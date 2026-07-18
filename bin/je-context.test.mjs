// je-context smoke test: synthetic usage-bearing transcripts + timeline labels -> context report
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { strict as assert } from 'node:assert'

const td = mkdtempSync(join(tmpdir(), 'je-cx-')), rd = mkdtempSync(join(tmpdir(), 'je-cx-run-'))
const usageLine = (id, ts, u) => JSON.stringify({ agentId: id, timestamp: ts, message: { role: 'assistant', usage: u } })
const plainLine = (id, ts, content) => JSON.stringify({ agentId: id, timestamp: ts, message: { role: 'user', content } })

// agent j1: a judge — 2 calls, big cold first load then cached second call
writeFileSync(join(td, 'agent-j1.jsonl'),
  plainLine('j1', '2026-07-16T00:00:00Z', 'Your lens is **risk**') + '\n' +
  usageLine('j1', '2026-07-16T00:00:10Z', { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 40000, output_tokens: 900 }) + '\n' +
  usageLine('j1', '2026-07-16T00:01:10Z', { input_tokens: 50, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 700 }) + '\n')
// agent h1: a helper — 1 small call, no caching
writeFileSync(join(td, 'agent-h1.jsonl'),
  plainLine('h1', '2026-07-16T00:00:05Z', 'shasum heredoc persist') + '\n' +
  usageLine('h1', '2026-07-16T00:00:12Z', { input_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 }) + '\n')
// an empty/no-usage agent must be skipped, not crash
writeFileSync(join(td, 'agent-x0.jsonl'), plainLine('x0', '2026-07-16T00:00:01Z', 'no usage here') + '\n')

// timeline labels for the join
writeFileSync(join(rd, 'timeline.jsonl'),
  JSON.stringify({ agent: 'j1', label: 'judge:risk@review-1' }) + '\n' +
  JSON.stringify({ agent: 'h1', label: 'persist-helper' }) + '\n')

// a codex runner log under runDir must surface in the runner section
mkdirSync(join(rd, 'review-rejudge', 'A'), { recursive: true })
writeFileSync(join(rd, 'review-rejudge', 'A', '_codex_run.log'), 'blah\ntokens used\n60,640\nJOUST-CODEX-DONE exit=0\n')

execFileSync('node', ['bin/je-context.mjs', td, rd])
assert.ok(existsSync(join(rd, 'context.jsonl')) && existsSync(join(rd, 'CONTEXT.md')))
const rows = readFileSync(join(rd, 'context.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
assert.equal(rows.length, 2, 'usage-bearing agents only')
const j1 = rows.find(r => r.agent === 'j1')
assert.equal(j1.label, 'judge:risk@review-1', 'label joined from timeline.jsonl')
assert.equal(j1.calls, 2)
assert.equal(j1.fresh, 150)
assert.equal(j1.cacheRead, 40000)
assert.equal(j1.cacheWrite, 40000)
assert.equal(j1.out, 1600)
assert.equal(j1.firstCtx, 40100, 'first-call context load = fresh + cacheRead + cacheWrite of call 1')
const md = readFileSync(join(rd, 'CONTEXT.md'), 'utf8')
assert.match(md, /judge:risk@review-1/)
assert.match(md, /40,100/, 'judge ingestion stat rendered')
assert.match(md, /tokens used 60,640/, 'codex runner log surfaced')
assert.match(md, /cache-read share/i)

// degrade path: no timeline.jsonl -> agent-id labels, still succeeds
const rd2 = mkdtempSync(join(tmpdir(), 'je-cx-run2-'))
execFileSync('node', ['bin/je-context.mjs', td, rd2])
const rows2 = readFileSync(join(rd2, 'context.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
assert.match(rows2.find(r => r.agent === 'j1').label, /^agent:j1/, 'label degrades to agent id without a timeline')

console.log('je-context tests: 15 assertions passed')
