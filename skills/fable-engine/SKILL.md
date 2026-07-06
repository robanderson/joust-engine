---
name: fable-engine
description: Fable Engine (@@FE[:N]) — the fast composer variant of the Joust Engine tournament. One WIDE parallel round of N draft plans (mixed providers, blind-staged by the engine's composeOnly mode), then the ORCHESTRATING model itself reviews every draft at once, composes the best composite plan (crediting what it took from each candidate, discarding the rest, adding its own ideas), implements it with unit tests, and reports. No judging councils, no second round, no steelman loop — a ~30-minute turnaround instead of hours. Designed for a frontier-class orchestrator (Fable/Opus tier); it trades the blind council's independent ranking and second security gate for speed, so keep @@JE runs as the periodic calibration baseline. Trigger on the sigil @@FE[:N] (e.g. @@FE, @@FE:8), case-insensitive, optional marker-adjacent task-size word (short/medium/long).
---

# Fable Engine (@@FE)

The composer variant of the tournament: exploration stays wide and parallel, but review,
synthesis, and implementation collapse into the orchestrating model. Use it when turnaround
matters more than adversarial independence; use `@@JE` when you want the blind council,
the dual security gates, and the steelman shootout.

**Honest trade (state it in the report):** @@FE has no independent blind ranking and no
independent security veto — the composer both judges and writes. Mitigations: the pool is
still staged BLIND (compose from `_pool.md`, unblind only when reporting), contributions
are credited per candidate, the implementation must pass the full test gate, and periodic
`@@JE` runs on comparable tasks calibrate whether the composite really matches
council-picked quality (compare in the run ledger).

## Phase 0: Parse

`@@FE[:N]` — N = draft attempts (default **10**, min 2). A marker-adjacent
`short`/`medium`/`long` sets the size profile (same D-0006 adjacency discipline as @@JE:
only next to the marker, stripped from the task). A prose model spec (`2 opus, 3 codex
xhigh, ...`, same grammar as @@JE) overrides the default pool; its sum overrides N.
Task = the message with marker/spec stripped.

Default pool (N=10): `2 opus, 2 sonnet, 2 glm-5.2, 2 codex-high, 2 minimax-m3` — codex at
HIGH (not xhigh: near-equal draft quality, materially faster), glm-5.2 viable here because
a compose round has no council to gridlock (give it the long-profile wall-clock if the task
is heavy). Most seats bill non-Anthropic providers, so a wide round is cheap on the
Anthropic budget while the orchestrator's spend goes where it is unique: the composite and
the implementation.

## Phase 1: Confirm (one gate, then go)

Show: the task verbatim, N + pool, the size profile (override vs estimate), and the cost
note (N parallel drafts + your own compose/implement work; no council spend). Proceed on
confirmation. In a session where the user has already granted batch/overnight autonomy,
that standing authorization satisfies this gate — say so in the report.

## Phase 2: Wide round 1 (the engine does this)

Invoke the bundled `Workflow` script `workflows/tournament.mjs` exactly as the joust-engine
skill's Phase 2 describes (same `attempts` shape, Pool A diversity nudges drawn without
replacement, same runner paths, same size-profile args from `bin/je-parse.mjs --size`,
`issueRunner` for auto-filed engine faults) **plus `composeOnly: true`**. The engine runs
the N isolated attempts, validates provenance fail-closed, stages the survivors blind, and
returns `{ poolPath, round1.mapping, candidates[], rc_summary }` — no councils.

Wide rounds SHOULD use **Pool A2 angle briefs** (one orthogonal one-paragraph angle per draft, riding `r1nudge` verbatim) instead of one-line nudges — see "Pool A2" in `skills/joust-engine/references/diversity-injection.md`.

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

## Phase 4: Implement (you)

Implement the composite plan directly (respecting any session branch/worktree rules):
smallest coherent change set, unit tests REQUIRED (extend the suites the plan names —
new behaviour needs a failing-then-passing test), then the full gate: `npm run check`,
the full test suite, and the rebrand self-verify when engine/runner files changed.
Commit only when green. Never push or open PRs beyond what the user has authorized.

## Investigate mode (`investigate: true`)

For a VAGUE goal ("the system is too slow") or a CONCRETE ISSUE ("fix #454") the expensive
part is finding WHAT is true, not choosing between designs for a guess — and FINDINGS
COMPOSE (the union of verified diagnoses beats the best single one), so no winner is picked.
Use @@FE with `investigate: true` added to the Phase 2 workflow args. The engine then:
Round 1 attempts produce **FINDINGS.md** artifacts (diagnosis + VERIFIABLE evidence
citations — file:line / artifact paths / log excerpts — + a candidate improvement sketch;
altitude-guarded: findings only, never fixes), an evidence-verification pass stamps each
pooled candidate with `EVIDENCE: n cited, m verified` (fail-safe: unverifiable is stamped,
never invalidated), and the run returns composeOnly-style — `{ poolPath, round1.mapping
(rows carry evidence counts), candidates[], investigate: true, rc_summary }`. The ORIGINAL
request is the constitution for the whole run: it appears verbatim in every later artifact
and nothing downstream may redefine it.

- **Issue intake** (`@@FE fix #NNN` / "fix issue NNN"): fetch the issue FIRST — `gh issue
  view NNN` — and install its title+body verbatim as the task text (it joins the original
  request as constitution); add the files the issue names to `contextFiles` so seats can
  actually read the substrate (a run without substrate must say so rather than speculate).
- **Compose (Phase 3, investigate variant):** UNION the VERIFIED findings into the
  composite — additive, never a winner-pick; two seats finding the same fault is
  confirmation, not redundancy. The composite must carry: the **diagnosis union**
  (priority-ordered by measured impact; a finding whose citation failed verification —
  low/zero `verified` on its stamp, or a citation you cannot reproduce — is demoted to a
  hypothesis or dropped, VISIBLY, never silently adopted), the **chosen approach** + why
  and rejected alternatives, **approach-neutral acceptance criteria** (binding on the
  implementation, mechanically checkable where possible), and the **credit table** (per
  seat: adopted/rejected and why, each adopted finding traced to its seat + verified
  citation). ALTITUDE-GUARDED like a design brief: no code blocks, no diffs, no function
  bodies — evidence file:line citations are citing, not editing.
- **Implement (Phase 4) and report (Phase 5) as usual.** v1: the acceptance criteria land
  verbatim in the report/PR body and as judge evidence requests — no mechanical
  criteria-extraction into the verify set yet.

## Phase 5: Report

1. Unblind: the mapping (candidate → model) and the credit table merged, so the user sees
   which model contributed what.
2. `rc_summary.non00` — every non-00 seat, as in @@JE Phase 6.
3. Run `node bin/je-timeline.mjs <transcriptDir> <runDir>` and cite the phase walls from
   `TIMELINE.md` (turnaround is this skill's promise — measure it every run).
4. Test evidence: the actual gate output, not an assertion.
5. The honest-trade note (no independent council/veto this run) + when the last @@JE
   calibration ran.
