// POST /api/refund { txid, vout, holderAddress, network, amount? }
// Co-signs a refund for one Takeback receipt with the shop's hot refund key. The key can only
// do what the contract's refund path allows: pay the receipt's holder exactly the receipt
// amount (or a partial amount, re-issuing a receipt for the rest) and burn it. The holder's
// wallet signs the receipt input and broadcasts; this function never broadcasts.
// Demo shop policy: every valid receipt from this shop is refundable, up to 25,000 sats (the menu
// tops out at 20,000). The cap bounds how much of the refund float one buy-and-refund cycle can move.
import { ElectrumNetworkProvider, type SpendableUtxo } from "cashscript";
import { hexToBin, cashAddressToLockingBytecode, binToHex, decodeCashAddress } from "@bitauth/libauth";
import { buildRefund, relaySafe, decodeReceipt, isMinterUtxo, type ShopKeys } from "../src/lib/takeback.ts";
import { loadShop } from "../src/lib/shop.ts";

const MAX_REFUND = 25_000n;
const PER_IP_PER_HOUR = 20;
const recent = new Map<string, number[]>(); // per server instance; a soft limit

type Req = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type Res = { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void };

// Messages written here are safe to show; anything else is logged and replaced with a plain one.
class Refusal extends Error {}

export default async function handler(req: Req, res: Res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const ct = String(req.headers?.["content-type"] ?? "");
  if (!ct.includes("application/json")) return res.status(415).json({ error: "Send the request as application/json" });
  let body: { txid?: unknown; vout?: unknown; holderAddress?: unknown; network?: unknown; amount?: unknown };
  try { body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {}; }
  catch { return res.status(400).json({ error: "The request body must be JSON" }); }
  if (typeof body !== "object") return res.status(400).json({ error: "The request body must be a JSON object" });

  if (body.network !== "mainnet" && body.network !== "chipnet") return res.status(400).json({ error: "network must be mainnet or chipnet" });
  const network = body.network;
  const txid = String(body.txid ?? ""), vout = body.vout, holderAddress = String(body.holderAddress ?? "");
  if (!/^[0-9a-f]{64}$/.test(txid) || typeof vout !== "number" || !Number.isInteger(vout) || vout < 0 || vout > 10_000) return res.status(400).json({ error: "txid (64 hex) and vout (a small whole number) are required" });
  const addr = decodeCashAddress(holderAddress);
  if (typeof addr === "string" || addr.prefix !== (network === "mainnet" ? "bitcoincash" : "bchtest") || !addr.type.startsWith("p2pkh")) return res.status(400).json({ error: `holderAddress must be a ${network} P2PKH address` });
  if (body.amount !== undefined && !/^\d{1,9}$/.test(String(body.amount))) return res.status(400).json({ error: "amount must be a whole number of sats" });

  const fwd = req.headers?.["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd ?? "unknown").split(",")[0].trim();
  const now = Date.now();
  const times = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (times.length >= PER_IP_PER_HOUR) return res.status(429).json({ error: "Too many refunds from here this hour; try again later" });

  const shop = loadShop(network);
  if (!shop) return res.status(503).json({ error: `No ${network} shop is set up yet` });
  const keyHex = network === "mainnet" ? process.env.TAKEBACK_REFUND_KEY : process.env.TAKEBACK_REFUND_KEY_CHIPNET;
  if (!keyHex) return res.status(503).json({ error: "Refund signer isn't configured" });

  const provider = new ElectrumNetworkProvider(network);
  try {
    const lb = cashAddressToLockingBytecode(holderAddress);
    if (typeof lb === "string") throw new Refusal("Bad address");
    const receipt = (await provider.getUtxos(holderAddress)).find((u) => u.txid === txid && u.vout === vout);
    if (!receipt) throw new Refusal("That receipt isn't at this address (already refunded, or moved)");
    if (receipt.token?.category !== shop.category || receipt.token.nft?.capability !== "none") throw new Refusal("Not a receipt from this shop");
    const decoded = decodeReceipt(receipt.token.nft.commitment);
    if (!decoded || decoded.amount <= 0n) throw new Refusal("Malformed receipt");
    if (decoded.amount > MAX_REFUND) throw new Refusal("Over the demo shop's refund limit of 25,000 sats");
    const refundAmount = body.amount !== undefined ? BigInt(String(body.amount)) : undefined;
    if (refundAmount !== undefined && (refundAmount < 546n || decoded.amount - refundAmount < 546n)) throw new Refusal("A partial refund must be at least 546 sats and leave at least 546 sats on the receipt");

    const need = refundAmount ?? decoded.amount;
    const minters = (await provider.getUtxos(shop.minterAddress)).filter((u) => isMinterUtxo(u) && u.token?.category === shop.category && u.satoshis - need >= 1000n);
    if (!minters.length) throw new Refusal("The shop's refund float is empty right now");
    const minterUtxo: SpendableUtxo = { ...minters[Math.floor(Math.random() * minters.length)], lockingBytecode: binToHex(cashAddressToLockingBytecode(shop.minterAddress).bytecode as Uint8Array) };
    const receiptUtxo: SpendableUtxo = { ...receipt, lockingBytecode: binToHex(lb.bytecode) };
    const keys: ShopKeys = { merchantPkh: hexToBin(shop.merchantPkh), refundPk: hexToBin(shop.refundPk), ownerPk: hexToBin(shop.ownerPk) };
    const plan = buildRefund({ provider, keys, minterUtxo, refundKey: hexToBin(keyHex), receiptUtxo, holderAddress, refundAmount });
    times.push(now); recent.set(ip, times);
    return res.status(200).json({ wc: relaySafe(plan.wc), inputIndex: plan.inputIndex, amount: plan.amount.toString() });
  } catch (e) {
    if (e instanceof Refusal) return res.status(400).json({ error: e.message });
    console.error("refund failed:", e);
    return res.status(500).json({ error: "The refund couldn't be prepared right now; try again in a moment" });
  } finally {
    await provider.disconnect?.().catch(() => undefined);
  }
}
