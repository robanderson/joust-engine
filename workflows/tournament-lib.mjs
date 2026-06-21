// workflows/tournament-lib.mjs
//
// Importable home for the GENUINELY PURE helpers that also live, byte-for-byte, inside
// the contribution-estimation block of workflows/tournament.mjs (process-improvement #6,
// item 5 — fragile test↔source coupling).
//
// WHY A SEPARATE FILE: workflows/tournament.mjs is a top-level-`return` script executed
// inside the Claude Code Workflow sandbox. That sandbox has NO `import` (see the inline
// note at tournament.mjs: "sandbox has NO node:fs/import/process"), and the file mixes a
// top-level `export const meta` with top-level `return` — so it is NOT a loadable ES
// module and CANNOT itself `import` from here. tournament.mjs therefore keeps its own
// copy of this block verbatim (runtime behavior unchanged); this module is the canonical,
// importable TEST surface so tests stop scraping source with brittle string markers.
//
// SINGLE SOURCE OF TRUTH is enforced at test time: workflows/tournament.contributions.test.mjs
// asserts that the contribution block in tournament.mjs is byte-identical to the block in
// this module. Editing one without the other fails the suite loudly.
//
// The block below is a verbatim copy of the region between
//   // ---- begin: contribution estimation (PURE; persistence is a separate thin step) ----
//   // ---- end:   contribution estimation (PURE; persistence is a separate thin step) ----
// in workflows/tournament.mjs, with `export` added to the symbols the tests consume.

// ---- begin: contribution estimation (PURE; persistence is a separate thin step) ----
// ESTIMATE — per-model attribution is a HEURISTIC, not ground truth. Intentionally
// forward-improvable. Algorithm: see proposal.md / the comment on computeContributions.
// Persistence is a thin `persist()` call elsewhere in this file; this block is pure
// (data in, data out — no I/O, no globals, no module side-effects).
//
// Single named knobs (all in one place so a future revision can swap them out cleanly):
//   CONTRIB_RANK_DECAY   — per-rank weight function (super-linear so the winning model
//                          stays dominant over a rival that fields several mid-rank finalists).
//   CONTRIB_WINNER_BONUS — additive winner emphasis in the CODE channel (ensures the
//                          winning model gets the dominant share, the acceptance criterion
//                          the issue calls out).
//   CONTRIB_GUIDANCE_SHARE — fraction of the FINAL total allocated to the round-1
//                          guidance channel in two-pass (round-2 outputs were shaped by
//                          round-1 priors, so round-1 models deserve partial credit even
//                          though their code was discarded).
export const CONTRIB_RANK_DECAY = (K, pos) => Math.pow(2, K - pos) // K = #ranked valid cands, pos 1-indexed
export const CONTRIB_WINNER_BONUS = 1.0                            // additive; in weight units
export const CONTRIB_GUIDANCE_SHARE = 0.30                        // 30% to round-1 guidance (two-pass only)

// ESTIMATE — returns [{ model, pct, detail }] with pcts summing to exactly 100.
// Returns [] (never throws) when no valid candidate or no verdict exists.
export function computeContributions(round1, guidance, final, mode) {
  // Channel 1 (code): final ranking in two-pass, round-1 ranking in single-pass.
  const codeReview = (mode === 'two' && final && final.rank && !final.rank.__failed)
    ? final.rank
    : (round1 && round1.review && !round1.review.__failed ? round1.review : null)
  const codeMapping = (mode === 'two' && final && Array.isArray(final.mapping))
    ? final.mapping
    : (round1 && Array.isArray(round1.mapping) ? round1.mapping : null)
  if (!codeReview || !codeMapping) return []
  const codeWeights = weightsFor(codeMapping, codeReview, CONTRIB_RANK_DECAY, CONTRIB_WINNER_BONUS)
  if (!codeWeights.size) return []

  // Channel 2 (guidance): round-1 ranking, only in two-pass with a valid round-1 verdict.
  const guideReview = (mode === 'two' && guidance && round1 && round1.review && !round1.review.__failed)
    ? round1.review : null
  const guideMapping = (round1 && Array.isArray(round1.mapping)) ? round1.mapping : null
  const guideWeights = (guideReview && guideMapping)
    ? weightsFor(guideMapping, guideReview, CONTRIB_RANK_DECAY, 0) // no winner bonus on guidance
    : new Map()

  // Combine: code = (1 - share), guidance = share. share=0 in single-pass (no guidance channel).
  const share = (mode === 'two' && guideWeights.size > 0) ? CONTRIB_GUIDANCE_SHARE : 0
  const combined = new Map()
  for (const [m, w] of codeWeights)  combined.set(m, (combined.get(m) || 0) + w * (1 - share))
  for (const [m, w] of guideWeights) combined.set(m, (combined.get(m) || 0) + w * share)

  return largestRemainderRound(combined, share)
}

// Internal: rank-based weights per model, summing repeated candidates of the same model.
// Filters out valid:false candidates BEFORE weighting, so failed attempts contribute 0 by
// construction (and never appear in the output).
export function weightsFor(mapping, review, decayFn, winnerBonus) {
  const byCandidate = new Map()
  for (const m of (mapping || [])) byCandidate.set(m.candidate, m)
  const validLetters = (review.ranking || []).filter(l => {
    const m = byCandidate.get(l); return m && m.valid !== false
  })
  if (!validLetters.length) return new Map()
  const K = validLetters.length
  const w = new Map()
  validLetters.forEach((letter, i) => {
    const m = byCandidate.get(letter); if (!m || !m.model) return
    const ww = decayFn(K, i + 1) + (i === 0 ? winnerBonus : 0) // bonus on the FIRST-ranked valid cand only
    w.set(m.model, (w.get(m.model) || 0) + ww)
  })
  return w
}

// Internal: sum of all values in a Map.
export function contribSumValues(map) { let s = 0; for (const v of map.values()) s += v; return s }

// Internal: normalize a Map<model, rawWeight> to pcts summing to EXACTLY 100 via
// largest-remainder rounding (drift is given to the LARGEST shares, one unit each, until
// the sum is exactly 100). Returns [] if the total is non-positive.
export function largestRemainderRound(combined, share) {
  const total = contribSumValues(combined)
  if (!isFinite(total) || total <= 0) return []
  const scaled = [...combined.entries()].map(([m, w]) => [m, (w / total) * 100])
  const rows = scaled.map(([m, v]) => ({ m, f: Math.floor(v), r: v - Math.floor(v) }))
  const assigned = rows.reduce((s, x) => s + x.f, 0)
  const drift = 100 - assigned
  // Sort by remainder DESC; ties broken by raw weight DESC (largest model first) so the
  // drift goes to the model that already has the largest share — i.e. the winning model
  // is the FIRST place any rounding drift lands. Stable sort; no random tie-break.
  const ordered = [...rows].sort((a, b) => (b.r - a.r) || (b.f + b.r) - (a.f + a.r))
  for (let i = 0; i < drift && i < ordered.length; i++) ordered[i].f += 1
  const detailTwo = share > 0
    ? `${Math.round(share * 100)}% guidance-channel credit from round-1 models; `
    : ''
  return ordered
    .filter(x => x.f > 0) // drop zero-share models (the rounding pass can produce 0 for negligible weights)
    .map(({ m, f }) => ({
      model: m,
      pct: f,
      detail: `ESTIMATE — rank-decay 2^(K-pos) + winner-bonus ${CONTRIB_WINNER_BONUS}; ${detailTwo}see workflows/tournament.mjs (computeContributions) for the exact formula`,
    }))
    .sort((a, b) => b.pct - a.pct) // largest first — the report's natural reading order
}
// ---- end: contribution estimation (PURE; persistence is a separate thin step) ----
