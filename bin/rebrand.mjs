#!/usr/bin/env node
// rebrand.mjs — generate a renamed, coexisting copy of this plugin.
//
// Reads the canonical plugin tree (this repo) and writes a fully self-contained,
// token-renamed copy into an out-dir (default <repo>/.dev-engine) so it can be
// added as a SEPARATE Claude Code marketplace/plugin that runs side-by-side with
// the canonical one — the "@@DE Development Engine" channel.
//
//   - Canonical source is NEVER modified (out-dir is gitignored) => `git status`
//     stays clean => the same commit still promotes to GitHub unchanged.
//   - Always reads canonical / writes fresh (the out-dir is wiped first), so it
//     can never double-apply its own output.
//   - Stamps a unique version into the generated manifests so Claude Code's
//     version-keyed plugin cache (~/.claude/plugins/cache) re-pulls every run.
//   - Self-verifies by running the GENERATED tree's own tests; exits non-zero on
//     any failure (a broken transform must fail loudly, esp. in CI).
//
// Usage:
//   node bin/rebrand.mjs [--out <dir>] [--config <path>] [--no-test]
//
// This is a normal Node script (NOT a workflow script), so Date.now()/git are fine.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2)
const getFlag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? '') : undefined
}
const noTest = argv.includes('--no-test')
const configPath = path.resolve(ROOT, getFlag('--config') ?? 'rebrand.config.json')
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const OUT = path.resolve(ROOT, getFlag('--out') ?? '.dev-engine')

// ---- guards --------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, '.claude-plugin', 'plugin.json'))) {
  console.error(`rebrand: ${ROOT} is not a plugin root (no .claude-plugin/plugin.json)`) ; process.exit(2)
}
if (path.resolve(OUT) === ROOT) {
  console.error('rebrand: --out must not be the repo root'); process.exit(2)
}

const excludeDirs = new Set(cfg.excludeDirs || [])
const excludeFiles = new Set(cfg.excludeFiles || [])
const replacements = cfg.replacements || []
const renameDirs = cfg.renameDirs || []

// ---- transforms ----------------------------------------------------------
const applyReplacements = (s) => {
  for (const [from, to] of replacements) s = s.split(from).join(to)
  return s
}
// Rename a POSIX-style relative path by longest-matching dir-prefix rule.
const renameRel = (relPosix) => {
  for (const [from, to] of renameDirs) {
    if (relPosix === from || relPosix.startsWith(from + '/')) {
      return to + relPosix.slice(from.length)
    }
  }
  return relPosix
}

// ---- wipe + recreate out-dir (fresh every run) ---------------------------
const OUT_REAL = path.resolve(OUT)
fs.rmSync(OUT_REAL, { recursive: true, force: true })
fs.mkdirSync(OUT_REAL, { recursive: true })

// ---- walk canonical tree -------------------------------------------------
let fileCount = 0
const walk = (absDir) => {
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, ent.name)
    if (path.resolve(abs) === OUT_REAL) continue // never descend into the out-dir
    if (ent.isSymbolicLink()) {
      // Recreate symlinks verbatim (targets are runtime-relative; none brand-bearing today).
      const relPosix = path.relative(ROOT, abs).split(path.sep).join('/')
      const dest = path.join(OUT_REAL, ...renameRel(relPosix).split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try { fs.symlinkSync(fs.readlinkSync(abs), dest) } catch { /* best-effort */ }
      continue
    }
    if (ent.isDirectory()) {
      if (excludeDirs.has(ent.name)) continue
      walk(abs)
      continue
    }
    if (!ent.isFile() || excludeFiles.has(ent.name)) continue
    const relPosix = path.relative(ROOT, abs).split(path.sep).join('/')
    const destRel = renameRel(relPosix)
    const dest = path.join(OUT_REAL, ...destRel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const buf = fs.readFileSync(abs)
    // Everything in this repo is UTF-8 text; transform all, preserving mode.
    fs.writeFileSync(dest, applyReplacements(buf.toString('utf8')))
    fs.chmodSync(dest, fs.statSync(abs).mode & 0o777)
    fileCount++
  }
}
walk(ROOT)

// ---- stamp a unique version (defeat the version-keyed plugin cache) ------
const baseVer = JSON.parse(
  fs.readFileSync(path.join(ROOT, cfg.versionBaseFrom || '.claude-plugin/plugin.json'), 'utf8')
).version || '0.0.0'
const stampedVer = `${baseVer}-dev.${Date.now()}`
for (const rel of (cfg.stampVersionIn || [])) {
  const p = path.join(OUT_REAL, ...rel.split('/'))
  if (!fs.existsSync(p)) continue
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  j.version = stampedVer
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n')
}

console.log(`rebrand: ${fileCount} files -> ${OUT_REAL}`)
console.log(`rebrand: brand=${cfg.brand?.plugin ?? '?'} sigil=${cfg.brand?.sigil ?? '?'} version=${stampedVer}`)

// ---- self-verify: run the GENERATED tree's own tests ---------------------
if (noTest) { console.log('rebrand: --no-test set, skipping self-verify'); process.exit(0) }

const expandGlob = (pattern) => {
  // supports "dir/*.ext"
  const [dir, base] = [path.posix.dirname(pattern), path.posix.basename(pattern)]
  const suffix = base.startsWith('*') ? base.slice(1) : base
  const absDir = path.join(OUT_REAL, ...dir.split('/'))
  if (!fs.existsSync(absDir)) return []
  return fs.readdirSync(absDir).filter(f => f.endsWith(suffix)).sort()
    .map(f => ['node', `${dir}/${f}`])
}

const tests = []
for (const entry of (cfg.selfTest || [])) {
  if (entry[0] === 'glob') tests.push(...expandGlob(entry[1]))
  else tests.push(entry)
}

let failed = 0
console.log(`rebrand: self-verify — ${tests.length} test file(s) in the generated tree`)
for (const [cmd, ...rest] of tests) {
  const r = spawnSync(cmd, rest, { cwd: OUT_REAL, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const ok = r.status === 0
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${cmd} ${rest.join(' ')}`)
  if (!ok) {
    const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-25).join('\n')
    console.log(tail.split('\n').map(l => '        ' + l).join('\n'))
  }
}
if (failed) {
  console.error(`rebrand: SELF-VERIFY FAILED — ${failed}/${tests.length} test file(s) failed. The transform is incoherent; do NOT use this .dev-engine tree.`)
  process.exit(1)
}
console.log('rebrand: self-verify PASSED — generated tree is coherent.')
