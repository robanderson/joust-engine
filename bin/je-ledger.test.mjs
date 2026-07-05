// =============================================================================
// je-ledger.test.mjs — tests for the cross-run leaderboard ledger (issue #41).
//
// Synthetic fixtures only (no model, no network): two fake runDirs are built in
// a temp dir, recorded twice into a temp ledger (JE_LEDGER_PATH), and the
// report is asserted to contain the expected rows. Also covers: missing
// timeline.jsonl degrades gracefully, malformed timeline lines are skipped,
// re-recording a run is a no-op, JE_LEDGER_PATH is respected by the CLI, and
// missing mapping.json fails loudly (exit 1) instead of crashing.
//
// Run with:  node bin/je-ledger.test.mjs
// =============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRecord, record, readLedger, reportMd, analyzeTimeline, ledgerPath } from './je-ledger.mjs'

const CLI = fileURLToPath(new URL('./je-ledger.mjs', import.meta.url))
const TMP = mkdtempSync(join(tmpdir(), 'je-ledger-test-'))

// --- fixture 1: a two-pass run with timeline + rc_summary ---------------------
const runA = join(TMP, '20260101-run-alpha')
mkdirSync(runA, { recursive: true })
writeFileSync(
  join(runA, 'mapping.json'),
  JSON.stringify({
    mode: 'two',
    n: 3,
    rc_summary: { seats: 5, by_code: { '00': 4, '02': 1 } },
    round1: [
      { candidate: 'A', model: 'opus', valid: true },
      { candidate: 'B', model: 'sonnet', valid: true },
      { candidate: 'C', model: 'glm-5.2', valid: false, failReason: 'security veto (unsafe rm)' },
    ],
    winner1: 'A',
    final: [
      { candidate: 'A', model: 'sonnet', round: 2, valid: true },
      { candidate: 'B', model: 'sonnet', round: 2, valid: true },
      { candidate: 'C', model: 'sonnet', round: 2, valid: true },
      { candidate: 'D', model: 'opus', round: 1, valid: true },
    ],
    winner: 'B',
    winnerRound: 2,
  }),
)
// round-2 seats are ALL sonnet -> attempt durations attributable; round-1 is mixed -> not.
writeFileSync(
  join(runA, 'timeline.jsonl'),
  [
    JSON.stringify({ label: 'context-bundler', durSecs: 30 }),
    JSON.stringify({ label: 'attempt:round-1/candidate-1', durSecs: 100 }),
    JSON.stringify({ label: 'attempt:round-1/candidate-2', durSecs: 300 }),
    JSON.stringify({ label: 'attempt:round-1/candidate-3', durSecs: 200 }),
    'this line is not JSON and must be skipped',
    JSON.stringify({ label: 'attempt:round-2/candidate-1', durSecs: 400 }),
    JSON.stringify({ label: 'attempt:round-2/candidate-2', durSecs: 200 }),
    JSON.stringify({ label: 'judge:risk@review-1', durSecs: 999 }), // not an attempt
  ].join('\n') + '\n',
)
// Pin mapping.json's mtime so the record ts is deterministic and provably NOT "now".
utimesSync(join(runA, 'mapping.json'), new Date('2026-01-01T12:00:00Z'), new Date('2026-01-01T12:00:00Z'))

// --- fixture 2: a single-pass run, NO timeline, NO rc_summary -----------------
const runB = join(TMP, '20260102-run-beta')
mkdirSync(runB, { recursive: true })
writeFileSync(
  join(runB, 'mapping.json'),
  JSON.stringify({
    mode: 'single',
    n: 2,
    round1: [
      { candidate: 'A', model: 'opus', valid: true },
      { candidate: 'B', model: 'minimax-m3', valid: false, failReason: 'no deliverable saved' },
    ],
    winner1: 'A',
  }),
)

const LEDGER = join(TMP, 'ledger.jsonl')

// ---------------------------------------------------------------------------
test('ledgerPath: env override respected, default under ~/.joust-engine', () => {
  assert.equal(ledgerPath({ JE_LEDGER_PATH: '/x/y.jsonl' }), '/x/y.jsonl')
  assert.ok(ledgerPath({}).endsWith(join('.joust-engine', 'ledger.jsonl')))
})

test('buildRecord: full run — ts from mtime, seats, winners, rc, barrier, attempts', () => {
  const rec = buildRecord(runA)
  assert.equal(rec.run, '20260101-run-alpha')
  assert.equal(rec.ts, '2026-01-01T12:00:00.000Z') // mapping.json mtime, not Date.now
  assert.equal(rec.mode, 'two')
  assert.equal(rec.n, 3)
  assert.equal(rec.winner1, 'A')
  assert.equal(rec.winner, 'B')
  assert.equal(rec.winnerRound, 2)
  assert.equal(rec.seats.length, 7) // 3 round1 + 4 final
  const veto = rec.seats.find((s) => s.candidate === 'C' && s.phase === 'round1')
  assert.equal(veto.valid, false)
  assert.match(veto.failReason, /veto/)
  assert.deepEqual(rec.rc_summary.by_code, { '00': 4, '02': 1 })
  // barrier: slowest attempt per phase group
  assert.deepEqual(rec.barrier, [
    { group: 'round-1', seat: 'candidate-2', durSecs: 300 },
    { group: 'round-2', seat: 'candidate-1', durSecs: 400 },
  ])
  // attempts: round-2 uniform (all sonnet) -> attributed; round-1 mixed -> no model
  const r1 = rec.attempts.find((a) => a.group === 'round-1')
  const r2 = rec.attempts.find((a) => a.group === 'round-2')
  assert.deepEqual(r1, { group: 'round-1', n: 3, meanSecs: 200 })
  assert.deepEqual(r2, { group: 'round-2', n: 2, meanSecs: 300, model: 'sonnet' })
})

test('buildRecord: missing timeline degrades gracefully (no barrier/attempts keys)', () => {
  const rec = buildRecord(runB)
  assert.equal(rec.run, '20260102-run-beta')
  assert.equal(rec.mode, 'single')
  assert.equal(rec.winner1, 'A')
  assert.equal(rec.winner, null)
  assert.equal(rec.seats.length, 2)
  assert.ok(!('barrier' in rec))
  assert.ok(!('attempts' in rec))
  assert.ok(!('rc_summary' in rec))
})

test('analyzeTimeline: skips malformed lines and non-attempt labels', () => {
  const { barrier, attempts } = analyzeTimeline(['garbage', JSON.stringify({ label: 'judge:x', durSecs: 5 })])
  assert.deepEqual(barrier, [])
  assert.deepEqual(attempts, [])
})

test('record twice + duplicate skip; report contains expected rows', () => {
  const a = record(runA, LEDGER)
  const b = record(runB, LEDGER)
  assert.equal(a.skipped, false)
  assert.equal(b.skipped, false)
  const dup = record(runA, LEDGER)
  assert.equal(dup.skipped, true)
  assert.equal(readFileSync(LEDGER, 'utf8').trim().split('\n').length, 2) // append-only, no dup line

  const records = readLedger(LEDGER)
  assert.equal(records.length, 2)
  const md = reportMd(records)
  assert.match(md, /Runs recorded: n=2 \((two=1, single=1|single=1, two=1)\)/)
  // per-model leaderboard rows carry n= everywhere
  assert.match(md, /\| sonnet \| n=4 \| 100% \(n=4\) \| 0 \| 1 \| 0 \| 0 \| 300s \(n=2\) \|/)
  assert.match(md, /\| opus \| n=3 \| 100% \(n=3\) \| 2 \| 1 \| 0 \| 0 \| — \(n=0\) \|/)
  assert.match(md, /\| glm-5\.2 \| n=1 \| 0% \(n=1\) \| 0 \| 0 \| 0 \| 1 \| — \(n=0\) \|/)
  // two-pass value: runA's final winner came from round 2
  assert.match(md, /Final winners in two-pass runs \(n=1\): fresh round-2 = 1, carried round-1 = 0\./)
  // diversity: 2 final winners total (runA final B=sonnet, runB single-pass winner1 A=opus)
  assert.match(md, /Final wins across models \(n=2\):/)
  // rc totals summed
  assert.match(md, /00=4, 02=1 \(n=1 runs with rc_summary\)/)
  // hypotheses: all n<5 -> no recommendations
  assert.match(md, /Insufficient data for any hypothesis \(need n>=5 per row\)\./)
})

test('reportMd: empty ledger says how to record', () => {
  assert.match(reportMd([]), /No runs recorded yet/)
})

test('CLI: JE_LEDGER_PATH respected end-to-end (record + report)', () => {
  const cliLedger = join(TMP, 'cli-ledger.jsonl')
  const env = { ...process.env, JE_LEDGER_PATH: cliLedger }
  const r1 = spawnSync('node', [CLI, 'record', runA], { env, encoding: 'utf8' })
  assert.equal(r1.status, 0, r1.stderr)
  assert.match(r1.stderr, /recorded "20260101-run-alpha"/)
  assert.ok(existsSync(cliLedger))
  const r2 = spawnSync('node', [CLI, 'record', runA], { env, encoding: 'utf8' })
  assert.equal(r2.status, 0)
  assert.match(r2.stderr, /already recorded/)
  const rep = spawnSync('node', [CLI, 'report'], { env, encoding: 'utf8' })
  assert.equal(rep.status, 0, rep.stderr)
  assert.match(rep.stdout, /Runs recorded: n=1/)
  assert.match(rep.stdout, /\| sonnet \|/)
})

test('CLI: missing mapping.json fails with exit 1, no stack trace crash', () => {
  const empty = join(TMP, 'not-a-run')
  mkdirSync(empty, { recursive: true })
  const r = spawnSync('node', [CLI, 'record', empty], {
    env: { ...process.env, JE_LEDGER_PATH: join(TMP, 'x.jsonl') },
    encoding: 'utf8',
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no mapping\.json/)
})

test('CLI: bad usage exits 2', () => {
  const r = spawnSync('node', [CLI, 'frobnicate'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage:/)
})
