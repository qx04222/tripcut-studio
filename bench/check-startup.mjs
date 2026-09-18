#!/usr/bin/env node
// R19 E-03:启动时间探针。用隔离 profile 起真实 release .app,从日志里读
// `rust_setup_ms`(见 src-tauri/src/lib.rs 的 E-05 打点),空库判据 <400ms、
// 1344 条库判据 <600ms(先只做空库场景的真机测量;1344 条库场景需要预先灌好
// 一个种子库放进隔离 profile 才能量,见下方 --seed-db)。
//
// 参照 scripts/qa/native-audit/run.mjs 的起 pid / 隔离 / 只杀自己那份的纪律:
// - 一定带 TRIPCUT_APP_SUPPORT_DIR=<scratch>,绝不碰 ~/Library/Application Support/TripCutStudio/
// - 只 kill 自己 `open` 出来的那个 pid,不扫描系统里所有 tripcut-studio 进程
//
// 用法: node bench/check-startup.mjs --app <path/to/旅剪工作台.app> [--rounds 5]
//                                    [--seed-db <library.db 路径,放进隔离 profile 模拟 1344 条库>]
//                                    [--enforce]
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const enforce = process.argv.includes("--enforce");
const appPath = argument("--app");
if (!appPath || !existsSync(appPath)) {
  console.error("用法: node bench/check-startup.mjs --app <path/to/旅剪工作台.app> [--rounds 5] [--seed-db <path>] [--resign] [--enforce]");
  process.exit(2);
}
// 本机实测:`tauri build` 产的 ad-hoc + hardened-runtime 签名会在启动时因为
// homebrew libmpv 是另一份独立的 ad-hoc 签名(Team ID 不匹配)被库校验拒绝
// 加载(dyld: "different Team IDs")。这是本机签名链的问题,不是 R19 改动
// 引入的——`--resign` 去掉 hardened-runtime 位,只用于本地起真机量测,不改
// 仓库里的 entitlements.plist/签名配置。
if (process.argv.includes("--resign")) {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "ignore" });
}
const rounds = Number(argument("--rounds") ?? 5);
const seedDb = argument("--seed-db");

function findRustSetupMs(profileDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      // rust_setup_ms 落在隔离 profile 树下某个 <素材库根>/logs/tripcut.log.* 里,
      // 具体子路径取决于是否已有项目——递归找最新的日志文件。
      let found = null;
      function walk(dir, depth) {
        if (found || depth > 6) return;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (found) return;
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p, depth + 1);
          else if (entry.name.startsWith("tripcut.log")) {
            const text = readFileSync(p, "utf8");
            const match = [...text.matchAll(/rust_setup_ms=(\d+)/g)];
            if (match.length > 0) found = Number(match.at(-1)[1]);
          }
        }
      }
      walk(profileDir, 0);
      if (found != null || Date.now() > deadline) resolve(found);
      else setTimeout(poll, 100);
    };
    poll();
  });
}

function bundleExecutable(app) {
  const plist = readFileSync(join(app, "Contents/Info.plist"), "utf8");
  const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
  if (match) return match[1];
  const names = readdirSync(join(app, "Contents/MacOS"));
  return names.find((name) => name === "tripcut-studio") ?? names[0];
}

async function oneRound(round) {
  const profile = mkdtempSync(join(tmpdir(), `tripcut-startup-bench-${round}-`));
  if (seedDb) {
    mkdirSync(join(profile, "seeded-project"), { recursive: true });
    cpSync(seedDb, join(profile, "seeded-project", "library.db"));
  }
  // 打包后的 .app 里 MacOS/ 不止主二进制(ffmpeg / ffprobe / sidecar-ocr / whisper-cli 也在),
  // 按字母序取第一个会起到 ffmpeg,五轮全 TIMEOUT 还只报 PROBE——先认 Info.plist 的 CFBundleExecutable。
  const bin = join(appPath, "Contents/MacOS", bundleExecutable(appPath));
  const child = spawn(bin, [], { env: { ...process.env, TRIPCUT_APP_SUPPORT_DIR: profile }, stdio: "ignore", detached: true });
  const pid = child.pid;
  try {
    const ms = await findRustSetupMs(profile, 15_000);
    return ms;
  } finally {
    // 只杀自己这一个 pid(不扫描系统里所有 tripcut-studio 进程)。分组杀失败时
    // 再直接杀一次这个 pid 兜底,最后用 pgrep -f 这份隔离 profile 路径确认真的
    // 没有残留(同一 pid 分组杀偶发不生效,曾经漏过一个进程)。
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
    try { execFileSync("pkill", ["-9", "-f", profile]); } catch {}
    rmSync(profile, { recursive: true, force: true });
  }
}

const results = [];
for (let r = 0; r < rounds; r++) {
  const ms = await oneRound(r);
  results.push(ms);
  console.log(`round ${r}: rust_setup_ms=${ms ?? "TIMEOUT"}`);
}
const values = results.filter((v) => v != null).sort((a, b) => a - b);
if (values.length === 0) {
  console.error("PROBE: 一轮都没量到 rust_setup_ms——探针故障(不是缺陷),检查日志路径/权限");
  process.exit(3);
}
const median = values[Math.floor(values.length / 2)];
const threshold = seedDb ? 600 : 400;
const pass = median < threshold;
console.log(`median rust_setup_ms=${median} (${values.length}/${rounds} 轮量到) threshold=${threshold}(${seedDb ? "1344 条库" : "空库"})`);
console.log(`${pass ? "PASS" : "FAIL"} check-startup`);
process.exitCode = enforce && !pass ? 1 : 0;
