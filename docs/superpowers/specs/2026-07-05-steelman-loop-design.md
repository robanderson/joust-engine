# Steelman improvement loop at final ranks (approved 2026-07-05)

Companion to `2026-07-05-r1-fast-tally-design.md` (fast tally at intermediate reviews).
This spec replaces bounded deliberation at FINAL ranks (plan final rank, implement-phase
reviews) with an iterative improve-and-re-judge loop, and supersedes that spec's "final
rank unchanged" line. Motivating observation (run B, 2026-07-05): a split final plan rank
burned ~4 sequential council rounds x 6 judges x 10 candidates (~hours, millions of
tokens) with judges arguing over FIXED artifacts — no mechanism existed to improve
anything, even though the verdicts documented exactly what was wrong. Deliberation
re-allocates votes; this loop improves the deliverable.

## Change

**Final-rank judging point:**

1. **One independent vote round** (unchanged brief, all living judges, deterministic
   tally, union security veto). Majority on a non-vetoed candidate → winner, done —
   byte-identical to today's happy path.
2. **No majority → the STEELMAN LOOP** (replaces deliberation entirely at final ranks):
   - **Steelman** (non-voting synthesis helper, like the guidance distiller — explicitly
     not a decision-maker, never votes): reads ALL judges' verdicts + the top-2
     candidates (most first-place votes; mean-rank tie-break; blind-label residual).
     Emits per candidate a MINIMAL change-list that would make IT the clear winner.
     Every item must be traceable to a judge-cited con — steel-man, not redesign; no new
     features, no scope growth.
   - **Improve**: one implementer per candidate applies its change-list to a COPY of the
     artifact. Code artifacts re-run the verify/enrichment gate; a boost that fails the
     gate is discarded and that candidate re-enters at its last gated version (an
     iteration can never make a candidate worse — ratchet).
   - **Re-judge, blind and COLD**: the two (boosted) candidates are re-pooled under
     FRESH blind letters and judged in a single independent vote round with NO memory:
     judges receive no prior verdicts, no peer block, no indication these are iterations
     or what was suggested. Only the steelman ever sees prior-round verdicts.
   - **Tally**: majority → winner (polished). Tie → iterate: steelman reads the NEW
     verdicts, emits new change-lists, repeat.
3. **Bound: max 5 improvement iterations.**
4. **After 5 rounds still tied → the ORCHESTRATOR casts the deciding vote.** The main
   agent (interactive) or grand-loop driver reads the final verdicts + both artifacts and
   picks, recording `decided_by: "orchestrator"` + one-paragraph reasoning in
   council.json / verdict.md / SUMMARY.md. Rationale: after 5 gated, security-cleared,
   judge-guided improvement rounds both candidates are solid; the residual choice is
   judgment between two goods, not a safety question. This RETIRES NO_CONSENSUS at
   final ranks (it remains only for degenerate cases below).
5. **Security is absolute and unchanged**: both security gates vote in every re-judge;
   a standing evidenced high/critical UNSAFE flag excludes a candidate from winning AND
   from the orchestrator's pick. Both finalists vetoed (or all candidates vetoed at the
   initial vote round) → NO_CONSENSUS/needs-human as today — the orchestrator never
   overrides a veto.
6. **Cost note**: an iteration = 1 steelman + <=2 implementer applications + 1 gate run
   + 1 two-candidate vote round (tiny briefs) — far cheaper than one deliberation round
   over a full pool, and each iteration adds value to the shipped artifact instead of
   litigating it.

**Intermediate reviews are NOT affected** — fast tally (carry top two, no deliberation,
no steelman) per the companion spec. `judges: 1` legacy mode untouched.

## Council brief enhancements (bundled, from the same review discussion)

- **feasibility** (plan council) additionally owns claim-auditing: "demand the proof —
  verify the plan's factual claims about the current tree (files, functions, behaviours
  it says exist) against the snapshot; a plan built on a misread codebase is infeasible
  however coherent." (Enhancement instead of a 7th groundedness judge.)
- **Anti-length-bias line** in the shared scoring method of every judge brief:
  "thoroughness is evidence, not word count — do not reward length or verbosity per se."
- Panel stays at SIX seats (odd-panel tie-proofing is superseded by the orchestrator
  decider).

## Metadata / persistence

`council.json` at a final rank records: `steelman_rounds: N`, per-iteration change-lists
(per candidate), per-iteration vote splits, gate results, ratchet reverts, and
`decided_by: "majority" | "orchestrator"`. `verdict.md` + SUMMARY.md render the
iteration history. mapping.json winner fields unchanged in shape.

## Files touched

`workflows/tournament.mjs` (final-rank path: steelman loop, cold re-judge pooling,
orchestrator-decision hook — returned as `needs_orchestrator_pick: {finalists, verdicts}`
for the SKILL to act on when interactive; the grand-loop driver picks in-driver),
council tests (loop: majority-first-round, one-iteration win, 5-round tie →
orchestrator, gate-failure ratchet, veto-during-loop, both-vetoed), review-rubric.md /
orchestration.md / SKILL.md (final-rank description + orchestrator-decider contract),
CHANGELOG.

## Acceptance

- Majority at the first final-rank vote → identical result to today, zero extra spend.
- Forced-tie fixture: loop runs, artifacts improve each round (change-lists traceable to
  cons), fresh letters each round, terminates at majority or hands to orchestrator at 5.
- A boost that fails the verify gate reverts (ratchet) and the loop continues.
- Vetoed candidate never wins via loop or orchestrator pick.
- `npm run check && npm test` green; rebrand self-verify passes.
