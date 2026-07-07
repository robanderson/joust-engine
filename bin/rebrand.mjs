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
// security-sweep H14 (2026-07-07): the wipe below is `fs.rmSync(OUT, {recursive,force})`. The old
// guard only blocked OUT===ROOT, so `--out ..` (an ANCESTOR of the repo), `--out /tmp/x`, or a
// symlinked OUT would force-delete an arbitrary tree. Refuse: OUT must be a NON-symlink path that is
// strictly UNDER the repo root and is NOT an ancestor of it (belt: also reject the fs root).
{
  const outReal = path.resolve(OUT)
  const rootReal = path.resolve(ROOT)
  const rel = path.relative(rootReal, outReal)
  const outIsUnderRoot = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  const rootIsUnderOut = (() => { const r = path.relative(outReal, rootReal); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) })()
  if (!outIsUnderRoot || rootIsUnderOut || outReal === path.parse(outReal).root) {
    console.error(`rebrand: --out must be a path strictly UNDER the repo root (got "${OUT}" → ${outReal}); refusing to rm -rf outside the tree`); process.exit(2)
  }
  try { if (fs.lstatSync(outReal).isSymbolicLink()) { console.error(`rebrand: --out is a symlink (${outReal}); refusing`); process.exit(2) } } catch { /* not existing yet = fine */ }
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
      const out = to + relPosix.slice(from.length)
      // security-sweep M10 (2026-07-07): a renameDirs `to` with `..`/absolute would join OUTSIDE the
      // generated tree (write escape). Reject a non-relative or traversing result (config is trusted,
      // but this closes a mistake/tamper vector cheaply).
      if (out.startsWith('/') || out.split('/').includes('..')) {
        console.error(`rebrand: renameDirs maps "${from}" -> "${to}" producing an unsafe path "${out}" (absolute or ..); fix rebrand.config.json`); process.exit(2)
      }
      return out
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
// SEQUENTIAL build number: in CI the publish workflow provides DEV_BUILD_NUMBER (=
// GITHUB_RUN_NUMBER, which Gitea/GitHub Actions increment monotonically per run), so the
// published dev-marketplace version is human-checkable and ordered — you can confirm
// `/reload-plugins` pulled the newest build by eye (0.0.1-dev.7 > 0.0.1-dev.6). A local
// `node bin/rebrand.mjs` (no CI env) falls back to a `local.<timestamp>` tag: still unique
// (so a same-path regen busts the cache) and clearly distinguished from a CI build.
const baseVer = JSON.parse(
  fs.readFileSync(path.join(ROOT, cfg.versionBaseFrom || '.claude-plugin/plugin.json'), 'utf8')
).version || '0.0.0'
const build = process.env.DEV_BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || `local.${Date.now()}`
const stampedVer = `${baseVer}-dev.${build}`
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

// security-sweep M11 (2026-07-07): selfTest entries are spawned. Restrict the COMMAND to the known
// test interpreters so a tampered/mistaken config cannot turn self-verify into arbitrary-binary
// execution. (glob entries expand to ['node'|'bash', <file>] already; a non-glob entry must too.)
const SELFTEST_CMDS = new Set(['node', 'bash'])
const tests = []
for (const entry of (cfg.selfTest || [])) {
  if (entry[0] === 'glob') tests.push(...expandGlob(entry[1]))
  else if (SELFTEST_CMDS.has(entry[0])) tests.push(entry)
  else { console.error(`rebrand: selfTest command "${entry[0]}" not allowed (only ${[...SELFTEST_CMDS].join('/')}); fix rebrand.config.json`); process.exit(2) }
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
