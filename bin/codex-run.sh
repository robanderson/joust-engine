#!/usr/bin/env bash
# Joust Engine CODEX attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on an OpenAI model via the `codex exec`
# non-interactive CLI, under a hard wall-clock timeout. Usage: codex-run.sh <codex exec flags...>
# Timeout (seconds) comes from JE_TIMEOUT_SECS (default 600). codex exec has NO --max-turns, so the
# wall clock is the ONLY backstop; JE_MAX_TURNS is intentionally ignored.
set -uo pipefail
FLAG="${*:--m gpt-5.5 -c model_reasoning_effort=medium}"
LOG=_codex_run.log
LAST=_codex_last.txt
TIMEOUT="${JE_TIMEOUT_SECS:-600}"   # wall-clock backstop (seconds) — the only per-attempt guard
[ -f _brief.txt ] || { echo "JOUST-CODEX-ERROR _brief.txt missing" | tee -a "$LOG"; exit 4; }
command -v codex >/dev/null 2>&1 || { echo "JOUST-CODEX-ERROR codex CLI not found on PATH" | tee -a "$LOG"; exit 5; }

# Write the PROVENANCE marker UNCONDITIONALLY, up front: a missing log at this path proves the runner
# never ran (a native-solve spoof or refusal) and must fail closed (P=0) downstream.
echo "JOUST-CODEX-PROVENANCE endpoint=api.openai.com flag=${FLAG} timeout=${TIMEOUT}s" >> "$LOG"
# Headless codex exec policy (all VERIFIED on codex-cli 0.139.0):
#   -s workspace-write          : MINIMAL sandbox that still lets codex WRITE the deliverable (preferred
#                                 over --dangerously-bypass-* since this runs on the user's real machine)
#   -C "$PWD"                    : working root = this attempt workspace (scopes writes here)
#   --skip-git-repo-check        : workspaces are not git repos
#   -c approval_policy="never"   : fully headless. NOTE: -a/--ask-for-approval is a TOP-LEVEL flag that
#                                  CRASHES `codex exec` ("unexpected argument '-a'") — set via -c, never -a.
#   -c 'mcp_servers={}'          : silence the broken web-search-prime MCP handshake noise
#   -o "$LAST"                   : clean capture of the agent's final message (engine deletes it pre-judge)
#   $FLAG                        : pinned model (-m gpt-5.5) + reasoning effort — never trust config default
#   "$(cat _brief.txt)"          : the brief as the PROMPT arg (do NOT also pipe stdin / use '-')
# Portable hard timeout (macOS has no coreutils `timeout`): fork the call, SIGALRM -> TERM/KILL. The
# >>LOG redirect is applied by the OUTER shell to the whole perl command (matches glm-run.sh's shape);
# $FLAG is unquoted so the outer shell word-splits it into separate argv elements before perl exec.
# </dev/null pins codex's stdin: with a prompt ARG but an OPEN (non-TTY) stdin, codex prints
# "Reading additional input from stdin..." and BLOCKS to the wall-clock timeout (exit 124) instead of
# running. The agent Bash context happens to close stdin (so the tournament worked), but a direct or
# differently-configured caller leaving stdin open would hang — so close it here and never rely on the caller.
perl -e '
  my $t = shift @ARGV;
  my $p = fork; if (!defined $p) { exit 127 }
  if ($p == 0) { exec @ARGV; exit 127 }
  $SIG{ALRM} = sub { kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 };
  alarm $t; waitpid($p, 0); exit($? >> 8);
' "$TIMEOUT" codex exec \
    -s workspace-write \
    -C "$PWD" \
    --skip-git-repo-check \
    -c approval_policy="never" \
    -c 'mcp_servers={}' \
    -o "$LAST" \
    $FLAG \
    "$(cat _brief.txt)" </dev/null >> "$LOG" 2>&1
RC=$?

# Defensive fail-closed (belt-and-suspenders beyond the exit code): if codex hit a terminal
# model/auth/version failure, force a nonzero RC so the provenance check (DONE exit=0) rejects it
# even on the rare path where codex returns such an error yet still exits 0.
# GUARD (-s "$LAST"): only force-fail when codex produced NO final message. A real auth/model/version
# failure aborts BEFORE any model output, so $LAST is empty/absent; a SUCCESSFUL run that merely
# *discusses* these phrases (e.g. a deliverable about codex auth) writes a normal $LAST and must NOT be
# force-failed. Without this guard, unanchored grep over the full transcript false-failed two genuinely
# successful codex attempts whose task was designing this very provenance system. Mirrors the staging
# validator's mention-proof anchoring fix.
if [ ! -s "$LAST" ] && grep -qiE 'requires a newer version of Codex|is not supported when using Codex with a|invalid_api_key|401 Unauthorized|403 Forbidden' "$LOG"; then
  echo "JOUST-CODEX-ERROR codex reported a model/auth/version failure (see log)" >> "$LOG"
  [ "$RC" -eq 0 ] && RC=6
fi

[ "$RC" -eq 124 ] && echo "JOUST-CODEX-TIMEOUT secs=${TIMEOUT}" >> "$LOG"
echo "JOUST-CODEX-DONE exit=$RC" >> "$LOG"
tail -20 "$LOG"
