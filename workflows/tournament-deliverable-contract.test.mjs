// Run G tests: standardized implement-deliverable contract (layout mandate + CONTRACT: stamp).
// Pure logic is extracted from the marked block in tournament.mjs and eval'd (repo convention —
// see tournament-mechanical-gate.test.mjs); brief wording, ordering, and stamp wiring are
// covered structurally.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

function extractBlock(begin, end) {
  const i = SRC.indexOf(begin)
  const j = SRC.indexOf(end, i >= 0 ? i : 0)
  if (i < 0 || j < 0) throw new Error(`block markers not found: ${begin}`)
  return SRC.slice(i, j)
}

const con = new Function(
  extractBlock('// ---- begin: deliverable contract gate', '// ---- end: deliverable contract gate') +
  '\nreturn { CONTRACT_CLASSES, contractStampFor, mergeContract };'
)()

// The grammar constant lives beside mechStampShell (it needs q()); recover its literal value by
// evaluating the single-quoted string from the declaration line.
const grammarMatch = SRC.match(/const CONTRACT_GRAMMAR = ('(?:[^'\\]|\\.)*')/)
assert.ok(grammarMatch, 'CONTRACT_GRAMMAR declaration found')
const CONTRACT_GRAMMAR = new Function(`return ${grammarMatch[1]}`)()

test('CONTRACT_CLASSES is the closed 5-token vocabulary', () => {
  assert.deepEqual([...con.CONTRACT_CLASSES].sort(),
    ['engine_diff', 'files_layout', 'freeform', 'patch_layout', 'unavailable'].sort())
})

test('contractStampFor: exact fixed literals per class; unknown -> check unavailable', () => {
  assert.equal(con.contractStampFor('patch_layout'), 'CONTRACT: conforming (patch layout: patches/ + APPLY.md + VERIFY.md)')
  assert.equal(con.contractStampFor('files_layout'), 'CONTRACT: conforming (full-files fallback: files/ + APPLY.md)')
  assert.equal(con.contractStampFor('engine_diff'), 'CONTRACT: conforming (engine-generated diff; repoMode)')
  assert.match(con.contractStampFor('freeform'), /^CONTRACT: non-conforming layout \(grandfathered v1/)
  assert.equal(con.contractStampFor('unavailable'), 'CONTRACT: check unavailable')
  assert.equal(con.contractStampFor('weird-token'), 'CONTRACT: check unavailable')
})

test('grammar admits every POOLED stamp and rejects unavailable (degrade-to-unstamped)', () => {
  const g = new RegExp(CONTRACT_GRAMMAR)
  for (const cls of ['patch_layout', 'files_layout', 'engine_diff', 'freeform']) {
    assert.match(con.contractStampFor(cls), g, `${cls} stamp must pass the pool grammar`)
  }
  // 'unavailable' must NOT match: a contract.txt carrying it (or any junk) is deleted by the
  // shell guard, so the pool degrades to no CONTRACT block at all — never a fallback stamp.
  assert.ok(!g.test(con.contractStampFor('unavailable')), 'unavailable is never pooled')
  assert.ok(!g.test('CONTRACT: made-up free text'), 'free text rejected')
})

test('mergeContract: routes by class, purely additive, never touches valid/failReason', () => {
  const staged = [
    { blind: 'A', valid: true }, { blind: 'B', valid: true },
    { blind: 'C', valid: true }, { blind: 'D', valid: false, failReason: 'no deliverable saved' },
  ]
  const out = con.mergeContract(staged, {
    A: { contract: 'patch_layout' },
    B: { contract: 'freeform' },
    C: { contract: 'bogus' },          // unknown token -> unavailable, still valid
    D: { contract: 'patch_layout' },   // upstream-invalid: stamped, never revalidated
  }, false)
  assert.equal(out[0].contract.class, 'patch_layout')
  assert.equal(out[0].valid, true)
  assert.equal(out[1].contract.class, 'freeform')
  assert.equal(out[1].valid, true, 'freeform NEVER invalidates (v1 grandfathering)')
  assert.equal(out[1].failReason, undefined)
  assert.equal(out[2].contract.class, 'unavailable')
  assert.equal(out[2].valid, true)
  assert.equal(out[3].contract.class, 'patch_layout')
  assert.equal(out[3].valid, false, 'never revalidates an upstream-invalid candidate')
  assert.equal(out[3].failReason, 'no deliverable saved')
})

test('mergeContract fail-safe: dead helper (null byBlind) -> all unavailable, nothing invalidated', () => {
  const dead = con.mergeContract([{ blind: 'A', valid: true }, { blind: 'B', valid: false, failReason: 'x' }], null, false)
  assert.equal(dead[0].contract.class, 'unavailable')
  assert.equal(dead[0].valid, true)
  assert.equal(dead[1].contract.class, 'unavailable')
  assert.equal(dead[1].valid, false)
})

test('mergeContract repoMode: forced engine_diff in pure code, ignoring any helper output', () => {
  const out = con.mergeContract(
    [{ blind: 'A', valid: true }, { blind: 'B', valid: false, failReason: 'x' }],
    { A: { contract: 'freeform' }, B: { contract: 'patch_layout' } }, true)
  assert.equal(out[0].contract.class, 'engine_diff')
  assert.equal(out[1].contract.class, 'engine_diff')
  assert.equal(out[0].valid, true)
  assert.equal(out[1].valid, false)
})

// ---- structural: brief() wording lands in the right branch ONLY ----

const briefStart = SRC.indexOf('function brief(')
const briefEnd = SRC.indexOf('// GLM display model', briefStart)
const briefSrc = SRC.slice(briefStart, briefEnd)
const planBranch = briefSrc.slice(briefSrc.indexOf("if (kind === 'plan')"), briefSrc.indexOf('// ---- IMPLEMENT phase'))
const repoBranch = briefSrc.slice(briefSrc.indexOf('if (repoMode) {'), briefSrc.indexOf('You are solving a self-contained task'))
const scratchBranch = briefSrc.slice(briefSrc.indexOf('You are solving a self-contained task'))

test('(structural) non-repoMode implement brief mandates the layout + self-verify', () => {
  assert.match(scratchBranch, /DELIVERABLE CONTRACT/)
  assert.match(scratchBranch, /patches\//)
  assert.match(scratchBranch, /APPLY\.md/)
  assert.match(scratchBranch, /VERIFY\.md/)
  assert.match(scratchBranch, /files\//)
  assert.match(scratchBranch, /git apply --check/)
  assert.match(scratchBranch, /until it exits 0/)
})

test('(structural) plan brief and repoMode brief carry NO contract mandate', () => {
  assert.ok(planBranch.length > 100 && repoBranch.length > 100, 'branch slices found')
  for (const [name, branch] of [['plan', planBranch], ['repoMode', repoBranch]]) {
    assert.ok(!branch.includes('DELIVERABLE CONTRACT'), `${name} branch must not carry the contract`)
    assert.ok(!branch.includes('APPLY.md'), `${name} branch must not name APPLY.md`)
  }
})

// ---- structural: gate wiring, ordering, stamp parity ----

test('(structural) contract merge runs inside mechanicalPatchGate, after the mechanical merge', () => {
  const gateStart = SRC.indexOf('async function mechanicalPatchGate')
  const gateEnd = SRC.indexOf('async function stageAndValidate', gateStart)
  const gate = SRC.slice(gateStart, gateEnd)
  assert.ok(gate.includes('mergeContract('), 'mechanicalPatchGate calls mergeContract')
  assert.match(gate, /mergeContract\(mergeMechanical\(/, 'mechanical merge feeds the contract merge (nested composition)')
  assert.ok(gate.includes('JCON'), 'per-candidate script emits JCON lines')
  // single helper call for both axes: exactly one mechanical-gate label, no contract-gate label
  assert.equal(gate.split("label: 'mechanical-gate'").length, 2, 'one classification helper call')
  assert.ok(!gate.includes("label: 'contract-gate'"), 'no second helper round-trip')
})

test('(structural) both pool writers stamp CONTRACT after MECHANICAL; stamp files excluded from raw cat', () => {
  // shared stamp shell used by its definition + both pool writers (mirrors the mechStampShell guard)
  assert.ok(SRC.split('contractStampShell(dest)').length >= 3, 'shared contract stamp shell in both pool writers')
  for (const line of SRC.split('\n').filter(l => l.includes('mechStampShell(dest)') && l.includes('contractStampShell(dest)'))) {
    assert.ok(line.indexOf('mechStampShell(dest)') < line.indexOf('contractStampShell(dest)'), 'mechanical stamp before contract stamp')
  }
  // the non-repoMode pool rebuild + nfiles count must not treat stamp files as deliverable content
  assert.ok(SRC.includes('! -name mechanical.txt ! -name contract.txt'), 'contract.txt excluded beside mechanical.txt')
})

test('(structural) MECH_SCHEMA: contract is optional (fail-safe), required unchanged', () => {
  const s = SRC.indexOf('const MECH_SCHEMA')
  const e = SRC.indexOf('async function mechanicalPatchGate', s)
  const schema = SRC.slice(s, e)
  assert.match(schema, /contract: \{ type: 'string' \}/)
  assert.match(schema, /required: \['blind', 'class'\]/)
  assert.ok(!/required: \[[^\]]*contract/.test(schema), 'contract never required')
})

test('(structural) mapping records the contract class beside mechanical; gate never reads it', () => {
  const irStart = SRC.indexOf('async function implementRound')
  const irEnd = SRC.indexOf('async function implementPhase', irStart)
  const ir = SRC.slice(irStart, irEnd)
  assert.match(ir, /contract: c\.contract\.class/, 'mapping carries the class')
  // v1 never gates on conformance: the round gate reads only the council verdict + valid flags
  const gpStart = SRC.indexOf('function implGatePassed')
  const gpEnd = SRC.indexOf('async function implementRound', gpStart)
  assert.ok(!SRC.slice(gpStart, gpEnd).includes('.contract'), 'implGatePassed never reads .contract')
})
