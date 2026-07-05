#!/usr/bin/env node
// je-parse.mjs — Joust Engine Phase-0 parser + normaliser (Feature 2 + Feature 1).
//
// Single source of truth for the @@JE sigil / prose-marker grammar, the prose
// model spec, the strict normaliser, the Top Mixed preset, the
// explicit-N-vs-prose conflict rule, and (NEW, Feature 1) the grand-loop Z
// parameter.
//
// @@FE (Fable Engine, the fast composer variant) is ALSO parsed here:
//   @@FE[:N]  — N optional (>= 2); case-insensitive; optional spaces around ':'.
//   Output gains fe:true + composeOnly:true. M/Z segments are INVALID for @@FE
//   (loud error, like positional skips) — @@FE is single-pass compose-only.
//   The marker-adjacent size word (short/medium/long) and the prose model spec
//   work identically to @@JE (spec sum supplies/overrides N). Bare @@FE with no
//   N and no spec expands to the skill's documented default pool
//   (2 opus, 2 sonnet, 2 glm-5.2, 2 codex-high, 2 minimax-m3 => N=10) and sets
//   feDefaultPool:true, needsGate:false (no interactive gate).
//   @@FE and @@JE in ONE message is an error (never guess which engine).
//
// Pure & deterministic: no Date, no random, no I/O except the tiny CLI guard at
// the bottom. NEVER throws on user input — every failure becomes an errors[]
// entry and n/assignment are nulled so a careless caller can't run the wrong
// tournament.
//
// CLI:   node je-parse.mjs "<raw user message>"   (or --help / --size <label>)
// Prints { task, n, mode, z, assignment, preset?, conflict?, errors?, needsGate?,
//          repoMode, baseRef }
//   plus, for an @@FE invocation only: { fe: true, composeOnly: true,
//          feDefaultPool } (feDefaultPool true iff the bare-@@FE default N=10
//          pool was applied). @@JE / prose parses carry NONE of the fe fields.
//   repoMode : boolean — true => repo-anchored (worktree-per-attempt) grand loop;
//               false (default) => today's self-contained tournament, byte-for-byte.
//   baseRef  : string|null — pinned base sha for repo-anchored mode. The PARSER only
//               ever records null (the SKILL resolves the sha at run time; plan §4/§13).
//
// Feature 1 (grand loops, Z): Z is now a REAL parameter, not inert plumbing.
//   - Z optional, default 1.  Z=1 == today's behaviour exactly (isolated
//     tournament, no repo writes, no PR) — byte-identical output for any input
//     that omits Z or sets Z=1.
//   - Z>=2 is VALID and flows on to the SKILL's grand-loop authorization +
//     driver.  No "grand loops not yet implemented" stop any more.
//   - Z_MAX = 5 is a runaway-SAFETY ceiling (not a cost cap — cost is not a
//     constraint here).  Z > Z_MAX is a LOUD error that echoes the offending Z
//     and tells the user to split into batches; n/assignment are nulled so a
//     caller that ignores errors cannot mistake it for a valid run.

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------
// Runaway-safety ceiling on grand loops. Z>Z_MAX is refused outright. This is a
// safety bound, NOT a cost bound (cost is not a constraint for this user) — but
// an unattended chain that mutates a real repo Z times per Enter must have a
// hard cap so a fat-fingered @@JE:5:2:30 cannot run 30 repo-mutating loops.
const Z_MAX = 5;

// Runaway-safety ceiling on tournament size. N>N_MAX is refused outright. This
// bounds one invocation's fan-out; together with Z_MAX=5 it caps dispatches at
// 80, while still allowing the normal small review pools this parser is built for.
const N_MAX = 16;

function nMaxError(n) {
  return 'N=' + n + ' exceeds the tournament-size ceiling N_MAX=' + N_MAX +
    '. This is a runaway-safety bound. Split into batches: run several invocations with N<=' +
    N_MAX + ' instead.';
}

// ---------------------------------------------------------------------------
// Normaliser table (the strict gate). alias -> { model, dispatch }.
// Keys are the *canonicalised* token form (lowercased, internal whitespace
// collapsed to single spaces, surrounding whitespace trimmed). We deliberately
// do NOT blanket-replace '.'/'_' so version tokens like 'glm 5.2' survive.
// ---------------------------------------------------------------------------
const NORMALISER = {
  // Anthropic
  'opus':   { model: 'opus',   dispatch: 'anthropic' },
  'sonnet': { model: 'sonnet', dispatch: 'anthropic' },
  'haiku':  { model: 'haiku',  dispatch: 'anthropic' },

  // GLM (z.ai). Bare 'glm' defaults to glm-5.2 (documented strongest).
  'glm':         { model: 'glm-5.2',     dispatch: 'glm' },
  'glm 5.2':     { model: 'glm-5.2',     dispatch: 'glm' },
  'glm-5.2':     { model: 'glm-5.2',     dispatch: 'glm' },
  'glm 5.1':     { model: 'glm-5.1',     dispatch: 'glm' },
  'glm-5.1':     { model: 'glm-5.1',     dispatch: 'glm' },
  'glm 4.7':     { model: 'glm-4.7',     dispatch: 'glm' },
  'glm-4.7':     { model: 'glm-4.7',     dispatch: 'glm' },
  'glm 4.5 air': { model: 'glm-4.5-air', dispatch: 'glm' },
  'glm-4.5-air': { model: 'glm-4.5-air', dispatch: 'glm' },
  'glm 4.5-air': { model: 'glm-4.5-air', dispatch: 'glm' },
  'air':         { model: 'glm-4.5-air', dispatch: 'glm' },

  // Codex (OpenAI, pinned gpt-5.5; the axis is reasoning effort).
  // Bare 'codex' defaults to codex-xhigh (2026-07-05: xhigh is the regular tier for all
  // engine use — pools, presets, judge seats). Explicit low/medium/high still selectable.
  'codex':            { model: 'codex-xhigh', dispatch: 'codex' },
  'codex low':        { model: 'codex-low',    dispatch: 'codex' },
  'codex medium':     { model: 'codex-medium', dispatch: 'codex' },
  'codex high':       { model: 'codex-high',   dispatch: 'codex' },
  'codex xhigh':      { model: 'codex-xhigh',  dispatch: 'codex' },
  'codex x-high':     { model: 'codex-xhigh',  dispatch: 'codex' },
  'codex extra high': { model: 'codex-xhigh',  dispatch: 'codex' },

  // MiniMax (new provider since the design doc). Like any single-model provider.
  'minimax':    { model: 'minimax-m3', dispatch: 'minimax' },
  'minimax-m3': { model: 'minimax-m3', dispatch: 'minimax' },
  'minimax m3': { model: 'minimax-m3', dispatch: 'minimax' },
  'm3':         { model: 'minimax-m3', dispatch: 'minimax' },

  // Grok (xAI, via the `grok` headless CLI). TWO variants on a -m model axis.
  // Bare 'grok' defaults to grok-build (the operator's '/model grok' = the grok-code build) — deliberately
  // NOT the CLI's config default (grok-composer-2.5-fast). The Composer variant needs an explicit spelling.
  'grok':                   { model: 'grok-build',             dispatch: 'grok' },
  'grok build':             { model: 'grok-build',             dispatch: 'grok' },
  'grok-build':             { model: 'grok-build',             dispatch: 'grok' },
  'grok code':              { model: 'grok-build',             dispatch: 'grok' }, // grok-code-fast-1 lineage
  'grok-code':              { model: 'grok-build',             dispatch: 'grok' },
  'grok composer':          { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
  'grok-composer':          { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
  'grok composer 2.5':      { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
  'grok composer 2.5 fast': { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
  'grok-composer-2.5-fast': { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
  'composer':               { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
  'composer 2.5':           { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
  'composer 2.5 fast':      { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
};

// Top Mixed preset pool, in remainder-priority order.
const TOP_MIXED_POOL = ['opus', 'glm-5.2', 'codex-xhigh'];

// ---------------------------------------------------------------------------
// Plan/Implement round split (2026-07-03 design).
// The tournament is split into a cheap, wide PLAN phase (rounds 1 & 2, always)
// and an optional narrow IMPLEMENT phase (rounds 3 & 4, only with the implement
// flag). Each phase draws from its own default pool; a phase-scoped prose spec
// ('Plan: 2 opus, ..., Implement: 2 opus, ...') overrides the relevant pool.
//   - PLAN_DEFAULT_POOL   : wide, diverse — plans are cheap to produce/judge (N=10).
//   - IMPLEMENT_DEFAULT_POOL : small, strong — code is expensive (M=5).
// The plan pool sum is the tournament N (attempts per plan round); the implement
// pool sum is M (implementers in round 3/4). Both are capped by N_MAX.
const PLAN_DEFAULT_POOL = [
  'opus', 'opus', 'sonnet', 'sonnet', 'codex-xhigh', 'codex-xhigh',
  'glm-5.2', 'glm-5.2', 'minimax-m3', 'minimax-m3',
];
// 2026-07-03: sonnet joined the implement pool (Sonnet 5 = newer base, better value; Rob wants
// opus >= 2 AND sonnet >= 2), trading one codex-high seat to keep M lean.
const IMPLEMENT_DEFAULT_POOL = ['opus', 'opus', 'sonnet', 'sonnet', 'codex-xhigh', 'glm-5.2'];

// @@FE (Fable Engine) default draft pool — the skill's documented default N=10
// pool for a bare @@FE (no N, no spec). Codex at HIGH (not xhigh: near-equal
// draft quality, materially faster); glm-5.2 viable because a compose round has
// no council to gridlock. See skills/fable-engine/SKILL.md "Phase 0: Parse".
const FE_DEFAULT_POOL = [
  'opus', 'opus', 'sonnet', 'sonnet', 'glm-5.2', 'glm-5.2',
  'codex-high', 'codex-high', 'minimax-m3', 'minimax-m3',
];

// Recognised model token alternatives for the SPEC scan. These match the
// HEAD of an item (after the count); the normaliser then validates exactly.
// Order matters: longer / more-specific patterns first so we capture the full
// token (e.g. 'codex high' not just 'codex').
const MODEL_TOKEN_RX =
  '(?:' +
    'codex(?:\\s*-?\\s*(?:low|medium|high|xhigh|x-?high|extra\\s*high))?' +
    // grok: 'grok', 'grok build', 'grok-code', 'grok composer 2.5 fast', etc. (more-specific before bare 'grok')
    '|grok(?:\\s*-?\\s*(?:build|code|composer(?:\\s*-?\\s*2\\.5(?:\\s*-?\\s*fast)?)?))?' +
    // bare 'composer 2.5 fast' (no 'grok' prefix) — the operator's Composer name on its own
    '|composer(?:\\s*-?\\s*2\\.5(?:\\s*-?\\s*fast)?)?' +
    '|glm(?:\\s*-?\\s*[0-9](?:\\.[0-9])?)?(?:\\s*-?\\s*air)?' +
    '|opus|sonnet|haiku' +
    '|minimax(?:\\s*-?\\s*m3)?|m3' +
  ')';

// Connectors that license capturing an *arbitrary* (possibly unknown) token as
// a spec item — used by the second-stage scan so unknowns are caught loudly
// without treating ordinary '<digit> <noun>' task text as a spec.
const CONNECTOR_BEFORE = '(?:with|using)';

// Shared COUNT fragment for every spec regex: a leading integer count, with an
// OPTIONAL multiplier 'x' (so '2x opus' == '2 opus'). The 'x' is OUTSIDE the
// capture group so parseInt(m[1]) stays a clean integer (no post-strip hack).
// Applied in lockstep to ITEM_RX, locateSpec/stripAll chainRx, expandSpec
// itemFinder so the 'Nx' form is recognised everywhere a count can appear.
const COUNT_RX = '(\\d+)x?\\s*';      // capturing form: '(\\d+)' + optional 'x'
const COUNT_NC = '\\d+x?\\s*';        // non-capturing form (chain scans)

// A '<n> grand loop[s]' phrase = the Z (grand-loop) directive in prose. It must
// be recognised and STRIPPED before the model-spec scan runs, otherwise 'grand'
// reaches the model-token recogniser and errors. Capture the integer in group 1.
const GRAND_LOOP_RX = /(\d+)\s*grand\s+loops?\b/i;

// A prose pass-count directive in plain English: 'two pass'/'two-pass' -> M=2;
// 'single pass'/'one pass' -> M=1. Reconciled against the sigil :M like
// GRAND_LOOP_RX is for Z (sigil wins; disagreement is a LOUD error).
//
// CRUCIALLY it is recognised ONLY when it sits IMMEDIATELY ADJACENT to the marker
// AND is set off as its own clause (followed by a comma/semicolon, the spec's
// leading digit, or end-of-side). An adversarial review showed an unanchored
// whole-message scan is dangerous: 'two-pass compiler', 'single-pass renderer',
// 'one pass over the data', 'the two-pass build' are ordinary TASK vocabulary —
// an unanchored scan flipped the mode on them, refused valid runs via a false
// pass-count conflict, and ate the words from the task. Anchoring to the marker +
// a clause boundary keeps those task phrases untouched while still catching a real
// directive like '@@JE two pass, ...' or '... @@JE:4 single pass'. (dogfood D-0006)
//   AFTER  : immediately follows the marker, then a clause boundary (, ; digit eol)
//   BEFORE : immediately precedes the marker (bounded by the marker itself)
const PASS_AFTER_RX  = /^[\s:,-]*\b(two|single|one)[\s-]?pass\b(?=\s*(?:[,;]|\d|$))/i;
const PASS_BEFORE_RX = /\b(two|single|one)[\s-]?pass\b[\s:,-]*$/i;

// Marker-adjacent repo-mode keywords (plan §4). Recognised ONLY immediately adjacent
// to the marker (after it, else before it) and stripped at the source side — the SAME
// D-0006 discipline the pass-count directive uses — so an ordinary 'anchored' or
// 'self-contained' elsewhere in the task body is never misread as a directive and is
// never eaten from the task. (We do NOT use a global `top mixed`-style scan/strip here
// precisely because 'anchored'/'self-contained' are common words; see plan §4 + D-0006.)
//   opt-IN  : 'repo-anchored' / 'repo anchored' / 'anchored'    -> repoMode true
//   opt-OUT : '--no-repo' / 'self-contained' / 'self contained' -> forces repoMode false
// The final repoMode is resolved in section 5b (Z>=2 default; opt-out wins).
const REPO_ANCHORED_AFTER_RX  = /^[\s:,-]*\b(?:repo[\s-]?anchored|anchored)\b/i;
const REPO_ANCHORED_BEFORE_RX = /\b(?:repo[\s-]?anchored|anchored)\b[\s:,-]*$/i;
const NO_REPO_AFTER_RX  = /^[\s:,-]*(?:--no-repo|self[\s-]?contained)\b/i;
const NO_REPO_BEFORE_RX = /(?:--no-repo|self[\s-]?contained)\b[\s:,-]*$/i;

// Marker-adjacent TASK-SIZE override (the dynamic-limits feature). The orchestrator
// normally ESTIMATES whether a task is short / medium / long and sizes the per-attempt
// turn + wall-clock limits accordingly; this keyword lets the user force a size by
// listing one of short / medium / long next to the @@JE marker (e.g. `@@JE:5 long`,
// `@@JE short, fix the bug`, `tidy up long @@JE:4`). It is recognised ONLY immediately
// adjacent to the marker and stripped at THAT side — the SAME D-0006 discipline the
// pass-count + repo-mode keywords use — so an ordinary 'short'/'medium'/'long' in the
// task body (e.g. 'long division solver', 'short-circuit the eval') is never misread as
// a directive and never eaten from the task. The AFTER form additionally requires a
// clause boundary (',' / ';' / end) right after the size word, so only a deliberately
// set-off `@@JE:5 long` or `@@JE long, <task>` matches — `@@JE long division` does not.
//   AFTER  : immediately follows the marker, then a clause boundary (, ; eol)
//   BEFORE : immediately precedes the marker
const SIZE_AFTER_RX  = /^[\s:,-]*\b(short|medium|long)\b(?=\s*(?:[,;]|$))/i;
const SIZE_BEFORE_RX = /\b(short|medium|long)\b[\s:,-]*$/i;

// Marker-adjacent 'implement' keyword (plan/implement round split). It enables the
// implement rounds (3–4) without a phase-scoped Implement: spec. Like the pass /
// repo-mode / size keywords it is recognised ONLY immediately adjacent to the marker
// and stripped at THAT side (the D-0006 discipline), so an ordinary 'implement …' in
// the task body ('implement a CSV parser') is NEVER misread as a directive and never
// eaten from the task. The AFTER form additionally needs a clause boundary (comma /
// semicolon / end) right after the word, so only a deliberately set-off '@@JE implement,
// <task>' or '@@JE:5 implement' matches — '@@JE implement a parser' does NOT.
//   AFTER  : immediately follows the marker, then a clause boundary (, ; eol)
//   BEFORE : immediately precedes the marker
const IMPLEMENT_AFTER_RX  = /^[\s:,-]*\bimplement\b(?=\s*(?:[,;]|$))/i;
const IMPLEMENT_BEFORE_RX = /\bimplement\b[\s:,-]*$/i;

// Phase-scoped prose model specs. 'Plan: <spec>' / 'Implement: <spec>' segment
// labels let the user set a distinct pool per phase, e.g.
//   'Plan: 2 opus, 2 sonnet, 2 codex high, Implement: 2 opus, 2 codex high'.
// A non-empty Implement: segment ALSO enables the implement rounds (like the keyword).
// These are explicit, distinctive labels (a capitalised word + colon), so — unlike the
// bare 'implement' keyword — they are recognised ANYWHERE in the message; the label
// words and their spec chains are stripped from the task by stripAll().
const PLAN_LABEL_RX      = /\bplan\s*:/i;
const IMPLEMENT_LABEL_RX = /\bimplement\s*:/i;

// ---------------------------------------------------------------------------
// Task-size limit profiles (single source of truth for the dynamic limits).
//
// Each profile is the COMPLETE set of per-attempt guard args the SKILL passes
// straight through to workflows/tournament.mjs. 'medium' is the engine's historical
// default behaviour (so an un-sized run is unchanged in spirit); 'short' tightens the
// guards for quick scripts; 'long' loosens them for heavy multi-file builds / big
// writing deliverables. These are deliberately GENEROUS runaway backstops (the
// single-pass hard-stop brief is the real guard), scaled to task weight.
//   attemptMaxTurns : GLM iteration cap (JE_MAX_TURNS)
//   localMaxTurns   : on-device/local iteration cap (weaker models -> tighter)
//   minimaxMaxTurns : MiniMax iteration cap
//   grokMaxTurns    : Grok iteration cap (grok has BOTH guards)
//   attemptTimeoutSecs : wall-clock backstop for local/minimax/GLM (GLM overridden below)
//   glmTimeoutSecs  : GLM-only wall-clock (GLM via z.ai is slow on heavy code)
//   codexTimeoutSecs: Codex-only wall-clock (codex has NO turn cap -> wall clock only)
//   grokTimeoutSecs : Grok-only wall-clock
//   minimaxTimeoutSecs : MiniMax-only wall-clock (M3 is slow on real code; issue #30)
// ---------------------------------------------------------------------------
const SIZE_PROFILES = {
  short: {
    attemptMaxTurns: 15,
    localMaxTurns: 12,
    minimaxMaxTurns: 15,
    grokMaxTurns: 15,
    attemptTimeoutSecs: 180,
    glmTimeoutSecs: 600,
    codexTimeoutSecs: 600,
    grokTimeoutSecs: 300,
    minimaxTimeoutSecs: 300,
  },
  medium: { // == today's engine defaults (with a roomier GLM wall-clock, which is slow)
    attemptMaxTurns: 30,
    localMaxTurns: 20,
    minimaxMaxTurns: 30,
    grokMaxTurns: 30,
    attemptTimeoutSecs: 300,
    glmTimeoutSecs: 1200,
    codexTimeoutSecs: 900,
    grokTimeoutSecs: 600,
    minimaxTimeoutSecs: 900, // issue #30: both M3 seats blew the shared 300s on a real medium task
  },
  long: {
    attemptMaxTurns: 50,
    localMaxTurns: 35,
    minimaxMaxTurns: 50,
    grokMaxTurns: 50,
    attemptTimeoutSecs: 600,
    glmTimeoutSecs: 2400,
    codexTimeoutSecs: 1800,
    grokTimeoutSecs: 1200,
    minimaxTimeoutSecs: 1800,
  },
};

// Resolve a size label to its full limit profile, or null for an unknown label.
// Returns a fresh object tagged with the canonical size so the SKILL can pass it
// straight into the workflow args (and echo it in the Phase 2 confirmation).
function sizeProfile(label) {
  const key = canon(label);
  return SIZE_PROFILES[key] ? { size: key, ...SIZE_PROFILES[key] } : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canon(tok) {
  return String(tok).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Normalise one captured model token to { model, dispatch } or null if unknown.
function normaliseModel(rawToken) {
  let t = canon(rawToken);
  if (!t) return null;

  // Direct hit on the table.
  if (NORMALISER[t]) return NORMALISER[t];

  // Tolerate a dash where the table has a space and vice-versa for the
  // multi-word codex/glm forms (e.g. 'codex-high' <-> 'codex high'). We try a
  // small set of equivalent spellings WITHOUT mangling version numbers.
  const dashToSpace = t.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (NORMALISER[dashToSpace]) return NORMALISER[dashToSpace];

  const spaceToDash = t.replace(/\s+/g, '-');
  if (NORMALISER[spaceToDash]) return NORMALISER[spaceToDash];

  // 'x high' / 'xhigh' / 'extra high' codex variants already covered; handle
  // 'codex' followed by an unusual-but-equivalent spacing of effort.
  const codexCollapsed = t.replace(/^codex\s*-?\s*/, 'codex ').replace(/\s+/g, ' ').trim();
  if (NORMALISER[codexCollapsed]) return NORMALISER[codexCollapsed];

  // Local ids: a live local id is accepted verbatim by the caller (we can't
  // see the omlx list here). Heuristic: a token that is NOT one of our known
  // provider families but *looks* like a model id (contains a dash and is not
  // a plain English word) could be local. We do NOT guess here — local ids are
  // long/dynamic, the design says accept-verbatim-if-typed but never fuzzy
  // match. Caller handles local via the interactive Mixed menu, so the parser
  // treats an unrecognised token as a hard error (never silently dropped).
  return null;
}

// Parse an integer segment that may be empty. Returns { present, value }.
function intSeg(raw) {
  if (raw === undefined || raw === null || raw === '') return { present: false, value: null };
  const v = parseInt(raw, 10);
  if (Number.isNaN(v)) return { present: true, value: null };
  return { present: true, value: v };
}

// ---------------------------------------------------------------------------
// Sigil / prose-marker detection.
// ---------------------------------------------------------------------------
// We capture each colon segment as \d* (NOT \d+) so an empty segment (a
// positional skip like '@@JE:5::3') is distinguishable from a supplied one.
// The trailing-segment groups are kept optional so '@@JE', '@@JE:5',
// '@@JE:5:2' and '@@JE:5:2:3' all match.
const SIGIL_RX = /@@je(?:\s*:\s*(\d*))?(?:\s*:\s*(\d*))?(?:\s*:\s*(\d*))?/i;
const PROSE_RX = /joust\s*:\s*(\d*)(?:\s*:\s*(\d*))?(?:\s*:\s*(\d*))?/i;
// @@FE (Fable Engine) sigil. Same segment shape as SIGIL_RX so an M/Z segment
// is CAPTURED (and then rejected loudly) rather than silently left in the task.
// NB: '@@FE' is deliberately brand-invariant — the rebrand map (rebrand.config.json)
// rewrites @@JE tokens only, so this sigil survives identically in the dev channel.
const FE_SIGIL_RX = /@@fe(?:\s*:\s*(\d*))?(?:\s*:\s*(\d*))?(?:\s*:\s*(\d*))?/i;

// ---------------------------------------------------------------------------
// Prose model-spec scan (two-stage).
//   Stage 1: match a chain of '<count> <recognised-model>' items.
//   Stage 2: if a connector ('with'/'using') OR a comma/'and' joins items and
//            one item carries an unrecognised model-ish token, capture it too
//            so the normaliser can reject it loudly (never drop -> never change N).
// ---------------------------------------------------------------------------

// A single recognised item: <count> <model token>.
const ITEM_RX = new RegExp(COUNT_RX + '(' + MODEL_TOKEN_RX + ')', 'i');

// Find the prose spec region in the message. Returns
// { found, start, end, raw } where [start,end) is the slice to strip, or
// { found:false }.
function locateSpec(msg) {
  // Build a global regex that matches a run of recognised items joined by
  // commas / 'and' / whitespace, optionally introduced by a connector.
  // We iterate item-by-item (NOT one giant variable-length capture) to reliably
  // capture middle items.
  const chainRx = new RegExp(
    '(' + COUNT_NC + MODEL_TOKEN_RX + ')' +                       // first item
    '(?:\\s*(?:,\\s*and|,|and)\\s*' + COUNT_NC + MODEL_TOKEN_RX + ')*', // more
    'ig'
  );

  let best = null;
  let m;
  while ((m = chainRx.exec(msg)) !== null) {
    if (m[0].length === 0) { chainRx.lastIndex++; continue; }
    // Require that this run is "spec-like": either it has >=2 items, or it is
    // near a connector / comma / 'and', or the single item's model token is a
    // recognised model (not an ordinary noun). Because ITEM model tokens here
    // are drawn from MODEL_TOKEN_RX (real model families only), a lone
    // '3 glm' is fine; '3 bugs' never matches because 'bugs' isn't a model
    // token. So any match here is already spec-grade.
    if (!best || m[0].length > best.raw.length) {
      best = { found: true, start: m.index, end: m.index + m[0].length, raw: m[0] };
    }
  }
  return best || { found: false };
}

// Given a located spec slice, expand it into an assignment array, collecting
// unknown tokens as errors. Returns { assignment, count, unknowns[], overflows[] }.
function expandSpec(specRaw) {
  const assignment = [];
  const unknowns = [];
  const overflows = [];
  // Iterate per item.
  const itemFinder = new RegExp(COUNT_RX + '(' + MODEL_TOKEN_RX + ')', 'ig');
  let m;
  let any = false;
  while ((m = itemFinder.exec(specRaw)) !== null) {
    any = true;
    const count = parseInt(m[1], 10);
    const norm = normaliseModel(m[2]);
    if (!norm) {
      unknowns.push(m[2].trim());
      continue; // recorded as unknown; do NOT drop silently — surfaced below.
    }
    const nextTotal = assignment.length + count;
    if (count > N_MAX || nextTotal > N_MAX) {
      overflows.push({ count, total: nextTotal, token: m[2].trim() });
      continue;
    }
    for (let i = 0; i < count; i++) assignment.push(norm.model);
  }
  return { assignment, count: any ? assignment.length : 0, unknowns, overflows, any };
}

// Detect a connector-licensed UNKNOWN token: '<count> <arbitrary>' sitting next
// to 'with'/'using'/','/'and'. This catches typos like '1 gpt4' that the
// recognised-token scan misses, so they error instead of silently shrinking N.
function locateUnknownNearConnector(msg) {
  // <connector> <count> <word(s)>   e.g. 'with 1 gpt4'
  const afterConnector = new RegExp(
    '\\b' + CONNECTOR_BEFORE + '\\s+(\\d+)\\s+([a-z][\\w.+-]*)',
    'ig'
  );
  // ', <count> <word>' or 'and <count> <word>' or 'X, 1 gpt4'
  const afterJoiner = new RegExp(
    '(?:,|\\band\\b)\\s*(\\d+)\\s+([a-z][\\w.+-]*)',
    'ig'
  );
  const hits = [];
  let m;
  while ((m = afterConnector.exec(msg)) !== null) hits.push({ count: m[1], tok: m[2] });
  while ((m = afterJoiner.exec(msg)) !== null) hits.push({ count: m[1], tok: m[2] });
  return hits;
}

// ---------------------------------------------------------------------------
// Top Mixed preset.
//   keyword 'top mixed' / 'top-mix' / 'top mix' + an N -> allocate N across
//   [opus, glm-5.2, codex-high] as evenly as possible, remainder priority
//   opus > glm-5.2 > codex-high. N2 special-cases to opus+glm-5.2 (1/1/0).
// ---------------------------------------------------------------------------
const TOP_MIXED_RX = /\btop[\s-]*mix(?:ed)?\b/i;
// A leading count for top mixed, e.g. '6 top mixed'.
const TOP_MIXED_LEADCOUNT_RX = /(\d+)\s*top[\s-]*mix(?:ed)?\b/i;

function topMixedAssignment(n) {
  if (!Number.isSafeInteger(n) || n < 2 || n > N_MAX) return [];
  if (n === 2) return ['opus', 'glm-5.2']; // 1/1/0 by spec
  const base = Math.floor(n / 3);
  let rem = n % 3;
  const counts = [base, base, base];
  for (let i = 0; i < 3 && rem > 0; i++, rem--) counts[i]++;
  const out = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < counts[i]; j++) out.push(TOP_MIXED_POOL[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase-scoped prose model specs ('Plan: ...' / 'Implement: ...').
// ---------------------------------------------------------------------------
// Slice the message into the Plan and Implement label segments, run the existing
// spec grammar (expandSpec via locateSpec) on each, and return the per-phase
// expansion. Returns null when neither label is present (the caller then uses the
// single-pool / default path). Each label's segment runs from just after its own
// label to the start of the OTHER label (whichever comes later) or end-of-message,
// so a Plan pool never bleeds into the Implement pool.
function extractPhaseSpecs(msg) {
  const planLbl = PLAN_LABEL_RX.exec(msg);
  const implLbl = IMPLEMENT_LABEL_RX.exec(msg);
  if (!planLbl && !implLbl) return null;

  // Ordered boundaries so each segment ends where the next label starts.
  const marks = [];
  if (planLbl) marks.push({ name: 'plan', start: planLbl.index, end: planLbl.index + planLbl[0].length });
  if (implLbl) marks.push({ name: 'implement', start: implLbl.index, end: implLbl.index + implLbl[0].length });
  marks.sort((a, b) => a.start - b.start);

  const out = { plan: null, implement: null };
  for (let i = 0; i < marks.length; i++) {
    const seg = msg.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : msg.length);
    const loc = locateSpec(seg);
    // Collect unknown-but-spec-ish tokens so a typo in a phase spell-out errors LOUDLY
    // (never silently drops a token → never silently changes N): the connector/comma-
    // licensed unknowns the recognised scan misses, plus a leading '<count> <token>' item
    // (a phase segment's first item is definitionally a spec item, right after the label).
    const unk = phaseSegmentUnknowns(seg);
    // An Implement: label with no model spell-out is still a signal to enable the
    // implement rounds (defaults fill the pool); record an empty expansion for it.
    const exp = loc.found ? expandSpec(loc.raw) : { assignment: [], count: 0, unknowns: [], overflows: [], any: false };
    for (const u of unk) if (!exp.unknowns.includes(u)) exp.unknowns.push(u);
    out[marks[i].name] = exp;
  }
  return out;
}

// Spec-ish UNKNOWN tokens in one phase segment: comma/and/connector-licensed ones
// (existing semantics) plus the segment's leading '<count> <token>' item. A token that
// normalises to a known model is NOT an unknown.
function phaseSegmentUnknowns(seg) {
  const unk = [];
  for (const h of locateUnknownNearConnector(seg)) {
    if (!normaliseModel(h.tok) && !unk.includes(h.tok)) unk.push(h.tok);
  }
  const lead = /^\s*(\d+)x?\s+([a-z][\w.+-]*)/i.exec(seg);
  if (lead && !normaliseModel(lead[2]) && !unk.includes(lead[2])) unk.push(lead[2]);
  return unk;
}

// ---------------------------------------------------------------------------
// Main parse.
// ---------------------------------------------------------------------------
function parse(rawInput) {
  const result = {
    task: '',
    n: null,
    mode: null,   // 1 = single, 2 = two pass
    z: 1,
    assignment: null,
    needsGate: false,
    repoMode: false, // P0 (plan §4): false => today's self-contained tournament unchanged
    baseRef: null,   // P0: resolved to a pinned sha by the SKILL; the parser records null
    size: null,      // manual task-size override (short|medium|long); null => SKILL estimates
    // Plan/Implement round split (2026-07-03). `implement` gates rounds 3–4;
    // planAssignment is the plan-phase pool (== assignment, kept for clarity);
    // implementAssignment is the implement-phase pool (rounds 3–4), null when
    // implement is off.
    implement: false,
    planAssignment: null,
    implementAssignment: null,
  };
  const errors = [];
  const oversizedNs = new Set();
  const pushNMaxError = (n) => {
    if (!oversizedNs.has(n)) {
      errors.push(nMaxError(n));
      oversizedNs.add(n);
    }
  };

  if (typeof rawInput !== 'string') {
    errors.push('Input must be a string.');
    result.errors = errors;
    return result;
  }
  const msg = rawInput;

  // --- 1. Find the marker (sigil preferred, else prose). ---
  const sigil = SIGIL_RX.exec(msg);
  const feSigil = FE_SIGIL_RX.exec(msg);
  const prose = PROSE_RX.exec(msg);

  // @@FE and @@JE in ONE message is ambiguous (which engine?) — NEVER guess.
  if (sigil && feSigil) {
    errors.push('Both @@FE and @@JE markers found in one message. Use exactly one engine sigil.');
    result.errors = errors;
    return result;
  }

  let marker = null;       // { kind, index, length, nSeg, mSeg, zSeg }
  if (sigil) {
    marker = {
      kind: 'sigil',
      index: sigil.index,
      length: sigil[0].length,
      nSeg: intSeg(sigil[1]),
      mSeg: intSeg(sigil[2]),
      zSeg: intSeg(sigil[3]),
      // raw text after '@@JE' (for positional-skip detection)
      rawTail: sigil[0],
    };
  } else if (feSigil) {
    // @@FE (Fable Engine, composeOnly). fe-only output fields are added HERE so
    // every @@JE / prose parse stays byte-identical to before.
    marker = {
      kind: 'fe',
      index: feSigil.index,
      length: feSigil[0].length,
      nSeg: intSeg(feSigil[1]),
      mSeg: intSeg(feSigil[2]),
      zSeg: intSeg(feSigil[3]),
      rawTail: feSigil[0],
    };
    result.fe = true;
    result.composeOnly = true;
    result.feDefaultPool = false; // true only when the bare-@@FE default pool applies
  } else if (prose) {
    marker = {
      kind: 'prose',
      index: prose.index,
      length: prose[0].length,
      nSeg: intSeg(prose[1]),
      mSeg: intSeg(prose[2]),
      zSeg: intSeg(prose[3]),
      rawTail: prose[0],
    };
  }

  if (!marker) {
    // No marker at all. Caller decides whether to trigger on plain language;
    // here we just report no usable invocation.
    errors.push('No @@JE sigil or "joust:N" marker found.');
    result.errors = errors;
    return result;
  }

  // --- 2. Detect positional skips (empty middle segment). ---
  // A skip looks like '@@JE:5::3' — N present, M EMPTY, Z present. Because we
  // captured \d* per segment, an empty-but-colon-supplied M shows as
  // present:false on mSeg while zSeg is present:true. We must distinguish
  // "M omitted, Z omitted" (fine) from "M skipped, Z given" (forbidden).
  // Count the colon groups actually written in the marker text.
  const colonSegs = countColonSegments(marker.rawTail);
  // colonSegs: how many ':' separators were written. If a later segment has a
  // value but an earlier one is empty -> positional skip.
  if (marker.kind === 'fe') {
    // @@FE takes ONLY an optional N. Any second colon segment (M or Z, even an
    // empty one) is rejected loudly — like a positional skip — never guessed at.
    if (colonSegs >= 2) {
      errors.push(
        'M/Z segments are not valid for @@FE: "' + marker.rawTail.trim() +
        '". @@FE is single-pass compose-only and takes only an optional N (e.g. @@FE:6). ' +
        'Use @@JE:N:M:Z for passes / grand loops.'
      );
    }
  } else {
    if (marker.zSeg.present && !marker.mSeg.present && marker.zSeg.value !== null) {
      errors.push(
        'Positional skip not allowed: "' + marker.rawTail.trim() +
        '". To set Z with default M, write @@JE:N:1:Z (e.g. @@JE:5:1:3).'
      );
    }
    if (marker.mSeg.present && !marker.nSeg.present && marker.nSeg.value === null &&
        marker.kind === 'sigil' && colonSegs >= 2 && isEmptyFirstColonSeg(marker.rawTail)) {
      // '@@JE::2' — empty N is allowed ONLY if a prose spec will supply N; we
      // record nothing here and let the conflict/needsGate logic decide later.
    }
  }

  // --- 3. Extract task = text on BOTH sides of the marker (D-0007). ---
  // The task used to be ONLY the pre-marker text, so the habitual marker-first
  // form '@@JE <spec>, <task>' silently dropped the entire task (task:""). Capture
  // the text before AND after the marker; stripAll() removes the spec / keywords /
  // prose directives from the combined remainder (it re-scans the text it is given,
  // so a post-marker spec is stripped just as well as a pre-marker one).
  let preMarker = msg.slice(0, marker.index);
  let postMarker = msg.slice(marker.index + marker.length);

  // --- 4. M / mode (sigil :M, then a MARKER-ADJACENT prose pass directive). ---
  let mode = 1;
  let mSigil = null;                 // a VALID sigil M (1 or 2), else null
  if (marker.kind !== 'fe' && marker.mSeg.present) {
    if (marker.mSeg.value === 1) { mode = 1; mSigil = 1; }
    else if (marker.mSeg.value === 2) { mode = 2; mSigil = 2; }
    else {
      errors.push(
        'Invalid pass count M=' + (marker.mSeg.value === null ? '(empty)' : marker.mSeg.value) +
        '. Only 1 (single) or 2 (two pass) are valid.'
      );
      mode = null;
    }
  }
  // Prose pass directive (D-0006): recognised ONLY when adjacent to the marker
  // (after it, else before it). The matched phrase is removed FROM THAT SIDE so it
  // never leaks into the task — and an adjective elsewhere in the task is left
  // intact. Sigil wins; a sigil-vs-prose disagreement is a loud error; prose alone
  // sets the mode.
  const pmAfter = PASS_AFTER_RX.exec(postMarker);
  const pmMatch = pmAfter || PASS_BEFORE_RX.exec(preMarker);
  if (pmMatch) {
    const mp = /two/i.test(pmMatch[1]) ? 2 : 1;   // 'two'->2, 'single'/'one'->1
    if (pmAfter) postMarker = postMarker.replace(PASS_AFTER_RX, ' ');
    else preMarker = preMarker.replace(PASS_BEFORE_RX, ' ');
    if (marker.kind === 'fe') {
      // @@FE is single-pass compose-only: a prose 'two pass' is the M=2 spelling
      // and is just as invalid as a sigil :2. 'single'/'one pass' is redundant
      // but harmless (mode is already 1) — stripped, no error.
      if (mp === 2) {
        errors.push('"two pass" is not valid with @@FE — @@FE is single-pass compose-only. ' +
          'Use @@JE:N:2 for a two-pass tournament.');
      }
    } else if (mSigil != null) {
      if (mSigil !== mp) {
        errors.push('Pass-count conflict: sigil M=' + mSigil + ' but prose says "' +
          pmMatch[1].toLowerCase() + ' pass" (M=' + mp + '). State the pass count once.');
      }
    } else if (mode !== null) {
      mode = mp;   // no (valid) sigil M -> the adjacent prose directive sets the mode
    }
  }
  result.mode = mode;

  // --- 4b. Repo-mode keywords (marker-adjacent; plan §4). ---
  // Stripped at the source side (like the pass directive above) so the keyword never
  // reaches `task`, and so an ordinary 'anchored'/'self-contained' in the body is left
  // intact. Opt-out (--no-repo / self-contained) wins over opt-in; the Z>=2 default is
  // applied later in section 5b.
  let repoMode = false;
  let repoForcedOff = false;
  if (REPO_ANCHORED_AFTER_RX.test(postMarker)) {
    repoMode = true;
    postMarker = postMarker.replace(REPO_ANCHORED_AFTER_RX, ' ');
  } else if (REPO_ANCHORED_BEFORE_RX.test(preMarker)) {
    repoMode = true;
    preMarker = preMarker.replace(REPO_ANCHORED_BEFORE_RX, ' ');
  }
  if (NO_REPO_AFTER_RX.test(postMarker)) {
    repoForcedOff = true;
    postMarker = postMarker.replace(NO_REPO_AFTER_RX, ' ');
  } else if (NO_REPO_BEFORE_RX.test(preMarker)) {
    repoForcedOff = true;
    preMarker = preMarker.replace(NO_REPO_BEFORE_RX, ' ');
  }

  // --- 4c. Task-size override (short|medium|long; dynamic-limits feature). ---
  // Marker-adjacent, stripped at its source side (same D-0006 discipline as the pass
  // and repo-mode keywords) so it never leaks into the task and an ordinary size word
  // in the body is left intact. AFTER form requires a clause boundary after the word.
  // When absent, size stays null and the SKILL ESTIMATES short/medium/long itself.
  const szAfter = SIZE_AFTER_RX.exec(postMarker);
  const szMatch = szAfter || SIZE_BEFORE_RX.exec(preMarker);
  if (szMatch) {
    result.size = canon(szMatch[1]); // short | medium | long
    if (szAfter) postMarker = postMarker.replace(SIZE_AFTER_RX, ' ');
    else preMarker = preMarker.replace(SIZE_BEFORE_RX, ' ');
  }

  // --- 4d. Implement keyword (marker-adjacent; plan/implement round split). ---
  // Enables the implement rounds (3–4). Stripped at its source side (same D-0006
  // discipline as the pass / repo / size keywords) so an ordinary 'implement …' in the
  // task body is left intact. A phase-scoped 'Implement:' spec ALSO enables the
  // rounds and is resolved in section 7 (`implementEnabled` there ORs both signals).
  let implementKw = false;
  const imAfter = IMPLEMENT_AFTER_RX.exec(postMarker);
  if (imAfter) { implementKw = true; postMarker = postMarker.replace(IMPLEMENT_AFTER_RX, ' '); }
  else if (IMPLEMENT_BEFORE_RX.test(preMarker)) { implementKw = true; preMarker = preMarker.replace(IMPLEMENT_BEFORE_RX, ' '); }

  // Task = both sides of the marker (D-0007), with the adjacent pass directive (if
  // any) already removed; stripAll() removes the spec / keywords / other directives.
  let task = preMarker + ' ' + postMarker;

  // --- 5. Z (grand loops, Feature 1 — now a REAL parameter). ---
  // Default 1 == today's behaviour exactly. Z>=2 is VALID and flows on to the
  // SKILL's grand-loop authorization + driver (NO "not yet implemented" stop).
  // Z>Z_MAX is a LOUD error that echoes the offending Z and nulls n/assignment.
  let z = 1;
  if (marker.kind !== 'fe' && marker.zSeg.present) {
    if (marker.zSeg.value === null || marker.zSeg.value < 1) {
      errors.push('Invalid Z=' + (marker.zSeg.value === null ? '(empty)' : marker.zSeg.value) +
        '. Z must be an integer >= 1.');
    } else if (marker.zSeg.value > Z_MAX) {
      // Runaway safety. Echo the offending Z (NOT silently reset to 1) so a
      // caller that ignores errors[] cannot mistake it for a valid Z=1 run.
      z = marker.zSeg.value;
      errors.push(
        'Z=' + marker.zSeg.value + ' exceeds the grand-loop ceiling Z_MAX=' + Z_MAX +
        '. This is a runaway-safety bound (not a cost cap). Split into batches: ' +
        'run several invocations with Z<=' + Z_MAX + ' instead (e.g. ' +
        '@@JE:N:M:' + Z_MAX + ' now, then another @@JE:N:M:' + (marker.zSeg.value - Z_MAX) + ' later).'
      );
    } else {
      z = marker.zSeg.value;
      // z in [1..Z_MAX] is valid. z>=2 simply flows on; the SKILL gates it.
    }
  }
  // A prose '<n> grand loop[s]' phrase is an alternative spelling of Z. Resolve it
  // here, AFTER the sigil Z, mirroring the N marker-vs-prose precedence: the sigil
  // :Z wins, and a disagreement between sigil :Z and prose is surfaced as an error
  // (never silently guessed). When only the prose form is present it supplies Z;
  // the same Z_MAX ceiling and >=1 floor apply. (GRAND_LOOP_RX is evaluated against
  //  msg, which exists here; section 7 re-strips it from the spec-scan copy.)
  const __grand = GRAND_LOOP_RX.exec(msg);
  if (__grand && marker.kind === 'fe') {
    // The prose grand-loop phrase is the Z spelling — invalid for @@FE like the
    // sigil :Z. (The phrase is still stripped from the spec scan / task below.)
    errors.push('grand loops (Z) are not valid with @@FE — @@FE is a single compose round. ' +
      'Use @@JE:N:M:Z for grand loops.');
  } else if (__grand) {
    const zp = intSeg(__grand[1]).value;
    if (zp === null || zp < 1) {
      errors.push('Invalid grand-loop count "' + __grand[0].trim() +
        '". The grand-loop count must be an integer >= 1.');
    } else if (marker.zSeg.present && marker.zSeg.value !== null && marker.zSeg.value !== zp) {
      // Both a sigil :Z and a prose 'N grand loop[s]' given and they disagree.
      errors.push('Grand-loop count conflict: sigil Z=' + marker.zSeg.value +
        ' but prose says ' + zp + ' grand loop(s). State Z once.');
    } else if (!marker.zSeg.present) {
      // Only the prose form sets Z — apply the same ceiling/floor as the sigil.
      if (zp > Z_MAX) {
        z = zp;
        errors.push(
          'Z=' + zp + ' exceeds the grand-loop ceiling Z_MAX=' + Z_MAX +
          '. This is a runaway-safety bound (not a cost cap). Split into batches: ' +
          'run several invocations with Z<=' + Z_MAX + ' instead.'
        );
      } else {
        z = zp;
      }
    }
  }
  result.z = z;

  // --- 5b. Resolve repoMode (plan §4): Z>=2 default + opt-out. ---
  // Grand-loop mode (Z>=2) is the only mode that writes to a real repo, so
  // repo-anchored mode defaults ON for Z>=2 unless the user forced it off. All Z<2 runs
  // (and explicit opt-outs) stay repoMode:false == today, byte-for-byte. Guarded by
  // z<=Z_MAX so an already-invalid over-ceiling run does not flip the flag.
  if (!repoForcedOff && z >= 2 && z <= Z_MAX) repoMode = true;
  if (repoForcedOff) repoMode = false;
  result.repoMode = repoMode;
  result.baseRef = null; // the parser is mode-only; the SKILL pins the sha at run time
  // Fail-closed validation: repo-anchored mode needs a PR target, which only Z>=2
  // provides. The unsafe combination (repoMode && z<2) is made unrunnable by
  // construction — it becomes an errors[] entry and section 11 then nulls n/assignment,
  // exactly like the over-ceiling-Z error in section 5. repoMode is PRESERVED (like an
  // over-ceiling z) so the message can name the offending mode.
  if (repoMode && z < 2) {
    errors.push(
      'repo-anchored mode requires Z>=2; it has no PR target at Z=1. ' +
      'Use @@JE:N:M:Z with Z>=2, or drop the repo-anchored keyword.'
    );
  }

  // --- 6. Sigil/marker N. ---
  let nMarker = null;
  if (marker.nSeg.present) {
    if (marker.nSeg.value === null) {
      // explicit empty N segment (e.g. '@@JE::2') — N must come from prose.
      nMarker = null;
    } else {
      nMarker = marker.nSeg.value;
    }
  }
  if (nMarker != null && nMarker > N_MAX) {
    pushNMaxError(nMarker);
  }

  // --- 7. Prose model spec scan + Top Mixed. ---
  // Work against the message (spec/keyword can appear anywhere). FIRST strip the
  // prose '<n> grand loop[s]' directive (its Z was resolved in section 5): the
  // literal word 'grand' would otherwise reach the model-token recogniser and
  // error. Build a SCAN COPY with that phrase removed and run EVERY downstream
  // scan (locateSpec / locateUnknownNearConnector / Top-Mixed) against the copy,
  // so the stray token never reaches the recogniser. (Task text is cleaned in
  // stripAll.)
  const scanMsg = GRAND_LOOP_RX.test(msg) ? msg.replace(GRAND_LOOP_RX, ' ') : msg;

  let assignment = null;
  let preset = null;
  let nSpec = null;

  const topMixedPresent = TOP_MIXED_RX.test(scanMsg);
  let topMixedLeadCount = null;
  const tmLead = TOP_MIXED_LEADCOUNT_RX.exec(scanMsg);
  if (tmLead) topMixedLeadCount = parseInt(tmLead[1], 10);

  // Locate a recognised-item spec (not Top Mixed).
  const spec = locateSpec(scanMsg);

  // Connector-licensed unknown tokens (loud rejection of typos).
  const unknownHits = locateUnknownNearConnector(scanMsg);

  // --- 7a. Phase-scoped specs + implement flag (plan/implement round split). ---
  // Phase labels ('Plan:' / 'Implement:') split the pool per phase; a phase branch
  // below takes precedence over the single-pool Top-Mixed/spec path. The implement
  // rounds turn on from the marker-adjacent `implement` keyword OR a present
  // 'Implement:' label. Omitted pools fall back to the design defaults.
  const phaseSpecs = extractPhaseSpecs(scanMsg);
  const implementEnabled = implementKw || (phaseSpecs && phaseSpecs.implement !== null);
  result.implement = !!implementEnabled;
  // Resolve the implement-phase pool (rounds 3–4). Explicit Implement: spec wins;
  // otherwise, when the implement rounds are on, the small strong default pool fills it.
  let implementAssignment = null;
  const implExp = phaseSpecs && phaseSpecs.implement;
  if (implExp && (implExp.any || implExp.unknowns.length || implExp.overflows.length)) {
    if (implExp.overflows.length) { for (const o of implExp.overflows) pushNMaxError(o.total); }
    else if (implExp.unknowns.length) {
      errors.push('Unrecognised model token(s) in Implement: spec: ' +
        implExp.unknowns.map(u => '"' + u + '"').join(', ') + '. Re-state the spec.');
    } else {
      implementAssignment = implExp.assignment;
    }
  } else if (implementEnabled) {
    implementAssignment = IMPLEMENT_DEFAULT_POOL.slice();
  }
  result.implementAssignment = implementAssignment;

  if (phaseSpecs) {
    // Phase-scoped path: the PLAN pool drives assignment + nSpec (the per-round N).
    // Explicit Plan: spec wins; an omitted Plan pool falls back to the wide default.
    preset = null;
    const planExp = phaseSpecs.plan;
    if (planExp && (planExp.any || planExp.unknowns.length || planExp.overflows.length)) {
      if (planExp.overflows.length) {
        for (const o of planExp.overflows) pushNMaxError(o.total);
        assignment = null; nSpec = null;
      } else if (planExp.unknowns.length) {
        errors.push('Unrecognised model token(s) in Plan: spec: ' +
          planExp.unknowns.map(u => '"' + u + '"').join(', ') + '. Re-state the spec (a dropped token would silently change N).');
        assignment = null; nSpec = null;
      } else {
        assignment = planExp.assignment; nSpec = planExp.count;
      }
    } else {
      // No explicit Plan pool -> the wide default (N=10).
      assignment = PLAN_DEFAULT_POOL.slice(); nSpec = PLAN_DEFAULT_POOL.length;
    }
  } else if (topMixedPresent) {
    preset = 'top-mixed';
    // N for top mixed: leading count, else sigil/marker N.
    let tmN = topMixedLeadCount != null ? topMixedLeadCount : nMarker;
    if (tmN != null) {
      // If BOTH a leading count and a marker N are present and disagree -> conflict.
      if (topMixedLeadCount != null && nMarker != null && topMixedLeadCount !== nMarker) {
        result.conflict = {
          markerN: nMarker,
          specN: topMixedLeadCount,
          reason: 'Top Mixed leading count (' + topMixedLeadCount + ') disagrees with marker N (' + nMarker + ').',
        };
        result.assignment = null;
        result.n = null;
        result.preset = preset;
        // strip & set task, then return below.
        result.task = stripAll(task, spec, msg, marker).trim();
        if (errors.length) result.errors = errors;
        return result;
      }
      if (tmN < 2) {
        errors.push('Top Mixed needs N >= 2 (got N=' + tmN + ').');
      } else if (tmN > N_MAX) {
        pushNMaxError(tmN);
        assignment = null;
        nSpec = null;
      } else {
        assignment = topMixedAssignment(tmN);
        nSpec = tmN;
      }
    } else {
      // Top Mixed with no N anywhere -> need the gate to supply N.
      result.needsGate = true;
    }
  } else if (spec.found) {
    const exp = expandSpec(spec.raw);
    // Merge in any connector-licensed unknowns that the recognised scan missed.
    const allUnknowns = exp.unknowns.slice();
    for (const h of unknownHits) {
      const norm = normaliseModel(h.tok);
      if (!norm && !allUnknowns.includes(h.tok)) allUnknowns.push(h.tok);
    }
    if (exp.overflows.length) {
      for (const o of exp.overflows) pushNMaxError(o.total);
      assignment = null;
      nSpec = null;
    }
    if (allUnknowns.length) {
      errors.push(
        'Unrecognised model token(s) in spec: ' + allUnknowns.map(u => '"' + u + '"').join(', ') +
        '. Known: opus, sonnet, haiku, glm[-5.2/5.1/4.7/4.5-air], codex[-low/medium/high/xhigh], ' +
        'minimax-m3, grok[-build]/grok-composer-2.5-fast, or a live local id. Re-state the spec (a dropped token would silently change N).'
      );
      assignment = null;
      nSpec = null;
    } else if (!exp.overflows.length && exp.count > 0) {
      assignment = exp.assignment;
      nSpec = exp.count;
    }
  } else {
    // No spec / no top-mixed. But still check for a lone connector-licensed
    // unknown (e.g. 'run with 1 gpt4 @@JE:5') so we reject loudly.
    const realUnknowns = [];
    for (const h of unknownHits) {
      const norm = normaliseModel(h.tok);
      if (!norm) realUnknowns.push(h.tok);
    }
    if (realUnknowns.length) {
      errors.push(
        'Unrecognised model token(s) near a connector: ' +
        realUnknowns.map(u => '"' + u + '"').join(', ') +
        '. If this is a model spec, use a known token; otherwise it was ignored.'
      );
      // Do not set assignment; if no marker N either, gate kicks in below.
    }
  }

  // --- 8. Explicit-N-vs-prose conflict (the one place we must not guess). ---
  if (nMarker != null && nSpec != null && nMarker !== nSpec) {
    result.conflict = {
      markerN: nMarker,
      specN: nSpec,
      reason: 'Marker says N=' + nMarker + ' but the prose spec sums to ' + nSpec + '.',
    };
    result.n = null;
    result.assignment = null;
    if (preset) result.preset = preset;
    result.task = stripAll(task, spec, msg, marker).trim();
    if (errors.length) result.errors = errors;
    return result;
  }

  // --- 9. Resolve N + assignment + gate. ---
  let n = nSpec != null ? nSpec : nMarker;

  // @@FE default pool: a bare @@FE (no N, no spec, no top-mixed-needs-N, no
  // errors so far) runs the skill's documented wide default pool (N=10) — the
  // interactive gate is NOT used for @@FE. feDefaultPool:true tells the SKILL
  // the default applied. An explicit @@FE:N with no spec keeps assignment:null
  // (the SKILL resolves the pool), exactly like @@JE:N.
  if (marker.kind === 'fe' && n == null && assignment == null &&
      !result.needsGate && !errors.length) {
    assignment = FE_DEFAULT_POOL.slice();
    n = FE_DEFAULT_POOL.length;
    result.feDefaultPool = true;
  }

  if (n == null && !result.needsGate) {
    // Bare @@JE with no spec, no marker N, no top-mixed-needs-N -> interactive gate.
    result.needsGate = true;
  }

  // Validate N range when we do have one.
  if (n != null) {
    if (n < 2) {
      errors.push('N must be an integer >= 2 (got N=' + n + ').');
      n = null;
      assignment = null;
    } else if (n > N_MAX) {
      pushNMaxError(n);
      n = null;
      assignment = null;
    }
  }

  result.n = n;
  result.assignment = assignment;
  result.planAssignment = assignment; // the plan pool IS the per-round attempt set
  if (preset) result.preset = preset;

  // --- 10. Build the task text (strip marker + spec + top-mixed keyword). ---
  result.task = stripAll(task, spec, msg, marker).trim();

  // --- 11. On any error, null out n/assignment so a careless caller can't run
  //         the wrong tournament. (mode/z/task/errors stay for the message —
  //         z is deliberately PRESERVED, including an over-ceiling Z, so the
  //         message can name the offending value.) ---
  if (errors.length) {
    result.errors = errors;
    result.n = null;
    result.assignment = null;
    result.planAssignment = null;
    result.implementAssignment = null;
  }

  return result;
}

// Count how many ':' separators were written in the marker tail.
function countColonSegments(rawTail) {
  const m = rawTail.match(/:/g);
  return m ? m.length : 0;
}

function isEmptyFirstColonSeg(rawTail) {
  // matches '@@je::' (first segment empty)
  return /@@je\s*:\s*:/i.test(rawTail);
}

// Build the task text: take everything before the marker, then remove any spec
// slice and top-mixed keyword that fell within it, and strip a trailing
// separator colon. The spec/keyword are searched within the pre-marker text.
function stripAll(preMarkerTask, spec, fullMsg, marker) {
  let t = preMarkerTask;

  // Remove a prose '<n> grand loop[s]' directive (it carried Z, not task content).
  t = t.replace(/(\d+)\s*grand\s+loops?\b/ig, ' ');

  // (D-0006: the prose pass directive is stripped at its source in parse() — only
  // when marker-adjacent — so it is NOT stripped here, where it could not be told
  // apart from an adjective like 'two-pass compiler' in the task text.)

  // Remove top-mixed phrases (with optional leading count) from the task.
  t = t.replace(/(\d+\s*)?top[\s-]*mix(?:ed)?/ig, ' ');

  // Remove phase-scoped spec labels ('Plan:' / 'Implement:') — the directive markers
  // for the plan/implement round split. The model chains that followed each label are
  // stripped by the chain regex below; only the bare labels need removing here.
  t = t.replace(/\bplan\s*:/ig, ' ').replace(/\bimplement\s*:/ig, ' ');

  // Remove recognised model-spec chains from the task. Re-run the chain regex on
  // the task text (the spec may sit on EITHER side of the marker — D-0007).
  const chainRx = new RegExp(
    '(?:\\bwith\\b|\\busing\\b)?\\s*' +
    '(' + COUNT_NC + MODEL_TOKEN_RX + ')' +
    '(?:\\s*(?:,\\s*and|,|and)\\s*' + COUNT_NC + MODEL_TOKEN_RX + ')*',
    'ig'
  );
  t = t.replace(chainRx, ' ');

  // Collapse whitespace, then strip dangling separators/connectors on BOTH ends —
  // combining both sides of the marker (D-0007) can leave a LEADING comma/connector
  // (e.g. '@@JE 2 opus, fix the bug' -> ', fix the bug').
  // NB: strip only leading SEPARATORS (a comma left when a stripped spec sat right
  // after the marker), NOT a leading connector word — a spec's own 'with'/'using'
  // is already absorbed by the chain regex above, so stripping a leading
  // 'with'/'and'/'using' here would only eat a real task word (e.g. '@@JE:3 with
  // great care, refactor' -> must keep 'with great care, refactor'). (D-0007)
  t = t.replace(/\s+/g, ' ')
       .replace(/^[\s,:]+/, '')
       .replace(/[\s,]+(with|using|and)\s*$/i, '')
       .replace(/\s*[:,]\s*$/, '')
       .replace(/\s+(with|using)\s*$/i, '')
       .trim();
  return t;
}

// ---------------------------------------------------------------------------
// Exports (for the test file).
// ---------------------------------------------------------------------------
export {
  parse,
  normaliseModel,
  topMixedAssignment,
  expandSpec,
  locateSpec,
  extractPhaseSpecs,
  sizeProfile,
  NORMALISER,
  TOP_MIXED_POOL,
  PLAN_DEFAULT_POOL,
  IMPLEMENT_DEFAULT_POOL,
  FE_DEFAULT_POOL,
  SIZE_PROFILES,
  Z_MAX,
  N_MAX,
};

// ---------------------------------------------------------------------------
// CLI guard (self-printing). Only runs when invoked directly.
// ---------------------------------------------------------------------------
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, '')));
  } catch { return false; }
})();

if (isMain) {
  // Subcommand: `--help` prints the grammar/usage (exit 0).
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    process.stdout.write([
      'usage: node je-parse.mjs "<raw user message>"',
      '       node je-parse.mjs --size <short|medium|long>',
      '       node je-parse.mjs --help',
      '',
      'Markers (exactly one per message):',
      '  @@JE[:N][:M[:Z]]   tournament — N attempts (>=2), M passes (1|2), Z grand loops (<=' + Z_MAX + ')',
      '  joust:N[:M[:Z]]    prose spelling of the @@JE marker',
      '  @@FE[:N]           Fable Engine (composeOnly) — N drafts (>=2); M/Z are INVALID.',
      '                     Bare @@FE (no N, no spec) = default pool ' +
        FE_DEFAULT_POOL.join(',') + ' (N=' + FE_DEFAULT_POOL.length + '), feDefaultPool:true.',
      '',
      'Shared grammar (both sigils, marker-adjacent unless noted):',
      '  prose model spec   "2 opus, 2 glm 5.2, 1 codex high" — sum supplies/overrides N (anywhere)',
      '  size word          short | medium | long (marker-adjacent, stripped from the task)',
      '  N ceiling          N_MAX=' + N_MAX + '; all failures land in errors[] with n/assignment nulled',
      '',
      'Output: JSON on stdout (see the header comment of this file for the field contract).',
    ].join('\n') + '\n');
    process.exit(0);
  }
  // Subcommand: `je-parse.mjs --size <short|medium|long>` prints just that size's
  // limit profile as JSON, so the SKILL can resolve the dynamic limits deterministically
  // (one source of truth) instead of hard-coding the numbers in the procedure text.
  if (process.argv[2] === '--size') {
    const prof = sizeProfile(process.argv.slice(3).join(' '));
    if (prof) {
      process.stdout.write(JSON.stringify(prof, null, 2) + '\n');
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({
      error: 'unknown size; expected one of: ' + Object.keys(SIZE_PROFILES).join(', '),
    }, null, 2) + '\n');
    process.exit(1);
  }
  const raw = process.argv.slice(2).join(' ');
  try {
    const out = parse(raw);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (e) {
    const out = { task: '', n: null, mode: null, z: 1, assignment: null,
                  repoMode: false, baseRef: null,
                  errors: ['internal parse error: ' + (e && e.message ? e.message : String(e))] };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}
