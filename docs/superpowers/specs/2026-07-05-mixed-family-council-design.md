# Mixed-family judging council + snapshot pinning

Approved design, 2026-07-05. Motivated by the judge-model comparison experiment (4 On2it
final reviews replayed per-lens on codex vs a reference anchor): codex (gpt-5.5) reached
parity-or-better on the completeness-class and simplicity-class lenses, and — being a
different model family from the Anthropic models that author most plans/implementations —
it resists assumptions natural to Anthropic models. The same experiment surfaced a
wrong-tree judging failure (a verifying judge checked the LIVE repo checkout instead of
the tournament snapshot and penalized the true winner), which this spec also fixes.

## 1. Codex-xhigh judge seats

**Seat assignment (both councils):**

| Council | Codex-xhigh seats | Stay Opus |
|---|---|---|
| Plan council | **completeness**, **simplicity** | feasibility, risk, security(-by-design) |
| Code council | **spec** (the completeness-class seat), **craft** (the simplicity-class seat) | correctness, security, robustness |

The security veto NEVER moves off Anthropic. The verification-heavy lenses
(correctness/feasibility/security/risk/robustness) stay Opus — the experiment showed the
codex gap concentrates exactly there.

**Mechanism.** Each LENS entry gains a `judge` field: `{ kind: 'anthropic', model: 'opus' }`
(default) or `{ kind: 'codex', displayModel: 'codex-xhigh' }`. `askLens()` routes on it:
- anthropic → today's native structured-output path, byte-identical.
- codex → dispatch via the codex runner (brief file written to a per-seat scratch dir,
  `model_reasoning_effort=xhigh`, generous wall-clock ~1500s): the brief is the SAME lens
  prompt plus "write your verdict as VALID JSON to VERDICT.json (keys: lens, candidates,
  ranking, vote, reasoning, checks_run[, safety])". The engine then reads + JSON-parses
  VERDICT.json, shape-validates it in code (same required keys as the native schema), and
  passes it through the existing `reconcileLens` + verdict-integrity guard. Parse/shape/
  integrity failure counts as a failed attempt.
- **Fallback, fail-safe:** retry once (same as native); if the codex seat still fails, the
  seat FALLS BACK to a native Opus judge for that round (logged loudly; council metadata
  records the ACTUAL model per seat per round). The council must never lose a seat to
  provider flakiness when Opus can fill it.
- Deliberation rounds include codex seats identically (peer verdicts embedded in the
  brief; revised VERDICT.json each round).
- `judges: 1` legacy path unaffected. New arg `judgeMix: 'anthropic'` forces all-Opus
  councils (offline / no-OpenAI runs); default is the mixed assignment above.
- Blindness: unchanged — judges never learn candidate models; reporting the JUDGES' own
  models in council metadata is not blind-sensitive.

## 2. Snapshot pinning (wrong-tree fix — applies to EVERY judge, both families)

- Every lens brief gains a **pinned evaluation scope**: the staged pool file, the staged
  per-candidate dirs (self-contained mode) or the candidate worktrees at their gated
  commits (repoMode), and — when repoMode provides it — the base SHA, stated explicitly.
- The brief FORBIDS consulting any path outside that scope; in particular the live repo
  checkout, whose state may have moved past the tournament snapshot. Verification
  commands must run against the staged/worktree trees only.
- `checks_run` discipline: each entry must cite a path under the allowed roots. The
  verdict-integrity guard adds a WARNING (logged, non-fatal in v1) when a `checks_run`
  entry cites a path outside the allowed roots — telemetry to decide whether to make it
  fatal later.

## 3. Files touched

`workflows/tournament.mjs` (LENS tables + askLens routing + codex verdict
parse/validate/fallback + council metadata + brief scope block), `bin/codex-run.sh` only
if a flag is missing (prefer none), `references/review-rubric.md` + `orchestration.md`
(seat table, judgeMix, snapshot-pinning contract), SKILL.md cost/notes, CHANGELOG, tests
(parse/shape-validation of a canned VERDICT.json; fallback path; allowed-roots warning).

## Acceptance

- `npm run check && npm test` green; rebrand self-verify passes.
- `judgeMix:'anthropic'` produces byte-identical behaviour to today.
- A malformed/missing VERDICT.json never kills a council: seat retries then falls back to
  Opus, and the run completes with per-seat model provenance in council metadata.
- No LLM aggregates votes (unchanged invariant).
