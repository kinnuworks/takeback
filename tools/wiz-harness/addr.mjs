// Prints the test wallet's chipnet receive address 0 (reads TEST/CHIPNET mnemonic from the env file).
import { makeKeys } from "./testwallet.mjs";
const m = process.env.CHIPNET_TEST_MNEMONIC;
if (!m) { console.error("CHIPNET_TEST_MNEMONIC missing"); process.exit(1); }
console.log(makeKeys(m, "chipnet").address(0, 0));
