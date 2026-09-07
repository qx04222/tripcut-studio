//! R5 Task 4：调用随包的 Vision OCR 工具（`sidecar-ocr`，Swift/Vision，
//! Apache-2.0）识别画面中的中英文文字。
//!
//! 协议（见 `sidecar-ocr/main.swift`）：stdin 一行一个图片绝对路径；stdout
//! 一行一个 JSON——成功 `{"path","texts":[{"text","confidence","bbox":[x,y,w,h]}]}`，
//! 失败（坏图）`{"path","error"}`，工具进程本身以 0 退出。

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::{self, Job};

const BATCH_TIMEOUT: Duration = Duration::from_secs(60);
/// R5 Task 5:裁剪单帧 / 探测胶片条尺寸的超时——都是单张小图操作,远比整段
/// 解码快,60s 绰绰有余同时不会在真正卡死时无限等待。
const IMAGE_PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const CROP_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
pub struct OcrHit {
    pub text: String,
    pub confidence: f32,
    pub bbox: [f32; 4],
}

#[derive(Debug, Deserialize)]
struct RawTextHit {
    text: String,
    confidence: f32,
    bbox: [f32; 4],
}

#[derive(Debug, Deserialize)]
struct RawLine {
    path: String,
    #[serde(default)]
    texts: Option<Vec<RawTextHit>>,
    #[serde(default)]
    error: Option<String>,
}

/// Runs the bundled Vision OCR tool on `image_paths` and returns, for each
/// input path (in order), the text hits found on it. An image the tool could
/// not read comes back with an empty hit list rather than failing the whole
/// batch — only a missing tool, a broken pipe, a timeout, or malformed JSON
/// on the wire is an `Err`.
pub fn recognize(image_paths: &[PathBuf]) -> Result<Vec<(PathBuf, Vec<OcrHit>)>> {
    recognize_with(resolve_tool(), image_paths)
}

/// Testable core of `recognize`, parameterized on an already-resolved tool
/// path so tests can exercise both the "missing tool" and the real
/// end-to-end path without mutating process-global environment variables
/// (which would race against every other test in this binary).
fn recognize_with(
    tool: Option<PathBuf>,
    image_paths: &[PathBuf],
) -> Result<Vec<(PathBuf, Vec<OcrHit>)>> {
    if image_paths.is_empty() {
        return Ok(Vec::new());
    }
    let tool = tool.ok_or_else(|| CoreError::Ocr("OCR 组件未安装".to_owned()))?;
    let lines = run_tool(&tool, image_paths)?;
    parse_lines(&lines)
}

/// Resolution order: `TRIPCUT_SIDECAR_OCR` env override -> the bundled
/// `Contents/MacOS/sidecar-ocr` next to the running executable -> the dev
/// build cache (`scripts/build-sidecar-ocr.sh`'s fixed output directory).
fn resolve_tool() -> Option<PathBuf> {
    resolve_tool_from(
        std::env::var_os("TRIPCUT_SIDECAR_OCR"),
        std::env::current_exe().ok(),
        std::env::var_os("HOME"),
    )
}

fn resolve_tool_from(
    env_override: Option<std::ffi::OsString>,
    current_exe: Option<PathBuf>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if let Some(configured) = env_override.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(exe) = current_exe {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("sidecar-ocr");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }
    if let Some(home) = home {
        let dev_cache = PathBuf::from(home)
            .join("Library/Caches/tripcut-build/sidecar-ocr/out/sidecar-ocr");
        if dev_cache.is_file() {
            return Some(dev_cache);
        }
    }
    None
}

fn run_tool(tool: &Path, image_paths: &[PathBuf]) -> Result<Vec<String>> {
    let mut child = Command::new(tool)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CoreError::Ocr(format!("无法启动 sidecar-ocr：{error}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| CoreError::Ocr("sidecar-ocr 缺少 stdin 管道".to_owned()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::Ocr("sidecar-ocr 缺少 stdout 管道".to_owned()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| CoreError::Ocr("sidecar-ocr 缺少 stderr 管道".to_owned()))?;

    // 一次性把所有路径写完再关闭 stdin：批次都是几十张图的路径列表，
    // 写入量小,不会造成管道死锁。
    let write_result = (|| -> std::io::Result<()> {
        for path in image_paths {
            writeln!(stdin, "{}", path.display())?;
        }
        Ok(())
    })();
    drop(stdin);
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(CoreError::Ocr(format!("写入 sidecar-ocr stdin 失败：{error}")));
    }

    let stdout_reader = thread::spawn(move || -> std::io::Result<Vec<String>> {
        let mut lines = Vec::new();
        for line in BufReader::new(stdout).lines() {
            lines.push(line?);
        }
        Ok(lines)
    });
    let stderr_reader = thread::spawn(move || -> std::io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes)?;
        Ok(bytes)
    });

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| CoreError::Ocr(format!("等待 sidecar-ocr 失败：{error}")))?
        {
            break status;
        }
        if started.elapsed() >= BATCH_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(CoreError::Ocr(format!(
                "sidecar-ocr 超过 {} 秒未完成",
                BATCH_TIMEOUT.as_secs()
            )));
        }
        thread::sleep(Duration::from_millis(20));
    };

    let lines = stdout_reader
        .join()
        .map_err(|_| CoreError::Ocr("sidecar-ocr stdout 读取线程崩溃".to_owned()))?
        .map_err(|error| CoreError::Ocr(format!("读取 sidecar-ocr stdout 失败：{error}")))?;
    let stderr_bytes = stderr_reader
        .join()
        .map_err(|_| CoreError::Ocr("sidecar-ocr stderr 读取线程崩溃".to_owned()))?
        .unwrap_or_default();

    if !status.success() {
        let diagnostic = String::from_utf8_lossy(&stderr_bytes)
            .trim()
            .chars()
            .take(1_024)
            .collect::<String>();
        return Err(CoreError::Ocr(format!(
            "sidecar-ocr 退出码 {:?}：{diagnostic}",
            status.code()
        )));
    }
    Ok(lines)
}

fn parse_lines(lines: &[String]) -> Result<Vec<(PathBuf, Vec<OcrHit>)>> {
    let mut results = Vec::with_capacity(lines.len());
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let raw: RawLine = serde_json::from_str(trimmed).map_err(|error| {
            CoreError::Ocr(format!("OCR 输出 JSON 无效：{error}；行内容：{trimmed}"))
        })?;
        let path = PathBuf::from(raw.path);
        if let Some(message) = raw.error {
            tracing::warn!(path = %path.display(), error = %message, "OCR 单张图片失败，已跳过");
            results.push((path, Vec::new()));
            continue;
        }
        let hits = raw
            .texts
            .unwrap_or_default()
            .into_iter()
            .map(|hit| OcrHit {
                text: hit.text,
                confidence: hit.confidence,
                bbox: hit.bbox,
            })
            .collect();
        results.push((path, hits));
    }
    Ok(results)
}

// ---------------------------------------------------------------------------
// R5 Task 5：`ocr_scan` 后台任务——从胶片条切帧、调用上面的 `recognize`、
// 落库到 `clip_ocr_texts`，并挂在 `thumbnail` 完成之后自动入队。
// ---------------------------------------------------------------------------

/// 单帧识别结果里已带一层文字过滤（相邻帧去重）后，实际要写入
/// `clip_ocr_texts` 的一行。
struct OcrRow {
    frame_tick: i64,
    text: String,
    confidence: f32,
    bbox_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct OcrScanPayload {
    clip_id: i64,
    source_hash: String,
    strip_path: String,
    strip_frame_count: usize,
    duration_ticks: i64,
    tb_num: i64,
    tb_den: i64,
}

/// 前端按帧展示用的一条 OCR 命中；`list_hits` 的返回类型。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OcrTextHit {
    pub frame_tick: i64,
    pub tb_num: i64,
    pub tb_den: i64,
    pub text: String,
    pub confidence: f32,
    pub bbox: [f32; 4],
}

/// `strip` 任务完成后的收尾挂钩：读回胶片条产物路径与素材时长，拼出
/// `ocr_scan` 负载入队。R6 Task 7d/F-R1-8 把封面与胶片条拆成两个任务后，
/// OCR 是在胶片条格子上裁切的，只有 `strip`（不再是 `thumbnail`）落地才有
/// 东西可扫。不是 `strip` 任务、素材已变化（`quick_hash` 不匹配）或胶片条
/// 产物还没落地时安静跳过——这是收尾挂钩，不是硬依赖，调用方
/// （`jobs::run_one_with_owner`）只记警告，不让它拖垮 strip 本身的完成。
pub fn enqueue_after_strip(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
) -> Result<()> {
    if job.kind != "strip" {
        return Ok(());
    }
    let payload: super::artifacts::ArtifactJobPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Ocr(format!("无法读取胶片条任务数据：{error}")))?;
    let row = connection
        .query_row(
            "SELECT c.duration_ticks, c.tb_num, c.tb_den, a.rel_path
             FROM clips c
             JOIN cache_artifacts a
               ON a.clip_id = c.id AND a.kind = 'strip' AND a.source_hash = c.quick_hash
             WHERE c.id = ?1 AND c.quick_hash = ?2",
            params![payload.clip_id, payload.source_hash],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((duration_ticks, tb_num, tb_den, rel_path)) = row else {
        return Ok(());
    };
    enqueue_scan(
        connection,
        payload.clip_id,
        &payload.source_hash,
        duration_ticks,
        tb_num,
        tb_den,
        &cache_root.join(rel_path),
    )
    .map(|_| ())
}

/// 手工补扫入口：当前 Episode 内每条已有胶片条（且与当前 `quick_hash` 匹配）
/// 的素材都尝试入队一次 OCR 扫描，返回本次新增的任务数。
pub fn enqueue_for_episode(connection: &mut Connection, cache_root: &Path) -> Result<usize> {
    let episode = super::episode::current_episode(connection)?;
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT c.id, c.quick_hash, c.duration_ticks, c.tb_num, c.tb_den, a.rel_path
             FROM clips c
             JOIN cache_artifacts a
               ON a.clip_id = c.id AND a.kind = 'strip' AND a.source_hash = c.quick_hash
             WHERE c.episode_id = ?1 AND c.quick_hash IS NOT NULL",
        )?;
        let rows = statement.query_map([episode.id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut enqueued = 0;
    for (clip_id, source_hash, duration_ticks, tb_num, tb_den, rel_path) in candidates {
        if enqueue_scan(
            connection,
            clip_id,
            &source_hash,
            duration_ticks,
            tb_num,
            tb_den,
            &cache_root.join(rel_path),
        )? {
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

/// 拼出 `ocr_scan` 负载并按 `(clip_id, source_hash)` 幂等入队：已有一条
/// pending/running/done 的同负载任务时跳过，返回是否真的新增了一条。
fn enqueue_scan(
    connection: &mut Connection,
    clip_id: i64,
    source_hash: &str,
    duration_ticks: i64,
    tb_num: i64,
    tb_den: i64,
    strip_path: &Path,
) -> Result<bool> {
    if duration_ticks <= 0 || tb_num <= 0 || tb_den <= 0 {
        return Ok(false);
    }
    let duration_seconds = duration_ticks as f64 * tb_num as f64 / tb_den as f64;
    let frame_count = super::artifacts::strip_frame_count(duration_seconds);
    let payload = OcrScanPayload {
        clip_id,
        source_hash: source_hash.to_owned(),
        strip_path: strip_path.to_string_lossy().into_owned(),
        strip_frame_count: frame_count,
        duration_ticks,
        tb_num,
        tb_den,
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Ocr(format!("无法创建 OCR 扫描任务：{error}")))?;
    let payload_hash = blake3::hash(format!("ocr_scan\0{clip_id}\0{source_hash}").as_bytes())
        .to_hex()
        .to_string();
    let existing_status: Option<String> = connection
        .query_row(
            "SELECT status FROM jobs WHERE kind = 'ocr_scan' AND payload_hash = ?1
             ORDER BY id DESC LIMIT 1",
            [&payload_hash],
            |row| row.get(0),
        )
        .optional()?;
    if matches!(existing_status.as_deref(), Some("pending" | "running" | "done")) {
        return Ok(false);
    }
    jobs::enqueue_idempotent(connection, "ocr_scan", &payload_json, &payload_hash)?;
    Ok(true)
}

/// 素材当前的一条 OCR 命中列表，按 `frame_tick` 排序——SelectPage 角标与
/// 未来的按帧检索都读这个。
pub fn list_hits(connection: &Connection, clip_id: i64) -> Result<Vec<OcrTextHit>> {
    let mut statement = connection.prepare(
        "SELECT frame_tick, tb_num, tb_den, text, confidence, bbox_json
         FROM clip_ocr_texts WHERE clip_id = ?1 ORDER BY frame_tick, id",
    )?;
    let rows = statement.query_map([clip_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, f64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut hits = Vec::new();
    for row in rows {
        let (frame_tick, tb_num, tb_den, text, confidence, bbox_json) = row?;
        let bbox: [f32; 4] = serde_json::from_str(&bbox_json).unwrap_or([0.0; 4]);
        hits.push(OcrTextHit {
            frame_tick,
            tb_num,
            tb_den,
            text,
            confidence: confidence as f32,
            bbox,
        });
    }
    Ok(hits)
}

/// 一个 `CoreError::Ocr` 是否来自"工具没装"（`recognize_with` 在
/// `resolve_tool()` 落空时返回的确定性错误）——用来在 `jobs.rs` 里决定直接
/// `mark_blocked_deterministic` 而不是烧重试。
pub(crate) fn is_missing_tool_error(error: &CoreError) -> bool {
    matches!(error, CoreError::Ocr(message) if message.contains("组件未安装"))
}

pub fn run_ocr_scan(connection: &mut Connection, job: &Job, cache_root: &Path) -> Result<()> {
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let ffprobe = super::settings::configured_ffprobe(connection, &ffmpeg)?;
    run_ocr_scan_with(connection, job, cache_root, &ffmpeg, &ffprobe, resolve_tool())
}

/// Testable core of `run_ocr_scan`, parameterized on ffmpeg/ffprobe/tool so
/// tests can point at fixtures without mutating process-global environment
/// variables (same reasoning as `recognize_with`).
fn run_ocr_scan_with(
    connection: &mut Connection,
    job: &Job,
    cache_root: &Path,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    tool: Option<PathBuf>,
) -> Result<()> {
    let payload: OcrScanPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Ocr(format!("OCR 扫描任务数据无效：{error}")))?;
    if !(1..=12).contains(&payload.strip_frame_count) {
        return Err(CoreError::Ocr(format!(
            "素材 {} 的胶片条帧数无效",
            payload.clip_id
        )));
    }
    let is_current: bool = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM jobs j JOIN clips c
            WHERE j.id = ?1 AND j.status = 'running' AND j.attempt = ?2
              AND c.id = ?3 AND c.quick_hash = ?4)",
        params![job.id, job.attempt, payload.clip_id, payload.source_hash],
        |row| row.get(0),
    )?;
    if !is_current {
        return Err(CoreError::InvalidTransition(format!(
            "ocr_scan job {} attempt {} is stale",
            job.id, job.attempt
        )));
    }

    let strip_path = PathBuf::from(&payload.strip_path);
    if !strip_path.is_file() {
        return Err(CoreError::Ocr(format!(
            "素材 {} 缺少胶片条：{}",
            payload.clip_id,
            strip_path.display()
        )));
    }

    let (width, height) = probe_image_dimensions(ffprobe, &strip_path, IMAGE_PROBE_TIMEOUT)?;
    let frame_count = payload.strip_frame_count as i64;
    let tile_width = (width / frame_count).max(1);

    let temp_dir = cache_root
        .join(payload.clip_id.to_string())
        .join(format!("ocr-tmp-{}", job.attempt));
    std::fs::create_dir_all(&temp_dir)?;

    let mut frame_paths = Vec::with_capacity(payload.strip_frame_count);
    for index in 0..frame_count {
        let x = index * tile_width;
        let width_for_tile = if index == frame_count - 1 {
            (width - x).max(1)
        } else {
            tile_width
        };
        let out = temp_dir.join(format!("frame-{index}.jpg"));
        if let Err(error) = crop_tile(ffmpeg, &strip_path, x, width_for_tile, height, &out, CROP_TIMEOUT) {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(error);
        }
        frame_paths.push(out);
    }

    let recognized = match recognize_with(tool, &frame_paths) {
        Ok(value) => value,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&temp_dir);
            return Err(error);
        }
    };

    let mut rows = Vec::new();
    let mut previous_texts: HashSet<String> = HashSet::new();
    for (index, (_path, hits)) in recognized.into_iter().enumerate() {
        let frame_tick = index as i64 * payload.duration_ticks / frame_count;
        let mut current_texts = HashSet::with_capacity(hits.len());
        for hit in hits {
            let is_adjacent_duplicate = previous_texts.contains(&hit.text);
            current_texts.insert(hit.text.clone());
            if is_adjacent_duplicate {
                continue;
            }
            let bbox_json = serde_json::to_string(&hit.bbox)
                .map_err(|error| CoreError::Ocr(format!("无法序列化 OCR 坐标：{error}")))?;
            rows.push(OcrRow {
                frame_tick,
                text: hit.text,
                confidence: hit.confidence,
                bbox_json,
            });
        }
        previous_texts = current_texts;
    }

    let result = store_rows(connection, job, &payload, &rows);
    let _ = std::fs::remove_dir_all(&temp_dir);
    result
}

fn store_rows(
    connection: &mut Connection,
    job: &Job,
    payload: &OcrScanPayload,
    rows: &[OcrRow],
) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let is_current: bool = transaction.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM jobs j JOIN clips c
            WHERE j.id = ?1 AND j.status = 'running' AND j.attempt = ?2
              AND c.id = ?3 AND c.quick_hash = ?4)",
        params![job.id, job.attempt, payload.clip_id, payload.source_hash],
        |row| row.get(0),
    )?;
    if !is_current {
        return Err(CoreError::InvalidTransition(format!(
            "ocr_scan job {} attempt {} changed before write",
            job.id, job.attempt
        )));
    }
    transaction.execute("DELETE FROM clip_ocr_texts WHERE clip_id = ?1", [payload.clip_id])?;
    for row in rows {
        transaction.execute(
            "INSERT INTO clip_ocr_texts(
                clip_id, frame_tick, tb_num, tb_den, text, confidence, bbox_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![
                payload.clip_id,
                row.frame_tick,
                payload.tb_num,
                payload.tb_den,
                row.text,
                f64::from(row.confidence),
                row.bbox_json,
            ],
        )?;
    }
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', blocked_summary = NULL, result_path = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2",
        params![job.id, job.attempt],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "ocr_scan job {} attempt {} changed during write",
            job.id, job.attempt
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn probe_image_dimensions(ffprobe: &OsStr, path: &Path, timeout: Duration) -> Result<(i64, i64)> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-show_entries"),
        OsString::from("stream=width,height"),
        OsString::from("-of"),
        OsString::from("json"),
        path.as_os_str().to_owned(),
    ];
    let output = execute_with_timeout(ffprobe, &args, timeout).map_err(|error| {
        CoreError::Ocr(format!("ffprobe 无法读取胶片条尺寸 {}：{error}", path.display()))
    })?;
    if !output.success {
        return Err(command_failure("ffprobe 胶片条尺寸探测", &output));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| CoreError::Ocr(format!("胶片条 ffprobe JSON 无效：{error}")))?;
    let stream = value
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .and_then(|streams| streams.first())
        .ok_or_else(|| CoreError::Ocr("胶片条 ffprobe 输出缺少视频流".to_owned()))?;
    let width = stream
        .get("width")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| CoreError::Ocr("胶片条 ffprobe 输出缺少 width".to_owned()))?;
    let height = stream
        .get("height")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| CoreError::Ocr("胶片条 ffprobe 输出缺少 height".to_owned()))?;
    if width <= 0 || height <= 0 {
        return Err(CoreError::Ocr("胶片条尺寸无效".to_owned()));
    }
    Ok((width, height))
}

fn crop_tile(
    ffmpeg: &OsStr,
    source: &Path,
    x: i64,
    width: i64,
    height: i64,
    output: &Path,
    timeout: Duration,
) -> Result<()> {
    let args = [
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        source.as_os_str().to_owned(),
        OsString::from("-vf"),
        OsString::from(format!("crop={width}:{height}:{x}:0")),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-c:v"),
        OsString::from("mjpeg"),
        OsString::from("-q:v"),
        OsString::from("4"),
        OsString::from("-f"),
        OsString::from("image2"),
        OsString::from("-y"),
        output.as_os_str().to_owned(),
    ];
    let result = execute_with_timeout(ffmpeg, &args, timeout)
        .map_err(|error| CoreError::Ocr(format!("裁剪胶片条帧失败：{error}")))?;
    if !result.success {
        return Err(command_failure("ffmpeg 裁剪帧", &result));
    }
    let metadata = std::fs::metadata(output)?;
    if metadata.len() == 0 {
        return Err(CoreError::Ocr("裁剪产物为空".to_owned()));
    }
    Ok(())
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
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
    CoreError::Ocr(format!(
        "{label} 失败（退出码 {}）：{}",
        output
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_owned()),
        if summary.is_empty() { "没有错误输出" } else { &summary }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_success_line() {
        let line = r#"{"path":"/a.png","texts":[{"text":"旅剪","confidence":0.9,"bbox":[0.1,0.2,0.3,0.4]}]}"#
            .to_owned();
        let parsed = parse_lines(&[line]).unwrap();
        assert_eq!(parsed.len(), 1);
        let (path, hits) = &parsed[0];
        assert_eq!(path, &PathBuf::from("/a.png"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "旅剪");
        assert_eq!(hits[0].confidence, 0.9);
        assert_eq!(hits[0].bbox, [0.1, 0.2, 0.3, 0.4]);
    }

    #[test]
    fn parses_an_error_line_as_an_empty_hit_list_not_a_failure() {
        let line = r#"{"path":"/bad.png","error":"cannot decode image"}"#.to_owned();
        let parsed = parse_lines(&[line]).unwrap();
        assert_eq!(parsed.len(), 1);
        let (path, hits) = &parsed[0];
        assert_eq!(path, &PathBuf::from("/bad.png"));
        assert!(hits.is_empty());
    }

    #[test]
    fn rejects_malformed_json_with_an_err_not_a_panic() {
        let line = "{not json".to_owned();
        let error = parse_lines(&[line]).unwrap_err();
        assert!(matches!(error, CoreError::Ocr(_)));
    }

    #[test]
    fn skips_blank_lines() {
        let parsed = parse_lines(&["".to_owned(), "   ".to_owned()]).unwrap();
        assert!(parsed.is_empty());
    }

    #[test]
    fn empty_input_returns_empty_output_without_touching_the_tool() {
        let result = recognize_with(None, &[]).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn missing_tool_is_an_err() {
        let error = recognize_with(None, &[PathBuf::from("/some/image.png")]).unwrap_err();
        assert!(matches!(error, CoreError::Ocr(_)));
    }

    #[test]
    fn resolve_tool_from_finds_nothing_when_every_candidate_is_absent() {
        let missing_dir = std::env::temp_dir().join("tripcut-ocr-test-no-such-dir");
        let resolved = resolve_tool_from(
            Some("/definitely/not/a/real/path/sidecar-ocr".into()),
            Some(missing_dir.join("fake-exe")),
            Some(missing_dir.into_os_string()),
        );
        assert!(resolved.is_none());
    }

    #[test]
    fn resolve_tool_from_prefers_the_env_override_when_it_is_a_real_file() {
        // Use this test binary itself as a stand-in "tool" file — resolution
        // only checks `is_file()`, it does not execute the candidate.
        let self_path = std::env::current_exe().unwrap();
        let resolved = resolve_tool_from(Some(self_path.clone().into_os_string()), None, None);
        assert_eq!(resolved, Some(self_path));
    }

    /// Builds the real tool (if `swiftc` is available) into the dev cache
    /// directory and runs it end-to-end against the committed fixture image,
    /// expecting both `旅剪` and `TripCut` in the recognized text. Skips
    /// cleanly (prints and returns) when `swiftc` or the built tool is
    /// unavailable, so CI machines without Command Line Tools don't fail.
    #[test]
    fn recognizes_the_fixture_image_end_to_end() {
        if which("swiftc").is_none() {
            eprintln!("skipping: swiftc not available");
            return;
        }
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .expect("src-tauri has a parent directory")
            .to_path_buf();
        let build_script = repo_root.join("scripts/build-sidecar-ocr.sh");
        let fixture = manifest_dir.join("tests/fixtures/ocr/zh-en.png");
        if !build_script.is_file() || !fixture.is_file() {
            eprintln!("skipping: build script or fixture image missing");
            return;
        }

        let status = Command::new("zsh")
            .arg(&build_script)
            .status()
            .expect("spawn build-sidecar-ocr.sh");
        if !status.success() {
            eprintln!("skipping: build-sidecar-ocr.sh failed ({status:?})");
            return;
        }

        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipping: no HOME to locate the dev cache tool");
            return;
        };
        let tool = PathBuf::from(home)
            .join("Library/Caches/tripcut-build/sidecar-ocr/out/sidecar-ocr");
        if !tool.is_file() {
            eprintln!("skipping: built tool not found at {}", tool.display());
            return;
        }

        let result = recognize_with(Some(tool), &[fixture]);
        let hits = result.expect("recognize should succeed against the fixture");
        assert_eq!(hits.len(), 1);
        let (_path, texts) = &hits[0];
        let joined = texts
            .iter()
            .map(|hit| hit.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined.contains("旅剪"), "OCR 输出应包含「旅剪」，实际：{joined}");
        assert!(joined.contains("TripCut"), "OCR 输出应包含「TripCut」，实际：{joined}");
    }

    fn which(name: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
    }

    // -----------------------------------------------------------------
    // R5 Task 5：run_ocr_scan / enqueue_after_strip / global_search 第五路
    // -----------------------------------------------------------------

    use crate::core::db;
    use crate::core::jobs::JobStatus;
    use crate::core::test_support::TestDirectory;

    fn open_test_db() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        (directory, connection)
    }

    fn seed_clip(
        connection: &Connection,
        clip_id: i64,
        quick_hash: &str,
        duration_ticks: i64,
        tb_num: i64,
        tb_den: i64,
    ) {
        connection
            .execute("INSERT OR IGNORE INTO volumes(uuid) VALUES ('v')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash, duration_ticks, tb_num, tb_den)
                 VALUES (?1, 'v', ?2, ?3, ?4, ?5, ?6)",
                params![clip_id, format!("{clip_id}.mov"), quick_hash, duration_ticks, tb_num, tb_den],
            )
            .unwrap();
    }

    fn seed_strip_artifact(connection: &Connection, clip_id: i64, quick_hash: &str, rel_path: &str) {
        connection
            .execute(
                "INSERT INTO cache_artifacts(clip_id, kind, rel_path, source_hash, bytes, created_at)
                 VALUES (?1, 'strip', ?2, ?3, 100, 'now')",
                params![clip_id, rel_path, quick_hash],
            )
            .unwrap();
    }

    fn seed_running_ocr_job(connection: &Connection, payload: &OcrScanPayload) -> Job {
        let payload_json = serde_json::to_string(payload).unwrap();
        connection
            .execute(
                "INSERT INTO jobs(kind, payload, payload_hash, status, attempt, created_at, updated_at)
                 VALUES ('ocr_scan', ?1, ?2, 'running', 1, 'now', 'now')",
                params![payload_json, format!("job-{}", payload.clip_id)],
            )
            .unwrap();
        Job {
            id: connection.last_insert_rowid(),
            kind: "ocr_scan".to_owned(),
            payload: payload_json,
            status: JobStatus::Running,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        }
    }

    fn build_strip_image(path: &Path, width: i64, height: i64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let status = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi"])
            .arg("-i")
            .arg(format!("testsrc2=size={width}x{height}:rate=1"))
            .args(["-frames:v", "1", "-y"])
            .arg(path)
            .status()
            .expect("spawn ffmpeg to build the fixture strip");
        assert!(status.success(), "ffmpeg 生成测试用胶片条失败");
    }

    fn write_ocr_stub(path: &Path, script: &str) {
        std::fs::write(path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }
    }

    fn test_ffmpeg_and_ffprobe() -> (std::ffi::OsString, std::ffi::OsString) {
        let connection = Connection::open_in_memory().unwrap();
        let ffmpeg = super::super::settings::configured_executable(
            &connection,
            super::super::settings::FFMPEG_PATH_KEY,
            "FFMPEG_PATH",
            "ffmpeg",
        )
        .unwrap();
        let ffprobe = super::super::settings::configured_ffprobe(&connection, &ffmpeg).unwrap();
        (ffmpeg, ffprobe)
    }

    #[test]
    fn enqueue_after_strip_enqueues_ocr_scan_exactly_once() {
        let (directory, mut connection) = open_test_db();
        seed_clip(&connection, 1, "hash-1", 2_000, 1, 1_000);
        seed_strip_artifact(&connection, 1, "hash-1", "1/strip.jpg");
        let strip_payload = super::super::artifacts::ArtifactJobPayload {
            clip_id: 1,
            path: "/does/not/matter.mov".to_owned(),
            source_hash: "hash-1".to_owned(),
        };
        let strip_job = Job {
            id: 1,
            kind: "strip".to_owned(),
            payload: serde_json::to_string(&strip_payload).unwrap(),
            status: JobStatus::Done,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        };
        let cache_root = directory.path().join("cache");

        enqueue_after_strip(&mut connection, &strip_job, &cache_root).unwrap();
        enqueue_after_strip(&mut connection, &strip_job, &cache_root).unwrap();

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE kind = 'ocr_scan'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "同一 clip/source_hash 的 ocr_scan 只应入队一次");
    }

    #[test]
    fn enqueue_after_strip_ignores_other_job_kinds() {
        let (_directory, mut connection) = open_test_db();
        seed_clip(&connection, 1, "hash-1", 2_000, 1, 1_000);
        seed_strip_artifact(&connection, 1, "hash-1", "1/strip.jpg");
        let waveform_payload = super::super::artifacts::ArtifactJobPayload {
            clip_id: 1,
            path: "/does/not/matter.mov".to_owned(),
            source_hash: "hash-1".to_owned(),
        };
        let waveform_job = Job {
            id: 1,
            kind: "waveform".to_owned(),
            payload: serde_json::to_string(&waveform_payload).unwrap(),
            status: JobStatus::Done,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        };
        enqueue_after_strip(&mut connection, &waveform_job, Path::new("/cache")).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE kind = 'ocr_scan'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn run_ocr_scan_inserts_a_row_per_distinct_frame_text() {
        let (directory, mut connection) = open_test_db();
        seed_clip(&connection, 1, "hash-1", 2_000, 1, 1_000);
        let cache_root = directory.path().join("cache");
        let strip_path = cache_root.join("1/strip.jpg");
        build_strip_image(&strip_path, 320, 100);

        let payload = OcrScanPayload {
            clip_id: 1,
            source_hash: "hash-1".to_owned(),
            strip_path: strip_path.to_string_lossy().into_owned(),
            strip_frame_count: 2,
            duration_ticks: 2_000,
            tb_num: 1,
            tb_den: 1_000,
        };
        let job = seed_running_ocr_job(&connection, &payload);

        let stub = directory.path().join("fake-sidecar-ocr");
        write_ocr_stub(
            &stub,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *frame-0*) printf '{"path":"%s","texts":[{"text":"旅剪","confidence":0.9,"bbox":[0,0,0.2,0.2]}]}\n' "$line" ;;
    *frame-1*) printf '{"path":"%s","texts":[{"text":"TripCut","confidence":0.8,"bbox":[0,0,0.2,0.2]}]}\n' "$line" ;;
    *) printf '{"path":"%s","texts":[]}\n' "$line" ;;
  esac
done
exit 0
"#,
        );

        let (ffmpeg, ffprobe) = test_ffmpeg_and_ffprobe();
        run_ocr_scan_with(&mut connection, &job, &cache_root, &ffmpeg, &ffprobe, Some(stub)).unwrap();

        let mut statement = connection
            .prepare("SELECT frame_tick, text FROM clip_ocr_texts WHERE clip_id = 1 ORDER BY frame_tick")
            .unwrap();
        let rows: Vec<(i64, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows, vec![(0, "旅剪".to_owned()), (1_000, "TripCut".to_owned())]);

        let job_status: String = connection
            .query_row("SELECT status FROM jobs WHERE id = ?1", [job.id], |row| row.get(0))
            .unwrap();
        assert_eq!(job_status, "done");
    }

    #[test]
    fn run_ocr_scan_dedupes_identical_text_across_adjacent_frames() {
        let (directory, mut connection) = open_test_db();
        seed_clip(&connection, 1, "hash-1", 2_000, 1, 1_000);
        let cache_root = directory.path().join("cache");
        let strip_path = cache_root.join("1/strip.jpg");
        build_strip_image(&strip_path, 320, 100);

        let payload = OcrScanPayload {
            clip_id: 1,
            source_hash: "hash-1".to_owned(),
            strip_path: strip_path.to_string_lossy().into_owned(),
            strip_frame_count: 2,
            duration_ticks: 2_000,
            tb_num: 1,
            tb_den: 1_000,
        };
        let job = seed_running_ocr_job(&connection, &payload);

        let stub = directory.path().join("fake-sidecar-ocr");
        write_ocr_stub(
            &stub,
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '{"path":"%s","texts":[{"text":"HELLO","confidence":0.9,"bbox":[0,0,0.2,0.2]}]}\n' "$line"
done
exit 0
"#,
        );

        let (ffmpeg, ffprobe) = test_ffmpeg_and_ffprobe();
        run_ocr_scan_with(&mut connection, &job, &cache_root, &ffmpeg, &ffprobe, Some(stub)).unwrap();

        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM clip_ocr_texts WHERE clip_id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1, "相邻帧的相同文字必须去重，只留第一次出现");
        let text: String = connection
            .query_row(
                "SELECT text FROM clip_ocr_texts WHERE clip_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(text, "HELLO");
    }

    #[test]
    fn run_ocr_scan_with_missing_tool_is_a_deterministic_ocr_error() {
        let (directory, mut connection) = open_test_db();
        seed_clip(&connection, 1, "hash-1", 2_000, 1, 1_000);
        let cache_root = directory.path().join("cache");
        let strip_path = cache_root.join("1/strip.jpg");
        build_strip_image(&strip_path, 320, 100);

        let payload = OcrScanPayload {
            clip_id: 1,
            source_hash: "hash-1".to_owned(),
            strip_path: strip_path.to_string_lossy().into_owned(),
            strip_frame_count: 2,
            duration_ticks: 2_000,
            tb_num: 1,
            tb_den: 1_000,
        };
        let job = seed_running_ocr_job(&connection, &payload);
        let (ffmpeg, ffprobe) = test_ffmpeg_and_ffprobe();

        let error = run_ocr_scan_with(&mut connection, &job, &cache_root, &ffmpeg, &ffprobe, None)
            .unwrap_err();
        assert!(is_missing_tool_error(&error), "缺工具的错误应能被识别为确定性错误");

        // 这一步复刻 `jobs::run_one_with_owner` 对 ocr_scan 分支的路由：
        // 确定性错误直接 blocked，不烧重试次数。
        jobs::mark_blocked_deterministic(&mut connection, job.id, job.attempt, &error.to_string())
            .unwrap();
        let (status, summary): (String, Option<String>) = connection
            .query_row(
                "SELECT status, blocked_summary FROM jobs WHERE id = ?1",
                [job.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "blocked");
        assert!(summary.unwrap().contains("组件未安装"), "blocked_summary 应带上「OCR 组件未安装」");
    }

    #[test]
    fn list_hits_returns_rows_ordered_by_frame_tick() {
        let (_directory, connection) = open_test_db();
        connection
            .execute("INSERT OR IGNORE INTO volumes(uuid) VALUES ('v')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path) VALUES (1, 'v', 'a.mov')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clip_ocr_texts(clip_id, frame_tick, tb_num, tb_den, text, confidence, bbox_json, created_at)
                 VALUES (1, 1000, 1, 1000, 'second', 0.5, '[0.0,0.0,0.1,0.1]', 'now'),
                        (1, 0, 1, 1000, 'first', 0.9, '[0.0,0.0,0.1,0.1]', 'now')",
                [],
            )
            .unwrap();
        let hits = list_hits(&connection, 1).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].text, "first");
        assert_eq!(hits[1].text, "second");
        assert_eq!(hits[0].bbox, [0.0, 0.0, 0.1, 0.1]);
    }
}
