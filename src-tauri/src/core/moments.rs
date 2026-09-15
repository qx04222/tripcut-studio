//! R11 车道 B:时刻分——每 0.5 s 一个窗口,给画面(清晰/运动/曝光)与声音
//! (响度/人声)打一个 0–1 的分,落到 `clip_moments`(迁移 0043)。
//!
//! 信号全部来自 L1 分析那一次 ffmpeg 扫描的逐帧 `metadata=print` 日志
//! (`fps=2` 之后一帧正好一个窗口;音频按 `asetnsamples` 切成同样的 0.5 s),
//! 不再解码第二次。老库里已经分析过、但没有时刻分的素材由 `moments` 任务
//! (「补齐时刻分」)单独重扫一遍,失败可重跑、不动 `clip_analysis`。
//!
//! 打分看这六项(权重可在 `settings` 的 `moments.weights` 调,缺省够用):
//! 清晰 0.24、运动适中 0.20、曝光正常 0.16、声音有内容 0.12、无场景切换 0.08、内容少见 0.20。
//! R18 B-1:前五项全是画质/运镜/音量 —— 一面曝光正常、对焦锐利的白墙能拿接近满分。
//! 第六项 `interest` 把**内容信号**接进来(帧级 CLIP 向量:与全库平均画面的距离 +
//! 与本条其它帧的差异)。没有 CLIP 向量时(8 GB 档、侧车没起来、老库)这一项**从分母里剔除**,
//! 与 `has_audio` 同样的处理 —— 缺省权重按比例缩过,所以口径与 v2 逐位相同。

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
/// v3(R18):加第六项 `interest`;「有人声」不再只看峰均比(见 `window_has_speech`)。
/// 两条都改了打分口径,老库必须重算,否则同一条热力条上半段是 v2 分、下半段是 v3 分。
pub const MOMENTS_PIPELINE_VERSION: &str = "moments/v3";
pub const WEIGHT_KEYS: [&str; 6] = ["sharp", "motion", "exposure", "sound", "no_cut", "interest"];
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
// R18:光有「响 + 峰均比高」会把**成品混音的音乐**整条判成有人声 —— 2026-09-14 基线上
// 夜骑组四条(只有音乐、一句对白都没有)全中,负控 3/7。再加两道:
// ① 人声频段(300–3000 Hz)的突出度要比**这条素材自己的底色**高 ≥ 1 dB
//    (音乐床是这条片子的常态,人说话才是相对于常态的抬升 —— 用绝对阈值会被混音响度骗);
// ② 窗内响度要有音节级起伏(RMS_peak − RMS_trough ≥ 4 dB):说话有音头有停顿,
//    稳态的音乐床没有。
// 两个阈值在 21 条真素材上的**成立区间**是 ①0.75–1.5 dB × ②1–4 dB(区间内召回都是 12/12、
// 负控都 ≥6/7),取区间中部;不是卡在某一条素材边上的数。判据见 lane-aiscore-report.md。
const SPEECH_BAND_PROMINENCE_DB: f64 = 1.0;
const SPEECH_SYLLABIC_SPAN_DB: f64 = 4.0;
/// 人声频段的上下截止(Hz):滤波在 `analysis::audio_filter` 里做,这里只作为常量的出处。
pub const SPEECH_BAND_LOW_HZ: u32 = 300;
pub const SPEECH_BAND_HIGH_HZ: u32 = 3000;
const REASON_THRESHOLD: f64 = 0.6;
/// 兴趣度:CLIP 向量之间的余弦在真素材上普遍落在 0.5–0.95。
/// 0.95 = 和参照画面几乎一样(毫无新意,0 分);0.50 = 完全不像(满分)。
const INTEREST_COS_SAME: f64 = 0.95;
const INTEREST_COS_DISTINCT: f64 = 0.50;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MomentWeights {
    pub sharp: f64,
    pub motion: f64,
    pub exposure: f64,
    pub sound: f64,
    pub no_cut: f64,
    /// R18 B-1:内容少见度。缺省 0.20,其余五项按比例缩到 0.80 —— 没有 CLIP 向量时
    /// 这一项连分子带分母一起剔除,`weighted/total` 与 v2 逐位相同(缩放因子约掉了)。
    pub interest: f64,
}

impl Default for MomentWeights {
    fn default() -> Self {
        Self { sharp: 0.24, motion: 0.20, exposure: 0.16, sound: 0.12, no_cut: 0.08, interest: 0.20 }
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
                "interest" => weights.interest = number,
                other => {
                    return Err(CoreError::InvalidSchema(format!(
                        "时刻分权重不认识「{other}」;可用:{}",
                        WEIGHT_KEYS.join("、")
                    )))
                }
            }
        }
        if weights.total(true, true) <= 0.0 {
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

    fn total(&self, has_audio: bool, has_interest: bool) -> f64 {
        self.sharp
            + self.motion
            + self.exposure
            + self.no_cut
            + if has_audio { self.sound } else { 0.0 }
            + if has_interest { self.interest } else { 0.0 }
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
    /// 窗内短时 RMS 的最高/最低(astats 自己按内部小窗算的)。两者之差 = 音节级起伏。
    pub rms_peak_db: f64,
    pub rms_trough_db: f64,
}

/// 人声频段(300–3000 Hz)那一路的同一批窗口:只要 RMS,用来和全频段比。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpeechBandWindow {
    pub t_secs: f64,
    pub rms_db: f64,
}

/// ffmpeg 逐帧日志拆出来的窗口信号。画面窗口来自 `metadata=print`
/// (`[Parsed_metadata_*]`),声音窗口来自 `ametadata=print`(`[Parsed_ametadata_*]`)。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WindowSignals {
    pub video: Vec<VideoWindow>,
    pub audio: Vec<AudioWindow>,
    /// 与 `audio` 一一对应(同一个 `asetnsamples` 切法);老日志里没有这一路时为空,
    /// 「有人声」就退回只看响度 —— 见 `window_has_speech`。
    pub speech_band: Vec<SpeechBandWindow>,
}

#[derive(Clone, Copy, PartialEq)]
enum Block {
    None,
    Video,
    Audio,
}

/// 音频那一路现在有两个分支(全频段 / 人声频段),ffmpeg 把它们的 `ametadata=print` 块
/// 交错打在同一份日志里,块头一模一样 —— 只有块**里面**的 `lavfi.tripcut.speechband` 标记
/// 能分辨。所以不能像以前那样看到块头就 push,得把整块收齐再决定它是哪一路。
const SPEECH_BAND_MARKER: &str = "lavfi.tripcut.speechband";

impl WindowSignals {
    pub fn parse(log: &str) -> Self {
        let mut signals = Self::default();
        let mut block = Block::None;
        let mut t_secs = 0.0;
        let mut entries: Vec<(&str, f64)> = Vec::new();
        for line in log.lines() {
            if line.contains("frame:") && line.contains("pts_time:") && !line.contains("showinfo") {
                signals.flush(block, t_secs, &entries);
                entries.clear();
                let Some(parsed) = token_after(line, "pts_time:") else {
                    block = Block::None;
                    continue;
                };
                t_secs = parsed;
                block = if line.contains("[Parsed_ametadata_") {
                    Block::Audio
                } else if line.contains("[Parsed_metadata_") {
                    Block::Video
                } else {
                    Block::None
                };
                continue;
            }
            let Some(start) = line.find("lavfi.") else { continue };
            let Some((key, value)) = line[start..].split_once('=') else { continue };
            entries.push((key, value.trim().parse().unwrap_or(f64::NAN)));
        }
        signals.flush(block, t_secs, &entries);
        signals
    }

    fn flush(&mut self, block: Block, t_secs: f64, entries: &[(&str, f64)]) {
        let get = |name: &str| {
            entries
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| *value)
        };
        match block {
            Block::None => {}
            Block::Video => {
                if entries.is_empty() {
                    return;
                }
                self.video.push(VideoWindow {
                    t_secs,
                    yavg: get("lavfi.signalstats.YAVG").unwrap_or_default(),
                    ylow: get("lavfi.signalstats.YLOW").unwrap_or_default(),
                    yhigh: get("lavfi.signalstats.YHIGH").unwrap_or_default(),
                    ymax: get("lavfi.signalstats.YMAX").unwrap_or_default(),
                    blur: get("lavfi.blur").unwrap_or_default(),
                    entropy: get("lavfi.entropy.entropy.normal.Y").unwrap_or_default(),
                    motion: get("lavfi.vmafmotion.score").unwrap_or_default(),
                });
            }
            Block::Audio => {
                if entries.is_empty() {
                    return;
                }
                if get(SPEECH_BAND_MARKER).is_some() {
                    self.speech_band.push(SpeechBandWindow {
                        t_secs,
                        rms_db: get("lavfi.astats.Overall.RMS_level").unwrap_or_default(),
                    });
                } else {
                    self.audio.push(AudioWindow {
                        t_secs,
                        rms_db: get("lavfi.astats.Overall.RMS_level").unwrap_or_default(),
                        peak_db: get("lavfi.astats.Overall.Peak_level").unwrap_or_default(),
                        entropy: get("lavfi.astats.Overall.Entropy").unwrap_or_default(),
                        rms_peak_db: get("lavfi.astats.Overall.RMS_peak").unwrap_or_default(),
                        rms_trough_db: get("lavfi.astats.Overall.RMS_trough").unwrap_or_default(),
                    });
                }
            }
        }
    }

    /// 这条素材自己的「声音底色」:人声频段相对全频段的突出度中位数。
    /// 音乐床是常态,说话是相对常态的抬升 —— 用绝对阈值会被混音响度骗(见常量处的注释)。
    fn speech_band_baseline(&self) -> Option<f64> {
        let mut values: Vec<f64> = self
            .audio
            .iter()
            .zip(&self.speech_band)
            .filter(|(full, band)| full.rms_db.is_finite() && band.rms_db.is_finite())
            .map(|(full, band)| band.rms_db - full.rms_db)
            .collect();
        if values.is_empty() {
            return None;
        }
        values.sort_by(f64::total_cmp);
        // 下中位数:窗口数是偶数时偏向**安静**的那一侧。基线要代表「这条素材的常态」,
        // 偏高会把常态抬到说话那一档,闸就再也不响了。
        Some(values[(values.len() - 1) / 2])
    }
}

/// 一个窗口算不算「有人声」。三道都要过:
/// ① 够响且是尖峰型(老判据,拦住环境底噪);
/// ② 人声频段比这条素材自己的底色突出 ≥ 1 dB;
/// ③ 窗内有音节级起伏 ≥ 4 dB。
/// 日志里没有人声频段那一路(老日志 / 无音轨)时 ②③ 不成立 —— **失败朝闭**,
/// 判不出来就不说「有人声」,由转写覆盖去纠正。
pub fn window_has_speech(
    audio: &AudioWindow,
    band: Option<&SpeechBandWindow>,
    baseline_db: Option<f64>,
) -> bool {
    if !(audio.rms_db.is_finite() && audio.peak_db.is_finite()) {
        return false;
    }
    if audio.rms_db < SPEECH_RMS_DB || audio.peak_db - audio.rms_db < SPEECH_CREST_DB {
        return false;
    }
    let (Some(band), Some(baseline)) = (band, baseline_db) else { return false };
    if !band.rms_db.is_finite() {
        return false;
    }
    if band.rms_db - audio.rms_db - baseline < SPEECH_BAND_PROMINENCE_DB {
        return false;
    }
    if !(audio.rms_peak_db.is_finite() && audio.rms_trough_db.is_finite()) {
        return false;
    }
    audio.rms_peak_db - audio.rms_trough_db >= SPEECH_SYLLABIC_SPAN_DB
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
    /// R18 B-1:内容少见度 0–1。`None` = 这条素材没有帧级 CLIP 向量,这一项不参与打分,
    /// 也**不计入分母**(和 `has_audio` 一样)。`None` 与 `0.0` 含义完全不同,别合并。
    pub interest: Option<f64>,
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
    let interest = moment.interest.filter(|value| value.is_finite());
    let total = weights.total(has_audio, interest.is_some());
    let weighted = weights.sharp * moment.sharp
        + weights.motion * moderate
        + weights.exposure * exposure
        + weights.no_cut * no_cut
        + if has_audio { weights.sound * sound } else { 0.0 }
        + interest.map_or(0.0, |value| weights.interest * clamp01(value));
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
    if interest.is_some_and(|value| value >= REASON_THRESHOLD) {
        reasons.push("画面少见".to_owned());
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
    let baseline = windows.speech_band_baseline();
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
        let speech = audio
            .is_some_and(|a| window_has_speech(a, windows.speech_band.get(index), baseline));
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
            interest: None,
            score: 0.0,
            reasons: Vec::new(),
        };
        score_moment(&mut moment, weights, source.has_audio);
        moments.push(moment);
    }
    moments
}

/// 一帧相对某个参照向量的「少见度」:余弦 0.95(几乎一样)→ 0,0.50(完全不像)→ 1。
fn novelty(cosine: f32) -> f64 {
    let cosine = f64::from(cosine);
    clamp01((INTEREST_COS_SAME - cosine) / (INTEREST_COS_SAME - INTEREST_COS_DISTINCT))
}

/// 一帧的兴趣度(R18 B-1 的定义,两项各占一半):
/// ① **与全库平均画面的距离** —— 越不像「大家都在拍的东西」越值钱;
/// ② **与本条素材其它帧的差异** —— 越不像自己别处的画面越值钱(同一条里重复的空镜会被压下去)。
/// 本条只有一帧时第二项没有参照,退回只用第一项。
pub fn frame_interest(frames: &[Vec<f32>], index: usize, library_mean: &[f32]) -> Option<f64> {
    let frame = frames.get(index)?;
    let against_library = novelty(super::clip_search::cosine_similarity(frame, library_mean)?);
    let mut sums = Vec::new();
    for (other_index, other) in frames.iter().enumerate() {
        if other_index == index {
            continue;
        }
        if let Some(cosine) = super::clip_search::cosine_similarity(frame, other) {
            sums.push(f64::from(cosine));
        }
    }
    if sums.is_empty() {
        return Some(against_library);
    }
    let mean = sums.iter().sum::<f64>() / sums.len() as f64;
    let against_self = novelty(mean as f32);
    Some(0.5 * against_library + 0.5 * against_self)
}

/// 把帧级兴趣度铺到窗口上:每个窗口取**时间上最近**的那一帧。
/// `frames` 要按 `t_ticks` 排好;空表示这条素材没有帧级向量,`interest` 一律留 `None`。
pub fn apply_frame_interest(
    moments: &mut [Moment],
    frames: &[(i64, f64)],
    weights: &MomentWeights,
    has_audio: bool,
) {
    if frames.is_empty() {
        return;
    }
    for moment in moments.iter_mut() {
        let centre = (moment.t_start_ticks + moment.t_end_ticks) / 2;
        let nearest = frames
            .iter()
            .min_by_key(|(t_ticks, _)| (t_ticks - centre).abs())
            .map(|(_, interest)| *interest);
        moment.interest = nearest;
        score_moment(moment, weights, has_audio);
    }
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
    let frames = super::clip_search::clip_frame_interest(&transaction, source.clip_id)?;
    apply_frame_interest(&mut moments, &frames, &weights, source.has_audio);
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
            exposure_ok, loud, speech, scene_cut, score, reasons_json, interest, pipeline, computed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
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
            moment.interest,
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
                exposure_ok, loud, speech, scene_cut, score, reasons_json, interest
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
            interest: row.get(12)?,
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
        super::analysis::scan_windows(&path, tb_num, tb_den, duration_ticks, &ffmpeg, &ffprobe, scene_threshold)?;
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
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.RMS_peak=-20.9
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.RMS_trough=-21.4
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.Entropy=0.74
[Parsed_ametadata_18 @ 0x5] frame:0    pts:0       pts_time:0
[Parsed_ametadata_18 @ 0x5] lavfi.astats.Overall.RMS_level=-27.1
[Parsed_ametadata_18 @ 0x5] lavfi.tripcut.speechband=1
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
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.RMS_peak=-18.0
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.RMS_trough=-30.0
[Parsed_ametadata_16 @ 0x2] lavfi.astats.Overall.Entropy=0.9
[Parsed_ametadata_18 @ 0x5] frame:1    pts:4000    pts_time:0.5
[Parsed_ametadata_18 @ 0x5] lavfi.astats.Overall.RMS_level=-19.0
[Parsed_ametadata_18 @ 0x5] lavfi.tripcut.speechband=1
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
        assert!(MomentWeights::parse(r#"{"sharp":0,"motion":0,"exposure":0,"sound":0,"no_cut":0,"interest":0}"#).is_err());
        // 老库只存了五个键:缺 `interest` 取缺省 0.20,不能报错(升级不能把老设置读崩)。
        assert_eq!(
            MomentWeights::parse(r#"{"sharp":0.5,"motion":0.2,"exposure":0.1,"sound":0.1,"no_cut":0.1}"#)
                .unwrap()
                .interest,
            MomentWeights::default().interest
        );
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
                interest: None, score: if index == 777 { 0.99 } else { 0.1 }, reasons: vec![],
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

    // ---- R18 B-1:第六项 `interest` ----

    fn window(interest: Option<f64>) -> Moment {
        Moment {
            clip_id: 1, win_index: 0, t_start_ticks: 0, t_end_ticks: 500,
            sharp: 0.7, motion: 20.0 / 100.0, exposure_ok: true, loud: true, speech: false,
            scene_cut: false, interest, score: 0.0, reasons: Vec::new(),
        }
    }

    /// 先红的那一条:技术指标**完全相同**、只有内容信号不同的两个窗口,分数必须分得开。
    /// v2 的公式里两者逐位相等 —— 这条在加 `interest` 之前必然红。
    #[test]
    fn content_signal_separates_two_technically_identical_windows() {
        let weights = MomentWeights::default();
        let (mut rare, mut plain) = (window(Some(0.9)), window(Some(0.1)));
        score_moment(&mut rare, &weights, true);
        score_moment(&mut plain, &weights, true);
        assert!(rare.score > plain.score, "少见 {} 应高于平庸 {}", rare.score, plain.score);
        assert!(rare.reasons.iter().any(|reason| reason == "画面少见"));
        assert!(!plain.reasons.iter().any(|reason| reason == "画面少见"));
    }

    /// 没有 CLIP(8 GB 档 / 侧车没起来 / 老库)时,`interest` 连分子带分母一起剔除,
    /// 分数与 v2 的口径**逐位相同** —— 缺省权重整体缩了 0.8,比值约掉了。
    #[test]
    fn missing_content_signal_keeps_the_v2_score_bit_for_bit() {
        let mut without = window(None);
        score_moment(&mut without, &MomentWeights::default(), true);
        let mut v2 = window(None);
        let legacy = MomentWeights { sharp: 0.3, motion: 0.25, exposure: 0.2, sound: 0.15, no_cut: 0.1, interest: 0.0 };
        score_moment(&mut v2, &legacy, true);
        assert!(
            (without.score - v2.score).abs() < 1e-12,
            "无 CLIP 时新旧缺省权重必须给出同一个分:{} vs {}",
            without.score,
            v2.score
        );
    }

    #[test]
    fn frame_interest_rewards_distance_from_the_library_and_from_its_own_siblings() {
        let mut common = vec![0.0_f32; 512];
        common[0] = 1.0;
        let mut odd = vec![0.0_f32; 512];
        odd[1] = 1.0;
        let frames = vec![common.clone(), common.clone(), odd.clone()];
        let usual = frame_interest(&frames, 0, &common).unwrap();
        let unusual = frame_interest(&frames, 2, &common).unwrap();
        assert!(unusual > usual, "少见的那一帧 {unusual} 应高于随大流的 {usual}");
        // 随大流的那一帧:与全库均值完全一致(0 分),但与本条里那一帧「怪的」不一样(满分)
        // —— 两项各半 = 0.5。少见的那一帧两项都满分 = 1.0。
        assert!((usual - 0.5).abs() < 1e-9, "{usual}");
        assert!((unusual - 1.0).abs() < 1e-9, "{unusual}");
    }

    #[test]
    fn frame_interest_lands_on_the_window_nearest_in_time() {
        let weights = MomentWeights::default();
        let mut moments: Vec<Moment> = (0..4)
            .map(|index| Moment { win_index: index, t_start_ticks: index * 500, t_end_ticks: index * 500 + 500, ..window(None) })
            .collect();
        apply_frame_interest(&mut moments, &[(100, 0.1), (1600, 0.9)], &weights, true);
        assert_eq!(moments[0].interest, Some(0.1));
        assert_eq!(moments[3].interest, Some(0.9));
        assert!(moments[3].score > moments[0].score);
    }

    // ---- R18:「有人声」判定 ----

    fn audio(rms: f64, peak: f64, span: f64) -> AudioWindow {
        AudioWindow { t_secs: 0.0, rms_db: rms, peak_db: peak, entropy: 0.8, rms_peak_db: rms, rms_trough_db: rms - span }
    }

    /// 成品混音的**音乐**:够响、峰均比也高(鼓点就是尖峰),但人声频段没有比这条素材
    /// 自己的底色更突出 —— 老判据判它「有人声」,新判据不判(基线负控 3/7 → 7/7 的那条)。
    #[test]
    fn steady_music_is_not_speech_even_when_loud_and_peaky() {
        let music = audio(-17.0, -3.0, 12.0);
        let band = SpeechBandWindow { t_secs: 0.0, rms_db: -22.0 };
        assert!(!window_has_speech(&music, Some(&band), Some(-5.0)), "带内突出度与底色持平,不算人声");
        let voice = SpeechBandWindow { t_secs: 0.0, rms_db: -19.0 };
        assert!(window_has_speech(&music, Some(&voice), Some(-5.0)), "带内比底色高 3 dB 才算");
    }

    /// 稳态的人声频段(没有音节起伏)也不算 —— 单簧管独奏就是这种。
    #[test]
    fn speech_needs_syllabic_dynamics() {
        let flat = audio(-17.0, -3.0, 1.0);
        let band = SpeechBandWindow { t_secs: 0.0, rms_db: -14.0 };
        assert!(!window_has_speech(&flat, Some(&band), Some(-5.0)));
    }

    /// 日志里没有人声频段那一路(老日志、无音轨)时**失败朝闭**:判不出来就不说有人声。
    #[test]
    fn missing_speech_band_never_claims_speech() {
        let loud = audio(-17.0, -3.0, 12.0);
        assert!(!window_has_speech(&loud, None, Some(-5.0)));
        assert!(!window_has_speech(&loud, Some(&SpeechBandWindow { t_secs: 0.0, rms_db: -10.0 }), None));
    }

    impl MomentSource {
        fn clone_for(&self, clip_id: i64) -> Self {
            Self { clip_id, ..self.clone() }
        }
    }
}
