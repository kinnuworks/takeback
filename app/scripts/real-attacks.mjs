// Sends the attack lists (evidence/attacks.json, attacks-2.json, attacks-3.json) to real Bitcoin Cash nodes.
// Every attack is built from the shop's real coins and signed with real keys, the shop's hot refund
// key included (the "stolen server key" case), then broadcast to two independent Electrum servers.
// The node's own reply and the signed raw transaction are saved, so anyone can rebroadcast them.
// The valid cases run too, as real transactions, so the same run shows the honest paths still work.
//
// Run:     node --env-file=../tools/wiz-harness/.env.local scripts/real-attacks.mjs chipnet
// Replay:  node scripts/real-attacks.mjs chipnet --replay   (no keys: rebroadcasts the saved hex)
import { readFileSync, writeFileSync } from "node:fs";
import { ElectrumNetworkProvider, TransactionBuilder, SignatureTemplate } from "cashscript";
import {
  hash160, binToHex, hexToBin, cashAddressToLockingBytecode, encodeLockingBytecodeP2pkh,
  lockingBytecodeToCashAddress, bigIntToVmNumber, hash256, swapEndianness,
} from "@bitauth/libauth";
import { makeKeys } from "../../tools/wiz-harness/testwallet.mjs";
import { minterContract, encodeReceipt, decodeReceipt, isMinterUtxo } from "../src/lib/takeback.ts";

const network = process.argv[2];
if (!["chipnet", "mainnet"].includes(network)) { console.error("network: chipnet | mainnet"); process.exit(2); }
const OUT = new URL(`../../evidence/real-node-${network}${process.env.REAL_NODE_SUFFIX ?? ""}.json`, import.meta.url).pathname;
const SERVERS = network === "chipnet" ? ["chipnet.bch.ninja", "chipnet.imaginary.cash"] : ["bch.imaginary.cash", "electrum.imaginary.cash"];
const providers = SERVERS.map((hostname) => new ElectrumNetworkProvider(network, { hostname }));
const provider = providers[0];
const txidOf = (hex) => swapEndianness(binToHex(hash256(hexToBin(hex))));

const UNREACHABLE = /Failed to establish connection|timed out|WebSocket|ECONN|socket hang up/i;
async function broadcastAll(hex) {
  const replies = [];
  for (const [i, p] of providers.entries()) {
    let reply;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { reply = { server: SERVERS[i], accepted: true, reply: await p.sendRawTransaction(hex) }; }
      catch (e) { reply = { server: SERVERS[i], accepted: false, reply: String(e.message ?? e).replace(/\s+/g, " ").slice(0, 400) }; }
      if (reply.accepted || !UNREACHABLE.test(reply.reply)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    reply.unreachable = !reply.accepted && UNREACHABLE.test(reply.reply);
    replies.push(reply);
  }
  return replies;
}
async function retry(f) {
  for (let attempt = 0; ; attempt++) {
    try { return await f(); } catch (e) { if (attempt >= 4 || !UNREACHABLE.test(String(e.message ?? e))) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
}
// Why a node refused: the contract (script failed) or a consensus/relay rule before the script ran.
function why(replies) {
  const r = replies.filter((x) => !x.unreachable).map((x) => x.reply).join(" | ");
  if (replies.some((x) => x.accepted)) return "accepted";
  if (/script|OP_|verify|signature|NULLFAIL|EQUALVERIFY|mandatory/i.test(r)) return "contract (script failed)";
  if (/token|category|commitment/i.test(r)) return "consensus token rules";
  if (/missing|spent|conflict/i.test(r)) return "inputs no longer available";
  if (/inputs-duplicate/i.test(r)) return "BUILD ERROR: duplicate input (our script's bug, not a refusal)";
  return "other: " + r.slice(0, 80);
}

if (process.argv.includes("--replay")) {
  const saved = JSON.parse(readFileSync(OUT, "utf8"));
  let refused = 0, n = 0;
  for (const c of saved.cases.filter((c) => c.kind === "attack" && c.rawTx)) {
    n++;
    const replies = await broadcastAll(c.rawTx);
    const ok = replies.every((x) => !x.accepted);
    if (ok) refused++;
    console.log(ok ? "REFUSED" : "ACCEPTED", c.id, "->", why(replies), "|", replies[0].reply.slice(0, 120));
  }
  console.log(`replay: ${refused} of ${n} saved attack transactions refused again`);
  process.exit(refused === n ? 0 : 1);
}

// ---------- keys and coins ----------
const shop = JSON.parse(readFileSync(new URL(`../src/shop/${network}.json`, import.meta.url), "utf8"));
const merchantSeed = process.env.TAKEBACK_MERCHANT_MNEMONIC;
const buyerSeed = process.env[network === "chipnet" ? "CHIPNET_TEST_MNEMONIC" : "MAINNET_TEST_MNEMONIC"];
if (!merchantSeed || !buyerSeed) { console.error("seeds missing from the env file"); process.exit(2); }
const mk = makeKeys(merchantSeed, network), bk = makeKeys(buyerSeed, network);
const refundKey = new SignatureTemplate(mk.node(0, 1).privateKey);
const buyerKey = new SignatureTemplate(bk.node(0, 0).privateKey);
const attackerKey = new SignatureTemplate(bk.node(0, 5).privateKey);
const keys = { merchantPkh: hexToBin(shop.merchantPkh), refundPk: hexToBin(shop.refundPk), ownerPk: hexToBin(shop.ownerPk) };
const minter = minterContract(keys, provider);
const prefix = network === "mainnet" ? "bitcoincash" : "bchtest";
const addrOf = (pub, tokenSupport = false) => lockingBytecodeToCashAddress({ bytecode: encodeLockingBytecodeP2pkh(hash160(pub)), prefix, tokenSupport }).address;
const buyer = addrOf(bk.pub(0, 0)), buyerT = addrOf(bk.pub(0, 0), true);
const attacker = addrOf(bk.pub(0, 5)), attackerT = addrOf(bk.pub(0, 5), true);
const merchant = shop.merchantAddress;
const C = shop.category;
const lbHex = (a) => binToHex(cashAddressToLockingBytecode(a).bytecode);
const nft = (category, capability, commitment) => ({ category, amount: 0n, nft: { capability, commitment } });
const le8 = (n) => { const b = new Uint8Array(8); b.set(bigIntToVmNumber(n).slice(0, 8)); return b; };
const commit = (amount, order, len = 16) => { const f = new Uint8Array([...le8(amount), ...le8(order)]); const o = new Uint8Array(len); o.set(f.slice(0, Math.min(len, 16))); return binToHex(o); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function utxos(addr) { return (await retry(() => provider.getUtxos(addr))).map((u) => ({ ...u, lockingBytecode: lbHex(addr) })); }
async function freshMinter(min = 40_000n) {
  const ms = (await utxos(shop.minterAddress)).filter((u) => isMinterUtxo(u) && u.token.category === C && u.satoshis >= min);
  if (!ms.length) throw new Error("no minter UTXO with enough float");
  return ms.sort((a, b) => Number(b.satoshis - a.satoshis))[0];
}
async function buyerCoin(min, exclude = []) {
  const used = new Set(exclude.map((u) => `${u.txid}:${u.vout}`));
  const cs = (await utxos(buyer)).filter((u) => !u.token && u.satoshis >= min && !used.has(`${u.txid}:${u.vout}`)).sort((a, b) => Number(b.satoshis - a.satoshis));
  if (!cs.length) throw new Error(`buyer has no plain coin of ${min}+ sats`);
  return cs[0];
}
async function seen(txid, vout, addr) {
  for (let i = 0; i < 30; i++) { const u = (await utxos(addr)).find((x) => x.txid === txid && x.vout === vout); if (u) return u; await wait(1500); }
  throw new Error(`output ${txid}:${vout} not seen at ${addr}`);
}

// Builds a transaction from inputs [{utxo, unlock}] and outputs, adding change to `changeTo` so the
// fee is about 1.2 sat/byte (so no node refuses an attack for a low fee before the script runs).
function assemble(inputs, outputs, changeTo) {
  const make = (change) => {
    const tb = new TransactionBuilder({ provider });
    for (const i of inputs) tb.addInput(i.utxo, i.unlock);
    for (const o of outputs) tb.addOutput(o);
    if (change >= 546n) tb.addOutput({ to: changeTo, amount: change });
    return tb.build();
  };
  const inSum = inputs.reduce((s, i) => s + i.utxo.satoshis, 0n);
  const outSum = outputs.reduce((s, o) => s + o.amount, 0n);
  const size = BigInt(make(inSum - outSum - 4000n).length / 2) + 40n; // a generous fee for the size estimate
  const change = inSum - outSum - (size * 12n) / 10n;
  if (change < 0n) throw new Error(`inputs ${inSum} don't cover outputs ${outSum} + fee`);
  return make(change);
}

const results = [];
async function run(id, what, kind, buildHex) {
  let hex;
  try { hex = await buildHex(); }
  catch (e) { results.push({ id, what, kind, outcome: "not built", detail: String(e.message ?? e).split("\n")[0] }); console.log("NOT BUILT", id, String(e.message ?? e).split("\n")[0]); return undefined; }
  const replies = await broadcastAll(hex);
  const reason = why(replies);
  const accepted = replies.some((x) => x.accepted);
  const answered = replies.filter((x) => !x.unreachable).length;
  const ok = kind === "valid" ? accepted : !accepted && answered > 0 && !reason.startsWith("BUILD ERROR");
  results.push({ id, what, kind, outcome: accepted ? "accepted" : answered ? "refused" : "no server answered", serversAnswered: answered, reason, ok, txid: txidOf(hex), rawTx: hex, replies, at: new Date().toISOString() });
  console.log(ok ? "PASS" : "FAIL", id, accepted ? "accepted" : "refused", "->", reason, "|", replies[0].reply.slice(0, 110));
  return accepted ? txidOf(hex) : undefined;
}

const spec1 = JSON.parse(readFileSync(new URL("../../evidence/attacks.json", import.meta.url), "utf8"));
const spec2 = JSON.parse(readFileSync(new URL("../../evidence/attacks-2.json", import.meta.url), "utf8"));
const spec3 = JSON.parse(readFileSync(new URL("../../evidence/attacks-3.json", import.meta.url), "utf8"));
const spec4 = JSON.parse(readFileSync(new URL("../../evidence/attacks-4.json", import.meta.url), "utf8"));
const whatOf = Object.fromEntries([...spec1.valid, ...spec1.attacks, ...spec2.valid, ...spec2.attacks, ...spec3.attacks, ...spec4.attacks].map((c) => [c.id, c.what]));

// ---------- setup: the attacker's own token category (a fake shop) ----------
console.log(`network ${network}; servers ${SERVERS.join(", ")}; shop ${C.slice(0, 8)}…`);
let order = BigInt(Date.now() % 1_000_000_000);
const setupTx = [];
let coin = await buyerCoin(30_000n);
const selfSend = assemble([{ utxo: coin, unlock: buyerKey.unlockP2PKH() }], [{ to: buyer, amount: 20_000n }], buyer);
const selfTxid = await retry(() => provider.sendRawTransaction(selfSend));
setupTx.push({ what: "attacker setup: a coin at output 0 (needed to create a token category)", txid: selfTxid });
const v0 = await seen(selfTxid, 0, buyer);
const X = v0.txid; // the attacker's category id
const genesis = assemble([{ utxo: v0, unlock: buyerKey.unlockP2PKH() }], [
  { to: buyerT, amount: 1000n, token: nft(X, "minting", "") },
  { to: buyerT, amount: 2500n, token: nft(X, "none", commit(30_000n, 99n)) },
], buyer);
const genTxid = await retry(() => provider.sendRawTransaction(genesis));
setupTx.push({ what: "attacker setup: a fake shop category with its own minting token and a fake 30,000-sat receipt", txid: genTxid });
const xMinting = await seen(genTxid, 0, buyer);
const fakeReceipt = await seen(genTxid, 1, buyer);
console.log("attacker category", X.slice(0, 8), "genesis", genTxid.slice(0, 8));

// ---------- valid purchases (they also give us extra receipts for the attacks) ----------
async function purchase(amount, mod = (o) => o, extraInputs = []) {
  const M = await freshMinter();
  const c = await buyerCoin(amount + 6_000n);
  const outs = [
    { to: minter.tokenAddress, amount: M.satoshis, token: M.token },
    { to: merchant, amount },
    { to: buyerT, amount: 2500n, token: nft(C, "none", commit(amount, ++order)) },
  ];
  return assemble([{ utxo: M, unlock: minter.unlock.pay() }, { utxo: c, unlock: buyerKey.unlockP2PKH() }, ...extraInputs], mod(outs, M), buyer);
}
const v2 = await run("V2", whatOf.V2, "valid", () => purchase(1_000n));
const R2 = v2 && await seen(v2, 2, buyer);
const v1 = await run("V1", whatOf.V1, "valid", () => purchase(5_000n));
const R3 = v1 && await seen(v1, 2, buyer);
let R1 = (await utxos(buyer)).filter((u) => u.token?.category === C && u.token.nft?.capability === "none" && u.txid !== v1 && u.txid !== v2 && decodeReceipt(u.token.nft.commitment)?.amount === 10_000n)[0];
if (!R1) {
  // A fresh shop has no earlier receipt: buy one 10,000-sat receipt to attack with (a real purchase).
  const hex = await purchase(10_000n);
  const t = await retry(() => provider.sendRawTransaction(hex));
  setupTx.push({ what: "setup: a 10,000-sat purchase whose receipt the attacks below try to abuse", txid: t });
  R1 = await seen(t, 2, buyer);
}
const A = decodeReceipt(R1.token.nft.commitment).amount;
console.log("attacking with receipt", `${R1.txid.slice(0, 8)}:${R1.vout}`, "worth", A.toString());

// ---------- list 1: purchase attacks ----------
const P = 2_000n;
const set = (i, f) => (o) => o.map((x, j) => (j === i ? f(x) : x));
const P_ATT = {
  A01: set(1, (x) => ({ ...x, amount: P - 1n })),
  A02: set(1, (x) => ({ ...x, amount: P / 2n })),
  A03: set(1, (x) => ({ ...x, amount: 546n })),
  A04: set(1, (x) => ({ ...x, to: attacker })),
  A05: set(2, (x) => ({ ...x, token: nft(C, "none", commit(P, order, 15)) })),
  A06: set(2, (x) => ({ ...x, token: nft(C, "none", commit(P, order) + "00") })),
  A07: (o) => set(2, (x) => ({ ...x, token: nft(C, "none", commit(0n, order)) }))(set(1, (x) => ({ ...x, amount: 546n }))(o)),
  A08: set(2, (x) => ({ ...x, token: nft(C, "none", binToHex(new Uint8Array([...le8(-P), ...le8(order)]))) })),
  A10: set(2, (x) => ({ to: x.to, amount: x.amount })),
  A11: set(0, (x) => ({ ...x, to: attackerT })),
  A12: set(0, (x) => ({ ...x, to: buyerT })),
  A13: set(0, (x) => ({ ...x, token: nft(C, "none", "") })),
  A14: set(0, (x) => ({ ...x, amount: x.amount - 1n })),
  A15: (o) => [...o, { to: attackerT, amount: 1000n, token: nft(C, "minting", "") }],
  A16: (o) => [...o, { to: buyerT, amount: 1000n, token: nft(C, "none", commit(P, order + 1n)) }],
  A17: set(2, (x) => ({ ...x, token: nft(C, "minting", commit(P, order)) })),
  A18: set(2, (x) => ({ ...x, token: nft(C, "mutable", commit(P, order)) })),
  A19: (o) => [...o, { to: buyerT, amount: 1000n, token: { category: C, amount: 1000n } }],
};
P_ATT.M01 = set(0, (x) => ({ ...x, token: nft(C, "minting", "01") }));
P_ATT.M04 = set(0, (x) => ({ ...x, token: nft(C, "minting", "ab".repeat(40)) }));
for (const [id, mod] of Object.entries(P_ATT)) await run(id, whatOf[id], "attack", () => purchase(P, mod));
// A09: the receipt is minted in a category the attacker controls (spending the attacker's own minting token).
await run("A09", whatOf.A09, "attack", () => purchase(P, (o) => [...set(2, (x) => ({ ...x, token: nft(X, "none", commit(P, order)) }))(o), { to: buyerT, amount: 1000n, token: nft(X, "minting", "") }], [{ utxo: xMinting, unlock: buyerKey.unlockP2PKH() }]));

// ---------- list 1: refund attacks (with the shop's real hot refund key unless stated) ----------
async function refund({ receipt = R1, amount, signer = refundKey, idx = 1n, mod = (o) => o, extra = [] } = {}) {
  const M = await freshMinter();
  const amt = amount ?? decodeReceipt(receipt.token.nft.commitment).amount;
  const outs = [
    { to: minter.tokenAddress, amount: M.satoshis - amt, token: M.token },
    { to: buyer, amount: amt },
  ];
  return assemble([{ utxo: M, unlock: minter.unlock.refund(signer, idx) }, { utxo: receipt, unlock: buyerKey.unlockP2PKH() }, ...extra], mod(outs, M, amt), buyer);
}
const R_ATT = {
  A20: () => refund({ signer: buyerKey }),
  A21: () => refund({ signer: attackerKey }),
  A22: () => refund({ amount: A + 1n }),
  A23: () => refund({ amount: 2n * A }),
  A24: () => refund({ mod: set(1, (x) => ({ ...x, to: attacker })) }),
  A25: () => refund({ receipt: fakeReceipt, amount: 30_000n }),
  A26: () => refund({ mod: (o) => [...o, { to: buyerT, amount: 800n, token: nft(C, "none", commit(A, 1n)) }] }),
  A27: () => refund({ mod: set(1, (x) => ({ ...x, to: buyerT, token: nft(C, "none", R1.token.nft.commitment) })) }),
  A28: () => refund({ idx: 0n }),
  A29: () => refund({ mod: set(0, (x) => ({ to: minter.address, amount: x.amount })) }),
  A30: () => refund({ mod: (o) => [...set(0, (x) => ({ ...x, amount: x.amount - 5_000n }))(o), { to: attacker, amount: 5_000n }] }),
  A31: () => refund({ mod: (o) => set(1, (x) => ({ ...x, amount: A - 1_000n }))(set(0, (x) => ({ ...x, amount: x.amount + 1_000n }))(o)) }),
  A32: () => refund({ mod: (o) => [...o, { to: attackerT, amount: 800n, token: nft(C, "none", commit(1n, 1n)) }] }),
  A33: () => refund({ extra: R2 ? [{ utxo: R2, unlock: buyerKey.unlockP2PKH() }] : [] }),
  A34: () => refund({ extra: R3 ? [{ utxo: R3, unlock: buyerKey.unlockP2PKH() }] : [] }),
};
R_ATT.M02 = () => refund({ mod: set(0, (x) => ({ ...x, token: nft(C, "minting", "01") })) });
for (const [id, b] of Object.entries(R_ATT)) await run(id, whatOf[id], "attack", b);

// ---------- list 2: partial-refund attacks ----------
async function partial({ receipt = R1, r = 4_000n, signer = refundKey, mod = (o) => o, extra = [] } = {}) {
  const M = await freshMinter();
  const amt = decodeReceipt(receipt.token.nft.commitment).amount;
  const ord = decodeReceipt(receipt.token.nft.commitment).orderId;
  const outs = [
    { to: minter.tokenAddress, amount: M.satoshis - (r > 0n ? r : 0n), token: M.token },
    { to: buyer, amount: r > 0n ? r : 546n },
    { to: buyerT, amount: 1000n, token: nft(C, "none", commit(amt - r, ord)) },
  ];
  const fee = extra.length ? extra : [{ utxo: await buyerCoin(3_000n), unlock: buyerKey.unlockP2PKH() }];
  return assemble([{ utxo: M, unlock: minter.unlock.partialRefund(signer, 1n, r) }, { utxo: receipt, unlock: buyerKey.unlockP2PKH() }, ...fee], mod(outs, M), buyer);
}
const ordR1 = decodeReceipt(R1.token.nft.commitment).orderId;
const PR_ATT = {
  P01: () => partial({ mod: set(2, (x) => ({ ...x, token: nft(C, "none", commit(A - 4_000n - 1_000n, ordR1)) })) }),
  P02: () => partial({ mod: set(2, (x) => ({ ...x, to: attackerT })) }),
  P03: () => partial({ mod: set(2, (x) => ({ ...x, token: nft(C, "minting", commit(A - 4_000n, ordR1)) })) }),
  P04: () => partial({ mod: set(2, (x) => ({ ...x, token: nft(C, "none", commit(A - 4_000n, ordR1 + 1n)) })) }),
  P05: () => partial({ r: 0n }),
  P06: () => partial({ r: A }),
  P07: () => partial({ mod: (o) => [...o, { to: buyerT, amount: 1000n, token: nft(C, "none", commit(A - 4_000n, ordR1)) }] }),
  P08: () => partial({ signer: buyerKey }),
  P09: () => partial({ mod: set(1, (x) => ({ ...x, to: attacker })) }),
  P10: () => partial({ mod: (o) => [o[0], o[1]] }),
  P11: () => partial({ mod: (o) => [...set(0, (x) => ({ ...x, amount: x.amount - 5_000n }))(o), { to: attacker, amount: 5_000n }] }),
  P12: () => partial({ r: A + 1_000n, mod: set(2, (x) => ({ ...x, token: nft(C, "none", commit(1n, ordR1)) })) }),
};
PR_ATT.M03 = () => partial({ mod: set(0, (x) => ({ ...x, token: nft(C, "minting", "01") })) });
for (const [id, b] of Object.entries(PR_ATT)) await run(id, whatOf[id], "attack", b);

// ---------- list 4: input-order tricks and the admin path (found by mutation testing) ----------
// K01-K03: the attacker's plain coin at input 0, the minter at input 1, output 0 to the attacker.
// K05-K06: the attacker's own minting token (category X) at input 0 and a fake X receipt at input 2.
async function minterSecond(path, lead) {
  const M = await freshMinter();
  const lure = lead ?? await buyerCoin(3_000n);
  const ins = [{ utxo: lure, unlock: buyerKey.unlockP2PKH() }];
  if (path === "pay") {
    const c = await buyerCoin(8_000n, [lure]);
    ins.push({ utxo: M, unlock: minter.unlock.pay() }, { utxo: c, unlock: buyerKey.unlockP2PKH() });
    return assemble(ins, [
      { to: buyerT, amount: M.satoshis, token: M.token },
      { to: merchant, amount: P },
      { to: buyerT, amount: 2500n, token: nft(C, "none", commit(P, ++order)) },
    ], buyer);
  }
  const rec = lead ? fakeReceipt : R1;
  const amt = decodeReceipt(rec.token.nft.commitment).amount;
  const r = path === "refund" ? amt : 2_000n;
  ins.push({ utxo: M, unlock: path === "refund" ? minter.unlock.refund(refundKey, 2n) : minter.unlock.partialRefund(refundKey, 2n, r) }, { utxo: rec, unlock: buyerKey.unlockP2PKH() });
  const outs = [{ to: lead ? buyerT : buyer, amount: lure.satoshis, token: lead ? lure.token : undefined }, { to: buyer, amount: r }];
  if (path === "partial") outs.push({ to: buyerT, amount: 1000n, token: nft(rec.token.category, "none", commit(amt - r, decodeReceipt(rec.token.nft.commitment).orderId)) });
  outs.push({ to: buyerT, amount: M.satoshis - r, token: M.token }); // the shop's minting token and float, to the attacker
  return assemble(ins.concat([{ utxo: await buyerCoin(3_000n, [lure]), unlock: buyerKey.unlockP2PKH() }]), outs.map((o) => (o.token ? o : { to: o.to, amount: o.amount })), buyer);
}
await run("K01", whatOf.K01, "attack", () => minterSecond("pay"));
await run("K02", whatOf.K02, "attack", () => minterSecond("refund"));
await run("K03", whatOf.K03, "attack", () => minterSecond("partial"));
await run("K04", whatOf.K04, "attack", async () => { const M = await freshMinter(); return assemble([{ utxo: M, unlock: minter.unlock.admin(refundKey) }], [{ to: attackerT, amount: M.satoshis - 2_000n, token: M.token }], attacker); });
await run("K05", whatOf.K05, "attack", () => minterSecond("refund", xMinting));
await run("K06", whatOf.K06, "attack", () => minterSecond("partial", xMinting));

// ---------- valid refunds last (they spend the extra receipts) ----------
if (R2) await run("V3", whatOf.V3, "valid", () => refund({ receipt: R2 }));
let R3b;
if (R3) { const t = await run("PV1", whatOf.PV1, "valid", () => partial({ receipt: R3, r: 2_000n })); R3b = t && await seen(t, 2, buyer); }
if (R3b) await run("PV3", whatOf.PV3, "valid", () => partial({ receipt: R3b, r: 546n }));

// ---------- report ----------
const attacks = results.filter((r) => r.kind === "attack");
const built = attacks.filter((r) => r.outcome !== "not built");
const refused = built.filter((r) => r.outcome === "refused" && !String(r.reason).startsWith("BUILD ERROR"));
const refusedByBoth = refused.filter((r) => r.serversAnswered === SERVERS.length).length;
const byContract = refused.filter((r) => r.reason === "contract (script failed)").length;
const valid = results.filter((r) => r.kind === "valid");
const summary = {
  network, servers: SERVERS, shopCategory: C, attackerCategory: X, setupTx, ranAt: new Date().toISOString(),
  attacksBuilt: built.length, attacksRefused: refused.length, refusedByBothServers: refusedByBoth, refusedByContract: byContract, refusedByOtherRules: refused.length - byContract,
  validAccepted: valid.filter((r) => r.ok).length, validRun: valid.length,
};
writeFileSync(OUT, JSON.stringify({ summary, cases: results }, null, 2) + "\n");
console.log(`attacks refused by real ${network} nodes: ${refused.length} of ${built.length} (both servers answered and refused: ${refusedByBoth}; refused by the contract: ${byContract}; by other consensus rules: ${refused.length - byContract})`);
console.log(`valid cases accepted: ${summary.validAccepted} of ${summary.validRun}`);
console.log("saved", OUT);
process.exit(refused.length === built.length && summary.validAccepted === summary.validRun ? 0 : 1);
