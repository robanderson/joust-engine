# Grand Loops (Feature 1) — Maintainer's Addendum & Build Status

Date: 2026-06-15. Companion to `2026-06-15-grand-loops-design.md` (the winning design from the first dogfood tournament — the "doc F" Opus winner). Read that for the full evaluation, grammar, per-loop lifecycle, fork resolutions, autonomy gate, git/PR mechanics, and file-change list. This addendum records what has SINCE been built and the one correction to apply when building the rest.

## Status (what's already done vs. what remains)

- **Feature 2 is SHIPPED** (on `main`, 2026-06-15): `bin/je-parse.mjs` (the parser, 110/110 tests), the 9-option Phase 1 gate, the prose model spec + Top Mixed preset, the explicit-N-vs-prose conflict rule, and the digit-noun guard. So the design doc's **§2 (grammar/parsing) is DONE** — the sigil surface for Feature 1 already exists.
- **`Z` is parsed as inert plumbing**: `je-parse.mjs` validates `Z` and stops with "grand loops not yet implemented" when `Z>1`. Turning that stop into the real grand-loop entry point is the remaining work.
- **MiniMax-M3** was added as a provider after the design (runner + `joust-minimax` agent + gate option). It handled a heavy multi-file build cleanly; **GLM-5.2 (z.ai) is the slow one** and gets its own `glmTimeoutSecs` (bump to ~1800-2400 for heavy code).
- **All four provider runners are uniform**: each reads its key from the env (or codex's `~/.codex/auth.json`), none source/grep rc files, all close stdin with `</dev/null`.
- **Cost is NOT a constraint** for this user (sunk subscriptions, spare capacity). The design's cost-gating / small `Z_MAX` should be treated as runaway-*safety*, not spend control — keep a ceiling and the re-type-`Z` friction, but don't optimize for cheapness.
- The overnight autonomous-PR agent is the **intended goal**, not a scary category change to quarantine. Build the implementer + git/PR layer as the point of the feature. (The name is apt: Professor Joust, the *deliberate inventor* — the opposite of a Ralph-Wiggum random loop.)

## The one correction to doc F (important — re-evaluate at build time)

Doc F (and the blind judges) concluded you **cannot** nest workflows, and that `resumeFromRunId` and the `Math.random`/`Date.now` prohibition don't exist — because they only had the engine source, not the Claude Code **`Workflow` tool API**. **All three ARE real**: `workflow()` supports one-level nesting, `resumeFromRunId` gives resumability, and `Date.now()`/`Math.random()` are forbidden in workflow scripts. So doc F's orchestration-home choice (a SKILL-narrated Z-loop + bash helpers) rests on a false premise and should be weighed against:

- a **deterministic outer `grand-loop.mjs` workflow** that nests `tournament.mjs` per loop and is **resumable via `resumeFromRunId`** — materially better for *unattended overnight* runs (a 6-hour chain that dies at loop 4 shouldn't lose loops 1-3). Doc F's valid concern — repo mutation from a backgrounded workflow agent is less auditable than from the watched main agent — still applies; mitigate by confining ALL real-repo writes to a single bundled `git`/`gh` runner (the same benign-runner pattern as glm/codex/minimax), invoked from the loop.

Net: the nested-workflow home is now on the table and probably wins for the unattended use case; doc F's SKILL-driven home is the conservative fallback.

## The rest of doc F still stands

FAN topology + cross-loop ledger (default; STACK opt-in with forced halt-on-failure), proposal → a separate **implementer** agent (the highest-risk new component — keep it a single audited actor writing only on the `JE-<n>-<random7>` branch), fail-closed auto-detected verify (draft/needs-human PR on failure, never auto-merge), one front-loaded autonomy authorization (re-type `Z`), the zero-token preflight, idempotency via per-loop DONE markers, and non-implementable-task detection. Branch convention `JE-<n>-<random7>` is user-confirmed (it overrides the global `rob/` prefix for loop branches only).

## Suggested build order

1. **Implementer agent** (`agents/joust-implementer.md`, a strong Anthropic model) + a bundled **git/PR runner** (`bin/je-git.sh`: preflight → branch → commit → `gh pr create` → DONE marker) — the side-effecting layer, mirrored on the existing runner pattern.
2. **Z-loop orchestration** — decide nested-`grand-loop.mjs`-workflow vs SKILL-driven (per the correction above); wire it to call `tournament.mjs` per loop → implementer → verify → git/PR runner → ledger.
3. Flip `je-parse.mjs`'s `Z`-inert stop into the real grand-loop entry; add the SKILL.md authorization-gate phase.
4. **Dogfood at `Z=2` on a low-stakes repo** before trusting it overnight.
