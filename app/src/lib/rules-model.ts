// An independent model of Takeback's written rules (the contract header and the README), used by
// the fuzzer as the second opinion on every random transaction. It never runs the contract or
// CashScript: it reads a plain description of the transaction and says whether the rules allow it.
// Written from the rule text, not from the contract's code.

export type Cap = "none" | "mutable" | "minting";
export interface MTok { category: string; amount: bigint; nft?: { capability: Cap; commitment: string } }
export interface MIn { lock: string; value: bigint; token?: MTok; isMinter: boolean }
export interface MOut { lock: string; value: bigint; token?: MTok }
export interface MTx {
  fn: "pay" | "refund" | "partialRefund";
  minterIndex: number; // where the minter input sits (it runs the contract)
  inputs: MIn[];
  outputs: MOut[];
  signerIsRefundKey: boolean;
  receiptInput: number;
  refundAmount: bigint;
  shop: { category: string; minterLock: string; merchantLock: string; minterCommitment: string };
}
export interface Verdict { valid: boolean; rule: string }

const no = (rule: string): Verdict => ({ valid: false, rule });
const yes: Verdict = { valid: true, rule: "allowed" };

/** Receipt bytes: 8-byte amount (little-endian VM number, sign bit in the top byte) + 8-byte order id. */
export function receiptAmount(commitmentHex: string): bigint | undefined {
  if (commitmentHex.length !== 32) return undefined;
  const b = commitmentHex.slice(0, 16).match(/../g)!.map((h) => parseInt(h, 16));
  const negative = (b[7] & 0x80) !== 0;
  b[7] &= 0x7f;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return negative ? -v : v;
}
/** The 8-byte padded VM-number encoding of a positive amount (as the remainder receipt must carry). */
export function amountBytes(n: bigint): string {
  const out: number[] = [];
  let v = n;
  while (v > 0n) { out.push(Number(v & 0xffn)); v >>= 8n; }
  if (out.length && out[out.length - 1] & 0x80) out.push(0);
  while (out.length < 8) out.push(0);
  return out.slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

const isShop = (t: MTok | undefined, shopCat: string) => !!t && t.category === shopCat;
const isMintingBaton = (t: MTok | undefined, tx: MTx) =>
  !!t && t.category === tx.shop.category && t.amount === 0n && t.nft?.capability === "minting" && t.nft.commitment === tx.shop.minterCommitment;
const isReceiptToken = (t: MTok | undefined, shopCat: string) =>
  !!t && t.category === shopCat && t.amount === 0n && t.nft?.capability === "none";

export function judge(tx: MTx): Verdict {
  const { inputs: ins, outputs: outs, shop } = tx;
  // Consensus: no new fungible tokens of a category without a genesis (no rule of ours needed).
  for (const o of outs) if (o.token && o.token.amount > 0n && !ins.some((i) => i.token?.category === o.token!.category && i.token.amount > 0n)) return no("consensus: fungible tokens from nowhere");
  // Every input that is a minter runs the contract; this model only ever has the one minter.
  // "The minter is input 0" in every path.
  if (tx.minterIndex !== 0) return no("minter must be input 0");
  const minterIn = ins[0];
  // "out[0] the minter again: same script, same minting token"
  const o0 = outs[0];
  if (!o0 || o0.lock !== shop.minterLock) return no("out0 must be the minter's script");
  if (!isMintingBaton(o0.token, tx)) return no("out0 must carry the same minting token");

  if (tx.fn === "pay") {
    // "float not reduced"
    if (o0.value < minterIn.value) return no("pay: float reduced");
    const o2 = outs[2];
    if (!o2 || !isReceiptToken(o2.token, shop.category)) return no("pay: out2 must be an immutable receipt of this shop");
    const amount = receiptAmount(o2.token!.nft!.commitment);
    if (amount === undefined) return no("pay: receipt must be 16 bytes");
    if (amount <= 0n) return no("pay: receipt amount must be positive");
    const o1 = outs[1];
    if (!o1 || o1.lock !== shop.merchantLock) return no("pay: out1 must pay the merchant");
    if (o1.value !== amount) return no("pay: merchant must get exactly the receipt amount");
    if (o1.token) return no("pay: merchant output carries no token");
    for (let i = 3; i < outs.length; i++) if (isShop(outs[i].token, shop.category)) return no("pay: no other output may carry the shop's tokens");
    return yes;
  }

  // refund and partialRefund: "the shop's hot refund key co-signs"
  if (!tx.signerIsRefundKey) return no("refund: needs the shop's refund key");
  const ri = tx.receiptInput;
  if (ri === 0) return no("refund: the receipt can't be input 0");
  const rIn = ins[ri];
  if (!rIn) return no("refund: receipt input index out of range");
  if (!isShop(rIn.token, shop.category) || rIn.token!.nft?.capability !== "none") return no("refund: the receipt must be an immutable NFT of this shop");
  const amount = receiptAmount(rIn.token!.nft!.commitment);
  if (amount === undefined) return no("refund: receipt must be 16 bytes");
  for (let j = 1; j < ins.length; j++) if (j !== ri && isShop(ins[j].token, shop.category)) return no("refund: only one receipt per refund");
  const holder = rIn.lock;
  const o1 = outs[1];

  if (tx.fn === "refund") {
    if (amount <= 0n) return no("refund: receipt amount must be positive");
    if (o0.value < minterIn.value - amount) return no("refund: float pays more than the receipt");
    if (!o1 || o1.lock !== holder) return no("refund: must pay the receipt's holder");
    if (o1.value !== amount) return no("refund: must pay exactly the receipt amount");
    if (o1.token) return no("refund: refund output carries no token");
    for (let k = 1; k < outs.length; k++) if (isShop(outs[k].token, shop.category)) return no("refund: the receipt must be burned");
    return yes;
  }

  // partialRefund
  const r = tx.refundAmount;
  if (r <= 0n) return no("partial: refund must be positive");
  if (r >= amount) return no("partial: must be less than the receipt");
  if (o0.value < minterIn.value - r) return no("partial: float pays more than the refund");
  if (!o1 || o1.lock !== holder) return no("partial: must pay the holder");
  if (o1.value !== r) return no("partial: must pay exactly the refund amount");
  if (o1.token) return no("partial: refund output carries no token");
  const o2 = outs[2];
  if (!o2 || o2.lock !== holder) return no("partial: remainder receipt must go to the holder");
  if (!isReceiptToken(o2.token, shop.category)) return no("partial: remainder must be an immutable receipt of this shop");
  const want = amountBytes(amount - r) + rIn.token!.nft!.commitment.slice(16);
  if (o2.token!.nft!.commitment !== want) return no("partial: remainder receipt must say exactly what's left, same order id");
  for (let k = 3; k < outs.length; k++) if (isShop(outs[k].token, shop.category)) return no("partial: no other output may carry the shop's tokens");
  return yes;
}
