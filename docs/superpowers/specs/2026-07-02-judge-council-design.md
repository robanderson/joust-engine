# 5-Judge Council for the Joust Engine (issue #22)

Approved design, 2026-07-02. Replaces the single blind Opus judge with a 5-judge
deliberating council at both decision points of `workflows/tournament.mjs`.

## Goal

Issue #22 (LLM-as-judge research) + the PR-council field run showed a single judge is
exposed to single-model bias and rubber-stamping. Upgrade the tournament's Phase 3 review
and Phase 5 final rank to a **council of 5 blind Opus judges with distinct lenses**,
independent round 1, bounded cross-talk deliberation, deterministic tally in code,
majority >50%, and a security veto.

## Non-goals

- No cross-family judges (runners have no structured-output enforcement; decided against).
- No change to attempts, blind labeling/staging, enrichment, diversity injection, or the
  grand-loop git flow beyond NO_CONSENSUS routing.
- No LLM ever aggregates votes ("summarize the consensus" is forbidden).

## The council

**5 Opus judges, one lens each:**

| Lens | Owns | Special |
|---|---|---|
| correctness | does it work; run/trace code; cite enrichment (verify/build/lint) exit codes | the evidence judge |
| spec | compliance & completeness: everything asked, stated constraints honoured | catches "works but wrong task" |
| security | vulns, injected execution, secrets, supply chain | **veto** via per-candidate `safety` flag |
| robustness | edge cases, failure modes, boundaries, error handling | |
| craft | readability, structure, maintainability, efficiency | |

All blind (candidate letters only, never model identities). All read the one `_pool.md`.
Each judge's candidate listing/order is **rotated differently** (position-bias control).
Every verdict requires `checks_run[]` — commands run / files read with the key result
(forced-evidence lever). Existing shared scoring rules from `references/review-rubric.md`
(judge the artifact not the self-summary, score against the task's stated runtime, cite
specifics) apply to every lens.

**Round 1 — independent.** 5 parallel verdicts, no peer visibility. Each returns:
per-candidate pros/cons through its lens, full ranking, first-place vote, reasoning,
`checks_run`. Security judge additionally returns per-candidate
`safety: SAFE | UNSAFE {severity: high|critical, evidence: file + why}`.

**Tally (plain code, after every round):**
- Majority = **>50% of living judges' first-place votes** (3/5 when all alive).
- **Veto filter:** a candidate flagged `UNSAFE` by the security judge cannot win
  regardless of votes.
- Majority reached on a non-vetoed candidate → done.

**Deliberation rounds (max 3).** If no majority, or the majority pick is vetoed: each
judge sees all peers' latest full verdicts (JSON, verbatim), must address disagreements in
`response_to_peers` (convince or be convinced; converge on the correct call rather than
stubbornly holding), may run 1–2 targeted checks to settle factual disputes, then emits a
revised verdict (`changed_from_round1`/`changed_this_round` truthful). Peers may rebut a
veto with evidence; the security judge may withdraw a refuted flag, but a standing flag at
final tally excludes the candidate. Still split after 3 deliberation rounds →
**NO_CONSENSUS** (never silently resolved by Borda or a meta-judge).

**NO_CONSENSUS routing:** interactive runs surface the full split (per-judge final
verdicts + vote evolution) to the user; grand loops route that loop to
needs-human + HALT (existing fail-closed contract). All candidates vetoed → NO_CONSENSUS.

## Aggregation, guidance, failure handling

- Tally/veto logic is deterministic code in `tournament.mjs`; per-round vote evolution is
  logged (`log()`) and persisted with the run artifacts.
- **Two-pass guidance:** a separate synthesis call (explicitly not a decision-maker)
  distils positives/challenges from all 5 final verdicts, same `GUIDANCE_CAP`, same
  guidance schema and blind rules as today.
- **Judge death:** retry once per judge (existing pattern); still dead → council proceeds
  with the living, majority recomputed as >50% of living. Exception: security judge dead
  in repoMode → treat as unresolvable veto → NO_CONSENSUS/needs-human (fail-closed);
  isolated runs proceed with a loud logged warning that veto coverage was lost.
- **Legacy escape:** workflow arg `judges: 1` keeps today's single-judge path; the 5-judge
  council is the default. (Council size is otherwise fixed at 5; not user-tunable.)
- Council applies to BOTH the Phase 3 review (incl. two-pass round-1 review) and the
  Phase 5 final rank.

## Contract compatibility

The council returns the same shape call sites consume today —
`{candidates, ranking, winner, reasoning, guidance?}` — extended with council metadata
(per-judge verdicts, rounds used, vote evolution, veto events, `no_consensus` flag).
`reconcile()`-style normalization (winner/ranking repaired to a real permutation of blind
labels) applies per judge verdict. `verdictToMd`/`summaryMd` extend to show per-judge
verdicts, the tally per round, and veto events; the unblinded mapping report is unchanged.
The council's consolidated `ranking` (needed downstream, e.g. 7-FALLBACK's ranked #2) is
derived deterministically in code from the final-round verdicts: winner first, then
remaining candidates ordered by (first-place votes, then average rank across final
verdicts, then blind label) — this ordering is bookkeeping for downstream consumers, NOT a
consensus override; the winner slot is only ever filled by a majority non-vetoed winner.

## Files touched

- `workflows/tournament.mjs` — council engine: lens prompts, R1 + deliberation schemas
  (`response_to_peers`, `changed_this_round`, `safety`, `checks_run`), tally loop,
  NO_CONSENSUS surfacing, report/persist additions, `judges:1` legacy path.
- `skills/joust-engine/references/review-rubric.md` — per-lens rubrics, deliberation
  conduct, tally + veto rules (rewrite; keep shared scoring method + guidance rules).
- `skills/joust-engine/SKILL.md` — Phase 3/5 text, cost notes, quick reference, grand-loop
  NO_CONSENSUS → needs-human wiring.
- `skills/joust-engine/references/orchestration.md` — args (`judges`), council notes.
- `CHANGELOG.md`.

## Acceptance

- `npm run check && npm test` green.
- `node bin/rebrand.mjs` self-verify passes (runner/engine touched).
- Single-judge legacy path (`judges: 1`) byte-equivalent behaviour to today.
- Aggregation reachable only through code paths (no prompt asks an LLM to merge votes).
- NO_CONSENSUS in a grand loop produces needs-human + HALT, never a merged/auto-picked
  winner.
