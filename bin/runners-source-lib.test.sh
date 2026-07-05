#!/usr/bin/env bash
# Belt-and-suspenders (plan §7.4): every runner MUST source bin/_je-run-lib.sh, or it would silently
# lose finish()/the watchdog at first use. A runner refactored to drop the source line fails CI loudly
# instead of degrading silently. Run: bash bin/runners-source-lib.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAIL=0
for f in glm-run.sh local-run.sh codex-run.sh minimax-run.sh grok-run.sh; do
  if grep -Eq '(^|[[:space:]])(\.|source)[[:space:]]+"?\$HERE/_je-run-lib\.sh' "$HERE/$f"; then
    echo "  ok   $f sources _je-run-lib.sh"
  else
    echo "  FAIL $f does NOT source _je-run-lib.sh"; FAIL=1
  fi
done
# The shared lib must ship in the plugin manifest / files list (a missing file fails every runner closed).
[ -f "$HERE/_je-run-lib.sh" ] && echo "  ok   _je-run-lib.sh present in bin/" || { echo "  FAIL _je-run-lib.sh missing from bin/"; FAIL=1; }
[ "$FAIL" -eq 0 ]
