# Joust Engine — Grand Loops (`Z`) + Prose-Inferred `N`: evaluation & build plan

Audience: a maintainer of this skill+plugin who must walk away able to build both features without re-deriving the engine's contracts. This document evaluates the two proposals, then gives the exact grammar, parsing rules, orchestration home, control flow, git/PR mechanics, and the file-by-file change list.

---

## 0. What the engine actually is (verified, load-bearing)

Read from `workflows/tournament.mjs`:

- It dispatches **only** through two harness primitives: `agent(prompt, opts)` (one sub-agent) and `parallel([...])` (fan-out), plus `phase()`/`log()`. There is **no** `workflow()` / sub-workflow / spawn-another-workflow primitive in the file, and nothing in the references claims one. Do not invent one.
- It is **pure with respect to real repos.** Every path it writes is under `runDir` (`round-1/`, `review-1/`, `round-2/`, `review-final/`, `_context/`). It never touches a git repo, never `cd`s outside `runDir`, never runs `git`/`gh`. The only side-effecting pattern in the whole engine is **bundled bash runners** (`glm-run.sh`, `local-run.sh`, `codex-run.sh`) invoked through a benign `bash <runner> <flag>` command that a wrapper agent runs verbatim.
- Its return value is structured JSON (`{ mode, n, round1.mapping, round1.review, guidance?, final.mapping, final.rank, final.winnerRound }`) — exactly the report payload, nothing more.
- It has **no resumability** beyond the live `/workflows` monitor. There is no `resumeFromRunId`. A run that dies is gone.

Two invariants follow that the proposal **breaks**, and the whole design is about breaking them deliberately, in one tightly-bounded place:

- **INV-1 (mandatory interactive gate).** SKILL.md's operating rule: the first response to a trigger is *only* the Phase 1 model question; the skill stops and asks before spending tokens, and again before each dispatch. Grand loops are an *unattended* chain — they cannot stop to ask between loops 1..Z. We do not delete the gate; we **front-load** it into one authorization that covers all Z loops.
- **INV-2 (nothing applied to a real repo).** Everything lives in isolated `.runs/` workspaces. "Implement the winner" is, by definition, a real write to a real repo. This is a genuinely new component, not a counter.

---

## 1. Evaluation

### 1.1 Feature 2 (infer `N` from a prose model spec) — low risk, high value, do it

This is almost pure ergonomics with no new autonomy. Today Mixed mode forces the user to (a) sum the counts into `N` by hand, then (b) walk an N-step per-attempt menu. A prose spec like `2 opus, 2 glm 5.2, 1 codex high` already *contains* both N (=5) and the per-attempt assignment (`[opus, opus, glm-5.2, glm-5.2, codex-high]`). Parsing it eliminates two error-prone manual steps and a long interactive walk.

**Strengths:** removes the most tedious part of Mixed; the assignment is auditable text the user typed; it composes cleanly with the existing model-gate (a prose spec simply *answers* the gate, so Phase 1's menu is skipped for that run).

**Risks / gaps to design around:**

- **Unknown tokens silently dropped change N.** If `glm 5.9` (typo) is dropped, N quietly shifts from 5 to 4 and the user gets a different tournament than they asked for. **Must reject unknown tokens loudly.**
- **Variant defaults.** `codex high` → `codex-high` is clear, but bare `codex` needs a default (medium, codex's own default) and bare `glm` needs a default (glm-5.2, the documented strongest). These must be specified, not guessed per-run.
- **Explicit-N-vs-prose conflict.** `@@JE:4 ... 2 opus, 2 glm, 1 codex` says N=4 by sigil and N=5 by prose. This is the skill's cardinal sin (silent guessing) if mishandled. **Resolution: stop and ask, surfacing both numbers; proceed silently only when they are equal.** Never silently override an explicit integer (neither direction — not "prose wins", not "N caps prose").
- **Local-model ids in prose.** Local ids (`gemma-4-26b-a4b-it-8bit`) are long, dynamic, and not prose-friendly. The parser should accept them verbatim if typed but not try to fuzzy-match them; realistically prose specs name hosted models, and Mixed-menu remains for exotic local ids.

### 1.2 Feature 1 (grand loops, `Z`) — powerful but it changes the product's category

With `Z>1`, Joust Engine stops being "an isolated generate-and-rank tournament that touches nothing" and becomes "an unattended self-improvement agent that writes code to your repo and opens PRs." That is a different, much higher-blast-radius tool. It is buildable and worth building, but only with the two invariants confronted head-on.

**Strengths:** the Ralph/Karpathy unattended-improvement loop is genuinely useful; one new branch + PR per loop keeps every change reviewable and revertible; the human-merges-later model is the right safety posture; reusing the existing tournament as the per-loop engine is sound (the engine is already the hard part and it stays unchanged).

**Risks / hidden costs / gaps:**

- **"Implement the winner" is the whole new system, not a step.** The tournament produces a *proposal artifact* in an isolated workspace. To implement it you need a brand-new **implementer actor** that reads the winning proposal and the real repo, makes real edits on a real branch, plus a **git/PR layer** (branch, commit, push, `gh pr create`). This breaks both INV-1 and INV-2 and is where all the new risk lives.
- **Cost is `Z × (tournament + implementer + verify)`, not `Z × tournament`.** Each loop adds (a) an implementer agent run (reads repo + proposal, writes a diff — easily as expensive as one attempt or more), and (b) verify runs (build/test/lint, possibly minutes of compute, possibly more if the implementer fixes failures). An estimate that prices only `Z × N` undersells the spend, sometimes badly. The budget line must include implementer + verify.
- **Autonomy vs the interactive gate.** The gate is mandatory and per-dispatch today. An unattended Z-loop chain cannot honor that literally. We replace per-loop gating with **one front-loaded authorization** covering all Z loops, plus a between-loops kill switch.
- **Oscillation / diminishing returns / no convergence signal.** `Z` is a fixed count. Loop 2 may undo loop 1; loop 4 may add noise. Nothing detects "we've converged, stop." This is inherent to a fixed-count loop and must be disclosed as a limitation; partial mitigations below (cross-loop memory, max-Z ceiling, kill switch).
- **Cross-loop memory / task evolution.** With FAN topology (each loop branches from the same base), every loop re-attacks the *same* repo state and tends to re-propose the *same* improvement — Z near-duplicate PRs. Needs a **prior-loops ledger** fed into each loop's task so loop k knows what loops 1..k-1 already proposed.
- **Non-implementable tasks.** `@@JE:4:1:3` on "write a haiku" would run a tournament, then try to "implement a haiku into the project" and open an empty/nonsense PR three times. Must **detect non-implementable tasks before entering grand-loop mode.**
- **Idempotency / interruption.** A chain that dies mid-loop (token limit, crash, network) can leave a half-applied branch, an un-pushed commit, or a created-but-empty PR. Need preflight + per-loop state so a re-run doesn't double-open PRs or corrupt the tree.
- **Branch-naming convention conflicts with a global user rule.** The user's global CLAUDE.md says branches are prefixed `rob/`. The required convention here is `JE-<n>-<random7>`. **This is a real conflict and must be called out, not silently resolved** — the feature-specific convention overrides the global rule *for these loop branches only*, and the skill must say so.

**Bottom line:** Feature 2 is a clean win, build as specified. Feature 1 is worth building but only if the implementer/git layer, the front-loaded authorization, the full-cost budget, and the fail-closed verify gate are all in place. Do not ship Z without them.

---

## 2. Grammar & Phase-0 parsing

### 2.1 Sigil grammar (backwards-compatible)

```
@@JE[:N][:M[:Z]]      (case-insensitive; optional spaces around every colon)
```

- `N` (optional now) = attempts per round. Integer ≥ 2.
- `M` (optional, default 1) = passes. 1 = single, 2 = two pass. Any other value → invalid, ask.
- `Z` (optional, default 1) = grand loops. Integer ≥ 1. `Z=1` = today's behavior exactly (isolated, no repo writes, no PR). `Z≥2` = grand-loop mode.

Backwards compatibility is total: `@@JE:5` and `@@JE:5:2` parse to `Z=1` and behave identically to today. `Z` can appear only when `M` is present (positional: you cannot write `@@JE:5::3`-style skips — if you want default M with explicit Z, write `@@JE:5:1:3`).

**`N` optional:** `@@JE::2:3` (empty N, M=2, Z=3) or `@@JE:` followed by a prose spec means "infer N from prose." If N is empty in the sigil, a prose model spec **must** be present, else ask for N. The empty-segment form is awkward; the common path is `@@JE` with a prose spec and no N at all (see prose grammar).

### 2.2 Prose grammar (backwards-compatible)

Existing prose marker keeps working:

```
joust engine:N[:M[:Z]]
```

New: a **prose model spec** may *replace* the explicit N (Feature 2). The spec is a comma/`and`-separated list of `<count> <model>` items:

```
MODEL_SPEC := ITEM ( (",", "and", ", and") ITEM )*
ITEM       := COUNT WS MODEL_TOKEN
COUNT      := integer ≥ 1
MODEL_TOKEN:= (see normaliser table §2.4)
```

Examples that parse:
- `run with 2 opus, 2 glm 5.2, 1 codex high` → N=5, assignment `[opus, opus, glm-5.2, glm-5.2, codex-high]`
- `1 opus and 1 sonnet and 1 codex` → N=3, `[opus, sonnet, codex-medium]` (bare `codex` → medium default)
- `3 glm` → N=3, `[glm-5.2, glm-5.2, glm-5.2]` (bare `glm` → glm-5.2 default)

The prose spec is detected by the regex in §2.3 anywhere in the message; it is *not* part of the task text (it is stripped from the task, same as the sigil).

### 2.3 Detection regexes (Phase-0)

Run these in order against the raw message (case-insensitive):

```
SIGIL   = /@@JE\s*(?::\s*(\d+)?)?(?:\s*:\s*(\d+))?(?:\s*:\s*(\d+))?/i
                     └ N(opt)        └ M(opt)        └ Z(opt)
PROSE   = /joust\s+engine\s*:\s*(\d+)(?:\s*:\s*(\d+))?(?:\s*:\s*(\d+))?/i
                                   └ N      └ M(opt)        └ Z(opt)
SPEC    = /(?:^|[\s:,])(\d+\s*(?:opus|sonnet|haiku|glm[\s-]*[0-9.]*(?:-?air)?|codex(?:[\s-]*(?:low|medium|high|xhigh|x-?high|extra\s*high))?)\b)(?:\s*(?:,|and|,\s*and)\s*\d+\s*(?:opus|sonnet|haiku|glm[\s-]*[0-9.]*(?:-?air)?|codex(?:[\s-]*\w+)?)\b)*/i
```

(`SPEC` is intentionally permissive on what it *captures*; the **normaliser** (§2.4) is the strict gate that rejects unknown tokens. Capture broadly, validate strictly — that way an unknown token is *rejected loudly* rather than dropped silently, because it was captured but fails normalisation.)

### 2.4 Normaliser table (the strict gate — reject unknowns loudly)

| Prose token (case-insensitive, spaces/dashes normalised) | Canonical model | dispatch |
|---|---|---|
| `opus` | `opus` | anthropic |
| `sonnet` | `sonnet` | anthropic |
| `haiku` | `haiku` | anthropic |
| `glm` (bare) | `glm-5.2` (default) | glm |
| `glm 5.2` / `glm-5.2` | `glm-5.2` | glm |
| `glm 5.1` / `glm-5.1` | `glm-5.1` | glm |
| `glm 4.7` / `glm-4.7` | `glm-4.7` | glm |
| `glm 4.5 air` / `glm-4.5-air` / `air` | `glm-4.5-air` | glm |
| `codex` (bare) | `codex-medium` (default) | codex |
| `codex low` | `codex-low` | codex |
| `codex medium` | `codex-medium` | codex |
| `codex high` | `codex-high` | codex |
| `codex xhigh` / `codex extra high` / `codex x-high` | `codex-xhigh` | codex |
| exact live local id (matches `omlx-models`) | that id | local |
| **anything else** | **ERROR — reject** | — |

Rule: **any captured token that does not normalise is a hard error.** The skill stops and says: *"I don't recognise model token `<x>` in your spec. Known: opus, sonnet, haiku, glm[-5.2/5.1/4.7/4.5-air], codex[-low/medium/high/xhigh], or a live local id. Please re-state the spec."* Dropping it would change N — forbidden.

### 2.5 The explicit-N-vs-prose conflict rule (no silent guess)

```
let nSigil   = N from sigil/prose marker, or null
let nSpec    = sum of counts in the prose model spec, or null

if nSigil != null and nSpec != null and nSigil != nSpec:
    STOP. Ask:
      "Your spec lists <nSpec> attempts (<assignment>) but the marker says N=<nSigil>.
       Which do you want — run <nSpec> from the spec, or N=<nSigil> (and I'll ask the
       per-attempt models)?"  -> wait for answer; never pick silently.
else:
    N = nSpec ?? nSigil          // they agree, or only one is present
    if N == null: ask for N (no spec, no marker N)
    assignment = nSpec ? <from spec> : <from the Phase-1 gate as today>
```

This is the one place the skill must not guess. When the numbers agree it proceeds silently (no friction for the common case). When they disagree it surfaces *both* and waits. It never silently overrides an explicit integer in either direction.

### 2.6 Worked Phase-0 examples

| Input | N | M (mode) | Z | assignment | gate? |
|---|---|---|---|---|---|
| `do abc @@JE:5` | 5 | 1 single | 1 | from Phase-1 gate | yes (today) |
| `do abc @@JE:5:2` | 5 | 2 two | 1 | from gate | yes |
| `do abc @@JE:5:2:3` | 5 | 2 two | 3 | from gate | yes + **autonomy auth** |
| `improve X @@JE:4:1:3 run with 2 opus, 2 glm, 1 codex` | **conflict** 4 vs 5 → STOP & ask | 1 | 3 | (pending answer) | ask |
| `improve X @@JE:1:3 2 opus 2 glm 1 codex` (N omitted) | 5 (from spec) | 1 single | 3 | `[opus,opus,glm-5.2,glm-5.2,codex-medium]` | no Phase-1 menu (spec answers it) + autonomy auth |
| `do abc joust engine:4` | 4 | 1 single | 1 | from gate | yes |
| `do abc, run with 2 opus and 1 sonnet joust engine:3:2` | 3 (agree) | 2 two | 1 | `[opus,opus,sonnet]` | no menu |

---

## 3. Where the grand-loop orchestration lives — decision

**Recommendation: a new `bin/` outer driver (`bin/grand-loop.sh`) that the SKILL.md procedure invokes once, which loops Z times and calls the *unchanged* `tournament.mjs` engine each loop via the harness, with a dedicated implementer/PR step in between.** Keep `tournament.mjs` pure.

Why, anchored in what exists:

- The engine dispatches only via `agent()`/`parallel()` and writes only to `runDir`. It has **no** primitive to spawn another workflow, run git, or create PRs. Putting the Z-loop inside `tournament.mjs` would require inventing a `workflow()`-calls-`workflow()` capability that I cannot confirm exists, and would mix real-repo side effects into the one component whose purity is its safety guarantee. Reject.
- The proven side-effecting pattern in this codebase is exactly **"a bash runner script invoked through a benign command"** (glm/local/codex). The grand-loop driver is the same pattern, one level up: a bash script that orchestrates `git`/`gh` and shells the engine. This is the lowest-novelty, most-auditable home and it keeps all real-repo writes in scripts the maintainer can read, not in agent improvisation.
- SKILL.md remains the human-facing procedure: it does Phase 0/1/2 (parse, authorize, confirm) and then hands off to the driver. The driver does the unattended loop. The engine stays the tournament.

So the layering is: **SKILL.md (gates) → `bin/grand-loop.sh` (Z-loop + git/PR + implementer dispatch) → `tournament.mjs` (one tournament, unchanged) + an implementer agent (new) + verify (auto-detected commands).**

A note on how the driver runs the engine: the engine is a Workflow script (`agent()`/`parallel()` are harness primitives, not Node libs), so the driver cannot just `node tournament.mjs`. The realistic shape is that **the SKILL procedure itself runs the Z loop**, invoking the `Workflow` tool for the tournament and the Task tool for the implementer, with `bin/grand-loop.sh` providing the deterministic git/PR/verify/preflight *helpers* the procedure calls between loops (suffix generation, branch create, verify-and-commit, pr-open, stop-file check). That keeps the non-deterministic parts (running the tournament, applying the winner) in the harness where the primitives live, and the deterministic, must-not-improvise parts (git/gh) in an auditable script. If a future harness exposes a real workflow-spawns-workflow primitive, the whole loop can move into a single driver; until then, the SKILL-procedure-drives + bash-helpers split is the honest design.

---

## 4. Design forks — resolved

### Fork (a): branch topology — STACK vs FAN → **FAN (default), with cross-loop memory**

- **STACK** (each loop branches off the previous): improvements compound, but blast radius is severe — one bad early loop poisons every downstream loop; you get a fragile rebase chain; and if loop 2's PR is the one the human wants to reject, loops 3..Z are built on it. This fights the stated goal ("each grand loop on its own new branch + PR … the human decides about merging later" — i.e. independent, individually-mergeable units).
- **FAN** (each loop branches off the same base, e.g. `main`): each PR is independent and individually mergeable/rejectable; one bad loop does not poison others; no rebase chain. Its weakness — loops re-propose the same thing — is fixed by **cross-loop memory** (§5.3): each loop's task is augmented with a ledger of what prior loops already proposed, so loop k explores *different* improvements.

**Decision: FAN by default**, base = current branch (resolved at preflight). It aligns with "independent PR per loop, human merges later," and the re-proposal weakness has a concrete fix. STACK is offered only as an explicit opt-in (`topology=stack`) and, if chosen, **forces halt-on-failure** (a fragile chain cannot tolerate a broken link) — that is the justification gate for picking it.

### Fork (b): per-loop task model — proposal+implementer vs each-attempt-real-diff → **proposal + separate implementer**

- **Each attempt produces a real applied diff, judged directly:** rejected. It fights the engine's single-pass hard-stop brief ("write once, don't run/rewrite" vs "make a working diff" are opposite instructions); it leaks blindness (a diff against a real repo carries identity/style fingerprints, and the judge would need the repo); it N-multiplies the real-repo cost (every attempt needs its own seeded repo copy and its own apply/verify); and it quietly requires seeding every sandbox with a repo checkout. Calling that "mostly unchanged" would be false — it is a rewrite of the engine and its safety model.
- **The tournament produces a PROPOSAL; a separate implementer agent applies the winner:** keeps the engine pure and unchanged (attempts stay sandboxed one-shots producing a written proposal, exactly as today), and confines **all** real-repo writes to a single auditable implementer actor on one JE- branch. The implementer reads the winning proposal + the real repo and makes the edits.

**Decision: proposal + separate implementer.** The tournament's job (when `Z>1`) is to produce the best *implementation proposal* (a concrete, file-level change description, ideally with diffs in fenced blocks, in its proposal artifact). The implementer turns the winning proposal into a real diff on the JE- branch. Attempt fan-out stays sandboxed; exactly one actor writes to the repo.

### Fork (c): verification + failure policy → **auto-detected verify, fail-closed (HALT chain), draft PR on failure, never auto-merge**

Before opening each PR:

1. **Auto-detect project verify commands** (preflight, once): if `package.json` has scripts, run `npm run build` / `npm test` / `npm run lint` that exist; if `pyproject.toml`/`pytest`, run `pytest`/`ruff`; if `Makefile` has `test`/`check`, run those; if `cargo`/`go`, the standard pair. If nothing is detected, fall back to "tree compiles / git diff is non-empty" and **mark the PR `needs-human` and draft** (we could not verify).
2. **Run verify after the implementer's diff.** On **pass:** commit, push, open a normal PR.
3. **On failure (fail-closed, default):** do **not** open a normal PR. Open a **draft PR labelled `needs-human`** with the failing output in the body, then **HALT the whole chain** (FAN default is halt-on-failure too here, because a failing loop signals the task/repo is in a state the chain shouldn't keep mutating). Record the stop reason. The human inspects before any further loops.
4. **Never auto-merge.** Ever. The human decides.

A `--continue-on-failure` opt-in exists for FAN (each loop is independent, so a human might want all Z attempts regardless), but the **default is HALT**. STACK never gets continue-on-failure.

---

## 5. Per-grand-loop lifecycle & control flow

### 5.1 Zero-token preflight (once, before loop 1)

Run before spending anything; abort with a clear message on any failure:

```
[preflight]
- inside a git work tree?            git rev-parse --is-inside-work-tree
- working tree clean?                git status --porcelain  (must be empty; refuse on dirty tree)
- gh authenticated?                  gh auth status
- a remote exists?                   git remote get-url origin (or the configured remote)
- base branch resolves?             git rev-parse --verify <base>   (base = current branch)
- task implementable?               heuristic + one cheap classifier (see §5.4)
- verify commands detected?         scan for package.json/pyproject/Makefile/cargo/go (record, don't run)
```

If any fail → stop, tell the user exactly which, do not run any tournament. (A dirty tree is the most common foot-gun; refuse rather than risk committing unrelated changes.)

### 5.2 The Z-loop (FAN default)

```
preflight()                         # §5.1, zero-token
authorize_once()                    # §6, ONE gate covering all Z loops
base = current_branch
ledger = []                         # cross-loop memory

for k in 1..Z:
    if exists(runDir/STOP): halt("kill-switch STOP file present"); break   # §6 between-loops check

    git switch base
    git switch -c "JE-<k>-<random7>"        # §7 suffix; FAN: always off base

    # 1) run the tournament (UNCHANGED engine) — produces a winning PROPOSAL artifact
    result = Workflow(tournament.mjs, args={ task: augment(task, ledger), mode, n, attempts, runDir: runDir/loop-<k>, ... })
    winnerProposalPath = pick_winner_artifact(result)      # from final.mapping / round1.mapping

    # 2) implement the winner into the REAL repo on this branch (new implementer agent, §5.5)
    Task(implementer, { proposal: winnerProposalPath, repoRoot: base_repo, branch: "JE-<k>-..." })

    # 3) verify (fail-closed, §4 fork c)
    ok = run_verify(detected_commands)
    git add -A && git commit -m "JE loop <k>: <one-line winner summary>"

    # 4) push + PR
    git push -u origin "JE-<k>-<random7>"
    if ok:
        gh pr create --base base --head "JE-<k>-..." --title "JE loop <k>: <summary>" --body <template §7.3>
    else:
        gh pr create --draft --label needs-human --base base --head "JE-<k>-..." --title "[needs-human] JE loop <k>" --body <template + failing output>
        halt("verify failed on loop <k>; chain stopped (fail-closed)"); break   # default HALT

    # 5) cross-loop memory
    ledger.append({ loop: k, winner_summary, pr_url })

git switch base                     # leave the user where they started
report(all loops, branches, PR urls, stop reason if any)
```

STACK variant: `base` for loop k becomes branch of loop k-1 (`git switch -c JE-<k>-... JE-<k-1>-...`), and `--continue-on-failure` is disallowed.

### 5.3 Cross-loop memory (`augment(task, ledger)`)

For FAN, each loop re-attacks the same base, so without memory it re-proposes the same change. `augment` appends to the task brief:

```
Prior grand loops on this same repository already proposed and (on separate branches) implemented:
- loop 1: <winner_summary 1>
- loop 2: <winner_summary 2>
Propose a DIFFERENT, additive improvement that does not duplicate the above. If you believe the
repository is already in good shape, say so explicitly rather than inventing a marginal change.
```

This both diversifies loops and gives the loop a way to say "nothing worthwhile left" (a soft convergence signal — see limitations; it is advisory, not enforced).

### 5.4 Non-implementable-task detection (before loop 1)

Heuristic + one cheap `haiku` classifier: a task is *implementable* if it implies a change to project files (refactor, add feature, fix, optimize, write tests, document). It is *non-implementable* for grand-loop mode if it produces a standalone artifact unrelated to the repo (`write a haiku`, `draft an email`, `explain X`). On non-implementable + `Z>1`:

```
STOP: "This task ('write a haiku') produces a standalone artifact, not a repo change, so grand
loops (Z=3) would open empty/meaningless PRs. Run it as a normal tournament (Z=1) instead? [y/N]"
```

This prevents the empty-PR failure mode at the source.

### 5.5 The implementer agent (the real new component)

A new bundled agent (`agents/joust-implementer.md`, model: a strong Anthropic model — Sonnet or Opus, since it writes real code) invoked via Task with `Bash Read Write Edit` in the **real repo root** on the JE- branch. Its brief:

```
You are applying an already-chosen improvement proposal to a real repository on a dedicated branch.
The proposal (chosen blind from a tournament) is at: <winnerProposalPath>. The repo root is <repoRoot>;
you are on branch <branch>; the base is <base>.

Do EXACTLY this:
- Read the proposal. Read the relevant existing files. Apply the proposal's concrete changes to the
  real files (edit in place / create files as the proposal specifies).
- Make the SMALLEST coherent change that realises the proposal. Do not add unrelated changes.
- Do NOT commit, push, switch branches, or open a PR — the driver does that. Do NOT run destructive git.
- If the proposal is ambiguous or under-specified, implement the most faithful reasonable interpretation
  and note the assumption in a file `JE-NOTES.md` at repo root.
- Leave the working tree with your changes unstaged; end with a 3-6 line summary of what you changed.
```

It is the *only* actor that writes to the real repo, and it does not touch git — keeping the auditable git/PR mechanics entirely in the driver. This is the design-around for INV-2: real writes are real, but confined to one actor on one JE- branch, never to `main`, never auto-merged.

---

## 6. The autonomy authorization (design-around for INV-1)

Replace the per-dispatch interactive gate with **ONE explicit authorization, shown once, covering all Z loops.** It is the first response when `Z>1` is detected (after Phase 0, before any spend), and it must name everything:

```
Grand-loop mode requested: Z=3 grand loops.

This is UNATTENDED and WRITES TO A REAL REPOSITORY. For each of 3 loops I will:
  • create a new branch  JE-<n>-<random7>  off  <base = current branch 'main'>   (FAN topology)
  • run a full <single|two>-pass tournament (N=<n>, models: <assignment>)
  • IMPLEMENT the winning proposal into your repo on that branch
  • run verify (<detected: npm test, npm run build>) — FAIL-CLOSED: a failure HALTS the chain
  • open a PR (draft+needs-human if verify failed). I will NEVER merge.

Repo:           <repoRoot>
Topology:       FAN (independent PRs off <base>); human merges later
Branch naming:  JE-<loop>-<random7>  (NOTE: this overrides your global 'rob/' branch-prefix rule
                for these loop branches only)
Kill switch:    create a file  <runDir>/STOP  at any time to stop before the next loop
Projected cost: ~Z × (N attempts + 1-2 Opus judges + 1 implementer + verify)
                ≈ 3 × (<n> attempts + 2 judges + 1 implementer + verify) = roughly <X> agent runs
                plus <n>×<Z> provider calls + 3 verify runs. (Estimate; verify/implementer are real.)

To proceed, re-type the number of grand loops: ___      (friction ∝ blast radius)
```

Properties demanded by the brief:
- **One authorization for all Z** (not per-loop) — the only way an unattended chain is compatible with "stop and ask."
- **Names repo, cost multiplier, kill-switch, topology** explicitly.
- **Friction proportional to blast radius:** the user must **re-type Z** to confirm (a fat-fingered `@@JE:5:2:30` doesn't run 30 repo-mutating loops on one Enter).
- **Cost gated on the PRODUCT** `Z × per-loop` (including implementer + verify), with a projected budget line — **not** the existing per-round `N` thresholds.
- **Hard `Z` ceiling:** `Z > Z_MAX` (recommend `Z_MAX = 5`) is refused outright with a message to split into batches. (Combined with the re-type, this caps a runaway.)
- **Between-loops STOP-file kill switch:** checked at the top of every loop iteration (§5.2), so the human can stop the chain without killing the harness.

The original per-dispatch gate is preserved exactly for `Z=1` (today's behavior). It is *only* replaced by this one authorization when `Z≥2`.

---

## 7. Git / PR mechanics

### 7.1 Suffix generator (real 7-char lowercase alnum)

```bash
# 7 chars from [0-9a-z]; portable on macOS (no GNU coreutils assumed)
je_suffix() { LC_ALL=C tr -dc '0-9a-z' < /dev/urandom | head -c 7; echo; }
# branch name for loop k:
je_branch() { echo "JE-$1-$(je_suffix)"; }   # e.g. JE-1-fhjdks6, JE-2-fhdsjy4
```

Uses `/dev/urandom`, not `Math.random`/`Date.now` (no dependence on any prohibition — `/dev/urandom` is simply the right tool and is collision-safe enough at 36^7 ≈ 78 billion).

### 7.2 Branch / commit / push

```bash
git switch "<base>"
git switch -c "$(je_branch "$k")"
# (implementer applies changes here)
git add -A
git commit -m "JE loop ${k}: ${WINNER_SUMMARY}"
git push -u origin "$BRANCH"
```

### 7.3 PR via `gh` (honest body template)

```bash
gh pr create --base "<base>" --head "$BRANCH" \
  --title "JE loop ${k}: ${WINNER_SUMMARY}" \
  --body "$(cat <<EOF
## Joust Engine — grand loop ${k} of ${Z}

**Automated, unverified-by-human change.** This branch was produced by an unattended
Joust Engine grand-loop run. A human must review before merging. NOT auto-merged.

- **Task:** ${TASK}
- **Tournament:** ${MODE} pass, N=${N}, models: ${ASSIGNMENT}
- **Winning proposal (chosen blind by Opus):** ${WINNER_MODEL} — see run dir.
- **Topology:** FAN (branched off \`${base}\`); sibling loops: ${SIBLING_PR_LINKS}
- **Verify:** ${VERIFY_RESULT}   (commands: ${VERIFY_COMMANDS})
- **Run dir / artifacts:** ${runDir}/loop-${k}/

### What changed
${IMPLEMENTER_SUMMARY}

### Caveats
- Chosen from N one-shot proposals; the implementer applied the winner faithfully but it has had
  no human iteration. Read the diff.
- $( [ verify_failed ] && echo "VERIFY FAILED — this is a draft \`needs-human\` PR; see output below." )
EOF
)"
# on verify failure, add: --draft --label needs-human
```

### 7.4 Idempotency / interruption

- **Dirty tree** → refused at preflight (never auto-stash unrelated work).
- **Per-loop completion marker:** write `runDir/loop-<k>/DONE` only after the PR is created. A re-run skips any loop whose `DONE` exists (don't double-open PRs).
- **Mid-loop death:** the branch may exist with un-pushed/uncommitted changes. The skill should, on re-entry, detect a branch `JE-<k>-*` with no `DONE` and tell the human to inspect/delete it rather than silently resuming (resuming a half-applied implementer step is unsafe). Leave the user on `base` (`git switch <base>` in a trap/finally).
- **STOP file** beats everything: checked top-of-loop; honored even mid-chain.

---

## 8. Files to change / add

| File | Change |
|---|---|
| `skills/joust-engine/SKILL.md` | Phase 0: add the `Z` segment + prose-spec parsing + the conflict-stop rule (§2.5) + non-implementable detection (§5.4). New **Phase 0b: grand-loop authorization** (§6) replacing the per-dispatch gate when `Z≥2`. New **Phase 7: grand-loop driver procedure** (§5.2 control flow, FAN default, fail-closed verify, PR mechanics). Note the `JE-` vs global `rob/` conflict. Update Quick reference table + description frontmatter (mention `@@JE:N:M:Z` and prose model spec). Keep all `Z=1` behavior byte-identical. |
| `skills/joust-engine/references/orchestration.md` | New section "Grand loops" documenting the driver/engine/implementer layering (§3), the implementer agent brief (§5.5), cross-loop memory (§5.3), verify auto-detection, idempotency (§7.4). State explicitly the engine is unchanged. |
| `workflows/tournament.mjs` | **No functional change to the tournament.** Optional: accept a `loopLedger`/`priorWinners` arg appended to the task brief (cleaner than the SKILL augmenting task text), but augmentation can live entirely in the driver — keep the engine pure if in doubt. Document that `runDir` per loop is `runDir/loop-<k>`. |
| `bin/grand-loop.sh` (**new**) | Deterministic helpers the SKILL procedure calls: `je_suffix`, `je_branch`, `preflight`, `detect_verify`, `run_verify`, `commit_and_push`, `open_pr` (normal + draft/needs-human), `stop_file_check`, `done_marker`. All git/gh lives here, never improvised by an agent. |
| `bin/je-parse` (**new**, standalone) | Testable parser+normaliser (§2): input = raw message; output = JSON `{task, n, mode, z, assignment[], conflict?, errors[]}`. Isolated so the grammar/normaliser are **unit-testable** without running a tournament. The SKILL calls it in Phase 0; it is the single source of truth for the grammar. |
| `agents/joust-implementer.md` (**new**) | The implementer agent (§5.5), model Sonnet/Opus, `Bash Read Write Edit`, applies winner proposal, no git. |
| `plugin.json` | Add `joust-implementer` to `components.agents`; bump version (2.0.0 — new major capability). Update description to mention grand loops + prose model spec. |
| `trigger-evals.json` | Add grand-loop + prose-spec cases (§9), including should-NOT-trigger guards. |

---

## 9. Trigger-eval additions

Add `z` and (where relevant) `n`/`assignment` expectations:

```json
{"query": "improve the error handling @@JE:4:2:3", "should_trigger": true, "mode": "two", "n": 4, "z": 3},
{"query": "refactor the parser @@JE:5:1:2", "should_trigger": true, "mode": "single", "n": 5, "z": 2},
{"query": "optimise this loop, joust engine:4:2:3", "should_trigger": true, "mode": "two", "n": 4, "z": 3},
{"query": "improve X @@JE:1:3 run with 2 opus, 2 glm 5.2, 1 codex high", "should_trigger": true, "mode": "single", "z": 3, "n": 5, "assignment": ["opus","opus","glm-5.2","glm-5.2","codex-high"]},
{"query": "do abc, 1 opus and 1 sonnet and 1 haiku joust engine:3", "should_trigger": true, "mode": "single", "n": 3, "z": 1, "assignment": ["opus","sonnet","haiku"]},
{"query": "improve X @@JE:4:1:3 run with 2 opus, 2 glm, 1 codex", "should_trigger": true, "conflict": true, "note": "N=4 (sigil) vs N=5 (spec) -> STOP and ask"},
{"query": "tidy things up @@JE:3:1:9", "should_trigger": true, "z": 9, "note": "Z>Z_MAX(5) -> refuse, ask to split"},
{"query": "write a haiku @@JE:4:1:3", "should_trigger": true, "z": 3, "note": "non-implementable -> offer Z=1 instead of opening empty PRs"},

// should-NOT-trigger guards (unchanged spirit):
{"query": "run 3 grand loops of improvement on my repo", "should_trigger": false, "note": "no marker/sigil; ambiguous; belongs to a plain request, not this skill"},
{"query": "create a branch JE-1-abc1234 and open a PR", "should_trigger": false, "note": "branch ops, not a tournament"},
{"query": "what does the Z parameter do in a loop", "should_trigger": false}
```

---

## 10. Open questions for the human (concise)

- `Z_MAX` = 5 ok? Or higher with stronger friction?
- Default base = current branch ok, or always branch off `main`?
- Implementer model: Sonnet (cheaper) or Opus (stronger) default?
- Verify-failure default = HALT chain (recommended) or finish remaining loops as drafts?
- When verify commands can't be auto-detected: draft-`needs-human` PR (recommended) or skip PR entirely?
- Bare `codex` → medium and bare `glm` → glm-5.2 defaults acceptable?
- OK that `JE-<n>-<random7>` overrides your global `rob/` prefix for loop branches?

---

## 11. Limitations (honest)

- **No convergence signal.** `Z` is fixed; loops can oscillate (loop 2 undoes loop 1) or hit diminishing returns. The cross-loop ledger lets a loop *say* "nothing left," but acting on that (early-stop) is advisory, not enforced — a true convergence test is out of scope here.
- **Implementer fidelity is unverified beyond build/test.** A proposal can pass tests and still be a poor change; the human PR review is the real gate. The implementer applies the *winner* of one-shot proposals — there has been no per-change human iteration.
- **Cost is real and front-loaded.** The budget line is an estimate; implementer and verify costs vary widely by repo (a slow test suite × Z dominates). The product gate + Z_MAX + re-type are the guardrails, not a hard token cap.
- **Mid-loop interruption is detect-and-stop, not resume.** The engine has no resumability; a chain that dies leaves a `DONE`-less JE- branch for the human to inspect. We do not auto-resume a half-applied implementer step (unsafe).
- **FAN re-proposal risk is mitigated, not eliminated.** The ledger reduces duplicate PRs but cannot guarantee orthogonal improvements; some overlap across loops is likely.
- **STACK, if chosen, inherits chain-fragility** — that's why it forces halt-on-failure; it is an opt-in, not the default.
- **Local model ids in prose are best-effort** (verbatim match only); exotic local mixes should still use the interactive Mixed menu.
- **Two harness facts are honour-system, not enforced** (carried from today): blind judges *could* read sibling dirs; and the engine's purity protects only the tournament, not the new implementer — which is exactly why the implementer is a single audited actor on an isolated JE- branch and never merges.
```

