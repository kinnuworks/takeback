// Runs the differential fuzzer (src/lib/fuzz.ts) against ReceiptMinter on the BCH 2026 VM.
// Usage: node contracts/fuzz.test.mjs [n] [seed] [--save]
// The plan's counted run is n = 20000, seed = 20261122 (evidence/EVAL_PLAN.md, second plan);
// --save writes evidence/fuzz-result.json. Exits non-zero on any security-hole disagreement.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runOne, summarize } from "../src/lib/fuzz.ts";

const n = Number(process.argv[2] ?? 2000), seed = Number(process.argv[3] ?? 20261122);
const t0 = Date.now();
const results = [];
for (let i = 0; i < n; i++) results.push(runOne(seed, i));
const s = summarize(seed, results);
const broke = s.counts["agree-refused"] + s.counts.hole;
let interval = "";
try { interval = execFileSync("python3", ["-I", new URL("../../evidence/interval.py", import.meta.url).pathname, "wilson", String(s.counts["agree-refused"]), String(broke)], { encoding: "utf8" }).trim().split("\n").pop(); } catch {}
console.log(`fuzz seed ${seed}: ${n} random transactions in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`  rule-breaking (per the model): ${broke}; refused by the contract: ${s.counts["agree-refused"]}${interval ? ` (${interval})` : ""}`);
console.log(`  allowed (per the model): ${s.counts["agree-accepted"] + s.counts["too-strict"]}; accepted by the contract: ${s.counts["agree-accepted"]}`);
console.log(`  security holes (contract accepted what the rules forbid): ${s.counts.hole}`);
console.log(`  too strict (contract refused what the rules allow): ${s.counts["too-strict"]}`);
console.log(`  not evaluated (transaction couldn't be built): ${s.counts.setup}`);
for (const d of s.disagreements.slice(0, 12)) console.log(`  DISAGREE #${d.i} ${d.outcome} ${d.fn} [${d.muts.join(",")}] model: ${d.model} | contract: ${d.contract}`);
for (const d of s.setups.slice(0, 5)) console.log(`  SETUP #${d.i} ${d.fn} [${d.muts.join(",")}] ${d.contract}`);
const top = Object.entries(s.byRule).sort((a, b) => b[1] - a[1]);
console.log(`  rules that refused cases: ${top.length} distinct; top: ${top.slice(0, 6).map(([k, v]) => `${k} (${v})`).join("; ")}`);
if (process.argv.includes("--save")) {
  writeFileSync(new URL("../../evidence/fuzz-result.json", import.meta.url), JSON.stringify({ ...s, ranAt: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, interval }, null, 2) + "\n");
  console.log("saved evidence/fuzz-result.json");
}
process.exit(s.counts.hole === 0 ? 0 : 1);
