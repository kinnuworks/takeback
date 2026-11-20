// One click from a cold page: press Buy on the first item without connecting anything. On chipnet the
// page makes a demo wallet, gets it test coins and completes the purchase; then refund it.
// Usage: node e2e/demo-buy-first.mjs [url]   (default https://takeback-bch.vercel.app/?net=chipnet)
import { chromium } from "playwright";
import { createHash } from "node:crypto";
const url = process.argv[2] ?? "https://takeback-bch.vercel.app/?net=chipnet";
const key = createHash("sha256").update("takeback-e2e-buy-first-wallet (chipnet test key, no value)").digest("hex");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript((k) => { try { localStorage.setItem("takeback-demo-key-chipnet", k); } catch {} }, key);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const fail = async (m) => { console.error("FAIL", m); try { console.error("PAGE:", (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 900)); } catch {} await browser.close(); process.exit(1); };
await page.goto(url, { waitUntil: "networkidle" });
await page.locator(".menu li").first().getByRole("button", { name: "Buy" }).click({ timeout: 20_000 }).catch((e) => fail("Buy not clickable before connecting: " + String(e).split("\n")[0]));
await page.waitForSelector("text=Your receipt is in your wallet", { timeout: 60_000 }).catch(() => fail("one-click purchase didn't complete"));
console.log("PASS one click on Buy: demo wallet made, funded and paid");
await page.locator(".receipts li").first().getByRole("button", { name: "Refund", exact: true }).click({ timeout: 30_000 }).catch((e) => fail("refund: " + String(e).split("\n")[0]));
await page.waitForSelector("text=The receipt is burned", { timeout: 45_000 }).catch(() => fail("refund didn't complete"));
console.log("PASS refund after the one-click purchase");
if (errors.length) await fail("page errors: " + errors.slice(0, 3).join(" | "));
await browser.close();
console.log("BUY FIRST: ALL PASS");
process.exit(0);
