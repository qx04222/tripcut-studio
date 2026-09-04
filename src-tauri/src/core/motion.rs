use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::Job;

pub const MOTION_SAMPLE_FPS: usize = 2;
pub const ZOOM_CORRELATION_THRESHOLD: f64 = 0.6;
pub const STATIC_MOTION_THRESHOLD: f64 = 0.5;
pub const DIRECTION_COHERENCE_THRESHOLD: f64 = 0.7;
const MOTION_WIDTH: usize = 160;
const MOTION_HEIGHT: usize = 160;
const BLOCK_SIZE: usize = 16;
const GRID_SIZE: usize = 8;
const SEARCH_RADIUS: isize = 8;
const GRID_ORIGIN: usize = (MOTION_WIDTH - BLOCK_SIZE * GRID_SIZE) / 2;
const FRAME_BYTES: usize = MOTION_WIDTH * MOTION_HEIGHT;
const MOTION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
// v5：shake_score 从"帧间差分绝对 RMS"改为"轨迹高频能量占比"（见
// `high_freq_energy_ratio`），量纲和取值范围都变了（新的是 [0,1] 比例，
// 旧的是像素量纲的绝对值）；旧版本算出的 clip_motion 行必须用新算法重跑，
// 否则会拿旧量纲的分数去和新的 DEFAULT_JITTER_THRESHOLD 比较。版本号变化会让
// `enqueue_missing` 把它们重新入队。
const TOOL_VERSION: &str = "analyze_motion/v5";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipMotion {
    pub clip_id: i64,
    pub class: String,
    pub pan_ratio: f64,
    pub tilt_ratio: f64,
    pub zoom_corr: f64,
    pub shake_score: f64,
    pub is_shaky: bool,
    pub sample_pairs: i64,
    pub tool_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnalyzeMotionPayload {
    clip_id: i64,
    path: String,
    quick_hash: String,
}

#[derive(Debug, Clone)]
struct MotionSource {
    clip_id: i64,
    path: PathBuf,
    quick_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct MotionVector {
    dx: f64,
    dy: f64,
}

#[derive(Debug, Clone)]
struct PairMotion {
    global: MotionVector,
    zoom_corr: f64,
    residual_rms: f64,
}

struct CommandOutput<T = Vec<u8>> {
    success: bool,
    code: Option<i32>,
    stdout: T,
    stderr: Vec<u8>,
}

pub fn enqueue_missing(connection: &mut Connection) -> Result<usize> {
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT c.id, c.quick_hash
             FROM clips c
             LEFT JOIN clip_motion motion ON motion.clip_id = c.id
             WHERE c.missing_since IS NULL AND c.quick_hash IS NOT NULL
               AND (
                 motion.clip_id IS NULL
                 OR motion.tool_version NOT LIKE ?1
               )
             ORDER BY c.id",
        )?;
        let version_prefix = format!("{TOOL_VERSION}%");
        let rows = statement.query_map([version_prefix], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut enqueued = 0;
    for (clip_id, quick_hash) in candidates {
        let Ok(path) = super::media_source::verified_clip_path(connection, clip_id) else {
            // 离线卷不因升级运镜特征而变成失败任务；卷重新挂载后下次启动再排队。
            continue;
        };
        if enqueue_for_clip(connection, clip_id, &path, &quick_hash)?.is_some() {
            enqueued += 1;
        }
    }
    Ok(enqueued)
}

pub fn enqueue_for_clip(
    connection: &mut Connection,
    clip_id: i64,
    path: &Path,
    quick_hash: &str,
) -> Result<Option<i64>> {
    let payload = AnalyzeMotionPayload {
        clip_id,
        path: path.to_string_lossy().into_owned(),
        quick_hash: quick_hash.to_owned(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Motion(format!("无法创建运镜分析任务：{error}")))?;
    let payload_hash = blake3::hash(
        format!("analyze_motion\0{clip_id}\0{quick_hash}\0{TOOL_VERSION}").as_bytes(),
    )
    .to_hex()
    .to_string();

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = transaction
        .query_row(
            "SELECT id FROM jobs
             WHERE kind = 'analyze_motion' AND payload_hash = ?1
               AND (
                   status IN ('pending', 'running')
                   OR (status = 'done' AND EXISTS(
                       SELECT 1 FROM clip_motion WHERE clip_id = ?2
                   ))
               )
             LIMIT 1",
            params![payload_hash, clip_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if existing.is_some() {
        transaction.commit()?;
        return Ok(None);
    }
    transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            'analyze_motion', ?1, ?2, 'pending', 0,
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

pub fn run_analyze_motion(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: AnalyzeMotionPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Motion(format!("运镜分析任务数据无效：{error}")))?;
    let mut source = load_source(connection, &payload)?;
    source.path = super::media_source::verified_clip_path(connection, payload.clip_id)
        .map_err(|error| CoreError::Motion(error.to_string()))?;
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let jitter_threshold = super::settings::number_value(
        connection,
        super::settings::JITTER_THRESHOLD_KEY,
        super::settings::DEFAULT_JITTER_THRESHOLD,
    )?
    .clamp(0.0, 1.0);
    let mut motion = analyze_video(&source.path, &ffmpeg)?;
    motion.clip_id = source.clip_id;
    motion.is_shaky = shake_is_flagged(motion.shake_score, jitter_threshold);
    motion.tool_version = format!(
        "{};jitter_threshold={jitter_threshold:.6} | {}",
        motion.tool_version,
        tool_version(&ffmpeg)?
    );
    persist_motion(connection, &source, &motion)
}

pub fn get_clip_motion(connection: &Connection, clip_id: i64) -> Result<Option<ClipMotion>> {
    let jitter_threshold = super::settings::number_value(
        connection,
        super::settings::JITTER_THRESHOLD_KEY,
        super::settings::DEFAULT_JITTER_THRESHOLD,
    )?
    .clamp(0.0, 1.0);
    connection
        .query_row(
            "SELECT clip_id, class, pan_ratio, tilt_ratio, zoom_corr,
                    shake_score, sample_pairs, tool_version
             FROM clip_motion WHERE clip_id = ?1",
            [clip_id],
            |row| {
                let shake_score = row.get(5)?;
                Ok(ClipMotion {
                    clip_id: row.get(0)?,
                    class: row.get(1)?,
                    pan_ratio: row.get(2)?,
                    tilt_ratio: row.get(3)?,
                    zoom_corr: row.get(4)?,
                    shake_score,
                    is_shaky: shake_is_flagged(shake_score, jitter_threshold),
                    sample_pairs: row.get(6)?,
                    tool_version: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(CoreError::from)
}

fn load_source(connection: &Connection, payload: &AnalyzeMotionPayload) -> Result<MotionSource> {
    connection
        .query_row(
            "SELECT 1 FROM clips WHERE id = ?1 AND quick_hash = ?2",
            params![payload.clip_id, payload.quick_hash],
            |_| {
                Ok(MotionSource {
                    clip_id: payload.clip_id,
                    path: PathBuf::from(&payload.path),
                    quick_hash: payload.quick_hash.clone(),
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::Motion(format!(
                "素材 {} 已变化或不存在，拒绝写入旧运镜分析",
                payload.clip_id
            ))
        })
}

fn gray_frame_args(path: &Path) -> Vec<OsString> {
    let filter = format!(
        "fps={MOTION_SAMPLE_FPS},scale={MOTION_WIDTH}:{MOTION_HEIGHT}:force_original_aspect_ratio=increase,crop={MOTION_WIDTH}:{MOTION_HEIGHT},format=gray"
    );
    vec![
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        path.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-an"),
        OsString::from("-vf"),
        OsString::from(filter),
        OsString::from("-pix_fmt"),
        OsString::from("gray"),
        OsString::from("-f"),
        OsString::from("rawvideo"),
        OsString::from("-"),
    ]
}

fn analyze_video(path: &Path, ffmpeg: &OsStr) -> Result<ClipMotion> {
    let output = execute_with_reader(ffmpeg, &gray_frame_args(path), MOTION_TIMEOUT, analyze_frame_stream)
        .map_err(|error| CoreError::Motion(format!("提取运镜采样帧失败：{error}")))?;
    if !output.success {
        return Err(command_failure("ffmpeg 运镜采样", &output));
    }
    aggregate_motion(&output.stdout?)
}

// Keep only two raw frames; the compact pair metrics preserve median, endpoint
// and per-second evidence exactly, including for long clips.
fn analyze_frame_stream(mut reader: impl Read) -> std::io::Result<Result<Vec<PairMotion>>> {
    let mut previous = vec![0_u8; FRAME_BYTES];
    let mut current = vec![0_u8; FRAME_BYTES];
    let mut pairs = Vec::new();
    let mut have_previous = false;
    loop {
        let mut filled = 0;
        while filled < FRAME_BYTES {
            match reader.read(&mut current[filled..]) {
                Ok(0) => break,
                Ok(count) => filled += count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        if filled == 0 {
            break;
        }
        if filled != FRAME_BYTES {
            return Ok(Err(CoreError::Motion(format!(
                "灰度采样帧不完整：{filled} 字节，期望 {FRAME_BYTES}"
            ))));
        }
        if have_previous {
            match estimate_pair(&previous, &current) {
                Ok(pair) => pairs.push(pair),
                Err(error) => return Ok(Err(error)),
            }
        }
        std::mem::swap(&mut previous, &mut current);
        have_previous = true;
    }
    if pairs.is_empty() {
        return Ok(Err(CoreError::Motion("运镜分析至少需要 2 个采样帧".to_owned())));
    }
    Ok(Ok(pairs))
}

#[cfg(test)]
fn extract_gray_frames(path: &Path, ffmpeg: &OsStr) -> Result<Vec<Vec<u8>>> {
    let args = gray_frame_args(path);
    let output = execute_with_timeout(ffmpeg, &args, MOTION_TIMEOUT)
        .map_err(|error| CoreError::Motion(format!("提取运镜采样帧失败：{error}")))?;
    if !output.success {
        return Err(command_failure("ffmpeg 运镜采样", &output));
    }
    if output.stdout.len() % FRAME_BYTES != 0 {
        return Err(CoreError::Motion(format!(
            "灰度采样帧字节数异常：{} 不能整除单帧 {FRAME_BYTES}",
            output.stdout.len()
        )));
    }
    let frames = output
        .stdout
        .chunks(FRAME_BYTES).filter(|c| c.len() == FRAME_BYTES)
        .map(|frame| frame.to_vec())
        .collect::<Vec<_>>();
    if frames.len() < 2 {
        return Err(CoreError::Motion(format!(
            "运镜分析至少需要 2 个采样帧，实际得到 {}",
            frames.len()
        )));
    }
    Ok(frames)
}

#[cfg(test)]
fn analyze_frames(frames: &[Vec<u8>]) -> Result<ClipMotion> {
    if frames.len() < 2 || frames.iter().any(|frame| frame.len() != FRAME_BYTES) {
        return Err(CoreError::Motion("运镜采样帧数量或尺寸无效".to_owned()));
    }
    let pairs = frames
        .windows(2)
        .map(|pair| estimate_pair(&pair[0], &pair[1]))
        .collect::<Result<Vec<_>>>()?;
    aggregate_motion(&pairs)
}

fn estimate_pair(previous: &[u8], next: &[u8]) -> Result<PairMotion> {
    if previous.len() != FRAME_BYTES || next.len() != FRAME_BYTES {
        return Err(CoreError::Motion("块匹配输入帧尺寸无效".to_owned()));
    }

    let mut vectors = Vec::with_capacity(GRID_SIZE * GRID_SIZE);
    let offsets = search_offsets();
    for row in 0..GRID_SIZE {
        for column in 0..GRID_SIZE {
            let x = GRID_ORIGIN + column * BLOCK_SIZE;
            let y = GRID_ORIGIN + row * BLOCK_SIZE;
            vectors.push(best_block_vector(previous, next, x, y, offsets));
        }
    }

    let global = MotionVector {
        dx: median(vectors.iter().map(|vector| vector.dx).collect()),
        dy: median(vectors.iter().map(|vector| vector.dy).collect()),
    };
    let center_x = (MOTION_WIDTH as f64 - 1.0) / 2.0;
    let center_y = (MOTION_HEIGHT as f64 - 1.0) / 2.0;
    let mut radial_dot = 0.0;
    let mut residual_energy = 0.0;
    let mut radial_energy = 0.0;
    for (index, vector) in vectors.iter().enumerate() {
        let row = index / GRID_SIZE;
        let column = index % GRID_SIZE;
        let block_center_x = (GRID_ORIGIN + column * BLOCK_SIZE) as f64
            + (BLOCK_SIZE as f64 - 1.0) / 2.0;
        let block_center_y = (GRID_ORIGIN + row * BLOCK_SIZE) as f64
            + (BLOCK_SIZE as f64 - 1.0) / 2.0;
        let radial_x = block_center_x - center_x;
        let radial_y = block_center_y - center_y;
        let residual_x = vector.dx - global.dx;
        let residual_y = vector.dy - global.dy;
        radial_dot += residual_x * radial_x + residual_y * radial_y;
        residual_energy += residual_x * residual_x + residual_y * residual_y;
        radial_energy += radial_x * radial_x + radial_y * radial_y;
    }
    let zoom_corr = if residual_energy <= f64::EPSILON || radial_energy <= f64::EPSILON {
        0.0
    } else {
        (radial_dot / (residual_energy * radial_energy).sqrt()).clamp(-1.0, 1.0)
    };
    let residual_rms = (residual_energy / vectors.len() as f64).sqrt();
    Ok(PairMotion {
        global,
        zoom_corr,
        residual_rms,
    })
}

fn search_offsets() -> &'static [(isize, isize)] {
    static OFFSETS: OnceLock<Vec<(isize, isize)>> = OnceLock::new();
    OFFSETS.get_or_init(|| {
        let mut offsets = (-SEARCH_RADIUS..=SEARCH_RADIUS)
            .flat_map(|dy| (-SEARCH_RADIUS..=SEARCH_RADIUS).map(move |dx| (dx, dy)))
            .collect::<Vec<_>>();
        offsets.sort_by_key(|(dx, dy)| (dx.abs() + dy.abs(), dy.abs(), dx.abs(), *dy, *dx));
        offsets
    })
}

fn best_block_vector(
    previous: &[u8],
    next: &[u8],
    x: usize,
    y: usize,
    offsets: &[(isize, isize)],
) -> MotionVector {
    let mut best_sad = u64::MAX;
    let mut best_dx = 0_isize;
    let mut best_dy = 0_isize;

    for &(dx, dy) in offsets {
        let candidate_x = (x as isize + dx) as usize;
        let candidate_y = (y as isize + dy) as usize;
        let mut sad = 0_u64;
        'pixels: for block_y in 0..BLOCK_SIZE {
            let previous_offset = (y + block_y) * MOTION_WIDTH + x;
            let next_offset = (candidate_y + block_y) * MOTION_WIDTH + candidate_x;
            for block_x in 0..BLOCK_SIZE {
                sad += u8::abs_diff(
                    previous[previous_offset + block_x],
                    next[next_offset + block_x],
                ) as u64;
                if sad > best_sad {
                    break 'pixels;
                }
            }
        }
        let distance = dx.abs() + dy.abs();
        let best_distance = best_dx.abs() + best_dy.abs();
        if sad < best_sad || (sad == best_sad && distance < best_distance) {
            best_sad = sad;
            best_dx = dx;
            best_dy = dy;
            // SAD cannot be negative. Offsets are ordered by distance, so a
            // later exact match cannot improve the original tie-break rule.
            if sad == 0 {
                break;
            }
        }
    }

    MotionVector {
        dx: best_dx as f64,
        dy: best_dy as f64,
    }
}

fn aggregate_motion(pairs: &[PairMotion]) -> Result<ClipMotion> {
    if pairs.is_empty() {
        return Err(CoreError::Motion("没有可聚合的运镜帧对".to_owned()));
    }
    let pair_count = pairs.len() as f64;
    let mean_abs_dx = pairs.iter().map(|pair| pair.global.dx.abs()).sum::<f64>() / pair_count;
    let mean_abs_dy = pairs.iter().map(|pair| pair.global.dy.abs()).sum::<f64>() / pair_count;
    let mean_magnitude = pairs
        .iter()
        .map(|pair| pair.global.dx.hypot(pair.global.dy))
        .sum::<f64>()
        / pair_count;
    let pan_ratio = coherent_axis_ratio(pairs, true);
    let tilt_ratio = coherent_axis_ratio(pairs, false);
    let zoom_corr = median(pairs.iter().map(|pair| pair.zoom_corr).collect());
    let shake_score = high_freq_energy_ratio(pairs);
    let endpoint_span = pairs.len().div_ceil(3).max(1);
    let start_shake = high_freq_energy_ratio(&pairs[..endpoint_span.min(pairs.len())]);
    let end_shake = high_freq_energy_ratio(&pairs[pairs.len().saturating_sub(endpoint_span)..]);
    let residual_rms = pairs.iter().map(|pair| pair.residual_rms).sum::<f64>() / pair_count;
    let direction_coherence = coherent_direction_ratio(pairs);
    let second_shake = per_second_shake_scores(pairs)
        .into_iter()
        .map(|score| format!("{score:.6}"))
        .collect::<Vec<_>>()
        .join(",");

    let class = if zoom_corr.abs() > ZOOM_CORRELATION_THRESHOLD {
        "zoom"
    } else if mean_magnitude < STATIC_MOTION_THRESHOLD {
        "static"
    } else if mean_abs_dx > mean_abs_dy && pan_ratio > DIRECTION_COHERENCE_THRESHOLD {
        "pan"
    } else if mean_abs_dy > mean_abs_dx && tilt_ratio > DIRECTION_COHERENCE_THRESHOLD {
        "tilt"
    } else {
        // 剩余运动均不满足静止、径向缩放或 70% 同向约束；高频/残差值保留为
        // handheld 的解释证据，低频但方向不一致的未知运动也保守落入此类。
        debug_assert!(shake_score.is_finite() && residual_rms.is_finite());
        "handheld"
    };

    Ok(ClipMotion {
        clip_id: 0,
        class: class.to_owned(),
        pan_ratio: pan_ratio.clamp(0.0, 1.0),
        tilt_ratio: tilt_ratio.clamp(0.0, 1.0),
        zoom_corr: zoom_corr.clamp(-1.0, 1.0),
        shake_score: shake_score.max(0.0),
        is_shaky: shake_is_flagged(shake_score, super::settings::DEFAULT_JITTER_THRESHOLD),
        sample_pairs: pairs.len() as i64,
        tool_version: format!(
            "{TOOL_VERSION};mean_magnitude={mean_magnitude:.6};residual_rms={residual_rms:.6};direction_coherence={direction_coherence:.6};start_shake={start_shake:.6};end_shake={end_shake:.6};second_shake={second_shake}"
        ),
    })
}

fn per_second_shake_scores(pairs: &[PairMotion]) -> Vec<f64> {
    if pairs.is_empty() {
        return Vec::new();
    }
    let seconds = pairs.len().div_ceil(MOTION_SAMPLE_FPS);
    (0..seconds)
        .map(|second| {
            let start = second.saturating_mul(MOTION_SAMPLE_FPS).saturating_sub(1);
            let end = ((second + 1) * MOTION_SAMPLE_FPS + 1).min(pairs.len());
            high_freq_energy_ratio(&pairs[start..end])
        })
        .collect()
}

/// 滑动平均窗口大小（帧对，奇数、居中），用作轨迹的低通近似：
/// 摇镜/推拉这类"运镜意图"在此窗口内几乎不变，残差因而被算作高频。
const HIGH_FREQ_WINDOW: usize = 3;

/// 相机运动轨迹的高频能量占比：以滑动平均取轨迹的低通（运镜意图）分量，
/// 残差（轨迹 - 低通）即高频分量；返回残差能量占轨迹总能量的比例，范围 [0,1]。
///
/// 摇镜哪怕速度快，只要速度平滑，帧间残差相对总位移能量也很小，比例趋近 0；
/// 手持抖动的帧间随机扰动本身就占了轨迹能量的大头，比例明显更高。用比例（而非
/// 绝对值）是关键：老算法 `motion_jitter` 直接用帧间差分的绝对 RMS 作为分数，
/// 快速摇镜哪怕匀速也会因位移绝对值大而被摊高（尤其是加减速阶段），与手持抖动
/// 混淆；除以总能量后，摇镜的分子分母同时变大，比例反而被压低。
///
/// 实测标定（2026-09-02，真实素材：cherokee_falls_drone 航拍、bangkok_walk /
/// dubai_walk 手持街拍；一次性用带 `#[ignore]` 的临时测试跑出下列数值后已移除
/// 该测试，数值原样保留在此。仓库内可复现的合成对照见本文件测试
/// `ffmpeg_locked_off_crop_scores_far_below_jitter_threshold` /
/// `ffmpeg_random_high_freq_crop_scores_far_above_jitter_threshold` /
/// `ffmpeg_pan_stays_below_random_jitter_even_when_faster`）：
///
/// - 航拍原片（无额外抖动）：ratio 0.0006–0.0054；单帧 loop 静止样本：ratio = 0.0
/// - 真实手持街拍原片（无额外抖动）：ratio 0.09–0.45（越接近走路实拍越高，本身就有
///   真实抖动，不是"稳定"对照组）
/// - 建议方案里给的 `crop=...:20+10*sin(n*2):20+10*cos(n*3)` 在真实素材上实测**不可用**：
///   该正弦扰动的角频率在原生 30/60fps 下约 9–19Hz，远超过 `MOTION_SAMPLE_FPS=2`
///   采样时 1Hz 的奈奎斯特上限，混叠后落到哪个表观频率纯属运气——对同一素材"加抖
///   前/加抖后"的比例有涨有跌，5 组里 2 组反而下降，不能用来标定阈值。改用按源分辨
///   率百分比取幅度的随机裁切 `crop=iw*0.9:ih*0.9:iw*0.05*(1+random(0)):ih*0.05*(1+random(1))`
///   （幅度经 160px 分析分辨率缩放后落在 SEARCH_RADIUS=8 量级，且是宽带随机扰动，
///   不会因固定频率而被整体混叠掉）后，5 组"加抖前/加抖后"全部单调上升：
///   0.0006→0.55、0.026→0.59、0.22→0.46、0.45→0.74、0.11→0.39（同一素材同一 5 秒
///   时间窗对比，避免整段 vs 截断造成的时间窗不一致）。
///
/// 稳定簇（航拍原片 + 静止样本，≤0.03）与明显抖动簇（重手持原片/任意素材叠加随机
/// 高频抖动，≥0.22）之间有清晰间隔，阈值取 0.15（见 `DEFAULT_JITTER_THRESHOLD`），
/// 落在间隔中段偏稳定一侧，让温和手持（如 dubai 原片 0.09–0.11）仍判非抖，更明显的
/// 手持/合成抖动判为抖。
fn high_freq_energy_ratio(pairs: &[PairMotion]) -> f64 {
    if pairs.len() < HIGH_FREQ_WINDOW {
        return 0.0;
    }
    let dx = pairs.iter().map(|pair| pair.global.dx).collect::<Vec<_>>();
    let dy = pairs.iter().map(|pair| pair.global.dy).collect::<Vec<_>>();
    let low_dx = moving_average(&dx, HIGH_FREQ_WINDOW);
    let low_dy = moving_average(&dy, HIGH_FREQ_WINDOW);

    let mut total_energy = 0.0;
    let mut high_energy = 0.0;
    for i in 0..pairs.len() {
        total_energy += dx[i] * dx[i] + dy[i] * dy[i];
        let high_dx = dx[i] - low_dx[i];
        let high_dy = dy[i] - low_dy[i];
        high_energy += high_dx * high_dx + high_dy * high_dy;
    }
    // 轨迹总能量过低（近乎静止）时比例在数值上不稳定（分母接近 0），
    // 且此时无论比例多少都谈不上"抖"——静止画面的传感器噪声不该被判成手持抖动。
    let floor = STATIC_MOTION_THRESHOLD * STATIC_MOTION_THRESHOLD * pairs.len() as f64;
    if total_energy <= floor {
        return 0.0;
    }
    (high_energy / total_energy).clamp(0.0, 1.0)
}

fn moving_average(values: &[f64], window: usize) -> Vec<f64> {
    let half = window / 2;
    let n = values.len();
    (0..n)
        .map(|i| {
            let lo = i.saturating_sub(half);
            let hi = (i + half).min(n.saturating_sub(1));
            let slice = &values[lo..=hi];
            slice.iter().sum::<f64>() / slice.len() as f64
        })
        .collect()
}

fn shake_is_flagged(shake_score: f64, jitter_threshold: f64) -> bool {
    shake_score.is_finite()
        && jitter_threshold.is_finite()
        && shake_score > jitter_threshold.max(0.0)
}

fn coherent_direction_ratio(pairs: &[PairMotion]) -> f64 {
    let moving = pairs
        .iter()
        .filter(|pair| pair.global.dx.hypot(pair.global.dy) >= STATIC_MOTION_THRESHOLD)
        .collect::<Vec<_>>();
    if moving.is_empty() {
        return 0.0;
    }
    let mean = MotionVector {
        dx: moving.iter().map(|pair| pair.global.dx).sum::<f64>() / moving.len() as f64,
        dy: moving.iter().map(|pair| pair.global.dy).sum::<f64>() / moving.len() as f64,
    };
    if mean.dx.hypot(mean.dy) < STATIC_MOTION_THRESHOLD {
        return 0.0;
    }
    moving
        .iter()
        .filter(|pair| pair.global.dx * mean.dx + pair.global.dy * mean.dy > 0.0)
        .count() as f64
        / moving.len() as f64
}

fn coherent_axis_ratio(pairs: &[PairMotion], horizontal: bool) -> f64 {
    let mut positive = 0_usize;
    let mut negative = 0_usize;
    for pair in pairs {
        let primary = if horizontal { pair.global.dx } else { pair.global.dy };
        let secondary = if horizontal { pair.global.dy } else { pair.global.dx };
        if primary.abs() <= secondary.abs() || primary.abs() < STATIC_MOTION_THRESHOLD {
            continue;
        }
        if primary > 0.0 {
            positive += 1;
        } else {
            negative += 1;
        }
    }
    positive.max(negative) as f64 / pairs.len() as f64
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

fn persist_motion(
    connection: &mut Connection,
    source: &MotionSource,
    motion: &ClipMotion,
) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = transaction
        .query_row(
            "SELECT 1 FROM clips WHERE id = ?1 AND quick_hash = ?2",
            params![source.clip_id, source.quick_hash],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !current {
        return Err(CoreError::Motion(format!(
            "素材 {} 在运镜分析期间发生变化，未写入结果",
            source.clip_id
        )));
    }
    transaction.execute(
        "INSERT INTO clip_motion(
            clip_id, class, pan_ratio, tilt_ratio, zoom_corr,
            shake_score, sample_pairs, tool_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(clip_id) DO UPDATE SET
            class = excluded.class,
            pan_ratio = excluded.pan_ratio,
            tilt_ratio = excluded.tilt_ratio,
            zoom_corr = excluded.zoom_corr,
            shake_score = excluded.shake_score,
            sample_pairs = excluded.sample_pairs,
            tool_version = excluded.tool_version",
        params![
            source.clip_id,
            motion.class,
            motion.pan_ratio,
            motion.tilt_ratio,
            motion.zoom_corr,
            motion.shake_score,
            motion.sample_pairs,
            motion.tool_version,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

fn tool_version(executable: &OsStr) -> Result<String> {
    let output = execute_with_timeout(
        executable,
        &[OsString::from("-version")],
        TOOL_TIMEOUT,
    )
    .map_err(|error| CoreError::Motion(format!("读取 ffmpeg 版本失败：{error}")))?;
    if !output.success {
        return Err(command_failure("读取 ffmpeg 版本", &output));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::to_owned)
        .ok_or_else(|| CoreError::Motion("ffmpeg 版本输出为空".to_owned()))
}

fn command_failure<T>(label: &str, output: &CommandOutput<T>) -> CoreError {
    let summary = String::from_utf8_lossy(&output.stderr)
        .trim()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(1200)
        .collect::<String>();
    CoreError::Motion(format!(
        "{label} 失败（退出码 {}）：{}",
        output
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_owned()),
        if summary.is_empty() { "没有错误输出" } else { &summary }
    ))
}

fn execute_with_timeout(
    executable: &OsStr,
    args: &[OsString],
    timeout: Duration,
) -> std::io::Result<CommandOutput> {
    execute_with_reader(executable, args, timeout, |pipe| read_pipe(Some(pipe)))
}

fn execute_with_reader<T: Send + 'static>(
    executable: &OsStr,
    args: &[OsString],
    timeout: Duration,
    read_stdout: impl FnOnce(ChildStdout) -> std::io::Result<T> + Send + 'static,
) -> std::io::Result<CommandOutput<T>> {
    let mut command = Command::new(executable);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // A configured executable may be a wrapper. Kill its process group on
    // cancellation/timeout so inherited pipes cannot keep readers alive.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take();
    let (stdout_sender, stdout_receiver) = std::sync::mpsc::channel();
    let (stderr_sender, stderr_receiver) = std::sync::mpsc::channel();
    thread::spawn(move || { let _ = stdout_sender.send(read_stdout(stdout)); });
    thread::spawn(move || { let _ = stderr_sender.send(read_pipe(stderr)); });
    let started = Instant::now();
    let mut status = None;
    let mut stdout = None;
    let mut stderr = None;
    loop {
        let interrupted = super::jobs::current_cancellation_requested();
        if interrupted || started.elapsed() >= timeout {
            terminate_command(&mut child);
            return Err(std::io::Error::new(
                if interrupted { std::io::ErrorKind::Interrupted } else { std::io::ErrorKind::TimedOut },
                if interrupted { "用户已取消".to_owned() } else { format!("命令超过 {} 秒未完成", timeout.as_secs()) },
            ));
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(next) => status = next,
                Err(error) => { terminate_command(&mut child); return Err(error); }
            }
        }
        if stdout.is_none() {
            match stdout_receiver.try_recv() {
                Ok(Ok(value)) => stdout = Some(value),
                Ok(Err(error)) => { terminate_command(&mut child); return Err(error); }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    terminate_command(&mut child);
                    return Err(std::io::Error::other("stdout reader thread panicked"));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        if stderr.is_none() {
            match stderr_receiver.try_recv() {
                Ok(Ok(value)) => stderr = Some(value),
                Ok(Err(error)) => { terminate_command(&mut child); return Err(error); }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    terminate_command(&mut child);
                    return Err(std::io::Error::other("stderr reader thread panicked"));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        match (status, stdout, stderr) {
            (Some(exit), Some(output), Some(errors)) => return Ok(CommandOutput {
                success: exit.success(), code: exit.code(), stdout: output, stderr: errors,
            }),
            (exit, output, errors) => { status = exit; stdout = output; stderr = errors; }
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn terminate_command(child: &mut Child) {
    #[cfg(unix)]
    // SAFETY: this child was spawned into a fresh process group whose id is
    // its positive pid. This never targets TripCut's own process group.
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
}

fn read_pipe<R: Read>(pipe: Option<R>) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut bytes)?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};

    use super::*;
    use crate::core::migrations::{MIGRATION_0001, MIGRATION_0007, MIGRATION_0008};
    use crate::core::test_support::TestDirectory;

    fn motion_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection.execute_batch(MIGRATION_0001).unwrap();
        connection.execute_batch(MIGRATION_0007).unwrap();
        connection.execute_batch(MIGRATION_0008).unwrap();
        connection
    }

    fn insert_source(connection: &Connection, path: &Path, quick_hash: &str) -> MotionSource {
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('motion-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, quick_hash)
                 VALUES ('motion-volume', ?1, ?2)",
                params![path.to_string_lossy(), quick_hash],
            )
            .unwrap();
        MotionSource {
            clip_id: connection.last_insert_rowid(),
            path: path.to_path_buf(),
            quick_hash: quick_hash.to_owned(),
        }
    }

    fn patterned_frame() -> Vec<u8> {
        let mut frame = vec![0_u8; FRAME_BYTES];
        for y in 0..MOTION_HEIGHT {
            for x in 0..MOTION_WIDTH {
                frame[y * MOTION_WIDTH + x] =
                    ((x * 19 + y * 37 + x * y + (x / 7) * 53) % 251) as u8;
            }
        }
        frame
    }

    fn translated_frame(source: &[u8], dx: isize, dy: isize) -> Vec<u8> {
        let mut target = vec![0_u8; FRAME_BYTES];
        for y in 0..MOTION_HEIGHT {
            for x in 0..MOTION_WIDTH {
                let target_x = x as isize + dx;
                let target_y = y as isize + dy;
                if (0..MOTION_WIDTH as isize).contains(&target_x)
                    && (0..MOTION_HEIGHT as isize).contains(&target_y)
                {
                    target[target_y as usize * MOTION_WIDTH + target_x as usize] =
                        source[y * MOTION_WIDTH + x];
                }
            }
        }
        target
    }

    fn pair(dx: f64, dy: f64, zoom_corr: f64, residual_rms: f64) -> PairMotion {
        PairMotion {
            global: MotionVector { dx, dy },
            zoom_corr,
            residual_rms,
        }
    }

    fn fixture_motion() -> ClipMotion {
        ClipMotion {
            clip_id: 1,
            class: "handheld".to_owned(),
            pan_ratio: 0.25,
            tilt_ratio: 0.2,
            zoom_corr: -0.12,
            shake_score: 3.5,
            is_shaky: true,
            sample_pairs: 5,
            tool_version: "fixture/v1".to_owned(),
        }
    }

    fn ffmpeg_available() -> bool {
        Command::new(test_ffmpeg())
            .arg("-version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn generate_fixture(path: &Path, filter: &str) -> bool {
        Command::new(test_ffmpeg())
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", filter])
            .args(["-t", "3", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p"])
            .arg(path)
            .status()
            .is_ok_and(|status| status.success())
    }

    fn analyze_fixture(filter: &str, name: &str) -> Option<ClipMotion> {
        if !ffmpeg_available() {
            eprintln!("skipping motion fixture: ffmpeg unavailable");
            return None;
        }
        let directory = TestDirectory::new();
        let path = directory.path().join(name);
        if !generate_fixture(&path, filter) {
            eprintln!("skipping motion fixture: encoder/filter unavailable");
            return None;
        }
        let frames = extract_gray_frames(&path, &test_ffmpeg()).unwrap();
        let streamed = analyze_video(&path, &test_ffmpeg()).unwrap();
        assert_eq!(streamed, analyze_frames(&frames).unwrap());
        Some(streamed)
    }

    const FIXED_PATTERN: &str =
        "nullsrc=size=360x280:rate=30:duration=3,geq=lum='mod(X*19+Y*37+X*Y,220)+16':cb=128:cr=128";

    fn test_ffmpeg() -> OsString {
        let connection = Connection::open_in_memory().unwrap();
        super::super::settings::configured_executable(
            &connection,
            super::super::settings::FFMPEG_PATH_KEY,
            "FFMPEG_PATH",
            "ffmpeg",
        )
        .unwrap()
    }

    #[test]
    fn streamed_short_reads_preserve_all_motion_evidence() {
        struct ShortReads(std::io::Cursor<Vec<u8>>);
        impl Read for ShortReads {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                let count = bytes.len().min(97);
                self.0.read(&mut bytes[..count])
            }
        }
        let first = patterned_frame();
        let frames = vec![first.clone(), translated_frame(&first, 3, -2), first.clone(), first];
        let pairs = analyze_frame_stream(ShortReads(std::io::Cursor::new(frames.concat()))).unwrap().unwrap();
        assert_eq!(aggregate_motion(&pairs).unwrap(), analyze_frames(&frames).unwrap());
    }

    #[test]
    fn streamed_empty_single_and_truncated_frames_are_rejected() {
        for size in [0, FRAME_BYTES, FRAME_BYTES * 2 + 1] {
            assert!(analyze_frame_stream(std::io::Cursor::new(vec![0; size])).unwrap().is_err());
        }
    }

    #[test]
    fn streaming_decoder_timeout_reaps_the_process() {
        let started = Instant::now();
        let result = execute_with_reader(
            OsStr::new("/bin/sh"),
            &[OsString::from("-c"), OsString::from("exec sleep 5")],
            Duration::from_millis(40), analyze_frame_stream,
        );
        assert_eq!(result.err().unwrap().kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn reader_deadline_applies_after_child_exit() {
        let started = Instant::now();
        let result = execute_with_reader(OsStr::new("/usr/bin/true"), &[], Duration::from_millis(40), |_| {
            thread::sleep(Duration::from_millis(300));
            Ok(Vec::<u8>::new())
        });
        assert_eq!(result.err().unwrap().kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(250));
    }

    #[cfg(unix)]
    #[test]
    fn inherited_wrapper_pipes_cannot_defeat_deadline() {
        let started = Instant::now();
        let result = execute_with_reader(OsStr::new("/bin/sh"),
            &[OsString::from("-c"), OsString::from("sleep 5 & exit 0")],
            Duration::from_millis(60), analyze_frame_stream);
        assert_eq!(result.err().unwrap().kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn block_matching_recovers_global_translation() {
        let previous = patterned_frame();
        let next = translated_frame(&previous, 5, -3);

        let estimated = estimate_pair(&previous, &next).unwrap();
        assert_eq!(estimated.global, MotionVector { dx: 5.0, dy: -3.0 });
        assert!(estimated.residual_rms < 0.01);
    }

    #[test]
    fn aggregate_persists_start_and_end_shake_for_best_take_explanation() {
        let motion = aggregate_motion(&[
            pair(0.0, 0.0, 0.0, 0.1),
            pair(0.1, 0.0, 0.0, 0.1),
            pair(0.2, 0.0, 0.0, 0.1),
            pair(1.0, 0.0, 0.0, 0.1),
            pair(2.0, 0.0, 0.0, 0.1),
            pair(3.5, 0.0, 0.0, 0.1),
        ])
        .unwrap();

        assert!(motion.tool_version.contains("start_shake="));
        assert!(motion.tool_version.contains("end_shake="));
        assert!(motion.tool_version.contains("second_shake="));
    }

    #[test]
    fn per_second_shake_keeps_temporal_variation_for_rescue_windows() {
        // 首尾各放一对高频抖动尖峰，中段留 6 对完全静止的帧对；per_second 的窗口
        // 会在秒边界各向外多取 1 对做padding，所以只有离首尾足够远的中间窗口才能
        // 完全避开两端尖峰的污染——用它验证"平静段分数明显低于两端"。
        let scores = per_second_shake_scores(&[
            pair(8.0, 0.0, 0.0, 0.1),
            pair(-8.0, 0.0, 0.0, 0.1),
            pair(0.0, 0.0, 0.0, 0.1),
            pair(0.0, 0.0, 0.0, 0.1),
            pair(0.0, 0.0, 0.0, 0.1),
            pair(0.0, 0.0, 0.0, 0.1),
            pair(0.0, 0.0, 0.0, 0.1),
            pair(0.0, 0.0, 0.0, 0.1),
            pair(8.0, 0.0, 0.0, 0.1),
            pair(-8.0, 0.0, 0.0, 0.1),
        ]);

        assert_eq!(scores.len(), 5);
        let calm_window = scores[2];
        assert_eq!(calm_window, 0.0);
        assert!(calm_window < scores[0]);
        assert!(calm_window < scores[4]);
    }

    #[test]
    fn static_pairs_classify_static() {
        let result = aggregate_motion(&[
            pair(0.0, 0.0, 0.0, 0.0),
            pair(0.0, 0.0, 0.0, 0.0),
        ])
        .unwrap();
        assert_eq!(result.class, "static");
        assert_eq!(result.shake_score, 0.0);
    }

    #[test]
    fn coherent_horizontal_pairs_classify_pan() {
        let result = aggregate_motion(&[
            pair(2.0, 0.0, 0.0, 0.0),
            pair(3.0, 0.0, 0.0, 0.0),
            pair(2.0, 0.0, 0.0, 0.0),
            pair(2.0, 0.0, 0.0, 0.0),
        ])
        .unwrap();
        assert_eq!(result.class, "pan");
        assert_eq!(result.pan_ratio, 1.0);
    }

    #[test]
    fn coherent_vertical_pairs_classify_tilt() {
        let result = aggregate_motion(&[
            pair(0.0, -2.0, 0.0, 0.0),
            pair(0.0, -3.0, 0.0, 0.0),
            pair(0.0, -2.0, 0.0, 0.0),
            pair(0.0, -2.0, 0.0, 0.0),
        ])
        .unwrap();
        assert_eq!(result.class, "tilt");
        assert_eq!(result.tilt_ratio, 1.0);
    }

    #[test]
    fn radial_correlation_classifies_zoom_before_static_translation() {
        let result = aggregate_motion(&[
            pair(0.0, 0.0, 0.82, 2.0),
            pair(0.0, 0.0, 0.79, 2.2),
            pair(0.0, 0.0, 0.84, 2.1),
        ])
        .unwrap();
        assert_eq!(result.class, "zoom");
        assert!(result.zoom_corr > ZOOM_CORRELATION_THRESHOLD);
    }

    #[test]
    fn inconsistent_high_frequency_motion_classifies_handheld() {
        let result = aggregate_motion(&[
            pair(4.0, -1.0, 0.0, 0.2),
            pair(-3.0, 4.0, 0.0, 0.2),
            pair(2.0, -4.0, 0.0, 0.2),
            pair(-4.0, 1.0, 0.0, 0.2),
        ])
        .unwrap();
        assert_eq!(result.class, "handheld");
        assert!(result.shake_score >= crate::core::settings::DEFAULT_JITTER_THRESHOLD);
    }

    #[test]
    fn raw_metrics_stay_inside_schema_ranges() {
        let result = aggregate_motion(&[
            pair(3.0, 0.0, 0.25, 0.4),
            pair(3.0, 0.0, 0.3, 0.5),
        ])
        .unwrap();
        assert!((0.0..=1.0).contains(&result.pan_ratio));
        assert!((0.0..=1.0).contains(&result.tilt_ratio));
        assert!((-1.0..=1.0).contains(&result.zoom_corr));
        assert!(result.shake_score >= 0.0);
        assert_eq!(result.sample_pairs, 2);
    }

    #[test]
    fn persistence_is_idempotent_and_round_trips_raw_evidence() {
        let mut connection = motion_connection();
        let source = insert_source(&connection, Path::new("motion.mov"), "motion-hash");
        let mut expected = fixture_motion();
        expected.clip_id = source.clip_id;

        persist_motion(&mut connection, &source, &expected).unwrap();
        expected.shake_score = 4.25;
        persist_motion(&mut connection, &source, &expected).unwrap();

        let stored = get_clip_motion(&connection, source.clip_id).unwrap().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM clip_motion", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(stored, expected);
    }

    #[test]
    fn persisted_jitter_threshold_controls_the_shake_decision() {
        let mut connection = motion_connection();
        let source = insert_source(&connection, Path::new("threshold.mov"), "threshold-hash");
        let mut motion = fixture_motion();
        motion.clip_id = source.clip_id;
        motion.shake_score = 1.0;
        persist_motion(&mut connection, &source, &motion).unwrap();

        crate::core::settings::set_setting(
            &connection,
            crate::core::settings::JITTER_THRESHOLD_KEY,
            "0.5",
        )
        .unwrap();
        assert!(get_clip_motion(&connection, source.clip_id)
            .unwrap()
            .unwrap()
            .is_shaky);

        crate::core::settings::set_setting(
            &connection,
            crate::core::settings::JITTER_THRESHOLD_KEY,
            "1.5",
        )
        .unwrap();
        assert!(!get_clip_motion(&connection, source.clip_id)
            .unwrap()
            .unwrap()
            .is_shaky);
    }

    #[test]
    fn changed_source_hash_prevents_stale_motion_write() {
        let mut connection = motion_connection();
        let source = insert_source(&connection, Path::new("changed.mov"), "before");
        connection
            .execute(
                "UPDATE clips SET quick_hash = 'after' WHERE id = ?1",
                [source.clip_id],
            )
            .unwrap();

        let error = persist_motion(&mut connection, &source, &fixture_motion()).unwrap_err();
        assert!(error.to_string().contains("发生变化"));
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM clip_motion", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn analyze_motion_enqueue_is_idempotent_for_source_hash() {
        let mut connection = motion_connection();
        let source = insert_source(&connection, Path::new("queued.mov"), "queued");

        let first = enqueue_for_clip(
            &mut connection,
            source.clip_id,
            &source.path,
            &source.quick_hash,
        )
        .unwrap();
        let second = enqueue_for_clip(
            &mut connection,
            source.clip_id,
            &source.path,
            &source.quick_hash,
        )
        .unwrap();
        assert!(first.is_some());
        assert!(second.is_none());
    }

    #[test]
    fn ffmpeg_static_test_pattern_classifies_static() {
        let filter = "testsrc=size=360x280:rate=30:duration=1,select='eq(n,0)',loop=loop=89:size=1:start=0,setpts=N/30/TB,crop=240:180:x=60:y=50";
        let Some(result) = analyze_fixture(filter, "static.mp4") else { return };
        assert_eq!(result.class, "static");
    }

    #[test]
    fn ffmpeg_crop_window_classifies_pan() {
        let filter = format!(
            "{FIXED_PATTERN},crop=240:180:x='60+min(36,n/15*3)':y=50"
        );
        let Some(result) = analyze_fixture(&filter, "pan.mp4") else { return };
        assert_eq!(result.class, "pan");
        assert!(result.pan_ratio > DIRECTION_COHERENCE_THRESHOLD);
    }

    #[test]
    fn ffmpeg_crop_window_classifies_tilt() {
        let filter = format!(
            "{FIXED_PATTERN},crop=240:180:x=60:y='50+min(36,n/15*3)'"
        );
        let Some(result) = analyze_fixture(&filter, "tilt.mp4") else { return };
        assert_eq!(result.class, "tilt");
        assert!(result.tilt_ratio > DIRECTION_COHERENCE_THRESHOLD);
    }

    #[test]
    fn ffmpeg_scale_sequence_classifies_zoom() {
        let filter = format!(
            "{FIXED_PATTERN},zoompan=z='1+0.002*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=240x180:fps=30"
        );
        let Some(result) = analyze_fixture(&filter, "zoom.mp4") else { return };
        assert_eq!(result.class, "zoom");
        assert!(result.zoom_corr.abs() > ZOOM_CORRELATION_THRESHOLD);
    }

    #[test]
    fn ffmpeg_random_crop_sequence_classifies_handheld() {
        let filter = format!(
            "{FIXED_PATTERN},crop=240:180:x='60+6*sin(n*0.37)':y='50+6*sin(n*0.61)'"
        );
        let Some(result) = analyze_fixture(&filter, "handheld.mp4") else { return };
        assert_eq!(result.class, "handheld");
        assert!(result.shake_score >= crate::core::settings::DEFAULT_JITTER_THRESHOLD);
    }

    #[test]
    fn incomplete_raw_frame_is_rejected_without_guessing() {
        let error = analyze_frames(&[vec![0; FRAME_BYTES], vec![0; 7]]).unwrap_err();
        assert!(error.to_string().contains("尺寸无效"));
    }

    // 稳定 / 抖动对照回归测试。
    //
    // 用真实素材（cherokee_falls_drone 航拍、bangkok_walk / dubai_walk 手持街拍）实测
    // 标定过 `high_freq_energy_ratio` 与 `DEFAULT_JITTER_THRESHOLD`（数值见
    // `high_freq_energy_ratio` 与 `DEFAULT_JITTER_THRESHOLD` 顶部注释），但真实素材文件
    // 不在仓库里，不能作为 CI 回归用例。这里用 lavfi 合成的静止裁切 vs.
    // `random()` 高频随机裁切抖动重现同一对比，随 CI 稳定可跑。
    //
    // 标定过程中的一个关键教训：最初按建议用 `crop=...:20+10*sin(n*2):20+10*cos(n*3)`
    // 在真实素材上叠加抖动，结果对同一素材"加抖前/加抖后"的抖动分有涨有跌，
    // 跌的情况占了小一半——不是判据错，是这个正弦抖动的角频率（原生 30/60fps 下约
    // 9–19Hz）远超过 MOTION_SAMPLE_FPS=2 采样时 1Hz 的奈奎斯特上限，混叠后落到哪个
    // 表观频率纯属运气，且像素幅度（±10px 源分辨率）经 160px 分析分辨率缩放后往往
    // 小于 1px，被块匹配的量化噪声淹没。换成按源分辨率百分比取幅度（这里
    // `iw*0.9`/`ih*0.9` 裁切 + 各边距 5% 内的 `random()` 偏移，缩放后落在
    // SEARCH_RADIUS=8 量级）之后，5 段真实素材的"加抖前/加抖后"全部单调上升
    // （0.0/0.03/0.22/0.45/0.11 → 0.55/0.59/0.46/0.74/0.39），才据此确认判据有效。
    const STABLE_JITTER_CROP: &str = "crop=iw*0.9:ih*0.9:iw*0.05*(1+random(0)):ih*0.05*(1+random(1))";

    #[test]
    fn ffmpeg_locked_off_crop_scores_far_below_jitter_threshold() {
        let filter = format!("{FIXED_PATTERN},crop=240:180:x=60:y=50");
        let Some(result) = analyze_fixture(&filter, "stable_ratio.mp4") else { return };
        assert_eq!(result.class, "static");
        assert!(!result.is_shaky);
        assert!(result.shake_score < crate::core::settings::DEFAULT_JITTER_THRESHOLD / 2.0);
    }

    #[test]
    fn ffmpeg_random_high_freq_crop_scores_far_above_jitter_threshold() {
        let filter = format!("{FIXED_PATTERN},{STABLE_JITTER_CROP}");
        let Some(result) = analyze_fixture(&filter, "jitter_ratio.mp4") else { return };
        assert!(result.shake_score > crate::core::settings::DEFAULT_JITTER_THRESHOLD * 2.0);
        assert!(shake_is_flagged(
            result.shake_score,
            crate::core::settings::DEFAULT_JITTER_THRESHOLD
        ));
    }

    #[test]
    fn ffmpeg_pan_stays_below_random_jitter_even_when_faster() {
        // 摇镜哪怕速度比抖动样本快得多，只要轨迹平滑，高频能量占比也应远低于
        // 真正的随机高频抖动——这是"比例"判据区别于老的绝对帧间差分 RMS 判据的
        // 核心诉求，必须直接对照验证，不能只看各自是否过阈值。
        let pan_filter = format!("{FIXED_PATTERN},crop=240:180:x='60+min(72,n/6*3)':y=50");
        let Some(pan) = analyze_fixture(&pan_filter, "fast_pan.mp4") else { return };
        let jitter_filter = format!("{FIXED_PATTERN},{STABLE_JITTER_CROP}");
        let Some(jitter) = analyze_fixture(&jitter_filter, "jitter_ratio_cmp.mp4") else { return };

        assert_eq!(pan.class, "pan");
        assert!(pan.shake_score < jitter.shake_score);
        assert!(pan.shake_score < crate::core::settings::DEFAULT_JITTER_THRESHOLD);
    }
}
