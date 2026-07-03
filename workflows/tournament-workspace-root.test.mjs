// Structural regression tests for issue #34: self-contained candidate WORKSPACES relocated
// outside ~/.claude/ (the user config dir / plugin cache), mirroring the #44 worktreeRoot fix.
//
// node tournament-workspace-root.test.mjs   (no deps; exits 0 on pass, 1 on fail)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'tournament.mjs'), 'utf8')

let failed = 0
const check = (name, cond) => { if (cond) console.log(`ok   - ${name}`); else { console.error(`FAIL - ${name}`); failed++ } }

console.log('== issue #34: self-contained workspaceRoot ==')

check('(workspace-root) workspaceRoot is configurable with a /tmp default, never under .claude/',
  SRC.includes('const workspaceRoot = A.workspaceRoot || `/tmp/je-workspaces/${safeRunId}`'))
check('(workspace-root) default workspaceRoot literal does not resolve under .claude/',
  (() => { const m = SRC.match(/A\.workspaceRoot \|\| `([^`]+)`/); return !!m && !m[1].includes('.claude') })())
check('(workspace-root) default workspaceRoot literal is rooted at /tmp, never under runDir',
  (() => { const m = SRC.match(/A\.workspaceRoot \|\| `([^`]+)`/); return !!m && m[1].startsWith('/tmp/') && !m[1].includes('${runDir}') })())
check('(workspace-root) scratchPath is rooted at workspaceRoot',
  SRC.includes('const scratchPath = (roundName, label) => `${workspaceRoot}/${roundName}/${label}`'))
check('(workspace-root) round-1 attempt ws uses scratchPath outside repoMode',
  SRC.includes("ws: repoMode ? worktreePath('round-1', a.label) : scratchPath('round-1', a.label)"))
check('(workspace-root) round-2 attempt ws uses scratchPath outside repoMode',
  SRC.includes("ws: repoMode ? worktreePath('round-2', a.label) : scratchPath('round-2', a.label)"))
check('(workspace-root) implement-round attempt ws uses scratchPath outside repoMode',
  SRC.includes("ws: repoMode ? worktreePath(roundName, a.label) : scratchPath(roundName, a.label)"))
check('(workspace-root) repoMode:true branch (worktreePath) is untouched by this fix',
  SRC.includes('const worktreePath = (roundName, label) => repoMode ? `${worktreeRoot}/${roundName}/${label}` : null'))
check('(workspace-root) explicit args.workspaceRoot overrides the default (legacy layout escape hatch)',
  SRC.includes('const workspaceRoot = A.workspaceRoot ||'))
// Regression guard: the OLD sensitive literal (candidate ws interpolated directly under runDir)
// must never reappear at any of the three ws call sites — that literal IS the issue #34 bug (a
// plugin-cache path nested claude-CLI runners refuse to write to).
check('(workspace-root) the old sensitive runDir-literal ws pattern is gone from every call site',
  !SRC.includes("worktreePath('round-1', a.label) : `${runDir}/round-1/${a.label}`") &&
  !SRC.includes("worktreePath('round-2', a.label) : `${runDir}/round-2/${a.label}`") &&
  !SRC.includes("worktreePath(roundName, a.label) : `${runDir}/${roundName}/${a.label}`"))
check('(workspace-root) staging still copies from c.ws unconditionally (relocation flows through automatically)',
  SRC.includes('cp -R ${q(c.ws)}/. ${q(dest)}/ 2>/dev/null;'))
check('(workspace-root) persisted run artifacts (mapping.json) still resolve under runDir, not workspaceRoot',
  SRC.includes('`${runDir}/mapping.json`'))
check('(workspace-root) context bundle still resolves under runDir, not workspaceRoot',
  SRC.includes("const contextPath = contextFiles.length ? `${runDir}/_context/_context.md` : null"))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
