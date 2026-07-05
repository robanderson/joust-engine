import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

function extractFn(name) {
  const sig = `function ${name}(`
  const start = SRC.indexOf(sig)
  if (start < 0) throw new Error(`could not find ${sig}`)
  let i = SRC.indexOf('{', start), depth = 0
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1) }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

test('lensPrompt calls pinnedScopeBlock (council path pinned)', () => {
  assert.match(extractFn('lensPrompt'), /pinnedScopeBlock\(/)
})
test('judgePrompt calls pinnedScopeBlock (legacy judges:1 path pinned too)', () => {
  assert.match(extractFn('judgePrompt'), /pinnedScopeBlock\(/)
})
test('pinnedScopeBlock forbids the live checkout', () => {
  assert.match(extractFn('pinnedScopeBlock'), /FORBIDDEN.*live/)
})
test('pinnedScopeBlock states the base SHA in repoMode', () => {
  assert.match(extractFn('pinnedScopeBlock'), /baseSha/)
})
test('reconcile() (legacy path) is wired to the roots check for forward-compatibility', () => {
  assert.match(extractFn('reconcile'), /checksRunRootsIssue/)
})
test('the legacy judge() call site passes allowedRootsFor into reconcile', () => {
  assert.ok(SRC.includes('allowedRootsFor(blindList, poolPath, repoMode, worktreeRoot)'))
})
