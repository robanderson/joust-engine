// Security regression test for #22 — command injection in the context bundler.
//
// node tournament-context-injection.test.mjs   (no deps; exits 0 on pass, 1 on fail)
//
// HOW IT PROVES THE FIX (drift-proof, exercises the SHIPPED code):
//   tournament.mjs has top-level `return`s, so it cannot be imported. We EXTRACT the exact
//   `contextCatCmd(files)` function SOURCE from the shipped file and eval it — no copy. We then
//   reproduce buildContext's real wrapping (mkdir + redirect into _context.md) and run it through a
//   REAL /bin/sh against temp dirs, with a context-file PATH that embeds a shell payload. The bug:
//   the path was interpolated unquoted into a double-quoted `echo "===== ${f} ====="`, so a path
//   containing $()/backticks executed. The fix emits the label via `printf '%s'` with q(f) as an
//   ARGUMENT, so the path is inert data. We assert the payload does NOT run, AND that benign bundling
//   (content + label, incl. paths with spaces and `$`) still works.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'tournament.mjs'), 'utf8')

// ---- extract the REAL contextCatCmd source from the shipped file (balanced-brace scan) ----
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

// the engine's q() (single-quote shell-escape); the extracted fn resolves it from global scope.
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'"
globalThis.q = q
// eslint-disable-next-line no-eval
const contextCatCmd = (0, eval)(`(${extractFn(SRC, 'contextCatCmd')})`)

// Reproduce buildContext's real wrapping around the cat join (tournament.mjs line ~137).
function bundleCmd(files, ctxDir, ctxPath) {
  const cat = contextCatCmd(files)
  return `mkdir -p ${q(ctxDir)} && { ${cat} ; } > ${q(ctxPath)} && wc -c ${q(ctxPath)} >/dev/null`
}

let failed = 0
const check = (name, cond) => { if (cond) console.log(`ok   - ${name}`); else { console.error(`FAIL - ${name}`); failed++ } }

// run a bundle for `files`, with cwd=root so any (mis)injected relative command lands in root.
function runBundle(files) {
  const root = mkdtempSync(join(tmpdir(), 'je-22-'))
  const ctxDir = join(root, '_context')
  const ctxPath = join(ctxDir, '_context.md')
  let err = null, bundle = ''
  try {
    execSync(bundleCmd(files, ctxDir, ctxPath), { shell: '/bin/sh', cwd: root, encoding: 'utf8', stdio: 'pipe' })
    bundle = existsSync(ctxPath) ? readFileSync(ctxPath, 'utf8') : ''
  } catch (e) { err = e }
  return { root, bundle, pwned: existsSync(join(root, 'PWNED')), cleanup: () => rmSync(root, { recursive: true, force: true }), err }
}

console.log('== tournament.mjs context-bundler injection (#22) ==')

// (1) INJECTION via $() in a context-file path must NOT execute.
{
  const r = runBundle(['x$(touch PWNED).txt'])
  check('(1) $(...) in a context path does NOT execute', r.pwned === false)
  r.cleanup()
}
// (1b) INJECTION via backticks must NOT execute.
{
  const r = runBundle(['y`touch PWNED`.txt'])
  check('(1b) backtick command in a context path does NOT execute', r.pwned === false)
  r.cleanup()
}

// (2) BENIGN: a real file's content and its `=====` label appear in the bundle.
{
  const root = mkdtempSync(join(tmpdir(), 'je-22-ok-'))
  const good = join(root, 'good.txt'); writeFileSync(good, 'BENIGN-CONTENT-12345\n')
  const ctxDir = join(root, '_context'); const ctxPath = join(ctxDir, '_context.md')
  execSync(bundleCmd([good], ctxDir, ctxPath), { shell: '/bin/sh', cwd: root, stdio: 'pipe' })
  const bundle = readFileSync(ctxPath, 'utf8')
  check('(2) benign file content is bundled', bundle.includes('BENIGN-CONTENT-12345'))
  check('(2) benign file label is present', bundle.includes(`===== ${good} =====`))
  rmSync(root, { recursive: true, force: true })
}

// (3) path with a SPACE: content bundled and full label not split.
{
  const root = mkdtempSync(join(tmpdir(), 'je-22-sp-'))
  const sp = join(root, 'a b.txt'); writeFileSync(sp, 'SPACED-CONTENT\n')
  const ctxDir = join(root, '_context'); const ctxPath = join(ctxDir, '_context.md')
  execSync(bundleCmd([sp], ctxDir, ctxPath), { shell: '/bin/sh', cwd: root, stdio: 'pipe' })
  const bundle = readFileSync(ctxPath, 'utf8')
  check('(3) spaced filename content bundled', bundle.includes('SPACED-CONTENT'))
  check('(3) spaced filename full label present', bundle.includes(`===== ${sp} =====`))
  rmSync(root, { recursive: true, force: true })
}

// (4) path containing `$` (benign, no parens): the label must NOT be mangled by var expansion.
{
  const root = mkdtempSync(join(tmpdir(), 'je-22-dol-'))
  const dol = join(root, 'lib$cfg.txt'); writeFileSync(dol, 'DOLLAR-CONTENT\n')
  const ctxDir = join(root, '_context'); const ctxPath = join(ctxDir, '_context.md')
  execSync(bundleCmd([dol], ctxDir, ctxPath), { shell: '/bin/sh', cwd: root, stdio: 'pipe' })
  const bundle = readFileSync(ctxPath, 'utf8')
  check('(4) $-filename content bundled', bundle.includes('DOLLAR-CONTENT'))
  check('(4) $-filename label not mangled by expansion', bundle.includes(`===== ${dol} =====`))
  rmSync(root, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
