// Runs evidence/attacks.json against ReceiptMinter (cases in src/lib/attacks.ts, the same code the
// live break-test page runs) on the BCH 2026 VM. Valid cases must pass, every attack must be
// rejected by the contract itself (setup errors don't count). Prints k of n with a Wilson 95%
// interval from evidence/interval.py; exits non-zero on any miss.
import { execFileSync } from "node:child_process";
import { runAll } from "../src/lib/attacks.ts";

const results = runAll();
for (const r of results) console.log(r.ok ? "PASS" : r.outcome === "not-applicable" ? "N/A " : "FAIL", r.id, r.what, "->", r.detail);
const valid = results.filter((r) => r.kind === "valid" && r.outcome !== "not-applicable");
const na = results.filter((r) => r.outcome === "not-applicable").map((r) => r.id);
const attacks = results.filter((r) => r.kind === "attack");
const rejected = attacks.filter((r) => r.outcome === "rejected").length;
const accepted = valid.filter((r) => r.ok).length;
let interval = "";
try {
  interval = execFileSync("python3", ["-I", new URL("../../evidence/interval.py", import.meta.url).pathname, "wilson", String(rejected), String(attacks.length)], { encoding: "utf8" }).trim().split("\n").pop();
} catch { /* interval is reporting only */ }
console.log(`valid accepted: ${accepted} of ${valid.length}${na.length ? ` (n/a: ${na.join(",")})` : ""}`);
console.log(`attacks rejected by the contract: ${rejected} of ${attacks.length}${interval ? `; ${interval}` : ""}`);
process.exit(accepted === valid.length && rejected === attacks.length ? 0 : 1);
