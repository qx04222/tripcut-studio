#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

const baselineArgument = argument("--baseline");
const outputArgument = argument("--out");
if (!baselineArgument || !outputArgument) {
  console.error("usage: crash-diff.mjs --baseline /path/manifest.json --out /path/evidence");
  process.exit(2);
}

const baselinePath = resolve(baselineArgument);
const outputDirectory = resolve(outputArgument);
if (!existsSync(baselinePath)) {
  console.error(`baseline not found: ${baselinePath}`);
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const graceArgument = Number(argument("--grace-ms") ?? 5000);
const graceMs = Number.isFinite(graceArgument) ? Math.max(0, Math.min(30000, graceArgument)) : 5000;
if (graceMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs);
}
const known = new Set((baseline.crashBaseline ?? []).map((entry) => `${entry.path}\0${entry.sha256 ?? entry.modifiedAt}`));
const reportDirectory = join(homedir(), "Library/Logs/DiagnosticReports");
const current = existsSync(reportDirectory)
  ? readdirSync(reportDirectory)
    .filter((name) => /^tripcut-studio.*\.ips$/i.test(name))
    .map((name) => {
      const path = join(reportDirectory, name);
      return { path, modifiedAt: statSync(path).mtime.toISOString(), sha256: sha256(path) };
    })
  : [];
const added = current.filter((entry) => !known.has(`${entry.path}\0${entry.sha256}`));
const expectedPid = Number(argument("--expect-exited-pid") ?? baseline.candidate?.pid);
let processExited = true;
if (Number.isSafeInteger(expectedPid) && expectedPid > 0) {
  try {
    process.kill(expectedPid, 0);
    processExited = false;
  } catch (error) {
    if (error?.code !== "ESRCH") processExited = false;
  }
}
const crashDirectory = join(outputDirectory, "crashes");
mkdirSync(crashDirectory, { recursive: true });
for (const entry of added) cpSync(entry.path, join(crashDirectory, basename(entry.path)), { errorOnExist: true });

const gate = {
  schemaVersion: 1,
  gate: "native-crash-diff",
  capturedAt: new Date().toISOString(),
  status: added.length === 0 && processExited ? "PASS" : "FAIL",
  baseline: baselinePath,
  graceMs,
  expectedExitedPid: Number.isSafeInteger(expectedPid) ? expectedPid : null,
  processExited,
  added,
};
writeFileSync(join(outputDirectory, "crash-gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
console.log(`${gate.status} native-crash-diff added=${added.length}`);
if (!processExited) console.log(`FAIL process-still-running pid=${expectedPid}`);
for (const entry of added) console.log(`FAIL ${entry.path} ${entry.sha256}`);
process.exitCode = gate.status === "PASS" ? 0 : 1;
