#!/usr/bin/env node
// 导演台工作区的无头截图装置:起一个 `vite --mode mock`(假 Tauri 后端,见
// src/devMock/),用 Playwright 的无头 Chromium 打开工作区,按固定剧本截 9 张图
// + 一份 AX 树,写到 qa/preview/<时间戳>/。不需要 Tauri、不需要 mpv、不需要
// macOS 录屏权限——控制端拿到的是像素,而不是"测试通过"四个字。
//
// 用法: node scripts/qa/preview-shots.mjs [--out <目录>] [--keep-server] [--kit | --kit-only]
//   --kit       工作区剧本之后再开 kit.html(套件 kitchen-sink),多截 10-kit / 11-kit-hover / 12-kit-drawer
//   --kit-only  跳过工作区剧本,只截套件(npm run preview:kit)
// 任一预期元素找不到即非零退出(截图仍尽量落盘,方便看"错在哪一步")。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { makeMockCovers } from "./make-mock-covers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const repoRoot = resolve(import.meta.dirname, "../..");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outDir = resolve(argument("--out") ?? join(repoRoot, "qa/preview", timestamp));
mkdirSync(outDir, { recursive: true });

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1280, height: 800 };
const STEP_TIMEOUT_MS = 15_000;
const KIT_ONLY = process.argv.includes("--kit-only");
const WITH_KIT = KIT_ONLY || process.argv.includes("--kit");

const failures = [];
const log = (line) => {
  console.log(line);
  logLines.push(line);
};
const logLines = [];

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function startVite(port) {
  const child = spawn(
    process.execPath,
    [join(repoRoot, "node_modules/vite/bin/vite.js"), "--mode", "mock", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" } },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited early (${child.exitCode}):\n${output}`);
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return { child, url, output: () => output };
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error(`vite did not come up within 30s:\n${output}`);
}

/** 每一步:找元素(找不到 = 记失败但继续),做动作,等一拍,截图。 */
async function shot(page, name, { locate, act, settle = 400 } = {}) {
  const file = join(outDir, `${name}.png`);
  try {
    if (locate) {
      const target = locate(page);
      await target.first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
      if (act) await act(target.first(), page);
    } else if (act) {
      await act(null, page);
    }
    await page.waitForTimeout(settle);
    await page.screenshot({ path: file, fullPage: false });
    log(`PASS ${name} → ${file}`);
  } catch (error) {
    failures.push(`${name}: ${String(error).split("\n")[0]}`);
    try {
      await page.screenshot({ path: file, fullPage: false });
    } catch {
      // 页面都截不下来就算了,失败已经记了
    }
    log(`FAIL ${name}: ${String(error).split("\n")[0]}`);
  }
}

/** 工作区剧本:9 张图 + AX 树 + landmark 硬断言。`--kit-only` 时整段跳过。 */
async function workspaceScript(page, context, viteUrl) {
  await page.goto(viteUrl, { waitUntil: "domcontentloaded" });
  // 「媒体池」landmark 出现 = 旗已落地、新壳已挂载。
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  // 素材网格第一格出现 = clips feed 已拉到假后端的 60 条。
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  // 封面是 lazy 的,等一拍让首屏那几行都解码完。
  await page.waitForTimeout(800);

  // 启动第一帧原样留证:空 hash 现在落到 `#/`(工作区本体),这一帧不该有任何抽屉;
  // 万一有(回归),下面按 Escape 关掉并在日志里留一行。
  await shot(page, "00-boot", { settle: 600 });
  if ((await page.getByRole("dialog").count()) > 0) {
    log("note: a dialog is open right after boot (legacy #/import redirect) — pressing Escape before 01-workspace");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(300);
  }

  await shot(page, "01-workspace");

  await shot(page, "02-selected", {
    locate: (p) => p.getByRole("gridcell"),
    act: async (cell, p) => {
      await cell.click();
      // 监视器切到该素材:传输控件出现(假后端 player_open 直接给 ready)。
      await p.getByRole("region", { name: "预览监视器" }).getByRole("button", { name: /播放|暂停/ }).first().waitFor({ timeout: STEP_TIMEOUT_MS });
    },
    settle: 700,
  });

  await shot(page, "03-band-music", {
    locate: (p) => p.getByRole("tab", { name: "音乐" }),
    act: async (tab, p) => {
      await tab.click();
      await p.getByText("音乐与节奏").first().waitFor({ timeout: STEP_TIMEOUT_MS });
    },
    settle: 700,
  });

  await shot(page, "04-inspector-open", {
    locate: (p) => p.getByRole("region", { name: "检查器" }).locator("details summary", { hasText: "技术检查" }),
    act: async (summary, p) => {
      await summary.click();
      await p.getByRole("region", { name: "检查器" }).locator("details[open] summary", { hasText: "技术检查" }).waitFor({ timeout: STEP_TIMEOUT_MS });
    },
    settle: 500,
  });

  // R9 Task 4:切到「仅缺口」视图(假后端的两处缺口都在第 2 / 3 章,按章节视图里它们在视口外、
  // 被虚拟化折叠),选中第一个空槽位瓦片 —— 看虚线瓦片的选中环、自带的「生成候选」,以及检查器的缺口分支。
  await shot(page, "09-gap-slot", {
    locate: (p) => p.getByRole("group", { name: "镜头带视图" }).getByRole("button", { name: "仅缺口" }),
    act: async (toggle, p) => {
      await toggle.click();
      const cell = p.getByRole("region", { name: "镜头带" }).getByRole("gridcell", { name: /：缺口 / }).first();
      await cell.waitFor({ timeout: STEP_TIMEOUT_MS });
      await cell.scrollIntoViewIfNeeded();
      await cell.click();
      await p.getByRole("region", { name: "检查器" }).getByText("缺口原因").waitFor({ timeout: STEP_TIMEOUT_MS });
    },
    settle: 600,
  });
  await page.getByRole("group", { name: "镜头带视图" }).getByRole("button", { name: "按章节" }).click();

  await shot(page, "05-import-drawer", {
    locate: (p) => p.getByRole("button", { name: "导入素材", exact: true }),
    act: async (button, p) => {
      await button.click();
      await p.getByRole("dialog").first().waitFor({ timeout: STEP_TIMEOUT_MS });
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);

  await shot(page, "06-deliver-drawer", {
    locate: (p) => p.getByRole("button", { name: "生成交付包", exact: true }),
    act: async (button, p) => {
      await button.click();
      await p.getByRole("dialog").first().waitFor({ timeout: STEP_TIMEOUT_MS });
      await p.getByText("本次交付平台").first().waitFor({ timeout: STEP_TIMEOUT_MS });
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);

  await shot(page, "07-settings-sheet", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      await button.click();
      await p.getByRole("dialog").first().waitFor({ timeout: STEP_TIMEOUT_MS });
      await p.getByText("隐私与诊断").first().waitFor({ timeout: STEP_TIMEOUT_MS });
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);

  await page.setViewportSize(NARROW);
  await shot(page, "08-narrow-1280", { settle: 900 });

  // AX 树两份:CDP 的完整 AX 节点表(ax.json,Playwright 1.6x 已删掉 page.accessibility)
  // 与 Playwright 的 ariaSnapshot(aria.yml,人眼好读)。都在 1280 窗宽下抓——
  // 这就是规格 §2 的最小窗口,冒烟脚本的断言按它写。
  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const compact = nodes
    .filter((node) => !node.ignored)
    .map((node) => ({
      id: node.nodeId,
      role: node.role?.value,
      name: node.name?.value || undefined,
      value: node.value?.value || undefined,
      children: node.childIds,
      props: Object.fromEntries((node.properties ?? []).map((prop) => [prop.name, prop.value?.value])),
    }));
  writeFileSync(join(outDir, "ax.json"), JSON.stringify(compact, null, 1));
  await cdp.detach();
  const aria = await page.locator("body").ariaSnapshot();
  writeFileSync(join(outDir, "aria.yml"), aria);

  // 硬断言:规格 §7 冻结的四个 landmark 与旧壳导航缺席。1280 是最小窗宽,
  // 检查器在这里按规格 §2 先折成竖条 —— landmark 与「展开检查器」二者必居其一。
  for (const [role, name] of [["region", "媒体池"], ["region", "预览监视器"], ["status", "后台状态"]]) {
    const count = await page.getByRole(role, { name }).count();
    if (count === 0) failures.push(`landmark missing: ${role} ${name}`);
  }
  if (
    (await page.getByRole("region", { name: "检查器" }).count()) === 0 &&
    (await page.getByRole("button", { name: "展开检查器" }).count()) === 0
  ) {
    failures.push("landmark missing: region 检查器 (and no 展开检查器 rail)");
  }
  if ((await page.getByText("01 导入 INGEST").count()) > 0) failures.push("legacy nav 01 导入 INGEST still in tree");
}

async function main() {
  const covers = await makeMockCovers({ chromium });
  log(`covers: ${covers.generated > 0 ? `generated ${covers.generated}` : `reused ${covers.existing}`} in ${covers.outDir}`);

  const port = await freePort();
  const vite = await startVite(port);
  log(`vite --mode mock on ${vite.url}`);

  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 1, locale: "zh-CN" });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleErrors.push(`[${message.type()}] ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.setDefaultTimeout(STEP_TIMEOUT_MS);

    if (!KIT_ONLY) await workspaceScript(page, context, vite.url);

    if (WITH_KIT) {
      await page.setViewportSize(WIDE);
      await page.goto(`${vite.url}kit.html`, { waitUntil: "domcontentloaded" });
      await page.getByRole("region", { name: "按钮" }).waitFor({ timeout: STEP_TIMEOUT_MS });
      await page.waitForTimeout(400);
      const file = join(outDir, "10-kit.png");
      await page.screenshot({ path: file, fullPage: true });
      log(`PASS 10-kit → ${file}`);
      // hover 态:把鼠标停在第一个 secondary 按钮上再截一张局部
      const hover = page.getByRole("region", { name: "按钮" }).getByRole("button").nth(1);
      await hover.hover();
      await page.waitForTimeout(200);
      await page.getByRole("region", { name: "按钮" }).screenshot({ path: join(outDir, "11-kit-hover.png") });
      log(`PASS 11-kit-hover → ${join(outDir, "11-kit-hover.png")}`);
      // 真实抽屉:打开右侧抽屉(表单语法 + 标题栏 actions)截一张视窗图,Esc 关掉。
      await page.getByRole("button", { name: "打开右侧抽屉" }).click();
      await page.getByRole("dialog", { name: "生成交付包" }).waitFor({ timeout: STEP_TIMEOUT_MS });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, "12-kit-drawer.png"), fullPage: false });
      log(`PASS 12-kit-drawer → ${join(outDir, "12-kit-drawer.png")}`);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
      if ((await page.getByRole("dialog").count()) > 0) failures.push("kit: Esc did not close the drawer");
    }

    await context.close();
  } finally {
    await browser.close();
    if (!process.argv.includes("--keep-server")) vite.child.kill("SIGTERM");
  }

  const mockMisses = [...consoleErrors, ...pageErrors].filter((line) => line.includes("no handler for command"));
  writeFileSync(join(outDir, "console.log"), [...consoleErrors, ...pageErrors].join("\n"));
  writeFileSync(join(outDir, "run.log"), logLines.join("\n"));
  if (mockMisses.length > 0) failures.push(...mockMisses.map((line) => `mock gap: ${line}`));

  console.log(`\noutput dir: ${outDir}`);
  console.log(`console errors/warnings: ${consoleErrors.length}, page errors: ${pageErrors.length} (see console.log)`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
