// RUN-REPO RESULTS BUS (tracker #21, phase 2) — structural pins over the tournament.mjs source
// (tournament-persist-phase2.test.mjs style). The bus is STRICTLY OPTIONAL (args.runRepoBase absent => byte-inert) and STRICTLY
// fail-open (a push failure logs JE-RUNREPO-FAIL and never fails the run). Pins: the optionality
// gate, the fail-open shell guard, NO hardcoded hostname anywhere in committed files, the neutral
// per-attempt push hook at the dispatch chokepoint, the post-terminal-persist-only publish
// (unmasking sequencing rule), and bin/je-run-repo.sh's contract surface.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')
const SCRIPT_PATH = resolve(HERE, '../bin/je-run-repo.sh')

const start = SRC.indexOf('// ---- begin: run-repo results bus')
const end = SRC.indexOf('// ---- end: run-repo results bus')
assert.ok(start > 0 && end > start, 'run-repo bus block exists with begin/end markers')
const BLOCK = SRC.slice(start, end)

// ----- 1. Optional + fail-open ------------------------------------------------------------------
test('the bus is OPTIONAL: gated on args.runRepoBase AND the runner-derived PLUGIN_BIN; absent => inert', () => {
  assert.ok(BLOCK.includes(`return typeof A.runRepoBase === 'string' ? A.runRepoBase.trim() : ''`))
  assert.ok(BLOCK.includes('return !!(runRepoBaseArg() && runRepoScriptPath())'))
  // every op helper early-returns when disabled, so absent args are byte-inert
  for (const fn of ['runRepoRun', 'runRepoInit', 'runRepoAttemptPush', 'runRepoPublish']) {
    const i = BLOCK.indexOf(`function ${fn}(`)
    assert.ok(i > 0, `${fn} exists`)
    assert.ok(BLOCK.slice(i, i + 400).includes('if (!runRepoEnabled()'), `${fn} early-returns when the bus is off`)
  }
  // the block is LAZY (function declarations + one plain array): structural tests extract-and-eval
  // slices spanning this region, so no top-level statement may dereference outside identifiers.
  const topLevel = BLOCK.split('\n').filter(l => /^const /.test(l))
  assert.deepEqual(topLevel.map(l => l.split(' ')[1]), ['runRepoPending'], 'the only top-level const is the inert pending array')
})

test('every shell op is fail-open (`|| echo JE-RUNREPO-FAIL`) and a failure only LOGS — it never fails the run', () => {
  assert.ok(BLOCK.includes('|| echo "JE-RUNREPO-FAIL ${op}"'), 'the shell guard rides on every op via runRepoShell')
  assert.ok(BLOCK.includes(`raw.includes('JE-RUNREPO-FAIL')`), 'the engine detects the marker in the relayed stdout')
  assert.match(BLOCK, /JE-RUNREPO-FAIL \$\{opLabel\}.*continuing.*source of truth/,
    'loud log names the op and reasserts local .runs as the source of truth')
  assert.ok(BLOCK.includes('.catch(() => null)'), 'agent dispatch failures are swallowed after logging (fire-and-forget discipline)')
  assert.ok(!BLOCK.includes('throw '), 'no run-repo path can throw into the run')
})

// ----- 2. No hardcoded hostname (public repo!) --------------------------------------------------
// The operator-hostname token is assembled at runtime (the #25 "Z"+"AI" hygiene pattern) so this
// test file itself never carries the literal it hunts for.
const HOST_TOKEN = new RegExp('1' + 'hut', 'i')
test('NO LAN/operator hostname literal ships in any committed path (engine, script, docs)', () => {
  const files = [
    resolve(HERE, 'tournament.mjs'),
    SCRIPT_PATH,
    resolve(HERE, '../bin/je-run-repo.test.sh'),
    resolve(HERE, '../skills/joust-engine/SKILL.md'),
    resolve(HERE, '../skills/joust-engine/references/orchestration.md'),
  ]
  for (const f of files) {
    const t = readFileSync(f, 'utf8')
    assert.ok(!HOST_TOKEN.test(t), `${f} carries no operator hostname`)
    assert.ok(!/192\.168\.|(^|[^0-9])10\.0\.0\./.test(t), `${f} carries no LAN IP literal`)
  }
  assert.ok(BLOCK.includes('<your-git-host>'), 'the engine documents the base with a GENERIC placeholder only')
})

// ----- 3. Per-attempt push hook at the dispatch chokepoint --------------------------------------
test('per-attempt pushes fire from the ONE dispatch resolution chokepoint, fire-and-forget, never awaited on the round path', () => {
  const i = SRC.indexOf('function dispatch(a, ws, guidance')
  const j = SRC.indexOf('function pinnedScopeBlock(')
  const body = SRC.slice(i, j)
  assert.ok(body.includes(`runRepoAttemptPush(a.label, a.dispatch || 'anthropic', ws, phaseTitle)`),
    'the hook lives in dispatch().then — the seat finish path every attempt family shares')
  assert.ok(!body.includes('await runRepoAttemptPush'), 'never awaited on the critical path')
  assert.ok(BLOCK.includes('runRepoPending.push('), 'pending pushes are collected...')
  assert.ok(BLOCK.includes('await Promise.allSettled(runRepoPending)'), '...and settled before the final publish')
})

test('worker pushes ride bin/je-run-repo.sh push_results (+ push_log only for runner families) and skip repoMode', () => {
  assert.ok(BLOCK.includes(`runRepoShell('push_results', [label, ws])`))
  assert.ok(BLOCK.includes(`runRepoShell('push_log', [label, \`\${ws}/\${logf}\`])`))
  assert.ok(BLOCK.includes('const { logf } = dispatchRunner(dispatchKind)'), 'log push keyed off the shared dispatch->log mapping (native seats have none)')
  assert.match(BLOCK, /if \(!runRepoEnabled\(\) \|\| repoMode\) return/, 'repoMode attempts are excluded (their deliverable is already a real-repo branch)')
})

// ----- 4. Unmasking sequencing: publish is post-terminal-persist ONLY ---------------------------
test('publish fires ONLY after a terminal persist — never mid-run (the unmasking sequencing rule)', () => {
  assert.match(BLOCK, /publish: POST-RUN ONLY/, 'the rule is documented at the helper')
  const sites = SRC.split('\n').filter(l => l.includes('await runRepoPublish('))
  assert.ok(sites.length >= 5, `publish is wired at the terminal exits (found ${sites.length})`)
  // an implement run is still mid-run at the plan final rank: publish there must be !implement-gated
  assert.ok(SRC.includes(`if (!implement) await runRepoPublish('Final rank')`),
    'the plan-final-rank publish is gated so an implement run defers unmasking to its own terminal')
  // init precedes Round 1 dispatch; publish never appears before the Review persist block
  assert.ok(SRC.indexOf('await runRepoInit()') < SRC.indexOf(`phase('Review')`), 'init runs before Round 1 completes')
})

// ----- 5. bin/je-run-repo.sh contract surface ---------------------------------------------------
test('bin/je-run-repo.sh exists with the init/push_results/push_log/publish contract, neutral identity, distinct exits', () => {
  assert.ok(existsSync(SCRIPT_PATH), 'bin/je-run-repo.sh is bundled')
  const R = readFileSync(SCRIPT_PATH, 'utf8')
  for (const c of ['cmd_init', 'cmd_push_results', 'cmd_push_log', 'cmd_publish']) assert.ok(R.includes(c), `${c} present`)
  assert.ok(R.includes('JE_RUN_REMOTE_BASE'), 'remote base comes ONLY from env/arg')
  assert.ok(R.includes('RC_DISABLED=7'), 'distinct "run-repo disabled" exit for the absent-env feature-off path')
  assert.ok(R.includes('worker@je'), 'neutral worker identity')
  assert.match(R, /worker_ident\(\)|worker-\$1/, 'per-label worker-<label> identity')
  assert.match(R, /push_with_retry/, 'the validated push||pull-rebase retry loop')
  assert.match(R, /\[ "\$i" -ge 5 \]/, 'retry loop bounded at 5 attempts')
  assert.ok(R.includes(`-name '_*'`), 'underscore-prefixed engine artifacts are excluded from worker pushes')
  assert.ok(R.includes('UNMASKING SEQUENCING RULE'), 'the post-run-only publish rule is documented in the header')
  assert.ok(!HOST_TOKEN.test(R), 'no hostname literal in the script')
})
