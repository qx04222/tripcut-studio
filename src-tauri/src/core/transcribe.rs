use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::{self, Job};

pub const DEFAULT_MODEL_TIER: &str = "large-v3-turbo";
// S5: small 约 29x 实时、峰值约 1GB，作为 8/16GB 老款机器的低配档；质量低于默认档。
pub const LOW_POWER_MODEL_TIER: &str = "small";
pub const DEFAULT_MODEL_FILE: &str = "ggml-large-v3-turbo.bin";
pub const LOW_POWER_MODEL_FILE: &str = "ggml-small.bin";
pub const TRANSCRIPT_FILE: &str = "transcript.json";
pub const SRT_FILE: &str = "transcript.srt";

const AUDIO_EXTRACT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const SEARCH_RESULT_LIMIT: i64 = 200;

// S5 证明单实例 large-v3-turbo 已约 24x 实时。通用 worker 池可以并发，
// 但 Whisper/Metal 必须单独限流，避免多个进程争抢同一块 GPU。
static WHISPER_PERMIT: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TranscribePayload {
    clip_id: i64,
    path: String,
    source_hash: String,
}

#[derive(Debug, Clone)]
struct ClipSource {
    clip_id: i64,
    path: PathBuf,
    source_hash: String,
    tb_num: i64,
    tb_den: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSrtSegment {
    seg_index: i64,
    start_millis: i64,
    end_millis: i64,
    text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TranscriptMatch {
    pub clip_id: i64,
    pub seg: i64,
    pub text: String,
    pub start_ticks: i64,
    pub end_ticks: i64,
    pub tb_num: i64,
    pub tb_den: i64,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct TemporaryFiles(Vec<PathBuf>);

impl Drop for TemporaryFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub fn enqueue_for_clip(
    connection: &mut Connection,
    clip_id: i64,
    path: &Path,
    source_hash: &str,
) -> Result<Option<i64>> {
    let eligible = connection
        .query_row(
            "SELECT 1
             FROM clip_analysis
             WHERE clip_id = ?1 AND has_audio = 1 AND audio_peak_db IS NOT NULL",
            [clip_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !eligible {
        // L1 将无音轨和纯静音都排除。若一次重分析把旧结果判成静音，
        // 检索和交付也不能继续暴露旧对白。
        connection.execute("DELETE FROM transcript_segments WHERE clip_id = ?1", [clip_id])?;
        connection.execute(
            "DELETE FROM cache_artifacts
             WHERE clip_id = ?1 AND kind IN ('transcript', 'srt')",
            [clip_id],
        )?;
        return Ok(None);
    }

    let payload = TranscribePayload {
        clip_id,
        path: path.to_string_lossy().into_owned(),
        source_hash: source_hash.to_owned(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Transcription(format!("无法创建转写任务：{error}")))?;
    let model_tier = super::settings::string_value(
        connection,
        super::settings::WHISPER_MODEL_TIER_KEY,
        DEFAULT_MODEL_TIER,
    )?;
    let payload_hash = blake3::hash(
        format!("transcribe\0{clip_id}\0{source_hash}\0{model_tier}").as_bytes(),
    )
    .to_hex()
    .to_string();

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists = transaction
        .query_row(
            "SELECT 1 FROM jobs
             WHERE kind = 'transcribe' AND payload_hash = ?1
               AND (
                   status IN ('pending', 'running', 'blocked')
                   OR (status = 'done' AND EXISTS(
                       SELECT 1 FROM cache_artifacts
                       WHERE clip_id = ?2 AND kind = 'transcript' AND source_hash = ?3
                   ) AND EXISTS(
                       SELECT 1 FROM cache_artifacts
                       WHERE clip_id = ?2 AND kind = 'srt' AND source_hash = ?3
                   ))
               )
             LIMIT 1",
            params![payload_hash, clip_id, source_hash],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        transaction.commit()?;
        return Ok(None);
    }
    transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            'transcribe', ?1, ?2, 'pending', 0,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )",
        params![payload_json, payload_hash],
    )?;
    let id = transaction.last_insert_rowid();
    transaction.commit()?;
    Ok(Some(id))
}

pub fn run_transcribe(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
) -> Result<()> {
    let payload = parse_payload(&job.payload)?;
    let Some(mut source) = load_eligible_source(connection, &payload)? else {
        return jobs::mark_done(connection, job.id, job.attempt);
    };
    source.path = super::media_source::verified_clip_path(connection, payload.clip_id)
        .map_err(|error| CoreError::Transcription(error.to_string()))?;

    let whisper_candidate = super::settings::configured_executable(
        connection,
        super::settings::WHISPER_PATH_KEY,
        "WHISPER_BIN",
        "whisper-cli",
    )?;
    let whisper = match executable_candidate(whisper_candidate) {
        Some(path) => path,
        None => {
            return block_job(
                connection,
                job,
                "找不到应用内置的 whisper-cli；请重新安装完整 DMG（开发调试可设置 WHISPER_BIN）。",
            )
        }
    };
    let model_tier = super::settings::string_value(
        connection,
        super::settings::WHISPER_MODEL_TIER_KEY,
        DEFAULT_MODEL_TIER,
    )?;
    let model = match resolve_model_for_tier(&model_tier) {
        Some(path) => path,
        None => return block_job(connection, job, &missing_model_message(&model_tier)),
    };
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;

    let clip_cache = cache_root.join(source.clip_id.to_string());
    std::fs::create_dir_all(&clip_cache)?;
    let audio_path = clip_cache.join(format!("whisper-input.tmp-{}.wav", job.attempt));
    let output_base = clip_cache.join(format!("transcript.tmp-{}", job.attempt));
    let json_temporary = append_suffix(&output_base, ".json");
    let srt_temporary = append_suffix(&output_base, ".srt");
    let temporary_files = TemporaryFiles(vec![
        audio_path.clone(),
        json_temporary.clone(),
        srt_temporary.clone(),
    ]);
    for path in &temporary_files.0 {
        remove_file_if_exists(path)?;
    }

    extract_audio(&source.path, &audio_path, &ffmpeg)?;
    let whisper_permit = WHISPER_PERMIT
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    transcribe_audio(&whisper, &model, &audio_path, &output_base)?;
    drop(whisper_permit);
    validate_nonempty_file(&json_temporary, "Whisper JSON")?;
    validate_nonempty_file(&srt_temporary, "Whisper SRT")?;

    let json_bytes = std::fs::read(&json_temporary)?;
    serde_json::from_slice::<serde_json::Value>(&json_bytes)
        .map_err(|error| CoreError::Transcription(format!("Whisper JSON 无效：{error}")))?;
    let srt_bytes = std::fs::read(&srt_temporary)?;
    let srt_text = std::str::from_utf8(&srt_bytes)
        .map_err(|error| CoreError::Transcription(format!("Whisper SRT 不是 UTF-8：{error}")))?;
    let segments = parse_srt(srt_text)?;

    persist_transcript(
        connection,
        job,
        &source,
        cache_root,
        &json_temporary,
        &srt_temporary,
        &segments,
    )?;
    drop(temporary_files);
    Ok(())
}

pub fn search_transcripts(connection: &Connection, keyword: &str) -> Result<Vec<TranscriptMatch>> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", escape_like(keyword));
    let mut statement = connection.prepare(
        "SELECT ts.clip_id, ts.seg_index, ts.text,
                ts.start_ticks, ts.end_ticks,
                COALESCE(c.tb_num, 0), COALESCE(c.tb_den, 0)
         FROM transcript_segments ts
         JOIN clips c ON c.id = ts.clip_id
         WHERE ts.text LIKE ?1 ESCAPE '\\'
         ORDER BY ts.clip_id, ts.start_ticks, ts.seg_index
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![pattern, SEARCH_RESULT_LIMIT], |row| {
        Ok(TranscriptMatch {
            clip_id: row.get(0)?,
            seg: row.get(1)?,
            text: row.get(2)?,
            start_ticks: row.get(3)?,
            end_ticks: row.get(4)?,
            tb_num: row.get(5)?,
            tb_den: row.get(6)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)
}

fn parse_payload(json: &str) -> Result<TranscribePayload> {
    serde_json::from_str(json)
        .map_err(|error| CoreError::Transcription(format!("转写任务数据无效：{error}")))
}

fn load_eligible_source(
    connection: &Connection,
    payload: &TranscribePayload,
) -> Result<Option<ClipSource>> {
    connection
        .query_row(
            "SELECT c.tb_num, c.tb_den
             FROM clips c
             JOIN clip_analysis a ON a.clip_id = c.id
             WHERE c.id = ?1 AND c.quick_hash = ?2
               AND a.has_audio = 1 AND a.audio_peak_db IS NOT NULL",
            params![payload.clip_id, payload.source_hash],
            |row| {
                Ok(ClipSource {
                    clip_id: payload.clip_id,
                    path: PathBuf::from(&payload.path),
                    source_hash: payload.source_hash.clone(),
                    tb_num: row.get(0)?,
                    tb_den: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(CoreError::from)
}

#[cfg(test)]
fn resolve_model() -> Option<PathBuf> {
    resolve_model_for_tier(DEFAULT_MODEL_TIER)
}

fn resolve_model_for_tier(tier: &str) -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("WHISPER_MODEL").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(configured);
        return path.is_file().then_some(path);
    }
    let model = super::settings::models_directory()
        .join(super::settings::model_file_for_tier(tier));
    model.is_file().then_some(model)
}

fn executable_candidate(candidate: OsString) -> Option<OsString> {
    let path = Path::new(&candidate);
    if path.components().count() > 1 {
        return path.is_file().then_some(candidate);
    }
    find_on_path(path.to_str()?)
}

fn find_on_path(name: &str) -> Option<OsString> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .map(PathBuf::into_os_string)
}

fn missing_model_message(tier: &str) -> String {
    let model_file = super::settings::model_file_for_tier(tier);
    format!(
        "缺少 Whisper 模型；请从 huggingface 的 ggerganov/whisper.cpp 下载 {model_file}，放到 ~/Library/Application Support/TripCutStudio/models/，或设置 WHISPER_MODEL。"
    )
}

fn block_job(connection: &mut Connection, job: &Job, summary: &str) -> Result<()> {
    let changed = connection.execute(
        "UPDATE jobs
         SET status = 'blocked', blocked_summary = ?3,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2",
        params![job.id, job.attempt, summary],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "transcribe job {} attempt {} is not running",
            job.id, job.attempt
        )));
    }
    Ok(())
}

fn extract_audio(source: &Path, output: &Path, ffmpeg: &OsStr) -> Result<()> {
    let args = [
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        source.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0:a:0"),
        OsString::from("-vn"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from("16000"),
        OsString::from("-c:a"),
        OsString::from("pcm_s16le"),
        OsString::from("-f"),
        OsString::from("wav"),
        OsString::from("-y"),
        output.as_os_str().to_owned(),
    ];
    let result = execute_with_timeout(ffmpeg, &args, AUDIO_EXTRACT_TIMEOUT).map_err(|error| {
        CoreError::Transcription(format!("无法提取 Whisper 16kHz 单声道音频：{error}"))
    })?;
    if !result.success {
        return Err(command_failure("ffmpeg 音频提取", &result));
    }
    validate_nonempty_file(output, "Whisper 输入音频")
}

fn transcribe_audio(
    whisper: &OsStr,
    model: &Path,
    audio: &Path,
    output_base: &Path,
) -> Result<()> {
    let args = [
        OsString::from("-m"),
        model.as_os_str().to_owned(),
        OsString::from("-f"),
        audio.as_os_str().to_owned(),
        // 真实素材可能是中文、英文或混合口播；auto 会把中文识别为 zh，
        // 同时保留 S4 英文 walking tour 的原语言文本。
        OsString::from("-l"),
        OsString::from("auto"),
        OsString::from("-oj"),
        OsString::from("-osrt"),
        OsString::from("-of"),
        output_base.as_os_str().to_owned(),
    ];
    let result = execute_with_timeout(whisper, &args, TRANSCRIBE_TIMEOUT).map_err(|error| {
        CoreError::Transcription(format!("无法运行 whisper-cli：{error}"))
    })?;
    if !result.success {
        return Err(command_failure("whisper-cli", &result));
    }
    Ok(())
}

fn persist_transcript(
    connection: &mut Connection,
    job: &Job,
    source: &ClipSource,
    cache_root: &Path,
    json_temporary: &Path,
    srt_temporary: &Path,
    segments: &[ParsedSrtSegment],
) -> Result<()> {
    if source.tb_num <= 0 || source.tb_den <= 0 {
        return Err(CoreError::Transcription(format!(
            "素材 {} 的 time_base 无效：{}/{}",
            source.clip_id, source.tb_num, source.tb_den
        )));
    }

    let json_relative = PathBuf::from(source.clip_id.to_string()).join(TRANSCRIPT_FILE);
    let srt_relative = PathBuf::from(source.clip_id.to_string()).join(SRT_FILE);
    let json_final = cache_root.join(&json_relative);
    let srt_final = cache_root.join(&srt_relative);
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = transaction
        .query_row(
            "SELECT 1 FROM jobs j
             JOIN clips c ON c.id = ?3
             WHERE j.id = ?1 AND j.status = 'running' AND j.attempt = ?2 AND j.cancel_requested = 0
               AND c.quick_hash = ?4",
            params![job.id, job.attempt, source.clip_id, source.source_hash],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !current {
        return Err(CoreError::InvalidTransition(format!(
            "transcribe job {} attempt {} is stale",
            job.id, job.attempt
        )));
    }

    std::fs::rename(json_temporary, &json_final)?;
    std::fs::rename(srt_temporary, &srt_final)?;
    let json_bytes = file_bytes(&json_final)?;
    let srt_bytes = file_bytes(&srt_final)?;
    for (kind, relative, bytes) in [
        ("transcript", &json_relative, json_bytes),
        ("srt", &srt_relative, srt_bytes),
    ] {
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
                source.clip_id,
                kind,
                relative.to_string_lossy(),
                source.source_hash,
                bytes,
            ],
        )?;
    }

    transaction.execute(
        "DELETE FROM transcript_segments WHERE clip_id = ?1",
        [source.clip_id],
    )?;
    for segment in segments {
        let start_ticks = millis_to_ticks(segment.start_millis, source.tb_num, source.tb_den)?;
        let end_ticks = millis_to_ticks(segment.end_millis, source.tb_num, source.tb_den)?;
        transaction.execute(
            "INSERT INTO transcript_segments(
                clip_id, seg_index, start_ticks, end_ticks, text
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                source.clip_id,
                segment.seg_index,
                start_ticks,
                end_ticks.max(start_ticks),
                segment.text,
            ],
        )?;
    }

    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', result_path = ?3, blocked_summary = NULL,
             owner_id = NULL, lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2 AND cancel_requested = 0",
        params![job.id, job.attempt, srt_final.to_string_lossy()],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "transcribe job {} attempt {} changed during finalization",
            job.id, job.attempt
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn parse_srt(input: &str) -> Result<Vec<ParsedSrtSegment>> {
    let normalized = input.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut parsed = Vec::new();
    for block in normalized.split("\n\n") {
        let mut lines = block.lines().filter(|line| !line.trim().is_empty());
        let Some(index_line) = lines.next() else {
            continue;
        };
        let seg_index = index_line.trim().parse::<i64>().map_err(|_| {
            CoreError::Transcription(format!("SRT 序号无效：{}", index_line.trim()))
        })?;
        let timing = lines.next().ok_or_else(|| {
            CoreError::Transcription(format!("SRT 第 {seg_index} 段缺少时间行"))
        })?;
        let (from, to) = timing.split_once("-->").ok_or_else(|| {
            CoreError::Transcription(format!("SRT 第 {seg_index} 段时间行无效：{timing}"))
        })?;
        let start_millis = parse_srt_timestamp(from.trim())?;
        let end_millis = parse_srt_timestamp(to.trim())?;
        if end_millis < start_millis {
            return Err(CoreError::Transcription(format!(
                "SRT 第 {seg_index} 段结束时间早于开始时间"
            )));
        }
        let text = lines.collect::<Vec<_>>().join("\n").trim().to_owned();
        if text.is_empty() {
            continue;
        }
        parsed.push(ParsedSrtSegment {
            seg_index,
            start_millis,
            end_millis,
            text,
        });
    }
    Ok(parsed)
}

fn parse_srt_timestamp(value: &str) -> Result<i64> {
    let (clock, millis) = value.split_once(',').ok_or_else(|| {
        CoreError::Transcription(format!("SRT 时间戳缺少毫秒：{value}"))
    })?;
    let mut components = clock.split(':');
    let hours = parse_time_component(components.next(), value)?;
    let minutes = parse_time_component(components.next(), value)?;
    let seconds = parse_time_component(components.next(), value)?;
    if components.next().is_some() || minutes >= 60 || seconds >= 60 {
        return Err(CoreError::Transcription(format!("SRT 时间戳无效：{value}")));
    }
    let millis = millis
        .parse::<i64>()
        .map_err(|_| CoreError::Transcription(format!("SRT 毫秒无效：{value}")))?;
    if !(0..1000).contains(&millis) {
        return Err(CoreError::Transcription(format!("SRT 毫秒越界：{value}")));
    }
    hours
        .checked_mul(3_600_000)
        .and_then(|value| value.checked_add(minutes * 60_000))
        .and_then(|value| value.checked_add(seconds * 1_000))
        .and_then(|value| value.checked_add(millis))
        .ok_or_else(|| CoreError::Transcription(format!("SRT 时间戳溢出：{value}")))
}

fn parse_time_component(value: Option<&str>, timestamp: &str) -> Result<i64> {
    value
        .ok_or_else(|| CoreError::Transcription(format!("SRT 时间戳不完整：{timestamp}")))?
        .parse::<i64>()
        .map_err(|_| CoreError::Transcription(format!("SRT 时间戳无效：{timestamp}")))
}

fn millis_to_ticks(millis: i64, tb_num: i64, tb_den: i64) -> Result<i64> {
    if millis < 0 || tb_num <= 0 || tb_den <= 0 {
        return Err(CoreError::Transcription(format!(
            "无法换算时间戳：{millis}ms @ {tb_num}/{tb_den}"
        )));
    }
    let numerator = i128::from(millis)
        .checked_mul(i128::from(tb_den))
        .ok_or_else(|| CoreError::Transcription("SRT ticks 换算溢出".to_owned()))?;
    let denominator = i128::from(tb_num)
        .checked_mul(1_000)
        .ok_or_else(|| CoreError::Transcription("SRT ticks 换算溢出".to_owned()))?;
    // 四舍五入到最近的源 time_base tick，避免系统性提前字幕。
    let ticks = numerator
        .checked_add(denominator / 2)
        .ok_or_else(|| CoreError::Transcription("SRT ticks 换算溢出".to_owned()))?
        / denominator;
    i64::try_from(ticks)
        .map_err(|_| CoreError::Transcription("SRT ticks 超出 i64 范围".to_owned()))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn file_bytes(path: &Path) -> Result<i64> {
    i64::try_from(std::fs::metadata(path)?.len())
        .map_err(|_| CoreError::Transcription(format!("缓存文件过大：{}", path.display())))
}

fn validate_nonempty_file(path: &Path, label: &str) -> Result<()> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        CoreError::Transcription(format!("{label} 未生成（{}）：{error}", path.display()))
    })?;
    if metadata.len() == 0 {
        return Err(CoreError::Transcription(format!("{label} 是空文件")));
    }
    File::open(path)?.sync_all()?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
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
        thread::sleep(Duration::from_millis(50));
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

fn command_failure(label: &str, output: &CommandOutput) -> CoreError {
    let diagnostic = if output.stderr.iter().all(u8::is_ascii_whitespace) {
        &output.stdout
    } else {
        &output.stderr
    };
    let summary = String::from_utf8_lossy(diagnostic)
        .trim()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(1_024)
        .collect::<String>();
    CoreError::Transcription(format!(
        "{label} 失败（退出码 {}）：{}",
        output
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_owned()),
        if summary.is_empty() {
            "没有错误输出"
        } else {
            &summary
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::migrations::{
        MIGRATION_0001, MIGRATION_0002, MIGRATION_0003, MIGRATION_0005, MIGRATION_0013,
    };
    use crate::core::test_support::TestDirectory;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection.execute_batch(MIGRATION_0001).unwrap();
        connection.execute_batch(MIGRATION_0002).unwrap();
        connection.execute_batch(MIGRATION_0003).unwrap();
        connection.execute_batch(MIGRATION_0005).unwrap();
        connection.execute_batch(MIGRATION_0013).unwrap();
        connection
    }

    fn insert_clip(connection: &Connection, path: &Path, has_audio: bool, peak: Option<f64>) -> i64 {
        connection
            .execute("INSERT OR IGNORE INTO volumes(uuid) VALUES ('transcribe-test')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, quick_hash, tb_num, tb_den, duration_ticks
                 ) VALUES ('transcribe-test', ?1, ?2, 1, 1000, 10000)",
                rusqlite::params![
                    path.to_string_lossy(),
                    crate::core::import::quick_fingerprint(path)
                        .map(|(hash, _)| hash)
                        .unwrap_or_else(|_| "source-hash".to_owned())
                ],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO clip_analysis(
                    clip_id, exposure_yavg, overexposed_ratio, audio_peak_db,
                    audio_clipped, has_audio, focus_scores, scene_count,
                    analyzed_at, tool_versions
                 ) VALUES (?1, 80, 0, ?2, 0, ?3, '[]', 1,
                           '2026-08-31T00:00:00Z', '{}')",
                params![clip_id, peak, if has_audio { 1 } else { 0 }],
            )
            .unwrap();
        clip_id
    }

    #[test]
    fn parses_standard_srt_and_preserves_multiline_text() {
        let parsed = parse_srt(
            "1\r\n00:00:00,000 --> 00:00:01,250\r\n大家好\r\n欢迎出发\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,500\r\n西安城墙\r\n",
        )
        .unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].text, "大家好\n欢迎出发");
        assert_eq!((parsed[1].start_millis, parsed[1].end_millis), (2_000, 3_500));
    }

    #[test]
    fn converts_srt_milliseconds_to_source_time_base_ticks() {
        assert_eq!(millis_to_ticks(1_250, 1, 1_000).unwrap(), 1_250);
        assert_eq!(millis_to_ticks(1_001, 1, 90_000).unwrap(), 90_090);
        assert_eq!(millis_to_ticks(1_000, 1_001, 30_000).unwrap(), 30);
    }

    #[test]
    fn silent_or_missing_audio_skips_transcribe_enqueue() {
        let mut connection = connection();
        let no_track = insert_clip(&connection, Path::new("no-track.mov"), false, None);
        let silence = insert_clip(&connection, Path::new("silence.mov"), true, None);
        assert!(enqueue_for_clip(&mut connection, no_track, Path::new("no-track.mov"), "source-hash")
            .unwrap()
            .is_none());
        assert!(enqueue_for_clip(&mut connection, silence, Path::new("silence.mov"), "source-hash")
            .unwrap()
            .is_none());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE kind = 'transcribe'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn eligible_transcribe_enqueue_is_idempotent() {
        let mut connection = connection();
        let clip_id = insert_clip(&connection, Path::new("voice.mov"), true, Some(-12.0));
        assert!(enqueue_for_clip(&mut connection, clip_id, Path::new("voice.mov"), "source-hash")
            .unwrap()
            .is_some());
        assert!(enqueue_for_clip(&mut connection, clip_id, Path::new("voice.mov"), "source-hash")
            .unwrap()
            .is_none());
    }

    #[test]
    fn missing_model_blocked_copy_names_huggingface_and_default_model() {
        let message = missing_model_message(DEFAULT_MODEL_TIER);
        assert!(message.contains("huggingface"));
        assert!(message.contains("ggml-large-v3-turbo.bin"));
        assert!(message.contains("WHISPER_MODEL"));
    }

    #[test]
    fn missing_model_message_is_persisted_as_blocked_without_retries() {
        let mut connection = connection();
        let clip_id = insert_clip(&connection, Path::new("voice.mov"), true, Some(-12.0));
        enqueue_for_clip(&mut connection, clip_id, Path::new("voice.mov"), "source-hash")
            .unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        block_job(
            &mut connection,
            &job,
            &missing_model_message(DEFAULT_MODEL_TIER),
        )
        .unwrap();

        let blocked = jobs::get(&connection, job.id).unwrap();
        assert_eq!(blocked.status, jobs::JobStatus::Blocked);
        assert_eq!(blocked.attempt, 1);
        assert!(blocked
            .blocked_summary
            .as_deref()
            .is_some_and(|summary| summary.contains("ggml-large-v3-turbo.bin")));
    }

    #[test]
    fn transcript_search_treats_like_wildcards_as_literal_text() {
        let connection = connection();
        let clip_id = insert_clip(&connection, Path::new("voice.mov"), true, Some(-12.0));
        connection
            .execute(
                "INSERT INTO transcript_segments(
                    clip_id, seg_index, start_ticks, end_ticks, text
                 ) VALUES (?1, 1, 10, 20, '100%_完成'),
                          (?1, 2, 30, 40, '100xx完成')",
                [clip_id],
            )
            .unwrap();
        let matches = search_transcripts(&connection, "%_").unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].text, "100%_完成");
    }

    #[test]
    fn parsed_segments_and_both_artifacts_commit_with_running_job() {
        let directory = TestDirectory::new();
        let cache_root = directory.path().join("cache");
        let clip_cache = cache_root.join("1");
        std::fs::create_dir_all(&clip_cache).unwrap();
        let json_temp = clip_cache.join("result.tmp.json");
        let srt_temp = clip_cache.join("result.tmp.srt");
        std::fs::write(&json_temp, b"{}").unwrap();
        std::fs::write(&srt_temp, b"1\n00:00:01,000 --> 00:00:02,000\nhello\n").unwrap();

        let mut connection = connection();
        let clip_id = insert_clip(&connection, Path::new("voice.mov"), true, Some(-12.0));
        let job_id = jobs::enqueue(&mut connection, "transcribe", "{}", "persist").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(job.id, job_id);
        let source = ClipSource {
            clip_id,
            path: PathBuf::from("voice.mov"),
            source_hash: "source-hash".to_owned(),
            tb_num: 1,
            tb_den: 1_000,
        };
        let segments = parse_srt(
            "1\n00:00:01,000 --> 00:00:02,000\nhello\n",
        )
        .unwrap();
        persist_transcript(
            &mut connection,
            &job,
            &source,
            &cache_root,
            &json_temp,
            &srt_temp,
            &segments,
        )
        .unwrap();

        let ticks: (i64, i64) = connection
            .query_row(
                "SELECT start_ticks, end_ticks FROM transcript_segments WHERE clip_id = ?1",
                [clip_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let artifact_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM cache_artifacts
                 WHERE clip_id = ?1 AND kind IN ('transcript', 'srt')",
                [clip_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ticks, (1_000, 2_000));
        assert_eq!(artifact_count, 2);
        assert_eq!(jobs::get(&connection, job_id).unwrap().status, jobs::JobStatus::Done);
    }

    #[test]
    fn cancelled_transcript_cannot_commit_artifacts_or_segments() {
        let directory = TestDirectory::new();
        let cache_root = directory.path().join("cache");
        let clip_cache = cache_root.join("1");
        std::fs::create_dir_all(&clip_cache).unwrap();
        let json_temp = clip_cache.join("result.tmp.json");
        let srt_temp = clip_cache.join("result.tmp.srt");
        std::fs::write(&json_temp, b"{}").unwrap();
        std::fs::write(&srt_temp, b"1\n00:00:01,000 --> 00:00:02,000\nhello\n").unwrap();

        let mut connection = connection();
        let clip_id = insert_clip(&connection, Path::new("voice.mov"), true, Some(-12.0));
        let job_id = jobs::enqueue(&mut connection, "transcribe", "{}", "persist").unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(job.id, job_id);
        let source = ClipSource {
            clip_id,
            path: PathBuf::from("voice.mov"),
            source_hash: "source-hash".to_owned(),
            tb_num: 1,
            tb_den: 1_000,
        };
        let segments = parse_srt(
            "1\n00:00:01,000 --> 00:00:02,000\nhello\n",
        )
        .unwrap();
        jobs::request_cancel(&mut connection, job_id).unwrap();
        let result = persist_transcript(
            &mut connection,
            &job,
            &source,
            &cache_root,
            &json_temp,
            &srt_temp,
            &segments,
        );
        assert!(result.is_err());
        assert!(!clip_cache.join(TRANSCRIPT_FILE).exists());
        assert!(!clip_cache.join(SRT_FILE).exists());
        for table in ["cache_artifacts", "transcript_segments"] {
            let count: i64 = connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap();
            assert_eq!(count, 0, "{table} changed after cancellation");
        }
        assert_ne!(jobs::get(&connection, job_id).unwrap().status, jobs::JobStatus::Done);
    }

    #[test]
    fn say_fixture_transcribes_when_say_whisper_model_and_ffmpeg_are_available() {
        let Some(say) = find_on_path("say") else {
            eprintln!("skipping say/whisper fixture: say unavailable");
            return;
        };
        let settings_connection = Connection::open_in_memory().unwrap();
        let whisper = crate::core::settings::configured_executable(
            &settings_connection,
            crate::core::settings::WHISPER_PATH_KEY,
            "WHISPER_BIN",
            "whisper-cli",
        )
        .ok()
        .and_then(executable_candidate);
        let ffmpeg = crate::core::settings::configured_executable(
            &settings_connection,
            crate::core::settings::FFMPEG_PATH_KEY,
            "FFMPEG_PATH",
            "ffmpeg",
        )
        .ok()
        .and_then(executable_candidate);
        if whisper.is_none() || resolve_model().is_none() || ffmpeg.is_none() {
            eprintln!("skipping say/whisper fixture: whisper, model, or ffmpeg unavailable");
            return;
        }
        let directory = TestDirectory::new();
        let source = directory.path().join("speech.aiff");
        let status = Command::new(say)
            .args(["-v", "Tingting", "-o"])
            .arg(&source)
            .arg("大家好，今天我们一起去看西安城墙。")
            .status();
        if !status.is_ok_and(|status| status.success()) {
            eprintln!("skipping say/whisper fixture: speech synthesis failed");
            return;
        }

        let mut connection = connection();
        let clip_id = insert_clip(&connection, &source, true, Some(-12.0));
        let real_hash = crate::core::import::quick_fingerprint(&source).unwrap().0;
        enqueue_for_clip(&mut connection, clip_id, &source, &real_hash).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_transcribe(&mut connection, &job, &directory.path().join("cache")).unwrap();
        let text: String = connection
            .query_row(
                "SELECT group_concat(text, '') FROM transcript_segments WHERE clip_id = ?1",
                [clip_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!text.trim().is_empty());
    }
}
