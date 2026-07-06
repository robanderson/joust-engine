// workflows/tournament-model-ladder.test.mjs
// Model fallback ladder (operator-requested resilience, 2026-07-06): the orchestrating session may
// run on a model (Fable) whose safety sensitivity can block sub-agent calls; a blocked NATIVE
// anthropic seat degrades one rung down the ladder instead of dying. Two suites:
//   1. PURE units — the marked `model ladder` block (MODEL_LADDER + nextModelDown) is extracted
//      from the shipped source and eval'd (repo convention: never hand-copy logic that would drift).
//   2. STRUCTURAL guards, written AS tests so they can never regress:
//      a. the explicit-model AUDIT — every agent()/agentLadder() call in tournament.mjs carries an
//         explicit `model:` or `agentType:` (zero engine sub-agents inherit the session model);
//         the only exempt calls are inside the agentLadder wrapper itself (the runtime-guarded
//         chokepoint) plus dispatch()'s `agentLadder(prompt, opts)` (opts is branch-built and the
//         wrapper THROWS when neither key is set — the guard's presence is asserted here too);
//      b. the security lenses are EXCLUDED from the ladder (sonnet retry is forbidden for them);
//      c. `model_downgrades` is surfaced in the workflow return value;
//      d. the loud JE-MODEL-DOWNGRADE log line exists;
//      e. the rung slots on the FINAL same-model try at retry-loop sites (opus try, opus retry,
//         THEN sonnet rung).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

function extractBlock(begin, end) {
  const i = SRC.indexOf(begin)
  const j = SRC.indexOf(end, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`block markers not found: ${begin}`)
  return SRC.slice(i, j)
}

// ----- 1. PURE units: MODEL_LADDER + nextModelDown -----
const block = extractBlock('// ---- begin: model ladder ', '// ---- end: model ladder ')
const sandbox = {}
new Function('sandbox', `
  with (sandbox) {
    ${block}
    sandbox.MODEL_LADDER = MODEL_LADDER
    sandbox.nextModelDown = nextModelDown
  }
`)(sandbox)
const { MODEL_LADDER, nextModelDown } = sandbox

test('MODEL_LADDER is exactly fable -> opus -> sonnet (haiku retired; sonnet is the floor)', () => {
  assert.deepEqual(MODEL_LADDER, ['fable', 'opus', 'sonnet'])
})

test('nextModelDown: fable -> opus', () => {
  assert.equal(nextModelDown('fable'), 'opus')
})

test('nextModelDown: opus -> sonnet', () => {
  assert.equal(nextModelDown('opus'), 'sonnet')
})

test('nextModelDown: sonnet -> null (NEVER below sonnet)', () => {
  assert.equal(nextModelDown('sonnet'), null)
})

test('nextModelDown: haiku -> null (retired by operator policy — never a rung)', () => {
  assert.equal(nextModelDown('haiku'), null)
})

test('nextModelDown: unknown ids -> null', () => {
  for (const m of ['glm-5.2', 'codex-xhigh', 'gpt-5.5', 'qwen', 'opusx', '']) {
    assert.equal(nextModelDown(m), null, `expected null for ${JSON.stringify(m)}`)
  }
})

test('nextModelDown: null/undefined/non-string -> null (never throws)', () => {
  assert.equal(nextModelDown(null), null)
  assert.equal(nextModelDown(undefined), null)
  assert.equal(nextModelDown(42), null)
})

test('nextModelDown: case/whitespace tolerant on known ids', () => {
  assert.equal(nextModelDown('OPUS'), 'sonnet')
  assert.equal(nextModelDown(' fable '), 'opus')
})

// ----- 2a. STRUCTURAL: the explicit-model audit (the regression-proof audit itself) -----
// Scan the source (minus the agentLadder wrapper body — the runtime-guarded chokepoint) for every
// agent( / agentLadder( call and assert its argument list names `model:` or `agentType:` outside
// string content. Comment mentions are all `agent()` (empty args) and are skipped.

// Strip the wrapper region: calls inside it forward caller opts by design.
const WRAP_BEGIN = '// ---- begin: agent ladder wrapper'
const WRAP_END = '// ---- end: agent ladder wrapper'
assert.ok(SRC.indexOf(WRAP_BEGIN) >= 0 && SRC.indexOf(WRAP_END) > SRC.indexOf(WRAP_BEGIN), 'agent ladder wrapper markers present')
const SCAN = SRC.slice(0, SRC.indexOf(WRAP_BEGIN)) + SRC.slice(SRC.indexOf(WRAP_END))

// Skip a template literal starting at src[i] === '`'; returns the index AFTER the closing backtick.
// Handles \x escapes and nested `${ ... }` (including nested template literals and quoted strings).
function skipTemplate(src, i) {
  i++
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '`') return i + 1
    if (ch === '$' && src[i + 1] === '{') {
      i += 2
      let d = 1
      while (i < src.length && d > 0) {
        const c = src[i]
        if (c === '\\') { i += 2; continue }
        if (c === '`') { i = skipTemplate(src, i); continue }
        if (c === "'" || c === '"') { i = skipQuoted(src, i); continue }
        if (c === '{') d++
        else if (c === '}') d--
        i++
      }
      continue
    }
    i++
  }
  return i
}
// Skip a '...'/"..." string starting at src[i]; returns the index AFTER the closing quote.
function skipQuoted(src, i) {
  const q = src[i]
  i++
  while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
  return i + 1
}
// Extract the balanced argument list for a call whose '(' is at src[start] (string-aware).
function callArgs(src, start) {
  let i = start, depth = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === "'" || ch === '"') { i = skipQuoted(src, i); continue }
    if (ch === '`') { i = skipTemplate(src, i); continue }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return src.slice(start + 1, i) }
    i++
  }
  return null
}
// Remove all string content from a code snippet so `model:`/`agentType:` matches only real keys.
function stripStrings(code) {
  let out = '', i = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === "'" || ch === '"') { i = skipQuoted(code, i); out += 'S'; continue }
    if (ch === '`') { i = skipTemplate(code, i); out += 'S'; continue }
    out += ch
    i++
  }
  return out
}

function auditCalls(name) {
  const offenders = []
  const re = new RegExp(`(?<![A-Za-z0-9_$.])${name}\\(`, 'g')
  let m
  while ((m = re.exec(SCAN))) {
    const parenIdx = m.index + m[0].length - 1
    const args = callArgs(SCAN, parenIdx)
    if (args == null) { offenders.push({ at: m.index, why: 'unbalanced call' }); continue }
    if (!args.trim()) continue // `agent()` in a comment — a mention, not a call
    const code = stripStrings(args)
    const ok = /\b(model|agentType)\s*:/.test(code) ||
      // dispatch()'s single pass-through: opts is branch-built (model OR agentType always set)
      // and the wrapper's runtime guard (asserted below) throws otherwise.
      (name === 'agentLadder' && code.replace(/\s+/g, ' ').trim() === 'prompt, opts')
    if (!ok) offenders.push({ at: m.index, snippet: SCAN.slice(m.index, m.index + 120).replace(/\n/g, ' ') })
  }
  return offenders
}

test('AUDIT: every agent() call carries an explicit model: or agentType: (never the session model)', () => {
  const offenders = auditCalls('agent')
  assert.deepEqual(offenders, [], `agent() call(s) without explicit model/agentType:\n${JSON.stringify(offenders, null, 2)}`)
})

test('AUDIT: every agentLadder() call carries an explicit model:/agentType: (or is dispatch\'s guarded opts pass-through)', () => {
  const offenders = auditCalls('agentLadder')
  assert.deepEqual(offenders, [], `agentLadder() call(s) without explicit model/agentType:\n${JSON.stringify(offenders, null, 2)}`)
})

test('AUDIT backstop: the wrapper runtime-guards against a model-less, agentType-less opts', () => {
  assert.ok(SRC.includes('no engine sub-agent may inherit the session model'),
    'agentLadder must throw when opts carries neither model nor agentType')
})

test('AUDIT sanity: the scanner actually sees the known call sites (not vacuously green)', () => {
  const count = (SCAN.match(/(?<![A-Za-z0-9_$.])agentLadder\(/g) || []).length
  assert.ok(count >= 15, `expected >=15 agentLadder call sites, saw ${count}`)
  const agentCount = (SCAN.match(/(?<![A-Za-z0-9_$.])agent\(/g) || []).length
  assert.ok(agentCount >= 2, `expected the legacy-judge + codex-dispatch agent() sites, saw ${agentCount}`)
})

// ----- 2b. STRUCTURAL: security lenses excluded from the ladder -----
test('security lenses are EXCLUDED from the ladder (sonnet retry forbidden; dead-judge path kept)', () => {
  assert.match(SRC, /eligible:\s*i === 2 && !isSecurityLens\(lens\.key\)/,
    'askLensNative must disable the rung for security/security-x seats')
})

test('the rung slots on the FINAL same-model try at retry-loop sites (try, retry, THEN rung)', () => {
  // askLensNative (covered above, `i === 2 && !isSecurityLens`) + guidance synthesis:
  assert.match(SRC, /GUIDANCE_SYNTH_SCHEMA[^\n]*\{ eligible: i === 2 \}/,
    'synthesizeGuidance must enable the rung only on its final opus try')
})

// ----- 2c. STRUCTURAL: model_downgrades surfaced in the workflow return value -----
test('model_downgrades is surfaced in the workflow return value', () => {
  const n = (SRC.match(/model_downgrades: modelDowngrades/g) || []).length
  assert.ok(n >= 10, `expected model_downgrades on the terminal returns (>=10 sites), saw ${n}`)
})

// ----- 2d. STRUCTURAL: the loud downgrade log line -----
test('JE-MODEL-DOWNGRADE log line exists (loud observability)', () => {
  assert.ok(SRC.includes('JE-MODEL-DOWNGRADE'), 'the downgrade must be logged loudly')
})

// ----- 2e. STRUCTURAL: honest judge_model tagging -----
test('askLensNative tags judgeModel with the model that ACTUALLY answered (ladder.used)', () => {
  assert.match(SRC, /judgeModel: ladder\.used \|\| 'opus'/)
})
