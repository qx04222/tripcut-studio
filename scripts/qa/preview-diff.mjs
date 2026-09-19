#!/usr/bin/env node
// R19 车道 tokens · V-12:深色主题 @2x 全剧本截图与入库基线(qa/preview-baseline/)的像素差异
// 门禁。默认自己跑一遍 `preview-shots.mjs --theme dark --dpr 2` 到临时目录,再和基线逐张比对。
// report-only(与 bench 同策略,R19 E-02/Q-13 同款拍板)——阈值超了只打印,不让调用方变红,
// 除非传 --enforce。基础设施本身跑不出来(截图套件失败、读不到基线目录)照样让它红,那是
// 环境坏了,不是阈值判定。
//
// 不新增依赖(lane-common 纪律,六条车道共用锁文件,谁加了依赖谁的锁文件就和别人对不上):
// 没有引入 pixelmatch/pngjs,PNG 解码用 Node 内置 zlib 手写一份最小 RGB(A) 8-bit 解码器
// (chromium 截图只产这种),diff 算法是逐像素、逐通道算差值之和,过一个小阈值就算"这个像素
// 不同"——没有 pixelmatch 的抗锯齿探测,数字口径更粗,但够用来盯"这次改动是不是把哪张图的
// 配色整个换了"。
//
// 用法: node scripts/qa/preview-diff.mjs [--dir <已有截图目录>] [--baseline <目录>]
//                                        [--threshold <百分比,默认 0.5>] [--enforce]
//   --dir       省略时自己起一遍 preview-shots.mjs --theme dark --dpr 2 到临时目录
//   --baseline  省略时用 qa/preview-baseline/
//   --enforce   有文件超阈值或本次截图缺文件时 exit 1;省略时只打印,exit 0
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const repoRoot = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const ENFORCE = args.includes("--enforce");
const THRESHOLD_PCT = Number(flagValue("--threshold", "0.5"));
const BASELINE_DIR = resolve(flagValue("--baseline", join(repoRoot, "qa/preview-baseline")));
const DIR_ARG = flagValue("--dir", null);

/** 最小 PNG 解码器:只认 8-bit RGB(colorType 2)/ RGBA(colorType 6),chromium 截图只产这两种。 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG(签名不对)");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 8 + length + 4; // data + CRC
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`这份最小解码器只认 8-bit RGB(A)(读到 bitDepth=${bitDepth} colorType=${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  let prevLine = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const line = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const outLine = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? outLine[x - channels] : 0;
      const b = prevLine[x];
      const c = x >= channels ? prevLine[x - channels] : 0;
      let predictor;
      switch (filterType) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = a;
          break;
        case 2:
          predictor = b;
          break;
        case 3:
          predictor = Math.floor((a + b) / 2);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`不认识的 PNG 滤波类型 ${filterType}`);
      }
      outLine[x] = (line[x] + predictor) & 0xff;
    }
    prevLine = outLine;
  }
  return { width, height, channels, pixels };
}

/** 每通道差值之和 > 每通道 24(约 10%)才算这个像素"不同"——躲开截图链路本身的量化抖动。 */
function diffPercent(current, baseline) {
  if (current.width !== baseline.width || current.height !== baseline.height) {
    return { percent: 100, note: `尺寸不同:${current.width}x${current.height} vs ${baseline.width}x${baseline.height}` };
  }
  const channels = Math.min(current.channels, baseline.channels);
  const totalPixels = current.width * current.height;
  let diffPixels = 0;
  for (let p = 0; p < totalPixels; p++) {
    let delta = 0;
    for (let c = 0; c < channels; c++) {
      delta += Math.abs(current.pixels[p * current.channels + c] - baseline.pixels[p * baseline.channels + c]);
    }
    if (delta > channels * 24) diffPixels++;
  }
  return { percent: (diffPixels / totalPixels) * 100, note: null };
}

function main() {
  let currentDir = DIR_ARG ? resolve(DIR_ARG) : null;
  let tempDir = null;
  if (!currentDir) {
    tempDir = mkdtempSync(join(tmpdir(), "preview-diff-"));
    console.log(`没给 --dir,自己跑一遍 preview-shots.mjs --theme dark --dpr 2 到 ${tempDir}`);
    const run = spawnSync(
      "node",
      ["scripts/qa/preview-shots.mjs", "--theme", "dark", "--dpr", "2", "--out", tempDir],
      { cwd: repoRoot, encoding: "utf8" },
    );
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    if (run.status !== 0) {
      console.error("preview-diff: preview-shots 本身跑失败(基础设施问题,不是像素判定)");
      process.exit(run.status ?? 1);
    }
    currentDir = tempDir;
  }

  let baselineFiles;
  try {
    baselineFiles = readdirSync(BASELINE_DIR).filter((f) => f.endsWith(".png")).sort();
  } catch (error) {
    console.error(`preview-diff: 读不到基线目录 ${BASELINE_DIR}(${error.message})`);
    process.exit(1);
  }
  if (baselineFiles.length === 0) {
    console.error(`preview-diff: 基线目录 ${BASELINE_DIR} 是空的`);
    process.exit(1);
  }

  const rows = [];
  let overThreshold = 0;
  let missing = 0;
  for (const file of baselineFiles) {
    let current;
    try {
      current = decodePng(readFileSync(join(currentDir, file)));
    } catch (error) {
      rows.push({ file, percent: null, note: `本次截图缺这张或读不出(${error.message})` });
      missing++;
      continue;
    }
    const baseline = decodePng(readFileSync(join(BASELINE_DIR, file)));
    const { percent, note } = diffPercent(current, baseline);
    rows.push({ file, percent, note });
    if (percent > THRESHOLD_PCT) overThreshold++;
  }

  for (const row of rows) {
    const status = row.percent === null ? "MISS" : row.percent > THRESHOLD_PCT ? "OVER" : "ok  ";
    const pct = row.percent === null ? "-" : `${row.percent.toFixed(3)}%`;
    console.log(`${status} ${row.file} ${pct}${row.note ? ` (${row.note})` : ""}`);
  }
  console.log(`\n阈值 ${THRESHOLD_PCT}%;${baselineFiles.length} 张基线里 ${overThreshold} 张超阈值,${missing} 张本次没截到。`);

  if (tempDir) rmSync(tempDir, { recursive: true, force: true });

  const fail = overThreshold > 0 || missing > 0;
  if (fail && !ENFORCE) console.log("report-only(没传 --enforce):以上是发现,exit 0。");
  process.exit(fail && ENFORCE ? 1 : 0);
}

// 只在直接执行时跑(`node scripts/qa/preview-diff.mjs`);被 preview-diff.test.mjs 当模块 import
// 纯函数(decodePng / diffPercent)时不触发——那些测试不需要真的起 Chromium。
if (import.meta.url === `file://${process.argv[1]}`) main();

export { decodePng, diffPercent };
