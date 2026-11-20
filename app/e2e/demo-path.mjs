// Walks the judge's demo path in a real browser and records a video of it (e2e/videos/).
// 1. the page loads with the required banner, the tagline and the menu, with no console errors
// 2. Connect opens a WizardConnect QR; the headless test wallet "scans" its URI over the real relay
// 3. the page shows the wallet as connected
// With E2E_FULL=1 (needs a funded wallet and the shop set up on the chosen network) it also buys
// the cheapest item, checks the receipt appears, refunds it and checks the receipt is gone.
// Usage: node e2e/demo-path.mjs [url]   (default: builds and serves the app locally)
// Full chipnet run: E2E_FULL=1 E2E_MNEMONIC_ENV=CHIPNET_TEST_MNEMONIC node --env-file=../tools/wiz-harness/.env.local e2e/demo-path.mjs "https://takeback-bch.vercel.app/?net=chipnet"
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { startTestWallet } from "../../tools/wiz-harness/testwallet.mjs";

const FULL = process.env.E2E_FULL === "1";
// E2E_MNEMONIC_ENV names the env variable that holds the seed (so it never sits on a command line).
const mnemonic = (process.env.E2E_MNEMONIC_ENV && process.env[process.env.E2E_MNEMONIC_ENV]) || process.env.E2E_MNEMONIC || "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
let server;
let url = process.argv[2];
const fail = async (msg) => {
  console.error("FAIL", msg);
  try { const t = await page.innerText("main, body"); console.error("PAGE:", t.replace(/\s+/g, " ").slice(0, 1500)); } catch {}
  if (errors?.length) console.error("ERRORS:", errors.slice(0, 5).join(" | "));
  await cleanup(); process.exit(1);
};
let browser;
async function cleanup() { try { await browser?.close(); } catch {} if (server) server.kill(); }

if (!url) {
  server = spawn("npx", ["vite", "preview", "--port", "5192", "--strictPort"], { stdio: "pipe" });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => /5192/.test(String(d)) && resolve());
    server.on("exit", (c) => reject(new Error("preview server exited " + c)));
    setTimeout(() => reject(new Error("preview server didn't start")), 30_000);
  });
  url = "http://localhost:5192/";
}
mkdirSync("e2e/videos", { recursive: true });
browser = await chromium.launch();
const context = await browser.newContext({ recordVideo: { dir: "e2e/videos", size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const step = (s) => console.log("PASS", s);
await page.goto(url, { waitUntil: "networkidle" });
const text = await page.innerText("body");
if (!/BCH BLAZE 2026/.test(text) || !/Source code/.test(text) || !/EMBER2026/.test(text)) await fail("banner missing (event, source link, EMBER2026 address)");
step("banner with event, source link and EMBER2026 line");
if (!/Pay with Bitcoin Cash, get a receipt that refunds\./.test(text)) await fail("tagline missing");
step("tagline");
if ((await page.locator(".menu li").count()) < 3) await fail("menu missing");
step("menu with 3 items");

await page.getByRole("button", { name: /Connect wallet/ }).click();
const uri = await page.waitForFunction(() => (document.body.innerText.match(/wiz:\/\/\S+/i) || [null])[0], null, { timeout: 15_000 }).then((h) => h.jsonValue()).catch(() => null);
if (!uri) await fail("no WizardConnect URI shown after Connect");
step("WizardConnect QR shows a pairing URI");
const { manager } = startTestWallet({ mnemonic, network: url.includes("net=chipnet") ? "chipnet" : "mainnet" });
manager.connect(uri);
await page.waitForSelector("text=Connected:", { timeout: 45_000 }).catch(() => fail("page never showed the wallet as connected"));
step("page shows the wallet connected over the real relay");

if (FULL) {
  const before = await page.locator(".receipts li").count();
  await page.locator(".menu li").first().getByRole("button", { name: "Buy" }).click({ timeout: 60_000 }).catch((e) => fail("buy button: " + String(e).split("\n")[0]));
  await page.waitForSelector("text=Your receipt is in your wallet", { timeout: 60_000 }).catch(() => fail("purchase didn't complete"));
  step("purchase: wallet signed, page reports the receipt");
  await page.waitForFunction((n) => document.querySelectorAll(".receipts li").length > n, before, { timeout: 60_000 }).catch(() => fail("receipt didn't appear in the wallet list"));
  step("receipt appears under Your receipts");
  await page.locator(".receipts li").first().getByRole("button", { name: "Refund", exact: true }).click({ timeout: 30_000 }).catch((e) => fail("refund button: " + String(e).split("\n")[0]));
  await page.waitForSelector("text=The receipt is burned", { timeout: 60_000 }).catch(() => fail("refund didn't complete"));
  step("refund: co-signed, wallet signed, receipt burned");
}

if (errors.length) await fail("console errors: " + errors.slice(0, 3).join(" | "));
step("no console errors");
const video = await page.video()?.path();
await context.close();
console.log("video:", video);
await cleanup();
manager.disconnectAll?.();
console.log("DEMO PATH: ALL PASS");
process.exit(0);
