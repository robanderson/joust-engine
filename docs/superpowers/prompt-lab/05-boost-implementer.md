# Prompt Lab 05 — Boost implementer (`boostCandidate()`)

**Anchor:** `workflows/tournament.mjs` → `boostCandidate()` ~line 2117 (judging-v3 steelman shootout: applies one finalist's change-list to a COPY of its artifact dir; the original staged dir is the ratchet source and is never touched). As of commit `b360a37`.

**Interpolation slots every variant MUST keep:** `${q(outDir)}`, `${q(origDir)}` (inside the copy command — keep the `mkdir -p ... && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null` shape), `${outDir}` (edit target), `${list}` (the numbered change-list with `(addresses: ...)` lines).

**Engine-contract invariants kept in EVERY variant:** copy FIRST, then edit ONLY the copy under `${outDir}`; apply EXACTLY the change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items); every file not named by the list stays byte-identical; terminates with a reply (production: "done"); "approved internal step of the joust-engine tournament" framing retained (it pre-empts refusals); no model identities.

## Current production prompt (verbatim)

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items):

${list}

Keep every file not named by the list byte-identical. When done, reply "done".
```

## Variants

### V1 — per-item applied/skipped report
Rationale: the engine currently learns nothing about WHICH items landed; a per-item terminal report makes boosts auditable and surfaces silently-impossible items.
Prediction: post-boost re-judge "con not actually fixed" findings down; skipped-item visibility from 0 to full (enables je-evolve mining of steelman quality).

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items):

${list}

Keep every file not named by the list byte-identical. An item you cannot apply as written (target text absent, item self-contradictory, item would require a redesign) must be SKIPPED, not improvised around.

When done, reply with one line per item — "N: applied — <file touched>" or "N: skipped — <one-clause reason>" — followed by the single word "done".
```

### V2 — numbered two-phase procedure (read-all, then edit)
Rationale: plan-then-act scaffold — reading the whole list and mapping items to files BEFORE editing prevents overlapping edits from later items clobbering earlier ones.
Prediction: boost regressions (items undone by later items) → 0; edit turn count down.

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. Follow this procedure exactly:

STEP 1 — Copy, in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null

STEP 2 — Read the FULL change-list below and the files it touches under ${outDir}. Map every item to its target file(s) before making any edit; where two items touch the same file, plan both edits together so neither undoes the other.

STEP 3 — Apply EXACTLY the change-list — nothing more: no redesign, no new features, no reformatting beyond the listed items.

${list}

STEP 4 — Confirm every file NOT named by the list is untouched (byte-identical to the copy). Then reply "done".
```

### V3 — negative-example inoculation (format drift)
Rationale: the classic silent failure is an editor "helpfully" reformatting or renaming while applying items; name the three drift shapes.
Prediction: diff-noise (changed lines not attributable to an item) → ~0; ratchet keeps more boosts (gated versions pass more often).

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list:

${list}

Three edit behaviours RUIN this step — a blind judge re-reads the result and any unexplained drift reads as a new defect:
- REFORMATTING DRIFT: re-indenting, re-wrapping, or "tidying" lines the list never mentioned.
- RENAME DRIFT: renaming files, functions, or variables to taste while you are in there.
- COMPLETIONIST DRIFT: fixing an unrelated bug you noticed. Not yours to fix — the list is the whole mandate.
Apply the listed items and NOTHING else; keep every file not named by the list byte-identical. When done, reply "done".
```

### V4 — minimal-diff quota
Rationale: an explicit ceiling ("touch only files an item names; smallest edit per item") turns the implicit minimality norm into a checkable budget.
Prediction: boost diff size down; post-boost simplicity-lens cons down; some hard items may under-apply (watch applied-rate).

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items):

${list}

DIFF BUDGET (hard): touch ONLY files an item plainly requires; per item, make the smallest edit that satisfies its `change` sentence — if a 2-line edit and a 20-line edit both satisfy it, the 2-line edit is correct. Keep every file not named by the list byte-identical, and within a touched file keep every line the item does not require byte-identical. When done, reply "done".
```

### V5 — checklist before "done"
Rationale: terminal binary audit (the cheapest compliance lever) applied to the boost step.
Prediction: unapplied-item rate down; stray-file edits → 0; negligible cost.

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items):

${list}

Keep every file not named by the list byte-identical.

Before replying, verify — fixing at most once:
[ ] every numbered item above is reflected in the files (re-read the exact lines you edited)
[ ] no file outside the items' targets differs from the copy
[ ] no edit went beyond its item (no bonus refactors, renames, or reformatting)
Then reply "done".
```

### V6 — role reframing (surgical patch applier)
Rationale: persona shift from "improvement pass" (invites creativity) to "surgeon executing a signed consent form" (constrains it).
Prediction: scope drift down on creative-leaning models; applied fidelity unchanged.

```text
This is an approved internal step of the joust-engine tournament. You are a SURGEON, and the change-list below is the signed consent form: it authorises exactly these procedures on this artifact and nothing else. Operating beyond consent — improving, redesigning, tidying, fixing unlisted defects — is the failure mode this step exists to prevent, however good your intentions.

First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to perform EXACTLY these procedures:

${list}

Every file not named by the list stays byte-identical; every line not required by an item stays byte-identical. Close cleanly: when done, reply "done".
```

### V7 — addresses-as-acceptance
Rationale: make the `(addresses: ...)` line the acceptance test per item — the edit is complete only when the quoted con would now be FALSE if a judge re-checked it.
Prediction: post-boost re-judge finds the cited cons resolved at a higher rate; item under-application down.

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items):

${list}

ACCEPTANCE PER ITEM: each item's "(addresses: ...)" line quotes the reviewer con your edit must extinguish. After editing for an item, re-read your edit and ask: "if a blind judge re-checked exactly this complaint against the file now, would the complaint be false?" If not, the edit is incomplete — finish it within the item's scope (never beyond it). Keep every file not named by the list byte-identical. When done, reply "done".
```

### V8 — brevity-forced (compressed instruction)
Rationale: this helper prompt may work at half the tokens; test that the copy-first and nothing-more contracts survive compression on opus.
Prediction: no metric moves (fidelity, drift, applied rate) — if confirmed, keep the short form for token savings.

```text
Approved internal joust-engine tournament step. ONE Bash call first: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null. Then edit files under ${outDir} to apply EXACTLY this list — nothing more, nothing else changed, unlisted files byte-identical:

${list}

No redesign, no new features, no reformatting beyond the items. Reply "done".
```

### V9 — impossible-item escape hatch with hard stop
Rationale: when an item's premise is wrong (target text absent because verdicts drifted from the artifact), models improvise; give an explicit refuse-and-report rule bounded to the item level.
Prediction: improvised off-list edits → 0; skipped-item reports appear only where verdict/artifact drift is real (a drift telemetry signal).

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items):

${list}

IF AN ITEM'S PREMISE IS WRONG (the text or behaviour it targets does not exist in these files), do NOT improvise a different edit in its spirit — skip that ONE item entirely and continue with the rest. Improvised edits are worse than skipped items: the review that produced the list never approved them. Keep every file not named by the list byte-identical. When done, reply "done", plus one line per skipped item: "skipped N: <what was missing>".
```

### V10 — artifact-type awareness (brief vs code)
Rationale: at plan-phase shootouts the artifact is a design brief — edits must preserve its bullet structure and altitude (no code added while "fixing"); pairs with steelman V10.
Prediction: altitude violations introduced by boosts → 0; boosted-brief gate pass rate up at plan final ranks.

```text
This is an approved internal step of the joust-engine tournament: apply a review-driven improvement pass to a candidate artifact. First run in ONE Bash call: mkdir -p ${q(outDir)} && cp -R ${q(origDir)}/. ${q(outDir)}/ 2>/dev/null; then EDIT the files under ${outDir} to apply EXACTLY this change-list — nothing more (no redesign, no new features, no reformatting beyond the listed items):

${list}

MATCH THE ARTIFACT'S NATURE: if the files are a DESIGN BRIEF (decision-level bullets — approach, surfaces, risks, acceptance criteria), your edits stay at that altitude: sharpen or correct bullets, never add code blocks, diffs, line numbers, or function bodies (reviewers judge those DOWN as altitude violations — such an edit would sabotage the artifact). Respect any stated bullet budget. If the files are CODE, edit at code level exactly as the items say. Keep every file not named by the list byte-identical. When done, reply "done".
```

## How to test

Swap ONE variant into the `agent(...)` template inside `boostCandidate()` (keep the `${q(outDir)}`/`${q(origDir)}` copy command shape and `${list}`). Run the standard calibration task n>=5 per arm with judging-v3 final ranks. Compare via the shootout artifacts under `review-final/`: `diff -r` the pre-boost staged dir vs the boost dir (drift lines not attributable to items), post-boost gate pass rate, re-judge con resolution rate, and `steelman.rounds`/`decided_by` in council metadata; roll up with `node bin/je-ledger.mjs report`. Pair boost variants with the SAME steelman prompt across arms (one variable).
