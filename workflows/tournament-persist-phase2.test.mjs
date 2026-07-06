// Structural persist PHASE 2 tests (issue #33, 2026-07-06): per-seat verdict files, the tally
// skeleton builder, the persist() `assemble` entry kind with FULL-file sha verification, and the
// typed-fallback ladder. Extract-and-eval convention: pure blocks/functions are sliced out of
// tournament.mjs and run in isolation (persist() runs against a stubbed write-agent); the
// councilJudge/checkpoint wiring is covered structurally.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

function slice(beginMark, endMark) {
  const i = SRC.indexOf(beginMark)
  const j = SRC.indexOf(endMark, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`markers not found: ${beginMark}`)
  return SRC.slice(i, j)
}

const json = obj => JSON.stringify(obj, null, 2) + '\n'
const shaOf = s => createHash('sha256').update(s.endsWith('\n') ? s : s + '\n', 'utf8').digest('hex') // sha over heredocBody(content)

// ----- tally skeleton builder (extract-and-eval) -----
const { buildTallySkeleton } = new Function(
  slice('// ---- begin: tally skeleton builder', '// ---- end: tally skeleton builder') +
  '\nreturn { buildTallySkeleton };')()

const verdict = (lens, note = '') => ({ lens, rc: '00', vote: 'A', ranking: ['A', 'B'], reasoning: `${lens} verdict ${note}` })
const RESULT = {
  candidates: [{ label: 'A', pros: ['ok'], cons: [] }], ranking: ['A', 'B'], winner: 'A', reasoning: 'majority',
  council: {
    lenses: ['correctness', 'spec'], rounds_used: 2,
    rounds: [
      { round: 1, living: ['correctness', 'spec'], votes: { A: 2 }, vetoed: [], winner: 'A', dead_seats: [], verdicts: [verdict('correctness'), verdict('spec')] },
      { round: 2, living: ['spec'], votes: { A: 1 }, vetoed: [], winner: 'A', dead_seats: [], verdicts: [verdict('spec', 'r2')] },
    ],
    vote_evolution: [], veto_events: [], final_living: 1, no_consensus: false,
  },
  no_consensus: false,
}
const REFS = {
  'correctness|r1': { rel: 'review-1/_judges/review-correctness-r1.json', sha: 'a'.repeat(64) },
  'spec|r2': { rel: 'review-1/_judges/review-spec-r2.json', sha: 'b'.repeat(64) },
}

test('buildTallySkeleton replaces exactly the ref-matched verdicts (lens key + round)', () => {
  const skel = buildTallySkeleton(RESULT, REFS)
  assert.deepEqual(skel.council.rounds[0].verdicts[0], { $seat: REFS['correctness|r1'].rel, sha256: 'a'.repeat(64) })
  assert.deepEqual(skel.council.rounds[1].verdicts[0], { $seat: REFS['spec|r2'].rel, sha256: 'b'.repeat(64) })
  // spec r1 has NO r1 ref (only r2): matching is round-scoped, so it must stay inline verbatim
  assert.deepEqual(skel.council.rounds[0].verdicts[1], verdict('spec'))
})

test('buildTallySkeleton: a ref-less verdict stays inline — assembly still succeeds, never a crashed persist', () => {
  const skel = buildTallySkeleton(RESULT, {})
  assert.deepEqual(skel.council.rounds.map(r => r.verdicts), RESULT.council.rounds.map(r => r.verdicts))
})

test('buildTallySkeleton never mutates the result: refs cannot leak into json(review) (byte-parity invariant)', () => {
  const before = json(RESULT)
  const skel = buildTallySkeleton(RESULT, REFS)
  assert.equal(json(RESULT), before)
  assert.ok(!json(RESULT).includes('$seat'))
  assert.notEqual(skel.council.rounds[0].verdicts[0], RESULT.council.rounds[0].verdicts[0]) // deep copy, not aliasing
})

test('buildTallySkeleton tolerates council-less / rounds-less results (judges:1 shapes)', () => {
  assert.deepEqual(buildTallySkeleton({ winner: 'A' }, REFS), { winner: 'A' })
  assert.deepEqual(buildTallySkeleton({ winner: 'A', council: { rounds_used: 0 } }, REFS), { winner: 'A', council: { rounds_used: 0 } })
})

// ----- persist(): the assemble entry kind + fallback ladder, against a stubbed write-agent -----
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'"
function makePersist(agentStub, pluginBin) {
  const src =
    slice('// ---- begin: structural persist helpers', '// ---- end: structural persist helpers') +
    '\n' + slice('async function persist(pairs, phaseTitle) {', '// Persist phase 2 (issue #33): the verdict.json entries') +
    '\nreturn persist;'
  // persist() now routes through the shared model-ladder wrapper (agentLadder); at sonnet there is
  // no rung below, so stubbing the wrapper directly preserves the exact pre-ladder semantics.
  return new Function('agentLadder', 'PLUGIN_BIN', 'log', 'HELPER_MODEL', 'PERSIST_SCHEMA', 'q', src)(
    agentStub, pluginBin, () => {}, 'sonnet', {}, q)
}

const TALLY = { path: '/run/review-1/_judges/tally.json', content: '{\n  "skeleton": true\n}\n' }
const VERDICT = { path: '/run/review-1/verdict.json', content: '{\n  "big": "review"\n}\n', assemble: { tally: TALLY.path } }

test('persist(assemble): happy path — je-assemble runs on disk, FULL sha verified, both paths returned', async () => {
  const scripts = []
  const stub = async (prompt) => {
    scripts.push(prompt)
    return { results: [
      { path: TALLY.path, bytes: TALLY.content.length, sha: shaOf(TALLY.content) },
      { path: VERDICT.path, bytes: VERDICT.content.length, sha: shaOf(VERDICT.content) }, // assembler produced the exact engine bytes
    ] }
  }
  const persist = makePersist(stub, '/plugin/bin')
  const ok = await persist([TALLY, VERDICT], 'Review')
  assert.deepEqual(ok.sort(), [TALLY.path, VERDICT.path].sort())
  assert.equal(scripts.length, 1)
  assert.match(scripts[0], /je-assemble\.mjs/)
  assert.ok(scripts[0].includes(`${q(TALLY.path)} ${q(VERDICT.path)}`), 'assemble step must be `je-assemble.mjs <tally> <out>`')
  assert.ok(!scripts[0].includes(VERDICT.content), 'the assembled bytes must NEVER transit the model (no heredoc body for the verdict)')
  const tallyFirst = scripts[0].indexOf(q(TALLY.path))
  assert.ok(tallyFirst >= 0 && tallyFirst < scripts[0].indexOf('je-assemble.mjs'), 'tally heredoc step must precede the assemble step (sequential script)')
})

test('persist(assemble): assembled bytes != json(review) is a VERIFIED miss -> retried as typed content (ladder)', async () => {
  const scripts = []
  const stub = async (prompt) => {
    scripts.push(prompt)
    if (scripts.length === 1) return { results: [
      { path: TALLY.path, bytes: TALLY.content.length, sha: shaOf(TALLY.content) },
      { path: VERDICT.path, bytes: 12, sha: 'f'.repeat(64) }, // corrupt assembly (or je-assemble crash left stale bytes)
    ] }
    return { results: [{ path: VERDICT.path, bytes: VERDICT.content.length, sha: shaOf(VERDICT.content) }] } // typed retry lands
  }
  const persist = makePersist(stub, '/plugin/bin')
  const ok = await persist([TALLY, VERDICT], 'Review')
  assert.deepEqual(ok.sort(), [TALLY.path, VERDICT.path].sort(), 'worst case is today\'s behaviour: the typed write, never a lost file')
  assert.equal(scripts.length, 2)
  assert.ok(!scripts[1].includes('je-assemble.mjs'), 'the retry must FORCE the typed path (a broken assemble never silently repeats)')
  assert.ok(scripts[1].includes(VERDICT.content), 'the retry types the full verdict content through the verified heredoc')
})

test('persist(assemble): je-assemble missing/crashed (no FLP line) -> typed fallback; still-bad target reported, good file returned', async () => {
  const scripts = []
  const stub = async (prompt) => {
    scripts.push(prompt)
    if (scripts.length === 1) return { results: [{ path: TALLY.path, bytes: TALLY.content.length, sha: shaOf(TALLY.content) }] } // assemble produced NOTHING
    return { results: [{ path: VERDICT.path, bytes: 0, sha: '' }] } // typed retry also failed
  }
  const persist = makePersist(stub, '/plugin/bin')
  const ok = await persist([TALLY, VERDICT], 'Review')
  assert.deepEqual(ok, [TALLY.path], 'only the verified file is returned; the still-bad one is excluded (path-named failure, never fake success)')
})

test('persist(assemble): PLUGIN_BIN unknown -> the entry is typed+verified on the FIRST pass (no assemble step emitted)', async () => {
  const scripts = []
  const stub = async (prompt) => {
    scripts.push(prompt)
    return { results: [
      { path: TALLY.path, bytes: TALLY.content.length, sha: shaOf(TALLY.content) },
      { path: VERDICT.path, bytes: VERDICT.content.length, sha: shaOf(VERDICT.content) },
    ] }
  }
  const persist = makePersist(stub, null)
  const ok = await persist([TALLY, VERDICT], 'Review')
  assert.deepEqual(ok.sort(), [TALLY.path, VERDICT.path].sort())
  assert.equal(scripts.length, 1)
  assert.ok(!scripts[0].includes('je-assemble.mjs'))
  assert.ok(scripts[0].includes(VERDICT.content))
})

test('persist: total agent failure returns [] and never throws (fire-and-forget contract)', async () => {
  const persist = makePersist(async () => { throw new Error('agent exploded') }, '/plugin/bin')
  assert.deepEqual(await persist([TALLY, VERDICT], 'Review'), [])
})

// ----- verdictEntries (extract-and-eval): checkpoint entry shapes -----
function makeVerdictEntries(refsByLabel) {
  const src =
    'const json = obj => JSON.stringify(obj, null, 2) + "\\n"\n' +
    slice('// ---- begin: tally skeleton builder', '// ---- end: tally skeleton builder') +
    '\n' + slice('function verdictEntries(dir, review, phaseLabel) {', '\n// ---- auto-filed engine issues') +
    '\nreturn verdictEntries;'
  return new Function('seatRefs', src)(refsByLabel)
}

test('verdictEntries: council + verified refs -> [typed tally, assemble verdict] with tally FIRST', () => {
  const ve = makeVerdictEntries({ review: { 'correctness|r1': REFS['correctness|r1'] } })
  const entries = ve('/run/review-1', RESULT, 'review')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].path, '/run/review-1/_judges/tally.json')
  assert.ok(entries[0].content.includes('$seat'), 'the tally skeleton carries the seat refs')
  assert.deepEqual(entries[1], { path: '/run/review-1/verdict.json', content: json(RESULT), assemble: { tally: '/run/review-1/_judges/tally.json' } })
})

test('verdictEntries: judges:1 legacy (no council) and all-seat-persist-failed (no refs) stay a single typed write', () => {
  const ve = makeVerdictEntries({ review: {} })
  assert.deepEqual(ve('/run/review-1', { winner: 'A' }, 'review'), [{ path: '/run/review-1/verdict.json', content: json({ winner: 'A' }) }]) // no council
  assert.deepEqual(ve('/run/review-1', RESULT, 'review'), [{ path: '/run/review-1/verdict.json', content: json(RESULT) }]) // council, zero refs
  assert.deepEqual(ve('/run/review-1', RESULT, 'other-label'), [{ path: '/run/review-1/verdict.json', content: json(RESULT) }]) // unknown label
})

// ----- structural: councilJudge seat-file persistence + checkpoint wiring -----
test('(structural) councilJudge persists one small typed batch per judging round and records verified refs only', () => {
  const cj = slice('async function councilJudge(', '\n// Render the council')
  assert.match(cj, /const refs = seatRefs\[label\] = Object\.create\(null\)/)
  assert.match(cj, /await persistRoundSeats\(roundsLog\[roundsLog\.length - 1\]\)/)
  assert.match(cj, /okPaths\.has\(/) // a ref is recorded ONLY for a sha-verified on-disk file
  assert.match(cj, /\$\{label\}-\$\{v\.lens\}-r\$\{rec\.round\}\.json/) // seat filenames reuse the existing seat label
  assert.match(cj, /_judges/)
})

test('(structural) steelman runoffs persist the ORIG-LETTER-mapped verdicts under distinct runoff keys', () => {
  const cj = slice('async function councilJudge(', '\n// Render the council')
  assert.match(cj, /runoff\$\{iter\}\|\$\{v\.lens\}/)
  assert.match(cj, /\$\{label\}-runoff\$\{iter\}-\$\{v\.lens\}-r1\.json/)
  const idx = cj.indexOf('steelmanVerdicts = rVerdicts.map')
  assert.ok(idx >= 0 && cj.indexOf('persistSeatFiles(steelmanVerdicts.map', idx) > idx, 'runoff persist reads the mapped verdicts')
})

test('(structural) every council checkpoint verdict.json goes through verdictEntries (8 call sites, no bare typed writes left)', () => {
  const calls = SRC.match(/\.\.\.verdictEntries\(/g) || []
  assert.equal(calls.length, 8, 'review-1 x2 (P1b/P2), review-final x3 (P5b/pick/P6), review-impl-3, review-impl-4, review-rejudge')
  assert.ok(!/verdict\.json`, content: json\(/.test(SRC), 'no checkpoint may bypass the assemble path with a bare typed verdict.json')
  for (const label of ["'review'", "'final-rank'", "'impl-3-review'", "'impl-4-review'", "'rejudge-review'"]) {
    assert.ok(SRC.includes(`, ${label})`) || SRC.includes(`, ${label}),`), `checkpoint label ${label} wired`)
  }
})

test('(structural) assemble is FULL-file verified (expected sha stays set) and the retry ladder forces typed', () => {
  const pv = slice('async function persist(pairs, phaseTitle) {', '// ---- auto-filed engine issues')
  const asm = pv.slice(pv.indexOf('f.assemble'), pv.indexOf('f.derive'))
  assert.match(asm, /expected\[f\.path\] = sha256Hex\(heredocBody\(f\.content\)\)/)
  assert.match(pv, /je-assemble\.mjs/)
  assert.match(pv, /writeAndMeasure\(missing, false\)/)
})

test('(structural) je-render stays untouched: renderers still derive from <reviewDir>/verdict.json', () => {
  const render = readFileSync(resolve(HERE, '../bin/je-render.mjs'), 'utf8')
  assert.ok(!render.includes('assemble'), 'je-render must know nothing about assembly')
  assert.ok((SRC.match(/derive: \{ mode: '(verdict-md|council-json|guidance-md)', from: `\$\{runDir\}\/review-[^`]*\/verdict\.json`/g) || []).length >= 8,
    'derived artifacts keep reading the (now assembled) verdict.json')
})

test('(structural) SUMMARY stays a typed write (v1 cut-list) and seatRefs is module state, never attached to the result', () => {
  assert.ok(!/SUMMARY\.md`,[^}]*assemble/.test(SRC))
  assert.ok(!/SUMMARY\.md`,[^}]*derive/.test(SRC))
  assert.match(SRC, /const seatRefs = Object\.create\(null\)/)
  const cj = slice('async function councilJudge(', '\n// Render the council')
  assert.ok(!/result\.(seatRefs|refs)\s*=/.test(cj), 'refs must never appear inside the returned result (json(review) parity)')
})
