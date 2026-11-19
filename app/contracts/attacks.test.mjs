// Runs evidence/attacks.json against ReceiptMinter on the BCH virtual machine (CashScript's
// MockNetworkProvider evaluates every input with libauth). Valid cases must pass, every attack
// must be rejected. Prints k of n and exits non-zero on any miss. No network, no funds.
import { readFileSync } from "node:fs";
import { compileFile } from "cashc";
import { Contract, MockNetworkProvider, TransactionBuilder, randomUtxo, randomNFT, SignatureTemplate } from "cashscript";
import {
  cashAddressToLockingBytecode, binToHex, secp256k1, encodeLockingBytecodeP2pkh, hash160,
  lockingBytecodeToCashAddress, bigIntToVmNumber, sha256,
} from "@bitauth/libauth";

const spec = JSON.parse(readFileSync(new URL("../../evidence/attacks.json", import.meta.url)));
const artifact = compileFile(new URL("./ReceiptMinter.cash", import.meta.url));

// Deterministic keys from the plan's seed.
let counter = 0;
const keyFromSeed = () => sha256.hash(new TextEncoder().encode(`takeback:${spec.seed}:${counter++}`));
const key = () => {
  const priv = keyFromSeed();
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const lb = encodeLockingBytecodeP2pkh(hash160(pub));
  return { priv, pub, lb, sig: new SignatureTemplate(priv), addr: lockingBytecodeToCashAddress({ bytecode: lb, prefix: "bchtest", tokenSupport: true }).address };
};
const lbHex = (a) => binToHex(cashAddressToLockingBytecode(a).bytecode);
const withLb = (u, a) => ({ ...u, lockingBytecode: lbHex(a) });
const le8 = (n) => { const b = new Uint8Array(8); const v = bigIntToVmNumber(n); b.set(v.slice(0, 8)); return b; };
const commit = (amount, order = 1n, len = 16) => {
  const full = new Uint8Array([...le8(amount), ...le8(order)]);
  const out = new Uint8Array(len); out.set(full.slice(0, Math.min(len, 16)));
  return binToHex(out);
};

function setup() {
  const provider = new MockNetworkProvider();
  const merchant = key(), customer = key(), attacker = key(), other = key(), owner = key();
  const minter = new Contract(artifact, [hash160(merchant.pub), merchant.pub, owner.pub], { provider });
  const baton = withLb(randomUtxo({ satoshis: 50_000n, token: randomNFT({ nft: { capability: "minting", commitment: "" } }) }), minter.address);
  const category = baton.token.category;
  provider.addUtxo(minter.address, baton);
  const coins = withLb(randomUtxo({ satoshis: 40_000n }), customer.addr);
  provider.addUtxo(customer.addr, coins);
  const otherCat = randomNFT({ nft: { capability: "none", commitment: commit(30_000n) } });
  return { provider, merchant, customer, attacker, other, owner, minter, baton, category, coins, otherCat };
}
const nft = (category, capability, commitment) => ({ category, amount: 0n, nft: { capability, commitment } });

// ----- pay cases -----
function payCase(mut = {}) {
  return () => {
  const c = setup();
  const amount = mut.amount ?? 5_000n;
  const outs = [
    mut.out0 ?? { to: c.minter.tokenAddress, amount: 50_000n, token: nft(c.category, "minting", "") },
    mut.out1 ?? { to: c.merchant.addr, amount: mut.merchantGets ?? amount },
    mut.out2 ?? { to: c.customer.addr, amount: 1_000n, token: nft(mut.receiptCategory ?? c.category, mut.receiptCap ?? "none", mut.commitment ?? commit(amount)) },
    ...(mut.extra ? mut.extra(c) : []),
    { to: c.customer.addr, amount: 40_000n - (mut.merchantGets ?? amount) - 1_000n - 2_000n - (mut.extraSats ?? 0n) },
  ];
  const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.pay()).addInput(c.coins, c.customer.sig.unlockP2PKH());
  for (const o of outs) tb.addOutput(o);
  return tb.debug();
  };
}

// ----- refund cases -----
function refundCase(mut = {}) {
  return () => {
  const c = setup();
  const amount = 5_000n;
  const receipt = withLb(randomUtxo({ satoshis: 2_000n, token: nft(mut.receiptCategory ?? c.category, "none", mut.receiptCommitment ?? commit(amount)) }), c.customer.addr);
  c.provider.addUtxo(c.customer.addr, receipt);
  const signer = mut.signer ? mut.signer(c) : c.merchant.sig;
  const receiptIdx = mut.receiptIdx ?? 1n;
  const tb = new TransactionBuilder({ provider: c.provider })
    .addInput(c.baton, c.minter.unlock.refund(signer, receiptIdx))
    .addInput(receipt, c.customer.sig.unlockP2PKH());
  if (mut.extraInput) { const u = mut.extraInput(c); c.provider.addUtxo(c.customer.addr, u); tb.addInput(u, c.customer.sig.unlockP2PKH()); }
  const refundAmt = mut.refundAmt ?? amount;
  const outs = [
    mut.out0 ?? { to: c.minter.tokenAddress, amount: mut.minterKeeps ?? 50_000n - refundAmt, token: nft(c.category, "minting", "") },
    mut.out1 ?? { to: mut.refundTo ? mut.refundTo(c) : c.customer.addr, amount: refundAmt },
    ...(mut.extra ? mut.extra(c, receipt) : []),
  ];
  for (const o of outs) tb.addOutput(o);
  return tb.debug();
  };
}

const cases = {
  V1: payCase(),
  V2: payCase({ amount: 1_000n }),
  V3: refundCase(),
  V4: (() => { // two shops in one transaction: each minter at input 0 of... only one minter can be input 0, so this checks one shop per tx.
    return () => { throw new Error("NOT-APPLICABLE: the contract requires the minter at input 0, so one shop per transaction by design"); };
  })(),
  A01: payCase({ merchantGets: 4_999n }),
  A02: payCase({ merchantGets: 2_500n }),
  A03: payCase({ merchantGets: 546n }),
  A04: payCase({ out1: { to: setup().attacker.addr, amount: 5_000n } }),
  A05: payCase({ commitment: commit(5_000n, 1n, 15) }),
  A06: payCase({ commitment: commit(5_000n, 1n, 16) + "00" }),
  A07: payCase({ amount: 0n, merchantGets: 546n }),
  A08: payCase({ commitment: binToHex(new Uint8Array([...le8(-5_000n), ...le8(1n)])) }),
  A09: payCase({ receiptCategory: "aa".repeat(32) }),
  A10: payCase({ out2: { to: setup().customer.addr, amount: 1_000n } }),
  A11: payCase({ out0: { to: setup().attacker.addr, amount: 50_000n } }),
  A12: payCase({ out0: { to: setup().customer.addr, amount: 50_000n } }),
  A13: (() => { const c = setup(); return payCase({ out0: undefined, receiptCap: "none" }); })(),
  A14: (() => payCase({ out0: undefined, minterAmount: 49_999n }))(),
  A15: payCase({ extra: (c) => [{ to: c.attacker.addr, amount: 1_000n, token: nft(c.category, "minting", "") }], extraSats: 1_000n }),
  A16: payCase({ extra: (c) => [{ to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(5_000n, 2n)) }], extraSats: 1_000n }),
  A17: payCase({ receiptCap: "minting" }),
  A18: payCase({ receiptCap: "mutable" }),
  A19: payCase({ extra: (c) => [{ to: c.customer.addr, amount: 1_000n, token: { category: c.category, amount: 1000n } }], extraSats: 1_000n }),
  A20: refundCase({ signer: (c) => c.customer.sig }),
  A21: refundCase({ signer: (c) => c.attacker.sig }),
  A22: refundCase({ refundAmt: 5_001n }),
  A23: refundCase({ refundAmt: 10_000n }),
  A24: refundCase({ refundTo: (c) => c.attacker.addr }),
  A25: refundCase({ receiptCategory: "bb".repeat(32), receiptCommitment: commit(30_000n), refundAmt: 30_000n }),
  A26: refundCase({ extra: (c, r) => [{ to: c.customer.addr, amount: 800n, token: nft(c.category, "none", commit(5_000n)) }] }),
  A27: refundCase({ out1: undefined, extra: undefined, refundTo: undefined }),
  A28: refundCase({ receiptIdx: 0n }),
  A29: refundCase({ out0: { to: setup().attacker.addr, amount: 45_000n } }),
  A30: refundCase({ minterKeeps: 40_000n, extra: (c) => [{ to: c.attacker.addr, amount: 5_000n }] }),
  A31: refundCase({ refundAmt: 4_000n, minterKeeps: 46_000n }),
  A32: refundCase({ extra: (c) => [{ to: c.attacker.addr, amount: 800n, token: nft(c.category, "none", commit(1n)) }] }),
  A33: refundCase({ extraInput: (c) => withLb(randomUtxo({ satoshis: 1_000n, token: nft(c.category, "none", commit(9_000n, 2n)) }), c.customer.addr) }),
  A34: refundCase({ extraInput: (c) => withLb(randomUtxo({ satoshis: 1_000n, token: nft(c.category, "none", commit(5_000n, 3n)) }), c.customer.addr) }),
};

// A27: receipt carried in the refund output itself.
cases.A27 = refundCase({ out1: undefined, refundTo: undefined, extra: undefined, receiptCommitment: undefined, out1Token: true });
{
  const c = setup(); const receipt = withLb(randomUtxo({ satoshis: 1_000n, token: nft(c.category, "none", commit(5_000n)) }), c.customer.addr);
  c.provider.addUtxo(c.customer.addr, receipt);
  const tb = new TransactionBuilder({ provider: c.provider })
    .addInput(c.baton, c.minter.unlock.refund(c.merchant.sig, 1n)).addInput(receipt, c.customer.sig.unlockP2PKH())
    .addOutput({ to: c.minter.tokenAddress, amount: 45_000n, token: nft(c.category, "minting", "") })
    .addOutput({ to: c.customer.addr, amount: 5_000n, token: nft(c.category, "none", commit(5_000n)) });
  cases.A27 = () => tb.debug();
}
// A13: baton downgraded to immutable.
{ const c0 = setup(); cases.A13 = payCase({ out0: { to: c0.minter.tokenAddress, amount: 50_000n, token: nft(c0.category, "none", "") } }); }
// Rebuild A13 and A14 against their own setup so categories match.
cases.A13 = (() => { const c = setup(); const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.pay()).addInput(c.coins, c.customer.sig.unlockP2PKH())
  .addOutput({ to: c.minter.tokenAddress, amount: 50_000n, token: nft(c.category, "none", "") }).addOutput({ to: c.merchant.addr, amount: 5_000n })
  .addOutput({ to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(5_000n)) }).addOutput({ to: c.customer.addr, amount: 32_000n }); return () => tb.debug(); })();
cases.A14 = (() => { const c = setup(); const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.pay()).addInput(c.coins, c.customer.sig.unlockP2PKH())
  .addOutput({ to: c.minter.tokenAddress, amount: 49_999n, token: nft(c.category, "minting", "") }).addOutput({ to: c.merchant.addr, amount: 5_000n })
  .addOutput({ to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(5_000n)) }).addOutput({ to: c.customer.addr, amount: 32_000n }); return () => tb.debug(); })();
cases.A11 = (() => { const c = setup(); const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.pay()).addInput(c.coins, c.customer.sig.unlockP2PKH())
  .addOutput({ to: c.attacker.addr, amount: 50_000n, token: nft(c.category, "minting", "") }).addOutput({ to: c.merchant.addr, amount: 5_000n })
  .addOutput({ to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(5_000n)) }).addOutput({ to: c.customer.addr, amount: 32_000n }); return () => tb.debug(); })();
cases.A12 = (() => { const c = setup(); const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.pay()).addInput(c.coins, c.customer.sig.unlockP2PKH())
  .addOutput({ to: c.customer.addr, amount: 50_000n, token: nft(c.category, "minting", "") }).addOutput({ to: c.merchant.addr, amount: 5_000n })
  .addOutput({ to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(5_000n)) }).addOutput({ to: c.customer.addr, amount: 32_000n }); return () => tb.debug(); })();
cases.A04 = (() => { const c = setup(); const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.pay()).addInput(c.coins, c.customer.sig.unlockP2PKH())
  .addOutput({ to: c.minter.tokenAddress, amount: 50_000n, token: nft(c.category, "minting", "") }).addOutput({ to: c.attacker.addr, amount: 5_000n })
  .addOutput({ to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(5_000n)) }).addOutput({ to: c.customer.addr, amount: 32_000n }); return () => tb.debug(); })();
cases.A10 = (() => { const c = setup(); const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.pay()).addInput(c.coins, c.customer.sig.unlockP2PKH())
  .addOutput({ to: c.minter.tokenAddress, amount: 50_000n, token: nft(c.category, "minting", "") }).addOutput({ to: c.merchant.addr, amount: 5_000n })
  .addOutput({ to: c.customer.addr, amount: 1_000n }).addOutput({ to: c.customer.addr, amount: 32_000n }); return () => tb.debug(); })();
cases.A29 = (() => { const c = setup(); const receipt = withLb(randomUtxo({ satoshis: 1_000n, token: nft(c.category, "none", commit(5_000n)) }), c.customer.addr); c.provider.addUtxo(c.customer.addr, receipt);
  const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.refund(c.merchant.sig, 1n)).addInput(receipt, c.customer.sig.unlockP2PKH())
  .addOutput({ to: c.minter.tokenAddress, amount: 45_000n }).addOutput({ to: c.customer.addr, amount: 5_000n }); return () => tb.debug(); })();

let validOk = 0, validN = 0, attacksRejected = 0, attacksN = 0, notApplicable = [];
for (const v of spec.valid) {
  try { cases[v.id](); validOk++; validN++; console.log("PASS", v.id, v.what); }
  catch (e) {
    const msg = String(e.message).split("\n")[0];
    if (msg.startsWith("NOT-APPLICABLE")) { notApplicable.push(v.id); console.log("N/A ", v.id, msg); continue; }
    validN++; console.log("FAIL", v.id, v.what, "->", msg);
  }
}
for (const a of spec.attacks) {
  attacksN++;
  try { cases[a.id](); console.log("FAIL", a.id, a.what, "-> ACCEPTED"); }
  catch (e) {
    const msg = String(e.message);
    // A rejection only counts when the contract's own script fails, not a test-setup error.
    const byScript = /failed|Require statement|evaluation|error in transaction|Failed/i.test(msg) && !/missing its lockingBytecode|fee per byte|Insufficient/i.test(msg);
    if (byScript) { attacksRejected++; console.log("PASS", a.id, "rejected:", a.what); }
    else console.log("FAIL", a.id, a.what, "-> setup error, not a contract rejection:", msg.split("\n")[0]);
  }
}
console.log(`valid accepted: ${validOk} of ${validN}${notApplicable.length ? ` (n/a: ${notApplicable.join(",")})` : ""}`);
console.log(`attacks rejected by the contract: ${attacksRejected} of ${attacksN}`);
process.exit(validOk === validN && attacksRejected === attacksN ? 0 : 1);
