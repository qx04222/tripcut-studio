//! R15 无头对照:真 worker 池 + 真 ffmpeg 在跑的时候,「撤销一批 / 清空当前集 / 清理缓存」
//! 要让用户等多久。`--mode before` 走 R15 之前的命令路径(`with_maintenance`:等所有
//! 正在跑的任务结束、同步删缓存目录);`--mode after` 走 R15 之后的路径(只暂停认领、
//! 只等本次范围内的任务、缓存目录交 cache_gc)。两种模式跑的是同一份 core 代码,
//! 差别只在等待策略——这正是业主真机上「卡」的那一段。
//!
//! 用法:
//!   cargo run --example reset_driver -- --db <新库> --folder-a <批次 A> --folder-b <批次 B>
//!       --workers 4 --at-secs 45 --mode before|after --action undo-a|clear-all|rebuild
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tripcut_studio_lib::core;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn running_summary(connection: &rusqlite::Connection) -> String {
    let mut statement = connection
        .prepare("SELECT kind, COUNT(*) FROM jobs WHERE status = 'running' GROUP BY kind")
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok(format!("{}×{}", row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    if rows.is_empty() { "无".to_owned() } else { rows.join(" ") }
}

fn main() {
    let db = PathBuf::from(arg("--db").expect("--db"));
    let folder_a = PathBuf::from(arg("--folder-a").expect("--folder-a"));
    let folder_b = arg("--folder-b").map(PathBuf::from);
    let workers: usize = arg("--workers").and_then(|w| w.parse().ok()).unwrap_or(4);
    let at_secs: u64 = arg("--at-secs").and_then(|w| w.parse().ok()).unwrap_or(45);
    let mode = arg("--mode").unwrap_or_else(|| "after".to_owned());
    let action = arg("--action").unwrap_or_else(|| "undo-a".to_owned());
    if db.exists() {
        std::fs::remove_file(&db).expect("清旧库");
    }
    let cache_root = core::artifacts::cache_root_for_db(&db);
    let _ = std::fs::remove_dir_all(&cache_root);

    let mut conn = core::db::open_project(&db).expect("open_project");
    core::settings::set_setting(&conn, core::settings::WORKER_COUNT_KEY, &workers.to_string()).unwrap();
    let batch_a = core::import::start_import(&mut conn, &folder_a).expect("start_import a").batch_id;
    let batch_b = folder_b
        .as_ref()
        .map(|folder_b| core::import::start_import(&mut conn, folder_b).expect("start_import b").batch_id);
    drop(conn);

    let budget = core::memory_profile::budget_bytes();
    let profile = core::memory_profile::profile_for_budget(budget, "auto");
    let runner = Arc::new(core::jobs::JobRunner::new(db.clone(), workers).with_decode_limit(profile.decode_permits()));
    let control = runner.control();
    let stop = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();
    for _ in 0..workers {
        let runner = runner.clone();
        let stop = stop.clone();
        handles.push(thread::spawn(move || loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match runner.run_one_step_with_kind() {
                Ok(Some(_)) => {}
                Ok(None) => thread::sleep(Duration::from_millis(200)),
                Err(error) => {
                    eprintln!("worker: {error}");
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }));
    }

    let started = Instant::now();
    loop {
        let c = core::db::open_project(&db).unwrap();
        let clips: i64 = c.query_row("SELECT COUNT(*) FROM clips", [], |r| r.get(0)).unwrap();
        let pending: i64 = c.query_row("SELECT COUNT(*) FROM jobs WHERE status IN ('pending','running')", [], |r| r.get(0)).unwrap();
        if started.elapsed() >= Duration::from_secs(at_secs) || (pending == 0 && started.elapsed() > Duration::from_secs(5)) {
            let running_a: i64 = c.query_row("SELECT COUNT(*) FROM jobs j JOIN clips c ON c.id = j.clip_id WHERE j.status = 'running' AND c.import_batch_id = ?1", [batch_a], |r| r.get(0)).unwrap();
            println!("T+{:.0}s clips={clips} pending+running={pending} running=[{}] (of which batch A: {running_a})", started.elapsed().as_secs_f64(), running_summary(&c));
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }

    let snapshots = db.parent().unwrap().join("snapshots");
    let request = match action.as_str() {
        "undo-a" => Some(core::import_control::RemovalRequest { batch_id: Some(batch_a), clip_ids: vec![], all: false }),
        // 批次 B 排在 A 后面:A 的分析在跑时撤销 B —— 正是「撤销一批要等别的批次任务」的形状。
        "undo-b" => Some(core::import_control::RemovalRequest { batch_id: batch_b, clip_ids: vec![], all: false }),
        "clear-all" => Some(core::import_control::RemovalRequest { batch_id: None, clip_ids: vec![], all: true }),
        _ => None,
    };
    let clock = Instant::now();
    let label = format!("{action} ({mode})");
    match (request, mode.as_str()) {
        (Some(request), "before") => {
            // R15 之前的 lib.rs 路径:prepare 两次 + with_maintenance(等所有 worker 空闲)
            // + 快照 + 删记录 + 同步删缓存目录。
            let mut c = core::db::open_project(&db).unwrap();
            core::import_control::prepare_removal(&mut c, &request).unwrap();
            drop(c);
            let path = db.clone();
            let cache = cache_root.clone();
            let count = control
                .with_maintenance(
                    || core::db::open_project(&path).and_then(|mut c| core::import_control::prepare_removal(&mut c, &request).map(|_| ())),
                    || {
                        let mut c = core::db::open_project(&path)?;
                        core::db::create_snapshot(&c, &snapshots)?;
                        let ids = core::import_control::removal_ids(&c, &request)?;
                        let count = core::import_control::remove_records(&mut c, &request)?;
                        for id in ids {
                            let directory = cache.join(id.to_string());
                            if directory.exists() {
                                let _ = std::fs::remove_dir_all(&directory);
                            }
                        }
                        Ok(count)
                    },
                )
                .unwrap();
            println!("{label}: removed {count} clips in {:.0} ms", clock.elapsed().as_secs_f64() * 1000.0);
        }
        (Some(request), _) => {
            let mut c = core::db::open_project(&db).unwrap();
            core::import_control::prepare_removal(&mut c, &request).unwrap();
            drop(c);
            let path = db.clone();
            let count = control
                .with_claims_paused(
                    || core::db::open_project(&path).and_then(|mut c| core::import_control::prepare_removal(&mut c, &request).map(|_| ())),
                    || {
                        let mut c = core::db::open_project(&path)?;
                        let ids = core::import_control::removal_ids(&c, &request)?;
                        let waited = Instant::now();
                        core::import_control::wait_for_related_jobs(&c, &ids, Duration::from_secs(5))?;
                        println!("  waited {:.0} ms for related running jobs", waited.elapsed().as_secs_f64() * 1000.0);
                        core::db::create_snapshot(&c, &snapshots)?;
                        core::import_control::remove_records(&mut c, &request)
                    },
                )
                .unwrap();
            control.wake_worker();
            println!("{label}: removed {count} clips in {:.0} ms", clock.elapsed().as_secs_f64() * 1000.0);
        }
        (None, "before") => {
            let path = db.clone();
            let cache = cache_root.clone();
            let result = control
                .with_maintenance(
                    || core::db::open_project(&path).and_then(|mut c| core::jobs::cancel_cache_jobs(&mut c).map(|_| ())),
                    || {
                        let mut c = core::db::open_project(&path)?;
                        let result = core::settings::clear_cache_and_rebuild(&mut c, &cache)?;
                        // 旧路径同步删旧目录:这里把 cache_gc 登记的退役目录立刻删掉,等价于旧行为。
                        for entry in std::fs::read_dir(cache.parent().unwrap()).unwrap().flatten() {
                            let name = entry.file_name().to_string_lossy().into_owned();
                            if name.starts_with(".cache") {
                                let _ = std::fs::remove_dir_all(entry.path());
                            }
                        }
                        Ok(result)
                    },
                )
                .unwrap();
            println!("{label}: reset_jobs={} removed_bytes={} in {:.0} ms", result.reset_jobs, result.removed_disk_bytes, clock.elapsed().as_secs_f64() * 1000.0);
        }
        (None, _) => {
            let path = db.clone();
            let cache = cache_root.clone();
            let result = control
                .with_claims_paused(
                    || core::db::open_project(&path).and_then(|mut c| core::jobs::cancel_cache_jobs(&mut c).map(|_| ())),
                    || {
                        let mut c = core::db::open_project(&path)?;
                        let waited = Instant::now();
                        core::jobs::wait_until_no_running(&c, &format!("kind IN {}", core::jobs::CACHE_JOB_KINDS_SQL), &[], Duration::from_secs(5))?;
                        println!("  waited {:.0} ms for running cache jobs", waited.elapsed().as_secs_f64() * 1000.0);
                        core::settings::clear_cache_and_rebuild(&mut c, &cache)
                    },
                )
                .unwrap();
            control.wake_worker();
            println!("{label}: reset_jobs={} removed_bytes={} in {:.0} ms", result.reset_jobs, result.removed_disk_bytes, clock.elapsed().as_secs_f64() * 1000.0);
        }
    }
    {
        let c = core::db::open_project(&db).unwrap();
        println!("after: clips={} running=[{}] cache_gc pending={}",
            c.query_row::<i64, _, _>("SELECT COUNT(*) FROM clips", [], |r| r.get(0)).unwrap(),
            running_summary(&c),
            core::cache_gc::pending_count(&c).unwrap());
    }
    // 让 cache_gc 等后台任务再跑一会儿,看它是否顺利收尾。
    thread::sleep(Duration::from_secs(3));
    {
        let c = core::db::open_project(&db).unwrap();
        println!("+3s: cache_gc pending={} running=[{}]", core::cache_gc::pending_count(&c).unwrap(), running_summary(&c));
    }
    stop.store(true, Ordering::Relaxed);
    let mut c = core::db::open_project(&db).unwrap();
    let _ = core::jobs::cancel_all_jobs(&mut c);
    for handle in handles {
        let _ = handle.join();
    }
}
