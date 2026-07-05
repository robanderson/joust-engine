# Prompt Lab 07 — Fable Engine composer (SKILL.md Phase 3)

**Anchor:** `skills/fable-engine/SKILL.md` → "## Phase 3: Compose (you)". Unlike families 01-06 this is ORCHESTRATOR-DIRECTED skill prose, but it directs a single well-defined worker act (the compose), so it is in scope; note MAS-PromptBench's caveat that orchestrator-prose optimisation pays less than worker prompts — set expectations accordingly. As of commit `b360a37`.

**Engine-contract invariants kept in EVERY variant:** compose from `poolPath` BLIND (do NOT read `mapping.json` or raw workspaces before composing; unblind only when reporting); a credit table with per-candidate traceability (every adopted idea traceable to a candidate letter or marked `(composer)`); a composite plan with file-level changes, test plan, risks; saved to `<runDir>/composite-plan.md`; no model identities during compose.

## Current production prompt (verbatim)

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).
Then write THE plan:

- **Credit table first**: per blind candidate, what you are taking, what you are rejecting,
  and why — one line each. Every adopted idea must be traceable to a candidate or marked
  `(composer)` for your own additions.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- Save it to `<runDir>/composite-plan.md`.
```

## Variants

### V1 — credit-quota (no silent discards)
Rationale: the composer's known bias is anchoring on 1-2 strong drafts and skimming the rest; a per-candidate quota (one take-or-reject line WITH cited evidence each) forces full-pool reading.
Prediction: contribution spread in contributions.json widens (more candidates credited); composite quality vs @@JE calibration unchanged or up.

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).
Then write THE plan:

- **Credit table first — full coverage is mandatory**: EVERY blind candidate gets its own
  line: what you are taking, what you are rejecting, and why — and the "why" must cite
  something concrete from that candidate's section (an idea, a risk it caught, a mistake
  it made). "Nothing useful" is a legal verdict but must name what you checked before
  concluding it. A candidate you cannot cite is a candidate you have not read — go back.
  Every adopted idea must be traceable to a candidate or marked `(composer)` for your own
  additions.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- Save it to `<runDir>/composite-plan.md`.
```

### V2 — conflict table (decide disagreements explicitly)
Rationale: @@FE's honest trade is no independent council; the composite's weakest point is silently inheriting ONE draft's side of a contested choice. Surface draft disagreements as first-class decisions.
Prediction: implement-phase gate failures traceable to unexamined design choices down; composite-vs-@@JE calibration delta narrows.

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).
Then write THE plan:

- **Credit table first**: per blind candidate, what you are taking, what you are rejecting,
  and why — one line each. Every adopted idea must be traceable to a candidate or marked
  `(composer)` for your own additions.
- **Conflict table second**: wherever drafts genuinely DISAGREE (different architecture,
  different surface, incompatible orderings), list the disagreement as a row — the
  positions, which you chose, and the reason. These contested forks are where a composite
  silently goes wrong; deciding them explicitly is this phase's real work. No conflicts
  found in a diverse pool is a red flag — look again.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- Save it to `<runDir>/composite-plan.md`.
```

### V3 — red-team pass before saving
Rationale: the composer both judges and writes (no council check); a mandatory self-adversarial pass — three concrete ways the composite fails — is the cheapest stand-in for the missing council.
Prediction: implement-phase test-gate failures down; risks section becomes specific (named failure paths, not categories).

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).
Then write THE plan:

- **Credit table first**: per blind candidate, what you are taking, what you are rejecting,
  and why — one line each. Every adopted idea must be traceable to a candidate or marked
  `(composer)` for your own additions.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- **Red-team pass before saving (mandatory)**: you have no blind council checking you this
  run, so do its job for one section: write "How this composite fails" — the THREE most
  plausible concrete failure paths (a file-level change that breaks an existing behaviour,
  an integration seam no draft actually verified, a test-plan blind spot), each with the
  check that would catch it. Amend the plan where a failure path reveals a real gap; keep
  the section in the saved file.
- Save it to `<runDir>/composite-plan.md`.
```

### V4 — diversity-harvest quota
Rationale: diversity research (arXiv:2606.10302) — the wide round's value is orthogonal angles; requiring adoption (or explicit rejection-with-reason) from >=3 distinct candidates stops the composite being draft-A-plus-trim.
Prediction: contribution spread up; composite contains ideas absent from the single best draft (measure: credit table vs top candidate overlap).

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).
Then write THE plan:

- **Credit table first**: per blind candidate, what you are taking, what you are rejecting,
  and why — one line each. Every adopted idea must be traceable to a candidate or marked
  `(composer)` for your own additions.
- **Harvest wide (the wide round is the whole point)**: the composite must adopt material
  from AT LEAST THREE distinct candidates, or the credit table must show why fewer
  sufficed (e.g. the pool converged — name the convergence). If one draft dominates your
  plan, re-read the others specifically hunting for the thing each saw that the dominant
  draft missed: an edge case, a cheaper surface, a risk, a test. The best drafts are
  often wrong in one place another mediocre draft got right.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- Save it to `<runDir>/composite-plan.md`.
```

### V5 — output-schema-first (fixed headings)
Rationale: fix the composite-plan.md skeleton so every run is comparable and the ledger/audit tooling can parse sections; schema-anchoring also stops credit-table drift.
Prediction: composite artifact comparability across runs up (enables je-ledger section metrics); compose time down slightly.

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).
Then write `<runDir>/composite-plan.md` with EXACTLY these five headings, in order:

1. `## Credit table` — one line per blind candidate: TAKE <what> / REJECT <what> — <why>.
   Every adopted idea must be traceable to a candidate or marked `(composer)` for your own
   additions.
2. `## Decisions` — the design choices the composite makes, each with the candidate(s) or
   `(composer)` reasoning behind it. Where drafts disagreed, say which side you took and why.
3. `## File-level changes` — per file: add/edit/delete and what changes in it.
4. `## Test plan` — the tests you will write or extend, and what each proves.
5. `## Risks` — what could break and the mitigation.
You are an author using references, not a judge averaging them: disagree with all N drafts
where you can do better, and say so under Decisions.
```

### V6 — implementer-contract framing
Rationale: the composite plan's consumer is Phase 4 (the composer itself implementing); write the plan as a contract with acceptance criteria — spec-first evidence says testable definitions of done cut implementation error.
Prediction: Phase 4 test-gate first-pass rate up; implement rework loops down.

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).
Then write THE plan — as a CONTRACT your Phase 4 self must satisfy, not as notes:

- **Credit table first**: per blind candidate, what you are taking, what you are rejecting,
  and why — one line each. Every adopted idea must be traceable to a candidate or marked
  `(composer)` for your own additions.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- **End with ACCEPTANCE CRITERIA**: 3-6 testable checks that will define "implemented
  correctly" in Phase 4 ("new test X fails before / passes after", "no existing test
  regresses", "behaviour Y preserved"). In Phase 4 you will verify each criterion and
  report it in the run summary — write criteria you are willing to be held to.
- Save it to `<runDir>/composite-plan.md`.
```

### V7 — role reframing (chief architect vs hostile review)
Rationale: social-stakes framing — the composite will be defended line-by-line to a hostile reviewer who has also read all drafts; tests whether anticipated scrutiny substitutes for the absent council.
Prediction: unexamined-adoption rate down (credit-table "why" gets specific); composite-vs-@@JE calibration delta narrows.

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).

You are the chief architect, and assume this composite will be defended in front of a
hostile reviewer WHO HAS ALSO READ EVERY DRAFT. They will ask, per decision: "draft D did
this differently — why is yours better?" and "you rejected E's risk mitigation — what
happens when that risk fires?" Write the plan so every such question is already answered.

- **Credit table first**: per blind candidate, what you are taking, what you are rejecting,
  and why — one line each, in terms that survive the hostile read (a rejection needs a
  reason, not a shrug). Every adopted idea must be traceable to a candidate or marked
  `(composer)` for your own additions.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so — with the argument you would give the reviewer.
- Save it to `<runDir>/composite-plan.md`.
```

### V8 — brevity-forced composite
Rationale: composites inherit the union of N drafts' surface area; a hard budget (credit line <=20 words; plan <=2 pages) forces the smallest coherent composite — the @@FE speed promise extends to the artifact.
Prediction: Phase 4 turnaround down (je-timeline phase walls); implement gate pass rate unchanged (kill criterion: gate failures rise).

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).
Then write THE plan under a HARD BUDGET: each credit line at most 20 words; the whole
composite plan at most two pages. A composite naturally bloats toward the union of all
drafts — your job is the INTERSECTION of what the task needs, which is the smallest
coherent plan that fully solves it. Cut any adopted idea you cannot defend as necessary.

- **Credit table first**: per blind candidate, what you are taking, what you are rejecting,
  and why — one line each. Every adopted idea must be traceable to a candidate or marked
  `(composer)` for your own additions.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- Save it to `<runDir>/composite-plan.md`.
```

### V9 — two-read protocol (survey then mine)
Rationale: explicit reading procedure — a fast full survey pass (one-line gist per candidate) before the mining pass — counters primacy anchoring on the first strong draft in a long pool file.
Prediction: credit distribution decorrelates from pool position (position-bias proxy); late-pool candidates credited at the same rate as early ones.

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet), in
TWO passes:

- **PASS 1 — survey**: read the whole pool once, writing ONE line per candidate (its core
  approach, its one standout idea, its one visible weakness) BEFORE forming any preference.
  Candidates late in the file get the same attention as the first — the pool order is
  arbitrary and means nothing.
- **PASS 2 — mine**: with the full field in view, decide what the composite takes.

Then write THE plan:
- **Credit table first** (grow it from your survey lines): per blind candidate, what you
  are taking, what you are rejecting, and why — one line each. Every adopted idea must be
  traceable to a candidate or marked `(composer)` for your own additions.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- Save it to `<runDir>/composite-plan.md`.
```

### V10 — negative-example inoculation (the three bad composites)
Rationale: name the three observed composite failure shapes — the rubber-stamp, the frankenplan, the ghost-writer — so the composer steers between them.
Prediction: contribution spread up WITHOUT coherence loss (implement gate pass rate holds); credit-table specificity up.

```text
## Phase 3: Compose (you)

Read `poolPath` (the blind pool — do NOT read mapping.json or the raw workspaces yet).

Three composite shapes FAIL this phase — know them before you write:
- THE RUBBER-STAMP: the best draft re-titled, other candidates skimmed and dismissed in a
  word. If your plan matches one draft ~90%, prove the others had nothing (cite what you
  checked) or go back.
- THE FRANKENPLAN: one idea per candidate stitched together to look fair, with seams that
  do not integrate. Adoption must earn its place by fitting the design, not by crediting
  everyone.
- THE GHOST-WRITER: a plan mostly `(composer)` that ignores the paid-for pool. Your own
  ideas are welcome ON TOP of the harvest, not instead of reading it.

Then write THE plan:
- **Credit table first**: per blind candidate, what you are taking, what you are rejecting,
  and why — one line each. Every adopted idea must be traceable to a candidate or marked
  `(composer)` for your own additions.
- **Then the composite plan**: file-level changes, test plan, risks. You are an author
  using references, not a judge averaging them: disagree with all N drafts where you can
  do better, and say so.
- Save it to `<runDir>/composite-plan.md`.
```

## How to test

Swap ONE variant in as the Phase 3 block of `skills/fable-engine/SKILL.md` (keep the blind-pool rule, credit traceability, `(composer)` marker, and the `<runDir>/composite-plan.md` save path). Run the standard calibration task via `@@FE` n>=5 per arm, and keep a periodic `@@JE` run on the same task as the council baseline (the skill's own calibration discipline). Compare via `contributions.json` (credit spread), `node bin/je-timeline.mjs` (phase walls — @@FE's promise), Phase 4 gate first-pass rate, and the @@FE-vs-@@JE winner-quality delta in `node bin/je-ledger.mjs report`. Composer variants are the noisiest family (orchestrator prose; MAS-PromptBench predicts small deltas) — demand larger effects before adopting.
