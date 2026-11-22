// Sends sats from the shop's merchant address (m/44'/145'/0'/0/0 of TAKEBACK_MERCHANT_MNEMONIC) to
// another of our own addresses, e.g. the mainnet test buyer. Change goes back to the merchant.
// Usage: node --env-file=<env> scripts/pay-from-merchant.mjs <mainnet|chipnet> <address> <sats>
import { ElectrumNetworkProvider, TransactionBuilder, SignatureTemplate } from "cashscript";
import { binToHex, cashAddressToLockingBytecode } from "@bitauth/libauth";
import { makeKeys } from "../../tools/wiz-harness/testwallet.mjs";

const [net, to, satsArg] = process.argv.slice(2);
if (!["mainnet", "chipnet"].includes(net) || !to || !/^\d+$/.test(satsArg ?? "")) { console.error("usage: <mainnet|chipnet> <address> <sats>"); process.exit(2); }
const amount = BigInt(satsArg);
const k = makeKeys(process.env.TAKEBACK_MERCHANT_MNEMONIC, net);
const from = k.address(0, 0);
const p = new ElectrumNetworkProvider(net);
const lb = binToHex(cashAddressToLockingBytecode(from).bytecode);
const coins = (await p.getUtxos(from)).filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
const picked = []; let total = 0n;
for (const c of coins) { if (total >= amount + 2_000n) break; picked.push(c); total += c.satoshis; }
if (total < amount + 2_000n) { console.error(`merchant has ${total} sats, needs ${amount + 2_000n}`); process.exit(1); }
const fee = 300n + 150n * BigInt(picked.length);
const tb = new TransactionBuilder({ provider: p });
for (const c of picked) tb.addInput({ ...c, lockingBytecode: lb }, new SignatureTemplate(k.node(0, 0).privateKey).unlockP2PKH());
tb.addOutput({ to, amount });
if (total - amount - fee >= 546n) tb.addOutput({ to: from, amount: total - amount - fee });
console.log(`sent ${amount} sats to ${to}:`, (await tb.send()).txid);
process.exit(0);
