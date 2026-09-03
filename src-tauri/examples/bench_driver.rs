//! TripCut benchmark application driver.
//!
//! Usage:
//! cargo run --example bench_driver -- --request /abs/request.json --output /abs/observations.json

use std::collections::HashMap;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tripcut_studio_lib::core;

type DriverResult<T> = Result<T, Box<dyn Error>>;

const DRIVER_VERSION: &str = "2";
const JOB_DRAIN_TIMEOUT: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Debug, Deserialize)]
struct BenchmarkRequest {
    schema_version: u32,
    run_id: String,
    manifest_digest: String,
    database_path: PathBuf,
    export_directory: PathBuf,
    l3_mode: String,
    fixtures: Vec<FixtureRequest>,
}

#[derive(Debug, Deserialize)]
struct FixtureRequest {
    id: String,
    group: String,
    source_path: PathBuf,
    #[serde(default)]
    vfr_checkpoints_us: Vec<i64>,
    #[serde(default)]
    proxy_checkpoints_us: Vec<i64>,
}

#[derive(Debug, Serialize)]
struct ObservationsDocument {
    schema_version: u32,
    run: RunEvidence,
    workflow: WorkflowEvidence,
    fixtures: Vec<FixtureObservation>,
}

#[derive(Debug, Serialize)]
struct RunEvidence {
    app_version: String,
    driver_version: String,
    started_at: String,
    finished_at: String,
    run_id: String,
    manifest_digest: String,
    errors: Vec<String>,
    job_summary: Value,
    export_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct WorkflowEvidence {
    import: String,
    import_failed_ids: Vec<String>,
    analysis: String,
    stack: String,
    l3: String,
    export: String,
}

#[derive(Debug, Serialize)]
struct FixtureObservation {
    id: String,
    scene_boundaries_us: Vec<i64>,
    stack_id: Option<String>,
    recommended: bool,
    retained: bool,
    rejected: bool,
    important_event_detected: bool,
    vfr_mappings: Vec<PtsMapping>,
    proxy_mappings: Vec<PtsMapping>,
    routine_repeated_in_story: bool,
    group: String,
    source_path: String,
    clip_id: Option<i64>,
    evidence_errors: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct PtsMapping {
    source_pts_us: i64,
    mapped_source_pts_us: i64,
}

fn main() {
    let (request_path, output_path) = match parse_args() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("bench_driver: {error}");
            std::process::exit(2);
        }
    };
    let request = match read_request(&request_path) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("bench_driver: {error}");
            std::process::exit(2);
        }
    };
    let mut observations = empty_observations(&request);
    let result = run_workflow(&request, &mut observations);
    observations.run.finished_at = timestamp();
    if let Err(error) = &result {
        observations.run.errors.push(error.to_string());
    }
    if let Err(error) = write_observations(&output_path, &observations) {
        eprintln!("bench_driver: failed to write {}: {error}", output_path.display());
        std::process::exit(1);
    }
    if let Err(error) = result {
        eprintln!("bench_driver: {error}");
        std::process::exit(1);
    }
}

fn parse_args() -> DriverResult<(PathBuf, PathBuf)> {
    let mut request = None;
    let mut output = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(argument) = args.next() {
        match argument.to_str() {
            Some("--request") => request = args.next().map(PathBuf::from),
            Some("--output") => output = args.next().map(PathBuf::from),
            _ => return Err(format!("unknown argument: {}", argument.to_string_lossy()).into()),
        }
    }
    Ok((
        request.ok_or("--request is required")?,
        output.ok_or("--output is required")?,
    ))
}

fn read_request(path: &Path) -> DriverResult<BenchmarkRequest> {
    let bytes = fs::read(path)?;
    let request: BenchmarkRequest = serde_json::from_slice(&bytes)?;
    if request.schema_version != 1 {
        return Err(format!("unsupported request schema_version {}", request.schema_version).into());
    }
    if request.fixtures.is_empty() {
        return Err("request contains no fixtures".into());
    }
    Ok(request)
}

fn empty_observations(request: &BenchmarkRequest) -> ObservationsDocument {
    ObservationsDocument {
        schema_version: 1,
        run: RunEvidence {
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            driver_version: DRIVER_VERSION.to_owned(),
            started_at: timestamp(),
            finished_at: String::new(),
            run_id: request.run_id.clone(),
            manifest_digest: request.manifest_digest.clone(),
            errors: Vec::new(),
            job_summary: json!({}),
            export_path: None,
        },
        workflow: WorkflowEvidence {
            import: "failed".to_owned(),
            import_failed_ids: Vec::new(),
            analysis: "failed".to_owned(),
            stack: "failed".to_owned(),
            l3: if request.l3_mode == "skip" {
                "skipped".to_owned()
            } else {
                "failed".to_owned()
            },
            export: "failed".to_owned(),
        },
        fixtures: request
            .fixtures
            .iter()
            .map(|fixture| FixtureObservation {
                id: fixture.id.clone(),
                scene_boundaries_us: Vec::new(),
                stack_id: None,
                recommended: false,
                retained: false,
                rejected: false,
                important_event_detected: false,
                vfr_mappings: Vec::new(),
                proxy_mappings: Vec::new(),
                routine_repeated_in_story: false,
                group: fixture.group.clone(),
                source_path: fixture.source_path.to_string_lossy().into_owned(),
                clip_id: None,
                evidence_errors: Vec::new(),
            })
            .collect(),
    }
}

fn run_workflow(
    request: &BenchmarkRequest,
    observations: &mut ObservationsDocument,
) -> DriverResult<()> {
    if request.l3_mode != "skip" {
        return Err("this core driver supports l3_mode=skip only".into());
    }
    if request.database_path.exists() {
        return Err(format!(
            "benchmark database must not already exist: {}",
            request.database_path.display()
        )
        .into());
    }
    if request.export_directory.exists() {
        return Err(format!(
            "benchmark export directory must not already exist: {}",
            request.export_directory.display()
        )
        .into());
    }

    let mut connection = core::db::open_project(&request.database_path)?;
    let sources = request
        .fixtures
        .iter()
        .map(|fixture| fixture.source_path.clone())
        .collect::<Vec<_>>();
    core::import::start_import_files(&mut connection, &sources)?;
    drop(connection);
    drain_jobs(&request.database_path)?;
    let connection = core::db::open_project(&request.database_path)?;
    let import_failures = job_failures(&connection, &["import_probe", "full_hash"])?;
    let analysis_failures = job_failures(
        &connection,
        &[
            "analyze_l1",
            "analyze_motion",
            "thumbnail",
            "waveform",
            "transcribe",
            "proxy",
            "clip_embed",
            "classify_dims",
        ],
    )?;
    observations.workflow.import = stage_status(&import_failures);
    {
        // 失败导入的夹具 id:评估器据此豁免"预期损坏"夹具
        let mut statement = connection.prepare(
            "SELECT payload FROM jobs WHERE kind='import_probe' AND status IN ('failed','blocked')",
        )?;
        let payloads: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|row| row.ok())
            .collect();
        for payload in payloads {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload) {
                if let Some(path) = value.get("path").and_then(|v| v.as_str()) {
                    if let Some(fixture) = request
                        .fixtures
                        .iter()
                        .find(|fixture| fixture.source_path.to_string_lossy() == path)
                    {
                        observations
                            .workflow
                            .import_failed_ids
                            .push(fixture.id.clone());
                    }
                }
            }
        }
    }
    observations.workflow.analysis = stage_status(&analysis_failures);
    observations.run.errors.extend(import_failures);
    observations.run.errors.extend(analysis_failures);
    drop(connection);

    let mut connection = core::db::open_project(&request.database_path)?;
    core::similar::enqueue_if_ready(&mut connection)?;
    drop(connection);
    drain_jobs(&request.database_path)?;
    let connection = core::db::open_project(&request.database_path)?;
    let stack_failures = job_failures(&connection, &["similar_cluster"])?;
    observations.workflow.stack = stage_status(&stack_failures);
    observations.run.errors.extend(stack_failures);
    drop(connection);

    let mut connection = core::db::open_project(&request.database_path)?;
    populate_application_observations(request, &connection, &mut observations.fixtures)?;

    let selected_clip_ids = observations
        .fixtures
        .iter()
        .filter_map(|fixture| fixture.clip_id)
        .collect::<Vec<_>>();
    if selected_clip_ids.is_empty() {
        observations.run.job_summary = job_summary(&connection)?;
        return Err("no requested fixture completed the real import path".into());
    }
    for clip_id in selected_clip_ids {
        core::ratings::rate_clip(&mut connection, clip_id, core::ratings::BINARY_RATING, 1)?;
    }

    fs::create_dir(&request.export_directory)?;
    let export = core::deliver::start_export(&mut connection, &request.export_directory)?;
    let export_job_id = export.job_id.ok_or("export did not return a job id")?;
    drop(connection);
    drain_jobs(&request.database_path)?;

    let connection = core::db::open_project(&request.database_path)?;
    let export = core::deliver::get_export_status(&connection, Some(export_job_id))?;
    if export.status != "done" {
        observations.run.job_summary = job_summary(&connection)?;
        return Err(format!(
            "export job {export_job_id} ended as {}: {}",
            export.status,
            export.error.unwrap_or_else(|| "no error summary".to_owned())
        )
        .into());
    }
    observations.workflow.export = "done".to_owned();
    observations.run.export_path = export.output_path.clone();
    populate_roundtrip_mappings(request, &connection, &mut observations.fixtures)?;
    observations.run.job_summary = job_summary(&connection)?;
    if observations.workflow.import == "done"
        && observations.workflow.analysis == "done"
        && observations.workflow.stack == "done"
    {
        Ok(())
    } else {
        Err("workflow completed with terminal core job failures; see run.errors".into())
    }
}

fn drain_jobs(db_path: &Path) -> DriverResult<()> {
    let started = Instant::now();
    loop {
        if core::jobs::JobRunner::run_one(db_path)? {
            continue;
        }
        let connection = core::db::open_project(db_path)?;
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM jobs WHERE status IN ('pending', 'running')",
            [],
            |row| row.get(0),
        )?;
        if active == 0 {
            return Ok(());
        }
        if started.elapsed() >= JOB_DRAIN_TIMEOUT {
            return Err(format!("timed out waiting for {active} active jobs").into());
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn populate_application_observations(
    request: &BenchmarkRequest,
    connection: &Connection,
    observations: &mut [FixtureObservation],
) -> DriverResult<()> {
    for (fixture, observation) in request.fixtures.iter().zip(observations.iter_mut()) {
        let clip_id = match clip_id_for_source(connection, &fixture.source_path) {
            Ok(Some(clip_id)) => clip_id,
            Ok(None) => {
                observation
                    .evidence_errors
                    .push("requested source has no imported clip row".to_owned());
                continue;
            }
            Err(error) => {
                observation.evidence_errors.push(error.to_string());
                continue;
            }
        };
        observation.clip_id = Some(clip_id);
        let (tb_num, tb_den, duration_ticks, is_vfr): (i64, i64, i64, bool) =
            connection.query_row(
                "SELECT tb_num, tb_den, duration_ticks, is_vfr FROM clips WHERE id=?1",
                [clip_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        let mut statement = connection.prepare(
            "SELECT out_ticks FROM segments
             WHERE clip_id=?1 AND kind='scene' AND tombstone=0
               AND out_ticks > 0 AND out_ticks < ?2
             ORDER BY out_ticks",
        )?;
        observation.scene_boundaries_us = statement
            .query_map([clip_id, duration_ticks], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|ticks| ticks_to_us(ticks, tb_num, tb_den))
            .collect();

        let stack = connection
            .query_row(
                "SELECT group_id, is_primary FROM similar_group_members WHERE clip_id=?1",
                [clip_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        observation.stack_id = stack.map(|(group_id, _)| format!("stack-{group_id}"));
        let rating = latest_binary_rating(connection, clip_id)?;
        observation.rejected = rating == Some(-1);
        observation.recommended = rating == Some(1) || stack.is_some_and(|(_, primary)| primary);
        observation.retained = !observation.rejected;
        observation.routine_repeated_in_story = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM story_order WHERE clip_id=?1 AND tombstone=0)",
            [clip_id],
            |row| row.get(0),
        )?;
        if is_vfr {
            observation
                .evidence_errors
                .push("VFR mapping pending export round-trip".to_owned());
        }
    }
    Ok(())
}

fn clip_id_for_source(connection: &Connection, path: &Path) -> DriverResult<Option<i64>> {
    let (quick_hash, byte_size) = core::import::quick_fingerprint(path)?;
    connection
        .query_row(
            "SELECT id FROM clips WHERE quick_hash=?1 AND byte_size=?2 ORDER BY id LIMIT 1",
            rusqlite::params![quick_hash, byte_size as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn latest_binary_rating(connection: &Connection, clip_id: i64) -> DriverResult<Option<i64>> {
    connection
        .query_row(
            "SELECT r.value FROM ratings r
             JOIN segments s ON s.id=r.segment_id
             WHERE s.clip_id=?1 AND s.tombstone=0 AND r.rating_type='binary'
             ORDER BY r.rated_at DESC, r.id DESC LIMIT 1",
            [clip_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn populate_roundtrip_mappings(
    request: &BenchmarkRequest,
    connection: &Connection,
    observations: &mut [FixtureObservation],
) -> DriverResult<()> {
    let ffmpeg = core::settings::configured_executable(
        connection,
        core::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let ffprobe = core::settings::configured_ffprobe(connection, &ffmpeg)?;
    let export_paths = exported_clip_paths(connection)?;

    for (fixture, observation) in request.fixtures.iter().zip(observations.iter_mut()) {
        let Some(clip_id) = observation.clip_id else {
            continue;
        };
        if !fixture.vfr_checkpoints_us.is_empty() {
            observation
                .evidence_errors
                .retain(|message| message != "VFR mapping pending export round-trip");
            match core::canonical_time::load_vfr_source_pts_us(connection, clip_id) {
                Ok(source_pts) if source_pts.len() >= 2 => {
                    if let Some(export_path) = export_paths.get(&clip_id) {
                        match frame_pts_us(&ffprobe, export_path) {
                            Ok(output_pts) => {
                                observation.vfr_mappings = map_vfr_checkpoints_roundtrip(
                                    &fixture.vfr_checkpoints_us,
                                    &source_pts,
                                    &output_pts,
                                )
                            }
                            Err(error) => observation
                                .evidence_errors
                                .push(format!("export PTS: {error}")),
                        }
                    } else {
                        observation
                            .evidence_errors
                            .push("export output missing for VFR mapping".to_owned());
                    }
                }
                Ok(_) => observation
                    .evidence_errors
                    .push("vfr_time_map has fewer than two samples".to_owned()),
                Err(error) => observation
                    .evidence_errors
                    .push(format!("vfr_time_map: {error}")),
            }
        }

        if !fixture.proxy_checkpoints_us.is_empty() {
            match core::canonical_time::load_proxy_mapper(connection, clip_id)? {
                Some(mapper) => {
                    observation.proxy_mappings = proxy_checkpoint_roundtrips(
                        &fixture.proxy_checkpoints_us,
                        &mapper,
                    );
                }
                None => observation
                    .evidence_errors
                    .push("proxy_time_map has fewer than two valid samples".to_owned()),
            }
        }
    }
    Ok(())
}

fn exported_clip_paths(connection: &Connection) -> DriverResult<HashMap<i64, PathBuf>> {
    let row = connection
        .query_row(
            "SELECT manifest, output_path FROM exports ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((manifest, output_path)) = row else {
        return Ok(HashMap::new());
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
    let mut paths = HashMap::new();
    for (clip, item) in clips.iter().zip(items) {
        let Some(clip_id) = clip.get("clip_id").and_then(Value::as_i64) else {
            continue;
        };
        if item.get("status").and_then(Value::as_str) != Some("done") {
            continue;
        }
        let Some(file_name) = item.get("output_name").and_then(Value::as_str) else {
            continue;
        };
        if let Some(path) = find_file_named(Path::new(&output_path), file_name)? {
            paths.insert(clip_id, path);
        }
    }
    Ok(paths)
}

fn find_file_named(root: &Path, name: &str) -> DriverResult<Option<PathBuf>> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name)? {
                return Ok(Some(found));
            }
        } else if entry.file_name() == OsStr::new(name) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn frame_pts_us(ffprobe: &OsStr, path: &Path) -> DriverResult<Vec<i64>> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let value: Value = serde_json::from_slice(&output.stdout)?;
    let frames = value
        .get("frames")
        .and_then(Value::as_array)
        .ok_or("ffprobe frame output lacks frames")?;
    let mut points = frames
        .iter()
        .filter_map(|frame| frame.get("best_effort_timestamp_time"))
        .filter_map(Value::as_str)
        .filter_map(decimal_seconds_to_us)
        .collect::<Vec<_>>();
    points.sort_unstable();
    points.dedup();
    if points.is_empty() {
        return Err(format!("ffprobe returned no video PTS for {}", path.display()).into());
    }
    Ok(points)
}

fn decimal_seconds_to_us(text: &str) -> Option<i64> {
    let (negative, unsigned) = text
        .strip_prefix('-')
        .map_or((false, text), |value| (true, value));
    let (seconds, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let seconds = seconds.parse::<i64>().ok()?;
    let mut micros_text = fraction.chars().take(6).collect::<String>();
    while micros_text.len() < 6 {
        micros_text.push('0');
    }
    let mut micros = micros_text.parse::<i64>().ok()?;
    if fraction.as_bytes().get(6).is_some_and(|digit| *digit >= b'5') {
        micros = micros.saturating_add(1);
    }
    let total = seconds.checked_mul(1_000_000)?.checked_add(micros)?;
    Some(if negative { -total } else { total })
}

fn map_vfr_checkpoints_roundtrip(
    checkpoints: &[i64],
    source_samples: &[i64],
    target: &[i64],
) -> Vec<PtsMapping> {
    let (Some(source_origin), Some(target_origin)) =
        (source_samples.first(), target.first())
    else {
        return Vec::new();
    };
    let relative_target = target
        .iter()
        .map(|pts| pts.saturating_sub(*target_origin))
        .collect::<Vec<_>>();
    checkpoints
        .iter()
        .map(|checkpoint| {
            let relative = checkpoint.saturating_sub(*source_origin);
            let index = relative_target
                .binary_search(&relative)
                .unwrap_or_else(|index| {
                    if index == 0 {
                        0
                    } else if index == relative_target.len() {
                        relative_target.len() - 1
                    } else if relative.abs_diff(relative_target[index - 1])
                        <= relative.abs_diff(relative_target[index])
                    {
                        index - 1
                    } else {
                        index
                    }
                });
            PtsMapping {
                source_pts_us: *checkpoint,
                mapped_source_pts_us: source_origin.saturating_add(relative_target[index]),
            }
        })
        .collect()
}

fn proxy_checkpoint_roundtrips(
    checkpoints: &[i64],
    mapper: &core::canonical_time::ProxyTimeMapper,
) -> Vec<PtsMapping> {
    checkpoints
        .iter()
        .map(|checkpoint| {
            let source_seconds = *checkpoint as f64 / 1_000_000.0;
            let proxy_seconds = mapper.proxy_seconds_for_source_seconds(source_seconds);
            let mapped_source_pts_us =
                (mapper.source_seconds_for_proxy_seconds(proxy_seconds) * 1_000_000.0).round()
                    as i64;
            PtsMapping {
                source_pts_us: *checkpoint,
                mapped_source_pts_us,
            }
        })
        .collect()
}

fn ticks_to_us(ticks: i64, tb_num: i64, tb_den: i64) -> Option<i64> {
    if tb_num <= 0 || tb_den <= 0 {
        return None;
    }
    let numerator = i128::from(ticks)
        .checked_mul(i128::from(tb_num))?
        .checked_mul(1_000_000)?;
    let rounded = if numerator >= 0 {
        numerator.checked_add(i128::from(tb_den) / 2)?
    } else {
        numerator.checked_sub(i128::from(tb_den) / 2)?
    } / i128::from(tb_den);
    i64::try_from(rounded).ok()
}

fn job_summary(connection: &Connection) -> DriverResult<Value> {
    let mut statement = connection.prepare(
        "SELECT kind, status, COUNT(*) FROM jobs GROUP BY kind, status ORDER BY kind, status",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut summary = serde_json::Map::new();
    for row in rows {
        let (kind, status, count) = row?;
        let entry = summary.entry(kind).or_insert_with(|| json!({}));
        if let Some(statuses) = entry.as_object_mut() {
            statuses.insert(status, json!(count));
        }
    }
    Ok(Value::Object(summary))
}

fn job_failures(connection: &Connection, kinds: &[&str]) -> DriverResult<Vec<String>> {
    let mut failures = Vec::new();
    for kind in kinds {
        let mut statement = connection.prepare(
            "SELECT id, status, COALESCE(blocked_summary, '') FROM jobs
             WHERE kind=?1 AND status IN ('failed', 'blocked') ORDER BY id",
        )?;
        let rows = statement.query_map([kind], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, status, summary) = row?;
            failures.push(format!("{kind} job {id} {status}: {summary}"));
        }
    }
    Ok(failures)
}

fn stage_status(failures: &[String]) -> String {
    if failures.is_empty() { "done" } else { "failed" }.to_owned()
}

fn write_observations(path: &Path, observations: &ObservationsDocument) -> DriverResult<()> {
    let bytes = serde_json::to_vec_pretty(observations)?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix:{seconds}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tripcut_studio_lib::core::canonical_time::{ProxyTimeMapper, ProxyTimePoint};

    #[test]
    fn request_accepts_explicit_mapping_checkpoints_without_answer_fields() {
        let fixture: FixtureRequest = serde_json::from_value(json!({
            "id": "F-006",
            "group": "F",
            "source_path": "/media/F-006.mov",
            "vfr_checkpoints_us": [0, 33367, 100100],
            "proxy_checkpoints_us": [0, 100100]
        }))
        .unwrap();

        assert_eq!(fixture.vfr_checkpoints_us, vec![0, 33_367, 100_100]);
        assert_eq!(fixture.proxy_checkpoints_us, vec![0, 100_100]);
    }

    #[test]
    fn vfr_mapping_reports_every_requested_checkpoint_as_the_lookup_key() {
        let mappings = map_vfr_checkpoints_roundtrip(
            &[0, 33_367, 100_100, 500_500],
            &[0, 33_367, 100_100, 500_500],
            &[9_000, 42_367, 109_100, 509_500],
        );

        assert_eq!(
            mappings,
            vec![
                PtsMapping { source_pts_us: 0, mapped_source_pts_us: 0 },
                PtsMapping { source_pts_us: 33_367, mapped_source_pts_us: 33_367 },
                PtsMapping { source_pts_us: 100_100, mapped_source_pts_us: 100_100 },
                PtsMapping { source_pts_us: 500_500, mapped_source_pts_us: 500_500 },
            ]
        );
    }

    #[test]
    fn proxy_mapping_round_trips_every_requested_checkpoint_through_e4_mapper() {
        let mapper = ProxyTimeMapper::from_points(
            1,
            1_000,
            vec![
                ProxyTimePoint { proxy_ts_ms: 0, source_ticks: 0 },
                ProxyTimePoint { proxy_ts_ms: 1_000, source_ticks: 1_000 },
                ProxyTimePoint { proxy_ts_ms: 2_000, source_ticks: 2_000 },
            ],
        )
        .unwrap();

        let mappings = proxy_checkpoint_roundtrips(&[0, 100_100, 1_999_000], &mapper);

        assert_eq!(mappings.len(), 3);
        assert!(mappings
            .iter()
            .all(|mapping| mapping.source_pts_us == mapping.mapped_source_pts_us));
    }
}
