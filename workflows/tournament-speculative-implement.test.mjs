// Run N (S2, 2026-07-07): speculative implement overlap — flag-gated (args.speculativeImplement),
// DEFAULT OFF. The steelman shootout (the measured long pole: ~30-50 min live) overlaps with
// Implement Round 3, seeded with the tally leader's pre-steelman brief; a flip discards + wipes +
// re-runs clean. Structural pins: default-off, single registration point, fire-once, flip hygiene.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

test('flag-gated default OFF: every speculative branch requires SPECULATIVE_IMPLEMENT (=== true opt-in)', () => {
  assert.ok(SRC.includes('const SPECULATIVE_IMPLEMENT = A.speculativeImplement === true'))
  assert.match(SRC, /if \(implement && SPECULATIVE_IMPLEMENT\) \{\s*\n\s*onSteelmanSeeds =/, 'registration is doubly gated (implement AND flag)')
})

test('the seed hook is registered ONLY before the plan final rank, fires ONCE, and never leaks', () => {
  const reg = SRC.indexOf('onSteelmanSeeds = (seeds) => {')
  const call = SRC.indexOf(`judge('final ranker', blindF`)
  const clear = SRC.indexOf('onSteelmanSeeds = null // Run N: never leaks past the plan final rank')
  assert.ok(reg > 0 && call > reg && clear > call, 'register -> final-rank judge -> unconditional clear')
  assert.ok(SRC.includes('const h = onSteelmanSeeds; onSteelmanSeeds = null; try { h(seeds.slice()) }'),
    'councilJudge clears BEFORE firing — no other council point can re-trigger it')
})

test('a FLIP awaits the speculative round to completion, WIPES its staging + workspaces, then re-runs clean', () => {
  const flip = SRC.indexOf('JE-SPECULATIVE-FLIP')
  assert.ok(flip > 0)
  const tail = SRC.slice(flip, flip + 900)
  assert.ok(tail.includes('await speculativeImpl.promise.catch(() => null)'), 'awaited — in-flight agents can never collide with the re-run')
  assert.ok(tail.includes('rm -rf') && tail.includes('review-impl-3') && tail.includes('/impl-3'), 'both the review staging and the workspace round dir are wiped')
  const wipe = SRC.indexOf('speculative-wipe')
  const rebundle = SRC.indexOf('if (!specHit) await bundlePlan(planWinner.ws, seedPlanPath)')
  assert.ok(wipe > 0 && rebundle > wipe, 'clean re-bundle happens after the wipe')
})

test('a HIT adopts the pre-started round via implementPhase(preR3) and skips the duplicate pre-steps', () => {
  assert.ok(SRC.includes('async function implementPhase(seedPlanPath, preR3 = null)'))
  assert.ok(SRC.includes('const r3 = preR3 ? await preR3 : await implementRound('), 'substitution, not a parallel fork of the phase')
  assert.ok(SRC.includes('implementPhase(seedPlanPath, specHit ? speculativeImpl.promise : null)'))
  assert.match(SRC, /if \(DYNAMIC_M_ON && !specHit\)/, 'dynamic-M trim stays a normal-path decision')
  assert.ok(SRC.includes('if (AB_BRIEFS && !specHit) {'), 'A/B was already assigned at seed time on a hit')
})

test('disclosure: implement.json records enabled/leader/hit and that the seed was PRE-steelman', () => {
  assert.ok(SRC.includes(`speculative: { enabled: true`), 'speculative block persisted')
  assert.ok(SRC.includes(`seed: 'pre-steelman'`), 'the semantic difference from the normal path is disclosed, not hidden')
})
