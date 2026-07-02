# Plan/Implement round split (tournament restructure)

Approved design decisions, 2026-07-03. Successor to the 5-judge council spec
(2026-07-02). Implementation via a Development Engine dogfood run once the council
changes are validated.

## Goal

Split the tournament into a cheap, wide **planning** phase and an optional, narrow
**implementation** phase — high-N diversity where artifacts are cheap to produce and
judge (plans), a small strong pool where they are expensive (code). Flatten
"implement" into the tournament itself; free grand loops (Z) to mean *separate tasks*.

## Round structure

| Round | Name | Runs | Pool (default) |
|---|---|---|---|
| 1 | **Plan Round 1** | always | 2 opus, 2 sonnet, 2 codex-high, 2 glm-5.2, 2 minimax (N=10) |
| 2 | **Plan Round 2** | always (two-pass spine: guidance from R1 review) | same pool, fresh diversity draw |
| 3 | **Implement Round 3** | only with the `implement` flag | 2 opus, 2 codex-high, 1 glm-5.2 (M=5) |
| 4 | **Implement Round 4** | **conditional**: only if R3 produces NO candidate passing the gates (verify fail / council NO_CONSENSUS / all vetoed) | same implement pool, guided by R3 review |

- Plan rounds produce PLAN artifacts (concrete file-level change proposals). Judged by a
  **plan council** (lenses: feasibility, completeness, risk, security-by-design,
  simplicity/proportionality). Plans never touch the repo.
- Implement rounds seed each implementer with the **winning plan verbatim** — an explicit,
  deliberate exception to the "never seed prior artifacts" rule (the plan IS the spec).
  Judged by the existing 5-lens **code council** (correctness/spec/security/robustness/
  craft) with enrichment + verify evidence.
- Implement rounds run **repo-anchored** (worktree-per-attempt, P3 gated commits) at ANY
  Z, including Z=1 — the `implement` flag is the PR-target signal repoMode currently
  lacks below Z=2. Winner = adoptable gated commit.
- Happy path with `implement` = 3 rounds total. R4 exists only as the guided retry.

## Invocation

- Phase-scoped prose model spec: `Plan: 2 opus, 2 sonnet, 2 codex high, Implement: 2
  opus, 2 codex high` (each phase segment uses the existing spec grammar; sums give N
  and M). `implement` keyword (or a non-empty Implement: spec) enables rounds 3–4.
- Omitted pools fall back to the defaults in the table above.
- Existing sigil forms stay valid; `@@JE:N:M` semantics unchanged for plan-only runs.

## NO_CONSENSUS escalation

Plan-phase NO_CONSENSUS = a genuine contested design: the **parent orchestrator steps
in** — surface the full split (per-judge verdicts, vote evolution) and stop for a human /
orchestrator decision (refine task, pick a plan manually, or abort). Never silently spend
on implementation without a consensus plan. Implement-phase NO_CONSENSUS after R4 =
needs-human (existing contract).

## Grand loops (Z) reinterpreted

Z no longer means "re-attack the same task N times". Each grand loop is a **separate or
sequential task** running the full plan(+implement) pipeline:

- Issue batch: "fix issues 4, 7, 24, 55" → Z=4, one loop per issue.
- Phased build: "build my website; break planning+implementation into 4 phases, one
  phase per grand loop" → Z=4 sequential loops, cross-loop ledger carries phase outputs.

Per-loop mechanics (branch, verify, audit, PR, ledger, STOP file, DONE markers) are
unchanged; the loop body becomes the plan(+implement) tournament instead of
tournament + implementer hop.

## Open items for the implementing run

- Parser: phase-scoped spec grammar (`Plan:` / `Implement:` segments), `implement`
  keyword, defaults, conflicts.
- Council rubric profiles: plan lenses vs code lenses (same engine, two lens tables).
- R3 gate definition reuses gate(candidate) from the grand-loop driver (verify AND
  audit) where applicable at Z=1.
- Cost notes + SKILL phase renumbering; size profiles may differ per phase (plans are
  short/medium; implementation inherits task size).
