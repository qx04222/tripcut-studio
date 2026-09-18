#!/usr/bin/env node
// R19 E-12:读 qa/perf/history.jsonl(追加式,一行一条量测记录),打印一张按
// metric 分组的时间序列表,供人肉盯趋势(不做阈值判定——那是 bench/check-*.mjs 的事)。
//
// 用法: node scripts/qa/perf-history-report.mjs [--metric jobspan_ms] [--tail 20]
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const historyPath = join(repoRoot, "qa/perf/history.jsonl");
const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const metricFilter = argument("--metric");
const tail = Number(argument("--tail") ?? 20);

if (!existsSync(historyPath)) {
  console.error(`没有历史文件: ${historyPath}`);
  process.exit(1);
}
const lines = readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
const rows = lines.map((l) => JSON.parse(l));
const byMetric = new Map();
for (const row of rows) {
  if (metricFilter && row.metric !== metricFilter) continue;
  if (!byMetric.has(row.metric)) byMetric.set(row.metric, []);
  byMetric.get(row.metric).push(row);
}
for (const [metric, entries] of byMetric) {
  console.log(`\n== ${metric} ==`);
  for (const e of entries.slice(-tail)) {
    console.log(`${e.date}  round=${e.round ?? "-"}  value=${e.value}${e.unit ?? ""}  ${e.note ?? ""}`);
  }
}
console.log(`\n共 ${rows.length} 条记录, ${byMetric.size} 个 metric`);
