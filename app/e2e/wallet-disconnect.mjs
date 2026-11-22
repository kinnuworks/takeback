// When the phone wallet ends the WizardConnect session from its side, the page must notice: the
// "Connected" line goes away and Connect wallet comes back, instead of waiting forever.
// Pairs the headless test wallet over the real relay, disconnects from the wallet, watches the page.
// Usage: node e2e/wallet-disconnect.mjs [url]   (default https://takeback-bch.vercel.app/)
import { chromium } from "playwright";
import { startTestWallet } from "../../tools/wiz-harness/testwallet.mjs";

const url = process.argv[2] ?? "https://takeback-bch.vercel.app/";
const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const step = (s) => console.log("PASS", s);
const fail = async (m) => {
  console.log("FAIL", m);
  try { console.log("PAGE:", (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 600)); } catch {}
  await browser.close(); process.exit(1);
};
await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Connect wallet/ }).first().click();
const uri = await page.waitForFunction(() => (document.body.innerText.match(/wiz:\/\/\S+/i) || [null])[0], null, { timeout: 15_000 }).then((h) => h.jsonValue()).catch(() => null);
if (!uri) await fail("no WizardConnect URI shown after Connect");
const { manager } = startTestWallet({ mnemonic, network: url.includes("net=chipnet") ? "chipnet" : "mainnet" });
manager.connect(uri);
await page.waitForSelector("text=Connected:", { timeout: 45_000 }).catch(() => fail("page never showed the wallet as connected"));
step("wallet paired over the real relay");
manager.disconnectAll();
const t0 = Date.now();
const gone = await page.waitForFunction(() => !/Connected:/.test(document.body.innerText) && [...document.querySelectorAll("button")].some((b) => /Connect wallet/.test(b.textContent ?? "")), null, { timeout: 30_000 }).then(() => true).catch(() => false);
if (!gone) await fail("30 s after the wallet disconnected, the page still shows it as connected");
step(`page noticed the wallet's disconnect after ${((Date.now() - t0) / 1000).toFixed(1)} s and offers Connect wallet again`);
const stuck = /finding a secure connection|connecting/i.test(await page.innerText("body"));
if (stuck) await fail("page shows a stuck connecting message after the disconnect");
step("no stuck connecting message");
console.log("WALLET DISCONNECT: ALL PASS");
await browser.close();
process.exit(0);
