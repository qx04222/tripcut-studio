#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 127,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function requireSuccess(result) {
  if (result.exitCode !== 0) {
    throw new Error(`${result.command} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function machoUuid(path) {
  const output = requireSuccess(run("dwarfdump", ["--uuid", path])).stdout;
  const match = output.match(/UUID:\s+([0-9A-F-]+)\s+\(([^)]+)\)/i);
  if (!match) throw new Error(`unexpected dwarfdump output: ${output}`);
  return `${match[1].toUpperCase()} (${match[2]})`;
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runningPids() {
  const result = run("pgrep", ["-x", "tripcut-studio"]);
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").map(Number).filter(Number.isSafeInteger);
}

function processCommand(pid) {
  return run("ps", ["-p", String(pid), "-o", "command="]).stdout;
}

function windowCount(pid) {
  const script = [
    'tell application "System Events"',
    `set matches to every application process whose unix id is ${pid}`,
    'if (count matches) is 0 then return "missing"',
    'return (count windows of item 1 of matches) as text',
    "end tell",
  ];
  const result = run("osascript", script.flatMap((line) => ["-e", line]));
  return {
    ...result,
    count: result.exitCode === 0 && /^\d+$/.test(result.stdout) ? Number(result.stdout) : 0,
  };
}

function bundleResourceManifest(root) {
  const entries = [];
  const visit = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === "Contents/Info.plist" || relative.startsWith("Contents/_CodeSignature/")) continue;
      const path = join(directory, name);
      const metadata = statSync(path);
      if (metadata.isDirectory()) visit(path, relative);
      else if (metadata.isFile() && relative !== "Contents/MacOS/tripcut-studio") {
        entries.push({ path: relative, bytes: metadata.size, sha256: sha256(path) });
      }
    }
  };
  visit(root);
  return entries;
}

function crashReports() {
  const directory = join(homedir(), "Library/Logs/DiagnosticReports");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^tripcut-studio.*\.ips$/i.test(name))
    .map((name) => {
      const path = join(directory, name);
      return { path, modifiedAt: statSync(path).mtime.toISOString(), sha256: sha256(path) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

const appArgument = argument("--app");
if (!appArgument) {
  console.error("usage: prepare-cua-candidate.mjs --app /absolute/path/App.app [--out directory]");
  process.exit(2);
}

const sourceApp = realpathSync(resolve(appArgument));
const sourceExecutable = join(sourceApp, "Contents/MacOS/tripcut-studio");
if (!sourceApp.endsWith(".app") || !existsSync(sourceExecutable)) {
  console.error(`not a TripCut app bundle: ${sourceApp}`);
  process.exit(2);
}

const consoleSession = run("ioreg", ["-n", "Root", "-d1"]);
if (/CGSSessionScreenIsLocked"=Yes/.test(consoleSession.stdout)) {
  console.error("FAIL runtime.desktop-unlocked: macOS session is locked; native UI evidence would be invalid");
  process.exit(1);
}

const existing = run("pgrep", ["-x", "tripcut-studio"]);
if (existing.exitCode === 0 && existing.stdout) {
  console.error(`FAIL runtime.single-writer: TripCut already running (pid ${existing.stdout.replaceAll("\n", ", ")})`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const runToken = randomBytes(4).toString("hex");
const outputDirectory = resolve(argument("--out") ?? join(repoRoot, "qa/runs", `${timestamp}-cua-candidate`));
const temporaryRoot = mkdtempSync(join(tmpdir(), `tripcut-cua-${runToken}-`));
const qaApp = join(temporaryRoot, "旅剪工作台 QA.app");
const supportDirectory = join(temporaryRoot, "support");
const jianyingDirectory = join(temporaryRoot, "jianying-drafts");
const bundleId = `com.tripcut.studio.qa.${runToken}`;
mkdirSync(outputDirectory, { recursive: true });
mkdirSync(supportDirectory, { recursive: true });
mkdirSync(jianyingDirectory, { recursive: true });
cpSync(sourceApp, qaApp, { recursive: true, preserveTimestamps: true });
const qaExecutable = join(qaApp, "Contents/MacOS/tripcut-studio");
const canonicalQaExecutable = realpathSync(qaExecutable);
const sourceResources = bundleResourceManifest(sourceApp);

const plist = join(qaApp, "Contents/Info.plist");
requireSuccess(run("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${bundleId}`, plist]));
requireSuccess(run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleDisplayName 旅剪工作台 QA", plist]));
requireSuccess(run("codesign", ["--force", "--sign", "-", qaApp]));
requireSuccess(run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", qaApp]));

const baseline = crashReports();
const launchEnvironment = {
  TRIPCUT_APP_SUPPORT_DIR: supportDirectory,
  TRIPCUT_JIANYING_DRAFT_ROOT: jianyingDirectory,
  TRIPCUT_DISABLE_LLM_PROVIDERS: "1",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
};
for (const [name, value] of Object.entries(launchEnvironment)) {
  requireSuccess(run("launchctl", ["setenv", name, value]));
}
let launch;
try {
  // LaunchServices is part of the product contract. Running the Mach-O directly can
  // create a blank WebKit window and is therefore forbidden in native QA.
  launch = requireSuccess(run("open", ["-n", qaApp]));
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (runningPids().some((pid) => processCommand(pid).startsWith(canonicalQaExecutable))) break;
    wait(100);
  }
} finally {
  for (const name of Object.keys(launchEnvironment)) run("launchctl", ["unsetenv", name]);
}

const matchingPids = runningPids().filter((pid) => processCommand(pid).startsWith(canonicalQaExecutable));
const qaPid = matchingPids.length === 1 ? matchingPids[0] : null;
let stable = Boolean(qaPid);
if (qaPid) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    wait(100);
    if (!runningPids().includes(qaPid) || !processCommand(qaPid).startsWith(canonicalQaExecutable)) {
      stable = false;
      break;
    }
  }
}
let window = qaPid ? windowCount(qaPid) : { exitCode: 1, count: 0, stdout: "", stderr: "process missing" };
if (qaPid && stable) {
  for (let attempt = 0; attempt < 150 && (window.exitCode !== 0 || window.count === 0); attempt += 1) {
    wait(100);
    if (!runningPids().includes(qaPid)) break;
    window = windowCount(qaPid);
  }
}
const candidateResources = bundleResourceManifest(qaApp);
const checks = [
  { id: "candidate.qa-copy", pass: existsSync(qaApp), detail: qaApp },
  {
    id: "candidate.executable-identity",
    pass: machoUuid(sourceExecutable) === machoUuid(qaExecutable),
    detail: machoUuid(sourceExecutable),
  },
  {
    id: "candidate.resource-identity",
    pass: JSON.stringify(sourceResources) === JSON.stringify(candidateResources),
    detail: `${sourceResources.length} immutable bundle files`,
  },
  { id: "candidate.qa-signature", pass: true, detail: "ad-hoc signature for isolated QA copy" },
  { id: "runtime.launch-services", pass: launch?.exitCode === 0, detail: launch?.stderr || launch?.stdout || "open -n" },
  {
    id: "runtime.started",
    pass: qaPid !== null && matchingPids.length === 1,
    detail: qaPid ? `pid=${qaPid} command=${processCommand(qaPid)}` : `matching=${matchingPids.join(",") || "none"}`,
  },
  { id: "runtime.stable-3s", pass: stable, detail: qaPid ? `pid=${qaPid}` : "process missing" },
  {
    id: "runtime.accessible-window",
    pass: window.exitCode === 0 && window.count > 0,
    detail: window.exitCode === 0 ? `windows=${window.count}` : window.stderr || window.stdout,
  },
];
const failed = checks.filter((check) => !check.pass);
const manifest = {
  schemaVersion: 1,
  kind: "tripcut-cua-candidate",
  capturedAt: new Date().toISOString(),
  source: {
    appPath: sourceApp,
    appName: basename(sourceApp),
    executableSha256: sha256(sourceExecutable),
    executableUuid: machoUuid(sourceExecutable),
  },
  candidate: {
    appPath: qaApp,
    executableSha256: sha256(qaExecutable),
    executableUuid: machoUuid(qaExecutable),
    bundleId,
    supportDirectory,
    jianyingDirectory,
    realProvidersDisabled: true,
    pid: qaPid,
  },
  crashBaseline: baseline,
  checks,
};
const gate = {
  schemaVersion: 1,
  gate: "cua-candidate",
  status: failed.length === 0 ? "PASS" : "FAIL",
  failed,
  manifest: "manifest.json",
};
writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outputDirectory, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);

for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`);
}
console.log(`${gate.status} ${outputDirectory}`);
console.log(`CUA_APP_PATH=${qaApp}`);
console.log(`TRIPCUT_SUPPORT_DIR=${supportDirectory}`);
process.exitCode = failed.length === 0 ? 0 : 1;
