#!/usr/bin/env bash
# Tests for bin/minimax-run.sh JE-RC observability: every exit path appends exactly ONE terminal
# `JOUST-RC <code> <reason>` line with the right code. PATH-stubbed fake `claude`; no network, no
# model, macOS-portable. Run: bash bin/minimax-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/minimax-run.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }

mk_ws() {
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"
  printf 'write a tiny script' > "$WS/_brief.txt"
  cat > "$WS/stub/claude" <<'STUB'
#!/usr/bin/env bash
case "${FAKE_MODE:-ok}" in
  ok)      echo "fake claude: done"; echo "print('hi')" > solution.py; exit 0 ;;
  turncap) echo "Reached max turns (30)"; exit 1 ;;
  hang)    sleep 10; exit 0 ;;
esac
STUB
  chmod +x "$WS/stub/claude"
}
run_runner() { ( cd "$WS" && env PATH="$WS/stub:$PATH" MINIMAX_API_KEY=test-key "$@" \
      bash "$RUNNER" >/dev/null 2>&1 ); }
rc_count() { grep -c '^JOUST-RC ' "$WS/_minimax_run.log"; }

echo "== minimax-run.sh JE-RC tests =="

# success -> 00
mk_ws; run_runner FAKE_MODE=ok; RC=$?
check "ok: exits 0"                 '[ "$RC" -eq 0 ]'
check "ok: exactly one JOUST-RC"    '[ "$(rc_count)" = "1" ]'
check "ok: JOUST-RC 00"             'grep -q "^JOUST-RC 00 " "$WS/_minimax_run.log"'
rm -rf "$WS"

# missing key -> 07 (exit 3)
WS=$(mktemp -d); export WS
( cd "$WS" && env MINIMAX_API_KEY= bash "$RUNNER" >/dev/null 2>&1 ); RC=$?
check "missing-key: exits 3"        '[ "$RC" -eq 3 ]'
check "missing-key: one JOUST-RC"   '[ "$(rc_count)" = "1" ]'
check "missing-key: JOUST-RC 07"    'grep -q "^JOUST-RC 07 " "$WS/_minimax_run.log"'
rm -rf "$WS"

# missing brief -> 07 (exit 4)
WS=$(mktemp -d); export WS
( cd "$WS" && env MINIMAX_API_KEY=test-key bash "$RUNNER" >/dev/null 2>&1 ); RC=$?
check "missing-brief: exits 4"      '[ "$RC" -eq 4 ]'
check "missing-brief: one JOUST-RC" '[ "$(rc_count)" = "1" ]'
check "missing-brief: JOUST-RC 07"  'grep -q "^JOUST-RC 07 " "$WS/_minimax_run.log"'
rm -rf "$WS"

# turn-cap -> 03
mk_ws; run_runner FAKE_MODE=turncap
check "turncap: one JOUST-RC"       '[ "$(rc_count)" = "1" ]'
check "turncap: JOUST-RC 03"        'grep -q "^JOUST-RC 03 " "$WS/_minimax_run.log"'
rm -rf "$WS"

# wall-clock timeout -> 01 (assert on the log line; runner does not propagate rc 124 as outer exit)
mk_ws; run_runner FAKE_MODE=hang JE_TIMEOUT_SECS=1
check "timeout: TIMEOUT marker"     'grep -q "^JOUST-MINIMAX-TIMEOUT " "$WS/_minimax_run.log"'
check "timeout: one JOUST-RC"       '[ "$(rc_count)" = "1" ]'
check "timeout: JOUST-RC 01"        'grep -q "^JOUST-RC 01 " "$WS/_minimax_run.log"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
