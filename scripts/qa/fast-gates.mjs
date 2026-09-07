#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../..");
const rustupBin = "/opt/homebrew/opt/rustup/bin";
const cargoHomeBin = join(process.env.HOME ?? "", ".cargo/bin");
const qaEnvironment = {
  ...process.env,
  PATH: [existsSync(rustupBin) ? rustupBin : null, existsSync(cargoHomeBin) ? cargoHomeBin : null, process.env.PATH ?? ""]
    .filter(Boolean)
    .join(":"),
};
const outputArgument = process.argv.indexOf("--out");
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outputDirectory = resolve(
  outputArgument >= 0 && process.argv[outputArgument + 1]
    ? process.argv[outputArgument + 1]
    : join(repoRoot, "qa/runs", `${timestamp}-fast-gates`),
);
mkdirSync(join(outputDirectory, "logs"), { recursive: true });

const strictFailurePatterns = [
  /Unhandled Errors?/i,
  /Unhandled Rejection/i,
  /not wrapped in act\(/i,
  /command not found/i,
  /\(!\) Some chunks are larger/,
];

const commands = [
  { id: "package-script-zsh-syntax", command: "zsh", args: ["-n", "scripts/package-dmg.sh"] },
  { id: "github-preview-script-zsh-syntax", command: "zsh", args: ["-n", "scripts/prepare-github-preview.sh"] },
  { id: "ffmpeg-build-script-zsh-syntax", command: "zsh", args: ["-n", "scripts/build-lgpl-ffmpeg.sh"] },
  { id: "libplacebo-build-script-zsh-syntax", command: "zsh", args: ["-n", "scripts/build-libplacebo.sh"] },
  { id: "mpv-build-script-zsh-syntax", command: "zsh", args: ["-n", "scripts/build-lgpl-mpv.sh"] },
  { id: "whisper-build-script-zsh-syntax", command: "zsh", args: ["-n", "scripts/build-whisper.sh"] },
  { id: "legacy-wrapper-sh-syntax", command: "sh", args: ["-n", "scripts/build-dmg.sh"] },
  { id: "preflight-script-syntax", command: "node", args: ["--check", "scripts/qa/preflight.mjs"] },
  { id: "cua-launcher-script-syntax", command: "node", args: ["--check", "scripts/qa/prepare-cua-candidate.mjs"] },
  { id: "crash-diff-script-syntax", command: "node", args: ["--check", "scripts/qa/crash-diff.mjs"] },
  { id: "dmg-audit-script-syntax", command: "node", args: ["--check", "scripts/qa/audit-dmg.mjs"] },
  // 全量跑 crash-recovery.mjs 太慢(要建种子库+跑三条崩溃路径),不进 fast-gates
  // 本体——只做语法检查。它是每日收尾链的一部分,单独用
  // `node scripts/qa/crash-recovery.mjs` 跑。
  { id: "crash-recovery-script-syntax", command: "node", args: ["--check", "scripts/qa/crash-recovery.mjs"] },
  // node_modules 必须与 package-lock 一致:并行车道加了 npm 依赖后主树没装,typescript/vitest 会以
  // "找不到模块"整片红;单列一步让根因一眼可见(F-R6-INT-2)。
  { id: "npm-deps-installed", command: "npm", args: ["ls", "--depth=0", "--silent"] },
  // 许可清单必须能生成:直接依赖缺映射时脚本抛错——R4/R5 加 printpdf/lopdf/rustfft 后曾在门禁之外红了一整轮。
  { id: "license-manifest", command: "node", args: ["scripts/generate-license-manifest.mjs"] },
  { id: "typescript", command: "npm", args: ["run", "typecheck"] },
  { id: "eslint", command: "npm", args: ["run", "lint"] },
  { id: "vite-build", command: "npm", args: ["run", "build"] },
  { id: "vitest", command: "npm", args: ["test"] },
  { id: "cargo-test", command: "cargo", args: ["test", "--manifest-path", "src-tauri/Cargo.toml"] },
  // R6 Task 2：真机剪映金丝雀——对活的 template.tmp 键集比对,剪映/草稿缺失时
  // 自己打印 SKIP 并直接 return(不假绿)。没有独立开关,就在 fast-gates 里
  // 老老实实真跑。
  {
    id: "jianying-canary",
    command: "cargo",
    args: ["test", "--manifest-path", "src-tauri/Cargo.toml", "--test", "jianying_canary", "--", "--nocapture"],
  },
  {
    id: "cargo-clippy",
    command: "cargo",
    args: ["clippy", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets", "--", "-D", "warnings"],
  },
  { id: "cargo-audit", command: "cargo", args: ["audit", "--file", "src-tauri/Cargo.lock"] },
  { id: "npm-audit", command: "npm", args: ["audit", "--audit-level=high"] },
];

const results = commands.map((entry) => {
  const startedAt = new Date();
  const result = spawnSync(entry.command, entry.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: qaEnvironment,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  const strictFailures = strictFailurePatterns
    .filter((pattern) => pattern.test(combined))
    .map((pattern) => pattern.source);
  const exitCode = result.status ?? 127;
  const pass = exitCode === 0 && strictFailures.length === 0;
  writeFileSync(join(outputDirectory, "logs", `${entry.id}.log`), combined);
  return {
    ...entry,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    exitCode,
    signal: result.signal,
    strictFailures,
    pass,
  };
});

const failed = results.filter((result) => !result.pass);
const gate = {
  schemaVersion: 1,
  gate: "fast-gates",
  capturedAt: new Date().toISOString(),
  status: failed.length === 0 ? "PASS" : "FAIL",
  results,
};
writeFileSync(join(outputDirectory, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);

for (const result of results) {
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id} exit=${result.exitCode} strict=${result.strictFailures.length}`);
}
console.log(`${gate.status} ${outputDirectory}`);
process.exitCode = failed.length === 0 ? 0 : 1;
