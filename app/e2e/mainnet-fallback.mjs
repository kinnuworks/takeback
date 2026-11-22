// On mainnet, "Try it now" must never end in an error when the owner's mainnet demo faucet can't pay:
// an empty faucet, or one that refuses (hourly limit), sends the visitor to the chipnet demo instead.
// Runs against a local preview build; the faucet API is answered by the test, the chain is real.
// Usage: node e2e/mainnet-fallback.mjs   (after npm run build; needs src/shop/mainnet.json set up)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

if (JSON.parse(readFileSync("src/shop/mainnet.json", "utf8")).notSetUp) { console.error("FAIL the mainnet shop isn't set up in src/shop/mainnet.json"); process.exit(1); }
const server = spawn("npx", ["vite", "preview", "--port", "5193"], { stdio: "pipe", detached: true });
const base = await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => { const m = String(d).replace(/\x1b\[[0-9;]*m/g, "").match(/http:\/\/localhost:(\d+)\//); if (m) resolve(m[0]); });
  server.on("exit", (c) => reject(new Error("preview server exited " + c)));
  setTimeout(() => reject(new Error("preview server didn't start")), 30_000);
});
for (const sig of ["SIGTERM", "SIGALRM", "SIGINT"]) process.on(sig, () => { try { process.kill(-server.pid); } catch {} process.exit(1); });
const browser = await chromium.launch();
let failed = false;
const done = async () => { await browser.close(); try { process.kill(-server.pid); } catch {} process.exit(failed ? 1 : 0); };

async function scenario(name, faucetGet, faucetPost) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.route("**/api/faucet**", (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(faucetGet) });
    if (new URL(req.url()).searchParams.get("net") === "chipnet" || /chipnet/.test(req.postData() ?? "")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ network: "chipnet", enabled: true, balance: "100000" }) });
    return route.fulfill({ status: faucetPost.status, contentType: "application/json", body: JSON.stringify(faucetPost.body) });
  });
  await page.goto(`${base}?net=mainnet`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Try it now/ }).first().click();
  const moved = await page.waitForURL(/net=chipnet/, { timeout: 20_000 }).then(() => true).catch(() => false);
  const body = (await page.innerText("body")).replace(/\s+/g, " ");
  if (moved) console.log("PASS", name, "-> the chipnet demo");
  else { failed = true; console.log("FAIL", name, "stayed on mainnet:", (body.match(/[^.]*(faucet|limit|error)[^.]*\./i) || [body.slice(0, 200)])[0]); }
  await context.close();
}

await scenario("mainnet faucet empty", { network: "mainnet", enabled: true, address: "x", balance: "0" }, { status: 503, body: { error: "The demo faucet is empty right now" } });
await scenario("mainnet faucet at its hourly limit", { network: "mainnet", enabled: true, address: "x", balance: "250000" }, { status: 429, body: { error: "The demo faucet has reached its hourly limit; try again later" } });
console.log(failed ? "MAINNET FALLBACK: FAIL" : "MAINNET FALLBACK: ALL PASS");
await done();
