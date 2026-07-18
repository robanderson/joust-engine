#!/usr/bin/env bash
# je-run-repo.sh — Joust Engine RUN-REPO helper: the git "results bus" (tracker #21, phase 2).
#
# One per-run repository, je-run-<runId>, created via PUSH-TO-CREATE on a git host the operator
# controls. During a run, WORKERS push their deliverables to per-worker orphan branches under a
# NEUTRAL identity (`worker-<label> <worker@je>` — no provider/model identity ever reaches the
# bus mid-run, preserving judge blindness) and their runner logs to main. The measured economics
# (tracker #21 bench): a worker clone+orphan-branch+commit+push of a 50KB deliverable ≈ 1s, vs
# 225s + corruption risk for a model-relay persist of the same bytes.
#
# UNMASKING SEQUENCING RULE (the one hard ordering constraint): `publish` — the only subcommand
# allowed to push identity-revealing artifacts (mapping.json, SUMMARY*.md, council verdicts) —
# must be invoked STRICTLY AFTER the run's terminal persist, never mid-run. Any earlier push
# would let a still-running blind seat read candidate→model identities off the bus. init /
# push_results / push_log are mid-run-safe by construction: nothing they push is unmasking.
#
# Deliberately LEAN (claudex-judge.sh's discipline — sources nothing heavy, not _je-run-lib.sh):
# every subcommand is one short synchronous git conversation. NO hostname is ever hardcoded here
# (public repo): the remote base comes ONLY from $JE_RUN_REMOTE_BASE (e.g. an scp-style
# 'git@<your-git-host>:<org>') or init's optional positional argument. NO secret and NO remote
# URL is ever echoed — an https base may embed credentials, so messages name only the repo
# (je-run-<runId>); git network stderr is suppressed for the same reason.
#
# Usage:
#   je-run-repo.sh init <runId> [<remote-base>]        seed the run repo (README + run metadata)
#                                                      on main via push-to-create
#   je-run-repo.sh push_results <runId> <label> <workspace-dir>
#                                                      copy the workspace's deliverable files
#                                                      (underscore-prefixed engine artifacts and
#                                                      .git excluded) onto orphan branch <label>,
#                                                      commit as worker-<label> <worker@je>, push.
#                                                      Parallel-safe: per-label branch + per-label
#                                                      local checkout = no contention anywhere.
#   je-run-repo.sh push_log <runId> <label> <log-file> commit the log as worktree-<label>-run-log
#                                                      on main; concurrent main pushes resolve via
#                                                      the VALIDATED retry loop (up to 5 attempts
#                                                      of push || pull --rebase)
#   je-run-repo.sh publish <runId> <runDir>            POST-RUN ONLY (see sequencing rule above):
#                                                      push the final artifacts to main
#
# Env:
#   JE_RUN_REMOTE_BASE   remote base for push-to-create (REQUIRED unless init got one positionally).
#                        ABSENT => exit 7: "run-repo disabled" — callers treat the feature as OFF.
#   JE_RUN_REPO_CACHE    local checkout cache root (default ${TMPDIR:-/tmp}/je-run-repos)
#
# Exit codes (distinct, loud): 0 ok; 2 usage; 3 bad input (unsafe token / missing workspace, log,
# or runDir); 5 git failure (clone/commit/push after retries); 7 run-repo disabled (no remote base).
set -uo pipefail

RC_USAGE=2; RC_INPUT=3; RC_GIT=5; RC_DISABLED=7

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf 'JE-RUNREPO %s\n' "$*"; }
die()  { printf 'je-run-repo.sh: %s\n' "$1" >&2; exit "${2:-1}"; }
usage() {
  printf 'usage: je-run-repo.sh init <runId> [<remote-base>] | push_results <runId> <label> <workspace-dir> | push_log <runId> <label> <log-file> | publish <runId> <runDir>\n' >&2
  exit "$RC_USAGE"
}

# Simple-filename token guard (mirrors the engine's M14 label guard): runIds and labels are joined
# into paths, branch names, and remote repo names — reject anything else BEFORE any use.
ok_token() { case "${1:-}" in ''|.|..) return 1;; esac; printf '%s' "$1" | LC_ALL=C grep -Eq '^[A-Za-z0-9._-]+$'; }

CMD="${1:-}"; RUN_ID="${2:-}"
[ -n "$CMD" ] || usage
case "$CMD" in init|push_results|push_log|publish) ;; *) usage ;; esac
ok_token "$RUN_ID" || die "unsafe/missing runId '${RUN_ID}' — must match [A-Za-z0-9._-]+" "$RC_INPUT"

# Remote base: env, or (init only) the optional positional. ABSENT is not an error but a DISTINCT
# "feature off" signal — callers check for exit 7 and skip the bus entirely.
BASE="${JE_RUN_REMOTE_BASE:-}"
if [ "$CMD" = "init" ] && [ -n "${3:-}" ]; then BASE="$3"; fi
if [ -z "$BASE" ]; then
  printf 'je-run-repo.sh: run-repo disabled — no JE_RUN_REMOTE_BASE (and no <remote-base> argument); treating the results bus as feature-off\n' >&2
  exit "$RC_DISABLED"
fi

REPO="je-run-${RUN_ID}"
URL="${BASE}/${REPO}.git"            # NEVER echoed (an https base may embed credentials)
CACHE="${JE_RUN_REPO_CACHE:-${TMPDIR:-/tmp}/je-run-repos}"

# Neutral identities — the ONLY identities this script ever writes. No operator git config leaks.
worker_ident() { printf '%s' "worker-$1"; }   # + worker@je
ENGINE_NAME="je-engine"; ENGINE_EMAIL="engine@je"; WORKER_EMAIL="worker@je"

engine_version() {
  local v
  v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HERE/../.claude-plugin/plugin.json" 2>/dev/null | head -n1)"
  printf '%s' "${v:-unknown}"
}

# Clone the run repo into $1 (reusing an existing checkout), or — pre-init / push-to-create — fall
# back to a fresh `git init` with origin set: the first push then creates the repo server-side.
ensure_checkout() { # $1 = dir
  local dir="$1"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch -q origin >/dev/null 2>&1 || true
    return 0
  fi
  mkdir -p "$dir" || die "cannot create checkout dir under the cache root" "$RC_INPUT"
  if git clone -q "$URL" "$dir" >/dev/null 2>&1; then return 0; fi
  git -C "$dir" init -q -b main >/dev/null 2>&1 || git -C "$dir" init -q >/dev/null 2>&1 \
    || die "git init failed for $REPO" "$RC_GIT"
  git -C "$dir" remote add origin "$URL" >/dev/null 2>&1 || true
}

# The VALIDATED concurrent-main retry loop (tracker #21 bench): up to 5 attempts of
# push || pull --rebase. Per-worker branches never need it (no contention by construction);
# main (logs, publish) does under parallel invocation.
push_with_retry() { # $1 = dir, $2 = branch
  local dir="$1" ref="$2" i=1
  while :; do
    if git -C "$dir" push -q origin "$ref" >/dev/null 2>&1; then return 0; fi
    [ "$i" -ge 5 ] && return 1
    git -C "$dir" pull --rebase -q origin "$ref" >/dev/null 2>&1 || true
    i=$((i+1))
  done
}

neutral_commit() { # $1 = dir, $2 = user.name, $3 = user.email, $4 = message
  git -C "$1" add -A >/dev/null 2>&1
  # commit is a no-op (rc!=0) when nothing changed — that is fine, the subsequent push settles it.
  git -C "$1" -c "user.name=$2" -c "user.email=$3" commit -q --allow-empty -m "$4" >/dev/null 2>&1 || true
}

cmd_init() {
  local seed="$CACHE/$RUN_ID/seed" now
  ensure_checkout "$seed"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  {
    printf '# %s\n\n' "$REPO"
    printf 'Joust Engine run repository (git results bus, tracker #21).\n\n'
    printf -- '- per-worker deliverables: orphan branches named by worker label (neutral identity)\n'
    printf -- '- worker run logs: `worktree-<label>-run-log` files on main\n'
    printf -- '- unmasking artifacts (mapping/summary/verdicts): pushed to main POST-RUN only\n'
  } > "$seed/README.md"
  printf '{\n  "runId": "%s",\n  "engineVersion": "%s",\n  "startedAt": "%s"\n}\n' \
    "$RUN_ID" "$(engine_version)" "$now" > "$seed/run.json"
  neutral_commit "$seed" "$ENGINE_NAME" "$ENGINE_EMAIL" "init: $REPO"
  push_with_retry "$seed" main || die "init push failed for $REPO (push-to-create rejected? check the allowlist/remote)" "$RC_GIT"
  info "init ok $REPO"
}

cmd_push_results() { # <label> <workspace-dir>
  local label="${3:-}" ws="${4:-}" co rel d
  ok_token "$label" || die "unsafe/missing worker label '${label}'" "$RC_INPUT"
  [ -n "$ws" ] && [ -d "$ws" ] && [ ! -L "$ws" ] || die "workspace dir missing/not a plain dir for worker $label" "$RC_INPUT"
  co="$CACHE/$RUN_ID/worker-$label"
  ensure_checkout "$co"
  # Fresh orphan branch <label> (reuse it on a retry), then a CLEAN tree: the branch always holds
  # exactly one snapshot of the workspace's deliverables.
  git -C "$co" checkout -q --orphan "$label" >/dev/null 2>&1 || git -C "$co" checkout -q "$label" >/dev/null 2>&1 || true
  git -C "$co" rm -r -f -q --cached . >/dev/null 2>&1 || true
  find "$co" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + 2>/dev/null
  # Copy deliverable FILES only, excluding engine artifacts: any path component starting with '_'
  # (_brief.txt, _*_run.log, _judges/, ...) and any .git dir are pruned.
  ( cd "$ws" && find . \( -name '_*' -o -name '.git' \) -prune -o -type f -print ) | while IFS= read -r f; do
    rel="${f#./}"
    d="$co/$(dirname "$rel")"
    mkdir -p "$d" && cp "$ws/$rel" "$co/$rel" || exit 1
  done || die "deliverable copy failed for worker $label" "$RC_INPUT"
  neutral_commit "$co" "$(worker_ident "$label")" "$WORKER_EMAIL" "results: worker $label"
  # Per-label branch: no contention, so a plain forced push (idempotent on retry) suffices.
  git -C "$co" push -qf origin "$label" >/dev/null 2>&1 || die "push_results push failed ($REPO branch $label)" "$RC_GIT"
  info "push_results ok $REPO $label"
}

cmd_push_log() { # <label> <log-file>
  local label="${3:-}" logf="${4:-}" co
  ok_token "$label" || die "unsafe/missing worker label '${label}'" "$RC_INPUT"
  [ -n "$logf" ] && [ -f "$logf" ] && [ ! -L "$logf" ] || die "log file missing/not a plain file for worker $label" "$RC_INPUT"
  co="$CACHE/$RUN_ID/log-$label"   # per-label checkout: local contention-free; remote main races
  ensure_checkout "$co"            # are settled by the retry loop below
  git -C "$co" checkout -q main >/dev/null 2>&1 || true
  cp "$logf" "$co/worktree-$label-run-log" || die "log copy failed for worker $label" "$RC_INPUT"
  neutral_commit "$co" "$(worker_ident "$label")" "$WORKER_EMAIL" "log: worker $label"
  push_with_retry "$co" main || die "push_log failed after 5 push/pull-rebase attempts ($REPO $label)" "$RC_GIT"
  info "push_log ok $REPO $label"
}

cmd_publish() { # <runDir> — POST-RUN ONLY (unmasking; see the sequencing rule in the header)
  local src="${3:-}" co f d b
  [ -n "$src" ] && [ -d "$src" ] && [ ! -L "$src" ] || die "runDir missing/not a plain dir" "$RC_INPUT"
  co="$CACHE/$RUN_ID/publish"
  ensure_checkout "$co"
  git -C "$co" checkout -q main >/dev/null 2>&1 || true
  # The run's final artifacts — named allowlist, never a blanket copy (underscore-prefixed
  # engine internals like _pool.md / _judges/ / _engine-logs stay local).
  for f in mapping.json SUMMARY.md SUMMARY.blind.md implement.json contributions.json \
           TIMELINE.md CONTEXT.md timeline.jsonl context.jsonl; do
    [ -f "$src/$f" ] && cp "$src/$f" "$co/$f"
  done
  for d in "$src"/review-*; do
    [ -d "$d" ] || continue
    b="$(basename "$d")"
    for f in council.json verdict.md verdict.json; do
      [ -f "$d/$f" ] && { mkdir -p "$co/$b" && cp "$d/$f" "$co/$b/$f"; }
    done
  done
  neutral_commit "$co" "$ENGINE_NAME" "$ENGINE_EMAIL" "publish: final run artifacts (post-run unmasking)"
  push_with_retry "$co" main || die "publish failed after 5 push/pull-rebase attempts ($REPO)" "$RC_GIT"
  info "publish ok $REPO"
}

case "$CMD" in
  init)         cmd_init "$@" ;;
  push_results) cmd_push_results "$@" ;;
  push_log)     cmd_push_log "$@" ;;
  publish)      cmd_publish "$@" ;;
esac
