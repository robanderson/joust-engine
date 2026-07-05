#!/usr/bin/env bash
# Tests for bin/local-run.sh JE-RC observability: every exit path appends exactly ONE terminal
# `JOUST-RC <code> <reason>` line with the right code. PATH-stubbed fake `claude`; no network, no
# model, macOS-portable. Run: bash bin/local-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/local-run.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }

# Fresh workspace with a PATH-first fake `claude`. FAKE_MODE controls the simulated behaviour:
#   ok       -> writes a deliverable, exit 0
#   turncap  -> prints "Reached max turns", exit 1
#   hang     -> sleeps past the wall clock (drives the runner's SIGALRM -> rc 124)
mk_ws() {
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"
  printf 'write a tiny script' > "$WS/_brief.txt"
  cat > "$WS/stub/claude" <<'STUB'
#!/usr/bin/env bash
case "${FAKE_MODE:-ok}" in
  ok)      echo "fake claude: done"; echo "print('hi')" > solution.py; exit 0 ;;
  turncap) echo "Reached max turns (20)"; exit 1 ;;
  hang)    sleep 10; exit 0 ;;
esac
STUB
  chmod +x "$WS/stub/claude"
}
run_runner() { ( cd "$WS" && env PATH="$WS/stub:$PATH" OMLX_AUTH_TOKEN=test-key "$@" \
      bash "$RUNNER" --model test >/dev/null 2>&1 ); }
rc_count() { grep -c '^JOUST-RC ' "$WS/_local_run.log"; }

echo "== local-run.sh JE-RC tests =="

# success -> 00
mk_ws; run_runner FAKE_MODE=ok; RC=$?
check "ok: exits 0"                 '[ "$RC" -eq 0 ]'
check "ok: exactly one JOUST-RC"    '[ "$(rc_count)" = "1" ]'
check "ok: JOUST-RC 00"             'grep -q "^JOUST-RC 00 " "$WS/_local_run.log"'
rm -rf "$WS"

# missing key -> 07 (exit 3)
WS=$(mktemp -d); export WS
( cd "$WS" && env OMLX_AUTH_TOKEN= bash "$RUNNER" --model test >/dev/null 2>&1 ); RC=$?
check "missing-key: exits 3"        '[ "$RC" -eq 3 ]'
check "missing-key: one JOUST-RC"   '[ "$(rc_count)" = "1" ]'
check "missing-key: JOUST-RC 07"    'grep -q "^JOUST-RC 07 " "$WS/_local_run.log"'
rm -rf "$WS"

# missing brief -> 07 (exit 4)
WS=$(mktemp -d); export WS
( cd "$WS" && env OMLX_AUTH_TOKEN=test-key bash "$RUNNER" --model test >/dev/null 2>&1 ); RC=$?
check "missing-brief: exits 4"      '[ "$RC" -eq 4 ]'
check "missing-brief: one JOUST-RC" '[ "$(rc_count)" = "1" ]'
check "missing-brief: JOUST-RC 07"  'grep -q "^JOUST-RC 07 " "$WS/_local_run.log"'
rm -rf "$WS"

# turn-cap -> 03
mk_ws; run_runner FAKE_MODE=turncap; RC=$?
check "turncap: one JOUST-RC"       '[ "$(rc_count)" = "1" ]'
check "turncap: JOUST-RC 03"        'grep -q "^JOUST-RC 03 " "$WS/_local_run.log"'
rm -rf "$WS"

# wall-clock timeout -> 01 (the runner's own SIGALRM kill records rc 124 internally; local-run.sh
# does not propagate it as an outer exit code, so assert on the log line, not $?).
mk_ws; run_runner FAKE_MODE=hang JE_TIMEOUT_SECS=1
check "timeout: TIMEOUT marker"     'grep -q "^JOUST-LOCAL-TIMEOUT " "$WS/_local_run.log"'
check "timeout: one JOUST-RC"       '[ "$(rc_count)" = "1" ]'
check "timeout: JOUST-RC 01"        'grep -q "^JOUST-RC 01 " "$WS/_local_run.log"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
