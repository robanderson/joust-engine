// Run O (2026-07-07): prompt-lab judge-lens A/B hook — args.lensVariant swaps ONE whitelisted
// paragraph into lensPrompt (prompt-lab 03/V2 evidence-quota); anything else runs production.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

test('variant selection is a closed whitelist — an unrecognised value silently runs production', () => {
  assert.ok(SRC.includes(`const LENS_VARIANT = String(A.lensVariant || '') === 'evidence-quota' ? 'evidence-quota' : ''`),
    'exact-match whitelist, never a passthrough of caller text into the prompt')
})

test('the variant inserts ONE paragraph into the shared-scoring slot; everything else stays byte-identical', () => {
  assert.ok(SRC.includes("${LENS_VARIANT ? LENS_VARIANT_BLOCKS[LENS_VARIANT] : ''}"), 'single insertion point')
  const i = SRC.indexOf('EVIDENCE QUOTA (hard)')
  assert.ok(i > 0, 'V2 text present')
  assert.ok(SRC.indexOf('EVIDENCE QUOTA (hard)', i + 1) < 0, 'exactly one copy — the block, not a fork of lensPrompt')
  // production tail of the scoring paragraph is untouched (variant appends, never rewrites)
  assert.ok(SRC.includes('do not reward length or verbosity per se.${LENS_VARIANT'), 'production text preserved verbatim')
})

test('the arm is recorded: rejudge mapping.json and the result carry lens_variant when set', () => {
  const n = SRC.split('...(LENS_VARIANT ? { lens_variant: LENS_VARIANT } : {})').length - 1
  assert.ok(n >= 3, `variant tag rides every rejudge mapping persist + the result (found ${n})`)
})
