// INVESTIGATE→COMPOSITE pipeline v1 (spec docs/superpowers/specs/2026-07-06-investigate-composite-pipeline.md):
// G1 investigate brief kind + investigate-implies-composeOnly, G2 evidence-verification pass.
// Pure logic (citation parser, stamp, merge) is extracted from the marked block in tournament.mjs
// and eval'd (repo convention — see tournament-return-codes.test.mjs); orchestration/ordering and
// brief wording are covered structurally.
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

const ev = new Function(
  extractBlock('// ---- begin: evidence verification', '// ---- end: evidence verification') +
  '\nreturn { CITE_GREP, CITE_SED, parseCitations, EVIDENCE_GRAMMAR, evidenceStampFor, mergeEvidence };'
)()

// ----- pure: parseCitations -----

test('parseCitations extracts file:line and bare-path citations', () => {
  const out = ev.parseCitations('slow loop, see workflows/tournament.mjs:1234 and bin/je-git.sh for the gate')
  assert.deepEqual(out, [
    { path: 'workflows/tournament.mjs', line: 1234 },
    { path: 'bin/je-git.sh', line: null },
  ])
})

test('parseCitations accepts separator wrappers: quotes, backticks, parens, brackets, absolute paths', () => {
  const text = 'in `skills/fable-engine/SKILL.md:12`, "docs/spec.md", (a/b.txt) [x/y.json:9] and /tmp/run/mapping.json'
  const paths = ev.parseCitations(text).map(c => c.path)
  assert.deepEqual(paths, ['skills/fable-engine/SKILL.md', 'docs/spec.md', 'a/b.txt', 'x/y.json', '/tmp/run/mapping.json'])
  const withLines = ev.parseCitations(text).filter(c => c.line != null)
  assert.deepEqual(withLines, [{ path: 'skills/fable-engine/SKILL.md', line: 12 }, { path: 'x/y.json', line: 9 }])
})

test('parseCitations ignores URLs and bare slashless filenames; dedupes by path', () => {
  assert.deepEqual(ev.parseCitations('see https://github.com/foo/bar.js and http://x.io/a/b.py:3'), [])
  assert.deepEqual(ev.parseCitations('package.json mentions no directory'), []) // slash required
  const out = ev.parseCitations('src/a.js:1 then src/a.js:99 then src/a.js')
  assert.deepEqual(out, [{ path: 'src/a.js', line: 1 }]) // first-seen kept; length == distinct paths == n cited
})

test('parseCitations never throws on junk input', () => {
  for (const bad of [null, undefined, '', 42, {}, '::::', 'a/b', '/']) {
    assert.ok(Array.isArray(ev.parseCitations(bad)))
  }
})

// ----- pure: stamp + grammar -----

test('evidenceStampFor: exact closed-grammar stamp; verified clamped to cited; junk coerces to 0', () => {
  assert.equal(ev.evidenceStampFor(4, 3), 'EVIDENCE: 4 cited, 3 verified')
  assert.equal(ev.evidenceStampFor(2, 5), 'EVIDENCE: 2 cited, 2 verified') // clamp
  assert.equal(ev.evidenceStampFor(-1, 'x'), 'EVIDENCE: 0 cited, 0 verified')
  const grammar = new RegExp(ev.EVIDENCE_GRAMMAR)
  for (const [n, m] of [[0, 0], [1, 0], [7, 7]]) assert.match(ev.evidenceStampFor(n, m), grammar)
})

// ----- pure: mergeEvidence -----

test('mergeEvidence is purely additive: attaches counts+stamp, NEVER touches valid/failReason', () => {
  const staged = [
    { blind: 'A', valid: true }, { blind: 'B', valid: true },
    { blind: 'C', valid: false, failReason: 'no deliverable saved' },
  ]
  const out = ev.mergeEvidence(staged, {
    A: { cited: 5, verified: 3 },
    B: { cited: '2', verified: '9' },          // numeric strings coerce; verified clamps to cited
    C: { cited: 1, verified: 1 },              // upstream-invalid gets its stamp but stays invalid
  })
  assert.deepEqual(out[0].evidence, { cited: 5, verified: 3, stamp: 'EVIDENCE: 5 cited, 3 verified' })
  assert.equal(out[0].valid, true)
  assert.deepEqual(out[1].evidence, { cited: 2, verified: 2, stamp: 'EVIDENCE: 2 cited, 2 verified' })
  assert.equal(out[2].valid, false)
  assert.equal(out[2].failReason, 'no deliverable saved')
  assert.ok(out[2].evidence, 'stamp only — invalidation never flips either way')
})

test('mergeEvidence fail-safe: missing/garbled/negative/dead-helper => NO evidence attached (unstamped)', () => {
  const staged = [{ blind: 'A', valid: true }, { blind: 'B', valid: true }]
  const out = ev.mergeEvidence(staged, { A: { cited: 'junk', verified: 1 }, B: { cited: -2, verified: 0 } })
  assert.ok(!out[0].evidence && !out[1].evidence)
  assert.ok(out.every(c => c.valid), 'nothing invalidated')
  const dead = ev.mergeEvidence(staged, null)
  assert.ok(dead.every(c => !c.evidence && c.valid))
  assert.ok(!staged[0].evidence, 'input not mutated')
})

// ----- structural: G1 investigate brief kind -----

test('(structural) investigate brief: findings-only altitude, save contract, hard stop', () => {
  assert.match(SRC, /if \(kind === 'investigate'\) \{/)
  const seam = SRC.indexOf("if (kind === 'investigate') {")
  const brief = SRC.slice(seam, SRC.indexOf("if (kind === 'plan') {", seam))
  assert.match(brief, /Your deliverable is FINDINGS ONLY/)
  assert.match(brief, /DIAGNOSIS \(1-3 bullets\)/)
  assert.match(brief, /EVIDENCE \(2-6 bullets\): VERIFIABLE citations/)
  assert.match(brief, /CANDIDATE IMPROVEMENT SKETCH \(1-3 bullets\)/)
  // altitude guard: no code blocks, no fixes — findings only
  assert.match(brief, /ALTITUDE RULE \(hard\): FINDINGS ONLY — NO code blocks, NO diffs, NO function bodies, NO fixes/)
  assert.match(brief, /Do NOT write a fix, do NOT edit real source files/)
  // single-pass + save contract + hard stop, like the other kinds
  assert.match(brief, /Work in a SINGLE pass and then STOP/)
  assert.match(brief, /Save FINDINGS\.md into: \$\{ws\}/)
  assert.match(brief, /Do NOT ask clarifying questions/)
})

// ----- structural: investigate implies composeOnly return -----

test('(structural) investigate flag implies composeOnly semantics and the {poolPath, mapping, candidates} return', () => {
  assert.match(SRC, /const investigate = A\.investigate === true && !implement/)
  assert.match(SRC, /const composeOnly = \(A\.composeOnly === true \|\| investigate\) && !implement/)
  // Round 1 dispatch selects the investigate brief kind
  assert.match(SRC, /dispatch\(a, a\.ws, null, 'Round 1', investigate \? 'investigate' : 'plan'\)/)
  // the composeOnly branch (the seam investigate rides) returns pool + mapping + candidates
  const seam = SRC.indexOf('if (composeOnly) {')
  assert.ok(seam > -1)
  const branch = SRC.slice(seam, SRC.indexOf('// Plan Round 1 review', seam))
  assert.match(branch, /poolPath: `\$\{runDir\}\/review-1\/_pool\.md`/)
  assert.match(branch, /candidates: stagedEv\.filter\(c => c\.valid\)/)
  assert.match(branch, /\.\.\.\(investigate \? \{ investigate: true \} : \{\}\)/)
  assert.doesNotMatch(branch, /await judge\(/)
})

// ----- structural: G2 evidence pass wiring -----

test('(structural) evidence pass: HELPER_MODEL step, after staging/enrich, before the pool return; hard no-op unless investigate', () => {
  const fnStart = SRC.indexOf('async function evidenceVerificationPass')
  assert.ok(fnStart > -1)
  const fn = SRC.slice(fnStart, SRC.indexOf('async function stageAndValidate', fnStart))
  assert.match(fn, /if \(!investigate\) return staged/, 'flag-off => byte-identical (no agent spend)')
  assert.match(fn, /model: HELPER_MODEL, schema: EVIDENCE_SCHEMA/, 'one HELPER_MODEL step (mechanicalPatchGate shape)')
  assert.match(fn, /grep -ohE \$\{q\(CITE_GREP\)\}/, 'shell extractor pins the pure block CITE_GREP pattern')
  assert.match(fn, /echo "JEVID \$\{c\.blind\} \$n \$m"/, 'letters only in relayed lines')
  assert.match(fn, /mergeEvidence\(staged, byBlind\)/, 'routing decision lives in pure code')
  assert.match(fn, /evidenceStampShell\(dest\)/, 'pool rebuild carries the grammar-guarded stamp')
  // ordering in the round-1 flow: staging -> (repoMode enrich) -> evidence pass -> composeOnly return
  const stagedIdx = SRC.indexOf('const staged1 = await stageAndValidate')
  const enrichIdx = SRC.indexOf('if (repoMode) await enrichBlindPool(blind1')
  const passIdx = SRC.indexOf('const stagedEv = await evidenceVerificationPass(staged1')
  const seamIdx = SRC.indexOf('if (composeOnly) {')
  assert.ok(stagedIdx > -1 && enrichIdx > -1 && passIdx > -1 && seamIdx > -1)
  assert.ok(stagedIdx < enrichIdx && enrichIdx < passIdx && passIdx < seamIdx,
    'evidence pass runs after staging/enrichment and before the pool is returned')
})

test('(structural) evidence stamp is grammar-guarded and fail-safe (degrade to unstamped, never invalidate)', () => {
  assert.match(SRC, /const EVIDENCE_GRAMMAR = '\^EVIDENCE: \[0-9\]\+ cited, \[0-9\]\+ verified\$'/)
  const stampShell = SRC.slice(SRC.indexOf('function evidenceStampShell'), SRC.indexOf('const EVIDENCE_SCHEMA'))
  assert.match(stampShell, /if grep -Eq \$\{q\(EVIDENCE_GRAMMAR\)\}/, 'stamp emitted only when grammar-clean')
  // the pass deletes a grammar-violating stamp file (unstamped degradation, contract-gate discipline)
  assert.match(SRC, /grep -Eq \$\{q\(EVIDENCE_GRAMMAR\)\} "\$ev" 2>\/dev\/null \|\| rm -f "\$ev"/)
  // no invalidation branch exists anywhere in the evidence block (purely additive by construction)
  const block = extractBlock('// ---- begin: evidence verification', '// ---- end: evidence verification')
  assert.doesNotMatch(block, /valid: false|failReason:/, 'mergeEvidence never touches validity')
})
