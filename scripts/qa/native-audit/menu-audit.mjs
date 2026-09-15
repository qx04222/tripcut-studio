#!/usr/bin/env node
/**
 * R18 车道 native / M-01:真机菜单栏审计。
 *
 * 用法:node scripts/qa/native-audit/menu-audit.mjs --pid <pid> [--json-out <file>]
 * 退出码:0 = 通过;1 = 菜单有问题;3 = 探针故障(没权限 / 抓不到 / pid 不对)。
 *
 * 只**读** AX 树,不 AXPress、不发按键,所以不会把焦点从被测应用上抢走。
 * 判定在 `menuAudit.mjs`(纯函数,vitest 里对 R18 之前那条默认英文菜单栏报过红)。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { auditMenuBar } from "./menuAudit.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const pid = Number.parseInt(argument("--pid") ?? "", 10);
if (!Number.isFinite(pid)) {
  console.error("用法:node scripts/qa/native-audit/menu-audit.mjs --pid <pid> [--json-out <file>]");
  process.exit(3);
}

const source = resolve(import.meta.dirname, "axmenu.swift");
const workDirectory = mkdtempSync(join(tmpdir(), "tripcut-axmenu-"));
const binary = join(workDirectory, "axmenu");
const compile = spawnSync("swiftc", ["-O", "-o", binary, source], { encoding: "utf8" });
if (compile.status !== 0) {
  console.error(`PROBE:axmenu.swift 编译失败\n${compile.stderr ?? ""}`);
  process.exit(3);
}

const run = spawnSync(binary, [String(pid)], { encoding: "utf8" });
let dump;
try {
  dump = JSON.parse(run.stdout || "{}");
} catch {
  dump = { ok: false, error: `axmenu 的输出不是 JSON:${run.stdout || run.stderr}` };
}

const verdict = auditMenuBar(dump);
const jsonOut = argument("--json-out");
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ ...verdict, dump }, null, 2)}\n`);

if (verdict.status === "PROBE") {
  console.error(`PROBE(探针故障,不是缺陷):${verdict.findings.join("; ")}`);
  process.exit(3);
}
for (const finding of verdict.findings) console.error(`FAIL:${finding}`);
console.log(`菜单栏审计:${verdict.status}(${dump.menus?.length ?? 0} 条顶级菜单)`);
process.exit(verdict.status === "PASS" ? 0 : 1);
