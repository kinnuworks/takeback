// Partial refund on the live chipnet page: buy the cheapest item with a demo wallet, press "Refund
// half", see the new receipt for the rest, then refund that remainder in full.
// Usage: node e2e/demo-partial.mjs [url]   (default https://takeback-bch.vercel.app/?net=chipnet)
import { chromium } from "playwright";
import { createHash } from "node:crypto";
const url = process.argv[2] ?? "https://takeback-bch.vercel.app/?net=chipnet";
const key = createHash("sha256").update("takeback-e2e-partial-wallet (chipnet test key, no value)").digest("hex");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript((k) => { try { localStorage.setItem("takeback-demo-key-chipnet", k); } catch {} }, key);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const fail = async (m) => { console.error("FAIL", m); try { console.error("PAGE:", (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 900)); } catch {} await browser.close(); process.exit(1); };
await page.goto(url, { waitUntil: "networkidle" });
await page.locator(".menu li").first().getByRole("button", { name: "Buy" }).click({ timeout: 20_000 }).catch((e) => fail("buy: " + String(e).split("\n")[0]));
await page.waitForSelector("text=Your receipt is in your wallet", { timeout: 60_000 }).catch(() => fail("purchase didn't complete"));
console.log("PASS bought a 10,000-sat Kopi");
await page.locator(".receipts li").first().getByRole("button", { name: "Refund half" }).click({ timeout: 30_000 }).catch((e) => fail("refund half: " + String(e).split("\n")[0]));
await page.waitForSelector("text=A new receipt for the rest is in your wallet", { timeout: 45_000 }).catch(() => fail("partial refund didn't complete"));
console.log("PASS refund half: 5,000 back and a new receipt for the rest");
await page.waitForFunction(() => /5,000 sats/.test(document.querySelector(".receipts")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => fail("the remainder receipt for 5,000 sats never appeared"));
await page.locator(".receipts li", { hasText: "5,000 sats" }).first().getByRole("button", { name: "Refund", exact: true }).click({ timeout: 30_000 }).catch((e) => fail("refund remainder: " + String(e).split("\n")[0]));
await page.waitForSelector("text=The receipt is burned", { timeout: 45_000 }).catch(() => fail("remainder refund didn't complete"));
console.log("PASS remainder refunded in full; receipt burned");
if (errors.length) await fail("page errors: " + errors.slice(0, 3).join(" | "));
await browser.close();
console.log("PARTIAL: ALL PASS");
process.exit(0);
