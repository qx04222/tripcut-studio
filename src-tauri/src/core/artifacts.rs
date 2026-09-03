use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::{self, Job};

pub const COVER_FILE: &str = "cover.jpg";
pub const STRIP_FILE: &str = "strip.jpg";
pub const PROXY_FILE: &str = "proxy.mp4";
pub const WAVEFORM_FILE: &str = "waveform.json";
pub const WAVEFORM_BINS: usize = 2_000;

const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(120);
const WAVEFORM_TIMEOUT: Duration = Duration::from_secs(300);
const PROXY_TIMEOUT: Duration = Duration::from_secs(3_600);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactJobPayload {
    pub clip_id: i64,
    pub path: String,
    pub source_hash: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStatus {
    Missing,
    Pending,
    Running,
    Ready,
    Direct,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ArtifactStatuses {
    pub cover: ArtifactStatus,
    pub strip: ArtifactStatus,
    pub proxy: ArtifactStatus,
    pub waveform: ArtifactStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ClipArtifacts {
    pub cover: Option<String>,
    pub strip: Option<String>,
    pub proxy: Option<String>,
    pub waveform: Option<String>,
    pub statuses: ArtifactStatuses,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaveformData {
    pub version: u8,
    pub bins: usize,
    pub peaks: Vec<[f32; 2]>,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug)]
struct ClipSource {
    path: PathBuf,
    duration_seconds: f64,
    duration_ticks: i64,
    tb_num: i64,
    tb_den: i64,
    height: i64,
}

struct FinalArtifact<'a> {
    kind: &'static str,
    file_name: &'static str,
    temporary_path: &'a Path,
}

#[derive(Debug)]
struct JobSnapshot {
    id: i64,
    status: String,
    result_path: Option<String>,
}

pub fn cache_root_for_db(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("cache")
}

pub fn run_artifact_job(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    match job.kind.as_str() {
        "thumbnail" => run_thumbnail(connection, job, cache_root),
        "waveform" => run_waveform(connection, job, cache_root),
        "proxy" => run_proxy(connection, job, cache_root),
        other => Err(CoreError::Artifact(format!(
            "不支持的缓存任务种类：{other}"
        ))),
    }
}

pub fn enqueue_for_clip(
    connection: &mut Connection,
    clip_id: i64,
    path: &Path,
    source_hash: &str,
) -> Result<()> {
    let payload = ArtifactJobPayload {
        clip_id,
        path: path.to_string_lossy().into_owned(),
        source_hash: source_hash.to_owned(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Artifact(format!("无法创建缓存任务：{error}")))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    // Even with proxy encoding disabled, the lightweight proxy job persists the
    // source-to-source identity map used by the canonical-time API.
    let kinds = &["thumbnail", "waveform", "proxy"][..];
    for kind in kinds {
        let payload_hash = blake3::hash(
            format!("{kind}\0{clip_id}\0{source_hash}").as_bytes(),
        )
        .to_hex()
        .to_string();
        let exists = transaction
            .query_row(
                "SELECT 1 FROM jobs WHERE kind = ?1 AND payload_hash = ?2 LIMIT 1",
                params![kind, payload_hash],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            continue;
        }
        transaction.execute(
            "INSERT INTO jobs(
                kind, payload, payload_hash, status, attempt,
                next_attempt_at, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, 'pending', 0,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )",
            params![kind, payload_json, payload_hash],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub fn run_thumbnail(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    run_thumbnail_with(
        connection,
        job,
        cache_root,
        &ffmpeg,
        THUMBNAIL_TIMEOUT,
    )
}

fn run_thumbnail_with(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    ffmpeg: &OsStr,
    timeout: Duration,
) -> Result<()> {
    let payload = parse_payload(job)?;
    let source = validate_source(connection, &payload)?;
    let frame_count = strip_frame_count(source.duration_seconds);
    let clip_root = cache_root.join(payload.clip_id.to_string());
    std::fs::create_dir_all(&clip_root)?;
    let cover_final = clip_root.join(COVER_FILE);
    let strip_final = clip_root.join(STRIP_FILE);
    let cover_temporary = jobs::temporary_output_path(&cover_final, job.attempt);
    let strip_temporary = jobs::temporary_output_path(&strip_final, job.attempt);
    remove_if_exists(&cover_temporary)?;
    remove_if_exists(&strip_temporary)?;

    let cover_time = source.duration_seconds * 0.25;
    let cover_args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-ss"),
        OsString::from(format!("{cover_time:.6}")),
        OsString::from("-i"),
        source.path.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-vf"),
        // thumbnail 滤镜在取样点后扫 90 帧选最有代表性的一帧,避免黑场/转场封面。
        OsString::from("thumbnail=90,scale=480:-2"),
        OsString::from("-c:v"),
        OsString::from("mjpeg"),
        OsString::from("-q:v"),
        OsString::from("3"),
        OsString::from("-f"),
        OsString::from("image2"),
        OsString::from("-y"),
        cover_temporary.as_os_str().to_owned(),
    ];
    if let Err(error) = run_ffmpeg_file(ffmpeg, &cover_args, timeout, &cover_temporary) {
        cleanup_temporary_files([&cover_temporary, &strip_temporary]);
        return Err(error);
    }

    let strip_filter = format!(
        "fps={frame_count}/{:.6},scale=160:-2,tile={frame_count}x1:padding=0:margin=0",
        source.duration_seconds
    );
    let strip_args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        source.path.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-vf"),
        OsString::from(strip_filter),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-c:v"),
        OsString::from("mjpeg"),
        OsString::from("-q:v"),
        OsString::from("4"),
        OsString::from("-f"),
        OsString::from("image2"),
        OsString::from("-y"),
        strip_temporary.as_os_str().to_owned(),
    ];
    if let Err(error) = run_ffmpeg_file(ffmpeg, &strip_args, timeout, &strip_temporary) {
        cleanup_temporary_files([&cover_temporary, &strip_temporary]);
        return Err(error);
    }

    let artifacts = [
        FinalArtifact {
            kind: "cover",
            file_name: COVER_FILE,
            temporary_path: &cover_temporary,
        },
        FinalArtifact {
            kind: "strip",
            file_name: STRIP_FILE,
            temporary_path: &strip_temporary,
        },
    ];
    if let Err(error) = finalize_artifacts(connection, job, cache_root, &payload, &artifacts, None) {
        cleanup_temporary_files([&cover_temporary, &strip_temporary]);
        return Err(error);
    }
    if let Err(error) = super::clip_search::enqueue_for_clip(
        connection,
        payload.clip_id,
        &payload.source_hash,
        &strip_final,
        frame_count,
    ) {
        // The thumbnail job is already durably finalized at this point. Startup
        // backfill will retry this enqueue without corrupting its done state.
        tracing::warn!(clip_id = payload.clip_id, %error, "could not enqueue clip embedding");
    }
    Ok(())
}

pub fn run_waveform(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    run_waveform_with(
        connection,
        job,
        cache_root,
        &ffmpeg,
        WAVEFORM_TIMEOUT,
    )
}

fn run_waveform_with(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    ffmpeg: &OsStr,
    timeout: Duration,
) -> Result<()> {
    let payload = parse_payload(job)?;
    let source = validate_source(connection, &payload)?;
    let args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        source.path.as_os_str().to_owned(),
        OsString::from("-vn"),
        OsString::from("-map"),
        OsString::from("0:a:0?"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from("8000"),
        OsString::from("-f"),
        OsString::from("s16le"),
        OsString::from("pipe:1"),
    ];
    let output = execute_with_timeout(ffmpeg, &args, timeout).map_err(|error| {
        CoreError::Artifact(format!(
            "ffmpeg 无法解码波形 {}：{error}",
            source.path.display()
        ))
    })?;
    let no_audio = output.stdout.is_empty()
        && (output.success || stderr_means_no_audio(&output.stderr));
    if !output.success && !no_audio {
        return Err(ffmpeg_failure("波形", &output));
    }
    if output.stdout.len() % 2 != 0 {
        return Err(CoreError::Artifact(
            "ffmpeg 返回了长度非偶数的 16-bit PCM".to_owned(),
        ));
    }
    let samples = output
        .stdout
        .as_chunks::<2>()
        .0
        .iter()
        .map(|bytes| i16::from_le_bytes(*bytes))
        .collect::<Vec<_>>();
    let waveform = WaveformData {
        version: 1,
        bins: WAVEFORM_BINS,
        peaks: compute_peaks(&samples, WAVEFORM_BINS),
    };
    let bytes = serde_json::to_vec(&waveform)
        .map_err(|error| CoreError::Artifact(format!("无法序列化波形：{error}")))?;

    let clip_root = cache_root.join(payload.clip_id.to_string());
    std::fs::create_dir_all(&clip_root)?;
    let final_path = clip_root.join(WAVEFORM_FILE);
    let temporary_path = jobs::temporary_output_path(&final_path, job.attempt);
    remove_if_exists(&temporary_path)?;
    write_synced(&temporary_path, &bytes)?;
    let artifacts = [FinalArtifact {
        kind: "waveform",
        file_name: WAVEFORM_FILE,
        temporary_path: &temporary_path,
    }];
    if let Err(error) = finalize_artifacts(connection, job, cache_root, &payload, &artifacts, None) {
        cleanup_temporary_files([&temporary_path]);
        return Err(error);
    }
    Ok(())
}

pub fn run_proxy(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    if !super::settings::proxy_enabled(connection)? {
        return complete_direct(connection, job, &parse_payload(job)?);
    }
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let ffprobe = super::settings::configured_ffprobe(connection, &ffmpeg)?;
    run_proxy_with(
        connection,
        job,
        cache_root,
        &ffmpeg,
        &ffprobe,
        PROXY_TIMEOUT,
    )
}

fn run_proxy_with(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    timeout: Duration,
) -> Result<()> {
    let payload = parse_payload(job)?;
    let source = validate_source(connection, &payload)?;
    if source.height <= 540 {
        return complete_direct(connection, job, &payload);
    }

    let clip_root = cache_root.join(payload.clip_id.to_string());
    std::fs::create_dir_all(&clip_root)?;
    let final_path = clip_root.join(PROXY_FILE);
    let temporary_path = jobs::temporary_output_path(&final_path, job.attempt);
    remove_if_exists(&temporary_path)?;

    let source_path = source.path.to_string_lossy();
    let hardware_decode_args = proxy_args(&source_path, &temporary_path, true);
    if let Err(hardware_decode_error) =
        run_ffmpeg_file(ffmpeg, &hardware_decode_args, timeout, &temporary_path)
    {
        remove_if_exists(&temporary_path)?;
        let software_decode_args = proxy_args(&source_path, &temporary_path, false);
        if let Err(software_decode_error) =
            run_ffmpeg_file(ffmpeg, &software_decode_args, timeout, &temporary_path)
        {
            cleanup_temporary_files([&temporary_path]);
            return Err(CoreError::Artifact(format!(
                "代理转码失败；VideoToolbox 硬件解码：{hardware_decode_error}；CPU 解码 + VideoToolbox 编码：{software_decode_error}"
            )));
        }
    }

    let proxy_duration_ms = match probe_duration_ms(ffprobe, &temporary_path, timeout) {
        Ok(duration) => duration,
        Err(error) => {
            cleanup_temporary_files([&temporary_path]);
            return Err(error);
        }
    };
    let time_map = super::canonical_time::build_linear_proxy_map(
        source.duration_ticks,
        source.tb_num,
        source.tb_den,
        proxy_duration_ms,
    );

    let artifacts = [FinalArtifact {
        kind: "proxy",
        file_name: PROXY_FILE,
        temporary_path: &temporary_path,
    }];
    if let Err(error) = finalize_artifacts(
        connection,
        job,
        cache_root,
        &payload,
        &artifacts,
        Some(&time_map),
    ) {
        cleanup_temporary_files([&temporary_path]);
        return Err(error);
    }
    Ok(())
}

fn proxy_args(source: &str, output: &Path, hardware_decode: bool) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
    ];
    if hardware_decode {
        args.extend([OsString::from("-hwaccel"), OsString::from("videotoolbox")]);
    }
    args.extend([
        OsString::from("-i"),
        source.into(),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-map"),
        OsString::from("0:a:0?"),
        OsString::from("-vf"),
        OsString::from("scale=-2:540"),
        OsString::from("-c:v"),
        OsString::from("h264_videotoolbox"),
        OsString::from("-allow_sw"),
        OsString::from("1"),
        OsString::from("-b:v"),
        OsString::from("4M"),
        OsString::from("-pix_fmt"),
        OsString::from("yuv420p"),
        OsString::from("-fps_mode"),
        OsString::from("cfr"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("96k"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-f"),
        OsString::from("mp4"),
        OsString::from("-y"),
        output.as_os_str().to_owned(),
    ]);
    args
}

pub fn compute_peaks(samples: &[i16], bins: usize) -> Vec<[f32; 2]> {
    if bins == 0 {
        return Vec::new();
    }
    if samples.is_empty() {
        return vec![[0.0, 0.0]; bins];
    }

    (0..bins)
        .map(|index| {
            let start = index.saturating_mul(samples.len()) / bins;
            let mut end = (index + 1).saturating_mul(samples.len()) / bins;
            if end <= start {
                end = (start + 1).min(samples.len());
            }
            let window = &samples[start.min(samples.len() - 1)..end.max(1)];
            let minimum = *window.iter().min().unwrap_or(&0);
            let maximum = *window.iter().max().unwrap_or(&0);
            [normalize_sample(minimum), normalize_sample(maximum)]
        })
        .collect()
}

fn normalize_sample(sample: i16) -> f32 {
    if sample < 0 {
        f32::from(sample) / 32_768.0
    } else {
        f32::from(sample) / 32_767.0
    }
}

fn strip_frame_count(duration_seconds: f64) -> usize {
    ((duration_seconds.max(0.0) / 5.0).ceil() as usize).clamp(1, 12)
}

fn parse_payload(job: &Job) -> Result<ArtifactJobPayload> {
    serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Artifact(format!("缓存任务数据无效：{error}")))
}

fn validate_source(connection: &Connection, payload: &ArtifactJobPayload) -> Result<ClipSource> {
    let path = super::media_source::verified_clip_path(connection, payload.clip_id)
        .map_err(|error| CoreError::Artifact(error.to_string()))?;

    let source = connection
        .query_row(
            "SELECT duration_ticks, tb_num, tb_den, height
             FROM clips WHERE id = ?1 AND quick_hash = ?2",
            params![payload.clip_id, payload.source_hash],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::Artifact(format!(
                "素材 {} 已变化或不存在，缓存任务作废",
                payload.clip_id
            ))
        })?;
    if source.1 <= 0 || source.2 <= 0 || source.0 <= 0 || source.3 <= 0 {
        return Err(CoreError::Artifact(format!(
            "素材 {} 的时长或尺寸无效",
            payload.clip_id
        )));
    }
    Ok(ClipSource {
        path,
        duration_seconds: source.0 as f64 * source.1 as f64 / source.2 as f64,
        duration_ticks: source.0,
        tb_num: source.1,
        tb_den: source.2,
        height: source.3,
    })
}

fn finalize_artifacts(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    payload: &ArtifactJobPayload,
    artifacts: &[FinalArtifact<'_>],
    proxy_time_map: Option<&[super::canonical_time::ProxyTimePoint]>,
) -> Result<()> {
    for artifact in artifacts {
        let metadata = std::fs::metadata(artifact.temporary_path)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(CoreError::Artifact(format!(
                "{} 产物为空",
                artifact.file_name
            )));
        }
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let source_is_current = transaction
        .query_row(
            "SELECT 1 FROM clips WHERE id = ?1 AND quick_hash = ?2",
            params![payload.clip_id, payload.source_hash],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !source_is_current {
        return Err(CoreError::Artifact(format!(
            "素材 {} 在产物完成前已变化",
            payload.clip_id
        )));
    }
    let is_current_attempt = transaction
        .query_row(
            "SELECT 1 FROM jobs
             WHERE id = ?1 AND status = 'running' AND attempt = ?2",
            params![job.id, job.attempt],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !is_current_attempt {
        return Err(CoreError::InvalidTransition(format!(
            "job {} attempt {} is not running",
            job.id, job.attempt
        )));
    }

    let mut first_result = None;
    for artifact in artifacts {
        let relative_path = artifact_relative_path(payload.clip_id, artifact.file_name);
        let final_path = cache_root.join(&relative_path);
        std::fs::rename(artifact.temporary_path, &final_path)?;
        let bytes = std::fs::metadata(&final_path)?.len() as i64;
        transaction.execute(
            "INSERT INTO cache_artifacts(
                clip_id, kind, rel_path, source_hash, bytes, created_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )
             ON CONFLICT(clip_id, kind) DO UPDATE SET
                rel_path = excluded.rel_path,
                source_hash = excluded.source_hash,
                bytes = excluded.bytes,
                created_at = excluded.created_at",
            params![
                payload.clip_id,
                artifact.kind,
                path_to_rel_string(&relative_path),
                payload.source_hash,
                bytes,
            ],
        )?;
        first_result.get_or_insert(final_path);
    }

    if let Some(points) = proxy_time_map {
        if points.len() < 2 {
            return Err(CoreError::Artifact(format!(
                "素材 {} 的代理时间映射点不足",
                payload.clip_id
            )));
        }
        transaction.execute(
            "DELETE FROM proxy_time_map WHERE clip_id = ?1",
            [payload.clip_id],
        )?;
        for point in points {
            transaction.execute(
                "INSERT INTO proxy_time_map(clip_id, proxy_ts_ms, source_ticks)
                 VALUES (?1, ?2, ?3)",
                params![payload.clip_id, point.proxy_ts_ms, point.source_ticks],
            )?;
        }
    }

    let result_path = first_result
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', result_path = ?3, blocked_summary = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2",
        params![job.id, job.attempt, result_path],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {} attempt {} changed during artifact finalization",
            job.id, job.attempt
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn complete_direct(
    connection: &mut Connection,
    job: &Job,
    payload: &ArtifactJobPayload,
) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let timing = transaction
        .query_row(
            "SELECT duration_ticks, tb_num, tb_den FROM clips
             WHERE id = ?1 AND quick_hash = ?2",
            params![payload.clip_id, payload.source_hash],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::InvalidTransition(format!(
                "proxy job {} attempt {} is stale",
                job.id, job.attempt
            ))
        })?;
    let time_map = super::canonical_time::build_identity_proxy_map(timing.0, timing.1, timing.2);
    if time_map.len() < 2 {
        return Err(CoreError::Artifact(format!(
            "素材 {} 的 direct 代理时间映射点不足",
            payload.clip_id
        )));
    }
    transaction.execute("DELETE FROM proxy_time_map WHERE clip_id = ?1", [payload.clip_id])?;
    for point in time_map {
        transaction.execute(
            "INSERT INTO proxy_time_map(clip_id, proxy_ts_ms, source_ticks)
             VALUES (?1, ?2, ?3)",
            params![payload.clip_id, point.proxy_ts_ms, point.source_ticks],
        )?;
    }
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', result_path = 'direct', blocked_summary = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2
           AND EXISTS (
             SELECT 1 FROM clips WHERE id = ?3 AND quick_hash = ?4
           )",
        params![job.id, job.attempt, payload.clip_id, payload.source_hash],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "proxy job {} attempt {} is stale",
            job.id, job.attempt
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn probe_duration_ms(ffprobe: &OsStr, path: &Path, timeout: Duration) -> Result<i64> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-show_entries"),
        OsString::from("stream=duration:format=duration"),
        OsString::from("-of"),
        OsString::from("json"),
        path.as_os_str().to_owned(),
    ];
    let output = execute_with_timeout(ffprobe, &args, timeout).map_err(|error| {
        CoreError::Artifact(format!("ffprobe 无法读取代理时长 {}：{error}", path.display()))
    })?;
    if !output.success {
        return Err(CoreError::Artifact(format!(
            "ffprobe 代理时间映射探测失败（退出码 {}）：{}",
            output
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_owned()),
            stderr_summary(&output.stderr)
        )));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| CoreError::Artifact(format!("代理 ffprobe JSON 无效：{error}")))?;
    let duration = value
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .and_then(|streams| streams.first())
        .and_then(|stream| stream.get("duration"))
        .or_else(|| value.get("format").and_then(|format| format.get("duration")))
        .and_then(serde_json::Value::as_str)
        .and_then(decimal_seconds_to_ms)
        .filter(|duration| *duration > 0)
        .ok_or_else(|| CoreError::Artifact("代理 ffprobe 输出缺少有效时长".to_owned()))?;
    Ok(duration)
}

fn decimal_seconds_to_ms(value: &str) -> Option<i64> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    let whole = whole.parse::<i128>().ok()?;
    let fraction = fraction.as_bytes();
    let mut milliseconds = 0_i128;
    for index in 0..3 {
        milliseconds *= 10;
        if let Some(byte) = fraction.get(index) {
            if !(*byte).is_ascii_digit() {
                return None;
            }
            milliseconds += i128::from(*byte - b'0');
        }
    }
    let rounded = if fraction.get(3).is_some_and(|byte| *byte >= b'5' && *byte <= b'9') {
        1
    } else {
        0
    };
    i64::try_from(whole.checked_mul(1_000)?.checked_add(milliseconds + rounded)?).ok()
}

fn run_ffmpeg_file(
    ffmpeg: &OsStr,
    args: &[OsString],
    timeout: Duration,
    output_path: &Path,
) -> Result<()> {
    let output = execute_with_timeout(ffmpeg, args, timeout).map_err(|error| {
        CoreError::Artifact(format!(
            "找不到或无法运行 ffmpeg（可设置 FFMPEG_PATH）：{error}"
        ))
    })?;
    if !output.success {
        return Err(ffmpeg_failure("产物", &output));
    }
    let file = File::open(output_path)?;
    file.sync_all()?;
    let length = file.metadata()?.len();
    if length == 0 {
        return Err(CoreError::Artifact("ffmpeg 生成了空文件".to_owned()));
    }
    Ok(())
}

fn execute_with_timeout(
    executable: &OsStr,
    args: &[OsString],
    timeout: Duration,
) -> std::io::Result<CommandOutput> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || read_pipe(stdout));
    let stderr_reader = thread::spawn(move || read_pipe(stderr));
    let started = Instant::now();

    let status = loop {
        if super::jobs::current_cancellation_requested() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "用户已取消",
            ));
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("命令超过 {} 秒未完成", timeout.as_secs()),
            ));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| std::io::Error::other("stdout reader thread panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| std::io::Error::other("stderr reader thread panicked"))??;
    Ok(CommandOutput {
        success: status.success(),
        code: status.code(),
        stdout,
        stderr,
    })
}

fn read_pipe<R: Read>(pipe: Option<R>) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut bytes)?;
    }
    Ok(bytes)
}

fn ffmpeg_failure(label: &str, output: &CommandOutput) -> CoreError {
    CoreError::Artifact(format!(
        "ffmpeg {label}失败（退出码 {}）：{}",
        output
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_owned()),
        stderr_summary(&output.stderr)
    ))
}

fn stderr_summary(stderr: &[u8]) -> String {
    const MAX_LENGTH: usize = 1_024;
    let text = String::from_utf8_lossy(stderr);
    let summary: String = text
        .trim()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(MAX_LENGTH)
        .collect();
    if summary.is_empty() {
        "没有错误输出".to_owned()
    } else {
        summary
    }
}

fn stderr_means_no_audio(stderr: &[u8]) -> bool {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    text.contains("does not contain any stream")
        || text.contains("matches no streams")
        || text.contains("stream map '0:a:0?' matches no streams")
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn cleanup_temporary_files<'a>(paths: impl IntoIterator<Item = &'a PathBuf>) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}

fn artifact_relative_path(clip_id: i64, file_name: &str) -> PathBuf {
    PathBuf::from(clip_id.to_string()).join(file_name)
}

fn path_to_rel_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn cache_url(port: u16, token: &str, clip_id: i64, file_name: &str) -> Result<String> {
    super::media_server::signed_cache_url(port, token, clip_id, file_name)
}

pub fn cover_urls(
    connection: &Connection,
    cache_root: &Path,
    port: u16,
    token: &str,
) -> Result<HashMap<i64, String>> {
    let mut statement = connection.prepare(
        "SELECT cache_artifacts.clip_id, cache_artifacts.rel_path
         FROM cache_artifacts
         JOIN clips ON clips.id = cache_artifacts.clip_id
         WHERE cache_artifacts.kind = 'cover'
           AND cache_artifacts.source_hash = clips.quick_hash",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut urls = HashMap::new();
    for row in rows {
        let (clip_id, rel_path) = row?;
        let expected = artifact_relative_path(clip_id, COVER_FILE);
        if rel_path == path_to_rel_string(&expected) && cache_root.join(expected).is_file() {
            urls.insert(clip_id, cache_url(port, token, clip_id, COVER_FILE)?);
        }
    }
    Ok(urls)
}

pub fn get_clip_artifacts(
    connection: &mut Connection,
    cache_root: &Path,
    port: u16,
    token: &str,
    clip_id: i64,
) -> Result<ClipArtifacts> {
    let source_hash = connection
        .query_row(
            "SELECT quick_hash FROM clips WHERE id = ?1",
            [clip_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .ok_or_else(|| CoreError::Artifact(format!("素材 {clip_id} 不存在或尚未完成导入")))?;

    let cover = valid_artifact_url(
        connection,
        cache_root,
        port,
        token,
        clip_id,
        &source_hash,
        "cover",
        COVER_FILE,
    )?;
    let strip = valid_artifact_url(
        connection,
        cache_root,
        port,
        token,
        clip_id,
        &source_hash,
        "strip",
        STRIP_FILE,
    )?;
    let proxy = valid_artifact_url(
        connection,
        cache_root,
        port,
        token,
        clip_id,
        &source_hash,
        "proxy",
        PROXY_FILE,
    )?;
    let waveform = valid_artifact_url(
        connection,
        cache_root,
        port,
        token,
        clip_id,
        &source_hash,
        "waveform",
        WAVEFORM_FILE,
    )?;

    let thumbnail_job = latest_job(connection, "thumbnail", clip_id, &source_hash)?;
    let waveform_job = latest_job(connection, "waveform", clip_id, &source_hash)?;
    let proxy_job = latest_job(connection, "proxy", clip_id, &source_hash)?;

    let thumbnail_job = requeue_if_cache_missing(
        connection,
        thumbnail_job,
        cover.is_none() || strip.is_none(),
    )?;
    let waveform_job =
        requeue_if_cache_missing(connection, waveform_job, waveform.is_none())?;
    let proxy_enabled = super::settings::proxy_enabled(connection)?;
    let proxy_direct = !proxy_enabled || proxy_job
        .as_ref()
        .is_some_and(|job| job.status == "done" && job.result_path.as_deref() == Some("direct"));
    let proxy_job = requeue_if_cache_missing(
        connection,
        proxy_job,
        proxy_enabled && proxy.is_none() && !proxy_direct,
    )?;

    Ok(ClipArtifacts {
        statuses: ArtifactStatuses {
            cover: if cover.is_some() {
                ArtifactStatus::Ready
            } else {
                snapshot_status(thumbnail_job.as_ref(), false)
            },
            strip: if strip.is_some() {
                ArtifactStatus::Ready
            } else {
                snapshot_status(thumbnail_job.as_ref(), false)
            },
            proxy: if proxy.is_some() {
                ArtifactStatus::Ready
            } else {
                snapshot_status(proxy_job.as_ref(), proxy_direct)
            },
            waveform: if waveform.is_some() {
                ArtifactStatus::Ready
            } else {
                snapshot_status(waveform_job.as_ref(), false)
            },
        },
        cover,
        strip,
        proxy,
        waveform,
    })
}

#[allow(clippy::too_many_arguments)]
fn valid_artifact_url(
    connection: &mut Connection,
    cache_root: &Path,
    port: u16,
    token: &str,
    clip_id: i64,
    source_hash: &str,
    kind: &str,
    file_name: &str,
) -> Result<Option<String>> {
    let rel_path = connection
        .query_row(
            "SELECT rel_path FROM cache_artifacts
             WHERE clip_id = ?1 AND kind = ?2 AND source_hash = ?3",
            params![clip_id, kind, source_hash],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(rel_path) = rel_path else {
        return Ok(None);
    };
    let expected = artifact_relative_path(clip_id, file_name);
    if rel_path == path_to_rel_string(&expected) && cache_root.join(&expected).is_file() {
        return Ok(Some(cache_url(port, token, clip_id, file_name)?));
    }
    connection.execute(
        "DELETE FROM cache_artifacts WHERE clip_id = ?1 AND kind = ?2",
        params![clip_id, kind],
    )?;
    Ok(None)
}

fn latest_job(
    connection: &Connection,
    kind: &str,
    clip_id: i64,
    source_hash: &str,
) -> Result<Option<JobSnapshot>> {
    let mut statement = connection.prepare(
        "SELECT id, status, result_path, payload
         FROM jobs WHERE kind = ?1 ORDER BY id DESC",
    )?;
    let rows = statement.query_map([kind], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (id, status, result_path, payload_json) = row?;
        let Ok(payload) = serde_json::from_str::<ArtifactJobPayload>(&payload_json) else {
            continue;
        };
        if payload.clip_id == clip_id && payload.source_hash == source_hash {
            return Ok(Some(JobSnapshot {
                id,
                status,
                result_path,
            }));
        }
    }
    Ok(None)
}

fn requeue_if_cache_missing(
    connection: &mut Connection,
    snapshot: Option<JobSnapshot>,
    cache_missing: bool,
) -> Result<Option<JobSnapshot>> {
    let Some(mut snapshot) = snapshot else {
        return Ok(None);
    };
    if cache_missing && snapshot.status == "done" {
        connection.execute(
            "UPDATE jobs
             SET status = 'pending', attempt = 0, result_path = NULL,
                 blocked_summary = NULL, finished_at = NULL,
                 next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND status = 'done'",
            [snapshot.id],
        )?;
        snapshot.status = "pending".to_owned();
        snapshot.result_path = None;
    }
    Ok(Some(snapshot))
}

fn snapshot_status(snapshot: Option<&JobSnapshot>, direct: bool) -> ArtifactStatus {
    if direct {
        return ArtifactStatus::Direct;
    }
    match snapshot.map(|snapshot| snapshot.status.as_str()) {
        Some("pending") => ArtifactStatus::Pending,
        Some("running") => ArtifactStatus::Running,
        Some("failed" | "blocked") => ArtifactStatus::Failed,
        Some("done") => ArtifactStatus::Missing,
        _ => ArtifactStatus::Missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn insert_source(
        connection: &Connection,
        path: &Path,
        height: i64,
    ) -> (i64, String) {
        let (source_hash, bytes) = crate::core::import::quick_fingerprint(path).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('artifact-test-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, byte_size, quick_hash,
                    tb_num, tb_den, duration_ticks, width, height
                 ) VALUES (
                    'artifact-test-volume', ?1, ?2, ?3,
                    1, 1000, 2000, 1280, ?4
                 )",
                params![path.to_string_lossy(), bytes as i64, source_hash, height],
            )
            .unwrap();
        (connection.last_insert_rowid(), source_hash)
    }

    #[test]
    fn peak_calculation_is_fixed_length_and_normalized() {
        let peaks = compute_peaks(&[i16::MIN, -1, 1, i16::MAX], 2_000);
        assert_eq!(peaks.len(), 2_000);
        assert!(peaks.iter().all(|peak| peak[0] >= -1.0 && peak[1] <= 1.0));
        assert!(peaks.iter().any(|peak| peak[0] == -1.0));
        assert!(peaks.iter().any(|peak| peak[1] == 1.0));
    }

    #[test]
    fn strip_frame_count_follows_five_second_rule_and_twelve_frame_cap() {
        assert_eq!(strip_frame_count(0.1), 1);
        assert_eq!(strip_frame_count(30.0), 6);
        assert_eq!(strip_frame_count(600.0), 12);
    }

    #[test]
    fn repeated_enqueue_does_not_duplicate_same_source_jobs() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);

        enqueue_for_clip(&mut connection, clip_id, &source, &source_hash).unwrap();
        enqueue_for_clip(&mut connection, clip_id, &source, &source_hash).unwrap();

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs
                 WHERE kind IN ('thumbnail', 'waveform', 'proxy')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn disabled_proxy_encoding_still_enqueues_identity_mapping_job() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 480);
        super::super::settings::set_setting(
            &connection,
            super::super::settings::PROXY_ENABLED_KEY,
            "false",
        )
        .unwrap();

        enqueue_for_clip(&mut connection, clip_id, &source, &source_hash).unwrap();

        let proxy_job_id: i64 = connection
            .query_row(
                "SELECT id FROM jobs WHERE kind = 'proxy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute(
                "UPDATE jobs SET status = 'running', attempt = 1 WHERE id = ?1",
                [proxy_job_id],
            )
            .unwrap();
        let job = jobs::get(&connection, proxy_job_id).unwrap();

        run_proxy(&mut connection, &job, directory.path()).unwrap();

        let mapped: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM proxy_time_map WHERE clip_id = ?1",
                [clip_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(mapped >= 2);
        assert_eq!(
            jobs::get(&connection, proxy_job_id)
                .unwrap()
                .result_path
                .as_deref(),
            Some("direct")
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_proxy_process_never_promotes_half_written_temporary_file() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"source bytes").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let (clip_id, source_hash) = insert_source(&connection, &source, 720);
        let payload = serde_json::to_string(&ArtifactJobPayload {
            clip_id,
            path: source.to_string_lossy().into_owned(),
            source_hash,
        })
        .unwrap();
        jobs::enqueue(&mut connection, "proxy", &payload, "partial-proxy").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();

        let fake_ffmpeg = directory.path().join("fake-ffmpeg");
        std::fs::write(
            &fake_ffmpeg,
            "#!/bin/sh\nfor output_path do :; done\nprintf partial > \"$output_path\"\nexit 9\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake_ffmpeg).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_ffmpeg, permissions).unwrap();

        let cache_root = directory.path().join("cache");
        let error = run_proxy_with(
            &mut connection,
            &job,
            &cache_root,
            fake_ffmpeg.as_os_str(),
            fake_ffmpeg.as_os_str(),
            Duration::from_secs(2),
        )
        .unwrap_err();
        let final_path = cache_root.join(format!("{clip_id}/{PROXY_FILE}"));
        let temporary_path = jobs::temporary_output_path(&final_path, job.attempt);

        assert!(error.to_string().contains("代理转码失败"));
        assert!(error.to_string().contains("VideoToolbox 硬件解码"));
        assert!(error.to_string().contains("CPU 解码 + VideoToolbox 编码"));
        assert!(!error.to_string().contains("libx264"));
        assert!(!final_path.exists());
        assert!(!temporary_path.exists());
    }

    #[test]
    fn proxy_uses_cpu_decode_fallback_but_only_the_bundled_videotoolbox_encoder() {
        let hardware = proxy_args("source.mov", Path::new("proxy.mp4"), true);
        let software = proxy_args("source.mov", Path::new("proxy.mp4"), false);
        let hardware = hardware
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let software = software
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(hardware.contains("-hwaccel videotoolbox"));
        assert!(!software.contains("-hwaccel"));
        for args in [&hardware, &software] {
            assert!(args.contains("h264_videotoolbox"));
            assert!(args.contains("-allow_sw 1"));
            assert!(args.contains("-b:v 4M"));
            assert!(!args.contains("libx264"));
        }
    }
}
