#!/usr/bin/env bash
# Tests for bin/grok-run.sh JE-RC observability: every exit path appends exactly ONE terminal
# `JOUST-RC <code> <reason>` line with the right code. PATH-stubbed fake `grok`; no network, no
# model, macOS-portable. Run: bash bin/grok-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/grok-run.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }

# The fake `grok` lives OUTSIDE the workspace: grok-run.sh's auth force-fail is GUARDED on "no
# deliverable file other than the engine files exists" via `find .`, so a stub inside $WS would
# defeat that guard. FAKE_MODE:
#   ok       -> writes a deliverable, exit 0
#   auth     -> prints a terminal auth failure, writes NOTHING, exit 0 (drives force-fail rc 6)
#   turncap  -> prints "Reached max turns", exit 1
#   hang     -> sleeps past the wall clock (drives SIGALRM -> rc 124)
STUB=$(mktemp -d); trap 'rm -rf "$STUB"' EXIT
cat > "$STUB/grok" <<'STUB'
#!/usr/bin/env bash
case "${FAKE_MODE:-ok}" in
  ok)      echo "grok: done"; echo "print('hi')" > solution.py; exit 0 ;;
  auth)    echo "401 Unauthorized"; exit 0 ;;
  turncap) echo "Reached max turns (30)"; exit 1 ;;
  hang)    sleep 10; exit 0 ;;
esac
STUB
chmod +x "$STUB/grok"

mk_ws() { WS=$(mktemp -d); export WS; printf 'write a tiny script' > "$WS/_brief.txt"; }
run_runner() { ( cd "$WS" && env PATH="$STUB:$PATH" "$@" \
      bash "$RUNNER" -m grok-build >/dev/null 2>&1 ); }
rc_count() { grep -c '^JOUST-RC ' "$WS/_grok_run.log"; }

echo "== grok-run.sh JE-RC tests =="

# success -> 00
mk_ws; run_runner FAKE_MODE=ok; RC=$?
check "ok: exactly one JOUST-RC"    '[ "$(rc_count)" = "1" ]'
check "ok: JOUST-RC 00"             'grep -q "^JOUST-RC 00 " "$WS/_grok_run.log"'
rm -rf "$WS"

# missing brief -> 07 (exit 4)
WS=$(mktemp -d); export WS
( cd "$WS" && env PATH="$STUB:$PATH" bash "$RUNNER" -m grok-build >/dev/null 2>&1 ); RC=$?
check "missing-brief: exits 4"      '[ "$RC" -eq 4 ]'
check "missing-brief: one JOUST-RC" '[ "$(rc_count)" = "1" ]'
check "missing-brief: JOUST-RC 07"  'grep -q "^JOUST-RC 07 " "$WS/_grok_run.log"'
rm -rf "$WS"

# grok CLI not found -> 07 (exit 5). Restricted PATH (system tools, no grok).
WS=$(mktemp -d); export WS; printf 'x' > "$WS/_brief.txt"
( cd "$WS" && env PATH="/usr/bin:/bin" bash "$RUNNER" -m grok-build >/dev/null 2>&1 ); RC=$?
check "missing-runner: exits 5"     '[ "$RC" -eq 5 ]'
check "missing-runner: one JOUST-RC" '[ "$(rc_count)" = "1" ]'
check "missing-runner: JOUST-RC 07" 'grep -q "^JOUST-RC 07 " "$WS/_grok_run.log"'
rm -rf "$WS"

# auth/model/version force-fail -> 02
mk_ws; run_runner FAKE_MODE=auth
check "auth: one JOUST-RC"          '[ "$(rc_count)" = "1" ]'
check "auth: JOUST-RC 02"           'grep -q "^JOUST-RC 02 " "$WS/_grok_run.log"'
rm -rf "$WS"

# turn-cap -> 03
mk_ws; run_runner FAKE_MODE=turncap
check "turncap: one JOUST-RC"       '[ "$(rc_count)" = "1" ]'
check "turncap: JOUST-RC 03"        'grep -q "^JOUST-RC 03 " "$WS/_grok_run.log"'
rm -rf "$WS"

# wall-clock timeout -> 01 (assert on the log line; runner does not propagate rc 124 as outer exit)
mk_ws; run_runner FAKE_MODE=hang JE_TIMEOUT_SECS=1
check "timeout: TIMEOUT marker"     'grep -q "^JOUST-GROK-TIMEOUT " "$WS/_grok_run.log"'
check "timeout: one JOUST-RC"       '[ "$(rc_count)" = "1" ]'
check "timeout: JOUST-RC 01"        'grep -q "^JOUST-RC 01 " "$WS/_grok_run.log"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
