// Creates a Takeback shop on chain, once, from the merchant seed in TAKEBACK_MERCHANT_MNEMONIC.
// Keys (m/44'/145'/0'/0/i): i=0 merchant payout and funding, i=1 hot refund key (goes to the
// server), i=2 cold owner key (stays here). The genesis transaction spends a vout-0 coin of the
// merchant, which fixes the receipt category (= that coin's txid), creates N minter UTXOs (each a
// minting NFT plus a refund float) and publishes the BCMR registry hash and URL in an OP_RETURN.
//
// Usage: node --env-file=../tools/wiz-harness/.env.local scripts/setup-shop.mjs <mainnet|chipnet|mock> [--send]
// Without --send it builds and checks everything and prints the plan; nothing is broadcast.
import { writeFileSync, mkdirSync } from "node:fs";
import { ElectrumNetworkProvider, MockNetworkProvider, TransactionBuilder, SignatureTemplate, randomUtxo } from "cashscript";
import { sha256, binToHex, utf8ToBin, cashAddressToLockingBytecode } from "@bitauth/libauth";
import { makeKeys } from "../../tools/wiz-harness/testwallet.mjs";
import { minterContract, p2pkhAddress } from "../src/lib/takeback.ts";

const network = process.argv[2];
const send = process.argv.includes("--send");
const SITE = process.env.TAKEBACK_SITE ?? "https://takeback-bch.vercel.app";
const MINTERS = 3n, FLOAT = 100_000n;
if (!["mainnet", "chipnet", "mock"].includes(network)) { console.error("network: mainnet | chipnet | mock"); process.exit(2); }
const mnemonic = process.env.TAKEBACK_MERCHANT_MNEMONIC;
if (!mnemonic) { console.error("TAKEBACK_MERCHANT_MNEMONIC missing"); process.exit(2); }

const chain = network === "mock" ? "chipnet" : network;
const k = makeKeys(mnemonic, chain);
const priv = (i) => k.node(0, i).privateKey;
const pub = (i) => k.pub(0, i);
const keys = { merchantPkh: (await import("@bitauth/libauth")).hash160(pub(0)), refundPk: pub(1), ownerPk: pub(2) };
const provider = network === "mock" ? new MockNetworkProvider() : new ElectrumNetworkProvider(chain);
const merchantAddr = p2pkhAddress(keys.merchantPkh, chain);
const lbHex = (a) => binToHex(cashAddressToLockingBytecode(a).bytecode);
if (network === "mock") provider.addUtxo(merchantAddr, { ...randomUtxo({ satoshis: 500_000n }), vout: 0, lockingBytecode: lbHex(merchantAddr) });

const minter = minterContract(keys, provider);
const coins = (await provider.getUtxos(merchantAddr)).filter((u) => !u.token).map((u) => ({ ...u, lockingBytecode: lbHex(merchantAddr) }));
const genesisCoin = coins.find((u) => u.vout === 0 && u.satoshis >= MINTERS * (FLOAT + 1000n) + 5000n);
if (!genesisCoin) {
  console.error(`No vout-0 coin of at least ${MINTERS * (FLOAT + 1000n) + 5000n} sats at ${merchantAddr}. Fund it (or self-send to make a vout-0 coin) first.`);
  process.exit(1);
}
const category = genesisCoin.txid;

// BCMR registry for the receipt category. Wallets read the hash and URL from the OP_RETURN.
const registry = {
  $schema: "https://cashtokens.org/bcmr-v2.schema.json",
  version: { major: 1, minor: 0, patch: 0 },
  latestRevision: new Date().toISOString(),
  registryIdentity: { name: "Takeback receipts", description: "Receipts that refund. Each receipt NFT records the amount paid and an order id." },
  identities: {
    [category]: {
      [new Date().toISOString()]: {
        name: "Takeback receipt: Kopi Blaze",
        description: "A refundable receipt from the Kopi Blaze demo shop. Hold it to get a refund of exactly the amount paid.",
        token: {
          category, symbol: "RCPT",
          nfts: {
            description: "Receipt: amount paid (8 bytes) and order id (8 bytes).",
            parse: { types: { "": { name: "Takeback receipt", description: "Refundable receipt" } }, bytecode: "" },
          },
        },
        uris: { icon: `${SITE}/receipt-icon.png`, web: SITE },
      },
    },
  },
};
const registryJson = JSON.stringify(registry, null, 2);
const registryHash = binToHex(sha256.hash(utf8ToBin(registryJson)));
const registryUrl = `${SITE.replace(/^https:\/\//, "")}/.well-known/bitcoin-cash-metadata-registry.json`;

const tb = new TransactionBuilder({ provider }).addInput(genesisCoin, new SignatureTemplate(priv(0)).unlockP2PKH());
for (let i = 0n; i < MINTERS; i++) {
  tb.addOutput({ to: minter.tokenAddress, amount: FLOAT, token: { category, amount: 0n, nft: { capability: "minting", commitment: "" } } });
}
tb.addOpReturnOutput(["BCMR", "0x" + registryHash, registryUrl]);
tb.addBchChangeOutputIfNeeded({ to: merchantAddr, feeRate: 1.0 });

const shop = {
  network: chain, name: "Kopi Blaze", category, minterAddress: minter.address, minterTokenAddress: minter.tokenAddress,
  merchantAddress: merchantAddr, merchantPkh: binToHex(keys.merchantPkh), refundPk: binToHex(keys.refundPk), ownerPk: binToHex(keys.ownerPk),
  minters: Number(MINTERS), floatEach: FLOAT.toString(), bcmrUrl: `https://${registryUrl}`, bcmrHash: registryHash,
};
console.log(JSON.stringify(shop, null, 2));

if (network === "mock") {
  const r = tb.debug();
  console.log("mock genesis accepted by the VM:", Array.isArray(r) || typeof r === "object" ? "yes" : r);
  process.exit(0);
}
if (!send) { console.log("dry run: built the genesis transaction; rerun with --send to broadcast."); process.exit(0); }
const sent = await tb.send();
shop.genesisTxid = sent.txid;
mkdirSync("src/shop", { recursive: true });
writeFileSync(`src/shop/${chain}.json`, JSON.stringify(shop, null, 2) + "\n");
mkdirSync("public/.well-known", { recursive: true });
writeFileSync("public/.well-known/bitcoin-cash-metadata-registry.json", registryJson);
console.log("genesis broadcast:", sent.txid);
process.exit(0);
