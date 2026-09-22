#!/usr/bin/env node
// 给假后端(vite --mode mock)生成 60 张封面占位图:每张一种颜色 + 文件名文字,
// 写到 qa/mock-covers/NN.jpg(不入库)。用 Playwright 的无头 Chromium 渲染——
// 本机 ffmpeg 没编 drawtext,node-canvas 也没装,而截图装置本来就要 Chromium。
// 用法: node scripts/qa/make-mock-covers.mjs [--force]
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "../..");
const outDir = join(repoRoot, "qa/mock-covers");
const force = process.argv.includes("--force");
export const COVER_COUNT = 60;

// 与 src/devMock/fixture.ts 的 DAYS/SUBJECTS 同一份表、同一套编号规则(改一处要改两处),
// 这样封面上的字与媒体池卡片下方的文件名对得上,人眼一扫就知道哪张是哪张。
const DAYS = [
  { date: "0812", perDay: 12, subjects: ["昆明长水机场_出发", "高速_苍山远景", "房车_加水", "下关_落日", "房车_夜宿"] },
  { date: "0813", perDay: 16, subjects: ["大理古城_清晨街景", "洱海_环湖骑行", "喜洲_扎染院子", "洱海_日出航拍", "双廊_咖啡馆", "才村码头_晚霞"] },
  { date: "0814", perDay: 16, subjects: ["沙溪_寺登街", "沙溪_玉津桥", "沙溪_周五集市", "沙溪_古戏台", "沙溪_稻田日落", "沙溪_民宿早餐"] },
  { date: "0815", perDay: 16, subjects: ["丽江_古城夜色", "丽江_玉龙雪山", "束河_石板路", "丽江_四方街_打跳", "丽江_民宿露台", "返程_收拾房车"] },
];

function labelFor(index) {
  if (index === 59) return "MiniMax · 洱海_日出航拍_建立镜头";
  if (index === 60) return "MiniMax · 沙溪_稻田_转场";
  let id = 0;
  for (const day of DAYS) {
    for (let n = 0; n < day.perDay; n += 1) {
      id += 1;
      if (id === index) return `${day.date} ${day.subjects[n % day.subjects.length]} ${String(Math.floor(n / day.subjects.length) + 1).padStart(2, "0")}`;
    }
  }
  return String(index);
}

function colourFor(index) {
  const hue = (index * 137.508) % 360; // 黄金角,相邻编号颜色差得开
  const generated = index >= 59;
  return { bg: `hsl(${hue} ${generated ? 20 : 45}% ${generated ? 30 : 38}%)`, fg: "rgba(255,255,255,0.92)" };
}

export async function makeMockCovers({ chromium } = require("playwright-core")) {
  mkdirSync(outDir, { recursive: true });
  // 300 band segments reuse these 60 source images. Count the actual expected
  // names: sixty unrelated jpg files must not silently skip fixture creation.
  const existing = Array.from({ length: COVER_COUNT }, (_, i) => `${String(i + 1).padStart(2, "0")}.jpg`)
    .filter(name => existsSync(join(outDir, name))).length;
  if (existing >= COVER_COUNT && !force) {
    return { outDir, generated: 0, existing };
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
    for (let index = 1; index <= COVER_COUNT; index += 1) {
      const { bg, fg } = colourFor(index);
      const label = labelFor(index);
      await page.setContent(`<!doctype html><html><body style="margin:0;background:${bg};width:320px;height:180px;
        font:600 18px -apple-system,'PingFang SC','Hiragino Sans GB',sans-serif;color:${fg};display:flex;flex-direction:column;
        justify-content:space-between;padding:12px;box-sizing:border-box">
        <div style="font-size:34px;font-weight:800;opacity:.85">${String(index).padStart(2, "0")}</div>
        <div style="font-size:15px;line-height:1.3;word-break:break-all">${label}</div>
        <div style="position:absolute;right:10px;top:10px;font-size:11px;letter-spacing:.08em;opacity:.7">${index >= 59 ? "AI" : "MOCK"}</div>
      </body></html>`);
      await page.screenshot({ path: join(outDir, `${String(index).padStart(2, "0")}.jpg`), type: "jpeg", quality: 70 });
    }
  } finally {
    await browser.close();
  }
  return { outDir, generated: COVER_COUNT, existing };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  makeMockCovers().then((result) => {
    console.log(result.generated > 0 ? `generated ${result.generated} covers → ${result.outDir}` : `covers already present (${result.existing}) → ${result.outDir}`);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
