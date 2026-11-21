import { useCallback, useEffect, useMemo, useState } from "react";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";
import { hash160, hexToBin, binToHex, cashAddressToLockingBytecode } from "@bitauth/libauth";
import { TransactionBuilder, SignatureTemplate, type SpendableUtxo } from "cashscript";
import { buildPurchase, relaySafe, decodeReceipt, isMinterUtxo, p2pkhAddress, minterContract, encodeReceipt, type WalletCoin, type ShopKeys } from "./lib/takeback.ts";
import { loadShop } from "./lib/shop.ts";
import { providerFor, shopLedger, sumLedger, txLink, shortTx, type LedgerRow, type Net } from "./lib/chain.ts";
import { loadBurner, signWcInputs, feeOf, type Burner } from "./lib/burner.ts";
import contractSource from "../contracts/ReceiptMinter.cash?raw";
import proof from "./evidence/proof-summary.json";
import type { CaseResult } from "./lib/attacks.ts";
import type { FuzzSummary } from "./lib/fuzz.ts";
import "./App.css";

const params = new URLSearchParams(location.search);
// The plain link opens the mainnet shop once it exists; until then the working chipnet shop.
const NET: Net = params.get("net") === "mainnet" ? "mainnet" : params.get("net") === "chipnet" ? "chipnet" : loadShop("mainnet") ? "mainnet" : "chipnet";
const shop = loadShop(NET);
const SLIDES_URL = (import.meta.env.VITE_SLIDES_URL as string | undefined) ?? "/slides.html";
const REPO_URL = (import.meta.env.VITE_REPO_URL as string | undefined) ?? "https://github.com/kinnuworks/takeback";
const EMBER_ADDRESS = import.meta.env.VITE_EMBER_ADDRESS as string | undefined;
const STRIPE_REFUNDS = "https://docs.stripe.com/refunds";
// ?state=<name> previews one UI state with sample data, for design work. Labelled on screen.
const PREVIEW_ALIAS: Record<string, string> = { result: "paid", empty: "idle", loading: "paying" };
const PREVIEW = params.get("state") ? (PREVIEW_ALIAS[params.get("state")!] ?? params.get("state")) : null;

export const PREVIEW_STATES = ["idle", "connecting", "connected-empty", "connected", "paying", "paid", "refunding", "refunded", "error", "ledger-empty", "break-test", "demo-funding", "network-cheats"] as const;
const SAMPLE_TX = "3f1a9c2e7b6d4f0a8e5c1b2d9f7a6e4c3b2a1908f7e6d5c4b3a291807f6e5d4c";
const DEMO_FUNDS = 25_000n;

const MENU = [
  { id: 1n, name: "Kopi", note: "Black coffee", sats: 10_000n },
  { id: 2n, name: "Teh tarik", note: "Pulled milk tea", sats: 15_000n },
  { id: 3n, name: "Kaya toast", note: "Coconut jam toast", sats: 20_000n },
];

interface HeldReceipt { txid: string; vout: number; amount: bigint; orderId: bigint; address: string; path: "receive" | "change"; index: number }
interface Msg { kind: "ok" | "err"; text: string; txid?: string; secs?: number; fee?: bigint; refund?: boolean; amount?: bigint; orderId?: bigint; part?: boolean }
interface Cheat { id: string; what: string; outcome?: "refused" | "accepted"; reply?: string }

function useBchUsd() {
  const [usd, setUsd] = useState<number | null>(null);
  useEffect(() => {
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd")
      .then((r) => r.json()).then((j) => setUsd(j?.["bitcoin-cash"]?.usd ?? null)).catch(() => setUsd(null));
  }, []);
  return usd;
}
const fmtUsd = (sats: bigint, usd: number | null) => (usd ? `≈ $${((Number(sats) / 1e8) * usd).toFixed(2)}` : "");
const lbHex = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === "string") throw new Error(r); return binToHex(r.bytecode); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Why each check that survived mutation testing can be deleted without letting an attack through.
function survivorReason(check: string) {
  if (/tokenAmount == 0/.test(check)) return "no fungible tokens of the shop's category can exist: consensus only allows them at creation, and the shop made none";
  if (/receiptInput != 0/.test(check)) return "input 0 is the minter, whose minting token fails the receipt check anyway";
  if (/amount > 0|refundAmount > 0/.test(check)) return "a zero or negative amount moves no money: outputs can't be negative, and a zero refund pays nothing";
  if (/outputs\[1\]\.tokenCategory == 0x/.test(check)) return "the burn check already keeps the shop's tokens off every output after the minter";
  if (/receipt\.length == 16/.test(check)) return "purchases only mint 16-byte receipts, so no other length exists";
  return "";
}

export default function App() {
  const wc = useWizardConnect({ dappName: "Takeback", dappIcon: `${location.origin}/receipt-icon.png` });
  const usd = useBchUsd();
  const [mode, setMode] = useState<"wc" | "demo" | null>(null);
  const burner = useMemo<Burner | null>(() => (NET === "chipnet" ? loadBurner() : null), []);
  const [coins, setCoins] = useState<WalletCoin[]>([]);
  const [receipts, setReceipts] = useState<HeldReceipt[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [ledgerErr, setLedgerErr] = useState<string | null>(null);
  const [cheats, setCheats] = useState<Cheat[] | null>(null);

  const keys: ShopKeys | null = useMemo(() => shop ? { merchantPkh: hexToBin(shop.merchantPkh), refundPk: hexToBin(shop.refundPk), ownerPk: hexToBin(shop.ownerPk) } : null, []);

  // First the server's cached read (instant), then the same history read again in this browser.
  const [ledgerBy, setLedgerBy] = useState<"server" | "browser" | null>(null);
  const refreshLedger = useCallback(() => {
    if (!shop || PREVIEW) return;
    fetch(`/api/books?net=${NET}`).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j?.rows) return;
      setLedgerBy((b) => (b === "browser" ? b : "server"));
      setLedger((cur) => cur ?? j.rows.map((r: LedgerRow & { amount: string; orderId?: string }) => ({ ...r, amount: BigInt(r.amount), orderId: r.orderId ? BigInt(r.orderId) : undefined })));
    }).catch(() => undefined);
    shopLedger(shop, 2000).then((r) => { setLedger(r); setLedgerBy("browser"); setLedgerErr(null); }).catch((e) => setLedgerErr(String(e?.message ?? e)));
  }, []);
  useEffect(() => { refreshLedger(); }, [refreshLedger]);

  // Reads coins and this shop's receipts from the connected wallet (phone over WizardConnect, or the demo wallet).
  const scanWallet = useCallback(async (as: "wc" | "demo" | null = mode) => {
    if (!shop) return;
    const p = providerFor(NET);
    const found: WalletCoin[] = [];
    const held: HeldReceipt[] = [];
    const read = async (address: string, path: "receive" | "change", i: number) => {
      for (const u of await p.getUtxos(address)) {
        if (!u.token) found.push({ utxo: u, address, path, index: i });
        else if (u.token.category === shop.category && u.token.nft?.capability === "none") {
          const d = decodeReceipt(u.token.nft.commitment);
          if (d) held.push({ txid: u.txid, vout: u.vout, amount: d.amount, orderId: d.orderId, address, path, index: i });
        }
      }
    };
    if (as === "demo" && burner) await read(burner.address, "receive", 0);
    else if (wc.manager) {
      for (const [child, path, count] of [[0, "receive", 8], [1, "change", 4]] as const) {
        for (let i = 0; i < count; i++) {
          const pub = wc.manager.getPubkey(child, BigInt(i));
          if (pub) await read(p2pkhAddress(hash160(pub), NET), path, i);
        }
      }
    } else return;
    setCoins(found); setReceipts(held.sort((a, b) => Number(b.orderId - a.orderId))); setScanned(true);
    return found;
  }, [wc.manager, mode, burner]);
  useEffect(() => {
    if (wc.state === "connected") { setMode("wc"); }
    else if (mode === "wc") { setMode(null); setScanned(false); }
  }, [wc.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode) scanWallet(mode); }, [mode, scanWallet]);

  // The instant demo: a test-network wallet made in this browser, topped up by the demo faucet.
  const startDemo = useCallback(async (): Promise<WalletCoin[] | undefined> => {
    if (NET !== "chipnet") { location.href = `${location.pathname}?net=chipnet&demo=1`; return; }
    if (!burner) return;
    setMode("demo"); setBusy("faucet"); setMsg(null);
    try {
      const p = providerFor("chipnet");
      const balance = async () => (await p.getUtxos(burner.address)).filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
      if ((await balance()) < DEMO_FUNDS - 1_500n) { // enough for the dearest item after a buy-and-refund round trip
        const r = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: burner.address }) });
        const j = await r.json().catch(() => ({}));
        // A wallet that already holds enough for a coffee carries on even if the faucet can't top it up.
        if (!r.ok && (await balance()) < 13_500n) throw new Error(j.error ?? "The demo faucet didn't answer");
        if (r.ok) for (let i = 0; i < 15 && (await balance()) < DEMO_FUNDS - 1_500n; i++) await sleep(1000);
      }
      return await scanWallet("demo");
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message ?? e) });
    } finally { setBusy(null); }
  }, [burner, scanWallet]);
  useEffect(() => { if (params.get("demo") === "1" && NET === "chipnet" && !PREVIEW) startDemo(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const broadcast = async (signedHex: string) => {
    try { return await providerFor(NET).sendRawTransaction(signedHex); }
    catch (e) { if (/already|txn-already|known/i.test(String(e))) return null; throw e; }
  };

  // Buy before connecting: on chipnet the demo wallet is made and funded first; on mainnet the
  // WizardConnect QR opens.
  const buyFirst = async (item: (typeof MENU)[number]) => {
    if (connected) return buy(item);
    if (NET !== "chipnet") { wc.connect(); return; }
    const found = await startDemo();
    if (found?.length) await buy(item, { coins: found, as: "demo" });
  };

  const buy = async (item: (typeof MENU)[number], opts: { coins?: WalletCoin[]; as?: "wc" | "demo" } = {}) => {
    if (!shop || !keys) return;
    const as = opts.as ?? mode;
    const t0 = performance.now();
    setBusy(`buy-${item.id}`); setMsg(null);
    try {
      const p = providerFor(NET);
      const minters = (await p.getUtxos(shop.minterAddress)).filter((u) => isMinterUtxo(u) && u.token?.category === shop.category);
      if (!minters.length) throw new Error("The shop isn't open right now (no minter on chain)");
      const minterUtxo = minters[Math.floor(Math.random() * minters.length)];
      const receiveAddr = as === "demo" ? burner!.address : p2pkhAddress(hash160(wc.manager!.getPubkey(0, 0n)!), NET);
      const orderId = BigInt(Date.now()) * 10n + item.id;
      const plan = buildPurchase({ provider: p, keys, network: NET, minterUtxo, coins: opts.coins ?? coins, amount: item.sats, orderId, receiptTo: receiveAddr, changeTo: receiveAddr });
      let signed: string;
      if (as === "demo") signed = signWcInputs(relaySafe(plan.wc), plan.inputPaths.map((x) => x[0]), burner!);
      else {
        const res = await wc.manager!.signTransaction({ transaction: relaySafe(plan.wc) as never, inputPaths: plan.inputPaths });
        if (!res.signedTransaction) throw new Error(res.error ?? "The wallet didn't sign");
        signed = res.signedTransaction;
      }
      const txid = (await broadcast(signed)) ?? "";
      setMsg({ kind: "ok", text: `Paid ${item.sats.toLocaleString()} sats for ${item.name}. Your receipt is in your wallet.`, txid, secs: (performance.now() - t0) / 1000, fee: feeOf(relaySafe(plan.wc)), amount: item.sats, orderId });
      setTimeout(() => { scanWallet(as); refreshLedger(); }, 1200);
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message ?? e) });
    } finally { setBusy(null); }
  };

  const refund = async (r: HeldReceipt, partAmount?: bigint) => {
    const t0 = performance.now();
    setBusy(`refund-${r.txid}`); setMsg(null);
    try {
      const resp = await fetch("/api/refund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txid: r.txid, vout: r.vout, holderAddress: r.address, network: NET, amount: partAmount?.toString() }) });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error ?? "Refund request failed");
      let signed: string;
      if (mode === "demo") signed = signWcInputs(j.wc, [j.inputIndex], burner!);
      else {
        const res = await wc.manager!.signTransaction({ transaction: j.wc, inputPaths: [[j.inputIndex, r.path, r.index]] });
        if (!res.signedTransaction) throw new Error(res.error ?? "The wallet didn't sign");
        signed = res.signedTransaction;
      }
      const txid = (await broadcast(signed)) ?? "";
      const amt = BigInt(j.amount).toLocaleString();
      setMsg({ kind: "ok", text: partAmount ? `Refunded ${amt} sats. A new receipt for the rest is in your wallet.` : `Refunded ${amt} sats. The receipt is burned.`, txid, secs: (performance.now() - t0) / 1000, fee: feeOf(j.wc), refund: true, amount: BigInt(j.amount), orderId: r.orderId, part: !!partAmount });
      setTimeout(() => { scanWallet(); refreshLedger(); }, 1200);
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message ?? e) });
    } finally { setBusy(null); }
  };

  // Five cheating purchases, signed by the demo wallet and sent to a real chipnet node. A node that
  // accepts one would take the demo wallet's own test coins; every one should come back refused.
  const cheatTheNetwork = async () => {
    if (!shop || !keys || !burner) return;
    setBusy("cheats"); setCheats(null);
    try {
      const p = providerFor("chipnet");
      const minter = minterContract(keys, p);
      const ms = (await p.getUtxos(shop.minterAddress)).filter((u) => isMinterUtxo(u) && u.token?.category === shop.category);
      const plain = (await p.getUtxos(burner.address)).filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
      // Use enough of the demo wallet's coins to cover a 10,000-sat purchase, its receipt and the fee.
      const cs: SpendableUtxo[] = [];
      for (const u of plain) { if (cs.reduce((t, c) => t + c.satoshis, 0n) >= 16_000n) break; cs.push({ ...u, lockingBytecode: lbHex(burner.address) }); }
      const have = cs.reduce((t, c) => t + c.satoshis, 0n);
      if (!ms.length || have < 16_000n) throw new Error(`The demo wallet needs about 16,000 test sats for the cheats (it has ${have.toLocaleString()}): press Try it now`);
      const M: SpendableUtxo = { ...ms[0], lockingBytecode: lbHex(shop.minterAddress) };
      const sig = new SignatureTemplate(burner.priv);
      const order = BigInt(Date.now());
      const receipt = (amount: bigint, extra = 0n) => ({ to: burner.tokenAddress, amount: 2_500n, token: { category: shop.category, amount: 0n, nft: { capability: "none" as const, commitment: encodeReceipt(amount, order + extra) } } });
      type O = { to: string; amount: bigint; token?: unknown };
      const shopOut: O = { to: minter.tokenAddress, amount: M.satoshis, token: M.token };
      const list: (Cheat & { minterSecond?: boolean; outs: O[] })[] = [
        { id: "underpay", what: "Pay 9,999 sats and keep a receipt that says 10,000", outs: [shopOut, { to: shop.merchantAddress, amount: 9_999n }, receipt(10_000n)] },
        { id: "inflate", what: "Pay 10,000 sats and keep a receipt that says 1,000,000", outs: [shopOut, { to: shop.merchantAddress, amount: 10_000n }, receipt(1_000_000n)] },
        { id: "two-receipts", what: "Pay once and take two receipts", outs: [shopOut, { to: shop.merchantAddress, amount: 10_000n }, receipt(10_000n), receipt(10_000n, 1n)] },
        { id: "take-minter", what: "Send the shop's minting token to my own wallet", outs: [{ ...shopOut, to: burner.tokenAddress }, { to: shop.merchantAddress, amount: 10_000n }, receipt(10_000n)] },
        { id: "minter-second", what: "Put the shop's minter second in line, so its minting token follows my coin home", minterSecond: true, outs: [{ ...shopOut, to: burner.tokenAddress }, { to: shop.merchantAddress, amount: 10_000n }, receipt(10_000n)] },
      ];
      const done: Cheat[] = [];
      for (const c of list) {
        const tb = new TransactionBuilder({ provider: p });
        if (c.minterSecond) { tb.addInput(cs[0], sig.unlockP2PKH()).addInput(M, minter.unlock.pay()); for (const x of cs.slice(1)) tb.addInput(x, sig.unlockP2PKH()); }
        else { tb.addInput(M, minter.unlock.pay()); for (const x of cs) tb.addInput(x, sig.unlockP2PKH()); }
        for (const o of c.outs) tb.addOutput(o as never);
        const change = M.satoshis + have - c.outs.reduce((s, o) => s + o.amount, 0n) - 3_000n;
        if (change >= 546n) tb.addOutput({ to: burner.address, amount: change });
        let outcome: Cheat["outcome"], reply: string;
        try { await p.sendRawTransaction(tb.build()); outcome = "accepted"; reply = "accepted (this would be a hole)"; }
        catch (e) { outcome = "refused"; reply = String((e as Error).message ?? e).replace(/\s+/g, " ").replace(/^.*?rejected by network rules\.?\s*/i, "").slice(0, 140); }
        done.push({ id: c.id, what: c.what, outcome, reply });
        setCheats([...done]);
      }
      setTimeout(() => scanWallet("demo"), 1000);
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message ?? e) });
    } finally { setBusy(null); }
  };

  // Preview states: fake only what the state needs, everything else stays real.
  const pv = PREVIEW;
  const connected = mode === "demo" ? true : wc.state === "connected";
  const viewState = pv === "connecting" ? "connecting" : pv && !["idle", "ledger-empty", "break-test"].includes(pv) ? "connected" : connected ? "connected" : wc.state;
  const viewMode = pv === "demo-funding" || pv === "network-cheats" ? "demo" : pv && viewState === "connected" ? "wc" : mode;
  useEffect(() => {
    if (!pv) return;
    const sample: HeldReceipt[] = [
      { txid: SAMPLE_TX, vout: 2, amount: 15_000n, orderId: 17636412002n, address: "", path: "receive", index: 0 },
      { txid: SAMPLE_TX.split("").reverse().join(""), vout: 2, amount: 10_000n, orderId: 17636411001n, address: "", path: "receive", index: 0 },
    ];
    if (pv === "connected" || pv === "paid" || pv === "refunding" || pv === "paying" || pv === "network-cheats") setReceipts(sample);
    if (pv === "refunded") setReceipts(sample.slice(1));
    if (pv === "paying") setBusy("buy-1");
    if (pv === "refunding") setBusy(`refund-${SAMPLE_TX}`);
    if (pv === "demo-funding") setBusy("faucet");
    if (pv === "paid") setMsg({ kind: "ok", text: "Paid 15,000 sats for Teh tarik. Your receipt is in your wallet.", txid: SAMPLE_TX, secs: 1.6, fee: 523n, amount: 15_000n, orderId: 17636412002n });
    if (pv === "refunded") setMsg({ kind: "ok", text: "Refunded 15,000 sats. The receipt is burned.", txid: SAMPLE_TX, secs: 1.3, fee: 611n, refund: true, amount: 15_000n, orderId: 17636412002n });
    if (pv === "error") setMsg({ kind: "err", text: "Not enough BCH in the connected wallet: need about 18,000 sats, have 4,200" });
    if (pv === "network-cheats") setCheats([
      { id: "underpay", what: "Pay 9,999 sats and keep a receipt that says 10,000", outcome: "refused", reply: "mandatory-script-verify-flag-failed (Script failed an OP_NUMEQUALVERIFY operation)" },
      { id: "take-minter", what: "Send the shop's minting token to my own wallet", outcome: "refused", reply: "mandatory-script-verify-flag-failed (Script failed an OP_EQUALVERIFY operation)" },
    ]);
    if (pv === "ledger-empty") setLedger([]);
    if (pv !== "ledger-empty" && pv !== "idle") setLedger([
      { txid: SAMPLE_TX, height: 951234, kind: "sale", amount: 15_000n },
      { txid: SAMPLE_TX.split("").reverse().join(""), height: 951230, kind: "refund", amount: 10_000n },
      { txid: SAMPLE_TX.replace(/a/g, "b"), height: 951229, kind: "sale", amount: 10_000n },
    ]);
  }, [pv]);
  const totals = ledger ? sumLedger(ledger) : null;

  // Break test, fuzzer, real nodes, mutation test.
  const [breakResults, setBreakResults] = useState<CaseResult[] | null>(null);
  const [breaking, setBreaking] = useState(false);
  const [fuzz, setFuzz] = useState<{ done: number; n: number; s: FuzzSummary; seed: number } | null>(null);
  const [showReal, setShowReal] = useState(false);
  const sourceLines = contractSource.split("\n");
  const runBreakTest = async () => {
    setBreaking(true);
    await sleep(30);
    const { runAll } = await import("./lib/attacks.ts");
    setBreakResults(runAll());
    setBreaking(false);
  };
  const runFuzzNow = async () => {
    const { runFuzz } = await import("./lib/fuzz.ts");
    const seed = Math.floor(Math.random() * 1e9), n = 2_000;
    await runFuzz(seed, n, (done, s) => setFuzz({ done, n, s, seed }));
  };
  useEffect(() => { if (pv === "break-test") runBreakTest(); }, [pv]); // eslint-disable-line react-hooks/exhaustive-deps
  const lineText = (detail: string) => { const n = Number(detail.match(/line (\d+)/)?.[1]); return n ? sourceLines[n - 1]?.trim() : ""; };
  const rn = proof.realNode, fz = proof.fuzz, mu = proof.mutants;
  const nAttacks = rn.cases.filter((c) => c.kind === "attack").length;
  const broke = fz.counts["agree-refused"] + fz.counts.hole;

  // The printed receipt beside the menu: the result of a purchase or refund, else the newest
  // receipt in the wallet, else the shop's latest sale read from the chain.
  const itemOf = (o?: bigint) => (o === undefined ? undefined : MENU.find((m) => m.id === o % 10n));
  const latestSale = ledger?.find((r) => r.kind === "sale");
  type SlipMode = "paid" | "held" | "refunded" | "latest" | "loading" | "empty";
  let slip: { mode: SlipMode; amount?: bigint; orderId?: bigint; txid?: string; held?: HeldReceipt; part?: boolean };
  if (msg?.kind === "ok" && msg.refund) slip = { mode: "refunded", amount: msg.amount, orderId: msg.orderId, txid: msg.txid, part: msg.part };
  else if (msg?.kind === "ok") slip = { mode: "paid", amount: msg.amount, orderId: msg.orderId, txid: msg.txid, held: receipts.find((r) => r.txid === msg.txid) };
  else if (viewState === "connected" && receipts.length) slip = { mode: "held", amount: receipts[0].amount, orderId: receipts[0].orderId, txid: receipts[0].txid, held: receipts[0] };
  else if (latestSale) slip = { mode: "latest", amount: latestSale.amount, orderId: latestSale.orderId, txid: latestSale.txid };
  else slip = { mode: ledger || ledgerErr || !shop ? "empty" : "loading" };
  const slipItem = itemOf(slip.orderId);
  const canRefund = (h?: HeldReceipt) => !!h && viewState === "connected";
  const [replay, setReplay] = useState(0);
  useEffect(() => { (window as unknown as { design?: { onReplay?: (f: () => void) => void } }).design?.onReplay?.(() => setReplay((n) => n + 1)); }, []);
  const slipKey = `${slip.mode}-${slip.txid ?? ""}-${replay}`;
  useEffect(() => {
    if (!msg || pv) return;
    document.querySelector(".slip")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [msg, pv]);
  const netLabel = NET === "chipnet" ? "chipnet (test network)" : "mainnet";
  const refundButtons = (h: HeldReceipt) => (
    <>
      <button className="tb-btn" disabled={!!busy} onClick={() => refund(h)}>{busy === `refund-${h.txid}` ? (viewMode === "demo" ? "Refunding…" : "Waiting for your wallet…") : "Refund"}</button>
      {h.amount >= 1092n && <button className="tb-btn tb-btn--ghost" disabled={!!busy} onClick={() => refund(h, h.amount / 2n)}>Refund half</button>}
    </>
  );

  return (
    <div className="tb">
      <div className="tb-binder" aria-hidden="true"><i /><i /></div>
      {pv && <div className="tb-preview">Illustration: preview of the "{pv}" state with sample data, not real transactions.</div>}
      <header className="tb-top" role="note" aria-label="BCH BLAZE 2026 entry">
        <div className="tb-top__inner">
          <a className="tb-brand" href={`/?net=${NET}`}><span className="tb-brand__mark" aria-hidden="true" />Takeback</a>
          <span className="tb-top__event">BCH BLAZE 2026 entry</span>
          <nav className="tb-top__links" aria-label="Entry links">
            <a href={REPO_URL}>Source code</a>
            <a className="tb-top__sec" href="#books">The books</a>
            <a className="tb-top__sec" href="#proof">The proof</a>
          </nav>
          <span className="tb-top__ember">EMBER2026 votes: {EMBER_ADDRESS ? <code>{EMBER_ADDRESS}</code> : <span className="tb-muted">address coming soon</span>}</span>
          {SLIDES_URL ? <a className="tb-top__slides" href={SLIDES_URL}>Slides</a> : <span className="tb-muted">Slides: coming soon</span>}
        </div>
      </header>

      <main className="tb-main">
        <section className="tb-hero">
          <div className="tb-hero__head"><h1>Pay with Bitcoin Cash, get a receipt that refunds.</h1></div>
          <div className="tb-hero__side">
            <p className="tb-hero__deck">Every purchase puts a receipt token in your wallet in the same transaction. The shop can refund exactly what's on the receipt, to whoever holds it, once. The contract refuses anything else.</p>
            {viewState !== "connected" ? (
              <>
                <div className="tb-hero__actions">
                  <button className="tb-btn tb-btn--lg" onClick={startDemo} disabled={!!busy}>Try it now, no wallet needed</button>
                  <button className="tb-btn tb-btn--lg tb-btn--ghost" onClick={() => wc.connect()}>Connect wallet{NET === "mainnet" ? " (real BCH)" : ""}</button>
                </div>
                <p className="tb-hero__hint"><span>Uses the test network: a demo wallet is made in this browser and gets free test coins.</span> <span>Scan with Paytaca or Selene (WizardConnect).</span></p>
              </>
            ) : viewMode === "demo" ? (
              <p className="tb-wallet">
                {busy === "faucet" ? "Making a demo wallet and getting test coins…" : <>Demo wallet <code>{burner ? shortTx(burner.address.replace("bchtest:", "")) : "bchtest:…"}</code> · {pv ? "25,000" : coins.reduce((s, c) => s + c.utxo.satoshis, 0n).toLocaleString()} test sats · test coins have no value</>}
              </p>
            ) : (
              <p className="tb-wallet">Connected: {pv ? "Paytaca" : wc.walletName ?? "wallet"} · {pv ? 3 : coins.length} coins · <button className="tb-link" onClick={() => wc.disconnect()}>Disconnect</button></p>
            )}
          </div>
        </section>

        {!shop && <p className="tb-notice">The {NET} demo shop isn't set up yet.</p>}

        <section className="tb-stage" aria-label="Demo shop">
          <div className="tb-window">
            <div className="tb-window__body">
              <aside className="tb-side" aria-hidden="true">
                <b className="tb-side__shop">{shop?.name ?? "Kopi Blaze"}</b>
                <span className="tb-side__item is-on">Menu</span>
                <span className="tb-side__item">Receipts</span>
                <span className="tb-side__item">Books</span>
                <span className="tb-side__label">Paid in</span>
                <span className="tb-side__item">BCH on {NET}</span>
              </aside>
              <div className="tb-shop">
                <h2 className="tb-shop__title">{shop?.name ?? "Kopi Blaze"} <span className="tb-muted">demo shop on {netLabel}</span></h2>
                <ul className="menu">
                  {MENU.map((m) => (
                    <li key={String(m.id)} className="menu__item">
                      <div className="menu__name"><b>{m.name}</b> <span className="tb-muted">{m.note}</span></div>
                      <div className="menu__price"><span className="tb-num">{m.sats.toLocaleString()} sats</span> <span className="tb-muted">{NET === "mainnet" ? fmtUsd(m.sats, usd) : "test coins"}</span></div>
                      <button className="tb-btn" disabled={!!busy || (!pv && viewState === "connected" && !scanned) || (!pv && !shop)} onClick={() => buyFirst(m)}>{busy === `buy-${m.id}` ? (viewMode === "demo" ? "Paying…" : "Waiting for your wallet…") : busy === "faucet" ? "Getting test coins…" : !pv && viewState === "connected" && !scanned ? "Reading your wallet…" : "Buy"}</button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="tb-slipcol">
                <article key={slipKey} className={`slip slip--${slip.mode}`} aria-label="Receipt">
                  <div className="slip__paper">
                    <div className="slip__head"><b>{(shop?.name ?? "Kopi Blaze").toUpperCase()}</b><span>demo shop · {NET}</span></div>
                    <p className="slip__kicker">{slip.mode === "latest" ? "Latest sale on the shop's books, read from the chain" : slip.mode === "refunded" ? "Refund" : slip.mode === "loading" ? "Reading the shop's books…" : slip.mode === "empty" ? (ledger ? "No sales on the shop's books yet. Buy something and your receipt prints here." : "Couldn't read the shop's books from the chain. Buy something and your receipt prints here.") : "Your receipt"}</p>
                    {slip.mode !== "loading" && slip.mode !== "empty" && (
                      <>
                        <dl className="slip__rows">
                          <div><dt>{slipItem?.name ?? "Purchase"}</dt><dd className="tb-num">{slip.amount?.toLocaleString()} sats</dd></div>
                          {slip.orderId !== undefined && <div><dt>Order</dt><dd className="tb-num">{String(slip.orderId).slice(-6)}</dd></div>}
                          <div><dt>Receipt token</dt><dd>{slip.mode === "refunded" ? "burned" : slip.mode === "latest" ? "in the buyer's wallet" : "in your wallet"}</dd></div>
                        </dl>
                        <div className="slip__total"><span>{slip.mode === "refunded" ? "Refunded" : "Refundable"}</span><span className="tb-num">{slip.amount?.toLocaleString()} sats</span></div>
                        {slip.txid && <a className="slip__tx" href={txLink(NET, slip.txid)} target="_blank" rel="noreferrer">Transaction {shortTx(slip.txid)}</a>}
                      </>
                    )}
                    {slip.mode === "refunded" && <span className="slip__stamp" aria-hidden="true">Refunded</span>}
                  </div>
                  {slip.held && canRefund(slip.held) && slip.mode !== "refunded" && <div className="slip__actions">{refundButtons(slip.held)}</div>}
                  {slip.held && canRefund(slip.held) && slip.mode !== "refunded" && <p className="slip__note">You press Refund. The shop's server co-signs right away, and the contract fixes the amount and who gets it.</p>}
                  {slip.mode === "paid" && !slip.held && viewState === "connected" && <p className="slip__note">Reading your wallet…</p>}
                </article>
                {msg && (
                  <div className={`tb-msg ${msg.kind === "ok" ? "tb-ok" : "tb-err"}`} role="status">
                    <p>{msg.text} {msg.txid && <a href={txLink(NET, msg.txid)} target="_blank" rel="noreferrer">View transaction {shortTx(msg.txid)}</a>}</p>
                    {msg.secs !== undefined && (
                      <p className="tb-small">
                        The network accepted it {msg.secs.toFixed(1)} s after you pressed {msg.refund ? "Refund" : "Buy"}{viewMode === "wc" ? " (including your approval in the wallet)" : ""}. Network fee: {msg.fee?.toLocaleString()} sats.
                        {msg.refund && <> A card refund reaches the customer about 5 to 10 business days later (<a href={STRIPE_REFUNDS} target="_blank" rel="noreferrer">Stripe's refund docs</a>).</>}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {viewState === "connected" && (
          <section className="tb-sec tb-receipts" id="receipts">
            <div className="tb-sec__head"><h2>Your receipts</h2></div>
            {receipts.length === 0 ? <p className="tb-muted">No receipts from this shop in this wallet yet. Buy something above.</p> : (
              <ul className="receipts">
                {receipts.map((r) => (
                  <li key={`${r.txid}:${r.vout}`}>
                    <div className="receipts__what"><b className="tb-num">{r.amount.toLocaleString()} sats</b> <span className="tb-muted">{itemOf(r.orderId)?.name ?? "order"} · order {String(r.orderId).slice(-6)}</span></div>
                    <a href={txLink(NET, r.txid)} target="_blank" rel="noreferrer">{shortTx(r.txid)}</a>
                    <span className="receipts__actions">{refundButtons(r)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {viewMode === "demo" && (
          <section className="tb-sec tb-cheats" id="cheats">
            <div className="tb-sec__head">
              
              <h2>Try to cheat the real network</h2>
              <p>Your demo wallet signs five cheating purchases and sends them to a real chipnet node. If a node accepted one, your wallet would pay for it. Each comes back with the node's own answer.</p>
              <button className="tb-btn" onClick={cheatTheNetwork} disabled={!!busy || (!pv && !scanned)}>{busy === "cheats" ? "Sending cheats to chipnet…" : "Send 5 cheats to chipnet"}</button>
            </div>
            {cheats && (
              <div className="tb-out">
                <p className={cheats.every((c) => c.outcome === "refused") ? "tb-ok" : "tb-err"}><b>{cheats.filter((c) => c.outcome === "refused").length} of {cheats.length} refused by the network.</b></p>
                <div className="tb-table-wrap"><table className="tb-table">
                  <thead><tr><th>What the cheat tries</th><th>Node's answer</th></tr></thead>
                  <tbody>{cheats.map((c) => <tr key={c.id}><td>{c.what}</td><td className={c.outcome === "refused" ? "tb-ok" : "tb-err"}><code>{c.reply}</code></td></tr>)}</tbody>
                </table></div>
              </div>
            )}
          </section>
        )}

        <section className="tb-sec tb-books" id="books">
          <div className="tb-sec__head">
            
            <h2>The shop's books, read from the chain</h2>
            {ledgerErr && <p className="tb-err">Couldn't read the chain: {ledgerErr}</p>}
            {!shop && <p className="tb-muted">The shop opens once its minter contract is on chain.</p>}
            {shop && !ledger && !ledgerErr && <p className="tb-muted">Reading the minter's history…</p>}
            {totals && (
              <p>{totals.sales} {totals.sales === 1 ? "sale" : "sales"} ({totals.salesSats.toLocaleString()} sats) · {totals.refunds} {totals.refunds === 1 ? "refund" : "refunds"} ({totals.refundSats.toLocaleString()} sats) · net {totals.netSats.toLocaleString()} sats across all {ledger?.length ?? 0} of the shop's transactions{NET === "chipnet" ? " · all test transactions from our wallets and visitors' demo wallets" : ""}
                {!pv && <span className="tb-muted tb-small"> · {ledgerBy === "browser" ? "read from the chain by this page" : "read from the chain by our server; rereading it in your browser…"}</span>}</p>
            )}
          </div>
          <div className="tb-out">
            {totals && (
              <dl className="tb-totals">
                <div><dt>Sales</dt><dd className="tb-num">{totals.salesSats.toLocaleString()} <small>sats</small></dd></div>
                <div><dt>Refunds</dt><dd className="tb-num">{totals.refundSats.toLocaleString()} <small>sats</small></dd></div>
                <div><dt>Net</dt><dd className="tb-num">{totals.netSats.toLocaleString()} <small>sats</small></dd></div>
              </dl>
            )}
            {ledger && ledger.length > 0 && (
              <div className="tb-table-wrap"><table className="tb-table">
                <thead><tr><th>What</th><th className="tb-r">Amount</th><th>Transaction</th></tr></thead>
                <tbody>
                  {ledger.filter((r) => r.kind !== "other").slice(0, 12).map((r) => (
                    <tr key={r.txid}><td>{r.kind}</td><td className="tb-r tb-num">{r.amount ? `${r.amount.toLocaleString()} sats` : ""}</td><td><a href={txLink(NET, r.txid)} target="_blank" rel="noreferrer">{shortTx(r.txid)}</a></td></tr>
                  ))}
                </tbody>
              </table></div>
            )}
            {shop && <p className="tb-muted tb-small">Minter contract: <code>{shop.minterAddress}</code> · receipt category <code>{shop.category.slice(0, 12)}…</code></p>}
            {shop && <p className="tb-small">Check the receipt token on an independent explorer: <a href={`https://tokenexplorer.cash/?tokenId=${shop.category}&network=${NET}`} target="_blank" rel="noreferrer">tokenexplorer.cash</a> shows its name, icon and receipt fields, and checks the metadata against its hash on chain.</p>}
          </div>
        </section>

        <section className="tb-sec tb-proof" id="proof">
          <div className="tb-sec__head">
            
            <h2>Try to cheat the contract</h2>
            <p>Four ways we tried to break it. Each reruns from the repo with one command.</p>
          </div>
          <ol className="tb-layers">
            <li className="tb-layer">
              <div className="tb-layer__text">
                <h3>1. {nAttacks} attacks we wrote down before running them</h3>
                <p>Over-refunds, second refunds, refunds to someone else, underpaid purchases that still get a receipt, stolen minting tokens, a stolen server key. Your browser runs each one against the real contract on a local copy of the BCH virtual machine.</p>
                <button className="tb-btn" onClick={runBreakTest} disabled={breaking}>{breaking ? "Running the cases…" : "Run the attacks"}</button>
              </div>
              {breakResults && (() => {
                const attacks = breakResults.filter((r) => r.kind === "attack");
                const rejected = attacks.filter((r) => r.outcome === "rejected").length;
                const valid = breakResults.filter((r) => r.kind === "valid" && r.outcome !== "not-applicable");
                return (
                  <div className="tb-layer__out">
                    <p className={rejected === attacks.length ? "tb-ok" : "tb-err"}><b>{rejected} of {attacks.length} attacks refused by the contract.</b> {valid.filter((r) => r.ok).length} of {valid.length} honest purchases and refunds went through.</p>
                    <div className="tb-table-wrap"><table className="tb-table">
                      <thead><tr><th>Case</th><th>What it tries</th><th>Result</th><th>The rule that stopped it</th></tr></thead>
                      <tbody>
                        {breakResults.map((r) => (
                          <tr key={r.id}><td>{r.id}</td><td>{r.what}</td><td className={r.ok ? "tb-ok" : "tb-err"}>{r.outcome}</td><td><code>{r.outcome === "rejected" ? lineText(r.detail) : ""}</code></td></tr>
                        ))}
                      </tbody>
                    </table></div>
                  </div>
                );
              })()}
            </li>

            <li className="tb-layer">
              <div className="tb-layer__text">
                <h3>2. The same attacks, sent to real nodes</h3>
                <p><b>{rn.refused} of {rn.built} refused by two independent chipnet servers</b> ({rn.byContract} by the contract, {rn.byConsensus} by the network's own token rules). Each was built from the shop's real coins and signed with real keys, including the shop's server key, as if it had been stolen. {rn.validAccepted} of {rn.validRun} honest purchases and refunds went through in the same run.</p>
                <button className="tb-btn tb-btn--ghost" onClick={() => setShowReal(!showReal)}>{showReal ? "Hide" : "Show"} every node reply</button>
              </div>
              {showReal && (
                <div className="tb-layer__out"><div className="tb-table-wrap"><table className="tb-table">
                  <thead><tr><th>Case</th><th>What it tries</th><th>Node's answer</th></tr></thead>
                  <tbody>{rn.cases.map((c) => (
                    <tr key={c.id}><td>{c.id}</td><td>{c.what}</td><td className={c.kind === "valid" ? (c.outcome === "accepted" ? "tb-ok" : "tb-err") : c.outcome === "refused" ? "tb-ok" : "tb-err"}>{c.kind === "valid" ? <a href={txLink("chipnet", c.txid ?? "")} target="_blank" rel="noreferrer">accepted {shortTx(c.txid ?? "")}</a> : <code>{c.reply}</code>}</td></tr>
                  ))}</tbody>
                </table></div></div>
              )}
            </li>

            <li className="tb-layer">
              <div className="tb-layer__text">
                <h3>3. {fz.n.toLocaleString()} random transactions, judged twice</h3>
                <p>A fuzzer bends valid purchases and refunds at random (amounts, recipients, tokens, input order, signers) and asks two judges: the contract on the BCH virtual machine, and a separate model of our written rules. On the counted run, <b>{fz.counts["agree-refused"].toLocaleString()} of {broke.toLocaleString()} rule-breaking transactions were refused</b> and {fz.counts["agree-accepted"].toLocaleString()} of {(fz.counts["agree-accepted"] + fz.counts["too-strict"]).toLocaleString()} allowed ones went through. On the contract's first version it found a gap: {fz.v1Holes} cases where a purchase could rewrite the shop's own minting token. No money was at risk; we fixed it before mainnet.</p>
                <button className="tb-btn" onClick={runFuzzNow} disabled={!!fuzz && fuzz.done < fuzz.n}>{fuzz && fuzz.done < fuzz.n ? `Fuzzing… ${fuzz.done.toLocaleString()} of ${fuzz.n.toLocaleString()}` : "Fuzz 2,000 more in your browser"}</button>
              </div>
              {fuzz && (
                <div className="tb-layer__out">
                  <p className={fuzz.s.counts.hole === 0 ? "tb-ok" : "tb-err"}>
                    Seed {fuzz.seed}: {fuzz.done.toLocaleString()} tried · {(fuzz.s.counts["agree-refused"] + fuzz.s.counts.hole).toLocaleString()} broke a rule · {fuzz.s.counts["agree-refused"].toLocaleString()} refused · <b>{fuzz.s.counts.hole} got through</b> · {fuzz.s.counts["too-strict"]} honest ones refused
                  </p>
                </div>
              )}
            </li>

            <li className="tb-layer">
              <div className="tb-layer__text">
                <h3>4. Every check that guards money is needed</h3>
                <p>We deleted each check in the contract, one at a time, and reran everything. <b>{mu.killed} of {mu.compiled} deletions let an attack through</b>, so a test catches each of those. The other {mu.survivors.length} are checks another rule or the network already covers:</p>
              </div>
              <div className="tb-layer__out">
                <ul className="tb-survivors">
                  {mu.survivors.map((s) => <li key={s.line}><code>{s.check}</code> ({s.fn}): {survivorReason(s.check)}</li>)}
                </ul>
              </div>
            </li>
          </ol>
        </section>
      </main>

      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog show={wc.state === "connecting" && !pv} onClose={() => wc.disconnect()} uri={wc.uri} qrUri={wc.qrUri} title="Connect your wallet" subtitle="Scan with Paytaca or Selene" />
      )}
      {pv === "connecting" && <p className="tb-notice">(Preview) The WizardConnect QR dialog opens here; press Connect on the live page to see the real one.</p>}
      <footer className="tb-foot"><span>Takeback · built for BCH BLAZE 2026.</span> <a href={REPO_URL}>Source code</a> <a href={SLIDES_URL}>Slides</a></footer>
    </div>
  );
}
