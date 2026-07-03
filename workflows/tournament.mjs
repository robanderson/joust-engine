export const meta = {
  name: 'Joust Engine',
  description: 'Plan/Implement tournament: a wide, cheap PLAN phase (Plan Round 1 + Plan Round 2, plan-lens Opus council: feasibility/completeness/risk/security-by-design/simplicity) always runs; the optional IMPLEMENT phase (Implement Round 3, plus Round 4 only if R3 yields no gate-passing candidate) seeds implementers with the winning plan verbatim and judges with the 5-lens code council (majority vote + security veto, code-tallied).',
  phases: [
    // Plan phase (always). The internal phase titles stay 'Round 1'/'Review'/'Round 2'/'Final
    // rank' for continuity with the engine's staging/worktree bookkeeping; they ARE the plan
    // rounds — see the flow at the bottom of this file.
    { title: 'Round 1' },
    { title: 'Review' },
    { title: 'Round 2' },
    { title: 'Final rank' },
    // Implement phase (only when args.implement). Round 4 is reached only if Round 3 produced
    // no gate-passing candidate.
    { title: 'Implement Round 3' },
    { title: 'Implement Review' },
    { title: 'Implement Round 4' },
    { title: 'Implement Final rank' },
  ],
}

// args = {
//   task: string,
//   mode: 'single' | 'two',
//   runDir: string,                       // absolute base dir for workspaces
//   glmRunner / localRunner / codexRunner / minimaxRunner / grokRunner: string,  // bundled runner-script paths (per provider used)
//   codexTimeoutSecs: number,             // optional wall-clock backstop for codex (default 600)
//   grokTimeoutSecs: number,              // optional wall-clock backstop for grok (default 600); grok ALSO honours grokMaxTurns
//   grokWebSearch: boolean,               // optional — true enables grok's web search (default false = hermetic, like the other providers)
//   attempts: [ {                         // one per attempt, length N
//      label: 'candidate-1',
//      dispatch: 'anthropic' | 'glm' | 'local' | 'codex' | 'minimax' | 'grok',
//      model: 'haiku'|'sonnet'|'opus',    // when dispatch=anthropic (or the exact local/codex model id)
//      agentType: 'joust-glm-5-2',   // when dispatch=glm/local/codex/minimax/grok (the worker agent)
//      displayModel: 'glm-5.2',           // for the report (kept private from judges); codex: 'codex-high'; grok: 'grok-build'
//      r1nudge: string,
//      r2nudge: string,
//   } ]
// }
// args may arrive as a real object or as a JSON-encoded string depending on the caller; normalise.
const A = (typeof args === 'string') ? JSON.parse(args) : (args || {})
const { task, runDir, attempts } = A
if (!Array.isArray(attempts) || attempts.length === 0) {
  return { error: 'no attempts provided', argsType: typeof args, keys: Object.keys(A || {}) }
}
// ---- Plan/Implement round split (2026-07-03) ----------------------------------------------
// `attempts` seat the PLAN phase (Plan Round 1 + Plan Round 2). `implement` (default off) gates
// the IMPLEMENT phase (Implement Round 3, + Round 4 only if R3 yields no gate-passing candidate).
// `implementAttempts` seat the implement rounds (a small strong pool); default to the plan pool.
// The plan phase ALWAYS runs the two-pass spine (Round 2 always) when we will implement, so the
// winning plan is refined before any expensive implementation spend — hence mode is forced to
// 'two' under `implement`. A plan-only run keeps its @@JE:N:M single/two semantics unchanged.
const implement = A.implement === true
const implementAttempts = (Array.isArray(A.implementAttempts) && A.implementAttempts.length) ? A.implementAttempts : attempts
const mode = implement ? 'two' : A.mode
const LABELS = 'ABCDEFGHIJKLMNOP'.split('')

// Judge council (issue #22). The default judge at BOTH decision points (Phase 3 review, Phase 5 final
// rank) is a 5-lens DELIBERATING Opus council: 5 blind judges vote independently, tally is deterministic
// CODE (never an LLM), a >50% majority on a non-vetoed candidate wins, the security lens can VETO with
// evidence, and an unresolved split routes to NO_CONSENSUS (surface interactively / needs-human+HALT in a
// grand loop). `judges: 1` is the LEGACY escape hatch — the single blind Opus judge, byte-for-byte today.
// Council size is fixed at 5 (not user-tunable): any judges value other than 1 selects the council.
const COUNCIL = Number(A.judges) !== 1

// Run-purpose summary for the live /workflows heading (issue #38). meta.name/description is a static
// PURE LITERAL (Workflow spec — it CANNOT be dynamic per-run), so the only runtime lever into the live
// display is an early log() narrator line rendered above the progress tree. args.title (alias args.purpose)
// wins verbatim when present; otherwise derive a sanitized one-line summary of args.task. Sanitization
// strips @@JE-style sigils and embedded newlines and collapses whitespace, then truncates to ~80 chars.
const SUMMARY_MAX = 80
function deriveSummary() {
  const explicit = A.title != null ? A.title : A.purpose
  if (explicit != null && String(explicit).trim()) return String(explicit).trim()
  const cleaned = String(task || '')
    .replace(/@@JE(:\d+){0,3}/g, '') // strip @@JE sigils (e.g. @@JE, @@JE:5, @@JE:5:2:1)
    .replace(/[\r\n]+/g, ' ')        // flatten to one line
    .replace(/\s+/g, ' ')            // collapse runs of whitespace
    .trim()
  if (!cleaned) return '(untitled run)'
  return cleaned.length > SUMMARY_MAX
    ? cleaned.slice(0, SUMMARY_MAX - 1).trimEnd() + '…'
    : cleaned
}

// Render one fallible-prior guidance item as a tagged bullet. Shared by brief() (the round-2 brief) and
// guidanceToMd() (the saved guidance.md). Back-compat: an old/in-flight guidance object may still hold bare
// strings — treat a string as a tentative, evidence-less item so the live system never crashes on cached data.
function priorLine(item) {
  if (typeof item === 'string') return `- [tentative] ${item}`
  const tag = item.conf === 'strong' ? 'strong' : 'tentative'
  const why = item.why ? ` (${item.why})` : ''
  return `- [${tag}] ${item.text}${why}`
}

// brief() frames one attempt. `kind` selects the phase framing:
//   'plan'      — Plan Round 1/2: produce a PLAN artifact (a concrete, file-level change
//                 proposal). Plans NEVER touch the repo, so this is always the scratch path.
//   'implement' — Implement Round 3/4: apply the change. `seedPlanPath` (when set) seeds the
//                 attempt with the WINNING PLAN verbatim — the deliberate exception to the
//                 "never seed prior artifacts" rule (the plan IS the spec).
function brief(nudge, ws, guidance, ctx, kind = 'implement', seedPlanPath = null) {
  let g = ''
  if (guidance) {
    // Render-side cap (the REAL enforcer; schema maxItems is only advisory for the structured-output judge).
    const pos = (guidance.positives || []).slice(0, GUIDANCE_CAP).map(priorLine).join('\n')
    const ch = (guidance.challenges || []).slice(0, GUIDANCE_CAP).map(priorLine).join('\n')
    g = `\nThe following are FALLIBLE PRIORS distilled from a single, noisy review of one earlier round — hypotheses to weigh, NOT instructions to obey. Each is tagged [strong] (the reviewer saw it hold up repeatedly) or [tentative] (a weaker, single-sighting or speculative signal). Let no single item override your own judgment: if your approach has a good reason to differ — especially from a [tentative] one — follow your reason and note why. Solve the task your own way; use these only to steer away from real pitfalls and toward ideas worth considering.\n\nPatterns that seemed to work (consider, don't copy):\n${pos}\n\nPitfalls that hurt attempts (avoid, unless you have a concrete reason they don't apply here):\n${ch}\n`
  }
  const ctxLine = ctx
    ? `\nShared context for this task has ALREADY been gathered for you in one file: ${ctx}\nRead that single file at the start — it contains the source material you need. Do NOT re-read the underlying source files one by one (that work is already done).\n`
    : ''

  // ---- PLAN phase (Plan Round 1/2): produce a PLAN artifact, never touch the repo. ----
  if (kind === 'plan') {
    return `You are producing a PLAN — a concrete, file-level change proposal for a task. You do NOT implement anything and you do NOT touch any real repository.

Task to plan:
${task}
${g}${ctxLine}
${nudge}

Write ONE plan file, PLAN.md, in your workspace. A strong plan is:
- CONCRETE and FILE-LEVEL: name each file to add / edit / delete, and say exactly what changes in each (functions, signatures, data shapes, config), enough that an implementer could execute it without guessing.
- COMPLETE: cover every requirement, edge case, migration, test, and doc update the task implies — do not hand-wave the hard parts.
- FEASIBLE: reference only real, reachable files/APIs/mechanisms; each step must follow from the last.
- RISK-AWARE and SECURE-BY-DESIGN: name the execution risks (breaking changes, coupling, data/compat, ordering) and the security posture (least privilege, input validation, safe secrets/supply-chain), and how the plan mitigates them.
- PROPORTIONATE: the smallest coherent change that fully solves the task — no gold-plating.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your plan.
- Produce the PLAN ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything. A plan, not a patch.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations.`
  }

  // ---- IMPLEMENT phase (Implement Round 3/4): the winning plan IS the spec. ----
  const seedBlock = seedPlanPath
    ? `\nAn APPROVED PLAN for this task has already been chosen by a review council. It is your specification — follow it. Read it in full at the start:\n${seedPlanPath}\nImplement THAT plan. Where the plan is concrete, follow it verbatim; where it leaves a small detail open, make the smallest reasonable choice consistent with it. Do NOT re-plan or second-guess the overall approach.\n`
    : ''

  if (repoMode) {
    return `You are working INSIDE an existing git repository checked out at: ${ws}
This is your own isolated branch off a pinned base commit. Apply your change DIRECTLY to the real files (edit/create/delete as needed) to accomplish the task. Do NOT write a "proposal" or a description of a change — make the change itself.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

Rules:
- This task is fully specified. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Single pass: make your change once, then STOP. Do NOT run the test suite, do NOT iterate to green.
  (A separate automated step tests every candidate after you finish — testing yourself only wastes your turn budget. Weak/local models that loop on "run tests, fix, repeat" time out; do not.)
- Do NOT run any git command. Do NOT commit, branch, stage, push, or touch .git. Just edit files.
  The harness snapshots your working tree into a commit for you after you stop.
- Do NOT write a proposal or patch plan. Apply the requested change directly to files in this checkout.
- Leave a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations, in JE-ATTEMPT-NOTES.md at the repo root.
- Work only in this checkout: ${ws}
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.`
  }
  return `You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution file ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite, re-align, "improve", or polish it. Your first version is final — even if it is imperfect or not to your taste. Perfecting it is explicitly NOT wanted here and only wastes effort.
- Your text reply is discarded; ONLY the file(s) you save are kept. You MUST save your solution to a file (an empty workspace is a total failure) — but it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}
- Work only in that directory. Create it if needed.
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations (an honest note about what is rough or unfinished is useful, not a mark against you).`
}

// GLM display model -> the `claude` --model flag that selects it on the z.ai endpoint.
const GLM_FLAG = {
  'glm-5.2': '--model opus',
  'glm-5.1': '--model glm-5.1',
  'glm-4.7': '--model sonnet',
  'glm-4.5-air': '--model haiku',
}
// Codex display model -> the `codex exec` flags selecting it. Codex is pinned to gpt-5.5 (the only
// model the local ChatGPT-account auth serves; other ids need an OPENAI_API_KEY). The selectable axis
// is the REASONING EFFORT — codex's real quality lever — set via the model_reasoning_effort config
// override. Verified-accepted tokens on gpt-5.5: low|medium|high|xhigh ("xhigh" == the UI's "Extra
// high"; "minimal" is rejected). The runner pins -m so it never falls back to config.toml's default.
const CODEX_FLAG = {
  'codex-low': '-m gpt-5.5 -c model_reasoning_effort=low',
  'codex-medium': '-m gpt-5.5 -c model_reasoning_effort=medium',
  'codex-high': '-m gpt-5.5 -c model_reasoning_effort=high',
  'codex-xhigh': '-m gpt-5.5 -c model_reasoning_effort=xhigh',
}
// Grok display model -> the `grok` -m flag that selects it. The two operator-requested variants are a
// MODEL axis (analogous to codex's reasoning-effort axis): grok-build is xAI's agentic-coding model
// (grok-code-fast-1 lineage); grok-composer-2.5-fast is Cursor Composer 2.5 (Kimi K2.5 lineage), the
// CLI default. The runner pins -m so grok never falls back to config.toml's default model silently.
const GROK_FLAG = {
  'grok-build': '-m grok-build',
  'grok-composer-2.5-fast': '-m grok-composer-2.5-fast',
}
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'" // single-quote shell-escape

// Runner paths for the non-Anthropic providers (passed in via args). Each provider's
// real (nested-Claude) call lives in a bundled script, so the wrapper agent only ever
// sees a benign `bash <runner> <flag>` command — nothing to refuse, shortcut, or
// self-substitute. All providers require their runner script; GLM has no inline fallback.
const glmRunner = A.glmRunner
const localRunner = A.localRunner
const codexRunner = A.codexRunner
const minimaxRunner = A.minimaxRunner
const grokRunner = A.grokRunner
// Per-attempt guards for GLM/local runners (enforced inside the runner scripts):
//  - max-turns: PRIMARY guard — caps agentic iterations so single-pass attempts can't
//    grind the write->run->fix loop (which balloons context, esp. on local models).
//  - timeout: wall-clock backstop for a single hung/slow turn.
// GLM gets a roomier cap; local models run a tighter cap because they tend to ignore
// "single pass" and burn turns on a verify-and-polish loop (observed on Qwen).
const glmMaxTurns = Number(A.attemptMaxTurns) > 0 ? Math.floor(Number(A.attemptMaxTurns)) : 30
const localMaxTurns = Number(A.localMaxTurns) > 0 ? Math.floor(Number(A.localMaxTurns)) : 20
// MiniMax exposes one model (MiniMax-M3); its runner reuses the GLM-style guards (default to glmMaxTurns).
const minimaxMaxTurns = Number(A.minimaxMaxTurns) > 0 ? Math.floor(Number(A.minimaxMaxTurns)) : glmMaxTurns
const attemptTimeout = Number(A.attemptTimeoutSecs) > 0 ? Math.floor(Number(A.attemptTimeoutSecs)) : 300
// GLM via z.ai is slow on heavy multi-file builds — give it its OWN wall-clock (usually larger),
// independent of local/minimax, so one long GLM leg doesn't force everyone's timeout up. For code-build
// tournaments pass glmTimeoutSecs ~1800-2400. Defaults to attemptTimeout when unset (backward-compatible).
const glmTimeoutSecs = Number(A.glmTimeoutSecs) > 0 ? Math.floor(Number(A.glmTimeoutSecs)) : attemptTimeout
// MiniMax-M3 is slow on real code tasks — both M3 seats blew the shared 300s wall-clock on a medium run
// (issue #30), so it gets its OWN wall-clock like GLM/codex. Defaults to attemptTimeout when unset.
const minimaxTimeoutSecs = Number(A.minimaxTimeoutSecs) > 0 ? Math.floor(Number(A.minimaxTimeoutSecs)) : attemptTimeout
// Codex exec is agentic with NO turn cap (no --max-turns flag), so the wall-clock timeout is its ONLY
// per-attempt backstop and gets its own, roomier default. Override via args.codexTimeoutSecs.
const codexTimeout = Number(A.codexTimeoutSecs) > 0 ? Math.floor(Number(A.codexTimeoutSecs)) : 600
// Grok is a full autonomous coding agent (like codex it gets a roomier wall-clock default), but UNLIKE
// codex it ALSO has --max-turns, so it uses BOTH per-attempt guards via the standard runnerCmd:
// grokMaxTurns (default = glm's 30) as the primary iteration cap + grokTimeout as the wall-clock backstop.
const grokMaxTurns = Number(A.grokMaxTurns) > 0 ? Math.floor(Number(A.grokMaxTurns)) : glmMaxTurns
const grokTimeout = Number(A.grokTimeoutSecs) > 0 ? Math.floor(Number(A.grokTimeoutSecs)) : 600
const cmdHead = (ws, b) => `mkdir -p ${q(ws)} && cd ${q(ws)} && printf '%s' ${q(b)} > _brief.txt`
// envExtra (optional): extra `KEY=VAL ` env assignments prepended to the runner call (e.g. grok's JE_GROK_WEB=1).
const runnerCmd = (runner, flag, ws, b, maxTurns, timeout = attemptTimeout, envExtra = '') => `${cmdHead(ws, b)} && ${envExtra}JE_MAX_TURNS=${maxTurns} JE_TIMEOUT_SECS=${timeout} bash ${q(runner)} ${flag}`
// Codex reuses cmdHead + the runner but overrides the wall-clock with codexTimeout (no JE_MAX_TURNS:
// codex has no turn cap, and codex-run.sh ignores it).
const codexRunnerCmd = (runner, flag, ws, b) => `${cmdHead(ws, b)} && JE_TIMEOUT_SECS=${codexTimeout} bash ${q(runner)} ${flag}`

// Optional shared CONTEXT BUNDLE for known-input tasks (args.contextFiles = [paths/globs]).
// Concatenate those files ONCE into a single file that every worker reads by path — instead of
// each attempt re-reading the same source files (which dominated tool-use/latency in practice).
// The bundle lives OUTSIDE any candidate workspace (in ${runDir}/_context/), and staging only ever
// copies a candidate's own workspace into its review dir, so the bundle is never exposed to the blind
// judge. No bundle is built when contextFiles is empty.
const contextFiles = Array.isArray(A.contextFiles) ? A.contextFiles.filter(Boolean) : []
const contextPath = contextFiles.length ? `${runDir}/_context/_context.md` : null
// repoMode (Phase 1, worktree-per-attempt): gated OFF by default so the scratch-directory path is
// byte-for-byte the existing behavior. Only when args.repoMode === true do workers edit real files in
// a per-attempt git worktree off args.baseRef (a pinned sha) and the harness snapshot+diff the tree.
const repoMode = A.repoMode === true
const baseRef = A.baseRef || null
const baseSha = baseRef
const safeRunId = String(runDir || 'run').split('/').filter(Boolean).pop().replace(/[^A-Za-z0-9._-]/g, '-') || 'run'
// Build the shell command that concatenates the context files into one bundle.
// SECURITY (issue #22): a context-file path is shell DATA, so EVERY place it reaches the shell must
// pass through q() (single-quote escape). The label is emitted with `printf '%s'` taking q(f) as an
// ARGUMENT — never interpolated into a double-quoted `echo "===== ${f} ====="`, where $()/backticks/
// ${} in a path would execute (and a bare $VAR would silently mangle the label). printf treats `%`
// only in the FORMAT string, so a `%` in the path is harmless data.
// SECURITY (issue #23): read a path only if it is a regular file AND not a symlink
// (`[ ! -L ] && [ -f ]`), so a planted symlink/special file can't be dereferenced into the bundle.
function contextCatCmd(files) {
  return files.map(f => `printf '===== %s =====\\n' ${q(f)}; if [ ! -L ${q(f)} ] && [ -f ${q(f)} ]; then cat ${q(f)} 2>/dev/null || printf '(unreadable: %s)\\n' ${q(f)}; else printf '(skipped non-regular: %s)\\n' ${q(f)}; fi; echo`).join('; ')
}
async function buildContext() {
  if (!contextPath) return
  const cat = contextCatCmd(contextFiles)
  const cmd = `mkdir -p ${q(`${runDir}/_context`)} && { ${cat} ; } > ${q(contextPath)} && wc -c ${q(contextPath)}`
  log(`Bundling ${contextFiles.length} context file(s) → ${contextPath}`)
  await agent(`Run this exact shell command in ONE Bash call and report its stdout. Do nothing else:\n\n${cmd}`,
    { model: 'haiku', phase: 'Round 1', label: 'context' }).catch(() => null)
}

// ---- repoMode worktree helpers (Phase 1). ALL gated on repoMode: every function below returns/falls
// through to the existing behavior when repoMode is false, so repoMode:false is byte-for-byte today. ----
const worktreeBranch = (roundName, label) => `jewt/${safeRunId}/${roundName}/${label}`
const worktreeLogDir = (roundName, label) => `${runDir}/_engine-logs/${roundName}/${label}`
const worktreeMetaDir = `${runDir}/_worktrees`
// issue #44: repoMode worktree CHECKOUTS live OUTSIDE ~/.claude/ (which the harness treats as sensitive
// and DENIES sub-agent Write/Edit/shell-redirect under), so runner-based attempts (glm/minimax/codex/grok)
// can actually write their deliverable into their worktree instead of failing / burning their turn budget.
// ONLY the checkout moves — staging artifacts, _engine-logs, and the run dir stay under runDir (the engine
// + native agents write those fine, and the blind _pool.md diff capture is path-independent). Configurable
// via args.worktreeRoot; default /tmp/je-worktrees/<runId> (the engine sandbox has no node:process, so it
// cannot read TMPDIR — the SKILL/caller may pass ${TMPDIR:-/tmp}/je-worktrees/<runId>). repoMode:false =>
// null (unused; the legacy scratch-dir path is byte-for-byte unchanged).
const worktreeRoot = repoMode ? (A.worktreeRoot || `/tmp/je-worktrees/${safeRunId}`) : null
const worktreePath = (roundName, label) => repoMode ? `${worktreeRoot}/${roundName}/${label}` : null
// issue #34: self-contained candidate WORKSPACES (repoMode:false) also default under runDir
// today — which sits inside the user config dir / plugin cache, a path nested claude-CLI
// runners (glm/minimax/codex/grok) treat as SENSITIVE and refuse to write under, so a
// completed runner attempt can burn its whole turn budget fighting write denials and save
// nothing (issue #34: MiniMax ran to exit=0 and saved zero files; GLM hit "Reached max turns
// (50)" both rounds). Mirrors the #44 worktreeRoot fix exactly: a configurable root, default
// OUTSIDE ~/.claude/, no process.env read (module scope has no node:process, so it cannot
// read TMPDIR — the SKILL/caller may pass ${TMPDIR:-/tmp}/je-workspaces/<runId>). Applies to
// EVERY self-contained candidate workspace (native Anthropic included too, so there is one
// uniform non-repoMode path rather than a per-dispatch special case) — ONLY the workspace
// moves; staging/review dirs, _engine-logs, the context bundle, and every persisted run
// artifact (mapping.json, SUMMARY*.md, review-*/, contributions.json, implement.json,
// _winning-plan/) stay under runDir exactly as today, because they are all written from
// literal `${runDir}/...}` paths, never from `ws`. stageAndValidate's `cp -R ${q(c.ws)}/. ...`
// always reads from c.ws, so blind staging keeps copying from wherever the workspace now
// lives with no further change. Configurable via args.workspaceRoot; pass
// `workspaceRoot: runDir` to reproduce the pre-fix layout verbatim (explicit legacy escape
// hatch, same pattern as `judges: 1`).
const workspaceRoot = A.workspaceRoot || `/tmp/je-workspaces/${safeRunId}`
const scratchPath = (roundName, label) => `${workspaceRoot}/${roundName}/${label}`
const engineFiles = ['_brief.txt', '_glm_run.log', '_local_run.log', '_codex_run.log', '_codex_last.txt', '_minimax_run.log', '_grok_run.log']
const engineLogPath = (c, log) => {
  if (!repoMode || !log) return log ? `${c.ws}/${log}` : ''
  // Implement rounds carry an explicit roundName ('impl-3'/'impl-4'); plan rounds fall back to
  // the round number ('round-1'/'round-2') exactly as before.
  const roundName = c.roundName || (c.round === 2 ? 'round-2' : 'round-1')
  return `${worktreeLogDir(roundName, c.label || c.blind)}/${log}`
}

function worktreeSetupShell(c, roundName) {
  const branch = worktreeBranch(roundName, c.label)
  const ws = c.ws
  const excludes = engineFiles.map(f => `printf '%s\\n' ${q(f)} >> "$exclude"`).join('; ')
  return `branch=${q(branch)}; ws=${q(ws)}; baseSha=${q(baseSha)}; ` +
    `mkdir -p ${q(`${runDir}/${roundName}`)} ${q(worktreeMetaDir)}; ` +
    `if [ ! -e "$ws/.git" ]; then git worktree add -b "$branch" "$ws" "$baseSha" --no-checkout 2>/dev/null || git worktree add -b "$branch" "$ws" "$baseSha"; fi; ` +
    `git -C "$ws" checkout -q "$baseSha" -- . 2>/dev/null || git -C "$ws" reset -q --hard "$baseSha"; ` +
    `exclude=$(git -C "$ws" rev-parse --git-path info/exclude); mkdir -p "$(dirname "$exclude")"; ` +
    `printf '\\n# Joust Engine engine files\\n' >> "$exclude"; ${excludes}`
}

async function buildWorktrees(roundName, list) {
  if (!repoMode) return
  if (!baseSha) throw new Error('repoMode requires args.baseRef')
  const script = list.map(c => worktreeSetupShell(c, roundName)).join('\n')
  log(`Preparing ${list.length} git worktree(s) for ${roundName} from ${baseSha}`)
  await agent(
    `Run this exact shell script in ONE Bash call. It serially creates git worktrees for the tournament attempts; do not parallelize it and do not do anything else.\n\n${script}`,
    { model: 'haiku', phase: roundName === 'round-1' ? 'Round 1' : 'Round 2', label: `${roundName}-worktrees` }
  ).catch(() => null)
}

function snapshotShell(c, roundName) {
  const ws = c.ws
  const logDir = worktreeLogDir(roundName, c.label)
  const cleanEngineFiles = engineFiles.map(f =>
    `if [ -f "$ws/${f}" ]; then cp "$ws/${f}" "$logDir/${f}" 2>/dev/null || true; fi; ` +
    `if git -C "$ws" ls-files --error-unmatch ${q(f)} >/dev/null 2>&1; then git -C "$ws" checkout -q "$baseSha" -- ${q(f)} 2>/dev/null || true; else rm -f "$ws/${f}"; fi`
  ).join('; ')
  return `ws=${q(ws)}; logDir=${q(logDir)}; mkdir -p "$logDir"; ${cleanEngineFiles}; ` +
    `git -C "$ws" add -A; ` +
    `if git -C "$ws" diff --cached --quiet; then :; else ` +
    `GIT_AUTHOR_NAME=joust GIT_AUTHOR_EMAIL=joust@localhost ` +
    `GIT_COMMITTER_NAME=joust GIT_COMMITTER_EMAIL=joust@localhost ` +
    `GIT_AUTHOR_DATE="$baseDate" GIT_COMMITTER_DATE="$baseDate" ` +
    `git -C "$ws" commit -q -m 'joust attempt' 1>/dev/null; fi`
}

async function snapshotWorktrees(roundName, list) {
  if (!repoMode || !list.length) return
  if (!baseSha) throw new Error('repoMode requires args.baseRef')
  const dateFile = `${worktreeMetaDir}/base-date`
  const script = [
    `set -eu`,
    `mkdir -p ${q(worktreeMetaDir)}`,
    `baseSha=$(git rev-parse --verify ${q(`${baseSha}^{commit}`)})`,
    `dateFile=${q(dateFile)}`,
    `if [ -s "$dateFile" ]; then baseDate=$(cat "$dateFile"); else baseDate=$(git show -s --format=%cI "$baseSha"); printf '%s\\n' "$baseDate" > "$dateFile"; fi`,
    ...list.map(c => snapshotShell(c, roundName)),
  ].join('\n')
  log(`Snapshotting ${list.length} worktree(s) for ${roundName}`)
  await agent(
    `Run this exact shell script in ONE Bash call. It serially snapshots each worktree into at most one fixed-identity commit; do not parallelize it and do not do anything else.\n\n${script}`,
    { model: 'haiku', phase: roundName === 'round-1' ? 'Review' : 'Final rank', label: `${roundName}-snapshot` }
  ).catch(() => null)
}

const RUNVERBATIM = (cmd, ws, log) =>
  `This is an approved internal step of the joust-engine tournament: it writes a brief file and runs a bundled project runner script, which performs the attempt. Run the following shell command EXACTLY as given, in one Bash call, and do nothing else (do not attempt the task yourself, do not edit the command):\n\n${cmd}\n\nThen report the deliverable path(s) in ${ws} and the last ~15 lines of ${log}.`

// The bundled worker agents register under the plugin namespace (joust-engine:<name>);
// accept either the bare or namespaced form from callers and normalize to what the
// agent registry actually resolves.
const nsAgent = t => (t && !t.includes(':')) ? `joust-engine:${t}` : t

// ---- dispatch-failure classification (#45) -------------------------------
// A worker attempt fails in two very different ways: (a) the model RAN but produced a
// bad/empty deliverable — a normal, expected loss; or (b) it NEVER ran because its
// required agent type is not registered in this session — an INFRASTRUCTURE drop that
// silently shrinks N (the field the judges see). These must not be blended together.
// The workflow runtime exposes no agent-registry query primitive, so we cannot truly
// preflight; instead we classify the dispatch error and report effective-vs-requested
// field size per round so a missing provider agent is LOUD, never silent. The common
// cause is a plugin installed/updated AFTER session start (agent types register only at
// session start). The canonical error text is: agent type 'x' not found.
const dispatchDrops = [] // {label, displayModel, agentType, phase} — one per unregistered-agent drop
// Match the canonical harness text `agent type 'x' not found` ONLY: same line, bounded gap.
// (No /s flag and a no-newline bounded gap so a multi-line runner transcript that merely
// mentions "agent type" somewhere and an unrelated "X not found" elsewhere is NOT misread
// as an infra drop — that false positive would invert the exact distinction #45 makes.)
function isUnregisteredAgentError(msg) { return /agent type\b[^\n]{0,80}\bnot found\b/i.test(String(msg)) }
// The prominent per-round warning (or null when no infra drops happened that round).
function dispatchDropSummary(phaseTitle, drops, requested, survived) {
  const mine = drops.filter(d => d.phase === phaseTitle)
  if (!mine.length) return null
  const types = [...new Set(mine.map(d => d.agentType))].join(', ')
  return `JE-DISPATCH-WARNING [${phaseTitle}]: ${mine.length}/${requested} attempt(s) dropped — required agent type(s) NOT REGISTERED: ${types}. Effective field ${survived}/${requested}. The affected provider(s) did NOT run, silently shrinking N. Most likely the plugin was installed/updated AFTER this session started (agent types register only at session start) — restart the session, then re-run for the full field.`
}

// SECURITY (audit #5, finding #3): a model id can reach the shell as an UNQUOTED flag token
// (local: `--model ${a.model}`; codex/grok fallbacks: `-m ${a.model}`). The allowlist maps
// (CODEX_FLAG/GROK_FLAG) cover known display models, but the LOCAL path accepts the model id
// VERBATIM (je-parse treats live local ids as accept-verbatim), so a hostile id like
// `x; rm -rf /` or `--dangerously-skip-permissions` would flow unescaped into the runner command
// / underlying CLI. We therefore VALIDATE the id against a strict allowlist charset BEFORE it is
// ever interpolated into a flag, and FAIL CLOSED (drop the attempt) on any non-match — mirroring
// the missing-runner skip pattern below rather than crashing the whole field.
// The charset bans shell metacharacters/whitespace; the leading char is additionally restricted to
// [A-Za-z0-9.] so a metachar-free-but-dash-leading id (e.g. `--dangerously-skip-permissions`)
// cannot be smuggled in as an option to the underlying CLI.
const SAFE_MODEL_ID = /^[A-Za-z0-9.][A-Za-z0-9._-]*$/
function validModelId(m) { return typeof m === 'string' && SAFE_MODEL_ID.test(m) }

// Does this attempt's dispatch path actually interpolate a.model into a shell flag? Only then
// must a.model exist and be safe. Per the documented ARGS shape, glm attempts carry NO `model`
// at all (GLM_FLAG is keyed by displayModel), and codex/grok interpolate a.model only as the
// `-m ${a.model}` FALLBACK when displayModel is not in their flag map — so requiring a valid
// a.model unconditionally (the original audit-#5 guard) dropped every documented glm attempt at
// dispatch (validModelId(undefined) === false), silently zeroing the glm field. local always
// interpolates (`--model ${a.model}`); minimax never does (env-pinned); anthropic passes a.model
// to agent() opts (no shell) but always has one, so it stays validated as cheap defense.
function interpolatesModelId(a) {
  switch (a.dispatch) {
    case 'glm': return false
    case 'minimax': return false
    case 'codex': return !CODEX_FLAG[a.displayModel]
    case 'grok': return !GROK_FLAG[a.displayModel]
    default: return true // local (always --model ${a.model}) + native anthropic (agent opts)
  }
}

function dispatch(a, ws, guidance, phaseTitle, phaseKind = 'plan', seedPlanPath = null) {
  // Any dispatch path that interpolates a.model into a runner flag must see a safe id. Reject up
  // front (fail closed) so no malicious id can ever reach the shell as an unquoted flag token.
  if (interpolatesModelId(a) && !validModelId(a.model)) {
    log(`attempt ${a.label} (${a.displayModel}) skipped: model id rejected — must match ${SAFE_MODEL_ID} (refusing to interpolate an unsafe id into a runner flag)`)
    return null
  }
  // phaseKind selects the framing: 'plan' (Rounds 1–2, produce a PLAN artifact) or 'implement'
  // (Rounds 3–4, apply the change, seeded with the winning plan verbatim via seedPlanPath).
  const b = brief(guidance ? a.r2nudge : a.r1nudge, ws, guidance, contextPath, phaseKind, seedPlanPath)
  const opts = { label: `${phaseTitle}:${a.displayModel}`, phase: phaseTitle }
  let prompt
  if (a.dispatch === 'glm') {
    opts.agentType = nsAgent(a.agentType)
    const flag = GLM_FLAG[a.displayModel]
    if (!glmRunner) {
      log(`attempt ${a.label} (${a.displayModel}) skipped: glmRunner not supplied (pass args.glmRunner pointing to bin/glm-run.sh)`)
      return null
    }
    const cmd = runnerCmd(glmRunner, flag, ws, b, glmMaxTurns, glmTimeoutSecs)
    prompt = RUNVERBATIM(cmd, ws, '_glm_run.log')
  } else if (a.dispatch === 'local') {
    opts.agentType = nsAgent(a.agentType) // joust-local
    const flag = `--model ${a.model}` // exact local model id, passes straight through to omlx
    prompt = RUNVERBATIM(runnerCmd(localRunner, flag, ws, b, localMaxTurns), ws, '_local_run.log')
  } else if (a.dispatch === 'codex') {
    opts.agentType = nsAgent(a.agentType) // joust-codex (one generic agent for every codex effort)
    const flag = CODEX_FLAG[a.displayModel] || `-m ${a.model}` // gpt-5.5 + reasoning-effort flags -> codex exec
    prompt = RUNVERBATIM(codexRunnerCmd(codexRunner, flag, ws, b), ws, '_codex_run.log')
  } else if (a.dispatch === 'minimax') {
    opts.agentType = nsAgent(a.agentType) // joust-minimax (one generic agent; MiniMax exposes only MiniMax-M3)
    // No --model flag: the runner's ANTHROPIC_MODEL pins MiniMax-M3 (all aliases map to it).
    prompt = RUNVERBATIM(runnerCmd(minimaxRunner, '', ws, b, minimaxMaxTurns, minimaxTimeoutSecs), ws, '_minimax_run.log')
  } else if (a.dispatch === 'grok') {
    opts.agentType = nsAgent(a.agentType) // joust-grok (one generic agent for BOTH grok variants)
    const flag = GROK_FLAG[a.displayModel] || `-m ${a.model}` // grok-build | grok-composer-2.5-fast -> grok -m
    if (!grokRunner) {
      log(`attempt ${a.label} (${a.displayModel}) skipped: grokRunner not supplied (pass args.grokRunner pointing to bin/grok-run.sh)`)
      return null
    }
    // Grok uses the STANDARD runnerCmd (both JE_MAX_TURNS and JE_TIMEOUT_SECS), NOT codexRunnerCmd:
    // unlike codex, grok HAS --max-turns, so it gets both guards like glm/minimax. (Key structural delta.)
    // Web search is OFF by default (hermetic/fair, like the other runner-based providers); args.grokWebSearch:true
    // sets JE_GROK_WEB=1 so the runner enables it — for tasks needing LIVE web at attempt time (a URL/doc/link
    // the shared contextFiles bundle cannot pre-provide).
    const grokEnv = A.grokWebSearch === true ? 'JE_GROK_WEB=1 ' : ''
    prompt = RUNVERBATIM(runnerCmd(grokRunner, flag, ws, b, grokMaxTurns, grokTimeout, grokEnv), ws, '_grok_run.log')
  } else {
    // Native Anthropic attempt. NOTE: the workflow agent() primitive exposes no turn/time cap,
    // so (unlike GLM/local) these are bounded only by the single-pass brief. If a future agent()
    // gains a maxTurns option, pass an Anthropic-equivalent cap here for symmetry.
    opts.model = a.model
    prompt = b
  }
  return agent(prompt, opts)
    .then(res => ({ label: a.label, displayModel: a.displayModel, dispatch: a.dispatch || 'anthropic', ws, res }))
    .catch(e => {
      const msg = String(e)
      if (opts.agentType && isUnregisteredAgentError(msg)) {
        // (b) infrastructure drop — surface LOUDLY and record so the round summary can name it. (#45)
        dispatchDrops.push({ label: a.label, displayModel: a.displayModel, agentType: opts.agentType, phase: phaseTitle })
        log(`JE-DISPATCH-DROP [${phaseTitle}]: required agent type '${opts.agentType}' is NOT REGISTERED — attempt ${a.label} (${a.displayModel}) never ran. Likely the plugin was installed/updated after this session started; restart the session to register it, then re-run.`)
      } else {
        log(`attempt ${a.label} (${a.displayModel}) errored: ${msg.slice(0, 100)}`) // (a) ran-but-lost; don't swallow silently
      }
      return null
    })
}

function judgePrompt(kind, blindList, guidanceWanted, poolPath) {
  const dirs = blindList.map(c => `  Candidate ${c.blind}: ${c.ws}/`).join('\n')
  const guidanceBlock = guidanceWanted
    ? `\n\nAlso distil GUIDANCE for a second round of fresh, independent attempts. These are FALLIBLE PRIORS over a single noisy round, not commands — the next attempts will weigh them and may override them, so calibrate honestly and do not over-claim. Two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never write "seen in 2 of 3" — describe the reason in words):\n- positives: generic patterns/choices that helped anywhere this round.\n- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.\nFor EACH item give: text (a generic principle, never an implementation lift — if it only makes sense as one exact piece of code, DROP it); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts (a corroboration bar that filters luck), otherwise "tentative" for a single sighting or a plausible-but-unconfirmed call; and why, one short generic clause naming the reason for the tier (e.g. "the round's most common miss", "held across several approaches", "seen once"). Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list. Prefer marking a shaky item "tentative" over dropping it; only drop an item you cannot phrase generically.`
    : ''
  return `You are a blind ${kind}. You do NOT know which model produced which candidate; do not speculate. Judge only the work in front of you.

Task that every candidate was given:
${task}

All candidate deliverables are concatenated, blind-labelled, in ONE file — read it ONCE (each candidate's section is headed "===== Candidate <letter> ====="):
${poolPath}

If (and only if) a candidate is runnable code you want to execute to judge the real output, its individual files are in its own directory (run with a sensible timeout):
${dirs}
Judge the real output / artifact — not any self-summary. Do not read any other files.

Score each candidate against criteria suited to the task (for code: correctness, meets stated constraints, completeness, edge cases, readability; adapt for non-code). Score against the task's STATED runtime, not an environment you cannot see: treat reliance on a capability the task did not establish is available as a risk, and treat an unfamiliar mechanism that honours the stated constraints as correct unless you can name a concrete way it fails — never reward a familiar-looking API over a constraint-honouring one on idiom alone. Give concrete, specific pros and cons per candidate. Rank them all. Name the single winner with reasoning.${guidanceBlock}

Return the structured object: per-candidate pros/cons, the full ranking (best first, by candidate letter), the winner letter${guidanceWanted ? ', and the two guidance lists (each item: text, conf, why)' : ''}.`
}

const CANDS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      label: { type: 'string', description: 'candidate letter' },
      pros: { type: 'array', items: { type: 'string' } },
      cons: { type: 'array', items: { type: 'string' } },
    },
    required: ['label', 'pros', 'cons'],
  },
}
// Each guidance item is a fallible PRIOR, not a command: a generic pattern/pitfall (`text`), a two-bucket
// confidence (`conf`: 'strong' = corroborated/repeated this round — the anti-luck bar; 'tentative' = single
// sighting or speculative), and a short GENERIC evidence clause (`why`) that names the reason WITHOUT any
// count or model identity (leaking either would break blind review / the no-N rule). Two buckets, not three
// or a numeric scale: one noisy judge can't calibrate finer than corroborated-vs-not.
const GUIDANCE_CAP = 5 // hard per-list cap. maxItems below is ADVISORY for the structured-output judge,
                       // so brief()/guidanceToMd() ALSO slice(0, GUIDANCE_CAP) — render-side is the real enforcer.
const GUIDANCE_ITEM = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string' },
    conf: { type: 'string', enum: ['strong', 'tentative'] },
    why: { type: 'string' },
  },
  required: ['text', 'conf', 'why'],
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    candidates: CANDS,
    ranking: { type: 'array', items: { type: 'string' } },
    winner: { type: 'string' },
    reasoning: { type: 'string' },
    guidance: {
      type: 'object', additionalProperties: false,
      properties: {
        positives: { type: 'array', maxItems: GUIDANCE_CAP, items: GUIDANCE_ITEM },
        challenges: { type: 'array', maxItems: GUIDANCE_CAP, items: GUIDANCE_ITEM },
      },
      required: ['positives', 'challenges'],
    },
  },
  required: ['candidates', 'ranking', 'winner', 'reasoning', 'guidance'],
}
const RANK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    candidates: CANDS,
    ranking: { type: 'array', items: { type: 'string' } },
    winner: { type: 'string' },
    reasoning: { type: 'string' },
  },
  required: ['candidates', 'ranking', 'winner', 'reasoning'],
}

// ---- helpers ----
const STAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { blind: { type: 'string' }, deliverable: { type: 'boolean' }, provenance: { type: 'boolean' } },
        required: ['blind', 'deliverable', 'provenance'],
      },
    },
  },
  required: ['results'],
}

// Phase 5's blind grammar. The shell creates this line from exit codes only; it is also the
// allowlist used before the pool is rebuilt. Keep every value numeric/boolean and fixed-position.
const ENRICHMENT_FALLBACK = 'automated_checks: enrichment_ok=0 checks_ok=0 verify_pass=0 verify_fail=0 verify_timeout=0 build_detected=0 build_ok=0 build_fail=0 build_timeout=0 lint_pass=0 lint_fail=0 lint_timeout=0'
const ENRICHMENT_GRAMMAR = '^automated_checks: enrichment_ok=[01] checks_ok=[01] verify_pass=[0-9]+ verify_fail=[0-9]+ verify_timeout=[0-9]+ build_detected=[01] build_ok=[01] build_fail=[01] build_timeout=[01] lint_pass=[0-9]+ lint_fail=[0-9]+ lint_timeout=[0-9]+$'

// D-0004 FIX — PURE, drift-proof provenance-gate builder.
// Emits the shell snippet that sets P (the provenance flag the `D>0 && P==1` pool gate reads).
//   - log:        the engine log filename for this dispatch ('' for native Anthropic) — selects the path.
//   - tok:        the provider provenance token (GLM/LOCAL/CODEX/MINIMAX), '' for native.
//   - lp:         the SHELL-ESCAPED path to the log file (q(`${ws}/${log}`)).
//   - carriedOver: true ONLY for the two-pass round-1 winner re-staged into the final pool.
//
// Decision (the single behavioural delta of this fix):
//   * native (no log)                -> `P=1` (UNCHANGED; native has no provenance contract).
//   * carried-over runner candidate  -> `P=1` (NEW; it ALREADY passed provenance in round 1, but its
//                                       engine log was stripped during round-1 staging, so re-grepping a
//                                       deliberately-stripped dir always yields P=0 — the D-0004 bug).
//   * normal runner candidate (log)  -> the line-anchored success-contract grep (UNCHANGED, byte-for-byte).
// The deliverable (`D>0`) requirement is NOT in here — it is enforced separately at the gate, so a
// carried-over candidate with an EMPTY staged dir is still excluded.
function provCheckShell(log, tok, lp, carriedOver) {
  if (!log) return `P=1`              // native Anthropic: no provenance log, unchanged
  if (carriedOver) return `P=1`       // already validated in round 1; do NOT re-grep the stripped dir
  return `if [ -f ${lp} ]; then if grep -q '^JOUST-${tok}-PROVENANCE endpoint=' ${lp} && grep -q '^JOUST-${tok}-DONE exit=0' ${lp} && ! grep -q '^JOUST-${tok}-\\(TIMEOUT\\|ERROR\\)' ${lp}; then P=1; else P=0; fi; else P=0; fi`
}

// Persist-verification schema: the write-agent reports, per FINAL target path, the byte count
// (`wc -c`) of the file it wrote — NOT free text. We decide success from `bytes > 0` per path, so a
// silently-skipped write (no file → reported as bytes:0/absent) can never read as success (#D-0002).
const PERSIST_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
        required: ['path', 'bytes'],
      },
    },
  },
  required: ['results'],
}

// Stage + validate + pool, all from one cheap haiku agent running a DETERMINISTIC shell script:
//  - stage deliverables into a clean per-blind dir (copy all, then delete the known engine files by
//    exact name — an allowlist, so a legit `_`-prefixed deliverable like `_config.yml` is NOT dropped) (#6);
//  - check a deliverable was saved AND (glm/local) the SUCCESS provenance contract holds — PROVENANCE
//    marker + DONE exit=0 + no TIMEOUT/ERROR (#2);
//  - concatenate the valid deliverables into ONE blind-labelled pool file the judge reads once (read-cost).
// The agent returns per-candidate {deliverable, provenance} via a SCHEMA (not scraped prose) (#4), and we
// FAIL CLOSED (#1): any candidate missing from the return, or not deliverable+provenance, is invalid.
async function stageAndValidate(list, reviewDir, phaseTitle) {
  const pool = `${reviewDir}/_pool.md`
  const script = [`mkdir -p ${q(reviewDir)}; : > ${q(pool)}`].concat(list.map(c => {
    const dest = `${reviewDir}/${c.blind}`
    const diffPath = `${dest}/candidate.diff`
    const log = c.dispatch === 'glm' ? '_glm_run.log'
              : c.dispatch === 'local' ? '_local_run.log'
              : c.dispatch === 'codex' ? '_codex_run.log'
              : c.dispatch === 'minimax' ? '_minimax_run.log'
              : c.dispatch === 'grok' ? '_grok_run.log'
              : ''
    const lp = log ? q(engineLogPath(c, log)) : ''
    // Provider-specific, LINE-ANCHORED marker token. Runners write their JOUST-<PROV>-* markers at
    // column 0, so matching '^JOUST-<PROV>-' (not the greedy 'JOUST-.*-') stops an attempt whose
    // OWN deliverable/transcript merely MENTIONS a marker — e.g. a proposal discussing JOUST-CODEX-ERROR,
    // echoed mid-line into its log — from false-tripping its own validation. That self-referential
    // false-negative was real: it invalidated two genuinely-successful GLM proposals about this very feature.
    // FAIL CLOSED (#2): the PROVENANCE line is written UNCONDITIONALLY at runner startup, so a missing log
    // here means the runner never ran (native-solve spoof / refusal) → P=0. Native attempts (no runner) → P=1.
    const tok = c.dispatch === 'glm' ? 'GLM' : c.dispatch === 'local' ? 'LOCAL' : c.dispatch === 'codex' ? 'CODEX' : c.dispatch === 'minimax' ? 'MINIMAX' : c.dispatch === 'grok' ? 'GROK' : ''
    // D-0004: a carried-over round-1 winner was ALREADY provenance-validated in round 1, but its engine log
    // was stripped during round-1 staging — so re-grepping its stripped staging dir always yields P=0 and the
    // winner is wrongly dropped. provCheckShell skips ONLY the provenance grep for a carryover (P=1); the
    // deliverable requirement below (`D>0`) is still enforced, so an empty carryover is still excluded.
    const provChk = provCheckShell(log, tok, lp, !!c.carriedOver)
    if (repoMode) {
      // repoMode: the blind artifact is a DIFF, not a copied workspace. Capture `git diff <baseSha> HEAD`
      // (no author/date/branch/message metadata leaks into judging) and keep the same D/P pool gate + JEV
      // line protocol. The carried-over round-1 winner is already a staged candidate.diff (not a live
      // worktree), so copy it forward and keep the D-0004 provenance skip (provChk -> P=1 for carryover).
      if (c.carriedOver) {
        return `mkdir -p ${q(dest)}; if [ -s ${q(`${c.ws}/candidate.diff`)} ]; then cp ${q(`${c.ws}/candidate.diff`)} ${q(diffPath)}; D=1; else D=0; fi; ${provChk}; ` +
               `if [ "$D" -gt 0 ] && [ "$P" -eq 1 ]; then { echo "===== Candidate ${c.blind} ====="; cat ${q(diffPath)} 2>/dev/null; echo; } >> ${q(pool)}; fi; ` +
               `echo "JEV ${c.blind} d=$([ "$D" -gt 0 ] && echo 1 || echo 0) p=$P"`
      }
      return `mkdir -p ${q(dest)}; git -C ${q(c.ws)} diff ${q(baseSha)} HEAD --no-color --no-prefix > ${q(diffPath)} 2>/dev/null; ` +
             `if [ -s ${q(diffPath)} ]; then D=1; else D=0; fi; ${provChk}; ` +
             `if [ "$D" -gt 0 ] && [ "$P" -eq 1 ]; then { echo "===== Candidate ${c.blind} ====="; cat ${q(diffPath)} 2>/dev/null; echo; } >> ${q(pool)}; fi; ` +
             `echo "JEV ${c.blind} d=$([ "$D" -gt 0 ] && echo 1 || echo 0) p=$P"`
    }
    return `mkdir -p ${q(dest)}; cp -R ${q(c.ws)}/. ${q(dest)}/ 2>/dev/null; ` +
           `rm -f ${q(dest)}/_brief.txt ${q(dest)}/_glm_run.log ${q(dest)}/_local_run.log ${q(dest)}/_codex_run.log ${q(dest)}/_codex_last.txt ${q(dest)}/_minimax_run.log ${q(dest)}/_grok_run.log; ` +
           `find ${q(dest)} -mindepth 1 ! -type f ! -type d -delete 2>/dev/null; ` +
           `D=$(find ${q(dest)} -type f 2>/dev/null | grep -c .); ${provChk}; ` +
           `if [ "$D" -gt 0 ] && [ "$P" -eq 1 ]; then { echo "===== Candidate ${c.blind} ====="; find ${q(dest)} -type f -print0 2>/dev/null | xargs -0 cat 2>/dev/null; echo; } >> ${q(pool)}; fi; ` +
           `echo "JEV ${c.blind} d=$([ "$D" -gt 0 ] && echo 1 || echo 0) p=$P"`
  })).join('\n')
  const res = await agent(
    `Run this exact shell script in ONE Bash call. It prints one line per candidate of the form "JEV <letter> d=<0|1> p=<0|1>". Then return the structured results: for EACH printed JEV line, an entry {blind: the letter, deliverable: (d==1), provenance: (p==1)}. Report exactly what the script printed — do not infer or change values.\n\n${script}`,
    { model: 'haiku', schema: STAGE_SCHEMA, phase: phaseTitle, label: 'stage' }
  ).catch(() => null)
  const v = {}
  for (const r of (res && Array.isArray(res.results) ? res.results : [])) v[String(r.blind).trim()] = r
  return list.map(c => {
    const r = v[c.blind]                           // FAIL CLOSED: missing/unparsed → invalid
    const valid = !!(r && r.deliverable && r.provenance)
    const failReason = valid ? '' : (!r ? 'staging result missing (failed closed)' : (!r.deliverable ? 'no deliverable saved' : 'provenance check failed (timeout/error/empty)'))
    // Staging changes ws to the blind review directory. Phase 5 still needs the runnable checkout;
    // expose it only in repoMode so the legacy object shape and all legacy consumers stay unchanged.
    return repoMode
      ? { ...c, liveWs: c.ws, ws: `${reviewDir}/${c.blind}`, valid, failReason }
      : { ...c, ws: `${reviewDir}/${c.blind}`, valid, failReason }
  })
}

// Phase 5: run checks in live worktrees, then rebuild the blind pool from an allowlisted summary.
// The engine cannot import node:fs/process, so this mirrors buildWorktrees()/stageAndValidate():
// one cheap agent, one deterministic Bash script. No agent-authored prose is ever pooled.
async function enrichBlindPool(list, reviewDir, phaseTitle) {
  if (!repoMode || !list.length) return
  const pool = `${reviewDir}/_pool.md`
  const fallback = q(ENRICHMENT_FALLBACK + '\n')
  const grammar = q(ENRICHMENT_GRAMMAR)
  const perCandidate = list.map(c => {
    const dest = `${reviewDir}/${c.blind}`
    const summary = `${dest}/enrichment.txt`
    if (c.carriedOver) {
      // The round-1 champion was already checked before the first blind pick. It has no live ws here;
      // copy only its strict summary, never rerun it and never copy arbitrary prior-pool text.
      const source = c.enrichmentSource || `${c.ws}/enrichment.txt`
      return `mkdir -p ${q(dest)}; ` +
             `if [ -f ${q(source)} ] && grep -Eq ${grammar} ${q(source)}; then cp ${q(source)} ${q(summary)}; else printf '%s' ${fallback} > ${q(summary)}; fi`
    }
    const ws = c.liveWs
    return `(` +
      `ws=${q(ws)}; summary=${q(summary)}; commands=${q(`${dest}/.verify-commands`)}; lint_commands=${q(`${dest}/.lint-commands`)}; ` +
      `mkdir -p ${q(dest)}; printf '%s' ${fallback} > "$summary"; : > "$commands"; : > "$lint_commands"; ` +
      `helper=$(git rev-parse --show-toplevel)/bin/je-git.sh; timeout=\${JE_VERIFY_CMD_TIMEOUT:-600}; ` +
      `case "$timeout" in ''|*[!0-9]*) timeout=600;; esac; ` +
      // Drop provider secrets before running untrusted candidate code (mirrors run_verify). The z.ai key
      // name is assembled at shell-runtime ("Z"+"AI_API_KEY") so the engine source keeps the #25 hygiene
      // guarantee (no literal ZAI key token in tournament.mjs); the same variable is still unset at runtime.
      // Candidate (LLM-authored) verify/lint code below runs through `je_verify_exec` — the same sandbox
      // chokepoint run_verify uses — so it is routed through the OS sandbox under the auto/strict policy
      // (JE_VERIFY_SANDBOX), not executed directly. Secret-drop above remains the env-credential boundary.
      `for v in "Z""AI_API_KEY" MINIMAX_API_KEY OMLX_AUTH_TOKEN OPENAI_API_KEY XAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN GH_TOKEN GITHUB_TOKEN; do unset "$v"; done; ` +
      `enrichment_ok=0; vp=0; vf=0; vt=0; lp=0; lf=0; lt=0; bd=0; bf=0; bt=0; ` +
      `if bash "$helper" je_run_with_timeout "$timeout" -- bash "$helper" detect_verify "$ws" > "$commands" 2>/dev/null; then enrichment_ok=1; else : > "$commands"; fi; ` +
      `while IFS= read -r cmd; do ` +
        `case "$cmd" in ''|'#'*) continue;; esac; ` +
        `read -r -a words <<< "$cmd"; [ "\${#words[@]}" -gt 0 ] || continue; ` +
        `is_lint=0; case "$cmd" in *lint*|*eslint*|*ruff*|*clippy*|*'go vet'*) is_lint=1;; esac; ` +
        `is_build=0; case "$cmd" in *build*) is_build=1; bd=1;; esac; ` +
        `if (cd "$ws" && bash "$helper" je_run_with_timeout "$timeout" -- bash "$helper" je_verify_exec "\${words[@]}") >/dev/null 2>&1; then rc=0; else rc=$?; fi; ` +
        `if [ "$rc" -eq 0 ]; then vp=$((vp+1)); [ "$is_lint" -eq 0 ] || lp=$((lp+1)); ` +
        `elif [ "$rc" -eq 124 ]; then vt=$((vt+1)); [ "$is_lint" -eq 0 ] || lt=$((lt+1)); [ "$is_build" -eq 0 ] || bt=1; ` +
        `else vf=$((vf+1)); [ "$is_lint" -eq 0 ] || lf=$((lf+1)); [ "$is_build" -eq 0 ] || bf=1; fi; ` +
      `done < "$commands"; ` +
      // Fixed lint detection only. Never execute candidate-supplied command text or assume a new helper.
      `if [ -f "$ws/package.json" ] && grep -Eq '"lint"[[:space:]]*:' "$ws/package.json"; then printf '%s\\n' 'npm run lint' >> "$lint_commands"; fi; ` +
      `if [ -f "$ws/Makefile" ] && grep -Eq '^[[:space:]]*lint[[:space:]]*:' "$ws/Makefile"; then printf '%s\\n' 'make lint' >> "$lint_commands"; fi; ` +
      `if [ -f "$ws/pyproject.toml" ] && grep -Eq '^\\[tool\\.ruff([].]|$)' "$ws/pyproject.toml"; then printf '%s\\n' 'ruff check .' >> "$lint_commands"; fi; ` +
      `if [ -f "$ws/Cargo.toml" ]; then printf '%s\\n' 'cargo clippy --all-targets' >> "$lint_commands"; fi; ` +
      `if [ -f "$ws/go.mod" ]; then printf '%s\\n' 'go vet ./...' >> "$lint_commands"; fi; ` +
      `while IFS= read -r cmd; do ` +
        `[ -n "$cmd" ] || continue; grep -Fqx "$cmd" "$commands" 2>/dev/null && continue; ` +
        `read -r -a words <<< "$cmd"; ` +
        `if (cd "$ws" && bash "$helper" je_run_with_timeout "$timeout" -- bash "$helper" je_verify_exec "\${words[@]}") >/dev/null 2>&1; then rc=0; else rc=$?; fi; ` +
        `if [ "$rc" -eq 0 ]; then lp=$((lp+1)); elif [ "$rc" -eq 124 ]; then lt=$((lt+1)); else lf=$((lf+1)); fi; ` +
      `done < "$lint_commands"; ` +
      `bo=0; if [ "$bd" -eq 1 ] && [ "$bf" -eq 0 ] && [ "$bt" -eq 0 ]; then bo=1; fi; ` +
      `checks_ok=0; if [ "$enrichment_ok" -eq 1 ] && [ "$vf" -eq 0 ] && [ "$vt" -eq 0 ] && [ "$lf" -eq 0 ] && [ "$lt" -eq 0 ]; then checks_ok=1; fi; ` +
      `printf 'automated_checks: enrichment_ok=%s checks_ok=%s verify_pass=%s verify_fail=%s verify_timeout=%s build_detected=%s build_ok=%s build_fail=%s build_timeout=%s lint_pass=%s lint_fail=%s lint_timeout=%s\\n' ` +
        `"$enrichment_ok" "$checks_ok" "$vp" "$vf" "$vt" "$bd" "$bo" "$bf" "$bt" "$lp" "$lf" "$lt" > "$summary"; ` +
      `if ! grep -Eq ${grammar} "$summary"; then printf '%s' ${fallback} > "$summary"; fi; ` +
      `rm -f "$commands" "$lint_commands"` +
    `)`
  }).join('\n')
  const rebuild = [`tmp=${q(`${pool}.enriched`)}`, `: > "$tmp"`, ...list.map(c => {
    const dest = `${reviewDir}/${c.blind}`
    return `{ printf '===== Candidate %s =====\\n' ${q(c.blind)}; ` +
           `cat ${q(`${dest}/candidate.diff`)} 2>/dev/null; ` +
           `printf '\\n--- Automated checks ---\\n'; ` +
           `if grep -Eq ${grammar} ${q(`${dest}/enrichment.txt`)}; then cat ${q(`${dest}/enrichment.txt`)}; else printf '%s' ${fallback}; fi; ` +
           `printf '\\n'; } >> "$tmp"`
  }), `mv -f "$tmp" ${q(pool)}`].join('\n')
  const script = `${perCandidate}\n${rebuild}`
  await agent(
    `Run this exact shell script in ONE Bash call. It runs blind tournament checks and atomically rebuilds the blind pool. Do not print, summarize, or expose command output; do nothing else:\n\n${script}`,
    { model: 'haiku', phase: phaseTitle, label: 'test-lint-enrichment' }
  ).catch(() => null)
}

// ---- begin: verdict integrity guard ----------------------------------------------------------
// A real observed failure (EV-judge-placeholder.md): a structured-output judge returned literal
// placeholder values for EVERY field ("test" as reasoning, "test" as every pros/cons entry) — schema-valid,
// so reconcile()'s label-permutation repair happily accepted it and it drove a whole round: wrong winner,
// meaningless round-2 guidance. This block is a PURE, deterministic, no-LLM-judges-the-judge guard against
// that narrow shape, wired at EVERY judging choke-point so the exact bug cannot recur through any path:
//   - reconcile()   — the legacy single-judge path (judges:1), both Phase 3 review and Phase 5 final rank.
//   - askLens()     — every council lens verdict, round 1 AND every deliberation round (same call site).
//   - councilTally()— the security veto's EVIDENCE substance (the highest-stakes exclusion path: a vacuous
//                     but schema-valid UNSAFE flag can silently exclude the real winner).
//   - synthesizeGuidance() and reconcile()'s guidance field — council and legacy guidance synthesis.
// Thresholds are conservative and named so a future owner can retune them without hunting through the tally
// logic: a real judge's shortest honest verdict clears them easily. Deliberately an AND of two independent
// signals (thin reasoning AND near-duplicate pros/cons), not an OR — either alone is common in legitimate
// output (a crisp one-line reasoning; two candidates that genuinely share one short con) and rejecting on
// either alone would create a NEW false-halt failure mode (a wrongly-killed lens/judge can cascade into
// NO_CONSENSUS, which is worse than letting one junk verdict through to be outvoted by its peers).
const INTEGRITY = {
  MIN_REASONING_CHARS: 8,       // "test" (4 chars) trips this; "Best overall pick." (19) clears it easily
  MIN_ITEMS_FOR_DIVERSITY: 3,   // need >=3 pros/cons entries before "everything is identical" is meaningful
  MAX_DISTINCT_RATIO: 0.34,     // <=1/3 distinct among >=3 entries => near-duplicate/placeholder shape
  MIN_VETO_EVIDENCE_CHARS: 15,  // a standing high/critical veto needs real substance ("file + why")
}
const JUNK_TOKENS = new Set(['test', 'todo', 'tbd', 'tbc', 'wip', 'n/a', 'na', 'xxx', 'placeholder', 'foo', 'bar', 'asdf', 'lorem ipsum', '...', '-'])
const trimStr = s => String(s == null ? '' : s).trim()

// Returns a short reason string if `result` (the {candidates, ranking, ..., reasoning} shape shared by the
// legacy judge and every council lens) looks like schema-valid junk, else null (pass).
function verdictIntegrityIssue(result) {
  if (!result || typeof result !== 'object') return null // callers already null-guard separately
  const reasoning = trimStr(result.reasoning)
  const reasoningThin = reasoning.length < INTEGRITY.MIN_REASONING_CHARS || JUNK_TOKENS.has(reasoning.toLowerCase())
  const prose = []
  for (const c of (result.candidates || [])) {
    for (const p of (c.pros || [])) prose.push(trimStr(p))
    for (const x of (c.cons || [])) prose.push(trimStr(x))
  }
  let degenerate = false, distinctN = 0
  if (prose.length >= INTEGRITY.MIN_ITEMS_FOR_DIVERSITY) {
    distinctN = new Set(prose.map(s => s.toLowerCase())).size
    degenerate = (distinctN / prose.length) <= INTEGRITY.MAX_DISTINCT_RATIO
  }
  if (reasoningThin && degenerate) {
    return `reasoning near-empty/placeholder (${JSON.stringify(reasoning.slice(0, 20))}) AND pros/cons collapse to ${distinctN} distinct value(s) across ${prose.length} entries — looks like schema-valid junk, not a real verdict`
  }
  return null
}

// checks_run is a REQUIRED array on every council lens verdict (the forced-evidence lever), but an EMPTY
// array satisfies JSON-schema `required` (the key is merely present) while supplying zero evidence — close
// that gap explicitly, in code, at the same choke-point. Pass undefined (legacy schema has no checks_run
// field) to skip.
function checksRunIssue(checksRun) {
  if (checksRun === undefined) return null
  if (!Array.isArray(checksRun) || checksRun.length === 0) return 'checks_run is empty — no evidence recorded for this vote (forced-evidence lever unmet)'
  if (checksRun.every(c => trimStr(c).length < 4)) return 'every checks_run entry is empty/near-empty — no real evidence recorded'
  return null
}

// Highest-stakes exclusion path: a security veto excludes a candidate regardless of votes, so a vacuous
// but schema-valid UNSAFE evidence string must not stand. Conservative: only an empty, placeholder-token,
// or near-empty string is rejected; any real sentence clears MIN_VETO_EVIDENCE_CHARS easily.
function vetoEvidenceIssue(evidence) {
  const e = trimStr(evidence)
  if (!e) return 'veto evidence is empty'
  if (JUNK_TOKENS.has(e.toLowerCase())) return `veto evidence is a placeholder token (${JSON.stringify(e)})`
  if (e.length < INTEGRITY.MIN_VETO_EVIDENCE_CHARS) return `veto evidence too short (${e.length} chars) to substantiate a high/critical exclusion`
  return null
}

// Guidance items ({text, conf, why}) get the same thin-content signal. Degenerate ONLY when EVERY item in
// a non-empty list is thin — an empty list is legitimate (nothing salient to report this round), and one
// weak item among several real ones is normal noise, not junk.
function guidanceIntegrityIssue(g) {
  if (!g || typeof g !== 'object') return null
  const items = [...(Array.isArray(g.positives) ? g.positives : []), ...(Array.isArray(g.challenges) ? g.challenges : [])]
  if (!items.length) return null
  const thin = items.filter(it => {
    const t = trimStr(it && it.text), w = trimStr(it && it.why)
    return t.length < INTEGRITY.MIN_REASONING_CHARS || w.length < INTEGRITY.MIN_REASONING_CHARS || JUNK_TOKENS.has(t.toLowerCase())
  })
  if (thin.length === items.length) return `all ${items.length} guidance item(s) have near-empty/placeholder text or why — looks like schema-valid junk`
  return null
}
// ---- end: verdict integrity guard ------------------------------------------------------------

// #6 + #7: never silently carry the wrong artifact or trust an off-spec ranking — normalize the
// judge's winner/ranking against the REAL candidate labels and repair to a full permutation.
function reconcile(result, labels) {
  // Null-guard: agent() returns null if the judge dies on a terminal API error (or is skipped). Surface
  // that as a clear, catchable error instead of a cryptic "null is not an object" — judge() retries once
  // then degrades to a clean __failed partial result rather than crashing the (fully-paid) run.
  if (!result || typeof result !== 'object') throw new Error('judge returned no structured result (null)')
  // Integrity guard (EV-judge-placeholder.md): reject schema-valid junk (e.g. every field literally "test")
  // BEFORE it is repaired into a plausible-looking shape — retried once by judge()'s existing loop, same
  // path as the null-guard above, so a genuinely dead/junk judge still degrades to a clean __failed partial.
  const integrityIssue = verdictIntegrityIssue(result) || (result.guidance ? guidanceIntegrityIssue(result.guidance) : null)
  if (integrityIssue) throw new Error(`judge verdict failed integrity check: ${integrityIssue}`)
  const set = new Set(labels)
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').charAt(0)
  let ranking = [...new Set((result.ranking || []).map(norm).filter(x => set.has(x)))]
  for (const l of labels) if (!ranking.includes(l)) ranking.push(l)
  let winner = norm(result.winner)
  if (!set.has(winner)) { winner = ranking[0]; log(`judge winner "${result.winner}" did not match a candidate; using top of ranking (${winner})`) }
  return { ...result, winner, ranking }
}

// rotate to decorrelate the blind letter from dispatch order
const blindLabel = (list, rot) => list.map((_, i) => list[(i + rot) % list.length]).map((c, i) => ({ ...c, blind: LABELS[i] }))

// #3: an Opus judge runs AFTER the maximum spend, so never let one judge error crash the whole paid
// run — retry once, then return a failure marker the caller turns into a partial, inspectable result.
//
// Council dispatch (issue #22): when COUNCIL is on (the default), judge() delegates to councilJudge() —
// the 5-lens deliberating council — and returns the SAME shape the legacy single judge returns
// (`{ candidates, ranking, winner, reasoning, guidance? }`), extended with `council` metadata and a
// `no_consensus` flag the call sites route on. `judges: 1` skips this branch entirely, so the legacy
// body below is byte-for-byte today's single blind Opus judge (schema is REVIEW_SCHEMA / RANK_SCHEMA).
async function judge(kind, blindList, guidanceWanted, poolPath, schema, phaseTitle, label, lenses = defaultLensesFor(phaseTitle)) {
  if (COUNCIL) return councilJudge(kind, blindList, guidanceWanted, poolPath, phaseTitle, label, lenses)
  const prompt = judgePrompt(kind, blindList, guidanceWanted, poolPath)
  for (let i = 1; i <= 2; i++) {
    try {
      return reconcile(await agent(prompt, { model: 'opus', schema, phase: phaseTitle, label }), blindList.map(c => c.blind))
    } catch (e) {
      log(`${label} judge attempt ${i}/2 failed: ${String(e).slice(0, 120)}`)
      if (i === 2) return { __failed: String(e).slice(0, 160) }
    }
  }
}

// ==== 5-judge deliberating council (issue #22) ==============================================
// Replaces the single blind Opus judge with 5 blind Opus judges, one lens each. Round 1 is
// independent (no peer visibility); if no >50% majority on a non-vetoed candidate, up to 3
// bounded deliberation rounds follow (each judge sees peers' verbatim verdicts, may run 1-2
// checks, revises). The tally and the veto are DETERMINISTIC CODE below — NO LLM ever aggregates
// votes or "summarises the consensus". Still split after 3 deliberation rounds → NO_CONSENSUS.
//
// The council returns the SAME shape the legacy judge returns — { candidates, ranking, winner,
// reasoning, guidance? } — extended with `council` metadata and a `no_consensus` flag. Call sites
// route on `__failed` (all judges dead) and `no_consensus` (ran but could not resolve).
// CODE lenses — judge an IMPLEMENTATION (rounds 3–4, and any plan-only legacy run). The
// veto lens's key is 'security' (councilTally / the veto machinery key off that literal).
const LENSES = [
  { key: 'correctness', owns: 'does it actually work — run or trace the code, and cite the enrichment (verify/build/lint) exit codes when present', special: 'You are the evidence judge; ground every claim in something you ran or read.' },
  { key: 'spec', owns: 'compliance and completeness — is EVERYTHING that was asked done, and are the stated constraints honoured', special: 'You catch the "works but solved the wrong task" failure.' },
  { key: 'security', owns: 'vulnerabilities, injected execution, secret/credential exposure, supply-chain and build-config risk', special: 'You hold the council VETO.' },
  { key: 'robustness', owns: 'edge cases, failure modes, boundaries, error handling', special: 'Probe what breaks it, not just the happy path.' },
  { key: 'craft', owns: 'readability, structure, maintainability, efficiency', special: 'Judge whether someone else could own this in a year.' },
]

// PLAN lenses — judge a PLAN artifact (rounds 1–2: a concrete, file-level change proposal
// that never touches the repo). Same council engine, a different lens table. The veto lens
// keeps the internal key 'security' (so councilTally / the veto / the security-dead policy
// work UNCHANGED) but is DISPLAYED as 'security-by-design' via `title`. lensPrompt renders
// `title || key`; every logic path (schema selection, tally, safety) still keys off `key`.
const PLAN_LENSES = [
  { key: 'feasibility', owns: 'can this plan actually be built as written — are the named files, APIs, and mechanisms real and reachable, and does each step follow from the last', special: 'You are the reality judge; a plan that cannot be executed as written is worthless however elegant.' },
  { key: 'completeness', owns: 'does the plan cover EVERYTHING the task asked — every requirement, edge case, migration, test, and doc update, with no silent gaps', special: 'You catch the "plans the easy 80%, hand-waves the hard 20%" failure.' },
  { key: 'risk', owns: 'what could go wrong on execution — hidden coupling, breaking changes, data/compat hazards, rollout/ordering risk, and whether the plan names and mitigates them', special: 'Probe the failure modes the plan glosses over, not just the happy path.' },
  { key: 'security', title: 'security-by-design', owns: 'security-by-design: does the plan build in least privilege, input validation, safe secret handling, and a safe execution/supply-chain posture — or does it design in a vulnerability', special: 'You hold the council VETO: veto a plan that designs in a real, evidenced security hazard.' },
  { key: 'simplicity', owns: 'simplicity and proportionality — is the plan the smallest coherent change that solves the task, or does it over-engineer, add needless surface, or gold-plate', special: 'Judge whether the plan is proportionate to the task; reward the simplest approach that is still complete.' },
]

// Lens profiles the council can run under. Default = code lenses (unchanged behaviour).
const LENS_PROFILES = { code: LENSES, plan: PLAN_LENSES }

// Which lens table a judging point uses, chosen by its phase title so the judge() CALL SITES stay
// byte-for-byte (no per-call lens arg needed): the PLAN phase ('Review' = Plan Round 1 review,
// 'Final rank' = Plan Final rank) uses the plan lenses; everything else (the implement rounds and
// any legacy point) uses the code lenses.
function defaultLensesFor(phaseTitle) {
  return (phaseTitle === 'Review' || phaseTitle === 'Final rank') ? PLAN_LENSES : LENSES
}

// Per-lens structured-output schemas. checks_run is REQUIRED on every verdict (the forced-evidence lever).
const LENS_R1_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    candidates: CANDS,
    ranking: { type: 'array', items: { type: 'string' } },
    vote: { type: 'string' },
    reasoning: { type: 'string' },
    checks_run: { type: 'array', items: { type: 'string' } },
  },
  required: ['candidates', 'ranking', 'vote', 'reasoning', 'checks_run'],
}
const SAFETY_ITEM = {
  type: 'object', additionalProperties: false,
  properties: {
    label: { type: 'string' },
    safety: { type: 'string', enum: ['SAFE', 'UNSAFE'] },
    severity: { type: 'string', enum: ['high', 'critical'] }, // present only when UNSAFE
    evidence: { type: 'string' },                              // file + why; required (in prose) for a standing veto
  },
  required: ['label', 'safety'],
}
const SECURITY_R1_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    ...LENS_R1_SCHEMA.properties,
    safety: { type: 'array', items: SAFETY_ITEM },
  },
  required: [...LENS_R1_SCHEMA.required, 'safety'],
}
// Deliberation rounds add the cross-talk fields (response_to_peers + the truthful changed flags).
const DELIB_EXTRA = {
  response_to_peers: { type: 'string' },
  changed_this_round: { type: 'boolean' },
  changed_from_round1: { type: 'boolean' },
}
const DELIB_EXTRA_REQ = ['response_to_peers', 'changed_this_round', 'changed_from_round1']
const LENS_DELIB_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { ...LENS_R1_SCHEMA.properties, ...DELIB_EXTRA },
  required: [...LENS_R1_SCHEMA.required, ...DELIB_EXTRA_REQ],
}
const SECURITY_DELIB_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { ...SECURITY_R1_SCHEMA.properties, ...DELIB_EXTRA },
  required: [...SECURITY_R1_SCHEMA.required, ...DELIB_EXTRA_REQ],
}
// Guidance is distilled by a SEPARATE synthesis call (not a decision-maker) with the same cap/schema/rules.
const GUIDANCE_SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    positives: { type: 'array', maxItems: GUIDANCE_CAP, items: GUIDANCE_ITEM },
    challenges: { type: 'array', maxItems: GUIDANCE_CAP, items: GUIDANCE_ITEM },
  },
  required: ['positives', 'challenges'],
}

// Per-judge reconcile: normalise vote/ranking/safety labels to the real blind-label set (mirrors reconcile()).
function reconcileLens(v, labels) {
  const set = new Set(labels)
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').charAt(0)
  let ranking = [...new Set((v.ranking || []).map(norm).filter(x => set.has(x)))]
  for (const l of labels) if (!ranking.includes(l)) ranking.push(l)
  let vote = norm(v.vote)
  if (!set.has(vote)) vote = ranking[0]
  const out = { ...v, vote, ranking }
  if (Array.isArray(v.safety)) {
    out.safety = v.safety.map(s => ({ ...s, label: norm(s && s.label) })).filter(s => set.has(s.label))
  }
  return out
}

// One lens judge: opus, retry once (like judge()), reconcile. Returns { lens, ...verdict } or null (dead).
async function askLens(lens, blindList, poolPath, phaseTitle, label, roundNum, peerBlock, rot) {
  const labels = blindList.map(c => c.blind)
  const prompt = lensPrompt(lens, blindList, poolPath, roundNum, peerBlock, rot)
  const schema = lens.key === 'security'
    ? (roundNum === 1 ? SECURITY_R1_SCHEMA : SECURITY_DELIB_SCHEMA)
    : (roundNum === 1 ? LENS_R1_SCHEMA : LENS_DELIB_SCHEMA)
  for (let i = 1; i <= 2; i++) {
    try {
      const raw = await agent(prompt, { model: 'opus', schema, phase: phaseTitle, label })
      if (!raw || typeof raw !== 'object') throw new Error('lens judge returned no structured result (null)')
      // Integrity guard (same choke-point as reconcile(), see EV-judge-placeholder.md): covers BOTH round 1
      // and every deliberation round, since askLens() is the single call site for all of them.
      const integrityIssue = verdictIntegrityIssue(raw) || checksRunIssue(raw.checks_run)
      if (integrityIssue) throw new Error(`council lens verdict failed integrity check: ${integrityIssue}`)
      return { lens: lens.key, ...reconcileLens(raw, labels) }
    } catch (e) {
      log(`council ${label} (${lens.key}) attempt ${i}/2 failed: ${String(e).slice(0, 120)}`)
      if (i === 2) return null // dead lens — council recomputes majority over the living
    }
  }
}

// Each judge's candidate LISTING is rotated differently (position-bias control). The shared _pool.md
// order is fixed (advisory caveat), but the dirs listing + the "consider in this order" hint rotate.
function lensPrompt(lens, blindList, poolPath, roundNum, peerBlock, rot) {
  const n = blindList.length
  const rotated = blindList.map((_, i) => blindList[(i + rot) % n])
  const dirs = rotated.map(c => `  Candidate ${c.blind}: ${c.ws}/`).join('\n')
  const letters = rotated.map(c => c.blind).join(', ')
  const securityExtra = lens.key === 'security'
    ? `\n\nYou hold the council's SECURITY VETO. For EVERY candidate also return a \`safety\` entry: {label, safety: "SAFE" | "UNSAFE", severity ("high"|"critical", UNSAFE only), evidence (file + concrete why, UNSAFE only)}. Flag UNSAFE only with EVIDENCE you can point to — a real vulnerability, injected-execution path, secret/credential exposure, or supply-chain/build-config risk. A standing UNSAFE flag (high|critical, with evidence) EXCLUDES that candidate from winning regardless of votes, so do not flag on suspicion alone — but if you are unsure whether something is exploitable, flag it and cite why (fail-closed).`
    : ''
  const delib = roundNum > 1
    ? `\n\nThis is DELIBERATION round ${roundNum - 1} of at most 3. Your peers' latest full verdicts (blind, letters only) are below as verbatim JSON. Read them, address the disagreements in \`response_to_peers\` (convince them or be convinced — converge on the CORRECT call, do not hold a position out of stubbornness), and you MAY run 1-2 targeted checks to settle a factual dispute. Then emit your REVISED verdict and set \`changed_this_round\` / \`changed_from_round1\` truthfully.${lens.key === 'security' ? ' A peer may rebut your veto with evidence; if it genuinely refutes the flag, WITHDRAW it (drop that UNSAFE entry). A flag you still believe stands and keeps excluding the candidate.' : ''}\n\nPEER VERDICTS (JSON, verbatim):\n${peerBlock}`
    : ''
  return `You are a blind judge on a 5-member review COUNCIL. Your lens is **${lens.title || lens.key}**: ${lens.owns}. ${lens.special}
You do NOT know which model produced which candidate; do not speculate. Judge only the work in front of you, through YOUR lens (the other four lenses cover the rest). Apply the shared scoring method: judge the real artifact not any self-summary; score against the task's STATED runtime (treat reliance on a capability the task did not establish as a risk, and treat an unfamiliar but constraint-honouring mechanism as correct unless you can name a concrete way it fails); cite specifics (a line or behaviour, never a vibe).

Task that every candidate was given:
${task}

All candidate deliverables are concatenated, blind-labelled, in ONE file — read it ONCE (each candidate's section is headed "===== Candidate <letter> ====="):
${poolPath}

If (and only if) a candidate is runnable code you want to execute to judge the real output, its individual files are in its own directory (run with a sensible timeout). Consider the candidates in this order — ${letters}:
${dirs}
Do not read any other files.

Return the structured object for YOUR lens: per-candidate pros/cons (through this lens), the full ranking (best first, by candidate letter), your single first-place \`vote\` (one candidate letter), \`reasoning\`, and \`checks_run\` — the commands you ran or files you read, each with its key result (forced evidence; never leave it empty).${securityExtra}${delib}

You are ONE independent voice. Do NOT tally, aggregate, average, or "reach consensus" yourself, and do NOT name an overall council winner — the winner is computed deterministically in code from all five votes plus the veto. Just cast the single most honest first-place vote your lens supports.`
}

// DETERMINISTIC tally — plain code, run after every round. Majority = strictly >50% of LIVING judges'
// first-place votes on a candidate the security lens has NOT flagged UNSAFE (high|critical, with evidence).
function councilTally(verdicts) {
  const living = verdicts.length
  const votes = {}
  for (const v of verdicts) votes[v.vote] = (votes[v.vote] || 0) + 1
  const secV = verdicts.find(v => v.lens === 'security')
  const vetoedSet = new Set()
  if (secV && Array.isArray(secV.safety)) {
    for (const s of secV.safety) {
      if (s && s.safety === 'UNSAFE' && (s.severity === 'high' || s.severity === 'critical')) {
        // Highest-stakes exclusion path: don't let a vacuous-but-schema-valid evidence string stand as a
        // veto (EV-judge-placeholder.md class of failure). A rejected veto does NOT kill the security
        // lens's other votes/ranking — only this one flag is disregarded, so a real veto on another
        // candidate, or the lens's first-place vote, are unaffected.
        const evIssue = vetoEvidenceIssue(s.evidence)
        if (evIssue) log(`council veto on Candidate ${s.label} REJECTED (not standing): ${evIssue} — a vacuous veto must not exclude a real candidate`)
        else vetoedSet.add(s.label)
      }
    }
  }
  const threshold = living / 2 // strict >50%
  let winner = null
  const order = Object.keys(votes).sort((a, b) => (votes[b] - votes[a]) || a.localeCompare(b))
  for (const c of order) { if (votes[c] > threshold && !vetoedSet.has(c)) { winner = c; break } }
  return { living, votes, vetoedSet, vetoed: [...vetoedSet], threshold, winner }
}

// A compact, blind (letters-only) peer block handed to each judge during deliberation.
function councilPeerBlock(peers) {
  const compact = peers.map(v => ({
    lens: v.lens, vote: v.vote, ranking: v.ranking, reasoning: v.reasoning,
    candidates: (v.candidates || []).map(c => ({ label: c.label, pros: c.pros, cons: c.cons })),
    checks_run: v.checks_run || [],
    ...(v.lens === 'security' && Array.isArray(v.safety) ? { safety: v.safety } : {}),
  }))
  return JSON.stringify(compact, null, 2)
}

// Consolidated ranking (bookkeeping for downstream consumers, e.g. 7-FALLBACK's ranked #2) — winner first,
// then remaining by (first-place votes desc, average rank across final verdicts asc, blind label asc). This
// is NOT a consensus override: the winner slot is only ever filled by a majority non-vetoed winner (else null).
function consolidatedRanking(verdicts, labels, winner) {
  const firstVotes = {}, rankSum = {}, rankCount = {}
  for (const l of labels) { firstVotes[l] = 0; rankSum[l] = 0; rankCount[l] = 0 }
  for (const v of verdicts) {
    if (firstVotes[v.vote] != null) firstVotes[v.vote]++
    ;(v.ranking || []).forEach((l, idx) => { if (rankCount[l] != null) { rankSum[l] += idx + 1; rankCount[l]++ } })
  }
  const avgRank = l => rankCount[l] ? rankSum[l] / rankCount[l] : labels.length + 1
  const rest = labels.filter(l => l !== winner)
  rest.sort((a, b) => (firstVotes[b] - firstVotes[a]) || (avgRank(a) - avgRank(b)) || a.localeCompare(b))
  return winner ? [winner, ...rest] : rest
}

// Merge the 5 lenses' pros/cons per candidate into the legacy { label, pros, cons } shape verdictToMd reads.
function mergeCandidates(verdicts, labels) {
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').charAt(0)
  return labels.map(l => {
    const pros = [], cons = []
    for (const v of verdicts) {
      const c = (v.candidates || []).find(x => norm(x.label) === l)
      if (!c) continue
      for (const p of (c.pros || [])) pros.push(`[${v.lens}] ${p}`)
      for (const x of (c.cons || [])) cons.push(`[${v.lens}] ${x}`)
    }
    return { label: l, pros, cons }
  })
}

// Per-round persisted record: living lenses, votes, veto, winner, and each judge's blind verdict.
function roundRecord(round, verdicts, t) {
  return {
    round,
    living: verdicts.map(v => v.lens),
    votes: { ...t.votes },
    vetoed: t.vetoed,
    winner: t.winner,
    verdicts: verdicts.map(v => ({
      lens: v.lens,
      vote: v.vote,
      ranking: v.ranking,
      reasoning: v.reasoning || '',
      checks_run: Array.isArray(v.checks_run) ? v.checks_run : [],
      pros_cons: (v.candidates || []).map(c => ({ label: c.label, pros: c.pros || [], cons: c.cons || [] })),
      changed_this_round: v.changed_this_round === true,
      changed_from_round1: v.changed_from_round1 === true,
      response_to_peers: v.response_to_peers || '',
      ...(v.lens === 'security' && Array.isArray(v.safety) ? { safety: v.safety } : {}),
    })),
  }
}

// Assemble the legacy-shaped result + council metadata. reasoning is CODE-generated (no LLM aggregation).
function buildCouncilResult({ winner, verdicts, roundsLog, labels, no_consensus, humanReason, lenses = LENSES }) {
  const ranking = consolidatedRanking(verdicts, labels, winner)
  const candidates = mergeCandidates(verdicts, labels)
  const t = roundsLog.length ? roundsLog[roundsLog.length - 1] : { votes: {}, living: 0, vetoed: [] }
  const reasoning = no_consensus
    ? `NO_CONSENSUS after ${roundsLog.length} council round(s): ${humanReason}. The deterministic tally never resolved to a >50% non-vetoed majority; routed to human review (a winner is NEVER synthesised or merged by an LLM).`
    : `Council majority: Candidate ${winner} took ${t.votes[winner] || 0}/${t.living} first-place votes (>50%) after ${roundsLog.length} round(s)` +
      `${t.vetoed.length ? `; security veto standing on ${t.vetoed.join(', ')}` : '; no standing security veto'}.`
  const council = {
    lenses: lenses.map(l => l.title || l.key),
    rounds_used: roundsLog.length,
    rounds: roundsLog,
    vote_evolution: roundsLog.map(r => ({ round: r.round, votes: r.votes, vetoed: r.vetoed, winner: r.winner, living: r.living })),
    veto_events: t.vetoed,
    final_living: t.living,
    no_consensus: !!no_consensus,
    ...(no_consensus ? { human_reason: humanReason } : {}),
  }
  return { candidates, ranking, winner: no_consensus ? null : winner, reasoning, council, no_consensus: !!no_consensus }
}

// A SEPARATE synthesis call — explicitly NOT a decision-maker and NOT a vote-aggregator. It distils generic
// round-2 guidance from the council's final verdicts under the same GUIDANCE_CAP, schema and blind rules as
// the legacy single-judge guidance. It never picks or changes a winner.
async function synthesizeGuidance(verdicts, phaseTitle, label) {
  const block = JSON.stringify(verdicts.map(v => ({
    lens: v.lens, reasoning: v.reasoning,
    candidates: (v.candidates || []).map(c => ({ label: c.label, pros: c.pros, cons: c.cons })),
  })), null, 2)
  const prompt = `You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).`
  for (let i = 1; i <= 2; i++) {
    try {
      const g = await agent(prompt, { model: 'opus', schema: GUIDANCE_SYNTH_SCHEMA, phase: phaseTitle, label })
      if (g && typeof g === 'object' && Array.isArray(g.positives) && Array.isArray(g.challenges)) {
        // Integrity guard (same choke-point family as reconcile()/askLens()): reject schema-valid junk
        // guidance (e.g. every item literally {text:"a", why:"b"}) before it steers a fresh round-2.
        const integrityIssue = guidanceIntegrityIssue(g)
        if (integrityIssue) throw new Error(`guidance synthesis failed integrity check: ${integrityIssue}`)
        return g
      }
      throw new Error('guidance synthesis returned a malformed result')
    } catch (e) {
      log(`council guidance synthesis attempt ${i}/2 failed: ${String(e).slice(0, 120)}`)
      if (i === 2) return { positives: [], challenges: [] } // never crash a fully-paid run for missing guidance
    }
  }
}

// The orchestrator judge() delegates to. Independent round 1 → bounded deliberation → deterministic tally.
async function councilJudge(kind, blindList, guidanceWanted, poolPath, phaseTitle, label, lenses = LENSES) {
  const labels = blindList.map(c => c.blind)
  const roundsLog = []

  // Round 1 — 5 independent verdicts, no peer visibility. Each lens gets a differently-rotated listing.
  const r1raw = await parallel(lenses.map((lens, i) => () =>
    askLens(lens, blindList, poolPath, phaseTitle, `${label}-${lens.key}-r1`, 1, null, i)))
  let verdicts = r1raw.filter(Boolean)
  if (!verdicts.length) {
    log(`council ${label}: ALL 5 lenses died in round 1 — degrading to a __failed partial (caller lands a partial run).`)
    return { __failed: 'all council judges failed in round 1' }
  }

  // Security-judge death policy: repoMode = fail-closed (unresolvable veto → NO_CONSENSUS/needs-human);
  // isolated run = proceed, but LOUD warning that veto coverage was lost.
  const securityDeadHalt = () => {
    const tt = councilTally(verdicts)
    roundsLog.push(roundRecord(roundsLog.length + 1, verdicts, tt))
    return buildCouncilResult({ winner: null, verdicts, roundsLog, labels, lenses, no_consensus: true,
      humanReason: 'security judge unavailable in repo mode — veto coverage lost (fail-closed)' })
  }
  if (!verdicts.some(v => v.lens === 'security')) {
    if (repoMode) {
      log(`council ${label}: SECURITY lens dead in repoMode — veto coverage unresolvable; failing closed to NO_CONSENSUS (needs-human + HALT).`)
      return securityDeadHalt()
    }
    log(`JE-COUNCIL-WARNING [${phaseTitle}]: security lens dead — veto coverage LOST for this isolated run; the council proceeds WITHOUT a security veto.`)
  }

  let t = councilTally(verdicts)
  roundsLog.push(roundRecord(1, verdicts, t))
  let winner = t.winner
  const allVetoed = () => labels.length > 0 && labels.every(l => t.vetoedSet.has(l))

  // Bounded deliberation: max 3 rounds. Stop early on a majority or when every candidate is vetoed.
  for (let d = 1; d <= 3 && winner == null && !allVetoed(); d++) {
    const roundNum = d + 1
    const prev = verdicts
    const delibRaw = await parallel(prev.map(pv => () => {
      const lens = lenses.find(l => l.key === pv.lens)
      const rot = lenses.findIndex(l => l.key === pv.lens)
      const peerBlock = councilPeerBlock(prev.filter(v => v.lens !== pv.lens))
      return askLens(lens, blindList, poolPath, phaseTitle, `${label}-${pv.lens}-r${roundNum}`, roundNum, peerBlock, rot)
    }))
    const next = delibRaw.filter(Boolean)
    if (!next.length) { log(`council ${label}: all living lenses died in deliberation round ${d}; ending deliberation on the prior round's verdicts.`); break }
    verdicts = next
    if (!verdicts.some(v => v.lens === 'security') && repoMode) {
      log(`council ${label}: SECURITY lens lost during deliberation in repoMode — failing closed to NO_CONSENSUS (needs-human + HALT).`)
      return securityDeadHalt()
    }
    t = councilTally(verdicts)
    roundsLog.push(roundRecord(roundNum, verdicts, t))
    winner = t.winner
  }

  if (winner != null) {
    const result = buildCouncilResult({ winner, verdicts, roundsLog, labels, lenses, no_consensus: false })
    if (guidanceWanted) result.guidance = await synthesizeGuidance(verdicts, phaseTitle, `${label}-guidance`)
    return result
  }
  // Still split after the bounded deliberation (or every candidate vetoed) → NO_CONSENSUS. Never resolved
  // by Borda or a meta-judge; routed to human review by the call site.
  const reason = allVetoed() ? 'all candidates were vetoed UNSAFE by the security lens' : 'no candidate reached a >50% majority after 3 deliberation rounds'
  log(`council ${label}: NO_CONSENSUS — ${reason}.`)
  return buildCouncilResult({ winner: null, verdicts, roundsLog, labels, lenses, no_consensus: true, humanReason: reason })
}

// Render the council's deliberation for the verdict.md report (per-round tally + per-judge verdicts + vetoes).
function councilToMd(council) {
  if (!council) return ''
  const L = ['## Council deliberation', '',
    `**Lenses:** ${(council.lenses || []).join(', ')}  •  **Rounds used:** ${council.rounds_used}  •  **Living at final tally:** ${council.final_living}`,
    council.no_consensus ? `**Result:** NO_CONSENSUS${council.human_reason ? ` — ${council.human_reason}` : ''}` : '', '']
  L.push('### Vote evolution', '', '| Round | Votes (candidate:count) | Veto | Round winner |', '|---|---|---|---|')
  for (const r of (council.vote_evolution || [])) {
    const votes = Object.keys(r.votes || {}).sort().map(k => `${k}:${r.votes[k]}`).join(', ') || '_(none)_'
    L.push(`| ${r.round} | ${votes} | ${(r.vetoed || []).join(', ') || '—'} | ${r.winner || '—'} |`)
  }
  L.push('')
  for (const r of (council.rounds || [])) {
    L.push(`### Round ${r.round} verdicts`, '')
    for (const v of (r.verdicts || [])) {
      L.push(`**${v.lens}** — vote Candidate ${v.vote}; ranking ${(v.ranking || []).map(x => `Candidate ${x}`).join(' > ')}${v.changed_this_round ? ' _(changed this round)_' : ''}`)
      if (v.reasoning) L.push(`- ${v.reasoning}`)
      for (const s of (v.safety || [])) if (s.safety === 'UNSAFE') L.push(`- VETO Candidate ${s.label} (${s.severity || '?'}): ${s.evidence || '_(no evidence)_'}`)
      if (v.response_to_peers) L.push(`- to peers: ${v.response_to_peers}`)
      L.push('')
    }
  }
  return L.join('\n') + '\n'
}

// Compact council line for the run SUMMARY (blind-safe: letters only, no model identity). The full
// per-judge deliberation lives in verdict.md (councilToMd); the summary shows just the outcome shape.
function councilTallyMd(council) {
  if (!council) return ''
  const last = (council.vote_evolution || [])[(council.vote_evolution || []).length - 1]
  const votes = last ? (Object.keys(last.votes || {}).sort().map(k => `${k}:${last.votes[k]}`).join(', ') || 'none') : 'none'
  const veto = last && last.vetoed && last.vetoed.length ? ` • veto: ${last.vetoed.join(', ')}` : ''
  const outcome = council.no_consensus ? `NO_CONSENSUS (${council.human_reason || 'unresolved split'})` : 'majority reached'
  return `**Council:** ${council.rounds_used} round(s), ${council.final_living} judge(s) at final tally • final votes ${votes}${veto} • ${outcome}`
}

// ---- durable persistence (sandbox has NO node:fs/import/process — write via haiku+Bash, like buildContext) ----
const json = obj => JSON.stringify(obj, null, 2) + '\n'

// Write one persistence point. Each file is written by its OWN small command (atomic .partial -> mv)
// and the agent reports `wc -c` per FINAL path via PERSIST_SCHEMA. We VERIFY every target exists and
// is non-empty from that structured byte count (never the agent's free text); any miss is RETRIED
// ONCE in a second agent call, and a still-missing target is logged as a REAL, path-named failure.
// An unverified LLM write is NEVER treated as success (#D-0002). Still fire-and-forget overall: a
// persist failure logs but must never crash a fully-paid run.
async function persist(pairs, phaseTitle) {
  const files = (pairs || []).filter(p => p && p.path && p.content != null)
  if (!files.length) return
  // One write+measure step per file: atomic .partial -> mv, then emit the FINAL path's byte count.
  const stepFor = ({ path, content }) => {
    const dir = path.slice(0, path.lastIndexOf('/'))
    const tmp = `${path}.partial`
    return `mkdir -p ${q(dir)} && printf '%s' ${q(content)} > ${q(tmp)} && mv -f ${q(tmp)} ${q(path)}; ` +
           `printf 'FLP %s %s\\n' ${q(path)} "$(wc -c < ${q(path)} 2>/dev/null || echo 0)"`
  }
  // Run the given file list through the write-agent; return a map path -> bytes (0 if unreported).
  const writeAndMeasure = async (list) => {
    const script = list.map(stepFor).join('\n')
    const res = await agent(
      `This is an approved internal step of the joust-engine tournament: persist result artifacts. ` +
      `Run this exact shell script in ONE Bash call. It prints one line per file of the form ` +
      `"FLP <path> <byte-count>". Then return the structured results: for EACH printed FLP line, an ` +
      `entry {path: the path, bytes: the integer byte-count}. Report exactly what the script printed — ` +
      `do not infer or change values. Do nothing else:\n\n${script}`,
      { model: 'haiku', schema: PERSIST_SCHEMA, phase: phaseTitle, label: 'persist' }
    ).catch(() => null)
    const seen = {}
    for (const r of (res && Array.isArray(res.results) ? res.results : [])) {
      if (r && r.path) seen[String(r.path)] = Number(r.bytes) || 0
    }
    return seen
  }
  try {
    let seen = await writeAndMeasure(files)
    let missing = files.filter(f => !(seen[f.path] > 0))
    if (missing.length) {                          // verified miss -> retry ONLY the misses, once
      log(`persist (${phaseTitle}): ${missing.length} file(s) unverified, retrying once: ${missing.map(f => f.path).join(', ')}`)
      const seen2 = await writeAndMeasure(missing)
      seen = { ...seen, ...seen2 }
      missing = files.filter(f => !(seen[f.path] > 0))
    }
    if (missing.length) log(`persist FAILED (${phaseTitle}): ${missing.map(f => f.path).join(', ')} still missing/empty after retry`)
  } catch (e) { log(`persist failed (${phaseTitle}): ${String(e).slice(0, 140)}`) }
}

// genericise a failReason for the BLIND summary so a provider-specific failure can't re-identify a model
const blindFail = r => r ? 'excluded (did not pass validation)' : r

// verdict object (blind, letters only): { candidates:[{label,pros,cons}], ranking, winner, reasoning, guidance? }
function verdictToMd(v, title) {
  // Council NO_CONSENSUS carries winner:null — render it as a HALT banner, never a fake "Candidate ".
  const winnerLine = (v.no_consensus || !v.winner) ? '**Winner:** NO CONSENSUS (routed to human review)' : `**Winner:** Candidate ${v.winner}`
  const L = [`# ${title}`, '', winnerLine, '',
    `**Ranking (best first):** ${(v.ranking || []).map(r => `Candidate ${r}`).join(' > ')}`, '',
    '## Reasoning', '', v.reasoning || '_(none given)_', '', '## Per-candidate', '']
  for (const c of (v.candidates || [])) {
    L.push(`### Candidate ${c.label}`, '', '**Pros**')
    for (const p of (c.pros || [])) L.push(`- ${p}`)
    if (!(c.pros || []).length) L.push('- _(none)_')
    L.push('', '**Cons**')
    for (const x of (c.cons || [])) L.push(`- ${x}`)
    if (!(c.cons || []).length) L.push('- _(none)_')
    L.push('')
  }
  // Council metadata (per-round tally + per-judge verdicts + veto events). Absent on the legacy judges:1 path.
  if (v.council) L.push(councilToMd(v.council))
  return L.join('\n') + '\n'
}

function guidanceToMd(g) {
  const pos = ((g && g.positives) || []).slice(0, GUIDANCE_CAP)   // render-side cap, same as brief()
  const ch = ((g && g.challenges) || []).slice(0, GUIDANCE_CAP)
  const L = ['# Round-1 guidance (fallible priors used to steer round 2)', '',
    '_Tagged [strong] (corroborated this round) or [tentative] (single sighting / speculative). Round-2 attempts weigh these as priors, not commands._', '',
    '## Positives to consider']
  for (const p of pos) L.push(priorLine(p))
  if (!pos.length) L.push('- _(none)_')
  L.push('', '## Challenges to avoid')
  for (const c of ch) L.push(priorLine(c))
  if (!ch.length) L.push('- _(none)_')
  return L.join('\n') + '\n'
}

// SUMMARY renderer. unblind=true => show models; false => letters only + genericised failReasons.
// Join on the candidate LETTER, never on model (models repeat in Mixed presets like '2 opus').
function summaryMd({ task, mode, n, unblind, r1mapping, r1review, finalMapping, finalRank, winnerRound }) {
  const L = [`# Joust Engine — run summary${unblind ? '' : ' (BLIND)'}`, '',
    `**Mode:** ${mode === 'two' ? 'two-pass' : 'single-pass'}  •  **N (attempts/round):** ${n}`, '',
    '## Task', '', '> ' + String(task).replace(/\n/g, '\n> '), '',
    '## Round-1 candidates', '',
    unblind ? '| Candidate | Model | Valid | Note |' : '| Candidate | Valid | Note |',
    unblind ? '|---|---|---|---|' : '|---|---|---|']
  for (const m of (r1mapping || [])) {
    const note = m.valid ? '' : (unblind ? (m.failReason || '') : blindFail(m.failReason || 'excluded'))
    L.push(unblind ? `| ${m.candidate} | ${m.model} | ${m.valid ? 'yes' : 'NO'} | ${note} |`
                   : `| ${m.candidate} | ${m.valid ? 'yes' : 'NO'} | ${note} |`)
  }
  L.push('')
  if (r1review && !r1review.__failed) {
    const r1join = letter => {
      const m = (r1mapping || []).find(x => x.candidate === letter)
      return unblind && m ? `Candidate ${letter} (${m.model})` : `Candidate ${letter}`
    }
    const r1winnerLine = (r1review.no_consensus || !r1review.winner) ? 'NO CONSENSUS (routed to human review)' : r1join(r1review.winner)
    L.push(mode === 'two' ? '## Round-1 review verdict' : '## Verdict', '',
      `**${mode === 'two' ? 'Round-1 ' : ''}Winner:** ${r1winnerLine}`, '',
      `**Ranking:** ${(r1review.ranking || []).map(r1join).join(' > ')}`, '')
    if (r1review.council) L.push(councilTallyMd(r1review.council), '')
  }
  if (mode === 'two' && finalMapping) {
    L.push('## Final candidates', '',
      unblind ? '| Candidate | Model | From round | Valid | Note |' : '| Candidate | From round | Valid | Note |',
      unblind ? '|---|---|---|---|---|' : '|---|---|---|---|')
    for (const m of finalMapping) {
      const note = m.valid ? '' : (unblind ? (m.failReason || '') : blindFail(m.failReason || 'excluded'))
      L.push(unblind ? `| ${m.candidate} | ${m.model} | ${m.round} | ${m.valid ? 'yes' : 'NO'} | ${note} |`
                     : `| ${m.candidate} | ${m.round} | ${m.valid ? 'yes' : 'NO'} | ${note} |`)
    }
    L.push('')
    if (finalRank && !finalRank.__failed) {
      const fjoin = letter => {
        const m = finalMapping.find(x => x.candidate === letter)
        return unblind && m ? `Candidate ${letter} (${m.model})` : `Candidate ${letter}`
      }
      const wm = finalMapping.find(x => x.candidate === finalRank.winner)
      const overallLine = (finalRank.no_consensus || !finalRank.winner) ? 'NO CONSENSUS (routed to human review)' : fjoin(finalRank.winner)
      L.push('## Overall winner', '', `**Winner:** ${overallLine}`)
      if (wm) L.push(`**Came from round:** ${wm.round}`)
      else if (winnerRound != null) L.push(`**Came from round:** ${winnerRound}`)
      L.push('', `**Final ranking:** ${(finalRank.ranking || []).map(fjoin).join(' > ')}`, '')
      if (finalRank.council) L.push(councilTallyMd(finalRank.council), '')
    }
  }
  return L.join('\n') + '\n'
}

// ---- begin: contribution estimation (PURE; persistence is a separate thin step) ----
// ESTIMATE — per-model attribution is a HEURISTIC, not ground truth. Intentionally
// forward-improvable. Algorithm: see proposal.md / the comment on computeContributions.
// Persistence is a thin `persist()` call elsewhere in this file; this block is pure
// (data in, data out — no I/O, no globals, no module side-effects).
//
// Single named knobs (all in one place so a future revision can swap them out cleanly):
//   CONTRIB_RANK_DECAY   — per-rank weight function (super-linear so the winning model
//                          stays dominant over a rival that fields several mid-rank finalists).
//   CONTRIB_WINNER_BONUS — additive winner emphasis in the CODE channel (ensures the
//                          winning model gets the dominant share, the acceptance criterion
//                          the issue calls out).
//   CONTRIB_GUIDANCE_SHARE — fraction of the FINAL total allocated to the round-1
//                          guidance channel in two-pass (round-2 outputs were shaped by
//                          round-1 priors, so round-1 models deserve partial credit even
//                          though their code was discarded).
const CONTRIB_RANK_DECAY = (K, pos) => Math.pow(2, K - pos) // K = #ranked valid cands, pos 1-indexed
const CONTRIB_WINNER_BONUS = 1.0                            // additive; in weight units
const CONTRIB_GUIDANCE_SHARE = 0.30                        // 30% to round-1 guidance (two-pass only)

// ESTIMATE — returns [{ model, pct, detail }] with pcts summing to exactly 100.
// Returns [] (never throws) when no valid candidate or no verdict exists.
function computeContributions(round1, guidance, final, mode) {
  // Channel 1 (code): final ranking in two-pass, round-1 ranking in single-pass.
  const codeReview = (mode === 'two' && final && final.rank && !final.rank.__failed)
    ? final.rank
    : (round1 && round1.review && !round1.review.__failed ? round1.review : null)
  const codeMapping = (mode === 'two' && final && Array.isArray(final.mapping))
    ? final.mapping
    : (round1 && Array.isArray(round1.mapping) ? round1.mapping : null)
  if (!codeReview || !codeMapping) return []
  const codeWeights = weightsFor(codeMapping, codeReview, CONTRIB_RANK_DECAY, CONTRIB_WINNER_BONUS)
  if (!codeWeights.size) return []

  // Channel 2 (guidance): round-1 ranking, only in two-pass with a valid round-1 verdict.
  const guideReview = (mode === 'two' && guidance && round1 && round1.review && !round1.review.__failed)
    ? round1.review : null
  const guideMapping = (round1 && Array.isArray(round1.mapping)) ? round1.mapping : null
  const guideWeights = (guideReview && guideMapping)
    ? weightsFor(guideMapping, guideReview, CONTRIB_RANK_DECAY, 0) // no winner bonus on guidance
    : new Map()

  // Combine: code = (1 - share), guidance = share. share=0 in single-pass (no guidance channel).
  const share = (mode === 'two' && guideWeights.size > 0) ? CONTRIB_GUIDANCE_SHARE : 0
  const combined = new Map()
  for (const [m, w] of codeWeights)  combined.set(m, (combined.get(m) || 0) + w * (1 - share))
  for (const [m, w] of guideWeights) combined.set(m, (combined.get(m) || 0) + w * share)

  return largestRemainderRound(combined, share)
}

// Internal: rank-based weights per model, summing repeated candidates of the same model.
// Filters out valid:false candidates BEFORE weighting, so failed attempts contribute 0 by
// construction (and never appear in the output).
function weightsFor(mapping, review, decayFn, winnerBonus) {
  const byCandidate = new Map()
  for (const m of (mapping || [])) byCandidate.set(m.candidate, m)
  const validLetters = (review.ranking || []).filter(l => {
    const m = byCandidate.get(l); return m && m.valid !== false
  })
  if (!validLetters.length) return new Map()
  const K = validLetters.length
  const w = new Map()
  validLetters.forEach((letter, i) => {
    const m = byCandidate.get(letter); if (!m || !m.model) return
    const ww = decayFn(K, i + 1) + (i === 0 ? winnerBonus : 0) // bonus on the FIRST-ranked valid cand only
    w.set(m.model, (w.get(m.model) || 0) + ww)
  })
  return w
}

// Internal: sum of all values in a Map.
function contribSumValues(map) { let s = 0; for (const v of map.values()) s += v; return s }

// Internal: normalize a Map<model, rawWeight> to pcts summing to EXACTLY 100 via
// largest-remainder rounding (drift is given to the LARGEST shares, one unit each, until
// the sum is exactly 100). Returns [] if the total is non-positive.
function largestRemainderRound(combined, share) {
  const total = contribSumValues(combined)
  if (!isFinite(total) || total <= 0) return []
  const scaled = [...combined.entries()].map(([m, w]) => [m, (w / total) * 100])
  const rows = scaled.map(([m, v]) => ({ m, f: Math.floor(v), r: v - Math.floor(v) }))
  const assigned = rows.reduce((s, x) => s + x.f, 0)
  const drift = 100 - assigned
  // Sort by remainder DESC; ties broken by raw weight DESC (largest model first) so the
  // drift goes to the model that already has the largest share — i.e. the winning model
  // is the FIRST place any rounding drift lands. Stable sort; no random tie-break.
  const ordered = [...rows].sort((a, b) => (b.r - a.r) || (b.f + b.r) - (a.f + a.r))
  for (let i = 0; i < drift && i < ordered.length; i++) ordered[i].f += 1
  const detailTwo = share > 0
    ? `${Math.round(share * 100)}% guidance-channel credit from round-1 models; `
    : ''
  return ordered
    .filter(x => x.f > 0) // drop zero-share models (the rounding pass can produce 0 for negligible weights)
    .map(({ m, f }) => ({
      model: m,
      pct: f,
      detail: `ESTIMATE — rank-decay 2^(K-pos) + winner-bonus ${CONTRIB_WINNER_BONUS}; ${detailTwo}see workflows/tournament.mjs (computeContributions) for the exact formula`,
    }))
    .sort((a, b) => b.pct - a.pct) // largest first — the report's natural reading order
}
// ---- end: contribution estimation (PURE; persistence is a separate thin step) ----

// ================= IMPLEMENT PHASE (Rounds 3–4) — only with args.implement =====================
// The plan phase (Rounds 1–2, above) resolves a WINNING PLAN. When implement is on, that plan is
// bundled verbatim and handed to a small strong implement pool. Round 3 always runs; Round 4 runs
// ONLY if Round 3 produced no gate-passing candidate. Judged by the 5-lens CODE council.

// Bundle the winning plan's staged deliverable(s) into ONE seed file the implementers read.
async function bundlePlan(planWs, seedPath) {
  const dir = seedPath.slice(0, seedPath.lastIndexOf('/'))
  const cmd = `mkdir -p ${q(dir)} && { echo "===== APPROVED PLAN (implement this verbatim) ====="; find ${q(planWs)} -type f 2>/dev/null | sort | while IFS= read -r f; do printf '\\n----- %s -----\\n' "$f"; cat "$f" 2>/dev/null; done; } > ${q(seedPath)} && wc -c ${q(seedPath)}`
  log(`Bundling winning plan → ${seedPath}`)
  await agent(`Run this exact shell command in ONE Bash call and report its stdout. Do nothing else:\n\n${cmd}`,
    { model: 'haiku', phase: 'Implement Round 3', label: 'seed-plan' }).catch(() => null)
}

// A round's gate: an adoptable candidate exists iff the CODE council reached a non-vetoed majority
// winner (not __failed / not NO_CONSENSUS) that is a VALID candidate. In repoMode the verify/build/
// lint (and, at the driver level, the security audit) evidence is folded into that council via the
// enriched blind pool — so this reuses the grand-loop gate(candidate) spirit (verify AND audit).
function implGatePassed(r) {
  const rv = r && r.review
  if (!rv || rv.__failed) return { pass: false, reason: 'no code-council verdict', winner: null }
  if (rv.no_consensus || !rv.winner) return { pass: false, reason: 'code council NO_CONSENSUS / all vetoed', winner: null }
  const w = (r.blind || []).find(c => c.blind === rv.winner)
  if (!w) return { pass: false, reason: 'council winner not among valid candidates', winner: null }
  return { pass: true, reason: 'code-council majority on a valid, non-vetoed candidate', winner: rv.winner }
}

// Run ONE implement round: dispatch the implement pool seeded with the plan, stage, enrich, and
// judge with the CODE lenses. `wantGuidance` distils round-3 → round-4 priors (round 3 only).
async function implementRound(roundName, phaseTitle, rot, seedPlanPath, guidance, reviewDir, wantGuidance) {
  const list = implementAttempts.map(a => ({ ...a, roundName, ws: repoMode ? worktreePath(roundName, a.label) : scratchPath(roundName, a.label) }))
  await buildWorktrees(roundName, list)
  const doneRaw = (await parallel(list.map(a => () => dispatch(a, a.ws, guidance, phaseTitle, 'implement', seedPlanPath)))).filter(Boolean)
  const done = doneRaw.map(c => ({ ...c, roundName }))
  { const w = dispatchDropSummary(phaseTitle, dispatchDrops, list.length, done.length); if (w) log(w) }
  await snapshotWorktrees(roundName, done)
  if (!done.length) return { blind: [], mapping: [], review: { __failed: 'no implement attempts survived dispatch' } }
  const staged = await stageAndValidate(blindLabel(done, rot), reviewDir, phaseTitle)
  const blind = staged.filter(c => c.valid)
  const mapping = staged.map(c => ({ candidate: c.blind, model: c.displayModel, valid: c.valid, ...(c.valid ? {} : { failReason: c.failReason }) }))
  if (!blind.length) return { blind, mapping, review: { __failed: 'no valid implement deliverables' } }
  if (repoMode) await enrichBlindPool(blind, reviewDir, phaseTitle)
  const review = await judge('code reviewer', blind, wantGuidance, `${reviewDir}/_pool.md`,
    wantGuidance ? REVIEW_SCHEMA : RANK_SCHEMA, phaseTitle, `${roundName}-review`, LENSES)
  return { blind, mapping, review }
}

// The implement phase driver. Round 3 always; Round 4 ONLY on a failed R3 gate (guided by R3 review).
async function implementPhase(seedPlanPath) {
  phase('Implement Round 3')
  log(`Implement Round 3: ${implementAttempts.length} implementer(s) seeded with the winning plan (${implementAttempts.map(a => a.displayModel).join(', ')})`)
  const r3 = await implementRound('impl-3', 'Implement Round 3', 3, seedPlanPath, null, `${runDir}/review-impl-3`, true)
  await persist([
    ...(r3.review && !r3.review.__failed ? [{ path: `${runDir}/review-impl-3/verdict.md`, content: verdictToMd(r3.review, 'Implement Round 3 verdict') }] : []),
    ...(r3.review && r3.review.council ? [{ path: `${runDir}/review-impl-3/council.json`, content: json(r3.review.council) }] : []),
  ], 'Implement Round 3')
  const g3 = implGatePassed(r3)
  if (g3.pass) {
    return { rounds: 3, round3: { mapping: r3.mapping, review: r3.review }, winner: g3.winner, winnerRound: 3, no_consensus: false, needs_human: false }
  }
  // R4 exists ONLY as the guided retry: R3 produced no gate-passing candidate (verify fail /
  // council NO_CONSENSUS / all vetoed). A plan-phase NO_CONSENSUS never reaches here — it was
  // surfaced before any implement spend.
  log(`Implement Round 3 gate NOT passed (${g3.reason}); escalating to Implement Round 4 (guided retry).`)
  phase('Implement Round 4')
  const guidance = (r3.review && r3.review.guidance) || null
  const r4 = await implementRound('impl-4', 'Implement Round 4', 4, seedPlanPath, guidance, `${runDir}/review-impl-4`, false)
  await persist([
    ...(r4.review && !r4.review.__failed ? [{ path: `${runDir}/review-impl-4/verdict.md`, content: verdictToMd(r4.review, 'Implement Round 4 verdict') }] : []),
    ...(r4.review && r4.review.council ? [{ path: `${runDir}/review-impl-4/council.json`, content: json(r4.review.council) }] : []),
  ], 'Implement Round 4')
  const g4 = implGatePassed(r4)
  return {
    rounds: 4,
    round3: { mapping: r3.mapping, review: r3.review },
    round4: { mapping: r4.mapping, review: r4.review },
    winner: g4.pass ? g4.winner : null,
    winnerRound: g4.pass ? 4 : null,
    no_consensus: !!(r4.review && r4.review.no_consensus),
    needs_human: !g4.pass, // R4 also failed the gate → needs-human (existing contract)
  }
}

// ---- Round 1 ----
phase('Round 1')
log(`▶ ${deriveSummary()}`) // issue #38: run-purpose summary as the first narrator line (above the progress tree)
await buildContext() // shared context bundle (no-op unless args.contextFiles given) — built once, before the attempts
const r1Worktrees = attempts.map(a => ({ ...a, ws: repoMode ? worktreePath('round-1', a.label) : scratchPath('round-1', a.label) }))
await buildWorktrees('round-1', r1Worktrees) // repoMode-only no-op otherwise
log(`Round 1: ${attempts.length} attempts (${attempts.map(a => a.displayModel).join(', ')})`)
const r1 = (await parallel(r1Worktrees.map(a => () => dispatch(a, a.ws, null, 'Round 1')))).filter(Boolean)
{ const w = dispatchDropSummary('Round 1', dispatchDrops, r1Worktrees.length, r1.length); if (w) log(w) } // #45
if (!r1.length) {
  const unreg = [...new Set(dispatchDrops.filter(d => d.phase === 'Round 1').map(d => d.agentType))]
  return { error: unreg.length
    ? `all round-1 attempts failed: required agent type(s) NOT REGISTERED (${unreg.join(', ')}). Restart the session to register newly-installed plugin agents, then re-run.`
    : 'all round-1 attempts failed (dispatch errors)' }
}
await snapshotWorktrees('round-1', r1) // repoMode-only no-op otherwise

phase('Review')
const staged1 = await stageAndValidate(blindLabel(r1, 1), `${runDir}/review-1`, 'Review')
const blind1 = staged1.filter(c => c.valid)
const r1mapping = staged1.map(c => ({ candidate: c.blind, model: c.displayModel, valid: c.valid, ...(c.valid ? {} : { failReason: c.failReason }) }))
const N = attempts.length
if (!blind1.length) {
  // P0: no valid round-1 pool — still land the key + summaries
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: null, ...(mode === 'two' ? { winner: null } : {}) }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ task, mode, n: N, unblind: true, r1mapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping }) },
  ], 'Review')
  return { mode, n: N, error: 'no valid round-1 deliverables', round1: { mapping: r1mapping } }
}

if (repoMode) await enrichBlindPool(blind1, `${runDir}/review-1`, 'Review')

// Plan Round 1 review — judged by the PLAN-lens council (feasibility/completeness/risk/
// security-by-design/simplicity), selected by phaseTitle inside judge(). Plans never touch the repo.
const review = await judge('reviewer', blind1, mode === 'two', `${runDir}/review-1/_pool.md`,
  mode === 'two' ? REVIEW_SCHEMA : RANK_SCHEMA, 'Review', 'review')
if (review.__failed) {
  // P1: review judge failed — land the key + summaries (no verdict exists)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: null, ...(mode === 'two' ? { winner: null } : {}) }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ task, mode, n: N, unblind: true, r1mapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping }) },
  ], 'Review')
  return { mode, n: N, round1: { mapping: r1mapping }, error: `review judge failed: ${review.__failed}` }
}

if (review.no_consensus) {
  // P1b (council): the council ran but could NOT reach a >50% non-vetoed majority. NO_CONSENSUS is
  // terminal — never silently resolved by Borda/meta-judge and never carried into round 2. Persist the
  // full split (per-judge verdicts + vote evolution + veto events) so an interactive run can surface it
  // and a grand loop routes this loop to needs-human + HALT (winner:null in mapping.json is the signal).
  log(`Review: council NO_CONSENSUS — ${review.reasoning}`)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: null, no_consensus: true, ...(mode === 'two' ? { winner: null } : {}) }) },
    { path: `${runDir}/review-1/verdict.json`, content: json(review) },
    { path: `${runDir}/review-1/verdict.md`, content: verdictToMd(review, 'Round-1 review verdict (NO CONSENSUS)') },
    { path: `${runDir}/review-1/council.json`, content: json(review.council) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ task, mode, n: N, unblind: true, r1mapping, r1review: review }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review }) },
  ], 'Review')
  return { mode, n: N, round1: { mapping: r1mapping, review }, no_consensus: true, council: review.council, error: `NO_CONSENSUS at review: ${review.reasoning}` }
}

// P2: round-1 review is valid — incremental write BEFORE any round-2 dispatch (crash-survival linchpin)
await persist([
  { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: review.winner }) },
  { path: `${runDir}/review-1/verdict.json`, content: json(review) },
  { path: `${runDir}/review-1/verdict.md`, content: verdictToMd(review, 'Round-1 review verdict') },
  ...(review.council ? [{ path: `${runDir}/review-1/council.json`, content: json(review.council) }] : []),
  ...(review.guidance ? [{ path: `${runDir}/review-1/guidance.md`, content: guidanceToMd(review.guidance) }] : []),
], 'Review')

if (mode === 'single') {
  // P3: single-pass — mapping/verdict already written at P2; add the summaries
  const contributions = computeContributions({ mapping: r1mapping, review }, null, null, mode)
  await persist([
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ task, mode, n: N, unblind: true, r1mapping, r1review: review }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review }) },
    { path: `${runDir}/contributions.json`, content: json({ note: 'ESTIMATE — per-model attribution is a HEURISTIC, not ground truth. See workflows/tournament.mjs (computeContributions) for the exact formula. Forward-improvable.', mode, contributions }) },
  ], 'Review')
  return { mode, n: N, round1: { mapping: r1mapping, review }, contributions }
}

// ---- Two pass ----
const winner1 = blind1.find(c => c.blind === review.winner)
if (!winner1) log(`round-1 winner "${review.winner}" not among valid candidates; carrying the first valid (${blind1[0].blind})`) // #8
const champ = winner1 || blind1[0]
phase('Round 2')
log(`Round 2: ${attempts.length} guided attempts; carrying over round-1 winner (${champ.displayModel})`)
const r2Worktrees = attempts.map(a => ({ ...a, ws: repoMode ? worktreePath('round-2', a.label) : scratchPath('round-2', a.label) }))
await buildWorktrees('round-2', r2Worktrees) // repoMode-only no-op otherwise
const r2 = (await parallel(r2Worktrees.map(a => () => dispatch(a, a.ws, review.guidance, 'Round 2')))).filter(Boolean)
{ const w = dispatchDropSummary('Round 2', dispatchDrops, r2Worktrees.length, r2.length); if (w) log(w) } // #45
await snapshotWorktrees('round-2', r2) // repoMode-only no-op otherwise

// final pool = round-2 attempts + the carried-over round-1 winner. Staging erases the round path,
// so the judge cannot tell which finalist is the carryover.
// D-0004: champ.ws is the round-1 STRIPPED staging dir (review-1/<blind>/) — its provenance log was
// already deleted there. The carryover passed provenance in round 1, so mark it carriedOver:true and
// have stageAndValidate skip ONLY the provenance grep for it (the deliverable is still required). Without
// this flag, a runner-backed (glm/codex/minimax/local) round-1 winner would re-grep the stripped dir,
// get P=0, and be wrongly dropped from the final pool the Opus ranker reads.
const finalPool = [
  ...r2.map(c => ({ ws: c.ws, label: c.label, displayModel: c.displayModel, dispatch: c.dispatch, round: 2 })),
  { ws: champ.ws, displayModel: champ.displayModel, dispatch: champ.dispatch, round: 1, carriedOver: true, enrichmentSource: `${champ.ws}/enrichment.txt` },
]
phase('Final rank')
const stagedF = await stageAndValidate(blindLabel(finalPool, 2), `${runDir}/review-final`, 'Final rank')
const blindF = stagedF.filter(c => c.valid)
const finalMapping = stagedF.map(c => ({ candidate: c.blind, model: c.displayModel, round: c.round, valid: c.valid, ...(c.valid ? {} : { failReason: c.failReason }) }))
const carriedEntry = finalMapping.find(e => e.round === 1)
const carriedOverWinner = carriedEntry ? carriedEntry.candidate : null
if (!blindF.length) {
  // P4: no valid finalists — full key (round1 + final, winner null) + summaries
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: review.winner, final: finalMapping, winner: null, winnerRound: null, carriedOverWinner }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping }) },
  ], 'Final rank')
  return { mode, n: N, round1: { mapping: r1mapping }, guidance: review.guidance, final: { mapping: finalMapping, error: 'no valid finalists' } } // #5
}

if (repoMode) await enrichBlindPool(blindF, `${runDir}/review-final`, 'Final rank')

// Plan Final rank — the winning PLAN, judged by the same PLAN-lens council (by phaseTitle).
const finalRank = await judge('final ranker', blindF, false, `${runDir}/review-final/_pool.md`, RANK_SCHEMA, 'Final rank', 'final-rank')
if (finalRank.__failed) {
  // P5: final-rank judge failed — same payload as P4 (no finalRank to render)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: review.winner, final: finalMapping, winner: null, winnerRound: null, carriedOverWinner }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping }) },
  ], 'Final rank')
  return { mode, n: N, round1: { mapping: r1mapping }, guidance: review.guidance, final: { mapping: finalMapping, error: `final-rank judge failed: ${finalRank.__failed}` } }
}

if (finalRank.no_consensus) {
  // P5b (council): the final-rank council could not reach a >50% non-vetoed majority. Terminal — winner
  // stays null (never synthesised). Persist the split; a grand loop reads winner:null / no_consensus:true
  // and routes to needs-human + HALT (see SKILL Phase 7 / 7-FALLBACK).
  log(`Final rank: council NO_CONSENSUS — ${finalRank.reasoning}`)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: review.winner, final: finalMapping, winner: null, winnerRound: null, carriedOverWinner, no_consensus: true }) },
    { path: `${runDir}/review-final/verdict.json`, content: json(finalRank) },
    { path: `${runDir}/review-final/verdict.md`, content: verdictToMd(finalRank, 'Final rank verdict (NO CONSENSUS)') },
    { path: `${runDir}/review-final/council.json`, content: json(finalRank.council) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping, finalRank }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping, finalRank }) },
  ], 'Final rank')
  return { mode, n: N, round1: { mapping: r1mapping }, guidance: review.guidance, final: { mapping: finalMapping, rank: finalRank }, no_consensus: true, council: finalRank.council, error: `NO_CONSENSUS at final rank: ${finalRank.reasoning}` }
}

// #7: resolve winnerRound against the VALID finalist set; omit the field if unresolved (no literal "undefined")
const winnerEntry = blindF.find(c => c.blind === finalRank.winner)
// P6: completed two-pass — full key + final verdict + summaries
const contributions = computeContributions(
  { mapping: r1mapping, review },
  review.guidance,
  { mapping: finalMapping, rank: finalRank, winnerRound: winnerEntry ? winnerEntry.round : null },
  mode
)
await persist([
  { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: review.winner, final: finalMapping, winner: finalRank.winner, winnerRound: winnerEntry ? winnerEntry.round : null, carriedOverWinner }) },
  { path: `${runDir}/review-final/verdict.json`, content: json(finalRank) },
  { path: `${runDir}/review-final/verdict.md`, content: verdictToMd(finalRank, 'Final rank verdict') },
  ...(finalRank.council ? [{ path: `${runDir}/review-final/council.json`, content: json(finalRank.council) }] : []),
  { path: `${runDir}/SUMMARY.md`, content: summaryMd({ task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping, finalRank, winnerRound: winnerEntry ? winnerEntry.round : null }) },
  { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping, finalRank, winnerRound: winnerEntry ? winnerEntry.round : null }) },
  { path: `${runDir}/contributions.json`, content: json({ note: 'ESTIMATE — per-model attribution is a HEURISTIC, not ground truth. See workflows/tournament.mjs (computeContributions) for the exact formula. Forward-improvable.', mode, winner: finalRank.winner, winnerRound: winnerEntry ? winnerEntry.round : null, contributions }) },
], 'Final rank')

// ===== IMPLEMENT PHASE hook — only with args.implement. =====================================
// Reached only on a RESOLVED winning plan: a plan-phase NO_CONSENSUS / __failed / no-valid-pool
// already returned above, BEFORE any implement spend (the design's hard invariant). The winning
// plan is bundled verbatim and drives Implement Round 3 (+ Round 4 only on a failed R3 gate).
if (implement) {
  const planWinner = blindF.find(c => c.blind === finalRank.winner) || champ
  const seedPlanPath = `${runDir}/_winning-plan/plan.md`
  await bundlePlan(planWinner.ws, seedPlanPath)
  const impl = await implementPhase(seedPlanPath)
  await persist([
    { path: `${runDir}/implement.json`, content: json({ winningPlan: finalRank.winner, ...impl }) },
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, implement: true, round1: r1mapping, winner1: review.winner, final: finalMapping, planWinner: finalRank.winner, implementRounds: impl.rounds, implementWinner: impl.winner, implementWinnerRound: impl.winnerRound, needs_human: impl.needs_human, carriedOverWinner }) },
  ], impl.rounds === 4 ? 'Implement Round 4' : 'Implement Round 3')
  return {
    mode, n: N, implement: true,
    plan: {
      round1: { mapping: r1mapping, review },
      guidance: review.guidance,
      final: { mapping: finalMapping, rank: finalRank, ...(winnerEntry ? { winnerRound: winnerEntry.round } : {}) },
      winner: finalRank.winner,
    },
    implementPhase: impl,
    contributions,
  }
}

return {
  mode, n: N,
  round1: { mapping: r1mapping, review },
  guidance: review.guidance,
  final: { mapping: finalMapping, rank: finalRank, ...(winnerEntry ? { winnerRound: winnerEntry.round } : {}) },
  contributions,
}
