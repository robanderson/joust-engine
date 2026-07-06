#!/usr/bin/env bash
# Joust Engine GROK attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on an xAI Grok model via the `grok` headless CLI, under
# BOTH per-attempt guards (--max-turns) plus a portable wall-clock timeout AND a zero-output stall
# watchdog. Usage: grok-run.sh -m <grok-build|grok-composer-2.5-fast> [extra grok flags...]
# Timeout from JE_TIMEOUT_SECS (default 600); max-turns from JE_MAX_TURNS (default 30).
set -uo pipefail
FLAG="${*:--m grok-composer-2.5-fast}"   # default to the CLI's own default model
LOG=_grok_run.log
PROV=GROK
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_je-run-lib.sh"           # provides finish() + guaranteed-terminal traps + run_watchdog_perl
unset ANTHROPIC_API_KEY            # fold-in B: never leak the Anthropic key into a non-Anthropic child

TIMEOUT="${JE_TIMEOUT_SECS:-600}"   # wall-clock backstop (seconds)
STALL="${JE_STALL_SECS:-90}"        # zero-output stall window (seconds)
MAXTURNS="${JE_MAX_TURNS:-30}"      # PRIMARY guard: cap agentic iterations (grok HAS --max-turns)

[ -f _brief.txt ] || { finish DONE "exit=4 (missing-brief)" 07 missing-brief; exit 4; }
command -v grok >/dev/null 2>&1 || { finish DONE "exit=5 (missing-runner)" 07 missing-runner; exit 5; }

# Auth: grok resolves its OWN credential (model.api_key > env_key > OAuth session > XAI_API_KEY). On an
# OAuth-only box NO key is set and that is NORMAL — so, unlike glm/minimax, require NEITHER credential.
if [ -n "${XAI_API_KEY:-}" ]; then AUTHMODE="env-key"; else AUTHMODE="oauth-session"; fi

# Web search OFF by default (hermetic/fair); opt IN with JE_GROK_WEB=1.
if [ "${JE_GROK_WEB:-0}" = "1" ]; then WEBFLAG=""; WEBMODE="on"; else WEBFLAG="--disable-web-search"; WEBMODE="off"; fi

# Write the PROVENANCE marker UNCONDITIONALLY, up front (missing log => runner never ran => fail closed).
PROV_LINE="JOUST-GROK-PROVENANCE endpoint=cli-chat-proxy.grok.com auth=${AUTHMODE} web=${WEBMODE} flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s stall=${STALL}s"
echo "$PROV_LINE" >> "$LOG"

# Headless grok policy (every flag CONFIRMED in `grok --help`). </dev/null pins stdin; $FLAG unquoted so
# the shell word-splits `-m grok-build` into argv before exec.
run_try() {
  run_watchdog_perl "$TIMEOUT" "$STALL" "$LOG" \
    grok -p "$(cat _brief.txt)" $FLAG \
      --always-approve \
      --max-turns "$MAXTURNS" \
      $WEBFLAG \
      --no-subagents \
      --no-alt-screen \
      --no-auto-update \
      --cwd "$PWD" </dev/null >> "$LOG" 2>&1
}

TIMEOUT_RETRIED=0
STALL_RETRIED=0
RC=0
while :; do
  LINES_BEFORE=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
  run_try
  RC=$?
  # Defensive fail-closed auth/model/version force-fail (non-retryable). GUARDED on "no deliverable file
  # other than the engine files exists" (grok has no codex-style -o capture). Scanned against the fresh slice.
  if tail -n +"$((LINES_BEFORE + 1))" "$LOG" | grep -qiE '401 Unauthorized|403 Forbidden|invalid api key|model .* (not found|unavailable)|session (expired|token expired)|requires a newer version of Grok' \
     && ! find . -type f ! -name '_brief.txt' ! -name '_grok_run.log' | grep -q .; then
    echo "JOUST-GROK-ERROR grok reported a model/auth/version failure (see log)" >> "$LOG"
    [ "$RC" -eq 0 ] && RC=6
    finish DONE "exit=${RC}" 02 provider-auth-endpoint
    break
  fi
  if [ "$RC" -eq 0 ]; then finish DONE "exit=0" 00 ok; break; fi
  if [ "$RC" -eq 124 ]; then
    if [ "$TIMEOUT_RETRIED" -eq 0 ]; then TIMEOUT_RETRIED=1; echo "JOUST-GROK-RETRY reason=wall-clock-timeout" >> "$LOG"; continue; fi
    finish TIMEOUT "secs=${TIMEOUT} (after 1 retry)" 01 wall-clock-timeout-retry-exhausted; break
  fi
  if [ "$RC" -eq 125 ]; then
    if [ "$STALL_RETRIED" -eq 0 ]; then STALL_RETRIED=1; echo "JOUST-GROK-RETRY reason=zero-output-stall" >> "$LOG"; continue; fi
    finish KILLED "reason=zero-output-stall (after 1 retry)" 01 zero-output-stall-retry-exhausted; break
  fi
  if grep -q 'Reached max turns' "$LOG"; then finish DONE "exit=${RC}" 03 turn-cap; else finish DONE "exit=${RC}" 09 runner-error; fi
  break
done

tail -20 "$LOG"
exit "$RC"
