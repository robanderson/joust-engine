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
    // Rejudge mode (only when args.rejudgeCandidates): no generation rounds at all — fixed
    // mechanical gate + code council over an existing staged pool (run-i salvage class).
    { title: 'Rejudge' },
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
//   quorumClose: boolean,                 // optional — false disables N-1 quorum close (default on where the runtime has timers+clock)
//   quorumGraceSecs: number,              // optional — grace buffer added to 2x a seat's wall clock (default 90)
//   aspectVerifiers: boolean,             // optional — true adds 4 cheap binary aspect verifiers per decision point (BoN-MAV, arXiv:2502.20379); tiebreak + steelman context ONLY, never the tally/veto (default off)
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
// A/B briefs (design-brief A/B test): when true AND the final rank produced a second gated,
// non-vetoed finalist, the implementer pool is seeded ALTERNATELY with both design briefs.
// Judges stay blind to brief lineage (they judge code against the ORIGINAL task + fundamentals,
// never against a brief); the A/B readout is derived from mapping afterwards, never from votes.
const AB_BRIEFS = A.abBriefs === true
let implementSeats = implementAttempts // reassigned by the A/B hook when a second finalist exists
// investigate (INVESTIGATE→COMPOSITE pipeline v1, spec 2026-07-06, gap G1): Round 1 attempts use
// the 'investigate' brief kind — each returns a short FINDINGS.md (diagnosis + VERIFIABLE evidence
// citations + a candidate improvement sketch; findings only, never fixes) — and the run IMPLIES
// composeOnly semantics (stage/validate/pool, then return {poolPath, mapping, candidates} for the
// orchestrating composer; no councils, no round 2). A G2 evidence-verification pass stamps each
// pooled candidate with `EVIDENCE: n cited, m verified` before the pool returns. Off (default) =>
// byte-identical behavior to today. Ignored under implement (investigation precedes implementation
// by construction — the composite, not the findings pool, seeds implementers).
const investigate = A.investigate === true && !implement
// Dynamic M (issue #36): OPT-IN, off by default. When on AND a ledger runner + task bucket are
// supplied, the engine MAY seat FEWER implementers on a brief prior runs show converges
// deterministically. Fail-open + reduce-only: any missing input or read failure leaves the seat
// count exactly as today. A documented no-op until operators run the ledger's record step.
const DYNAMIC_M_ON = A.dynamicM === true
const ledgerRunner = A.ledgerRunner || null
const dynamicMBucket = A.taskBucket || null
// composeOnly (@@FE Fable Engine): run Round 1 + stage/validate/pool, then STOP — no councils,
// no round 2, no implement. The caller (the orchestrating model) reads the blind pool and
// composes/implements itself. Mutually exclusive with implement. `investigate` implies it.
const composeOnly = (A.composeOnly === true || investigate) && !implement
const mode = implement ? 'two' : A.mode
const LABELS = 'ABCDEFGHIJKLMNOP'.split('')

// Judge council (issue #22). The default judge at BOTH decision points (Phase 3 review, Phase 5 final
// rank) is a 5-lens DELIBERATING Opus council: 5 blind judges vote independently, tally is deterministic
// CODE (never an LLM), a >50% majority on a non-vetoed candidate wins, the security lens can VETO with
// evidence, and an unresolved split routes to NO_CONSENSUS (surface interactively / needs-human+HALT in a
// grand loop). `judges: 1` is the LEGACY escape hatch — the single blind Opus judge, byte-for-byte today.
// Council size is fixed at 5 (not user-tunable): any judges value other than 1 selects the council.
const COUNCIL = Number(A.judges) !== 1

// judgeMix (mixed-family council, 2026-07-05 design). Default = the mixed assignment (codex-xhigh on
// completeness-class/simplicity-class seats); judgeMix:'anthropic' forces every seat native Opus,
// byte-identical to pre-feature output. Ignored when judges:1 (no council to mix).
const LEGACY_MIX = A.judgeMix === 'anthropic'

// Aspect verifiers (BoN-MAV, arXiv:2502.20379; default OFF via args.aspectVerifiers === true):
// many cheap BINARY aspect checks beat a single continuous score — spend marginal budget on
// verification, not candidates. 4 HELPER_MODEL verifiers (one per aspect) run CONCURRENTLY with
// the council's round-1 lens fan-out against the same staged pool. Their approval counts ONLY
// break EXACT ties inside nonVetoedOrder (slotting between mean-rank and blind-letter) and are
// surfaced to the steelman as context — NEVER the majority tally, the veto, or the judges:1
// legacy path. A dead aspect agent ABSTAINS; the feature can never crash or shrink a run.
const ASPECT_VERIFIERS = A.aspectVerifiers === true

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

// brief() frames one attempt. `kind` selects the phase framing:
//   'plan'        — Plan Round 1/2: produce a PLAN artifact (a concrete, file-level change
//                   proposal). Plans NEVER touch the repo, so this is always the scratch path.
//   'investigate' — Investigate Round 1 (investigate: true): produce a FINDINGS.md — diagnosis +
//                   verifiable evidence citations + an improvement sketch. Findings only, never
//                   fixes; same single-pass + save contract + hard stop as the other kinds.
//   'implement'   — Implement Round 3/4: apply the change. `seedPlanPath` (when set) seeds the
//                   attempt with the WINNING PLAN verbatim — the deliberate exception to the
//                   "never seed prior artifacts" rule (the plan IS the spec).
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

  // ---- INVESTIGATE round (investigate: true, Round 1 only): produce FINDINGS, never fixes. ----
  if (kind === 'investigate') {
    return `You are INVESTIGATING a problem — establishing WHAT is actually true, not designing or writing a fix. Your deliverable is FINDINGS ONLY.

Task to investigate:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, FINDINGS.md, in your workspace, organised as:
- DIAGNOSIS (1-3 bullets): what is actually wrong/slow/missing, in decision-level language.
- EVIDENCE (2-6 bullets): VERIFIABLE citations backing each diagnosis bullet — exact file paths with line numbers (e.g. src/foo.js:123), artifact/log paths, or short quoted log/telemetry excerpts naming their source path, plus measured numbers where you have them. Every claim must be checkable by a reader with the same files; a claim you could not verify is speculation and MUST be labelled as such.
- CANDIDATE IMPROVEMENT SKETCH (1-3 bullets): the direction a fix could take, at design-brief altitude — what KIND of change, where, and why it would address the diagnosis.

ALTITUDE RULE (hard): FINDINGS ONLY — NO code blocks, NO diffs, NO function bodies, NO fixes, NO line-level edit instructions. Citing a file:line as evidence is citing, not editing. A findings file that reads like a patch or an implementation will be judged DOWN for altitude violation; a diagnosis without checkable evidence will be weighed as speculation.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — investigate with what you can read; where you cannot verify, say so honestly rather than speculate.
- Produce the FINDINGS ONLY. Do NOT write a fix, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save FINDINGS.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End FINDINGS.md with a 2 to 4 sentence note on your confidence and what you could not verify (outside the bullet budget).`
  }

  // ---- PLAN phase (Plan Round 1/2): produce a PLAN artifact, never touch the repo. ----
  if (kind === 'plan') {
    return `You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY. If a genuinely competitive alternative exists, name it in one bullet and say why you rejected it.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects (breaking changes, coupling, data/compat, security posture) and the mitigation.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("<metric> improves by >=X", "no existing test regresses", "behaviour Z is preserved", "a new test covers case W").

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — reviewers verify that named surfaces and constraints actually exist. A brief that reads like an implementation will be judged DOWN for altitude violation, however good its code is; a brief that hand-waves the hard 20% will be judged down for incompleteness. Decisions and criteria are the deliverable — implementation details belong to the implementers.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).`
  }

  // ---- IMPLEMENT phase (Implement Round 3/4): the winning plan IS the spec. ----
  const seedBlock = seedPlanPath
    ? `\nAn APPROVED DESIGN BRIEF for this task has already been chosen by a review council. It is your specification — read it in full at the start:\n${seedPlanPath}\nFollow its APPROACH and satisfy its ACCEPTANCE CRITERIA. The implementation details are yours: make the smallest coherent implementation consistent with the brief. Where the brief is explicit, honour it; where it is silent, choose well. Do NOT re-plan or second-guess the overall approach.\n`
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
  // Run G (non-repoMode implement only — 'plan' returned above, repoMode returned above): ONE
  // mandated deliverable layout + a bounded git-apply self-verify. The engine's pre-council gate
  // stamps conformance (CONTRACT:) but v1 never invalidates a freeform layout (grandfathered).
  return `You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

DELIVERABLE CONTRACT (mandatory layout — a deterministic engine gate checks it before judging):
- PRIMARY (preferred): a \`patches/\` directory holding one or more ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\` (the exact, ORDERED shell commands to apply every patch, e.g. \`git apply patches/0001-<name>.patch\`), PLUS \`VERIFY.md\` (the exact commands to verify the change and the expected result).
- SELF-VERIFY before you stop: you have no repository checkout here, so prove your diffs are well-formed — \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This one bounded check is REQUIRED and explicitly allowed — it is NOT the forbidden run-the-tests-and-iterate loop. If you cannot reach exit 0, switch to the FALLBACK below instead of shipping a corrupt patch.
- FALLBACK (only if you cannot produce a clean patch): a \`files/\` directory mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root. A conforming layout lets reviewers judge your CODE instead of your packaging (a non-conforming layout is stamped but still judged in this version).

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution file ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite, re-align, "improve", or polish it (sole exception: the \`git apply --check\` self-verify the DELIVERABLE CONTRACT requires). Your first version is final — even if it is imperfect or not to your taste. Perfecting it is explicitly NOT wanted here and only wastes effort.
- Your text reply is discarded; ONLY the file(s) you save are kept. You MUST save your solution to a file (an empty workspace is a total failure) — but it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}
- Work only in that directory. Create it if needed.
- NEVER delete or rewrite the workspace scratch files (\`_brief.txt\` and any \`_*.log\` / \`_*.txt\`): they are the run's provenance record, and a "tidied" workspace is indistinguishable from a spoofed run — it invalidates your deliverable (observed live: a worker cleaned them up alongside a good patch and was rejected).
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
// Generous wall-clock for a codex-xhigh JUDGE seat (reasoning-heavy, reads a whole blind pool file).
// Separate from codexTimeout (the ATTEMPT wall-clock) so raising one never silently raises the other.
const codexJudgeTimeout = Number(A.codexJudgeTimeoutSecs) > 0 ? Math.floor(Number(A.codexJudgeTimeoutSecs)) : 1500
// Grok is a full autonomous coding agent (like codex it gets a roomier wall-clock default), but UNLIKE
// codex it ALSO has --max-turns, so it uses BOTH per-attempt guards via the standard runnerCmd:
// grokMaxTurns (default = glm's 30) as the primary iteration cap + grokTimeout as the wall-clock backstop.
const grokMaxTurns = Number(A.grokMaxTurns) > 0 ? Math.floor(Number(A.grokMaxTurns)) : glmMaxTurns
const grokTimeout = Number(A.grokTimeoutSecs) > 0 ? Math.floor(Number(A.grokTimeoutSecs)) : 600
const cmdHead = (ws, b) => `mkdir -p ${q(ws)} && cd ${q(ws)} && printf '%s' ${q(b)} > _brief.txt`
// DETACHED LAUNCH (2026-07-06, run-i glm post-mortem): the runner command is no longer executed
// inside one long wrapper Bash call — a foreground tool call is CAPPED (~600s) below the runner
// wall-clocks (glm 1200s), and a run_in_background task is reaped when the wrapper agent's turn
// ends (the run-h impl-4 kill). Instead the wrapper runs a LAUNCHER that detaches the runner into
// its own session (perl POSIX::setsid — macOS ships no setsid binary; perl is already a hard runner
// dependency) and returns immediately; the runner SELF-SUPERVISES (its own wall-clock + stall
// watchdogs guarantee exactly one terminal JOUST-RC line), and the wrapper POLLS the log for that
// line in short bounded calls (the RUNVERBATIM protocol below). No wrapper ceiling ever bounds a
// runner again; an abandoned runner still terminates itself.
const detachLaunch = (env, runner, flag) =>
  `{ ${env}nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!"' -- bash ${q(runner)} ${flag} </dev/null >/dev/null 2>&1 & } && echo JOUST-LAUNCHED`
// envExtra (optional): extra `KEY=VAL ` env assignments prepended to the runner call (e.g. grok's JE_GROK_WEB=1).
const runnerCmd = (runner, flag, ws, b, maxTurns, timeout = attemptTimeout, envExtra = '') => `${cmdHead(ws, b)} && ${detachLaunch(`${envExtra}JE_MAX_TURNS=${maxTurns} JE_TIMEOUT_SECS=${timeout} `, runner, flag)}`
// Codex reuses cmdHead + the runner but overrides the wall-clock with codexTimeout (no JE_MAX_TURNS:
// codex has no turn cap, and codex-run.sh ignores it). The optional timeoutSecs arg lets a codex JUDGE
// seat pass codexJudgeTimeout (its own, roomier wall-clock) without touching the attempt call site.
// prep (optional): extra shell run INSIDE the workspace between the brief write and the launch (the
// review-mode judge stages the pool file + a scratch git repo there). envExtra as in runnerCmd.
const codexRunnerCmd = (runner, flag, ws, b, timeoutSecs = codexTimeout, prep = '', envExtra = '') => `${cmdHead(ws, b)} && ${prep}${detachLaunch(`${envExtra}JE_TIMEOUT_SECS=${timeoutSecs} `, runner, flag)}`
// The poll step of the RUNVERBATIM protocol: one bounded until-loop call the wrapper repeats until
// the runner's guaranteed terminal line lands. maxWaitSecs mirrors the runner wall-clock (+ retry
// headroom) so the wrapper knows when polling has genuinely outlived the watchdogs.
const pollCmd = (log) => `until grep -q '^JOUST-RC ' ${q(log)} 2>/dev/null; do sleep 10; done; echo JOUST-SETTLED`

// Optional shared CONTEXT BUNDLE for known-input tasks (args.contextFiles = [paths/globs]).
// Concatenate those files ONCE into a single file that every worker reads by path — instead of
// each attempt re-reading the same source files (which dominated tool-use/latency in practice).
// The bundle lives OUTSIDE any candidate workspace (in ${runDir}/_context/), and staging only ever
// copies a candidate's own workspace into its review dir, so the bundle is never exposed to the blind
// judge. No bundle is built when contextFiles is empty.
// HELPER_MODEL — the model for every internal engine helper agent (context bundling, worktree
// setup/snapshot, staging validation, enrichment, persist, seed-plan copy). Sonnet, not haiku
// (2026-07-05): Sonnet 5's agentic reliability is worth the negligible cost delta on these small
// steps, and persist specifically corrupted artifacts on haiku (issue #33; 9/9 audited runs).
const HELPER_MODEL = 'sonnet'
// Quorum close (run E): capability-gated on BOTH host timer APIs it needs — setTimeout AND a usable
// clock. Neither is core-ECMAScript-guaranteed here: this sandbox deliberately makes Date.now() THROW
// (resume-safety), so we PROBE by calling it, not by typeof. When either is missing, rounds block on
// every seat exactly as before this feature (one log line, fail-safety unaffected). `quorumClose:false`
// is the operator-reversible escape hatch, independent of capability.
const HAS_TIMERS = typeof setTimeout === 'function'
let HAS_CLOCK = false
try { Date.now(); HAS_CLOCK = true } catch { /* sandbox clock disabled — quorum close stays inert */ }
const QUORUM_ENABLED = HAS_TIMERS && HAS_CLOCK && A.quorumClose !== false
const QUORUM_GRACE_SECS = Number(A.quorumGraceSecs) > 0 ? Number(A.quorumGraceSecs) : 90
const QUORUM_POLL_MS = 5000
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let quorumCapabilityWarned = false

// Idempotent seat-record guard: a quorum-closed straggler is written to seatRcs synthetically when the
// round closes, but its real promise may STILL resolve later and record the same seat again.
// recordSeatOnce keys on `${label} ${phaseTitle}` and lets only the FIRST write per key win —
// a no-op for every normal seat (each records its label+phase exactly once).
const _seatRecorded = new Set()
function recordSeatOnce(label, phaseTitle, rc, reason) {
  const key = `${label} ${phaseTitle}`
  if (_seatRecorded.has(key)) return
  _seatRecorded.add(key)
  recordSeat(label, phaseTitle, rc, reason)
}
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
// Gate baseline pin (run-i mechanical-gate post-mortem): capture the host repo's HEAD sha ONCE at
// bundle time into a runDir file the mechanical gate reads directly (file-relayed, no model transit).
// Non-repoMode tournaments still execute FROM a git checkout — the very tree the context bundle was
// cut from — so this sha gives the gate a REAL apply-check baseline instead of an empty `git init`
// repo (where a patch MODIFYING any existing file can never pass; that false-killed 11/12 implement
// candidates in run-i and made run-h's two "clean" stamps a find-order coin-flip). Pinning at BUNDLE
// time (not gate time) keeps the check honest when the checkout drifts mid-run (commits landed
// during run-i's implement rounds). Fail-soft: no repo => empty file => the gate degrades to the
// parse-only structure check.
const gateBaseShaFile = `${runDir}/_context/base-sha`
async function buildContext() {
  const pin = `mkdir -p ${q(`${runDir}/_context`)} && { git rev-parse HEAD 2>/dev/null || printf ''; } > ${q(gateBaseShaFile)}`
  if (!contextPath) {
    await agentLadder(`Run this exact shell command in ONE Bash call; do not print or expose its output. Do nothing else:\n\n${pin}`,
      { model: HELPER_MODEL, phase: 'Round 1', label: 'context' }).catch(() => null)
    return
  }
  const cat = contextCatCmd(contextFiles)
  const cmd = `${pin} && { ${cat} ; } > ${q(contextPath)} && wc -c ${q(contextPath)}`
  log(`Bundling ${contextFiles.length} context file(s) → ${contextPath}`)
  await agentLadder(`Run this exact shell command in ONE Bash call and report its stdout. Do nothing else:\n\n${cmd}`,
    { model: HELPER_MODEL, phase: 'Round 1', label: 'context' }).catch(() => null)
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
// Judge scratch dirs (mixed-family council, 2026-07-05) live under the SAME outside-~/.claude/ root as
// candidate workspaces (issue #34/#44) so a codex judge seat can actually write VERDICT.json instead of
// fighting write denials. Keyed off the already-unique per-seat label (`<phase-label>-<lens.key>-r<round>`),
// so concurrent codex seats (spec/craft, completeness/simplicity) get disjoint dirs even under parallel().
const judgeWorkspaceRoot = `${workspaceRoot}/_judges`
const judgeWs = (label) => `${judgeWorkspaceRoot}/${label}`
let codexRunnerWarned = false // one-time (not per-seat/round) missing-runner warning
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
  await agentLadder(
    `Run this exact shell script in ONE Bash call. It serially creates git worktrees for the tournament attempts; do not parallelize it and do not do anything else.\n\n${script}`,
    { model: HELPER_MODEL, phase: roundName === 'round-1' ? 'Round 1' : 'Round 2', label: `${roundName}-worktrees` }
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
  await agentLadder(
    `Run this exact shell script in ONE Bash call. It serially snapshots each worktree into at most one fixed-identity commit; do not parallelize it and do not do anything else.\n\n${script}`,
    { model: HELPER_MODEL, phase: roundName === 'round-1' ? 'Review' : 'Final rank', label: `${roundName}-snapshot` }
  ).catch(() => null)
}

const RUNVERBATIM = (cmd, ws, log) =>
  `This is an approved internal step of the joust-engine tournament: it writes a brief file and LAUNCHES a bundled, self-supervising project runner script (its own watchdogs bound its runtime and it always writes a terminal "JOUST-RC" line to its log), which performs the attempt. Follow this LAUNCH-AND-POLL protocol exactly; do not attempt the task yourself and do not edit the commands.\n\nSTEP 1 — LAUNCH (one Bash call; it detaches the runner and returns in seconds — expect it to print JOUST-LAUNCHED):\n\n${cmd}\n\nSTEP 2 — POLL until the runner finishes: run this exact command as its own FOREGROUND Bash call (never as a background task) with a generous per-call timeout; when a call times out, RUN THE SAME COMMAND AGAIN — repeat until it prints JOUST-SETTLED. NEVER end your turn while the runner is still working; the runner's own watchdogs guarantee the line always arrives.\n\ncd ${q(ws)} && ${pollCmd(log)}\n\nSTEP 3 — report the deliverable path(s) in ${ws} and the last ~15 lines of ${log}.`

// The bundled worker agents register under the plugin namespace (joust-engine:<name>);
// accept either the bare or namespaced form from callers and normalize to what the
// agent registry actually resolves.
const nsAgent = t => (t && !t.includes(':')) ? `joust-engine:${t}` : t

// ---- begin: model ladder ------------------------------------------------------------------------
// Model fallback ladder (operator-requested resilience, 2026-07-06). The orchestrating session may
// run on a model (Fable) whose safety sensitivity can block a sub-agent call outright or downgrade
// it; a blocked NATIVE anthropic seat must degrade ONE rung down this ladder instead of dying.
// PURE (extract-and-eval'able like the return-codes block): no closures over module state, no I/O.
// haiku is RETIRED by operator policy (no haiku sub-agents until a Haiku 5.x base ships), so sonnet
// is the hard FLOOR: nextModelDown('sonnet') === null, and unknown ids (incl. 'haiku') -> null.
const MODEL_LADDER = ['fable', 'opus', 'sonnet']
function nextModelDown(model) {
  const i = MODEL_LADDER.indexOf(String(model == null ? '' : model).trim().toLowerCase())
  if (i < 0) return null                 // unknown / haiku (retired): no rung below
  return MODEL_LADDER[i + 1] || null     // sonnet -> null: NEVER below sonnet
}
// ---- end: model ladder --------------------------------------------------------------------------

// ---- begin: agent ladder wrapper (impure; the ONE downgrade-retry chokepoint) --------------------
// Downgrade bookkeeping: one entry per successful ladder rescue. Surfaced in the workflow return
// value as `model_downgrades` (observability only — it never gates dispatch/judging/any return).
const modelDowngrades = [] // { label, phase, from, to }

// agentLadder(prompt, opts, ladder) — agent() plus ONE downgrade-retry rung for NATIVE anthropic
// seats. The SINGLE shared wrapper (no per-site copies). Contract:
//   * opts.agentType (runner dispatch) passes straight through: command runners are exempt.
//   * opts.model is REQUIRED otherwise — no engine sub-agent may inherit the session model.
//   * a thrown/blocked attempt (throw OR null result) retries ONCE at nextModelDown(opts.model);
//     rung success records {label, phase, from, to} in modelDowngrades + logs LOUDLY
//     (JE-MODEL-DOWNGRADE) and sets ladder.used to the model that ACTUALLY answered (so council
//     seats tag judge_model truthfully); a rung failure propagates the ORIGINAL outcome so every
//     existing dead/fallback path stays byte-for-byte.
//   * ladder.eligible === false disables the rung entirely: the security lenses (primary
//     'security' AND the 'security-x' opus-fallback seat) stay opus minimum — a sonnet retry is
//     FORBIDDEN for them (their failure keeps today's dead-judge path) — and a retry-loop site
//     passes eligible only on its FINAL same-model try, so the rung slots AFTER the site's own
//     retries and BEFORE its dead path (askLensNative: opus try, opus retry, THEN sonnet rung).
//   * sonnet floor by construction: nextModelDown('sonnet') === null, so every sonnet-seated
//     helper (persist/stage/etc.) keeps today's exact behaviour — no rung below sonnet.
async function agentLadder(prompt, opts, ladder = {}) {
  if (opts && opts.agentType) return agent(prompt, opts) // runner dispatch: exempt (command runners)
  if (!opts || !opts.model) throw new Error('agentLadder: opts.model or opts.agentType is required — no engine sub-agent may inherit the session model')
  const from = opts.model
  ladder.used = from
  const to = ladder.eligible === false ? null : nextModelDown(from)
  let res, failure = null
  try { res = await agent(prompt, opts) } catch (e) { failure = e }
  if (!failure && res != null) return res
  if (to == null) { if (failure) throw failure; return res } // no rung: today's outcome, unchanged
  const label = opts.label || '?'
  const phase = opts.phase || '?'
  log(`JE-MODEL-DOWNGRADE [${phase}] ${label}: '${from}' seat ${failure ? `threw (${String(failure).slice(0, 120)})` : 'returned null (blocked/empty)'} — retrying ONCE at '${to}' (model fallback ladder; floor=sonnet, haiku retired).`)
  let res2
  try { res2 = await agent(prompt, { ...opts, model: to }) }
  catch (e2) { if (failure) throw failure; throw e2 } // rung also failed: surface the ORIGINAL class
  if (res2 == null) { if (failure) throw failure; return res2 }
  ladder.used = to
  modelDowngrades.push({ label, phase, from, to })
  log(`JE-MODEL-DOWNGRADE [${phase}] ${label}: '${to}' rung answered — downgrade recorded (${from} -> ${to}); verdict metadata carries the ACTUAL model.`)
  return res2
}
// ---- end: agent ladder wrapper -------------------------------------------------------------------

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
// ---- per-seat return-code accumulator (issue: return-codes design). Read-only bookkeeping fed at
// existing observation points; it NEVER gates dispatch/judging/any return (observability only), so it
// mirrors the dispatchDrops pattern. Each entry: {seat, phase, rc, reason, logPath?}. `logPath` (runner
// seats only) lets the auto-issue hook grep a real JOUST-* marker excerpt for the evidence file.
const seatRcs = []
function recordSeat(seat, phase, rc, reason, logPath) { seatRcs.push({ seat, phase, rc, reason, ...(logPath ? { logPath } : {}) }) }

// ---- begin: return codes ----------------------------------------------------------------------
// Official per-seat return codes (JE-RC 00–09). RCs are OBSERVABILITY, not control flow — nothing
// here gates dispatch, staging, judging, or any return; it only classifies signals the engine has
// ALREADY observed. Every function below is PURE (no closures over module state, no I/O) so
// workflows/tournament-return-codes.test.mjs can extract this marked block and eval it in isolation,
// exactly like the verdict-integrity block above.
//
// LOAD-BEARING INVARIANT: the literal marker runners write is `JOUST-RC <code> <reason>`, and
// `JOUST-` is deliberately NOT a rebrand replacement token — so this parse regex stays byte-identical
// to the writer (emit_rc in bin/*-run.sh) in BOTH the prod and dev-rebranded copies. Do not add a
// `JOUST-` rewrite to rebrand.config.json.
const RC = { OK:'00', TIMEOUT:'01', UNAVAIL:'02', TURNCAP:'03', INVALID:'04',
             NODELIV:'05', PROV:'06', ENV:'07', ABORT:'08', UNKNOWN:'09' }
// classes that auto-file an engine-fault issue (spec §3: 01/02 after retries, 04-09; NOT 00/03).
const ENGINE_FAULT_CLASSES = new Set(['01','02','04','05','06','07','08','09'])
const RC_MEANING = { '00':'expected result','01':'model timeout','02':'model unavailable/throttled',
  '03':'turn-cap exhausted','04':'invalid output','05':'no deliverable saved','06':'provenance failure',
  '07':'environment/permission failure','08':'aborted/killed','09':'unknown/other error' }

// parse the LAST `JOUST-RC <code> <reason>` line from a runner log's text. Missing line => RC 09.
function parseRunnerRc(logText) {
  const lines = String(logText == null ? '' : logText).split('\n')
  let last = null
  for (const ln of lines) { const m = /^JOUST-RC ([0-9]{2}) ?(.*)$/.exec(ln.trim()); if (m) last = m }
  if (!last) return { rc: RC.UNKNOWN, reason: 'no-jerc-line' }
  return { rc: last[1], reason: (last[2] || '').trim() || RC_MEANING[last[1]] || 'unclassified' }
}
// native anthropic attempt (no runner): derive from staging truth only.
function deriveNativeAttemptRc({ dispatchedOk, valid, failReason }) {
  if (!dispatchedOk) return { rc: RC.UNKNOWN, reason: 'agent-null-or-throw' }
  if (valid) return { rc: RC.OK, reason: 'ok' }
  const fr = String(failReason || '')
  if (/no deliverable/i.test(fr)) return { rc: RC.NODELIV, reason: 'no-deliverable' }
  if (/provenance/i.test(fr))     return { rc: RC.PROV,    reason: 'provenance' }
  return { rc: RC.INVALID, reason: 'invalid-or-missing-staging' }
}
// runner attempt: the runner's own RC is authoritative for what happened inside it, but the engine
// also observes staging. If the runner said 00 yet staging rejected it, reclassify to staging truth.
function deriveRunnerAttemptRc({ runnerRc, runnerReason, valid, failReason }) {
  if (!runnerRc) return { rc: RC.UNKNOWN, reason: 'no-jerc-line' }
  if (runnerRc !== RC.OK) return { rc: runnerRc, reason: runnerReason || RC_MEANING[runnerRc] }
  if (valid) return { rc: RC.OK, reason: 'ok' }
  const fr = String(failReason || '')
  if (/no deliverable/i.test(fr)) return { rc: RC.NODELIV, reason: 'no-deliverable' }
  if (/provenance/i.test(fr))     return { rc: RC.PROV,    reason: 'provenance' }
  return { rc: RC.INVALID, reason: 'invalid-output' }
}
// build the rc_summary from the flat seat accumulator (pure).
function buildRcSummary(seatRcs) {
  const seats = seatRcs.length
  const by_code = {}
  const non00 = []
  for (const s of seatRcs) {
    by_code[s.rc] = (by_code[s.rc] || 0) + 1
    if (s.rc !== RC.OK) non00.push({ seat: s.seat, phase: s.phase, rc: s.rc, reason: s.reason })
  }
  return { seats, by_code, non00 }
}
// Codex judge VERDICT read-back failure classification (fold-in A, run E). STRUCTURAL, not
// message-sniffing: a 'dispatch'-stage failure means the codex runner never produced a verdict at all
// (never ran / not registered / genuine throttle) -> RC 02 (unavailable, unchanged meaning). A
// 'readback'-stage failure means the dispatch agent() call ALREADY succeeded and something AFTER that
// was bad — sha-verified relay corruption, non-JSON, wrong shape, or a failed integrity check — which
// is the same class RC 04 already covers for every other seat. Only the class was wrong before.
function classifyCodexJudgeFailure(stage) {
  return stage === 'readback'
    ? { rc: RC.INVALID, reason: 'codex-verdict-readback-failed' }
    : { rc: RC.UNAVAIL, reason: 'codex-seat-unavailable' }
}
// ---- end: return codes ------------------------------------------------------------------------

// ---- begin: quorum close ------------------------------------------------------------------------
// Pure decision logic for engine-side N-1 quorum close (run E item 4). The async orchestration that
// calls these (parallelQuorum) is impure and exercised by system testing; only the arithmetic here,
// where an off-by-one or a missed fail-closed check would matter, is unit tested.

// A seat's total "must-still-be-alive" budget in seconds: 2x its per-try wall clock (one original try
// + the runner's own one built-in stall/timeout retry, see bin/_je-run-lib.sh) plus a grace buffer.
// timeoutSecs == null (a seat with NO engine-known wall clock — every native Anthropic attempt/judge)
// returns null: NEVER eligible, by construction. NOTE: the 2x factor is tied to the runner's
// retry-once policy — if that policy changes, revisit this together with bin/_je-run-lib.sh.
function quorumDeadlineSecs(timeoutSecs, graceSecs) {
  if (timeoutSecs == null || !(timeoutSecs > 0)) return null
  return 2 * timeoutSecs + (graceSecs > 0 ? graceSecs : 0)
}

// Should the round close now, leaving exactly `straggler` behind? Fail-closed on every axis: requires
// >=2 seats, EXACTLY one unsettled, never a security-gate seat (neverClose), never a no-deadline seat,
// and only once elapsed is STRICTLY past the deadline.
function shouldQuorumClose({ settledCount, totalCount, straggler }) {
  if (totalCount < 2) return false
  if (settledCount !== totalCount - 1) return false
  if (!straggler || straggler.neverClose) return false
  const deadline = quorumDeadlineSecs(straggler.timeoutSecs, straggler.graceSecs)
  if (deadline == null) return false
  return (straggler.elapsedSecs || 0) > deadline
}
// ---- end: quorum close --------------------------------------------------------------------------

// parallelQuorum(entries, thunkFor, phaseTitle, opts): drop-in for
// `parallel(entries.map((e, i) => () => thunkFor(e, i)))` that additionally allows the round to close
// when all but one seat have returned and that seat has blown its budget (shouldQuorumClose). It NEVER
// forks a competing scheduler: the same thunks go to the real parallel() (individually instrumented for
// start/settle time), and this only RACES that call's resolution against a side-channel poll. Returns
// the SAME array shape (aligned to entries; a quorum-closed straggler's slot is null, like dispatch()'s
// own dropped-seat null, so every existing .filter(Boolean) call site is unaffected).
// opts: { timeoutSecsFor(entry)->number|null, neverClose(entry)->boolean, seatLabelFor(entry)->string,
//         graceSecs (default QUORUM_GRACE_SECS) }
async function parallelQuorum(entries, thunkFor, phaseTitle, opts) {
  const { timeoutSecsFor, neverClose = () => false, seatLabelFor = (e) => String((e && (e.label || e.key)) || '?'), graceSecs = QUORUM_GRACE_SECS } = opts
  if (!QUORUM_ENABLED || entries.length < 2) {
    if (!(HAS_TIMERS && HAS_CLOCK) && !quorumCapabilityWarned) {
      log('JE-QUORUM-DISABLED: this runtime lacks setTimeout and/or a usable clock — rounds block on every seat exactly as before this feature; fail-safety is unaffected.')
      quorumCapabilityWarned = true
    }
    return parallel(entries.map((e, i) => () => thunkFor(e, i)))
  }
  const state = entries.map((e, i) => ({
    index: i, settled: false, startedAt: null, result: null,
    timeoutSecs: timeoutSecsFor(e), neverClose: !!neverClose(e), graceSecs, label: seatLabelFor(e),
  }))
  const thunks = state.map((st, i) => () => {
    st.startedAt = Date.now()
    return Promise.resolve(thunkFor(entries[i], i))
      .then((r) => { st.settled = true; st.result = r; return r })
      .catch(() => { st.settled = true; st.result = null; return null }) // dispatch()/askLens() never throw; belt-and-suspenders
  })
  const allPromise = parallel(thunks)
  for (;;) {
    const unsettled = state.filter((s) => !s.settled)
    if (!unsettled.length) return await allPromise
    if (unsettled.length === 1) {
      const s = unsettled[0]
      const elapsedSecs = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0
      if (shouldQuorumClose({ settledCount: state.length - 1, totalCount: state.length, straggler: { ...s, elapsedSecs } })) {
        const deadline = quorumDeadlineSecs(s.timeoutSecs, s.graceSecs)
        recordSeatOnce(s.label, phaseTitle, RC.TIMEOUT, `quorum-close: exceeded ${deadline}s (2x timeout + ${s.graceSecs}s grace) with the round otherwise complete`)
        log(`JE-QUORUM-CLOSE [${phaseTitle}]: ${state.length - 1}/${state.length} seats returned — '${s.label}' exceeded ${deadline}s; closing the round without it. Its process is NOT killed by this decision (the engine has no handle into a sub-agent's subprocess) and may keep running until the runner's own watchdog/timeout ends it.`)
        s.settled = true; s.result = null
        allPromise.catch(() => {}) // the abandoned background wait must never surface an unhandled rejection
        return state.map((x) => x.result)
      }
    }
    await sleepMs(QUORUM_POLL_MS)
  }
}

// attempt/lens -> engine-known per-try timeout (null = no engine-known wall clock => never
// quorum-closable). Function declarations: they reference module consts defined later in the file
// (glmTimeoutSecs, codexJudgeTimeout, chooseJudgeDispatch, ...) but are only CALLED at await time,
// long after module evaluation.
function attemptTimeoutSecsFor(a) {
  switch (a.dispatch) {
    case 'glm': return glmTimeoutSecs
    case 'local': return attemptTimeout
    case 'codex': return codexTimeout
    case 'minimax': return minimaxTimeoutSecs
    case 'grok': return grokTimeout
    default: return null // native anthropic: agent() exposes no timeout primitive
  }
}
function lensTimeoutSecsFor(lens) {
  return (chooseJudgeDispatch(lens, LEGACY_MIX, !!codexRunner) === 'codex') ? codexJudgeTimeout : null
}

// ---- begin: mechanical patch gate ------------------------------------------------------------
// Deterministic pre-council classification of a staged implement candidate's deliverable (run F).
// PURE — extract-and-eval'able like the return-codes block. The IMPURE runner (mechanicalPatchGate)
// composes these onto one HELPER_MODEL shell step. Classes: clean_patch | corrupt_patch |
// full_files | empty | unavailable. ONLY corrupt_patch invalidates (a corrupt patch cannot win a
// code round; full files are a legitimate deliverable under the loose contract; a gate the engine
// could not run must never shrink the field).
const MECH_CLASSES = new Set(['clean_patch', 'corrupt_patch', 'full_files', 'empty', 'unavailable'])

// Blindness hardening: strip path-shaped text (a scratch/workspace path could hint at dispatch),
// collapse newlines, cap length. Never throws, never returns empty.
function sanitizeMechDetail(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\/[^\s'"()<>]+/g, '<path>')
    .trim()
    .slice(0, 160)
  return s || 'no further detail'
}

// class (+detail) -> the exact judge-visible stamp line. detail: 'recount' | 'structure' for
// clean_patch nuance; the sanitized first git error line for corrupt_patch.
function mechanicalStampFor(cls, detail) {
  switch (cls) {
    case 'clean_patch':
      if (detail === 'structure') return 'MECHANICAL: patch is well-formed (structure-only; no snapshot to context-check)'
      if (detail === 'recount') return 'MECHANICAL: patch applies cleanly (--recount)'
      return 'MECHANICAL: patch applies cleanly'
    case 'corrupt_patch': return `MECHANICAL: git apply --check FAILED: ${sanitizeMechDetail(detail)}`
    case 'full_files': return 'MECHANICAL: no patch found (full-files deliverable)'
    case 'empty': return 'MECHANICAL: no deliverable'
    default: return 'MECHANICAL: check unavailable'
  }
}
const isMechanicalInvalid = (cls) => cls === 'corrupt_patch'

// Merge parsed script results onto the staged list (the routing decision lives HERE, in pure code).
// byBlind = { <letter>: { class, detail } }; missing/unknown/null => 'unavailable' — a candidate the
// gate could not classify is NEVER invalidated (fail-safe), and an upstream-invalid candidate is
// never revalidated or reclassified into contention.
function mergeMechanical(staged, byBlind) {
  return staged.map(c => {
    const r = byBlind && byBlind[c.blind]
    const cls = r && MECH_CLASSES.has(r.class) ? r.class : 'unavailable'
    const stamp = mechanicalStampFor(cls, r && r.detail)
    if (!c.valid) return { ...c, mechanical: { class: cls, stamp } }
    if (isMechanicalInvalid(cls)) {
      return { ...c, valid: false, failReason: `mechanical: patch does not apply (${sanitizeMechDetail(r && r.detail)})`, mechanical: { class: cls, stamp } }
    }
    return { ...c, mechanical: { class: cls, stamp } }
  })
}
// ---- end: mechanical patch gate --------------------------------------------------------------

// ---- begin: deliverable contract gate ----------------------------------------------------------
// Deterministic LAYOUT-conformance classification of a staged implement candidate (run G) —
// ORTHOGONAL to the mechanical patch gate above: MECHANICAL answers "does a found patch apply?",
// CONTRACT answers "did the candidate use the ONE mandated deliverable layout?" (patches/ +
// APPLY.md + VERIFY.md, or the files/ + APPLY.md full-files fallback). The axes cross freely — a
// clean_patch can sit in a freeform layout, and a full_files deliverable can conform via files/.
// A PARALLEL `CONTRACT:` stamp was chosen over extending the MECHANICAL: vocabulary because
// fusing two independent axes into one grammar would need a class cross-product and would edit
// the shipped, tested run-F gate; this block is purely additive (run F stays byte-identical).
// v1 grandfathers: a non-conforming (freeform) layout is stamped, NEVER invalidated. Every stamp
// is a FIXED literal (no interpolated detail), so — unlike corrupt_patch — no sanitizer is needed
// and blindness holds structurally. Classes: patch_layout | files_layout | engine_diff | freeform
// | unavailable ('unavailable' is bookkeeping-only: see contractStampFor).
const CONTRACT_CLASSES = new Set(['patch_layout', 'files_layout', 'engine_diff', 'freeform', 'unavailable'])

// class -> the exact judge-visible stamp line. 'unavailable' is deliberately NEVER pooled: the
// run-G fail-safe degrades to UNSTAMPED — contractStampShell emits nothing without a grammar-
// clean contract.txt — so gate-infra noise never becomes a judge-visible signal (contrast
// MECH_FALLBACK, which always stamps). The freeform literal carries the anti-relitigation nudge
// so a judge cannot see the non-conforming flag without also seeing it must not gate the rank.
function contractStampFor(cls) {
  switch (cls) {
    case 'patch_layout': return 'CONTRACT: conforming (patch layout: patches/ + APPLY.md + VERIFY.md)'
    case 'files_layout': return 'CONTRACT: conforming (full-files fallback: files/ + APPLY.md)'
    case 'engine_diff': return 'CONTRACT: conforming (engine-generated diff; repoMode)'
    case 'freeform': return 'CONTRACT: non-conforming layout (grandfathered v1; judge code quality, not packaging)'
    default: return 'CONTRACT: check unavailable'
  }
}

// Merge parsed JCON tokens onto the staged list. PURELY ADDITIVE — attaches c.contract and NEVER
// touches valid/failReason in either direction (v1 grandfathering is structural: there is no
// invalidation branch to flip by accident). repoModeFlag is an explicit PARAMETER (not a closure
// over the module-level const) so this block stays extract-and-eval testable; repoMode candidates
// are engine-generated worktree diffs — trivially conformant — so their class is forced to
// engine_diff in pure code here, immune to helper death/garbling. Missing/unknown => 'unavailable'
// (fail-safe: an unclassifiable candidate is never penalized, merely left unstamped in the pool).
function mergeContract(staged, byBlind, repoModeFlag) {
  return staged.map(c => {
    if (repoModeFlag) return { ...c, contract: { class: 'engine_diff', stamp: contractStampFor('engine_diff') } }
    const r = byBlind && byBlind[c.blind]
    const cls = r && CONTRACT_CLASSES.has(r.contract) ? r.contract : 'unavailable'
    return { ...c, contract: { class: cls, stamp: contractStampFor(cls) } }
  })
}
// ---- end: deliverable contract gate ------------------------------------------------------------

// ---- begin: ab briefs --------------------------------------------------------------------------
// PURE: alternate two design-brief seed paths across the implementer pool. Even index -> brief-1
// (the final-rank winner), odd -> brief-2 (the runner-up finalist). Anything but exactly two paths
// returns the pool unchanged (fail-safe: never partially seeded).
function assignAbSeeds(attempts, seedPaths) {
  if (!Array.isArray(seedPaths) || seedPaths.length !== 2 || !seedPaths[0] || !seedPaths[1]) return attempts.map(a => ({ ...a }))
  return attempts.map((a, i) => ({ ...a, seedPlanPath: seedPaths[i % 2], seedBrief: i % 2 === 0 ? 'brief-1' : 'brief-2' }))
}
// ---- end: ab briefs ----------------------------------------------------------------------------

// ---- begin: evidence verification ---------------------------------------------------------------
// G2 evidence-verification pass (INVESTIGATE→COMPOSITE v1) — PURE, extract-and-eval'able like the
// mechanical/contract gates. The IMPURE runner (evidenceVerificationPass) composes these onto one
// HELPER_MODEL shell step AFTER staging: extract each valid candidate's cited file paths from its
// FINDINGS deliverable, grep-check they exist in the snapshot/context, and stamp
// `EVIDENCE: n cited, m verified` into the pool. FAIL-SAFE end to end: an unverifiable citation is
// counted-but-unverified (stamp only), a garbled/dead helper degrades to UNSTAMPED, and nothing
// here ever invalidates a candidate or touches valid/failReason (contrast corrupt_patch).
//
// Citation grammar (the contract both extractors implement): a path-shaped token — one or more
// directory segments then a dotted filename (optionally absolute), with an optional :line suffix —
// preceded by start-of-text or a separator (whitespace/quote/backtick/paren/bracket), so URL
// interiors (https://host/a/b.js — every path-ish substring is preceded by ':' '/' or '.') and
// mid-word fragments never match. Bare slashless filenames (package.json) deliberately do NOT
// count: requiring a directory segment is what keeps prose mentions from inflating `n cited`.
// CITE_GREP is the POSIX-ERE twin of parseCitations' JS regex; the two MUST stay in sync (the
// extract-and-eval suite pins parseCitations; the structural suite pins CITE_GREP into the shell).
const CITE_GREP = `(^|[[:space:]"'\`(\\[])\\/?([A-Za-z0-9._-]+\\/)+[A-Za-z0-9._-]+\\.[A-Za-z0-9_]+(:[0-9]+)?`
// Shell post-processing for `grep -ohE CITE_GREP` output: strip the one leading separator char the
// alternation may have captured, then the :line suffix — leaving one bare path per line (sort -u
// then counts DISTINCT cited paths, the same dedupe parseCitations applies).
const CITE_SED = `s/^[[:space:]"'\`(\\[]//; s/:[0-9]+$//`

// parseCitations(text) -> [{ path, line }] — the marked-block citation parser. Dedupes by PATH
// (first-seen line number kept), so its length is exactly the runner's `n cited`. Never throws.
function parseCitations(text) {
  const re = /(?:^|[\s"'`(\[])(\/?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9_]+)(?::(\d+))?/g
  const out = []
  const seen = new Set()
  const s = String(text == null ? '' : text)
  let m
  while ((m = re.exec(s))) {
    const path = m[1]
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ path, line: m[2] ? Number(m[2]) : null })
  }
  return out
}

// counts -> the exact judge/composer-visible stamp line (closed grammar; letters only — no
// candidate text, no paths, no model identity ever enters the stamp).
const EVIDENCE_GRAMMAR = '^EVIDENCE: [0-9]+ cited, [0-9]+ verified$'
function evidenceStampFor(cited, verified) {
  const n = Number.isInteger(cited) && cited >= 0 ? cited : 0
  const m = Math.min(Number.isInteger(verified) && verified >= 0 ? verified : 0, n)
  return `EVIDENCE: ${n} cited, ${m} verified`
}

// Merge parsed JEVID counts onto the staged list. PURELY ADDITIVE — attaches c.evidence and NEVER
// touches valid/failReason in either direction (fail-safe by construction: there is no
// invalidation branch). Missing/garbled/non-numeric => NO evidence attached (degrade to unstamped,
// the contract-gate discipline: helper noise never reads as a candidate signal).
function mergeEvidence(staged, byBlind) {
  return staged.map(c => {
    const r = byBlind && byBlind[c.blind]
    const cited = r == null ? NaN : Number(r.cited)
    const verified = r == null ? NaN : Number(r.verified)
    if (!Number.isInteger(cited) || cited < 0 || !Number.isInteger(verified) || verified < 0) return { ...c }
    const m = Math.min(verified, cited)
    return { ...c, evidence: { cited, verified: m, stamp: evidenceStampFor(cited, m) } }
  })
}
// ---- end: evidence verification -----------------------------------------------------------------
// ---- begin: identical-candidate dedup (issue #36) ---------------------------------------------
// PURE — extract-and-eval'able like the return-codes / quorum blocks (no closures over module
// state, no I/O). Byte-identical implement deliverables collapse to ONE pooled candidate BEFORE the
// council convenes, so duplicates never split the vote or waste judge attention. The identity hash
// is computed once in mechanicalPatchGate's helper shell over each candidate's PRE-STAMP deliverable
// bytes (the same file-set the pool rebuild concatenates) and relayed as one token; the grouping,
// contention predicate, and stamp text are decided HERE, in code.

// Attach an additive `collapse` field {rep, group:[letters]} to every VALID member of a >=2-member
// equal-hash group. rep = the LOWEST blind letter in the group (the codebase's existing letter
// tie-break precedent) — no candidate is ever re-lettered. valid/failReason are NEVER touched.
// hashByBlind: { <letter>: <non-empty hash string> } (a missing/empty hash => never collapses).
function groupIdenticalCandidates(staged, hashByBlind) {
  const byHash = new Map() // hash -> [letters] (valid candidates with a usable hash, first-seen order)
  for (const c of (staged || [])) {
    if (!c || !c.valid) continue
    const h = hashByBlind && hashByBlind[c.blind]
    if (!h || typeof h !== 'string') continue // fail-safe: no usable hash => singleton, never collapses
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h).push(c.blind)
  }
  const infoByBlind = {} // letter -> {rep, group} (only for members of a >=2 group)
  for (const letters of byHash.values()) {
    if (letters.length < 2) continue // singleton: nothing to merge, no collapse field
    const group = [...letters].sort() // deterministic; group[0] = lowest letter = representative
    const rep = group[0]
    for (const l of letters) infoByBlind[l] = { rep, group }
  }
  return (staged || []).map(c => {
    const info = c && c.valid ? infoByBlind[c.blind] : null
    return info ? { ...c, collapse: { rep: info.rep, group: info.group } } : c
  })
}

// The dedup contention predicate — the ONLY new judging gate. A VALID candidate is in contention
// unless it is a NON-representative duplicate (collapsed into another letter). A collapsed non-rep
// stays valid:true but drops out of the pool/council/tally EXACTLY as an invalid candidate already
// does (it simply never appears in the valid-list), so no tally/veto/no_consensus branch changes.
function inContention(c) {
  return !!(c && c.valid) && !(c.collapse && c.collapse.rep !== c.blind)
}

// The judge-visible convergence stamp line for a representative that absorbed >=1 duplicate, or null
// (singleton / non-rep => no stamp). Letters + a COUNT only — no hash, path, or model text — so
// blindness holds structurally. That convergence is itself evidence of the brief's determinism.
function convergenceLineFor(c) {
  if (!c || !c.collapse || c.collapse.rep !== c.blind) return null
  const group = Array.isArray(c.collapse.group) ? c.collapse.group : []
  if (group.length < 2) return null
  return `CONVERGENCE: ${group.length} implementers produced this identical artifact (candidates ${group.join(', ')}); that convergence is evidence of the brief's determinism`
}
// ---- end: identical-candidate dedup -----------------------------------------------------------

// ---- begin: dynamic M (issue #36) -------------------------------------------------------------
// PURE seat-trimming + evidence parsing (extract-and-eval'able). When prior SAME-TASK runs show the
// winning brief converges deterministically (identical implement candidates collapse), the engine
// MAY seat fewer implementers. Fail-open, reduce-only, floored: any missing/thin/malformed evidence
// returns the seat list UNCHANGED, and a trim never drops below M_FLOOR. Cross-run evidence comes
// from bin/je-ledger.mjs (read impurely by the caller); this block only DECIDES.
const DYNAMIC_M = {
  MIN_SAMPLES: 5,       // the ledger's own n>=5 hypothesis bar — never act on thinner evidence
  CONVERGE_RATIO: 0.50, // same-bucket convergence ratio at/above which a trim may fire
  M_FLOOR: 2,           // never seat fewer than this — a real contest still needs >=2 implementers
}
// Parse the ledger runner's one-line convergence readout for a task bucket. Returns
// { samples, convergenceRatio } or null (no/garbled line => fail-open no-op upstream).
function parseConvergenceEvidence(text) {
  const m = /JE-LEDGER-CONVERGENCE\s+samples=(\d+)\s+ratio=([0-9]*\.?[0-9]+)/.exec(String(text == null ? '' : text))
  if (!m) return null
  const samples = parseInt(m[1], 10)
  const convergenceRatio = parseFloat(m[2])
  if (!Number.isFinite(samples) || !Number.isFinite(convergenceRatio)) return null
  return { samples, convergenceRatio }
}
// Decide the (possibly shorter) implement-seat list. `seats` is returned UNCHANGED (same reference)
// unless the same-bucket evidence clears BOTH the sample floor and the convergence threshold, in
// which case exactly one seat is shed (reduce-only ratchet), never below M_FLOOR. The result is
// always a prefix slice (stable seat identities), never reordered or grown.
function trimSeatsForConvergence(seats, evidence, opts = DYNAMIC_M) {
  if (!Array.isArray(seats) || seats.length <= opts.M_FLOOR) return seats
  if (!evidence || typeof evidence !== 'object') return seats
  const n = Number(evidence.samples)
  const ratio = Number(evidence.convergenceRatio)
  if (!Number.isFinite(n) || n < opts.MIN_SAMPLES) return seats           // sample-size floor
  if (!Number.isFinite(ratio) || ratio < opts.CONVERGE_RATIO) return seats // below trim threshold
  const target = Math.max(opts.M_FLOOR, seats.length - 1)                  // shed at most one seat
  return target >= seats.length ? seats : seats.slice(0, target)
}
// ---- end: dynamic M ---------------------------------------------------------------------------
// Snapshot of the accumulator at each terminal site (return value, mapping.json, SUMMARY.md). Computed
// fresh at every call so the summary reflects all seats observed so far (including auto-issue outcomes).
const rcSummaryLive = () => buildRcSummary(seatRcs)
// Auto-issue args (spec §3, default-ON for engine-fault classes; fail-closed + fire-and-forget):
//   noAutoIssue:true  -> skip filing entirely
//   issueRunner       -> absolute path to bin/je-issue.sh (absent => skip, logged once)
//   engineRepo        -> owner/repo to pin GH_REPO to (default = the public canonical repo)
const engineRepo = A.engineRepo || 'robanderson/joust-engine'
const autoIssue = A.noAutoIssue !== true && !!A.issueRunner
let autoIssueWarned = false
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
  // model: HELPER_MODEL is set even for agentType (runner-wrapper) dispatches: an explicit model
  // OVERRIDES the agent definition's frontmatter, and the harness does NOT reliably honour that
  // frontmatter for workflow agentType calls (observed live: 28 codex-dispatch wrappers ran on
  // HAIKU despite `model: sonnet` frontmatter — operator policy is sonnet MINIMUM for all engine
  // work; haiku's base predates strong agentic training). Native branches overwrite with a.model.
  const opts = { label: `${phaseTitle}:${a.displayModel}`, phase: phaseTitle, model: HELPER_MODEL }
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
  // agentLadder: runner dispatches (opts.agentType) pass straight through; a NATIVE anthropic
  // attempt that is blocked (throw/null) gets ONE downgrade-retry rung (model fallback ladder).
  return agentLadder(prompt, opts)
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
      // Observability: capture the never-staged / silently-lost seat through the parallel accumulator
      // (RC 09) so full seat visibility survives without touching the null-filter or return shape.
      recordSeat(a.label, phaseTitle, RC.UNKNOWN, 'dispatch-drop-or-null')
      return null
    })
}

// Part 2 of the mixed-family spec (2026-07-05): PINS every judge (council lens AND legacy single judge) to
// the tournament SNAPSHOT and forbids the live/current repo checkout, whose state may have moved past what
// any candidate was actually judged against (the observed wrong-tree judging failure). Applies
// UNCONDITIONALLY — no judgeMix/COUNCIL gate — because it is a correctness fix, not new opt-in behavior.
function pinnedScopeBlock(poolPath, blindList) {
  const roots = [poolPath, ...(blindList || []).map(c => c.ws)]
  const repoNote = repoMode
    ? ` Each candidate directory above is an ISOLATED git worktree checked out at base commit ${baseSha}; do not check out, diff against, or otherwise reference any other commit, branch, or the live working tree.`
    : ''
  return `\n\nPINNED EVALUATION SCOPE — read before judging: your evaluation is PINNED to this tournament's SNAPSHOT and NOTHING else. Allowed paths: ${roots.join(', ')}.${repoNote} FORBIDDEN: the live/current checkout of this repository outside the paths above (its state may have moved on since this tournament's snapshot was taken and is NOT what any candidate was judged against), and any path not listed above. If you run a verification command, run it INSIDE the listed candidate directory only, and cite that exact path in checks_run.`
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
Judge the real output / artifact — not any self-summary. Do not read any other files.${pinnedScopeBlock(poolPath, blindList)}

Score each candidate against criteria suited to the task (for code: correctness, meets stated constraints, completeness, edge cases, readability; adapt for non-code). Score against the task's STATED runtime, not an environment you cannot see: treat reliance on a capability the task did not establish is available as a risk, and treat an unfamiliar mechanism that honours the stated constraints as correct unless you can name a concrete way it fails — never reward a familiar-looking API over a constraint-honouring one on idiom alone. Thoroughness is evidence, not word count — do not reward length or verbosity per se. Give concrete, specific pros and cons per candidate. Rank them all. Name the single winner with reasoning.${guidanceBlock}

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
        // rc/rcReason (OPTIONAL, additive): the runner's terminal `JOUST-RC <code> <reason>` line,
        // relayed from the staging grep. Native candidates have no log and simply omit them; a stale
        // result without them is back-compatible. Never in `required`.
        properties: { blind: { type: 'string' }, deliverable: { type: 'boolean' }, provenance: { type: 'boolean' }, rc: { type: 'string' }, rcReason: { type: 'string' } },
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
  // KILLED added to the reject set (run E, belt-and-suspenders): only finish() ever writes it, on a
  // genuine watchdog/external kill — never on a log that ends in success (the interim -RETRY word is
  // non-terminal and deliberately NOT matched here, so a try that succeeds after a retry still passes).
  return `if [ -f ${lp} ]; then if grep -q '^JOUST-${tok}-PROVENANCE endpoint=' ${lp} && grep -q '^JOUST-${tok}-DONE exit=0' ${lp} && ! grep -q '^JOUST-${tok}-\\(TIMEOUT\\|ERROR\\|KILLED\\)' ${lp}; then P=1; else P=0; fi; else P=0; fi`
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
        properties: { path: { type: 'string' }, bytes: { type: 'integer' }, sha: { type: 'string' } },
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
// Mechanical patch gate stamp plumbing (run F). MECHANICAL/JMECH are provider-neutral literals —
// like JOUST-, they are deliberately NOT rebrand tokens and stay byte-identical in the dev copy.
const MECH_FALLBACK = 'MECHANICAL: check unavailable\n'
const MECH_GRAMMAR = '^MECHANICAL: (patch applies cleanly.*|patch is well-formed .*|git apply --check FAILED:.*|no patch found .*|no deliverable|check unavailable)$'
// Shell snippet: emit the pooled "--- Mechanical check ---" block for one candidate dir, grammar-
// guarded. Shared by mechanicalPatchGate's pool rebuild AND enrichBlindPool's rebuild loop, so the
// two pool writers can never drift.
function mechStampShell(dest) {
  const f = `${dest}/mechanical.txt`
  return `printf '\\n--- Mechanical check ---\\n'; if grep -Eq ${q(MECH_GRAMMAR)} ${q(f)} 2>/dev/null; then cat ${q(f)}; else printf '%s' ${q(MECH_FALLBACK)}; fi`
}
// Run G contract-stamp plumbing. CONTRACT/JCON are provider-neutral literals — like MECHANICAL/
// JMECH they are deliberately NOT rebrand tokens and stay byte-identical in the dev copy.
// There is NO CONTRACT fallback constant on purpose: the run-G fail-safe is DEGRADE TO UNSTAMPED —
// a missing or grammar-violating contract.txt emits no "--- Contract check ---" block at all
// (contrast MECH_FALLBACK, which always stamps), so a gate that could not run leaves the pool
// exactly as it was pre-run-G and infra noise never reads as a candidate signal.
const CONTRACT_GRAMMAR = '^CONTRACT: (conforming \\(.*\\)|non-conforming layout \\(.*\\))$'
// Shell snippet: emit the pooled "--- Contract check ---" block for one candidate dir, grammar-
// guarded. Shared by mechanicalPatchGate's pool rebuild AND enrichBlindPool's rebuild loop, so
// the two pool writers can never drift (exactly mirrors mechStampShell).
function contractStampShell(dest) {
  const f = `${dest}/contract.txt`
  return `if grep -Eq ${q(CONTRACT_GRAMMAR)} ${q(f)} 2>/dev/null; then printf '\\n--- Contract check ---\\n'; cat ${q(f)}; fi`
}
// Issue #36 convergence-stamp plumbing. CONVERGENCE is a provider-neutral literal — like MECHANICAL/
// CONTRACT it is deliberately NOT a rebrand token and stays byte-identical in the dev copy. `line` is
// the engine-computed stamp (convergenceLineFor — letters + a count only, blindness holds) for a
// representative that absorbed duplicates; a null/empty line emits NOTHING (singleton / non-rep).
// Shared by BOTH pool-rebuild writers (mechanicalPatchGate + enrichBlindPool) so they cannot drift,
// mirroring mechStampShell/contractStampShell.
function convergenceStampShell(line) {
  if (!line) return ':' // no-op shell builtin — emits nothing for singletons / non-reps
  return `printf '\\n--- Convergence check ---\\n%s\\n' ${q(line)}`
}

const MECH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        // `contract` (run G): the JCON layout-conformance token, folded into the SAME entry the
        // way stageAndValidate folds JRC into JEV entries. OPTIONAL and never in `required`, so a
        // helper that forgets the JCON lines degrades only the contract axis (=> 'unavailable',
        // unstamped) and can never knock out the mechanical classification with it.
        // `hash` (issue #36): the JHASH content-hash token over the pre-stamp deliverable bytes,
        // folded into the SAME entry. OPTIONAL and never in `required`; a missing hash simply means
        // that candidate never collapses (fail-safe singleton).
        properties: { blind: { type: 'string' }, class: { type: 'string' }, detail: { type: 'string' }, contract: { type: 'string' }, hash: { type: 'string' } },
        required: ['blind', 'class'],
      },
    },
  },
  required: ['results'],
}

// Pre-council mechanical gate (run F): classify each VALID staged implement candidate's deliverable
// BEFORE the code council convenes — one HELPER_MODEL agent, one deterministic script, once per
// round, never per judge (retires the 5-6x duplicated apply-checks the 9-run audit observed).
// Run G: the SAME script/call also classifies deliverable-contract layout conformance (JCON lines
// -> the deliverable-contract-gate block) — no second helper round-trip, no new agent step.
// Snapshot-pinned: repoMode verifies against a DETACHED scratch worktree at baseSha; without a
// snapshot it degrades to a structure-only well-formedness check in a throwaway `git init` repo
// (catches the audited corrupt class: malformed/truncated diffs); no git/scratch => 'unavailable'.
// Fail-safe end to end: any infra failure degrades to 'unavailable' and invalidates nothing.
async function mechanicalPatchGate(staged, reviewDir, phaseTitle) {
  const targets = staged.filter(c => c.valid)
  if (!targets.length) return staged
  const baseArg = repoMode && baseSha ? q(baseSha) : `''`
  const perCandidate = targets.map(c => {
    const dest = `${reviewDir}/${c.blind}`
    return `(` +
      `dest=${q(dest)}; mech=${q(`${dest}/mechanical.txt`)}; base=${baseArg}; ` +
      // Baseline fallback (run-i post-mortem): no repoMode baseSha => use the HEAD sha pinned at
      // context-bundle time, so non-repo runs get a REAL apply baseline instead of an empty repo.
      `[ -z "$base" ] && [ -s ${q(gateBaseShaFile)} ] && base=$(cat ${q(gateBaseShaFile)} 2>/dev/null); ` +
      // ALL patches, sorted (0001, 0002, ...): run-i showed `head -n1` made a multi-patch
      // deliverable's fate a find-order coin flip. candidate.diff (engine-generated, repoMode)
      // stays a single -p0 diff.
      `patches=''; p0=0; ` +
      `if [ -s "$dest/candidate.diff" ]; then patches="$dest/candidate.diff"; p0=1; ` +
      `else patches=$(find "$dest" -maxdepth 3 -type f \\( -iname '*.patch' -o -iname '*.diff' \\) 2>/dev/null | sort); ` +
      `  if [ -z "$patches" ]; then patches=$(grep -rlE '^(diff --git |@@ -[0-9]|--- (a/|/dev/null))' "$dest" 2>/dev/null | head -n1); fi; fi; ` +
      `nfiles=$(find "$dest" -type f ! -name mechanical.txt ! -name contract.txt 2>/dev/null | grep -c .); ` +
      `cls=''; detail=''; ` +
      `if [ "$nfiles" -eq 0 ]; then cls=empty; ` +
      `elif [ -z "$patches" ]; then cls=full_files; ` +
      `elif ! command -v git >/dev/null 2>&1; then cls=unavailable; ` +
      `else ` +
        `scratch=$(mktemp -d 2>/dev/null) || scratch=''; snapmode=''; top=''; ` +
        `if [ -n "$scratch" ] && [ -n "$base" ] && top=$(git rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ]; then ` +
          `git -C "$top" worktree add --detach "$scratch/wt" "$base" >/dev/null 2>&1 && snapmode=snapshot; fi; ` +
        `wt="$scratch/wt"; ` +
        `if [ -z "$snapmode" ] && [ -n "$scratch" ]; then wt="$scratch/wt"; mkdir -p "$wt" && git init -q "$wt" >/dev/null 2>&1 && snapmode=structure; fi; ` +
        `if [ -z "$snapmode" ]; then cls=unavailable; else ` +
          `pflag=''; [ "$p0" -eq 1 ] && pflag='-p0'; recount=''; cls=clean_patch; ` +
          // snapshot: APPLY each patch FOR REAL in sorted order (numbered patches may stack —
          // 0002 can depend on 0001; independent --check of each against base false-fails those).
          // The worktree is disposable, so a real apply is safe and mirrors APPLY.md semantics.
          // structure (no repo reachable): parse-only well-formedness via --numstat — an empty
          // `git init` repo can NEVER pass a modify-patch under --check, so --check there is a
          // false-kill machine (run-i: 11/12 candidates), while --numstat still catches the
          // audited malformed/truncated class and cannot false-kill.
          `for p in $patches; do ` +
            `if [ "$snapmode" = snapshot ]; then ` +
              `if err=$(git -C "$wt" apply $pflag "$p" 2>&1); then :; ` +
              `elif err=$(git -C "$wt" apply --recount $pflag "$p" 2>&1); then recount=1; ` +
              `else cls=corrupt_patch; detail=$(printf '%s' "$err" | head -n1 | cut -c1-200); break; fi; ` +
            `else ` +
              `if err=$(git -C "$wt" apply --numstat $pflag "$p" 2>&1 >/dev/null); then :; ` +
              `else cls=corrupt_patch; detail=$(printf '%s' "$err" | head -n1 | cut -c1-200); break; fi; ` +
            `fi; ` +
          `done; ` +
          `if [ "$cls" = clean_patch ]; then if [ "$snapmode" = structure ]; then detail=structure; elif [ -n "$recount" ]; then detail=recount; else detail=''; fi; fi; ` +
        `fi; ` +
        `if [ -n "$scratch" ]; then [ "$snapmode" = snapshot ] && git -C "$top" worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "$scratch"; fi; ` +
      `fi; ` +
      `case "$cls" in ` +
      `clean_patch) if [ "$detail" = structure ]; then printf 'MECHANICAL: patch is well-formed (structure-only; no snapshot to context-check)\\n' > "$mech"; elif [ "$detail" = recount ]; then printf 'MECHANICAL: patch applies cleanly (--recount)\\n' > "$mech"; else printf 'MECHANICAL: patch applies cleanly\\n' > "$mech"; fi;; ` +
      `corrupt_patch) printf 'MECHANICAL: git apply --check FAILED: %s\\n' "$detail" > "$mech";; ` +
      `full_files) printf 'MECHANICAL: no patch found (full-files deliverable)\\n' > "$mech";; ` +
      `empty) printf 'MECHANICAL: no deliverable\\n' > "$mech";; ` +
      `*) printf 'MECHANICAL: check unavailable\\n' > "$mech";; esac; ` +
      `grep -Eq ${q(MECH_GRAMMAR)} "$mech" || printf '%s' ${q(MECH_FALLBACK)} > "$mech"; ` +
      // ---- contract layout detection (run G) — see the deliverable-contract-gate block. repoMode
      // is injected as a JS literal (engine_diff by construction: the shell must never misread a
      // candidate-authored file named candidate.diff as engine output); non-repoMode checks the
      // fixed contract names only — presence + non-emptiness, never candidate file CONTENT, and no
      // candidate text is ever interpolated into the stamp (fixed literals, blind letters only).
      `ccls=${repoMode ? 'engine_diff' : `''`}; ` +
      `if [ -z "$ccls" ]; then ` +
        `pn=$(find "$dest/patches" -maxdepth 1 -type f \\( -iname '*.patch' -o -iname '*.diff' \\) -size +0c 2>/dev/null | grep -c .); ` +
        `fn=$(find "$dest/files" -type f -size +0c 2>/dev/null | grep -c .); ` +
        `if [ "$pn" -gt 0 ] && [ -s "$dest/APPLY.md" ] && [ -s "$dest/VERIFY.md" ]; then ccls=patch_layout; ` +
        `elif [ "$fn" -gt 0 ] && [ -s "$dest/APPLY.md" ]; then ccls=files_layout; ` +
        `else ccls=freeform; fi; ` +
      `fi; ` +
      `ctr="$dest/contract.txt"; ` +
      `case "$ccls" in ` +
      `patch_layout) printf 'CONTRACT: conforming (patch layout: patches/ + APPLY.md + VERIFY.md)\\n' > "$ctr";; ` +
      `files_layout) printf 'CONTRACT: conforming (full-files fallback: files/ + APPLY.md)\\n' > "$ctr";; ` +
      `engine_diff) printf 'CONTRACT: conforming (engine-generated diff; repoMode)\\n' > "$ctr";; ` +
      `freeform) printf 'CONTRACT: non-conforming layout (grandfathered v1; judge code quality, not packaging)\\n' > "$ctr";; ` +
      `*) rm -f "$ctr";; esac; ` +
      // Degrade-to-unstamped guard: anything not matching the closed grammar is DELETED, so
      // contractStampShell emits no block for it (run-G fail-safe; no fallback stamp on purpose).
      `grep -Eq ${q(CONTRACT_GRAMMAR)} "$ctr" 2>/dev/null || rm -f "$ctr"; ` +
      // Identity hash (issue #36): sha256 over a MANIFEST of the candidate's PRE-STAMP deliverable —
      // one `shasum -a 256` line per file (digest + ./relative-path), sorted, hashed again. The
      // manifest (not a bare byte concatenation) encodes file boundaries, names, and count, so two
      // DIFFERENT trees can never alias to one identity by shifting bytes across file boundaries
      // (codex-review security finding, 2026-07-06: 'ab'+'c' vs 'abc' concatenate identically).
      // Paths are $dest-RELATIVE (cd + find .), so identical deliverables under distinct blind
      // letters still produce an identical hash; engine-written stamp files stay excluded so stamp
      // jitter never breaks a genuine match. An empty file-set OR a missing shasum both degrade to
      // NONE (singleton, never collapses) — two zero-file valid deliverables can never false-merge.
      `nfiles=$(find "$dest" -type f ! -name mechanical.txt ! -name contract.txt ! -name convergence.txt ! -name enrichment.txt -print0 2>/dev/null | tr -dc '\\0' | wc -c | tr -d ' '); ` +
      `if [ "\${nfiles:-0}" -gt 0 ] && command -v shasum >/dev/null 2>&1; then h=$(cd "$dest" && find . -type f ! -name mechanical.txt ! -name contract.txt ! -name convergence.txt ! -name enrichment.txt -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 2>/dev/null | sort | shasum -a 256 2>/dev/null | cut -d' ' -f1); else h=NONE; fi; ` +
      `echo "JMECH ${c.blind} $cls $detail"; ` +
      `echo "JCON ${c.blind} $ccls"; ` +
      `echo "JHASH ${c.blind} ${'${h:-NONE}'}"` +
      `)`
  }).join('\n')
  const res = await agentLadder(
    `Run this exact shell script in ONE Bash call. It prints three lines per candidate: "JMECH <letter> <class> [detail]", "JCON <letter> <class>", and "JHASH <letter> <hash|NONE>". Then return the structured results: for EACH printed JMECH line an entry {blind: the letter, class: the class token, detail: the rest of the line after the class (omit if empty)}; set that same entry's contract to the class token from the matching letter's JCON line (omit contract if that line is missing); and set that same entry's hash to the token after the letter on the matching JHASH line (omit hash if the line is missing or the token is "NONE"). Report exactly what the script printed — do not infer, judge, or change values. Do not expose any other command output.\n\n${perCandidate}`,
    { model: HELPER_MODEL, schema: MECH_SCHEMA, phase: phaseTitle, label: 'mechanical-gate' }
  ).catch(() => null)
  const byBlind = {}
  for (const r of (res && Array.isArray(res.results) ? res.results : [])) byBlind[String(r.blind).trim()] = r
  // Run G: the contract merge runs AFTER the mechanical merge and is purely additive (attaches
  // c.contract, never touches valid/failReason). byBlind entries carry the optional JCON token.
  const merged = mergeContract(mergeMechanical(staged, byBlind), byBlind, repoMode)
  // Dedup (issue #36): group byte-identical VALID deliverables by the relayed content hash; attach
  // an additive `collapse` field to every member (rep = lowest blind letter). Non-rep duplicates
  // stay valid:true but drop out of judging via inContention below. Fail-safe: a missing/NONE hash
  // never collapses (singleton). Any hash/parse/rebuild failure leaves staging byte-identical to today.
  const byHash = {}
  for (const r of (res && Array.isArray(res.results) ? res.results : [])) {
    const h = r && typeof r.hash === 'string' ? r.hash.trim().toLowerCase() : ''
    // STRICT sha256 shape required (codex-review security finding, 2026-07-06): the hash is a
    // RELAYED token, and grouping on any non-empty string lets a corrupted/dishonest relay return
    // the same junk token (e.g. "same") for unrelated candidates — forging a collapse + convergence
    // stamp and suppressing a real candidate from judging. Non-hex tokens degrade to no-collapse
    // (fail-open singleton), exactly like NONE.
    if (/^[0-9a-f]{64}$/.test(h)) byHash[String(r.blind).trim()] = h
  }
  const grouped = groupIdenticalCandidates(merged, byHash)
  // Observability: a corrupt-patch invalidation records a DISTINCT :mech seat (RC 04) — the main seat
  // already recorded its staging RC; this makes the mechanical exclusion visible without double-counting.
  for (const c of merged) if (c.mechanical && c.mechanical.class === 'corrupt_patch') recordSeatOnce(`${c.label || c.blind}:mech`, phaseTitle, RC.INVALID, 'mechanical-corrupt-patch')
  // Non-repoMode: stageAndValidate already built _pool.md and enrichBlindPool will NOT run, so rebuild
  // the pool here from the still-valid candidates (mirrors stageAndValidate's section format exactly)
  // + the stamp block. repoMode: enrichBlindPool's rebuild carries the stamp via mechStampShell.
  if (!repoMode) {
    const pool = `${reviewDir}/_pool.md`
    const rebuild = [`tmp=${q(`${pool}.mech`)}`, `: > "$tmp"`].concat(grouped.filter(inContention).map(c => {
      const dest = `${reviewDir}/${c.blind}`
      return `{ echo "===== Candidate ${c.blind} ====="; find ${q(dest)} -type f ! -name mechanical.txt ! -name contract.txt ! -name convergence.txt -print0 2>/dev/null | xargs -0 cat 2>/dev/null; ${mechStampShell(dest)}; ${contractStampShell(dest)}; ${convergenceStampShell(convergenceLineFor(c))}; echo; } >> "$tmp"`
    })).concat([`mv -f "$tmp" ${q(pool)}`]).join('\n')
    await agentLadder(
      `Run this exact shell script in ONE Bash call. It atomically rebuilds the blind pool with mechanical-check stamps. Do not print, summarize, or expose command output; do nothing else:\n\n${rebuild}`,
      { model: HELPER_MODEL, phase: phaseTitle, label: 'mechanical-pool' }
    ).catch(() => null)
  }
  return grouped
}

// G2 evidence-stamp plumbing (INVESTIGATE→COMPOSITE v1). EVIDENCE/JEVID are provider-neutral
// literals — like MECHANICAL/JMECH they are deliberately NOT rebrand tokens and stay byte-identical
// in the dev copy. The fail-safe is DEGRADE TO UNSTAMPED (the contract-gate discipline): a missing
// or grammar-violating evidence.txt emits no "--- Evidence check ---" block at all, so pass-infra
// noise never becomes a composer-visible signal.
function evidenceStampShell(dest) {
  const f = `${dest}/evidence.txt`
  return `if grep -Eq ${q(EVIDENCE_GRAMMAR)} ${q(f)} 2>/dev/null; then printf '\\n--- Evidence check ---\\n'; cat ${q(f)}; fi`
}

const EVIDENCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { blind: { type: 'string' }, cited: { type: 'number' }, verified: { type: 'number' } },
        required: ['blind', 'cited', 'verified'],
      },
    },
  },
  required: ['results'],
}

// G2 evidence-verification pass (investigate runs only): one HELPER_MODEL agent, one deterministic
// shell script, once per round — mechanicalPatchGate's shape exactly. AFTER staging (and the
// repoMode enrichment rebuild), BEFORE the composeOnly pool return: for each VALID candidate,
// extract its cited paths (grep -ohE CITE_GREP — the shell twin of parseCitations), grep-check each
// against the snapshot/context (working tree at the repo top, the pinned baseSha via git cat-file,
// or the shared context bundle), stamp `EVIDENCE: n cited, m verified` into evidence.txt, and
// rebuild the blind pool with the stamp (letters only — no path, no candidate text, no identity).
// FAIL-SAFE: an unverifiable citation is stamped-but-unverified; a dead helper / garbled counts
// degrade to unstamped; NOTHING here invalidates a candidate (mergeEvidence is purely additive).
async function evidenceVerificationPass(staged, reviewDir, phaseTitle) {
  if (!investigate) return staged
  const targets = staged.filter(c => c.valid)
  if (!targets.length) return staged
  const baseArg = repoMode && baseSha ? q(baseSha) : `''`
  const ctxArg = contextPath ? q(contextPath) : `''`
  const perCandidate = targets.map(c => {
    const dest = `${reviewDir}/${c.blind}`
    return `(` +
      `dest=${q(dest)}; ev=${q(`${dest}/evidence.txt`)}; base=${baseArg}; ctx=${ctxArg}; ` +
      `cites=$(find "$dest" -type f ! -name evidence.txt -print0 2>/dev/null | xargs -0 grep -ohE ${q(CITE_GREP)} 2>/dev/null | sed -E ${q(CITE_SED)} | sort -u); ` +
      // Citation paths carry no whitespace/globs by grammar (charset [A-Za-z0-9._-/]), so plain
      // word-splitting iteration is safe and keeps n/m in THIS shell (no subshell-pipe counter loss).
      `n=0; m=0; top=$(git rev-parse --show-toplevel 2>/dev/null); ` +
      `for p in $cites; do n=$((n+1)); ok=0; ` +
        `if [ -e "$p" ]; then ok=1; ` +
        `elif [ -n "$top" ] && [ -e "$top/$p" ]; then ok=1; ` +
        `elif [ -n "$top" ] && [ -n "$base" ] && git -C "$top" cat-file -e "$base:$p" >/dev/null 2>&1; then ok=1; ` +
        `elif [ -n "$ctx" ] && grep -qF -- "$p" "$ctx" 2>/dev/null; then ok=1; fi; ` +
        `[ "$ok" -eq 1 ] && m=$((m+1)); ` +
      `done; ` +
      `printf 'EVIDENCE: %s cited, %s verified\\n' "$n" "$m" > "$ev"; ` +
      // Degrade-to-unstamped guard: anything not matching the closed grammar is DELETED, so
      // evidenceStampShell emits no block for it (fail-safe; no fallback stamp on purpose).
      `grep -Eq ${q(EVIDENCE_GRAMMAR)} "$ev" 2>/dev/null || rm -f "$ev"; ` +
      `echo "JEVID ${c.blind} $n $m"` +
      `)`
  }).join('\n')
  const res = await agentLadder(
    `Run this exact shell script in ONE Bash call. It prints one line per candidate of the form "JEVID <letter> <cited> <verified>". Then return the structured results: for EACH printed JEVID line an entry {blind: the letter, cited: the first number, verified: the second number}. Report exactly what the script printed — do not infer, judge, or change values. Do not expose any other command output.\n\n${perCandidate}`,
    { model: HELPER_MODEL, schema: EVIDENCE_SCHEMA, phase: phaseTitle, label: 'evidence-gate' }
  ).catch(() => null)
  const byBlind = {}
  for (const r of (res && Array.isArray(res.results) ? res.results : [])) byBlind[String(r.blind).trim()] = r
  const merged = mergeEvidence(staged, byBlind)
  // Rebuild the pool from the still-valid candidates (stageAndValidate's section format + the
  // grammar-guarded stamp block — the mechanical-gate rebuild discipline; engine stamp files are
  // excluded from the cat and re-emitted only through their guarded stamp shells).
  const pool = `${reviewDir}/_pool.md`
  const rebuild = [`tmp=${q(`${pool}.evid`)}`, `: > "$tmp"`].concat(merged.filter(c => c.valid).map(c => {
    const dest = `${reviewDir}/${c.blind}`
    return `{ echo "===== Candidate ${c.blind} ====="; find ${q(dest)} -type f ! -name evidence.txt ! -name mechanical.txt ! -name contract.txt -print0 2>/dev/null | xargs -0 cat 2>/dev/null; ${evidenceStampShell(dest)}; echo; } >> "$tmp"`
  })).concat([`mv -f "$tmp" ${q(pool)}`]).join('\n')
  await agentLadder(
    `Run this exact shell script in ONE Bash call. It atomically rebuilds the blind pool with evidence-verification stamps. Do not print, summarize, or expose command output; do nothing else:\n\n${rebuild}`,
    { model: HELPER_MODEL, phase: phaseTitle, label: 'evidence-pool' }
  ).catch(() => null)
  return merged
}

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
    // Surface the runner's terminal JOUST-RC line (observability). Appended after the JEV line so the
    // helper agent relays it too; native candidates (no log) emit nothing here.
    const rcEcho = lp ? `; rcline=$(grep -a '^JOUST-RC ' ${lp} 2>/dev/null | tail -n1); echo "JRC ${c.blind} ${'${rcline:-NONE}'}"` : ''
    if (repoMode) {
      // repoMode: the blind artifact is a DIFF, not a copied workspace. Capture `git diff <baseSha> HEAD`
      // (no author/date/branch/message metadata leaks into judging) and keep the same D/P pool gate + JEV
      // line protocol. The carried-over round-1 winner is already a staged candidate.diff (not a live
      // worktree), so copy it forward and keep the D-0004 provenance skip (provChk -> P=1 for carryover).
      if (c.carriedOver) {
        return `mkdir -p ${q(dest)}; if [ -s ${q(`${c.ws}/candidate.diff`)} ]; then cp ${q(`${c.ws}/candidate.diff`)} ${q(diffPath)}; D=1; else D=0; fi; ${provChk}; ` +
               `if [ "$D" -gt 0 ] && [ "$P" -eq 1 ]; then { echo "===== Candidate ${c.blind} ====="; cat ${q(diffPath)} 2>/dev/null; echo; } >> ${q(pool)}; fi; ` +
               `echo "JEV ${c.blind} d=$([ "$D" -gt 0 ] && echo 1 || echo 0) p=$P"${rcEcho}`
      }
      return `mkdir -p ${q(dest)}; git -C ${q(c.ws)} diff ${q(baseSha)} HEAD --no-color --no-prefix > ${q(diffPath)} 2>/dev/null; ` +
             `if [ -s ${q(diffPath)} ]; then D=1; else D=0; fi; ${provChk}; ` +
             `if [ "$D" -gt 0 ] && [ "$P" -eq 1 ]; then { echo "===== Candidate ${c.blind} ====="; cat ${q(diffPath)} 2>/dev/null; echo; } >> ${q(pool)}; fi; ` +
             `echo "JEV ${c.blind} d=$([ "$D" -gt 0 ] && echo 1 || echo 0) p=$P"${rcEcho}`
    }
    return `mkdir -p ${q(dest)}; cp -R ${q(c.ws)}/. ${q(dest)}/ 2>/dev/null; ` +
           `rm -f ${q(dest)}/_brief.txt ${q(dest)}/_glm_run.log ${q(dest)}/_local_run.log ${q(dest)}/_codex_run.log ${q(dest)}/_codex_last.txt ${q(dest)}/_minimax_run.log ${q(dest)}/_grok_run.log; ` +
           `find ${q(dest)} -mindepth 1 ! -type f ! -type d -delete 2>/dev/null; ` +
           `D=$(find ${q(dest)} -type f 2>/dev/null | grep -c .); ${provChk}; ` +
           `if [ "$D" -gt 0 ] && [ "$P" -eq 1 ]; then { echo "===== Candidate ${c.blind} ====="; find ${q(dest)} -type f -print0 2>/dev/null | xargs -0 cat 2>/dev/null; echo; } >> ${q(pool)}; fi; ` +
           `echo "JEV ${c.blind} d=$([ "$D" -gt 0 ] && echo 1 || echo 0) p=$P"${rcEcho}`
  })).join('\n')
  const res = await agentLadder(
    `Run this exact shell script in ONE Bash call. It prints one line per candidate of the form "JEV <letter> d=<0|1> p=<0|1>", and (for runner candidates only) a matching line "JRC <letter> JOUST-RC <code> <reason>" or "JRC <letter> NONE". Then return the structured results: for EACH printed JEV line, an entry {blind: the letter, deliverable: (d==1), provenance: (p==1)}; and for the matching JRC line, set that blind's rc to the two-digit <code> and rcReason to the <reason> text after "JOUST-RC" ("NONE" or no JRC line => omit rc/rcReason). Report exactly what the script printed — do not infer or change values.\n\n${script}`,
    { model: HELPER_MODEL, schema: STAGE_SCHEMA, phase: phaseTitle, label: 'stage' }
  ).catch(() => null)
  const v = {}
  for (const r of (res && Array.isArray(res.results) ? res.results : [])) v[String(r.blind).trim()] = r
  return list.map(c => {
    const r = v[c.blind]                           // FAIL CLOSED: missing/unparsed → invalid
    const valid = !!(r && r.deliverable && r.provenance)
    const failReason = valid ? '' : (!r ? 'staging result missing (failed closed)' : (!r.deliverable ? 'no deliverable saved' : 'provenance check failed (timeout/error/empty)'))
    // ---- per-seat RC derivation (observability only; additive fields, no consumer contract change).
    // A runner candidate carries a JOUST-RC line in its engine log; parse it and let the runner's own
    // code win unless it said 00 while staging rejected the deliverable (then staging truth wins). A
    // native anthropic attempt has no runner log — derive purely from staging truth. dispatchedOk is
    // true here (it survived dispatch to reach staging; null/throw seats were recorded in dispatch()).
    const isRunner = c.dispatch && c.dispatch !== 'anthropic'
    const runnerLog = isRunner ? (c.dispatch === 'glm' ? '_glm_run.log'
      : c.dispatch === 'local' ? '_local_run.log' : c.dispatch === 'codex' ? '_codex_run.log'
      : c.dispatch === 'minimax' ? '_minimax_run.log' : c.dispatch === 'grok' ? '_grok_run.log' : '') : ''
    const logPath = runnerLog ? engineLogPath(c, runnerLog) : ''
    // The runner's JOUST-RC line was already relayed in the staging result when present (r.rc); when it
    // was not captured, deriveRunnerAttemptRc falls back to staging truth (a runner with no JOUST-RC
    // line is itself an RC-09 signal). Native seats derive from staging directly.
    const seat = isRunner
      ? deriveRunnerAttemptRc({ runnerRc: (r && r.rc) || (valid ? RC.OK : null), runnerReason: r && r.rcReason, valid, failReason })
      : deriveNativeAttemptRc({ dispatchedOk: true, valid, failReason })
    recordSeat(c.label || c.blind, phaseTitle, seat.rc, seat.reason, logPath || undefined)
    // Staging changes ws to the blind review directory. Phase 5 still needs the runnable checkout;
    // expose it only in repoMode so the legacy object shape and all legacy consumers stay unchanged.
    // The per-seat rc/rcReason are attached AFTER construction (additive; no consumer contract change).
    const staged = repoMode
      ? { ...c, liveWs: c.ws, ws: `${reviewDir}/${c.blind}`, valid, failReason }
      : { ...c, ws: `${reviewDir}/${c.blind}`, valid, failReason }
    staged.rc = seat.rc
    staged.rcReason = seat.reason
    return staged
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
           `${mechStampShell(dest)}; ` +
           `${contractStampShell(dest)}; ` +
           `${convergenceStampShell(convergenceLineFor(c))}; ` +
           `printf '\\n'; } >> "$tmp"`
  }), `mv -f "$tmp" ${q(pool)}`].join('\n')
  const script = `${perCandidate}\n${rebuild}`
  await agentLadder(
    `Run this exact shell script in ONE Bash call. It runs blind tournament checks and atomically rebuilds the blind pool. Do not print, summarize, or expose command output; do nothing else:\n\n${script}`,
    { model: HELPER_MODEL, phase: phaseTitle, label: 'test-lint-enrichment' }
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
// Round-2/R4 LAUNCH guard (run F fold-in): is this guidance a STUB — empty, or schema-valid junk?
// Returns a short reason (stub) or null (usable). guidanceIntegrityIssue deliberately passes an
// EMPTY set (legitimate for its producer: "nothing salient this round"), but an empty set is a stub
// for SEEDING a guided round — that gap let placeholder guidance reach round-2 briefs in 3 audited
// runs. A stub round falls back to task-only dispatch (null guidance == the round-1 shape).
function guidanceStub(g) {
  if (!g || typeof g !== 'object') return 'guidance missing'
  const n = (Array.isArray(g.positives) ? g.positives.length : 0) + (Array.isArray(g.challenges) ? g.challenges.length : 0)
  if (n === 0) return 'guidance empty (no positives or challenges)'
  return guidanceIntegrityIssue(g)
}
// ---- end: verdict integrity guard ------------------------------------------------------------


// ---- begin: codex-judge routing + verdict parsing (mixed-family council, 2026-07-05) --------------
// Every function here is PURE (no closures over module state, no I/O) so it can be extracted and
// eval'd in isolation by a test, exactly like the verdict-integrity block above (which this composes
// onto rather than re-deriving).

// Which family judges this lens, this round? 'native' (Opus, today's path) or 'codex' (codex-xhigh via
// the codex runner). legacyMix forces 'native' unconditionally (byte-identical escape hatch); a lens
// with no `judge` field (everything except spec/craft/completeness/simplicity) always stays 'native';
// a missing codexRunner also forces 'native' (fail-safe — never crash for a missing optional runner).
// 6th seat (spec addendum 2026-07-05): councils carry TWO security gates — the primary Opus
// 'security' seat plus a cross-family 'security-x' seat on codex-xhigh. Both hold veto power
// (UNION: a standing evidenced flag from EITHER excludes the candidate). Everything that gates
// security behaviour keys off this predicate; the fail-closed security-DEAD policy stays keyed
// to the PRIMARY 'security' seat only (security-x already falls back to Opus like other codex seats).
const isSecurityLens = (key) => key === 'security' || key === 'security-x'

function chooseJudgeDispatch(lens, legacyMix, codexRunnerConfigured) {
  if (legacyMix) return 'native'
  if (lens && lens.judge && lens.judge.kind === 'codex' && codexRunnerConfigured) return 'codex'
  return 'native'
}

// The paths a judge is allowed to cite in checks_run: the shared blind pool file, each candidate's own
// listed directory (worktree in repoMode, scratch dir otherwise — already the right value either way),
// and (repoMode) the shared worktree root prefix.
function allowedRootsFor(blindList, poolPath, repoModeFlag, worktreeRootVal) {
  const roots = [poolPath, ...(blindList || []).map((c) => c.ws)]
  if (repoModeFlag && worktreeRootVal) roots.push(worktreeRootVal)
  return roots
}

// Same required-key shape as LENS_R1_SCHEMA/LENS_DELIB_SCHEMA (minus the delib-only cross-talk fields,
// which are optional/best-effort for a codex verdict — see edge case 8). `safety` is OPTIONAL here:
// the cross-family security-x seat routes to codex and returns it; shape-check it when present.
function verdictShapeIssue(v) {
  if (!v || typeof v !== 'object') return 'not an object'
  if (typeof v.lens !== 'string' || !v.lens) return 'missing/invalid "lens"'
  if (!Array.isArray(v.candidates) || !v.candidates.every((c) => c && typeof c.label === 'string' && Array.isArray(c.pros) && Array.isArray(c.cons)))
    return 'missing/invalid "candidates"'
  if (!Array.isArray(v.ranking) || !v.ranking.every((r) => typeof r === 'string')) return 'missing/invalid "ranking"'
  if (typeof v.vote !== 'string' || !v.vote) return 'missing/invalid "vote"'
  if (typeof v.reasoning !== 'string') return 'missing/invalid "reasoning"'
  if (!Array.isArray(v.checks_run) || !v.checks_run.every((c) => typeof c === 'string')) return 'missing/invalid "checks_run"'
  if (v.safety !== undefined && (!Array.isArray(v.safety) || !v.safety.every((x) => x && typeof x.label === 'string' && typeof x.safety === 'string')))
    return 'invalid "safety"'
  return null
}

// Non-fatal (v1) telemetry: does any checks_run entry cite an absolute-path-looking token outside the
// pinned scope? Only flags tokens that actually LOOK like a path (leading '/'); prose-only evidence
// ("ran the build, exit 0") never trips this. Never throws, never rejects the verdict.
function checksRunRootsIssue(checksRun, allowedRoots) {
  if (!Array.isArray(checksRun) || !Array.isArray(allowedRoots) || !allowedRoots.length) return null
  const PATH_RE = /(\/[^\s'"()<>]+)/g
  const offenders = new Set()
  for (const entry of checksRun) {
    const s = String(entry == null ? '' : entry)
    let m
    PATH_RE.lastIndex = 0
    while ((m = PATH_RE.exec(s))) {
      const p = m[1].replace(/[.,;:]+$/, '')
      const inScope = allowedRoots.some((root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/'))
      if (!inScope) offenders.add(p)
    }
  }
  if (!offenders.size) return null
  return `checks_run cites path(s) outside the pinned evaluation scope: ${[...offenders].slice(0, 5).join(', ')}`
}

// Fixed sentinels the SHELL (not the LLM) emits via printf, so the engine can trust the split points
// regardless of what the LLM relays (mirrors buildContext's contextCatCmd label pattern).
const CODEX_JUDGE_LOG_MARK = '===JE-CODEX-JUDGE-LOG==='
const CODEX_JUDGE_VERDICT_MARK = '===JE-CODEX-JUDGE-VERDICT==='
const CODEX_JUDGE_SHA_MARK = '===JE-CODEX-JUDGE-SHA==='

// ---- begin: codex review-judge parsing ----------------------------------------------------------
// Review-preset judge seats (2026-07-06 judge-architecture experiment): codex judges via the
// purpose-built `codex review` preset (bounded plain-text report) instead of authoring VERDICT.json
// at the end of an open-ended exec session — VERDICT authorship was the 100%-fallback failure class
// two full runs straight. A sonnet helper then MECHANICALLY reformats the report into the verdict
// shape under a strict traceability rule (it reformats, it never judges): ranking/vote/safety MUST
// come from the report's explicit machine lines, or the seat fails over to opus exactly as before.
// parseCodexReviewDump validates the relayed dump (log tail + report, sentinel-joined) BEFORE any
// reformat spend: provenance + clean exit + a non-trivial report carrying the RANKING/VOTE lines.
function parseCodexReviewDump(rawDump) {
  const s = String(rawDump == null ? '' : rawDump)
  const li = s.indexOf(CODEX_JUDGE_LOG_MARK)
  const vi = s.indexOf(CODEX_JUDGE_VERDICT_MARK)
  if (li < 0 || vi < 0 || vi < li) return { ok: false, reason: 'codex review judge dump missing log/report markers — runner or read-back step failed' }
  const logPart = s.slice(li + CODEX_JUDGE_LOG_MARK.length, vi)
  const report = s.slice(vi + CODEX_JUDGE_VERDICT_MARK.length).trim()
  if (!/^JOUST-CODEX-PROVENANCE endpoint=/m.test(logPart)) return { ok: false, reason: 'codex review judge: no PROVENANCE marker — runner never ran' }
  if (!/^JOUST-CODEX-DONE exit=0/m.test(logPart)) return { ok: false, reason: 'codex review judge: runner did not report exit=0' }
  if (/^JOUST-CODEX-(TIMEOUT|ERROR)/m.test(logPart)) return { ok: false, reason: 'codex review judge: runner reported TIMEOUT/ERROR' }
  if (report.length < 80) return { ok: false, reason: `codex review judge: report too short (${report.length} bytes) to be a real review` }
  if (!/^RANKING:/m.test(report)) return { ok: false, reason: 'codex review judge: report has no explicit RANKING: line' }
  if (!/^VOTE:/m.test(report)) return { ok: false, reason: 'codex review judge: report has no explicit VOTE: line' }
  return { ok: true, report }
}
// checks_run is exec-mode honesty telemetry (commands the agentic session ran); the review preset's
// evidence discipline lives in the report's inline quotes instead. The verdict still needs the field
// for shape validity, so it carries this engine-written constant — never model-invented content.
const REVIEW_CHECKS_RUN = ['_pool.md (codex-review preset: evidence quoted inline in the report)']
// ---- end: codex review-judge parsing ------------------------------------------------------------

// Structured-output schema for the review-report REFORMAT helper. `found` is the traceability
// escape hatch: when the report lacks the explicit machine lines, the helper reports found:false
// (and the seat falls over) instead of inventing a ranking — the reformatter must never judge.
const CODEX_REVIEW_VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    candidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { label: { type: 'string' }, pros: { type: 'array', items: { type: 'string' } }, cons: { type: 'array', items: { type: 'string' } } },
        required: ['label', 'pros', 'cons'],
      },
    },
    ranking: { type: 'array', items: { type: 'string' } },
    vote: { type: 'string' },
    reasoning: { type: 'string' },
    safety: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { label: { type: 'string' }, safety: { type: 'string' }, severity: { type: 'string' }, evidence: { type: 'string' } },
        required: ['label', 'safety'],
      },
    },
    response_to_peers: { type: 'string' },
    changed_this_round: { type: 'boolean' },
    changed_from_round1: { type: 'boolean' },
  },
  required: ['found', 'candidates', 'ranking', 'vote', 'reasoning'],
}

// Parse+validate a codex judge seat's raw dump (log tail + VERDICT.json body, sentinel-joined). Pure:
// no I/O, no agent() calls. Reuses the EXISTING guards (verdictIntegrityIssue/checksRunIssue) rather
// than re-deriving equivalent logic. Returns {ok:true, verdict} or {ok:false, reason} — NEVER throws.
function parseCodexJudgeDump(rawDump) {
  const s = String(rawDump == null ? '' : rawDump)
  const li = s.indexOf(CODEX_JUDGE_LOG_MARK)
  const vi = s.indexOf(CODEX_JUDGE_VERDICT_MARK)
  if (li < 0 || vi < 0 || vi < li) return { ok: false, reason: 'codex judge dump missing log/verdict markers — runner or read-back step failed' }
  const logPart = s.slice(li + CODEX_JUDGE_LOG_MARK.length, vi)
  const verdictPart = s.slice(vi + CODEX_JUDGE_VERDICT_MARK.length)
  if (!/^JOUST-CODEX-PROVENANCE endpoint=/m.test(logPart)) return { ok: false, reason: 'codex judge: no PROVENANCE marker — runner never ran' }
  if (!/^JOUST-CODEX-DONE exit=0/m.test(logPart)) return { ok: false, reason: 'codex judge: runner did not report exit=0' }
  if (/^JOUST-CODEX-(TIMEOUT|ERROR)/m.test(logPart)) return { ok: false, reason: 'codex judge: runner reported TIMEOUT/ERROR' }
  let parsed
  try {
    parsed = JSON.parse(verdictPart.trim())
  } catch (e) {
    return { ok: false, reason: `codex judge: VERDICT.json is not valid JSON (${String(e).slice(0, 80)})` }
  }
  const shapeIssue = verdictShapeIssue(parsed)
  if (shapeIssue) return { ok: false, reason: `codex judge: VERDICT.json shape invalid — ${shapeIssue}` }
  const integrityIssue = verdictIntegrityIssue(parsed) || checksRunIssue(parsed.checks_run)
  if (integrityIssue) return { ok: false, reason: `codex judge verdict failed integrity check: ${integrityIssue}` }
  return { ok: true, verdict: parsed }
}
// ---- end: codex-judge routing + verdict parsing -----------------------------------------------

// Structured-output schema for the read-back agent: it relays the sentinel-joined raw dump VERBATIM in
// one string field. The engine (parseCodexJudgeDump), not the LLM, is the source of truth for the bytes.
const CODEX_JUDGE_DUMP_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { raw: { type: 'string' } },
  required: ['raw'],
}

// #6 + #7: never silently carry the wrong artifact or trust an off-spec ranking — normalize the
// judge's winner/ranking against the REAL candidate labels and repair to a full permutation.
function reconcile(result, labels, allowedRoots) {
  // Null-guard: agent() returns null if the judge dies on a terminal API error (or is skipped). Surface
  // that as a clear, catchable error instead of a cryptic "null is not an object" — judge() retries once
  // then degrades to a clean __failed partial result rather than crashing the (fully-paid) run.
  if (!result || typeof result !== 'object') throw new Error('judge returned no structured result (null)')
  // Integrity guard (EV-judge-placeholder.md): reject schema-valid junk (e.g. every field literally "test")
  // BEFORE it is repaired into a plausible-looking shape — retried once by judge()'s existing loop, same
  // path as the null-guard above, so a genuinely dead/junk judge still degrades to a clean __failed partial.
  const integrityIssue = verdictIntegrityIssue(result) || (result.guidance ? guidanceIntegrityIssue(result.guidance) : null)
  if (integrityIssue) throw new Error(`judge verdict failed integrity check: ${integrityIssue}`)
  // Snapshot-pinning roots check (forward-compatible; a NO-OP today — REVIEW_SCHEMA/RANK_SCHEMA have no
  // checks_run field, so checksRunRootsIssue(undefined, ...) always returns null). Wired here so the legacy
  // judges:1 path is covered the day the legacy schema grows a checks_run field. Non-fatal telemetry only.
  if (allowedRoots) {
    const rootsIssue = checksRunRootsIssue(result.checks_run, allowedRoots)
    if (rootsIssue) log(`JE-COUNCIL-WARNING: ${rootsIssue} — non-fatal (v1 telemetry); verdict still accepted.`)
  }
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
async function judge(kind, blindList, guidanceWanted, poolPath, schema, phaseTitle, label, lenses = defaultLensesFor(phaseTitle), style = 'final') {
  if (COUNCIL) return councilJudge(kind, blindList, guidanceWanted, poolPath, phaseTitle, label, lenses, style)
  const prompt = judgePrompt(kind, blindList, guidanceWanted, poolPath)
  for (let i = 1; i <= 2; i++) {
    try {
      return reconcile(await agent(prompt, { model: 'opus', schema, phase: phaseTitle, label }), blindList.map(c => c.blind), allowedRootsFor(blindList, poolPath, repoMode, worktreeRoot))
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
  { key: 'spec', owns: 'compliance and completeness — is EVERYTHING that was asked done, and are the stated constraints honoured', special: 'You catch the "works but solved the wrong task" failure.', judge: { kind: 'codex', displayModel: 'codex-xhigh' } },
  { key: 'security', owns: 'vulnerabilities, injected execution, secret/credential exposure, supply-chain and build-config risk', special: 'You hold the council VETO.' },
  { key: 'robustness', owns: 'edge cases, failure modes, boundaries, error handling', special: 'Probe what breaks it, not just the happy path.' },
  { key: 'craft', owns: 'readability, structure, maintainability, efficiency', special: 'Judge whether someone else could own this in a year.', judge: { kind: 'codex', displayModel: 'codex-xhigh' } },
  { key: 'security-x', title: 'security (cross-family)', owns: 'vulnerabilities, injected execution, secret/credential exposure, supply-chain and build-config risk', special: 'You hold a council VETO — the second, cross-family security gate.', judge: { kind: 'codex', displayModel: 'codex-xhigh' } },
]

// PLAN lenses — judge a PLAN artifact (rounds 1–2: a concrete, file-level change proposal
// that never touches the repo). Same council engine, a different lens table. The veto lens
// keeps the internal key 'security' (so councilTally / the veto / the security-dead policy
// work UNCHANGED) but is DISPLAYED as 'security-by-design' via `title`. lensPrompt renders
// `title || key`; every logic path (schema selection, tally, safety) still keys off `key`.
const PLAN_LENSES = [
  { key: 'feasibility', owns: 'is this design brief buildable and TRUE — do the surfaces, mechanisms, and constraints it names actually exist in the snapshot (demand the proof: verify every factual claim about the codebase — a brief built on a misread codebase is infeasible however coherent), and does the chosen approach actually reach the acceptance criteria', special: 'You are the reality judge; audit the claims, not the prose. A brief at the WRONG ALTITUDE (code blocks, diffs, line numbers, function bodies) violates the deliverable contract — score it down for that, never up for the extra detail.' },
  { key: 'completeness', owns: 'does the brief cover EVERYTHING material the task implies — the hard 20% named (not hand-waved), the real risks, and acceptance criteria that are TESTABLE and approach-neutral, with no silent gaps in what "done" means', special: 'You catch the "frames the easy 80%, hand-waves the hard 20%" failure. Completeness is decision coverage, NOT edit-level detail — never reward line-level specificity.', judge: { kind: 'codex', displayModel: 'codex-xhigh' } },
  { key: 'risk', owns: 'what could go wrong executing this approach — hidden coupling, breaking changes, data/compat hazards, rollout/ordering risk — and whether the brief names the riskiest assumptions and mitigates them', special: 'Probe the failure modes the brief glosses over, not just the happy path.' },
  { key: 'security', title: 'security-by-design', owns: 'security-by-design: does the chosen approach build in least privilege, input validation, safe secret handling, and a safe execution/supply-chain posture — or does it design in a vulnerability', special: 'You hold the council VETO: veto a brief whose approach designs in a real, evidenced security hazard.' },
  { key: 'simplicity', owns: 'simplicity and proportionality — is the chosen approach the smallest coherent one that solves the task, or does it over-engineer, add needless surface, or gold-plate', special: 'Judge whether the APPROACH is proportionate; reward the simplest complete approach. A longer brief is not a better brief.', judge: { kind: 'codex', displayModel: 'codex-xhigh' } },
  { key: 'security-x', title: 'security-by-design (cross-family)', owns: 'security-by-design: does the chosen approach build in least privilege, input validation, safe secret handling, and a safe execution/supply-chain posture — or does it design in a vulnerability', special: 'You hold a council VETO — the second, cross-family security gate: veto a brief whose approach designs in a real, evidenced security hazard.', judge: { kind: 'codex', displayModel: 'codex-xhigh' } },
]

// Lens profiles the council can run under. Default = code lenses (unchanged behaviour).
const LENS_PROFILES = { code: LENSES, plan: PLAN_LENSES }

// Which lens table a judging point uses, chosen by its phase title so the judge() CALL SITES stay
// byte-for-byte (no per-call lens arg needed): the PLAN phase ('Review' = Plan Round 1 review,
// 'Final rank' = Plan Final rank) uses the plan lenses; everything else (the implement rounds and
// any legacy point) uses the code lenses.
// dualSecurity:false (per-run escape hatch) drops the security-x seat, restoring the 5-seat odd
// panel — an even panel can 3-3 gridlock through every deliberation round. Interim measure until
// the steelman-shootout redesign (2026-07-05-steelman-loop-design.md) makes ties cheap; the
// PRIMARY security veto seat is unaffected and can never be disabled.
function defaultLensesFor(phaseTitle) {
  const table = (phaseTitle === 'Review' || phaseTitle === 'Final rank') ? PLAN_LENSES : LENSES
  return A.dualSecurity === false ? table.filter(l => l.key !== 'security-x') : table
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

// One lens judge — a THIN ROUTER (same external signature as before, so councilJudge's call sites are
// byte-for-byte). Routes on chooseJudgeDispatch: a codex-xhigh seat (spec/craft, completeness/simplicity)
// dispatches via the codex runner when configured and not overridden; everything else — and, under
// judgeMix:'anthropic', EVERY seat — runs the native Opus path. A codex seat that exhausts its retries
// FALLS BACK to native Opus for that round so the council never loses a seat. Returns { lens, judgeModel,
// ...verdict } or null (dead even after fallback — council recomputes majority over the living).
async function askLens(lens, blindList, poolPath, phaseTitle, label, roundNum, peerBlock, rot) {
  const labels = blindList.map(c => c.blind)
  const allowedRoots = allowedRootsFor(blindList, poolPath, repoMode, worktreeRoot)
  const dispatchMode = chooseJudgeDispatch(lens, LEGACY_MIX, !!codexRunner)
  if (dispatchMode === 'codex') {
    const result = await askLensCodex(lens, blindList, poolPath, phaseTitle, label, roundNum, peerBlock, rot, labels, allowedRoots)
    if (result && !result.__codexFail) return result
    const fail = (result && result.__codexFail) || classifyCodexJudgeFailure('dispatch')
    log(`JE-COUNCIL-FALLBACK [${phaseTitle}] ${label} (${lens.key}): codex-xhigh seat exhausted retries — falling back to native Opus for this round so the council does not lose a seat.`)
    // A fallback IS an existing behavioural branch, so recording a RECOVERED fault here honours the
    // "observability, except where behaviour already branches" clause: the seat stays living (Opus) but
    // its codex leg faulted. Fold-in A: a dispatch-stage failure records the pre-existing RC 02; a
    // readback-stage failure (codex RAN, its verdict arrived corrupt/unparseable) records RC 04.
    recordSeat(`${label}:codex`, phaseTitle, fail.rc, fail.rc === RC.INVALID ? 'codex-seat-fallback-to-opus (verdict-readback-failed)' : 'codex-seat-fallback-to-opus')
  } else if (!LEGACY_MIX && lens.judge && lens.judge.kind === 'codex' && !codexRunner && !codexRunnerWarned) {
    log(`JE-COUNCIL-WARNING: codexRunner not supplied — codex judge seat(s) (spec/craft/completeness/simplicity) will run as native Opus this run. Pass args.codexRunner to enable mixed-family judging.`)
    codexRunnerWarned = true
  }
  return askLensNative(lens, blindList, poolPath, phaseTitle, label, roundNum, peerBlock, rot, labels, allowedRoots)
}

// Native Opus lens judge: opus, retry once (like judge()), THEN one model-ladder rung (opus try,
// opus retry, sonnet rung, dead) — EXCEPT the security lenses, which stay opus minimum (sonnet
// retry FORBIDDEN; their failure keeps today's dead-judge path). judgeModel is tagged with the
// model that ACTUALLY answered (ladder.used), so a downgraded verdict is honest in the record.
async function askLensNative(lens, blindList, poolPath, phaseTitle, label, roundNum, peerBlock, rot, labels, allowedRoots) {
  const prompt = lensPrompt(lens, blindList, poolPath, roundNum, peerBlock, rot)
  const schema = isSecurityLens(lens.key)
    ? (roundNum === 1 ? SECURITY_R1_SCHEMA : SECURITY_DELIB_SCHEMA)
    : (roundNum === 1 ? LENS_R1_SCHEMA : LENS_DELIB_SCHEMA)
  for (let i = 1; i <= 2; i++) {
    try {
      // Ladder rung ONLY on the final same-model try, NEVER for a security lens.
      const ladder = { eligible: i === 2 && !isSecurityLens(lens.key) }
      const raw = await agentLadder(prompt, { model: 'opus', schema, phase: phaseTitle, label }, ladder)
      if (!raw || typeof raw !== 'object') throw new Error('lens judge returned no structured result (null)')
      // Integrity guard (same choke-point as reconcile(), see EV-judge-placeholder.md): covers BOTH round 1
      // and every deliberation round, since askLens() is the single call site for all of them.
      const integrityIssue = verdictIntegrityIssue(raw) || checksRunIssue(raw.checks_run)
      if (integrityIssue) throw new Error(`council lens verdict failed integrity check: ${integrityIssue}`)
      const rootsIssue = checksRunRootsIssue(raw.checks_run, allowedRoots)
      if (rootsIssue) log(`JE-COUNCIL-WARNING [${phaseTitle}] ${label} (${lens.key}): ${rootsIssue} — non-fatal (v1 telemetry); verdict still accepted.`)
      return { lens: lens.key, judgeModel: ladder.used || 'opus', ...reconcileLens(raw, labels) }
    } catch (e) {
      log(`council ${label} (${lens.key}) attempt ${i}/2 failed: ${String(e).slice(0, 120)}`)
      if (i === 2) return null // dead lens — council recomputes majority over the living
    }
  }
}

// The verbatim-run brief for the codex JUDGE dispatch agent (the joust-codex agent runs it as-is; it
// judges NOTHING itself). Mirrors RUNVERBATIM (the attempt dispatch), scoped to a single judge seat.
function RUNVERBATIM_JUDGE(cmd, ws) {
  return `This is an approved internal step of the joust-engine tournament: it writes a judge brief and LAUNCHES the bundled, self-supervising codex runner script, which performs ONE codex council judge seat (NOT a task attempt; the runner's own watchdogs bound its runtime and it always writes a terminal "JOUST-RC" line to its log). Follow this LAUNCH-AND-POLL protocol exactly; do not judge anything yourself and do not edit the commands.\n\nSTEP 1 — LAUNCH (one Bash call; detaches the runner and returns in seconds — expect JOUST-LAUNCHED):\n\n${cmd}\n\nSTEP 2 — POLL: run this exact command as its own FOREGROUND Bash call (never as a background task) with a generous per-call timeout; when a call times out, RUN THE SAME COMMAND AGAIN — repeat until it prints JOUST-SETTLED. NEVER end your turn while the runner is still working.\n\ncd ${q(ws)} && ${pollCmd('_codex_run.log')}\n\nSTEP 3 — report only whether a file named _review_report.md exists in ${ws} and its byte size. Do not read or relay its contents.`
}

// Codex lens judge — REVIEW-PRESET pipeline (2026-07-06 judge-architecture experiment; replaces the
// exec+VERDICT.json-authorship flow whose verdict-readback failed 9/9 seats two runs straight):
//   1. The engine stages the seat workspace: scratch `git init` + the blind pool copied in as
//      _pool.md (the review presets are mutually exclusive on codex-cli >=0.141, so custom
//      instructions review the WORKING TREE — the pool copy IS the tree content under review).
//   2. codex-run.sh in JE_CODEX_MODE=review runs the bounded `codex review` preset — the report
//      goes to _review_report.md, the session stream feeds the stall watchdog, and the brief
//      demands explicit machine lines (RANKING: / VOTE: / SAFETY <letter>:).
//   3. Read-back relays log tail + report (sentinel-joined, sha-verified); parseCodexReviewDump
//      validates provenance/exit/report-shape BEFORE any reformat spend.
//   4. A sonnet helper MECHANICALLY reformats the report into the verdict shape (strict
//      traceability: it reformats, it never judges — found:false on missing machine lines), then
//      the verdict passes the SAME shape/integrity guards as every other seat.
// Effort defaults to HIGH: the experiment's effort sweep found medium/high/xhigh all surfaced the
// same core findings on the review preset, with high ~1.7x faster than xhigh (override:
// args.codexJudgeEffort). Retry once; { __codexFail } after two failures (caller falls back to Opus).
async function askLensCodex(lens, blindList, poolPath, phaseTitle, label, roundNum, peerBlock, rot, labels, allowedRoots) {
  const delibExtra = roundNum > 1
    ? `\n- Because this is a deliberation round, ALSO end with lines "RESPONSE TO PEERS: <one paragraph>", "CHANGED THIS ROUND: yes|no", and "CHANGED FROM ROUND 1: yes|no" if you can honestly assess them.`
    : ''
  const briefBody = lensPrompt(lens, blindList, poolPath, roundNum, peerBlock, rot) +
    `\n\nThe working tree you are reviewing contains _pool.md — a byte-identical copy of that pool file; it IS the artifact under review. Deliver a prioritized PLAIN-TEXT review report (you are a review preset run — do NOT write any files):\n- One section per candidate, headed exactly "Candidate <letter>:", with your lens's pros and cons, each grounded in evidence QUOTED from the pool.\n- Then finish with EXACTLY these machine-parsed lines, one per line:\nRANKING: <all candidate letters, best first, separated by " > ">\nVOTE: <the single best candidate's letter>${isSecurityLens(lens.key) ? '\nSAFETY <letter>: SAFE — or — SAFETY <letter>: UNSAFE <high|critical> <one-line concrete evidence> (one SAFETY line per candidate; UNSAFE only with evidence you can point to — a standing UNSAFE flag excludes that candidate regardless of votes)' : ''}${delibExtra}\n- Close with one reasoning paragraph explaining the ranking.`
  const seatWs = judgeWs(label)
  const judgeEffort = /^(low|medium|high|xhigh)$/.test(String(A.codexJudgeEffort || '')) ? String(A.codexJudgeEffort) : 'high'
  const flag = CODEX_FLAG[`codex-${judgeEffort}`]
  const prep = `git init -q . 2>/dev/null; cp ${q(poolPath)} _pool.md && `
  const dispatchCmd = codexRunnerCmd(codexRunner, flag, seatWs, briefBody, codexJudgeTimeout, prep, 'JE_CODEX_MODE=review ')
  const dumpScript = `printf '%s' ${q(CODEX_JUDGE_LOG_MARK)}; tail -c 4000 ${q(`${seatWs}/_codex_run.log`)} 2>/dev/null; printf '%s' ${q(CODEX_JUDGE_VERDICT_MARK)}; head -c 200000 ${q(`${seatWs}/_review_report.md`)} 2>/dev/null; printf '%s' ${q(CODEX_JUDGE_SHA_MARK)}; shasum -a 256 ${q(`${seatWs}/_review_report.md`)} 2>/dev/null | cut -d' ' -f1`

  // Two-stage try/catch per try (fold-in A): the classification is STRUCTURAL — a dispatch-stage
  // failure (codex never produced a verdict) stays RC 02; anything past a successful dispatch
  // (relay corruption, non-JSON, wrong shape, integrity reject) is RC 04. On exhaustion the caller
  // receives { __codexFail } instead of null so it can record the right class.
  let lastFail = classifyCodexJudgeFailure('dispatch')
  for (let i = 1; i <= 2; i++) {
    try {
      // model pinned alongside agentType: frontmatter is not reliably honoured (see dispatch()).
      await agent(RUNVERBATIM_JUDGE(dispatchCmd, seatWs), { agentType: nsAgent('joust-codex'), model: HELPER_MODEL, phase: phaseTitle, label: `${label}-codex-dispatch` })
    } catch (e) {
      log(`council ${label} (${lens.key}) codex-xhigh dispatch attempt ${i}/2 failed: ${String(e).slice(0, 160)}`)
      lastFail = classifyCodexJudgeFailure('dispatch')
      if (i === 2) return { __codexFail: lastFail }
      continue
    }
    try {
      const readRaw = await agentLadder(
        `Run this exact shell command in ONE Bash call and return its ENTIRE stdout, verbatim and unaltered, in the "raw" field. Do not summarize, truncate, or interpret it. Do nothing else:\n\n${dumpScript}`,
        { model: HELPER_MODEL, schema: CODEX_JUDGE_DUMP_SCHEMA, phase: phaseTitle, label: `${label}-codex-read` }
      )
      const raw = (readRaw && typeof readRaw.raw === 'string') ? readRaw.raw : ''
      // Structural persist (#33): the read-back helper relays VERDICT.json bytes through its own
      // output — verify the relay against the on-disk shasum it reported. Missing sha section (old
      // logs / truncated >200KB verdicts) skips the check; a MISMATCH is relay corruption -> retry.
      const shaIdx = raw.indexOf(CODEX_JUDGE_SHA_MARK)
      let rawForParse = raw
      if (shaIdx >= 0) {
        const reportedSha = raw.slice(shaIdx + CODEX_JUDGE_SHA_MARK.length).trim().toLowerCase()
        rawForParse = raw.slice(0, shaIdx)
        const vIdx = rawForParse.indexOf(CODEX_JUDGE_VERDICT_MARK)
        const seg = vIdx >= 0 ? rawForParse.slice(vIdx + CODEX_JUDGE_VERDICT_MARK.length) : ''
        if (/^[0-9a-f]{64}$/.test(reportedSha) && seg.length > 0 && seg.length < 200000) {
          const candidates = [seg, seg.endsWith('\n') ? seg.slice(0, -1) : seg + '\n']
          if (!candidates.some(c => sha256Hex(c) === reportedSha)) {
            throw new Error('VERDICT.json relay corruption: read-back sha256 does not match the on-disk shasum')
          }
        }
      }
      const parsedResult = parseCodexReviewDump(rawForParse)
      if (!parsedResult.ok) throw new Error(parsedResult.reason)
      // REFORMAT (sonnet, mechanical): report text -> verdict shape. The helper reformats, it never
      // judges — every field must trace to report content, and found:false (no invented ranking)
      // routes to the fallback exactly like any other readback failure.
      const fmt = await agentLadder(
        `You are a MECHANICAL reformatter for a code-review council. Below is a judge's plain-text review report over blind candidates ${labels.join(', ')}. Convert it into the structured verdict WITHOUT adding, upgrading, downgrading, or inventing ANYTHING — every pro, con, ranking position, vote${isSecurityLens(lens.key) ? ', safety flag' : ''} and reasoning sentence must be traceable to the report. Take ranking from the report's "RANKING:" line and vote from its "VOTE:" line verbatim${isSecurityLens(lens.key) ? '; take safety entries ONLY from its "SAFETY <letter>:" lines (safety "SAFE" or "UNSAFE"; severity/evidence only as written)' : ''}. If the report lacks an explicit RANKING: or VOTE: line, or is not a real review, return found:false with empty fields rather than inventing one.\n\nREPORT (verbatim):\n${parsedResult.report}`,
        { model: HELPER_MODEL, schema: CODEX_REVIEW_VERDICT_SCHEMA, phase: phaseTitle, label: `${label}-codex-reformat` }
      )
      if (!fmt || fmt.found !== true) throw new Error('codex review judge: reformatter reported no traceable RANKING/VOTE in the report')
      const verdict = {
        lens: lens.key,
        candidates: fmt.candidates, ranking: fmt.ranking, vote: fmt.vote, reasoning: fmt.reasoning,
        checks_run: REVIEW_CHECKS_RUN,
        ...(isSecurityLens(lens.key) ? { safety: Array.isArray(fmt.safety) ? fmt.safety : [] } : {}),
        ...(fmt.response_to_peers ? { response_to_peers: fmt.response_to_peers } : {}),
        ...(typeof fmt.changed_this_round === 'boolean' ? { changed_this_round: fmt.changed_this_round } : {}),
        ...(typeof fmt.changed_from_round1 === 'boolean' ? { changed_from_round1: fmt.changed_from_round1 } : {}),
      }
      const shapeIssue = verdictShapeIssue(verdict)
      if (shapeIssue) throw new Error(`codex review judge: reformatted verdict shape invalid — ${shapeIssue}`)
      const integrityIssue = verdictIntegrityIssue(verdict)
      if (integrityIssue) throw new Error(`codex review judge verdict failed integrity check: ${integrityIssue}`)
      return { lens: lens.key, judgeModel: `codex-${judgeEffort}`, ...reconcileLens(verdict, labels) }
    } catch (e) {
      log(`council ${label} (${lens.key}) codex-xhigh readback attempt ${i}/2 failed: ${String(e).slice(0, 160)}`)
      lastFail = classifyCodexJudgeFailure('readback')
      if (i === 2) return { __codexFail: lastFail }
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
  const securityExtra = isSecurityLens(lens.key)
    ? `\n\nYou hold the council's SECURITY VETO. For EVERY candidate also return a \`safety\` entry: {label, safety: "SAFE" | "UNSAFE", severity ("high"|"critical", UNSAFE only), evidence (file + concrete why, UNSAFE only)}. Flag UNSAFE only with EVIDENCE you can point to — a real vulnerability, injected-execution path, secret/credential exposure, or supply-chain/build-config risk. A standing UNSAFE flag (high|critical, with evidence) EXCLUDES that candidate from winning regardless of votes, so do not flag on suspicion alone — but if you are unsure whether something is exploitable, flag it and cite why (fail-closed).`
    : ''
  const delib = roundNum > 1
    ? `\n\nThis is DELIBERATION round ${roundNum - 1} of at most 3. Your peers' latest full verdicts (blind, letters only) are below as verbatim JSON. Read them, address the disagreements in \`response_to_peers\` (convince them or be convinced — converge on the CORRECT call, do not hold a position out of stubbornness), and you MAY run 1-2 targeted checks to settle a factual dispute. Then emit your REVISED verdict and set \`changed_this_round\` / \`changed_from_round1\` truthfully.${isSecurityLens(lens.key) ? ' A peer may rebut your veto with evidence; if it genuinely refutes the flag, WITHDRAW it (drop that UNSAFE entry). A flag you still believe stands and keeps excluding the candidate.' : ''}\n\nPEER VERDICTS (JSON, verbatim):\n${peerBlock}`
    : ''
  return `You are a blind judge on a 5-member review COUNCIL. Your lens is **${lens.title || lens.key}**: ${lens.owns}. ${lens.special}
You do NOT know which model produced which candidate; do not speculate. Judge only the work in front of you, through YOUR lens (the other four lenses cover the rest). Apply the shared scoring method: judge the real artifact not any self-summary; score against the task's STATED runtime (treat reliance on a capability the task did not establish as a risk, and treat an unfamiliar but constraint-honouring mechanism as correct unless you can name a concrete way it fails); cite specifics (a line or behaviour, never a vibe); thoroughness is evidence, not word count — do not reward length or verbosity per se.

Task that every candidate was given:
${task}

All candidate deliverables are concatenated, blind-labelled, in ONE file — read it ONCE (each candidate's section is headed "===== Candidate <letter> ====="):
${poolPath}

If (and only if) a candidate is runnable code you want to execute to judge the real output, its individual files are in its own directory (run with a sensible timeout). Consider the candidates in this order — ${letters}:
${dirs}
Do not read any other files.${pinnedScopeBlock(poolPath, blindList)}

Return the structured object for YOUR lens: per-candidate pros/cons (through this lens), the full ranking (best first, by candidate letter), your single first-place \`vote\` (one candidate letter), \`reasoning\`, and \`checks_run\` — the commands you ran or files you read, each with its key result (forced evidence; never leave it empty).${securityExtra}${delib}

You are ONE independent voice. Do NOT tally, aggregate, average, or "reach consensus" yourself, and do NOT name an overall council winner — the winner is computed deterministically in code from all five votes plus the veto. Just cast the single most honest first-place vote your lens supports.`
}

// DETERMINISTIC tally — plain code, run after every round. Majority = strictly >50% of LIVING judges'
// first-place votes on a candidate the security lens has NOT flagged UNSAFE (high|critical, with evidence).
function councilTally(verdicts) {
  const living = verdicts.length
  const votes = {}
  for (const v of verdicts) votes[v.vote] = (votes[v.vote] || 0) + 1
  // Dual security gates (spec addendum): the veto set is the UNION of standing flags from EVERY
  // security-lens verdict ('security' + 'security-x'); each judge's flags stand or are withdrawn
  // independently in deliberation.
  const secVs = verdicts.filter(v => isSecurityLens(v.lens))
  const vetoedSet = new Set()
  for (const secV of secVs) {
    if (!Array.isArray(secV.safety)) continue
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
  const threshold = living / 2 // strict >50% (6 alive => 4 votes; even-N 3-3 splits resolve via deliberation/NO_CONSENSUS)
  let winner = null
  const order = Object.keys(votes).sort((a, b) => (votes[b] - votes[a]) || a.localeCompare(b))
  for (const c of order) { if (votes[c] > threshold && !vetoedSet.has(c)) { winner = c; break } }
  return { living, votes, vetoedSet, vetoed: [...vetoedSet], threshold, winner }
}

// ---- begin: aspect verifiers ----
// Binary aspect verification (BoN-MAV, arXiv:2502.20379): many cheap BINARY aspect checks beat a
// single continuous score. PURE — extract-and-eval'able (repo convention, like the return-codes
// block); the IMPURE fan-out (aspectVerify below) is exercised structurally/system-side. Approvals
// NEVER override the council order: they only break EXACT ties (aspectTiebreak), slotting between
// mean-rank and blind-letter in nonVetoedOrder.
// The 4 aspects. Each carries the SAME binary question phrased for the artifact a phase judges:
// `plan` for a design brief (the PLAN decision points: 'Review' / 'Final rank'), `code` otherwise.
const ASPECTS = [
  { key: 'correct-behaviour',
    plan: 'Would faithfully implementing this design brief produce the behaviour the task asks for — is every mechanism it relies on sound and workable as described?',
    code: 'Does this candidate actually produce the behaviour the task asks for — traced or run, does the core path work?' },
  { key: 'spec-fit',
    plan: 'Does this design brief address EVERYTHING the task explicitly asked for, honouring every stated constraint, with nothing material missing or out of scope?',
    code: 'Does this candidate do EVERYTHING the task explicitly asked for, honouring every stated constraint, with nothing material missing or out of scope?' },
  { key: 'simplicity',
    plan: "Is this design brief's approach the smallest coherent one that solves the task — free of over-engineering, needless surface, or gold-plating?",
    code: "Is this candidate's implementation the smallest coherent one that solves the task — free of over-engineering, needless surface, or gold-plating?" },
  { key: 'robustness',
    plan: 'Does this design brief account for the realistic failure modes and edge cases its approach will face (bad input, boundaries, partial failure), rather than only the happy path?',
    code: 'Does this candidate handle the realistic failure modes and edge cases it will face (bad input, boundaries, partial failure) gracefully, rather than only the happy path?' },
]
// Phase -> phrasing selector (mirrors defaultLensesFor's phase split; no phase arg reaches the table).
function aspectQuestionFor(aspect, phaseTitle) {
  return (phaseTitle === 'Review' || phaseTitle === 'Final rank') ? aspect.plan : aspect.code
}
// votesByCandidate: { [label]: [true|false|null, ...] } — one slot per aspect; null = that aspect
// ABSTAINED (dead agent or missing vote). Approval count = strict `true`s only; an abstention
// never counts for or against a candidate.
function aspectTally(votesByCandidate) {
  const out = {}
  for (const label of Object.keys(votesByCandidate || {})) {
    out[label] = (votesByCandidate[label] || []).reduce((n, v) => n + (v === true ? 1 : 0), 0)
  }
  return out
}
// aspectTiebreak(order, approvals): reorders ONLY exact ties in an existing council ranking by
// approval count. `order` is an array whose elements are either a single label (not tied — NEVER
// moved relative to its neighbours) or an array of labels that are an EXACT tie under the
// council's sort key. Within a tie group: approval count desc, then the group's incoming order
// (blind-letter asc from the caller's sort) — i.e. the approval count slots BETWEEN mean-rank and
// blind-letter. A null/empty approvals map disables reordering entirely (flatten unchanged); a
// label missing from the map counts 0. Pure; never overrides the council order otherwise.
function aspectTiebreak(order, approvals) {
  if (!approvals || !Object.keys(approvals).length) {
    return (order || []).flatMap(g => (Array.isArray(g) ? g : [g]))
  }
  const count = l => (Number.isFinite(approvals[l]) ? approvals[l] : 0)
  return (order || []).flatMap(g => {
    if (!Array.isArray(g)) return [g]
    return g.map((l, i) => ({ l, i }))
      .sort((a, b) => (count(b.l) - count(a.l)) || (a.i - b.i))
      .map(x => x.l)
  })
}
// ---- end: aspect verifiers ----

// Strict per-aspect vote schema: one BINARY approve/reject per candidate, short reason. No scores,
// no ranking, no winner — a verifier is not a judge.
const ASPECT_VOTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    votes: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        label: { type: 'string' },
        approve: { type: 'boolean' },
        reason: { type: 'string', maxLength: 240 },
      },
      required: ['label', 'approve', 'reason'],
    } },
  },
  required: ['votes'],
}

// One cheap binary verifier for ONE aspect (HELPER_MODEL): reads the staged pool once, returns
// approve/reject per candidate. Fail-safe by construction: any failure => null (that aspect
// ABSTAINS) — it never throws and never shrinks the field.
async function askAspect(aspect, blindList, poolPath, phaseTitle, label) {
  const letters = blindList.map(c => c.blind)
  const prompt = `You are ONE binary ASPECT VERIFIER (not a judge, not a ranker) in a blind review. Your single aspect is **${aspect.key}**. For EVERY candidate answer ONE yes/no question:

${aspectQuestionFor(aspect, phaseTitle)}

Task every candidate was given:
${task}

All candidate deliverables are concatenated, blind-labelled, in ONE file — read it ONCE (each candidate's section is headed "===== Candidate <letter> ====="):
${poolPath}
Do not read any other files. You do NOT know which model produced which candidate; do not speculate.

Return one vote per candidate, for candidates ${letters.join(', ')} — each vote: label, approve (true = yes, it clearly passes this aspect; false = no, or too unclear to approve), and a SHORT reason (one clause). BINARY only: no scores, no ranking, no overall winner.`
  try {
    const raw = await agentLadder(prompt, { model: HELPER_MODEL, schema: ASPECT_VOTE_SCHEMA, phase: phaseTitle, label })
    if (!raw || !Array.isArray(raw.votes)) return null
    const set = new Set(letters)
    const norm = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').charAt(0)
    const byLabel = {}
    for (const v of raw.votes) {
      const l = norm(v && v.label)
      if (set.has(l) && typeof (v && v.approve) === 'boolean' && byLabel[l] === undefined) {
        byLabel[l] = { label: l, approve: v.approve, reason: String(v.reason || '').slice(0, 240) }
      }
    }
    if (!Object.keys(byLabel).length) return null // schema-valid junk (no recognisable labels) = abstain
    return { aspect: aspect.key, votes: letters.map(l => byLabel[l] || null) }
  } catch (e) {
    log(`aspect verifier '${aspect.key}' failed (${String(e).slice(0, 100)}) — this aspect ABSTAINS (never fatal).`)
    return null
  }
}

// Fan out ONE HELPER_MODEL verifier per aspect (4 total) against the SAME staged pool the council
// reads. Launched CONCURRENTLY with the round-1 lens fan-out (no ordering dependency). Native
// Anthropic seats expose no engine-known wall clock (lensTimeoutSecsFor-style null), so
// parallelQuorum never quorum-closes an aspect seat here — but every failure path already
// degrades to an abstention, so a dead aspect can never block or crash the council. Returns
// { approvals: {label: n}, by_aspect: [{aspect, votes|null}] } (persisted in council.json as
// `aspects`) or null when everything abstained/failed.
async function aspectVerify(blindList, poolPath, phaseTitle) {
  const letters = blindList.map(c => c.blind)
  try {
    const results = await parallelQuorum(ASPECTS, (aspect) =>
      askAspect(aspect, blindList, poolPath, phaseTitle, `aspect-${aspect.key}`), phaseTitle, {
      timeoutSecsFor: () => null, // native seats: no engine-known wall clock => never quorum-closable
      seatLabelFor: (a) => `aspect:${a.key}`,
    })
    const votesByCandidate = {}
    for (const l of letters) {
      votesByCandidate[l] = ASPECTS.map((a, i) => {
        const r = results[i]
        const v = r && Array.isArray(r.votes) ? r.votes.find(x => x && x.label === l) : null
        return v ? v.approve : null // dead aspect / missing per-candidate vote = abstain (null)
      })
    }
    const approvals = aspectTally(votesByCandidate)
    const by_aspect = ASPECTS.map((a, i) => ({
      aspect: a.key,
      votes: results[i] && Array.isArray(results[i].votes) ? results[i].votes.filter(Boolean) : null, // null = abstained
    }))
    const dead = by_aspect.filter(x => !x.votes).map(x => x.aspect)
    if (dead.length === ASPECTS.length) { log(`aspect verifiers [${phaseTitle}]: ALL aspects abstained — proceeding without aspect data (fail-safe).`); return null }
    if (dead.length) log(`aspect verifiers [${phaseTitle}]: ${dead.length}/${ASPECTS.length} aspect(s) abstained (${dead.join(', ')}).`)
    log(`aspect verifiers [${phaseTitle}]: approvals ${letters.map(l => `${l}:${approvals[l]}`).join(', ')} (of ${ASPECTS.length} binary aspects; tiebreak + steelman context only).`)
    return { approvals, by_aspect }
  } catch (e) {
    log(`aspect verifiers failed entirely (${String(e).slice(0, 100)}) — proceeding without (fail-safe).`)
    return null
  }
}

// Non-vetoed candidates in carry/seed order: most first-place votes, then best mean rank across
// living verdicts, then blind label. Used by the fast tally (top-2 carry) and the steelman loop
// (finalist seeding). Deterministic code — never an LLM. `aspectApprovals` (optional; only passed
// when args.aspectVerifiers produced data) breaks EXACT (first-votes, mean-rank) ties by binary
// approval count — slotting between mean-rank and blind-letter via aspectTiebreak. Positions that
// are not exact ties NEVER move.
function nonVetoedOrder(verdicts, labels, vetoedSet, aspectApprovals = null) {
  const firstVotes = {}, rankSum = {}, rankCount = {}
  for (const l of labels) { firstVotes[l] = 0; rankSum[l] = 0; rankCount[l] = 0 }
  for (const v of verdicts) {
    if (firstVotes[v.vote] != null) firstVotes[v.vote]++
    ;(v.ranking || []).forEach((l, idx) => { if (rankCount[l] != null) { rankSum[l] += idx + 1; rankCount[l]++ } })
  }
  const avgRank = l => rankCount[l] ? rankSum[l] / rankCount[l] : labels.length + 1
  const sorted = labels.filter(l => !vetoedSet.has(l))
    .sort((a, b) => (firstVotes[b] - firstVotes[a]) || (avgRank(a) - avgRank(b)) || a.localeCompare(b))
  if (!aspectApprovals) return sorted
  // Group EXACT ties under the council sort key (first-votes, mean-rank); aspectTiebreak reorders
  // only within a group (approval count desc, then the incoming blind-letter order).
  const key = l => `${firstVotes[l]}|${avgRank(l)}`
  const groups = []
  for (const l of sorted) {
    const g = groups[groups.length - 1]
    if (g && key(g[0]) === key(l)) g.push(l)
    else groups.push([l])
  }
  return aspectTiebreak(groups, aspectApprovals)
}

// A compact, blind (letters-only) peer block handed to each judge during deliberation.
function councilPeerBlock(peers) {
  const compact = peers.map(v => ({
    lens: v.lens, vote: v.vote, ranking: v.ranking, reasoning: v.reasoning,
    candidates: (v.candidates || []).map(c => ({ label: c.label, pros: c.pros, cons: c.cons })),
    checks_run: v.checks_run || [],
    ...(isSecurityLens(v.lens) && Array.isArray(v.safety) ? { safety: v.safety } : {}),
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
// `requested` (optional): the round's REQUESTED lens list — when passed, dead_seats records each
// requested lens with no living verdict this round as a non-00 judge seat (observability).
function roundRecord(round, verdicts, t, requested) {
  const living = new Set(verdicts.map(v => v.lens))
  const dead_seats = (requested || []).filter(l => !living.has(l.key)).map(l => ({ lens: l.key, rc: '09', reason: 'lens-seat-dead-after-retries' }))
  return {
    round,
    living: verdicts.map(v => v.lens),
    votes: { ...t.votes },
    vetoed: t.vetoed,
    winner: t.winner,
    dead_seats,
    verdicts: verdicts.map(v => ({
      lens: v.lens,
      rc: '00', // a living lens seat succeeded (observability; per-seat RC in council metadata)
      ...(LEGACY_MIX ? {} : { judge_model: v.judgeModel || 'opus' }),
      vote: v.vote,
      ranking: v.ranking,
      reasoning: v.reasoning || '',
      checks_run: Array.isArray(v.checks_run) ? v.checks_run : [],
      pros_cons: (v.candidates || []).map(c => ({ label: c.label, pros: c.pros || [], cons: c.cons || [] })),
      changed_this_round: v.changed_this_round === true,
      changed_from_round1: v.changed_from_round1 === true,
      response_to_peers: v.response_to_peers || '',
      ...(isSecurityLens(v.lens) && Array.isArray(v.safety) ? { safety: v.safety } : {}),
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
      // Ladder rung ONLY on the final same-model try (opus try, opus retry, THEN sonnet rung).
      const g = await agentLadder(prompt, { model: 'opus', schema: GUIDANCE_SYNTH_SCHEMA, phase: phaseTitle, label }, { eligible: i === 2 })
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
// ---- steelman shootout machinery (judging-v3, 2026-07-06) --------------------------------------
// The steelman is a SYNTHESIS helper like the guidance distiller: it never votes, never picks a
// winner. It turns the judges' cited cons on each finalist into a MINIMAL change-list. Opus —
// the change-list steers real artifact edits.
const STEELMAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    changes: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        label: { type: 'string' },
        items: { type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: { change: { type: 'string' }, addresses: { type: 'string' } },
          required: ['change', 'addresses'] } },
      }, required: ['label', 'items'] } },
  }, required: ['changes'],
}

// Compact aspect-verifier context block for the steelman prompt (approval counts + which aspects
// rejected each finalist, with the short reasons). Context only — never votes, never a ranking.
function aspectSteelmanContext(aspects, finalists) {
  if (!aspects || !aspects.approvals) return ''
  const lines = finalists.map(f => {
    const rejected = (aspects.by_aspect || [])
      .map(a => ({ aspect: a.aspect, v: Array.isArray(a.votes) ? a.votes.find(x => x && x.label === f) : null }))
      .filter(x => x.v && x.v.approve === false)
      .map(x => `${x.aspect} ("${x.v.reason}")`)
    return `- Candidate ${f}: ${aspects.approvals[f] ?? 0} of ${(aspects.by_aspect || []).length} aspects approved${rejected.length ? `; rejected by ${rejected.join('; ')}` : ''}`
  })
  return `\n\nASPECT VERIFIER RESULTS (independent cheap binary checks; CONTEXT ONLY — they are not judges, cast no votes, and never pick winners; use a rejection reason only where it corroborates a judge-cited con):\n${lines.join('\n')}`
}

async function steelmanChangeLists(finalists, verdicts, phaseTitle, label, aspects = null) {
  const block = JSON.stringify(verdicts.map(v => ({ lens: v.lens, vote: v.vote, ranking: v.ranking, reasoning: v.reasoning,
    candidates: (v.candidates || []).filter(c => finalists.includes(String(c.label || '').charAt(0))).map(c => ({ label: c.label, pros: c.pros, cons: c.cons })) })), null, 2)
  try {
    const res = await agentLadder(
      `You are the STEELMAN for a blind review — a synthesis helper, explicitly NOT a judge: you never vote, never rank, never pick a winner. Below are the review council's verdicts on the finalist candidates ${finalists.join(' and ')}. For EACH finalist, produce the MINIMAL change-list that would make IT the clear winner. HARD RULES: every item must be traceable to a judge-cited con (put the con it addresses in \`addresses\`, quoted or closely paraphrased); steel-man, do not redesign — no new features, no scope growth, no stylistic rewrites beyond the cited cons; prefer the smallest coherent edit per con. Return one entry per finalist.\n\nCOUNCIL VERDICTS (blind, verbatim):\n${block}${aspectSteelmanContext(aspects, finalists)}`,
      { model: 'opus', schema: STEELMAN_SCHEMA, phase: phaseTitle, label: `${label}-steelman` })
    const out = {}
    for (const c of (res && res.changes) || []) {
      const l = String(c.label || '').toUpperCase().charAt(0)
      if (finalists.includes(l)) out[l] = (c.items || []).slice(0, 12)
    }
    return out
  } catch (e) { log(`steelman ${label}: change-list synthesis failed (${String(e).slice(0, 100)}) — boosting skipped this iteration`); return {} }
}

// Apply one finalist's change-list to a COPY of its artifact dir. The booster edits the copy in
// place; the original staged dir is never touched (ratchet source). Returns true if the agent ran.
async function boostCandidate(origDir, outDir, items, phaseTitle, label) {
  const list = items.map((it, i) => `${i + 1}. ${it.change}\n   (addresses: ${it.addresses})`).join('\n')
  try {
    await agentLadder(
      `This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items):\n\n${list}\n\nKeep every file not named by the list byte-identical.\n\nHARD STOP DISCIPLINE (this pass is edit-and-stop, not iterate-until-perfect): make ONE editing pass over the listed items, then STOP and reply "done". Do NOT run test suites, builds, or the artifact itself — a separate staging gate validates the boosted artifact after you finish, so any verification you run here is duplicated spend (observed live: a boost agent burned 88 tool calls re-running full test suites). At most, you may re-read an edited file once to confirm the edit landed. If a change-list item cannot be applied as written, skip it and note the skip in your final reply instead of iterating on it.`,
      { model: 'opus', phase: phaseTitle, label })
    return true
  } catch (e) { log(`steelman boost ${label} failed: ${String(e).slice(0, 100)} — candidate re-enters at its last gated version (ratchet)`); return false }
}

async function councilJudge(kind, blindList, guidanceWanted, poolPath, phaseTitle, label, lenses = LENSES, style = 'final') {
  const labels = blindList.map(c => c.blind)
  const roundsLog = []
  const reviewDir = poolPath.replace(/\/_pool\.md$/, '')
  // Persist phase 2 (issue #33): land each round's per-seat verdicts as SMALL typed sha-verified
  // files under <reviewDir>/_judges/ as soon as the round's verdicts are final — amortized DURING
  // judging, off the checkpoint critical path. The engine copy is authoritative (the exact
  // roundRecord verdict entry, serialized json(entry)); a codex seat's raw workspace VERDICT.json
  // stays a debug artifact. Verified writes are recorded in the module seatRefs map so the
  // checkpoint's tally skeleton can reference them; a failed write leaves that seat INLINE in the
  // skeleton (persist logs, never throws) — worst case is today's behaviour, never a crashed run.
  const refs = seatRefs[label] = Object.create(null)
  const judgesDir = `${reviewDir}/_judges`
  const relJudges = judgesDir.startsWith(`${runDir}/`) ? judgesDir.slice(runDir.length + 1) : judgesDir
  const persistSeatFiles = async (entries) => {
    try {
      const okPaths = new Set(await persist(entries.map(e => ({ path: `${judgesDir}/${e.name}`, content: e.content })), phaseTitle))
      for (const e of entries) {
        if (okPaths.has(`${judgesDir}/${e.name}`)) refs[e.key] = { rel: `${relJudges}/${e.name}`, sha: sha256Hex(heredocBody(e.content)) }
      }
    } catch (e) { log(`seat-file persist (${label}): ${String(e).slice(0, 120)} — affected seats stay inline in the tally skeleton`) }
  }
  // One persist batch per judging round: the just-pushed roundRecord's verdict entries, keyed by
  // lens + round (what buildTallySkeleton matches against council.rounds). Seat filenames reuse
  // the existing seat label (`<phase-label>-<lens.key>-r<n>`), flat under _judges/.
  const persistRoundSeats = (rec) => persistSeatFiles((rec.verdicts || []).map(v => ({
    key: `${v.lens}|r${rec.round}`, name: `${label}-${v.lens}-r${rec.round}.json`, content: json(v) })))
  // Per-judge-seat RC (observability). A living lens seat = 00; a REQUESTED lens with no living verdict
  // after retries = a dead seat (09). `no_consensus` is NOT a fault — it still records 00 for the living
  // seats only. Recorded once, at the terminal decision, over the FINAL living verdicts.
  const recordCouncilSeats = (living) => {
    const livingKeys = new Set((living || []).map(v => v.lens))
    for (const v of (living || [])) recordSeat(`${label}:${v.lens}`, phaseTitle, RC.OK, 'ok')
    for (const l of lenses) if (!livingKeys.has(l.key)) recordSeat(`${label}:${l.key}`, phaseTitle, RC.UNKNOWN, 'lens-seat-dead-after-retries')
  }

  // Aspect verifiers (args.aspectVerifiers, default OFF): launched CONCURRENTLY with the round-1
  // lens fan-out — both read the same staged pool, no ordering dependency. aspectVerify never
  // rejects (fail-safe: abstentions), so the un-awaited promise is always harmless.
  const aspectsPromise = ASPECT_VERIFIERS ? aspectVerify(blindList, poolPath, phaseTitle) : null

  // Round 1 — 5 independent verdicts, no peer visibility. Each lens gets a differently-rotated listing.
  const r1raw = await parallelQuorum(lenses, (lens, i) =>
    askLens(lens, blindList, poolPath, phaseTitle, `${label}-${lens.key}-r1`, 1, null, i), phaseTitle, {
    timeoutSecsFor: lensTimeoutSecsFor,
    neverClose: (lens) => isSecurityLens(lens.key), // NEVER close over a security-gate seat
    seatLabelFor: (lens) => `${label}:${lens.key}`,
  })
  let verdicts = r1raw.filter(Boolean)
  if (!verdicts.length) {
    log(`council ${label}: ALL 5 lenses died in round 1 — degrading to a __failed partial (caller lands a partial run).`)
    recordSeat(label, phaseTitle, RC.UNKNOWN, 'all-lenses-dead')
    return { __failed: 'all council judges failed in round 1' }
  }

  // Aspect data (flag-gated; null when off or all aspects abstained). Approvals feed ONLY the
  // nonVetoedOrder tiebreak slot and the steelman context; `aspects` is recorded in council
  // metadata (persisted in council.json).
  const aspects = aspectsPromise ? await aspectsPromise : null
  const aspectApprovals = aspects ? aspects.approvals : null
  const attachAspects = (result) => { if (aspects && result && result.council) result.council.aspects = aspects; return result }

  // Security-judge death policy: repoMode = fail-closed (unresolvable veto → NO_CONSENSUS/needs-human);
  // isolated run = proceed, but LOUD warning that veto coverage was lost.
  const securityDeadHalt = async () => {
    const tt = councilTally(verdicts)
    roundsLog.push(roundRecord(roundsLog.length + 1, verdicts, tt, lenses))
    await persistRoundSeats(roundsLog[roundsLog.length - 1]) // persist phase 2: this fail path still checkpoints its seats
    recordCouncilSeats(verdicts)
    return attachAspects(buildCouncilResult({ winner: null, verdicts, roundsLog, labels, lenses, no_consensus: true,
      humanReason: 'security judge unavailable in repo mode — veto coverage lost (fail-closed)' }))
  }
  if (!verdicts.some(v => v.lens === 'security')) {
    if (repoMode) {
      log(`council ${label}: SECURITY lens dead in repoMode — veto coverage unresolvable; failing closed to NO_CONSENSUS (needs-human + HALT).`)
      return securityDeadHalt()
    }
    log(`JE-COUNCIL-WARNING [${phaseTitle}]: security lens dead — veto coverage LOST for this isolated run; the council proceeds WITHOUT a security veto.`)
  }

  let t = councilTally(verdicts)
  roundsLog.push(roundRecord(1, verdicts, t, lenses))
  await persistRoundSeats(roundsLog[roundsLog.length - 1]) // persist phase 2: round-1 seats land now (~2-20KB each, one helper batch)
  const allVetoed = () => labels.length > 0 && labels.every(l => t.vetoedSet.has(l))
  recordCouncilSeats(verdicts)

  // ---- INTERMEDIATE review: FAST TALLY (judging-v3 spec 1). ONE vote round, NEVER deliberates.
  // The intermediate review's downstream consumers are the round-2 guidance and the carried
  // champion(s) — forcing consensus here wastes tokens and discards the runner-up nearly half
  // the panel preferred. Majority => carry 1 (byte-identical outcome to before); split => carry
  // the TOP TWO non-vetoed; all-vetoed => carry NONE and proceed on guidance alone (NOT a halt).
  if (style === 'intermediate') {
    const order = nonVetoedOrder(verdicts, labels, t.vetoedSet, aspectApprovals)
    const carried = t.winner != null ? [t.winner] : order.slice(0, 2)
    if (t.winner == null) log(`council ${label}: FAST TALLY — no majority; carrying top ${carried.length} non-vetoed candidate(s) [${carried.join(', ')}] into the final pool (no deliberation at intermediate reviews).`)
    if (!carried.length) log(`council ${label}: FAST TALLY — every candidate vetoed; carrying none, round 2 proceeds on guidance alone.`)
    const result = buildCouncilResult({ winner: carried[0] ?? null, verdicts, roundsLog, labels, lenses, no_consensus: false })
    result.carried = carried
    result.council.fast_tally = true
    result.council.carried = carried
    if (t.winner == null) result.reasoning = `FAST TALLY (intermediate review, no deliberation): no >50% majority — votes ${Object.keys(t.votes).sort().map(k => `${k}:${t.votes[k]}`).join(', ') || 'none'}${t.vetoed.length ? `; standing veto on ${t.vetoed.join(', ')}` : ''}. Carrying top ${carried.length} non-vetoed candidate(s) [${carried.join(', ')}] into the final pool; the final rank resolves the contest.`
    if (guidanceWanted) {
      result.guidance = await synthesizeGuidance(verdicts, phaseTitle, `${label}-guidance`)
      if (result.guidance) result.guidance.carried_note = carried.length
        ? `Carried champion(s): ${carried.join(', ')} (vote split ${Object.keys(t.votes).sort().map(k => `${k}:${t.votes[k]}`).join(', ') || 'none'}) — these set the bar the final pool must beat.`
        : 'No candidate was carried (all vetoed); the final pool is round 2 alone.'
    }
    return attachAspects(result)
  }

  // ---- FINAL decision point: STEELMAN SHOOTOUT (judging-v3 spec 2). The seed vote NEVER crowns —
  // it seeds the top-2 non-vetoed finalists; then ALWAYS >=1 improve-and-cold-re-judge round, so a
  // shipped winner never carries the cons the judges already documented, and every crown is
  // defended against an improved challenger. Deliberation no longer exists at final ranks.
  if (allVetoed()) {
    const reason = 'all candidates were vetoed UNSAFE by the security lens(es)'
    log(`council ${label}: NO_CONSENSUS — ${reason}.`)
    return attachAspects(buildCouncilResult({ winner: null, verdicts, roundsLog, labels, lenses, no_consensus: true, humanReason: reason }))
  }
  const seedOrder = nonVetoedOrder(verdicts, labels, t.vetoedSet, aspectApprovals)
  const seeds = seedOrder.slice(0, 2)
  const seedVotesStr = Object.keys(t.votes).sort().map(k => `${k}:${t.votes[k]}`).join(', ') || 'none'
  log(`council ${label}: STEELMAN SHOOTOUT — seed vote ${seedVotesStr}${t.winner ? ` (majority: ${t.winner})` : ' (no majority)'}; finalists [${seeds.join(', ')}].`)
  const steelmanMeta = { seeds, seed_votes: { ...t.votes }, seed_majority: t.winner || null, rounds: [], decided_by: null }
  const currentWs = {}                          // ratchet state: letter -> last GATED artifact dir
  for (const s of seeds) currentWs[s] = `${reviewDir}/${s}`
  const loneFinalist = seeds.length === 1
  let finalWinner = null                        // ORIGINAL pool letter
  let lastRunoffVerdicts = null                 // mapped to original letters (for orchestrator pick)
  let steelmanVerdicts = verdicts               // what the steelman reads (orig-letter space)
  const maxIters = loneFinalist ? 1 : 5

  for (let iter = 1; iter <= maxIters && finalWinner == null; iter++) {
    // (a) steelman: cons -> minimal change-lists (never votes). Only the steelman sees history.
    const changeLists = await steelmanChangeLists(seeds, steelmanVerdicts, phaseTitle, `${label}-i${iter}`, aspects)
    // (b) boost each finalist on a COPY; a failed/empty boost re-enters at the last gated version.
    const boostDirs = {}
    await parallel(seeds.map(s => async () => {
      const items = changeLists[s] || []
      if (!items.length) { log(`steelman ${label} i${iter}: no change-list for ${s}; it re-enters unboosted.`); return }
      const out = `${reviewDir}-steelman/i${iter}/${s}`
      if (await boostCandidate(currentWs[s], out, items, phaseTitle, `${label}-boost-i${iter}-${s}`)) boostDirs[s] = out
    }))
    // (c) COLD re-judge: fresh blind pool of the gated versions (lone mode: boosted vs pre-boost
    // original). Judges get NO prior verdicts, no peer block, no iteration hints.
    const runoffEntries = loneFinalist
      ? [ { ws: boostDirs[seeds[0]] || currentWs[seeds[0]], orig: seeds[0], variant: 'boosted', dispatch: 'anthropic', displayModel: 'steelman', carriedOver: true },
          { ws: `${reviewDir}/${seeds[0]}`, orig: seeds[0], variant: 'original', dispatch: 'anthropic', displayModel: 'steelman', carriedOver: true } ]
      : seeds.map(s => ({ ws: boostDirs[s] || currentWs[s], orig: s, variant: boostDirs[s] ? 'boosted' : 'ratchet', dispatch: 'anthropic', displayModel: 'steelman', carriedOver: true }))
    let runoffDir = `${reviewDir}-runoff-${iter}`
    let stagedR = (await stageAndValidate(blindLabel(runoffEntries, iter), runoffDir, phaseTitle)).filter(c => c.valid)
    // gate/ratchet: a boost that failed staging is replaced by the last gated version and re-staged once.
    if (stagedR.length < runoffEntries.length && !loneFinalist) {
      const validOrig = new Set(stagedR.map(c => c.orig))
      const repaired = runoffEntries.map(e => validOrig.has(e.orig) ? e : { ...e, ws: currentWs[e.orig], variant: 'ratchet' })
      log(`steelman ${label} i${iter}: ${runoffEntries.length - stagedR.length} boost(s) failed the staging gate — reverted to last gated version (ratchet).`)
      runoffDir = `${runoffDir}-repair`
      stagedR = (await stageAndValidate(blindLabel(repaired, iter), runoffDir, phaseTitle)).filter(c => c.valid)
    }
    if (!stagedR.length) { log(`steelman ${label} i${iter}: runoff staging produced no valid candidates — ending loop on seed result.`); break }
    if (repoMode) await enrichBlindPool(stagedR, runoffDir, phaseTitle)
    const runoffPool = `${runoffDir}/_pool.md`
    const rRaw = await parallelQuorum(lenses, (lens, i) =>
      askLens(lens, stagedR, runoffPool, phaseTitle, `${label}-runoff${iter}-${lens.key}-r1`, 1, null, i), phaseTitle, {
      timeoutSecsFor: lensTimeoutSecsFor,
      neverClose: (lens) => isSecurityLens(lens.key), // NEVER close over a security-gate seat
      seatLabelFor: (lens) => `${label}:runoff${iter}:${lens.key}`,
    })
    const rVerdicts = rRaw.filter(Boolean)
    if (!rVerdicts.length) { log(`steelman ${label} i${iter}: all runoff judges died — ending loop on seed result.`); break }
    const rt = councilTally(rVerdicts)
    const origOf = (blind) => { const e = stagedR.find(c => c.blind === blind); return e ? e.orig : null }
    const mapVerdict = v => ({ ...v, vote: origOf(v.vote) || v.vote })
    lastRunoffVerdicts = rVerdicts.map(mapVerdict)
    steelmanVerdicts = rVerdicts.map(v => ({ ...v,
      candidates: (v.candidates || []).map(c => ({ ...c, label: origOf(String(c.label || '').charAt(0)) || c.label })),
      vote: origOf(v.vote) || v.vote,
      ranking: (v.ranking || []).map(l => origOf(l) || l) }))
    // Persist phase 2: durable per-seat runoff verdicts (ORIG-LETTER mapped — what steelmanVerdicts
    // consumes) under the base reviewDir's _judges/. Runoff verdicts never appear in council.rounds,
    // so these files are a natural partial checkpoint (inspection v1; resume v2), recorded under
    // distinct runoff keys the tally skeleton never matches.
    await persistSeatFiles(steelmanVerdicts.map(v => ({
      key: `runoff${iter}|${v.lens}`, name: `${label}-runoff${iter}-${v.lens}-r1.json`, content: json(v) })))
    steelmanMeta.rounds.push({
      iteration: iter,
      change_lists: Object.fromEntries(seeds.map(s => [s, (changeLists[s] || []).map(it => it.change)])),
      gate: Object.fromEntries(stagedR.map(c => [c.orig, c.variant])),
      votes: { ...rt.votes }, vetoed: rt.vetoed,
      winner: rt.winner ? origOf(rt.winner) : null,
      ...(loneFinalist ? { lone_finalist: true, winning_variant: rt.winner ? (stagedR.find(c => c.blind === rt.winner) || {}).variant : null } : {}),
    })
    const bothVetoed = stagedR.length > 0 && stagedR.every(c => rt.vetoedSet.has(c.blind))
    if (bothVetoed) {
      log(`council ${label}: STEELMAN runoff i${iter} — every finalist vetoed UNSAFE; NO_CONSENSUS (needs-human).`)
      return attachAspects(buildCouncilResult({ winner: null, verdicts: steelmanVerdicts, roundsLog, labels, lenses, no_consensus: true, humanReason: 'both steelman finalists vetoed UNSAFE in the runoff' }))
    }
    if (rt.winner != null) {
      const winEntry = stagedR.find(c => c.blind === rt.winner)
      finalWinner = winEntry.orig
      steelmanMeta.decided_by = 'majority'
      // ship the version that WON: copy the winning gated artifact over the winner's staged dir so
      // every downstream consumer (plan bundling, adoption, reports) gets the polished artifact.
      if (winEntry.ws !== `${reviewDir}/${finalWinner}`) {
        await agentLadder(`This is an approved internal step of the joust-engine tournament: adopt the improved winner artifact. Run in ONE Bash call: SRC=${q(winEntry.ws)}; DEST=${q(`${reviewDir}/${finalWinner}`)}; find "$DEST" -mindepth 1 -delete 2>/dev/null; cp -R "$SRC"/. "$DEST"/; echo done. Then reply "done".`,
          { model: HELPER_MODEL, phase: phaseTitle, label: `${label}-adopt-boost` }).catch(e => log(`steelman ${label}: winner-adoption copy failed (${String(e).slice(0, 100)}) — the winning content remains at ${winEntry.ws}`))
      }
    } else if (iter < maxIters) {
      // tie -> iterate: next boosts are gated versions of THIS round (ratchet forward on gate pass)
      for (const c of stagedR) if (c.variant === 'boosted') currentWs[c.orig] = c.ws
      log(`council ${label}: STEELMAN runoff i${iter} tied (${Object.keys(rt.votes).sort().map(k => `${k}:${rt.votes[k]}`).join(', ') || 'no votes'}); iterating.`)
    }
  }

  if (finalWinner == null && loneFinalist) { finalWinner = seeds[0]; steelmanMeta.decided_by = 'majority' } // solo polish fell through -> original stands
  if (finalWinner != null) {
    const result = buildCouncilResult({ winner: finalWinner, verdicts: steelmanVerdicts, roundsLog, labels, lenses, no_consensus: false })
    result.reasoning = `Steelman shootout: seed vote ${seedVotesStr}${t.winner ? ` (seed majority ${t.winner})` : ''}; finalists [${seeds.join(', ')}] each received a judge-guided improvement pass; Candidate ${finalWinner} won the cold runoff after ${steelmanMeta.rounds.length} steelman round(s). Decided by ${steelmanMeta.decided_by}.`
    result.council.steelman = steelmanMeta
    if (guidanceWanted) result.guidance = await synthesizeGuidance(steelmanVerdicts, phaseTitle, `${label}-guidance`)
    return attachAspects(result)
  }
  // 5 rounds, still tied -> the ORCHESTRATOR casts the deciding vote (never the engine, never an
  // LLM aggregation). NOT no_consensus: both finalists are gated, security-cleared, 5x improved —
  // the residual choice is judgment between two goods, surfaced to the caller.
  steelmanMeta.decided_by = 'orchestrator-pending'
  log(`council ${label}: STEELMAN loop exhausted ${maxIters} rounds still tied — returning needs_orchestrator_pick [${seeds.join(', ')}].`)
  const result = buildCouncilResult({ winner: null, verdicts: steelmanVerdicts, roundsLog, labels, lenses, no_consensus: false })
  result.council.steelman = steelmanMeta
  result.needs_orchestrator_pick = {
    finalists: seeds,
    gated_ws: { ...currentWs },
    verdicts: (lastRunoffVerdicts || steelmanVerdicts).map(v => ({ lens: v.lens, vote: v.vote, reasoning: v.reasoning })),
  }
  result.reasoning = `Steelman shootout: ${maxIters} improvement rounds could not break the tie between [${seeds.join(', ')}] — the orchestrator must cast the deciding vote (both finalists are gated and security-cleared; a vetoed candidate can never be picked).`
  if (guidanceWanted) result.guidance = await synthesizeGuidance(steelmanVerdicts, phaseTitle, `${label}-guidance`)
  return attachAspects(result)
}

// ---- begin: report renderers (PURE — sliced by bin/je-render.mjs + tests; deps: GUIDANCE_CAP only) ----

function priorLine(item) {
  if (typeof item === 'string') return `- [tentative] ${item}`
  const tag = item.conf === 'strong' ? 'strong' : 'tentative'
  const why = item.why ? ` (${item.why})` : ''
  return `- [${tag}] ${item.text}${why}`
}

// Render the council's deliberation for the verdict.md report (per-round tally + per-judge verdicts + vetoes).
function councilToMd(council) {
  if (!council) return ''
  const L = ['## Council deliberation', '',
    `**Lenses:** ${(council.lenses || []).join(', ')}  •  **Rounds used:** ${council.rounds_used}  •  **Living at final tally:** ${council.final_living}`,
    council.fast_tally ? `**Fast tally (intermediate review):** one vote round, no deliberation • carried: ${(council.carried || []).join(', ') || 'none (all vetoed)'}` : '',
    council.no_consensus ? `**Result:** NO_CONSENSUS${council.human_reason ? ` — ${council.human_reason}` : ''}` : '', '']
  if (council.steelman) {
    const sm = council.steelman
    L.push('### Steelman shootout', '',
      `**Seed vote:** ${Object.keys(sm.seed_votes || {}).sort().map(k => `${k}:${sm.seed_votes[k]}`).join(', ') || 'none'}${sm.seed_majority ? ` (seed majority ${sm.seed_majority})` : ''} • **Finalists:** ${(sm.seeds || []).join(', ')} • **Decided by:** ${sm.decided_by || '—'}`, '',
      '| Iteration | Change-list sizes | Gate | Runoff votes | Veto | Winner |', '|---|---|---|---|---|---|')
    for (const r of (sm.rounds || [])) {
      const sizes = Object.keys(r.change_lists || {}).map(k => `${k}:${(r.change_lists[k] || []).length}`).join(', ') || '—'
      const gate = Object.keys(r.gate || {}).map(k => `${k}:${r.gate[k]}`).join(', ') || '—'
      const votes = Object.keys(r.votes || {}).sort().map(k => `${k}:${r.votes[k]}`).join(', ') || '—'
      L.push(`| ${r.iteration}${r.lone_finalist ? ' (solo polish)' : ''} | ${sizes} | ${gate} | ${votes} | ${(r.vetoed || []).join(', ') || '—'} | ${r.winner || 'tie'} |`)
    }
    L.push('')
    for (const r of (sm.rounds || [])) {
      for (const k of Object.keys(r.change_lists || {})) {
        if (!(r.change_lists[k] || []).length) continue
        L.push(`**i${r.iteration} boost for Candidate ${k}:**`)
        for (const c of r.change_lists[k]) L.push(`- ${c}`)
        L.push('')
      }
    }
  }
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
      if (v.judge_model && v.judge_model !== 'opus') L.push(`- judge: ${v.judge_model}`)
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
    ...(g && g.carried_note ? [g.carried_note, ''] : []),
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
// Render the per-seat RC summary as a Markdown section. Blind-safe: seat ids are candidate letters /
// `label:lens` / helper labels — never a model identity — so it is safe in both SUMMARY.md and
// SUMMARY.blind.md. All-00 run => a one-line note and no table (the acceptance case).
function rcSummaryMd(rcSummary) {
  if (!rcSummary || typeof rcSummary !== 'object') return []
  const byCode = rcSummary.by_code || {}
  const codes = Object.keys(byCode).sort()
  const byCodeStr = codes.map(c => `${c}×${byCode[c]}`).join(', ') || '—'
  const L = ['## Return codes (per-seat)', '', `**Seats:** ${rcSummary.seats || 0}  •  **by code:** ${byCodeStr}`, '']
  const non00 = Array.isArray(rcSummary.non00) ? rcSummary.non00 : []
  if (!non00.length) { L.push('_All seats returned 00 (expected result)._', ''); return L }
  L.push('| Seat | Phase | RC | Meaning | Reason |', '|---|---|---|---|---|')
  for (const s of non00) L.push(`| ${s.seat} | ${s.phase} | ${s.rc} | ${RC_MEANING[s.rc] || ''} | ${s.reason || ''} |`)
  L.push('')
  return L
}

function summaryMd({ task, mode, n, unblind, r1mapping, r1review, finalMapping, finalRank, winnerRound, rcSummary }) {
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
  for (const line of rcSummaryMd(rcSummary)) L.push(line)
  return L.join('\n') + '\n'
}
// ---- end: report renderers ---------------------------------------------------------------------

// ---- begin: structural persist helpers (PURE — issue #33; sliced by tests) ---------------------
// SHA-256 in pure JS (the sandbox has no node:crypto). Verified against `shasum -a 256` output.
function sha256Hex(str) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i)
    if (c > 0xffff) i++
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
             (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  const rr = (x, n) => ((x >>> n) | (x << (32 - n))) | 0
  const W = new Array(64)
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) | (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3]
    for (let t = 16; t < 64; t++) {
      const s0 = rr(W[t - 15], 7) ^ rr(W[t - 15], 18) ^ (W[t - 15] >>> 3)
      const s1 = rr(W[t - 2], 17) ^ rr(W[t - 2], 19) ^ (W[t - 2] >>> 10)
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let t = 0; t < 64; t++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[t] + W[t]) | 0
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0]
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

// Heredoc delimiter guaranteed absent from the content (a content line equal to the delimiter would
// terminate the write early — exactly the silent-truncation class this block exists to kill).
function heredocDelim(content) {
  let n = 0, d = 'JE_EOF_W'
  while (content.includes(d)) d = `JE_EOF_W${++n}`
  return d
}

// Normalize for heredoc transport: `cat <<'EOF'` requires the body to end in a newline. The sha is
// computed over THIS normalized body — what lands on disk — never the raw input.
function heredocBody(content) {
  const s = String(content)
  return s.endsWith('\n') ? s : s + '\n'
}
// ---- end: structural persist helpers ------------------------------------------------------------

// ---- begin: tally skeleton builder (PURE — persist phase 2, issue #33; sliced by tests) ----------
// Deep-copy the council result and replace each council.rounds[*].verdicts[*] body with its
// on-disk seat ref {"$seat": "<runDir-relative path>", "sha256": "<hex>"} — matched by lens key +
// round. Skeleton + splice, never recompute: bin/je-assemble.mjs reverses this by splicing the
// sha-verified seat files back, byte-identical to json(result). A verdict with no verified on-disk
// ref stays INLINE (the skeleton grows but assembly still succeeds — never a crashed persist). The
// deep copy guarantees refs can NEVER leak into json(review) itself (byte-parity invariant).
function buildTallySkeleton(result, refs) {
  const skel = JSON.parse(JSON.stringify(result))
  const rounds = skel && skel.council && Array.isArray(skel.council.rounds) ? skel.council.rounds : []
  for (const r of rounds) {
    if (!r || !Array.isArray(r.verdicts)) continue
    r.verdicts = r.verdicts.map(v => {
      const ref = v && v.lens && refs ? refs[`${v.lens}|r${r.round}`] : null
      return ref ? { $seat: ref.rel, sha256: ref.sha } : v
    })
  }
  return skel
}
// ---- end: tally skeleton builder -----------------------------------------------------------------

// ---- durable persistence (sandbox has NO node:fs/import/process — write via a sonnet helper+Bash) ----
const json = obj => JSON.stringify(obj, null, 2) + '\n'

// Persist phase 2 (issue #33): per-seat verdict refs, module-level, keyed phase label ->
// { '<lensKey>|r<round>': { rel, sha } } for round-log seats (splice-able into the tally skeleton)
// plus 'runoff<i>|<lensKey>' keys for steelman runoff seats (durable/inspection only — runoff
// verdicts never appear in council.rounds). NEVER attached to the council result itself: refs
// inside json(review) would break assemble byte-parity. Written by councilJudge as each round's
// seat files verify; read by the checkpoint call sites via verdictEntries().
const seatRefs = Object.create(null)

// Plugin bin dir (for on-disk derivation via bin/je-render.mjs), derived from any supplied runner path.
const PLUGIN_BIN = (() => {
  for (const r of [A.issueRunner, A.codexRunner, A.minimaxRunner, A.glmRunner, A.localRunner, A.grokRunner]) {
    if (typeof r === 'string' && r.includes('/bin/')) return r.slice(0, r.lastIndexOf('/'))
  }
  return null
})()

// Write one persistence point — STRUCTURAL PERSIST (issue #33). Three entry kinds:
//   { path, content }            — typed once through the helper as a single quoted HEREDOC (no
//                                  printf re-quoting, no chunking), then VERIFIED: the helper reports
//                                  `wc -c` + `shasum -a 256` per file and the engine compares against
//                                  the sha it computed IN CODE (sha256Hex) over the exact bytes. A
//                                  mismatch (abbreviation, mangling, truncation) is a verified miss.
//   { path, content, derive }    — DERIVED artifact: when a plugin bin dir is known, the helper runs
//                                  `node bin/je-render.mjs <mode> <from> <path> [...]` so the bytes are
//                                  rendered ON DISK by deterministic code and NEVER transit the model
//                                  (the dominant cost: run C typed ~290KB at ~9KB/min ≈ 35min/checkpoint).
//                                  `content` is the fallback (typed+verified) when PLUGIN_BIN is unknown.
//   { path, content, assemble }  — ASSEMBLED artifact (persist phase 2): the helper runs
//                                  `node bin/je-assemble.mjs <assemble.tally> <path>` so deterministic
//                                  code splices the sha-pinned per-seat files back into the tally
//                                  skeleton ON DISK. Unlike derive, the result is FULLY verified: the
//                                  FLP sha must equal the engine-computed sha256Hex over `content`
//                                  (= json(review)) — assembled bytes ≠ the engine's result object is
//                                  a verified miss, so corruption structurally cannot land silently.
// Any verified miss is RETRIED ONCE (a failed derive/assemble retries as typed content); a still-bad
// target is logged as a REAL, path-named failure. An unverified LLM write is NEVER treated as success
// (#D-0002). Still fire-and-forget overall: a persist failure logs but must never crash a fully-paid
// run. Returns the list of VERIFIED paths (empty on total failure) so callers — the per-seat writes
// feeding the tally skeleton — can record refs only for files that actually landed.
async function persist(pairs, phaseTitle) {
  const files = (pairs || []).filter(p => p && p.path && (p.content != null || p.derive))
  if (!files.length) return []
  const expected = {} // path -> sha256 hex for typed writes (derived writes verify bytes>0 + exit only)
  const stepFor = (f, allowDerive) => {
    const dir = f.path.slice(0, f.path.lastIndexOf('/'))
    const tmp = `${f.path}.partial`
    const report = `printf 'FLP %s %s %s\\n' ${q(f.path)} "$(wc -c < ${q(f.path)} 2>/dev/null || echo 0)" "$(shasum -a 256 ${q(f.path)} 2>/dev/null | cut -d' ' -f1)"`
    if (f.assemble && f.content != null && allowDerive && PLUGIN_BIN) {
      // Assembled write: deterministic splice on disk, but expected[] STAYS SET (over the exact
      // json(review) bytes) — full-file verification, stronger than derive's bytes>0 check. A
      // je-assemble crash/miss/mismatch surfaces as a verified miss and retries as typed content.
      expected[f.path] = sha256Hex(heredocBody(f.content))
      return `mkdir -p ${q(dir)} && node ${q(`${PLUGIN_BIN}/je-assemble.mjs`)} ${q(f.assemble.tally)} ${q(f.path)}; ${report}`
    }
    if (f.derive && allowDerive && PLUGIN_BIN) {
      delete expected[f.path]
      const extra = f.derive.title ? ` ${q(f.derive.title)}` : ''
      return `mkdir -p ${q(dir)} && node ${q(`${PLUGIN_BIN}/je-render.mjs`)} ${q(f.derive.mode)} ${q(f.derive.from)} ${q(f.path)}${extra}; ${report}`
    }
    if (f.content == null) return `printf 'FLP %s 0 none\\n' ${q(f.path)}` // derive-only entry with no bin dir: report the miss honestly
    const body = heredocBody(f.content)
    const delim = heredocDelim(body)
    expected[f.path] = sha256Hex(body)
    return `mkdir -p ${q(dir)} && cat > ${q(tmp)} <<'${delim}'\n${body}${delim}\n` +
           `mv -f ${q(tmp)} ${q(f.path)}; ${report}`
  }
  // Run the given file list through the write-agent; return a map path -> {bytes, sha}.
  const writeAndMeasure = async (list, allowDerive) => {
    const script = list.map(f => stepFor(f, allowDerive)).join('\n')
    const res = await agentLadder(
      `This is an approved internal step of the joust-engine tournament: persist result artifacts. ` +
      `Run this exact shell script in ONE Bash call, reproducing it VERBATIM — every heredoc body byte-for-byte, ` +
      `no reformatting, no abbreviation (the engine verifies checksums; any drift is detected and retried). ` +
      `It prints one line per file of the form "FLP <path> <byte-count> <sha256>". Then return the structured ` +
      `results: for EACH printed FLP line, an entry {path, bytes, sha}. Report exactly what the script printed — ` +
      `do not infer or change values. Do nothing else:\n\n${script}`,
      // sonnet, not haiku — OPERATOR POLICY (2026-07-06): no haiku sub-agents until a Haiku 5.x-base
      // ships, even though the sha verification below now makes the dataplane model-independent.
      { model: HELPER_MODEL, schema: PERSIST_SCHEMA, phase: phaseTitle, label: 'persist' }
    ).catch(() => null)
    const seen = {}
    for (const r of (res && Array.isArray(res.results) ? res.results : [])) {
      if (r && r.path) seen[String(r.path)] = { bytes: Number(r.bytes) || 0, sha: typeof r.sha === 'string' ? r.sha.toLowerCase() : '' }
    }
    return seen
  }
  const bad = (f, seen) => {
    const got = seen[f.path]
    if (!got || !(got.bytes > 0)) return 'missing/empty'
    if (expected[f.path] && got.sha && got.sha !== expected[f.path]) return `sha mismatch (relay corruption): expected ${expected[f.path].slice(0, 12)}…, got ${got.sha.slice(0, 12)}…`
    return null
  }
  try {
    let seen = await writeAndMeasure(files, true)
    let missing = files.filter(f => bad(f, seen))
    if (missing.length) {                          // verified miss/corruption -> retry ONLY those, once,
      log(`persist (${phaseTitle}): ${missing.length} file(s) unverified, retrying once (as typed+verified writes): ${missing.map(f => `${f.path} [${bad(f, seen)}]`).join(', ')}`)
      const seen2 = await writeAndMeasure(missing, false) // ...forcing the typed path (a broken derive never silently repeats)
      seen = { ...seen, ...seen2 }
      missing = files.filter(f => bad(f, seen))
    }
    if (missing.length) log(`persist FAILED (${phaseTitle}): ${missing.map(f => `${f.path} [${bad(f, seen)}]`).join(', ')} after retry`)
    const badSet = new Set(missing.map(f => f.path))
    return files.map(f => f.path).filter(p => !badSet.has(p))
  } catch (e) { log(`persist failed (${phaseTitle}): ${String(e).slice(0, 140)}`); return [] }
}

// Persist phase 2 (issue #33): the verdict.json entries for one review checkpoint. With a council
// AND at least one verified per-seat file, the bulk never transits the model: a SMALL typed tally
// skeleton (the result with $seat refs) lands first, then bin/je-assemble.mjs splices the
// sha-pinned seat files back into verdict.json ON DISK — verified against the engine-computed
// sha256Hex(json(review)) via the assemble entry's `content`. Any failure retries through the
// existing ladder as today's single typed write (worst case = current behaviour). No council
// (judges:1 legacy) or no verified refs → today's plain typed write, unchanged.
function verdictEntries(dir, review, phaseLabel) {
  const path = `${dir}/verdict.json`
  const content = json(review)
  const refs = seatRefs[phaseLabel]
  if (!review || !review.council || !refs || !Object.keys(refs).length) return [{ path, content }]
  const tallyPath = `${dir}/_judges/tally.json`
  return [ // tally.json ordered BEFORE the assemble step — persist runs its steps sequentially in one script
    { path: tallyPath, content: json(buildTallySkeleton(review, refs)) },
    { path, content, assemble: { tally: tallyPath } },
  ]
}

// ---- auto-filed engine issues (privacy-scrubbed, fail-closed, fire-and-forget) ----
// At run end, for each ENGINE-FAULT RC class present in seatRcs, file ONE deduplicated dogfood issue
// per class per run to the ENGINE repo via bin/je-issue.sh. Evidence = the RC lines + JOUST-* marker
// excerpts ONLY; je-issue.sh's NEW scrub pass redacts host/user/env details BEFORE its guards (defense
// in depth). Wrapped so it can NEVER crash or block a fully-paid run (log + continue). A filing FAILURE
// is recorded as a non-00 `issue:<rc>` seat so it is never silently dropped from the report.
async function maybeFileEngineIssues(phaseTitle) {
  try {
    if (!autoIssue) {
      if (A.noAutoIssue !== true && !A.issueRunner && !autoIssueWarned) {
        log('auto-issue: issueRunner not supplied (pass args.issueRunner = <plugin-root>/bin/je-issue.sh) — skipping engine-fault issue filing.')
        autoIssueWarned = true
      }
      return
    }
    const faults = seatRcs.filter(s => ENGINE_FAULT_CLASSES.has(s.rc))
    if (!faults.length) return // zero-failure run: files nothing (acceptance)
    const byClass = new Map()
    for (const s of faults) { if (!byClass.has(s.rc)) byClass.set(s.rc, []); byClass.get(s.rc).push(s) }
    for (const [rc, group] of byClass) {
      const title = `JE-RC ${rc} (${RC_MEANING[rc]}) — engine-fault (auto)`
      const sev = (rc === '04' || rc === '06') ? 'sev1' : 'sev2'          // outcome-corrupting classes -> sev1
      const area = (rc === '01' || rc === '02' || rc === '07') ? 'runner' : 'infra'
      const evLines = group.map(s => `JOUST-RC ${s.rc} ${s.reason}  [seat ${s.seat} @ ${s.phase}]`)
      const logGreps = group.filter(s => s.logPath)
        .map(s => `printf '\\n----- %s -----\\n' ${q(s.seat)}; grep -a '^JOUST-' ${q(s.logPath)} 2>/dev/null | tail -n 20`)
        .join('; ')
      const ev = `${runDir}/_rc-issues/rc-${rc}.md`
      const cmd = `mkdir -p ${q(`${runDir}/_rc-issues`)}; { printf '%s\\n' ${q(evLines.join('\n'))}; ${logGreps || 'true'}; } > ${q(ev)}; ` +
        `GH_REPO=${q(engineRepo)} JE_ISSUE_AUTOFILE=1 bash ${q(A.issueRunner)} new --sev ${sev} --area ${area} ` +
        `--title ${q(title)} --evidence-file ${q(ev)} --run-id ${q(safeRunId)} 2>&1; echo "JEI ${rc} rc=$?"`
      const res = await agentLadder(
        `This is an approved internal step: file ONE dogfood issue for engine-fault class ${rc}. Run this exact shell command in ONE Bash call and report its stdout verbatim. Do nothing else:\n\n${cmd}`,
        { model: HELPER_MODEL, phase: phaseTitle, label: `rc-issue-${rc}` }).catch(() => null)
      const filed = /JEI .* rc=0\b/.test(String(res))
      recordSeat(`issue:${rc}`, phaseTitle, filed ? RC.OK : RC.UNKNOWN, `auto-issue-${filed ? 'filed-or-drafted' : 'FAILED'}`)
    }
  } catch (e) { log(`auto-issue step failed (non-fatal): ${String(e).slice(0, 140)}`) }
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
  await agentLadder(`Run this exact shell command in ONE Bash call and report its stdout. Do nothing else:\n\n${cmd}`,
    { model: HELPER_MODEL, phase: 'Implement Round 3', label: 'seed-plan' }).catch(() => null)
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

// Read the SAME-TASK convergence aggregate from the run ledger (bin/je-ledger.mjs) via the opt-in
// ledger runner. Fail-open end to end: no runner / no bucket / dead agent / garbled output => null,
// which trimSeatsForConvergence treats as "leave the seat count unchanged". The runner is expected
// to print ONE line for the bucket: `JE-LEDGER-CONVERGENCE samples=<int> ratio=<float>`; the engine
// (parseConvergenceEvidence), not the LLM, is the source of truth for the numbers.
async function readConvergenceEvidence(taskBucket) {
  if (!DYNAMIC_M_ON || !ledgerRunner || !taskBucket) return null
  // Fail-open (issue #36): the opt-in dynamic-M path must NEVER throw. Guard the optional
  // CODEX_JUDGE_DUMP_SCHEMA — if it is absent, degrade to an inline {raw} schema rather than a
  // ReferenceError — and wrap the whole read so any failure returns null (seats stay unchanged).
  try {
    const dumpSchema = (typeof CODEX_JUDGE_DUMP_SCHEMA !== 'undefined' && CODEX_JUDGE_DUMP_SCHEMA)
      || { type: 'object', additionalProperties: false, properties: { raw: { type: 'string' } }, required: ['raw'] }
    const cmd = `node ${q(ledgerRunner)} convergence ${q(taskBucket)} 2>/dev/null`
    const res = await agent(
      `Run this exact shell command in ONE Bash call and return its stdout VERBATIM in the "raw" field. Do not summarize or interpret it. Do nothing else:\n\n${cmd}`,
      { model: HELPER_MODEL, schema: dumpSchema, phase: 'Implement Round 3', label: 'ledger-convergence' }
    ).catch(() => null)
    const raw = res && typeof res.raw === 'string' ? res.raw : ''
    return parseConvergenceEvidence(raw)
  } catch {
    return null
  }
}

// Run ONE implement round: dispatch the implement pool seeded with the plan, stage, enrich, and
// judge with the CODE lenses. `wantGuidance` distils round-3 → round-4 priors (round 3 only).
async function implementRound(roundName, phaseTitle, rot, seedPlanPath, guidance, reviewDir, wantGuidance) {
  const list = implementSeats.map(a => ({ ...a, roundName, ws: repoMode ? worktreePath(roundName, a.label) : scratchPath(roundName, a.label) }))
  await buildWorktrees(roundName, list)
  // Per-attempt seed (A/B briefs): a seat carrying its own seedPlanPath uses it; else the shared one.
  const doneRaw = (await parallelQuorum(list, (a) => dispatch(a, a.ws, guidance, phaseTitle, 'implement', a.seedPlanPath || seedPlanPath), phaseTitle, {
    timeoutSecsFor: attemptTimeoutSecsFor, seatLabelFor: (a) => a.label,
  })).filter(Boolean)
  const done = doneRaw.map(c => ({ ...c, roundName }))
  { const w = dispatchDropSummary(phaseTitle, dispatchDrops, list.length, done.length); if (w) log(w) }
  await snapshotWorktrees(roundName, done)
  if (!done.length) return { blind: [], mapping: [], review: { __failed: 'no implement attempts survived dispatch' } }
  let staged = await stageAndValidate(blindLabel(done, rot), reviewDir, phaseTitle)
  // Run F: mechanical pre-council gate — classify/stamp every valid candidate, invalidate corrupt
  // patches, BEFORE the code council (or legacy judge) sees the pool. Implement rounds only.
  staged = await mechanicalPatchGate(staged, reviewDir, phaseTitle)
  // issue #36: inContention drops NON-representative byte-identical duplicates from judging while
  // leaving them valid:true (they never enter blindList, exactly as an invalid candidate doesn't).
  const blind = staged.filter(inContention)
  const mapping = staged.map(c => ({ candidate: c.blind, model: c.displayModel, valid: c.valid,
    ...(c.mechanical ? { mechanical: c.mechanical.class } : {}),
    ...(c.contract ? { contract: c.contract.class } : {}), // run G: layout-conformance class (audit only; never gates)
    ...(c.collapse ? { collapse: c.collapse } : {}), // issue #36: dedup group (rep + all letters) — unblinding bookkeeping, never judge-visible
    ...(c.seedBrief ? { seedBrief: c.seedBrief } : {}), // A/B lineage — bookkeeping only, judges never see it
    ...(c.valid ? {} : { failReason: c.failReason }) }))
  if (!blind.length) return { blind, mapping, review: { __failed: 'no valid implement deliverables (post-mechanical-gate)' } }
  if (repoMode) await enrichBlindPool(blind, reviewDir, phaseTitle)
  const review = await judge('code reviewer', blind, wantGuidance, `${reviewDir}/_pool.md`,
    wantGuidance ? REVIEW_SCHEMA : RANK_SCHEMA, phaseTitle, `${roundName}-review`, LENSES, 'final')
  return { blind, mapping, review }
}

// The implement phase driver. Round 3 always; Round 4 ONLY on a failed R3 gate (guided by R3 review).
async function implementPhase(seedPlanPath) {
  phase('Implement Round 3')
  log(`Implement Round 3: ${implementAttempts.length} implementer(s) seeded with the winning plan (${implementAttempts.map(a => a.displayModel).join(', ')})`)
  const r3 = await implementRound('impl-3', 'Implement Round 3', 3, seedPlanPath, null, `${runDir}/review-impl-3`, true)
  await persist([
    ...(r3.review && !r3.review.__failed ? [
      ...verdictEntries(`${runDir}/review-impl-3`, r3.review, 'impl-3-review'),
      { path: `${runDir}/review-impl-3/verdict.md`, content: verdictToMd(r3.review, 'Implement Round 3 verdict'), derive: { mode: 'verdict-md', from: `${runDir}/review-impl-3/verdict.json`, title: 'Implement Round 3 verdict' } },
    ] : []),
    ...(r3.review && r3.review.council ? [{ path: `${runDir}/review-impl-3/council.json`, content: json(r3.review.council), derive: { mode: 'council-json', from: `${runDir}/review-impl-3/verdict.json` } }] : []),
  ], 'Implement Round 3')
  const g3 = implGatePassed(r3)
  if (g3.pass) {
    return { rounds: 3, round3: { mapping: r3.mapping, review: r3.review }, winner: g3.winner, winnerRound: 3, no_consensus: false, needs_human: false }
  }
  if (r3.review && r3.review.needs_orchestrator_pick) {
    // judging-v3: a 5x-steelman tie is NOT a gate failure — the orchestrator picks between two
    // gated, security-cleared finalists. R4 (a fresh full round) would cost far more than the pick.
    log('Implement Round 3: steelman loop tied — surfacing needs_orchestrator_pick (no Round 4).')
    return { rounds: 3, round3: { mapping: r3.mapping, review: r3.review }, winner: null, winnerRound: null, no_consensus: false, needs_human: false, needs_orchestrator_pick: r3.review.needs_orchestrator_pick }
  }
  // R4 exists ONLY as the guided retry: R3 produced no gate-passing candidate (verify fail /
  // council NO_CONSENSUS / all vetoed). A plan-phase NO_CONSENSUS never reaches here — it was
  // surfaced before any implement spend.
  log(`Implement Round 3 gate NOT passed (${g3.reason}); escalating to Implement Round 4 (guided retry).`)
  phase('Implement Round 4')
  let guidance = (r3.review && r3.review.guidance) || null
  { const stub = guidanceStub(guidance)
    if (stub) { log(`JE-GUIDANCE-STUB [Implement Round 4]: ${stub} — falling back to task-only guided retry (no placeholder guidance seeds a brief).`); guidance = null } }
  const r4 = await implementRound('impl-4', 'Implement Round 4', 4, seedPlanPath, guidance, `${runDir}/review-impl-4`, false)
  await persist([
    ...(r4.review && !r4.review.__failed ? [
      ...verdictEntries(`${runDir}/review-impl-4`, r4.review, 'impl-4-review'),
      { path: `${runDir}/review-impl-4/verdict.md`, content: verdictToMd(r4.review, 'Implement Round 4 verdict'), derive: { mode: 'verdict-md', from: `${runDir}/review-impl-4/verdict.json`, title: 'Implement Round 4 verdict' } },
    ] : []),
    ...(r4.review && r4.review.council ? [{ path: `${runDir}/review-impl-4/council.json`, content: json(r4.review.council), derive: { mode: 'council-json', from: `${runDir}/review-impl-4/verdict.json` } }] : []),
  ], 'Implement Round 4')
  const g4 = implGatePassed(r4)
  const r4pick = !g4.pass && r4.review && r4.review.needs_orchestrator_pick ? r4.review.needs_orchestrator_pick : null
  return {
    rounds: 4,
    round3: { mapping: r3.mapping, review: r3.review },
    round4: { mapping: r4.mapping, review: r4.review },
    winner: g4.pass ? g4.winner : null,
    winnerRound: g4.pass ? 4 : null,
    no_consensus: !!(r4.review && r4.review.no_consensus),
    ...(r4pick ? { needs_orchestrator_pick: r4pick } : {}),
    needs_human: !g4.pass && !r4pick, // R4 failed the gate → needs-human; a steelman tie routes to the orchestrator instead
  }
}

// ================= REJUDGE MODE (args.rejudgeCandidates) ======================================
// Salvage/re-judge entry: judge an EXISTING pool of staged implement candidates without running
// any plan or implement round. Motivated by run-i (2026-07-06): a mechanical-gate bug false-killed
// 11/12 staged candidates AFTER the expensive dispatch had already succeeded — the artifacts were
// intact on disk, only the judgment was wrong. Rejudge re-runs the (fixed) mechanical gate over
// the staged dirs under FRESH blind letters (cold re-judge: no letter aligns with the source run),
// rebuilds the pool, and runs the full CODE council (majority + dual security veto + steelman).
// args.rejudgeCandidates = [{ dir: <abs staged-candidate dir>, model: <displayModel>, source: <tag> }]
// args.rejudgeRot (optional int) rotates the fresh letter assignment. `attempts` still needs one
// well-formed (never-dispatched) seat to satisfy the top-of-file guard.
if (Array.isArray(A.rejudgeCandidates) && A.rejudgeCandidates.length) {
  phase('Rejudge')
  log(`▶ REJUDGE: ${A.rejudgeCandidates.length} staged candidate(s) — fixed mechanical gate + code council, no generation rounds`)
  await buildContext() // pins gateBaseShaFile (HEAD) for the gate's real-apply snapshot baseline
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const rjN = A.rejudgeCandidates.length
  const rjRot = Number.isInteger(A.rejudgeRot) ? A.rejudgeRot : 3
  const reviewDir = `${runDir}/review-rejudge`
  const rjAssign = A.rejudgeCandidates.map((r, i) => ({ ...r, blind: letters[(i + rjRot) % rjN] }))
  // Stage: copy each source dir into its fresh blind slot; STRIP the source run's engine stamps
  // (mechanical/contract/convergence/enrichment) so the fixed gate re-derives them — a stale
  // corrupt-patch stamp from the buggy gate must never leak into the rebuilt pool.
  const copyScript = [`mkdir -p ${q(reviewDir)}`].concat(rjAssign.map(c => {
    const dest = `${reviewDir}/${c.blind}`
    return `rm -rf ${q(dest)}; mkdir -p ${q(dest)}; cp -R ${q(c.dir)}/. ${q(dest)}/ 2>/dev/null; ` +
           `rm -f ${q(dest)}/mechanical.txt ${q(dest)}/contract.txt ${q(dest)}/convergence.txt ${q(dest)}/enrichment.txt; ` +
           `echo "JRJ ${c.blind} $(find ${q(dest)} -type f 2>/dev/null | grep -c .)"`
  })).join('\n')
  await agentLadder(
    `Run this exact shell script in ONE Bash call. It stages candidate directories for re-judging and prints one "JRJ <letter> <filecount>" line per candidate. Report the printed lines; do nothing else:\n\n${copyScript}`,
    { model: HELPER_MODEL, phase: 'Rejudge', label: 'rejudge-stage' }
  ).catch(() => null)
  let rjStaged = rjAssign.map((c, i) => ({
    label: c.source || `rejudge-${i + 1}`, dispatch: 'anthropic', displayModel: c.model || 'unknown',
    blind: c.blind, ws: `${reviewDir}/${c.blind}`, valid: true, failReason: '', roundName: 'rejudge',
  }))
  rjStaged = await mechanicalPatchGate(rjStaged, reviewDir, 'Rejudge')
  const rjBlind = rjStaged.filter(inContention)
  const rjMapping = rjStaged.map(c => ({ candidate: c.blind, model: c.displayModel, source: c.label, valid: c.valid,
    ...(c.mechanical ? { mechanical: c.mechanical.class } : {}),
    ...(c.contract ? { contract: c.contract.class } : {}),
    ...(c.collapse ? { collapse: c.collapse } : {}),
    ...(c.valid ? {} : { failReason: c.failReason }) }))
  if (!rjBlind.length) {
    await persist([{ path: `${runDir}/mapping.json`, content: json({ mode: 'rejudge', n: rjN, rc_summary: rcSummaryLive(), ...(dynamicMBucket ? { taskBucket: dynamicMBucket } : {}), candidates: rjMapping, winner: null }) }], 'Rejudge')
    return { mode: 'rejudge', n: rjN, mapping: rjMapping, winner: null, __failed: 'no valid candidates survived the mechanical gate', rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades }
  }
  const rjReview = await judge('code reviewer', rjBlind, false, `${reviewDir}/_pool.md`, RANK_SCHEMA, 'Rejudge', 'rejudge-review', LENSES, 'final')
  await persist([
    ...(rjReview && !rjReview.__failed ? [
      ...verdictEntries(reviewDir, rjReview, 'rejudge-review'),
      { path: `${reviewDir}/verdict.md`, content: verdictToMd(rjReview, 'Rejudge verdict'), derive: { mode: 'verdict-md', from: `${reviewDir}/verdict.json`, title: 'Rejudge verdict' } },
    ] : []),
    ...(rjReview && rjReview.council ? [{ path: `${reviewDir}/council.json`, content: json(rjReview.council), derive: { mode: 'council-json', from: `${reviewDir}/verdict.json` } }] : []),
  ], 'Rejudge')
  const rjGate = implGatePassed({ review: rjReview, blind: rjBlind })
  const rjWinnerEntry = rjGate.pass ? rjMapping.find(m => m.candidate === rjGate.winner) : null
  const rjPick = !rjGate.pass && rjReview && rjReview.needs_orchestrator_pick ? rjReview.needs_orchestrator_pick : null
  await persist([{ path: `${runDir}/mapping.json`, content: json({ mode: 'rejudge', n: rjN, rc_summary: rcSummaryLive(), ...(dynamicMBucket ? { taskBucket: dynamicMBucket } : {}), candidates: rjMapping, winner: rjGate.winner, ...(rjWinnerEntry ? { winnerSource: rjWinnerEntry.source, winnerModel: rjWinnerEntry.model } : {}), no_consensus: !!(rjReview && rjReview.no_consensus) }) }], 'Rejudge')
  await maybeFileEngineIssues('Rejudge')
  return {
    mode: 'rejudge', n: rjN, mapping: rjMapping,
    winner: rjGate.winner, ...(rjWinnerEntry ? { winnerSource: rjWinnerEntry.source, winnerModel: rjWinnerEntry.model } : {}),
    no_consensus: !!(rjReview && rjReview.no_consensus),
    ...(rjPick ? { needs_orchestrator_pick: rjPick } : {}),
    ranking: (rjReview && rjReview.ranking) || null,
    reasoning: (rjReview && typeof rjReview.reasoning === 'string') ? rjReview.reasoning.slice(0, 2000) : null,
    rc_summary: rcSummaryLive(),
    model_downgrades: modelDowngrades,
  }
}

// ---- Round 1 ----
phase('Round 1')
log(`▶ ${deriveSummary()}`) // issue #38: run-purpose summary as the first narrator line (above the progress tree)
await buildContext() // shared context bundle (no-op unless args.contextFiles given) — built once, before the attempts
const r1Worktrees = attempts.map(a => ({ ...a, ws: repoMode ? worktreePath('round-1', a.label) : scratchPath('round-1', a.label) }))
await buildWorktrees('round-1', r1Worktrees) // repoMode-only no-op otherwise
log(`Round 1: ${attempts.length} attempts (${attempts.map(a => a.displayModel).join(', ')})`)
const r1 = (await parallelQuorum(r1Worktrees, (a) => dispatch(a, a.ws, null, 'Round 1', investigate ? 'investigate' : 'plan'), 'Round 1', {
  timeoutSecsFor: attemptTimeoutSecsFor, seatLabelFor: (a) => a.label,
})).filter(Boolean)
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
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: null, ...(mode === 'two' ? { winner: null } : {}) }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping }) },
  ], 'Review')
  await maybeFileEngineIssues('Review') // failure-heavy abort: file engine-fault classes before returning
  return { mode, n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades, error: 'no valid round-1 deliverables', round1: { mapping: r1mapping } }
}

if (repoMode) await enrichBlindPool(blind1, `${runDir}/review-1`, 'Review')

// G2 evidence-verification pass (investigate runs only — a hard no-op otherwise): AFTER staging
// (and the repoMode enrichment rebuild), BEFORE the composeOnly pool return, so every pooled
// finding carries its `EVIDENCE: n cited, m verified` stamp when the composer reads the pool.
const stagedEv = await evidenceVerificationPass(staged1, `${runDir}/review-1`, 'Review')

// composeOnly (@@FE): the pool is the product. Persist the key + summaries and return the
// staged blind pool for the orchestrating model to review/compose from. No council spend.
if (composeOnly) {
  // Evidence-aware mapping rows (investigate only; identical to r1mapping otherwise, since
  // mergeEvidence attaches nothing when the pass did not run).
  const evMapping = stagedEv.map(c => ({ candidate: c.blind, model: c.displayModel, valid: c.valid,
    ...(c.evidence ? { evidence: { cited: c.evidence.cited, verified: c.evidence.verified } } : {}),
    ...(c.valid ? {} : { failReason: c.failReason }) }))
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode: 'composeOnly', ...(investigate ? { investigate: true } : {}), n: N, rc_summary: rcSummaryLive(), round1: evMapping, winner1: null }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode: 'composeOnly', n: N, unblind: true, r1mapping: evMapping }) },
  ], 'Review')
  await maybeFileEngineIssues('Review')
  return {
    mode: 'composeOnly', ...(investigate ? { investigate: true } : {}), n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades,
    poolPath: `${runDir}/review-1/_pool.md`,
    round1: { mapping: evMapping },
    candidates: stagedEv.filter(c => c.valid).map(c => ({ blind: c.blind, stagedDir: `${runDir}/review-1/${c.blind}`,
      ...(c.evidence ? { evidence: { cited: c.evidence.cited, verified: c.evidence.verified } } : {}) })),
  }
}

// Plan Round 1 review — judged by the PLAN-lens council (feasibility/completeness/risk/
// security-by-design/simplicity), selected by phaseTitle inside judge(). Plans never touch the repo.
const review = await judge('reviewer', blind1, mode === 'two', `${runDir}/review-1/_pool.md`,
  mode === 'two' ? REVIEW_SCHEMA : RANK_SCHEMA, 'Review', 'review', defaultLensesFor('Review'), mode === 'two' ? 'intermediate' : 'final')
if (review.__failed) {
  // P1: review judge failed — land the key + summaries (no verdict exists)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: null, ...(mode === 'two' ? { winner: null } : {}) }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping }) },
  ], 'Review')
  await maybeFileEngineIssues('Review') // failure-heavy abort: file engine-fault classes before returning
  return { mode, n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades, round1: { mapping: r1mapping }, error: `review judge failed: ${review.__failed}` }
}

if (review.no_consensus) {
  // P1b (council): the council ran but could NOT reach a >50% non-vetoed majority. NO_CONSENSUS is
  // terminal — never silently resolved by Borda/meta-judge and never carried into round 2. Persist the
  // full split (per-judge verdicts + vote evolution + veto events) so an interactive run can surface it
  // and a grand loop routes this loop to needs-human + HALT (winner:null in mapping.json is the signal).
  log(`Review: council NO_CONSENSUS — ${review.reasoning}`)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: null, no_consensus: true, ...(mode === 'two' ? { winner: null } : {}) }) },
    ...verdictEntries(`${runDir}/review-1`, review, 'review'),
    { path: `${runDir}/review-1/verdict.md`, content: verdictToMd(review, 'Round-1 review verdict (NO CONSENSUS)'), derive: { mode: 'verdict-md', from: `${runDir}/review-1/verdict.json`, title: 'Round-1 review verdict (NO CONSENSUS)' } },
    { path: `${runDir}/review-1/council.json`, content: json(review.council), derive: { mode: 'council-json', from: `${runDir}/review-1/verdict.json` } },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping, r1review: review }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping, r1review: review }) },
  ], 'Review')
  await maybeFileEngineIssues('Review') // abort path: RC observability must survive a NO_CONSENSUS stop
  return { mode, n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades, round1: { mapping: r1mapping, review }, no_consensus: true, council: review.council, error: `NO_CONSENSUS at review: ${review.reasoning}` }
}

// P2: round-1 review is valid — incremental write BEFORE any round-2 dispatch (crash-survival linchpin)
await persist([
  { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: review.winner }) },
  ...verdictEntries(`${runDir}/review-1`, review, 'review'),
  { path: `${runDir}/review-1/verdict.md`, content: verdictToMd(review, 'Round-1 review verdict'), derive: { mode: 'verdict-md', from: `${runDir}/review-1/verdict.json`, title: 'Round-1 review verdict' } },
  ...(review.council ? [{ path: `${runDir}/review-1/council.json`, content: json(review.council), derive: { mode: 'council-json', from: `${runDir}/review-1/verdict.json` } }] : []),
  ...(review.guidance ? [{ path: `${runDir}/review-1/guidance.md`, content: guidanceToMd(review.guidance), derive: { mode: 'guidance-md', from: `${runDir}/review-1/verdict.json` } }] : []),
], 'Review')

if (mode === 'single') {
  // P3: single-pass — mapping/verdict already written at P2; add the summaries
  const contributions = computeContributions({ mapping: r1mapping, review }, null, null, mode)
  await persist([
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping, r1review: review }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping, r1review: review }) },
    { path: `${runDir}/contributions.json`, content: json({ note: 'ESTIMATE — per-model attribution is a HEURISTIC, not ground truth. See workflows/tournament.mjs (computeContributions) for the exact formula. Forward-improvable.', mode, contributions }) },
  ], 'Review')
  await maybeFileEngineIssues('Review')
  return { mode, n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades, round1: { mapping: r1mapping, review }, contributions }
}

// ---- Two pass ----
// Fast tally (judging-v3): the intermediate review carries up to TWO champions on a split (its
// `carried` array). Legacy single judge / older shapes fall back to the single winner. All-vetoed
// intermediate carries NONE — the final pool is round 2 alone.
const carriedLetters = Array.isArray(review.carried) ? review.carried : (review.winner ? [review.winner] : [])
let champs = carriedLetters.map(l => blind1.find(c => c.blind === l)).filter(Boolean)
if (!champs.length && carriedLetters.length) { log(`carried candidate(s) "${carriedLetters.join(', ')}" not among valid candidates; carrying the first valid (${blind1[0].blind})`); champs = [blind1[0]] } // #8
const champ = champs[0] || null
phase('Round 2')
log(`Round 2: ${attempts.length} guided attempts; carrying over ${champs.length} round-1 champion(s)${champs.length ? ` (${champs.map(c => c.displayModel).join(', ')})` : ' — none (all vetoed)'}`)
const r2Worktrees = attempts.map(a => ({ ...a, ws: repoMode ? worktreePath('round-2', a.label) : scratchPath('round-2', a.label) }))
await buildWorktrees('round-2', r2Worktrees) // repoMode-only no-op otherwise
// Run F fold-in: never seed round-2 briefs with stub/placeholder guidance — fall back to task-only
// (null guidance is the round-1 dispatch shape, a first-class path).
let r2Guidance = review.guidance
{ const stub = guidanceStub(r2Guidance)
  if (stub) { log(`JE-GUIDANCE-STUB [Round 2]: ${stub} — falling back to TASK-ONLY round 2 (no priors block seeds a brief).`); r2Guidance = null } }
const r2 = (await parallelQuorum(r2Worktrees, (a) => dispatch(a, a.ws, r2Guidance, 'Round 2'), 'Round 2', {
  timeoutSecsFor: attemptTimeoutSecsFor, seatLabelFor: (a) => a.label,
})).filter(Boolean)
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
  ...champs.map(ch => ({ ws: ch.ws, displayModel: ch.displayModel, dispatch: ch.dispatch, round: 1, carriedOver: true, enrichmentSource: `${ch.ws}/enrichment.txt` })),
]
phase('Final rank')
const stagedF = await stageAndValidate(blindLabel(finalPool, 2), `${runDir}/review-final`, 'Final rank')
const blindF = stagedF.filter(c => c.valid)
const finalMapping = stagedF.map(c => ({ candidate: c.blind, model: c.displayModel, round: c.round, valid: c.valid, ...(c.valid ? {} : { failReason: c.failReason }) }))
const carriedEntries = finalMapping.filter(e => e.round === 1)
const carriedOverWinner = carriedEntries.length ? carriedEntries[0].candidate : null // legacy field (first champion)
const carriedOverAll = carriedEntries.map(e => e.candidate)
if (!blindF.length) {
  // P4: no valid finalists — full key (round1 + final, winner null) + summaries
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: review.winner, final: finalMapping, winner: null, winnerRound: null, carriedOverWinner, carriedOver: carriedOverAll }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping }) },
  ], 'Final rank')
  return { mode, n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades, round1: { mapping: r1mapping }, guidance: review.guidance, final: { mapping: finalMapping, error: 'no valid finalists' } } // #5
}

if (repoMode) await enrichBlindPool(blindF, `${runDir}/review-final`, 'Final rank')

// Plan Final rank — the winning PLAN, judged by the same PLAN-lens council (by phaseTitle).
const finalRank = await judge('final ranker', blindF, false, `${runDir}/review-final/_pool.md`, RANK_SCHEMA, 'Final rank', 'final-rank')
if (finalRank.__failed) {
  // P5: final-rank judge failed — same payload as P4 (no finalRank to render)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: review.winner, final: finalMapping, winner: null, winnerRound: null, carriedOverWinner, carriedOver: carriedOverAll }) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping }) },
  ], 'Final rank')
  await maybeFileEngineIssues('Final rank') // failure-heavy abort: file engine-fault classes before returning
  return { mode, n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades, round1: { mapping: r1mapping }, guidance: review.guidance, final: { mapping: finalMapping, error: `final-rank judge failed: ${finalRank.__failed}` } }
}

if (finalRank.no_consensus) {
  // P5b (council): the final-rank council could not reach a >50% non-vetoed majority. Terminal — winner
  // stays null (never synthesised). Persist the split; a grand loop reads winner:null / no_consensus:true
  // and routes to needs-human + HALT (see SKILL Phase 7 / 7-FALLBACK).
  log(`Final rank: council NO_CONSENSUS — ${finalRank.reasoning}`)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: review.winner, final: finalMapping, winner: null, winnerRound: null, carriedOverWinner, carriedOver: carriedOverAll, no_consensus: true }) },
    ...verdictEntries(`${runDir}/review-final`, finalRank, 'final-rank'),
    { path: `${runDir}/review-final/verdict.md`, content: verdictToMd(finalRank, 'Final rank verdict (NO CONSENSUS)'), derive: { mode: 'verdict-md', from: `${runDir}/review-final/verdict.json`, title: 'Final rank verdict (NO CONSENSUS)' } },
    { path: `${runDir}/review-final/council.json`, content: json(finalRank.council), derive: { mode: 'council-json', from: `${runDir}/review-final/verdict.json` } },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping, finalRank }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping, finalRank }) },
  ], 'Final rank')
  await maybeFileEngineIssues('Final rank') // abort path: RC observability must survive a NO_CONSENSUS stop
  return { mode, n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades, round1: { mapping: r1mapping }, guidance: review.guidance, final: { mapping: finalMapping, rank: finalRank }, no_consensus: true, council: finalRank.council, error: `NO_CONSENSUS at final rank: ${finalRank.reasoning}` }
}

if (finalRank.needs_orchestrator_pick) {
  // Judging-v3: the steelman loop exhausted its 5 rounds still tied. NOT a NO_CONSENSUS — both
  // finalists are gated and security-cleared; the ORCHESTRATOR (interactive SKILL / grand-loop
  // driver) casts the deciding vote. Persist everything and surface the pick payload.
  log(`Final rank: steelman loop tied after 5 rounds — needs_orchestrator_pick [${finalRank.needs_orchestrator_pick.finalists.join(', ')}]`)
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: review.winner, final: finalMapping, winner: null, winnerRound: null, carriedOverWinner, carriedOver: carriedOverAll, needs_orchestrator_pick: finalRank.needs_orchestrator_pick.finalists }) },
    ...verdictEntries(`${runDir}/review-final`, finalRank, 'final-rank'),
    { path: `${runDir}/review-final/verdict.md`, content: verdictToMd(finalRank, 'Final rank verdict (ORCHESTRATOR PICK NEEDED)'), derive: { mode: 'verdict-md', from: `${runDir}/review-final/verdict.json`, title: 'Final rank verdict (ORCHESTRATOR PICK NEEDED)' } },
    { path: `${runDir}/review-final/council.json`, content: json(finalRank.council) },
    { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping, finalRank }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping, finalRank }) },
  ], 'Final rank')
  await maybeFileEngineIssues('Final rank')
  return { mode, n: N, rc_summary: rcSummaryLive(), model_downgrades: modelDowngrades, round1: { mapping: r1mapping }, guidance: review.guidance, final: { mapping: finalMapping, rank: finalRank }, needs_orchestrator_pick: finalRank.needs_orchestrator_pick }
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
  { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), round1: r1mapping, winner1: review.winner, final: finalMapping, winner: finalRank.winner, winnerRound: winnerEntry ? winnerEntry.round : null, carriedOverWinner, carriedOver: carriedOverAll }) },
  ...verdictEntries(`${runDir}/review-final`, finalRank, 'final-rank'),
  { path: `${runDir}/review-final/verdict.md`, content: verdictToMd(finalRank, 'Final rank verdict'), derive: { mode: 'verdict-md', from: `${runDir}/review-final/verdict.json`, title: 'Final rank verdict' } },
  ...(finalRank.council ? [{ path: `${runDir}/review-final/council.json`, content: json(finalRank.council), derive: { mode: 'council-json', from: `${runDir}/review-final/verdict.json` } }] : []),
  { path: `${runDir}/SUMMARY.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: true, r1mapping, r1review: review, finalMapping, finalRank, winnerRound: winnerEntry ? winnerEntry.round : null }) },
  { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ rcSummary: rcSummaryLive(), task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping, finalRank, winnerRound: winnerEntry ? winnerEntry.round : null }) },
  { path: `${runDir}/contributions.json`, content: json({ note: 'ESTIMATE — per-model attribution is a HEURISTIC, not ground truth. See workflows/tournament.mjs (computeContributions) for the exact formula. Forward-improvable.', mode, winner: finalRank.winner, winnerRound: winnerEntry ? winnerEntry.round : null, contributions }) },
], 'Final rank')

// Auto-file engine-fault issues AFTER durable persistence, so a filing hang can never lose artifacts.
await maybeFileEngineIssues('Final rank')

// ===== IMPLEMENT PHASE hook — only with args.implement. =====================================
// Reached only on a RESOLVED winning plan: a plan-phase NO_CONSENSUS / __failed / no-valid-pool
// already returned above, BEFORE any implement spend (the design's hard invariant). The winning
// plan is bundled verbatim and drives Implement Round 3 (+ Round 4 only on a failed R3 gate).
if (implement) {
  const planWinner = blindF.find(c => c.blind === finalRank.winner) || champ || blindF[0]
  const seedPlanPath = `${runDir}/_winning-plan/plan.md`
  await bundlePlan(planWinner.ws, seedPlanPath)
  // Dynamic M (issue #36): OPT-IN spend optimization — decided BEFORE the A/B-brief assignment so the
  // reduce-only prefix trim shrinks the BASE pool and the A/B split re-alternates the TRIMMED pool
  // below (a prefix slice of an already-alternated pool would unbalance brief-1/brief-2).
  // Reduce-only + fail-open: on high same-task convergence in the ledger, seat one fewer implementer
  // (never below the floor). Any missing input / read failure / thin evidence leaves the count as-is.
  // Safe by construction: dedup already dissolves the duplicate-deadlock before judging, so a wrong
  // or stale read can only ever spend slightly less — it can never recreate the deadlock #36 targets.
  if (DYNAMIC_M_ON) {
    const ev = await readConvergenceEvidence(dynamicMBucket)
    const trimmed = trimSeatsForConvergence(implementSeats, ev)
    if (trimmed.length < implementSeats.length) {
      log(`JE-DYNAMIC-M: same-task convergence high (samples=${ev.samples}, ratio=${ev.convergenceRatio}) — trimming implementers ${implementSeats.length} → ${trimmed.length} (reduce-only; floor ${DYNAMIC_M.M_FLOOR}).`)
      implementSeats = trimmed
    } else {
      log(`JE-DYNAMIC-M: no trim (dynamicM on; evidence ${ev ? `samples=${ev.samples} ratio=${ev.convergenceRatio}` : 'unavailable'} — seats unchanged at ${implementSeats.length}).`)
    }
  }
  // A/B briefs: seed the implementer pool alternately with the winner's AND the runner-up finalist's
  // briefs. The runner-up comes from the steelman's seeded finalists (top-2 NON-VETOED by
  // construction — a vetoed candidate can never be a finalist), so a vetoed brief can never seed an
  // implementer. Judges stay blind to lineage; the readout is derived from mapping afterwards.
  let abInfo = null
  if (AB_BRIEFS) {
    // The steelman metadata's field for the top-2 non-vetoed finalists is `seeds` (observed live:
    // the run-h calibration resolved A vs G with steelman.seeds=['A','G'], while `finalists` exists
    // ONLY inside a needs_orchestrator_pick payload — reading it here silently disabled A/B on
    // every majority-resolved run). Keep `finalists` as a fallback for the pick-payload shape.
    const sm = finalRank.council && finalRank.council.steelman
    const fin = (sm && Array.isArray(sm.seeds) && sm.seeds.length) ? sm.seeds
      : (sm && Array.isArray(sm.finalists)) ? sm.finalists : []
    const ruLetter = fin.find(l => l !== finalRank.winner) || null
    const ru = ruLetter ? blindF.find(c => c.blind === ruLetter) : null
    if (ru) {
      const brief2Path = `${runDir}/_winning-plan/brief-2.md`
      await bundlePlan(ru.ws, brief2Path)
      // Re-alternate the (possibly trimmed) pool so the A/B split stays balanced — never slice a
      // prefix of an already-alternated pool (issue #36: trim precedes this assignment).
      implementSeats = assignAbSeeds(implementSeats, [seedPlanPath, brief2Path])
      abInfo = { 'brief-1': finalRank.winner, 'brief-2': ruLetter }
      log(`A/B BRIEFS: implementers split alternately across brief-1 (final-rank ${finalRank.winner}) and brief-2 (final-rank ${ruLetter}). Judges are blind to lineage — the A/B readout is derived from mapping, never from votes.`)
    } else {
      log('A/B BRIEFS requested but the final rank has no second non-vetoed finalist — all implementers seed from the single winning brief.')
    }
  }
  const impl = await implementPhase(seedPlanPath)
  await persist([
    { path: `${runDir}/implement.json`, content: json({ winningPlan: finalRank.winner, ...(abInfo ? { ab: abInfo } : {}), ...impl }) },
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, rc_summary: rcSummaryLive(), implement: true, ...(dynamicMBucket ? { taskBucket: dynamicMBucket } : {}), round1: r1mapping, winner1: review.winner, final: finalMapping, planWinner: finalRank.winner, implementRounds: impl.rounds, implementWinner: impl.winner, implementWinnerRound: impl.winnerRound, needs_human: impl.needs_human, carriedOverWinner }) },
  ], impl.rounds === 4 ? 'Implement Round 4' : 'Implement Round 3')
  await maybeFileEngineIssues(impl.rounds === 4 ? 'Implement Round 4' : 'Implement Round 3')
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
    rc_summary: rcSummaryLive(),
    model_downgrades: modelDowngrades,
  }
}

return {
  mode, n: N,
  round1: { mapping: r1mapping, review },
  guidance: review.guidance,
  final: { mapping: finalMapping, rank: finalRank, ...(winnerEntry ? { winnerRound: winnerEntry.round } : {}) },
  contributions,
  rc_summary: rcSummaryLive(),
  model_downgrades: modelDowngrades,
}
