#!/usr/bin/env node
// =============================================================================
// je-bench.mjs — Joust Engine generation-throughput benchmark.
//
// Measures tokens/second for EVERY model the joust-engine system can call,
// on a COLD run (first call) and a HOT run (an immediate second call), and
// reports cold tok/s, hot tok/s, and the delta.
//
// It uses the SAME nested-`claude`/`codex` invocation mechanics, env vars, auth
// conventions, and portable perl-alarm timeout as the bundled runner scripts
// (bin/glm-run.sh / local-run.sh / codex-run.sh / minimax-run.sh), but calls
// them DIRECTLY here (rather than through the runner scripts) so each call's
// wall-time and the provider's REAL output-token count can be captured.
//
//   tok/s = output_tokens / generation_wall_seconds
//
// Token counts are the provider's OWN reported counts (NOT chars/4):
//   - claude-family (anthropic / glm / minimax): `claude -p --output-format
//     json --verbose` emits a JSON ARRAY of stream events; the final
//     type:"result" element carries usage.output_tokens. We parse defensively
//     (walk the whole structure, take the MAX output_tokens seen), never
//     `JSON.parse(stdout).usage`, never slice(indexOf('{')).
//   - local (omlx MLX): we hit the OpenAI-shaped /v1/chat/completions endpoint
//     directly and read usage.completion_tokens.
//   - codex (gpt-5.5): codex's token accounting is not reliably machine-
//     readable from `codex exec`, so codex is the ONE place where a chars/4
//     estimate (of the captured final message) is an explicitly-flagged
//     fallback (estimated:true). We still try the real token_count event first.
//
// HONEST MEASUREMENT NOTES (stated, not implied away):
//   - Every timed window is the WALL-CLOCK of the subprocess: it includes the
//     `claude`/`codex` CLI / agent startup overhead (and curl/HTTP setup for
//     local). So the reported tok/s is end-to-end throughput as the system
//     experiences it, NOT a pure decode rate.
//   - "COLD" means: for local MLX, a genuine model-load-into-memory cold start
//     (if the weights are not resident); for the HOSTED providers (anthropic /
//     glm / minimax / codex) it is connection/cache/route warmup, NOT a true
//     weight load. The HOT run is an immediate second identical call.
//   - The `claude` CLI has NO `--max-tokens` flag; output is bounded by the
//     prompt instruction AND CLAUDE_CODE_MAX_OUTPUT_TOKENS (a SOFT cap for the
//     claude-family providers). For local (raw HTTP) and codex we pass a hard
//     max-tokens where the API supports it.
// =============================================================================

import { spawnSync } from 'node:child_process'
import { mkdirSync, appendFileSync, existsSync, writeFileSync, unlinkSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

// security-sweep M9 (2026-07-07): the OMLX bearer token must NEVER ride in curl's argv — process
// listings (`ps -ef`, /proc/<pid>/cmdline) are world-readable, so a co-tenant could scrape it. Write
// the Authorization header to a 0600 curl config file consumed with -K, then unlink it. The config
// file is only readable by our own uid for the ~milliseconds the request is in flight.
function curlAuthed(baseArgv, bearer, spawnOpts) {
  const dir = mkdtempSync(join(tmpdir(), 'je-bench-'))
  const cfg = join(dir, 'curl.cfg')
  // curl config: `header = "<value>"`. A bearer token is an opaque credential with no `"`/`\`/newline
  // in any provider we support; strip those defensively so a malformed token can't break out of the
  // quoted value or inject a second directive.
  const safeBearer = String(bearer).replace(/["\\\r\n]/g, '')
  writeFileSync(cfg, `header = "Authorization: Bearer ${safeBearer}"\n`, { mode: 0o600 })
  try {
    return spawnSync('curl', ['-K', cfg, ...baseArgv], spawnOpts)
  } finally {
    try { unlinkSync(cfg) } catch { /* best effort */ }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(__dirname, '..')          // bin/.. = plugin root
const RESULTS_DIR = resolve(PLUGIN_ROOT, '.bench')
const RESULTS_FILE = resolve(RESULTS_DIR, 'results.jsonl')

// ----------------------------------------------------------------------------
// Benchmark PROFILES. A profile is a fixed, IDENTICAL prompt + output cap +
// timeouts applied to EVERY model, so tok/s is comparable WITHIN a profile.
// The profile name is stored on every result row so light/heavy histories never
// get mixed.
//
//   light (default) — a tiny ~200-word paragraph: a fast/cheap smoke of raw
//        throughput. Output cap is 2048, NOT a few hundred: an extended-thinking
//        model rejects a sub-1024 cap with `400 thinking.enabled.budget_tokens:
//        Input should be greater than or equal to 1024`. The old 256 cap is
//        exactly why haiku FAILED in the all-models sweep (dogfood D-0005); the
//        ~200-word prompt still keeps the actual decode small, the cap is only a
//        ceiling that must clear the thinking-budget floor.
//
//   heavy — a representative coding/agentic workload: a large fixed input
//        context (>5k input tokens) plus an instruction that elicits a long
//        structured deliverable (targets >5k decode tokens). Output cap 8192,
//        longer timeouts. The light profile's few-hundred-token decode is not
//        enough to characterise throughput on real coding-sized inputs/outputs.
// ----------------------------------------------------------------------------
const LIGHT_PROMPT =
  'Write exactly one paragraph (about 200 words, no lists, no headings, no code) ' +
  'explaining what a hash map is and why its average-case lookup is O(1). ' +
  'Stop after the single paragraph. Do not ask any questions; do not add anything else.'

// Deterministic, self-contained ~7k-token "codebase" used as the heavy-profile
// input context so every model receives byte-identical >5k-token input.
function buildHeavyContext() {
  const ops = [
    'get', 'set', 'delete', 'has', 'merge', 'scan', 'expire', 'touch', 'incr', 'decr',
    'flush', 'keys', 'values', 'entries', 'size', 'clear', 'rename', 'copy', 'dump', 'load',
    'lock', 'unlock', 'watch', 'unwatch', 'append', 'prepend', 'trim', 'slice', 'index', 'compact',
  ]
  const header =
`/* ============================================================================
 * Module under review: kvstore.js — an in-memory key/value store with TTL
 * expiry, counters, range scans, optimistic locking, and change watches.
 * (Synthetic, self-contained input context for the heavy benchmark profile;
 *  intentionally sized so the prompt exceeds 5,000 input tokens.)
 * ========================================================================== */
function currentTime() { return Date.now() }
`
  const blocks = ops.map((op, i) =>
`// --- ${op}Handler -------------------------------------------------------------
// Handles the "${op}" operation against the backing map. Validates the key,
// reconciles the TTL index, updates metrics, and notifies any registered watch
// callbacks. Known edge cases to consider during review: an empty or null key;
// an entry that expired exactly at \`now\`; concurrent modification while a scan
// is iterating; counter overflow past Number.MAX_SAFE_INTEGER; a watch callback
// that throws and must not abort the operation; and re-entrancy when ${op}
// triggers another ${ops[(i + 1) % ops.length]} on the same store.
function ${op}Handler(store, key, value, opts = {}) {
  if (key == null || key === '') throw new Error('${op}: key required')
  const now = opts.now != null ? opts.now : currentTime()
  const entry = store.map.get(key)
  if (entry && entry.expiresAt && entry.expiresAt <= now) {
    store.map.delete(key); store.metrics.expired = (store.metrics.expired || 0) + 1
  }
  const before = store.map.size
  const result = compute_${op}(store, key, value, now, opts)   // operation-specific body
  if (store.map.size !== before) store.dirty = true
  store.metrics.${op} = (store.metrics.${op} || 0) + 1
  for (const w of store.watches.get(key) || []) {
    try { w({ op: '${op}', key, value, now }) } catch (e) { store.metrics.watchErrors++ }
  }
  return result
}`)
  return header + '\n' + blocks.join('\n\n') + '\n'
}

const HEAVY_PROMPT =
  buildHeavyContext() + '\n\n' +
  'You are a senior engineer reviewing the module above. Produce an EXHAUSTIVE ' +
  'response containing ALL of the following IN FULL — do not truncate, abbreviate, ' +
  'summarise, or defer with "...":\n' +
  '1. A function-by-function code review: for EVERY handler, name a likely bug or ' +
  'edge case, give its time and space complexity, and propose one concrete fix.\n' +
  '2. A COMPLETE refactored rewrite of EVERY function, each with a full docstring.\n' +
  '3. A comprehensive unit-test suite with several cases per function.\n' +
  '4. A closing rationale explaining the most important changes and trade-offs.\n' +
  'Keep going until all four sections are fully written; do not stop early and do ' +
  'not ask any questions.'

const PROFILES = {
  light: { name: 'light', prompt: LIGHT_PROMPT, maxOutputTokens: 2048, defaultTimeoutSecs: 240, localTimeoutSecs: 600 },
  heavy: { name: 'heavy', prompt: HEAVY_PROMPT, maxOutputTokens: 8192, defaultTimeoutSecs: 600, localTimeoutSecs: 1200 },
}
const DEFAULT_PROFILE = 'light'

// Light-profile timeouts kept as named constants for the --help text.
const DEFAULT_TIMEOUT_SECS = PROFILES.light.defaultTimeoutSecs
const LOCAL_TIMEOUT_SECS = PROFILES.light.localTimeoutSecs   // a cold MLX weight-load can be slow

// ----------------------------------------------------------------------------
// CLI args.
//   --models all                 benchmark every callable model (local discovered live)
//   --models <sel>[,<sel>...]    a custom subset (see selection grammar below)
//   --profile light|heavy        workload size (default light). heavy = >5k-token
//                                input context + long-output task (>5k decode).
//   --heavy / --light            shorthand for --profile heavy / --profile light
//   --list                       dry-run: print what WOULD be benchmarked, make no calls
//   --timeout <secs>             override the default per-call timeout
//   --help
//
// SELECTION GRAMMAR (comma-separated; whitespace ignored; de-duped):
//   all                          -> every callable model across every provider
//   <provider>                   -> every model of that provider
//                                   providers: anthropic | glm | local | codex | minimax | grok | claudex
//   <provider>:<id>              -> one specific model, e.g. glm:glm-5.1, codex:codex-high,
//                                   local:gemma-4-26b-a4b-it-8bit, anthropic:opus
//   <id>                         -> a bare id resolved against the known/discovered catalogue
//                                   (e.g. opus, glm-5.2, minimax-m3, codex-high, grok-build, a local id)
// Examples:
//   je-bench.mjs --models all
//   je-bench.mjs --models anthropic,glm
//   je-bench.mjs --models glm:glm-5.1,codex:codex-high,opus
//   je-bench.mjs --models local            # every locally-discovered MLX model
//   je-bench.mjs --list --models all       # show the plan, call nothing
// ----------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { models: 'all', list: false, timeout: null, help: false, profile: DEFAULT_PROFILE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--list' || a === '--dry-run') out.list = true
    else if (a === '--models' || a === '-m') out.models = argv[++i]
    else if (a === '--timeout') out.timeout = Number(argv[++i])
    else if (a === '--profile') out.profile = String(argv[++i] || '').toLowerCase()
    else if (a === '--heavy') out.profile = 'heavy'
    else if (a === '--light') out.profile = 'light'
    else if (a.startsWith('--models=')) out.models = a.slice('--models='.length)
    else if (a.startsWith('--timeout=')) out.timeout = Number(a.slice('--timeout='.length))
    else if (a.startsWith('--profile=')) out.profile = a.slice('--profile='.length).toLowerCase()
  }
  return out
}

const USAGE = `je-bench.mjs — Joust Engine throughput benchmark (cold vs hot tok/s)

Usage:
  je-bench.mjs [--models <selection>] [--profile light|heavy] [--list] [--timeout <secs>]

Options:
  --models <sel>   What to benchmark. Default: all. Comma-separated. See grammar.
  --profile <p>    Workload profile (default ${DEFAULT_PROFILE}). light = ~200-word paragraph
                   (cap ${PROFILES.light.maxOutputTokens}); heavy = >5k-token input context + long-output
                   task (cap ${PROFILES.heavy.maxOutputTokens}), to measure real coding-sized throughput.
                   Shorthand: --heavy / --light.
  --list           Dry-run: print the resolved plan and make NO model calls.
  --timeout <secs> Per-call wall-clock backstop (light default ${DEFAULT_TIMEOUT_SECS}/local ${LOCAL_TIMEOUT_SECS};
                   heavy default ${PROFILES.heavy.defaultTimeoutSecs}/local ${PROFILES.heavy.localTimeoutSecs}).
  --help           This help.

Selection grammar (comma-separated, de-duped):
  all                      every callable model (local list discovered live)
  <provider>               anthropic | glm | local | codex | minimax | grok | claudex
  <provider>:<id>          e.g. glm:glm-5.1, codex:codex-high, local:<omlx-id>, anthropic:opus
  <id>                     a bare id resolved against the catalogue (opus, glm-5.2, minimax-m3, codex-high, ...)

Results: appended to ${RESULTS_FILE}
         (append-only JSONL; one record per model per run; survives crashes).`

// ============================================================================
// Provider catalogues (static where the system pins them; local is dynamic).
// Each entry is a benchmark TARGET with: { provider, id (display), ...dispatch }.
// ============================================================================

// Anthropic — session's own auth (NO API-key env var). Dispatched via `claude`
// with --model <alias>. The alias resolves on the session's Anthropic provider.
const ANTHROPIC_MODELS = [
  { provider: 'anthropic', id: 'opus', alias: 'opus' },
  { provider: 'anthropic', id: 'sonnet', alias: 'sonnet' },
  { provider: 'anthropic', id: 'haiku', alias: 'haiku' },
]

// GLM (z.ai) — `claude` pointed at the z.ai Anthropic-compatible endpoint.
// Bearer auth via ANTHROPIC_AUTH_TOKEN=$ZAI_API_KEY (NOT x-api-key). The display
// id maps to a `claude --model` flag exactly as the runner/tournament do.
const GLM_MODELS = [
  { provider: 'glm', id: 'glm-5.2', flag: 'opus' },     // --model opus -> glm-5.2 (default-opus env)
  { provider: 'glm', id: 'glm-5.1', flag: 'glm-5.1' },  // passed through directly
  { provider: 'glm', id: 'glm-4.7', flag: 'sonnet' },
  { provider: 'glm', id: 'glm-4.5-air', flag: 'haiku' },
]

// Codex (OpenAI gpt-5.5) — pinned model, REASONING EFFORT is the axis. Auth from
// ~/.codex/auth.json (NO OPENAI_API_KEY env var injected).
const CODEX_MODELS = [
  { provider: 'codex', id: 'codex-low', effort: 'low' },
  { provider: 'codex', id: 'codex-medium', effort: 'medium' },
  { provider: 'codex', id: 'codex-high', effort: 'high' },
  { provider: 'codex', id: 'codex-xhigh', effort: 'xhigh' },
  // gpt-5.6 family (2026-07-15, issue #7 Arm A): model overrides the gpt-5.5 default; sol-high
  // is the engine's default codex seat (bare codex -> codex-sol, effort pinned high).
  { provider: 'codex', id: 'codex-sol', effort: 'high', model: 'gpt-5.6-sol' },
]

// MiniMax — one model, no --model flag (ANTHROPIC_MODEL pins MiniMax-M3). Bearer
// auth via ANTHROPIC_AUTH_TOKEN=$MINIMAX_API_KEY against the MiniMax endpoint.
const MINIMAX_MODELS = [
  { provider: 'minimax', id: 'minimax-m3' },
]

// Grok (xAI) — `grok` headless CLI. Auth from the OAuth session (~/.grok/auth.json) OR XAI_API_KEY
// (CI fallback); no env key injected (mirrors codex's ~/.codex/auth.json). TWO variants on a -m model axis.
const GROK_MODELS = [
  { provider: 'grok', id: 'grok-build', model: 'grok-build' },
  { provider: 'grok', id: 'grok-composer-2.5-fast', model: 'grok-composer-2.5-fast' },
]

// Claudex — `claude` pointed at a LOCAL CLIProxyAPI instance exposing the Anthropic API (/v1/messages)
// at its ROOT, serving OpenAI-family gpt-5.6 models (benchmark Arm B: Claude Code as the harness,
// gpt-5.6-* as the model; mirrors bin/claudex-run.sh). Bearer auth via the contents of a client-token
// FILE (JE_CLAUDEX_TOKEN_FILE, default ~/.config/cliproxyapi/client-token) — the token never lives in
// the ambient environment. Base url from JE_CLAUDEX_BASE_URL (default http://127.0.0.1:8317).
const CLAUDEX_MODELS = [
  { provider: 'claudex', id: 'gpt-5.6-sol', flag: 'gpt-5.6-sol' },
  { provider: 'claudex', id: 'gpt-5.6-terra', flag: 'gpt-5.6-terra' },
  { provider: 'claudex', id: 'gpt-5.6-luna', flag: 'gpt-5.6-luna' },
]

// ----------------------------------------------------------------------------
// Local (omlx MLX) discovery — DYNAMIC, fetched live from the omlx server.
// Degrades gracefully: if OMLX_AUTH_TOKEN is unset or the server is down, we
// return [] with a note rather than crashing.
// ----------------------------------------------------------------------------
function discoverLocalModels() {
  const tok = process.env.OMLX_AUTH_TOKEN
  if (!tok) return { models: [], note: 'OMLX_AUTH_TOKEN unset — local discovery skipped (export in ~/.zshrc and relaunch)' }
  const r = curlAuthed([
    '-s', '--max-time', '15',
    'http://127.0.0.1:8000/v1/models',
  ], tok, { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout) {
    return { models: [], note: `omlx server unreachable at 127.0.0.1:8000 (curl rc=${r.status}) — local discovery skipped` }
  }
  let ids = []
  try {
    const j = JSON.parse(r.stdout)
    ids = (j && Array.isArray(j.data) ? j.data : []).map(m => m && m.id).filter(Boolean)
  } catch {
    return { models: [], note: 'omlx /v1/models returned unparseable JSON — local discovery skipped' }
  }
  return {
    models: ids.map(id => ({ provider: 'local', id })),
    note: ids.length ? '' : 'omlx returned an empty model list',
  }
}

// ============================================================================
// Catalogue assembly + selection resolution.
// ============================================================================
const PROVIDERS = ['anthropic', 'glm', 'local', 'codex', 'minimax', 'grok', 'claudex']

function buildCatalogue() {
  const local = discoverLocalModels()
  const all = [
    ...ANTHROPIC_MODELS,
    ...GLM_MODELS,
    ...local.models,
    ...CODEX_MODELS,
    ...MINIMAX_MODELS,
    ...GROK_MODELS,
    ...CLAUDEX_MODELS,
  ]
  return { all, localNote: local.note }
}

// Resolve the --models selection string into a de-duped ordered list of targets.
function resolveSelection(sel, catalogue) {
  const tokens = String(sel || 'all').split(',').map(s => s.trim()).filter(Boolean)
  const picked = []
  const seen = new Set()
  const warnings = []
  const add = t => { const k = `${t.provider}:${t.id}`; if (!seen.has(k)) { seen.add(k); picked.push(t) } }

  for (const tk of tokens) {
    const low = tk.toLowerCase()
    if (low === 'all') { catalogue.forEach(add); continue }
    if (PROVIDERS.includes(low)) {
      const hits = catalogue.filter(t => t.provider === low)
      if (!hits.length) warnings.push(`provider "${low}" has no callable models (e.g. local not discovered)`)
      hits.forEach(add)
      continue
    }
    if (tk.includes(':')) {
      const [p, ...rest] = tk.split(':')
      const id = rest.join(':')
      const prov = p.toLowerCase()
      const hit = catalogue.find(t => t.provider === prov && t.id === id)
      if (hit) add(hit)
      else warnings.push(`no match for "${tk}" (provider:${prov}, id:${id})`)
      continue
    }
    // bare id — match against any provider's id
    const hits = catalogue.filter(t => t.id === tk)
    if (hits.length) hits.forEach(add)
    else warnings.push(`no match for bare id "${tk}"`)
  }
  return { picked, warnings }
}

// ============================================================================
// Defensive result extraction for the claude-family `--output-format json`.
// That output is a JSON ARRAY of stream events; the final type:"result" element
// carries usage.{output,input}_tokens plus is_error and a `result` string. We DO
// NOT do JSON.parse(stdout).usage — that is wrong for the real array output. We
// parse the array (or object, or line-by-line), then walk the whole structure
// recursively and collect, defensively:
//   - outputTokens  = MAX usage.output_tokens (cumulative final-result usage)
//   - inputTokens   = MAX (input_tokens + cache_read + cache_creation), i.e. the
//                     true prompt size whether or not the input was cached (the
//                     HOT call re-reads the same prompt from cache)
//   - isError       = the FINAL type:"result" element's is_error (NOT a whole-tree
//                     OR: an intermediate tool_result with is_error:true must not
//                     fail a completed run — that over-detection was a D-0005
//                     regression an adversarial review caught)
//   - resultText    = the result/error string from that final result element
// ============================================================================
function extractClaudeResult(stdout) {
  let root = null
  if (stdout && stdout.trim()) {
    try { root = JSON.parse(stdout) }
    catch {
      // line-by-line fallback (interleaved --verbose stream-json objects)
      const arr = []
      for (const line of stdout.split(/\r?\n/)) {
        const s = line.trim()
        if (!s || (s[0] !== '{' && s[0] !== '[')) continue
        try { arr.push(JSON.parse(s)) } catch { /* skip */ }
      }
      if (arr.length) root = arr
    }
  }
  if (root == null) return { parsed: false, outputTokens: 0, inputTokens: 0, isError: false, resultText: '' }
  let outputTokens = 0, inputTokens = 0, isError = false, resultText = ''
  const visit = n => {
    if (n == null) return
    if (Array.isArray(n)) { for (const e of n) visit(e); return }
    if (typeof n !== 'object') return
    if (n.usage && typeof n.usage === 'object') {
      const u = n.usage
      const ot = Number(u.output_tokens); if (Number.isFinite(ot) && ot > outputTokens) outputTokens = ot
      const inTot = (Number(u.input_tokens) || 0) +
        (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
      if (inTot > inputTokens) inputTokens = inTot
    }
    const direct = Number(n.output_tokens); if (Number.isFinite(direct) && direct > outputTokens) outputTokens = direct
    // is_error / resultText come ONLY from the authoritative final type:"result"
    // element — never a whole-tree OR. An intermediate stream event (e.g. a
    // tool_result with is_error:true) must NOT mark a completed run as failed.
    if (n.type === 'result') {
      isError = n.is_error === true
      if (typeof n.result === 'string') resultText = n.result
    }
    for (const k of Object.keys(n)) visit(n[k])
  }
  visit(root)
  return { parsed: true, outputTokens, inputTokens, isError, resultText }
}

// PURE outcome decision from (exit status, extracted result). This is the D-0005
// fix and is unit-tested directly (no claude spawn needed):
//   - A COMPLETED result with real output_tokens is SUCCESS even when the CLI
//     exit code is nonzero (glm-5.1 exited 1 with outputTokens:256 — the old code
//     bailed on the exit code and discarded a valid measurement).
//   - An is_error result (e.g. haiku's `400 thinking.enabled.budget_tokens >=
//     1024` from too small a cap) reports the REAL reason, not a bare "exit 1".
//   - Timeout (124) and unparseable/empty output still fail, as before.
function decideClaudeOutcome(status, ex, timeoutSecs) {
  if (status === 124) return { ok: false, tokens: 0, inputTokens: 0, error: `timeout after ${timeoutSecs}s` }
  // Salvage FIRST: a completed result with real output tokens is a valid throughput
  // measurement regardless of the CLI exit code OR an is_error flag (e.g. an
  // error_max_turns / refusal that still produced tokens). Tokens-produced wins —
  // this is the core D-0005 fix, and is checked BEFORE is_error so an intermediate
  // or result-level error can't discard a real measurement.
  if (ex.parsed && ex.outputTokens > 0) {
    return { ok: true, tokens: ex.outputTokens, inputTokens: ex.inputTokens || 0, error: '' }
  }
  if (ex.parsed && ex.isError) {
    const why = ex.resultText ? ex.resultText.replace(/\s+/g, ' ').trim().slice(0, 200) : `is_error (claude exit ${status})`
    return { ok: false, tokens: 0, inputTokens: ex.inputTokens || 0, error: `claude API error: ${why}` }
  }
  if (status !== 0) {
    const tail = ex.resultText ? `: ${ex.resultText.replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''
    return { ok: false, tokens: 0, inputTokens: ex.inputTokens || 0, error: `claude exit ${status}: no usable completed result${tail}` }
  }
  return {
    ok: false, tokens: 0, inputTokens: ex.inputTokens || 0,
    error: ex.parsed ? 'claude completed but reported 0 output tokens (empty modelUsage)' : 'could not parse claude JSON output',
  }
}

// ============================================================================
// Per-call dispatch. Each returns { ok, secs, tokens, estimated, error }.
// All use the portable perl-alarm TERM->KILL timeout (macOS has no `timeout`),
// close stdin (</dev/null) so the nested CLI never stalls waiting on stdin.
// ============================================================================

// Wrap any command in the same perl alarm fork-exec TERM/KILL pattern the
// runner scripts use. Returns the argv for spawnSync('perl', ...).
function perlAlarmArgv(timeoutSecs, cmdArgv) {
  const PERL = `
    my $t = shift @ARGV;
    my $p = fork; if (!defined $p) { exit 127 }
    if ($p == 0) { exec @ARGV; exit 127 }
    $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
    alarm $t; waitpid($p, 0); exit($? >> 8);
  `
  return ['-e', PERL, String(timeoutSecs), ...cmdArgv]
}

// security-sweep H2 (2026-07-07): bench children (esp. codex/grok, which have agentic tools)
// inherited the FULL process.env — every provider key + forge/cloud secret. Mirror the runner-lib
// je_scrub_child_secrets: return process.env with every known secret name removed, so a benched
// agentic child cannot exfiltrate cross-provider/forge/cloud creds. Each provider dispatch adds
// back ONLY the one auth var it needs.
const BENCH_SECRET_KEYS = [
  'ZAI_API_KEY', 'MINIMAX_API_KEY', 'OMLX_AUTH_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY',
  // issue #7: an operator following the claudex recipe interactively may have the CLIProxyAPI client
  // token exported as ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL) — no bench child may inherit it.
  // The providers that need these vars (glm/minimax/claudex) re-add them explicitly per dispatch;
  // anthropic uses the session's own auth, never these env vars.
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_PAT', 'GH_ENTERPRISE_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GCP_SA_KEY', 'GCLOUD_SERVICE_KEY',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'CLOUDFLARE_API_TOKEN', 'DIGITALOCEAN_TOKEN',
]
function scrubbedEnv() {
  const e = { ...process.env }
  for (const k of BENCH_SECRET_KEYS) delete e[k]
  return e
}

// Run a claude-family call (anthropic/glm/minimax) and time JUST this call.
// env: the provider-specific ANTHROPIC_* env (auth, base url, default models).
// flagArgv: extra `claude` args (e.g. ['--model','opus']) — [] for minimax.
// cfg: the resolved profile { prompt, maxOutputTokens, ... }.
function runClaudeFamily({ env, flagArgv, timeoutSecs, cfg }) {
  const claudeArgs = [
    '-p', cfg.prompt,
    ...flagArgv,
    '--output-format', 'json',
    '--verbose',                 // ensure the result/usage event is emitted
    '--permission-mode', 'acceptEdits',
    '--allowedTools', '',        // pure generation: grant no tools
  ]
  const argv = perlAlarmArgv(timeoutSecs, ['claude', ...claudeArgs])
  const fullEnv = {
    ...scrubbedEnv(),          // security-sweep H2: base env with all secrets stripped
    ...env,                    // provider ANTHROPIC_* (auth/base-url/models) added back explicitly
    // SOFT output cap for claude-family (no --max-tokens flag exists). MUST be
    // >= 1024 or an extended-thinking model rejects the request with a 400 (the
    // root cause of D-0005's haiku failure); profile caps are 2048 / 8192.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(cfg.maxOutputTokens),
  }
  const t0 = Date.now()
  const r = spawnSync('perl', argv, {
    env: fullEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],      // stdin closed/ignored (no stall)
    maxBuffer: 64 * 1024 * 1024,
  })
  const secs = (Date.now() - t0) / 1000
  // D-0005: parse stdout FIRST, then decide — a completed result is salvaged even
  // on a nonzero CLI exit; an is_error result reports the real reason.
  const ex = extractClaudeResult(r.stdout)
  const d = decideClaudeOutcome(r.status, ex, timeoutSecs)
  return { ok: d.ok, secs, tokens: d.tokens, inputTokens: d.inputTokens, estimated: false, error: d.error }
}

// Anthropic — session's own auth; do NOT inject any ANTHROPIC_AUTH_TOKEN/base url.
function dispatchAnthropic(target, timeoutSecs, cfg) {
  return runClaudeFamily({ env: {}, flagArgv: ['--model', target.alias], timeoutSecs, cfg })
}

// GLM — z.ai endpoint, Bearer via ZAI_API_KEY, default-model env (mirrors glm-run.sh).
function dispatchGlm(target, timeoutSecs, cfg) {
  if (!process.env.ZAI_API_KEY) return { ok: false, secs: 0, tokens: 0, inputTokens: 0, estimated: false, error: 'ZAI_API_KEY unset' }
  const env = {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: process.env.ZAI_API_KEY,           // Bearer (NOT x-api-key)
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
  }
  return runClaudeFamily({ env, flagArgv: ['--model', target.flag], timeoutSecs, cfg })
}

// Claudex — local CLIProxyAPI proxy, Bearer via the client-token FILE (never an env var), the model
// mirrored into CLAUDE_CODE_SUBAGENT_MODEL + effort always enabled (mirrors bin/claudex-run.sh; the
// proxy also honours effort-in-parens model names like "gpt-5.6-sol(high)"). The token is read at
// dispatch time and injected ONLY into this child's env, never echoed or logged.
function claudexTokenFile() {
  return process.env.JE_CLAUDEX_TOKEN_FILE || join(homedir(), '.config', 'cliproxyapi', 'client-token')
}
function dispatchClaudex(target, timeoutSecs, cfg) {
  let token = ''
  try { token = readFileSync(claudexTokenFile(), 'utf8').trim() } catch { /* handled below */ }
  if (!token) {
    return { ok: false, secs: 0, tokens: 0, inputTokens: 0, estimated: false, error: `claudex client-token file missing/unreadable/empty: ${claudexTokenFile()} (set JE_CLAUDEX_TOKEN_FILE)` }
  }
  const env = {
    ANTHROPIC_BASE_URL: process.env.JE_CLAUDEX_BASE_URL || 'http://127.0.0.1:8317',
    ANTHROPIC_AUTH_TOKEN: token,                              // Bearer (the proxy's client token)
    CLAUDE_CODE_SUBAGENT_MODEL: target.flag,                  // same model for any harness-spawned child
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
  }
  return runClaudeFamily({ env, flagArgv: ['--model', target.flag], timeoutSecs, cfg })
}

// MiniMax — MiniMax endpoint, Bearer via MINIMAX_API_KEY, ANTHROPIC_MODEL pins
// MiniMax-M3, no --model flag (mirrors minimax-run.sh).
function dispatchMinimax(_target, timeoutSecs, cfg) {
  if (!process.env.MINIMAX_API_KEY) return { ok: false, secs: 0, tokens: 0, inputTokens: 0, estimated: false, error: 'MINIMAX_API_KEY unset' }
  const env = {
    ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
    ANTHROPIC_AUTH_TOKEN: process.env.MINIMAX_API_KEY,        // Bearer
    ANTHROPIC_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '512000',
    API_TIMEOUT_MS: '3000000',
  }
  return runClaudeFamily({ env, flagArgv: [], timeoutSecs, cfg })
}

// Local (omlx MLX) — call the OpenAI-shaped /v1/chat/completions endpoint
// DIRECTLY via curl so we get a clean usage.completion_tokens and a clean
// HTTP-only timing window (no `claude` agent overhead). Bearer via OMLX_AUTH_TOKEN.
function dispatchLocal(target, timeoutSecs, cfg) {
  const tok = process.env.OMLX_AUTH_TOKEN
  if (!tok) return { ok: false, secs: 0, tokens: 0, inputTokens: 0, estimated: false, error: 'OMLX_AUTH_TOKEN unset' }
  const body = JSON.stringify({
    model: target.id,
    messages: [{ role: 'user', content: cfg.prompt }],
    max_tokens: cfg.maxOutputTokens,         // omlx honours a hard cap
    temperature: 0,
    stream: false,
  })
  const curlArgv = [
    '-s', '--max-time', String(timeoutSecs),
    'http://127.0.0.1:8000/v1/chat/completions',
    '-H', 'Content-Type: application/json',
    '-d', body,
  ]
  const t0 = Date.now()
  const r = curlAuthed(curlArgv, tok, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  const secs = (Date.now() - t0) / 1000
  if (r.status !== 0) return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: `curl exit ${r.status} (omlx unreachable/timeout)` }
  let j
  try { j = JSON.parse(r.stdout) } catch { return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: `omlx returned non-JSON: ${(r.stdout || '').trim().slice(0, 200)}` } }
  if (j && j.error) return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: `omlx error: ${typeof j.error === 'string' ? j.error : JSON.stringify(j.error).slice(0, 200)}` }
  const ct = Number(j && j.usage && j.usage.completion_tokens)
  const pt = Number(j && j.usage && j.usage.prompt_tokens)
  if (!Number.isFinite(ct) || ct <= 0) {
    return { ok: false, secs, tokens: 0, inputTokens: Number.isFinite(pt) ? pt : 0, estimated: false, error: 'omlx response missing usage.completion_tokens' }
  }
  return { ok: true, secs, tokens: ct, inputTokens: Number.isFinite(pt) ? pt : 0, estimated: false, error: '' }
}

// Codex (gpt-5.5) — `codex exec`, auth from ~/.codex/auth.json (no env key). We
// request --json so we can read a token_count usage event if present; codex's
// token reporting is unreliable across versions, so if no usage is found we fall
// back to a chars/4 estimate of the captured final message (estimated:true) —
// the ONE legitimate estimation per the constraints.
function dispatchCodex(target, timeoutSecs, cfg) {
  // Pull the codex final message to its own file (clean capture), like codex-run.sh.
  const lastFile = resolve(RESULTS_DIR, `_codex_last_${target.id}.txt`)
  const codexArgs = [
    'exec',
    '-s', 'read-only',                       // benchmark only generates text; no writes needed
    '--skip-git-repo-check',
    '-c', 'approval_policy="never"',
    '-c', 'mcp_servers={}',
    '--json',                                // emit structured events (token usage if available)
    '-o', lastFile,
    '-m', target.model || 'gpt-5.5',        // gpt-5.6 entries carry their own model id
    '-c', `model_reasoning_effort=${target.effort}`,
    cfg.prompt,
  ]
  const argv = perlAlarmArgv(timeoutSecs, ['codex', ...codexArgs])
  const t0 = Date.now()
  // security-sweep H2: codex authenticates from ~/.codex/auth.json — give it a secret-scrubbed env.
  const r = spawnSync('perl', argv, { env: scrubbedEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  const secs = (Date.now() - t0) / 1000
  if (r.status === 124) return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: `timeout after ${timeoutSecs}s` }
  const out = (r.stdout || '')
  // terminal model/auth/version failure -> fail closed (mirrors codex-run.sh guard)
  if (/requires a newer version of Codex|is not supported when using Codex with a|invalid_api_key|401 Unauthorized|403 Forbidden/i.test(out + (r.stderr || ''))) {
    return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: 'codex model/auth/version failure (see codex output)' }
  }
  if (r.status !== 0) {
    const tail = ((r.stderr || '') + out).trim().slice(-300)
    return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: `codex exit ${r.status}: ${tail || 'no output'}` }
  }
  // 1) try to find REAL token counts in the --json event stream (output + input).
  let realTokens = 0, realInput = 0
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s[0] !== '{') continue
    try {
      const o = JSON.parse(s)
      const cand =
        (o && o.token_count && (o.token_count.output_tokens ?? o.token_count.total_tokens)) ??
        (o && o.usage && (o.usage.output_tokens ?? o.usage.completion_tokens)) ??
        (o && o.info && o.info.token_usage && (o.info.token_usage.output_tokens ?? o.info.token_usage.total_tokens))
      const n = Number(cand)
      if (Number.isFinite(n) && n > realTokens) realTokens = n
      const inCand =
        (o && o.token_count && (o.token_count.input_tokens ?? o.token_count.prompt_tokens)) ??
        (o && o.usage && (o.usage.input_tokens ?? o.usage.prompt_tokens)) ??
        (o && o.info && o.info.token_usage && (o.info.token_usage.input_tokens ?? o.info.token_usage.prompt_tokens))
      const m = Number(inCand)
      if (Number.isFinite(m) && m > realInput) realInput = m
    } catch { /* skip */ }
  }
  if (realTokens > 0) return { ok: true, secs, tokens: realTokens, inputTokens: realInput, estimated: false, error: '' }
  // 2) FALLBACK (codex only): chars/4 estimate of the captured final message.
  let finalMsg = ''
  try { if (existsSync(lastFile)) finalMsg = require_readFileSync(lastFile) } catch { /* ignore */ }
  if (!finalMsg) {
    // last resort: scrape an "agent_message" / "item.completed" text from the json stream
    for (const line of out.split(/\r?\n/)) {
      const s = line.trim(); if (!s || s[0] !== '{') continue
      try { const o = JSON.parse(s); const txt = o?.msg?.message || o?.item?.text || o?.text; if (typeof txt === 'string' && txt.length > finalMsg.length) finalMsg = txt } catch { /* skip */ }
    }
  }
  if (!finalMsg.trim()) return { ok: false, secs, tokens: 0, inputTokens: realInput, estimated: false, error: 'codex produced no extractable final message or token count' }
  const est = Math.max(1, Math.round(finalMsg.length / 4))
  return { ok: true, secs, tokens: est, inputTokens: realInput, estimated: true, error: '' }
}

// tiny lazy fs read (kept out of the top imports to avoid an unused symbol if codex never runs)
function require_readFileSync(p) {
  // eslint-disable-next-line global-require
  const fs = require_node_fs()
  return fs.readFileSync(p, 'utf8')
}
let _fs
function require_node_fs() { if (!_fs) _fs = require_dynamic('node:fs'); return _fs }
function require_dynamic(mod) { /* eslint-disable no-undef */ return globalThis.__nodeRequire ? globalThis.__nodeRequire(mod) : importSyncFallback(mod) }
// In ESM there is no require; use createRequire.
import { createRequire as _createRequire } from 'node:module'
const _req = _createRequire(import.meta.url)
function importSyncFallback(mod) { return _req(mod) }

// Grok (xAI) — `grok` headless CLI, auth from OAuth session OR XAI_API_KEY (no env key injected). We
// request --output-format json to read a usage/token event if present; grok's token-reporting shape is
// UNCONFIRMED, so if no machine-readable usage is found we fall back to a chars/4 estimate of the response
// (estimated:true) — the same single legitimate estimation codex uses. Single-turn generation (no
// --always-approve / --max-turns): the bench measures raw decode throughput, like the other dispatch fns.
function dispatchGrok(target, timeoutSecs, cfg) {
  const grokArgs = [
    '-p', cfg.prompt,
    '-m', target.model,
    '--output-format', 'json',
    '--no-alt-screen',
    '--no-auto-update',
    '--disable-web-search',  // benchmark = deterministic throughput, so always hermetic (no grokWebSearch knob here)
    '--no-subagents',        // pure single-turn generation: never fan out sub-agents (bounds latency)
  ]
  const argv = perlAlarmArgv(timeoutSecs, ['grok', ...grokArgs])
  const t0 = Date.now()
  // security-sweep H2: grok resolves its own credential (OAuth session or XAI_API_KEY); give it a
  // secret-scrubbed env but ADD BACK its own XAI key if the operator set one.
  const grokEnv = scrubbedEnv()
  if (process.env.XAI_API_KEY) grokEnv.XAI_API_KEY = process.env.XAI_API_KEY
  const r = spawnSync('perl', argv, { env: grokEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  const secs = (Date.now() - t0) / 1000
  if (r.status === 124) return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: `timeout after ${timeoutSecs}s` }
  const out = (r.stdout || '')
  // terminal model/auth/session failure -> fail closed (mirrors grok-run.sh guard)
  if (/401 Unauthorized|403 Forbidden|invalid api key|session (expired|token expired)|requires a newer version of Grok/i.test(out + (r.stderr || ''))) {
    return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: 'grok model/auth/session failure (see grok output)' }
  }
  if (r.status !== 0) {
    const tail = ((r.stderr || '') + out).trim().slice(-300)
    return { ok: false, secs, tokens: 0, inputTokens: 0, estimated: false, error: `grok exit ${r.status}: ${tail || 'no output'}` }
  }
  // 1) try to find REAL token counts in --output-format json (shape UNCONFIRMED: walk common usage fields).
  let realTokens = 0, realInput = 0, finalMsg = ''
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim(); if (!s || s[0] !== '{') continue
    try {
      const o = JSON.parse(s)
      const cand = (o && o.usage && (o.usage.output_tokens ?? o.usage.completion_tokens ?? o.usage.total_tokens)) ??
                   (o && o.token_count && (o.token_count.output_tokens ?? o.token_count.total_tokens))
      const n = Number(cand); if (Number.isFinite(n) && n > realTokens) realTokens = n
      const inCand = (o && o.usage && (o.usage.input_tokens ?? o.usage.prompt_tokens)) ??
                     (o && o.token_count && (o.token_count.input_tokens ?? o.token_count.prompt_tokens))
      const m = Number(inCand); if (Number.isFinite(m) && m > realInput) realInput = m
      const txt = o?.result ?? o?.response ?? o?.message ?? o?.text
      if (typeof txt === 'string' && txt.length > finalMsg.length) finalMsg = txt
    } catch { /* skip */ }
  }
  if (realTokens > 0) return { ok: true, secs, tokens: realTokens, inputTokens: realInput, estimated: false, error: '' }
  // 2) FALLBACK: chars/4 estimate of the response text (plain stdout if the json wasn't parseable).
  if (!finalMsg.trim()) finalMsg = out
  if (!finalMsg.trim()) return { ok: false, secs, tokens: 0, inputTokens: realInput, estimated: false, error: 'grok produced no extractable response or token count' }
  const est = Math.max(1, Math.round(finalMsg.length / 4))
  return { ok: true, secs, tokens: est, inputTokens: realInput, estimated: true, error: '' }
}

const DISPATCH = {
  anthropic: dispatchAnthropic,
  glm: dispatchGlm,
  local: dispatchLocal,
  codex: dispatchCodex,
  minimax: dispatchMinimax,
  grok: dispatchGrok,
  claudex: dispatchClaudex,
}

// ============================================================================
// Benchmark one target: COLD call, then immediate HOT call.
// Each tok/s is derived from THAT call's OWN token count and seconds (cold and
// hot do NOT generate the same number of output tokens, so we store both).
// ============================================================================
function benchOne(target, timeoutSecs, cfg) {
  const dispatch = DISPATCH[target.provider]
  const tSecs = target.provider === 'local'
    ? Math.max(timeoutSecs, cfg.localTimeoutSecs)   // local cold load can be slow
    : timeoutSecs

  const cold = dispatch(target, tSecs, cfg)
  // immediate HOT call (no sleep) — warm connection / resident weights
  const hot = cold.ok ? dispatch(target, tSecs, cfg) : { ok: false, secs: 0, tokens: 0, inputTokens: 0, estimated: false, error: 'skipped (cold failed)' }

  const tps = c => (c.ok && c.secs > 0 && c.tokens > 0) ? (c.tokens / c.secs) : null
  const coldTps = tps(cold)
  const hotTps = tps(hot)
  const ok = !!(cold.ok && hot.ok)
  const errParts = []
  if (!cold.ok) errParts.push(`cold: ${cold.error}`)
  if (!hot.ok) errParts.push(`hot: ${hot.error}`)

  return {
    provider: target.provider,
    model: target.id,
    profile: cfg.name,
    ok,
    cold_tok_s: coldTps != null ? round2(coldTps) : null,
    hot_tok_s: hotTps != null ? round2(hotTps) : null,
    delta_tok_s: (coldTps != null && hotTps != null) ? round2(hotTps - coldTps) : null,
    cold_tokens: cold.tokens || 0,
    hot_tokens: hot.tokens || 0,
    cold_input_tokens: cold.inputTokens || 0,
    hot_input_tokens: hot.inputTokens || 0,
    cold_secs: round2(cold.secs || 0),
    hot_secs: round2(hot.secs || 0),
    estimated: !!(cold.estimated || hot.estimated),   // true only for codex chars/4 fallback
    timestamp: localIso(),
    error: errParts.join(' | '),
  }
}

function round2(n) { return Math.round(n * 100) / 100 }

// Local-tz ISO-8601 with offset (e.g. 2026-06-15T11:55:28-07:00).
function localIso(d = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}

// ============================================================================
// Persistence — append-only JSONL, one record per model, written IMMEDIATELY
// after each model finishes (crash-survival: a sweep that dies mid-run keeps
// every record produced so far).
// ============================================================================
function appendRecord(rec) {
  mkdirSync(RESULTS_DIR, { recursive: true })
  appendFileSync(RESULTS_FILE, JSON.stringify(rec) + '\n', 'utf8')
}

// ============================================================================
// Readable end-of-run summary table.
// ============================================================================
function printTable(records) {
  const cols = [
    ['PROVIDER', r => r.provider],
    ['MODEL', r => r.model],
    ['COLD t/s', r => r.cold_tok_s == null ? '-' : String(r.cold_tok_s)],
    ['HOT t/s', r => r.hot_tok_s == null ? '-' : String(r.hot_tok_s)],
    ['Δ t/s', r => r.delta_tok_s == null ? '-' : (r.delta_tok_s >= 0 ? '+' : '') + r.delta_tok_s],
    ['cIn', r => String(r.cold_input_tokens || 0)],
    ['cOut', r => String(r.cold_tokens)],
    ['hOut', r => String(r.hot_tokens)],
    ['cSec', r => String(r.cold_secs)],
    ['hSec', r => String(r.hot_secs)],
    ['STATUS', r => r.ok ? (r.estimated ? 'OK*' : 'OK') : 'FAIL'],
  ]
  const widths = cols.map(([h, f]) => Math.max(h.length, ...records.map(r => f(r).length), 1))
  const fmtRow = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  const sep = widths.map(w => '-'.repeat(w)).join('  ')
  console.log('')
  console.log(fmtRow(cols.map(c => c[0])))
  console.log(sep)
  for (const r of records) console.log(fmtRow(cols.map(c => c[1](r))))
  console.log(sep)
  // per-row error detail
  const failed = records.filter(r => !r.ok)
  if (failed.length) {
    console.log('\nFailures:')
    for (const r of failed) console.log(`  ${r.provider}:${r.model} — ${r.error}`)
  }
  if (records.some(r => r.estimated)) {
    console.log('\n* token count for this row is an estimate (codex chars/4 fallback — no machine-readable usage).')
  }
}

// ============================================================================
// Main.
// ============================================================================
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(USAGE); return }

  const cfg = PROFILES[args.profile]
  if (!cfg) {
    console.error(`Unknown profile "${args.profile}". Choose one of: ${Object.keys(PROFILES).join(' | ')}.`)
    process.exit(2)
  }
  const baseTimeout = Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : cfg.defaultTimeoutSecs

  const { all, localNote } = buildCatalogue()
  if (localNote) console.error(`[local discovery] ${localNote}`)

  const { picked, warnings } = resolveSelection(args.models, all)
  for (const w of warnings) console.error(`[selection] ${w}`)

  if (!picked.length) {
    console.error('No models selected. Use --models all or see --help for the selection grammar.')
    process.exit(2)
  }

  if (args.list) {
    console.log(`Would benchmark ${picked.length} model(s) (cold + hot each) on the "${cfg.name}" profile (output cap ${cfg.maxOutputTokens}):\n`)
    for (const t of picked) console.log(`  ${t.provider}:${t.id}`)
    console.log(`\nPer-call timeout: ${baseTimeout}s (local: ${Math.max(baseTimeout, cfg.localTimeoutSecs)}s)`)
    console.log(`Results would append to: ${RESULTS_FILE}`)
    if (localNote) console.log(`\nNote: ${localNote}`)
    return
  }

  console.error(`je-bench: benchmarking ${picked.length} model(s) on the "${cfg.name}" profile; cold+hot each; output cap ${cfg.maxOutputTokens} tokens.`)
  console.error(`Results -> ${RESULTS_FILE}\n`)

  const records = []
  for (let i = 0; i < picked.length; i++) {
    const t = picked[i]
    process.stderr.write(`[${i + 1}/${picked.length}] ${t.provider}:${t.id} ... `)
    let rec
    try {
      rec = benchOne(t, baseTimeout, cfg)
    } catch (e) {
      // honest failure: record + continue
      rec = {
        provider: t.provider, model: t.id, profile: cfg.name, ok: false,
        cold_tok_s: null, hot_tok_s: null, delta_tok_s: null,
        cold_tokens: 0, hot_tokens: 0, cold_input_tokens: 0, hot_input_tokens: 0,
        cold_secs: 0, hot_secs: 0,
        estimated: false, timestamp: localIso(),
        error: `harness exception: ${String(e && e.message || e).slice(0, 200)}`,
      }
    }
    appendRecord(rec)   // IMMEDIATE append (crash-survival)
    records.push(rec)
    process.stderr.write(
      rec.ok
        ? `OK  cold ${rec.cold_tok_s} t/s, hot ${rec.hot_tok_s} t/s (Δ ${rec.delta_tok_s})${rec.estimated ? ' *est' : ''}\n`
        : `FAIL (${rec.error})\n`
    )
  }

  printTable(records)
  const okCount = records.filter(r => r.ok).length
  console.log(`\n${okCount}/${records.length} models benchmarked successfully. Full history: ${RESULTS_FILE}`)
}

// Run main() only when executed as a CLI, so the pure helpers can be imported by
// the test suite without triggering a benchmark sweep.
const _isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (_isMain) main()

export { extractClaudeResult, decideClaudeOutcome, buildHeavyContext, PROFILES }
