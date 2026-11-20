// Runs the receipt registry's parse bytecode the way a BCMR wallet does: inside the standardized NFT
// parsing transaction from the BCMR spec (input 0 spends the NFT, input 1 spends the empty-hash
// outpoint with unlocking OP_1 and locking = parse.bytecode, output 0 is OP_RETURN), on the BCH 2026
// VM. Passes if the stack ends as one truthy item and the altstack is [type "", amount, order id].
// Also checks every field the type lists is defined, and the registry validates its own shape.
import { createVirtualMachineBch2026, hexToBin, binToHex, vmNumberToBigInt, utf8ToBin, sha256 } from "@bitauth/libauth";
import { RECEIPT_PARSE_BYTECODE, receiptRegistry } from "../src/lib/bcmr.ts";
import { encodeReceipt } from "../src/lib/takeback.ts";

const vm = createVirtualMachineBch2026();
const category = binToHex(sha256.hash(utf8ToBin("bcmr-parse-test")));
const fails = [];
function parse(commitmentHex) {
  const sourceOutputs = [
    { lockingBytecode: hexToBin("76a914" + "11".repeat(20) + "88ac"), valueSatoshis: 1000n, token: { category: hexToBin(category), amount: 0n, nft: { capability: "none", commitment: hexToBin(commitmentHex) } } },
    { lockingBytecode: hexToBin(RECEIPT_PARSE_BYTECODE), valueSatoshis: 0n },
  ];
  const transaction = {
    version: 2, locktime: 0,
    inputs: [
      { outpointTransactionHash: hexToBin("22".repeat(32)), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() },
      { outpointTransactionHash: new Uint8Array(32), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x51) },
    ],
    outputs: [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }],
  };
  const state = vm.evaluate({ inputIndex: 1, sourceOutputs, transaction });
  if (state.error) return { error: state.error };
  const truthy = state.stack.length === 1 && state.stack[0].some((b) => b !== 0);
  const alt = state.alternateStack.map((x) => (x.length ? vmNumberToBigInt(x, { requireMinimalEncoding: true }) : ""));
  return { truthy, alt };
}
for (const [amount, order] of [[10_000n, 17636412001n], [546n, 1n], [20_000n, 99n], [2_000_000n, 1_763_641_200_123n]]) {
  const r = parse(encodeReceipt(amount, order));
  const ok = !r.error && r.truthy && r.alt.length === 3 && r.alt[0] === "" && r.alt[1] === amount && r.alt[2] === order;
  console.log(ok ? "PASS" : "FAIL", `receipt ${amount} sats, order ${order} ->`, r.error ?? `type "${r.alt[0]}", amount ${r.alt[1]}, order ${r.alt[2]}`);
  if (!ok) fails.push(amount);
}
const reg = receiptRegistry({ category, shopName: "Test", site: "https://example.invalid", at: "2026-11-20T00:00:00.000Z" });
const nfts = reg.identities[category]["2026-11-20T00:00:00.000Z"].token.nfts;
for (const [key, type] of Object.entries(nfts.parse.types)) for (const f of type.fields) if (!nfts.fields[f]) { console.log("FAIL type", key, "lists undefined field", f); fails.push(f); }
console.log(fails.length ? "BCMR PARSE: FAIL" : "BCMR PARSE: ALL PASS (wallets that parse NFTs read amount and order id)");
process.exit(fails.length ? 1 : 0);
