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
const NEED = MINTERS * (FLOAT + 1000n) + 5000n;
const plainCoins = async () => (await provider.getUtxos(merchantAddr)).filter((u) => !u.token).map((u) => ({ ...u, lockingBytecode: lbHex(merchantAddr) }));
let coins = await plainCoins();
let genesisCoin = coins.find((u) => u.vout === 0 && u.satoshis >= NEED);
if (!genesisCoin) {
  // Faucets and exchanges rarely pay to output 0. With --send, sweep the merchant's own coins into
  // one output-0 coin at the same address first (a self-send; nothing leaves the merchant wallet).
  const total = coins.reduce((s, u) => s + u.satoshis, 0n);
  const SWEEP_FEE = 200n + 150n * BigInt(coins.length);
  if (!send || total - SWEEP_FEE < NEED) {
    console.error(`No vout-0 coin of at least ${NEED} sats at ${merchantAddr} (wallet holds ${total} sats in ${coins.length} coins).${total - SWEEP_FEE >= NEED ? " Rerun with --send to self-send one first." : " Fund it first."}`);
    process.exit(1);
  }
  const sweep = new TransactionBuilder({ provider });
  for (const c of coins) sweep.addInput(c, new SignatureTemplate(priv(0)).unlockP2PKH());
  sweep.addOutput({ to: merchantAddr, amount: total - SWEEP_FEE });
  const swept = await sweep.send();
  console.log("self-send to make an output-0 coin:", swept.txid);
  for (let i = 0; i < 20 && !genesisCoin; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    coins = await plainCoins();
    genesisCoin = coins.find((u) => u.txid === swept.txid && u.vout === 0);
  }
  if (!genesisCoin) { console.error("self-send broadcast but not seen yet; rerun in a minute."); process.exit(1); }
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
const REGISTRY_PATH = chain === "mainnet" ? ".well-known/bitcoin-cash-metadata-registry.json" : `bcmr-${chain}.json`;
const registryUrl = `${SITE.replace(/^https:\/\//, "")}/${REGISTRY_PATH}`;

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
writeFileSync(`public/${REGISTRY_PATH}`, registryJson);
console.log("genesis broadcast:", sent.txid);
process.exit(0);
