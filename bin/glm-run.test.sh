#!/usr/bin/env bash
# Tests for bin/glm-run.sh transient-overload handling (issue #25) and timeout-class
# transient API-error retry (issue #31). Layer A / deterministic: a PATH-stubbed fake
# `claude` simulates z.ai responses; no network, no model, macOS-portable.
# Run: bash bin/glm-run.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$HERE/glm-run.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }

# Fresh workspace with a PATH-first fake `claude`. The fake fails the first
# $FAKE_FAILS calls in $FAKE_MODE (529/timeout = transient text, hard/authprefixed =
# non-transient, wallclock = rc 124), then succeeds (writing a deliverable). It records
# call count + selected env.
mk_ws() { # $1=fake_fails $2=mode
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"
  printf 'write a tiny script' > "$WS/_brief.txt"
  cat > "$WS/stub/claude" <<'STUB'
#!/usr/bin/env bash
n=$(cat "$WS/calls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$WS/calls"
{ echo "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-}";
  echo "API_TIMEOUT_MS=${API_TIMEOUT_MS:-}"; } > "$WS/env.txt"
if [ "$n" -le "${FAKE_FAILS:-0}" ]; then
  case "${FAKE_MODE:-529}" in
    529)        echo "API Error: 529 [1305][The service may be temporarily overloaded, please try again later]"; exit 1 ;;
    hard)       echo "Error: invalid API key. Fix your credentials."; exit 1 ;;
    # issue #31: the CLI's own client-side timeout surfaces as a generic 'API Error: The
    # operation timed out.' (rc 1) — transient, must retry like 529.
    timeout)      echo "API Error: The operation timed out."; exit 1 ;;
    # Boundary: rc 124 is the RUNNER's own wall-clock SIGALRM kill (NOT the CLI timeout).
    # It must NEVER retry — prove the grep matcher cannot resurrect a wall-clock-killed
    # try even when its output carries timeout-shaped text.
    wallclock)    echo "API Error: The operation timed out."; exit 124 ;;
    # Boundary: auth text carried on the SAME 'API Error:' prefix must NOT retry — the
    # matcher requires a transient SHAPE (5xx digits / overloaded / timed-out word), so
    # the prefix alone is insufficient. (Contrast FAKE_MODE=hard: auth with no prefix.)
    authprefixed) echo "API Error: invalid API key. Fix your credentials."; exit 1 ;;
  esac
fi
echo "fake claude: task done"; echo "print('hi')" > solution.py; exit 0
STUB
  chmod +x "$WS/stub/claude"
}

run_runner() { # extra env via leading VAR=val args to `env`
  ( cd "$WS" && env PATH="$WS/stub:$PATH" ZAI_API_KEY=test-key \
      JE_GLM_JITTER_MAX=0 JE_GLM_BACKOFF_BASE=0 JE_TIMEOUT_SECS=30 "$@" \
      bash "$RUNNER" --model opus >/dev/null 2>&1 )
}

echo "== glm-run.sh transient-overload tests =="

# T1: one 529 then success -> retried once, rc 0, deliverable exists, env aligned.
mk_ws; export FAKE_FAILS=1 FAKE_MODE=529
run_runner FAKE_FAILS=1 FAKE_MODE=529; RC=$?
check "T1: 529-then-success exits 0"                '[ "$RC" -eq 0 ]'
check "T1: exactly 2 claude calls"                  '[ "$(cat "$WS/calls")" = "2" ]'
check "T1: RETRY marker logged"                     'grep -qE "^JOUST-GLM-RETRY try=2/4 .*transient-overload" "$WS/_glm_run.log"'
check "T1: DONE exit=0"                             'grep -q "^JOUST-GLM-DONE exit=0" "$WS/_glm_run.log"'
check "T1: deliverable saved"                       '[ -f "$WS/solution.py" ]'
check "T1: nonessential traffic disabled for call"  'grep -q "^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1$" "$WS/env.txt"'
check "T1: API_TIMEOUT_MS defaulted (3000000)"      'grep -q "^API_TIMEOUT_MS=3000000$" "$WS/env.txt"'
rm -rf "$WS"

# T2: hard (non-transient) error -> NO retry, fail closed, single call.
mk_ws
run_runner FAKE_FAILS=99 FAKE_MODE=hard; RC=$?
check "T2: hard error exits nonzero"                '[ "$RC" -ne 0 ]'
check "T2: exactly 1 claude call (no retry)"        '[ "$(cat "$WS/calls")" = "1" ]'
check "T2: no RETRY marker"                         '! grep -q "^JOUST-GLM-RETRY" "$WS/_glm_run.log"'
rm -rf "$WS"

# T3: persistent 529 -> retries capped (JE_GLM_RETRIES=2 -> 3 tries), then fail closed.
mk_ws
run_runner FAKE_FAILS=99 FAKE_MODE=529 JE_GLM_RETRIES=2; RC=$?
check "T3: persistent 529 exits nonzero"            '[ "$RC" -ne 0 ]'
check "T3: exactly 3 claude calls (1 + 2 retries)"  '[ "$(cat "$WS/calls")" = "3" ]'
check "T3: RETRIES-EXHAUSTED logged"                'grep -q "^JOUST-GLM-RETRIES-EXHAUSTED tries=3" "$WS/_glm_run.log"'
check "T3: DONE exit nonzero"                       'grep -qE "^JOUST-GLM-DONE exit=[1-9]" "$WS/_glm_run.log"'
rm -rf "$WS"

# T4: retries can be disabled entirely.
mk_ws
run_runner FAKE_FAILS=99 FAKE_MODE=529 JE_GLM_RETRIES=0; RC=$?
check "T4: JE_GLM_RETRIES=0 -> single call"         '[ "$(cat "$WS/calls")" = "1" ]'
check "T4: exits nonzero"                           '[ "$RC" -ne 0 ]'
rm -rf "$WS"

# T5: guard rails unchanged — missing key still exits 3 before any call.
WS=$(mktemp -d)
( cd "$WS" && env ZAI_API_KEY= bash "$RUNNER" --model opus >/dev/null 2>&1 ); RC=$?
check "T5: missing ZAI_API_KEY exits 3"             '[ "$RC" -eq 3 ]'
rm -rf "$WS"

# T6 (issue #31): one 'API Error: The operation timed out.' then success -> retried once, rc 0.
mk_ws; export FAKE_FAILS=1 FAKE_MODE=timeout
run_runner FAKE_FAILS=1 FAKE_MODE=timeout; RC=$?
check "T6: timeout-then-success exits 0"              '[ "$RC" -eq 0 ]'
check "T6: exactly 2 claude calls"                    '[ "$(cat "$WS/calls")" = "2" ]'
check "T6: RETRY marker logged (transient-overload)"  'grep -qE "^JOUST-GLM-RETRY try=2/4 .*transient-overload" "$WS/_glm_run.log"'
check "T6: DONE exit=0"                               'grep -q "^JOUST-GLM-DONE exit=0" "$WS/_glm_run.log"'
check "T6: deliverable saved"                         '[ -f "$WS/solution.py" ]'
rm -rf "$WS"

# T7: rc 124 = the runner's OWN wall-clock SIGALRM kill — must NEVER retry, even though
# the try's output carries timeout-shaped text (the rc-124 branch fires before the grep).
mk_ws; export FAKE_FAILS=99 FAKE_MODE=wallclock
run_runner FAKE_FAILS=99 FAKE_MODE=wallclock; RC=$?
check "T7: wall-clock rc 124 propagated"              '[ "$RC" -eq 124 ]'
check "T7: exactly 1 claude call (no retry)"          '[ "$(cat "$WS/calls")" = "1" ]'
check "T7: TIMEOUT marker logged"                     'grep -q "^JOUST-GLM-TIMEOUT secs=" "$WS/_glm_run.log"'
check "T7: no RETRY marker"                           '! grep -q "^JOUST-GLM-RETRY" "$WS/_glm_run.log"'
rm -rf "$WS"

# T8: auth text on the SAME 'API Error:' prefix must NOT retry — the prefix anchor alone
# is insufficient; the matcher requires a transient shape. (Conservatism: never retry auth.)
mk_ws; export FAKE_FAILS=99 FAKE_MODE=authprefixed
run_runner FAKE_FAILS=99 FAKE_MODE=authprefixed; RC=$?
check "T8: prefixed auth error exits nonzero"         '[ "$RC" -ne 0 ]'
check "T8: exactly 1 claude call (no retry)"          '[ "$(cat "$WS/calls")" = "1" ]'
check "T8: no RETRY marker"                           '! grep -q "^JOUST-GLM-RETRY" "$WS/_glm_run.log"'
rm -rf "$WS"

# T9: persistent timeout retries are CAPPED (JE_GLM_RETRIES=2 -> 3 tries), then fail closed.
mk_ws
run_runner FAKE_FAILS=99 FAKE_MODE=timeout JE_GLM_RETRIES=2; RC=$?
check "T9: persistent timeout exits nonzero"          '[ "$RC" -ne 0 ]'
check "T9: exactly 3 claude calls (1 + 2 retries)"    '[ "$(cat "$WS/calls")" = "3" ]'
check "T9: RETRIES-EXHAUSTED logged"                  'grep -q "^JOUST-GLM-RETRIES-EXHAUSTED tries=3" "$WS/_glm_run.log"'
check "T9: DONE exit nonzero"                         'grep -qE "^JOUST-GLM-DONE exit=[1-9]" "$WS/_glm_run.log"'
rm -rf "$WS"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
