// The instant demo wallet: a throwaway key made in this browser, one per network (a chipnet key is
// never used on mainnet), funded by /api/faucet: test coins on chipnet, a few cents of real BCH on
// mainnet when the owner has switched that faucet on. It signs the same transactions a phone wallet
// signs over WizardConnect (P2PKH inputs, Schnorr, SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID), so
// the demo runs the real purchase and refund paths against the real contract.
import {
  secp256k1, hash160, hash256, binToHex, hexToBin, decodeTransactionBCH, encodeTransactionBCH,
  generateSigningSerializationBCH, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, SigningSerializationFlag,
  cashAddressToLockingBytecode,
} from "@bitauth/libauth";
import { parseExtendedJson, toUint8Array, toBigInt } from "@wizardconnect/core";

type Net = "mainnet" | "chipnet";
const storeKey = (net: Net) => `takeback-demo-key-${net}`;
const SIGHASH = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;

export interface Burner { priv: Uint8Array; pub: Uint8Array; address: string; tokenAddress: string }

function fromPriv(priv: Uint8Array, net: Net): Burner {
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const lb = encodeLockingBytecodeP2pkh(hash160(pub));
  const prefix = net === "mainnet" ? "bitcoincash" : "bchtest";
  const a = lockingBytecodeToCashAddress({ bytecode: lb, prefix });
  const t = lockingBytecodeToCashAddress({ bytecode: lb, prefix, tokenSupport: true });
  if (typeof a === "string" || typeof t === "string") throw new Error("address encoding failed");
  return { priv, pub, address: a.address, tokenAddress: t.address };
}

/** Loads this browser's demo key, or makes one. Storage can be blocked: then the key lives for this page only. */
export function loadBurner(net: Net = "chipnet"): Burner {
  try {
    const saved = localStorage.getItem(storeKey(net));
    if (saved && /^[0-9a-f]{64}$/.test(saved)) return fromPriv(hexToBin(saved), net);
  } catch { /* storage blocked: fall through to a fresh key */ }
  let priv: Uint8Array;
  do { priv = crypto.getRandomValues(new Uint8Array(32)); } while (!secp256k1.validatePrivateKey(priv));
  try { localStorage.setItem(storeKey(net), binToHex(priv)); } catch { /* page-only key */ }
  return fromPriv(priv, net);
}

/**
 * Signs the given inputs of a WizardConnect transaction object (the JSON a wallet receives), the way
 * a phone wallet does, and returns the signed transaction hex.
 */
export function signWcInputs(wcJson: unknown, inputIndexes: number[], b: Burner): string {
  const wc = parseExtendedJson(JSON.stringify(wcJson)) as { transaction: unknown; sourceOutputs: { lockingBytecode: unknown; valueSatoshis: unknown; token?: unknown }[] };
  const tx = typeof wc.transaction === "string" ? decodeTransactionBCH(hexToBin(wc.transaction)) : (wc.transaction as ReturnType<typeof decodeTransactionBCH>);
  if (typeof tx === "string") throw new Error(tx);
  const sourceOutputs = wc.sourceOutputs.map((o) => ({ lockingBytecode: toUint8Array(o.lockingBytecode as never), valueSatoshis: toBigInt(o.valueSatoshis as never), token: o.token as never }));
  for (const i of tx.inputs) i.unlockingBytecode ??= new Uint8Array();
  for (const inputIndex of inputIndexes) {
    const serialization = generateSigningSerializationBCH(
      { inputIndex, sourceOutputs, transaction: tx },
      { coveredBytecode: sourceOutputs[inputIndex].lockingBytecode, signingSerializationType: new Uint8Array([SIGHASH]) },
    );
    const sig = secp256k1.signMessageHashSchnorr(b.priv, hash256(serialization));
    if (typeof sig === "string") throw new Error(sig);
    const full = new Uint8Array([...sig, SIGHASH]);
    tx.inputs[inputIndex].unlockingBytecode = new Uint8Array([full.length, ...full, b.pub.length, ...b.pub]);
  }
  return binToHex(encodeTransactionBCH(tx));
}

/** The fee a transaction object pays: inputs minus outputs. */
export function feeOf(wcJson: unknown): bigint {
  const wc = parseExtendedJson(JSON.stringify(wcJson)) as { transaction: unknown; sourceOutputs: { valueSatoshis: unknown }[] };
  const tx = typeof wc.transaction === "string" ? decodeTransactionBCH(hexToBin(wc.transaction)) : (wc.transaction as ReturnType<typeof decodeTransactionBCH>);
  if (typeof tx === "string") return 0n;
  const ins = wc.sourceOutputs.reduce((s, o) => s + toBigInt(o.valueSatoshis as never), 0n);
  return ins - tx.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
}

/**
 * Checks a refund the server prepared before any wallet signs it: input 1 is the receipt being
 * refunded, and output 1 pays the holder's own address exactly the expected amount. Throws if not.
 */
export function checkRefundPlan(wcJson: unknown, inputIndex: number, receipt: { txid: string; vout: number }, holderAddress: string, amount: bigint): void {
  const wc = parseExtendedJson(JSON.stringify(wcJson)) as { transaction: unknown };
  const tx = typeof wc.transaction === "string" ? decodeTransactionBCH(hexToBin(wc.transaction)) : (wc.transaction as ReturnType<typeof decodeTransactionBCH>);
  if (typeof tx === "string") throw new Error("The server's refund couldn't be read");
  const lb = cashAddressToLockingBytecode(holderAddress);
  if (typeof lb === "string") throw new Error(lb);
  const inp = tx.inputs[inputIndex];
  const out = tx.outputs[1];
  const ok = inputIndex === 1 && !!inp && binToHex(inp.outpointTransactionHash) === receipt.txid && inp.outpointIndex === receipt.vout
    && !!out && binToHex(out.lockingBytecode) === binToHex(lb.bytecode) && out.valueSatoshis === amount && !out.token;
  if (!ok) throw new Error("The refund the server prepared doesn't pay you the receipt's amount; not signing it");
}
