#!/usr/bin/env bash
# Joust Engine LOCAL (omlx / MLX) attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on a local MLX model via the Claude CLI
# pointed at the local omlx server (http://127.0.0.1:8000), under a hard wall-clock timeout.
# Usage: local-run.sh <claude --model flag...>   Timeout (seconds) from JE_TIMEOUT_SECS (default 300).
set -uo pipefail
FLAG="${*:---model gemma-4-26b-a4b-it-8bit}"
LOG=_local_run.log
TIMEOUT="${JE_TIMEOUT_SECS:-300}"   # wall-clock backstop (seconds)
MAXTURNS="${JE_MAX_TURNS:-20}"       # tight cap: local models tend to ignore "single pass" and loop

# OMLX_AUTH_TOKEN comes from the environment — the same uniform key handling every runner uses
# (glm-run.sh reads ZAI_API_KEY, minimax-run.sh reads MINIMAX_API_KEY). It is exported in the user's
# ~/.zshrc and inherited into the session at launch. Do NOT source/grep rc files here.
if [ -z "${OMLX_AUTH_TOKEN:-}" ]; then echo "JOUST-LOCAL-ERROR OMLX_AUTH_TOKEN missing (export in ~/.zshrc and relaunch)" | tee -a "$LOG"; exit 3; fi
[ -f _brief.txt ] || { echo "JOUST-LOCAL-ERROR _brief.txt missing" | tee -a "$LOG"; exit 4; }

echo "JOUST-LOCAL-PROVENANCE endpoint=127.0.0.1:8000 flag=${FLAG} max-turns=${MAXTURNS} timeout=${TIMEOUT}s" >> "$LOG"
# Portable hard timeout (no coreutils `timeout` on macOS): fork the call, SIGALRM -> TERM/KILL.
# </dev/null pins stdin: open (non-TTY) stdin makes `claude -p` warn "no stdin data received in 3s"
# and can stall the whole wall-clock producing nothing. Uniform with glm/codex/minimax runners.
ANTHROPIC_BASE_URL="http://127.0.0.1:8000" \
ANTHROPIC_AUTH_TOKEN="$OMLX_AUTH_TOKEN" \
ANTHROPIC_DEFAULT_OPUS_MODEL="Qwen3.5-122B-A10B-LM-MLX-6.5bit" \
ANTHROPIC_DEFAULT_SONNET_MODEL="mlx-community--Qwen3.6-35B-A3B-8bit" \
ANTHROPIC_DEFAULT_HAIKU_MODEL="gemma-4-26b-a4b-it-8bit" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" API_TIMEOUT_MS="3000000" \
perl -e '
  my $t = shift @ARGV;
  my $p = fork; if (!defined $p) { exit 127 }
  if ($p == 0) { exec @ARGV; exit 127 }
  $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
  alarm $t; waitpid($p, 0); exit($? >> 8);
' "$TIMEOUT" claude -p "$(cat _brief.txt)" $FLAG --max-turns "$MAXTURNS" --permission-mode acceptEdits --allowedTools "Bash Read Write Edit" </dev/null >> "$LOG" 2>&1
RC=$?
[ "$RC" -eq 124 ] && echo "JOUST-LOCAL-TIMEOUT secs=${TIMEOUT}" >> "$LOG"
echo "JOUST-LOCAL-DONE exit=$RC" >> "$LOG"
tail -20 "$LOG"
