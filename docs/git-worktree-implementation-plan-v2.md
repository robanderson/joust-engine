# Joust Engine — Worktree-Per-Attempt + Fail-Closed Adoption: Engineering Plan (v2)

> **Supersedes:** `docs/git-worktree-implementation-plan.md` (the v1 design doc). This is a critique-and-rebuild, not a polish. **Status:** design, ready to implement in staged PRs. **Evaluated against the live tree** (`workflows/tournament.mjs` 776 ln, `bin/je-git.sh` 596 ln, `bin/je-parse.mjs` 765 ln, `skills/joust-engine/SKILL.md` 272 ln, `agents/joust-implementer.md` 29 ln) on `main`, with every file:line re-grepped at its real offset.

---


## 0. How to read this document (question → answer)

Each section is framed as the engineering question it answers, then answers it decisively. Where I disagree with v1 I say so and justify it. The two organizing rules that drive ordering, abort criteria, and most of the decisions:

- **The safety spine.** Today's only safety guarantee for repo writes is *"one audited Opus actor (the implementer) is the sole writer."* Worktrees delete that guarantee by making an untrusted attempt's commit the mergeable ref. **No phase that increases write capability may ship before the gate that contains it.** Every phase's abort criterion is derived from this.
- **Eliminate leaks by construction, not by scrubbing.** When the deliverable shifts from files to commits, the new identity/timestamp/branch-name leak vectors are designed *out* (fixed identity, defer the commit until after the blind decision) rather than scrubbed after the fact.

---

## 1. Stale claims in v1 that this plan corrects (do this first — it changes the work)

The single most consequential class of error in v1 is **citing line numbers and "missing" hardening that have since drifted or already landed.** Re-grepping the real files:

| v1 claim | Reality on `main` | Consequence for the plan |
|---|---|---|
| "`run_verify` runs bare `eval "$c"` … **no timeout wrapper** (`:165`)" and "shell-only, no diagnosis" | `run_verify` is at **`bin/je-git.sh:193`**. It does **NOT** use `eval`: it argv-splits with `read -r -a words <<< "$c"` and runs `"${words[@]}"` (`:226–228`) so shell metacharacters are inert. It already **drops secrets** (`unset ZAI_API_KEY MINIMAX_API_KEY OMLX_AUTH_TOKEN OPENAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN GH_TOKEN GITHUB_TOKEN`, `:201`). | The *only* genuinely missing run_verify hardening is **the wall-clock/SIGALRM timeout** (still absent). v1's "add secret-scrubbing" and "switch off eval" work is **already done** — do not re-do it. See §9. |
| "the missing SIGALRM timeout" (listed as one of several gaps) | **Correct, and it is the ONLY gap.** No `timeout`/`gtimeout`/SIGALRM anywhere in `run_verify`; the file header even notes macOS has no `timeout`. | Promote this from "one of several" to the **single** run_verify deliverable. §9. |
| Implied: the verify gate is permissive about what the winner may touch | **`verify_safe_diff` already exists** (`bin/je-git.sh:124`) and `run_verify` calls it first (`:196`). It **refuses (rc 1)** if the change touches `package.json`, `Makefile`, `pyproject.toml`/`setup.py`/`setup.cfg`/`tox.ini`, `conftest.py`, `Cargo.toml`/`build.rs`, `go.mod`, `test_*.py`/`*_test.py`/`*_test.go`, `.github/workflows/*`, git hooks (`:140–152`). | **This is the load-bearing inversion v1 missed entirely.** Under the *current* implementer model the gate is a guard. Under the *new* model — where the winning attempt's *whole purpose* is to add a feature/fix that touches exactly these files — the gate fires on **almost every winner**, turning the validation gate into a near-universal block. Resolving this is a first-class design problem, not a footnote. See §8. |
| Line cites throughout (`:120/:160/:336/:362/:404/:462/:566/:630/:66-68`) | **All drift by the context-bundle's header offset.** Real anchors below. | Use the anchor table in §2; treat **function names** as the durable anchor, numbers as approximate. |

**Why this matters:** a plan that tells the maintainer to "add secret-scrubbing to run_verify" sends them to re-implement landed code and miss the real gap (timeout) and the real landmine (`verify_safe_diff` inversion). Correcting it is higher-value than restating v1.

---

## 2. Verified anchor table (function-name primary, line secondary)

Re-grepped against the live files on `main`. **Anchor on the symbol; the number may drift.**

| Symbol / construct | File:line | Role in this plan |
|---|---|---|
| `cmdHead = (ws, b) => mkdir -p … && cd … && printf … > _brief.txt` | `workflows/tournament.mjs:120` | The `mkdir` we replace with `git worktree add` in repo-anchored mode. |
| `runnerCmd(runner, flag, ws, b, …)` | `tournament.mjs:121` | Builds the worker shell line; threads `JE_MAX_TURNS`/`JE_TIMEOUT_SECS`. |
| `contextFiles` / `contextPath` | `tournament.mjs:132–133` | Existing per-run config plumbed through `args`; model for the new `repoMode`/`baseRef` args. |
| `buildContext()` | `tournament.mjs:145` | The haiku+Bash "run one shell command" pattern we reuse for `git worktree add`/`remove` (sandbox has no `node:fs`/`process`). |
| `RUNVERBATIM(cmd, ws, log)` | `tournament.mjs:154` | The verbatim-exec wrapper prompt; unchanged. |
| `dispatch(a, ws, guidance, phaseTitle)` | `tournament.mjs:162` | Where the worktree is created and the brief is built. The deliverable-shape change lives here. |
| `brief(nudge, ws, guidance, ctx)` | `tournament.mjs:46` (text "You are solving a self-contained task" at `:57`; "Save all deliverable files to: ${ws}" at `:68`) | The brief that must branch to "apply your change on this branch." |
| `stageAndValidate(list, reviewDir, phaseTitle)` | `tournament.mjs:342`; pool path `:343`; engine-file `rm -f` allowlist `:366`; pool concat `find … -print0 | xargs -0 cat` `:369`; provenance gate `[ "$D" -gt 0 ] && [ "$P" -eq 1 ]` `:369` | Staging that copies files today; must capture **diffs** in repo-anchored mode. |
| `provCheckShell(log, tok, lp, carriedOver)` | `tournament.mjs:310` | The provenance grep; unchanged but its inputs (engine logs) live *outside* the worktree — important for §6. |
| `blindFail` | `tournament.mjs:469` | Genericises a failReason for the BLIND summary; the laundering precedent for git-metadata leak handling. |
| `judge(kind, blindList, guidanceWanted, poolPath, schema, …)` | `tournament.mjs:407`; prompt `judgePrompt` `:199`; review call `:676`; final-rank call `:742` | Blind Opus judge, used for both reviews. The nested audit is a **sibling** call, never reuses this for union-synthesis (see §10). |
| `verify_safe_diff()` | `bin/je-git.sh:124` (refuse message `:156`) | The near-universal-block landmine. §8. |
| `run_verify()` | `bin/je-git.sh:193` (secret-drop `:201`, argv-exec `:226`, `verify_safe_diff` call `:196`) | Already hardened except for the timeout. §9. |
| `detect_verify()` | `bin/je-git.sh:61` | Detects verify commands; frozen at preflight. Runs against the base tree today; must run against the **winner's worktree** in repo-anchored mode. |
| `commit_and_push(branch, base, msg)` | `bin/je-git.sh:336` (HEAD guard `:343`, `JE-*` guard `:350`, `git add -A` `:354`, empty-diff refuse `:356`) | Adopts the winner. The worktree path changes how we reach an `JE-` branch with the diff staged. §11. |
| `preflight(base, runDir)` | `bin/je-git.sh:256` (dirty-tree refuse `:236` region) | Zero-token gate; extend to assert worktree support + disk headroom. §12. |
| `open_pr` / `open_pr_needs_human` | `bin/je-git.sh:402 / :426` | PR mechanics; unchanged. |
| `parse(rawInput)` returns `{ task, n, mode, z, assignment, preset?, conflict?, errors?, needsGate? }` | `bin/je-parse.mjs:317`; return shape doc `:15`; `result.task = stripAll(...)` `:661`; `result.needsGate` `:640` | Where `repoMode`/`baseRef` are parsed and threaded. §4. |
| `joust-implementer` "single audited actor", "UNSTAGED" | `agents/joust-implementer.md:3,8,20` | The actor being retired in repo-anchored mode. §7, §8. |
| SKILL Phase 7 driver (implement → verify → commit/push → PR) | `skills/joust-engine/SKILL.md:212` (impl step `:226`, verify step `:227`, fail route `:231`) | The grand-loop spine that changes from "re-derive" to "adopt the ref." §7. |
| "no nested grand-loop workflow … tournament.mjs is unchanged" | `SKILL.md:214` | The sibling-Workflow nesting argument the audit relies on. §10. |

Confirmed by repo-wide grep: **no `git worktree` usage anywhere** in `workflows/`, `bin/`, `skills/`, `agents/` today. (v1's claim holds.)

---

## 3. What we are actually changing (the architecture delta)

```
TODAY (Z>=2 grand loop, per loop) — lossy + single-audited-actor
  N attempts (mkdir scratch dirs)                tournament.mjs:120,162
        │  produce TEXT proposals
        ▼  blind Opus judge (tournament.mjs:407)
  winner = a PROPOSAL (text)
        │  Task → joust-implementer (Opus) RE-DERIVES code   SKILL.md:226
        ▼  on JE-<k>-<rand7>, UNSTAGED
  run_verify on the implementer's tree (je-git.sh:193)            ← single audited actor = safety
        ▼  commit_and_push → open_pr (never merged)               SKILL.md:227-231

PROPOSED (repo-anchored loop) — winner IS a gated, mergeable commit
  N worktrees off ONE pinned base ref            git worktree add  (new, in dispatch())
        │  each attempt makes a COMMIT on its own branch (fixed identity)
        ▼  blind Opus judge reads DIFFS (tournament.mjs:342→diff capture)
  winner = a git BRANCH (real, exact code)
        │  ── un-blind ──
        ▼  VALIDATION GATE on the winner's actual tree:           ← this REPLACES the audited actor
            (a) run_verify + NEW wall-clock timeout (je-git.sh:193)
            (b) nested @@JE security AUDIT (sibling Workflow, ensemble synthesis)  §10
        │  pass → adopt the winner's EXACT commit (no re-author)  §11
        ▼  fail → runner-up (re-gate) → else needs-human + HALT   §9
  open_pr (never merged)
```

The implementer hop is **collapsed** for repo-anchored tasks. We keep the implementer agent for the legacy self-contained → proposal → implement path (back-compat) but it is no longer on the repo-anchored critical path.

---

## 4. Repo-anchored vs self-contained task mode (detection, opt-in, threading)

**The question:** worktrees only pay off when the deliverable is a *change to this repo*. Today every attempt brief literally says *"You are solving a self-contained task … Save all deliverable files to: ${ws}"* (`tournament.mjs:57,68`). How is the new mode detected, opted into, and threaded?

**Decision — explicit opt-in, never auto-detect from the task prose.** (Answers v1 Open Q #1.) Reasons:

1. The blast radius differs by orders of magnitude (write to a real repo vs. write to a scratch dir). Capability escalation must be a deliberate switch, consistent with the existing front-loaded Phase 0b authorization for `Z>=2`.
2. `je-parse.mjs` is documented as *"Pure & deterministic … NEVER throws … every failure becomes an errors[] entry"* (`:11–13`). NLP-classifying "is this a repo change?" inside the parser violates that contract and is unreliable (v1's own Phase-7 non-implementable-task heuristic already lives in the SKILL, not the parser — follow that precedent).
3. There is already a perfect coupling signal: **grand-loop mode (`Z>=2`) is the only mode that writes to the real repo.** Repo-anchored mode should be *gated on, and default-on for, `Z>=2`*, and *unavailable for `Z=1`* unless explicitly forced. A `Z=1` tournament has no repo to anchor to (it opens no PR), so a worktree there is pure overhead — which directly answers v1 Open Q #6: **self-contained tasks (and all `Z=1` runs) never get worktrees.**

**Grammar + threading.** Add an optional `repo` flag to the sigil grammar as a **named segment, not a positional one** (the parser already forbids positional skips, `je-parse.mjs:559`-region, and the v1 sigil is already at its 3-segment limit `@@JE:N:M:Z`). Concretely:

- Recognize a prose keyword `repo-anchored` / `repo anchored` / `anchored` adjacent to the marker, mirroring the existing marker-adjacent `PASS_*_RX` directives (`je-parse.mjs:131,132`) and the `top mixed` keyword (`:268`). Strip it from the task in `stripAll` exactly like `top mixed` is stripped (`:573`-region).
- Add `repoMode: boolean` and `baseRef: string|null` to the parser's result object (extend the documented shape at `je-parse.mjs:15` and the `result` initializer at `:317`). Default `repoMode:false`. When `Z>=2`, default `repoMode:true` unless the user wrote `--no-repo`/`self-contained`.
- **Validation rule (fail-closed, parser-side):** `repoMode:true && z<2` → push an `errors[]` entry ("repo-anchored mode requires Z>=2; it has no PR target at Z=1") and null `n`/`assignment`, matching the existing error discipline (`:539`-region). This makes the unsafe combination unrunnable by construction.

**SKILL threading.** In **Phase 0** (`SKILL.md:25`), after acting on the parser JSON, branch on `repoMode`. In **Phase 0b authorization** (`SKILL.md:62`) add one line to the authorization block: *"Attempts build REAL code in isolated git worktrees off `<base>@<pinned-sha>`; the winning attempt's commit is adopted directly (no separate implementer)."* In **Phase 2 dispatch** (`SKILL.md:161`) pass two new `args` to the Workflow: `repoMode:true`, `baseRef:<the pinned sha>` (see §13 for why a sha, not a branch name). In **Phase 7** (`SKILL.md:212`) replace step 5 ("Implement the winner via the Task tool", `:226`) with "adopt the winner's branch" (§7/§11).

**tournament.mjs threading.** Read the two new args next to `contextFiles` (`tournament.mjs:132`): `const repoMode = A.repoMode === true; const baseRef = A.baseRef || null`. Everything downstream branches on `repoMode`; when false, the engine is **byte-for-byte today's behavior** (the same discipline `Z=1` keeps for the grand-loop feature). This keeps Phase 1 independently shippable and risk-free.

---

## 5. Worktree-per-attempt mechanics in `dispatch()`

**The question:** how does `dispatch()` (`tournament.mjs:162`) create one worktree per attempt off a single pinned base, change the brief, make the deliverable a commit, and feed diffs (not files) to staging and the blind pool?

### 5.1 Creating the worktree (replaces `cmdHead`'s `mkdir`)

Today `cmdHead` (`tournament.mjs:120`) is `mkdir -p <ws> && cd <ws> && printf … > _brief.txt`. In repo-anchored mode, the worktree must be **created before** the worker runs and **on its own branch off the pinned sha**. Two key constraints from the existing code shape the design:

1. **The sandbox cannot run git directly** — the engine has *no `node:fs`/`process`* (`tournament.mjs:419` comment) and runs shell only via a haiku+Bash agent (the `buildContext` pattern, `:145`). So the worktree must be created by a **deterministic shell command executed through the same haiku-agent pattern**, once, before the parallel dispatch — *not* inside each parallel `dispatch()` (parallel `git worktree add` against one repo can race the index lock).

2. `git worktree add` must use a **fixed identity and a deterministic branch name** to avoid the leak vectors in §6.

**Concrete design — add a `buildWorktrees()` phase mirroring `buildContext()`**, run once after `buildContext()` (`tournament.mjs:656`) and before the Round-1 `parallel(...)` dispatch (`tournament.mjs:658`-region). It emits one deterministic shell script (run in ONE Bash call via a haiku agent) that, for each attempt `a` with workspace `ws = ${runDir}/round-1/${a.label}`:

```bash
# Run ONCE, serially, from the repo root. baseSha is pinned (see §13).
# branch name is BLIND-SAFE: derived from the candidate LABEL + run id, never the model.
git worktree add -b "jewt/<runId>/round-1/<label>" "<ws>" "<baseSha>" --no-checkout 2>/dev/null \
  || git worktree add -b "jewt/<runId>/round-1/<label>" "<ws>" "<baseSha>"
git -C "<ws>" checkout -q "<baseSha>" -- . 2>/dev/null || git -C "<ws>" reset -q --hard "<baseSha>"
```

Notes that matter (and that a loose plan gets wrong):
- The branch name uses the **blind candidate label** (`candidate-1`…), not `displayModel`. Even so it is never shown to the judge (it lives in `.git`, not the worktree files); the staging step (§5.3) never copies `.git`.
- One serial loop, not parallel, for the index lock. This is cheap (platform note: ~200–500 ms each); the attempts themselves run in parallel afterward.
- `--no-checkout` then a path checkout keeps the add fast and avoids touching submodule clones; the fallback covers older git.

### 5.2 The changed brief

In `brief()` (`tournament.mjs:46`) branch on `repoMode`. The repo-anchored brief replaces the self-contained framing (`tournament.mjs:57,68`) with:

```
You are working INSIDE an existing git repository checked out at: ${ws}
This is your own isolated branch off a pinned base commit. Apply your change DIRECTLY to the
real files (edit/create/delete as needed) to accomplish the task. Do NOT write a "proposal" or a
description of a change — make the change itself.

Rules:
- Single pass: make your change once, then STOP. Do NOT run the test suite, do NOT iterate to green.
  (A separate automated step tests every candidate after you finish — testing yourself only wastes
  your turn budget. Weak/local models that loop on "run tests, fix, repeat" time out; do not.)
- Do NOT run any git command. Do NOT commit, branch, stage, push, or touch .git. Just edit files.
  The harness snapshots your working tree into a commit for you after you stop.
- Leave a 2–4 sentence note on your approach in JE-ATTEMPT-NOTES.md at the repo root.
```

**Critical discipline (v1 got this half-right):** the brief must forbid the attempt from *committing* (not just from *running tests*). v1 says "the deliverable becomes a commit (the attempt's HEAD)." I disagree with letting the *attempt* commit: an attacker-controlled attempt that commits chooses its own commit message, author, and timestamp — three of the leak vectors in §6 — and could also create extra refs. **The harness commits on the attempt's behalf, with fixed identity, after the attempt stops.** This eliminates the leak by construction (the §0 rule) rather than scrubbing a model-chosen message afterward.

### 5.3 Deliverable = a harness-made commit (not the attempt's)

After the parallel dispatch returns, a second deterministic shell step (haiku+Bash, run serially per worktree) snapshots each attempt's working tree into one commit on its branch, under a **fixed identity and a fixed message and a pinned timestamp**:

```bash
# Per worktree <ws>. ALL identity fields fixed & identical across every candidate.
export GIT_AUTHOR_NAME='joust' GIT_AUTHOR_EMAIL='joust@localhost'
export GIT_COMMITTER_NAME='joust' GIT_COMMITTER_EMAIL='joust@localhost'
export GIT_AUTHOR_DATE='<baseCommitDate>' GIT_COMMITTER_DATE='<baseCommitDate>'   # = the base commit's own date
git -C "<ws>" add -A
# Empty diff => no commit => the candidate fails the deliverable gate downstream (D>0 analog).
git -C "<ws>" diff --cached --quiet || git -C "<ws>" commit -q -m 'joust attempt' 1>/dev/null
```

`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` are pinned to the **base commit's own date** (read once from `git show -s --format=%cI <baseSha>`), so every candidate's commit is byte-identical in every identity dimension — there is *nothing* for the judge to fingerprint and nothing wall-clock-correlated. (See §6 for why this beats scrubbing.)

### 5.4 Staging + the blind `_pool.md` capture diffs, not files

`stageAndValidate()` (`tournament.mjs:342`) today: copies the whole workspace (`cp -R … :365`), deletes engine files by exact name (`:366`), counts deliverable files `D` (`:369`), runs the provenance gate `P` (`:364`), and if `D>0 && P==1` concatenates the files into `_pool.md` (`:369`).

In repo-anchored mode, change **only the per-candidate body of the staging script** (keep the schema, the `JEV <letter> d=.. p=..` line protocol, the fail-closed return contract, and `blindFail` — all unchanged):

```bash
# repoMode staging for candidate <blind>, worktree <ws>:
mkdir -p "<dest>"
# DIFF, not files. --no-color, no commit metadata, stable ordering. This is the blind artifact.
git -C "<ws>" diff "<baseSha>" HEAD --no-color --no-prefix > "<dest>/candidate.diff" 2>/dev/null
# D = "did this candidate change anything?" (the diff-mode analog of the file count)
D=$( [ -s "<dest>/candidate.diff" ] && echo 1 || echo 0 )
<provChk: provenance P is unchanged — it greps the ENGINE LOG, which lives OUTSIDE the worktree>
if [ "$D" -gt 0 ] && [ "$P" -eq 1 ]; then
  { echo "===== Candidate <blind> ====="; cat "<dest>/candidate.diff"; echo; } >> "<pool>"
fi
echo "JEV <blind> d=$D p=$P"
```

Why `git diff <baseSha> HEAD` and **not** the working tree: the commit (§5.3) is the gated, mergeable artifact; the diff the judge reads must be **exactly the diff that will be merged** (the §0 "validated ref = merged ref" property starts here). The diff uses `--no-prefix --no-color` and is computed against the *pinned base sha* so all N diffs are mutually comparable (§13). It carries **no author/committer/date/branch metadata** — a plain unified diff — so the blind pool is leak-free without any post-hoc scrub.

The `judgePrompt` (`tournament.mjs:199`) line that offers per-candidate dirs for execution ("its individual files are in its own directory", `:203`-region) must, in repo-anchored mode, instead point the judge at the **diff plus the test/lint summary** (§14) — the judge ranks the *change*, not loose files. (See §14 for the enrichment that makes "judge a diff" reliable.)

---

## 6. Blindness / integrity: the NEW leak vectors a commit introduces, eliminated by construction

**The question:** a worktree is a git repo; branch names, commit messages, author/committer identity, timestamps, and `.git` metadata are all new model-identity channels to the blind judge. How are they closed?

This is the gating pre-selection risk. The existing scrubbing only deletes *named engine files* during staging (`rm -f … _glm_run.log …`, `tournament.mjs:366`) and genericises failReasons via `blindFail` (`:469`); **none of it covers git metadata.** Rather than extend scrubbing (fragile — easy to miss a vector), I eliminate each vector *by construction*:

| Leak vector | Why it leaks | Elimination by construction |
|---|---|---|
| **Commit message** | A model that commits would phrase the message in its own voice/idiom. | **The harness commits, not the attempt** (§5.3), with a fixed literal message `joust attempt`. Attempts are forbidden any git command (§5.2 brief). |
| **Author / committer identity** | Default identity = the operator's git config, or worse, a model-set identity. | Fixed `GIT_AUTHOR_*`/`GIT_COMMITTER_*` = `joust@localhost`, identical for all N (§5.3). |
| **Timestamps** | Commit/author dates correlate with how long a model took → speed fingerprints the provider (GLM slow, local slower). | Pin both dates to the **base commit's date** (§5.3) — constant across candidates, uncorrelated with run time. |
| **Branch name** | `jewt/.../candidate-1` is fine, but a model-chosen branch would leak. | Harness-chosen, label-based, **never shown to the judge** (the judge reads `_pool.md` diffs + per-candidate diff files, never `.git`). Attempts cannot create branches (§5.2). |
| **`.git` metadata in the staged dir** | If staging `cp -R`'d the worktree it would copy `.git` (a linked-worktree `.git` *file* pointing into the main repo) → judge could read refs/reflogs. | Repo-anchored staging **never copies the tree** — it emits a single `git diff` text file (§5.4). `.git` never reaches `<dest>`. |
| **Diff content fingerprints** | Models have idiom (comment style, naming). | *Irreducible and acceptable* — this is the actual work being judged, exactly as today's file-content judging already exposes. No change in posture. |

**The post-pick audit (§10) is the low-blindness-risk variant** — once the winner is chosen, identity is no longer in play, so the audit may see anything. This is the same observation v1 made and it is correct.

**A leak v1 missed:** the engine **provenance logs** (`_glm_run.log` etc., grepped by `provCheckShell`, `tournament.mjs:310`) must continue to live **outside** the worktree (in `ws`'s sibling space or the run dir), because if a worker wrote its log *inside* the repo working tree, `git add -A` (§5.3) would commit it into the diff and leak the provider token straight into `_pool.md`. **Decision:** keep engine logs at `${runDir}/round-k/<label>/_*.log` *as siblings of the worktree, not inside it* — i.e. the worktree checkout is a subdirectory and the logs sit beside it — OR add `_*run.log` to the worktree's `.git/info/exclude` before the worker runs so `git add -A` can never stage them. I recommend **both** (defense in depth): logs outside the tree *and* an exclude entry.

---

## 7. Winner-as-mergeable-ref: collapsing the implementer hop

**The question:** once the blind judge picks, how does the loop "implement" the winner?

**Decision:** in repo-anchored mode, replace SKILL Phase-7 step 5 (`SKILL.md:226`, "Spawn Task … joust-implementer") with **adopt the winner's existing branch**. The winner's worktree branch `jewt/<runId>/<round>/<winnerLabel>` already contains the exact, gated commit. There is no re-derivation, no Opus implementer pass, and — critically — **no interpretation drift** between a text proposal and code.

The implementer agent (`agents/joust-implementer.md`) is **retained for self-contained/legacy `repoMode:false` grand loops only** and explicitly removed from the repo-anchored critical path. Its self-description as *"the single audited actor that writes to the real repo"* (`:3,8`) is now **false for repo-anchored mode** and must be amended to scope it to legacy mode — otherwise the agent file silently misrepresents the safety model (see §16, a rough edge). The §8 gate is what carries the safety guarantee in the new mode.

---

## 8. The safety-model shift (load-bearing) AND the `verify_safe_diff` inversion

**The question (the spine):** what guarantee disappears, what replaces it, and what ordering does that force?

### 8.1 The guarantee removed

Today: *"the single audited actor (the Opus implementer) is the sole writer to the real repo"* (`agents/joust-implementer.md:3`). Trust flows from there being exactly one, audited, high-capability actor that produces every byte that reaches an `JE-` branch. The implementer is even constrained to the "smallest coherent change" and forbidden destructive git (`:20`-region) precisely to keep that one actor auditable.

The moment an untrusted attempt (GLM / local MLX / codex / minimax) becomes the mergeable ref (§5.3, §7), **that guarantee is gone.** An untrusted model now authored code that — absent a gate — would reach a human's PR queue and possibly their CI, with the operator's credentials in scope.

### 8.2 The replacement

The **post-pick validation gate** is no longer "extra" — it is the *sole* remaining safety boundary:

- **(a) `run_verify`** against the winner's *actual worktree* (real tests/build/lint), with the new wall-clock timeout (§9).
- **(b) a nested `@@JE` security audit** of the winner's diff, ensemble-synthesized (§10).

Both must be **fail-closed**: any failure, timeout, or inability to run routes to runner-up (re-gated) or `needs-human` + HALT (§9). The architecture trades *"trust one Opus actor"* for *"validate any actor's output, fail-closed, before it can reach a human."*

### 8.3 The `verify_safe_diff` inversion (the landmine v1 missed entirely)

`run_verify` calls `verify_safe_diff` **first** (`bin/je-git.sh:196`) and **refuses (rc 1)** if the change touches any verify-executable file: `package.json`, `Makefile`, `pyproject.toml`/`setup.py`/`setup.cfg`/`tox.ini`, `conftest.py`, `Cargo.toml`/`build.rs`, `go.mod`, `test_*.py`/`*_test.py`/`*_test.go`, `.github/workflows/*`, git hooks (`:140–152`). This gate was designed (issue #21) for the *implementer* model, where the implementer's change touching those files meant *"a proposal is smuggling code into `make test`/`pytest` to run under operator credentials."* There, refusing → human review was exactly right and rarely fired.

**Under the new model this gate inverts into a near-universal block.** A repo-anchored winner's *entire purpose* is to add a feature/fix that, in any real project, **routinely** edits `package.json` (a script/dep), a `Makefile`, a `conftest.py`, or — most damningly — **adds/changes a test file** (`test_*.py`, `*_test.go`). Every such winner would hit `verify_safe_diff` rc 1 → `needs-human` + HALT. The gate stops being a guard and becomes a wall that fails ~every loop.

**This is not a footnote — it must be resolved before Phase 3 (the gate) ships.** Three options, with my decision:

1. ~~Loosen `verify_safe_diff` to allow these files~~ — **rejected.** That re-opens exactly the verify-time-RCE hole issue #21 closed; an untrusted attempt could put `os.system("curl …")` in a `conftest.py` and have `pytest` execute it under operator creds. With untrusted authors this is *more* dangerous than under the implementer.
2. **Sandbox the verify run** so executing attacker-authored build/test config is contained, then drop the `verify_safe_diff` refusal *inside the sandbox only*. **This is the right long-term answer** but it is a substantial, separate piece of infrastructure (container/VM/`sandbox-exec`), and the engine deliberately has no such facility today.
3. **Keep `verify_safe_diff` as a HARD gate, and make the security audit (§10) carry the load for the "did this change executable config maliciously?" question, then run verify in a sandbox.** Sequence it: the audit reviews the *full diff including* the build/test-config changes (it is reading text, not executing) and must explicitly clear them; only an audit-cleared diff is allowed to proceed to a sandboxed `run_verify` that *executes* that config.

**Decision (staged):**
- **Phase 3 (first gate ship):** `verify_safe_diff` stays a hard refuse. A winner that touches verify-executable files is routed to **`needs-human` + HALT** (fail-closed), *with a clear PR note that this is expected under the new model and human review is required because the change edits executable build/test config.* This is safe and shippable immediately, even though it means many repo-anchored winners go to human review at first. **This honesty is the correct fail-closed default** — better a wall than an unsafe auto-merge path.
- **Phase 4 (audit):** the nested audit reviews the build/test-config changes as text and records findings.
- **Phase 6 (sandbox, the unblock):** add a sandboxed verify runner; only then relax the refusal *inside the sandbox*, so an audit-cleared, sandbox-verified winner touching `package.json`/tests can flow to a normal PR. Until Phase 6 lands, repo-anchored mode is **safe but conservative** (config-touching winners → human). That is an acceptable, deliberately-staged posture.

### 8.4 The ordering rule this forces

**No capability-increasing phase ships before the gate that contains it.** Concretely:
- Phase 1 (worktree attempts) is *capability-neutral* — it changes how attempts are produced and judged but the winner is still adopted by the **existing** implementer-or-nothing path until Phase 2. It can ship first.
- **Phase 2 (winner-as-ref adoption) MUST NOT ship before Phase 3 (the gate).** The day an untrusted commit can become the adopted `JE-` branch is the day the gate must already exist. → Phase 3 ships *with or before* Phase 2 is *enabled*; we ship the code for Phase 2 but **feature-flag the adoption path off until Phase 3's gate is in place** (see §15 ordering).

---

## 9. `run_verify` against the real winning tree: the timeout, and the fallback policy

**The question:** what does `run_verify` need to safely test the winner's worktree, and what happens on failure?

### 9.1 The only missing hardening: a wall-clock timeout

`run_verify` (`bin/je-git.sh:193`) already: gates via `verify_safe_diff` (`:196`), drops secrets (`:201`), reads frozen commands from stdin (`:208`-region), refuses live re-detect on empty input → rc 2 (`:214`-region), runs each command as argv with no `eval` (`:226–228`), is fail-fast and never masks rc (`:230`-region). **The single gap is that any one verify command can hang forever** — and the file header explicitly notes macOS has **no `timeout`/`gtimeout`**.

**Decision — a portable, correct per-command watchdog (no `timeout` dependency).** macOS-safe, no GNU coreutils. The watchdog is a separate function so it is unit-testable in isolation:

```bash
# je_run_with_timeout <secs> -- <cmd argv...>   prints rc; 124 == timed out (GNU-compatible code)
je_run_with_timeout() {
  local secs="$1"; shift
  [ "$1" = "--" ] && shift
  "$@" &                       # run the verify command in the background
  local cmd_pid=$!
  ( sleep "$secs"; kill -TERM "$cmd_pid" 2>/dev/null
    sleep 2; kill -KILL "$cmd_pid" 2>/dev/null ) &   # escalate TERM->KILL after a grace period
  local watch_pid=$!
  wait "$cmd_pid" 2>/dev/null; local rc=$?
  kill -TERM "$watch_pid" 2>/dev/null; wait "$watch_pid" 2>/dev/null
  # If the command was killed by the watchdog, normalise to 124.
  if [ "$rc" -ge 128 ]; then rc=124; fi
  return "$rc"
}
```

Pitfalls deliberately avoided (these are the exact "fragile timeout control flow" defects the priors flag): the watchdog PID is `wait`ed and reaped so it cannot leak; the command runs as `"$@"` argv (consistent with `run_verify`'s existing no-`eval` posture, `:226`); a `kill -KILL` escalation handles processes that ignore TERM; rc≥128 (killed-by-signal) is normalized to **124** so the caller distinguishes timeout from a genuine nonzero exit. Wire it into the existing loop at `bin/je-git.sh:226–228`: replace `if "${words[@]}"; then` with `if je_run_with_timeout "$JE_VERIFY_CMD_TIMEOUT" -- "${words[@]}"; then`, and add a `JE_VERIFY_CMD_TIMEOUT="${JE_VERIFY_CMD_TIMEOUT:-600}"` near the other `JE_*` env defaults (`bin/je-git.sh:35`-region). A 124 is a verify FAIL (treated as rc 1 by the caller's routing).

Also: **`detect_verify` must run against the winner's worktree, not the base tree** in repo-anchored mode, because the winner may have *added* a test suite (`detect_verify` greps for `package.json` scripts, `pytest`, etc., `bin/je-git.sh:61–96`-region). Freeze the command set from the **winner's** tree at gate time (after un-blinding), not at preflight — but freeze it *once* and pipe it in, preserving the "no live re-detect on a mutated tree" property (`:214`). This is a behavioral change scoped to repo-anchored mode only.

### 9.2 Gate-failure fallback policy

**Decision (answers v1 Open Q #4) — bounded automatic fall-back to the runner-up, then `needs-human` + HALT.** Rationale: a single fall-back recovers the common case (the winner had a flaky/real test failure but the #2 candidate is clean) without a human, while a *bounded* fall-back (try at most the next 1 ranked candidate, not the whole list) prevents the gate from silently merging the 5th-best just because it happened to pass — which would defeat the tournament's quality signal.

Algorithm, run by the SKILL Phase-7 driver after un-blinding:
1. Gate the ranked #1 winner: `run_verify` (with timeout) **and** the audit (§10) both pass → adopt (§11). Done.
2. If either fails: gate the ranked #2 candidate the same way. If it passes → adopt #2, **annotate the PR** that #1 failed the gate and #2 was used (full transparency). Done.
3. If #2 also fails (or there is no #2): **`needs-human` + HALT** the whole chain — compose a draft PR off the #1 winner's branch with the verify log tail (`je_append_verify_tail`, `bin/je-git.sh`) and the audit findings, label `needs-human` (`open_pr_needs_human`, `:426`), and stop. This preserves the existing fail-closed contract (`SKILL.md:231`).

`verify_safe_diff` rc 1 (config-touched, pre-Phase-6) is **not** a "try runner-up" failure — the runner-up will almost certainly touch config too. It routes **straight to `needs-human` + HALT** with the §8.3 explanatory note. (Avoids burning the fall-back on a structural block.)

---

## 10. The nested `@@JE` security audit: ensemble synthesis, not competitive ranking

**The question:** how is the audit run, and what are its semantics?

**Feasibility (v1 is right here, confirmed against `SKILL.md:214`):** the grand-loop driver is the **main agent** invoking the `Workflow` tool, and `tournament.mjs` is unchanged with no nested-workflow. So the audit is a **second, sibling `Workflow(tournament.mjs)` call** — not `workflow()` inside `workflow()` — so the one-level nesting limit does not apply. The driver supplies `args.assignment` directly, bypassing the interactive gate exactly as the main tournament already does in a grand loop.

**Audit invocation:** `task = "Security-audit this diff. Report every vulnerability, injected-execution path, credential/secret risk, and supply-chain/build-config risk you find, with severity. This is the only safety review before a human sees this change."`, `assignment = [opus, glm-5.2]` (N=2, the documented Top-Mixed N=2 case, `SKILL.md:113`), `contextFiles = [<winner's candidate.diff>]` (so both auditors read the exact gated diff via the existing bundling path, `tournament.mjs:132`).

**The semantic error to avoid (the prior flagged this, and v1 *invited* it):** the existing `judge()` (`tournament.mjs:407`) is a **competitive ranker** — it picks ONE winner and discards the rest (`RANK_SCHEMA`/`REVIEW_SCHEMA`, `:441`-region). **A security audit must be union-of-findings ensemble synthesis: every finding from every auditor is retained, de-duplicated, and severity-reconciled.** Picking "the better audit" and discarding the other *loses real findings* — if Opus catches an injection and GLM catches a secret leak, ranking keeps one and drops the other. That is a safety regression, not a style choice.

**Decision — do NOT reuse the competitive `judge()` for the audit.** Two viable shapes; I recommend the first:

1. **Run the two audits as parallel attempts (no competitive judge), then a dedicated Opus *reconciler* pass that takes the union.** The reconciler prompt is explicitly *synthesis* ("merge these N audits; keep every distinct finding; de-dup; assign the max severity any auditor gave a shared finding; output a single findings list and an overall verdict PASS|FAIL where ANY high/critical finding ⇒ FAIL"). This needs a small new schema (`{ findings: [{title, severity, evidence}], verdict }`) — it does *not* reuse `RANK_SCHEMA`. Because the auditors are not ranked against each other, blindness is irrelevant here (post-pick), which simplifies it.
2. Run the audit tournament normally but treat the verdict as advisory and have the driver itself union the per-candidate `pros/cons`/reasoning. Weaker — the competitive prompt biases auditors toward "beat the other audit" rather than "find everything."

**Fail-closed wiring:** the audit's `verdict` is ANDed with `run_verify` in §9. **Audit FAIL ⇒ gate FAIL** (→ runner-up / needs-human). An audit that *errors* (judge `__failed`, `tournament.mjs:407`) is also a gate FAIL — never "audit unavailable, proceed." This is the fail-closed default the whole safety spine rests on.

**Cost:** +2 attempts +1 reconciler Opus per loop, within the projected grand-loop envelope (`SKILL.md` Phase-0b cost line, `:88`-region).

---

## 11. Winner adoption: merge mechanics + authorship (preserve "validated ref = merged ref")

**The question:** fast-forward, merge-commit, or cherry-pick — and whose authorship?

**Decision (answers v1 Open Q #2) — adopt the winner's EXACT gated commit; do not re-author, squash, or cherry-pick.** The single most important correctness property is: **the commit that was verified+audited (§8–§10) is byte-for-byte the commit that lands on the `JE-` branch and reaches the PR.** Cherry-pick, squash, or a re-commit *changes the tree's identity* (new sha, new author/committer, possibly a re-resolved diff) — so what a human reviews/merges is no longer the artifact the gate cleared. That is a real, subtle safety gap (the prior explicitly warns against it).

Mechanics — reuse the existing branch-naming + push helpers, with one change to how we reach the branch:

1. The winner already lives on `jewt/<runId>/<round>/<winnerLabel>` (§5.1) with the gated commit at its HEAD. The grand-loop's PR branch must be named `JE-<k>-<rand7>` (`je_branch`, `bin/je-git.sh` ~`:` region; the SKILL hard-requires the `JE-` prefix so `commit_and_push`'s guard at `:350` accepts it).
2. **Create `JE-<k>-<rand7>` pointing at the winner's exact commit, with no new commit:**
   ```bash
   BR="$(bash je-git.sh je_branch <k>)"     # JE-<k>-<rand7>
   git branch "$BR" "jewt/<runId>/<round>/<winnerLabel>"   # JE- branch = the EXACT winner commit (no new sha)
   git push -u "<remote>" "$BR"
   ```
   This is a pure ref alias of the gated commit — fast-forward-equivalent, zero re-authoring.
3. **`commit_and_push` (`bin/je-git.sh:336`) is NOT used for adoption in repo-anchored mode.** Its design assumes an UNSTAGED implementer diff to `git add -A` (`:354`) and commit (`:356`); here there is already a commit and nothing to stage. Reusing it would create a redundant empty commit (it would hit the empty-diff refuse, `:356`) or re-author. **Add a sibling `adopt_winner_branch <flBranch> <base> <winnerWorktreeBranch>` helper** that does the `git branch <flBranch> <winnerWorktreeBranch>` + guarded push above, with the same remote-resolution (`je_resolve_remote`) and `JE-*`/rc-propagation guards as `commit_and_push`. Keep `commit_and_push` untouched for the legacy implementer path.
4. **Authorship metadata** on the adopted commit is the fixed `joust@localhost` from §5.3. That is honest (no model is impersonated, no human is mis-credited) and uniform. The PR body records the *actual* winning model (un-blinded) so attribution is preserved in prose without polluting git identity. (Answers v1 Open Q #2's "whose authorship": **a fixed synthetic identity; real model in the PR body.**)

---

## 12. Worktree resource & lifecycle management

**The question:** add/remove discipline, disk cost, the ~N×2 trees for two-pass.

- **Count:** single-pass = N worktrees; **two-pass = up to 2N+1** (N round-1 + N round-2 + the carried-over round-1 winner — which is *already a worktree*, so no extra checkout, just kept alive). v1 said "~N×2"; the precise number is **2N** live at peak in two-pass, since the carryover reuses its existing tree.
- **Add discipline:** all `git worktree add` runs **serially**, once, in `buildWorktrees()` (§5.1), never inside parallel `dispatch()` (index-lock races).
- **Remove discipline (the part v1 underspecified):** worktrees must be removed in a **`finally`-equivalent step that runs even on judge/gate failure**, mirroring how the engine always writes summaries even on the P0–P6 failure paths (`tournament.mjs:680`-region onward). Concretely: after the winner is adopted (§11) **and** after any abort, run `git worktree remove --force <ws>` for every attempt's tree, then `git worktree prune`. **Do not delete the winner's branch** until the PR is open (the branch is the artifact); delete the *worktree* (the checkout) but keep the *branch ref*. The losing branches (`jewt/...`) are deleted (`git branch -D`) once staging has captured their diffs into `_pool.md` — the diff text is the only thing the judge needs, so the branch can go.
- **Disk:** each worktree is a full working-tree checkout (no extra object store — linked worktrees share `.git/objects`), so cost ≈ N × (working-tree size), not N × (repo size). For a normal source repo this is modest; preflight should still check headroom (§13/§15).
- **Crash safety:** an orphaned `jewt/<runId>/...` worktree from a died run is detected and cleaned by a `worktree prune` + a `git worktree list | grep jewt/<runId>` sweep at the start of the next loop, mirroring the existing `je_detect_orphan_branch` detect-and-stop posture (`bin/je-git.sh` orphan-branch fn) for the `JE-` branches.

---

## 13. Determinism: the single pinned base ref

**The question:** how is "one pinned base" guaranteed?

**Decision — pin to a resolved commit SHA, not a branch name.** v1 says "pinned base ref"; a *branch name* is not pinned — if anything advances `base` mid-run, different attempts (and the diff baseline in §5.4) would compare against different trees. At the start of a repo-anchored loop, the SKILL resolves `baseSha=$(git rev-parse "<base>")` **once**, passes `baseRef=<baseSha>` to the Workflow (§4), and **every** `git worktree add … <baseSha>` (§5.1), every `git diff <baseSha> HEAD` (§5.4), and the audit/verify all reference that one immutable sha. The two-pass round-2 worktrees branch off the **same** `baseSha`, not off round-1 results, so round-1 and round-2 candidates are mutually comparable (this matches the engine's existing design where round-2 attempts get only guidance, never round-1 code — `SKILL.md` Phase 4). Pinning a sha also makes the run reproducible and makes the §11 "exact gated commit" property meaningful.

---

## 14. Test/lint enrichment feeding a blind-safe summary to the judge (issue #32)

**The question:** the original #32 idea — a small/fast agent runs tests+lint per candidate and feeds a blind-safe summary to the judge — presupposes worktrees. How does it slot in?

This is **Phase 5**, and it is what makes "the judge ranks a *diff*" reliable (a diff is harder to eyeball than a file; pass/fail signal compensates). Mechanics, reusing existing patterns:

- After staging (§5.4) but before the blind `judge()` (`tournament.mjs:407`), a **cheap haiku/local agent runs `run_verify` + lint inside each candidate's worktree** (the tree still exists at this point — removal is deferred to §12's finally). One agent, one deterministic shell script per candidate (the `stageAndValidate` haiku+Bash pattern), each command wrapped in the §9 timeout so a candidate's hung test cannot stall the round.
- It emits a **blind-safe, per-candidate summary**: `tests: 12 pass / 1 fail`, `build: ok`, `lint: 3 warnings` — **letters only, no model identity, no provider-specific strings** (laundered exactly like `blindFail`, `tournament.mjs:469`). This summary is appended to each candidate's section in `_pool.md` (the file the judge reads once, `tournament.mjs:369`), so rankings reflect real pass/fail + lint, not just code-reading.
- **Blindness caution:** the summary must be scrubbed of anything provider-specific (e.g. a stack trace path mentioning a model, a timeout that fingerprints a slow provider). Keep it to **counts + ok/fail booleans**, never raw logs, in the blind pool. (This is the §6 discipline applied to the enrichment channel.)
- **This is independent of the safety gate.** The §8–§10 *post-pick* gate is the safety boundary; the §14 enrichment is a *pre-pick quality signal*. They run on the same worktrees but serve different purposes — do not conflate them (the pre-pick test run informs ranking; the post-pick run is authoritative for adoption).

---

## 15. Phase breakdown: ordering, hard dependencies, per-phase rollback/abort

Derived from the §8.4 ordering rule. Each phase is independently shippable and reversible behind the `repoMode` flag (which keeps `repoMode:false` byte-identical to today).

| Phase | Delivers | Hard deps | Real touch-points | Rollback / abort criterion |
|---|---|---|---|---|
| **P0 — Mode plumbing** | `repoMode`/`baseRef` parsed + threaded; `repoMode && z<2` is a parser error. No behavior change yet. | none | `je-parse.mjs:15,317,539,661`; `tournament.mjs:132`; `SKILL.md:25,62` | Pure additive; revert the flag. Abort if `je-parse` test suite (the documented test export, `:` exports block) shows any drift in existing `Z=1`/`@@JE:N:M` parses. |
| **P1 — Worktree attempts (capability-NEUTRAL)** | `buildWorktrees()`, repo-anchored `brief()`, harness-commit (§5.3), diff-staging (§5.4), fixed identity (§6). Winner still adopted by the **existing** implementer-or-nothing path (Phase 2 OFF). | P0 | `tournament.mjs:46,120,145,162,342,366,369` | Disabled by `repoMode:false`. **Abort if** any candidate's diff in `_pool.md` carries git metadata (leak check), or `git add -A` ever stages an engine log (§6). Roll back to scratch-dir staging. |
| **P3 — Validation gate (verify+timeout+audit), gate-fail policy** | §9 timeout in `run_verify`; `detect_verify` on winner tree; runner-up/needs-human fallback; **the nested audit (§10) ships here too** because the gate is incomplete without it. | P1 (needs a real winner tree to gate) | `je-git.sh:35,193,196,201,226`; new `je_run_with_timeout`; `SKILL.md:227,231`; sibling Workflow call | **Must ship before P2 is enabled (§8.4).** Abort if the timeout watchdog leaks PIDs or fails to escalate (unit-test in isolation). Roll back: keep gate, disable adoption. |
| **P2 — Winner-as-ref adoption** | `adopt_winner_branch` helper (§11); SKILL Phase-7 step-5 replaced; implementer scoped to legacy. **Enabled only once P3's gate is live.** | **P3 (hard — the spine)** | `je-git.sh:336` (new sibling fn); `SKILL.md:226`; `agents/joust-implementer.md:3` (scope amend) | **Abort if** an adopted `JE-` commit's sha ≠ the gated commit's sha (the "validated ref = merged ref" invariant). Roll back to implementer hop (`repoMode:false`). |
| **P5 — Test/lint → judge enrichment** | §14 blind-safe per-candidate test/lint summary in `_pool.md`. | P1 | `tournament.mjs:369,407,469` | Pure additive to the pool; abort if any provider-specific string reaches the blind pool. Strip the enrichment block. |
| **P6 — Sandbox verify (the `verify_safe_diff` unblock)** | Sandboxed `run_verify`; relax the §8.3 refusal *inside the sandbox only* so config-touching winners can reach normal PRs. | P3 | `je-git.sh:124,193` | Highest-risk phase. Abort if the sandbox can reach network or operator creds (`run_verify`'s secret-drop, `:201`, is the floor; sandbox is the ceiling). Until P6, config-touching winners → needs-human (safe). |

**Ordering note:** P3 is numbered before P2 deliberately — **the gate must exist before the capability it contains is enabled.** P5 and P6 are independent leaves and can be scheduled by appetite. The non-`repoMode` path (and all `Z=1`) is untouched throughout, so each phase is shippable to `main` without risk to today's users.

---

## 16. Rough edges, disagreements with v1, and honest gaps

- **Disagreement with v1 #1 (deliverable = commit):** v1 says "the deliverable becomes a commit (the attempt's HEAD)." I have the **harness** commit with fixed identity *after* the attempt stops, and forbid the attempt any git command — because letting an untrusted attempt author the commit re-introduces the message/author/timestamp leak vectors v1 itself lists as risks. Eliminating by construction beats scrubbing.
- **Disagreement with v1 #2 (merge mechanic):** v1's Open Q leaves cherry-pick on the table. I reject cherry-pick/squash outright: they break "validated ref = merged ref." Adopt the exact commit via a branch alias.
- **Correction of v1 #3 (run_verify):** v1's "add secret-scrubbing / switch off `eval`" is already done; the *only* gap is the timeout. A maintainer following v1 would waste effort and miss the real gap.
- **The `verify_safe_diff` inversion (§8.3) is the biggest thing v1 missed.** It is load-bearing: without resolving it, repo-anchored mode either fails ~every loop (hard gate) or re-opens an RCE hole (loosen). My staged answer (hard gate → human now; sandbox unblock later) is safe but means repo-anchored mode is *conservative until P6*. That is a real, acknowledged limitation, not a bug.
- **Rough edge — the implementer's self-description goes stale (§7).** `agents/joust-implementer.md:3` calls itself "the single audited actor"; that is false in repo-anchored mode. P2 must amend that file's scope, or the safety model is misdescribed in-tree. Easy to forget; called out here.
- **Honest gap — sandbox design (P6) is sketched, not specified.** Whether it is a container, a VM, or macOS `sandbox-exec` depends on the operator's environment and is out of scope for this plan; I specify only its *invariants* (no network, no operator creds, executes the audit-cleared diff). Treat P6 as "design TBD, invariants fixed."
- **Honest gap — git version assumptions.** `git worktree add -b … --no-checkout` and `git worktree remove --force` are assumed available; preflight (§12/§15 P3) should assert a minimum git version, otherwise the `buildWorktrees` fallback path (§5.1) is the safety net.

---

## 17. Answers to every v1 Open Question (decision + rationale + fallback)

1. **Repo-anchored detection: opt-in or auto-detect?** → **Explicit opt-in, defaulting on for `Z>=2` and forbidden for `Z<2`** (§4). Rationale: capability escalation must be deliberate; the parser is contractually non-heuristic; `Z>=2` is the only mode that writes to a repo. *Fallback:* if the `Z>=2` coupling proves too coarse, add a standalone `repo-anchored` keyword (already specified) without changing the parser's error discipline.
2. **Merge mechanic + authorship?** → **Adopt the winner's exact gated commit via a branch alias (no re-author/squash/cherry-pick); authorship = fixed `joust@localhost`; real model recorded in the PR body** (§11). Rationale: preserves "validated ref = merged ref"; honest identity. *Fallback:* if a project requires a single squashed commit, squash *only after* re-running the full gate on the squashed result (never adopt an ungated tree).
3. **Audit ensemble: fixed `[opus, glm-5.2]` or configurable; synthesis or reconcile step?** → **`[opus, glm-5.2]` default, configurable via the same `assignment` plumbing; a DEDICATED Opus reconciler doing union-of-findings synthesis, NOT the competitive `judge()`** (§10). Rationale: an audit must keep every finding; reusing the ranker discards half. *Fallback:* if a reconciler pass is too costly, union the raw per-auditor findings programmatically in the driver (no second LLM) — still never rank-and-discard.
4. **Gate-failure policy: auto runner-up or always needs-human?** → **Bounded auto fall-back to the ranked #2, then `needs-human` + HALT; `verify_safe_diff` rc 1 skips the fall-back and goes straight to human** (§9.2). Rationale: recovers the common flaky-#1 case without a human while keeping the quality signal and the fail-closed contract. *Fallback:* a config knob to set the fall-back depth to 0 (always needs-human) for high-stakes repos.
5. **Worktree blindness: scrub git metadata, or fixed identity?** → **Fixed identity + harness-made commit + pinned timestamps + diff-only staging — eliminate the vectors by construction; scrubbing is the inferior backup** (§6). Rationale: scrubbing is fragile and easy to under-cover; construction is robust. *Fallback:* if some path must copy a tree, add a `.git`-excluding scrub mirroring the `rm -f` allowlist (`tournament.mjs:366`) — but prefer never copying `.git`.
6. **Should self-contained tasks ever get worktrees?** → **No — `Z=1`/self-contained tasks keep the scratch-dir model unchanged** (§4). Rationale: no PR target, pure overhead, and keeping that path byte-identical is what makes every phase shippable without risk. *Fallback:* none needed; this is the conservative default.

---

*Engineering plan v2. Grounded against the live tree on `main`; every file:line re-verified at its real offset. The safety spine (gate replaces the single-audited-actor guarantee; no capability ships before its gate) drives the phase ordering and every abort criterion.*
