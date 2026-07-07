#!/usr/bin/env bash
# Joust Engine CODEX attempt runner — approved internal tool.
# Runs the attempt brief in _brief.txt (cwd) on an OpenAI model via the `codex exec` non-interactive
# CLI, under a hard wall-clock timeout AND a zero-output stall watchdog. Usage: codex-run.sh <flags...>
# Timeout from JE_TIMEOUT_SECS (default 600). codex exec has NO --max-turns, so the wall clock (plus the
# new stall watchdog) is the ONLY backstop; JE_MAX_TURNS is intentionally ignored.
set -uo pipefail
FLAG="${*:--m gpt-5.5 -c model_reasoning_effort=medium}"
LOG=_codex_run.log
LAST=_codex_last.txt
PROV=CODEX
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_je-run-lib.sh"           # provides finish() + guaranteed-terminal traps + run_watchdog_perl
unset ANTHROPIC_API_KEY            # fold-in B: never leak the Anthropic key into a non-Anthropic child
# security-sweep H1: codex authenticates from ~/.codex/auth.json (on disk), needing NO provider env
# key, so strip every provider/forge/cloud secret from the env before `codex exec -s workspace-write`
# (whose shell can run model-authored commands). On-disk creds are a separate finding; this closes
# the ENV-secret exfil surface.
je_scrub_child_secrets

TIMEOUT="${JE_TIMEOUT_SECS:-600}"   # wall-clock backstop (seconds)
STALL="${JE_STALL_SECS:-300}"       # zero-output stall window (seconds). 300 not 120: codex exec goes
                                    # legitimately quiet while composing one large patch/file (run-h
                                    # impl-5 was killed twice at 120s mid-"writing the patch now").

[ -f _brief.txt ] || { finish DONE "exit=4 (missing-brief)" 07 missing-brief; exit 4; }
command -v codex >/dev/null 2>&1 || { finish DONE "exit=5 (missing-runner)" 07 missing-runner; exit 5; }

# Write the PROVENANCE marker UNCONDITIONALLY, up front: a missing log at this path proves the runner
# never ran (a native-solve spoof or refusal) and must fail closed (P=0) downstream.
PROV_LINE="JOUST-CODEX-PROVENANCE endpoint=api.openai.com flag=${FLAG} timeout=${TIMEOUT}s stall=${STALL}s"
echo "$PROV_LINE" >> "$LOG"

# JE_CODEX_MODE=review (judge seats, 2026-07-06 judge-architecture experiment): run the purpose-built
# `codex review` preset instead of an open-ended agentic exec. Custom instructions come from
# _brief.txt (the review presets are MUTUALLY EXCLUSIVE on >=0.141 — a prompt cannot combine with
# --base/--commit/--uncommitted — so prompt-only mode reviews the WORKING TREE; the engine stages the
# subject matter into this workspace beforehand). codex streams its session progress to STDERR
# (observed 200-350KB/run) — that feeds $LOG so the stall watchdog measures true liveness — and
# prints the final report to STDOUT -> $REPORT. Model/effort flags are GLOBAL: `review` has no -m.
MODE="${JE_CODEX_MODE:-exec}"
REPORT=_review_report.md

# Headless codex exec policy (all VERIFIED on codex-cli 0.139.0). </dev/null pins codex's stdin so it
# never blocks reading additional input; $FLAG is unquoted so the shell word-splits it into argv.
run_try() {
  if [ "$MODE" = review ]; then
    run_watchdog_perl "$TIMEOUT" "$STALL" "$LOG" \
      codex \
        $FLAG \
        -c approval_policy="never" \
        -c 'mcp_servers={}' \
        review \
        "$(cat _brief.txt)" </dev/null > "$REPORT" 2>> "$LOG"
  else
    run_watchdog_perl "$TIMEOUT" "$STALL" "$LOG" \
      codex exec \
        -s workspace-write \
        -C "$PWD" \
        --skip-git-repo-check \
        -c approval_policy="never" \
        -c 'mcp_servers={}' \
        -o "$LAST" \
        $FLAG \
        "$(cat _brief.txt)" </dev/null >> "$LOG" 2>&1
  fi
}

TIMEOUT_RETRIED=0
STALL_RETRIED=0
RC=0
while :; do
  LINES_BEFORE=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
  run_try
  RC=$?
  # Defensive fail-closed auth/model/version force-fail (non-retryable — retrying a bad key cannot
  # succeed). GUARD [ ! -s "$LAST" ]: only when codex produced NO final message (a real abort), so a
  # SUCCESSFUL run that merely *discusses* these phrases is never force-failed. Scanned against THIS
  # try's fresh log slice.
  TARGET="$LAST"; [ "$MODE" = review ] && TARGET="$REPORT"
  if [ ! -s "$TARGET" ] && tail -n +"$((LINES_BEFORE + 1))" "$LOG" | grep -qiE 'requires a newer version of Codex|is not supported when using Codex with a|invalid_api_key|401 Unauthorized|403 Forbidden'; then
    echo "JOUST-CODEX-ERROR codex reported a model/auth/version failure (see log)" >> "$LOG"
    [ "$RC" -eq 0 ] && RC=6
    finish DONE "exit=${RC}" 02 provider-auth-endpoint
    break
  fi
  # Review mode: a clean exit with an EMPTY report is not a success — classify honestly as RC 05
  # (no deliverable) so the engine's fallback ladder takes over instead of parsing nothing.
  if [ "$RC" -eq 0 ] && [ "$MODE" = review ] && [ ! -s "$REPORT" ]; then
    finish DONE "exit=0 (empty-report)" 05 no-deliverable-saved
    break
  fi
  if [ "$RC" -eq 0 ]; then finish DONE "exit=0" 00 ok; break; fi
  if [ "$RC" -eq 124 ]; then
    if [ "$TIMEOUT_RETRIED" -eq 0 ]; then TIMEOUT_RETRIED=1; echo "JOUST-CODEX-RETRY reason=wall-clock-timeout" >> "$LOG"; continue; fi
    finish TIMEOUT "secs=${TIMEOUT} (after 1 retry)" 01 wall-clock-timeout-retry-exhausted; break
  fi
  if [ "$RC" -eq 125 ]; then
    if [ "$STALL_RETRIED" -eq 0 ]; then STALL_RETRIED=1; echo "JOUST-CODEX-RETRY reason=zero-output-stall" >> "$LOG"; continue; fi
    finish KILLED "reason=zero-output-stall (after 1 retry)" 01 zero-output-stall-retry-exhausted; break
  fi
  # Codex has no --max-turns, so turn-cap (03) is N/A here.
  finish DONE "exit=${RC}" 09 runner-error
  break
done

tail -20 "$LOG"
exit "$RC"
