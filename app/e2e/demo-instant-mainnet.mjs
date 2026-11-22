// Walks the no-wallet demo on the live site on MAINNET, as a judge would: Try it now (the owner's
// mainnet demo faucet gives a demo wallet made in the browser a few cents of real BCH), buy the
// cheapest item, refund it, then send the five cheats to a mainnet node and see each one refused.
// The demo key comes from our own mainnet test seed (env), so afterwards the script sweeps the demo
// wallet's coins back to the demo faucet: a run costs only network fees.
// Usage: node --env-file=../tools/wiz-harness/.env.local e2e/demo-instant-mainnet.mjs [url]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ElectrumNetworkProvider, TransactionBuilder, SignatureTemplate } from "cashscript";
import { secp256k1, hash160, encodeCashAddress, hexToBin, binToHex, cashAddressToLockingBytecode } from "@bitauth/libauth";

const url = process.argv[2] ?? "https://takeback-bch.vercel.app/?net=mainnet";
const seed = process.env.MAINNET_TEST_MNEMONIC;
if (!seed) { console.error("FAIL MAINNET_TEST_MNEMONIC missing from the env file"); process.exit(2); }
const demoKey = createHash("sha256").update(`takeback-e2e-mainnet-demo-wallet:${seed}`).digest("hex");
mkdirSync("e2e/videos", { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ recordVideo: { dir: "e2e/videos", size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } });
await context.addInitScript((k) => { try { localStorage.setItem("takeback-demo-key-mainnet", k); } catch {} }, demoKey);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const step = (s) => console.log("PASS", s);
const fail = async (m) => {
  console.error("FAIL", m);
  try { console.error("PAGE:", (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 1500)); } catch {}
  if (errors.length) console.error("ERRORS:", errors.slice(0, 5).join(" | "));
  await browser.close(); await sweep(); process.exit(1);
};

// Sends the demo wallet's plain coins back to the mainnet demo faucet (address read from the live API).
async function sweep() {
  try {
    const k = hexToBin(demoKey);
    const a = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload: hash160(secp256k1.derivePublicKeyCompressed(k)) });
    const addr = typeof a === "string" ? a : a.address;
    const faucet = (await (await fetch(new URL("/api/faucet?net=mainnet", url))).json()).address;
    const p = new ElectrumNetworkProvider("mainnet");
    const coins = (await p.getUtxos(addr)).filter((u) => !u.token);
    const total = coins.reduce((s, u) => s + u.satoshis, 0n), fee = 300n + 150n * BigInt(coins.length);
    if (!faucet || total - fee < 546n) return console.log("sweep: nothing to send back");
    const lb = binToHex(cashAddressToLockingBytecode(addr).bytecode);
    const tb = new TransactionBuilder({ provider: p });
    for (const u of coins) tb.addInput({ ...u, lockingBytecode: lb }, new SignatureTemplate(k).unlockP2PKH());
    tb.addOutput({ to: faucet, amount: total - fee });
    console.log(`sweep: ${total - fee} sats back to the demo faucet:`, (await tb.send()).txid);
  } catch (e) { console.log("sweep failed:", String(e).split("\n")[0]); }
}

const t = Date.now();
await page.goto(url, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Try it now, no wallet needed" }).click();
await page.waitForFunction(() => /Demo wallet .* ([1-9][0-9,]*) sats of real BCH/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => fail("demo wallet never got mainnet coins"));
step("Try it now on mainnet: demo wallet funded with real BCH by the demo faucet");
await page.locator(".menu li").first().getByRole("button", { name: "Buy" }).click({ timeout: 30_000 }).catch((e) => fail("buy: " + String(e).split("\n")[0]));
await page.waitForSelector("text=Your receipt is in your wallet", { timeout: 60_000 }).catch(() => fail("purchase didn't complete"));
step("purchase: signed in the browser, accepted by mainnet");
await page.waitForSelector(".receipts li", { timeout: 30_000 }).catch(() => fail("receipt never listed"));
await page.locator(".receipts li").first().getByRole("button", { name: "Refund", exact: true }).click({ timeout: 30_000 }).catch((e) => fail("refund: " + String(e).split("\n")[0]));
await page.waitForSelector("text=The receipt is burned", { timeout: 60_000 }).catch(() => fail("refund didn't complete"));
const timing = (await page.innerText("[role=status]")).match(/accepted it ([\d.]+) s after you pressed Refund/);
if (!timing) await fail("no timing line after the refund");
step(`refund on mainnet: co-signed, accepted ${timing[1]} s after the click, receipt burned`);
await page.getByRole("button", { name: "Send 5 cheats to mainnet" }).click({ timeout: 30_000 }).catch((e) => fail("cheats: " + String(e).split("\n")[0]));
await page.waitForSelector("text=5 of 5 refused by the network", { timeout: 90_000 }).catch(() => fail("the five cheats weren't all refused"));
step("5 of 5 cheats refused by a real mainnet node");
const status = (await page.innerText("body")).replace(/\s+/g, " ");
const txids = [...new Set(status.match(/[0-9a-f]{64}/g) ?? [])];
if (errors.length) await fail("console errors: " + errors.slice(0, 3).join(" | "));
step("no console errors");
const video = await page.video()?.path();
await context.close(); await browser.close();
console.log("video:", video);
if (txids.length) console.log("txids on the page:", txids.join(" "));
if (process.env.KEEP_DEMO_COINS !== "1") await sweep(); // KEEP_DEMO_COINS=1 for back-to-back runs
console.log(`MAINNET INSTANT DEMO: ALL PASS in ${((Date.now() - t) / 1000).toFixed(0)} s`);
process.exit(0);
