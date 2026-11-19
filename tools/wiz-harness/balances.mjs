// Prints the confirmed+unconfirmed balance of the shop's mainnet wallets (addresses only, no keys).
import { ElectrumNetworkProvider } from "cashscript";
const provider = new ElectrumNetworkProvider("mainnet");
for (const a of process.argv.slice(2)) {
  const utxos = await provider.getUtxos(a);
  console.log(a, utxos.reduce((s, u) => s + u.satoshis, 0n).toString(), "sats in", utxos.length, "utxos");
}
process.exit(0);
