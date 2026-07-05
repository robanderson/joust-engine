#!/usr/bin/env bash
# Joust Engine LOCAL (omlx / MLX) attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on a local MLX model via the Claude CLI pointed at the
# local omlx server (http://127.0.0.1:8000), under a hard wall-clock timeout AND a zero-output stall
# watchdog. Usage: local-run.sh <claude --model flag...>  Timeout from JE_TIMEOUT_SECS (default 300).
set -uo pipefail
FLAG="${*:---model gemma-4-26b-a4b-it-8bit}"
LOG=_local_run.log
PROV=LOCAL
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_je-run-lib.sh"           # provides finish() + guaranteed-terminal traps + run_watchdog_perl
unset ANTHROPIC_API_KEY            # fold-in B: never leak the Anthropic key into a non-Anthropic child

TIMEOUT="${JE_TIMEOUT_SECS:-300}"   # wall-clock backstop (seconds)
STALL="${JE_STALL_SECS:-60}"        # zero-output stall window (seconds)
MAXTURNS="${JE_MAX_TURNS:-20}"       # tight cap: local models tend to ignore "single pass" and loop

# OMLX_AUTH_TOKEN comes from the environment — uniform key handling across every runner.
[ -z "${OMLX_AUTH_TOKEN:-}" ] && { finish DONE "exit=3 (missing-key)" 07 missing-key; exit 3; }
[ -f _brief.txt ]           || { finish DONE "exit=4 (missing-brief)" 07 missing-brief; exit 4; }

echo "JOUST-LOCAL-PROVENANCE endpoint=127.0.0.1:8000 flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s stall=${STALL}s" >> "$LOG"

run_try() {
  ANTHROPIC_BASE_URL="http://127.0.0.1:8000" \
  ANTHROPIC_AUTH_TOKEN="$OMLX_AUTH_TOKEN" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="Qwen3.5-122B-A10B-LM-MLX-6.5bit" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="mlx-community--Qwen3.6-35B-A3B-8bit" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="gemma-4-26b-a4b-it-8bit" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" API_TIMEOUT_MS="3000000" \
  run_watchdog_perl "$TIMEOUT" "$STALL" "$LOG" \
    claude -p "$(cat _brief.txt)" $FLAG --max-turns "$MAXTURNS" --permission-mode acceptEdits --allowedTools "Bash Read Write Edit" </dev/null >> "$LOG" 2>&1
}

TIMEOUT_RETRIED=0
STALL_RETRIED=0
RC=0
while :; do
  run_try
  RC=$?
  if [ "$RC" -eq 0 ]; then finish DONE "exit=0" 00 ok; break; fi
  if [ "$RC" -eq 124 ]; then
    if [ "$TIMEOUT_RETRIED" -eq 0 ]; then TIMEOUT_RETRIED=1; echo "JOUST-LOCAL-RETRY reason=wall-clock-timeout" >> "$LOG"; continue; fi
    finish TIMEOUT "secs=${TIMEOUT} (after 1 retry)" 01 wall-clock-timeout-retry-exhausted; break
  fi
  if [ "$RC" -eq 125 ]; then
    if [ "$STALL_RETRIED" -eq 0 ]; then STALL_RETRIED=1; echo "JOUST-LOCAL-RETRY reason=zero-output-stall" >> "$LOG"; continue; fi
    finish KILLED "reason=zero-output-stall (after 1 retry)" 01 zero-output-stall-retry-exhausted; break
  fi
  if grep -q 'Reached max turns' "$LOG"; then finish DONE "exit=${RC}" 03 turn-cap; else finish DONE "exit=${RC}" 09 runner-error; fi
  break
done

tail -20 "$LOG"
exit "$RC"
