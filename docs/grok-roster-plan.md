# Implementation Plan — Add xAI `grok` CLI to the Joust Engine model roster

**Scope:** add the xAI Grok Build CLI (`grok`, v0.2.56) as a fifth non-Anthropic
provider, exposing **two model variants** the operator wants:

| Display model (token)      | `-m <id>`                  | What it is                                                                 |
|----------------------------|----------------------------|----------------------------------------------------------------------------|
| `grok-build`               | `grok-build`               | xAI's own agentic-coding model (`grok-code-fast-1` is an alias). 256K ctx.  |
| `grok-composer-2.5-fast`   | `grok-composer-2.5-fast`   | Cursor Composer 2.5 (Kimi K2.5 lineage), `-fast` serving tier. CLI default. |

This is a **design** deliverable: file-by-file changes, exact wiring points, and a
validation checklist for every UNCONFIRMED fact. No production code is written here.

Grok is closest to **codex** (an external, non-`claude` CLI authenticated from a file
rather than an env key) but, crucially, grok **has `--max-turns`**, so it uses **both**
per-attempt guards like glm/minimax — not the wall-clock-only model codex is stuck with.

---

## 0. Design decisions up front (the two judgement calls the brief asks me to make)

### 0.1 One generic `joust-grok` agent, NOT per-variant stubs

**Decision: one generic `joust-grok` stub.** The model id rides in the command,
exactly like codex (`joust-codex` serves every reasoning effort) and local
(`joust-local` serves every omlx id). The per-model GLM stubs
(`joust-glm-5-2`, …) exist only because GLM's `--model opus/sonnet/haiku` aliases
are *not* the GLM model name — the per-model stub is the only place that opaque mapping
is pinned to a human-readable identity. Grok has no such indirection: the `-m` value
*is* the literal model id (`grok-build` / `grok-composer-2.5-fast`), so a `GROK_FLAG`
map in `tournament.mjs` plus one generic agent is the right, lower-maintenance shape.
This matches the brief's own framing: "the two requested variants are a `-m <model>`
axis — analogous to codex's reasoning-effort axis." One axis, one generic agent.

**Consequence:** the `displayModel` *is* the dispatch key. `GROK_FLAG[displayModel]`
yields the `-m <id>` flag; the agentType is always `joust-engine:joust-grok`.

### 0.2 Provenance endpoint string

The runner writes, at column 0, unconditionally at startup:

```
JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com model=<id> max-turns=<N> timeout=<T>s
```

Endpoint is `cli-chat-proxy.grok.com` (the default inference route for OAuth-session
auth on this box — research §B "high" confidence), NOT `api.x.ai` (that path is only
reached with explicit `XAI_API_KEY` direct-API auth). The endpoint token must be a
**fixed literal** so the staging grep is stable; see §3.5 and the validation note V8
on whether to make it auth-mode-aware.

### 0.3 `-p` prompt-as-arg vs `--prompt-file`

**Decision: `--prompt-file _brief.txt`** (not `-p "$(cat _brief.txt)"`).

Rationale: the brief is already written to `_brief.txt` by the engine's `cmdHead`
(`printf '%s' <brief> > _brief.txt`). Passing it as a *file* is strictly more robust
than `-p "$(cat …)"`:
- it sidesteps any argv-length ceiling on a heavy brief (heavy multi-file specs +
  shared-context line can be large);
- it avoids a second layer of shell quoting on brief text that may contain `$`,
  backticks, single quotes;
- `grok --help` confirms `--prompt-file <PATH>` is a first-class single-turn entry
  point (the file analog of `-p`).

Both still `</dev/null`-pin stdin (see §1.4). The other runners use `-p "$(cat …)"`
only because `claude`/`codex` lacked a `--prompt-file`; grok has one, so prefer it.
(Validation V6 confirms `--prompt-file` exits after one turn exactly like `-p`.)

---

## 1. NEW FILE — `bin/grok-run.sh`

A peer of `bin/codex-run.sh` / `bin/minimax-run.sh` / `bin/glm-run.sh`. Approved
internal runner. Same skeleton; grok-specific auth, flags, and provenance.

### 1.1 Header + knobs (mirror the existing runners)

```sh
#!/usr/bin/env bash
# Joust Engine GROK attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on an xAI Grok model via the `grok`
# headless CLI (`grok --prompt-file`), under BOTH per-attempt guards: --max-turns
# (grok HAS one, unlike codex) and a portable wall-clock timeout.
# Usage: grok-run.sh -m <grok-build|grok-composer-2.5-fast> [extra grok flags...]
# Timeout (seconds) from JE_TIMEOUT_SECS (default 600); max-turns from JE_MAX_TURNS (default 30).
set -uo pipefail
FLAG="${*:--m grok-composer-2.5-fast}"   # default to the CLI's own default model
LOG=_grok_run.log
TIMEOUT="${JE_TIMEOUT_SECS:-600}"   # wall-clock backstop (seconds)
MAXTURNS="${JE_MAX_TURNS:-30}"      # PRIMARY guard: cap agentic iterations (grok HAS --max-turns)
```

Notes:
- **Default timeout 600s**, not 300. Grok Build is a full autonomous coding agent
  (sub-agents, plan mode, web tools off); like codex it deserves the roomier default.
  The per-attempt `grokTimeoutSecs` knob (§3.4) overrides it.
- **`--max-turns` default 30**, the glm/minimax default — grok *can* use it, so it is
  the primary guard and the wall-clock is the backstop (the brief's "BOTH guards").

### 1.2 Auth handling — the grok-specific part

Grok's credential resolution order (research §B, high confidence) is:
`model.api_key` > `model.env_key` > **active OAuth session token** (`~/.grok/auth.json`)
> **`XAI_API_KEY`** (`xai-` prefix). On THIS machine **only the OAuth session exists**;
no `XAI_API_KEY` is staged.

So the runner is **auth-mode-agnostic by design** — it injects *no* key and lets grok
resolve its own credential, exactly as codex reads `~/.codex/auth.json` without an env
var. But because `XAI_API_KEY` is the documented headless/CI fallback, the runner:

1. Does **not** require `XAI_API_KEY` (unlike glm/minimax which hard-fail on a missing
   key) — a missing key is the *normal* state here (OAuth covers it).
2. **Passes `XAI_API_KEY` through if present** (it is inherited from the env like every
   other provider key — never sourced/grepped from rc files, per the uniform rule). No
   special export line is needed: a present `XAI_API_KEY` is already in the runner's
   environment and grok picks it up via its own resolution order.
3. Emits a **one-line auth-mode note** into the log for diagnosis (does not gate):

```sh
# Auth: grok resolves OAuth session (~/.grok/auth.json) OR XAI_API_KEY (CI fallback) on
# its own (model.api_key > env_key > session > XAI_API_KEY). We require NEITHER and inject
# NEITHER — uniform with codex (reads ~/.codex/auth.json, no env key). Just record which.
if [ -n "${XAI_API_KEY:-}" ]; then AUTHMODE="env-key"; else AUTHMODE="oauth-session"; fi
```

`AUTHMODE` is appended to the PROVENANCE line (so the report/log shows whether the run
used the OAuth session or a CI key — relevant to the session-expiry risk, V4).

> **Why not hard-fail on missing key like glm/minimax?** Because grok's *primary* auth
> is the OAuth session file, not a key. Hard-failing on a missing `XAI_API_KEY` would
> break the operator's actual setup. Grok is a *codex-shaped* auth provider (file-based),
> not a *glm-shaped* one (env-key required).

### 1.3 Pre-flight guards (mirror codex/minimax)

```sh
[ -f _brief.txt ] || { echo "JOUST-GROK-ERROR _brief.txt missing" | tee -a "$LOG"; exit 4; }
command -v grok >/dev/null 2>&1 || { echo "JOUST-GROK-ERROR grok CLI not found on PATH" | tee -a "$LOG"; exit 5; }
```

(Same `exit 4` / `exit 5` codes as codex-run.sh for `_brief.txt` missing / CLI missing.)

### 1.4 PROVENANCE marker (unconditional, up front)

```sh
# Write the PROVENANCE marker UNCONDITIONALLY, up front: a missing log at this path proves
# the runner never ran (a native-solve spoof or refusal) and must fail closed (P=0) downstream.
echo "JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com auth=${AUTHMODE} flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s" >> "$LOG"
```

### 1.5 The headless invocation — the exact grok flag surface

All flags below are CONFIRMED present in `grok --help` (research §A). Built into the
portable perl `alarm` → TERM/KILL wrapper, identical in shape to codex-run.sh, with
`$FLAG` left **unquoted** so the outer shell word-splits `-m grok-build` into argv:

```sh
# Portable hard timeout (macOS has no coreutils `timeout`): fork the call, SIGALRM -> TERM/KILL.
# </dev/null pins grok's stdin: with a prompt SOURCE (--prompt-file) but an OPEN (non-TTY)
# stdin, an agentic CLI can block waiting on stdin and stall the whole wall-clock (the bug
# that hit glm/codex/minimax). Close it here and never rely on the caller. (Mirrors the
# same fix in codex-run.sh / glm-run.sh / minimax-run.sh.)
perl -e '
  my $t = shift @ARGV;
  my $p = fork; if (!defined $p) { exit 127 }
  if ($p == 0) { exec @ARGV; exit 127 }
  $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
  alarm $t; waitpid($p, 0); exit($? >> 8);
' "$TIMEOUT" grok \
    --prompt-file _brief.txt \
    $FLAG \
    --output-format json \
    --no-alt-screen \
    --no-auto-update \
    --always-approve \
    --max-turns "$MAXTURNS" \
    --disable-web-search \
    --cwd "$PWD" </dev/null >> "$LOG" 2>&1
RC=$?
```

**Each flag, and why it is here:**

| Flag                          | Purpose / why                                                                                                                                                              |
|-------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `--prompt-file _brief.txt`    | single-turn headless prompt from the engine-written brief file (see §0.3). The headless analog of `codex exec` / `claude -p`. Exits after the turn(s).                    |
| `$FLAG` (`-m <id>`)           | the model variant, injected by the dispatch layer's `GROK_FLAG`. Pinned so grok never falls back to `config.toml`'s `default = "grok-composer-2.5-fast"` silently.        |
| `--output-format json`        | machine-readable result (the engine only needs files + the log tail, but JSON keeps stdout clean and parseable for the bench; see V5 on the shape).                       |
| `--no-alt-screen`             | run **inline** — no fullscreen TUI. Mandatory in a piped/redirected (`>> LOG`) context; the alt-screen would corrupt the log.                                             |
| `--no-auto-update`            | skip the background update check (research §B CI gotcha) so a script run never stalls/mutates on an update prompt.                                                         |
| `--always-approve`            | auto-approve ALL tool executions — the headless permission bypass (grok's analog of codex `approval_policy="never"` / claude `--permission-mode acceptEdits`).            |
| `--max-turns "$MAXTURNS"`     | PRIMARY iteration guard. **Grok HAS this** (unlike codex), so we use it. Caps the write→run→fix grind; the deliverable written before the cap is preserved.               |
| `--disable-web-search`        | disable web-search + web-fetch tools. Matches the liveness probe that returned clean `OK`; keeps attempts hermetic (no network reads skewing diversity), and quiets MCP.  |
| `--cwd "$PWD"`                | scope the agent's working root to this attempt workspace (analog of codex `-C "$PWD"`). The brief's "save to / work only in this dir" rules then resolve here.            |
| `</dev/null`                  | stdin pin (see comment) — the uniform anti-stall fix across all runners.                                                                                                  |

**Deliberately NOT used:**
- `--permission-mode` — `--always-approve` already grants the headless bypass; passing
  both is redundant. (If V7 shows `--always-approve` alone is insufficient, add
  `--permission-mode bypassPermissions` — see validation.)
- `--sandbox` — grok's sandbox profiles are unverified on this binary and the workspace
  is not a sensitive target; codex uses `-s workspace-write` but grok's profile names
  differ. Left to a follow-up once V7 confirms safe write behaviour. The attempt already
  runs in an isolated per-candidate dir.
- `--effort` / `--reasoning-effort` — the operator's two variants are a **model** axis,
  not an effort axis. Effort is intentionally NOT a selectable axis here (keeps the
  roster to exactly the two requested ids). A future "grok-build high" could add it via
  the same `GROK_FLAG` map, but it is out of scope.
- `--best-of-n`, `--check`, `--no-subagents`, `--no-memory`, `--no-plan` — not needed;
  the single-pass brief already forbids over-iteration, and `--max-turns` is the backstop.
- MCP noise: the liveness probe showed benign `unexpected content type: None` / "worker
  quit" stderr from MCP-init that did NOT block completion. We capture stdout and
  redirect stderr to the same log (`2>&1`); the lines are harmless. If they prove noisy,
  add `--mcp-config '{}'`-equivalent neutralization (V9) — codex uses `-c 'mcp_servers={}'`
  for the same reason, but grok's MCP-disable flag is unverified, so we do NOT guess it.

### 1.6 Defensive fail-closed + TIMEOUT/DONE lines (mirror codex-run.sh)

Grok's non-zero exit semantics on refusal/tool-failure are UNCONFIRMED (V7), so add the
same belt-and-suspenders guard codex uses: if grok produced no usable output AND the log
shows a terminal auth/model/version failure phrase, force a non-zero RC so the
provenance gate (`DONE exit=0`) rejects it even if grok wrongly exits 0.

```sh
# Defensive fail-closed (beyond the exit code): if grok hit a terminal auth/model/version
# failure, force a nonzero RC so the provenance check (DONE exit=0) rejects it even on the
# rare path where grok returns such an error yet still exits 0. Anchored to terminal phrases
# only (mirrors codex-run.sh's mention-proof guard) so a SUCCESSFUL run whose deliverable
# merely DISCUSSES these phrases is never force-failed. Phrase list is a VALIDATION ITEM (V7):
# replace these placeholders with the real grok error strings once observed.
if grep -qiE '401 Unauthorized|403 Forbidden|invalid api key|model .* (not found|unavailable)|session (expired|token expired)|requires a newer version of Grok' "$LOG" \
   && ! find . -type f ! -name '_brief.txt' ! -name '_grok_run.log' | grep -q .; then
  echo "JOUST-GROK-ERROR grok reported a model/auth/version failure (see log)" >> "$LOG"
  [ "$RC" -eq 0 ] && RC=6
fi

[ "$RC" -eq 124 ] && echo "JOUST-GROK-TIMEOUT secs=${TIMEOUT}" >> "$LOG"
echo "JOUST-GROK-DONE exit=$RC" >> "$LOG"
tail -20 "$LOG"
```

> The "no deliverable AND terminal phrase" guard mirrors codex's `[ ! -s "$LAST" ] &&
> grep …` guard: only force-fail when grok produced no real work AND an error phrase is
> present, so a genuine success that *mentions* an error string in its deliverable is not
> false-failed. (Codex used `_codex_last.txt` for this; grok has no `-o`-equivalent that
> we rely on, so we use "any deliverable file other than the engine files exists" as the
> stand-in. V5/V7 may let us switch to a clean `--output-format json` final-result check.)

### 1.7 Summary of `_grok_run.log` contract (what the validator greps)

```
JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com auth=… flag=-m grok-build max-turns=30 timeout=600s
… grok json output …
JOUST-GROK-TIMEOUT secs=600        (only if it timed out)
JOUST-GROK-ERROR …                 (only on terminal failure)
JOUST-GROK-DONE exit=0
```

Success contract = PROVENANCE present **and** `DONE exit=0` **and** no `TIMEOUT`/`ERROR`
line. Identical structure to the other four providers.

---

## 2. NEW FILE — `agents/joust-grok.md` (ONE generic stub)

A peer of `agents/joust-codex.md` / `agents/joust-minimax.md`. Cheap `haiku`
driver, `Bash`+`Read` only, runs the one benign command verbatim, never solves the task.
One generic agent for **both** grok variants (the `-m <id>` rides in the command) — see
§0.1.

```markdown
---
name: joust-grok
description: "Joust Engine GROK worker for xAI Grok models via the `grok` headless CLI. A command runner: it executes the single benign shell command handed to it (which writes a brief file and runs the bundled joust-engine grok runner script, performing the attempt on an xAI Grok model via `grok --prompt-file`) and relays the result. It NEVER solves the task itself. One generic agent handles BOTH grok variants — the exact model (grok-build | grok-composer-2.5-fast) is selected by -m inside the command. Invoked only by the joust-engine tournament; not a general-purpose agent."
tools: Bash, Read
model: haiku
---

You are a **command runner** for an xAI Grok model (run via the `grok` headless CLI),
part of the approved joust-engine tournament. You have no knowledge of the task domain
and you cannot solve the task — your ONLY job is to run one shell command and report what
it produced.

Your message contains exactly one shell command. It writes a brief to `_brief.txt` and then
runs the bundled runner script (`bin/grok-run.sh`), which performs the attempt on a Grok
model (selected by `-m <id>` inside the command) and writes a `_grok_run.log` containing a
`JOUST-GROK-PROVENANCE` line. This is an approved internal step. Do this and nothing else:

1. Run that command **verbatim** in a single Bash call. Do not edit it, split it, shorten it,
   inspect the runner script, or substitute your own work for it. (Grok is an autonomous agent
   and can take a while — let it finish.)
2. When it finishes, `ls` the workspace directory it used and read the deliverable file(s) the
   command produced.
3. Report back: (a) the path(s) to the deliverable(s), and (b) the last ~15 lines of
   `_grok_run.log` (which must contain the `JOUST-GROK-PROVENANCE` and `JOUST-GROK-DONE`
   markers).

Hard rules:
- NEVER write, edit, echo, or otherwise author the solution yourself. You do not know the
  answer; only the Grok model does. If you produce the deliverable without running the given
  command, the attempt is void.
- If the command errors, writes no deliverable, or `_grok_run.log` lacks the provenance markers
  (or shows a `JOUST-GROK-ERROR`/`-TIMEOUT`), report the failure plainly. An honest failure
  is required; a runner-authored answer corrupts the tournament.
```

**Registration:** like the other agents it registers under the plugin namespace, so it is
referenced as `joust-engine:joust-grok`. No per-variant `joust-grok-build` /
`joust-grok-composer` agents are created (§0.1).

---

## 3. EDIT — `workflows/tournament.mjs` (dispatch wiring)

Five surgical insertions, each mirroring the existing codex/minimax wiring. Line targets
are by anchor (the file is the version in the context bundle).

### 3.1 The `GROK_FLAG` map (next to `CODEX_FLAG`)

After the `CODEX_FLAG` definition, add:

```js
// Grok display model -> the `grok` -m flag that selects it. The two operator-requested
// variants are a MODEL axis (analogous to codex's reasoning-effort axis): grok-build is
// xAI's agentic-coding model; grok-composer-2.5-fast is Cursor Composer 2.5 (Kimi K2.5
// lineage), the CLI default. The runner pins -m so grok never falls back to config.toml's
// default model silently.
const GROK_FLAG = {
  'grok-build': '-m grok-build',
  'grok-composer-2.5-fast': '-m grok-composer-2.5-fast',
}
```

### 3.2 The runner-path arg (next to `codexRunner` / `minimaxRunner`)

In the runner-paths block:

```js
const grokRunner = A.grokRunner
```

And in the args-shape doc comment at the top of the file, add the line
`//   grokRunner: string,   // bundled runner-script path (if any attempt is Grok)` and a
sample attempt entry:

```js
//    { label: 'candidate-6',
//      dispatch: 'grok',
//      agentType: 'joust-grok',   // ONE generic agent for both grok variants
//      displayModel: 'grok-build',     // grok-build | grok-composer-2.5-fast -> GROK_FLAG
//      r1nudge, r2nudge },
```

### 3.3 The `grokTimeoutSecs` knob (next to `codexTimeout`)

```js
// Grok is a full autonomous coding agent; like codex it gets a roomier wall-clock default.
// UNLIKE codex it ALSO has --max-turns (grokMaxTurns, default = glmMaxTurns 30), so it uses
// BOTH guards. Override the wall clock via args.grokTimeoutSecs.
const grokMaxTurns = Number(A.grokMaxTurns) > 0 ? Math.floor(Number(A.grokMaxTurns)) : glmMaxTurns
const grokTimeout  = Number(A.grokTimeoutSecs) > 0 ? Math.floor(Number(A.grokTimeoutSecs)) : 600
```

`grokMaxTurns` flows through the existing `runnerCmd(runner, flag, ws, b, maxTurns, timeout)`
helper as the `JE_MAX_TURNS` value; `grokTimeout` as `JE_TIMEOUT_SECS`. No new command
builder is needed — grok uses the *standard* `runnerCmd` (it has both guards), **not** the
codex-only `codexRunnerCmd` (which omits `JE_MAX_TURNS`). This is the key structural
difference from codex.

### 3.4 The `dispatch:'grok'` branch (in `dispatch()`)

Add a branch alongside `else if (a.dispatch === 'codex')` / `'minimax'`:

```js
} else if (a.dispatch === 'grok') {
  opts.agentType = nsAgent(a.agentType) // joust-grok (one generic agent for both variants)
  const flag = GROK_FLAG[a.displayModel] || `-m ${a.model}` // grok-build | grok-composer-2.5-fast
  if (!grokRunner) {
    log(`attempt ${a.label} (${a.displayModel}) skipped: grokRunner not supplied (pass args.grokRunner pointing to bin/grok-run.sh)`)
    return null
  }
  const cmd = runnerCmd(grokRunner, flag, ws, b, grokMaxTurns, grokTimeout) // BOTH guards
  prompt = RUNVERBATIM(cmd, ws, '_grok_run.log')
```

Note it uses `runnerCmd` (both `JE_MAX_TURNS` and `JE_TIMEOUT_SECS`), unlike the codex
branch's `codexRunnerCmd`. The `|| \`-m ${a.model}\`` fallback mirrors codex's
`|| \`-m ${a.model}\`` so an unmapped displayModel still produces a sane `-m`.

### 3.5 The staging/provenance validator (in `stageAndValidate`)

Two one-token additions to the existing chains, so the validator is provider-specific and
**line-anchored** (`^JOUST-GROK-…`), per the engine's mention-proof rule.

a) Log-filename selection:

```js
const log = c.dispatch === 'glm' ? '_glm_run.log'
          : c.dispatch === 'local' ? '_local_run.log'
          : c.dispatch === 'codex' ? '_codex_run.log'
          : c.dispatch === 'minimax' ? '_minimax_run.log'
          : c.dispatch === 'grok' ? '_grok_run.log'        // <-- ADD
          : ''
```

b) Provenance token:

```js
const tok = c.dispatch === 'glm' ? 'GLM'
          : c.dispatch === 'local' ? 'LOCAL'
          : c.dispatch === 'codex' ? 'CODEX'
          : c.dispatch === 'minimax' ? 'MINIMAX'
          : c.dispatch === 'grok' ? 'GROK'                 // <-- ADD
          : ''
```

c) The stage `rm -f` cleanup line — add `_grok_run.log` to the engine-file delete list so
it is stripped before pooling (it names the provider, and would leak identity to the
blind judge):

```js
rm -f …/_codex_run.log …/_codex_last.txt …/_minimax_run.log ${q(dest)}/_grok_run.log; …
```

`provCheckShell(log, tok, lp, carriedOver)` is **unchanged** — it already builds the
correct grep from `tok='GROK'`:

```
grep -q '^JOUST-GROK-PROVENANCE endpoint=' …
  && grep -q '^JOUST-GROK-DONE exit=0' …
  && ! grep -q '^JOUST-GROK-\(TIMEOUT\|ERROR\)' …
```

So the runner's column-0 markers in §1 satisfy the success contract automatically. No
change to `provCheckShell`, the carryover logic, the schema, or `reconcile`.

> **Why the endpoint string must be literal/stable:** the validator greps
> `^JOUST-GROK-PROVENANCE endpoint=` (it does not pin the endpoint *value*), so the
> `auth=`/`flag=` suffix is free to vary. Good — the `auth=oauth-session|env-key` field
> (§1.2) does not break validation.

---

## 4. EDIT — `bin/je-parse.mjs` (parser recognition)

So prose specs like `2 grok`, `1 grok-build`, `3 grok composer 2.5 fast` are selectable
and map to the right `displayModel` tokens.

### 4.1 `NORMALISER` entries

Add a grok block after the MiniMax block. Bare `grok` defaults to the **operator's
`/model grok` variant**, which is `grok-build` (the operator described "`/model grok`"
as the grok-code build) — note this is deliberately NOT the CLI's *config* default
(`grok-composer-2.5-fast`); the operator's prose "grok" means the build model.

```js
// Grok (xAI, via the `grok` headless CLI). TWO variants on a -m model axis.
// Bare 'grok' defaults to grok-build (the operator's '/model grok' = the grok-code build).
// The Composer variant is selected explicitly by its (several) spellings.
'grok':                    { model: 'grok-build',             dispatch: 'grok' },
'grok build':              { model: 'grok-build',             dispatch: 'grok' },
'grok-build':              { model: 'grok-build',             dispatch: 'grok' },
'grok code':               { model: 'grok-build',             dispatch: 'grok' }, // grok-code-fast-1 alias
'grok-code':               { model: 'grok-build',             dispatch: 'grok' },
'grok composer':           { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
'grok-composer':           { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
'grok composer 2.5':       { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
'grok composer 2.5 fast':  { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
'grok-composer-2.5-fast':  { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
'composer':                { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
'composer 2.5':            { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
'composer 2.5 fast':       { model: 'grok-composer-2.5-fast', dispatch: 'grok' },
```

> Both `displayModel` tokens (`grok-build`, `grok-composer-2.5-fast`) are **exactly** the
> `GROK_FLAG` keys in §3.1 and the bench ids in §6 — one canonical spelling end to end.
> The normaliser's existing `dashToSpace`/`spaceToDash` fallbacks (in `normaliseModel`)
> then also catch `grok build` <-> `grok-build` and `composer 2.5 fast` <->
> `composer-2.5-fast` for free, so I only enumerate the canonical + the most likely prose
> spellings.

### 4.2 `MODEL_TOKEN_RX` (the spec-scan recogniser)

Add grok/composer alternatives so `locateSpec`/`expandSpec` capture the **whole** token
(the version digits must be captured, like glm's `[0-9](\.[0-9])?`). Insert as
higher-priority (earlier) alternatives so the longest match wins:

```js
const MODEL_TOKEN_RX =
  '(?:' +
    'codex(?:\\s*-?\\s*(?:low|medium|high|xhigh|x-?high|extra\\s*high))?' +
    // grok: 'grok', 'grok build', 'grok-code', 'grok composer 2.5 fast', etc.
    '|grok(?:\\s*-?\\s*(?:build|code|composer(?:\\s*-?\\s*2\\.5(?:\\s*-?\\s*fast)?)?))?' +
    // bare 'composer 2.5 fast' (no 'grok' prefix) — the operator's Composer name
    '|composer(?:\\s*-?\\s*2\\.5(?:\\s*-?\\s*fast)?)?' +
    '|glm(?:\\s*-?\\s*[0-9](?:\\.[0-9])?)?(?:\\s*-?\\s*air)?' +
    '|opus|sonnet|haiku' +
    '|minimax(?:\\s*-?\\s*m3)?|m3' +
  ')';
```

> Order matters: the `grok…composer…` alternative precedes bare `composer`, and both
> precede `glm`, so `grok composer 2.5 fast` is captured as one token rather than `grok` +
> stray `composer`. This is the same "longest/most-specific first" rule the file already
> documents for codex.

### 4.3 The "Known:" error string

Add grok to the unrecognised-token help text so a typo lists grok as a known family:

```js
'Known: opus, sonnet, haiku, glm[-5.2/5.1/4.7/4.5-air], codex[-low/medium/high/xhigh], ' +
'minimax-m3, grok[-build]/grok-composer-2.5-fast, or a live local id. Re-state the spec …'
```

### 4.4 NOT changed

- `TOP_MIXED_POOL` stays `['opus', 'glm-5.2', 'codex-high']` — grok is opt-in via an
  explicit spec / the Phase 1 menu, not folded into the Top Mixed preset (the operator
  did not ask for that, and changing the preset would silently alter every `top mixed`
  run's cost/identity).
- `Z_MAX`/`N_MAX`, the conflict logic, `stripAll` — untouched. `stripAll` re-uses
  `MODEL_TOKEN_RX`, so once §4.2 lands, grok spec text is stripped from the task body for
  free.

**displayModel mapping summary (the brief asks for this explicitly):**

| Prose                                   | normaliser `model` (= displayModel) | GROK_FLAG `-m`                |
|-----------------------------------------|--------------------------------------|-------------------------------|
| `grok`, `grok build`, `grok-code`       | `grok-build`                         | `-m grok-build`               |
| `grok composer 2.5 fast`, `composer`    | `grok-composer-2.5-fast`             | `-m grok-composer-2.5-fast`   |

---

## 5. EDIT — `SKILL.md` + `references/orchestration.md`

### 5.1 `SKILL.md` Phase 1 menu — a tenth option

The menu is currently nine options. Add a tenth (grok) and update the "nine option"
wording to "ten option":

```
> 10. Grok — xAI Grok via the `grok` CLI (I'll then ask which variant)
```

And the handler, mirroring Option 6 (GLM) / Option 8 (Codex) — a sub-menu, then stop:

```
- **Option 10 (Grok):** drill down with a second question, then stop again and wait.
  Grok is authenticated by the operator's grok.com OAuth session (~/.grok/auth.json);
  XAI_API_KEY is the headless/CI fallback only. Optionally run a one-line liveness probe
  first so a stale CLI / expired session doesn't waste a round:
  > `grok -p "Reply with the single word OK and nothing else." -m grok-composer-2.5-fast --disable-web-search --no-alt-screen --no-auto-update 2>/dev/null | tail -3`
  If it prints OK, ask:
  > Which Grok model?
  > 1. grok-build — xAI's agentic-coding model (grok-code-fast-1 lineage), 256K context
  > 2. grok-composer-2.5-fast — Cursor Composer 2.5 (Kimi K2.5), the CLI default
  Record the uniform assignment with the displayModel token, e.g. N=4 on build:
  [grok-build, grok-build, grok-build, grok-build]. Grok bills your SuperGrok / X Premium+
  subscription (or XAI_API_KEY billing if set), not Anthropic. Grok HAS a turn cap, so it
  uses both guards (max-turns + wall-clock); for heavy multi-file builds raise grokTimeoutSecs.
```

Update **Option 2 (Specify Mix)** to offer the two grok ids in the per-attempt loop:
"…the four codex effort levels, minimax-m3, **and the two grok variants
(grok-build / grok-composer-2.5-fast)**…".

### 5.2 `SKILL.md` Phase 2 dispatch paragraph

Add grok to the runner-list sentence and the args note: "…`codexRunner` =
`<plugin-root>/bin/codex-run.sh` if any attempt is Codex, **`grokRunner` =
`<plugin-root>/bin/grok-run.sh` if any attempt is Grok, `grokTimeoutSecs` = the Grok
wall-clock backstop (default 600); grok ALSO honours `attemptMaxTurns`/`grokMaxTurns`
(default 30) since it has `--max-turns`** …". And in the "attempts run through" sentence:
"…**Grok attempts run through the single `joust-grok` agent executing
`bin/grok-run.sh` (xAI `grok` headless CLI)**."

### 5.3 `SKILL.md` Phase 6 provenance-check bullet

Extend the "Provenance check (GLM, Local, and Codex)" bullet to include grok:

```
…for every Grok attempt, confirm `_grok_run.log` contains
`JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com` (and `JOUST-GROK-DONE exit=0`,
no `-TIMEOUT`/`-ERROR`). Grok is an autonomous external agent and can refuse, bail without
saving, or hit its wall-clock/turn cap — those are honest failures; exclude and note them.
```

### 5.4 `SKILL.md` Quick-reference table + bullets

- Phase 1 line: "ten options (… MiniMax, **Grok→variant submenu**)".
- Dispatch line: "… MiniMax attempts via the `bin/minimax-run.sh` runner, **Grok via the
  `grok` headless CLI runner**."

### 5.5 `references/orchestration.md`

a) **Model identifiers section** — add a Grok subsection after the MiniMax paragraph:

```
**Grok models (xAI, via the `grok` headless CLI)** — dispatched by shelling out to
`grok --prompt-file` through `bin/grok-run.sh`. TWO variants on a -m MODEL axis:
`grok-build` (xAI's agentic-coding model; `grok-code-fast-1` alias; 256K ctx) and
`grok-composer-2.5-fast` (Cursor Composer 2.5, Kimi K2.5 lineage; the CLI default). The
display model IS the dispatch key: `GROK_FLAG[displayModel]` -> `-m <id>`. Auth is the
operator's grok.com OAuth SESSION (`~/.grok/auth.json`); `XAI_API_KEY` (prefix `xai-`) is
the headless/CI fallback — the runner injects NEITHER and requires NEITHER (grok resolves
its own credential, exactly like codex reads `~/.codex/auth.json`). Default inference flows
over `cli-chat-proxy.grok.com` (NOT api.x.ai). ONE generic `joust-grok` agent serves
both variants; the provenance marker is
`JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com` in `_grok_run.log`. Unlike
codex, grok HAS `--max-turns`, so it uses BOTH per-attempt guards (`grokMaxTurns` default
30 + `grokTimeoutSecs` default 600). Grok bills the operator's SuperGrok / X Premium+ plan.
```

b) **ARGS shape** — add `grokRunner`, `grokTimeoutSecs`, `grokMaxTurns`, and a sample
`dispatch:'grok'` attempt entry (mirroring the codex/minimax entries already there).

c) **Model → agentType map** note — add: "(Local, Codex, MiniMax, **and Grok** attempts
each use one generic agent — … / `joust-engine:joust-grok` — for every model/variant)."

d) **A "Grok dispatch" paragraph** mirroring the codex one, stating the three-part fix
(runner `bin/grok-run.sh`; the single `joust-grok` Bash-only command-runner; the
`JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com` marker), plus grok specifics:
(1) it shells to `grok --prompt-file` (not `claude`), authenticating from the OAuth session
file or `XAI_API_KEY`, no env key required/injected; (2) confirmed-safe headless flags are
`--prompt-file _brief.txt -m <id> --output-format json --no-alt-screen --no-auto-update
--always-approve --max-turns <N> --disable-web-search --cwd "$PWD"`; (3) grok HAS
`--max-turns`, so it uses BOTH guards (the codex contrast); (4) the runner adds a defensive
grep for terminal auth/model/version failures forcing a non-zero exit.

e) **Per-attempt guards section** — note grok uses **both** layers (like glm/local/minimax),
not the codex wall-clock-only model, despite being an external non-`claude` CLI.

f) **Stdin paragraph** — add grok to the "all `claude`/`codex` runners" stdin-pin list:
"…uniform across glm/local/codex/minimax/**grok**."

---

## 6. EDIT — `bin/je-bench.mjs` (benchmark roster, both variants)

### 6.1 The catalogue entry

Add a `GROK_MODELS` array after `MINIMAX_MODELS`:

```js
// Grok (xAI) — `grok` headless CLI. Auth from the OAuth session (~/.grok/auth.json) OR
// XAI_API_KEY (CI fallback); no env key injected (mirrors codex's ~/.codex/auth.json).
// TWO variants on a -m model axis.
const GROK_MODELS = [
  { provider: 'grok', id: 'grok-build', model: 'grok-build' },
  { provider: 'grok', id: 'grok-composer-2.5-fast', model: 'grok-composer-2.5-fast' },
]
```

Add `'grok'` to `PROVIDERS` and `...GROK_MODELS` to `buildCatalogue()`'s `all`.

### 6.2 The dispatch function

Grok is its own dispatch (it is NOT a claude-family `--output-format json` array; it is the
`grok` CLI). Add `dispatchGrok` mirroring `dispatchCodex` (the closest peer — external CLI,
file auth, possibly-unreliable token accounting):

```js
// Grok (xAI) — `grok` headless CLI, auth from OAuth session OR XAI_API_KEY (no env key
// injected). We request --output-format json so we can read a usage/token event if present;
// grok's token reporting shape is UNCONFIRMED (V5), so if no machine-readable usage is found
// we fall back to a chars/4 estimate of the final message (estimated:true) — the same single
// legitimate estimation codex uses.
function dispatchGrok(target, timeoutSecs, cfg) {
  const promptFile = resolve(RESULTS_DIR, `_grok_prompt_${target.id}.txt`)
  // write cfg.prompt to promptFile (mkdirSync RESULTS_DIR first), then:
  const grokArgs = [
    '--prompt-file', promptFile,
    '-m', target.model,
    '--output-format', 'json',
    '--no-alt-screen',
    '--no-auto-update',
    '--always-approve',
    '--disable-web-search',
    // NOTE: no --max-turns here — the bench is a single generation, not an agentic loop;
    // grok's own single-turn --prompt-file is one turn. (The runner uses --max-turns; the
    // bench measures raw generation throughput, like the other dispatch functions.)
    cfg.prompt && '',  // prompt comes from --prompt-file, not an arg
  ].filter(Boolean)
  const argv = perlAlarmArgv(timeoutSecs, ['grok', ...grokArgs])
  // spawnSync('perl', argv, …); time the window; then:
  //  1) parse --output-format json for a usage/token_count/output_tokens field (V5);
  //  2) terminal auth/model/version phrase -> { ok:false, … } (mirror codex guard);
  //  3) fallback: chars/4 of the final message text -> { ok:true, estimated:true }.
}
```

and register it:

```js
const DISPATCH = { anthropic: dispatchAnthropic, glm: dispatchGlm, local: dispatchLocal,
                   codex: dispatchCodex, minimax: dispatchMinimax, grok: dispatchGrok }
```

### 6.3 Selection grammar / help / usage text

- `--models grok` -> both variants; `grok:grok-build` / `grok:grok-composer-2.5-fast` ->
  one. (Handled automatically by `resolveSelection` once `'grok'` is in `PROVIDERS` and the
  two ids are in the catalogue — no code change beyond §6.1/§6.2.)
- Update the USAGE / selection-grammar comment blocks to list `grok` as a provider and
  show an example (`je-bench.mjs --models grok:grok-build,grok:grok-composer-2.5-fast`).

> The bench deliberately does NOT pass `--max-turns` (single-turn generation throughput is
> the metric, matching how the other dispatch fns measure raw decode). The runner (§1) DOES
> pass it (it is an agentic attempt). Two different jobs, two different flag sets — same as
> codex (`-s read-only` in the bench vs `-s workspace-write` in the runner).

---

## 7. VALIDATION CHECKLIST (every UNCONFIRMED fact is a step, not an assumption)

These must be executed against the real `grok` binary *before* relying on the design.
Each maps to a concrete action and a fallback if it fails.

| #  | UNCONFIRMED fact (from research §B)                          | Validation step                                                                                                                              | If it fails / differs                                                                                          |
|----|-------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| V1 | `grok-composer-2.5-fast` **context window** (200K vs 1M)    | Run a known-length (>200K-token) input through each variant; observe truncation/refusal. Or read `grok inspect`/model metadata if exposed.    | Document the real ctx in orchestration.md; size `grokTimeoutSecs`/heavy-profile inputs accordingly. No code dep. |
| V2 | Grok Build **billing**: metered vs SuperGrok/Premium bundle | Run a few attempts, check the xAI/Cursor billing dashboard for metered charges vs subscription draw.                                          | Adjust the SKILL "Grok bills your …" note. Purely a docs/expectation fix.                                       |
| V3 | **Rate limits** for headless fan-out (1,800 RPM/10M TPM?)   | Fan out N=8 concurrent grok attempts; watch for 429/`rate_limit` in logs.                                                                     | If throttled, the SKILL already says "split N into smaller parallel batches" — reuse that. Add a grok note.      |
| V4 | OAuth **session-token lifetime** (may expire mid-run)       | Note `auth=oauth-session` in the log; run a long (grand-loop-length) chain; watch for a mid-run 401/`session expired`.                         | The §1.6 defensive grep force-fails an expired-session attempt (P=0). Operator stages `XAI_API_KEY` for CI.      |
| V5 | `--output-format json` **shape** (object vs stream)         | `grok -p "say hi" -m grok-build --output-format json --no-alt-screen --no-auto-update --disable-web-search` — inspect the JSON.               | Update `dispatchGrok`'s token-field walk (§6.2) to the real field; until then bench falls back to chars/4 est.   |
| V6 | `--prompt-file` exits after one turn like `-p`              | `printf 'Reply OK' > /tmp/b.txt; grok --prompt-file /tmp/b.txt -m grok-build --no-alt-screen --no-auto-update --disable-web-search; echo $?`   | If it does NOT exit, revert §0.3 to `-p "$(cat _brief.txt)"` in the runner (one-line change).                    |
| V7 | Non-zero **exit semantics** on refusal/tool-failure         | Force a refusal/error; record `echo $?` and the stderr/stdout phrases.                                                                        | Replace the placeholder phrase list in the §1.6 defensive grep with the real terminal strings.                  |
| V8 | Endpoint is **`cli-chat-proxy.grok.com`** for OAuth auth    | Run with verbose/trace if available, or confirm via xAI docs; confirm `api.x.ai` only on explicit `XAI_API_KEY`.                              | If the real endpoint differs, update the PROVENANCE literal (§1.4) AND the SKILL/orchestration strings to match. |
| V9 | MCP-init stderr noise (`unexpected content type: None`)     | Run the liveness probe; confirm the noise does not block completion (already CONFIRMED once) and does not pollute the JSON on stdout.         | If noise reaches stdout/JSON, add grok's MCP-disable flag (do NOT guess it — find it in `grok --help` first).    |
| V10| `--always-approve` alone is a sufficient headless bypass    | Run an attempt that needs a file write; confirm no permission prompt stalls it.                                                               | Add `--permission-mode bypassPermissions` (a CONFIRMED-present flag) to the runner invocation (§1.5).            |
| V11| `--disable-web-search` is the right hermetic default        | Confirm attempts still complete coding tasks with web search off.                                                                            | If a task legitimately needs web, expose a `grokWebSearch` arg; default stays off for diversity hermeticity.     |

**Liveness probe to keep handy** (already CONFIRMED to print `OK` exit 0):

```sh
grok -p "Reply with the single word OK and nothing else." -m grok-composer-2.5-fast \
  --disable-web-search --no-alt-screen --no-auto-update 2>/dev/null | tail -3
```

---

## 8. File-by-file change summary

| File                                    | Change                                                                                                   | New / Edit |
|-----------------------------------------|----------------------------------------------------------------------------------------------------------|------------|
| `bin/grok-run.sh`                       | the runner: OAuth/`XAI_API_KEY` auth, `grok --prompt-file -m <id> …`, both guards, PROVENANCE/DONE/TIMEOUT | **NEW**    |
| `agents/joust-grok.md`             | ONE generic haiku command-runner stub for both variants                                                   | **NEW**    |
| `workflows/tournament.mjs`              | `GROK_FLAG` map, `grokRunner`/`grokMaxTurns`/`grokTimeout`, `dispatch:'grok'` branch, validator GROK token | Edit       |
| `bin/je-parse.mjs`                      | `NORMALISER` grok/composer entries, `MODEL_TOKEN_RX` alternatives, "Known:" help text                     | Edit       |
| `skills/.../SKILL.md`                   | Phase 1 Option 10 + submenu, Specify-Mix line, Phase 2 dispatch, Phase 6 provenance, quick-ref            | Edit       |
| `skills/.../references/orchestration.md`| Grok model-identifier subsection, ARGS shape, agentType note, Grok-dispatch paragraph, guards/stdin notes | Edit       |
| `bin/je-bench.mjs`                      | `GROK_MODELS`, `dispatchGrok`, `PROVIDERS`+`buildCatalogue`+`DISPATCH` wiring, usage/grammar text          | Edit       |

**Invariants preserved:** no change to `provCheckShell`, the staging schema, `reconcile`,
the carryover logic, the persistence layer, `Z_MAX`/`N_MAX`, the diversity injection, the
grand-loop driver, or `je-git.sh`. Grok slots into the existing five-provider machinery as
a sixth provider (anthropic + glm + local + codex + minimax + **grok**) with zero structural
change — exactly the "mirror the patterns, don't invent a new style" mandate.

---

## 9. Open questions (concise)

- Default for bare `grok`: I chose **grok-build** (operator's "`/model grok`" = build). OK,
  or default to the CLI's own default (`grok-composer-2.5-fast`)?
- Fold grok into `top mixed`? I left the preset untouched (opus/glm-5.2/codex-high). Want a
  grok variant in it?
- Stage `XAI_API_KEY` in `~/.zshrc` now (for CI/session-expiry resilience), or stay
  OAuth-only until V4 bites?
- Add an `--effort` axis later (grok-build low/high), or keep the roster to the two ids?
