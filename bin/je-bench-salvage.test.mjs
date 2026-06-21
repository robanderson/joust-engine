// =============================================================================
// je-bench-salvage.test.mjs — regression tests for dogfood D-0005.
//
// D-0005: je-bench scored a *completed* claude-family call as FAIL whenever the
// `claude` CLI exited nonzero, discarding the result BEFORE parsing stdout. Two
// real cases from the all-models sweep:
//   - glm-5.1 exited 1 but its stdout carried a completed result with
//     usage.output_tokens=256 (a valid measurement that was thrown away).
//   - haiku exited 1 with is_error:true and result "API Error: 400
//     thinking.enabled.budget_tokens: Input should be greater than or equal to
//     1024" (caused by the old 256 output cap) — reported as a bare "exit 1".
//
// These tests import the REAL exported helpers (extractClaudeResult,
// decideClaudeOutcome, buildHeavyContext, PROFILES) and assert the salvage /
// error / heavy-profile behaviour, so they fail if the fix is reverted.
// =============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractClaudeResult, decideClaudeOutcome, buildHeavyContext, PROFILES } from './je-bench.mjs'

// --- fixtures: the claude --output-format json ARRAY shape (result element) ----
const resultEvent = (over = {}) => JSON.stringify([
  { type: 'system', subtype: 'init' },
  {
    type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    result: 'A hash map is ...',
    usage: { input_tokens: 10, output_tokens: 256, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...over,
  },
])

// glm-5.1: completed, real tokens, but the CLI exited 1.
const GLM51 = resultEvent({ result: 'hash map essay', usage: { input_tokens: 64, output_tokens: 256 } })
// haiku: the actual observed 400 — is_error true, 0 output tokens.
const HAIKU = resultEvent({
  is_error: true, output_tokens: 0,
  result: 'API Error: 400 thinking.enabled.budget_tokens: Input should be greater than or equal to 1024',
  usage: { input_tokens: 0, output_tokens: 0 },
})
// heavy: big input + big output.
const HEAVY = resultEvent({ usage: { input_tokens: 6200, output_tokens: 5300 } })

test('extractClaudeResult pulls output, input, is_error, resultText', () => {
  const ex = extractClaudeResult(GLM51)
  assert.equal(ex.parsed, true)
  assert.equal(ex.outputTokens, 256)
  assert.equal(ex.inputTokens, 64)
  assert.equal(ex.isError, false)

  const h = extractClaudeResult(HAIKU)
  assert.equal(h.isError, true)
  assert.equal(h.outputTokens, 0)
  assert.match(h.resultText, /thinking\.enabled\.budget_tokens/)
})

test('extractClaudeResult sums cached input tokens into the real prompt size', () => {
  const s = JSON.stringify([{ type: 'result', is_error: false,
    usage: { input_tokens: 12, cache_read_input_tokens: 6000, cache_creation_input_tokens: 200, output_tokens: 80 } }])
  const ex = extractClaudeResult(s)
  assert.equal(ex.inputTokens, 6212)   // hot-call cache reads still count as input
  assert.equal(ex.outputTokens, 80)
})

test('extractClaudeResult parses line-by-line stream-json fallback', () => {
  const lines = [
    '{"type":"system"}',
    '{"type":"result","is_error":false,"usage":{"input_tokens":5,"output_tokens":99}}',
  ].join('\n')
  const ex = extractClaudeResult(lines)
  assert.equal(ex.parsed, true)
  assert.equal(ex.outputTokens, 99)
})

test('extractClaudeResult on empty/garbage is unparsed', () => {
  assert.equal(extractClaudeResult('').parsed, false)
  assert.equal(extractClaudeResult('not json at all').parsed, false)
})

// ----------------------------------------------------------------------------
// decideClaudeOutcome — the D-0005 fix.
// ----------------------------------------------------------------------------
test('D-0005: completed result with real tokens is SALVAGED despite nonzero exit (glm-5.1)', () => {
  const d = decideClaudeOutcome(1, extractClaudeResult(GLM51), 240)
  assert.equal(d.ok, true)               // <-- old code returned false here
  assert.equal(d.tokens, 256)
  assert.equal(d.inputTokens, 64)
  assert.equal(d.error, '')
})

test('completed result on a clean exit is still OK (no regression)', () => {
  const d = decideClaudeOutcome(0, extractClaudeResult(resultEvent()), 240)
  assert.equal(d.ok, true)
  assert.equal(d.tokens, 256)
})

test('D-0005: is_error result reports the REAL reason, not a bare exit code (haiku)', () => {
  const d = decideClaudeOutcome(1, extractClaudeResult(HAIKU), 240)
  assert.equal(d.ok, false)
  assert.match(d.error, /claude API error/)
  assert.match(d.error, /thinking\.enabled\.budget_tokens/)   // actionable, not "exit 1"
  assert.doesNotMatch(d.error, /^claude exit/)
})

// Regressions for the adversarial-review finding: a whole-tree is_error OR +
// is_error-before-salvage ordering would mis-score completed runs as FAIL.
test('D-0005 regression: intermediate is_error event does NOT fail a completed run', () => {
  const stream = JSON.stringify([
    { type: 'system' },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'a tool failed mid-run' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'final essay', usage: { input_tokens: 30, output_tokens: 700 } },
  ])
  const ex = extractClaudeResult(stream)
  assert.equal(ex.isError, false, 'is_error must come from the result element, not the intermediate tool_result')
  assert.equal(ex.resultText, 'final essay', 'resultText must be the final result, not the intermediate error string')
  const d = decideClaudeOutcome(0, ex, 240)
  assert.equal(d.ok, true)
  assert.equal(d.tokens, 700)
})

test('D-0005 regression: a result with is_error:true BUT real tokens is salvaged (throughput still valid)', () => {
  // e.g. error_max_turns / refusal that still decoded tokens — measure their rate.
  const s = JSON.stringify([{ type: 'result', subtype: 'error_max_turns', is_error: true,
    result: 'hit max turns', usage: { input_tokens: 40, output_tokens: 900 } }])
  const d = decideClaudeOutcome(1, extractClaudeResult(s), 240)
  assert.equal(d.ok, true)
  assert.equal(d.tokens, 900)
})

test('timeout (124) still fails with a timeout message', () => {
  const d = decideClaudeOutcome(124, extractClaudeResult(''), 300)
  assert.equal(d.ok, false)
  assert.match(d.error, /timeout after 300s/)
})

test('nonzero exit with no usable result fails (not salvaged)', () => {
  const d = decideClaudeOutcome(1, extractClaudeResult(''), 240)
  assert.equal(d.ok, false)
  assert.match(d.error, /no usable completed result/)
})

test('clean exit but zero output tokens reports empty modelUsage', () => {
  const zero = JSON.stringify([{ type: 'result', is_error: false, usage: { input_tokens: 9, output_tokens: 0 } }])
  const d = decideClaudeOutcome(0, extractClaudeResult(zero), 240)
  assert.equal(d.ok, false)
  assert.match(d.error, /0 output tokens|empty modelUsage/)
})

// ----------------------------------------------------------------------------
// Profile invariants — the cap must clear the thinking-budget floor, and the
// heavy input context must exceed 5k tokens.
// ----------------------------------------------------------------------------
test('every profile output cap clears the 1024 thinking-budget floor (D-0005 root cause)', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    assert.ok(p.maxOutputTokens >= 1024, `${name} cap ${p.maxOutputTokens} must be >= 1024`)
  }
})

test('heavy profile targets >5k input and >5k output', () => {
  assert.ok(PROFILES.heavy.maxOutputTokens >= 5000, 'heavy output cap must allow >5k decode')
  // ~4 chars/token is a conservative lower bound; require the context alone to
  // exceed ~5k tokens (>20k chars) so the prompt clears the 5k-input target.
  const chars = buildHeavyContext().length
  assert.ok(chars / 4 > 5000, `heavy input context ~${Math.round(chars / 4)} tokens must exceed 5000`)
  assert.ok(PROFILES.heavy.prompt.length > buildHeavyContext().length, 'heavy prompt includes the context + the instruction')
})

test('light profile stays small but legal', () => {
  assert.equal(PROFILES.light.maxOutputTokens, 2048)
  assert.ok(PROFILES.light.prompt.length < 1000, 'light prompt is a short paragraph ask')
})
