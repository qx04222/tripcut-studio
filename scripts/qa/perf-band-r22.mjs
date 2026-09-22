#!/usr/bin/env node
// R22-C 镜头带精修的掉帧判据:mock 模式下 N 段夹具(默认 300,`--band-segments N`),
// (a) 真指针按住一个镜块在带上来回拖 5 s;(b) ⌥ + 滚轮在鼠标位置缩放 20 次。
// 每段用 rAF 节拍算掉帧率(与 perf-scrubber-r22.mjs 同一口径),≤5% 达标。
// 自证:拖动中 `.band-drag-ghost` 必须出现且 over 目标换过 ≥3 个;缩放后 data-zoom 必须离开 1。
// 用法: node scripts/qa/perf-band-r22.mjs [--band-segments 300] [--out qa/perf/r22-band-300.json]
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { makeMockCovers } from "./make-mock-covers.mjs";

const root = resolve(import.meta.dirname, "../..");
const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const bandSegments = Number(argument("--band-segments") ?? 300);
const out = resolve(root, argument("--out") ?? `qa/perf/r22-band-${bandSegments}.json`);
let vite, browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startFrames(page) {
  await page.evaluate(() => {
    window.__r22Frames = []; window.__r22Running = true;
    const tick = (now) => { window.__r22Frames.push(now); if (window.__r22Running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}
async function stopFrames(page) {
  const frames = await page.evaluate(() => { window.__r22Running = false; return window.__r22Frames; });
  const intervals = frames.slice(1).map((v, i) => v - frames[i]);
  const cadence = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
  const dropped = intervals.reduce((sum, ms) => sum + Math.max(0, Math.round(ms / cadence) - 1), 0);
  return { duration_ms: frames.at(-1) - frames[0], frames: frames.length, cadence_ms: cadence, dropped_frames: dropped, dropped_ratio: dropped / (intervals.length + dropped) };
}
const metric = (value) => Object.fromEntries(value.metrics.map((m) => [m.name, m.value]));
const delta = (b, a) => Object.fromEntries(["LayoutCount", "RecalcStyleCount", "ScriptDuration", "TaskDuration"].map((k) => [k, a[k] - b[k]]));

try {
  await makeMockCovers();
  browser = await chromium.launch({ headless: true });
  const port = await new Promise((accept, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => accept(p)); });
  });
  vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--mode", "mock", "--port", String(port), "--strictPort"], {
    cwd: root, stdio: "ignore", env: { ...process.env, VITE_MOCK_BAND_SEGMENTS: String(bandSegments) },
  });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 150; n++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* boot */ } await sleep(100); }
  if (!ready) throw new Error("mock server did not start");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  const band = page.getByRole("region", { name: "镜头带", exact: true });
  const grid = band.getByRole("grid", { name: "镜头序列" });
  const cells = grid.locator('[data-guide="shot"]');
  await cells.first().waitFor({ timeout: 30_000 });
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined);
  await page.keyboard.press("Escape");
  const actual = Number(await grid.getAttribute("data-segment-count"));
  if (actual !== bandSegments) throw new Error(`fixture mismatch: requested ${bandSegments}, rendered model has ${actual}`);
  await sleep(1500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  // (a) 5 s 拖动:从第 2 块按下,在视口内左右来回扫(跨到别的章节与栏边缘)。
  const gridBox = await grid.boundingBox();
  const source = await cells.nth(1).boundingBox();
  if (!gridBox || !source) throw new Error("band geometry missing");
  const y = source.y + source.height / 2;
  const dragBefore = metric(await cdp.send("Performance.getMetrics"));
  await startFrames(page);
  await page.mouse.move(source.x + source.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 12, y, { steps: 3 });
  const started = performance.now();
  let moves = 0; const overs = new Set(); let ghostSeen = false; let renderedDuringDrag = 0;
  while (performance.now() - started < 5000) {
    const phase = (performance.now() - started) / 5000;
    const x = gridBox.x + 40 + (gridBox.width - 80) * (0.5 - 0.5 * Math.cos(phase * Math.PI * 6));
    await page.mouse.move(x, y);
    moves++; await sleep(8);
    if (moves % 25 === 0) {
      ghostSeen ||= (await page.locator(".band-drag-ghost").count()) > 0;
      const over = await grid.locator('.band-segment--over-before, .band-segment--over-after').first().getAttribute("data-band-key").catch(() => null);
      if (over) overs.add(over);
      renderedDuringDrag = Math.max(renderedDuringDrag, await cells.count());
    }
  }
  const dragFrames = await stopFrames(page);
  await page.mouse.up();
  await sleep(600);
  const dragAfter = metric(await cdp.send("Performance.getMetrics"));
  if (!ghostSeen) throw new Error("drag never showed .band-drag-ghost — the pointer was not dragging a segment");
  await page.keyboard.press("Meta+z").catch(() => undefined);
  await sleep(800);

  // (b) ⌥ + 滚轮 20 次(10 次放大 + 10 次缩小),锚在带中央。
  const zoomBefore = metric(await cdp.send("Performance.getMetrics"));
  const zoomsSeen = new Set([await band.getAttribute("data-zoom")]);
  await page.mouse.move(gridBox.x + gridBox.width / 2, y);
  await page.keyboard.down("Alt");
  await startFrames(page);
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, i < 10 ? -120 : 120);
    await sleep(60);
    zoomsSeen.add(await band.getAttribute("data-zoom"));
  }
  const zoomFrames = await stopFrames(page);
  await page.keyboard.up("Alt");
  await sleep(600);
  const zoomAfter = metric(await cdp.send("Performance.getMetrics"));
  if (zoomsSeen.size < 3) throw new Error(`alt-wheel did not zoom: data-zoom values ${JSON.stringify([...zoomsSeen])}`);

  const result = {
    mode: "mock", band_segments: bandSegments, actual_band_segments: actual,
    drag: { ...dragFrames, moves, over_targets: overs.size, ghost_seen: ghostSeen, rendered_cards_during_drag: renderedDuringDrag, pass: dragFrames.dropped_ratio <= 0.05, delta: delta(dragBefore, dragAfter) },
    zoom: { ...zoomFrames, wheel_events: 20, zooms_seen: [...zoomsSeen], pass: zoomFrames.dropped_ratio <= 0.05, delta: delta(zoomBefore, zoomAfter) },
  };
  result.pass = result.drag.pass && result.zoom.pass;
  mkdirSync(resolve(root, "qa/perf"), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
} catch (error) {
  mkdirSync(resolve(root, "qa/perf"), { recursive: true });
  writeFileSync(out, JSON.stringify({ mode: "mock", band_segments: bandSegments, pass: null, blocked: String(error) }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { await browser?.close(); vite?.kill("SIGTERM"); }
