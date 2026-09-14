//! R15 删除 / 重置路径计时器:对一份项目库副本(以及按 `cache_artifacts` 重建出来的
//! 缓存目录)逐段计时「清空当前集素材」与「清理缓存并重新分析」走过的每一步。
//!
//! 用法:
//!   cargo run --example reset_bench -- --db <项目库副本> [--materialize-cache]
//!
//! `--materialize-cache` 会按 `cache_artifacts` 里记录的大小在 `<db 所在目录>/cache/`
//! 写出同样大小的占位文件(只在副本目录里写,原始素材永远不碰)。
use std::path::{Path, PathBuf};
use std::time::Instant;

use tripcut_studio_lib::core;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn flag(name: &str) -> bool {
    std::env::args().any(|a| a == name)
}

fn timed<T>(label: &str, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = work();
    println!("{label}: {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
    value
}

fn materialize_cache(db: &Path, cache_root: &Path) {
    let connection = core::db::open_project(db).expect("open");
    let mut statement = connection
        .prepare("SELECT rel_path, bytes FROM cache_artifacts")
        .expect("prepare");
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .expect("query")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows");
    let mut total = 0_u64;
    for (rel, bytes) in &rows {
        let path = cache_root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        let file = std::fs::File::create(&path).expect("create");
        file.set_len((*bytes).max(1) as u64).expect("set_len");
        total += *bytes as u64;
    }
    println!(
        "materialized {} cache files, {:.0} MB (sparse)",
        rows.len(),
        total as f64 / 1e6
    );
}

fn main() {
    let db = PathBuf::from(arg("--db").expect("--db <project.db copy>"));
    let cache_root = core::artifacts::cache_root_for_db(&db);
    if flag("--materialize-cache") {
        materialize_cache(&db, &cache_root);
    }
    let mut connection = core::db::open_project(&db).expect("open");
    let clips: i64 = connection
        .query_row("SELECT count(*) FROM clips", [], |row| row.get(0))
        .expect("count");
    let jobs: i64 = connection
        .query_row("SELECT count(*) FROM jobs", [], |row| row.get(0))
        .expect("count");
    println!("clips={clips} jobs={jobs} cache_root={}", cache_root.display());

    timed("list_clips (one UI poll)", || core::import::list_clips(&connection).expect("list"));

    if flag("--rebuild") {
        let result = timed("clear_cache_and_rebuild", || {
            core::settings::clear_cache_and_rebuild(&mut connection, &cache_root).expect("rebuild")
        });
        println!(
            "  removed_rows={} reset_jobs={} removed_bytes={}",
            result.removed_database_rows, result.reset_jobs, result.removed_disk_bytes
        );
        return;
    }

    let request = core::import_control::RemovalRequest { batch_id: None, clip_ids: vec![], all: true };
    timed("prepare_removal #1 (outside gate)", || {
        core::import_control::prepare_removal(&mut connection, &request).expect("prepare")
    });
    timed("prepare_removal #2 (maintenance prepare)", || {
        core::import_control::prepare_removal(&mut connection, &request).expect("prepare")
    });
    let snapshots = db.parent().unwrap().join("snapshots");
    timed("create_snapshot (VACUUM INTO)", || {
        core::db::create_snapshot(&connection, &snapshots).expect("snapshot")
    });
    let ids = timed("removal_ids", || {
        core::import_control::removal_ids(&connection, &request).expect("ids")
    });
    let count = timed("remove_records (one transaction)", || {
        core::import_control::remove_records(&mut connection, &request).expect("remove")
    });
    timed(&format!("remove_dir_all x{} (cache dirs; in-app this is the cache_gc job)", ids.len()), || {
        for id in &ids {
            let directory = cache_root.join(id.to_string());
            if directory.exists() {
                std::fs::remove_dir_all(&directory).expect("rm");
            }
        }
    });
    println!("removed {count} clips");
}
