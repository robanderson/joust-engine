# Prompt Lab 06 — Guidance synthesis (`synthesizeGuidance()`)

**Anchor:** `workflows/tournament.mjs` → `synthesizeGuidance()` ~line 2042 (council path; schema `GUIDANCE_SYNTH_SCHEMA`, cap `GUIDANCE_CAP` = 5, integrity-guarded). The legacy single-judge equivalent is `judgePrompt()`'s `guidanceBlock` (~line 890) — same rules; test the council path first. Output is rendered into round-2 briefs by `brief()` as FALLIBLE PRIORS. As of commit `b360a37`.

**Interpolation slots every variant MUST keep:** `${task}`, `${block}` (council verdicts JSON), `${GUIDANCE_CAP}`.

**Engine-contract invariants kept in EVERY variant:** synthesiser is NOT a judge/decision-maker — never picks a winner, ranks, tallies, or merges votes; two lists (positives / challenges); per item `text` (generic principle, never an implementation lift), `conf` ("strong" only when corroborated repeatedly across distinct attempts, else "tentative"), `why` (short generic clause); NO candidate-specific code, NO model identities, NO counts ("seen in 2 of 3" forbidden — the no-N rule protects blind round 2); at most `${GUIDANCE_CAP}` per list.

## Current production prompt (verbatim)

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

## Variants

### V1 — corroborate-then-strip procedure
Rationale: GEPA-style two-phase reflection — cluster and count evidence INTERNALLY first, then strip the counts at emission; separating calibration from wording should raise conf accuracy without leaking N.
Prediction: "strong" items that recur as next-round pitfalls anyway (mis-calibrated strongs) down; integrity rejections unchanged.

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

Work in two phases. PHASE 1 (private — never emitted): cluster the verdicts' pros into recurring patterns and the cons into recurring pitfalls; for each cluster note privately how many DISTINCT candidates and DISTINCT lenses it spans (same-lens repetition across candidates is one judge's taste, not corroboration). PHASE 2 (emitted): write the lists — a cluster spanning several distinct candidates AND more than one lens is "strong"; anything else is "tentative". Then STRIP every number: `why` describes the evidence in words ("held across several unrelated approaches", "one attempt, one lens", "plausible but unconfirmed") — never a count.

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts:
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

### V2 — actionability test per item
Rationale: guidance only earns its context window if a fresh attempt would DO something differently because of it; an explicit counterfactual filter kills platitudes.
Prediction: round-2 briefs shorter; round-2 win-over-carried-champion rate up; platitude items ("write tests", "handle errors") → 0.

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

THE ACTIONABILITY TEST — apply it to every item before including it: "would a competent fresh attempt, already trying its best, plausibly act DIFFERENTLY because of this line?" Generic virtues ("be thorough", "test your code", "handle edge cases") fail the test — every attempt already believes it is doing those. An item passes when it names a task-specific fork in the road: a choice that helped, a trap that looked correct, a constraint that was easy to miss. Items that fail the test are dropped, not reworded.

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

### V3 — worked example items
Rationale: one good and one bad example item pin the target altitude (generic principle with concrete trigger) better than the abstract "never an implementation lift" rule.
Prediction: guidance integrity rejections down; implementation-lift items → 0; round-2 attempts diverge more (guidance steers without prescribing).

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

The target shape (examples from an unrelated round — copy the ALTITUDE, never the content):
GOOD item: {text: "Validating the input contract before transforming it caught failures the transform-first attempts shipped", conf: "strong", why: "held across several unrelated approaches"} — a generic principle with a concrete trigger; a fresh attempt can act on it its own way.
BAD item: {text: "Add a validateSchema(input) call at the top of process()", ...} — an implementation lift; it only makes sense as one exact piece of code and would collapse round-2 diversity. DROP such items.
BAD item: {text: "Be more careful with edge cases", ...} — true of every task ever; carries no information.

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text; conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

### V4 — challenges-first ordering with severity anchor
Rationale: pitfalls are the higher-value half (round-2 attempts repeat round-1 mistakes more than they miss round-1 wins); synthesise challenges FIRST while attention is freshest and anchor each to its cost.
Prediction: round-2 repetition of round-1 con clusters (je-evolve Signal C across rounds) down; positives quality unchanged.

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

Synthesise the CHALLENGES first — they are the expensive half: a fresh round repeats an unnamed pitfall far more often than it misses an unnamed win. For each challenge, make `text` name both the pitfall AND what it cost ("...which judges read as scope creep", "...which broke the stated constraint"), so a fresh attempt feels the stakes. Then synthesise the positives.

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
- positives: generic patterns/choices that helped anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

### V5 — tighter cap (3 per list)
Rationale: research on priors-in-context — few sharp items steer better than five diluted ones; the render-side cap stays 5 so this is prompt-only.
Prediction: round-2 attempts reference guidance more faithfully (fewer ignored items); if round-2 quality drops, information was lost — retire.

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier.

HARD CAP: at most 3 items per list — strictly the three highest-evidence, highest-consequence items. If you drafted five, delete the two weakest; a fresh attempt reads three sharp priors and internalises them, but skims five. (An emptier list is legal when the round genuinely taught less.)

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

### V6 — dedupe/orthogonality rule
Rationale: correlated council cons produce near-duplicate guidance items that burn the cap; require pairwise-orthogonal items.
Prediction: distinct-theme coverage per list up at same cap; round-2 briefs cover more failure surface.

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

ORTHOGONALITY RULE: council lenses overlap, so the same underlying lesson often appears in several verdicts in different words — that is ONE item, not three. Before emitting, check every pair of items in a list: if two would change a fresh attempt's behaviour in the same way, merge them into the sharper phrasing and free the slot for a genuinely different lesson. Each slot you keep must earn its place by covering ground no other item covers.

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

### V7 — role reframing (coach who never saw the games)
Rationale: the coach frame naturally produces transferable principles ("what to practise") rather than artifact critique ("what was wrong with attempt C") — the exact altitude the no-lift rule wants.
Prediction: candidate-specific leakage → 0; guidance genericity up (measured by absence of artifact-unique nouns).

```text
You are a COACH preparing a NEW team for a contest an earlier team just played — and you are NOT a judge or decision-maker: you never pick winners, rank anyone, or tally votes (that is done elsewhere in code). You did not watch the games; all you have is the blind referees' final reports below (candidates are letters only; you do not know which model is which and must not speculate). The new team never sees those reports — only your two lists — and they are FALLIBLE PRIORS the new team may overrule, so calibrate honestly.

Task the earlier team was given (the new team gets the same one):
${task}

Coach at the level of PLAY, not of plays: a lesson tied to one specific move in one specific game ("candidate C's exact code") is useless to a team that will play its own way — drop any item that only makes sense as one exact piece of code. NO candidate-specific code, NO model identities, NO counts (never "seen in 2 of 3" — describe the reason in words).

Produce:
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The referees' final reports (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

### V8 — schema-first with integrity self-check
Rationale: lead with the exact object plus the three ways guidance gets auto-rejected (junk, lift, count-leak); format-anchoring for the structured-output call.
Prediction: guidance integrity-guard rejections and retries → 0.

```text
You will return EXACTLY this object and nothing else: {positives: [{text, conf, why}], challenges: [{text, conf, why}]} — at most ${GUIDANCE_CAP} items per list. Three defects get the whole result auto-rejected by an integrity guard: (1) junk filler (placeholder or near-duplicate items), (2) implementation lifts (an item that only makes sense as one exact piece of code), (3) leakage (candidate letters, model identities, or counts like "2 of 3" anywhere in an item).

You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item: text (a generic principle); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; why — one short generic clause naming the reason for the tier (in words, never a count). Fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}
```

### V9 — brevity-forced item budget
Rationale: cap `text` at 25 words and `why` at 10 — round-2 briefs carry up to 10 rendered items; word discipline compounds across the whole round-2 pool.
Prediction: round-2 brief tokens down; guidance adherence unchanged (kill criterion: round-2 quality drop).

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

WORD BUDGET (hard): each `text` at most 25 words; each `why` at most 10 words. These lines are injected verbatim into every second-round attempt's brief — every word you spend is spent N times. One precise clause beats a qualified paragraph.

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

### V10 — failure-mode enumeration (what bad guidance did to past rounds)
Rationale: inoculate with the three observed downstream harms — over-confident tentatives steering rounds wrong, lifts collapsing diversity, platitudes wasting the cap — so the synthesiser optimises for the CONSUMER.
Prediction: mis-calibrated "strong" rate down; round-2 diversity (pairwise distinctness) up vs production.

```text
You are a guidance SYNTHESISER, not a judge and NOT a decision-maker. You are given the blind council judges' FINAL verdicts on one task (letters only; you do not know which model is which and must not speculate). Do NOT pick a winner, do NOT rank candidates, do NOT tally or merge votes — that is done elsewhere in code. Your ONLY job is to distil FALLIBLE PRIORS for a fresh, independent second round of attempts.

Task the candidates were given:
${task}

Know how guidance HARMS the next round when done badly — these are the failure modes you are avoiding:
1. FALSE STRONG: a single-sighting pattern tagged "strong" steers every fresh attempt toward one judge's noise. When in doubt, "tentative" — the brief tells attempts they may overrule tentatives.
2. DIVERSITY COLLAPSE: an implementation-shaped item makes ten fresh attempts converge on one design. Keep every item at principle altitude so attempts can honour it in different ways.
3. CAP WASTE: a platitude ("test thoroughly") occupies a slot that a real, task-specific lesson needed.

Produce two short generic lists, NO candidate-specific code, NO model identities, and NO counts (never "seen in 2 of 3" — describe the reason in words):
- positives: generic patterns/choices that helped anywhere this round.
- challenges: generic pitfalls/weaknesses/constraint-violations seen anywhere this round.
For EACH item give: text (a generic principle, never an implementation lift — drop it if it only makes sense as one exact piece of code); conf — "strong" ONLY if the same pattern held up REPEATEDLY across distinct attempts, otherwise "tentative"; and why, one short generic clause naming the reason for the tier. Keep each list to at most ${GUIDANCE_CAP} items — fewer, sharper, corroborated items beat a long list.

The council's final verdicts (JSON, verbatim):
${block}

Return only the two guidance lists (each item: text, conf, why).
```

## How to test

Swap ONE variant into the `prompt` template inside `synthesizeGuidance()` (keep `${task}`, `${block}`, `${GUIDANCE_CAP}`; schema stays `GUIDANCE_SYNTH_SCHEMA`). Guidance quality is measured DOWNSTREAM: run two-pass calibration tournaments n>=5 per arm with a pinned round-1 pool, then compare round-2 outcomes — round-2 win rate over the carried champion, round-2 valid-rate, round-2 pairwise diversity, and recurrence of round-1 con clusters in round-2 verdicts (`node bin/je-evolve.mjs` Signal C across the paired runs). Also track integrity-guard rejections in `_engine-logs`.
