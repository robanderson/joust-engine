# Changelog

All notable changes to the **joust-engine** plugin are documented here.

## Unreleased

### Changed

- **Tournament split into a Plan phase and an optional Implement phase** (2026-07-03 design), replacing the flat single/two-pass structure with a cheap-wide-plan → narrow-strong-implement pipeline.
  - **Plan Round 1 + Plan Round 2 (always).** Attempts produce **PLAN artifacts** — concrete, file-level change proposals that never touch the repo — judged by a new **plan-lens council**: *feasibility, completeness, risk, security-by-design, simplicity/proportionality*. The plan phase runs the two-pass spine (Round 2 always) whenever implementation will follow, so the winning plan is refined before any expensive spend. Default plan pool (N=10): `2 opus, 2 sonnet, 2 codex-high, 2 glm-5.2, 2 minimax`.
  - **Implement Round 3 (only with the `implement` flag).** Each implementer is seeded with the **winning plan verbatim** — the deliberate exception to the never-seed-prior-artifacts rule (the plan IS the spec) — and applies the change repo-anchored. Judged by the existing 5-lens **code council** (correctness/spec/security/robustness/craft) with enrichment + verify evidence. Default implement pool (M=5): `2 opus, 2 codex-high, 1 glm-5.2`.
  - **Implement Round 4 (conditional).** Runs **only if Round 3 produced no gate-passing candidate** (verify fail / council NO_CONSENSUS / all vetoed), guided by the R3 review. Happy path with `implement` = 3 rounds total.
  - **Plan NO_CONSENSUS surfaces to the orchestrator BEFORE any implement spend** — a contested plan is never silently escalated to implementation; the full split (per-judge verdicts + vote evolution) is persisted and the run stops. Implement-phase NO_CONSENSUS after R4 = needs-human (existing contract).
  - **Parser** (`bin/je-parse.mjs`): phase-scoped prose specs — `Plan: 2 opus, …, Implement: 2 opus, …` (each segment uses the existing spec grammar; the plan sum is N, the implement sum is M); the marker-adjacent **`implement` keyword** (or a non-empty `Implement:` segment) enables rounds 3–4; omitted pools fall back to the defaults above. New output fields: `implement`, `planAssignment`, `implementAssignment`. Existing sigil forms and `@@JE:N:M` semantics are unchanged for plan-only runs.
  - The council engine is shared: one deterministic tally / veto / bounded-deliberation / NO_CONSENSUS path, two lens tables (`LENS_PROFILES.plan` vs `LENS_PROFILES.code`), selected per judging point by phase.

- **MiniMax gets its own wall-clock** (`minimaxTimeoutSecs`: short 300s / medium 900s / long 1800s) in `SIZE_PROFILES` and the engine (fallback = `attemptTimeoutSecs`, so unset behaves as before). Both MiniMax-M3 seats in a real medium-profile run timed out at the shared 300s and saved no deliverable (issue #30); M3 needs GLM-style headroom on real code tasks.

- **Self-contained candidate workspaces relocated outside the plugin cache** (issue #34,
  mirrors the #44 `worktreeRoot` fix). `repoMode:false` candidate workspaces (native
  Anthropic and every runner-based attempt) now default to `/tmp/je-workspaces/<run-id>/...`
  instead of `<runDir>/round-*/candidate-*` — `runDir` lives inside the user config dir /
  plugin cache, a path nested claude-CLI runners (glm/minimax/codex/grok) treat as sensitive
  and refuse to write under, so a completed runner attempt could burn its whole turn budget
  fighting write denials and save zero files. Configurable via the new `workspaceRoot` arg
  (`workspaceRoot: runDir` reproduces the pre-fix layout exactly). Staging/review dirs,
  `_engine-logs`, the shared context bundle, and every persisted artifact (`mapping.json`,
  `SUMMARY*.md`, `review-*/`, etc.) are unaffected — they were always written from `runDir`
  literals, never from the candidate workspace path. `repoMode:true` is untouched.

- **Judging is now a 5-lens deliberating Opus council** (issue #22), replacing the single blind Opus judge at BOTH decision points (Phase 3 review and Phase 5 final rank).
  - Five blind Opus judges, one lens each — **correctness, spec, security, robustness, craft** — vote independently in round 1 (no peer visibility), each returning per-candidate pros/cons, a full ranking, a first-place vote, and a required `checks_run[]` evidence list.
  - **Deterministic tally in code** (never an LLM): a **>50% majority** of the living judges' first-place votes on a non-vetoed candidate wins.
  - **Security veto:** the security lens flags candidates `UNSAFE` with a severity + evidence; a standing high/critical flag excludes that candidate from winning regardless of votes.
  - **Bounded deliberation:** no majority (or the majority pick is vetoed) triggers up to **3** deliberation rounds — each judge sees peers' verbatim verdicts, may run 1-2 targeted checks, and revises. Still split → **NO_CONSENSUS** (never resolved by Borda or a meta-judge).
  - **NO_CONSENSUS routing:** interactive runs surface the full split (per-judge verdicts + vote evolution); grand loops route the loop to **needs-human + HALT** (winner `null` / `no_consensus:true` in `mapping.json`).
  - **Judge death:** retry once, then proceed with the living (majority recomputed as >50% of living). Security judge dead in repo-anchored mode fails closed to NO_CONSENSUS; isolated runs proceed with a loud warning that veto coverage was lost.
  - Two-pass guidance is now distilled by a **separate synthesis call** (explicitly not a decision-maker; same `GUIDANCE_CAP`, schema and blind rules) — it never merges votes or picks a winner.
  - **Legacy escape:** pass `judges: 1` to keep the single blind Opus judge (byte-for-byte today's behaviour). Council size is otherwise fixed at 5 (not user-tunable).
  - Council metadata (per-judge verdicts, rounds used, vote evolution, veto events) is logged and persisted to `review-*/council.json`, and rendered in `verdict.md` / the run summaries.

## v0.0.1

Initial release of **Joust Engine** — model-diverse agentic loops from concept to PR.

- `@@JE` sigil and `joust:N[:M[:Z]]` prose marker (single pass, two pass, grand loops).
- N parallel attempts across a mix of providers (Anthropic, GLM, on-device MLX, OpenAI Codex, MiniMax, xAI Grok), judged blind by a fixed Opus reviewer.
- Two-pass guided rounds; grand loops (`Z >= 2`) implement each winner on a `JE-<loop>-<rand7>` branch behind a fail-closed verify gate and open a PR (never auto-merged).
- Self-contained Claude Code plugin **and** marketplace: `/plugin marketplace add robanderson/joust-engine` → `/plugin install joust-engine@joust-engine`.
- Bundled `bin/je-*` runners, `joust-*` provider agents, and the `joust-engine` / `joust-bench` skills.
