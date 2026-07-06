// Extract-and-eval unit tests for the issue #36 identical-candidate dedup + dynamic-M pure blocks.
// Same convention as workflows/tournament-return-codes.test.mjs: slice the marked PURE block out of
// tournament.mjs and eval it in an isolated function scope, so the tests exercise the real shipped
// source (no copy drift) without importing the whole impure workflow module.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, 'tournament.mjs'), 'utf8')

// Pull the text between a `// ---- begin: <name>` marker and its matching `// ---- end: <name>`
// marker, then eval it and return the requested top-level bindings.
function evalBlock(beginSub, endSub, exportNames) {
  const b = SRC.indexOf(beginSub)
  assert.ok(b >= 0, `missing block start: ${beginSub}`)
  const e = SRC.indexOf(endSub, b)
  assert.ok(e >= 0, `missing block end: ${endSub}`)
  const body = SRC.slice(b, e)
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\n;return { ${exportNames.join(', ')} };`)()
}

const dedup = evalBlock(
  '// ---- begin: identical-candidate dedup',
  '// ---- end: identical-candidate dedup',
  ['groupIdenticalCandidates', 'inContention', 'convergenceLineFor'],
)
const dyn = evalBlock(
  '// ---- begin: dynamic M',
  '// ---- end: dynamic M',
  ['DYNAMIC_M', 'parseConvergenceEvidence', 'trimSeatsForConvergence'],
)

const cand = (blind, valid = true, extra = {}) => ({ blind, valid, displayModel: 'm-' + blind, ...extra })

// ===== dedup: grouping =====
test('two byte-identical valid candidates collapse; rep = lowest letter; no re-lettering', () => {
  const staged = [cand('A'), cand('B')]
  const g = dedup.groupIdenticalCandidates(staged, { A: 'h1', B: 'h1' })
  assert.deepEqual(g.map(c => c.blind), ['A', 'B']) // letters preserved
  assert.deepEqual(g[0].collapse, { rep: 'A', group: ['A', 'B'] })
  assert.deepEqual(g[1].collapse, { rep: 'A', group: ['A', 'B'] })
  assert.equal(g[0].valid, true)
  assert.equal(g[1].valid, true)
})

test('representative selection is deterministic (lowest letter regardless of input order)', () => {
  const staged = [cand('C'), cand('A'), cand('B')]
  const g = dedup.groupIdenticalCandidates(staged, { C: 'x', A: 'x', B: 'x' })
  for (const c of g) assert.equal(c.collapse.rep, 'A')
  assert.deepEqual(g[0].collapse.group, ['A', 'B', 'C']) // sorted
})

test('three identical => all tied to one rep; two are non-representative', () => {
  const staged = [cand('A'), cand('B'), cand('C')]
  const g = dedup.groupIdenticalCandidates(staged, { A: 'z', B: 'z', C: 'z' })
  assert.equal(g.filter(dedup.inContention).length, 1)
  assert.equal(g.find(c => c.blind === 'A').collapse.group.length, 3)
})

test('distinct hashes => NO collapse field on anyone (no-duplicate fixture unchanged)', () => {
  const staged = [cand('A'), cand('B'), cand('C')]
  const g = dedup.groupIdenticalCandidates(staged, { A: 'h1', B: 'h2', C: 'h3' })
  for (const c of g) assert.equal(c.collapse, undefined)
  assert.equal(g.filter(dedup.inContention).length, 3)
})

test('missing / NONE hash never collapses (fail-safe singleton)', () => {
  const staged = [cand('A'), cand('B')]
  const g1 = dedup.groupIdenticalCandidates(staged, { A: 'h1' }) // B has no hash
  assert.equal(g1.find(c => c.blind === 'A').collapse, undefined)
  const g2 = dedup.groupIdenticalCandidates(staged, null) // whole map missing
  for (const c of g2) assert.equal(c.collapse, undefined)
})

test('invalid candidate is never grouped and never in contention', () => {
  const staged = [cand('A'), cand('B', false, { failReason: 'no deliverable saved' })]
  const g = dedup.groupIdenticalCandidates(staged, { A: 'h', B: 'h' })
  assert.equal(g.find(c => c.blind === 'B').collapse, undefined) // invalid untouched
  assert.equal(g.find(c => c.blind === 'B').failReason, 'no deliverable saved')
  assert.equal(dedup.inContention(g.find(c => c.blind === 'B')), false)
})

// ===== dedup: contention predicate =====
test('inContention: rep in, non-rep out, plain valid in, invalid out', () => {
  assert.equal(dedup.inContention({ blind: 'A', valid: true, collapse: { rep: 'A', group: ['A', 'B'] } }), true)
  assert.equal(dedup.inContention({ blind: 'B', valid: true, collapse: { rep: 'A', group: ['A', 'B'] } }), false)
  assert.equal(dedup.inContention({ blind: 'A', valid: true }), true)
  assert.equal(dedup.inContention({ blind: 'A', valid: false }), false)
})

// ===== dedup: convergence stamp (letters + count only; blindness) =====
test('convergenceLineFor: rep of >=2 group gets a letters+count stamp; others get null', () => {
  const line = dedup.convergenceLineFor({ blind: 'A', collapse: { rep: 'A', group: ['A', 'B', 'C'] } })
  assert.match(line, /^CONVERGENCE: 3 implementers produced this identical artifact \(candidates A, B, C\)/)
  assert.doesNotMatch(line, /\//) // no path
  assert.doesNotMatch(line, /m-[A-Z]/) // no model identity
  assert.equal(dedup.convergenceLineFor({ blind: 'B', collapse: { rep: 'A', group: ['A', 'B'] } }), null)
  assert.equal(dedup.convergenceLineFor({ blind: 'A' }), null)
})

// ===== dynamic M: seat trimming =====
const seats4 = [{ label: 's1' }, { label: 's2' }, { label: 's3' }, { label: 's4' }]

test('unchanged (same reference) when evidence is null — no ledger / read failure', () => {
  assert.equal(dyn.trimSeatsForConvergence(seats4, null), seats4)
})

test('unchanged when samples below the floor', () => {
  assert.equal(dyn.trimSeatsForConvergence(seats4, { samples: 4, convergenceRatio: 0.9 }), seats4)
})

test('unchanged when convergence ratio below the threshold', () => {
  assert.equal(dyn.trimSeatsForConvergence(seats4, { samples: 20, convergenceRatio: 0.3 }), seats4)
})

test('trims exactly one seat (reduce-only prefix) when both bars clear', () => {
  const out = dyn.trimSeatsForConvergence(seats4, { samples: 10, convergenceRatio: 0.8 })
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(s => s.label), ['s1', 's2', 's3']) // stable prefix
})

test('never drops below the M_FLOOR', () => {
  const seats3 = seats4.slice(0, 3)
  const out = dyn.trimSeatsForConvergence(seats3, { samples: 99, convergenceRatio: 1 })
  assert.equal(out.length, Math.max(dyn.DYNAMIC_M.M_FLOOR, 2))
  // at/below floor => untouched (same reference)
  const seats2 = seats4.slice(0, 2)
  assert.equal(dyn.trimSeatsForConvergence(seats2, { samples: 99, convergenceRatio: 1 }), seats2)
})

test('never grows the seat list', () => {
  const out = dyn.trimSeatsForConvergence(seats4, { samples: 10, convergenceRatio: 0.99 })
  assert.ok(out.length <= seats4.length)
})

// ===== dynamic M: evidence parsing =====
test('parseConvergenceEvidence reads a well-formed ledger line', () => {
  assert.deepEqual(
    dyn.parseConvergenceEvidence('noise\nJE-LEDGER-CONVERGENCE samples=7 ratio=0.62\nmore'),
    { samples: 7, convergenceRatio: 0.62 },
  )
})

test('parseConvergenceEvidence returns null on missing / garbled input', () => {
  assert.equal(dyn.parseConvergenceEvidence(''), null)
  assert.equal(dyn.parseConvergenceEvidence(null), null)
  assert.equal(dyn.parseConvergenceEvidence('JE-LEDGER-CONVERGENCE samples=x ratio=y'), null)
})

test('end-to-end: garbled ledger read leaves the seat count unchanged', () => {
  const ev = dyn.parseConvergenceEvidence('unexpected ledger output')
  assert.equal(ev, null)
  assert.equal(dyn.trimSeatsForConvergence(seats4, ev), seats4)
})

// ===== structural wiring: order-of-operations in the real shipped source =====
// These assert WHERE things are wired in tournament.mjs (not just that the pure helpers behave),
// since the dedup/dynamic-M seams are position-sensitive: dedup must run after the mechanical/
// contract merge and before the pool rebuild, the trim must gate the seat pool before A/B, and the
// convergence stamp must ride both pool-rebuild writers.
const at = (needle) => {
  const i = SRC.indexOf(needle)
  assert.ok(i >= 0, `missing source anchor: ${needle}`)
  return i
}

test('dedup runs AFTER the mechanical/contract merge and BEFORE the pool rebuild', () => {
  const merge = at('mergeContract(mergeMechanical(staged, byBlind)')
  const group = at('const grouped = groupIdenticalCandidates(merged, byHash)')
  const rebuild = at('grouped.filter(inContention)')
  assert.ok(merge < group, 'grouping must consume the already-merged candidates')
  assert.ok(group < rebuild, 'the pool must be rebuilt from the grouped/contention-filtered set')
  // the gate returns the grouped set (so downstream judging sees collapses), not the pre-group merge
  assert.ok(at('return grouped') > group)
})

test('identity hash is guarded (nfiles>0 AND shasum present) before it can collapse anything', () => {
  const guard = at('command -v shasum')
  const emit = at('echo "JHASH ${c.blind}')
  assert.ok(guard < emit, 'the JHASH token is only emitted after the empty-set / no-shasum guard')
  assert.ok(SRC.includes('${nfiles:-0}" -gt 0'), 'zero-file deliverables degrade to NONE, never false-merge')
})

test('convergence stamp rides BOTH pool-rebuild writers (mechanical + enrich)', () => {
  const n = SRC.split('convergenceStampShell(convergenceLineFor(c))').length - 1
  assert.equal(n, 2, 'the stamp must be wired into both the mechanical-pool and enrich-pool rebuilds')
})

test('dynamic-M seat trim gates the pool BEFORE the A/B assignment and BEFORE implementPhase', () => {
  const trim = at('const trimmed = trimSeatsForConvergence(implementSeats, ev)')
  const gate = at('if (DYNAMIC_M_ON) {')
  const abAssign = at('assignAbSeeds(implementSeats,')
  const implPhase = at('const impl = await implementPhase(seedPlanPath)')
  assert.ok(gate <= trim, 'the trim is gated by the opt-in DYNAMIC_M_ON flag')
  assert.ok(trim < abAssign, 'trim the base pool BEFORE A/B so the split re-alternates the trimmed pool')
  assert.ok(abAssign < implPhase, 'seats are finalized before the implement phase runs')
  // regression guard (issue #36 item 7): A/B must re-alternate the TRIMMED pool, never slice a prefix
  // of an already-alternated one — so the old assignAbSeeds(implementAttempts, …) wiring is gone.
  assert.ok(!SRC.includes('assignAbSeeds(implementAttempts'), 'A/B must not re-alternate the untrimmed base pool')
})
