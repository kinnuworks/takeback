# Takeback

Pay with Bitcoin Cash, get a receipt that refunds. Every purchase puts a receipt token in the buyer's wallet in the same transaction, and the shop can refund exactly what's on that receipt, to whoever holds it, once.

It needs Bitcoin Cash because the receipt is a CashToken minted by a covenant inside the payment itself, and the refund rules live in that covenant, so neither the shop's server nor the customer can bend them.

**Live demo:** https://takeback-bch.vercel.app

**Try it in 30 seconds**
1. Open the link on a laptop and press **Connect wallet to buy**.
2. Scan the QR code with Paytaca or Selene (WizardConnect).
3. Buy a coffee from the Kopi Blaze demo shop. Approve in your wallet.
4. The receipt shows up under **Your receipts**. Press **Refund**, approve, and the same amount comes back.
5. No wallet handy? Press **Run the attacks** to watch the contract refuse 46 ways of cheating it.

## How it uses Bitcoin Cash

- **The receipt is minted inside the payment.** [`ReceiptMinter.cash`](app/contracts/ReceiptMinter.cash) holds the shop's minting token. Its `pay` path only lets a purchase through if output 1 pays the merchant exactly the amount written into the receipt NFT at output 2, and if no other output carries the shop's token category.
- **Refunds follow the receipt, not an address the customer types.** The `refund` path pays exactly the receipt's amount to the address that held the receipt, and the receipt is burned in the same transaction. A second refund of the same receipt has nothing to spend.
- **Partial refunds keep the rest owed.** The `partialRefund` path pays part of the receipt and, in the same transaction, gives the holder a new receipt for exactly the remainder with the same order id.
- **Two keys, so a stolen server key can't drain the shop.** A hot refund key on the server ([`api/refund.ts`](app/api/refund.ts)) can only co-sign refunds the contract allows. A cold owner key administers the minter.
- **Wallets connect through WizardConnect.** The page builds the transaction ([`takeback.ts`](app/src/lib/takeback.ts)), the phone wallet signs its own inputs, and the minter input needs no signature for a purchase.
- **The books come from the chain.** Every purchase and refund spends a minter UTXO, so the page rebuilds sales, refunds and net from the minter's history ([`chain.ts`](app/src/lib/chain.ts)).
- **CashScript 0.14 on the 2026 VM.** The contract uses the loops from the May 2026 upgrade to check every other input and output for the shop's token category.

## Check it yourself

- The attack list and the code that runs it: [`evidence/attacks.json`](evidence/attacks.json), [`app/src/lib/attacks.ts`](app/src/lib/attacks.ts). Rerun with `cd app && npm install && node contracts/attacks.test.mjs`.
- Mainnet transactions: not yet. The demo shop goes on chain once its float is funded, and its minter address and transaction links will be listed here.

## Evidence

Evidence, stated plainly: no real users yet; it was built for this hackathon. Instead: our own break test of the refund rules, and test transactions from wallets we control once the shop is on mainnet. Each one reruns from the repo with one command.

> Claim: the receipt contract refuses rule-breaking purchases and refunds.
> Evidence type: Our own break test (we tried to make it fail), not real users.
> Data: 34 attacks and 3 valid cases written before the contract's final version ([`evidence/attacks.json`](evidence/attacks.json), committed in fb142c6), run on the BCH 2026 virtual machine.
> Result: 34 of 34 attacks rejected by the contract (95% interval 89.8% to 100.0%); 3 of 3 valid cases accepted.
> Rerun: `cd app && node contracts/attacks.test.mjs 1` at commit 0901f1e. Limits: we wrote the attacks ourselves; this runs on a local copy of the VM, not as mainnet broadcasts.

> Claim: the partial-refund path refuses rule-breaking partial refunds.
> Evidence type: Our own break test (we tried to make it fail), not real users.
> Data: a second, labelled list of 12 attacks and 3 valid cases ([`evidence/attacks-2.json`](evidence/attacks-2.json), committed in da8f0f3 before any run against the new path), BCH 2026 virtual machine.
> Result: 12 of 12 attacks rejected by the contract (95% interval 75.8% to 100.0%); 2 of 2 possible valid cases accepted (one valid case, a 1-sat refund, can't exist on chain: it's below the 546-sat dust limit).
> Rerun: `cd app && node contracts/attacks.test.mjs 2`. Limits: as above, and only 12 cases.

Limits, in numbers: zero real users and zero mainnet transactions so far; 34 attacks, all ours; the interval's low end is 89.8% because 34 cases can't rule out a rarer hole. The next real test is a mainnet purchase and refund from a wallet we control, which passes if the holder gets back exactly the receipt amount and the receipt is gone.

## What doesn't work yet

- The demo shop isn't on mainnet yet (waiting for its refund float).
- A remainder receipt from a partial refund can be refunded in full, but a second partial refund of it needs the holder to add a coin for the fee.
- Prices are in BCH only. PUSD-priced items are planned.
- The demo shop approves every valid refund automatically. A real shop would set its own policy.

## Run it locally

```bash
cd app && npm install && npm run dev
```

`./check.sh` runs the contract attack list, the purchase and refund flow test, the build, a browser walk of the demo path and a WizardConnect round trip.
