// POST /api/refund { txid, vout, holderAddress, network? }
// Co-signs a refund for one Takeback receipt with the shop's hot refund key. The key can only
// do what the contract's refund path allows: pay the receipt's holder exactly the receipt
// amount and burn it. The holder's wallet signs the receipt input and broadcasts.
// Demo shop policy: every valid receipt from this shop is refundable, up to 200,000 sats.
import { ElectrumNetworkProvider, type SpendableUtxo } from "cashscript";
import { hexToBin, cashAddressToLockingBytecode, binToHex } from "@bitauth/libauth";
import { buildRefund, relaySafe, decodeReceipt, isMinterUtxo, type ShopKeys } from "../src/lib/takeback.ts";
import { loadShop } from "../src/lib/shop.ts";

const MAX_REFUND = 200_000n;

type Req = { method?: string; body?: unknown };
type Res = { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void };

export default async function handler(req: Req, res: Res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as { txid?: string; vout?: number; holderAddress?: string; network?: string; amount?: string };
  const network = body.network === "chipnet" ? "chipnet" : "mainnet";
  const shop = loadShop(network);
  if (!shop) return res.status(503).json({ error: `No ${network} shop is set up yet` });
  const keyHex = network === "mainnet" ? process.env.TAKEBACK_REFUND_KEY : process.env.TAKEBACK_REFUND_KEY_CHIPNET;
  if (!keyHex) return res.status(503).json({ error: "Refund signer isn't configured" });
  if (!body.txid || typeof body.vout !== "number" || !body.holderAddress) return res.status(400).json({ error: "txid, vout and holderAddress are required" });

  const provider = new ElectrumNetworkProvider(network);
  try {
    const lb = cashAddressToLockingBytecode(body.holderAddress);
    if (typeof lb === "string") return res.status(400).json({ error: "Bad address" });
    const holderUtxos = await provider.getUtxos(body.holderAddress);
    const receipt = holderUtxos.find((u) => u.txid === body.txid && u.vout === body.vout);
    if (!receipt) return res.status(404).json({ error: "That receipt isn't at this address (already refunded, or moved)" });
    if (receipt.token?.category !== shop.category || receipt.token.nft?.capability !== "none") return res.status(400).json({ error: "Not a receipt from this shop" });
    const decoded = decodeReceipt(receipt.token.nft.commitment);
    if (!decoded) return res.status(400).json({ error: "Malformed receipt" });
    if (decoded.amount > MAX_REFUND) return res.status(400).json({ error: "Over the demo shop's refund limit" });

    const minters = (await provider.getUtxos(shop.minterAddress)).filter((u) => isMinterUtxo(u) && u.token?.category === shop.category && u.satoshis - decoded.amount >= 1000n);
    if (!minters.length) return res.status(503).json({ error: "The shop's refund float is empty right now" });
    const minterUtxo: SpendableUtxo = { ...minters[Math.floor(Math.random() * minters.length)], lockingBytecode: binToHex(cashAddressToLockingBytecode(shop.minterAddress).bytecode as Uint8Array) };
    const receiptUtxo: SpendableUtxo = { ...receipt, lockingBytecode: binToHex(lb.bytecode) };
    const keys: ShopKeys = { merchantPkh: hexToBin(shop.merchantPkh), refundPk: hexToBin(shop.refundPk), ownerPk: hexToBin(shop.ownerPk) };
    const refundAmount = body.amount ? BigInt(body.amount) : undefined;
    const plan = buildRefund({ provider, keys, minterUtxo, refundKey: hexToBin(keyHex), receiptUtxo, holderAddress: body.holderAddress, refundAmount });
    return res.status(200).json({ wc: relaySafe(plan.wc), inputIndex: plan.inputIndex, amount: plan.amount.toString() });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message ?? e).split("\n")[0] });
  } finally {
    await provider.disconnect?.().catch(() => undefined);
  }
}
