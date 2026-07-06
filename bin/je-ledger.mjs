#!/usr/bin/env node
// je-ledger.mjs — cross-run leaderboard ledger (issue #41).
//
// Per-run artifacts (mapping.json, contributions.json, timeline.jsonl) live in
// gitignored run dirs and die with them. This tool APPENDS one JSON line per
// completed run to a durable, append-only ledger (like .bench/results.jsonl),
// then aggregates the ledger into a markdown leaderboard so diversity pools and
// default seats can be tuned on evidence instead of vibes.
//
// Usage:
//   node je-ledger.mjs record <runDir>       # append one record (skips if run already recorded)
//   node je-ledger.mjs report                # aggregate ledger -> markdown on stdout
//   node je-ledger.mjs convergence <bucket>  # emit `JE-LEDGER-CONVERGENCE samples=N ratio=F` for a
//                                            # task bucket (issue #36 dynamic-M evidence; stdout only)
//
// Ledger path: $JE_LEDGER_PATH, else ~/.joust-engine/ledger.jsonl.
//
// Inputs read from <runDir> (everything optional except mapping.json):
//   mapping.json    — unblinded outcomes: mode, n, round1/final seats, winners, rc_summary
//   implement.json  — grand-loop implement phase: roundN.mapping seats + implement winner
//   timeline.jsonl  — per-agent timings; yields the per-phase "barrier" (slowest attempt)
//                     and mean attempt durations (attributed to a model only when a phase's
//                     seats all ran the SAME model — blind letters can't be joined to the
//                     timeline's seat indexes, so mixed phases stay unattributed)
//
// Missing/malformed optional inputs degrade gracefully: record what exists, never crash.
// Every report row carries its sample size (n=…); hypotheses need n — nothing is phrased
// as a recommendation below n>=5, and even then only as a hypothesis.

import { readFileSync, appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// ledger location
// ---------------------------------------------------------------------------
export function ledgerPath(env = process.env) {
  return env.JE_LEDGER_PATH || join(homedir(), '.joust-engine', 'ledger.jsonl')
}

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

function readLinesMaybe(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
  } catch {
    return null
  }
}

// Copy only the seat fields the ledger tracks; optional fields survive when present.
// `collapse` (issue #36): the dedup group {rep, group:[letters]} a seat belongs to — carried so the
// convergence aggregate below can tell which recorded runs actually converged, and so implement-win
// credit can be SPLIT across a collapsed group instead of inflating one model's win-rate telemetry.
const SEAT_OPTIONAL = ['round', 'failReason', 'rc', 'mechanical', 'seedBrief', 'collapse']
function pickSeat(phase, s, extra = {}) {
  const out = { phase, candidate: s.candidate ?? null, model: s.model ?? null, valid: s.valid === true }
  for (const k of SEAT_OPTIONAL) if (s[k] !== undefined) out[k] = s[k]
  return { ...out, ...extra }
}

// ---------------------------------------------------------------------------
// timeline analysis
// ---------------------------------------------------------------------------
// timeline.jsonl lines look like:
//   {"label":"attempt:round-1/candidate-8","durSecs":175,...}
//   {"label":"attempt:impl-3/impl-2","durSecs":213,...}
// Group = the segment between "attempt:" and "/" (round-1, round-2, impl-3, …).
export function analyzeTimeline(lines) {
  const groups = new Map() // group -> { entries: [{seat, durSecs}] }
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue // malformed line: skip, never crash
    }
    const label = typeof e?.label === 'string' ? e.label : ''
    if (!label.startsWith('attempt:')) continue
    const rest = label.slice('attempt:'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) continue
    const group = rest.slice(0, slash)
    const seat = rest.slice(slash + 1)
    const durSecs = Number(e.durSecs)
    if (!Number.isFinite(durSecs)) continue
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push({ seat, durSecs })
  }
  const barrier = []
  const attempts = []
  for (const [group, entries] of groups) {
    let max = entries[0]
    let sum = 0
    for (const e of entries) {
      sum += e.durSecs
      if (e.durSecs > max.durSecs) max = e
    }
    barrier.push({ group, seat: max.seat, durSecs: max.durSecs })
    attempts.push({ group, n: entries.length, meanSecs: Math.round(sum / entries.length) })
  }
  barrier.sort((a, b) => a.group.localeCompare(b.group))
  attempts.sort((a, b) => a.group.localeCompare(b.group))
  return { barrier, attempts }
}

// Attribute a timeline attempt group to a single model iff every seat that
// mapping.json (or implement.json) lists for that phase ran the same model.
// (Blind candidate letters cannot be joined to the timeline's seat indexes.)
export function groupModels(group, mapping, implement) {
  if (group === 'round-1') return (mapping?.round1 || []).map((s) => s.model)
  const roundM = /^round-(\d+)$/.exec(group)
  if (roundM) {
    const r = Number(roundM[1])
    return (mapping?.final || []).filter((s) => s.round === r).map((s) => s.model)
  }
  const implM = /^impl-(\d+)$/.exec(group)
  if (implM) {
    const seats = implement?.[`round${implM[1]}`]?.mapping
    return Array.isArray(seats) ? seats.map((s) => s.model) : []
  }
  return []
}

function uniformModel(models) {
  const set = new Set(models.filter(Boolean))
  return set.size === 1 ? [...set][0] : null
}

// ---------------------------------------------------------------------------
// record building
// ---------------------------------------------------------------------------
export function buildRecord(runDir) {
  const mappingPath = join(runDir, 'mapping.json')
  if (!existsSync(mappingPath)) throw new Error(`no mapping.json in ${runDir} — is this a completed run dir?`)
  const mapping = readJsonMaybe(mappingPath)
  if (!mapping) throw new Error(`mapping.json in ${runDir} is not valid JSON`)

  // ts = mtime of mapping.json (when the run finished), NEVER Date.now of recording.
  const ts = statSync(mappingPath).mtime.toISOString()

  const implement = readJsonMaybe(join(runDir, 'implement.json')) // often absent

  const seats = []
  for (const s of Array.isArray(mapping.round1) ? mapping.round1 : []) seats.push(pickSeat('round1', s))
  for (const s of Array.isArray(mapping.final) ? mapping.final : []) seats.push(pickSeat('final', s))
  if (implement) {
    for (const k of Object.keys(implement)) {
      const m = /^round(\d+)$/.exec(k)
      if (!m || !Array.isArray(implement[k]?.mapping)) continue
      for (const s of implement[k].mapping) {
        seats.push(pickSeat('implement', s, s.round === undefined ? { round: Number(m[1]) } : {}))
      }
    }
  }

  const rec = {
    run: basename(resolve(runDir)),
    ts,
    mode: mapping.mode ?? null,
    n: mapping.n ?? null,
    seats,
    winner1: mapping.winner1 ?? null,
    winner: mapping.winner ?? null,
    winnerRound: mapping.winnerRound ?? null,
  }
  // taskBucket (issue #36): the per-run opaque convergence key the engine stamps into an implement
  // run's mapping.json. Recorded verbatim so `convergence <bucket>` can accumulate same-bucket
  // evidence across runs; absent on plan-only runs (never written => the bucket has no samples).
  if (mapping.taskBucket !== undefined && mapping.taskBucket !== null) rec.taskBucket = mapping.taskBucket
  const implementWinner = mapping.implementWinner ?? implement?.winner
  if (implementWinner !== undefined && implementWinner !== null) {
    rec.implementWinner = implementWinner
    const iwr = mapping.implementWinnerRound ?? implement?.winnerRound
    if (iwr !== undefined && iwr !== null) rec.implementWinnerRound = iwr
  }
  if (mapping.rc_summary && typeof mapping.rc_summary === 'object') {
    rec.rc_summary = { seats: mapping.rc_summary.seats ?? null, by_code: mapping.rc_summary.by_code ?? {} }
  }

  const timelineLines = readLinesMaybe(join(runDir, 'timeline.jsonl'))
  if (timelineLines) {
    const { barrier, attempts } = analyzeTimeline(timelineLines)
    if (barrier.length) rec.barrier = barrier
    if (attempts.length) {
      rec.attempts = attempts.map((a) => {
        const model = uniformModel(groupModels(a.group, mapping, implement))
        return model ? { ...a, model } : a
      })
    }
  }
  return rec
}

// ---------------------------------------------------------------------------
// ledger IO
// ---------------------------------------------------------------------------
export function readLedger(path) {
  const lines = readLinesMaybe(path)
  if (!lines) return []
  const byRun = new Map() // dedupe by run name, last record wins
  for (const line of lines) {
    try {
      const rec = JSON.parse(line)
      if (rec && typeof rec.run === 'string') byRun.set(rec.run, rec)
    } catch {
      /* skip malformed line */
    }
  }
  return [...byRun.values()]
}

export function record(runDir, path) {
  const rec = buildRecord(runDir)
  if (readLedger(path).some((r) => r.run === rec.run)) {
    return { rec, skipped: true }
  }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(rec) + '\n')
  return { rec, skipped: false }
}

// ---------------------------------------------------------------------------
// convergence (issue #36)
// ---------------------------------------------------------------------------
// Same-task convergence aggregate for a taskBucket: how many recorded runs carry that bucket
// (samples), and what fraction of them CONVERGED — i.e. had an implement-phase seat that collapsed
// into a >=2-member byte-identical group. This is the real telemetry `readConvergenceEvidence`
// shells for in workflows/tournament.mjs; the engine (not this tool) decides the trim from it.
export function convergence(bucket, path) {
  const records = readLedger(path)
  let samples = 0
  let converged = 0
  for (const rec of records) {
    if (!rec || rec.taskBucket == null || String(rec.taskBucket) !== String(bucket)) continue
    samples++
    const didConverge = (rec.seats || []).some(
      (s) => s.phase === 'implement' && s.collapse && Array.isArray(s.collapse.group) && s.collapse.group.length >= 2,
    )
    if (didConverge) converged++
  }
  const ratio = samples > 0 ? converged / samples : 0
  return { samples, converged, ratio }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
function pct(num, den) {
  return den > 0 ? `${Math.round((100 * num) / den)}%` : '—'
}

function seatModel(rec, phases, candidate) {
  if (candidate === undefined || candidate === null) return null
  const seat = rec.seats.find((s) => phases.includes(s.phase) && s.candidate === candidate)
  return seat?.model ?? null
}

export function aggregate(records) {
  const models = new Map()
  const stat = (m) => {
    if (!models.has(m)) {
      models.set(m, { seats: 0, valid: 0, r1Wins: 0, finalWins: 0, implWins: 0, vetoes: 0, durSum: 0, durN: 0 })
    }
    return models.get(m)
  }
  let twoPassFinals = 0
  let round2Wins = 0
  let carriedWins = 0
  const rcTotals = {}

  for (const rec of records) {
    for (const s of rec.seats || []) {
      if (!s.model) continue
      const st = stat(s.model)
      st.seats++
      if (s.valid) st.valid++
      if (typeof s.failReason === 'string' && /veto/i.test(s.failReason)) st.vetoes++
    }
    const r1 = seatModel(rec, ['round1'], rec.winner1)
    if (r1) stat(r1).r1Wins++
    // Final winner: the `final` pool when it exists; a single-pass run's winner1 IS its final.
    const hasFinal = (rec.seats || []).some((s) => s.phase === 'final')
    const finalModel = hasFinal
      ? seatModel(rec, ['final'], rec.winner)
      : seatModel(rec, ['round1'], rec.winner ?? rec.winner1)
    if (finalModel) stat(finalModel).finalWins++
    // Implement win credit (issue #36): when the winning implement candidate is the representative of
    // a byte-identical collapse group, SPLIT one win 1/k across the group members' models instead of
    // crediting the rep's model the full win — convergence must not inflate the aggregate win-rate a
    // future dynamic-M reads. A non-collapsed winner credits its model +1 exactly as before.
    const implSeats = (rec.seats || []).filter((s) => s.phase === 'implement')
    // Round-scoped seat lookup (codex-review correctness finding, 2026-07-06): Round 4 reuses
    // Round 3's blind letters, so a bare candidate-letter .find() resolves to the FIRST (round-3)
    // seat and can credit the wrong model/collapse-group. Prefer the seat whose round matches
    // implementWinnerRound; when rounds are unrecorded, take the LAST match (the later round).
    const seatFor = (cand) => {
      const matches = implSeats.filter((s) => s.candidate === cand)
      if (!matches.length) return null
      if (rec.implementWinnerRound != null) {
        const m = matches.find((s) => s.round === rec.implementWinnerRound)
        if (m) return m
      }
      return matches[matches.length - 1]
    }
    const winSeat = rec.implementWinner != null ? seatFor(rec.implementWinner) : null
    if (winSeat && winSeat.model) {
      const group = winSeat.collapse && Array.isArray(winSeat.collapse.group) ? winSeat.collapse.group : null
      if (group && group.length >= 2) {
        const members = group.map(seatFor).filter((s) => s && s.model)
        const share = members.length > 0 ? 1 / members.length : 1
        for (const m of members) stat(m.model).implWins += share
      } else {
        stat(winSeat.model).implWins++
      }
    }

    if (rec.mode === 'two' && rec.winner && rec.winnerRound != null) {
      twoPassFinals++
      if (rec.winnerRound === 2) round2Wins++
      else carriedWins++
    }
    for (const [code, count] of Object.entries(rec.rc_summary?.by_code || {})) {
      rcTotals[code] = (rcTotals[code] || 0) + count
    }
    for (const a of rec.attempts || []) {
      if (!a.model) continue
      const st = stat(a.model)
      st.durSum += a.meanSecs * a.n
      st.durN += a.n
    }
  }
  return { models, twoPassFinals, round2Wins, carriedWins, rcTotals }
}

export function reportMd(records) {
  const out = []
  const push = (s = '') => out.push(s)
  push('# Cross-run ledger report')
  push()
  if (records.length === 0) {
    push('No runs recorded yet. Record one with: `node bin/je-ledger.mjs record <runDir>`')
    return out.join('\n') + '\n'
  }
  const modes = {}
  for (const r of records) modes[r.mode ?? '?'] = (modes[r.mode ?? '?'] || 0) + 1
  push(`Runs recorded: n=${records.length} (${Object.entries(modes).map(([m, c]) => `${m}=${c}`).join(', ')})`)
  push()

  const { models, twoPassFinals, round2Wins, carriedWins, rcTotals } = aggregate(records)
  const rows = [...models.entries()].sort(
    (a, b) => b[1].finalWins - a[1].finalWins || b[1].seats - a[1].seats || a[0].localeCompare(b[0]),
  )

  push('## Per-model leaderboard')
  push()
  push('| model | seats | valid-rate | R1 wins | final wins | impl wins | vetoes | mean attempt dur |')
  push('|---|---|---|---|---|---|---|---|')
  for (const [model, st] of rows) {
    const dur = st.durN > 0 ? `${Math.round(st.durSum / st.durN)}s (n=${st.durN})` : '— (n=0)'
    push(
      `| ${model} | n=${st.seats} | ${pct(st.valid, st.seats)} (n=${st.seats}) | ${st.r1Wins} | ${st.finalWins} | ${st.implWins} | ${st.vetoes} | ${dur} |`,
    )
  }
  push()
  push('Attempt durations come from timeline.jsonl and are attributed to a model only when a')
  push('phase ran a single model (blind letters cannot be joined to timeline seat indexes).')
  push()

  push('## Assumption: two-pass value')
  push()
  if (twoPassFinals > 0) {
    push(
      `Final winners in two-pass runs (n=${twoPassFinals}): fresh round-2 = ${round2Wins}, carried round-1 = ${carriedWins}.`,
    )
  } else {
    push('No two-pass runs with a final winner recorded yet (n=0).')
  }
  push()

  push('## Assumption: diversity (win distribution)')
  push()
  const totalFinalWins = rows.reduce((a, [, st]) => a + st.finalWins, 0)
  if (totalFinalWins > 0) {
    push(`Final wins across models (n=${totalFinalWins}):`)
    for (const [model, st] of rows) {
      if (st.finalWins > 0) push(`- ${model}: ${st.finalWins} (${pct(st.finalWins, totalFinalWins)}, n=${totalFinalWins})`)
    }
  } else {
    push('No final winners recorded yet (n=0).')
  }
  push()

  push('## Assumption: per-seat cost-vs-contribution')
  push()
  push('| model | seat share | win share (R1+final+impl) | wins/seat | n seats |')
  push('|---|---|---|---|---|')
  const totalSeats = rows.reduce((a, [, st]) => a + st.seats, 0)
  const totalWins = rows.reduce((a, [, st]) => a + st.r1Wins + st.finalWins + st.implWins, 0)
  for (const [model, st] of rows) {
    const wins = st.r1Wins + st.finalWins + st.implWins
    const perSeat = st.seats > 0 ? (wins / st.seats).toFixed(2) : '—'
    push(`| ${model} | ${pct(st.seats, totalSeats)} | ${pct(wins, totalWins)} | ${perSeat} | n=${st.seats} |`)
  }
  push()

  if (Object.keys(rcTotals).length) {
    push('## Return codes (summed by_code across runs)')
    push()
    push(
      Object.entries(rcTotals)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([c, n]) => `${c}=${n}`)
        .join(', ') + ` (n=${records.filter((r) => r.rc_summary).length} runs with rc_summary)`,
    )
    push()
  }

  push('## Hypotheses')
  push()
  push('Nothing here is a recommendation below n>=5; everything is phrased as a hypothesis.')
  let any = false
  for (const [model, st] of rows) {
    if (st.seats < 5) continue
    any = true
    const wins = st.r1Wins + st.finalWins + st.implWins
    const seatShare = totalSeats > 0 ? st.seats / totalSeats : 0
    const winShare = totalWins > 0 ? wins / totalWins : 0
    if (st.valid / st.seats < 0.5) {
      push(`- Hypothesis (n=${st.seats} seats): ${model} completes <50% of seats — its pool share may be wasted cost.`)
    } else if (winShare > seatShare) {
      push(`- Hypothesis (n=${st.seats} seats): ${model} wins above its seat share (${pct(wins, totalWins)} of wins from ${pct(st.seats, totalSeats)} of seats) — more seats may raise win quality.`)
    } else if (winShare < seatShare / 2 && totalWins >= 5) {
      push(`- Hypothesis (n=${st.seats} seats): ${model} wins well below its seat share (${pct(wins, totalWins)} of wins from ${pct(st.seats, totalSeats)} of seats) — seats may be better spent elsewhere.`)
    }
  }
  if (twoPassFinals >= 5) {
    any = true
    push(
      `- Hypothesis (n=${twoPassFinals} two-pass runs): round-2 fresh attempts win ${pct(round2Wins, twoPassFinals)} of finals — ${round2Wins > carriedWins ? 'the second pass appears to add value' : 'carried round-1 work holds its own; the second pass may add less than assumed'}.`,
    )
  }
  if (!any) push('- Insufficient data for any hypothesis (need n>=5 per row).')
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main(argv) {
  const [cmd, arg] = argv
  const path = ledgerPath()
  if (cmd === 'record') {
    if (!arg) {
      console.error('usage: je-ledger.mjs record <runDir>')
      return 2
    }
    let res
    try {
      res = record(arg, path)
    } catch (e) {
      console.error(`je-ledger: ${e.message}`)
      return 1
    }
    if (res.skipped) console.error(`je-ledger: run "${res.rec.run}" already recorded in ${path} — skipped`)
    else console.error(`je-ledger: recorded "${res.rec.run}" (${res.rec.seats.length} seats) -> ${path}`)
    return 0
  }
  if (cmd === 'report') {
    process.stdout.write(reportMd(readLedger(path)))
    return 0
  }
  if (cmd === 'convergence') {
    if (!arg) {
      console.error('usage: je-ledger.mjs convergence <bucket>')
      return 2
    }
    const { samples, ratio } = convergence(arg, path)
    // The exact one-line contract readConvergenceEvidence (tournament.mjs) parses; stdout only.
    process.stdout.write(`JE-LEDGER-CONVERGENCE samples=${samples} ratio=${ratio.toFixed(2)}\n`)
    return 0
  }
  console.error('usage: je-ledger.mjs <record <runDir> | report | convergence <bucket>>    (ledger: $JE_LEDGER_PATH or ~/.joust-engine/ledger.jsonl)')
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
