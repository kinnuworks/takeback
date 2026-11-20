// Walks the no-wallet demo on the live site, on chipnet: Try it now (faucet tops up a demo wallet made
// in the browser), buy the cheapest item, see the receipt, refund it, see the timing line and the
// burned receipt, then send the five cheats to chipnet and see every one refused. Also runs the
// in-browser attack lists and a fuzz batch. Records a video in e2e/videos.
// Usage: node e2e/demo-instant.mjs [url]   (default https://takeback-bch.vercel.app/?net=chipnet)
// The demo key is a fixed, test-only chipnet key so repeated runs reuse their test coins.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const url = process.argv[2] ?? "https://takeback-bch.vercel.app/?net=chipnet";
const demoKey = createHash("sha256").update("takeback-e2e-demo-wallet (chipnet test key, no value)").digest("hex");
mkdirSync("e2e/videos", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ recordVideo: { dir: "e2e/videos", size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } });
await context.addInitScript((k) => { try { localStorage.setItem("takeback-demo-key-chipnet", k); } catch {} }, demoKey);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const step = (s) => console.log("PASS", s);
const fail = async (m) => {
  console.error("FAIL", m);
  try { console.error("PAGE:", (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 1500)); } catch {}
  if (errors.length) console.error("ERRORS:", errors.slice(0, 5).join(" | "));
  await browser.close(); process.exit(1);
};
const t = Date.now();
await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Try it now, no wallet needed" }).click();
await page.waitForFunction(() => /Demo wallet .* ([1-9][0-9,]*) test sats/.test(document.body.innerText), null, { timeout: 45_000 }).catch(() => fail("demo wallet never got test coins"));
step("Try it now: demo wallet funded by the faucet");
await page.locator(".menu li").first().getByRole("button", { name: "Buy" }).click({ timeout: 30_000 }).catch((e) => fail("buy: " + String(e).split("\n")[0]));
await page.waitForSelector("text=Your receipt is in your wallet", { timeout: 45_000 }).catch(() => fail("purchase didn't complete"));
step("purchase: signed in the browser, accepted by chipnet");
await page.waitForSelector(".receipts li", { timeout: 30_000 }).catch(() => fail("receipt never listed"));
step("receipt listed under Your receipts");
await page.locator(".receipts li").first().getByRole("button", { name: "Refund", exact: true }).click({ timeout: 30_000 }).catch((e) => fail("refund: " + String(e).split("\n")[0]));
await page.waitForSelector("text=The receipt is burned", { timeout: 45_000 }).catch(() => fail("refund didn't complete"));
const timing = (await page.innerText("[role=status]")).match(/accepted it ([\d.]+) s after you pressed Refund/);
if (!timing) await fail("no timing line after the refund");
if (!/5 to 10 business days/.test(await page.innerText("[role=status]"))) await fail("no card-refund comparison line");
step(`refund: co-signed, accepted ${timing[1]} s after the click, comparison line shown`);
await page.getByRole("button", { name: "Send 5 cheats to chipnet" }).click({ timeout: 30_000 }).catch((e) => fail("cheats: " + String(e).split("\n")[0]));
await page.waitForSelector("text=5 of 5 refused by the network", { timeout: 60_000 }).catch(() => fail("the five cheats weren't all refused"));
step("5 of 5 cheats refused by a real chipnet node");
await page.getByRole("button", { name: "Run the attacks" }).click();
await page.waitForFunction(() => /(\d+) of \1 attacks refused by the contract/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => fail("in-browser attack lists didn't all pass"));
step("in-browser attack lists: every attack refused");
await page.getByRole("button", { name: "Fuzz 2,000 more in your browser" }).click();
await page.waitForFunction(() => /2,000 tried .* 0 got through · 0 honest ones refused/.test(document.body.innerText), null, { timeout: 90_000 }).catch(() => fail("fuzz batch didn't finish clean"));
step("in-browser fuzz: 2,000 tried, 0 got through");
if (errors.length) await fail("console errors: " + errors.slice(0, 3).join(" | "));
step("no console errors");
const video = await page.video()?.path();
await context.close(); await browser.close();
console.log("video:", video);
console.log(`INSTANT DEMO: ALL PASS in ${((Date.now() - t) / 1000).toFixed(0)} s`);
process.exit(0);
