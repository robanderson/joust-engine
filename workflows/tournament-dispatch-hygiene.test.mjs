// Dispatch + workspace hygiene guards (run-h codex-implementer post-mortem, 2026-07-06).
// Run H's "3/6 codex implementers failed staging" cluster decomposed into three distinct defects,
// none of them codex code quality; each gets a structural regression guard here:
//   impl-4 (RC 08): the dispatch wrapper ran the runner as a BACKGROUND task, then idled — the
//     harness TERM-kills a backgrounded command when the agent's turn ends. Guard: every verbatim-run
//     dispatch prompt mandates ONE FOREGROUND Bash call and forbids backgrounding.
//   impl-5 (RC 01): codex exec goes legitimately quiet while composing one large patch; the 120s
//     default stall window killed it twice mid-write. Guard: codex-run.sh default stall is 300s.
//   impl-6 (RC 06): the worker deleted _brief.txt + _codex_run.log while tidying its deliverables,
//     destroying the up-front PROVENANCE stamp -> an honest, self-verified patch was rejected
//     fail-closed. Guards: finish() restamps a missing provenance line from PROV_LINE (behavioural
//     test in bin/codex-run.test.sh FAKE_MODE=clobber); every runner sets PROV_LINE; the attempt
//     brief forbids deleting workspace scratch files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(resolve(HERE, p), 'utf8')
const SRC = read('tournament.mjs')

// LAUNCH-AND-POLL protocol (run-i glm post-mortem superseding the plain foreground mandate): a
// foreground wrapper call is CAPPED (~600s) below the runner wall-clocks (glm 1200s) — the FE run's
// glm seat was TERM-killed at ~10m mid-retry (RC 08). The runner detaches into its own session and
// self-supervises; the wrapper polls the log for the guaranteed terminal line.
test('runner dispatch DETACHES via perl setsid and returns a JOUST-LAUNCHED sentinel', () => {
  assert.ok(SRC.includes("POSIX::setsid(); exec @ARGV"), 'launcher must new-session the runner (macOS has no setsid binary)')
  assert.ok(SRC.includes('echo JOUST-LAUNCHED'), 'launcher must confirm the detach')
  assert.ok(SRC.includes('const detachLaunch ='), 'the launcher helper must exist')
  const launches = (SRC.match(/\$\{detachLaunch\(/g) || []).length
  assert.equal(launches, 2, `detachLaunch must be interpolated by BOTH runnerCmd and codexRunnerCmd, saw ${launches}`)
})

test('both verbatim-run prompts mandate the poll loop on the guaranteed ^JOUST-RC line', () => {
  assert.ok(SRC.includes("grep -q '^JOUST-RC '"), 'poll watches the line-anchored terminal RC contract')
  assert.ok(SRC.includes('echo JOUST-SETTLED'), 'poll prints a settle sentinel')
  const again = (SRC.match(/RUN THE SAME COMMAND AGAIN/g) || []).length
  assert.ok(again >= 2, `both prompts must tell the wrapper to re-issue a timed-out poll, saw ${again}`)
  const stay = (SRC.match(/NEVER end your turn/g) || []).length
  assert.ok(stay >= 2, `both prompts must forbid ending the turn mid-run (the run-h impl-4 kill), saw ${stay}`)
  const bg = (SRC.match(/never as a background task/g) || []).length
  assert.ok(bg >= 2, `both prompts must keep the background prohibition on the poll call, saw ${bg}`)
})

test('attempt brief forbids deleting workspace scratch files (provenance record)', () => {
  assert.match(SRC, /NEVER delete or rewrite the workspace scratch files/)
})

test('codex-run.sh default stall window is 300s (codex composes large patches silently)', () => {
  assert.match(read('../bin/codex-run.sh'), /JE_STALL_SECS:-300/)
})

test('finish() restamps a worker-clobbered provenance line from PROV_LINE', () => {
  const lib = read('../bin/_je-run-lib.sh')
  assert.match(lib, /PROV_LINE/, 'lib must read PROV_LINE')
  assert.match(lib, /restamped=finish/, 'restamped copy must be distinguishable from the original')
  const i = lib.indexOf('PROV_LINE')
  const j = lib.indexOf("printf 'JOUST-%s-%s")
  assert.ok(i >= 0 && j > i, 'restamp must happen BEFORE the terminal marker is written')
})

test('all five runners set PROV_LINE (restamp opt-in is universal)', () => {
  for (const r of ['codex', 'glm', 'minimax', 'local', 'grok']) {
    const s = read(`../bin/${r}-run.sh`)
    assert.match(s, /^PROV_LINE="JOUST-[A-Z]+-PROVENANCE /m, `${r}-run.sh must set PROV_LINE`)
    assert.match(s, /^echo "\$PROV_LINE" >> "\$LOG"$/m, `${r}-run.sh must stamp via PROV_LINE`)
  }
})
