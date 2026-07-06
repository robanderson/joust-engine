#!/usr/bin/env bash
# Tests for bin/codex-run.sh watchdog/retry + JE-RC + fold-in-B key scrub. PATH-stubbed fake `codex`.
# Codex has no --max-turns, so no turn-cap case. Run: bash bin/codex-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/codex-run.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }
mk_ws() {
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"; printf 'do it' > "$WS/_brief.txt"
  # The stub ignores codex's argv (exec -s ... -o _codex_last.txt ... "<brief>") and acts by FAKE_MODE.
  cat > "$WS/stub/codex" <<'STUB'
#!/usr/bin/env bash
TF="$WS/.tries"; n=0; [ -f "$TF" ] && n=$(cat "$TF"); n=$((n+1)); echo "$n" > "$TF"
case "${FAKE_MODE:-ok}" in
  ok)        echo "final msg" > _codex_last.txt; echo done; echo "print('hi')" > solution.py; exit 0 ;;
  authfail)  echo "invalid_api_key: nope"; exit 1 ;;
  stall)     echo boot; sleep 30; exit 0 ;;
  stallonce) if [ "$n" -ge 2 ]; then echo "final msg" > _codex_last.txt; echo done; echo x>solution.py; exit 0; else echo boot; sleep 30; fi ;;
  hang)      sleep 30; exit 0 ;;
  scrub)     env > "$WS/child-env.txt"; echo "print('hi')" > solution.py; exit 0 ;;
  clobber)   rm -f _codex_run.log _brief.txt; echo "final msg" > _codex_last.txt; echo x > solution.py; exit 0 ;;
esac
STUB
  chmod +x "$WS/stub/codex"
}
run_runner() { ( cd "$WS" && env PATH="$WS/stub:$PATH" "$@" \
      bash "$RUNNER" -m test >/dev/null 2>&1 ); }
rc_count() { grep -c '^JOUST-RC ' "$WS/_codex_run.log"; }
echo "== codex-run.sh watchdog tests =="

mk_ws; run_runner FAKE_MODE=ok; RC=$?
check "ok: exits 0"                   '[ "$RC" -eq 0 ]'
check "ok: one JOUST-RC 00"           '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_codex_run.log"'
check "ok: one DONE exit=0"           '[ "$(grep -c "^JOUST-CODEX-DONE exit=0" "$WS/_codex_run.log")" = "1" ]'
rm -rf "$WS"

# auth-failure force-fail -> RC 02, non-retryable (only one try attempted)
mk_ws; run_runner FAKE_MODE=authfail JE_STALL_SECS=30 JE_TIMEOUT_SECS=30
check "authfail: one JOUST-RC 02"     '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 02 " "$WS/_codex_run.log"'
check "authfail: no DONE exit=0"      '! grep -q "^JOUST-CODEX-DONE exit=0" "$WS/_codex_run.log"'
check "authfail: no RETRY"            '! grep -q "^JOUST-CODEX-RETRY " "$WS/_codex_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=stallonce JE_STALL_SECS=1 JE_TIMEOUT_SECS=30; RC=$?
check "stall-retry-ok: exits 0"       '[ "$RC" -eq 0 ]'
check "stall-retry-ok: RC 00"         '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_codex_run.log"'
check "stall-retry-ok: one RETRY"     '[ "$(grep -c "^JOUST-CODEX-RETRY reason=zero-output-stall" "$WS/_codex_run.log")" = "1" ]'
check "stall-retry-ok: no KILLED"     '! grep -qE "^JOUST-CODEX-(KILLED|TIMEOUT)" "$WS/_codex_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=stall JE_STALL_SECS=1 JE_TIMEOUT_SECS=30
check "stall-exhausted: one KILLED"   '[ "$(grep -c "^JOUST-CODEX-KILLED reason=zero-output-stall" "$WS/_codex_run.log")" = "1" ]'
check "stall-exhausted: one RC 01"    '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_codex_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=hang JE_STALL_SECS=10 JE_TIMEOUT_SECS=1
check "timeout-exhausted: one TIMEOUT" '[ "$(grep -c "^JOUST-CODEX-TIMEOUT " "$WS/_codex_run.log")" = "1" ]'
check "timeout-exhausted: one RC 01"  '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_codex_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=scrub ANTHROPIC_API_KEY=leaked-test-key; RC=$?
check "scrub: ANTHROPIC_API_KEY gone" '! grep -q "^ANTHROPIC_API_KEY=" "$WS/child-env.txt"'
rm -rf "$WS"

# Provenance self-destruction guard (run-h impl-6): the worker deletes the log + brief mid-run; the
# runner must restamp the PROVENANCE line at finish so an honest success is not rejected fail-closed.
mk_ws; run_runner FAKE_MODE=clobber; RC=$?
check "clobber: exits 0"              '[ "$RC" -eq 0 ]'
check "clobber: RC 00 in fresh log"   '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_codex_run.log"'
check "clobber: provenance restamped" 'grep -q "^JOUST-CODEX-PROVENANCE .*restamped=finish$" "$WS/_codex_run.log"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
