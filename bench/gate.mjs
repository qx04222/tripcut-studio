#!/usr/bin/env node
// R19 E-02:fast-gates 里的 "perf-bench-100" 条目——跑一次 100 条固定夹具的导入基准,
// 再用 bench/check-bench.mjs 报告(不是 --enforce)。Q-13 拍板:头两周只报告不拦截,
// 所以这里永远以 exit 0 收尾(除非跑基准本身失败,比如 perf_driver 没编译出来——
// 那是基建坏了,不是性能倒退,应该照样让 fast-gates 报红)。
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const run = spawnSync("node", ["bench/run-import-bench.mjs", "--fixtures", "100"], { cwd: repoRoot, encoding: "utf8" });
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.status !== 0) {
  console.error("perf-bench-100: run-import-bench 失败(基建问题,不是阈值判定)");
  process.exit(run.status ?? 1);
}
const resultPath = (run.stdout.trim().split("\n").pop() ?? "").trim();
const check = spawnSync("node", ["bench/check-bench.mjs", resultPath], { cwd: repoRoot, encoding: "utf8" });
process.stdout.write(check.stdout ?? "");
process.stderr.write(check.stderr ?? "");
// report-only(Q-13):check-bench 不带 --enforce 已经恒 0,这里再兜底一次,
// 避免将来有人给 check-bench 默认值动手脚时误伤 fast-gates。
process.exit(0);
