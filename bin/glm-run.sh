#!/usr/bin/env bash
# Joust Engine GLM attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on a z.ai GLM model via the Claude CLI
# pointed at z.ai, under a hard wall-clock timeout AND a zero-output stall watchdog.
# Usage: glm-run.sh <claude --model flag...>  Timeout (seconds) from JE_TIMEOUT_SECS (default 300).
#
# Transient-overload handling (issue #25): z.ai enforces PLAN-TIER CONCURRENCY limits and sheds excess
# load with HTTP 529 "temporarily overloaded". A tournament fans N parallel attempts, so 529s are
# expected backpressure. Startup jitter + bounded exponential backoff retry on a TRANSIENT marker.
# Wall-clock (124) AND zero-output stall (125) each retry ONCE (see bin/_je-run-lib.sh); hard errors
# (bad key/flag/auth) never retry.
set -uo pipefail
FLAG="${*:---model glm-5}"
LOG=_glm_run.log
PROV=GLM
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_je-run-lib.sh"           # provides finish() + guaranteed-terminal traps + run_watchdog_perl
unset ANTHROPIC_API_KEY            # fold-in B: never leak the Anthropic key into a non-Anthropic child

TIMEOUT="${JE_TIMEOUT_SECS:-300}"   # wall-clock backstop (seconds), PER TRY
STALL="${JE_STALL_SECS:-240}"       # zero-output stall window (seconds), PER TRY. 240 is safe again:
                                    # --output-format stream-json makes claude emit incremental JSON
                                    # events (incl. partial-message deltas) into $LOG during work, so
                                    # the watchdog measures TRUE liveness — a long silent prefill/think
                                    # no longer looks like a hang (the 480s interim bump is reverted).
MAXTURNS="${JE_MAX_TURNS:-30}"       # primary guard: cap agentic iterations (single-pass)
RETRIES="${JE_GLM_RETRIES:-3}"       # max ADDITIONAL tries after the first, for 529s (<=4 total)
BACKOFF="${JE_GLM_BACKOFF_BASE:-15}" # first retry delay (seconds); doubles per retry
JITTER_MAX="${JE_GLM_JITTER_MAX:-10}" # random 0..N s added to startup + each backoff

[ -z "${ZAI_API_KEY:-}" ] && { finish DONE "exit=3 (missing-key)" 07 missing-key; exit 3; }
[ -f _brief.txt ]        || { finish DONE "exit=4 (missing-brief)" 07 missing-brief; exit 4; }
# security-sweep H1: capture our token, then strip EVERY secret name (incl. our raw ZAI_API_KEY) from
# the env so the acceptEdits child cannot exfiltrate cross-provider/forge/cloud creds.
_prov_token="$ZAI_API_KEY"; je_scrub_child_secrets

# Portable random 0..N seconds (macOS has no shuf; sh has no reliable $RANDOM).
jitter() { perl -e 'print int(rand($ARGV[0]+1))' "$1"; }

PROV_LINE="JOUST-GLM-PROVENANCE endpoint=api.z.ai flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s stall=${STALL}s retries=${RETRIES}"
echo "$PROV_LINE" >> "$LOG"

# Startup jitter: stagger parallel sibling attempts' first call.
if [ "$JITTER_MAX" -gt 0 ] 2>/dev/null; then
  J=$(jitter "$JITTER_MAX")
  [ "$J" -gt 0 ] && { echo "JOUST-GLM-JITTER startup=${J}s" >> "$LOG"; sleep "$J"; }
fi

# One try. The perl fork+SIGALRM wrapper now lives in run_watchdog_perl (adds the stall watchdog +
# process-group kill). </dev/null pins claude's stdin so it never stalls waiting on a non-TTY stdin.
# --verbose --output-format stream-json --include-partial-messages: stream incremental JSON events
# (stream-json requires --verbose in -p mode; partial messages give intra-turn liveness during long
# thinking) so $LOG grows while claude works and the stall watchdog sees real liveness instead of the
# old buffered-until-done text output.
run_try() {
  ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" \
  ANTHROPIC_AUTH_TOKEN="$_prov_token" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2[1m]" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="glm-4.7" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.5-air" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
  API_TIMEOUT_MS="${JE_API_TIMEOUT_MS:-3000000}" \
  run_watchdog_perl "$TIMEOUT" "$STALL" "$LOG" \
    claude -p "$(cat _brief.txt)" $FLAG --verbose --output-format stream-json --include-partial-messages --max-turns "$MAXTURNS" --permission-mode acceptEdits --allowedTools "Bash Read Write Edit" </dev/null >> "$LOG" 2>&1
}

TIMEOUT_RETRIED=0
STALL_RETRIED=0
TRY=1
MAXTRIES=$((RETRIES + 1))
RC=0
while :; do
  LINES_BEFORE=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
  run_try
  RC=$?
  if [ "$RC" -eq 0 ]; then finish DONE "exit=0" 00 ok; break; fi
  # Wall-clock hang (124): retryable ONCE, then terminal (matches 529 policy).
  if [ "$RC" -eq 124 ]; then
    if [ "$TIMEOUT_RETRIED" -eq 0 ]; then
      TIMEOUT_RETRIED=1
      echo "JOUST-GLM-RETRY reason=wall-clock-timeout" >> "$LOG"
      continue
    fi
    finish TIMEOUT "secs=${TIMEOUT} (after 1 retry)" 01 wall-clock-timeout-retry-exhausted
    break
  fi
  # Zero-output stall (125): watchdog killed the group; retryable ONCE, then terminal.
  if [ "$RC" -eq 125 ]; then
    if [ "$STALL_RETRIED" -eq 0 ]; then
      STALL_RETRIED=1
      echo "JOUST-GLM-RETRY reason=zero-output-stall" >> "$LOG"
      continue
    fi
    finish KILLED "reason=zero-output-stall (after 1 retry)" 01 zero-output-stall-retry-exhausted
    break
  fi
  # 529/transient backpressure: retry with backoff ONLY on a transient marker in THIS try's slice.
  # stream-json shapes (verified live vs a local 529/400 server, CLI 2.1.201): internal retries emit
  # {"type":"system","subtype":"api_retry",...,"error_status":529,"error":"overloaded"} events; a
  # terminal API failure emits a result event whose "result" field still carries the plain
  # "API Error: <code> ..." text, so the old alternatives still match. The quoted "error_status" key is
  # mention-proof by construction: task-content text quoting it lands JSON-ESCAPED (\"error_status\")
  # inside a string and cannot match the unescaped pattern.
  if tail -n +"$((LINES_BEFORE + 1))" "$LOG" | grep -qE 'API Error: *(429|500|502|503|529)|overloaded|API Error:.*(timed out|timeout)|"(api_)?error_status": *(429|500|502|503|529)'; then
    if [ "$TRY" -ge "$MAXTRIES" ]; then
      echo "JOUST-GLM-RETRIES-EXHAUSTED tries=${TRY}" >> "$LOG"
      finish DONE "exit=${RC}" 02 retries-exhausted
      break
    fi
    DELAY=$(( BACKOFF * (1 << (TRY - 1)) ))
    [ "$JITTER_MAX" -gt 0 ] 2>/dev/null && DELAY=$(( DELAY + $(jitter "$JITTER_MAX") ))
    TRY=$((TRY + 1))
    echo "JOUST-GLM-RETRY try=${TRY}/${MAXTRIES} backoff=${DELAY}s reason=transient-overload" >> "$LOG"
    sleep "$DELAY"
    continue
  fi
  # Unclassified non-transient failure: turn-cap (03) is an honest model loss; else runner error (09).
  # stream-json signals turn-cap as {"type":"result","subtype":"error_max_turns",...} — the plain
  # "Reached max turns" text is GONE (verified live, CLI 2.1.201); keep both patterns. The quoted-JSON
  # form is mention-proof: task content quoting it gets escaped (\"subtype\") and cannot match.
  if tail -n +"$((LINES_BEFORE + 1))" "$LOG" | grep -qE 'Reached max turns|"subtype":"error_max_turns"'; then
    finish DONE "exit=${RC}" 03 turn-cap
  else
    finish DONE "exit=${RC}" 09 runner-error
  fi
  break
done

tail -20 "$LOG"
exit "$RC"
