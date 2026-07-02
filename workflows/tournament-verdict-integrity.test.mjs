// workflows/tournament-verdict-integrity.test.mjs
// Regression test for the verdict-integrity guard (EV-judge-placeholder.md): a real observed run where a
// structured-output judge returned literal placeholder values for EVERY field ("test" as reasoning and as
// every candidate's pros/cons) and, because it was schema-valid, passed reconcile()'s label-permutation
// repair and drove a whole round (wrong winner, meaningless round-2 guidance). The guard block lives inside
// workflows/tournament.mjs (a top-level-return sandbox script, not an importable ES module), so — following
// this repo's existing precedent (tournament.contributions.test.mjs) — we extract the marked block from the
// shipped source and eval it, rather than hand-copying the logic (which would silently drift from reality).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(HERE, 'tournament.mjs'), 'utf8')

const BEGIN = '// ---- begin: verdict integrity guard ----------------------------------------------------------'
const END = '// ---- end: verdict integrity guard ------------------------------------------------------------'
const i = SRC.indexOf(BEGIN)
const j = SRC.indexOf(END, i >= 0 ? i : 0)
if (i < 0 || j < 0) throw new Error('verdict-integrity block markers not found in workflows/tournament.mjs')
const block = SRC.slice(i, j)

const sandbox = {}
new Function('sandbox', `
  with (sandbox) {
    ${block}
    sandbox.verdictIntegrityIssue  = verdictIntegrityIssue
    sandbox.checksRunIssue         = checksRunIssue
    sandbox.vetoEvidenceIssue      = vetoEvidenceIssue
    sandbox.guidanceIntegrityIssue = guidanceIntegrityIssue
  }
`)(sandbox)
const { verdictIntegrityIssue, checksRunIssue, vetoEvidenceIssue, guidanceIntegrityIssue } = sandbox
for (const fn of ['verdictIntegrityIssue', 'checksRunIssue', 'vetoEvidenceIssue', 'guidanceIntegrityIssue']) {
  assert.equal(typeof sandbox[fn], 'function', `${fn} must be a function`)
}

// ----- the exact observed failure (EV-judge-placeholder.md), verbatim from review-1/verdict.json -----
const JUNK_VERDICT = {
  candidates: [
    { label: 'A', pros: ['test'], cons: ['test'] },
    { label: 'C', pros: ['test'], cons: ['test'] },
    { label: 'D', pros: ['test'], cons: ['test'] },
  ],
  ranking: ['A', 'D', 'C'],
  winner: 'A',
  reasoning: 'test',
  guidance: {
    positives: [{ text: 'a', conf: 'strong', why: 'b' }],
    challenges: [{ text: 'c', conf: 'strong', why: 'd' }],
  },
}

test('reproduces the exact observed failure: the junk verdict is flagged', () => {
  assert.ok(verdictIntegrityIssue(JUNK_VERDICT), 'the literal all-"test" verdict must be caught')
})

test('reproduces the exact observed failure: the junk guidance is flagged', () => {
  assert.ok(guidanceIntegrityIssue(JUNK_VERDICT.guidance), 'the literal {text:"a"/"c", why:"b"/"d"} guidance must be caught')
})

// ----- no false positives: a realistic, legitimate, even fairly terse verdict must pass clean -----
const REALISTIC_VERDICT = {
  candidates: [
    { label: 'A', pros: ['Handles the empty-input case explicitly'], cons: ['No input validation on the count argument'] },
    { label: 'B', pros: ['Clear separation of parsing and rendering'], cons: ['Off-by-one on the last page of results'] },
    { label: 'C', pros: ['Smallest diff, easiest to review'], cons: ['Duplicates the retry loop instead of extracting a helper'] },
  ],
  ranking: ['A', 'C', 'B'],
  winner: 'A',
  reasoning: 'A is the only candidate that handles empty input without throwing.',
}

test('does not flag a realistic legitimate verdict', () => {
  assert.equal(verdictIntegrityIssue(REALISTIC_VERDICT), null)
})

test('does not flag a legitimate but genuinely terse verdict (short reasoning, diverse pros/cons)', () => {
  const terse = { ...REALISTIC_VERDICT, reasoning: 'A wins outright.' } // short, but real and >= MIN_REASONING_CHARS
  assert.equal(verdictIntegrityIssue(terse), null)
})

test('does not flag two candidates legitimately sharing one short con (thin reasoning alone is not enough)', () => {
  // Real judges sometimes reuse a short phrase across candidates; that alone must never trip the guard —
  // only the conjunction of thin reasoning AND near-duplicate pros/cons (the observed junk shape) should.
  const sharedCon = {
    candidates: [
      { label: 'A', pros: ['Fast'], cons: ['No tests'] },
      { label: 'B', pros: ['Readable'], cons: ['No tests'] },
      { label: 'C', pros: ['Robust'], cons: ['Slow'] },
    ],
    ranking: ['C', 'B', 'A'],
    winner: 'C',
    reasoning: 'C is the most robust option and the tradeoffs are acceptable here.',
  }
  assert.equal(verdictIntegrityIssue(sharedCon), null)
})

test('does not flag a legitimate guidance list', () => {
  const g = {
    positives: [{ text: 'Validate and normalise user input before using it', conf: 'strong', why: 'held across several approaches' }],
    challenges: [{ text: 'Do not let a repeated guess decrement remaining lives', conf: 'tentative', why: 'seen once' }],
  }
  assert.equal(guidanceIntegrityIssue(g), null)
})

test('an empty guidance list is legitimate, not junk', () => {
  assert.equal(guidanceIntegrityIssue({ positives: [], challenges: [] }), null)
})

// ----- forced-evidence lever: checks_run must not be silently empty -----
test('empty checks_run is rejected (the forced-evidence lever the failure exposed)', () => {
  assert.ok(checksRunIssue([]))
})

test('checks_run of only blank/near-empty entries is rejected', () => {
  assert.ok(checksRunIssue(['', '-', 'ok']))
})

test('a real checks_run passes', () => {
  assert.equal(checksRunIssue(['ran `npm test` — 12 passed, 0 failed', 'read src/index.mjs']), null)
})

test('checks_run is not applicable to the legacy schema (undefined skips the check)', () => {
  assert.equal(checksRunIssue(undefined), null)
})

// ----- highest-stakes exclusion path: a security veto needs real evidence -----
test('an empty veto evidence string does not stand', () => {
  assert.ok(vetoEvidenceIssue(''))
})

test('a placeholder-token veto evidence string does not stand', () => {
  assert.ok(vetoEvidenceIssue('test'))
})

test('a near-empty veto evidence string does not stand', () => {
  assert.ok(vetoEvidenceIssue('bad'))
})

test('a real veto evidence string stands', () => {
  assert.equal(vetoEvidenceIssue('config.yml line 12 embeds a plaintext AWS_SECRET_ACCESS_KEY'), null)
})
