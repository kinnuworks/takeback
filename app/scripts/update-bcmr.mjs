// Publishes a new BCMR registry for a shop's receipt category by extending its authchain: the owner's
// cold key spends the authhead (the minter UTXO descended from the genesis transaction's output 0)
// through the contract's admin path, recreates it unchanged at output 0, and adds a BCMR OP_RETURN
// with the new registry's hash and URL. Writes the registry file the URL points to.
// Usage: node --env-file=../tools/wiz-harness/.env.local scripts/update-bcmr.mjs <chipnet|mainnet> [--send]
import { readFileSync, writeFileSync } from "node:fs";
import { ElectrumNetworkProvider, TransactionBuilder, SignatureTemplate } from "cashscript";
import { sha256, binToHex, hexToBin, utf8ToBin, cashAddressToLockingBytecode, decodeTransactionBCH } from "@bitauth/libauth";
import { makeKeys } from "../../tools/wiz-harness/testwallet.mjs";
import { minterContract } from "../src/lib/takeback.ts";
import { receiptRegistry } from "../src/lib/bcmr.ts";

const chain = process.argv[2];
if (!["chipnet", "mainnet"].includes(chain)) { console.error("network: chipnet | mainnet"); process.exit(2); }
const send = process.argv.includes("--send");
const SITE = process.env.TAKEBACK_SITE ?? "https://takeback-bch.vercel.app";
const shopPath = new URL(`../src/shop/${chain}.json`, import.meta.url);
const shop = JSON.parse(readFileSync(shopPath, "utf8"));
const k = makeKeys(process.env.TAKEBACK_MERCHANT_MNEMONIC, chain);
const provider = new ElectrumNetworkProvider(chain);
const keys = { merchantPkh: hexToBin(shop.merchantPkh), refundPk: hexToBin(shop.refundPk), ownerPk: hexToBin(shop.ownerPk) };
const minter = minterContract(keys, provider);
const lbHex = (a) => binToHex(cashAddressToLockingBytecode(a).bytecode);
const retry = async (f) => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 1500)); } } };

// Follow output 0 from the genesis transaction to the authhead.
const history = await retry(() => provider.performRequest("blockchain.address.get_history", shop.minterAddress));
const spentBy = new Map();
for (const h of history) {
  const tx = decodeTransactionBCH(hexToBin(await retry(() => provider.getRawTransaction(h.tx_hash))));
  for (const i of tx.inputs) spentBy.set(`${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`, h.tx_hash);
}
// libauth decodes outpoint hashes in the same byte order txids are written in.
let head = shop.genesisTxid, links = 0;
while (spentBy.has(`${head}:0`)) { head = spentBy.get(`${head}:0`); links++; }
const authhead = (await retry(() => provider.getUtxos(shop.minterAddress))).find((u) => u.txid === head && u.vout === 0);
if (!authhead) { console.error(`authhead ${head}:0 isn't an unspent minter UTXO`); process.exit(1); }
console.log(`authhead: ${head}:0 (${links} links after the genesis), ${authhead.satoshis} sats`);

const registry = receiptRegistry({ category: shop.category, shopName: shop.name, site: SITE, at: new Date().toISOString() });
const registryJson = JSON.stringify(registry, null, 2);
const registryHash = binToHex(sha256.hash(utf8ToBin(registryJson)));
const REGISTRY_PATH = chain === "mainnet" ? ".well-known/bitcoin-cash-metadata-registry.json" : `bcmr-${chain}.json`;
const registryUrl = `${SITE.replace(/^https:\/\//, "")}/${REGISTRY_PATH}`;

const merchant = shop.merchantAddress;
const fee = (await retry(() => provider.getUtxos(merchant))).filter((u) => !u.token && u.satoshis >= 3_000n).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
if (!fee) { console.error("the merchant needs a 3,000+ sat coin for the fee"); process.exit(1); }
const tb = new TransactionBuilder({ provider })
  .addInput({ ...authhead, lockingBytecode: lbHex(shop.minterAddress) }, minter.unlock.admin(new SignatureTemplate(k.node(0, 2).privateKey)))
  .addInput({ ...fee, lockingBytecode: lbHex(merchant) }, new SignatureTemplate(k.node(0, 0).privateKey).unlockP2PKH())
  .addOutput({ to: minter.tokenAddress, amount: authhead.satoshis, token: authhead.token })
  .addOpReturnOutput(["BCMR", "0x" + registryHash, registryUrl])
  .addOutput({ to: merchant, amount: fee.satoshis - 1_500n });
if (!send) { tb.build(); console.log(`dry run: registry ${registryHash.slice(0, 12)}…, built the authchain update; rerun with --send`); process.exit(0); }
const sent = await tb.send();
writeFileSync(new URL(`../public/${REGISTRY_PATH}`, import.meta.url), registryJson);
writeFileSync(shopPath, JSON.stringify({ ...shop, bcmrHash: registryHash, bcmrUpdateTxid: sent.txid }, null, 2) + "\n");
console.log("authchain update broadcast:", sent.txid, "registry hash", registryHash);
process.exit(0);
