// security-sweep H2 (2026-07-07): bench children (codex/grok have agentic tools) must NOT inherit
// the operator's cross-provider / forge / cloud secrets. Structural pins on the scrub wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'je-bench.mjs'), 'utf8')

test('scrubbedEnv strips every known secret name (incl. all provider keys + forge/cloud)', () => {
  assert.ok(SRC.includes('function scrubbedEnv()'), 'helper exists')
  for (const k of ['ZAI_API_KEY', 'MINIMAX_API_KEY', 'OMLX_AUTH_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY',
                   'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                   'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
                   'NPM_TOKEN', 'SSH_AUTH_SOCK'])
    assert.ok(SRC.includes(`'${k}'`), `BENCH_SECRET_KEYS covers ${k}`)
})

test('codex bench spawns with a scrubbed env (codex authenticates from ~/.codex/auth.json)', () => {
  assert.match(SRC, /perlAlarmArgv\(timeoutSecs, \['codex'[\s\S]{0,200}spawnSync\('perl', argv, \{ env: scrubbedEnv\(\)/,
    'codex spawn passes env: scrubbedEnv()')
})

test('grok bench scrubs foreign secrets but keeps its own XAI key', () => {
  assert.ok(SRC.includes('const grokEnv = scrubbedEnv()'), 'grok starts from scrubbed env')
  assert.ok(SRC.includes('if (process.env.XAI_API_KEY) grokEnv.XAI_API_KEY = process.env.XAI_API_KEY'), 'own XAI restored')
  assert.match(SRC, /spawnSync\('perl', argv, \{ env: grokEnv,/, 'grok spawn uses the scrubbed+XAI env')
})

test('claude-family fullEnv starts from the scrubbed base, not raw process.env', () => {
  assert.ok(SRC.includes('...scrubbedEnv(),'), 'fullEnv base is scrubbed')
  assert.ok(!/const fullEnv = \{\s*\n\s*\.\.\.process\.env,/.test(SRC), 'no raw ...process.env base for the child')
})

// security-sweep M9 (2026-07-07): the OMLX bearer token must go through a 0600 curl -K config file,
// never `-H "Authorization: Bearer <tok>"` in argv (world-readable via ps / /proc cmdline).
test('OMLX bearer never rides in curl argv — routed through a 0600 -K config file', () => {
  assert.ok(SRC.includes('function curlAuthed('), 'curlAuthed helper exists')
  assert.match(SRC, /writeFileSync\(cfg, [^\n]*Authorization: Bearer[^\n]*\{ mode: 0o600 \}\)/,
    'header written to a 0600 config file')
  assert.match(SRC, /spawnSync\('curl', \['-K', cfg, \.\.\.baseArgv\]/, 'curl consumes the header via -K')
  assert.ok(SRC.includes('unlinkSync(cfg)'), 'config file is unlinked after use')
  // No remaining `-H`/argv form of the Authorization header anywhere in the file.
  assert.ok(!/'-H', `Authorization: Bearer/.test(SRC), 'no -H Authorization: Bearer in any curl argv')
})
