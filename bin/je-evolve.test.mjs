#!/usr/bin/env node
// =============================================================================
// je-evolve.test.mjs — tests for the GEPA-LITE brief-evidence miner.
//
// Synthetic fixtures only (no model, no network): fake runDirs with
// mapping.json / review-*/verdict.json / review-*/council.json are built in a
// temp dir. Covers: theme normalization (candidate letters stripped); >=3
// shared significant words cluster, unrelated don't; overlapping challenge
// themes across two runs cluster into one recurring signal; within-round lens
// echo does NOT count as recurrence; RC 05 cluster produces the save-contract
// suggestion; RC 03 produces the scope suggestion; per-model valid-rate +
// recurring failReason delta; missing verdict.json degrades gracefully;
// --runs-root discovery; template targeting; ts from file mtimes; CLI exit
// codes.
//
// Run with:  node bin/je-evolve.test.mjs
// =============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeTheme,
  significantWords,
  clusterThemes,
  isRecurring,
  isSaveContractFailure,
  templateForReviewDir,
  templateForRcSeat,
  collectRun,
  mine,
  reportMd,
  discoverRunsRoot,
  RECUR_MIN,
  SHARED_WORDS_MIN,
} from './je-evolve.mjs'

const CLI = fileURLToPath(new URL('./je-evolve.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'je-evolve-test-'))

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------
function writeJson(path, obj, mtime) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(obj))
  if (mtime) utimesSync(path, mtime, mtime)
}

const THEME_SAVE =
  'Attempts forget to persist the deliverable file before finishing, leaving the required deliverable file missing from the workspace.'
const THEME_SAVE_B =
  'Several attempts never persist the required deliverable file to the workspace before finishing, so the deliverable file is missing.'
const THEME_SCOPE = 'Expanding scope beyond the smallest coherent change adds blast radius on fail-safety code.'

// runA: mapping with recurring glm-5.2 save failures + RC 05 + RC 03, one
// verdict.json guidance block, council with the SAME con echoed by two lenses
// in ONE round (must NOT count as recurrence) plus a round-2 repeat (counts).
function buildRunA(root) {
  const dir = join(root, 'runA')
  writeJson(
    join(dir, 'mapping.json'),
    {
      mode: 'composeOnly',
      n: 4,
      rc_summary: {
        seats: 6,
        by_code: { '00': 3, '03': 1, '05': 2 },
        non00: [
          { seat: 'candidate-2', phase: 'Review', rc: '05', reason: 'no-deliverable' },
          { seat: 'candidate-3', phase: 'Review', rc: '05', reason: 'no-deliverable' },
          { seat: 'candidate-4', phase: 'Review', rc: '03', reason: 'turn-cap' },
        ],
      },
      round1: [
        { candidate: 'A', model: 'opus', valid: true },
        { candidate: 'B', model: 'glm-5.2', valid: false, failReason: 'no deliverable saved' },
        { candidate: 'C', model: 'glm-5.2', valid: false, failReason: 'no deliverable saved' },
        { candidate: 'D', model: 'sonnet', valid: true },
      ],
    },
    new Date('2026-07-01T10:00:00Z'),
  )
  writeJson(
    join(dir, 'review-1', 'verdict.json'),
    {
      winner: 'A',
      guidance: {
        positives: [{ text: 'good things happened', conf: 'strong', why: 'x' }],
        challenges: [
          { text: THEME_SAVE, conf: 'strong', why: 'seen twice' },
          { text: 'A one-off oddity about candidate B misreading zebras.', conf: 'tentative', why: 'once' },
        ],
      },
    },
    new Date('2026-07-01T11:00:00Z'),
  )
  writeJson(
    join(dir, 'review-1', 'council.json'),
    {
      rounds: [
        {
          round: 1,
          verdicts: [
            { lens: 'feasibility', vote: 'A', pros_cons: [{ label: 'B', pros: [], cons: [THEME_SCOPE] }] },
            { lens: 'simplicity', vote: 'A', pros_cons: [{ label: 'B', pros: [], cons: [THEME_SCOPE] }] },
          ],
        },
        {
          round: 2,
          verdicts: [{ lens: 'feasibility', vote: 'A', pros_cons: [{ label: 'B', pros: [], cons: [THEME_SCOPE] }] }],
        },
      ],
    },
    new Date('2026-07-01T12:00:00Z'),
  )
  return dir
}

// runB: overlapping challenge theme (clusters with runA), NO council.json,
// and an implement-review verdict (targets implement-brief).
function buildRunB(root) {
  const dir = join(root, 'runB')
  writeJson(
    join(dir, 'mapping.json'),
    {
      mode: 'two',
      n: 2,
      round1: [
        { candidate: 'A', model: 'opus', valid: true },
        { candidate: 'B', model: 'glm-5.2', valid: false, failReason: 'no deliverable saved' },
      ],
    },
    new Date('2026-07-02T10:00:00Z'),
  )
  writeJson(
    join(dir, 'review-1', 'verdict.json'),
    { winner: 'A', guidance: { challenges: [{ text: THEME_SAVE_B, conf: 'strong', why: 'y' }] } },
    new Date('2026-07-02T11:00:00Z'),
  )
  writeJson(
    join(dir, 'review-impl-1', 'verdict.json'),
    { winner: 'A', guidance: { challenges: [{ text: THEME_SAVE_B, conf: 'strong', why: 'y' }] } },
    new Date('2026-07-02T12:00:00Z'),
  )
  return dir
}

// runC: degradation case — review dir exists but verdict.json is MISSING and
// council.json is malformed; mapping.json absent.
function buildRunC(root) {
  const dir = join(root, 'runC')
  mkdirSync(join(dir, 'review-1'), { recursive: true })
  writeFileSync(join(dir, 'review-1', 'council.json'), '{not json')
  return dir
}

const RUN_A = buildRunA(TMP)
const RUN_B = buildRunB(TMP)
const RUN_C = buildRunC(TMP)

// ---------------------------------------------------------------------------
// normalization + clustering unit tests
// ---------------------------------------------------------------------------
test('normalizeTheme strips candidate letters and punctuation', () => {
  assert.equal(normalizeTheme('Candidate A forgets to SAVE the file!'), 'forgets to save the file')
  assert.equal(normalizeTheme('B and C both miss it.'), 'and both miss it')
})

test('significantWords drops stopwords and short tokens', () => {
  const w = significantWords('The attempts should never forget the deliverable file')
  assert.ok(w.has('forget') && w.has('deliverable') && w.has('file'))
  assert.ok(!w.has('the') && !w.has('should') && !w.has('never') && !w.has('attempts'))
})

test(`clusterThemes joins texts sharing >= ${SHARED_WORDS_MIN} significant words, keeps unrelated apart`, () => {
  const clusters = clusterThemes([
    { text: THEME_SAVE, source: 'runA/review-1' },
    { text: THEME_SAVE_B, source: 'runB/review-1' },
    { text: 'Judges disagree wildly about zebra formatting styles.', source: 'runB/review-1' },
  ])
  assert.equal(clusters.length, 2)
  const big = clusters.find((c) => c.n === 2)
  assert.ok(big, 'overlapping save themes must cluster')
  assert.deepEqual(big.runs, ['runA', 'runB'])
  assert.ok(isRecurring(big))
  assert.ok(!isRecurring(clusters.find((c) => c.n === 1)))
})

test('clusterThemes is deterministic regardless of input order', () => {
  const items = [
    { text: THEME_SAVE_B, source: 'runB/review-1' },
    { text: THEME_SAVE, source: 'runA/review-1' },
  ]
  const a = clusterThemes(items)
  const b = clusterThemes([...items].reverse())
  assert.deepEqual(a, b)
})

test('within-round lens echo is NOT recurrence; across rounds IS', () => {
  const oneRound = clusterThemes([
    { text: THEME_SCOPE, source: 'runA/review-1/round-1' },
    { text: THEME_SCOPE, source: 'runA/review-1/round-1' },
  ])
  assert.equal(oneRound.length, 1)
  assert.ok(!isRecurring(oneRound[0]), 'same-round echo must not pass the evidence bar')
  const twoRounds = clusterThemes([
    { text: THEME_SCOPE, source: 'runA/review-1/round-1' },
    { text: THEME_SCOPE, source: 'runA/review-1/round-2' },
  ])
  assert.ok(isRecurring(twoRounds[0]))
})

// ---------------------------------------------------------------------------
// helper classification tests
// ---------------------------------------------------------------------------
test('isSaveContractFailure matches deliverable/save reasons only', () => {
  assert.ok(isSaveContractFailure('no deliverable saved'))
  assert.ok(isSaveContractFailure('failed to save output'))
  assert.ok(!isSaveContractFailure('timeout'))
})

test('template targeting: review dirs and rc seats', () => {
  assert.equal(templateForReviewDir('runB/review-impl-1'), 'implement-brief')
  assert.equal(templateForReviewDir('runA/review-1'), 'attempt plan-brief')
  assert.equal(templateForReviewDir('runA/review-final'), 'attempt plan-brief')
  assert.deepEqual(templateForRcSeat('review-simplicity-r1:codex'), ['judge lens brief'])
  assert.deepEqual(templateForRcSeat('final-rank-security-x-r1:codex'), ['judge lens brief'])
  assert.deepEqual(templateForRcSeat('candidate-10'), ['attempt plan-brief', 'implement-brief'])
})

// ---------------------------------------------------------------------------
// collectRun / mine
// ---------------------------------------------------------------------------
test('collectRun extracts seats, rc signals, challenges, cons, mtimes', () => {
  const res = collectRun(RUN_A)
  assert.equal(res.run, 'runA')
  assert.equal(res.mode, 'composeOnly')
  assert.equal(res.seats.length, 4)
  assert.equal(res.rcSignals.filter((s) => s.rc === '05').length, 2)
  assert.equal(res.rcSignals.filter((s) => s.rc === '03').length, 1)
  assert.equal(res.challenges.length, 2)
  assert.equal(res.cons.length, 3) // 2 lenses round-1 + 1 lens round-2
  assert.equal(res.councilRounds, 2)
  // ts from file mtimes, never Date.now
  assert.equal(res.tsMin.toISOString(), '2026-07-01T10:00:00.000Z')
  assert.equal(res.tsMax.toISOString(), '2026-07-01T12:00:00.000Z')
})

test('collectRun degrades gracefully: missing verdict.json + malformed council.json', () => {
  const res = collectRun(RUN_C)
  assert.equal(res.challenges.length, 0)
  assert.equal(res.cons.length, 0)
  assert.equal(res.skipped.length, 1)
  assert.match(res.skipped[0], /council\.json .*invalid JSON/)
})

test('collectRun on a nonexistent dir yields empty result, no crash', () => {
  const res = collectRun(join(TMP, 'does-not-exist'))
  assert.equal(res.seats.length + res.challenges.length + res.cons.length, 0)
  assert.equal(res.tsMin, null)
})

test('mine aggregates models and rc signals across runs', () => {
  const agg = mine([RUN_A, RUN_B, RUN_C])
  assert.equal(agg.runsMined, 3) // runC has a skipped artifact, so it counts as mined-with-skips
  const glm = agg.models.get('glm-5.2')
  assert.equal(glm.seats, 3)
  assert.equal(glm.valid, 0)
  assert.equal(glm.failReasons.get('no deliverable saved').n, 3)
  assert.deepEqual([...glm.failReasons.get('no deliverable saved').runs].sort(), ['runA', 'runB'])
  assert.equal(agg.rc05.length, 2)
  assert.equal(agg.rc03.length, 1)
  assert.ok(agg.composeOnlyRuns.has('runA'))
  assert.equal(agg.tsMax.toISOString(), '2026-07-02T12:00:00.000Z')
})

test('mine flags a dir with no artifacts as skipped, not mined', () => {
  const empty = join(TMP, 'emptyRun')
  mkdirSync(empty, { recursive: true })
  const agg = mine([empty])
  assert.equal(agg.runsMined, 0)
  assert.equal(agg.skipped.length, 1)
})

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
test('report: overlapping challenge themes across two runs cluster into one recurring signal', () => {
  const md = reportMd(mine([RUN_A, RUN_B]))
  // one Signal-B observation citing both runs
  assert.match(md, /## Signal B/)
  assert.match(md, /runs: runA, runB/)
  // and it produced a suggested delta with an id
  assert.match(md, /SUGGESTED BRIEF DELTA \[S\d+\] \(hypothesis\)/)
})

test('report: RC 05 cluster produces the save-contract suggestion', () => {
  const md = reportMd(mine([RUN_A]))
  assert.match(md, /RC 05 no-deliverable exits/)
  assert.match(md, /n=2 seats.*runs: runA/)
  assert.match(md, /save contract may be unclear/)
  assert.match(md, /moving the save instruction earlier in the brief and repeating it as the final line/)
})

test('report: RC 03 produces the scope suggestion', () => {
  const md = reportMd(mine([RUN_A]))
  assert.match(md, /RC 03 turn-cap exits/)
  assert.match(md, /brief scope may be too big for the turn budget/)
})

test('report: recurring failReason yields per-model save delta with n=', () => {
  const md = reportMd(mine([RUN_A, RUN_B]))
  assert.match(md, /attempts on glm-5\.2 failed with "no deliverable saved"/)
  assert.match(md, /n=3\/3 seats/)
})

test('report: within-round lens echo alone yields no Signal-C delta; round-2 repeat does', () => {
  const md = reportMd(mine([RUN_A]))
  // THEME_SCOPE appears in round-1 twice AND round-2 once -> 2 distinct sources -> recurring
  assert.match(md, /## Signal C/)
  assert.match(md, /Expanding scope beyond the smallest coherent change/)
})

test('report: final section maps suggestions to worker templates and flags orchestrator out of scope', () => {
  const md = reportMd(mine([RUN_A, RUN_B]))
  assert.match(md, /## Suggested deltas → target templates/)
  assert.match(md, /OUT OF SCOPE: ORCHESTRATOR\/skill prose is NEVER a mutation target/)
  assert.match(md, /implement-brief/) // runB's review-impl-1 evidence targets implement-brief
  assert.match(md, /composer prompt/) // runA is composeOnly
  assert.match(md, /judge lens brief|attempt plan-brief/)
})

test('report: missing verdict.json degrades gracefully (runC still reported)', () => {
  const md = reportMd(mine([RUN_C]))
  assert.match(md, /Runs mined: n=1/)
  assert.match(md, /Skipped inputs \(n=1\)/)
  assert.match(md, /No failReason recurs|No mapping\.json seat data/)
})

test('report: zero runs -> nothing to mine, no crash', () => {
  const md = reportMd(mine([join(TMP, 'nope-1'), join(TMP, 'nope-2')]))
  assert.match(md, /Nothing to mine/)
})

test('report: n= appears everywhere evidence is claimed', () => {
  const md = reportMd(mine([RUN_A, RUN_B]))
  for (const line of md.split('\n')) {
    if (/\*\*Observation/.test(line)) assert.match(line, /n=\d+/)
  }
})

// ---------------------------------------------------------------------------
// discovery + CLI
// ---------------------------------------------------------------------------
test('discoverRunsRoot finds run-like subdirs only', () => {
  const found = discoverRunsRoot(TMP).map((p) => p.split('/').pop())
  assert.ok(found.includes('runA') && found.includes('runB') && found.includes('runC'))
  assert.ok(!found.includes('emptyRun'))
  assert.deepEqual(discoverRunsRoot(join(TMP, 'no-such-root')), [])
})

test('CLI: explicit run dirs -> exit 0, markdown on stdout', () => {
  const r = spawnSync('node', [CLI, RUN_A, RUN_B], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /# Brief-evolution evidence report \(GEPA-LITE\)/)
  assert.match(r.stdout, /Runs mined: n=2/)
})

test('CLI: --runs-root <dir> discovers runs', () => {
  const r = spawnSync('node', [CLI, '--runs-root', TMP], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Runs mined: n=3/)
})

test('CLI: no args -> usage, exit 2; unknown flag -> exit 2', () => {
  const r1 = spawnSync('node', [CLI], { encoding: 'utf8' })
  assert.equal(r1.status, 2)
  assert.match(r1.stderr, /usage/)
  const r2 = spawnSync('node', [CLI, '--bogus'], { encoding: 'utf8' })
  assert.equal(r2.status, 2)
})
