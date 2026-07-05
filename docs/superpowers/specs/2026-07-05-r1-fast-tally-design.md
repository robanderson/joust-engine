# Round-1 review fast tally — carry top two, skip deliberation (approved 2026-07-05)

Observed in the first live 6-judge run: the ROUND-1 (intermediate) review deliberated the
full bounded rounds to force a single-winner majority. That is wasted time and tokens at
this decision point. The intermediate review exists to (a) distill ALL judges' findings
into round-2 guidance and (b) carry a champion into the final pool — not to settle a
contest. Consensus only matters at the FINAL rank, where exactly one winner must be named.

## Change

**Applies ONLY to the intermediate (round-1) review** — the Plan R1 review, and the code
R1 review in plain two-pass mode. The final rank (plan final, implement gate reviews) is
UNCHANGED: full bounded deliberation, strict majority, security veto, NO_CONSENSUS.

1. **One independent vote round, then a deterministic tally. NO deliberation rounds at
   the intermediate review.** Judges vote once (same per-candidate pros/cons, ranking,
   first-place vote, checks_run, safety flags as today).
2. **Majority present (>50% of living judges on a non-vetoed candidate):** carry that
   single winner forward — byte-identical to today.
3. **No majority ("two top candidates"):** carry the **top TWO non-vetoed candidates**
   forward into the final pool. Ordering rule (deterministic, in code): most first-place
   votes; tie-break by best mean rank across living judges; residual tie by blind label
   order. If fewer than two non-vetoed candidates exist, carry what exists (0 or 1).
4. **Security veto unchanged:** a standing evidenced high/critical UNSAFE flag from
   EITHER security gate (union) excludes a candidate from being carried, exactly as it
   excludes from winning.
5. **Guidance synthesis unchanged** — it already distills from ALL judges' verdicts
   across ALL candidates; it now also names which candidate(s) were carried and why
   (vote split), so round 2 knows the bar.
6. **Final pool** = N round-2 attempts + up to TWO carried round-1 champions (N+2 max,
   re-labelled blind as today). The final rank council handles the rest — with its full
   deliberation + NO_CONSENSUS machinery intact.
7. **Council metadata:** `council.json` for an intermediate review records
   `fast_tally: true`, the vote split, and `carried: [labels]`. `judges:1` legacy mode
   is untouched (single judge already never deliberates).

## Why this is safe

- The intermediate review's only downstream consumers are the guidance text and the
  carried champion(s). Carrying two on a split preserves MORE information than forcing
  a majority through deliberation (a coin-flip-ish consensus discards the runner-up that
  nearly half the panel preferred).
- The final rank still enforces the strict single-winner contract, security veto, and
  NO_CONSENSUS→needs-human. Nothing reachable by a grand loop or implement phase loses
  its fail-closed properties.
- Cost: removes up to 3 deliberation rounds × 6 judges at every intermediate review
  (observed: the largest single token sink in the run).

## Files touched

`workflows/tournament.mjs` (intermediate-review path: skip deliberation, top-two carry,
metadata), council tests (carry-two tally cases: majority / split / veto-excluded /
all-vetoed / single-candidate), review-rubric.md + orchestration.md + SKILL.md (Phase 3/5
description), CHANGELOG.

## Acceptance

- Majority in R1 vote round → identical result to today (one carried winner, no
  deliberation spend).
- Split R1 → two carried champions appear in the final pool and `carried` metadata;
  final rank resolves normally.
- Vetoed candidates never carried; all-vetoed R1 carries none and proceeds on guidance
  alone (final pool = N round-2 attempts).
- Final-rank behaviour byte-identical to today (deliberation, veto, NO_CONSENSUS).
- `npm run check && npm test` green; rebrand self-verify passes.
