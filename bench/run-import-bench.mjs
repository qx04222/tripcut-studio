#!/usr/bin/env node
// R19 E-02:固定 100 条(或 --fixtures 指定的)夹具跑一次导入性能基准,产出 JSON。
// 复用 src-tauri/examples/perf_driver(与 scripts/qa/perf-harness.mjs 同一个驱动),
// 区别是本脚本落盘到 bench/runs/,并且默认用 bench/fixtures/ 下的固定清单而不是
// ~/Library/Caches 下按需生成的散装夹具目录。
//
// 用法: node bench/run-import-bench.mjs [--fixtures 100] [--workers 4] [--budget-gb <本机GB>] [--out <path>]
import { existsSync, mkdirSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const repoRoot = resolve(import.meta.dirname, "..");
const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const fixtures = Number(argument("--fixtures") ?? 100);
const workers = Number(argument("--workers") ?? 4);
const budgetGbRaw = argument("--budget-gb");
const budgetGb = budgetGbRaw ? Number(budgetGbRaw) : Math.round(Number(spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).stdout.trim()) / 1024 ** 3);

const fixtureDir = argument("--fixture-dir") ?? join(import.meta.dirname, "fixtures", "cache");
if (!existsSync(join(fixtureDir, "manifest.json")) || statSync(join(fixtureDir, "manifest.json")).size === 0) {
  console.log(`fixtures 缺失,生成 ${fixtures} 条到 ${fixtureDir} ...`);
  const gen = spawnSync("zsh", [join(repoRoot, "scripts/qa/make-perf-fixtures.sh"), String(fixtures), fixtureDir], { stdio: "inherit" });
  if (gen.status !== 0) { console.error("生成夹具失败"); process.exit(gen.status ?? 1); }
}

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outDir = argument("--out-dir") ?? join(repoRoot, "bench/runs", `${timestamp}-n${fixtures}`);
mkdirSync(outDir, { recursive: true });

const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH ?? ""}`,
  TRIPCUT_MEMORY_BUDGET_BYTES: String(budgetGb * 1024 ** 3) };

const cargoTarget = process.env.CARGO_TARGET_DIR ?? join(homedir(), "Projects/tripcut-studio/src-tauri/target");
const driverBin = join(cargoTarget, "release/examples/perf_driver");
if (!existsSync(driverBin)) {
  console.error(`perf_driver 未构建: ${driverBin}\n先跑: cargo build --release --manifest-path src-tauri/Cargo.toml --example perf_driver`);
  process.exit(1);
}

const dbPath = join(outDir, "bench.db");
const resultPath = argument("--out") ?? join(outDir, "result.json");
const run = spawnSync(driverBin, ["--db", dbPath, "--folder", fixtureDir, "--workers", String(workers), "--out", resultPath],
  { cwd: repoRoot, encoding: "utf8", env });
writeFileSync(join(outDir, "perf_driver.log"), `${run.stdout}\n${run.stderr}`);
if (run.status !== 0) { console.error(`perf_driver exit=${run.status}`); console.error(run.stderr); process.exit(run.status ?? 1); }
console.log(run.stdout.trim());
console.log(resultPath);
