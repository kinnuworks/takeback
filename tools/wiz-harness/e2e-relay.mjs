// End-to-end check of WizardConnect over the real relay, no phone: a dapp pairs with the
// headless test wallet, asks it to sign a P2PKH spend of a made-up UTXO, and the signed
// transaction is verified in libauth's BCH virtual machine. Nothing is broadcast.
// Usage: TEST_MNEMONIC="..." node e2e-relay.mjs
import { initiateDappRelay, RelayStatus } from "@wizardconnect/core";
import { DappConnectionManager } from "@wizardconnect/dapp";
import {
  createVirtualMachineBCH, decodeTransactionBCH, hexToBin, encodeLockingBytecodeP2pkh, hash160,
  binToHex, generateRandomBytes, encodeTransactionBCH, stringify,
} from "@bitauth/libauth";
import { startTestWallet } from "./testwallet.mjs";

const mnemonic = process.env.TEST_MNEMONIC;
const timeout = setTimeout(() => { console.error("FAIL: timed out after 60s"); process.exit(1); }, 60_000);

const { manager: wallet, keys } = startTestWallet({ mnemonic });
const dapp = new DappConnectionManager("wiz-harness", undefined, { session: false });
const relay = initiateDappRelay((u) => dapp.updateConnection(u.client, u.status));
dapp.attachRelay(relay);
console.log("dapp URI ready:", relay.uri.slice(0, 24) + "...");

dapp.on("walletready", async (msg) => {
  console.log("wallet_ready from:", msg.wallet_name);
  const pubkey = keys.pub(0, 0);
  const lockingBytecode = encodeLockingBytecodeP2pkh(hash160(pubkey));
  const sourceOutput = { lockingBytecode, valueSatoshis: 10_000n };
  const transaction = {
    version: 2, locktime: 0,
    inputs: [{ outpointTransactionHash: generateRandomBytes(32), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode, valueSatoshis: 9_000n }],
  };
  const t0 = Date.now();
  const signed = await dapp.signTransaction({
    transaction: JSON.parse(stringify({ transaction: binToHex(encodeTransactionBCH(transaction)), sourceOutputs: [{ ...transaction.inputs[0], ...sourceOutput }], broadcast: false })),
    inputPaths: [[0, "receive", 0]],
  });
  const hex = typeof signed === "string" ? signed : signed.signedTransaction;
  const tx = decodeTransactionBCH(hexToBin(hex));
  const vm = createVirtualMachineBCH();
  const result = vm.verify({ sourceOutputs: [sourceOutput], transaction: tx });
  console.log("signed in", Date.now() - t0, "ms; VM verify:", result === true ? "PASS" : result);
  clearTimeout(timeout);
  relay.cleanup?.();
  process.exit(result === true ? 0 : 1);
});

// The wallet scans the dapp's URI, as a phone would scan the QR.
setTimeout(() => wallet.connect(relay.uri), 500);
