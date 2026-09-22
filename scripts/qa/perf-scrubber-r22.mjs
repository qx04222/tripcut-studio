#!/usr/bin/env node
// R22 five-second drag: CDP metrics + rAF cadence, separate from native decode latency.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { makeMockCovers } from "./make-mock-covers.mjs";
const root = resolve(import.meta.dirname, "../..");
const out = resolve(root, "qa/perf/r22-scrubber.json");
let vite, browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  makeMockCovers();
  browser = await chromium.launch({ headless: true });
  const port = await new Promise((accept, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => accept(port)); });
  });
  vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--mode", "mock", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 100; n++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* boot */ } await sleep(100); }
  if (!ready) throw new Error("mock server did not start");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  await page.getByRole("region", { name: "媒体池" }).getByRole("gridcell").first().click();
  await page.keyboard.press("Escape");
  const track = page.getByRole("slider", { name: "播放位置" });
  await track.waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="播放位置"]')?.getAttribute("aria-disabled") === "false");
  await sleep(1000);
  const box = await track.boundingBox();
  if (!box) throw new Error("no track bounds");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const before = await cdp.send("Performance.getMetrics");
  const trace = [];
  cdp.on("Tracing.dataCollected", event => trace.push(...event.value));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
  await page.evaluate(() => {
    window.__r22Frames = []; window.__r22Running = true;
    const tick = now => { window.__r22Frames.push(now); if (window.__r22Running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const valueBefore = await track.getAttribute("aria-valuenow");
  await page.mouse.move(box.x + 4, box.y + 35); await page.mouse.down();
  const started = performance.now();
  let moves = 0;
  const midway = [];
  while (performance.now() - started < 5000) {
    const phase = (performance.now() - started) / 5000;
    await page.mouse.move(box.x + 4 + (box.width - 8) * (0.5 - 0.5 * Math.cos(phase * Math.PI * 6)), box.y + 35);
    moves++; await sleep(8);
    if (moves % 50 === 0) midway.push(Number(await track.getAttribute("aria-valuenow")));
  }
  await page.mouse.up();
  // 拖动必须真的移动了播放头(拖动中 aria-valuenow 取过 ≥3 个不同值),否则「0 掉帧」只是空转。
  const valueAfter = await track.getAttribute("aria-valuenow");
  if (new Set(midway).size < 3) throw new Error(`drag did not move the playhead: samples ${JSON.stringify(midway)} (before ${valueBefore})`);
  const frames = await page.evaluate(() => { window.__r22Running = false; return window.__r22Frames; });
  const complete = new Promise(r => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.end"); await complete;
  const after = await cdp.send("Performance.getMetrics");
  const intervals = frames.slice(1).map((value, i) => value - frames[i]);
  const cadence = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
  const dropped = intervals.reduce((sum, ms) => sum + Math.max(0, Math.round(ms / cadence) - 1), 0);
  const ratio = dropped / (intervals.length + dropped);
  const metric = value => Object.fromEntries(value.metrics.map(m => [m.name, m.value]));
  const b = metric(before), a = metric(after);
  const result = { mode: "mock", duration_ms: frames.at(-1) - frames[0], moves, frames: frames.length, cadence_ms: cadence,
    playhead_before: Number(valueBefore), playhead_samples: midway, playhead_after: Number(valueAfter),
    dropped_frames: dropped, dropped_ratio: ratio, pass: ratio <= 0.05,
    delta: Object.fromEntries(["LayoutCount", "RecalcStyleCount", "ScriptDuration", "TaskDuration"].map(k => [k, a[k] - b[k]])),
    trace_events: Object.fromEntries(["Commit", "Layout", "FunctionCall", "Paint"].map(k => [k, trace.filter(e => e.name === k).length])) };
  mkdirSync(resolve(root, "qa/perf"), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
} catch (error) {
  mkdirSync(resolve(root, "qa/perf"), { recursive: true });
  writeFileSync(out, JSON.stringify({ mode: "mock", pass: null, blocked: String(error) }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { await browser?.close(); vite?.kill("SIGTERM"); }
