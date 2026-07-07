// je-timeline smoke test: synthetic 3-agent transcript -> timeline + gates
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { strict as assert } from 'node:assert'

const td = mkdtempSync(join(tmpdir(), 'je-tl-')), rd = mkdtempSync(join(tmpdir(), 'je-tl-run-'))
const line = (id, ts, content) => JSON.stringify({ agentId: id, timestamp: ts, message: { role: 'user', content } })
writeFileSync(join(td, 'agent-a1.jsonl'),
  line('a1', '2026-07-06T00:00:00Z', 'Run this exact shell command in ONE Bash call: cat files > /tmp/x/_context/_context.md') + '\n' +
  line('a1', '2026-07-06T00:00:30Z', 'done') + '\n')
writeFileSync(join(td, 'agent-a2.jsonl'),
  line('a2', '2026-07-06T00:00:35Z', 'Save your work to /tmp/de-workspaces/r/round-1/candidate-2/ please') + '\n' +
  line('a2', '2026-07-06T00:05:35Z', 'done') + '\n')
writeFileSync(join(td, 'agent-a3.jsonl'),
  line('a3', '2026-07-06T00:05:40Z', 'You are a blind judge on a 5-member review COUNCIL. Your lens is **risk**: ... read review-1/_pool.md') + '\n' +
  line('a3', '2026-07-06T00:09:40Z', 'done') + '\n')
execFileSync('node', ['bin/je-timeline.mjs', td, rd])
assert.ok(existsSync(join(rd, 'TIMELINE.md')) && existsSync(join(rd, 'timeline.jsonl')))
const rows = readFileSync(join(rd, 'timeline.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
assert.equal(rows.length, 3)
assert.equal(rows[0].label, 'context-bundler')
assert.equal(rows[1].label, 'attempt:round-1/candidate-2')
assert.equal(rows[1].gate, 'context-bundler')
assert.match(rows[2].label, /^judge:risk@review-1/)
assert.equal(rows[2].gate, 'attempt:round-1/candidate-2')
assert.equal(rows[2].durSecs, 240)
console.log('je-timeline tests: 8 assertions passed')
