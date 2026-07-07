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
# security-sweep H21: modern OpenAI project/service keys have a hyphen after `sk-` and slipped the
# old `sk-[A-Za-z0-9]{16,}` pattern → reached the PUBLIC issue body. Now caught.
expect_rc 5 "openai proj key"  'leaked sk-proj-ABCdef0123456789ABCdef0123456789 into the log'
expect_rc 5 "openai svcacct"   'the runner used sk-svcacct-ZZZ0123456789ABCdefGHIjkl to auth'
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
echo "je-issue.sh scrub-evidence (privacy scrub — fail-closed, runs BEFORE the guards):"
# Fixed HOME/USER so the $HOME-path and bare-username redactions are deterministic.
scrub_of() { printf '%s' "$1" > "$TMP/sin.md"; env HOME=/Users/tester USER=tester bash "$SUT" scrub-evidence "$TMP/sin.md" 2>/dev/null; }
# has <name> <input> <needle>    — scrubbed output MUST contain needle
has() { local out; out="$(scrub_of "$2")"; if printf '%s' "$out" | grep -qF "$3"; then pass=$((pass+1)); echo "  ok   [$1]"; else fail=$((fail+1)); echo "  FAIL [$1] missing '$3' in: $out"; fi; }
# hasnot <name> <input> <needle> — scrubbed output must NOT contain needle
hasnot() { local out; out="$(scrub_of "$2")"; if printf '%s' "$out" | grep -qF "$3"; then fail=$((fail+1)); echo "  FAIL [$1] still contains '$3'"; else pass=$((pass+1)); echo "  ok   [$1]"; fi; }

# private IPs (RFC1918) -> <PRIVATE-IP>; a PUBLIC ip is left intact (negative case)
has    "private-ip 10.x"     'host at 10.1.2.3 responded'        '<PRIVATE-IP>'
hasnot "private-ip 10.x gone" 'host at 10.1.2.3 responded'       '10.1.2.3'
has    "private-ip 192.168"   'gateway 192.168.0.5 up'           '<PRIVATE-IP>'
has    "private-ip 172.20"    'node 172.20.1.9 joined'           '<PRIVATE-IP>'
hasnot "public-ip preserved"  'dns resolver is 8.8.8.8 today'    '<PRIVATE-IP>'
has    "public-ip intact"     'dns resolver is 8.8.8.8 today'    '8.8.8.8'
# LAN hostnames -> <LAN-HOST>
has    "lan-host .local"      'reached mybox.local over ssh'     '<LAN-HOST>'
hasnot "lan-host .local gone" 'reached mybox.local over ssh'     'mybox.local'
has    "lan-host .lan"        'router.lan refused the push'      '<LAN-HOST>'
# $HOME path + bare username
has    "home path"            'wrote /Users/tester/proj/out.md'  '<HOME>'
hasnot "home path gone"       'wrote /Users/tester/proj/out.md'  '/Users/tester'
has    "bare username"        'the user tester ran the job'      '<USER>'
# generic UPPER_SNAKE env-value class ONLY (name NOT ending KEY/TOKEN) — proves the generic class works
has    "env-value generic"    'ANTHROPIC_BASE_URL=https://x.example.test'  '<REDACTED>'
hasnot "env-value generic gone" 'ANTHROPIC_BASE_URL=https://x.example.test' 'https://x.example.test'
# key/token class ONLY (lowercase name ending _token) — proves that class independently
has    "key/token class"      'session_token = abcdef0123456789'  '<REDACTED>'
hasnot "key/token class gone" 'session_token = abcdef0123456789'  'abcdef0123456789'
# email -> <EMAIL>
has    "email"                'ping me at dev@example.test soon'  '<EMAIL>'
hasnot "email gone"           'ping me at dev@example.test soon'  'dev@example.test'

# clean excerpt passes UNMODIFIED (byte-identical in==out)
_clean=$'JOUST-RC 04 schema-invalid\nthe verdict object failed to parse on candidate blind B.'
printf '%s' "$_clean" > "$TMP/cin.md"
env HOME=/Users/tester USER=tester bash "$SUT" scrub-evidence "$TMP/cin.md" > "$TMP/cout.md" 2>/dev/null
if cmp -s "$TMP/cin.md" "$TMP/cout.md"; then pass=$((pass+1)); echo "  ok   [clean excerpt unchanged]"; else fail=$((fail+1)); echo "  FAIL [clean excerpt changed]"; fi

# guards STILL fire after scrub (composition): scrub-then-check-evidence keeps the exit-3/4/5 codes
guard_after_scrub() { # <want-rc> <name> <input>
  printf '%s' "$3" > "$TMP/gs.md"
  env HOME=/Users/tester USER=tester bash "$SUT" scrub-evidence "$TMP/gs.md" > "$TMP/gso.md" 2>/dev/null
  bash "$SUT" check-evidence "$TMP/gso.md" >/dev/null 2>&1; local got=$?
  if [ "$got" -eq "$1" ]; then pass=$((pass+1)); echo "  ok   [$2] rc=$got"; else fail=$((fail+1)); echo "  FAIL [$2] want rc=$1 got rc=$got"; fi
}
guard_after_scrub 5 "secret survives scrub -> exit 5"     'the log leaked ghp_abcdefghijklmnopqrstuvwxyz0123456789 oops'
guard_after_scrub 4 "unblinding survives scrub -> exit 4" 'blind C is opus and it won'
guard_after_scrub 3 "empty after scrub -> exit 3"         ''

echo
echo "je-issue guards: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
