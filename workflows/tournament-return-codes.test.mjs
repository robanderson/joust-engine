// workflows/tournament-return-codes.test.mjs
// Unit tests for the engine-side return-code (JE-RC) derivation. The logic lives inside the
// `// ---- begin: return codes ----` marked block in workflows/tournament.mjs (a top-level-return
// sandbox script, not an importable ES module), so — following this repo's precedent
// (tournament-verdict-integrity.test.mjs / tournament.contributions.test.mjs) — we extract the marked
// block from the shipped source and eval it, rather than hand-copying logic that would drift.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

const BEGIN = '// ---- begin: return codes ----------------------------------------------------------------------'
const END = '// ---- end: return codes ------------------------------------------------------------------------'
const i = SRC.indexOf(BEGIN)
const j = SRC.indexOf(END, i >= 0 ? i : 0)
if (i < 0 || j < 0) throw new Error('return-codes block markers not found in workflows/tournament.mjs')
const block = SRC.slice(i, j)

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
  }
`)(sandbox)
const { RC, ENGINE_FAULT_CLASSES, parseRunnerRc, deriveNativeAttemptRc, deriveRunnerAttemptRc, buildRcSummary } = sandbox

for (const fn of ['parseRunnerRc', 'deriveNativeAttemptRc', 'deriveRunnerAttemptRc', 'buildRcSummary']) {
  assert.equal(typeof sandbox[fn], 'function', `${fn} must be a function`)
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

// ----- ENGINE_FAULT_CLASSES: 00 and 03 are NEVER auto-filed; 01,02,04-09 are -----
test('ENGINE_FAULT_CLASSES excludes 00 (success) and 03 (honest turn-cap loss)', () => {
  assert.equal(ENGINE_FAULT_CLASSES.has('00'), false)
  assert.equal(ENGINE_FAULT_CLASSES.has('03'), false)
})

test('ENGINE_FAULT_CLASSES includes 01, 02, and 04-09', () => {
  for (const c of ['01', '02', '04', '05', '06', '07', '08', '09']) {
    assert.equal(ENGINE_FAULT_CLASSES.has(c), true, `${c} must be an engine-fault class`)
  }
})
