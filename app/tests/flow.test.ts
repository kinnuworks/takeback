// End-to-end flow on the mock network, with the real wallet signing code path:
// purchase built by the app -> signed by the headless WizardConnect test wallet from the
// relay-safe object -> accepted by the VM -> refund built and co-signed by the refund key ->
// receipt input signed by the wallet -> accepted; holder gets exactly the receipt amount.
import { MockNetworkProvider, randomUtxo, randomNFT } from "cashscript";
import {
  secp256k1, hash160, binToHex, hexToBin, decodeTransactionBCH, sha256, createVirtualMachineBch2026,
  cashAddressToLockingBytecode,
} from "@bitauth/libauth";
import { buildPurchase, buildRefund, minterContract, relaySafe, p2pkhAddress, decodeReceipt, type ShopKeys } from "../src/lib/takeback.ts";
// @ts-expect-error plain JS module
import { makeKeys, signP2pkhInputs } from "../../tools/wiz-harness/testwallet.mjs";

let failures = 0;
const ok = (cond: boolean, name: string) => { console.log(cond ? "PASS" : "FAIL", name); if (!cond) failures++; };
const priv = (label: string) => sha256.hash(new TextEncoder().encode("flow:" + label));

const provider = new MockNetworkProvider();
const refundKey = priv("refund"), ownerKey = priv("owner"), merchantKey = priv("merchant");
const keys: ShopKeys = {
  merchantPkh: hash160(secp256k1.derivePublicKeyCompressed(merchantKey) as Uint8Array),
  refundPk: secp256k1.derivePublicKeyCompressed(refundKey) as Uint8Array,
  ownerPk: secp256k1.derivePublicKeyCompressed(ownerKey) as Uint8Array,
};
const minter = minterContract(keys, provider);
const lbHex = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === "string") throw new Error(r); return binToHex(r.bytecode); };

// The customer: an HD test wallet (the same code the headless WizardConnect wallet signs with).
const wallet = makeKeys("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "chipnet");
const custAddr: string = wallet.address(0, 0);
const coin = { ...randomUtxo({ satoshis: 60_000n }), lockingBytecode: lbHex(custAddr) };
provider.addUtxo(custAddr, coin);
const baton = { ...randomUtxo({ satoshis: 100_000n, token: randomNFT({ nft: { capability: "minting", commitment: "" } }) }), lockingBytecode: lbHex(minter.address) };
provider.addUtxo(minter.address, baton);

// 1. Purchase
const plan = buildPurchase({
  provider, keys, network: "chipnet", minterUtxo: baton,
  coins: [{ utxo: coin, address: custAddr, path: "receive", index: 0 }],
  amount: 10_000n, orderId: 42n, receiptTo: custAddr, changeTo: custAddr,
});
const wire = relaySafe({ transaction: plan.wc.transaction, sourceOutputs: plan.wc.sourceOutputs });
ok(JSON.stringify(wire).length > 0, "purchase request serialises for the relay");
const signedHex: string = signP2pkhInputs(wallet, wire, plan.inputPaths);
const tx = decodeTransactionBCH(hexToBin(signedHex));
if (typeof tx === "string") throw new Error(tx);
const vm = createVirtualMachineBch2026();
const sourceOutputs = plan.wc.sourceOutputs.map((o) => ({ lockingBytecode: o.lockingBytecode, valueSatoshis: o.valueSatoshis, token: o.token }));
const verdict = vm.verify({ sourceOutputs, transaction: tx });
ok(verdict === true, "wallet-signed purchase passes the BCH VM" + (verdict === true ? "" : `: ${verdict}`));
ok(tx.outputs[1].valueSatoshis === 10_000n, "merchant output is exactly 10,000 sats");
const receiptOut = tx.outputs[2];
ok(receiptOut.token?.nft?.capability === "none", "receipt is an immutable NFT");
const decoded = decodeReceipt(binToHex(receiptOut.token!.nft!.commitment));
ok(decoded?.amount === 10_000n && decoded?.orderId === 42n, "receipt says 10,000 sats, order 42");

// 2. Refund (the minter UTXO and receipt as they'd exist after the purchase)
const txid = binToHex(sha256.hash(sha256.hash(hexToBin(signedHex))).reverse());
const newBaton = { txid, vout: 0, satoshis: tx.outputs[0].valueSatoshis, token: baton.token, lockingBytecode: lbHex(minter.address) };
const receiptUtxo = {
  txid, vout: 2, satoshis: receiptOut.valueSatoshis, lockingBytecode: binToHex(receiptOut.lockingBytecode),
  token: { category: baton.token!.category, amount: 0n, nft: { capability: "none" as const, commitment: binToHex(receiptOut.token!.nft!.commitment) } },
};
const refund = buildRefund({ provider, keys, minterUtxo: newBaton, refundKey, receiptUtxo, holderAddress: custAddr });
const rwire = relaySafe({ transaction: refund.wc.transaction, sourceOutputs: refund.wc.sourceOutputs });
const rsigned: string = signP2pkhInputs(wallet, rwire, [[1, "receive", 0]]);
const rtx = decodeTransactionBCH(hexToBin(rsigned));
if (typeof rtx === "string") throw new Error(rtx);
const rsources = refund.wc.sourceOutputs.map((o) => ({ lockingBytecode: o.lockingBytecode, valueSatoshis: o.valueSatoshis, token: o.token }));
const rverdict = vm.verify({ sourceOutputs: rsources, transaction: rtx });
ok(rverdict === true, "refund co-signed by the refund key and the holder passes the BCH VM" + (rverdict === true ? "" : `: ${rverdict}`));
ok(rtx.outputs[1].valueSatoshis === 10_000n, "holder gets exactly 10,000 sats back");
ok(rtx.outputs.slice(1).every((o) => !o.token), "receipt is burned (no token after the minter)");
ok(p2pkhAddress(keys.merchantPkh, "chipnet").startsWith("bchtest:"), "merchant address derives");

// 3. Partial refund of 4,000 from the same 10,000 receipt (as if the full refund hadn't happened)
const part = buildRefund({ provider, keys, minterUtxo: newBaton, refundKey, receiptUtxo, holderAddress: custAddr, refundAmount: 4_000n });
const pwire = relaySafe({ transaction: part.wc.transaction, sourceOutputs: part.wc.sourceOutputs });
const psigned: string = signP2pkhInputs(wallet, pwire, [[1, "receive", 0]]);
const ptx = decodeTransactionBCH(hexToBin(psigned));
if (typeof ptx === "string") throw new Error(ptx);
const psources = part.wc.sourceOutputs.map((o) => ({ lockingBytecode: o.lockingBytecode, valueSatoshis: o.valueSatoshis, token: o.token }));
const pverdict = vm.verify({ sourceOutputs: psources, transaction: ptx });
ok(pverdict === true, "partial refund passes the BCH VM" + (pverdict === true ? "" : `: ${pverdict}`));
ok(ptx.outputs[1].valueSatoshis === 4_000n, "holder gets 4,000 back");
const rem = decodeReceipt(binToHex(ptx.outputs[2].token!.nft!.commitment));
ok(rem?.amount === 6_000n && rem?.orderId === 42n, "new receipt says 6,000 sats, same order 42");

console.log(failures === 0 ? "FLOW: ALL PASS" : `FLOW: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
