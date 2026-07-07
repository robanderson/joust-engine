# Prompt Lab 01 — Plan design brief (`brief()`, `kind === 'plan'`)

**Anchor:** `workflows/tournament.mjs` → `brief()` line ~112, `if (kind === 'plan')` branch (~line 125). Text below is the template-literal body as of commit `b360a37`.

**Interpolation slots every variant MUST keep, in a sensible position:** `${task}`, `${g}${ctxLine}`, `${nudge}`, `${ws}`. Escaped backticks (`\``) are source-form; paste variants as the template-literal body verbatim.

**Engine-contract invariants kept in EVERY variant:** design-brief ALTITUDE rule (no code blocks / diffs / line numbers / function bodies; violations judged DOWN); single-pass hard stop; save contract (PLAN.md into `${ws}`); no clarifying questions; brief only (never implements); no model identities. `PLAN.md` filename is a JOUST literal — never rename it (bundlePlan/staging read it).

## Current production prompt (verbatim)

```text
You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY. If a genuinely competitive alternative exists, name it in one bullet and say why you rejected it.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects (breaking changes, coupling, data/compat, security posture) and the mitigation.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("<metric> improves by >=X", "no existing test regresses", "behaviour Z is preserved", "a new test covers case W").

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — reviewers verify that named surfaces and constraints actually exist. A brief that reads like an implementation will be judged DOWN for altitude violation, however good its code is; a brief that hand-waves the hard 20% will be judged down for incompleteness. Decisions and criteria are the deliverable — implementation details belong to the implementers.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).
```

## Variants

### V1 — save-contract-first
Rationale: je-evolve S1/S21 (glm-5.2 "no deliverable saved" n=2/2; RC 05 seat) — put the save instruction FIRST and repeat it as the LAST line so weak runners cannot lose it mid-context.
Prediction: valid-rate up on glm/minimax seats; RC 05 (no-deliverable) rate down; no change on opus/codex.

```text
FIRST, before anything else: your ONLY deliverable is ONE file, PLAN.md, saved into ${ws} (create the directory now, with \`mkdir -p\`, before you think about the task). Your text reply is discarded — an empty workspace is a total failure. If a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).

You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

PLAN.md is AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY. If a genuinely competitive alternative exists, name it in one bullet and say why you rejected it.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects (breaking changes, coupling, data/compat, security posture) and the mitigation.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("<metric> improves by >=X", "no existing test regresses", "behaviour Z is preserved", "a new test covers case W").

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — reviewers verify that named surfaces and constraints actually exist. A brief that reads like an implementation will be judged DOWN for altitude violation, however good its code is; a brief that hand-waves the hard 20% will be judged down for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).

FINAL REMINDER (the one thing that matters mechanically): PLAN.md must exist, non-empty, inside ${ws} when you stop. Save it NOW if you have not already.
```

### V2 — criteria-first ordering
Rationale: judge-bias research (arXiv:2604.23178): explicit rubrics stated up front move judged quality; telling the author the scoring criteria BEFORE the task aligns generation with evaluation.
Prediction: council first-vote concentration up (judge dispersion down) with unchanged diversity; completeness cons down.

```text
You are producing a DESIGN BRIEF that will be scored by a blind 5-lens review council. Know the scoring BEFORE you read the task — your brief wins or loses on exactly these five questions:
1. FEASIBILITY: are the named files/APIs/mechanisms real, and do your factual claims about the codebase check out?
2. COMPLETENESS: is EVERY requirement, edge case, migration, test, and doc update covered — no silent gaps, no hand-waved hard 20%?
3. RISK: are the failure modes on execution named WITH mitigations, not glossed?
4. SECURITY-BY-DESIGN: does the design build in least privilege, input validation, safe secret handling?
5. SIMPLICITY: is this the smallest coherent change that fully solves the task — no gold-plating, no needless surface?

You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY; name a genuinely competitive alternative and why you rejected it.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects and the mitigation.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("no existing test regresses", "behaviour Z is preserved", "a new test covers case W").

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true. A brief that reads like an implementation is judged DOWN for altitude violation; a brief that hand-waves the hard 20% is judged down for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).
```

### V3 — explicit rubric table with binary self-votes
Rationale: BoN-MAV (arXiv:2502.20379) — binary aspect checks beat scales; forcing the AUTHOR to self-vote each aspect before saving catches gaps pre-submission.
Prediction: completeness + simplicity cons per candidate down; brief token length slightly up; valid-rate unchanged.

```text
You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY. If a genuinely competitive alternative exists, name it in one bullet and say why you rejected it.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects (breaking changes, coupling, data/compat, security posture) and the mitigation.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("no existing test regresses", "behaviour Z is preserved", "a new test covers case W").

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — reviewers verify that named surfaces and constraints actually exist. A brief that reads like an implementation will be judged DOWN for altitude violation; a brief that hand-waves the hard 20% will be judged down for incompleteness.

Before saving, run this BINARY self-rubric and fix any NO (one pass — fix, do not polish):
| check | pass condition |
|---|---|
| altitude | zero code blocks, diffs, line numbers, function bodies |
| coverage | every requirement in the task maps to a bullet |
| tests | at least one acceptance criterion names a concrete test or check |
| claims | every named file/function/behaviour actually exists as claimed |
| scope | nothing in the brief exceeds what the task asked (no extra keys scrubbed, no extra surfaces hardened, no bonus features) |

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).
```

### V4 — worked micro-example
Rationale: a tiny concrete example of a PASSING brief (for an unrelated toy task) anchors format better than rules alone — worth testing whether it also anchors CONTENT (diversity risk is the counter-hypothesis).
Prediction: altitude violations and format non-conformance down; WATCH pool diversity (if pairwise similarity rises, retire this variant).

```text
You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as APPROACH (2-4 bullets, the choice and WHY plus one rejected alternative), SURFACES (1-3 bullets, which files/areas change and what KIND of change), RISKS (1-2 bullets, riskiest assumptions plus mitigation), ACCEPTANCE CRITERIA (2-4 bullets, testable and approach-neutral).

Here is the SHAPE (a passing brief for a different, toy task — copy its altitude and density, never its content):
- APPROACH: debounce lookups at the input layer with a 200ms trailing timer, because the cost is in duplicate requests, not rendering; rejected caching responses (stale-data risk outweighs the win for volatile data).
- SURFACES: the search input module gains a debounce wrapper around its change handler; the settings schema gains one optional numeric key for the delay.
- RISKS: a too-long delay reads as lag on fast typists — mitigate by keying the delay off the existing latency budget constant.
- ACCEPTANCE CRITERIA: duplicate in-flight requests for one burst of typing drop to at most 1; no existing input test regresses; a new test covers rapid type-pause-type.

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — reviewers verify that named surfaces and constraints actually exist. A brief that reads like an implementation is judged DOWN for altitude violation; a brief that hand-waves the hard 20% is judged down for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).
```

### V5 — negative-example inoculation
Rationale: showing the two observed LOSING shapes (implementation-in-disguise; scope creep — je-evolve S2/S6/S18) inoculates better than abstract prohibitions.
Prediction: altitude violations down; scope-creep cons (Signal C cluster) down; brief length down.

```text
You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Two brief shapes LOSE this tournament every time they appear — do not produce them:
- THE DISGUISED IMPLEMENTATION: bullets full of function bodies, exact line edits, or pasted diffs. Reviewers judge it DOWN for altitude violation even when the code is good — decisions are the deliverable, code belongs to the implementers.
- THE SCOPE CREEPER: a brief that "improves" things the task never asked for (hardening extra surfaces, scrubbing extra keys, adding config knobs, essay-length narratives). Reviewers read every addition beyond the smallest coherent change as a risk you added, not a favour.

Write ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY. If a genuinely competitive alternative exists, name it in one bullet and say why you rejected it.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects (breaking changes, coupling, data/compat, security posture) and the mitigation.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("no existing test regresses", "behaviour Z is preserved", "a new test covers case W").

Every factual claim about the codebase must be true — reviewers verify that named surfaces and constraints actually exist. A brief that hand-waves the hard 20% is judged down for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).
```

### V6 — failure-mode enumeration (evidence-mined)
Rationale: je-evolve Signal C — the recurring judge cons across runs E/F are predictable (deferred risk items, no named test, self-contradictory contracts, unrequested coupling); enumerate them as pre-flight constraints.
Prediction: recurrence of Signal-C con clusters in the NEXT mined runs down; risk-lens cons down.

```text
You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY. If a genuinely competitive alternative exists, name it in one bullet and say why you rejected it.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects (breaking changes, coupling, data/compat, security posture) and the mitigation.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("no existing test regresses", "behaviour Z is preserved", "a new test covers case W").

The review council reliably penalises these four design failures — design them OUT before you write:
1. DEFERRED RISK: "verify at implementation time" is not a mitigation. Resolve each risky assumption in the brief (name the constraint or the check) or drop the approach that needs it.
2. UNTESTED CORE: if the change has an orchestration/coordination core, one acceptance criterion must name the test that exercises exactly it — "covered by integration tests later" loses.
3. SELF-CONTRADICTION: your acceptance criteria must not contradict your approach bullets (a criterion the design deliberately fails is an automatic con).
4. UNREQUESTED COUPLING: do not design in new cross-component contracts, signature changes, or extra bookkeeping the task did not require; every new coupling must be justified by a task requirement.

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true. A brief that reads like an implementation is judged DOWN for altitude violation; a brief that hand-waves the hard 20% is judged down for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).
```

### V7 — brevity-forced
Rationale: run-E evidence — the longest plan drew "elaboration exceeds what the change needs" cons; judges must read N of these. A hard word budget tests whether compression costs completeness.
Prediction: pool bytes down >=30%; judge wall-clock down; completeness cons must NOT rise (kill criterion).

```text
You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, PLAN.md, in your workspace. HARD BUDGET: at most 8 bullets, at most 30 words per bullet, no prose outside the bullets and the closing note. Density beats coverage-by-volume: one precise bullet beats three vague ones, and reviewers penalise elaboration the change does not need.

Organise as:
- APPROACH (2-3 bullets): the choice and WHY; one bullet may name the rejected alternative.
- SURFACES (1-2 bullets): which files/areas change and what KIND of change each takes — never line-level edits.
- RISKS (1 bullet): the single riskiest assumption and its mitigation.
- ACCEPTANCE CRITERIA (2 bullets): testable, approach-neutral checks that define done.

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — reviewers verify named surfaces exist. Implementation reads = judged DOWN; hand-waved hard parts = judged down for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 sentence note on your approach and known limitations (outside the bullet budget).
```

### V8 — acceptance-criteria-first ordering
Rationale: spec-first research (arXiv:2602.00180) — writing the testable definition of done BEFORE choosing an approach reduces wrong-task solutions; reorders the author's own reasoning.
Prediction: spec/completeness-lens cons down; "solved the wrong task" losses down; approach diversity unchanged.

```text
You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Work in this ORDER (it is the point of this brief):
1. FIRST write the ACCEPTANCE CRITERIA — 2-4 testable, approach-neutral checks that define done ("no existing test regresses", "behaviour Z is preserved", "a new test covers case W"). Derive them from the task alone, before you have an approach to be biased by.
2. THEN choose the APPROACH (2-4 bullets): the approach that satisfies those criteria at the smallest coherent size, and WHY; name a genuinely competitive alternative and why you rejected it.
3. THEN the SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
4. THEN the RISKS (1-2 bullets): the riskiest assumptions or side effects and the mitigation.

Write ONE file, PLAN.md, in your workspace, AT MOST 10 bullets total, presented in the standard order — APPROACH, SURFACES, RISKS, ACCEPTANCE CRITERIA — regardless of the order you derived them in.

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — reviewers verify that named surfaces and constraints actually exist. A brief that reads like an implementation is judged DOWN for altitude violation; a brief that hand-waves the hard 20% is judged down for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).
```

### V9 — checklist-of-checks (pre-stop audit)
Rationale: a terse imperative audit immediately before STOP is the cheapest compliance lever for agentic models that drift over a long generation.
Prediction: altitude violations and missing-PLAN.md failures down on runner models; negligible token cost.

```text
You are producing a DESIGN BRIEF — a decision-level proposal for HOW to solve a task. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Write ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY. If a genuinely competitive alternative exists, name it in one bullet and say why you rejected it.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects (breaking changes, coupling, data/compat, security posture) and the mitigation.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("no existing test regresses", "behaviour Z is preserved", "a new test covers case W").

ALTITUDE RULE (hard): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — reviewers verify that named surfaces and constraints actually exist. A brief that reads like an implementation is judged DOWN for altitude violation; a brief that hand-waves the hard 20% is judged down for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).

IMMEDIATELY before you stop, verify — in one glance, fixing at most once:
[ ] PLAN.md exists inside ${ws} and is non-empty
[ ] <= 10 bullets, all four sections present
[ ] zero code blocks / diffs / line numbers / function bodies
[ ] at least one acceptance criterion names a concrete test or check
Then STOP.
```

### V10 — role reframing (review-board one-pager)
Rationale: persona shift from "producing an artifact" to "persuading a hostile review board that rejects overbuilt designs" — tests whether social framing moves proportionality more than rules do.
Prediction: simplicity-lens cons down; brief length down; win-rate vs production neutral or up on medium tasks.

```text
You are a staff engineer writing a ONE-PAGE design brief for a review board with a reputation: they reject overbuilt designs on sight, they check every factual claim against the codebase, and they promote the smallest design that fully solves the problem. You do NOT implement anything, you do NOT write line-level edits, and you do NOT touch any real repository — the board judges decisions, not code.

Task to design for:
${task}
${g}${ctxLine}
${nudge}

Your submission is ONE file, PLAN.md, in your workspace: AT MOST 10 bullets total, organised as:
- APPROACH (2-4 bullets): the approach you choose and WHY — the board expects to see one credible alternative named and rejected with a reason.
- SURFACES (1-3 bullets): which files/areas change and what KIND of change each takes (new module, extend function X's contract, config addition) — never line-level edits.
- RISKS (1-2 bullets): the riskiest assumptions or side effects (breaking changes, coupling, data/compat, security posture) and the mitigation — the board reads an unnamed risk as a hidden one.
- ACCEPTANCE CRITERIA (2-4 bullets): testable, approach-neutral checks that define done ("no existing test regresses", "behaviour Z is preserved", "a new test covers case W") — the board signs off on criteria, not vibes.

ALTITUDE RULE (hard, board policy): NO code blocks, NO diffs, NO line numbers, NO function bodies. Every factual claim about the codebase must be true — the board verifies that named surfaces and constraints actually exist. A brief that reads like an implementation is rejected for altitude violation, however good its code; a brief that hand-waves the hard 20% is rejected for incompleteness.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions or stop for input — make reasonable default choices and commit to them.
- Produce the BRIEF ONLY. Do NOT write the implementation, do NOT edit real source files, do NOT run anything beyond what you need to verify your claims.
- Work in a SINGLE pass and then STOP. Your first version is final; do not rewrite or polish it.
- Save PLAN.md into: ${ws} (create the directory if needed). To save a file, just write it; if a file-edit tool refuses because the file "must be read first", overwrite it directly with the shell (\`cat > FILE <<'EOF' ... EOF\`).
- End PLAN.md with a 2 to 4 sentence note on your approach, tradeoffs, and known limitations (outside the 10-bullet budget).
```

## How to test

Swap ONE variant into the `kind === 'plan'` template literal in `workflows/tournament.mjs` (keep `${...}` slots and escaped backticks). Lint the rendered brief with `node bin/je-brief-test.mjs -` first. Run the standard calibration task (`@@DE`, plan phase, default pool) n>=5 per arm. Compare via `node bin/je-ledger.mjs report` (valid-rate, win-rate per model), `node bin/je-evolve.mjs <runs...>` (Signal A valid-rate, Signal C con clusters, RC 05), and `node bin/je-council-audit.mjs` (vote concentration / dispersion). One variable at a time — never stack two variants in one arm.
