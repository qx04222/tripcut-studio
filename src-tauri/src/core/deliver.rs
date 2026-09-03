use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::{CoreError, Result};
use super::jobs::{self, Job};

const EXPORT_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
const PROJECT_NAME: &str = "旅剪项目";
const PACKAGE_SUFFIX: &str = "剪映交付";
const SELECTED_DIRECTORY: &str = "01_精选片段";
const ROUGH_CUT_FILE: &str = "02_参考粗剪.mp4";
const SUBTITLE_DIRECTORY: &str = "03_字幕";
const SHOT_LIST_FILE: &str = "03_镜头表.csv";
const DESTINATION_DIRECTORY: &str = "05_地点卡";
const README_FILE: &str = "交付说明.txt";
const COMPLETION_MARKER_FILE: &str = ".tripcut-complete.json";

type CancellationMap = HashMap<(String, i64), Arc<AtomicBool>>;

static CANCELLATIONS: OnceLock<Mutex<CancellationMap>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ExportClip {
    pub(crate) clip_id: i64,
    #[serde(default)]
    pub(crate) segment_id: Option<i64>,
    #[serde(default = "whole_selection_kind")]
    pub(crate) selection_kind: String,
    #[serde(default)]
    pub(crate) in_ticks: Option<i64>,
    #[serde(default)]
    pub(crate) out_ticks: Option<i64>,
    #[serde(default)]
    pub(crate) tb_num: Option<i64>,
    #[serde(default)]
    pub(crate) tb_den: Option<i64>,
    #[serde(default)]
    pub(crate) volume_uuid: String,
    #[serde(default)]
    pub(crate) rel_path: String,
    #[serde(default)]
    pub(crate) quick_hash: String,
    pub(crate) full_hash: Option<String>,
    #[serde(skip)]
    pub(crate) source_path: String,
    pub(crate) file_name: String,
    byte_size: u64,
    #[serde(default)]
    source_byte_size: u64,
    pub(crate) width: Option<i64>,
    pub(crate) height: Option<i64>,
    codec: Option<String>,
    fps_num: Option<i64>,
    fps_den: Option<i64>,
    is_vfr: bool,
    captured_at: Option<String>,
    #[serde(default)]
    chapter_title: String,
    #[serde(default)]
    beat_label: String,
    stars: Option<i64>,
    l1_summary: String,
    has_audio: Option<bool>,
    #[serde(default)]
    dialogue_summary: String,
    #[serde(default)]
    pub(crate) srt_rel_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportProgress {
    stage: String,
    completed_items: u64,
    failed_items: u64,
    cancel_requested: bool,
    message: Option<String>,
    items: Vec<ExportItemStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportJobPayload {
    version: u8,
    #[serde(default)]
    episode_id: Option<i64>,
    #[serde(default)]
    episode_memory_id: Option<String>,
    destination: String,
    project_name: String,
    date: String,
    selected_bytes: u64,
    clips: Vec<ExportClip>,
    progress: ExportProgress,
    output_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TickBounds {
    first: i64,
    end: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CompletionMarker {
    version: u8,
    job_id: i64,
    attempt: i64,
    payload_hash: String,
}

impl CompletionMarker {
    fn matches(&self, job_id: i64, payload_hash: &str) -> bool {
        self.version == 1 && self.job_id == job_id && self.payload_hash == payload_hash
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExportItemStatus {
    pub clip_id: i64,
    pub file_name: String,
    pub output_name: String,
    pub status: String,
    pub note: Option<String>,
    #[serde(default)]
    pub warning: bool,
}

fn whole_selection_kind() -> String {
    "whole".to_owned()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExportStatus {
    pub job_id: Option<i64>,
    pub status: String,
    pub stage: String,
    pub selected_count: u64,
    pub selected_segment_count: u64,
    pub selected_whole_count: u64,
    pub total_duration_seconds: f64,
    pub completed_items: u64,
    pub failed_items: u64,
    pub items: Vec<ExportItemStatus>,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug)]
enum CommandError {
    Cancelled,
    Io(std::io::Error),
}

struct CancellationRegistration {
    key: (String, i64),
    flag: Arc<AtomicBool>,
}

impl CancellationRegistration {
    fn register(key: (String, i64)) -> Self {
        // 覆盖式注册 + 按(库路径,job id)键控:测试临时库/历史泄漏都不得污染本次运行。
        let flag = Arc::new(AtomicBool::new(false));
        let mut flags = cancellation_flags().lock().unwrap_or_else(|error| error.into_inner());
        flags.insert(key.clone(), flag.clone());
        drop(flags);
        Self { key, flag }
    }
}

impl Drop for CancellationRegistration {
    fn drop(&mut self) {
        let mut flags = cancellation_flags().lock().unwrap_or_else(|error| error.into_inner());
        flags.remove(&self.key);
    }
}

struct StagingDirectory {
    path: PathBuf,
    promoted: bool,
}

impl StagingDirectory {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            promoted: false,
        }
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if !self.promoted {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

#[derive(Debug)]
struct SuccessfulClip {
    clip: ExportClip,
    path: PathBuf,
}

fn cancellation_key(connection: &Connection, job_id: i64) -> (String, i64) {
    let db = connection.path().unwrap_or("<memory>").to_owned();
    (db, job_id)
}

fn cancellation_flags() -> &'static Mutex<CancellationMap> {
    CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn clip_duration_seconds(clip: &ExportClip) -> f64 {
    match (clip.in_ticks, clip.out_ticks, clip.tb_num, clip.tb_den) {
        (Some(start), Some(end), Some(num), Some(den)) if end >= start && num > 0 && den > 0 => {
            end.saturating_sub(start) as f64 * num as f64 / den as f64
        }
        _ => 0.0,
    }
}

fn total_duration_seconds(clips: &[ExportClip]) -> f64 {
    clips.iter().map(clip_duration_seconds).sum()
}

fn selection_kind_counts(clips: &[ExportClip]) -> (u64, u64) {
    clips.iter().fold((0, 0), |(segments, whole), clip| {
        if clip.selection_kind == "select" {
            (segments + 1, whole)
        } else {
            (segments, whole + 1)
        }
    })
}

fn selected_estimated_bytes(clip: &ExportClip) -> u64 {
    clip.byte_size
}

fn canonical_payload_hash(payload: &ExportJobPayload) -> Result<String> {
    let selections = payload
        .clips
        .iter()
        .map(|clip| {
            (
                clip.clip_id,
                clip.segment_id,
                clip.selection_kind.as_str(),
                clip.in_ticks,
                clip.out_ticks,
                clip.tb_num,
                clip.tb_den,
                clip.volume_uuid.as_str(),
                clip.rel_path.as_str(),
                clip.quick_hash.as_str(),
                clip.source_byte_size,
            )
        })
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&(
        payload.version,
        payload.episode_id,
        &payload.episode_memory_id,
        &payload.destination,
        &payload.project_name,
        &payload.date,
        payload.selected_bytes,
        selections,
    ))
    .map_err(|error| CoreError::Export(format!("无法规范化交付任务：{error}")))?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

fn write_completion_marker(
    directory: &Path,
    job_id: i64,
    attempt: i64,
    payload_hash: &str,
) -> Result<()> {
    let marker = CompletionMarker {
        version: 1,
        job_id,
        attempt,
        payload_hash: payload_hash.to_owned(),
    };
    let bytes = serde_json::to_vec_pretty(&marker)
        .map_err(|error| CoreError::Export(format!("无法写入交付完成标记：{error}")))?;
    write_synced(&directory.join(COMPLETION_MARKER_FILE), &bytes)
}

fn read_completion_marker(directory: &Path) -> Result<Option<CompletionMarker>> {
    let path = directory.join(COMPLETION_MARKER_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| CoreError::Export(format!("交付完成标记损坏：{error}")))
}

pub fn start_export(connection: &mut Connection, destination: &Path) -> Result<ExportStatus> {
    let destination = destination.canonicalize().map_err(|error| {
        CoreError::Export(format!(
            "无法打开交付目标目录 {}：{error}",
            destination.display()
        ))
    })?;
    if !destination.is_dir() {
        return Err(CoreError::Export(format!(
            "交付目标不是文件夹：{}",
            destination.display()
        )));
    }

    // Freeze Episode identity, narrative selection and the queued job under one write lock.
    // Archiving in another connection cannot splice EP01 clips into an EP02 payload.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (episode_id, episode_memory_id): (i64, String) = transaction
        .query_row(
            "SELECT id, memory_id FROM episodes WHERE status = 'active'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| CoreError::Export("没有进行中的 Episode，无法创建交付任务".to_owned()))?;
    let clips = selected_clips(&transaction)?;
    if clips.is_empty() {
        return Err(CoreError::Export(
            "当前没有精选段或收藏素材；请先打点保存片段，或用 F 收藏整条素材".to_owned(),
        ));
    }
    let selected_bytes = clips.iter().map(selected_estimated_bytes).sum::<u64>();
    let required_bytes = estimated_required_bytes(selected_bytes);
    let available_bytes = available_space_bytes(&destination)?;
    ensure_capacity(required_bytes, available_bytes)?;

    let date: String = transaction.query_row(
        "SELECT strftime('%Y-%m-%d', 'now', 'localtime')",
        [],
        |row| row.get(0),
    )?;
    let items = clips
        .iter()
        .enumerate()
        .map(|(index, clip)| ExportItemStatus {
            clip_id: clip.clip_id,
            file_name: clip.file_name.clone(),
            output_name: export_file_name(index + 1, &clip.file_name),
            status: "pending".to_owned(),
            note: None,
            warning: false,
        })
        .collect();
    let payload = ExportJobPayload {
        version: 4,
        episode_id: Some(episode_id),
        episode_memory_id: Some(episode_memory_id),
        destination: destination.to_string_lossy().into_owned(),
        project_name: PROJECT_NAME.to_owned(),
        date,
        selected_bytes,
        clips,
        progress: ExportProgress {
            stage: "queued".to_owned(),
            completed_items: 0,
            failed_items: 0,
            cancel_requested: false,
            message: Some("等待交付任务开始".to_owned()),
            items,
        },
        output_path: None,
    };
    let payload_json = serialize_payload(&payload)?;
    let payload_hash = canonical_payload_hash(&payload)?;
    let inserted = transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            'export_package', ?1, ?2, 'pending', 0,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ) ON CONFLICT DO NOTHING",
        params![payload_json, payload_hash],
    )?;
    let job_id = if inserted == 1 {
        transaction.last_insert_rowid()
    } else {
        transaction.query_row(
            "SELECT id FROM jobs
             WHERE kind = 'export_package' AND payload_hash = ?1
               AND status IN ('pending', 'running')
             ORDER BY id DESC LIMIT 1",
            [payload_hash],
            |row| row.get(0),
        )?
    };
    transaction.commit()?;
    get_export_status(connection, Some(job_id))
}

pub fn get_export_status(connection: &Connection, job_id: Option<i64>) -> Result<ExportStatus> {
    let row = match job_id {
        Some(job_id) => connection
            .query_row(
                "SELECT id, status, payload, result_path, blocked_summary
                 FROM jobs WHERE id = ?1 AND kind = 'export_package'",
                [job_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?,
        None => connection
            .query_row(
                "SELECT id, status, payload, result_path, blocked_summary
                 FROM jobs WHERE kind = 'export_package'
                   AND status IN ('pending', 'running')
                   AND CAST(json_extract(payload, '$.episode_id') AS INTEGER) = (
                       SELECT id FROM episodes WHERE status = 'active' LIMIT 1
                   )
                 ORDER BY id DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?,
    };

    let Some((id, status, payload_json, result_path, error)) = row else {
        let clips = selected_clips(connection)?;
        let (selected_segment_count, selected_whole_count) = selection_kind_counts(&clips);
        return Ok(ExportStatus {
            job_id: None,
            status: "idle".to_owned(),
            stage: "idle".to_owned(),
            selected_count: clips.len() as u64,
            selected_segment_count,
            selected_whole_count,
            total_duration_seconds: total_duration_seconds(&clips),
            completed_items: 0,
            failed_items: 0,
            items: Vec::new(),
            output_path: None,
            error: None,
        });
    };
    let payload = parse_payload(&payload_json)?;
    let (selected_segment_count, selected_whole_count) = selection_kind_counts(&payload.clips);
    Ok(ExportStatus {
        job_id: Some(id),
        status,
        stage: payload.progress.stage,
        selected_count: payload.clips.len() as u64,
        selected_segment_count,
        selected_whole_count,
        total_duration_seconds: total_duration_seconds(&payload.clips),
        completed_items: payload.progress.completed_items,
        failed_items: payload.progress.failed_items,
        items: payload.progress.items,
        output_path: result_path.or(payload.output_path),
        error,
    })
}

pub fn cancel_export(connection: &mut Connection, job_id: i64) -> Result<()> {
    let (status, payload_json) = connection
        .query_row(
            "SELECT status, payload FROM jobs
             WHERE id = ?1 AND kind = 'export_package'",
            [job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::Export(format!("交付任务 {job_id} 不存在")))?;
    if !matches!(status.as_str(), "pending" | "running") {
        return Ok(());
    }

    let flag = {
        let key = cancellation_key(connection, job_id);
        let mut flags = cancellation_flags().lock().unwrap_or_else(|error| error.into_inner());
        flags
            .entry(key)
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    };
    flag.store(true, Ordering::SeqCst);

    let mut payload = parse_payload(&payload_json)?;
    payload.progress.cancel_requested = true;
    payload.progress.stage = "cancelling".to_owned();
    payload.progress.message = Some("正在取消并清理半成品".to_owned());
    let serialized = serialize_payload(&payload)?;
    if status == "pending" {
        connection.execute(
            "UPDATE jobs
             SET status = 'failed', payload = ?2, blocked_summary = '用户已取消',
                 cancel_requested = 1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND status = 'pending'",
            params![job_id, serialized],
        )?;
        let mut flags = cancellation_flags().lock().unwrap_or_else(|error| error.into_inner());
        flags.remove(&cancellation_key(connection, job_id));
    } else {
        connection.execute(
            "UPDATE jobs
             SET payload = ?2, cancel_requested = 1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND status = 'running'",
            params![job_id, serialized],
        )?;
    }
    jobs::request_cancel(connection, job_id)?;
    Ok(())
}

pub fn run_export_package(connection: &mut Connection, job: &Job) -> Result<()> {
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let ffprobe = super::settings::configured_ffprobe(connection, &ffmpeg)?;
    run_export_package_with(connection, job, &ffmpeg, &ffprobe)
}

pub fn mark_export_failed(
    connection: &mut Connection,
    job: &Job,
    summary: &str,
) -> Result<()> {
    let payload_json = connection
        .query_row(
            "SELECT payload FROM jobs
             WHERE id = ?1 AND status = 'running' AND attempt = ?2",
            params![job.id, job.attempt],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(payload_json) = payload_json else {
        return Ok(());
    };
    let mut payload = parse_payload(&payload_json)?;
    payload.progress.stage = if summary.contains("用户已取消") {
        "cancelled".to_owned()
    } else {
        "failed".to_owned()
    };
    payload.progress.message = Some(summary.to_owned());
    let payload_json = serialize_payload(&payload)?;
    let changed = connection.execute(
        "UPDATE jobs
         SET status = 'failed', payload = ?3, blocked_summary = ?4,
             owner_id = NULL, lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2",
        params![job.id, job.attempt, payload_json, summary],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "export job {} attempt {} is not running",
            job.id, job.attempt
        )));
    }
    let mut flags = cancellation_flags().lock().unwrap_or_else(|error| error.into_inner());
    flags.remove(&cancellation_key(connection, job.id));
    Ok(())
}

fn run_export_package_with(
    connection: &mut Connection,
    job: &Job,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
) -> Result<()> {
    let cancellation = CancellationRegistration::register(cancellation_key(connection, job.id));
    let mut payload = parse_payload(&job.payload)?;
    let episode_id = payload
        .episode_id
        .ok_or_else(|| CoreError::Export("旧交付任务缺少 Episode 归属；请重新创建".to_owned()))?;
    let episode_memory_id = payload
        .episode_memory_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CoreError::Export("旧交付任务缺少稳定 Episode 标识；请重新创建".to_owned()))?;
    let identity_matches: i64 = connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM episodes WHERE id = ?1 AND memory_id = ?2
         )",
        params![episode_id, episode_memory_id],
        |row| row.get(0),
    )?;
    if identity_matches != 1 {
        return Err(CoreError::Export(
            "交付任务的 Episode 身份已失效；已在处理媒体前停止".to_owned(),
        ));
    }
    for clip in &payload.clips {
        let owned: i64 = connection.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM clips WHERE id = ?1 AND episode_id = ?2
             )",
            params![clip.clip_id, episode_id],
            |row| row.get(0),
        )?;
        if owned != 1 {
            return Err(CoreError::Export(format!(
                "素材 {} 不属于交付任务固定的 Episode；已停止",
                clip.clip_id
            )));
        }
    }
    let payload_hash: String = connection.query_row(
        "SELECT payload_hash FROM jobs WHERE id=?1",
        [job.id],
        |row| row.get(0),
    )?;
    if let Some(existing) = payload.output_path.clone().map(PathBuf::from) {
        if read_completion_marker(&existing)?
            .is_some_and(|marker| marker.matches(job.id, &payload_hash))
        {
            return adopt_completed_package(connection, job, &mut payload, &existing);
        }
    }
    if payload.progress.cancel_requested {
        cancellation.flag.store(true, Ordering::SeqCst);
    }
    check_cancelled(&cancellation.flag)?;

    for clip in &mut payload.clips {
        clip.source_path = verified_export_source(connection, clip)?
            .to_string_lossy()
            .into_owned();
    }

    let destination = PathBuf::from(&payload.destination);
    if !destination.is_dir() {
        return Err(CoreError::Export(format!(
            "交付目标目录已不可用：{}",
            destination.display()
        )));
    }
    ensure_capacity(
        estimated_required_bytes(payload.selected_bytes),
        available_space_bytes(&destination)?,
    )?;

    let final_path = unique_package_path(
        &destination,
        &payload.project_name,
        &payload.date,
    );
    let staging_path = staging_path(&final_path, job.id, job.attempt);
    if staging_path.exists() {
        std::fs::remove_dir_all(&staging_path)?;
    }
    std::fs::create_dir(&staging_path)?;
    let mut staging = StagingDirectory::new(staging_path.clone());
    std::fs::create_dir(staging_path.join(SELECTED_DIRECTORY))?;

    payload.output_path = Some(final_path.to_string_lossy().into_owned());
    payload.progress.stage = "remuxing".to_owned();
    payload.progress.message = Some("正在整理精选片段".to_owned());
    persist_progress(connection, job, &payload)?;

    let mut successful = Vec::new();
    for index in 0..payload.clips.len() {
        check_cancelled(&cancellation.flag)?;
        payload.progress.items[index].status = "running".to_owned();
        payload.progress.items[index].note = None;
        payload.progress.items[index].warning = false;
        payload.progress.message = Some(format!(
            "正在处理 {} / {}：{}",
            index + 1,
            payload.clips.len(),
            payload.clips[index].file_name
        ));
        persist_progress(connection, job, &payload)?;

        let output_path = staging_path
            .join(SELECTED_DIRECTORY)
            .join(&payload.progress.items[index].output_name);
        let temporary_path = jobs::temporary_output_path(&output_path, job.attempt);
        remove_file_if_exists(&temporary_path)?;
        match export_clip(
            ffmpeg,
            ffprobe,
            &payload.clips[index],
            &temporary_path,
            &cancellation.flag,
        ) {
            Ok(warning) => {
                std::fs::rename(&temporary_path, &output_path)?;
                payload.progress.items[index].status = "done".to_owned();
                payload.progress.items[index].warning = warning.is_some();
                payload.progress.items[index].note = warning;
                payload.progress.completed_items += 1;
                successful.push(SuccessfulClip {
                    clip: payload.clips[index].clone(),
                    path: output_path,
                });
            }
            Err(error) if cancellation.flag.load(Ordering::SeqCst) => {
                let _ = std::fs::remove_file(&temporary_path);
                return Err(error);
            }
            Err(error) => {
                let _ = std::fs::remove_file(&temporary_path);
                payload.progress.items[index].status = "failed".to_owned();
                payload.progress.items[index].note = Some(error.to_string());
                payload.progress.failed_items += 1;
            }
        }
        persist_progress(connection, job, &payload)?;
    }

    if successful.is_empty() {
        return Err(CoreError::Export(
            "所有精选片段均无法读取，未生成交付包".to_owned(),
        ));
    }

    payload.progress.stage = "rough_cut".to_owned();
    payload.progress.message = Some("正在转码 1080p H.264 参考粗剪".to_owned());
    persist_progress(connection, job, &payload)?;
    let rough_cut_path = staging_path.join(ROUGH_CUT_FILE);
    let rough_cut_temporary = jobs::temporary_output_path(&rough_cut_path, job.attempt);
    remove_file_if_exists(&rough_cut_temporary)?;
    transcode_rough_cut(
        ffmpeg,
        ffprobe,
        &successful,
        &rough_cut_temporary,
        &cancellation.flag,
    )?;
    std::fs::rename(&rough_cut_temporary, &rough_cut_path)?;

    check_cancelled(&cancellation.flag)?;
    payload.progress.stage = "documents".to_owned();
    payload.progress.message = Some("正在写入镜头表与交付说明".to_owned());
    persist_progress(connection, job, &payload)?;
    let subtitle_count = copy_subtitles(
        connection,
        &payload.clips,
        &payload.progress.items,
        &staging_path,
    )?;
    let csv = build_shot_list_csv(&payload.clips, &payload.progress.items);
    write_synced(&staging_path.join(SHOT_LIST_FILE), csv.as_bytes())?;
    let episode_id = payload
        .episode_id
        .ok_or_else(|| CoreError::Export("交付任务缺少 Episode 归属".to_owned()))?;
    let destination_count = write_destination_cards(connection, &staging_path, episode_id)?;
    let instructions = build_instructions(&payload, subtitle_count, destination_count);
    write_synced(&staging_path.join(README_FILE), instructions.as_bytes())?;

    check_cancelled(&cancellation.flag)?;
    payload.progress.stage = "finalizing".to_owned();
    payload.progress.message = Some("正在完成原子交付".to_owned());
    persist_progress(connection, job, &payload)?;
    payload.progress.stage = "complete".to_owned();
    payload.progress.message = Some(if payload.progress.failed_items == 0 {
        "交付包已生成".to_owned()
    } else {
        format!(
            "交付包已生成；{} 条素材失败，详情见镜头表",
            payload.progress.failed_items
        )
    });
    payload.output_path = Some(final_path.to_string_lossy().into_owned());
    write_completion_marker(
        &staging_path,
        job.id,
        job.attempt,
        &payload_hash,
    )?;
    check_cancelled(&cancellation.flag)?;
    std::fs::rename(&staging_path, &final_path)?;
    staging.promoted = true;
    if let Some(parent) = final_path.parent() {
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
    }
    let manifest = serde_json::to_string_pretty(&payload)
        .map_err(|error| CoreError::Export(format!("无法生成交付审计：{error}")))?;
    let payload_json = serialize_payload(&payload)?;
    let memory_payload = channel_memory_payload(
        payload.episode_memory_id.as_deref(),
        successful.iter().map(|item| &item.clip),
    )?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let inserted = transaction.execute(
        "INSERT INTO exports(tier, manifest, created_at, output_path, episode_id)
         SELECT 'stable_package', ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?4, ?5
         WHERE EXISTS (
             SELECT 1 FROM jobs
             WHERE id = ?1 AND status = 'running' AND attempt = ?2
         )",
        params![
            job.id,
            job.attempt,
            manifest,
            final_path.to_string_lossy().into_owned(),
            payload.episode_id,
        ],
    )?;
    if inserted != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "export job {} attempt {} is not running",
            job.id, job.attempt
        )));
    }
    let export_id = transaction.last_insert_rowid();
    if let Some((episode_memory_id, selections_json)) = memory_payload {
        transaction.execute(
            "INSERT INTO channel_memory_outbox(
                 export_id, episode_memory_id, selections_json, status, created_at
             ) VALUES (?1, ?2, ?3, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![export_id, episode_memory_id, selections_json],
        )?;
    }
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', payload = ?3, result_path = ?4,
             blocked_summary = NULL, owner_id = NULL, lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2
           AND cancel_requested = 0",
        params![
            job.id,
            job.attempt,
            payload_json,
            final_path.to_string_lossy().into_owned()
        ],
    )?;
    if changed != 1 {
        drop(transaction);
        // A cancellation can win in the narrow window after filesystem rename
        // but before the database CAS. This directory is uniquely owned by this
        // job/attempt, so never leave a cancelled package looking successful.
        let _ = std::fs::remove_dir_all(&final_path);
        return Err(CoreError::InvalidTransition(format!(
            "export job {} changed during finalization",
            job.id
        )));
    }
    if let Err(error) = transaction.commit() {
        return Err(error.into());
    }
    if let Err(error) = flush_channel_memory_outbox(connection) {
        tracing::warn!(%error, export_id, "channel memory outbox remains pending");
    }
    Ok(())
}

pub(crate) fn verified_export_source(
    connection: &Connection,
    clip: &mut ExportClip,
) -> Result<PathBuf> {
    let current = connection
        .query_row(
            "SELECT volume_uuid, rel_path, byte_size, quick_hash, full_hash
             FROM clips WHERE id=?1",
            [clip.clip_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0) as u64,
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::Export(format!("素材 {} 已不存在", clip.clip_id)))?;
    if current.0 != clip.volume_uuid
        || current.1 != clip.rel_path
        || current.2 != clip.source_byte_size
        || current.3 != clip.quick_hash
        || clip
            .full_hash
            .as_ref()
            .is_some_and(|expected| current.4.as_ref() != Some(expected))
    {
        return Err(CoreError::Export(format!(
            "素材 {} 的身份信息在排队后发生变化；请重新创建交付任务",
            clip.clip_id
        )));
    }
    if clip.full_hash.is_none() {
        clip.full_hash = current.4;
    }
    super::media_source::verified_clip_path(connection, clip.clip_id)
        .map_err(|error| CoreError::Export(error.to_string()))
}

fn adopt_completed_package(
    connection: &mut Connection,
    job: &Job,
    payload: &mut ExportJobPayload,
    final_path: &Path,
) -> Result<()> {
    payload.progress.stage = "complete".to_owned();
    payload.progress.message = Some("已收养崩溃前完成的交付包".to_owned());
    payload.output_path = Some(final_path.to_string_lossy().into_owned());
    let manifest = serde_json::to_string_pretty(payload)
        .map_err(|error| CoreError::Export(format!("无法恢复交付审计：{error}")))?;
    let payload_json = serialize_payload(payload)?;
    let memory_payload = channel_memory_payload(
        payload.episode_memory_id.as_deref(),
        payload
            .clips
            .iter()
            .zip(&payload.progress.items)
            .filter(|(_, status)| status.status == "done")
            .map(|(clip, _)| clip),
    )?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT INTO exports(tier, manifest, created_at, output_path, episode_id)
         VALUES ('stable_package', ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?2, ?3)",
        params![manifest, final_path.to_string_lossy().into_owned(), payload.episode_id],
    )?;
    let export_id = transaction.last_insert_rowid();
    if let Some((episode_memory_id, selections_json)) = memory_payload {
        transaction.execute(
            "INSERT INTO channel_memory_outbox(
                 export_id, episode_memory_id, selections_json, status, created_at
             ) VALUES (?1, ?2, ?3, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![export_id, episode_memory_id, selections_json],
        )?;
    }
    let changed = transaction.execute(
        "UPDATE jobs SET status='done', payload=?3, result_path=?4,
         blocked_summary=NULL, owner_id=NULL, lease_expires_at=NULL,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id=?1 AND status='running' AND attempt=?2 AND cancel_requested=0",
        params![
            job.id,
            job.attempt,
            payload_json,
            final_path.to_string_lossy().into_owned()
        ],
    )?;
    if changed != 1 {
        drop(transaction);
        let _ = std::fs::remove_dir_all(final_path);
        return Err(CoreError::InvalidTransition(format!(
            "export job {} changed during completion-marker adoption",
            job.id
        )));
    }
    transaction.commit()?;
    if let Err(error) = flush_channel_memory_outbox(connection) {
        tracing::warn!(%error, export_id, "channel memory outbox remains pending after adoption");
    }
    Ok(())
}

fn channel_memory_payload<'a>(
    episode_memory_id: Option<&str>,
    clips: impl Iterator<Item = &'a ExportClip>,
) -> Result<Option<(String, String)>> {
    let selections = clips
        .map(|clip| super::channel_memory::ExportedSelection {
            clip_id: clip.clip_id,
            segment_id: clip.segment_id,
            in_ticks: clip.in_ticks.unwrap_or(0),
            out_ticks: clip.out_ticks.unwrap_or(0),
        })
        .collect::<Vec<_>>();
    if selections.is_empty() {
        return Ok(None);
    }
    let episode_memory_id = episode_memory_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CoreError::Export(
                "交付任务缺少稳定 Episode 标识；已拒绝写入长期记忆".to_owned(),
            )
        })?;
    let json = serde_json::to_string(&selections)
        .map_err(|error| CoreError::Export(format!("长期记忆 outbox 序列化失败：{error}")))?;
    Ok(Some((episode_memory_id.to_owned(), json)))
}

pub fn flush_channel_memory_outbox(connection: &Connection) -> Result<u64> {
    let mut statement = connection.prepare(
        "SELECT export_id, episode_memory_id, selections_json
         FROM channel_memory_outbox WHERE status = 'pending' ORDER BY export_id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let channel_path = super::channel_memory::channel_path_for_project(connection)?;
    let mut synced = 0_u64;
    for (export_id, episode_memory_id, json) in rows {
        let selections: Vec<super::channel_memory::ExportedSelection> =
            serde_json::from_str(&json).map_err(|error| {
                CoreError::Export(format!("长期记忆 outbox {export_id} 损坏：{error}"))
            })?;
        match super::channel_memory::record_successful_export(
            connection,
            &channel_path,
            &episode_memory_id,
            &selections,
        ) {
            Ok(()) => {
                connection.execute(
                    "UPDATE channel_memory_outbox
                     SET status = 'done', last_error = NULL,
                         synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     WHERE export_id = ?1 AND status = 'pending'",
                    [export_id],
                )?;
                synced += 1;
            }
            Err(error) => {
                connection.execute(
                    "UPDATE channel_memory_outbox SET last_error = ?2
                     WHERE export_id = ?1 AND status = 'pending'",
                    params![export_id, error.to_string()],
                )?;
            }
        }
    }
    Ok(synced)
}

pub(crate) fn selected_clips(connection: &Connection) -> Result<Vec<ExportClip>> {
    let narrative_active =
        super::settings::string_value(connection, super::settings::LLM_ENABLED_KEY, "false")?
            == "true"
            && super::narrative::load_overview(connection)?.is_some();
    // G4:交付只能带出当前 active 集的素材;历史集封存后其精选段/收藏必须留在
    // 原集,不能被后续集的交付任务再次带出(回归发现的跨集污染缺口)。
    let active_episode: Option<i64> = connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .optional()?;
    // G2:beat 顺序只读当前 active 集的权威修订(confirmed 优先),防止建议版/确认版双份 join。
    let active_revision: Option<i64> = if narrative_active {
        match active_episode {
            Some(id) => super::narrative_revision::active_revision_id(connection, id)?,
            None => None,
        }
    } else {
        None
    };
    let mut statement = connection.prepare(
        "WITH live_selects AS (
             SELECT id, clip_id, in_ticks, out_ticks
             FROM segments
             WHERE kind = 'select' AND tombstone = 0
         )
         SELECT c.id,
                COALESCE(
                    (SELECT CASE WHEN json_valid(j.payload)
                            THEN json_extract(j.payload, '$.path') END
                     FROM jobs j
                     WHERE j.kind IN ('analyze_l1', 'thumbnail', 'waveform', 'proxy')
                       AND CAST(CASE WHEN json_valid(j.payload)
                            THEN json_extract(j.payload, '$.clip_id') END AS INTEGER) = c.id
                     ORDER BY CASE j.kind WHEN 'analyze_l1' THEN 1 ELSE 0 END DESC,
                              j.id DESC LIMIT 1),
                    c.rel_path
                ) AS source_path,
                c.rel_path, c.byte_size, c.duration_ticks, c.tb_num, c.tb_den,
                c.width, c.height, c.codec, c.fps_num, c.fps_den, c.is_vfr,
                c.captured_at,
                COALESCE(narrative_chapter.title, chapter.title, ''),
                CASE WHEN narrative_beat.id IS NULL THEN ''
                     ELSE printf('%02d · %s', narrative_beat.\"order\" + 1, narrative_beat.role)
                END,
                (SELECT star.value
                 FROM ratings star
                 JOIN segments star_segment ON star_segment.id = star.segment_id
                 WHERE star_segment.clip_id = c.id AND star_segment.tombstone = 0
                   AND star.rating_type = 'star'
                 ORDER BY star.rated_at DESC, star.id DESC LIMIT 1) AS stars,
                a.exposure_yavg, a.overexposed_ratio, a.audio_clipped,
                a.has_audio, a.focus_scores,
                (SELECT group_concat(ordered.text, '')
                 FROM (
                     SELECT ts.text AS text
                     FROM transcript_segments ts
                     WHERE ts.clip_id = c.id
                     ORDER BY ts.seg_index
                 ) ordered) AS transcript_text,
                (SELECT artifact.rel_path
                 FROM cache_artifacts artifact
                 WHERE artifact.clip_id = c.id
                   AND artifact.kind = 'srt'
                   AND artifact.source_hash = c.quick_hash
                 LIMIT 1) AS srt_rel_path,
                selected_segment.id, selected_segment.in_ticks, selected_segment.out_ticks,
                c.volume_uuid, c.quick_hash, c.full_hash
         FROM clips c
         LEFT JOIN live_selects selected_segment ON selected_segment.clip_id = c.id
         LEFT JOIN clip_analysis a ON a.clip_id = c.id
         LEFT JOIN chapters chapter
           ON chapter.id = c.chapter_id AND chapter.tombstone = 0
         LEFT JOIN narrative_beats narrative_beat
           ON narrative_beat.clip_id = c.id
          AND ((selected_segment.id IS NULL AND narrative_beat.segment_id IS NULL)
            OR narrative_beat.segment_id = selected_segment.id)
          AND ?1 = 1
          AND EXISTS (SELECT 1 FROM narrative_chapters rc
                       WHERE rc.id = narrative_beat.chapter_id AND rc.revision_id = ?2)
         LEFT JOIN narrative_chapters narrative_chapter
           ON narrative_chapter.id = narrative_beat.chapter_id
          AND narrative_chapter.revision_id = ?2
         LEFT JOIN story_order story
           ON story.tombstone = 0
          AND story.clip_id = c.id
          AND (
              (selected_segment.id IS NOT NULL
               AND story.item_kind = 'segment'
               AND story.segment_id = selected_segment.id)
              OR (selected_segment.id IS NULL AND story.item_kind = 'whole')
          )
         WHERE (c.episode_id = ?3 OR c.episode_id IS NULL)
           AND (
             selected_segment.id IS NOT NULL
             OR (
                NOT EXISTS (
                    SELECT 1 FROM live_selects candidate WHERE candidate.clip_id = c.id
                )
                AND 1 = (
                    SELECT binary.value
                    FROM ratings binary
                    JOIN segments binary_segment ON binary_segment.id = binary.segment_id
                    WHERE binary_segment.clip_id = c.id
                      AND COALESCE(binary_segment.kind, 'whole') != 'select'
                      AND binary_segment.tombstone = 0
                      AND binary.rating_type = 'binary'
                    ORDER BY binary.rated_at DESC, binary.id DESC LIMIT 1
                )
             )
           )
         ORDER BY narrative_chapter.id IS NULL,
                  narrative_chapter.\"order\", narrative_beat.\"order\",
                  story.position IS NULL, story.position,
                  c.captured_at IS NULL, c.captured_at, c.id,
                  selected_segment.in_ticks, selected_segment.id",
    )?;
    let rows = statement.query_map(
        params![if narrative_active { 1_i64 } else { 0_i64 }, active_revision, active_episode],
        |row| {
        let _queued_source_path: String = row.get(1)?;
        let rel_path: String = row.get(2)?;
        let source_duration_ticks = row.get::<_, Option<i64>>(4)?.unwrap_or(0);
        let tb_num = row.get::<_, Option<i64>>(5)?.unwrap_or(0);
        let tb_den = row.get::<_, Option<i64>>(6)?.unwrap_or(0);
        let segment_id = row.get::<_, Option<i64>>(24)?;
        let in_ticks = row.get::<_, Option<i64>>(25)?.unwrap_or(0);
        let out_ticks = row
            .get::<_, Option<i64>>(26)?
            .unwrap_or(source_duration_ticks);
        let selected_ticks = out_ticks.saturating_sub(in_ticks).max(0);
        let source_bytes = row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64;
        let byte_size = if segment_id.is_some() && source_duration_ticks > 0 {
            ((source_bytes as f64 * selected_ticks as f64 / source_duration_ticks as f64).ceil()
                as u64)
                .max(1)
        } else {
            source_bytes
        };
        let exposure = row.get::<_, Option<f64>>(17)?;
        let overexposed = row.get::<_, Option<f64>>(18)?;
        let audio_clipped = row.get::<_, Option<i64>>(19)?.map(|value| value == 1);
        let has_audio = row.get::<_, Option<i64>>(20)?.map(|value| value == 1);
        let focus_scores = row.get::<_, Option<String>>(21)?;
        let transcript_text = row.get::<_, Option<String>>(22)?;
        Ok(ExportClip {
            clip_id: row.get(0)?,
            segment_id,
            selection_kind: if segment_id.is_some() { "select" } else { "whole" }.to_owned(),
            in_ticks: Some(in_ticks),
            out_ticks: Some(out_ticks),
            tb_num: (tb_num > 0).then_some(tb_num),
            tb_den: (tb_den > 0).then_some(tb_den),
            volume_uuid: row.get(27)?,
            rel_path: rel_path.clone(),
            quick_hash: row.get(28)?,
            full_hash: row.get(29)?,
            source_path: String::new(),
            file_name: Path::new(&rel_path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or(rel_path),
            byte_size,
            source_byte_size: source_bytes,
            width: row.get(7)?,
            height: row.get(8)?,
            codec: row.get(9)?,
            fps_num: row.get(10)?,
            fps_den: row.get(11)?,
            is_vfr: row.get::<_, i64>(12)? == 1,
            captured_at: row.get(13)?,
            chapter_title: row.get(14)?,
            beat_label: row.get(15)?,
            stars: row.get(16)?,
            l1_summary: l1_summary(
                exposure,
                overexposed,
                audio_clipped,
                has_audio,
                focus_scores.as_deref(),
            ),
            has_audio,
            dialogue_summary: dialogue_summary(transcript_text.as_deref()),
            srt_rel_path: row.get(23)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)
}

fn dialogue_summary(text: Option<&str>) -> String {
    text.unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(30)
        .collect()
}

fn l1_summary(
    exposure: Option<f64>,
    overexposed: Option<f64>,
    audio_clipped: Option<bool>,
    has_audio: Option<bool>,
    focus_scores: Option<&str>,
) -> String {
    if exposure.is_none() {
        return "未分析".to_owned();
    }
    let mut labels = Vec::new();
    if exposure.is_some_and(|value| value < super::analysis::DARK_YAVG_THRESHOLD) {
        labels.push("过暗");
    }
    if overexposed.is_some_and(|value| value > super::analysis::OVEREXPOSED_RATIO_THRESHOLD) {
        labels.push("过曝");
    }
    if audio_clipped == Some(true) {
        labels.push("削波");
    }
    if has_audio == Some(false) {
        labels.push("静音");
    }
    let focus_mean = focus_scores
        .and_then(|json| serde_json::from_str::<Vec<f64>>(json).ok())
        .filter(|values| !values.is_empty())
        .map(|values| values.iter().sum::<f64>() / values.len() as f64);
    if focus_mean.is_some_and(|value| value < super::analysis::SOFT_FOCUS_THRESHOLD) {
        labels.push("疑似失焦");
    }
    if labels.is_empty() {
        "无角标".to_owned()
    } else {
        labels.join("；")
    }
}

fn persist_progress(
    connection: &Connection,
    job: &Job,
    payload: &ExportJobPayload,
) -> Result<()> {
    let payload_json = serialize_payload(payload)?;
    let changed = connection.execute(
        "UPDATE jobs SET payload = ?3,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2",
        params![job.id, job.attempt, payload_json],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "export job {} attempt {} is not running",
            job.id, job.attempt
        )));
    }
    Ok(())
}

fn remux_clip(
    ffmpeg: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<()> {
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        OsString::from(&clip.source_path),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-map"),
        OsString::from("0:a:0?"),
        OsString::from("-c"),
        OsString::from("copy"),
    ];
    if clip
        .codec
        .as_deref()
        .is_some_and(|codec| matches!(codec.to_ascii_lowercase().as_str(), "hevc" | "h265"))
    {
        args.extend([OsString::from("-tag:v"), OsString::from("hvc1")]);
    }
    args.extend([
        OsString::from("-fps_mode"),
        OsString::from("passthrough"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-f"),
        OsString::from("mp4"),
        OsString::from("-y"),
        output_path.as_os_str().to_owned(),
    ]);
    run_media_command(ffmpeg, &args, EXPORT_TIMEOUT, cancellation, "精选片段 remux")?;
    validate_nonempty(output_path, "精选片段")
}

fn export_clip(
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<Option<String>> {
    if clip.selection_kind != "select" || clip.segment_id.is_none() {
        return match remux_clip(ffmpeg, clip, output_path, cancellation) {
            Ok(()) => Ok(None),
            Err(error) if cancellation.load(Ordering::SeqCst) => Err(error),
            Err(remux_error) if clip.is_vfr => {
                remove_file_if_exists(output_path)?;
                transcode_whole_vfr(ffmpeg, clip, output_path, cancellation).map(|()| {
                    Some(format!(
                        "VFR 原样封装失败，已转码保留时间轴：{remux_error}"
                    ))
                })
            }
            Err(error) => Err(error),
        };
    }

    transcode_select_segment(ffmpeg, clip, output_path, cancellation)?;
    verify_segment_pts(ffmpeg, ffprobe, clip, output_path, cancellation)
}

fn transcode_whole_vfr(
    ffmpeg: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<()> {
    let args = whole_vfr_args(clip, output_path);
    run_media_command(
        ffmpeg,
        &args,
        EXPORT_TIMEOUT,
        cancellation,
        "VFR 整条 VideoToolbox 转码",
    )?;
    validate_nonempty(output_path, "VFR 精选片段")
    .map_err(|error| {
        CoreError::Export(format!(
            "VFR 整条 VideoToolbox 转码失败（已允许系统软件编码）：{error}"
        ))
    })
}

fn whole_vfr_args(
    clip: &ExportClip,
    output_path: &Path,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        OsString::from(&clip.source_path),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-map"),
        OsString::from("0:a:0?"),
        OsString::from("-c:v"),
        OsString::from("h264_videotoolbox"),
        OsString::from("-allow_sw"),
        OsString::from("1"),
        OsString::from("-b:v"),
        OsString::from("16M"),
    ];
    args.extend([
        OsString::from("-pix_fmt"),
        OsString::from("yuv420p"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("192k"),
        OsString::from("-fps_mode"),
        OsString::from("passthrough"),
        OsString::from("-avoid_negative_ts"),
        OsString::from("make_zero"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-f"),
        OsString::from("mp4"),
        OsString::from("-y"),
        output_path.as_os_str().to_owned(),
    ]);
    args
}

fn transcode_select_segment(
    ffmpeg: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<()> {
    let start = clip_start_seconds(clip)?;
    let duration = clip_duration_seconds(clip);
    if duration <= 0.0 {
        return Err(CoreError::Export(format!(
            "精选段 {} 时长无效",
            clip.segment_id.unwrap_or_default()
        )));
    }
    let args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from(format!("{start:.9}")),
        OsString::from("-accurate_seek"),
        OsString::from("-i"),
        OsString::from(&clip.source_path),
        OsString::from("-t"),
        OsString::from(format!("{duration:.9}")),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-map"),
        OsString::from("0:a:0?"),
        OsString::from("-c:v"),
        OsString::from("h264_videotoolbox"),
        OsString::from("-allow_sw"),
        OsString::from("1"),
        OsString::from("-b:v"),
        OsString::from("16M"),
        OsString::from("-pix_fmt"),
        OsString::from("yuv420p"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("192k"),
        OsString::from("-fps_mode"),
        OsString::from("passthrough"),
        OsString::from("-avoid_negative_ts"),
        OsString::from("make_zero"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-f"),
        OsString::from("mp4"),
        OsString::from("-y"),
        output_path.as_os_str().to_owned(),
    ];
    run_media_command(
        ffmpeg,
        &args,
        EXPORT_TIMEOUT,
        cancellation,
        "精选段帧精确转码",
    )?;
    validate_nonempty(output_path, "精选段")
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PtsBounds {
    first_seconds: f64,
    end_seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BoundaryFingerprint {
    difference_hash: u64,
    mean_luma: u8,
}

const SOURCE_PROBE_ROLLBACK_SECONDS: f64 = 10.0;

fn verify_segment_pts(
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<Option<String>> {
    let requested_in = clip
        .in_ticks
        .ok_or_else(|| CoreError::Export("精选段缺少源入点 tick".to_owned()))?;
    let requested_out = clip
        .out_ticks
        .ok_or_else(|| CoreError::Export("精选段缺少源出点 tick".to_owned()))?;
    let source_bounds = probe_source_tick_bounds(
        ffprobe,
        clip,
        requested_in,
        requested_out,
        cancellation,
    )?;
    validate_source_pts_bounds(
        source_bounds,
        requested_in,
        requested_out,
        clip_frame_ticks(clip),
    )?;

    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-show_entries"),
        OsString::from("packet=pts_time,duration_time"),
        OsString::from("-of"),
        OsString::from("json"),
        output_path.as_os_str().to_owned(),
    ];
    let output = execute_with_cancel(ffprobe, &args, TOOL_TIMEOUT, cancellation)
        .map_err(command_io_error)?;
    if !output.success {
        return Err(command_failure("ffprobe 精选段 PTS 回读", &output));
    }
    let frame_seconds = clip_frame_seconds(clip);
    let bounds = parse_pts_bounds(&output.stdout, frame_seconds)?;
    let mapped_output = map_output_bounds_to_source_ticks(clip, bounds)?;
    validate_source_pts_bounds(
        mapped_output,
        source_bounds.first,
        source_bounds.end,
        clip_frame_ticks(clip),
    )?;
    verify_boundary_content(ffmpeg, clip, output_path, cancellation)?;
    Ok(pts_boundary_warning(
        bounds,
        clip_duration_seconds(clip),
        frame_seconds,
    ))
}

fn probe_source_tick_bounds(
    ffprobe: &OsStr,
    clip: &ExportClip,
    requested_in: i64,
    requested_out: i64,
    cancellation: &AtomicBool,
) -> Result<TickBounds> {
    let start_seconds = clip_start_seconds(clip)?;
    let end_seconds = start_seconds + clip_duration_seconds(clip);
    let probe_start = (start_seconds - SOURCE_PROBE_ROLLBACK_SECONDS).max(0.0);
    let probe_end = end_seconds + clip_frame_seconds(clip) * 2.0;
    let source_args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-read_intervals"),
        // ffprobe seeks intervals to an earlier keyframe. Use an absolute end and
        // filter decoded frame PTS below instead of assuming start%+duration begins
        // exactly at the requested non-keyframe timestamp.
        OsString::from(format!("{probe_start:.9}%{probe_end:.9}")),
        OsString::from("-show_entries"),
        OsString::from("frame=best_effort_timestamp,pkt_duration,duration"),
        OsString::from("-of"),
        OsString::from("json"),
        OsString::from(&clip.source_path),
    ];
    let source_output = execute_with_cancel(ffprobe, &source_args, TOOL_TIMEOUT, cancellation)
        .map_err(command_io_error)?;
    if !source_output.success {
        return Err(command_failure("ffprobe 源片 PTS 边界回读", &source_output));
    }
    parse_tick_bounds(&source_output.stdout, requested_in, requested_out)
}

fn map_output_bounds_to_source_ticks(clip: &ExportClip, bounds: PtsBounds) -> Result<TickBounds> {
    let start = clip
        .in_ticks
        .ok_or_else(|| CoreError::Export("精选段缺少源入点 tick".to_owned()))?;
    let (Some(tb_num), Some(tb_den)) = (clip.tb_num, clip.tb_den) else {
        return Err(CoreError::Export("精选段缺少源 time_base".to_owned()));
    };
    if tb_num <= 0 || tb_den <= 0 {
        return Err(CoreError::Export("精选段源 time_base 无效".to_owned()));
    }
    let to_ticks = |seconds: f64| -> Result<i64> {
        let ticks = seconds * tb_den as f64 / tb_num as f64;
        if !ticks.is_finite() || ticks < i64::MIN as f64 || ticks > i64::MAX as f64 {
            return Err(CoreError::Export("输出 PTS 无法映射回源 tick".to_owned()));
        }
        Ok(ticks.round() as i64)
    };
    Ok(TickBounds {
        first: start.saturating_add(to_ticks(bounds.first_seconds)?),
        end: start.saturating_add(to_ticks(bounds.end_seconds)?),
    })
}

fn parse_tick_bounds(bytes: &[u8], requested_in: i64, requested_out: i64) -> Result<TickBounds> {
    if requested_out <= requested_in {
        return Err(CoreError::Export("源片 PTS 过滤窗口无效".to_owned()));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| CoreError::Export(format!("ffprobe 源片 PTS JSON 无效：{error}")))?;
    let frames = value
        .get("frames")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Export("ffprobe 源片 PTS 输出缺少 frames".to_owned()))?;
    let mut decoded = Vec::new();
    for frame in frames {
        let Some(pts) = json_i64(frame.get("best_effort_timestamp")) else {
            continue;
        };
        let duration = json_i64(frame.get("pkt_duration"))
            .or_else(|| json_i64(frame.get("duration")))
            .filter(|value| *value > 0);
        decoded.push((pts, duration));
    }
    decoded.sort_unstable_by_key(|frame| frame.0);
    decoded.dedup_by_key(|frame| frame.0);

    let first_index = decoded
        .iter()
        .position(|(pts, _)| *pts >= requested_in && *pts < requested_out)
        .ok_or_else(|| {
            CoreError::Export("ffprobe 源片 PTS 输出在请求窗口内没有可用视频帧".to_owned())
        })?;
    let last_index = decoded
        .iter()
        .rposition(|(pts, _)| *pts >= requested_in && *pts < requested_out)
        .expect("first in-window frame guarantees a last frame");
    let end = decoded
        .iter()
        .skip(last_index + 1)
        .find_map(|(pts, _)| (*pts >= requested_out).then_some(*pts))
        .unwrap_or_else(|| {
            let (last_pts, duration) = decoded[last_index];
            let inferred_duration = decoded
                .get(last_index + 1)
                .map(|next| next.0.saturating_sub(last_pts))
                .filter(|value| *value > 0)
                .or(duration)
                .unwrap_or(1);
            last_pts.saturating_add(inferred_duration)
        });
    Ok(TickBounds {
        first: decoded[first_index].0,
        end,
    })
}

fn validate_source_pts_bounds(
    bounds: TickBounds,
    expected_in: i64,
    expected_out: i64,
    tolerance_ticks: i64,
) -> Result<()> {
    let tolerance = tolerance_ticks.max(1);
    let first_delta = bounds.first.abs_diff(expected_in) as i64;
    let end_delta = bounds.end.abs_diff(expected_out) as i64;
    if first_delta > tolerance || end_delta > tolerance {
        return Err(CoreError::Export(format!(
            "源片 PTS 边界与精选段不符（入点差 {first_delta} tick，出点差 {end_delta} tick，容差 {tolerance} tick）"
        )));
    }
    Ok(())
}

fn verify_boundary_content(
    ffmpeg: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<()> {
    let source_start = clip_start_seconds(clip)?;
    let duration = clip_duration_seconds(clip);
    let last_offset = (duration - clip_frame_seconds(clip)).max(0.0);
    for (label, source_at, output_at) in [
        ("首帧", source_start, 0.0),
        ("尾帧", source_start + last_offset, last_offset),
    ] {
        let expected = probe_boundary_fingerprint(
            ffmpeg,
            Path::new(&clip.source_path),
            source_at,
            cancellation,
            &format!("源片{label}"),
        )?;
        let actual = probe_boundary_fingerprint(
            ffmpeg,
            output_path,
            output_at,
            cancellation,
            &format!("输出{label}"),
        )?;
        validate_boundary_fingerprint(expected, actual, label)?;
    }
    Ok(())
}

fn probe_boundary_fingerprint(
    ffmpeg: &OsStr,
    path: &Path,
    at_seconds: f64,
    cancellation: &AtomicBool,
    label: &str,
) -> Result<BoundaryFingerprint> {
    let args = [
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from(format!("{at_seconds:.9}")),
        OsString::from("-accurate_seek"),
        OsString::from("-i"),
        path.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-vf"),
        OsString::from("scale=9:8:flags=area,format=gray"),
        OsString::from("-f"),
        OsString::from("rawvideo"),
        OsString::from("pipe:1"),
    ];
    let output = execute_with_cancel(ffmpeg, &args, TOOL_TIMEOUT, cancellation)
        .map_err(command_io_error)?;
    if !output.success {
        return Err(command_failure(&format!("{label}内容指纹提取"), &output));
    }
    if output.stdout.len() != 9 * 8 {
        return Err(CoreError::Export(format!(
            "{label}内容指纹尺寸无效（期望 72 字节，得到 {}）",
            output.stdout.len()
        )));
    }
    let mut difference_hash = 0_u64;
    for row in 0..8 {
        for column in 0..8 {
            difference_hash <<= 1;
            let left = output.stdout[row * 9 + column];
            let right = output.stdout[row * 9 + column + 1];
            if left > right {
                difference_hash |= 1;
            }
        }
    }
    let mean_luma = (output.stdout.iter().map(|value| u64::from(*value)).sum::<u64>()
        / output.stdout.len() as u64) as u8;
    Ok(BoundaryFingerprint {
        difference_hash,
        mean_luma,
    })
}

fn validate_boundary_fingerprint(
    expected: BoundaryFingerprint,
    actual: BoundaryFingerprint,
    label: &str,
) -> Result<()> {
    let distance = (expected.difference_hash ^ actual.difference_hash).count_ones();
    let luma_delta = expected.mean_luma.abs_diff(actual.mean_luma);
    if distance > 20 || luma_delta > 32 {
        return Err(CoreError::Export(format!(
            "输出{label}内容指纹与预期源 PTS 不一致（结构差异 {distance}/64，亮度差 {luma_delta}）"
        )));
    }
    Ok(())
}

fn clip_frame_ticks(clip: &ExportClip) -> i64 {
    match (clip.tb_num, clip.tb_den, clip.fps_num, clip.fps_den) {
        (Some(tb_num), Some(tb_den), Some(fps_num), Some(fps_den))
            if tb_num > 0 && tb_den > 0 && fps_num > 0 && fps_den > 0 =>
        {
            let numerator = i128::from(tb_den) * i128::from(fps_den);
            let denominator = i128::from(tb_num) * i128::from(fps_num);
            i64::try_from((numerator + denominator - 1) / denominator)
                .unwrap_or(i64::MAX)
                .max(1)
        }
        _ => 1,
    }
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    })
}

fn pts_boundary_warning(
    bounds: PtsBounds,
    expected_duration: f64,
    frame_seconds: f64,
) -> Option<String> {
    let first_delta = bounds.first_seconds.abs();
    let end_delta = (bounds.end_seconds - expected_duration).abs();
    let tolerance = frame_seconds.max(0.000_001);
    if first_delta > tolerance + f64::EPSILON || end_delta > tolerance + f64::EPSILON {
        Some(format!(
            "⚠ 黄标：PTS 边界偏差超过 1 帧（首帧 {first_delta:.6}s，尾帧 {end_delta:.6}s，1 帧 {tolerance:.6}s）"
        ))
    } else {
        None
    }
}

fn parse_pts_bounds(bytes: &[u8], fallback_frame_seconds: f64) -> Result<PtsBounds> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| CoreError::Export(format!("ffprobe PTS JSON 无效：{error}")))?;
    let packets = value
        .get("packets")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Export("ffprobe PTS 输出缺少 packets".to_owned()))?;
    let mut first: Option<f64> = None;
    let mut last_end: Option<f64> = None;
    for packet in packets {
        let Some(pts) = json_f64(packet.get("pts_time")) else {
            continue;
        };
        let duration = json_f64(packet.get("duration_time"))
            .unwrap_or(fallback_frame_seconds)
            .max(0.0);
        first = Some(first.map_or(pts, |current| current.min(pts)));
        let end = pts + duration;
        last_end = Some(last_end.map_or(end, |current| current.max(end)));
    }
    match (first, last_end) {
        (Some(first_seconds), Some(end_seconds)) => Ok(PtsBounds {
            first_seconds,
            end_seconds,
        }),
        _ => Err(CoreError::Export(
            "ffprobe PTS 输出没有可用视频 packet".to_owned(),
        )),
    }
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    })
}

fn clip_start_seconds(clip: &ExportClip) -> Result<f64> {
    let (Some(in_ticks), Some(tb_num), Some(tb_den)) =
        (clip.in_ticks, clip.tb_num, clip.tb_den)
    else {
        return Err(CoreError::Export("精选段缺少源 time_base 入点".to_owned()));
    };
    if in_ticks < 0 || tb_num <= 0 || tb_den <= 0 {
        return Err(CoreError::Export("精选段源 time_base 入点无效".to_owned()));
    }
    Ok(in_ticks as f64 * tb_num as f64 / tb_den as f64)
}

fn clip_frame_seconds(clip: &ExportClip) -> f64 {
    match (clip.fps_num, clip.fps_den) {
        (Some(num), Some(den)) if num > 0 && den > 0 => den as f64 / num as f64,
        _ => match (clip.tb_num, clip.tb_den) {
            (Some(num), Some(den)) if num > 0 && den > 0 => num as f64 / den as f64,
            _ => 1.0 / 30.0,
        },
    }
}

fn transcode_rough_cut(
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    clips: &[SuccessfulClip],
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<()> {
    let audio_presence = clips
        .iter()
        .map(|item| match item.clip.has_audio {
            Some(value) => Ok(value),
            None => probe_has_audio(ffprobe, &item.path, cancellation),
        })
        .collect::<Result<Vec<_>>>()?;
    let args = rough_cut_args(clips, &audio_presence, output_path);
    run_media_command(
        ffmpeg,
        &args,
        EXPORT_TIMEOUT,
        cancellation,
        "参考粗剪 VideoToolbox 转码",
    )
    .map_err(|error| {
        CoreError::Export(format!(
            "参考粗剪 VideoToolbox 转码失败（已允许系统软件编码）：{error}"
        ))
    })?;
    validate_nonempty(output_path, "参考粗剪")
}

fn rough_cut_args(
    clips: &[SuccessfulClip],
    audio_presence: &[bool],
    output_path: &Path,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
    ];
    for clip in clips {
        args.extend([
            OsString::from("-i"),
            clip.path.as_os_str().to_owned(),
        ]);
    }
    let mut silence_inputs = HashMap::new();
    let mut next_input = clips.len();
    for (index, has_audio) in audio_presence.iter().copied().enumerate() {
        if has_audio {
            continue;
        }
        let duration = clip_duration_seconds(&clips[index].clip).max(0.001);
        args.extend([
            OsString::from("-f"),
            OsString::from("lavfi"),
            OsString::from("-t"),
            OsString::from(format!("{duration:.6}")),
            OsString::from("-i"),
            OsString::from("anullsrc=channel_layout=stereo:sample_rate=48000"),
        ]);
        silence_inputs.insert(index, next_input);
        next_input += 1;
    }

    let mut filters = Vec::new();
    let mut concat_inputs = String::new();
    for (index, clip) in clips.iter().enumerate() {
        let duration = clip_duration_seconds(&clip.clip).max(0.001);
        filters.push(format!(
            "[{index}:v:0]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,trim=duration={duration:.6},setpts=PTS-STARTPTS[v{index}]"
        ));
        if audio_presence[index] {
            filters.push(format!(
                "[{index}:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration={duration:.6},asetpts=PTS-STARTPTS[a{index}]"
            ));
        } else {
            let silence_input = silence_inputs[&index];
            filters.push(format!(
                "[{silence_input}:a:0]atrim=duration={duration:.6},asetpts=PTS-STARTPTS[a{index}]"
            ));
        }
        concat_inputs.push_str(&format!("[v{index}][a{index}]"));
    }
    filters.push(format!(
        "{concat_inputs}concat=n={}:v=1:a=1[vout][aout]",
        clips.len()
    ));
    args.extend([
        OsString::from("-filter_complex"),
        OsString::from(filters.join(";")),
        OsString::from("-map"),
        OsString::from("[vout]"),
        OsString::from("-map"),
        OsString::from("[aout]"),
        OsString::from("-c:v"),
        OsString::from("h264_videotoolbox"),
        OsString::from("-allow_sw"),
        OsString::from("1"),
        OsString::from("-b:v"),
        OsString::from("12M"),
        OsString::from("-pix_fmt"),
        OsString::from("yuv420p"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("192k"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-f"),
        OsString::from("mp4"),
        OsString::from("-y"),
        output_path.as_os_str().to_owned(),
    ]);
    args
}

fn probe_has_audio(ffprobe: &OsStr, path: &Path, cancellation: &AtomicBool) -> Result<bool> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("a:0"),
        OsString::from("-show_entries"),
        OsString::from("stream=index"),
        OsString::from("-of"),
        OsString::from("csv=p=0"),
        path.as_os_str().to_owned(),
    ];
    let output = execute_with_cancel(ffprobe, &args, TOOL_TIMEOUT, cancellation)
        .map_err(command_io_error)?;
    if !output.success {
        return Err(command_failure("ffprobe 音轨探测", &output));
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn run_media_command(
    executable: &OsStr,
    args: &[OsString],
    timeout: Duration,
    cancellation: &AtomicBool,
    label: &str,
) -> Result<()> {
    let output = execute_with_cancel(executable, args, timeout, cancellation)
        .map_err(command_io_error)?;
    if !output.success {
        return Err(command_failure(label, &output));
    }
    Ok(())
}

fn execute_with_cancel(
    executable: &OsStr,
    args: &[OsString],
    timeout: Duration,
    cancellation: &AtomicBool,
) -> std::result::Result<CommandOutput, CommandError> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(CommandError::Io)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || read_pipe(stdout));
    let stderr_reader = thread::spawn(move || read_pipe(stderr));
    let started = Instant::now();

    let status = loop {
        if cancellation.load(Ordering::SeqCst) || jobs::current_cancellation_requested() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(CommandError::Cancelled);
        }
        if let Some(status) = child.try_wait().map_err(CommandError::Io)? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(CommandError::Io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("命令超过 {} 秒未完成", timeout.as_secs()),
            )));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| CommandError::Io(std::io::Error::other("stdout reader thread panicked")))?
        .map_err(CommandError::Io)?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| CommandError::Io(std::io::Error::other("stderr reader thread panicked")))?
        .map_err(CommandError::Io)?;
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

fn command_io_error(error: CommandError) -> CoreError {
    match error {
        CommandError::Cancelled => CoreError::Export("用户已取消；半成品已清理".to_owned()),
        CommandError::Io(error) => CoreError::Export(format!(
            "找不到或无法运行媒体工具（可设置 FFMPEG_PATH/FFPROBE_PATH）：{error}"
        )),
    }
}

fn command_failure(label: &str, output: &CommandOutput) -> CoreError {
    CoreError::Export(format!(
        "{label}失败（退出码 {}）：{}",
        output
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_owned()),
        stderr_summary(&output.stderr)
    ))
}

fn stderr_summary(stderr: &[u8]) -> String {
    let summary = String::from_utf8_lossy(stderr)
        .trim()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(1_024)
        .collect::<String>();
    if summary.is_empty() {
        "没有错误输出".to_owned()
    } else {
        summary
    }
}

fn check_cancelled(cancellation: &AtomicBool) -> Result<()> {
    if cancellation.load(Ordering::SeqCst) || jobs::current_cancellation_requested() {
        Err(CoreError::Export("用户已取消；半成品已清理".to_owned()))
    } else {
        Ok(())
    }
}

fn copy_subtitles(
    connection: &Connection,
    clips: &[ExportClip],
    items: &[ExportItemStatus],
    staging_path: &Path,
) -> Result<u64> {
    let Some(db_path) = connection.path() else {
        return Ok(0);
    };
    let cache_root = super::artifacts::cache_root_for_db(Path::new(db_path));
    let subtitle_directory = staging_path.join(SUBTITLE_DIRECTORY);
    let mut copied = 0_u64;

    for (clip, item) in clips.iter().zip(items) {
        if item.status != "done" {
            continue;
        }
        let Some(relative) = clip.srt_rel_path.as_deref() else {
            continue;
        };
        // A whole-clip SRT would carry knowingly wrong timestamps after a cut.
        // Segment subtitle trimming/retiming is outside P3-D1, so omit it.
        if clip.selection_kind == "select" {
            continue;
        }
        let expected = PathBuf::from(clip.clip_id.to_string()).join(super::transcribe::SRT_FILE);
        if Path::new(relative) != expected.as_path() {
            continue;
        }
        let source = cache_root.join(&expected);
        if !source.is_file() {
            continue;
        }
        if copied == 0 {
            std::fs::create_dir(&subtitle_directory)?;
        }
        let output_name = Path::new(&item.output_name)
            .with_extension("srt")
            .file_name()
            .ok_or_else(|| CoreError::Export("无法生成字幕文件名".to_owned()))?
            .to_owned();
        let bytes = std::fs::read(&source)?;
        write_synced(&subtitle_directory.join(output_name), &bytes)?;
        copied += 1;
    }
    Ok(copied)
}

fn build_shot_list_csv(clips: &[ExportClip], items: &[ExportItemStatus]) -> String {
    let mut csv = String::from(
        "\u{feff}顺序号,文件名,包内路径,入点,出点,段时长,分辨率,编码,FPS,VFR,拍摄时间,Chapter,Beat,星级,L1角标摘要,对白摘要,备注\r\n",
    );
    for (index, (clip, item)) in clips.iter().zip(items).enumerate() {
        let resolution = match (clip.width, clip.height) {
            (Some(width), Some(height)) => format!("{width}×{height}"),
            _ => String::new(),
        };
        let fps = match (clip.fps_num, clip.fps_den) {
            (Some(num), Some(den)) if den > 0 => format!("{:.3}", num as f64 / den as f64),
            _ => String::new(),
        };
        let note = item.note.as_deref().unwrap_or(if item.status == "done" {
            "已导出"
        } else {
            "等待处理"
        });
        let start_seconds = clip_start_seconds(clip).unwrap_or(0.0);
        let duration_seconds = clip_duration_seconds(clip);
        let end_seconds = start_seconds + duration_seconds;
        let fields = [
            (index + 1).to_string(),
            clip.file_name.clone(),
            format!("{SELECTED_DIRECTORY}/{}", item.output_name),
            format_clock(start_seconds),
            format_clock(end_seconds),
            format_clock(duration_seconds),
            resolution,
            clip.codec.clone().unwrap_or_default(),
            fps,
            if clip.is_vfr { "是" } else { "否" }.to_owned(),
            clip.captured_at.clone().unwrap_or_default(),
            clip.chapter_title.clone(),
            clip.beat_label.clone(),
            clip.stars.map(|value| value.to_string()).unwrap_or_default(),
            clip.l1_summary.clone(),
            clip.dialogue_summary.clone(),
            note.to_owned(),
        ];
        csv.push_str(&fields.map(|field| csv_escape(&field)).join(","));
        csv.push_str("\r\n");
    }
    csv
}

fn format_clock(seconds: f64) -> String {
    let total_millis = (seconds.max(0.0) * 1_000.0).round() as u64;
    let millis = total_millis % 1_000;
    let total_seconds = total_millis / 1_000;
    let secs = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    let minutes = total_minutes % 60;
    let hours = total_minutes / 60;
    format!("{hours:02}:{minutes:02}:{secs:02}.{millis:03}")
}

fn csv_escape(value: &str) -> String {
    // Spreadsheet applications can execute cells beginning with these sigils as
    // formulas. Prefixing an apostrophe preserves visible text while forcing a
    // literal cell, including when an attacker hides the sigil after whitespace.
    let escaped_formula = if value
        .trim_start_matches([' ', '\t'])
        .starts_with(['=', '+', '-', '@'])
    {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if escaped_formula.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", escaped_formula.replace('"', "\"\""))
    } else {
        escaped_formula
    }
}

fn build_instructions(
    payload: &ExportJobPayload,
    subtitle_count: u64,
    destination_count: u64,
) -> String {
    let subtitle_note = if subtitle_count > 0 {
        format!(
            "4. “{SUBTITLE_DIRECTORY}/”含 {subtitle_count} 条与精选素材同序号的标准 SRT；请在当前剪映版本导入并核对时间轴。\n\
             5. “{SHOT_LIST_FILE}”含包内路径、画面参数、VFR、星级、L1 角标和对白摘要。"
        )
    } else {
        format!(
            "4. 本次没有可用转写，未创建“{SUBTITLE_DIRECTORY}/”；这不会阻塞素材交付。\n\
             5. “{SHOT_LIST_FILE}”含包内路径、画面参数、VFR、星级、L1 角标和对白摘要。"
        )
    };
    let destination_note = if destination_count > 0 {
        format!(
            "\n6. “{DESTINATION_DIRECTORY}/”含 {destination_count} 张地点卡；待核实卡只导出状态占位，不会把模型草稿写入交付说明。"
        )
    } else {
        String::new()
    };
    format!(
        "旅剪工作台 · 稳定交付包\n\n\
         1. 打开剪映专业版，新建草稿。\n\
         2. 将“{SELECTED_DIRECTORY}”拖入素材区；文件名前三位就是推荐顺序。\n\
         3. “{ROUGH_CUT_FILE}”是 1080p H.264/AAC 参考粗剪，可直接预览故事顺序。\n\
         {subtitle_note}{destination_note}\n\n\
         本包不会修改原片。用户打点的精选段按源 time_base 入出点重编码，并回读首尾 PTS；超过 1 帧的偏差会在镜头表中以“⚠ 黄标”注明。没有精选段但用 F 收藏的素材仍按整条 remux。\n\
         参考粗剪统一为 30fps 1080p，使用 macOS VideoToolbox，并允许系统提供的软件编码路径。\n\
         本次精选 {} 条，成功 {} 条，失败 {} 条。失败原因见镜头表“备注”列。\n",
        payload.clips.len(),
        payload.progress.completed_items,
        payload.progress.failed_items
    )
}

fn write_destination_cards(
    connection: &Connection,
    staging_path: &Path,
    episode_id: i64,
) -> Result<u64> {
    if super::settings::string_value(connection, super::settings::LLM_ENABLED_KEY, "false")?
        != "true"
    {
        return Ok(0);
    }
    let Some(overview) = super::narrative::load_overview_for_episode(connection, episode_id)? else {
        return Ok(0);
    };
    if overview.destination_cards.is_empty() {
        return Ok(0);
    }
    let directory = staging_path.join(DESTINATION_DIRECTORY);
    std::fs::create_dir(&directory)?;
    for card in &overview.destination_cards {
        let status = if card.verified { "已核实" } else { "待核实" };
        let body = if card.verified {
            let coverage = card
                .coverage
                .iter()
                .map(|item| {
                    format!(
                        "- [{}] {} — {}{}",
                        if item.covered { "x" } else { " " },
                        item.item,
                        item.evidence,
                        if item.suggestion.is_empty() {
                            String::new()
                        } else {
                            format!("；建议：{}", item.suggestion)
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let sources = card
                .sources
                .iter()
                .map(|source| format!("- {}：{}", source.label, source.basis))
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "# {}\n\n核实状态：{status}\n\n## 地理背景\n{}\n\n## 特点\n{}\n\n## 为什么值得来\n{}\n\n## 个人体验\n{}\n\n## Destination Coverage\n{}\n\n## 依据\n{}\n",
                card.name,
                card.geo_context,
                card.highlights,
                card.why_visit,
                card.personal_note,
                coverage,
                sources,
            )
        } else {
            format!(
                "# {}\n\n核实状态：{status}\n\n未核实的模型草稿未写入交付包。请回到旅剪工作台逐项核实，再重新生成交付包。\n",
                card.name
            )
        };
        let file_name = destination_card_file_name(card.id, &card.name);
        write_synced(&directory.join(file_name), body.as_bytes())?;
    }
    Ok(overview.destination_cards.len() as u64)
}

fn destination_card_file_name(id: i64, name: &str) -> String {
    let safe = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '\0' => '_',
            other => other,
        })
        .take(80)
        .collect::<String>();
    format!("{id:03}_{}.md", if safe.trim().is_empty() { "地点" } else { safe.trim() })
}

fn estimated_required_bytes(selected_bytes: u64) -> u64 {
    selected_bytes.saturating_mul(12).saturating_add(9) / 10
}

fn ensure_capacity(required_bytes: u64, available_bytes: u64) -> Result<()> {
    if available_bytes < required_bytes {
        return Err(CoreError::Export(format!(
            "目标磁盘空间不足：预计需要 {}，当前可用 {}",
            format_bytes(required_bytes),
            format_bytes(available_bytes)
        )));
    }
    Ok(())
}

fn available_space_bytes(path: &Path) -> Result<u64> {
    let output = Command::new("df")
        .args([OsStr::new("-Pk"), path.as_os_str()])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| CoreError::Export(format!("无法检查目标磁盘空间：{error}")))?;
    if !output.status.success() {
        return Err(CoreError::Export(format!(
            "无法检查目标磁盘空间：{}",
            stderr_summary(&output.stderr)
        )));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| CoreError::Export("磁盘空间检查没有返回结果".to_owned()))?;
    let columns = line.split_whitespace().collect::<Vec<_>>();
    let available_kib = columns
        .get(3)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| CoreError::Export("无法解析目标磁盘可用空间".to_owned()))?;
    Ok(available_kib.saturating_mul(1_024))
}

fn format_bytes(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= GIB {
        format!("{:.2} GiB", bytes as f64 / GIB)
    } else {
        format!("{:.1} MiB", bytes as f64 / MIB)
    }
}

fn unique_package_path(destination: &Path, project_name: &str, date: &str) -> PathBuf {
    let base = format!("{project_name}_{PACKAGE_SUFFIX}_{date}");
    let first = destination.join(&base);
    if !first.exists() {
        return first;
    }
    for suffix in 2_u64.. {
        let candidate = destination.join(format!("{base}_{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn staging_path(final_path: &Path, job_id: i64, attempt: i64) -> PathBuf {
    let name = final_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tripcut-export".to_owned());
    final_path.with_file_name(format!(".{name}.tmp-{job_id}-{attempt}"))
}

fn export_file_name(sequence: usize, source_name: &str) -> String {
    let stem = Path::new(source_name)
        .file_stem()
        .map(|value| value.to_string_lossy())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "clip".into());
    let safe_stem = stem
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '_',
            other => other,
        })
        .collect::<String>();
    format!("{sequence:03}_{safe_stem}.mp4")
}

fn validate_nonempty(path: &Path, label: &str) -> Result<()> {
    let file = File::open(path)?;
    file.sync_all()?;
    if file.metadata()?.len() == 0 {
        return Err(CoreError::Export(format!("{label}为空")));
    }
    Ok(())
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn parse_payload(json: &str) -> Result<ExportJobPayload> {
    serde_json::from_str(json)
        .map_err(|error| CoreError::Export(format!("交付任务数据无效：{error}")))
}

fn serialize_payload(payload: &ExportJobPayload) -> Result<String> {
    serde_json::to_string(payload)
        .map_err(|error| CoreError::Export(format!("无法保存交付进度：{error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn insert_clip(
        connection: &Connection,
        path: &Path,
        captured_at: &str,
        binary_values: &[i64],
        stars: Option<i64>,
    ) -> i64 {
        let volume_uuid = if path.is_absolute() { "local" } else { "export-fixture" };
        let (byte_size, quick_hash, full_hash) = if path.is_file() {
            let (quick, bytes) = crate::core::import::quick_fingerprint(path).unwrap();
            let full = crate::core::import::full_fingerprint(path).unwrap();
            (bytes as i64, quick, Some(full))
        } else {
            (1_000, "fixture".to_owned(), None)
        };
        connection
            .execute(
                "INSERT OR IGNORE INTO volumes(uuid) VALUES (?1)",
                [volume_uuid],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, byte_size, quick_hash, full_hash,
                    tb_num, tb_den, duration_ticks, fps_num, fps_den,
                    codec, width, height, captured_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5,
                    1, 1000, 2000, 25, 1,
                    'h264', 1280, 720, ?6
                 )",
                params![
                    volume_uuid,
                    path.to_string_lossy(),
                    byte_size,
                    quick_hash,
                    full_hash,
                    captured_at
                ],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        crate::core::episode::assign_clip_to_current(connection, clip_id).unwrap();
        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind)
                 VALUES (?1, 0, 2000, 'whole')",
                [clip_id],
            )
            .unwrap();
        let segment_id = connection.last_insert_rowid();
        for (index, value) in binary_values.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                     VALUES (?1, 'binary', ?2, ?3)",
                    params![segment_id, value, format!("2026-08-31T00:00:{index:02}Z")],
                )
                .unwrap();
        }
        if let Some(stars) = stars {
            connection
                .execute(
                    "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                     VALUES (?1, 'star', ?2, '2026-08-31T00:01:00Z')",
                    params![segment_id, stars],
                )
                .unwrap();
        }
        clip_id
    }

    fn export_clip_fixture(
        name: &str,
        in_ticks: i64,
        out_ticks: i64,
        tb_num: i64,
        tb_den: i64,
    ) -> ExportClip {
        ExportClip {
            clip_id: 1,
            segment_id: Some(1),
            selection_kind: "select".to_owned(),
            in_ticks: Some(in_ticks),
            out_ticks: Some(out_ticks),
            tb_num: Some(tb_num),
            tb_den: Some(tb_den),
            volume_uuid: "local".to_owned(),
            rel_path: name.to_owned(),
            quick_hash: "quick".to_owned(),
            full_hash: Some("full".to_owned()),
            source_path: name.to_owned(),
            file_name: name.to_owned(),
            byte_size: 100,
            source_byte_size: 1_000,
            width: Some(1920),
            height: Some(1080),
            codec: Some("h264".to_owned()),
            fps_num: Some(25),
            fps_den: Some(1),
            is_vfr: false,
            captured_at: None,
            chapter_title: String::new(),
            beat_label: String::new(),
            stars: None,
            l1_summary: "未分析".to_owned(),
            has_audio: Some(true),
            dialogue_summary: String::new(),
            srt_rel_path: None,
        }
    }

    fn export_payload_fixture(clips: Vec<ExportClip>) -> ExportJobPayload {
        ExportJobPayload {
            version: 4,
            episode_id: Some(1),
            episode_memory_id: Some("test-episode".to_owned()),
            destination: "/tmp".to_owned(),
            project_name: PROJECT_NAME.to_owned(),
            date: "2026-09-01".to_owned(),
            selected_bytes: clips.iter().map(|clip| clip.byte_size).sum(),
            progress: ExportProgress {
                stage: "queued".to_owned(),
                completed_items: 0,
                failed_items: 0,
                cancel_requested: false,
                message: None,
                items: Vec::new(),
            },
            clips,
            output_path: None,
        }
    }

    fn insert_select_segment(
        connection: &Connection,
        clip_id: i64,
        in_ticks: i64,
        out_ticks: i64,
        tombstone: i64,
    ) -> i64 {
        connection
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, tombstone)
                 VALUES (?1, ?2, ?3, 'select', ?4)",
                params![clip_id, in_ticks, out_ticks, tombstone],
            )
            .unwrap();
        let segment_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                 VALUES (?1, 'binary', 1, '2026-08-31T00:02:00Z')",
                [segment_id],
            )
            .unwrap();
        segment_id
    }

    fn ffmpeg_tools() -> Option<(OsString, OsString)> {
        let connection = Connection::open_in_memory().unwrap();
        let ffmpeg = crate::core::settings::configured_executable(
            &connection,
            crate::core::settings::FFMPEG_PATH_KEY,
            "FFMPEG_PATH",
            "ffmpeg",
        )
        .unwrap();
        let ffprobe = crate::core::settings::configured_ffprobe(&connection, &ffmpeg).unwrap();
        for tool in [&ffmpeg, &ffprobe] {
            let available = Command::new(tool)
                .arg("-version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if !available {
                eprintln!(
                    "skipping export ffmpeg fixture: {} unavailable",
                    Path::new(tool).display()
                );
                return None;
            }
        }
        Some((ffmpeg, ffprobe))
    }

    fn generate_fixture(ffmpeg: &OsStr, path: &Path) -> bool {
        Command::new(ffmpeg)
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x180:r=25:d=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1",
                "-shortest",
                "-c:v",
                "mpeg4",
                "-q:v",
                "3",
                "-c:a",
                "aac",
            ])
            .arg(path)
            .status()
            .is_ok_and(|status| status.success())
    }

    fn generate_long_gop_fixture(ffmpeg: &OsStr, path: &Path) -> bool {
        Command::new(ffmpeg)
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x180:r=25:d=8",
                "-an",
                "-c:v",
                "libx264",
                "-g",
                "250",
                "-keyint_min",
                "250",
                "-sc_threshold",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-video_track_timescale",
                "1000",
            ])
            .arg(path)
            .status()
            .is_ok_and(|status| status.success())
    }

    #[test]
    fn selection_uses_latest_binary_rating_and_capture_order() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let later = insert_clip(
            &connection,
            Path::new("later.mov"),
            "2026-08-31T12:00:00Z",
            &[1],
            Some(4),
        );
        let earlier = insert_clip(
            &connection,
            Path::new("earlier.mov"),
            "2026-08-31T10:00:00Z",
            &[1],
            Some(5),
        );
        insert_clip(
            &connection,
            Path::new("rejected.mov"),
            "2026-08-31T09:00:00Z",
            &[1, -1],
            None,
        );

        let clips = selected_clips(&connection).unwrap();
        assert_eq!(
            clips.iter().map(|clip| clip.clip_id).collect::<Vec<_>>(),
            vec![earlier, later]
        );
        assert_eq!(clips[0].stars, Some(5));
        assert_eq!(clips[1].stars, Some(4));
    }

    #[test]
    fn selected_clips_excludes_archived_episode_selections() {
        // 回归说明：交付只应带出 active 集的精选/收藏,不能把已封存
        // 历史集仍保留的评级/精选段一并混入(src-tauri/src/core/deliver.rs 的
        // selected_clips 曾完全没有 episode_id 过滤)。
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let ep1_clip = insert_clip(
            &connection,
            Path::new("ep1.mov"),
            "2026-08-31T10:00:00Z",
            &[1],
            Some(5),
        );
        crate::core::episode::assign_clip_to_current(&connection, ep1_clip).unwrap();

        crate::core::episode::archive_current(&mut connection, Some("EP02")).unwrap();

        let ep2_clip = insert_clip(
            &connection,
            Path::new("ep2.mov"),
            "2026-09-01T10:00:00Z",
            &[1],
            Some(4),
        );
        crate::core::episode::assign_clip_to_current(&connection, ep2_clip).unwrap();

        let clips = selected_clips(&connection).unwrap();
        let clip_ids = clips.iter().map(|clip| clip.clip_id).collect::<Vec<_>>();
        assert_eq!(
            clip_ids,
            vec![ep2_clip],
            "已封存集(EP01)的收藏素材不能出现在新集(EP02)的交付选集里"
        );
    }

    #[test]
    fn active_story_order_precedes_capture_time_for_delivery() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let earlier = insert_clip(
            &connection,
            Path::new("earlier.mov"),
            "2026-08-31T10:00:00Z",
            &[1],
            None,
        );
        let later = insert_clip(
            &connection,
            Path::new("later.mov"),
            "2026-08-31T12:00:00Z",
            &[1],
            None,
        );
        for (position, clip_id) in [later, earlier].into_iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO story_order(
                        item_kind, clip_id, position, tombstone, created_at, updated_at
                     ) VALUES (
                        'whole', ?1, ?2, 0,
                        '2026-08-31T13:00:00Z', '2026-08-31T13:00:00Z'
                     )",
                    params![clip_id, position as i64],
                )
                .unwrap();
        }

        let clips = selected_clips(&connection).unwrap();
        assert_eq!(
            clips.iter().map(|clip| clip.clip_id).collect::<Vec<_>>(),
            vec![later, earlier]
        );
    }

    #[test]
    fn l3_enabled_delivery_uses_beat_order_without_rewriting_d2_order() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        crate::core::settings::set_setting(
            &connection,
            crate::core::settings::LLM_ENABLED_KEY,
            "true",
        ).unwrap();
        let earlier = insert_clip(
            &connection,
            Path::new("earlier.mov"),
            "2026-08-31T10:00:00Z",
            &[1],
            None,
        );
        let later = insert_clip(
            &connection,
            Path::new("later.mov"),
            "2026-08-31T12:00:00Z",
            &[1],
            None,
        );
        connection.execute(
            "INSERT INTO episodes(title, theme, created_at) VALUES ('旅程', '主题', 'now')",
            [],
        ).unwrap();
        // 迁移 0020 预置了 EP01,自增 id 不再从 1 起,必须取真实 id。
        let episode_id = connection.last_insert_rowid();
        // G2:读取权威按 active 集的修订;夹具把修订挂在 active 集上。
        let active: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        connection.execute(
            "INSERT INTO narrative_revisions(episode_id, kind, title, theme, created_at)
             VALUES (?1, 'suggested', '旅程', '主题', 'now')",
            [active],
        ).unwrap();
        let revision_id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO narrative_chapters(
                episode_id, revision_id, kind, title, \"order\", promoted, score, rationale,
                promotion_reason, story_slots_json, missing_slots_json, dh_plan_json
             ) VALUES (?1, ?2, 'journey', '在途旅程', 0, 0, 0.8, '推进', '', '[]', '[]', 'null')",
            params![episode_id, revision_id],
        ).unwrap();
        let chapter_id = connection.last_insert_rowid();
        for (position, clip_id) in [later, earlier].into_iter().enumerate() {
            connection.execute(
                "INSERT INTO narrative_beats(
                    chapter_id, clip_id, role, \"order\", score, rationale
                 ) VALUES (?3, ?1, 'beat', ?2, 0.8, '顺序依据')",
                params![clip_id, position as i64, chapter_id],
            ).unwrap();
        }

        let clips = selected_clips(&connection).unwrap();
        assert_eq!(clips.iter().map(|clip| clip.clip_id).collect::<Vec<_>>(), vec![later, earlier]);
        assert_eq!(clips[0].chapter_title, "在途旅程");
        assert_eq!(clips[0].beat_label, "01 · beat");
    }

    #[test]
    fn selection_mixes_whole_fallback_with_each_live_select_segment() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let whole = insert_clip(
            &connection,
            Path::new("whole.mov"),
            "2026-08-31T10:00:00Z",
            &[1],
            None,
        );
        let segmented = insert_clip(
            &connection,
            Path::new("segmented.mov"),
            "2026-08-31T11:00:00Z",
            &[1],
            None,
        );
        insert_select_segment(&connection, segmented, 250, 750, 0);
        insert_select_segment(&connection, segmented, 1_000, 1_500, 0);

        let clips = selected_clips(&connection).unwrap();
        assert_eq!(clips.len(), 3);
        assert_eq!(clips[0].clip_id, whole);
        assert_eq!(clips[0].selection_kind, "whole");
        assert_eq!(clips[1].clip_id, segmented);
        assert_eq!((clips[1].in_ticks, clips[1].out_ticks), (Some(250), Some(750)));
        assert_eq!((clips[2].in_ticks, clips[2].out_ticks), (Some(1_000), Some(1_500)));
        assert_eq!(clip_duration_seconds(&clips[1]), 0.5);
    }

    #[test]
    fn tombstoned_select_segment_is_absent_from_delivery() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let clip_id = insert_clip(
            &connection,
            Path::new("segmented.mov"),
            "2026-08-31T11:00:00Z",
            &[1],
            None,
        );
        insert_select_segment(&connection, clip_id, 100, 300, 0);
        insert_select_segment(&connection, clip_id, 500, 900, 1);

        let clips = selected_clips(&connection).unwrap();
        assert_eq!(clips.len(), 1);
        assert_eq!((clips[0].in_ticks, clips[0].out_ticks), (Some(100), Some(300)));
    }

    #[test]
    fn idle_status_reports_selected_count_and_total_duration() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(
            &connection,
            Path::new("one.mov"),
            "2026-08-31T10:00:00Z",
            &[1],
            None,
        );
        insert_clip(
            &connection,
            Path::new("two.mov"),
            "2026-08-31T11:00:00Z",
            &[1],
            None,
        );

        let status = get_export_status(&connection, None).unwrap();
        assert_eq!(status.status, "idle");
        assert_eq!(status.selected_count, 2);
        assert_eq!(status.selected_segment_count, 0);
        assert_eq!(status.selected_whole_count, 2);
        assert_eq!(status.total_duration_seconds, 4.0);
    }

    #[test]
    fn disk_preflight_uses_one_point_two_times_selected_bytes() {
        assert_eq!(estimated_required_bytes(1_000), 1_200);
        let error = ensure_capacity(1_200, 1_199).unwrap_err();
        assert!(error.to_string().contains("空间不足"));
        ensure_capacity(1_200, 1_200).unwrap();
    }

    #[test]
    fn conflicting_package_directory_gets_incrementing_suffix() {
        let directory = TestDirectory::new();
        let first = directory.path().join("旅剪项目_剪映交付_2026-08-31");
        let second = directory.path().join("旅剪项目_剪映交付_2026-08-31_2");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();

        assert_eq!(
            unique_package_path(directory.path(), "旅剪项目", "2026-08-31"),
            directory.path().join("旅剪项目_剪映交付_2026-08-31_3")
        );
    }

    #[test]
    fn csv_has_utf8_bom_and_escapes_commas_and_quotes() {
        let mut clip = export_clip_fixture("A,\"B\".mov", 0, 1_250, 1, 1_000);
        clip.segment_id = None;
        clip.selection_kind = "whole".to_owned();
        clip.source_path = "/素材/A,\"B\".mov".to_owned();
        clip.codec = Some("hevc".to_owned());
        clip.fps_num = Some(30_000);
        clip.fps_den = Some(1_001);
        clip.is_vfr = true;
        clip.chapter_title = "清晨出发".to_owned();
        clip.beat_label = "01 · beat".to_owned();
        clip.stars = Some(5);
        clip.l1_summary = "无角标".to_owned();
        clip.dialogue_summary = "今天去西安城墙".to_owned();
        let item = ExportItemStatus {
            clip_id: 1,
            file_name: clip.file_name.clone(),
            output_name: "001_A.mp4".to_owned(),
            status: "failed".to_owned(),
            note: Some("bad, \"packet\"".to_owned()),
            warning: false,
        };

        let csv = build_shot_list_csv(&[clip], &[item]);
        assert!(csv.as_bytes().starts_with(&[0xef, 0xbb, 0xbf]));
        assert!(csv.contains("\"A,\"\"B\"\".mov\""));
        assert!(csv.contains("\"bad, \"\"packet\"\"\""));
        assert!(csv.contains(",是,"));
        assert!(csv.contains("L1角标摘要,对白摘要,备注"));
        assert!(csv.contains("包内路径,入点,出点,段时长"));
        assert!(csv.contains("01_精选片段/001_A.mp4"));
        assert!(!csv.contains("/素材/"));
        assert!(csv.contains("拍摄时间,Chapter,Beat,星级"));
        assert!(csv.contains("清晨出发"));
        assert!(csv.contains("01 · beat"));
        assert!(csv.contains("00:00:01.250"));
        assert!(csv.contains("今天去西安城墙"));
    }

    #[test]
    fn csv_neutralizes_spreadsheet_formulas() {
        for value in ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "  =HYPERLINK(\"x\")"] {
            let escaped = csv_escape(value);
            assert!(escaped.contains('\''), "formula was not neutralized: {value}");
        }
        assert_eq!(csv_escape("ordinary text"), "ordinary text");
    }

    #[test]
    fn unverified_destination_card_exports_only_a_pending_placeholder() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        super::super::settings::set_setting(
            &connection,
            super::super::settings::LLM_ENABLED_KEY,
            "true",
        )
        .unwrap();
        connection.execute(
            "INSERT INTO episodes(title, theme, created_at)
             VALUES ('旅程', '测试', '2026-09-01T00:00:00Z')",
            [],
        ).unwrap();
        let episode_id = connection.last_insert_rowid();
        let active: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        connection.execute(
            "INSERT INTO narrative_revisions(episode_id, kind, title, theme, created_at)
             VALUES (?1, 'suggested', '旅程', '测试', 'now')",
            [active],
        ).unwrap();
        let revision_id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO narrative_chapters(
                episode_id, revision_id, kind, title, \"order\", promoted, score, rationale,
                promotion_reason, story_slots_json, missing_slots_json, dh_plan_json
             ) VALUES (?1, ?2, 'destination', '地点', 0, 0, 0.8, '依据', '', '[]', '[]', 'null')",
            params![active, revision_id],
        ).unwrap();
        let _ = episode_id;
        let chapter_id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO destination_cards(
                chapter_id, name, geo_context, highlights, why_visit, personal_note,
                sources_json, verified, coverage_json, created_at, updated_at
             ) VALUES (
                ?1, '秘密地点', '未核实地理草稿', '特点', '原因', '体验',
                '[]', 0, '[]', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
             )",
            [chapter_id],
        ).unwrap();
        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();

        assert_eq!(
            write_destination_cards(&connection, &staging, active).unwrap(),
            1
        );
        let output = std::fs::read_to_string(
            staging.join(DESTINATION_DIRECTORY).join("001_秘密地点.md"),
        ).unwrap();
        assert!(output.contains("核实状态：待核实"));
        assert!(!output.contains("未核实地理草稿"));
    }

    #[test]
    fn mock_ffprobe_packets_are_reduced_to_pts_boundaries() {
        let json = br#"{
            "packets": [
                {"pts_time":"0.040000", "duration_time":"0.040000"},
                {"pts_time":"0.000000", "duration_time":"0.040000"},
                {"pts_time":"0.960000", "duration_time":"0.040000"}
            ]
        }"#;

        let bounds = parse_pts_bounds(json, 0.04).unwrap();
        assert_eq!(bounds, PtsBounds { first_seconds: 0.0, end_seconds: 1.0 });
        assert!(pts_boundary_warning(bounds, 1.0, 0.04).is_none());
    }

    #[test]
    fn h264_long_gop_non_keyframe_in_point_is_filtered_from_preroll_pts() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("long-gop.mp4");
        if !generate_long_gop_fixture(&ffmpeg, &source) {
            eprintln!("skipping long-GOP boundary fixture: libx264 unavailable");
            return;
        }
        // best_effort_timestamp 以真实流 time_base 为单位;夹具 tb 必须取自实际探测,
        // 否则单位错配(此前硬写 1/1000 撞上 libx264 的 1/12800)。
        let meta = crate::core::import::probe_media(&source).unwrap();
        let per_sec = meta.tb_den / meta.tb_num;
        let (win_in, win_out) = (3 * per_sec, 5 * per_sec);
        let mut clip = export_clip_fixture("long-gop.mp4", win_in, win_out, meta.tb_num, meta.tb_den);
        clip.source_path = source.to_string_lossy().into_owned();

        let bounds = probe_source_tick_bounds(
            &ffprobe,
            &clip,
            win_in,
            win_out,
            &AtomicBool::new(false),
        )
        .unwrap();

        // 入点吸附到窗口内首帧(容差一帧),出点=末帧+时长应达窗口右缘(容差一帧)
        let frame_ticks = per_sec / 25;
        assert!(bounds.first.abs_diff(win_in) as i64 <= frame_ticks, "first={} win_in={win_in}", bounds.first);
        assert!(bounds.end.abs_diff(win_out) as i64 <= frame_ticks, "end={} win_out={win_out}", bounds.end);
    }

    #[test]
    fn vfr_boundary_filter_uses_irregular_best_effort_timestamps() {
        let json = br#"{
            "frames": [
                {"best_effort_timestamp":"0", "pkt_duration":"400"},
                {"best_effort_timestamp":"800", "pkt_duration":"200"},
                {"best_effort_timestamp":"1000", "pkt_duration":"40"},
                {"best_effort_timestamp":"1040", "pkt_duration":"60"},
                {"best_effort_timestamp":"1100", "pkt_duration":"80"},
                {"best_effort_timestamp":"1180", "pkt_duration":"80"},
                {"best_effort_timestamp":"1260", "pkt_duration":"90"},
                {"best_effort_timestamp":"1350", "pkt_duration":"100"},
                {"best_effort_timestamp":"1450", "pkt_duration":"120"},
                {"best_effort_timestamp":"1570", "pkt_duration":"130"},
                {"best_effort_timestamp":"1700", "pkt_duration":"150"}
            ]
        }"#;

        let bounds = parse_tick_bounds(json, 1_000, 1_700).unwrap();

        assert_eq!(bounds, TickBounds { first: 1_000, end: 1_700 });
    }

    #[test]
    fn pts_difference_over_one_frame_becomes_yellow_warning() {
        let warning = pts_boundary_warning(
            PtsBounds {
                first_seconds: 0.0,
                end_seconds: 1.081,
            },
            1.0,
            0.04,
        )
        .unwrap();

        assert!(warning.contains("黄标"));
        assert!(warning.contains("超过 1 帧"));
    }

    #[test]
    fn exported_file_names_are_ordered_sanitized_and_mp4() {
        assert_eq!(export_file_name(7, "A:B/C.MOV"), "007_C.mp4");
        assert_eq!(export_file_name(12, "航拍.mov"), "012_航拍.mp4");
    }

    #[test]
    fn remux_success_creates_nonempty_mp4_when_ffmpeg_is_available() {
        let Some((ffmpeg, _)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        if !generate_fixture(&ffmpeg, &source) {
            eprintln!("skipping export remux fixture: encoder unavailable");
            return;
        }
        let output = directory.path().join("remux.tmp");
        let mut clip = export_clip_fixture("source.mp4", 0, 1_000, 1, 1_000);
        clip.segment_id = None;
        clip.selection_kind = "whole".to_owned();
        clip.source_path = source.to_string_lossy().into_owned();
        clip.byte_size = std::fs::metadata(&source).unwrap().len();
        clip.source_byte_size = clip.byte_size;
        clip.width = Some(320);
        clip.height = Some(180);
        clip.codec = Some("mpeg4".to_owned());
        remux_clip(&ffmpeg, &clip, &output, &AtomicBool::new(false)).unwrap();
        assert!(std::fs::metadata(output).unwrap().len() > 0);
    }

    #[cfg(unix)]
    #[test]
    fn whole_vfr_reports_the_real_bundled_encoder_when_videotoolbox_fails() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let fake_ffmpeg = directory.path().join("fake-ffmpeg");
        std::fs::write(
            &fake_ffmpeg,
            r#"#!/bin/sh
case " $* " in
  *" -c copy "*) exit 9 ;;
  *" h264_videotoolbox "*) exit 8 ;;
  *) exit 7 ;;
esac
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake_ffmpeg).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_ffmpeg, permissions).unwrap();
        let output = directory.path().join("vfr-output.tmp");
        let mut clip = export_clip_fixture("vfr.mp4", 0, 3_003, 1, 1_000);
        clip.segment_id = None;
        clip.selection_kind = "whole".to_owned();
        clip.is_vfr = true;

        let error = export_clip(
            fake_ffmpeg.as_os_str(),
            OsStr::new("unused-ffprobe"),
            &clip,
            &output,
            &AtomicBool::new(false),
        )
        .unwrap_err();

        assert!(error.to_string().contains("VideoToolbox"));
        assert!(!error.to_string().contains("libx264"));
        assert!(!output.exists());
    }

    #[test]
    fn delivery_transcodes_match_the_bundled_videotoolbox_quality_contract() {
        let clip = export_clip_fixture("source.mov", 0, 3_000, 1, 1_000);
        let whole = whole_vfr_args(&clip, Path::new("whole.mp4"));
        let successful = [SuccessfulClip {
            clip,
            path: PathBuf::from("selected.mp4"),
        }];
        let rough = rough_cut_args(&successful, &[true], Path::new("rough.mp4"));
        let whole = whole
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        let rough = rough
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(whole.contains("h264_videotoolbox -allow_sw 1 -b:v 16M"));
        assert!(rough.contains("h264_videotoolbox -allow_sw 1 -b:v 12M"));
        assert!(!whole.contains("libx264"));
        assert!(!rough.contains("libx264"));
    }

    #[test]
    fn srt_is_copied_to_delivery_package_with_ordered_clip_name() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let connection = Connection::open(&db_path).unwrap();
        let cache_source = directory.path().join("cache/1/transcript.srt");
        std::fs::create_dir_all(cache_source.parent().unwrap()).unwrap();
        std::fs::write(
            &cache_source,
            "1\n00:00:00,000 --> 00:00:01,000\n大家好\n",
        )
        .unwrap();
        let staging = directory.path().join("package.tmp");
        std::fs::create_dir(&staging).unwrap();
        let mut clip = export_clip_fixture("voice.mov", 0, 1_000, 1, 1_000);
        clip.segment_id = None;
        clip.selection_kind = "whole".to_owned();
        clip.l1_summary = "无角标".to_owned();
        clip.dialogue_summary = "大家好".to_owned();
        clip.srt_rel_path = Some("1/transcript.srt".to_owned());
        let clips = vec![clip];
        let items = vec![ExportItemStatus {
            clip_id: 1,
            file_name: "voice.mov".to_owned(),
            output_name: "001_voice.mp4".to_owned(),
            status: "done".to_owned(),
            note: None,
            warning: false,
        }];

        assert_eq!(copy_subtitles(&connection, &clips, &items, &staging).unwrap(), 1);
        let output = staging.join("03_字幕/001_voice.srt");
        assert!(output.is_file());
        assert!(std::fs::read_to_string(output).unwrap().contains("大家好"));
    }

    #[test]
    fn corrupt_source_is_red_but_does_not_interrupt_complete_package() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("good.mp4");
        let corrupt = directory.path().join("bad.mp4");
        if !generate_fixture(&ffmpeg, &source) {
            eprintln!("skipping complete export fixture: encoder unavailable");
            return;
        }
        std::fs::write(&corrupt, b"not media").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(
            &connection,
            &source,
            "2026-08-31T10:00:00Z",
            &[1],
            None,
        );
        insert_clip(
            &connection,
            &corrupt,
            "2026-08-31T11:00:00Z",
            &[1],
            None,
        );
        let status = start_export(&mut connection, directory.path()).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();

        let finished = get_export_status(&connection, status.job_id).unwrap();
        assert_eq!(finished.status, "done");
        assert_eq!(finished.completed_items, 1);
        assert_eq!(finished.failed_items, 1);
        let output = PathBuf::from(finished.output_path.unwrap());
        assert!(output.join(ROUGH_CUT_FILE).is_file());
        let csv = std::fs::read_to_string(output.join(SHOT_LIST_FILE)).unwrap();
        assert!(csv.contains("精选片段 remux失败"));
        let outbox_status: String = connection
            .query_row(
                "SELECT status FROM channel_memory_outbox",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(outbox_status, "done");
    }

    #[test]
    fn all_corrupt_sources_leave_no_final_or_staging_directory() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let corrupt = directory.path().join("bad.mp4");
        std::fs::write(&corrupt, b"not media").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(
            &connection,
            &corrupt,
            "2026-08-31T11:00:00Z",
            &[1],
            None,
        );
        start_export(&mut connection, directory.path()).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        let error = run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe)
            .unwrap_err();
        assert!(error.to_string().contains("所有精选片段"));
        let unexpected = std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .any(|name| name.contains("剪映交付") || name.contains(".tmp-"));
        assert!(!unexpected);
        let outbox_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM channel_memory_outbox", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outbox_count, 0);
    }

    #[test]
    fn pending_cancel_marks_job_failed_without_running_it() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"placeholder").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(
            &connection,
            &source,
            "2026-08-31T11:00:00Z",
            &[1],
            None,
        );
        let started = start_export(&mut connection, directory.path()).unwrap();
        let job_id = started.job_id.unwrap();
        cancel_export(&mut connection, job_id).unwrap();

        let status = get_export_status(&connection, Some(job_id)).unwrap();
        assert_eq!(status.status, "failed");
        assert_eq!(status.stage, "cancelling");
        assert_eq!(status.error.as_deref(), Some("用户已取消"));
        let outbox_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM channel_memory_outbox", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outbox_count, 0);
    }

    #[test]
    fn persisted_export_payload_contains_ticks_but_no_floating_seconds() {
        let clip = export_clip_fixture("source.mov", 250, 750, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);

        let json = serialize_payload(&payload).unwrap();

        assert!(json.contains("\"in_ticks\":250"));
        assert!(json.contains("\"out_ticks\":750"));
        assert!(!json.contains("duration_seconds"));
        assert!(!json.contains("total_duration_seconds"));
    }

    #[test]
    fn source_pts_boundary_must_match_requested_ticks_not_zero_based_output() {
        let error = validate_source_pts_bounds(
            TickBounds { first: 249, end: 751 },
            1_000,
            2_000,
            1,
        )
        .unwrap_err();

        assert!(error.to_string().contains("源片 PTS 边界"));
    }

    #[test]
    fn output_pts_are_mapped_back_to_source_ticks_before_boundary_acceptance() {
        let clip = export_clip_fixture("source.mov", 1_000, 2_000, 1, 1_000);
        let mapped = map_output_bounds_to_source_ticks(
            &clip,
            PtsBounds {
                first_seconds: 0.0,
                end_seconds: 0.5,
            },
        )
        .unwrap();

        let error = validate_source_pts_bounds(mapped, 1_000, 2_000, 40).unwrap_err();
        assert!(error.to_string().contains("源片 PTS 边界"));
    }

    #[test]
    fn boundary_content_fingerprint_rejects_a_different_source_frame() {
        let expected = BoundaryFingerprint {
            difference_hash: 0b1010,
            mean_luma: 24,
        };
        let wrong_frame = BoundaryFingerprint {
            difference_hash: u64::MAX ^ expected.difference_hash,
            mean_luma: 220,
        };

        let error = validate_boundary_fingerprint(expected, wrong_frame, "首帧").unwrap_err();

        assert!(error.to_string().contains("首帧内容指纹"));
    }

    #[test]
    fn matching_completion_marker_is_adopted_after_crash() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let final_path = directory.path().join("finished-package");
        std::fs::create_dir(&final_path).unwrap();
        let clip_id = insert_clip(
            &connection,
            Path::new("offline-after-crash.mov"),
            "2026-09-01T10:00:00Z",
            &[1],
            None,
        );
        let mut clip = export_clip_fixture("offline-after-crash.mov", 0, 1_000, 1, 1_000);
        clip.clip_id = clip_id;
        let mut payload = export_payload_fixture(vec![clip]);
        let (episode_id, memory_id): (i64, String) = connection
            .query_row(
                "SELECT id, memory_id FROM episodes WHERE status = 'active'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        payload.episode_id = Some(episode_id);
        payload.episode_memory_id = Some(memory_id);
        payload.output_path = Some(final_path.to_string_lossy().into_owned());
        let payload_hash = canonical_payload_hash(&payload).unwrap();
        let job_id = jobs::enqueue(
            &mut connection,
            "export_package",
            &serialize_payload(&payload).unwrap(),
            &payload_hash,
        )
        .unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        write_completion_marker(&final_path, job_id, job.attempt, &payload_hash).unwrap();

        run_export_package_with(
            &mut connection,
            &job,
            OsStr::new("tool-must-not-run"),
            OsStr::new("tool-must-not-run"),
        )
        .unwrap();

        let status = get_export_status(&connection, Some(job_id)).unwrap();
        assert_eq!(status.status, "done");
        let expected_path = final_path.to_string_lossy().into_owned();
        assert_eq!(status.output_path.as_deref(), Some(expected_path.as_str()));
    }

    #[test]
    fn canonical_hash_uses_full_payload_and_active_enqueue_is_idempotent() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let first_payload = export_payload_fixture(vec![export_clip_fixture(
            "same-size.mov",
            0,
            500,
            1,
            1_000,
        )]);
        let second_payload = export_payload_fixture(vec![export_clip_fixture(
            "same-size.mov",
            0,
            750,
            1,
            1_000,
        )]);
        let first_hash = canonical_payload_hash(&first_payload).unwrap();
        let second_hash = canonical_payload_hash(&second_payload).unwrap();
        assert_ne!(first_hash, second_hash, "同长度 JSON 的不同 tick 不得碰撞");
        let json = serialize_payload(&first_payload).unwrap();

        let first = jobs::enqueue_idempotent(
            &mut connection,
            "export_package",
            &json,
            &first_hash,
        )
        .unwrap();
        let duplicate = jobs::enqueue_idempotent(
            &mut connection,
            "export_package",
            &json,
            &first_hash,
        )
        .unwrap();

        assert_eq!(first, duplicate);
    }
}
