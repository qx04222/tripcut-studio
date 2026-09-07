//! 纯 Rust 的音乐节拍/段落分析（rustfft，无 C 依赖、无外部模型）。
//!
//! 管线：ffmpeg 解出单声道 22050 Hz s16le PCM → 2048/512 汉宁窗 STFT →
//! 谱通量包络 → 自相关估 BPM → 自适应阈值挑拍 → 8 秒滑窗的 RMS/谱心跳变切段。
//! 所有时间量都以 tb 1/1000000（微秒 tick）对外表达，与工程内其它 ticks 同源。

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::{self, Job};
use super::motion::execute_with_reader;

/// 音乐 tick 的时基：1/1000000 秒。
pub const MUSIC_TB_NUM: i64 = 1;
pub const MUSIC_TB_DEN: i64 = 1_000_000;
/// `decode_pcm` 固定输出的采样率。
pub const DECODE_SAMPLE_RATE: u32 = 22_050;

const TICKS_PER_SECOND: f64 = 1_000_000.0;
const FRAME: usize = 2048;
const HOP: usize = 512;
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;
/// 自相关按 0.1 BPM 步进搜索，滞后取小数并线性插值——整数帧滞后在
/// 22050/512 ≈ 43 帧每秒下只能分辨到 ±3 BPM（120 BPM 落在 21/22 帧之间）。
const BPM_STEP: f64 = 0.1;
/// 速度先验：对数正态，中心 120 BPM。只用来在同一条周期信号的
/// 谐波/次谐波（60 与 120）之间打破平局，不改变真实峰的位置。
const TEMPO_PRIOR_CENTER: f64 = 120.0;
const TEMPO_PRIOR_WIDTH: f64 = 0.7;
const THRESHOLD_WINDOW_SECONDS: f64 = 1.5;
const THRESHOLD_K: f32 = 1.0;
const MIN_BEAT_SEPARATION_SECONDS: f64 = 0.1;
/// 低于全曲通量峰值这一比例的局部极大值一律不算 onset——纯噪声段里
/// 相对阈值（均值+k·标准差）自己会缩到 0 附近，必须有绝对地板兜住。
const FLUX_FLOOR_RATIO: f32 = 0.05;
/// 自相关峰值/候选均值 的下限。这个比值对纯随机信号有系统性偏置——
/// candidate 数量（1401 个 0.1 BPM 档位、彼此高度相关）本身会把"峰/正值
/// 均值"这个比值顶到 4 左右，哪怕完全没有周期性；实测跨 160+ 个种子的
/// ±1 LSB 抖动白噪声，30 秒轨的置信度落在约 3.9–12.7。因此 3.0 这个原始
/// 设计值实际上几乎抓不住任何抖动噪声——已按审查意见的退路条款上调到
/// 5.0：120 BPM 点击音轨实测约 11.7，本文件里最弱的真实信号（`energy_
/// staircase_splits_into_sections_with_a_loud_middle` 的噪声铺底 120 BPM
/// 点击）实测约 8.8，都留有余量；而
/// `dithered_silence_reports_no_beats` 选用的种子实测约 3.95，明显低于
/// 5.0。这不是一个能保证覆盖每一种噪声实现的阈值（某些种子测得高达
/// 12.7，逼近甚至可能超过弱信号），只是把审查发现的"从不设防"改成"有
/// 一道有实测数据支撑的防线"。
const MIN_TEMPO_CONFIDENCE: f32 = 5.0;
const SECTION_WINDOW_SECONDS: f64 = 8.0;
const SECTION_NOVELTY_FLOOR: f32 = 0.08;
const BEATS_PER_BAR: usize = 4;
const CUT_DEDUPE_TICKS: i64 = 100_000;
const DECODE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const NO_BEATS: &str = "未检测到节拍";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatGrid {
    pub bpm: f64,
    pub beats_ticks: Vec<i64>,
    /// 必须保持升序——`persist_analysis` 用 `binary_search` 在这里查是否为下拍。
    pub downbeats_ticks: Vec<i64>,
    pub strengths: Vec<f32>,
    /// 自相关峰值与候选均值之比。1.0 附近说明没有明显周期性。
    pub confidence: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SectionLabel {
    Intro,
    Verse,
    Build,
    Climax,
    Outro,
    Other,
}

impl SectionLabel {
    pub fn as_str(self) -> &'static str {
        match self {
            SectionLabel::Intro => "intro",
            SectionLabel::Verse => "verse",
            SectionLabel::Build => "build",
            SectionLabel::Climax => "climax",
            SectionLabel::Outro => "outro",
            SectionLabel::Other => "other",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "intro" => Some(SectionLabel::Intro),
            "verse" => Some(SectionLabel::Verse),
            "build" => Some(SectionLabel::Build),
            "climax" => Some(SectionLabel::Climax),
            "outro" => Some(SectionLabel::Outro),
            "other" => Some(SectionLabel::Other),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub start_tick: i64,
    pub end_tick: i64,
    pub label: SectionLabel,
    pub energy: f32,
}

/// 仅供测试观察 `decode_pcm` 是否被调用——验证导入阶段不再靠整轨解码取时长。
/// `cargo test` 默认多线程并跑同一个测试二进制，这个计数器是进程级全局状态；
/// 任何测试读取或可能增量它之前都必须先拿 `DECODE_PCM_CALLS_LOCK`，否则并发
/// 跑到的另一个测试会在 `store(0)` 和 `load` 之间插一次 `decode_pcm` 调用，
/// 把断言变成偶发假红。
#[cfg(test)]
pub(crate) static DECODE_PCM_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub(crate) static DECODE_PCM_CALLS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 用 ffmpeg 把任意音频解成单声道 22050 Hz 的 16-bit PCM。
pub fn decode_pcm(ffmpeg: &OsStr, path: &Path) -> Result<(Vec<i16>, u32)> {
    #[cfg(test)]
    DECODE_PCM_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        path.as_os_str().to_owned(),
        OsString::from("-vn"),
        OsString::from("-map"),
        OsString::from("0:a:0?"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from(DECODE_SAMPLE_RATE.to_string()),
        OsString::from("-f"),
        OsString::from("s16le"),
        OsString::from("-"),
    ];
    let output = execute_with_reader(ffmpeg, &args, DECODE_TIMEOUT, read_pcm)
        .map_err(|error| {
            CoreError::Music(format!("ffmpeg 无法解码音乐 {}：{error}", path.display()))
        })?;
    if !output.success {
        let summary = String::from_utf8_lossy(&output.stderr);
        let summary = summary.trim();
        return Err(CoreError::Music(format!(
            "ffmpeg 解码音乐 {} 失败（退出码 {}）：{}",
            path.display(),
            output
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "信号中止".to_owned()),
            if summary.is_empty() { "没有错误输出" } else { summary }
        )));
    }
    let samples = output.stdout?;
    if samples.is_empty() {
        return Err(CoreError::Music(format!(
            "{} 没有可用的音频流",
            path.display()
        )));
    }
    Ok((samples, DECODE_SAMPLE_RATE))
}

fn read_pcm<R: Read>(mut reader: R) -> std::io::Result<Result<Vec<i16>>> {
    let mut samples = Vec::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut carry: Option<u8> = None;
    loop {
        let filled = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let mut cursor = 0;
        if let Some(low) = carry.take() {
            samples.push(i16::from_le_bytes([low, buffer[0]]));
            cursor = 1;
        }
        let bytes = &buffer[cursor..filled];
        let pairs = bytes.len() / 2;
        samples.extend(
            bytes[..pairs * 2]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| i16::from_le_bytes(*pair)),
        );
        if bytes.len() % 2 == 1 {
            carry = Some(bytes[bytes.len() - 1]);
        }
    }
    if carry.is_some() {
        return Ok(Err(CoreError::Music(
            "ffmpeg 返回了长度非偶数的 16-bit PCM".to_owned(),
        )));
    }
    Ok(Ok(samples))
}

/// 分析一段单声道 PCM，返回节拍网格、段落和建议切点（下拍 ∪ 段落边界）。
pub fn analyze_pcm(samples: &[i16], sample_rate: u32) -> Result<(BeatGrid, Vec<Section>, Vec<i64>)> {
    let envelope = extract_envelope(samples, sample_rate)?;
    let beats = pick_beats(&envelope.flux, envelope.frame_rate);
    if beats.is_empty() {
        return Err(CoreError::Music(NO_BEATS.to_owned()));
    }
    let (coarse_bpm, confidence) = estimate_tempo(&envelope.flux, envelope.frame_rate)
        .ok_or_else(|| CoreError::Music(NO_BEATS.to_owned()))?;
    if confidence < MIN_TEMPO_CONFIDENCE {
        return Err(CoreError::Music(NO_BEATS.to_owned()));
    }
    let bpm = refine_tempo(coarse_bpm, &beats, envelope.frame_rate);

    let beats_ticks: Vec<i64> = beats
        .iter()
        .map(|beat| frame_to_ticks(beat.position, envelope.frame_rate))
        .collect();
    let strengths: Vec<f32> = beats.iter().map(|beat| beat.strength).collect();
    let downbeats_ticks = pick_downbeats(&beats_ticks, &strengths);

    let duration_ticks = (samples.len() as f64 / f64::from(sample_rate) * TICKS_PER_SECOND) as i64;
    let sections = detect_sections(&envelope, duration_ticks);

    let mut cuts = downbeats_ticks.clone();
    cuts.extend(sections.iter().map(|section| section.start_tick));
    cuts.sort_unstable();
    cuts = dedupe_ticks(&cuts, CUT_DEDUPE_TICKS);

    Ok((
        BeatGrid {
            bpm,
            beats_ticks,
            downbeats_ticks,
            strengths,
            confidence,
        },
        sections,
        cuts,
    ))
}

/// 把一次分析结果落库：节拍、段落、以及轨上的 bpm/analysis_status，一个事务里完成。
pub fn persist_analysis(
    connection: &mut Connection,
    track_id: i64,
    grid: &BeatGrid,
    sections: &[Section],
) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let updated = transaction.execute(
        "UPDATE music_tracks SET bpm = ?2, analysis_status = 'done' WHERE id = ?1",
        params![track_id, grid.bpm],
    )?;
    if updated == 0 {
        return Err(CoreError::Music(format!("音乐轨 {track_id} 不存在")));
    }
    transaction.execute("DELETE FROM music_beats WHERE track_id = ?1", params![track_id])?;
    transaction.execute(
        "DELETE FROM music_sections WHERE track_id = ?1",
        params![track_id],
    )?;
    {
        let mut beats = transaction.prepare(
            "INSERT INTO music_beats(track_id, tick, is_downbeat, strength) VALUES(?1, ?2, ?3, ?4)",
        )?;
        for (index, tick) in grid.beats_ticks.iter().enumerate() {
            let is_downbeat = i64::from(grid.downbeats_ticks.binary_search(tick).is_ok());
            let strength = grid.strengths.get(index).copied().unwrap_or(0.0);
            beats.execute(params![track_id, tick, is_downbeat, strength])?;
        }
        let mut rows = transaction.prepare(
            "INSERT INTO music_sections(track_id, start_tick, end_tick, label, energy)
             VALUES(?1, ?2, ?3, ?4, ?5)",
        )?;
        for section in sections {
            rows.execute(params![
                track_id,
                section.start_tick,
                section.end_tick,
                section.label.as_str(),
                section.energy
            ])?;
        }
    }
    transaction.commit()?;
    Ok(())
}

/// 音乐轨的摘要视图——导入/查询命令的返回形状。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MusicTrackSummary {
    pub id: i64,
    pub episode_id: i64,
    pub file_name: String,
    pub rel_path: String,
    pub quick_hash: Option<String>,
    pub duration_ticks: Option<i64>,
    pub tb_num: i64,
    pub tb_den: i64,
    pub bpm: Option<f64>,
    pub analysis_status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MusicBeat {
    pub tick: i64,
    pub is_downbeat: bool,
    pub strength: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MusicAnalysis {
    pub track: MusicTrackSummary,
    pub beats: Vec<MusicBeat>,
    pub sections: Vec<Section>,
    /// 下拍 ∪ 段落边界，去重窗口 100ms——从落库的行在读时派生，不另开表。
    pub suggested_cut_ticks: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MusicAnalyzePayload {
    track_id: i64,
}

fn read_track_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<MusicTrackSummary> {
    Ok(MusicTrackSummary {
        id: row.get(0)?,
        episode_id: row.get(1)?,
        file_name: row.get(2)?,
        rel_path: row.get(3)?,
        quick_hash: row.get(4)?,
        duration_ticks: row.get(5)?,
        tb_num: row.get(6)?,
        tb_den: row.get(7)?,
        bpm: row.get(8)?,
        analysis_status: row.get(9)?,
        created_at: row.get(10)?,
    })
}

const TRACK_SUMMARY_COLUMNS: &str =
    "id, episode_id, file_name, rel_path, quick_hash, duration_ticks, tb_num, tb_den, bpm, analysis_status, created_at";

/// 写操作守卫:音乐轨必须属于当前进行中的集。历史集是只读档案——UI 会禁用写
/// 控件,但**后端必须独立校验**。镜像 `episode::ensure_clip_writable` /
/// `player_prefs::ensure_episode_writable`,按 episode_id 直接判断。
fn ensure_music_episode_writable(connection: &Connection, episode_id: i64) -> Result<()> {
    let active: Option<i64> = connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .optional()?;
    match active {
        None => Err(CoreError::Music("没有处于进行中的集;数据库状态异常".to_owned())),
        Some(active_id) if active_id != episode_id => Err(CoreError::Music(
            "历史集为只读档案,不能修改音乐;请回到当前集操作".to_owned(),
        )),
        Some(_) => Ok(()),
    }
}

/// 导入一条音乐素材：只链接（存绝对路径），从不复制。落库为
/// `analysis_status='pending'` 并入队 `music_analyze`，由后台任务解出节拍/段落。
pub fn import_track(
    connection: &mut Connection,
    episode_id: i64,
    path: &Path,
) -> Result<MusicTrackSummary> {
    ensure_music_episode_writable(connection, episode_id)?;
    let absolute = path
        .canonicalize()
        .map_err(|error| CoreError::Music(format!("无法打开音乐文件 {}：{error}", path.display())))?;
    let file_name = absolute
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| CoreError::Music(format!("{} 不是一个文件", absolute.display())))?;

    let (quick_hash, _byte_size) = super::import::quick_fingerprint(&absolute)?;

    let duration_ticks = probe_duration_ticks(connection, &absolute).ok();

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT INTO music_tracks(episode_id, file_name, rel_path, quick_hash, duration_ticks, analysis_status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![
            episode_id,
            file_name,
            absolute.to_string_lossy().into_owned(),
            quick_hash,
            duration_ticks,
        ],
    )?;
    let track_id = transaction.last_insert_rowid();
    transaction.commit()?;

    let payload = MusicAnalyzePayload { track_id };
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| CoreError::Music(format!("无法创建音乐分析任务：{error}")))?;
    let payload_hash = blake3::hash(format!("music_analyze\0{track_id}\0{quick_hash}").as_bytes())
        .to_hex()
        .to_string();
    jobs::enqueue_idempotent(connection, "music_analyze", &payload_json, &payload_hash)?;

    connection
        .query_row(
            &format!("SELECT {TRACK_SUMMARY_COLUMNS} FROM music_tracks WHERE id = ?1"),
            [track_id],
            read_track_summary,
        )
        .map_err(CoreError::from)
}

/// 导入阶段只需要时长,不需要整轨 PCM——`ffprobe -show_entries format=duration`
/// 直接读容器头就够,比 `decode_pcm` 解完整条音轨再数采样数快得多(`music_analyze`
/// 后台任务本来就要解一遍 PCM 做节拍分析,导入阶段再解一遍纯属浪费)。只有
/// ffprobe 本身失败(容器诡异、探测不到 duration)时才退回旧的解码路径。
fn probe_duration_ticks(connection: &Connection, path: &Path) -> Result<i64> {
    let ffprobe = super::settings::configured_executable(
        connection,
        super::settings::FFPROBE_PATH_KEY,
        "FFPROBE_PATH",
        "ffprobe",
    )?;
    match probe_duration_ticks_via_ffprobe(&ffprobe, path) {
        Ok(ticks) => Ok(ticks),
        Err(error) => {
            eprintln!(
                "ffprobe 读取音乐时长失败，回退到整轨解码取时长 {}：{error}",
                path.display()
            );
            let ffmpeg = super::settings::configured_executable(
                connection,
                super::settings::FFMPEG_PATH_KEY,
                "FFMPEG_PATH",
                "ffmpeg",
            )?;
            let (samples, sample_rate) = decode_pcm(&ffmpeg, path)?;
            Ok((samples.len() as f64 / f64::from(sample_rate) * TICKS_PER_SECOND).round() as i64)
        }
    }
}

/// ffprobe 超时时间：只读容器头,不需要 `DECODE_TIMEOUT` 那么长。
const PROBE_DURATION_TIMEOUT: Duration = Duration::from_secs(30);

fn probe_duration_ticks_via_ffprobe(ffprobe: &OsStr, path: &Path) -> Result<i64> {
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-show_entries"),
        OsString::from("format=duration"),
        OsString::from("-of"),
        OsString::from("csv=p=0"),
        path.as_os_str().to_owned(),
    ];
    let output = execute_with_reader(ffprobe, &args, PROBE_DURATION_TIMEOUT, |mut pipe| {
        let mut buffer = Vec::new();
        pipe.read_to_end(&mut buffer)?;
        Ok(buffer)
    })
    .map_err(|error| CoreError::Music(format!("ffprobe 无法读取时长 {}：{error}", path.display())))?;
    if !output.success {
        let summary = String::from_utf8_lossy(&output.stderr);
        let summary = summary.trim();
        return Err(CoreError::Music(format!(
            "ffprobe 读取时长失败（退出码 {}）：{}",
            output
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "信号中止".to_owned()),
            if summary.is_empty() { "没有错误输出" } else { summary }
        )));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    parse_duration_seconds_to_ticks(text)
        .ok_or_else(|| CoreError::Music(format!("ffprobe 时长输出无效：{text:?}")))
}

/// 把 ffprobe `format=duration` 输出的十进制秒字符串（如 `"20.001234"`）转成
/// tb 1/1000000 的整数 tick，全程走字符串/整数运算——不把秒值先过一遍
/// `f64` 再乘 1_000_000，避免浮点误差在这一步就悄悄吃掉毫秒级精度。
fn parse_duration_seconds_to_ticks(text: &str) -> Option<i64> {
    if text.is_empty() || text.eq_ignore_ascii_case("n/a") {
        return None;
    }
    let (whole, frac) = text.split_once('.').unwrap_or((text, ""));
    let whole: i64 = whole.parse().ok()?;
    let mut frac_digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
    if frac_digits.len() != frac.len() {
        // 小数部分含非数字字符（如指数记法）——不猜测。
        return None;
    }
    frac_digits.truncate(6);
    while frac_digits.len() < 6 {
        frac_digits.push('0');
    }
    let frac_ticks: i64 = frac_digits.parse().ok()?;
    Some(whole * 1_000_000 + frac_ticks)
}

/// 列出某一集下的全部音乐轨，按导入先后排序。
pub fn list_tracks(connection: &Connection, episode_id: i64) -> Result<Vec<MusicTrackSummary>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {TRACK_SUMMARY_COLUMNS} FROM music_tracks WHERE episode_id = ?1 ORDER BY id"
    ))?;
    let rows = statement.query_map([episode_id], read_track_summary)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)
}

/// 读一条音乐轨的完整分析结果：节拍网格、段落划分、以及派生的建议切点。
pub fn get_analysis(connection: &Connection, track_id: i64) -> Result<MusicAnalysis> {
    let track = connection
        .query_row(
            &format!("SELECT {TRACK_SUMMARY_COLUMNS} FROM music_tracks WHERE id = ?1"),
            [track_id],
            read_track_summary,
        )
        .map_err(CoreError::from)?;

    let mut beat_statement = connection.prepare(
        "SELECT tick, is_downbeat, strength FROM music_beats WHERE track_id = ?1 ORDER BY tick",
    )?;
    let beats = beat_statement
        .query_map([track_id], |row| {
            Ok(MusicBeat {
                tick: row.get(0)?,
                is_downbeat: row.get::<_, i64>(1)? != 0,
                strength: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut section_statement = connection.prepare(
        "SELECT start_tick, end_tick, label, energy FROM music_sections WHERE track_id = ?1 ORDER BY start_tick",
    )?;
    let sections = section_statement
        .query_map([track_id], |row| {
            let label: String = row.get(2)?;
            Ok(Section {
                start_tick: row.get(0)?,
                end_tick: row.get(1)?,
                label: SectionLabel::parse(&label).unwrap_or(SectionLabel::Other),
                energy: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut cuts: Vec<i64> = beats
        .iter()
        .filter(|beat| beat.is_downbeat)
        .map(|beat| beat.tick)
        .collect();
    cuts.extend(sections.iter().map(|section| section.start_tick));
    cuts.sort_unstable();
    let suggested_cut_ticks = dedupe_ticks(&cuts, CUT_DEDUPE_TICKS);

    Ok(MusicAnalysis {
        track,
        beats,
        sections,
        suggested_cut_ticks,
    })
}

/// 删除一条音乐轨；节拍/段落靠外键 `ON DELETE CASCADE` 级联清空。
/// 写操作守卫按轨所属的 episode_id 判断——历史集的音乐轨同样只读。
pub fn delete_track(connection: &Connection, track_id: i64) -> Result<()> {
    let episode_id: Option<i64> = connection
        .query_row(
            "SELECT episode_id FROM music_tracks WHERE id = ?1",
            [track_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(episode_id) = episode_id else {
        return Err(CoreError::Music(format!("音乐轨 {track_id} 不存在")));
    };
    ensure_music_episode_writable(connection, episode_id)?;

    let changed = connection.execute("DELETE FROM music_tracks WHERE id = ?1", [track_id])?;
    if changed == 0 {
        return Err(CoreError::Music(format!("音乐轨 {track_id} 不存在")));
    }
    Ok(())
}

/// `music_analyze` 后台任务：解码 → 分析 → 落库。缺文件与"未检测到节拍"是
/// 确定性结局，直接终结任务（前者 blocked、后者 failed），不占重试预算；
/// 其它错误（ffmpeg 缺失、IO 抖动等）向上抛给 `jobs::fail_or_retry`。
pub fn run_music_analyze(connection: &mut Connection, job: &Job) -> Result<()> {
    let payload: MusicAnalyzePayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Music(format!("音乐分析任务数据无效：{error}")))?;

    let rel_path: Option<String> = connection
        .query_row(
            "SELECT rel_path FROM music_tracks WHERE id = ?1",
            [payload.track_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(rel_path) = rel_path else {
        // 任务入队后音乐轨被删除:没有可分析的对象,直接判完成即可。
        return jobs::mark_done(connection, job.id, job.attempt);
    };

    let path = PathBuf::from(&rel_path);
    if !path.exists() {
        jobs::mark_blocked_deterministic(connection, job.id, job.attempt, "音乐文件不存在")?;
        connection.execute(
            "UPDATE music_tracks SET analysis_status = 'failed' WHERE id = ?1",
            params![payload.track_id],
        )?;
        return Ok(());
    }

    let ffmpeg = super::settings::configured_executable(
        connection,
        super::settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    )?;
    let (samples, sample_rate) = decode_pcm(&ffmpeg, &path)?;

    match analyze_pcm(&samples, sample_rate) {
        Ok((grid, sections, _cuts)) => {
            persist_analysis(connection, payload.track_id, &grid, &sections)?;
            jobs::mark_done(connection, job.id, job.attempt)
        }
        Err(CoreError::Music(message)) if message == NO_BEATS => {
            jobs::mark_failed(connection, job.id, job.attempt, &message)?;
            connection.execute(
                "UPDATE music_tracks SET analysis_status = 'failed' WHERE id = ?1",
                params![payload.track_id],
            )?;
            Ok(())
        }
        Err(other) => Err(other),
    }
}

struct Envelope {
    flux: Vec<f32>,
    rms: Vec<f32>,
    centroid: Vec<f32>,
    frame_rate: f64,
}

struct Beat {
    position: f64,
    strength: f32,
}

fn hann(size: usize) -> Vec<f32> {
    (0..size)
        .map(|index| {
            let ratio = index as f32 / size as f32;
            0.5 - 0.5 * (std::f32::consts::TAU * ratio).cos()
        })
        .collect()
}

fn extract_envelope(samples: &[i16], sample_rate: u32) -> Result<Envelope> {
    if sample_rate == 0 {
        return Err(CoreError::Music("采样率必须大于 0".to_owned()));
    }
    if samples.len() < FRAME * 2 {
        return Err(CoreError::Music(NO_BEATS.to_owned()));
    }
    let window = hann(FRAME);
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME);
    let bins = FRAME / 2 + 1;
    let bin_hz = f64::from(sample_rate) / FRAME as f64;

    let mut previous = vec![0_f32; bins];
    let mut buffer = vec![Complex::new(0_f32, 0_f32); FRAME];
    let mut flux = Vec::new();
    let mut rms = Vec::new();
    let mut centroid = Vec::new();
    let mut first = true;
    let mut start = 0;
    while start + FRAME <= samples.len() {
        let mut energy = 0_f64;
        for ((slot, sample), taper) in buffer
            .iter_mut()
            .zip(samples[start..start + FRAME].iter())
            .zip(window.iter())
        {
            let value = f32::from(*sample) / 32768.0;
            energy += f64::from(value) * f64::from(value);
            *slot = Complex::new(value * taper, 0.0);
        }
        rms.push((energy / FRAME as f64).sqrt() as f32);

        fft.process(&mut buffer);
        let mut magnitude_sum = 0_f64;
        let mut weighted = 0_f64;
        let mut difference = 0_f32;
        for (index, (value, earlier)) in buffer[..bins].iter().zip(previous.iter_mut()).enumerate() {
            let magnitude = value.norm();
            magnitude_sum += f64::from(magnitude);
            weighted += f64::from(magnitude) * (index as f64 * bin_hz);
            if !first {
                difference += (magnitude - *earlier).max(0.0);
            }
            *earlier = magnitude;
        }
        centroid.push(if magnitude_sum > 0.0 {
            (weighted / magnitude_sum) as f32
        } else {
            0.0
        });
        flux.push(if first { 0.0 } else { difference });
        first = false;
        start += HOP;
    }

    let flux_peak = flux.iter().copied().fold(0_f32, f32::max);
    let rms_peak = rms.iter().copied().fold(0_f32, f32::max);
    if flux.len() < 3 || flux_peak <= 1e-6 || rms_peak <= 1e-5 {
        return Err(CoreError::Music(NO_BEATS.to_owned()));
    }
    Ok(Envelope {
        flux,
        rms,
        centroid,
        frame_rate: f64::from(sample_rate) / HOP as f64,
    })
}

/// 60–200 BPM 的自相关峰。滞后取小数并对包络线性插值，配一条对数正态速度先验
/// 打破谐波平局。返回 (bpm, 峰值/均值 置信度)。
fn estimate_tempo(flux: &[f32], frame_rate: f64) -> Option<(f64, f32)> {
    let count = flux.len();
    if count < 4 {
        return None;
    }
    let mean = flux.iter().sum::<f32>() / count as f32;
    let centered: Vec<f32> = flux.iter().map(|value| value - mean).collect();

    let mut best: Option<(f64, f64)> = None;
    let mut total = 0_f64;
    let mut candidates = 0_usize;
    let steps = ((MAX_BPM - MIN_BPM) / BPM_STEP).round() as usize;
    for step in 0..=steps {
        let bpm = MIN_BPM + step as f64 * BPM_STEP;
        let lag = 60.0 * frame_rate / bpm;
        let span = lag.ceil() as usize + 1;
        if span >= count {
            continue;
        }
        let mut sum = 0_f64;
        for (offset, value) in centered[..count - span].iter().enumerate() {
            let position = offset as f64 + lag;
            let low = position.floor() as usize;
            let fraction = (position - low as f64) as f32;
            let shifted = centered[low] * (1.0 - fraction) + centered[low + 1] * fraction;
            sum += f64::from(*value * shifted);
        }
        let prior =
            (-0.5 * (bpm / TEMPO_PRIOR_CENTER).ln().powi(2) / (TEMPO_PRIOR_WIDTH * TEMPO_PRIOR_WIDTH))
                .exp();
        let score = sum * prior;
        total += score.max(0.0);
        candidates += 1;
        if best.is_none_or(|(_, peak)| score > peak) {
            best = Some((bpm, score));
        }
    }

    let (bpm, peak) = best?;
    if peak <= 0.0 || candidates == 0 {
        return None;
    }
    let average = total / candidates as f64;
    let confidence = if average > 0.0 { (peak / average) as f32 } else { 0.0 };
    Some((bpm, confidence))
}

/// 自适应阈值挑峰：局部极大 + 高于 1.5 秒窗口内的 均值 + k·标准差 + 绝对地板。
/// 峰位再做一次抛物线插值，把 onset 时间细化到帧以下（帧步 23 ms，不插值时
/// 120 BPM 的拍间隔只能落在 487 ms / 511 ms 两档上）。
fn pick_beats(flux: &[f32], frame_rate: f64) -> Vec<Beat> {
    let count = flux.len();
    if count < 3 {
        return Vec::new();
    }
    let peak = flux.iter().copied().fold(0_f32, f32::max);
    let floor = peak * FLUX_FLOOR_RATIO;
    let half = ((THRESHOLD_WINDOW_SECONDS * frame_rate / 2.0).round() as usize).max(1);
    let separation = MIN_BEAT_SEPARATION_SECONDS * frame_rate;

    let mut beats: Vec<Beat> = Vec::new();
    for index in 1..count - 1 {
        let value = flux[index];
        if value < floor {
            continue;
        }
        if value < flux[index - 1] || value <= flux[index + 1] {
            continue;
        }
        let low = index.saturating_sub(half);
        let high = (index + half + 1).min(count);
        let slice = &flux[low..high];
        let mean = slice.iter().sum::<f32>() / slice.len() as f32;
        let variance =
            slice.iter().map(|item| (item - mean) * (item - mean)).sum::<f32>() / slice.len() as f32;
        if value < mean + THRESHOLD_K * variance.sqrt() {
            continue;
        }
        let position = index as f64 + parabolic_offset(flux[index - 1], value, flux[index + 1]);
        let strength = if peak > 0.0 { value / peak } else { 0.0 };
        match beats.last_mut() {
            Some(previous) if position - previous.position < separation => {
                if strength > previous.strength {
                    previous.position = position;
                    previous.strength = strength;
                }
            }
            _ => beats.push(Beat { position, strength }),
        }
    }
    beats
}

/// 自相关只定了速度档位:0.1 BPM 的搜索步进换算到 43 帧/秒的包络上仍然是
/// 整数帧滞后在起决定作用(120 BPM 的 21.53 帧周期会塌到 21 或 22 帧,即
/// 117.5/123.0 BPM)。这里用已挑出的拍点(带抛物线亚帧插值)做一次精修:
/// 只取落在候选周期 ±25% 内的拍间隔求均值,离群的漏拍/多拍不参与。
///
/// 速度先验(中心 120 BPM)会在真实速度偏离先验较远时,把自相关的峰压到
/// 一个八度谐波上——例如 200 BPM 的点击音轨,自相关粗估常年落在其二分
/// 谐波(约 100 BPM)附近,因为先验更偏爱接近 120 的候选。粗估周期错了一
/// 倍,±25% 的窗口就会把真实的(约一半长的)拍间隔全部滤掉,精修形同虚设。
/// 这里额外试探粗估的二倍/二分之一速度,谁的拍间隔落在窗口内更多,就说明
/// 谁更接近真实周期,取其精修结果。
fn refine_tempo(coarse_bpm: f64, beats: &[Beat], frame_rate: f64) -> f64 {
    if beats.len() < 5 {
        return coarse_bpm;
    }
    let mut candidates = vec![coarse_bpm];
    if coarse_bpm * 2.0 <= MAX_BPM * 1.05 {
        candidates.push(coarse_bpm * 2.0);
    }
    if coarse_bpm / 2.0 >= MIN_BPM * 0.95 {
        candidates.push(coarse_bpm / 2.0);
    }

    let mut best: Option<(f64, usize)> = None;
    for candidate in candidates {
        let period = 60.0 * frame_rate / candidate;
        let kept: Vec<f64> = beats
            .windows(2)
            .map(|pair| pair[1].position - pair[0].position)
            .filter(|gap| *gap > period * 0.75 && *gap < period * 1.25)
            .collect();
        if kept.len() < 4 {
            continue;
        }
        let mean = kept.iter().sum::<f64>() / kept.len() as f64;
        if mean <= 0.0 {
            continue;
        }
        let refined = 60.0 * frame_rate / mean;
        if best.is_none_or(|(_, count)| kept.len() > count) {
            best = Some((refined, kept.len()));
        }
    }
    best.map(|(bpm, _)| bpm).unwrap_or(coarse_bpm)
}

fn parabolic_offset(before: f32, center: f32, after: f32) -> f64 {
    let denominator = f64::from(before) - 2.0 * f64::from(center) + f64::from(after);
    if denominator.abs() < f64::EPSILON {
        return 0.0;
    }
    let offset = 0.5 * (f64::from(before) - f64::from(after)) / denominator;
    offset.clamp(-0.5, 0.5)
}

/// 下拍 = 从第一小节里最强的那一拍起，每 4 拍一个。
fn pick_downbeats(beats_ticks: &[i64], strengths: &[f32]) -> Vec<i64> {
    if beats_ticks.is_empty() {
        return Vec::new();
    }
    let first_bar = strengths.len().min(BEATS_PER_BAR);
    let offset = (0..first_bar)
        .max_by(|left, right| {
            strengths[*left]
                .partial_cmp(&strengths[*right])
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(0);
    beats_ticks
        .iter()
        .skip(offset)
        .step_by(BEATS_PER_BAR)
        .copied()
        .collect()
}

/// 8 秒滑窗的 RMS/谱心跳变。novelty(i) 取窗口前后两半的均值差（即把窗口
/// 一分为二时的组间方差跳变），在电平/音色的台阶处最大。
fn detect_sections(envelope: &Envelope, duration_ticks: i64) -> Vec<Section> {
    let count = envelope.rms.len();
    let window = ((SECTION_WINDOW_SECONDS * envelope.frame_rate).round() as usize).max(1);
    let rms = normalized(&envelope.rms);
    let centroid = normalized(&envelope.centroid);

    let mut boundaries = vec![0_usize];
    if count > window * 2 {
        let mut novelty = vec![0_f32; count];
        for index in window..count - window {
            let before_rms = mean_of(&rms[index - window..index]);
            let after_rms = mean_of(&rms[index..index + window]);
            let before_centroid = mean_of(&centroid[index - window..index]);
            let after_centroid = mean_of(&centroid[index..index + window]);
            let level = before_rms - after_rms;
            let colour = before_centroid - after_centroid;
            novelty[index] = (level * level + colour * colour).sqrt();
        }
        let considered = &novelty[window..count - window];
        let mean = mean_of(considered);
        let variance = considered
            .iter()
            .map(|item| (item - mean) * (item - mean))
            .sum::<f32>()
            / considered.len() as f32;
        let threshold = (mean + variance.sqrt()).max(SECTION_NOVELTY_FLOOR);
        for index in window..count - window {
            let value = novelty[index];
            if value < threshold {
                continue;
            }
            if value < novelty[index - 1] || value <= novelty[index + 1] {
                continue;
            }
            match boundaries.last() {
                Some(previous) if index - previous < window => {}
                _ => boundaries.push(index),
            }
        }
    }

    let mut sections = Vec::new();
    for (order, start) in boundaries.iter().enumerate() {
        let end_frame = boundaries.get(order + 1).copied().unwrap_or(count);
        let energy = mean_of(&rms[*start..end_frame.max(*start + 1).min(count)]);
        sections.push(Section {
            start_tick: frame_to_ticks(*start as f64, envelope.frame_rate),
            end_tick: boundaries
                .get(order + 1)
                .map(|next| frame_to_ticks(*next as f64, envelope.frame_rate))
                .unwrap_or(duration_ticks),
            label: SectionLabel::Other,
            energy,
        });
    }
    label_sections(&mut sections);
    sections
}

fn label_sections(sections: &mut [Section]) {
    if sections.len() < 2 {
        return;
    }
    let last = sections.len() - 1;
    let strongest = (0..sections.len())
        .max_by(|left, right| {
            sections[*left]
                .energy
                .partial_cmp(&sections[*right].energy)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(0);
    for index in 0..sections.len() {
        sections[index].label = if index == strongest {
            SectionLabel::Climax
        } else if index == 0 {
            SectionLabel::Intro
        } else if index == last {
            SectionLabel::Outro
        } else if sections[index].energy > sections[index - 1].energy {
            SectionLabel::Build
        } else {
            SectionLabel::Verse
        };
    }
}

fn normalized(values: &[f32]) -> Vec<f32> {
    let peak = values.iter().copied().fold(0_f32, f32::max);
    if peak <= 0.0 {
        return vec![0.0; values.len()];
    }
    values.iter().map(|value| value / peak).collect()
}

fn mean_of(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f32>() / values.len() as f32
}

fn frame_to_ticks(position: f64, frame_rate: f64) -> i64 {
    (position / frame_rate * TICKS_PER_SECOND).round() as i64
}

fn dedupe_ticks(ticks: &[i64], window: i64) -> Vec<i64> {
    let mut kept: Vec<i64> = Vec::new();
    for tick in ticks {
        match kept.last() {
            Some(previous) if tick - previous < window => {}
            _ => kept.push(*tick),
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};
    use std::process::{Command, Stdio};

    const SAMPLE_RATE: u32 = 22_050;

    fn noise(state: &mut u32) -> f32 {
        *state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f32::from((*state >> 16) as u16) / 32_768.0 - 1.0
    }

    /// 每 60/bpm 秒一个 10 ms 白噪声脉冲，振幅由 `amplitude(秒)` 决定。
    fn click_track(seconds: f64, bpm: f64, amplitude: impl Fn(f64) -> f32) -> Vec<i16> {
        let total = (seconds * f64::from(SAMPLE_RATE)) as usize;
        let mut samples = vec![0_i16; total];
        let mut state = 0x1234_5678_u32;
        let period = 60.0 / bpm;
        let burst = (0.010 * f64::from(SAMPLE_RATE)) as usize;
        let mut beat = 0_usize;
        loop {
            let start = (beat as f64 * period * f64::from(SAMPLE_RATE)).round() as usize;
            if start >= total {
                break;
            }
            let gain = amplitude(start as f64 / f64::from(SAMPLE_RATE));
            let end = (start + burst).min(total);
            for (offset, slot) in samples[start..end].iter_mut().enumerate() {
                let decay = 1.0 - offset as f32 / burst as f32;
                *slot = (noise(&mut state) * gain * decay * 30_000.0) as i16;
            }
            beat += 1;
        }
        samples
    }

    fn median_interval(ticks: &[i64]) -> i64 {
        let mut gaps: Vec<i64> = ticks.windows(2).map(|pair| pair[1] - pair[0]).collect();
        gaps.sort_unstable();
        gaps[gaps.len() / 2]
    }

    #[test]
    fn click_track_at_120_bpm_is_measured_within_two_bpm() {
        let samples = click_track(60.0, 120.0, |_| 0.9);
        let (grid, sections, cuts) = analyze_pcm(&samples, SAMPLE_RATE).unwrap();
        assert!(
            (118.0..=122.0).contains(&grid.bpm),
            "120 BPM 点击音轨测得 {}",
            grid.bpm
        );
        let interval = median_interval(&grid.beats_ticks);
        assert!(
            (interval - 500_000).abs() <= 25_000,
            "拍间隔中位数 {interval} 应接近 500000"
        );
        assert!(
            (110..=130).contains(&grid.beats_ticks.len()),
            "60 秒 120 BPM 应约 120 拍，实测 {}",
            grid.beats_ticks.len()
        );
        assert!(grid.confidence > 1.5, "周期信号的置信度应明显大于 1");
        let bar = median_interval(&grid.downbeats_ticks);
        assert!(
            (bar - 2_000_000).abs() <= 100_000,
            "下拍间隔中位数 {bar} 应约 4 拍"
        );
        assert!(!sections.is_empty());
        assert!(!cuts.is_empty());
        assert!(
            cuts.windows(2).all(|pair| pair[1] - pair[0] >= 100_000),
            "建议切点必须按 100 ms 去重"
        );
    }

    #[test]
    fn dithered_silence_reports_no_beats() {
        // ±1 LSB 抖动白噪声，30 秒，无真实周期性——此前会被自相关的谐波/次谐波
        // 平局打破规则误判成约 120 BPM。种子 LCG 保证可复现；这颗种子实测置信度
        // 约 3.95，明显低于 MIN_TEMPO_CONFIDENCE（5.0，见该常量上的注释）。
        let mut state = 109_u32;
        let samples: Vec<i16> = (0..SAMPLE_RATE as usize * 30)
            .map(|_| noise(&mut state).round() as i16)
            .collect();

        let envelope = extract_envelope(&samples, SAMPLE_RATE).unwrap();
        let (_, confidence) = estimate_tempo(&envelope.flux, envelope.frame_rate)
            .expect("噪声轨仍应给出某个候选峰，只是置信度应远低于阈值");
        assert!(
            confidence < MIN_TEMPO_CONFIDENCE,
            "抖动噪声置信度 {confidence} 应明显低于 {MIN_TEMPO_CONFIDENCE}"
        );

        let error = analyze_pcm(&samples, SAMPLE_RATE).unwrap_err();
        assert!(matches!(&error, CoreError::Music(message) if message == "未检测到节拍"), "{error}");
    }

    #[test]
    fn click_track_at_60_bpm_is_measured_not_120() {
        let samples = click_track(60.0, 60.0, |_| 0.9);
        let (grid, _, _) = analyze_pcm(&samples, SAMPLE_RATE).unwrap();
        assert!(
            (58.0..=62.0).contains(&grid.bpm),
            "60 BPM 点击音轨不应被八度先验吸到 120，实测 {}",
            grid.bpm
        );
    }

    #[test]
    fn click_track_at_200_bpm_is_measured_within_bounds() {
        let samples = click_track(60.0, 200.0, |_| 0.9);
        let (grid, _, _) = analyze_pcm(&samples, SAMPLE_RATE).unwrap();
        assert!(
            (197.0..=203.0).contains(&grid.bpm),
            "200 BPM 点击音轨实测 {}",
            grid.bpm
        );
    }

    #[test]
    fn silence_reports_no_beats() {
        let samples = vec![0_i16; SAMPLE_RATE as usize * 60];
        let error = analyze_pcm(&samples, SAMPLE_RATE).unwrap_err();
        assert!(matches!(&error, CoreError::Music(message) if message == "未检测到节拍"), "{error}");
    }

    #[test]
    fn too_short_input_reports_no_beats() {
        let samples = vec![100_i16; 1000];
        let error = analyze_pcm(&samples, SAMPLE_RATE).unwrap_err();
        assert!(matches!(&error, CoreError::Music(message) if message == "未检测到节拍"), "{error}");
    }

    #[test]
    fn energy_staircase_splits_into_sections_with_a_loud_middle() {
        // 低 → 高 → 低,每段 20 秒:白噪声铺底提供 RMS 台阶,点击提供 onset。
        // 点击振幅取全轨恒定的 0.9(而不是随台阶起伏)、背景噪声调低到
        // 2500——这样整轨的节拍置信度才能稳过 MIN_TEMPO_CONFIDENCE 这道新增
        // 的闸门(实测约 8.8),同时仍然保留 RMS 台阶用于段落边界检测。
        let mut state = 0x0BAD_F00D_u32;
        let mut samples: Vec<i16> = (0..SAMPLE_RATE as usize * 60)
            .map(|index| {
                let second = index as f64 / f64::from(SAMPLE_RATE);
                let level = if (20.0..40.0).contains(&second) { 0.9 } else { 0.08 };
                (noise(&mut state) * level * 2_500.0) as i16
            })
            .collect();
        let clicks = click_track(60.0, 120.0, |_| 0.9);
        for (slot, click) in samples.iter_mut().zip(clicks.iter()) {
            *slot = slot.saturating_add(*click / 2);
        }

        let (_, sections, cuts) = analyze_pcm(&samples, SAMPLE_RATE).unwrap();
        assert!(
            sections.len() >= 3,
            "能量阶梯至少应有 2 个段落边界，实测 {} 段",
            sections.len()
        );
        let middle = &sections[1];
        assert!(
            matches!(middle.label, SectionLabel::Climax | SectionLabel::Build),
            "中段标签应为 climax 或 build，实测 {}",
            middle.label.as_str()
        );
        assert!(
            (middle.start_tick - 20_000_000).abs() <= 2_100_000,
            "第一个边界应落在 20 秒附近，实测 {}",
            middle.start_tick
        );
        assert!(sections[1].energy > sections[0].energy * 2.0, "中段能量应显著更高");
        assert!(
            cuts.iter().any(|cut| (cut - middle.start_tick).abs() < 100_000),
            "段落边界必须进入建议切点"
        );
    }

    #[test]
    fn mixed_tempo_track_reports_each_half() {
        let mut samples = click_track(30.0, 90.0, |_| 0.9);
        samples.extend(click_track(30.0, 120.0, |_| 0.9));

        let first = analyze_pcm(&samples[..SAMPLE_RATE as usize * 30], SAMPLE_RATE).unwrap().0;
        let second = analyze_pcm(&samples[SAMPLE_RATE as usize * 30..], SAMPLE_RATE).unwrap().0;
        assert!((88.0..=92.0).contains(&first.bpm), "前半应为 90 BPM，实测 {}", first.bpm);
        assert!((118.0..=122.0).contains(&second.bpm), "后半应为 120 BPM，实测 {}", second.bpm);

        // 本实现是整轨单一估计,混合轨只保证落在两段真值之间。
        let whole = analyze_pcm(&samples, SAMPLE_RATE).unwrap().0;
        assert!(
            (88.0..=122.0).contains(&whole.bpm),
            "整轨估计应落在 90–120 之间，实测 {}",
            whole.bpm
        );
    }

    #[test]
    fn suggested_cuts_are_deduplicated_within_100ms() {
        let deduped = dedupe_ticks(&[0, 40_000, 99_999, 100_000, 250_000], 100_000);
        assert_eq!(deduped, vec![0, 100_000, 250_000]);
    }

    #[test]
    fn persist_analysis_writes_beats_sections_and_track_status() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute(
                "INSERT INTO music_tracks(id, episode_id, file_name, rel_path, duration_ticks, created_at)
                 SELECT 1, id, 'bgm.m4a', 'music/bgm.m4a', 60000000, '2026-09-06T00:00:00Z'
                 FROM episodes LIMIT 1",
                [],
            )
            .unwrap();
        let grid = BeatGrid {
            bpm: 120.0,
            beats_ticks: vec![0, 500_000, 1_000_000, 1_500_000],
            downbeats_ticks: vec![0],
            strengths: vec![1.0, 0.4, 0.6, 0.3],
            confidence: 4.0,
        };
        let sections = vec![Section {
            start_tick: 0,
            end_tick: 60_000_000,
            label: SectionLabel::Other,
            energy: 0.5,
        }];
        persist_analysis(&mut connection, 1, &grid, &sections).unwrap();

        let (bpm, status): (f64, String) = connection
            .query_row("SELECT bpm, analysis_status FROM music_tracks WHERE id = 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(bpm, 120.0);
        assert_eq!(status, "done");
        let beats: i64 = connection
            .query_row("SELECT COUNT(*) FROM music_beats WHERE track_id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(beats, 4);
        let downbeats: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM music_beats WHERE track_id = 1 AND is_downbeat = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(downbeats, 1);
        let stored_sections: i64 = connection
            .query_row("SELECT COUNT(*) FROM music_sections WHERE track_id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored_sections, 1);

        // 重跑必须覆盖而不是追加。
        persist_analysis(&mut connection, 1, &grid, &sections).unwrap();
        let beats: i64 = connection
            .query_row("SELECT COUNT(*) FROM music_beats WHERE track_id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(beats, 4, "重跑应替换旧节拍");
    }

    #[test]
    fn persist_analysis_refuses_an_unknown_track() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let grid = BeatGrid {
            bpm: 120.0,
            beats_ticks: Vec::new(),
            downbeats_ticks: Vec::new(),
            strengths: Vec::new(),
            confidence: 0.0,
        };
        let error = persist_analysis(&mut connection, 999, &grid, &[]).unwrap_err();
        assert!(matches!(error, CoreError::Music(_)), "{error}");
    }

    #[test]
    fn parse_duration_seconds_to_ticks_truncates_beyond_six_fractional_digits() {
        // ffprobe 有时给出超过 6 位小数的秒值；tb 是 1/1_000_000，多出的位数
        // 钉住截断（而不是四舍五入）：第 7 位起直接丢弃。
        assert_eq!(
            parse_duration_seconds_to_ticks("1.23456789"),
            Some(1_234_567)
        );
    }

    fn test_ffmpeg() -> OsString {
        let connection = Connection::open_in_memory().unwrap();
        crate::core::settings::configured_executable(
            &connection,
            crate::core::settings::FFMPEG_PATH_KEY,
            "FFMPEG_PATH",
            "ffmpeg",
        )
        .unwrap()
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

    fn test_ffprobe() -> OsString {
        let connection = Connection::open_in_memory().unwrap();
        crate::core::settings::configured_executable(
            &connection,
            crate::core::settings::FFPROBE_PATH_KEY,
            "FFPROBE_PATH",
            "ffprobe",
        )
        .unwrap()
    }

    fn ffprobe_available() -> bool {
        Command::new(test_ffprobe())
            .arg("-version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[test]
    fn decode_pcm_reads_a_generated_sine_at_22050_mono() {
        if !ffmpeg_available() {
            eprintln!("skipping decode_pcm: ffmpeg unavailable");
            return;
        }
        let directory = TestDirectory::new();
        let path = directory.path().join("sine.wav");
        let generated = Command::new(test_ffmpeg())
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2"])
            .arg(&path)
            .status()
            .is_ok_and(|status| status.success());
        if !generated {
            eprintln!("skipping decode_pcm: lavfi sine unavailable");
            return;
        }
        let _guard = DECODE_PCM_CALLS_LOCK.lock().unwrap();
        let (samples, rate) = decode_pcm(&test_ffmpeg(), &path).unwrap();
        assert_eq!(rate, DECODE_SAMPLE_RATE);
        let expected = DECODE_SAMPLE_RATE as usize * 2;
        assert!(
            samples.len().abs_diff(expected) < DECODE_SAMPLE_RATE as usize / 10,
            "2 秒 22050 Hz 应约 {expected} 个采样，实测 {}",
            samples.len()
        );
        assert!(samples.iter().any(|sample| sample.abs() > 1000), "正弦不应全零");
    }

    #[test]
    fn decode_pcm_reports_a_missing_file() {
        if !ffmpeg_available() {
            eprintln!("skipping decode_pcm failure: ffmpeg unavailable");
            return;
        }
        let directory = TestDirectory::new();
        let _guard = DECODE_PCM_CALLS_LOCK.lock().unwrap();
        let error = decode_pcm(&test_ffmpeg(), &directory.path().join("absent.m4a")).unwrap_err();
        assert!(matches!(error, CoreError::Music(_)), "{error}");
    }

    #[test]
    fn section_labels_round_trip_through_their_sql_spelling() {
        for label in [
            SectionLabel::Intro,
            SectionLabel::Verse,
            SectionLabel::Build,
            SectionLabel::Climax,
            SectionLabel::Outro,
            SectionLabel::Other,
        ] {
            assert_eq!(SectionLabel::parse(label.as_str()), Some(label));
        }
        assert_eq!(SectionLabel::parse("chorus"), None);
    }

    fn generate_click_wav(path: &Path, bpm: f64, seconds: f64) -> bool {
        let period = 60.0 / bpm;
        let expr = format!("0.9*sin(2*PI*1000*t)*lt(mod(t\\,{period})\\,0.02)");
        Command::new(test_ffmpeg())
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("aevalsrc=exprs={expr}:s=22050:d={seconds}"),
                "-ac",
                "1",
            ])
            .arg(path)
            .status()
            .is_ok_and(|status| status.success())
    }

    fn first_episode_id(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT id FROM episodes LIMIT 1", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn import_track_links_the_file_and_enqueues_analysis() {
        if !ffmpeg_available() {
            eprintln!("skipping import_track: ffmpeg unavailable");
            return;
        }
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let wav = directory.path().join("click-120.wav");
        if !generate_click_wav(&wav, 120.0, 20.0) {
            eprintln!("skipping import_track: lavfi click track unavailable");
            return;
        }
        let episode_id = first_episode_id(&connection);

        let summary = import_track(&mut connection, episode_id, &wav).unwrap();
        assert_eq!(summary.episode_id, episode_id);
        assert_eq!(summary.analysis_status, "pending");
        assert!(summary.quick_hash.is_some());
        assert_eq!(summary.rel_path, wav.canonicalize().unwrap().to_string_lossy());
        assert!(
            summary.duration_ticks.is_some_and(|ticks| (ticks - 20_000_000).abs() < 2_000_000),
            "导入应记下约 20 秒的时长，实测 {:?}",
            summary.duration_ticks
        );

        let pending: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE kind = 'music_analyze' AND status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1, "导入必须入队一个 music_analyze 任务");
    }

    #[test]
    fn import_track_reads_duration_via_ffprobe_without_decoding() {
        if !ffmpeg_available() {
            eprintln!("skipping import_track ffprobe duration: ffmpeg unavailable");
            return;
        }
        if !ffprobe_available() {
            eprintln!("skipping import_track ffprobe duration: ffprobe unavailable");
            return;
        }
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let wav = directory.path().join("click-120.wav");
        if !generate_click_wav(&wav, 120.0, 20.0) {
            eprintln!("skipping import_track ffprobe duration: lavfi click track unavailable");
            return;
        }
        let episode_id = first_episode_id(&connection);

        let _guard = DECODE_PCM_CALLS_LOCK.lock().unwrap();
        DECODE_PCM_CALLS.store(0, std::sync::atomic::Ordering::SeqCst);
        let summary = import_track(&mut connection, episode_id, &wav).unwrap();

        assert_eq!(
            DECODE_PCM_CALLS.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "ffprobe 成功时导入不应该整轨解码取时长"
        );
        assert!(
            summary.duration_ticks.is_some_and(|ticks| (ticks - 20_000_000).abs() < 1_000),
            "ffprobe 读到的时长应精确到 1ms 以内，实测 {:?}",
            summary.duration_ticks
        );
    }

    #[test]
    fn import_track_refuses_an_archived_episode() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let episode_id = first_episode_id(&connection);
        connection
            .execute("UPDATE episodes SET status = 'archived' WHERE id = ?1", [episode_id])
            .unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id)
                 VALUES ('EP02', '', 'now', 'active', 2, lower(hex(randomblob(16))))",
                [],
            )
            .unwrap();

        // 守卫在任何文件 I/O 之前触发,所以不需要一个真实存在的音频文件。
        let wav = directory.path().join("click-120.wav");
        let error = import_track(&mut connection, episode_id, &wav).unwrap_err();
        assert!(
            matches!(&error, CoreError::Music(message) if message.contains("只读档案")),
            "{error}"
        );

        let tracks: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM music_tracks WHERE episode_id = ?1",
                [episode_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tracks, 0, "守卫必须在写库之前拒绝,历史集不应新增音乐轨");
    }

    #[test]
    fn running_the_job_analyzes_the_track_and_marks_it_done() {
        if !ffmpeg_available() {
            eprintln!("skipping run_music_analyze: ffmpeg unavailable");
            return;
        }
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let wav = directory.path().join("click-120.wav");
        if !generate_click_wav(&wav, 120.0, 20.0) {
            eprintln!("skipping run_music_analyze: lavfi click track unavailable");
            return;
        }
        let episode_id = first_episode_id(&connection);
        let summary = import_track(&mut connection, episode_id, &wav).unwrap();
        drop(connection);

        assert!(
            jobs::JobRunner::run_one(&directory.db_path()).unwrap(),
            "应当认领并运行一个任务"
        );

        let connection = db::open_project(&directory.db_path()).unwrap();
        let analysis = get_analysis(&connection, summary.id).unwrap();
        assert_eq!(analysis.track.analysis_status, "done");
        assert!(
            (analysis.track.bpm.unwrap() - 120.0).abs() <= 4.0,
            "120 BPM 点击音轨测得 {:?}",
            analysis.track.bpm
        );
        assert!(
            analysis.beats.len() > 30,
            "20 秒 120 BPM 应有远超 30 个节拍，实测 {}",
            analysis.beats.len()
        );
        assert!(!analysis.suggested_cut_ticks.is_empty());
    }

    #[test]
    fn deleting_a_track_cascades_beats_and_sections() {
        if !ffmpeg_available() {
            eprintln!("skipping delete_track: ffmpeg unavailable");
            return;
        }
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let wav = directory.path().join("click-120.wav");
        if !generate_click_wav(&wav, 120.0, 20.0) {
            eprintln!("skipping delete_track: lavfi click track unavailable");
            return;
        }
        let episode_id = first_episode_id(&connection);
        let summary = import_track(&mut connection, episode_id, &wav).unwrap();
        drop(connection);
        assert!(jobs::JobRunner::run_one(&directory.db_path()).unwrap());

        let connection = db::open_project(&directory.db_path()).unwrap();
        let beats_before: i64 = connection
            .query_row("SELECT COUNT(*) FROM music_beats WHERE track_id = ?1", [summary.id], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(beats_before > 0);

        delete_track(&connection, summary.id).unwrap();

        let remaining_track: i64 = connection
            .query_row("SELECT COUNT(*) FROM music_tracks WHERE id = ?1", [summary.id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining_track, 0);
        let remaining_beats: i64 = connection
            .query_row("SELECT COUNT(*) FROM music_beats WHERE track_id = ?1", [summary.id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining_beats, 0, "删除必须级联清空节拍");
        let remaining_sections: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM music_sections WHERE track_id = ?1",
                [summary.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_sections, 0, "删除必须级联清空段落");
    }

    #[test]
    fn delete_track_refuses_when_its_episode_is_archived() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let episode_id = first_episode_id(&connection);
        connection
            .execute(
                "INSERT INTO music_tracks(id, episode_id, file_name, rel_path, analysis_status, created_at)
                 VALUES (1, ?1, 'bgm.wav', '/tmp/bgm.wav', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                [episode_id],
            )
            .unwrap();
        connection
            .execute("UPDATE episodes SET status = 'archived' WHERE id = ?1", [episode_id])
            .unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id)
                 VALUES ('EP02', '', 'now', 'active', 2, lower(hex(randomblob(16))))",
                [],
            )
            .unwrap();

        let error = delete_track(&connection, 1).unwrap_err();
        assert!(
            matches!(&error, CoreError::Music(message) if message.contains("只读档案")),
            "{error}"
        );

        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM music_tracks WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 1, "守卫必须在删除之前拦截,行不应被动到");
    }

    #[test]
    fn deleting_an_unknown_track_is_an_error() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let error = delete_track(&connection, 999).unwrap_err();
        assert!(matches!(error, CoreError::Music(_)), "{error}");
    }

    #[test]
    fn a_missing_music_file_blocks_the_job_deterministically() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let episode_id = first_episode_id(&connection);
        let missing_path = directory.path().join("does-not-exist.wav");
        connection
            .execute(
                "INSERT INTO music_tracks(id, episode_id, file_name, rel_path, quick_hash, analysis_status, created_at)
                 VALUES (1, ?1, 'gone.wav', ?2, 'deadbeef', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![episode_id, missing_path.to_string_lossy()],
            )
            .unwrap();
        let payload = serde_json::to_string(&MusicAnalyzePayload { track_id: 1 }).unwrap();
        let job_id = jobs::enqueue(&mut connection, "music_analyze", &payload, "missing-file").unwrap();
        drop(connection);

        assert!(jobs::JobRunner::run_one(&directory.db_path()).unwrap());

        let connection = db::open_project(&directory.db_path()).unwrap();
        let (status, summary): (String, Option<String>) = connection
            .query_row(
                "SELECT status, blocked_summary FROM jobs WHERE id = ?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "blocked");
        assert_eq!(summary.as_deref(), Some("音乐文件不存在"));
        let track_status: String = connection
            .query_row("SELECT analysis_status FROM music_tracks WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(track_status, "failed");
    }

    #[test]
    fn list_tracks_is_scoped_to_its_episode() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let episode_id = first_episode_id(&connection);
        connection
            .execute("UPDATE episodes SET status='archived' WHERE id=?1", [episode_id])
            .unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id)
                 VALUES ('EP02', '', 'now', 'active', 2, lower(hex(randomblob(16))))",
                [],
            )
            .unwrap();
        let other_episode = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO music_tracks(episode_id, file_name, rel_path, analysis_status, created_at)
                 VALUES (?1, 'a.wav', '/tmp/a.wav', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                [episode_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO music_tracks(episode_id, file_name, rel_path, analysis_status, created_at)
                 VALUES (?1, 'b.wav', '/tmp/b.wav', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                [other_episode],
            )
            .unwrap();

        let tracks = list_tracks(&connection, episode_id).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].file_name, "a.wav");
    }
}
