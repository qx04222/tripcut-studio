# R0 基建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让后续六轮无人值守有可信的门禁、性能装置、GUI 冒烟与报告骨架，并把交付包目录改成业主原稿编号。

**Architecture:** 所有新脚本放 `scripts/qa/`，与现有 `fast-gates.mjs` 同风格（`spawnSync`、真退出码、`gate.json` 落到 `qa/runs/<ts>-<id>/`）。性能装置分两层：Rust 示例 `perf_driver` 负责无头入库与多线程跑任务并采样进程组 RSS，Node 脚本负责生成夹具、调用驱动、与基线比对。

**Tech Stack:** Node 22（ESM）、Rust（`tripcut_studio_lib` 示例）、zsh、ffmpeg（bundled，`src-tauri/target/release/bundle/share` 或 `/opt/homebrew/bin/ffmpeg` 兜底）、cliclick、osascript。

## Global Constraints

- 规格 `docs/superpowers/specs/2026-09-06-unattended-upgrade-design.md`；总计划 `docs/superpowers/plans/2026-09-06-unattended-upgrade-master.md` 的 Global Constraints 全部适用。
- shell 里先 `export PATH=/opt/homebrew/opt/rustup/bin:$PATH`；cargo 命令都带 `--manifest-path src-tauri/Cargo.toml`。
- 夹具与装置产物放 `~/Library/Caches/tripcut-perf/`，不入库；`qa/runs/` 目前未被 `.gitignore` 忽略且已有历史目录入库；Task 1 顺手加 `qa/runs/` 到 `.gitignore`（已跟踪的历史目录保留不动）。
- 不启动 `/Applications/` 下任何正式版；GUI 只跑 `prepare-cua-candidate.mjs` 产出的 QA 副本。
- 每个任务在 `main` 上直接做小提交（R0 全是接线人自己的基建，不开 worktree），提交后 `git push origin main`。

---

### Task 1: fast-gates 加 vite-build

**Files:**
- Modify: `scripts/qa/fast-gates.mjs:43-51`

**Interfaces:**
- Produces: `gate.json.results[]` 多一条 `id: "vite-build"`；后续任务与轮次的合并门禁以此为准。

- [ ] **Step 1: 先证明缺口**

Run: `cd ~/Projects/tripcut-studio && node scripts/qa/fast-gates.mjs 2>&1 | grep -c vite-build`
Expected: `0`

- [ ] **Step 2: 在 `commands` 数组里 `eslint` 之后插入**

```js
  { id: "vite-build", command: "npm", args: ["run", "build"] },
```

- [ ] **Step 3: 跑门禁**

Run: `node scripts/qa/fast-gates.mjs`
Expected: 输出含 `PASS vite-build exit=0 strict=0`，末行 `PASS <目录>`。

- [ ] **Step 4: `.gitignore` 加一行 `qa/runs/`，Commit**

```bash
git add scripts/qa/fast-gates.mjs .gitignore
git commit -m "gate(qa): fast-gates 加 vite-build——build-only 错误此前只在打包时暴露

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

---

### Task 2: 依赖漏洞扫描进门禁

**Files:**
- Modify: `scripts/qa/fast-gates.mjs`（`commands` 与 `strictFailurePatterns`）

- [ ] **Step 1: 安装 cargo-audit 并看现状**

Run:
```bash
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
cargo install cargo-audit --locked
cd ~/Projects/tripcut-studio && cargo audit --file src-tauri/Cargo.lock; echo "cargo-audit EXIT=$?"
npm audit --audit-level=high; echo "npm-audit EXIT=$?"
```
Expected: 两个 EXIT 都打印出来。若任一非 0，把输出原文写进本轮报告 FINDINGS F-R0-1，并在 Step 2 之前先升级对应依赖到无高危版本（`npm audit fix` 或 `cargo update -p <crate>`），重跑 fast-gates 全绿后再继续；不得用忽略清单让它变绿。

- [ ] **Step 2: 加两条门禁**

在 `cargo-clippy` 之后追加：
```js
  { id: "cargo-audit", command: "cargo", args: ["audit", "--file", "src-tauri/Cargo.lock"] },
  { id: "npm-audit", command: "npm", args: ["audit", "--audit-level=high"] },
```
`cargo-audit` 装在 `~/.cargo/bin`（`cargo install` 默认），把它也并进 PATH：
```js
const cargoHomeBin = join(process.env.HOME ?? "", ".cargo/bin");
const qaEnvironment = {
  ...process.env,
  PATH: [existsSync(rustupBin) ? rustupBin : null, existsSync(cargoHomeBin) ? cargoHomeBin : null, process.env.PATH ?? ""]
    .filter(Boolean)
    .join(":"),
};
```

- [ ] **Step 3: 跑门禁**

Run: `node scripts/qa/fast-gates.mjs`
Expected: `PASS cargo-audit` 与 `PASS npm-audit`，末行 PASS。

- [ ] **Step 4: Commit**

```bash
git add scripts/qa/fast-gates.mjs
git commit -m "gate(qa): cargo audit 与 npm audit(high) 进 fast-gates

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

---

### Task 3: 性能夹具生成脚本

**Files:**
- Create: `scripts/qa/make-perf-fixtures.sh`

**Interfaces:**
- Produces: 目录 `~/Library/Caches/tripcut-perf/fixtures/` 含 N 个 mp4；`manifest.json` 记每个文件的来源母本、时长档、大小。Task 4 的驱动只吃这个目录。

- [ ] **Step 1: 写脚本**

```zsh
#!/bin/zsh
# 生成性能验收夹具:以仓库内两条 4K HEVC 母本 -c copy 切 10/30/120 s,再加 lavfi 合成的 1080p H.264。
# 用法: scripts/qa/make-perf-fixtures.sh [数量,默认 500] [输出目录]
set -euo pipefail
count=${1:-500}
out=${2:-$HOME/Library/Caches/tripcut-perf/fixtures}
repo=${0:A:h:h:h}
ffmpeg=${FFMPEG_BIN:-$(command -v ffmpeg)}
[[ -x $ffmpeg ]] || { echo "缺 ffmpeg" >&2; exit 2 }
mkdir -p "$out"
masters=("$repo/spikes/s2-libmpv/media/test-4k-hevc-10bit.mp4" "$repo/spikes/s2-libmpv/media/test-4k-hevc.mp4")
durations=(10 30 120)
manifest="$out/manifest.json"
print -n '[' > "$manifest"
i=0
while (( i < count )); do
  kind=$(( i % 4 ))
  name=$(printf 'perf_%04d.mp4' $i)
  target="$out/$name"
  if [[ -f $target ]]; then (( i++ )); continue; fi
  if (( kind == 3 )); then
    "$ffmpeg" -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=440" \
      -t 20 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -metadata title="perf-$i" "$target" \
      2>/dev/null || "$ffmpeg" -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=440" \
      -t 20 -c:v h264_videotoolbox -pix_fmt yuv420p -c:a aac -metadata title="perf-$i" "$target"
    src="lavfi-1080p"; dur=20
  else
    src=${masters[$(( kind % 2 + 1 ))]}
    dur=${durations[$(( (i / 4) % 3 + 1 ))]}
    "$ffmpeg" -v error -y -ss 0 -t $dur -i "$src" -c copy -metadata title="perf-$i" -movflags +faststart "$target"
  fi
  size=$(stat -f %z "$target")
  (( i > 0 )) && print -n ',' >> "$manifest"
  print -n "{\"file\":\"$name\",\"source\":\"${src:t}\",\"duration_s\":$dur,\"bytes\":$size}" >> "$manifest"
  (( i++ ))
done
print ']' >> "$manifest"
echo "fixtures=$count dir=$out bytes=$(du -sk "$out" | cut -f1)K"
```

- [ ] **Step 2: 小规模验证**

Run: `chmod +x scripts/qa/make-perf-fixtures.sh && scripts/qa/make-perf-fixtures.sh 8 /tmp/perf-smoke && ls /tmp/perf-smoke | wc -l && python3 -c "import json;print(len(json.load(open('/tmp/perf-smoke/manifest.json'))))"`
Expected: `9`（8 个 mp4 + manifest）与 `8`。

- [ ] **Step 3: 全量生成**

Run: `scripts/qa/make-perf-fixtures.sh 500`
Expected: 末行 `fixtures=500 …`，目录约 8–12 GB。

- [ ] **Step 4: Commit**

```bash
git add scripts/qa/make-perf-fixtures.sh
git commit -m "qa(perf): 性能夹具生成脚本——母本在仓库内,任何机器可重建 500 条

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

---

### Task 4: 性能装置（驱动 + 采集 + 基线比对）

**Files:**
- Create: `src-tauri/examples/perf_driver.rs`
- Create: `scripts/qa/perf-harness.mjs`
- Create: `benchmark/perf-baseline.json`（首次运行产出）

**Interfaces:**
- Consumes: `tripcut_studio_lib::core::{db::open_project, import::start_import, jobs::JobRunner::run_one, settings::set_setting}`；`settings::WORKER_COUNT_KEY`。
- Produces: `result.json`：
```json
{ "schema_version": 1, "started_at": "...", "finished_at": "...",
  "workers": 4, "fixtures": 500,
  "rss_bytes": { "peak": 0, "p95": 0 }, "swapouts_delta": 0,
  "first_screen_cover_ms": 0, "all_cover_ms": 0, "total_ms": 0,
  "stages": { "thumbnail": { "count": 0, "p50_ms": 0, "p95_ms": 0 }, "analyze_l1": {}, "analyze_motion": {}, "proxy": {}, "waveform": {} },
  "jobs": { "done": 0, "failed": 0, "blocked": 0 } }
```
- 环境变量：`TRIPCUT_MEMORY_BUDGET_BYTES`、`TRIPCUT_MEMORY_PRESSURE_FILE`（R1 的 P6 才消费，本轮只透传）。

- [ ] **Step 1: 写驱动**

```rust
//! 性能验收驱动:无头导入夹具目录,N 线程跑任务队列,采样进程组 RSS,输出 result.json。
//! 用法: cargo run --release --example perf_driver -- --db <新库路径> --folder <夹具目录> --workers 4 --out result.json
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tripcut_studio_lib::core;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn pgid_rss_bytes() -> u64 {
    let pgid = unsafe { libc::getpgrp() };
    let out = Command::new("ps").args(["-axo", "pgid=,rss="]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let g: i32 = it.next()?.parse().ok()?;
            let kb: u64 = it.next()?.parse().ok()?;
            (g == pgid).then_some(kb * 1024)
        })
        .sum()
}

fn swapouts() -> u64 {
    let out = Command::new("vm_stat").output().expect("vm_stat");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.starts_with("Swapouts"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().trim_end_matches('.').parse().ok())
        .unwrap_or(0)
}

fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() { return 0; }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx]
}

fn main() {
    let db = PathBuf::from(arg("--db").expect("--db"));
    let folder = PathBuf::from(arg("--folder").expect("--folder"));
    let workers: usize = arg("--workers").and_then(|w| w.parse().ok()).unwrap_or(4);
    let out = PathBuf::from(arg("--out").unwrap_or_else(|| "result.json".into()));
    if db.exists() { std::fs::remove_file(&db).expect("清旧库"); }
    let mut conn = core::db::open_project(&db).expect("open_project");
    core::settings::set_setting(&conn, core::settings::WORKER_COUNT_KEY, &workers.to_string()).unwrap();
    let started = Instant::now();
    let started_at = chrono_now();
    let swap_before = swapouts();
    core::import::start_import(&mut conn, folder.as_path()).expect("start_import");
    drop(conn);

    let stop = Arc::new(AtomicBool::new(false));
    let timings: Arc<Mutex<Vec<(String, u64)>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for _ in 0..workers {
        let db = db.clone(); let stop = stop.clone(); let timings = timings.clone();
        handles.push(thread::spawn(move || loop {
            if stop.load(Ordering::Relaxed) { break; }
            let t = Instant::now();
            match core::jobs::JobRunner::run_one(&db) {
                Ok(true) => {
                    let ms = t.elapsed().as_millis() as u64;
                    let c = core::db::open_project(&db).unwrap();
                    let kind: String = c.query_row(
                        "SELECT kind FROM jobs WHERE status IN ('done','failed','blocked') ORDER BY finished_at DESC LIMIT 1",
                        [], |r| r.get(0)).unwrap_or_default();
                    timings.lock().unwrap().push((kind, ms));
                }
                Ok(false) => thread::sleep(Duration::from_millis(200)),
                Err(e) => { eprintln!("run_one: {e}"); thread::sleep(Duration::from_millis(500)); }
            }
        }));
    }

    let mut samples: Vec<u64> = Vec::new();
    let mut first_screen_ms: Option<u64> = None;
    let mut all_cover_ms: Option<u64> = None;
    let fixtures = std::fs::read_dir(&folder).unwrap().filter(|e| e.as_ref().unwrap().path().extension().map(|x| x == "mp4").unwrap_or(false)).count() as i64;
    loop {
        samples.push(pgid_rss_bytes());
        let c = core::db::open_project(&db).unwrap();
        let covers: i64 = c.query_row("SELECT COUNT(*) FROM cache_artifacts WHERE kind='cover'", [], |r| r.get(0)).unwrap();
        if first_screen_ms.is_none() && covers >= 24 { first_screen_ms = Some(started.elapsed().as_millis() as u64); }
        if all_cover_ms.is_none() && covers >= fixtures { all_cover_ms = Some(started.elapsed().as_millis() as u64); }
        let active: i64 = c.query_row("SELECT COUNT(*) FROM jobs WHERE status IN ('pending','running')", [], |r| r.get(0)).unwrap();
        if active == 0 && started.elapsed() > Duration::from_secs(5) { break; }
        if started.elapsed() > Duration::from_secs(6 * 3600) { eprintln!("timeout"); break; }
        thread::sleep(Duration::from_millis(500));
    }
    stop.store(true, Ordering::Relaxed);
    for h in handles { let _ = h.join(); }

    let c = core::db::open_project(&db).unwrap();
    let count = |s: &str| -> i64 { c.query_row(&format!("SELECT COUNT(*) FROM jobs WHERE status='{s}'"), [], |r| r.get(0)).unwrap() };
    samples.sort_unstable();
    let mut by_kind: HashMap<String, Vec<u64>> = HashMap::new();
    for (k, ms) in timings.lock().unwrap().iter() { by_kind.entry(k.clone()).or_default().push(*ms); }
    let stages: serde_json::Map<String, serde_json::Value> = by_kind.into_iter().map(|(k, mut v)| {
        v.sort_unstable();
        (k, json!({"count": v.len(), "p50_ms": percentile(&v, 0.5), "p95_ms": percentile(&v, 0.95)}))
    }).collect();
    let result = json!({
        "schema_version": 1, "started_at": started_at, "finished_at": chrono_now(),
        "workers": workers, "fixtures": fixtures,
        "rss_bytes": {"peak": samples.last().copied().unwrap_or(0), "p95": percentile(&samples, 0.95)},
        "swapouts_delta": swapouts().saturating_sub(swap_before),
        "first_screen_cover_ms": first_screen_ms, "all_cover_ms": all_cover_ms,
        "total_ms": started.elapsed().as_millis() as u64,
        "stages": stages,
        "jobs": {"done": count("done"), "failed": count("failed"), "blocked": count("blocked")},
    });
    std::fs::write(&out, serde_json::to_string_pretty(&result).unwrap()).unwrap();
    println!("{}", out.display());
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    format!("unix:{secs}")
}
```
`libc = "=0.2.189"` 已在 `src-tauri/Cargo.toml:19`；`JobRunner::run_one` 是 `pub fn`（`jobs.rs:925`），`bench_driver.rs:349` 已在用。

- [ ] **Step 2: 编译并小规模跑**

Run:
```bash
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
cargo build --release --manifest-path src-tauri/Cargo.toml --example perf_driver
src-tauri/target/release/examples/perf_driver --db /tmp/perf-smoke.db --folder /tmp/perf-smoke --workers 2 --out /tmp/perf-smoke.json && python3 -m json.tool /tmp/perf-smoke.json | head -30
```
Expected: 输出 JSON，`jobs.done` > 0、`jobs.failed` = 0、`stages.thumbnail.count` = 8。

- [ ] **Step 3: 写 harness**

```js
#!/usr/bin/env node
// 性能验收装置:生成夹具(缺则建)、跑 perf_driver、与基线比对、落 qa/runs/<ts>-perf/。
// 用法: node scripts/qa/perf-harness.mjs [--fixtures 500] [--workers 4] [--budget-gb 12] [--write-baseline] [--label 前|后]
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const repoRoot = resolve(import.meta.dirname, "../..");
const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (name) => process.argv.includes(name);
const fixtures = Number(argument("--fixtures") ?? 500);
const workers = Number(argument("--workers") ?? 4);
const budgetGb = Number(argument("--budget-gb") ?? 12);
const label = argument("--label") ?? "run";
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outDir = join(repoRoot, "qa/runs", `${timestamp}-perf-${label}`);
mkdirSync(outDir, { recursive: true });
const cache = join(homedir(), "Library/Caches/tripcut-perf");
const fixtureDir = join(cache, "fixtures");
const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${process.env.PATH ?? ""}`,
  TRIPCUT_MEMORY_BUDGET_BYTES: String(budgetGb * 1024 ** 3) };
const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], ...extra });
  writeFileSync(join(outDir, `${args[0] ?? cmd}.log`), `${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) { console.error(`${cmd} ${args.join(" ")} exit=${r.status}`); process.exit(r.status ?? 1); }
  return r;
};
if (!existsSync(join(fixtureDir, "manifest.json"))) run("zsh", ["scripts/qa/make-perf-fixtures.sh", String(fixtures), fixtureDir]);
run("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml", "--example", "perf_driver"]);
const resultPath = join(outDir, "result.json");
run(join(repoRoot, "src-tauri/target/release/examples/perf_driver"),
  ["--db", join(cache, "perf.db"), "--folder", fixtureDir, "--workers", String(workers), "--out", resultPath]);
const result = JSON.parse(readFileSync(resultPath, "utf8"));
const baselinePath = join(repoRoot, "benchmark/perf-baseline.json");
const checks = [];
const red = (id, detail) => checks.push({ id, pass: false, detail });
const green = (id, detail) => checks.push({ id, pass: true, detail });
if (result.jobs.failed > 0 || result.jobs.blocked > 0) red("jobs.clean", JSON.stringify(result.jobs)); else green("jobs.clean", JSON.stringify(result.jobs));
if (result.first_screen_cover_ms == null || result.first_screen_cover_ms > 30_000) red("first-screen<=30s", String(result.first_screen_cover_ms)); else green("first-screen<=30s", String(result.first_screen_cover_ms));
if (result.swapouts_delta > 0) red("swapouts=0", String(result.swapouts_delta)); else green("swapouts=0", "0");
if (existsSync(baselinePath) && !flag("--write-baseline")) {
  const base = JSON.parse(readFileSync(baselinePath, "utf8"));
  const ratio = (a, b) => (b ? a / b : 1);
  const rss = ratio(result.rss_bytes.peak, base.rss_bytes.peak);
  const total = ratio(result.total_ms, base.total_ms);
  (rss > 1.10 ? red : green)("rss-peak<=+10%", `${(rss * 100).toFixed(1)}% of baseline`);
  (total > 1.15 ? red : green)("total<=+15%", `${(total * 100).toFixed(1)}% of baseline`);
}
if (flag("--write-baseline")) { copyFileSync(resultPath, baselinePath); green("baseline.written", baselinePath); }
const gate = { schemaVersion: 1, gate: "perf-harness", capturedAt: new Date().toISOString(),
  status: checks.every((c) => c.pass) ? "PASS" : "FAIL", workers, fixtures: result.fixtures, budgetGb, checks, result };
writeFileSync(join(outDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.detail}`);
console.log(`${gate.status} ${outDir}`);
process.exitCode = gate.status === "PASS" ? 0 : 1;
```

- [ ] **Step 4: 产出基线（500 条，4 worker）**

Run: `node scripts/qa/perf-harness.mjs --write-baseline --label baseline`
Expected: `PASS baseline.written …`，末行 `PASS`；`benchmark/perf-baseline.json` 存在。把 `rss_bytes.peak`、`total_ms`、`first_screen_cover_ms` 三个数抄进本轮报告第 2 节。

- [ ] **Step 5: 先让它红过一次**

Run: 临时把 `benchmark/perf-baseline.json` 里 `total_ms` 改成 `1`，跑 `node scripts/qa/perf-harness.mjs --fixtures 8 --label calib`（会复用已有夹具目录，所以实际仍是 500 条；若想快，用 `--fixtures 8` 前先 `mv ~/Library/Caches/tripcut-perf/fixtures{,.full}`），Expected: `FAIL total<=+15%`。改回并确认 `git diff benchmark/` 为空。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/examples/perf_driver.rs scripts/qa/perf-harness.mjs benchmark/perf-baseline.json
git commit -m "qa(perf): 性能验收装置——无头驱动采进程组 RSS/阶段耗时/首屏缩略图,基线与回归阈值

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

---

### Task 5: GUI 冒烟脚本

**Files:**
- Create: `scripts/qa/smoke-gui.mjs`

**Interfaces:**
- Consumes: `prepare-cua-candidate.mjs --out <dir>` 产出的 `<dir>/manifest.json`，键为 `candidate.appPath`、`candidate.supportDirectory`、`candidate.pid`（已核对 `prepare-cua-candidate.mjs:225-262`）。每次运行都新建临时 support 目录，所以灌库要在启动前完成：本任务给该脚本加 `--seed-db <project.db>` 参数。
- Produces: `qa/runs/<ts>-smoke/gate.json` 与六张 `NN-<page>.png`。

- [ ] **Step 1: 写脚本**

```js
#!/usr/bin/env node
// GUI 冒烟:对 CUA 候选实例用 ⌘K 逐页跳转、截图、键盘评级,判定用隔离库行数与进程存活。
// 用法: node scripts/qa/smoke-gui.mjs --candidate <prepare-cua-candidate 输出目录> [--fixtures <目录>] [--out <目录>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "../..");
const argument = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const candidateDir = resolve(argument("--candidate") ?? "");
const manifest = JSON.parse(readFileSync(join(candidateDir, "manifest.json"), "utf8"));
const supportDir = manifest.candidate.supportDirectory;
const appName = "旅剪工作台 QA";
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const outDir = resolve(argument("--out") ?? join(repoRoot, "qa/runs", `${timestamp}-smoke`));
mkdirSync(outDir, { recursive: true });
const checks = [];
const check = (id, pass, detail) => { checks.push({ id, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${detail}`); };
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const osa = (script) => sh("osascript", ["-e", script]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sqlite = (sql) => sh("sqlite3", [join(supportDir, "default/project.db"), sql]).stdout.trim();
const alive = () => sh("pgrep", ["-f", `${appName}.app/Contents/MacOS/tripcut-studio`]).status === 0;

// 0. 候选活着、前台
check("process.alive", alive(), "pgrep");
osa(`tell application "${appName}" to activate`); sleep(1500);
const keys = (text) => osa(`tell application "System Events" to keystroke "${text}"`);
const key = (code, mods = "") => osa(`tell application "System Events" to key code ${code}${mods ? ` using {${mods}}` : ""}`);
const shot = (n, name) => { const p = join(outDir, `${String(n).padStart(2, "0")}-${name}.png`); sh("screencapture", ["-x", p]); return existsSync(p); };

// 1. 六页跳转:⌘K → 输入页名 → 回车
const pages = [["import", "导入"], ["select", "筛片"], ["story", "故事"], ["deliver", "交付"], ["settings", "设置"], ["select2", "筛片"]];
pages.forEach(([id, label], i) => {
  key(40, "command down"); sleep(600);            // ⌘K
  keys(label); sleep(500); key(36); sleep(1500);   // 输入 + Return
  check(`page.${id}.shot`, shot(i + 1, id), label);
  check(`page.${id}.alive`, alive(), "");
});

// 2. 筛片页键盘评级(可选断言:失败降级为 warn,R2 加固)
const ratingsBefore = Number(sqlite("SELECT COUNT(*) FROM ratings") || 0);
key(125); sleep(300); keys("f"); sleep(800);      // ↓ 选中首条,F 收藏
const ratingsAfter = Number(sqlite("SELECT COUNT(*) FROM ratings") || 0);
checks.push({ id: "select.rate.f", pass: true, warn: ratingsAfter <= ratingsBefore, detail: `${ratingsBefore}->${ratingsAfter}` });
console.log(`${ratingsAfter > ratingsBefore ? "PASS" : "WARN"} select.rate.f ${ratingsBefore}->${ratingsAfter}`);

// 3. 库自检
check("db.integrity", sqlite("PRAGMA integrity_check") === "ok", sqlite("PRAGMA integrity_check"));
check("db.clips", Number(sqlite("SELECT COUNT(*) FROM clips") || 0) > 0, sqlite("SELECT COUNT(*) FROM clips"));
check("process.alive.end", alive(), "");

const gate = { schemaVersion: 1, gate: "smoke-gui", capturedAt: new Date().toISOString(), candidateDir, supportDir,
  status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks };
writeFileSync(join(outDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`);
console.log(`${gate.status} ${outDir}`);
process.exitCode = gate.status === "PASS" ? 0 : 1;
```

- [ ] **Step 2: 给 prepare-cua-candidate 加 `--seed-db`，并预先无头灌库**

在 `scripts/qa/prepare-cua-candidate.mjs:146` 之后（`mkdirSync(jianyingDirectory…)` 之前）加：
```js
const seedDb = argument("--seed-db");
if (seedDb) {
  mkdirSync(join(supportDirectory, "default"), { recursive: true });
  cpSync(resolve(seedDb), join(supportDirectory, "default/project.db"));
}
```
（`cpSync`、`mkdirSync`、`resolve` 该文件已导入；`default` 是 release 构建的库作用域，见 `src-tauri/src/libraries.rs:18`。）然后用 `perf_driver` 灌一份 8 条的库再启动候选：
```bash
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
APP=src-tauri/target/release/bundle/macos/旅剪工作台.app
src-tauri/target/release/examples/perf_driver --db /tmp/cua-seed/project.db --folder /tmp/perf-smoke --workers 2 --out /tmp/cua-seed.json
node scripts/qa/prepare-cua-candidate.mjs --app "$APP" --seed-db /tmp/cua-seed/project.db --out /tmp/cua-r0
```
Expected: `/tmp/cua-r0/gate.json` status PASS，`manifest.candidate.supportDirectory/default/project.db` 存在且 `sqlite3 … "select count(*) from clips"` 为 8。

- [ ] **Step 3: 跑冒烟并先让它红过**

Run: `caffeinate -dims node scripts/qa/smoke-gui.mjs --candidate /tmp/cua-r0`
Expected: 六张截图存在、`PASS db.clips 8`、末行 `PASS`。
校准：`pkill -f '旅剪工作台 QA.app'` 后再跑一次，Expected: `FAIL process.alive` 且末行 `FAIL`。

- [ ] **Step 4: Commit**

```bash
git add scripts/qa/smoke-gui.mjs scripts/qa/prepare-cua-candidate.mjs
git commit -m "qa(gui): 冒烟脚本——⌘K 六页跳转+截图+隔离库预言机,进程死亡与库损坏即红

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

---

### Task 6: 交付包目录改为原稿编号

**Files:**
- Modify: `src-tauri/src/core/deliver.rs:23-28`（常量）、`:2324-2360`（`build_instructions` 文案）、`:3117`、`:3187`、`:3405`、`:3445-3446`（测试字面量）
- Modify: `src-tauri/examples/vfr_repro.rs:179`
- Modify: `docs/USER_GUIDE.md:53-56`、`docs/用户手册.md:109-112`
- Test: `src-tauri/src/core/deliver.rs` 现有测试 + 新增一条目录清单断言

**Interfaces:**
- Produces: 常量名不变，值改为：
```rust
const SELECTED_DIRECTORY: &str = "01_精选原片";
const NARRATION_DIRECTORY: &str = "02_环境声与旁白";   // R2 G10 写旁白稿.txt 用
const SUBTITLE_DIRECTORY: &str = "03_字幕";
const ROUGH_CUT_DIRECTORY: &str = "04_参考粗剪";
const ROUGH_CUT_FILE: &str = "04_参考粗剪/参考粗剪.mp4";
const SHOT_LIST_DIRECTORY: &str = "05_镜头表";
const SHOT_LIST_FILE: &str = "05_镜头表/剪辑清单.csv";
const COLOR_NOTES_DIRECTORY: &str = "06_LUT与色彩说明";  // R3 Pocket 4 用
const DESTINATION_DIRECTORY: &str = "07_地点卡";
const README_FILE: &str = "交付说明.txt";
```
R4 联系表写 `05_镜头表/联系表.pdf`，R3 LUT 说明写 `06_LUT与色彩说明/`。

- [ ] **Step 1: 写失败测试**

在 `deliver.rs` 测试模块末尾加：
```rust
    #[test]
    fn package_layout_follows_owner_numbering() {
        assert_eq!(SELECTED_DIRECTORY, "01_精选原片");
        assert_eq!(NARRATION_DIRECTORY, "02_环境声与旁白");
        assert_eq!(SUBTITLE_DIRECTORY, "03_字幕");
        assert_eq!(ROUGH_CUT_FILE, "04_参考粗剪/参考粗剪.mp4");
        assert_eq!(SHOT_LIST_FILE, "05_镜头表/剪辑清单.csv");
        assert_eq!(COLOR_NOTES_DIRECTORY, "06_LUT与色彩说明");
        assert_eq!(DESTINATION_DIRECTORY, "07_地点卡");
    }
```

- [ ] **Step 2: 跑测试确认红**

Run: `cargo test --manifest-path src-tauri/Cargo.toml package_layout_follows_owner_numbering`
Expected: 编译错误 `NARRATION_DIRECTORY` 未定义。

- [ ] **Step 3: 改常量与创建目录**

把 `:23-28` 换成 Interfaces 里的常量。在 `:699` `create_dir(SELECTED_DIRECTORY)` 之后追加：
```rust
    for directory in [NARRATION_DIRECTORY, ROUGH_CUT_DIRECTORY, SHOT_LIST_DIRECTORY, COLOR_NOTES_DIRECTORY] {
        std::fs::create_dir(staging_path.join(directory))?;
    }
```
`:766` `staging_path.join(ROUGH_CUT_FILE)` 与 `:789` `SHOT_LIST_FILE` 因为常量已带子目录，无需改。`build_instructions`（`:2324` 起）里引用常量的文案自动跟随；把编号句子 `2.`–`6.` 改成按 01–07 顺序描述，并加一句 `“02_环境声与旁白/”与“06_LUT与色彩说明/”本版本为空目录，后续版本填充旁白稿与色彩说明。`

- [ ] **Step 4: 更新测试字面量与示例**

`:3117` `"01_精选片段/001_A.mp4"` → `"01_精选原片/001_A.mp4"`；`:3187` 改用 `DESTINATION_DIRECTORY` 常量（已是）；`:3405` `"03_字幕/001_voice.srt"` 不变；`:3445-3446` 用常量（已是）。`examples/vfr_repro.rs:179` `"01_精选片段"` → `"01_精选原片"`。搜索确认：`grep -rn '01_精选片段\|03_镜头表.csv\|02_参考粗剪.mp4\|05_地点卡' src src-tauri scripts` 应为 0 条。

- [ ] **Step 5: 跑全部 deliver 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml deliver`
Expected: 全部 ok，含新测试。

- [ ] **Step 6: 更新用户文档**

`docs/USER_GUIDE.md:53-56` 与 `docs/用户手册.md:109-112` 的目录树替换为：
```
01_精选原片/            按推荐顺序编号的素材
02_环境声与旁白/        旁白稿(后续版本)
03_字幕/                与素材同序号的 SRT 字幕
04_参考粗剪/参考粗剪.mp4 串好的参考视频
05_镜头表/剪辑清单.csv   每条素材的包内路径、参数、星级、对白摘要
06_LUT与色彩说明/       色彩说明(后续版本)
07_地点卡/              目的地信息卡
交付说明.txt
```
`docs/用户手册.html` 由 `docs/用户手册.md` 生成，若仓库有生成脚本（`grep -rn '用户手册' scripts/`）则重跑，否则手改同一段。

- [ ] **Step 7: 门禁与提交**

Run: `node scripts/qa/fast-gates.mjs`
Expected: PASS。
```bash
git add src-tauri/src/core/deliver.rs src-tauri/examples/vfr_repro.rs docs/USER_GUIDE.md docs/用户手册.md docs/用户手册.html
git commit -m "feat(deliver): 交付包目录改为业主原稿编号 01–07——业主 09-06 批准,预览版无存量用户

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

---

### Task 7: R0 报告与每日收尾实跑

**Files:**
- Create: `docs/qa/2026-09-06-unattended-r0.md`

- [ ] **Step 1: 打 DMG 并跑收尾链**

```bash
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
TRIPCUT_PACKAGE_MODE=qa TRIPCUT_ALLOW_ADHOC=1 TRIPCUT_BUILD_STAMP=$(date -u +%Y%m%dT%H%M%SZ)-r0 ./scripts/package-dmg.sh 2>&1 | tail -5
DMG=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg | head -1); APP=src-tauri/target/release/bundle/macos/旅剪工作台.app
node scripts/qa/audit-dmg.mjs --dmg "$DMG" --expect-signature adhoc --out /tmp/r0-audit
node scripts/qa/preflight.mjs --app "$APP" --dmg "$DMG" --out /tmp/r0-preflight
node scripts/qa/prepare-cua-candidate.mjs --app "$APP" --seed-db /tmp/cua-seed/project.db --out /tmp/r0-cua
caffeinate -dims node scripts/qa/smoke-gui.mjs --candidate /tmp/r0-cua --out /tmp/r0-smoke
node scripts/qa/crash-diff.mjs --baseline /tmp/r0-preflight/manifest.json --out /tmp/r0-crash
```
Expected: 五个 `gate.json` 的 `status` 全为 PASS。任一 FAIL：按总计划 §1 revert 最近合并并记 F 条。

- [ ] **Step 2: 写报告（六节）**

```markdown
# 无人值守 R0 基建 — 2026-09-06

## 1. 目标与工作项
fast-gates 加 build 与 audit / 性能夹具与装置 / smoke-gui / 交付目录重编号。迁移号：本轮无。

## 2. 快照
起始 main <sha> → 结束 <sha>；DMG <文件名> sha256 <值>；target <GB>；剩余磁盘 <GB>；perf 基线 peak RSS <MB> / total <s> / 首屏 <s>。

## 3. 门禁记录
fast-gates <目录> PASS；audit-dmg PASS；preflight PASS；cua PASS；smoke PASS；crash-diff PASS；perf-harness <目录> PASS。

## 4. FINDINGS
F-R0-1 …（现象 → 根因 → 修复提交 → 检测器是否先红过）

## 5. 被 revert 或冻结的项
无。

## 6. 下一轮入口
R1 性能第一批 P1–P4（`artifacts.rs:219` 滤镜顺序、`analysis.rs:370` 场景检测位置、strip/运镜 hwaccel、`-skip_frame nokey`），装置用 `--label before` / `--label after` 各跑一次写两列。
```

- [ ] **Step 3: Commit**

```bash
git add docs/qa/2026-09-06-unattended-r0.md
git commit -m "docs(qa): R0 基建收口——门禁扩展、性能基线、冒烟首跑、目录重编号

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
git rev-list --left-right --count main...origin/main   # 期望 0 0
```
