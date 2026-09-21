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

/// R18 W-4:开窗前耗时的尺子。同一个库、同一台机器上量两件事:
/// - `legacy`:R18 之前 `setup()` 里开窗**之前**跑完的那一整段(14 步,含整库 `VACUUM INTO`);
/// - `deferred`:R18 之后开窗前只剩的两步(原片存活检查 + library_census)。
///
/// 每一轮都从一份干净副本开跑(入队是幂等的,第二轮就没活干了,不换副本量出来的是假数)。
fn startup_bench(source_db: &std::path::Path, cache_root: &std::path::Path, rounds: usize, clips: usize) {
    let scratch = source_db.parent().expect("db 的父目录").join("startup-bench");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).expect("建 bench 目录");

    // 先把库灌到目标条数:复制现有 clips 行(rel_path 唯一,加后缀)。
    let seed = scratch.join("seed.db");
    std::fs::copy(source_db, &seed).expect("复制种子库");
    {
        let mut connection = core::db::open_project(&seed).expect("open seed");
        let existing: i64 = connection
            .query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))
            .unwrap();
        let mut next = existing;
        let mut round = 0;
        while (next as usize) < clips {
            round += 1;
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "INSERT INTO clips(volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den,
                                       duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                                       captured_at, imported_at, hdr_flag, color_transfer)
                       SELECT volume_uuid, rel_path || '-bench' || ?1, byte_size, quick_hash || ?1, tb_num, tb_den,
                              duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                              captured_at, imported_at, hdr_flag, color_transfer
                         FROM clips WHERE rel_path NOT LIKE '%-bench%'",
                    rusqlite::params![round],
                )
                .unwrap();
            transaction.commit().unwrap();
            next = connection
                .query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))
                .unwrap();
        }
        eprintln!("startup-bench: 库里 {next} 条素材");
    }

    let mut legacy_ms = Vec::new();
    let mut deferred_ms = Vec::new();
    for round in 0..rounds {
        for legacy in [true, false] {
            let working = scratch.join(format!("round-{round}-{}.db", if legacy { "legacy" } else { "deferred" }));
            std::fs::copy(&seed, &working).expect("复制工作副本");
            let snapshots_root = scratch.join(format!("snap-{round}-{legacy}"));
            std::fs::create_dir_all(&snapshots_root).unwrap();
            let mut connection = core::db::open_project(&working).expect("open working");
            let started = Instant::now();
            // 两条路都要跑的:原片存活检查(首屏的「文件不见了」标记)。
            let _ = core::media_source::refresh_missing_flags_throttled(&connection, Duration::from_secs(60));
            if legacy {
                let _ = core::import::enqueue_metadata_backfill(&mut connection);
                let _ = core::artifacts::enqueue_missing_strips(&mut connection);
                if core::memory_profile::sidecars_enabled(&connection) {
                    let _ = core::clip_search::enqueue_missing(&mut connection, cache_root);
                }
                let _ = core::analysis::enqueue_missing(&mut connection);
                let _ = core::motion::enqueue_missing(&mut connection);
                let _ = core::moments::enqueue_missing(&mut connection);
                let _ = core::clip_dimensions::enqueue_missing(&mut connection, cache_root);
                let _ = core::similar::enqueue_if_ready(&mut connection);
                let _ = core::story::enqueue_if_import_complete(&mut connection);
                let _ = core::canonical_time::enqueue_align_if_ready(&mut connection);
                let _ = core::asset_safety::refresh_all(&mut connection);
                let _ = core::shot_stack::rebuild(&mut connection);
            }
            // 两条路都要跑的:A16-02 的取证判据。
            let _ = core::db::library_census(&connection, &snapshots_root);
            if legacy {
                let _ = core::db::create_snapshot(&connection, &snapshots_root);
            }
            let elapsed = started.elapsed().as_millis() as u64;
            if legacy {
                legacy_ms.push(elapsed);
            } else {
                deferred_ms.push(elapsed);
            }
        }
    }
    legacy_ms.sort_unstable();
    deferred_ms.sort_unstable();
    println!(
        "startup-bench rounds={rounds} legacy_ms={legacy_ms:?} median={} deferred_ms={deferred_ms:?} median={}",
        legacy_ms[legacy_ms.len() / 2],
        deferred_ms[deferred_ms.len() / 2]
    );
}

fn main() {
    if let Some(source) = arg("--startup-bench") {
        let cache_root = PathBuf::from(arg("--cache-root").unwrap_or_else(|| "/tmp/tripcut-bench-cache".to_owned()));
        let rounds: usize = arg("--rounds").and_then(|r| r.parse().ok()).unwrap_or(3);
        let clips: usize = arg("--clips").and_then(|c| c.parse().ok()).unwrap_or(1344);
        startup_bench(std::path::Path::new(&source), &cache_root, rounds, clips);
        return;
    }
    let db = PathBuf::from(arg("--db").expect("--db"));
    let folder = PathBuf::from(arg("--folder").expect("--folder"));
    let workers: usize = arg("--workers").and_then(|w| w.parse().ok()).unwrap_or(4);
    let out = PathBuf::from(arg("--out").unwrap_or_else(|| "result.json".into()));
    if db.exists() {
        std::fs::remove_file(&db).expect("清旧库");
    }
    // R16:`--low-spec auto|on|off` 写 `performance.low_spec_mode`,与设置页同一把键。
    let low_spec_mode = arg("--low-spec").unwrap_or_else(|| "auto".to_owned());
    // R18 W-2:`--effort eco|balanced|full` 写 `performance.background_effort`,与设置页同一把键。
    let effort = arg("--effort").unwrap_or_else(|| core::settings::DEFAULT_BACKGROUND_EFFORT.to_owned());
    let mut conn = core::db::open_project(&db).expect("open_project");
    core::settings::set_setting(&conn, core::settings::WORKER_COUNT_KEY, &workers.to_string()).unwrap();
    core::settings::set_setting(&conn, core::settings::LOW_SPEC_MODE_KEY, &low_spec_mode).unwrap();
    core::settings::set_setting(&conn, core::settings::BACKGROUND_EFFORT_KEY, &effort).unwrap();
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
    let profile = core::memory_profile::profile_for_budget_and_mode(budget, "auto", &low_spec_mode);
    // R16:worker 数按档位封顶(低配档 2),与 lib.rs 一致;整套解码策略走 `with_memory_profile`。
    let workers = workers.min(profile.max_worker_count());
    // R18 W-1:把新档位的四个数字打出来,别让它们只活在代码里。
    let machine = core::machine::current();
    let permits = profile.decode_permits_for_effort(&effort);
    eprintln!(
        "machine: chip={} media_engines={} perf_cores={} eff_cores={} memory={} MiB",
        machine.chip.as_str(),
        machine.media_engines(),
        machine.perf_cores,
        machine.efficiency_cores,
        machine.memory_bytes >> 20
    );
    eprintln!(
        "memory profile: {} (effort {effort} → decode_permits {permits}, heavy_model_limit {}, workers {workers})",
        profile.as_str(),
        profile.heavy_model_limit()
    );
    let runner = Arc::new(
        core::jobs::JobRunner::new(db.clone(), workers)
            .with_memory_profile(profile)
            .with_decode_limit(permits),
    );

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
    let mut all_photo_cover_observed_ms: Option<u64> = None;
    let mut all_preview_ms: Option<u64> = None;
    // R18:原来只数 `.mp4`,`.mov` 为主的夹具上 `fixtures` 恒为 0、`first_screen_cover_ms`
    // 恒为 null(阈值写死 24 也大于夹具条数)——两个字段静默失效。现在递归数所有
    // 常见视频后缀,首屏阈值取「一屏 12 张与夹具总数的较小者」。
    fn count_media(directory: &std::path::Path) -> (i64,i64) {
        const MEDIA_EXTENSIONS: [&str; 14] = ["mp4", "mov", "m4v", "avi", "mkv", "mts", "jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff"];
        const PHOTO_EXTENSIONS: [&str; 8] = ["jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff"];
        let Ok(entries) = std::fs::read_dir(directory) else {
            return (0,0);
        };
        entries
            .filter_map(|entry| entry.ok())
            .map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    return count_media(&path);
                }
                let extension=path.extension().and_then(|value|value.to_str()).unwrap_or("");
                (
                    i64::from(MEDIA_EXTENSIONS.iter().any(|known|known.eq_ignore_ascii_case(extension))),
                    i64::from(PHOTO_EXTENSIONS.iter().any(|known|known.eq_ignore_ascii_case(extension))),
                )
            })
            .fold((0,0),|(media,photos),(next_media,next_photos)|(media+next_media,photos+next_photos))
    }
    let (fixtures,photo_fixtures) = count_media(&folder);
    let first_screen_target = fixtures.clamp(1, 12);
    // R18:采样循环原来**每 500 ms 新开一次 `open_project`**。8 个 worker 正在狂写同一个
    // 库时,这一次打开要等写锁(busy_timeout 5 s),于是 `total_ms` 被量化成 5 s 的整数倍
    // (实测 20 083 / 25 095 / 30 104 / 35 120 ms),而且采样自己还在给被测系统加写锁竞争。
    // 现在整个循环共用一条只读连接。
    let poll = core::db::open_project(&db).unwrap();
    loop {
        samples.push(pgid_rss_bytes());
        let c = &poll;
        let covers: i64 = c.query_row("SELECT COUNT(*) FROM cache_artifacts WHERE kind='cover'", [], |r| r.get(0)).unwrap();
        if first_screen_ms.is_none() && covers >= first_screen_target {
            first_screen_ms = Some(started.elapsed().as_millis() as u64);
        }
        if all_cover_ms.is_none() && covers >= fixtures {
            all_cover_ms = Some(started.elapsed().as_millis() as u64);
        }
        let photo_covers:i64=c.query_row("SELECT COUNT(*) FROM cache_artifacts a JOIN clips c ON c.id=a.clip_id WHERE a.kind='cover' AND c.kind='photo'",[],|r|r.get(0)).unwrap();
        // 照片工作台的 cover/preview 门禁只等待照片登记完成；混合导入里的视频
        // import_probe 属于独立视频工作台，不能把已完成的 100 张照片继续记成未完成。
        let registrations_busy:i64=c.query_row("SELECT COUNT(*) FROM jobs WHERE kind='photo_probe' AND status IN ('pending','running')",[],|r|r.get(0)).unwrap();
        let photos:i64=c.query_row("SELECT COUNT(*) FROM clips WHERE kind='photo'",[],|r|r.get(0)).unwrap();
        if all_photo_cover_observed_ms.is_none() && registrations_busy==0 && photos>0 && photo_covers>=photos {
            all_photo_cover_observed_ms=Some(started.elapsed().as_millis() as u64);
        }
        let previews:i64=c.query_row("SELECT COUNT(*) FROM jobs WHERE kind='photo_preview' AND status='done'",[],|r|r.get(0)).unwrap();
        if all_preview_ms.is_none() && registrations_busy==0 && photos>0 && previews>=photos {
            all_preview_ms=Some(started.elapsed().as_millis() as u64);
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
    drop(poll);

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
    let photo_clips:i64=c.query_row("SELECT COUNT(*) FROM clips WHERE kind='photo'",[],|row|row.get(0)).unwrap();
    samples.sort_unstable();
    let mut by_kind: HashMap<String, Vec<u64>> = HashMap::new();
    let mut timeline: Vec<(String, u64, u64)> = timings.lock().unwrap().clone();
    timeline.sort_by_key(|(_, start, _)| *start);
    // R21 照片导入已在 photo_probe 内用同一个 ImageIO source 原子发布 cover；
    // 任务结束时间就是最后一张 cover 的真实完成时间。轮询值另存 observed，避免
    // SQLite 锁等待和 500 ms 采样粒度污染 ≤4 s 的解码判据。
    let all_photo_cover_ms=timeline.iter()
        .filter(|(kind,_,_)|kind=="photo_probe")
        .map(|(_,start,duration)|start.saturating_add(*duration))
        .max();
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
        "workers": workers, "fixtures": fixtures, "photo_fixtures": photo_fixtures, "photo_clips": photo_clips,
        "profile": profile.as_str(), "effort": effort, "decode_permits": permits,
        "chip": machine.chip.as_str(), "media_engines": machine.media_engines(),
        "rss_bytes": {"peak": samples.last().copied().unwrap_or(0), "p95": percentile(&samples, 0.95)},
        "swapouts_delta": swapouts().saturating_sub(swap_before),
        "first_screen_cover_ms": first_screen_ms, "all_cover_ms": all_cover_ms,
        "all_photo_cover_ms": all_photo_cover_ms,
        "all_photo_cover_observed_ms": all_photo_cover_observed_ms,
        "all_preview_ms": all_preview_ms,
        "total_ms": started.elapsed().as_millis() as u64,
        "stages": stages,
        "timeline": timeline,
        "jobs": {"done": count("done"), "failed": count("failed"), "blocked": count("blocked")},
        "excluded": {"clip_embed_blocked": clip_embed_blocked},
    });
    std::fs::write(&out, serde_json::to_string_pretty(&result).unwrap()).unwrap();
    println!("{}", out.display());
}
