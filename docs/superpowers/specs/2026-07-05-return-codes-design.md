# Official per-seat Return Codes + orchestrator reporting + privacy-filtered auto-issues

Approved design, 2026-07-05. Every workflow sub-agent seat (attempt, implementer, judge,
helper) ends with an OFFICIAL return code; non-00 codes surface to the orchestrator, and
engine-fault classes are auto-filed to the engine's GitHub issues through a fail-closed
privacy filter.

## 1. Return-code taxonomy (JE-RC)

| RC | Meaning | Today's signal it standardizes |
|----|---------|-------------------------------|
| 00 | expected result (deliverable saved / verdict valid) | valid=true |
| 01 | model timeout (wall-clock) | `*-TIMEOUT secs=`, exit 124 |
| 02 | model unavailable / throttled | 529s, rate-limit, `RETRIES-EXHAUSTED`, auth-endpoint down |
| 03 | turn-cap exhausted | `Reached max turns` |
| 04 | invalid output | schema/parse fail, verdict-integrity reject (after retry) |
| 05 | no deliverable saved | ran fine, wrote nothing (stdout-only, empty ws) |
| 06 | provenance failure | missing/mismatched `JOUST-*-PROVENANCE` |
| 07 | environment/permission failure | sensitive-path write block, missing runner/key |
| 08 | aborted / killed | STOP file, SIGINT, harness kill |
| 09 | unknown / other error | anything unclassified |

- **Runner seats:** every runner script's every exit path appends a final
  `JOUST-RC <code> <short-reason>` line to its `_*_run.log` (complements, never replaces,
  the existing DONE/TIMEOUT markers). The engine parses it; absence of the line = RC 09
  (and is itself a bug to fix — guaranteed-terminal-marker discipline).
- **Native/engine-side seats** (anthropic attempts, judges, helpers): the engine derives
  the RC in code from what it already observes (agent null/throw + message classing,
  schema/integrity failures, staging results) — no prompt changes; a model is never asked
  to self-report its RC.
- Per-seat RCs recorded in `mapping.json` (per candidate), council metadata (per judge
  seat per round), and the workflow return value.

## 2. Orchestrator reporting (non-00)

- The workflow return gains `rc_summary`: `{ seats: N, by_code: {"01": 2, ...}, non00:
  [{seat, phase, rc, reason}] }` — and SUMMARY.md renders it as a table. The SKILL Phase 6
  report must surface every non-00 seat with its class (no more silent seat loss).
- Fail-safety semantics unchanged: RCs are OBSERVABILITY, not new control flow, except
  where existing behaviour already branches (retries, fallbacks).

## 3. Auto-filed engine issues (privacy-filtered, fail-closed)

- At run end, for each non-00 CLASS that indicates an ENGINE fault (01/02 after retries,
  04-09 — not honest model losses like a rough deliverable), the engine/SKILL files ONE
  deduplicated issue per class per run to the ENGINE repo (robanderson/joust-engine) via
  `bin/je-issue.sh` (label `dogfood`, sev by class), evidence = the RC lines + marker
  excerpts ONLY.
- **Privacy contract (extends je-issue.sh check-evidence, all fail-closed):** existing
  guards (secrets exit 5, unblinding exit 4, placeholder exit 3) PLUS new scrubbing pass
  applied BEFORE the guards: redact `$HOME`/usernames in paths, env-var values, private
  IPs (10/172.16-31/192.168), `.local`/`.lan`/LAN hostnames, email addresses, and any
  `*_KEY`/`*_TOKEN`-shaped assignments. The contract is documented in
  `references/dogfood.md` ("what may never appear in a public issue").
- Refusal path: if the filter still refuses after scrubbing, degrade to the existing
  committed-inbox draft (scrubbed) or a loud log — NEVER post unscrubbed, NEVER silently
  drop the failure from the orchestrator report.
- Auto-filing is default-ON for engine-fault classes but respects a `noAutoIssue: true`
  arg and the offline/no-gh degradation that je-issue.sh already implements.

## 4. Files touched

All `bin/*-run.sh` runners (+ their test files: assert `JOUST-RC` on every exit path),
`workflows/tournament.mjs` (RC derivation, rc_summary, mapping/council/SUMMARY plumbing,
auto-issue hook), `bin/je-issue.sh` (+ tests: scrubbing pass + contract), `references/
dogfood.md` (privacy contract), orchestration.md/SKILL.md (rc_summary + noAutoIssue),
CHANGELOG.

## Acceptance

- `npm run check && npm test` green; rebrand self-verify passes.
- Every runner exit path emits exactly one `JOUST-RC` line (unit-tested per runner).
- A run with zero failures produces rc_summary all-00 and files no issues.
- Scrubber unit tests: private IP / LAN hostname / $HOME path / env value / email each
  redacted; a clean excerpt passes unmodified; the existing exit-3/4/5 guards still fire.
- The engine never blocks or crashes a paid run on an issue-filing failure (log + continue).
