# Joust Engine

> *Model-diverse agentic coding tournaments taking concept to PR.*
>
> 🌐 **[joustengine.ai](https://joustengine.ai)** — *site coming soon*

**Joust Engine is a Claude Code plugin that runs best-of-N tournaments.** You hand it a task; it produces N independent attempts in parallel, then a *blind* **6-judge council** scores them, votes once, and names a winner — a deterministic majority tally in code (councils never deliberate; ties are settled by a steelman-improvement shootout), never an LLM "summarising the consensus". The attempts can come from any mix of providers (Anthropic, GLM, on-device MLX, OpenAI Codex, MiniMax, xAI Grok); the judge panel is held fixed (Opus anchor seats + codex-xhigh cross-family seats) so the comparison stays honest.

```text
@@JE:5  Build a CLI that flattens nested JSON to dotted keys.
```

That one line triggers the loop: it asks which model(s) to run the 5 attempts on, you answer, it fans out 5 isolated workers, and the blind council crowns a winner. Add `:2` for the full two-round plan phase, `implement` for the implementation rounds, or a `:Z` for grand loops (an unattended chain that implements each winner into a real branch and opens a PR).

---

## Contents

- [The core idea](#the-core-idea)
- [The rounds: plan, then implement](#the-rounds-plan-then-implement)
- [The judging council](#the-judging-council)
- [Invoking it: the sigil and prose forms](#invoking-it-the-sigil-and-prose-forms)
  - [The `@@JE` sigil](#the-je-sigil)
  - [Task size (dynamic limits)](#task-size-dynamic-limits)
  - [Prose model spec](#prose-model-spec)
  - [Mixed and Top Mixed presets](#mixed-and-top-mixed-presets)
  - [Worked examples](#worked-examples)
  - [The slash-command form](#the-slash-command-form)
- [Model providers](#model-providers)
- [Diversity injection](#diversity-injection-pool-a--pool-b)
- [Grand loops (`Z >= 2`)](#grand-loops-z--2)
- [The dogfood backlog](#the-dogfood-backlog)
- [Installation & setup](#installation--setup)
- [The benchmarking system (`je-bench`)](#the-benchmarking-system-je-bench)
- [Repository layout](#repository-layout)
- [Honest limitations](#honest-limitations)

---

## The core idea

A single LLM attempt at a task is one sample from a noisy distribution. The Joust Engine spends tokens to do better than one sample, in two specific ways:

1. **Generate, don't iterate.** Run **N attempts in parallel**, each a *single-pass exploration* — every attempt writes its solution **once and stops**. No attempt is told it's competing or being judged; none sees another's work. The refinement happens at the *tournament* level (many diverse one-shots → review), never inside a single attempt grinding "until it works." A rough or even failed attempt is useful signal, not a wasted slot.

2. **Judge blind, with fixed strong judges.** A blind **judging council** (six seats; see below) receives the deliverables labelled `Candidate A`, `B`, `C`, … with **no model identities attached**. Each judge reads (and where feasible runs) each one, scores it through its lens, lists concrete pros and cons, ranks them, and casts a first-place vote; code tallies the majority. Because the judges never learn which model produced which candidate, a cheap model can win on merit — and the engine takes mechanical steps (below) to keep that blindness real.

The attempts are deliberately *diverse*: different model families, sampling stochasticity, and a per-attempt framing nudge ([diversity injection](#diversity-injection-pool-a--pool-b)) all push the N solutions apart so the review has genuinely different things to compare.

---

## The rounds: plan, then implement

The tournament is a **cheap, wide planning phase** (always) followed by an **optional, narrow implementation phase** — high-N diversity where artifacts are cheap to produce and judge, a small strong pool where they are expensive (`docs/superpowers/specs/2026-07-03-plan-implement-rounds-design.md`):

| Round | Runs | What happens | Pool default |
|---|---|---|---|
| **Plan Round 1** | always | N parallel, isolated attempts each produce a **design brief** (≤10 bullets: approach, surfaces, risks, testable acceptance criteria — never code or diffs), one diversity nudge each → the blind plan-lens council reviews, votes a round-1 winner, **and distils guidance** | wide + diverse: `2 opus, 2 sonnet, 2 codex-high, 2 glm-5.2, 2 minimax` (N=10) |
| **Plan Round 2** | always (two-pass; `:1` stops after Round 1) | winner's brief **saved**, every other artifact discarded; N **fresh** attempts get the task + guidance (never round-1 content); final pool = N + the carried winner, re-labelled blind → the council ranks and elects the **winning design brief** | same pool, fresh nudges |
| **Implement Round 3** | only with the `implement` keyword | M implementers are each seeded with the **winning design brief** (a deliberate exception to "never seed prior artifacts" — the brief is the spec: approach + acceptance criteria, implementation details are theirs); the blind **code-lens council** judges with verify/build/lint evidence folded in, and a deterministic **gate** must pass | small + strong: `2 opus, 2 sonnet, 1 codex-high, 1 glm-5.2` (M=6) |
| **Implement Round 4** | **only** if Round 3 yields no gate-passing candidate (no council majority, all vetoed, or verify failure) | M fresh implementers, guided by the R3 review; still no consensus → **needs-human**, never a silently-picked winner | same pool |

```text
PLAN (always)
  task ──▶ [N plan attempts] ──▶ plan council ──┬▶ distil guidance ─┐
                                                └▶ save winner ──┐  │
                                                                 │  ▼
           [N fresh plan attempts + guidance] ◀──────────────────┼──┘
                             │                                   │
                             ▼                                   │
           final plan pool = N round-2 + saved winner ◀──────────┘
                             │
                             ▼
                  plan council rank ──▶ WINNING BRIEF ✓       (no implement flag → done)

IMPLEMENT (only with the `implement` keyword)
  winning brief ──▶ [M implementers, brief seeded] ──▶ code council + gate ──▶ winner ✓
                                                                    │ gate fails
                                                                    ▼
                   [M fresh implementers + R3 guidance] ──▶ code council + gate ──▶ winner ✓ / needs-human
```

The distilled guidance is two short lists — *positives to consider* and *challenges to avoid* — phrased as generic principles, each tagged `[strong]` (held up repeatedly) or `[tentative]` (a single sighting), with no candidate-specific content.

**Why round 2 discards the losing plans but keeps the lessons:** re-using a winner's content would make round 2 copy it and collapse the diversity that makes the loop work. Re-using the *distilled* pros and cons keeps diversity while raising the floor. The carried round-1 champion competes blind in the final pool on the merits — if a guided round-2 plan is genuinely better, it wins.

Three guard rails: a plan-phase `NO_CONSENSUS` stops the run **before any implementation spend** (the split is surfaced for you to resolve); the R3→R4 fallback is **bounded** (one retry, then needs-human); and phase-scoped prose specs pick the pools inline — `Plan: 2 opus, 2 sonnet, 1 glm 5.2 Implement: 2 opus, 1 codex high implement @@JE:5:2` — with the `implement` keyword recognised only marker-adjacent, so prose like "implement a CSV parser" never false-triggers rounds 3–4.

Cost scales with what you enable: plan-only two pass ≈ 2N attempts + 2 council judging points; `implement` adds M (+M on an R4 retry) and a third judging point. The skill confirms volume before spending at `N ≥ 8` (single pass) or `N ≥ 6` (two pass).

---

## The judging council

Every judging point (the round-1 review and the final rank) is, by default, a **council of six blind judges** — five lenses (**correctness/verification** (runs the code, cites real exit codes), **spec-compliance**, **security** (holds the veto), **robustness/edge-cases**, **craft/efficiency**) plus **security-x**, a second cross-family security gate. The completeness-class and simplicity-class seats and security-x run on **codex-xhigh** (a different model family from the models that author most attempts); the security veto and the verification-heavy lenses are always Anthropic Opus. All six are blind to model identities and must ground every verdict in a required `checks_run` evidence list.

- **The vote is independent, and councils never deliberate (judging-v3)** — no judge sees a peer. The tally runs **in code**: **>50% of living judges' first-place votes** on a candidate neither security gate has flagged `UNSAFE` (high/critical severity **with concrete evidence** — a union veto).
- **Intermediate reviews fast-tally**: a majority carries one champion into the final pool; a split carries the **top two** non-vetoed. Nothing deliberates; the round's learning goes into the round-2 guidance.
- **Final decision points run the steelman shootout**: the vote seeds the top-2 finalists, a non-voting steelman distils the judges' cons into minimal change-lists, each finalist is boosted on a copy (validation-gated), and a **cold blind re-judge** (fresh letters, no history) votes again — tie → iterate (max 5) → the orchestrator casts the deciding vote between the two gated finalists. The winner ships with its improvements applied.
- **All finalists vetoed → `NO_CONSENSUS`** — surfaced to you (or needs-human + HALT in a grand loop). It is never silently resolved by a score average, Borda, or a meta-judge, and a vetoed candidate can never be picked.
- A **verdict-integrity guard** rejects schema-valid-but-junk verdicts (placeholder reasoning, collapsed pros/cons, vacuous veto evidence) at every choke point, so a degenerate judge output dies and retries instead of steering the run.
- `judges: 1` restores the legacy single blind Opus judge (cheap runs); `dualSecurity: false` drops only the security-x seat; `judgeMix: 'anthropic'` forces every seat native Opus.

The design follows the LLM-as-judge research in [issue #22](https://github.com/robanderson/joust-engine/issues/22) and `docs/superpowers/specs/2026-07-02-judge-council-design.md`: diverse lenses over one generalist, independent votes before cross-talk, aggregation in code, evidence-forcing, and fail-closed no-consensus routing.

---

## Invoking it: the sigil and prose forms

Put a trigger anywhere in your message; **the text before it is the task**. All forms are case-insensitive with optional spaces around the colons. Phase 0 of the skill runs a bundled parser (`bin/je-parse.mjs`) on your raw message — it does **not** hand-parse the sigil — and acts on the JSON it returns.

> Write the trigger **literally**, unquoted. `@@JE:5` is correct; don't wrap it in shell quotes.

### The `@@JE` sigil

```text
@@JE[:N][:M[:Z]]
```

| Field | Meaning | Default | Constraints |
|---|---|---|---|
| **N** | attempts per round | none (asks, or inferred) | integer ≥ 2 |
| **M** | passes | **1** (single pass) | `1` or `2`; any other value is an error |
| **Z** | grand loops | **1** (isolated tournament) | integer `1..5`; `Z > 5` is **refused** (split into batches) |

- `@@JE:5` → 5 attempts, single pass.
- `@@JE:5:2` → 5 attempts, two pass.
- `@@JE:5:2:3` → 5 attempts, two pass, **3 grand loops**.
- `@@JE` (bare) → falls back to the interactive model gate (it asks N and the model).

**Positional skips are forbidden.** `@@JE:5::3` is invalid — to set Z with a default M, write `@@JE:5:1:3`. (`Z=1` and omitting Z are byte-identical: today's isolated tournament.)

There is also a **prose marker** that extends identically: `joust:N[:M[:Z]]` — e.g. `do abc :joust:5` (single) or `do abc: joust:5:2` (two pass).

### Task size (dynamic limits)

The per-attempt **turn caps and wall-clock timeouts** scale to how big the task is, instead of being fixed. By default the orchestrator **estimates** the task as `short`, `medium`, or `long` (Phase 1c) and sizes the limits to match — a quick script gets tight guards, a heavy multi-file build gets generous ones.

You can **override** the estimate by listing one of `short` / `medium` / `long` next to the marker:

```text
@@JE:5 long          Refactor the whole rendering pipeline.
@@JE short, fix the off-by-one in the paginator
tidy up the imports long @@JE:4
```

The size word is recognised **only adjacent to the marker** and is stripped from the task (the after-marker form needs a comma/semicolon/end right after it), so an ordinary size word in the task body — `build a short-circuit evaluator`, `long division solver` — is left untouched. The numbers live in one place: `SIZE_PROFILES` in `bin/je-parse.mjs` (printable with `node bin/je-parse.mjs --size <label>`). They flow to the runner-based providers (GLM / local / codex / MiniMax / grok) as `JE_MAX_TURNS` / `JE_TIMEOUT_SECS`; native Anthropic attempts are uncapped.

### Prose model spec

You can describe the fleet in prose **instead of** giving an explicit N. A comma- or `and`-separated list of `<count> <model>` items anywhere in the message becomes the per-attempt assignment; **the sum of the counts is N**, and the spec text is stripped from the task:

```text
@@JE two passes, 4 opus, 2 sonnet, 2 codex high, 2 glm 4.7, 2 minimax  Refactor the auth module.
```

Counts: `4 + 2 + 2 + 2 + 2 = 12`, so **N = 12** with the per-attempt assignment
`[opus×4, sonnet×2, codex-high×2, glm-4.7×2, minimax-m3×2]`, run as **two pass** (the phrase "two passes" sets M=2). Because the spec already answers "which models," the interactive model menu is **skipped**.

A spec is recognised as `<count> <model>` items only; an ordinary `<digit> <noun>` in the task (e.g. "fix 3 bugs") is **not** a spec. If a model token isn't recognised the parser **stops and asks** rather than silently dropping it (a dropped token would change N).

### Mixed and Top Mixed presets

- **Mixed (Specify Mix):** choose a concrete model for **each** attempt, one at a time. A prose spec *is* a Mixed assignment.
- **Top Mixed:** the keyword `top mixed` (also `top-mix` / `top mix`) plus an N spreads N **as evenly as possible across `[opus, glm-5.2, codex-high]`**, remainder priority `opus > glm-5.2 > codex-high` (and `N=2` → `[opus, glm-5.2]`). N can come from the sigil or a leading count.

```text
@@JE:6 top mixed  Design a rate-limiter.
```

N = 6 over three buckets → 2 each → `[opus, opus, glm-5.2, glm-5.2, codex-high, codex-high]`.

```text
@@JE:5 top mixed  ...
```

N = 5 → base 1 each (3), remainder 2 by priority → opus +1, glm-5.2 +1 → `[opus, opus, glm-5.2, glm-5.2, codex-high]`.

### Worked examples

| Invocation | N | Mode | Z | Assignment / behaviour |
|---|---|---|---|---|
| `@@JE:4` | 4 | single | 1 | asks the model gate, then 4 attempts |
| `@@JE:5:2` | 5 | two | 1 | 5 attempts/round, guided round 2, final rank |
| `@@JE` | gate | gate | 1 | bare → interactive gate (N defaults to 6, passes to 2 *in the gate*) |
| `@@JE:6 top mixed` | 6 | single | 1 | `[opus, opus, glm-5.2, glm-5.2, codex-high, codex-high]` |
| `@@JE 2 opus, 2 glm 5.2, 1 codex high` | 5 | single | 1 | `[opus, opus, glm-5.2, glm-5.2, codex-high]` (N inferred from the spec) |
| `@@JE two passes, 4 opus, 2 sonnet, 2 codex high, 2 glm 4.7, 2 minimax` | 12 | two | 1 | `[opus×4, sonnet×2, codex-high×2, glm-4.7×2, minimax-m3×2]` |
| `@@JE:5:2:3` | 5 | two | 3 | grand-loop chain (authorization + per-loop PR) |
| `joust:7:2` | 7 | two | 1 | prose marker, same as `@@JE:7:2` |
| `/joust-engine:joust-engine @@JE:5 …` | 5 | single | 1 | [slash command](#the-slash-command-form); `@@JE:5` supplied as the arguments |
| `/joust-engine:joust-engine 2 opus, 2 glm 5.2, …` | 4 | single | 1 | [slash command](#the-slash-command-form); prose spec → `[opus, opus, glm-5.2, glm-5.2]` (N inferred) |
| `/joust-engine:joust-engine <bare task>` | gate | gate | 1 | [slash command](#the-slash-command-form); no sigil/spec → interactive gate, same as bare `@@JE` |

> **Note the two different defaults.** When `@@JE` has **no N and no spec**, the parser returns `needsGate` — control passes to the interactive gate, where **N defaults to 6 and passes to 2**. That gate default is *not* the grammar default: an explicit `@@JE:5` (no M) is single pass, because the sigil's M defaults to **1**. Don't conflate the gate's "passes default to 2" with the sigil's "M defaults to 1."

If you describe a generate-and-rank tournament in plain English with no marker at all, the skill can still infer single vs two pass and ask for N and the model.

### The slash-command form

The plugin also ships its triggers as **Claude Code slash commands**, so you can launch a tournament without writing a sigil at all. There are two:

```text
/joust-engine:joust-engine   ...      runs a tournament
/joust-engine:joust-bench    ...      runs the throughput benchmark (see je-bench, below)
```

The canonical name is `/<plugin>:<skill>`; here the plugin and the tournament skill are both named `joust-engine`, hence the doubled `/joust-engine:joust-engine`.

**Whatever you type after the slash command is the arguments**, and Phase 0 feeds those arguments **verbatim** into the same `bin/je-parse.mjs` it would run on the body of an `@@JE` / `joust:` message. So the slash command is just a **different entry point into the same parser and the same skill** — it adds **no new flags** and changes **no behaviour**. Everything documented above (N, mode `M`, grand loops `Z`, task size, prose model specs, Top Mixed) works identically as slash-command arguments. You can even supply an explicit sigil in the arguments if you like:

```text
/joust-engine:joust-engine @@JE:5 Build a CLI that flattens nested JSON.
/joust-engine:joust-engine 2 opus, 2 glm 5.2, Refactor the auth module.
/joust-engine:joust-engine Design a rate-limiter.
```

- The **first** form passes an explicit `@@JE:5` as the arguments → 5 attempts, single pass.
- The **second** is a prose model spec → N is inferred from the counts (`2 + 2 = 4`, `[opus, opus, glm-5.2, glm-5.2]`); no sigil needed.
- The **third** is a bare task with no sigil and no spec → it falls back to the interactive model gate (where N defaults to 6 and passes to 2), exactly as a bare `@@JE` would.

> **Don't confuse this with the install commands.** `/plugin marketplace add …` and `/plugin install …` (see [Installation & setup](#installation--setup)) are Claude Code's built-in commands for *adding* the plugin. `/joust-engine:joust-engine` and `/joust-engine:joust-bench` are the engine's own commands for *invoking* it once it's installed.

---

## Model providers

Attempts can run on six providers. The **judge panel is held fixed** (the 6-seat council anchored on Anthropic Opus — the security veto and verification-heavy lenses are always Opus, three seats run codex-xhigh — or the `judges:1` single Opus judge) so scoring stays consistent across attempts and rounds. Each non-Anthropic provider runs through a bundled runner script invoked by a thin command-runner agent (see [layout](#repository-layout)); this indirection is what makes those paths reliable.

| Provider | Models (selectable axis) | Dispatch | Auth (from the **environment**) |
|---|---|---|---|
| **Anthropic** | `opus` · `sonnet` · `haiku` | Task tool, native in-process | the session's own Claude auth (no extra key) |
| **GLM (z.ai)** | `glm-5.2` · `glm-5.1` · `glm-4.7` · `glm-4.5-air` | `claude` pointed at z.ai via `bin/glm-run.sh` | `ZAI_API_KEY` |
| **Local MLX** | dynamic on-device list (via the `omlx` server) | `claude` pointed at `http://127.0.0.1:8000` via `bin/local-run.sh` | `OMLX_AUTH_TOKEN` |
| **Codex (OpenAI)** | `gpt-5.5`, axis = reasoning effort: `codex-low/medium/high/xhigh` | `codex exec` via `bin/codex-run.sh` | `~/.codex/auth.json` (no env var) |
| **MiniMax** | `MiniMax-M3` (the only model) | `claude` pointed at the MiniMax endpoint via `bin/minimax-run.sh` | `MINIMAX_API_KEY` |

A few provider specifics worth knowing:

- **Anthropic** model aliases map to API strings `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5`.
- **GLM** is the `claude` CLI pointed at z.ai's Anthropic-compatible endpoint. The selection maps through `glm`'s `--model` flag, which is **not** the GLM name: `glm-5.2 → --model opus`, `glm-5.1 → --model glm-5.1`, `glm-4.7 → --model sonnet`, `glm-4.5-air → --model haiku`. (Those aliases resolve to GLM models because the wrapper sets `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`.) GLM bills the z.ai plan and is the slow one on large multi-file tasks — give it a generous `glmTimeoutSecs`.
- **Local MLX** has a **dynamic** catalogue: fetch it live with `omlx-models` (or `curl -s http://127.0.0.1:8000/v1/models -H "Authorization: Bearer $OMLX_AUTH_TOKEN" | jq -r '.data[].id'`). Ids pass straight through as `--model <exact-id>`. Local models are **free** (on-device) but slower, and small ones can be unreliable at saving a deliverable; prefer hosted providers for heavy writing tasks.
- **Codex** is **pinned to `gpt-5.5`** — the only model the local ChatGPT-account auth serves (other ids return HTTP 400 unless you set `OPENAI_API_KEY` for API-key billing). So the lever is **reasoning effort**: `low | medium | high | xhigh` ("Extra high"; `minimal` is rejected). Codex has **no turn cap**, so its only per-attempt backstop is the wall clock (`codexTimeoutSecs`, default 600s). It bills your OpenAI/ChatGPT plan.
- **MiniMax** exposes one model, `MiniMax-M3` (512K context), pinned via `ANTHROPIC_MODEL=MiniMax-M3` (so there's no `--model` flag). It bills your MiniMax plan; M3 was fast and clean on a heavy multi-file build in testing.

**Every runner reads its key from the environment** — never by sourcing or grepping rc files — so the providers stay uniform. A provider whose key is unset produces an honest failure, not a fake fallback.

**Provenance check (the anti-spoofing guard).** Every non-Anthropic attempt writes a marker into its run log proving it actually hit the intended endpoint — `JOUST-GLM-PROVENANCE endpoint=api.z.ai`, `JOUST-LOCAL-PROVENANCE endpoint=127.0.0.1:8000`, `JOUST-CODEX-PROVENANCE endpoint=api.openai.com`, `JOUST-MINIMAX-PROVENANCE endpoint=api.minimax.io` — plus a `DONE exit=0` with no `TIMEOUT`/`ERROR`. The validator is **line-anchored and provider-specific** (`^JOUST-<PROV>-…`), so an attempt whose own deliverable merely *mentions* a marker token can't false-fail. A candidate with no marker or no saved file is treated as a failed attempt and excluded; the round proceeds over the survivors.

---

## Diversity injection (Pool A / Pool B)

Independent attempts only help if they actually differ; same-model siblings on an identical prompt tend to converge. Diversity injection (**default on**) gives each attempt a distinct framing drawn from a modifier pool, so any divergence is attributable to the modifier. The draw is **seeded and logged** for reproducibility, **without replacement** within a round, and biased so same-model siblings get the most-different nudges.

- **Pool A — approach nudges (default on, blind-safe).** These vary *how* an attempt starts and proceeds, not what counts as a good answer (e.g. "from first principles," "test-first," "happy path first then harden," or for prose "lead with your strongest claim," "write for a smart, skeptical reader"). Because they don't move the success criteria, blind review is preserved. Pool A is **task-type-aware**: a light heuristic picks a code-flavoured or prose-flavoured set so a "data model" nudge isn't prepended to an essay.
- **Pool B — objective lenses (opt-in only).** These deliberately bias the *tradeoff* (`safely`, `quickly`, `efficiently`, `robustly`, `minimally`, …). Useful to fan attempts across a tradeoff frontier on purpose — but an attempt told "quickly" may correctly produce something fast and thin that a completeness-minded blind reviewer marks down. Pick one honest handling and state it: **best-overall** (keep review blind; the lens is exploration spice) or **judge-to-intent** (pass the lens to the reviewer, breaking blindness). If you didn't opt in, only Pool A is used.

In **two pass**, round 2 takes a **fresh Pool A draw only** — the distilled guidance already carries the objective steering, so a conflicting Pool B lens would send mixed signals.

---

## Grand loops (`Z >= 2`)

`Z=1` (or omitted) is the isolated tournament: it touches no repo and opens no PR. **`Z >= 2` turns the tournament into an unattended chain** that, for each of `Z` loops, runs a full tournament, **implements the winning proposal into your real repository** on a new branch, verifies it, and opens one PR. It **never auto-merges.**

Per loop `k` (FAN topology — the default):

1. **STOP-file kill switch** checked at the top of every iteration — create `<runDir>/STOP` at any time to halt before the next loop, without killing the harness.
2. **Branch off base:** `JE-<loop>-<random7>` off the branch you started on. *(This fixed name is used as-is, overriding any branch-prefix rule you have configured, for loop branches only.)*
3. **Run the tournament** (the unchanged engine), with the task augmented by a **cross-loop ledger** of what prior loops already proposed, so each loop attacks something different.
4. **Implement the winner** via the Opus `joust-implementer` agent — the *only* actor that writes to the real repo. It makes the smallest coherent change on the branch, leaves it **unstaged**, records ambiguities in `JE-NOTES.md`, and never runs git.
5. **Verify, fail-closed.** Auto-detected commands (npm scripts, `ruff`/`pytest`, `make test/check`, `cargo`, `go`) run **fail-fast**; a failure or "no verify commands" routes the PR to **draft + `needs-human`** (with a capped tail of the failing output) and **halts the chain**.
6. **Commit, push, open the PR** (one per loop, individually mergeable off base). A per-loop **DONE marker** is written only after the PR exists, so a re-run skips completed loops.

At the end the driver switches back to your starting branch. Safety rails:

- **One front-loaded authorization (Phase 0b)** replaces the per-dispatch gate for the whole chain — the only way an unattended chain is compatible with "stop and ask." A **zero-token preflight** runs first (work tree clean? `gh` authenticated? remote resolves? base resolves?) and refuses on a dirty tree. You must **re-type Z** to proceed — friction proportional to blast radius.
- **`Z_MAX = 5`.** The parser refuses `Z > 5` outright (echoing the offending Z, telling you to split into batches); the re-type guards a valid-but-large Z.
- **Non-implementable-task check.** A task that produces a standalone artifact unrelated to the repo (a haiku, an email) would open empty PRs, so grand loops offer `Z=1` instead.
- **STACK topology** (each loop off the previous) is opt-in (`topology=stack` in your message) and **forces halt-on-failure**; FAN (independent PRs off base) is the default.
- **Mid-loop death** leaves an orphan `JE-<k>-*` branch with no DONE marker; on re-entry the driver **stops and tells you to inspect/delete it** — it never auto-resumes a half-applied step.

The orchestration home is the skill procedure plus `bin/je-git.sh` (which owns *all* git/gh side effects). The tournament engine (`workflows/tournament.mjs`) is **unchanged** and never touches the repo — that purity is its safety guarantee.

---

## The dogfood backlog

Problems found while running tournaments are filed as **GitHub Issues labelled `dogfood`** (the live backlog), so they survive the gitignored `.runs/` directory and get triaged later. All forge access is confined to one helper, `bin/je-issue.sh`, so the engine stays forge-agnostic.

```bash
bin/je-issue.sh bootstrap                                      # (once) create the label scheme
bin/je-issue.sh new --sev sev2 --area parse \
   --title "…" --evidence-file EV.md                           # file an item (dedups first)
bin/je-issue.sh next                                           # top open item (sev1 → sev3)
bin/je-issue.sh claim <N> <run-id>                             # best-effort claim
# fix on a dogfood-<N> branch, open one PR with "Closes #<N>"
```

- **Severity** `sev1` (wrong winners) · `sev2` (degraded but usable) · `sev3` (cosmetic/docs); **area** labels `area:review|runner|parse|git|skill|docs|infra`.
- Every item needs a **verbatim evidence excerpt** (the helper refuses empty/placeholder evidence).
- **PUBLIC repo:** never paste secrets or the `mapping.json` unblinding line — refer to a candidate as "blind B," not the model (the helper has refusal greps for both).
- **Claiming is best-effort, not a mutex:** the GitHub API has no compare-and-swap, so `claim` is a TOCTOU read-after-write with a deterministic tiebreak; a git-ref push under `refs/dogfood-claims/` is the strict escape hatch for high fan-out / grand loops.
- **No `gh` / offline?** `new` degrades to a committed draft under `docs/dogfood/inbox/` (never `.runs/`); re-file later with `drain-inbox`.
- Legacy `D-NNNN` items were imported as **closed `dogfood` issues** (full evidence in each body); there is no in-repo archive.

---

## Installation & setup

Install Joust Engine **from inside Claude Code** — it installs straight from this GitHub repo, so there is no external marketplace or registry to register with first. Run the first command, then the second, then apply it:

```text
/plugin marketplace add robanderson/joust-engine
/plugin install joust-engine@joust-engine
/reload-plugins
```

What each line does:

1. **`/plugin marketplace add robanderson/joust-engine`** — register this repo as a plugin marketplace (Claude Code accepts the GitHub `owner/repo` shorthand). The repo root holds `.claude-plugin/marketplace.json` (marketplace name `joust-engine`).
2. **`/plugin install joust-engine@joust-engine`** — install the plugin. The form is `<plugin-name>@<marketplace-name>`; here both are `joust-engine` (the plugin manifest is `.claude-plugin/plugin.json`, name `joust-engine`, version `0.0.1`). It ships two skills (`joust-engine`, `joust-bench`) and ten agents.
3. **`/reload-plugins`** — **apply it.** This is the step the install command doesn't do for you: the newly installed plugin's skills and agents only load once you reload (or restart the session). *(If you install interactively instead — see below — Claude Code prints "Run /reload-plugins to apply" for you.)*

**Interactive alternative:** if you prefer to browse, run `/plugin` with **no arguments** after step 1 to open the marketplace, then install `joust-engine` through the menu. Either path ends the same way — at step 3, apply it with `/reload-plugins`.

After install + reload, the `joust-engine` and `joust-bench` skills and the `@@JE` trigger are available in your sessions; the bundled scripts under `bin/` run via `node` / `bash` from the resolved plugin root. **Confirm the install:** check that the `joust-engine` skill appears (e.g. it's listed in the skills list, or the `@@JE` trigger is recognised when you type it). (To launch a tournament once installed, use the `@@JE` sigil, the `joust:` prose marker, or the [`/joust-engine:joust-engine` slash command](#the-slash-command-form) — all three feed the same parser.)

> **You need a recent Claude Code with plugin support.** Anthropic auth alone — your session's own Claude login — is enough to start: Opus/Sonnet/Haiku attempts and the Opus judge need no extra keys. Optional per-provider keys (GLM / local / codex / minimax / grok) are listed in the table below and only matter if you want attempts on those providers.

> **Enabling dynamic workflows.** The preferred backend runs on Claude Code's dynamic-workflow orchestration. Turn it on by upgrading effort to its maximum: run `/effort` and select **ultracode** (max = xhigh reasoning + dynamic workflow orchestration). With it on, the tournament fans out through the `Workflow` engine and is watchable live in `/workflows`. Without it, the skill automatically falls back to manual Task-tool + `glm` CLI dispatch — the same tournament, just not driven by the workflow engine.

### What you need per provider

**Anthropic only is enough to start.** Opus/Sonnet/Haiku attempts and the Opus judge use your session's own Claude auth — no extra keys. Everything below is **optional**, needed only if you want attempts on that provider:

| Provider | You need | Set how |
|---|---|---|
| Anthropic | nothing extra | session auth |
| GLM (z.ai) | the `glm` CLI + `ZAI_API_KEY` | export `ZAI_API_KEY` in your shell profile |
| Local MLX | the `omlx` server running on `127.0.0.1:8000` + `OMLX_AUTH_TOKEN` | start `omlx`; export `OMLX_AUTH_TOKEN` |
| Codex (OpenAI) | the `codex` CLI, signed in (`~/.codex/auth.json`) | `codex` login; optional `OPENAI_API_KEY` for non-`gpt-5.5` ids |
| MiniMax | the `claude` CLI + `MINIMAX_API_KEY` | export `MINIMAX_API_KEY` in your shell profile |

Every runner reads its key **from the environment** (exported in your shell profile and inherited into the session at launch), exactly the same way for every provider. The skill probes liveness before spending a round where it can — e.g. a one-line Codex probe, an `omlx-models` fetch — and offers another tier if a provider is down or its CLI is stale (e.g. `brew upgrade codex`).

---

## The benchmarking system (`je-bench`)

The `joust-bench` skill (trigger: ask to benchmark model speed, run `/je-bench`, or the [`/joust-engine:joust-bench` slash command](#the-slash-command-form)) is a thin wrapper over `bin/je-bench.mjs`. It measures **generation throughput (tokens/second)** for every model the system can call, on a **cold** call (first call — connection/cache/route warmup for hosted providers, a genuine weight-load only for local MLX) and an immediate **hot** call (second identical call). It prints a table and **appends every result** to `<plugin>/.bench/results.jsonl` (append-only, written per-model immediately, so a crashed sweep keeps what it produced).

```sh
# every callable model (local MLX list discovered live), cold + hot each:
node "<plugin-root>/bin/je-bench.mjs" --models all

# a subset:
node "<plugin-root>/bin/je-bench.mjs" --models anthropic,glm
node "<plugin-root>/bin/je-bench.mjs" --models glm:glm-5.1,codex:codex-high,opus

# dry-run: print the resolved plan, make NO model calls (cheap, testable):
node "<plugin-root>/bin/je-bench.mjs" --list --models all

# heavy profile (slower + pricier):
node "<plugin-root>/bin/je-bench.mjs" --models opus,minimax-m3 --profile heavy
```

**Selection grammar** (`--models`, comma-separated, de-duped): `all` (default) · a provider (`anthropic|glm|local|codex|minimax`) · `<provider>:<id>` (e.g. `glm:glm-5.1`, `codex:codex-high`, `local:<omlx-id>`) · a bare id (`opus`, `glm-5.2`, `minimax-m3`, `codex-high`, a local id).

**Two workload profiles** (`--profile`, default `light`; `--heavy`/`--light` shorthand):

| Profile | Input | Output cap | Timeouts (default/local) | Use |
|---|---|---|---|---|
| `light` (default) | ~200-word paragraph | 2048 | 240s / 600s | fast/cheap throughput smoke |
| `heavy` | fixed **>5k-token** code context | 8192 | 600s / 1200s | representative coding/agentic load: drives a **>5k-token decode** |

The light cap is **2048, not a few hundred**: an extended-thinking model rejects a sub-1024 output cap (the thinking-budget floor), which is why both profile caps sit above it. The heavy profile is for when the light profile's small decode is too tiny to characterise real coding throughput.

`tok/s = output_tokens / generation_wall_seconds`, using the provider's **real** token counts (claude-family parses `claude -p --output-format json --verbose`; local uses omlx `usage.completion_tokens`; codex uses a real usage event if present, else a flagged chars/4 estimate). Auth comes from the environment exactly as the runners do; a provider whose key is unset is recorded as a **failed row** and the sweep **continues**. Each result row records the `profile` name, cold/hot output tokens, the real input size, seconds, and a `timestamp`.

Useful tips: run `--list` first to confirm (and price) the plan before the real paid sweep; the heavy all-models sweep is much slower and pricier (slow local models can approach the 1200s local timeout), so warn yourself and consider a representative subset. Full reference: `bin/README.je-bench.md`.

---

## Repository layout

A Claude Code plugin: a manifest, two skills, ten agents, the workflow engine, and the bin helpers. How the pieces fit:

```text
joust-engine/
├── plugin.json                         # plugin manifest (name, version, skills, agents)
├── package.json                        # toolchain pin + test entry points (not published to npm)
├── .nvmrc                              # pinned Node version for local dev + CI
├── .github/workflows/ci.yml            # CI lane 1: runs `npm run ci` on push + PR
├── scripts/                            # dev tooling (run-tests, static checks)
├── DOGFOOD.md                          # pointer stub → live backlog is GitHub Issues
├── skills/
│   ├── joust-engine/
│   │   ├── SKILL.md                    # the orchestration procedure (Phases 0–7); runs the loop
│   │   └── references/
│   │       ├── orchestration.md        # dispatch mechanics, model ids, runner args, run layout
│   │       ├── diversity-injection.md  # Pool A / Pool B, sampling rules
│   │       ├── review-rubric.md        # the Opus reviewer/ranker scoring + distillation rubric
│   │       └── dogfood.md              # the dogfood-backlog convention
│   └── joust-bench/
│       └── SKILL.md                    # /je-bench wrapper over bin/je-bench.mjs
├── agents/                             # bundled worker agents
│   ├── joust-glm-5-2.md           # GLM workers (one per GLM model) — run bin/glm-run.sh
│   ├── joust-glm-5-1.md
│   ├── joust-glm-4-7.md
│   ├── joust-glm-4-5-air.md
│   ├── joust-local.md             # one generic local worker — runs bin/local-run.sh
│   ├── joust-codex.md             # one generic codex worker — runs bin/codex-run.sh
│   ├── joust-minimax.md           # one generic minimax worker — runs bin/minimax-run.sh
│   ├── joust-grok.md              # one generic grok worker (both variants) — runs bin/grok-run.sh
│   ├── joust-implementer.md       # (grand loops) Opus; applies the winner to the real repo
│   └── joust-cleanup.md           # (on request) Opus; ASK-FIRST disk reclaim via bin/je-git.sh je_cleanup
├── workflows/
│   ├── tournament.mjs                  # the dynamic-workflow engine: plan rounds → council review → (implement) rounds 3-4 → council rank
│   └── tournament-*.test.mjs           # engine test suite (worktree mode, workspace root, verdict integrity, contributions, ...)
├── bin/                                # runners + helpers (run with node / bash)
│   ├── je-parse.mjs                    # Phase 0 invocation parser (sigil, prose spec, Top Mixed, Z, task size)
│   ├── je-git.sh                       # ALL git/gh side effects for grand loops (preflight, branch, verify, PR, markers, cleanup)
│   ├── je-issue.sh                     # the only forge-touching part: dogfood GitHub-Issues helper
│   ├── glm-run.sh                      # provider runner scripts (build a benign command, set env,
│   ├── local-run.sh                    #   call the nested claude/codex, write provenance markers)
│   ├── codex-run.sh
│   ├── minimax-run.sh
│   ├── grok-run.sh
│   ├── je-bench.mjs                    # the throughput benchmark
│   └── README.je-bench.md              # je-bench usage + results-format reference
├── docs/
│   ├── superpowers/specs/              # approved design specs (judge council, plan/implement rounds)
│   └── dogfood/inbox/                  # committed offline drafts (no-gh fallback)
└── .bench/results.jsonl                # append-only je-bench history
```

**How the pieces fit together at run time:**

- **SKILL.md is the driver.** On a trigger it runs `bin/je-parse.mjs` (Phase 0), the mandatory model gate (Phase 1), diversity injection (Phase 1b), then dispatches.
- **`workflows/tournament.mjs` is the preferred backend.** Invoked via the `Workflow` tool, it runs the parallel attempts, the blind Opus council reviews, and (two pass) round 2 + final rank — plus the optional implement rounds — deterministically — watchable live in `/workflows`. It returns the structured mapping + rankings the skill reports in Phase 6. (Fallback when workflows are unavailable: manual Task-tool + `glm` CLI dispatch.)
- **Agents are thin command-runners.** Anthropic attempts run native via the Task tool. Each non-Anthropic attempt runs through its wrapper agent (a cheap Bash-only driver) executing the matching `bin/*-run.sh` — the script sets provider env, closes stdin, calls the nested `claude`/`codex`, and writes the provenance marker. This indirection exists because a wrapper handed a *raw* nested command proved unreliable (it would solve the task itself, refuse on "safety," or let the weak inner model bail without saving); it matters most for **codex**, a fully autonomous external agent.
- **The judge is fixed.** Reviewer and final ranker are always Opus via the Task tool. Before judging, the engine **stages** each deliverable into a clean blind tree (copying files and deleting the known engine files — `_brief.txt`, the run logs — by exact name, an *allowlist* that keeps legitimately `_`-prefixed deliverables), **validates** the success provenance contract, and **pools** the valid deliverables into one blind-labelled `_pool.md` the judge reads — failing closed on any invalid candidate.
- **Grand loops** add `joust-implementer` (the only repo-writer) and `bin/je-git.sh` (all git/gh); the tournament engine itself stays repo-pure.

---

## Development

The deterministic tooling (the `bin/` runners, the pure helpers in
`workflows/tournament.mjs`) ships with a test suite. There is one entry point —
the same command runs locally and in CI:

```bash
npm test       # run every test (node:test + the hand-rolled harnesses + the bash tests)
npm run check  # static, model-free checks: manifests are valid JSON; every agent/skill
               # named in plugin.json has its file on disk
npm run ci     # check + test, exactly what CI runs
```

No dependencies to install — the tests are Node/Bash stdlib only. Node is pinned in
`.nvmrc` (run `nvm use`). `npm test` discovers and runs each `*.test.mjs` /
`*.test.sh` under `workflows/` and `bin/`; add a test by dropping a new file there.

**Scope:** this covers the *tooling* — the parser, git/gh helpers, contribution
math, output parsing, and key-hygiene guards — which call no model and need no
network. It does **not** test skill *behaviour* (whether Claude triggers on `@@JE`,
runs blind attempts, etc.); that needs a model in the loop and is an evals concern,
not a unit test. CI runs on every push and PR via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

> **Naming caveat:** the top-level `workflows/` directory is the tournament
> **engine source**, *not* GitHub Actions. CI workflows live under
> `.github/workflows/`.

---

## Honest limitations

The source is candid about these, and you should be too:

- **Blindness has honour-system edges.** The judge gets `Read`/`Bash` and the absolute run dir, so it *could* walk to a sibling workspace and read a provenance log; the prompt tells it not to, but that part isn't mechanically enforced. And while the blind letter is decorrelated from dispatch order, the presentation order in the pool is fixed, so any positional bias in the judge is uncorrected — weight on merits, not order.
- **Cost grows with N and mode.** Single pass ≈ N attempts + 1 Opus pass; two pass ≈ 2N + 2; grand loops multiply that by Z and add an Opus implementer + verify per loop. Cost is explicitly *not* the design constraint here, but it is real — the skill confirms volume at higher N and `Z_MAX` caps the chain at 5.
- **Weaker models fail honestly.** `glm-4.5-air` and small local MLX models sometimes don't save a deliverable; codex can refuse or run to its wall-clock timeout. These are excluded as failed attempts, not papered over, and the round proceeds over the survivors. On-device models are poorly suited to heavy writing deliverables (one local model timed out at 600s on a ~27KB proposal) — prefer hosted providers there.
- **Claiming a dogfood item is best-effort, not a lock** (no GitHub compare-and-swap); use the git-ref escape hatch when you need strict exclusivity.
- **Grand loops never auto-merge, never resume.** A failed verify halts the chain into a draft `needs-human` PR; a mid-loop death stops and asks a human to clean up the orphan branch. By design, you are always the one who merges.
