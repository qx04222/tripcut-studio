#!/usr/bin/env node
// 导演台工作区的无头截图装置:起一个 `vite --mode mock`(假 Tauri 后端,见
// src/devMock/),用 Playwright 的无头 Chromium 打开工作区,按固定剧本截 10 张图
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
// R10 U-10:中栏被压到它的最小 520px。<1040 时媒体池与检查器都折成 44px 竖条,620 − 44 − 44 − 2×6 = 520。
const MONITOR_NARROW = { width: 620, height: 800 };
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

/** 工作区剧本:10 张图 + AX 树 + landmark 硬断言。`--kit-only` 时整段跳过。 */
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
      // R12 起卡面中央是主动作按钮(点中它会打开选择列表),选中槽位要点标题那一行。
      await cell.locator(".band-slot-title").click();
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

  // R11 车道 E → R14 车道 B:抽屉默认落在剪映草稿(假后端剪映可用)/ 剪映素材包(不可用);06 这张仍是
  // 完整交付包的表单,先切 chip(快速模式单独截 17,素材包截 28)。
  await shot(page, "06-deliver-drawer", {
    locate: (p) => p.getByRole("button", { name: "第 4 步 导出", exact: true }), // R12:顶栏按钮迁为「流水线下一步」,开导出抽屉走导航条
    act: async (button, p) => {
      await button.click();
      await p.getByRole("dialog").first().waitFor({ timeout: STEP_TIMEOUT_MS });
      await p.getByRole("button", { name: "完整交付包" }).click();
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

  // R10 车道 C(U-10 / U-37):先在 1280 下重新选一条素材(09 步选的是空槽位,没有传输条),
  // 再把窗口压到中栏只剩最小 520px,打上入出点、F6 把焦点送进监视器栏 —— 看传输条不溢出、
  // 「全屏 ⌘⏎」还在,以及栏的焦点环。硬断言:全屏按钮的盒子落在监视器 landmark 里,传输条没有横向溢出。
  await shot(page, "10-monitor-narrow", {
    locate: (p) => p.getByRole("region", { name: "媒体池" }).getByRole("gridcell"),
    act: async (cell, p) => {
      const monitor = p.getByRole("region", { name: "预览监视器" });
      await cell.click();
      await monitor.getByRole("button", { name: "入点" }).waitFor({ timeout: STEP_TIMEOUT_MS });
      await p.setViewportSize(MONITOR_NARROW);
      await p.waitForTimeout(400);
      await monitor.getByRole("button", { name: "入点" }).click();
      await monitor.getByRole("button", { name: "前进一秒" }).click();
      await monitor.getByRole("button", { name: "前进一秒" }).click();
      await monitor.getByRole("button", { name: "出点" }).click();
      await monitor.getByRole("button", { name: "出点", pressed: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
      // F6 轮到监视器栏为止(从哪一栏起转取决于上一步点了什么,最多四次)。
      for (let round = 0; round < 4; round += 1) {
        await p.keyboard.press("F6");
        if ((await p.locator('[data-pane="monitor"]:focus').count()) > 0) break;
      }
      await p.locator('[data-pane="monitor"]:focus-visible').waitFor({ timeout: STEP_TIMEOUT_MS });
      const region = await monitor.boundingBox();
      const fullscreen = await monitor.getByRole("button", { name: "全屏沉浸" }).boundingBox();
      if (!region || !fullscreen) failures.push("10-monitor-narrow: monitor region or 全屏 button has no box");
      else if (fullscreen.x + fullscreen.width > region.x + region.width + 0.5 || fullscreen.x < region.x - 0.5) {
        failures.push(`10-monitor-narrow: 全屏 button overflows monitor region (${JSON.stringify(fullscreen)} vs ${JSON.stringify(region)})`);
      }
      const overflow = await monitor.locator(".monitor-controls").evaluate((node) => node.scrollWidth - node.clientWidth);
      if (overflow > 0) failures.push(`10-monitor-narrow: .monitor-controls overflows by ${overflow}px`);
      if (region && region.width > 560) failures.push(`10-monitor-narrow: monitor pane is ${region.width}px wide, expected ≈520`);
    },
    settle: 600,
  });
  await page.setViewportSize(NARROW);
  // R10 U-04:走查里的窗宽序列 1512 → 1280 → 1704 → 展开 → 1512。每一步检查器该在就在,
  // 末了整栏宽 ≥ 280(真机上「整个消失」就是宽塌成 0)。jsdom 量不到宽,这里是真 Chromium。
  const inspectorWidth = async () => {
    const box = await page.getByRole("region", { name: "检查器" }).boundingBox().catch(() => null);
    return box ? box.width : 0;
  };
  await page.setViewportSize({ width: 1512, height: 945 });
  await page.waitForTimeout(400);
  if ((await inspectorWidth()) < 280) failures.push(`U-04: inspector width < 280 at 1512 (before sequence)`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  if ((await page.getByRole("button", { name: "展开检查器" }).count()) === 0) failures.push("U-04: no 展开检查器 rail at 1280");
  await page.setViewportSize({ width: 1704, height: 1013 });
  await page.waitForTimeout(400);
  if ((await inspectorWidth()) < 280) failures.push("U-04: inspector did not auto-expand at 1704");
  const rail = page.getByRole("button", { name: "展开检查器" });
  if ((await rail.count()) > 0) await rail.click();
  await page.setViewportSize({ width: 1512, height: 945 });
  await shot(page, "13-inspector-roundtrip-1512", { settle: 600 });
  const finalWidth = await inspectorWidth();
  if (finalWidth < 280) failures.push(`U-04: inspector width ${finalWidth} < 280 after 1512→1280→1704→展开→1512`);
  log(`U-04 inspector width after round trip: ${finalWidth}`);

  // R10 U-21:界面缩放 130% 一张——字号 / 行高 / 控件高 / 栏标题条应整套一起放大。
  await page.setViewportSize(WIDE);
  await page.evaluate(() => {
    document.documentElement.dataset.uiScale = "130";
  });
  await shot(page, "14-scale-130", { settle: 700 });
  await page.evaluate(() => {
    document.documentElement.dataset.uiScale = "100";
  });

  // R10 U-36:恢复页(假后端 `?recovery=1` 报异常退出)。1512×945 下标题不孤字、
  // 「进入工作台」不用滚动就在首屏(吸底操作条)。
  await page.setViewportSize({ width: 1512, height: 945 });
  await page.goto(`${viteUrl}?recovery=1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("main", { name: "旅剪启动恢复" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("button", { name: "进入工作台" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await shot(page, "15-recovery-1512", { settle: 600 });
  const enter = await page.getByRole("button", { name: "进入工作台" }).boundingBox();
  if (!enter || enter.y + enter.height > 945) failures.push("U-36: 进入工作台 is below the first screen at 1512×945");
  const titleLines = await page.locator(".recovery-r10-title").evaluate((node) => {
    const style = getComputedStyle(node);
    return Math.round(node.getBoundingClientRect().height / parseFloat(style.lineHeight));
  });
  if (titleLines > 1) failures.push(`U-36: recovery title wraps to ${titleLines} lines at 1512`);

  // R11 车道 C(§1.2 / §3):回到工作区,选第一条素材 —— seek bar 下有「时刻热力」(≤200 点、三条
  // 建议区块、一条高亮),状态行「建议 1/3 · … · 按 Enter 采用这段」,入出点已按当前建议预填;
  // 媒体池里有一半卡片带闪电角标;镜头带工具条有「自动挑选精选段」。硬断言写在 act 里。
  await page.setViewportSize(WIDE);
  await page.goto(viteUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await shot(page, "16-heat-strip", {
    locate: (p) => p.getByRole("region", { name: "媒体池" }).getByRole("gridcell"),
    act: async (cell, p) => {
      const monitor = p.getByRole("region", { name: "预览监视器" });
      await cell.click();
      await monitor.getByRole("img", { name: "时刻热力" }).waitFor({ timeout: STEP_TIMEOUT_MS });
      const bars = await monitor.locator(".monitor-heat-bar").count();
      if (bars === 0 || bars > 200) failures.push(`16-heat-strip: ${bars} heat bars (expected 1–200)`);
      const active = await monitor.locator(".monitor-heat-suggestion.active").count();
      if (active !== 1) failures.push(`16-heat-strip: ${active} active suggestion blocks (expected 1)`);
      await monitor.getByText(/^建议 1\/\d · /).waitFor({ timeout: STEP_TIMEOUT_MS });
      await monitor.getByText("按 Enter 采用这段").waitFor({ timeout: STEP_TIMEOUT_MS });
      await monitor.getByRole("button", { name: "入点", pressed: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
      const bolts = await p.getByRole("region", { name: "媒体池" }).locator(".pool-card-bolt").count();
      if (bolts === 0) failures.push("16-heat-strip: no 有建议段 bolt badge in the pool");
      await p.getByRole("region", { name: "镜头带" }).getByRole("button", { name: "自动挑选精选段" }).waitFor({ timeout: STEP_TIMEOUT_MS });
      // 热力条与 seek 轨道左缘对齐(容差 6px)。
      const heat = await monitor.locator(".monitor-heat").boundingBox();
      const track = await monitor.locator(".monitor-seek-track").boundingBox();
      if (heat && track && Math.abs(heat.x - track.x) > 6) failures.push(`16-heat-strip: heat strip x=${heat.x} vs seek track x=${track.x}`);
    },
    settle: 700,
  });
  // R11 车道 E:快速导出(抽屉默认模式)。看清单 + 引导句 + 「导出」主按钮;硬断言:
  // 快速模式下不出现「本次交付平台」/ 联系表开关,主按钮与「更改文件夹」都在。
  await page.goto(viteUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(WIDE);
  await shot(page, "17-quick-export", {
    locate: (p) => p.getByRole("button", { name: "第 4 步 导出", exact: true }), // R12:顶栏按钮迁为「流水线下一步」,开导出抽屉走导航条
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog").first();
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      // R13 §5:假后端的剪映是白名单版本 → 抽屉默认落在「剪映草稿」;这一步看的是快速导出,先切过去。
      await dialog.getByRole("button", { name: "导出片段", exact: true }).click();
      await dialog.getByRole("list", { name: "将导出的文件" }).waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await dialog.getByText("本次交付平台").count()) > 0) failures.push("R11-E: 快速导出模式里出现了「本次交付平台」");
      // Y-08(R13 真机):假后端没记过文件夹 → 主按钮叫「导出…」(记过才是「导出到上次文件夹」)。
      for (const name of ["导出…", "更改文件夹", "导出片段", "完整交付包", "剪映草稿", "剪映素材包"]) {
        if ((await dialog.getByRole("button", { name, exact: true }).count()) === 0) failures.push(`R11-E: button missing: ${name}`);
      }
      if ((await dialog.getByRole("button", { name: "导出到上次文件夹", exact: true }).count()) > 0) failures.push("Y-08: 没记过文件夹却叫「导出到上次文件夹」");
      const text = await dialog.innerText();
      if (/remux|H\.264|tick|VFR/i.test(text)) failures.push("R11-E: 快速导出文案出现内部术语");
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");

  // R11 简化专项 → R12 §1 → R13 §3:`?empty=1` 让素材库为空 —— 新用户第一眼看到的是首页(region「首页」,
  // 盖在三栏上),R12 的四步卡并入首页顶部(group「四步上手」,四步、无按钮);唯一的 primary 是
  // 「开始一个新旅程」;没有任何 dialog 打开;三栏 inert。
  await page.setViewportSize(WIDE);
  await page.goto(`${viteUrl}?empty=1`, { waitUntil: "domcontentloaded" });
  await shot(page, "18-onboarding", {
    locate: (p) => p.getByRole("region", { name: "首页" }),
    act: async (home, p) => {
      if ((await p.getByRole("dialog").count()) > 0) failures.push("18-onboarding: a dialog is open over the home screen");
      const steps = home.getByRole("group", { name: "四步上手" });
      await steps.waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await steps.locator("li").count()) !== 4) failures.push("18-onboarding: expected 4 steps in the home pipeline strip");
      const primaries = await home.locator(".ui-button--primary").count();
      if (primaries !== 1) failures.push(`18-onboarding: ${primaries} primary buttons on home (expected 1)`);
      if ((await home.getByRole("button", { name: "开始一个新旅程", exact: true }).count()) === 0) failures.push("18-onboarding: button missing: 开始一个新旅程");
      if (!(await p.locator(".workspace-columns").evaluate((node) => node.hasAttribute("inert")))) failures.push("18-onboarding: 三栏没有 inert");
      const text = await p.locator("body").innerText();
      if (/FIRST RUN|remux|VFR|sidecar|L1|L3/.test(text)) failures.push("18-onboarding: 空工作区出现内部术语");
    },
    settle: 800,
  });

  // R11 简化专项(车道 simplify):设置页收成 3 个分区 + 每区一个「高级…」折叠。硬断言:tablist「设置分区」
  // R13 §2 起:剪映式六个 tab、没有「高级…」折叠(23-settings-keymap 断言六块顺序);冻结锚点「云端补镜」「隐私与诊断」
  // 以左轨快捷入口常驻。截「播放与导出」分区(导出文件夹在那里)。
  await page.goto(viteUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await shot(page, "19-settings-simplified", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog").first();
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      const tabs = await dialog.getByRole("tablist", { name: "设置分区" }).getByRole("tab").allInnerTexts();
      if (tabs.length !== 6) failures.push(`19-settings-simplified: ${tabs.length} tabs in 设置分区 (expected 6): ${tabs.join(" | ")}`);
      for (const name of ["云端补镜", "隐私与诊断"]) {
        if ((await dialog.getByRole("button", { name, exact: true }).count()) === 0) failures.push(`19-settings-simplified: quick link missing: ${name}`);
      }
      await dialog.getByRole("tab", { name: /^播放与导出/ }).click();
      await dialog.getByText("导出文件夹").first().waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await dialog.locator("details.settings-sheet-advanced").count()) !== 0) failures.push("19-settings-simplified: 「高级…」 disclosure should be gone (R13 §2)");
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");

  // R12 车道 A(壳):`?analyzed=1` 让所有素材分析完 —— 流水线走到 ②/③/④,顶栏中央的四步导航条
  // 有勾、有计数、恰好一个 aria-current;主按钮 AX 名固定「流水线下一步」,可见文案「下一步:…」。
  await page.goto(`${viteUrl}?analyzed=1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await shot(page, "20-pipeline-rail", {
    locate: (p) => p.getByRole("navigation", { name: "流水线" }),
    act: async (nav, p) => {
      const names = await nav.getByRole("button").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
      const expected = ["第 1 步 导入", "第 2 步 挑选", "第 3 步 排列", "第 4 步 导出"];
      if (names.join("|") !== expected.join("|")) failures.push(`20-pipeline-rail: step buttons ${names.join("|")}`);
      const current = await nav.locator("button[aria-current='step']").count();
      if (current !== 1) failures.push(`20-pipeline-rail: ${current} aria-current buttons (expected 1)`);
      if ((await nav.locator("svg[data-icon='check']").count()) === 0) failures.push("20-pipeline-rail: no completed step shows a check");
      const next = p.getByRole("button", { name: "流水线下一步", exact: true });
      const label = await next.innerText();
      if (!/^(下一步:|再导出一次)/.test(label)) failures.push(`20-pipeline-rail: next button label ${label}`);
      if ((await p.getByRole("button", { name: "生成交付包", exact: true }).count()) > 0) failures.push("20-pipeline-rail: 顶栏仍有「生成交付包」");
      const text = await p.locator(".workspace-topbar").innerText();
      if (/INGEST|SELECT|DELIVER|ROUGH CUT/.test(text)) failures.push("20-pipeline-rail: 顶栏出现英文 kicker");
    },
    settle: 600,
  });

  // R12 车道 A:`?` 打开「流水线手册」——四步各 3 行 + 该步快捷键;仍是 dialog、可 Esc。
  await shot(page, "21-help-manual", {
    act: async (_target, p) => {
      await p.keyboard.press("?");
      const dialog = p.getByRole("dialog", { name: "流水线手册" });
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      const steps = await dialog.locator("[data-pipeline-step]").count();
      if (steps !== 4) failures.push(`21-help-manual: ${steps} pipeline steps (expected 4)`);
      for (const step of [1, 2, 3, 4]) {
        const lines = await dialog.locator(`[data-pipeline-step='${step}'] .pipeline-manual-howto li`).count();
        if (lines !== 3) failures.push(`21-help-manual: step ${step} has ${lines} how-to lines (expected 3)`);
        if ((await dialog.locator(`[data-pipeline-step='${step}'] kbd`).count()) === 0) failures.push(`21-help-manual: step ${step} has no shortcut keys`);
      }
    },
    settle: 600,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  if ((await page.getByRole("dialog").count()) > 0) failures.push("21-help-manual: Esc did not close the manual");
  // R12 车道 B(§2 / §3):「一键排入」把假后端里的精选段排进镜头带 → 顶部 Toast「已排入 n 段 · 覆盖 k 章 · 撤销」
  // (role=status,一条),带上出现「片段 a–b s」的段级镜块,选中的镜块常显「往前 / 往后」(X-03 由「上移 / 下移」改名);缺口卡只有一个主动作
  // + 「···」,空章有「这章够了」。硬断言写在 act 里;镜头带底部不再有 .band-toast。
  await page.goto(viteUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(WIDE);
  await shot(page, "22-band-arranged", {
    locate: (p) => p.getByRole("region", { name: "镜头带" }).getByRole("button", { name: "一键排入" }),
    act: async (button, p) => {
      const band = p.getByRole("region", { name: "镜头带" });
      if (!(await button.evaluate((node) => node.classList.contains("ui-button--primary")))) failures.push("22-band-arranged: 「一键排入」不是 primary");
      await button.click();
      const toast = p.getByRole("status").filter({ hasText: "已排入" });
      await toast.first().waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await p.locator(".ui-toast").count()) !== 1) failures.push("22-band-arranged: toast 不是恰好一条");
      if ((await toast.first().getByRole("button", { name: "撤销" }).count()) !== 1) failures.push("22-band-arranged: 排入 toast 缺「撤销」");
      const box = await p.locator(".ui-toast").boundingBox();
      const viewport = p.viewportSize();
      if (box && viewport && Math.abs(box.x + box.width / 2 - viewport.width / 2) > 40) failures.push(`22-band-arranged: toast 没有居中(x=${box.x}, w=${box.width})`);
      if ((await band.locator(".band-toast").count()) !== 0) failures.push("22-band-arranged: 镜头带底部仍有旧的 .band-toast 小字");
      await band.getByText(/^片段 [\d.]+–[\d.]+ s$/).first().waitFor({ timeout: STEP_TIMEOUT_MS });
      const segmentTile = band.locator(".band-segment").filter({ hasText: "片段 " }).first();
      // X-03:点选而不是悬停——选中态(ui-card--selected)要常显,鼠标移开也得在。
      await segmentTile.click();
      await p.mouse.move(4, 4);
      await p.waitForTimeout(300); // 露出有 120 ms 过渡
      for (const name of ["往前", "往后"]) {
        const button = segmentTile.getByRole("button", { name });
        if ((await button.count()) !== 1) failures.push(`22-band-arranged: 镜块缺「${name}」`);
        else if (!(await button.isVisible())) failures.push(`22-band-arranged: 选中镜块的「${name}」没常显`);
        else if ((await button.evaluate((el) => getComputedStyle(el.parentElement).opacity)) !== "1") failures.push(`22-band-arranged: 选中镜块的「${name}」仍是隐藏态(opacity≠1)`);
      }
      const gapCell = band.getByRole("gridcell", { name: /：缺口 / }).first();
      if ((await gapCell.count()) > 0) {
        const primaries = await gapCell.getByRole("button", { name: /从挑好的片段里选|回到第 2 步挑几条/ }).count();
        if (primaries !== 1) failures.push(`22-band-arranged: 缺口卡主动作数 ${primaries}(应为 1)`);
        if ((await gapCell.getByRole("button", { name: "更多" }).count()) !== 1) failures.push("22-band-arranged: 缺口卡缺「···」");
        if ((await gapCell.getByRole("button", { name: "生成候选" }).count()) !== 0) failures.push("22-band-arranged: 「生成候选」还在缺口卡面上");
      }
      const text = await band.innerText();
      if (/tick|VFR|remux|sidecar|L1|L3/.test(text)) failures.push("22-band-arranged: 镜头带出现内部术语");
    },
    settle: 500,
  });

  // R13 车道 A:设置 → 「快捷键」分区(六分区、无「高级…」、预设下拉、快捷键表、修改录制)。
  await page.keyboard.press("Escape");
  await shot(page, "23-settings-keymap", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog", { name: "设置" });
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      const tabs = await dialog.getByRole("tablist", { name: "设置分区" }).getByRole("tab").allInnerTexts();
      const labels = tabs.map((t) => t.split("\n")[0]);
      const expected = ["项目与缓存", "快捷键", "播放与导出", "性能", "工具与模型", "关于"];
      if (labels.join("|") !== expected.join("|")) failures.push(`23-settings-keymap: 分区 tab 不是剪映式六块(${labels.join("|")})`);
      if ((await dialog.locator("details.settings-sheet-advanced").count()) !== 0) failures.push("23-settings-keymap: 还有「高级…」折叠");
      if ((await dialog.locator(".settings-sheet-intro").count()) !== 1) failures.push("23-settings-keymap: 分区顶部缺「这里管什么」");
      await dialog.getByRole("tab", { name: "快捷键" }).click();
      const table = dialog.getByRole("table", { name: "快捷键表" });
      await table.waitFor({ timeout: STEP_TIMEOUT_MS });
      const preset = dialog.getByRole("combobox", { name: "键位预设" });
      if ((await preset.inputValue()) !== "jianying") failures.push("23-settings-keymap: 默认预设不是剪映");
      const exportKeys = await table.locator('[data-keymap-action="export"] kbd').allInnerTexts();
      if (exportKeys.join("/") !== "⌘E") failures.push(`23-settings-keymap: 导出键帽 ${exportKeys.join("/")}(应为 ⌘E)`);
      const edit = table.getByRole("button", { name: "修改「收藏」" });
      await edit.scrollIntoViewIfNeeded();
      await edit.click();
      await table.getByRole("button", { name: /正在录制「收藏」/ }).waitFor({ timeout: STEP_TIMEOUT_MS });
      await p.keyboard.press("Shift+G");
      await table.getByRole("button", { name: "修改「收藏」" }).waitFor({ timeout: STEP_TIMEOUT_MS });
      const favKeys = await table.locator('[data-keymap-action="favorite"] kbd').allInnerTexts();
      if (favKeys.join("/") !== "⇧G") failures.push(`23-settings-keymap: 录制后收藏键帽 ${favKeys.join("/")}(应为 ⇧G)`);
      if ((await preset.inputValue()) !== "custom") failures.push("23-settings-keymap: 改键后预设没有变成自定义");
      // 再把「拒绝」录成 ⇧G,撞键提示要出现。
      const editReject = table.getByRole("button", { name: "修改「拒绝」" });
      await editReject.click();
      await p.keyboard.press("Shift+G");
      await table.locator('[data-keymap-action="reject"] [role="alert"]').waitFor({ timeout: STEP_TIMEOUT_MS });
      await dialog.getByRole("button", { name: "恢复默认" }).click();
      await table.locator('[data-keymap-action="favorite"] kbd', { hasText: "F" }).first().waitFor({ timeout: STEP_TIMEOUT_MS });
      // 截图留在「自定义 + 撞键」之前的干净态太无聊 —— 再改一次收藏,让图里有录制痕迹与冲突提示。
      await edit.click();
      await p.keyboard.press("Shift+G");
      await editReject.click();
      await p.keyboard.press("Shift+G");
      await table.locator('[data-keymap-action="reject"] [role="alert"]').waitFor({ timeout: STEP_TIMEOUT_MS });
      await table.locator('[data-keymap-action="favorite"]').scrollIntoViewIfNeeded();
    },
    settle: 600,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  // R13 车道 B(§3):首页 —— `?empty=1` 之外也能从顶栏 logo 进(有素材时只从这里进)。看「开始一个新旅程」大按钮、
  // 「最近的集」卡(集名 / 缩略图 / 四步进度)、三个模板卡。硬断言:logo 是 button「首页」且按下;list「最近的集」≥1 张、
  // 进行中的集排第一且带四步进度;group「从模板开始」恰好三张卡;唯一 primary。
  await page.goto(viteUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  if ((await page.getByRole("region", { name: "首页" }).count()) > 0) failures.push("24-home: 有素材时首页自动出现了");
  await shot(page, "24-home", {
    locate: (p) => p.getByRole("button", { name: "首页", exact: true }),
    act: async (logo, p) => {
      await logo.click();
      const home = p.getByRole("region", { name: "首页" });
      await home.waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await logo.getAttribute("aria-pressed")) !== "true") failures.push("24-home: logo「首页」没有按下态");
      const primaries = await home.locator(".ui-button--primary").count();
      if (primaries !== 1) failures.push(`24-home: ${primaries} primary buttons (expected 1)`);
      const episodes = home.getByRole("list", { name: "最近的集" });
      await episodes.waitFor({ timeout: STEP_TIMEOUT_MS });
      // R15 起每张集卡旁边多了一颗「···」(集操作)按钮,也是 button —— 只数卡本体。
      const cards = episodes.locator(".home-episode-card");
      if ((await cards.count()) < 1) failures.push("24-home: 最近的集没有卡片");
      const first = await cards.first().innerText();
      if (!first.includes("进行中")) failures.push(`24-home: 第一张集卡不是进行中的集: ${first.replace(/\n/g, " | ")}`);
      if ((await cards.first().locator("[data-step-done]").count()) !== 4) failures.push("24-home: 集卡缺四步进度");
      const templates = home.getByRole("group", { name: "从模板开始" }).getByRole("button");
      const names = await templates.allInnerTexts();
      if (names.length !== 3 || !names.some((n) => n.includes("旅行日记")) || !names.some((n) => n.includes("电影感")) || !names.some((n) => n.includes("快节奏"))) {
        failures.push(`24-home: 模板卡 ${names.join(" | ")}`);
      }
      const text = await home.innerText();
      if (/tick|VFR|remux|sidecar|L1|L3|hero|Stack/.test(text)) failures.push("24-home: 首页出现内部术语");
    },
    settle: 800,
  });
  // 再点 logo 回工作区(不留首页给后面的步骤)。
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.getByRole("region", { name: "首页" }).waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);

  // R13 车道 B(§3):功能气泡。`?guides=1` 让假后端不把 guide.*.viewed 预置为 true —— 首次进入工作区先出
  // 「导航条」气泡(dialog「新手引导」,非模态,锚在流水线导航条正下方);「知道了」后选一条有建议的素材 → 「热力条」气泡。
  // 硬断言:同一时刻只有一个「新手引导」dialog;气泡盒子在导航条下方且横向相交;不带 aria-modal。
  await page.goto(`${viteUrl}?guides=1`, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await shot(page, "25-guide-bubble", {
    locate: (p) => p.getByRole("dialog", { name: "新手引导" }),
    act: async (bubble, p) => {
      if ((await p.getByRole("dialog", { name: "新手引导" }).count()) !== 1) failures.push("25-guide-bubble: 不是恰好一个气泡");
      if ((await bubble.getAttribute("aria-modal")) !== null) failures.push("25-guide-bubble: 气泡不该是 aria-modal");
      const text = await bubble.innerText();
      if (!text.includes("导入 → 挑选 → 排列 → 导出")) failures.push(`25-guide-bubble: 第一只气泡不是导航条: ${text}`);
      const rail = await p.locator("nav.pipeline-rail").boundingBox();
      const box = await bubble.boundingBox();
      if (!rail || !box) failures.push("25-guide-bubble: 导航条或气泡没有盒子");
      else {
        if (box.y < rail.y + rail.height) failures.push(`25-guide-bubble: 气泡没在导航条下方 (bubble y=${box.y}, rail bottom=${rail.y + rail.height})`);
        if (box.x + box.width < rail.x || box.x > rail.x + rail.width) failures.push("25-guide-bubble: 气泡与导航条横向不相交");
      }
      if ((await bubble.getByRole("button", { name: "知道了" }).count()) !== 1) failures.push("25-guide-bubble: 缺「知道了」");
    },
    settle: 600,
  });
  await page.getByRole("dialog", { name: "新手引导" }).getByRole("button", { name: "知道了" }).click();
  await page.getByRole("dialog", { name: "新手引导" }).waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  // 第二只:选一条带「有建议段」角标的素材 → 热力条气泡(锚在热力条上方)。
  const suggested = page.getByRole("region", { name: "媒体池" }).locator("[role='gridcell']").filter({ has: page.locator(".pool-card-bolt") }).first();
  await suggested.click();
  // 假后端一开机镜头带上就有镜块,所以「镜块」气泡可能排在热力条前面(同一时刻只出一个、按流水线顺序);
  // 逐只「知道了」,最多四只之内必须见到热力条那只。
  let sawHeat = false;
  for (let round = 0; round < 4 && !sawHeat; round += 1) {
    const bubble = page.getByRole("dialog", { name: "新手引导" });
    await bubble.waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
    const count = await bubble.count();
    if (count > 1) failures.push("25-guide-bubble: 同一时刻出现了多只气泡");
    if (count === 0) break;
    const text = await bubble.innerText();
    if (text.includes("精彩程度")) {
      sawHeat = true;
      await bubble.screenshot({ path: join(outDir, "25-guide-bubble-heat.png") }).catch(() => undefined);
    }
    await bubble.getByRole("button", { name: "知道了" }).click();
    await bubble.waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  }
  if (!sawHeat) failures.push("25-guide-bubble: 选中有建议的素材后四只之内没有热力条气泡");
  // R13 车道 C(§4 时间线化 + §5 交接感):镜头带视口上方有 img「时间刻度」;点一个精选段镜块 → 选中 + 播放头(红线)
  // 落在带上;精选段镜块有「调整入点 / 调整出点」把手;轨头有折叠按钮(aria-expanded);刻度行右端常驻「导入剪映继续剪」。
  // 接着 22 的状态截(带上已有排入的段)。
  await shot(page, "26-timeline", {
    locate: (p) => p.getByRole("region", { name: "镜头带" }).getByRole("img", { name: "时间刻度" }),
    act: async (ruler, p) => {
      const band = p.getByRole("region", { name: "镜头带" });
      if ((await ruler.locator(".band-time-mark--label").count()) === 0) failures.push("26-timeline: 时间刻度没有一个带文字的刻度");
      if ((await band.getByRole("button", { name: "在时间刻度上定位" }).count()) !== 1) failures.push("26-timeline: 刻度上缺定位按钮");
      const jianying = band.getByRole("button", { name: "导入剪映继续剪" });
      if ((await jianying.count()) !== 1) failures.push("26-timeline: 缺「导入剪映继续剪」");
      const fold = band.getByRole("button", { name: /^折叠第 \d+ 章$/ }).first();
      if ((await fold.count()) === 0) failures.push("26-timeline: 轨头缺折叠按钮");
      else if ((await fold.getAttribute("aria-expanded")) !== "true") failures.push("26-timeline: 折叠按钮 aria-expanded 不是 true");
      // 25 步 `?guides=1` 重新载入了假后端,22 步排进带的精选段没了 —— 先再排一次,不然下面找不到「片段」镜块。
      if ((await band.locator(".band-segment").filter({ hasText: "片段 " }).count()) === 0) {
        const arrange = p.getByRole("button", { name: "一键排入" }).first();
        if ((await arrange.count()) > 0) {
          await arrange.click();
          await band.locator(".band-segment").filter({ hasText: "片段 " }).first().waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("26-timeline: 一键排入后仍没有精选段镜块"));
        } else failures.push("26-timeline: 找不到「一键排入」");
      }
      const segmentTile = band.locator(".band-segment").filter({ hasText: "片段 " }).first();
      await segmentTile.click();
      await segmentTile.hover();
      for (const name of ["调整入点", "调整出点"]) {
        if ((await segmentTile.getByRole("button", { name }).count()) !== 1) failures.push(`26-timeline: 精选段镜块缺「${name}」`);
      }
      await band.locator(".band-playhead").waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("26-timeline: 选中带上素材后没有播放头"));
      const text = await band.innerText();
      if (/tick|VFR|remux|sidecar|L1|L3/.test(text)) failures.push("26-timeline: 镜头带出现内部术语");
    },
    settle: 600,
  });

  // R13 §5 主题:设置 → 外观「主题」四段,第四段「剪映风格深色」→ html[data-theme="jianying-dark"];关掉 sheet 截整个工作台。
  await shot(page, "27-jianying-dark", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog", { name: "设置" }); // 新手引导气泡也是 dialog,不能 first()
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      // R13 车道 A 把设置改成剪映式六块,主题在「播放与导出」而不是首块。
      await dialog.getByRole("tab", { name: /^播放与导出/ }).click();
      const themes = await dialog.locator(".settings-sheet-segmented").first().getByRole("button").allInnerTexts();
      if (themes.join("|") !== "跟随系统|浅色|深色|剪映风格深色") failures.push(`27-jianying-dark: 主题分段 ${themes.join("|")}`);
      await dialog.getByRole("button", { name: "剪映风格深色", exact: true }).click();
      await p.waitForFunction(() => document.documentElement.dataset.theme === "jianying-dark", null, { timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("27-jianying-dark: html[data-theme] 没变成 jianying-dark"));
      await p.keyboard.press("Escape");
      await p.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
      const bg = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
      if (bg !== "#2fd6c4") failures.push(`27-jianying-dark: --accent 是 ${bg},不是剪映风格深色的青绿`);
    },
    settle: 800,
  });

  // R14 车道 B(§9 B):交付抽屉的「剪映素材包」模式。四枚 chip 顺序「剪映草稿 / 剪映素材包 / 导出片段 / 完整交付包」;
  // 面板一句话 + 按镜头带顺序编号的清单(NN_章名_素材名.mp4)+ 页脚「导出到 …」/ 主按钮「导出素材包」;文案无内部术语。
  // 重新载入让主题回浅色、镜头带回到假后端初始状态。
  await page.goto(viteUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await shot(page, "28-jianying-kit", {
    locate: (p) => p.getByRole("button", { name: "第 4 步 导出", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog", { name: "导出" });
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      const chips = await dialog.getByRole("group", { name: "导出方式" }).getByRole("button").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
      if (chips.join("|") !== "剪映草稿|剪映素材包|导出片段|完整交付包") failures.push(`28-jianying-kit: chip 顺序 ${chips.join("|")}`);
      await dialog.getByRole("button", { name: "剪映素材包", exact: true }).click();
      await dialog.getByText("按镜头带顺序编号导出,拖进剪映时间线就是这个顺序").waitFor({ timeout: STEP_TIMEOUT_MS });
      const list = dialog.getByRole("list", { name: "将导出的文件" });
      await list.waitFor({ timeout: STEP_TIMEOUT_MS });
      const names = await list.getByRole("listitem").allInnerTexts();
      if (names.length === 0) failures.push("28-jianying-kit: 清单为空");
      names.forEach((name, index) => {
        if (!name.trim().startsWith(`${String(index + 1).padStart(2, "0")}_`)) failures.push(`28-jianying-kit: 第 ${index + 1} 项编号不对: ${name}`);
        if (!/^\d{2,}_[^_]+_.+\.mp4$/.test(name.trim())) failures.push(`28-jianying-kit: 文件名不是 NN_章名_素材名.mp4: ${name}`);
      });
      if ((await dialog.getByRole("button", { name: /^导出剪映素材包/ }).count()) === 0) failures.push("28-jianying-kit: button missing: 导出剪映素材包…");
      if ((await dialog.getByRole("button", { name: "更改文件夹", exact: true }).count()) === 0) failures.push("28-jianying-kit: button missing: 更改文件夹");
      if ((await dialog.getByText("本次交付平台").count()) > 0) failures.push("28-jianying-kit: 素材包模式里出现了「本次交付平台」");
      const text = await dialog.innerText();
      if (/remux|H\.264|tick|VFR|sidecar/i.test(text)) failures.push("28-jianying-kit: 素材包文案出现内部术语");
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");

  // R16 车道 B(§1 / §2 P1-3、P2-1):章头「···」→ 菜单「章操作 · <章名>」四项顺序冻结(重命名 · 并入上一章 · 这章够了 · 删除这一章…);
  // 第 1 章的「并入上一章」禁用;「重命名」进内联输入框「章节名」(Esc 取消,不用 window.prompt)。菜单开着时截图。
  await shot(page, "30-chapter-menu", {
    locate: (p) => p.getByRole("region", { name: "镜头带" }).getByRole("button", { name: /^章操作 · / }),
    act: async (more, p) => {
      await p.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
      const band = p.getByRole("region", { name: "镜头带" });
      const title = (await more.getAttribute("aria-label")).replace(/^章操作 · /, "");
      await more.click();
      const menu = p.getByRole("menu", { name: `章操作 · ${title}` });
      await menu.waitFor({ timeout: STEP_TIMEOUT_MS });
      const items = await menu.getByRole("menuitem").allInnerTexts();
      if (items.join("|") !== "重命名|并入上一章|这章够了|删除这一章…") failures.push(`30-chapter-menu: 菜单项 ${items.join("|")}`);
      if (!(await menu.getByRole("menuitem", { name: "并入上一章" }).isDisabled())) failures.push("30-chapter-menu: 第 1 章的「并入上一章」没有禁用");
      // 截完菜单再走「重命名」:输入框在章头里出现、预填章名、Esc 收回。
      p.once("dialog", (dialog) => {
        failures.push(`30-chapter-menu: 出现了原生弹窗 ${dialog.type()}`);
        void dialog.dismiss();
      });
      await p.screenshot({ path: join(outDir, "30-chapter-menu-open.png"), fullPage: false });
      await menu.getByRole("menuitem", { name: "重命名" }).click();
      const input = band.getByRole("textbox", { name: "章节名" });
      await input.waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("30-chapter-menu: 「重命名」后没有出现内联输入框「章节名」"));
      if ((await input.count()) > 0 && (await input.inputValue()) !== title) failures.push(`30-chapter-menu: 输入框预填 ${await input.inputValue()},不是 ${title}`);
    },
    settle: 500,
  });
  await page.keyboard.press("Escape");

  // R16 §1 车道 A:实体菜单。素材卡右键菜单(媒体池 / 检查器头部「···」同一张表)、镜块「···」菜单、
  // 「移除素材…」的后果预览确认卡(alertdialog,复用导入页那张)。截图停在三张菜单都开过、确认卡开着的一刻。
  await shot(page, "29-entity-menus", {
    locate: (p) => p.getByRole("region", { name: "媒体池" }).getByRole("gridcell"),
    act: async (cell, p) => {
      await cell.click();
      await cell.click({ button: "right" });
      const poolMenu = p.getByRole("menu", { name: "素材操作" });
      await poolMenu.waitFor({ timeout: STEP_TIMEOUT_MS });
      const poolItems = await poolMenu.getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
      if (poolItems.join("|") !== "收藏|拒绝|清除评级|加入镜头带|移到其他集|导出所选|在 Finder 中显示|移除素材") failures.push(`29-entity-menus: 媒体池菜单 ${poolItems.join("|")}`);
      await p.keyboard.press("Escape");
      await poolMenu.waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS });

      // 检查器头部「···」:同一张表。
      const inspector = p.getByRole("region", { name: "检查器" });
      const more = inspector.getByRole("button", { name: "更多" }).first();
      if ((await more.count()) === 0) failures.push("29-entity-menus: 检查器头部缺「更多」");
      else {
        await more.click();
        const items = await p.getByRole("menu", { name: "素材操作" }).getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
        if (items.join("|") !== poolItems.join("|")) failures.push(`29-entity-menus: 检查器菜单与媒体池不一致 ${items.join("|")}`);
        await p.keyboard.press("Escape");
      }

      // 镜块「···」:往前 · 往后 · 从镜头带移出 · 删除精选段 · 导出这一段。
      const band = p.getByRole("region", { name: "镜头带" });
      const shotCell = band.getByRole("gridcell", { name: /^镜头 \d+：/ }).first();
      if ((await shotCell.count()) === 0) failures.push("29-entity-menus: 镜头带上没有镜块");
      else {
        await shotCell.click();
        await shotCell.getByRole("button", { name: "更多" }).click();
        const shotMenu = p.getByRole("menu", { name: "镜块操作" });
        await shotMenu.waitFor({ timeout: STEP_TIMEOUT_MS });
        const items = await shotMenu.getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
        if (items.join("|") !== "往前|往后|从镜头带移出|删除精选段|导出这一段") failures.push(`29-entity-menus: 镜块菜单 ${items.join("|")}`);
        await p.keyboard.press("Escape");
        await shotMenu.waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS });
      }

      // 「移除素材…」→ 后果预览确认卡(不确认)。
      await cell.click({ button: "right" });
      await p.getByRole("menu", { name: "素材操作" }).getByRole("menuitem", { name: "移除素材" }).click();
      const confirm = p.getByRole("alertdialog", { name: "确认移除素材" });
      await confirm.waitFor({ timeout: STEP_TIMEOUT_MS });
      const text = await confirm.innerText();
      if (!/将移除 \d+ 条素材、\d+ 条评分记录、\d+ 个精选段/.test(text)) failures.push(`29-entity-menus: 确认卡缺后果数字: ${text.replace(/\n/g, " | ")}`);
      if ((await confirm.getByRole("button", { name: "确认移除，保留原视频" }).count()) !== 1) failures.push("29-entity-menus: 确认卡缺主按钮");
      if (/tick|VFR|remux|sidecar|L1|L3|hero|Stack/.test(text)) failures.push("29-entity-menus: 确认卡出现内部术语");
    },
    settle: 500,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("29-entity-menus: Esc 没关掉确认卡"));
  // R16 车道 C(P1-7):缺失素材页每条「找到它…」——点第一条,假后端把它从清单里拿掉并报「已找到」。
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  await shot(page, "31-missing-relink", {
    locate: (p) => p.getByRole("button", { name: "导入素材", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog").first();
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      await dialog.getByRole("tab", { name: "缺失素材" }).click();
      const finders = dialog.getByRole("button", { name: /^找到 / });
      const before = await finders.count();
      if (before < 2) failures.push(`31-missing-relink: 缺失页每条应有「找到它…」,只见 ${before}`);
      await finders.first().click();
      await dialog.getByText(/已找到/).waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await finders.count()) !== before - 1) failures.push("31-missing-relink: 找到后那条没从清单里消失");
      const text = await dialog.innerText();
      if (/relink|uuid|rel_path/i.test(text)) failures.push("31-missing-relink: 缺失页文案出现内部术语");
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");

  // R17 车道 B:应用内自动升级。`?update=ask` = 假后端有 0.8.0 且用户勾了「先问我再下载」;启动 30 秒的
  // 延迟用 Playwright 时钟拨过去。硬断言:toast 是 role=status、三枚按钮名一字不差、不是 aria-modal、
  // 素材网格仍可点(不打断);「现在更新」后状态条出现「正在下载更新 nn%」;下完出「更新已下载」toast。
  await page.clock.install();
  await page.goto(`${viteUrl}?update=ask`, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(800);
  await page.clock.runFor(31_000);
  await shot(page, "32-update-toast", {
    locate: (p) => p.getByRole("status").filter({ hasText: "有新版本 0.8.0" }),
    act: async (toast, p) => {
      // 业主:顶栏最右、齿轮旁要有「新版本」提醒,可点。
      const topbar = p.getByRole("banner");
      if ((await topbar.getByRole("button", { name: "新版本 0.8.0" }).count()) !== 1) failures.push("32-update-toast: 顶栏没有「新版本 0.8.0」提醒");
      if ((await toast.getAttribute("aria-modal")) !== null) failures.push("32-update-toast: 提示不该是 aria-modal");
      const buttons = await toast.getByRole("button").allInnerTexts();
      if (buttons.join("|") !== "现在更新|稍后|跳过这个版本|") failures.push(`32-update-toast: 按钮 ${buttons.join("|")}`);
      if ((await p.getByRole("dialog").count()) !== 0) failures.push("32-update-toast: 更新提示不该带 dialog");
      const text = await toast.innerText();
      if (/tauri|updater|minisign|signature|json/i.test(text)) failures.push("32-update-toast: 出现内部术语");
      // 不打断:提示在的时候素材照样能选。
      await p.getByRole("gridcell").nth(1).click();
    },
    settle: 500,
  });
  await page.getByRole("status").filter({ hasText: "有新版本 0.8.0" }).getByRole("button", { name: "现在更新" }).click();
  await shot(page, "32-update-downloading", {
    locate: (p) => p.getByRole("status", { name: "后台状态" }).getByText(/正在下载更新 \d+%/),
    settle: 200,
  });
  await shot(page, "32-update-ready", {
    locate: (p) => p.getByRole("status").filter({ hasText: "更新已下载 0.8.0" }),
    act: async (toast, p) => {
      const buttons = await toast.getByRole("button").allInnerTexts();
      if (buttons.join("|") !== "重启完成更新|稍后|跳过这个版本|") failures.push(`32-update-ready: 按钮 ${buttons.join("|")}`);
      if ((await p.getByRole("banner").getByRole("button", { name: "重启完成更新" }).count()) !== 1) failures.push("32-update-ready: 顶栏没有「重启完成更新」");
    },
    settle: 400,
  });
  await page.getByRole("status").filter({ hasText: "更新已下载 0.8.0" }).getByRole("button", { name: "稍后" }).click();
  // 设置 › 关于:「自动更新」开关(默认开)、「有新版本时先问我再下载」、「检查更新」、版本与上次检查、「查看更新说明」。
  await shot(page, "33-update-settings", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog", { name: "设置" });
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      await dialog.getByRole("tab", { name: /^关于/ }).click();
      const toggle = dialog.getByRole("switch", { name: "自动更新" });
      await toggle.waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await toggle.getAttribute("aria-checked")) !== "true") failures.push("33-update-settings: 「自动更新」默认没开");
      if ((await dialog.getByRole("checkbox", { name: "有新版本时先问我再下载" }).count()) !== 1) failures.push("33-update-settings: 缺「有新版本时先问我再下载」");
      if ((await dialog.getByRole("button", { name: "检查更新" }).count()) !== 1) failures.push("33-update-settings: 缺「检查更新」");
      if ((await dialog.getByRole("button", { name: "重启完成更新" }).count()) !== 1) failures.push("33-update-settings: 下完后关于分区没有「重启完成更新」");
      if ((await dialog.getByText(/当前版本 .+ · (上次检查 |还没检查过更新)/).count()) !== 1) failures.push("33-update-settings: 缺「当前版本 · 上次检查」");
      await dialog.getByRole("button", { name: "查看更新说明" }).click();
      const notes = await dialog.locator(".update-r17-notes").innerText().catch(() => "");
      if (!notes.includes("素材可以跨集移动了") || /[#*[\]]/.test(notes)) failures.push(`33-update-settings: 更新说明没展成纯文本: ${notes.slice(0, 80)}`);
    },
    settle: 600,
  });
  await page.keyboard.press("Escape");

  // R17 车道 epmove:素材菜单「移到其他集…」→ 目标集菜单「选择目标集」(集名 · 进度 · 素材数,当前集灰)。
  // 上一段装了 Playwright 时钟,这里开一页干净的;硬断言:菜单项 AX 名、当前集那行禁用、选中后 toast
  // 带「撤销」且撤销后那条回到池里。
  {
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(STEP_TIMEOUT_MS);
    await fresh.goto(viteUrl, { waitUntil: "domcontentloaded" });
    await fresh.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    let movedName = "";
    await shot(fresh, "34-move-to-episode", {
      locate: (p) => p.getByRole("region", { name: "媒体池" }).getByRole("gridcell"),
      act: async (cell, p) => {
        movedName = (await cell.getAttribute("aria-label")) ?? "";
        await cell.click();
        await cell.click({ button: "right" });
        const poolMenu = p.getByRole("menu", { name: "素材操作" });
        await poolMenu.waitFor({ timeout: STEP_TIMEOUT_MS });
        const item = poolMenu.getByRole("menuitem", { name: "移到其他集" });
        if ((await item.count()) !== 1) failures.push("34-move-to-episode: 素材菜单缺「移到其他集」");
        if (await item.isDisabled()) failures.push("34-move-to-episode: 假后端有两集,「移到其他集」却是禁用的");
        await item.click();
        const picker = p.getByRole("menu", { name: "选择目标集" });
        await picker.waitFor({ timeout: STEP_TIMEOUT_MS });
        const rows = await picker.getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => `${node.textContent}${node.disabled ? "(禁用)" : ""}`));
        if (rows.length < 2) failures.push(`34-move-to-episode: 目标集菜单只有 ${rows.length} 行: ${rows.join("|")}`);
        if (!rows.some((row) => row.includes("当前集") && row.endsWith("(禁用)"))) failures.push(`34-move-to-episode: 当前集那一行没有灰掉: ${rows.join("|")}`);
        if (!rows.some((row) => /第 \d 步|还没开始/.test(row) && / \d+ 条素材/.test(row))) failures.push(`34-move-to-episode: 目标行缺进度 / 素材数: ${rows.join("|")}`);
        if (rows.some((row) => /tick|VFR|remux|sidecar|L1|L3|hero|Stack/.test(row))) failures.push("34-move-to-episode: 目标集菜单出现内部术语");
      },
      settle: 500,
    });
    // 选中即移动:toast「已把 1 条移到「…」」+「撤销」;撤销后那条回到池里。
    const target = fresh.getByRole("menu", { name: "选择目标集" }).locator("[role='menuitem']:not([disabled])").first();
    await target.click().catch(() => failures.push("34-move-to-episode: 目标集菜单没有可点的行"));
    const toast = fresh.getByRole("status").filter({ hasText: /已把 1 条移到「.+」/ });
    await toast.waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("34-move-to-episode: 移动后没有「已把 1 条移到「集名」」toast"));
    if ((await toast.count()) > 0) {
      const gone = fresh.getByRole("region", { name: "媒体池" }).getByRole("gridcell", { name: movedName, exact: true });
      if ((await gone.count()) !== 0) failures.push(`34-move-to-episode: 移走的「${movedName}」还留在媒体池里`);
      await toast.getByRole("button", { name: "撤销" }).click().catch(() => failures.push("34-move-to-episode: toast 缺「撤销」"));
      await gone.waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => failures.push(`34-move-to-episode: 撤销后「${movedName}」没有回到媒体池`));
    }
    await fresh.close();
  }
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
      await page.getByRole("dialog", { name: "导出" }).waitFor({ timeout: STEP_TIMEOUT_MS });
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
