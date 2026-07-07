// Run L (2026-07-07): S1 codex review-seat concurrency cap + Q1 seat-model audit.
// Evidence base: 4-way concurrent `codex review` measured ~4x single-seat latency (judge-architecture
// experiment); run-h's security-x seat silently ran as opus with nothing auditable at summary level.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

// ----- S1: concurrency cap -----
test('codex judge dispatch is gated by a slot semaphore, default cap 2, arg-overridable', () => {
  assert.match(SRC, /CODEX_JUDGE_MAX_CONCURRENT = Math\.max\(1, Number\(A\.codexJudgeConcurrency\) \|\| 2\)/)
  const i = SRC.indexOf('await acquireCodexSlot()')
  assert.ok(i > 0, 'slot acquired')
  const tail = SRC.slice(i, i + 400)
  assert.ok(tail.includes('RUNVERBATIM_JUDGE(dispatchCmd'), 'slot wraps the LIVE codex dispatch')
  assert.ok(tail.includes('finally { releaseCodexSlot() }'), 'slot released on every path (finally)')
})

test('semaphore wake is over-admission-safe: waiter RE-CHECKS the cap on wake (while, not if)', () => {
  assert.match(SRC, /while \(codexSlotActive >= CODEX_JUDGE_MAX_CONCURRENT\) await new Promise/)
})

test('readback + reformat run OUTSIDE the slot (cheap stages must not hold a codex lane)', () => {
  const rel = SRC.indexOf('finally { releaseCodexSlot() }')
  const read = SRC.indexOf(`label: \`\${label}-codex-read\``)
  const fmt = SRC.indexOf(`label: \`\${label}-codex-reformat\``)
  assert.ok(rel > 0 && read > rel && fmt > read, 'release precedes readback and reformat')
})

// ----- Q1: seat-model audit -----
test('every living lens verdict is audited: codex path and native path both route through auditSeatModel', () => {
  assert.ok(SRC.includes(`return auditSeatModel(phaseTitle, label, lens, 'codex', result)`), 'codex success audited')
  assert.match(SRC, /return auditSeatModel\(phaseTitle, label, lens, dispatchMode,\s*\n\s*await askLensNative\(/, 'native (incl. codex->opus fallback) audited')
})

test('security-sweep M15: as_intended is an EXACT-effort check (a codex-xhigh→codex-low downgrade is flagged, not hidden)', () => {
  assert.match(SRC, /const intended = dispatchMode === 'codex' \? `codex-\$\{CODEX_JUDGE_EFFORT\}` : 'opus'/,
    'intended is the exact configured effort, not the family — the old startsWith("codex-") hid effort downgrades')
  assert.ok(SRC.includes('const as_intended = actual === intended'), 'exact compare')
  assert.ok(SRC.includes('const CODEX_JUDGE_EFFORT ='), 'single resolved-effort constant')
  assert.ok(SRC.includes('const judgeEffort = CODEX_JUDGE_EFFORT'), 'dispatch + audit share the one resolution')
  assert.ok(SRC.includes('JE-SEAT-AUDIT ['), 'mismatch is loudly logged')
})

test('rcSummaryLive attaches judge_seats additively — absent before the first council point', () => {
  const i = SRC.indexOf('const rcSummaryLive = () =>')
  const body = SRC.slice(i, i + 400)
  assert.ok(body.includes('seatModelAudit.length ? { ...s, judge_seats: seatModelAudit.slice() } : s'),
    'legacy rc_summary shape preserved when no council ran')
})

test('audit never resurrects a dead seat: null verdicts pass through unaudited', () => {
  const i = SRC.indexOf('function auditSeatModel(')
  const body = SRC.slice(i, i + 300)
  assert.ok(body.includes('if (!verdict) return verdict'), 'null-safe passthrough')
})
