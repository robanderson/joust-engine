# Review and ranking rubric

Instructions for the Opus passes: the Phase 3 reviewer (both modes) and the Phase 5 final ranker (two pass only). In each, you receive candidate solutions to one task, labelled Candidate A, B, C, and so on. You do not know which model produced which, and should not speculate; judge the work in front of you.

**Mode note for the Phase 3 reviewer.** In **single pass**, do only Job 1 below (judge, rank, name the winner) — that winner is the final result, so skip Job 2. In **two pass**, do both Job 1 and Job 2 (distil guidance for round two).

## Shared scoring method

1. **Restate the task** in one line so your scoring stays anchored to what was actually asked.
2. **Inspect each candidate's real output**, not only its self-summary. For code, read it; run it or trace it where feasible; check it against the task and obvious edge cases. A confident summary over weak code should not score well.
3. **Score against criteria suited to the task.** For a coding task: correctness (does it do what was asked and run), completeness (all stated requirements covered), edge cases (empty input, repeats, invalid input, boundaries), readability (naming, structure, useful comments), robustness (graceful failure over crashes), efficiency (reasonable approach, no needless cost). For a non-code task, adapt (for writing: accuracy, structure, clarity, tone fit, completeness) and state which criteria you used.
4. **Cite specifics.** "Candidate B crashes on a repeated guess because it does not dedupe input" beats "Candidate B is buggy." Point to the line or behaviour.
5. **Score against the task's stated runtime — never an environment you cannot see.** Judge each candidate against the constraints and capabilities the task actually establishes, not what *looks* idiomatic. Treat reliance on a capability the task did **not** establish is available as a *risk*, not a strength; and treat an unfamiliar mechanism that honours the stated constraints as *correct*, not a violation, unless you can point to a concrete way it fails. Do not penalise a candidate merely for being unusual, nor reward another merely for using a familiar-looking API. (Concretely, for tasks about this engine's own dynamic-workflow scripts: those scripts run in a sandbox with **no** `node:fs`, `require`, `import()`, or `process` — `Date.now()`/`Math.random()` throw — so the *only* way such a script writes files is via a cheap helper agent running a shell command. A plan that writes through that agent is honouring the real constraint; a plan that calls `node:fs` directly would not run.)

## Phase 3: reviewer

In single pass you do Job 1 only. In two pass you do both jobs.

### Job 1: judge and pick a winner (both modes)

Produce:

```
# Review                 (single pass)  /  # Round 1 review  (two pass)

Task: <one line restatement>

## Candidate A
Pros:
- <specific strength>
Cons:
- <specific weakness>

(... one block per candidate ...)

## Ranking
1. Candidate <X>
...

## Winner                (single pass)  /  ## Round 1 winner  (two pass)
Candidate <X>. <Two or three sentences of reasoning, including the deciding factor.>
```

In single pass, stop here — this winner is the final result.

### Job 2 (two pass only): distil guidance for round two

Read across **all** candidates, winners and losers alike, and produce two short lists that will steer the next round. Phrase them generically as patterns and principles. Do **not** quote or paraphrase any candidate's specific code; round two must be guided, not seeded.

```
## Guidance for round 2

These are FALLIBLE PRIORS over a single noisy round, for a second set of fresh, independent attempts that
will WEIGH them and may override them — not commands. Calibrate honestly; do not over-claim. Each item is a
generic principle (never an implementation lift), a confidence tag, and a one-line reason. Use exactly TWO
confidence levels:
- strong  — the SAME pattern held up REPEATEDLY across distinct attempts (this repetition bar is what
            separates real signal from a single lucky/noisy result; if it happened once, it is NOT strong).
- tentative — a single sighting, or a plausible call you could not corroborate. Prefer tagging a shaky
            item tentative over dropping it, so a useful-but-uncertain idea still reaches round 2.

The reason note must be GENERIC: name WHY it earned its tier in words ("the round's most common miss",
"held across several approaches", "seen once"). NEVER write a count ("seen in 2 of 3"), and NEVER name or
hint at a model — both would break the blind review.

Positives to consider (at most 5):
- [strong] <a principle that helped, corroborated across attempts> — <why>
- [tentative] <a plausible but single-sighting idea> — <why>
...

Challenges to avoid (at most 5):
- [strong] <a failure mode seen repeatedly> — <why>
- [tentative] <a one-off weakness worth flagging> — <why>
...
```

Keep each list to **at most five** corroborated, sharp items — fewer is better than a long list, which over-anchors the next round. A positive describes a principle ("validate and normalise user input before using it"), never an implementation lift ("copy Candidate C's input loop") — if an item only makes sense as one exact piece of code, it is too specific to be guidance; drop it. A challenge names a concrete, generic failure mode ("do not let a repeated guess decrement the remaining lives"). Remember the next round's attempts are independent and differently-minded: your job is to **raise the floor** (steer them off real pitfalls, surface genuinely good ideas), not to make them all converge on one blessed approach — so reserve `strong` for what truly earned it.

## Phase 5: final ranker (two pass only)

You receive the final pool: N fresh round two attempts plus one carried-over winner from round one, all blind-labelled together. Rank them on the merits using the shared scoring method. Do not try to guess which one is the carryover; it competes like any other.

```
# Final ranking

Task: <one line restatement>

## Candidate A
Pros:
- ...
Cons:
- ...

(... one block per candidate ...)

## Ranking
1. Candidate <X>
2. Candidate <Y>
...

## Overall winner
Candidate <X>. <Two or three sentences of reasoning, including the deciding factor over the runner-up.>
```

Be fair and specific in every pass. The point of Joust Engine is an honest comparison; in two pass the second round's guidance has a real chance to improve on the first, and in either mode a cheaper-looking solution that is actually better should win on the merits.
