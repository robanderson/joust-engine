# Investigate → Composite → Implement → Gate → PR pipeline (operator design, 2026-07-06)

Today's tournament assumes the task arrives PRE-DIAGNOSED: the plan phase designs HOW to
solve a problem someone has already located. Two real entry shapes break that assumption —
a vague goal ("the system is too slow") and a concrete issue ("fix #454") — because the
expensive part is finding out WHAT is true, not choosing between ten designs for a guess.
Design briefs also exposed a structural asymmetry the engine does not yet exploit:
SOLUTIONS compete (pick one winner, discard the rest), but FINDINGS compose — the union of
ten verified diagnoses is strictly better than the best single one. This spec adds a
front half that harvests that union, then feeds today's proven back half.

## Pipeline shape

```
INVESTIGATE (wide, cheap, additive)  →  COMPOSITE (one spec, the decision point)
      →  IMPLEMENT (narrow, strong, brief-as-contract)  →  GATE → PR (existing)
```

Entry shapes (both feed the same Phase 1):

- **Vague goal**: the operator's sentence IS the task; investigation scopes it.
- **Concrete issue**: `@@JE fix #454` — issue-intake (gap G4) fetches the issue body via
  `gh`, installs it as the task text, and adds files it names to `contextFiles`.

The ORIGINAL request is the constitution for the whole run: every later artifact serves
it; nothing downstream may redefine it.

## Phase 1 — INVESTIGATE (wide + cheap)

N mixed-model seats (mixed pools are viable here: outputs are SHORT findings, the same
cost shape that makes @@FE's wide round cheap) dig into the substrate: code, logs, and
run telemetry — `timeline.jsonl`/`TIMELINE.md`, the je-ledger, runDir artifacts
(`mapping.json`, `council.json`, `rc_summary`), git history. Each seat returns one
FINDINGS artifact (investigate-brief template, gap G1):

- **Diagnosis** — what is actually wrong/slow/missing, in decision-level language.
- **Evidence** — VERIFIABLE citations: file/line, journal/ledger/timeline refs, measured
  numbers. Claims without checkable evidence are weighed as speculation.
- **Candidate improvement sketch** — 1-3 bullets, altitude-guarded like a design brief.

**Iteration (optional round 2)**: rides the existing two-pass spine — the distiller's
guidance becomes "look HERE next" (dig where round 1 found smoke), via the existing
`guidance` plumbing with an investigate framing; `guidanceStub` already protects against
seeding placeholders.

**Composition is ADDITIVE — the core difference from every other phase.** No winner is
picked. An evidence-verification pass (gap G2) checks each cited claim against the
snapshot/telemetry (mechanical where possible: does the file/line exist, does the ledger
row say that; helper-audited otherwise); verified findings are UNIONED and ranked by
measured impact; unverifiable ones are dropped or demoted to hypotheses. Two seats
finding the same fault is confirmation, not redundancy.

## Phase 2 — COMPOSITE (the decision point)

A composer — the frontier orchestrator in @@FE mode, or a council in @@JE mode — unions
the verified findings into ONE spec-shaped artifact:

- **Diagnosis** (the union, priority-ordered by measured impact).
- **Chosen approach** + why, and rejected alternatives.
- **Acceptance criteria** — APPROACH-NEUTRAL, binding on EVERY implementer, mechanically
  checkable where possible ("p95 checkpoint <60s", "no test regresses"). These are the
  spec's contract with Phase 3 and Phase 4.
- **Credit table** — per finding-seat, what was adopted/rejected and why (the @@FE
  composite discipline, reused verbatim).

Rules:

- **ALTITUDE-GUARDED like design briefs**: no code blocks, diffs, line numbers, function
  bodies. The composite decides; implementers implement. (Evidence citations keep their
  file/line refs — citing is not editing.)
- **Conflicting DIAGNOSES may both be true** — union them with priorities; that is the
  additive property working as intended.
- **Conflicting APPROACHES are a decide moment**, never silently averaged: (a) evidence
  tally settles it when the measurements do; (b) genuinely split → TWO briefs, resolved
  empirically by `abBriefs` in Phase 3; (c) neither → surface to the human (the plan
  NO_CONSENSUS contract).
- **demand-the-proof audit concentrates HERE.** The feasibility lens's claim-auditing
  (steelman-loop spec) moves its weight to the composite: a wrong composite poisons ALL
  implementers, so every factual claim it carries forward is re-verified against the
  snapshot before Phase 3 spends anything.

## Phase 3 — IMPLEMENT (narrow + strong)

X strong seats (today's implement pool shape) seeded with the composite via the existing
`seedPlanPath` brief-as-contract framing: honour the APPROACH and ACCEPTANCE CRITERIA,
details are theirs. When approaches genuinely split, `abBriefs` seeds the pool
alternately from both briefs, `mapping.json` records `seedBrief`, and the A/B result is
derived from bookkeeping.

**Judging is blind on fundamentals + the ORIGINAL request only — never against the
brief.** "Briefs compete through their children; children are judged as orphans." Judges
never see the composite; an implementer that satisfies the original request by a better
route than the brief chose must be able to win. Objective testing belongs to machinery,
not judges: the mechanical patch gate classifies deliverables pre-council, and the
composite's acceptance criteria run as extracted checks (gap G3) alongside enrichment.

## Phase 4 — GATE → PR (existing, unchanged)

The repoMode plumbing as-is: gated commits (P3 validation), frozen-set `run_verify`
fail-closed (rc 1/2 → needs-human; sandbox re-gate order preserved), security audit
reconciler ANDed with verify, `open_pr`/`open_pr_needs_human`, NEVER auto-merge. The
only addition: extracted acceptance-criteria checks (G3) append to the frozen verify set
so "done" is the composite's definition, not just the repo's default suite.

## Cost shape

Investigation wide + cheap (short outputs, mixed/non-Anthropic-heavy pools, telemetry
reads not builds) → composite is one strong-model act (or one council round) → implement
narrow + strong → judging mostly mechanical (patch gate + criteria checks + verify carry
the objective load; councils rank what machines cannot). Spend concentrates exactly where
uniqueness is: the composite and the implementations.

## Mapping onto existing machinery

| Pipeline piece | Existing machinery |
| --- | --- |
| Wide blind round, no council | `composeOnly: true` (@@FE mode) — reuse for the investigate round |
| Substrate access | `contextFiles` bundle; runDir artifacts; `bin/je-timeline.mjs`; `bin/je-ledger.mjs report` |
| Findings staging/provenance | `stageAndValidate` (same fail-closed staging; findings are just a different deliverable contract) |
| Round-2 "look here next" | two-pass guidance plumbing + `guidanceStub` launch gate |
| Composite authoring | @@FE Phase 3 composer (+ credit table) or plan council (`LENS_PROFILES.plan`, feasibility = demand-the-proof) |
| Brief-as-contract seeding | `brief()` `seedPlanPath` implement framing |
| Approach A/B | `abBriefs` + `seedBrief` bookkeeping |
| Objective implement gating | `mechanicalPatchGate` + enrichment/verify evidence |
| Gate → PR | `bin/je-git.sh`: `preflight`, `detect_verify`, `run_verify`, `adopt_winner_branch`, `open_pr`, `open_pr_needs_human` |
| Telemetry/learning | `je-timeline` per-run; `je-ledger` cross-run (which models find verified faults) |

## Gaps to build (small, named)

- **G1 investigate-brief template**: a third `brief()` kind (`'investigate'`) — findings
  deliverable contract (diagnosis/evidence/sketch), altitude rule, short-output framing,
  read-mostly substrate instructions.
- **G2 evidence-verification pass**: post-staging, pre-composite — verify each cited
  claim (file/line exists and says that; ledger/timeline row matches) mechanically where
  possible, helper-audited otherwise; annotate verified/unverified; rank by impact.
  Sibling of `mechanicalPatchGate` in spirit: deterministic where it can be.
- **G3 acceptance-criteria → verify-command extraction**: parse the composite's
  mechanically-checkable criteria into commands appended to the frozen verify set
  (`detect_verify` output + criteria checks piped to `run_verify`); non-mechanical
  criteria route to judge briefs as evidence requests.
- **G4 issue-intake**: `@@JE fix #454` → `gh issue view` fetches title+body as the task,
  referenced paths become `contextFiles`; the issue text joins the original request as
  constitution.

## Migration path

This GENERALIZES today's plan phase; it does not replace it. A pre-diagnosed task enters
at Phase 2/3 exactly as today (plan rounds ARE a degenerate composite: one entry shape,
zero investigation). Ship order: G4 + G1 behind a flag (`investigate: true`) → G2 → G3.
@@JE keeps council judging at the composite; @@FE keeps the composer. Existing sigils,
plan/implement rounds, and the grand loop are untouched when the flag is off.

## Risks

- **Intent drift** — three artifact generations between request and code. Mitigation:
  the ORIGINAL request is the constitution; it appears verbatim in every phase's brief
  and is the ONLY thing implement judges rank against.
- **Spec overfit** — acceptance criteria that encode the composer's pet approach bind
  implementers to it. Mitigation: criteria must be approach-neutral by rule; the
  composite audit (Phase 2) checks neutrality; abBriefs exists precisely for real splits.
- **Investigation needs substrate access** — findings are only as good as what seats can
  read; runner seats in scratch workspaces cannot see the live repo/telemetry unless the
  bundle carries it. Mitigation: `contextFiles` + repoMode read access; a run without
  substrate must say so rather than speculate (unverified findings demote, G2).
- **Additive ≠ uncritical** — unioning unverified findings launders hallucinated
  diagnoses into the constitution's neighborhood. G2 is fail-closed: no verification, no
  ranking weight.

## v1 cut-list

- IN: G1 investigate kind (single round), additive union with a HELPER-audited (not yet
  mechanical) G2, composite via existing @@FE composer path, G4 issue-intake, implement
  reuse as-is, gate/PR as-is.
- OUT (v2+): mechanical G2 verifiers, G3 criteria-extraction (v1: criteria land in the
  PR body + judge evidence requests only), investigate round 2, council-mode composite
  for @@JE, ledger columns for finder-quality, multi-issue intake.

## Acceptance (v1)

- `@@JE fix #<n> investigate` fetches the issue, runs one wide investigate round, and
  the composite's credit table traces every adopted finding to a seat + verified citation.
- A finding whose citation fails verification never appears in the composite's diagnosis
  (demoted or dropped, visibly).
- Implement judges' briefs contain the ORIGINAL request and never the composite.
- Flag off ⇒ byte-identical behavior to today (existing suites green, rebrand
  self-verify passes).
