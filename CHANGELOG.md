# Changelog

All notable changes to the **joust-engine** plugin are documented here.

## Unreleased

### Added

- **Runner watchdogs, guaranteed terminal markers, retryable hangs + N-1 quorum close (run E).**
  New shared `bin/_je-run-lib.sh` (sourced by all five runners): idempotent `finish()` writes
  exactly one terminal `JOUST-<PROV>-{DONE|TIMEOUT|KILLED|ERROR}` + one `JOUST-RC` line on EVERY
  exit path (TERM/INT→KILLED/08, uncaught EXIT→ERROR/09), and `run_watchdog_perl` adds a
  zero-output stall watchdog (kills the child's process GROUP; exit 125) alongside the existing
  wall clock (124). Wall-clock hangs and stalls are each retryable ONCE via a non-terminal
  `JOUST-<PROV>-RETRY` line (a successful retry never leaves a terminal failure word; the staging
  gate's reject set gains `KILLED`, stays mention-proof). Stall windows: `JE_STALL_SECS`
  (defaults: glm/minimax/grok 90s, local 60s, codex 120s). Engine: `parallelQuorum` lets a round
  close when all but one seat returned and the straggler exceeded 2x its wall clock + grace
  (`quorumGraceSecs`, default 90; `quorumClose:false` to disable) — NEVER over a security-gate
  seat, never over a native seat (no engine-known clock), capability-gated on the runtime having
  timers + a usable clock (this workflow sandbox does not; inert there with one log line).
  Fold-ins: codex judge VERDICT read-back failures reclassified RC 02→04 (structural
  dispatch/readback split in `askLensCodex`); runners `unset ANTHROPIC_API_KEY` so the Anthropic
  key never reaches a non-Anthropic child (each provider injects only its own credential). Tests:
  `bin/je-run-lib.test.sh` (13), `bin/runners-source-lib.test.sh`, KILLED/watchdog/retry/scrub
  cases in all five `bin/*-run.test.sh` suites, quorum + reclass cases in
  `workflows/tournament-return-codes.test.mjs`. Plan authored by the run E tournament (winner
  A/opus, steelman-boosted); implementation adapted from implementer draft impl-1/opus with one
  real bug found and fixed in review: a child that exited during a poll tick could be
  misclassified as stalled (kill-after-success race) — the watchdog now re-reaps after each sleep
  before any deadline judgment.

- **Fable Engine (`@@FE[:N]`)** — fast composer variant (new `fable-engine` skill + engine
  `composeOnly: true` flag). One WIDE blind round (default N=10: `2 opus, 2 sonnet,
  2 glm-5.2, 2 codex-high, 2 minimax-m3`), staged/validated exactly like @@JE but with NO
  councils; the orchestrating model (Fable/Opus tier) composes the best composite plan from
  the blind pool with a per-candidate credit table, implements it with unit tests, and
  reports with timeline telemetry. Trades the council's independent ranking + second
  security gate for ~30-minute turnarounds; @@JE remains the calibration baseline.
- **`bin/je-timeline.mjs`** — per-run agent timeline (`timeline.jsonl` + `TIMELINE.md` in
  the runDir) mined deterministically from workflow transcripts (the workflow sandbox
  cannot self-timestamp): ordered start/duration per agent, the gating predecessor, peak
  concurrency, and a deterministic Observations section (barrier seats vs group median,
  codex judge chain legs). Works mid-run on partial transcripts.

- **Judging-v3: councils never deliberate** (2026-07-05/06 designs; peer-deliberation rounds
  are retired after a live run burned hours re-arguing fixed artifacts).
  - **Fast tally at intermediate reviews** (two-pass Round-1 review): one independent vote
    round; a >50% majority carries one champion (identical to before); a split carries the
    **top TWO non-vetoed** candidates into the final pool (first-place votes, then mean rank,
    then blind label); all-vetoed carries none and round 2 proceeds on guidance alone.
    `council.json` gains `fast_tally` + `carried`; `mapping.json` gains `carriedOver` (array).
  - **Steelman shootout at final decision points** (plan Final rank, implement reviews,
    single-pass Review): the vote round only SEEDS the top-2 non-vetoed finalists — then
    ALWAYS ≥1 improvement round: a non-voting **steelman** distils the judges' cited cons
    into per-finalist minimal change-lists (every item traceable to a con; no redesign),
    implementers apply them to copies (staging-gated, **ratcheted** — a failed boost reverts),
    and a **cold** blind re-judge (fresh letters, no history — only the steelman sees prior
    verdicts) votes once. Majority → the winner ships with its improvements applied (its
    staged artifact is replaced by the boosted version). Tie → iterate, **max 5**; still
    tied → **`needs_orchestrator_pick`** — the orchestrator casts the deciding vote between
    two gated, security-cleared finalists (`decided_by: "orchestrator"`; the engine never
    self-resolves; a vetoed candidate can never be picked). A lone non-vetoed finalist gets a
    solo polish round judged against its own pre-boost version. NO_CONSENSUS remains only for
    all-vetoed. Implement-phase steelman ties skip Round 4 and surface the pick instead.
  - **Brief enhancements:** the plan feasibility lens now owns demand-the-proof claim
    auditing (verify the plan's factual claims against the snapshot); every judge brief
    (council + legacy) gains an anti-length-bias line ("thoroughness is evidence, not word
    count").
- **Structural persist (issue #33) — verified dataplane, bytes stop transiting models.**
  `persist()` writes each artifact ONCE as a single quoted heredoc and verifies it in code:
  the helper reports `wc -c` + `shasum -a 256` per file and the engine compares against a
  pure-JS SHA-256 it computed over the exact bytes — abbreviation/mangling/truncation is a
  verified miss, retried once (forced onto the typed+verified path), then loudly failed.
  Derived artifacts (`verdict.md`, `council.json`, `guidance.md`) are no longer typed by a
  model at all: the new deterministic **`bin/je-render.mjs`** renders them ON DISK from the
  already-verified `verdict.json`, slicing the marked renderer block out of `tournament.mjs`
  itself (engine and renderer cannot drift; byte-parity is unit-tested). The codex judge
  VERDICT.json read-back is likewise sha-verified before parse (a corrupted relay retries,
  then falls back per the existing ladder). Run C measured the old path at ~35 min/checkpoint
  for ~290KB; typed bytes drop ~60% and every remaining byte is checksummed. HELPER_MODEL
  stays `sonnet` everywhere (operator policy: no haiku until a Haiku 5.x base).

- **Official per-seat return codes (JE-RC 00–09).** Every runner script appends a terminal
  `JOUST-RC <code> <short-reason>` line to its `_*_run.log` on **every** exit path (complementing,
  never replacing, the existing DONE/TIMEOUT provenance markers). The engine derives RCs for
  native/judge/helper seats from signals it already observes (agent null/throw, timeout markers,
  schema/verdict-integrity failures, empty staging — never model-self-reported; a missing
  `JOUST-RC` line parses as RC 09), records them in `mapping.json`, council metadata, and the
  workflow return value, and renders an `rc_summary { seats, by_code, non00 }` table in
  `SUMMARY.md`. Engine-fault classes (01/02 after retries, 04–09 — not honest model losses or the
  03 turn-cap) auto-file **one deduped, privacy-scrubbed dogfood issue per class per run** to the
  engine repo via `bin/je-issue.sh` (label `dogfood`). A NEW fail-closed scrubbing pass runs
  **before** je-issue's existing guards, redacting `$HOME`/usernames in paths, UPPER_SNAKE env-var
  values, `*_KEY`/`*_TOKEN`/`*_SECRET` assignments, RFC1918 private IPs, `.local`/`.lan`
  hostnames, and emails — it **never posts unscrubbed** (degrades to a scrubbed committed-inbox
  draft or a loud log) and an issue-filing failure **never blocks or crashes a run**. Set
  `noAutoIssue: true` to disable auto-filing. RCs are OBSERVABILITY, not new control flow —
  fail-safety semantics are unchanged.

### Changed

- **`dualSecurity: false` escape hatch** — per-run arg that drops the `security-x` seat,
  restoring the 5-seat odd panel (an even panel can 3-3 gridlock through every
  deliberation round; observed live, hours of final-rank deliberation). Originally an
  interim measure for that gridlock; judging-v3 (above) retires deliberation entirely and
  makes ties cheap (a tie just seeds the steelman shootout), so the **dual gates are the
  default again** and the flag remains only as an explicit escape hatch. The PRIMARY
  security veto seat cannot be disabled by any flag.

- **Runner wrapper agents haiku → sonnet.** The 8 provider wrapper agents
  (`joust-codex`, `joust-glm-*` ×4, `joust-minimax`, `joust-local`, `joust-grok`) pinned
  `model: haiku` in their frontmatter — the last haiku sub-agents left after the
  `HELPER_MODEL` sonnet bump. They relay runner commands/output verbatim, exactly the
  workload haiku corrupted in issue #33, and they now also carry the council's codex
  judge seats. All bumped to `model: sonnet`.

- **Dual security gates + codex tier policy (spec addendum).** Every council now seats a
  SIXTH judge: `security-x`, a second security gate on **codex-xhigh** (cross-family — it
  resists assumptions natural to the Anthropic models that author most candidates). Veto is
  the UNION of standing evidenced flags from either security seat; majority with 6 living
  judges = 4/6 (strict >50%); the fail-closed security-DEAD policy stays keyed to the
  primary Opus seat. Separately, **codex-xhigh is now the default codex tier everywhere**:
  bare `codex` spec token, Top Mixed, plan/implement default pools, judge seats; codex
  wall-clock profiles widen to 600/900/1800s.

### Fixed

- **GLM runner retries timeout-class transient API errors** (issue #31). `bin/glm-run.sh`'s transient-marker matcher previously matched only `529`/`429`/`5xx`/`overloaded`, so a generic `API Error: The operation timed out.` from the z.ai endpoint killed a parallel glm-5.2 seat on first occurrence even with `retries=3` configured. The matcher now also matches `API Error: …(timed out|timeout)` on the CLI's stable `API Error:` prefix, retrying with the same bounded exponential backoff + jitter. Anchoring to the prefix keeps genuine task output, refusals, and auth text (even auth on the `API Error:` line) from self-tripping a retry, and the runner's own wall-clock SIGALRM (rc 124) still never retries. An engine-level same-provider stagger in `workflows/tournament.mjs` was evaluated and **declined** — the existing startup jitter plus this retry already address the root cause, and a stagger would mutate the shared all-provider dispatch path. `bin/glm-run.test.sh` extended with timeout-retry, wall-clock-no-retry, prefixed-auth-no-retry, and persistent-timeout-cap cases.

### Changed

- **Tournament split into a Plan phase and an optional Implement phase** (2026-07-03 design), replacing the flat single/two-pass structure with a cheap-wide-plan → narrow-strong-implement pipeline.
  - **Plan Round 1 + Plan Round 2 (always).** Attempts produce **PLAN artifacts** — concrete, file-level change proposals that never touch the repo — judged by a new **plan-lens council**: *feasibility, completeness, risk, security-by-design, simplicity/proportionality*. The plan phase runs the two-pass spine (Round 2 always) whenever implementation will follow, so the winning plan is refined before any expensive spend. Default plan pool (N=10): `2 opus, 2 sonnet, 2 codex-high, 2 glm-5.2, 2 minimax`.
  - **Implement Round 3 (only with the `implement` flag).** Each implementer is seeded with the **winning plan verbatim** — the deliberate exception to the never-seed-prior-artifacts rule (the plan IS the spec) — and applies the change repo-anchored. Judged by the existing 5-lens **code council** (correctness/spec/security/robustness/craft) with enrichment + verify evidence. Default implement pool (M=5): `2 opus, 2 codex-high, 1 glm-5.2`.
  - **Implement Round 4 (conditional).** Runs **only if Round 3 produced no gate-passing candidate** (verify fail / council NO_CONSENSUS / all vetoed), guided by the R3 review. Happy path with `implement` = 3 rounds total.
  - **Plan NO_CONSENSUS surfaces to the orchestrator BEFORE any implement spend** — a contested plan is never silently escalated to implementation; the full split (per-judge verdicts + vote evolution) is persisted and the run stops. Implement-phase NO_CONSENSUS after R4 = needs-human (existing contract).
  - **Parser** (`bin/je-parse.mjs`): phase-scoped prose specs — `Plan: 2 opus, …, Implement: 2 opus, …` (each segment uses the existing spec grammar; the plan sum is N, the implement sum is M); the marker-adjacent **`implement` keyword** (or a non-empty `Implement:` segment) enables rounds 3–4; omitted pools fall back to the defaults above. New output fields: `implement`, `planAssignment`, `implementAssignment`. Existing sigil forms and `@@JE:N:M` semantics are unchanged for plan-only runs.
  - The council engine is shared: one deterministic tally / veto / bounded-deliberation / NO_CONSENSUS path, two lens tables (`LENS_PROFILES.plan` vs `LENS_PROFILES.code`), selected per judging point by phase.

- **MiniMax gets its own wall-clock** (`minimaxTimeoutSecs`: short 300s / medium 900s / long 1800s) in `SIZE_PROFILES` and the engine (fallback = `attemptTimeoutSecs`, so unset behaves as before). Both MiniMax-M3 seats in a real medium-profile run timed out at the shared 300s and saved no deliverable (issue #30); M3 needs GLM-style headroom on real code tasks.

- **Self-contained candidate workspaces relocated outside the plugin cache** (issue #34,
  mirrors the #44 `worktreeRoot` fix). `repoMode:false` candidate workspaces (native
  Anthropic and every runner-based attempt) now default to `/tmp/je-workspaces/<run-id>/...`
  instead of `<runDir>/round-*/candidate-*` — `runDir` lives inside the user config dir /
  plugin cache, a path nested claude-CLI runners (glm/minimax/codex/grok) treat as sensitive
  and refuse to write under, so a completed runner attempt could burn its whole turn budget
  fighting write denials and save zero files. Configurable via the new `workspaceRoot` arg
  (`workspaceRoot: runDir` reproduces the pre-fix layout exactly). Staging/review dirs,
  `_engine-logs`, the shared context bundle, and every persisted artifact (`mapping.json`,
  `SUMMARY*.md`, `review-*/`, etc.) are unaffected — they were always written from `runDir`
  literals, never from the candidate workspace path. `repoMode:true` is untouched.

- **Judging is now a 5-lens deliberating Opus council** (issue #22), replacing the single blind Opus judge at BOTH decision points (Phase 3 review and Phase 5 final rank).
  - Five blind Opus judges, one lens each — **correctness, spec, security, robustness, craft** — vote independently in round 1 (no peer visibility), each returning per-candidate pros/cons, a full ranking, a first-place vote, and a required `checks_run[]` evidence list.
  - **Deterministic tally in code** (never an LLM): a **>50% majority** of the living judges' first-place votes on a non-vetoed candidate wins.
  - **Security veto:** the security lens flags candidates `UNSAFE` with a severity + evidence; a standing high/critical flag excludes that candidate from winning regardless of votes.
  - **Bounded deliberation:** no majority (or the majority pick is vetoed) triggers up to **3** deliberation rounds — each judge sees peers' verbatim verdicts, may run 1-2 targeted checks, and revises. Still split → **NO_CONSENSUS** (never resolved by Borda or a meta-judge).
  - **NO_CONSENSUS routing:** interactive runs surface the full split (per-judge verdicts + vote evolution); grand loops route the loop to **needs-human + HALT** (winner `null` / `no_consensus:true` in `mapping.json`).
  - **Judge death:** retry once, then proceed with the living (majority recomputed as >50% of living). Security judge dead in repo-anchored mode fails closed to NO_CONSENSUS; isolated runs proceed with a loud warning that veto coverage was lost.
  - Two-pass guidance is now distilled by a **separate synthesis call** (explicitly not a decision-maker; same `GUIDANCE_CAP`, schema and blind rules) — it never merges votes or picks a winner.
  - **Legacy escape:** pass `judges: 1` to keep the single blind Opus judge (byte-for-byte today's behaviour). Council size is otherwise fixed at 5 (not user-tunable).
  - Council metadata (per-judge verdicts, rounds used, vote evolution, veto events) is logged and persisted to `review-*/council.json`, and rendered in `verdict.md` / the run summaries.

- **Mixed-family judging council + snapshot pinning** (2026-07-05 design). The completeness-class seat (`spec`/`completeness`) and the simplicity-class seat (`craft`/`simplicity`) in each 5-lens council now dispatch to **codex-xhigh** via the codex runner by default (brief → `VERDICT.json` → engine-side JSON-parse + shape validation → the existing `reconcileLens` + verdict-integrity guard); a seat that fails twice (parse/shape/integrity failure counts as a failed attempt) **falls back to native Opus** for that round rather than dropping the seat, logged loudly. The security veto and every verification-heavy lens (correctness/feasibility/security/risk/robustness) stay Opus. `judgeMix: 'anthropic'` forces every seat back to native Opus, **byte-identical** to pre-feature behaviour. Council metadata now records the actual model used per seat per round (`judge_model`). Separately, **every** judge's brief (council or `judges: 1` legacy) is now pinned to the tournament snapshot — the staged pool/candidate dirs, or the repoMode worktrees + base SHA — and told to never consult the live repo checkout, fixing an observed wrong-tree judging failure; a `checks_run` entry citing a path outside that scope now logs a non-fatal warning (v1 telemetry). New optional args: `judgeMix` (`'anthropic'` = all-Opus escape hatch) and `codexJudgeTimeoutSecs` (codex judge-seat wall-clock, default 1500s, separate from the attempt wall-clock).

## v0.0.1

Initial release of **Joust Engine** — model-diverse agentic loops from concept to PR.

- `@@JE` sigil and `joust:N[:M[:Z]]` prose marker (single pass, two pass, grand loops).
- N parallel attempts across a mix of providers (Anthropic, GLM, on-device MLX, OpenAI Codex, MiniMax, xAI Grok), judged blind by a fixed Opus reviewer.
- Two-pass guided rounds; grand loops (`Z >= 2`) implement each winner on a `JE-<loop>-<rand7>` branch behind a fail-closed verify gate and open a PR (never auto-merged).
- Self-contained Claude Code plugin **and** marketplace: `/plugin marketplace add robanderson/joust-engine` → `/plugin install joust-engine@joust-engine`.
- Bundled `bin/je-*` runners, `joust-*` provider agents, and the `joust-engine` / `joust-bench` skills.
