#!/usr/bin/env node
// scripts/run-tests.mjs — the single entry point for the deterministic test suite.
//
// This is "CI lane 1a" (see issue #6): it runs every Layer-A test — the parser,
// git/gh helpers, contribution math, output parsing, key-hygiene guards — which
// are plain `node`/`bash` programs that call NO model and need NO network. It does
// NOT exercise skill behaviour (Layer B); that is an evals concern, not a unit test.
//
// The repo's tests use three different shapes (node:test, a hand-rolled assert
// harness, and bash), but every one of them already reports pass/fail through its
// PROCESS EXIT CODE. So the runner is deliberately dumb: discover the files, spawn
// each with the right interpreter (`node` for *.test.mjs, `bash` for *.test.sh),
// and fail the run if any child exits non-zero. No test framework, no dependencies.
//
// Usage:  node scripts/run-tests.mjs           (run everything)
//         node scripts/run-tests.mjs bin        (only files whose path contains "bin")
// Exits 0 iff every test passed.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Directories that hold tests, paired with how each file type is launched.
const TEST_DIRS = ['workflows', 'bin']
const RUNNERS = [
  { suffix: '.test.mjs', cmd: 'node' },
  { suffix: '.test.sh', cmd: 'bash' },
]

// Discover test files deterministically (sorted) so output order is stable.
function discover() {
  const found = []
  for (const dir of TEST_DIRS) {
    let entries
    try {
      entries = readdirSync(join(ROOT, dir))
    } catch {
      continue // a directory may not exist in every checkout
    }
    for (const name of entries.sort()) {
      const runner = RUNNERS.find((r) => name.endsWith(r.suffix))
      if (runner) found.push({ path: join(ROOT, dir, name), cmd: runner.cmd })
    }
  }
  return found
}

const filter = process.argv[2] // optional substring filter on the relative path
const tests = discover().filter((t) => !filter || relative(ROOT, t.path).includes(filter))

if (tests.length === 0) {
  console.error(filter ? `No tests match "${filter}".` : 'No tests discovered.')
  process.exit(1)
}

const isCI = !!process.env.GITHUB_ACTIONS
let failed = 0
const t0 = Date.now()

for (const { path, cmd } of tests) {
  const rel = relative(ROOT, path)
  // GitHub Actions collapses ::group:: blocks; locally they're just plain lines.
  if (isCI) console.log(`::group::${cmd} ${rel}`)
  else process.stdout.write(`▸ ${cmd} ${rel}\n`)

  const r = spawnSync(cmd, [path], { stdio: 'inherit', cwd: ROOT })
  const ok = r.status === 0 && !r.error
  if (isCI) console.log('::endgroup::')
  if (!ok) {
    failed++
    const why = r.error ? r.error.message : `exit ${r.status}`
    console.error(`✗ FAIL  ${rel}  (${why})`)
  } else {
    console.log(`✓ pass  ${rel}`)
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n${tests.length - failed}/${tests.length} test files passed in ${secs}s`)
process.exit(failed === 0 ? 0 : 1)
