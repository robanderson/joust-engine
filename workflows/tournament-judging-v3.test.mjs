// judging-v3 + structural persist tests (2026-07-06): fast tally, steelman shootout, verified
// persist dataplane, on-disk derivation. Extract-and-eval convention: pure blocks/functions are
// sliced out of tournament.mjs and run in isolation; orchestration is covered structurally.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

function slice(beginMark, endMark) {
  const i = SRC.indexOf(beginMark)
  const j = SRC.indexOf(endMark, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`markers not found: ${beginMark}`)
  return SRC.slice(i, j)
}
function sliceFn(name) {
  const i = SRC.indexOf(`function ${name}(`)
  const j = SRC.indexOf('\n}\n', i)
  if (i < 0 || j < 0) throw new Error(`function not found: ${name}`)
  return SRC.slice(i, j + 3)
}

// ----- structural persist helpers: sha256 vs node:crypto, heredoc discipline -----
const persistHelpers = new Function(
  slice('// ---- begin: structural persist helpers', '// ---- end: structural persist helpers') +
  '\nreturn { sha256Hex, heredocDelim, heredocBody };')()

test('sha256Hex matches node:crypto on empty/ascii/large/multibyte inputs', () => {
  for (const c of ['', 'abc', 'hello world\n', 'x'.repeat(200000), 'é漢字🚀\nline\n', JSON.stringify({ a: [1, 2], b: 'ü' })]) {
    assert.equal(persistHelpers.sha256Hex(c), createHash('sha256').update(c, 'utf8').digest('hex'))
  }
})
test('heredocDelim never returns a delimiter contained in the content', () => {
  const evil = 'line1\nJE_EOF_W\nJE_EOF_W1\nJE_EOF_W2\n'
  const d = persistHelpers.heredocDelim(evil)
  assert.ok(!evil.includes(d))
})
test('heredocBody guarantees a trailing newline and never double-adds one', () => {
  assert.equal(persistHelpers.heredocBody('x'), 'x\n')
  assert.equal(persistHelpers.heredocBody('x\n'), 'x\n')
})
test('corruption detection: sha of abbreviated content differs (the #33 failure class)', () => {
  const full = 'A'.repeat(50000) + '\n'
  const abbreviated = 'A'.repeat(49999) + '\n' // one byte lost in relay
  assert.notEqual(persistHelpers.sha256Hex(full), persistHelpers.sha256Hex(abbreviated))
})

// ----- nonVetoedOrder: carry/seed ordering -----
const { nonVetoedOrder } = new Function(sliceFn('nonVetoedOrder') + '\nreturn { nonVetoedOrder };')()
const V = (vote, ranking) => ({ vote, ranking })

test('nonVetoedOrder: first-place votes dominate', () => {
  const verdicts = [V('A', ['A', 'B', 'C']), V('A', ['A', 'C', 'B']), V('B', ['B', 'A', 'C'])]
  assert.deepEqual(nonVetoedOrder(verdicts, ['A', 'B', 'C'], new Set()), ['A', 'B', 'C'])
})
test('nonVetoedOrder: mean rank breaks a first-vote tie', () => {
  const verdicts = [V('A', ['A', 'B', 'C']), V('B', ['B', 'A', 'C']), V('C', ['C', 'A', 'B'])]
  // A/B/C each 1 first vote; mean ranks: A=(1+2+2)/3, B=(2+1+3)/3, C=(3+3+1)/3 -> A best
  assert.equal(nonVetoedOrder(verdicts, ['A', 'B', 'C'], new Set())[0], 'A')
})
test('nonVetoedOrder: vetoed candidates are excluded entirely', () => {
  const verdicts = [V('A', ['A', 'B']), V('A', ['A', 'B']), V('B', ['B', 'A'])]
  assert.deepEqual(nonVetoedOrder(verdicts, ['A', 'B'], new Set(['A'])), ['B'])
})
test('nonVetoedOrder: all vetoed -> empty (fast tally carries none; final rank -> NO_CONSENSUS)', () => {
  assert.deepEqual(nonVetoedOrder([V('A', ['A'])], ['A'], new Set(['A'])), [])
})
test('nonVetoedOrder: residual tie falls back to blind label order (deterministic)', () => {
  const verdicts = [V('A', ['A', 'B']), V('B', ['B', 'A'])]
  assert.deepEqual(nonVetoedOrder(verdicts, ['B', 'A'], new Set()), ['A', 'B'])
})

// ----- structural: fast tally -----
test('(structural) intermediate style never deliberates and carries top-2 on a split', () => {
  const cj = slice('async function councilJudge(', '\n// Render the council')
  assert.match(cj, /style === 'intermediate'/)
  assert.match(cj, /order\.slice\(0, 2\)/)
  assert.match(cj, /fast_tally = true/)
  assert.ok(!cj.includes('DELIBERATION round'), 'councilJudge must not run deliberation rounds any more')
})
test('(structural) two-pass Review is intermediate; final rank and implement reviews are final', () => {
  assert.ok(SRC.includes("mode === 'two' ? 'intermediate' : 'final'"))
  assert.ok(SRC.includes("`${roundName}-review`, LENSES, 'final')"))
})
test('(structural) final pool takes up to two carried champions', () => {
  assert.match(SRC, /\.\.\.champs\.map\(ch => \(\{ ws: ch\.ws/)
  assert.match(SRC, /carriedOverAll/)
})

// ----- structural: steelman shootout -----
test('(structural) steelman loop: always >=1 round, max 5, orchestrator pick after', () => {
  const cj = slice('async function councilJudge(', '\n// Render the council')
  assert.match(cj, /const maxIters = loneFinalist \? 1 : 5/)
  assert.match(cj, /needs_orchestrator_pick/)
  assert.match(cj, /decided_by/)
})
test('(structural) steelman is a non-voting synthesis helper with traceability rules', () => {
  const sm = slice('async function steelmanChangeLists(', 'async function boostCandidate(')
  assert.match(sm, /NOT a judge/)
  assert.match(sm, /traceable to a judge-cited con/)
})
test('(structural) boost failure ratchets to the last gated version, never worsens', () => {
  const cj = slice('async function councilJudge(', '\n// Render the council')
  assert.match(cj, /ratchet/)
  assert.match(cj, /currentWs\[/)
})
test('(structural) cold re-judge: runoff judges get roundNum=1 and no peer block', () => {
  const cj = slice('async function councilJudge(', '\n// Render the council')
  assert.match(cj, /-runoff\$\{iter\}-\$\{lens\.key\}-r1`, 1, null, i\)/)
})
test('(structural) security is absolute: both-vetoed runoff -> NO_CONSENSUS; orchestrator payload has no veto override', () => {
  const cj = slice('async function councilJudge(', '\n// Render the council')
  assert.match(cj, /bothVetoed/)
  assert.match(cj, /vetoed UNSAFE in the runoff/)
})
test('(structural) implement phase surfaces needs_orchestrator_pick instead of Round 4 / needs_human', () => {
  assert.match(SRC, /needs_orchestrator_pick: r3\.review\.needs_orchestrator_pick/)
  assert.match(SRC, /needs_human: !g4\.pass && !r4pick/)
})

// ----- structural: brief enhancements -----
test('(structural) every judge brief carries the anti-length-bias line', () => {
  const hits = (SRC.match(/thoroughness is evidence, not word count/gi) || []).length
  assert.ok(hits >= 2, `expected the anti-length line in council AND legacy briefs, found ${hits}`)
})
test('(structural) feasibility lens owns demand-the-proof claim auditing', () => {
  assert.match(SRC, /demand the proof: verify cited files, functions, and behaviours against the snapshot/)
})

// ----- structural: persist v2 -----
test('(structural) persist writes via quoted heredoc and verifies sha in code', () => {
  const pv = slice('async function persist(pairs, phaseTitle) {', '// ---- auto-filed engine issues')
  assert.match(pv, /<<'\$\{delim\}'/)
  assert.match(pv, /sha256Hex\(body\)/)
  assert.match(pv, /sha mismatch \(relay corruption\)/)
  assert.match(pv, /writeAndMeasure\(missing, false\)/) // retry forces the typed+verified path
})
test('(structural) derived artifacts render on disk via je-render.mjs, never through the model', () => {
  const pv = slice('async function persist(pairs, phaseTitle) {', '// ---- auto-filed engine issues')
  assert.match(pv, /je-render\.mjs/)
  assert.ok((SRC.match(/derive: \{ mode: '(verdict-md|council-json|guidance-md)'/g) || []).length >= 8, 'call sites should pass derive specs')
})
test('(structural) codex read-back is sha-verified before parse', () => {
  assert.match(SRC, /CODEX_JUDGE_SHA_MARK/)
  assert.match(SRC, /relay corruption: read-back sha256/)
})

// ----- je-render end-to-end: derived artifacts match the in-sandbox renderers byte-for-byte -----
const FIXTURE = {
  winner: 'A', no_consensus: false, ranking: ['A', 'B'],
  reasoning: 'Council majority: Candidate A took 4/5 first-place votes.',
  candidates: [
    { label: 'A', pros: ['[spec] complete'], cons: ['[craft] terse'] },
    { label: 'B', pros: [], cons: ['[correctness] fails on empty input'] },
  ],
  council: {
    lenses: ['correctness', 'spec'], rounds_used: 1, final_living: 5, no_consensus: false,
    fast_tally: true, carried: ['A', 'B'],
    rounds: [{ round: 1, living: ['correctness'], votes: { A: 4, B: 1 }, vetoed: [], winner: 'A', dead_seats: [], verdicts: [] }],
    vote_evolution: [{ round: 1, votes: { A: 4, B: 1 }, vetoed: [], winner: 'A', living: 5 }],
    veto_events: [],
    steelman: { seeds: ['A', 'B'], seed_votes: { A: 2, B: 2 }, seed_majority: null, decided_by: 'majority',
      rounds: [{ iteration: 1, change_lists: { A: ['tighten docs'], B: ['fix empty input'] }, gate: { A: 'boosted', B: 'boosted' }, votes: { A: 3, B: 2 }, vetoed: [], winner: 'A' }] },
  },
  guidance: { positives: [{ text: 'small diffs', conf: 'strong', why: 'held across attempts' }], challenges: ['scope creep'], carried_note: 'Carried champion(s): A, B (vote split A:2, B:2).' },
}
test('je-render output is byte-identical to the sandbox renderers (parity, all three modes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'je-render-'))
  const vPath = join(dir, 'verdict.json')
  writeFileSync(vPath, JSON.stringify(FIXTURE, null, 2) + '\n')
  const rendererBlock = slice('// ---- begin: report renderers', '// ---- end: report renderers')
  const capMatch = /const GUIDANCE_CAP = (\d+)/.exec(SRC)
  const api = new Function('GUIDANCE_CAP', rendererBlock + '\nreturn { verdictToMd, guidanceToMd };')(Number(capMatch[1]))
  execFileSync('node', [resolve(HERE, '../bin/je-render.mjs'), 'verdict-md', vPath, join(dir, 'v.md'), 'Test verdict'])
  execFileSync('node', [resolve(HERE, '../bin/je-render.mjs'), 'council-json', vPath, join(dir, 'c.json')])
  execFileSync('node', [resolve(HERE, '../bin/je-render.mjs'), 'guidance-md', vPath, join(dir, 'g.md')])
  assert.equal(readFileSync(join(dir, 'v.md'), 'utf8'), api.verdictToMd(FIXTURE, 'Test verdict'))
  assert.equal(readFileSync(join(dir, 'c.json'), 'utf8'), JSON.stringify(FIXTURE.council, null, 2) + '\n')
  assert.equal(readFileSync(join(dir, 'g.md'), 'utf8'), api.guidanceToMd(FIXTURE.guidance))
})
test('je-render renders steelman + fast-tally metadata into verdict.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'je-render-'))
  const vPath = join(dir, 'verdict.json')
  writeFileSync(vPath, JSON.stringify(FIXTURE) + '\n')
  execFileSync('node', [resolve(HERE, '../bin/je-render.mjs'), 'verdict-md', vPath, join(dir, 'v.md'), 'T'])
  const md = readFileSync(join(dir, 'v.md'), 'utf8')
  assert.match(md, /Steelman shootout/)
  assert.match(md, /Fast tally \(intermediate review\)/)
  assert.match(md, /Decided by:\*\* majority/)
})
