// Regression test for D-0004 — carried-over (runner-backed) round-1 winner must not be dropped
// from the FINAL pool.
//
// node tournament-carryover.test.mjs   (no deps; exits 0 on pass, 1 on fail)
//
// HOW IT PROVES THE FIX (drift-proof, exercises the SHIPPED code):
//   tournament.mjs has top-level `return`s, so it cannot be imported as a module. So we EXTRACT the
//   exact `provCheckShell(...)` function SOURCE from the shipped file at runtime and eval it — no
//   copy, no mirror. We then run the shell snippet it produces through a REAL /bin/sh, reproducing
//   the engine's actual gate `[ "$D" -gt 0 ] && [ "$P" -eq 1 ]` against REAL temp dirs. That tests
//   the layer that actually matters end-to-end (the deterministic shell that writes a candidate's
//   content into the pool the judge reads), not just a JS boolean.
//
// The three required guardrail cases (asserted at the gate level):
//   (a) runner carryover, deliverable present, provenance log STRIPPED  -> POOLED  (the bug; was dropped)
//   (b) non-carryover runner, deliverable present, provenance log MISSING -> EXCLUDED (must stay broken)
//   (c) runner carryover, NO deliverable                                -> EXCLUDED (empty must stay out)
// Plus regression guards: a healthy non-carryover runner with a valid log stays POOLED, and a native
// (no-log) candidate is unchanged. Case (a) is the assertion that FAILS if the fix is reverted.

import { readFileSync } from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'tournament.mjs'), 'utf8')

// ---- extract the REAL provCheckShell source from the shipped file (balanced-brace scan) ----
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
// eslint-disable-next-line no-eval
const provCheckShell = (0, eval)(`(${extractFn(SRC, 'provCheckShell')})`)

// shell single-quote escape, matching the engine's q()
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'"

// A valid GLM success log (PROVENANCE + DONE exit=0, no TIMEOUT/ERROR), markers at column 0.
const GOOD_GLM_LOG =
  'JOUST-GLM-PROVENANCE endpoint=api.z.ai flag=--model opus\n' +
  '...work...\n' +
  'JOUST-GLM-DONE exit=0\n'

// Reproduce the engine's per-candidate gate for ONE candidate using the REAL provChk snippet.
// Returns { pooled: bool, d, p } — `pooled` is true iff content reached _pool.md (D>0 && P==1).
function runGate({ dispatch, carriedOver, writeDeliverable, writeLog, logContent }) {
  const root = mkdtempSync(join(tmpdir(), 'je-d0004-'))
  try {
    const ws = join(root, 'ws')      // the (post-staging) workspace the final pool re-validates
    const dest = join(root, 'dest')  // where staging copies it
    const pool = join(root, '_pool.md')
    mkdirSync(ws, { recursive: true })
    writeFileSync(pool, '')

    const logName = dispatch === 'glm' ? '_glm_run.log'
      : dispatch === 'local' ? '_local_run.log'
        : dispatch === 'codex' ? '_codex_run.log'
          : dispatch === 'minimax' ? '_minimax_run.log' : ''
    const tok = dispatch === 'glm' ? 'GLM' : dispatch === 'local' ? 'LOCAL'
      : dispatch === 'codex' ? 'CODEX' : dispatch === 'minimax' ? 'MINIMAX' : ''

    if (writeDeliverable) writeFileSync(join(ws, 'solution.txt'), 'a real validated deliverable\n')
    // Emulate the round-1 staging strip: the carryover ws here normally has NO log (it was deleted).
    // Only write the log when the test explicitly asks (the healthy non-carryover regression case).
    if (logName && writeLog) writeFileSync(join(ws, logName), logContent ?? GOOD_GLM_LOG)

    const lp = logName ? q(join(ws, logName)) : ''
    const provChk = provCheckShell(logName, tok, lp, !!carriedOver)

    // The EXACT gate the engine emits (stage-copy + strip + D + provChk + pool-append), reproduced here.
    const script = `
mkdir -p ${q(dest)}; cp -R ${q(ws)}/. ${q(dest)}/ 2>/dev/null;
rm -f ${q(dest)}/_brief.txt ${q(dest)}/_glm_run.log ${q(dest)}/_local_run.log ${q(dest)}/_codex_run.log ${q(dest)}/_codex_last.txt ${q(dest)}/_minimax_run.log;
D=$(find ${q(dest)} -type f 2>/dev/null | grep -c .); ${provChk};
if [ "$D" -gt 0 ] && [ "$P" -eq 1 ]; then { echo "===== Candidate X ====="; cat ${q(dest)}/* 2>/dev/null; echo; } >> ${q(pool)}; fi;
echo "JEV X d=$([ "$D" -gt 0 ] && echo 1 || echo 0) p=$P"
`
    const out = execSync(script, { shell: '/bin/sh', encoding: 'utf8' }).trim()
    const m = out.match(/JEV X d=(\d) p=(\d)/)
    if (!m) throw new Error(`unexpected gate output: ${out}`)
    const poolBody = readFileSync(pool, 'utf8')
    return { d: Number(m[1]), p: Number(m[2]), pooled: poolBody.includes('===== Candidate X =====') }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- assertions ----
let failed = 0
function check(name, cond) {
  if (cond) { console.log(`ok   - ${name}`) } else { console.error(`FAIL - ${name}`); failed++ }
}

// (a) THE FIX: runner-backed carryover with a deliverable but a STRIPPED/absent provenance log -> VALID/pooled.
//     This is the assertion that FAILS if the fix is reverted (carriedOver flag removed / not threaded).
for (const dispatch of ['glm', 'codex', 'minimax', 'local']) {
  const r = runGate({ dispatch, carriedOver: true, writeDeliverable: true, writeLog: false })
  check(`(a) ${dispatch} carryover, deliverable, stripped log -> P=1 & pooled`, r.p === 1 && r.d === 1 && r.pooled === true)
}

// (b) GUARDRAIL: non-carryover runner candidate MISSING its provenance log stays INVALID/excluded.
for (const dispatch of ['glm', 'codex', 'minimax', 'local']) {
  const r = runGate({ dispatch, carriedOver: false, writeDeliverable: true, writeLog: false })
  check(`(b) ${dispatch} non-carryover, deliverable, missing log -> P=0 & NOT pooled`, r.p === 0 && r.pooled === false)
}

// (c) GUARDRAIL: a carryover with NO deliverable stays INVALID/excluded (provenance skipped, but D=0 gate holds).
for (const dispatch of ['glm', 'codex', 'minimax', 'local']) {
  const r = runGate({ dispatch, carriedOver: true, writeDeliverable: false, writeLog: false })
  check(`(c) ${dispatch} carryover, NO deliverable -> P=1 but D=0 so NOT pooled`, r.d === 0 && r.pooled === false)
}

// regression guard: a HEALTHY non-carryover runner (valid log + deliverable) is still pooled — the
// normal round-1/round-2 validation path is byte-for-byte unchanged.
{
  const r = runGate({ dispatch: 'glm', carriedOver: false, writeDeliverable: true, writeLog: true, logContent: GOOD_GLM_LOG })
  check('(reg) glm healthy non-carryover (valid log) -> pooled', r.p === 1 && r.pooled === true)
}
// regression guard: a non-carryover runner whose log shows a FAILURE (TIMEOUT) stays excluded.
{
  const badLog = 'JOUST-GLM-PROVENANCE endpoint=api.z.ai\nJOUST-GLM-TIMEOUT secs=300\nJOUST-GLM-DONE exit=124\n'
  const r = runGate({ dispatch: 'glm', carriedOver: false, writeDeliverable: true, writeLog: true, logContent: badLog })
  check('(reg) glm non-carryover with TIMEOUT log -> NOT pooled', r.p === 0 && r.pooled === false)
}
// regression guard: native Anthropic candidate (no log) -> P=1 unconditionally, unchanged; flag is a no-op for native.
{
  const native = runGate({ dispatch: 'anthropic', carriedOver: false, writeDeliverable: true, writeLog: false })
  const nativeCarry = runGate({ dispatch: 'anthropic', carriedOver: true, writeDeliverable: true, writeLog: false })
  check('(reg) native non-carryover -> P=1 & pooled', native.p === 1 && native.pooled === true)
  check('(reg) native carryover (flag is no-op for native) -> P=1 & pooled', nativeCarry.p === 1 && nativeCarry.pooled === true)
}

// PURE-string guard: the carryover branch emits literally `P=1` (no grep of the stripped dir),
// while the non-carryover runner branch keeps the line-anchored success contract intact.
check('(pure) carryover GLM snippet is exactly "P=1"', provCheckShell('_glm_run.log', 'GLM', "'/x/_glm_run.log'", true) === 'P=1')
check('(pure) native snippet is exactly "P=1"', provCheckShell('', '', '', false) === 'P=1')
{
  const normal = provCheckShell('_codex_run.log', 'CODEX', "'/x/_codex_run.log'", false)
  check('(pure) non-carryover runner snippet still greps the anchored success contract',
    normal.includes("grep -q '^JOUST-CODEX-PROVENANCE endpoint='") &&
    normal.includes("grep -q '^JOUST-CODEX-DONE exit=0'") &&
    // run E: KILLED joined the fail-closed reject set (watchdog kills); -RETRY is non-terminal and
    // deliberately NOT rejected, so a try that succeeds after a retry still passes the gate.
    normal.includes("! grep -q '^JOUST-CODEX-\\(TIMEOUT\\|ERROR\\|KILLED\\)'"))
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
