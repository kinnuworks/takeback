// Receipt amounts and order ids must round-trip through encodeReceipt/decodeReceipt exactly as the
// contract reads them (OP_BIN2NUM on 8 padded bytes). Amounts whose top byte has the high bit set
// (128, 255, 32768, 40000, 65535...) once decoded as negative after the padding was trimmed.
import { encodeReceipt, decodeReceipt } from "../src/lib/takeback.ts";
const amounts = [1n, 127n, 128n, 255n, 256n, 546n, 10_000n, 32_767n, 32_768n, 40_000n, 50_000n, 65_535n, 65_536n, 200_000n, 8_388_608n, 100_000_000n, 2_100_000_000_000_000n];
const orders = [1n, 128n, 40_000n, 17_636_412_001n];
let fails = 0;
for (const a of amounts) for (const o of orders) {
  const d = decodeReceipt(encodeReceipt(a, o));
  if (!d || d.amount !== a || d.orderId !== o) { fails++; if (fails <= 8) console.log("FAIL", a, o, "->", d?.amount, d?.orderId); }
}
console.log(fails ? `DECODE: ${fails} of ${amounts.length * orders.length} round trips wrong` : `DECODE: ALL PASS (${amounts.length * orders.length} amount and order round trips)`);
process.exit(fails ? 1 : 0);
