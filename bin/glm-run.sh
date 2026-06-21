#!/usr/bin/env bash
# Joust Engine GLM attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on a z.ai GLM model via the Claude CLI
# pointed at z.ai, under a hard wall-clock timeout. Usage: glm-run.sh <claude --model flag...>
# Timeout (seconds) comes from JE_TIMEOUT_SECS (default 300).
set -uo pipefail
FLAG="${*:---model glm-5}"
LOG=_glm_run.log
TIMEOUT="${JE_TIMEOUT_SECS:-300}"   # wall-clock backstop (seconds)
MAXTURNS="${JE_MAX_TURNS:-30}"       # primary guard: cap agentic iterations (single-pass)
if [ -z "${ZAI_API_KEY:-}" ]; then echo "JOUST-GLM-ERROR ZAI_API_KEY missing" | tee -a "$LOG"; exit 3; fi
[ -f _brief.txt ] || { echo "JOUST-GLM-ERROR _brief.txt missing" | tee -a "$LOG"; exit 4; }

echo "JOUST-GLM-PROVENANCE endpoint=api.z.ai flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s" >> "$LOG"
# Portable hard timeout (no coreutils `timeout` on macOS): fork the call, SIGALRM -> TERM/KILL.
# </dev/null pins claude's stdin: with a prompt ARG but an OPEN (non-TTY) stdin, claude warns
# "no stdin data received in 3s" and can STALL the entire wall-clock producing NO output/deliverable
# (observed: every GLM attempt = 4-line log, exit 124). The agent context sometimes closes stdin so it
# worked before, but don't rely on the caller — close it here. (Mirrors the same fix in codex-run.sh.)
ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic" \
ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY" \
ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2[1m]" \
ANTHROPIC_DEFAULT_SONNET_MODEL="glm-4.7" \
ANTHROPIC_DEFAULT_HAIKU_MODEL="glm-4.5-air" \
perl -e '
  my $t = shift @ARGV;
  my $p = fork; if (!defined $p) { exit 127 }
  if ($p == 0) { exec @ARGV; exit 127 }
  $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
  alarm $t; waitpid($p, 0); exit($? >> 8);
' "$TIMEOUT" claude -p "$(cat _brief.txt)" $FLAG --max-turns "$MAXTURNS" --permission-mode acceptEdits --allowedTools "Bash Read Write Edit" </dev/null >> "$LOG" 2>&1
RC=$?
[ "$RC" -eq 124 ] && echo "JOUST-GLM-TIMEOUT secs=${TIMEOUT}" >> "$LOG"
echo "JOUST-GLM-DONE exit=$RC" >> "$LOG"
tail -20 "$LOG"
