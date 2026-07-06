// Run F tests: mechanical pre-council patch gate + round-2 guidance-stub gate.
// Pure logic is extracted from the marked blocks in tournament.mjs and eval'd (repo convention —
// see tournament-return-codes.test.mjs); orchestration/ordering is covered structurally.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

function extractBlock(begin, end) {
  const i = SRC.indexOf(begin)
  const j = SRC.indexOf(end, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`block markers not found: ${begin}`)
  return SRC.slice(i, j)
}

const mech = new Function(
  extractBlock('// ---- begin: mechanical patch gate', '// ---- end: mechanical patch gate') +
  '\nreturn { MECH_CLASSES, sanitizeMechDetail, mechanicalStampFor, isMechanicalInvalid, mergeMechanical };'
)()

test('sanitizeMechDetail strips paths, newlines, caps length, never empty', () => {
  assert.equal(mech.sanitizeMechDetail('error: corrupt patch at line 12'), 'error: corrupt patch at line 12')
  assert.ok(!mech.sanitizeMechDetail('failed at /tmp/de-workspaces/x/round-1/candidate-3/f.diff line 2').includes('/tmp/'))
  assert.ok(mech.sanitizeMechDetail('a\nb\r\nc').indexOf('\n') === -1)
  assert.ok(mech.sanitizeMechDetail('x'.repeat(500)).length <= 160)
  assert.equal(mech.sanitizeMechDetail(''), 'no further detail')
  assert.equal(mech.sanitizeMechDetail(null), 'no further detail')
})

test('mechanicalStampFor: exact stamps per class incl. recount/structure nuance', () => {
  assert.equal(mech.mechanicalStampFor('clean_patch'), 'MECHANICAL: patch applies cleanly')
  assert.equal(mech.mechanicalStampFor('clean_patch', 'recount'), 'MECHANICAL: patch applies cleanly (--recount)')
  assert.match(mech.mechanicalStampFor('clean_patch', 'structure'), /structure-only/)
  assert.match(mech.mechanicalStampFor('corrupt_patch', 'error: bad hunk'), /^MECHANICAL: git apply --check FAILED: error: bad hunk/)
  assert.equal(mech.mechanicalStampFor('full_files'), 'MECHANICAL: no patch found (full-files deliverable)')
  assert.equal(mech.mechanicalStampFor('unavailable'), 'MECHANICAL: check unavailable')
  assert.equal(mech.mechanicalStampFor('weird-token'), 'MECHANICAL: check unavailable')
})

test('only corrupt_patch invalidates', () => {
  for (const cls of mech.MECH_CLASSES) assert.equal(mech.isMechanicalInvalid(cls), cls === 'corrupt_patch')
})

test('mergeMechanical routing: corrupt invalidates; others keep valid; fail-safe on missing/null/unknown', () => {
  const staged = [
    { blind: 'A', valid: true }, { blind: 'B', valid: true },
    { blind: 'C', valid: true }, { blind: 'D', valid: false, failReason: 'no deliverable saved' },
  ]
  const out = mech.mergeMechanical(staged, {
    A: { class: 'corrupt_patch', detail: 'error: bad hunk' },
    B: { class: 'full_files' },
    C: { class: 'weird' },              // unknown token -> unavailable, NOT invalidated
    D: { class: 'clean_patch' },        // upstream-invalid never revalidated
  })
  assert.equal(out[0].valid, false)
  assert.match(out[0].failReason, /^mechanical: patch does not apply/)
  assert.equal(out[0].mechanical.class, 'corrupt_patch')
  assert.equal(out[1].valid, true)
  assert.equal(out[1].mechanical.class, 'full_files')
  assert.equal(out[2].valid, true)
  assert.equal(out[2].mechanical.class, 'unavailable')
  assert.equal(out[3].valid, false)
  // helper died entirely -> byBlind null -> ALL unavailable, nothing invalidated
  const dead = mech.mergeMechanical([{ blind: 'A', valid: true }], null)
  assert.equal(dead[0].valid, true)
  assert.equal(dead[0].mechanical.class, 'unavailable')
})

// guidanceStub lives in the verdict-integrity block (reuses guidanceIntegrityIssue).
const gi = {}
new Function('sandbox', `with (sandbox) { ${extractBlock('// ---- begin: verdict integrity guard', '// ---- end: verdict integrity guard')}
  sandbox.guidanceStub = guidanceStub }`)(gi)

test('guidanceStub: missing/empty/all-thin are stubs; one substantive item is usable', () => {
  assert.equal(gi.guidanceStub(null), 'guidance missing')
  assert.equal(gi.guidanceStub({}), 'guidance empty (no positives or challenges)')
  assert.equal(gi.guidanceStub({ positives: [], challenges: [] }), 'guidance empty (no positives or challenges)')
  assert.match(String(gi.guidanceStub({ positives: [{ text: 'x', why: 'y' }], challenges: [] })), /placeholder|junk/)
  assert.equal(gi.guidanceStub({ positives: [{ text: 'validate and normalise user input before use', why: 'candidates that skipped this crashed on repeats' }], challenges: [] }), null)
})

test('(structural) gate runs after staging, before enrich + the code council, implement rounds only', () => {
  const irStart = SRC.indexOf('async function implementRound')
  const irEnd = SRC.indexOf('async function implementPhase', irStart)
  const ir = SRC.slice(irStart, irEnd)
  assert.ok(ir.indexOf('mechanicalPatchGate(') > ir.indexOf('stageAndValidate('), 'gate after staging')
  assert.ok(ir.indexOf('mechanicalPatchGate(') < ir.indexOf('enrichBlindPool('), 'gate before repoMode pool rebuild')
  assert.ok(ir.indexOf('mechanicalPatchGate(') < ir.indexOf("judge('code reviewer'"), 'gate before the council')
  assert.match(ir, /mechanical: c\.mechanical\.class/, 'mapping records the class')
  // plan-phase judge calls are NOT gated
  const planReview = SRC.indexOf("await judge('reviewer'")
  assert.ok(planReview > 0 && SRC.lastIndexOf('mechanicalPatchGate(', planReview) < irEnd === false || SRC.slice(planReview - 2000, planReview).indexOf('mechanicalPatchGate(') === -1, 'plan review not gated')
  // repoMode pool rebuild carries the stamp; both writers share mechStampShell
  assert.ok(SRC.split('mechStampShell(dest)').length >= 3, 'shared stamp shell used by both pool writers')
})

test('(structural) round-2 and implement-R4 seeds are stub-gated', () => {
  assert.match(SRC, /JE-GUIDANCE-STUB \[Round 2\]/)
  assert.match(SRC, /JE-GUIDANCE-STUB \[Implement Round 4\]/)
  assert.match(SRC, /dispatch\(a, a\.ws, r2Guidance, 'Round 2'\)/)
})

// Run-i post-mortem (2026-07-06): the non-repo gate false-killed 11/12 implement candidates —
// `git apply --check` in an EMPTY `git init` repo can never pass a modify-patch, and `head -n1`
// made multi-patch deliverables a find-order coin flip (run-h's two "clean" stamps were luck).
test('(structural) gate checks ALL patches, sorted — never a head -n1 coin flip', () => {
  const i = SRC.indexOf('async function mechanicalPatchGate')
  const gate = SRC.slice(i, SRC.indexOf('\n}', i))
  assert.ok(/-iname '\*\.patch' -o -iname '\*\.diff' \\\\\) 2>\/dev\/null\) \| sort/.test(gate) || gate.includes(`2>/dev/null | sort`), 'patch enumeration must be sorted')
  assert.ok(gate.includes('for p in $patches'), 'every patch is checked, in order')
  assert.ok(!gate.includes("-iname '*.diff' \\) 2>/dev/null | head -n1"), 'the single-patch head -n1 pick is gone')
})

test('(structural) snapshot mode APPLIES patches in order (stacked 0002-on-0001 works); structure mode is parse-only --numstat', () => {
  const i = SRC.indexOf('async function mechanicalPatchGate')
  const gate = SRC.slice(i, SRC.indexOf('\n}', i))
  assert.ok(gate.includes('git -C "$wt" apply $pflag "$p"'), 'snapshot applies for real so stacked patches verify')
  assert.ok(gate.includes('git -C "$wt" apply --numstat $pflag "$p"'), 'structure mode uses --numstat (cannot false-kill a modify-patch)')
  assert.ok(!gate.includes('apply --check $pflag'), 'the empty-repo --check false-kill machine is gone')
})

test('(structural) gate baseline: repoMode baseSha, else the HEAD sha pinned at context-bundle time', () => {
  const i = SRC.indexOf('async function mechanicalPatchGate')
  const gate = SRC.slice(i, SRC.indexOf('\n}', i))
  assert.ok(gate.includes('base=$(cat'), 'gate falls back to the pinned base-sha file')
  assert.ok(SRC.includes('const gateBaseShaFile = `${runDir}/_context/base-sha`'), 'pin file lives under runDir/_context')
  assert.ok(SRC.includes("git rev-parse HEAD 2>/dev/null || printf ''"), 'buildContext pins HEAD fail-soft at bundle time')
  const pin = SRC.indexOf("git rev-parse HEAD 2>/dev/null")
  const attempts = SRC.indexOf('await buildContext()')
  assert.ok(pin > 0 && attempts > 0, 'both present')
})
