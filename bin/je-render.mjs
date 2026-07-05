#!/usr/bin/env node
// je-render.mjs — deterministic on-disk artifact renderer (structural persist, issue #33).
//
// Derives report artifacts FROM an already-persisted (checksum-verified) verdict.json so their
// bytes never transit a model. The rendering CODE is not duplicated here: this tool slices the
// marked "report renderers" block out of ../workflows/tournament.mjs (the same extract-and-eval
// convention the test files use), so engine and renderer can never drift.
//
// Usage:
//   node je-render.mjs verdict-md   <verdict.json> <out.md> [title]
//   node je-render.mjs council-json <verdict.json> <out.json>
//   node je-render.mjs guidance-md  <verdict.json> <out.md>
//
// Exit: 0 on success (out file written, non-empty); nonzero otherwise. The engine's persist()
// verifies the result via wc -c, so a silent failure here still surfaces as a verified miss.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, from, out, ...rest] = process.argv.slice(2)
if (!mode || !from || !out) {
  console.error('usage: je-render.mjs <verdict-md|council-json|guidance-md> <verdict.json> <out> [title]')
  process.exit(2)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, '../workflows/tournament.mjs'), 'utf8')

function slice(beginMark, endMark) {
  const i = SRC.indexOf(beginMark)
  const j = SRC.indexOf(endMark, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`renderer block markers not found in tournament.mjs`)
  return SRC.slice(i, j)
}
const block = slice('// ---- begin: report renderers', '// ---- end: report renderers')
const capMatch = /const GUIDANCE_CAP = (\d+)/.exec(SRC)
const GUIDANCE_CAP = capMatch ? Number(capMatch[1]) : 5

const api = new Function('GUIDANCE_CAP',
  `${block}\nreturn { verdictToMd, councilToMd, councilTallyMd, guidanceToMd, summaryMd, rcSummaryMd };`)(GUIDANCE_CAP)

const v = JSON.parse(readFileSync(from, 'utf8'))
let text
if (mode === 'verdict-md') text = api.verdictToMd(v, rest[0] || 'Verdict')
else if (mode === 'council-json') text = JSON.stringify(v.council ?? null, null, 2) + '\n'
else if (mode === 'guidance-md') text = api.guidanceToMd(v.guidance || {})
else { console.error(`je-render: unknown mode "${mode}"`); process.exit(2) }

if (!text || !text.trim()) { console.error(`je-render: ${mode} produced empty output`); process.exit(1) }
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, text)
