//! 性能验收驱动:无头导入夹具目录,N 线程跑任务队列,采样进程组 RSS,输出 result.json。
//! 用法: cargo run --release --example perf_driver -- --db <新库路径> --folder <夹具目录> --workers 4 --out result.json
use std::collections::HashMap;
use std::path::PathBuf;
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
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx]
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    format!("unix:{secs}")
}

fn main() {
    let db = PathBuf::from(arg("--db").expect("--db"));
    let folder = PathBuf::from(arg("--folder").expect("--folder"));
    let workers: usize = arg("--workers").and_then(|w| w.parse().ok()).unwrap_or(4);
    let out = PathBuf::from(arg("--out").unwrap_or_else(|| "result.json".into()));
    if db.exists() {
        std::fs::remove_file(&db).expect("清旧库");
    }
    let mut conn = core::db::open_project(&db).expect("open_project");
    core::settings::set_setting(&conn, core::settings::WORKER_COUNT_KEY, &workers.to_string()).unwrap();
    let started = Instant::now();
    let started_at = chrono_now();
    let swap_before = swapouts();
    core::import::start_import(&mut conn, folder.as_path()).expect("start_import");
    drop(conn);

    // F-R1-9: 走真协调器,不是每次调用都新建一个空协调器的 `JobRunner::run_one`。
    // `JobRunner::new(..).with_decode_limit(..)` 与 `src-tauri/src/lib.rs` 生产
    // 接线用的是同一套 API,decode_permits 也来自同一个
    // `memory_profile::profile_for_budget`(读 `TRIPCUT_MEMORY_BUDGET_BYTES`,
    // 与 `perf-harness.mjs` 的 `--budget-gb` 接的是同一个环境变量)。所有 worker
    // 线程共享同一个 `Arc<JobRunner>`,因此共享同一份解码/大模型许可与内存
    // 暂停状态——这正是此前 `run_one()` 每次新建协调器所绕开的那部分。
    let budget = core::memory_profile::budget_bytes();
    let profile = core::memory_profile::profile_for_budget(budget, "auto");
    let decode_permits = profile.decode_permits();
    let runner = Arc::new(core::jobs::JobRunner::new(db.clone(), workers).with_decode_limit(decode_permits));

    let stop = Arc::new(AtomicBool::new(false));
    // R15-perf:每条任务记 (kind, 距开跑的起点 ms, 耗时 ms),result.json 里多一份 `timeline`,
    // 单文件夹具跑时能直接读出每个阶段的先后与首个封面/首条分析到位的时刻。
    let timings: Arc<Mutex<Vec<(String, u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();

    // 内存压力轮询线程:与生产 `JobRunner::run()` 里的 `watch_memory_pressure`
    // 调的是同一个 `poll_memory_pressure_once`(经由 `poll_memory_pressure`
    // 公开出口),只是节奏由这里的采样循环自己敲,不依赖 tokio 事件循环。
    {
        let runner = runner.clone();
        let stop = stop.clone();
        handles.push(thread::spawn(move || loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            runner.poll_memory_pressure();
            thread::sleep(Duration::from_secs(5));
        }));
    }

    for _ in 0..workers {
        let runner = runner.clone();
        let stop = stop.clone();
        let timings = timings.clone();
        let run_started = started;
        handles.push(thread::spawn(move || loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let t = Instant::now();
            let start_ms = t.duration_since(run_started).as_millis() as u64;
            // 直接拿 `run_one_step_with_kind` 带出来的 kind,不再另开一条
            // 连接去查"最近完成的是哪条"——那条全局 `ORDER BY finished_at
            // DESC LIMIT 1` 在多个 worker 几毫秒内先后收尾时会撞车,把
            // strip/ocr_scan 这类几毫秒就跑完的任务重复计数(500 条素材曾
            // 记出 1027 条 strip 计时样本)。
            match runner.run_one_step_with_kind() {
                Ok(Some(kind)) => {
                    let ms = t.elapsed().as_millis() as u64;
                    timings.lock().unwrap().push((kind, start_ms, ms));
                }
                Ok(None) => thread::sleep(Duration::from_millis(200)),
                Err(e) => {
                    eprintln!("run_one_step_with_kind: {e}");
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }));
    }

    let mut samples: Vec<u64> = Vec::new();
    let mut first_screen_ms: Option<u64> = None;
    let mut all_cover_ms: Option<u64> = None;
    let fixtures = std::fs::read_dir(&folder)
        .unwrap()
        .filter(|e| e.as_ref().unwrap().path().extension().map(|x| x == "mp4").unwrap_or(false))
        .count() as i64;
    loop {
        samples.push(pgid_rss_bytes());
        let c = core::db::open_project(&db).unwrap();
        let covers: i64 = c.query_row("SELECT COUNT(*) FROM cache_artifacts WHERE kind='cover'", [], |r| r.get(0)).unwrap();
        if first_screen_ms.is_none() && covers >= 24 {
            first_screen_ms = Some(started.elapsed().as_millis() as u64);
        }
        if all_cover_ms.is_none() && covers >= fixtures {
            all_cover_ms = Some(started.elapsed().as_millis() as u64);
        }
        let active: i64 = c.query_row("SELECT COUNT(*) FROM jobs WHERE status IN ('pending','running')", [], |r| r.get(0)).unwrap();
        if active == 0 && started.elapsed() > Duration::from_secs(5) {
            break;
        }
        if started.elapsed() > Duration::from_secs(6 * 3600) {
            eprintln!("timeout");
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
    stop.store(true, Ordering::Relaxed);
    for h in handles {
        let _ = h.join();
    }

    let c = core::db::open_project(&db).unwrap();
    // clip_embed 依赖单独打包/下载的 Chinese-CLIP 模型(TRIPCUT_CLIP_MODEL_DIR)。
    // 缺模型时它会整批 blocked——这一种状态与本轮要验收的视频处理管道性能无关,
    // 从 jobs 汇总里排除,但排除数量写进 "excluded" 字段,不再无声消失。
    // clip_embed 的 done/failed 与其它 kind 一样正常计数——它若真的失败,不能被这条排除藏起来。
    let clip_embed_blocked: i64 = c
        .query_row("SELECT COUNT(*) FROM jobs WHERE status='blocked' AND kind='clip_embed'", [], |r| r.get(0))
        .unwrap();
    let count = |s: &str| -> i64 {
        c.query_row(
            &format!("SELECT COUNT(*) FROM jobs WHERE status='{s}' AND NOT (status='blocked' AND kind='clip_embed')"),
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    samples.sort_unstable();
    let mut by_kind: HashMap<String, Vec<u64>> = HashMap::new();
    let mut timeline: Vec<(String, u64, u64)> = timings.lock().unwrap().clone();
    timeline.sort_by_key(|(_, start, _)| *start);
    for (k, _, ms) in timeline.iter() {
        by_kind.entry(k.clone()).or_default().push(*ms);
    }
    let timeline: Vec<serde_json::Value> = timeline
        .into_iter()
        .map(|(kind, start_ms, ms)| json!({"kind": kind, "start_ms": start_ms, "ms": ms}))
        .collect();
    let stages: serde_json::Map<String, serde_json::Value> = by_kind
        .into_iter()
        .map(|(k, mut v)| {
            v.sort_unstable();
            (k, json!({"count": v.len(), "p50_ms": percentile(&v, 0.5), "p95_ms": percentile(&v, 0.95)}))
        })
        .collect();
    let result = json!({
        "schema_version": 1, "started_at": started_at, "finished_at": chrono_now(),
        "workers": workers, "fixtures": fixtures,
        "rss_bytes": {"peak": samples.last().copied().unwrap_or(0), "p95": percentile(&samples, 0.95)},
        "swapouts_delta": swapouts().saturating_sub(swap_before),
        "first_screen_cover_ms": first_screen_ms, "all_cover_ms": all_cover_ms,
        "total_ms": started.elapsed().as_millis() as u64,
        "stages": stages,
        "timeline": timeline,
        "jobs": {"done": count("done"), "failed": count("failed"), "blocked": count("blocked")},
        "excluded": {"clip_embed_blocked": clip_embed_blocked},
    });
    std::fs::write(&out, serde_json::to_string_pretty(&result).unwrap()).unwrap();
    println!("{}", out.display());
}
