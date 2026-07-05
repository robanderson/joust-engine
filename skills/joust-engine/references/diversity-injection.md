# Diversity injection

How to push the N attempts apart so they explore different regions of the solution space instead of converging on near-identical answers. Read this when dispatching a round.

## Why this exists

Three independent diversity axes stack:

1. **Model heterogeneity.** Different model families and sizes (for example three Haiku, two Sonnet, one Opus) carry different inductive biases. This is the cheapest strong diversity lever: you pay mostly cheap-model rates and still get genuinely different approaches.
2. **Sampling stochasticity.** Same model, different random rolls. Weakest axis on its own; at low temperature, identical prompts can still cluster.
3. **Prompt perturbation.** A distinct framing per attempt, which guarantees no two agents begin from exactly the same state. This is what this file configures.

Perturbation costs almost nothing (a handful of prompt tokens) and does not reduce compute load; it raises the quality of diversity per token already being spent. Its largest payoff is differentiating **same-model siblings**: agents sharing one model on an identical prompt are the most likely to collapse onto the same answer, so they benefit most from being pushed apart.

## Two pools

Pool A changes the path an attempt takes. Pool B changes the target it aims at. Treat them differently.

### Pool A: approach nudges (default on, reviewer-blind)

These vary where an attempt starts and how it proceeds, not what counts as a good answer. Because they do not move the success criteria, the reviewer does not need to know which nudge an attempt received, so blind review is preserved.

**Pool A is task-type-aware.** The default nudges below are code-flavoured ("data model", "test-first") and become nonsense prepended to a prose/analysis/decision task. So tag each nudge by domain and draw only from the applicable set. Detect the task type with a light heuristic at draw time — if the task says write a program/function/script/test/code (or names a language), use **code**; otherwise use **prose**. When N exceeds the chosen set, top up from the `any` set.

**Code (default for code tasks):**
1. from first principles `[any]`
2. starting from the data model or core types `[code]`
3. starting from the public interface or CLI surface `[code]`
4. test-first: sketch the tests before the implementation `[code]`
5. simplest thing that could work first, then refine `[any]`
6. sketch two approaches briefly, then commit to the strongest `[any]`
7. happy path first, then harden `[code]`
8. edge cases first, then the core `[code]`
9. write a short plan before any code `[any]`
10. as if it will be maintained by someone else in a year `[code]`

**Prose / analysis / decision tasks (use these instead for non-code):**
1. from first principles — question the premises `[any]`
2. lead with your strongest claim, then support it
3. structure it as question → answer
4. draft the conclusion first, then justify it backwards
5. write for a smart, skeptical reader who will push back
6. favour concrete examples over abstractions
7. start from the audience and what they need to walk away with
8. cover the strongest counter-argument head-on
9. simplest framing that could work first, then deepen `[any]`
10. sketch two angles briefly, then commit to the strongest `[any]`

Items tagged `[any]` work for either domain and are the top-up pool. Keep the sampling rules below (draw without replacement, bias same-model siblings apart) unchanged; they apply within the chosen set.

### Pool A2: angle briefs (preferred for design-brief rounds)

One-line nudges shift an attempt's first step; **angle briefs** commit an explorer to a whole region of the solution space. Research: distinct per-explorer specification angles yield 2-3x measured diversity versus sampling randomness alone, and best-of-N quality is ceilinged by pool diversity (arXiv:2606.10302). For **design-brief rounds** — attempts produce plans/proposals/drafts rather than a direct artifact — prefer Pool A2: the orchestrator writes (or draws from the library below) N orthogonal ONE-PARAGRAPH angle briefs, each committing its explorer to a distinct solution-space angle.

Like Pool A, angle briefs are **blind-review-safe**: each steers the STARTING ANGLE — where the attempt begins and what it treats as the backbone — never the quality criteria or what counts as a good answer, so the reviewer stays blind to the draw and no attempt is set up to be marked down for following its brief.

**Rules** (Pool A sampling rules apply, plus):

- Draw **without replacement** within a round — no two attempts share an angle.
- **Same-model siblings get the most-distant angles** available (e.g. minimal-diff conservative vs refactor-first structural; data-model-led vs interface/contract-led).
- The angle text **rides the existing `r1nudge` / `r2nudge` fields verbatim** — no engine changes; that plumbing already carries arbitrary text.
- **Log the draw** (attempt → angle name, plus seed) exactly as for Pool A, so the run is reproducible and the report can show it.
- If N exceeds 10, top up from the Pool A one-liners rather than repeating an angle.

**Library: 10 angle briefs for engineering tasks.** Each is 3-5 sentences; prepend one, whole and verbatim, per attempt.

1. **minimal-diff conservative** — Anchor your solution in the code as it stands today. Treat the existing structure, names, and conventions as fixed, and find where the task's behavior can attach within them. Start by identifying the exact seams where the change wants to live, and let the current architecture tell you the shape of the change. Restructuring is out of scope for your angle; work with the grain of what exists.

2. **refactor-first structural** — Begin by asking what shape the code would need to be in for this task to become easy, and treat that restructuring as a first-class part of your plan. Map the current structure, name the friction it creates for this specific task, and design the target structure before designing the feature. Let the feature itself fall out as the final, small step on top of the reshaped foundation.

3. **data-model-led** — Start from the data: the entities, their fields, their relationships, and their lifecycle. Write the schemas, types, or core structures first, and let every function and interface be derived from what the data demands. When a design question arises, resolve it by asking what the most truthful representation of the data would be.

4. **interface/contract-led** — Begin at the boundary: the public API, CLI surface, function signatures, or protocol that callers will touch. Write the contract first — inputs, outputs, errors, invariants — as if its consumers already existed, and only then work inward to an implementation that honors it. Let questions about internals be settled by whatever makes the contract cleanest to uphold.

5. **test-harness-led** — Start by designing how the behavior will be exercised and observed: the harness, the fixtures, and the concrete cases that would demonstrate the task is done. Sketch those executable checks before any implementation, and let their setup needs drive the shape of the code under test. Build outward from what is verifiable.

6. **operational/observability-led** — Approach the task from the perspective of the person operating this in production. Start from how it will be deployed, configured, monitored, and debugged: what it logs, what it exposes, how an operator sees inside it when something is off. Design that runtime story first, and let the implementation be shaped by what makes its behavior legible in operation.

7. **failure-mode-led** — Begin by enumerating the ways this can go wrong: bad inputs, partial failures, races, resource exhaustion, dying midway. Design the behavior of each failure path first — what is detected, what is reported, what state survives — then fill in the happy path as the case where none of them fire. Let the failure taxonomy drive the structure.

8. **performance-budget-led** — Start by writing down a concrete resource budget for the task — latency, throughput, memory, calls to expensive dependencies — and identifying where the hot path runs. Design the data flow and algorithms against that budget from the first sketch, rather than as a later tuning pass. When two designs are otherwise comparable, let the budget break the tie.

9. **security-posture-led** — Approach the task from its trust boundaries: who or what supplies each input, what privileges each component holds, what an adversarial caller could attempt. Map those boundaries first, and design validation, authority, and data handling around them before filling in functionality. Let where untrusted data flows determine the shape of the solution.

10. **simplest-thing-spec-purist** — Read the task statement as the entire specification: build exactly what it asks, in the most direct construction available, and nothing speculative beyond it. Start by restating the requirements as a short checklist, then design the plainest mechanism that satisfies each item literally. Where the spec is silent, choose the least mechanism rather than anticipating futures.

### Pool B: objective lenses (opt-in, logged)

These deliberately bias the tradeoff an attempt makes. They are useful when you want to fan attempts across a tradeoff frontier on purpose. The cost: an attempt told "quickly" may correctly produce something fast and thin, and a blind reviewer scoring on completeness and robustness will mark it down through no fault of the attempt.

1. safely
2. quickly
3. efficiently
4. robustly
5. minimally
6. defensively
7. idiomatically
8. portably
9. readably
10. thoroughly

Two honest ways to handle Pool B, pick one and state it in the report:
- **Best-overall (default).** Keep the review blind. The lens is pure exploration spice; whichever attempt produced the best overall solution to the real task wins, regardless of its lens. You accept that some lenses will reliably underperform on this task, which is the bet you are making.
- **Judge-to-intent.** Pass each attempt's lens to the reviewer so it judges relative to that intent. This breaks blindness and is only worth it when you genuinely want frontier coverage where each lens is assessed on its own terms.

If the user did not opt into Pool B, use Pool A only.

## Sampling rule

- **Draw without replacement** within a round, so no two attempts in that round share a modifier. This is what guarantees distinct starting state.
- **Bias for same-model spread:** when several attempts share a model, assign them the most dissimilar modifiers available, so siblings are pushed furthest apart.
- **If N exceeds the pool** in use (10 for one pool, 20 combined): either draw from both pools combined, or compose a Pool A nudge with a Pool B lens to form N distinct pairs, or only then allow repeats.
- **Seed and log** the draw (attempt to modifier, plus the seed) so a run is reproducible and the report can show what was applied.

## Applying it to the brief

Prepend the drawn modifier to the attempt brief. For a Pool A nudge:

```
Approach this task <nudge> (for example: test-first: sketch the tests before the implementation).
```

For a Pool B lens:

```
In this attempt, lean toward solving the task <lens> (for example: defensively).
```

Keep the rest of the brief identical to every other attempt. The modifier is the only thing that differs, so any divergence is attributable to it.

## Mode specifics

### Single pass

One round only: take a fresh draw, Pool A on by default, Pool B if the user opted in. Same rules as round one below. There is no second round, so nothing further applies.

### Two pass

- **Round one:** fresh draw, Pool A on by default, Pool B if the user opted in. Maximises exploration before any guidance exists.
- **Round two:** the distilled guidance already steers every attempt toward similar objectives, which risks convergence, so a **fresh Pool A draw** is valuable to keep paths apart. Do **not** add Pool B lenses in round two: the guidance carries the objective steering, and a conflicting lens ("quickly" against guidance that says "handle every edge case") sends mixed signals. Log the round two draw separately from round one.
