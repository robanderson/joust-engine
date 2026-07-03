#!/usr/bin/env bash
# Joust Engine GLM attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on a z.ai GLM model via the Claude CLI
# pointed at z.ai, under a hard wall-clock timeout. Usage: glm-run.sh <claude --model flag...>
# Timeout (seconds) comes from JE_TIMEOUT_SECS (default 300).
#
# Transient-overload handling (issue #25): z.ai enforces PLAN-TIER CONCURRENCY limits
# (dynamically tightened at peak) and sheds excess load with HTTP 529 "temporarily
# overloaded". A tournament fans N parallel agentic attempts, so 529s are expected
# backpressure, not fatal errors. Two mitigations, both bounded and fail-closed:
#   1. Startup jitter (0..JE_GLM_JITTER_MAX s, default 10) staggers sibling attempts so
#      they don't open with a synchronized burst.
#   2. Bounded retry with exponential backoff + jitter, ONLY when the failed try's own
#      output shows a TRANSIENT marker: a 5xx/overload status OR (issue #31) a timeout-
#      class API error on the CLI's stable 'API Error:' line ("The operation timed out."
#      and its timeout-worded near-neighbours). Hard errors (bad key, bad flag, refusals,
#      and auth text even on the 'API Error:' line) never retry; the runner's OWN wall-
#      clock timeout (rc 124, the SIGALRM kill) never retries — it already spent the budget.
# Retries: JE_GLM_RETRIES (default 3, so <=4 tries). Backoff: JE_GLM_BACKOFF_BASE
# (default 15s) doubling per retry, plus 0..JE_GLM_JITTER_MAX random seconds.
set -uo pipefail
FLAG="${*:---model glm-5}"
LOG=_glm_run.log
TIMEOUT="${JE_TIMEOUT_SECS:-300}"   # wall-clock backstop (seconds), PER TRY
MAXTURNS="${JE_MAX_TURNS:-30}"       # primary guard: cap agentic iterations (single-pass)
RETRIES="${JE_GLM_RETRIES:-3}"       # max ADDITIONAL tries after the first (<=4 total)
BACKOFF="${JE_GLM_BACKOFF_BASE:-15}" # first retry delay (seconds); doubles per retry
JITTER_MAX="${JE_GLM_JITTER_MAX:-10}" # random 0..N s added to startup + each backoff
if [ -z "${ZAI_API_KEY:-}" ]; then echo "JOUST-GLM-ERROR ZAI_API_KEY missing" | tee -a "$LOG"; exit 3; fi
[ -f _brief.txt ] || { echo "JOUST-GLM-ERROR _brief.txt missing" | tee -a "$LOG"; exit 4; }

# Portable random 0..N seconds (macOS has no shuf; sh has no reliable $RANDOM).
jitter() { perl -e 'print int(rand($ARGV[0]+1))' "$1"; }

echo "JOUST-GLM-PROVENANCE endpoint=api.z.ai flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s retries=${RETRIES}" >> "$LOG"

# Startup jitter: stagger parallel sibling attempts' first call.
if [ "$JITTER_MAX" -gt 0 ] 2>/dev/null; then
  J=$(jitter "$JITTER_MAX")
  [ "$J" -gt 0 ] && { echo "JOUST-GLM-JITTER startup=${J}s" >> "$LOG"; sleep "$J"; }
fi

# One try. Portable hard timeout (no coreutils `timeout` on macOS): fork the call, SIGALRM -> TERM/KILL.
# </dev/null pins claude's stdin: with a prompt ARG but an OPEN (non-TTY) stdin, claude warns
# "no stdin data received in 3s" and can STALL the entire wall-clock producing NO output/deliverable
# (observed: every GLM attempt = 4-line log, exit 124). The agent context sometimes closes stdin so it
# worked before, but don't rely on the caller — close it here. (Mirrors the same fix in codex-run.sh.)
# CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC + API_TIMEOUT_MS mirror the operator's proven
# interactive `glm` alias: no connector-warning noise, no premature client-side cutoff.
run_try() {
  ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" \
  ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2[1m]" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="glm-4.7" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.5-air" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
  API_TIMEOUT_MS="${JE_API_TIMEOUT_MS:-3000000}" \
  perl -e '
    my $t = shift @ARGV;
    my $p = fork; if (!defined $p) { exit 127 }
    if ($p == 0) { exec @ARGV; exit 127 }
    $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
    alarm $t; waitpid($p, 0); exit($? >> 8);
  ' "$TIMEOUT" claude -p "$(cat _brief.txt)" $FLAG --max-turns "$MAXTURNS" --permission-mode acceptEdits --allowedTools "Bash Read Write Edit" </dev/null >> "$LOG" 2>&1
}

TRY=1
MAXTRIES=$((RETRIES + 1))
while :; do
  LINES_BEFORE=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
  run_try
  RC=$?
  [ "$RC" -eq 0 ] && break
  if [ "$RC" -eq 124 ]; then echo "JOUST-GLM-TIMEOUT secs=${TIMEOUT}" >> "$LOG"; break; fi
  # Retry ONLY on a TRANSIENT marker in THIS try's appended output — hard errors fail
  # closed immediately. Markers: a 5xx/overload status, OR (issue #31) a timeout-class
  # API error on the CLI's stable 'API Error:' line ('...timed out' / '...timeout').
  # The 'API Error:' prefix anchor keeps genuine task output, refusals, and auth text
  # (even auth carried on that same line) from self-tripping a retry; an extra retry
  # after a genuine failure whose text merely *mentions* a marker is bounded and harmless,
  # but retrying a hard auth/flag error is not. rc 124 (the runner's own wall-clock
  # SIGALRM) is handled above and never reaches this grep.
  if tail -n +"$((LINES_BEFORE + 1))" "$LOG" | grep -qE 'API Error: *(429|500|502|503|529)|overloaded|API Error:.*(timed out|timeout)'; then
    if [ "$TRY" -ge "$MAXTRIES" ]; then
      echo "JOUST-GLM-RETRIES-EXHAUSTED tries=${TRY}" >> "$LOG"
      break
    fi
    DELAY=$(( BACKOFF * (1 << (TRY - 1)) ))
    [ "$JITTER_MAX" -gt 0 ] 2>/dev/null && DELAY=$(( DELAY + $(jitter "$JITTER_MAX") ))
    TRY=$((TRY + 1))
    echo "JOUST-GLM-RETRY try=${TRY}/${MAXTRIES} backoff=${DELAY}s reason=transient-overload" >> "$LOG"
    sleep "$DELAY"
    continue
  fi
  break
done

echo "JOUST-GLM-DONE exit=$RC" >> "$LOG"
tail -20 "$LOG"
# Propagate the try's exit code (previously `tail` masked it to 0; the engine judges
# by deliverable + DONE marker, but callers deserve an honest rc too).
exit "$RC"
