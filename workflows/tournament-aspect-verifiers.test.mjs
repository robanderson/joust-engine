// Aspect verifiers with binary approvals (BoN-MAV, arXiv:2502.20379; args.aspectVerifiers, default OFF).
// Pure logic is extracted from the marked block in tournament.mjs and eval'd (repo convention —
// see tournament-return-codes.test.mjs); orchestration/wiring is covered structurally.
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

const ASPECT_BLOCK = extractBlock('// ---- begin: aspect verifiers ----', '// ---- end: aspect verifiers ----')
const av = new Function(ASPECT_BLOCK + '\nreturn { ASPECTS, aspectQuestionFor, aspectTally, aspectTiebreak };')()

// ---------------- ASPECT table ----------------

test('ASPECTS: exactly 4 binary aspects with a plan and a code phrasing each', () => {
  assert.deepEqual(av.ASPECTS.map(a => a.key), ['correct-behaviour', 'spec-fit', 'simplicity', 'robustness'])
  for (const a of av.ASPECTS) {
    assert.ok(typeof a.plan === 'string' && a.plan.trim().endsWith('?'), `${a.key} plan question is a question`)
    assert.ok(typeof a.code === 'string' && a.code.trim().endsWith('?'), `${a.key} code question is a question`)
    assert.notEqual(a.plan, a.code, `${a.key} phrased per artifact`)
  }
})

test('aspectQuestionFor: plan phrasing at the PLAN decision points, code everywhere else', () => {
  const a = av.ASPECTS[0]
  assert.equal(av.aspectQuestionFor(a, 'Review'), a.plan)
  assert.equal(av.aspectQuestionFor(a, 'Final rank'), a.plan)
  for (const phase of ['Round 1', 'Implement Review', 'Implement Final rank', 'anything-else']) {
    assert.equal(av.aspectQuestionFor(a, phase), a.code, phase)
  }
})

// ---------------- aspectTally (approval counts + abstention handling) ----------------

test('aspectTally: counts strict trues only — false and null (abstain) never count', () => {
  assert.deepEqual(av.aspectTally({
    A: [true, true, false, true],
    B: [true, null, null, false],
    C: [null, null, null, null],   // every aspect abstained on C
    D: [],
  }), { A: 3, B: 1, C: 0, D: 0 })
})

test('aspectTally: defensive on junk input', () => {
  assert.deepEqual(av.aspectTally(null), {})
  assert.deepEqual(av.aspectTally({}), {})
  assert.deepEqual(av.aspectTally({ A: null }), { A: 0 })
  // truthy non-boolean junk is NOT an approval
  assert.deepEqual(av.aspectTally({ A: [1, 'true', {}, true] }), { A: 1 })
})

// ---------------- aspectTiebreak (only-on-ties property) ----------------

test('aspectTiebreak: reorders ONLY inside exact-tie groups, by approvals desc then incoming order', () => {
  const order = [['A'], ['B', 'C', 'D'], ['E']]
  // C leads the tie group; A and E never move
  assert.deepEqual(av.aspectTiebreak(order, { A: 0, B: 1, C: 4, D: 2, E: 4 }), ['A', 'C', 'D', 'B', 'E'])
  // equal approvals inside the group -> incoming (blind-letter) order preserved
  assert.deepEqual(av.aspectTiebreak(order, { B: 2, C: 2, D: 2 }), ['A', 'B', 'C', 'D', 'E'])
  // missing labels count 0
  assert.deepEqual(av.aspectTiebreak(order, { D: 1 }), ['A', 'D', 'B', 'C', 'E'])
})

test('aspectTiebreak: never overrides the council order otherwise', () => {
  // singletons (no exact ties) are NEVER moved, whatever the approvals say
  const noTies = [['A'], ['B'], ['C']]
  assert.deepEqual(av.aspectTiebreak(noTies, { A: 0, B: 4, C: 4 }), ['A', 'B', 'C'])
  // flat labels are treated as singletons too
  assert.deepEqual(av.aspectTiebreak(['A', 'B', 'C'], { C: 9 }), ['A', 'B', 'C'])
})

test('aspectTiebreak: null/empty approvals or junk order degrade to the unchanged flattened order', () => {
  const order = [['A'], ['B', 'C']]
  assert.deepEqual(av.aspectTiebreak(order, null), ['A', 'B', 'C'])
  assert.deepEqual(av.aspectTiebreak(order, {}), ['A', 'B', 'C'])
  assert.deepEqual(av.aspectTiebreak(null, { A: 1 }), [])
  assert.deepEqual(av.aspectTiebreak([], null), [])
})

// ---------------- nonVetoedOrder integration (tiebreak at the blind-letter slot) ----------------

const NVO_SRC = extractBlock('// Non-vetoed candidates in carry/seed order', '// A compact, blind (letters-only) peer block')
const nvo = new Function(ASPECT_BLOCK + '\n' + NVO_SRC + '\nreturn { nonVetoedOrder };')().nonVetoedOrder

test('nonVetoedOrder: approvals break ONLY exact (first-votes, mean-rank) ties, between mean-rank and blind-letter', () => {
  const labels = ['A', 'B', 'C']
  const verdicts = [
    { vote: 'A', ranking: ['A', 'B', 'C'] },
    { vote: 'A', ranking: ['A', 'C', 'B'] },
  ] // A: 2 first votes; B and C: exact tie (0 votes, mean rank 2.5 each)
  assert.deepEqual(nvo(verdicts, labels, new Set()), ['A', 'B', 'C'], 'no approvals -> blind-letter tiebreak (unchanged behaviour)')
  assert.deepEqual(nvo(verdicts, labels, new Set(), { C: 3, B: 1 }), ['A', 'C', 'B'], 'approvals break the exact tie')
  assert.deepEqual(nvo(verdicts, labels, new Set(), { B: 2, C: 2 }), ['A', 'B', 'C'], 'equal approvals -> blind letter still decides')
  assert.deepEqual(nvo(verdicts, labels, new Set(), { A: 0, B: 4, C: 4 }), ['A', 'B', 'C'], 'approvals NEVER override first-place votes')
  assert.deepEqual(nvo(verdicts, labels, new Set(['A']), { C: 3 }), ['C', 'B'], 'veto filter untouched — vetoed candidates excluded before any tiebreak')
})

// ---------------- structural wiring ----------------

test('(structural) feature is flag-gated on args.aspectVerifiers === true', () => {
  assert.match(SRC, /const ASPECT_VERIFIERS = A\.aspectVerifiers === true/)
  assert.ok(SRC.includes('const aspectsPromise = ASPECT_VERIFIERS ? aspectVerify(blindList, poolPath, phaseTitle) : null'), 'runner only launches under the flag')
})

test('(structural) aspectVerify runs CONCURRENTLY with the round-1 lens fan-out', () => {
  const launch = SRC.indexOf('const aspectsPromise = ASPECT_VERIFIERS ? aspectVerify(')
  const r1 = SRC.indexOf('const r1raw = await parallelQuorum(lenses')
  assert.ok(launch > 0 && r1 > 0 && launch < r1, 'aspect fan-out is launched (un-awaited) before the lens fan-out awaits')
  assert.ok(!SRC.includes('await aspectVerify('), 'never awaited inline — only via the concurrent promise')
  assert.ok(SRC.includes('const aspects = aspectsPromise ? await aspectsPromise : null'), 'awaited only after round 1')
  // the fan-out itself is a parallelQuorum with lensTimeoutSecsFor-style null timeouts
  const body = extractBlock('async function aspectVerify(', '// Non-vetoed candidates in carry/seed order')
  assert.match(body, /parallelQuorum\(ASPECTS/)
  assert.match(body, /timeoutSecsFor: \(\) => null/)
})

test('(structural) tiebreak is wired at the blind-letter slot of nonVetoedOrder ONLY', () => {
  // exactly 1 definition + exactly 1 call site (inside nonVetoedOrder) — comments excluded
  const codeLines = SRC.split('\n').filter(l => l.includes('aspectTiebreak(') && !l.trim().startsWith('//'))
  assert.equal(codeLines.filter(l => l.includes('function aspectTiebreak(')).length, 1)
  assert.deepEqual(codeLines.filter(l => !l.includes('function aspectTiebreak(')).map(l => l.trim()),
    ['return aspectTiebreak(groups, aspectApprovals)'])
  assert.match(SRC, /function nonVetoedOrder\(verdicts, labels, vetoedSet, aspectApprovals = null\)/)
  // both councilJudge order sites pass the (possibly null) approvals; no other consumer exists
  assert.ok(SRC.includes('nonVetoedOrder(verdicts, labels, t.vetoedSet, aspectApprovals)'))
  assert.equal(SRC.split('nonVetoedOrder(verdicts, labels, t.vetoedSet, aspectApprovals)').length - 1, 2, 'fast-tally carry order + steelman seed order')
  assert.ok(!SRC.includes('nonVetoedOrder(verdicts, labels, t.vetoedSet)'), 'no un-wired call site remains')
})

test('(structural) tally, veto, carry rules and the judges:1 legacy path are untouched', () => {
  // deterministic majority tally + veto machinery contain no aspect reference
  const tallySrc = extractBlock('function councilTally(verdicts)', '// ---- begin: aspect verifiers ----')
  assert.ok(!/aspect/i.test(tallySrc), 'councilTally / veto never see aspects')
  assert.ok(SRC.includes('const threshold = living / 2'), 'majority threshold unchanged')
  // fast-tally carry rule unchanged beyond the tiebreak slot
  assert.ok(SRC.includes('const carried = t.winner != null ? [t.winner] : order.slice(0, 2)'))
  // consolidated ranking (downstream bookkeeping) untouched
  const consSrc = extractBlock('function consolidatedRanking(', 'function mergeCandidates(')
  assert.ok(!/aspect/i.test(consSrc))
  // judges:1 legacy judge body untouched
  const legacySrc = extractBlock('async function judge(kind, blindList', '// ==== 5-judge deliberating council')
  assert.ok(!/aspect/i.test(legacySrc))
})

test('(structural) strict binary schema, HELPER_MODEL seats, fail-safe abstention', () => {
  const schemaSrc = extractBlock('const ASPECT_VOTE_SCHEMA = {', 'async function askAspect(')
  assert.match(schemaSrc, /approve: \{ type: 'boolean' \}/)
  assert.ok((schemaSrc.match(/additionalProperties: false/g) || []).length >= 2, 'strict at both levels')
  assert.match(schemaSrc, /required: \['label', 'approve', 'reason'\]/)
  const askSrc = extractBlock('async function askAspect(', 'async function aspectVerify(')
  assert.match(askSrc, /model: HELPER_MODEL/)
  assert.match(askSrc, /ABSTAINS \(never fatal\)/)
  assert.ok(/return null\n/.test(askSrc) && /catch \(e\)/.test(askSrc), 'dead aspect agent degrades to null (abstain), never throws')
})

test('(structural) results persist in council metadata and reach the steelman context', () => {
  assert.ok(SRC.includes('result.council.aspects = aspects'), 'aspects recorded in council metadata (-> council.json)')
  assert.ok(SRC.includes('return { approvals, by_aspect }'), 'per-candidate approval counts + per-aspect votes')
  assert.ok(SRC.includes('steelmanChangeLists(seeds, steelmanVerdicts, phaseTitle, `${label}-i${iter}`, aspects)'), 'steelman receives aspect context')
  assert.match(SRC, /function aspectSteelmanContext\(aspects, finalists\)/)
  assert.ok(SRC.includes('${aspectSteelmanContext(aspects, finalists)}'), 'context appended to the steelman prompt')
})
