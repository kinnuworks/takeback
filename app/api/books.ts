// GET /api/books?net=chipnet|mainnet: the shop's books (sales, refunds) read from the minter's history
// on chain by the server, cached at the edge for 20 seconds so the first screen never waits on a cold
// chain read. The page then rereads the same history in the visitor's browser and says so.
import { shopLedger } from "../src/lib/chain.ts";
import { loadShop } from "../src/lib/shop.ts";

type Req = { query?: Record<string, string | string[] | undefined> };
// A warm instance answers from memory for 20 s, whatever other query strings a caller adds.
const memo = new Map<string, { at: number; body: unknown }>();
type Res = { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void };

export default async function handler(req: Req, res: Res) {
  const net = req.query?.net === "chipnet" ? "chipnet" : "mainnet";
  const shop = loadShop(net);
  if (!shop) { res.setHeader("Cache-Control", "public, s-maxage=60"); return res.status(503).json({ error: `No ${net} shop is set up yet` }); }
  res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=600");
  const hit = memo.get(net);
  if (hit && Date.now() - hit.at < 20_000) return res.status(200).json(hit.body);
  try {
    const rows = await shopLedger(shop, 2000);
    const body = { net, readAt: new Date().toISOString(), rows: rows.map((r) => ({ ...r, amount: r.amount.toString(), orderId: r.orderId?.toString() })) };
    memo.set(net, { at: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error("books failed:", e);
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Couldn't read the shop's books from the chain right now" });
  }
}
