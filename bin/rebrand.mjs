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
import os from 'node:os'
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
// security-sweep H14 (2026-07-07; relaxed 2026-07-10): the wipe below is `fs.rmSync(OUT, {recursive,
// force})`, so OUT must be a SAFE, disposable scratch location — never the repo, an ANCESTOR of it,
// the fs root, an arbitrary tree (`$HOME`, `/etc`, `..`), or a symlink we'd follow out of. ALLOWED
// roots: strictly UNDER the repo root (default .dev-engine) OR under a system temp dir. H14 first
// permitted ONLY under-repo, which broke the .gitea publish/rebrand-check workflows that legitimately
// build into /tmp (rebrand exited 2 before doing any work — the dev marketplace stopped publishing);
// this restores the temp-dir path while keeping every dangerous target refused.
{
  const outReal = path.resolve(OUT)
  const rootReal = path.resolve(ROOT)
  const isUnder = (parent, child) => {
    const rel = path.relative(parent, child)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  // Known system temp roots, plus their realpaths (macOS /tmp -> /private/tmp; honours $TMPDIR).
  const tmpRoots = [...new Set(['/tmp', '/private/tmp', '/var/tmp', os.tmpdir()].flatMap(p => {
    try { return [path.resolve(p), fs.realpathSync(p)] } catch { return [path.resolve(p)] }
  }))]
  const inSafeRoot = isUnder(rootReal, outReal) || tmpRoots.some(t => isUnder(t, outReal))
  const rootIsUnderOut = (() => { const r = path.relative(outReal, rootReal); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) })()
  if (!inSafeRoot || rootIsUnderOut || outReal === path.parse(outReal).root) {
    console.error(`rebrand: --out must be strictly UNDER the repo root or a system temp dir (got "${OUT}" → ${outReal}); refusing to rm -rf an arbitrary tree`); process.exit(2)
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
// The published @@DE dev version is <next-JE-patch>-dev.<build> — human-checkable and ordered, so you
// can confirm `/reload-plugins` pulled the newest build by eye (e.g. 0.1.1-dev.7 > 0.1.1-dev.6). The
// base bump (devVersionBase) and the resetting build counter (devBuildNumber) are each documented at
// their function below. A local `node bin/rebrand.mjs` with no reachable tag / CI env falls back to a
// `local.<timestamp>` tag: still unique (a same-path regen busts the cache), clearly non-CI.
const baseVer = JSON.parse(
  fs.readFileSync(path.join(ROOT, cfg.versionBaseFrom || '.claude-plugin/plugin.json'), 'utf8')
).version || '0.0.0'
// Dev-channel base (cfg.devPatchBump): publish as a PRERELEASE of the NEXT patch of the canonical
// release (X.Y.Z -> X.Y.(Z+1)), so a @@DE dev build sorts ABOVE the current @@JE release (X.Y.Z) and
// BELOW the next (X.Y.(Z+1)). This keeps the two channels in lockstep: whenever @@JE bumps its patch,
// @@DE's base advances with it (e.g. JE 0.1.0 -> DE 0.1.1-dev.N; JE releases 0.1.1 -> DE 0.1.2-dev.N).
// A malformed (non X.Y.Z) base falls back to verbatim, never crashing the publish. PURE + sliceable.
function devVersionBase(ver, bump) {
  if (!bump) return ver
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(ver == null ? '' : ver).trim())
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : ver
}
// build number (cfg.devBuildFromCommits): commits since the latest release tag
// (`git rev-list <tag>..HEAD --count`), so the dev number RESETS to a small value after each JE patch
// release — 0.1.1-dev.1, dev.2, …, then a JE 0.1.1 release rolls the base to 0.1.2 and the count
// resets: 0.1.2-dev.1. Requires tags + history in the checkout (CI uses fetch-depth: 0). Falls back
// to the CI run number, then a local timestamp, when no tag is reachable (a branch with no tag
// ancestor) or git is unavailable. Cache-bust note: a NEW commit always yields a higher count => a
// new version => Claude Code's version-keyed cache re-pulls; re-publishing the SAME commit yields the
// same version AND identical content (correct). The one degenerate case is two SIBLING branches at
// the exact same tag-distance (same count, different content) — rare on a single-dev channel; if a
// dev build's version looks unchanged after such a push, force a re-pull.
function devBuildNumber() {
  if (cfg.devBuildFromCommits) {
    try {
      const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, encoding: 'utf8' })
      if (tag.status === 0 && tag.stdout.trim()) {
        const cnt = spawnSync('git', ['rev-list', `${tag.stdout.trim()}..HEAD`, '--count'], { cwd: ROOT, encoding: 'utf8' })
        if (cnt.status === 0 && /^\d+$/.test(cnt.stdout.trim())) return cnt.stdout.trim()
      }
    } catch { /* git absent / not a repo -> fall through to the CI/local fallback */ }
  }
  return process.env.DEV_BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || `local.${Date.now()}`
}
const build = devBuildNumber()
const stampedVer = `${devVersionBase(baseVer, cfg.devPatchBump)}-dev.${build}`
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
