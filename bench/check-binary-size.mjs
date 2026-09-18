#!/usr/bin/env node
// R19 E-11:release 二进制与 DMG 体积门禁——不超基线 +10%。
// 用法:
//   记基线: node bench/check-binary-size.mjs --write-baseline
//   门禁:   node bench/check-binary-size.mjs [--enforce]
// 度量对象:
//   binary  = src-tauri/target/release/tripcut-studio(主可执行文件,tauri build 或
//             `cargo build --release --manifest-path src-tauri/Cargo.toml` 产物)
//   dmg     = 最近一次 scripts/package-dmg.sh 产物(若 dist/ 或 src-tauri/target/release/bundle
//             下找不到 .dmg,该项跳过并在报告里注明,不计入门禁失败)
import { existsSync, statSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

const repoRoot = resolve(import.meta.dirname, "..");
const enforce = process.argv.includes("--enforce");
const writeBaseline = process.argv.includes("--write-baseline");
const cargoTarget = process.env.CARGO_TARGET_DIR ?? join(homedir(), "Projects/tripcut-studio/src-tauri/target");
const binaryPath = join(cargoTarget, "release/tripcut-studio");

function findDmg() {
  const candidates = [join(repoRoot, "src-tauri/target/release/bundle/dmg"), join(cargoTarget, "release/bundle/dmg")];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const dmgs = readdirSync(dir).filter((f) => f.endsWith(".dmg"));
    if (dmgs.length > 0) return join(dir, dmgs.sort().at(-1));
  }
  return null;
}

if (!existsSync(binaryPath)) {
  console.error(`二进制不存在: ${binaryPath}\n先跑: cargo build --release --manifest-path src-tauri/Cargo.toml`);
  process.exit(enforce ? 1 : 0);
}
const binaryBytes = statSync(binaryPath).size;
const dmgPath = findDmg();
const dmgBytes = dmgPath ? statSync(dmgPath).size : null;

const baselineDir = join(import.meta.dirname, "baseline");
mkdirSync(baselineDir, { recursive: true });
const sizeBaselinePath = join(baselineDir, "binary-size.json");

if (writeBaseline) {
  writeFileSync(sizeBaselinePath, `${JSON.stringify({ binary_bytes: binaryBytes, dmg_bytes: dmgBytes, dmg_file: dmgPath ? basename(dmgPath) : null, recorded_at: new Date().toISOString() }, null, 2)}\n`);
  console.log(`baseline written: ${sizeBaselinePath} binary=${binaryBytes}B dmg=${dmgBytes ?? "n/a"}B`);
  process.exit(0);
}

if (!existsSync(sizeBaselinePath)) {
  console.error("没有 bench/baseline/binary-size.json,先 --write-baseline");
  process.exit(enforce ? 1 : 0);
}
const baseline = JSON.parse(readFileSync(sizeBaselinePath, "utf8"));
const ratio = binaryBytes / baseline.binary_bytes;
const checks = [{ id: "binary<=+10%", pass: ratio <= 1.10, detail: `${binaryBytes}B vs baseline ${baseline.binary_bytes}B (${(ratio * 100).toFixed(1)}%)` }];
if (dmgBytes != null && baseline.dmg_bytes != null) {
  const dmgRatio = dmgBytes / baseline.dmg_bytes;
  checks.push({ id: "dmg<=+10%", pass: dmgRatio <= 1.10, detail: `${dmgBytes}B vs baseline ${baseline.dmg_bytes}B (${(dmgRatio * 100).toFixed(1)}%)` });
} else {
  console.log(`INFO dmg 未找到,跳过 dmg 体积比对(binary=${dmgPath ?? "n/a"})`);
}
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.detail}`);
const failed = checks.filter((c) => !c.pass);
console.log(`${failed.length === 0 ? "PASS" : "FAIL"} check-binary-size`);
process.exitCode = enforce && failed.length > 0 ? 1 : 0;
