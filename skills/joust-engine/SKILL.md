---
name: joust-engine
description: "Run a Joust Engine tournament in one of two modes. The sigil is @@JE[:N][:M[:Z]] — N (optional) = attempts per round, M = passes (1 single, 2 two), Z = grand loops (Z>=2 = an UNATTENDED chain that, per loop, runs a full tournament, implements the winning proposal into your real repo on a new JE-<loop>-<random7> branch, runs fail-closed verify, and opens one PR — never auto-merged; Z=1 or omitted = today's isolated tournament; Z capped at Z_MAX=5); N may be inferred from a prose model spec like '2 opus, 2 glm 5.2, 1 codex high' (sum of counts = N, the items become the per-attempt Mixed assignment) or the Top Mixed preset ('top mixed' + N spread over opus/glm-5.2/codex-high), and bare @@JE falls back to the interactive model gate. A marker-adjacent task-size word (short/medium/long, e.g. @@JE:5 long) optionally overrides the per-attempt turn/timeout limits, which otherwise scale to the orchestrator's estimate of task size. First ask the user which model quality to use for the attempts (Anthropic Opus, Sonnet, Haiku; a GLM z.ai model via the glm CLI; a free local on-device MLX model via the omlx server; or Mixed per-attempt). SINGLE PASS: produce N independent solutions in parallel, then a blind Opus reviewer scores them, lists pros and cons, ranks them, and names a winner. TWO PASS: the same first round, but the Opus reviewer also distils what worked and what failed into guidance; the losing attempts are discarded, a second round of N fresh attempts is run with that guidance (positives to emulate, pitfalls to avoid), the saved round one winner is added back, and a final Opus ranker picks the overall winner. Trigger whenever the user's message contains a sigil of the form @@JE:N:M (for example @@JE:5 , @@JE:5:2 , @@je:7:2 ), where N is the number of attempts per round and M is the number of passes (omitted or 1 = single pass, 2 = two pass); the text before the sigil is the task. ALSO trigger on the prose marker 'joust:N' (single pass) or 'joust:N:2' (two pass), e.g. 'do abc :joust:5' or 'do abc: joust:5:2'. All forms are case-insensitive with optional spaces around the colons. Also trigger when the user clearly asks for a joust engine / generate-and-rank tournament even without a marker."
---

# Joust Engine

Joust Engine runs several independent attempts at one task and has a blind Opus reviewer pick the best. It has two modes:

- **Single pass** is the base pattern: N independent attempts in parallel, then one blind Opus review that scores them, ranks them, and names the winner. Done.
- **Two pass** is single pass with a learning step in the middle. Round one runs and is reviewed exactly as in single pass, but the reviewer also distils what worked and what failed into a short guidance brief. The winner is kept, the other artifacts are discarded, and round two runs N brand new attempts that are handed that guidance (but not the prior code), so they explore fresh while steering away from round one's mistakes. The saved round one winner is then added back into the pool, and a final Opus ranker picks the overall winner.

Two pass is therefore the same spine as single pass plus an extra round. Every shared step below (model choice, diversity injection, attempt dispatch, the review rubric, the report) applies to both modes identically; the only difference is that two pass continues past the first review into a guided round and a final rank.

Why two pass discards the losing artifacts but keeps the lessons: re-using the winner's code would just make round two copy it and collapse the diversity that makes the loop work. Re-using the distilled pros and cons keeps the diversity while raising the floor.

This skill is an orchestration procedure. Sub-agent dispatch depends on the harness (in Claude Code, the Task tool and dynamic workflows; the Claude Agent SDK exposes the same primitive). Follow the phases in order.

## Operating rule: this skill is interactive, stop and ask first

The moment you detect the trigger, your **first response must be only the Phase 1 model-selection question** (after silently parsing the invocation in Phase 0). Do not plan, do not write any attempt, do not pick a model yourself, and do not produce or pre-compose any candidate in the same turn the task arrives. Wait for the user's answer, then proceed. This applies to **both modes**.

This gate is mandatory **even when the environment cannot truly run separate-model sub-agents** (for example on Claude.ai with a single instance). Do not skip it on the grounds that the model choice "won't matter". It matters because the user explicitly asked to choose, the chosen model sets the capability bar each attempt is produced at, and the choice is recorded in the report. Silently producing the attempts without asking is the single most common failure of this skill; do not do it.

## Phase 0: Parse the invocation and detect the mode

Do not hand-parse the sigil. In Phase 0, run the bundled parser ONCE and act on its JSON:

```
node <plugin-root>/bin/je-parse.mjs "<the raw user message, verbatim>"
```

It returns `{ task, n, mode, z, assignment, size, preset?, conflict?, errors?, needsGate? }`. The grammar it implements:

- **Sigil** `@@JE[:N][:M[:Z]]` (case-insensitive, optional spaces around colons). N optional (int ≥ 2). M optional, default 1 (1 = single, 2 = two pass; any other value → error). **Z optional, default 1 (int in [1..5]). `Z=1` (or omitted) = today's isolated tournament, byte-identical. `Z>=2` = grand-loop mode (Phase 0b authorization + Phase 7 driver). `Z>Z_MAX=5` is a hard error (the parser refuses it and echoes the offending Z; tell the user to split into batches).** `@@JE:5` and `@@JE:5:2` parse exactly as before.
- **Positional skips are forbidden:** `@@JE:5::3` is invalid; to set Z with a default M, write `@@JE:5:1:3`.
- **Prose marker** `joust:N[:M[:Z]]` — extended identically.
- **Prose model spec** (may replace explicit N): a comma- or `and`-separated list of `<count> <model>` items anywhere in the message. Sum of counts = N; the items expand to the per-attempt assignment. The spec text is stripped from the task. An ordinary `<digit> <noun>` in the task (e.g. "fix 3 bugs") is NOT a spec.
- **Top Mixed preset:** `top mixed` (also `top-mix` / `top mix`) plus an N (from the sigil, or a leading count like `6 top mixed`) → allocate N across `[opus, glm-5.2, codex-high]` as evenly as possible (remainder priority opus > glm-5.2 > codex-high; N=2 → opus+glm-5.2).
- **Task-size override** (dynamic limits): a marker-adjacent `short` / `medium` / `long` (e.g. `@@JE:5 long`, `@@JE short, <task>`, `tidy up long @@JE:4`) sets `size` to force the per-attempt turn + timeout limits. Recognised only next to the marker and stripped from the task (the AFTER form needs a comma/semicolon/end right after it), so an ordinary size word in the task body is untouched. When absent, `size` is `null` and Phase 1c estimates it.

**Act on the JSON, in this order:**

1. **`errors` non-empty → STOP and ask.** Print the error(s) and do nothing else. This covers: an unrecognised model token (never silently drop one — a dropped token changes N), an invalid M, an invalid Z (< 1), **`Z > Z_MAX` (5) — refuse and tell the user to split into batches (the error names the offending Z; do NOT silently treat it as Z=1)**, a positional skip, and N < 2. `n` and `assignment` are nulled on any error, so never run a tournament when `errors` is present.
2. **`conflict` present → STOP and ask, surfacing BOTH numbers.** The sigil/marker N and the prose-spec sum disagree. Do **not** guess. Ask, e.g.: *"Your spec lists N=`conflict.specN` (`assignment`) but the marker says N=`conflict.markerN`. Run the spec's count, or N=markerN (and I'll ask the per-attempt models)?"* Proceed only after the user resolves it.
3. **`needsGate: true` → run the Phase 1 gate.** This is bare `@@JE` (no N, no spec), or Top Mixed with no N anywhere. Go to Phase 1.
4. **Otherwise (`n` set):** the invocation is complete. If `assignment` is set (a prose spec or Top Mixed already answered the model question), **skip the Phase 1 menu** and use that assignment directly — it *is* a Mixed assignment. If `assignment` is null but `n` is set (explicit N, no spec), run the Phase 1 gate as today.
5. **`z >= 2` and no error/conflict → grand-loop mode.** After resolving N/assignment/mode as above, do NOT start a normal tournament. Instead: (a) run the **non-implementable-task check** below; (b) go to **Phase 0b** (the one front-loaded autonomy authorization); (c) then run **Phase 7** (the grand-loop driver). For `z == 1` everything proceeds exactly as today (Phases 1–6).

**Task** = the parser's `task` (everything before the marker, with the spec text and Top Mixed keyword stripped and any trailing separator colon removed). Every attempt in every round receives this identical task.

If the user clearly describes the loop's generate-and-rank tournament but omits any marker, you may still run it: infer single vs two pass from whether they describe a learning round, ask for N and the model if not given, then proceed.

Validate before continuing (the parser enforces these; re-check):
- N must be an integer of 2 or more.
- Single pass is roughly N attempts plus one Opus pass. At N of 8 or more, confirm the user wants that volume.
- Two pass roughly doubles the attempt count, so its cost ceiling is lower: at N of 6 or more, confirm the user wants that volume before proceeding (see the cost note in Phase 2).

**Non-implementable-task detection (only when `z >= 2`, before loop 1).** Grand loops implement the winning proposal into the real repo. A task that produces a **standalone artifact unrelated to the repo** (e.g. "write a haiku", "draft an email", "explain X") would make the implementer open empty/meaningless PRs. Before authorizing, judge whether the task implies a change to project files (refactor / add feature / fix / optimise / write tests / document). If it does not, STOP and offer Z=1 instead:
*"This task ('<task>') produces a standalone artifact, not a repo change, so grand loops (Z=<z>) would open empty/meaningless PRs. Run it as a normal tournament (Z=1) instead? [y/N]"*
Proceed to Phase 0b only on a clearly implementable task (or explicit user override).

## Phase 0b: Grand-loop authorization (Z>=2 only)

When `z >= 2`, the mandatory per-dispatch interactive gate (the operating rule) is **front-loaded into ONE authorization covering all Z loops** — the only way an unattended chain is compatible with "stop and ask." This **replaces** the per-dispatch gate for the whole chain (for `z == 1` the normal gate is unchanged). First run the **zero-token preflight** so you never spend on a doomed chain:

```
bash <plugin-root>/bin/je-git.sh preflight "<base = current branch>" "<runDir>"
```

`preflight` collects ALL failures at once (inside a git work tree? working tree clean — it REFUSES on a dirty tree; gh authenticated? a remote resolves from the base's upstream with an origin fallback? base branch resolves?) and warns (does not fail) if no verify commands are detectable. If it returns nonzero, print its failure list and STOP — run no tournament.

On a clean preflight, show this authorization and **wait** for the user to **re-type Z** (friction proportional to blast radius — a fat-fingered `@@JE:5:2:30` is already refused by the parser at Z_MAX; the re-type guards a valid-but-large Z):

```
Grand-loop mode requested: Z=<z> grand loops.

This is UNATTENDED and WRITES TO A REAL REPOSITORY. For each of <z> loops I will:
  • create a new branch  JE-<loop>-<random7>  off  <base = current branch '<base>'>   (FAN topology)
  • run a full <single|two>-pass tournament (N=<n>, models: <assignment or 'from the gate'>)
  • IMPLEMENT the winning proposal into your repo on that branch (the joust-implementer agent, Opus)
  • run verify (<detected commands, or 'NONE detected → draft needs-human PR'>) — FAIL-CLOSED: a failure HALTS the chain
  • open a PR (draft + needs-human if verify failed or could not run). I will NEVER merge.

Repo:           <repoRoot>
Topology:       FAN (independent, individually-mergeable PRs off <base>); a cross-loop ledger keeps loops from duplicating each other; you merge later
Branch naming:  JE-<loop>-<random7>   (NOTE: this OVERRIDES your global 'rob/' branch-prefix rule for these loop branches only)
Kill switch:    create a file  <runDir>/STOP  at any time to stop the chain before the next loop
Projected cost: ~Z × (N attempts + 1-2 Opus judges + 1 Opus implementer + verify)
                ≈ <z> × (<n> attempts + judges + implementer + verify). (Cost is not the constraint; this is for awareness. Real implementer + verify spend is included.)
                Repo-anchored mode adds, per loop, a nested security audit: +2 audit attempts (opus, glm-5.2) + 1 Opus reconciler, plus up to 1 runner-up re-gate (verify + audit) on a gate failure. Within the grand-loop envelope; included for awareness.

To proceed, re-type the number of grand loops: ___
```

Only if the typed number equals `z` do you continue to Phase 7. Any other answer (or a STOP request) aborts with no spend. **STACK topology** is opt-in only (`topology=stack` in the user's message): if chosen, say so in the authorization, note each loop branches off the previous loop's branch, and that STACK **forces halt-on-failure** (no continue-on-failure). FAN is the default.

## Phase 1: Choose the models (mandatory gate, stop here — both modes)

This is the gate from the operating rule (run it when Phase 0 returned `needsGate`, or when an explicit N has no inferred assignment — when Phase 0 already produced an `assignment`, skip the menu). Ask it as your first response and **wait for the answer before doing anything else**. N defaults to **6** (or whatever Phase 0 supplied); passes default to **2** (or 1). Ask exactly this, as a ten option selection, then stop:

> Which models do you want for the attempts? (N defaults to 6, passes to 2)
> 1. Top Mixed — spread N across Opus, glm-5.2, codex-high (even split)
> 2. Specify Mix — choose a model per attempt (custom)
> 3. Opus — Anthropic, highest capability
> 4. Sonnet — Anthropic, balanced
> 5. Haiku — Anthropic, fastest and cheapest
> 6. GLM — z.ai models (I'll then ask which GLM model)
> 7. Local — free on-device MLX models via the omlx server (I'll then list the available ones)
> 8. Codex — OpenAI gpt-5.5 via the `codex exec` CLI (I'll then ask which reasoning effort)
> 9. MiniMax — minimax-m3 via the bundled minimax runner
> 10. Grok — xAI Grok via the `grok` CLI (I'll then ask which variant)

Handle the answer (if Phase 0 already produced an `assignment` — a prose spec or the Top Mixed keyword — skip this menu and use it directly):

- **Option 1 (Top Mixed):** if N is not yet known, ask for it. Allocate N across `[opus, glm-5.2, codex-high]` as evenly as possible (remainder priority opus > glm-5.2 > codex-high; N=2 → `[opus, glm-5.2]`) — the same computation `je-parse.mjs` does for the `top mixed` keyword. Record it, e.g. N = 5 → `[opus, opus, glm-5.2, glm-5.2, codex-high]`.
- **Option 2 (Specify Mix):** walk the attempts one at a time, attempt 1 to attempt N. For each, ask which concrete model to use, offering the three Anthropic models, the four GLM models, the live local model ids, the four codex effort levels, **minimax-m3, and the two grok variants (grok-build / grok-composer-2.5-fast)** — not the group names. Record each choice, e.g. `[opus, glm-5.2, codex-high, grok-build]`.
- **Options 3, 4, or 5 (uniform Anthropic):** every attempt uses that single Anthropic model. Record the assignment, e.g. for N = 4 with Sonnet: `[sonnet, sonnet, sonnet, sonnet]`.
- **Option 6 (GLM):** drill down with a second question, then stop again and wait. Every attempt uses the one chosen GLM model:
  > Which GLM model?
  > 1. glm-5.2 — strongest, 1M context
  > 2. glm-5.1
  > 3. glm-4.7
  > 4. glm-4.5-air — fastest, cheapest

  Record the uniform assignment, e.g. for N = 4 with glm-5.2: `[glm-5.2, glm-5.2, glm-5.2, glm-5.2]`.
- **Option 7 (Local):** the local model list is **dynamic**, so fetch it live before drilling down — run `omlx-models` (or `curl -s http://127.0.0.1:8000/v1/models -H "Authorization: Bearer $OMLX_AUTH_TOKEN" | jq -r '.data[].id'`). Present the returned model ids as a numbered menu, then stop and wait. Every attempt uses the one chosen local model id (recorded verbatim, e.g. `[gemma-4-26b-a4b-it-8bit, ...]`). If the server is unreachable (connection refused), tell the user the local server appears down and offer another tier. Local models are free but slower; flag that for larger N.
- **Option 8 (Codex):** Codex is pinned to OpenAI **gpt-5.5** (the model the local ChatGPT-account auth serves; other ids need an `OPENAI_API_KEY`), so the submenu is the **reasoning effort** (codex's quality lever), not a model. First run a one-line liveness probe so a stale CLI / auth block doesn't waste a (possibly paid) round:
  > `printf 'reply OK and stop' | codex exec -s read-only --skip-git-repo-check -c 'mcp_servers={}' -m gpt-5.5 - 2>&1 | tail -5`

  If it returns an HTTP 400 "requires a newer version of Codex" → tell the user to `brew upgrade codex`; if "not supported when using Codex with a ChatGPT account" → tell them to set `OPENAI_API_KEY` (API-key billing) — then offer another tier. On success (it prints OK), ask:
  > Which codex reasoning effort? (model is gpt-5.5)
  > 1. Low — fastest, lightest reasoning
  > 2. Medium — balanced (codex default)
  > 3. High — deeper reasoning
  > 4. Extra high — maximum reasoning depth

  Record the uniform assignment using the `codex-<effort>` displayModel (effort token: low / medium / high / **xhigh** for "Extra high"), e.g. for N = 4 at High: `[codex-high, codex-high, codex-high, codex-high]`. Codex bills your OpenAI/ChatGPT plan, not Anthropic usage; flag that codex (an autonomous agent with no turn cap) is slower than a one-shot, so size N modestly.
- **Option 9 (MiniMax):** every attempt uses `minimax-m3`, dispatched via the bundled `bin/minimax-run.sh` through the `joust-engine:joust-minimax` agent. Record the uniform assignment, e.g. for N = 4: `[minimax-m3, minimax-m3, minimax-m3, minimax-m3]`. Treat it like the other single-model runner providers (its own `_minimax_run.log` provenance marker, same honest-failure handling). MiniMax-M3 handled a heavy multi-file build cleanly in testing (GLM is the slow one on big tasks); if it ever runs long on a large task, raise `attemptTimeoutSecs`.
- **Option 10 (Grok):** drill down with a second question, then stop again and wait. Grok is authenticated by the operator's grok.com **OAuth session** (`~/.grok/auth.json`); `XAI_API_KEY` (prefix `xai-`) is the headless/CI fallback only — the runner requires and injects NEITHER credential (grok resolves its own, like codex reads `~/.codex/auth.json`). Optionally run a one-line liveness probe first so a stale CLI / expired session doesn't waste a round:
  > `grok -p "Reply with the single word OK and nothing else." -m grok-composer-2.5-fast --disable-web-search --no-alt-screen --no-auto-update 2>/dev/null | tail -3`

  If it prints OK, ask:
  > Which Grok model?
  > 1. grok-build — xAI's agentic-coding model (grok-code-fast-1 lineage), 256K context
  > 2. grok-composer-2.5-fast — Cursor Composer 2.5 (Kimi K2.5), the CLI default

  Record the uniform assignment with the displayModel token, e.g. for N = 4 on build: `[grok-build, grok-build, grok-build, grok-build]`. Dispatched via the bundled `bin/grok-run.sh` through the `joust-engine:joust-grok` agent (ONE generic agent for both variants; its own `_grok_run.log` provenance marker, same honest-failure handling). Unlike codex, grok HAS a turn cap, so it uses **both** guards (max-turns + wall-clock); for heavy multi-file builds raise `grokTimeoutSecs`. Grok bills the operator's SuperGrok / X Premium+ subscription (or `XAI_API_KEY` billing if set), not Anthropic.

In two pass, the model assignment applies to **both rounds**: round two re-uses the same per-attempt list. If the user explicitly wants different models for round two, re-ask the gate for round two; otherwise re-use round one's assignment. Model aliases, the GLM/local dispatch mechanics, and the `--model` mappings are in `references/orchestration.md`. **Anthropic attempts dispatch via the Task tool; GLM attempts via the `glm`→z.ai runner; Local attempts via the `omlx`→on-device runner; Codex attempts via the `codex exec` runner; MiniMax attempts via the `bin/minimax-run.sh` runner (agent `joust-engine:joust-minimax`); Grok attempts via the `bin/grok-run.sh` runner (agent `joust-engine:joust-grok`)** (the non-Anthropic ones through bundled wrapper agents, per the orchestration reference). The reviewer and the final ranker are **always Anthropic Opus**, regardless of what the attempts use — the judge is held fixed so the comparison is consistent.

## Phase 1b: Diversity injection (default on — both modes)

Independent attempts are only valuable if they actually differ. Model heterogeneity and sampling give some of that, but same-model siblings on an identical prompt tend to converge. To prevent that, give each attempt a distinct framing drawn from a modifier pool, following `references/diversity-injection.md`. In short:

- **Pool A (approach nudges), on by default.** These vary how an attempt starts and proceeds, not what counts as a good answer, so the review stays blind. Drawn without replacement within a round so no two attempts share one, biased so same-model siblings get the most different nudges.
- **Pool B (objective lenses like safely, quickly, efficiently), opt-in only.** These bias the tradeoff an attempt makes. Offer them when the user wants to fan attempts across a tradeoff frontier on purpose, and read the Pool B handling notes before using them (they interact with blind review).

Seed and log the draw so the run is reproducible and the report can show what was applied. If the user prefers fully identical briefs, they can turn diversity injection off.

## Phase 1c: Size the per-attempt limits (estimate or override — both modes)

The per-attempt guards (turn caps and wall-clock timeouts) are **not fixed any more** — they scale to how big the task is, because a one-line script and a heavy multi-file build need very different headroom. Resolve a single size label — `short`, `medium`, or `long` — then pass that size's limit profile into the workflow in Phase 2.

**Pick the size in this order:**

1. **Manual override wins.** If Phase 0's parser returned a non-null `size` (the user listed `short` / `medium` / `long` next to the `@@JE` marker — e.g. `@@JE:5 long`, `@@JE short, <task>`, `tidy up long @@JE:4`), use that label verbatim. Do not second-guess it.
2. **Otherwise estimate.** Judge the task from its text and classify it:
   - **short** — a small, self-contained deliverable: a single function/script, a quick fix, a short snippet, a one-file answer. (~tens of lines.)
   - **medium** — a normal feature/refactor/document: a few files or a moderate single file, some real design. This is the **default** when you are unsure.
   - **long** — a heavy build or large writing deliverable: many files, a full module/subsystem, a substantial document, anything you expect to take an agent many turns or minutes.

**Resolve the label to concrete limits** with the bundled helper (one source of truth — do not hand-type the numbers):

```
node <plugin-root>/bin/je-parse.mjs --size <short|medium|long>
```

It prints the full guard set as JSON: `attemptMaxTurns` (GLM), `localMaxTurns`, `minimaxMaxTurns`, `grokMaxTurns`, `attemptTimeoutSecs` (local/MiniMax/base), `glmTimeoutSecs`, `codexTimeoutSecs`, `grokTimeoutSecs`. Pass **every** field through to the Phase 2 workflow args verbatim — each key is exactly the arg name the engine reads, so the values flow into the runners as `JE_MAX_TURNS` / `JE_TIMEOUT_SECS`. Roughly: short tightens the guards (e.g. GLM 15 turns / 180s, codex 300s), medium matches the historical defaults (GLM 30 turns / 300s, codex 600s, with a roomier 1200s GLM wall-clock since z.ai is slow), long loosens them for big work (GLM 50 turns / 600s, GLM wall-clock 2400s, codex/grok 1200s).

Two notes: (a) **native Anthropic attempts are uncapped** — the workflow's `agent()` primitive exposes no turn/time cap, so the size profile only affects the runner-based providers (GLM / local / codex / MiniMax / grok); Anthropic attempts stay bounded by the single-pass brief alone. (b) State the chosen size and its source (override vs estimate) in the Phase 2 confirmation so the user can correct it before any tokens are spent.

## Phase 2: Confirm, then run the first round (both modes)

Before spending tokens, show the plan and get a go-ahead:

- The task, quoted exactly.
- N, the model per attempt, and **which mode** this is (single pass: one round then a final review; two pass: round one, then a guided round two, then a final rank).
- A cost note scaled to the mode:
  - **Single pass:** roughly N independent attempts plus one Opus review.
  - **Two pass:** roughly 2N independent attempts plus two Opus passes (the round one review and the final rank), so token use is about double single pass. Recommend a small N on the first run to gauge usage.
- **The task size and its limit profile** (from Phase 1c): the chosen `short`/`medium`/`long`, whether it came from a manual override or your estimate, and the resulting per-attempt caps. The user can correct the size here before any tokens are spent.

On confirmation, dispatch the whole tournament. **Two dispatch backends exist — prefer dynamic workflows:**

- **Preferred — dynamic workflows.** Invoke the bundled Workflow script `workflows/tournament.mjs` (at the plugin root, i.e. `../../workflows/tournament.mjs` relative to this skill's base dir) via the `Workflow` tool, passing `args` (see `references/orchestration.md` for the exact shape: task, mode, runDir, the per-attempt list, and the runner paths each kind of attempt needs — plus, if the task has **known input files every worker needs** (e.g. "evaluate/summarise/audit these files"), pass them as `contextFiles: [paths]` so the engine bundles them once and every attempt reads the bundle instead of re-reading each file (this avoids the dominant duplicated-Read cost) — `glmRunner` = `<plugin-root>/bin/glm-run.sh` if any attempt is GLM, `localRunner` = `<plugin-root>/bin/local-run.sh` if any attempt is Local, `codexRunner` = `<plugin-root>/bin/codex-run.sh` if any attempt is Codex, the **per-attempt limit args come from the Phase 1c size profile** (`node <plugin-root>/bin/je-parse.mjs --size <short|medium|long>`) — pass every field it prints through verbatim: `attemptMaxTurns` = the agentic-iteration cap for **GLM** runners, `localMaxTurns` / `minimaxMaxTurns` / `grokMaxTurns` = the caps for the other runner providers (the iteration backstop against grinding; the hard-stop brief is the real guard), `attemptTimeoutSecs` = the wall-clock backstop for local/MiniMax/base, `glmTimeoutSecs` = the GLM-only wall-clock (z.ai is slow on heavy code), `codexTimeoutSecs` = the Codex-only wall-clock (codex `exec` has **no** turn cap, so the wall clock is its only per-attempt guard), `grokTimeoutSecs` = the Grok-only wall-clock. If the user gave no size and you did not estimate one, the engine still applies its own built-in medium-ish defaults, but you should always pass an explicit profile so the limits match the task. The workflow runs Phases 2–5 deterministically — parallel attempts, the blind Opus review, and (two pass) round two and the final rank — and you can watch it live in `/workflows`. It returns the structured mapping + rankings you report in Phase 6. This is opt-in orchestration: the harness will show a confirm at first dispatch. **Anthropic attempts run native; GLM attempts run through `joust-glm-*` agents executing `bin/glm-run.sh` (z.ai); Local attempts run through the single `joust-local` agent executing `bin/local-run.sh` (on-device omlx server); Codex attempts run through the single `joust-codex` agent executing `bin/codex-run.sh` (OpenAI `codex exec`).** The Task tool cannot target GLM, local, or codex models directly, and the runner-script indirection is what makes those paths reliable (do not inline the raw nested-`claude`/`codex` command; the wrapper will refuse or shortcut it). The indirection matters most for codex, a fully autonomous external agent most prone to solving/refusing the task itself.
- **Fallback — Task tool + `glm` CLI.** If workflows are unavailable (disabled on the plan, or the user declines), fan out manually per `references/orchestration.md`: Anthropic attempts via the Task tool, GLM attempts via backgrounded `glm` calls, then run the Opus review yourself.

Apply a fresh diversity draw for each round (Phase 1b). The essential rules hold on **either** backend:

- **Identical brief plus one modifier.** Every attempt receives the same task text, differing only by its drawn diversity modifier, so any divergence is attributable to it. No attempt is told it is competing, judged, or which attempt it is.
- **Isolation.** Each attempt gets its own workspace (e.g. `<run-id>/round-1/candidate-<i>/`). Isolated workspaces prevent the race conditions and clobbered files that parallel writes to one location cause.
- **No cross-talk.** Attempts must not see each other's output. Independence is the point.
- **Self-summary.** Each attempt leaves its complete work product in its workspace plus a 2 to 4 sentence note on its approach, tradeoffs, and known limitations.
- **Single-pass exploration, hard stop.** Each attempt writes ONE solution file and stops immediately — no running, testing, rewriting, or polishing. It must NOT "iterate until it works." Refinement is the tournament's job (diverse one-shots → review → in two pass, distilled guidance → a fresh guided round), not any single attempt's. A rough or failed attempt is useful signal for the review/distillation; forcing per-attempt perfection collapses diversity, hides that signal, and explodes runtime — weaker local models especially loop on self-critique ("re-align the art…") and fixing their own bugs until they exhaust their turn cap. So the brief is a *hard* stop (write once, don't run/rewrite), with a per-attempt `--max-turns` backstop and a wall-clock timeout, both sized by the Phase 1c task-size profile (short/medium/long). Require a saved file but not a flawless one; convey this as a working style — never tell an attempt it is one of several or being judged. See `references/orchestration.md`.

If many concurrent requests hit provider rate ceilings, run in smaller parallel batches rather than all at once. (Mixed Anthropic+GLM rounds spread load across two providers, which helps.)

## Phase 3: Blind Opus review

Spin up one **review agent on Opus**. Hand it every first-round work product, labelled Candidate A, B, C, and so on, **without revealing which model produced which**. Following `references/review-rubric.md`, it scores each candidate, lists concrete pros and cons, ranks them, and names the winner with reasoning.

**Then the modes diverge:**

- **Single pass:** Phase 3's named winner **is the result**. Skip Phases 4 and 5 and go straight to Phase 6 to report. (You do not need the round-two guidance lists; the reviewer can omit them in single-pass mode.)
- **Two pass:** the reviewer does the **second job** as well — distil guidance for round two. Across all candidates (not just the winner), produce two short lists phrased generically, with no candidate-specific code:
  - **Positives to consider:** patterns and choices that worked well anywhere in round one.
  - **Challenges to avoid:** pitfalls, bugs, and weaknesses seen anywhere in round one.

  Then **save** the round one winner's work product (the carried-over champion for the final pool) and **discard** the other round one artifacts, keeping only the distilled guidance — not the losing code. Continue to Phase 4.

## Phase 4 (two pass only): Run round 2 with the guidance

Fan out **N fresh sub-agents in parallel** (same isolation and no-cross-talk rules, new workspaces, for example `.../round-2/candidate-<i>/`). Apply a **fresh Pool A draw** for round two (Pool A only, per `references/diversity-injection.md`: the guidance already carries the objective steering, so Pool B lenses would conflict with it). Each gets the identical task **plus** the distilled guidance, framed like this:

> In producing your answer, please consider these items as possible positives: a, b, c, d (the round one positives). And treat these items as challenges to avoid: w, x, y, z (the round one challenges).

Do **not** give round two agents any prior code or the winner's artifact. They get the task and the guidance only, so they produce genuinely new solutions that are merely steered, not seeded. As before, no agent is told it is competing or judged, and each returns its work product plus a short self-summary.

## Phase 5 (two pass only): Final ranking

Build the final pool: the **N fresh round two attempts plus the saved round one winner** (N + 1 candidates). Re-label the whole pool blind (Candidate A, B, C, ...) in a fixed order, keep a private mapping for the report, and spin up one **Opus ranker**. It scores every candidate against the same rubric (`references/review-rubric.md`), lists pros and cons for each, ranks them, and names the overall winner. The carried-over champion competes blind on the merits like everything else: it produced no worse work for not having seen the guidance, and if a guided round two attempt is genuinely better, it should win.

## Phase 6: Report back (both modes)

Present to the user:

1. **The mapping**, unblinded: which model produced each final candidate. In two pass, also mark which one was the round one carried-over winner.
2. **(Two pass only) the round two guidance that was used** (the positives-to-consider and challenges-to-avoid lists), so the user can see what steered the second round.
3. **Per-candidate pros and cons** from the reviewer (single pass) or final ranker (two pass), plus the **ranking and overall winner** with reasoning.
4. **The winning work product itself** (or offer to save it). Offer a merged "best of all" synthesis only if the user asks; the honest comparison is the primary result.

Include brief run metadata: the mode, N, the model per attempt, the diversity modifier each attempt drew (and the seed), and — in two pass — whether the final winner came from round one or round two, plus wall-clock or token figures if the harness surfaced them.

**Provenance check (GLM, Local, Codex, and Grok).** For every GLM attempt, confirm its workspace `_glm_run.log` contains a `JOUST-GLM-PROVENANCE endpoint=api.z.ai` line; for every Local attempt, confirm `_local_run.log` contains `JOUST-LOCAL-PROVENANCE endpoint=127.0.0.1:8000`; for every Codex attempt, confirm `_codex_run.log` contains `JOUST-CODEX-PROVENANCE endpoint=api.openai.com` (and `JOUST-CODEX-DONE exit=0`, no `-TIMEOUT`/`-ERROR`); for every Grok attempt, confirm `_grok_run.log` contains `JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com` (and `JOUST-GROK-DONE exit=0`, no `-TIMEOUT`/`-ERROR`). This is mechanical proof the attempt actually ran on the intended provider, not a wrapper faking it with an Anthropic model. Treat any such candidate with no provenance marker or no saved deliverable as a failed attempt: exclude it and note the failure. Weaker models (especially `glm-4.5-air` and small local models) sometimes fail to save a deliverable, and codex (an autonomous external agent) can refuse, bail without saving, or run to its wall-clock timeout; those are honest failures, not something to paper over. The engine's validator is line-anchored and provider-specific (`^JOUST-<PROV>-…`), so an attempt whose own deliverable merely *mentions* a marker token cannot false-fail its validation.

## Phase 7: Grand-loop driver (Z>=2 only — FAN topology, fail-closed)

Reached only after a successful Phase 0b authorization. The orchestration home is **this SKILL procedure + `bin/je-git.sh`** — there is **no nested grand-loop workflow**, and **`tournament.mjs` is unchanged**. You (the main agent) run the loop; you invoke the `Workflow` tool for the tournament and the `Task` tool for the implementer; `bin/je-git.sh` does every git/gh side effect. Run all git through the helper (`bash <plugin-root>/bin/je-git.sh <fn> ...`), never improvise git/gh yourself.

The driver calls exactly these `je-git.sh` functions: `je_branch`, `preflight`, `detect_verify`, `run_verify`, `commit_and_push`, `open_pr`, `open_pr_needs_human`, `je_compose_body`, `je_append_verify_tail`, `stop_file_check`, `done_marker`, `je_detect_orphan_branch`, and (ASK-FIRST, only after a PR is merged) `je_cleanup`.

Setup once: `base` = the current branch (from preflight). `ledger = []` (cross-loop memory). Detect a *base-tree* verify set once for preflight context: `bash <plugin-root>/bin/je-git.sh detect_verify > <runDir>/_verify_cmds.txt` (empty file ⇒ base tree is unverifiable). **In repo-anchored mode the AUTHORITATIVE verify set is RE-FROZEN per loop from the WINNER'S WORKTREE at gate time** (the winner may have added a test suite the base lacked — plan §9.2): `bash <plugin-root>/bin/je-git.sh detect_verify "<winner-worktree>" > <runDir>/loop-<k>/_verify_cmds.txt`, then pipe THAT file into `run_verify`. An empty per-loop file ⇒ unverifiable ⇒ that loop's PR is draft + needs-human. (`run_verify` still never re-detects on a mutated tree; we freeze once, from the winner's tree, and pipe it in.)

**P6 default-off invariant.** Never export `JE_VERIFY_SANDBOX` for a loop or
session. The first verify call always leaves it unset. Set `JE_VERIFY_SANDBOX=1`
inline for one re-gate only, after 7-AUDIT returned a valid `verdict:"PASS"` for
that candidate's exact diff. The environment flag is routing state, not evidence
that the audit ran; the driver owns this sequencing invariant.

**For each loop `k` in 1..Z:**

1. **STOP-file kill switch (top of every iteration).** `bash <plugin-root>/bin/je-git.sh stop_file_check "<runDir>"` — **rc 0 means a STOP file is present**: halt the chain, report, go to the finally step. (rc 1 = keep going.)
2. **Idempotency / DONE marker.** `bash <plugin-root>/bin/je-git.sh done_marker "<runDir>" <k>` — rc 0 means this loop already completed (its PR exists); **skip it**. Also run `bash <plugin-root>/bin/je-git.sh je_detect_orphan_branch <k>`: if it prints an `JE-<k>-*` branch but the DONE marker is absent, a prior run died mid-loop — **STOP and tell the human to inspect/delete that branch** (detect-and-stop; never auto-resume a half-applied implementer step).
3. **Branch off base (FAN).** `BR=$(bash <plugin-root>/bin/je-git.sh je_branch <k>)` then `git switch "<base>" && git switch -c "$BR"`. (STACK variant: branch off loop k-1's branch instead.) The `JE-` name OVERRIDES the global `rob/` prefix for loop branches only.
4. **Run the tournament (UNCHANGED engine) via the Workflow tool.** Invoke `workflows/tournament.mjs` exactly as in Phase 2, with `runDir: "<runDir>/loop-<k>"` and the task **augmented with the cross-loop ledger** (see below). It returns the structured mapping/ranking; **pick the winning candidate's deliverable path** (its proposal artifact) from `final.mapping`/`round1.mapping`. The proposal must be a concrete, file-level change description (Phase 2 already briefs attempts to produce that).
5. **Implement the winner via the Task tool.** Spawn `Task` with agent `joust-engine:joust-implementer` (model Opus), cwd = `repoRoot`, passing `{ proposal: <winnerProposalPath>, repoRoot: <base repo root>, branch: "$BR", base: "<base>" }`. It makes the smallest coherent change on `$BR`, leaves changes **UNSTAGED**, and returns a 3-6 line summary (its `JE-NOTES.md` captures any ambiguity). Keep that summary as `WINNER_SUMMARY`.

   **Repo-anchored mode (P2 adoption — replaces the implementer hop).** When the tournament ran in repo-anchored mode (`repoMode:true`), the winning attempt's worktree branch `jewt/<runId>/<round>/<winnerLabel>` **already contains the exact, P3-gated commit** — that commit IS the implementation. Do **NOT** spawn the `joust-implementer`, and do **NOT** re-derive code from a text proposal: there is none, and re-deriving would lose the "validated ref == merged ref" property. Instead, after `7-FALLBACK` has selected the adopted candidate `<winnerLabel>`, adopt its branch directly:
   `bash <plugin-root>/bin/je-git.sh adopt_winner_branch "$BR" "<base>" "jewt/<runId>/<round>/<winnerLabel>"`.
   This aliases `$BR` to the winner's EXACT commit (no new commit, no re-author/squash/cherry-pick) and pushes `-u` to the resolved remote. Propagate any nonzero rc and stop. Set `WINNER_SUMMARY` from the winner's `JE-ATTEMPT-NOTES.md` (un-blinded) plus the model name for the PR body.
   **Sequencing in repo-anchored mode (do NOT pre-create `$BR`):** SKIP step 3's `git switch -c "$BR"` — `adopt_winner_branch` *creates* `$BR` from the winner's commit and refuses to clobber a pre-existing branch (its no-clobber guard). Compute `$BR` with `je_branch <k>` (step 3) but do not realize it as a branch until this adoption. **Also SKIP step 7 (`commit_and_push`)**: the adoption already created and pushed `$BR`; running `commit_and_push` afterward would refuse (empty diff / wrong HEAD) and is redundant. Continue at step 8 (open the PR) using `$BR`.

   **Legacy / self-contained mode (`repoMode:false`) is UNCHANGED** — use the `joust-implementer` Task hop exactly as described above (it produces the UNSTAGED diff that step 7's `commit_and_push` then commits).
6. **Verify (fail-closed).** `bash <plugin-root>/bin/je-git.sh run_verify < <runDir>/_verify_cmds.txt > <runDir>/loop-<k>/_verify.log 2>&1`. rc 0 = pass; rc 1 = a command failed (fail-fast, never masked) **or the verify-time-RCE gate refused** (issue #21: the implementer's changes touch a verify-executable file like `Makefile`/`package.json`/`conftest.py` whose body would be executed — those go to human review, never auto-run); rc 2 = no (frozen) commands, run_verify does NOT re-detect on the mutated tree. `run_verify` also drops provider secrets from the verify env and runs commands as argv (no `eval`). Treat rc 1 **and** rc 2 as "verify did not pass" for PR routing below.

   **Repo-anchored gate (P3).** In repo-anchored mode the winner is an UNTRUSTED model's commit, so step 6's `run_verify` is no longer sufficient on its own — it is paired with the security audit (7-AUDIT) and routed by the bounded fallback (7-FALLBACK). Run `run_verify` against the WINNER'S WORKTREE with the per-loop frozen set: `bash <plugin-root>/bin/je-git.sh run_verify < <runDir>/loop-<k>/_verify_cmds.txt > <runDir>/loop-<k>/_verify.log 2>&1`. **Disambiguate the overloaded rc 1**: rc 1 is EITHER a genuine command failure OR the `verify_safe_diff` safety REFUSAL (the winner touched a verify-executable file like `package.json`/`Makefile`/`conftest.py`/a test file). Tell them apart by a STABLE log marker, not by "all nonzero alike" — grep `_verify.log` for `JE-VERIFY-REFUSE-UNSAFE` (emitted by `verify_safe_diff`) or `refusing to run verify on implementer-authored executable changes` (emitted by `run_verify`'s gate branch). If that marker is present, this is a **config-refusal** (route per 7-FALLBACK's config rule); otherwise rc 1/124/2 is a **verify failure** (route per 7-FALLBACK's runner-up rule). Do NOT proceed to commit/PR (existing steps 7–9) until 7-FALLBACK has selected an adopted candidate or decided needs-human+HALT.

   **Repo-anchored sandbox re-gate (P6, only after audit PASS).** The first call above MUST leave `JE_VERIFY_SANDBOX` unset, preserving issue #21's hard refusal. If it is a config-refusal, run 7-AUDIT on that exact candidate diff. Only when the reconciler returns a valid `verdict:"PASS"`, rerun the same frozen commands from the same winner worktree as `JE_VERIFY_SANDBOX=1 bash <plugin-root>/bin/je-git.sh run_verify < <runDir>/loop-<k>/_verify_cmds.txt > <runDir>/loop-<k>/_verify-sandbox.log 2>&1`. Unset `JE_VERIFY_SANDBOX` immediately after that one process (inline assignment does this by construction). rc 0 converts the config-refusal into a verify PASS. Any nonzero rc — including `JE-VERIFY-SANDBOX-UNAVAILABLE` — remains needs-human+HALT. If the audit fails, errors, or is unparseable, do NOT run attacker-authored config and route directly to needs-human+HALT.

   With no `JE_VERIFY_SANDBOX_WRAPPER`, `run_verify` uses the macOS `sandbox-exec` reference profile. Operators on other environments may set `JE_VERIFY_SANDBOX_WRAPPER` inline to an approved container/VM launcher implementing `wrapper -- <argv...>`. Wrapper absence or failure is never permission to retry unsandboxed.
7. **Commit + push.** `bash <plugin-root>/bin/je-git.sh commit_and_push "$BR" "<base>" "JE loop <k>: <WINNER_SUMMARY first line>"`. It refuses unless HEAD is `$BR` and the diff is non-empty, then pushes `-u` to the resolved remote. Propagate any nonzero rc (stop with the message).
8. **Open the PR.** Compose a body file in a portable temp file, then:
   - **verify passed (rc 0):** `BODY=$(mktemp); bash <plugin-root>/bin/je-git.sh je_compose_body "$BODY" <<'EOF' ...PR template (Task, tournament, winner, topology, verify result, ledger siblings, run dir, WINNER_SUMMARY)... EOF`; `bash <plugin-root>/bin/je-git.sh open_pr "$BR" "<base>" "JE loop <k>: <summary>" "$BODY"`.
   - **verify failed/unverifiable (rc 1 or 2):** compose the same body, then `bash <plugin-root>/bin/je-git.sh je_append_verify_tail "$BODY" "<runDir>/loop-<k>/_verify.log"` (caps the output so a huge log can't blow the PR limit), then `bash <plugin-root>/bin/je-git.sh open_pr_needs_human "$BR" "<base>" "[needs-human] JE loop <k>" "$BODY"` (draft + `needs-human`, with a label-less draft fallback). **Then HALT the whole chain** (fail-closed default; STACK always halts). NEVER auto-merge, ever.
9. **DONE marker (only after the PR is created).** `bash <plugin-root>/bin/je-git.sh done_marker "<runDir>" <k> write`. A re-run will now skip loop k.
10. **Append to the ledger:** `{ loop: k, winner_summary: <WINNER_SUMMARY>, pr_url: <url> }`.

**7-AUDIT — nested @@JE security audit of the winner's diff (fail-closed, run AFTER un-blinding).** The winner is now an untrusted actor's mergeable commit; this audit is the ONLY security review before a human sees the change. Run it as a **SIBLING `Workflow(tournament.mjs)` call** (NOT nested — `tournament.mjs` is unchanged and the driver is the main agent, so the one-level limit does not apply), supplying `args.assignment` directly to bypass the interactive gate exactly as the main tournament does in a grand loop:

- `task` = `"Security-audit this diff. Report every vulnerability, injected-execution path, credential/secret risk, and supply-chain/build-config risk you find, each with a severity (low|medium|high|critical) and concrete evidence (file + why). This is the only safety review before a human sees this change; if unsure, flag it."`
- `assignment` = `[opus, glm-5.2]` (the documented Top-Mixed N=2 case; two independent auditors).
- `contextFiles` = `[ <winner's candidate.diff> ]` — the EXACT gated diff (the same artifact the blind judge ranked), bundled once via the existing `contextFiles` path so both auditors read the identical bytes.
- `runDir` = `<runDir>/loop-<k>/_audit`.

**Synthesis is UNION-OF-FINDINGS via a DEDICATED Opus reconciler — NOT the competitive judge.** The competitive ranker picks one auditor and discards the other, which would DROP real findings (if Opus catches an injection and GLM catches a secret leak, ranking keeps one). So after both audits return, spawn ONE Opus `Task` (the *reconciler*, explicitly not the ranker) with this prompt and schema:

> You are a security-audit RECONCILER, not a judge. You are given N independent security audits of ONE code diff. Do NOT pick a "best" audit and do NOT rank the auditors. Instead, produce the UNION of their findings: merge all findings, de-duplicate findings that describe the same underlying issue (same file + same root cause), and for each merged finding assign the MAXIMUM severity any auditor gave it. Then decide one overall verdict. Output ONLY a single JSON object, no prose, exactly this schema:
> ```json
> { "findings": [ { "title": "<short>", "severity": "low|medium|high|critical", "evidence": "<file + why>" } ],
>   "verdict": "PASS" | "FAIL",
>   "reason": "<one line>" }
> ```
> RULES: verdict MUST be "FAIL" if ANY finding has severity "high" or "critical"; otherwise "PASS". If you cannot parse an input audit or are unsure, INCLUDE a finding for it at severity "high" (fail-closed). Emit valid JSON only.
>
> **Fail-closed wiring:** the audit's `verdict` is **ANDed** with `run_verify` to form the gate result. `verdict:"FAIL"` ⇒ **gate FAIL**. An audit that ERRORS (a sibling-Workflow `__failed`, a reconciler that errors, or reconciler output that does not parse as the schema above) is ALSO a **gate FAIL** — never "audit unavailable, proceed". Carry the reconciler's `findings` forward verbatim for the PR body (transparency).

**7-FALLBACK — bounded gate-failure fallback (plan §9.2).** Define `gate(candidate)` = (the default-off `run_verify` returns rc 0, OR it returned config-refusal and the same candidate subsequently returns rc 0 from the P6 sandbox re-gate) **AND** (7-AUDIT on that candidate's exact diff returns `verdict:"PASS"` with no audit error). The sandbox alternative is valid only in the order default refusal → audit PASS → inline sandbox re-gate. Then, after un-blinding, using the final ranking from Phase 5/3:

1. **Gate ranked #1.** If `gate(#1)` passes → adopt #1 (proceed to existing steps 7–9; in repo-anchored mode adoption is the P2 `adopt_winner_branch` path). Done.
2. **#1 failed → bounded fall to ranked #2.** EXCEPTION — if #1's initial failure was the **config-refusal** (`JE-VERIFY-REFUSE-UNSAFE`): run 7-AUDIT first. Audit PASS → perform the P6 sandbox re-gate; rc 0 adopts #1, while sandbox failure/unavailability goes straight to step 4. Audit FAIL/error/unparseable also goes straight to step 4 without executing config. Do NOT try the runner-up for this exception (it will likely touch the same config, wasting the bounded fallback). Otherwise (a genuine verify failure OR an audit FAIL/error on a non-config diff), gate ranked **#2** the same way.
3. **#2 passed → adopt #2 and ANNOTATE.** Adopt #2 and add a clear PR note: "ranked #1 (<model, un-blinded>) FAILED the validation gate (<verify-fail | audit-FAIL: \<top finding\>>); adopted ranked #2 (<model>) which passed." Full transparency. Done.
4. **#2 also failed, OR there is no #2, OR config-refusal was not both audit-cleared and sandbox-verified:** **needs-human + HALT.** Compose a draft PR off the #1 winner's branch: `bash <plugin-root>/bin/je-git.sh je_append_verify_tail "$BODY" "<runDir>/loop-<k>/_verify.log"` for the default verify tail, append `_verify-sandbox.log` when a sandbox re-gate was attempted, plus the reconciler `findings` JSON, then `open_pr_needs_human` (draft + `needs-human`, label-less fallback as today). Include the §8.3 note: "this change edits executable build/test config; audit clearance and an available sandbox are both required." Then **HALT the whole chain** (fail-closed; matches the existing step-8 HALT contract). NEVER auto-merge.

The fallback is **bounded to depth 1** (try at most #1 then #2). Falling further would silently merge a low-ranked candidate just because it passed, defeating the tournament's quality signal — so beyond #2 it is always needs-human + HALT.

**Cross-loop ledger (FAN memory).** Because every FAN loop re-attacks the same `base`, augment loop k's task with what prior loops already proposed so loop k explores something different:

```
Prior grand loops on this same repository already proposed and implemented (on separate branches):
- loop 1: <winner_summary 1>
- loop 2: <winner_summary 2>
Propose a DIFFERENT, additive improvement that does not duplicate the above. If the repository is
already in good shape, say so explicitly rather than inventing a marginal change.
```

**Finally (always):** `git switch "<base>"` so the user ends on the branch they started on. **Report** every loop: its JE- branch, PR url (and whether it is a normal or draft/needs-human PR), the winning model, the verify result, and the stop reason if the chain halted early.

**Post-merge disk reclaim (ADDITIVE, ASK-FIRST — never auto-delete).** A grand loop leaves local scratch behind: the per-run parallel-attempt workspaces under `<plugin-root>/.runs/<run-id>/`, plus (in repo-anchored mode) `jewt/*` worktrees and the `JE-<loop>-<suffix>` branches. This is reclaimable ONLY once a loop's PR has been **merged** — an unmerged/open PR's branch is still live work. So reclaim is gated on a human yes in BOTH directions:
- **Trigger.** Run cleanup ONLY when **(a)** the user explicitly asks to reclaim disk, OR **(b)** AFTER you observe a loop's PR has been **merged** (e.g. `gh pr view <url> --json state,mergedAt` shows merged) and you then **PROMPT the user** — "Loop `<k>`'s PR is merged; reclaim its local Joust Engine scratch (worktrees + merged JE- branch + `.runs/<run-id>`)? [y/N]". Do **NOT** run cleanup for a loop whose PR is open, draft, or needs-human — that branch may still be merged later.
- **Always dry-run first.** `bash <plugin-root>/bin/je-git.sh je_cleanup "<base>" "<plugin-root>/.runs"` LISTS exactly what would be removed (each `jewt/*` worktree, each MERGED `JE-*` branch, each `.runs/<run-id>` dir) and the total bytes — and **deletes nothing**. Show the user this inventory.
- **Apply ONLY on an explicit yes.** Only after the user answers yes, run `bash <plugin-root>/bin/je-git.sh je_cleanup --apply "<base>" "<plugin-root>/.runs"` (or spawn the `joust-engine:joust-cleanup` agent with `apply:true`). `je_cleanup` **defaults to dry-run**, so nothing is ever destroyed without that explicit `--apply`. It removes `jewt/*` worktrees (`git worktree remove --force` + `prune`), deletes MERGED `JE-*` branches with the merged-only `git branch -d` (which **refuses** an unmerged branch — in-flight work is never lost), and `rm -rf`s each `.runs/<run-id>` dir. It touches ONLY JE-owned artifacts: never the main checkout, the base branch, a non-JE branch, or any non-JE file.

## Quick reference

| Step | Single pass | Two pass |
|------|-------------|----------|
| Trigger | `@@JE[:N][:M[:Z]]` / `joust:N[:M[:Z]]` — N optional (prose spec / Top Mixed can supply it) | same, `:2` = two pass |
| Phase 0 | parse task, N, mode | parse task, N, mode |
| Phase 1 | model gate (mandatory stop) | model gate (mandatory stop) |
| Phase 1b | diversity injection (default on) | diversity injection (default on) |
| Phase 1c | size limits: override (`short`/`medium`/`long`) else estimate | same |
| Phase 2 | confirm + run N attempts | confirm + run N attempts |
| Phase 3 | blind Opus review → rank → winner = result | blind Opus review → rank + distil guidance; save winner, discard rest |
| Phase 4 | — | N fresh attempts given task + guidance, no prior code |
| Phase 5 | — | final pool = N round-2 + 1 saved winner; blind Opus rank |
| Phase 6 | report | report (+ guidance used, winner's round) |
| Phase 7 | — (Z=1: not used) | grand-loop driver (Z>=2): preflight → authorize (re-type Z) → per loop: STOP-check → branch off base → tournament → implement → verify → commit/push → PR → ledger; finally switch back to base |

- Trigger: sigil `@@JE[:N][:M[:Z]]` (e.g. `@@JE:5`, `@@JE:7:2`, bare `@@JE`) or prose `joust:N[:M[:Z]]`. N optional — inferable from a prose model spec (`2 opus, 2 glm 5.2, 1 codex high` → N=5, `[opus,opus,glm-5.2,glm-5.2,codex-high]`) or the Top Mixed preset (`top mixed` + N → even split over opus/glm-5.2/codex-high). M = passes (omit/1 single, 2 two). Z = grand loops (Z=1/omitted = today's isolated tournament; Z>=2 = unattended chain — per loop: tournament → implement winner on a new JE-<loop>-<random7> branch (Opus implementer) → fail-closed verify → one PR (draft+needs-human on failure, then HALT), never auto-merged; Z capped at Z_MAX=5, Z>5 refused). JE- branch naming OVERRIDES the global rob/ prefix for loop branches only. All git/gh lives in bin/je-git.sh; tournament.mjs is unchanged; there is no nested workflow. Bare `@@JE` → interactive gate. Case-insensitive, optional spaces; text before the marker is the task. Phase 0 runs `bin/je-parse.mjs` for all of this.
- Dispatch: prefer the bundled `Workflow` script `workflows/tournament.mjs` (live in `/workflows`); Anthropic attempts native, GLM/Local/Codex/MiniMax/Grok attempts via the `joust-glm-*` / `joust-local` / `joust-codex` / `joust-minimax` / `joust-grok` wrapper agents. Fallback: Task tool + `glm` CLI. See `references/orchestration.md`.
- N is per round, an integer of 2 or more. Confirm volume at N ≥ 8 (single pass) or N ≥ 6 (two pass).
- Phase 1 model question: ten options (Top Mixed, Specify Mix, Opus, Sonnet, Haiku, GLM→submenu, Local→live submenu, Codex→effort submenu, MiniMax, Grok→variant submenu); a Phase-0 prose spec or Top Mixed keyword answers it and the menu is skipped; N defaults 6, passes default 2. GLM drills down to one of glm-5.2/glm-5.1/glm-4.7/glm-4.5-air; Local lists `omlx-models` live (dynamic); Codex is gpt-5.5 with a reasoning-effort submenu (codex-low/medium/high/xhigh); Grok drills down to grok-build/grok-composer-2.5-fast; Specify Mix loops per attempt over Anthropic + GLM + local + codex + minimax-m3 + grok ids; in two pass the assignment applies to both rounds. Anthropic attempts dispatch via the Task tool, GLM via the `glm`→z.ai runner, Local via the `omlx`→on-device runner, Codex via the `codex exec` runner, MiniMax via the `bin/minimax-run.sh` runner, Grok via the `grok`→xAI runner. Reviewer/ranker are always Anthropic Opus.
- Diversity injection (default on): each attempt draws a distinct framing so siblings do not converge. Pool A approach nudges by default (blind-safe); Pool B objective lenses opt-in. Without replacement, seeded, logged. See `references/diversity-injection.md`.
- Dynamic limits (Phase 1c): per-attempt turn caps + wall-clock timeouts scale to task size (`short`/`medium`/`long`). The parser's `size` field is a manual override (marker-adjacent `@@JE:5 long`); otherwise the orchestrator estimates. Resolve the numbers with `bin/je-parse.mjs --size <label>` (one source of truth: `SIZE_PROFILES`) and pass them into the Phase 2 workflow args (`attemptMaxTurns`, `localMaxTurns`, `minimaxMaxTurns`, `grokMaxTurns`, `attemptTimeoutSecs`, `glmTimeoutSecs`, `codexTimeoutSecs`, `grokTimeoutSecs`). They flow to the runners as `JE_MAX_TURNS`/`JE_TIMEOUT_SECS`; native Anthropic attempts are uncapped.
- Round attempts: N parallel, isolated, identical brief plus one diversity modifier, no cross-talk.
- Review/rank (Opus, blind): pros and cons per candidate, rank, name winner. In two pass also distil positives-to-consider and challenges-to-avoid, save the winner, discard the other artifacts.
- Dispatch mechanics and the round two brief template: `references/orchestration.md`.
- Scoring and distillation rubric: `references/review-rubric.md`.
- Grand loops (Z>=2): Phase 0b front-loads ONE autonomy authorization (re-type Z) covering all loops; a `<runDir>/STOP` file is the between-loops kill switch; FAN topology (independent PRs off base) + a cross-loop ledger by default, STACK opt-in (forces halt-on-failure); fail-closed auto-detected verify; per-loop DONE markers for idempotency; non-implementable tasks are offered Z=1 instead. See Phase 7 and `references/orchestration.md`.
- Dogfood backlog (GitHub Issues): problems found while running tournaments are filed as GitHub issues labelled `dogfood` via the bundled `bin/je-issue.sh` (the only forge-touching part; the engine stays forge-agnostic). File with `bin/je-issue.sh new --sev sevN --area <area> --title "…" --evidence-file EV.md` — always paste a verbatim verdict/guidance excerpt (still required triage content; PUBLIC repo, so never paste secrets or the `mapping.json` unblinding line — say "blind B", not the model). A `@@JE` "dogfood run" picks the top open item (`bin/je-issue.sh next`), claims it best-effort (`claim N run-id`; the gh API has no compare-and-swap, so a git-ref push under `refs/dogfood-claims/` is the strict escape hatch), fixes it on a `rob/dogfood-N` branch, and opens one PR with `Closes #N`. No `gh`/offline → the helper degrades to a committed `docs/dogfood/inbox/` draft (never `.runs/`). Historical `D-NNNN` items were imported as closed `dogfood` issues (full evidence in each body); there is no in-repo backlog/archive anymore. Full rules: `references/dogfood.md`.
