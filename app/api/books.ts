// GET /api/books?net=chipnet|mainnet: the shop's books (sales, refunds) read from the minter's history
// on chain by the server, cached at the edge for 20 seconds so the first screen never waits on a cold
// chain read. The page then rereads the same history in the visitor's browser and says so.
import { shopLedger } from "../src/lib/chain.ts";
import { loadShop } from "../src/lib/shop.ts";

type Req = { query?: Record<string, string | string[] | undefined> };
type Res = { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void };

export default async function handler(req: Req, res: Res) {
  const net = req.query?.net === "chipnet" ? "chipnet" : "mainnet";
  const shop = loadShop(net);
  if (!shop) { res.setHeader("Cache-Control", "public, s-maxage=60"); return res.status(503).json({ error: `No ${net} shop is set up yet` }); }
  try {
    const rows = await shopLedger(shop, 2000);
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=600");
    return res.status(200).json({ net, readAt: new Date().toISOString(), rows: rows.map((r) => ({ ...r, amount: r.amount.toString(), orderId: r.orderId?.toString() })) });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: String((e as Error).message ?? e).split("\n")[0] });
  }
}
