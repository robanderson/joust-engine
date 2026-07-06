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

test('every verbatim-run dispatch prompt mandates ONE FOREGROUND Bash call (attempt + codex judge)', () => {
  const n = (SRC.match(/ONE FOREGROUND Bash call/g) || []).length
  assert.ok(n >= 2, `expected the foreground mandate on >=2 dispatch prompts, saw ${n}`)
  const bg = (SRC.match(/NEVER as a background task/g) || []).length
  assert.ok(bg >= 2, `expected the background prohibition on >=2 dispatch prompts, saw ${bg}`)
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
