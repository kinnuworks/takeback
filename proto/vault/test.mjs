// Prototype check: the vault lets a top-up and a refund through at the fixed rate and
// rejects a theft attempt (taking BCH without returning credits). Mock network, no funds.
import { compileFile } from "cashc";
import { Contract, MockNetworkProvider, TransactionBuilder, randomUtxo, randomToken, SignatureTemplate } from "cashscript";
import { cashAddressToLockingBytecode, binToHex, secp256k1, encodeLockingBytecodeP2pkh, hash160, lockingBytecodeToCashAddress, generateRandomBytes } from "@bitauth/libauth";

const artifact = compileFile(new URL("./Vault.cash", import.meta.url));
const provider = new MockNetworkProvider();
const RATE = 100n; // 100 sats per credit
const vault = new Contract(artifact, [RATE], { provider });

const priv = generateRandomBytes(32);
const pub = secp256k1.derivePublicKeyCompressed(priv);
const userLb = encodeLockingBytecodeP2pkh(hash160(pub));
const userAddr = lockingBytecodeToCashAddress({ bytecode: userLb, prefix: "bchtest", tokenSupport: true }).address;
const sig = new SignatureTemplate(priv);

const supply = 1_000_000n;
const lbHex = (addr) => binToHex(cashAddressToLockingBytecode(addr).bytecode);
const withLb = (u, addr) => ({ ...u, lockingBytecode: lbHex(addr) });
const vaultUtxo = withLb(randomUtxo({ satoshis: 10_000n, token: randomToken({ amount: supply }) }), vault.address);
const category = vaultUtxo.token.category;
provider.addUtxo(vault.address, vaultUtxo);
const userUtxo = withLb(randomUtxo({ satoshis: 50_000n }), userAddr);
provider.addUtxo(userAddr, userUtxo);

function check(name, fn, expectOk) {
  try { fn(); console.log(expectOk ? "PASS" : "FAIL", name, expectOk ? "" : "(should have been rejected)"); return expectOk; }
  catch (e) { console.log(expectOk ? "FAIL" : "PASS", name, expectOk ? String(e.message).split("\n")[0] : "(rejected as expected)"); return !expectOk; }
}

let ok = true;
// Top-up: user pays 10,000 sats, gets 100 credits.
ok &= check("top-up 100 credits for 10,000 sats", () => {
  new TransactionBuilder({ provider })
    .addInput(vaultUtxo, vault.unlock.swap())
    .addInput(userUtxo, sig.unlockP2PKH())
    .addOutput({ to: vault.tokenAddress, amount: 20_000n, token: { category, amount: supply - 100n } })
    .addOutput({ to: userAddr, amount: 1_000n, token: { category, amount: 100n } })
    .addOutput({ to: userAddr, amount: 38_000n })
    .debug();
}, true);
// Theft: take 5,000 sats from the vault and keep all credits in it.
ok &= check("steal backing without returning credits", () => {
  new TransactionBuilder({ provider })
    .addInput(vaultUtxo, vault.unlock.swap())
    .addInput(userUtxo, sig.unlockP2PKH())
    .addOutput({ to: vault.tokenAddress, amount: 5_000n, token: { category, amount: supply } })
    .addOutput({ to: userAddr, amount: 54_000n })
    .debug();
}, false);
// Refund: a holder returns 30 credits and takes 3,000 sats.
const holder = withLb(randomUtxo({ satoshis: 1_000n, token: { category, amount: 30n } }), userAddr);
provider.addUtxo(userAddr, holder);
ok &= check("refund 30 credits for 3,000 sats", () => {
  new TransactionBuilder({ provider })
    .addInput(vaultUtxo, vault.unlock.swap())
    .addInput(holder, sig.unlockP2PKH())
    .addOutput({ to: vault.tokenAddress, amount: 7_000n, token: { category, amount: supply + 30n } })
    .addOutput({ to: userAddr, amount: 4_000n - 500n })
    .debug();
}, true);
console.log(ok ? "ALL PASS" : "SOME FAILED");
process.exit(ok ? 0 : 1);
