#!/usr/bin/env node
// R19 E-04:稳态内存三场景——空库、大库不做任务、播放 4K。用 `/usr/bin/time -l`
// 起真实 release .app,在隔离 profile 里跑够 idle-seconds 秒(给后台任务收尾/
// 内存回落的时间),再杀掉拿 maximum resident set size。
//
// 本轮只做了「空库」与「大库(用 bench/run-import-bench.mjs 跑出的库,已导入完
// 不再有任务)不做任务」两个场景的真机测量;「播放 4K」需要 AX 驱动点开一段素材
// 并保持播放 N 秒,这一步没做(留给下一轮或 U-12 的驱动脚本一起接线),跑
// --scenario playing-4k 会打印 PROBE 并以 3 退出。
//
// 用法: node bench/check-idle-memory.mjs --app <path> --scenario empty|large-idle|playing-4k
//                                        [--seed-db <library.db>] [--idle-seconds 20]
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const appPath = argument("--app");
const scenario = argument("--scenario");
if (!appPath || !existsSync(appPath) || !["empty", "large-idle", "playing-4k"].includes(scenario ?? "")) {
  console.error("用法: node bench/check-idle-memory.mjs --app <path> --scenario empty|large-idle|playing-4k [--seed-db <path>] [--idle-seconds 20]");
  process.exit(2);
}
if (scenario === "playing-4k") {
  console.error("PROBE: playing-4k 场景需要 AX 驱动点开素材并保持播放,本轮未接线(见文件头注释)");
  process.exit(3);
}
const seedDb = argument("--seed-db");
if (scenario === "large-idle" && !seedDb) {
  console.error("large-idle 场景需要 --seed-db <library.db>");
  process.exit(2);
}
const idleSeconds = Number(argument("--idle-seconds") ?? 20);
if (process.argv.includes("--resign")) {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "ignore" });
}

const profile = mkdtempSync(join(tmpdir(), `tripcut-idle-mem-${scenario}-`));
if (seedDb) {
  mkdirSync(join(profile, "default"), { recursive: true });
  cpSync(seedDb, join(profile, "default", "project.db"));
}
const bin = join(appPath, "Contents/MacOS", "tripcut-studio");
// `/usr/bin/time -l` 打印子进程退出后的资源使用摘要(含 "maximum resident set
// size"),所以让它自己内部 sleep 够时长再 kill——time 量的是它包起来的那个
// 子进程树。用 zsh -c '进程 & sleep N; kill %1' 让 time 测的是整段 shell。
const script = `"${bin}" & child=$!; sleep ${idleSeconds}; kill -9 $child 2>/dev/null; wait $child 2>/dev/null; exit 0`;
const result = spawnSync("/usr/bin/time", ["-l", "zsh", "-c", script], {
  encoding: "utf8",
  env: { ...process.env, TRIPCUT_APP_SUPPORT_DIR: profile },
});
try { execFileSync("pkill", ["-9", "-f", profile]); } catch {}
rmSync(profile, { recursive: true, force: true });
const stderr = result.stderr ?? "";
const match = stderr.match(/(\d+)\s+maximum resident set size/);
if (!match) {
  console.error("PROBE: /usr/bin/time 输出里没找到 maximum resident set size");
  console.error(stderr);
  process.exit(3);
}
const rssBytes = Number(match[1]);
console.log(`scenario=${scenario} maximum_resident_set_size_bytes=${rssBytes} (${(rssBytes / 1024 / 1024).toFixed(1)} MB)`);
