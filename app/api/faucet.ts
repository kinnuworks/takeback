// POST /api/faucet { address }: sends 25,000 chipnet test sats (no monetary value) to a demo wallet
// made in the visitor's browser, so anyone can try the purchase and refund without a wallet.
// Chipnet only. The faucet key is derived from the chipnet refund key, so no extra secret exists;
// it holds only test coins. GET /api/faucet shows the faucet's address and balance.
import { ElectrumNetworkProvider, TransactionBuilder, SignatureTemplate } from "cashscript";
import { sha256, utf8ToBin, secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, decodeCashAddress, binToHex } from "@bitauth/libauth";

const AMOUNT = 25_000n;
const PER_IP_PER_HOUR = 6;
const recent = new Map<string, number[]>(); // per server instance; a soft limit for test coins

type Req = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type Res = { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void };

function faucetWallet() {
  const keyHex = process.env.TAKEBACK_REFUND_KEY_CHIPNET;
  if (!keyHex) return undefined;
  const priv = sha256.hash(utf8ToBin(`takeback-chipnet-faucet:${keyHex}`));
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const lb = encodeLockingBytecodeP2pkh(hash160(pub));
  const a = lockingBytecodeToCashAddress({ bytecode: lb, prefix: "bchtest" });
  if (typeof a === "string") return undefined;
  return { sig: new SignatureTemplate(priv), address: a.address, lockingBytecode: binToHex(lb) };
}

export default async function handler(req: Req, res: Res) {
  res.setHeader("Cache-Control", "no-store");
  const w = faucetWallet();
  if (!w) return res.status(503).json({ error: "The test faucet isn't configured" });
  const provider = new ElectrumNetworkProvider("chipnet");
  try {
    const coins = (await provider.getUtxos(w.address)).filter((u) => !u.token);
    const balance = coins.reduce((s, u) => s + u.satoshis, 0n);
    if (req.method === "GET") { res.setHeader("Cache-Control", "public, s-maxage=10"); return res.status(200).json({ network: "chipnet", address: w.address, balance: balance.toString() }); }
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    if (!String(req.headers?.["content-type"] ?? "").includes("application/json")) return res.status(415).json({ error: "Send the request as application/json" });

    let body: { address?: string };
    try { body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {}; }
    catch { return res.status(400).json({ error: "The request body must be JSON" }); }
    const address = String(body?.address ?? "");
    const decoded = decodeCashAddress(address);
    if (typeof decoded === "string" || decoded.prefix !== "bchtest" || !decoded.type.startsWith("p2pkh")) return res.status(400).json({ error: "A chipnet (bchtest:) P2PKH address is required" });

    const fwd = req.headers?.["x-forwarded-for"];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd ?? "unknown").split(",")[0].trim();
    const now = Date.now();
    const times = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= PER_IP_PER_HOUR) return res.status(429).json({ error: "This demo faucet has sent you enough test coins for this hour" });

    const held = (await provider.getUtxos(address)).filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
    if (held >= AMOUNT) return res.status(200).json({ txid: null, amount: "0", note: "This demo wallet already has enough test coins" });

    // Gather coins until they cover the amount and the fee (change from earlier sends is small).
    const picked: typeof coins = [];
    let total = 0n;
    for (const c of [...coins].sort((a, b) => Number(b.satoshis - a.satoshis))) { if (total >= AMOUNT + 2_000n) break; picked.push(c); total += c.satoshis; }
    if (total < AMOUNT + 2_000n) return res.status(503).json({ error: "The test faucet is empty right now" });
    const fee = 300n + 150n * BigInt(picked.length);
    const tb = new TransactionBuilder({ provider });
    for (const c of picked) tb.addInput({ ...c, lockingBytecode: w.lockingBytecode }, w.sig.unlockP2PKH());
    tb.addOutput({ to: address, amount: AMOUNT });
    if (total - AMOUNT - fee >= 546n) tb.addOutput({ to: w.address, amount: total - AMOUNT - fee });
    const sent = await tb.send();
    times.push(now); recent.set(ip, times);
    return res.status(200).json({ txid: sent.txid, amount: AMOUNT.toString() });
  } catch (e) {
    console.error("faucet failed:", e);
    return res.status(500).json({ error: "The test faucet couldn't send right now; try again in a moment" });
  } finally {
    await provider.disconnect?.().catch(() => undefined);
  }
}
