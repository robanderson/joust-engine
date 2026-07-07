# Persist phase 2 — per-seat verdict files + deterministic assembler (issue #33 follow-on)

Phase 1 (2026-07-06-structural-persist-design.md, shipped) made every persist write
sha-verified and derived verdict.md/council.json/guidance.md on disk via bin/je-render.mjs.
One large artifact still transits the model: **verdict.json itself** is typed once per
checkpoint as a single ~130KB heredoc (~minutes of a sonnet helper reproducing bytes).
Phase 2 eliminates it. The bulk of verdict.json is `council.rounds[*].verdicts[*]` —
per-seat judge verdicts the engine already holds as structured objects (native seats
return schema objects; codex seats already write `VERDICT.json` into their
`${workspaceRoot}/_judges/<seat-label>` workspace). Land those bytes on disk as SMALL
per-seat files when each round finishes, then have deterministic code assemble
verdict.json from them + a small engine tally skeleton. Zero large-artifact model transit.

## Decisions (v1)

1. **Engine-written per-seat files, one persist batch per judging round.** After each
   round's verdicts land (council r1, each deliberation round, each steelman runoff),
   councilJudge calls persist() with one small TYPED entry per living seat — the exact
   `roundRecord(...).verdicts[i]` entry, serialized `json(entry)`. Reuses phase-1's
   heredoc+sha ladder unchanged; each file is ~2-20KB so a whole round is one fast helper
   call. Rejected: "native judges write their own file as a trailing step" — the judge's
   file and its returned schema object (what the tally consumed) could diverge, and the
   judge's own serialization can't be byte-checked against `json(entry)`. The engine copy
   is authoritative; the codex seat's raw workspace VERDICT.json stays a debug artifact.
2. **Skeleton + splice, not recompute.** The checkpoint persists a small `tally.json`:
   the full result object (`buildCouncilResult` output, verbatim) with each
   `council.rounds[*].verdicts[*]` body replaced by a ref
   `{"$seat": "<relpath>", "sha256": "<hex>"}`. A new **bin/je-assemble.mjs** parses the
   skeleton, sha-verifies + parses each referenced seat file, splices the objects back,
   and writes `JSON.stringify(result, null, 2) + '\n'`. No tally/merge logic is
   re-implemented (splice only) — node preserves key insertion order, so parse→splice→
   stringify is byte-identical to `json(review)`. Rejected: extract-and-eval recompute of
   mergeCandidates/consolidatedRanking/buildCouncilResult — the steelman letter-remapping
   and fast-tally branches make recompute a drift farm; splice is dumb and provable.
3. **Full sha verification of the assembled file.** The engine holds the result object,
   so it computes `sha256Hex(json(review))` IN CODE and verifies the assemble step's FLP
   line against it — STRONGER than phase-1 derive verification (bytes>0). A mismatch
   retries via the existing derive→typed ladder (content fallback = today's behavior).
4. **Tally record provenance:** councilTally/roundRecord/buildCouncilResult outputs are
   engine JSON already; the skeleton (~3-15KB: votes, vetoes, vote_evolution, reasoning,
   merged candidates, guidance, steelman meta, seat refs) is written as one small typed
   heredoc in the SAME checkpoint persist batch, ordered before the assemble step (persist
   runs its steps sequentially in one script — the ordering dependency already holds for
   verdict.json → verdict.md today).
5. **Merged `candidates` stays inline in the skeleton (v1).** It duplicates seat pros/cons
   (~5-20KB) but keeping it inline avoids shipping a mapped `final/` seat set for the
   steelman path. v2 can splice it too (cut-list).
6. **je-render unchanged.** Renderers keep `derive.from = <reviewDir>/verdict.json` and
   read the ASSEMBLED file; council.json/verdict.md/guidance.md derivation is untouched.
7. **judges:1 legacy path unchanged.** No council → no rounds bulk → verdict.json stays a
   small typed write. Assemble applies only when `review.council` exists.

## File layout

```
<runDir>/review-1/                      # likewise review-final/, review-impl-3/, review-impl-4/
  _judges/
    tally.json                          # skeleton: result w/ $seat refs (typed, sha-verified)
    review-1-<lens>-r1.json             # per-seat roundRecord verdict entry (typed, sha-verified)
    review-1-<lens>-r2.json             # deliberation rounds, if any
    review-1-runoff<i>-<lens>-r1.json   # steelman runoff rounds (orig-letter mapped)
  verdict.json                          # ASSEMBLED by je-assemble.mjs; byte-equal to json(review)
  verdict.md / council.json / guidance.md   # je-render derive, unchanged (phase 1)
```

Seat filenames reuse the existing seat label (`<phase-label>-<lens.key>-r<n>`), flat under
`_judges/` — the half-existing `${workspaceRoot}/_judges/<label>/` convention stays the
codex seat's SCRATCH workspace (outside runDir, wiped); durable copies live under runDir.
Refs in tally.json are runDir-relative so runs can be moved/archived.

## Engine changes (workflows/tournament.mjs)

- councilJudge: after each round's `verdicts` array is final, fire one persist() batch of
  per-seat typed entries; record `{path, sha}` per seat in a local refs map (keyed
  phase-label + seat-label). Steelman runoffs persist the ORIG-LETTER-mapped verdicts
  (what roundsLog/steelmanVerdicts consume). Fire-and-forget, same as all persist.
- councilJudge returns `result` plus seat refs (attach as a non-enumerable or sibling
  return — refs must NOT appear inside `result`, or json(review) parity breaks; simplest:
  module-level `seatRefs` map keyed by phase label, read by the checkpoint call sites).
- persist(): new entry kind `{ path, content, assemble: { tally } }` —
  `node bin/je-assemble.mjs <tally> <path>` + FLP report; `expected[path] =
  sha256Hex(heredocBody(content))` so the assembled bytes are FULLY verified. Retry ladder
  identical to derive: failed/mismatched assemble retries as typed content.
- buildTallySkeleton(result, refs): deep-copy result, replace each
  `council.rounds[i].verdicts[j]` with its ref (matched by lens key + round). A verdict
  with no on-disk ref (its seat-file persist failed) stays INLINE in the skeleton — the
  skeleton grows but assembly still succeeds; never a crashed persist.
- Checkpoint call sites (review-1, review-final incl. NO_CONSENSUS and
  needs_orchestrator_pick, review-impl-3/4): verdict.json entry becomes
  `{ path, content: json(review), assemble: { tally } }` with the tally.json typed entry
  listed immediately before it. mapping.json, SUMMARY.md/SUMMARY.blind.md, guidance
  fallback content: unchanged small typed writes (stay in persist v1).

## bin/je-assemble.mjs (new, standalone — no extract-and-eval needed)

```
node je-assemble.mjs <tally.json> <out-verdict.json>
```
Read skeleton; walk `council.rounds[*].verdicts[*]`; for each `$seat` ref: read file
(path resolved against the tally file's runDir), sha256 the exact bytes (node:crypto —
real node, unlike the sandbox), compare to `ref.sha256`, JSON.parse, splice. Write
`JSON.stringify(doc, null, 2) + '\n'`. Exit 0 only if every ref resolved + verified and
the output is non-empty; on any failure exit nonzero naming the offending path (the
engine's FLP check then drives the typed fallback). ~60 lines.

## Failure matrix

| Failure | Detection | Outcome |
|---|---|---|
| Seat-file heredoc corrupted/short | phase-1 sha check in persist() | retry typed once; still bad → seat stays INLINE in skeleton (no ref) — assembly unaffected |
| Seat dead in-engine (askLens null) | existing dead-judge path | never referenced; roundRecord dead_seats already records it; nothing new |
| Seat file corrupted on disk later | je-assemble per-ref sha | assemble exits nonzero → persist retries verdict.json as full typed content |
| tally.json write corrupted | phase-1 sha check | retry typed once; still bad → assemble fails → typed verdict.json fallback |
| je-assemble crash / missing / PLUGIN_BIN unknown | FLP miss / engine check | typed-content fallback (exact phase-1 derive ladder) |
| Assembled bytes ≠ json(review) | engine-computed expected sha | verified miss → retry as typed content — corruption structurally cannot land silently |
| Crash mid-judging | n/a | per-seat files already on runDir = natural partial checkpoint (inspection v1; resume v2) |

Persist stays fire-and-forget overall: worst case is today's behavior (one typed 130KB
write), never a crashed run. `needs-human` / NO_CONSENSUS paths use the same mechanism.

## Savings

| | Model-typed bytes per review checkpoint | Wall clock |
|---|---|---|
| Run C (pre-#33) | ~290KB re-typed (all artifacts) | ~35 min measured |
| Phase 1 (shipped) | ~130KB (verdict.json heredoc; md/council/guidance derived) | ~minutes |
| Phase 2 | ~3-25KB (tally skeleton + small artifacts) | **seconds** + `node` assemble/render |

Per-seat writes add 1-4 small helper batches per judging point (~seconds each), amortized
DURING judging — off the checkpoint critical path; the codex read-back helper call per
codex seat already exists and is untouched. Net on a 4-6-checkpoint plan/implement run:
tens of minutes of helper typing removed beyond phase 1.

## Test plan

- **je-assemble.test.mjs (extract-and-eval style fixtures):** build a fixture result
  object covering majority, fast-tally (carried), steelman multi-round, NO_CONSENSUS,
  dead-seat, and dual-security shapes; write seat files + skeleton the way the engine
  would; assert assembler output is BYTE-EQUAL to `json(result)` (parity vs the current
  typed pipeline), and that je-render verdict-md/council-json over assembled vs typed
  verdict.json are byte-identical.
- **Corruption injection:** flip one byte in a seat file → nonzero exit naming the path;
  truncate tally.json → nonzero; ref to missing file → nonzero. Engine-side: simulated
  failed assemble exercises the typed-fallback ladder (extend the existing persist tests).
- **Skeleton builder unit tests (extract-and-eval from tournament.mjs):** refs replace
  the right verdicts; a ref-less verdict stays inline; refs never leak into json(review).
- `npm run check && npm test` green; rebrand self-verify (bin/ + workflows/ touched).

## v1 cut-list (explicitly out)

- Resume/rehydration of a crashed run from seat files (files make it natural; not wired).
- SUMMARY.md derivation (needs rc state on disk; stays a small typed write).
- Splicing merged `candidates` / a mapped `final/` seat set (v2 shrink, ~5-20KB more).
- Reusing the codex seat's raw workspace VERDICT.json as the durable seat file.
- Any HELPER_MODEL change (operator policy: sonnet, no haiku until Haiku 5.x base).

## Acceptance

- A council review checkpoint with a >=100KB verdict.json completes with <30KB of
  model-typed payload and lands byte-identical to `json(review)` (sha-verified) in <60s.
- Every failure row above lands its stated outcome; no path crashes persist.
- Byte-parity fixtures green; existing tests green; closes the phase-2 half of #33.
