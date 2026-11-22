// GET /api/price: the BCH price in US dollars, for the "≈ $" hints on the mainnet menu. Read by the
// server and cached at the edge for 5 minutes, so visitors' browsers never call a price service
// themselves (CoinGecko rate-limits busy pages and its 429 reply has no CORS header). CoinGecko first;
// if it doesn't answer, Kraken's public ticker. If neither answers, usd is null and the page shows
// sats only. The reply says which service the price came from.
type Res = { status: (n: number) => Res; json: (b: unknown) => void; setHeader: (k: string, v: string) => void };

const SOURCES: { name: string; url: string; read: (j: any) => unknown }[] = [
  { name: "CoinGecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd", read: (j) => j?.["bitcoin-cash"]?.usd },
  { name: "Kraken", url: "https://api.kraken.com/0/public/Ticker?pair=BCHUSD", read: (j) => j?.result?.BCHUSD?.c?.[0] },
];
let memo: { at: number; body: { usd: number; source: string; readAt: string } } | null = null;

export default async function handler(_req: unknown, res: Res) {
  if (memo && Date.now() - memo.at < 300_000) {
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    return res.status(200).json(memo.body);
  }
  for (const s of SOURCES) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
      if (!r.ok) { console.error(`price: ${s.name} answered ${r.status}`); continue; }
      const usd = Number(s.read(await r.json()));
      if (!Number.isFinite(usd) || usd <= 0) { console.error(`price: ${s.name} gave no usable price`); continue; }
      memo = { at: Date.now(), body: { usd, source: s.name, readAt: new Date().toISOString() } };
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
      return res.status(200).json(memo.body);
    } catch (e) {
      console.error(`price: ${s.name} failed:`, e);
    }
  }
  res.setHeader("Cache-Control", "public, s-maxage=60");
  return res.status(200).json({ usd: null, source: null, error: "No price service answered" });
}
