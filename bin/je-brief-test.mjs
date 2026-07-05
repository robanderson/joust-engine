#!/usr/bin/env node
// je-brief-test.mjs — BRIEF DRY-RUN TESTER: a deterministic STATIC LINTER for
// tournament attempt briefs. No model calls, no network.
//
// Research basis: Anthropic's multi-agent system work — an agent that exercised a
// flawed tool description and rewrote it cut downstream task time 40%. Same trick
// applied to attempt briefs: attempts receive ONLY the composed brief (plus a
// context bundle), no conversation history, so anything deictic, unresolved, or
// self-contradictory silently taxes EVERY attempt in a wide round. The orchestrator
// runs this on the composed task brief BEFORE dispatch (SKILL.md Phase 1).
//
// Usage:
//   node bin/je-brief-test.mjs <brief-file>       lint a brief file
//   node bin/je-brief-test.mjs -                  read the brief from stdin
//   flags: --json            machine-readable output
//          --root <dir>      path-resolution root (default: this repo's root)
//
// Checks (fixed order; ONE PASS/WARN/FAIL line each; failures carry a concrete fix):
//   deixis       "this file" / "as discussed" / "the current system" etc. with no
//                in-brief antecedent (attempts have no conversation context)   FAIL
//   paths        referenced paths that don't resolve under the root; missing
//                bare filenames are lower-confidence                      FAIL/WARN
//   deliverable  no explicit save/write instruction naming the output file     FAIL
//   stop-rule    no single-pass / hard-stop language (iterators blow turn caps) FAIL
//   conflicts    contradictory directives — do-not-implement vs implement,
//                "smallest change" + "comprehensive/exhaustive" (heuristic)    WARN
//   altitude     asks for a DESIGN BRIEF but demands file-level edit lists /
//                code blocks (contradicts the altitude rule)                   FAIL
//   jargon       repo-internal codenames used once, undefined, absent from the
//                repo tree                                                     WARN
//   length       brief > 6000 words (attention dilution)                       WARN
//
// Exit: 0 = all PASS/WARN, 1 = any FAIL, 2 = usage error.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = resolve(HERE, '..')
export const WORD_BUDGET = 6000
export const RULE_IDS = ['deixis', 'paths', 'deliverable', 'stop-rule', 'conflicts', 'altitude', 'jargon', 'length']

// ---------------------------------------------------------------------------
// shared token extraction
// ---------------------------------------------------------------------------

const PATH_EXT = 'mjs|cjs|js|ts|tsx|jsx|json|md|mdx|sh|bash|yml|yaml|txt|py|rb|go|rs|toml|lock|css|html|svg|csv|xml|ini|cfg|conf'
// A path-like token: (a) something with a "/" and >=2 segments, optionally rooted
// or dot-prefixed, or (b) a bare filename with a recognised extension. Bounded by
// whitespace/quotes/brackets so URLs and mid-word slashes don't match.
const PATH_RE = new RegExp(
  '(^|[\\s"\'`(\\[=])' +
  '((?:\\.{1,2}/|/)?[\\w.@~-]+(?:/[\\w.@~-]+)+|[\\w@~-][\\w.@~-]*\\.(?:' + PATH_EXT + '))' +
  '(?=$|[\\s"\'`)\\],;:!?>])',
  'gm',
)

export function extractPathTokens(text) {
  const out = []
  const re = new RegExp(PATH_RE.source, PATH_RE.flags)
  let m
  while ((m = re.exec(text)) !== null) {
    let token = m[2].replace(/\.+$/, '')
    if (!token || token.includes('://')) continue // URL fragment, not a path
    out.push({ token, index: m.index + m[1].length })
  }
  return out
}

const basename = (p) => p.split('/').filter(Boolean).pop() || p

// Repo file inventory: git ls-files when available, else a bounded fs walk.
export function listRepoFiles(root) {
  const g = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (!g.error && g.status === 0) return g.stdout.split('\n').filter(Boolean)
  const out = []
  const walk = (rel, depth) => {
    if (depth > 6 || out.length > 5000) return
    let entries
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.runs') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r, depth + 1)
      else out.push(r)
    }
  }
  walk('', 0)
  return out
}

// One `git grep` for all candidate jargon tokens; returns the Set of tokens that
// occur in tracked file CONTENT, or null when git grep is unavailable.
function tokensInRepoContent(root, tokens) {
  if (tokens.length === 0) return new Set()
  const args = ['-C', root, 'grep', '-h', '-o', '-I', '-F']
  for (const t of tokens) args.push('-e', t)
  const g = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (g.error || (g.status !== 0 && g.status !== 1)) return null
  return new Set(g.stdout.split('\n').filter(Boolean))
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
const countOccurrences = (text, token) => (text.match(new RegExp(`\\b${escapeRe(token)}\\b`, 'gi')) || []).length

// ---------------------------------------------------------------------------
// rule 1 — AMBIGUOUS DEIXIS
// ---------------------------------------------------------------------------

// Phrases that can ONLY resolve against a conversation the attempt never sees.
const CONVO_DEIXIS = [
  /\bas (?:we )?(?:discussed|agreed)\b/i,
  /\bper (?:our|the) (?:conversation|discussion|chat|call|thread)\b/i,
  /\bas (?:mentioned|described|noted|explained) (?:earlier|before|previously)\b/i,
  /\bearlier (?:in (?:this|our)) (?:conversation|discussion|thread|session)\b/i,
]
// Phrases that need an in-brief antecedent; `kind` picks the antecedent test.
const REF_DEIXIS = [
  [/\b(?:this|that) file\b/i, 'file'],
  [/\bthese files\b/i, 'file'],
  [/\bthe file (?:above|below)\b/i, 'file'],
  [/\bthe above\b/i, 'above'],
  [/\bthe aforementioned\b/i, 'above'],
  [/\bas (?:mentioned|described|noted) above\b/i, 'above'],
  [/\bthe current (?:system|codebase|implementation|setup|architecture|repo|repository|project)\b/i, 'system'],
  [/\bthe existing (?:code|system|implementation|setup|architecture)\b/i, 'system'],
]
const SYSTEM_NAMING = /\b[A-Z][\w-]*(?:\s+[A-Z][\w-]*)*\s+(?:plugin|repo|repository|codebase|project|engine|service|app|library)\b/

function checkDeixis(text, pathTokens) {
  const offenders = []
  let resolved = 0
  const scan = (pattern, kind) => {
    const re = new RegExp(pattern.source, 'gi')
    let m
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(0, m.index)
      let ok = false
      if (kind === 'file') ok = pathTokens.some((t) => t.index < m.index)
      else if (kind === 'above') ok = before.trim().length >= 200
      else if (kind === 'system') ok = pathTokens.some((t) => t.index < m.index) || SYSTEM_NAMING.test(before)
      // kind === 'conversation': never resolvable in-brief.
      if (ok) resolved++
      else offenders.push(m[0])
    }
  }
  for (const p of CONVO_DEIXIS) scan(p, 'conversation')
  for (const [p, kind] of REF_DEIXIS) scan(p, kind)
  if (offenders.length === 0) {
    return pass('deixis', resolved ? 'deictic phrases all have in-brief antecedents' : 'no ambiguous references')
  }
  return finding('deixis', 'FAIL',
    `${offenders.length} reference(s) with no in-brief antecedent: ${quoteList(offenders)}`,
    'name the file/system explicitly — attempts receive ONLY this brief, never the conversation it came from',
    offenders)
}

// ---------------------------------------------------------------------------
// rule 2 — UNRESOLVED PATHS
// ---------------------------------------------------------------------------

function checkPaths(text, pathTokens, deliverables, root, repoFiles) {
  const baseSet = new Set(repoFiles.map(basename))
  const hard = [] // absolute / relative-with-slash that must resolve → FAIL
  const soft = [] // bare filenames not found anywhere in the tree → WARN
  const seen = new Set()
  let resolvedCount = 0
  for (const { token } of pathTokens) {
    if (seen.has(token)) continue
    seen.add(token)
    if (deliverables.has(token) || deliverables.has(basename(token))) continue // outputs to CREATE
    if (token.startsWith('/')) {
      if (existsSync(token)) resolvedCount++
      else hard.push(token)
    } else if (token.includes('/')) {
      // Only judge slash-tokens that look like real file refs (dot-prefixed or extensioned).
      if (!token.startsWith('./') && !token.startsWith('../') && !/\.[A-Za-z0-9]+$/.test(basename(token))) continue
      if (existsSync(join(root, token))) resolvedCount++
      else hard.push(token)
    } else {
      if (baseSet.has(token) || existsSync(join(root, token))) resolvedCount++
      else soft.push(token)
    }
  }
  if (hard.length === 0 && soft.length === 0) {
    return pass('paths', resolvedCount ? `all ${resolvedCount} referenced path(s) resolve` : 'no path references')
  }
  const bits = []
  if (hard.length) bits.push(`unresolved: ${quoteList(hard)}`)
  if (soft.length) bits.push(`bare filename(s) not in tree: ${quoteList(soft)}`)
  return finding('paths', hard.length ? 'FAIL' : 'WARN', bits.join('; '),
    'briefs must be self-contained — inline the needed content (or ship it in the context bundle) and correct or drop dead paths',
    [...hard, ...soft])
}

// ---------------------------------------------------------------------------
// rule 3 — DELIVERABLE CONTRACT (also feeds rule 2's exclusion set)
// ---------------------------------------------------------------------------

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/
const DELIVER_VERB = /\b(?:save|write|writes|written|output|create|produce|emit|deliver\w*|store|place)\b/i
const BARE_FILE_RE = new RegExp('\\b[\\w@~-][\\w.@~-]*\\.(?:' + PATH_EXT + ')\\b', 'g')

export function extractDeliverables(text) {
  const deliverables = new Set()
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (!DELIVER_VERB.test(sentence)) continue
    for (const { token } of extractPathTokens(sentence)) {
      // Only file-looking targets: word/word prose ("reliability/efficiency") is not a deliverable.
      if (!/\.[A-Za-z0-9]+$/.test(basename(token))) continue
      deliverables.add(token)
      deliverables.add(basename(token))
    }
    for (const m of sentence.match(BARE_FILE_RE) || []) {
      deliverables.add(m)
    }
  }
  return deliverables
}

function checkDeliverable(deliverables) {
  if (deliverables.size > 0) {
    return pass('deliverable', `output contract names: ${quoteList([...deliverables].slice(0, 4))}`)
  }
  return finding('deliverable', 'FAIL',
    'no save/write instruction naming an output file',
    'add an explicit contract, e.g. "Save your plan to PLAN.md in your workspace." — without it attempts finish with nothing on disk',
    [])
}

// ---------------------------------------------------------------------------
// rule 4 — STOP RULE
// ---------------------------------------------------------------------------

const STOP_PATTERNS = [
  /\bsingle[- ]pass\b/i, /\bone[- ]pass\b/i, /\bexactly one (?:pass|attempt)\b/i,
  /\bat most one (?:pass|attempt|iteration)\b/i,
  /\bdo not iterate\b/i, /\bno iteration\b/i, /\bdo not (?:loop|retry|revisit|refine)\b/i,
  /\bhard[- ]stop\b/i, /\bstop after\b/i, /\bthen stop\b/i, /\bstop when\b/i,
  /\band stop\b/i, /\bstop immediately\b/i, /\bSTOP\b/,
  /\bno (?:further|additional|second) (?:pass(?:es)?|iterations?|attempts?|rounds?)\b/i,
]

function checkStopRule(text) {
  const hit = STOP_PATTERNS.find((p) => p.test(text))
  if (hit) return pass('stop-rule', 'hard-stop language present')
  return finding('stop-rule', 'FAIL',
    'no single-pass / hard-stop language found',
    'add e.g. "Make ONE pass; once the deliverable is saved, STOP." — iterating attempts blow their turn caps',
    [])
}

// ---------------------------------------------------------------------------
// rule 5 — CONFLICTING DIRECTIVES (heuristic, WARN)
// ---------------------------------------------------------------------------

const NEG_IMPLEMENT = /\b(?:do not|don't|never|must not)\s+(?:implement|write (?:any )?code|modify|edit|touch)\b|\bplan[- ]only\b|\bno code changes\b/gi
const POS_IMPLEMENT = /\bimplement(?:ing)?\s+(?:the|this|it|your|that)\b|\bwrite\s+(?:the\s+)?code\b|\bmake the (?:change|edit)s?\b|\bapply the (?:patch|diff|change)s?\b/i
const SIZE_MIN = /\b(?:smallest|minimal|tiniest|surgical)\s+(?:coherent\s+)?(?:change|edit|diff|patch|fix)\b/i
const SIZE_MAX = /\b(?:comprehensive|exhaustive)\b/i

function checkConflicts(text) {
  const details = []
  // implement vs do-not-implement: mask the negated forms, then look for a positive imperative.
  const negMatches = text.match(NEG_IMPLEMENT) || []
  if (negMatches.length) {
    const masked = text.replace(new RegExp(NEG_IMPLEMENT.source, 'gi'), (s) => ' '.repeat(s.length))
    const pos = masked.match(POS_IMPLEMENT)
    if (pos) details.push(`"${negMatches[0]}" vs "${pos[0]}"`)
  }
  // size words contradicting within the same clause-set (paragraph).
  for (const para of text.split(/\n\s*\n/)) {
    const lo = para.match(SIZE_MIN)
    const hi = para.match(SIZE_MAX)
    if (lo && hi) { details.push(`"${lo[0]}" vs "${hi[0]}"`); break }
  }
  if (details.length === 0) return pass('conflicts', 'no contradictory directives detected')
  return finding('conflicts', 'WARN',
    `possibly contradictory directives: ${details.join('; ')}`,
    'pick one instruction per axis (plan vs implement; minimal vs exhaustive) — attempts resolve conflicts randomly',
    details)
}

// ---------------------------------------------------------------------------
// rule 6 — ALTITUDE MIX (design-brief era)
// ---------------------------------------------------------------------------

const DESIGN_ASK = /\bdesign[- ]brief\b/i
const FILE_LEVEL_DEMAND = /\b(?:file[- ]level|per[- ]file)\s+(?:edit|change|modification)s?(?:\s+list)?\b|\bedit list\b|\blist of (?:file )?edits\b|\bfile\s*(?:→|->)\s*(?:what|change)/i
const CODE_DEMAND = /\b(?:include|provide|emit|give|add|show|full|complete)\b[^.\n]{0,60}\bcode blocks?\b|\bcode blocks? (?:are )?required\b/i

function checkAltitude(text) {
  if (!DESIGN_ASK.test(text)) return pass('altitude', 'not a design-brief ask')
  const fileHit = text.match(FILE_LEVEL_DEMAND)
  const codeHit = text.match(CODE_DEMAND)
  if (!fileHit && !codeHit) return pass('altitude', 'design-brief ask stays at design altitude')
  const what = [fileHit && `"${fileHit[0]}"`, codeHit && `"${codeHit[0]}"`].filter(Boolean).join(' and ')
  return finding('altitude', 'FAIL',
    `asks for a DESIGN BRIEF but also demands ${what}`,
    'a design brief stays above file level — drop the edit-list/code-block demands, or ask for an implementation plan instead',
    [fileHit?.[0], codeHit?.[0]].filter(Boolean))
}

// ---------------------------------------------------------------------------
// rule 7 — UNDEFINED JARGON (WARN)
// ---------------------------------------------------------------------------

const CAMEL_RE = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g
const SNAKE_CAPS_RE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g
const CAPS_HYPHEN_RE = /\b[A-Z][A-Z0-9]+(?:-[A-Z][A-Z0-9]+)+\b/g
const ALLCAPS_RE = /\b[A-Z]{4,}\b/g
const JARGON_ALLOW = new Set([
  'PASS', 'FAIL', 'WARN', 'STOP', 'GOAL', 'PLAN', 'NOTE', 'TODO', 'FIXME', 'README', 'LICENSE',
  'JSON', 'YAML', 'HTTP', 'HTTPS', 'HTML', 'ASCII', 'UTF', 'ALWAYS', 'NEVER', 'MUST', 'ONLY',
  'BEFORE', 'AFTER', 'IMPORTANT', 'CONSTRAINTS', 'CONSTRAINT', 'DELIVERABLE', 'DELIVERABLES',
  'TASK', 'SCOPE', 'RULES', 'ERROR', 'WARNING', 'TRUE', 'FALSE', 'NULL', 'NONE', 'EVERY',
  'WITH', 'THIS', 'THAT', 'FROM', 'INTO', 'YOUR', 'DOES', 'WHEN', 'WHAT', 'ALSO', 'BOTH',
  'EACH', 'MOST', 'SOME', 'SUCH', 'THAN', 'THEN', 'THEM', 'THEY', 'WILL', 'MAKE', 'ONCE',
  'CHOOSE', 'FULL', 'FILES', 'FILE', 'CODE', 'TEST', 'TESTS', 'DESIGN', 'BRIEF', 'INPUT',
  'OUTPUT', 'ONLY', 'NEVER', 'HARD', 'DIRECT', 'EXACTLY',
])
const MIXED_ALLOW = new Set(['iOS', 'macOS', 'iPhone', 'ePub'])

function jargonCandidates(text) {
  const cands = new Set()
  for (const re of [CAMEL_RE, SNAKE_CAPS_RE, CAPS_HYPHEN_RE, ALLCAPS_RE]) {
    const r = new RegExp(re.source, 'g')
    let m
    while ((m = r.exec(text)) !== null) {
      const tok = m[0]
      if (tok.length < 4 || tok.length > 40) continue
      if (JARGON_ALLOW.has(tok) || MIXED_ALLOW.has(tok)) continue
      // Fragment of a larger hyphen/underscore token ("INVALIDATED" inside
      // "AUTO-INVALIDATED") — the composite candidate covers it.
      const prev = text[m.index - 1]
      const next = text[m.index + tok.length]
      if (prev === '-' || prev === '_' || next === '-' || next === '_') continue
      if (countOccurrences(text, tok) > 1) continue // repeated (incl. lowercase uses) → context defines it
      // Defined inline right after first use — "TOKEN (", "TOKEN —", "TOKEN:", "TOKEN =".
      const tail = text.slice(m.index + tok.length, m.index + tok.length + 4)
      if (/^\s?[(—=:–]/.test(tail)) continue
      cands.add(tok)
    }
  }
  return [...cands].slice(0, 32)
}

function checkJargon(text, root, repoFiles) {
  const cands = jargonCandidates(text)
  if (cands.length === 0) return pass('jargon', 'no undefined one-off codenames')
  // A token is "known" if it appears in tracked file content or in any repo path.
  const inContent = tokensInRepoContent(root, cands)
  const unknown = cands.filter((t) =>
    !(inContent && inContent.has(t)) && !repoFiles.some((p) => p.includes(t)))
  if (unknown.length === 0) return pass('jargon', 'all one-off codenames exist in the repo tree')
  const note = inContent === null ? ' (repo content scan unavailable — path match only)' : ''
  return finding('jargon', 'WARN',
    `possibly undefined codename(s)${note}: ${quoteList(unknown)}`,
    'define each codename inline at first use, e.g. "enrichBlindPool (the pool-enrichment step in tournament.mjs)"',
    unknown)
}

// ---------------------------------------------------------------------------
// rule 8 — LENGTH BUDGET (WARN)
// ---------------------------------------------------------------------------

function checkLength(words) {
  if (words <= WORD_BUDGET) return pass('length', `${words} words (budget ${WORD_BUDGET})`)
  return finding('length', 'WARN',
    `${words} words exceeds the ${WORD_BUDGET}-word budget (attention dilution)`,
    'move bulk reference material into the context bundle; keep the brief to the task, contract, and constraints',
    [String(words)])
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

function pass(id, reason) { return { id, level: 'PASS', reason, suggestion: null, details: [] } }
function finding(id, level, reason, suggestion, details) { return { id, level, reason, suggestion, details } }
function quoteList(items, max = 4) {
  const shown = items.slice(0, max).map((s) => `"${s}"`).join(', ')
  return items.length > max ? `${shown}, +${items.length - max} more` : shown
}

export function lintBrief(text, { root = DEFAULT_ROOT } = {}) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const pathTokens = extractPathTokens(text)
  const deliverables = extractDeliverables(text)
  const repoFiles = listRepoFiles(root)
  const findings = [
    checkDeixis(text, pathTokens),
    checkPaths(text, pathTokens, deliverables, root, repoFiles),
    checkDeliverable(deliverables),
    checkStopRule(text),
    checkConflicts(text),
    checkAltitude(text),
    checkJargon(text, root, repoFiles),
    checkLength(words),
  ]
  const counts = { pass: 0, warn: 0, fail: 0 }
  for (const f of findings) counts[f.level.toLowerCase()]++
  return { words, findings, counts, ok: counts.fail === 0 }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  let file = null
  let json = false
  let root = DEFAULT_ROOT
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--root') {
      root = argv[++i]
      if (!root) { console.error('je-brief-test: --root needs a directory'); process.exit(2) }
      root = resolve(root)
    } else if (file === null) file = a
    else { console.error(`je-brief-test: unexpected argument "${a}"`); process.exit(2) }
  }
  if (!file) {
    console.error('usage: je-brief-test.mjs <brief-file|-> [--json] [--root <dir>]')
    process.exit(2)
  }
  let text
  try {
    text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')
  } catch (e) {
    console.error(`je-brief-test: cannot read ${file}: ${e.message}`)
    process.exit(2)
  }
  const source = file === '-' ? '<stdin>' : file
  const r = lintBrief(text, { root })
  if (json) {
    console.log(JSON.stringify({ source, ...r }, null, 2))
  } else {
    console.log(`je-brief-test — ${source} (${r.words} words)\n`)
    for (const f of r.findings) {
      console.log(`${f.level.padEnd(4)}  ${f.id.padEnd(12)} ${f.reason}`)
      if (f.level !== 'PASS' && f.suggestion) console.log(`      fix: ${f.suggestion}`)
    }
    const verdict = r.ok ? (r.counts.warn ? 'PASS (with warnings)' : 'PASS') : 'FAIL'
    console.log(`\nRESULT: ${verdict} — ${r.counts.fail} fail, ${r.counts.warn} warn, ${r.counts.pass} pass`)
  }
  process.exit(r.ok ? 0 : 1)
}

const isMain = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()
if (isMain) main()
