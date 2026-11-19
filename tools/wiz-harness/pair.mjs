// Pairs the headless test wallet with a dapp URI (as a phone scanning the QR would) and stays
// connected for N seconds, signing any request. Usage: node pair.mjs '<wiz://...>' [seconds]
import { startTestWallet } from "./testwallet.mjs";
const [uri, secs = "45"] = process.argv.slice(2);
const { manager } = startTestWallet({ mnemonic: process.env.TEST_MNEMONIC, onSigned: (hex) => console.log("signed", hex.length / 2, "bytes") });
manager.on("connectionStatusChanged", (_id, status) => console.log("status", status));
manager.connect(uri);
setTimeout(() => process.exit(0), Number(secs) * 1000);
