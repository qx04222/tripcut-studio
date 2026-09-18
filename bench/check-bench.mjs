#!/usr/bin/env node
// R19 E-02:把一次 bench/run-import-bench.mjs 的 result.json 与
// bench/baseline/main-<sha>.json 比对——total_ms 不得超基线 +15%,rss_bytes.peak
// 不得超基线 +10%。
//
// 头两周(拍板 Q-13)只报告不拦截:默认退出码恒 0,只在 stdout 打印 PASS/FAIL 供人看;
// 加 --enforce 才会在真的超阈值时以非零退出码失败(供 CI/fast-gates 未来切换用)。
//
// 用法: node bench/check-bench.mjs <result.json> [--baseline bench/baseline/main-<sha>.json] [--enforce]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const enforce = process.argv.includes("--enforce");
const resultPath = process.argv[2];
if (!resultPath || resultPath.startsWith("--")) {
  console.error("用法: node bench/check-bench.mjs <result.json> [--baseline <path>] [--enforce]");
  process.exit(2);
}
if (!existsSync(resultPath)) { console.error(`result 不存在: ${resultPath}`); process.exit(2); }
const result = JSON.parse(readFileSync(resultPath, "utf8"));

function latestBaseline() {
  const dir = join(repoRoot, "bench/baseline");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("main-") && f.endsWith(".json")) : [];
  if (files.length === 0) return null;
  files.sort();
  return join(dir, files.at(-1));
}
const baselinePath = argument("--baseline") ?? latestBaseline();
if (!baselinePath || !existsSync(baselinePath)) {
  console.error(`没有基线可比(bench/baseline/main-<sha>.json 不存在)。先跑一次 --write-baseline。`);
  process.exit(enforce ? 1 : 0);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const ratio = (a, b) => (b ? a / b : Infinity);
const totalRatio = ratio(result.total_ms, baseline.total_ms);
const rssRatio = ratio(result.rss_bytes.peak, baseline.rss_bytes.peak);
const checks = [
  { id: "total_ms<=+15%", pass: totalRatio <= 1.15, detail: `${result.total_ms}ms vs baseline ${baseline.total_ms}ms (${(totalRatio * 100).toFixed(1)}%)` },
  { id: "rss_peak<=+10%", pass: rssRatio <= 1.10, detail: `${result.rss_bytes.peak}B vs baseline ${baseline.rss_bytes.peak}B (${(rssRatio * 100).toFixed(1)}%)` },
];
const failed = checks.filter((c) => !c.pass);
console.log(`baseline: ${baselinePath}`);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.detail}`);
const mode = enforce ? "enforce" : "report-only(Q-13 头两周不拦截)";
console.log(`${failed.length === 0 ? "PASS" : "FAIL"} check-bench [${mode}]`);
process.exitCode = enforce && failed.length > 0 ? 1 : 0;
