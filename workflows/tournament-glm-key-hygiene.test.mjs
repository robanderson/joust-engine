// Security regression test for #25 — no API-key reference may reach agent-visible command text.
//
// node tournament-glm-key-hygiene.test.mjs   (no deps; exits 0 on pass, 1 on fail)
//
// The GLM inline fallback baked `ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"` into a command STRING handed to a
// wrapper sub-agent. The fix deletes it: every provider goes through its bundled runner script, which
// reads the key from the ENV inside the script — the wrapper only ever sees a benign `bash <runner>`.
// This is a structural guard: the engine source must contain NO provider-key reference and NO glmInline,
// and the GLM dispatch must go through the runner (fail-closed when the runner is absent).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'tournament.mjs'), 'utf8')

let failed = 0
const check = (name, cond) => { if (cond) console.log(`ok   - ${name}`); else { console.error(`FAIL - ${name}`); failed++ } }

console.log('== tournament.mjs GLM key hygiene (#25) ==')

// The #25 key (ZAI_API_KEY) was interpolated only by glmInline; after the fix it must be entirely absent
// from the engine source (it now lives ONLY inside bin/glm-run.sh, read from the env there).
check('no ZAI_API_KEY reference in tournament.mjs', !SRC.includes('ZAI_API_KEY'))

// The real vuln pattern: a secret env-var assigned from a `$`-expansion INSIDE a command string handed to
// an agent (e.g. `ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"`). No such interpolation may exist in the engine.
// (A benign prose mention of a key name in a // comment is fine — only the assignment-from-expansion leaks.)
check('no secret env-var interpolated into an agent-visible command string',
  !/(API_KEY|AUTH_TOKEN)\s*=\s*["']?\$/.test(SRC))

// The inline fallback (the only construct that interpolated the key) must be gone.
check('glmInline function removed', !SRC.includes('glmInline'))

// GLM dispatch must go through the runner script, and fail-closed (no insecure inline path) when absent.
check('GLM dispatch builds via runnerCmd(glmRunner, ...)', SRC.includes('runnerCmd(glmRunner,'))
check('GLM dispatch fails closed when glmRunner is absent', /if\s*\(!glmRunner\)/.test(SRC))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
