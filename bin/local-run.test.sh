#!/usr/bin/env bash
# Tests for bin/local-run.sh JE-RC observability + watchdog/retry paths. Every exit path appends exactly
# ONE terminal JOUST-LOCAL-{DONE|TIMEOUT|KILLED|ERROR} status line + exactly ONE JOUST-RC line.
# PATH-stubbed fake `claude`; no network, no model, macOS + Linux portable. Run: bash bin/local-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/local-run.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }

# Fresh workspace with a PATH-first fake `claude`. FAKE_MODE controls simulated behaviour; a per-ws
# counter file distinguishes try #1 from the retry (try #2) for the *once modes.
mk_ws() {
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"
  printf 'write a tiny script' > "$WS/_brief.txt"
  cat > "$WS/stub/claude" <<'STUB'
#!/usr/bin/env bash
TF="$WS/.tries"; n=0; [ -f "$TF" ] && n=$(cat "$TF"); n=$((n+1)); echo "$n" > "$TF"
printf '%s\n' "$@" > "$WS/child-args.txt"
case "${FAKE_MODE:-ok}" in
  ok)        echo "fake claude: done"; echo "print('hi')" > solution.py; exit 0 ;;
  turncap)   echo "Reached max turns (20)"; exit 1 ;;
  turncapjson) echo '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":20}'; exit 1 ;;
  hang)      sleep 30; exit 0 ;;                                   # never writes -> wall clock (stall disabled in test)
  hangonce)  if [ "$n" -ge 2 ]; then echo done; echo "x" > solution.py; exit 0; else sleep 30; fi ;;
  stall)     echo boot; sleep 30; exit 0 ;;                        # writes once then silent -> stall watchdog
  stallonce) if [ "$n" -ge 2 ]; then echo done; echo "x" > solution.py; exit 0; else echo boot; sleep 30; fi ;;
  scrub)     env > "$WS/child-env.txt"; echo "print('hi')" > solution.py; exit 0 ;;
esac
STUB
  chmod +x "$WS/stub/claude"
}
run_runner() { ( cd "$WS" && env PATH="$WS/stub:$PATH" OMLX_AUTH_TOKEN=test-key "$@" \
      bash "$RUNNER" --model test >/dev/null 2>&1 ); }
rc_count() { grep -c '^JOUST-RC ' "$WS/_local_run.log"; }

echo "== local-run.sh JE-RC + watchdog tests =="

# success -> 00
mk_ws; run_runner FAKE_MODE=ok; RC=$?
check "ok: exits 0"                 '[ "$RC" -eq 0 ]'
check "ok: exactly one JOUST-RC"    '[ "$(rc_count)" = "1" ]'
check "ok: JOUST-RC 00"             'grep -q "^JOUST-RC 00 " "$WS/_local_run.log"'
check "ok: one DONE exit=0"         '[ "$(grep -c "^JOUST-LOCAL-DONE exit=0" "$WS/_local_run.log")" = "1" ]'
check "ok: stream-json liveness flags passed" 'grep -qx -- "--output-format" "$WS/child-args.txt" && grep -qx "stream-json" "$WS/child-args.txt" && grep -qx -- "--verbose" "$WS/child-args.txt" && grep -qx -- "--include-partial-messages" "$WS/child-args.txt"'
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

# stream-json turn-cap: {"subtype":"error_max_turns"} result event (no plain "Reached max turns") -> 03
mk_ws; run_runner FAKE_MODE=turncapjson
check "turncap-json: one JOUST-RC"  '[ "$(rc_count)" = "1" ]'
check "turncap-json: JOUST-RC 03"   'grep -q "^JOUST-RC 03 " "$WS/_local_run.log"'
rm -rf "$WS"

# stall-then-success: try1 goes silent (stall kill 125), retry once, try2 succeeds -> RC 00, NO terminal KILLED
mk_ws; run_runner FAKE_MODE=stallonce JE_STALL_SECS=1 JE_TIMEOUT_SECS=30; RC=$?
check "stall-retry-ok: exits 0"          '[ "$RC" -eq 0 ]'
check "stall-retry-ok: one JOUST-RC 00"  '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_local_run.log"'
check "stall-retry-ok: one DONE exit=0"  '[ "$(grep -c "^JOUST-LOCAL-DONE exit=0" "$WS/_local_run.log")" = "1" ]'
check "stall-retry-ok: one RETRY stall"  '[ "$(grep -c "^JOUST-LOCAL-RETRY reason=zero-output-stall" "$WS/_local_run.log")" = "1" ]'
check "stall-retry-ok: no KILLED/TIMEOUT" '! grep -qE "^JOUST-LOCAL-(KILLED|TIMEOUT)" "$WS/_local_run.log"'
rm -rf "$WS"

# stall exhausted: both tries stall -> one RETRY, one KILLED, one JOUST-RC 01, NO DONE exit=0
mk_ws; run_runner FAKE_MODE=stall JE_STALL_SECS=1 JE_TIMEOUT_SECS=30
check "stall-exhausted: one RETRY stall"  '[ "$(grep -c "^JOUST-LOCAL-RETRY reason=zero-output-stall" "$WS/_local_run.log")" = "1" ]'
check "stall-exhausted: one KILLED"       '[ "$(grep -c "^JOUST-LOCAL-KILLED reason=zero-output-stall" "$WS/_local_run.log")" = "1" ]'
check "stall-exhausted: one JOUST-RC 01"  '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_local_run.log"'
check "stall-exhausted: no DONE exit=0"   '! grep -q "^JOUST-LOCAL-DONE exit=0" "$WS/_local_run.log"'
rm -rf "$WS"

# hard-timeout retried then succeeds: try1 hangs (wall 124), retry, try2 ok. Stall > timeout so only wall fires.
mk_ws; run_runner FAKE_MODE=hangonce JE_STALL_SECS=10 JE_TIMEOUT_SECS=1; RC=$?
check "timeout-retry-ok: exits 0"         '[ "$RC" -eq 0 ]'
check "timeout-retry-ok: one RETRY wall"  '[ "$(grep -c "^JOUST-LOCAL-RETRY reason=wall-clock-timeout" "$WS/_local_run.log")" = "1" ]'
check "timeout-retry-ok: one JOUST-RC 00" '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_local_run.log"'
rm -rf "$WS"

# hard-timeout exhausted: both tries hang -> one RETRY, one TIMEOUT (after 1 retry), one JOUST-RC 01
mk_ws; run_runner FAKE_MODE=hang JE_STALL_SECS=10 JE_TIMEOUT_SECS=1
check "timeout-exhausted: one RETRY wall"  '[ "$(grep -c "^JOUST-LOCAL-RETRY reason=wall-clock-timeout" "$WS/_local_run.log")" = "1" ]'
check "timeout-exhausted: one TIMEOUT"     '[ "$(grep -c "^JOUST-LOCAL-TIMEOUT " "$WS/_local_run.log")" = "1" ]'
check "timeout-exhausted: one JOUST-RC 01" '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_local_run.log"'
check "timeout-exhausted: no DONE exit=0"  '! grep -q "^JOUST-LOCAL-DONE exit=0" "$WS/_local_run.log"'
rm -rf "$WS"

# fold-in B: ANTHROPIC_API_KEY scrubbed from the child env; the provider's own key still present
mk_ws; run_runner FAKE_MODE=scrub ANTHROPIC_API_KEY=leaked-test-key; RC=$?
check "scrub: exits 0"                     '[ "$RC" -eq 0 ]'
check "scrub: ANTHROPIC_API_KEY absent"    '! grep -q "^ANTHROPIC_API_KEY=" "$WS/child-env.txt"'
check "scrub: own OMLX key still present"  'grep -q "^OMLX_AUTH_TOKEN=" "$WS/child-env.txt"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
