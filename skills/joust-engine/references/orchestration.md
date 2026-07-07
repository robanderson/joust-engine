# Orchestration reference

How to dispatch the attempts and the Opus passes. Read this in Phase 2 (both modes), and in Phase 4 and Phase 5 (two pass only).

**Mode note.** Single pass uses only the first round (`round-1/`) and one Opus pass (the Phase 3 reviewer); it has no `round-2/`, no carried-over `winner/`, and no `final-rank/`. Two pass uses everything below. Where this file says "both rounds", single pass simply runs the first round and stops after the Phase 3 review.

## Model identifiers

The Phase 1 selection maps to these. There are two families with two different dispatch paths.

**Anthropic models** — dispatched via the Task tool. The sub-agent's `model` field accepts the short alias; the full API string is given for harnesses that need it.

| Choice  | Alias    | API model string     | Role                        |
|---------|----------|----------------------|-----------------------------|
| Opus    | `opus`   | `claude-opus-4-8`    | attempt, review, or rank    |
| Sonnet  | `sonnet` | `claude-sonnet-5`    | attempt                     |
| Haiku   | `haiku`  | `claude-haiku-4-5`   | attempt                     |

**GLM models (z.ai)** — dispatched by shelling out to the `glm` CLI (see "Dispatching GLM attempts" below). `glm` is the `claude` CLI pointed at z.ai's Anthropic-compatible endpoint; it is selected through `glm`'s `--model` flag, which is **not** the same as a GLM model name. Use this exact mapping:

| GLM model     | `glm` flag         | Notes                          |
|---------------|--------------------|--------------------------------|
| `glm-5.2`     | `--model opus`     | strongest, 1M context          |
| `glm-5.1`     | `--model glm-5.1`  | passed through directly        |
| `glm-4.7`     | `--model sonnet`   |                                |
| `glm-4.5-air` | `--model haiku`    | fastest, cheapest              |

The `--model opus/sonnet/haiku` aliases resolve to GLM models only because the `glm` wrapper sets `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` to the GLM strings; they are GLM models, not Anthropic ones. The wrapper requires `ZAI_API_KEY` to be set in the environment (it is sourced from the user's shell profile).

**Local models (on-device MLX via the `omlx` server)** — dispatched by shelling out to `claude` pointed at the local `omlx` server (`http://127.0.0.1:8000`). Unlike GLM's fixed five, the local catalogue is **dynamic** — fetch it at gate time with `omlx-models` (or `curl -s http://127.0.0.1:8000/v1/models -H "Authorization: Bearer $OMLX_AUTH_TOKEN" | jq -r '.data[].id'`). Local model ids are passed straight through: `--model <exact-id>` (e.g. `--model gemma-4-26b-a4b-it-8bit`, `--model mlx-community--Qwen3.6-35B-A3B-8bit`) — no alias table. Because the list is dynamic, **one generic worker agent (`joust-local`) handles every local model**; the exact id rides in the command. The runner reads `OMLX_AUTH_TOKEN` from the environment (exported in `~/.zshrc`, inherited into the session at launch — the same uniform key handling every runner uses). Local models are **free** (on-device) but slower than the hosted providers.

**Codex models (OpenAI, via the `codex exec` CLI)** — dispatched by shelling out to `codex exec` (the non-interactive mode) through `bin/codex-run.sh`. Codex is **pinned to `gpt-5.5`** — the only model the local ChatGPT-account auth (`~/.codex/auth.json`) serves; the `gpt-5.1`/`gpt-5`/`*-codex` ids all return HTTP 400 "not supported when using Codex with a ChatGPT account" unless an `OPENAI_API_KEY` (API-key billing) is set. So the selectable axis is **reasoning effort**, not model — codex's real quality lever, set via the `model_reasoning_effort` config override. Verified-accepted tokens on gpt-5.5: **`low` | `medium` | `high` | `xhigh`** (`xhigh` is the UI's "Extra high"; `minimal` is rejected). The display models are `codex-low` / `codex-medium` / `codex-high` / `codex-xhigh`, mapped to flags by `CODEX_FLAG` in `tournament.mjs` (`-m gpt-5.5 -c model_reasoning_effort=<tok>`); the runner pins `-m` so it never falls back to config.toml's possibly-unserveable default. Like local, **one generic worker agent (`joust-codex`) handles every effort level**; the effort rides in the command. Auth comes from `~/.codex/auth.json` — no env var to pre-check. Codex is an **autonomous agent with no turn cap** (`codex exec` has no `--max-turns`), so its only per-attempt backstop is the wall-clock timeout (`codexTimeoutSecs`, default 600); it bills the user's OpenAI/ChatGPT plan, not Anthropic.

**MiniMax models (the MiniMax M-series, via `claude` pointed at the MiniMax Anthropic-compatible endpoint)** — dispatched by shelling out to `claude` through `bin/minimax-run.sh`. MiniMax exposes a single model, **MiniMax-M3** (512K context); all opus/sonnet/haiku aliases map to it, so there is **no `--model` flag** — the runner pins it with `ANTHROPIC_MODEL=MiniMax-M3`. It reads its API key from the **environment** (`MINIMAX_API_KEY`), exactly as `glm-run.sh` reads `ZAI_API_KEY`: the key is exported in the user's `~/.zshrc` (alongside `ZAI_API_KEY`/`OMLX_AUTH_TOKEN`) and inherited into the session at launch. **Every provider runner resolves its key the same way — from the env, never by sourcing or grepping rc files — so the runners stay uniform and maintainable.** One generic worker agent (`joust-minimax`) handles it; the provenance marker is `JOUST-MINIMAX-PROVENANCE endpoint=api.minimax.io` in `_minimax_run.log`. MiniMax bills the user's MiniMax plan. M3 is fast on lighter tasks; for heavy multi-file builds give it a generous `attemptTimeoutSecs`.

**Grok models (xAI, via the `grok` headless CLI)** — dispatched by shelling out to `grok -p` through `bin/grok-run.sh`. TWO variants on a **`-m` model axis**: `grok-build` (xAI's own agentic-coding model; `grok-code-fast-1` is an alias; 256K context) and `grok-composer-2.5-fast` (Cursor Composer 2.5, Kimi K2.5 lineage; the CLI default). The `displayModel` **is** the dispatch key: `GROK_FLAG[displayModel]` → `-m <id>`. Auth is the operator's grok.com **OAuth session** (`~/.grok/auth.json`, `auth_mode=oidc`); `XAI_API_KEY` (prefix `xai-`) is the headless/CI fallback — the runner injects **neither** and requires **neither** (grok resolves its own credential, exactly like codex reads `~/.codex/auth.json`, so — unlike glm/minimax — it does NOT hard-fail on a missing env key). Default inference flows over `cli-chat-proxy.grok.com` (NOT `api.x.ai`). **One generic worker agent (`joust-grok`) handles both variants**; the provenance marker is `JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com` in `_grok_run.log`. Unlike codex, grok **HAS `--max-turns`**, so it uses **both** per-attempt guards (`grokMaxTurns`, default 30, via `JE_MAX_TURNS`; `grokTimeoutSecs`, default 600, via `JE_TIMEOUT_SECS`) through the standard `runnerCmd`. Grok bills the operator's SuperGrok / X Premium+ plan.

The Phase 3 reviewer (single pass and two pass) and the final ranker (Phase 5, two pass only) are **always Anthropic Opus**, dispatched via the Task tool — never GLM. By default each is a **blind 6-seat council that votes once and never deliberates (judging-v3)** (see "Dispatching the Opus passes" below); `judges: 1` selects the legacy single blind Opus judge. Holding the judge model fixed on Opus keeps scoring consistent across attempts and across rounds.

## Dynamic-workflow dispatch (preferred backend)

The bundled workflow `workflows/tournament.mjs` (plugin root) runs the whole tournament — parallel attempts, blind Opus review, and (two pass) the guided round and final rank — as one resumable, `/workflows`-monitored run. Invoke it from the skill's Phase 2 once the interactive gates are done:

```
Workflow({ scriptPath: "<plugin-root>/workflows/tournament.mjs", args: <ARGS> })
```

**ARGS shape** (the skill builds this from the model gate + diversity draw):

```
{
  task: "<exact task text>",
  mode: "single" | "two",
  runDir: "<absolute run dir>",          // e.g. <plugin>/.runs/<run-id>
  workspaceRoot: "<absolute base dir>",  // optional: base dir for SELF-CONTAINED candidate
                                          // workspaces (repoMode:false). Default (omit) =
                                          // /tmp/je-workspaces/<run-id> — deliberately OUTSIDE
                                          // the plugin cache / ~/.claude/, which nested
                                          // claude-CLI runners (glm/minimax/codex/grok) treat
                                          // as sensitive and refuse to write under (issue #34).
                                          // Pass workspaceRoot: runDir to reproduce the
                                          // pre-fix layout verbatim. Mirrors repoMode's
                                          // worktreeRoot (issue #44); staging/review dirs,
                                          // _engine-logs, the context bundle, and every
                                          // persisted artifact stay under runDir either way.
  contextFiles: ["<path>", ...],         // optional: known input files all workers need (see below)
  glmRunner: "<plugin-root>/bin/glm-run.sh",      // REQUIRED if any attempt is GLM
  localRunner: "<plugin-root>/bin/local-run.sh",  // REQUIRED if any attempt is Local
  codexRunner: "<plugin-root>/bin/codex-run.sh",  // REQUIRED if any attempt is Codex — AND now also
                                          // used by the judging council's codex-xhigh seats (spec/craft,
                                          // completeness/simplicity) by default; pass it even if no
                                          // attempt is Codex, or those seats silently run native Opus
                                          // (logged once) instead of mixed-family judging.
  minimaxRunner: "<plugin-root>/bin/minimax-run.sh", // REQUIRED if any attempt is MiniMax
  grokRunner: "<plugin-root>/bin/grok-run.sh",    // REQUIRED if any attempt is Grok
  // Per-attempt guards — SET FROM THE TASK-SIZE PROFILE (SKILL Phase 1c). Resolve the whole set with
  // `node <plugin-root>/bin/je-parse.mjs --size <short|medium|long>` and pass every field through; the
  // engine still has its own fallbacks (shown below) if a field is omitted, but always pass an explicit
  // profile so the limits match the task. (short tightens, medium ≈ historical defaults, long loosens.)
  attemptMaxTurns: 30,                    // GLM iteration cap; engine fallback 30
  localMaxTurns: 20,                      // LOCAL iteration cap; engine fallback 20
  minimaxMaxTurns: 30,                    // MiniMax iteration cap; engine fallback = attemptMaxTurns
  grokMaxTurns: 30,                       // Grok iteration cap; engine fallback = attemptMaxTurns (grok has BOTH guards)
  attemptTimeoutSecs: 300,               // wall-clock backstop (local/base); engine fallback 300
  glmTimeoutSecs: 2400,                  // GLM-only wall-clock (GLM is slow on heavy code); engine fallback = attemptTimeoutSecs
  minimaxTimeoutSecs: 900,               // MiniMax-only wall-clock (M3 is slow on real code — issue #30); engine fallback = attemptTimeoutSecs
  codexTimeoutSecs: 600,                 // wall-clock backstop for Codex; engine fallback 600 (codex has no turn cap)
  grokTimeoutSecs: 600,                  // wall-clock backstop for Grok; engine fallback 600 (grok ALSO honours grokMaxTurns)
  grokWebSearch: false,                  // optional — true enables grok web search (default false = hermetic, like the other providers)
  judges: 5,                             // optional — judging council size. DEFAULT (omit) = the blind 6-seat
                                         // judging-v3 council (5 lenses + security-x; votes once, never deliberates)
                                         // at both decision points. Set `1` for the LEGACY single blind Opus judge
                                         // (byte-for-byte the pre-council behaviour). Any value other than 1 selects
                                         // the council (size fixed at 6, or 5 with dualSecurity: false — not tunable).
  judgeMix: 'anthropic',                 // optional — forces every council seat to native Opus,
                                         // byte-identical to pre-mixed-family behaviour. DEFAULT (omit)
                                         // = the mixed assignment (codex-xhigh on the completeness-class
                                         // /simplicity-class seats: spec+craft for code, completeness+
                                         // simplicity for plan). Ignored when judges:1.
  codexJudgeTimeoutSecs: 1500,           // optional — wall-clock for a codex-xhigh JUDGE seat (separate
                                         // from codexTimeoutSecs, the ATTEMPT wall-clock); engine
                                         // fallback 1500 (judging reads a whole blind pool + reasons at
                                         // xhigh effort, so it gets more headroom than an attempt).
  issueRunner: "<plugin-root>/bin/je-issue.sh", // optional but recommended — enables auto-filing of
                                         // engine-fault RC classes (01/02 after retries, 04–09) as ONE
                                         // deduped, privacy-scrubbed `dogfood` issue per class per run.
                                         // Absent => auto-filing is skipped (logged once). Fire-and-forget:
                                         // a filing failure never blocks or crashes the run.
  engineRepo: "robanderson/joust-engine", // optional — owner/repo the auto-issues are pinned to (GH_REPO);
                                         // default = the public canonical engine repo.
  noAutoIssue: false,                    // optional — set true to disable auto-filing entirely (RCs are
                                         // still derived, recorded, and reported; only the GitHub filing is off).
  // STRUCTURAL PERSIST (#33): passing ANY runner path also enables on-disk artifact derivation —
  // persist() writes each JSON once (single quoted heredoc, engine-side SHA-256 verified, retried on
  // mismatch) and derives verdict.md / council.json / guidance.md ON DISK via bin/je-render.mjs, so
  // report bytes never transit a model. A run with no runner paths degrades to typed+verified writes.
  attempts: [                            // one per attempt, length N
    { label: "candidate-1",
      dispatch: "anthropic",             // native, runs in-process
      model: "haiku",                    // opus | sonnet | haiku
      displayModel: "haiku",             // for the report; NOT shown to judges
      r1nudge: "<Pool A nudge>", r2nudge: "<fresh Pool A nudge>" },
                                         // design-brief rounds: carry a Pool A2 angle-brief PARAGRAPH
                                         // verbatim in these same fields (see diversity-injection.md).
    { label: "candidate-2",
      dispatch: "glm",                              // runs via a wrapper agent + the runner script
      agentType: "joust-engine:joust-glm-5-2",  // namespaced bundled GLM worker agent
      displayModel: "glm-5.2",
      r1nudge: "...", r2nudge: "..." },
    { label: "candidate-3",
      dispatch: "local",                            // runs via the generic local agent + runner
      agentType: "joust-engine:joust-local",    // namespaced single local worker agent
      model: "gemma-4-26b-a4b-it-8bit",  // exact omlx model id -> `--model <id>`
      displayModel: "gemma-4-26b-a4b-it-8bit",
      r1nudge: "...", r2nudge: "..." },
    { label: "candidate-4",
      dispatch: "codex",                            // runs via the generic codex agent + runner
      agentType: "joust-engine:joust-codex",    // namespaced single codex worker agent
      model: "gpt-5.5",                  // codex is pinned to gpt-5.5 (fallback if displayModel not in CODEX_FLAG)
      displayModel: "codex-high",        // codex-low|medium|high|xhigh -> CODEX_FLAG (-m gpt-5.5 -c model_reasoning_effort=<tok>)
      r1nudge: "...", r2nudge: "..." },
    { label: "candidate-5",
      dispatch: "minimax",                          // runs via the generic minimax agent + runner
      agentType: "joust-engine:joust-minimax",  // namespaced single minimax worker agent
      displayModel: "minimax-m3",        // the only MiniMax model; no --model flag (ANTHROPIC_MODEL pins MiniMax-M3)
      r1nudge: "...", r2nudge: "..." }
    // ...
  ]
}
```

**Plan/Implement args (2026-07-03 round split).** The tournament is a **Plan phase** (Plan Round 1 + Plan Round 2, always — attempts produce **design briefs**, cheap to produce/judge) plus an optional **Implement phase** (Implement Round 3, plus Round 4 only if R3 yields no gate-passing candidate). `attempts` seat the plan rounds; two extra args seat the implement rounds:

```
  implement: true,                        // optional (default false). Enables Implement Round 3 (+ 4).
                                          // The parser sets it from the `implement` keyword or a
                                          // non-empty `Implement:` phase spec.
  implementAttempts: [ ... ],             // optional: the implement-phase pool (SAME per-attempt shape
                                          // as `attempts`; a small strong pool). Defaults to `attempts`
                                          // when omitted. From je-parse's `implementAssignment`.
  abBriefs: true,                         // optional (default false). A/B briefs: when the final rank
                                          // leaves a second non-vetoed steelman finalist, implementers
                                          // seed ALTERNATELY from the top-2 finalists' briefs. Judges
                                          // stay blind to lineage; the readout is derived from mapping
                                          // (`seedBrief` per implementer; `implement.json` gains
                                          // `ab: {brief-1, brief-2}`), never from votes.
```

- When `implement` is true the engine forces the plan phase to the **two-pass spine** (Round 2 always) so the winning design brief is refined before any expensive implementation, then bundles the winning brief verbatim into `${runDir}/_winning-plan/plan.md` and hands it to each implementer as an **approach + acceptance-criteria contract** (the deliberate seed exception; implementation details belong to the implementers).
- **Default pools** (`bin/je-parse.mjs`): plan `PLAN_DEFAULT_POOL` = `2 opus, 2 sonnet, 2 codex-high, 2 glm-5.2, 2 minimax` (N=10); implement `IMPLEMENT_DEFAULT_POOL` = `2 opus, 2 sonnet, 1 codex-high, 1 glm-5.2` (M=6). A phase-scoped spec (`Plan: … , Implement: …`) overrides the relevant pool.
- **Judging:** plan rounds use the **plan-lens** council (feasibility/completeness/risk/security-by-design/simplicity); implement rounds use the **code-lens** council. Same engine, selected per judging point (see `references/review-rubric.md`). A **plan NO_CONSENSUS returns before any implement spend** (`no_consensus:true`, `winner:null` in `mapping.json`), and a plan-final steelman tie returns `needs_orchestrator_pick` the same way. The implement result is persisted to `${runDir}/implement.json` (`rounds`, `winner`, `winnerRound`, `needs_human`, `needs_orchestrator_pick?`).

**Investigate args (INVESTIGATE→COMPOSITE v1, spec 2026-07-06).** `investigate: true` (default false; ignored when `implement` is set) switches Round 1 attempts to the `investigate` brief kind — each seat returns a short **FINDINGS.md** (diagnosis + VERIFIABLE evidence citations — file:line / artifact paths / log excerpts — + a candidate improvement sketch; altitude-guarded: findings only, never fixes; same single-pass + save contract + hard stop as the other kinds) — and IMPLIES `composeOnly` semantics: the engine stages/validates the pool, runs a G2 **evidence-verification pass** (one deterministic HELPER_MODEL shell step, mechanical-gate shape: extracts each valid candidate's cited paths with the pure-block citation grammar and grep-checks them against the snapshot/context — working tree, pinned `baseRef` via `git cat-file`, or the `contextFiles` bundle — then stamps a `--- Evidence check --- / EVIDENCE: n cited, m verified` block into `_pool.md`; fail-safe: an unverifiable citation is stamped-but-unverified, a dead helper degrades to unstamped, nothing is ever invalidated), and returns `{ poolPath, round1.mapping (rows gain evidence: {cited, verified}), candidates[], investigate: true, rc_summary }` for the orchestrating composer — no councils, no round 2 (see the fable-engine skill's "Investigate mode" for the compose/union discipline). Issue-intake is SKILL-side, not an engine arg: for a `fix #NNN` task the orchestrator runs `gh issue view NNN` and installs the issue title+body verbatim as `task` (the original request/constitution), passing the files the issue names as `contextFiles`.

**Model → agentType map** for GLM attempts. Agent types register under the **plugin namespace**, so use the `joust-engine:` prefix (the workflow also auto-prefixes a bare name, but pass the namespaced form):

| GLM model | agentType |
|-----------|-----------|
| glm-5.2 | `joust-engine:joust-glm-5-2` |
| glm-5.1 | `joust-engine:joust-glm-5-1` |
| glm-4.7 | `joust-engine:joust-glm-4-7` |
| glm-4.5-air | `joust-engine:joust-glm-4-5-air` |

(Local, Codex, MiniMax, and Grok attempts each use one generic agent — `joust-engine:joust-local` / `joust-engine:joust-codex` / `joust-engine:joust-minimax` / `joust-engine:joust-grok` — for every model/effort/variant.)

**Shared context bundle (`contextFiles`).** When the task has **known input files every worker needs** (e.g. "evaluate these skill files", "summarise this corpus", "audit these files"), pass their paths as `contextFiles`. The engine concatenates them ONCE — a single cheap `haiku` agent runs a `cat` — into `${runDir}/_context/_context.md`, and adds a line to every attempt's brief: *"shared context is at `<path>` — read that one file; don't re-read the underlying files."* This kills the dominant cost we measured: without it, every attempt independently re-reads the same files (a 4-attempt × 2-round run racked up ~86 Read calls, almost all duplicated). The bundle lives **outside** any candidate workspace, so staging (which only copies from candidate workspaces) never exposes it to the blind judge. Pass **exact file paths** (not shell globs — the paths are shell-quoted, so a `*` is taken literally). Use it only for **known** inputs (facts everyone needs anyway — no diversity cost); it is NOT a research "scout" (discovering unknown inputs is a separate, optional concern with real diversity/bias tradeoffs).

Anthropic attempts pass `dispatch:"anthropic"` + `model`; the workflow spawns them natively. GLM attempts pass `dispatch:"glm"` + `agentType` (per the map above) + `displayModel`. **Local attempts** pass `dispatch:"local"` + `agentType:"joust-local"` + `model` (the exact omlx id, also used as `displayModel`). **Codex attempts** pass `dispatch:"codex"` + `agentType:"joust-codex"` + `displayModel` (`codex-low|medium|high|xhigh` → `CODEX_FLAG`) + `model:"gpt-5.5"` (the fallback). The workflow blind-labels candidates, the Opus reviewer/ranker **reads and runs each candidate's files** from its workspace (judges never receive model identities), and the script returns `{ round1.mapping, round1.review, guidance?, final.mapping, final.rank, final.winnerRound }` — everything Phase 6 needs to unblind and report.

**Why GLM dispatch is shaped this way (learned the hard way):** a subagent inherits the session's Anthropic provider, so `model: glm-5.2` fails (verified: the Anthropic endpoint returns "model … may not exist"). GLM therefore needs a separate `claude`→z.ai process. The workflow can only run bash through a sub-agent, and an LLM wrapper handed a **raw** `claude -p … --model glm-5 …` command proved unreliable in smoke testing: it variously (a) solved the task itself with its own Anthropic model, (b) **refused** on safety grounds ("nested autonomous Claude … external provider … unsafe"), or (c) let the weak inner model bail without saving a file. Fix, in three parts:

1. **Runner script (`bin/glm-run.sh`).** The real z.ai call lives in a bundled script. The workflow builds a *benign* command — `mkdir … && printf <brief> > _brief.txt && bash <glmRunner> <flag>` — so the wrapper agent only ever sees "run a project script," nothing to refuse or shortcut. The script sets the z.ai env, runs `claude -p "$(cat _brief.txt)" <flag> --permission-mode acceptEdits --allowedTools …`, and writes a `JOUST-GLM-PROVENANCE endpoint=api.z.ai` line plus `JOUST-GLM-DONE exit=N`.
2. **Bash-only command-runner agents.** Each `joust-glm-*` agent (cheap `haiku` driver, `Bash`+`Read` only) is told: run the one command in your message verbatim, never solve the task yourself.
3. **Provenance check.** The `_glm_run.log` must contain the `JOUST-GLM-PROVENANCE` marker — mechanical proof the attempt actually hit z.ai rather than a wrapper faking it. Phase 6 should verify this per GLM candidate; an attempt whose workspace has no marker / no deliverable is a failure, and the round proceeds over the survivors.

`ZAI_API_KEY` must be set (sourced from the user's shell profile). GLM tokens bill the z.ai plan and don't appear in Anthropic usage, but each attempt still shows as a node in `/workflows`. Note: weaker GLM models (esp. `glm-4.5-air`) are less reliable at actually saving a deliverable; `glm-5`/`glm-5.2` are dependable. The brief explicitly forbids clarifying questions and demands a saved file to mitigate this.

**Local dispatch mirrors GLM**, with three differences: (1) the runner is `bin/local-run.sh` (set z.ai env → set omlx/local env pointing at `http://127.0.0.1:8000`); (2) one generic `joust-local` agent serves every model, with the exact id passed as `--model <id>`; (3) the provenance marker is `JOUST-LOCAL-PROVENANCE endpoint=127.0.0.1:8000` written to `_local_run.log`. The runner reads `OMLX_AUTH_TOKEN` from the environment (uniform key handling — same as GLM/MiniMax; no rc-file sourcing). Local models are free but slower, and small ones can be unreliable at saving a deliverable — same honest-failure handling as GLM. There is no inline fallback for local; it always uses the runner script.

**Codex dispatch mirrors GLM/local**, with the same three-part fix (runner script `bin/codex-run.sh`; the single `joust-codex` Bash-only command-runner; the `JOUST-CODEX-PROVENANCE endpoint=api.openai.com` marker in `_codex_run.log`), plus codex-specific points: (1) it shells to `codex exec` (not `claude`), authenticating from `~/.codex/auth.json` — no API-key env var is required or injected; (2) verified-safe headless flags are `-s workspace-write -C "$PWD" --skip-git-repo-check -c approval_policy="never" -c 'mcp_servers={}' -o _codex_last.txt -m gpt-5.5 -c model_reasoning_effort=<tok>` — **note `-a/--ask-for-approval` is a TOP-LEVEL flag that CRASHES `codex exec` ("unexpected argument '-a'")**, so approval is set via the `-c` config override, never a flag; (3) codex has **no `--max-turns`**, so unlike GLM/local it relies on the **wall-clock timeout alone** (`codexTimeoutSecs`, default 600); (4) the runner adds a defensive grep for terminal model/auth/version failures that forces a nonzero exit, so a soft 400 still fails closed. The indirection matters **most** for codex: it is a fully autonomous external agent, so handed a raw `codex exec` command a wrapper LLM is especially prone to solve-it-itself, refuse on safety, or let codex bail without saving. Codex bills the user's OpenAI/ChatGPT plan.

**MiniMax dispatch mirrors GLM/local/codex** (runner script `bin/minimax-run.sh`; the single `joust-minimax` Bash-only command-runner; the `JOUST-MINIMAX-PROVENANCE endpoint=api.minimax.io` marker in `_minimax_run.log`), with two MiniMax specifics: (1) one model only (`MiniMax-M3`), so the runner takes **no `--model` flag** — `ANTHROPIC_MODEL=MiniMax-M3` pins it; (2) the key (`MINIMAX_API_KEY`) is read from the env, identical to GLM's `ZAI_API_KEY` — **no runner sources or greps rc files; all keys come from the env, so every runner is uniform.** It uses both per-attempt guards (`attemptMaxTurns` / `attemptTimeoutSecs`). MiniMax bills the user's MiniMax plan.

**Grok dispatch mirrors codex** (an external non-`claude` CLI authenticated from a file, not an env key), with grok specifics: (1) it shells to `grok -p "$(cat _brief.txt)"` through `bin/grok-run.sh`, authenticating from the OAuth session (`~/.grok/auth.json`) OR `XAI_API_KEY` — the runner requires/injects **neither** (mirrors codex), and records `auth=oauth-session|env-key` in the provenance line for session-expiry diagnosis; (2) verified-safe headless flags (all present in `grok --help`, agentic file-write verified end-to-end) are `-p "<brief>" -m <id> --always-approve --max-turns <N> --no-subagents --no-alt-screen --no-auto-update --cwd "$PWD"`, plus `--disable-web-search` **UNLESS** `JE_GROK_WEB=1` (the workflow's `grokWebSearch:true`). `--no-subagents` keeps the attempt ONE independent unit (grok-build can otherwise spawn up to 8 parallel sub-agents — an internal swarm that fights JE's "N independent attempts" model and is the main variable-latency surface). Two flags are deliberately OMITTED: **`--no-plan`** (it toggles grok's read-only plan PERMISSION mode, not the model's reasoning — JE runs planning tasks, and a measured A/B showed it gave no speed benefit yet thinner plans) and **`--no-memory`** (cross-session memory is the opt-in `--experimental-memory` feature, OFF by default, so the flag is a no-op). Web search is OFF by default (hermetic + fair in a mixed blind review, consistent with glm/minimax/local/codex which have no web); enable it per-run for tasks needing LIVE web (validate a URL/doc/link). (3) **unlike codex, grok HAS `--max-turns`**, so it uses **both** guards via the standard `runnerCmd` (NOT `codexRunnerCmd`) — `grokMaxTurns` (default 30) + `grokTimeoutSecs` (default 600); (4) the runner adds a defensive grep for terminal auth/model/version failures, gated on "no deliverable produced" (mention-proof, like codex's `[ ! -s "$LAST" ]`), that forces a nonzero exit so a soft failure still fails closed; (5) the provenance marker is `JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com` in `_grok_run.log`. Grok bills the operator's SuperGrok / X Premium+ plan.

**Stdin (all `claude`/`codex` runners).** Every runner closes stdin with `</dev/null` on the nested call. With a prompt passed as an arg but an *open* (non-TTY) stdin, `claude`/`codex` wait for stdin input — `claude` warns "no stdin data received in 3s" and can stall the whole wall-clock; `codex` prints "Reading additional input from stdin" and hangs to the timeout. Closing stdin is mandatory and uniform across glm/local/codex/minimax/grok.

**Task-size profiles (dynamic limits).** The per-attempt guards below are not fixed: the SKILL (Phase 1c) sizes them to the task — a manual marker-adjacent `short`/`medium`/`long` override, else the orchestrator's estimate. `bin/je-parse.mjs` is the single source of truth: `SIZE_PROFILES` defines each label's full guard set, and `node bin/je-parse.mjs --size <label>` prints it as JSON for the SKILL to pass straight into the workflow args. The keys are exactly the arg names the engine reads, so they flow into the runners as `JE_MAX_TURNS`/`JE_TIMEOUT_SECS`. Reference values:

| guard | short | medium | long |
|-------|-------|--------|------|
| `attemptMaxTurns` (GLM) | 15 | 30 | 50 |
| `localMaxTurns` | 12 | 20 | 35 |
| `minimaxMaxTurns` | 15 | 30 | 50 |
| `grokMaxTurns` | 15 | 30 | 50 |
| `attemptTimeoutSecs` (local/base) | 180 | 300 | 600 |
| `glmTimeoutSecs` | 600 | 1200 | 2400 |
| `minimaxTimeoutSecs` | 300 | 900 | 1800 |
| `codexTimeoutSecs` | 300 | 600 | 1200 |
| `grokTimeoutSecs` | 300 | 600 | 1200 |

`medium` matches the engine's historical defaults in spirit (with a roomier GLM wall-clock, since z.ai is slow). **Native Anthropic attempts are uncapped** — the workflow's `agent()` primitive exposes no turn/time cap, so the size profile only affects the runner-based providers (GLM / local / codex / MiniMax / grok).

**Per-attempt guards (two layers).** The GLM and local runner scripts bound the nested `claude` call with both layers below. **Codex uses only layer 2** (the wall-clock timeout): `codex exec` has no `--max-turns`, so there is no iteration layer to apply — which is exactly why `codexTimeoutSecs` defaults higher (600s).

1. **`--max-turns` (primary, iteration-based).** Passed from `JE_MAX_TURNS`: **GLM = `attemptMaxTurns` (default 30); local = `localMaxTurns` (default 20).** This caps agentic turns, so an attempt that tries to grind the write→run→fix loop is stopped cleanly. Crucially, **the deliverable written before the cap is preserved** — hitting the cap truncates the grind but keeps the best-so-far file (claude prints `Error: Reached max turns (N)` and exits non-zero; the saved file is still graded). Local gets the tighter cap because weaker local models (observed clearly on Qwen) ignore "single pass" and burn turns **rewriting the art on self-critique** ("that's a cow face… proportions are off… let me realign") and **fixing their own buggy code** (bad raw-string escaping; Linux-only `cat -A` on macOS). The hard-stop brief (below) curbs the behaviour at the source; the tight cap is the backstop. A clean single pass under the hard-stop brief is ~2 turns (Write → stop); the caps are generous runaway backstops, sized up because substantial writing deliverables legitimately need more turns than a tiny script.
2. **Wall-clock timeout (backstop, time-based).** Portable perl `alarm` → TERM/KILL (macOS has no `timeout`/`gtimeout`), from `JE_TIMEOUT_SECS` (workflow `attemptTimeoutSecs`, default 300s for local/minimax; `glmTimeoutSecs` for GLM — its own knob, default = `attemptTimeoutSecs`, bump to ~1800-2400 for heavy multi-file builds where GLM via z.ai is slow; `codexTimeoutSecs`, default 600s for codex). Catches a *single* hung or pathologically slow turn that `--max-turns` can't (one turn never returning), and for codex it is the **only** guard. On fire it logs `JOUST-{GLM,LOCAL,CODEX}-TIMEOUT secs=N` and exits 124. Scale to task complexity (~180s small, 300s+ heavier; codex/big-writing tasks more). Note the local Qwen timed out at 600s producing a ~27KB proposal — on-device models are poorly suited to heavy writing deliverables; prefer hosted providers (or a much larger timeout) there.

Either way a bounded-out attempt is just an honest failure and the round proceeds over the survivors. These cover the runner-based (GLM/local) attempts — native Anthropic attempts have no shell hook, but they are fast and bounded by the single-pass brief. The **single-pass brief is the real fix**; these two are the safety net.

If dynamic workflows are unavailable, use the manual Task-tool + `glm`/`omlx`-CLI fallback below.

## Run layout

Two roots, not one. `runDir` holds round bookkeeping, staged/blind review pools, and every
persisted artifact (mapping.json, SUMMARY*.md, review-*/, contributions.json). Each
candidate's raw, unstaged WORKSPACE lives under a separate `workspaceRoot` — by default
`/tmp/je-workspaces/<run-id>` (issue #34: `runDir` sits inside the plugin cache / user config
dir, a path nested claude-CLI runners — glm/minimax/codex/grok — refuse to write under, so a
completed runner attempt could burn its whole turn budget fighting write denials and save
nothing). Pass `workspaceRoot: runDir` to reproduce the pre-fix single-tree layout. Isolation
is not optional either way: parallel agents writing to a shared path produce race conditions
and overwritten files.

```
<runDir>                                  (default <plugin-root>/.runs/<run-id>)
├── round-1/                              # round 1 candidate workspaces (repoMode:true only —
│   ├── candidate-1/                      #   worktree checkouts under worktreeRoot instead;
│   └── ...                               #   repoMode:false has NO round-1/ here, see below)
├── review-1/                             # Phase 3 Opus reviewer workspace + report (+ guidance)
├── winner/                               # (two pass) the saved round 1 winner artifact
├── round-2/                              # (repoMode:true only, mirrors round-1/ above)
├── final-rank/                           # (two pass) final Opus ranker workspace + report
└── _context/                             # shared context bundle, if contextFiles was passed

<workspaceRoot>                           (default /tmp/je-workspaces/<run-id>, repoMode:false only)
├── round-1/
│   ├── candidate-1/                      # round 1 attempt workspaces
│   ├── candidate-2/
│   ├── ...
│   └── candidate-N/
└── round-2/                              # (two pass) round 2 attempt workspaces
    ├── candidate-1/
    ├── ...
    └── candidate-N/
```

Single pass stops after `review-1/`: the Phase 3 reviewer names the winner and that is the
result. `repoMode:true` uses `worktreeRoot` (default `/tmp/je-worktrees/<run-id>`) for the
same reason and in the same shape — see the repo-anchored-mode notes below.

## Return codes (JE-RC) and `rc_summary`

Every seat (attempt, judge lens, helper, auto-issue filing) ends with an OFFICIAL two-digit return
code. Runner attempts self-report a terminal `JOUST-RC <code> <reason>` line in their `_*_run.log`;
native/judge/helper seats have their RC **derived in code** from signals the engine already observes
(a missing runner line parses as `09`). RCs are **observability, not control flow** — fail-safety is
unchanged except where behaviour already branches (retries, fallbacks, the auto-issue hook).

| RC | meaning | RC | meaning |
|----|---------|----|---------|
| 00 | expected result | 05 | no deliverable saved |
| 01 | model timeout (wall-clock) | 06 | provenance failure |
| 02 | model unavailable / throttled | 07 | environment / permission failure |
| 03 | turn-cap exhausted | 08 | aborted / killed |
| 04 | invalid output | 09 | unknown / other |

The workflow **return value** and `mapping.json` now carry
`rc_summary { seats, by_code: {"01":2,…}, non00: [{seat, phase, rc, reason}] }`, and `SUMMARY.md`
renders it as a per-seat table (blind-safe: seat ids are candidate letters / `label:lens` / helper
labels, never a model identity). Per-candidate `rc`/`rcReason` appear on each `mapping.json` row; each
council round records `dead_seats` + a per-verdict `rc`. Engine-fault classes (01/02 after retries,
04–09 — not 00/03) auto-file one deduped, privacy-scrubbed `dogfood` issue per class per run via
`issueRunner` (respects `noAutoIssue`, pinned to `engineRepo`, fail-closed — see `references/dogfood.md`).

## Dispatching the attempts

Launch all N of a round in the same turn so they run concurrently, each pointed at its own workspace. Single pass dispatches the Round 1 brief only. Two pass dispatches the Round 1 brief, then later the Round 2 brief.

**Each attempt is a SINGLE-PASS exploration, not a grind to perfection.** This is the most important property of the brief, and it is easy to get wrong. The refinement in this system happens at the **tournament** level — many diverse one-shot attempts → blind review → (two pass) distilled guidance → a fresh guided round → final rank — *not* inside any one attempt. So the brief must tell each attempt to produce one solution and stop, explicitly forbidding "iterate until it works":
- An instruction like "actually run it and iterate until it works" is **harmful** here. It (a) collapses diversity — attempts converge on "whatever runs" instead of exploring different approaches; (b) suppresses the failure signal that the review distils into round-two guidance (a rough or broken attempt is *useful data*, not a wasted slot); and (c) on slow or local models, balloons the context (write→run→read→fix loops) into tens of thousands of tokens, turning a one-minute call into many minutes.
- Allow at most a single quick sanity run. Require that a file be saved (an empty workspace is a real failure), but make clear it need not be flawless. Ask for an honest note on known limitations — that note feeds the distillation.
- Keep the no-cross-talk rule: convey "single pass, don't over-polish" as a working style; do **not** tell the attempt it is one of several, that it is being judged, or that failures feed a later round.

**Round 1 brief (identical task plus one diversity modifier) — both modes:**

```
You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
<the exact task text, verbatim>

<one drawn diversity modifier, per references/diversity-injection.md, e.g.
"Approach this task test-first: sketch the tests before the implementation.">

Rules:
- Fully specified — do NOT ask questions; make reasonable defaults and just produce your solution.
- SINGLE pass, then STOP: write the file ONCE and stop. Do NOT run, test, inspect, rewrite, or polish it — your first version is final, even if imperfect.
- Save your solution file(s) to: <run-id>/round-1/candidate-<i>/  (an empty workspace is a failure;
  the file need NOT be flawless). Work only in that directory.
- End with a 2 to 4 sentence note on your approach, tradeoffs, and any known limitations.
```

**Round 2 brief (two pass only — task plus distilled guidance, no prior code):**

```
You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
<the exact task text, verbatim>

The following are FALLIBLE PRIORS distilled from a single, noisy review of one earlier round —
hypotheses to weigh, NOT instructions to obey. Each is tagged [strong] (held up repeatedly) or
[tentative] (single-sighting or speculative). Let no single item override your own judgment: if your
approach has a good reason to differ — especially from a [tentative] item — follow your reason. Solve
the task your own way; use these only to steer off real pitfalls and toward ideas worth considering.

Patterns that seemed to work (consider, don't copy):
- [strong] <corroborated principle> (<why>)
- [tentative] <single-sighting idea> (<why>)
And pitfalls that hurt attempts (avoid, unless you have a concrete reason they don't apply):
- [strong] <repeated failure mode> (<why>)
- [tentative] <one-off weakness> (<why>)

<one drawn Pool A nudge — or, for design-brief rounds, one Pool A2 angle-brief paragraph —
per references/diversity-injection.md, e.g.
"Approach this task starting from the data model or core types.">

Rules:
- Fully specified — do NOT ask questions; make reasonable defaults and just produce your solution.
- SINGLE pass, then STOP: write the file ONCE and stop. Do NOT run, test, inspect, rewrite, or polish it — your first version is final, even if imperfect.
- Save your solution file(s) to: <run-id>/round-2/candidate-<i>/  (an empty workspace is a failure;
  the file need NOT be flawless). Work only in that directory.
- End with a 2 to 4 sentence note on your approach, tradeoffs, and any known limitations.
```

In neither round, and in either mode, tell an agent it is one of several, what N is, that it will be judged, or hand it another agent's output. Each attempt must be an independent solution. The round two guidance steers; it must not include or paraphrase a specific candidate's code, only generic patterns to emulate and pitfalls to avoid.

**Fresh workspaces + the read-before-write guard.** Each attempt gets its own clean workspace (only `_brief.txt` pre-exists), so the deliverable is a *new* file and Claude Code's "file must be read before overwriting" guard does not fire — verified. It can only fire if a workspace is reused (same run-id across runs, or a resume) and a stale deliverable lingers; weaker local models then waste turns (read → retry) on it. Two cheap defenses: use a **unique run-id per run** so paths never collide, and the brief already instructs attempts to overwrite via the shell (`cat > FILE <<'EOF'`) if a file-edit tool demands a read-first — so even a reused workspace stays a clean single pass.

### Two dispatch paths (Anthropic vs GLM)

Each attempt's assigned model decides how it is launched. The **brief is identical either way** — same task text, same one diversity modifier, same isolation and self-summary rules — only the launch mechanism differs.

- **Anthropic attempt (`opus`/`sonnet`/`haiku`):** spawn a sub-agent via the Task tool with that `model`, as usual.
- **GLM attempt (`glm-5.2`/`glm-5.1`/`glm-5`/`glm-4.7`/`glm-4.5-air`):** the Task tool cannot target a GLM model, so launch it by shelling out to the `glm` CLI (see next subsection). It runs agentic with tools in its own workspace, exactly like a Task sub-agent, but on the GLM backend.

A single round can mix both paths (e.g. Mixed mode): launch the Task sub-agents and the `glm` background commands in the same turn so the whole round runs concurrently, then collect all deliverables together.

### Dispatching GLM attempts

For each GLM attempt with workspace `WS` and chosen GLM model mapped to its `glm` flag `F` (per the mapping table above), run the attempt brief through the `glm` CLI, agentic, with its cwd set to the isolated workspace:

```
( cd "WS" && glm -p "<the exact attempt brief, same text a Task sub-agent would get>" \
    --model F --allowedTools "Bash Read Write Edit" ) > "WS/_glm_run.log" 2>&1 &
```

- **cwd = the workspace** so the brief's "save to / work only in this directory" rules resolve to `WS` (the `glm` agent treats cwd as its working dir).
- `--allowedTools "Bash Read Write Edit"` pre-grants the tools so the non-interactive `-p` run never blocks on a permission prompt. (`ZAI_API_KEY` must be set; it comes from the user's shell profile.)
- Background each call with `&` (redirecting to a per-candidate log) so all of the round's GLM attempts run in parallel, then `wait` for them.
- **The deliverable** is whatever files the agent wrote in `WS`; **the self-summary** is the tail of `_glm_run.log` (the agent's final printed message). Collect both, exactly as you would a Task sub-agent's return.
- Do not put competition/judging/N context in the brief, same as any other attempt.

A quick liveness check before a big round is cheap: `glm -p "reply OK" --model haiku` should print `OK`.

### Concurrency and rate limits

- Keep each candidate's writes atomic and confined to its own directory.
- Many concurrent model requests can hit provider rate ceilings. If dispatch stalls or errors on rate limits, split N into smaller parallel batches (for example 4 at a time) run in sequence; attempts within a batch still run in parallel.
- If a sub-agent fails or returns nothing, note it and continue. A round proceeds over the attempts that succeeded, and the report states which attempt failed.

## Dispatching the Opus passes

**Stage + validate + pool before judging (engine, both passes).** A candidate's live workspace is NOT shown to the judge — it contains `_brief.txt` and `_glm_run.log` / `_local_run.log`, and those provenance logs name the provider/model (`flag=--model opus` = glm-5.2, the exact local id, etc.) while Anthropic workspaces have no such log. Pointing a "blind" judge at the raw workspace therefore leaks identity, and in two pass the round-1-vs-round-2 path also unmasks the carryover. So `stageAndValidate` (one cheap `haiku` agent running a deterministic shell script) does three things at once, into a clean `review-1/` (and `review-final/`) tree with no round in the path:
- **Stage** each candidate's deliverable files into `<blind>/` by copying everything then deleting the known engine files *by exact name* (`_brief.txt`, the two run logs) — an **allowlist**, so a legitimately `_`-prefixed deliverable (e.g. `_config.yml`, `__init__.py`) is kept, not dropped.
- **Validate**: a candidate must have saved a deliverable AND (for GLM/local/codex) its log must show the **success** provenance contract — the `PROVENANCE` marker *and* `DONE exit=0` *and* no `TIMEOUT`/`ERROR` line (merely "a `JOUST-` line exists" is not enough; the runners write those before/around failures too). The greps are **line-anchored and provider-specific** (`^JOUST-<PROV>-…`, where `<PROV>` is the candidate's own `GLM`/`LOCAL`/`CODEX`), **not** a greedy `JOUST-.*-` — a real fix: the greedy form invalidated two genuinely-successful GLM proposals because the proposals' own text discussed a `JOUST-CODEX-ERROR` marker, which got echoed mid-line into the runner log and matched. Anchoring to column 0 (where the runner writes its markers) and pinning the provider stops an attempt whose deliverable merely *mentions* a marker from false-failing. The agent returns the per-candidate `{deliverable, provenance}` as a **schema** (not scraped prose), and the engine **fails closed** — any candidate missing from the return, or not deliverable+provenance, is invalid and excluded *before* the judge runs (recorded `valid:false` + reason).
- **Pool**: concatenate the valid deliverables into one blind-labelled `_pool.md` (`===== Candidate A =====` sections). The judge reads that ONE file instead of N per-candidate dirs (the per-candidate dirs remain only so the judge can *run* code when needed) — the same read-cost collapse the context bundle gives the attempts.

**Implement deliverable contract (run G).** Non-repoMode implement briefs mandate ONE fixed deliverable layout — `patches/` (ordered unified diffs) + `APPLY.md` (exact, ordered apply commands) + `VERIFY.md` (how to verify), with a `files/` + `APPLY.md` full-files fallback — and a bounded self-verify (fix the diff until `git apply --check` exits 0 in a scratch `git init`, or use the fallback). The mechanical gate's same pre-council helper call classifies each candidate's layout (`patch_layout | files_layout | engine_diff | freeform | unavailable`) and stamps a judge-visible `--- Contract check --- / CONTRACT: …` line into `_pool.md` beside the orthogonal `MECHANICAL:` stamp (apply-ability vs packaging); `mapping.json` records the class. v1 grandfathers: `freeform` is stamped, never invalidated; repoMode candidates are trivially conformant (`engine_diff`, engine-generated `candidate.diff`); any check failure degrades to UNSTAMPED, never a shrunk field.

Each judge's returned winner/ranking is reconciled against the real blind-label set (normalised, repaired to a full permutation), every judge call is retried-once-then-degrades-to-a-partial-result rather than crashing a fully-paid run, and an empty valid pool short-circuits instead of asking the judge to rank nothing.

**Residual blindness caveats (advisory, not enforced).** Two things the prompt asks for but cannot mechanically guarantee: (a) each judge has `Read`/`Bash` and the absolute `runDir`, so it *could* walk to a sibling `round-*/candidate-*/` and read a provenance log — the prompt tells it not to read anything outside the pool, but that is honour-system; (b) the blind letter is decorrelated from dispatch order by a constant rotation, and each council lens additionally gets a *differently-rotated* candidate listing (position-bias control), but the *presentation order* in the shared `_pool.md` is fixed — so any residual positional bias is uncorrected (and reproducible) — weight on merits, not order.

**The judging council (default) — the shape at both decision points.** Judging is a **blind 6-seat council that votes once and never deliberates (judging-v3)** unless `judges: 1` is passed. All lenses read the same staged blind `_pool.md`; the pipeline is:

1. **Round 1 (independent).** Five Opus judges — **correctness, spec, security, robustness, craft** — run in parallel with no peer visibility. Each returns per-candidate pros/cons through its lens, a full ranking, a first-place `vote`, `reasoning`, and a required `checks_run[]`. The **security** lens also returns per-candidate `safety` (`SAFE`/`UNSAFE` + severity + evidence).
   - **Seat routing (mixed-family, default).** The completeness-class seat (spec for code, completeness for plan) and the simplicity-class seat (craft for code, simplicity for plan) dispatch to **codex-xhigh** via the codex runner by default (brief → `VERDICT.json` → engine-side parse/shape validation → the same `reconcileLens` + integrity guard as a native verdict). A seat that fails twice falls back to native Opus for that round so the council never loses a seat. The security veto and the verification-heavy lenses stay Opus, and no runtime flag moves the PRIMARY veto off Anthropic. Each council also seats a SIXTH judge — `security-x`, a second cross-family security gate on codex-xhigh with the same mandate and its own veto (UNION: a standing evidenced flag from either gate excludes; 6 living judges => majority 4/6). `judgeMix: 'anthropic'` disables this and forces every seat native, byte-for-byte. `dualSecurity: false` drops ONLY the `security-x` seat (restoring the 5-seat odd panel; an escape hatch — under judging-v3 a tied even panel is cheap, it just seeds the steelman shootout, so the dual gates run by default); the primary security veto seat cannot be disabled.
2. **Tally (plain code, every round).** Majority = strictly **>50%** of the *living* judges' first-place votes on a candidate the security lens has **not** vetoed. No LLM ever aggregates votes — the tally and the veto are deterministic code in `tournament.mjs` (`councilTally`).
3. **Resolution (judging-v3 — councils never deliberate).** Intermediate reviews FAST-TALLY (majority carries 1; split carries the top-2 non-vetoed into the final pool — `carried` in the result + `carriedOver` in mapping.json). Final decision points run the STEELMAN SHOOTOUT (seed top-2 → boost from judges' cons → cold blind re-judge; max 5 rounds); a 5-round tie returns `needs_orchestrator_pick: {finalists, gated_ws, verdicts}` — the ORCHESTRATOR picks between the gated, security-cleared finalists (never the engine, never an LLM aggregation; a vetoed candidate can never be picked). `no_consensus: true` with `winner: null` remains ONLY for all-vetoed (interactive: surface the split; grand loop: needs-human + HALT).
4. **Judge death.** Each lens retries once; a still-dead lens drops and the majority recomputes over the living. Exception: the security lens dying in repo-anchored mode is unresolvable veto coverage → fail closed to NO_CONSENSUS; an isolated run proceeds with a loud logged warning.
5. **Guidance (two pass).** A *separate* synthesis call (explicitly not a decision-maker) distils the round-2 guidance from the final verdicts under the same cap/schema/blind rules — it never picks or changes a winner.

Council metadata (per-judge verdicts, per-round tally, vote evolution, veto events, `no_consensus`) is logged and persisted (`review-*/council.json`, `verdict.md`, the run summaries), including, per verdict, the actual judge model used that round (`judge_model` — `opus` or `codex-xhigh`). The consolidated `ranking` downstream consumers read is derived in code (winner first, then remaining by first-place votes, average rank, blind label); it is bookkeeping, not a consensus override — the winner slot is only ever a majority non-vetoed candidate.

**Snapshot pinning (every judge).** Every judge brief — council lens or legacy `judges: 1`, native Opus or codex-xhigh — pins the evaluation to the tournament snapshot: the staged `_pool.md` + the per-candidate directories (plus, in repo-anchored mode, the isolated worktrees at the base commit SHA), and explicitly forbids consulting the live/current repo checkout (whose state may have moved past what any candidate was judged against — the observed wrong-tree judging failure). The pinned scope is built by `pinnedScopeBlock` (wired into both `lensPrompt` and `judgePrompt`). A `checks_run` entry citing a path outside that scope logs a **non-fatal** warning (v1 telemetry — `checksRunRootsIssue`); it never fails the verdict.

**Legacy single judge (`judges: 1`).** One blind Opus agent does the whole job at each point — the pre-council path, byte-for-byte. Spawn it with the candidates and `references/review-rubric.md`: it returns per-candidate pros/cons, ranking, and winner (and in two pass the two guidance lists). Do not pass model identities to it. The final ranker (Phase 5) builds the pool of N round-two attempts plus the one saved round-one winner, re-labelled blind, and ranks it the same way.

## Harness notes

- **Claude Code:** use the Task tool to spawn each Anthropic attempt with the chosen `model`; spawn each GLM attempt by backgrounding a `glm -p` call (see "Dispatching GLM attempts"). With dynamic workflows / ultracode enabled, Claude can fan out and verify automatically. Confirm at the first dispatch. The reviewer/ranker are always Task-tool Anthropic Opus.
- **Claude Agent SDK:** spawn Anthropic sub-agents programmatically with per-agent model selection; for GLM attempts, invoke the `glm` CLI as a subprocess per the dispatch pattern. The same isolation, no-cross-talk, and blind-review rules apply in both modes.
- **Claude.ai (no sub-agents):** true parallel independent agents are not available. **Still run the interactive gates:** ask the Phase 1 model question and get the go-ahead exactly as written; only the parallelism is approximated, not the elicitation. Then produce each round's N attempts one at a time in separate, self-contained passes, holding each chosen model as the capability bar, and do the review yourself against the rubric. Flag to the user that this is a sequential approximation. In two pass, be especially careful not to let round one's code leak into round two beyond the distilled guidance.

## Grand loops (Feature 1 — the `Z` parameter)

`Z>=2` turns a single isolated tournament into an **unattended chain** that, for each of `Z` loops, runs a full tournament, **implements the winning proposal into the real repository** on a new branch, verifies it, and opens one PR. `Z=1` (or omitted) is unchanged — the isolated tournament described above, touching no repo and opening no PR.

### Layering (where each piece runs)

- **SKILL.md (Phases 0/0b/7) is the driver.** The orchestration home is the **SKILL procedure + bundled bash helpers**, NOT a nested workflow. The main agent runs the Z-loop: it invokes the `Workflow` tool for the tournament once per loop and the `Task` tool for the implementer, and calls `bin/je-git.sh` for every git/gh side effect. There is **no `grand-loop.mjs` workflow** and **no workflow-spawns-workflow**; the deterministic, must-not-improvise parts (git/gh/verify/preflight/markers) live in `bin/je-git.sh`, the non-deterministic parts (running the tournament, applying the winner) stay in the harness where the `agent()`/`parallel()` primitives live.
- **`workflows/tournament.mjs` is UNCHANGED.** The per-loop engine is exactly today's tournament. The only difference is the SKILL passes a per-loop `runDir` of `<runDir>/loop-<k>` and augments the task text with the cross-loop ledger (below). The engine never touches the real repo, never runs git, never opens a PR — that purity is its safety guarantee and grand loops do not break it.
- **`agents/joust-implementer.md` (Opus) is the only actor that writes to the real repo.** Tournament attempts stay sandboxed one-shots that produce a written *proposal*; the implementer turns the *winning* proposal into a real diff on one `JE-` branch. It never touches git.
- **`bin/je-git.sh` holds ALL git/gh mechanics** as callable functions, mirrored on the bundled-runner pattern (`glm-run.sh`/`codex-run.sh`): portable on macOS (no GNU coreutils, no `timeout`, `/dev/urandom` for randomness), every gh/git call rc-checked and propagated, fail-closed. It has a dual interface: sourceable functions AND a `case "$1"` CLI dispatcher, so the SKILL calls `bash <plugin-root>/bin/je-git.sh <fn> args` (the same benign-command pattern the runners use).

So: **SKILL.md (gates + Z-loop) → tournament.mjs (one tournament, unchanged) + joust-implementer (applies the winner) + je-git.sh (preflight / branch / verify / commit / push / PR / DONE markers / STOP check).**

### The implementer agent brief

Invoked via `Task` with agent `joust-engine:joust-implementer` (model **Opus**, tools `Bash Read Write Edit`), cwd = the real repo root, on the already-created `JE-<loop>-<random7>` branch. Inputs: `proposal` (winner artifact path), `repoRoot`, `branch`, `base`. It reads the proposal + the real files, applies the proposal as the **smallest coherent change**, leaves the working tree **UNSTAGED**, and ends with a 3-6 line summary. It does **not** commit, push, switch/create branches, open PRs, or run any destructive git (the driver owns all of that via `je-git.sh`). Ambiguities are implemented as the most faithful reasonable interpretation and recorded in `JE-NOTES.md` at the repo root. It is a single audited actor on one isolated branch, never `main`, never auto-merged.

### Cross-loop memory (the ledger)

FAN topology means every loop branches off the same `base`, so without memory loops re-propose the same change (Z near-duplicate PRs). The driver keeps a `ledger` of `{loop, winner_summary, pr_url}` and appends it to each loop's task brief:

```
Prior grand loops on this same repository already proposed and implemented (on separate branches):
- loop 1: <winner_summary 1>
- loop 2: <winner_summary 2>
Propose a DIFFERENT, additive improvement that does not duplicate the above. If the repository is
already in good shape, say so explicitly rather than inventing a marginal change.
```

This diversifies loops and gives a loop a way to say "nothing worthwhile left" (an advisory soft-convergence signal, not enforced).

### Verify auto-detection (fail-closed, the crown jewel)

`je-git.sh detect_verify` scans, once, for: `package.json` scripts (`build`/`typecheck`/`test`/`lint` via `npm run <s> --if-present`, only those that exist), `pyproject.toml`/`setup.cfg`/`tox.ini` (`ruff check .`, `pytest -q`), a `Makefile` `test`/`check` target (`make test`/`make check`), Rust (`cargo build` + `cargo test`), Go (`go build ./...` + `go test ./...`). It records the commands; it does not run them.

`je-git.sh run_verify` runs the **frozen** command set (piped in on stdin) **fail-fast and fail-closed**: it captures each command's rc directly (`if cmd; then ... else rc=$?; break`), **breaks on the first failure**, and **never lets a later command's success mask an earlier failure** (no `tee`/grep rc recovery — `tee` masks exit codes). rc 0 = all passed; rc 1 = a command failed; rc 2 = no commands available (unverifiable).

`run_verify` is also **hardened against the unattended verify-time RCE** (issue #21): a verify command (`make test`/`npm run`/`pytest`) executes the *body* of a recipe/script/`conftest.py` the implementer may have just written from an LLM-authored proposal. Four layers, all inside `run_verify` so the existing PR routing (any nonzero rc → draft+needs-human + HALT) handles them automatically: (1) **diff-gate** — `verify_safe_diff` refuses (rc 1) before running anything if the implementer's unstaged changes touch a verify-executable file (`package.json`, `Makefile`/`*.mk`, `pyproject.toml`/`setup.*`/`tox.ini`/`conftest.py`, `Cargo.toml`/`build.rs`, `go.mod`, `test_*.py`/`*_test.py`/`*_test.go`, `.github/workflows/`, `.git/hooks/`) — those must be human-reviewed; (2) **secret-drop** — provider keys (`ZAI_API_KEY`/`MINIMAX_API_KEY`/`OMLX_AUTH_TOKEN`/`OPENAI_API_KEY`/`ANTHROPIC_*`/`GH_TOKEN`/`GITHUB_TOKEN`) are `unset` from the verify process so a verify command can neither read nor exfiltrate them (git/gh auth lives in *other* helper calls, in separate processes); (3) **no live re-detection** — an empty frozen set is `rc 2` (unverifiable), never a re-scan of the mutated tree; (4) **argv exec** — each command runs as a word-split argv vector, not via `eval`, so `;`/`|`/`$()`/backticks are inert.

PR routing: verify **pass** → normal PR. verify **fail or unverifiable** → a **draft PR labelled `needs-human`** (label created idempotently, with a label-less draft fallback) whose body includes a **capped tail** of the failing output (`je_append_verify_tail`, `tail -c`, so a huge log can't blow the PR body limit), and then the chain **HALTS** (fail-closed default; STACK always halts). **Never auto-merge.** When verify commands cannot be detected at all, still open the draft `needs-human` PR (do not skip the PR).

### Idempotency / DONE markers / interruption

- **Preflight** refuses on a dirty tree (never auto-stash unrelated work), and checks: inside a work tree, gh authenticated, a remote resolves (from the base branch's actual upstream, with an origin fallback), base branch resolves. It collects ALL failures rather than bailing on the first.
- **Per-loop DONE marker** at `<runDir>/loop-<k>/DONE` is written **only after the PR is created**. A re-run skips any loop whose DONE exists (no double-opened PRs).
- **Mid-loop death** leaves an `JE-<k>-*` branch with no DONE marker. On re-entry the driver detects it (`je_detect_orphan_branch`) and **STOPS, telling the human to inspect/delete it** — it never auto-resumes a half-applied implementer step (the engine has no resumability; resuming is unsafe). The driver always `git switch <base>` at the end, leaving the user where they started.

### STOP-file kill switch

`je-git.sh stop_file_check <runDir>` is checked at the **top of every loop iteration**. Creating `<runDir>/STOP` at any time halts the chain before the next loop, without killing the harness. (`stop_file_check` returns rc 0 — success — when the STOP file is present, so the caller's `if stop_file_check ...; then halt; fi` reads naturally.)

### Branch naming overrides any configured branch-prefix rule

Loop branches are `JE-<loop>-<random7>` (7 lowercase alphanumerics from `/dev/urandom`). This fixed name is used as-is, **overriding any branch-prefix rule you have configured, for these loop branches only**; the SKILL authorization (Phase 0b) states this explicitly. Non-loop work is unaffected.

### Topology

**FAN** is the default: each loop branches off the same `base` (the current branch, resolved at preflight), so every PR is independent and individually mergeable/rejectable, one bad loop does not poison others, and there is no rebase chain. **STACK** (each loop off the previous loop's branch) is opt-in (`topology=stack`) and, if chosen, **forces halt-on-failure** — a fragile chain cannot tolerate a broken link.

### Z ceiling

`Z_MAX = 5` is a runaway-**safety** bound (cost is not the constraint here). `je-parse.mjs` refuses `Z > 5` with a loud error that echoes the offending Z and tells the user to split into batches; the Phase 0b authorization additionally requires the user to **re-type Z**, so a fat-fingered large Z cannot run on one Enter.
