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
                emits an objective PASS/FAIL. Verdict is carried into review.
9. ELECT        Judge sees code + test verdict. Top-2/3 playoff: surviving agents
                review each other's work and debate (bounded rounds, may include
                1–2 improvement passes) until 2/3 agree; judge breaks deadlock.
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
