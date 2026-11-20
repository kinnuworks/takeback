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
const NET: Net = params.get("net") === "chipnet" ? "chipnet" : "mainnet";
const shop = loadShop(NET);
const SLIDES_URL = import.meta.env.VITE_SLIDES_URL as string | undefined;
const REPO_URL = (import.meta.env.VITE_REPO_URL as string | undefined) ?? "https://github.com/kinnuworks/takeback";
const EMBER_ADDRESS = import.meta.env.VITE_EMBER_ADDRESS as string | undefined;
const STRIPE_REFUNDS = "https://docs.stripe.com/refunds";
// ?state=<name> previews one UI state with sample data, for design work. Labelled on screen.
const PREVIEW = params.get("state");
export const PREVIEW_STATES = ["idle", "connecting", "connected-empty", "connected", "paying", "paid", "refunding", "refunded", "error", "ledger-empty", "break-test", "demo-funding", "network-cheats"] as const;
const SAMPLE_TX = "3f1a9c2e7b6d4f0a8e5c1b2d9f7a6e4c3b2a1908f7e6d5c4b3a291807f6e5d4c";
const DEMO_FUNDS = 25_000n;

const MENU = [
  { id: 1n, name: "Kopi", note: "Black coffee", sats: 10_000n },
  { id: 2n, name: "Teh tarik", note: "Pulled milk tea", sats: 15_000n },
  { id: 3n, name: "Kaya toast", note: "Coconut jam toast", sats: 20_000n },
];

interface HeldReceipt { txid: string; vout: number; amount: bigint; orderId: bigint; address: string; path: "receive" | "change"; index: number }
interface Msg { kind: "ok" | "err"; text: string; txid?: string; secs?: number; fee?: bigint; refund?: boolean }
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

  const refreshLedger = useCallback(() => {
    if (!shop || PREVIEW) return;
    shopLedger(shop, 80).then((r) => { setLedger(r); setLedgerErr(null); }).catch((e) => setLedgerErr(String(e?.message ?? e)));
  }, []);
  useEffect(() => { refreshLedger(); }, [refreshLedger]);

  // Reads coins and this shop's receipts from the connected wallet (phone over WizardConnect, or the demo wallet).
  const scanWallet = useCallback(async () => {
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
    if (mode === "demo" && burner) await read(burner.address, "receive", 0);
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
  useEffect(() => { if (mode) scanWallet(); }, [mode, scanWallet]);

  // The instant demo: a test-network wallet made in this browser, topped up by the demo faucet.
  const startDemo = useCallback(async () => {
    if (NET !== "chipnet") { location.href = `${location.pathname}?net=chipnet&demo=1`; return; }
    if (!burner) return;
    setMode("demo"); setBusy("faucet"); setMsg(null);
    try {
      const p = providerFor("chipnet");
      const balance = async () => (await p.getUtxos(burner.address)).filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
      if ((await balance()) < DEMO_FUNDS - 1_500n) { // enough for the dearest item after a buy-and-refund round trip
        const r = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: burner.address }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "The demo faucet didn't answer");
        for (let i = 0; i < 15 && (await balance()) < DEMO_FUNDS; i++) await sleep(1000);
      }
      await scanWallet();
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message ?? e) });
    } finally { setBusy(null); }
  }, [burner, scanWallet]);
  useEffect(() => { if (params.get("demo") === "1" && NET === "chipnet" && !PREVIEW) startDemo(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const broadcast = async (signedHex: string) => {
    try { return await providerFor(NET).sendRawTransaction(signedHex); }
    catch (e) { if (/already|txn-already|known/i.test(String(e))) return null; throw e; }
  };

  const buy = async (item: (typeof MENU)[number]) => {
    if (!shop || !keys) return;
    const t0 = performance.now();
    setBusy(`buy-${item.id}`); setMsg(null);
    try {
      const p = providerFor(NET);
      const minters = (await p.getUtxos(shop.minterAddress)).filter((u) => isMinterUtxo(u) && u.token?.category === shop.category);
      if (!minters.length) throw new Error("The shop isn't open right now (no minter on chain)");
      const minterUtxo = minters[Math.floor(Math.random() * minters.length)];
      const receiveAddr = mode === "demo" ? burner!.address : p2pkhAddress(hash160(wc.manager!.getPubkey(0, 0n)!), NET);
      const orderId = BigInt(Date.now()) * 10n + item.id;
      const plan = buildPurchase({ provider: p, keys, network: NET, minterUtxo, coins, amount: item.sats, orderId, receiptTo: receiveAddr, changeTo: receiveAddr });
      let signed: string;
      if (mode === "demo") signed = signWcInputs(relaySafe(plan.wc), plan.inputPaths.map((x) => x[0]), burner!);
      else {
        const res = await wc.manager!.signTransaction({ transaction: relaySafe(plan.wc) as never, inputPaths: plan.inputPaths });
        if (!res.signedTransaction) throw new Error(res.error ?? "The wallet didn't sign");
        signed = res.signedTransaction;
      }
      const txid = (await broadcast(signed)) ?? "";
      setMsg({ kind: "ok", text: `Paid ${item.sats.toLocaleString()} sats for ${item.name}. Your receipt is in your wallet.`, txid, secs: (performance.now() - t0) / 1000, fee: feeOf(relaySafe(plan.wc)) });
      setTimeout(() => { scanWallet(); refreshLedger(); }, 1200);
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
      setMsg({ kind: "ok", text: partAmount ? `Refunded ${amt} sats. A new receipt for the rest is in your wallet.` : `Refunded ${amt} sats. The receipt is burned.`, txid, secs: (performance.now() - t0) / 1000, fee: feeOf(j.wc), refund: true });
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
      if (!ms.length || !plain.length || plain[0].satoshis < 15_000n) throw new Error("The demo wallet needs test coins first: press Try it now");
      const M: SpendableUtxo = { ...ms[0], lockingBytecode: lbHex(shop.minterAddress) };
      const coin: SpendableUtxo = { ...plain[0], lockingBytecode: lbHex(burner.address) };
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
        if (c.minterSecond) tb.addInput(coin, sig.unlockP2PKH()).addInput(M, minter.unlock.pay());
        else tb.addInput(M, minter.unlock.pay()).addInput(coin, sig.unlockP2PKH());
        for (const o of c.outs) tb.addOutput(o as never);
        const change = M.satoshis + coin.satoshis - c.outs.reduce((s, o) => s + o.amount, 0n) - 2_500n;
        if (change >= 546n) tb.addOutput({ to: burner.address, amount: change });
        let outcome: Cheat["outcome"], reply: string;
        try { await p.sendRawTransaction(tb.build()); outcome = "accepted"; reply = "accepted (this would be a hole)"; }
        catch (e) { outcome = "refused"; reply = String((e as Error).message ?? e).replace(/\s+/g, " ").replace(/^.*?rejected by network rules\.?\s*/i, "").slice(0, 140); }
        done.push({ id: c.id, what: c.what, outcome, reply });
        setCheats([...done]);
      }
      setTimeout(() => scanWallet(), 1000);
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
      { txid: SAMPLE_TX, vout: 2, amount: 15_000n, orderId: 17636412001n, address: "", path: "receive", index: 0 },
      { txid: SAMPLE_TX.split("").reverse().join(""), vout: 2, amount: 10_000n, orderId: 17636411002n, address: "", path: "receive", index: 0 },
    ];
    if (pv === "connected" || pv === "paid" || pv === "refunding" || pv === "paying" || pv === "network-cheats") setReceipts(sample);
    if (pv === "refunded") setReceipts(sample.slice(1));
    if (pv === "paying") setBusy("buy-1");
    if (pv === "refunding") setBusy(`refund-${SAMPLE_TX}`);
    if (pv === "demo-funding") setBusy("faucet");
    if (pv === "paid") setMsg({ kind: "ok", text: "Paid 15,000 sats for Teh tarik. Your receipt is in your wallet.", txid: SAMPLE_TX, secs: 1.6, fee: 523n });
    if (pv === "refunded") setMsg({ kind: "ok", text: "Refunded 15,000 sats. The receipt is burned.", txid: SAMPLE_TX, secs: 1.3, fee: 611n, refund: true });
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

  return (
    <div className="page">
      {pv && <div className="preview-flag">Illustration: preview of the "{pv}" state with sample data, not real transactions.</div>}
      <div className="banner" role="note">
        <span><b>BCH BLAZE 2026</b> entry.</span>
        {SLIDES_URL ? <a href={SLIDES_URL}>Slides</a> : <span className="muted">Slides: coming soon</span>}
        <a href={REPO_URL}>Source code</a>
        <span>EMBER2026 votes: {EMBER_ADDRESS ? <code>{EMBER_ADDRESS}</code> : <span className="muted">address coming soon</span>}</span>
      </div>

      <header>
        <h1>Takeback</h1>
        <p className="tagline">Pay with Bitcoin Cash, get a receipt that refunds.</p>
        <p>Every purchase puts a receipt token in your wallet in the same transaction. The shop can refund exactly what's on the receipt, to whoever holds it, once. The contract refuses anything else.</p>
      </header>

      {!shop && <p className="notice">The {NET} demo shop isn't set up yet.</p>}

      <section>
        <h2>{shop?.name ?? "Kopi Blaze"} <span className="muted">demo shop on {NET === "chipnet" ? "chipnet (test network)" : "mainnet"}</span></h2>
        {viewState !== "connected" ? (
          <div className="connect">
            <button onClick={startDemo} disabled={!!busy}>Try it now, no wallet needed</button>
            <span className="muted">Uses the test network: a demo wallet is made in this browser and gets free test coins.</span>
            <button className="secondary" onClick={() => wc.connect()}>Connect wallet{NET === "mainnet" ? " (real BCH)" : ""}</button>
            <span className="muted">Scan with Paytaca or Selene (WizardConnect).</span>
          </div>
        ) : viewMode === "demo" ? (
          <p className="muted">
            {busy === "faucet" ? "Making a demo wallet and getting test coins…" : <>Demo wallet <code>{burner ? shortTx(burner.address.replace("bchtest:", "")) : "bchtest:…"}</code> · {pv ? "25,000" : coins.reduce((s, c) => s + c.utxo.satoshis, 0n).toLocaleString()} test sats · test coins have no value</>}
          </p>
        ) : (
          <p className="muted">Connected: {pv ? "Paytaca" : wc.walletName ?? "wallet"} · {pv ? 3 : coins.length} coins · <button className="link" onClick={() => wc.disconnect()}>Disconnect</button></p>
        )}
        <ul className="menu">
          {MENU.map((m) => (
            <li key={String(m.id)}>
              <div><b>{m.name}</b> <span className="muted">{m.note}</span></div>
              <div>{m.sats.toLocaleString()} sats <span className="muted">{NET === "mainnet" ? fmtUsd(m.sats, usd) : "test coins"}</span></div>
              <button disabled={viewState !== "connected" || !!busy || (!pv && !scanned)} onClick={() => buy(m)}>{busy === `buy-${m.id}` ? (viewMode === "demo" ? "Paying…" : "Waiting for your wallet…") : !pv && viewState === "connected" && !scanned ? "Reading your wallet…" : "Buy"}</button>
            </li>
          ))}
        </ul>
        {msg && (
          <div className={msg.kind === "ok" ? "ok" : "err"} role="status">
            <p>{msg.text} {msg.txid && <a href={txLink(NET, msg.txid)} target="_blank" rel="noreferrer">View transaction {shortTx(msg.txid)}</a>}</p>
            {msg.secs !== undefined && (
              <p className="small">
                The network accepted it {msg.secs.toFixed(1)} s after you pressed {msg.refund ? "Refund" : "Buy"}{viewMode === "wc" ? " (including your approval in the wallet)" : ""}. Network fee: {msg.fee?.toLocaleString()} sats.
                {msg.refund && <> A card refund reaches the customer about 5 to 10 business days later (<a href={STRIPE_REFUNDS} target="_blank" rel="noreferrer">Stripe's refund docs</a>).</>}
              </p>
            )}
          </div>
        )}
      </section>

      {viewState === "connected" && (
        <section>
          <h2>Your receipts</h2>
          {receipts.length === 0 ? <p className="muted">No receipts from this shop in this wallet yet. Buy something above.</p> : (
            <ul className="receipts">
              {receipts.map((r) => (
                <li key={`${r.txid}:${r.vout}`}>
                  <div><b>{r.amount.toLocaleString()} sats</b> <span className="muted">order {String(r.orderId).slice(-6)}</span></div>
                  <a href={txLink(NET, r.txid)} target="_blank" rel="noreferrer">{shortTx(r.txid)}</a>
                  <span className="actions">
                    <button disabled={!!busy} onClick={() => refund(r)}>{busy === `refund-${r.txid}` ? (viewMode === "demo" ? "Refunding…" : "Waiting for your wallet…") : "Refund"}</button>
                    {r.amount >= 1092n && <button className="secondary" disabled={!!busy} onClick={() => refund(r, r.amount / 2n)}>Refund half</button>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {viewMode === "demo" && (
        <section>
          <h2>Try to cheat the real network</h2>
          <p>Your demo wallet signs five cheating purchases and sends them to a real chipnet node. If a node accepted one, your wallet would pay for it. Each comes back with the node's own answer.</p>
          <button onClick={cheatTheNetwork} disabled={!!busy || (!pv && !scanned)}>{busy === "cheats" ? "Sending cheats to chipnet…" : "Send 5 cheats to chipnet"}</button>
          {cheats && (
            <>
              <p className={cheats.every((c) => c.outcome === "refused") ? "ok" : "err"}><b>{cheats.filter((c) => c.outcome === "refused").length} of {cheats.length} refused by the network.</b></p>
              <table>
                <thead><tr><th>What the cheat tries</th><th>Node's answer</th></tr></thead>
                <tbody>{cheats.map((c) => <tr key={c.id}><td>{c.what}</td><td className={c.outcome === "refused" ? "ok" : "err"}><code>{c.reply}</code></td></tr>)}</tbody>
              </table>
            </>
          )}
        </section>
      )}

      <section>
        <h2>The shop's books, read from the chain</h2>
        {ledgerErr && <p className="err">Couldn't read the chain: {ledgerErr}</p>}
        {!shop && <p className="muted">The shop opens once its minter contract is on chain.</p>}
        {shop && !ledger && !ledgerErr && <p className="muted">Reading the minter's history…</p>}
        {totals && (
          <p>{totals.sales} {totals.sales === 1 ? "sale" : "sales"} ({totals.salesSats.toLocaleString()} sats) · {totals.refunds} {totals.refunds === 1 ? "refund" : "refunds"} ({totals.refundSats.toLocaleString()} sats) · net {totals.netSats.toLocaleString()} sats{NET === "chipnet" ? " · all test transactions from our wallets and visitors' demo wallets" : ""}</p>
        )}
        {ledger && ledger.length > 0 && (
          <table>
            <thead><tr><th>What</th><th>Amount</th><th>Transaction</th></tr></thead>
            <tbody>
              {ledger.filter((r) => r.kind !== "other").slice(0, 12).map((r) => (
                <tr key={r.txid}><td>{r.kind}</td><td>{r.amount ? `${r.amount.toLocaleString()} sats` : ""}</td><td><a href={txLink(NET, r.txid)} target="_blank" rel="noreferrer">{shortTx(r.txid)}</a></td></tr>
              ))}
            </tbody>
          </table>
        )}
        {shop && <p className="muted small">Minter contract: <code>{shop.minterAddress}</code> · receipt category <code>{shop.category.slice(0, 12)}…</code></p>}
      </section>

      <section>
        <h2>Try to cheat the contract</h2>
        <p>Four ways we tried to break it. Each reruns from the repo with one command.</p>

        <h3>1. {nAttacks} attacks we wrote down before running them</h3>
        <p>Over-refunds, second refunds, refunds to someone else, underpaid purchases that still get a receipt, stolen minting tokens, a stolen server key. Your browser runs each one against the real contract on a local copy of the BCH virtual machine.</p>
        <button onClick={runBreakTest} disabled={breaking}>{breaking ? "Running the cases…" : "Run the attacks"}</button>
        {breakResults && (() => {
          const attacks = breakResults.filter((r) => r.kind === "attack");
          const rejected = attacks.filter((r) => r.outcome === "rejected").length;
          const valid = breakResults.filter((r) => r.kind === "valid" && r.outcome !== "not-applicable");
          return (
            <>
              <p className={rejected === attacks.length ? "ok" : "err"}><b>{rejected} of {attacks.length} attacks refused by the contract.</b> {valid.filter((r) => r.ok).length} of {valid.length} honest purchases and refunds went through.</p>
              <table>
                <thead><tr><th>Case</th><th>What it tries</th><th>Result</th><th>The rule that stopped it</th></tr></thead>
                <tbody>
                  {breakResults.map((r) => (
                    <tr key={r.id}><td>{r.id}</td><td>{r.what}</td><td className={r.ok ? "ok" : "err"}>{r.outcome}</td><td><code>{r.outcome === "rejected" ? lineText(r.detail) : ""}</code></td></tr>
                  ))}
                </tbody>
              </table>
            </>
          );
        })()}

        <h3>2. The same attacks, sent to real nodes</h3>
        <p><b>{rn.refused} of {rn.built} refused by two independent chipnet servers</b> ({rn.byContract} by the contract, {rn.byConsensus} by the network's own token rules). Each was built from the shop's real coins and signed with real keys, including the shop's server key, as if it had been stolen. {rn.validAccepted} of {rn.validRun} honest purchases and refunds went through in the same run.</p>
        <button className="secondary" onClick={() => setShowReal(!showReal)}>{showReal ? "Hide" : "Show"} every node reply</button>
        {showReal && (
          <table>
            <thead><tr><th>Case</th><th>What it tries</th><th>Node's answer</th></tr></thead>
            <tbody>{rn.cases.map((c) => (
              <tr key={c.id}><td>{c.id}</td><td>{c.what}</td><td className={c.kind === "valid" ? (c.outcome === "accepted" ? "ok" : "err") : c.outcome === "refused" ? "ok" : "err"}>{c.kind === "valid" ? <a href={txLink("chipnet", c.txid ?? "")} target="_blank" rel="noreferrer">accepted {shortTx(c.txid ?? "")}</a> : <code>{c.reply}</code>}</td></tr>
            ))}</tbody>
          </table>
        )}

        <h3>3. {fz.n.toLocaleString()} random transactions, judged twice</h3>
        <p>A fuzzer bends valid purchases and refunds at random (amounts, recipients, tokens, input order, signers) and asks two judges: the contract on the BCH virtual machine, and a separate model of our written rules. On the counted run, <b>{fz.counts["agree-refused"].toLocaleString()} of {broke.toLocaleString()} rule-breaking transactions were refused</b> and {fz.counts["agree-accepted"].toLocaleString()} of {(fz.counts["agree-accepted"] + fz.counts["too-strict"]).toLocaleString()} allowed ones went through. On the contract's first version it found a gap: {fz.v1Holes} cases where a purchase could rewrite the shop's own minting token. No money was at risk; we fixed it before mainnet.</p>
        <button onClick={runFuzzNow} disabled={!!fuzz && fuzz.done < fuzz.n}>{fuzz && fuzz.done < fuzz.n ? `Fuzzing… ${fuzz.done.toLocaleString()} of ${fuzz.n.toLocaleString()}` : "Fuzz 2,000 more in your browser"}</button>
        {fuzz && (
          <p className={fuzz.s.counts.hole === 0 ? "ok" : "err"}>
            Seed {fuzz.seed}: {fuzz.done.toLocaleString()} tried · {(fuzz.s.counts["agree-refused"] + fuzz.s.counts.hole).toLocaleString()} broke a rule · {fuzz.s.counts["agree-refused"].toLocaleString()} refused · <b>{fuzz.s.counts.hole} got through</b> · {fuzz.s.counts["too-strict"]} honest ones refused
          </p>
        )}

        <h3>4. Every check that guards money is needed</h3>
        <p>We deleted each check in the contract, one at a time, and reran everything. <b>{mu.killed} of {mu.compiled} deletions let an attack through</b>, so a test catches each of those. The other {mu.survivors.length} are checks another rule or the network already covers:</p>
        <ul className="small">
          {mu.survivors.map((s) => <li key={s.line}><code>{s.check}</code> ({s.fn}): {survivorReason(s.check)}</li>)}
        </ul>
      </section>

      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog show={wc.state === "connecting" && !pv} onClose={() => wc.disconnect()} uri={wc.uri} qrUri={wc.qrUri} title="Connect your wallet" subtitle="Scan with Paytaca or Selene" />
      )}
      {pv === "connecting" && <p className="notice">(Preview) The WizardConnect QR dialog opens here; press Connect on the live page to see the real one.</p>}
      <footer className="muted small">Takeback · built for BCH BLAZE 2026.</footer>
    </div>
  );
}
