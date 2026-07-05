# Structural persist — deterministic, verified dataplane (issue #33; run D, approved 2026-07-06)

Every byte the engine moves to or from disk today transits an LLM that RE-TYPES it.
Haiku corrupted these relays (9/9 audited runs — #33); the sonnet interim stopped the
corruption but keeps the cost: a single review checkpoint (~50-100KB of verdict.json /
verdict.md / council.json / SUMMARY.md) takes 10-20 MINUTES of a model literally typing
bytes, at 4-6 checkpoints per plan/implement run. Live evidence: run C's R1 persist,
~15 min while the whole council had already finished.

## Scope — ALL model-relayed byte-copies, both directions

1. **Persist writes** (`persist()` — every checkpoint: P0 no-pool, P2 incremental,
   review-1, review-final, implement, NO_CONSENSUS paths): engine (sandbox) → helper
   agent → files under runDir.
2. **Codex/runner judge verdict read-backs** (`askLensCodex` → helper cats log +
   VERDICT.json → returns `{raw}` for `parseCodexJudgeDump`): disk → helper → engine.
   Shape/integrity validation DETECTS corruption here but the relay is still slow and
   retry-expensive.
3. **Seed-plan copy** (implement phase: winning plan → `_winning-plan/plan.md`) and any
   other place a helper's brief says "write exactly this content" / "return exactly this
   file".

## Requirements (the tournament designs the mechanism)

- **The model must never re-type payload bytes.** The helper may only orchestrate
  deterministic shell (cp/cat/mv/tee of harness-materialized inputs, or single-shot
  heredoc where the bytes appear ONCE in the prompt and are verified after) — whatever
  mechanism the winning design picks, corruption must be structurally impossible or
  mechanically detected.
- **Verification in code, fail-closed:** the engine knows the expected byte length (and
  a cheap engine-computable digest — the sandbox has no node:crypto, so pure-JS or
  length+probe checks) and verifies after every write/read; mismatch => bounded retry
  => loud failure. Never a silently short/abbreviated artifact.
- **Constraint honesty:** the workflow sandbox has NO node:fs/process; the ONLY channels
  are agent prompts (out) and agent return values / journal (in). The design must work
  within that — e.g. exploit that the harness already persists journal.jsonl and agent
  transcripts to disk without any model in the loop.
- **Speed:** a review checkpoint should take seconds-to-a-minute, not 15 minutes.
- **Model-independence restored:** once no model re-types content, the helper can go
  back to the cheapest tier (haiku) — HELPER_MODEL stays sonnet only where a helper
  genuinely reasons (context bundling summaries, staging validation judgment).
- **No contract changes:** same files, same paths, same shapes (mapping.json,
  council.json, verdict.md, SUMMARY.md, rc_summary rendering); crash-survival
  (incremental checkpoints) preserved or improved.
- Tests: corruption injection (helper returns short/mutated content) is caught +
  retried + loudly failed; byte-identical round-trip for a >100KB artifact; existing
  test files stay green. Docs + CHANGELOG.

## Acceptance

- A forced large checkpoint (>=100KB) persists byte-identical (verified) in <60s.
- A simulated abbreviating helper NEVER results in a silently corrupt artifact.
- Codex judge read-back is verified (length/digest) before parse; corruption =>
  retry-once => native fallback (existing ladder).
- `npm run check && npm test` green; rebrand self-verify passes. Closes #33.
