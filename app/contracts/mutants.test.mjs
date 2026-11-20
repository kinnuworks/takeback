// Mutation testing of ReceiptMinter.cash: delete one `require` at a time, recompile, and run the
// three attack lists plus 5,000 fuzz cases against the mutant. A mutant is "killed" when an attack
// gets through, a valid case is refused, or the fuzzer finds a disagreement with the rules. A mutant
// that survives means that check is either redundant or untested; each survivor is listed.
// Usage: node contracts/mutants.test.mjs [--save]
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const FUZZ_N = 5000, SEED = 20261122;
if (process.argv[2] === "--child") {
  globalThis.__TAKEBACK_ARTIFACT__ = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const { runAll } = await import("../src/lib/attacks.ts");
  const { runOne } = await import("../src/lib/fuzz.ts");
  const res = runAll("all");
  const out = { attacksThrough: res.filter((r) => r.kind === "attack" && r.outcome === "accepted").map((r) => r.id), validRefused: res.filter((r) => r.kind === "valid" && r.outcome === "rejected").map((r) => r.id), holes: 0, tooStrict: 0, firstFuzz: "" };
  for (let i = 0; i < FUZZ_N; i++) {
    const r = runOne(SEED, i);
    if (r.outcome === "hole" || r.outcome === "too-strict") { out[r.outcome === "hole" ? "holes" : "tooStrict"]++; out.firstFuzz ||= `#${i} ${r.fn} [${r.muts.join(",")}] ${r.model}`; }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const { compileString } = await import("cashc");
const src = readFileSync(new URL("./ReceiptMinter.cash", import.meta.url), "utf8");
const lines = src.split("\n");
const dir = mkdtempSync(join(tmpdir(), "takeback-mutants-"));
const targets = lines.map((l, i) => ({ i, l })).filter(({ l }) => /^\s*require\(/.test(l));
const fnOf = (i) => { for (let k = i; k >= 0; k--) { const m = lines[k].match(/function (\w+)\(/); if (m) return m[1]; } return "?"; };
const child = (artifactPath) => new Promise((resolve) => {
  const p = spawn(process.execPath, [new URL(import.meta.url).pathname, "--child", artifactPath], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("exit", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve({ error: err.split("\n").find((x) => x.trim()) ?? "child failed" }); } });
});
const kill = (r) => r.attacksThrough?.length || r.validRefused?.length || r.holes || r.tooStrict;

// Control: the real contract must survive everything.
const ctrlPath = join(dir, "control.json");
writeFileSync(ctrlPath, JSON.stringify(compileString(src)));
const control = await child(ctrlPath);
if (kill(control) || control.error) { console.error("control failed:", control); process.exit(1); }
console.log("control (unmutated v2): every attack refused, every valid case accepted, 0 fuzz disagreements");

const results = [];
const queue = [...targets];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const { i, l } = queue.shift();
    const mutant = lines.map((x, k) => (k === i ? "" : x)).join("\n");
    let compiled;
    try { compiled = compileString(mutant); } catch (e) { results.push({ line: i + 1, fn: fnOf(i), check: l.trim(), outcome: "does not compile", detail: String(e.message ?? e).split("\n")[0] }); continue; }
    const p = join(dir, `m${i + 1}.json`);
    writeFileSync(p, JSON.stringify(compiled));
    const r = await child(p);
    results.push({ line: i + 1, fn: fnOf(i), check: l.trim(), outcome: r.error ? "error" : kill(r) ? "killed" : "survived", ...r });
  }
}));
results.sort((a, b) => a.line - b.line);
const compiledN = results.filter((r) => r.outcome === "killed" || r.outcome === "survived").length;
const killed = results.filter((r) => r.outcome === "killed").length;
for (const r of results) console.log(r.outcome.toUpperCase().padEnd(16), `line ${r.line}`.padEnd(9), r.fn.padEnd(14), r.check, r.outcome === "killed" ? `<- ${[...(r.attacksThrough ?? []).slice(0, 3), r.holes ? `${r.holes} fuzz holes` : "", r.tooStrict ? `${r.tooStrict} too strict` : ""].filter(Boolean).join(", ")}` : r.detail ?? "");
console.log(`mutation score: ${killed} of ${compiledN} single-check deletions killed (${results.length - compiledN} don't compile)`);
if (process.argv.includes("--save")) {
  writeFileSync(new URL("../../evidence/mutants-result.json", import.meta.url), JSON.stringify({ ranAt: new Date().toISOString(), fuzzCasesPerMutant: FUZZ_N, seed: SEED, killed, compiled: compiledN, total: results.length, results }, null, 2) + "\n");
  console.log("saved evidence/mutants-result.json");
}
process.exit(0);
