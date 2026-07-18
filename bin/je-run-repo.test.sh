#!/usr/bin/env bash
# Tests for bin/je-run-repo.sh (tracker #21 phase 2 — the git results bus). git is PATH-stubbed:
# every invocation is recorded, clone/init materialise a fake .git, push failures are injectable
# (FAKE_PUSH_FAILS=N fails the first N pushes) so the validated push||pull-rebase retry loop is
# exercised for real. Asserts: neutral identities, underscore/engine-artifact exclusion, the
# 5-attempt retry loop, graceful feature-off on absent env (exit 7), distinct input/git exits,
# and that NO hostname/LAN literal ships in the script (public repo hygiene).
# Run: bash bin/je-run-repo.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/je-run-repo.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi }

mk_ws() {
  WS=$(mktemp -d); export WS
  mkdir -p "$WS/stub"
  export GITLOG="$WS/git-calls.txt"
  # Stub git: record argv, then emulate just enough — clone/init create <dir>/.git so the
  # clone-or-reuse logic behaves; push honours FAKE_PUSH_FAILS via a counter file.
  cat > "$WS/stub/git" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GITLOG"
args=("$@"); i=0; diropt=""; sub=""
while [ $i -lt ${#args[@]} ]; do
  a="${args[$i]}"
  case "$a" in
    -C) i=$((i+1)); diropt="${args[$i]}" ;;
    -c) i=$((i+1)) ;;
    -*) ;;
    *) sub="$a"; break ;;
  esac
  i=$((i+1))
done
case "$sub" in
  clone)
    [ "${FAKE_CLONE_RC:-0}" -ne 0 ] && exit "$FAKE_CLONE_RC"
    dest="${args[${#args[@]}-1]}"; mkdir -p "$dest/.git"; exit 0 ;;
  init) mkdir -p "$diropt/.git"; exit 0 ;;
  push)
    cnt=$(cat "$WS/push-count" 2>/dev/null || echo 0); cnt=$((cnt+1)); echo "$cnt" > "$WS/push-count"
    [ "$cnt" -le "${FAKE_PUSH_FAILS:-0}" ] && exit 1
    exit 0 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$WS/stub/git"
}
# run_rr <argv...>: run the script with the stubbed git. Test-specific env (FAKE_*) is passed as a
# command-scoped prefix (`FAKE_PUSH_FAILS=2 run_rr ...`); RR_BASE overrides the remote base.
run_rr() { ( cd "$WS" && env PATH="$WS/stub:$PATH" JE_RUN_REPO_CACHE="$WS/cache" \
      JE_RUN_REMOTE_BASE="${RR_BASE-git@stub-host:stub-org}" \
      bash "$SCRIPT" "$@" > "$WS/out.txt" 2>"$WS/err.txt" ) < /dev/null; }
echo "== je-run-repo.sh contract tests =="

# ---- feature-off: absent remote base is a DISTINCT exit 7, git never invoked --------------------
mk_ws; RR_BASE= run_rr init run-1; RC=$?
check "no-env: exits 7 (run-repo disabled)"    '[ "$RC" -eq 7 ]'
check "no-env: loud feature-off notice"        'grep -q "run-repo disabled" "$WS/err.txt"'
check "no-env: git never invoked"              '[ ! -f "$GITLOG" ]'
rm -rf "$WS"

# ---- usage / input guards ----------------------------------------------------------------------
mk_ws; run_rr frobnicate run-1; RC=$?
check "unknown cmd: exits 2 (usage)"           '[ "$RC" -eq 2 ]'
run_rr init '../evil'; RC=$?
check "unsafe runId: exits 3"                  '[ "$RC" -eq 3 ]'
run_rr push_results run-1 '../evil' "$WS"; RC=$?
check "unsafe label: exits 3"                  '[ "$RC" -eq 3 ]'
run_rr push_results run-1 candidate-1 "$WS/no-such-ws"; RC=$?
check "missing workspace: exits 3"             '[ "$RC" -eq 3 ]'
run_rr push_log run-1 candidate-1 "$WS/no-such-log"; RC=$?
check "missing log file: exits 3"              '[ "$RC" -eq 3 ]'
run_rr publish run-1 "$WS/no-such-dir"; RC=$?
check "missing runDir: exits 3"                '[ "$RC" -eq 3 ]'
rm -rf "$WS"

# ---- init: seed clone with README + run metadata, engine-neutral identity, push main ------------
mk_ws; run_rr init run-1; RC=$?
SEED="$WS/cache/run-1/seed"
check "init: exits 0"                          '[ "$RC" -eq 0 ]'
check "init: README seeded"                    'grep -q "je-run-run-1" "$SEED/README.md"'
check "init: run metadata (runId/version/start)" 'grep -q "\"runId\": \"run-1\"" "$SEED/run.json" && grep -q "engineVersion" "$SEED/run.json" && grep -q "startedAt" "$SEED/run.json"'
check "init: neutral engine identity"          'grep -q "user.name=je-engine" "$GITLOG" && grep -q "user.email=engine@je" "$GITLOG"'
check "init: pushes main"                      'grep -q "push -q origin main" "$GITLOG"'
check "init: remote base never echoed"         '! grep -q "stub-host" "$WS/out.txt" && ! grep -q "stub-host" "$WS/err.txt"'
check "init: JE-RUNREPO ok marker"             'grep -q "^JE-RUNREPO init ok je-run-run-1$" "$WS/out.txt"'
rm -rf "$WS"

# ---- push_results: orphan branch, underscore exclusion, neutral worker identity -----------------
mk_ws
mkdir -p "$WS/attempt/sub" "$WS/attempt/_judges" "$WS/attempt/.git"
printf 'the plan\n' > "$WS/attempt/plan.md"
printf 'impl\n' > "$WS/attempt/sub/impl.txt"
printf 'engine brief\n' > "$WS/attempt/_brief.txt"
printf 'runner log\n' > "$WS/attempt/_glm_run.log"
printf 'seat file\n' > "$WS/attempt/_judges/seat.txt"
printf 'gitmeta\n' > "$WS/attempt/.git/config"
run_rr push_results run-1 candidate-1 "$WS/attempt"; RC=$?
CO="$WS/cache/run-1/worker-candidate-1"
check "results: exits 0"                       '[ "$RC" -eq 0 ]'
check "results: deliverables copied"           '[ -f "$CO/plan.md" ] && [ -f "$CO/sub/impl.txt" ]'
check "results: underscore artifacts excluded" '[ ! -e "$CO/_brief.txt" ] && [ ! -e "$CO/_glm_run.log" ] && [ ! -e "$CO/_judges" ]'
check "results: workspace .git never copied"   '[ ! -e "$CO/.git/config" ]'
check "results: orphan branch per label"       'grep -q "checkout -q --orphan candidate-1" "$GITLOG"'
check "results: NEUTRAL worker identity"       'grep -q "user.name=worker-candidate-1" "$GITLOG" && grep -q "user.email=worker@je" "$GITLOG"'
check "results: pushes the per-label branch"   'grep -q "push -qf origin candidate-1" "$GITLOG"'
check "results: never touches main"            '! grep -q "push -q origin main" "$GITLOG"'
rm -rf "$WS"

# ---- push_log: main + the validated push||pull-rebase retry loop --------------------------------
mk_ws; printf 'JOUST-RC 00 ok\n' > "$WS/run.log"
run_rr push_log run-1 candidate-2 "$WS/run.log"; RC=$?
CO="$WS/cache/run-1/log-candidate-2"
check "log: exits 0"                           '[ "$RC" -eq 0 ]'
check "log: committed as worktree-<label>-run-log" 'cmp -s "$WS/run.log" "$CO/worktree-candidate-2-run-log"'
check "log: neutral worker identity"           'grep -q "user.name=worker-candidate-2" "$GITLOG"'
check "log: pushes main"                       'grep -q "push -q origin main" "$GITLOG"'
rm -rf "$WS"

# Retry loop: 2 failed pushes -> pull --rebase between attempts -> succeeds on the 3rd.
mk_ws; printf 'log\n' > "$WS/run.log"
FAKE_PUSH_FAILS=2 run_rr push_log run-1 w1 "$WS/run.log"; RC=$?
check "retry: eventual success exits 0"        '[ "$RC" -eq 0 ]'
check "retry: exactly 3 push attempts"         '[ "$(grep -c "push -q origin main" "$GITLOG")" -eq 3 ]'
check "retry: pull --rebase between attempts"  '[ "$(grep -c "pull --rebase -q origin main" "$GITLOG")" -eq 2 ]'
rm -rf "$WS"

# Retry loop cap: pushes keep failing -> exactly 5 attempts, then a DISTINCT git failure (exit 5).
mk_ws; printf 'log\n' > "$WS/run.log"
FAKE_PUSH_FAILS=99 run_rr push_log run-1 w1 "$WS/run.log"; RC=$?
check "retry-cap: exits 5 after the loop"      '[ "$RC" -eq 5 ]'
check "retry-cap: exactly 5 push attempts"     '[ "$(grep -c "push -q origin main" "$GITLOG")" -eq 5 ]'
check "retry-cap: loud named failure"          'grep -q "push_log failed after 5" "$WS/err.txt"'
rm -rf "$WS"

# ---- publish: POST-RUN allowlist copy (engine internals never leave), engine identity -----------
mk_ws
mkdir -p "$WS/rundir/review-1/_judges" "$WS/rundir/_engine-logs"
printf '{"winner":"A"}\n' > "$WS/rundir/mapping.json"
printf 'summary\n' > "$WS/rundir/SUMMARY.md"
printf 'blind summary\n' > "$WS/rundir/SUMMARY.blind.md"
printf 'council\n' > "$WS/rundir/review-1/council.json"
printf 'verdict\n' > "$WS/rundir/review-1/verdict.md"
printf 'pool\n' > "$WS/rundir/review-1/_pool.md"
printf 'seat\n' > "$WS/rundir/review-1/_judges/seat.json"
printf 'timeline\n' > "$WS/rundir/timeline.jsonl"
run_rr publish run-1 "$WS/rundir"; RC=$?
CO="$WS/cache/run-1/publish"
check "publish: exits 0"                       '[ "$RC" -eq 0 ]'
check "publish: unmasking artifacts copied"    '[ -f "$CO/mapping.json" ] && [ -f "$CO/SUMMARY.md" ] && [ -f "$CO/SUMMARY.blind.md" ] && [ -f "$CO/timeline.jsonl" ]'
check "publish: council verdicts copied"       '[ -f "$CO/review-1/council.json" ] && [ -f "$CO/review-1/verdict.md" ]'
check "publish: engine internals stay local"   '[ ! -e "$CO/review-1/_pool.md" ] && [ ! -e "$CO/review-1/_judges" ] && [ ! -e "$CO/_engine-logs" ]'
check "publish: engine-neutral identity"       'grep -q "user.name=je-engine" "$GITLOG"'
check "publish: pushes main (retry-looped)"    'grep -q "push -q origin main" "$GITLOG"'
rm -rf "$WS"

# ---- pre-init push-to-create fallback: clone fails -> init -b main + remote add, still pushes ----
mk_ws; printf 'log\n' > "$WS/run.log"
FAKE_CLONE_RC=128 run_rr push_log run-1 w1 "$WS/run.log"; RC=$?
check "no-remote-repo: falls back to git init"  'grep -q " init -q -b main" "$GITLOG" || grep -q " init -q$" "$GITLOG"'
check "no-remote-repo: origin wired up"         'grep -q "remote add origin" "$GITLOG"'
check "no-remote-repo: still pushes (creates)"  '[ "$RC" -eq 0 ] && grep -q "push -q origin main" "$GITLOG"'
rm -rf "$WS"

# ---- public-repo hygiene: NO hostname/LAN literal in the committed script -----------------------
# The hostname token is assembled at runtime ("1""hut" — the #25 Z""AI hygiene pattern) so this
# test file itself never carries the literal either.
check "hygiene: no operator hostname literal"  '! grep -qi "1""hut" "$SCRIPT"'
check "hygiene: no LAN/IP literal"             '! grep -Eq "192\.168\.|10\.0\.|\.local[^a-zA-Z]" "$SCRIPT"'
check "hygiene: remote base only via env/arg"  'grep -q "JE_RUN_REMOTE_BASE" "$SCRIPT" && ! grep -Eq "^[^#]*git@[a-z0-9.-]+\." "$SCRIPT"'

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
