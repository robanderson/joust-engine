# Joust Engine — Git Worktree Implementation Plan

> **Umbrella issue:** [#32](https://github.com/robanderson/joust-engine/issues/32) · **Feeder:** [#30](https://github.com/robanderson/joust-engine/issues/30) (GLM reviewer) · **Evaluation branch:** `rob/test-agent-eval` · **Status:** design — not yet implemented

## Contents

1. [Overview & motivation](#1-overview--motivation)
2. [Current architecture (grounded)](#2-current-architecture-grounded)
3. [Proposed architecture](#3-proposed-architecture)
   - [3.1 Repo-anchored task mode](#31-repo-anchored-task-mode)
   - [3.2 Worktree-per-attempt](#32-worktree-per-attempt)
   - [3.3 Winner-as-mergeable-ref](#33-winner-as-mergeable-ref)
   - [3.4 Validation gate on the winner](#34-validation-gate-on-the-winner)
   - [3.5 Nested `@@JE` security audit](#35-nested-je-security-audit)
   - [3.6 Test/lint enrichment feeding the judge](#36-testlint-enrichment-feeding-the-judge)
4. [The safety-model shift (load-bearing)](#4-the-safety-model-shift-load-bearing)
5. [Phased implementation plan](#5-phased-implementation-plan)
6. [Challenges & risks](#6-challenges--risks)
7. [Relationship to #30 & the test/lint agents](#7-relationship-to-30--the-testlint-agents)
8. [Open questions](#8-open-questions)
9. [Grounding (file:line)](#9-grounding-fileline)

---

## 1. Overview & motivation

This document scopes an architectural evolution of the Joust Engine grand-loop, evaluated on branch `rob/test-agent-eval`. It is a **plan and design**, not a committed implementation.

Three goals drive it:

- **Speed** long-running parallel tasks and **save Anthropic tokens** by moving testing/diagnosis onto small/fast (or free local) models.
- **Relieve timeouts** — big premium models (Opus / GLM / Codex) time out precisely when they fall into build/test-and-iterate loops, which is why attempts are *forbidden* from testing today.
- **A structural simplification**: collapse the lossy "winning proposal → Opus implementer re-derives the code" hop, and validate the real winning code before it reaches a PR.

> [!IMPORTANT]
> **Core idea** — Make every tournament attempt a real **git worktree** branched off a pinned base. The winning attempt is then already a **mergeable ref** — "implementing" it is just taking its branch. Because the winner is a real tree, you can run real tests + a security audit on the *actual applied change* before merging.

## 2. Current architecture (grounded)

Today the tournament and grand-loop never touch `git worktree` at all (confirmed by repository-wide grep). The relevant mechanics:

- **Attempts are plain scratch dirs.** `cmdHead` at `workflows/tournament.mjs:120` is literally `mkdir -p <ws> && cd <ws>`. The brief (`:66–68`) says: single pass, write *one* solution file, *do not run or test it*.
- **Single-pass is enforced to avoid timeouts.** Local models that self-test fall into a verify-and-polish loop and time out (`tournament.mjs:106–107`, observed on Qwen). So code is generated *untested* and judged by reading.
- **Blind Opus judge** (`tournament.mjs:404`) is used for both review-1 (`:566`) and the final rank (`:630`). The winner is a *proposal*.
- **Grand-loop driver** is the main agent + `bin/je-git.sh`; there is explicitly *no nested grand-loop workflow* and `tournament.mjs` is unchanged (`skills/joust-engine/SKILL.md:214`). Per loop: tournament (Workflow) → implementer (Task, Opus) on an `JE-<k>` branch → `run_verify` → commit/push/PR.
- **The implementer re-derives code from the proposal.** `agents/joust-implementer.md:11`: the proposal is "a concrete, file-level change description, often with diffs"; `:18–19`: it reads the proposal, then *applies* the smallest coherent change to the real repo. It is "the single audited actor that writes to the real repo" (`:3`).
- **Verify is shell-only, no diagnosis.** `run_verify` (`bin/je-git.sh:125–173`) runs bare `eval "$c"` with **no timeout wrapper** (`:165`). On failure the chain HALTs and files a draft `needs-human` PR (`SKILL.md:231`) — no diagnosis, no retry.

```
  CURRENT (grand-loop, per loop)
  ┌────────────┐   blind Opus    ┌──────────────┐   proposal    ┌──────────────┐
  │ N attempts │ ──judge (:404)──▶│  winner = a  │ ──implementer─▶│ Opus RE-DERIVES│ ──▶ JE-<k> ──▶ PR
  │ (scratch    │                 │  PROPOSAL    │   (Task,Opus) │  the code      │     branch
  │  dirs)      │                 │  (text)      │               │  :11,:18-19    │
  └────────────┘                 └──────────────┘               └──────────────┘
        ↑ lossy hop: attempt code is thrown away; implementer rebuilds it from a description
```

## 3. Proposed architecture

### 3.1 Repo-anchored task mode

Worktrees only pay off when the deliverable is a *change to a real repo* (fix / extend / refactor THIS codebase), where the winner is a diff on a base ref. Today's tasks are self-contained ("write one file" to an empty workspace), for which a worktree is pure overhead. So this whole arc is gated on JE gaining a **repo-anchored task mode** — a new task class, opted in per run. Self-contained tasks keep the current scratch-dir model unchanged.

### 3.2 Worktree-per-attempt

For repo-anchored tasks, `dispatch()` (`tournament.mjs:160`) replaces `cmdHead`'s `mkdir` with a `git worktree add` from a **pinned base ref**. The brief changes from "write to an empty workspace" to "apply your change on this branch." The deliverable becomes a **commit** (the attempt's `HEAD`) on its own short-lived branch, not a loose file.

Knock-on changes: `stageAndValidate` (`:336`) and the blind `_pool.md` bundle (`:362`) capture *diffs* instead of files; the provenance/scrub logic (`:359–361`) extends to git metadata (see [Challenges](#6-challenges--risks)).

### 3.3 Winner-as-mergeable-ref

Once the blind judge picks, un-blind the result: the winning attempt's worktree branch *is* the implementation. The grand-loop "implements" the winner by taking that ref (merge / fast-forward / push) rather than re-deriving anything.

> [!TIP]
> **Why this is a simplification** — It **collapses the implementer hop** (`joust-implementer.md:11,:18–19`): no Opus re-derivation, and you preserve the *exact* winning code instead of the implementer's interpretation of a description. It also saves one Opus pass per loop.

### 3.4 Validation gate on the winner

Before the winner's branch becomes a PR, run a fail-closed gate against the *actual applied change* in its worktree:

- **Verify** — `run_verify` now has a real tree to run against (pytest / cargo / go / lint). Add the missing SIGALRM timeout (see Challenges).
- **Security audit** — a nested multi-model review of the diff (next section).

Gate failure → fall back to the runner-up, or file `needs-human` and HALT (preserving today's fail-closed contract, `SKILL.md:231`).

### 3.5 Nested `@@JE` security audit

The security review of the winning diff can itself be a **Joust Engine tournament** — e.g. 1 Opus + 1 GLM 5.2.

> [!TIP]
> **Feasible** — The grand-loop driver is the *main agent* invoking the `Workflow` tool for the tournament (`SKILL.md:214`). So a security audit is just a **second `Workflow({tournament.mjs})` call** with `task = "audit this diff for security vulnerabilities"`, `assignment = [opus, glm-5.2]` (N=2 — exactly the Top-Mixed N=2 preset, `SKILL.md:39,:113`), and the winner's diff as `contextFiles`. This is a *sibling* Workflow call by the main agent, not `workflow()`-inside-`workflow()`, so the platform's one-level nesting limit does not apply. The interactive model gate is bypassed because the driver supplies `args.assignment` directly — exactly how the main tournament already receives its assignment in a grand-loop.

**Semantics note:** N=2 is thin for a *competition*, but a security audit wants an *ensemble* — the Opus judge synthesizes the two audits into one verdict (union of findings + de-dup + severity), not winner-takes-all. The blind-judge machinery already does this reconciliation.

### 3.6 Test/lint enrichment feeding the judge

The original [#32](https://github.com/robanderson/joust-engine/issues/32) idea: a dedicated small/fast agent runs `run_verify` + lint *per candidate* and feeds a blind-safe summary into the pool the judge reads, so rankings reflect real pass/fail + lint — not just code-reading. Worktrees are what make this scalable: each candidate is already a runnable tree, so the test agent just runs `run_verify` in candidate-A's worktree.

## 4. The safety-model shift (load-bearing)

This is the most important consequence and the strongest argument *for* the nested audit.

> [!WARNING]
> **What changes** — Today the implementer is "the **single audited actor** that writes to the real repo" (`joust-implementer.md:3`) — safety comes from trusting that one Opus actor. If an untrusted attempt (GLM / local / codex) becomes the mergeable ref, that guarantee is **gone**.

> [!IMPORTANT]
> **Therefore** — The post-pick validation gate (verify + nested audit) is **not optional** — it is what *replaces* the implementer's safety guarantee. The architecture trades "trust one Opus actor" for "validate any actor's output, fail-closed, before merge." The audit upgrades from "extra" to **load-bearing**.

```
  PROPOSED (repo-anchored grand-loop, per loop)
  ┌──────────────┐  blind Opus   ┌─────────────┐  un-blind   ┌────────────────┐  fail-closed   ┌─────┐
  │ N attempts = │ ──judge (:404)─▶│ winner = a  │ ──────────▶ │ VALIDATION GATE│ ──────────────▶ │ PR  │
  │ N worktrees  │                │ git BRANCH  │             │ verify + audit │ (or needs-human)│     │
  │ off base ref │                │ (real code) │             │ on real tree   │                └─────┘
  └──────────────┘                └─────────────┘             └────────────────┘
        ↑ winner's branch IS the implementation — no re-derivation; audit is load-bearing, not optional
```

## 5. Phased implementation plan

Each phase is independently valuable and reversible; later phases depend on earlier ones.

| Phase | Delivers | Key touch-points |
|---|---|---|
| **0 — Task mode** | Repo-anchored task detection + opt-in (vs self-contained). | SKILL Phase 0; `je-parse.mjs` |
| **1 — Worktree attempts** | `dispatch()` does `git worktree add` from a pinned base; brief = "apply on this branch"; deliverable = commit; staging/bundle capture diffs. | `tournament.mjs:120,160,336,362` |
| **2 — Winner-as-ref** | New `je-git.sh` fn to merge/push the winner's branch; implementer retired (or optional) for repo-anchored tasks. | `je-git.sh`; SKILL Phase 7 |
| **3 — Validation gate** | `run_verify` on the winner's worktree + SIGALRM timeout; fall-back policy (runner-up / needs-human). | `je-git.sh:125,165`; `SKILL.md:231` |
| **4 — Nested audit** | Second `Workflow(tournament.mjs)` call: audit diff, `[opus,glm-5.2]`, ensemble synthesis. | SKILL Phase 7; `tournament.mjs` |
| **5 — Test/lint → judge** | Small/fast per-candidate test+lint agent feeding a blind-safe summary to the judge. | `tournament.mjs:336–404`; [#32](https://github.com/robanderson/joust-engine/issues/32) |

## 6. Challenges & risks

**Blindness / integrity (the gating risk, pre-selection)**
- A worktree is a git repo: branch names, commit messages, author/timestamps, `.git` metadata are all *new model-identity leak vectors*. Today's scrubbing deletes provenance logs by exact name (`tournament.mjs:359–361`) — it does **not** cover git metadata. Any per-candidate signal fed to the judge must be laundered like `blindFail()` (`:462`), and the test/audit agents must never see `displayModel`.
- The **post-pick** audit is the *low*-blindness-risk variant — model identity is no longer in play once the winner is chosen.

**Single-pass friction**
- A worktree makes it *easier* for an attempt to test-and-iterate — the exact timeout trap the brief forbids (`:66`). Discipline: the **test agent** runs tests *after* the attempt; the attempt stays single-pass.

**Resource cost**
- ~N worktrees per round (N×2 for two-pass), each a full checkout. Needs a disciplined `git worktree add` / `remove` lifecycle. Platform notes ~200–500 ms + disk each.

**Determinism**
- All N worktrees must branch from the **same pinned base ref** or testing/auditing isn't comparable.

**Audit cost & semantics**
- Nested audit adds ~2 attempts + 1 Opus judge per loop (already within the grand-loop's projected cost envelope, `SKILL.md:88`). Decide ensemble-synthesis vs. competitive ranking up front.

**The safety-model shift itself**
- The "single audited actor" property is load-bearing today. Removing it is only safe if the Phase-3/4 gate is robust and **fail-closed**. This is a design/cultural change, not just code.

## 7. Relationship to #30 & the test/lint agents

- [#30 (GLM reviewer)](https://github.com/robanderson/joust-engine/issues/30) feeds directly into the nested audit: the `[opus, glm-5.2]` mix and the "Claude directs + validates, GLM reasons" pattern are exactly what the audit tournament uses. The audit is a concrete consumer of #30's mechanism.
- The original [#32](https://github.com/robanderson/joust-engine/issues/32) (test/lint agents) becomes **Phase 5** here — it presupposes the worktree infrastructure of Phase 1.

## 8. Open questions

- Repo-anchored task detection: explicit opt-in flag, or auto-detect from the task?
- Merge mechanics for the winner's ref: fast-forward, merge-commit, or cherry-pick? Whose authorship metadata?
- Audit ensemble: fixed `[opus, glm-5.2]`, or configurable per run? Synthesis by the existing Opus judge or a dedicated reconcile step?
- Gate failure policy: automatic fall-back to runner-up, or always needs-human?
- Worktree blindness: scrub git metadata at staging, or run attempts under a fixed identity (same author/committer for all)?
- Should self-contained tasks ever get worktrees, or strictly repo-anchored only?

## 9. Grounding (file:line)

| Claim | Source |
|---|---|
| Attempts = plain scratch dir (`mkdir`) | `workflows/tournament.mjs:120` |
| Single-pass, do-not-test brief | `tournament.mjs:66–68` |
| Verify-polish loop causes timeouts | `tournament.mjs:106–107` |
| Blind Opus judge (both reviews) | `tournament.mjs:404` (review `:566`, final `:630`) |
| `dispatch()` branches per provider | `tournament.mjs:160–191` |
| Staging + blind pool + log scrub | `tournament.mjs:336,359–362` |
| `blindFail()` genericiser | `tournament.mjs:462` |
| Grand-loop driver: main agent + `je-git.sh`, no nested workflow, `tournament.mjs` unchanged | `skills/joust-engine/SKILL.md:214` |
| Implementer re-derives from proposal artifact | `agents/joust-implementer.md:3,11,18–19` |
| `run_verify`: shell, `eval "$c"`, no timeout | `bin/je-git.sh:125–173` (esp. `:165`) |
| Verify-fail → draft `needs-human` + HALT | `skills/joust-engine/SKILL.md:231` |
| Top-Mixed N=2 → `[opus, glm-5.2]` | `skills/joust-engine/SKILL.md:39,113` |
| No `git worktree` usage anywhere in-tree | grep across `workflows/`, `bin/`, `skills/`, `agents/` |

---

*Generated as a scoping/design artifact for [#32](https://github.com/robanderson/joust-engine/issues/32). Not a committed implementation; everything here is a plan to evaluate.*
