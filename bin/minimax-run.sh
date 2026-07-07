#!/usr/bin/env bash
# Joust Engine MINIMAX attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on MiniMax-M3 via the Claude CLI pointed at the MiniMax
# Anthropic-compatible endpoint, under a hard wall-clock timeout AND a zero-output stall watchdog.
# MiniMax exposes ONE model (all aliases map to MiniMax-M3, ANTHROPIC_MODEL pins it). No --model flag.
# Usage: minimax-run.sh [extra claude flags...]  Timeout from JE_TIMEOUT_SECS (default 300).
set -uo pipefail
FLAG="${*:-}"
LOG=_minimax_run.log
PROV=MINIMAX
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_je-run-lib.sh"           # provides finish() + guaranteed-terminal traps + run_watchdog_perl
unset ANTHROPIC_API_KEY            # fold-in B: never leak the Anthropic key into a non-Anthropic child

TIMEOUT="${JE_TIMEOUT_SECS:-300}"   # wall-clock backstop (seconds)
STALL="${JE_STALL_SECS:-180}"       # zero-output stall window (seconds); 180 is safe again: stream-json
                                    # makes claude emit incremental JSON events into $LOG during work, so
                                    # the watchdog measures true liveness (300s interim bump reverted)
MAXTURNS="${JE_MAX_TURNS:-30}"       # primary guard: cap agentic iterations (single-pass)

[ -z "${MINIMAX_API_KEY:-}" ] && { finish DONE "exit=3 (missing-key)" 07 missing-key; exit 3; }
# security-sweep H1: capture token, strip all other secrets from the acceptEdits child env.
_prov_token="$MINIMAX_API_KEY"; je_scrub_child_secrets
[ -f _brief.txt ]            || { finish DONE "exit=4 (missing-brief)" 07 missing-brief; exit 4; }

PROV_LINE="JOUST-MINIMAX-PROVENANCE endpoint=api.minimax.io model=MiniMax-M3 max-turns=${MAXTURNS} timeout=${TIMEOUT}s stall=${STALL}s"
echo "$PROV_LINE" >> "$LOG"

# --verbose --output-format stream-json --include-partial-messages: stream incremental JSON events
# (stream-json requires --verbose in -p mode; partial messages give intra-turn liveness during long
# thinking) so $LOG grows while claude works and the stall watchdog sees real liveness.
run_try() {
  ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic" \
  ANTHROPIC_AUTH_TOKEN="$_prov_token" \
  ANTHROPIC_MODEL="MiniMax-M3" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="MiniMax-M3" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="MiniMax-M3" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="MiniMax-M3" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
  CLAUDE_CODE_AUTO_COMPACT_WINDOW="512000" \
  API_TIMEOUT_MS="3000000" \
  run_watchdog_perl "$TIMEOUT" "$STALL" "$LOG" \
    claude -p "$(cat _brief.txt)" $FLAG --verbose --output-format stream-json --include-partial-messages --max-turns "$MAXTURNS" --permission-mode acceptEdits --allowedTools "Bash Read Write Edit" </dev/null >> "$LOG" 2>&1
}

TIMEOUT_RETRIED=0
STALL_RETRIED=0
RC=0
while :; do
  run_try
  RC=$?
  if [ "$RC" -eq 0 ]; then finish DONE "exit=0" 00 ok; break; fi
  if [ "$RC" -eq 124 ]; then
    if [ "$TIMEOUT_RETRIED" -eq 0 ]; then TIMEOUT_RETRIED=1; echo "JOUST-MINIMAX-RETRY reason=wall-clock-timeout" >> "$LOG"; continue; fi
    finish TIMEOUT "secs=${TIMEOUT} (after 1 retry)" 01 wall-clock-timeout-retry-exhausted; break
  fi
  if [ "$RC" -eq 125 ]; then
    if [ "$STALL_RETRIED" -eq 0 ]; then STALL_RETRIED=1; echo "JOUST-MINIMAX-RETRY reason=zero-output-stall" >> "$LOG"; continue; fi
    finish KILLED "reason=zero-output-stall (after 1 retry)" 01 zero-output-stall-retry-exhausted; break
  fi
  # stream-json signals turn-cap as {"type":"result","subtype":"error_max_turns",...}; the plain text
  # is gone (verified live, CLI 2.1.201). Quoted-JSON form is mention-proof (task quotes get escaped).
  if grep -qE '"subtype":"error_max_turns"' "$LOG"; then finish DONE "exit=${RC}" 03 turn-cap; else finish DONE "exit=${RC}" 09 runner-error; fi
  break
done

tail -20 "$LOG"
exit "$RC"
