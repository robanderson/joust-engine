#!/usr/bin/env bash
# bin/_je-run-lib.sh — shared runner primitives (JE-RC + guaranteed terminal marker + watchdog kill).
# Sourced by every bin/*-run.sh; NOT a standalone entrypoint (no shebang execution path is documented
# or supported). Rebrand-safety: every internal var/function name below is deliberately NOT JE_-
# prefixed (mirrors the existing `_rc_emitted` precedent) so rebrand's JE_->DE_ token rewrite cannot
# touch them; only the PUBLIC env-var surface (JE_TIMEOUT_SECS, JE_STALL_SECS, ...) uses the JE_
# prefix, exactly like today's JE_MAX_TURNS/JE_TIMEOUT_SECS, and gets rewritten consistently on both
# the runner (reader) and tournament.mjs (writer) sides together.
: "${PROV:?_je-run-lib.sh: PROV must be set before sourcing}"
: "${LOG:?_je-run-lib.sh: LOG must be set before sourcing}"

# security-sweep M7/H18/H19 (2026-07-07): the runner writes trust markers (PROVENANCE / DONE / RC) to
# $LOG and, in review mode, the report to $REPORT — both in a workspace a model can pre-populate. If
# either is a pre-planted SYMLINK, the runner's own writes (and restamps) follow it OUTSIDE the
# workspace, clobbering an arbitrary file. Remove any symlink at these paths up front so every runner
# write lands on a fresh regular file it owns. Call je_unlink_symlink for any workspace path opened
# for writing.
je_unlink_symlink() { [ -L "$1" ] && rm -f "$1"; return 0; }
je_unlink_symlink "$LOG"

# security-sweep H1 (2026-07-07): every runner launches `claude`/`codex` in acceptEdits with a Bash
# tool, so a prompt-injected attempt can `echo $SOME_KEY` / `env` and exfiltrate any credential the
# child inherits into its own (pooled, logged) output. The child needs exactly ONE auth token; it
# must NEVER see the operator's OTHER provider keys, forge tokens, or cloud creds. Each runner
# CAPTURES its own token into `_prov_token` first, then calls this to strip EVERY known secret name
# from the environment (including its own raw key name), then passes `_prov_token` as
# ANTHROPIC_AUTH_TOKEN command-scoped. Residual, documented honestly: the auth token is still
# readable as ANTHROPIC_AUTH_TOKEN (the CLI needs it in-env) — a full fix needs an out-of-env
# credential broker, out of scope; this closes the CROSS-provider + forge + cloud exfil surface,
# which is the real multi-credential exposure. Internal name (no JE_ prefix) so rebrand won't touch it.
# ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL are in the list too (issue #7): an operator following the
# claudex recipe interactively may have the CLIProxyAPI client token EXPORTED in their shell, and no
# other provider's child may ever see it. Safe to strip globally: every runner that needs these vars
# sets them COMMAND-SCOPED inside its own run_try, AFTER this scrub runs.
je_scrub_child_secrets() {
  local v
  for v in ZAI_API_KEY MINIMAX_API_KEY OMLX_AUTH_TOKEN OPENAI_API_KEY XAI_API_KEY ANTHROPIC_API_KEY \
           ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL \
           GH_TOKEN GITHUB_TOKEN GITHUB_PAT GH_ENTERPRISE_TOKEN \
           AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
           GOOGLE_APPLICATION_CREDENTIALS GCP_SA_KEY GCLOUD_SERVICE_KEY \
           NPM_TOKEN NODE_AUTH_TOKEN SSH_AUTH_SOCK CLOUDFLARE_API_TOKEN DIGITALOCEAN_TOKEN; do
    unset "$v"
  done
}

_finished=0
# finish <STATUS_WORD DONE|TIMEOUT|KILLED|ERROR> <status-detail> <rc-code> <rc-reason>
# IDEMPOTENT: the first call wins; every later call (explicit, or via a trap firing after an explicit
# call already ran) is a silent no-op. This is the ONE place that ever writes a terminal marker, so
# every exit path — success, an early config/env guard, a fully-classified failure, an uncaught crash
# under `set -u`, or an external signal — is guaranteed to leave exactly one status line and exactly
# one JOUST-RC line, never zero, never two.
finish() {
  [ "$_finished" = "1" ] && return 0
  _finished=1
  # Provenance self-destruction guard (run-h impl-6): a workspace-write worker can delete/recreate the
  # log mid-run (observed live: codex "tidied" _brief.txt + _codex_run.log away alongside a GOOD
  # deliverable), destroying the up-front PROVENANCE stamp and turning an honest success into a
  # fail-closed RC 06 reject. finish() runs ONLY inside the genuine runner process, so restamping here
  # preserves exactly what the marker asserts ("this runner really ran") while surviving worker
  # workspace hygiene. Runners opt in by setting PROV_LINE to their exact provenance line; the
  # restamped copy is suffixed so a log reader can tell it apart from the up-front original.
  if [ -n "${PROV_LINE:-}" ] && ! grep -q "^JOUST-${PROV}-PROVENANCE" "$LOG" 2>/dev/null; then
    printf '%s restamped=finish\n' "$PROV_LINE" >> "$LOG"
  fi
  printf 'JOUST-%s-%s %s\n' "$PROV" "$1" "$2" >> "$LOG"
  printf 'JOUST-RC %s %s\n' "$3" "$4" >> "$LOG"
}
# Catch-all traps. TERM/INT = an external kill (harness/operator/STOP-file signal delivery) -> RC 08,
# status word KILLED (distinct from a watchdog self-kill's RC 01 — the two share the KILLED status
# *word* but never the RC, so a log reader can tell "someone else killed this" from "this runner
# decided the child was unresponsive"). EXIT = the unclassified catch-all (crash, unset-variable abort
# under `set -uo pipefail`, or a code path that forgot to call finish() explicitly) -> the distinct
# terminal status word ERROR + RC 09, so a coding bug in a runner degrades to a loud, correctly-shaped
# RC 09 line rather than a silent, marker-less log. A SIGKILL (or external OOM-kill) of this process
# cannot be trapped by any userspace mechanism — the engine's fail-closed staging gate already treats a
# log with no terminal marker as an invalid candidate, so that undefeatable case degrades SAFELY.
trap 'finish KILLED "signal=TERM" 08 signal-abort' TERM
trap 'finish KILLED "signal=INT" 08 signal-abort' INT
trap 'finish ERROR "exit=unclassified" 09 unclassified' EXIT

# run_watchdog_perl <hard_timeout_s> <stall_window_s> <log_path> <cmd...>
# Portable (macOS + Linux, no new dependency — perl is already required by every runner for the
# existing SIGALRM hard-timeout wrapper) fork+exec with TWO independent kill conditions checked on a
# fixed poll tick: (a) total elapsed >= hard_timeout_s (today's existing wall-clock backstop) and
# (b) the log file's byte size has not grown for stall_window_s (the NEW zero-output watchdog).
# Kills by PROCESS GROUP: the exec'd child calls setpgrp(0,0) to become its own group leader BEFORE
# exec, and the parent signals the whole group with a NEGATIVE pid (`kill(SIG, -$p)`), so the entire
# tool subtree is reaped — not just the direct child. Exit code contract (distinct from the child's own
# real exit code, passed through unchanged on a normal finish):
#   124 = hard wall-clock deadline reached (same meaning/value as today)
#   125 = zero-output stall detected and the group was killed (NEW)
# Poll tick is min(5s, stall_window_s) so a short test-configured stall window (e.g. 1s) is checked
# promptly instead of only every 5s.
run_watchdog_perl() {
  local t="$1" stall="$2" logf="$3"; shift 3
  perl -e '
    use POSIX ":sys_wait_h";
    my ($t, $stall, $logf) = (shift @ARGV, shift @ARGV, shift @ARGV);
    my $poll = 5; $poll = $stall if $stall > 0 && $stall < $poll;
    $poll = 1 if $poll < 1;
    my $p = fork; if (!defined $p) { exit 127 }
    if ($p == 0) { setpgrp(0, 0); exec @ARGV; exit 127 }
    setpgrp($p, $p); # parent-side too: race-safe if the child has not yet called setpgrp itself
    # NON-BLOCKING poll loop: both the stall deadline and the wall-clock deadline are absolute time()
    # values, and the wait is a WNOHANG poll paced by a select() sleep — so the kill fires from this
    # loop own control flow and NEVER depends on a deferred safe-signals $SIG{ALRM} handler interrupting
    # a blocked wait (which could starve that handler and reproduce the 1200s hang this exists to prevent).
    # After a group kill the log can end MID-LINE (stream-json runners write continuously), which
    # would glue the next runner-written marker onto a partial JSON line and break the sacred
    # line-anchored ^JOUST- contract. Ensure the log ends with a newline before returning a kill code.
    my $nlfix = sub {
      return unless -s $logf;
      open(my $fh, "<", $logf) or return; seek($fh, -1, 2); read($fh, my $c, 1); close $fh;
      return if $c eq "\n";
      open(my $o, ">>", $logf) or return; print $o "\n"; close $o;
    };
    my $now = time();
    my $wall_deadline = $now + $t;
    my $stall_deadline = $stall > 0 ? $now + $stall : 0;
    my $last_size = -1;
    for (;;) {
      my $r = waitpid($p, WNOHANG);
      if ($r == $p) { exit($? >> 8) }               # child reaped -> pass its real exit code through
      select(undef, undef, undef, $poll);            # sleep one poll tick without arming a signal
      # Re-check AFTER the sleep, before any deadline judgment: a child that exited during the tick
      # is finished, not stalled — without this, its output stops growing and the stall branch could
      # kill an already-successful run (observed: steady writer, stall=1, killed 125 after clean exit).
      $r = waitpid($p, WNOHANG);
      if ($r == $p) { exit($? >> 8) }
      $now = time();
      my $size = -s $logf; $size = 0 unless defined $size;
      if ($size != $last_size) { $last_size = $size; $stall_deadline = $stall > 0 ? $now + $stall : 0 }
      if ($stall > 0 && $now >= $stall_deadline) { kill("TERM", -$p); sleep 2; kill("KILL", -$p); waitpid($p, 0); $nlfix->(); exit 125 }
      if ($now >= $wall_deadline)                { kill("TERM", -$p); sleep 2; kill("KILL", -$p); waitpid($p, 0); $nlfix->(); exit 124 }
    }
  ' "$t" "$stall" "$logf" "$@"
}
