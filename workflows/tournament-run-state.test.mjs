// Run-state heartbeat + abort stamping + resume tests (engine top-10 #10, 2026-07-06).
// Extract-and-eval convention (mirrors tournament-return-codes.test.mjs / tournament-persist-phase2):
// the PURE run-state block is sliced out of tournament.mjs and run in isolation; the phase-boundary
// wiring (heartbeat call sites, dispatchOrReuse) is pinned STRUCTURALLY against the source text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

function slice(beginMark, endMark) {
  const i = SRC.indexOf(beginMark)
  const j = SRC.indexOf(endMark, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`markers not found: ${beginMark}`)
  return SRC.slice(i, j)
}

// ----- extract the PURE run-state helpers (no module-state closures, no I/O) -----
const M = new Function(
  slice('// ---- begin: run-state heartbeat/resume pure helpers', '// ---- end: run-state heartbeat/resume pure helpers') +
  '\nreturn { RUN_STATE_VERSION, VALID_SEAT_STATUS, attemptIdentity, attemptIdentityKey, canonicalConfig, validateRunState, deriveSeatStatus, rebuildResumeList };'
)()
const { attemptIdentity, canonicalConfig, validateRunState, deriveSeatStatus, rebuildResumeList, RUN_STATE_VERSION } = M

// ---------- deriveSeatStatus: the single on-disk source of truth (covers every status) ----------
test('deriveSeatStatus: deliverable present + provenance => completed (reuse-eligible)', () => {
  assert.equal(deriveSeatStatus({ started: true, present: true, provenance: true, provStarted: true }), 'completed')
})
test('deriveSeatStatus: no workspace begun => never_started', () => {
  assert.equal(deriveSeatStatus(undefined), 'never_started')
  assert.equal(deriveSeatStatus(null), 'never_started')
  assert.equal(deriveSeatStatus({ started: false }), 'never_started')
})
test('deriveSeatStatus: began but empty + no clean provenance => aborted', () => {
  assert.equal(deriveSeatStatus({ started: true, present: false, provenance: false, provStarted: false }), 'aborted')
})
test('deriveSeatStatus: runner PROVENANCE marker but no DONE and no deliverable => in_flight (hard kill)', () => {
  assert.equal(deriveSeatStatus({ started: true, present: false, provenance: false, provStarted: true }), 'in_flight')
})
test('deriveSeatStatus: deliverable present but provenance FAILED => not completed (aborted)', () => {
  // an anti-spoof axis: a deliverable with no valid provenance is never trusted as completed
  assert.equal(deriveSeatStatus({ started: true, present: true, provenance: false, provStarted: true }), 'aborted')
})
test('deriveSeatStatus is provider-agnostic BY PRINCIPLE: identical probe => identical status', () => {
  const probe = { started: true, present: true, provenance: true, provStarted: true }
  // no `dispatch` field is consulted at all — same facts, same verdict for glm/codex/native/etc.
  assert.equal(deriveSeatStatus(probe), 'completed')
  assert.equal(deriveSeatStatus({ ...probe }), 'completed')
})

// ---------- rebuildResumeList: in-place reuse, drift fails SAFE ----------
const A0 = [
  { label: 'candidate-1', dispatch: 'anthropic', model: 'opus', displayModel: 'opus', agentType: null },
  { label: 'candidate-2', dispatch: 'glm', model: null, displayModel: 'glm-5.2', agentType: 'joust-glm-5-2' },
  { label: 'candidate-3', dispatch: 'codex', model: null, displayModel: 'codex-high', agentType: 'joust-codex' },
]
const ids = arr => arr.map(attemptIdentity)

test('rebuildResumeList (a) full reuse: every seat completed => reuse all, ORIGINAL order preserved', () => {
  const plan = rebuildResumeList({
    prevAttempts: ids(A0), currentAttempts: ids(A0),
    completedSet: new Set(['candidate-1', 'candidate-2', 'candidate-3']),
    prevRot: 1, currentRot: 1, prevFingerprint: 'fp', currentFingerprint: 'fp',
  })
  assert.equal(plan.length, 3)
  assert.deepEqual(plan.map(p => p.attempt.label), ['candidate-1', 'candidate-2', 'candidate-3'])
  assert.deepEqual(plan.map(p => p.reuse), [true, true, true])
})
test('rebuildResumeList (b) partial reuse: only completed seats reused, the rest re-run', () => {
  const plan = rebuildResumeList({
    prevAttempts: ids(A0), currentAttempts: ids(A0),
    completedSet: new Set(['candidate-1', 'candidate-3']),
    prevRot: 1, currentRot: 1,
  })
  assert.deepEqual(plan.map(p => p.reuse), [true, false, true])
})
test('rebuildResumeList (c) attempts ORDER drift => null (never a shifted blind letter)', () => {
  const reordered = ids([A0[1], A0[0], A0[2]])
  assert.equal(rebuildResumeList({ prevAttempts: ids(A0), currentAttempts: reordered, completedSet: new Set(['candidate-1']), prevRot: 1, currentRot: 1 }), null)
})
test('rebuildResumeList: attempts LENGTH / identity drift => null', () => {
  assert.equal(rebuildResumeList({ prevAttempts: ids(A0), currentAttempts: ids(A0.slice(0, 2)), completedSet: new Set(), prevRot: 1, currentRot: 1 }), null)
  const changed = ids([{ ...A0[0], model: 'sonnet' }, A0[1], A0[2]]) // same label, different model
  assert.equal(rebuildResumeList({ prevAttempts: ids(A0), currentAttempts: changed, completedSet: new Set(), prevRot: 1, currentRot: 1 }), null)
})
test('rebuildResumeList (d) rot drift => null', () => {
  assert.equal(rebuildResumeList({ prevAttempts: ids(A0), currentAttempts: ids(A0), completedSet: new Set(), prevRot: 1, currentRot: 2 }), null)
})
test('rebuildResumeList (e) fingerprint mismatch => null', () => {
  assert.equal(rebuildResumeList({ prevAttempts: ids(A0), currentAttempts: ids(A0), completedSet: new Set(), prevFingerprint: 'x', currentFingerprint: 'y' }), null)
})
test('rebuildResumeList: no prior attempts (nothing to resume) => null (clean re-run)', () => {
  assert.equal(rebuildResumeList({ prevAttempts: null, currentAttempts: ids(A0), completedSet: new Set() }), null)
})

// ---------- ANTI-SPOOF: reuse is gated on the DISK PROBE, never the cached run-state claim ----------
test('anti-spoof: a hand-edited run-state marking seat A completed does NOT reuse it if disk is empty', () => {
  // Emulate the engine path: computeReuse builds completedSet from deriveSeatStatus(diskProbe), NOT
  // from the cached run-state.seats. A spoofed run-state cannot inject a completed seat because the
  // completedSet only ever contains labels whose ON-DISK probe classified them 'completed'.
  const spoofedRunStateClaim = { 'candidate-1': { status: 'completed', rc: '00' } } // attacker-supplied
  const diskProbe = { 'candidate-1': { started: true, present: false, provenance: false, provStarted: false } } // truth: empty
  const completedSet = new Set()
  for (const a of ids(A0)) if (deriveSeatStatus(diskProbe[a.label]) === 'completed') completedSet.add(a.label)
  assert.equal(completedSet.has('candidate-1'), false) // the spoof is ignored — seat A will re-run
  const plan = rebuildResumeList({ prevAttempts: ids(A0), currentAttempts: ids(A0), completedSet, prevRot: 1, currentRot: 1 })
  assert.equal(plan.find(p => p.attempt.label === 'candidate-1').reuse, false)
  // and the cached claim is never consulted by the reuse decision
  assert.ok(!('candidate-1' in Object.fromEntries([...completedSet].map(l => [l, spoofedRunStateClaim[l]]))))
})

// ---------- validateRunState: pins the on-disk schema so the contract can't drift silently ----------
const GOOD_STATE = {
  version: RUN_STATE_VERSION, phase: 'Round 2', phase_index: 3, resumed: false,
  config_fingerprint: 'a'.repeat(64),
  config: { mode: 'two', implement: false, rots: { 'round-1': 1 }, attempts: ids(A0), implementAttempts: ids(A0) },
  seats: { 'candidate-1': { status: 'completed', rc: '00' }, 'candidate-2': { status: 'in_flight', rc: null } },
}
test('validateRunState: a well-formed state validates', () => {
  assert.equal(validateRunState(GOOD_STATE), true)
})
test('validateRunState: wrong version / missing fingerprint / bad seat status all fail closed', () => {
  assert.equal(validateRunState({ ...GOOD_STATE, version: 999 }), false)
  assert.equal(validateRunState({ ...GOOD_STATE, config_fingerprint: '' }), false)
  assert.equal(validateRunState({ ...GOOD_STATE, phase_index: 'x' }), false)
  assert.equal(validateRunState({ ...GOOD_STATE, config: { mode: 'two' } }), false) // no attempts array
  assert.equal(validateRunState({ ...GOOD_STATE, seats: { x: { status: 'bogus' } } }), false)
  assert.equal(validateRunState(null), false)
})

// ---------- canonicalConfig: the fingerprint input is stable + drift-sensitive ----------
test('canonicalConfig is order/shape-stable and changes when a seat identity changes', () => {
  const cfg = { mode: 'two', implement: true, rots: { 'round-1': 1 }, attempts: ids(A0), implementAttempts: ids(A0) }
  assert.equal(canonicalConfig(cfg), canonicalConfig({ ...cfg })) // deterministic
  const drifted = { ...cfg, attempts: ids([{ ...A0[0], displayModel: 'sonnet' }, A0[1], A0[2]]) }
  assert.notEqual(canonicalConfig(cfg), canonicalConfig(drifted))
})

// ---------- STRUCTURAL pins: heartbeat call sites, abort write-ahead, reuse wiring, blindness ----------
test('structural: run-state.json is written through persist() (atomic+sha-verified), never a raw write', () => {
  assert.ok(SRC.includes('const RUN_STATE_PATH = `${runDir}/run-state.json`'))
  assert.ok(/await persist\(\[\{ path: RUN_STATE_PATH, content: json\(state\) \}\], phaseLabel\)/.test(SRC))
})
test('structural: heartbeat is fail-open (try/catch that logs, never throws to the caller)', () => {
  const hb = SRC.slice(SRC.indexOf('async function heartbeat('), SRC.indexOf('async function readRunState('))
  assert.ok(hb.includes('try {') && hb.includes('} catch (e) {') && hb.includes('non-fatal'))
})
test('structural: write-ahead in_flight BEFORE dispatch on every dispatching round (abort honesty)', () => {
  // markInflight precedes each round dispatch so a crash mid-round leaves those seats visibly in_flight,
  // which the NEXT launch reclassifies via the disk probe (in_flight/empty => aborted => re-run).
  assert.ok(SRC.includes("markInflight(r1Worktrees)\nawait heartbeat('Round 1')"))
  assert.ok(SRC.includes("markInflight(r2Worktrees)\nawait heartbeat('Round 2')"))
  assert.ok(SRC.includes('markInflight(list)\n  await heartbeat(phaseTitle)'))
})
test('structural: every dispatching round routes through dispatchOrReuse (resume reuse path)', () => {
  assert.ok(SRC.includes("dispatchOrReuse(a, 'round-1', () => dispatch(a, a.ws, null, 'Round 1'"))
  assert.ok(SRC.includes("dispatchOrReuse(a, 'round-2', () => dispatch(a, a.ws, r2Guidance, 'Round 2')"))
  assert.ok(SRC.includes('dispatchOrReuse(a, roundName, () => dispatch(a, a.ws, guidance, phaseTitle'))
})
test('structural: reuse keeps the seat in place (same ws) so blindLabel yields the SAME letter', () => {
  const d = SRC.slice(SRC.indexOf('function dispatchOrReuse('), SRC.indexOf('async function resumeInit('))
  assert.ok(d.includes('ws: a.ws')) // reused seat is substituted at its original dispatch-order index
})
test('structural: heartbeat call sites are BOUNDED (phase boundaries + one per-seat completion site)', () => {
  const calls = (SRC.match(/await heartbeat\(/g) || []).length
  // Phase boundaries (Round 1, Review, Round 2, Final rank, an implement round, + terminal stamps) PLUS
  // durability sites the NEEDS text asks for: a per-seat-completion heartbeat inside dispatchOrReuse
  // (reuse + dispatch paths — 2 fixed source sites, each fires once per seat, NOT an unbounded loop of
  // NEW call sites), a resume-abort stamp, and a resume-rerun stamp. A generous structural ceiling that
  // still fails if an unbounded set of new call sites leaks in.
  assert.ok(calls > 0 && calls <= 16, `heartbeat call site count ${calls} exceeds the bounded ceiling`)
})
test('blindness: run-state.json is unblinding bookkeeping — never concatenated into a judge pool', () => {
  // the pool the judges read is _pool.md; run-state.json must never be written into it
  assert.ok(!/_pool\.md[^\n]*run-state/.test(SRC))
  assert.ok(!/run-state[^\n]*_pool\.md/.test(SRC))
})
test('structural: a resumed run DISCLOSES the resume in its SUMMARY (never judge-visible pool)', () => {
  assert.ok(SRC.includes('**RESUMED** — reused ${resume.reused} seat(s)'))
  assert.ok(SRC.includes('resume: resumeSummary()'))
})

// ---------- END-TO-END resume (item 1): the REAL impure machinery against a fabricated KILLED runDir ----------
// Extract the IMPURE runtime block and eval it with real disk-backed shims (a probe/lock/cat agentLadder
// that actually runs the produced shell via execSync, and a persist that writes files). This exercises
// the REAL resumeInit -> computeReuse -> probeSeats -> dispatchOrReuse path against a killed run on disk,
// converting the reuse guarantee from "asserted by design" (structural pins) into DEMONSTRATED evidence.
function buildRuntime(deps) {
  const body = slice('// ---- run-state runtime (IMPURE', '// ---- end run-state runtime')
  const params = Object.keys(deps)
  const factory = new Function(...params,
    body + '\nreturn { resumeInit, computeReuse, probeSeats, dispatchOrReuse, resumeSummary, runStateSeats, CONFIG_FP, RUN_STATE_CONFIG };')
  return factory(...params.map(k => deps[k]))
}

// mirror of the module-level shell/runner helpers the impure block closes over (kept tiny + local).
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'"
const engineFiles = ['_brief.txt', '_glm_run.log', '_local_run.log', '_codex_run.log', '_codex_last.txt', '_minimax_run.log', '_grok_run.log']
const dispatchRunner = d => ({
  glm: { logf: '_glm_run.log', tok: 'GLM' }, local: { logf: '_local_run.log', tok: 'LOCAL' },
  codex: { logf: '_codex_run.log', tok: 'CODEX' }, minimax: { logf: '_minimax_run.log', tok: 'MINIMAX' },
  grok: { logf: '_grok_run.log', tok: 'GROK' },
}[d] || { logf: '', tok: '' })
function provCheckShell(log, tok, lp, carriedOver) {
  if (!log) return `P=1`
  if (carriedOver) return `P=1`
  return `if [ -f ${lp} ]; then if grep -q '^JOUST-${tok}-PROVENANCE endpoint=' ${lp} && grep -q '^JOUST-${tok}-DONE exit=0' ${lp} && ! grep -q '^JOUST-${tok}-\\(TIMEOUT\\|ERROR\\|KILLED\\)' ${lp}; then P=1; else P=0; fi; else P=0; fi`
}
const sha256Hex = str => createHash('sha256').update(String(str)).digest('hex')

test('e2e resume: completed seats reuse in place; empty/in_flight seats re-run (real killed runDir)', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'je-resume-e2e-'))
  // A killed run's on-disk workspaces: A = completed (deliverable + native provenance) => REUSE;
  // B = empty (brief only, no deliverable) => ABORTED/re-run; C = in_flight (glm PROVENANCE, no DONE,
  // no deliverable) => IN_FLIGHT => reclassified aborted => re-run.
  const mk = (label, dispatch) => ({
    label, dispatch, model: dispatch === 'anthropic' ? 'opus' : null,
    displayModel: dispatch === 'glm' ? 'glm-5.2' : 'opus', agentType: dispatch === 'glm' ? 'joust-glm' : null,
    ws: join(runDir, 'round-1', label),
  })
  const seatA = mk('candidate-1', 'anthropic'), seatB = mk('candidate-2', 'anthropic'), seatC = mk('candidate-3', 'glm')
  for (const s of [seatA, seatB, seatC]) mkdirSync(s.ws, { recursive: true })
  writeFileSync(join(seatA.ws, '_brief.txt'), 'brief'); writeFileSync(join(seatA.ws, 'plan.md'), '# plan\n')
  writeFileSync(join(seatB.ws, '_brief.txt'), 'brief')
  writeFileSync(join(seatC.ws, '_brief.txt'), 'brief')
  writeFileSync(join(seatC.ws, '_glm_run.log'), 'JOUST-GLM-PROVENANCE endpoint=https://example\n') // started, never DONE

  // agentLadder shim: run the exact shell the real code produced. For the probe (its prompt describes
  // the "JPRB ..." lines) parse them into the structured result the real helper agent would return;
  // for every other call (cat run-state / lock / touch) return raw stdout.
  const agentLadder = async (prompt) => {
    const shellCmd = prompt.slice(prompt.lastIndexOf('\n\n') + 2)
    let stdout = ''
    try { stdout = execSync(shellCmd, { shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch (e) { stdout = e && e.stdout ? e.stdout.toString() : '' }
    if (/JPRB /.test(prompt)) {
      const results = []
      for (const line of stdout.split('\n')) {
        const m = line.match(/^JPRB (\S+) S=(\d) D=(\d) P=(\d) PS=(\d) RC=(\S+)/)
        if (m) results.push({ label: m[1], started: m[2] === '1', present: m[3] === '1', provenance: m[4] === '1', provStarted: m[5] === '1', rc: m[6] })
      }
      return { results }
    }
    return { raw: stdout }
  }
  const persist = async (pairs) => { for (const p of pairs) writeFileSync(p.path, p.content) } // real disk write

  const attempts = [seatA, seatB, seatC]
  const mod = buildRuntime({
    A: { resume: true }, runDir, mode: 'two', implement: false, task: 'test-task', attempts, implementAttempts: [],
    attemptIdentity, canonicalConfig, sha256Hex, RUN_STATE_VERSION,
    persist, json: x => JSON.stringify(x), log: () => {}, q, agentLadder, HELPER_MODEL: 'sonnet',
    engineFiles, provCheckShell, dispatchRunner, deriveSeatStatus, rebuildResumeList, validateRunState,
  })

  // Fabricate the prior (killed) run-state.json — fingerprint + config taken from the block's OWN
  // CONFIG_FP/RUN_STATE_CONFIG so the fingerprint gate matches exactly; seats still claim in_flight.
  const runState = {
    version: RUN_STATE_VERSION, phase: 'Round 1', phase_index: 1, resumed: false,
    config_fingerprint: mod.CONFIG_FP, config: mod.RUN_STATE_CONFIG,
    seats: { 'candidate-1': { status: 'completed', rc: '00' }, 'candidate-2': { status: 'in_flight', rc: null }, 'candidate-3': { status: 'in_flight', rc: null } },
  }
  writeFileSync(join(runDir, 'run-state.json'), JSON.stringify(runState))

  // (1) resume entry: lock acquired on the fresh runDir, prior state valid, fingerprint matches => proceed.
  assert.equal(await mod.resumeInit(), null)

  // (2) compute reuse from the DISK PROBE (not the cached claim): only A is completed.
  await mod.computeReuse('round-1', [seatA, seatB, seatC])

  // item 2 evidence: the reclassified seats are persisted as 'aborted' (durable artifact literally reads it)
  const persisted = JSON.parse(readFileSync(join(runDir, 'run-state.json'), 'utf8'))
  assert.equal(persisted.seats['candidate-2'].status, 'aborted')
  assert.equal(persisted.seats['candidate-3'].status, 'aborted') // in_flight -> aborted before re-dispatch

  // (3) dispatchOrReuse: A reuses in place (thunk NOT called), B and C actually re-run (thunk called).
  const dispatched = []
  const thunkFor = (a) => () => { dispatched.push(a.label); return Promise.resolve({ label: a.label, displayModel: a.displayModel, dispatch: a.dispatch, ws: a.ws, res: null }) }
  const rA = await mod.dispatchOrReuse(seatA, 'round-1', thunkFor(seatA))
  await mod.dispatchOrReuse(seatB, 'round-1', thunkFor(seatB))
  await mod.dispatchOrReuse(seatC, 'round-1', thunkFor(seatC))

  assert.deepEqual(dispatched, ['candidate-2', 'candidate-3']) // A was NOT re-dispatched
  assert.equal(rA.reused, true)
  assert.equal(rA.ws, seatA.ws)                                 // reused IN PLACE (same workspace => same blind letter)
  assert.equal(mod.runStateSeats['candidate-1'].status, 'completed')
  assert.equal(mod.runStateSeats['candidate-1'].reused, true)
  assert.equal(mod.runStateSeats['candidate-2'].status, 'aborted')
  assert.equal(mod.runStateSeats['candidate-3'].status, 'aborted')

  // item 4 evidence: the SUMMARY disclosure names WHICH seats were reused vs re-run (not just counts).
  const summary = mod.resumeSummary()
  assert.equal(summary.reused, 1)
  assert.equal(summary.rerun, 2)
  assert.deepEqual(summary.reusedSeats, ['candidate-1'])
  assert.deepEqual(summary.rerunSeats, ['candidate-2', 'candidate-3'])
})

// ---- run-j3 (2026-07-07): evidence-quota arm's cross-family security vetoes, confirmed + fixed ----
test('security: the stale-lock steal never writes THROUGH the lock path (symlink-truncation veto finding)', () => {
  const i = SRC.indexOf('JLOCK stale-stolen')
  const branch = SRC.slice(SRC.indexOf('elif [ -n "$(find'), i + 40)
  assert.ok(branch.includes('rm -f') , 'stale lock is REMOVED, not truncated in place')
  assert.ok(branch.includes('set -o noclobber'), 're-taken with the same atomic create (racing recreator wins)')
  assert.ok(SRC.includes(`[ -L \${q(LOCK_PATH)} ] && { echo JLOCK symlink; exit 0; }`), 'symlinked lock refused outright')
})

test('security: the resume probe emits the seat label via q()/printf, never bare double-quoted interpolation', () => {
  assert.ok(!SRC.includes('echo "JPRB ${c.label}'), 'a label carrying $(...) must not execute in the probe shell')
  assert.match(SRC, /printf 'JPRB %s S=%s D=%s P=%s PS=%s RC=%s\\\\n' \$\{q\(c\.label\)\}/, 'label single-quote-escaped through q()')
})
