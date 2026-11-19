// Prototype check for refund receipts on the mock network: pay + mint in one tx, refund
// forced to equal the receipt amount; underpaying the merchant and over-refunding fail.
import { compileFile } from "cashc";
import { Contract, MockNetworkProvider, TransactionBuilder, randomUtxo, randomNFT, SignatureTemplate } from "cashscript";
import { cashAddressToLockingBytecode, binToHex, secp256k1, encodeLockingBytecodeP2pkh, hash160, lockingBytecodeToCashAddress, generateRandomBytes, bigIntToVmNumber } from "@bitauth/libauth";

const provider = new MockNetworkProvider();
const key = () => { const p = generateRandomBytes(32); const pub = secp256k1.derivePublicKeyCompressed(p); const lb = encodeLockingBytecodeP2pkh(hash160(pub));
  return { sig: new SignatureTemplate(p), pub, lb, addr: lockingBytecodeToCashAddress({ bytecode: lb, prefix: "bchtest", tokenSupport: true }).address }; };
const merchant = key(), customer = key();
const minter = new Contract(compileFile(new URL("./Receipt.cash", import.meta.url)), [hash160(merchant.pub), merchant.pub], { provider });
const lbHex = (a) => binToHex(cashAddressToLockingBytecode(a).bytecode);
const withLb = (u, a) => ({ ...u, lockingBytecode: lbHex(a) });

const baton = withLb(randomUtxo({ satoshis: 50_000n, token: randomNFT({ nft: { capability: "minting", commitment: "" } }) }), minter.address);
const category = baton.token.category;
provider.addUtxo(minter.address, baton);
const custCoins = withLb(randomUtxo({ satoshis: 20_000n }), customer.addr);
provider.addUtxo(customer.addr, custCoins);

const num8 = (n) => { const b = new Uint8Array(8); const v = bigIntToVmNumber(n); b.set(v); return b; };
const commitment = (amount, order) => binToHex(new Uint8Array([...num8(amount), ...num8(order)]));

function check(name, fn, expectOk) {
  try { fn(); console.log(expectOk ? "PASS" : "FAIL", name); return expectOk; }
  catch (e) { console.log(expectOk ? "FAIL" : "PASS", name, expectOk ? String(e.message).split("\n")[0] : "(rejected as expected)"); return !expectOk; }
}
const payTx = (merchantGets) => new TransactionBuilder({ provider })
  .addInput(baton, minter.unlock.pay())
  .addInput(custCoins, customer.sig.unlockP2PKH())
  .addOutput({ to: minter.tokenAddress, amount: 50_000n, token: { category, amount: 0n, nft: { capability: "minting", commitment: "" } } })
  .addOutput({ to: merchant.addr, amount: merchantGets })
  .addOutput({ to: customer.addr, amount: 1_000n, token: { category, amount: 0n, nft: { capability: "none", commitment: commitment(5_000n, 1n) } } })
  .addOutput({ to: customer.addr, amount: 13_000n });

let ok = true;
ok &= check("pay 5,000 sats and mint receipt in one tx", () => payTx(5_000n).debug(), true);
ok &= check("underpay merchant (4,000) with a 5,000 receipt", () => payTx(4_000n).debug(), false);

const receipt = withLb(randomUtxo({ satoshis: 1_000n, token: { category, amount: 0n, nft: { capability: "none", commitment: commitment(5_000n, 1n) } } }), customer.addr);
provider.addUtxo(customer.addr, receipt);
const refundTx = (amount) => new TransactionBuilder({ provider })
  .addInput(baton, minter.unlock.refund(merchant.sig, 1n, lbHex(customer.addr)))
  .addInput(receipt, customer.sig.unlockP2PKH())
  .addOutput({ to: minter.tokenAddress, amount: 50_000n - amount, token: { category, amount: 0n, nft: { capability: "minting", commitment: "" } } })
  .addOutput({ to: customer.addr, amount: amount + 500n - 500n });
ok &= check("refund exactly 5,000 and burn the receipt", () => refundTx(5_000n).debug(), true);
ok &= check("refund 9,000 against a 5,000 receipt", () => refundTx(9_000n).debug(), false);
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
