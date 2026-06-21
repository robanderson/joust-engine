# Implementation Plan — Add Moonshot **Kimi K2.6** to the Joust Engine model roster

**Scope:** add Moonshot AI's **Kimi K2.6** (`kimi.com`, served via Moonshot's
Anthropic-compatible endpoint) as a **seventh** provider, exposing one model the
operator asks for — `kimi-k2.6` — selectable per-attempt exactly like GLM and
MiniMax.

This is a **design** deliverable: file-by-file changes, exact wiring points, and a
validation checklist for every UNCONFIRMED fact. No production code is written here.

Kimi K2.6 is closest to **MiniMax** of all the existing peers: an Anthropic-compatible
endpoint reached by pointing the `claude` CLI at it via `ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN`, one model, an env-key credential, both per-attempt guards
(`--max-turns` + wall-clock). It is **not** codex/grok-shaped (no external non-`claude`
CLI, no file-based auth). So the right sibling to copy is **`minimax-run.sh`**, and the
GLM-shape `FLAG` map / the codex/grok auth idioms are deliberately **not** copied.

---

## Core question: can Kimi K2.6 be integrated like GLM and MiniMax?

**Yes — by construction.** Moonshot exposes an Anthropic-compatible API, so the
existing pattern works unchanged: the runner points the `claude` CLI at the endpoint
with `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` and the attempt is selected per
attempt in Claude Code by running that nested `claude -p` call. The wrapper-agent
indirection (benign `bash <runner>` command) keeps the LLM driver from solving the task
itself, exactly as for GLM/MiniMax.

The three values the brief asks for, **with calibrated confidence** (web verification
was unavailable in this pass, so each carries an explicit pre-merge validation step
in §10):

| Fact | Best-known value | Confidence | How to confirm (validation step) |
|------|------------------|------------|-----------------------------------|
| **Anthropic-compatible base URL** | `https://api.moonshot.ai/anthropic` | **medium-high** — Moonshot documents an Anthropic-compat path; the `/anthropic` suffix is the convention (MiniMax uses `/anthropic`, z.ai uses `/api/anthropic`). | **V1**: `curl -s https://api.moonshot.ai/anthropic/v1/messages -H "x-api-key: $MOONSHOT_API_KEY" -H "anthropic-version: 2023-06-01" -d '{"model":"<id>","max_tokens":8,"messages":[{"role":"user","content":"OK"}]}'` returns a 200 + content. If 404, try `https://api.moonshot.ai/anthropic` vs a regional host; see fallback note below. |
| **Auth env-var (native key name)** | `MOONSHOT_API_KEY` | **high** — the documented Moonshot key variable (native OpenAI-compat endpoint uses it). The runner reads it from the env and copies it into `ANTHROPIC_AUTH_TOKEN`, exactly as `minimax-run.sh` reads `MINIMAX_API_KEY`. | **V2**: the operator's `~/.zshrc` already exports `MOONSHOT_API_KEY` (same place `ZAI_API_KEY`/`MINIMAX_API_KEY` live); `echo "${MOONSHOT_API_KEY:?missing}"` succeeds in a fresh shell. |
| **Kimi K2.6 model id** | **UNKNOWN — best guess `kimi-k2.6`** (alt spellings `kimi-k2-6`, `kimi-k2.6-…`). I do **not** assert this. Moonshot's K2 line has shipped ids like `kimi-k2-0905-preview` / `kimi-k2-turing`; a "K2.6" id in mid-2026 is plausible but its exact spelling is unverified. | **low** — must be discovered. | **V3 (this is the critical pre-merge gate)**: list live model ids and grep for kimi: `curl -s https://api.moonshot.ai/v1/models -H "Authorization: Bearer $MOONSHOT_API_KEY" \| jq -r '.data[].id' \| grep -i kimi`. The real id replaces the literal everywhere (§1.3, §3.1, §4, docs). Because the design keeps the wire id in **one literal + one NORMALISER map key** and decouples the display token (`kimi-k2.6`) from it, a wrong guess is a one-line correction, never structural rework. |

> **Why the endpoint is a fixed literal and the model id is isolated:** the staging
> validator greps `^JOUST-KIMI-PROVENANCE endpoint=` (it does **not** pin the
> endpoint *value*), so the `model=` suffix may vary freely. The endpoint string itself
> is baked into the provenance literal once and into the orchestration docs — stable.

**Fallback if `api.moonshot.ai/anthropic` is wrong (V1):** Moonshot may serve the
Anthropic-compat surface at a different path or regional host. The runner sources the
base URL from a single env-overridable constant (§1.1), so flipping it is one line.
Do **not** ship a guessed host baked into multiple places.

---

## 0. Design decisions up front (the two judgement calls the brief asks for)

### 0.1 Single-model, MiniMax-shape — NOT a GLM-shape FLAG map

**Decision: Kimi is single-model (like MiniMax): one `ANTHROPIC_MODEL` pin, no
`--model` flag, one generic `joust-kimi` agent.** The operator asked for **one**
model — "Kimi K2.6". MiniMax is the exact precedent: one model (`MiniMax-M3`), all
opus/sonnet/haiku aliases collapse to it, `ANTHROPIC_MODEL` pins it, no `--model` flag.

The GLM-shape (`GLM_FLAG` map of `--model opus/sonnet/haiku` aliases) exists only
because GLM's `claude` `--model` aliases are **not** the GLM model name — the per-model
stub is where that opaque mapping is pinned. Kimi has no such indirection to expose
(one model ⇒ `ANTHROPIC_MODEL` pins it directly), so a `KIMI_FLAG` map would be empty
machinery. **This is the "copy the peer that matches the auth/model shape and DON'T
copy idioms the closest peer deliberately omits" rule:** copy `minimax-run.sh`
(env-key + `ANTHROPIC_MODEL` pin); do **not** copy GLM's `FLAG` map or its four
per-model agent stubs.

**Consequence:** `displayModel` is always `kimi-k2.6`; `agentType` is always
`joust-engine:joust-kimi`; the `dispatch:'kimi'` branch (§3.4) passes **no
flag** (empty string), mirroring the minimax branch exactly.

**If more Kimi variants are wanted later** (e.g. a `kimi-k2.6-thinking`), promote to
the GLM shape then: add a `KIMI_FLAG` map and switch from `ANTHROPIC_MODEL` pin to a
`--model` flag. Out of scope now — see open question §12.

### 0.2 displayModel token decoupled from the wire id

The internal/report token is **`kimi-k2.6`** regardless of the real API id (which may
be `kimi-k2-6` or a preview-suffixed string). The normaliser maps every prose spelling
to `kimi-k2.6`; the runner independently resolves `kimi-k2.6` → wire id via **one
literal** (§1.3). So a V3 correction to the wire id never touches the parser, the
workflow, the agent, or the docs — it is one line in `kimi-run.sh`.

---

## 1. NEW FILE — `bin/kimi-run.sh`

A peer of `bin/minimax-run.sh` (the closest sibling — Anthropic-compat endpoint via
`claude`, env-key auth, `ANTHROPIC_MODEL` pin, both guards). Same skeleton; kimi-specific
endpoint, key, model, provenance.

### 1.1 Header + knobs (mirror minimax-run.sh)

```sh
#!/usr/bin/env bash
# Joust Engine KIMI attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on Moonshot Kimi K2.6 via the Claude CLI
# pointed at Moonshot's Anthropic-compatible endpoint, under a hard wall-clock timeout.
# Kimi (like MiniMax) exposes the requested model via ANTHROPIC_MODEL — no --model flag.
# Usage: kimi-run.sh [extra claude flags...]
# Timeout (seconds) from JE_TIMEOUT_SECS (default 600); max-turns from JE_MAX_TURNS (default 30).
set -uo pipefail
FLAG="${*:-}"
LOG=_kimi_run.log
TIMEOUT="${JE_TIMEOUT_SECS:-600}"   # wall-clock backstop (seconds)
MAXTURNS="${JE_MAX_TURNS:-30}"      # PRIMARY guard: cap agentic iterations (single-pass)

# The Anthropic-compatible base URL. Env-overridable so V1 (host/path) is a one-line fix
# without touching provenance literal or docs. Default = Moonshot's documented /anthropic path.
KIMI_BASE_URL="${KIMI_BASE_URL:-https://api.moonshot.ai/anthropic}"
```

Notes:
- **Default timeout 600s, not 300.** Kimi K2.6 is a frontier model that, like grok/glm
  on heavy multi-file builds, benefits from a roomier backstop. The per-attempt
  `kimiTimeoutSecs` knob (§3.3) overrides it. (MiniMax used 300; Kimi gets the roomier
  600 default consistent with grok/codex. Confirm size against real latency in V4.)
- **`--max-turns` default 30**, the glm/minimax default — the primary guard; wall-clock
  is the backstop.
- `KIMI_BASE_URL` is the **only** place the host lives, so the V1 fallback is one env
  var / one literal, never a multi-file change.

### 1.2 Key handling — uniform env-key pattern (mirror minimax-run.sh)

```sh
# MOONSHOT_API_KEY comes from the environment — exactly like minimax-run.sh reads
# MINIMAX_API_KEY and glm-run.sh reads ZAI_API_KEY. The user's ~/.zshrc exports it
# (alongside ZAI_API_KEY / MINIMAX_API_KEY / OMLX_AUTH_TOKEN) and the Claude Code
# session inherits it at launch. If it is missing, the session predates the export:
# relaunch from a shell that has it. Do NOT add bespoke key-loading (sourcing/grepping
# rc files) here — keep every provider runner uniform.
if [ -z "${MOONSHOT_API_KEY:-}" ]; then echo "JOUST-KIMI-ERROR MOONSHOT_API_KEY missing (export in ~/.zshrc and relaunch)" | tee -a "$LOG"; exit 3; fi
[ -f _brief.txt ] || { echo "JOUST-KIMI-ERROR _brief.txt missing" | tee -a "$LOG"; exit 4; }
```

> **Why `MOONSHOT_API_KEY` (native name), not a renamed var:** the established pattern
> (GLM `ZAI_API_KEY`, MiniMax `MINIMAX_API_KEY`, local `OMLX_AUTH_TOKEN`) is to use each
> provider's **own documented** key name. `MOONSHOT_API_KEY` is Moonshot's. Renaming it
> would be a subtle convention break with no upside.

### 1.3 Model id — the one literal (the V3 correction point)

```sh
# The Kimi K2.6 wire id. UNCONFIRMED (V3) — replace with the real id from
# `curl https://api.moonshot.ai/v1/models | jq -r '.data[].id'` (grep kimi). Isolated
# here so a correction never touches the parser/workflow/agent/docs.
KIMI_MODEL="${KIMI_MODEL:-kimi-k2.6}"
```

### 1.4 PROVENANCE marker (unconditional, up front)

```sh
echo "JOUST-KIMI-PROVENANCE endpoint=api.moonshot.ai model=${KIMI_MODEL} max-turns=${MAXTURNS} timeout=${TIMEOUT}s" >> "$LOG"
```

Write **unconditionally at startup** — a missing log at this path proves the runner
never ran (native-solve spoof / refusal) and must fail closed (P=0) downstream. Column-0
+ provider-specific token so the staging validator's `^JOUST-KIMI-` grep is
mention-proof (an attempt whose deliverable merely *discusses* a marker cannot
false-trip its own validation).

### 1.5 The invocation (mirror minimax-run.sh exactly, minus the auto-compact hardcode)

```sh
# Portable hard timeout (no coreutils `timeout` on macOS): fork the call, SIGALRM -> TERM/KILL.
# </dev/null pins claude's stdin: with a prompt ARG but an OPEN (non-TTY) stdin, claude warns
# "no stdin data received in 3s" and can STALL the entire wall-clock producing nothing (the bug
# that hit glm/codex/minimax). Close stdin here and never rely on the caller.
ANTHROPIC_BASE_URL="$KIMI_BASE_URL" \
ANTHROPIC_AUTH_TOKEN="$MOONSHOT_API_KEY" \
ANTHROPIC_MODEL="$KIMI_MODEL" \
ANTHROPIC_DEFAULT_OPUS_MODEL="$KIMI_MODEL" \
ANTHROPIC_DEFAULT_SONNET_MODEL="$KIMI_MODEL" \
ANTHROPIC_DEFAULT_HAIKU_MODEL="$KIMI_MODEL" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
API_TIMEOUT_MS="3000000" \
perl -e '
  my $t = shift @ARGV;
  my $p = fork; if (!defined $p) { exit 127 }
  if ($p == 0) { exec @ARGV; exit 127 }
  $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
  alarm $t; waitpid($p, 0); exit($? >> 8);
' "$TIMEOUT" claude -p "$(cat _brief.txt)" $FLAG --max-turns "$MAXTURNS" --permission-mode acceptEdits --allowedTools "Bash Read Write Edit" </dev/null >> "$LOG" 2>&1
RC=$?
[ "$RC" -eq 124 ] && echo "JOUST-KIMI-TIMEOUT secs=${TIMEOUT}" >> "$LOG"
echo "JOUST-KIMI-DONE exit=$RC" >> "$LOG"
tail -20 "$LOG"
```

> **Deliberately OMITTED vs minimax-run.sh: `CLAUDE_CODE_AUTO_COMPACT_WINDOW="512000"`.**
> MiniMax hardcodes its 512K context window there. Kimi K2.6's context window is
> **unconfirmed** (likely 256K; possibly 200K/1M) — baking an optimistic guess would
> contradict the "flag it unconfirmed" stance (an internal contradiction the priors
> flag as a real pitfall). **Omit until confirmed** (V5). If V5 confirms a value, add
> `CLAUDE_CODE_AUTO_COMPACT_WINDOW="<N>000"` here as a one-line follow-up. Omitting it
> is safe: `claude` falls back to its own default window.

> **Deliberately OMITTED vs grok/codex-run.sh: the defensive error-grep.** That
> `grep -qiE '401|invalid api key|…'` fail-closed guard exists only on the
> **file-auth / external-CLI** peers (codex reads `~/.codex/auth.json`; grok reads
> `~/.grok/auth.json`) where a soft failure can wrongly exit 0. Kimi, like
> glm/minimax, is an env-key `claude` call whose auth failures surface as a nonzero
> `claude` exit that the `DONE exit=0` gate already catches — so the grep would be
> cargo-culted from the wrong sibling. (If a real soft-failure mode is observed in V6,
> add it then.)

### 1.6 `_kimi_run.log` contract (what the validator greps)

```
JOUST-KIMI-PROVENANCE endpoint=api.moonshot.ai model=kimi-k2.6 max-turns=30 timeout=600s
… claude output …
JOUST-KIMI-TIMEOUT secs=600        (only if it timed out)
JOUST-KIMI-ERROR …                 (only on the missing-key/_brief paths)
JOUST-KIMI-DONE exit=0
```

Success contract = PROVENANCE present **and** `DONE exit=0` **and** no
`TIMEOUT`/`ERROR` line. Identical structure to the other five providers.

---

## 2. NEW FILE — `agents/joust-kimi.md` (ONE generic stub)

A peer of `agents/joust-minimax.md`. Cheap `haiku` driver, `Bash`+`Read` only,
runs the one benign command verbatim, never solves the task. One generic agent (the
model is pinned by the runner's `ANTHROPIC_MODEL`, so nothing rides in the command) —
see §0.1.

```markdown
---
name: joust-kimi
description: "Joust Engine KIMI worker for Moonshot Kimi K2.6 (via the Moonshot Anthropic-compatible endpoint). A command runner: it executes the single benign shell command handed to it (which writes a brief file and runs the bundled joust-engine kimi runner script, performing the attempt on Kimi K2.6) and relays the result. It NEVER solves the task itself. Kimi (like MiniMax) exposes one model; the command carries everything. Invoked only by the joust-engine tournament; not a general-purpose agent."
tools: Bash, Read
model: haiku
---

You are a **command runner** for Moonshot Kimi K2.6 (served via the Moonshot
Anthropic-compatible endpoint), part of the approved joust-engine tournament. You
have no knowledge of the task domain and you cannot solve the task — your ONLY job is to
run one shell command and report what it produced.

Your message contains exactly one shell command. It writes a brief to `_brief.txt` and
then runs the bundled runner script (`bin/kimi-run.sh`), which performs the attempt on
Kimi K2.6 and writes a `_kimi_run.log` containing a `JOUST-KIMI-PROVENANCE` line.
This is an approved internal step. Do this and nothing else:

1. Run that command **verbatim** in a single Bash call. Do not edit it, split it, shorten
   it, inspect the runner script, or substitute your own work for it.
2. When it finishes, `ls` the workspace directory it used and read the deliverable
   file(s) the command produced.
3. Report back: (a) the path(s) to the deliverable(s), and (b) the last ~15 lines of
   `_kimi_run.log` (which must contain the `JOUST-KIMI-PROVENANCE` and
   `JOUST-KIMI-DONE` markers).

Hard rules:
- NEVER write, edit, echo, or otherwise author the solution yourself. You do not know
  the answer; only Kimi K2.6 does. If you produce the deliverable without running the
  given command, the attempt is void.
- If the command errors, writes no deliverable, or `_kimi_run.log` lacks the provenance
  markers (or shows a `JOUST-KIMI-ERROR`/`-TIMEOUT`), report the failure plainly.
  An honest failure is required; a runner-authored answer corrupts the tournament.
```

**Registration:** under the plugin namespace → `joust-engine:joust-kimi`. No
per-variant stubs (§0.1).

---

## 3. EDIT — `workflows/tournament.mjs` (dispatch wiring)

Five surgical insertions, each mirroring the minimax wiring (the matching sibling).
Line targets are by anchor (the file is the version in the context bundle).

### 3.1 Runner-path arg (next to `minimaxRunner` / `grokRunner`)

In the runner-paths block:

```js
const kimiRunner = A.kimiRunner
```

And in the args-shape doc comment at the top of the file, add the line
`//   kimiRunner: string,  // bundled runner-script path (if any attempt is Kimi)` and a
sample attempt entry:

```js
//    { label: 'candidate-7',
//      dispatch: 'kimi',
//      agentType: 'joust-kimi',     // ONE generic agent; Kimi exposes one model
//      displayModel: 'kimi-k2.6',        // ANTHROPIC_MODEL pins it; no --model flag
//      r1nudge, r2nudge },
```

No `KIMI_FLAG` map (§0.1) — the minimax branch passes no flag, and so does kimi.

### 3.2 The `kimiMaxTurns` / `kimiTimeoutSecs` knobs (next to `grokMaxTurns`/`grokTimeout`)

```js
// Kimi (Moonshot, Anthropic-compatible endpoint via claude) reuses the minimax-style guards:
// BOTH --max-turns (kimiMaxTurns, default = glmMaxTurns 30) and a wall-clock backstop. Override
// the wall clock via args.kimiTimeoutSecs (Kimi K2.6 is a frontier model; default 600, roomier
// than minimax's 300, consistent with grok/codex).
const kimiMaxTurns = Number(A.kimiMaxTurns) > 0 ? Math.floor(Number(A.kimiMaxTurns)) : glmMaxTurns
const kimiTimeout  = Number(A.kimiTimeoutSecs) > 0 ? Math.floor(Number(A.kimiTimeoutSecs)) : 600
```

Both flow through the **standard** `runnerCmd(runner, flag, ws, b, maxTurns, timeout)`
helper (it has both guards) — `flag` is `''`, mirroring the minimax branch.

### 3.3 The `dispatch:'kimi'` branch (in `dispatch()`)

Add a branch alongside `else if (a.dispatch === 'minimax')`. It is **byte-for-byte the
minimax shape** (no `--model` flag; `ANTHROPIC_MODEL` pins the model inside the runner):

```js
} else if (a.dispatch === 'kimi') {
  opts.agentType = nsAgent(a.agentType) // joust-kimi (one generic agent; Kimi exposes one model)
  // No --model flag: the runner's ANTHROPIC_MODEL pins Kimi K2.6 (mirrors minimax exactly).
  if (!kimiRunner) {
    log(`attempt ${a.label} (${a.displayModel}) skipped: kimiRunner not supplied (pass args.kimiRunner pointing to bin/kimi-run.sh)`)
    return null
  }
  const cmd = runnerCmd(kimiRunner, '', ws, b, kimiMaxTurns, kimiTimeout) // BOTH guards, no flag
  prompt = RUNVERBATIM(cmd, ws, '_kimi_run.log')
```

### 3.4 The staging/provenance validator (in `stageAndValidate`)

Three one-token additions so the validator is provider-specific and line-anchored
(`^JOUST-KIMI-…`), per the engine's mention-proof rule.

a) **Log-filename selection:**

```js
const log = c.dispatch === 'glm' ? '_glm_run.log'
          : c.dispatch === 'local' ? '_local_run.log'
          : c.dispatch === 'codex' ? '_codex_run.log'
          : c.dispatch === 'minimax' ? '_minimax_run.log'
          : c.dispatch === 'grok' ? '_grok_run.log'
          : c.dispatch === 'kimi' ? '_kimi_run.log'            // <-- ADD
          : ''
```

b) **Provenance token:**

```js
const tok = c.dispatch === 'glm' ? 'GLM'
          : c.dispatch === 'local' ? 'LOCAL'
          : c.dispatch === 'codex' ? 'CODEX'
          : c.dispatch === 'minimax' ? 'MINIMAX'
          : c.dispatch === 'grok' ? 'GROK'
          : c.dispatch === 'kimi' ? 'KIMI'                     // <-- ADD
          : ''
```

c) **The stage `rm -f` cleanup line** — add `_kimi_run.log` to the engine-file delete
list so it is stripped before pooling (it names the provider/model and would leak
identity to the blind judge):

```js
rm -f …/_minimax_run.log …/_grok_run.log ${q(dest)}/_kimi_run.log; …
```

d) **The `engineFiles` array** (the repoMode worktree exclude/snapshot list) — add
`'_kimi_run.log'` so repoMode staging strips/captures it like the other engine logs:

```js
const engineFiles = ['_brief.txt', '_glm_run.log', '_local_run.log', '_codex_run.log', '_codex_last.txt', '_minimax_run.log', '_grok_run.log', '_kimi_run.log']
```

`provCheckShell(log, tok, lp, carriedOver)` is **unchanged** — with `tok='KIMI'` it
already builds:

```
grep -q '^JOUST-KIMI-PROVENANCE endpoint=' …
  && grep -q '^JOUST-KIMI-DONE exit=0' …
  && ! grep -q '^JOUST-KIMI-\(TIMEOUT\|ERROR\)' …
```

So the runner's column-0 markers in §1.4/§1.5 satisfy the success contract
automatically. No change to `provCheckShell`, the carryover logic, the schema, or
`reconcile`.

---

## 4. EDIT — `bin/je-parse.mjs` (parser recognition)

So prose specs like `2 kimi`, `1 kimi-k2.6`, `3 kimi k2.6` are selectable and map to
the `kimi-k2.6` displayModel.

### 4.1 `NORMALISER` entries

Add a kimi block after the Grok block. Bare `kimi` defaults to `kimi-k2.6` (the only
Kimi model on the roster).

```js
// Kimi (Moonshot, via Moonshot's Anthropic-compatible endpoint). ONE model (Kimi K2.6),
// MiniMax-shaped. Bare 'kimi' defaults to kimi-k2.6.
'kimi':        { model: 'kimi-k2.6', dispatch: 'kimi' },
'kimi k2.6':   { model: 'kimi-k2.6', dispatch: 'kimi' },
'kimi k2 6':   { model: 'kimi-k2.6', dispatch: 'kimi' },
'kimi-k2.6':   { model: 'kimi-k2.6', dispatch: 'kimi' },
'kimi-k2-6':   { model: 'kimi-k2.6', dispatch: 'kimi' },
```

> The normaliser's existing `dashToSpace`/`spaceToDash` fallbacks (in `normaliseModel`)
> also catch `kimi k2.6` <-> `kimi-k2.6` for free, so only the canonical + the most
> likely prose spellings are enumerated.

**Collision reasoning (the "don't match ordinary task prose" pitfall):** `kimi` is a
brand word unlikely to appear as `<digit> kimi` in task prose, so a bare `kimi` alias is
safe (same bar MiniMax's bare `m3` and grok's bare `composer` cleared). I deliberately
do **NOT** add a bare version-fragment alias `k2.6` / `k2 6` on its own: `<digit> k2.6`
is a realistic collision shape (and a bare fragment is riskier than MiniMax's `m3`), so
the parser surface is kept to the `kimi`-prefixed spellings only.

### 4.2 `MODEL_TOKEN_RX` (the spec-scan recogniser)

Add a kimi alternative so `locateSpec`/`expandSpec` capture the **whole** token (the
version digits must be captured, like glm's `[0-9](?:\.[0-9])?`). Insert near the
minimax alternative:

```js
const MODEL_TOKEN_RX =
  '(?:' +
    'codex(?:\\s*-?\\s*(?:low|medium|high|xhigh|x-?high|extra\\s*high))?' +
    '|grok(?:\\s*-?\\s*(?:build|code|composer(?:\\s*-?\\s*2\\.5(?:\\s*-?\\s*fast)?)?))?' +
    '|composer(?:\\s*-?\\s*2\\.5(?:\\s*-?\\s*fast)?)?' +
    '|glm(?:\\s*-?\\s*[0-9](?:\\.[0-9])?)?(?:\\s*-?\\s*air)?' +
    '|opus|sonnet|haiku' +
    '|minimax(?:\\s*-?\\s*m3)?|m3' +
    // kimi: 'kimi', 'kimi k2.6', 'kimi-k2-6' — capture the version (2.6 / 2 6) with the token
    '|kimi(?:\\s*-?\\s*k?2[\\s.-]?6)?' +
  ')';
```

> The `kimi…` alternative is intentionally a single branch: it captures `kimi` bare OR
> `kimi` + a `k2.6`/`2.6`/`2 6`/`2-6` suffix as one token, so `1 kimi k2.6` is one item,
> not `kimi` + a stray `2.6`.

### 4.3 The "Known:" error string

Add kimi to the unrecognised-token help text so a typo lists kimi as a known family:

```js
'Known: opus, sonnet, haiku, glm[-5.2/5.1/4.7/4.5-air], codex[-low/medium/high/xhigh], ' +
'minimax-m3, grok[-build]/grok-composer-2.5-fast, kimi-k2.6, or a live local id. Re-state the spec …'
```

### 4.4 NOT changed

- `TOP_MIXED_POOL` stays `['opus', 'glm-5.2', 'codex-high']` — kimi is opt-in via an
  explicit spec / the Phase 1 menu, not folded into Top Mixed (changing the preset
  would silently alter every `top mixed` run's cost/identity).
- `Z_MAX`/`N_MAX`, the conflict logic, `stripAll` — untouched. `stripAll` re-uses
  `MODEL_TOKEN_RX`, so once §4.2 lands, kimi spec text is stripped from the task body
  for free.

**displayModel mapping summary:**

| Prose | normaliser `model` (= displayModel) | runner pin |
|---|---|---|
| `kimi`, `kimi k2.6`, `kimi-k2-6` | `kimi-k2.6` | `ANTHROPIC_MODEL=kimi-k2.6` (V3 → real wire id) |

---

## 5. EDIT — `skills/joust-engine/SKILL.md` + `references/orchestration.md`

### 5.1 `SKILL.md` Phase 1 menu — an eleventh option

The menu is currently ten options. Add an eleventh (kimi) and update the "ten option"
wording to "eleven option":

```
> 11. Kimi — Moonshot Kimi K2.6 via the bundled kimi runner (Anthropic-compatible endpoint)
```

And the handler, mirroring **Option 9 (MiniMax)** — no sub-menu (one model), then stop:

```
- **Option 11 (Kimi):** every attempt uses `kimi-k2.6`, dispatched via the bundled
  `bin/kimi-run.sh` through the `joust-engine:joust-kimi` agent. Record the
  uniform assignment, e.g. for N = 4: `[kimi-k2.6, kimi-k2.6, kimi-k2.6, kimi-k2.6]`.
  Treat it like the other single-model runner providers (its own `_kimi_run.log`
  provenance marker, same honest-failure handling). Optionally run a one-line liveness
  probe first so a missing `MOONSHOT_API_KEY` / wrong endpoint / wrong model id doesn't
  waste a round (see §10 V1/V3). Kimi bills your Moonshot plan; it has a turn cap, so it
  uses both guards (max-turns + wall-clock). For heavy multi-file builds raise
  `kimiTimeoutSecs`.
```

Update **Option 2 (Specify Mix)** to offer the kimi id in the per-attempt loop:
"…minimax-m3, the two grok variants (grok-build / grok-composer-2.5-fast), **and
kimi-k2.6**…".

### 5.2 `SKILL.md` Phase 2 dispatch paragraph

Add kimi to the runner-list sentence and the args note: "…`grokRunner` =
`<plugin-root>/bin/grok-run.sh` if any attempt is Grok, **`kimiRunner` =
`<plugin-root>/bin/kimi-run.sh` if any attempt is Kimi, `kimiTimeoutSecs` = the Kimi
wall-clock backstop (default 600); kimi ALSO honours `attemptMaxTurns`/`kimiMaxTurns`
(default 30) since `claude` has `--max-turns`** …". And in the "attempts run through"
sentence: "…**Kimi attempts run through the single `joust-kimi` agent executing
`bin/kimi-run.sh` (Moonshot Anthropic-compatible endpoint)**."

### 5.3 `SKILL.md` Phase 6 provenance-check bullet

Extend the "Provenance check (GLM, Local, Codex, and Grok)" bullet to include kimi:

```
…for every Kimi attempt, confirm `_kimi_run.log` contains
`JOUST-KIMI-PROVENANCE endpoint=api.moonshot.ai` (and `JOUST-KIMI-DONE exit=0`,
no `-TIMEOUT`/`-ERROR`).
```

### 5.4 `SKILL.md` Quick-reference table + bullets

- Phase 1 line: "eleven options (… Grok, **Kimi**)".
- Dispatch line: "… Grok via the `grok`→xAI runner, **Kimi via the Moonshot
  Anthropic-compatible runner**."

### 5.5 `references/orchestration.md`

a) **Model identifiers section** — add a Kimi subsection after the Grok paragraph:

```
**Kimi models (Moonshot, via Moonshot's Anthropic-compatible endpoint)** — dispatched by
shelling out to `claude` through `bin/kimi-run.sh`, exactly like MiniMax. ONE model,
**Kimi K2.6**; all opus/sonnet/haiku aliases map to it, so there is **no `--model`
flag** — the runner pins it with `ANTHROPIC_MODEL=kimi-k2.6`. It reads its API key from
the **environment** (`MOONSHOT_API_KEY`), exactly as `minimax-run.sh` reads
`MINIMAX_API_KEY` and `glm-run.sh` reads `ZAI_API_KEY`: the key is exported in the
user's `~/.zshrc` and inherited into the session at launch. **Every provider runner
resolves its key the same way — from the env, never by sourcing/grepping rc files.**
The base URL is `https://api.moonshot.ai/anthropic` (env-overridable via `KIMI_BASE_URL`
in the runner). ONE generic worker agent (`joust-kimi`) handles it; the provenance
marker is `JOUST-KIMI-PROVENANCE endpoint=api.moonshot.ai` in `_kimi_run.log`. It
uses both per-attempt guards (`kimiMaxTurns`, default 30 + `kimiTimeoutSecs`, default
600). Kimi bills the user's Moonshot plan.
```

b) **ARGS shape** — add `kimiRunner`, `kimiTimeoutSecs`, `kimiMaxTurns`, and a sample
`dispatch:'kimi'` attempt entry (mirroring the minimax entry).

c) **Model → agentType map** note — add: "(Local, Codex, MiniMax, Grok, **and Kimi**
attempts each use one generic agent — … / `joust-engine:joust-kimi` — for every
model)."

d) **A "Kimi dispatch" paragraph** mirroring the MiniMax one, stating the three-part
fix (runner `bin/kimi-run.sh`; the single `joust-kimi` Bash-only command-runner;
the `JOUST-KIMI-PROVENANCE endpoint=api.moonshot.ai` marker), plus: (1) it shells
to `claude` pointed at `https://api.moonshot.ai/anthropic`, reading `MOONSHOT_API_KEY`
from the env — no rc-file sourcing; (2) one model, so no `--model` flag
(`ANTHROPIC_MODEL` pins it); (3) it uses BOTH guards like glm/minimax/grok (the codex
contrast); (4) the model id is unconfirmed and isolated to one runner literal.

e) **Stdin paragraph** — add kimi to the stdin-pin list:
"…uniform across glm/local/codex/minimax/grok/**kimi**."

---

## 6. EDIT — `.claude-plugin/plugin.json` + CHANGELOG + version bump

### 6.1 `plugin.json` — agent registration

Add `"joust-kimi"` to `components.agents`:

```json
"agents": [
  "joust-glm-5-2", "joust-glm-5-1", "joust-glm-4-7",
  "joust-glm-4-5-air", "joust-local", "joust-codex",
  "joust-minimax", "joust-grok", "joust-kimi",
  "joust-implementer"
]
```

Append the Kimi model to the top-level `description` string's provider list:
"…an xAI Grok model (grok-build or grok-composer-2.5-fast, run via the grok CLI), **a
Moonshot Kimi model (kimi-k2.6, via the Moonshot Anthropic-compatible endpoint)**, Top
Mixed …".

### 6.2 Version bump `0.0.4` → `0.0.5`

In `plugin.json` `"version"`.

### 6.3 `CHANGELOG.md`

Add an entry:

```
## v0.0.5 — feat(kimi): add Moonshot Kimi K2.6 provider (Anthropic-compatible endpoint);
  single-model, MiniMax-shape (ANTHROPIC_MODEL pin, MOONSHOT_API_KEY env key, no --model flag).
  New bin/kimi-run.sh + agents/joust-kimi.md; je-parse/tournament/SKILL/orchestration
  wiring; kimi-k2.6 selectable per-attempt like minimax-m3.
```

---

## 7. EDIT — `bin/je-bench.mjs` (benchmark roster) *(secondary touchpoint)*

The bench catalogs every provider, so kimi belongs. Kimi is Anthropic-compatible like
MiniMax, so it is a `claude`-family dispatch (not a separate CLI like codex/grok).

### 7.1 Catalogue entry

Add a `KIMI_MODELS` array after `MINIMAX_MODELS` / `GROK_MODELS`:

```js
// Kimi (Moonshot) — Anthropic-compatible endpoint via claude, env-key (MOONSHOT_API_KEY).
// ONE model (MiniMax-shape). Wire id UNCONFIRMED (V3); isolated here.
const KIMI_MODELS = [
  { provider: 'kimi', id: 'kimi-k2.6', model: 'kimi-k2.6' },
]
```

Add `'kimi'` to `PROVIDERS` and `...KIMI_MODELS` to `buildCatalogue()`'s `all`.

### 7.2 Dispatch function

Add `dispatchKimi` mirroring `dispatchMinimax` (the closest peer — `claude` pointed at
an Anthropic-compat endpoint via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, single
model). It spawns `claude -p` under the perl-alarm wrapper with the kimi env, times the
generation window, and counts tokens (Anthropic-style usage if surfaced, else a chars/4
`estimated:true` fallback like minimax). Register it:

```js
const DISPATCH = { anthropic: dispatchAnthropic, glm: dispatchGlm, local: dispatchLocal,
                   codex: dispatchCodex, minimax: dispatchMinimax, grok: dispatchGrok, kimi: dispatchKimi }
```

Selection grammar: `--models kimi` → the one variant; `kimi:kimi-k2.6` → explicit.
Update USAGE/grammar text to list `kimi`.

---

## 8. EDIT — `bin/je-git.sh` `run_verify` secret-drop (the security touchpoint) 

**This is the edit a naive "mirror minimax" pass misses** (the [tentative] prior about
tracing a new credential through the whole system). `run_verify` (issue #21 hardening)
`unset`s provider keys from the verify process so a verify command can neither read nor
exfiltrate them. Its secret-drop list is currently:

```
ZAI_API_KEY / MINIMAX_API_KEY / OMLX_AUTH_TOKEN / OPENAI_API_KEY / ANTHROPIC_* / GH_TOKEN / GITHUB_TOKEN
```

(Plus `XAI_API_KEY` if grok's addition landed it — verify and mirror.) **Add
`MOONSHOT_API_KEY`** to that `unset` list so a `make test` / `npm run` / `pytest`
running the implementer's LLM-authored code cannot read or exfiltrate the Moonshot key.
Without this, a grand-loop (Z≥2) verify step runs with `MOONSHOT_API_KEY` in the
environment — the one new-credential hole the minimax→grok precedent did not have to
think about for kimi.

Edit by anchor: in the `run_verify` function's secret-drop block, add `MOONSHOT_API_KEY`
alongside `MINIMAX_API_KEY` in the same `unset` statement.

---

## 9. TESTS

### 9.1 `bin/je-parse.test.mjs` (or wherever the parser tests live)

Add cases mirroring the minimax/grok ones:

```js
// kimi normalisation
assert(parse('refactor it @@JE:2 kimi').assignment, ['kimi-k2.6', 'kimi-k2.6'])
assert(parse('@@JE 2 kimi-k2.6').assignment, ['kimi-k2.6', 'kimi-k2.6'])
assert(parse('@@JE 1 kimi, 1 kimi k2.6').assignment, ['kimi-k2.6', 'kimi-k2.6'])
// spec text stripped from the task
assert(parse('fix 3 kimi files @@JE:2 kimi').task, 'fix 3 kimi files')   // 'kimi' in the task body survives; only the spec item is stripped
// dispatch token
assert(NORMALISER['kimi-k2.6'].dispatch === 'kimi')
```

Also assert a **collision guard**: an ordinary `<digit> <noun>` that is not a kimi spec
is not swallowed — e.g. `parse('review 3 keyboards @@JE:2 opus')` keeps `assignment`
`['opus','opus']` and leaves the task intact (the `kimi` alternative must not reach
across to unrelated words).

### 9.2 Tournament tests

If `tournament.mjs` has dispatch-table tests, add a `dispatch:'kimi'` case asserting it
yields a `RUNVERBATIM(… '_kimi_run.log')` prompt with no `--model` flag and agentType
`joust-engine:joust-kimi` (mirror the minimax test). If no such harness exists
(the workflow has no unit-test runner in the bundle), record this as a manual check in
§10 instead of fabricating a test file.

---

## 10. Provenance, validation, and end-to-end VERIFY

### 10.1 Provenance marker

```
JOUST-KIMI-PROVENANCE endpoint=api.moonshot.ai model=kimi-k2.6 max-turns=30 timeout=600s
```
- **Line-anchored validator token:** `KIMI`; grep `^JOUST-KIMI-PROVENANCE endpoint=`
  (success) ∧ `^JOUST-KIMI-DONE exit=0` ∧ ¬ `^JOUST-KIMI-\(TIMEOUT\|ERROR\)`.
- The `model=` suffix may vary (V3 wire id) without breaking validation (the grep pins
  the `endpoint=` prefix, not the value).

### 10.2 Liveness probe (run before any paid round)

A two-stage probe — (a) discover the real model id, (b) confirm the endpoint answers an
Anthropic-shaped call. Both use `MOONSHOT_API_KEY` from the env:

```sh
# (a) list model ids, find the K2.6 spelling (V3)
curl -s https://api.moonshot.ai/v1/models -H "Authorization: Bearer $MOONSHOT_API_KEY" | jq -r '.data[].id' | grep -i kimi

# (b) Anthropic-compatible endpoint answers (V1); replace <id> from (a)
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic \
ANTHROPIC_AUTH_TOKEN="$MOONSHOT_API_KEY" \
ANTHROPIC_MODEL="<id>" \
claude -p "Reply with the single word OK and nothing else." --model opus --permission-mode acceptEdits </dev/null 2>&1 | tail -5
```

On (b) printing `OK` exit 0, the integration is live. On a 404/auth error, see the V1
fallback (host/path) and V2 (key name) — both are one-line fixes via `KIMI_BASE_URL` /
the env var.

### 10.3 Key hygiene

`MOONSHOT_API_KEY` is read from the env in the runner (§1.2) — **never sourced/grepped
from rc files**, matching the uniform glm/minimax/local rule. Exported once in
`~/.zshrc`; the Claude Code session inherits it at launch; a missing key hard-fails with
`JOUST-KIMI-ERROR MOONSHOT_API_KEY missing` (exit 3).

### 10.4 Validation checklist (every UNCONFIRMED fact is a step, not an assumption)

| #  | UNCONFIRMED fact | Validation step | If it fails / differs |
|----|------------------|-----------------|-----------------------|
| V1 | base URL `https://api.moonshot.ai/anthropic` | §10.2(b) returns 200 + `OK` | Flip `KIMI_BASE_URL` default in `kimi-run.sh` (one literal). Try regional host / different `/anthropic` path. |
| V2 | key var `MOONSHOT_API_KEY` | `echo "${MOONSHOT_API_KEY:?}"` in a fresh shell; §10.2(a) returns 200 | Use the operator's real var name in §1.2 (one literal). |
| V3 | **model id `kimi-k2.6`** (the critical one) | §10.2(a) grep kimi; pick the real id | Replace the `KIMI_MODEL` literal in `kimi-run.sh` §1.3 and the bench `KIMI_MODELS` id. Display token `kimi-k2.6` is decoupled, so no parser/workflow/agent change. |
| V4 | timeout/latency sizing (600s enough?) | Run a heavy multi-file kimi attempt; watch for `-TIMEOUT` | Raise `kimiTimeoutSecs` default. Docs-only. |
| V5 | context window (omit until known) | Moonshot docs / a >256K-token probe | If confirmed, add `CLAUDE_CODE_AUTO_COMPACT_WINDOW` literal to §1.5. Until then it stays omitted (no contradiction). |
| V6 | soft-failure exit semantics | Force an auth/model error; record `echo $?` + phrases | If `claude` ever exits 0 on a kimi soft failure, add the codex/grok-style defensive grep to §1.5 (do not pre-add it — wrong sibling). |
| V7 | `ANTHROPIC_AUTH_TOKEN` vs `x-api-key` auth header | §10.2(b); if 401 with `ANTHROPIC_AUTH_TOKEN`, try Moonshot's required header | `claude` honours `ANTHROPIC_AUTH_TOKEN`; if Moonshot needs `x-api-key`, the nested `claude` already maps the token — confirm, no change expected. |
| V8 | secret-drop var name | grep `run_verify` for the `unset` list after edit | Confirm `MOONSHOT_API_KEY` is present (§8). |

### 10.5 End-to-end VERIFY (the full integration)

1. `node bin/je-parse.mjs "do it @@JE:2 kimi"` → `assignment: ['kimi-k2.6','kimi-k2.6']`,
   `n: 2`, task `do it`.
2. §10.2 probe prints `OK` (endpoint + key + id confirmed).
3. Manual dispatch check: build the ARGS (§5.5 shape) with one `dispatch:'kimi'`
   attempt + one `dispatch:'anthropic'` (so the pool is non-empty even if kimi fails),
   `kimiRunner` set; run the workflow. Confirm `_kimi_run.log` shows the success
   contract (§1.6) and the candidate is `valid` in `mapping.json`.
4. `node bin/je-bench.mjs --models kimi` → one throughput row (or an `estimated:true`
   row if usage isn't surfaced).
5. `grep -r MOONSHOT_API_KEY bin/je-git.sh` → present in the `run_verify` secret-drop
   (§8).

---

## 11. File-by-file change summary

| File | Change | New / Edit |
|------|--------|------------|
| `bin/kimi-run.sh` | the runner: `MOONSHOT_API_KEY` env auth, `claude`→Moonshot `/anthropic`, `ANTHROPIC_MODEL` pin, both guards, PROVENANCE/DONE/TIMEOUT | **NEW** |
| `agents/joust-kimi.md` | ONE generic haiku command-runner stub | **NEW** |
| `workflows/tournament.mjs` | `kimiRunner`, `kimiMaxTurns`/`kimiTimeout`, `dispatch:'kimi'` branch (no flag), validator KIMI token + `_kimi_run.log` log/rm/engineFiles | Edit |
| `bin/je-parse.mjs` | `NORMALISER` kimi entries, `MODEL_TOKEN_RX` kimi alternative, "Known:" help text | Edit |
| `skills/.../SKILL.md` | Phase 1 Option 11 + Specify-Mix line, Phase 2 dispatch, Phase 6 provenance, quick-ref | Edit |
| `skills/.../references/orchestration.md` | Kimi model-identifier subsection, ARGS shape, agentType note, Kimi-dispatch paragraph, stdin note | Edit |
| `.claude-plugin/plugin.json` | `joust-kimi` agent + description; version `0.0.5` | Edit |
| `CHANGELOG.md` | v0.0.5 entry | Edit |
| `bin/je-bench.mjs` | `KIMI_MODELS`, `dispatchKimi`, `PROVIDERS`+`buildCatalogue`+`DISPATCH` wiring, usage text | Edit |
| `bin/je-git.sh` | add `MOONSHOT_API_KEY` to `run_verify` secret-drop unset list (§8) | Edit |
| `bin/je-parse.test.mjs` | kimi normalisation + collision-guard cases | Edit |

**Invariants preserved:** no change to `provCheckShell`, the staging schema, `reconcile`,
the carryover logic, the persistence layer, `Z_MAX`/`N_MAX`, the diversity injection, the
grand-loop driver, `TOP_MIXED_POOL`. Kimi slots into the existing six-provider machinery
as a seventh provider (anthropic + glm + local + codex + minimax + grok + **kimi**) with
zero structural change — the "mirror the patterns, don't invent a new style" mandate.

---

## 12. Open questions (concise)

- **Model id** (V3): real wire id for Kimi K2.6? Default placeholder `kimi-k2.6` until
  `GET /v1/models` confirms.
- **Endpoint host/path** (V1): `api.moonshot.ai/anthropic` correct, or
  regional/alternate? One-line `KIMI_BASE_URL` fix if not.
- **Context window** (V5): 256K? Omit `CLAUDE_CODE_AUTO_COMPACT_WINDOW` until known —
  bake in once confirmed?
- **More variants later**: keep single-model (MiniMax-shape), or anticipate a
  `kimi-k2.6-thinking` and pre-build the GLM-shape `KIMI_FLAG`? (Recommendation: stay
  single-model now; promote on demand.)
- **Fold into Top Mixed**: leave `top mixed` as opus/glm-5.2/codex-high, or add kimi?
  (Recommendation: leave unchanged.)
