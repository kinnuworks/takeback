// Tops up the shop's refund float: the owner's cold key spends every minter UTXO through the admin
// path and recreates each one (same script, same minting token) with more BCH, paid from a funding
// wallet. Output 0 stays a minter, so the BCMR authchain carries on unchanged. Purchases pay the
// merchant, never the float, so a busy demo shop needs this now and then.
// Usage: node --env-file=../tools/wiz-harness/.env.local scripts/top-up-float.mjs <chipnet|mainnet> <sats per minter> [--from faucet|merchant] [--send]
//        node scripts/top-up-float.mjs <chipnet|mainnet> --check   (no keys: fails if the float is under 100,000 sats)
import { readFileSync } from "node:fs";
import { ElectrumNetworkProvider, TransactionBuilder, SignatureTemplate } from "cashscript";
import { binToHex, hexToBin, cashAddressToLockingBytecode, sha256, utf8ToBin, secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress } from "@bitauth/libauth";
import { minterContract, isMinterUtxo } from "../src/lib/takeback.ts";

const chain = process.argv[2];
if (!["chipnet", "mainnet"].includes(chain)) { console.error("network: chipnet | mainnet"); process.exit(2); }
const shop = JSON.parse(readFileSync(new URL(`../src/shop/${chain}.json`, import.meta.url), "utf8"));
const provider = new ElectrumNetworkProvider(chain);
const lbHex = (a) => binToHex(cashAddressToLockingBytecode(a).bytecode);
const minters = (await provider.getUtxos(shop.minterAddress)).filter((u) => isMinterUtxo(u) && u.token.category === shop.category);
const float = minters.reduce((s, u) => s + u.satoshis, 0n);
console.log(`${chain} float: ${float.toLocaleString()} sats in ${minters.length} minters (${minters.map((m) => m.satoshis.toLocaleString()).join(", ")})`);
if (process.argv.includes("--check")) process.exit(float >= 100_000n ? 0 : 1);

const per = BigInt(process.argv[3] ?? "0");
if (per <= 0n) { console.error("give the sats to add per minter"); process.exit(2); }
const { makeKeys } = await import("../../tools/wiz-harness/testwallet.mjs");
const k = makeKeys(process.env.TAKEBACK_MERCHANT_MNEMONIC, chain);
const from = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : "merchant";
let fundPriv;
if (from === "faucet") {
  if (chain !== "chipnet") { console.error("the faucet is chipnet only"); process.exit(2); }
  fundPriv = sha256.hash(utf8ToBin(`takeback-chipnet-faucet:${binToHex(k.node(0, 1).privateKey)}`));
} else fundPriv = k.node(0, 0).privateKey;
const fundAddr = lockingBytecodeToCashAddress({ bytecode: encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(fundPriv))), prefix: chain === "mainnet" ? "bitcoincash" : "bchtest" }).address;
const coins = (await provider.getUtxos(fundAddr)).filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
const need = per * BigInt(minters.length) + 3_000n;
const picked = []; let have = 0n;
for (const c of coins) { if (have >= need) break; picked.push(c); have += c.satoshis; }
if (have < need) { console.error(`${from} wallet ${fundAddr} has ${have} sats, needs ${need}`); process.exit(1); }

const keys = { merchantPkh: hexToBin(shop.merchantPkh), refundPk: hexToBin(shop.refundPk), ownerPk: hexToBin(shop.ownerPk) };
const minter = minterContract(keys, provider);
const owner = new SignatureTemplate(k.node(0, 2).privateKey), fund = new SignatureTemplate(fundPriv);
const tb = new TransactionBuilder({ provider });
for (const m of minters) tb.addInput({ ...m, lockingBytecode: lbHex(shop.minterAddress) }, minter.unlock.admin(owner));
for (const c of picked) tb.addInput({ ...c, lockingBytecode: lbHex(fundAddr) }, fund.unlockP2PKH());
for (const m of minters) tb.addOutput({ to: minter.tokenAddress, amount: m.satoshis + per, token: m.token });
const fee = 600n + 900n * BigInt(minters.length) + 200n * BigInt(picked.length); // each admin input carries the whole contract
if (have - need + 3_000n - fee >= 546n) tb.addOutput({ to: fundAddr, amount: have - per * BigInt(minters.length) - fee });
if (!process.argv.includes("--send")) { tb.build(); console.log(`dry run: +${per} sats to each of ${minters.length} minters from the ${from} wallet; rerun with --send`); process.exit(0); }
console.log("float topped up:", (await tb.send()).txid);
process.exit(0);
