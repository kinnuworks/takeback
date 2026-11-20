# Takeback

Pay with Bitcoin Cash, get a receipt that refunds. Every purchase puts a receipt token in the buyer's wallet in the same transaction, and the shop can refund exactly what's on that receipt, to whoever holds it, once.

It needs Bitcoin Cash because the receipt is a CashToken minted by a covenant inside the payment itself, and the refund rules live in that covenant, so neither the shop's server nor the customer can bend them.

**Live demo:** https://takeback-bch.vercel.app

![Try it now: a demo wallet gets test coins, buys a coffee, gets a receipt, refunds it](docs/demo.gif)

**Try it in 30 seconds**
1. Open https://takeback-bch.vercel.app/?net=chipnet and press **Try it now, no wallet needed**. A demo wallet is made in your browser and gets free test coins (chipnet, the test network).
2. Buy a coffee from the Kopi Blaze demo shop. The receipt shows up under **Your receipts**.
3. Press **Refund**. The same amount comes back, the receipt burns, and the page shows how many seconds it took.
4. Press **Send 5 cheats to chipnet** and watch a real node refuse each one.
5. With a phone wallet: open the live link, press **Connect wallet**, scan with Paytaca or Selene (WizardConnect), and do the same with real BCH.

## How it uses Bitcoin Cash

- **The receipt is minted inside the payment.** [`ReceiptMinter.cash`](app/contracts/ReceiptMinter.cash) holds the shop's minting token. Its `pay` path only lets a purchase through if output 1 pays the merchant exactly the amount written into the receipt NFT at output 2, and if no other output carries the shop's token category.
- **Refunds follow the receipt, not an address the customer types.** The `refund` path pays exactly the receipt's amount to the address that held the receipt, and the receipt is burned in the same transaction. A second refund of the same receipt has nothing to spend.
- **Partial refunds keep the rest owed.** The `partialRefund` path pays part of the receipt and, in the same transaction, gives the holder a new receipt for exactly the remainder with the same order id.
- **Two keys, so a stolen server key can't drain the shop.** A hot refund key on the server ([`api/refund.ts`](app/api/refund.ts)) can only co-sign refunds the contract allows. A cold owner key administers the minter.
- **Wallets connect through WizardConnect.** The page builds the transaction ([`takeback.ts`](app/src/lib/takeback.ts)), the phone wallet signs its own inputs, and the minter input needs no signature for a purchase. The no-wallet demo signs the same transactions in the browser ([`burner.ts`](app/src/lib/burner.ts)).
- **The books come from the chain.** Every purchase and refund spends a minter UTXO, so the page rebuilds sales, refunds and net from the minter's history ([`chain.ts`](app/src/lib/chain.ts)).
- **CashScript 0.14 on the 2026 VM.** The contract uses the loops from the May 2026 upgrade to check every other input and output for the shop's token category.

The heart of the purchase rule, from [`ReceiptMinter.cash`](app/contracts/ReceiptMinter.cash):

```solidity
bytes receipt = tx.outputs[2].nftCommitment;          // the receipt minted in this payment
require(receipt.length == 16);
int amount = int(receipt.split(8)[0]);                // the amount written on it
require(amount > 0);
require(tx.outputs[1].lockingBytecode == new LockingBytecodeP2PKH(merchantPkh));
require(tx.outputs[1].value == amount);               // the shop got exactly that amount
```

## Check it yourself

[![proof](https://github.com/kinnuworks/takeback/actions/workflows/proof.yml/badge.svg)](https://github.com/kinnuworks/takeback/actions/workflows/proof.yml) GitHub reruns the attack lists, the fuzzer, the mutation test and the flow test on every push ([`.github/workflows/proof.yml`](.github/workflows/proof.yml)).

No keys or test coins are needed for any of these: from a fresh clone, `cd app && npm install`, then the commands below.

- **Real nodes:** every attack below, built from the shop's real chipnet coins and signed with real keys, sent to two chipnet servers. Each node reply and signed transaction is in [`evidence/real-node-chipnet.json`](evidence/real-node-chipnet.json). Check them yourself with no keys: `cd app && node scripts/real-attacks.mjs chipnet --verify` fetches the real coins each saved transaction spent and reruns it on the BCH 2026 VM (56 of 56 attacks refused, 5 of 5 honest transactions verify). `--replay` rebroadcasts them, but once the shop's coins have moved on, a node answers "missing inputs" before it runs the contract.
- **The attack lists** and the code that runs them: [`evidence/attacks.json`](evidence/attacks.json), [`attacks-2.json`](evidence/attacks-2.json), [`attacks-3.json`](evidence/attacks-3.json), [`attacks-4.json`](evidence/attacks-4.json), [`app/src/lib/attacks.ts`](app/src/lib/attacks.ts). Rerun: `cd app && npm install && node contracts/attacks.test.mjs 1` (and `2`, `3`, `4`).
- **The fuzzer:** [`app/src/lib/fuzz.ts`](app/src/lib/fuzz.ts) and the model of the rules it checks against, [`rules-model.ts`](app/src/lib/rules-model.ts). Rerun: `cd app && node contracts/fuzz.test.mjs 20000 20261122`.
- **The mutation test:** [`app/contracts/mutants.test.mjs`](app/contracts/mutants.test.mjs), results in [`evidence/mutants-result.json`](evidence/mutants-result.json).
- **Chipnet shop (contract v2):** [shop setup](https://chipnet.imaginary.cash/tx/13f39d1ae6350b3b4a15250b9e77af965101942bd28a42944ce3b6769e64d081). Open https://takeback-bch.vercel.app/?net=chipnet to see its books rebuilt from the chain.
- **The receipt token on an independent explorer:** [tokenexplorer.cash](https://tokenexplorer.cash/?tokenId=ebef9a8f0693ed7d8f765d8f537cfcc920b5e9a6668423d5c5265781bf9c7dd3&network=chipnet) shows the name, icon and parsable receipt fields (amount paid, order id), and checks that the metadata matches its hash on chain. The registry was updated through the shop's authchain ([update](https://chipnet.imaginary.cash/tx/838b952e31274db008df1311f0875ca1e5e9eaf7bf4c30370c841b5a691f93f8)).
- **Mainnet:** not yet. The mainnet shop goes on chain once its float is funded.

## Evidence

Evidence, stated plainly: no real users yet; it was built for this hackathon. Instead: our own break test of the refund rules (written attack lists, a fuzzer and a mutation test), and test transactions from wallets we control on chipnet, including every attack sent to real nodes. Each one reruns from the repo with one command.

> Claim: real Bitcoin Cash nodes refuse every attack on the receipt contract, not only our local copy of the VM.
> Evidence type: Test transactions from wallets we control (chipnet, no monetary value), not real users.
> Data: lists 1 to 4 (56 attacks), built from the shop's real chipnet coins and signed with real keys, the shop's hot refund key included; sent to chipnet.bch.ninja and chipnet.imaginary.cash on 2026-11-20.
> Result: 56 of 56 refused by both servers (55 by the contract, 1 by consensus token rules; 95% interval 93.6% to 100.0%); 5 of 5 honest purchases and refunds accepted in the same run.
> Rerun: the keyless `--verify` above, or a fresh run with your own chipnet test wallets (`scripts/real-attacks.mjs chipnet` reads the seeds from an env file). Limits: chipnet, not mainnet; the attacks are ours.

> Claim: random rule-breaking transactions are refused and allowed ones go through.
> Evidence type: Our own break test (we tried to make it fail), not real users.
> Data: 20,000 transactions from seed 20261122 (fixed in [`evidence/EVAL_PLAN.md`](evidence/EVAL_PLAN.md) before the run), each a valid purchase, refund or partial refund with one to three random changes, judged by the BCH 2026 VM and by a separate model of our written rules.
> Result: on contract v1 the fuzzer found one kind of gap, 333 cases where a purchase or refund could rewrite the shop's own minting token (no money at risk); we fixed it in v2. On v2: 18,714 of 18,714 rule-breaking transactions refused (95% interval 99.98% to 100%), 1,286 of 1,286 allowed ones accepted, zero disagreements.
> Rerun: `cd app && node contracts/fuzz.test.mjs 20000 20261122`. Limits: the model of the rules is written by the same team as the contract, so a misunderstanding we share wouldn't show.

> Claim: the receipt contract refuses rule-breaking purchases and refunds.
> Evidence type: Our own break test (we tried to make it fail), not real users.
> Data: 34 attacks and 3 valid cases written before the contract's final version ([`evidence/attacks.json`](evidence/attacks.json), committed in fb142c6), plus three labelled lists added later: 12 partial-refund attacks, 4 found by the fuzzer, 6 found by the mutation test.
> Result: 56 of 56 attacks rejected by the contract (95% interval 93.6% to 100.0%); every valid case accepted.
> Rerun: `cd app && node contracts/attacks.test.mjs 1` (and `2`, `3`, `4`). Limits: we wrote the attacks ourselves.

> Claim: every check in the contract that guards money is needed.
> Evidence type: Our own break test (we tried to make it fail), not real users.
> Data: each of the contract's 52 checks deleted one at a time (48 mutants compile), each mutant run against the attack lists and 5,000 fuzz cases.
> Result: 36 of 48 mutants let an attack through, so a test catches each of those deletions. The other 12 are checks another rule or consensus already covers, listed with the reason on the live page. The first run showed three input-order checks no test covered; list 4 now covers them.
> Rerun: `cd app && node contracts/mutants.test.mjs`. Limits: it deletes whole checks only.

Limits, in numbers: zero real users and zero mainnet transactions so far; all chipnet transactions come from our own wallets and from visitors' demo wallets with test coins; 56 hand-written attacks; the fuzzer's model shares our understanding of the rules. The next real test is a mainnet purchase and refund from a wallet we control, which passes if the holder gets back exactly the receipt amount and the receipt is gone.

## What doesn't work yet

- The demo shop runs on chipnet (the test network). It isn't on mainnet yet (waiting for its refund float).
- A remainder receipt from a partial refund can be refunded in full, but a second partial refund of it needs the holder to add a coin for the fee.
- Prices are in BCH only. PUSD-priced items are planned.
- The demo shop approves every valid refund automatically. A real shop would set its own policy.

## Run it locally

```bash
cd app && npm install && npm run dev
```

The purchase-and-refund flow test also uses the headless test wallet in `tools/wiz-harness`: run `npm install` there too.

`./check.sh` runs the four attack lists, the 20,000-case fuzzer, the purchase and refund flow test, the build, a browser walk of the demo path and a WizardConnect round trip.
