#!/usr/bin/env bash
# Joust Engine CLAUDEX JUDGE runner — approved internal tool. Originated with the retired engine
# fork council (tracker #19); salvaged as a STANDALONE runner for the future CI code council
# (tracker #21) — it has no engine callers and depends on no engine code.
# Runs ONE single-turn council judge call on an OpenAI-family model (default gpt-5.6-sol) with the
# Claude CLI pointed at a local CLIProxyAPI instance, by PIPING a staged prompt to
# `claude -p --output-format json`. Deliberately LEAN — it does NOT source bin/_je-run-lib.sh: the
# attempt-runner machinery (detach, stall watchdog, JOUST-RC log discipline) exists for long agentic
# sessions writing into a workspace; a judge seat is one synchronous prompt->result call whose whole
# contract is its stdout.
#
# Usage (tracker #21 phase 1 — runner-side prompt assembly):
#   claudex-judge.sh <pool-file> <suffix-file>   two-file mode: the prompt is cat(pool, suffix),
#                                                assembled HERE. The engine stages only the ~1-2KB
#                                                per-seat suffix; the ~50KB blind pool is read
#                                                straight off disk (<reviewDir>/_pool.md) and never
#                                                transits the model persist dataplane again.
#   claudex-judge.sh <prompt-file>               legacy single-file fallback, byte-identical to the
#                                                original contract (one pre-assembled prompt file).
#
# Env contract (mirrors bin/claudex-run.sh — all generic, no machine-specific values baked in):
#   JE_CLAUDEX_BASE_URL    proxy endpoint       (default http://127.0.0.1:8317)
#   JE_CLAUDEX_TOKEN_FILE  client-token file    (default $HOME/.config/cliproxyapi/client-token)
#   JE_CLAUDEX_MODEL       judge model          (default gpt-5.6-sol; also CLAUDE_CODE_SUBAGENT_MODEL)
#   JE_TIMEOUT_SECS        wall-clock backstop  (default 600)
# The token FILE's contents become ANTHROPIC_AUTH_TOKEN for the child, read at exec time and NEVER
# echoed/logged — only the PATH is safe to print.
#
# Stdout contract (the engine parses these lines; JOUST- markers are line-anchored):
#   JOUST-CLAUDEXJ-PROVENANCE endpoint=<host> model=<model> timeout=<T>s
#   <the model's result text, verbatim>
#   USAGE <json>                       (token usage parsed from the CLI's json output)
#   JOUST-CLAUDEXJ-DONE exit=<n>       (always the last line; JOUST-CLAUDEXJ-TIMEOUT precedes it on 124)
#
# Fail-fast exits (distinct, loud, claude never invoked): 3 missing/empty token file; 4 missing/empty
# prompt/pool/suffix file; 5 proxy unreachable. Post-run: 6 unparseable CLI json; 124 wall-clock
# timeout; otherwise the child's own exit code (is_error:true in a parseable result exits 1).
set -uo pipefail
unset ANTHROPIC_API_KEY            # the REAL Anthropic key must never reach the proxy child (fold-in B)
# Lean secret scrub (je_scrub_child_secrets' list, inlined): the child needs exactly ONE token.
for _v in ZAI_API_KEY MINIMAX_API_KEY OMLX_AUTH_TOKEN OPENAI_API_KEY XAI_API_KEY \
          GH_TOKEN GITHUB_TOKEN GITHUB_PAT GH_ENTERPRISE_TOKEN \
          AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
          GOOGLE_APPLICATION_CREDENTIALS GCP_SA_KEY GCLOUD_SERVICE_KEY \
          NPM_TOKEN NODE_AUTH_TOKEN SSH_AUTH_SOCK CLOUDFLARE_API_TOKEN DIGITALOCEAN_TOKEN; do
  unset "$_v"
done

PROMPT_FILE="${1:-}"   # two-file mode: the POOL file; single-file mode: the whole prompt
SUFFIX_FILE="${2:-}"   # two-file mode only: the per-seat suffix appended after the pool
BASE_URL="${JE_CLAUDEX_BASE_URL:-http://127.0.0.1:8317}"
TOKEN_FILE="${JE_CLAUDEX_TOKEN_FILE:-$HOME/.config/cliproxyapi/client-token}"
MODEL="${JE_CLAUDEX_MODEL:-gpt-5.6-sol}"
TIMEOUT="${JE_TIMEOUT_SECS:-600}"

done_line() { echo "JOUST-CLAUDEXJ-DONE exit=$1"; }

# Fail-fast guard 1: every named prompt part must exist, be readable, and be non-empty — never
# launch on missing or empty bytes (a half-assembled prompt is a dispatch failure, exit 4).
if [ -z "$PROMPT_FILE" ] || [ ! -r "$PROMPT_FILE" ] || [ ! -s "$PROMPT_FILE" ]; then
  echo "claudex-judge.sh: prompt/pool file missing/unreadable/empty: '${PROMPT_FILE}' (usage: claudex-judge.sh <pool-file> <suffix-file> | claudex-judge.sh <prompt-file>)" >&2
  done_line 4; exit 4
fi
if [ -n "$SUFFIX_FILE" ] && { [ ! -r "$SUFFIX_FILE" ] || [ ! -s "$SUFFIX_FILE" ]; }; then
  echo "claudex-judge.sh: suffix file missing/unreadable/empty: '${SUFFIX_FILE}' (usage: claudex-judge.sh <pool-file> <suffix-file>)" >&2
  done_line 4; exit 4
fi
# Fail-fast guard 2: the client-token file must exist, be readable, and be non-empty. NEVER echo
# its contents anywhere — only the PATH is safe to print.
if [ ! -r "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
  echo "claudex-judge.sh: client-token file missing/unreadable/empty: $TOKEN_FILE (set JE_CLAUDEX_TOKEN_FILE)" >&2
  done_line 3; exit 3
fi
# Fail-fast guard 3: the proxy endpoint must at least answer TCP/HTTP (any status counts; only a
# connect-class failure trips this). No credential rides in the probe.
if ! curl -s -o /dev/null --connect-timeout 5 --max-time 10 "$BASE_URL" 2>/dev/null; then
  echo "claudex-judge.sh: proxy endpoint unreachable: $BASE_URL (set JE_CLAUDEX_BASE_URL; is CLIProxyAPI running?)" >&2
  done_line 5; exit 5
fi

_prov_token="$(cat "$TOKEN_FILE")"   # $(cat) strips the trailing newline client-token files carry

echo "JOUST-CLAUDEXJ-PROVENANCE endpoint=${BASE_URL#*://} model=${MODEL} timeout=${TIMEOUT}s"

OUT="$(mktemp)" || { done_line 9; exit 9; }
ERR="$(mktemp)" || { rm -f "$OUT"; done_line 9; exit 9; }
ASM=""
cleanup() { rm -f "$OUT" "$ERR" ${ASM:+"$ASM"}; }
trap cleanup EXIT

# Runner-side prompt assembly (#21 phase 1): in two-file mode the prompt IS cat(pool, suffix) — a
# plain byte concatenation into a private temp file (both parts were guard-checked non-empty above).
PROMPT_SRC="$PROMPT_FILE"
if [ -n "$SUFFIX_FILE" ]; then
  ASM="$(mktemp)" || { done_line 9; exit 9; }
  if ! cat "$PROMPT_FILE" "$SUFFIX_FILE" > "$ASM"; then
    echo "claudex-judge.sh: prompt assembly (cat pool + suffix) failed" >&2
    done_line 9; exit 9
  fi
  PROMPT_SRC="$ASM"
fi

# One try, wall-clock bounded: alarm(2) survives exec, so the perl wrapper arms SIGALRM and execs
# claude — a hung call dies at TIMEOUT with status 142 (128+SIGALRM), mapped to the classic 124.
# The prompt is PIPED on stdin (never argv — it can exceed ARG_MAX); the env is the published
# claudex recipe with the judge model mirrored into CLAUDE_CODE_SUBAGENT_MODEL.
ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_AUTH_TOKEN="$_prov_token" \
CLAUDE_CODE_SUBAGENT_MODEL="$MODEL" \
CLAUDE_CODE_ALWAYS_ENABLE_EFFORT="1" \
ENABLE_TOOL_SEARCH="false" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" \
perl -e 'alarm shift @ARGV; exec @ARGV or die "exec: $!"' -- "$TIMEOUT" \
  claude -p --output-format json --model "$MODEL" < "$PROMPT_SRC" > "$OUT" 2> "$ERR"
RC=$?
if [ "$RC" -eq 142 ]; then
  echo "JOUST-CLAUDEXJ-TIMEOUT secs=${TIMEOUT}"
  echo "claudex-judge.sh: wall-clock timeout after ${TIMEOUT}s" >&2
  done_line 124; exit 124
fi
if [ "$RC" -ne 0 ] && [ ! -s "$OUT" ]; then
  tail -c 2000 "$ERR" >&2
  done_line "$RC"; exit "$RC"
fi

# Parse the CLI's json envelope with node (pinned toolchain dependency; see package.json engines):
# print the result text + one USAGE line. A doc that does not parse is a DISTINCT failure (exit 6)
# — never relay bytes the contract cannot vouch for. is_error:true exits 1 (honest loss).
# DEFANG (the runners' JE_DEFANG discipline): a model-authored result line starting with our own
# trust-marker prefixes (JOUST-CLAUDEXJ / USAGE) is indented one space, so a prompt-injected judge
# can never forge a column-0 provenance/DONE/USAGE line into the engine-parsed stream.
if node -e '
  const fs = require("fs")
  let d
  try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch { process.exit(6) }
  if (!d || typeof d !== "object" || typeof d.result !== "string") process.exit(6)
  const defanged = d.result.split("\n").map(l => /^(JOUST-CLAUDEXJ|USAGE\s)/.test(l) ? " " + l : l).join("\n")
  process.stdout.write(defanged.endsWith("\n") ? defanged : defanged + "\n")
  console.log("USAGE " + JSON.stringify(d.usage || {}))
  process.exit(d.is_error ? 1 : 0)
' "$OUT"; then
  done_line 0; exit 0
else
  PRC=$?
  if [ "$PRC" -eq 6 ]; then
    echo "claudex-judge.sh: claude CLI output is not the expected json envelope (see stderr)" >&2
    tail -c 2000 "$ERR" >&2
    done_line 6; exit 6
  fi
  done_line "$PRC"; exit "$PRC"
fi
