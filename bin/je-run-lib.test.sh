#!/usr/bin/env bash
# Tests for bin/_je-run-lib.sh shared runner primitives: finish() idempotency + guaranteed terminal
# marker traps, and run_watchdog_perl (pass-through, stall kill, wall-clock kill, process-GROUP reap).
# No network, no model, macOS + Linux portable. Run: bash bin/je-run-lib.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/_je-run-lib.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }

echo "== _je-run-lib.sh tests =="

# ---- finish(): two calls write exactly one status line + one RC line (idempotency) ----
WS=$(mktemp -d)
( cd "$WS"; PROV=TEST LOG="$WS/t.log"; . "$LIB"
  finish DONE "exit=0" 00 ok
  finish TIMEOUT "secs=9" 01 later-should-be-noop ) >/dev/null 2>&1
check "finish idempotent: one status line"  '[ "$(grep -c "^JOUST-TEST-" "$WS/t.log")" = "1" ]'
check "finish idempotent: one RC line"       '[ "$(grep -c "^JOUST-RC " "$WS/t.log")" = "1" ]'
check "finish idempotent: first call won"    'grep -q "^JOUST-TEST-DONE exit=0" "$WS/t.log" && grep -q "^JOUST-RC 00 ok" "$WS/t.log"'
rm -rf "$WS"

# ---- EXIT trap fires finish ERROR/09 when the script never calls finish itself (crash path) ----
WS=$(mktemp -d)
( cd "$WS"; PROV=TEST LOG="$WS/t.log"; . "$LIB"; : ) >/dev/null 2>&1
check "EXIT trap: one status line"           '[ "$(grep -c "^JOUST-TEST-" "$WS/t.log")" = "1" ]'
check "EXIT trap: ERROR status word"         'grep -q "^JOUST-TEST-ERROR " "$WS/t.log"'
check "EXIT trap: JOUST-RC 09"               'grep -q "^JOUST-RC 09 " "$WS/t.log"'
rm -rf "$WS"

# ---- an explicit finish() makes the EXIT trap a no-op (no double marker) ----
WS=$(mktemp -d)
( cd "$WS"; PROV=TEST LOG="$WS/t.log"; . "$LIB"; finish DONE "exit=0" 00 ok ) >/dev/null 2>&1
check "explicit finish suppresses EXIT trap: one RC" '[ "$(grep -c "^JOUST-RC " "$WS/t.log")" = "1" ]'
check "explicit finish suppresses EXIT trap: DONE"   'grep -q "^JOUST-RC 00 ok" "$WS/t.log"'
rm -rf "$WS"

# ---- run_watchdog_perl: a fast clean child returns its own exit code, no kill ----
WS=$(mktemp -d)
RCV=$( cd "$WS"; PROV=TEST LOG="$WS/t.log"; . "$LIB" >/dev/null 2>&1
  run_watchdog_perl 30 5 "$WS/t.log" bash -c 'echo hi >> "'"$WS"'/t.log"; exit 0' >/dev/null 2>&1; echo $? )
check "watchdog: clean child returns 0"      '[ "$RCV" = "0" ]'
rm -rf "$WS"

# ---- run_watchdog_perl: a growing child never trips the stall clock ----
# writes every 0.2s for ~2s with stall=1; because output keeps growing, the 1s stall never fires and the
# child exits 0 on its own (proving growth resets the stall clock, not just the wall deadline).
WS=$(mktemp -d)
RCV=$( cd "$WS"; PROV=TEST LOG="$WS/t.log"; . "$LIB" >/dev/null 2>&1
  run_watchdog_perl 30 1 "$WS/t.log" bash -c 'for i in $(seq 1 10); do echo tick >> "'"$WS"'/t.log"; sleep 0.2; done; exit 0' >/dev/null 2>&1; echo $? )
check "watchdog: steady output survives stall (exit 0)" '[ "$RCV" = "0" ]'
rm -rf "$WS"

# ---- run_watchdog_perl: a silent child is killed with 125 and its GROUP (incl. grandchild) is reaped ----
# The child ignores TERM at its own pid AND forks a grandchild that also ignores TERM, then both go
# silent. A parent-only kill would miss them; the process-GROUP kill (negative pid) reaps both. We record
# the grandchild pid to a file and assert it is gone after the watchdog returns 125.
WS=$(mktemp -d)
cat > "$WS/silent.sh" <<'SIL'
#!/usr/bin/env bash
trap '' TERM
( trap '' TERM; echo $BASHPID > "$WS/gc.pid"; sleep 600 ) &
GC=$!
echo boot >> "$LOG"   # one write so the log is non-empty, then go silent
sleep 600
SIL
chmod +x "$WS/silent.sh"
RCV=$( cd "$WS"; PROV=TEST LOG="$WS/t.log"; export WS LOG="$WS/t.log"; . "$LIB" >/dev/null 2>&1
  run_watchdog_perl 30 1 "$WS/t.log" bash "$WS/silent.sh" >/dev/null 2>&1; echo $? )
check "watchdog: silent child returns 125"   '[ "$RCV" = "125" ]'
sleep 1
GC=$(cat "$WS/gc.pid" 2>/dev/null || echo 0)
check "watchdog: grandchild reaped by group kill" '[ "$GC" = "0" ] || ! kill -0 "$GC" 2>/dev/null'
rm -rf "$WS"

# ---- run_watchdog_perl: a child that never writes and never exits hits the WALL clock (124) ----
WS=$(mktemp -d)
RCV=$( cd "$WS"; PROV=TEST LOG="$WS/t.log"; . "$LIB" >/dev/null 2>&1
  # stall disabled (0) so ONLY the wall clock can fire; hard timeout 1s.
  run_watchdog_perl 1 0 "$WS/t.log" bash -c 'sleep 600' >/dev/null 2>&1; echo $? )
check "watchdog: wall-clock kill returns 124" '[ "$RCV" = "124" ]'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
