// Records the rough-cut demo film on the live site at viewing pace, with a caption for each step
// drawn into the page (labelled as the test network). Not a test: run it by hand.
// Usage: node e2e/record-film.mjs [url]   -> e2e/videos/film-<time>.webm
import { chromium } from "playwright";
import { mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";

const url = process.argv[2] ?? "https://takeback-bch.vercel.app/?net=chipnet";
const site = new URL(url).origin;
const key = createHash("sha256").update(`takeback-film-wallet ${Date.now()} (chipnet test key, no value)`).digest("hex");
mkdirSync("e2e/videos", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "e2e/videos", size: { width: 1280, height: 720 } } });
await context.addInitScript((k) => { try { localStorage.setItem("takeback-demo-key-chipnet", k); } catch {} }, key);
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById("film-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "film-caption";
      Object.assign(el.style, { position: "fixed", left: "50%", bottom: "28px", transform: "translateX(-50%)", zIndex: "2147483647", maxWidth: "1040px", padding: "14px 22px", borderRadius: "12px", background: "rgba(10,30,15,0.88)", color: "#fff", font: "600 24px/1.35 system-ui, sans-serif", textAlign: "center", boxShadow: "0 8px 30px rgba(0,0,0,0.3)" });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}
const scrollTo = async (sel) => { await page.locator(sel).first().evaluate((e) => e.scrollIntoView({ behavior: "smooth", block: "center" })); await wait(900); };

// 1. Title slide
await page.goto(`${site}/slides.html`, { waitUntil: "networkidle" });
await caption("Takeback: pay with Bitcoin Cash, get a receipt that refunds.");
await wait(3500);
// 2. The shop
await page.goto(url, { waitUntil: "networkidle" });
await caption("A demo coffee shop on the Bitcoin Cash test network. No wallet needed: the page makes one for you.");
await wait(4500);
// 3. Buy
await caption("One transaction pays the shop and puts a receipt token in your wallet.");
await page.locator(".menu li").first().getByRole("button", { name: "Buy" }).click();
await page.waitForSelector("text=Your receipt is in your wallet", { timeout: 60_000 });
await scrollTo(".slip");
await caption("The receipt: what you paid, the order number, and the transaction on chain.");
await wait(4500);
// 4. Refund
await caption("Press Refund. The shop co-signs, and the contract fixes the amount and who gets it.");
await wait(2000);
await page.locator(".receipts li").first().getByRole("button", { name: "Refund", exact: true }).click();
await page.waitForSelector("text=The receipt is burned", { timeout: 60_000 });
await scrollTo(".slip");
const secs = (await page.innerText("[role=status]")).match(/accepted it ([\d.]+) s/)?.[1];
await caption(`Exactly the amount back and the receipt destroyed, ${secs ?? "a few"} seconds after the click. A card refund takes about 5 to 10 business days.`);
await wait(6000);
// 5. Cheat the network
await scrollTo("#cheats");
await caption("Now try to cheat: the demo wallet sends five dishonest purchases to a real node.");
await page.getByRole("button", { name: /Send 5 cheats to/ }).click();
await page.waitForSelector("text=5 of 5 refused by the network", { timeout: 90_000 });
await scrollTo("#cheats .tb-out");
await caption("Refused, every one, by the network itself. Each line is the node's own answer.");
await wait(5500);
// 6. The proof
await scrollTo("#proof");
await caption("Our own break test: 56 attacks refused by two real nodes, and 18,714 random cheats refused by the contract.");
await wait(6000);
// 7. For shops
await scrollTo("#shops");
await caption("For shops that take Bitcoin Cash: refunds in one tap that can never exceed what was paid.");
await wait(5000);
// 8. End
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await wait(900);
await caption("Try it yourself: takeback-bch.vercel.app");
await wait(4000);
const v = await page.video()?.path();
await context.close(); await browser.close();
const out = `e2e/videos/film-${Date.now()}.webm`;
renameSync(v, out);
console.log("film:", out, secs ? `(refund ${secs} s)` : "");
