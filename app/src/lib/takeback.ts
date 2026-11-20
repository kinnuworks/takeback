// Takeback core: builds the purchase and refund transactions for a shop's receipt minter.
// Shared by the browser (purchases, signed by the customer's wallet over WizardConnect), the
// refund function (co-signed by the shop's hot refund key) and the tests (mock network).
import {
  Contract, TransactionBuilder, placeholderP2PKHUnlocker, SignatureTemplate,
  type NetworkProvider, type SpendableUtxo, type WcTransactionObject, type Artifact,
} from "cashscript";
type Utxo = SpendableUtxo;
import {
  bigIntToVmNumber, binToHex, hexToBin, vmNumberToBigInt, cashAddressToLockingBytecode,
  lockingBytecodeToCashAddress, encodeLockingBytecodeP2pkh, hash160, stringify,
} from "@bitauth/libauth";
import artifact from "../../contracts/ReceiptMinter.json" with { type: "json" };

/** Satoshis put on each receipt NFT: token dust plus enough to pay the fee of a later refund. */
export const RECEIPT_DUST = 2500n;
export const FEE_RATE = 1.0;

export interface ShopKeys {
  merchantPkh: Uint8Array;
  refundPk: Uint8Array;
  ownerPk: Uint8Array;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function minterContract(keys: ShopKeys, provider: NetworkProvider): Contract<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Mutation testing (contracts/mutants.test.mjs) swaps in a mutant's artifact here; nothing else does.
  const override = (globalThis as { __TAKEBACK_ARTIFACT__?: unknown }).__TAKEBACK_ARTIFACT__;
  return new Contract((override ?? artifact) as unknown as Artifact, [keys.merchantPkh, keys.refundPk, keys.ownerPk], { provider }) as Contract<any>;
}

/** Receipt commitment: amount (8 bytes, VM number padded) + order id (8 bytes). */
export function encodeReceipt(amount: bigint, orderId: bigint): string {
  const pad8 = (n: bigint) => { const b = new Uint8Array(8); b.set(bigIntToVmNumber(n).slice(0, 8)); return b; };
  return binToHex(new Uint8Array([...pad8(amount), ...pad8(orderId)]));
}

export function decodeReceipt(commitmentHex: string): { amount: bigint; orderId: bigint } | undefined {
  const b = hexToBin(commitmentHex);
  if (b.length !== 16) return undefined;
  const trim = (x: Uint8Array) => { let e = x.length; while (e > 0 && x[e - 1] === 0) e--; return x.slice(0, e); };
  const amount = vmNumberToBigInt(trim(b.slice(0, 8)), { requireMinimalEncoding: false });
  const orderId = vmNumberToBigInt(trim(b.slice(8, 16)), { requireMinimalEncoding: false });
  if (typeof amount === "string" || typeof orderId === "string") return undefined;
  return { amount, orderId };
}

export function categoryOf(minterUtxo: Utxo): string {
  if (!minterUtxo.token) throw new Error("minter UTXO has no token");
  return minterUtxo.token.category;
}

export function isMinterUtxo(u: Utxo): boolean {
  return u.token?.nft?.capability === "minting";
}

export function p2pkhAddress(pubkeyHash: Uint8Array, network: "mainnet" | "chipnet", tokenSupport = false): string {
  const r = lockingBytecodeToCashAddress({
    bytecode: encodeLockingBytecodeP2pkh(pubkeyHash), prefix: network === "mainnet" ? "bitcoincash" : "bchtest", tokenSupport,
  });
  if (typeof r === "string") throw new Error(r);
  return r.address;
}

export function toTokenAddress(address: string): string {
  const lb = cashAddressToLockingBytecode(address);
  if (typeof lb === "string") throw new Error(lb);
  const r = lockingBytecodeToCashAddress({ bytecode: lb.bytecode, prefix: address.split(":")[0] as "bitcoincash", tokenSupport: true });
  if (typeof r === "string") throw new Error(r);
  return r.address;
}

/** A customer coin the wallet can sign: which HD path and index it sits at. */
export interface WalletCoin {
  utxo: Utxo;
  address: string;
  path: "receive" | "change";
  index: number;
}

export interface PurchasePlan {
  wc: WcTransactionObject;
  inputPaths: [number, string, number][];
  receipt: { amount: bigint; orderId: bigint; commitment: string };
  builder: TransactionBuilder;
}

/**
 * Purchase: input 0 is a minter UTXO (pay path, no signature), the rest are the customer's coins.
 * Output 0 recreates the minter, 1 pays the merchant, 2 is the customer's receipt, 3 is change.
 */
export function buildPurchase(opts: {
  provider: NetworkProvider; keys: ShopKeys; network: "mainnet" | "chipnet";
  minterUtxo: Utxo; coins: WalletCoin[]; amount: bigint; orderId: bigint;
  receiptTo: string; changeTo: string;
}): PurchasePlan {
  const { provider, keys, network, minterUtxo, amount, orderId } = opts;
  const minter = minterContract(keys, provider);
  const category = categoryOf(minterUtxo);
  const commitment = encodeReceipt(amount, orderId);
  const need = amount + RECEIPT_DUST + 2000n;
  const picked: WalletCoin[] = [];
  let total = 0n;
  for (const c of [...opts.coins].filter((c) => !c.utxo.token).sort((a, b) => Number(b.utxo.satoshis - a.utxo.satoshis))) {
    if (total >= need) break;
    picked.push(c); total += c.utxo.satoshis;
  }
  if (total < need) throw new Error(`Not enough BCH in the connected wallet: need about ${need} sats, have ${total}`);

  const tb = new TransactionBuilder({ provider }).addInput(minterUtxo, minter.unlock.pay());
  for (const c of picked) tb.addInput(c.utxo, placeholderP2PKHUnlocker(c.address));
  tb.addOutput({ to: minter.tokenAddress, amount: minterUtxo.satoshis, token: minterUtxo.token });
  tb.addOutput({ to: p2pkhAddress(keys.merchantPkh, network), amount });
  tb.addOutput({ to: toTokenAddress(opts.receiptTo), amount: RECEIPT_DUST, token: { category, amount: 0n, nft: { capability: "none", commitment } } });
  tb.addBchChangeOutputIfNeeded({ to: opts.changeTo, feeRate: FEE_RATE });
  const wc = tb.generateWcTransactionObject({ broadcast: true, userPrompt: `Pay ${amount} sats and receive a Takeback receipt` });
  const inputPaths = picked.map((c, i) => [i + 1, c.path, c.index] as [number, string, number]);
  return { wc, inputPaths, receipt: { amount, orderId, commitment }, builder: tb };
}

export interface RefundPlan { wc: WcTransactionObject; inputIndex: number; amount: bigint; builder: TransactionBuilder }

/**
 * Refund: input 0 is a minter UTXO unlocked by the refund key, input 1 is the receipt (the holder
 * signs it). Output 0 recreates the minter less the refund, output 1 pays the holder exactly the
 * receipt amount, output 2 returns the receipt's own dust (less fee) to the holder.
 */
export function buildRefund(opts: {
  provider: NetworkProvider; keys: ShopKeys; minterUtxo: Utxo; refundKey: Uint8Array;
  receiptUtxo: Utxo; holderAddress: string; refundAmount?: bigint;
}): RefundPlan {
  if (opts.refundAmount !== undefined) return buildPartialRefund({ ...opts, refundAmount: opts.refundAmount });
  const { provider, keys, minterUtxo, receiptUtxo, holderAddress } = opts;
  const commitment = receiptUtxo.token?.nft?.commitment;
  if (!commitment || receiptUtxo.token?.category !== categoryOf(minterUtxo)) throw new Error("Not a receipt from this shop");
  const decoded = decodeReceipt(commitment);
  if (!decoded) throw new Error("Malformed receipt");
  if (minterUtxo.satoshis - decoded.amount < 1000n) throw new Error("The shop's refund float is too low right now");
  const minter = minterContract(keys, provider);
  const plain = toPlainAddress(holderAddress);
  const tb = new TransactionBuilder({ provider })
    .addInput(minterUtxo, minter.unlock.refund(new SignatureTemplate(opts.refundKey), 1n))
    .addInput(receiptUtxo, placeholderP2PKHUnlocker(plain))
    .addOutput({ to: minter.tokenAddress, amount: minterUtxo.satoshis - decoded.amount, token: minterUtxo.token })
    .addOutput({ to: plain, amount: decoded.amount })
    .addBchChangeOutputIfNeeded({ to: plain, feeRate: FEE_RATE });
  const wc = tb.generateWcTransactionObject({ broadcast: true, userPrompt: `Refund ${decoded.amount} sats for your Takeback receipt` });
  return { wc, inputIndex: 1, amount: decoded.amount, builder: tb };
}

/**
 * Partial refund: pays `refundAmount` and gives the holder a new receipt for the rest (same order
 * id). Output 0 minter less the refund, 1 the refund, 2 the remainder receipt, 3 dust back.
 */
export function buildPartialRefund(opts: {
  provider: NetworkProvider; keys: ShopKeys; minterUtxo: Utxo; refundKey: Uint8Array;
  receiptUtxo: Utxo; holderAddress: string; refundAmount: bigint;
}): RefundPlan {
  const { provider, keys, minterUtxo, receiptUtxo, holderAddress, refundAmount } = opts;
  const commitment = receiptUtxo.token?.nft?.commitment;
  const category = categoryOf(minterUtxo);
  if (!commitment || receiptUtxo.token?.category !== category) throw new Error("Not a receipt from this shop");
  const decoded = decodeReceipt(commitment);
  if (!decoded) throw new Error("Malformed receipt");
  if (refundAmount < 546n) throw new Error("A refund has to be at least 546 sats (the dust limit)");
  if (refundAmount >= decoded.amount) throw new Error("A partial refund must be less than the receipt; use a full refund");
  if (minterUtxo.satoshis - refundAmount < 1000n) throw new Error("The shop's refund float is too low right now");
  const minter = minterContract(keys, provider);
  const plain = toPlainAddress(holderAddress);
  const tb = new TransactionBuilder({ provider })
    .addInput(minterUtxo, minter.unlock.partialRefund(new SignatureTemplate(opts.refundKey), 1n, refundAmount))
    .addInput(receiptUtxo, placeholderP2PKHUnlocker(plain))
    .addOutput({ to: minter.tokenAddress, amount: minterUtxo.satoshis - refundAmount, token: minterUtxo.token })
    .addOutput({ to: plain, amount: refundAmount })
    .addOutput({ to: toTokenAddress(plain), amount: 1000n, token: { category, amount: 0n, nft: { capability: "none", commitment: encodeReceipt(decoded.amount - refundAmount, decoded.orderId) } } })
    .addBchChangeOutputIfNeeded({ to: plain, feeRate: FEE_RATE });
  const wc = tb.generateWcTransactionObject({ broadcast: true, userPrompt: `Refund ${refundAmount} of ${decoded.amount} sats; keep a receipt for the rest` });
  return { wc, inputIndex: 1, amount: refundAmount, builder: tb };
}

export function toPlainAddress(address: string): string {
  const lb = cashAddressToLockingBytecode(address);
  if (typeof lb === "string") throw new Error(lb);
  const r = lockingBytecodeToCashAddress({ bytecode: lb.bytecode, prefix: address.split(":")[0] as "bitcoincash", tokenSupport: false });
  if (typeof r === "string") throw new Error(r);
  return r.address;
}

/** WizardConnect's relay carries JSON: bytes and bigints go in libauth's extended format. */
export function relaySafe<T>(value: T): T {
  return JSON.parse(stringify(value));
}

export const pkhOf = (pubkey: Uint8Array) => hash160(pubkey);
