#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const repoRoot = resolve(import.meta.dirname, "../..");
const rustupBin = "/opt/homebrew/opt/rustup/bin";
const qaEnvironment = {
  ...process.env,
  PATH: existsSync(rustupBin)
    ? `${rustupBin}:${process.env.PATH ?? ""}`
    : process.env.PATH,
};

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args = []) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: qaEnvironment,
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 127,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function sha256(path) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) return null;
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function commandAvailable(command) {
  return run("/usr/bin/which", [command]).exitCode === 0;
}

function listCrashReports() {
  const directory = join(homedir(), "Library/Logs/DiagnosticReports");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^tripcut-studio.*\.ips$/i.test(name))
    .map((name) => {
      const path = join(directory, name);
      return { path, modifiedAt: statSync(path).mtime.toISOString() };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outputDirectory = resolve(argument("--out") ?? join(repoRoot, "qa/runs", `${timestamp}-preflight`));
const appPath = argument("--app") ? resolve(argument("--app")) : null;
const dmgPath = argument("--dmg") ? resolve(argument("--dmg")) : null;
mkdirSync(outputDirectory, { recursive: true });

const appExecutable = appPath ? join(appPath, "Contents/MacOS/tripcut-studio") : null;
const appInfo = appPath ? join(appPath, "Contents/Info.plist") : null;
const gitStatus = run("git", ["status", "--short", "--branch"]);
const gitHead = run("git", ["rev-parse", "HEAD"]);
const xcode = run("xcodebuild", ["-version"]);
const mountedImages = run("hdiutil", ["info"]);
const tripcutProcesses = run("pgrep", ["-x", "tripcut-studio"]);

const checks = [
  { id: "candidate.app-explicit", pass: Boolean(appPath), detail: appPath ?? "missing --app" },
  { id: "candidate.app-exists", pass: Boolean(appExecutable && existsSync(appExecutable)), detail: appExecutable ?? "no app" },
  { id: "candidate.dmg-explicit", pass: Boolean(dmgPath), detail: dmgPath ?? "missing --dmg" },
  { id: "candidate.dmg-exists", pass: Boolean(dmgPath && existsSync(dmgPath)), detail: dmgPath ?? "no dmg" },
  { id: "tool.node", pass: commandAvailable("node"), detail: run("node", ["--version"]).stdout },
  { id: "tool.npm", pass: commandAvailable("npm"), detail: run("npm", ["--version"]).stdout },
  { id: "tool.cargo", pass: commandAvailable("cargo"), detail: commandAvailable("cargo") ? run("cargo", ["--version"]).stdout : "not found" },
  { id: "tool.rustc", pass: commandAvailable("rustc"), detail: commandAvailable("rustc") ? run("rustc", ["--version"]).stdout : "not found" },
  { id: "tool.xcode", pass: xcode.exitCode === 0, detail: xcode.stdout || xcode.stderr },
  { id: "tool.ffmpeg", pass: commandAvailable("ffmpeg"), detail: run("ffmpeg", ["-version"]).stdout.split("\n")[0] ?? "" },
  { id: "tool.ffprobe", pass: commandAvailable("ffprobe"), detail: run("ffprobe", ["-version"]).stdout.split("\n")[0] ?? "" },
  {
    id: "runtime.single-writer",
    pass: tripcutProcesses.exitCode !== 0 || tripcutProcesses.stdout.split("\n").filter(Boolean).length <= 1,
    detail: tripcutProcesses.stdout || "no running TripCut process",
  },
  {
    id: "runtime.no-mounted-tripcut-dmg",
    pass: !/mount-point\s+:\s+\/Volumes\/旅剪工作台/.test(mountedImages.stdout),
    detail: mountedImages.stdout.match(/mount-point\s+:\s+.*旅剪工作台.*/g)?.join("\n") ?? "none",
  },
];

const manifest = {
  schemaVersion: 1,
  kind: "tripcut-preflight",
  capturedAt: new Date().toISOString(),
  repoRoot,
  source: {
    head: gitHead.stdout || null,
    status: gitStatus.stdout,
  },
  candidate: {
    appPath,
    appExecutableSha256: sha256(appExecutable),
    infoPlistSha256: sha256(appInfo),
    dmgPath,
    dmgSha256: sha256(dmgPath),
    label: dmgPath ? basename(dmgPath) : null,
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    xcode,
  },
  crashBaseline: listCrashReports(),
  checks,
};

const failed = checks.filter((check) => !check.pass);
const gate = {
  schemaVersion: 1,
  gate: "phase0-preflight",
  status: failed.length === 0 ? "PASS" : "FAIL",
  failed: failed.map(({ id, detail }) => ({ id, detail })),
  manifest: "manifest.json",
};

writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outputDirectory, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);

console.log(`${gate.status} ${outputDirectory}`);
for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}: ${String(check.detail).split("\n")[0]}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
