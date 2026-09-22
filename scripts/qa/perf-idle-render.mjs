#!/usr/bin/env node
/**
 * R16 车道 E(§3 ④):量「空闲态」主线程开销——mock 预览打开媒体池后什么都不做,
 * `useClipsFeed` 每 2 s 轮询一次;比较前后两版在 N 秒空闲里的 CDP Performance 指标增量
 * (LayoutCount / RecalcStyleCount / ScriptDuration / TaskDuration)与 trace 里的
 * `Commit` / `FunctionCall` 事件数。用法:
 *   node scripts/qa/perf-idle-render.mjs [--seconds 10] [--out qa/perf/idle-<label>.json] [--label after]
 * 只测量,不断言;数字进 lane-perf-report。
 *
 * E-07(R19 perf 车道)加了 `--band-segments N`:通过 `VITE_MOCK_BAND_SEGMENTS=N` 注入一条
 * N 段的镜头带(见 src/devMock/fixture.ts `buildScaledSegments`),并在空闲态量测之后
 * 额外跑一段「横向滚动镜头带」场景(对 role=grid, name=镜头序列 连续 wheel 滚动),
 * 输出里多一个 `scroll` 字段,和 `idle` 同样的指标口径。不传该参数时行为与改动前完全一致。
 */
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { makeMockCovers } from "./make-mock-covers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const repoRoot = resolve(import.meta.dirname, "../..");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const seconds = Number(argument("--seconds") ?? 10);
const label = argument("--label") ?? "run";
const outPath = resolve(argument("--out") ?? join(repoRoot, `qa/perf/idle-${label}.json`));
const bandSegments = Number(argument("--band-segments") ?? 0);

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
  const env = { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" };
  if (bandSegments > 0) env.VITE_MOCK_BAND_SEGMENTS = String(bandSegments);
  const child = spawn(
    process.execPath,
    [join(repoRoot, "node_modules/vite/bin/vite.js"), "--mode", "mock", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env },
  );
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited early (${child.exitCode})`);
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return { child, url };
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error("vite did not come up within 30 s");
}

function metricMap(result) {
  return Object.fromEntries(result.metrics.map((m) => [m.name, m.value]));
}

function summarize(before, after, trace, extra) {
  const events = Array.isArray(trace) ? trace : trace.traceEvents;
  const count = (name) => events.filter((e) => e.name === name).length;
  return {
    ...extra,
    delta: {
      LayoutCount: after.LayoutCount - before.LayoutCount,
      RecalcStyleCount: after.RecalcStyleCount - before.RecalcStyleCount,
      ScriptDuration_ms: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
      TaskDuration_ms: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
      JSHeapUsedSize_delta_kb: Math.round((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1024),
    },
    trace_events: {
      Commit: count("Commit"),
      Layout: count("Layout"),
      UpdateLayoutTree: count("UpdateLayoutTree"),
      FunctionCall: count("FunctionCall"),
      Paint: count("Paint"),
    },
  };
}

async function measure(session, browser, page, run) {
  const before = metricMap(await session.send("Performance.getMetrics"));
  await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
  await run();
  const traceBuffer = await browser.stopTracing();
  const after = metricMap(await session.send("Performance.getMetrics"));
  return { before, after, trace: JSON.parse(traceBuffer.toString("utf8")) };
}

async function main() {
  await makeMockCovers();
  const port = await freePort();
  const vite = await startVite(port);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(vite.url, { waitUntil: "domcontentloaded" });
    await page.getByRole("gridcell").first().waitFor({ state: "visible", timeout: 15_000 });
    const actualBandSegments = Number(await page.getByRole("grid", { name: "镜头序列" }).getAttribute("data-segment-count"));
    if (bandSegments > 0 && actualBandSegments !== bandSegments) {
      throw new Error(`Invalid band fixture: requested ${bandSegments}, rendered model contains ${actualBandSegments}`);
    }
    // 让首屏与首轮轮询都落定。
    await page.waitForTimeout(3_000);

    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");

    const idleRun = await measure(session, browser, page, () => page.waitForTimeout(seconds * 1_000));
    const idle = summarize(idleRun.before, idleRun.after, idleRun.trace, { label, seconds, polls_expected: Math.floor(seconds / 2) });

    let scroll = null;
    if (bandSegments > 0) {
      const band = page.getByRole("grid", { name: "镜头序列" });
      await band.waitFor({ state: "visible", timeout: 15_000 });
      const box = await band.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const scrollRun = await measure(session, browser, page, async () => {
        // 20 次横向滚轮,每次间隔 100ms,模拟人手动滚动一条长镜头带。
        for (let i = 0; i < 20; i += 1) {
          await page.mouse.wheel(120, 0);
          await page.waitForTimeout(100);
        }
      });
      scroll = summarize(scrollRun.before, scrollRun.after, scrollRun.trace, { label, scenario: "scroll", wheel_events: 20 });
    }

    const summary = { ...idle, scenario: "idle", band_segments: bandSegments || null, actual_band_segments: actualBandSegments, scroll };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    await browser.close();
    vite.child.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
