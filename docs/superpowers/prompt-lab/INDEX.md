# Prompt Lab — optimised worker-prompt variants for future A/B testing

A document library of drop-in replacement variants for every worker sub-agent prompt in the
engine, authored 2026-07-06 by a frontier-class model against commit `b360a37`, for testing
LATER when the day-to-day orchestrator drops to Opus-tier. Nothing here is wired in;
production prompts are unchanged.

Scope follows the GEPA/MAS-PromptBench evidence (arXiv:2507.19457, arXiv:2606.23664):
optimise WORKER prompts, leave orchestration prose alone — family 07 is the one deliberate
exception (a single well-defined compose act) and is flagged as the noisiest.

## Families

| file | family | production anchor |
|---|---|---|
| [01-plan-design-brief.md](01-plan-design-brief.md) | Plan design brief | `tournament.mjs` `brief()` `kind==='plan'` (~L125) |
| [02-implement-brief.md](02-implement-brief.md) | Implement brief (seedBlock + repoMode + deliverable contract) | `tournament.mjs` `brief()` (~L150-197) |
| [03-judge-lens-brief.md](03-judge-lens-brief.md) | Council lens judge | `tournament.mjs` `lensPrompt()` (~L1869); legacy `judgePrompt()` (~L888) |
| [04-steelman.md](04-steelman.md) | Steelman change-list synthesis | `tournament.mjs` `steelmanChangeLists()` (~L2099) |
| [05-boost-implementer.md](05-boost-implementer.md) | Boost implementer | `tournament.mjs` `boostCandidate()` (~L2117) |
| [06-guidance-synthesis.md](06-guidance-synthesis.md) | Round-2 guidance synthesis | `tournament.mjs` `synthesizeGuidance()` (~L2042) |
| [07-fe-composer.md](07-fe-composer.md) | Fable Engine composer | `skills/fable-engine/SKILL.md` Phase 3 |

Each file: the CURRENT production prompt verbatim; TEN complete drop-in variants, each with
a one-line rationale (variation axis) and a one-line testable prediction; a how-to-test
footer. Every variant preserves the engine-contract invariants: blind letters only,
`checks_run` required for judges, single-pass hard stop + save contract for attempts,
altitude rule for design briefs, no model identities, JOUST literals untouched.

## Testing protocol

1. **One variable at a time.** One variant swapped into one template per experiment. Never
   stack two variants (even in different families) in the same arm — cross-family
   interactions are round 2, after single-variant winners exist.
2. **Pin everything else.** Same calibration task, same pool spec (include glm-5.2 +
   minimax seats when testing attempt briefs — they are the failing population), same size
   profile, same judge config. For judge/steelman/boost/guidance variants, pin the ATTEMPT
   side; for attempt-brief variants, pin the judging side.
3. **Lint before spending.** Render the swapped brief and run
   `node bin/je-brief-test.mjs -` (deterministic, no model). A FAIL means fix the variant,
   not the run.
4. **n >= 5 runs per arm before any conclusion.** Single-run deltas are judge noise —
   je-evolve's own evidence bar (>=2 distinct sources) applies doubly to prompt deltas.
   Interleave arms in time (A,B,A,B...) so provider load/backpressure doesn't confound.
5. **Record every run**: `node bin/je-ledger.mjs record <runDir>` immediately after each
   run; tag the arm in the run id (e.g. `...-arm-02v1`).
6. **Compare with the standard instruments:**
   - `node bin/je-ledger.mjs report` — valid-rate, win-rate per model, cross-run leaderboard.
   - `node bin/je-evolve.mjs <runDirs...>` — Signal A (per-model valid-rate), Signal C
     (recurring con clusters), Signal D (RC 03/05 classes).
   - `node bin/je-council-audit.mjs` — inter-seat correlation, vote concentration,
     rotation disagreement (judge-dispersion metrics).
   - `node bin/je-timeline.mjs` — phase walls (for brevity/turnaround variants).
7. **Decide with a kill criterion declared up front.** Each variant's Prediction line names
   the metric that must move; the file footers name the metric that must NOT regress.
   Adopt only when the target moves AND the guard holds across the n>=5.
8. **Adopted variant = new baseline.** Fold it into `tournament.mjs`/SKILL.md with a
   changelog entry citing the arm data, then re-run the next experiment against the new
   baseline. Keep this lab updated: the adopted text becomes the "current production
   prompt" section of its family file.

## Test these first (top 10, evidence-ranked)

1. **02-V1 implement save-contract-first** — direct fix for the only n=2/2 observed failure
   (glm-5.2 "no deliverable saved", je-evolve S1/S21). Metric: runner valid-rate, RC 05.
2. **01-V1 plan save-contract-first** — same delta, plan phase (S1 targets both templates).
   Metric: plan-round valid-rate, RC 05.
3. **03-V7 verbosity-line ablation** — research says the debiasing line is dead weight;
   cheapest experiment in the lab (delete one sentence). Metric: nothing moves = win.
4. **03-V1 binary sub-rubric per lens** — strongest research prior (BoN-MAV: binary aspect
   checks beat holistic scores). Metric: judge dispersion, deliberation rounds.
5. **01-V6 failure-mode enumeration** — mined directly from run-E/F recurring cons
   (S2-S20). Metric: Signal-C con-cluster recurrence.
6. **02-V4 negative-example inoculation** — attacks the three OBSERVED runner loss modes
   (#34 save-nothing, write-denial burn, iterate-to-green). Metric: RC 03 + RC 05.
7. **03-V2 evidence-quota per candidate** — directly hardens the forced-evidence lever the
   integrity guard depends on. Metric: integrity rejections, checks_run substance.
8. **06-V2 guidance actionability test** — guidance is the two-pass mode's whole payload;
   platitude-filtering is the highest-leverage line. Metric: round-2 win-over-champion rate.
9. **04-V1 steelman con-clustering** — correlated-judge cons burning the 12-item cap is a
   known structural issue (Nine Judges). Metric: post-boost con resolution, shootout iterations.
10. **05-V1 boost applied/skipped report** — pure observability win (zero-risk), unlocks
    je-evolve mining of steelman→boost fidelity. Metric: skipped-item visibility, re-judge
    "not actually fixed" rate.
