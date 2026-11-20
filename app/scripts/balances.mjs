// Usage: node scripts/balances.mjs <address>...  Prints each address's confirmed+unconfirmed balance
// (addresses only, no keys). bchtest: addresses are read from chipnet, the rest from mainnet.
import { ElectrumNetworkProvider } from "cashscript";
const providers = {};
const providerFor = (a) => (providers[a.startsWith("bchtest:") ? "chipnet" : "mainnet"] ??= new ElectrumNetworkProvider(a.startsWith("bchtest:") ? "chipnet" : "mainnet"));
for (const a of process.argv.slice(2)) {
  const utxos = await providerFor(a).getUtxos(a);
  console.log(a, utxos.reduce((s, u) => s + u.satoshis, 0n).toString(), "sats in", utxos.length, "utxos");
}
process.exit(0);
