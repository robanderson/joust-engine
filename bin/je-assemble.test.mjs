// je-assemble.mjs tests (structural persist phase 2, issue #33): byte-parity fixtures vs the
// current typed pipeline, plus corruption injection. The seat files + tally skeleton are built
// THE WAY THE ENGINE WOULD — via the extract-and-eval'd buildTallySkeleton from tournament.mjs
// and the engine's exact serialization (JSON.stringify(obj, null, 2) + '\n') — so a green run
// here is real parity evidence, not a self-consistent mock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSEMBLE = resolve(HERE, 'je-assemble.mjs')
const RENDER = resolve(HERE, 'je-render.mjs')
const SRC = readFileSync(resolve(HERE, '../workflows/tournament.mjs'), 'utf8')

function slice(beginMark, endMark) {
  const i = SRC.indexOf(beginMark)
  const j = SRC.indexOf(endMark, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`markers not found: ${beginMark}`)
  return SRC.slice(i, j)
}
const { buildTallySkeleton } = new Function(
  slice('// ---- begin: tally skeleton builder', '// ---- end: tally skeleton builder') +
  '\nreturn { buildTallySkeleton };')()

const json = obj => JSON.stringify(obj, null, 2) + '\n' // the engine's exact serializer
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex')

// ---- fixture factories: roundRecord-entry-shaped seat verdicts + buildCouncilResult-shaped results ----
const seatVerdict = (lens, vote, ranking, extra = {}) => ({
  lens, rc: '00', judge_model: extra.judgeModel || 'opus', vote, ranking,
  reasoning: extra.reasoning || `${lens}: candidate ${vote} best meets the brief — é漢字🚀 multibyte parity check`,
  checks_run: [`read review-1/${vote}/proposal.md — confirmed the acceptance section`],
  pros_cons: ranking.map(l => ({ label: l, pros: [`[${lens}] ${l} pro`], cons: l === vote ? [] : [`[${lens}] ${l} con`] })),
  changed_this_round: false, changed_from_round1: false, response_to_peers: '',
  ...(extra.safety ? { safety: extra.safety } : {}),
})
const roundRec = (n, verdicts, votes, { vetoed = [], winner = null, dead = [] } = {}) => ({
  round: n, living: verdicts.map(v => v.lens), votes, vetoed, winner, dead_seats: dead, verdicts,
})
const makeResult = ({ winner, ranking, rounds, no_consensus = false, humanReason, councilExtra = {}, extra = {} }) => ({
  candidates: ranking.map(l => ({ label: l, pros: [`[spec] ${l} complete`], cons: [`[craft] ${l} terse`] })),
  ranking, winner,
  reasoning: no_consensus ? `NO_CONSENSUS after ${rounds.length} council round(s): ${humanReason}.` : `Council majority: Candidate ${winner}.`,
  council: {
    lenses: ['correctness', 'spec', 'security', 'robustness', 'craft'],
    rounds_used: rounds.length, rounds,
    vote_evolution: rounds.map(r => ({ round: r.round, votes: r.votes, vetoed: r.vetoed, winner: r.winner, living: r.living })),
    veto_events: rounds[rounds.length - 1].vetoed, final_living: rounds[rounds.length - 1].living.length,
    no_consensus, ...(no_consensus ? { human_reason: humanReason } : {}), ...councilExtra,
  },
  no_consensus, ...extra,
})

const FIVE = ['correctness', 'spec', 'security', 'robustness', 'craft']
const r1 = (votes = {}) => FIVE.map(k => seatVerdict(k, votes[k] || 'A', votes[k] === 'B' ? ['B', 'A'] : ['A', 'B']))

// The 6 result shapes from the spec's test plan.
const FIXTURES = {
  majority: makeResult({ winner: 'A', ranking: ['A', 'B'], rounds: [roundRec(1, r1({ craft: 'B' }), { A: 4, B: 1 }, { winner: 'A' })] }),
  'fast-tally-carried': makeResult({
    winner: 'A', ranking: ['A', 'B', 'C'],
    rounds: [roundRec(1, r1({ spec: 'B', craft: 'B' }), { A: 3, B: 2 })],
    councilExtra: { fast_tally: true, carried: ['A', 'B'] },
    extra: { carried: ['A', 'B'], guidance: { positives: [{ text: 'small diffs', conf: 'strong', why: 'held across attempts' }], challenges: ['scope creep'], carried_note: 'Carried champion(s): A, B (vote split A:3, B:2) — these set the bar the final pool must beat.' } },
  }),
  'steelman-multi-round': makeResult({
    winner: 'B', ranking: ['B', 'A'],
    rounds: [ // two round records exercise lens-key + ROUND matching (r1 vs r2 seat files)
      roundRec(1, r1({ spec: 'B', craft: 'B' }), { A: 3, B: 2 }),
      roundRec(2, FIVE.map(k => seatVerdict(k, 'B', ['B', 'A'], { reasoning: `${k}: round-2 view` })), { B: 5 }, { winner: 'B' }),
    ],
    councilExtra: { steelman: { seeds: ['A', 'B'], seed_votes: { A: 3, B: 2 }, seed_majority: null, decided_by: 'majority',
      rounds: [
        { iteration: 1, change_lists: { A: ['tighten docs'], B: ['fix empty input'] }, gate: { A: 'boosted', B: 'boosted' }, votes: { A: 2, B: 2 }, vetoed: [], winner: null },
        { iteration: 2, change_lists: { A: ['name the risk'], B: ['cite the check'] }, gate: { A: 'ratchet', B: 'boosted' }, votes: { A: 1, B: 4 }, vetoed: [], winner: 'B' },
      ] } },
  }),
  no_consensus: makeResult({
    winner: null, ranking: ['A', 'B'], no_consensus: true,
    humanReason: 'all candidates were vetoed UNSAFE by the security lens(es)',
    rounds: [roundRec(1, r1(), {}, { vetoed: ['A', 'B'] })],
  }),
  'dead-seat': makeResult({
    winner: 'A', ranking: ['A', 'B'],
    rounds: [roundRec(1, r1().slice(0, 3), { A: 3 }, { winner: 'A', dead: [{ lens: 'robustness', rc: '09', reason: 'lens-seat-dead-after-retries' }, { lens: 'craft', rc: '09', reason: 'lens-seat-dead-after-retries' }] })],
  }),
  'dual-security': makeResult({
    winner: 'A', ranking: ['A', 'B'],
    rounds: [roundRec(1, [
      ...r1().slice(0, 4),
      seatVerdict('security', 'A', ['A', 'B'], { safety: [{ label: 'A', safety: 'SAFE' }, { label: 'B', safety: 'UNSAFE', severity: 'high', evidence: 'curl | bash in setup' }] }),
      seatVerdict('security-x', 'A', ['A', 'B'], { judgeModel: 'codex-xhigh', safety: [{ label: 'A', safety: 'SAFE' }, { label: 'B', safety: 'UNSAFE', severity: 'high', evidence: 'unpinned install script' }] }),
    ].filter(v => v.lens !== 'security' || v.safety), { A: 4, B: 1 }, { vetoed: ['B'], winner: 'A' })],
  }),
}

// Write seat files + tally.json exactly the way the engine would: seat file = json(entry) under
// <runDir>/review-1/_judges/, ref = { rel: runDir-relative, sha: sha256(bytes) }, skeleton via the
// engine's own buildTallySkeleton, serialized with the engine's json(). `inline` lens|round keys
// simulate seats whose persist failed (they get NO ref and stay inline in the skeleton).
function writeRun(result, { inline = new Set(), label = 'review' } = {}) {
  const runDir = mkdtempSync(join(tmpdir(), 'je-assemble-'))
  const judgesDir = join(runDir, 'review-1', '_judges')
  mkdirSync(judgesDir, { recursive: true })
  const refs = {}
  const seatPaths = []
  for (const r of result.council.rounds) {
    for (const v of r.verdicts) {
      const key = `${v.lens}|r${r.round}`
      if (inline.has(key)) continue
      const name = `${label}-${v.lens}-r${r.round}.json`
      const body = json(v)
      writeFileSync(join(judgesDir, name), body)
      refs[key] = { rel: `review-1/_judges/${name}`, sha: sha(body) }
      seatPaths.push(join(judgesDir, name))
    }
  }
  const tallyPath = join(judgesDir, 'tally.json')
  writeFileSync(tallyPath, json(buildTallySkeleton(result, refs)))
  return { runDir, tallyPath, outPath: join(runDir, 'review-1', 'verdict.json'), refs, seatPaths }
}
const runAssemble = (tallyPath, outPath) => execFileSync('node', [ASSEMBLE, tallyPath, outPath], { stdio: 'pipe' })

// ---- byte-parity: assembled verdict.json === json(result) for every fixture shape ----
for (const [name, result] of Object.entries(FIXTURES)) {
  test(`byte-parity (${name}): assembled verdict.json is byte-equal to the engine's json(result)`, () => {
    const { runDir, tallyPath, outPath } = writeRun(result)
    runAssemble(tallyPath, outPath)
    assert.equal(readFileSync(outPath, 'utf8'), json(result))
    rmSync(runDir, { recursive: true, force: true })
  })
}

test('byte-parity survives a ref-less (inline) seat mixed with spliced ones', () => {
  const { runDir, tallyPath, outPath } = writeRun(FIXTURES['dead-seat'], { inline: new Set(['spec|r1']) })
  const skel = JSON.parse(readFileSync(tallyPath, 'utf8'))
  const specEntry = skel.council.rounds[0].verdicts.find(v => v.lens === 'spec')
  assert.ok(specEntry && !specEntry.$seat, 'the inline seat must be a full verdict in the skeleton, not a ref')
  runAssemble(tallyPath, outPath)
  assert.equal(readFileSync(outPath, 'utf8'), json(FIXTURES['dead-seat']))
  rmSync(runDir, { recursive: true, force: true })
})

test('the tally skeleton is small: refs, not bodies (multi-round fixture)', () => {
  const { runDir, tallyPath } = writeRun(FIXTURES['steelman-multi-round'])
  const skel = JSON.parse(readFileSync(tallyPath, 'utf8'))
  for (const r of skel.council.rounds) for (const v of r.verdicts) {
    assert.match(v.$seat, /^review-1\/_judges\/review-.*-r[12]\.json$/)
    assert.match(v.sha256, /^[0-9a-f]{64}$/)
  }
  rmSync(runDir, { recursive: true, force: true })
})

// ---- acceptance (spec 2026-07-06-persist-phase2): >=100KB verdict, <30KB model-typed checkpoint
// payload (the tally skeleton — seat files are amortized during judging), byte-identical, <60s ----
test('acceptance: a >=100KB verdict assembles byte-identical with a <30KB tally skeleton in well under 60s', () => {
  const fat = (lens) => seatVerdict(lens, 'A', ['A', 'B', 'C'], {
    reasoning: `${lens}: ` + `evidence line about candidate behaviour under load — é漢字🚀. `.repeat(400),
  })
  const result = makeResult({ winner: 'A', ranking: ['A', 'B', 'C'],
    rounds: [roundRec(1, FIVE.map(fat), { A: 5 }, { winner: 'A' })] })
  const bytes = json(result)
  assert.ok(bytes.length >= 100 * 1024, `fixture verdict must be >=100KB (got ${bytes.length})`)
  const { runDir, tallyPath, outPath } = writeRun(result)
  const skeletonBytes = readFileSync(tallyPath, 'utf8').length
  assert.ok(skeletonBytes < 30 * 1024, `checkpoint-typed payload (tally skeleton) must be <30KB (got ${skeletonBytes})`)
  const t0 = Date.now()
  runAssemble(tallyPath, outPath)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 60_000, `assembly must complete in <60s (took ${elapsed}ms)`)
  assert.equal(readFileSync(outPath, 'utf8'), bytes)
  rmSync(runDir, { recursive: true, force: true })
})

// ---- je-render parity: derived artifacts over ASSEMBLED vs TYPED verdict.json are byte-identical ----
test('je-render verdict-md + council-json over assembled vs typed verdict.json: byte-identical', () => {
  for (const [name, result] of Object.entries(FIXTURES)) {
    const { runDir, tallyPath, outPath } = writeRun(result)
    runAssemble(tallyPath, outPath)
    const typedPath = join(runDir, 'typed-verdict.json')
    writeFileSync(typedPath, json(result)) // today's pipeline: the model-typed write
    for (const [mode, out] of [['verdict-md', 'v.md'], ['council-json', 'c.json']]) {
      execFileSync('node', [RENDER, mode, outPath, join(runDir, `assembled-${out}`), 'Parity verdict'], { stdio: 'pipe' })
      execFileSync('node', [RENDER, mode, typedPath, join(runDir, `typed-${out}`), 'Parity verdict'], { stdio: 'pipe' })
      assert.equal(readFileSync(join(runDir, `assembled-${out}`), 'utf8'), readFileSync(join(runDir, `typed-${out}`), 'utf8'),
        `${mode} must not differ between assembled and typed verdict.json (${name})`)
    }
    rmSync(runDir, { recursive: true, force: true })
  }
})

// ---- corruption injection: every failure exits nonzero and NAMES the offending path ----
const expectFail = (args, reMsg, code = 1) => {
  try {
    execFileSync('node', args, { stdio: 'pipe' })
    assert.fail('expected je-assemble to exit nonzero')
  } catch (e) {
    assert.equal(e.status, code, `exit code (stderr: ${String(e.stderr)})`)
    assert.match(String(e.stderr), reMsg)
  }
}

test('corruption: one flipped byte in a seat file -> nonzero exit naming the path (sha mismatch)', () => {
  const { runDir, tallyPath, outPath, seatPaths } = writeRun(FIXTURES.majority)
  const victim = seatPaths[1]
  const bytes = readFileSync(victim, 'utf8')
  writeFileSync(victim, bytes.replace('candidate', 'çandidate')) // one corrupted char
  expectFail([ASSEMBLE, tallyPath, outPath], new RegExp(`sha mismatch for .*${victim.split('/').pop().replace('.', '\\.')}`))
  rmSync(runDir, { recursive: true, force: true })
})

test('corruption: truncated tally.json -> nonzero exit', () => {
  const { runDir, tallyPath, outPath } = writeRun(FIXTURES.majority)
  const t = readFileSync(tallyPath, 'utf8')
  writeFileSync(tallyPath, t.slice(0, Math.floor(t.length / 2)))
  expectFail([ASSEMBLE, tallyPath, outPath], /unreadable tally/)
  rmSync(runDir, { recursive: true, force: true })
})

test('corruption: ref to a missing seat file -> nonzero exit naming the path', () => {
  const { runDir, tallyPath, outPath, seatPaths } = writeRun(FIXTURES.majority)
  rmSync(seatPaths[0])
  expectFail([ASSEMBLE, tallyPath, outPath], /missing seat file .*review-correctness-r1\.json/)
  rmSync(runDir, { recursive: true, force: true })
})

test('corruption: seat file valid sha but unparseable JSON -> nonzero exit naming the path', () => {
  const { runDir, tallyPath, outPath, seatPaths } = writeRun(FIXTURES.majority)
  const broken = 'not json at all\n'
  writeFileSync(seatPaths[0], broken)
  // re-pin the ref sha so ONLY the parse fails (isolates the parse guard from the sha guard)
  const skel = JSON.parse(readFileSync(tallyPath, 'utf8'))
  skel.council.rounds[0].verdicts[0].sha256 = sha(broken)
  writeFileSync(tallyPath, json(skel))
  expectFail([ASSEMBLE, tallyPath, outPath], /unparseable seat file/)
  rmSync(runDir, { recursive: true, force: true })
})

test('usage error: missing args -> exit 2', () => {
  expectFail([ASSEMBLE], /usage: je-assemble\.mjs/, 2)
})
