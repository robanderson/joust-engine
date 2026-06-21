# Implementation Plan — Persist Joust Engine review/judge outcomes to disk

**File touched:** `workflows/tournament.mjs` (single file; additive only).
**Contract:** no new agent *type* and no new judge/attempt; no behavior change to the existing flow; negligible perf cost; fully backward-compatible. Only NEW files are written, and a write failure must NEVER crash the (already fully-paid) run.

> **Provenance of this plan.** Synthesised from a two-pass @@JE:8 tournament (2 opus, 2 sonnet, 2 codex-high, 2 minimax). Tournament winner was an Opus plan ("candidate I"); this doc grafts onto it the **verified line-anchors** from the real source and the **atomic-write discipline** of the runner-up — and **corrects one fatal error that every top-ranked plan shared** (see §0). The blind judges could not catch that error because they reasoned from the file's `.mjs` extension, not from the workflow execution sandbox.

---

## 0. CRITICAL — the workflow sandbox has NO `node:fs` (this overrides every "use fs" instinct)

`tournament.mjs` runs inside the dynamic-**workflow** sandbox, not a normal Node process. Empirically probed:

```
typeof process  === 'undefined'
typeof require  === 'undefined'
await import('node:fs')  -> throws "import() is not available in workflow scripts."
Date.now() / Math.random()  -> throw
```

So `writeFileSync`, `mkdirSync`, `renameSync`, `process.pid`, dynamic/static `import` are **all unavailable**. Any plan built on `import { writeFileSync } from 'node:fs'` fails at runtime.

**The engine already tells you the right way.** Every existing filesystem side-effect in `tournament.mjs` is performed by dispatching a **cheap `haiku` agent that runs a Bash script**, never by `fs`:
- `buildContext` (lines 123–130) writes the context bundle via `agent(..., {model:'haiku'})` running `cat … > _context.md`.
- `stageAndValidate` (lines 270–309) copies/stages dirs and builds `_pool.md` the same way.
- `cmdHead` (line 109) writes `_brief.txt` via `printf '%s' <q(content)> > _brief.txt`.

**Decision:** persist via the engine's own primitive — build each file's content as a string in pure JS (string building works fine), then write all files for a persistence point in **one Bash script dispatched to one `haiku` agent**. This vindicates the tournament's last-place "candidate B" on mechanism while keeping the winner's superior structure. It is **not a new agent type** (haiku I/O is already the engine's file-write primitive) and costs ~1–2 extra haiku calls per run — negligible against the multi-minute Opus judge spend.

Atomicity (the runner-up's good idea) is preserved in shell: write to `<path>.partial`, then `mv -f` into place. Writes are **sequential within the single workflow**, so a fixed `.partial` suffix is collision-free — no `Date.now()`/random needed (they'd throw anyway).

---

## 1. The one fact that drives the priority

The staged pools (`review-1/_pool.md`, `review-final/_pool.md`) + the raw candidate dirs already on disk make the **verdict re-derivable** (you could re-run a judge over the preserved pool). The thing that is **not** on disk and **not** re-derivable is the **blind-letter → model mapping** — the decryption key. If the session dies, nothing tells you Candidate B was `glm-5.2`.

**Therefore `mapping.json` is the irreplaceable artifact. Write it FIRST, on every exit path** — including both "no valid pool" early returns and both "judge failed" early returns. Verdict/SUMMARY are valuable but secondary.

---

## 2. The three design questions — decided conclusion-first

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| **Q1** | Also add a run-id collision-breaker (`-<rnd4>`)? | **No — persist only.** | `tournament.mjs` *receives* `runDir` from args (line 30); it never mints the run-id. The collision-breaker belongs in the **caller** that composes the id (the skill orchestrator). Adding it here is out-of-scope and would desync the path the caller expects. File separately. (NB: also `Math.random()` throws in-sandbox, so a suffix literally can't be minted here.) |
| **Q2** | Keep a blind copy of `SUMMARY.md`? | **Yes — write both** `SUMMARY.md` (unblinded) + `SUMMARY.blind.md` (letters-only, genericised failReasons). | `SUMMARY.md` is the *only* new artifact that joins letters→models, so it's the only one that can re-identify. `verdict.*`/`guidance.md`/`mapping.json` need no twin: the first two are blind by construction; `mapping.json` *is* the key. |
| **Q3** | Incremental per-round or once at end? | **Incremental.** | Write round-1 `mapping`+`verdict`+`guidance` **before round-2 dispatch** (the §5 P2 point, before line 371), so a round-2/final crash still leaves round-1 fully recoverable. Surviving a dead session is the whole point. |

---

## 3. Schemas

### 3a. `mapping.json` (the key — persisted verbatim from the in-memory arrays)

```jsonc
{
  "mode": "two",                 // 'single' | 'two'
  "n": 8,                        // attempts per round
  "round1": [                    // = r1mapping (tournament.mjs:354), VERBATIM
    { "candidate": "A", "model": "opus", "valid": true },
    { "candidate": "B", "model": "sonnet", "valid": false, "failReason": "no deliverable saved" }
  ],
  "winner1": "C",                // review.winner (round-1 winner letter); null if review failed/absent
  "final": [                     // two-pass only; OMIT key in single-pass. = finalMapping (:382), VERBATIM
    { "candidate": "A", "model": "codex-high", "round": 2, "valid": true },
    { "candidate": "G", "model": "sonnet", "round": 1, "valid": true }   // round===1 => carried-over R1 winner
  ],
  "winner": "I",                 // overall winner letter (finalRank.winner two-pass; review.winner single); null if failed
  "winnerRound": 2,              // two-pass only; winnerEntry.round (:389); null if unresolved
  "carriedOverWinner": "G"       // two-pass only; finalMapping.find(round===1).candidate; null if none
}
```
- `failReason` is present **only** when `valid:false` (matches source lines 354 & 382: `...(c.valid ? {} : { failReason })`). Persist the arrays **verbatim** — do not rename/re-derive fields.
- Invalid candidates ARE included in `mapping.json` (roster + reason) even though the judge never saw them.
- **Do NOT embed the task text here** (winner I's one con — it bloats the key file; the task lives in SUMMARY).

### 3b. `verdict.json` (verbatim from the reconciled judge object)

`review-1/verdict.json` (round-1, both modes) and `review-final/verdict.json` (two-pass final):

```jsonc
{
  "candidates": [ { "label": "A", "pros": ["…"], "cons": ["…"] } ],  // letters only
  "ranking": ["I","E","H", "…"],   // letters, best first
  "winner": "I",
  "reasoning": "…",
  "guidance": { "positives": ["…"], "challenges": ["…"] }  // present ONLY in review-1 of a TWO-pass run
}                                                          //  (REVIEW_SCHEMA has it; RANK_SCHEMA/single + final do not)
```
Blind by construction (no `displayModel` anywhere) → **no blind/unblind split** for verdict.json/.md.

### 3c. Markdown layouts
- `review-1/verdict.md`, `review-final/verdict.md` — rendered by `verdictToMd()` (§4).
- `review-1/guidance.md` (two-pass only) — `guidanceToMd(review.guidance)`.
- `SUMMARY.md` / `SUMMARY.blind.md` — `summaryMd()` (§4): task, mode/N, round-1 roster table (incl. invalids), round-1 verdict line, (two-pass) final roster table + overall winner + which round it came from, full ranking.

---

## 4. Helpers to add (pure-JS renderers + ONE agent-based writer)

Add after the existing helpers (after `judge`, ~line 342). **No imports.** All string-building; the only side-effect is the single `persist()` agent dispatch.

```js
// ---- durable persistence (sandbox has NO node:fs/import/process — write via haiku+Bash, like buildContext) ----
const json = obj => JSON.stringify(obj, null, 2) + '\n'

// Write ALL files for one persistence point in ONE shell script via ONE cheap haiku agent.
// Atomic per file: printf to <path>.partial then `mv` into place. Sequential writes within the
// single workflow => fixed .partial suffix is collision-free (Date.now()/random throw here anyway).
// Fire-and-forget: a persist failure must never crash a fully-paid run.
async function persist(pairs, phaseTitle) {
  const files = (pairs || []).filter(p => p && p.path && p.content != null)
  if (!files.length) return
  const script = files.map(({ path, content }) => {
    const dir = path.slice(0, path.lastIndexOf('/'))
    const tmp = `${path}.partial`
    return `mkdir -p ${q(dir)} && printf '%s' ${q(content)} > ${q(tmp)} && mv -f ${q(tmp)} ${q(path)}`
  }).join(' && ')
  try {
    await agent(
      `This is an approved internal step of the joust-engine tournament: persist result artifacts. ` +
      `Run this exact shell command in ONE Bash call and report only the exit status. Do nothing else:\n\n${script}`,
      { model: 'haiku', phase: phaseTitle, label: 'persist' }
    )
  } catch (e) { log(`persist failed (${phaseTitle}): ${String(e).slice(0, 140)}`) }
}

// verdict object (blind, letters only): { candidates:[{label,pros,cons}], ranking, winner, reasoning, guidance? }
function verdictToMd(v, title) {
  const L = [`# ${title}`, '', `**Winner:** Candidate ${v.winner}`, '',
    `**Ranking (best first):** ${(v.ranking || []).map(r => `Candidate ${r}`).join(' > ')}`, '',
    `## Reasoning`, '', v.reasoning || '_(none given)_', '', `## Per-candidate`, '']
  for (const c of (v.candidates || [])) {
    L.push(`### Candidate ${c.label}`, '', '**Pros**')
    for (const p of (c.pros || [])) L.push(`- ${p}`); if (!(c.pros || []).length) L.push('- _(none)_')
    L.push('', '**Cons**')
    for (const x of (c.cons || [])) L.push(`- ${x}`); if (!(c.cons || []).length) L.push('- _(none)_')
    L.push('')
  }
  return L.join('\n') + '\n'
}

function guidanceToMd(g) {
  const L = ['# Round-1 guidance (used to steer round 2)', '', '## Positives to emulate']
  for (const p of (g?.positives || [])) L.push(`- ${p}`); if (!(g?.positives || []).length) L.push('- _(none)_')
  L.push('', '## Challenges to avoid')
  for (const c of (g?.challenges || [])) L.push(`- ${c}`); if (!(g?.challenges || []).length) L.push('- _(none)_')
  return L.join('\n') + '\n'
}

// genericise a failReason for the BLIND summary so a provider-specific failure can't re-identify a model
const blindFail = r => r ? 'excluded (did not pass validation)' : r

// SUMMARY renderer. unblind=true => show models; false => letters only + genericised failReasons.
// IMPORTANT: join on the candidate LETTER, never on model (models repeat in Mixed presets like '2 opus').
function summaryMd({ task, mode, n, unblind, r1mapping, r1review, finalMapping, finalRank, winnerRound }) {
  const L = [`# Joust Engine — run summary${unblind ? '' : ' (BLIND)'}`, '',
    `**Mode:** ${mode === 'two' ? 'two-pass' : 'single-pass'}  •  **N (attempts/round):** ${n}`, '',
    '## Task', '', '> ' + String(task).replace(/\n/g, '\n> '), '',
    '## Round-1 candidates', '',
    unblind ? '| Candidate | Model | Valid | Note |' : '| Candidate | Valid | Note |',
    unblind ? '|---|---|---|---|' : '|---|---|---|']
  for (const m of (r1mapping || [])) {
    const note = m.valid ? '' : (unblind ? (m.failReason || '') : blindFail(m.failReason || 'excluded'))
    L.push(unblind ? `| ${m.candidate} | ${m.model} | ${m.valid ? 'yes' : 'NO'} | ${note} |`
                   : `| ${m.candidate} | ${m.valid ? 'yes' : 'NO'} | ${note} |`)
  }
  L.push('')
  const r1join = letter => {
    const m = (r1mapping || []).find(x => x.candidate === letter)
    return unblind && m ? `Candidate ${letter} (${m.model})` : `Candidate ${letter}`
  }
  if (r1review && !r1review.__failed) {
    L.push(mode === 'two' ? '## Round-1 review verdict' : '## Verdict', '',
      `**${mode === 'two' ? 'Round-1 ' : ''}Winner:** ${r1join(r1review.winner)}`, '',
      `**Ranking:** ${(r1review.ranking || []).map(r1join).join(' > ')}`, '')
  }
  if (mode === 'two' && finalMapping) {
    L.push('## Final candidates', '',
      unblind ? '| Candidate | Model | From round | Valid | Note |' : '| Candidate | From round | Valid | Note |',
      unblind ? '|---|---|---|---|---|' : '|---|---|---|---|')
    for (const m of finalMapping) {
      const note = m.valid ? '' : (unblind ? (m.failReason || '') : blindFail(m.failReason || 'excluded'))
      L.push(unblind ? `| ${m.candidate} | ${m.model} | ${m.round} | ${m.valid ? 'yes' : 'NO'} | ${note} |`
                     : `| ${m.candidate} | ${m.round} | ${m.valid ? 'yes' : 'NO'} | ${note} |`)
    }
    L.push('')
    if (finalRank && !finalRank.__failed) {
      const fjoin = letter => {
        const m = finalMapping.find(x => x.candidate === letter)
        return unblind && m ? `Candidate ${letter} (${m.model})` : `Candidate ${letter}`
      }
      const wm = finalMapping.find(x => x.candidate === finalRank.winner)
      L.push('## Overall winner', '', `**Winner:** ${fjoin(finalRank.winner)}`)
      if (wm) L.push(`**Came from round:** ${wm.round}`)
      else if (winnerRound != null) L.push(`**Came from round:** ${winnerRound}`)
      L.push('', `**Final ranking:** ${(finalRank.ranking || []).map(fjoin).join(' > ')}`, '')
    }
  }
  return L.join('\n') + '\n'
}
```

**Carryover correctness (the trap several plans nearly shipped):** the winner's "from round" comes from the **`finalMapping` entry's `round`** (or `winnerEntry.round`, line 389) — the *re-blinded* final letter-space. **Never `champ.blind`**: `champ` (line 368) is round-1 letter-space, and the final pool is re-blinded via `blindLabel(finalPool, 2)` (line 380), so `champ.blind` is wrong there. The carryover finalist is `finalMapping.find(e => e.round === 1)`.

---

## 5. Exact edit points (line anchors VERIFIED against the real source)

> These supersede both the winner's (~off by 1–3) and the runner-up's (~off by 1) anchors. Insert each block **immediately before** the named `return` (and at the P2 incremental point). All content is built in JS, then handed to `persist()`.

The five return sites and the incremental point:

| Pt | Where (verified line) | What to persist |
|----|----------------------|-----------------|
| **P0** | before `return` at **355** (no valid round-1 pool) | `mapping.json` (round1 only, `winner1:null`) + both SUMMARYs |
| **P1** | before `return` at **359** (review judge failed) | same as P0 |
| **P2** | **after 359, before 361** (review valid — runs for BOTH modes, before round-2 dispatch at 371) | `mapping.json` (round1 + `winner1`) + `review-1/verdict.json`+`.md` + `review-1/guidance.md` (two-pass only) |
| **P3** | inside `if (mode==='single')` block (**361–363**), before its `return` | both SUMMARYs (mapping+verdict already written at P2) |
| **P4** | before `return` at **383** (no valid finalists) | `mapping.json` (round1 + final, `winner:null`, `carriedOverWinner`) + both SUMMARYs |
| **P5** | before `return` at **386** (final-rank judge failed) | same as P4 |
| **P6** | after `winnerEntry` (**389**), before the final `return` (**390–395**) | `mapping.json` (full) + `review-final/verdict.json`+`.md` + both SUMMARYs |

Normal completed two-pass run fires **P2 + P6 = two haiku calls**. Single-pass fires **P2 + P3**. Early-return points fire only on failure.

### Concrete inserts

```js
// runDir, mode, attempts, task are all top-level consts already in scope.
const N = attempts.length

// ---- P0 : before line 355 `if (!blind1.length) return …` ----
await persist([
  { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: null,
      ...(mode === 'two' ? { winner: null } : {}) }) },
  { path: `${runDir}/SUMMARY.md`,       content: summaryMd({ task, mode, n: N, unblind: true,  r1mapping }) },
  { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping }) },
], 'Review')

// ---- P1 : before line 359 `if (review.__failed) return …` ----  (same payload as P0)

// ---- P2 : AFTER line 359, BEFORE line 361 (review is valid here, both modes) ----
await persist([
  { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: review.winner }) },
  { path: `${runDir}/review-1/verdict.json`, content: json(review) },
  { path: `${runDir}/review-1/verdict.md`,   content: verdictToMd(review, 'Round-1 review verdict') },
  ...(review.guidance ? [{ path: `${runDir}/review-1/guidance.md`, content: guidanceToMd(review.guidance) }] : []),
], 'Review')

// ---- P3 : inside the single-pass block, before `return { … }` ----
if (mode === 'single') {
  await persist([
    { path: `${runDir}/SUMMARY.md`,       content: summaryMd({ task, mode, n: N, unblind: true,  r1mapping, r1review: review }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review }) },
  ], 'Review')
  return { mode, n: N, round1: { mapping: r1mapping, review } }
}

// ---- P4 : before line 383 `if (!blindF.length) return …` ----
//      P5 : before line 386 `if (finalRank.__failed) return …`  (identical payload; no finalRank to render)
{
  const carriedOverWinner = (finalMapping.find(e => e.round === 1) || {}).candidate ?? null
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: review.winner,
        final: finalMapping, winner: null, winnerRound: null, carriedOverWinner }) },
    { path: `${runDir}/SUMMARY.md`,       content: summaryMd({ task, mode, n: N, unblind: true,  r1mapping, r1review: review, finalMapping }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping }) },
  ], 'Final rank')
}

// ---- P6 : after line 389 `const winnerEntry = …`, before the final return ----
{
  const carriedOverWinner = (finalMapping.find(e => e.round === 1) || {}).candidate ?? null
  await persist([
    { path: `${runDir}/mapping.json`, content: json({ mode, n: N, round1: r1mapping, winner1: review.winner,
        final: finalMapping, winner: finalRank.winner,
        winnerRound: winnerEntry ? winnerEntry.round : null, carriedOverWinner }) },
    { path: `${runDir}/review-final/verdict.json`, content: json(finalRank) },
    { path: `${runDir}/review-final/verdict.md`,   content: verdictToMd(finalRank, 'Final rank verdict') },
    { path: `${runDir}/SUMMARY.md`,       content: summaryMd({ task, mode, n: N, unblind: true,  r1mapping, r1review: review, finalMapping, finalRank, winnerRound: winnerEntry ? winnerEntry.round : null }) },
    { path: `${runDir}/SUMMARY.blind.md`, content: summaryMd({ task, mode, n: N, unblind: false, r1mapping, r1review: review, finalMapping, finalRank, winnerRound: winnerEntry ? winnerEntry.round : null }) },
  ], 'Final rank')
}
```

---

## 6. Final on-disk layout

```
<runDir>/
  mapping.json                 # the KEY — written on every exit path (UNBLINDED)
  SUMMARY.md                   # unblinded one-screen summary
  SUMMARY.blind.md             # blind twin (genericised failReasons)
  review-1/
    _pool.md                   # (existing) judge input
    verdict.json / verdict.md  # round-1 verdict (blind by construction)
    guidance.md                # two-pass only
    A/ B/ …                    # (existing) staged candidate dirs
  review-final/                # two-pass only
    _pool.md                   # (existing)
    verdict.json / verdict.md  # final-rank verdict
    A/ B/ …                    # (existing) re-blinded staged dirs
```

---

## 7. Edge cases

**Single vs two-pass**

| Artifact | single | two |
|---|---|---|
| `mapping.json` | round1 + winner1 + winner | round1 + winner1 + final + winner + winnerRound + carriedOverWinner |
| `review-1/verdict.*` | yes (no `guidance`) | yes (incl. `guidance`) |
| `review-1/guidance.md` | **no** | yes |
| `review-final/verdict.*` | **no** | yes |
| `SUMMARY.md` / `.blind.md` | yes | yes |

Guard `guidance.md` on `if (review.guidance)` — single-pass uses RANK_SCHEMA (no guidance field).

**Invalid candidates (`valid:false`)** — excluded from `verdict.json` (the in-memory `review.candidates` only contains validated letters, so verbatim persistence already excludes them — don't re-add); included in `mapping.json` + SUMMARY roster with `failReason` (genericised in the blind copy).

**Empty valid pool** — P0 (no round-1) / P4 (no finalists) still write `mapping.json` + SUMMARYs; the key lands even with nothing judged.

**Crash mid-run**

| Crash point | On disk afterward |
|---|---|
| during round-1 dispatch (before staging) | nothing new (no outcome exists yet — acceptable) |
| no-valid-round-1 path (P0) | `mapping.json`(round1) + SUMMARYs |
| **after review, before/within round-2 (P2 ran)** | `mapping.json`(round1+winner1) + `review-1/verdict.*` + `guidance.md` — **round-1 fully recoverable** |
| during final-rank | as above (round-1 intact); `review-final/` may hold `_pool.md` only |
| normal completion | everything in §6 |

P2 (runs before round-2 dispatch at line 371) is what makes the round-2-crash row recoverable — the concrete payoff of the Q3 "incremental" decision.

**Persist itself fails (disk full / agent error)** — `persist()` is `try/catch` + `log()` only; the run's return value is unchanged. No new throw path; "additive-only" holds. Atomic `mv` means a reader never sees a torn file.

**Shell `ARG_MAX`** — content is `printf '%s' <single-quoted>`, so the whole script must fit the command line (~256 KB on macOS). Verdict/summary are a few KB; fine. If a future verdict's `reasoning` ever approached this, split that file into its own `persist()` call (the batching already isolates per-point).

---

## 8. Implementer checklist
- [ ] **No `import`/`require`/`fs`/`process`/`Date.now`/`Math.random`** anywhere added (they throw in-sandbox).
- [ ] All writes go through `persist()` (haiku+Bash), atomic via `.partial` → `mv`.
- [ ] `mapping.json` written on all five exit paths (P0,P1,P4,P5,P6) + the P2 incremental.
- [ ] Carryover "from round" read from `finalMapping`/`winnerEntry.round`, **never `champ.blind`**.
- [ ] `verdict.json` is the verbatim judge object (`guidance` only in two-pass review-1).
- [ ] Blind SUMMARY hides models AND genericises `failReason`; join on candidate **letter**, not model.
- [ ] `runDir`/run-id untouched (Q1).
- [ ] `persist()` swallows + logs every error (grep for any bare write outside it).
- [ ] Smoke: run a single-pass N=2 and a two-pass N=2; confirm files appear and `mapping.json` round-trips.

---

## Unresolved questions
- Run-id collision-breaker: confirm it's filed as a **caller-side** (skill orchestrator) ticket, not done here.
- `persist()` adds 1–2 haiku calls/run — acceptable, or fold the P2 mapping write into the existing `stageAndValidate` haiku call to save one dispatch (mild coupling cost)?
- Persist a `{__failed}` stub `verdict.json` on judge failure for forensic completeness, or skip (current plan skips — mapping+SUMMARY already record the failure)?
- Want a tiny `bin/je-unblind.mjs` reader later (pretty-print `mapping.json` + `verdict.json` for an old run dir), or is the on-disk markdown enough?
