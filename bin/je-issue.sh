#!/usr/bin/env bash
# =============================================================================
# je-issue.sh — Joust Engine dogfood backlog, on GitHub Issues.
#
# The CAPABILITY an @@JE run uses to record + work problems found while running
# tournaments. ALL forge (gh) access is confined to THIS file so the tournament
# engine (workflows/tournament.mjs) stays forge-agnostic. Lives at the plugin
# root bin/, beside je-git.sh / je-parse.mjs. Convention + flow:
#   skills/joust-engine/references/dogfood.md
#
# Subcommands:
#   bootstrap                 (re-runnable) create the dogfood label scheme
#   new       --sev .. --area .. --title .. --evidence-file F [..]   file an item
#   check-evidence FILE       run ONLY the evidence guards (no network; for tests)
#   next                      print the top open dogfood issue number (sev1->sev3)
#   claim     N RUN-ID        best-effort claim issue N (see references/dogfood.md)
#   release   N [RUN-ID]      drop your claim on issue N
#   drain-inbox               file any committed docs/dogfood/inbox/*.md via `new`
#
# Guards return distinct exit codes so callers/tests can branch:
#   3 = evidence empty / placeholder   4 = unblinding (blind->model / mapping.json)
#   5 = possible secret/token
#
# Offline / no-gh / headless: `new` degrades to a COMMITTED inbox file under
# docs/dogfood/inbox/ (NEVER .runs/, which is gitignored) so a finding is never
# lost; drain-inbox files them when connectivity returns.
#
# Target repo: NOT hard-coded. Resolved once per run as  $GH_REPO  if set, else
# inferred by `gh` from the current git checkout's remote. Set GH_REPO=owner/repo
# to pin it (e.g. in a fork or a multi-remote checkout where inference is ambiguous).
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"              # repo root (= plugin root)
DOGFOOD_DIR="$PLUGIN_ROOT/docs/dogfood"
INBOX_DIR="$DOGFOOD_DIR/inbox"

MARKER="dogfood"                                         # label every JE item carries
TITLE_PREFIX="[dogfood] "

die()  { echo "je-issue: $*" >&2; exit 1; }
info() { echo "je-issue: $*" >&2; }
now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }

gh_ok() { command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; }

# Resolve the target repo ONCE: $GH_REPO if set (explicit override, deterministic
# even with multiple remotes), else `gh`'s inference from the local git remote.
# Every issue/label call is pinned to it via ghi() so a run can't straddle repos.
JE_REPO=""
resolve_repo() {
  [ -n "$JE_REPO" ] && return 0
  if [ -n "${GH_REPO:-}" ]; then
    JE_REPO="$GH_REPO"
  else
    JE_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
  fi
  [ -n "$JE_REPO" ] || die "cannot resolve target repo — set GH_REPO=owner/repo, or run inside a checkout with a GitHub remote."
  info "target repo: $JE_REPO"
}
ghi() { gh "$@" --repo "$JE_REPO"; }   # gh, pinned to the resolved repo

# ---------------------------------------------------------------------------
# Guards (pure text; NO network — unit-testable)
# ---------------------------------------------------------------------------
# check_evidence FILE -> 0 ok | 3 empty/placeholder | 4 unblinding | 5 secret
check_evidence() {
  local f="${1:?check_evidence: evidence file required}" ev stripped
  [ -f "$f" ] || { echo "REFUSE: evidence file not found: $f" >&2; return 3; }
  ev="$(cat "$f")"
  stripped="$(printf '%s' "$ev" | tr -d '[:space:]')"
  case "$stripped" in
    ""|TODO*|FIXME*|TBD*|XXX*|"<paste"*|"...") \
      echo "REFUSE: Durable evidence is empty or a placeholder." >&2; return 3 ;;
  esac
  # PUBLIC repo: a blind-letter -> model association, or a mapping.json reference,
  # de-anonymises which candidate was which model. Refer to candidates as "blind B".
  if printf '%s' "$ev" | grep -Eiq \
      'mapping\.json|blind[[:space:]]+[A-Z][[:space:]]*(=|->|:|is|was)[[:space:]]*(the[[:space:]]+)?(opus|sonnet|haiku|glm|codex|minimax|gpt|claude)|"candidate"[[:space:]]*:[[:space:]]*"[A-Z]"'; then
    echo "REFUSE: evidence appears to UNBLIND a candidate (blind-letter->model / mapping.json). Redact to 'blind B'." >&2
    return 4
  fi
  # Obvious secrets/tokens.
  if printf '%s' "$ev" | grep -Eiq \
      'sk-[A-Za-z0-9]{16,}|gh[ps]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|(api[_-]?key|secret|bearer|access[_-]?token)[[:space:]"'"'"':=]+[A-Za-z0-9._\-]{16,}'; then
    echo "REFUSE: possible secret/token in evidence." >&2
    return 5
  fi
  return 0
}

# ---------------------------------------------------------------------------
# bootstrap — idempotent label scheme (mirrors the legacy roster columns)
# ---------------------------------------------------------------------------
cmd_bootstrap() {
  gh_ok || die "gh not available/authenticated; cannot bootstrap labels."
  resolve_repo
  local specs=(
    "dogfood|6f42c1|JE dogfood backlog item (found while running @@JE)"
    "sev1|b60205|wrong winners / corrupts tournament outcome"
    "sev2|d93f0b|degraded but usable"
    "sev3|fbca04|cosmetic / docs"
    "area:review|0e8a16|tournament review/ranking"
    "area:runner|0e8a16|model runner scripts"
    "area:parse|0e8a16|je-parse invocation parsing"
    "area:git|0e8a16|je-git / grand-loop git mechanics"
    "area:skill|0e8a16|SKILL.md procedure"
    "area:docs|0e8a16|documentation"
    "area:infra|0e8a16|engine / workflow infrastructure"
    "claimed|c5def5|transient claim marker (see references/dogfood.md)"
    "wontfix|ffffff|will not be fixed (by-design / out of scope)"
  )
  local spec name color desc
  for spec in "${specs[@]}"; do
    IFS='|' read -r name color desc <<<"$spec"
    if ghi label create "$name" --color "$color" --description "$desc" >/dev/null 2>&1; then
      echo "  created  $name"
    else
      ghi label edit "$name" --color "$color" --description "$desc" >/dev/null 2>&1 \
        && echo "  exists   $name" || echo "  SKIP     $name (label op failed)"
    fi
  done
  info "bootstrap complete."
}

# ---------------------------------------------------------------------------
# new — file a dogfood item (the day-to-day capability)
# ---------------------------------------------------------------------------
SEV="" AREA="" TITLE="" RUNID="" EVIDENCE_FILE="" PROBLEM_FILE="" REPRO_FILE="" FIX_FILE=""
_parse_new_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --sev) SEV="$2"; shift 2;;
      --area) AREA="$2"; shift 2;;
      --title) TITLE="$2"; shift 2;;
      --run-id) RUNID="$2"; shift 2;;
      --evidence-file) EVIDENCE_FILE="$2"; shift 2;;
      --problem-file) PROBLEM_FILE="$2"; shift 2;;
      --repro-file) REPRO_FILE="$2"; shift 2;;
      --fix-file) FIX_FILE="$2"; shift 2;;
      *) die "new: unknown flag '$1'";;
    esac
  done
}
_section() { [ -n "$1" ] && [ -f "$1" ] && cat "$1" || echo "_(none provided)_"; }
render_body() {
  cat <<EOF
## Problem
$(_section "$PROBLEM_FILE")

## Durable evidence (verbatim excerpt)
$(cat "$EVIDENCE_FILE")

## Repro
$(_section "$REPRO_FILE")

## Suspected fix
$(_section "$FIX_FILE")

---
_Provenance (non-durable breadcrumb): run-id \`${RUNID:-unknown}\`. \`.runs/\` may be gc'd — evidence above is the durable record._
EOF
}
find_dup() {  # <full-title-without-prefix> -> prints existing issue number, if any
  # Exact, special-char-safe match: list all dogfood issues as number<TAB>title and
  # compare the full title in-shell. Avoids the `--search in:title` query breaking on
  # backticks/quotes/parens in a title (which silently returns nothing -> a duplicate).
  local want="${TITLE_PREFIX}$1" num title
  while IFS=$'\t' read -r num title; do
    [ "$title" = "$want" ] && { echo "$num"; return 0; }
  done < <(ghi issue list --state all --label "$MARKER" --limit 400 \
             --json number,title --jq '.[]|[.number,.title]|@tsv' 2>/dev/null)
  return 0
}
fallback_inbox() {  # <title> <body> -> committed inbox draft (never .runs/)
  mkdir -p "$INBOX_DIR"
  local f="$INBOX_DIR/INBOX-$(date -u +%Y%m%dT%H%M%SZ)-$$.md"
  { printf '<!-- dogfood inbox draft: sev=%s area=%s -->\n# %s%s\n\n' "$SEV" "$AREA" "$TITLE_PREFIX" "$1"; printf '%s\n' "$2"; } > "$f"
  info "gh unavailable — wrote COMMITTED inbox draft: ${f#$PLUGIN_ROOT/}"
  info "commit it now; run 'je-issue.sh drain-inbox' when gh is reachable."
  echo "$f"
}
cmd_new() {
  _parse_new_flags "$@"
  : "${TITLE:?new: --title required}"
  : "${SEV:?new: --sev required (sev1|sev2|sev3)}"
  : "${AREA:?new: --area required (review|runner|parse|git|skill|docs|infra)}"
  : "${EVIDENCE_FILE:?new: --evidence-file required}"
  case "$SEV" in sev1|sev2|sev3) ;; *) die "new: --sev must be sev1|sev2|sev3";; esac
  local rc; check_evidence "$EVIDENCE_FILE"; rc=$?; [ $rc -ne 0 ] && return $rc
  local body; body="$(render_body)"
  if ! gh_ok; then fallback_inbox "$TITLE" "$body"; return 0; fi
  resolve_repo
  local dup; dup="$(find_dup "$TITLE")"
  if [ -n "$dup" ]; then info "duplicate of #$dup — not filing (comment there if new info)."; echo "$dup"; return 0; fi
  ghi issue create --title "${TITLE_PREFIX}${TITLE}" \
    --label "$MARKER" --label "$SEV" --label "area:$AREA" --body "$body"
}

# ---------------------------------------------------------------------------
# next — top open item: lowest sev, then lowest issue number
# ---------------------------------------------------------------------------
cmd_next() {
  gh_ok || die "gh unavailable."
  resolve_repo
  local sev n
  for sev in sev1 sev2 sev3; do
    n="$(ghi issue list --state open --label "$MARKER" --label "$sev" --json number \
         --jq 'if length>0 then (min_by(.number).number) else empty end' 2>/dev/null)"
    if [ -n "$n" ]; then echo "$n"; return 0; fi
  done
  info "no open dogfood items."
  return 0
}

# ---------------------------------------------------------------------------
# claim — BEST-EFFORT (no gh-API compare-and-swap). See references/dogfood.md.
# Assignee+label are additive/idempotent; this is TOCTOU with a deterministic
# tiebreak so at most one worker proceeds. For STRICT exclusivity at high
# fan-out use the git-ref escape hatch documented in references/dogfood.md.
# ---------------------------------------------------------------------------
cmd_claim() {
  gh_ok || die "gh unavailable."
  resolve_repo
  local n="${1:?claim: issue number}" runid="${2:?claim: run-id}" me
  me="$(gh api user --jq .login 2>/dev/null)" || die "claim: cannot resolve gh user."
  # IDENTITY IS THE RUN-ID, not the gh login: @@JE workers usually share ONE gh account,
  # so assignee/login cannot disambiguate two concurrent runs. The durable `claim: run:<id>`
  # comment is the lock; the assignee + `claimed` label are just visible state.
  # 1. announce our claim (carries our run-id).
  ghi issue comment "$n" --body "claim: run:$runid by:@$me at:$(now)" >/dev/null 2>&1 \
    || die "claim: cannot comment on #$n."
  ghi issue edit "$n" --add-assignee @me --add-label claimed >/dev/null 2>&1
  # 2. deterministic tiebreak: the EARLIEST `claim: run:` comment wins. Livelock-free —
  #    only losers back off; once the comments exist the winning run-id is fixed.
  local winner
  winner="$(ghi issue view "$n" --json comments \
    --jq '[.comments[]|select(.body|test("^claim: run:"))]|sort_by(.createdAt,.url)|.[0].body|capture("run:(?<r>[^ ]+)").r' 2>/dev/null)"
  if [ -n "$winner" ] && [ "$winner" != "$runid" ]; then
    info "lost claim on #$n: run:$winner got there first (mine run:$runid) — backing off."
    ghi issue comment "$n" --body "release: run:$runid (superseded by run:$winner)" >/dev/null 2>&1
    return 2
  fi
  info "claimed #$n (run:$runid). best-effort; for strict exclusivity at high fan-out use the git-ref hatch (see references/dogfood.md)."
  echo "$n"
}
cmd_release() {
  gh_ok || die "gh unavailable."
  resolve_repo
  local n="${1:?release: issue number}" runid="${2:-}"
  ghi issue edit "$n" --remove-assignee @me --remove-label claimed >/dev/null 2>&1
  ghi issue comment "$n" --body "release: run:${runid:-unknown} (explicit)" >/dev/null 2>&1
  info "released #$n."
}

# ---------------------------------------------------------------------------
# drain-inbox — file committed offline drafts, then remove them
# ---------------------------------------------------------------------------
cmd_drain_inbox() {
  gh_ok || die "gh unavailable — cannot drain inbox."
  [ -d "$INBOX_DIR" ] || { info "no inbox dir."; return 0; }
  local f filed=0
  for f in "$INBOX_DIR"/*.md; do
    [ -e "$f" ] || continue
    info "draining $f — file it manually via 'je-issue.sh new ...' using its sections, then: git rm $f"
    filed=$((filed+1))
  done
  [ "$filed" -eq 0 ] && info "inbox empty."
  info "drain is intentionally manual (each draft needs --sev/--area to re-validate)."
}

# ---------------------------------------------------------------------------
main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    bootstrap)       cmd_bootstrap "$@";;
    new)             cmd_new "$@";;
    check-evidence)  check_evidence "$@";;
    next)            cmd_next "$@";;
    claim)           cmd_claim "$@";;
    release)         cmd_release "$@";;
    drain-inbox)     cmd_drain_inbox "$@";;
    ""|-h|--help|help)
      sed -n '/^# ===/,/^# ===/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//';;
    *) die "unknown subcommand '$cmd' (try: help)";;
  esac
}
# Run main only when executed directly, not when sourced (e.g. by tests).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
