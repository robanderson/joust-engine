#!/usr/bin/env node
// je-evolve.mjs — GEPA-LITE: deterministic run-archive miner for brief evolution.
//
// Research basis: GEPA (arXiv:2507.19457) — reflective prompt evolution from
// execution traces beats RL-style tuning at ~35x lower cost. GEPA's loop is
// (1) mine execution traces for evidence, (2) reflect, (3) mutate the prompt.
// This tool is STEP 1 ONLY: a deterministic evidence miner. A human or a
// frontier-model session does the reflection and writes the actual brief
// mutation. Per the research, only WORKER prompts (attempt/judge/composer
// briefs) are optimization targets — ORCHESTRATOR/skill prose is NEVER in
// scope (same philosophy as bin/je-ledger.mjs: evidence with n=, not vibes).
//
// Usage:
//   node je-evolve.mjs <runDir> [<runDir>...]
//   node je-evolve.mjs --runs-root [<dir>]   # every subdir of <dir> that looks
//                                            # like a run (mapping.json or
//                                            # review-*/); bare flag => /tmp/de-runs
//
// Inputs read from each <runDir> (ALL optional — degrade gracefully):
//   mapping.json               — per-model valid-rate + failReason clusters
//                                (e.g. "no deliverable saved" = the brief's
//                                save contract failed); rc_summary.non00 for
//                                RC 03 (turn cap = brief scope too big) and
//                                RC 05 (no deliverable = save contract unclear)
//   review-*/verdict.json      — guidance.challenges: recurring challenge themes
//   review-*/council.json      — per-verdict pros_cons cons that repeat across
//                                rounds/runs
//
// Theme clustering: normalize (lowercase, strip candidate letters, strip
// punctuation), then greedily cluster items sharing >= 3 significant words
// with a cluster's seed. A cluster only counts as EVIDENCE when its items span
// >= 2 distinct sources (round/review/run) — repetition across the lenses of a
// single round is correlated-judge noise, not recurrence.
//
// Output: markdown "Brief-evolution evidence report" on stdout — per signal the
// observation, the runs/rounds citing it (n= everywhere), and a SUGGESTED BRIEF
// DELTA phrased as a hypothesis. A final section maps each suggestion to the
// brief template it targets (attempt plan-brief, implement-brief, judge lens
// brief, composer prompt) and flags orchestrator prose as out of scope.
//
// Timestamps come from artifact file mtimes only — never Date.now.
// Missing/malformed inputs degrade gracefully: mine what exists, never crash.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SHARED_WORDS_MIN = 3 // words a theme must share with a cluster seed
export const RECUR_MIN = 2 // distinct sources for a cluster to be evidence
export const DEFAULT_RUNS_ROOT = '/tmp/de-runs'

// The only legitimate mutation targets (worker prompts). Orchestrator/skill
// prose is NEVER a target — see header.
export const TEMPLATES = ['attempt plan-brief', 'implement-brief', 'judge lens brief', 'composer prompt']

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function readJsonMaybe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function statMaybe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function listDirsMaybe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// theme normalization + clustering
// ---------------------------------------------------------------------------
// Words too generic to indicate a shared theme. Tokens shorter than 4 chars
// are dropped anyway, so only stopwords of length >= 4 matter here.
const STOPWORDS = new Set([
  'that', 'with', 'this', 'from', 'into', 'then', 'than', 'they', 'their', 'there',
  'when', 'where', 'which', 'while', 'would', 'could', 'should', 'have', 'been',
  'being', 'were', 'does', 'doing', 'done', 'will', 'shall', 'must', 'them',
  'these', 'those', 'after', 'before', 'because', 'without', 'within', 'over',
  'under', 'only', 'also', 'more', 'most', 'less', 'least', 'very', 'such',
  'some', 'same', 'other', 'others', 'another', 'each', 'every', 'ever', 'never',
  'again', 'still', 'even', 'just', 'much', 'many', 'both', 'between', 'through',
  'against', 'onto', 'upon', 'about', 'above', 'below', 'itself', 'candidate',
  'candidates', 'attempt', 'attempts', 'plan', 'plans', 'makes', 'made', 'making',
])

// Normalize a theme string: lowercase, strip candidate-letter references
// ("candidate A", bare single letters), strip punctuation.
export function normalizeTheme(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\bcandidates?\s+[a-z]\b/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\b[a-z]\b/g, ' ') // bare candidate letters
    .replace(/\s+/g, ' ')
    .trim()
}

// The significant-word fingerprint of a theme (Set of tokens).
export function significantWords(text) {
  const out = new Set()
  for (const tok of normalizeTheme(text).split(' ')) {
    if (tok.length >= 4 && !STOPWORDS.has(tok)) out.add(tok)
  }
  return out
}

function sharedCount(a, b) {
  let n = 0
  for (const w of a) if (b.has(w)) n++
  return n
}

// Greedy deterministic clustering: items sorted by (source, text); each item
// joins the FIRST cluster whose SEED shares >= SHARED_WORDS_MIN significant
// words, else starts a new cluster.
// items: [{ text, source }] -> [{ seed, items, sources, runs, n }]
export function clusterThemes(items) {
  const sorted = [...items]
    .filter((it) => it && typeof it.text === 'string' && it.text.trim())
    .sort((a, b) => String(a.source).localeCompare(String(b.source)) || a.text.localeCompare(b.text))
  const clusters = []
  for (const it of sorted) {
    const words = significantWords(it.text)
    let home = null
    for (const c of clusters) {
      if (sharedCount(c.seedWords, words) >= SHARED_WORDS_MIN) {
        home = c
        break
      }
    }
    if (!home) {
      home = { seed: it.text, seedWords: words, items: [] }
      clusters.push(home)
    }
    home.items.push(it)
  }
  return clusters.map((c) => {
    const sources = [...new Set(c.items.map((i) => String(i.source)))].sort()
    const runs = [...new Set(c.items.map((i) => String(i.source).split('/')[0]))].sort()
    return { seed: c.seed, items: c.items, sources, runs, n: c.items.length }
  })
}

// Evidence bar: recurrence means >= RECUR_MIN DISTINCT sources (round/review/
// run) — not the same round's lenses echoing each other.
export function isRecurring(cluster) {
  return cluster.sources.length >= RECUR_MIN
}

// ---------------------------------------------------------------------------
// extraction: one runDir -> { seats, rcSignals, challenges, cons, ... }
// ---------------------------------------------------------------------------
export function collectRun(runDir) {
  const run = basename(resolve(runDir))
  const out = {
    run,
    mode: null,
    seats: [], // { model, valid, failReason|null, phase }
    rcSignals: [], // { rc, seat, phase, reason, run }
    challenges: [], // { text, conf, source }
    cons: [], // { text, source }
    guidanceBlocks: 0,
    councilRounds: 0,
    hasMapping: false,
    skipped: [],
    tsMin: null,
    tsMax: null,
  }
  const seen = (path) => {
    const st = statMaybe(path)
    if (!st) return
    if (out.tsMin === null || st.mtime < out.tsMin) out.tsMin = st.mtime
    if (out.tsMax === null || st.mtime > out.tsMax) out.tsMax = st.mtime
  }

  // --- mapping.json: seat validity + rc_summary --------------------------
  const mappingPath = join(runDir, 'mapping.json')
  if (statMaybe(mappingPath)) {
    const mapping = readJsonMaybe(mappingPath)
    if (!mapping) {
      out.skipped.push(`${run}/mapping.json (unreadable or invalid JSON)`)
    } else {
      out.hasMapping = true
      seen(mappingPath)
      out.mode = typeof mapping.mode === 'string' ? mapping.mode : null
      for (const [phase, arr] of [
        ['round1', mapping.round1],
        ['final', mapping.final],
      ]) {
        if (!Array.isArray(arr)) continue
        for (const s of arr) {
          if (!s || typeof s.model !== 'string') continue
          out.seats.push({
            model: s.model,
            valid: s.valid === true,
            failReason: typeof s.failReason === 'string' ? s.failReason.toLowerCase().trim() : null,
            phase,
          })
        }
      }
      const non00 = mapping.rc_summary?.non00
      if (Array.isArray(non00)) {
        for (const e of non00) {
          if (!e || (e.rc !== '03' && e.rc !== '05')) continue
          out.rcSignals.push({
            rc: e.rc,
            seat: typeof e.seat === 'string' ? e.seat : '?',
            phase: typeof e.phase === 'string' ? e.phase : '?',
            reason: typeof e.reason === 'string' ? e.reason : '',
            run,
          })
        }
      }
    }
  }

  // --- review-*/ : verdict.json guidance + council.json cons -------------
  for (const name of listDirsMaybe(runDir)) {
    if (!name.startsWith('review-')) continue
    const verdictPath = join(runDir, name, 'verdict.json')
    if (statMaybe(verdictPath)) {
      const verdict = readJsonMaybe(verdictPath)
      if (!verdict) {
        out.skipped.push(`${run}/${name}/verdict.json (unreadable or invalid JSON)`)
      } else {
        seen(verdictPath)
        const challenges = verdict.guidance?.challenges
        if (Array.isArray(challenges)) {
          out.guidanceBlocks++
          for (const c of challenges) {
            const text = typeof c === 'string' ? c : c?.text
            if (typeof text !== 'string' || !text.trim()) continue
            out.challenges.push({
              text,
              conf: typeof c?.conf === 'string' ? c.conf : null,
              source: `${run}/${name}`,
            })
          }
        }
      }
    }
    const councilPath = join(runDir, name, 'council.json')
    if (statMaybe(councilPath)) {
      const council = readJsonMaybe(councilPath)
      if (!council) {
        out.skipped.push(`${run}/${name}/council.json (unreadable or invalid JSON)`)
      } else {
        seen(councilPath)
        const rounds = Array.isArray(council.rounds) ? council.rounds : []
        for (const r of rounds) {
          const verdicts = Array.isArray(r?.verdicts) ? r.verdicts : []
          if (verdicts.length === 0) continue
          out.councilRounds++
          const source = `${run}/${name}/round-${r?.round ?? '?'}`
          for (const v of verdicts) {
            for (const pc of Array.isArray(v?.pros_cons) ? v.pros_cons : []) {
              for (const con of Array.isArray(pc?.cons) ? pc.cons : []) {
                if (typeof con === 'string' && con.trim()) out.cons.push({ text: con, source })
              }
            }
          }
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// mining: aggregate collected runs
// ---------------------------------------------------------------------------
export function mine(runDirs) {
  const agg = {
    runsMined: 0,
    runs: [], // per-run collect results actually mined
    models: new Map(), // model -> { seats, valid, failReasons: Map(reason -> { n, runs:Set }) }
    challenges: [],
    cons: [],
    rc03: [],
    rc05: [],
    composeOnlyRuns: new Set(),
    skipped: [],
    tsMin: null,
    tsMax: null,
  }
  for (const dir of runDirs) {
    const res = collectRun(dir)
    const empty =
      !res.hasMapping && res.challenges.length === 0 && res.cons.length === 0 && res.skipped.length === 0
    if (empty) {
      agg.skipped.push(`${dir} (no mapping.json or review-* artifacts found)`)
      continue
    }
    agg.runsMined++
    agg.runs.push(res)
    agg.skipped.push(...res.skipped)
    if (res.mode === 'composeOnly') agg.composeOnlyRuns.add(res.run)
    for (const s of res.seats) {
      if (!agg.models.has(s.model)) agg.models.set(s.model, { seats: 0, valid: 0, failReasons: new Map() })
      const st = agg.models.get(s.model)
      st.seats++
      if (s.valid) st.valid++
      else {
        const reason = s.failReason || 'unspecified'
        if (!st.failReasons.has(reason)) st.failReasons.set(reason, { n: 0, runs: new Set() })
        const fr = st.failReasons.get(reason)
        fr.n++
        fr.runs.add(res.run)
      }
    }
    agg.challenges.push(...res.challenges)
    agg.cons.push(...res.cons)
    for (const sig of res.rcSignals) (sig.rc === '03' ? agg.rc03 : agg.rc05).push(sig)
    if (res.tsMin && (agg.tsMin === null || res.tsMin < agg.tsMin)) agg.tsMin = res.tsMin
    if (res.tsMax && (agg.tsMax === null || res.tsMax > agg.tsMax)) agg.tsMax = res.tsMax
  }
  return agg
}

// ---------------------------------------------------------------------------
// suggested-delta helpers
// ---------------------------------------------------------------------------
// A failReason about the deliverable/save contract gets the specific
// save-instruction delta; anything else gets a generic contract delta.
export function isSaveContractFailure(reason) {
  return /no deliverable|deliverable|save/i.test(String(reason ?? ''))
}

// Which brief template does a review dir's evidence point at?
// review-impl-* judges implement attempts; everything else judges plans.
export function templateForReviewDir(source) {
  return /\/review-impl-/.test(`/${source}`) ? 'implement-brief' : 'attempt plan-brief'
}

// Which template does an rc_summary seat name point at? Judge seats are named
// review-*/final-rank-*; anything else is a worker attempt seat.
export function templateForRcSeat(seat) {
  return /^(review-|final-rank-)/.test(String(seat ?? '')) ? ['judge lens brief'] : ['attempt plan-brief', 'implement-brief']
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const pct = (num, den) => (den > 0 ? `${Math.round((100 * num) / den)}%` : '—')
// security-sweep H22 (2026-07-07): `c.seed` is MODEL-AUTHORED review text and is rendered into the
// evolution report, which a human reads and may feed back into brief mutation — so a candidate can
// inject instructions/markdown that steer FUTURE briefs (self-perpetuating). Neutralise the two
// break-out vectors before display: collapse newlines to spaces (can't spawn a new markdown block or
// heading) and defang backticks/backslashes (can't open/close a code fence). trunc still bounds length.
const fence = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/[`\\]/g, '·')
const trunc = (s, n = 160) => { const t = fence(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t }

export function reportMd(agg) {
  const out = []
  const push = (s = '') => out.push(s)
  const suggestions = [] // { id, text, targets }
  const suggest = (text, targets) => {
    const id = `S${suggestions.length + 1}`
    suggestions.push({ id, text, targets })
    return id
  }

  push('# Brief-evolution evidence report (GEPA-LITE)')
  push()
  push('Basis: GEPA (arXiv:2507.19457) — reflective prompt evolution from execution')
  push('traces (~35x cheaper than RL). This report is the EVIDENCE step only: a human')
  push('or frontier session does the reflection and writes the brief mutation. Every')
  push('suggested delta below is a HYPOTHESIS with its n, never a prescription.')
  push()
  const window =
    agg.tsMin && agg.tsMax
      ? `${agg.tsMin.toISOString()} .. ${agg.tsMax.toISOString()} (artifact mtimes)`
      : 'unknown (no dated artifacts)'
  push(`Runs mined: n=${agg.runsMined}; data window: ${window}`)
  if (agg.skipped.length) {
    push()
    push(`Skipped inputs (n=${agg.skipped.length}):`)
    for (const s of agg.skipped) push(`- ${s}`)
  }
  push()
  if (agg.runsMined === 0) {
    push('No run artifacts found in the given run dirs (n=0). Nothing to mine.')
    return out.join('\n') + '\n'
  }

  // --- signal A: per-model validity + failReason clusters ----------------
  push('## Signal A — per-model deliverable validity (mapping.json)')
  push()
  const modelNames = [...agg.models.keys()].sort()
  if (modelNames.length === 0) {
    push('No mapping.json seat data found (n=0).')
  } else {
    push('| model | seats | valid-rate | failReasons seen |')
    push('|---|---|---|---|')
    for (const m of modelNames) {
      const st = agg.models.get(m)
      const fr = [...st.failReasons.entries()]
        .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
        .map(([reason, x]) => `"${reason}" (n=${x.n})`)
        .join('; ')
      push(`| ${m} | n=${st.seats} | ${pct(st.valid, st.seats)} (n=${st.seats}) | ${fr || '—'} |`)
    }
    push()
    let any = false
    for (const m of modelNames) {
      const st = agg.models.get(m)
      for (const [reason, x] of [...st.failReasons.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (x.n < RECUR_MIN) continue
        any = true
        const runs = [...x.runs].sort()
        const delta = isSaveContractFailure(reason)
          ? 'consider moving the save instruction earlier in the brief and repeating it as the final line'
          : 'consider making the brief\'s success contract for this failure mode explicit'
        const targets = ['attempt plan-brief', 'implement-brief']
        if (runs.some((r) => agg.composeOnlyRuns.has(r))) targets.push('composer prompt')
        const id = suggest(
          `attempts on ${m} failed with "${reason}" in n=${x.n}/${st.seats} seats → ${delta}`,
          targets,
        )
        push(
          `- **Observation (n=${x.n}/${st.seats} seats, runs: ${runs.join(', ')}):** attempts on ${m} failed with "${reason}".`,
        )
        push(`  **SUGGESTED BRIEF DELTA [${id}] (hypothesis):** ${delta}.`)
      }
    }
    if (!any) push(`- No failReason recurs at n>=${RECUR_MIN} for any model. No delta suggested from this signal.`)
  }
  push()

  // --- shared renderer for theme-cluster signals --------------------------
  const renderClusters = (clusters, kind, deltaText) => {
    const recurring = clusters.filter(isRecurring).sort((a, b) => b.n - a.n || a.seed.localeCompare(b.seed))
    if (recurring.length === 0) {
      push(`- No ${kind} recurs across >=${RECUR_MIN} distinct sources. No delta suggested from this signal.`)
      return recurring
    }
    for (const c of recurring) {
      const id = suggest(
        `${kind} recurred in n=${c.n} citations across ${c.sources.length} sources (${c.runs.length} run${c.runs.length === 1 ? '' : 's'}): "${trunc(c.seed, 120)}" → ${deltaText}`,
        [...new Set(c.sources.map(templateForReviewDir))],
      )
      push(`- **Observation (n=${c.n} citations across ${c.sources.length} sources; runs: ${c.runs.join(', ')}):**`)
      push(`  "${trunc(c.seed)}"`)
      push(`  Cited by: ${c.sources.join('; ')}`)
      push(`  **SUGGESTED BRIEF DELTA [${id}] (hypothesis):** ${deltaText}.`)
    }
    return recurring
  }

  // --- signal B: recurring challenge themes (review guidance) ------------
  push('## Signal B — recurring challenge themes (review-*/verdict.json guidance)')
  push()
  const challengeClusters = clusterThemes(agg.challenges)
  renderClusters(
    challengeClusters,
    'challenge theme',
    'consider adding an explicit warning/checklist line for this pitfall to the brief so fresh attempts avoid it without needing round-2 guidance',
  )
  // strong-confidence single-source challenges: below the evidence bar, watch list only.
  const watch = challengeClusters.filter((c) => !isRecurring(c) && c.items.some((i) => i.conf === 'strong'))
  if (watch.length) {
    push()
    push(`Watch list (below evidence bar — single source, conf=strong; NO delta yet, collect more runs):`)
    for (const c of watch) push(`- (n=${c.n}, ${c.sources.join('; ')}) "${trunc(c.seed)}"`)
  }
  push()

  // --- signal C: recurring council cons -----------------------------------
  push('## Signal C — recurring council cons (review-*/council.json)')
  push()
  push(`Cons repeated by lenses within ONE round are correlated-judge noise and do NOT count;`)
  push(`a cluster is evidence only across >=${RECUR_MIN} distinct rounds/reviews/runs.`)
  push()
  renderClusters(
    clusterThemes(agg.cons),
    'council con',
    'consider a brief line that pre-empts this recurring weakness (state the constraint or required check directly in the brief)',
  )
  push()

  // --- signal D: return-code signals --------------------------------------
  push('## Signal D — return-code signals (mapping.json rc_summary)')
  push()
  if (agg.rc03.length === 0 && agg.rc05.length === 0) {
    push('No RC 03 (turn cap) or RC 05 (no deliverable) seats found (n=0).')
  }
  if (agg.rc03.length) {
    const runs = [...new Set(agg.rc03.map((s) => s.run))].sort()
    const delta =
      'brief scope may be too big for the turn budget; consider trimming required sections or splitting the deliverable'
    const targets = [...new Set(agg.rc03.flatMap((s) => templateForRcSeat(s.seat)))].sort()
    const id = suggest(`n=${agg.rc03.length} seats hit the turn cap (RC 03) → ${delta}`, targets)
    push(`- **Observation (n=${agg.rc03.length} seats, runs: ${runs.join(', ')}):** RC 03 turn-cap exits:`)
    for (const s of agg.rc03) push(`  - ${s.run}: ${s.seat} (${s.phase}${s.reason ? `, ${s.reason}` : ''})`)
    push(`  **SUGGESTED BRIEF DELTA [${id}] (hypothesis):** ${delta}.`)
  }
  if (agg.rc05.length) {
    const runs = [...new Set(agg.rc05.map((s) => s.run))].sort()
    const delta =
      'save contract may be unclear; consider moving the save instruction earlier in the brief and repeating it as the final line'
    const targets = [...new Set(agg.rc05.flatMap((s) => templateForRcSeat(s.seat)))].sort()
    if (runs.some((r) => agg.composeOnlyRuns.has(r)) && !targets.includes('composer prompt')) {
      targets.push('composer prompt')
    }
    const id = suggest(`n=${agg.rc05.length} seats ended with no deliverable (RC 05) → ${delta}`, targets)
    push(`- **Observation (n=${agg.rc05.length} seats, runs: ${runs.join(', ')}):** RC 05 no-deliverable exits:`)
    for (const s of agg.rc05) push(`  - ${s.run}: ${s.seat} (${s.phase}${s.reason ? `, ${s.reason}` : ''})`)
    push(`  **SUGGESTED BRIEF DELTA [${id}] (hypothesis):** ${delta}.`)
  }
  push()

  // --- final section: suggestion -> template targets -----------------------
  push('## Suggested deltas → target templates')
  push()
  push(`Worker-prompt templates only: ${TEMPLATES.join(', ')}.`)
  push()
  push('**OUT OF SCOPE: ORCHESTRATOR/skill prose is NEVER a mutation target** — per the')
  push('GEPA research this tool optimizes WORKER prompts only; orchestration logic stays')
  push('hand-maintained and is excluded from every suggestion above.')
  push()
  if (suggestions.length === 0) {
    push('No suggested deltas met the evidence bar in this mining pass (n=0).')
  } else {
    push('| id | suggested delta (hypothesis) | target template(s) |')
    push('|---|---|---|')
    for (const s of suggestions) {
      push(`| ${s.id} | ${trunc(s.text.replace(/\|/g, '\\|'), 220)} | ${s.targets.join(', ')} |`)
    }
  }
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// run-dir discovery
// ---------------------------------------------------------------------------
export function discoverRunsRoot(root) {
  const found = []
  for (const name of listDirsMaybe(root)) {
    const runDir = join(root, name)
    const looksLikeRun =
      statMaybe(join(runDir, 'mapping.json')) !== null || listDirsMaybe(runDir).some((d) => d.startsWith('review-'))
    if (looksLikeRun) found.push(runDir)
  }
  return found
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main(argv) {
  const runDirs = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--runs-root') {
      // value optional: bare flag defaults to DEFAULT_RUNS_ROOT
      let root = DEFAULT_RUNS_ROOT
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) root = argv[++i]
      runDirs.push(...discoverRunsRoot(root))
    } else if (arg.startsWith('-')) {
      console.error(`je-evolve: unknown flag ${arg}`)
      console.error('usage: je-evolve.mjs <runDir> [<runDir>...] | --runs-root [<dir>]')
      return 2
    } else {
      runDirs.push(arg)
    }
  }
  if (runDirs.length === 0) {
    console.error('usage: je-evolve.mjs <runDir> [<runDir>...] | --runs-root [<dir>]')
    return 2
  }
  process.stdout.write(reportMd(mine(runDirs)))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
