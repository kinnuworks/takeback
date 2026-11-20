// The BCMR registry for a shop's receipt category, with a parser so wallets that decode NFTs show
// "Amount paid" and "Order" instead of 16 raw bytes. Used by scripts/setup-shop.mjs (genesis) and
// scripts/update-bcmr.mjs (a later authchain update), and checked by contracts/bcmr-parse.test.mjs.
//
// Parse bytecode, run as input 1 of the spec's NFT parsing transaction (input 0 is the receipt):
//   OP_0 OP_TOALTSTACK              type "" (every receipt is one type)
//   OP_0 OP_UTXOTOKENCOMMITMENT     the receipt's 16 bytes
//   OP_8 OP_SPLIT OP_SWAP           [order, amount]
//   OP_BIN2NUM OP_TOALTSTACK        field 0: amount paid (sats)
//   OP_BIN2NUM OP_TOALTSTACK        field 1: order id
export const RECEIPT_PARSE_BYTECODE = "006b00cf587f7c816b816b";

export function receiptRegistry(opts: { category: string; shopName: string; site: string; at: string }) {
  const { category, shopName, site, at } = opts;
  return {
    $schema: "https://cashtokens.org/bcmr-v2.schema.json",
    version: { major: 1, minor: 1, patch: 0 },
    latestRevision: at,
    registryIdentity: { name: "Takeback receipts", description: "Receipts that refund. Each receipt NFT records the amount paid and an order id." },
    identities: {
      [category]: {
        [at]: {
          name: `Takeback receipt: ${shopName}`,
          description: `A refundable receipt from the ${shopName} demo shop. Hold it to get a refund of exactly the amount paid.`,
          token: {
            category,
            symbol: "RCPT",
            nfts: {
              description: "Receipt: amount paid (8 bytes) and order id (8 bytes).",
              fields: {
                amount: { name: "Amount paid", description: "What the receipt refunds, in satoshis.", encoding: { type: "number", aggregate: "add", unit: "sats" } },
                order: { name: "Order", description: "The shop's order id.", encoding: { type: "number" } },
              },
              parse: {
                bytecode: RECEIPT_PARSE_BYTECODE,
                types: { "": { name: "Takeback receipt", description: "Refundable: the shop refunds exactly the amount paid, once, to whoever holds it.", fields: ["amount", "order"] } },
              },
            },
          },
          uris: { icon: `${site}/receipt-icon.png`, web: site },
        },
      },
    },
  };
}
