#!/usr/bin/env node
// je-assemble.mjs — deterministic verdict.json assembler (structural persist phase 2, issue #33).
//
// Splices sha-pinned per-seat verdict files back into the small engine-written tally skeleton
// (`<reviewDir>/_judges/tally.json`) so the full verdict.json lands ON DISK byte-identical to the
// engine's `json(review)` without its bulk ever transiting a model. Splice only — no tally/merge
// logic is re-implemented here; node preserves key insertion order, so parse → splice → stringify
// reproduces the engine serialization exactly.
//
// Usage:
//   node je-assemble.mjs <tally.json> <out-verdict.json>
//
// The skeleton is the full council result with each council.rounds[*].verdicts[*] body replaced by
// a ref {"$seat": "<runDir-relative path>", "sha256": "<hex>"}. Refs are runDir-relative so runs
// can be moved/archived; the layout is fixed (<runDir>/<review-dir>/_judges/tally.json), so runDir
// is the grandparent of the tally's directory. A verdict with no ref (its seat-file persist failed)
// is inline in the skeleton and is kept verbatim.
//
// Exit: 0 only if EVERY ref resolved, sha-verified (node:crypto over the exact file bytes) and
// parsed, and the output is non-empty; nonzero otherwise, naming the offending path — the engine's
// FLP check then drives the typed-content fallback (worst case = today's behaviour, never a crash).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve, relative, isAbsolute } from 'node:path'

const [tallyPath, outPath] = process.argv.slice(2)
if (!tallyPath || !outPath) {
  console.error('usage: je-assemble.mjs <tally.json> <out-verdict.json>')
  process.exit(2)
}
const fail = (msg) => { console.error(`je-assemble: ${msg}`); process.exit(1) }

const runDir = resolve(dirname(tallyPath), '../..') // <runDir>/<review-dir>/_judges/tally.json
let doc
try { doc = JSON.parse(readFileSync(tallyPath, 'utf8')) } catch (e) { fail(`unreadable tally ${tallyPath}: ${e.message}`) }

const rounds = doc && doc.council && Array.isArray(doc.council.rounds) ? doc.council.rounds : []
for (const r of rounds) {
  if (!r || !Array.isArray(r.verdicts)) continue
  r.verdicts = r.verdicts.map(v => {
    if (!v || typeof v.$seat !== 'string') return v // inline verdict (no on-disk ref) — kept verbatim
    // security-sweep L6 (2026-07-07): a $seat ref with an absolute path or `..` would resolve OUTSIDE
    // runDir, reading an arbitrary file into the assembled verdict. Require containment.
    const p = resolve(runDir, v.$seat)
    const relFromRun = relative(runDir, p)
    if (v.$seat.startsWith('/') || relFromRun.startsWith('..') || relFromRun === '' || isAbsolute(relFromRun)) fail(`seat ref escapes runDir: ${v.$seat}`)
    let bytes
    try { bytes = readFileSync(p) } catch { fail(`missing seat file ${p} (ref ${v.$seat})`) }
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== String(v.sha256 || '').toLowerCase()) fail(`sha mismatch for ${p}: expected ${v.sha256}, got ${sha}`)
    try { return JSON.parse(bytes.toString('utf8')) } catch (e) { fail(`unparseable seat file ${p}: ${e.message}`) }
  })
}

const text = JSON.stringify(doc, null, 2) + '\n'
if (!text.trim()) fail('empty output')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, text)
