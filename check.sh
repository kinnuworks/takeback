#!/usr/bin/env bash
# The checks that prove this project works: tests, typecheck, and the end-to-end script
# that walks the demo path in a real browser against the real API, recording a screen
# video of it. Exits non-zero when anything fails.
#
# Keep it fast enough to run often (a few minutes at most), stop any server it starts
# before it exits, and never make a check pass by skipping, weakening or special-casing it.
set -euo pipefail
cd "$(dirname "$0")"

echo "== evidence: the app's copies of the attack lists match evidence/ exactly"
cmp evidence/attacks.json app/src/evidence/attacks.json && cmp evidence/attacks-2.json app/src/evidence/attacks-2.json && echo "attack lists in sync"

echo "== contract: compile ReceiptMinter (CashScript 0.14)"
(cd app && npx --no-install cashc contracts/ReceiptMinter.cash -o contracts/ReceiptMinter.json)

echo "== contract: evidence/attacks.json on the BCH 2026 VM (every attack rejected, every valid case accepted)"
(cd app && node contracts/attacks.test.mjs 1 | tail -2)

echo "== contract: evidence/attacks-2.json, the second labelled list (partial refunds)"
(cd app && node contracts/attacks.test.mjs 2 | tail -2)

echo "== flow: purchase + refund built by the app, signed by the headless wallet, verified on the VM"
(cd app && node tests/flow.test.ts | tail -1)

echo "== app: typecheck and build"
(cd app && npm run --silent build >/dev/null && echo "build ok")

echo "== demo path: real browser, banner/tagline/menu, Connect -> wallet pairs over the relay (video in app/e2e/videos)"
(cd app && perl -e 'alarm 150; exec @ARGV' node e2e/demo-path.mjs 2>&1 | grep -E "^(PASS|FAIL|video|DEMO)" ; test "${PIPESTATUS[0]}" -eq 0)

echo "== wallet: WizardConnect pairing + signing over the real relay (headless test wallet)"
(cd tools/wiz-harness && TEST_MNEMONIC="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" perl -e 'alarm 90; exec @ARGV' node e2e-relay.mjs 2>&1 | grep -E "VM verify: PASS" || { echo "relay round trip failed"; exit 1; })

# Evidence labels: once evidence/EVAL_PLAN.md exists, the public text (README, submission text,
# video script) must label every evidence claim for its kind.
if [ -f evidence/EVAL_PLAN.md ] && [ -f evidence_lint.py ]; then
  python3 -I evidence_lint.py
fi

echo "check.sh: all checks passed"
