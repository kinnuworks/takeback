#!/usr/bin/env bash
# Puts the shop on mainnet from one transfer to the merchant address, then proves it:
#  1. funds the mainnet test buyer from the merchant (both wallets are ours),
#  2. sizes the shop to the rest (2 or 3 minters, float up to 100,000 sats each) and runs the genesis,
#  3. deploys the page (the plain link then opens the mainnet shop),
#  4. walks a real purchase and refund through the live page with the headless WizardConnect wallet,
#  5. sends the attack lists to two mainnet servers (refused attacks cost nothing).
# Usage: cd app && scripts/go-mainnet.sh   (reads seeds from ../tools/wiz-harness/.env.local)
set -euo pipefail
cd "$(dirname "$0")/.."
ENV=../tools/wiz-harness/.env.local
MERCHANT=bitcoincash:qzu4vmef4g96v9k08dfgeq8mmsj9m46qsy2p0t6h4u
BUYER=bitcoincash:qrr4uprqpan9pa3va89axd9leax2cq8xkswywauqa9

bal() { node scripts/balances.mjs "$1" | awk '{print $2}'; }
M=$(bal $MERCHANT); B=$(bal $BUYER)
echo "merchant $M sats, buyer $B sats"
if [ "$M" -lt 45000 ] && [ "$B" -lt 60000 ]; then echo "need at least 45,000 sats at the merchant"; exit 1; fi
# Small mode (under 190,000 sats): one minter, a buyer coin for one Kopi, and no attack run on mainnet.
SMALL=$([ "$M" -lt 190000 ] && [ "$B" -lt 60000 ] && echo 1 || echo 0)

if [ "$B" -lt 60000 ]; then
  FUND=$([ "$SMALL" = 1 ] && echo 16000 || ([ "$M" -ge 400000 ] && echo 100000 || echo 65000))
  echo "== 1. fund the test buyer with $FUND sats from the merchant"
  node --env-file=$ENV scripts/pay-from-merchant.mjs mainnet $BUYER $FUND
  sleep 4; M=$(bal $MERCHANT)
fi

FREE=$((M - 8000))
if [ "$SMALL" = 1 ]; then MINTERS=1; FLOAT=$(( (FREE - 6000) / 1000 * 1000 )); [ "$FLOAT" -gt 100000 ] && FLOAT=100000
elif [ "$FREE" -ge 310000 ]; then MINTERS=3; FLOAT=100000; else MINTERS=2; FLOAT=$(( (FREE / 2 - 1000) / 1000 * 1000 )); [ "$FLOAT" -gt 100000 ] && FLOAT=100000; fi
echo "== 2. shop genesis: $MINTERS minters with a $FLOAT-sat float each"
TAKEBACK_MINTERS=$MINTERS TAKEBACK_FLOAT=$FLOAT node --env-file=$ENV scripts/setup-shop.mjs mainnet --send

echo "== 3. deploy"
vercel --prod --yes >/dev/null && sleep 8 && curl -s https://takeback-bch.vercel.app/.well-known/bitcoin-cash-metadata-registry.json | head -c 120; echo

echo "== 4. a real purchase and refund through the live page"
E2E_FULL=1 E2E_MNEMONIC_ENV=MAINNET_TEST_MNEMONIC node --env-file=$ENV e2e/demo-path.mjs "https://takeback-bch.vercel.app/?net=mainnet" 2>&1 | grep -E "^(PASS|FAIL|DEMO|PAGE)"

if [ "$SMALL" = 1 ]; then echo "== 5. skipped in small mode (the attack run's honest cases need about 100,000 sats at the buyer)"; exit 0; fi
echo "== 5. attack lists on two mainnet servers"
node --env-file=$ENV scripts/real-attacks.mjs mainnet 2>&1 | grep -v "^PASS [APMK][0-9]" | tail -14
