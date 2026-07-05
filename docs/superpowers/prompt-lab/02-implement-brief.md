# Prompt Lab 02 — Implement brief (`brief()`, `kind === 'implement'`)

**Anchor:** `workflows/tournament.mjs` → `brief()` line ~112; `seedBlock` ~line 150; repoMode branch ~line 154; non-repoMode branch (run-G DELIVERABLE CONTRACT) ~line 177. As of commit `b360a37`.

**Family unit for A/B:** the **non-repoMode** brief — that is where all observed valid-rate failures concentrate (je-evolve S1: glm-5.2 "no deliverable saved" n=2/2; S21: RC 05 seat). The repoMode brief and `seedBlock` are quoted for reference; the same axes apply to them but test the non-repoMode arm first. Variants below replace the non-repoMode template body only; `${seedBlock}` stays a slot.

**Interpolation slots every variant MUST keep:** `${task}`, `${g}${ctxLine}${seedBlock}`, `${nudge}`, `${ws}`.

**Engine-contract invariants kept in EVERY variant:** single-pass hard stop (no iterate-to-green; sole allowed check = the bounded `git apply --check` self-verify); save contract (files in `${ws}` are the only output; text reply discarded); no clarifying questions; the DELIVERABLE CONTRACT layout literals (`patches/`, `APPLY.md`, `VERIFY.md`, `files/`) untouched — a deterministic engine gate greps them; no model identities.

## Current production prompts (verbatim)

`seedBlock` (prepended when a winning design brief seeds the attempt):

```text
An APPROVED DESIGN BRIEF for this task has already been chosen by a review council. It is your specification — read it in full at the start:
${seedPlanPath}
Follow its APPROACH and satisfy its ACCEPTANCE CRITERIA. The implementation details are yours: make the smallest coherent implementation consistent with the brief. Where the brief is explicit, honour it; where it is silent, choose well. Do NOT re-plan or second-guess the overall approach.
```

repoMode branch:

```text
You are working INSIDE an existing git repository checked out at: ${ws}
This is your own isolated branch off a pinned base commit. Apply your change DIRECTLY to the real files (edit/create/delete as needed) to accomplish the task. Do NOT write a "proposal" or a description of a change — make the change itself.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

Rules:
- This task is fully specified. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Single pass: make your change once, then STOP. Do NOT run the test suite, do NOT iterate to green.
  (A separate automated step tests every candidate after you finish — testing yourself only wastes your turn budget. Weak/local models that loop on "run tests, fix, repeat" time out; do not.)
- Do NOT run any git command. Do NOT commit, branch, stage, push, or touch .git. Just edit files.
  The harness snapshots your working tree into a commit for you after you stop.
- Do NOT write a proposal or patch plan. Apply the requested change directly to files in this checkout.
- Leave a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations, in JE-ATTEMPT-NOTES.md at the repo root.
- Work only in this checkout: ${ws}
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
```

non-repoMode branch (the A/B unit):

```text
You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

DELIVERABLE CONTRACT (mandatory layout — a deterministic engine gate checks it before judging):
- PRIMARY (preferred): a \`patches/\` directory holding one or more ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\` (the exact, ORDERED shell commands to apply every patch, e.g. \`git apply patches/0001-<name>.patch\`), PLUS \`VERIFY.md\` (the exact commands to verify the change and the expected result).
- SELF-VERIFY before you stop: you have no repository checkout here, so prove your diffs are well-formed — \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This one bounded check is REQUIRED and explicitly allowed — it is NOT the forbidden run-the-tests-and-iterate loop. If you cannot reach exit 0, switch to the FALLBACK below instead of shipping a corrupt patch.
- FALLBACK (only if you cannot produce a clean patch): a \`files/\` directory mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root. A conforming layout lets reviewers judge your CODE instead of your packaging (a non-conforming layout is stamped but still judged in this version).

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution file ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite, re-align, "improve", or polish it (sole exception: the \`git apply --check\` self-verify the DELIVERABLE CONTRACT requires). Your first version is final — even if it is imperfect or not to your taste. Perfecting it is explicitly NOT wanted here and only wastes effort.
- Your text reply is discarded; ONLY the file(s) you save are kept. You MUST save your solution to a file (an empty workspace is a total failure) — but it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}
- Work only in that directory. Create it if needed.
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations (an honest note about what is rough or unfinished is useful, not a mark against you).
```

## Variants (non-repoMode brief)

### V1 — save-contract-first
Rationale: je-evolve S1/S21 direct delta — move the save/layout contract to the TOP and repeat it as the final line (weak runners lose late instructions).
Prediction: valid-rate up on glm-5.2/minimax; RC 05 down; contract-conformance stamp rate up.

```text
FIRST, before reading the task: everything you produce lives in ${ws} (create it now with \`mkdir -p\`). Your text reply is discarded; ONLY saved files are kept, and an empty workspace is a total failure. The mandatory layout (a deterministic engine gate checks it before judging):
- PRIMARY (preferred): \`patches/\` holding ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\` (the exact, ORDERED shell commands to apply every patch, e.g. \`git apply patches/0001-<name>.patch\`), PLUS \`VERIFY.md\` (the exact commands to verify the change and the expected result).
- FALLBACK (only if you cannot produce a clean patch): \`files/\` mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root.

You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

SELF-VERIFY before you stop: you have no repository checkout here, so prove your diffs are well-formed — \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This one bounded check is REQUIRED and explicitly allowed — it is NOT the forbidden run-the-tests-and-iterate loop. If you cannot reach exit 0, ship the FALLBACK layout instead of a corrupt patch.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite or polish it (sole exception: the \`git apply --check\` self-verify above). Your first version is final.
- Work only in ${ws}. To save a file, just write it; if a file-edit tool refuses because the file "must be read first", do NOT spend turns retrying — overwrite it directly with the shell, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations (an honest note about what is rough is useful, not a mark against you).

FINAL REMINDER: when you stop, ${ws} must contain a conforming \`patches/\` (or \`files/\`) layout plus \`APPLY.md\`. Save them NOW if you have not already — nothing else you say survives.
```

### V2 — output-schema-first (literal tree)
Rationale: a literal target tree diagram is unambiguous where prose enumeration is parseable-but-skimmable; schema-first output framing measurably improves format conformance on mid-tier models.
Prediction: contract-conformance stamp rate up; bare-patch-in-root violations down; valid-rate unchanged on frontier seats.

```text
You are solving a self-contained task. Produce ONE complete solution in a single focused pass. Your deliverable is EXACTLY this workspace tree (a deterministic engine gate checks it before judging):

${ws}/
├── patches/
│   ├── 0001-<name>.patch        (unified diff; applied in filename order)
│   └── 0002-<name>.patch        (only if needed)
├── APPLY.md                     (the exact, ORDERED shell commands, e.g. git apply patches/0001-<name>.patch)
└── VERIFY.md                    (the exact commands to verify the change and the expected result)

FALLBACK tree (only if you cannot produce a clean patch): replace patches/ with files/<full-repo-relative-path> mirrors of each changed file, and make APPLY.md the exact ordered copy commands (and any deletions). Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

SELF-VERIFY before you stop: you have no repository checkout here, so prove your diffs are well-formed — \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This one bounded check is REQUIRED and explicitly allowed — it is NOT the forbidden run-the-tests-and-iterate loop. If you cannot reach exit 0, ship the FALLBACK tree instead of a corrupt patch.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite, re-align, "improve", or polish it (sole exception: the \`git apply --check\` self-verify). Your first version is final — even if imperfect.
- Your text reply is discarded; ONLY the file(s) you save are kept. You MUST save your solution (an empty workspace is a total failure) — but it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}. Work only in that directory; create it if needed.
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations (an honest note about what is rough or unfinished is useful, not a mark against you).
```

### V3 — worked micro-example (APPLY.md / VERIFY.md contents)
Rationale: the contract names the files but not their internal shape; a 4-line example of each removes the last ambiguity for runner models.
Prediction: APPLY.md/VERIFY.md usable-as-written rate up (measure: reviewers' packaging cons down); token cost small.

```text
You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

DELIVERABLE CONTRACT (mandatory layout — a deterministic engine gate checks it before judging):
- PRIMARY (preferred): a \`patches/\` directory holding one or more ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\`, PLUS \`VERIFY.md\`.
- APPLY.md is literally the ordered commands and nothing else, e.g.:
    git apply patches/0001-add-retry-helper.patch
    git apply patches/0002-wire-retry-into-runner.patch
- VERIFY.md is commands plus the expected observation, e.g.:
    npm test -- --filter retry   # expect: 3 passing, 0 failing
    grep -n "maxRetries" src/runner.js   # expect: one hit in the new helper call
- SELF-VERIFY before you stop: you have no repository checkout here, so prove your diffs are well-formed — \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This one bounded check is REQUIRED and explicitly allowed — it is NOT the forbidden run-the-tests-and-iterate loop. If you cannot reach exit 0, switch to the FALLBACK below instead of shipping a corrupt patch.
- FALLBACK (only if you cannot produce a clean patch): a \`files/\` directory mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite or polish it (sole exception: the \`git apply --check\` self-verify). Your first version is final.
- Your text reply is discarded; ONLY the file(s) you save are kept. You MUST save your solution to a file (an empty workspace is a total failure) — but it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}. Work only in that directory; create it if needed.
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations (an honest note about what is rough or unfinished is useful, not a mark against you).
```

### V4 — negative-example inoculation (observed loss modes)
Rationale: name the three OBSERVED loss modes (issue #34 MiniMax exit=0/zero files; GLM max-turns burn fighting write denials; iterate-to-green timeouts) as concrete anti-patterns.
Prediction: RC 03 (max-turns) and RC 05 rates down on runner seats; no effect on native seats.

```text
You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Three failure shapes have LOST this tournament for real attempts — do not reproduce them:
1. FINISHED BUT SAVED NOTHING: an attempt ran to a clean exit having written zero files. Everything you produce must be saved into ${ws}; your text reply is discarded.
2. BURNED ALL TURNS FIGHTING A FILE TOOL: an attempt spent its whole budget on "must be read first" retry loops. If a file-edit tool refuses, overwrite directly with the shell (\`cat > FILE <<'EOF' ... EOF\`) and move on — first refusal, not the fifth.
3. ITERATED TO GREEN UNTIL TIMEOUT: an attempt looped run-tests/fix/repeat and timed out with nothing staged. A separate automated step tests every candidate after you finish; your only allowed check is the bounded \`git apply --check\` below.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

DELIVERABLE CONTRACT (mandatory layout — a deterministic engine gate checks it before judging):
- PRIMARY (preferred): a \`patches/\` directory holding one or more ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\` (the exact, ORDERED shell commands to apply every patch, e.g. \`git apply patches/0001-<name>.patch\`), PLUS \`VERIFY.md\` (the exact commands to verify the change and the expected result).
- SELF-VERIFY before you stop: \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This one bounded check is REQUIRED and explicitly allowed. If you cannot reach exit 0, switch to the FALLBACK below instead of shipping a corrupt patch.
- FALLBACK (only if you cannot produce a clean patch): a \`files/\` directory mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite or polish it (sole exception: the self-verify above). Your first version is final — even if imperfect; it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}. Work only in that directory; create it if needed.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations (an honest note about what is rough or unfinished is useful, not a mark against you).
```

### V5 — checklist-of-checks (pre-stop audit)
Rationale: terminal binary audit right before STOP; cheapest compliance lever for long agentic generations.
Prediction: RC 05 down; conforming-layout rate up; negligible token cost.

```text
You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

DELIVERABLE CONTRACT (mandatory layout — a deterministic engine gate checks it before judging):
- PRIMARY (preferred): a \`patches/\` directory holding one or more ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\` (the exact, ORDERED shell commands to apply every patch, e.g. \`git apply patches/0001-<name>.patch\`), PLUS \`VERIFY.md\` (the exact commands to verify the change and the expected result).
- SELF-VERIFY before you stop: you have no repository checkout here, so prove your diffs are well-formed — \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This one bounded check is REQUIRED and explicitly allowed — it is NOT the forbidden run-the-tests-and-iterate loop. If you cannot reach exit 0, switch to the FALLBACK below instead of shipping a corrupt patch.
- FALLBACK (only if you cannot produce a clean patch): a \`files/\` directory mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite or polish it (sole exception: the \`git apply --check\` self-verify). Your first version is final — even if imperfect.
- Your text reply is discarded; ONLY the file(s) you save are kept. You MUST save your solution to a file (an empty workspace is a total failure) — but it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}. Work only in that directory; create it if needed.
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations.

IMMEDIATELY before you stop, verify in ONE shell command (\`ls -R ${ws}\`) and fix at most once:
[ ] patches/ (or files/) exists and is non-empty
[ ] APPLY.md exists and its commands name every patch/file you shipped
[ ] VERIFY.md exists (PRIMARY layout)
[ ] nothing sits loose in the workspace root except APPLY.md, VERIFY.md, and your note
Then STOP.
```

### V6 — brevity-forced (compressed contract)
Rationale: the production brief is long; rule bloat may itself cause weak-model drift (lost-in-the-middle). Halve the token count while keeping every load-bearing literal.
Prediction: valid-rate on glm/minimax unchanged or UP with fewer tokens; if conformance drops, rule bloat is not the problem — retire.

```text
You are solving a self-contained task in ONE pass. Only files saved into ${ws} survive; your text reply is discarded. An empty workspace is a total failure.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

DELIVERABLE (exact names; an engine gate checks them):
- \`patches/0001-<name>.patch\` (ordered unified diffs) + \`APPLY.md\` (exact ordered \`git apply\` commands) + \`VERIFY.md\` (verify commands + expected result).
- Self-verify (REQUIRED, and your ONLY allowed check): \`git init -q\` a scratch dir, reconstruct the touched files from the shared context, \`git apply --check\` (add \`--recount\` if needed) each patch until exit 0. Cannot reach 0? Ship the fallback instead: \`files/<repo-relative-path>\` mirrors + \`APPLY.md\` copy commands.
- No other layout; no bare patch in the workspace root.

Rules:
- Fully specified task: no clarifying questions, no options, no stopping for input.
- SINGLE pass, then STOP. No running your code, no testing, no polishing (sole exception: the self-verify above). Imperfect is acceptable; unsaved is not.
- File tool refuses ("must be read first")? Overwrite via shell at once: \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2-4 sentence note on approach, tradeoffs, and known limitations.
```

### V7 — role reframing (CI-gate submitter)
Rationale: frame the recipient as a MACHINE (an automated gate that reads only the workspace), removing any social incentive to explain instead of save.
Prediction: text-reply-only failures (RC 05) down on chat-tuned runners; note quality unchanged.

```text
You are a patch author submitting to an AUTOMATED CI gate. The gate is a program: it reads ONLY the files inside ${ws}, it never reads your explanation, and it rejects non-conforming layouts before any human sees your work. Write for the machine first, the human reviewer second.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

WHAT THE GATE ACCEPTS (exact names, checked deterministically):
- PRIMARY (preferred): \`patches/\` holding ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\` (the exact, ORDERED shell commands, e.g. \`git apply patches/0001-<name>.patch\`), PLUS \`VERIFY.md\` (the exact commands to verify the change and the expected result).
- FALLBACK (only if you cannot produce a clean patch): \`files/\` mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Anything else — another layout, a bare patch in the workspace root, an empty workspace — is a rejection.

SELF-VERIFY before you submit (REQUIRED, and your ONLY allowed check): you have no repository checkout here, so prove your diffs are well-formed — \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This is NOT the forbidden run-the-tests-and-iterate loop — a separate automated step tests every candidate after you finish. If you cannot reach exit 0, ship the FALLBACK instead of a corrupt patch.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and submit.
- Work in a SINGLE pass and then STOP: write your solution ONCE, then stop immediately. Do NOT run it, test it, or polish it (sole exception: the self-verify). Your first version is final; it does NOT need to be flawless or fully working — unsaved work is the only unrecoverable failure.
- Save all deliverable files to: ${ws}. Work only in that directory; create it if needed.
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations (an honest note about what is rough or unfinished is useful, not a mark against you).
```

### V8 — numbered-procedure scaffold
Rationale: convert prose rules into a 6-step numbered procedure — sequential scaffolds cut instruction dropout on mid-tier agentic models (plan-then-act ordering).
Prediction: contract conformance up on glm/grok/minimax; turn count per attempt down.

```text
You are solving a self-contained task. Follow this procedure EXACTLY, in order, one pass, then stop.

STEP 1 — Read the task and the shared context (once):
Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

STEP 2 — \`mkdir -p ${ws}/patches\` and decide your change set. Make reasonable default choices; do NOT ask clarifying questions or stop for input.

STEP 3 — Write the ordered unified diffs: \`${ws}/patches/0001-<name>.patch\` (then 0002-..., applied in filename order).

STEP 4 — SELF-VERIFY (REQUIRED, your ONLY allowed check): \`git init -q\` a throwaway scratch directory, seed it with your best reconstruction of the touched files from the shared context, run \`git apply --check\` (add \`--recount\` if needed) on each patch, FIX until exit 0. This is NOT the forbidden run-the-tests-and-iterate loop — a separate automated step tests every candidate after you finish. If you cannot reach exit 0, delete \`patches/\` and instead write \`${ws}/files/<full-repo-relative-path>\` mirrors of each changed file.

STEP 5 — Write \`${ws}/APPLY.md\` (the exact, ORDERED commands to apply every patch — e.g. \`git apply patches/0001-<name>.patch\` — or, for the files/ fallback, the exact ordered copy commands and any deletions) and \`${ws}/VERIFY.md\` (the exact commands to verify the change and the expected result).

STEP 6 — Append a 2 to 4 sentence note on your approach, tradeoffs, and known limitations. Then STOP. Do NOT run your code, do NOT test it, do NOT rewrite or polish anything. Your first version is final — imperfect is acceptable; unsaved is a total failure (your text reply is discarded; only files inside ${ws} are kept).

Notes: use these exact directory and file names — a deterministic engine gate checks them; no bare patch in the workspace root. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite directly with the shell, e.g. \`cat > FILE <<'EOF' ... EOF\`.
```

### V9 — bounded self-verify quota
Rationale: the open-ended "FIX the diff until it exits 0" is the one licensed loop; bounding it (<=3 fix cycles, then fallback) tests whether an explicit budget stops runaway polishing without hurting patch quality.
Prediction: RC 03 (max-turns) down on runner seats; fallback-layout usage up slightly; applies-clean rate unchanged.

```text
You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

DELIVERABLE CONTRACT (mandatory layout — a deterministic engine gate checks it before judging):
- PRIMARY (preferred): a \`patches/\` directory holding one or more ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\` (the exact, ORDERED shell commands to apply every patch, e.g. \`git apply patches/0001-<name>.patch\`), PLUS \`VERIFY.md\` (the exact commands to verify the change and the expected result).
- SELF-VERIFY, STRICTLY BOUNDED: \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context) and run \`git apply --check\` (add \`--recount\` if needed) on each patch. You get AT MOST 3 fix-and-recheck cycles TOTAL across all patches. Count them. If any patch still fails after the third cycle, STOP fixing and ship the FALLBACK below — a working fallback beats a fourth attempt at a patch. This bounded check is REQUIRED and is NOT the forbidden run-the-tests-and-iterate loop.
- FALLBACK (if the quota runs out or you cannot produce a clean patch): a \`files/\` directory mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite or polish it (sole exception: the bounded self-verify above). Your first version is final — even if imperfect.
- Your text reply is discarded; ONLY the file(s) you save are kept. You MUST save your solution to a file (an empty workspace is a total failure) — but it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}. Work only in that directory; create it if needed.
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations (an honest note about what is rough or unfinished is useful, not a mark against you).
```

### V10 — smallest-coherent-change constraint (scope inoculation)
Rationale: je-evolve S2/S6/S12/S14 — implement-phase scope creep (extra keys scrubbed, extra couplings, extra bookkeeping) is the dominant recurring con; state the proportionality constraint in the ATTEMPT brief, not just the design brief.
Prediction: simplicity/spec-lens cons down; diff size (lines) down; win-rate vs production up on refactor-ish tasks.

```text
You are solving a self-contained task. Produce ONE complete solution in a single focused pass.

SCOPE RULE (judged, not advisory): make the SMALLEST COHERENT CHANGE that fully solves the task. Reviewers reliably punish additions the task did not ask for — extra surfaces hardened, extra keys or files touched "while you were there", new couplings, new config knobs, defensive bookkeeping. If the task names ONE thing, change that one thing. When in doubt, leave it out and mention it in your closing note instead.

Task:
${task}
${g}${ctxLine}${seedBlock}
${nudge}

DELIVERABLE CONTRACT (mandatory layout — a deterministic engine gate checks it before judging):
- PRIMARY (preferred): a \`patches/\` directory holding one or more ordered unified-diff files (\`patches/0001-<name>.patch\` or \`.diff\`, applied in filename order), PLUS \`APPLY.md\` (the exact, ORDERED shell commands to apply every patch, e.g. \`git apply patches/0001-<name>.patch\`), PLUS \`VERIFY.md\` (the exact commands to verify the change and the expected result).
- SELF-VERIFY before you stop: you have no repository checkout here, so prove your diffs are well-formed — \`git init -q\` a throwaway scratch directory (seed it with your best reconstruction of the touched files from the shared context), run \`git apply --check\` (add \`--recount\` if needed) on each patch, and FIX the diff until it exits 0. This one bounded check is REQUIRED and explicitly allowed — it is NOT the forbidden run-the-tests-and-iterate loop. If you cannot reach exit 0, switch to the FALLBACK below instead of shipping a corrupt patch.
- FALLBACK (only if you cannot produce a clean patch): a \`files/\` directory mirroring each changed file at its full repo-relative path (e.g. \`files/src/foo.js\`), PLUS \`APPLY.md\` (the exact, ordered copy commands, and any deletions). \`VERIFY.md\` is encouraged here too.
- Use these exact directory and file names; do NOT invent another layout or leave a bare patch in the workspace root.

Rules:
- This task is fully specified and self-contained. Do NOT ask clarifying questions, present options, or stop for input — make reasonable default choices and just produce your solution.
- Work in a SINGLE pass and then STOP: write your solution ONCE, then stop immediately. Do NOT run it, do NOT test or inspect it, and do NOT rewrite or polish it (sole exception: the \`git apply --check\` self-verify). Your first version is final — even if imperfect.
- Your text reply is discarded; ONLY the file(s) you save are kept. You MUST save your solution to a file (an empty workspace is a total failure) — but it does NOT need to be flawless or fully working.
- Save all deliverable files to: ${ws}. Work only in that directory; create it if needed.
- To save a file, just write it. If a file-edit tool refuses because the file "must be read first" (a stale copy exists), do NOT spend turns reading/retrying — overwrite it directly with the shell instead, e.g. \`cat > FILE <<'EOF' ... EOF\`.
- End with a 2 to 4 sentence note on your approach, plus any tradeoffs or known limitations — including anything you deliberately did NOT touch under the scope rule.
```

## How to test

Swap ONE variant into the non-repoMode branch of `brief()` (keep `${...}` slots, escaped backticks, and the contract literals `patches/`, `APPLY.md`, `VERIFY.md`, `files/` byte-identical — the mechanical gate greps them). Lint with `node bin/je-brief-test.mjs -`. Run the standard calibration task with a runner-heavy pool (glm-5.2 + minimax seats included — they are the failing population) n>=5 per arm. Compare via `node bin/je-evolve.mjs` (Signal A per-model valid-rate, Signal D RC 05/03), `node bin/je-ledger.mjs report` (win-rate), and the mechanical-gate CONTRACT stamp rate in mapping.json.
