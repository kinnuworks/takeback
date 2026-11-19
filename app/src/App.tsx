import { useCallback, useEffect, useMemo, useState } from "react";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";
import { hash160 } from "@bitauth/libauth";
import { buildPurchase, relaySafe, decodeReceipt, isMinterUtxo, p2pkhAddress, type WalletCoin, type ShopKeys } from "./lib/takeback.ts";
import { loadShop } from "./lib/shop.ts";
import { providerFor, shopLedger, sumLedger, txLink, shortTx, type LedgerRow, type Net } from "./lib/chain.ts";
import { hexToBin } from "@bitauth/libauth";
import contractSource from "../contracts/ReceiptMinter.cash?raw";
import type { CaseResult } from "./lib/attacks.ts";
import "./App.css";

const params = new URLSearchParams(location.search);
const NET: Net = params.get("net") === "chipnet" ? "chipnet" : "mainnet";
const shop = loadShop(NET);
const SLIDES_URL = import.meta.env.VITE_SLIDES_URL as string | undefined;
const REPO_URL = (import.meta.env.VITE_REPO_URL as string | undefined) ?? "https://github.com/kinnuworks/takeback";
const EMBER_ADDRESS = import.meta.env.VITE_EMBER_ADDRESS as string | undefined;
// ?state=<name> previews one UI state with sample data, for design work. Labelled on screen.
const PREVIEW = params.get("state");
export const PREVIEW_STATES = ["idle", "connecting", "connected-empty", "connected", "paying", "paid", "refunding", "refunded", "error", "ledger-empty", "break-test"] as const;
const SAMPLE_TX = "3f1a9c2e7b6d4f0a8e5c1b2d9f7a6e4c3b2a1908f7e6d5c4b3a291807f6e5d4c";

const MENU = [
  { id: 1n, name: "Kopi", note: "Black coffee", sats: 10_000n },
  { id: 2n, name: "Teh tarik", note: "Pulled milk tea", sats: 15_000n },
  { id: 3n, name: "Kaya toast", note: "Coconut jam toast", sats: 20_000n },
];

interface HeldReceipt { txid: string; vout: number; amount: bigint; orderId: bigint; address: string; path: "receive" | "change"; index: number }

function useBchUsd() {
  const [usd, setUsd] = useState<number | null>(null);
  useEffect(() => {
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd")
      .then((r) => r.json()).then((j) => setUsd(j?.["bitcoin-cash"]?.usd ?? null)).catch(() => setUsd(null));
  }, []);
  return usd;
}
const fmtUsd = (sats: bigint, usd: number | null) => (usd ? `≈ $${((Number(sats) / 1e8) * usd).toFixed(2)}` : "");

export default function App() {
  const wc = useWizardConnect({ dappName: "Takeback", dappIcon: `${location.origin}/receipt-icon.png` });
  const usd = useBchUsd();
  const [coins, setCoins] = useState<WalletCoin[]>([]);
  const [receipts, setReceipts] = useState<HeldReceipt[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; txid?: string } | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [ledgerErr, setLedgerErr] = useState<string | null>(null);

  const keys: ShopKeys | null = useMemo(() => shop ? { merchantPkh: hexToBin(shop.merchantPkh), refundPk: hexToBin(shop.refundPk), ownerPk: hexToBin(shop.ownerPk) } : null, []);

  const refreshLedger = useCallback(() => {
    if (!shop || PREVIEW) return;
    shopLedger(shop).then((r) => { setLedger(r); setLedgerErr(null); }).catch((e) => setLedgerErr(String(e?.message ?? e)));
  }, []);
  useEffect(() => { refreshLedger(); }, [refreshLedger]);

  const scanWallet = useCallback(async () => {
    if (!wc.manager || !shop) return;
    const p = providerFor(NET);
    const found: WalletCoin[] = [];
    const held: HeldReceipt[] = [];
    const scan = async (child: 0 | 1, path: "receive" | "change", count: number) => {
      for (let i = 0; i < count; i++) {
        const pub = wc.manager!.getPubkey(child, BigInt(i));
        if (!pub) continue;
        const address = p2pkhAddress(hash160(pub), NET);
        for (const u of await p.getUtxos(address)) {
          if (!u.token) found.push({ utxo: u, address, path, index: i });
          else if (u.token.category === shop.category && u.token.nft?.capability === "none") {
            const d = decodeReceipt(u.token.nft.commitment);
            if (d) held.push({ txid: u.txid, vout: u.vout, amount: d.amount, orderId: d.orderId, address, path, index: i });
          }
        }
      }
    };
    await scan(0, "receive", 8);
    await scan(1, "change", 4);
    setCoins(found); setReceipts(held);
  }, [wc.manager]);
  useEffect(() => { if (wc.state === "connected") scanWallet(); }, [wc.state, scanWallet]);

  const broadcast = async (signedHex: string) => {
    try { return await providerFor(NET).sendRawTransaction(signedHex); }
    catch (e) { if (/already|txn-already|known/i.test(String(e))) return null; throw e; }
  };

  const buy = async (item: (typeof MENU)[number]) => {
    if (!shop || !keys || !wc.manager) return;
    setBusy(`buy-${item.id}`); setMsg(null);
    try {
      const p = providerFor(NET);
      const minters = (await p.getUtxos(shop.minterAddress)).filter((u) => isMinterUtxo(u) && u.token?.category === shop.category);
      if (!minters.length) throw new Error("The shop isn't open right now (no minter on chain)");
      const minterUtxo = minters[Math.floor(Math.random() * minters.length)];
      const receiveAddr = p2pkhAddress(hash160(wc.manager.getPubkey(0, 0n)!), NET);
      const orderId = BigInt(Date.now()) * 10n + item.id;
      const plan = buildPurchase({ provider: p, keys, network: NET, minterUtxo, coins, amount: item.sats, orderId, receiptTo: receiveAddr, changeTo: receiveAddr });
      const res = await wc.manager.signTransaction({ transaction: relaySafe(plan.wc) as never, inputPaths: plan.inputPaths });
      const signed = res.signedTransaction;
      if (!signed) throw new Error(res.error ?? "The wallet didn't sign");
      const txid = (await broadcast(signed)) ?? "";
      setMsg({ kind: "ok", text: `Paid ${item.sats.toLocaleString()} sats for ${item.name}. Your receipt is in your wallet.`, txid });
      setTimeout(() => { scanWallet(); refreshLedger(); }, 1500);
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message ?? e) });
    } finally { setBusy(null); }
  };

  const refund = async (r: HeldReceipt) => {
    if (!wc.manager) return;
    setBusy(`refund-${r.txid}`); setMsg(null);
    try {
      const resp = await fetch("/api/refund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txid: r.txid, vout: r.vout, holderAddress: r.address, network: NET }) });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error ?? "Refund request failed");
      const res = await wc.manager.signTransaction({ transaction: j.wc, inputPaths: [[j.inputIndex, r.path, r.index]] });
      if (!res.signedTransaction) throw new Error(res.error ?? "The wallet didn't sign");
      const txid = (await broadcast(res.signedTransaction)) ?? "";
      setMsg({ kind: "ok", text: `Refunded ${BigInt(j.amount).toLocaleString()} sats. The receipt is burned.`, txid });
      setTimeout(() => { scanWallet(); refreshLedger(); }, 1500);
    } catch (e) {
      setMsg({ kind: "err", text: String((e as Error).message ?? e) });
    } finally { setBusy(null); }
  };

  // Preview states: fake only what the state needs, everything else stays real.
  const pv = PREVIEW;
  const viewState = pv === "connecting" ? "connecting" : pv && pv !== "idle" && pv !== "ledger-empty" && pv !== "break-test" ? "connected" : wc.state;
  useEffect(() => {
    if (!pv) return;
    const sample: HeldReceipt[] = [
      { txid: SAMPLE_TX, vout: 2, amount: 15_000n, orderId: 17636412001n, address: "", path: "receive", index: 0 },
      { txid: SAMPLE_TX.split("").reverse().join(""), vout: 2, amount: 10_000n, orderId: 17636411002n, address: "", path: "receive", index: 0 },
    ];
    if (pv === "connected" || pv === "paid" || pv === "refunding" || pv === "paying") setReceipts(sample);
    if (pv === "refunded") setReceipts(sample.slice(1));
    if (pv === "paying") setBusy("buy-1");
    if (pv === "refunding") setBusy(`refund-${SAMPLE_TX}`);
    if (pv === "paid") setMsg({ kind: "ok", text: "Paid 15,000 sats for Teh tarik. Your receipt is in your wallet.", txid: SAMPLE_TX });
    if (pv === "refunded") setMsg({ kind: "ok", text: "Refunded 15,000 sats. The receipt is burned.", txid: SAMPLE_TX });
    if (pv === "error") setMsg({ kind: "err", text: "Not enough BCH in the connected wallet: need about 18,000 sats, have 4,200" });
    if (pv === "ledger-empty") setLedger([]);
    if (pv !== "ledger-empty" && pv !== "idle") setLedger([
      { txid: SAMPLE_TX, height: 951234, kind: "sale", amount: 15_000n },
      { txid: SAMPLE_TX.split("").reverse().join(""), height: 951230, kind: "refund", amount: 10_000n },
      { txid: SAMPLE_TX.replace(/a/g, "b"), height: 951229, kind: "sale", amount: 10_000n },
    ]);
  }, [pv]);
  const totals = ledger ? sumLedger(ledger) : null;
  const [breakResults, setBreakResults] = useState<CaseResult[] | null>(null);
  const [breaking, setBreaking] = useState(false);
  const sourceLines = contractSource.split("\n");
  const runBreakTest = async () => {
    setBreaking(true);
    await new Promise((r) => setTimeout(r, 30));
    const { runAll } = await import("./lib/attacks.ts");
    setBreakResults(runAll());
    setBreaking(false);
  };
  useEffect(() => { if (pv === "break-test") runBreakTest(); }, [pv]); // eslint-disable-line react-hooks/exhaustive-deps
  const lineText = (detail: string) => { const n = Number(detail.match(/line (\d+)/)?.[1]); return n ? sourceLines[n - 1]?.trim() : ""; };

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
        <h2>{shop?.name ?? "Kopi Blaze"} <span className="muted">demo shop on {NET}</span></h2>
        {viewState !== "connected" ? (
          <div className="connect">
            <button onClick={() => wc.connect()}>Connect wallet to buy</button>
            <span className="muted">Scan with Paytaca or Selene (WizardConnect).</span>
          </div>
        ) : (
          <p className="muted">Connected: {pv ? "Paytaca" : wc.walletName ?? "wallet"} · {pv ? 3 : coins.length} coins · <button className="link" onClick={() => wc.disconnect()}>Disconnect</button></p>
        )}
        <ul className="menu">
          {MENU.map((m) => (
            <li key={String(m.id)}>
              <div><b>{m.name}</b> <span className="muted">{m.note}</span></div>
              <div>{m.sats.toLocaleString()} sats <span className="muted">{fmtUsd(m.sats, usd)}</span></div>
              <button disabled={viewState !== "connected" || !!busy} onClick={() => buy(m)}>{busy === `buy-${m.id}` ? "Waiting for your wallet…" : "Buy"}</button>
            </li>
          ))}
        </ul>
        {msg && (
          <p className={msg.kind === "ok" ? "ok" : "err"} role="status">
            {msg.text} {msg.txid && <a href={txLink(NET, msg.txid)} target="_blank" rel="noreferrer">View transaction {shortTx(msg.txid)}</a>}
          </p>
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
                  <button disabled={!!busy} onClick={() => refund(r)}>{busy === `refund-${r.txid}` ? "Waiting for your wallet…" : "Refund"}</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2>The shop's books, read from the chain</h2>
        {ledgerErr && <p className="err">Couldn't read the chain: {ledgerErr}</p>}
        {!shop && <p className="muted">The shop opens once its minter contract is on chain.</p>}
        {shop && !ledger && !ledgerErr && <p className="muted">Reading the minter's history…</p>}
        {totals && (
          <p>{totals.sales} {totals.sales === 1 ? "sale" : "sales"} ({totals.salesSats.toLocaleString()} sats) · {totals.refunds} {totals.refunds === 1 ? "refund" : "refunds"} ({totals.refundSats.toLocaleString()} sats) · net {totals.netSats.toLocaleString()} sats</p>
        )}
        {ledger && ledger.length > 0 && (
          <table>
            <thead><tr><th>What</th><th>Amount</th><th>Transaction</th></tr></thead>
            <tbody>
              {ledger.filter((r) => r.kind !== "other").map((r) => (
                <tr key={r.txid}><td>{r.kind}</td><td>{r.amount ? `${r.amount.toLocaleString()} sats` : ""}</td><td><a href={txLink(NET, r.txid)} target="_blank" rel="noreferrer">{shortTx(r.txid)}</a></td></tr>
              ))}
            </tbody>
          </table>
        )}
        {shop && <p className="muted small">Minter contract: <code>{shop.minterAddress}</code> · receipt category <code>{shop.category.slice(0, 12)}…</code></p>}
      </section>

      <section>
        <h2>Try to cheat the contract</h2>
        <p>Thirty-four attacks we wrote before building it: over-refunds, second refunds, refunds to someone else, underpaid purchases that still get a receipt, extra minting tokens. Press the button and your browser runs each one against the real contract on a local copy of the BCH virtual machine. No wallet or money needed.</p>
        <button onClick={runBreakTest} disabled={breaking}>{breaking ? "Running 37 cases…" : "Run the attacks"}</button>
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
      </section>

      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog show={wc.state === "connecting" && !pv} onClose={() => wc.disconnect()} uri={wc.uri} qrUri={wc.qrUri} title="Connect your wallet" subtitle="Scan with Paytaca or Selene" />
      )}
      {pv === "connecting" && <p className="notice">(Preview) The WizardConnect QR dialog opens here; press Connect on the live page to see the real one.</p>}
      <footer className="muted small">Takeback · built for BCH BLAZE 2026.</footer>
    </div>
  );
}
