// REJUDGE MODE (run-i salvage class, 2026-07-07): judge an existing staged implement pool with
// the fixed mechanical gate + code council, no generation rounds. Structural pins: the mode must
// strip stale gate stamps before re-gating, assign FRESH blind letters, reuse the SAME gate/judge
// machinery as a live implement round (no parallel fork), and return before Round 1 dispatch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

const start = SRC.indexOf('// ================= REJUDGE MODE')
const end = SRC.indexOf('// ---- Round 1 ----')
assert.ok(start > 0 && end > start, 'rejudge block exists and precedes Round 1')
const BLOCK = SRC.slice(start, end)

test('rejudge gates on args.rejudgeCandidates and returns BEFORE any generation round', () => {
  assert.ok(BLOCK.includes('A.rejudgeCandidates'), 'arg-gated')
  assert.match(BLOCK, /return \{\s*\n\s*mode: 'rejudge'/, 'terminal return — Round 1 is never reached')
  assert.ok(!BLOCK.includes('dispatch('), 'no attempt dispatch inside rejudge')
})

test('stale gate stamps are STRIPPED before the fixed gate re-derives them', () => {
  const copy = BLOCK.indexOf('copyScript')
  const gate = BLOCK.indexOf('mechanicalPatchGate(')
  assert.ok(copy > 0 && gate > copy, 'copy/strip precedes the gate')
  for (const f of ['mechanical.txt', 'contract.txt', 'convergence.txt', 'enrichment.txt'])
    assert.ok(BLOCK.includes(f), `strips ${f}`)
})

test('fresh blind letters with rotation — cold re-judge, no letter alignment with the source run', () => {
  assert.ok(BLOCK.includes('letters[(i + rjRot) % rjN]'), 'rotated fresh-letter assignment')
  assert.ok(BLOCK.includes('A.rejudgeRot'), 'rotation is caller-controllable')
})

test('reuses the SAME machinery as a live implement round: gate, inContention, code council, gate check', () => {
  assert.ok(BLOCK.includes('mechanicalPatchGate(rjStaged, reviewDir'), 'the real gate')
  assert.ok(BLOCK.includes('.filter(inContention)'), 'dedup contention filter')
  assert.match(BLOCK, /judge\('code reviewer', rjBlind, false, `\$\{reviewDir\}\/_pool\.md`, RANK_SCHEMA, 'Rejudge', 'rejudge-review', LENSES, 'final'\)/, 'full code council, final style (steelman)')
  assert.ok(BLOCK.includes('implGatePassed({ review: rjReview, blind: rjBlind })'), 'winner via the same gate predicate')
})

test('buildContext pins the gate baseline before the gate runs', () => {
  const ctx = BLOCK.indexOf('await buildContext()')
  const gate = BLOCK.indexOf('mechanicalPatchGate(')
  assert.ok(ctx > 0 && ctx < gate, 'baseline pinned before re-gating')
})

test('mapping persists model + source attribution and the taskBucket rides along for the ledger', () => {
  assert.ok(BLOCK.includes('winnerSource'), 'winner is unblinded to its source seat')
  assert.ok(BLOCK.includes('dynamicMBucket ? { taskBucket: dynamicMBucket }'), 'convergence-ledger bucket carried')
})

test('meta declares the Rejudge phase', () => {
  assert.ok(SRC.includes(`{ title: 'Rejudge' }`), 'phase title in meta.phases')
})

test('rejudgeBaseSha pins the gate baseline to the tree the candidates were AUTHORED against (strict hex, verified rev-parse)', () => {
  assert.match(SRC, /\/\^\[0-9a-f\]\{7,40\}\$\/\.test\(String\(A\.rejudgeBaseSha \|\| ''\)\)/, 'strict sha shape or ignored')
  const i = SRC.indexOf('A.rejudgeBaseSha')
  const seg = SRC.slice(i, i + 700)
  assert.ok(seg.includes('rev-parse --verify'), 'sha verified against the repo, never trusted as text')
  assert.ok(seg.includes('gateBaseShaFile'), 'overwrites the context-time HEAD pin')
  const ctx = SRC.indexOf('await buildContext() // pins gateBaseShaFile (HEAD)')
  assert.ok(ctx > 0 && ctx < i, 'pin overwrite runs AFTER buildContext so it wins')
})

// ---- security-sweep rejudge hardening (2026-07-07) ----
test('M20: >26 candidates is refused (blind alphabet is 26); rot normalised non-negative', () => {
  assert.ok(BLOCK.includes('rjN > letters.length'), 'N>26 guard')
  assert.match(BLOCK, /const rjRot = Number\.isInteger\(A\.rejudgeRot\) \? \(\(A\.rejudgeRot % rjN\) \+ rjN\) % rjN/, 'rot normalised to a non-negative in-range index')
})

test('H17: rejudge copy refuses a non-directory / symlinked source (no arbitrary-file leak into the pool)', () => {
  assert.ok(BLOCK.includes('if [ -d ${q(c.dir)} ] && [ ! -L ${q(c.dir)} ]; then cp -R'),
    'copy only when the source is a real directory AND not a symlink')
  assert.ok(BLOCK.includes('JRJ-REFUSE'), 'a refused source is logged, staged as 0 files (fails the empty gate)')
})

test('M19: a hex-but-unresolvable rejudgeBaseSha FAILS the rejudge (fail-closed, no silent HEAD fallback)', () => {
  assert.ok(BLOCK.includes('echo "JRPIN $(wc -c'), 'the pin reports resolved bytes')
  assert.ok(BLOCK.includes('if (!pinBytes) {'), 'zero bytes (unresolved) is a failure')
  assert.match(BLOCK, /did not resolve to a commit in this repo — refusing to gate against the wrong baseline/)
})
