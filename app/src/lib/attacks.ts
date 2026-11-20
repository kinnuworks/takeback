// The fixed attack list (evidence/attacks.json) as runnable cases against ReceiptMinter on
// CashScript's mock network, which evaluates every input on the BCH 2026 VM. Shared by the
// Node test (check.sh) and the live break-test page, so judges run exactly what we run.
import { MockNetworkProvider, TransactionBuilder, randomUtxo, randomNFT, SignatureTemplate, type SpendableUtxo } from "cashscript";
import {
  cashAddressToLockingBytecode, binToHex, secp256k1, encodeLockingBytecodeP2pkh, hash160,
  lockingBytecodeToCashAddress, bigIntToVmNumber, sha256,
} from "@bitauth/libauth";
import attackSpec from "../evidence/attacks.json" with { type: "json" };
import attackSpec2 from "../evidence/attacks-2.json" with { type: "json" };
import attackSpec3 from "../evidence/attacks-3.json" with { type: "json" };
import { minterContract } from "./takeback.ts";

export const spec2 = attackSpec2 as { seed: number; valid: { id: string; path: string; what: string }[]; attacks: { id: string; path: string; what: string }[] };
export const spec3 = attackSpec3 as { seed: number; valid: { id: string; path: string; what: string }[]; attacks: { id: string; path: string; what: string }[] };
export const spec = attackSpec as { seed: number; valid: { id: string; path: string; what: string }[]; attacks: { id: string; path: string; what: string }[] };

type Key = { pub: Uint8Array; sig: SignatureTemplate; addr: string };
let counter = 0;
function key(): Key {
  const priv = sha256.hash(new TextEncoder().encode(`takeback:${spec.seed}:${counter++}`));
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const lb = encodeLockingBytecodeP2pkh(hash160(pub));
  const r = lockingBytecodeToCashAddress({ bytecode: lb, prefix: "bchtest", tokenSupport: true });
  if (typeof r === "string") throw new Error(r);
  return { pub, sig: new SignatureTemplate(priv), addr: r.address };
}
const lbHex = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === "string") throw new Error(r); return binToHex(r.bytecode); };
const le8 = (n: bigint) => { const b = new Uint8Array(8); b.set(bigIntToVmNumber(n).slice(0, 8)); return b; };
export const commit = (amount: bigint, order = 1n, len = 16) => {
  const full = new Uint8Array([...le8(amount), ...le8(order)]);
  const out = new Uint8Array(len); out.set(full.slice(0, Math.min(len, 16)));
  return binToHex(out);
};
type Cap = "none" | "mutable" | "minting";
const nft = (category: string, capability: Cap, commitment: string) => ({ category, amount: 0n, nft: { capability, commitment } });

function setup() {
  const provider = new MockNetworkProvider();
  const merchant = key(), customer = key(), attacker = key(), owner = key();
  const minter = minterContract({ merchantPkh: hash160(merchant.pub), refundPk: merchant.pub, ownerPk: owner.pub }, provider);
  const baton: SpendableUtxo = { ...randomUtxo({ satoshis: 50_000n, token: randomNFT({ nft: { capability: "minting", commitment: "" } }) }), lockingBytecode: lbHex(minter.address) };
  const category = baton.token!.category;
  provider.addUtxo(minter.address, baton);
  const coins: SpendableUtxo = { ...randomUtxo({ satoshis: 40_000n }), lockingBytecode: lbHex(customer.addr) };
  provider.addUtxo(customer.addr, coins);
  return { provider, merchant, customer, attacker, owner, minter, baton, category, coins };
}
type Ctx = ReturnType<typeof setup>;
type Out = { to: string; amount: bigint; token?: ReturnType<typeof nft> | { category: string; amount: bigint } };

// Purchase: minter in, customer coins in; outputs as given (defaults are the valid purchase).
function purchase(mod: (c: Ctx, outs: Out[]) => Out[] = (_c, o) => o, amount = 5_000n) {
  return () => {
    const c = setup();
    const outs: Out[] = [
      { to: c.minter.tokenAddress, amount: 50_000n, token: nft(c.category, "minting", "") },
      { to: c.merchant.addr, amount },
      { to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(amount)) },
    ];
    const final = mod(c, outs);
    const spent = final.reduce((s, o) => s + o.amount, 0n) - 50_000n;
    const tb = new TransactionBuilder({ provider: c.provider }).addInput(c.baton, c.minter.unlock.pay()).addInput(c.coins, c.customer.sig.unlockP2PKH());
    for (const o of final) tb.addOutput(o as never);
    tb.addOutput({ to: c.customer.addr, amount: 40_000n - spent - 2_000n });
    return tb.debug();
  };
}

// Refund: minter in (refund path), receipt in; outputs as given (defaults are the valid refund).
function refund(opts: {
  signer?: (c: Ctx) => SignatureTemplate; receiptCategory?: (c: Ctx) => string; receiptCommitment?: string;
  receiptIdx?: bigint; extraInput?: (c: Ctx) => SpendableUtxo; outs?: (c: Ctx, outs: Out[]) => Out[];
} = {}) {
  return () => {
    const c = setup();
    const amount = 5_000n;
    const receipt: SpendableUtxo = { ...randomUtxo({ satoshis: 2_000n, token: nft(opts.receiptCategory ? opts.receiptCategory(c) : c.category, "none", opts.receiptCommitment ?? commit(amount)) }), lockingBytecode: lbHex(c.customer.addr) };
    c.provider.addUtxo(c.customer.addr, receipt);
    const tb = new TransactionBuilder({ provider: c.provider })
      .addInput(c.baton, c.minter.unlock.refund(opts.signer ? opts.signer(c) : c.merchant.sig, opts.receiptIdx ?? 1n))
      .addInput(receipt, c.customer.sig.unlockP2PKH());
    if (opts.extraInput) { const u = opts.extraInput(c); c.provider.addUtxo(c.customer.addr, u); tb.addInput(u, c.customer.sig.unlockP2PKH()); }
    const outs: Out[] = [
      { to: c.minter.tokenAddress, amount: 50_000n - amount, token: nft(c.category, "minting", "") },
      { to: c.customer.addr, amount },
    ];
    for (const o of opts.outs ? opts.outs(c, outs) : outs) tb.addOutput(o as never);
    return tb.debug();
  };
}
// Partial refund of `refundAmount` from a 5,000 receipt (order 7): out0 minter, out1 refund, out2 remainder receipt.
function partial(opts: {
  refundAmount?: bigint; signer?: (c: Ctx) => SignatureTemplate; outs?: (c: Ctx, outs: Out[]) => Out[];
} = {}) {
  return () => {
    const c = setup();
    const amount = 5_000n, refundAmount = opts.refundAmount ?? 2_000n;
    const receipt: SpendableUtxo = { ...randomUtxo({ satoshis: 5_000n, token: nft(c.category, "none", commit(amount, 7n)) }), lockingBytecode: lbHex(c.customer.addr) };
    c.provider.addUtxo(c.customer.addr, receipt);
    const tb = new TransactionBuilder({ provider: c.provider })
      .addInput(c.baton, c.minter.unlock.partialRefund(opts.signer ? opts.signer(c) : c.merchant.sig, 1n, refundAmount))
      .addInput(receipt, c.customer.sig.unlockP2PKH());
    const outs: Out[] = [
      { to: c.minter.tokenAddress, amount: 50_000n - (refundAmount > 0n ? refundAmount : 0n), token: nft(c.category, "minting", "") },
      { to: c.customer.addr, amount: refundAmount > 0n ? refundAmount : 546n },
      { to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(amount - refundAmount, 7n)) },
    ];
    for (const o of opts.outs ? opts.outs(c, outs) : outs) tb.addOutput(o as never);
    return tb.debug();
  };
}

const setAmount = (i: number, amount: bigint) => (_c: Ctx, o: Out[]) => o.map((x, j) => (j === i ? { ...x, amount } : x));
const setTo = (i: number, f: (c: Ctx) => string) => (c: Ctx, o: Out[]) => o.map((x, j) => (j === i ? { ...x, to: f(c) } : x));
const setToken = (i: number, f: (c: Ctx) => Out["token"]) => (c: Ctx, o: Out[]) => o.map((x, j) => (j === i ? { ...x, token: f(c) } : x));
const dropToken = (i: number) => (_c: Ctx, o: Out[]) => o.map((x, j) => (j === i ? { to: x.to, amount: x.amount } : x));
const add = (f: (c: Ctx) => Out) => (c: Ctx, o: Out[]) => [...o, f(c)];

export const cases: Record<string, () => unknown> = {
  V1: purchase(),
  V2: purchase(undefined, 1_000n),
  V3: refund(),
  A01: purchase(setAmount(1, 4_999n)),
  A02: purchase(setAmount(1, 2_500n)),
  A03: purchase(setAmount(1, 546n)),
  A04: purchase(setTo(1, (c) => c.attacker.addr)),
  A05: purchase(setToken(2, (c) => nft(c.category, "none", commit(5_000n, 1n, 15)))),
  A06: purchase(setToken(2, (c) => nft(c.category, "none", commit(5_000n) + "00"))),
  A07: purchase((c, o) => setToken(2, () => nft(c.category, "none", commit(0n)))(c, setAmount(1, 546n)(c, o))),
  A08: purchase(setToken(2, (c) => nft(c.category, "none", binToHex(new Uint8Array([...le8(-5_000n), ...le8(1n)]))))),
  A09: purchase(setToken(2, () => nft("aa".repeat(32), "none", commit(5_000n)))),
  A10: purchase(dropToken(2)),
  A11: purchase(setTo(0, (c) => c.attacker.addr)),
  A12: purchase(setTo(0, (c) => c.customer.addr)),
  A13: purchase(setToken(0, (c) => nft(c.category, "none", ""))),
  A14: purchase(setAmount(0, 49_999n)),
  A15: purchase(add((c) => ({ to: c.attacker.addr, amount: 1_000n, token: nft(c.category, "minting", "") }))),
  A16: purchase(add((c) => ({ to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(5_000n, 2n)) }))),
  A17: purchase(setToken(2, (c) => nft(c.category, "minting", commit(5_000n)))),
  A18: purchase(setToken(2, (c) => nft(c.category, "mutable", commit(5_000n)))),
  A19: purchase(add((c) => ({ to: c.customer.addr, amount: 1_000n, token: { category: c.category, amount: 1000n } }))),
  A20: refund({ signer: (c) => c.customer.sig }),
  A21: refund({ signer: (c) => c.attacker.sig }),
  A22: refund({ outs: (c, o) => setAmount(1, 5_001n)(c, setAmount(0, 44_999n)(c, o)) }),
  A23: refund({ outs: (c, o) => setAmount(1, 10_000n)(c, setAmount(0, 40_000n)(c, o)) }),
  A24: refund({ outs: setTo(1, (c) => c.attacker.addr) }),
  A25: refund({ receiptCategory: () => "bb".repeat(32), receiptCommitment: commit(30_000n), outs: (c, o) => setAmount(1, 30_000n)(c, setAmount(0, 20_000n)(c, o)) }),
  A26: refund({ outs: add((c) => ({ to: c.customer.addr, amount: 800n, token: nft(c.category, "none", commit(5_000n)) })) }),
  A27: refund({ outs: setToken(1, (c) => nft(c.category, "none", commit(5_000n))) }),
  A28: refund({ receiptIdx: 0n }),
  A29: refund({ outs: dropToken(0) }),
  A30: refund({ outs: (c, o) => add((cc) => ({ to: cc.attacker.addr, amount: 5_000n }))(c, setAmount(0, 40_000n)(c, o)) }),
  A31: refund({ outs: (c, o) => setAmount(1, 4_000n)(c, setAmount(0, 46_000n)(c, o)) }),
  A32: refund({ outs: add((c) => ({ to: c.attacker.addr, amount: 800n, token: nft(c.category, "none", commit(1n)) })) }),
  A33: refund({ extraInput: (c) => ({ ...randomUtxo({ satoshis: 1_000n, token: nft(c.category, "none", commit(9_000n, 2n)) }), lockingBytecode: lbHex(c.customer.addr) }) }),
  A34: refund({ extraInput: (c) => ({ ...randomUtxo({ satoshis: 1_000n, token: nft(c.category, "none", commit(5_000n, 3n)) }), lockingBytecode: lbHex(c.customer.addr) }) }),
};

Object.assign(cases, {
  PV1: partial(),
  PV3: partial({ refundAmount: 546n }),
  P01: partial({ outs: setToken(2, (c) => nft(c.category, "none", commit(4_000n, 7n))) }),
  P02: partial({ outs: setTo(2, (c) => c.attacker.addr) }),
  P03: partial({ outs: setToken(2, (c) => nft(c.category, "minting", commit(3_000n, 7n))) }),
  P04: partial({ outs: setToken(2, (c) => nft(c.category, "none", commit(3_000n, 8n))) }),
  P05: partial({ refundAmount: 0n }),
  P06: partial({ refundAmount: 5_000n }),
  P07: partial({ outs: add((c) => ({ to: c.customer.addr, amount: 1_000n, token: nft(c.category, "none", commit(3_000n, 7n)) })) }),
  P08: partial({ signer: (c) => c.customer.sig }),
  P09: partial({ outs: setTo(1, (c) => c.attacker.addr) }),
  P10: partial({ outs: (_c, o) => [o[0], o[1]] }),
  P11: partial({ outs: (c, o) => add((cc) => ({ to: cc.attacker.addr, amount: 5_000n }))(c, setAmount(0, 43_000n)(c, o)) }),
  P12: partial({ refundAmount: 6_000n, outs: setToken(2, (c) => nft(c.category, "none", commit(1n, 7n))) }),
  // List 3 (found by the fuzzer on v1): the minter's own minting token must keep its commitment.
  M01: purchase(setToken(0, (c) => nft(c.category, "minting", "01"))),
  M02: refund({ outs: setToken(0, (c) => nft(c.category, "minting", "01")) }),
  M03: partial({ outs: setToken(0, (c) => nft(c.category, "minting", "01")) }),
  M04: purchase(setToken(0, (c) => nft(c.category, "minting", "ab".repeat(40)))),
});

export interface CaseResult { id: string; what: string; kind: "valid" | "attack"; expected: "accept" | "reject"; outcome: "accepted" | "rejected" | "not-applicable" | "setup-error"; ok: boolean; detail: string }

const SETUP_ERROR = /missing its lockingBytecode|fee per byte|Insufficient|less than the required minimum|OutputSatoshisTooSmall/i;

export function runCase(id: string, what: string, kind: "valid" | "attack"): CaseResult {
  const expected = kind === "valid" ? "accept" : "reject";
  const fn = cases[id];
  const naReason = (spec2 as unknown as { not_applicable?: Record<string, string> }).not_applicable?.[id];
  if (!fn) return { id, what, kind, expected, outcome: "not-applicable", ok: kind === "valid", detail: naReason ?? "one shop per transaction by design (minter must be input 0)" };
  try {
    fn();
    return { id, what, kind, expected, outcome: "accepted", ok: kind === "valid", detail: "accepted by the VM" };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (SETUP_ERROR.test(msg)) return { id, what, kind, expected, outcome: "setup-error", ok: false, detail: msg.split("\n")[0] };
    const line = msg.match(/ReceiptMinter\.cash:(\d+)/)?.[1];
    return { id, what, kind, expected, outcome: "rejected", ok: kind === "attack", detail: line ? `rejected by the contract at line ${line}` : msg.split("\n")[0] };
  }
}

export function runAll(list: 1 | 2 | 3 | "both" | "all" = "all"): CaseResult[] {
  const specs = list === 1 ? [spec] : list === 2 ? [spec2] : list === 3 ? [spec3] : list === "both" ? [spec, spec2] : [spec, spec2, spec3];
  return specs.flatMap((sp) => [
    ...sp.valid.map((v) => runCase(v.id, v.what, "valid")),
    ...sp.attacks.map((a) => runCase(a.id, a.what, "attack")),
  ]);
}
