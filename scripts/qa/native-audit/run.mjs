#!/usr/bin/env node
/**
 * R18 车道 native2 / M-12:原生行为真机审计套件。
 *
 *   node scripts/qa/native-audit/run.mjs --app <path/to/旅剪工作台.app> [--profile <dir>]
 *                                        [--launch] [--pid <pid>] [--json-out <file>]
 *                                        [--control <path/to/旧包.app>]
 *
 * 退出码:0 全通过;1 有缺陷;3 探针故障(没权限 / 抓不到 / 路径不对)。
 *
 * 三条纪律(业主记忆里那几条的直接落地):
 *  1. **取数与判定分开**。抓 AX 树的是 swift 探针,判定是 `*.mjs` 里的纯函数,
 *     纯函数在 vitest 里对**旧包的实抓形态**报过红(正控),才敢信它的绿。
 *  2. **抓不到 ≠ 有缺陷**。没有辅助功能权限、pid 不对、窗口还没建起来,一律 PROBE。
 *  3. **只杀自己启动的 pid**。`--launch` 记下自己那一个;不给 `--launch` 时
 *     一个进程都不碰(`--pid` 只读不杀)。业主自己开着的那份永远不动。
 *
 * 隔离:`--launch` 一定带 `TRIPCUT_APP_SUPPORT_DIR=<profile>`(默认建在系统临时目录),
 * 绝不碰 `~/Library/Application Support/TripCutStudio/`。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { auditInfoPlist } from "./infoPlist.mjs";
import { auditFileAssociations, auditWindowOnScreen } from "./fileAssociations.mjs";
import { auditMenuBar } from "./menuAudit.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name) => process.argv.includes(name);

const appPath = argument("--app");
if (!appPath) {
  console.error(
    "用法:node scripts/qa/native-audit/run.mjs --app <.app> [--profile <dir>] [--launch] [--pid <pid>] [--control <旧包.app>] [--json-out <file>]",
  );
  process.exit(3);
}

/** 读打包后的 Info.plist。读不出来是探针故障,不是缺陷。 */
function readInfoPlist(bundle) {
  const plist = join(bundle, "Contents/Info.plist");
  if (!existsSync(plist)) return { error: `${plist} 不存在` };
  try {
    return { values: JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })) };
  } catch (error) {
    return { error: `plutil 读不出 ${plist}:${error.message}` };
  }
}

const checks = [];
const record = (id, status, findings) => checks.push({ id, status, findings });

// ── 静态:不用启动应用就能判的两条 ────────────────────────────────
const bundle = resolve(appPath);
const info = readInfoPlist(bundle);
if (info.error) {
  record("app.localization-and-file-access", "PROBE", [info.error]);
  record("app.file-associations", "PROBE", [info.error]);
} else {
  const localization = auditInfoPlist(info.values);
  record("app.localization-and-file-access", localization.length === 0 ? "PASS" : "FAIL", localization);
  const associations = auditFileAssociations(info.values.CFBundleDocumentTypes);
  record("app.file-associations", associations.length === 0 ? "PASS" : "FAIL", associations);
}

// ── 正控:同样两条判定喂给旧包,必须报红 ──────────────────────────
const controlPath = argument("--control");
if (controlPath) {
  const control = readInfoPlist(resolve(controlPath));
  if (control.error) {
    record("control.old-bundle-must-fail", "PROBE", [control.error]);
  } else {
    const red =
      auditInfoPlist(control.values).length > 0 || auditFileAssociations(control.values.CFBundleDocumentTypes).length > 0;
    record(
      "control.old-bundle-must-fail",
      red ? "PASS" : "FAIL",
      red ? [] : [`${controlPath} 一条都没报红——判定自己坏了,别信上面那几条绿`],
    );
  }
}

// ── 真机:需要一个活着的 pid ─────────────────────────────────────
let pid = Number.parseInt(argument("--pid") ?? "", 10);
let child;
let profile = argument("--profile");

if (flag("--launch")) {
  profile = profile ? resolve(profile) : mkdtempSync(join(tmpdir(), "tripcut-native-audit-"));
  mkdirSync(profile, { recursive: true });
  const binary = join(bundle, "Contents/MacOS/旅剪工作台");
  if (!existsSync(binary)) {
    record("app.launch", "PROBE", [`${binary} 不存在——这个包里没有可执行文件`]);
  } else {
    // 隔离 profile:绝不碰业主那份 Application Support。
    child = spawn(binary, [], {
      env: { ...process.env, TRIPCUT_APP_SUPPORT_DIR: profile },
      stdio: "ignore",
      detached: false,
    });
    pid = child.pid;
    record("app.launch", "PASS", []);
  }
}

/** 编译并跑一个 swift 探针,回它的 JSON。 */
function probe(source, pidArgument) {
  const workDirectory = mkdtempSync(join(tmpdir(), "tripcut-probe-"));
  const binary = join(workDirectory, "probe");
  const compile = spawnSync("swiftc", ["-O", "-o", binary, resolve(import.meta.dirname, source)], { encoding: "utf8" });
  if (compile.status !== 0) return { ok: false, error: `${source} 编译失败:${compile.stderr ?? ""}` };
  const run = spawnSync(binary, [String(pidArgument)], { encoding: "utf8" });
  try {
    return JSON.parse(run.stdout || "{}");
  } catch {
    return { ok: false, error: `${source} 的输出不是 JSON:${run.stdout || run.stderr}` };
  }
}

async function liveChecks() {
  if (!Number.isFinite(pid)) {
    record("app.menu-bar", "PROBE", ["没有 pid:给 --pid,或者加 --launch 让套件自己起一个隔离实例"]);
    record("app.window-on-screen", "PROBE", ["没有 pid"]);
    return;
  }
  // 窗口要几秒才建得起来;每 500 ms 探一次,最多 30 秒。**有界等待**——
  // 无界等待会把"起不来"伪装成"跑得很慢"(业主记忆:无界等待与阴阳环境)。
  const deadline = Date.now() + 30_000;
  let window = probe("axwindow.swift", pid);
  while (window.ok !== true && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 500));
    window = probe("axwindow.swift", pid);
  }
  const windowVerdict = auditWindowOnScreen(window);
  record("app.window-on-screen", windowVerdict.status, windowVerdict.findings);

  const menu = probe("axmenu.swift", pid);
  const menuVerdict = auditMenuBar(menu);
  record("app.menu-bar", menuVerdict.status, menuVerdict.findings);
}

await liveChecks();

// 只杀自己启动的那一个。没启动过就一个都不碰。
if (child && child.pid) {
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    /* 已经自己退了 */
  }
}

const failed = checks.filter((check) => check.status === "FAIL");
const probed = checks.filter((check) => check.status === "PROBE");
const report = { app: bundle, profile: profile ?? null, checks };
const jsonOut = argument("--json-out");
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

for (const check of checks) {
  const head = `${check.status} ${check.id}`;
  if (check.findings.length === 0) console.log(head);
  else console.log(`${head}\n  - ${check.findings.join("\n  - ")}`);
}
console.log(
  `原生审计:${checks.length - failed.length - probed.length} 通过 / ${failed.length} 缺陷 / ${probed.length} 探针故障`,
);
process.exit(failed.length > 0 ? 1 : probed.length > 0 ? 3 : 0);
