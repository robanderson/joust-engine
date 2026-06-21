// Structural regression tests for Phase 1 repoMode worktree attempts.
//
// node tournament-worktree-mode.test.mjs   (no deps; exits 0 on pass, 1 on fail)
//
// These are pure source/snippet assertions, matching the existing tournament tests:
//   (1) repoMode:false keeps legacy cmdHead/brief/staging snippets byte-identical.
//   (2) repoMode:true brief tells workers to edit the checkout, not propose, and forbids git/tests.
//   (3) repoMode:true staging captures `git diff <base> HEAD` and preserves JEV/provenance fail-closed flow.
//   (4) worktree setup is gated and uses the blind candidate label, never displayModel.
//   (5) Phase 5 enrichment is repoMode-only, fixed-grammar blind, in-section, and timeout-wrapped.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'tournament.mjs'), 'utf8')

let failed = 0
const check = (name, cond) => { if (cond) console.log(`ok   - ${name}`); else { console.error(`FAIL - ${name}`); failed++ } }

function extractFn(src, name) {
  const sig = `function ${name}(`
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`could not find ${sig}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

console.log('== tournament.mjs repoMode worktree phase 1 ==')

const briefSrc = extractFn(SRC, 'brief')
const stageSrc = extractFn(SRC, 'stageAndValidate')
const buildSrc = extractFn(SRC, 'buildWorktrees')
const setupSrc = extractFn(SRC, 'worktreeSetupShell')
const enrichSrc = extractFn(SRC, 'enrichBlindPool')

// (1) Legacy snippets: these exact strings are the current repoMode:false behavior.
check('(legacy) repoMode flag read from args',
  SRC.includes('const repoMode = A.repoMode === true'))
check('(legacy) baseRef read from args',
  SRC.includes('const baseRef = A.baseRef || null'))
check('(legacy) cmdHead is byte-identical',
  SRC.includes("const cmdHead = (ws, b) => `mkdir -p ${q(ws)} && cd ${q(ws)} && printf '%s' ${q(b)} > _brief.txt`"))
check('(legacy) self-contained brief opening unchanged',
  briefSrc.includes('return `You are solving a self-contained task. Produce ONE complete solution in a single focused pass.'))
check('(legacy) self-contained save-dir line unchanged',
  briefSrc.includes('- Save all deliverable files to: ${ws}'))
check('(legacy) file-staging copy snippet unchanged',
  stageSrc.includes('mkdir -p ${q(dest)}; cp -R ${q(c.ws)}/. ${q(dest)}/ 2>/dev/null;'))
check('(legacy) file-staging pool concat snippet unchanged',
  stageSrc.includes('find ${q(dest)} -type f -print0 2>/dev/null | xargs -0 cat 2>/dev/null'))
check('(legacy) round-1 judge call unchanged',
  SRC.includes("const review = await judge('reviewer', blind1, mode === 'two', `${runDir}/review-1/_pool.md`,\n  mode === 'two' ? REVIEW_SCHEMA : RANK_SCHEMA, 'Review', 'review')"))
check('(legacy) final judge call unchanged',
  SRC.includes("const finalRank = await judge('final ranker', blindF, false, `${runDir}/review-final/_pool.md`, RANK_SCHEMA, 'Final rank', 'final-rank')"))

// (2) Repo-anchored worker brief: apply real changes, no proposals, no tests, no git.
check('(brief) repoMode branch exists',
  briefSrc.includes('if (repoMode)'))
check('(brief) says existing git repository checkout',
  briefSrc.includes('You are working INSIDE an existing git repository checked out at: ${ws}'))
check('(brief) says apply directly to real files',
  briefSrc.includes('Apply your change DIRECTLY to the real files'))
check('(brief) forbids proposal deliverable',
  briefSrc.includes('Do NOT write a "proposal"'))
check('(brief) forbids tests',
  briefSrc.includes('Do NOT run the test suite'))
check('(brief) forbids git commands',
  briefSrc.includes('Do NOT run any git command'))
check('(brief) explains harness snapshot',
  briefSrc.includes('The harness snapshots your working tree into a commit for you after you stop.'))
check('(brief) asks for attempt notes',
  briefSrc.includes('JE-ATTEMPT-NOTES.md'))
check('(brief) still includes task text',
  briefSrc.includes('Task:\n${task}'))

// (3) Diff staging: diff-only artifact, same line protocol and provenance contract.
check('(stage) repoMode diff uses git diff base HEAD',
  stageSrc.includes('git -C ${q(c.ws)} diff ${q(baseSha)} HEAD --no-color --no-prefix > ${q(diffPath)}'))
check('(stage) diff artifact is candidate.diff',
  stageSrc.includes('const diffPath = `${dest}/candidate.diff`'))
check('(stage) D is based on non-empty diff',
  stageSrc.includes('if [ -s ${q(diffPath)} ]; then D=1; else D=0; fi'))
check('(stage) JEV line protocol preserved',
  stageSrc.includes('echo "JEV ${c.blind} d=$([ "$D" -gt 0 ] && echo 1 || echo 0) p=$P"'))
check('(stage) provenance builder still used',
  stageSrc.includes('const provChk = provCheckShell(log, tok, lp, !!c.carriedOver)'))
check('(stage) fail-closed validity still requires deliverable and provenance',
  stageSrc.includes('const valid = !!(r && r.deliverable && r.provenance)'))
check('(stage) carried-over winner reuses saved diff',
  stageSrc.includes('cp ${q(`${c.ws}/candidate.diff`)} ${q(diffPath)}'))
check('(stage) blindFail remains present for summaries',
  SRC.includes("const blindFail = r => r ? 'excluded (did not pass validation)' : r"))

// (4) Worktree creation: mode-gated, serial shell, blind labels only.
check('(worktree) buildWorktrees skips when repoMode false',
  buildSrc.includes('if (!repoMode) return'))
check('(worktree) setup uses candidate label in branch',
  setupSrc.includes('const branch = worktreeBranch(roundName, c.label)'))
check('(worktree) setup does not mention displayModel',
  !setupSrc.includes('displayModel'))
check('(worktree) branch namespace is jewt/run/round/label',
  SRC.includes('`jewt/${safeRunId}/${roundName}/${label}`'))
check('(worktree) git worktree add is serial shell, not parallel dispatch',
  setupSrc.includes('git worktree add -b "$branch" "$ws" "$baseSha" --no-checkout'))
check('(worktree) engine logs excluded before worker runs',
  setupSrc.includes('rev-parse --git-path info/exclude') && setupSrc.includes('Joust Engine engine files'))
check('(worktree) harness commit uses fixed identity',
  SRC.includes('GIT_AUTHOR_NAME=joust GIT_AUTHOR_EMAIL=joust@localhost') &&
  SRC.includes('GIT_COMMITTER_NAME=joust GIT_COMMITTER_EMAIL=joust@localhost'))
check('(worktree) base date cached once',
  SRC.includes('dateFile=${q(dateFile)}') && SRC.includes('git show -s --format=%cI "$baseSha"'))

// (5a) repoMode:false: no enrichment agent or pool rewrite is reachable.
check('(enrich) helper is hard-gated when repoMode is false',
  enrichSrc.includes('if (!repoMode || !list.length) return'))
check('(enrich) round-1 call is repoMode-gated and after staging',
  SRC.indexOf("const staged1 = await stageAndValidate") < SRC.indexOf("if (repoMode) await enrichBlindPool(blind1") &&
  SRC.indexOf("if (repoMode) await enrichBlindPool(blind1") < SRC.indexOf("const review = await judge('reviewer'"))
check('(enrich) final call is repoMode-gated and after staging',
  SRC.indexOf("const stagedF = await stageAndValidate") < SRC.indexOf("if (repoMode) await enrichBlindPool(blindF") &&
  SRC.indexOf("if (repoMode) await enrichBlindPool(blindF") < SRC.indexOf("const finalRank = await judge('final ranker'"))

// (5b) live worktree recovery and carryover reuse: never test the stripped review dir twice.
check('(enrich) staging preserves live worktree only in repoMode',
  stageSrc.includes('? { ...c, liveWs: c.ws, ws: `${reviewDir}/${c.blind}`, valid, failReason }') &&
  stageSrc.includes(': { ...c, ws: `${reviewDir}/${c.blind}`, valid, failReason }'))
check('(enrich) checks change into live candidate worktree',
  enrichSrc.includes('const ws = c.liveWs') && enrichSrc.includes('(cd "$ws" && bash "$helper" je_run_with_timeout'))
check('(enrich) carryover reuses strict prior summary',
  enrichSrc.includes('if (c.carriedOver)') && enrichSrc.includes('c.enrichmentSource') &&
  SRC.includes('enrichmentSource: `${champ.ws}/enrichment.txt`'))

// (5c) blindness: fixed grammar only, no identity, command text, logs, paths, or durations in pool.
check('(enrich) summary grammar is anchored and numeric/boolean only',
  SRC.includes("const ENRICHMENT_GRAMMAR = '^automated_checks: enrichment_ok=[01]") &&
  SRC.includes("lint_timeout=[0-9]+$'"))
check('(enrich) no model/provider fields used',
  !enrichSrc.includes('displayModel') && !enrichSrc.includes('dispatch') && !enrichSrc.includes('engineLogPath'))
check('(enrich) raw check output is discarded',
  enrichSrc.includes('>/dev/null 2>&1') && !enrichSrc.includes('cat "$commands"'))
check('(enrich) strict summary is appended inside each candidate section',
  enrichSrc.includes("printf '===== Candidate %s =====\\\\n'") &&
  enrichSrc.includes("printf '\\\\n--- Automated checks ---\\\\n'") &&
  enrichSrc.includes('candidate.diff') && enrichSrc.includes('enrichment.txt'))
check('(enrich) pool replacement is atomic',
  enrichSrc.includes('`${pool}.enriched`') && enrichSrc.includes('mv -f "$tmp" ${q(pool)}'))

// (5d) detector, every detected verify command, and every lint command use the landed timeout helper.
check('(enrich) detect_verify targets candidate worktree and is timeout-wrapped',
  enrichSrc.includes('je_run_with_timeout "$timeout" -- bash "$helper" detect_verify "$ws"'))
check('(enrich) verify commands are argv-split, never evaled, and timeout-wrapped through the sandbox chokepoint',
  enrichSrc.includes('read -r -a words <<< "$cmd"') &&
  enrichSrc.includes('je_run_with_timeout "$timeout" -- bash "$helper" je_verify_exec "\\${words[@]}"') &&
  !enrichSrc.includes('eval '))
check('(enrich) candidate code routes through je_verify_exec (sandbox policy), never executed directly',
  !enrichSrc.includes('je_run_with_timeout "$timeout" -- "\\${words[@]}"'))
check('(enrich) lint commands share the same sandbox-routed, timeout-wrapped execution site',
  (enrichSrc.match(/je_run_with_timeout \"\$timeout\" -- bash \"\$helper\" je_verify_exec \"\\\$\{words\[@\]\}\"/g) || []).length === 2)
check('(enrich) timeout is the canonical verify timeout default',
  enrichSrc.includes('timeout=\\${JE_VERIFY_CMD_TIMEOUT:-600}'))

// (6) issue #44: repoMode worktree CHECKOUTS live OUTSIDE ~/.claude/ so runner sub-agents can edit freely;
//     only the checkout moves; repoMode:false stays byte-identical under runDir.
console.log('== issue #44: repoMode worktrees outside ~/.claude/ ==')
check('(worktree-root) worktreeRoot is configurable with a /tmp default, never under .claude/',
  SRC.includes('const worktreeRoot = repoMode ? (A.worktreeRoot || `/tmp/je-worktrees/${safeRunId}`) : null'))
check('(worktree-root) default worktreeRoot does not resolve under .claude/',
  (() => { const m = SRC.match(/A\.worktreeRoot \|\| `([^`]+)`/); return !!m && !m[1].includes('.claude') })())
check('(worktree-root) worktreePath is rooted at worktreeRoot and repoMode-gated',
  SRC.includes('const worktreePath = (roundName, label) => repoMode ? `${worktreeRoot}/${roundName}/${label}` : null'))
check('(worktree-root) round-1 attempt ws uses worktreePath in repoMode',
  SRC.includes("ws: repoMode ? worktreePath('round-1', a.label) : `${runDir}/round-1/${a.label}`"))
check('(worktree-root) round-2 attempt ws uses worktreePath in repoMode',
  SRC.includes("ws: repoMode ? worktreePath('round-2', a.label) : `${runDir}/round-2/${a.label}`"))
check('(worktree-root) repoMode:false keeps legacy round-1 ws literal under runDir',
  SRC.includes('`${runDir}/round-1/${a.label}`'))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
