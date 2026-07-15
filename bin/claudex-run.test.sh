#!/usr/bin/env bash
# Tests for bin/claudex-run.sh watchdog/retry + JE-RC + env assembly + fail-fast guards. PATH-stubbed
# fake `claude` AND fake `curl` (the proxy reachability probe); jitter disabled; token comes from a
# stub client-token file. Run: bash bin/claudex-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/claudex-run.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }
mk_ws() {
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"; printf 'do it' > "$WS/_brief.txt"
  printf 'stub-proxy-token\n' > "$WS/client-token"
  cat > "$WS/stub/claude" <<'STUB'
#!/usr/bin/env bash
TF="$WS/.tries"; n=0; [ -f "$TF" ] && n=$(cat "$TF"); n=$((n+1)); echo "$n" > "$TF"
printf '%s\n' "$@" > "$WS/child-args.txt"
case "${FAKE_MODE:-ok}" in
  ok)        echo done; echo "print('hi')" > solution.py; exit 0 ;;
  turncapjson) echo '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":30}'; exit 1 ;;
  stall)     echo boot; sleep 30; exit 0 ;;
  stallonce) if [ "$n" -ge 2 ]; then echo done; echo x>solution.py; exit 0; else echo boot; sleep 30; fi ;;
  hang)      sleep 30; exit 0 ;;
  transientonce) if [ "$n" -ge 2 ]; then echo done; echo x>solution.py; exit 0; else echo 'API Error: 503 upstream overloaded'; exit 1; fi ;;
  scrub)     env > "$WS/child-env.txt"; echo x>solution.py; exit 0 ;;
esac
STUB
  chmod +x "$WS/stub/claude"
  # The proxy reachability probe: exit ${FAKE_CURL_RC:-0} (0 = "an HTTP answer came back").
  cat > "$WS/stub/curl" <<'STUB'
#!/usr/bin/env bash
exit "${FAKE_CURL_RC:-0}"
STUB
  chmod +x "$WS/stub/curl"
}
# Defaults first, then "$@" so a test's own env pairs (later `env` args) override them.
run_runner() { ( cd "$WS" && env PATH="$WS/stub:$PATH" JE_CLAUDEX_TOKEN_FILE="$WS/client-token" JE_CLAUDEX_JITTER_MAX=0 "$@" \
      bash "$RUNNER" --model gpt-5.6-sol >/dev/null 2>&1 ); }
rc_count() { grep -c '^JOUST-RC ' "$WS/_claudex_run.log"; }
echo "== claudex-run.sh watchdog/env tests =="

mk_ws; run_runner FAKE_MODE=ok; RC=$?
check "ok: exits 0"                   '[ "$RC" -eq 0 ]'
check "ok: one JOUST-RC 00"           '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_claudex_run.log"'
check "ok: one DONE exit=0"           '[ "$(grep -c "^JOUST-CLAUDEX-DONE exit=0" "$WS/_claudex_run.log")" = "1" ]'
check "ok: provenance has endpoint"   'grep -q "^JOUST-CLAUDEX-PROVENANCE endpoint=127.0.0.1:8317 " "$WS/_claudex_run.log"'
check "ok: stream-json liveness flags passed" 'grep -qx -- "--output-format" "$WS/child-args.txt" && grep -qx "stream-json" "$WS/child-args.txt" && grep -qx -- "--verbose" "$WS/child-args.txt" && grep -qx -- "--include-partial-messages" "$WS/child-args.txt"'
check "ok: token never lands in the log" '! grep -q "stub-proxy-token" "$WS/_claudex_run.log"'
rm -rf "$WS"

# Env assembly: base url + token-from-file + subagent model + recipe env; secrets scrubbed.
mk_ws; run_runner FAKE_MODE=scrub ANTHROPIC_API_KEY=leaked-test-key OPENAI_API_KEY=foreign-key GH_TOKEN=foreign-gh; RC=$?
check "env: default base url"          'grep -q "^ANTHROPIC_BASE_URL=http://127.0.0.1:8317$" "$WS/child-env.txt"'
check "env: auth token from file"      'grep -q "^ANTHROPIC_AUTH_TOKEN=stub-proxy-token$" "$WS/child-env.txt"'
check "env: subagent model = FLAG model" 'grep -q "^CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-sol$" "$WS/child-env.txt"'
check "env: effort always enabled"     'grep -q "^CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1$" "$WS/child-env.txt"'
check "env: tool concurrency capped"   'grep -q "^CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3$" "$WS/child-env.txt"'
check "env: tool search disabled"      'grep -q "^ENABLE_TOOL_SEARCH=false$" "$WS/child-env.txt"'
# fold-in B + security-sweep H1: the REAL Anthropic key and foreign creds must NOT reach the proxy child.
check "scrub: ANTHROPIC_API_KEY gone"  '! grep -q "^ANTHROPIC_API_KEY=" "$WS/child-env.txt"'
check "scrub: foreign OPENAI key gone" '! grep -q "^OPENAI_API_KEY=" "$WS/child-env.txt"'
check "scrub: foreign GH token gone"   '! grep -q "^GH_TOKEN=" "$WS/child-env.txt"'
rm -rf "$WS"

# A custom JE_CLAUDEX_BASE_URL + a different FLAG model both flow into the child env.
mk_ws
( cd "$WS" && env PATH="$WS/stub:$PATH" JE_CLAUDEX_TOKEN_FILE="$WS/client-token" JE_CLAUDEX_JITTER_MAX=0 \
    JE_CLAUDEX_BASE_URL=http://127.0.0.1:9317 FAKE_MODE=scrub \
    bash "$RUNNER" --model gpt-5.6-luna >/dev/null 2>&1 )
check "override: custom base url flows"    'grep -q "^ANTHROPIC_BASE_URL=http://127.0.0.1:9317$" "$WS/child-env.txt"'
check "override: FLAG model -> subagent"   'grep -q "^CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-luna$" "$WS/child-env.txt"'
check "override: FLAG model -> claude argv" 'grep -qx -- "--model" "$WS/child-args.txt" && grep -qx "gpt-5.6-luna" "$WS/child-args.txt"'
check "override: custom endpoint in provenance" 'grep -q "^JOUST-CLAUDEX-PROVENANCE endpoint=127.0.0.1:9317 " "$WS/_claudex_run.log"'
rm -rf "$WS"

# Fail-fast: missing token file -> exit 3, RC 07, loud and immediate (claude never invoked).
mk_ws; run_runner JE_CLAUDEX_TOKEN_FILE="$WS/nope"; RC=$?
check "missing-token: exits 3"        '[ "$RC" -eq 3 ]'
check "missing-token: one RC 07"      '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 07 missing-token-file" "$WS/_claudex_run.log"'
check "missing-token: claude not run" '[ ! -f "$WS/child-args.txt" ]'
rm -rf "$WS"

# Fail-fast: proxy connection refused (curl connect-class failure) -> exit 5, RC 07.
mk_ws; run_runner FAKE_CURL_RC=7; RC=$?
check "proxy-refused: exits 5"        '[ "$RC" -eq 5 ]'
check "proxy-refused: one RC 07"      '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 07 proxy-unreachable" "$WS/_claudex_run.log"'
check "proxy-refused: claude not run" '[ ! -f "$WS/child-args.txt" ]'
rm -rf "$WS"

# stream-json turn-cap: {"subtype":"error_max_turns"} result event -> RC 03
mk_ws; run_runner FAKE_MODE=turncapjson
check "turncap-json: one JOUST-RC 03" '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 03 " "$WS/_claudex_run.log"'
rm -rf "$WS"

# Transient (proxy surfaces upstream overload as 5xx): retry with backoff, then succeed.
mk_ws; run_runner FAKE_MODE=transientonce JE_CLAUDEX_BACKOFF_BASE=0; RC=$?
check "transient-retry-ok: exits 0"   '[ "$RC" -eq 0 ]'
check "transient-retry-ok: RC 00"     '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_claudex_run.log"'
check "transient-retry-ok: one RETRY" '[ "$(grep -c "reason=transient-overload" "$WS/_claudex_run.log")" = "1" ]'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=stallonce JE_STALL_SECS=1 JE_TIMEOUT_SECS=30; RC=$?
check "stall-retry-ok: exits 0"       '[ "$RC" -eq 0 ]'
check "stall-retry-ok: RC 00"         '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 00 ok" "$WS/_claudex_run.log"'
check "stall-retry-ok: one RETRY"     '[ "$(grep -c "^JOUST-CLAUDEX-RETRY reason=zero-output-stall" "$WS/_claudex_run.log")" = "1" ]'
check "stall-retry-ok: no KILLED"     '! grep -qE "^JOUST-CLAUDEX-(KILLED|TIMEOUT)" "$WS/_claudex_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=stall JE_STALL_SECS=1 JE_TIMEOUT_SECS=30
check "stall-exhausted: one KILLED"   '[ "$(grep -c "^JOUST-CLAUDEX-KILLED reason=zero-output-stall" "$WS/_claudex_run.log")" = "1" ]'
check "stall-exhausted: one RC 01"    '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_claudex_run.log"'
check "stall-exhausted: no DONE 0"    '! grep -q "^JOUST-CLAUDEX-DONE exit=0" "$WS/_claudex_run.log"'
rm -rf "$WS"

mk_ws; run_runner FAKE_MODE=hang JE_STALL_SECS=10 JE_TIMEOUT_SECS=1
check "timeout-exhausted: one RETRY"  '[ "$(grep -c "^JOUST-CLAUDEX-RETRY reason=wall-clock-timeout" "$WS/_claudex_run.log")" = "1" ]'
check "timeout-exhausted: one TIMEOUT" '[ "$(grep -c "^JOUST-CLAUDEX-TIMEOUT " "$WS/_claudex_run.log")" = "1" ]'
check "timeout-exhausted: one RC 01"  '[ "$(rc_count)" = "1" ] && grep -q "^JOUST-RC 01 " "$WS/_claudex_run.log"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
