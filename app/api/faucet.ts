// POST /api/faucet { address, network? }: funds a demo wallet made in the visitor's browser, so
// anyone can try the purchase and refund without a wallet of their own.
//  - chipnet (default): 25,000 test sats, no monetary value.
//  - mainnet: 25,000 sats of real BCH (a few cents), only while TAKEBACK_MAINNET_FAUCET=on, which the
//    owner switches on with a budget; a global hourly cap per server instance bounds the spend.
// Each faucet key is derived from that network's refund key, so no extra secret exists.
// GET /api/faucet?net=chipnet|mainnet shows whether it's on, its address and its balance.
import { ElectrumNetworkProvider, TransactionBuilder, SignatureTemplate } from "cashscript";
import { sha256, utf8ToBin, secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, decodeCashAddress, binToHex } from "@bitauth/libauth";

type Net = "mainnet" | "chipnet";
const AMOUNT: Record<Net, bigint> = { chipnet: 25_000n, mainnet: 25_000n };
const PER_IP_PER_HOUR: Record<Net, number> = { chipnet: 6, mainnet: 2 };
const GLOBAL_PER_HOUR: Record<Net, number> = { chipnet: 200, mainnet: 12 };
const recent = new Map<string, number[]>(); // per server instance
const sent: Record<Net, number[]> = { chipnet: [], mainnet: [] };

type Req = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined> };
type Res = { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void };

const enabled = (net: Net) => net === "chipnet" || process.env.TAKEBACK_MAINNET_FAUCET === "on";

function faucetWallet(net: Net) {
  const keyHex = net === "mainnet" ? process.env.TAKEBACK_REFUND_KEY : process.env.TAKEBACK_REFUND_KEY_CHIPNET;
  if (!keyHex) return undefined;
  const priv = sha256.hash(utf8ToBin(`takeback-${net}-faucet:${keyHex}`));
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const lb = encodeLockingBytecodeP2pkh(hash160(pub));
  const a = lockingBytecodeToCashAddress({ bytecode: lb, prefix: net === "mainnet" ? "bitcoincash" : "bchtest" });
  if (typeof a === "string") return undefined;
  return { sig: new SignatureTemplate(priv), address: a.address, lockingBytecode: binToHex(lb) };
}

export default async function handler(req: Req, res: Res) {
  res.setHeader("Cache-Control", "no-store");
  let body: { address?: string; network?: string } = {};
  if (req.method === "POST") {
    if (!String(req.headers?.["content-type"] ?? "").includes("application/json")) return res.status(415).json({ error: "Send the request as application/json" });
    try { body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {}; }
    catch { return res.status(400).json({ error: "The request body must be JSON" }); }
  } else if (req.method !== "GET") return res.status(405).json({ error: "GET or POST only" });
  const netParam = req.method === "GET" ? req.query?.net : body.network;
  const net: Net = netParam === "mainnet" ? "mainnet" : "chipnet";
  if (!enabled(net)) {
    if (req.method === "GET") { res.setHeader("Cache-Control", "public, s-maxage=30"); return res.status(200).json({ network: net, enabled: false }); }
    return res.status(503).json({ error: "The mainnet demo faucet is off" });
  }
  const w = faucetWallet(net);
  if (!w) return res.status(503).json({ error: "The demo faucet isn't configured" });
  const provider = new ElectrumNetworkProvider(net);
  try {
    const coins = (await provider.getUtxos(w.address)).filter((u) => !u.token);
    const balance = coins.reduce((s, u) => s + u.satoshis, 0n);
    if (req.method === "GET") { res.setHeader("Cache-Control", "public, s-maxage=10"); return res.status(200).json({ network: net, enabled: true, address: w.address, balance: balance.toString() }); }

    const address = String(body.address ?? "");
    const decoded = decodeCashAddress(address);
    if (typeof decoded === "string" || decoded.prefix !== (net === "mainnet" ? "bitcoincash" : "bchtest") || !decoded.type.startsWith("p2pkh")) return res.status(400).json({ error: `A ${net} P2PKH address is required` });

    const fwd = req.headers?.["x-forwarded-for"];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd ?? "unknown").split(",")[0].trim();
    const now = Date.now();
    const key = `${net}:${ip}`;
    const times = (recent.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= PER_IP_PER_HOUR[net]) return res.status(429).json({ error: "This demo faucet has sent you enough for this hour" });
    sent[net] = sent[net].filter((t) => now - t < 3_600_000);
    if (sent[net].length >= GLOBAL_PER_HOUR[net]) return res.status(429).json({ error: "The demo faucet has reached its hourly limit; try again later" });

    const amount = AMOUNT[net];
    const held = (await provider.getUtxos(address)).filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
    if (held >= amount) return res.status(200).json({ txid: null, amount: "0", note: "This demo wallet already has enough" });

    // Gather coins until they cover the amount and the fee (change from earlier sends is small).
    const picked: typeof coins = [];
    let total = 0n;
    for (const c of [...coins].sort((a, b) => Number(b.satoshis - a.satoshis))) { if (total >= amount + 2_000n) break; picked.push(c); total += c.satoshis; }
    if (total < amount + 2_000n) return res.status(503).json({ error: "The demo faucet is empty right now" });
    const fee = 300n + 150n * BigInt(picked.length);
    const tb = new TransactionBuilder({ provider });
    for (const c of picked) tb.addInput({ ...c, lockingBytecode: w.lockingBytecode }, w.sig.unlockP2PKH());
    tb.addOutput({ to: address, amount });
    if (total - amount - fee >= 546n) tb.addOutput({ to: w.address, amount: total - amount - fee });
    const out = await tb.send();
    times.push(now); recent.set(key, times); sent[net].push(now);
    return res.status(200).json({ txid: out.txid, amount: amount.toString() });
  } catch (e) {
    console.error("faucet failed:", e);
    return res.status(500).json({ error: "The demo faucet couldn't send right now; try again in a moment" });
  } finally {
    await provider.disconnect?.().catch(() => undefined);
  }
}
