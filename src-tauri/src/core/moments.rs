//! R11 车道 B:时刻分——每 0.5 s 一个窗口,给画面(清晰/运动/曝光)与声音
//! (响度/人声)打一个 0–1 的分,落到 `clip_moments`(迁移 0043)。
//!
//! 信号全部来自 L1 分析那一次 ffmpeg 扫描的逐帧 `metadata=print` 日志
//! (`fps=2` 之后一帧正好一个窗口;音频按 `asetnsamples` 切成同样的 0.5 s),
//! 不再解码第二次。老库里已经分析过、但没有时刻分的素材由 `moments` 任务
//! (「补齐时刻分」)单独重扫一遍,失败可重跑、不动 `clip_analysis`。
//!
//! 打分只看这五项(权重可在 `settings` 的 `moments.weights` 调,缺省够用):
//! 清晰 0.3、运动适中 0.25、曝光正常 0.2、声音有内容 0.15、无场景切换 0.1。

use std::collections::BTreeMap;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::analysis::{
    frame_underexposed, LOW_ENTROPY_GUARD, OVEREXPOSED_YAVG_THRESHOLD, OVEREXPOSED_YHIGH_THRESHOLD,
};
use super::error::{CoreError, Result};
use super::jobs::Job;

pub const MOMENT_WINDOW_SECS: f64 = 0.5;
/// 音频窗口:重采样到 8 kHz 后每 4000 个样本一窗 = 0.5 s,与画面窗口对齐。
pub const AUDIO_WINDOW_SAMPLE_RATE: u32 = 8000;
pub const AUDIO_WINDOW_SAMPLES: u32 = AUDIO_WINDOW_SAMPLE_RATE / 2;
/// 版本号变化会让 `enqueue_missing` 把旧时刻分重新排队。
/// v2(R14):「曝光正常」改用 L1 的 `frame_underexposed`(夜景有高光不算欠曝)。
pub const MOMENTS_PIPELINE_VERSION: &str = "moments/v2";
pub const WEIGHT_KEYS: [&str; 5] = ["sharp", "motion", "exposure", "sound", "no_cut"];
/// 热力条降采样上限。
pub const HEATMAP_MAX_POINTS: usize = 200;

// 清晰度:blurdetect 边缘宽度 3 → 1.0,12 → 0(正常素材 4.0–6.3 落在 0.63–0.89)。
const SHARP_BLUR_FLOOR: f64 = 3.0;
const SHARP_BLUR_CEIL: f64 = 12.0;
// 运动适中:vmafmotion 归一(÷100)后 0.08–0.6 满分;静止帧 0 分;猛甩(1.0)0.2 分。
// 2026-09-13 用 DAY1 真素材标定:静止窗 0.00–0.03,正常手持/步行 0.07–0.30,甩镜/切换 0.6–0.7。
const MOTION_FULL_LOW: f64 = 0.08;
const MOTION_FULL_HIGH: f64 = 0.6;
const MOTION_WILD_SCORE: f64 = 0.2;
// 声音:窗口 RMS 高于 -35 dBFS 算「有声音」;人声启发式再要 RMS ≥ -30 且峰值比 RMS 高 ≥ 10 dB
// (语音是尖峰型;正弦/持续噪声峰均比只有 3–6 dB)。有转写时以 transcript_segments 覆盖。
const LOUD_RMS_DB: f64 = -35.0;
const SPEECH_RMS_DB: f64 = -30.0;
const SPEECH_CREST_DB: f64 = 10.0;
const REASON_THRESHOLD: f64 = 0.6;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MomentWeights {
    pub sharp: f64,
    pub motion: f64,
    pub exposure: f64,
    pub sound: f64,
    pub no_cut: f64,
}

impl Default for MomentWeights {
    fn default() -> Self {
        Self { sharp: 0.3, motion: 0.25, exposure: 0.2, sound: 0.15, no_cut: 0.1 }
    }
}

impl MomentWeights {
    /// 设置值是 JSON 对象,键只能是 `WEIGHT_KEYS`,值 0–1;缺的键取缺省;总和必须 > 0。
    pub fn parse(json: &str) -> Result<Self> {
        let map: BTreeMap<String, serde_json::Value> = serde_json::from_str(json)
            .map_err(|error| CoreError::InvalidSchema(format!("时刻分权重不是 JSON 对象:{error}")))?;
        let mut weights = Self::default();
        for (key, value) in &map {
            let number = value
                .as_f64()
                .filter(|number| number.is_finite() && (0.0..=1.0).contains(number))
                .ok_or_else(|| CoreError::InvalidSchema(format!("时刻分权重 {key} 必须是 0–1 的数")))?;
            match key.as_str() {
                "sharp" => weights.sharp = number,
                "motion" => weights.motion = number,
                "exposure" => weights.exposure = number,
                "sound" => weights.sound = number,
                "no_cut" => weights.no_cut = number,
                other => {
                    return Err(CoreError::InvalidSchema(format!(
                        "时刻分权重不认识「{other}」;可用:{}",
                        WEIGHT_KEYS.join("、")
                    )))
                }
            }
        }
        if weights.total(true) <= 0.0 {
            return Err(CoreError::InvalidSchema("时刻分权重不能全为 0".to_owned()));
        }
        Ok(weights)
    }

    pub fn load(connection: &Connection) -> Result<Self> {
        match super::settings::setting_value(connection, super::settings::MOMENT_WEIGHTS_KEY)? {
            Some(json) => Self::parse(&json),
            None => Ok(Self::default()),
        }
    }

    fn total(&self, has_audio: bool) -> f64 {
        self.sharp + self.motion + self.exposure + self.no_cut + if has_audio { self.sound } else { 0.0 }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct VideoWindow {
    pub t_secs: f64,
    pub yavg: f64,
    pub ylow: f64,
    pub yhigh: f64,
    pub ymax: f64,
    /// blurdetect 对没有边缘的帧给 NaN,保留原值由打分处理。
    pub blur: f64,
    pub entropy: f64,
    pub motion: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AudioWindow {
    pub t_secs: f64,
    pub rms_db: f64,
    pub peak_db: f64,
    pub entropy: f64,
}

/// ffmpeg 逐帧日志拆出来的窗口信号。画面窗口来自 `metadata=print`
/// (`[Parsed_metadata_*]`),声音窗口来自 `ametadata=print`(`[Parsed_ametadata_*]`)。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WindowSignals {
    pub video: Vec<VideoWindow>,
    pub audio: Vec<AudioWindow>,
}

#[derive(Clone, Copy, PartialEq)]
enum Block {
    None,
    Video,
    Audio,
}

impl WindowSignals {
    pub fn parse(log: &str) -> Self {
        let mut signals = Self::default();
        let mut block = Block::None;
        for line in log.lines() {
            if line.contains("frame:") && line.contains("pts_time:") && !line.contains("showinfo") {
                let Some(t_secs) = token_after(line, "pts_time:") else { continue };
                if line.contains("[Parsed_ametadata_") {
                    block = Block::Audio;
                    signals.audio.push(AudioWindow { t_secs, ..AudioWindow::default() });
                } else if line.contains("[Parsed_metadata_") {
                    block = Block::Video;
                    signals.video.push(VideoWindow { t_secs, ..VideoWindow::default() });
                } else {
                    block = Block::None;
                }
                continue;
            }
            let Some(start) = line.find("lavfi.") else { continue };
            let Some((key, value)) = line[start..].split_once('=') else { continue };
            let value: f64 = value.trim().parse().unwrap_or(f64::NAN);
            match block {
                Block::Video => {
                    let Some(window) = signals.video.last_mut() else { continue };
                    match key {
                        "lavfi.signalstats.YAVG" => window.yavg = value,
                        "lavfi.signalstats.YLOW" => window.ylow = value,
                        "lavfi.signalstats.YHIGH" => window.yhigh = value,
                        "lavfi.signalstats.YMAX" => window.ymax = value,
                        "lavfi.blur" => window.blur = value,
                        "lavfi.entropy.entropy.normal.Y" => window.entropy = value,
                        "lavfi.vmafmotion.score" => window.motion = value,
                        _ => {}
                    }
                }
                Block::Audio => {
                    let Some(window) = signals.audio.last_mut() else { continue };
                    match key {
                        "lavfi.astats.Overall.RMS_level" => window.rms_db = value,
                        "lavfi.astats.Overall.Peak_level" => window.peak_db = value,
                        "lavfi.astats.Overall.Entropy" => window.entropy = value,
                        _ => {}
                    }
                }
                Block::None => {}
            }
        }
        signals
    }
}

fn token_after(line: &str, prefix: &str) -> Option<f64> {
    let start = line.find(prefix)? + prefix.len();
    line[start..].split_whitespace().next()?.parse().ok()
}

/// 一条素材的时刻分输入:从 `clips` 读,并带 L1 判定的「有没有音轨」。
#[derive(Debug, Clone)]
pub struct MomentSource {
    pub clip_id: i64,
    pub quick_hash: String,
    pub tb_num: i64,
    pub tb_den: i64,
    pub duration_ticks: i64,
    pub has_audio: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Moment {
    pub clip_id: i64,
    pub win_index: i64,
    pub t_start_ticks: i64,
    pub t_end_ticks: i64,
    /// 0–1,越大越清晰。
    pub sharp: f64,
    /// 0–1,画面运动量(vmafmotion ÷ 100);「适中」由打分函数判。
    pub motion: f64,
    pub exposure_ok: bool,
    pub loud: bool,
    pub speech: bool,
    pub scene_cut: bool,
    pub score: f64,
    /// 给人看的中文原因短语,如「清晰」「运动适中」「有人声」。
    pub reasons: Vec<String>,
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 }
}

fn sharpness(blur: f64, entropy: f64) -> f64 {
    if blur.is_finite() {
        clamp01(1.0 - (blur - SHARP_BLUR_FLOOR) / (SHARP_BLUR_CEIL - SHARP_BLUR_FLOOR))
    } else if entropy < LOW_ENTROPY_GUARD {
        0.0
    } else {
        0.5
    }
}

/// 运动适中度:静止 0,温和到正常手持满分,猛甩降到 0.2。
pub fn motion_moderation(motion: f64) -> f64 {
    let m = clamp01(motion);
    if m < MOTION_FULL_LOW {
        m / MOTION_FULL_LOW
    } else if m <= MOTION_FULL_HIGH {
        1.0
    } else {
        1.0 - (m - MOTION_FULL_HIGH) / (1.0 - MOTION_FULL_HIGH) * (1.0 - MOTION_WILD_SCORE)
    }
}

fn exposure_is_ok(window: &VideoWindow) -> bool {
    let over = window.yhigh >= OVEREXPOSED_YHIGH_THRESHOLD && window.yavg >= OVEREXPOSED_YAVG_THRESHOLD;
    let under = frame_underexposed(window.ylow, window.yavg, window.ymax);
    !over && !under
}

/// 打分 + 原因短语。`has_audio` 为假时声音权重不计入分母,免得无声素材整体吃亏。
pub fn score_moment(moment: &mut Moment, weights: &MomentWeights, has_audio: bool) {
    let moderate = motion_moderation(moment.motion);
    let sound = if moment.speech { 1.0 } else if moment.loud { 0.6 } else { 0.0 };
    let exposure = if moment.exposure_ok { 1.0 } else { 0.0 };
    let no_cut = if moment.scene_cut { 0.0 } else { 1.0 };
    let total = weights.total(has_audio);
    let weighted = weights.sharp * moment.sharp
        + weights.motion * moderate
        + weights.exposure * exposure
        + weights.no_cut * no_cut
        + if has_audio { weights.sound * sound } else { 0.0 };
    moment.score = if total > 0.0 { clamp01(weighted / total) } else { 0.0 };
    let mut reasons = Vec::new();
    if moment.sharp >= REASON_THRESHOLD {
        reasons.push("清晰".to_owned());
    }
    if moderate >= REASON_THRESHOLD {
        reasons.push("运动适中".to_owned());
    }
    if moment.exposure_ok {
        reasons.push("曝光正常".to_owned());
    }
    if moment.speech {
        reasons.push("有人声".to_owned());
    } else if moment.loud {
        reasons.push("有声音".to_owned());
    }
    moment.reasons = reasons;
}

pub fn seconds_to_ticks(seconds: f64, tb_num: i64, tb_den: i64) -> i64 {
    (seconds * tb_den as f64 / tb_num.max(1) as f64).round() as i64
}

pub fn ticks_to_seconds(ticks: i64, tb_num: i64, tb_den: i64) -> f64 {
    if tb_den <= 0 { 0.0 } else { ticks as f64 * tb_num as f64 / tb_den as f64 }
}

/// 纯函数:窗口信号 → 时刻分列表(未套转写覆盖)。
pub fn compute_moments(
    source: &MomentSource,
    windows: &WindowSignals,
    scene_cuts: &[i64],
    weights: &MomentWeights,
) -> Vec<Moment> {
    let mut moments = Vec::with_capacity(windows.video.len());
    for (index, window) in windows.video.iter().enumerate() {
        let t_start = seconds_to_ticks(window.t_secs, source.tb_num, source.tb_den);
        if source.duration_ticks > 0 && t_start >= source.duration_ticks {
            break;
        }
        let mut t_end = seconds_to_ticks(window.t_secs + MOMENT_WINDOW_SECS, source.tb_num, source.tb_den);
        if source.duration_ticks > 0 {
            t_end = t_end.min(source.duration_ticks);
        }
        let audio = if source.has_audio { windows.audio.get(index) } else { None };
        let loud = audio.is_some_and(|a| a.rms_db.is_finite() && a.rms_db >= LOUD_RMS_DB);
        let speech = audio.is_some_and(|a| {
            a.rms_db.is_finite() && a.peak_db.is_finite()
                && a.rms_db >= SPEECH_RMS_DB
                && a.peak_db - a.rms_db >= SPEECH_CREST_DB
        });
        let scene_cut = index > 0 && scene_cuts.iter().any(|cut| *cut >= t_start && *cut < t_end);
        let mut moment = Moment {
            clip_id: source.clip_id,
            win_index: index as i64,
            t_start_ticks: t_start,
            t_end_ticks: t_end.max(t_start),
            sharp: sharpness(window.blur, window.entropy),
            motion: clamp01(window.motion / 100.0),
            exposure_ok: exposure_is_ok(window),
            loud,
            speech,
            scene_cut,
            score: 0.0,
            reasons: Vec::new(),
        };
        score_moment(&mut moment, weights, source.has_audio);
        moments.push(moment);
    }
    moments
}

/// 有转写时,「有人声」以 transcript_segments 为准(窗口与任一转写段相交)。
fn apply_transcript_override(connection: &Connection, moments: &mut [Moment], weights: &MomentWeights, has_audio: bool) -> Result<bool> {
    let Some(clip_id) = moments.first().map(|moment| moment.clip_id) else { return Ok(false) };
    let mut statement = connection.prepare(
        "SELECT start_ticks, end_ticks FROM transcript_segments WHERE clip_id = ?1 AND length(trim(text)) > 0",
    )?;
    let spans = statement
        .query_map([clip_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if spans.is_empty() {
        return Ok(false);
    }
    for moment in moments.iter_mut() {
        moment.speech = spans
            .iter()
            .any(|(start, end)| *start < moment.t_end_ticks && *end > moment.t_start_ticks);
        score_moment(moment, weights, has_audio);
    }
    Ok(true)
}

/// 落盘:整条素材的时刻分一次换掉(同一事务),素材变化时拒绝写旧结果。
pub fn persist_for_clip(
    connection: &mut Connection,
    source: &MomentSource,
    windows: &WindowSignals,
    scene_cuts: &[i64],
) -> Result<usize> {
    let weights = MomentWeights::load(connection)?;
    let mut moments = compute_moments(source, windows, scene_cuts, &weights);
    if moments.is_empty() {
        return Err(CoreError::Analysis(format!(
            "素材 {} 没有拿到任何画面窗口,无法算时刻分",
            source.clip_id
        )));
    }
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
            "素材 {} 在分析期间发生变化,未写入时刻分",
            source.clip_id
        )));
    }
    apply_transcript_override(&transaction, &mut moments, &weights, source.has_audio)?;
    transaction.execute("DELETE FROM clip_moments WHERE clip_id = ?1", [source.clip_id])?;
    let count = insert_moments(&transaction, &moments)?;
    transaction.commit()?;
    Ok(count)
}

fn insert_moments(connection: &Connection, moments: &[Moment]) -> Result<usize> {
    let mut statement = connection.prepare(
        "INSERT INTO clip_moments(
            clip_id, win_index, t_start_ticks, t_end_ticks, sharp, motion,
            exposure_ok, loud, speech, scene_cut, score, reasons_json, pipeline, computed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )?;
    for moment in moments {
        let reasons = serde_json::to_string(&moment.reasons)
            .map_err(|error| CoreError::Analysis(format!("无法保存时刻分原因:{error}")))?;
        statement.execute(params![
            moment.clip_id,
            moment.win_index,
            moment.t_start_ticks,
            moment.t_end_ticks,
            moment.sharp,
            moment.motion,
            i64::from(moment.exposure_ok),
            i64::from(moment.loud),
            i64::from(moment.speech),
            i64::from(moment.scene_cut),
            moment.score,
            reasons,
            MOMENTS_PIPELINE_VERSION,
        ])?;
    }
    Ok(moments.len())
}

/// 转写完成后重打「有人声」:只改 speech/score/reasons,不重扫画面。
pub fn refresh_speech_from_transcript(connection: &mut Connection, clip_id: i64) -> Result<bool> {
    let weights = MomentWeights::load(connection)?;
    let has_audio = connection
        .query_row("SELECT has_audio FROM clip_analysis WHERE clip_id = ?1", [clip_id], |row| row.get::<_, i64>(0))
        .optional()?
        .is_none_or(|flag| flag == 1);
    let mut moments = load_moments(connection, clip_id)?;
    if moments.is_empty() {
        return Ok(false);
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !apply_transcript_override(&transaction, &mut moments, &weights, has_audio)? {
        return Ok(false);
    }
    for moment in &moments {
        let reasons = serde_json::to_string(&moment.reasons)
            .map_err(|error| CoreError::Analysis(format!("无法保存时刻分原因:{error}")))?;
        transaction.execute(
            "UPDATE clip_moments SET speech = ?3, score = ?4, reasons_json = ?5
             WHERE clip_id = ?1 AND win_index = ?2",
            params![moment.clip_id, moment.win_index, i64::from(moment.speech), moment.score, reasons],
        )?;
    }
    transaction.commit()?;
    Ok(true)
}

/// 整条素材的全部窗口(按时间序)。
pub fn load_moments(connection: &Connection, clip_id: i64) -> Result<Vec<Moment>> {
    let mut statement = connection.prepare(
        "SELECT clip_id, win_index, t_start_ticks, t_end_ticks, sharp, motion,
                exposure_ok, loud, speech, scene_cut, score, reasons_json
           FROM clip_moments WHERE clip_id = ?1 ORDER BY win_index",
    )?;
    let rows = statement.query_map([clip_id], |row| {
        let reasons_json: String = row.get(11)?;
        Ok(Moment {
            clip_id: row.get(0)?,
            win_index: row.get(1)?,
            t_start_ticks: row.get(2)?,
            t_end_ticks: row.get(3)?,
            sharp: row.get(4)?,
            motion: row.get(5)?,
            exposure_ok: row.get::<_, i64>(6)? == 1,
            loud: row.get::<_, i64>(7)? == 1,
            speech: row.get::<_, i64>(8)? == 1,
            scene_cut: row.get::<_, i64>(9)? == 1,
            score: row.get(10)?,
            reasons: serde_json::from_str(&reasons_json).unwrap_or_default(),
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(CoreError::from)
}

/// 热力条用:按窗口降采样到 ≤ `HEATMAP_MAX_POINTS` 个点,每桶取分最高的窗口
/// (峰不被平均掉),时间跨度改成整桶。
pub fn get_clip_moments(connection: &Connection, clip_id: i64) -> Result<Vec<Moment>> {
    Ok(downsample(load_moments(connection, clip_id)?, HEATMAP_MAX_POINTS))
}

pub fn downsample(moments: Vec<Moment>, max_points: usize) -> Vec<Moment> {
    if moments.len() <= max_points || max_points == 0 {
        return moments;
    }
    let bucket = moments.len().div_ceil(max_points);
    moments
        .chunks(bucket)
        .map(|chunk| {
            let mut best = chunk
                .iter()
                .max_by(|a, b| a.score.total_cmp(&b.score))
                .cloned()
                .expect("chunk 非空");
            best.t_start_ticks = chunk[0].t_start_ticks;
            best.t_end_ticks = chunk[chunk.len() - 1].t_end_ticks;
            best.scene_cut = chunk.iter().any(|moment| moment.scene_cut);
            best
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 「补齐时刻分」任务(老库增量)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MomentsPayload {
    clip_id: i64,
    path: String,
    quick_hash: String,
}

/// 已有 L1 分析、却没有当前版本时刻分的素材,逐条排队。幂等:已排队/已跑完的不重复。
pub fn enqueue_missing(connection: &mut Connection) -> Result<usize> {
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT c.id, c.rel_path, c.quick_hash
             FROM clips c
             JOIN clip_analysis a ON a.clip_id = c.id
             WHERE c.missing_since IS NULL AND c.quick_hash IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM clip_moments m WHERE m.clip_id = c.id AND m.pipeline = ?1
               )
             ORDER BY c.id",
        )?;
        let rows = statement.query_map([MOMENTS_PIPELINE_VERSION], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut enqueued = 0;
    for (clip_id, rel_path, quick_hash) in candidates {
        let path = PathBuf::from(&rel_path);
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
    path: &std::path::Path,
    quick_hash: &str,
) -> Result<Option<i64>> {
    let payload = MomentsPayload {
        clip_id,
        path: path.to_string_lossy().into_owned(),
        quick_hash: quick_hash.to_owned(),
    };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Analysis(format!("无法创建时刻分任务:{error}")))?;
    let payload_hash =
        blake3::hash(format!("moments\0{clip_id}\0{quick_hash}\0{MOMENTS_PIPELINE_VERSION}").as_bytes())
            .to_hex()
            .to_string();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = transaction
        .query_row(
            "SELECT id FROM jobs
             WHERE kind = 'moments' AND payload_hash = ?1
               AND (status IN ('pending', 'running')
                    OR (status = 'done' AND EXISTS(SELECT 1 FROM clip_moments WHERE clip_id = ?2)))
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
        "INSERT INTO jobs(kind, payload, payload_hash, status, attempt, next_attempt_at, created_at, updated_at)
         VALUES ('moments', ?1, ?2, 'pending', 0,
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![payload_json, payload_hash],
    )?;
    let id = transaction.last_insert_rowid();
    transaction.commit()?;
    Ok(Some(id))
}

pub fn run_moments_job(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: MomentsPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Analysis(format!("时刻分任务数据无效:{error}")))?;
    let (tb_num, tb_den, duration_ticks, has_audio) = connection
        .query_row(
            "SELECT c.tb_num, c.tb_den, c.duration_ticks, COALESCE(a.has_audio, 1)
             FROM clips c LEFT JOIN clip_analysis a ON a.clip_id = c.id
             WHERE c.id = ?1 AND c.quick_hash = ?2",
            params![payload.clip_id, payload.quick_hash],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::Analysis(format!("素材 {} 已变化或不存在,拒绝写入旧时刻分", payload.clip_id)))?;
    let path = super::media_source::verified_clip_path(connection, payload.clip_id)
        .map_err(|error| CoreError::Analysis(error.to_string()))?;
    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let ffprobe = super::settings::configured_ffprobe(connection, &ffmpeg)?;
    let scene_threshold = super::analysis::effective_scene_threshold(connection)?;
    let (windows, cuts, probed_audio) =
        super::analysis::scan_windows(&path, tb_num, tb_den, &ffmpeg, &ffprobe, scene_threshold)?;
    let cuts = cuts.into_iter().filter(|cut| *cut > 0 && *cut < duration_ticks).collect::<Vec<_>>();
    let source = MomentSource {
        clip_id: payload.clip_id,
        quick_hash: payload.quick_hash,
        tb_num,
        tb_den,
        duration_ticks,
        has_audio: has_audio == 1 && probed_audio,
    };
    persist_for_clip(connection, &source, &windows, &cuts)?;
    Ok(())
}

/// 状态条「补齐时刻分 n/m」:当前集里已分析的素材,按有没有时刻分与任务状态计数。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MomentsProgress {
    pub total: u64,
    pub done: u64,
    pub failed: u64,
    pub running: u64,
    pub pending: u64,
}

pub fn progress(connection: &Connection) -> Result<MomentsProgress> {
    let (total, done) = connection.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(EXISTS(SELECT 1 FROM clip_moments m WHERE m.clip_id = c.id)), 0)
           FROM clips c JOIN clip_analysis a ON a.clip_id = c.id
          WHERE c.missing_since IS NULL
            AND (c.episode_id IS NULL OR c.episode_id = (SELECT id FROM episodes WHERE status = 'active'))",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let (failed, running, pending) = connection.query_row(
        "SELECT COALESCE(SUM(status IN ('failed', 'blocked')), 0),
                COALESCE(SUM(status = 'running'), 0),
                COALESCE(SUM(status = 'pending'), 0)
           FROM jobs WHERE kind = 'moments'",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
    )?;
    Ok(MomentsProgress {
        total: total.max(0) as u64,
        done: done.max(0) as u64,
        failed: failed.max(0) as u64,
        running: running.max(0) as u64,
        pending: pending.max(0) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    const SAMPLE_LOG: &str = "\
[Parsed_metadata_10 @ 0x1] frame:0    pts:0       pts_time:0
[Parsed_metadata_10 @ 0x1] lavfi.signalstats.YLOW=16
[Parsed_metadata_10 @ 0x1] lavfi.signalstats.YAVG=16
[Parsed_metadata_10 @ 0x1] lavfi.signalstats.YHIGH=16
[Parsed_metadata_10 @ 0x1] lavfi.signalstats.YMAX=16
[Parsed_metadata_10 @ 0x1] lavfi.blur=nan
[Parsed_metadata_10 @ 0x1] lavfi.entropy.entropy.normal.Y=0.000000
[Parsed_metadata_10 @ 0x1] lavfi.vmafmotion.score=0.00
[Parsed_ametadata_16 @ 0x2] frame:0    pts:0       pts_time:0
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.Peak_level=-17.7
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.RMS_level=-21.1
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.Entropy=0.74
[Parsed_showinfo_5 @ 0x3] n:   1 pts:      1 pts_time:0.5     duration:      1
[Parsed_metadata_10 @ 0x1] frame:1    pts:1       pts_time:0.5
[Parsed_metadata_10 @ 0x1] lavfi.signalstats.YLOW=40
[Parsed_metadata_10 @ 0x1] lavfi.signalstats.YAVG=110
[Parsed_metadata_10 @ 0x1] lavfi.signalstats.YHIGH=190
[Parsed_metadata_10 @ 0x1] lavfi.signalstats.YMAX=255
[Parsed_metadata_10 @ 0x1] lavfi.blur=4.5
[Parsed_metadata_10 @ 0x1] lavfi.entropy.entropy.normal.Y=6.8
[Parsed_metadata_10 @ 0x1] lavfi.vmafmotion.score=32.00
[Parsed_ametadata_16 @ 0x2] frame:1    pts:4000    pts_time:0.5
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.Peak_level=-8.0
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.RMS_level=-22.0
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.Entropy=0.9
[Parsed_astats_12 @ 0x4] Peak level dB: -13.44
";

    fn source(has_audio: bool) -> MomentSource {
        MomentSource { clip_id: 1, quick_hash: "h".into(), tb_num: 1, tb_den: 1000, duration_ticks: 1000, has_audio }
    }

    #[test]
    fn parses_video_and_audio_windows_from_interleaved_log() {
        let signals = WindowSignals::parse(SAMPLE_LOG);
        assert_eq!(signals.video.len(), 2);
        assert_eq!(signals.audio.len(), 2);
        assert_eq!(signals.video[1].t_secs, 0.5);
        assert_eq!(signals.video[1].blur, 4.5);
        assert_eq!(signals.video[1].motion, 32.0);
        assert!(signals.video[0].blur.is_nan());
        assert_eq!(signals.audio[1].peak_db, -8.0);
        assert_eq!(signals.audio[1].rms_db, -22.0);
    }

    #[test]
    fn black_still_window_scores_low_and_clear_moving_speech_window_scores_high() {
        let signals = WindowSignals::parse(SAMPLE_LOG);
        let moments = compute_moments(&source(true), &signals, &[500], &MomentWeights::default());
        assert_eq!(moments.len(), 2);
        let (dark, good) = (&moments[0], &moments[1]);
        assert!(!dark.exposure_ok && dark.sharp == 0.0 && !dark.speech);
        assert!(dark.score < 0.3, "黑场静帧 {}", dark.score);
        assert!(good.exposure_ok && good.speech && good.loud && good.scene_cut);
        assert!(good.score > 0.7, "清晰运动人声 {}", good.score);
        assert_eq!(good.reasons, vec!["清晰", "运动适中", "曝光正常", "有人声"]);
        assert_eq!((good.t_start_ticks, good.t_end_ticks), (500, 1000));
    }

    #[test]
    fn night_window_with_highlights_counts_as_exposure_ok() {
        // R14:夜景窗口(暗部贴黑、整帧偏暗,但有路灯/窗户高光)曝光是对的;
        // 同样的暗度没有任何高光才是欠曝。
        let night = VideoWindow { yavg: 41.0, ylow: 16.0, yhigh: 86.0, ymax: 244.0, blur: 5.0, entropy: 5.6, motion: 15.0, ..VideoWindow::default() };
        assert!(exposure_is_ok(&night));
        let under = VideoWindow { ymax: 166.0, ..night.clone() };
        assert!(!exposure_is_ok(&under));
    }

    #[test]
    fn clip_without_audio_is_not_penalised_for_silence() {
        let mut signals = WindowSignals::parse(SAMPLE_LOG);
        for audio in &mut signals.audio {
            audio.rms_db = -90.0;
            audio.peak_db = -85.0;
        }
        let silent = compute_moments(&source(true), &signals, &[], &MomentWeights::default());
        let without = compute_moments(&source(false), &signals, &[], &MomentWeights::default());
        assert!(!silent[1].loud && !without[1].loud && !without[1].speech);
        assert!(without[1].score > silent[1].score, "无音轨按四项归一,不该比「有音轨却没声」更低");
        assert!(without[1].score > 0.9);
    }

    #[test]
    fn weights_parse_rejects_unknown_keys_and_out_of_range() {
        assert!(MomentWeights::parse(r#"{"sharp":0.5}"#).is_ok());
        assert!(MomentWeights::parse(r#"{"hero":0.5}"#).is_err());
        assert!(MomentWeights::parse(r#"{"sharp":1.5}"#).is_err());
        assert!(MomentWeights::parse(r#"{"sharp":0,"motion":0,"exposure":0,"sound":0,"no_cut":0}"#).is_err());
        assert!(MomentWeights::parse("[]").is_err());
    }

    #[test]
    fn motion_moderation_is_zero_for_still_and_low_for_wild() {
        assert_eq!(motion_moderation(0.0), 0.0);
        assert_eq!(motion_moderation(0.3), 1.0);
        assert!((motion_moderation(1.0) - MOTION_WILD_SCORE).abs() < 1e-9);
    }

    #[test]
    fn downsample_keeps_peaks_and_caps_points() {
        let moments = (0..1000)
            .map(|index| Moment {
                clip_id: 1, win_index: index, t_start_ticks: index * 500, t_end_ticks: index * 500 + 500,
                sharp: 0.0, motion: 0.0, exposure_ok: true, loud: false, speech: false, scene_cut: false,
                score: if index == 777 { 0.99 } else { 0.1 }, reasons: vec![],
            })
            .collect();
        let sampled = downsample(moments, HEATMAP_MAX_POINTS);
        assert_eq!(sampled.len(), 200);
        assert!(sampled.iter().any(|moment| moment.score == 0.99));
        assert_eq!(sampled[0].t_start_ticks, 0);
        assert_eq!(sampled[199].t_end_ticks, 500_000);
    }

    fn library_with_analyzed_clip() -> (TestDirectory, Connection, i64) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, duration_ticks, tb_num, tb_den, imported_at, quick_hash, episode_id)
                 VALUES ('v', '/abs/clip.mov', 1000, 1, 1000, '2026-09-13T00:00:00Z', 'h',
                         (SELECT id FROM episodes WHERE status = 'active'))",
                [],
            )
            .unwrap();
        let clip_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO clip_analysis(clip_id, exposure_yavg, overexposed_ratio, audio_clipped, has_audio,
                    focus_scores, scene_count, analyzed_at, tool_versions)
                 VALUES (?1, 100, 0, 0, 1, '[]', 1, '2026-09-13T00:00:00Z', '{}')",
                [clip_id],
            )
            .unwrap();
        (directory, connection, clip_id)
    }

    /// V-01:媒体池闪电角标只认 `has_suggestions === true`,这一列必须由 `list_clips` 给——
    /// 时刻分落盘前 false,落盘后 true(此前 Rust 从不写它,真机 21 张卡片零角标)。
    #[test]
    fn list_clips_reports_has_suggestions_once_moments_are_persisted() {
        let (_directory, mut connection, clip_id) = library_with_analyzed_clip();
        let before = crate::core::import::list_clips(&connection).unwrap();
        assert_eq!(before[0].id, Some(clip_id));
        assert!(!before[0].has_suggestions, "没有时刻分就没有建议");

        let signals = WindowSignals::parse(SAMPLE_LOG);
        persist_for_clip(&mut connection, &source(true).clone_for(clip_id), &signals, &[500]).unwrap();
        let after = crate::core::import::list_clips(&connection).unwrap();
        assert!(after[0].has_suggestions, "时刻分落盘后角标亮起");
    }

    #[test]
    fn backfill_enqueue_is_idempotent_and_clears_once_moments_exist() {
        let (_directory, mut connection, clip_id) = library_with_analyzed_clip();
        assert_eq!(enqueue_missing(&mut connection).unwrap(), 1);
        assert_eq!(enqueue_missing(&mut connection).unwrap(), 0, "第二次不重复排队");
        let progress = super::progress(&connection).unwrap();
        assert_eq!((progress.total, progress.done, progress.pending), (1, 0, 1));

        let signals = WindowSignals::parse(SAMPLE_LOG);
        persist_for_clip(&mut connection, &source(true).clone_for(clip_id), &signals, &[500]).unwrap();
        connection.execute("UPDATE jobs SET status = 'done' WHERE kind = 'moments'", []).unwrap();
        assert_eq!(enqueue_missing(&mut connection).unwrap(), 0, "有了时刻分就不再排队");
        let progress = super::progress(&connection).unwrap();
        assert_eq!((progress.total, progress.done, progress.pending), (1, 1, 0));
        // 重跑幂等:再落盘一次行数不变。
        persist_for_clip(&mut connection, &source(true).clone_for(clip_id), &signals, &[500]).unwrap();
        let rows: i64 = connection.query_row("SELECT COUNT(*) FROM clip_moments", [], |row| row.get(0)).unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn transcript_overrides_speech_heuristic() {
        let (_directory, mut connection, clip_id) = library_with_analyzed_clip();
        let signals = WindowSignals::parse(SAMPLE_LOG);
        persist_for_clip(&mut connection, &source(true).clone_for(clip_id), &signals, &[]).unwrap();
        let before = load_moments(&connection, clip_id).unwrap();
        assert!(before[1].speech && !before[0].speech);
        connection
            .execute(
                "INSERT INTO transcript_segments(clip_id, seg_index, start_ticks, end_ticks, text) VALUES (?1, 0, 0, 400, '你好')",
                [clip_id],
            )
            .unwrap();
        assert!(refresh_speech_from_transcript(&mut connection, clip_id).unwrap());
        let after = load_moments(&connection, clip_id).unwrap();
        assert!(after[0].speech && !after[1].speech, "转写段只盖住第一窗");
        assert!(after[0].reasons.iter().any(|reason| reason == "有人声"));
        assert!(after[1].score < before[1].score);
    }

    impl MomentSource {
        fn clone_for(&self, clip_id: i64) -> Self {
            Self { clip_id, ..self.clone() }
        }
    }
}
