#!/usr/bin/env bash
# Tests for bin/minimax-run.sh watchdog/retry + JE-RC + fold-in-B key scrub. Run: bash bin/minimax-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/minimax-run.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }
mk_ws() {
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"; printf 'do it' > "$WS/_brief.txt"
  cat > "$WS/stub/claude" <<'STUB'
#!/usr/bin/env bash
TF="$WS/.tries"; n=0; [ -f "$TF" ] && n=$(cat "$TF"); n=$((n+1)); echo "$n" > "$TF"
printf '%s\n' "$@" > "$WS/child-args.txt"
case "${FAKE_MODE:-ok}" in
  ok)        echo done; echo "print('hi')" > solution.py; exit 0 ;;
  turncap)   echo "Reached max turns (30)"; exit 1 ;;
  turncapjson) echo '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":30}'; exit 1 ;;
  stall)     echo boot; sleep 30; exit 0 ;;
  stallonce) if [ "$n" -ge 2 ]; then echo done; echo x>solution.py; exit 0; else echo boot; sleep 30; fi ;;
  hang)      sleep 30; exit 0 ;;
  scrub)     env > "$WS/child-env.txt"; echo x>solution.py; exit 0 ;;
esac
STUB
  chmod +x "$WS/stub/claude"
}
run_runner() { ( cd "$WS" && env PATH="$WS/stub:$PATH" MINIMAX_API_KEY=test-key "$@" \
      bash "$RUNNER" >/dev/null 2>&1 ); }
rc_count() { grep -c '^JOUST-RC ' "$WS/_minimax_run.log"; }
echo "== minimax-run.sh watchdog tests =="

mk_ws; run_runner FAKE_MODE=ok; RC=$?
check "ok: exits 0"                   '[ "$RC" -eq 0 ]'
check "ok: one JOUST-RC 00"           '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_minimax_run.log"'
check "ok: one DONE exit=0"           '[ "$(grep -c "^JOUST-MINIMAX-DONE exit=0" "$WS/_minimax_run.log")" = "1" ]'
check "ok: stream-json liveness flags passed" 'grep -qx -- "--output-format" "$WS/child-args.txt" && grep -qx "stream-json" "$WS/child-args.txt" && grep -qx -- "--verbose" "$WS/child-args.txt" && grep -qx -- "--include-partial-messages" "$WS/child-args.txt"'
rm -rf "$WS"

# stream-json turn-cap: {"subtype":"error_max_turns"} result event (no plain "Reached max turns") -> RC 03
mk_ws; run_runner FAKE_MODE=turncapjson
check "turncap-json: one JOUST-RC 03" '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 03 " "$WS/_minimax_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=stallonce JE_STALL_SECS=1 JE_TIMEOUT_SECS=30; RC=$?
check "stall-retry-ok: exits 0"       '[ "$RC" -eq 0 ]'
check "stall-retry-ok: RC 00"         '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_minimax_run.log"'
check "stall-retry-ok: one RETRY"     '[ "$(grep -c "^JOUST-MINIMAX-RETRY reason=zero-output-stall" "$WS/_minimax_run.log")" = "1" ]'
check "stall-retry-ok: no KILLED"     '! grep -qE "^JOUST-MINIMAX-(KILLED|TIMEOUT)" "$WS/_minimax_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=stall JE_STALL_SECS=1 JE_TIMEOUT_SECS=30
check "stall-exhausted: one KILLED"   '[ "$(grep -c "^JOUST-MINIMAX-KILLED reason=zero-output-stall" "$WS/_minimax_run.log")" = "1" ]'
check "stall-exhausted: one RC 01"    '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_minimax_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=hang JE_STALL_SECS=10 JE_TIMEOUT_SECS=1
check "timeout-exhausted: one TIMEOUT" '[ "$(grep -c "^JOUST-MINIMAX-TIMEOUT " "$WS/_minimax_run.log")" = "1" ]'
check "timeout-exhausted: one RC 01"  '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_minimax_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=scrub ANTHROPIC_API_KEY=leaked-test-key; RC=$?
check "scrub: ANTHROPIC_API_KEY gone" '! grep -q "^ANTHROPIC_API_KEY=" "$WS/child-env.txt"'
# security-sweep H1: raw provider key must NOT reach the child; token flows only as ANTHROPIC_AUTH_TOKEN.
check "scrub: raw MINIMAX_API_KEY gone" '! grep -q "^MINIMAX_API_KEY=" "$WS/child-env.txt"'
check "scrub: auth token carries key"   'grep -q "^ANTHROPIC_AUTH_TOKEN=test-key" "$WS/child-env.txt"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
