// workflows/tournament-return-codes.test.mjs
// Unit tests for the engine-side return-code (JE-RC) derivation, the fold-in-A codex-judge failure
// reclassification (02->04), and the engine-side N-1 quorum-close decision logic. All three live inside
// MARKED blocks in workflows/tournament.mjs (a top-level-return sandbox script, not an importable ES
// module), so — following this repo's precedent — we extract the marked blocks from the shipped source
// and eval them, rather than hand-copying logic that would drift.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

function extractBlock(begin, end) {
  const i = SRC.indexOf(begin)
  const j = SRC.indexOf(end, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`block markers not found: ${begin}`)
  return SRC.slice(i, j)
}

const BEGIN = '// ---- begin: return codes ----------------------------------------------------------------------'
const END = '// ---- end: return codes ------------------------------------------------------------------------'
const block = extractBlock(BEGIN, END)

const sandbox = {}
new Function('sandbox', `
  with (sandbox) {
    ${block}
    sandbox.RC = RC
    sandbox.ENGINE_FAULT_CLASSES = ENGINE_FAULT_CLASSES
    sandbox.RC_MEANING = RC_MEANING
    sandbox.parseRunnerRc = parseRunnerRc
    sandbox.deriveNativeAttemptRc = deriveNativeAttemptRc
    sandbox.deriveRunnerAttemptRc = deriveRunnerAttemptRc
    sandbox.buildRcSummary = buildRcSummary
    sandbox.classifyCodexJudgeFailure = classifyCodexJudgeFailure
  }
`)(sandbox)
const { RC, ENGINE_FAULT_CLASSES, parseRunnerRc, deriveNativeAttemptRc, deriveRunnerAttemptRc, buildRcSummary, classifyCodexJudgeFailure } = sandbox

for (const fn of ['parseRunnerRc', 'deriveNativeAttemptRc', 'deriveRunnerAttemptRc', 'buildRcSummary', 'classifyCodexJudgeFailure']) {
  assert.equal(typeof sandbox[fn], 'function', `${fn} must be a function`)
}

// Quorum-close block (new): pure decision arithmetic.
const QBEGIN = '// ---- begin: quorum close ------------------------------------------------------------------------'
const QEND = '// ---- end: quorum close --------------------------------------------------------------------------'
const qblock = extractBlock(QBEGIN, QEND)
const qsandbox = {}
new Function('sandbox', `
  with (sandbox) {
    ${qblock}
    sandbox.quorumDeadlineSecs = quorumDeadlineSecs
    sandbox.shouldQuorumClose = shouldQuorumClose
  }
`)(qsandbox)
const { quorumDeadlineSecs, shouldQuorumClose } = qsandbox
for (const fn of ['quorumDeadlineSecs', 'shouldQuorumClose']) {
  assert.equal(typeof qsandbox[fn], 'function', `${fn} must be a function`)
}

// ----- parseRunnerRc -----
test('parseRunnerRc: a present line yields code + reason', () => {
  const r = parseRunnerRc('JOUST-GLM-PROVENANCE endpoint=x\nJOUST-RC 07 missing-key\nJOUST-GLM-DONE exit=3')
  assert.deepEqual(r, { rc: '07', reason: 'missing-key' })
})

test('parseRunnerRc: a missing line parses as RC 09 no-jerc-line (the runner-bug signal)', () => {
  assert.deepEqual(parseRunnerRc('JOUST-GLM-DONE exit=0\n(no rc line here)'), { rc: '09', reason: 'no-jerc-line' })
})

test('parseRunnerRc: the LAST JOUST-RC line wins when multiple are present', () => {
  const r = parseRunnerRc('JOUST-RC 09 unclassified\nJOUST-RC 00 ok')
  assert.deepEqual(r, { rc: '00', reason: 'ok' })
})

test('parseRunnerRc: a code with no reason falls back to the RC_MEANING text', () => {
  const r = parseRunnerRc('JOUST-RC 01')
  assert.equal(r.rc, '01')
  assert.equal(r.reason, 'model timeout')
})

test('parseRunnerRc: null / empty input parses as 09', () => {
  assert.equal(parseRunnerRc(null).rc, '09')
  assert.equal(parseRunnerRc('').rc, '09')
})

// ----- deriveNativeAttemptRc -----
test('deriveNativeAttemptRc: valid staging => 00', () => {
  assert.deepEqual(deriveNativeAttemptRc({ dispatchedOk: true, valid: true }), { rc: '00', reason: 'ok' })
})

test('deriveNativeAttemptRc: agent null/throw => 09', () => {
  assert.equal(deriveNativeAttemptRc({ dispatchedOk: false, valid: false }).rc, '09')
})

test('deriveNativeAttemptRc: no deliverable => 05', () => {
  assert.equal(deriveNativeAttemptRc({ dispatchedOk: true, valid: false, failReason: 'no deliverable saved' }).rc, '05')
})

test('deriveNativeAttemptRc: provenance failure => 06', () => {
  assert.equal(deriveNativeAttemptRc({ dispatchedOk: true, valid: false, failReason: 'provenance check failed (timeout/error/empty)' }).rc, '06')
})

test('deriveNativeAttemptRc: other invalid staging => 04', () => {
  assert.equal(deriveNativeAttemptRc({ dispatchedOk: true, valid: false, failReason: 'staging result missing (failed closed)' }).rc, '04')
})

// ----- deriveRunnerAttemptRc -----
test('deriveRunnerAttemptRc: runner 124/timeout RC passes through (01)', () => {
  assert.deepEqual(deriveRunnerAttemptRc({ runnerRc: '01', runnerReason: 'wall-clock-timeout', valid: false, failReason: 'no deliverable saved' }),
    { rc: '01', reason: 'wall-clock-timeout' })
})

test('deriveRunnerAttemptRc: runner said 00 but staging rejected (no deliverable) => reclassify to 05', () => {
  assert.equal(deriveRunnerAttemptRc({ runnerRc: '00', valid: false, failReason: 'no deliverable saved' }).rc, '05')
})

test('deriveRunnerAttemptRc: runner said 00 but staging rejected (provenance) => reclassify to 06', () => {
  assert.equal(deriveRunnerAttemptRc({ runnerRc: '00', valid: false, failReason: 'provenance check failed' }).rc, '06')
})

test('deriveRunnerAttemptRc: runner 00 and staging valid => 00', () => {
  assert.equal(deriveRunnerAttemptRc({ runnerRc: '00', valid: true }).rc, '00')
})

test('deriveRunnerAttemptRc: a missing JOUST-RC line (null runnerRc) => 09', () => {
  assert.deepEqual(deriveRunnerAttemptRc({ runnerRc: null, valid: true }), { rc: '09', reason: 'no-jerc-line' })
})

// ----- buildRcSummary -----
test('buildRcSummary: an all-00 field yields non00:[] and the right by_code', () => {
  const s = buildRcSummary([
    { seat: 'A', phase: 'Round 1', rc: '00', reason: 'ok' },
    { seat: 'B', phase: 'Round 1', rc: '00', reason: 'ok' },
  ])
  assert.equal(s.seats, 2)
  assert.deepEqual(s.by_code, { '00': 2 })
  assert.deepEqual(s.non00, [])
})

test('buildRcSummary: a mixed field yields counts + non00 rows', () => {
  const s = buildRcSummary([
    { seat: 'A', phase: 'Round 1', rc: '00', reason: 'ok' },
    { seat: 'B', phase: 'Round 1', rc: '05', reason: 'no-deliverable' },
    { seat: 'C', phase: 'Final rank', rc: '05', reason: 'no-deliverable' },
    { seat: 'x:security', phase: 'Review', rc: '09', reason: 'lens-seat-dead-after-retries' },
  ])
  assert.equal(s.seats, 4)
  assert.deepEqual(s.by_code, { '00': 1, '05': 2, '09': 1 })
  assert.equal(s.non00.length, 3)
  assert.deepEqual(s.non00[0], { seat: 'B', phase: 'Round 1', rc: '05', reason: 'no-deliverable' })
})

// ----- ENGINE_FAULT_CLASSES -----
test('ENGINE_FAULT_CLASSES excludes 00 (success) and 03 (honest turn-cap loss)', () => {
  assert.equal(ENGINE_FAULT_CLASSES.has('00'), false)
  assert.equal(ENGINE_FAULT_CLASSES.has('03'), false)
})

test('ENGINE_FAULT_CLASSES includes 01, 02, and 04-09', () => {
  for (const c of ['01', '02', '04', '05', '06', '07', '08', '09']) {
    assert.equal(ENGINE_FAULT_CLASSES.has(c), true, `${c} must be an engine-fault class`)
  }
})

// ----- fold-in A: codex judge VERDICT read-back reclassification (02 dispatch/unavail -> 04 readback/invalid) -----
test('classifyCodexJudgeFailure: dispatch stage => 02 codex-seat-unavailable', () => {
  assert.deepEqual(classifyCodexJudgeFailure('dispatch'), { rc: RC.UNAVAIL, reason: 'codex-seat-unavailable' })
  assert.equal(classifyCodexJudgeFailure('dispatch').rc, '02')
})

test('classifyCodexJudgeFailure: readback stage => 04 codex-verdict-readback-failed', () => {
  assert.deepEqual(classifyCodexJudgeFailure('readback'), { rc: RC.INVALID, reason: 'codex-verdict-readback-failed' })
  assert.equal(classifyCodexJudgeFailure('readback').rc, '04')
})

test('classifyCodexJudgeFailure: unrecognized/undefined stage fails toward the pre-existing 02 branch', () => {
  assert.equal(classifyCodexJudgeFailure(undefined).rc, '02')
  assert.equal(classifyCodexJudgeFailure('weird').rc, '02')
})

// ----- item 4: quorum-close arithmetic -----
test('quorumDeadlineSecs: null / non-positive timeout => null (never eligible)', () => {
  assert.equal(quorumDeadlineSecs(null, 90), null)
  assert.equal(quorumDeadlineSecs(0, 90), null)
  assert.equal(quorumDeadlineSecs(-5, 90), null)
})

test('quorumDeadlineSecs: 2x timeout + grace (and the zero-grace edge)', () => {
  assert.equal(quorumDeadlineSecs(300, 90), 690)
  assert.equal(quorumDeadlineSecs(300, 0), 600)
})

test('shouldQuorumClose: a single-seat round never closes (totalCount < 2)', () => {
  assert.equal(shouldQuorumClose({ settledCount: 0, totalCount: 1, straggler: { timeoutSecs: 300, graceSecs: 90, elapsedSecs: 99999 } }), false)
})

test('shouldQuorumClose: false unless EXACTLY one seat is unsettled', () => {
  assert.equal(shouldQuorumClose({ settledCount: 3, totalCount: 5, straggler: { timeoutSecs: 300, graceSecs: 90, elapsedSecs: 99999 } }), false)
})

test('shouldQuorumClose: NEVER over a security-gate seat (neverClose) even past deadline', () => {
  assert.equal(shouldQuorumClose({ settledCount: 4, totalCount: 5, straggler: { neverClose: true, timeoutSecs: 300, graceSecs: 90, elapsedSecs: 99999 } }), false)
})

test('shouldQuorumClose: false for a native seat with no engine-known deadline', () => {
  assert.equal(shouldQuorumClose({ settledCount: 4, totalCount: 5, straggler: { timeoutSecs: null, graceSecs: 90, elapsedSecs: 99999 } }), false)
})

test('shouldQuorumClose: false while still within the deadline', () => {
  assert.equal(shouldQuorumClose({ settledCount: 4, totalCount: 5, straggler: { timeoutSecs: 300, graceSecs: 90, elapsedSecs: 100 } }), false)
})

test('shouldQuorumClose: true once strictly past the deadline for an eligible straggler', () => {
  assert.equal(shouldQuorumClose({ settledCount: 4, totalCount: 5, straggler: { timeoutSecs: 300, graceSecs: 90, elapsedSecs: 691 } }), true)
})
