#!/usr/bin/env node
// R6 Task 1 端到端:应用内自动更新的正例与负例,全程只打本机 http 端点,不碰任何公开仓库。
//
// 正例:0.1.1 候选 → 检查更新 → 下载并安装 → 重启 → 跑起来的包是 0.1.2,隔离库内容没变,
//       没有新崩溃报告。
// 负例:同一个 0.1.2 包,但 latest.json 里的签名被翻掉一位 → 必须被拒绝安装,且原包还活着。
//
// 为什么负例不能省:正例绿只证明"签名对得上时装得上"。装置里最常见的假绿是校验根本没跑
// (pubkey 配错、签名字段被忽略、错误被吞掉),那种情况下正例照样全绿。只有先让它红过——
// 一位翻转就必须拒装——「装得上」这件事才有意义。
//
// 用法:node scripts/qa/updater-e2e.mjs [--out 目录] [--port 8765] [--seed-db 路径] [--keep]
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  activatePid,
  alivePids,
  clickByLabel,
  clickNav,
  dismissNativeDialog,
  dismissOnboarding,
  sleep,
  waitForText,
  windowText,
} from "./ax-helpers.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const flag = (name) => process.argv.includes(name);

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outDir = resolve(argument("--out") ?? join(repoRoot, "qa/runs", `${timestamp}-updater-e2e`));
const goodPort = Number(argument("--port") ?? 8765);
const badPort = goodPort + 1;
const seedDb = argument("--seed-db") ? resolve(argument("--seed-db")) : null;
mkdirSync(outDir, { recursive: true });

const checks = [];
const log = [];
const say = (line) => {
  log.push(line);
  console.log(line);
};
const check = (id, pass, detail) => {
  checks.push({ id, pass, detail: String(detail).slice(0, 2000) });
  say(`${pass ? "PASS" : "FAIL"} ${id}: ${String(detail).slice(0, 400)}`);
  return pass;
};

const servers = [];
const cleanups = [];

// 显示器休眠会把会话锁上,锁上之后 System Events 拿不到任何 UI,所有 AX 断言一起变红,
// 而红的理由在 gate 里长得像"按钮不存在"。本机 displaysleep=5 分钟,而两次打包要跑
// 二十多分钟——第一次跑到负例时就是这么锁的。整轮用 caffeinate 摁住,并在每个 AX
// 阶段前重新确认一次:锁了就报"锁了",不让它伪装成产品缺陷。
const caffeine = spawn("caffeinate", ["-disu", "-w", String(process.pid)], { stdio: "ignore" });
caffeine.unref();
let finished = false;
function finish(extra = {}) {
  if (finished) return;
  finished = true;
  for (const server of servers) {
    try {
      process.kill(server.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  for (const undo of cleanups.reverse()) {
    try {
      undo();
    } catch (error) {
      say(`WARN cleanup failed: ${error}`);
    }
  }
  const failed = checks.filter((entry) => !entry.pass);
  const gate = {
    schemaVersion: 1,
    gate: "updater-e2e",
    capturedAt: new Date().toISOString(),
    status: failed.length === 0 ? "PASS" : "FAIL",
    checks,
    failed,
    ...extra,
  };
  writeFileSync(join(outDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
  writeFileSync(join(outDir, "run.log"), `${log.join("\n")}\n`);
  console.log(`${gate.status} ${outDir}`);
  process.exit(gate.status === "PASS" ? 0 : 1);
}
process.on("uncaughtException", (error) => {
  check("run.no-uncaught-exception", false, `${error?.stack ?? error}`);
  finish();
});
// L5(review 修复):Ctrl-C 或外部 kill 之前直接绕过 finish(),留下候选 App、本地
// http 服务器和 caffeinate 常驻——下一次跑会撞进程冲突或占着显示器唤醒锁。这里让
// SIGINT/SIGTERM 也走同一条清理路径:killAllCandidates 之类的 undo 在 cleanups
// 里注册的都会执行,gate.json 明确记成中止而不是悄悄不写。
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    check("run.not-interrupted", false, `进程收到 ${signal},提前中止,已尽量清理`);
    finish({ interrupted: signal });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? 127,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function killAllCandidates() {
  run("pkill", ["-x", "tripcut-studio"]);
  for (let attempt = 0; attempt < 100 && run("pgrep", ["-x", "tripcut-studio"]).status === 0; attempt += 1) {
    sleep(100);
  }
}

// ---------------------------------------------------------------- 版本号改写
// 三处版本号必须一起改:package.json 只影响前端与许可清单,tauri.conf.json 决定包里
// Info.plist 的 CFBundleShortVersionString,Cargo.toml 决定编进二进制的 PACKAGE_INFO
// ——插件比较的当前版本读的正是最后这个。少改一处,更新检查会拿一个和包不符的版本去比。
const VERSION_FILES = [
  ["package.json", (from, to) => [`s/^  "version": "${from}",$/  "version": "${to}",/`]],
  ["src-tauri/tauri.conf.json", (from, to) => [`s/^  "version": "${from}",$/  "version": "${to}",/`]],
  ["src-tauri/Cargo.toml", (from, to) => [`s/^version = "${from}"$/version = "${to}"/`]],
];
// Cargo.lock 会被 cargo 顺手改掉版本号,一并做字节级快照还原。
const SNAPSHOT_FILES = [...VERSION_FILES.map(([file]) => file), "src-tauri/Cargo.lock"];

function snapshotVersionFiles() {
  const saved = SNAPSHOT_FILES.filter((file) => existsSync(join(repoRoot, file))).map((file) => ({
    file,
    bytes: readFileSync(join(repoRoot, file)),
  }));
  // 按字节还原,不用 `git checkout`:并行会话可能正在同一个仓库里干活,
  // git checkout 会把别人的改动一起丢掉。
  return () => {
    for (const entry of saved) writeFileSync(join(repoRoot, entry.file), entry.bytes);
  };
}

function bumpVersion(from, to) {
  for (const [file, expressions] of VERSION_FILES) {
    const path = join(repoRoot, file);
    const before = readFileSync(path, "utf8");
    const result = run("sed", ["-i", "", ...expressions(from, to).flatMap((e) => ["-e", e]), path]);
    if (result.status !== 0) throw new Error(`sed 失败 ${file}: ${result.stderr}`);
    const after = readFileSync(path, "utf8");
    // sed 匹配不到时静默返回 0。不自证的话会打出一个版本号没变的包,
    // 然后正例"发现新版本"永远为假,还查不出为什么。
    if (before === after) throw new Error(`版本号改写没生效:${file} 里找不到 ${from}`);
    if (!after.includes(to)) throw new Error(`版本号改写后仍不含 ${to}:${file}`);
  }
}

// ---------------------------------------------------------------- 打包
function packageBuild(version, { port, notes }) {
  const stamp = `r6upd-${version.replaceAll(".", "-")}-${Date.now()}`;
  const environment = { ...process.env };
  // package-dmg.sh 把产物固定找在 $ROOT/src-tauri/target/release/bundle 下;
  // CARGO_TARGET_DIR 指到别处会让它找不到 .app。这里显式摘掉。
  delete environment.CARGO_TARGET_DIR;
  Object.assign(environment, {
    TRIPCUT_PACKAGE_MODE: "qa",
    TRIPCUT_ALLOW_ADHOC: "1",
    TRIPCUT_UPDATER_SIGN: "1",
    TRIPCUT_UPDATER_LOCAL: "1",
    TRIPCUT_UPDATER_PORT: String(port),
    TRIPCUT_UPDATER_NOTES: notes,
    TRIPCUT_BUILD_STAMP: stamp,
  });
  const started = Date.now();
  const result = run("zsh", [join(repoRoot, "scripts/package-dmg.sh")], { cwd: repoRoot, env: environment });
  writeFileSync(join(outDir, `package-${version}.log`), `${result.stdout}\n--- stderr ---\n${result.stderr}\n`);
  if (result.status !== 0) {
    throw new Error(`package-dmg.sh(${version}) 失败 rc=${result.status};日志见 package-${version}.log`);
  }
  const tar = result.stdout.match(/^UPDATER_TAR=(.+)$/m)?.[1];
  const latest = result.stdout.match(/^UPDATER_LATEST_JSON=(.+)$/m)?.[1];
  if (!tar || !latest) throw new Error(`package-dmg.sh(${version}) 没有输出更新产物路径`);
  const builtApp = join(repoRoot, "src-tauri/target/release/bundle/macos/旅剪工作台.app");
  if (!existsSync(builtApp)) throw new Error(`找不到构建产物:${builtApp}`);
  const keptApp = join(workRoot, `${version}/旅剪工作台.app`);
  mkdirSync(dirname(keptApp), { recursive: true });
  // 下一次构建会原地覆盖 bundle/macos,所以每个版本都要立刻挪走一份。
  run("ditto", [builtApp, keptApp]);
  const plistVersion = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(keptApp, "Contents/Info.plist"),
  ]).stdout.trim();
  say(`    built ${version} in ${Math.round((Date.now() - started) / 1000)}s (plist=${plistVersion})`);
  return { app: keptApp, tar, latest, plistVersion };
}

// ---------------------------------------------------------------- 隔离库快照
// 不比字节:应用一启动就会写会话/诊断相关的行,重启前后原样相同是不可能的。
// 要证明的是"更新没有动用户的东西",所以比的是内容表的行数与 schema 版本 + 完整性。
const CONTENT_TABLES = ["clips", "segments", "ratings", "tags", "settings", "exports", "volumes", "episodes"];
function databaseSnapshot(dbPath) {
  if (!existsSync(dbPath)) return { exists: false };
  const sql = (statement) => run("sqlite3", [dbPath, statement]).stdout.trim();
  const tables = sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .split("\n")
    .filter(Boolean);
  const counts = {};
  for (const table of CONTENT_TABLES) {
    if (tables.includes(table)) counts[table] = sql(`SELECT COUNT(*) FROM "${table}"`);
  }
  return {
    exists: true,
    integrity: sql("PRAGMA integrity_check"),
    schemaVersion: tables.includes("schema_version") ? sql("SELECT version FROM schema_version") : null,
    tables,
    counts,
  };
}

// ---------------------------------------------------------------- 本地端点
function serve(directory, port) {
  const child = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", directory], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  servers.push(child);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = run("curl", ["-fsS", "-o", "/dev/null", `http://127.0.0.1:${port}/latest.json`]);
    if (probe.status === 0) return child;
    sleep(100);
  }
  throw new Error(`http 服务没起来:127.0.0.1:${port} (${directory})`);
}

// 精确地翻掉签名里的一位。直接改 base64 字符往往先炸在 base64/编码层,那样"被拒绝"
// 证明的是解码失败,不是验签失败——两者是不同的守卫,不能互相顶替。
function tamperSignature(signatureBase64) {
  const minisignText = Buffer.from(signatureBase64, "base64").toString("utf8");
  const lines = minisignText.split("\n");
  if (lines.length < 2) throw new Error("签名文件形状意外,不是 minisign 的两行以上文本");
  const raw = Buffer.from(lines[1], "base64");
  if (raw.length < 74) throw new Error(`签名负载长度意外:${raw.length}`);
  raw[raw.length - 1] ^= 0x01; // ed25519 签名的最后一个字节,翻一位
  lines[1] = raw.toString("base64");
  const tampered = Buffer.from(lines.join("\n"), "utf8").toString("base64");
  if (tampered === signatureBase64) throw new Error("篡改没生效:签名与原文一致");
  return tampered;
}

// ---------------------------------------------------------------- 候选驱动
function launchCandidate(label, appPath, endpoint) {
  killAllCandidates();
  const candidateDir = join(outDir, `${label}-candidate`);
  const args = ["scripts/qa/prepare-cua-candidate.mjs", "--app", appPath, "--out", candidateDir];
  if (seedDb) args.push("--seed-db", seedDb);
  const result = run("node", args, {
    cwd: repoRoot,
    env: { ...process.env, TRIPCUT_UPDATER_ENDPOINT: endpoint },
  });
  writeFileSync(join(outDir, `${label}-candidate.log`), `${result.stdout}\n--- stderr ---\n${result.stderr}\n`);
  if (result.status !== 0) {
    // prepare-cua-candidate 是用 `open -n` 起的,进程的 stderr 进了系统日志,gate 里
    // 只剩一句「runtime.stable-3s 失败」。第一次撞上这条时,真正的原因(插件初始化
    // panic:更新端点不是 https)完全看不见。这里直接把二进制跑一遍收 stderr,
    // 让"起不来"变成"为什么起不来"。
    const diagnostic = run(join(appPath, "Contents/MacOS/tripcut-studio"), [], {
      env: {
        ...process.env,
        TRIPCUT_UPDATER_ENDPOINT: endpoint,
        TRIPCUT_APP_SUPPORT_DIR: mkdtempSync(join(tmpdir(), "tripcut-updater-diag-")),
        TRIPCUT_DISABLE_LLM_PROVIDERS: "1",
      },
      timeout: 15000,
    });
    writeFileSync(
      join(outDir, `${label}-candidate-stderr.log`),
      `${diagnostic.stdout}\n--- stderr ---\n${diagnostic.stderr}\n`,
    );
    throw new Error(
      `prepare-cua-candidate(${label}) 失败:${result.stdout || result.stderr}\n直跑二进制的 stderr:${diagnostic.stderr.slice(-1500)}`,
    );
  }
  const manifest = JSON.parse(readFileSync(join(candidateDir, "manifest.json"), "utf8"));
  if (manifest.candidate.updaterEndpoint !== endpoint) {
    throw new Error(`候选没有带上端点覆盖:${manifest.candidate.updaterEndpoint}`);
  }
  return { candidateDir, manifest };
}

function assertUnlocked(stage) {
  const locked = /CGSSessionScreenIsLocked"=Yes/.test(run("ioreg", ["-n", "Root", "-d1"]).stdout);
  return check(`${stage}.desktop-unlocked`, !locked, locked ? "会话已锁定,AX 证据无效" : "会话未锁定");
}

function openSettings(pid) {
  activatePid(pid);
  sleep(1500);
  dismissOnboarding();
  clickNav("04 设置 SETTINGS");
  sleep(1200);
}

// ---------------------------------------------------------------- 主流程
const workRoot = mkdtempSync(join(tmpdir(), "tripcut-updater-e2e-"));
if (!flag("--keep")) cleanups.push(() => rmSync(workRoot, { recursive: true, force: true }));

const baseVersion = JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8")).version;
const [major, minor, patch] = baseVersion.split(".").map(Number);
const nextVersion = `${major}.${minor}.${patch + 1}`;
say(`==> updater e2e ${baseVersion} -> ${nextVersion}, out=${outDir}`);

try {
  // 0. 前置:环境干净、钥匙在、端口空
  check("pre.no-running-app", run("pgrep", ["-x", "tripcut-studio"]).status !== 0, "没有正在运行的 tripcut-studio");
  const keyPath = process.env.TRIPCUT_UPDATER_KEY ?? join(process.env.HOME, ".tauri/tripcut-updater.key");
  check("pre.signing-key", existsSync(keyPath), keyPath);
  check(
    "pre.keychain-password",
    run("security", ["find-generic-password", "-a", "tripcut", "-s", "tripcut-updater"]).status === 0,
    "钥匙串条目 tripcut-updater 存在(不打印口令)",
  );
  for (const port of [goodPort, badPort]) {
    check(`pre.port-free-${port}`, run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status !== 0, `127.0.0.1:${port}`);
  }
  if (checks.some((entry) => !entry.pass)) finish({ stoppedAt: "preflight" });

  // 1. 打两个包。版本号只在临时窗口里改,finally 一定还原。
  const restoreVersions = snapshotVersionFiles();
  cleanups.push(restoreVersions);
  say(`==> packaging ${baseVersion} (base candidate)`);
  const basePackage = packageBuild(baseVersion, { port: goodPort, notes: `旅剪工作台 ${baseVersion}` });
  check("package.base.version", basePackage.plistVersion === baseVersion, `Info.plist=${basePackage.plistVersion}`);

  say(`==> packaging ${nextVersion} (update payload)`);
  let nextPackage;
  try {
    bumpVersion(baseVersion, nextVersion);
    nextPackage = packageBuild(nextVersion, { port: goodPort, notes: `QA 更新链路验证 ${nextVersion}` });
  } finally {
    restoreVersions();
  }
  check("package.next.version", nextPackage.plistVersion === nextVersion, `Info.plist=${nextPackage.plistVersion}`);
  check(
    "package.versions-restored",
    JSON.parse(readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8")).version === baseVersion,
    `tauri.conf.json 回到 ${baseVersion}`,
  );
  check("package.signature-file", existsSync(`${nextPackage.tar}.sig`), `${basename(nextPackage.tar)}.sig`);

  // 2. 两个本地端点:好的一份原样,坏的一份翻掉签名的一位。
  const goodDir = join(workRoot, "serve-good");
  const badDir = join(workRoot, "serve-bad");
  mkdirSync(goodDir, { recursive: true });
  mkdirSync(badDir, { recursive: true });
  const tarName = basename(nextPackage.tar);
  cpSync(nextPackage.tar, join(goodDir, tarName));
  cpSync(nextPackage.tar, join(badDir, tarName));
  const goodManifest = JSON.parse(readFileSync(nextPackage.latest, "utf8"));
  writeFileSync(join(goodDir, "latest.json"), `${JSON.stringify(goodManifest, null, 2)}\n`);
  const badManifest = JSON.parse(JSON.stringify(goodManifest));
  badManifest.platforms["darwin-aarch64"].signature = tamperSignature(
    goodManifest.platforms["darwin-aarch64"].signature,
  );
  badManifest.platforms["darwin-aarch64"].url = `http://127.0.0.1:${badPort}/${tarName}`;
  writeFileSync(join(badDir, "latest.json"), `${JSON.stringify(badManifest, null, 2)}\n`);
  check(
    "endpoint.tampered-signature-differs",
    badManifest.platforms["darwin-aarch64"].signature !== goodManifest.platforms["darwin-aarch64"].signature,
    "负例清单里的签名与正例不同",
  );
  serve(goodDir, goodPort);
  serve(badDir, badPort);
  check("endpoint.good-served", true, `http://127.0.0.1:${goodPort}/latest.json`);
  check("endpoint.bad-served", true, `http://127.0.0.1:${badPort}/latest.json`);

  // 3. 正例
  say("==> positive: 0.1.1 candidate updates to 0.1.2");
  const positive = launchCandidate("positive", basePackage.app, `http://127.0.0.1:${goodPort}/latest.json`);
  const oldPid = positive.manifest.candidate.pid;
  const candidateApp = positive.manifest.candidate.appPath;
  const supportDir = positive.manifest.candidate.supportDirectory;
  const dbPath = join(supportDir, "default/project.db");
  assertUnlocked("positive");
  openSettings(oldPid);
  const beforeSnapshot = databaseSnapshot(dbPath);

  check("positive.check-button", clickByLabel("检查更新", { exact: true }), "点中「检查更新」");
  const foundNeedle = `发现新版本 ${nextVersion}`;
  const found = waitForText([foundNeedle, "校验失败", "更新失败", "已是最新版本"], { timeoutMs: 90000 });
  check("positive.update-found", found.needle === foundNeedle, `界面文本命中=${found.needle}`);
  writeFileSync(join(outDir, "positive-after-check.txt"), found.text);

  check("positive.install-button", clickByLabel("下载并安装", { exact: true }), "点中「下载并安装」");
  const installed = waitForText(["重启后生效", "校验失败", "更新失败"], { timeoutMs: 180000 });
  check("positive.installed", installed.needle === "重启后生效", `界面文本命中=${installed.needle}`);
  writeFileSync(join(outDir, "positive-after-install.txt"), installed.text);

  check("positive.restart-button", clickByLabel("立即重启", { exact: true }), "点中「立即重启」");
  let newPid = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    sleep(200);
    const pids = alivePids(`${candidateApp}/Contents/MacOS/tripcut-studio`).filter((pid) => pid !== oldPid);
    if (pids.length === 1) {
      newPid = pids[0];
      break;
    }
  }
  check("positive.relaunched", newPid !== null, `旧 pid=${oldPid} 新 pid=${newPid}`);
  sleep(6000);

  const runningVersion = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(candidateApp, "Contents/Info.plist"),
  ]).stdout.trim();
  check("positive.bundle-version", runningVersion === nextVersion, `跑起来的包 Info.plist=${runningVersion}`);
  check("positive.old-pid-exited", oldPid !== null && run("kill", ["-0", String(oldPid)]).status !== 0, `旧 pid=${oldPid}`);

  if (newPid) {
    // 单写锁没来得及释放时会弹原生 NSAlert(「检测到另一个实例」),它阻塞主线程,
    // 后面的 AX 断言会读成"页面冻死"。先如实记一笔,再点掉,别让它伪装成别的缺陷。
    activatePid(newPid);
    sleep(2000);
    const afterText = windowText();
    const sawReadOnlyDialog = afterText.includes("检测到另一个实例");
    checks.push({
      id: "positive.no-read-only-dialog",
      pass: true,
      warn: sawReadOnlyDialog,
      detail: sawReadOnlyDialog ? "重启后弹出单写锁提示,已点掉(旧进程退出与新进程启动的竞态)" : "无",
    });
    say(`${sawReadOnlyDialog ? "WARN" : "PASS"} positive.no-read-only-dialog ${sawReadOnlyDialog}`);
    if (sawReadOnlyDialog) {
      dismissNativeDialog();
      sleep(1500);
    }
    openSettings(newPid);
    const currentNeedle = `当前版本 ${nextVersion}`;
    const shown = waitForText([currentNeedle], { timeoutMs: 30000 });
    check("positive.about-shows-new-version", shown.needle === currentNeedle, `设置页文本命中=${shown.needle}`);
    writeFileSync(join(outDir, "positive-after-relaunch.txt"), shown.text);
  }

  const afterSnapshot = databaseSnapshot(dbPath);
  check(
    "positive.db-untouched",
    beforeSnapshot.exists &&
      afterSnapshot.exists &&
      afterSnapshot.integrity === "ok" &&
      JSON.stringify(beforeSnapshot.tables) === JSON.stringify(afterSnapshot.tables) &&
      JSON.stringify(beforeSnapshot.counts) === JSON.stringify(afterSnapshot.counts) &&
      beforeSnapshot.schemaVersion === afterSnapshot.schemaVersion,
    `before=${JSON.stringify(beforeSnapshot.counts)} after=${JSON.stringify(afterSnapshot.counts)} integrity=${afterSnapshot.integrity} schema=${afterSnapshot.schemaVersion}`,
  );
  writeFileSync(
    join(outDir, "positive-db-snapshots.json"),
    `${JSON.stringify({ before: beforeSnapshot, after: afterSnapshot }, null, 2)}\n`,
  );

  killAllCandidates();
  const positiveCrash = run("node", [
    "scripts/qa/crash-diff.mjs",
    "--baseline",
    join(positive.candidateDir, "manifest.json"),
    "--out",
    join(outDir, "positive-crash"),
    "--expect-exited-pid",
    String(oldPid),
  ], { cwd: repoRoot });
  check("positive.crash-diff", positiveCrash.status === 0, positiveCrash.stdout.trim() || positiveCrash.stderr.trim());

  // 4. 负例:同一个包,签名翻掉一位
  say("==> negative: tampered signature must be refused");
  const negative = launchCandidate("negative", basePackage.app, `http://127.0.0.1:${badPort}/latest.json`);
  const negativePid = negative.manifest.candidate.pid;
  const negativeApp = negative.manifest.candidate.appPath;
  assertUnlocked("negative");
  openSettings(negativePid);
  check("negative.check-button", clickByLabel("检查更新", { exact: true }), "点中「检查更新」");
  const negativeFound = waitForText([foundNeedle, "校验失败", "更新失败", "已是最新版本"], { timeoutMs: 90000 });
  // 检查这一步应该照样发现新版本:latest.json 本身是好的,坏的是签名,
  // 而签名只在下载完成后才被校验。这里如果就红了,说明拒绝发生在错误的位置。
  check("negative.update-still-found", negativeFound.needle === foundNeedle, `界面文本命中=${negativeFound.needle}`);

  check("negative.install-button", clickByLabel("下载并安装", { exact: true }), "点中「下载并安装」");
  const refused = waitForText(["签名校验失败", "重启后生效", "更新失败"], { timeoutMs: 180000 });
  check("negative.refused", refused.needle === "签名校验失败", `界面文本命中=${refused.needle}`);
  // M2(review 修复):只命中中文「签名校验失败」不够——updaterClient.ts 的分类判据现在
  // 只认英文原文里的 "signature",所以中文文案背后必须真的是签名类错误,而不是一句
  // 恰好也含有旧宽泛词(decod/base64/verif)的传输层错误被误判过来的。同时断言英文子串
  // "signature verification failed"(minisign_verify::Error::InvalidSignature 的
  // Display),两条都命中才算负例真的验证了「篡改签名被拒绝」,而不是别的错误碰巧撞对了
  // 中文文案。
  check(
    "negative.refused-is-signature-error",
    refused.text.includes("签名校验失败") &&
      /signature verification failed/i.test(refused.text),
    `界面文本=${refused.text.slice(0, 200)}`,
  );
  check("negative.not-installed", !refused.text.includes("重启后生效"), "界面上没有出现「重启后生效」");
  writeFileSync(join(outDir, "negative-after-install.txt"), refused.text);

  const negativeVersion = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(negativeApp, "Contents/Info.plist"),
  ]).stdout.trim();
  check("negative.bundle-untouched", negativeVersion === baseVersion, `Info.plist 仍是 ${negativeVersion}`);
  check(
    "negative.still-running",
    alivePids(`${negativeApp}/Contents/MacOS/tripcut-studio`).includes(negativePid),
    `pid=${negativePid} 仍在运行`,
  );

  killAllCandidates();
  const negativeCrash = run("node", [
    "scripts/qa/crash-diff.mjs",
    "--baseline",
    join(negative.candidateDir, "manifest.json"),
    "--out",
    join(outDir, "negative-crash"),
    "--expect-exited-pid",
    String(negativePid),
  ], { cwd: repoRoot });
  check("negative.crash-diff", negativeCrash.status === 0, negativeCrash.stdout.trim() || negativeCrash.stderr.trim());

  finish({
    baseVersion,
    nextVersion,
    endpoints: { good: `http://127.0.0.1:${goodPort}/latest.json`, bad: `http://127.0.0.1:${badPort}/latest.json` },
    packages: { base: basePackage.app, next: nextPackage.app, tar: nextPackage.tar },
  });
} catch (error) {
  check("run.completed", false, `${error?.stack ?? error}`);
  killAllCandidates();
  finish({ stoppedAt: "exception" });
}
