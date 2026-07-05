import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const integrityBlock = slice(
  '// ---- begin: verdict integrity guard ----------------------------------------------------------',
  '// ---- end: verdict integrity guard ------------------------------------------------------------')
const mixBlock = slice(
  '// ---- begin: codex-judge routing + verdict parsing (mixed-family council, 2026-07-05) --------------',
  '// ---- end: codex-judge routing + verdict parsing -----------------------------------------------')

const sandbox = {}
new Function('sandbox', `
  with (sandbox) {
    ${integrityBlock}
    ${mixBlock}
    sandbox.chooseJudgeDispatch = chooseJudgeDispatch
    sandbox.allowedRootsFor = allowedRootsFor
    sandbox.verdictShapeIssue = verdictShapeIssue
    sandbox.checksRunRootsIssue = checksRunRootsIssue
    sandbox.parseCodexJudgeDump = parseCodexJudgeDump
    sandbox.isSecurityLens = isSecurityLens
  }
`)(sandbox)
const { chooseJudgeDispatch, allowedRootsFor, verdictShapeIssue, checksRunRootsIssue, parseCodexJudgeDump, isSecurityLens } = sandbox

// ----- seat routing / fallback decision -----
const CODEX_LENS = { key: 'spec', judge: { kind: 'codex', displayModel: 'codex-xhigh' } }
const NATIVE_LENS = { key: 'correctness' }

test('a codex-seat lens routes to codex when mixed + runner configured', () => {
  assert.equal(chooseJudgeDispatch(CODEX_LENS, false, true), 'codex')
})
test('judgeMix:anthropic forces native even for a codex-seat lens', () => {
  assert.equal(chooseJudgeDispatch(CODEX_LENS, true, true), 'native')
})
test('missing codexRunner forces native for a codex-seat lens (never crash for a missing optional runner)', () => {
  assert.equal(chooseJudgeDispatch(CODEX_LENS, false, false), 'native')
})
test('a lens with no judge field always stays native', () => {
  assert.equal(chooseJudgeDispatch(NATIVE_LENS, false, true), 'native')
})

// ----- allowedRootsFor -----
test('allowedRootsFor includes the pool and every candidate ws', () => {
  const roots = allowedRootsFor([{ ws: '/tmp/a' }, { ws: '/tmp/b' }], '/tmp/pool.md', false, null)
  assert.deepEqual(roots, ['/tmp/pool.md', '/tmp/a', '/tmp/b'])
})
test('allowedRootsFor adds worktreeRoot in repoMode', () => {
  const roots = allowedRootsFor([{ ws: '/tmp/wt/a' }], '/tmp/pool.md', true, '/tmp/wt')
  assert.ok(roots.includes('/tmp/wt'))
})

// ----- verdictShapeIssue: canned VERDICT.json cases -----
const VALID_VERDICT = {
  lens: 'spec', candidates: [{ label: 'A', pros: ['x'], cons: ['y'] }],
  ranking: ['A'], vote: 'A', reasoning: 'A meets every stated requirement.', checks_run: ['read spec.md: matches'],
}
test('a well-formed VERDICT.json passes shape validation', () => {
  assert.equal(verdictShapeIssue(VALID_VERDICT), null)
})
for (const [name, mutate] of [
  ['missing lens', (v) => { const c = { ...v }; delete c.lens; return c }],
  ['candidates not an array', (v) => ({ ...v, candidates: 'nope' })],
  ['candidate missing pros', (v) => ({ ...v, candidates: [{ label: 'A', cons: [] }] })],
  ['ranking has a non-string', (v) => ({ ...v, ranking: [1] })],
  ['vote missing', (v) => { const c = { ...v }; delete c.vote; return c }],
  ['checks_run not an array', (v) => ({ ...v, checks_run: 'nope' })],
]) {
  test(`shape validation rejects: ${name}`, () => {
    assert.ok(verdictShapeIssue(mutate(VALID_VERDICT)))
  })
}

// ----- 6th seat (dual security gates): predicate, routing, safety shape -----
test('isSecurityLens covers both security seats and nothing else', () => {
  assert.equal(isSecurityLens('security'), true)
  assert.equal(isSecurityLens('security-x'), true)
  assert.equal(isSecurityLens('spec'), false)
})
test('security-x seat routes to codex (and falls back to native without a runner)', () => {
  const SECX = { key: 'security-x', judge: { kind: 'codex', displayModel: 'codex-xhigh' } }
  assert.equal(chooseJudgeDispatch(SECX, false, true), 'codex')
  assert.equal(chooseJudgeDispatch(SECX, false, false), 'native')
  assert.equal(chooseJudgeDispatch(SECX, true, true), 'native')
})
test('shape validation accepts a valid optional safety array', () => {
  assert.equal(verdictShapeIssue({ ...VALID_VERDICT, safety: [{ label: 'A', safety: 'SAFE' }] }), null)
})
test('shape validation rejects a malformed safety array', () => {
  assert.ok(verdictShapeIssue({ ...VALID_VERDICT, safety: [{ label: 42 }] }))
  assert.ok(verdictShapeIssue({ ...VALID_VERDICT, safety: 'UNSAFE' }))
})

// ----- parseCodexJudgeDump: canned raw dumps (log + VERDICT.json, sentinel-joined) -----
const LOG_MARK = '===JE-CODEX-JUDGE-LOG==='
const VERDICT_MARK = '===JE-CODEX-JUDGE-VERDICT==='
const goodLog = 'JOUST-CODEX-PROVENANCE endpoint=api.openai.com flag=-m gpt-5.5 -c model_reasoning_effort=xhigh timeout=1500s\nJOUST-CODEX-DONE exit=0\n'
const dump = (log, verdictJson) => `${LOG_MARK}${log}${VERDICT_MARK}${verdictJson}`

test('parseCodexJudgeDump accepts a well-formed dump', () => {
  const r = parseCodexJudgeDump(dump(goodLog, JSON.stringify(VALID_VERDICT)))
  assert.equal(r.ok, true)
  assert.equal(r.verdict.vote, 'A')
})
test('parseCodexJudgeDump rejects missing provenance (runner never ran)', () => {
  const r = parseCodexJudgeDump(dump('some unrelated log text\n', JSON.stringify(VALID_VERDICT)))
  assert.equal(r.ok, false)
})
test('parseCodexJudgeDump rejects a TIMEOUT run', () => {
  const r = parseCodexJudgeDump(dump(goodLog + 'JOUST-CODEX-TIMEOUT secs=1500\n', JSON.stringify(VALID_VERDICT)))
  assert.equal(r.ok, false)
})
test('parseCodexJudgeDump rejects malformed JSON (never kills the caller — returns ok:false)', () => {
  const r = parseCodexJudgeDump(dump(goodLog, '{ this is not valid json'))
  assert.equal(r.ok, false)
  assert.match(r.reason, /not valid JSON/)
})
test('parseCodexJudgeDump rejects an empty VERDICT.json', () => {
  const r = parseCodexJudgeDump(dump(goodLog, ''))
  assert.equal(r.ok, false)
})
test('parseCodexJudgeDump rejects a shape-invalid verdict', () => {
  const r = parseCodexJudgeDump(dump(goodLog, JSON.stringify({ lens: 'spec' })))
  assert.equal(r.ok, false)
})
test('parseCodexJudgeDump composes onto the existing integrity guard (schema-valid junk still rejected)', () => {
  const junk = { ...VALID_VERDICT, reasoning: 'test', candidates: [{ label: 'A', pros: ['test'], cons: ['test'] }, { label: 'B', pros: ['test'], cons: ['test'] }, { label: 'C', pros: ['test'], cons: ['test'] }] }
  const r = parseCodexJudgeDump(dump(goodLog, JSON.stringify(junk)))
  assert.equal(r.ok, false)
  assert.match(r.reason, /integrity check/)
})
test('parseCodexJudgeDump missing markers entirely (read-back step failed) is a clean rejection, not a throw', () => {
  assert.doesNotThrow(() => parseCodexJudgeDump('garbage with no markers at all'))
  assert.equal(parseCodexJudgeDump('garbage with no markers at all').ok, false)
})

// ----- checksRunRootsIssue: allowed-roots warning -----
const ROOTS = ['/tmp/run/review-1/_pool.md', '/tmp/run/review-1/A']
test('checksRunRootsIssue is null for in-scope paths', () => {
  assert.equal(checksRunRootsIssue(['read /tmp/run/review-1/A/main.py: looks correct'], ROOTS), null)
})
test('checksRunRootsIssue flags a path outside the allowed roots (e.g. the live checkout)', () => {
  const issue = checksRunRootsIssue(['ran tests in /Users/dev/real-repo/src: all green'], ROOTS)
  assert.ok(issue)
  assert.match(issue, /\/Users\/dev\/real-repo\/src/)
})
test('checksRunRootsIssue does not flag prose with no path-looking token', () => {
  assert.equal(checksRunRootsIssue(['ran the enrichment build, exit 0'], ROOTS), null)
})
test('checksRunRootsIssue is null (never fatal) when allowedRoots is empty/absent', () => {
  assert.equal(checksRunRootsIssue(['/anything'], []), null)
  assert.equal(checksRunRootsIssue(['/anything'], undefined), null)
})

// ----- structural: byte-identical gating + uniform application -----
test('(structural) judge_model is gated behind LEGACY_MIX in roundRecord', () => {
  assert.ok(SRC.includes('...(LEGACY_MIX ? {} : { judge_model: v.judgeModel || \'opus\' }),'))
})
test('(structural) LEGACY_MIX reads args.judgeMix === "anthropic"', () => {
  assert.ok(SRC.includes("const LEGACY_MIX = A.judgeMix === 'anthropic'"))
})
test('(structural) security lens never carries a judge field (code council)', () => {
  const lensesSrc = slice('const LENSES = [', ']\n')
  assert.ok(!/key:\s*'security'[^}]*judge:/.test(lensesSrc))
})
test('(structural) spec and craft carry the codex-xhigh judge field (code council)', () => {
  const lensesSrc = slice('const LENSES = [', ']\n')
  assert.match(lensesSrc, /key:\s*'spec'[^}]*judge:\s*\{\s*kind:\s*'codex'/)
  assert.match(lensesSrc, /key:\s*'craft'[^}]*judge:\s*\{\s*kind:\s*'codex'/)
})
test('(structural) completeness and simplicity carry the codex-xhigh judge field (plan council)', () => {
  const planLensesSrc = slice('const PLAN_LENSES = [', ']\n')
  assert.match(planLensesSrc, /key:\s*'completeness'[^}]*judge:\s*\{\s*kind:\s*'codex'/)
  assert.match(planLensesSrc, /key:\s*'simplicity'[^}]*judge:\s*\{\s*kind:\s*'codex'/)
  assert.ok(!/key:\s*'security'[^}]*judge:/.test(planLensesSrc)) // plan security-by-design never codex
})
test('(structural) askLens falls back to native Opus after exhausting codex retries', () => {
  const askLensSrc = slice('async function askLens(lens,', '\n}\n')
  assert.match(askLensSrc, /JE-COUNCIL-FALLBACK/)
  assert.match(askLensSrc, /askLensNative/)
})
test('(structural) dualSecurity:false drops ONLY the security-x seat; primary security has no such escape', () => {
  const src = slice('function defaultLensesFor(phaseTitle)', '\n}\n')
  assert.match(src, /A\.dualSecurity === false/)
  assert.match(src, /filter\(l => l\.key !== 'security-x'\)/)
  assert.ok(!src.includes("!== 'security'"), 'must never filter the primary security seat')
})
