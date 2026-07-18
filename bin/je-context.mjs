// je-context.mjs — per-agent token/cache usage from workflow transcripts (tracker #17).
// Sibling of je-timeline.mjs: deterministic, zero model calls, post-run (or mid-run on partial
// transcripts). Usage: node je-context.mjs <transcriptDir> <runDir>
// Writes <runDir>/context.jsonl (one row per agent: fresh/cached/output tokens, calls, first-call
// context load) and <runDir>/CONTEXT.md (totals, cache-read share, judge-seat ingestion stats).
//
// Labels: joined from <runDir>/timeline.jsonl (run je-timeline.mjs first — the documented post-run
// order). A missing timeline degrades to `agent:<id>` labels rather than failing: usage numbers
// matter more than names, and mid-run snapshots may precede the timeline step.
//
// Codex-family seats run inside `codex exec`, so their tokens never reach a Claude transcript.
// Best-effort coverage: any `*_run.log` under runDir with a codex "tokens used" figure is reported
// in a separate RUNNER LOGS section (coverage is partial by design — runner logs may live in /tmp
// workspaces or have been stripped during blind staging; CONTEXT.md states what it found).
import { readdirSync, readFileSync, writeFileSync, lstatSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

function writeNoFollow(p, data) {
  // Mirror je-timeline's symlink hardening: never write through a pre-planted symlink.
  try { if (lstatSync(p).isSymbolicLink()) rmSync(p) } catch { /* absent is fine */ }
  writeFileSync(p, data)
}

const [transcriptDir, runDir] = process.argv.slice(2)
if (!transcriptDir || !runDir) { console.error('usage: je-context.mjs <transcriptDir> <runDir>'); process.exit(2) }

// ---- labels from timeline.jsonl (optional) ---------------------------------------------------
const labels = new Map()
try {
  for (const line of readFileSync(join(runDir, 'timeline.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { const r = JSON.parse(line); if (r.agent && r.label && !labels.has(r.agent)) labels.set(r.agent, r.label) } catch { /* skip bad row */ }
  }
} catch { /* no timeline yet — degrade to agent ids */ }

// ---- per-agent usage from transcripts ---------------------------------------------------------
const files = readdirSync(transcriptDir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
const agents = []
for (const f of files) {
  let lines
  try { lines = readFileSync(join(transcriptDir, f), 'utf8').split('\n').filter(Boolean) } catch { continue }
  if (!lines.length) continue
  let agentId = null, calls = 0, fresh = 0, cacheRead = 0, cacheWrite = 0, out = 0, firstCtx = null, start = null
  for (const line of lines) {
    let d; try { d = JSON.parse(line) } catch { continue }
    if (!agentId && d.agentId) agentId = d.agentId
    if (!start && d.timestamp) start = d.timestamp
    const u = d.message && d.message.usage
    if (!u || typeof u !== 'object' || (u.input_tokens == null && u.output_tokens == null)) continue
    const inTok = Number(u.input_tokens || 0)
    const cr = Number(u.cache_read_input_tokens || 0)
    const cw = Number(u.cache_creation_input_tokens || 0)
    calls++; fresh += inTok; cacheRead += cr; cacheWrite += cw; out += Number(u.output_tokens || 0)
    if (firstCtx == null) firstCtx = inTok + cr + cw // the initial context load of this agent
  }
  if (!calls) continue
  agents.push({
    agent: agentId || f.replace(/^agent-|\.jsonl$/g, ''),
    label: labels.get(agentId) || `agent:${(agentId || f).slice(0, 12)}`,
    calls, fresh, cacheRead, cacheWrite, out, firstCtx: firstCtx || 0,
    totalIn: fresh + cacheRead + cacheWrite, start: start || '',
  })
}
agents.sort((a, b) => (a.start < b.start ? -1 : 1))

// ---- best-effort codex runner-log usage under runDir ------------------------------------------
const runnerRows = []
;(function walk(dir, depth) {
  if (depth > 6) return
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    try { if (lstatSync(p).isSymbolicLink()) continue } catch { continue }
    if (e.isDirectory()) walk(p, depth + 1)
    else if (/_run\.log$/.test(e.name) && statSync(p).size < 32 * 1024 * 1024) {
      const txt = readFileSync(p, 'utf8')
      const m = txt.match(/tokens used[\s:]*([\d,]+)/i)
      if (m) runnerRows.push({ log: p.slice(runDir.length + 1), tokensUsed: Number(m[1].replace(/,/g, '')) })
    }
  }
})(runDir, 0)

// ---- aggregate + render ------------------------------------------------------------------------
const sum = (k) => agents.reduce((n, a) => n + a[k], 0)
const totals = { agents: agents.length, calls: sum('calls'), fresh: sum('fresh'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), out: sum('out') }
const denom = totals.fresh + totals.cacheRead + totals.cacheWrite
totals.cacheReadShare = denom ? +(totals.cacheRead / denom).toFixed(3) : 0

const judges = agents.filter(a => a.label.startsWith('judge:'))
const jCtx = judges.map(a => a.firstCtx).sort((x, y) => x - y)
const judgeStats = judges.length ? {
  seats: judges.length,
  ingestionMean: Math.round(jCtx.reduce((n, x) => n + x, 0) / judges.length),
  ingestionMax: jCtx[jCtx.length - 1],
  ingestionMin: jCtx[0],
} : null

const fmt = (n) => n.toLocaleString('en-US')
const top = [...agents].sort((a, b) => b.totalIn - a.totalIn).slice(0, 15)
const md = `# Run context/usage (${totals.agents} agents, ${totals.calls} usage-bearing calls)

## Totals

| fresh input | cache read | cache write | output | cache-read share |
|---|---|---|---|---|
| ${fmt(totals.fresh)} | ${fmt(totals.cacheRead)} | ${fmt(totals.cacheWrite)} | ${fmt(totals.out)} | ${(totals.cacheReadShare * 100).toFixed(1)}% |

cache-read share = cache reads / (fresh + cache reads + cache writes). High = prompt prefixes are
being reused; low = every call re-pays its context cold.

${judgeStats ? `## Judge seats (Anthropic-transcript seats only)

| seats | first-call context load (min / mean / max) |
|---|---|
| ${judgeStats.seats} | ${fmt(judgeStats.ingestionMin)} / ${fmt(judgeStats.ingestionMean)} / ${fmt(judgeStats.ingestionMax)} |
` : '## Judge seats\n\n_No judge-labelled agents found (run je-timeline.mjs first for labels)._\n'}
## Top agents by total input (fresh + cached)

| agent | label | calls | fresh | cache read | cache write | output | first-call load |
|---|---|---|---|---|---|---|---|
${top.map(a => `| ${a.agent.slice(0, 10)} | ${a.label.slice(0, 44)} | ${a.calls} | ${fmt(a.fresh)} | ${fmt(a.cacheRead)} | ${fmt(a.cacheWrite)} | ${fmt(a.out)} | ${fmt(a.firstCtx)} |`).join('\n')}

## Runner logs found under runDir (codex-family tokens live outside Claude transcripts)

${runnerRows.length ? runnerRows.map(r => `- \`${r.log}\`: tokens used ${fmt(r.tokensUsed)}`).join('\n') : '_None found — codex seat logs may live in /tmp workspaces or were stripped during blind staging (partial coverage is expected; see tool header)._'}
`
writeNoFollow(join(runDir, 'context.jsonl'), agents.map(a => JSON.stringify(a)).join('\n') + '\n')
writeNoFollow(join(runDir, 'CONTEXT.md'), md)
console.log(`CONTEXT: ${totals.agents} agents, cache-read share ${(totals.cacheReadShare * 100).toFixed(1)}% -> ${join(runDir, 'CONTEXT.md')}`)
