// Reads the shop's activity straight from the chain: every purchase and refund spends a minter
// UTXO, so the minter address's history is the shop's full ledger.
import { ElectrumNetworkProvider } from "cashscript";
import { decodeTransactionBCH, hexToBin, binToHex, lockingBytecodeToCashAddress } from "@bitauth/libauth";
import { decodeReceipt } from "./takeback.ts";
import type { ShopConfig } from "./shop.ts";

export type Net = "mainnet" | "chipnet";

const providers = new Map<Net, ElectrumNetworkProvider>();
export function providerFor(net: Net) {
  let p = providers.get(net);
  if (!p) { p = new ElectrumNetworkProvider(net); providers.set(net, p); }
  return p;
}

export function txLink(net: Net, txid: string) {
  return net === "mainnet" ? `https://blockchair.com/bitcoin-cash/transaction/${txid}` : `https://chipnet.imaginary.cash/tx/${txid}`;
}

export interface LedgerRow {
  txid: string;
  height: number;
  kind: "sale" | "refund" | "setup" | "other";
  amount: bigint;
  orderId?: bigint;
  customer?: string;
}

const rawCache = new Map<string, string>();

export async function shopLedger(shop: ShopConfig, limit = 40): Promise<LedgerRow[]> {
  const p = providerFor(shop.network);
  const history = (await p.performRequest("blockchain.address.get_history", shop.minterAddress)) as { tx_hash: string; height: number }[];
  const recent = [...history].sort((a, b) => (b.height || 1e9) - (a.height || 1e9)).slice(0, limit);
  const rows: LedgerRow[] = [];
  for (const h of recent) {
    let raw = rawCache.get(h.tx_hash);
    if (!raw) { raw = await p.getRawTransaction(h.tx_hash); rawCache.set(h.tx_hash, raw); }
    const tx = decodeTransactionBCH(hexToBin(raw));
    if (typeof tx === "string") continue;
    const outCat = (i: number) => (tx.outputs[i]?.token ? binToHex(tx.outputs[i].token!.category) : undefined);
    const addr = (i: number) => {
      const r = lockingBytecodeToCashAddress({ bytecode: tx.outputs[i].lockingBytecode, prefix: shop.network === "mainnet" ? "bitcoincash" : "bchtest" });
      return typeof r === "string" ? undefined : r.address;
    };
    const receiptOut = tx.outputs[2];
    if (outCat(0) === shop.category && outCat(2) === shop.category && receiptOut?.token?.nft?.capability === "none") {
      const d = decodeReceipt(binToHex(receiptOut.token.nft.commitment));
      rows.push({ txid: h.tx_hash, height: h.height, kind: "sale", amount: d?.amount ?? 0n, orderId: d?.orderId, customer: addr(2) });
    } else if (outCat(0) === shop.category && tx.outputs.slice(1).every((o) => !o.token) && addr(1) !== shop.merchantAddress) {
      rows.push({ txid: h.tx_hash, height: h.height, kind: "refund", amount: tx.outputs[1]?.valueSatoshis ?? 0n, customer: addr(1) });
    } else if (tx.outputs.filter((o) => o.token?.nft?.capability === "minting").length > 1) {
      rows.push({ txid: h.tx_hash, height: h.height, kind: "setup", amount: 0n });
    } else {
      rows.push({ txid: h.tx_hash, height: h.height, kind: "other", amount: 0n });
    }
  }
  return rows;
}

export function sumLedger(rows: LedgerRow[]) {
  const sales = rows.filter((r) => r.kind === "sale");
  const refunds = rows.filter((r) => r.kind === "refund");
  const total = (xs: LedgerRow[]) => xs.reduce((s, r) => s + r.amount, 0n);
  return { sales: sales.length, salesSats: total(sales), refunds: refunds.length, refundSats: total(refunds), netSats: total(sales) - total(refunds) };
}

export function shortTx(txid: string) { return `${txid.slice(0, 8)}…${txid.slice(-6)}`; }
