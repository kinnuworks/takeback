// Differential fuzzer for ReceiptMinter. Each case starts from a valid purchase, refund or partial
// refund, applies one to three random mutations, and is judged twice:
//   1. the contract: the whole transaction is verified by libauth's BCH 2026 virtual machine
//      (consensus rules and every input's script, the way a node checks it);
//   2. the model: src/lib/rules-model.ts, written from the rule text, never from the contract.
// A case where the contract accepts what the model says breaks a rule is a security hole.
// Shared by the Node runner (contracts/fuzz.test.mjs) and the live page.
import { TransactionBuilder, MockNetworkProvider, SignatureTemplate, type SpendableUtxo } from "cashscript";
import {
  createVirtualMachineBch2026, secp256k1, sha256, hash160, encodeLockingBytecodeP2pkh, binToHex, hexToBin,
  cashAddressToLockingBytecode, utf8ToBin,
} from "@bitauth/libauth";
import { minterContract } from "./takeback.ts";
import { judge, amountBytes, type MTok, type Cap, type MTx } from "./rules-model.ts";

type Owner = "minter" | "merchant" | "customer" | "attacker";
type Fn = MTx["fn"];
interface CIn { owner: Owner; value: bigint; token?: MTok; role: "minter" | "coin" | "receipt" | "extra" }
interface COut { owner: Owner; value: bigint; token?: MTok }
export interface FuzzCase { fn: Fn; ins: CIn[]; outs: COut[]; signer: "refund" | "customer" | "attacker" | "owner"; receiptIdx: number; r: bigint; muts: string[] }
export type Outcome = "agree-refused" | "agree-accepted" | "hole" | "too-strict" | "setup";
export interface FuzzResult { i: number; outcome: Outcome; model: string; contract: string; muts: string[]; fn: Fn }

// ---------- fixed world: keys, shop, categories ----------
const keyFrom = (label: string) => {
  const priv = sha256.hash(utf8ToBin(`takeback-fuzz:${label}`));
  return { priv, pub: secp256k1.derivePublicKeyCompressed(priv) as Uint8Array, sig: new SignatureTemplate(priv) };
};
const K = { merchant: keyFrom("merchant"), refund: keyFrom("refund"), owner: keyFrom("owner"), customer: keyFrom("customer"), attacker: keyFrom("attacker") };
const provider = new MockNetworkProvider();
const minter = minterContract({ merchantPkh: hash160(K.merchant.pub), refundPk: K.refund.pub, ownerPk: K.owner.pub }, provider);
const lockOf = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === "string") throw new Error(r); return binToHex(r.bytecode); };
const LOCK: Record<Owner, string> = {
  minter: lockOf(minter.tokenAddress),
  merchant: binToHex(encodeLockingBytecodeP2pkh(hash160(K.merchant.pub))),
  customer: binToHex(encodeLockingBytecodeP2pkh(hash160(K.customer.pub))),
  attacker: binToHex(encodeLockingBytecodeP2pkh(hash160(K.attacker.pub))),
};
const C = binToHex(sha256.hash(utf8ToBin("takeback-fuzz:shop-category")));
const F = binToHex(sha256.hash(utf8ToBin("takeback-fuzz:attacker-category")));
const FLOAT = 100_000n;
const vm = createVirtualMachineBch2026();

// ---------- deterministic randomness ----------
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  return { next, int, pick, big: (lo: bigint, hi: bigint) => lo + BigInt(Math.floor(next() * Number(hi - lo + 1n))) };
}
type R = ReturnType<typeof rng>;

const le8 = (n: bigint) => amountBytes(n < 0n ? 0n : n);
const commit = (amount: bigint, order: bigint) => {
  if (amount < 0n) { const b = hexToBin(amountBytes(-amount)); b[7] |= 0x80; return binToHex(b) + le8(order); }
  return le8(amount) + le8(order);
};
const nft = (category: string, capability: Cap, commitment: string): MTok => ({ category, amount: 0n, nft: { capability, commitment } });
const baton = (): MTok => nft(C, "minting", "");

// ---------- valid templates ----------
function template(r: R): FuzzCase {
  const fn = r.pick(["pay", "refund", "partialRefund"] as const);
  const A = r.big(1_000n, 40_000n), order = r.big(1n, 1_000_000n);
  const coin: CIn = { owner: "customer", value: 5_000_000n, role: "coin" };
  if (fn === "pay") return {
    fn, signer: "refund", receiptIdx: 1, r: 0n, muts: [],
    ins: [{ owner: "minter", value: FLOAT, token: baton(), role: "minter" }, coin],
    outs: [{ owner: "minter", value: FLOAT, token: baton() }, { owner: "merchant", value: A }, { owner: "customer", value: 1_000n, token: nft(C, "none", commit(A, order)) }],
  };
  const receipt: CIn = { owner: "customer", value: 2_500n, token: nft(C, "none", commit(A, order)), role: "receipt" };
  if (fn === "refund") return {
    fn, signer: "refund", receiptIdx: 1, r: 0n, muts: [],
    ins: [{ owner: "minter", value: FLOAT, token: baton(), role: "minter" }, receipt, coin],
    outs: [{ owner: "minter", value: FLOAT - A, token: baton() }, { owner: "customer", value: A }],
  };
  const rr = r.big(546n, A - 1n);
  return {
    fn, signer: "refund", receiptIdx: 1, r: rr, muts: [],
    ins: [{ owner: "minter", value: FLOAT, token: baton(), role: "minter" }, receipt, coin],
    outs: [{ owner: "minter", value: FLOAT - rr, token: baton() }, { owner: "customer", value: rr }, { owner: "customer", value: 1_000n, token: nft(C, "none", commit(A - rr, order)) }],
  };
}

// ---------- mutations ----------
const OWNERS: Owner[] = ["minter", "merchant", "customer", "attacker"];
const hasF = (c: FuzzCase) => c.ins.some((i) => i.token?.category === F);
function randomCommitment(r: R, _c: FuzzCase, current?: string): string {
  const order = r.big(1n, 1_000_000n);
  const v = r.int(0, 8);
  if (v === 0) return "";
  if (v === 1 && current) return current.slice(0, 30); // 15 bytes
  if (v === 2 && current) return current + "00"; // 17 bytes
  if (v === 3) return binToHex(sha256.hash(utf8ToBin(String(r.next())))).slice(0, 32); // random 16 bytes
  if (v === 4) return commit(0n, order);
  if (v === 5) return commit(-r.big(1n, 40_000n), order);
  if (v === 6 && current && current.length === 32) return commit(r.big(1n, 80_000n), BigInt("0x" + (current.slice(16).match(/../g) ?? []).reverse().join("") || "0"));
  return commit(r.big(1n, 80_000n), order);
}
function randomToken(r: R, c: FuzzCase): MTok | undefined {
  const v = r.int(0, 9);
  if (v === 0) return undefined;
  if (v === 1) return { category: C, amount: r.big(1n, 1000n) }; // fungible of the shop (impossible by consensus)
  const category = hasF(c) && r.next() < 0.3 ? F : C;
  return nft(category, r.pick(["none", "none", "mutable", "minting"] as const), randomCommitment(r, c));
}
const floor = (o: { value: bigint; token?: MTok; owner?: Owner }) => (o.token ? 1_000n : o.owner === "minter" ? 576n : 546n); // P2SH32 outputs have a higher dust limit
const clampOut = (o: COut): COut => ({ ...o, value: o.value < floor(o) ? floor(o) : o.value });

const MUTATIONS: Record<string, (r: R, c: FuzzCase) => boolean> = {
  amount: (r, c) => { if (!c.outs.length) return false; const i = r.int(0, c.outs.length - 1); const v = c.outs[i].value; c.outs[i] = clampOut({ ...c.outs[i], value: r.pick([v + 1n, v - 1n, v * 2n, v / 2n, 546n, r.big(1_000n, 200_000n)]) }); return true; },
  recipient: (r, c) => { if (!c.outs.length) return false; const i = r.int(0, c.outs.length - 1); c.outs[i] = clampOut({ ...c.outs[i], owner: r.pick(OWNERS.filter((o) => o !== c.outs[i].owner)) }); return true; },
  token: (r, c) => { if (!c.outs.length) return false; const i = r.int(0, c.outs.length - 1); c.outs[i] = clampOut({ ...c.outs[i], token: randomToken(r, c) }); return true; },
  flipByte: (r, c) => { const xs = c.outs.filter((o) => o.token?.nft && o.token.nft.commitment.length); if (!xs.length) return false; const o = r.pick(xs); const b = hexToBin(o.token!.nft!.commitment); b[r.int(0, b.length - 1)] ^= 1 << r.int(0, 7); o.token = { ...o.token!, nft: { ...o.token!.nft!, commitment: binToHex(b) } }; return true; },
  addOutput: (r, c) => { c.outs.splice(r.int(0, c.outs.length), 0, clampOut({ owner: r.pick(OWNERS), value: r.big(546n, 5_000n), token: r.next() < 0.6 ? randomToken(r, c) : undefined })); return true; },
  dropOutput: (r, c) => { if (!c.outs.length) return false; c.outs.splice(r.int(0, c.outs.length - 1), 1); return true; },
  swapOutputs: (r, c) => { if (c.outs.length < 2) return false; const i = r.int(0, c.outs.length - 1), j = r.int(0, c.outs.length - 1); if (i === j) return false; [c.outs[i], c.outs[j]] = [c.outs[j], c.outs[i]]; return true; },
  addInput: (r, c) => {
    const v = r.int(0, 3);
    const extra: CIn = v === 0 ? { owner: "customer", value: r.big(1_000n, 50_000n), role: "extra" }
      : v === 1 ? { owner: "customer", value: 1_000n, token: nft(C, "none", commit(r.big(1n, 40_000n), r.big(1n, 1_000_000n))), role: "extra" }
      : v === 2 ? { owner: "customer", value: 1_000n, token: nft(F, "minting", ""), role: "extra" }
      : { owner: "attacker", value: r.big(1_000n, 50_000n), role: "extra" };
    c.ins.push(extra); return true;
  },
  swapInputs: (r, c) => { if (c.ins.length < 2) return false; const i = r.int(0, c.ins.length - 1), j = r.int(0, c.ins.length - 1); if (i === j) return false; [c.ins[i], c.ins[j]] = [c.ins[j], c.ins[i]]; return true; },
  receiptIndex: (r, c) => { if (c.fn === "pay") return false; const n = r.int(0, c.ins.length); if (n === c.receiptIdx) return false; c.receiptIdx = n; return true; },
  refundAmount: (r, c) => { if (c.fn !== "partialRefund") return false; const rc = c.ins.find((i) => i.role === "receipt")?.token?.nft?.commitment; const A = rc ? BigInt(parseInt(rc.slice(0, 8).match(/../g)!.reverse().join(""), 16)) : 10_000n; c.r = r.pick([0n, -1n, A, A + 1n, 1n, r.big(1n, 2n * A)]); return true; },
  signer: (r, c) => { if (c.fn === "pay") return false; c.signer = r.pick(["customer", "attacker", "owner"] as const); return true; },
  receiptToken: (r, c) => {
    const rc = c.ins.find((i) => i.role === "receipt"); if (!rc) return false;
    const v = r.int(0, 3);
    const cur = rc.token!.nft!.commitment;
    rc.token = v === 0 ? nft(F, "none", cur) : v === 1 ? nft(C, r.pick(["mutable", "minting"] as const), cur) : nft(C, "none", randomCommitment(r, c, cur));
    if (rc.token.category === F && !hasF(c)) c.ins.push({ owner: "customer", value: 1_000n, token: nft(F, "minting", ""), role: "extra" });
    return true;
  },
  receiptHolder: (_r, c) => { const rc = c.ins.find((i) => i.role === "receipt"); if (!rc) return false; rc.owner = "attacker"; return true; },
  function: (r, c) => { const fn = r.pick((["pay", "refund", "partialRefund"] as const).filter((f) => f !== c.fn)); c.fn = fn; if (fn === "partialRefund" && c.r === 0n) c.r = r.big(546n, 20_000n); return true; },
  minterToken: (r, c) => { if (!c.outs[0]?.token) return false; const v = r.int(0, 2); c.outs[0].token = v === 0 ? nft(C, "minting", "01") : v === 1 ? nft(C, "mutable", "") : nft(C, "none", ""); return true; },
};
const MUT_NAMES = Object.keys(MUTATIONS);

export function generate(seed: number, i: number): FuzzCase {
  const r = rng(seed * 1_000_003 + i);
  const c = template(r);
  const want = r.int(1, 3);
  for (let tries = 0; c.muts.length < want && tries < 20; tries++) {
    const m = r.pick(MUT_NAMES);
    if (MUTATIONS[m](r, c)) c.muts.push(m);
  }
  return c;
}

// ---------- the contract's verdict (BCH 2026 VM, whole transaction) ----------
let counter = 0;
function contractVerdict(c: FuzzCase): { accepted: boolean; detail: string } | { setup: string } {
  const tb = new TransactionBuilder({ provider });
  const sigOf = (o: Owner) => (o === "attacker" ? K.attacker.sig : K.customer.sig);
  const signer = { refund: K.refund.sig, customer: K.customer.sig, attacker: K.attacker.sig, owner: K.owner.sig }[c.signer];
  const utxos: SpendableUtxo[] = [];
  try {
    for (const inp of c.ins) {
      const txid = binToHex(sha256.hash(utf8ToBin(`in:${counter++}`)));
      const u: SpendableUtxo = { txid, vout: 0, satoshis: inp.value, token: inp.token as SpendableUtxo["token"], lockingBytecode: LOCK[inp.owner] };
      utxos.push(u);
      if (inp.role === "minter") {
        const unlock = c.fn === "pay" ? minter.unlock.pay() : c.fn === "refund" ? minter.unlock.refund(signer, BigInt(c.receiptIdx)) : minter.unlock.partialRefund(signer, BigInt(c.receiptIdx), c.r);
        tb.addInput(u, unlock);
      } else tb.addInput(u, sigOf(inp.owner).unlockP2PKH());
    }
    const inSum = c.ins.reduce((s, x) => s + x.value, 0n);
    const outSum = c.outs.reduce((s, x) => s + x.value, 0n);
    for (const o of c.outs) tb.addOutput({ to: hexToBin(LOCK[o.owner]), amount: o.value, token: o.token as never });
    const change = inSum - outSum - 6_000n;
    if (change >= 546n) tb.addOutput({ to: hexToBin(LOCK.customer), amount: change });
    const transaction = (tb as unknown as { buildLibauthTransaction(skip: boolean): never }).buildLibauthTransaction(true);
    const sourceOutputs = utxos.map((u) => ({ lockingBytecode: hexToBin(u.lockingBytecode), valueSatoshis: u.satoshis, token: u.token && { category: hexToBin(u.token.category), amount: u.token.amount, nft: u.token.nft && { capability: u.token.nft.capability, commitment: hexToBin(u.token.nft.commitment) } } }));
    const res = vm.verify({ transaction, sourceOutputs } as never);
    if (res === true) return { accepted: true, detail: "accepted" };
    return { accepted: false, detail: String(res).split("\n")[0].slice(0, 160) };
  } catch (e) {
    return { setup: String((e as Error).message ?? e).split("\n")[0].slice(0, 160) };
  }
}

// The model sees the final transaction the same way: change output included.
function toModel(c: FuzzCase): MTx {
  const inSum = c.ins.reduce((s, x) => s + x.value, 0n), outSum = c.outs.reduce((s, x) => s + x.value, 0n);
  const change = inSum - outSum - 6_000n;
  const outs = [...c.outs.map((o) => ({ lock: LOCK[o.owner], value: o.value, token: o.token })), ...(change >= 546n ? [{ lock: LOCK.customer, value: change }] : [])];
  return {
    fn: c.fn, minterIndex: c.ins.findIndex((i) => i.role === "minter"),
    inputs: c.ins.map((i) => ({ lock: LOCK[i.owner], value: i.value, token: i.token, isMinter: i.role === "minter" })),
    outputs: outs, signerIsRefundKey: c.signer === "refund", receiptInput: c.receiptIdx, refundAmount: c.r,
    shop: { category: C, minterLock: LOCK.minter, merchantLock: LOCK.merchant, minterCommitment: "" },
  };
}

export function runOne(seed: number, i: number): FuzzResult {
  const c = generate(seed, i);
  const m = judge(toModel(c));
  const v = contractVerdict(c);
  if ("setup" in v) return { i, outcome: "setup", model: m.rule, contract: v.setup, muts: c.muts, fn: c.fn };
  const outcome: Outcome = m.valid ? (v.accepted ? "agree-accepted" : "too-strict") : (v.accepted ? "hole" : "agree-refused");
  return { i, outcome, model: m.rule, contract: v.detail, muts: c.muts, fn: c.fn };
}

export interface FuzzSummary { seed: number; n: number; counts: Record<Outcome, number>; byRule: Record<string, number>; disagreements: FuzzResult[]; setups: FuzzResult[] }
export function summarize(seed: number, results: FuzzResult[]): FuzzSummary {
  const counts = { "agree-refused": 0, "agree-accepted": 0, hole: 0, "too-strict": 0, setup: 0 } as Record<Outcome, number>;
  const byRule: Record<string, number> = {};
  for (const r of results) { counts[r.outcome]++; if (r.outcome === "agree-refused") byRule[r.model] = (byRule[r.model] ?? 0) + 1; }
  return { seed, n: results.length, counts, byRule, disagreements: results.filter((r) => r.outcome === "hole" || r.outcome === "too-strict"), setups: results.filter((r) => r.outcome === "setup") };
}

/** Browser-friendly: runs n cases in small slices so the page can show progress. */
export async function runFuzz(seed: number, n: number, onProgress?: (done: number, s: FuzzSummary) => void): Promise<FuzzSummary> {
  const results: FuzzResult[] = [];
  for (let i = 0; i < n; i++) {
    results.push(runOne(seed, i));
    if (onProgress && (i % 25 === 24 || i === n - 1)) { onProgress(i + 1, summarize(seed, results)); await new Promise((r) => setTimeout(r, 0)); }
  }
  return summarize(seed, results);
}
