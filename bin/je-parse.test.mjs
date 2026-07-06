#!/usr/bin/env node
// je-parse.test.mjs — tests for the Joust Engine Phase-0 parser.
//
// Self-contained (no test framework): a tiny assert harness + a table of
// cases. Run with:  node je-parse.test.mjs
// Exits 0 if all pass, 1 otherwise (with a per-failure diff).
//
// Covers BOTH Feature 2 (sigil/prose/spec/Top-Mixed/conflict/normaliser) AND
// Feature 1 (grand loops Z): Z=1 unchanged, Z>=2 valid, Z>Z_MAX rejected,
// positional-skip still invalid.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, normaliseModel, topMixedAssignment, expandSpec, extractPhaseSpecs, sizeProfile, SIZE_PROFILES, PLAN_DEFAULT_POOL, IMPLEMENT_DEFAULT_POOL, FE_DEFAULT_POOL, Z_MAX, N_MAX } from './je-parse.mjs';

const JE_PARSE_CLI = fileURLToPath(new URL('./je-parse.mjs', import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function eq(a, b) {
  // strict deep-ish equality that distinguishes null from undefined.
  if (a === b) return true;
  if (a === null || b === null) return a === b;       // null !== undefined
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((x, i) => eq(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => eq(a[k], b[k]));
  }
  return false;
}

function show(v) {
  if (v === undefined) return 'undefined';
  return JSON.stringify(v);
}

// assertField(name, actual, expected)
function assertField(label, name, actual, expected) {
  if (eq(actual, expected)) { passed++; return; }
  failed++;
  failures.push(`  [${label}] field "${name}": expected ${show(expected)}, got ${show(actual)}`);
}

// Run a parse case. `expect` is a subset of fields to assert (each must match,
// using null where the parser nulls). If `errorIncludes` is set, errors[] must
// be present and contain a matching substring.
function parseCase(label, input, expect = {}, opts = {}) {
  const r = parse(input);
  for (const [k, v] of Object.entries(expect)) {
    assertField(label, k, r[k], v);
  }
  if (opts.errorIncludes !== undefined) {
    const errs = r.errors || [];
    const hit = errs.some(e => e.toLowerCase().includes(opts.errorIncludes.toLowerCase()));
    if (hit) { passed++; }
    else {
      failed++;
      failures.push(`  [${label}] expected an error including "${opts.errorIncludes}", got errors=${show(errs)}`);
    }
  }
  if (opts.noErrors) {
    if (r.errors === undefined) { passed++; }
    else {
      failed++;
      failures.push(`  [${label}] expected NO errors, got ${show(r.errors)}`);
    }
  }
  if (opts.hasConflict) {
    if (r.conflict && r.conflict.markerN === opts.hasConflict.markerN && r.conflict.specN === opts.hasConflict.specN) {
      passed++;
    } else {
      failed++;
      failures.push(`  [${label}] expected conflict ${show(opts.hasConflict)}, got ${show(r.conflict)}`);
    }
  }
}

function unit(label, cond) {
  if (cond) { passed++; }
  else { failed++; failures.push(`  [${label}] unit assertion failed`); }
}

function cliParseCase(label, input, expect = {}, opts = {}) {
  const p = spawnSync(process.execPath, [JE_PARSE_CLI, input], { encoding: 'utf8' });
  if (p.status === 0) { passed++; }
  else {
    failed++;
    failures.push(`  [${label}] expected CLI exit 0, got ${p.status}; stderr=${show(p.stderr)}`);
    return;
  }
  let r;
  try {
    r = JSON.parse(p.stdout);
    passed++;
  } catch (e) {
    failed++;
    failures.push(`  [${label}] expected JSON stdout, got ${show(p.stdout)}`);
    return;
  }
  for (const [k, v] of Object.entries(expect)) {
    assertField(label, k, r[k], v);
  }
  if (opts.errorIncludes !== undefined) {
    const errs = r.errors || [];
    const hit = errs.some(e => e.toLowerCase().includes(opts.errorIncludes.toLowerCase()));
    if (hit) { passed++; }
    else {
      failed++;
      failures.push(`  [${label}] expected an error including "${opts.errorIncludes}", got errors=${show(errs)}`);
    }
  }
}

// ===========================================================================
// EXISTING Feature-2 behaviour (must all still pass).
// ===========================================================================

// --- basic sigil forms ---
// NOTE on needsGate: the parser sets needsGate ONLY when N is unknown. When an
// explicit N is given with NO inferred assignment, needsGate stays false and the
// SKILL runs the gate off `assignment === null` (the parser-contract distinction
// the brief calls out). So an explicit @@JE:5 has needsGate:false, assignment:null.
parseCase('sigil N', 'do abc @@JE:5',
  { task: 'do abc', n: 5, mode: 1, z: 1, assignment: null, needsGate: false }, { noErrors: true });
parseCase('sigil N:M two', 'do abc @@JE:5:2',
  { task: 'do abc', n: 5, mode: 2, z: 1, assignment: null, needsGate: false }, { noErrors: true });
parseCase('sigil case-insensitive + spaces', 'do abc @@je : 7 : 2',
  { n: 7, mode: 2, z: 1 }, { noErrors: true });

// --- bare sigil -> needsGate ---
parseCase('bare @@JE', 'do abc @@JE',
  { task: 'do abc', n: null, mode: 1, z: 1, assignment: null, needsGate: true }, { noErrors: true });

// --- prose marker ---
parseCase('prose marker N', 'do abc :joust:5',
  { n: 5, mode: 1, z: 1 }, { noErrors: true });
parseCase('prose marker N:2', 'do abc: joust:5:2',
  { n: 5, mode: 2, z: 1 }, { noErrors: true });
parseCase('prose marker upper', 'refactor this JOUST:5',
  { n: 5, mode: 1, z: 1 }, { noErrors: true });

// --- prose model spec (Feature 2) ---
parseCase('spec headline', 'build a parser with 2 opus, 2 glm 5.2, 1 codex high @@JE',
  { n: 5, mode: 1, z: 1, assignment: ['opus', 'opus', 'glm-5.2', 'glm-5.2', 'codex-high'] }, { noErrors: true });
parseCase('spec bare codex -> xhigh (2026-07-05 tier policy)', 'do abc, 1 opus and 1 sonnet and 1 codex joust:3',
  { n: 3, mode: 1, z: 1, assignment: ['opus', 'sonnet', 'codex-xhigh'] }, { noErrors: true });
parseCase('spec bare glm -> 5.2', 'do x with 3 glm @@JE',
  { n: 3, z: 1, assignment: ['glm-5.2', 'glm-5.2', 'glm-5.2'] }, { noErrors: true });
parseCase('spec minimax', 'do y with 2 minimax @@JE',
  { n: 2, z: 1, assignment: ['minimax-m3', 'minimax-m3'] }, { noErrors: true });

// Grok (two variants on a -m model axis; bare 'grok' -> grok-build per the operator's '/model grok').
parseCase('spec grok bare -> grok-build', 'do y with 2 grok @@JE',
  { n: 2, z: 1, assignment: ['grok-build', 'grok-build'] }, { noErrors: true });
parseCase('spec grok both variants', 'build x with 1 grok-build, 1 grok composer 2.5 fast @@JE',
  { n: 2, z: 1, assignment: ['grok-build', 'grok-composer-2.5-fast'] }, { noErrors: true });
parseCase('spec bare composer -> grok-composer', 'do z with 2 composer 2.5 fast @@JE',
  { n: 2, z: 1, assignment: ['grok-composer-2.5-fast', 'grok-composer-2.5-fast'] }, { noErrors: true });
parseCase('spec grok mixed with anthropic', 'improve X @@JE with 1 opus, 1 grok, 1 grok composer',
  { n: 3, z: 1, assignment: ['opus', 'grok-build', 'grok-composer-2.5-fast'] }, { noErrors: true });
parseCase('spec grok strips spec from task', '@@JE 2 grok improve the parser',
  { task: 'improve the parser', n: 2, z: 1, assignment: ['grok-build', 'grok-build'] }, { noErrors: true });

// --- Top Mixed preset ---
parseCase('top mixed N=6', 'do abc top mixed @@JE:6',
  { n: 6, z: 1, preset: 'top-mixed', assignment: ['opus', 'opus', 'glm-5.2', 'glm-5.2', 'codex-xhigh', 'codex-xhigh'] }, { noErrors: true });
parseCase('top mixed leadcount 5', 'do abc 5 top mixed @@JE',
  { n: 5, z: 1, preset: 'top-mixed', assignment: ['opus', 'opus', 'glm-5.2', 'glm-5.2', 'codex-xhigh'] }, { noErrors: true });
parseCase('top mixed N=2', 'do abc with top-mix @@JE:2',
  { n: 2, z: 1, preset: 'top-mixed', assignment: ['opus', 'glm-5.2'] }, { noErrors: true });

// --- conflict (explicit N vs prose) ---
parseCase('conflict 4 vs 5', 'improve X @@JE:4 with 2 opus, 2 glm, 1 codex',
  { n: null, assignment: null, z: 1 }, { hasConflict: { markerN: 4, specN: 5 } });
parseCase('agree marker+spec', 'do x with 2 opus and 1 sonnet @@JE:3',
  { n: 3, z: 1, assignment: ['opus', 'opus', 'sonnet'] }, { noErrors: true });

// --- digit-noun guard ---
// '3 bugs' / '5 tests' are task text, NOT a spec: n stays the explicit sigil N,
// assignment stays null, needsGate stays false (SKILL gates off assignment===null).
parseCase('digit-noun guard 3 bugs', 'fix 3 bugs @@JE:5',
  { n: 5, z: 1, assignment: null, needsGate: false }, { noErrors: true });
parseCase('digit-noun guard 5 tests', 'write 5 tests for the parser @@JE:4',
  { n: 4, z: 1, assignment: null, needsGate: false }, { noErrors: true });
parseCase('digit-noun mixed with spec', 'refactor 2 modules with 2 opus @@JE:2',
  { n: 2, z: 1, assignment: ['opus', 'opus'] }, { noErrors: true });

// --- unknown token rejected loudly ---
parseCase('unknown token gpt4', 'do x with 2 opus and 1 gpt4 @@JE',
  { n: null, assignment: null }, { errorIncludes: 'Unrecognised model token' });

// --- invalid M ---
parseCase('invalid M=3', 'do abc @@JE:5:3',
  { n: null }, { errorIncludes: 'Invalid pass count' });

// --- N < 2 ---
parseCase('N=1 invalid', 'do abc @@JE:1',
  { n: null }, { errorIncludes: 'N must be an integer >= 2' });

// --- N > N_MAX rejected loudly and safely ---
parseCase('N over ceiling marker', 'do abc @@JE:9999',
  { n: null, assignment: null }, { errorIncludes: 'N=9999 exceeds the tournament-size ceiling N_MAX=' + N_MAX });
parseCase('N at ceiling valid', 'do abc @@JE:' + N_MAX,
  { n: N_MAX, assignment: null }, { noErrors: true });
parseCase('spec over ceiling rejected before expansion', '@@JE run with 50000000 opus, 1 glm',
  { n: null, assignment: null }, { errorIncludes: 'N=50000000 exceeds the tournament-size ceiling' });
parseCase('spec total over ceiling rejected', '@@JE run with 10 opus, 10 glm',
  { n: null, assignment: null }, { errorIncludes: 'N=20 exceeds the tournament-size ceiling' });
parseCase('top mixed over ceiling rejected before expansion', 'do abc top mixed @@JE:9999',
  { n: null, assignment: null, preset: 'top-mixed' }, { errorIncludes: 'N=9999 exceeds the tournament-size ceiling' });

// --- CLI regression: oversize inputs exit 0 with errors[] (no crash/OOM) ---
cliParseCase('CLI huge prose spec exits 0', '@@JE run with 50000000 opus, 1 glm',
  { n: null, assignment: null }, { errorIncludes: 'N=50000000 exceeds the tournament-size ceiling' });
cliParseCase('CLI N over ceiling exits 0', '@@JE:9999',
  { n: null, assignment: null }, { errorIncludes: 'N=9999 exceeds the tournament-size ceiling N_MAX=' + N_MAX });

// --- no marker ---
parseCase('no marker', 'fix 3 bugs in the parser',
  { n: null }, { errorIncludes: 'No @@JE sigil' });

// ===========================================================================
// FEATURE 1 — grand loops (Z). NEW.
// ===========================================================================

// --- Z=1 explicit is byte-identical to omitting Z ---
{
  const omit = parse('do abc @@JE:5:1');
  const z1 = parse('do abc @@JE:5:1:1');
  unit('Z=1 explicit == omitted (n)', omit.n === z1.n && z1.n === 5);
  unit('Z=1 explicit == omitted (z)', omit.z === 1 && z1.z === 1);
  unit('Z=1 explicit == omitted (mode)', omit.mode === z1.mode);
  unit('Z=1 explicit no errors', z1.errors === undefined);
}

// --- Z>=2 is VALID now (flows on; NO "not yet implemented" error) ---
// Explicit N, no spec -> needsGate stays false (SKILL gates off assignment===null).
parseCase('Z=2 valid', 'do abc @@JE:5:1:2',
  { task: 'do abc', n: 5, mode: 1, z: 2, assignment: null, needsGate: false }, { noErrors: true });
parseCase('Z=3 single valid', 'improve the error handling @@JE:4:1:3',
  { n: 4, mode: 1, z: 3 }, { noErrors: true });
parseCase('Z=3 two-pass valid', 'improve the error handling @@JE:4:2:3',
  { n: 4, mode: 2, z: 3 }, { noErrors: true });
parseCase('Z=5 at the ceiling valid', 'tidy things up @@JE:3:1:5',
  { n: 3, mode: 1, z: 5 }, { noErrors: true });

// --- Z>=2 via prose marker ---
parseCase('Z=3 prose marker', 'optimise this loop, joust:4:2:3',
  { n: 4, mode: 2, z: 3 }, { noErrors: true });

// --- Z>=2 with N inferred from a prose spec (empty-N sigil form) ---
parseCase('Z=3 N-from-spec empty N', 'improve X @@JE::1:3 with 2 opus, 2 glm 5.2, 1 codex high',
  { n: 5, mode: 1, z: 3, assignment: ['opus', 'opus', 'glm-5.2', 'glm-5.2', 'codex-high'] }, { noErrors: true });
// And with an explicit N that AGREES with the prose sum.
parseCase('Z=3 N explicit agrees with spec', 'improve X @@JE:5:1:3 with 2 opus, 2 glm 5.2, 1 codex high',
  { n: 5, mode: 1, z: 3, assignment: ['opus', 'opus', 'glm-5.2', 'glm-5.2', 'codex-high'] }, { noErrors: true });

// --- Z > Z_MAX rejected, echoing the offending Z (NOT reset to 1) ---
parseCase('Z=9 over ceiling', 'tidy things up @@JE:3:1:9',
  { n: null, assignment: null, z: 9 }, { errorIncludes: 'exceeds the grand-loop ceiling' });
parseCase('Z=6 just over ceiling', 'do abc @@JE:4:1:6',
  { n: null, z: 6 }, { errorIncludes: 'Z_MAX=' + Z_MAX });
parseCase('Z=30 fat-fingered', 'do abc @@JE:5:2:30',
  { n: null, z: 30 }, { errorIncludes: 'split into batches' });

// --- positional skip still invalid with Z ---
parseCase('positional skip @@JE:5::3', 'do abc @@JE:5::3',
  { n: null }, { errorIncludes: 'Positional skip' });

// --- invalid Z (zero / empty) ---
parseCase('Z=0 invalid', 'do abc @@JE:5:1:0',
  { n: null }, { errorIncludes: 'Z must be an integer' });

// --- the spec's DANGEROUS worked example must NOT be (mis)treated as Z=3.
//     '@@JE:1:3' is positional N=1, M=3 (NOT N omitted/Z=3). N=1 is < 2 AND
//     M=3 is invalid. The empty-N form '@@JE::1:3' is the correct N-omitted
//     spelling. Assert the grammar, not the stray example. ---
{
  const bad = parse('improve X @@JE:1:3');
  unit('@@JE:1:3 is NOT a valid Z=3 run', bad.n === null && (bad.errors || []).length > 0);
  unit('@@JE:1:3 z is not silently 3', bad.z === 1);
}

// ===========================================================================
// D-0003 — prose 'Nx <model>' multiplier + '<n> grand loop[s]' Z directive.
// ===========================================================================

// --- 'Nx <model>' is equivalent to 'N <model>' (no space before model) ---
parseCase('Nx single spec', 'do x with 2x opus @@JE',
  { n: 2, z: 1, assignment: ['opus', 'opus'], needsGate: false }, { noErrors: true });
parseCase('Nx chained spec', 'build a parser with 2x opus and 1x codex high @@JE',
  { task: 'build a parser', n: 3, z: 1, assignment: ['opus', 'opus', 'codex-high'] }, { noErrors: true });
parseCase('Nx chained four with M=2', 'build x with 2x opus, 2x sonnet, 2x codex, 2x minimax @@JE:8:2',
  { n: 8, mode: 2, z: 1,
    assignment: ['opus', 'opus', 'sonnet', 'sonnet', 'codex-xhigh', 'codex-xhigh', 'minimax-m3', 'minimax-m3'] },
  { noErrors: true });
// 'Nx' agrees with an explicit marker N -> no conflict.
parseCase('Nx agrees with marker N', 'do x with 2x opus and 1x sonnet @@JE:3',
  { n: 3, z: 1, assignment: ['opus', 'opus', 'sonnet'] }, { noErrors: true });

// --- '<n> grand loop[s]' is a Z directive: sets z, stripped from task/spec ---
parseCase('grand loops sets Z, with spec', 'build x with 3 opus, 2 grand loops @@JE',
  { n: 3, z: 2, assignment: ['opus', 'opus', 'opus'] }, { noErrors: true });
parseCase('grand loop singular -> z=1', 'do abc with 2 opus, 1 grand loop @@JE',
  { n: 2, z: 1, assignment: ['opus', 'opus'] }, { noErrors: true });
parseCase('grand loops with explicit sigil N (no spec)', 'tidy up @@JE:3 2 grand loops',
  { task: 'tidy up', n: 3, mode: 1, z: 2, assignment: null }, { noErrors: true });
// 'grand' is NOT a model token -> the literal repro no longer errors.
parseCase('grand loop does NOT error on "grand"', '@@JE 2 minimax, 1 grand loop, do X',
  { n: 2, z: 1, assignment: ['minimax-m3', 'minimax-m3'] }, { noErrors: true });
// A prose grand-loop count over the ceiling is rejected like the sigil Z.
parseCase('grand loops over ceiling', 'tidy up @@JE:3 9 grand loops',
  { n: null, z: 9 }, { errorIncludes: 'exceeds the grand-loop ceiling' });
// Sigil :Z and prose 'N grand loops' that DISAGREE -> loud conflict error.
parseCase('grand loop conflicts with sigil Z', 'improve X @@JE:4:1:2 with 3 grand loops',
  {}, { errorIncludes: 'Grand-loop count conflict' });
// Ordinary 'grand' as task noun (no count immediately before, no 'loop[s]' after)
// is NOT treated as a directive and is left in the task text.
parseCase('ordinary grand noun untouched', 'redesign the grand staircase @@JE:5',
  { task: 'redesign the grand staircase', n: 5, z: 1, assignment: null }, { noErrors: true });

// ===========================================================================
// D-0006 — prose 'two pass' / 'single pass' / 'one pass' sets the mode.
// ===========================================================================
parseCase('D-0006 two pass -> mode 2', '@@JE two pass, 2 opus, 2 sonnet do X',
  { task: 'do X', n: 4, mode: 2, z: 1, assignment: ['opus', 'opus', 'sonnet', 'sonnet'] }, { noErrors: true });
parseCase('D-0006 two-pass (hyphen) -> mode 2', '@@JE two-pass, 2 opus, 2 sonnet do X',
  { task: 'do X', n: 4, mode: 2, assignment: ['opus', 'opus', 'sonnet', 'sonnet'] }, { noErrors: true });
parseCase('D-0006 single pass -> mode 1', 'refactor @@JE:4 single pass',
  { task: 'refactor', n: 4, mode: 1, z: 1 }, { noErrors: true });
parseCase('D-0006 one pass -> mode 1', 'do x @@JE:4 one pass',
  { mode: 1 }, { noErrors: true });
parseCase('D-0006 prose marker + two pass', 'do X joust:4 two pass',
  { n: 4, mode: 2 }, { noErrors: true });
// sigil :M wins; agreeing prose is fine.
parseCase('D-0006 sigil M=2 agrees with two pass', '@@JE:4:2 two pass, do X',
  { task: 'do X', n: 4, mode: 2 }, { noErrors: true });
// sigil :M vs prose DISAGREE -> loud conflict error, n nulled.
parseCase('D-0006 sigil M vs prose conflict', '@@JE:4:2 single pass, do X',
  { n: null }, { errorIncludes: 'Pass-count conflict' });
// false-positive guard: 'two passes of feedback' is NOT 'two pass' -> mode stays 1.
parseCase('D-0006 "two passes" does NOT flip mode', 'review @@JE:4 give me two passes of feedback',
  { mode: 1, n: 4 }, { noErrors: true });
// --- D-0006 OVER-MATCH regressions (adversarial-review catch): a hyphenated /
// mid-task pass adjective is NOT a directive — it must not flip the mode, raise a
// false conflict, refuse the run, or be eaten from the task. ---
parseCase('D-0006 "two-pass compiler" task is NOT a directive', 'build a two-pass compiler @@JE:4',
  { task: 'build a two-pass compiler', n: 4, mode: 1, z: 1 }, { noErrors: true });
parseCase('D-0006 "two-pass build" does NOT cause a false conflict', 'replace the two-pass build with a faster one @@JE:5:1',
  { n: 5, mode: 1 }, { noErrors: true });
parseCase('D-0006 "single-pass renderer" task kept; sigil mode honoured', 'optimize the single-pass renderer @@JE:5:2',
  { task: 'optimize the single-pass renderer', n: 5, mode: 2 }, { noErrors: true });
parseCase('D-0006 mid-task "two-pass" after spec is kept', '@@JE:4:1 with 2 opus, 2 sonnet, rewrite the two-pass tokenizer',
  { task: 'rewrite the two-pass tokenizer', n: 4, mode: 1, assignment: ['opus', 'opus', 'sonnet', 'sonnet'] }, { noErrors: true });
// a directive immediately followed by the spec (no comma) still works (clause boundary = the digit).
parseCase('D-0006 directive then spec digit', '@@JE two pass 2 opus, 2 sonnet, do the thing',
  { task: 'do the thing', n: 4, mode: 2, assignment: ['opus', 'opus', 'sonnet', 'sonnet'] }, { noErrors: true });

// ===========================================================================
// D-0007 — task text after a leading @@JE marker is captured (not dropped).
// ===========================================================================
parseCase('D-0007 marker-first spec + task', '@@JE 2 opus, fix the parser bug',
  { task: 'fix the parser bug', n: 2, mode: 1, z: 1, assignment: ['opus', 'opus'] }, { noErrors: true });
parseCase('D-0007 sigil N + trailing task', '@@JE:2 do the thing',
  { task: 'do the thing', n: 2 }, { noErrors: true });
parseCase('D-0007 spec + task both after marker', '@@JE:4 with 2 opus and 2 sonnet, refactor the parser',
  { task: 'refactor the parser', n: 4, assignment: ['opus', 'opus', 'sonnet', 'sonnet'] }, { noErrors: true });
parseCase('D-0007 bare marker-first task -> needsGate, task kept', '@@JE fix the parser bug',
  { task: 'fix the parser bug', n: null, needsGate: true }, { noErrors: true });
// regression: pre-marker task still works.
parseCase('D-0007 pre-marker task unchanged', 'fix the bug @@JE:2',
  { task: 'fix the bug', n: 2 }, { noErrors: true });
// D-0006 + D-0007 together: the original failing invocation shape.
parseCase('D-0006+D-0007 combined', '@@JE two pass, 2 opus, 2 sonnet, build a CSV parser',
  { task: 'build a CSV parser', n: 4, mode: 2, assignment: ['opus', 'opus', 'sonnet', 'sonnet'] }, { noErrors: true });
// D-0007 leading-word: a task that legitimately STARTS with 'with'/'and'/'using'
// must NOT have that word eaten (the spec's own connector is absorbed separately).
parseCase('D-0007 leading "with" kept', '@@JE:3 with great care, refactor',
  { task: 'with great care, refactor', n: 3 }, { noErrors: true });
parseCase('D-0007 leading "and" kept', '@@JE:3 and then ship it',
  { task: 'and then ship it', n: 3 }, { noErrors: true });

// ===========================================================================
// unit-level normaliser / helpers.
// ===========================================================================
unit('normalise opus', normaliseModel('opus') && normaliseModel('opus').model === 'opus');
unit('normalise codex high', normaliseModel('codex high') && normaliseModel('codex high').model === 'codex-high');
unit('normalise codex-high dash', normaliseModel('codex-high') && normaliseModel('codex-high').model === 'codex-high');
unit('normalise bare glm', normaliseModel('glm') && normaliseModel('glm').model === 'glm-5.2');
unit('normalise bare grok -> grok-build', normaliseModel('grok') && normaliseModel('grok').model === 'grok-build');
unit('normalise grok dispatch is grok', normaliseModel('grok') && normaliseModel('grok').dispatch === 'grok');
unit('normalise grok composer 2.5 fast', normaliseModel('grok composer 2.5 fast') && normaliseModel('grok composer 2.5 fast').model === 'grok-composer-2.5-fast');
unit('normalise grok-composer-2.5-fast dash', normaliseModel('grok-composer-2.5-fast') && normaliseModel('grok-composer-2.5-fast').model === 'grok-composer-2.5-fast');
unit('normalise bare composer -> grok-composer', normaliseModel('composer 2.5 fast') && normaliseModel('composer 2.5 fast').model === 'grok-composer-2.5-fast');
unit('normalise unknown -> null', normaliseModel('gpt4') === null);
unit('topMixed N=2', eq(topMixedAssignment(2), ['opus', 'glm-5.2']));
unit('topMixed N=6', eq(topMixedAssignment(6), ['opus', 'opus', 'glm-5.2', 'glm-5.2', 'codex-xhigh', 'codex-xhigh']));
unit('topMixed N=5', eq(topMixedAssignment(5), ['opus', 'opus', 'glm-5.2', 'glm-5.2', 'codex-xhigh']));
unit('expandSpec basic', eq(expandSpec('2 opus, 1 sonnet').assignment, ['opus', 'opus', 'sonnet']));
unit('Z_MAX is 5', Z_MAX === 5);
unit('N_MAX is 16', N_MAX === 16);
unit('expandSpec over N_MAX reports overflow', expandSpec('50000000 opus').overflows[0].total === 50000000);
unit('topMixed over N_MAX returns empty safely', eq(topMixedAssignment(N_MAX + 1), []));

// ===========================================================================
// PHASE 0 — repo-mode plumbing (repoMode / baseRef). NEW (plan §4, P0).
// ===========================================================================

// --- default repoMode=false & baseRef=null ---
parseCase('P0 default repoMode false / baseRef null', 'do abc @@JE:5',
  { repoMode: false, baseRef: null }, { noErrors: true });

// --- the keyword sets repoMode=true AND is stripped from `task` ---
parseCase('P0 repo-anchored (hyphen) sets mode + stripped', 'do abc repo-anchored @@JE:5:1:2',
  { task: 'do abc', repoMode: true, z: 2, baseRef: null }, { noErrors: true });
parseCase('P0 "repo anchored" (space) sets mode + stripped', 'do abc @@JE:5:1:2 repo anchored',
  { task: 'do abc', repoMode: true }, { noErrors: true });
parseCase('P0 bare "anchored" before marker sets mode', 'anchored @@JE:5:1:2',
  { task: '', repoMode: true, z: 2 }, { noErrors: true });

// --- Z>=2 defaults repoMode=true with NO keyword ---
parseCase('P0 Z>=2 defaults repoMode true', 'do abc @@JE:5:1:2',
  { repoMode: true, z: 2, task: 'do abc' }, { noErrors: true });

// --- --no-repo / self-contained override the Z>=2 default to false ---
parseCase('P0 --no-repo overrides Z>=2 default', 'do abc @@JE:5:1:2 --no-repo',
  { repoMode: false, z: 2, task: 'do abc' }, { noErrors: true });
parseCase('P0 self-contained overrides Z>=2 default', 'do abc @@JE:5:1:2 self-contained',
  { repoMode: false, z: 2, task: 'do abc' }, { noErrors: true });
// opt-out also wins over an explicit opt-in keyword; both are stripped.
parseCase('P0 anchored then --no-repo -> false, both stripped', 'do abc @@JE:5:1:2 repo-anchored --no-repo',
  { task: 'do abc', repoMode: false, z: 2 }, { noErrors: true });

// --- repoMode && z<2 error path: errors[] populated, n/assignment nulled ---
parseCase('P0 anchored + Z=1 -> error, n/assignment nulled', 'do abc repo-anchored @@JE:5',
  { n: null, assignment: null, repoMode: true, z: 1 },
  { errorIncludes: 'repo-anchored mode requires Z>=2' });

// --- baseRef is always null from the parser (SKILL pins the sha later) ---
unit('P0 baseRef null even when repo-anchored', parse('do abc @@JE:5:1:2 repo-anchored').baseRef === null);

// --- NO regressions: marker-adjacency safety + existing parses unchanged ---
// 'anchored' / 'self-contained' as ordinary TASK words are NOT directives and are NOT eaten.
parseCase('P0 "anchored" in task body untouched', 'fix the anchored footer @@JE:5',
  { task: 'fix the anchored footer', repoMode: false, n: 5, z: 1 }, { noErrors: true });
parseCase('P0 "self-contained" in task body untouched', 'review the self-contained module @@JE:5',
  { task: 'review the self-contained module', repoMode: false, n: 5, z: 1 }, { noErrors: true });
// A Z=1 run with no keyword stays fully byte-identical (repoMode:false, no error).
{
  const r = parse('do abc @@JE:5');
  unit('P0 Z=1 unchanged: n/mode/z/task', r.n === 5 && r.mode === 1 && r.z === 1 && r.task === 'do abc');
  unit('P0 Z=1 unchanged: repoMode false, no errors', r.repoMode === false && r.errors === undefined);
}
// Z>=2 defaulting repoMode=true does NOT perturb any other field of an existing shape.
{
  const r = parse('do abc @@JE:5:1:2');
  unit('P0 Z=2 leaves n/mode/assignment/needsGate', r.n === 5 && r.mode === 1 && r.assignment === null && r.needsGate === false);
}

// ===========================================================================
// DYNAMIC LIMITS — marker-adjacent task-size override (short|medium|long). NEW.
// ===========================================================================

// --- default: no size keyword -> size null (SKILL estimates) ---
parseCase('size default null', 'do abc @@JE:5',
  { task: 'do abc', n: 5, size: null }, { noErrors: true });

// --- AFTER the marker, set off by end-of-input ---
parseCase('size long after marker', 'fix the bug @@JE:5 long',
  { task: 'fix the bug', n: 5, size: 'long' }, { noErrors: true });
parseCase('size medium after marker', 'refactor @@JE:4 medium',
  { task: 'refactor', n: 4, size: 'medium' }, { noErrors: true });

// --- AFTER the marker, set off by a comma, with a trailing task ---
parseCase('size short after marker + comma + task', '@@JE short, refactor the parser',
  { task: 'refactor the parser', size: 'short', needsGate: true }, { noErrors: true });

// --- BEFORE the marker ---
parseCase('size before marker', 'tidy up long @@JE:4',
  { task: 'tidy up', n: 4, size: 'long' }, { noErrors: true });

// --- combines with spec + two-pass; size stripped, everything else intact ---
parseCase('size + two-pass + spec', '@@JE:4:2 medium, 2 opus, 2 sonnet, build a CSV parser',
  { task: 'build a CSV parser', n: 4, mode: 2, z: 1, size: 'medium',
    assignment: ['opus', 'opus', 'sonnet', 'sonnet'] }, { noErrors: true });

// --- false-positive guards: a size word in the TASK BODY is NOT a directive ---
// (AFTER form needs a clause boundary; 'long division' has none -> not stripped.)
parseCase('size "long division" task untouched', '@@JE:3 long division solver',
  { task: 'long division solver', n: 3, size: null }, { noErrors: true });
parseCase('size "short-circuit" task untouched', 'build a short-circuit evaluator @@JE:3',
  { task: 'build a short-circuit evaluator', n: 3, size: null }, { noErrors: true });
parseCase('size "medium" mid-task untouched', 'render the medium font weight @@JE:3',
  { task: 'render the medium font weight', n: 3, size: null }, { noErrors: true });

// --- the size override is independent of grand loops / repo mode ---
parseCase('size long with Z>=2', 'optimise the build @@JE:4:1:2 long',
  { task: 'optimise the build', n: 4, z: 2, size: 'long', repoMode: true }, { noErrors: true });

// --- sizeProfile() returns the full guard set, tagged with the canonical size ---
unit('sizeProfile short keys', (() => {
  const p = sizeProfile('short');
  return p && p.size === 'short' && p.attemptMaxTurns === 15 && p.attemptTimeoutSecs === 180 &&
    p.codexTimeoutSecs === 600 && p.grokTimeoutSecs === 300;
})());
unit('sizeProfile medium == engine defaults spirit', (() => {
  const p = sizeProfile('MEDIUM'); // case-insensitive
  return p && p.size === 'medium' && p.attemptMaxTurns === 30 && p.localMaxTurns === 20 &&
    p.attemptTimeoutSecs === 300 && p.codexTimeoutSecs === 900 && p.minimaxTimeoutSecs === 900;
})());
unit('sizeProfile long loosens guards', (() => {
  const p = sizeProfile('long');
  return p && p.attemptMaxTurns === 50 && p.glmTimeoutSecs === 2400 && p.codexTimeoutSecs === 1800 &&
    p.minimaxTimeoutSecs === 1800;
})());
unit('sizeProfile unknown -> null', sizeProfile('huge') === null);
// every profile must define the SAME complete key set the engine reads.
unit('SIZE_PROFILES have identical key sets', (() => {
  const keys = o => Object.keys(o).sort().join(',');
  const ref = keys(SIZE_PROFILES.medium);
  return keys(SIZE_PROFILES.short) === ref && keys(SIZE_PROFILES.long) === ref;
})());
// monotonic: short <= medium <= long for every numeric guard.
unit('SIZE_PROFILES monotonic short<=medium<=long', (() => {
  const { short: s, medium: m, long: l } = SIZE_PROFILES;
  return Object.keys(m).every(k => s[k] <= m[k] && m[k] <= l[k]);
})());

// --- CLI: `--size <label>` prints the profile (exit 0); unknown -> exit 1 ---
{
  const ok = spawnSync(process.execPath, [JE_PARSE_CLI, '--size', 'long'], { encoding: 'utf8' });
  unit('CLI --size long exit 0', ok.status === 0);
  let prof = null; try { prof = JSON.parse(ok.stdout); } catch {}
  unit('CLI --size long JSON profile', prof && prof.size === 'long' && prof.grokTimeoutSecs === 1200);
  const bad = spawnSync(process.execPath, [JE_PARSE_CLI, '--size', 'huge'], { encoding: 'utf8' });
  unit('CLI --size huge exit 1', bad.status === 1);
}

// ===========================================================================
// PLAN/IMPLEMENT ROUND SPLIT — phase-scoped specs + implement flag. NEW.
// ===========================================================================

// --- default: no implement signal -> implement false, implementAssignment null ---
parseCase('P/I default plan-only', 'do abc @@JE:5',
  { n: 5, implement: false, implementAssignment: null }, { noErrors: true });
// planAssignment mirrors assignment (null here — explicit N, no spec).
{
  const r = parse('do abc @@JE:5');
  unit('P/I plan-only planAssignment mirrors assignment', r.planAssignment === null && r.assignment === null);
}

// --- marker-adjacent 'implement' keyword enables the implement rounds ---
parseCase('P/I implement keyword after marker', 'refactor the auth module @@JE:5 implement',
  { task: 'refactor the auth module', n: 5, implement: true,
    implementAssignment: IMPLEMENT_DEFAULT_POOL }, { noErrors: true });
parseCase('P/I implement keyword after marker + comma + task', '@@JE implement, add a retry helper',
  { task: 'add a retry helper', implement: true, needsGate: true,
    implementAssignment: IMPLEMENT_DEFAULT_POOL }, { noErrors: true });
parseCase('P/I implement keyword before marker', 'optimise the loop implement @@JE:4',
  { task: 'optimise the loop', n: 4, implement: true }, { noErrors: true });

// --- false-positive guard: 'implement' in the task body is NOT the directive ---
parseCase('P/I "implement a parser" body untouched', '@@JE:3 implement a CSV parser',
  { task: 'implement a CSV parser', n: 3, implement: false, implementAssignment: null }, { noErrors: true });
parseCase('P/I mid-task "implement" untouched', 'we need to implement caching @@JE:3',
  { task: 'we need to implement caching', n: 3, implement: false }, { noErrors: true });

// --- phase-scoped specs: Plan pool drives N/assignment; Implement pool separate ---
parseCase('P/I both phase specs', '@@JE Plan: 2 opus, 2 sonnet, 2 codex high, Implement: 2 opus, 2 codex high, build a parser',
  { task: 'build a parser', n: 6, implement: true,
    assignment: ['opus', 'opus', 'sonnet', 'sonnet', 'codex-high', 'codex-high'],
    planAssignment: ['opus', 'opus', 'sonnet', 'sonnet', 'codex-high', 'codex-high'],
    implementAssignment: ['opus', 'opus', 'codex-high', 'codex-high'] }, { noErrors: true });

// --- Implement: label alone enables implement + defaults the Plan pool ---
parseCase('P/I implement label alone -> plan default pool', '@@JE Implement: 1 glm 5.2, fix the bug',
  { task: 'fix the bug', n: 10, implement: true,
    assignment: PLAN_DEFAULT_POOL, planAssignment: PLAN_DEFAULT_POOL,
    implementAssignment: ['glm-5.2'] }, { noErrors: true });

// --- Plan: label alone (no implement) -> implement stays off, uses plan pool ---
parseCase('P/I plan label alone, no implement', '@@JE Plan: 3 opus, tidy the config',
  { task: 'tidy the config', n: 3, implement: false,
    assignment: ['opus', 'opus', 'opus'], implementAssignment: null }, { noErrors: true });

// --- Plan pool omitted entirely, only implement keyword -> plan default pool ---
parseCase('P/I implement keyword, no plan spec -> defaults',
  '@@JE implement, migrate the store',
  { task: 'migrate the store', implement: true, needsGate: true,
    implementAssignment: IMPLEMENT_DEFAULT_POOL }, { noErrors: true });

// --- explicit sigil N agreeing with the plan sum is fine ---
parseCase('P/I sigil N agrees with plan sum', '@@JE:6 Plan: 3 opus, 3 sonnet, Implement: 2 opus, do X',
  { task: 'do X', n: 6, implement: true,
    assignment: ['opus', 'opus', 'opus', 'sonnet', 'sonnet', 'sonnet'],
    implementAssignment: ['opus', 'opus'] }, { noErrors: true });

// --- sigil N disagreeing with the plan sum -> conflict (n nulled) ---
parseCase('P/I sigil N vs plan sum conflict', '@@JE:4 Plan: 3 opus, 3 sonnet, Implement: 2 opus, do X',
  { n: null, assignment: null }, { hasConflict: { markerN: 4, specN: 6 } });

// --- unknown token in a phase spec is rejected loudly ---
parseCase('P/I unknown token in Plan spec', '@@JE Plan: 2 opus, 1 gpt4, Implement: 2 opus, do X',
  { n: null, assignment: null }, { errorIncludes: 'Unrecognised model token' });
parseCase('P/I unknown token in Implement spec', '@@JE Plan: 2 opus, Implement: 1 gpt5, do X',
  { assignment: null }, { errorIncludes: 'Unrecognised model token' });

// --- phase-spec pool over N_MAX rejected safely ---
parseCase('P/I plan pool over ceiling', '@@JE Plan: 20 opus, Implement: 2 opus, do X',
  { n: null, assignment: null }, { errorIncludes: 'exceeds the tournament-size ceiling' });

// --- implement + Z>=2 (grand loops) coexist ---
parseCase('P/I implement with grand loops', 'harden the API @@JE:5:1:2 implement',
  { task: 'harden the API', n: 5, z: 2, implement: true, repoMode: true }, { noErrors: true });

// --- unit: extractPhaseSpecs slices the two segments correctly ---
unit('extractPhaseSpecs both', (() => {
  const ps = extractPhaseSpecs('Plan: 2 opus, 1 sonnet, Implement: 2 codex high');
  return ps && eq(ps.plan.assignment, ['opus', 'opus', 'sonnet']) &&
    eq(ps.implement.assignment, ['codex-high', 'codex-high']);
})());
unit('extractPhaseSpecs implement-only', (() => {
  const ps = extractPhaseSpecs('Implement: 1 glm 5.2');
  return ps && ps.plan === null && eq(ps.implement.assignment, ['glm-5.2']);
})());
unit('extractPhaseSpecs none -> null', extractPhaseSpecs('build a parser') === null);
unit('PLAN_DEFAULT_POOL sums to 10', PLAN_DEFAULT_POOL.length === 10);
unit('IMPLEMENT_DEFAULT_POOL sums to 6', IMPLEMENT_DEFAULT_POOL.length === 6);
unit('IMPLEMENT_DEFAULT_POOL has >=2 opus and >=2 sonnet',
  IMPLEMENT_DEFAULT_POOL.filter(m => m === 'opus').length >= 2 &&
  IMPLEMENT_DEFAULT_POOL.filter(m => m === 'sonnet').length >= 2);

// ===========================================================================
// @@FE — Fable Engine sigil (composeOnly). NEW.
// ===========================================================================

// --- bare @@FE -> the documented default pool, N=10, NO interactive gate ---
parseCase('FE bare -> default pool n=10', 'fix the parser @@FE',
  { task: 'fix the parser', n: 10, mode: 1, z: 1, fe: true, composeOnly: true,
    feDefaultPool: true, needsGate: false,
    assignment: ['opus', 'opus', 'sonnet', 'sonnet', 'glm-5.2', 'glm-5.2',
                 'codex-high', 'codex-high', 'minimax-m3', 'minimax-m3'] },
  { noErrors: true });
parseCase('FE bare marker-first task kept (D-0007 shape)', '@@FE fix the parser bug',
  { task: 'fix the parser bug', n: 10, feDefaultPool: true, needsGate: false }, { noErrors: true });

// --- explicit N: like @@JE:N — assignment null (SKILL resolves the pool) ---
parseCase('FE explicit N', 'do abc @@FE:6',
  { task: 'do abc', n: 6, mode: 1, z: 1, fe: true, composeOnly: true,
    feDefaultPool: false, assignment: null, needsGate: false }, { noErrors: true });

// --- M/Z segments are INVALID for @@FE (error, like positional skips) ---
parseCase('FE M segment invalid', 'do abc @@FE:6:2',
  { n: null, assignment: null, fe: true }, { errorIncludes: 'not valid for @@FE' });
parseCase('FE Z segment invalid', 'do abc @@FE:6:1:2',
  { n: null, assignment: null }, { errorIncludes: 'not valid for @@FE' });
parseCase('FE empty trailing segment invalid', 'do abc @@FE:6::2',
  { n: null }, { errorIncludes: 'not valid for @@FE' });

// --- prose model spec: same grammar as @@JE, sum wins over the default pool ---
parseCase('FE prose spec sum wins', 'build a parser with 2 opus, 2 glm 5.2, 1 codex high @@FE',
  { task: 'build a parser', n: 5, fe: true, composeOnly: true, feDefaultPool: false,
    assignment: ['opus', 'opus', 'glm-5.2', 'glm-5.2', 'codex-high'] }, { noErrors: true });
parseCase('FE spec agrees with marker N', 'do x with 2 opus and 1 sonnet @@FE:3',
  { n: 3, assignment: ['opus', 'opus', 'sonnet'], feDefaultPool: false }, { noErrors: true });
parseCase('FE marker N vs spec conflict', 'improve X @@FE:4 with 2 opus, 2 glm, 1 codex',
  { n: null, assignment: null, fe: true }, { hasConflict: { markerN: 4, specN: 5 } });
parseCase('FE unknown token rejected loudly', 'do x with 2 opus and 1 gpt4 @@FE',
  { n: null, assignment: null }, { errorIncludes: 'Unrecognised model token' });

// --- size word: identical marker-adjacent grammar, stripped from the task ---
parseCase('FE size medium after marker', 'refactor @@FE:4 medium',
  { task: 'refactor', n: 4, size: 'medium', fe: true }, { noErrors: true });
parseCase('FE size + default pool + comma + task', '@@FE medium, refactor the parser',
  { task: 'refactor the parser', n: 10, size: 'medium', feDefaultPool: true }, { noErrors: true });
parseCase('FE size before marker', 'tidy up long @@FE:4',
  { task: 'tidy up', n: 4, size: 'long' }, { noErrors: true });
parseCase('FE size word in task body untouched', '@@FE:3 long division solver',
  { task: 'long division solver', n: 3, size: null }, { noErrors: true });

// --- @@FE + @@JE in one message = error (never guess which engine) ---
parseCase('FE + JE conflict', 'do abc @@FE @@JE:5',
  { n: null, assignment: null }, { errorIncludes: 'exactly one engine sigil' });
parseCase('FE + JE conflict either order', '@@JE:5 do abc @@FE:6',
  { n: null }, { errorIncludes: 'exactly one engine sigil' });

// --- case / space variants ---
parseCase('FE lowercase + spaces around colon', 'do abc @@fe : 6',
  { task: 'do abc', n: 6, fe: true, composeOnly: true }, { noErrors: true });
parseCase('FE mixed case', 'do abc @@Fe:4',
  { n: 4, fe: true }, { noErrors: true });
parseCase('FE uppercase bare', 'do abc @@FE',
  { n: 10, fe: true, feDefaultPool: true }, { noErrors: true });

// --- N floor / ceiling apply as for @@JE ---
parseCase('FE N=1 invalid', 'do abc @@FE:1',
  { n: null }, { errorIncludes: 'N must be an integer >= 2' });
parseCase('FE N over ceiling', 'do abc @@FE:9999',
  { n: null, assignment: null }, { errorIncludes: 'exceeds the tournament-size ceiling' });

// --- prose spellings of M / Z are invalid for @@FE too (loud, never guessed) ---
parseCase('FE prose two pass invalid', '@@FE two pass, do abc',
  { n: null }, { errorIncludes: 'not valid with @@FE' });
parseCase('FE prose grand loops invalid', 'do abc, 2 grand loops @@FE',
  { n: null }, { errorIncludes: 'not valid with @@FE' });

// --- @@JE / prose parses carry NONE of the fe fields (byte-identical output) ---
{
  const r = parse('do abc @@JE:5');
  unit('JE output has no fe fields',
    r.fe === undefined && r.composeOnly === undefined && r.feDefaultPool === undefined);
  const p = parse('do abc joust:5');
  unit('prose output has no fe fields',
    p.fe === undefined && p.composeOnly === undefined && p.feDefaultPool === undefined);
}

// --- unit: the exported default pool matches the skill's documented pool ---
unit('FE_DEFAULT_POOL is the documented N=10 pool', eq(FE_DEFAULT_POOL,
  ['opus', 'opus', 'sonnet', 'sonnet', 'glm-5.2', 'glm-5.2',
   'codex-high', 'codex-high', 'minimax-m3', 'minimax-m3']));

// --- CLI: @@FE round-trips through the CLI guard ---
cliParseCase('CLI FE bare default pool', 'do abc @@FE',
  { n: 10, fe: true, composeOnly: true, feDefaultPool: true });
cliParseCase('CLI FE M segment errors, exit 0', 'do abc @@FE:6:2',
  { n: null }, { errorIncludes: 'not valid for @@FE' });

// ===========================================================================
// 2026-07-07: run-depth keyword (fast|deep) — variable steelman shootout budget.
// fast = 1 iteration, deep = 5, absent = null (engine default 3). Marker-adjacent
// + stripped, same D-0006 discipline as the size words.
// ===========================================================================
parseCase('depth AFTER form: fast', '@@JE:4 fast, a cli hangman game',
  { depth: 'fast', steelmanMaxIters: 1, task: 'a cli hangman game' }, { noErrors: true });
parseCase('depth AFTER form: deep', '@@JE:4 deep, big refactor',
  { depth: 'deep', steelmanMaxIters: 5 }, { noErrors: true });
parseCase('depth BEFORE form', 'fast @@JE:4, task',
  { depth: 'fast', steelmanMaxIters: 1, task: 'task' }, { noErrors: true });
parseCase('ordinary fast in task body untouched', '@@JE:4 a fast sorter',
  { depth: null, task: 'a fast sorter' }, { noErrors: true });
parseCase('ordinary deep in task body untouched', '@@JE:4 deep copy the tree util',
  { depth: null, task: 'deep copy the tree util' }, { noErrors: true });
parseCase('depth composes with a spec when marker-adjacent', '@@JE fast, 2 opus 2 codex, task z',
  { depth: 'fast', steelmanMaxIters: 1, n: 4 }, { noErrors: true });
parseCase('non-adjacent depth word stays task text (same rule as size words)',
  '@@JE 2 opus 2 codex fast, short, task z',
  { depth: null, n: 4 }, { noErrors: true });

// ===========================================================================
// 2026-07-07: whitespace-joined spec items + loud multiple-fragment refusal.
// "2 opus 2 codex" (no comma) used to parse as two disjoint 1-item chains and
// the longest-raw pick SILENTLY DROPPED the other item (live: @@DE dispatched
// 2x codex-xhigh for a "2 opus 2 codex" request). Whitespace now joins adjacent
// items into one chain; genuinely separated fragments error loudly instead of
// silently changing N; phase labels keep owning their own segments.
// ===========================================================================
parseCase('whitespace-joined spec: 2 opus 2 codex => N=4, nothing dropped',
  '@@JE 2 opus 2 codex, a cli hangman game in python',
  { n: 4, assignment: ['opus', 'opus', 'codex-xhigh', 'codex-xhigh'], task: 'a cli hangman game in python' },
  { noErrors: true });
parseCase('comma form still parses identically',
  '@@JE 2 opus, 2 codex, task x',
  { n: 4, assignment: ['opus', 'opus', 'codex-xhigh', 'codex-xhigh'] }, { noErrors: true });
parseCase('mixed joiners: comma + and + whitespace-multiword tokens',
  '@@JE 2 opus, 2 codex high and 1 sonnet, task x',
  { n: 5, assignment: ['opus', 'opus', 'codex-high', 'codex-high', 'sonnet'] }, { noErrors: true });
parseCase('disjoint fragments REFUSE loudly (never a silent longest-wins drop)',
  '@@JE 2 opus then later 2 codex, task x',
  { n: null, assignment: null },
  { errorIncludes: 'separate model-spec fragments' });
parseCase('phase labels exempt from the top-level fragment refusal; segments parse whitespace-joined',
  '@@JE Plan: 2 opus 2 sonnet, Implement: 1 opus, do the thing',
  { n: 4, assignment: ['opus', 'opus', 'sonnet', 'sonnet'], implementAssignment: ['opus'] },
  { noErrors: true });
parseCase('ordinary task digits still never spec ("fix 3 bugs")',
  '@@JE:5 fix 3 bugs in the parser',
  { n: 5, assignment: null, task: 'fix 3 bugs in the parser' }, { noErrors: true });

// ===========================================================================
// report.
// ===========================================================================
console.log(`\nje-parse tests: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(f);
  process.exit(1);
}
process.exit(0);
