// Headless WizardConnect test wallet: implements the official WalletAdapter with an HD key
// from TEST_MNEMONIC (a chipnet-only test seed), and signs P2PKH inputs the way the
// protocol requires (Schnorr, SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS).
// It never touches mainnet keys: it refuses to start without TEST_MNEMONIC.
import {
  deriveSeedFromBip39Mnemonic, deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPublicNode,
  encodeHdPublicKey, secp256k1, sha256, hash256, hexToBin, binToHex, decodeTransactionBCH,
  encodeTransactionBCH, generateSigningSerializationBCH, encodeLockingBytecodeP2pkh, hash160,
  lockingBytecodeToCashAddress, SigningSerializationFlag,
} from "@bitauth/libauth";
import { WalletConnectionManager } from "@wizardconnect/wallet";
import { toUint8Array, toBigInt } from "@wizardconnect/core";

const SIGHASH = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId; // 0x61

export function makeKeys(mnemonic, network = "chipnet") {
  const seed = deriveSeedFromBip39Mnemonic(mnemonic);
  const master = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });
  const account = deriveHdPath(master, "m/44'/145'/0'");
  if (typeof account === "string") throw new Error(account);
  const node = (child, index) => {
    const n = deriveHdPath(master, `m/44'/145'/0'/${child}/${index}`);
    if (typeof n === "string") throw new Error(n);
    return n;
  };
  const pub = (child, index) => secp256k1.derivePublicKeyCompressed(node(child, index).privateKey);
  const address = (child, index) => {
    const lb = encodeLockingBytecodeP2pkh(hash160(pub(child, index)));
    const r = lockingBytecodeToCashAddress({ bytecode: lb, prefix: network === "mainnet" ? "bitcoincash" : "bchtest" });
    return typeof r === "string" ? r : r.address;
  };
  const xpub = (child) => {
    const n = deriveHdPath(master, `m/44'/145'/0'/${child}`);
    if (typeof n === "string") throw new Error(n);
    const r = encodeHdPublicKey({ network: "mainnet", node: deriveHdPublicNode(n) });
    return typeof r === "string" ? r : r.hdPublicKey;
  };
  return { node, pub, address, xpub };
}

const PATH_CHILD = { receive: 0, change: 1, defi: 7 };

export function signP2pkhInputs(keys, wcTx, inputPaths) {
  const tx = typeof wcTx.transaction === "string" ? decodeTransactionBCH(hexToBin(wcTx.transaction)) : wcTx.transaction;
  if (typeof tx === "string") throw new Error(tx);
  const sourceOutputs = wcTx.sourceOutputs.map((o) => ({ lockingBytecode: toUint8Array(o.lockingBytecode), valueSatoshis: toBigInt(o.valueSatoshis), token: o.token }));
  for (const [inputIndex, pathName, addressIndex] of inputPaths) {
    const child = typeof pathName === "number" ? pathName : PATH_CHILD[pathName];
    const n = keys.node(child, addressIndex);
    const pubkey = secp256k1.derivePublicKeyCompressed(n.privateKey);
    const coveredBytecode = sourceOutputs[inputIndex].lockingBytecode;
    const serialization = generateSigningSerializationBCH(
      { inputIndex, sourceOutputs, transaction: tx },
      { coveredBytecode, signingSerializationType: new Uint8Array([SIGHASH]) },
    );
    const digest = hash256(serialization);
    const sig = secp256k1.signMessageHashSchnorr(n.privateKey, digest);
    if (typeof sig === "string") throw new Error(sig);
    const fullSig = new Uint8Array([...sig, SIGHASH]);
    tx.inputs[inputIndex].unlockingBytecode = new Uint8Array([fullSig.length, ...fullSig, pubkey.length, ...pubkey]);
  }
  return binToHex(encodeTransactionBCH(tx));
}

export function startTestWallet({ mnemonic, network = "chipnet", onSigned } = {}) {
  if (!mnemonic) throw new Error("TEST_MNEMONIC is required (chipnet test seed only)");
  const keys = makeKeys(mnemonic, network);
  const adapter = {
    walletName: "Headless Test Wallet",
    walletIcon: "",
    getRelayPrivateKey: (uri) => sha256.hash(new TextEncoder().encode("relay:" + mnemonic + uri)),
    getPublicKey: (path, index) => keys.pub(path, Number(index)),
    getXpub: (path) => keys.xpub(path),
    signTransaction: async (request) => ({ signedTransaction: signP2pkhInputs(keys, request.transaction, request.inputPaths) }),
  };
  const manager = new WalletConnectionManager(adapter);
  manager.on("pendingSignRequest", async ({ connectionId, request }) => {
    try {
      const { signedTransaction } = await adapter.signTransaction(request);
      await manager.sendSignResponse(connectionId, request.sequence, signedTransaction);
      onSigned?.(signedTransaction);
    } catch (e) {
      await manager.sendSignError(connectionId, request.sequence, String(e?.message ?? e));
    }
  });
  return { manager, keys };
}
