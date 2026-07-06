// Codex REVIEW-PRESET judge seats (2026-07-06 judge-architecture experiment). The exec-mode seats'
// VERDICT.json self-authorship failed verdict-readback on 9/9 codex seats across TWO full runs
// (run-h + run-i); the experiment showed `codex review` (bounded report) + a sonnet mechanical
// reformat under a strict traceability rule is equal-or-better on findings with no authorship
// failure mode. Suites: PURE parseCodexReviewDump units (extract-and-eval) + STRUCTURAL wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')
const RUNNER = readFileSync(resolve(HERE, '../bin/codex-run.sh'), 'utf8')

function extractBlock(begin, end) {
  const i = SRC.indexOf(begin)
  const j = SRC.indexOf(end, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`block markers not found: ${begin}`)
  return SRC.slice(i, j)
}

// ----- 1. PURE: parseCodexReviewDump -----
const block = extractBlock('// ---- begin: codex review-judge parsing', '// ---- end: codex review-judge parsing')
const sandbox = {}
new Function('sandbox', `
  const CODEX_JUDGE_LOG_MARK = '===JE-CODEX-JUDGE-LOG==='
  const CODEX_JUDGE_VERDICT_MARK = '===JE-CODEX-JUDGE-VERDICT==='
  ${block}
  sandbox.parseCodexReviewDump = parseCodexReviewDump
  sandbox.REVIEW_CHECKS_RUN = REVIEW_CHECKS_RUN
`)(sandbox)
const { parseCodexReviewDump, REVIEW_CHECKS_RUN } = sandbox

const LOGM = '===JE-CODEX-JUDGE-LOG==='
const REPM = '===JE-CODEX-JUDGE-VERDICT==='
const goodLog = 'JOUST-CODEX-PROVENANCE endpoint=api.openai.com flag=-m test timeout=1s stall=1s\nJOUST-CODEX-DONE exit=0\nJOUST-RC 00 ok\n'
const goodReport = `Candidate A:\n- pro: q()-escapes every relayed token (quoted at line 12)\n- con: none material\nCandidate B:\n- con: trusts the relay hash verbatim\nRANKING: A > B\nVOTE: A\nSAFETY A: SAFE\nSAFETY B: UNSAFE high trusts unvalidated relay token\nThe ranking follows from the evidence above.`
const dump = (log, report) => `${LOGM}${log}${REPM}${report}`

test('accepts a well-formed dump (provenance + exit 0 + RANKING/VOTE lines)', () => {
  const r = parseCodexReviewDump(dump(goodLog, goodReport))
  assert.equal(r.ok, true)
  assert.match(r.report, /^RANKING: A > B$/m)
})

test('rejects missing provenance (runner never ran — spoof/fail-closed)', () => {
  const r = parseCodexReviewDump(dump('unrelated log text\n', goodReport))
  assert.equal(r.ok, false)
  assert.match(r.reason, /PROVENANCE/)
})

test('rejects a non-zero / TIMEOUT / ERROR run', () => {
  assert.equal(parseCodexReviewDump(dump(goodLog.replace('exit=0', 'exit=1'), goodReport)).ok, false)
  assert.equal(parseCodexReviewDump(dump(goodLog + 'JOUST-CODEX-TIMEOUT secs=1500\n', goodReport)).ok, false)
})

test('rejects a report with no explicit RANKING/VOTE machine line (reformatter must never invent one)', () => {
  const noRank = parseCodexReviewDump(dump(goodLog, 'Candidate A: fine.\nVOTE: A\n' + 'x'.repeat(80)))
  assert.equal(noRank.ok, false); assert.match(noRank.reason, /RANKING/)
  const noVote = parseCodexReviewDump(dump(goodLog, 'Candidate A: fine.\nRANKING: A > B\n' + 'x'.repeat(80)))
  assert.equal(noVote.ok, false); assert.match(noVote.reason, /VOTE/)
})

test('rejects trivially short reports and missing markers; never throws', () => {
  assert.equal(parseCodexReviewDump(dump(goodLog, 'RANKING: A\nVOTE: A')).ok, false)
  assert.equal(parseCodexReviewDump('no markers at all').ok, false)
  assert.equal(parseCodexReviewDump(null).ok, false)
  assert.equal(parseCodexReviewDump(undefined).ok, false)
})

test('REVIEW_CHECKS_RUN is an engine-written constant (never model-invented telemetry)', () => {
  assert.ok(Array.isArray(REVIEW_CHECKS_RUN) && REVIEW_CHECKS_RUN.length >= 1)
  assert.ok(REVIEW_CHECKS_RUN.every(s => typeof s === 'string' && s.includes('_pool.md')))
})

// ----- 2. STRUCTURAL: engine wiring -----
test('askLensCodex dispatches the runner in JE_CODEX_MODE=review with a staged pool copy', () => {
  assert.ok(SRC.includes(`'JE_CODEX_MODE=review '`), 'dispatch env selects the review mode')
  assert.match(SRC, /git init -q \. 2>\/dev\/null; cp \$\{q\(poolPath\)\} _pool\.md && /, 'seat prep stages a scratch repo + the pool copy')
})

test('the reformat helper is traceability-bound sonnet with found:false as the no-invention escape', () => {
  assert.ok(SRC.includes('MECHANICAL reformatter'), 'reformat prompt frames the helper as mechanical')
  assert.ok(SRC.includes('WITHOUT adding, upgrading, downgrading, or inventing ANYTHING'))
  assert.ok(SRC.includes('return found:false with empty fields rather than inventing one'))
  assert.match(SRC, /label: `\$\{label\}-codex-reformat`/, 'reformat is its own labelled seat step')
  const i = SRC.indexOf('CODEX_REVIEW_VERDICT_SCHEMA = {')
  assert.ok(i > 0 && SRC.slice(i, i + 400).includes(`found: { type: 'boolean' }`))
})

test('reformatted verdicts pass the SAME shape+integrity guards as native seats, then reconcile', () => {
  const i = SRC.indexOf('parseCodexReviewDump(rawForParse)')
  const tail = SRC.slice(i, i + 3000)
  assert.ok(tail.includes('verdictShapeIssue(verdict)'), 'shape guard applied to the reformatted verdict')
  assert.ok(tail.includes('verdictIntegrityIssue(verdict)'), 'schema-valid-junk guard applied')
  assert.ok(tail.includes('reconcileLens(verdict, labels)'), 'label-permutation repair unchanged')
})

test('judge effort defaults to HIGH (experiment sweep) with args.codexJudgeEffort override; judgeModel reports the real effort', () => {
  assert.match(SRC, /A\.codexJudgeEffort.*: 'high'/s)
  assert.ok(SRC.includes('judgeModel: `codex-${judgeEffort}`'), 'judge_model is tagged with the effort that ACTUALLY ran')
})

// ----- 3. STRUCTURAL: runner review mode -----
test('codex-run.sh review mode: global flags, review subcommand, report to stdout, stderr feeds the watchdog log', () => {
  assert.ok(RUNNER.includes('MODE="${JE_CODEX_MODE:-exec}"'))
  const i = RUNNER.indexOf('if [ "$MODE" = review ]')
  assert.ok(i > 0, 'review branch exists')
  const branch = RUNNER.slice(i, RUNNER.indexOf('else', i))
  assert.ok(branch.includes('review \\'), 'uses the review subcommand')
  assert.ok(branch.includes('> "$REPORT" 2>> "$LOG"'), 'report on stdout; session stream (stderr) is the liveness feed')
  assert.ok(!branch.includes('--skip-git-repo-check'), 'review runs in the staged scratch repo')
  const flagIdx = branch.indexOf('$FLAG'), revIdx = branch.indexOf('review \\')
  assert.ok(flagIdx > 0 && flagIdx < revIdx, 'model/effort flags are GLOBAL — `codex review` has no -m')
})

test('codex-run.sh review mode: a clean exit with an empty report is RC 05, not a fake success', () => {
  assert.ok(RUNNER.includes('[ "$MODE" = review ] && [ ! -s "$REPORT" ]'))
  assert.ok(RUNNER.includes('05 no-deliverable-saved'))
})
