// Prints the mainnet receive address 0 of the merchant float and the test buyer wallets.
import { makeKeys } from "./testwallet.mjs";
for (const name of ["TAKEBACK_MERCHANT_MNEMONIC", "MAINNET_TEST_MNEMONIC"]) {
  const m = process.env[name];
  if (!m) { console.error(name + " missing"); process.exit(1); }
  console.log(name.replace("_MNEMONIC", ""), makeKeys(m, "mainnet").address(0, 0));
}
