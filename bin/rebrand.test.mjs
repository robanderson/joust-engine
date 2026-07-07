// rebrand.mjs dev-channel version derivation (extract-and-eval, repo convention).
// The @@DE dev marketplace publishes as a PRERELEASE of the NEXT patch of the canonical @@JE
// release (devPatchBump), keeping the two channels in lockstep; a monotonic run# stays the build
// suffix (unique => busts the version-keyed plugin cache).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'rebrand.mjs'), 'utf8')
const CFG = JSON.parse(readFileSync(resolve(HERE, '..', 'rebrand.config.json'), 'utf8'))

// slice the PURE devVersionBase() out of the script and eval it in isolation
const i = SRC.indexOf('function devVersionBase(')
const j = SRC.indexOf('\n}', i) + 2
assert.ok(i > -1 && j > i, 'devVersionBase present in rebrand.mjs')
const devVersionBase = new Function(`${SRC.slice(i, j)}\nreturn devVersionBase;`)()

test('devVersionBase: bump=true increments the PATCH (prerelease of the next release)', () => {
  assert.equal(devVersionBase('0.1.0', true), '0.1.1')
  assert.equal(devVersionBase('0.1.1', true), '0.1.2')   // after a JE 0.1.1 release, DE base advances
  assert.equal(devVersionBase('1.2.3', true), '1.2.4')
})

test('devVersionBase: numeric patch (not string) — 0.1.9 -> 0.1.10, never 0.1.91', () => {
  assert.equal(devVersionBase('0.1.9', true), '0.1.10')
})

test('devVersionBase: bump=false is verbatim (a plain rebrand keeps the base)', () => {
  assert.equal(devVersionBase('0.1.0', false), '0.1.0')
  assert.equal(devVersionBase('2.0.0', undefined), '2.0.0')
})

test('devVersionBase: malformed (non X.Y.Z) falls back to verbatim, never crashes', () => {
  assert.equal(devVersionBase('weird', true), 'weird')
  assert.equal(devVersionBase('', true), '')
  assert.equal(devVersionBase(null, true), null)
})

test('the dev config opts INTO the patch bump + commits-based reset (channels stay in lockstep)', () => {
  assert.equal(CFG.devPatchBump, true, 'rebrand.config.json sets devPatchBump')
  assert.equal(CFG.devBuildFromCommits, true, 'rebrand.config.json sets devBuildFromCommits')
})

test('the dev build number RESETS via commits-since-latest-tag, with a run#/timestamp fallback', () => {
  assert.match(SRC, /\$\{devVersionBase\(baseVer, cfg\.devPatchBump\)\}-dev\.\$\{build\}/,
    'stampedVer = <bumped base>-dev.<build>')
  const i = SRC.indexOf('function devBuildNumber(')
  const blk = SRC.slice(i, SRC.indexOf('\nconst build = devBuildNumber()', i))
  assert.match(blk, /if \(cfg\.devBuildFromCommits\)/, 'commits-based counter is opt-in via config')
  assert.match(blk, /git['"\s,]+.*describe['"\s,]+.*--tags/s, 'derives the latest release tag')
  assert.match(blk, /rev-list['"`,\s]+.*\.\.HEAD['"`,\s]+.*--count/s, 'counts commits since that tag (resets each release)')
  assert.match(blk, /process\.env\.DEV_BUILD_NUMBER \|\| process\.env\.GITHUB_RUN_NUMBER \|\| `local\./,
    'falls back to CI run number then a local timestamp when no tag is reachable')
})
