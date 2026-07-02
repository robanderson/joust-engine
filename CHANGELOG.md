# Changelog

All notable changes to the **joust-engine** plugin are documented here.

## Unreleased

### Changed

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
