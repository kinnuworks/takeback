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
cmp evidence/attacks.json app/src/evidence/attacks.json && cmp evidence/attacks-2.json app/src/evidence/attacks-2.json && cmp evidence/attacks-3.json app/src/evidence/attacks-3.json && cmp evidence/attacks-4.json app/src/evidence/attacks-4.json && echo "attack lists in sync"
(cd app && node scripts/proof-summary.mjs --check)

echo "== contract: compile ReceiptMinter (CashScript 0.14)"
(cd app && npx --no-install cashc contracts/ReceiptMinter.cash -o contracts/ReceiptMinter.json)

echo "== contract: evidence/attacks.json on the BCH 2026 VM (every attack rejected, every valid case accepted)"
(cd app && node contracts/attacks.test.mjs 1 | tail -2)

echo "== contract: evidence/attacks-2.json, the second labelled list (partial refunds)"
(cd app && node contracts/attacks.test.mjs 2 | tail -2)

echo "== contract: evidence/attacks-3.json, the third labelled list (found by the fuzzer on v1)"
(cd app && node contracts/attacks.test.mjs 3 | tail -2)

echo "== contract: evidence/attacks-4.json, the fourth labelled list (found by mutation testing)"
(cd app && node contracts/attacks.test.mjs 4 | tail -2)

echo "== contract: differential fuzzer, 20,000 random transactions (seed 20261122), zero security holes"
(cd app && node contracts/fuzz.test.mjs 20000 20261122 | head -5)

echo "== wallets: the receipt registry's parse bytecode, run in the BCMR spec's parsing transaction, yields amount and order id"
(cd app && node contracts/bcmr-parse.test.mjs | tail -1)

echo "== receipts: amounts and order ids round-trip exactly as the contract reads them (OP_BIN2NUM)"
(cd app && node tests/decode.test.mjs)

echo "== flow: purchase + refund built by the app, signed by the headless wallet, verified on the VM"
(cd app && node tests/flow.test.ts | tail -1)

echo "== app: typecheck and build"
(cd app && npm run --silent build >/dev/null && echo "build ok")

echo "== demo path: real browser, banner/tagline/menu, Connect -> wallet pairs over the relay (video in app/e2e/videos)"
(cd app && perl -e 'alarm 150; exec @ARGV' node e2e/demo-path.mjs 2>&1 | grep -E "^(PASS|FAIL|video|DEMO)" ; test "${PIPESTATUS[0]}" -eq 0)

echo "== WizardConnect: when the wallet ends the session from its side, the page notices and offers Connect wallet again"
(cd app && perl -e 'alarm 120; exec @ARGV' node e2e/wallet-disconnect.mjs 2>&1 | grep -E "^(PASS|FAIL|WALLET)" ; test "${PIPESTATUS[0]}" -eq 0)

echo "== mainnet: when the owner's mainnet demo budget is empty or at its hourly cap, Try it now carries on in the chipnet demo (no error)"
(cd app && perl -e 'alarm 120; exec @ARGV' node e2e/mainnet-fallback.mjs 2>&1 | grep -E "^(PASS|FAIL|MAINNET)" ; test "${PIPESTATUS[0]}" -eq 0)

echo "== required banner: the Widget Factory slides page is live"
curl -sf https://takeback-bch.vercel.app/slides.html | grep -q "The story of Takeback" && echo "slides live"

echo "== the demo faucet holds at least 100,000 chipnet test sats (about four new visitors); refill it before it runs dry"
curl -sf https://takeback-bch.vercel.app/api/faucet | python3 -c "import json,sys; b=int(json.load(sys.stdin)['balance']); print(f'faucet balance {b:,} test sats'); sys.exit(0 if b >= 100000 else 1)"

echo "== the chipnet shop's refund float holds at least 100,000 sats (refunds are paid from it; purchases pay the merchant)"
(cd app && node scripts/top-up-float.mjs chipnet --check)

echo "== live no-wallet demo on chipnet: faucet, buy, refund with timing, 5 cheats refused by a node, attacks and fuzz in the browser"
(cd app && perl -e 'alarm 180; exec @ARGV' node e2e/demo-instant.mjs 2>&1 | grep -E "^(PASS|FAIL|INSTANT)" ; test "${PIPESTATUS[0]}" -eq 0)

echo "== live one-click buy: Buy on a cold chipnet page makes and funds a demo wallet, pays, then refunds"
(cd app && perl -e 'alarm 150; exec @ARGV' node e2e/demo-buy-first.mjs 2>&1 | grep -E "^(PASS|FAIL|BUY)" ; test "${PIPESTATUS[0]}" -eq 0)

echo "== live partial refund: Refund half gives back half and a new receipt for the rest, which then refunds in full"
(cd app && perl -e 'alarm 150; exec @ARGV' node e2e/demo-partial.mjs 2>&1 | grep -E "^(PASS|FAIL|PARTIAL)" ; test "${PIPESTATUS[0]}" -eq 0)

echo "== wallet: WizardConnect pairing + signing over the real relay (headless test wallet)"
(cd tools/wiz-harness && TEST_MNEMONIC="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" perl -e 'alarm 90; exec @ARGV' node e2e-relay.mjs 2>&1 | grep -E "VM verify: PASS" || { echo "relay round trip failed"; exit 1; })

# Evidence labels: once evidence/EVAL_PLAN.md exists, the public text (README, submission text,
# video script) must label every evidence claim for its kind.
if [ -f evidence/EVAL_PLAN.md ] && [ -f evidence_lint.py ]; then
  python3 -I evidence_lint.py
fi

echo "check.sh: all checks passed"
