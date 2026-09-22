#!/usr/bin/env node
// 导演台工作区的无头截图装置:起一个 `vite --mode mock`(假 Tauri 后端,见
// src/devMock/),用 Playwright 的无头 Chromium 打开工作区,按固定剧本截 10 张图
// + 一份 AX 树,写到 qa/preview/<时间戳>/。不需要 Tauri、不需要 mpv、不需要
// macOS 录屏权限——控制端拿到的是像素,而不是"测试通过"四个字。
//
// 用法: node scripts/qa/preview-shots.mjs [--out <目录>] [--keep-server] [--kit | --kit-only] [--theme light|dark]
//   --kit       工作区剧本之后再开 kit.html(套件 kitchen-sink),多截 10-kit / 11-kit-hover / 12-kit-drawer
//   --kit-only  跳过工作区剧本,只截套件(npm run preview:kit)
//   --theme     整套剧本在这个主题下跑(假后端 devMock/fixture.ts 读 URL 的 ?theme= 预置
//               appearance.theme,R19 车道 tokens · V-12);省略时走假后端默认(system)。
// 任一预期元素找不到即非零退出(截图仍尽量落盘,方便看"错在哪一步")。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { scrubberScenario } from "./scrubber-scenario.mjs";
import { photoScenario } from "./photo-scenario.mjs";
import { duelScenario } from "./duel-scenario.mjs";
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

// R18 车道 V1(V-26):业主真机是 2x,1x 截图看不出描边毛刺。默认跑两遍剧本——
// 一遍 deviceScaleFactor 1(文件名不变,向后兼容),一遍 deviceScaleFactor 2
// (文件名统一加 @2x 后缀)。`--dpr 1` 可以只跑 1x(旧行为,调试单张时更快)。
const DPR_ARG = argument("--dpr");
const DPR_PASSES = DPR_ARG ? [{ scale: Number(DPR_ARG), suffix: Number(DPR_ARG) === 1 ? "" : "@2x" }] : [
  { scale: 1, suffix: "" },
  { scale: 2, suffix: "@2x" },
];
/** 当前这一遍剧本的文件名后缀(""或"@2x"),由 main() 在每一遍开始时切换。 */
let dprSuffix = "";
/** 所有截图文件名都从这里过一遍,保证 1x/2x 两份不会互相覆盖。 */
const outFile = (name) => join(outDir, `${name}${dprSuffix}.png`);

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1280, height: 800 };
// R10 U-10:中栏被压到它的最小 520px。<1040 时媒体池折成 44px 竖条;R19 起检查器是中栏内的滑出层,
// 不再占横向空间,570 − 44 − 6 = 520。
const MONITOR_NARROW = { width: 570, height: 800 };
const STEP_TIMEOUT_MS = 15_000;
const KIT_ONLY = process.argv.includes("--kit-only");
// R19 车道 tokens · V-12:`--theme dark`(或 light)让整套剧本从第一次 goto 起就带着
// ?theme=<值>,devMock/fixture.ts 读它预置 appearance.theme——不是逐张截图后再点设置切主题,
// 是从假后端启动那一刻就在那个主题下。withTheme() 只负责把这个查询参数接到已经拼好的 URL
// 后面(?或 & 视原 URL 是否已带查询串而定),不改任何一步剧本原有的断言。
const THEME_ARG = argument("--theme");
function withTheme(url) {
  if (!THEME_ARG) return url;
  return url.includes("?") ? `${url}&theme=${THEME_ARG}` : `${url}?theme=${THEME_ARG}`;
}
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

/**
 * R19 shell · V-01「一屏一颗实心主按钮」:每张截图落盘时数一遍可见的 .ui-button--primary。
 * 模态(aria-modal 的 dialog / alertdialog)开着时只数最上面那一层 —— 它盖住了壳,壳上那颗不算同屏。
 * 0.9.1 现状:02-selected 同屏 4 颗(下一步 / 保存片段 / 一键排入 / 导入剪映继续剪)。
 */
async function assertSinglePrimary(page, name) {
  const found = await page.evaluate(() => {
    const visible = (node) => {
      if (node.hidden || node.closest("[hidden]") || node.closest("[inert]")) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const modals = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')].filter(visible);
    const scope = modals.length > 0 ? modals[modals.length - 1] : document;
    const label = (node) => (node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 24);
    const byClass = [...scope.querySelectorAll(".ui-button--primary:not([hidden])")].filter(visible).map(label);
    // 按像素再数一遍:类名不是 primary 但被旧 CSS 填成强调色的按钮(0.9.1 的「生成候选」就是),类名检测看不见。
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const probe = document.createElement("span");
    probe.style.color = accent;
    document.body.append(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    // 只数「按钮形状」的:开关(role=switch)与镜块上的细把手(调整入点 / 出点,宽 < 40)本来就是强调色控件,不是主按钮。
    const buttonLike = (node) => {
      const rect = node.getBoundingClientRect();
      return node.getAttribute("role") !== "switch" && rect.width >= 40 && rect.height >= 20;
    };
    const byPixel = [...scope.querySelectorAll("button:not([hidden])")].filter(visible).filter(buttonLike).filter((node) => getComputedStyle(node).backgroundColor === accentRgb).map(label);
    return { byClass, byPixel };
  });
  if (found.byClass.length > 1) failures.push(`V-01 ${name}: 同屏 ${found.byClass.length} 颗实心主按钮: ${found.byClass.join(" | ")}`);
  if (found.byPixel.length > 1) failures.push(`V-01 ${name}: 按像素数到 ${found.byPixel.length} 颗强调色实心按钮: ${found.byPixel.join(" | ")}`);
  return Math.max(found.byClass.length, found.byPixel.length);
}

/** 每一步:找元素(找不到 = 记失败但继续),做动作,等一拍,截图。 */
async function shot(page, name, { locate, act, settle = 400 } = {}) {
  const file = outFile(name);
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
    const primaries = await assertSinglePrimary(page, name);
    log(`PASS ${name} → ${file} (primary ×${primaries})`);
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
  // R19 P-05:01–09 描述的是「显示全部功能」打开后的形态(04 要点检查器的「技术检查」段);默认态(开关关)在 18 / 19b。
  await page.goto(withTheme(`${viteUrl}?showall=1`), { waitUntil: "domcontentloaded" });
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
  // R19 shell · V-03:镜头带通栏 —— 1440 下 region「镜头带」的 clientWidth ≥ 1380(0.9.1 是 ~740,被池与检查器夹着)。
  {
    const bandWidth = await page.getByRole("region", { name: "镜头带" }).evaluate((node) => node.clientWidth);
    if (bandWidth < 1380) failures.push(`V-03: 镜头带 clientWidth ${bandWidth} < 1380 at 1440`);
    log(`V-03 band clientWidth at 1440: ${bandWidth}`);
    // R19 shell · V-02:顶部只有一行 —— 窗顶到媒体池标题条 = 44px(0.9.1 是 76:顶栏 44 + 步骤提示 32)。
    const chromeTop = (await page.getByRole("region", { name: "媒体池" }).locator(".workspace-pane-chrome").first().boundingBox())?.y ?? -1;
    if (Math.round(chromeTop) !== 44) failures.push(`V-02: 顶部到媒体池标题条 ${chromeTop}px,应为 44`);
    if ((await page.getByRole("status", { name: /^第 \d 步提示$/ }).count()) > 0) failures.push("V-02: 「第 n 步提示」status 条还在");
    log(`V-02 top → pool chrome: ${chromeTop}px`);
  }

  await shot(page, "02-selected", {
    locate: (p) => p.getByRole("gridcell"),
    act: async (cell, p) => {
      await cell.click();
      // 监视器切到该素材:传输控件出现(假后端 player_open 直接给 ready)。
      await p.getByRole("region", { name: "预览监视器" }).getByRole("button", { name: /播放|暂停/ }).first().waitFor({ timeout: STEP_TIMEOUT_MS });
    },
    settle: 700,
  });

  // R19 V-07:五个附属 tab 收进「附属：{当前} ⌄」触发钮下的浮层,平时不占标题条——
  // 剧本要先展开它才摸得到 tablist(选中一个 tab 就收起,不留浮层盖住下面的镜头带)。
  await page.getByRole("button", { name: /^附属：/ }).click();
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

  // R19 V-07:视图三芯片同样收进「{当前} ⌄」触发钮的浮层。
  await page.getByRole("button", { name: "按章节 ⌄" }).click();
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
  // 选中「仅缺口」后触发钮变成「仅缺口 ⌄」且浮层已收起(选完就收,不常驻盖住镜头带)——切回
  // 「按章节」要先重新展开。
  await page.getByRole("button", { name: "仅缺口 ⌄" }).click();
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
  // R19 U-06/P-04(deliver,接线人补):导出首屏恰好三张大卡(规格 §6「交付」行)+ 「更多方式」。先截首屏再进详情。
  await shot(page, "06a-deliver-cards", {
    locate: (p) => p.getByRole("button", { name: "第 4 步 导出", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog").first();
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      const cards = dialog.getByRole("group", { name: "交付方式" }).locator(".deliver-card");
      await cards.first().waitFor({ timeout: STEP_TIMEOUT_MS });
      const names = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
      if (names.join("|") !== "交给剪映|导出视频文件|整包交付") failures.push(`06a-deliver-cards: 首屏卡片应恰好三张 交给剪映|导出视频文件|整包交付,实际 ${names.join("|")}`);
      if ((await dialog.getByRole("button", { name: "更多方式", exact: true }).count()) !== 1) failures.push("06a-deliver-cards: 首屏缺「更多方式」");
      if ((await dialog.locator(".deliver-mode").count()) !== 0) failures.push("06a-deliver-cards: 首屏不该直接露出四模式 chip");
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);

  await shot(page, "06-deliver-drawer", {
    locate: (p) => p.getByRole("button", { name: "第 4 步 导出", exact: true }), // R12:顶栏按钮迁为「流水线下一步」,开导出抽屉走导航条
    act: async (button, p) => {
      await button.click();
      await p.getByRole("dialog").first().waitFor({ timeout: STEP_TIMEOUT_MS });
      // R19 U-06/P-04:首屏是三卡,「整包交付」直接落完整交付包表单。
      await p.getByRole("button", { name: "整包交付" }).click();
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

  // R19 P-06(models 车道):设置 › 工具与模型 的模型卡三态里的两态(mock:画面理解未装、转写默认档已装)。
  await shot(page, "07b-settings-tools-models", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog").first();
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      await dialog.getByRole("tab", { name: "工具与模型" }).click();
      const clip = dialog.getByRole("group", { name: "画面理解模型" });
      await clip.waitFor({ timeout: STEP_TIMEOUT_MS });
      await clip.scrollIntoViewIfNeeded();
      if ((await clip.getByRole("button", { name: "安装 画面理解模型" }).count()) !== 1) failures.push("07b: 画面理解模型卡缺「安装」");
      if ((await dialog.getByText("组件尚未提供").count()) !== 0) failures.push("07b: 旧文案「组件尚未提供」还在");
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);

  // R20-3 quality 车道(接线 W3):设置 › 工具与模型 › 分析与 AI 在「显示全部功能」下多三行校准 slider
  // (地平线端正 / 局部曝光 / 主体清晰),默认 0.00;默认态(19b)不出现,由 QualityR20.test.tsx 盯。
  await shot(page, "07c-settings-quality-sliders", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog").first();
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      await dialog.getByRole("tab", { name: "工具与模型" }).click();
      const first = dialog.getByRole("slider", { name: "地平线端正" });
      await first.waitFor({ timeout: STEP_TIMEOUT_MS });
      await first.scrollIntoViewIfNeeded();
      for (const name of ["地平线端正", "局部曝光", "主体清晰"]) {
        const slider = dialog.getByRole("slider", { name });
        if ((await slider.count()) !== 1) failures.push(`07c: 缺校准 slider「${name}」`);
        else if (Number(await slider.inputValue()) !== 0) failures.push(`07c: 「${name}」默认值不是 0`);
      }
      if ((await dialog.getByText(/标定后生效/).count()) !== 3) failures.push("07c: 三行说明「标定后生效」不齐");
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);

  await page.setViewportSize(NARROW);
  await shot(page, "08-narrow-1280", { settle: 900 });
  // R19 shell · V-11:壳只有一个断点 --bp-compact: 1366px。1280 是紧凑档(顶栏四步折成胶囊、池两列),
  // 1366 起是标准档(四步展开、池三列);1512 是 14" 默认、1920 是外接屏,各截一张。
  {
    const railButtons = () => page.getByRole("navigation", { name: "流水线" }).getByRole("button", { name: /^第 \d 步 / }).count();
    const poolCols = () => page.getByRole("grid", { name: "媒体池" }).getAttribute("aria-colcount");
    if ((await railButtons()) !== 0) failures.push("V-11: 1280 下四步没有折成胶囊");
    if ((await poolCols()) !== "2") failures.push(`V-11: 1280 下媒体池 ${await poolCols()} 列(应为 2)`);
    for (const [name, size] of [["08-compact-1366", { width: 1366, height: 768 }], ["08-standard-1512", { width: 1512, height: 945 }], ["08-wide-1920", { width: 1920, height: 1080 }]]) {
      await page.setViewportSize(size);
      await shot(page, name, { settle: 700 });
      if ((await railButtons()) !== 4) failures.push(`V-11: ${name} 下四步没有展开(${await railButtons()} 颗)`);
      // 标准档不再封顶两列;1920 下池随分栏按比例变宽,可到 4 列。
      if (Number(await poolCols()) < 3) failures.push(`V-11: ${name} 下媒体池 ${await poolCols()} 列(应 ≥ 3)`);
    }
    await page.setViewportSize(NARROW);
    await page.waitForTimeout(400);
  }

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

  // 硬断言:规格 §7 冻结的四个 landmark 与旧壳导航缺席。1280 是最小窗宽。
  // R19 V-04:检查器是滑出层,region 常在(收起时空着);09 步选了空槽位,这一刻它是展开的。
  for (const [role, name] of [["region", "媒体池"], ["region", "预览监视器"], ["region", "检查器"], ["status", "后台状态"]]) {
    const count = await page.getByRole(role, { name }).count();
    if (count === 0) failures.push(`landmark missing: ${role} ${name}`);
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
      // R19 V-04:选中会滑出检查器盖住井右侧;这一步量的是监视器自己的最小宽,先 Esc 收掉它。
      await p.keyboard.press("Escape");
      await p.waitForTimeout(300);
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
  await scrubberScenario(page, shot);
  // R19 V-04(取代 R10 U-04 的折叠走查):检查器是监视器栏内的滑出层。1280 下:选中 → 300ms 内展开;
  // Esc → 收起;中栏(.workspace-center)clientWidth 开合前后相等;📌 钉住 → 常驻、Esc 不收;1512 截一张钉住态。
  {
    const inspector = page.getByRole("region", { name: "检查器" });
    const centerWidth = () => page.locator(".workspace-center").evaluate((node) => node.clientWidth);
    const isOpen = () => inspector.evaluate((node) => node.classList.contains("is-open"));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    await page.getByRole("region", { name: "媒体池" }).getByRole("gridcell").first().click();
    const t0 = Date.now();
    await inspector.locator(".inspector").waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("V-04: 选中后检查器没有展开"));
    const openMs = Date.now() - t0;
    if (openMs > 300) failures.push(`V-04: 选中后 ${openMs}ms 才展开(要求 ≤300)`);
    await page.waitForTimeout(300);
    const widthOpen = await centerWidth();
    const box = await inspector.boundingBox();
    const center = await page.locator(".workspace-center").boundingBox();
    if (!box || !center || Math.abs(box.x + box.width - (center.x + center.width)) > 1) failures.push(`V-04: 滑出层没贴在中栏右缘 (${JSON.stringify(box)} vs ${JSON.stringify(center)})`);
    if (box && box.width < 280) failures.push(`V-04: 滑出层宽 ${box.width} < 280`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if (await isOpen()) failures.push("V-04: Esc 没有收起检查器");
    const widthClosed = await centerWidth();
    if (widthOpen !== widthClosed) failures.push(`V-04: 检查器开合改变了中栏宽度 (${widthOpen} → ${widthClosed})`);
    log(`V-04 center clientWidth open/closed at 1280: ${widthOpen}/${widthClosed}; open in ${openMs}ms`);
    await page.getByRole("region", { name: "媒体池" }).getByRole("gridcell").nth(1).click();
    await inspector.locator(".inspector").waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("V-04: 再次选中后检查器没有展开"));
    await inspector.getByRole("button", { name: "钉住检查器" }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if (!(await isOpen())) failures.push("V-04: 钉住后 Esc 仍把检查器收掉了");
    await page.setViewportSize({ width: 1512, height: 945 });
    await shot(page, "13-inspector-pinned-1512", { settle: 600 });
    const pinnedWidth = (await inspector.boundingBox())?.width ?? 0;
    if (pinnedWidth < 280) failures.push(`V-04: 钉住态检查器宽 ${pinnedWidth} < 280`);
    log(`V-04 pinned inspector width at 1512: ${pinnedWidth}`);
    await inspector.getByRole("button", { name: "钉住检查器" }).click(); // 取消钉住,后面的步骤按默认(滑出)走
  }

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
  await page.goto(withTheme(`${viteUrl}?recovery=1`), { waitUntil: "domcontentloaded" });
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
  await page.goto(withTheme(viteUrl), { waitUntil: "domcontentloaded" });
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
      // R19 V-05:可见只留「建议 1/n」,整句与「按 Enter 采用这段」进 tooltip;热力画在 seek 轨道里。
      await monitor.getByText(/^建议 1\/\d$/).waitFor({ timeout: STEP_TIMEOUT_MS });
      const suggestionTitle = await monitor.locator(".monitor-suggestion").getAttribute("title");
      if (!suggestionTitle || !suggestionTitle.includes("按 Enter 采用这段")) failures.push(`16-heat-strip: 建议 tooltip 缺「按 Enter 采用这段」: ${suggestionTitle}`);
      if ((await monitor.locator(".scrubber-r22-track .monitor-heat").count()) !== 1) failures.push("16-heat-strip: 热力条没有画在 seek 轨道里");
      if ((await monitor.locator(".monitor-heat-row").count()) !== 0) failures.push("16-heat-strip: 假时码热力行还在");
      if ((await monitor.locator(".monitor-well-chips").count()) !== 0) failures.push("16-heat-strip: 井内 chip 还在");
      const controlsChildren = await monitor.locator(".monitor-controls").evaluate((node) => node.children.length);
      if (controlsChildren > 2) failures.push(`16-heat-strip: .monitor-controls 直接子元素 ${controlsChildren} > 2`);
      const wellHeight = (await monitor.locator(".monitor-well").boundingBox())?.height ?? 0;
      if (wellHeight < 420) failures.push(`V-05: 1440×900 井高 ${wellHeight} < 420`);
      log(`V-05 well height at 1440×900: ${wellHeight}`);
      await monitor.getByRole("button", { name: "入点", pressed: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
      const bolts = await p.getByRole("region", { name: "媒体池" }).locator(".pool-card-bolt").count();
      if (bolts === 0) failures.push("16-heat-strip: no 有建议段 bolt badge in the pool");
      await p.getByRole("region", { name: "镜头带" }).getByRole("button", { name: "自动挑选精选段" }).waitFor({ timeout: STEP_TIMEOUT_MS });
      // 热力条与 seek 轨道左缘对齐(容差 6px)。R22 起轨道默认放大到精选段,热力层按全片时间
      // 铺在轨道底下会被左移 —— 先切到「全片」再量,量完切回。
      const scope = monitor.getByRole("button", { name: "切换进度条范围" });
      const zoomed = (await scope.textContent()) === "片段";
      if (zoomed) {
        // 点卡片会让检查器滑出(300 ms),按钮在动画里平移,真鼠标的 pointerdown 与 mouseup 会落在两处 ——
        // 这里只想切状态,直接派发 click 事件(React 的 onClick 就挂在它上)。
        await scope.dispatchEvent("click");
        // 用同一个 locator 轮询(document.querySelector 可能抓到别的监视器实例);切不回去就记失败,别卡在这一步。
        let flipped = false;
        for (let n = 0; n < 30 && !flipped; n++) { await p.waitForTimeout(100); flipped = (await scope.textContent()) === "全片"; }
        if (!flipped) failures.push("16-heat-strip: 「切换进度条范围」点了没切到「全片」");
      }
      const heat = await monitor.locator(".monitor-heat").boundingBox();
      const track = await monitor.locator(".scrubber-r22-track").boundingBox();
      if (heat && track && Math.abs(heat.x - track.x) > 6) failures.push(`16-heat-strip: heat strip x=${heat.x} vs seek track x=${track.x}`);
      if (heat && track && Math.abs(heat.width - track.width) > 6) failures.push(`16-heat-strip: heat strip width=${heat.width} vs seek track width=${track.width}`);
      if (zoomed) await scope.dispatchEvent("click");
    },
    settle: 700,
  });
  // R11 车道 E:快速导出(抽屉默认模式)。看清单 + 引导句 + 「导出」主按钮;硬断言:
  // 快速模式下不出现「本次交付平台」/ 联系表开关,主按钮与「更改文件夹」都在。
  await page.goto(withTheme(viteUrl), { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(WIDE);
  await shot(page, "17-quick-export", {
    locate: (p) => p.getByRole("button", { name: "第 4 步 导出", exact: true }), // R12:顶栏按钮迁为「流水线下一步」,开导出抽屉走导航条
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog").first();
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      // R19 U-06/P-04:首屏是三卡,既有四模式 chip 选择器搬进「更多方式 ⌄」——先展开它,
      // 行为与冻结 AX 名不变(R13 §5:假后端的剪映是白名单版本 → 默认落「剪映草稿」;这一步看快速导出,再切过去)。
      await dialog.getByRole("button", { name: "更多方式", exact: true }).click();
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
  // 「新建一集」(R19 U-03);没有任何 dialog 打开;三栏 inert。
  await page.setViewportSize(WIDE);
  await page.goto(withTheme(`${viteUrl}?empty=1`), { waitUntil: "domcontentloaded" });
  await shot(page, "18-onboarding", {
    locate: (p) => p.getByRole("region", { name: "首页" }),
    act: async (home, p) => {
      if ((await p.getByRole("dialog").count()) > 0) failures.push("18-onboarding: a dialog is open over the home screen");
      const steps = home.getByRole("group", { name: "四步上手" });
      await steps.waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await steps.locator("li").count()) !== 4) failures.push("18-onboarding: expected 4 steps in the home pipeline strip");
      const primaries = await home.locator(".ui-button--primary").count();
      if (primaries !== 1) failures.push(`18-onboarding: ${primaries} primary buttons on home (expected 1)`);
      // R19 U-03:大按钮改「新建一集」;首页 DOM 不含首轮词表。
      if ((await home.getByRole("button", { name: "新建一集", exact: true }).count()) === 0) failures.push("18-onboarding: button missing: 新建一集");
      if (/镜头带|章节|精选段|交付|模板|旅程/.test(await home.innerText())) failures.push("18-onboarding: 首页出现首轮词表里的词");
      if (!(await p.locator(".workspace-columns").evaluate((node) => node.hasAttribute("inert")))) failures.push("18-onboarding: 三栏没有 inert");
      const text = await p.locator("body").innerText();
      if (/FIRST RUN|remux|VFR|sidecar|L1|L3/.test(text)) failures.push("18-onboarding: 空工作区出现内部术语");
    },
    settle: 800,
  });

  // R11 简化专项(车道 simplify):设置页收成 3 个分区 + 每区一个「高级…」折叠。硬断言:tablist「设置分区」
  // R13 §2 起:剪映式六个 tab、没有「高级…」折叠(23-settings-keymap 断言六块顺序);冻结锚点「云端补镜」「隐私与诊断」
  // 以左轨快捷入口常驻。截「播放与导出」分区(导出文件夹在那里)。R19 P-05:六分区是开关打开后的形态(`?showall=1`)。
  await page.goto(withTheme(`${viteUrl}?showall=1`), { waitUntil: "domcontentloaded" });
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

  // R19 P-05(flow 车道):默认态 —— 「显示全部功能」关:设置只剩四块、直达没有「云端补镜」、镜头带附属只剩 故事 / 音乐;
  // 「关于」里那颗开关默认关。硬断言写在 act 里;打开开关后的形态由 19 / 23 覆盖。
  await page.goto(withTheme(viteUrl), { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await shot(page, "19b-settings-basic", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      // R19 V-07(band):tablist 收在「附属：{当前} ⌄」触发钮下的浮层里,先展开再数,数完 Esc 收起(不让浮层盖住设置弹层)。
      await p.getByRole("button", { name: /^附属：/ }).click();
      const bandTabs = await p.getByRole("tablist", { name: "镜头带附属视图" }).getByRole("tab").allInnerTexts();
      if (bandTabs.join("|") !== "故事|音乐") failures.push(`19b-settings-basic: 默认态附属 tab 应只有 故事|音乐,实际 ${bandTabs.join("|")}`);
      await p.keyboard.press("Escape");
      await button.click();
      const dialog = p.getByRole("dialog").first();
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      const tabs = await dialog.getByRole("tablist", { name: "设置分区" }).getByRole("tab").allInnerTexts();
      if (tabs.length !== 4) failures.push(`19b-settings-basic: ${tabs.length} tabs in 设置分区 (expected 4): ${tabs.join(" | ")}`);
      if ((await dialog.getByRole("button", { name: "云端补镜", exact: true }).count()) !== 0) failures.push("19b-settings-basic: 默认态不该有「云端补镜」直达");
      await dialog.getByRole("tab", { name: /^关于/ }).click();
      const toggle = dialog.getByRole("switch", { name: "显示全部功能" });
      await toggle.waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await toggle.getAttribute("aria-checked")) !== "false") failures.push("19b-settings-basic: 「显示全部功能」默认应为关");
    },
    settle: 700,
  });
  await page.keyboard.press("Escape");

  // R12 车道 A(壳):`?analyzed=1` 让所有素材分析完 —— 流水线走到 ②/③/④,顶栏中央的四步导航条
  // 有勾、有计数、恰好一个 aria-current;主按钮 AX 名固定「流水线下一步」,可见文案「下一步:…」。
  await page.goto(withTheme(`${viteUrl}?analyzed=1`), { waitUntil: "domcontentloaded" });
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
  // + 「···」,空章有「这章够了」。硬断言写在 act 里;镜头带底部不再有 .band-toast。R19 P-05:23 的六分区要开关打开(`?showall=1`)。
  await page.goto(withTheme(`${viteUrl}?showall=1`), { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(WIDE);
  await shot(page, "22-band-arranged", {
    locate: (p) => p.getByRole("region", { name: "镜头带" }).getByRole("button", { name: "一键排入" }),
    act: async (button, p) => {
      const band = p.getByRole("region", { name: "镜头带" });
      // R19 V-01:「一键排入」降为 secondary,同屏唯一的实心主按钮是顶栏「下一步」(每张图由 assertSinglePrimary 数)。
      if (await button.evaluate((node) => node.classList.contains("ui-button--primary"))) failures.push("22-band-arranged: 「一键排入」仍是 primary(V-01)");
      await button.click();
      const toast = p.getByRole("status").filter({ hasText: "已排入" });
      await toast.first().waitFor({ timeout: STEP_TIMEOUT_MS });
      if ((await p.locator(".ui-toast").count()) !== 1) failures.push("22-band-arranged: toast 不是恰好一条");
      if ((await toast.first().getByRole("button", { name: "撤销" }).count()) !== 1) failures.push("22-band-arranged: 排入 toast 缺「撤销」");
      const box = await p.locator(".ui-toast").boundingBox();
      const viewport = p.viewportSize();
      if (box && viewport && Math.abs(box.x + box.width / 2 - viewport.width / 2) > 40) failures.push(`22-band-arranged: toast 没有居中(x=${box.x}, w=${box.width})`);
      if ((await band.locator(".band-toast").count()) !== 0) failures.push("22-band-arranged: 镜头带底部仍有旧的 .band-toast 小字");
      // R19 V-06:「片段 a–b s」不再是镜块上常显的文字,挪进了缩略图的 title(tooltip)——
      // 断言跟着改成读那个属性,不再等一段可见文本。
      const segmentTile = band.locator('.band-segment:has(.band-tile-thumb[title*="片段 "])').first();
      await segmentTile.waitFor({ timeout: STEP_TIMEOUT_MS });
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
  // R13 车道 B(§3)→ R19 U-03:首页 —— `?empty=1` 之外也能从顶栏 logo 进(有素材时只从这里进)。看「新建一集」大按钮、
  // 「继续上次」、「最近的集」卡(集名 / 缩略图 / 四步进度)。硬断言:logo 是 button「首页」且按下;list「最近的集」≥1 张、
  // 进行中的集排第一且带四步进度;没有模板区;唯一 primary。
  await page.goto(withTheme(viteUrl), { waitUntil: "domcontentloaded" });
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
      // R19 U-03:模板区撤掉(Wave 2 P-09 做实再回);有素材时多一颗「继续上次」;首页 DOM 不含首轮词表。
      if ((await home.getByRole("group", { name: "从模板开始" }).count()) !== 0) failures.push("24-home: 模板区还在");
      if ((await home.getByRole("button", { name: "继续上次", exact: true }).count()) === 0) failures.push("24-home: button missing: 继续上次");
      const text = await home.innerText();
      if (/tick|VFR|remux|sidecar|L1|L3|hero|Stack/.test(text)) failures.push("24-home: 首页出现内部术语");
      if (/镜头带|章节|精选段|交付|模板|旅程/.test(text)) failures.push("24-home: 首页出现首轮词表里的词");
    },
    settle: 800,
  });
  // 再点 logo 回工作区(不留首页给后面的步骤)。
  await page.getByRole("button", { name: "首页", exact: true }).click();
  await page.getByRole("region", { name: "首页" }).waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);

  // R13 车道 B(§3):功能气泡。`?guides=1` 让假后端不把 guide.*.viewed 预置为 true —— 首次进入工作区先出
  // 「导航条」气泡(dialog「新手引导」,非模态,锚在流水线导航条正下方);「知道了」后选一条有建议的素材 → 「热力条」气泡。
  // 硬断言:同一时刻只有一个「新手引导」dialog;气泡盒子在导航条下方且横向相交;不带 aria-modal。
  await page.goto(withTheme(`${viteUrl}?guides=1`), { waitUntil: "domcontentloaded" });
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
      await bubble.screenshot({ path: outFile("25-guide-bubble-heat") }).catch(() => undefined);
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
      if ((await band.locator(".band-segment").filter({ hasText: /片段 [\d.]+–/ }).count()) === 0) {
        const arrange = p.getByRole("button", { name: "一键排入" }).first();
        if ((await arrange.count()) > 0) {
          await arrange.click();
          await band.locator(".band-segment").filter({ hasText: /片段 [\d.]+–/ }).first().waitFor({ timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("26-timeline: 一键排入后仍没有精选段镜块"));
        } else failures.push("26-timeline: 找不到「一键排入」");
      }
      const segmentTile = band.locator(".band-segment").filter({ hasText: /片段 [\d.]+–/ }).first();
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

  // R19 车道 tokens · Q-3:R13 §5「剪映风格深色」升格为唯一深色,设置 → 外观「主题」收到三段;
  // 选「深色」→ html[data-theme="dark"](不再有单独的 jianying-dark 值);关掉 sheet 截整个工作台。
  await shot(page, "27-dark-theme", {
    locate: (p) => p.getByRole("button", { name: "设置", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog", { name: "设置" }); // 新手引导气泡也是 dialog,不能 first()
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      // R13 车道 A 把设置改成剪映式六块,主题在「播放与导出」而不是首块。
      await dialog.getByRole("tab", { name: /^播放与导出/ }).click();
      const themes = await dialog.locator(".settings-sheet-segmented").first().getByRole("button").allInnerTexts();
      if (themes.join("|") !== "跟随系统|浅色|深色") failures.push(`27-dark-theme: 主题分段 ${themes.join("|")}`);
      await dialog.getByRole("button", { name: "深色", exact: true }).click();
      await p.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("27-dark-theme: html[data-theme] 没变成 dark"));
      await p.keyboard.press("Escape");
      await p.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
      const bg = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
      if (bg !== "#2fd6c4") failures.push(`27-dark-theme: --accent 是 ${bg},不是升格后深色的青绿(原剪映风格深色配色)`);
    },
    settle: 800,
  });

  // R14 车道 B(§9 B):交付抽屉的「剪映素材包」模式。四枚 chip 顺序「剪映草稿 / 剪映素材包 / 导出片段 / 完整交付包」;
  // 面板一句话 + 按镜头带顺序编号的清单(NN_章名_素材名.mp4)+ 页脚「导出到 …」/ 主按钮「导出素材包」;文案无内部术语。
  // 重新载入让主题回浅色、镜头带回到假后端初始状态。
  await page.goto(withTheme(viteUrl), { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await shot(page, "28-jianying-kit", {
    locate: (p) => p.getByRole("button", { name: "第 4 步 导出", exact: true }),
    act: async (button, p) => {
      await button.click();
      const dialog = p.getByRole("dialog", { name: "导出" });
      await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
      // R19 U-06/P-04:首屏是三卡,既有四模式 chip 选择器搬进「更多方式 ⌄」——先展开它,冻结 AX 名与顺序不变。
      await dialog.getByRole("button", { name: "更多方式", exact: true }).click();
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
      await p.screenshot({ path: outFile("30-chapter-menu-open"), fullPage: false });
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
      if (poolItems.join("|") !== "收藏|拒绝|清除评级|加入镜头带|移到其他集|导出所选|在 Finder 中显示|移除素材|擂台") failures.push(`29-entity-menus: 媒体池菜单 ${poolItems.join("|")}`);
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
        if (items.join("|") !== "往前|往后|从镜头带移出|删除精选段|导出这一段|从这段开始连播|擂台") failures.push(`29-entity-menus: 镜块菜单 ${items.join("|")}`);
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
  await page.goto(withTheme(`${viteUrl}?update=ask`), { waitUntil: "domcontentloaded" });
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
    await fresh.goto(withTheme(viteUrl), { waitUntil: "domcontentloaded" });
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

  // R19 results 车道 P-03:自动挑选 → 「为什么是这些」结果面板(镜头带栏内滑出层)。硬断言:
  // list「挑选结果」行数 ≥ 1 且每行理由非空;点「不要这一段」→ 行数 −1;「全部撤销」→ 面板收起;
  // 面板文案不含内部术语。
  {
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(STEP_TIMEOUT_MS);
    await fresh.goto(`${viteUrl}?analyzed=1`, { waitUntil: "domcontentloaded" });
    await fresh.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    const band = fresh.getByRole("region", { name: "镜头带" });
    const rowsOf = (p) => p.getByRole("list", { name: "挑选结果" }).locator(":scope > li");
    await shot(fresh, "35-results-panel", {
      locate: (p) => p.getByRole("region", { name: "镜头带" }).getByRole("button", { name: "自动挑选精选段" }),
      act: async (button, p) => {
        await button.click();
        const panel = p.getByRole("group", { name: "自动挑选精选段" });
        await panel.waitFor({ timeout: STEP_TIMEOUT_MS });
        await panel.getByRole("button", { name: "开始挑选" }).click();
        const results = band.getByRole("group", { name: "为什么是这些" });
        await results.waitFor({ timeout: STEP_TIMEOUT_MS });
        await rowsOf(p).first().waitFor({ timeout: STEP_TIMEOUT_MS });
        const count = await rowsOf(p).count();
        if (count < 1) failures.push("35-results-panel: 结果面板一行都没有");
        // R20-1 起一行可能有两个 .results-row-reason(理由 + 「可修:…」),按行取第一个数。
        const reasons = await rowsOf(p).locator(".results-row-head + .results-row-reason").allInnerTexts();
        if (reasons.length !== count || reasons.some((text) => text.trim().length === 0)) failures.push(`35-results-panel: 有行没有理由: ${reasons.join("|")}`);
        const text = await results.innerText();
        if (/tick|VFR|remux|sidecar|L1|L3|hero|Stack|sharp|motion|no_cut|interest/.test(text)) failures.push("35-results-panel: 结果面板出现内部术语 / 内部键");
        if ((await results.locator("details summary").count()) === 0) failures.push("35-results-panel: 假后端里没有一行带「相似的没选」折叠");
        // R20-1:面板顶部多了「被去重/未选」折叠(details.results-siblings),每行的「还有 N 条相似的没选」是列表里的 details;
        // 两种各展开一个,截图同时看得见「未选:…」与兄弟列表;每行「可修:…」是行内文本,不用点。
        await results.locator("details.results-siblings summary").first().click().catch(() => failures.push("35-results-panel: 缺「被去重/未选」折叠"));
        await results.locator(".results-list details").first().locator("summary").click();
        if (!/可修:/.test(await results.innerText())) failures.push("35-results-panel: 没有一行带「可修:…」");
        if (!/未选:/.test(await results.innerText())) failures.push("35-results-panel: 「被去重/未选」没有条目");
      },
      settle: 600,
    });
    const before = await rowsOf(fresh).count();
    await rowsOf(fresh).first().getByRole("button", { name: /^不要这一段/ }).click().catch(() => failures.push("35-results-panel: 第一行缺「不要这一段」"));
    await fresh.waitForFunction((expected) => document.querySelectorAll("[aria-label='挑选结果'] > li").length === expected, before - 1, { timeout: STEP_TIMEOUT_MS }).catch(() => failures.push(`35-results-panel: 「不要这一段」后行数没有从 ${before} 减 1`));
    await fresh.getByRole("button", { name: "全部撤销" }).click().catch(() => failures.push("35-results-panel: 缺「全部撤销」"));
    await band.getByRole("group", { name: "为什么是这些" }).waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS }).catch(() => failures.push("35-results-panel: 「全部撤销」后面板没有收起"));
    await fresh.close();
  }

  // R19 results 车道 P-01:一句话挑片 —— 面板顶部输入框 → Enter → 结果面板顶部回显原句;段数 ≥ 1、每段理由非空。
  {
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(STEP_TIMEOUT_MS);
    await fresh.goto(`${viteUrl}?analyzed=1`, { waitUntil: "domcontentloaded" });
    await fresh.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    const sentence = "挑 60 秒,风景为主,少人脸,按时间顺序";
    await shot(fresh, "36-prompt-select", {
      locate: (p) => p.getByRole("region", { name: "镜头带" }).getByRole("button", { name: "自动挑选精选段" }),
      act: async (button, p) => {
        await button.click();
        const input = p.getByRole("group", { name: "自动挑选精选段" }).getByRole("textbox", { name: "一句话挑片" });
        await input.waitFor({ timeout: STEP_TIMEOUT_MS });
        const placeholder = await input.getAttribute("placeholder");
        if (!placeholder || !placeholder.includes("例如")) failures.push(`36-prompt-select: 占位文案不对: ${placeholder}`);
        await input.fill(sentence);
        await input.press("Enter");
        const results = p.getByRole("region", { name: "镜头带" }).getByRole("group", { name: "为什么是这些" });
        await results.waitFor({ timeout: STEP_TIMEOUT_MS });
        const rows = p.getByRole("list", { name: "挑选结果" }).locator(":scope > li");
        await rows.first().waitFor({ timeout: STEP_TIMEOUT_MS });
        const summary = await results.locator(".results-summary").innerText();
        if (!summary.includes(sentence)) failures.push(`36-prompt-select: 结果面板没有回显原句: ${summary}`);
        const reasons = await rows.locator(".results-row-reason").allInnerTexts();
        if (reasons.length === 0 || reasons.some((text) => text.trim().length === 0)) failures.push("36-prompt-select: 有行没有理由");
        if ((await results.getByRole("textbox", { name: "一句话挑片" }).count()) !== 1) failures.push("36-prompt-select: 结果面板顶部缺「再挑一次」的输入框");
      },
      settle: 600,
    });
    await fresh.close();
  }

  // R22-B:连播中。独立页,实际入口触发,不伪造 UI 状态。
  {
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(STEP_TIMEOUT_MS);
    await fresh.goto(withTheme(viteUrl), { waitUntil: "domcontentloaded" });
    await shot(fresh, "playthrough-playing", {
      locate: p => p.getByRole("button", { name: "镜头带连播", exact: true }),
      act: async (button, p) => {
        await button.click();
        await p.getByRole("group", { name: "镜头带连播预览" }).waitFor();
        await p.waitForFunction(() => Number(document.querySelector(".playthrough-overlay")?.getAttribute("data-switch-ms")) > 0);
        await p.getByRole("button", { name: "下一段", exact: true }).click();
        await p.getByText(/连播 · 第 2\//).waitFor();
      },
      settle: 500,
    });
    await fresh.close();
  }

  // R21 车道 archive(PH-11):`?archive=1` 让假后端报一条未完成的归档日志,交付抽屉顶部出现
  // 唯一新增的入口「上次交付未完成 · 查看与继续」;三张交付卡照旧在它下面。展开后截:冻结清单、
  // 错误、「继续交付」「撤销复制」两个按钮。
  // 接线 W3:它要重新载入页面(带 ?archive=1),放在主页面剧本中间会把 03 的附属带 / 04 的检查器 /
  // 缺口选中态全部复位,07–14 对不上基线 —— 改到剧本末尾开一页干净的,与 34–36 同一做法。
  {
    const archivePage = await context.newPage();
    archivePage.setDefaultTimeout(STEP_TIMEOUT_MS);
    await archivePage.goto(withTheme(`${viteUrl}?showall=1&archive=1`), { waitUntil: "domcontentloaded" });
    await archivePage.getByRole("region", { name: "媒体池" }).waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    await archivePage.getByRole("gridcell").first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    await shot(archivePage, "06c-deliver-archive-recovery", {
      locate: (p) => p.getByRole("button", { name: "第 4 步 导出", exact: true }),
      act: async (button, p) => {
        await button.click();
        const dialog = p.getByRole("dialog").first();
        await dialog.waitFor({ timeout: STEP_TIMEOUT_MS });
        const summary = dialog.getByText("上次交付未完成 · 查看与继续", { exact: true });
        await summary.waitFor({ timeout: STEP_TIMEOUT_MS });
        const cards = dialog.getByRole("group", { name: "交付方式" }).locator(".deliver-card");
        if ((await cards.count()) !== 3) failures.push(`06c-deliver-archive-recovery: 三张交付卡应仍在,实际 ${await cards.count()}`);
        await summary.click();
        await dialog.getByRole("list", { name: "本次交付文件清单" }).waitFor({ timeout: STEP_TIMEOUT_MS });
        for (const name of ["继续交付", "撤销复制"]) {
          if ((await dialog.getByRole("button", { name, exact: true }).count()) !== 1) failures.push(`06c-deliver-archive-recovery: 缺「${name}」`);
        }
        const text = await dialog.locator(".deliver-archive-recovery").innerText();
        for (const phrase of ["原片始终保留", "只撤销本次创建且未修改的文件", "ENOSPC", "(转换副本)", "(原样复制)"]) {
          if (!text.includes(phrase)) failures.push(`06c-deliver-archive-recovery: 文案缺「${phrase}」`);
        }
      },
      settle: 700,
    });
    await archivePage.close();
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
    for (const pass of DPR_PASSES) {
      dprSuffix = pass.suffix;
      log(`--- pass deviceScaleFactor=${pass.scale}${pass.suffix ? ` (文件名后缀 ${pass.suffix})` : ""} ---`);
      // 分组 chip / 章名按浏览器时区算,假后端夹具是 +08:00 的钟面:钉在东八区,基线才不随拍图机器的时区漂。
      const context = await browser.newContext({ viewport: WIDE, deviceScaleFactor: pass.scale, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          consoleErrors.push(`[${message.type()}] ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      page.setDefaultTimeout(STEP_TIMEOUT_MS);

      if (!KIT_ONLY) {
        if (!process.argv.includes("--photo-only")) await workspaceScript(page, context, vite.url);
        await photoScenario(context, vite.url, shot, failures, withTheme);
        await duelScenario(context, vite.url, shot, failures, withTheme);
      }

      if (WITH_KIT) {
        await page.setViewportSize(WIDE);
        await page.goto(`${vite.url}kit.html`, { waitUntil: "domcontentloaded" });
        await page.getByRole("region", { name: "按钮" }).waitFor({ timeout: STEP_TIMEOUT_MS });
        await page.waitForTimeout(400);
        const file = outFile("10-kit");
        await page.screenshot({ path: file, fullPage: true });
        log(`PASS 10-kit → ${file}`);
        // hover 态:把鼠标停在第一个 secondary 按钮上再截一张局部
        const hover = page.getByRole("region", { name: "按钮" }).getByRole("button").nth(1);
        await hover.hover();
        await page.waitForTimeout(200);
        await page.getByRole("region", { name: "按钮" }).screenshot({ path: outFile("11-kit-hover") });
        log(`PASS 11-kit-hover → ${outFile("11-kit-hover")}`);
        // 真实抽屉:打开右侧抽屉(表单语法 + 标题栏 actions)截一张视窗图,Esc 关掉。
        await page.getByRole("button", { name: "打开右侧抽屉" }).click();
        await page.getByRole("dialog", { name: "导出" }).waitFor({ timeout: STEP_TIMEOUT_MS });
        await page.waitForTimeout(300);
        await page.screenshot({ path: outFile("12-kit-drawer"), fullPage: false });
        log(`PASS 12-kit-drawer → ${outFile("12-kit-drawer")}`);
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
        if ((await page.getByRole("dialog").count()) > 0) failures.push("kit: Esc did not close the drawer");
      }

      await context.close();
    }
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
