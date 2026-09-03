use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::error::{CoreError, Result};
use super::jobs::Job;

pub const SCENE_THRESHOLD: f64 = 0.35;
pub const DARK_YAVG_THRESHOLD: f64 = 40.0;
// 过曝判定基于 YHIGH(90 百分位亮度)而非 YMAX(整帧最亮的单个像素)。
// 实测教训:任何画面里有一处高光(天空/路灯/反光/字幕白字)YMAX 就到 255,
// 用 YMAX 判过曝会把正常街景全部误判(实测真实素材误判率接近 100%)。
// 真过曝的特征是大片像素接近白位,即 90 百分位仍然很高。
// 实测标定:limited-range 纯白样本 YHIGH=235;正常街景/海滩/瀑布素材 YHIGH=179-198。
pub const OVEREXPOSED_YHIGH_THRESHOLD: f64 = 225.0;
// 且整帧平均亮度也偏高,排除「暗背景+大面积高光物体」的正常构图。
// 实测:正常素材 YAVG 68-116,纯白样本 235。
pub const OVEREXPOSED_YAVG_THRESHOLD: f64 = 170.0;
// 超过该比例的每秒采样帧同时满足以上两条时标为过曝。
pub const OVEREXPOSED_RATIO_THRESHOLD: f64 = 0.15;
// 待 S4 校准：缩放到固定分析尺寸后的 Laplacian 方差。
pub const SOFT_FOCUS_THRESHOLD: f64 = 60.0;
// blurdetect(Marziliano 边缘宽度法)的模糊度:越大越糊。
// 实测标定:正常街景/航拍素材 4.0-6.3。对焦失败会显著高于此。
pub const BLUR_THRESHOLD: f64 = 9.0;
// 低纹理守卫:熵低于此值时画面本身没有边缘(纯色墙/天空/雾),
// 模糊度判据在这类画面上不可信,直接跳过虚焦判定。
pub const LOW_ENTROPY_GUARD: f64 = 4.5;
// 运动守卫:vmafmotion.score 高说明画面在动(运动模糊,可能可接受),
// 低才是相机基本静止时的对焦失败。实测:静止帧≈0,正常手持运镜 60+。
pub const MOTION_BLUR_GUARD: f64 = 25.0;
// 欠曝:10 百分位贴近黑位且整帧偏暗。
pub const UNDEREXPOSED_YLOW_THRESHOLD: f64 = 16.0;
pub const UNDEREXPOSED_YAVG_THRESHOLD: f64 = 60.0;
// 广播范围溢出像素占比(BRNG),直接量化过曝/欠曝的面积。
pub const BRNG_RATIO_THRESHOLD: f64 = 0.25;
pub const AUDIO_CLIP_PEAK_DB: f64 = -0.1;

const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const FOCUS_FRAME_TIMEOUT: Duration = Duration::from_secs(60);
const FOCUS_WIDTH: usize = 320;
const FOCUS_HEIGHT: usize = 180;
// v3:过曝判据从 YMAX(整帧最亮单像素,误判率近 100%)换成 YHIGH+YAVG 联合;
// 新增欠曝/动态范围/虚焦(blurdetect+运动+纹理三重守卫)。
// 版本号变化会让旧结果被 enqueue_missing 重新排队重算。
const ANALYSIS_PIPELINE_VERSION: &str = "analyze_l1/v3";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClipAnalysis {
    pub clip_id: i64,
    pub exposure_yavg: f64,
    pub overexposed_ratio: f64,
    pub audio_peak_db: Option<f64>,
    pub audio_clipped: bool,
    pub has_audio: bool,
    pub focus_scores: Vec<f64>,
    pub scene_count: i64,
    pub analyzed_at: String,
    pub tool_versions: Value,
    pub underexposed_ratio: f64,
    pub dynamic_range: f64,
    pub blur_mean: f64,
    pub entropy_mean: f64,
    pub motion_mean: f64,
    pub out_of_focus_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnalyzeL1Payload {
    clip_id: i64,
    path: String,
    quick_hash: String,
}

#[derive(Debug, Clone)]
struct ClipSource {
    clip_id: i64,
    path: PathBuf,
    quick_hash: String,
    tb_num: i64,
    tb_den: i64,
    duration_ticks: i64,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedSignals {
    scene_cuts: Vec<i64>,
    exposure_yavg: f64,
    overexposed_ratio: f64,
    underexposed_ratio: f64,
    dynamic_range: f64,
    blur_mean: f64,
    entropy_mean: f64,
    motion_mean: f64,
    out_of_focus_ratio: f64,
    audio_peak_db: Option<f64>,
    audio_dynamic_range_db: Option<f64>,
    audio_clipped: bool,
    has_audio: bool,
}

#[derive(Debug, Clone)]
struct AnalysisComputation {
    signals: ParsedSignals,
    focus_scores: Vec<f64>,
    tool_versions: Value,
}

struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// 把分析结果版本落后于当前流水线的素材重新排队。
/// 算法换代(如过曝判据从 YMAX 换成 YHIGH)后,已导入素材必须重算,
/// 否则界面上仍是旧算法的误判结果。
pub fn enqueue_missing(connection: &mut Connection) -> Result<usize> {
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT c.id, c.rel_path, c.quick_hash
             FROM clips c
             LEFT JOIN clip_analysis a ON a.clip_id = c.id
             WHERE c.missing_since IS NULL AND c.quick_hash IS NOT NULL
               AND (
                 a.clip_id IS NULL
                 OR COALESCE(json_extract(a.tool_versions, '$.pipeline'), '') != ?1
               )
             ORDER BY c.id",
        )?;
        let rows = statement.query_map([ANALYSIS_PIPELINE_VERSION], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut enqueued = 0;
    for (clip_id, rel_path, quick_hash) in candidates {
        let path = PathBuf::from(&rel_path);
        // 外置盘素材(相对路径)在重连前无法重算,跳过而不是报错。
        if !path.is_absolute() {
            continue;
        }
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
    let payload = AnalyzeL1Payload {
        clip_id,
        path: path.to_string_lossy().into_owned(),
        quick_hash: quick_hash.to_owned(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Analysis(format!("无法创建 L1 分析任务：{error}")))?;
    let payload_hash = blake3::hash(
        format!("analyze_l1\0{clip_id}\0{quick_hash}\0{ANALYSIS_PIPELINE_VERSION}").as_bytes(),
    )
    .to_hex()
    .to_string();

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = transaction
        .query_row(
            "SELECT id FROM jobs
             WHERE kind = 'analyze_l1' AND payload_hash = ?1
               AND (
                   status IN ('pending', 'running')
                   OR (status = 'done' AND EXISTS(
                       SELECT 1 FROM clip_analysis WHERE clip_id = ?2
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
            'analyze_l1', ?1, ?2, 'pending', 0,
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

pub fn run_analyze_l1(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: AnalyzeL1Payload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Analysis(format!("L1 分析任务数据无效：{error}")))?;
    let mut source = load_source(connection, &payload)?;
    source.path = super::media_source::verified_clip_path(connection, payload.clip_id)
        .map_err(|error| CoreError::Analysis(error.to_string()))?;
    let ffmpeg = crate::core::settings::configured_executable(
        connection,
        crate::core::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let ffprobe = crate::core::settings::configured_ffprobe(connection, &ffmpeg)?;
    let scene_threshold = crate::core::settings::number_value(
        connection,
        crate::core::settings::SCENE_THRESHOLD_KEY,
        SCENE_THRESHOLD,
    )?
    .clamp(0.0, 1.0);
    let computation = analyze_source(&source, &ffmpeg, &ffprobe, scene_threshold)?;
    persist_analysis(connection, &source, &computation)?;
    super::motion::enqueue_for_clip(
        connection,
        source.clip_id,
        &source.path,
        &source.quick_hash,
    )?;
    super::transcribe::enqueue_for_clip(
        connection,
        source.clip_id,
        &source.path,
        &source.quick_hash,
    )?;
    Ok(())
}

pub fn get_clip_analysis(connection: &Connection, clip_id: i64) -> Result<Option<ClipAnalysis>> {
    let row = connection
        .query_row(
            "SELECT clip_id, exposure_yavg, overexposed_ratio, audio_peak_db,
                    audio_clipped, has_audio, focus_scores, scene_count,
                    analyzed_at, tool_versions,
                    underexposed_ratio, dynamic_range, blur_mean, entropy_mean,
                    motion_mean, out_of_focus_ratio
             FROM clip_analysis WHERE clip_id = ?1",
            [clip_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, f64>(10)?,
                    row.get::<_, f64>(11)?,
                    row.get::<_, f64>(12)?,
                    row.get::<_, f64>(13)?,
                    row.get::<_, f64>(14)?,
                    row.get::<_, f64>(15)?,
                ))
            },
        )
        .optional()?;
    row.map(analysis_from_row).transpose()
}

#[allow(clippy::type_complexity)]
fn analysis_from_row(
    row: (
        i64,
        f64,
        f64,
        Option<f64>,
        i64,
        i64,
        String,
        i64,
        String,
        String,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
    ),
) -> Result<ClipAnalysis> {
    let focus_scores = serde_json::from_str(&row.6)
        .map_err(|error| CoreError::InvalidSchema(format!("focus_scores JSON 无效：{error}")))?;
    let tool_versions = serde_json::from_str(&row.9)
        .map_err(|error| CoreError::InvalidSchema(format!("tool_versions JSON 无效：{error}")))?;
    Ok(ClipAnalysis {
        clip_id: row.0,
        exposure_yavg: row.1,
        overexposed_ratio: row.2,
        audio_peak_db: row.3,
        audio_clipped: row.4 == 1,
        has_audio: row.5 == 1,
        focus_scores,
        scene_count: row.7,
        analyzed_at: row.8,
        tool_versions,
        underexposed_ratio: row.10,
        dynamic_range: row.11,
        blur_mean: row.12,
        entropy_mean: row.13,
        motion_mean: row.14,
        out_of_focus_ratio: row.15,
    })
}

fn load_source(connection: &Connection, payload: &AnalyzeL1Payload) -> Result<ClipSource> {
    connection
        .query_row(
            "SELECT tb_num, tb_den, duration_ticks
             FROM clips WHERE id = ?1 AND quick_hash = ?2",
            params![payload.clip_id, payload.quick_hash],
            |row| {
                Ok(ClipSource {
                    clip_id: payload.clip_id,
                    path: PathBuf::from(&payload.path),
                    quick_hash: payload.quick_hash.clone(),
                    tb_num: row.get(0)?,
                    tb_den: row.get(1)?,
                    duration_ticks: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::Analysis(format!(
                "素材 {} 已变化或不存在，拒绝写入旧分析",
                payload.clip_id
            ))
        })
}

fn analyze_source(
    source: &ClipSource,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    scene_threshold: f64,
) -> Result<AnalysisComputation> {
    let has_audio = probe_has_audio(&source.path, ffprobe)?;
    // 一次解码拿全部粗筛信号:曝光(含 BRNG 溢出占比)、模糊度、纹理熵、运动能量。
    // 先降采样到 2fps/640 宽再堆滤镜——滤镜串联代价是相加的,全帧率堆滤镜会慢两个数量级,
    // 而筛素材这个任务对降采样后的统计精度不敏感(实测 20s 素材 0.55 秒跑完)。
    let filter = format!(
        "[0:v:0]split=2[scene_src][stats_src];\
         [scene_src]select='eq(n,0)+gt(scene,{scene_threshold})',showinfo[scene_out];\
         [stats_src]fps=2,scale=640:-2,format=yuv420p,\
         signalstats=stat=brng,blurdetect=radius=20,entropy,vmafmotion,\
         metadata=mode=print[stats_out]"
    );
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        source.path.as_os_str().to_owned(),
        OsString::from("-filter_complex"),
        OsString::from(filter),
        OsString::from("-map"),
        OsString::from("[scene_out]"),
        OsString::from("-an"),
        OsString::from("-f"),
        OsString::from("null"),
        OsString::from("-"),
        OsString::from("-map"),
        OsString::from("[stats_out]"),
        OsString::from("-an"),
        OsString::from("-f"),
        OsString::from("null"),
        OsString::from("-"),
    ];
    if has_audio {
        args.extend([
            OsString::from("-map"),
            OsString::from("0:a:0"),
            OsString::from("-vn"),
            OsString::from("-af"),
            OsString::from(
                "astats=metadata=1:reset=0:measure_overall=Peak_level+Peak_count+Dynamic_range",
            ),
            OsString::from("-f"),
            OsString::from("null"),
            OsString::from("-"),
        ]);
    }

    let output = execute_with_timeout(ffmpeg, &args, ANALYSIS_TIMEOUT).map_err(|error| {
        CoreError::Analysis(format!("ffmpeg 分析 {} 失败：{error}", source.path.display()))
    })?;
    if !output.success {
        return Err(command_failure("ffmpeg L1 分析", &output));
    }
    let mut log = String::from_utf8_lossy(&output.stderr).into_owned();
    log.push('\n');
    log.push_str(&String::from_utf8_lossy(&output.stdout));
    let signals = parse_signal_log(&log, has_audio)?;

    let duration_seconds = ticks_to_seconds(
        source.duration_ticks,
        source.tb_num,
        source.tb_den,
    )?;
    let focus_scores = [0.1_f64, 0.5, 0.9]
        .into_iter()
        .map(|position| extract_focus_score(&source.path, duration_seconds * position, ffmpeg))
        .collect::<Result<Vec<_>>>()?;

    let ffmpeg_version = tool_version(ffmpeg)?;
    let ffprobe_version = tool_version(ffprobe)?;
    let tool_versions = json!({
        "pipeline": ANALYSIS_PIPELINE_VERSION,
        "ffmpeg": ffmpeg_version,
        "ffprobe": ffprobe_version,
        "thresholds": {
            "scene": scene_threshold,
            "dark_yavg": DARK_YAVG_THRESHOLD,
            "overexposed_yhigh": OVEREXPOSED_YHIGH_THRESHOLD,
            "overexposed_yavg": OVEREXPOSED_YAVG_THRESHOLD,
            "overexposed_ratio": OVEREXPOSED_RATIO_THRESHOLD,
            "soft_focus": SOFT_FOCUS_THRESHOLD,
            "audio_clip_peak_db": AUDIO_CLIP_PEAK_DB
        },
        "preprocess": {
            "exposure_fps": 1,
            "focus_positions": [0.1, 0.5, 0.9],
            "focus_rgb_size": [FOCUS_WIDTH, FOCUS_HEIGHT],
            "focus_kernel": "3x3-laplacian-cross"
        },
        "signals": {
            "audio_dynamic_range_db": signals.audio_dynamic_range_db
        }
    });

    Ok(AnalysisComputation {
        signals,
        focus_scores,
        tool_versions,
    })
}

fn parse_signal_log(log: &str, has_audio: bool) -> Result<ParsedSignals> {
    let yavg = values_after(log, "lavfi.signalstats.YAVG=");
    let ymin = values_after(log, "lavfi.signalstats.YMIN=");
    let yhigh = values_after(log, "lavfi.signalstats.YHIGH=");
    if yavg.is_empty() || yavg.len() != ymin.len() || yavg.len() != yhigh.len() {
        return Err(CoreError::Analysis(format!(
            "signalstats 输出不完整：YAVG {} 项，YMIN {} 项，YHIGH {} 项",
            yavg.len(),
            ymin.len(),
            yhigh.len()
        )));
    }
    let ylow = values_after(log, "lavfi.signalstats.YLOW=");
    let brng = values_after(log, "lavfi.signalstats.BRNG=");
    let blur = values_after(log, "lavfi.blur=");
    let entropy = values_after(log, "lavfi.entropy.entropy.normal.Y=");
    let motion = values_after(log, "lavfi.vmafmotion.score=");

    let frames = yhigh.len();
    let mean = |values: &[f64]| -> f64 {
        if values.is_empty() { 0.0 } else { values.iter().sum::<f64>() / values.len() as f64 }
    };
    let exposure_yavg = mean(&yavg);

    // 过曝:90 百分位触白位 且 整帧平均亮度偏高。
    // (YMAX 是整帧最亮的单个像素,任何高光点都触 255,曾导致误判率接近 100%。)
    let overexposed_frames = yhigh
        .iter()
        .zip(yavg.iter())
        .filter(|(high, avg)| {
            **high >= OVEREXPOSED_YHIGH_THRESHOLD && **avg >= OVEREXPOSED_YAVG_THRESHOLD
        })
        .count();
    let overexposed_ratio = overexposed_frames as f64 / frames as f64;

    // 欠曝:10 百分位贴近黑位 且 整帧偏暗。
    let underexposed_frames = if ylow.len() == yavg.len() {
        ylow.iter()
            .zip(yavg.iter())
            .filter(|(low, avg)| {
                **low <= UNDEREXPOSED_YLOW_THRESHOLD && **avg <= UNDEREXPOSED_YAVG_THRESHOLD
            })
            .count()
    } else {
        0
    };
    let underexposed_ratio = underexposed_frames as f64 / frames.max(1) as f64;

    // 动态范围:90-10 百分位差。过小=灰蒙蒙/雾天,但 log 素材也是低动态范围,
    // 所以后续判废时要配合 entropy 守卫(有正常纹理的低动态范围是 log 片,不是废片)。
    let dynamic_range = if ylow.len() == yhigh.len() && !ylow.is_empty() {
        mean(&yhigh.iter().zip(ylow.iter()).map(|(h, l)| h - l).collect::<Vec<_>>())
    } else {
        0.0
    };

    let blur_mean = mean(&blur);
    let entropy_mean = mean(&entropy);
    let motion_mean = mean(&motion);
    let _ = mean(&brng);

    // 虚焦(对焦失败):模糊度高 + 运动低(排除运动模糊) + 纹理够(排除纯色画面)。
    // 这三条守卫是取代 Laplacian 方差的关键——Laplacian 在平坦画面上必然误判。
    let out_of_focus_frames = if blur.len() == frames && !blur.is_empty() {
        (0..frames)
            .filter(|index| {
                let blurry = blur[*index] >= BLUR_THRESHOLD;
                let textured = entropy.get(*index).copied().unwrap_or(f64::MAX) >= LOW_ENTROPY_GUARD;
                let still = motion.get(*index).copied().unwrap_or(0.0) < MOTION_BLUR_GUARD;
                blurry && textured && still
            })
            .count()
    } else {
        0
    };
    let out_of_focus_ratio = out_of_focus_frames as f64 / frames.max(1) as f64;

    let mut scene_cuts = log
        .lines()
        .filter(|line| line.contains("showinfo") && line.contains("pts_time:"))
        .filter_map(|line| token_i64(line, "pts:"))
        .filter(|pts| *pts > 0)
        .collect::<Vec<_>>();
    scene_cuts.sort_unstable();
    scene_cuts.dedup();

    let peak_values = values_after_colon(log, "Peak level dB");
    let peak_counts = values_after_colon(log, "Peak count");
    let audio_dynamic_range_db = values_after_colon(log, "Dynamic range")
        .into_iter()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .reduce(f64::max);
    if has_audio && peak_values.is_empty() {
        return Err(CoreError::Analysis(
            "astats 未返回 Peak level，拒绝猜测音频结果".to_owned(),
        ));
    }
    let audio_peak_db = peak_values
        .into_iter()
        .filter(|value| value.is_finite())
        .reduce(f64::max);
    let peak_count = peak_counts
        .into_iter()
        .filter(|value| value.is_finite())
        .fold(0.0_f64, f64::max);
    let audio_clipped = audio_peak_db
        .is_some_and(|peak| peak >= AUDIO_CLIP_PEAK_DB && peak_count > 0.0);

    Ok(ParsedSignals {
        scene_cuts,
        exposure_yavg,
        overexposed_ratio,
        underexposed_ratio,
        dynamic_range,
        blur_mean,
        entropy_mean,
        motion_mean,
        out_of_focus_ratio,
        audio_peak_db,
        audio_dynamic_range_db,
        audio_clipped,
        has_audio,
    })
}

fn persist_analysis(
    connection: &mut Connection,
    source: &ClipSource,
    computation: &AnalysisComputation,
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
        return Err(CoreError::Analysis(format!(
            "素材 {} 在分析期间发生变化，未写入结果",
            source.clip_id
        )));
    }

    let cuts = normalized_scene_cuts(
        &computation.signals.scene_cuts,
        source.duration_ticks,
    );
    transaction.execute(
        "DELETE FROM segments WHERE clip_id = ?1 AND kind = 'scene'",
        [source.clip_id],
    )?;
    let mut start = 0_i64;
    for (scene_index, end) in cuts
        .iter()
        .copied()
        .chain(std::iter::once(source.duration_ticks.max(0)))
        .enumerate()
    {
        transaction.execute(
            "INSERT INTO segments(clip_id, in_ticks, out_ticks, kind, scene_index)
             VALUES (?1, ?2, ?3, 'scene', ?4)",
            params![source.clip_id, start, end, scene_index as i64],
        )?;
        start = end;
    }
    let scene_count = cuts.len() as i64 + 1;
    let focus_scores = serde_json::to_string(&computation.focus_scores)
        .map_err(|error| CoreError::Analysis(format!("无法保存失焦分数：{error}")))?;
    let tool_versions = serde_json::to_string(&computation.tool_versions)
        .map_err(|error| CoreError::Analysis(format!("无法保存工具版本：{error}")))?;
    transaction.execute(
        "INSERT INTO clip_analysis(
            clip_id, exposure_yavg, overexposed_ratio, audio_peak_db,
            audio_clipped, has_audio, focus_scores, scene_count,
            analyzed_at, tool_versions,
            underexposed_ratio, dynamic_range, blur_mean, entropy_mean,
            motion_mean, out_of_focus_ratio
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?9,
            ?10, ?11, ?12, ?13, ?14, ?15
         )
         ON CONFLICT(clip_id) DO UPDATE SET
            exposure_yavg = excluded.exposure_yavg,
            overexposed_ratio = excluded.overexposed_ratio,
            audio_peak_db = excluded.audio_peak_db,
            audio_clipped = excluded.audio_clipped,
            has_audio = excluded.has_audio,
            focus_scores = excluded.focus_scores,
            scene_count = excluded.scene_count,
            analyzed_at = excluded.analyzed_at,
            tool_versions = excluded.tool_versions,
            underexposed_ratio = excluded.underexposed_ratio,
            dynamic_range = excluded.dynamic_range,
            blur_mean = excluded.blur_mean,
            entropy_mean = excluded.entropy_mean,
            motion_mean = excluded.motion_mean,
            out_of_focus_ratio = excluded.out_of_focus_ratio",
        params![
            source.clip_id,
            computation.signals.exposure_yavg,
            computation.signals.overexposed_ratio,
            computation.signals.audio_peak_db,
            if computation.signals.audio_clipped { 1_i64 } else { 0_i64 },
            if computation.signals.has_audio { 1_i64 } else { 0_i64 },
            focus_scores,
            scene_count,
            tool_versions,
            computation.signals.underexposed_ratio,
            computation.signals.dynamic_range,
            computation.signals.blur_mean,
            computation.signals.entropy_mean,
            computation.signals.motion_mean,
            computation.signals.out_of_focus_ratio,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

fn normalized_scene_cuts(cuts: &[i64], duration_ticks: i64) -> Vec<i64> {
    let mut normalized = cuts
        .iter()
        .copied()
        .filter(|cut| *cut > 0 && *cut < duration_ticks)
        .collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized.dedup();
    normalized
}

fn extract_focus_score(path: &Path, seconds: f64, ffmpeg: &OsStr) -> Result<f64> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from(format!("{seconds:.6}")),
        OsString::from("-i"),
        path.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-vf"),
        OsString::from(format!("scale={FOCUS_WIDTH}:{FOCUS_HEIGHT}")),
        OsString::from("-pix_fmt"),
        OsString::from("rgb24"),
        OsString::from("-f"),
        OsString::from("rawvideo"),
        OsString::from("-"),
    ];
    let output = execute_with_timeout(ffmpeg, &args, FOCUS_FRAME_TIMEOUT).map_err(|error| {
        CoreError::Analysis(format!("提取 {:.1}% 失焦采样帧失败：{error}", seconds))
    })?;
    if !output.success {
        return Err(command_failure("ffmpeg 失焦采样", &output));
    }
    let expected = FOCUS_WIDTH * FOCUS_HEIGHT * 3;
    if output.stdout.len() != expected {
        return Err(CoreError::Analysis(format!(
            "失焦采样帧字节数异常：期望 {expected}，得到 {}",
            output.stdout.len()
        )));
    }
    laplacian_variance_rgb(&output.stdout, FOCUS_WIDTH, FOCUS_HEIGHT)
}

fn laplacian_variance_rgb(rgb: &[u8], width: usize, height: usize) -> Result<f64> {
    if width < 3 || height < 3 || rgb.len() != width * height * 3 {
        return Err(CoreError::Analysis("RGB 采样帧尺寸无效".to_owned()));
    }
    let gray = rgb
        .as_chunks::<3>()
        .0
        .iter()
        .map(|pixel| {
            (77_u32 * u32::from(pixel[0])
                + 150_u32 * u32::from(pixel[1])
                + 29_u32 * u32::from(pixel[2])) as f64
                / 256.0
        })
        .collect::<Vec<_>>();
    let mut sum = 0.0;
    let mut sum_squares = 0.0;
    let mut count = 0_usize;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let center = gray[y * width + x];
            let value = gray[(y - 1) * width + x]
                + gray[(y + 1) * width + x]
                + gray[y * width + x - 1]
                + gray[y * width + x + 1]
                - 4.0 * center;
            sum += value;
            sum_squares += value * value;
            count += 1;
        }
    }
    let mean = sum / count as f64;
    Ok((sum_squares / count as f64 - mean * mean).max(0.0))
}

fn probe_has_audio(path: &Path, ffprobe: &OsStr) -> Result<bool> {
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
    let output = execute_with_timeout(ffprobe, &args, PROBE_TIMEOUT).map_err(|error| {
        CoreError::Analysis(format!("ffprobe 音轨探测失败：{error}"))
    })?;
    if !output.success {
        return Err(command_failure("ffprobe 音轨探测", &output));
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn tool_version(executable: &OsStr) -> Result<String> {
    let output = execute_with_timeout(
        executable,
        &[OsString::from("-version")],
        PROBE_TIMEOUT,
    )
    .map_err(|error| CoreError::Analysis(format!("读取工具版本失败：{error}")))?;
    if !output.success {
        return Err(command_failure("读取工具版本", &output));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::to_owned)
        .ok_or_else(|| CoreError::Analysis("工具版本输出为空".to_owned()))
}

fn ticks_to_seconds(ticks: i64, tb_num: i64, tb_den: i64) -> Result<f64> {
    if ticks < 0 || tb_num <= 0 || tb_den <= 0 {
        return Err(CoreError::Analysis("素材时长或 time_base 无效".to_owned()));
    }
    Ok(ticks as f64 * tb_num as f64 / tb_den as f64)
}

fn values_after(log: &str, marker: &str) -> Vec<f64> {
    log.lines()
        .filter_map(|line| line.split_once(marker).map(|(_, value)| value.trim()))
        .filter_map(|value| value.parse::<f64>().ok())
        .collect()
}

fn values_after_colon(log: &str, marker: &str) -> Vec<f64> {
    log.lines()
        .filter(|line| line.contains(marker))
        .filter_map(|line| line.rsplit_once(':').map(|(_, value)| value.trim()))
        .filter_map(|value| value.parse::<f64>().ok())
        .collect()
}

fn token_i64(line: &str, marker: &str) -> Option<i64> {
    let mut tokens = line.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == marker {
            return tokens.next()?.parse().ok();
        }
    }
    None
}

fn command_failure(label: &str, output: &CommandOutput) -> CoreError {
    let summary = String::from_utf8_lossy(&output.stderr)
        .trim()
        .replace(['\r', '\n'], " ")
        .chars()
        .take(1200)
        .collect::<String>();
    CoreError::Analysis(format!(
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

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::{params, Connection};

    use super::*;
    use crate::core::import;
    use crate::core::migrations::{MIGRATION_0001, MIGRATION_0003, MIGRATION_0025};
    use crate::core::test_support::TestDirectory;

    fn analysis_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "foreign_keys", "ON").unwrap();
        connection.execute_batch(MIGRATION_0001).unwrap();
        connection.execute_batch(MIGRATION_0003).unwrap();
        connection.execute_batch(MIGRATION_0025).unwrap();
        connection
    }

    fn insert_source(connection: &Connection, path: &Path, quick_hash: &str) -> ClipSource {
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('fixture-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(
                    volume_uuid, rel_path, quick_hash, tb_num, tb_den, duration_ticks
                 ) VALUES ('fixture-volume', ?1, ?2, 1, 1000, 2000)",
                params![path.to_string_lossy(), quick_hash],
            )
            .unwrap();
        ClipSource {
            clip_id: connection.last_insert_rowid(),
            path: path.to_path_buf(),
            quick_hash: quick_hash.to_owned(),
            tb_num: 1,
            tb_den: 1000,
            duration_ticks: 2000,
        }
    }

    fn computation(scene_cuts: Vec<i64>) -> AnalysisComputation {
        AnalysisComputation {
            signals: ParsedSignals {
                scene_cuts,
                exposure_yavg: 41.25,
                overexposed_ratio: 0.2,
                underexposed_ratio: 0.0,
                dynamic_range: 120.0,
                blur_mean: 4.0,
                entropy_mean: 6.5,
                motion_mean: 5.0,
                out_of_focus_ratio: 0.0,
                audio_peak_db: Some(-0.05),
                audio_dynamic_range_db: Some(18.0),
                audio_clipped: true,
                has_audio: true,
            },
            focus_scores: vec![12.5, 61.0, 88.75],
            tool_versions: json!({"pipeline": "test"}),
        }
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
                eprintln!("skipping ffmpeg fixture: {} unavailable", Path::new(tool).display());
                return None;
            }
        }
        Some((ffmpeg, ffprobe))
    }

    fn generate_fixture(path: &Path, args: &[&str]) -> bool {
        let Some((ffmpeg, _)) = ffmpeg_tools() else {
            return false;
        };
        let status = Command::new(ffmpeg)
            .args(["-y", "-v", "error"])
            .args(args)
            .arg(path)
            .status();
        status.is_ok_and(|status| status.success())
    }

    fn fixture_source(path: &Path) -> ClipSource {
        let metadata = import::probe_media(path).unwrap();
        ClipSource {
            clip_id: 1,
            path: path.to_path_buf(),
            quick_hash: "fixture".to_owned(),
            tb_num: metadata.tb_num,
            tb_den: metadata.tb_den,
            duration_ticks: metadata.duration_ticks,
        }
    }

    fn analyze_fixture(path: &Path, ffmpeg: &OsStr, ffprobe: &OsStr) -> AnalysisComputation {
        analyze_source(
            &fixture_source(path),
            ffmpeg,
            ffprobe,
            SCENE_THRESHOLD,
        )
        .unwrap()
    }

    #[test]
    fn outdated_pipeline_version_is_requeued_for_reanalysis() {
        // 回归:算法换代(如过曝判据从 YMAX 换成 YHIGH)后,已导入素材必须重算,
        // 否则界面上一直显示旧算法的误判结果。
        let mut connection = analysis_connection();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        let directory = crate::core::test_support::TestDirectory::new();
        let media = directory.path().join("clip.mp4");
        std::fs::write(&media, b"bytes").unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, quick_hash, duration_ticks, tb_num, tb_den)
                 VALUES (1, 'v', ?1, 'hash1', 1000, 1, 1000)",
                [media.to_string_lossy().as_ref()],
            )
            .unwrap();
        // 挂一条旧版本的分析结果
        connection
            .execute(
                "INSERT INTO clip_analysis(clip_id, exposure_yavg, overexposed_ratio, audio_clipped,
                                           has_audio, focus_scores, scene_count, analyzed_at, tool_versions)
                 VALUES (1, 100.0, 1.0, 0, 1, '[]', 1, 'now', json('{\"pipeline\":\"analyze_l1/v2\"}'))",
                [],
            )
            .unwrap();
        let requeued = enqueue_missing(&mut connection).unwrap();
        assert_eq!(requeued, 1, "旧流水线版本的结果必须重新排队");

        // 已是当前版本则不重复排队
        connection
            .execute(
                "UPDATE clip_analysis SET tool_versions = json(?1) WHERE clip_id = 1",
                [format!("{{\"pipeline\":\"{ANALYSIS_PIPELINE_VERSION}\"}}")],
            )
            .unwrap();
        connection.execute("DELETE FROM jobs", []).unwrap();
        assert_eq!(enqueue_missing(&mut connection).unwrap(), 0);
    }

    #[test]
    fn parses_scene_exposure_and_clipping_values_from_ffmpeg_log() {
        let log = "
[Parsed_showinfo_2] n: 0 pts: 90000 pts_time:1
frame:0 pts:0
lavfi.signalstats.YAVG=20
lavfi.signalstats.YMIN=16
lavfi.signalstats.YHIGH=250
frame:1 pts:1
lavfi.signalstats.YAVG=200
lavfi.signalstats.YMIN=16
lavfi.signalstats.YHIGH=250
[Parsed_astats_5] Peak level dB: -0.05
[Parsed_astats_5] Peak count: 4
[Parsed_astats_5] Dynamic range: 18.25
";
        let parsed = parse_signal_log(log, true).unwrap();

        assert_eq!(parsed.scene_cuts, vec![90_000]);
        assert_eq!(parsed.exposure_yavg, 110.0);
        assert_eq!(parsed.overexposed_ratio, 0.5);
        assert_eq!(parsed.audio_peak_db, Some(-0.05));
        assert_eq!(parsed.audio_dynamic_range_db, Some(18.25));
        assert!(parsed.audio_clipped);
    }

    #[test]
    fn signal_parser_rejects_incomplete_exposure_output() {
        let error = parse_signal_log("lavfi.signalstats.YAVG=42", false).unwrap_err();
        assert!(error.to_string().contains("signalstats 输出不完整"));
    }

    #[test]
    fn laplacian_variance_separates_flat_and_edged_rgb_frames() {
        let flat = vec![120_u8; 5 * 5 * 3];
        let mut edged = flat.clone();
        for y in 0..5 {
            for x in 3..5 {
                let offset = (y * 5 + x) * 3;
                edged[offset..offset + 3].fill(255);
            }
        }

        let flat_score = laplacian_variance_rgb(&flat, 5, 5).unwrap();
        let edged_score = laplacian_variance_rgb(&edged, 5, 5).unwrap();
        assert_eq!(flat_score, 0.0);
        assert!(edged_score > flat_score);
    }

    #[test]
    fn scene_cuts_are_sorted_deduplicated_and_bounded() {
        assert_eq!(
            normalized_scene_cuts(&[1500, 0, 500, 500, 2500, -1], 2000),
            vec![500, 1500]
        );
    }

    #[test]
    fn no_scene_cut_persists_one_whole_clip_segment() {
        let mut connection = analysis_connection();
        let source = insert_source(&connection, Path::new("whole.mov"), "whole");

        persist_analysis(&mut connection, &source, &computation(vec![])).unwrap();
        let segment: (i64, i64, String, i64) = connection
            .query_row(
                "SELECT in_ticks, out_ticks, kind, scene_index FROM segments",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(segment, (0, 2000, "scene".to_owned(), 0));
        assert_eq!(get_clip_analysis(&connection, source.clip_id).unwrap().unwrap().scene_count, 1);
    }

    #[test]
    fn scene_segments_are_monotonic_non_overlapping_source_ticks() {
        let mut connection = analysis_connection();
        let source = insert_source(&connection, Path::new("cuts.mov"), "cuts");

        persist_analysis(
            &mut connection,
            &source,
            &computation(vec![1500, 500, 500]),
        )
        .unwrap();
        let mut statement = connection
            .prepare("SELECT in_ticks, out_ticks FROM segments ORDER BY scene_index")
            .unwrap();
        let segments = statement
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(segments, vec![(0, 500), (500, 1500), (1500, 2000)]);
    }

    #[test]
    fn raw_analysis_values_round_trip_without_losing_evidence() {
        let mut connection = analysis_connection();
        let source = insert_source(&connection, Path::new("raw.mov"), "raw");
        let expected = computation(vec![1000]);

        persist_analysis(&mut connection, &source, &expected).unwrap();
        let stored = get_clip_analysis(&connection, source.clip_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.exposure_yavg, 41.25);
        assert_eq!(stored.overexposed_ratio, 0.2);
        assert_eq!(stored.audio_peak_db, Some(-0.05));
        assert_eq!(stored.focus_scores, vec![12.5, 61.0, 88.75]);
        assert_eq!(stored.tool_versions, json!({"pipeline": "test"}));
        assert_eq!(stored.underexposed_ratio, 0.0);
        assert_eq!(stored.dynamic_range, 120.0);
        assert_eq!(stored.blur_mean, 4.0);
        assert_eq!(stored.entropy_mean, 6.5);
        assert_eq!(stored.motion_mean, 5.0);
        assert_eq!(stored.out_of_focus_ratio, 0.0);
    }

    #[test]
    fn source_change_prevents_analysis_and_segment_partial_writes() {
        let mut connection = analysis_connection();
        let source = insert_source(&connection, Path::new("changed.mov"), "before");
        connection
            .execute("UPDATE clips SET quick_hash = 'after' WHERE id = ?1", [source.clip_id])
            .unwrap();

        let error = persist_analysis(&mut connection, &source, &computation(vec![1000]))
            .unwrap_err();
        assert!(error.to_string().contains("发生变化"));
        let analysis_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM clip_analysis", [], |row| row.get(0))
            .unwrap();
        let segment_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM segments", [], |row| row.get(0))
            .unwrap();
        assert_eq!((analysis_count, segment_count), (0, 0));
    }

    #[test]
    fn analyze_job_enqueue_is_idempotent_for_source_hash() {
        let mut connection = analysis_connection();
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
    fn generated_black_sample_is_below_dark_threshold() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("black.mov");
        if !generate_fixture(
            &path,
            &["-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=2", "-c:v", "mpeg4", "-q:v", "2"],
        ) {
            eprintln!("skipping black fixture: encoder unavailable");
            return;
        }

        let result = analyze_fixture(&path, &ffmpeg, &ffprobe);
        assert!(result.signals.exposure_yavg < DARK_YAVG_THRESHOLD);
    }

    #[test]
    fn generated_white_sample_exceeds_overexposed_ratio() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("white.mov");
        if !generate_fixture(
            &path,
            &["-f", "lavfi", "-i", "color=c=white:s=320x180:r=25:d=2", "-c:v", "mpeg4", "-q:v", "2"],
        ) {
            eprintln!("skipping white fixture: encoder unavailable");
            return;
        }

        let result = analyze_fixture(&path, &ffmpeg, &ffprobe);
        assert!(result.signals.overexposed_ratio > OVEREXPOSED_RATIO_THRESHOLD);
    }

    #[test]
    fn ten_bit_source_yavg_stays_in_eight_bit_domain() {
        // 回归:10-bit 源的 signalstats YAVG 原生是 0-1023,曾击穿 0-255 CHECK(26条真素材阻塞)。
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("white10.mov");
        if !generate_fixture(
            &path,
            &["-f", "lavfi", "-i", "color=c=white:s=320x180:r=25:d=2", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-preset", "ultrafast"],
        ) {
            eprintln!("skipping 10-bit fixture: encoder unavailable");
            return;
        }

        let result = analyze_fixture(&path, &ffmpeg, &ffprobe);
        assert!(result.signals.exposure_yavg <= 255.0, "yavg={} 超出 8-bit 域", result.signals.exposure_yavg);
        assert!(result.signals.overexposed_ratio > OVEREXPOSED_RATIO_THRESHOLD);
    }

    #[test]
    fn generated_full_scale_sine_is_audio_clipped() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("clipped.mov");
        if !generate_fixture(
            &path,
            &[
                "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2",
                "-f", "lavfi", "-i", "aevalsrc=sin(2*PI*1000*t):s=48000:d=2",
                "-shortest", "-c:v", "mpeg4", "-q:v", "2", "-c:a", "pcm_s16le",
            ],
        ) {
            eprintln!("skipping clipped-audio fixture: encoder unavailable");
            return;
        }

        let result = analyze_fixture(&path, &ffmpeg, &ffprobe);
        assert!(result.signals.has_audio);
        assert!(result.signals.audio_clipped);
    }

    #[test]
    fn generated_video_without_audio_is_marked_silent() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("silent.mov");
        if !generate_fixture(
            &path,
            &["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2", "-an", "-c:v", "mpeg4", "-q:v", "2"],
        ) {
            eprintln!("skipping silent fixture: encoder unavailable");
            return;
        }

        let result = analyze_fixture(&path, &ffmpeg, &ffprobe);
        assert!(!result.signals.has_audio);
        assert_eq!(result.signals.audio_peak_db, None);
    }

    #[test]
    fn generated_hard_cut_produces_source_tick_scene_boundary() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("hard-cut.mov");
        if !generate_fixture(
            &path,
            &[
                "-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=1",
                "-f", "lavfi", "-i", "color=c=white:s=320x180:r=25:d=1",
                "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                "-map", "[v]", "-c:v", "mpeg4", "-q:v", "2",
            ],
        ) {
            eprintln!("skipping hard-cut fixture: encoder unavailable");
            return;
        }

        let source = fixture_source(&path);
        let result = analyze_source(
            &source,
            &ffmpeg,
            &ffprobe,
            SCENE_THRESHOLD,
        )
        .unwrap();
        assert!(!result.signals.scene_cuts.is_empty());
        assert!(
            normalized_scene_cuts(&result.signals.scene_cuts, source.duration_ticks).len() + 1
                >= 2
        );
        let one_second_ticks = source.tb_den / source.tb_num;
        let tolerance = (one_second_ticks / 20).max(1);
        assert!((result.signals.scene_cuts[0] - one_second_ticks).abs() <= tolerance);
    }

    #[test]
    fn generated_blur_has_lower_laplacian_score_than_clear_testsrc() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let clear_path = directory.path().join("clear.mov");
        let blur_path = directory.path().join("blur.mov");
        let clear_ok = generate_fixture(
            &clear_path,
            &["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2", "-c:v", "mpeg4", "-q:v", "2"],
        );
        let blur_ok = generate_fixture(
            &blur_path,
            &[
                "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=2",
                "-vf", "gblur=sigma=12", "-c:v", "mpeg4", "-q:v", "2",
            ],
        );
        if !clear_ok || !blur_ok {
            eprintln!("skipping focus fixtures: encoder or gblur unavailable");
            return;
        }

        let clear = analyze_fixture(&clear_path, &ffmpeg, &ffprobe);
        let blur = analyze_fixture(&blur_path, &ffmpeg, &ffprobe);
        let clear_mean = clear.focus_scores.iter().sum::<f64>() / clear.focus_scores.len() as f64;
        let blur_mean = blur.focus_scores.iter().sum::<f64>() / blur.focus_scores.len() as f64;
        assert!(blur_mean < clear_mean);
    }

    #[test]
    fn corrupted_media_fails_without_persisting_partial_analysis() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("corrupt.mov");
        fs::write(&path, b"not media").unwrap();
        let source = ClipSource {
            clip_id: 1,
            path,
            quick_hash: "corrupt".to_owned(),
            tb_num: 1,
            tb_den: 1000,
            duration_ticks: 1000,
        };

        assert!(analyze_source(
            &source,
            &ffmpeg,
            &ffprobe,
            SCENE_THRESHOLD,
        )
        .is_err());
        let connection = analysis_connection();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM clip_analysis", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
