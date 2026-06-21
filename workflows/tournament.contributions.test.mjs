// workflows/tournament.contributions.test.mjs
// Unit tests for computeContributions() — the PURE per-model contribution estimator
// added by issue #18. The function lives inside workflows/tournament.mjs (a top-level-
// return sandbox script, not an importable ES module), so we extract the function block
// from the shipped source rather than hand-copying it (the repo's only test precedent).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC  = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

// Extract the entire contribution block (helpers + constants + computeContributions)
// between the two unique markers added in §2.1. Pure substring — no parser needed.
const BEGIN = '// ---- begin: contribution estimation (PURE; persistence is a separate thin step) ----'
const END   = '// ---- end: contribution estimation (PURE; persistence is a separate thin step) ----'
const i = SRC.indexOf(BEGIN)
const j = SRC.indexOf(END, i >= 0 ? i : 0)
if (i < 0 || j < 0) throw new Error('contribution block markers not found in workflows/tournament.mjs')
const block = SRC.slice(i, j)

// Eval the block into a sandbox and lift the symbols we want to test.
const sandbox = {}
new Function('sandbox', `
  with (sandbox) {
    ${block}
    sandbox.computeContributions   = computeContributions
    sandbox.CONTRIB_RANK_DECAY     = CONTRIB_RANK_DECAY
    sandbox.CONTRIB_WINNER_BONUS   = CONTRIB_WINNER_BONUS
    sandbox.CONTRIB_GUIDANCE_SHARE = CONTRIB_GUIDANCE_SHARE
  }
`)(sandbox)
const { computeContributions, CONTRIB_GUIDANCE_SHARE } = sandbox
assert.equal(typeof computeContributions, 'function', 'computeContributions must be a function')

// ----- fixture builders -----
const validMap = arr => arr.map((c, i) => ({
  candidate: c.letter, model: c.model, valid: true, ...(c.round ? { round: c.round } : {}),
}))
const invalidMap = (arr, invalids) => arr.map(c => invalids.includes(c.letter)
  ? { candidate: c.letter, model: c.model, valid: false, failReason: 'no deliverable' }
  : { candidate: c.letter, model: c.model, valid: true })
const review = (winner, ...rest) => ({ ranking: [winner, ...rest], winner, reasoning: 'test' })
const failReview = { __failed: 'judge died' }

// ----- tests -----

test('pcts sum to exactly 100 (no drift)', () => {
  const r1 = {
    mapping: validMap([{ letter: 'A', model: 'opus' }, { letter: 'B', model: 'sonnet' }, { letter: 'C', model: 'haiku' }]),
    review:  review('A', 'B', 'C'),
  }
  const out = computeContributions(r1, null, null, 'single')
  assert.equal(out.reduce((s, x) => s + x.pct, 0), 100, 'pcts must sum to exactly 100')
})

test('winning model has the largest share', () => {
  const r1 = {
    mapping: validMap([{ letter: 'A', model: 'opus' }, { letter: 'B', model: 'sonnet' }, { letter: 'C', model: 'haiku' }]),
    review:  review('A', 'B', 'C'),
  }
  const out = computeContributions(r1, null, null, 'single')
  assert.equal(out[0].model, 'opus', 'winner must be first (largest pct)')
  const rest = out.slice(1).reduce((s, x) => s + x.pct, 0)
  assert.ok(out[0].pct > rest, `winner (${out[0].pct}) must exceed sum of all others (${rest})`)
})

test('invalid/failed candidates contribute 0 (absent from output)', () => {
  const r1 = {
    mapping: invalidMap(
      [{ letter: 'A', model: 'opus' }, { letter: 'B', model: 'sonnet' }, { letter: 'C', model: 'haiku' }],
      ['B'] // sonnet failed validation
    ),
    review:  review('A', 'C'),
  }
  const out = computeContributions(r1, null, null, 'single')
  assert.equal(out.find(x => x.model === 'sonnet'), undefined, 'invalid model must be absent')
  assert.equal(out.reduce((s, x) => s + x.pct, 0), 100, 'still sums to 100 with one fewer model')
  assert.equal(out.length, 2)
})

test('single valid candidate: 100% to that model', () => {
  const r1 = { mapping: validMap([{ letter: 'A', model: 'opus' }]), review: review('A') }
  const out = computeContributions(r1, null, null, 'single')
  assert.equal(out.length, 1)
  assert.equal(out[0].model, 'opus')
  assert.equal(out[0].pct, 100)
})

test('single model in entire pool: 100%', () => {
  // Two valid candidates, same model — that model gets 100%.
  const r1 = {
    mapping: validMap([{ letter: 'A', model: 'opus' }, { letter: 'B', model: 'opus' }]),
    review:  review('A', 'B'),
  }
  const out = computeContributions(r1, null, null, 'single')
  assert.equal(out.length, 1)
  assert.equal(out[0].model, 'opus')
  assert.equal(out[0].pct, 100)
})

test('rival-fields-multiple-finalists: winner still dominant (acceptance criterion)', () => {
  // opus = 1 finalist (the winner), sonnet = 3 mid-ranked finalists, haiku = 1 last.
  // Plain linear weights would let sonnet tie or beat opus; super-linear + bonus
  // must keep opus dominant.
  const r1 = {
    mapping: validMap([
      { letter: 'A', model: 'opus'   },
      { letter: 'B', model: 'sonnet' },
      { letter: 'C', model: 'sonnet' },
      { letter: 'D', model: 'sonnet' },
      { letter: 'E', model: 'haiku'  },
    ]),
    review:  review('A', 'B', 'C', 'D', 'E'),
  }
  const out = computeContributions(r1, null, null, 'single')
  const opus   = out.find(x => x.model === 'opus')
  const sonnet = out.find(x => x.model === 'sonnet')
  assert.ok(opus,   'opus must be in output')
  assert.ok(sonnet, 'sonnet must be in output')
  assert.ok(opus.pct > sonnet.pct, `opus (${opus.pct}) must beat stacked sonnet (${sonnet.pct}) — the acceptance-criterion case`)
  assert.equal(out.reduce((s, x) => s + x.pct, 0), 100)
})

test('no valid candidates: returns []', () => {
  const r1 = { mapping: [{ candidate: 'A', model: 'opus', valid: false, failReason: 'failed' }], review: null }
  const out = computeContributions(r1, null, null, 'single')
  assert.deepEqual(out, [])
})

test('judge __failed: returns [] gracefully (no throw)', () => {
  const r1 = { mapping: validMap([{ letter: 'A', model: 'opus' }]), review: failReview }
  const out = computeContributions(r1, null, null, 'single')
  assert.deepEqual(out, [])
})

test('two-pass: round-1 models receive a guidance-channel slice', () => {
  // Round 1: A=opus, B=sonnet, C=haiku (A wins).
  // Round 2: D=opus, E=sonnet, F=haiku (D wins final).
  const r1 = {
    mapping: validMap([{ letter: 'A', model: 'opus' }, { letter: 'B', model: 'sonnet' }, { letter: 'C', model: 'haiku' }]),
    review:  review('A', 'B', 'C'),
  }
  const final = {
    mapping: validMap([
      { letter: 'D', model: 'opus',   round: 2 },
      { letter: 'E', model: 'sonnet', round: 2 },
      { letter: 'F', model: 'haiku',  round: 2 },
    ]),
    rank:       review('D', 'E', 'F'),
    winnerRound: 2,
  }
  const out = computeContributions(r1, { positives: [], challenges: [] }, final, 'two')
  assert.equal(out.reduce((s, x) => s + x.pct, 0), 100)
  // Every distinct round-1 model appears (guidance channel keeps them on the board
  // even when their round-2 attempt lost).
  for (const m of ['opus', 'sonnet', 'haiku']) {
    assert.ok(out.some(x => x.model === m), `${m} must appear in the two-pass breakdown`)
  }
  // Final winner (opus via D) has the dominant share.
  const opus = out.find(x => x.model === 'opus')
  assert.ok(opus.pct > 30, `final-winning opus should have a substantial share; got ${opus.pct}`)
  assert.ok(opus.pct > out.filter(x => x.model !== 'opus').reduce((s, x) => s + x.pct, 0),
    `opus (${opus.pct}) must exceed sum of all others — the two-pass dominant-share criterion`)
  // The detail string must mention the heuristic, the guidance share, and the source.
  assert.match(opus.detail, /ESTIMATE/i)
  assert.match(opus.detail, new RegExp(`${Math.round(CONTRIB_GUIDANCE_SHARE * 100)}% guidance-channel`))
  assert.match(opus.detail, /workflows\/tournament\.mjs/)
})

test('two-pass with no valid round-1 review: guidance channel collapses, code channel only', () => {
  // Degenerate two-pass: round-1 review failed, final review succeeded. The guidance
  // channel MUST collapse (no slice) and the result should equal the single-pass shape
  // over the final pool.
  const r1 = {
    mapping: validMap([{ letter: 'A', model: 'opus' }, { letter: 'B', model: 'sonnet' }]),
    review:  failReview,
  }
  const final = {
    mapping: validMap([{ letter: 'C', model: 'opus' }, { letter: 'D', model: 'sonnet' }]),
    rank:    review('C', 'D'),
  }
  const out = computeContributions(r1, { positives: [], challenges: [] }, final, 'two')
  assert.equal(out.reduce((s, x) => s + x.pct, 0), 100)
  const opus = out.find(x => x.model === 'opus')
  assert.ok(opus.pct >= 50, 'opus wins final, should still be dominant via code channel alone')
  // The detail string in this branch must NOT mention the guidance-channel slice.
  assert.doesNotMatch(opus.detail, /guidance-channel/)
})
