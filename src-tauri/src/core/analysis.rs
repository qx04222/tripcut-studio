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

// 场景切换:在 10 fps 采样上比较相邻帧(见 `analysis_args`),阈值 0.25。
// R14 实测:v4 在 2 fps 采样上判切点,相邻样本隔 0.5 s,平滑摇镜(10%/s)本身就差到
// 0.33–0.35(tilt_fast 0.3456 离误判一线之隔),而夜景硬切只有 0.22–0.30——两者在
// 2 fps 上根本分不开,0.35 只能"都不认"。改成 10 fps 后摇镜相邻样本只差 ≤0.17,
// 夜景硬切仍是 0.29–0.37(切点分数与采样率无关),0.25 落在中间。
pub const SCENE_THRESHOLD: f64 = 0.25;
pub const SCENE_SAMPLE_FPS: u32 = 10;
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
// 欠曝:10 百分位贴近黑位且整帧偏暗,且画面里没有真实高光。
// R14 实测(2026-09-14,6 条真实样片):正确曝光的夜景(路灯/窗户/手机屏幕)
// YLOW=16、YAVG 34–48 —— 前两条单独用会把每一帧都判成欠曝(under=1.00,时刻分
// 「曝光正常」占比 0),这正是 verify-v1 记的「夜景被判曝光不正常」。区别在高光:
// 夜景 YMAX 242–255;真欠曝(整段曝光不足)是全画面一起压暗,最亮像素也到不了白位
// (合成 eq=brightness=-0.35 样本 YMAX≈166)。分析前已缩到 640 宽,单个热像素被平均掉,
// YMAX 在这里比 YHIGH 可靠(YHIGH 是 90 百分位,夜景里的高光面积不到 10%)。
pub const UNDEREXPOSED_YLOW_THRESHOLD: f64 = 16.0;
pub const UNDEREXPOSED_YAVG_THRESHOLD: f64 = 60.0;
pub const UNDEREXPOSED_HIGHLIGHT_YMAX: f64 = 200.0;

/// 单帧欠曝判定:暗部贴黑位 + 整帧偏暗 + 没有高光。L1 汇总与 R11 时刻分共用同一条判据,
/// 池子角标「欠曝」与时刻分「曝光正常」不会互相打架。
pub fn frame_underexposed(ylow: f64, yavg: f64, ymax: f64) -> bool {
    ylow <= UNDEREXPOSED_YLOW_THRESHOLD
        && yavg <= UNDEREXPOSED_YAVG_THRESHOLD
        && ymax < UNDEREXPOSED_HIGHLIGHT_YMAX
}
// 广播范围溢出像素占比(BRNG),直接量化过曝/欠曝的面积。
pub const BRNG_RATIO_THRESHOLD: f64 = 0.25;
pub const AUDIO_CLIP_PEAK_DB: f64 = -0.1;

const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(10 * 60);
// R15-perf:分段并行解码。ffmpeg 里的 VideoToolbox 硬解是逐帧同步的——延迟决定吞吐,
// 4K H.264 60 Mbps 单进程只有 ~150 fps(5 分钟素材 58 s),而三个进程各解一段几乎线性
// 加速(实测 20 s)。分段边界落在 0.5 s 窗口格点上,每段多解前面 0.5 s 作为上下文
// (场景检测 / vmafmotion 都要前一帧),合并时按绝对时间裁掉重叠——统计量与单进程逐字一致。
/// 至少这么长才值得分段(每段至少 SEGMENT_MIN_SECONDS)。
pub(crate) const SEGMENT_MIN_SECONDS: f64 = 40.0;
/// 一条素材最多开几个解码进程(含自己那一份许可)。
pub(crate) const MAX_SEGMENTS: usize = 4;
/// 每段往前多解的上下文,等于一个统计窗口(fps=2)。
const SEGMENT_OVERLAP_SECONDS: f64 = 0.5;
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const FOCUS_FRAME_TIMEOUT: Duration = Duration::from_secs(60);
const FOCUS_WIDTH: usize = 320;
const FOCUS_HEIGHT: usize = 180;
// v3:过曝判据从 YMAX(整帧最亮单像素,误判率近 100%)换成 YHIGH+YAVG 联合;
// 新增欠曝/动态范围/虚焦(blurdetect+运动+纹理三重守卫)。
// v4:场景检测挪到 2fps/640 降采样之后(此前 select 跑在全分辨率原始流上,
// 是分析阶段 CPU 的大头);解码阶段开硬解(VideoToolbox),失败自动软解重跑。
// v5(R14):欠曝加「无高光」守卫(夜景不再整段判欠曝);时刻分同判据;
// 场景检测改在 10 fps/640 上比较相邻帧(2 fps 下摇镜与夜景硬切分不开),阈值 0.35→0.25。
// 版本号变化会让旧结果被 enqueue_missing 重新排队重算。
const ANALYSIS_PIPELINE_VERSION: &str = "analyze_l1/v5";

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
    /// R11:同一份 ffmpeg 日志按 0.5 s 窗口拆出的画面/声音信号,供时刻分落盘。
    windows: super::moments::WindowSignals,
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
    let scene_threshold = effective_scene_threshold(connection)?;
    // R15-perf:同一次解码顺手留下运镜采样帧,后面的 analyze_motion 不再整片解码第二遍。
    let motion_handoff = connection.path().map(|db_path| MotionHandoff {
        cache_root: super::artifacts::cache_root_for_db(Path::new(db_path)),
        clip_id: source.clip_id,
        quick_hash: source.quick_hash.clone(),
    });
    let computation =
        analyze_source_with_handoff(&source, &ffmpeg, &ffprobe, scene_threshold, motion_handoff.as_ref())?;
    persist_analysis(connection, &source, &computation)?;
    // R11:时刻分是 L1 的后续步骤,用的是同一份日志(不再解码第二次)。
    // 它失败不能连累已经落盘的分析结果——记日志,交给启动时的「补齐时刻分」重跑。
    let cuts = normalized_scene_cuts(&computation.signals.scene_cuts, source.duration_ticks);
    if let Err(error) = super::moments::persist_for_clip(
        connection,
        &super::moments::MomentSource {
            clip_id: source.clip_id,
            quick_hash: source.quick_hash.clone(),
            tb_num: source.tb_num,
            tb_den: source.tb_den,
            duration_ticks: source.duration_ticks,
            has_audio: computation.signals.has_audio,
        },
        &computation.windows,
        &cuts,
    ) {
        tracing::warn!(%error, clip_id = source.clip_id, "时刻分未能写入,留给补齐任务重跑");
    }
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

/// 场景阈值:读设置;旧库里种下的 0.35(v4 的默认,从未在界面暴露)当作没改过,
/// 用当前默认——否则版本升级重算时还是拿 2 fps 时代的阈值去比 10 fps 的相邻帧。
pub(crate) fn effective_scene_threshold(connection: &Connection) -> Result<f64> {
    let stored = crate::core::settings::number_value(
        connection,
        crate::core::settings::SCENE_THRESHOLD_KEY,
        SCENE_THRESHOLD,
    )?;
    if (stored - crate::core::settings::LEGACY_SCENE_THRESHOLD).abs() < 1e-9 {
        return Ok(SCENE_THRESHOLD);
    }
    Ok(stored.clamp(0.0, 1.0))
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

/// 一次解码拿全部粗筛信号:曝光(含 BRNG 溢出占比)、模糊度、纹理熵、运动能量、场景切点。
/// 先降采样到 10fps/640 宽再堆滤镜——滤镜串联代价是相加的,
/// 全帧率堆滤镜会慢两个数量级,而筛素材这个任务对降采样后的统计精度不敏感
/// (实测 30s 4K 素材:v3 全分辨率跑场景检测 CPU 19.6s → v4 降采样后跑 <3s)。
/// 场景检测在 10 fps 上比相邻帧(摇镜相邻帧差得小、硬切差得大);统计量再抽到 2 fps
/// (与 R11 时刻分的 0.5 s 窗口对齐)。
/// `hardware_decode` 为真时在 `-i` 前插入 VideoToolbox 硬解前缀。
/// `with_motion` 为真时从**解码后、缩放前**的原始流再分一路给运镜采样链
/// (`motion::gray_frame_filter`,2 fps → 160×160 灰度)——与运镜任务自己解码时的 `-vf`
/// 作用在同样的解码帧上,采样帧逐字节相同(2026-09-14 实测),运镜结果不变,只省一次整片解码。
fn video_filter(scene_threshold: f64, with_motion: bool) -> String {
    let l1 = format!(
        "fps={SCENE_SAMPLE_FPS},scale=640:-2,format=yuv420p,split=2[scene_src][stats_src];\
         [scene_src]select='eq(n,0)+gt(scene,{scene_threshold})',showinfo[scene_out];\
         [stats_src]fps=2,signalstats=stat=brng,blurdetect=radius=20,entropy,vmafmotion,\
         metadata=mode=print[stats_out]"
    );
    if with_motion {
        format!(
            "[0:v:0]split=2[l1_src][motion_src];[l1_src]{l1};[motion_src]{}[motion_out]",
            super::motion::gray_frame_filter()
        )
    } else {
        format!("[0:v:0]{l1}")
    }
}

/// 运镜采样帧输出:写成裸灰度文件,`max_frames` 是这段该有的帧数上限(含上下文),
/// 最后一段不限。
fn motion_output_args(path: &Path, max_frames: Option<usize>) -> Vec<OsString> {
    let mut args = vec![OsString::from("-map"), OsString::from("[motion_out]")];
    if let Some(max) = max_frames {
        args.extend([OsString::from("-frames:v"), OsString::from(max.to_string())]);
    }
    args.extend([
        OsString::from("-an"),
        OsString::from("-pix_fmt"),
        OsString::from("gray"),
        OsString::from("-f"),
        OsString::from("rawvideo"),
        OsString::from("-y"),
        path.as_os_str().to_owned(),
    ]);
    args
}

/// R11 时刻分:同一次解码里把音频分成两路——整条汇总(原有 Peak/动态范围)
/// 与每 0.5 s 一窗的 RMS/峰值/熵(`asetnsamples` 按重采样后的 8 kHz 切 4000 样本)。
fn audio_filter() -> String {
    format!(
        "[0:a:0]asplit=2[a_all][a_win];\
         [a_all]astats=metadata=1:reset=0:measure_overall=Peak_level+Peak_count+Dynamic_range[a_all_out];\
         [a_win]aresample={rate},asetnsamples=n={samples},\
         astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level+Peak_level+Entropy,\
         ametadata=mode=print[a_win_out]",
        rate = super::moments::AUDIO_WINDOW_SAMPLE_RATE,
        samples = super::moments::AUDIO_WINDOW_SAMPLES,
    )
}

fn video_output_args() -> [OsString; 12] {
    [
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
    ]
}

fn audio_output_args() -> Vec<OsString> {
    let mut args = Vec::with_capacity(12);
    for label in ["[a_all_out]", "[a_win_out]"] {
        args.extend([
            OsString::from("-map"),
            OsString::from(label),
            OsString::from("-vn"),
            OsString::from("-f"),
            OsString::from("null"),
            OsString::from("-"),
        ]);
    }
    args
}

fn analysis_args(
    path: &Path,
    scene_threshold: f64,
    has_audio: bool,
    hardware_decode: bool,
    motion_out: Option<&Path>,
) -> Vec<OsString> {
    let mut filter = video_filter(scene_threshold, motion_out.is_some());
    if has_audio {
        filter.push(';');
        filter.push_str(&audio_filter());
    }
    let mut args = vec![OsString::from("-hide_banner"), OsString::from("-nostdin")];
    if hardware_decode {
        args.extend(super::artifacts::hardware_decode_prefix());
    }
    args.extend([
        OsString::from("-i"),
        path.as_os_str().to_owned(),
        OsString::from("-filter_complex"),
        OsString::from(filter),
    ]);
    args.extend(video_output_args());
    if has_audio {
        args.extend(audio_output_args());
    }
    if let Some(motion_path) = motion_out {
        args.extend(motion_output_args(motion_path, None));
    }
    args
}

/// R15-perf:一段视频的分析参数——`-ss`(输入侧,先按关键帧跳再精确丢帧到 `seek`)与
/// 可选的 `-t`;时间戳从 0 重新计,合并时由 `rebase_segment_log` 加回 `seek`。只跑视频
/// 滤镜——音频另起一个轻量进程整条跑(AAC 解码 5 分钟不到 1 s,分段不值得)。
fn analysis_segment_args(
    path: &Path,
    scene_threshold: f64,
    hardware_decode: bool,
    seek_seconds: f64,
    length_seconds: Option<f64>,
    motion_out: Option<(&Path, Option<usize>)>,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("-hide_banner"), OsString::from("-nostdin")];
    if hardware_decode {
        args.extend(super::artifacts::hardware_decode_prefix());
    }
    args.extend([OsString::from("-ss"), OsString::from(format!("{seek_seconds:.3}"))]);
    if let Some(length) = length_seconds {
        args.extend([OsString::from("-t"), OsString::from(format!("{length:.3}"))]);
    }
    args.extend([
        OsString::from("-i"),
        path.as_os_str().to_owned(),
        OsString::from("-filter_complex"),
        OsString::from(video_filter(scene_threshold, motion_out.is_some())),
    ]);
    args.extend(video_output_args());
    if let Some((motion_path, max_frames)) = motion_out {
        args.extend(motion_output_args(motion_path, max_frames));
    }
    args
}

/// 分段跑时音频单独一趟(不带硬解前缀,音频用不上)。
fn analysis_audio_args(path: &Path) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        path.as_os_str().to_owned(),
        OsString::from("-filter_complex"),
        OsString::from(audio_filter()),
    ];
    args.extend(audio_output_args());
    args
}

/// 一段:`start` 是这段负责的绝对起点,`seek` 是实际解码起点(前面多解 0.5 s 上下文),
/// `end` 是负责的绝对终点(最后一段为 `None`,解到片尾)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Segment {
    pub start: f64,
    pub seek: f64,
    pub end: Option<f64>,
}

impl Segment {
    /// 传给 ffmpeg `-t` 的长度:从 `seek` 解到 `end`(最后一段不限)。
    fn length(&self) -> Option<f64> {
        self.end.map(|end| end - self.seek)
    }

    /// 这段的运镜采样帧里,前面多少帧是上下文(要丢),多少帧是自己的(最后一段 `None`)。
    fn motion_frames(&self) -> (usize, Option<usize>) {
        let fps = super::motion::HANDOFF_SAMPLE_FPS as f64;
        let context = ((self.start - self.seek) * fps).round() as usize;
        let owned = self.end.map(|end| ((end - self.start) * fps).round() as usize);
        (context, owned)
    }
}

/// 决定分几段:不超过 `1 + extra_slots`(自己那份许可加借来的)、不超过 MAX_SEGMENTS,
/// 且每段至少 SEGMENT_MIN_SECONDS。段界落在 0.5 s 格点上。只有一段时返回空——调用方走
/// 原来的单进程路径,参数逐字不变。
pub(crate) fn segment_plan(duration_seconds: f64, extra_slots: usize) -> Vec<Segment> {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Vec::new();
    }
    let by_length = (duration_seconds / SEGMENT_MIN_SECONDS).floor() as usize;
    let count = by_length.min(1 + extra_slots).min(MAX_SEGMENTS);
    if count < 2 {
        return Vec::new();
    }
    let raw_length = duration_seconds / count as f64;
    // 段界对齐到 0.5 s 格点(统计窗口),重叠上下文正好一整窗。
    let grid = SEGMENT_OVERLAP_SECONDS;
    (0..count)
        .map(|index| {
            let start = ((index as f64 * raw_length) / grid).round() * grid;
            let end = if index + 1 == count {
                None
            } else {
                Some((((index + 1) as f64 * raw_length) / grid).round() * grid)
            };
            let seek = if index == 0 { 0.0 } else { (start - SEGMENT_OVERLAP_SECONDS).max(0.0) };
            Segment { start, seek, end }
        })
        .collect()
}

/// 把一段的日志换算回整条素材的时间轴:`pts_time:` 加上 `seek`,再按 `[start, end)`
/// 裁掉上下文与越界帧——`metadata=print` 的 `frame:` 行带着它后面的 `lavfi.*` 行一起去留,
/// `showinfo` 行单独判。其它行(横幅、进度)原样保留,解析器本来就不看它们。
fn rebase_segment_log(log: &str, segment: Segment) -> String {
    const EPSILON: f64 = 1e-4;
    let in_range = |seconds: f64| {
        seconds >= segment.start - EPSILON && segment.end.is_none_or(|end| seconds < end - EPSILON)
    };
    let rewrite = |line: &str, seconds: f64| -> String {
        line.split(' ')
            .map(|token| {
                if token.starts_with("pts_time:") {
                    format!("pts_time:{}", (seconds * 1e6).round() / 1e6)
                } else {
                    token.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut output = String::with_capacity(log.len());
    let mut keep_block = true;
    for line in log.lines() {
        let is_showinfo = line.contains("showinfo");
        let is_frame_header = line.contains("frame:") && line.contains("pts_time:") && !is_showinfo;
        if is_showinfo && line.contains("pts_time:") {
            if let Some(local) = token_prefixed_f64(line, "pts_time:") {
                let absolute = local + segment.seek;
                if in_range(absolute) {
                    output.push_str(&rewrite(line, absolute));
                    output.push('\n');
                }
            }
            continue;
        }
        if is_frame_header {
            match token_prefixed_f64(line, "pts_time:") {
                Some(local) => {
                    let absolute = local + segment.seek;
                    keep_block = in_range(absolute);
                    if keep_block {
                        output.push_str(&rewrite(line, absolute));
                        output.push('\n');
                    }
                }
                None => keep_block = false,
            }
            continue;
        }
        if line.contains("lavfi.") {
            if keep_block {
                output.push_str(line);
                output.push('\n');
            }
            continue;
        }
        output.push_str(line);
        output.push('\n');
    }
    output
}

/// 先硬解后软解:硬解失败(进程报错或非零退出)就用软解重跑一次;
/// 两次都失败时合并两条错误信息(`run_ffmpeg_file_with_fallback` 是产物文件导向的,
/// 分析阶段要解析 ffmpeg 的日志输出而非产物文件,故在此内联实现重试)。
fn run_analysis_ffmpeg(
    ffmpeg: &OsStr,
    path: &Path,
    scene_threshold: f64,
    has_audio: bool,
    motion_out: Option<&Path>,
) -> Result<String> {
    run_analysis_ffmpeg_with_args(
        ffmpeg,
        path,
        &analysis_args(path, scene_threshold, has_audio, true, motion_out),
        &analysis_args(path, scene_threshold, has_audio, false, motion_out),
    )
}

/// 承载实际的先硬解后软解重试;拆出来是为了让测试能各自喂给硬解/软解不同的
/// (故意会失败的)参数，而不用依赖真的 VideoToolbox 失败场景。
fn run_analysis_ffmpeg_with_args(
    ffmpeg: &OsStr,
    path: &Path,
    hardware_args: &[OsString],
    software_args: &[OsString],
) -> Result<String> {
    let hardware_error = match execute_with_timeout(ffmpeg, hardware_args, ANALYSIS_TIMEOUT) {
        Ok(output) if output.success => return Ok(combined_log(&output)),
        Ok(output) => command_failure("ffmpeg L1 分析（VideoToolbox 硬解）", &output),
        Err(error) => CoreError::Analysis(format!(
            "ffmpeg 分析 {}（VideoToolbox 硬解）失败：{error}",
            path.display()
        )),
    };

    match execute_with_timeout(ffmpeg, software_args, ANALYSIS_TIMEOUT) {
        Ok(output) if output.success => Ok(combined_log(&output)),
        Ok(output) => {
            let software_error = command_failure("ffmpeg L1 分析（CPU 软解）", &output);
            Err(CoreError::Analysis(format!(
                "VideoToolbox 硬解：{hardware_error}；CPU 解码：{software_error}"
            )))
        }
        Err(error) => Err(CoreError::Analysis(format!(
            "VideoToolbox 硬解：{hardware_error}；CPU 解码：ffmpeg 分析 {} 失败：{error}",
            path.display()
        ))),
    }
}

/// R15-perf:分段并行——每段一个线程跑 `run_analysis_ffmpeg_with_args`(各自先硬解后软解),
/// 音频整条另跑一趟;任何一段失败或用户取消就让其余段停下,再把各段日志按绝对时间
/// 换算、裁重叠、按顺序拼成一份,交给原来的解析器。
fn run_analysis_ffmpeg_segmented(
    ffmpeg: &OsStr,
    path: &Path,
    scene_threshold: f64,
    has_audio: bool,
    plan: &[Segment],
    motion_parts: Option<&[PathBuf]>,
) -> Result<String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let abort = Arc::new(AtomicBool::new(false));
    let parent_flag = super::jobs::current_cancellation_flag();
    let mut handles = Vec::with_capacity(plan.len() + 1);
    let spawn = |args_hw: Vec<OsString>, args_sw: Vec<OsString>| {
        let ffmpeg = ffmpeg.to_owned();
        let path = path.to_path_buf();
        let abort = abort.clone();
        let parent_flag = parent_flag.clone();
        thread::spawn(move || {
            // 子线程的取消标志 = 父任务的取消 || 本次分段的任一失败。
            let merged = Arc::new(AtomicBool::new(false));
            super::jobs::adopt_cancellation_flag(Some(merged.clone()));
            let watcher_abort = abort.clone();
            let watcher_flag = merged.clone();
            let watcher_parent = parent_flag.clone();
            let watcher_done = Arc::new(AtomicBool::new(false));
            let watcher_done_flag = watcher_done.clone();
            let watcher = thread::spawn(move || {
                while !watcher_done_flag.load(Ordering::SeqCst) {
                    if watcher_abort.load(Ordering::SeqCst)
                        || watcher_parent.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst))
                    {
                        watcher_flag.store(true, Ordering::SeqCst);
                        break;
                    }
                    thread::sleep(Duration::from_millis(20));
                }
            });
            let result = run_analysis_ffmpeg_with_args(&ffmpeg, &path, &args_hw, &args_sw);
            watcher_done.store(true, Ordering::SeqCst);
            let _ = watcher.join();
            if result.is_err() {
                abort.store(true, Ordering::SeqCst);
            }
            result
        })
    };
    for (index, segment) in plan.iter().enumerate() {
        let motion_out = motion_parts.and_then(|parts| parts.get(index)).map(|part| {
            let (context, owned) = segment.motion_frames();
            (part.as_path(), owned.map(|owned| context + owned))
        });
        handles.push(spawn(
            analysis_segment_args(path, scene_threshold, true, segment.seek, segment.length(), motion_out),
            analysis_segment_args(path, scene_threshold, false, segment.seek, segment.length(), motion_out),
        ));
    }
    if has_audio {
        let audio_args = analysis_audio_args(path);
        handles.push(spawn(audio_args.clone(), audio_args));
    }
    let mut logs = Vec::with_capacity(handles.len());
    let mut first_error = None;
    for handle in handles {
        match handle.join() {
            Ok(Ok(log)) => logs.push(log),
            Ok(Err(error)) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
            Err(_) => {
                if first_error.is_none() {
                    first_error = Some(CoreError::Analysis("分段分析线程异常退出".to_owned()));
                }
            }
        }
    }
    if let Some(error) = first_error {
        if super::jobs::current_cancellation_requested() {
            return Err(CoreError::Analysis("用户已取消".to_owned()));
        }
        return Err(error);
    }
    let mut merged = String::new();
    for (index, log) in logs.iter().enumerate() {
        match plan.get(index) {
            Some(segment) => merged.push_str(&rebase_segment_log(log, *segment)),
            None => merged.push_str(log),
        }
        merged.push('\n');
    }
    Ok(merged)
}

fn combined_log(output: &CommandOutput) -> String {
    let mut log = String::from_utf8_lossy(&output.stderr).into_owned();
    log.push('\n');
    log.push_str(&String::from_utf8_lossy(&output.stdout));
    log
}

#[cfg(test)]
fn analyze_source(
    source: &ClipSource,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    scene_threshold: f64,
) -> Result<AnalysisComputation> {
    analyze_source_with_handoff(source, ffmpeg, ffprobe, scene_threshold, None)
}

fn analyze_source_with_handoff(
    source: &ClipSource,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    scene_threshold: f64,
    motion_handoff: Option<&MotionHandoff>,
) -> Result<AnalysisComputation> {
    let duration_seconds = ticks_to_seconds(
        source.duration_ticks,
        source.tb_num,
        source.tb_den,
    )?;
    let has_audio = probe_has_audio(&source.path, ffprobe)?;
    let (log, segments) =
        run_analysis_pass(ffmpeg, &source.path, duration_seconds, scene_threshold, has_audio, None, motion_handoff)?;
    let signals = parse_signal_log(&log, has_audio, source.tb_num, source.tb_den)?;
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
            "underexposed_ylow": UNDEREXPOSED_YLOW_THRESHOLD,
            "underexposed_yavg": UNDEREXPOSED_YAVG_THRESHOLD,
            "underexposed_highlight_ymax": UNDEREXPOSED_HIGHLIGHT_YMAX,
            "audio_clip_peak_db": AUDIO_CLIP_PEAK_DB
        },
        "preprocess": {
            "exposure_fps": 2,
            "decode_segments": segments,
            "focus_positions": [0.1, 0.5, 0.9],
            "focus_rgb_size": [FOCUS_WIDTH, FOCUS_HEIGHT],
            "focus_kernel": "3x3-laplacian-cross"
        },
        "signals": {
            "audio_dynamic_range_db": signals.audio_dynamic_range_db,
            "blur_valid_samples": values_after(&log, "lavfi.blur=").iter().filter(|value| value.is_finite()).count()
        }
    });

    let windows = super::moments::WindowSignals::parse(&log);

    Ok(AnalysisComputation {
        signals,
        focus_scores,
        tool_versions,
        windows,
    })
}

/// R11 「补齐时刻分」任务用:只跑一次同样的扫描,拿回窗口信号与场景切点,
/// 不重写 `clip_analysis`(老库里已有的分析结果原样保留)。
pub(crate) fn scan_windows(
    path: &Path,
    tb_num: i64,
    tb_den: i64,
    duration_ticks: i64,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    scene_threshold: f64,
) -> Result<(super::moments::WindowSignals, Vec<i64>, bool)> {
    let has_audio = probe_has_audio(path, ffprobe)?;
    let duration_seconds = ticks_to_seconds(duration_ticks, tb_num, tb_den)?;
    let (log, _) = run_analysis_pass(ffmpeg, path, duration_seconds, scene_threshold, has_audio, None, None)?;
    let cuts = scene_cuts_from_log(&log, tb_num, tb_den);
    Ok((super::moments::WindowSignals::parse(&log), cuts, has_audio))
}

/// 一次分析扫描:借空闲解码许可决定分几段(`forced_segments` 只给测试用来定死段数),
/// 一段就走原来的单进程;返回日志与实际段数。
fn run_analysis_pass(
    ffmpeg: &OsStr,
    path: &Path,
    duration_seconds: f64,
    scene_threshold: f64,
    has_audio: bool,
    forced_segments: Option<usize>,
    motion_handoff: Option<&MotionHandoff>,
) -> Result<(String, usize)> {
    let loan = super::jobs::borrow_spare_decode_slots(MAX_SEGMENTS - 1);
    let plan = match forced_segments {
        Some(count) => segment_plan(duration_seconds, count.saturating_sub(1)),
        None => segment_plan(duration_seconds, loan.count()),
    };
    let part_count = plan.len().max(1);
    let parts: Vec<PathBuf> = motion_handoff
        .map(|handoff| handoff.part_paths(part_count))
        .unwrap_or_default();
    if let Some(parent) = parts.first().and_then(|part| part.parent()) {
        std::fs::create_dir_all(parent)?;
    }
    let result = if plan.len() < 2 {
        run_analysis_ffmpeg(ffmpeg, path, scene_threshold, has_audio, parts.first().map(PathBuf::as_path))
            .map(|log| (log, 1))
    } else {
        run_analysis_ffmpeg_segmented(
            ffmpeg,
            path,
            scene_threshold,
            has_audio,
            &plan,
            (!parts.is_empty()).then_some(parts.as_slice()),
        )
        .map(|log| (log, plan.len()))
    };
    drop(loan);
    if let (Ok(_), Some(handoff)) = (&result, motion_handoff) {
        let handoff_parts: Vec<super::motion::HandoffPart> = if plan.len() < 2 {
            vec![super::motion::HandoffPart { path: parts[0].clone(), skip: 0, expect: None }]
        } else {
            plan.iter()
                .zip(parts.iter())
                .map(|(segment, part)| {
                    let (skip, expect) = segment.motion_frames();
                    super::motion::HandoffPart { path: part.clone(), skip, expect }
                })
                .collect()
        };
        match super::motion::write_handoff(&handoff.cache_root, handoff.clip_id, &handoff.quick_hash, &handoff_parts) {
            Ok(frames) => tracing::debug!(clip_id = handoff.clip_id, frames, "运镜采样帧已随画质分析交接"),
            Err(error) => tracing::warn!(%error, clip_id = handoff.clip_id, "运镜采样帧交接失败,运镜任务将自行解码"),
        }
    }
    for part in &parts {
        let _ = std::fs::remove_file(part);
    }
    result
}

/// R15-perf:画质分析顺手为运镜任务留下采样帧的去处(见 `motion::write_handoff`)。
pub(crate) struct MotionHandoff {
    pub cache_root: PathBuf,
    pub clip_id: i64,
    pub quick_hash: String,
}

impl MotionHandoff {
    fn part_paths(&self, count: usize) -> Vec<PathBuf> {
        let root = self.cache_root.join(self.clip_id.to_string());
        (0..count).map(|index| root.join(format!("motion-frames.part{index}.tmp"))).collect()
    }
}

/// v4:场景检测挪到 fps=2 降采样之后,showinfo 报告的 raw `pts:` 落在 fps 滤镜
/// 自己选的输出时基里(实测 time_base=1/2,pts=2 表示 t=1s),不再等于源流的
/// tb_num/tb_den。改用 `pts_time:`(滤镜链任何一段都以秒为单位、与源时基无关)
/// 再乘回源 tb_den/tb_num 换算成素材自己的 tick。
/// R14:`select='eq(n,0)+…'` 放出来的第一帧靠 showinfo 的 `n: 0` 识别,不靠 `pts_time>0`——
/// 首帧 pts 不为 0 的文件(B 帧延迟/编辑列表,合成夹具首帧落在 0.1 s)会把它当成一个切点。
fn scene_cuts_from_log(log: &str, tb_num: i64, tb_den: i64) -> Vec<i64> {
    let mut scene_cuts = log
        .lines()
        .filter(|line| line.contains("showinfo") && line.contains("pts_time:"))
        .filter(|line| showinfo_index(line).is_none_or(|index| index > 0))
        .filter_map(|line| token_prefixed_f64(line, "pts_time:"))
        .filter(|seconds| *seconds > 0.0)
        .map(|seconds| seconds_to_ticks(seconds, tb_num, tb_den))
        .collect::<Vec<_>>();
    scene_cuts.sort_unstable();
    scene_cuts.dedup();
    scene_cuts
}

fn parse_signal_log(
    log: &str,
    has_audio: bool,
    tb_num: i64,
    tb_den: i64,
) -> Result<ParsedSignals> {
    let yavg = values_after(log, "lavfi.signalstats.YAVG=");
    let ymin = values_after(log, "lavfi.signalstats.YMIN=");
    let yhigh = values_after(log, "lavfi.signalstats.YHIGH=");
    let ymax = values_after(log, "lavfi.signalstats.YMAX=");
    if yavg.is_empty() || yavg.len() != ymin.len() || yavg.len() != yhigh.len() || yavg.len() != ymax.len() {
        return Err(CoreError::Analysis(format!(
            "signalstats 输出不完整：YAVG {} 项，YMIN {} 项，YHIGH {} 项，YMAX {} 项",
            yavg.len(),
            ymin.len(),
            yhigh.len(),
            ymax.len()
        )));
    }
    let ylow = values_after(log, "lavfi.signalstats.YLOW=");
    let brng = values_after(log, "lavfi.signalstats.BRNG=");
    let blur = values_after(log, "lavfi.blur=");
    let entropy = values_after(log, "lavfi.entropy.entropy.normal.Y=");
    let motion = values_after(log, "lavfi.vmafmotion.score=");

    let frames = yhigh.len();
    // blurdetect emits NaN for frames without measurable edges. Keep the
    // original arrays aligned for per-frame guards, but exclude undefined
    // samples from means: SQLite represents NaN as NULL (NOT NULL violation).
    let mean = |values: &[f64]| -> f64 {
        let (sum, count) = values.iter().filter(|value| value.is_finite())
            .fold((0.0, 0_usize), |(sum, count), value| (sum + value, count + 1));
        if count == 0 { 0.0 } else { sum / count as f64 }
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

    // 欠曝:10 百分位贴近黑位 且 整帧偏暗 且 没有高光(见 `frame_underexposed`)。
    let underexposed_frames = if ylow.len() == yavg.len() {
        (0..frames)
            .filter(|index| frame_underexposed(ylow[*index], yavg[*index], ymax[*index]))
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

    let scene_cuts = scene_cuts_from_log(log, tb_num, tb_den);

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

/// showinfo 行里的帧序号:`n:   3`(冒号后有对齐空格,值是下一个 token)。
fn showinfo_index(line: &str) -> Option<u64> {
    let mut tokens = line.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == "n:" {
            return tokens.next()?.parse().ok();
        }
        if let Some(value) = token.strip_prefix("n:") {
            return value.parse().ok();
        }
    }
    None
}

/// 取形如 `pts_time:1.5` 的单个 token(前缀与值中间没有空格)。
fn token_prefixed_f64(line: &str, prefix: &str) -> Option<f64> {
    line.split_whitespace()
        .find_map(|token| token.strip_prefix(prefix).and_then(|value| value.parse::<f64>().ok()))
}

/// `ticks_to_seconds` 的反函数:把滤镜链自己时基下的秒数换算回素材自己的 tick。
fn seconds_to_ticks(seconds: f64, tb_num: i64, tb_den: i64) -> i64 {
    if tb_num <= 0 || tb_den <= 0 || !seconds.is_finite() {
        return 0;
    }
    (seconds * tb_den as f64 / tb_num as f64).round() as i64
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
            windows: crate::core::moments::WindowSignals::default(),
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
    fn analysis_filter_runs_scene_detection_after_downscale_and_bumps_pipeline_version() {
        assert_eq!(ANALYSIS_PIPELINE_VERSION, "analyze_l1/v5");
        let args = analysis_args(Path::new("/x.mp4"), 0.25, false, true, None);
        let joined = args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.starts_with("-hide_banner -nostdin -hwaccel videotoolbox -i"));
        let filter = args.iter().position(|a| a == "-filter_complex").map(|i| args[i + 1].to_string_lossy().into_owned()).unwrap();
        // R14:场景检测在 10 fps 上比相邻帧,统计量再抽到 2 fps。
        assert!(filter.starts_with("[0:v:0]fps=10,scale=640:-2,format=yuv420p,split=2[scene_src][stats_src]"));
        assert!(filter.contains("[scene_src]select='eq(n,0)+gt(scene,0.25)',showinfo[scene_out]"));
        assert!(filter.contains("[stats_src]fps=2,signalstats"));
        assert_eq!(SCENE_THRESHOLD, 0.25);
    }

    // ---- R15-perf:分段并行解码 ----

    #[test]
    fn segment_plan_only_splits_long_clips_and_never_beyond_the_borrowed_slots() {
        assert!(segment_plan(30.0, 3).is_empty(), "短于两段的素材不分");
        assert!(segment_plan(300.0, 0).is_empty(), "没借到许可就不分");
        assert!(segment_plan(f64::NAN, 3).is_empty());
        assert_eq!(segment_plan(100.0, 3).len(), 2, "100 s 只够两段 40 s");
        assert_eq!(segment_plan(300.0, 1).len(), 2);
        assert_eq!(segment_plan(3600.0, 9).len(), MAX_SEGMENTS);
    }

    #[test]
    fn segment_plan_boundaries_sit_on_half_second_grid_with_half_second_context() {
        let plan = segment_plan(300.0, 3);
        assert_eq!(
            plan,
            vec![
                Segment { start: 0.0, seek: 0.0, end: Some(75.0) },
                Segment { start: 75.0, seek: 74.5, end: Some(150.0) },
                Segment { start: 150.0, seek: 149.5, end: Some(225.0) },
                Segment { start: 225.0, seek: 224.5, end: None },
            ]
        );
        assert_eq!(plan[1].length(), Some(75.5));
        assert_eq!(plan[3].length(), None);
        // 不整除时段界仍落在 0.5 s 格点上。
        for segment in segment_plan(299.0, 2) {
            assert_eq!((segment.start * 2.0).fract(), 0.0, "{segment:?}");
        }
    }

    #[test]
    fn segment_args_seek_before_input_and_carry_only_the_video_filter() {
        let args = analysis_segment_args(Path::new("/x.mp4"), 0.25, true, 74.5, Some(75.5), None);
        let joined = args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.starts_with("-hide_banner -nostdin -hwaccel videotoolbox -ss 74.500 -t 75.500 -i /x.mp4"), "{joined}");
        assert!(joined.contains("[stats_src]fps=2,signalstats"));
        assert!(!joined.contains("[0:a:0]"), "分段进程不碰音频");
        assert!(!joined.contains("-vn"));
        let last = analysis_segment_args(Path::new("/x.mp4"), 0.25, false, 224.5, None, None);
        let joined = last.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.starts_with("-hide_banner -nostdin -ss 224.500 -i /x.mp4"), "{joined}");
        assert!(!joined.contains(" -t "), "最后一段解到片尾");
        let audio = analysis_audio_args(Path::new("/x.mp4"));
        let joined = audio.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.contains("[0:a:0]asplit=2[a_all][a_win]"));
        assert!(!joined.contains("[0:v:0]"));
        assert!(!joined.contains("-hwaccel"));
    }

    #[test]
    fn rebase_segment_log_shifts_timestamps_and_trims_context_and_overrun() {
        // 第二段:负责 [75, 150),实际从 74.5 解起;日志里的时间从 0 计。
        let segment = Segment { start: 75.0, seek: 74.5, end: Some(150.0) };
        let log = "\
[Parsed_metadata_11 @ 0x1] frame:0    pts:0       pts_time:0
[Parsed_metadata_11 @ 0x1] lavfi.signalstats.YAVG=1
[Parsed_metadata_11 @ 0x1] frame:1    pts:1       pts_time:0.5
[Parsed_metadata_11 @ 0x1] lavfi.signalstats.YAVG=2
[Parsed_showinfo_5 @ 0x2] n:   0 pts:      0 pts_time:0       duration:      1
[Parsed_showinfo_5 @ 0x2] n:   7 pts:      7 pts_time:0.7     duration:      1
[Parsed_metadata_11 @ 0x1] frame:150  pts:150     pts_time:75
[Parsed_metadata_11 @ 0x1] lavfi.signalstats.YAVG=3
[Parsed_metadata_11 @ 0x1] frame:151  pts:151     pts_time:75.5
[Parsed_metadata_11 @ 0x1] lavfi.signalstats.YAVG=4
frame=  151 fps=0.0 q=-0.0 size=N/A
";
        let rebased = rebase_segment_log(log, segment);
        let yavg = values_after(&rebased, "lavfi.signalstats.YAVG=");
        assert_eq!(yavg, vec![2.0, 3.0], "74.5 是上下文、150 越界,留下 75.0 与 149.5 两窗");
        assert!(rebased.contains("frame:1    pts:1       pts_time:75"), "{rebased}");
        assert!(rebased.contains("frame:150  pts:150     pts_time:149.5"), "{rebased}");
        assert!(!rebased.contains("pts_time:0.5"));
        assert!(!rebased.contains("pts_time:150"));
        // showinfo:上下文里的 n:0 被裁掉,75.2 s 的切点保留并换算成绝对时间。
        assert!(!rebased.contains("n:   0"), "{rebased}");
        assert!(rebased.contains("n:   7 pts:      7 pts_time:75.2"), "{rebased}");
        assert_eq!(scene_cuts_from_log(&rebased, 1, 10), vec![752]);
        // 与解析无关的进度行原样保留。
        assert!(rebased.contains("frame=  151 fps=0.0"));
        // 最后一段没有上界。
        let tail = rebase_segment_log(log, Segment { start: 75.0, seek: 74.5, end: None });
        assert_eq!(values_after(&tail, "lavfi.signalstats.YAVG="), vec![2.0, 3.0, 4.0]);
    }

    /// 真 ffmpeg:2 分钟合成素材(有硬切、有运动、有音频),定死 1 段与 3 段各跑一遍,
    /// 统计量、场景切点与时刻窗口必须一致——分段只是解码方式,不是另一种分析。
    #[test]
    fn segmented_analysis_matches_the_single_pass_on_a_two_minute_fixture() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("two-minutes.mp4");
        if !generate_fixture(
            &path,
            &[
                "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=50",
                "-f", "lavfi", "-i", "color=c=white:s=320x180:r=10:d=20",
                "-f", "lavfi", "-i", "testsrc=s=320x180:r=10:d=55",
                "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:d=125",
                "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
                "-map", "[v]", "-map", "3:a", "-t", "125",
                "-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac",
            ],
        ) {
            eprintln!("skipping two-minute fixture: encoder unavailable");
            return;
        }
        let source = fixture_source(&path);
        let duration_seconds = ticks_to_seconds(source.duration_ticks, source.tb_num, source.tb_den).unwrap();
        assert!(duration_seconds >= 120.0, "夹具至少两分钟,实际 {duration_seconds}");
        let has_audio = probe_has_audio(&path, &ffprobe).unwrap();
        assert!(has_audio);

        let (single_log, single_segments) =
            run_analysis_pass(&ffmpeg, &path, duration_seconds, SCENE_THRESHOLD, has_audio, Some(1), None).unwrap();
        let (split_log, split_segments) =
            run_analysis_pass(&ffmpeg, &path, duration_seconds, SCENE_THRESHOLD, has_audio, Some(3), None).unwrap();
        assert_eq!(single_segments, 1);
        assert_eq!(split_segments, 3);

        let single = parse_signal_log(&single_log, has_audio, source.tb_num, source.tb_den).unwrap();
        let split = parse_signal_log(&split_log, has_audio, source.tb_num, source.tb_den).unwrap();
        assert_eq!(split.scene_cuts, single.scene_cuts, "场景切点必须逐个一致");
        // blurdetect 在没有边缘的帧上给 NaN,NaN != NaN,按位比较。
        let same_series = |marker: &str| {
            let left = values_after(&split_log, marker);
            let right = values_after(&single_log, marker);
            assert_eq!(left.len(), right.len(), "{marker} 样本数");
            for (index, (l, r)) in left.iter().zip(right.iter()).enumerate() {
                assert!(l.to_bits() == r.to_bits() || (l - r).abs() < 1e-9, "{marker}[{index}]: {l} vs {r}");
            }
        };
        same_series("lavfi.signalstats.YAVG=");
        same_series("lavfi.blur=");
        same_series("lavfi.vmafmotion.score=");
        for (name, left, right) in [
            ("exposure_yavg", split.exposure_yavg, single.exposure_yavg),
            ("overexposed_ratio", split.overexposed_ratio, single.overexposed_ratio),
            ("underexposed_ratio", split.underexposed_ratio, single.underexposed_ratio),
            ("dynamic_range", split.dynamic_range, single.dynamic_range),
            ("blur_mean", split.blur_mean, single.blur_mean),
            ("entropy_mean", split.entropy_mean, single.entropy_mean),
            ("motion_mean", split.motion_mean, single.motion_mean),
            ("out_of_focus_ratio", split.out_of_focus_ratio, single.out_of_focus_ratio),
        ] {
            assert!((left - right).abs() < 1e-9, "{name}: 分段 {left} vs 单进程 {right}");
        }
        assert_eq!(split.audio_peak_db, single.audio_peak_db);
        assert_eq!(split.audio_clipped, single.audio_clipped);

        let single_windows = super::super::moments::WindowSignals::parse(&single_log);
        let split_windows = super::super::moments::WindowSignals::parse(&split_log);
        assert_eq!(split_windows.video.len(), single_windows.video.len());
        assert_eq!(split_windows.audio.len(), single_windows.audio.len());
        for (left, right) in split_windows.video.iter().zip(single_windows.video.iter()) {
            assert!((left.t_secs - right.t_secs).abs() < 1e-6, "{} vs {}", left.t_secs, right.t_secs);
            assert_eq!(left.yavg, right.yavg);
            assert_eq!(left.motion, right.motion);
        }
    }

    #[test]
    fn motion_branch_is_only_added_when_a_handoff_path_is_given() {
        let plain = analysis_args(Path::new("/x.mp4"), 0.25, false, true, None);
        let joined = plain.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(!joined.contains("motion_out") && !joined.contains("rawvideo"));

        let with = analysis_args(Path::new("/x.mp4"), 0.25, true, true, Some(Path::new("/c/1/motion-frames.part0.tmp")));
        let joined = with.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        let filter = with.iter().position(|a| a == "-filter_complex").map(|i| with[i + 1].to_string_lossy().into_owned()).unwrap();
        // 运镜链挂在解码后、缩放前的原始流上,与运镜任务自己的 `-vf` 一字不差。
        assert!(filter.starts_with("[0:v:0]split=2[l1_src][motion_src];[l1_src]fps=10,scale=640:-2,format=yuv420p,split=2[scene_src][stats_src]"), "{filter}");
        assert!(filter.contains(&format!("[motion_src]{}[motion_out]", super::super::motion::gray_frame_filter())), "{filter}");
        assert!(joined.ends_with("-map [motion_out] -an -pix_fmt gray -f rawvideo -y /c/1/motion-frames.part0.tmp"), "{joined}");
        assert!(!joined.contains("-frames:v"), "单进程不限帧数");

        let segment = analysis_segment_args(Path::new("/x.mp4"), 0.25, true, 74.5, Some(75.5), Some((Path::new("/c/1/p1.tmp"), Some(152))));
        let joined = segment.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
        assert!(joined.ends_with("-map [motion_out] -frames:v 152 -an -pix_fmt gray -f rawvideo -y /c/1/p1.tmp"), "{joined}");
        assert_eq!(Segment { start: 75.0, seek: 74.5, end: Some(150.0) }.motion_frames(), (1, Some(150)));
        assert_eq!(Segment { start: 0.0, seek: 0.0, end: Some(75.0) }.motion_frames(), (0, Some(150)));
        assert_eq!(Segment { start: 225.0, seek: 224.5, end: None }.motion_frames(), (1, None));
    }

    /// 真 ffmpeg:分段 / 单进程两种跑法交接出来的采样帧,都与运镜任务自己解码得到的
    /// 逐字节相同——所以运镜结果不会因为省掉一次解码而变。
    #[test]
    fn handed_off_motion_frames_match_the_motion_jobs_own_decode() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("pan-two-minutes.mp4");
        if !generate_fixture(
            &path,
            &[
                "-f", "lavfi", "-i",
                "nullsrc=size=360x280:rate=10:duration=125,geq=lum='mod(X*19+Y*37+X*Y,220)+16':cb=128:cr=128,crop=240:180:x='60+mod(n,60)':y=50",
                "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", "-an",
            ],
        ) {
            eprintln!("skipping handoff fixture: encoder unavailable");
            return;
        }
        let expected = super::super::motion::extract_gray_frames(&path, &ffmpeg).unwrap().concat();
        let source = fixture_source(&path);
        let duration_seconds = ticks_to_seconds(source.duration_ticks, source.tb_num, source.tb_den).unwrap();
        for (label, forced) in [("单进程", 1), ("三段", 3)] {
            let cache_root = directory.path().join(format!("cache-{forced}"));
            let handoff = MotionHandoff { cache_root: cache_root.clone(), clip_id: 5, quick_hash: "qh".into() };
            let (_, segments) =
                run_analysis_pass(&ffmpeg, &path, duration_seconds, SCENE_THRESHOLD, false, Some(forced), Some(&handoff)).unwrap();
            assert_eq!(segments, forced);
            let (frames_path, meta_path) = super::super::motion::handoff_paths(&cache_root, 5);
            assert!(meta_path.exists(), "{label}:交接说明缺失");
            let actual = std::fs::read(&frames_path).unwrap();
            assert_eq!(actual.len(), expected.len(), "{label}:帧数 {} vs {}", actual.len() / 25600, expected.len() / 25600);
            assert!(actual == expected, "{label}:采样帧与运镜任务自己解码的不一致");
            // 分段临时文件清干净。
            assert!(!cache_root.join("5").join("motion-frames.part0.tmp").exists());
        }
        let _ = ffprobe;
    }

    #[test]
    fn legacy_scene_threshold_setting_maps_to_the_current_default() {
        let directory = TestDirectory::new();
        let connection = crate::core::db::open_project(&directory.path().join("p.db")).unwrap();
        connection
            .execute(
                "INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?1, '0.35', 'now')",
                [crate::core::settings::SCENE_THRESHOLD_KEY],
            )
            .unwrap();
        assert_eq!(effective_scene_threshold(&connection).unwrap(), SCENE_THRESHOLD);
        connection
            .execute(
                "INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?1, '0.4', 'now')",
                [crate::core::settings::SCENE_THRESHOLD_KEY],
            )
            .unwrap();
        assert_eq!(effective_scene_threshold(&connection).unwrap(), 0.4);
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
[Parsed_showinfo_2] n: 0 pts: 0 pts_time:0
[Parsed_showinfo_2] n: 1 pts: 90000 pts_time:1
frame:0 pts:0
lavfi.signalstats.YAVG=20
lavfi.signalstats.YMIN=16
lavfi.signalstats.YHIGH=250
lavfi.signalstats.YMAX=255
frame:1 pts:1
lavfi.signalstats.YAVG=200
lavfi.signalstats.YMIN=16
lavfi.signalstats.YHIGH=250
lavfi.signalstats.YMAX=255
[Parsed_astats_5] Peak level dB: -0.05
[Parsed_astats_5] Peak count: 4
[Parsed_astats_5] Dynamic range: 18.25
";
        let parsed = parse_signal_log(log, true, 1, 90_000).unwrap();

        assert_eq!(parsed.scene_cuts, vec![90_000]);
        assert_eq!(parsed.exposure_yavg, 110.0);
        assert_eq!(parsed.overexposed_ratio, 0.5);
        assert_eq!(parsed.audio_peak_db, Some(-0.05));
        assert_eq!(parsed.audio_dynamic_range_db, Some(18.25));
        assert!(parsed.audio_clipped);
    }

    #[test]
    fn undefined_flat_frame_blur_does_not_poison_analysis_storage() {
        let mut connection = analysis_connection();
        let source = insert_source(&connection, Path::new("flat.mov"), "flat");
        let log = "lavfi.signalstats.YAVG=235\nlavfi.signalstats.YMIN=235\nlavfi.signalstats.YHIGH=235\nlavfi.signalstats.YMAX=235\nlavfi.blur=nan\nlavfi.entropy.entropy.normal.Y=0\nlavfi.vmafmotion.score=0\n";
        let mut result = computation(Vec::new());
        result.signals = parse_signal_log(log, false, 1, 1000).unwrap();
        persist_analysis(&mut connection, &source, &result).unwrap();
        let stored = get_clip_analysis(&connection, source.clip_id).unwrap().unwrap();
        assert!(stored.blur_mean.is_finite());
        assert_eq!(stored.out_of_focus_ratio, 0.0);
        assert_eq!(stored.overexposed_ratio, 1.0);
    }

    #[test]
    fn real_ffmpeg_flat_4k_analysis_persists_without_retry() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return; };
        let directory = TestDirectory::new();
        let path = directory.path().join("flat-4k.mp4");
        assert!(generate_fixture(&path, &[
            "-f", "lavfi", "-i", "color=c=white:s=3840x2160:r=30:d=2",
            "-c:v", "mpeg4", "-q:v", "2", "-an",
        ]));
        let mut connection = analysis_connection();
        let source = insert_source(&connection, &path, "flat-4k");
        let result = analyze_source(&source, &ffmpeg, &ffprobe, SCENE_THRESHOLD).unwrap();
        persist_analysis(&mut connection, &source, &result).unwrap();
        let stored = get_clip_analysis(&connection, source.clip_id).unwrap().unwrap();
        assert!(stored.blur_mean.is_finite());
        assert_eq!(stored.overexposed_ratio, 1.0);
        assert_eq!(stored.out_of_focus_ratio, 0.0);
        assert_eq!(stored.tool_versions["signals"]["blur_valid_samples"], 0);
    }

    #[test]
    fn hardware_decode_failure_retries_with_software_decode() {
        // 硬解参数指向一个不存在的输入,必然非零退出;软解参数指向真实的
        // lavfi 生成素材。只有当软解重试真的执行了,才能拿到完整的滤镜输出
        // (含 signalstats 标记),证明重试不是摆设。
        let Some((ffmpeg, _)) = ffmpeg_tools() else { return; };
        let directory = TestDirectory::new();
        let good_path = directory.path().join("ok.mp4");
        assert!(generate_fixture(&good_path, &[
            "-f", "lavfi", "-i", "color=c=black:s=64x64:r=2:d=1",
        ]));
        let bogus_path = directory.path().join("does-not-exist.mp4");
        let hardware_args = analysis_args(&bogus_path, SCENE_THRESHOLD, false, true, None);
        let software_args = analysis_args(&good_path, SCENE_THRESHOLD, false, false, None);

        let log = run_analysis_ffmpeg_with_args(&ffmpeg, &good_path, &hardware_args, &software_args)
            .expect("software fallback must succeed after the deliberately-broken hardware attempt");
        assert!(
            log.contains("lavfi.signalstats.YAVG="),
            "log must carry the real filter output, proving the software retry actually ran: {log}"
        );
    }

    #[test]
    fn hardware_and_software_decode_both_failing_reports_both_errors() {
        let Some((ffmpeg, _)) = ffmpeg_tools() else { return; };
        let directory = TestDirectory::new();
        let bogus_path = directory.path().join("does-not-exist.mp4");
        let hardware_args = analysis_args(&bogus_path, SCENE_THRESHOLD, false, true, None);
        let software_args = analysis_args(&bogus_path, SCENE_THRESHOLD, false, false, None);

        let error =
            run_analysis_ffmpeg_with_args(&ffmpeg, &bogus_path, &hardware_args, &software_args)
                .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("VideoToolbox 硬解"), "{message}");
        assert!(message.contains("CPU 解码"), "{message}");
    }

    #[test]
    fn night_frames_with_highlights_are_not_underexposed_but_crushed_frames_are() {
        // R14:夜景每帧 YLOW=16、YAVG≈41 但 YMAX≈244(路灯/窗户);真欠曝最亮像素也到不了白位。
        let frame = |yavg: u32, ymax: u32| format!(
            "lavfi.signalstats.YAVG={yavg}\nlavfi.signalstats.YMIN=16\nlavfi.signalstats.YLOW=16\nlavfi.signalstats.YHIGH=86\nlavfi.signalstats.YMAX={ymax}\nlavfi.blur=5\nlavfi.entropy.entropy.normal.Y=5.6\nlavfi.vmafmotion.score=15\n"
        );
        let night = parse_signal_log(&format!("{}{}", frame(41, 244), frame(38, 242)), false, 1, 1000).unwrap();
        assert_eq!(night.underexposed_ratio, 0.0);
        let crushed = parse_signal_log(&format!("{}{}", frame(20, 166), frame(41, 244)), false, 1, 1000).unwrap();
        assert_eq!(crushed.underexposed_ratio, 0.5);
        assert!(frame_underexposed(16.0, 20.0, 166.0));
        assert!(!frame_underexposed(16.0, 41.0, 244.0));
        assert!(!frame_underexposed(16.0, 100.0, 166.0), "中灰正常、只是暗部压死不算欠曝");
    }

    #[test]
    fn signal_parser_rejects_incomplete_exposure_output() {
        let error = parse_signal_log("lavfi.signalstats.YAVG=42", false, 1, 1000).unwrap_err();
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
    fn first_selected_frame_with_nonzero_pts_is_not_a_scene_cut() {
        // R14:首帧 pts=0.1 s 的文件(合成夹具经 VideoToolbox 编码)此前被当成一个切点。
        let log = "\
[Parsed_showinfo_4 @ 0x1] n:   0 pts:      1 pts_time:0.1     duration:      1
[Parsed_showinfo_4 @ 0x1] n:   1 pts:     34 pts_time:3.4     duration:      1
";
        assert_eq!(scene_cuts_from_log(log, 1, 1000), vec![3400]);
        assert_eq!(showinfo_index("[Parsed_showinfo_4 @ 0x1] n:  12 pts: 1"), Some(12));
        assert_eq!(showinfo_index("[Parsed_showinfo_4 @ 0x1] n:7 pts: 1"), Some(7));
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

#[cfg(test)]
mod moments_fixture_tests {
    use std::path::Path;
    use std::process::{Command, Stdio};

    use super::*;
    use crate::core::moments::{compute_moments, MomentSource, MomentWeights};
    use crate::core::smart_select::{suggest_from_moments, MAX_SUGGESTIONS};
    use crate::core::test_support::TestDirectory;

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

    /// 12 s 合成素材:前 3 s 黑场静帧、中间 6 s 清晰运动(testsrc2)、后 3 s 纯白过曝;
    /// 全程 440 Hz 正弦(有声音、不是人声)。
    fn synthetic_clip(ffmpeg: &OsStr, path: &Path) -> bool {
        Command::new(ffmpeg)
            .args(["-y", "-v", "error"])
            .args(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=25:d=3"])
            .args(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=6"])
            .args(["-f", "lavfi", "-i", "color=c=white:s=320x180:r=25:d=3"])
            .args(["-f", "lavfi", "-i", "sine=f=440:d=12"])
            .args(["-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]"])
            .args(["-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
            .arg(path)
            .status()
            .is_ok_and(|status| status.success())
    }

    #[test]
    fn synthetic_black_good_white_clip_suggests_the_bright_moving_middle() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let path = directory.path().join("synthetic.mp4");
        assert!(synthetic_clip(&ffmpeg, &path), "合成素材生成失败");
        let metadata = crate::core::import::probe_media(&path).unwrap();
        let (windows, cuts, has_audio) =
            scan_windows(&path, metadata.tb_num, metadata.tb_den, metadata.duration_ticks, &ffmpeg, &ffprobe, SCENE_THRESHOLD).unwrap();
        assert!(has_audio);
        assert!(windows.video.len() >= 22 && windows.video.len() <= 25, "0.5 s 一窗:{}", windows.video.len());
        assert!(windows.audio.len() >= 22, "声音窗口:{}", windows.audio.len());
        let cuts = normalized_scene_cuts(&cuts, metadata.duration_ticks);
        assert_eq!(cuts.len(), 2, "3 s 与 9 s 两个切点:{cuts:?}");

        let source = MomentSource {
            clip_id: 1,
            quick_hash: "synthetic".to_owned(),
            tb_num: metadata.tb_num,
            tb_den: metadata.tb_den,
            duration_ticks: metadata.duration_ticks,
            has_audio,
        };
        let moments = compute_moments(&source, &windows, &cuts, &MomentWeights::default());
        let secs = |ticks: i64| crate::core::moments::ticks_to_seconds(ticks, metadata.tb_num, metadata.tb_den);
        let dark = moments.iter().filter(|m| secs(m.t_start_ticks) < 2.9).map(|m| m.score).fold(0.0, f64::max);
        let white = moments.iter().filter(|m| secs(m.t_start_ticks) >= 9.1).map(|m| m.score).fold(0.0, f64::max);
        let middle = moments.iter().filter(|m| (3.1..8.9).contains(&secs(m.t_start_ticks))).map(|m| m.score).fold(1.0, f64::min);
        assert!(middle > dark && middle > white, "中段最低分 {middle} 应高于黑场 {dark} 与过曝 {white}");
        assert!(moments.iter().all(|m| !m.speech), "正弦不是人声");
        assert!(moments.iter().any(|m| m.loud), "正弦有声音");

        let suggestions = suggest_from_moments(&moments, 5.0, MAX_SUGGESTIONS);
        assert!(!suggestions.is_empty());
        let best = &suggestions[0];
        let (in_s, out_s) = (secs(best.in_ticks), secs(best.out_ticks));
        assert!(in_s >= 2.9 && out_s <= 9.1, "建议段 {in_s:.2}–{out_s:.2} 应落在中段");
        assert!((out_s - in_s - 5.0).abs() < 0.6, "长度 {:.2}", out_s - in_s);
        assert!(best.reasons.iter().any(|r| r == "曝光正常"), "{:?}", best.reasons);
        eprintln!("synthetic suggestions: {suggestions:?}");
    }

    /// 真素材抽样(只读):`TRIPCUT_MOMENTS_SAMPLE=<路径> cargo test -- real_sample --ignored --nocapture`。
    #[test]
    #[ignore = "需要真素材路径,只用于报告抽样"]
    fn real_sample_suggestions_are_printed() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let Ok(sample) = std::env::var("TRIPCUT_MOMENTS_SAMPLE") else { return };
        let path = PathBuf::from(sample);
        let metadata = crate::core::import::probe_media(&path).unwrap();
        let started = Instant::now();
        let (windows, cuts, has_audio) =
            scan_windows(&path, metadata.tb_num, metadata.tb_den, metadata.duration_ticks, &ffmpeg, &ffprobe, SCENE_THRESHOLD).unwrap();
        let cuts = normalized_scene_cuts(&cuts, metadata.duration_ticks);
        let source = MomentSource {
            clip_id: 0,
            quick_hash: String::new(),
            tb_num: metadata.tb_num,
            tb_den: metadata.tb_den,
            duration_ticks: metadata.duration_ticks,
            has_audio,
        };
        let moments = compute_moments(&source, &windows, &cuts, &MomentWeights::default());
        let secs = |ticks: i64| crate::core::moments::ticks_to_seconds(ticks, metadata.tb_num, metadata.tb_den);
        eprintln!(
            "sample {} duration {:.2}s windows {} audio {} cuts {:?} scan {:?}",
            path.display(),
            secs(metadata.duration_ticks),
            moments.len(),
            has_audio,
            cuts.iter().map(|cut| secs(*cut)).collect::<Vec<_>>(),
            started.elapsed()
        );
        for moment in &moments {
            eprintln!(
                "  {:5.1}s score {:.2} sharp {:.2} motion {:.2} exp {} loud {} speech {} cut {} {:?}",
                secs(moment.t_start_ticks), moment.score, moment.sharp, moment.motion,
                u8::from(moment.exposure_ok), u8::from(moment.loud), u8::from(moment.speech), u8::from(moment.scene_cut), moment.reasons
            );
        }
        for suggestion in suggest_from_moments(&moments, 5.0, MAX_SUGGESTIONS) {
            eprintln!(
                "suggest {:.2}–{:.2}s score {:.2} {:?}",
                secs(suggestion.in_ticks), secs(suggestion.out_ticks), suggestion.score, suggestion.reasons
            );
        }
    }
}
