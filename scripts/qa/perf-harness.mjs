#!/usr/bin/env node
// 性能验收装置:生成夹具(缺则建)、跑 perf_driver、与基线比对、落 qa/runs/<ts>-perf/。
// 用法: node scripts/qa/perf-harness.mjs --budget-gb <本机内存GB> [--fixtures 500] [--workers 4] [--write-baseline] [--label 前|后] [--fixture-dir <dir>]
// `--budget-gb` 必须显式传入,没有默认值——机器之间的物理内存差得远(这台是
// 32GB,曾经硬编码的 12 是 Low 档,不是这台机器的标准档),悄悄给一个默认值
// 只会让人在错的机器上引用错的基线而不自知。先跑 `sysctl hw.memsize` 读本机
// 物理内存字节数,换算成 GB 后传进来。
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const repoRoot = resolve(import.meta.dirname, "../..");
const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (name) => process.argv.includes(name);
const fixtures = Number(argument("--fixtures") ?? 500);
const workers = Number(argument("--workers") ?? 4);
const budgetGbRaw = argument("--budget-gb");
if (budgetGbRaw === undefined) {
  console.error("用法: node scripts/qa/perf-harness.mjs --budget-gb <本机内存GB> [--fixtures 500] [--workers 4] [--write-baseline] [--label 前|后] [--fixture-dir <dir>]");
  console.error("--budget-gb 是必填项,没有默认值——先跑 `sysctl hw.memsize` 读本机物理内存再换算成 GB 传入(这台机器是 32)。");
  process.exit(1);
}
const budgetGb = Number(budgetGbRaw);
const label = argument("--label") ?? "run";
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outDir = join(repoRoot, "qa/runs", `${timestamp}-perf-${label}`);
mkdirSync(outDir, { recursive: true });
const cache = join(homedir(), "Library/Caches/tripcut-perf");
const fixtureDir = argument("--fixture-dir") ?? join(cache, "fixtures");
const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH ?? ""}`,
  TRIPCUT_MEMORY_BUDGET_BYTES: String(budgetGb * 1024 ** 3) };
const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], ...extra });
  writeFileSync(join(outDir, `${args[0] ?? cmd}.log`), `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) { console.error(`${cmd} ${args.join(" ")} exit=${r.status}`); process.exit(r.status ?? 1); }
  return r;
};
if (!existsSync(join(fixtureDir, "manifest.json"))) run("zsh", ["scripts/qa/make-perf-fixtures.sh", String(fixtures), fixtureDir]);
run("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml", "--example", "perf_driver"]);
const resultPath = join(outDir, "result.json");
run(join(repoRoot, "src-tauri/target/release/examples/perf_driver"),
  ["--db", join(cache, "perf.db"), "--folder", fixtureDir, "--workers", String(workers), "--out", resultPath]);
copyFileSync(join(cache, "perf.db"), join(outDir, "perf.db"));
const result = JSON.parse(readFileSync(resultPath, "utf8"));
const baselinePath = join(repoRoot, "benchmark/perf-baseline.json");
const writeBaseline = flag("--write-baseline");
const checks = [];
const red = (id, detail) => checks.push({ id, pass: false, detail });
const green = (id, detail) => checks.push({ id, pass: true, detail });
if (result.jobs.failed > 0 || result.jobs.blocked > 0) red("jobs.clean", JSON.stringify(result.jobs)); else green("jobs.clean", JSON.stringify(result.jobs));
if (result.first_screen_cover_ms == null || result.first_screen_cover_ms > 30_000) red("first-screen<=30s", String(result.first_screen_cover_ms)); else green("first-screen<=30s", String(result.first_screen_cover_ms));
if (result.swapouts_delta > 0) red("swapouts=0", String(result.swapouts_delta)); else green("swapouts=0", "0");
if (existsSync(baselinePath) && !writeBaseline) {
  const base = JSON.parse(readFileSync(baselinePath, "utf8"));
  const ratio = (a, b) => (b ? a / b : 1);
  const rss = ratio(result.rss_bytes.peak, base.rss_bytes.peak);
  const total = ratio(result.total_ms, base.total_ms);
  (rss > 1.10 ? red : green)("rss-peak<=+10%", `${(rss * 100).toFixed(1)}% of baseline`);
  (total > 1.15 ? red : green)("total<=+15%", `${(total * 100).toFixed(1)}% of baseline`);
}
if (writeBaseline) { copyFileSync(resultPath, baselinePath); green("baseline.written", baselinePath); }
// --write-baseline 下 threshold 类检查(first-screen/swapouts)只记录、不参与 PASS/FAIL 判定;
// jobs.clean 和 baseline.written(即 result.json 落地成功)始终是硬门槛。
const hardChecks = writeBaseline ? checks.filter((c) => c.id === "jobs.clean" || c.id === "baseline.written") : checks;
const gate = { schemaVersion: 1, gate: "perf-harness", capturedAt: new Date().toISOString(),
  status: hardChecks.every((c) => c.pass) ? "PASS" : "FAIL", workers, fixtures: result.fixtures, budgetGb, checks, result };
writeFileSync(join(outDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}${writeBaseline && !hardChecks.includes(c) ? " (advisory)" : ""} ${c.id} ${c.detail}`);
console.log(`INFO excluded clip_embed_blocked=${result.excluded?.clip_embed_blocked ?? 0}`);
console.log(`DB ${join(outDir, "perf.db")}`);
console.log(`${gate.status} ${outDir}`);
process.exitCode = gate.status === "PASS" ? 0 : 1;
