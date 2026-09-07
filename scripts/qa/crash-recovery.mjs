#!/usr/bin/env node
// G18 崩溃恢复回归:对 import/rate/export 三条写路径各做一次"崩溃后自检"——
// 拷贝一份已导入过素材的种子库,用 crash_probe 在收尾事务提交前 abort(),
// 断言库依旧完整(PRAGMA integrity_check / foreign_key_check),再正常跑一次
// 同一条路径,断言它照常成功。这证明的是"WAL 崩溃恢复"而不是"从不崩溃"。
//
// 用法: node scripts/qa/crash-recovery.mjs [--fixtures <目录>] [--out <目录>]
// 环境: TRIPCUT_CRASH_RECOVERY_CALIBRATE=1  检测器校准模式——把第一条路径的
//       崩溃模式从 before_commit 换成 after_corrupt(crash_probe 内测试专用
//       分支,写完后人为截断库文件 4096 字节)。这条路径的完整性检查必须
//       FAIL,用来证明本脚本的断言不是摆设。仅用于人工校准,不要在正常收尾
//       链路里打开。

import { existsSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../..");
const rustupBin = "/opt/homebrew/opt/rustup/bin";
const cargoHomeBin = join(process.env.HOME ?? "", ".cargo/bin");
const targetDir = process.env.CARGO_TARGET_DIR || join(process.env.HOME ?? "", "Projects/tripcut-studio/src-tauri/target");
const env = {
  ...process.env,
  CARGO_TARGET_DIR: targetDir,
  PATH: [existsSync(rustupBin) ? rustupBin : null, existsSync(cargoHomeBin) ? cargoHomeBin : null, process.env.PATH ?? ""]
    .filter(Boolean)
    .join(":"),
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const fixturesDir = resolve(arg("--fixtures", "/tmp/perf-smoke"));
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outputDir = resolve(arg("--out", join(repoRoot, "qa/runs", `${timestamp}-crash-recovery`)));
mkdirSync(outputDir, { recursive: true });

const calibrate = process.env.TRIPCUT_CRASH_RECOVERY_CALIBRATE === "1";

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env, cwd: repoRoot, ...opts });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    signal: result.signal,
  };
}

function step(label, fn) {
  const startedAt = Date.now();
  let detail = {};
  let ok = false;
  try {
    detail = fn() ?? {};
    ok = detail.ok !== false;
  } catch (error) {
    detail = { error: String(error?.stack ?? error) };
    ok = false;
  }
  const record = { id: label, pass: ok, durationMs: Date.now() - startedAt, ...detail };
  console.log(`${ok ? "PASS" : "FAIL"} ${label} (${record.durationMs}ms)`);
  return record;
}

const results = [];

if (!existsSync(fixturesDir)) {
  results.push(
    step("fixtures-present", () => {
      const gen = run("scripts/qa/make-perf-fixtures.sh", ["8", fixturesDir], { shell: false, cwd: repoRoot });
      return { ok: gen.status === 0, stdout: gen.stdout, stderr: gen.stderr };
    }),
  );
} else {
  results.push(step("fixtures-present", () => ({ ok: true, note: `reused ${fixturesDir}` })));
}

results.push(
  step("build-examples", () => {
    const build = run("cargo", [
      "build",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--example",
      "crash_probe",
      "--example",
      "perf_driver",
    ]);
    return { ok: build.status === 0, stdout: build.stdout.slice(-4000), stderr: build.stderr.slice(-4000) };
  }),
);

if (results.some((r) => !r.pass)) {
  finish(1);
}

const crashProbeBin = join(targetDir, "debug/examples/crash_probe");
const perfDriverBin = join(targetDir, "debug/examples/perf_driver");
const workRoot = mkdtempSync(join(tmpdir(), "tripcut-crash-recovery-"));
const seedDb = join(workRoot, "seed.db");

results.push(
  step("build-seed-db", () => {
    const seed = run(perfDriverBin, [
      "--db",
      seedDb,
      "--folder",
      fixturesDir,
      "--workers",
      "4",
      "--out",
      join(workRoot, "seed-perf-result.json"),
    ]);
    if (seed.status !== 0) {
      return { ok: false, stdout: seed.stdout, stderr: seed.stderr };
    }
    const checkpoint = run("sqlite3", [seedDb, "PRAGMA wal_checkpoint(TRUNCATE);"]);
    return { ok: checkpoint.status === 0, checkpoint: checkpoint.stdout.trim() };
  }),
);

if (results.some((r) => !r.pass)) {
  finish(1);
}

function integrityCheck(dbPath) {
  const integrity = run("sqlite3", ["-readonly", dbPath, "PRAGMA integrity_check;"]);
  const fkCheck = run("sqlite3", ["-readonly", dbPath, "PRAGMA foreign_key_check;"]);
  const integrityOk = integrity.status === 0 && integrity.stdout.trim() === "ok";
  const fkOk = fkCheck.status === 0 && fkCheck.stdout.trim() === "";
  return {
    ok: integrityOk && fkOk,
    integrityStatus: integrity.status,
    integrityOutput: integrity.stdout.trim() || integrity.stderr.trim(),
    fkStatus: fkCheck.status,
    fkOutput: fkCheck.stdout.trim() || fkCheck.stderr.trim(),
  };
}

const ops = [
  { op: "import", args: ["--folder", fixturesDir] },
  { op: "rate", args: [] },
  { op: "export", args: ["--dest", null] }, // dest resolved per-workdir below
];

let calibrationApplied = false;

for (const { op, args } of ops) {
  const workDir = join(workRoot, op);
  mkdirSync(workDir, { recursive: true });
  const dbPath = join(workDir, "work.db");
  copyFileSync(seedDb, dbPath);
  const opArgs = op === "export" ? ["--dest", (mkdirSync(join(workDir, "dest"), { recursive: true }), join(workDir, "dest"))] : args;

  const useCalibration = calibrate && !calibrationApplied;
  const crashMode = useCalibration ? "after_corrupt" : "before_commit";
  if (useCalibration) calibrationApplied = true;

  results.push(
    step(`${op}-crash-${crashMode}`, () => {
      const crashed = run(crashProbeBin, ["--db", dbPath, "--op", op, ...opArgs], {
        env: { ...env, TRIPCUT_CRASH_AT: crashMode },
      });
      if (crashMode === "before_commit") {
        // abort() must actually fire — a clean exit here means the probe never
        // reached the instrumented window, and the rest of this op proves nothing.
        const aborted = crashed.status !== 0 || crashed.signal != null;
        return { ok: aborted, status: crashed.status, signal: crashed.signal, stderr: crashed.stderr.slice(-2000) };
      }
      // after_corrupt exits cleanly by design; the corruption is checked next.
      return { ok: crashed.status === 0, status: crashed.status, stderr: crashed.stderr.slice(-2000) };
    }),
  );

  results.push(
    step(`${op}-integrity-after-crash`, () => {
      const check = integrityCheck(dbPath);
      if (useCalibration) {
        // Calibration: the corrupted db MUST fail integrity — pass this step only
        // if the detector correctly reports failure (i.e. check.ok === false).
        return { ok: check.ok === false, calibration: true, ...check };
      }
      return { ok: check.ok, ...check };
    }),
  );

  if (useCalibration) {
    // The db is deliberately corrupted; a second normal run would only muddy the
    // calibration signal, and the op-level result already reflects the required FAIL.
    continue;
  }

  results.push(
    step(`${op}-recovers-and-writes-again`, () => {
      const again = run(crashProbeBin, ["--db", dbPath, "--op", op, ...opArgs]);
      return { ok: again.status === 0, status: again.status, stdout: again.stdout.trim(), stderr: again.stderr.slice(-2000) };
    }),
  );
}

finish();

function finish(forceExit) {
  const failed = results.filter((r) => !r.pass);
  const status = failed.length === 0 ? "PASS" : "FAIL";
  const gate = {
    schemaVersion: 1,
    gate: "crash-recovery",
    capturedAt: new Date().toISOString(),
    calibrate,
    fixturesDir,
    status,
    results,
  };
  writeFileSync(join(outputDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
  console.log(`${status} ${outputDir}`);
  process.exitCode = forceExit ?? (failed.length === 0 ? 0 : 1);
  if (forceExit !== undefined) {
    process.exit(forceExit);
  }
}
