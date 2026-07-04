#!/usr/bin/env bash
# =============================================================================
# je-issue.test.sh — no-network regression tests for je-issue.sh's evidence
# guards (the public-repo safety + completeness gates). Exercises ONLY
# `check-evidence`, which never touches gh, so it is safe in CI / offline.
#
# Run:  bash bin/je-issue.test.sh   (exit 0 = all pass)
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/je-issue.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
# expect_rc <expected-code> <name> <evidence-text>
expect_rc() {
  local want="$1" name="$2" text="$3" f="$TMP/ev.md" got
  printf '%s' "$text" > "$f"
  bash "$SUT" check-evidence "$f" >/dev/null 2>&1; got=$?
  if [ "$got" -eq "$want" ]; then pass=$((pass+1)); echo "  ok   [$name] rc=$got"
  else fail=$((fail+1)); echo "  FAIL [$name] want rc=$want got rc=$got"; fi
}

echo "je-issue.sh check-evidence guards:"

# --- rc 3: empty / placeholder ------------------------------------------------
expect_rc 3 "empty"            ""
expect_rc 3 "whitespace-only"  $'   \n  \t '
expect_rc 3 "TODO placeholder" "TODO: paste the verdict here"
expect_rc 3 "angle placeholder" "<paste the offending excerpt>"

# --- rc 4: unblinding (blind-letter -> model / mapping.json / candidate JSON) --
expect_rc 4 "blind=model"      '> reviewer on blind B = the haiku+Bash plan ranked it last'
expect_rc 4 "blind is model"   'blind C is opus and it won'
expect_rc 4 "mapping.json ref" 'see mapping.json (round 1): blind A won'
expect_rc 4 "candidate json"   'mapping: {"candidate":"E","model":"codex-high"}'
# a NEW (un-enumerated) provider name must still be caught via the JSON / "(model)" shapes
expect_rc 4 "blind=newprovider" 'blind D = acme-ultra-7b (model) won round 2'
expect_rc 4 "candidate->model"  '{"candidate":"F","model":"acme-ultra-7b"}'

# --- rc 5: secrets ------------------------------------------------------------
expect_rc 5 "gh token"         'the log leaked ghp_abcdefghijklmnopqrstuvwxyz0123456789 oops'
expect_rc 5 "api key kv"       'config had api_key = sk-abcdef0123456789abcdef0123 in it'
# new formats — all values are obviously FAKE but match the real format shape
expect_rc 5 "google api key"   'env had GOOGLE_KEY=AIzaFAKE_NOT_A_REAL_GOOGLE_KEY_00000000 set'
expect_rc 5 "slack token"      'the bot used xoxb-FAKE-NOT-A-REAL-TOKEN-000000 to post'
expect_rc 5 "pem private key"  $'-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----'
expect_rc 5 "jwt"              'Authorization header was eyJFAKE-header-not-real.FAKE-payload-not-real.FAKE-sig-not-real'
# Stripe live keys: assemble the literal at runtime so the obviously-fake token is
# never a contiguous string in source (avoids tripping push-protection scanners),
# while still feeding check-evidence a value that matches the [sr]k_live_ shape.
_live="_live_"; _body="FAKEFAKEFAKEFAKE00000000"
expect_rc 5 "stripe live sk"   "the webhook used sk${_live}${_body} to charge"
expect_rc 5 "stripe live rk"   "a restricted key rk${_live}${_body} leaked too"

# --- rc 0: legitimate verbatim evidence (no leak) -----------------------------
expect_rc 0 "clean excerpt"    $'> Round-1 reviewer, on blind candidate B:\n> "the core mechanism is wrong" — but a later probe proved node:fs is absent.'
expect_rc 0 "clean prose"      'je-parse mis-read the prose "two pass" form and ran single pass.'
expect_rc 0 "prose mentions key" 'the api description was clear but the secret sauce is the ranking heuristic.'

echo
echo "je-issue guards: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
