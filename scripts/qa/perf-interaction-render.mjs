#!/usr/bin/env node
/**
 * R18 W-5:量「交互态」主线程开销。`perf-idle-render.mjs` 量的是什么都不做的空闲态
 * (R16 已经把它修到 3 ms),这一把量的是**选中素材**这种每点一次就让 MediaPool
 * 整棵重渲染的场景——`React.memo(PoolCard)` 在 R18 之前被两个内联闭包打穿,
 * 可见的 ~32 张卡每次点击全部重协调。
 *
 * 做法:mock 预览打开媒体池,连点 N 张卡片(默认 10 次,每次之间等 250 ms 让
 * 渲染落定),量这段时间的 CDP Performance 增量与 trace 事件数。只测量,不断言。
 *
 *   node scripts/qa/perf-interaction-render.mjs [--clicks 10] [--label after] [--out qa/perf/interaction-<label>.json]
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
const clicks = Number(argument("--clicks") ?? 10);
const label = argument("--label") ?? "run";
const outPath = resolve(argument("--out") ?? join(repoRoot, `qa/perf/interaction-${label}.json`));

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

const metricMap = (result) => Object.fromEntries(result.metrics.map((m) => [m.name, m.value]));

async function main() {
  makeMockCovers();
  const port = await freePort();
  const vite = await startVite(port);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(vite.url, { waitUntil: "domcontentloaded" });
    const cells = page.getByRole("gridcell");
    await cells.first().waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(3_000);
    const cellCount = await cells.count();
    if (cellCount < 2) throw new Error(`媒体池里只有 ${cellCount} 个 gridcell,量不出交互态`);

    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");
    const before = metricMap(await session.send("Performance.getMetrics"));
    await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
    const started = Date.now();
    for (let index = 0; index < clicks; index += 1) {
      // 每次点不同的一张卡:同一张点两次 props 不变,量不到重协调。
      await cells.nth(index % cellCount).click({ position: { x: 20, y: 60 } });
      await page.waitForTimeout(250);
    }
    const elapsedMs = Date.now() - started;
    const traceBuffer = await browser.stopTracing();
    const after = metricMap(await session.send("Performance.getMetrics"));

    const trace = JSON.parse(traceBuffer.toString("utf8"));
    const events = Array.isArray(trace) ? trace : trace.traceEvents;
    const count = (name) => events.filter((e) => e.name === name).length;
    const summary = {
      label,
      clicks,
      cells: cellCount,
      elapsed_ms: elapsedMs,
      delta: {
        LayoutCount: after.LayoutCount - before.LayoutCount,
        RecalcStyleCount: after.RecalcStyleCount - before.RecalcStyleCount,
        ScriptDuration_ms: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
        TaskDuration_ms: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
        JSHeapUsedSize_delta_kb: Math.round((after.JSHeapUsedSize - before.JSHeapUsedSize) / 1024),
      },
      per_click: {
        ScriptDuration_ms: Math.round(((after.ScriptDuration - before.ScriptDuration) * 1000) / clicks),
        LayoutCount: Math.round((after.LayoutCount - before.LayoutCount) / clicks),
      },
      trace_events: {
        Commit: count("Commit"),
        Layout: count("Layout"),
        UpdateLayoutTree: count("UpdateLayoutTree"),
        FunctionCall: count("FunctionCall"),
        Paint: count("Paint"),
      },
    };
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
