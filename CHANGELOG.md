# Changelog

All notable changes to the **joust-engine** plugin are documented here.

## v0.0.1

Initial release of **Joust Engine** — model-diverse agentic loops from concept to PR.

- `@@JE` sigil and `joust engine:N[:M[:Z]]` prose marker (single pass, two pass, grand loops).
- N parallel attempts across a mix of providers (Anthropic, GLM, on-device MLX, OpenAI Codex, MiniMax, xAI Grok), judged blind by a fixed Opus reviewer.
- Two-pass guided rounds; grand loops (`Z >= 2`) implement each winner on a `JE-<loop>-<rand7>` branch behind a fail-closed verify gate and open a PR (never auto-merged).
- Self-contained Claude Code plugin **and** marketplace: `/plugin marketplace add robanderson/joust-engine` → `/plugin install joust-engine@joust-engine`.
- Bundled `bin/je-*` runners, `joust-*` provider agents, and the `joust-engine` / `joust-bench` skills.
