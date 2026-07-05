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
