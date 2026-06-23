# Joust Engine — Loop Architecture (design north star)

Status: proposed (design discussion, 2026-06)
Scope: defines the canonical shape of a Joust Engine grand loop and the work
breakdown to get there. This is a reference document, not yet implemented.
Companion work items live in `docs/dogfood/inbox/` (file via `bin/je-issue.sh`).

---

## 1. Premise (what JE optimizes for)

JE monetizes **sunk subscription capacity** — paid-for model/harness throughput
that would otherwise go unused — **not** marginal cost efficiency. Two consequences
shape every design choice below:

- **Discarded attempts are the product, not waste.** A losing attempt explored a
  region of the solution space; its value is realized as *distilled feedback*
  (both "converge here" and "be aware / dead-end") that sharpens the next round.
- **Effort is allocated asymmetrically across rounds.** Round 1 is wide and
  exploratory (max attempts, max diversity). Round 2 is narrow and refined: only
  the **top-K** candidates from round 1 advance, carrying the distilled learning.

The grammar axes are unchanged:

- **N** — attempts per design/build round.
- **M** — passes (1 = single, 2 = explore→distill→refine→select).
- **Z** — number of unattended grand loops (chained tasks). Z keeps its current
  meaning; the richer structure below lives **inside** each loop.

A new **plan-only** mode (signalled by its own token, not by overloading Z) stops
each loop after the plan is judged, emitting the winning plan instead of code.

---

## 2. The canonical loop (one grand loop, repeated Z times)

```
1. DEFINE       Pin the task + explicit acceptance criteria.
2. RESEARCH     Sub-agents gather the shared CONTEXT PACK: project truths,
                conventions, planning docs, relevant files. One pack, threaded
                identically into design, build, and review (fairness + grounding).
3. DESIGN       N1 plan attempts, BLIND, diversity-injected (Pool A/B).        [wide]
4. DISTILL      Blind review of the N1 plans → two-channel distillation:
                  (+) converge here     (−) dead-ends / be-aware
5. RE-DESIGN    Top-K plans advance; N2 fresh plans (N2 < N1) with the step-4
                distillation injected.                                          [narrow]
6. JUDGE        Winning plan selected.
   ── gate ──   plan-only mode?  → STOP loop here; emit plan (+ PR).
                else ↓
7. BUILD        Parallel implementation in worktrees, from the winning plan.
8. TEST-GATE    A small fast model enters each worktree, runs lint + tests,
                emits an objective PASS/FAIL + structured verdict. Carried into
                review; an APPROVE may not pass without a present, passing verdict.
9. ELECT        Judge sees code + test verdict. Top-2/3 playoff: surviving agents
                deliberate SIMULTANEOUSLY against each other's pre-deliberation
                positions (one bounded round, may include 1–2 improvement passes)
                until 2/3 agree; judge breaks deadlock. A substantiated severity
                veto forces NO_CONSENSUS rather than being outvoted. Tally + outcome
                are computed in code, not by the writer.
   ── recovery ladder if ALL candidates fail ──
                (a) re-BUILD same plan + failure feedback  (cheap, first resort)
                (b) escalate: re-PLAN from step 3 with failure feedback
10. LAND        Output SECURITY GATE → implementer applies the winner → open PR.
```

Throughout, the **leaderboard ledger** records outcomes keyed by
`model × harness × nudge` so performance accrues across runs.

---

## 3. Key invariants (do not erode)

- **Blindness ends at step 6/9, never before.** Distillation (step 4) and the
  playoff (step 9) operate on candidates, not on model identities.
- **The test-gate is factual, not generative.** The fast model reports pass/fail;
  it never fixes code. Its verdict is the branch condition for the recovery ladder
  and the cheapest way to stop reviewing broken candidates.
- **Step 5's injected knowledge IS step 4's distillation object** — one auditable
  artifact carried forward, not a re-derivation.
- **Forge access stays confined to `bin/je-issue.sh`; repo writes stay confined to
  `bin/je-git.sh` + `joust-implementer`.** New gates compose with these, they do
  not open new write paths.
- **Fail-closed.** The output security gate (step 10) and the test-gate (step 8)
  halt the chain on a hit rather than proceeding.
- **Execution-evidence-required quorum.** An election may not return APPROVE / a
  winner on read-only opinion alone. The lens that actually ran the code (the
  test-gate verdict) must be present and passing; a missing or dead execution
  verdict downgrades the outcome to recover/BLOCK, never a silent APPROVE on a
  shrunk panel. The threshold is over the *full* intended panel, not over whoever
  survived — a dead reviewer is not an abstention that lowers the bar.
- **Severity veto over majority.** A substantiated, high-confidence BLOCK that
  carries concrete blocking issues (security or correctness) forces at least
  NO_CONSENSUS and escalates to a human; it is NOT outvoted by simple majority.
  Costs are asymmetric — a false APPROVE (ship the flaw) far outweighs a false
  BLOCK (re-review) for security-relevant changes.
- **Graders never touch the live tree.** Read-only review/judge lenses run against
  an isolated worktree, export, or pinned refs — never the operator's working
  checkout. Isolation is enforced by the harness (a separate worktree), not by a
  prompt instruction telling the model to behave.
- **Deterministic facts are computed, not model-judged.** Tallies, quorum/consensus
  booleans, and the elected outcome are computed in code and *passed into* any
  report writer. The model writes narrative only. Never let a clerk re-derive a
  fact the engine already knows — it can silently contradict the computed value.
- **One pinned revision for the whole panel.** Every lens/attempt judges the same
  pinned commit SHA, never a moving branch ref, so verdicts are commensurable.
- **Auditable deliberation.** Members revise once, against each other's
  pre-deliberation positions (no sequential anchoring). Record each member's pre-
  and post-deliberation vote; if deliberation flips the outcome (especially
  BLOCK→APPROVE), surface it and prefer NO_CONSENSUS over a silently herded verdict.

---

## 4. Work breakdown (sequenced)

Ordered by recommended build sequence. Self-contained, high-value gates first so
later stages have something factual to branch on.

| # | Item | Touches | Sev | Area |
|---|------|---------|-----|------|
| 01 | Output security gate before implementer applies winner | `je-git.sh`, implementer | sev2 | git |
| 02 | Test-gate: fast model lint/test in worktree → pass/fail | `je-git.sh`, new agent | sev2 | git |
| 03 | Research step / shared context pack | new agent, `SKILL.md` | sev2 | skill |
| 04 | Per-round N funnel (N1→N2) + top-K advancement | `je-parse.mjs`, `tournament.mjs` | sev2 | review |
| 05 | Two-channel (+/−) distillation as a required review field | `review-rubric.md`, `SKILL.md` | sev3 | review |
| 06 | Election / top-2/3 playoff (debate to 2-of-3) | new phase, `SKILL.md` | sev2 | review |
| 07 | Recovery ladder (re-build vs re-plan on all-fail) | `SKILL.md` Phase 7 | sev2 | skill |
| 08 | Plan-only mode + early exit (new grammar token) | `je-parse.mjs`, `SKILL.md` | sev3 | parse |
| 09 | Leaderboard ledger (`.je/ledger.jsonl`) keyed model×harness×nudge | `tournament.mjs`, new writer | sev3 | infra |

Each item is filed as a dogfood inbox draft with a one-line problem, this design
doc as the reference, and the touch-points above.

---

## 5. Mapping to Agentic Design Patterns (Gulli)

The structure above is a composition of the book's patterns, grounded in JE's
existing machinery:

- **Goal Setting & Monitoring** → step 1 acceptance criteria; step 8 test-gate.
- **RAG / Knowledge Retrieval** → step 2 shared context pack.
- **Parallelization** → steps 3, 7 (already JE's core).
- **Reflection** → step 4 two-channel distillation; step 9 playoff.
- **Multi-Agent / A2A** → step 9 cross-candidate debate.
- **Learning & Adaptation + Memory Management** → leaderboard ledger; future
  self-improvement target is optimizing sub-agent instruction sets, NOT cost.
- **Exception Handling & Recovery** → step 9 recovery ladder.
- **Guardrails / Safety** → step 10 output security gate (output-side, complementing
  the existing input/env-side verify gates).
- **Planning** → the whole design-before-build separation; plan-only mode.

Patterns deliberately NOT adopted: a unified/MCP provider adapter. Different
harnesses (Claude Code, Open Code, Cursor CLI, Grok Build) need bespoke handling;
fixed bash runners are a security boundary (the model cannot generate arbitrary
code to execute), and MCP is dated relative to Claude dynamic workflows.

---

## 6. Learnings from a reference council workflow

A dynamic-workflow "council" that reviews open PRs (3 role-specialized reviewers →
one simultaneous deliberation round → 2/3 vote → clerk report) was run as a live
probe of steps 8–9. It validated the shape and surfaced the invariants above. What
to carry into the JE election (step 9) and test-gate (step 8):

**Adopt as-is (the council got these right):**

- **Role-specialized lenses, not clones.** Reviewers split by *purpose* — one that
  builds/runs, one for security efficacy, one for regression/supply-chain — so each
  catches a different failure class. Perspective diversity > redundant agreement.
- **Structured verdict schema.** Each reviewer returns
  `{ vote, confidence, rationale, blocking_issues[], nonblocking_notes[], checks_run[] }`.
  `checks_run` (what was actually executed/read + the result) makes a verdict
  auditable and resists "looks fine" hand-waving. JE's review/election outputs
  should use the same shape; `blocking_issues` vs `nonblocking_notes` is exactly the
  +/− distillation channel from step 4.
- **Deliberation schema captures the shift.** The round-2 schema adds
  `{ changed_from_round1, response_to_peers, final_rationale }` — the raw material
  for the auditable-deliberation invariant.
- **Verify, do not trust.** Author claims and pre-generated evidence files are fed
  in explicitly labelled as claims to be re-checked, and the build lens re-runs the
  scan itself rather than trusting a supplied scan file.
- **`NO_CONSENSUS` is a first-class outcome**, and the elected position is computed
  deterministically (`approve>=2 ? APPROVE : block>=2 ? BLOCK : NO_CONSENSUS`).

**Fix before relying on it (became the new invariants in §3):**

1. **Quorum ignored execution evidence.** `votes = r2.filter(Boolean)` with an
   absolute `>=2` meant a dead build lens + two read-only APPROVEs could elect
   APPROVE with nothing ever built. → execution-evidence-required quorum.
2. **No severity veto.** A high-confidence security BLOCK could be outvoted 2-1 on a
   security PR. → severity veto over majority.
3. **Read-only lenses ran on the operator's live checkout** (`REPO=…/Dev/On2it`),
   read-only by prompt only, with two PR councils sharing that tree concurrently. →
   graders never touch the live tree (harness-enforced isolation).
4. **`tally`/`consensus_met` were re-derived by the clerk LLM** alongside the
   code-computed values, free to drift. → deterministic facts are computed, passed in.
5. **Lenses judged different revisions** — the build lens used the pinned head SHA,
   the read-only lenses diffed a moving `origin/<branch>`. → one pinned revision.
6. **Election used only round-2**, so round-1 dissent could vanish into groupthink
   even though the data was retained. → auditable deliberation (act on vote-flips).
