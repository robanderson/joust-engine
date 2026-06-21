#!/usr/bin/env bash
# Joust Engine MINIMAX attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on the MiniMax M-series model (MiniMax-M3, 512K ctx)
# via the Claude CLI pointed at the MiniMax Anthropic-compatible endpoint, under a hard wall-clock
# timeout. MiniMax exposes ONE model: all opus/sonnet/haiku aliases map to MiniMax-M3, so no --model
# flag is needed (ANTHROPIC_MODEL pins it). Usage: minimax-run.sh [extra claude flags...]
# Timeout (seconds) from JE_TIMEOUT_SECS (default 300); max-turns from JE_MAX_TURNS (default 30).
set -uo pipefail
FLAG="${*:-}"
LOG=_minimax_run.log
TIMEOUT="${JE_TIMEOUT_SECS:-300}"   # wall-clock backstop (seconds)
MAXTURNS="${JE_MAX_TURNS:-30}"       # primary guard: cap agentic iterations (single-pass)

# MINIMAX_API_KEY comes from the environment — exactly like glm-run.sh reads ZAI_API_KEY. The user's
# ~/.zshrc exports it (alongside ZAI_API_KEY / OMLX_AUTH_TOKEN) and the Claude Code session inherits it
# at launch. If it is missing, the session predates the export: relaunch from a shell that has it. Do
# NOT add bespoke key-loading (sourcing/grepping rc files) here — keep every provider runner uniform.
if [ -z "${MINIMAX_API_KEY:-}" ]; then echo "JOUST-MINIMAX-ERROR MINIMAX_API_KEY missing (export in ~/.zshrc and relaunch)" | tee -a "$LOG"; exit 3; fi
[ -f _brief.txt ] || { echo "JOUST-MINIMAX-ERROR _brief.txt missing" | tee -a "$LOG"; exit 4; }

echo "JOUST-MINIMAX-PROVENANCE endpoint=api.minimax.io model=MiniMax-M3 max-turns=${MAXTURNS} timeout=${TIMEOUT}s" >> "$LOG"
# Portable hard timeout (no coreutils `timeout` on macOS): fork the call, SIGALRM -> TERM/KILL.
# </dev/null pins claude's stdin: with a prompt ARG but an OPEN (non-TTY) stdin, claude warns
# "no stdin data received in 3s" and can STALL the entire wall-clock producing nothing (the bug that
# hit glm/codex). Close stdin here and never rely on the caller. (Mirrors glm-run.sh / codex-run.sh.)
ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic" \
ANTHROPIC_AUTH_TOKEN="$MINIMAX_API_KEY" \
ANTHROPIC_MODEL="MiniMax-M3" \
ANTHROPIC_DEFAULT_OPUS_MODEL="MiniMax-M3" \
ANTHROPIC_DEFAULT_SONNET_MODEL="MiniMax-M3" \
ANTHROPIC_DEFAULT_HAIKU_MODEL="MiniMax-M3" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
CLAUDE_CODE_AUTO_COMPACT_WINDOW="512000" \
API_TIMEOUT_MS="3000000" \
perl -e '
  my $t = shift @ARGV;
  my $p = fork; if (!defined $p) { exit 127 }
  if ($p == 0) { exec @ARGV; exit 127 }
  $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
  alarm $t; waitpid($p, 0); exit($? >> 8);
' "$TIMEOUT" claude -p "$(cat _brief.txt)" $FLAG --max-turns "$MAXTURNS" --permission-mode acceptEdits --allowedTools "Bash Read Write Edit" </dev/null >> "$LOG" 2>&1
RC=$?
[ "$RC" -eq 124 ] && echo "JOUST-MINIMAX-TIMEOUT secs=${TIMEOUT}" >> "$LOG"
echo "JOUST-MINIMAX-DONE exit=$RC" >> "$LOG"
tail -20 "$LOG"
