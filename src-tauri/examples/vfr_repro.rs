//! 单条 VFR 素材的完整核心链路复现器。
//!
//! 把一条测试用 VFR 素材的绝对路径作为第一个参数传入。
//! 复现产物会保留在打印出的临时目录中。

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use tripcut_studio_lib::core;

type ReproResult<T> = Result<T, Box<dyn Error>>;

fn main() {
    if let Err(error) = run() {
        eprintln!("vfr_repro failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> ReproResult<()> {
    let fixture = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: cargo run --example vfr_repro -- /absolute/path/to/vfr-video.mp4")?;
    if !fixture.is_file() {
        return Err(format!("VFR fixture is not a file: {}", fixture.display()).into());
    }

    let repro_root = fresh_repro_root()?;
    let database_path = repro_root.join("project.db");
    let export_root = repro_root.join("export");
    fs::create_dir(&export_root)?;

    println!("fixture={}", fixture.display());
    println!("repro_root={}", repro_root.display());
    println!("database={}", database_path.display());
    println!("export_root={}", export_root.display());

    let mut connection = core::db::open_project(&database_path)?;
    core::import::start_import_files(&mut connection, std::slice::from_ref(&fixture))?;
    drop(connection);
    drain_jobs(&database_path)?;

    let mut connection = core::db::open_project(&database_path)?;
    core::similar::enqueue_if_ready(&mut connection)?;
    drop(connection);
    drain_jobs(&database_path)?;

    let mut connection = core::db::open_project(&database_path)?;
    let clip_id = connection
        .query_row("SELECT id FROM clips ORDER BY id LIMIT 1", [], |row| row.get::<_, i64>(0))
        .optional()?
        .ok_or("import did not create a clip row")?;
    core::ratings::rate_clip(
        &mut connection,
        clip_id,
        core::ratings::BINARY_RATING,
        1,
    )?;
    let export = core::deliver::start_export(&mut connection, &export_root)?;
    let export_job_id = export.job_id.ok_or("export did not create a job")?;
    drop(connection);
    drain_jobs(&database_path)?;

    let connection = core::db::open_project(&database_path)?;
    print_jobs(&connection)?;
    let vfr_rows: i64 = connection.query_row(
        "SELECT COUNT(*) FROM vfr_time_map WHERE clip_id = ?1",
        [clip_id],
        |row| row.get(0),
    )?;
    let proxy_rows: i64 = connection.query_row(
        "SELECT COUNT(*) FROM proxy_time_map WHERE clip_id = ?1",
        [clip_id],
        |row| row.get(0),
    )?;
    let export = core::deliver::get_export_status(&connection, Some(export_job_id))?;
    let exported = latest_export_contains_clip(&connection, clip_id)?;
    println!("clip_id={clip_id}");
    println!("vfr_time_map_rows={vfr_rows}");
    println!("proxy_time_map_rows={proxy_rows}");
    println!("export_status={}", export.status);
    println!("export_output={}", export.output_path.as_deref().unwrap_or("<none>"));
    println!("export_contains_clip={exported}");
    Ok(())
}

fn fresh_repro_root() -> ReproResult<PathBuf> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let root = std::env::temp_dir().join(format!(
        "tripcut-vfr-repro-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root)?;
    Ok(root)
}

fn drain_jobs(database_path: &Path) -> ReproResult<()> {
    let started = Instant::now();
    loop {
        if core::jobs::JobRunner::run_one(database_path)? {
            continue;
        }
        let connection = core::db::open_project(database_path)?;
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status IN ('pending', 'running')",
            [],
            |row| row.get(0),
        )?;
        if active == 0 {
            return Ok(());
        }
        if started.elapsed() >= Duration::from_secs(12 * 60 * 60) {
            return Err(format!("job drain timed out with {active} active jobs").into());
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn print_jobs(connection: &Connection) -> ReproResult<()> {
    let mut statement = connection.prepare(
        "SELECT kind, status, COALESCE(blocked_summary, '')
         FROM jobs ORDER BY kind, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (kind, status, blocked_summary) = row?;
        println!(
            "job kind={kind} status={status} blocked_summary={}",
            if blocked_summary.is_empty() {
                "<none>"
            } else {
                &blocked_summary
            }
        );
    }
    Ok(())
}

fn latest_export_contains_clip(connection: &Connection, clip_id: i64) -> ReproResult<bool> {
    let export = connection
        .query_row(
            "SELECT manifest, output_path FROM exports ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((manifest, output_path)) = export else {
        return Ok(false);
    };
    let value: Value = serde_json::from_str(&manifest)?;
    let clips = value
        .get("clips")
        .and_then(Value::as_array)
        .ok_or("export manifest lacks clips")?;
    let items = value
        .pointer("/progress/items")
        .and_then(Value::as_array)
        .ok_or("export manifest lacks progress.items")?;
    let output_name = clips.iter().zip(items).find_map(|(clip, item)| {
        (clip.get("clip_id").and_then(Value::as_i64) == Some(clip_id)
            && item.get("status").and_then(Value::as_str) == Some("done"))
        .then(|| item.get("output_name").and_then(Value::as_str))
        .flatten()
    });
    Ok(output_name.is_some_and(|name| {
        Path::new(&output_path)
            .join("01_精选片段")
            .join(name)
            .is_file()
    }))
}
