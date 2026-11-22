// When CoinGecko is rate-limiting (it answers 429 with no CORS header, as seen on 22 Nov), the live
// page must not log an error, and the mainnet menu must still show each price in dollars. The test
// makes CoinGecko refuse every request from the browser; the rest (our server, the chain) is real.
// Usage: node e2e/price-outage.mjs [url]   (default https://takeback-bch.vercel.app/)
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://takeback-bch.vercel.app/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route(/^https:\/\/api\.coingecko\.com\//, (route) => route.fulfill({ status: 429, contentType: "text/plain", body: "Too Many Requests" }));
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
let failed = false;
const check = (ok, what, detail = "") => { console.log(ok ? "PASS" : "FAIL", what, ok ? "" : detail); if (!ok) failed = true; };

await page.goto(url, { waitUntil: "networkidle" });
const hint = await page.waitForFunction(() => {
  const m = document.querySelector(".menu__price");
  return m && /≈ \$\d+\.\d\d/.test(m.textContent ?? "") ? m.textContent : null;
}, null, { timeout: 15_000 }).then((h) => h.jsonValue()).catch(() => null);
check(!!hint, "mainnet menu shows the dollar price while CoinGecko refuses the browser", `(menu: ${await page.locator(".menu__price").first().innerText().catch(() => "none")})`);
if (hint) console.log("  first item:", String(hint).replace(/\s+/g, " ").trim());
await page.waitForTimeout(1500);
check(errors.length === 0, "no console errors", errors.join(" | ").slice(0, 400));
console.log(failed ? "PRICE OUTAGE: FAIL" : "PRICE OUTAGE: ALL PASS");
await browser.close();
process.exit(failed ? 1 : 0);
