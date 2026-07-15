#!/usr/bin/env bash
# Joust Engine CLAUDEX attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on an OpenAI-family model (gpt-5.6-sol/terra/luna) with
# CLAUDE CODE AS THE AGENT HARNESS, via the Claude CLI pointed at a local CLIProxyAPI instance that
# exposes the Anthropic API (/v1/messages) at its ROOT. Runs under a hard wall-clock timeout AND a
# zero-output stall watchdog. Usage: claudex-run.sh <claude --model flag...>
# Timeout (seconds) from JE_TIMEOUT_SECS (default 300).
#
# Env contract (all generic — no machine-specific paths/hostnames baked in):
#   JE_CLAUDEX_BASE_URL    proxy endpoint       (default http://127.0.0.1:8317)
#   JE_CLAUDEX_TOKEN_FILE  client-token file    (default $HOME/.config/cliproxyapi/client-token)
# The token FILE's contents become ANTHROPIC_AUTH_TOKEN for the child, read at exec time and never
# echoed/logged. A missing/unreadable token file exits 3; an unreachable proxy exits 5 — a
# misconfigured host fails loudly up front instead of hanging into the watchdog.
#
# Transient-overload handling (mirrors glm-run.sh): upstream overload/ratelimit surfaces THROUGH the
# proxy as HTTP 5xx/429, so the same TRANSIENT marker class gets bounded exponential backoff with
# startup jitter. Wall-clock (124) AND zero-output stall (125) each retry ONCE (see
# bin/_je-run-lib.sh); hard errors (bad token/flag/auth) never retry.
set -uo pipefail
FLAG="${*:---model gpt-5.6-sol}"
LOG=_claudex_run.log
PROV=CLAUDEX
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_je-run-lib.sh"           # provides finish() + guaranteed-terminal traps + run_watchdog_perl
unset ANTHROPIC_API_KEY            # fold-in B: the REAL Anthropic key must never reach the proxy child

BASE_URL="${JE_CLAUDEX_BASE_URL:-http://127.0.0.1:8317}"
TOKEN_FILE="${JE_CLAUDEX_TOKEN_FILE:-$HOME/.config/cliproxyapi/client-token}"

TIMEOUT="${JE_TIMEOUT_SECS:-300}"   # wall-clock backstop (seconds), PER TRY
STALL="${JE_STALL_SECS:-240}"       # zero-output stall window (seconds), PER TRY: stream-json makes
                                    # claude emit incremental JSON events (incl. partial-message
                                    # deltas) into $LOG during work, so the watchdog measures TRUE
                                    # liveness — a long silent prefill/think doesn't look like a hang.
MAXTURNS="${JE_MAX_TURNS:-30}"       # primary guard: cap agentic iterations (single-pass)
RETRIES="${JE_CLAUDEX_RETRIES:-3}"       # max ADDITIONAL tries after the first, for 5xx/429 (<=4 total)
BACKOFF="${JE_CLAUDEX_BACKOFF_BASE:-15}" # first retry delay (seconds); doubles per retry
JITTER_MAX="${JE_CLAUDEX_JITTER_MAX:-10}" # random 0..N s added to startup + each backoff

# Fail-fast guard 1: the client-token file must exist, be readable, and be non-empty. NEVER echo its
# contents anywhere (stderr, $LOG, provenance) — only the PATH is safe to print.
if [ ! -r "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
  echo "claudex-run.sh: client-token file missing/unreadable/empty: $TOKEN_FILE (set JE_CLAUDEX_TOKEN_FILE)" >&2
  finish DONE "exit=3 (missing-token-file)" 07 missing-token-file
  exit 3
fi
[ -f _brief.txt ] || { finish DONE "exit=4 (missing-brief)" 07 missing-brief; exit 4; }
# Fail-fast guard 2: the proxy endpoint must at least answer TCP/HTTP (any status code counts; only a
# connect-class failure — refused/unresolvable/timeout — trips this). No credential rides in the probe.
if ! curl -s -o /dev/null --connect-timeout 5 --max-time 10 "$BASE_URL" 2>/dev/null; then
  echo "claudex-run.sh: proxy endpoint unreachable: $BASE_URL (set JE_CLAUDEX_BASE_URL; is CLIProxyAPI running?)" >&2
  finish DONE "exit=5 (proxy-unreachable)" 07 proxy-unreachable
  exit 5
fi

# security-sweep H1: capture our token (read from the file AT EXEC TIME), then strip EVERY secret name
# from the env so the acceptEdits child cannot exfiltrate cross-provider/forge/cloud creds. $(cat)
# strips trailing newlines, which client-token files typically carry.
_prov_token="$(cat "$TOKEN_FILE")"; je_scrub_child_secrets

# The model in FLAG must also flow into CLAUDE_CODE_SUBAGENT_MODEL so Task-tool children the harness
# spawns stay on the SAME proxy model (last --model wins, matching the claude CLI itself).
MODEL="gpt-5.6-sol"
_prev=""
for _w in $FLAG; do
  [ "$_prev" = "--model" ] && MODEL="$_w"
  _prev="$_w"
done

# Portable random 0..N seconds (macOS has no shuf; sh has no reliable $RANDOM).
jitter() { perl -e 'print int(rand($ARGV[0]+1))' "$1"; }

PROV_LINE="JOUST-CLAUDEX-PROVENANCE endpoint=${BASE_URL#*://} flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s stall=${STALL}s retries=${RETRIES}"
echo "$PROV_LINE" >> "$LOG"

# Startup jitter: stagger parallel sibling attempts' first call.
if [ "$JITTER_MAX" -gt 0 ] 2>/dev/null; then
  J=$(jitter "$JITTER_MAX")
  [ "$J" -gt 0 ] && { echo "JOUST-CLAUDEX-JITTER startup=${J}s" >> "$LOG"; sleep "$J"; }
fi

# One try. Env is the published claudex recipe: base-url+token to the local proxy, the FLAG model
# mirrored into CLAUDE_CODE_SUBAGENT_MODEL, effort always enabled (the proxy also honours
# "model(effort)" names), bounded tool concurrency, tool search off. </dev/null pins claude's stdin;
# --verbose --output-format stream-json --include-partial-messages stream incremental JSON events so
# $LOG grows while claude works and the stall watchdog sees real liveness.
run_try() {
  ANTHROPIC_BASE_URL="$BASE_URL" \
  ANTHROPIC_AUTH_TOKEN="$_prov_token" \
  CLAUDE_CODE_SUBAGENT_MODEL="$MODEL" \
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT="1" \
  CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY="3" \
  ENABLE_TOOL_SEARCH="false" \
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
  # Wall-clock hang (124): retryable ONCE, then terminal (matches the transient policy).
  if [ "$RC" -eq 124 ]; then
    if [ "$TIMEOUT_RETRIED" -eq 0 ]; then
      TIMEOUT_RETRIED=1
      echo "JOUST-CLAUDEX-RETRY reason=wall-clock-timeout" >> "$LOG"
      continue
    fi
    finish TIMEOUT "secs=${TIMEOUT} (after 1 retry)" 01 wall-clock-timeout-retry-exhausted
    break
  fi
  # Zero-output stall (125): watchdog killed the group; retryable ONCE, then terminal.
  if [ "$RC" -eq 125 ]; then
    if [ "$STALL_RETRIED" -eq 0 ]; then
      STALL_RETRIED=1
      echo "JOUST-CLAUDEX-RETRY reason=zero-output-stall" >> "$LOG"
      continue
    fi
    finish KILLED "reason=zero-output-stall (after 1 retry)" 01 zero-output-stall-retry-exhausted
    break
  fi
  # Transient backpressure: upstream overload/ratelimit surfaces THROUGH the proxy as 5xx/429 — same
  # marker class as glm's 529 handling. stream-json shapes: internal retries emit
  # {"type":"system","subtype":"api_retry",...,"error_status":5xx,...}; a terminal API failure emits a
  # result event whose "result" field carries the plain "API Error: <code> ..." text. The quoted
  # "error_status" key is mention-proof: task-content text quoting it lands JSON-ESCAPED
  # (\"error_status\") inside a string and cannot match the unescaped pattern.
  if tail -n +"$((LINES_BEFORE + 1))" "$LOG" | grep -qE 'API Error: *(429|500|502|503|529)|overloaded|API Error:.*(timed out|timeout)|"(api_)?error_status": *(429|500|502|503|529)'; then
    if [ "$TRY" -ge "$MAXTRIES" ]; then
      echo "JOUST-CLAUDEX-RETRIES-EXHAUSTED tries=${TRY}" >> "$LOG"
      finish DONE "exit=${RC}" 02 retries-exhausted
      break
    fi
    DELAY=$(( BACKOFF * (1 << (TRY - 1)) ))
    [ "$JITTER_MAX" -gt 0 ] 2>/dev/null && DELAY=$(( DELAY + $(jitter "$JITTER_MAX") ))
    TRY=$((TRY + 1))
    echo "JOUST-CLAUDEX-RETRY try=${TRY}/${MAXTRIES} backoff=${DELAY}s reason=transient-overload" >> "$LOG"
    sleep "$DELAY"
    continue
  fi
  # Unclassified non-transient failure: turn-cap (03) is an honest model loss; else runner error (09).
  # stream-json signals turn-cap as {"type":"result","subtype":"error_max_turns",...}; the quoted-JSON
  # form is mention-proof: task content quoting it gets escaped (\"subtype\") and cannot match.
  if tail -n +"$((LINES_BEFORE + 1))" "$LOG" | grep -qE '"subtype":"error_max_turns"'; then
    finish DONE "exit=${RC}" 03 turn-cap
  else
    finish DONE "exit=${RC}" 09 runner-error
  fi
  break
done

tail -20 "$LOG"
exit "$RC"
