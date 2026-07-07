// Design-briefs altitude + A/B implement seeding (rob/design-briefs).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'tournament.mjs'), 'utf8')

function extractBlock(b, e) {
  const i = SRC.indexOf(b), j = SRC.indexOf(e, i)
  if (i < 0 || j < 0) throw new Error(`markers missing: ${b}`)
  return SRC.slice(i, j)
}
const ab = new Function(extractBlock('// ---- begin: ab briefs', '// ---- end: ab briefs') + '\nreturn { assignAbSeeds };')()

test('assignAbSeeds alternates two seeds; anything else is a no-op copy', () => {
  const pool = [{ label: 'i1' }, { label: 'i2' }, { label: 'i3' }, { label: 'i4' }, { label: 'i5' }]
  const out = ab.assignAbSeeds(pool, ['/p/a.md', '/p/b.md'])
  assert.deepEqual(out.map(a => a.seedBrief), ['brief-1', 'brief-2', 'brief-1', 'brief-2', 'brief-1'])
  assert.deepEqual(out.map(a => a.seedPlanPath), ['/p/a.md', '/p/b.md', '/p/a.md', '/p/b.md', '/p/a.md'])
  for (const bad of [null, [], ['/one'], ['/a', ''], ['/a', '/b', '/c']]) {
    const same = ab.assignAbSeeds(pool, bad)
    assert.ok(same.every(a => !a.seedBrief && !a.seedPlanPath), `no partial seeding for ${JSON.stringify(bad)}`)
  }
  assert.ok(!pool[0].seedBrief, 'input not mutated')
})

test('(structural) plan brief is a DESIGN BRIEF with the hard altitude rule', () => {
  assert.match(SRC, /You are producing a DESIGN BRIEF/)
  assert.match(SRC, /AT MOST 10 bullets/)
  assert.match(SRC, /ALTITUDE RULE \(hard\): NO code blocks, NO diffs, NO line numbers, NO function bodies/)
  assert.match(SRC, /ACCEPTANCE CRITERIA \(2-4 bullets\): testable, approach-neutral/)
  assert.ok(!/CONCRETE and FILE-LEVEL: name each file/.test(SRC), 'old file-level plan mandate removed')
})

test('(structural) implement seeding is per-attempt and the A/B hook exists', () => {
  assert.match(SRC, /a\.seedPlanPath \|\| seedPlanPath/, 'per-attempt seed override')
  assert.match(SRC, /const AB_BRIEFS = A\.abBriefs === true/)
  assert.match(SRC, /sm\.seeds/, 'runner-up comes from steelman SEEDS (the top-2 non-vetoed; `finalists` exists only in the needs_orchestrator_pick payload — live bug from the run-h calibration)')
  assert.match(SRC, /sm\.finalists/, 'pick-payload fallback retained')
  assert.match(SRC, /seedBrief: c\.seedBrief/, 'mapping records lineage')
  const seedIdx = SRC.indexOf('seedBrief: c.seedBrief')
  const judgeIdx = SRC.indexOf("judge('code reviewer'")
  assert.ok(seedIdx > 0 && judgeIdx > 0, 'both present')
})

test('(structural) plan lenses retuned to brief altitude', () => {
  assert.match(SRC, /score it down for that, never up for the extra detail/)
  assert.match(SRC, /never reward line-level specificity/)
  assert.match(SRC, /A longer brief is not a better brief/)
})
