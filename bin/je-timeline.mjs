#!/usr/bin/env node
// je-timeline.mjs — per-run agent timeline + observations, mined from workflow transcripts.
// Usage: node je-timeline.mjs <transcriptDir> <runDir>
// Writes <runDir>/timeline.jsonl (one record per agent) and <runDir>/TIMELINE.md.
// Deterministic, zero tokens: transcripts carry real timestamps; the workflow sandbox
// cannot self-timestamp (Date.now() is forbidden there for resume-safety), so timing is
// reconstructed here, post-run or mid-run (partial transcripts produce a partial timeline).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [transcriptDir, runDir] = process.argv.slice(2)
if (!transcriptDir || !runDir) { console.error('usage: je-timeline.mjs <transcriptDir> <runDir>'); process.exit(2) }

export function labelFor(c) {
  const jm = c.match(/_judges\/([a-z0-9-]+)\/VERDICT/i)
  const lens = c.match(/Your lens is \*\*([a-z-]+)\*\*/i)
  const pool = c.match(/(review-final[a-z0-9-]*|review-1|review-[0-9]+|runoff-?[0-9]+[a-z0-9-]*)\/_pool\.md/i)
  const ws = c.match(/de-workspaces\/[^/]+\/([a-z0-9-]+)\/((?:candidate|impl)-[0-9]+)/i) ||
             c.match(/(round-[0-9]+|impl-[0-9]+)\/((?:candidate|impl)-[0-9]+)/i)
  if (jm) return `codex-judge-dispatch:${jm[1]}`
  if (lens) return `judge:${lens[1]}${pool ? '@' + pool[1] : ''}`
  if (ws) return `attempt:${ws[1]}/${ws[2]}`
  if (/Run this exact shell command/i.test(c) && /_context/.test(c)) return 'context-bundler'
  if (/steelman/i.test(c) && /change/i.test(c)) return 'steelman'
  if (/improvement|boost/i.test(c) && /apply/i.test(c)) return 'boost-implementer'
  if (/shasum|heredoc/i.test(c)) return 'persist-helper'
  if (/stage/i.test(c) && /blind/i.test(c)) return `stage${pool ? ':' + pool[1] : ''}`
  if (/positives|challenges/i.test(c) && /guidance/i.test(c)) return 'guidance-synthesis'
  return `other:${c.slice(0, 50).replace(/\s+/g, ' ')}`
}

const files = readdirSync(transcriptDir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
const agents = []
for (const f of files) {
  const lines = readFileSync(join(transcriptDir, f), 'utf8').split('\n').filter(Boolean)
  if (!lines.length) continue
  let first, last
  try { first = JSON.parse(lines[0]); last = JSON.parse(lines[lines.length - 1]) } catch { continue }
  let c = first.message?.content
  if (Array.isArray(c)) c = c.map(x => x.text || '').join(' ')
  const start = Date.parse(first.timestamp), end = Date.parse(last.timestamp)
  agents.push({ agent: first.agentId, label: labelFor(String(c || '')), start, end, durSecs: Math.round((end - start) / 1000) })
}
agents.sort((a, b) => a.start - b.start)
for (const a of agents) {
  let pred = null
  for (const b of agents) if (b !== a && b.end <= a.start + 1000 && (!pred || b.end > pred.end)) pred = b
  a.gate = pred ? pred.label : '(run start)'
  a.gapSecs = pred ? Math.max(0, Math.round((a.start - pred.end) / 1000)) : 0
  a.concurrent = agents.filter(b => b !== a && b.start < a.start && b.end > a.start + 1000).length
}

const d = s => s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
const t = ms => new Date(ms).toISOString().slice(11, 19) + 'Z'
const rows = agents.map(a => `| ${t(a.start)} | ${d(a.durSecs)} | ${a.label} | ${a.gate} (+${a.gapSecs}s) | ${a.concurrent} |`)

// observations: deterministic, attributed
const obs = []
const groups = {}
for (const a of agents) { const g = a.label.replace(/:.*/, ''); (groups[g] ||= []).push(a) }
for (const [g, list] of Object.entries(groups)) {
  if (list.length < 3 || g === 'other') continue
  const durs = list.map(x => x.durSecs).sort((x, y) => x - y)
  const max = list.find(x => x.durSecs === durs[durs.length - 1])
  const median = durs[Math.floor(durs.length / 2)]
  if (durs[durs.length - 1] >= median * 2 && durs[durs.length - 1] - median >= 120)
    obs.push(`**${g}** barrier: \`${max.label}\` ran ${d(max.durSecs)} vs group median ${d(median)} — ${d(max.durSecs - median)} of pure critical-path wait.`)
}
const chains = agents.filter(a => a.label.startsWith('codex-judge-dispatch'))
if (chains.length) obs.push(`**codex judge chains**: ${chains.length} dispatch legs; retries visible where the same seat name repeats — each repeat is a serial round-trip on the critical path.`)
const peak = Math.max(0, ...agents.map(a => a.concurrent + 1))
obs.push(`**peak concurrency**: ${peak} (workflow cap 16) — ${peak >= 15 ? 'cap may be binding' : 'cap not binding'}.`)

writeFileSync(join(runDir, 'timeline.jsonl'), agents.map(a => JSON.stringify(a)).join('\n') + '\n')
writeFileSync(join(runDir, 'TIMELINE.md'), `# Run timeline (${agents.length} agents)

| start (UTC) | dur | agent | started after (gap) | concurrent |
|---|---|---|---|---|
${rows.join('\n')}

## Observations (deterministic; hypotheses need cross-run n — see the ledger)

${obs.map(o => `- ${o}`).join('\n')}
`)
console.log(`TIMELINE: ${agents.length} agents -> ${join(runDir, 'TIMELINE.md')}`)
