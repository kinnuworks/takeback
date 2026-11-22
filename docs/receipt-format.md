# Takeback receipt format, version 1

This page is for wallet developers. It describes what a Takeback receipt is on chain, how to read it, and how a wallet could offer a Refund button for it. Everything here is what the live demo shop does today, except the last section, which is a proposal.

## What a receipt is

- An **immutable CashTokens NFT** (capability `none`) of the shop's token category. The category is the shop's own: one category per shop, created when the shop is set up.
- It is minted by the shop's `ReceiptMinter` covenant ([`app/contracts/ReceiptMinter.cash`](../app/contracts/ReceiptMinter.cash)) at **output 2 of the payment itself**. The same transaction must pay the merchant exactly the receipt's amount at output 1, or the covenant refuses it.

## The commitment (16 bytes)

| Bytes | Field | Encoding |
|---|---|---|
| 0-7 | Amount paid, in satoshis | VM number, little-endian, padded with zero bytes to 8 bytes (read it the way `OP_BIN2NUM` does) |
| 8-15 | Order id | same encoding |

Example: a 10,000-sat receipt for order 42 is `1027000000000000` `2a00000000000000`.

Read each half as `OP_BIN2NUM` would: strip the zero padding but keep the byte that holds the sign. A naive "trim trailing zeros" gets amounts like 40,000 sats (`409c000000000000`) wrong. [`decodeReceipt`](../app/src/lib/takeback.ts) does it right, and [`tests/decode.test.mjs`](../app/tests/decode.test.mjs) checks 68 round trips.

## Metadata (BCMR)

Each shop publishes a BCMR registry through its authchain (the genesis transaction carries the first `BCMR` OP_RETURN; updates spend the authhead through the owner's admin path). The registry gives:

- the name (for example "Takeback receipt: Kopi Blaze"), a description and an icon;
- a parser for the commitment: `token.nfts.parse.bytecode` = `006b00cf587f7c816b816b`, one type `""`, and two fields, `amount` ("Amount paid", number, sats) and `order` ("Order", number).

The bytecode is `OP_0 OP_TOALTSTACK OP_0 OP_UTXOTOKENCOMMITMENT OP_8 OP_SPLIT OP_SWAP OP_BIN2NUM OP_TOALTSTACK OP_BIN2NUM OP_TOALTSTACK`. [`contracts/bcmr-parse.test.mjs`](../app/contracts/bcmr-parse.test.mjs) runs it in the BCMR spec's parsing transaction on the BCH 2026 VM. tokenexplorer.cash already shows the demo shop's receipts with their name, icon and parsed fields.

## The rules a wallet can rely on

The covenant enforces these, whoever asks:

- A receipt only exists if the merchant was paid exactly its amount in the same transaction.
- A refund pays exactly the receipt's amount (or a part of it) to the address that holds the receipt, and destroys the receipt in the same transaction, so it can't be refunded twice.
- A partial refund pays part and issues a new receipt for exactly the rest, with the same order id.
- The shop's hot refund key can only sign refunds the rules allow; it can't move the shop's money anywhere else.

## How a refund works today

1. The holder's wallet sends the receipt's outpoint and its own address to the shop's refund endpoint (the demo shop's is `POST https://takeback-bch.vercel.app/api/refund` with `{ txid, vout, holderAddress, network, amount? }`).
2. The shop answers with a WizardConnect transaction object that spends one of its minter coins (already signed by the hot refund key) and the receipt.
3. Before signing, the wallet checks that input 1 is the receipt and that output 1 pays its own address exactly the receipt's amount with no token. The page does this in [`checkRefundPlan`](../app/src/lib/burner.ts).
4. The wallet signs input 1 (the receipt) and broadcasts.

## Proposal: a Refund button in any wallet

A wallet that reads the BCMR parser above already knows a token is a Takeback receipt and how much it refunds. If shops also listed their refund endpoint in the registry, for example as `uris.refund`, any wallet could show **Refund 10,000 sats** on the receipt and run steps 1 to 4 itself, with no shop website involved. This field is not in the demo shop's registry yet; it is a proposal for discussion.
