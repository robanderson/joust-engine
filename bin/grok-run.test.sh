#!/usr/bin/env bash
# Tests for bin/grok-run.sh watchdog/retry + JE-RC + fold-in-B key scrub. PATH-stubbed fake `grok`.
# Run: bash bin/grok-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/grok-run.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }
mk_ws() {
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"; printf 'do it' > "$WS/_brief.txt"
  cat > "$WS/stub/grok" <<'STUB'
#!/usr/bin/env bash
TF="$WS/.tries"; n=0; [ -f "$TF" ] && n=$(cat "$TF"); n=$((n+1)); echo "$n" > "$TF"
case "${FAKE_MODE:-ok}" in
  ok)        echo done; echo "print('hi')" > solution.py; exit 0 ;;
  turncap)   echo "Reached max turns (30)"; exit 1 ;;
  stall)     echo boot; sleep 30; exit 0 ;;
  stallonce) if [ "$n" -ge 2 ]; then echo done; echo x>solution.py; exit 0; else echo boot; sleep 30; fi ;;
  hang)      sleep 30; exit 0 ;;
  scrub)     env > "$WS/child-env.txt"; echo x>solution.py; exit 0 ;;
  authdecoy) echo "401 Unauthorized"; echo "print('decoy')" > solution.py; exit 0 ;;
esac
STUB
  chmod +x "$WS/stub/grok"
}
run_runner() { ( cd "$WS" && env PATH="$WS/stub:$PATH" "$@" \
      bash "$RUNNER" -m grok-build >/dev/null 2>&1 ); }
rc_count() { grep -c '^JOUST-RC ' "$WS/_grok_run.log"; }
echo "== grok-run.sh watchdog tests =="

mk_ws; run_runner FAKE_MODE=ok; RC=$?
check "ok: exits 0"                   '[ "$RC" -eq 0 ]'
check "ok: one JOUST-RC 00"           '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_grok_run.log"'
check "ok: one DONE exit=0"           '[ "$(grep -c "^JOUST-GROK-DONE exit=0" "$WS/_grok_run.log")" = "1" ]'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=turncap JE_STALL_SECS=30 JE_TIMEOUT_SECS=30
check "turncap: one JOUST-RC 03"      '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 03 " "$WS/_grok_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=stallonce JE_STALL_SECS=1 JE_TIMEOUT_SECS=30; RC=$?
check "stall-retry-ok: exits 0"       '[ "$RC" -eq 0 ]'
check "stall-retry-ok: RC 00"         '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_grok_run.log"'
check "stall-retry-ok: one RETRY"     '[ "$(grep -c "^JOUST-GROK-RETRY reason=zero-output-stall" "$WS/_grok_run.log")" = "1" ]'
check "stall-retry-ok: no KILLED"     '! grep -qE "^JOUST-GROK-(KILLED|TIMEOUT)" "$WS/_grok_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=stall JE_STALL_SECS=1 JE_TIMEOUT_SECS=30
check "stall-exhausted: one KILLED"   '[ "$(grep -c "^JOUST-GROK-KILLED reason=zero-output-stall" "$WS/_grok_run.log")" = "1" ]'
check "stall-exhausted: one RC 01"    '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_grok_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=hang JE_STALL_SECS=10 JE_TIMEOUT_SECS=1
check "timeout-exhausted: one TIMEOUT" '[ "$(grep -c "^JOUST-GROK-TIMEOUT " "$WS/_grok_run.log")" = "1" ]'
check "timeout-exhausted: one RC 01"  '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_grok_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=scrub ANTHROPIC_API_KEY=leaked-test-key; RC=$?
check "scrub: ANTHROPIC_API_KEY gone" '! grep -q "^ANTHROPIC_API_KEY=" "$WS/child-env.txt"'
rm -rf "$WS"

# security-sweep M6: an auth failure force-fails even when the model dropped a decoy deliverable file
# (the old `&& ! find <deliverable>` let a prompt-injected grok suppress the force-fail by writing one).
mk_ws; run_runner FAKE_MODE=authdecoy JE_STALL_SECS=30 JE_TIMEOUT_SECS=30; RC=$?
check "authdecoy: nonzero exit"       '[ "$RC" -ne 0 ]'
check "authdecoy: RC 02 (not 00)"     '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 02 " "$WS/_grok_run.log" && ! grep -q "^JOUST-RC 00 " "$WS/_grok_run.log"'
check "authdecoy: GROK-ERROR emitted" 'grep -q "^JOUST-GROK-ERROR " "$WS/_grok_run.log"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
