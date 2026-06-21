// Security regression test for #23 — symlink/special-file exfiltration via the staging pool `cat`.
//
// node tournament-staging-symlink.test.mjs   (no deps; exits 0 on pass, 1 on fail)
//
// TWO layers:
//  (1) STRUCTURAL (drift guard): assert the shipped workflows/tournament.mjs staging contains the fix
//      — the non-regular-file strip line and the `find -type f -print0 | xargs -0 cat` pool read — and
//      that the old `cat ${q(dest)}/*` deref read and the unguarded contextFiles `cat` are gone.
//  (2) BEHAVIORAL: reproduce the FIXED staging shell (same structure the engine emits) through a real
//      /bin/sh against temp dirs, planting a symlink-to-a-secret AND a FIFO in the workspace, and prove
//      the secret is NOT pooled, the FIFO does not hang the reader, and a genuine regular deliverable IS
//      pooled. A VULNERABLE reconstruction (old `cat dest/*`, symlink only) confirms the test discriminates.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'tournament.mjs'), 'utf8')

let failed = 0
const check = (name, cond) => { if (cond) console.log(`ok   - ${name}`); else { console.error(`FAIL - ${name}`); failed++ } }

console.log('== tournament.mjs staging symlink exfiltration (#23) ==')

// (1) STRUCTURAL — these literal substrings must be present/absent in the shipped source.
check('(struct) strip line for non-regular files present',
  SRC.includes('-mindepth 1 ! -type f ! -type d -delete'))
check('(struct) pool read uses find -type f -print0 | xargs -0 cat',
  SRC.includes('-type f -print0 2>/dev/null | xargs -0 cat'))
check('(struct) old deref read `cat ${q(dest)}/*` is gone',
  !SRC.includes('cat ${q(dest)}/*'))
check('(struct) contextFiles read is guarded by [ ! -L ] && [ -f ]',
  SRC.includes('[ ! -L ${q(f)} ] && [ -f ${q(f)} ]'))

// Helper: stage one workspace through a reconstruction of the engine's per-candidate shell, return pool text.
const RM = 'rm -f "$DEST"/_brief.txt "$DEST"/_glm_run.log "$DEST"/_local_run.log "$DEST"/_codex_run.log "$DEST"/_codex_last.txt "$DEST"/_minimax_run.log'
function stage({ fixed, withFifo }) {
  const root = mkdtempSync(join(tmpdir(), 'je-23-'))
  const ws = join(root, 'ws'); const dest = join(root, 'dest'); const pool = join(root, '_pool.md')
  const secret = join(root, 'secret.txt')
  mkdirSync(ws, { recursive: true }); writeFileSync(pool, '')
  writeFileSync(secret, 'TOPSECRET-API-KEY-12345')
  writeFileSync(join(ws, 'answer.md'), '# real answer\nhello-deliverable\n')   // genuine regular deliverable
  symlinkSync(secret, join(ws, 'leak.md'))                                     // planted symlink to a host secret
  const fifo = withFifo ? `mkfifo "${join(ws, 'pipe.md')}" 2>/dev/null;` : ''
  const strip = fixed ? `find "$DEST" -mindepth 1 ! -type f ! -type d -delete 2>/dev/null;` : ''
  const read = fixed
    ? `find "$DEST" -type f -print0 2>/dev/null | xargs -0 cat 2>/dev/null`
    : `cat "$DEST"/* 2>/dev/null`
  const script = `
set -u
WS="${ws}"; DEST="${dest}"; POOL="${pool}"
${fifo}
mkdir -p "$DEST"; cp -R "$WS"/. "$DEST"/ 2>/dev/null;
${RM};
${strip}
D=$(find "$DEST" -type f 2>/dev/null | grep -c .);
if [ "$D" -gt 0 ]; then { echo "===== Candidate A ====="; ${read}; echo; } >> "$POOL"; fi;
echo "JEV d=$D"
`
  let out = '', err = null
  try { out = execSync(script, { shell: '/bin/sh', encoding: 'utf8', timeout: 10000 }) } catch (e) { err = e }
  const pooled = readFileSync(pool, 'utf8')
  rmSync(root, { recursive: true, force: true })
  return { out, err, pooled, d: Number((out.match(/JEV d=(\d+)/) || [])[1]) }
}

// (2a) VULNERABLE reconstruction (symlink only) — confirms the repro actually detects exfiltration.
{
  const r = stage({ fixed: false, withFifo: false })
  check('(disc) vulnerable staging DOES leak the secret (test is meaningful)',
    r.pooled.includes('TOPSECRET-API-KEY-12345'))
}

// (2b) FIXED reconstruction with a symlink AND a FIFO — the real assertions.
{
  const r = stage({ fixed: true, withFifo: true })
  check('(fixed) secret is NOT exfiltrated into the pool', !r.pooled.includes('TOPSECRET-API-KEY-12345'))
  check('(fixed) genuine regular deliverable IS pooled', r.pooled.includes('hello-deliverable'))
  check('(fixed) D counts only the regular file (D=1)', r.d === 1)
  check('(fixed) FIFO did not hang the reader (completed under timeout)', r.err === null)
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
