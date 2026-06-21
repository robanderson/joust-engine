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
