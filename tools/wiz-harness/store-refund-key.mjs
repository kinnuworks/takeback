// Derives the shop's hot refund key (m/44'/145'/0'/0/1 of the merchant seed) and stores its hex in
// the macOS Keychain as TAKEBACK_REFUND_KEY, without printing it.
import { execFileSync } from "node:child_process";
import { binToHex } from "@bitauth/libauth";
import { makeKeys } from "./testwallet.mjs";
const k = makeKeys(process.env.TAKEBACK_MERCHANT_MNEMONIC, "mainnet");
execFileSync("security", ["add-generic-password", "-U", "-s", "hackathon-kit", "-a", "TAKEBACK_REFUND_KEY", "-w", binToHex(k.node(0, 1).privateKey)]);
console.log("stored TAKEBACK_REFUND_KEY (value not shown)");
