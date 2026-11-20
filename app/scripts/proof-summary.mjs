// Writes src/evidence/proof-summary.json, the compact view of the evidence files the live page shows
// (real-node replies, the fuzzer's counted run, the mutation test). --check fails if it's stale.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const ev = (f) => JSON.parse(readFileSync(new URL(`../../evidence/${f}`, import.meta.url), "utf8"));
const real = ev("real-node-chipnet.json"), fuzz = ev("fuzz-result.json"), fuzz1 = ev("fuzz-result-v1.json"), mut = ev("mutants-result.json");
const short = (s) => (s.match(/\(([^)]*)\)/)?.[1] ?? s).slice(0, 90);
const summary = {
  realNode: {
    network: real.summary.network, servers: real.summary.servers, ranAt: real.summary.ranAt,
    built: real.summary.attacksBuilt, refused: real.summary.attacksRefused, byContract: real.summary.refusedByContract, byConsensus: real.summary.refusedByOtherRules,
    validAccepted: real.summary.validAccepted, validRun: real.summary.validRun,
    cases: real.cases.map((c) => ({ id: c.id, kind: c.kind, what: c.what, outcome: c.outcome, reason: c.reason, reply: c.replies ? short(c.replies.find((r) => !r.unreachable)?.reply ?? "") : "", txid: c.txid })),
  },
  fuzz: { seed: fuzz.seed, n: fuzz.n, counts: fuzz.counts, rules: Object.keys(fuzz.byRule).length, v1Holes: fuzz1.counts.hole },
  mutants: {
    killed: mut.killed, compiled: mut.compiled, total: mut.total,
    survivors: mut.results.filter((r) => r.outcome === "survived").map((r) => ({ line: r.line, fn: r.fn, check: r.check })),
  },
};
const out = new URL("../src/evidence/proof-summary.json", import.meta.url);
const text = JSON.stringify(summary, null, 1) + "\n";
if (process.argv.includes("--check")) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) { console.error("src/evidence/proof-summary.json is stale: run node scripts/proof-summary.mjs"); process.exit(1); }
  console.log("proof summary up to date");
} else { writeFileSync(out, text); console.log("wrote src/evidence/proof-summary.json"); }
