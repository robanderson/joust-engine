// =============================================================================
// je-council-audit.test.mjs — tests for the judge-panel decorrelation audit.
//
// Synthetic council.json fixtures only (no model, no network): fake runDirs
// with review-*/council.json are built in a temp dir. Covers: two perfectly-
// agreeing seats flagged as redundant; independent seats not flagged; security
// seats excluded from pruning hypotheses (info-only); Spearman math; effective
// votes greedy merge; missing/malformed files degrade gracefully; --runs-root
// discovery; ts from file mtimes (never Date.now).
//
// Run with:  node bin/je-council-audit.test.mjs
// =============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  spearman,
  isSecuritySeat,
  extractRounds,
  collectRun,
  aggregate,
  effectiveVotes,
  audit,
  reportMd,
  discoverRunsRoot,
  AGREE_THRESHOLD,
  MIN_N,
} from './je-council-audit.mjs'

const CLI = fileURLToPath(new URL('./je-council-audit.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'je-council-audit-test-'))

// ---------------------------------------------------------------------------
// fixture builder: one council.json with the given per-round verdicts
// ---------------------------------------------------------------------------
function writeCouncil(runDir, reviewName, roundsVerdicts, mtime) {
  const dir = join(runDir, reviewName)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'council.json')
  writeFileSync(
    path,
    JSON.stringify({
      lenses: [],
      rounds_used: roundsVerdicts.length,
      rounds: roundsVerdicts.map((verdicts, i) => ({ round: i + 1, verdicts })),
    }),
  )
  if (mtime) utimesSync(path, mtime, mtime)
  return path
}
const v = (lens, vote, ranking, judge_model = 'opus') => ({ lens, judge_model, vote, ranking })

// --- fixture: run with 6 rounds (>= MIN_N) across two review dirs -------------
// echo-a & echo-b: ALWAYS identical vote+ranking  -> must be flagged redundant.
// indep: votes differently every round            -> must NOT be flagged.
// security & security-x: also perfectly agreeing  -> info-only, never pruned.
const CANDS = ['A', 'B', 'C', 'D']
const runClone = join(TMP, '20260101-clone-run')
{
  const mk = (i) => {
    const echoVote = CANDS[i % 2] // A,B,A,B,...
    const echoRank = i % 2 ? ['B', 'A', 'C', 'D'] : ['A', 'B', 'C', 'D']
    const indepVote = CANDS[(i + 2) % 4] // C,D,A(≠echo? i=2: echo A... ) — see below
    return [
      v('echo-a', echoVote, echoRank),
      v('echo-b', echoVote, echoRank),
      // indep: agree with echo on ~1/3 of rounds at most (i=2 -> 'A' vs echo 'A')
      v('indep', indepVote, [...CANDS].reverse()),
      v('security', 'D', ['D', 'C', 'B', 'A']),
      v('security-x', 'D', ['D', 'C', 'B', 'A']),
    ]
  }
  // 3 rounds in review-1, 3 in review-final => 6 rounds total, aggregated
  writeCouncil(runClone, 'review-1', [mk(0), mk(1), mk(2)], new Date('2026-01-01T10:00:00Z'))
  writeCouncil(runClone, 'review-final', [mk(3), mk(4), mk(5)], new Date('2026-01-02T10:00:00Z'))
}

// ---------------------------------------------------------------------------
test('spearman: identical=1, reversed=-1, partial overlap, degenerate=null', () => {
  assert.equal(spearman(['A', 'B', 'C', 'D'], ['A', 'B', 'C', 'D']), 1)
  assert.equal(spearman(['A', 'B', 'C', 'D'], ['D', 'C', 'B', 'A']), -1)
  // common subset only: B,C,D shared; same relative order => 1
  assert.equal(spearman(['A', 'B', 'C', 'D'], ['B', 'C', 'D', 'E']), 1)
  assert.equal(spearman(['A', 'B'], ['A', 'B']), null) // <3 common
  assert.equal(spearman(null, ['A']), null)
})

test('isSecuritySeat: security lenses matched, others not', () => {
  assert.ok(isSecuritySeat('security'))
  assert.ok(isSecuritySeat('security-x'))
  assert.ok(isSecuritySeat('security-by-design (cross-family)'))
  assert.ok(!isSecuritySeat('risk'))
  assert.ok(!isSecuritySeat('simplicity'))
})

test('extractRounds: skips empty rounds and malformed verdicts', () => {
  const rounds = extractRounds(
    {
      rounds: [
        { round: 1, verdicts: [v('risk', 'A', CANDS), { nope: true }, null] },
        { round: 2, verdicts: [] },
        { round: 3 },
      ],
    },
    'src',
  )
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].seats.size, 1)
  assert.equal(rounds[0].seats.get('risk').vote, 'A')
})

test('aggregate: perfect pair flagged; independent seat not; n counted right', () => {
  const { rounds } = audit([runClone])
  assert.equal(rounds.length, 6)
  const { pairs } = aggregate(rounds)
  const pair = (a, b) => pairs.find((p) => p.a === a && p.b === b)

  const echo = pair('echo-a', 'echo-b')
  assert.equal(echo.n, 6)
  assert.equal(echo.agreement, 1)
  assert.equal(echo.meanRho, 1)
  assert.ok(echo.flagged, 'perfectly-agreeing pair at n=6 must be flagged')
  assert.ok(!echo.security)

  const ind = pair('echo-a', 'indep')
  assert.equal(ind.n, 6)
  assert.ok(ind.agreement < AGREE_THRESHOLD, `independent agreement ${ind.agreement} must be < ${AGREE_THRESHOLD}`)
  assert.ok(!ind.flagged, 'independent seat must not be flagged')
  assert.ok(ind.meanRho < 0, `indep ranks anti-correlated vs echo (got ${ind.meanRho})`)

  const sec = pair('security', 'security-x')
  assert.equal(sec.agreement, 1)
  assert.ok(sec.flagged)
  assert.ok(sec.security, 'security pair must carry the security marker')
})

test('effectiveVotes: greedy merge of flagged pairs only', () => {
  const { rounds } = audit([runClone])
  const { seats, pairs } = aggregate(rounds)
  // 5 seats; echo-a+echo-b merge, security+security-x merge => 3 clusters
  assert.equal(effectiveVotes([...seats.keys()].sort(), pairs), 3)
  // nothing flagged => every seat its own vote
  assert.equal(effectiveVotes(['x', 'y', 'z'], []), 3)
})

test('reportMd: redundancy flagged, security exempt from pruning, ts from mtimes', () => {
  const md = reportMd(audit([runClone]))
  // redundant pair called out as ~1 effective vote
  assert.match(md, /echo-a \+ echo-b .*~1 effective vote/)
  // pruning hypothesis names the non-security pair only
  assert.match(md, /Hypothesis \(n=6 rounds\): echo-a and echo-b/)
  // security pair: info-only, never a pruning candidate
  assert.match(md, /Info only \(n=6\): security \+ security-x .*NOT a pruning candidate/)
  assert.ok(!/Hypothesis \(n=\d+ rounds\): security/.test(md), 'no pruning hypothesis may target security seats')
  assert.match(md, /NEVER candidates for pruning/)
  // independent seat has no redundancy hypothesis
  assert.ok(!/Hypothesis \(n=\d+ rounds\): .*indep/.test(md))
  // effective votes: 5 seats -> ~3
  assert.match(md, /Seats observed: 5\..*~3 effective votes/)
  // data window comes from the pinned file mtimes, never "now"
  assert.match(md, /2026-01-01T10:00:00\.000Z \.\. 2026-01-02T10:00:00\.000Z \(council\.json mtimes\)/)
  // n everywhere: matrix cell for the echo pair
  assert.match(md, /1\.00 \(n=6\)/)
})

test('below MIN_N: high agreement is watch-listed, never a recommendation', () => {
  const runShort = join(TMP, '20260103-short-run')
  const mk = () => [v('p', 'A', CANDS), v('q', 'A', CANDS)]
  writeCouncil(runShort, 'review-1', [mk(), mk()], new Date('2026-01-03T10:00:00Z')) // n=2 < MIN_N
  const res = audit([runShort])
  const { pairs } = aggregate(res.rounds)
  const pq = pairs.find((p) => p.a === 'p' && p.b === 'q')
  assert.equal(pq.agreement, 1)
  assert.ok(!pq.flagged, `n=${pq.n} < ${MIN_N} must not flag`)
  const md = reportMd(res)
  assert.match(md, /insufficient data \(n=2 < 5\)/)
  assert.match(md, /Watch list .*p\+q at 1\.00 \(n=2\).*NO recommendation/)
  assert.ok(!md.includes('Hypothesis (n=2'))
})

test('missing/malformed inputs degrade gracefully', () => {
  // runDir that does not exist + runDir with malformed council.json
  const runBad = join(TMP, '20260104-bad-run')
  mkdirSync(join(runBad, 'review-1'), { recursive: true })
  writeFileSync(join(runBad, 'review-1', 'council.json'), '{not json')
  const res = audit([join(TMP, 'does-not-exist'), runBad])
  assert.equal(res.rounds.length, 0)
  assert.equal(res.runsAudited, 1) // runBad counted (it had a skipped file)
  assert.ok(res.skipped.some((s) => s.includes('does-not-exist')))
  assert.ok(res.skipped.some((s) => s.includes('unreadable or invalid JSON')))
  const md = reportMd(res)
  assert.match(md, /Nothing to audit/)
  assert.match(md, /Skipped inputs \(n=2\)/)
})

test('discoverRunsRoot: only subdirs with review-*/council.json', () => {
  const root = join(TMP, 'runs-root')
  const good = join(root, 'run-good')
  writeCouncil(good, 'review-1', [[v('a', 'A', CANDS), v('b', 'A', CANDS)]], new Date('2026-01-05T10:00:00Z'))
  mkdirSync(join(root, 'run-empty', 'review-1'), { recursive: true }) // no council.json
  mkdirSync(join(root, '_context'), { recursive: true }) // not a run dir
  assert.deepEqual(discoverRunsRoot(root), [good])
  assert.deepEqual(discoverRunsRoot(join(TMP, 'no-such-root')), [])
})

test('CLI: runDir args work; bad flag and no args exit 2', () => {
  const ok = spawnSync('node', [CLI, runClone], { encoding: 'utf8' })
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /Judge-panel decorrelation audit/)
  assert.match(ok.stdout, /echo-a \+ echo-b/)

  const root = spawnSync('node', [CLI, '--runs-root', join(TMP, 'runs-root')], { encoding: 'utf8' })
  assert.equal(root.status, 0)
  assert.match(root.stdout, /Runs audited: n=1/)

  const noArgs = spawnSync('node', [CLI], { encoding: 'utf8' })
  assert.equal(noArgs.status, 2)
  const badFlag = spawnSync('node', [CLI, '--bogus'], { encoding: 'utf8' })
  assert.equal(badFlag.status, 2)
})
