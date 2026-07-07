#!/usr/bin/env bash
# je-git.test.sh — tests for bin/je-git.sh run_verify hardening (issue #21).
#
# Covers the unattended verify-time RCE fix:
#   - diff-gate: refuse verify when the implementer's changes touch a file a
#     toolchain would EXECUTE (package.json / Makefile / conftest.py / …)
#   - secret-drop: provider keys are removed from the verify environment
#   - no live re-detection: empty frozen set -> rc 2, never re-scan a mutated tree
#   - argv execution: command lines run as argv (no `eval`), so `;`/`|`/`$()` are inert
#   - preserved contract: fail-FAST (break on first failure), all-pass rc 0
#   - off-mode gate: explicit config-touch refusals remain unchanged
#   - opt-in route: config-touch is accepted only onto the sandbox path
#   - fail-closed route: a missing wrapper never falls back to direct execution
#   - secret-drop still applies before the sandbox wrapper is entered
#   - AUTO default (section Z): sandbox-when-available, else unsandboxed + warn,
#     with the gate fail-closed when auto has no sandbox to route to
#
# Self-contained: builds throwaway git repos in mktemp dirs; no network, no toolchains.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLGIT="$HERE/je-git.sh"

# The verify sandbox now DEFAULTS to "auto" (sandbox when available). The issue-#21
# regression cases (A–H, T, …) assert the explicit OFF contract, so pin off-mode here;
# section Z exercises the auto default deterministically with a fake wrapper. Set
# inline overrides where a case needs strict (=1) or auto.
export JE_VERIFY_SANDBOX=0
unset JE_VERIFY_SANDBOX_WRAPPER

pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }
check(){ # check <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi
}

# mkrepo <dir> [files...] — init a git repo with an initial commit containing the
# given "path=content" files (content may be empty after '=').
mkrepo() {
  local dir="$1"; shift
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name  tester
  git -C "$dir" config commit.gpgsign false
  printf 'hello\n' > "$dir/README.md"
  local f name body
  for f in "$@"; do
    name="${f%%=*}"; body="${f#*=}"
    mkdir -p "$dir/$(dirname "$name")"
    printf '%s' "$body" > "$dir/$name"
  done
  git -C "$dir" add -A
  git -C "$dir" commit -q -m init --no-gpg-sign
}

# rv <repo> <stdin> — run `run_verify` in <repo> with <stdin> piped; echoes rc on
# the last line, full output captured to $RV_OUT.
RV_OUT=""
rv() {
  local repo="$1" input="$2" out rc
  out="$( cd "$repo" && printf '%s' "$input" | bash "$FLGIT" run_verify 2>&1 )"
  rc=$?
  RV_OUT="$out"
  return $rc
}

echo "== je-git.sh run_verify hardening (#21) =="

# ---------------------------------------------------------------------------
# A) diff-gate REFUSES when the implementer added a verify-executable file, and
#    runs NOTHING (the malicious command never executes).
# ---------------------------------------------------------------------------
A=$(mktemp -d); repo="$A/repo"; mkrepo "$repo"
# implementer "creates" package.json (untracked) — a verify-executable change
printf '{"scripts":{"build":"true"}}' > "$repo/package.json"
proof="$A/PROOF"; rm -f "$proof"
rv "$repo" "touch $proof"$'\n'; rc=$?
[ "$rc" -ne 0 ] && ok "A: refused (rc=$rc nonzero)" || bad "A: expected nonzero rc, got 0"
[ ! -e "$proof" ] && ok "A: malicious command did NOT run" || bad "A: command executed despite unsafe diff"
case "$RV_OUT" in *REFUSE-UNSAFE*package.json*) ok "A: names the offending file";; *) bad "A: missing refuse/package.json marker";; esac
rm -rf "$A"

# ---------------------------------------------------------------------------
# B) diff-gate ALLOWS when only a non-verify file changed; the command runs.
# ---------------------------------------------------------------------------
B=$(mktemp -d); repo="$B/repo"; mkrepo "$repo"
printf 'edited\n' >> "$repo/README.md"   # safe change only
ran="$B/RAN"; rm -f "$ran"
rv "$repo" "touch $ran"$'\n'; rc=$?
check "B: allowed (rc 0)" "$rc" "0"
[ -e "$ran" ] && ok "B: command ran on safe diff" || bad "B: command did not run on safe diff"
rm -rf "$B"

# ---------------------------------------------------------------------------
# C) secret-drop: provider keys are removed from the verify environment.
# ---------------------------------------------------------------------------
C=$(mktemp -d); repo="$C/repo"; mkrepo "$repo"
printf 'edited\n' >> "$repo/README.md"
leak="$C/leak.sh"; keyout="$C/KEYOUT"; rm -f "$keyout"
printf '#!/usr/bin/env bash\necho "${ZAI_API_KEY:-EMPTY}" > "$1"\n' > "$leak"
( cd "$repo" && printf '%s\n' "bash $leak $keyout" | ZAI_API_KEY=secret123 bash "$FLGIT" run_verify ) >/dev/null 2>&1
got="$(cat "$keyout" 2>/dev/null || echo MISSING)"
check "C: ZAI_API_KEY dropped from verify env" "$got" "EMPTY"
rm -rf "$C"

# ---------------------------------------------------------------------------
# C2) secret-drop covers XAI_API_KEY (Grok). Same shape as C; this is the key
#     that was previously NOT in the unset list, so a verify command could read
#     a live Grok token.
# ---------------------------------------------------------------------------
C2=$(mktemp -d); repo="$C2/repo"; mkrepo "$repo"
printf 'edited\n' >> "$repo/README.md"
leak="$C2/leak.sh"; keyout="$C2/KEYOUT"; rm -f "$keyout"
printf '#!/usr/bin/env bash\necho "${XAI_API_KEY:-EMPTY}" > "$1"\n' > "$leak"
( cd "$repo" && printf '%s\n' "bash $leak $keyout" | XAI_API_KEY=secret123 bash "$FLGIT" run_verify ) >/dev/null 2>&1
got="$(cat "$keyout" 2>/dev/null || echo MISSING)"
check "C2: XAI_API_KEY dropped from verify env" "$got" "EMPTY"
rm -rf "$C2"

# ---------------------------------------------------------------------------
# D) no live re-detection: empty frozen set -> rc 2, never scans the tree.
#    (committed package.json, clean tree -> gate passes; empty stdin -> rc 2.)
# ---------------------------------------------------------------------------
D=$(mktemp -d); repo="$D/repo"; mkrepo "$repo" 'package.json={"scripts":{"build":"true"}}'
rv "$repo" ""; rc=$?
check "D: empty stdin -> rc 2 (unverifiable)" "$rc" "2"
case "$RV_OUT" in *JE-VERIFY-RUN*) bad "D: re-detected and tried to run a command";; *) ok "D: did not re-detect/run";; esac
rm -rf "$D"

# ---------------------------------------------------------------------------
# G) argv execution: a `;`-chained second command is inert (no eval).
# ---------------------------------------------------------------------------
G=$(mktemp -d); repo="$G/repo"; mkrepo "$repo"
printf 'edited\n' >> "$repo/README.md"
inj="$G/INJECTED"; rm -f "$inj"
rv "$repo" "true; touch $inj"$'\n'
[ ! -e "$inj" ] && ok "G: ;-chained command did NOT execute (argv, not eval)" || bad "G: injected command executed (eval still in use)"
rm -rf "$G"

# ---------------------------------------------------------------------------
# E) fail-FAST preserved: first command fails -> stop, second never runs, rc 1.
# ---------------------------------------------------------------------------
E=$(mktemp -d); repo="$E/repo"; mkrepo "$repo"
printf 'edited\n' >> "$repo/README.md"
snr="$E/SHOULD_NOT_RUN"; rm -f "$snr"
rv "$repo" "false"$'\n'"touch $snr"$'\n'; rc=$?
check "E: failing command -> rc 1" "$rc" "1"
[ ! -e "$snr" ] && ok "E: fail-fast (second command skipped)" || bad "E: second command ran after a failure"
rm -rf "$E"

# ---------------------------------------------------------------------------
# F) all-pass preserved: every command succeeds -> rc 0.
# ---------------------------------------------------------------------------
F=$(mktemp -d); repo="$F/repo"; mkrepo "$repo"
printf 'edited\n' >> "$repo/README.md"
rv "$repo" "true"$'\n'"true"$'\n'; rc=$?
check "F: all-pass -> rc 0" "$rc" "0"
case "$RV_OUT" in *JE-VERIFY-ALL-PASS*) ok "F: reports all-pass";; *) bad "F: missing all-pass marker";; esac
rm -rf "$F"

# ---------------------------------------------------------------------------
# H) gate pattern coverage: each verify-executable file type trips the gate;
#    ordinary deliverables (incl. the implementer's own JE-NOTES.md) do not.
# ---------------------------------------------------------------------------
gate_trips() { # gate_trips <relpath> -> echoes "unsafe"/"safe"
  local rel="$1" d repo
  d=$(mktemp -d); repo="$d/repo"; mkrepo "$repo" >/dev/null 2>&1
  mkdir -p "$repo/$(dirname "$rel")"; printf 'x' > "$repo/$rel"   # untracked new file
  if ( cd "$repo" && bash "$FLGIT" verify_safe_diff >/dev/null 2>&1 ); then echo safe; else echo unsafe; fi
  rm -rf "$d"
}
# security-sweep H5 (2026-07-07): a verify command runs the WHOLE tree's code, so EXECUTABLE SOURCE
# (src/app.py, main.go, util.rs, *.js, …) and framework configs (jest/vite/webpack/gradle/…) are
# now correctly gated too — the old narrow allowlist let them through and they ran unsandboxed.
for u in package.json src/web/package.json Makefile makefile build.mk \
         pyproject.toml conftest.py pkg/conftest.py tests/test_login.py api_test.py \
         Cargo.toml build.rs go.mod .github/workflows/ci.yml \
         src/app.py main.go util.rs lib/index.js web/app.ts jest.config.js vite.config.ts \
         build.gradle pom.xml Rakefile Gemfile CMakeLists.txt noxfile.py; do
  check "H: gate trips on $u" "$(gate_trips "$u")" "unsafe"
done
# Only genuinely non-executable deliverables (docs/data) verify unsandboxed against the trusted tree.
for s in README.md JE-NOTES.md docs/notes.txt data/fixtures.json config.yaml notes.md; do
  check "H: gate allows $s" "$(gate_trips "$s")" "safe"
done

# ---------------------------------------------------------------------------
# S) P6 sandbox GATING/ROUTING. These tests use a fake pass-through wrapper to
#    prove argv routing only; they make NO claim about OS-level isolation.
#    Existing A/H above run with the flag unset and remain the no-regression
#    proof for issue #21's default fail-closed behavior.
# ---------------------------------------------------------------------------
S=$(mktemp -d); repo="$S/repo"; mkrepo "$repo"
printf '{"scripts":{"build":"true"}}' > "$repo/package.json"

# S1: exactly JE_VERIFY_SANDBOX=1 relaxes the config-touch refusal decision.
out="$( cd "$repo" && JE_VERIFY_SANDBOX=1 bash "$FLGIT" verify_safe_diff 2>&1 )"; rc=$?
check "S1: sandbox opt-in relaxes config-touch gate -> rc 0" "$rc" "0"
case "$out" in *JE-VERIFY-SANDBOX-ROUTE*package.json*) ok "S1: emits sandbox-route marker + offending file";; *) bad "S1: missing sandbox-route/package.json marker";; esac

# Fake wrapper contract: wrapper -- <argv...>. It records entry, then execs.
# This is intentionally NOT an isolation test.
wrapper="$S/fake-sandbox-wrapper"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf invoked > "${JE_TEST_WRAPPER_MARKER:?}"' \
  '[ "${1:-}" = "--" ] && shift' \
  'exec "$@"' > "$wrapper"
chmod +x "$wrapper"

# S2: run_verify routes a config-touching diff through the selected wrapper.
marker="$S/WRAPPER_INVOKED"; ran="$S/RAN"; rm -f "$marker" "$ran"
out="$( cd "$repo" && printf '%s\n' "touch $ran" | \
  JE_VERIFY_SANDBOX=1 JE_VERIFY_SANDBOX_WRAPPER="$wrapper" \
  JE_TEST_WRAPPER_MARKER="$marker" bash "$FLGIT" run_verify 2>&1 )"; rc=$?
check "S2: sandbox-routed config-touch verify -> rc 0" "$rc" "0"
[ -e "$marker" ] && ok "S2: sandbox wrapper invoked" || bad "S2: sandbox wrapper not invoked"
[ -e "$ran" ] && ok "S2: verify command ran through wrapper" || bad "S2: routed verify command did not run"
case "$out" in *JE-VERIFY-SANDBOX-ROUTE*) ok "S2: run_verify records relaxed gate decision";; *) bad "S2: run_verify missing sandbox-route marker";; esac

# S3: existing provider-secret drop occurs before entering the wrapper.
leak="$S/leak.sh"; keyout="$S/KEYOUT"; rm -f "$marker" "$keyout"
printf '#!/usr/bin/env bash\necho "${ZAI_API_KEY:-EMPTY}" > "$1"\n' > "$leak"
chmod +x "$leak"
( cd "$repo" && printf '%s\n' "bash $leak $keyout" | \
  JE_VERIFY_SANDBOX=1 JE_VERIFY_SANDBOX_WRAPPER="$wrapper" \
  JE_TEST_WRAPPER_MARKER="$marker" ZAI_API_KEY=secret123 \
  bash "$FLGIT" run_verify ) >/dev/null 2>&1; rc=$?
check "S3: sandbox-routed verify -> rc 0" "$rc" "0"
got="$(cat "$keyout" 2>/dev/null || echo MISSING)"
check "S3: ZAI_API_KEY dropped before sandbox wrapper" "$got" "EMPTY"
[ -e "$marker" ] && ok "S3: secret-drop assertion used sandbox route" || bad "S3: wrapper not invoked"

# S4: force unavailable-wrapper path by naming a nonexistent absolute path.
# Do not empty PATH: setup and code under test still need git/coreutils.
missing="$S/does-not-exist/sandbox-wrapper"; proof="$S/UNSANDBOXED"; rm -f "$proof"
out="$( cd "$repo" && printf '%s\n' "touch $proof" | \
  JE_VERIFY_SANDBOX=1 JE_VERIFY_SANDBOX_WRAPPER="$missing" \
  bash "$FLGIT" run_verify 2>&1 )"; rc=$?
[ "$rc" -ne 0 ] && ok "S4: unavailable wrapper -> nonzero ($rc)" || bad "S4: unavailable wrapper unexpectedly passed"
[ ! -e "$proof" ] && ok "S4: no unsandboxed fallback execution" || bad "S4: command ran unsandboxed after wrapper failure"
case "$out" in *JE-VERIFY-SANDBOX-UNAVAILABLE*fail-closed*) ok "S4: emits stable unavailable/fail-closed marker";; *) bad "S4: missing unavailable/fail-closed marker";; esac
rm -rf "$S"

# ---------------------------------------------------------------------------
# Z) AUTO default (sandbox-when-available). The default policy is now "auto":
#    route through the sandbox when one is available, else run unsandboxed WITH a
#    warning. Availability is decided with the SAME test the leaf uses, so a wrapper
#    that is set-but-missing makes auto DETERMINISTICALLY unavailable on every host
#    (no dependence on whether the host has sandbox-exec). The fake pass-through
#    wrapper makes "available" deterministic too. These prove ROUTING, not isolation.
# ---------------------------------------------------------------------------
Z=$(mktemp -d); repo="$Z/repo"; mkrepo "$repo"
printf '{"scripts":{"build":"true"}}' > "$repo/package.json"   # a verify-executable touch
zwrap="$Z/fake-sandbox-wrapper"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf invoked > "${JE_TEST_WRAPPER_MARKER:?}"' \
  '[ "${1:-}" = "--" ] && shift' \
  'exec "$@"' > "$zwrap"
chmod +x "$zwrap"
missing="$Z/nope/sandbox-wrapper"

# Z1: AUTO (env UNSET -> resolves to auto) WITH an available wrapper relaxes the
#     config-touch gate to the sandbox route — proves unset defaults to auto.
out="$( cd "$repo" && env -u JE_VERIFY_SANDBOX JE_VERIFY_SANDBOX_WRAPPER="$zwrap" bash "$FLGIT" verify_safe_diff 2>&1 )"; rc=$?
check "Z1: auto(unset)+available wrapper relaxes gate -> rc 0" "$rc" "0"
case "$out" in *JE-VERIFY-SANDBOX-ROUTE*package.json*) ok "Z1: auto routes the config-touch to the sandbox";; *) bad "Z1: missing sandbox-route marker under auto";; esac

# Z2: AUTO with NO sandbox available (wrapper set-but-missing) REFUSES the
#     config-touch (fail-closed, exactly like off) — there is no sandbox to route to.
out="$( cd "$repo" && JE_VERIFY_SANDBOX=auto JE_VERIFY_SANDBOX_WRAPPER="$missing" bash "$FLGIT" verify_safe_diff 2>&1 )"; rc=$?
[ "$rc" -ne 0 ] && ok "Z2: auto+no-sandbox refuses config-touch (rc=$rc)" || bad "Z2: auto+no-sandbox should refuse"
case "$out" in *JE-VERIFY-REFUSE-UNSAFE*package.json*) ok "Z2: auto+no-sandbox emits the fail-closed refusal";; *) bad "Z2: missing refuse marker";; esac

# Z3: AUTO + available wrapper ROUTES an actual verify command through the wrapper.
zrepo2="$Z/repo2"; mkrepo "$zrepo2"; printf 'edited\n' >> "$zrepo2/README.md"   # safe diff
marker="$Z/WRAP1"; ran="$Z/RAN1"; rm -f "$marker" "$ran"
out="$( cd "$zrepo2" && printf '%s\n' "touch $ran" | \
  JE_VERIFY_SANDBOX=auto JE_VERIFY_SANDBOX_WRAPPER="$zwrap" \
  JE_TEST_WRAPPER_MARKER="$marker" bash "$FLGIT" run_verify 2>&1 )"; rc=$?
check "Z3: auto+wrapper verify -> rc 0" "$rc" "0"
[ -e "$marker" ] && ok "Z3: auto routed the verify command through the wrapper" || bad "Z3: wrapper not invoked under auto"
[ -e "$ran" ] && ok "Z3: routed command actually ran" || bad "Z3: routed command did not run"
case "$out" in *JE-VERIFY-SANDBOX-WARN*) bad "Z3: warned despite a sandbox being available";; *) ok "Z3: no unsandboxed-warning when sandbox is available";; esac

# Z4: AUTO + NO sandbox + SAFE diff runs UNSANDBOXED but WARNS loudly.
zrepo3="$Z/repo3"; mkrepo "$zrepo3"; printf 'edited\n' >> "$zrepo3/README.md"
ran="$Z/RAN2"; rm -f "$ran"
out="$( cd "$zrepo3" && printf '%s\n' "touch $ran" | \
  JE_VERIFY_SANDBOX=auto JE_VERIFY_SANDBOX_WRAPPER="$missing" bash "$FLGIT" run_verify 2>&1 )"; rc=$?
check "Z4: auto+no-sandbox safe verify -> rc 0" "$rc" "0"
[ -e "$ran" ] && ok "Z4: ran unsandowed (auto fallback keeps non-sandbox hosts working)" || bad "Z4: command did not run under auto fallback"
case "$out" in *JE-VERIFY-SANDBOX-WARN*) ok "Z4: emits the unsandboxed warning";; *) bad "Z4: missing unsandboxed warning";; esac

# Z5: explicit OFF (=0) is silent — the deliberate opt-out must NOT warn.
ran="$Z/RAN3"; rm -f "$ran"
out="$( cd "$zrepo3" && printf '%s\n' "touch $ran" | JE_VERIFY_SANDBOX=0 bash "$FLGIT" run_verify 2>&1 )"; rc=$?
check "Z5: off-mode safe verify -> rc 0" "$rc" "0"
case "$out" in *JE-VERIFY-SANDBOX-WARN*) bad "Z5: off-mode wrongly warned";; *) ok "Z5: off-mode is silent (no warning)";; esac
rm -rf "$Z"

# ---------------------------------------------------------------------------
# T) je_run_with_timeout in isolation: real rc passthrough, timeout->124, and
#    NO leaked background process on the EARLY-COMPLETION path (fast command
#    under a large timeout — where a naive watchdog orphans its sleep).
# ---------------------------------------------------------------------------

# T1: a fast command returns its REAL rc (0). Small timeout so any residual
#     benign orphan is short-lived; watchdog torn down early.
( bash "$FLGIT" je_run_with_timeout 5 -- true ) >/dev/null 2>&1; rc=$?
check "T1: fast success -> real rc 0" "$rc" "0"

# T2: a fast NONZERO exit passes through unchanged (NOT normalised to 124).
( bash "$FLGIT" je_run_with_timeout 30 -- sh -c 'exit 7' ) >/dev/null 2>&1; rc=$?
check "T2: fast failure -> real rc 7 (not 124)" "$rc" "7"

# T3: a command that sleeps past a tiny timeout is killed and reported as 124.
( bash "$FLGIT" je_run_with_timeout 1 -- sleep 30 ) >/dev/null 2>&1; rc=$?
check "T3: overrun -> rc 124 (timed out)" "$rc" "124"

# security-sweep M22: a timed-out command's BACKGROUNDED CHILD must also be reaped (process-group
# kill), not left alive holding inherited creds / mutating files. Run a command that backgrounds a
# long unique sleep then itself sleeps past the timeout; after the timeout, that grandchild sleep
# must be GONE (the old single-pid kill left it running).
m22=97531
( bash "$FLGIT" je_run_with_timeout 1 -- sh -c "sleep $m22 & sleep 30" ) >/dev/null 2>&1
gchild=""
for _t in 1 2 3 4 5 6 7 8; do
  if ps -Ao args 2>/dev/null | grep -v grep | grep -q "sleep $m22"; then gchild="alive"; sleep 0.5; else gchild=""; break; fi
done
[ -z "$gchild" ] && ok "M22: timed-out command's backgrounded child was group-killed" || { bad "M22: backgrounded child ($m22) survived the timeout"; pkill -f "sleep $m22" 2>/dev/null; }

# T4: NO LEAK on the early-completion path. A reparented orphan is invisible to
#     `jobs -p`, so we scan the REAL process table for the watchdog's sleep.
#     Use a unique marker timeout value so we match THIS test's sleep only, then
#     run a SHORT NON-INSTANT command (sleep 0.2 — >=200ms guarantees the
#     watchdog's TERM trap is installed before teardown, so this is DETERMINISTIC,
#     no flake, while still exercising the real early-completion leak path).
#     Generous settle window so a loaded machine doesn't flake. NOTE: we scan only
#     for the UNIQUE marker `sleep 98765`, never the command's own `sleep 0.2`.
T4=$(mktemp -d)
marker=98765                                   # unique sleep duration -> greppable
# Run a short non-instant command under a (marker-second) timeout; the watchdog
# will `sleep 98765`. The command finishes first -> early-completion teardown.
( bash "$FLGIT" je_run_with_timeout "$marker" -- sleep 0.2 ) >/dev/null 2>&1
# Give any orphan a moment to show up, then look for a `sleep 98765` we own.
leak=""
for _try in 1 2 3 4 5 6 7 8 9 10; do
  # match the literal marker arg; exclude our own grep/ps pipeline.
  if ps -A -o pid=,args= 2>/dev/null | grep -E "sleep[[:space:]]+$marker([[:space:]]|$)" | grep -v grep >/dev/null 2>&1; then
    leak="present"
  else
    leak=""; break
  fi
  sleep 1
done
# Best-effort cleanup so a (buggy) leaked sleep doesn't linger past the test run.
ps -A -o pid=,args= 2>/dev/null | grep -E "sleep[[:space:]]+$marker([[:space:]]|$)" | grep -v grep \
  | awk '{print $1}' | while read -r p; do kill "$p" 2>/dev/null; done
rm -rf "$T4"
[ -z "$leak" ] && ok "T4: no leaked watchdog sleep after fast success (early-completion path)" \
               || bad "T4: watchdog 'sleep $marker' orphaned to init on the fast-success path"

# T5: integration — run_verify still PASSES a quick command set unchanged.
T5=$(mktemp -d); repo="$T5/repo"; mkrepo "$repo"
printf 'edited\n' >> "$repo/README.md"            # safe diff -> gate allows
out="$( cd "$repo" && printf 'true\ntrue\n' | JE_VERIFY_CMD_TIMEOUT=30 bash "$FLGIT" run_verify 2>&1 )"; rc=$?
check "T5: run_verify quick set -> rc 0" "$rc" "0"
case "$out" in *JE-VERIFY-ALL-PASS*) ok "T5: reports all-pass";; *) bad "T5: missing all-pass marker";; esac
rm -rf "$T5"

# T6: integration — a hung command past a tiny timeout makes run_verify FAIL
#     (nonzero), AND fail-fast survives the wrapper: the next command does NOT run.
T6=$(mktemp -d); repo="$T6/repo"; mkrepo "$repo"
printf 'edited\n' >> "$repo/README.md"
snr="$T6/SHOULD_NOT_RUN"; rm -f "$snr"
out="$( cd "$repo" && printf '%s\n' "sleep 30" "touch $snr" | JE_VERIFY_CMD_TIMEOUT=1 bash "$FLGIT" run_verify 2>&1 )"; rc=$?
[ "$rc" -ne 0 ] && ok "T6: hung command -> run_verify rc nonzero ($rc)" || bad "T6: hung command did not fail run_verify"
[ ! -e "$snr" ] && ok "T6: fail-fast survives wrapper (command after the timeout did NOT run)" \
               || bad "T6: command after a timed-out command still ran (fail-fast broken)"
rm -rf "$T6"

# ---------------------------------------------------------------------------
# V) detect_verify [<dir>]: detect against an explicit target tree (the winner's
#    worktree, plan §9.2). Hermetic: only package.json + Makefile are exercised
#    (toolchain-FREE in detect_verify); pytest/ruff/cargo/go are command-v-gated
#    and intentionally not asserted (host-dependent).
#
#    dv <dir-arg...> -> runs `detect_verify <dir-arg...>` from a NEUTRAL cwd
#    (an empty dir with NO config files), so the only signal is the arg. Captures
#    stdout to $DV_OUT (stderr discarded so incidental output can't taint the
#    load-bearing equality), echoes rc.
# ---------------------------------------------------------------------------
DV_OUT=""
NEUTRAL="$(mktemp -d)"   # an empty dir: no package.json/Makefile/etc. anywhere
dv() {
  local out rc
  out="$( cd "$NEUTRAL" && bash "$FLGIT" detect_verify "$@" 2>/dev/null )"
  rc=$?
  DV_OUT="$out"
  return $rc
}

# A target tree with a multi-config fixture: package.json (build+test scripts)
# and a Makefile (test + check targets). No toolchain needed for either.
VT="$(mktemp -d)"
printf '{"scripts":{"build":"true","test":"true"}}\n' > "$VT/package.json"
printf 'test:\n\ttrue\ncheck:\n\ttrue\n'              > "$VT/Makefile"

# V1: detect against the target dir finds that dir's package.json + Makefile.
dv "$VT"; rc=$?
check "V1: target dir detected -> rc 0" "$rc" "0"
case "$DV_OUT" in *"npm run build --if-present"*) ok "V1: emits npm build for target";; *) bad "V1: missing npm build";; esac
case "$DV_OUT" in *"npm run test --if-present"*)  ok "V1: emits npm test for target";;  *) bad "V1: missing npm test";;  esac
case "$DV_OUT" in *"make test"*)  ok "V1: emits make test for target";;  *) bad "V1: missing make test";;  esac
case "$DV_OUT" in *"make check"*) ok "V1: emits make check for target";; *) bad "V1: missing make check";; esac

# V2: a target dir with NOTHING -> rc nonzero AND empty output (the §9.2
#     "could not verify -> draft needs-human" path).
EMPTY="$(mktemp -d)"
dv "$EMPTY"; rc=$?
[ "$rc" -ne 0 ] && ok "V2: empty target -> rc nonzero ($rc)" || bad "V2: empty target should be nonzero"
[ -z "$DV_OUT" ] && ok "V2: empty target -> no commands printed" || bad "V2: empty target printed '$DV_OUT'"

# V3: BACKWARD-COMPAT, proven OBSERVABLY (not asserted). On a multi-config tree,
#     the no-arg form (cwd-relative) must produce BYTE-IDENTICAL output+rc to the
#     explicit '.' form AND to the absolute-dir form. Run all three over the SAME
#     fixture and compare. (A bare relative '.' default that diverges from the
#     absolute path is exactly the partial-redirect bug this catches.)
noarg="$( cd "$VT" && bash "$FLGIT" detect_verify         2>/dev/null )"; rc_n=$?
dotarg="$( cd "$VT" && bash "$FLGIT" detect_verify .       2>/dev/null )"; rc_d=$?
absarg="$( cd "$NEUTRAL" && bash "$FLGIT" detect_verify "$VT" 2>/dev/null )"; rc_a=$?
check "V3: no-arg rc == '.'-arg rc"        "$rc_n" "$rc_d"
check "V3: no-arg rc == abs-dir-arg rc"    "$rc_n" "$rc_a"
[ "$noarg" = "$dotarg" ] && ok "V3: no-arg output == '.'-arg output (byte-identical)" \
                         || bad "V3: no-arg output diverged from '.'-arg output"
[ "$noarg" = "$absarg" ] && ok "V3: no-arg output == abs-dir-arg output (byte-identical)" \
                         || bad "V3: no-arg output diverged from abs-dir-arg output"

# V4: COMPETING-SIGNALS guard. Put DIFFERENT configs in the cwd AND in the
#     target, then detect with the target arg from inside the cwd: detection must
#     follow the TARGET, never the cwd. A target-only/empty-cwd fixture cannot
#     catch a partial-redirect bug (where one probe still reads the cwd); this
#     one does. cwd has ONLY a Makefile(test:); target has ONLY package.json(lint).
CWDONLY="$(mktemp -d)"; printf 'test:\n\ttrue\n'                 > "$CWDONLY/Makefile"
TGTONLY="$(mktemp -d)"; printf '{"scripts":{"lint":"true"}}\n'  > "$TGTONLY/package.json"
comp="$( cd "$CWDONLY" && bash "$FLGIT" detect_verify "$TGTONLY" 2>/dev/null )"; rc_c=$?
check "V4: competing-signals detect -> rc 0" "$rc_c" "0"
case "$comp" in *"npm run lint --if-present"*) ok "V4: followed TARGET (npm lint present)";;       *) bad "V4: did NOT detect target's package.json";; esac
case "$comp" in *"make test"*) bad "V4: LEAKED cwd signal (saw cwd Makefile 'make test')";;        *) ok "V4: did NOT leak cwd Makefile";; esac

rm -rf "$NEUTRAL" "$VT" "$EMPTY" "$CWDONLY" "$TGTONLY"

# ---------------------------------------------------------------------------
# W) adopt_winner_branch (plan §7/§11): a PURE REF ALIAS of the winner's exact
#    gated commit -> JE- branch (NO new commit, NO re-author), then push -u to a
#    LOCAL BARE remote wired as origin (so push + upstream tracking run offline).
#
#    mkadopt <root> -> sets up:
#      <root>/origin.git  bare repo (the remote)
#      <root>/repo        work repo cloned-style: origin remote + base upstream set
#      <root>/repo's BASE branch name captured in the global BASE (portable: may be
#      'master' on some sandboxes, so we never hard-code 'main').
#    Echoes nothing; sets globals: ADOPT_REPO, BASE.
# ---------------------------------------------------------------------------
ADOPT_REPO=""; BASE=""
mkadopt() {
  local root="$1"
  ADOPT_REPO="$root/repo"
  mkrepo "$ADOPT_REPO"                                   # initial commit on the default branch
  BASE="$(git -C "$ADOPT_REPO" symbolic-ref --short HEAD)"   # 'main' or 'master' — capture it
  git init -q --bare "$root/origin.git"
  git -C "$ADOPT_REPO" remote add origin "$root/origin.git"
  git -C "$ADOPT_REPO" push -q -u origin "$BASE"         # base now has origin/$BASE upstream
}

# mkwinner <repo> <branch> [extra] — create a winner worktree branch off BASE.
# With [extra]='ahead', add ONE commit so the winner is one commit ahead of base.
# Uses a separate worktree dir so we never disturb the work repo's HEAD.
mkwinner() {
  local repo="$1" wbranch="$2" extra="${3:-}"
  local wt="$repo/../wt-$wbranch"
  git -C "$repo" worktree add -q -b "$wbranch" "$wt" "$BASE"
  if [ "$extra" = "ahead" ]; then
    printf 'winner change\n' > "$wt/WINNER.txt"
    git -C "$wt" add -A
    git -C "$wt" commit -q -m "winner work" --no-gpg-sign
  fi
}

echo "== je-git.sh adopt_winner_branch (P2 §7/§11) =="

# W1: HAPPY PATH — winner one commit AHEAD of base. adopt aliases the JE- branch
#     to the winner's EXACT sha (no new commit), pushes -u, and the remote has it.
W1=$(mktemp -d); mkadopt "$W1"
mkwinner "$ADOPT_REPO" "jewt/run/round-1/candidate-1" ahead
win_sha="$(git -C "$ADOPT_REPO" rev-parse jewt/run/round-1/candidate-1)"
base_sha="$(git -C "$ADOPT_REPO" rev-parse "$BASE")"
[ "$win_sha" != "$base_sha" ] && ok "W1: winner is one commit ahead of base (precondition)" \
                              || bad "W1: winner sha unexpectedly equals base sha"
out="$( cd "$ADOPT_REPO" && bash "$FLGIT" adopt_winner_branch "JE-1-aaaaaa1" "$BASE" "jewt/run/round-1/candidate-1" 2>&1 )"; rc=$?
check "W1: adopt -> rc 0" "$rc" "0"
je_sha="$(git -C "$ADOPT_REPO" rev-parse JE-1-aaaaaa1 2>/dev/null || echo MISSING)"
# THE INVARIANT: JE- branch sha == winner sha (pure alias, no new commit).
check "W1: JE- branch == winner EXACT sha (no new commit)" "$je_sha" "$win_sha"
# Commit count on the JE- branch equals the winner's (alias added no commit).
je_n="$(git -C "$ADOPT_REPO" rev-list --count JE-1-aaaaaa1)"
win_n="$(git -C "$ADOPT_REPO" rev-list --count jewt/run/round-1/candidate-1)"
check "W1: JE- branch commit count == winner's (no extra commit)" "$je_n" "$win_n"
# push -u happened: the remote bare repo now has the JE- branch at the same sha.
remote_sha="$(git -C "$W1/origin.git" rev-parse JE-1-aaaaaa1 2>/dev/null || echo MISSING)"
check "W1: remote received pushed JE- branch at winner sha" "$remote_sha" "$win_sha"
# upstream tracking set by push -u.
up="$(git -C "$ADOPT_REPO" rev-parse --abbrev-ref --symbolic-full-name 'JE-1-aaaaaa1@{upstream}' 2>/dev/null || echo NONE)"
check "W1: push -u set upstream to origin/JE-1-aaaaaa1" "$up" "origin/JE-1-aaaaaa1"
case "$out" in *JE-ADOPT-PUSH-OK*) ok "W1: emits JE-ADOPT-PUSH-OK";; *) bad "W1: missing JE-ADOPT-PUSH-OK marker";; esac
rm -rf "$W1"

# W2: REFUSE a non-JE- branch name (mirrors commit_and_push's prefix guard), and
#     prove it created NOTHING (fail-closed) — no branch, nothing pushed.
W2=$(mktemp -d); mkadopt "$W2"
mkwinner "$ADOPT_REPO" "jewt/run/round-1/candidate-1" ahead
out="$( cd "$ADOPT_REPO" && bash "$FLGIT" adopt_winner_branch "notje-1-x" "$BASE" "jewt/run/round-1/candidate-1" 2>&1 )"; rc=$?
[ "$rc" -ne 0 ] && ok "W2: non-JE- name -> rc nonzero ($rc)" || bad "W2: expected nonzero rc for non-JE- name"
case "$out" in *JE-ADOPT-REFUSE*not\ an\ JE-\ branch*) ok "W2: names the JE- prefix refusal";; *) bad "W2: missing JE- prefix refuse marker";; esac
if git -C "$ADOPT_REPO" rev-parse --verify --quiet "refs/heads/notje-1-x" >/dev/null 2>&1; then
  bad "W2: refused name was created anyway (not fail-closed)"
else
  ok "W2: refused -> no branch created (fail-closed)"
fi
rm -rf "$W2"

# W3: winner branch EVEN WITH base (zero commits ahead) still aliases correctly to
#     the EXACT (base) sha — the alias is sha-faithful regardless of distance.
W3=$(mktemp -d); mkadopt "$W3"
mkwinner "$ADOPT_REPO" "jewt/run/round-1/candidate-2"        # no 'ahead' -> sits at base sha
win_sha="$(git -C "$ADOPT_REPO" rev-parse jewt/run/round-1/candidate-2)"
out="$( cd "$ADOPT_REPO" && bash "$FLGIT" adopt_winner_branch "JE-2-bbbbbb2" "$BASE" "jewt/run/round-1/candidate-2" 2>&1 )"; rc=$?
check "W3: adopt (winner at base) -> rc 0" "$rc" "0"
je_sha="$(git -C "$ADOPT_REPO" rev-parse JE-2-bbbbbb2 2>/dev/null || echo MISSING)"
check "W3: JE- branch == winner EXACT sha" "$je_sha" "$win_sha"
rm -rf "$W3"

# W4: REFUSE when the winner branch does not resolve (fail-closed; no JE- branch).
W4=$(mktemp -d); mkadopt "$W4"
out="$( cd "$ADOPT_REPO" && bash "$FLGIT" adopt_winner_branch "JE-3-cccccc3" "$BASE" "jewt/run/round-1/does-not-exist" 2>&1 )"; rc=$?
[ "$rc" -ne 0 ] && ok "W4: missing winner branch -> rc nonzero ($rc)" || bad "W4: expected nonzero rc for missing winner"
if git -C "$ADOPT_REPO" rev-parse --verify --quiet "refs/heads/JE-3-cccccc3" >/dev/null 2>&1; then
  bad "W4: JE- branch created despite missing winner (not fail-closed)"
else
  ok "W4: no JE- branch created for missing winner (fail-closed)"
fi
rm -rf "$W4"

# ---------------------------------------------------------------------------
# X) #46 regression: je_run_with_timeout invoked inside command substitution $(...)
#    must NOT block on an orphaned watchdog `sleep`. Pre-fix, the residual
#    instant-command race orphaned the watchdog's `sleep`, which (inheriting fd 1)
#    held the $() capture pipe open for the FULL timeout (~10s/call).
#
#    A fixed wall-time budget is flaky on loaded CI (process-spawn overhead varies),
#    so measure DIFFERENTIALLY against the bug's own mechanism. The same 30 instant
#    calls with output REDIRECTED (>/dev/null — no capture pipe an orphan can hold,
#    so this path is immune to the bug) establish this runner's spawn-overhead
#    baseline; the $()-captured batch then must not run a FULL timeout longer. With
#    the fix the two are ~equal; a held pipe adds >= one whole timeout. Subtracting
#    the baseline makes the check robust to a slow runner — both batches scale together.
XTO=10
xb_s=$(date +%s)
for xi in $(seq 1 30); do bash "$FLGIT" je_run_with_timeout "$XTO" -- true >/dev/null 2>&1; done
xbase=$(( $(date +%s) - xb_s ))
xc_s=$(date +%s)
for xi in $(seq 1 30); do xout="$( bash "$FLGIT" je_run_with_timeout "$XTO" -- true 2>/dev/null )"; done
xcap=$(( $(date +%s) - xc_s ))
xextra=$(( xcap - xbase ))
[ "$xextra" -lt "$XTO" ] \
  && ok "X: \$()-captured je_run_with_timeout adds no full-timeout stall vs baseline (base ${xbase}s, captured ${xcap}s)" \
  || bad "X: \$()-captured je_run_with_timeout blocked on an orphaned watchdog sleep (captured ${xcap}s vs baseline ${xbase}s; +${xextra}s >= one ${XTO}s timeout => a sleep held the pipe)"

# ---------------------------------------------------------------------------
# Y) je_cleanup (disk reclaim): DRY-RUN by default, --apply to actually delete.
#    Reclaims ONLY JE-owned artifacts: jewt/* worktrees, MERGED JE-* branches,
#    and .runs/<run-id> dirs. NEVER unmerged work, the main checkout, non-JE refs.
#
#    Reuses mkadopt/mkwinner (above): they set ADOPT_REPO + BASE and give us a
#    jewt/* worktree branch we can also use as a stand-in JE- branch.
# ---------------------------------------------------------------------------
echo "== je-git.sh je_cleanup (disk reclaim, dry-run default) =="

# cleanup_setup <root> -> builds a repo with:
#   - one jewt/* worktree (mergeable into base, i.e. at base sha)
#   - one JE- branch MERGED into base  (JE-merged)
#   - one JE- branch NOT merged (one commit ahead) (JE-unmerged)
#   - a .runs/<id> dir with a junk file (so it has nonzero bytes)
# Sets globals: ADOPT_REPO, BASE, RUNS_DIR (the .runs dir), RUN_ID.
RUNS_DIR=""; RUN_ID=""
cleanup_setup() {
  local root="$1"
  mkadopt "$root"                                   # ADOPT_REPO + BASE, origin wired
  # jewt/* worktree at base (mergeable / safe to remove).
  mkwinner "$ADOPT_REPO" "jewt/run/round-1/candidate-1"
  # A MERGED JE- branch: create at base sha (0 commits ahead == merged).
  git -C "$ADOPT_REPO" branch "JE-9-merged00" "$BASE"
  # An UNMERGED JE- branch: one commit ahead of base on its own worktree.
  mkwinner "$ADOPT_REPO" "JE-9-unmerge1" ahead
  # A .runs/<id> dir with content.
  RUNS_DIR="$ADOPT_REPO/.runs"; RUN_ID="gl-deadbeef-20990101-000000"
  mkdir -p "$RUNS_DIR/$RUN_ID/loop-1"
  printf 'scratch artifact bytes\n' > "$RUNS_DIR/$RUN_ID/loop-1/junk.txt"
}

# Y1: DRY-RUN (default) LISTS candidates + bytes but DELETES NOTHING.
Y1=$(mktemp -d); cleanup_setup "$Y1"
out="$( cd "$ADOPT_REPO" && bash "$FLGIT" je_cleanup "$BASE" "$RUNS_DIR" 2>&1 )"; rc=$?
check "Y1: dry-run -> rc 0" "$rc" "0"
case "$out" in *JE-CLEANUP-DRYRUN*) ok "Y1: announces dry-run mode";; *) bad "Y1: missing dry-run marker";; esac
case "$out" in *jewt/run/round-1/candidate-1*) ok "Y1: lists the jewt worktree";; *) bad "Y1: did not list jewt worktree";; esac
case "$out" in *JE-9-merged00*) ok "Y1: lists the merged JE- branch";; *) bad "Y1: did not list merged JE- branch";; esac
case "$out" in *"$RUN_ID"*) ok "Y1: lists the .runs/<id> dir";; *) bad "Y1: did not list .runs dir";; esac
# The unmerged JE- branch must surface ONLY as kept, NEVER in the merged-delete list.
case "$out" in *UNMERGED*JE-9-unmerge1*) ok "Y1: unmerged JE- branch surfaced as kept";; *) bad "Y1: unmerged JE- branch not reported as kept";; esac
case "$out" in *"[branch merged] JE-9-unmerge1"*) bad "Y1: unmerged branch wrongly listed for deletion";; *) ok "Y1: unmerged JE- branch NOT in the merged-delete list";; esac
# Nothing deleted: every artifact still present after dry-run.
git -C "$ADOPT_REPO" rev-parse --verify --quiet refs/heads/JE-9-merged00 >/dev/null 2>&1 && ok "Y1: merged branch NOT deleted (dry-run)" || bad "Y1: merged branch deleted in dry-run"
[ -d "$RUNS_DIR/$RUN_ID" ] && ok "Y1: .runs dir NOT deleted (dry-run)" || bad "Y1: .runs dir deleted in dry-run"
git -C "$ADOPT_REPO" worktree list 2>/dev/null | grep -q "candidate-1" && ok "Y1: worktree NOT removed (dry-run)" || bad "Y1: worktree removed in dry-run"
# bytes are reported.
case "$out" in *bytes*) ok "Y1: reports a byte total";; *) bad "Y1: no byte total reported";; esac
rm -rf "$Y1"

# Y2: --apply REMOVES a MERGED JE- branch + its jewt worktree, and the .runs dir.
Y2=$(mktemp -d); cleanup_setup "$Y2"
out="$( cd "$ADOPT_REPO" && bash "$FLGIT" je_cleanup --apply "$BASE" "$RUNS_DIR" 2>&1 )"; rc=$?
check "Y2: --apply -> rc 0" "$rc" "0"
case "$out" in *JE-CLEANUP-APPLY*) ok "Y2: announces apply mode";; *) bad "Y2: missing apply marker";; esac
if git -C "$ADOPT_REPO" rev-parse --verify --quiet refs/heads/JE-9-merged00 >/dev/null 2>&1; then
  bad "Y2: merged JE- branch still present after --apply"
else
  ok "Y2: merged JE- branch deleted under --apply"
fi
if git -C "$ADOPT_REPO" worktree list 2>/dev/null | grep -q "candidate-1"; then
  bad "Y2: jewt worktree still present after --apply"
else
  ok "Y2: jewt worktree removed under --apply"
fi
[ ! -d "$RUNS_DIR/$RUN_ID" ] && ok "Y2: .runs/<id> dir removed under --apply" || bad "Y2: .runs dir still present after --apply"

# Y3: --apply REFUSES the UNMERGED JE- branch (never -D / force-deletes work).
if git -C "$ADOPT_REPO" rev-parse --verify --quiet refs/heads/JE-9-unmerge1 >/dev/null 2>&1; then
  ok "Y3: unmerged JE- branch PRESERVED under --apply (refused)"
else
  bad "Y3: unmerged JE- branch was deleted (DATA LOSS — must refuse)"
fi
case "$out" in *JE-9-unmerge1*) ok "Y3: reports it skipped the unmerged branch";; *) ok "Y3: silently skipped unmerged branch";; esac
rm -rf "$Y2"

# Y4: SAFETY — je_cleanup NEVER touches a non-JE branch nor the base branch.
Y4=$(mktemp -d); cleanup_setup "$Y4"
git -C "$ADOPT_REPO" branch "feature/keepme" "$BASE"     # a non-JE local branch
( cd "$ADOPT_REPO" && bash "$FLGIT" je_cleanup --apply "$BASE" "$RUNS_DIR" ) >/dev/null 2>&1
git -C "$ADOPT_REPO" rev-parse --verify --quiet "refs/heads/$BASE" >/dev/null 2>&1 && ok "Y4: base branch preserved" || bad "Y4: base branch deleted (CATASTROPHIC)"
git -C "$ADOPT_REPO" rev-parse --verify --quiet refs/heads/feature/keepme >/dev/null 2>&1 && ok "Y4: non-JE branch preserved" || bad "Y4: non-JE branch deleted"
[ -f "$ADOPT_REPO/README.md" ] && ok "Y4: main checkout files untouched" || bad "Y4: main checkout damaged"
rm -rf "$Y4"

# Y5: BLAST-RADIUS guard (review-critical). A runsDir whose basename != ".runs" is
#     REFUSED — its subdirs are NEVER deleted (guards the repo-root / '/' / $HOME typo).
#     And a SYMLINKED child under a real .runs/ is skipped (never followed out of tree).
#     Run from a NON-git temp dir so worktree/branch reclaim is inert and only step 3 runs.
Y5=$(mktemp -d)
# (a) a non-".runs" dir shaped like a source tree -> must be refused, subdirs kept.
notruns="$Y5/srcroot"; mkdir -p "$notruns/bin" "$notruns/workflows"
out="$( cd "$notruns" && bash "$FLGIT" je_cleanup --apply main "$notruns" 2>&1 )"; rc=$?
check "Y5a: non-.runs runsDir -> rc 0 (fail-soft)" "$rc" "0"
case "$out" in *JE-CLEANUP-REFUSE*) ok "Y5a: refuses a non-.runs runsDir";; *) bad "Y5a: did not refuse non-.runs runsDir";; esac
[ -d "$notruns/bin" ] && [ -d "$notruns/workflows" ] && ok "Y5a: non-.runs subdirs PRESERVED (no blast)" || bad "Y5a: DELETED subdirs of a non-.runs runsDir (BLAST RADIUS)"
# (b) symlinked child under a real .runs/ -> skipped; target + real run-id dir handled.
realruns="$Y5/.runs"; victim="$Y5/victim"; mkdir -p "$realruns/gl-real-20990101-000000" "$victim"
printf 'precious\n' > "$victim/precious.txt"
ln -s "$victim" "$realruns/evillink"
out="$( cd "$Y5" && bash "$FLGIT" je_cleanup --apply main "$realruns" 2>&1 )"; rc=$?
check "Y5b: real .runs runsDir -> rc 0" "$rc" "0"
case "$out" in *"SKIPPED — symlink"*) ok "Y5b: reports the symlinked child as skipped";; *) bad "Y5b: did not skip symlinked .runs child";; esac
[ -f "$victim/precious.txt" ] && ok "Y5b: symlink target PRESERVED (no escape)" || bad "Y5b: followed symlink and deleted target (ESCAPE)"
[ -L "$realruns/evillink" ] && ok "Y5b: symlink child left intact (not reclaimed)" || bad "Y5b: removed the symlink child"
[ ! -d "$realruns/gl-real-20990101-000000" ] && ok "Y5b: real run-id dir under .runs IS reclaimed" || bad "Y5b: real run-id dir not reclaimed"
rm -rf "$Y5"

# Y6: a MERGED JE- branch that is the CURRENTLY-CHECKED-OUT HEAD is kept, and the WARN
#     surfaces git's REAL reason (checked-out), not a misleading "(not merged?)".
Y6=$(mktemp -d); mkadopt "$Y6"
git -C "$ADOPT_REPO" branch "JE-9-current0" "$BASE"
git -C "$ADOPT_REPO" checkout -q "JE-9-current0"     # HEAD now on the merged JE- branch
out="$( cd "$ADOPT_REPO" && bash "$FLGIT" je_cleanup --apply "$BASE" "$ADOPT_REPO/.runs" 2>&1 )"; rc=$?
check "Y6: --apply with HEAD on merged JE- -> rc 0" "$rc" "0"
git -C "$ADOPT_REPO" rev-parse --verify --quiet refs/heads/JE-9-current0 >/dev/null 2>&1 && ok "Y6: checked-out merged JE- branch KEPT (git protects it)" || bad "Y6: deleted the checked-out branch"
case "$out" in *"(not merged?)"*) bad "Y6: still prints misleading '(not merged?)'";; *) ok "Y6: no misleading '(not merged?)' message";; esac
case "$out" in *"git refused:"*) ok "Y6: surfaces git's real refusal reason";; *) bad "Y6: did not surface git's reason";; esac
rm -rf "$Y6"

# Y7: Fix #4 — on a DETACHED HEAD with no explicit base, base defaults to EMPTY (not the
#     literal "HEAD"), so the branch self-guard is intact and the branch section is skipped.
#     Dry-run proves it (announce shows base='') without deleting anything.
Y7=$(mktemp -d); mkadopt "$Y7"
git -C "$ADOPT_REPO" branch "JE-9-detach00" "$BASE"
git -C "$ADOPT_REPO" checkout -q --detach "$BASE"    # detached HEAD at base sha
out="$( cd "$ADOPT_REPO" && bash "$FLGIT" je_cleanup 2>&1 )"; rc=$?   # NO base/runsDir args
check "Y7: dry-run on detached HEAD -> rc 0" "$rc" "0"
case "$out" in *"base=''"*) ok "Y7: detached HEAD defaults base to EMPTY (not literal HEAD)";; *) bad "Y7: detached HEAD did not yield empty base";; esac
case "$out" in *"[branch merged] JE-9-detach00"*) bad "Y7: branch section ran under detached HEAD (self-guard defeated)";; *) ok "Y7: branch section skipped under detached HEAD";; esac
git -C "$ADOPT_REPO" rev-parse --verify --quiet refs/heads/JE-9-detach00 >/dev/null 2>&1 && ok "Y7: JE- branch at detached commit preserved" || bad "Y7: JE- branch missing"
rm -rf "$Y7"

# Y8: Fix #5 — under --apply the jewt/* BRANCH ref is removed too (not just the worktree),
#     so stale attempt branches don't accumulate across grand loops.
Y8=$(mktemp -d); cleanup_setup "$Y8"
( cd "$ADOPT_REPO" && bash "$FLGIT" je_cleanup --apply "$BASE" "$RUNS_DIR" ) >/dev/null 2>&1
if git -C "$ADOPT_REPO" rev-parse --verify --quiet "refs/heads/jewt/run/round-1/candidate-1" >/dev/null 2>&1; then
  bad "Y8: jewt/* branch ref left behind after --apply (leak)"
else
  ok "Y8: jewt/* branch ref removed under --apply"
fi
rm -rf "$Y8"

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
