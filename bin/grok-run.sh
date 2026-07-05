#!/usr/bin/env bash
# Joust Engine GROK attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on an xAI Grok model via the `grok` headless CLI
# (`grok -p`), under BOTH per-attempt guards: --max-turns (grok HAS one, unlike codex) and a portable
# wall-clock timeout. Usage: grok-run.sh -m <grok-build|grok-composer-2.5-fast> [extra grok flags...]
# Timeout (seconds) from JE_TIMEOUT_SECS (default 600); max-turns from JE_MAX_TURNS (default 30).
set -uo pipefail
FLAG="${*:--m grok-composer-2.5-fast}"   # default to the CLI's own default model
LOG=_grok_run.log
TIMEOUT="${JE_TIMEOUT_SECS:-600}"   # wall-clock backstop (seconds)
MAXTURNS="${JE_MAX_TURNS:-30}"      # PRIMARY guard: cap agentic iterations (grok HAS --max-turns)

# ---- JE-RC observability: append exactly one terminal `JOUST-RC <code> <reason>` line on EVERY exit
# path (complements the JOUST-GROK-DONE/TIMEOUT markers). `JOUST-` is deliberately NOT rebranded, so
# this marker is byte-identical prod vs dev-rebranded. `_rc_emitted` is a plain lowercase var so
# rebrand's JE_->DE_ rule cannot touch it. Missing line parses as RC 09 in the engine (a runner bug).
_rc_emitted=0
emit_rc() {                     # emit_rc <code> <reason>; idempotent (first call wins)
  [ "$_rc_emitted" = "1" ] && return 0
  _rc_emitted=1
  printf 'JOUST-RC %s %s\n' "$1" "$2" >> "$LOG"
}
trap 'emit_rc 08 signal-abort' INT TERM
trap 'emit_rc 09 unclassified' EXIT

[ -f _brief.txt ] || { echo "JOUST-GROK-ERROR _brief.txt missing" | tee -a "$LOG"; emit_rc 07 missing-brief; exit 4; }
command -v grok >/dev/null 2>&1 || { echo "JOUST-GROK-ERROR grok CLI not found on PATH" | tee -a "$LOG"; emit_rc 07 missing-runner; exit 5; }

# Auth (the grok-specific part): grok resolves its OWN credential in order
#   model.api_key > model.env_key > active OAuth session (~/.grok/auth.json) > XAI_API_KEY (xai- prefix).
# On an OAuth-only box NO key is set and that is the NORMAL state — so, UNLIKE glm/minimax (which hard-fail
# on a missing env key), this runner requires NEITHER credential and injects NEITHER, exactly as codex-run.sh
# reads ~/.codex/auth.json with no env key. A present XAI_API_KEY is already inherited from the env and grok
# picks it up via its own resolution order (never sourced/grepped from rc files — uniform key handling).
# Record which mode was used (for the session-expiry diagnosis the OAuth path needs); does NOT gate.
if [ -n "${XAI_API_KEY:-}" ]; then AUTHMODE="env-key"; else AUTHMODE="oauth-session"; fi

# Web search is OFF by default — hermetic, and consistent with the other runner-based providers
# (glm/minimax/local restrict --allowedTools to Bash/Read/Write/Edit; codex sets mcp_servers={}), so a
# MIXED blind review stays fair (grok gets no live-web edge the others structurally lack) and reproducible.
# Opt IN per run with JE_GROK_WEB=1 (the workflow's grokWebSearch:true) for tasks that need LIVE web at
# attempt time (validate a URL/doc, check a link) — something the shared contextFiles bundle cannot pre-provide.
if [ "${JE_GROK_WEB:-0}" = "1" ]; then WEBFLAG=""; WEBMODE="on"; else WEBFLAG="--disable-web-search"; WEBMODE="off"; fi

# Write the PROVENANCE marker UNCONDITIONALLY, up front: a missing log at this path proves the runner
# never ran (a native-solve spoof or refusal) and must fail closed (P=0) downstream. Column-0 + provider-
# specific token so the staging validator's '^JOUST-GROK-' grep is mention-proof.
echo "JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com auth=${AUTHMODE} web=${WEBMODE} flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s" >> "$LOG"

# Headless grok policy (every flag CONFIRMED present in `grok --help`):
#   -p "<brief>"        : single non-interactive invocation; runs agentically (tools) under --max-turns then exits.
#   $FLAG (-m <id>)     : the model variant, pinned so grok never silently uses config.toml's default model.
#   --always-approve    : auto-approve ALL tool executions — the headless permission bypass (grok's analog of
#                         codex approval_policy="never" / claude --permission-mode acceptEdits).
#   --max-turns N       : PRIMARY iteration guard. Grok HAS this (codex does not) — the deliverable written
#                         before the cap is preserved.
#   $WEBFLAG            : web search. OFF by default (--disable-web-search) for a hermetic, fair blind review
#                         consistent with the other runner-based providers; set JE_GROK_WEB=1 to enable it.
#   --no-subagents      : an JE attempt is ONE independent piece of work; grok-build can otherwise spawn up to
#                         8 parallel sub-agents (an internal swarm), which both fights JE's "N independent
#                         attempts" model AND is the main variable-latency surface (a fanned-out run can
#                         balloon to minutes on a non-trivial task; a single agent loop stays ~15-30s).
#                         NOTE: we deliberately do NOT pass --no-plan (it toggles grok's read-only plan
#                         PERMISSION mode, not the model's reasoning; JE runs planning tasks — a measured A/B
#                         showed it gave NO speed benefit yet thinner plans) nor --no-memory (cross-session
#                         memory is the opt-in --experimental-memory feature, OFF by default → --no-memory is a no-op).
#   --no-alt-screen     : run INLINE — no fullscreen TUI takeover (mandatory under the `>> LOG` redirect).
#   --no-auto-update    : skip the background update check (CI gotcha) so a script run never stalls/mutates.
#   --cwd "$PWD"        : scope the agent's working root to this attempt workspace (analog of codex -C "$PWD").
# Portable hard timeout (macOS has no coreutils `timeout`): fork the call, SIGALRM -> TERM/KILL. $FLAG is
# unquoted so the outer shell word-splits `-m grok-build` into separate argv elements before perl exec.
# </dev/null pins grok's stdin: with a prompt ARG but an OPEN (non-TTY) stdin an agentic CLI can block
# waiting on stdin and stall the whole wall-clock (the bug that hit glm/codex/minimax). Close it here.
perl -e '
  my $t = shift @ARGV;
  my $p = fork; if (!defined $p) { exit 127 }
  if ($p == 0) { exec @ARGV; exit 127 }
  $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
  alarm $t; waitpid($p, 0); exit($? >> 8);
' "$TIMEOUT" grok -p "$(cat _brief.txt)" $FLAG \
    --always-approve \
    --max-turns "$MAXTURNS" \
    $WEBFLAG \
    --no-subagents \
    --no-alt-screen \
    --no-auto-update \
    --cwd "$PWD" </dev/null >> "$LOG" 2>&1
RC=$?

# Defensive fail-closed (belt-and-suspenders beyond the exit code): if grok hit a terminal auth/model/version
# failure, force a nonzero RC so the provenance gate (DONE exit=0) rejects it even on the rare path where grok
# returns such an error yet still exits 0. GUARDED on "no deliverable file other than the engine files exists"
# (grok has no codex-style `-o` capture, so this stands in for codex's `[ ! -s "$LAST" ]` mention-proof guard):
# a SUCCESSFUL run that merely *discusses* these phrases in its deliverable is never force-failed. The phrase
# list is a VALIDATION ITEM — replace the placeholders with grok's real terminal strings once observed.
if grep -qiE '401 Unauthorized|403 Forbidden|invalid api key|model .* (not found|unavailable)|session (expired|token expired)|requires a newer version of Grok' "$LOG" \
   && ! find . -type f ! -name '_brief.txt' ! -name '_grok_run.log' | grep -q .; then
  echo "JOUST-GROK-ERROR grok reported a model/auth/version failure (see log)" >> "$LOG"
  [ "$RC" -eq 0 ] && RC=6
  emit_rc 02 provider-auth-endpoint
fi

[ "$RC" -eq 124 ] && echo "JOUST-GROK-TIMEOUT secs=${TIMEOUT}" >> "$LOG"
# Classify (the 02 force-fail above, if any, already won idempotently). Grok HAS --max-turns, so a
# turn-cap exhaustion (03) is an honest model loss; anything else non-zero is a runner-level error (09).
if [ "$RC" -eq 0 ]; then emit_rc 00 ok
elif [ "$RC" -eq 124 ]; then emit_rc 01 wall-clock-timeout
elif grep -q 'Reached max turns' "$LOG"; then emit_rc 03 turn-cap
else emit_rc 09 runner-error; fi
echo "JOUST-GROK-DONE exit=$RC" >> "$LOG"
tail -20 "$LOG"
