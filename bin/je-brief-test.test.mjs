#!/usr/bin/env node
// je-brief-test.test.mjs — tests for the brief dry-run tester (static brief linter).
//
// Self-contained (no test framework): a tiny assert harness, fixture briefs built
// in a temp directory so path resolution is fully controlled, plus CLI-level
// checks (exit codes, --json, stdin). Auto-discovered by scripts/run-tests.mjs
// via the bin/*.test.mjs glob. Exits 0 iff all pass.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintBrief, extractPathTokens, extractDeliverables, WORD_BUDGET, RULE_IDS } from './je-brief-test.mjs'

const CLI = fileURLToPath(new URL('./je-brief-test.mjs', import.meta.url))

let passed = 0
let failed = 0
const failures = []

function unit(label, cond, extra) {
  if (cond) { passed++; return }
  failed++
  failures.push(`  [${label}]${extra ? ` ${extra}` : ''}`)
}

const get = (r, id) => r.findings.find((f) => f.id === id)
const level = (r, id) => get(r, id).level

// ---------------------------------------------------------------------------
// fixture root: a fake repo tree (not a git repo → exercises the fs fallback).
// ---------------------------------------------------------------------------
const ROOT = mkdtempSync(join(tmpdir(), 'je-brief-test-'))
mkdirSync(join(ROOT, 'lib'), { recursive: true })
writeFileSync(join(ROOT, 'lib', 'util.mjs'), 'export const x = 1\n')
writeFileSync(join(ROOT, 'lib', 'frobWidget.mjs'), '// known codename lives here as a path\n')
writeFileSync(join(ROOT, 'notes.txt'), 'hello\n')
const opts = { root: ROOT }

// A brief that satisfies every rule (the all-green baseline).
const GOOD = [
  'You are improving the tokenizer of a small parser library.',
  'Read lib/util.mjs from the provided context bundle and simplify its exported helper.',
  'Constraints: keep the public shape unchanged; smallest coherent change.',
  'Save your result to PLAN.md in your workspace.',
  'Make a single pass; once the deliverable is saved, stop.',
].join('\n')

// ---------------------------------------------------------------------------
// shape: every rule reports exactly once, in the fixed order.
// ---------------------------------------------------------------------------
{
  const r = lintBrief(GOOD, opts)
  unit('shape: 8 findings in RULE_IDS order',
    r.findings.length === 8 && r.findings.every((f, i) => f.id === RULE_IDS[i]))
  unit('shape: counts sum to 8', r.counts.pass + r.counts.warn + r.counts.fail === 8)
  unit('good brief: all pass, ok', r.ok && r.counts.fail === 0 && r.counts.warn === 0)
  unit('good brief: word count > 0', r.words > 0)
}

// ---------------------------------------------------------------------------
// rule 1 — deixis
// ---------------------------------------------------------------------------
{
  const r = lintBrief('As discussed, refactor the tokenizer.\nSave the result to OUT.md.\nSingle pass, then stop.', opts)
  unit('deixis: "as discussed" FAILs', level(r, 'deixis') === 'FAIL')
  unit('deixis: offender quoted in reason', get(r, 'deixis').reason.includes('As discussed'))
  unit('deixis: FAIL carries a suggestion', !!get(r, 'deixis').suggestion)
  unit('deixis: run not ok', r.ok === false)
}
{
  const r = lintBrief('Improve the current system.\nSave notes to NOTES.md.\nOne pass, then stop.', opts)
  unit('deixis: "the current system" with no antecedent FAILs', level(r, 'deixis') === 'FAIL')
}
{
  const r = lintBrief('Read lib/util.mjs first.\nThen simplify this file.\nSave the result to OUT.md.\nSingle pass, then stop.', opts)
  unit('deixis: "this file" with a path antecedent PASSes', level(r, 'deixis') === 'PASS')
}
{
  const r = lintBrief('Simplify this file.\nIt is lib/util.mjs.\nSave the result to OUT.md.\nSingle pass, then stop.', opts)
  unit('deixis: "this file" BEFORE any path mention FAILs', level(r, 'deixis') === 'FAIL')
}
{
  const r = lintBrief('You are working on the Acme Widget plugin codebase.\nHarden the current system against bad input.\nSave notes to NOTES.md.\nOne pass, then stop.', opts)
  unit('deixis: "the current system" with a named system PASSes', level(r, 'deixis') === 'PASS')
}

// ---------------------------------------------------------------------------
// rule 2 — paths
// ---------------------------------------------------------------------------
{
  const r = lintBrief('Read lib/missing.mjs and summarise it.\nSave the summary to OUT.md.\nSingle pass, then stop.', opts)
  unit('paths: missing relative path FAILs', level(r, 'paths') === 'FAIL')
  unit('paths: missing token named', get(r, 'paths').details.includes('lib/missing.mjs'))
}
{
  const r = lintBrief('Read /definitely/not/here/x.mjs.\nSave the summary to OUT.md.\nSingle pass, then stop.', opts)
  unit('paths: missing absolute path FAILs', level(r, 'paths') === 'FAIL')
}
{
  const r = lintBrief(`Read lib/util.mjs and ${ROOT}/notes.txt.\nSave the summary to OUT.md.\nSingle pass, then stop.`, opts)
  unit('paths: existing relative + absolute PASS', level(r, 'paths') === 'PASS')
}
{
  const r = lintBrief('Consult ghost.json for the schema.\nSave the summary to OUT.md.\nSingle pass, then stop.', opts)
  unit('paths: missing bare filename is WARN not FAIL', level(r, 'paths') === 'WARN')
  unit('paths: WARN-only run still ok (exit 0 tier)', r.ok === true && r.counts.warn >= 1)
}
{
  const r = lintBrief('Consult notes.txt for context.\nSave the summary to OUT.md.\nSingle pass, then stop.', opts)
  unit('paths: bare filename found in tree PASSes', level(r, 'paths') === 'PASS')
}
{
  // Deliverable targets are outputs to CREATE — never flagged as unresolved.
  const r = lintBrief('Write your plan to docs/PLAN.md.\nSingle pass, then stop.', opts)
  unit('paths: deliverable path excluded from resolution', level(r, 'paths') === 'PASS')
  unit('paths: deliverable still satisfies rule 3', level(r, 'deliverable') === 'PASS')
}
{
  // Slash-token with no extension and no dot-prefix (e.g. a fn/fn mention) is skipped.
  const r = lintBrief('The stageAndValidate/enrichBlindPool area is relevant, both already repeated: stageAndValidate, enrichBlindPool.\nSave notes to OUT.md.\nSingle pass, then stop.', opts)
  unit('paths: extensionless slash mention not treated as a path', level(r, 'paths') === 'PASS')
}
{
  unit('paths: URL not extracted as path token',
    extractPathTokens('see https://example.com/a/b.md for details').every((t) => !t.token.includes('example.com')))
}

// ---------------------------------------------------------------------------
// rule 3 — deliverable contract
// ---------------------------------------------------------------------------
{
  const r = lintBrief('Analyse the tradeoffs and report back.\nSingle pass, then stop.', opts)
  unit('deliverable: no save+filename FAILs', level(r, 'deliverable') === 'FAIL')
  unit('deliverable: suggestion present', !!get(r, 'deliverable').suggestion)
}
{
  unit('deliverable: save sentence extracts filename',
    extractDeliverables('Save your plan to PLAN.md when done.').has('PLAN.md'))
  {
    // word/word prose in a deliver sentence is NOT a deliverable filename.
    const d = extractDeliverables('Deliver the reliability/efficiency plan as PLAN.md.')
    unit('deliverable: word/word prose excluded', d.has('PLAN.md') && !d.has('reliability/efficiency') && !d.has('efficiency'))
  }
  unit('deliverable: verb in another sentence does not bind',
    !extractDeliverables('Save time where you can. The file PLAN.md is described elsewhere.\nNothing to do.').has('x-none'))
}

// ---------------------------------------------------------------------------
// rule 4 — stop rule
// ---------------------------------------------------------------------------
{
  const r = lintBrief('Refactor the helper.\nSave the result to OUT.md.', opts)
  unit('stop-rule: absent FAILs', level(r, 'stop-rule') === 'FAIL')
  unit('stop-rule: makes run not ok', r.ok === false)
}
{
  const variants = [
    'Make a single pass over the code.',
    'One pass only.',
    'Do not iterate on feedback.',
    'Hard-stop after saving.',
    'Once written, STOP.',
    'No further passes.',
  ]
  for (const v of variants) {
    const r = lintBrief(`Refactor the helper.\nSave the result to OUT.md.\n${v}`, opts)
    unit(`stop-rule: "${v}" PASSes`, level(r, 'stop-rule') === 'PASS')
  }
}

// ---------------------------------------------------------------------------
// rule 5 — conflicting directives (WARN)
// ---------------------------------------------------------------------------
{
  const r = lintBrief('Do not implement anything yet.\nThen implement the change across the module.\nSave the plan to OUT.md.\nSingle pass, then stop.', opts)
  unit('conflicts: do-not-implement vs implement WARNs', level(r, 'conflicts') === 'WARN')
  unit('conflicts: WARN does not fail the run', r.ok === true)
}
{
  const r = lintBrief('Plan only.\nAlso write the code for the new module.\nSave the plan to OUT.md.\nSingle pass, then stop.', opts)
  unit('conflicts: plan-only vs write-code WARNs', level(r, 'conflicts') === 'WARN')
}
{
  const r = lintBrief('Implement the change carefully.\nSave a summary to OUT.md.\nSingle pass, then stop.', opts)
  unit('conflicts: positive alone (no negative) PASSes', level(r, 'conflicts') === 'PASS')
}
{
  const r = lintBrief('Make the smallest coherent change and be comprehensive about edge cases.\n\nSave notes to OUT.md.\nSingle pass, then stop.', opts)
  unit('conflicts: smallest+comprehensive in one paragraph WARNs', level(r, 'conflicts') === 'WARN')
}
{
  const r = lintBrief('Make the smallest coherent change.\n\nSeparately, the exhaustive test suite lives elsewhere.\n\nSave notes to OUT.md.\nSingle pass, then stop.', opts)
  unit('conflicts: size words in different paragraphs PASS', level(r, 'conflicts') === 'PASS')
}

// ---------------------------------------------------------------------------
// rule 6 — altitude mix
// ---------------------------------------------------------------------------
{
  const r = lintBrief('Produce a DESIGN BRIEF for the cache layer.\nInclude a per-file edit list for the change.\nSave it to DESIGN.md.\nSingle pass, then stop.', opts)
  unit('altitude: design brief + per-file edit list FAILs', level(r, 'altitude') === 'FAIL')
}
{
  const r = lintBrief('Produce a design-brief for the cache layer.\nProvide full code blocks for each change.\nSave it to DESIGN.md.\nSingle pass, then stop.', opts)
  unit('altitude: design brief + code blocks FAILs', level(r, 'altitude') === 'FAIL')
}
{
  const r = lintBrief('Produce a design brief for the cache layer at concept altitude.\nSave it to DESIGN.md.\nSingle pass, then stop.', opts)
  unit('altitude: clean design brief PASSes', level(r, 'altitude') === 'PASS')
}
{
  const r = lintBrief('Produce an implementation plan with a per-file edit list.\nSave it to PLAN.md.\nSingle pass, then stop.', opts)
  unit('altitude: file-level plan WITHOUT design-brief ask PASSes', level(r, 'altitude') === 'PASS')
}

// ---------------------------------------------------------------------------
// rule 7 — undefined jargon (WARN)
// ---------------------------------------------------------------------------
{
  const r = lintBrief('Wire the flumoxTranslator into the pipeline.\nSave notes to OUT.md.\nSingle pass, then stop.', opts)
  unit('jargon: one-off undefined codename WARNs', level(r, 'jargon') === 'WARN')
  unit('jargon: codename named in details', get(r, 'jargon').details.includes('flumoxTranslator'))
  unit('jargon: WARN does not fail the run', r.ok === true)
}
{
  const r = lintBrief('Wire the flumoxTranslator (the retry helper) into the pipeline.\nSave notes to OUT.md.\nSingle pass, then stop.', opts)
  unit('jargon: inline-defined codename PASSes', level(r, 'jargon') === 'PASS')
}
{
  const r = lintBrief('Wire the flumoxTranslator into the pipeline; the flumoxTranslator owns retries.\nSave notes to OUT.md.\nSingle pass, then stop.', opts)
  unit('jargon: repeated codename PASSes', level(r, 'jargon') === 'PASS')
}
{
  const r = lintBrief('Extend frobWidget with a reset method.\nSave notes to OUT.md.\nSingle pass, then stop.', opts)
  unit('jargon: codename present in repo tree PASSes', level(r, 'jargon') === 'PASS')
}
{
  // Only the composite hyphenated token is reported, not its ALLCAPS fragments.
  const r = lintBrief('Candidates get FLAG-QUARANTINED before review.\nSave notes to OUT.md.\nSingle pass, then stop.', opts)
  const d = get(r, 'jargon').details
  unit('jargon: composite hyphen token reported once',
    level(r, 'jargon') === 'WARN' && d.includes('FLAG-QUARANTINED') && !d.includes('QUARANTINED') && !d.includes('FLAG'))
}

// ---------------------------------------------------------------------------
// rule 8 — length budget (WARN)
// ---------------------------------------------------------------------------
{
  const filler = Array(WORD_BUDGET + 10).fill('word').join(' ')
  const r = lintBrief(`${filler}\nSave notes to OUT.md.\nSingle pass, then stop.`, opts)
  unit('length: over budget WARNs', level(r, 'length') === 'WARN')
  unit('length: WARN alone keeps run ok', r.ok === true)
}
{
  const r = lintBrief(GOOD, opts)
  unit('length: short brief PASSes', level(r, 'length') === 'PASS')
}

// ---------------------------------------------------------------------------
// CLI — exit codes, --json, stdin
// ---------------------------------------------------------------------------
const goodFile = join(ROOT, 'good-brief.md')
const badFile = join(ROOT, 'bad-brief.md')
writeFileSync(goodFile, GOOD)
writeFileSync(badFile, 'As discussed, fix the thing from before.') // deixis+deliverable+stop-rule FAILs

{
  const p = spawnSync(process.execPath, [CLI, goodFile, '--root', ROOT], { encoding: 'utf8' })
  unit('CLI: all-green brief exits 0', p.status === 0, `status=${p.status} stderr=${p.stderr}`)
  unit('CLI: prints RESULT: PASS', p.stdout.includes('RESULT: PASS'))
}
{
  const p = spawnSync(process.execPath, [CLI, badFile, '--root', ROOT], { encoding: 'utf8' })
  unit('CLI: failing brief exits 1', p.status === 1)
  unit('CLI: prints RESULT: FAIL', p.stdout.includes('RESULT: FAIL'))
  unit('CLI: prints a fix line', p.stdout.includes('fix:'))
}
{
  const p = spawnSync(process.execPath, [CLI, badFile, '--json', '--root', ROOT], { encoding: 'utf8' })
  unit('CLI --json: still exits 1 on FAIL', p.status === 1)
  let j = null
  try { j = JSON.parse(p.stdout) } catch {}
  unit('CLI --json: stdout is JSON', !!j)
  unit('CLI --json: ok false + findings array', j && j.ok === false && Array.isArray(j.findings) && j.findings.length === 8)
  unit('CLI --json: counts present', j && j.counts.fail >= 3)
}
{
  const p = spawnSync(process.execPath, [CLI, '-', '--root', ROOT], { encoding: 'utf8', input: GOOD })
  unit('CLI stdin: "-" reads stdin, exits 0', p.status === 0, `status=${p.status} stderr=${p.stderr}`)
}
{
  const p = spawnSync(process.execPath, [CLI], { encoding: 'utf8' })
  unit('CLI: no args → usage, exit 2', p.status === 2 && p.stderr.includes('usage'))
}
{
  const p = spawnSync(process.execPath, [CLI, join(ROOT, 'nope.md')], { encoding: 'utf8' })
  unit('CLI: unreadable file → exit 2', p.status === 2)
}

// ---------------------------------------------------------------------------
// warn-only brief → exit 0 (the contract: 0 all pass/warn, 1 any FAIL)
// ---------------------------------------------------------------------------
{
  const warnOnly = 'Consult ghost.json for the schema.\nSave the summary to OUT.md.\nSingle pass, then stop.'
  const f = join(ROOT, 'warn-brief.md')
  writeFileSync(f, warnOnly)
  const p = spawnSync(process.execPath, [CLI, f, '--root', ROOT], { encoding: 'utf8' })
  unit('CLI: warn-only brief exits 0', p.status === 0, `status=${p.status}`)
  unit('CLI: warn-only verdict says with warnings', p.stdout.includes('PASS (with warnings)'))
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
rmSync(ROOT, { recursive: true, force: true })
console.log(`\nje-brief-test tests: ${passed} passed, ${failed} failed`)
if (failed) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(f)
  process.exit(1)
}
process.exit(0)
