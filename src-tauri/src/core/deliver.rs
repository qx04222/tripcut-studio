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

use super::contact_sheet;
use super::error::{CoreError, Result};
use super::jobs::{self, Job};
use super::media_tools::{self, H264Encoder};
use super::platform;

const EXPORT_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
/// 回读 / 指纹探测要真解码素材(ffprobe 没有硬解),4K HEVC 10-bit 软解只有几 fps;
/// 固定 30 s 会把导出正确的文件当失败扔掉(业主 2026-09-14 DJI 素材 9/11 条「命令超过 30 秒」)。
/// 按要解码的媒体时长放大:每秒媒体给 8 s,下限 60 s,上限 15 分钟。
fn probe_timeout(media_seconds: f64) -> Duration {
    let scaled = 60.0 + media_seconds.max(0.0) * 8.0;
    Duration::from_secs_f64(scaled.min(15.0 * 60.0))
}
/// 集标题为空 / 全是非法字符时的兜底集名(R10 U-20)。
const PROJECT_NAME: &str = "旅剪项目";
/// 交付包文件夹:`<集名>_交付_<YYYY-MM-DD>`(R10 U-20;旧名「旅剪项目_剪映交付_日期」退役)。
const PACKAGE_SUFFIX: &str = "交付";
/// R11 车道 E:快速导出的文件夹叫 `<集名>_导出_<YYYY-MM-DD>`,同名追加 `-2`(规格 §2;
/// 集名清洗与交付包共用 [`package_project_name`])。
const QUICK_SUFFIX: &str = "导出";
/// 快速导出的目标目录不存在 / 不可写时错误文本的前缀:前端按它回落到保存面板,
/// 别的失败(没有精选、磁盘不够)不带这个前缀,不能被当成"换个文件夹就好"。
pub const QUICK_EXPORT_DEST_UNAVAILABLE: &str = "dest_unavailable";
const MODE_FULL: &str = "full";
const MODE_QUICK: &str = "quick";
/// R14 车道 B:「剪映素材包」—— 按镜头带顺序把每个镜 remux 成 `NN_<章名>_<素材名>.mp4`,
/// 平铺在 `<集名>_剪映素材包_<日期>`(同名 `-2`)里,附 [`KIT_ORDER_FILE`];剪映不可用时的交接路。
const MODE_KIT: &str = "kit";
const KIT_SUFFIX: &str = "剪映素材包";
/// 素材包里的顺序清单:每行 `NN 章名 素材名 时长`,拖进剪映时间线时照着核对。
pub const KIT_ORDER_FILE: &str = "顺序.txt";
/// 素材没有章时文件名里的章名。
const KIT_NO_CHAPTER: &str = "未分章";
/// 文件系统里集名最长保留多少个字符(Finder 显示 + 路径长度都受得了)。
const PACKAGE_TITLE_MAX_CHARS: usize = 40;
const SELECTED_DIRECTORY: &str = "01_精选原片";
const NARRATION_DIRECTORY: &str = "02_环境声与旁白"; // R2 G10 写旁白稿.txt 用
const SUBTITLE_DIRECTORY: &str = "03_字幕";
const ROUGH_CUT_DIRECTORY: &str = "04_参考粗剪";
const ROUGH_CUT_FILE: &str = "04_参考粗剪/参考粗剪.mp4";
const SHOT_LIST_DIRECTORY: &str = "05_镜头表";
const SHOT_LIST_FILE: &str = "05_镜头表/剪辑清单.csv";
const CONTACT_SHEET_FILE: &str = "05_镜头表/联系表.pdf";
const COLOR_NOTES_DIRECTORY: &str = "06_LUT与色彩说明"; // R3 Pocket 4 用
const DESTINATION_DIRECTORY: &str = "07_地点卡";
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
    pub(crate) chapter_title: String,
    #[serde(default)]
    beat_label: String,
    stars: Option<i64>,
    l1_summary: String,
    has_audio: Option<bool>,
    #[serde(default)]
    dialogue_summary: String,
    #[serde(default)]
    pub(crate) srt_rel_path: Option<String>,
    /// R3 Task 6：转录实际用了哪一路音轨（`None` 表示未选择，回退到 0）。
    #[serde(default)]
    pub(crate) selected_transcribe_track: Option<i64>,
    /// R3 Task 6：`clip_audio_tracks` 里这条素材全部音轨，按 `stream_index` 升序；
    /// 用来在交付说明/剪辑清单/剪映草稿里还原音轨映射。少于 2 条时不认为素材是多轨。
    #[serde(default)]
    pub(crate) audio_tracks: Vec<ExportAudioTrack>,
    /// R6 Task 7b：`clips.manual_rotation`——只在 rotate 标签兜底命中、且没有
    /// side_data 显示矩阵时才非空（见 import.rs 对该列的注释）。粗剪转码与
    /// 剪映草稿都要按它把画面转正，而不是像此前那样只在 App 内预览时生效。
    #[serde(default)]
    pub(crate) manual_rotation: Option<i64>,
}

/// `clip_audio_tracks` 一行的交付层投影，只留下渲染"音轨映射"用得到的字段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub(crate) struct ExportAudioTrack {
    pub(crate) stream_index: i64,
    pub(crate) role_guess: Option<String>,
}

/// `role_guess` 的中文展示标签；未知或缺失一律显示"未知"，不猜测新分类。
pub(crate) fn audio_role_label(role_guess: Option<&str>) -> &'static str {
    match role_guess {
        Some("onboard_mic") => "机内麦",
        Some("wireless_mic") => "无线麦",
        Some("backup") => "备份",
        _ => "未知",
    }
}

/// 这条素材转录实际用的音轨序号：显式选择优先，否则回退到 0
/// （与 `transcribe::resolve_transcribe_track` 的默认值保持一致）。
fn effective_transcribe_track(clip: &ExportClip) -> i64 {
    clip.selected_transcribe_track.unwrap_or(0)
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

/// R3 Task 3:交付说明/镜头表要读的平台信息,在 `start_export` 时一次性解析并
/// 冻结进任务负载——`交付说明.txt`/`剪辑清单.csv` 都是纯函数,不再回查 DB。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ExportPlatformInfo {
    platform: String,
    display_name: String,
    /// 已把 `both` 折成 `landscape` 的实际画布朝向。
    orientation: String,
    canvas_width: i64,
    canvas_height: i64,
    /// 0 表示不限时长。
    duration_budget_seconds: i64,
    /// R10 U-05:画布方向的来源(`override`/`episode`/`preset`/`clips`/`fallback`),
    /// 见 `platform::ResolvedPlatform::orientation_source`。旧负载没有这个字段,按
    /// 「集记录」回退。
    #[serde(default = "default_orientation_source")]
    orientation_source: String,
}

fn default_orientation_source() -> String {
    "episode".to_owned()
}

/// R10 U-05:交付画布——抽屉里「画布 1080×1920」那一行的数据源。`get_export_status`
/// 的 idle 态和 `preview_export_canvas` 都返回它。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExportCanvas {
    pub platform: String,
    pub display_name: String,
    pub orientation: String,
    pub orientation_source: String,
    pub width: i64,
    pub height: i64,
}

impl From<&ExportPlatformInfo> for ExportCanvas {
    fn from(info: &ExportPlatformInfo) -> Self {
        ExportCanvas {
            platform: info.platform.clone(),
            display_name: info.display_name.clone(),
            orientation: info.orientation.clone(),
            orientation_source: info.orientation_source.clone(),
            width: info.canvas_width,
            height: info.canvas_height,
        }
    }
}

/// 抽屉预览:按本次将要传给 `start_export_with_canvas` 的参数解析画布,不建任务。
pub fn preview_export_canvas(
    connection: &Connection,
    override_platform: Option<&str>,
    override_orientation: Option<&str>,
) -> Result<ExportCanvas> {
    let episode_id: i64 = connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .map_err(|_| CoreError::Export("没有进行中的 Episode".to_owned()))?;
    let info: ExportPlatformInfo = platform::resolve_platform_with_orientation(
        connection,
        episode_id,
        override_platform,
        override_orientation,
    )?
    .into();
    Ok(ExportCanvas::from(&info))
}

/// Mirrors the `general` row seeded by migration 0031; must be kept in sync.
fn default_platform_info() -> ExportPlatformInfo {
    // 兼容 R3 之前排队/未完成的旧交付任务:无平台信息时按"通用·横版"回退,
    // 不阻塞任务恢复。
    ExportPlatformInfo {
        platform: "general".to_owned(),
        display_name: "通用".to_owned(),
        orientation: "landscape".to_owned(),
        canvas_width: 1920,
        canvas_height: 1080,
        duration_budget_seconds: 0,
        orientation_source: default_orientation_source(),
    }
}


impl From<platform::ResolvedPlatform> for ExportPlatformInfo {
    fn from(resolved: platform::ResolvedPlatform) -> Self {
        let (canvas_width, canvas_height) = resolved.canvas();
        ExportPlatformInfo {
            platform: resolved.preset.platform.clone(),
            display_name: resolved.preset.display_name.clone(),
            orientation: resolved.orientation.clone(),
            canvas_width,
            canvas_height,
            duration_budget_seconds: resolved.duration_budget_seconds(),
            orientation_source: resolved.orientation_source.to_owned(),
        }
    }
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
    #[serde(default = "default_platform_info")]
    platform_info: ExportPlatformInfo,
    /// R4 Task 3:是否写入 `05_镜头表/联系表.pdf`。旧任务负载(未带这个字段)
    /// 一律按"是"回退,不能因为升级就悄悄少一份产物。
    #[serde(default = "default_true")]
    include_contact_sheet: bool,
    /// 联系表渲染成功时,子集字体不含、被替换成「□」的字符数;联系表被关闭
    /// 或渲染失败时保持 `None`,不能和"确实是 0 个缺字"混为一谈。
    #[serde(default)]
    contact_sheet_glyph_fallbacks: Option<u64>,
    /// 联系表渲染成功时,损坏/截断而退化成灰框占位的封面张数;联系表被关闭
    /// 或渲染失败时保持 `None`,不能和"确实是 0 张损坏封面"混为一谈。
    #[serde(default)]
    contact_sheet_cover_failures: Option<u64>,
    /// R6 Task 6 G9：参考粗剪目标时长（30/60/180 秒）；`None` 表示完整长度。
    /// 创建交付任务时校验并冻结，任务恢复/重跑都不会变。
    #[serde(default)]
    target_seconds: Option<u32>,
    /// R11 车道 E:`full`(交付包,旧任务负载缺这个字段时的回退)或 `quick`(只 remux
    /// 精选段与整条收藏,平铺在文件夹根目录,不出粗剪 / 镜头表 / 联系表 / 交付说明)。
    #[serde(default = "default_mode")]
    mode: String,
    /// 参考粗剪实际拼出来的总时长，统一换算到毫秒 tick 记账；粗剪转码完成前是 `None`。
    #[serde(default)]
    rough_cut_actual_ticks: Option<i64>,
    #[serde(default)]
    rough_cut_actual_tb_num: Option<i64>,
    #[serde(default)]
    rough_cut_actual_tb_den: Option<i64>,
    /// Z-11:「只重试失败的」要写回的上一次文件夹(快速导出专用);`None` = 照常新建文件夹。
    #[serde(default)]
    retry_into: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_mode() -> String {
    MODE_FULL.to_owned()
}

/// R11 车道 E:快速导出只导这些段 / 素材;两项都缺 = 本集全部精选段 + 收藏。
/// `clip_ids` 命中的是该素材名下的全部精选段(没有精选段时是它的整条收藏)。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuickExportSelection {
    #[serde(default)]
    pub segment_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub clip_ids: Option<Vec<i64>>,
    /// Z-11:「只重试失败的」时上一次快速导出的作业 id —— 重试写回**同一个文件夹**、沿用原编号,
    /// 已经导好的文件跳过;不再另开 `-2` 文件夹从 001 重排。
    #[serde(default)]
    pub retry_of_job_id: Option<i64>,
}

/// Z-11:上一次快速导出留下的文件夹与「(素材, 段) → 原文件名」表。
struct RetryContext {
    output_path: PathBuf,
    names: std::collections::HashMap<(i64, Option<i64>), String>,
}

/// 读上一次快速导出作业的负载:必须是快速导出、文件夹还在。不满足就返回 None(退回普通导出)。
fn retry_context(connection: &Connection, job_id: i64) -> Result<Option<RetryContext>> {
    let payload_json: Option<String> = connection
        .query_row(
            "SELECT payload FROM jobs WHERE id = ?1 AND kind = 'export_package'",
            [job_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(payload_json) = payload_json else {
        return Ok(None);
    };
    let previous = parse_payload(&payload_json)?;
    if previous.mode != MODE_QUICK {
        return Ok(None);
    }
    let Some(output_path) = previous.output_path.map(PathBuf::from).filter(|path| path.is_dir()) else {
        return Ok(None);
    };
    let names = previous
        .clips
        .iter()
        .zip(previous.progress.items.iter())
        .map(|(clip, item)| ((clip.clip_id, clip.segment_id), item.output_name.clone()))
        .collect();
    Ok(Some(RetryContext { output_path, names }))
}

impl QuickExportSelection {
    /// 没给任何过滤 = 导全部。给了空数组算"选了个空集",要报错而不是静默导全部。
    fn is_unfiltered(&self) -> bool {
        self.segment_ids.is_none() && self.clip_ids.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuickExportSkipped {
    pub reason: String,
}

/// `quick_export` / `plan_quick_export` 的结果:`job_id` 只在真的排了任务时有值;
/// `dir` 是将要写的文件夹(有目标目录时是全路径,否则只有文件夹名);`files` 是
/// 文件夹里将出现的文件名,顺序与交付项一致。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct QuickExportOutcome {
    pub job_id: Option<i64>,
    pub dir: String,
    pub files: Vec<String>,
    pub skipped: Vec<QuickExportSkipped>,
    /// Z-07:原片此刻不在原位的文件名;非空时导出会被拒绝,抽屉据此给「去缺失素材页重新定位」。
    #[serde(default)]
    pub missing: Vec<String>,
}

/// `export_jianying_kit` / `plan_jianying_kit` 的结果:`dir` 是将写(或已排)的文件夹,`files`
/// 是按镜头带顺序编号的文件名,`order_file` 是顺序清单的文件名(固定 [`KIT_ORDER_FILE`])。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KitExportOutcome {
    pub job_id: Option<i64>,
    pub dir: String,
    pub files: Vec<String>,
    pub order_file: String,
    /// Z-07:原片此刻不在原位的文件名;非空时导出会被拒绝,抽屉据此给「去缺失素材页重新定位」。
    #[serde(default)]
    pub missing: Vec<String>,
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
    /// 联系表渲染成功时子集字体不含、被替换成「□」的字符数;联系表被关闭、
    /// 尚未渲染或渲染失败时是 `None`。
    pub contact_sheet_glyph_fallbacks: Option<u64>,
    /// 联系表渲染成功时损坏/截断而退化成灰框占位的封面张数;联系表被关闭、
    /// 尚未渲染或渲染失败时是 `None`。
    pub contact_sheet_cover_failures: Option<u64>,
    /// R6 Task 6 G9：参考粗剪目标时长（30/60/180 秒）；`None` 表示完整长度。
    pub rough_cut_target_seconds: Option<u32>,
    /// 参考粗剪实际拼出来的总时长，配合 `rough_cut_actual_tb_num`/`_tb_den` 换算成秒；
    /// 粗剪转码完成前是 `None`。
    pub rough_cut_actual_ticks: Option<i64>,
    pub rough_cut_actual_tb_num: Option<i64>,
    pub rough_cut_actual_tb_den: Option<i64>,
    /// R10 U-05:本次交付(或 idle 时「将要」)用的画布。任务负载里冻结的那份;
    /// idle 态按当前集与平台预设现算,解析失败时为 `None`。
    pub canvas: Option<ExportCanvas>,
    /// R11 车道 E:任务的模式(`quick` / `full`);idle 态为 `None`。
    pub mode: Option<String>,
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

#[derive(Debug, Clone)]
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

/// Z-02(R13 压测):导出码率不再硬编码 16M / 12M —— 396×720 / 1.6 Mbps 的源被导成 10.9 Mbps,
/// 25 段 282 MB(7× 源)。目标码率按**源码率 × 1.5** 取,下限 2 Mbps(别把低码率源压得更糊),
/// 上限仍是原来的档位(4K / 高码率源不变)。源码率 = 所选那段的字节数 × 8 / 时长。
const EXPORT_BITRATE_FLOOR_BPS: f64 = 2_000_000.0;
const EXPORT_BITRATE_HEADROOM: f64 = 1.5;
pub(crate) const SEGMENT_BITRATE_CEILING_BPS: f64 = 16_000_000.0;
pub(crate) const ROUGH_CUT_BITRATE_CEILING_BPS: f64 = 12_000_000.0;

fn source_bitrate_bps(clip: &ExportClip) -> Option<f64> {
    let duration = clip_duration_seconds(clip);
    if duration <= 0.0 || clip.byte_size == 0 {
        return None;
    }
    Some(clip.byte_size as f64 * 8.0 / duration)
}

/// `-b:v` 的值(`2400k` 这种整 kbps);源码率未知时退回上限,行为与改前一致。
pub(crate) fn export_video_bitrate(clips: &[&ExportClip], ceiling_bps: f64) -> String {
    let wanted = clips
        .iter()
        .filter_map(|clip| source_bitrate_bps(clip))
        .map(|bps| bps * EXPORT_BITRATE_HEADROOM)
        .fold(None, |acc: Option<f64>, bps| Some(acc.map_or(bps, |a| a.max(bps))));
    let target = match wanted {
        Some(bps) => bps.max(EXPORT_BITRATE_FLOOR_BPS).min(ceiling_bps),
        None => ceiling_bps,
    };
    format!("{}k", (target / 1_000.0).round() as i64)
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
                // R6 6b：manual_rotation 会真的改变参考粗剪的画面朝向
                // (rough_cut_rotation_prefix)，缺了它会把"只改某片段旋转"的
                // 两次 start_export 去重成同一个任务，复用旧 payload 导出未转正的粗剪。
                clip.manual_rotation,
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
        // 目标时长与是否附联系表都会改变实际产出的文件，缺了它们会把
        // "只改目标秒数/联系表开关"的两次 start_export 去重成同一个任务。
        payload.target_seconds,
        payload.include_contact_sheet,
        // override_platform 会改变联系表方向与交付说明的措辞，缺了它会把
        // "只改导出平台"的两次 start_export 去重成同一个任务，第二次悄悄
        // 拿到第一次那个平台的产物。
        &payload.platform_info,
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

pub fn start_export(
    connection: &mut Connection,
    destination: &Path,
    override_platform: Option<&str>,
    include_contact_sheet: bool,
    target_seconds: Option<u32>,
) -> Result<ExportStatus> {
    start_export_with_canvas(
        connection,
        destination,
        override_platform,
        None,
        include_contact_sheet,
        target_seconds,
    )
}

/// R10 U-05:`start_export` + 本次交付手动指定的画布方向(`portrait`/`landscape`;
/// `None` 按 `platform::resolve_platform` 的优先级落定)。
pub fn start_export_with_canvas(
    connection: &mut Connection,
    destination: &Path,
    override_platform: Option<&str>,
    override_orientation: Option<&str>,
    include_contact_sheet: bool,
    target_seconds: Option<u32>,
) -> Result<ExportStatus> {
    let job_id = enqueue_export(
        connection,
        destination,
        override_platform,
        override_orientation,
        include_contact_sheet,
        target_seconds,
        MODE_FULL,
        None,
    )?;
    get_export_status(connection, Some(job_id))
}

/// R11 车道 E:快速导出——只 remux 精选段与整条收藏到 `<集名>_导出_<日期>`,进度沿用
/// 交付任务那套(同一个 `export_package` 作业,负载 `mode = quick`)。目标目录不存在 /
/// 不可写时报 [`QUICK_EXPORT_DEST_UNAVAILABLE`] 前缀的错误,前端据此回落到保存面板。
pub fn start_quick_export(
    connection: &mut Connection,
    destination: &Path,
    selection: Option<&QuickExportSelection>,
) -> Result<QuickExportOutcome> {
    ensure_writable_directory(destination)?;
    let plan = plan_quick_export(connection, Some(destination), selection)?;
    let job_id = enqueue_export(connection, destination, None, None, false, None, MODE_QUICK, selection)?;
    Ok(QuickExportOutcome {
        job_id: Some(job_id),
        ..plan
    })
}

/// 只算不排:快速导出将写哪个文件夹、哪些文件、哪些 id 被跳过。抽屉的清单读它。
pub fn plan_quick_export(
    connection: &Connection,
    destination: Option<&Path>,
    selection: Option<&QuickExportSelection>,
) -> Result<QuickExportOutcome> {
    let episode_title: String = connection
        .query_row("SELECT title FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .map_err(|_| CoreError::Export("没有进行中的 Episode，无法导出".to_owned()))?;
    let (clips, skipped) = filter_quick_selection(selected_clips(connection)?, selection)?;
    let date: String = connection.query_row(
        "SELECT strftime('%Y-%m-%d', 'now', 'localtime')",
        [],
        |row| row.get(0),
    )?;
    let project_name = package_project_name(&episode_title);
    let retry = match selection.and_then(|selection| selection.retry_of_job_id) {
        Some(job_id) => retry_context(connection, job_id)?,
        None => None,
    };
    let dir = match (&retry, destination) {
        // Z-11:重试写回上一次的文件夹。
        (Some(retry), _) => retry.output_path.to_string_lossy().into_owned(),
        // 与任务运行时同一条规范化路径(/var → /private/var),前端拿到的就是最终会出现的那个。
        (None, Some(destination)) => unique_quick_path(
            &destination.canonicalize().unwrap_or_else(|_| destination.to_path_buf()),
            &project_name,
            &date,
        )
        .to_string_lossy()
        .into_owned(),
        (None, None) => quick_folder_name(&project_name, &date),
    };
    let missing = missing_source_names(connection, &clips)?;
    Ok(QuickExportOutcome {
        job_id: None,
        dir,
        files: clips
            .iter()
            .enumerate()
            .map(|(index, clip)| quick_output_name(retry.as_ref(), index, clip))
            .collect(),
        skipped,
        missing,
    })
}

/// R14 车道 B:剪映素材包 —— 复用快速导出管线(同一个 `export_package` 作业,负载
/// `mode = kit`),但文件按镜头带顺序编号为 `NN_<章名>_<素材名>.mp4`,并附「顺序.txt」。
/// 目标目录不存在 / 不可写时报 [`QUICK_EXPORT_DEST_UNAVAILABLE`] 前缀的错误。
pub fn start_jianying_kit(connection: &mut Connection, destination: &Path) -> Result<KitExportOutcome> {
    ensure_writable_directory(destination)?;
    let plan = plan_jianying_kit(connection, Some(destination))?;
    let job_id = enqueue_export(connection, destination, None, None, false, None, MODE_KIT, None)?;
    Ok(KitExportOutcome {
        job_id: Some(job_id),
        ..plan
    })
}

/// 只算不排:素材包将写哪个文件夹、哪些文件(顺序 = 镜头带顺序,见 [`selected_clips`] 的排序)。
pub fn plan_jianying_kit(connection: &Connection, destination: Option<&Path>) -> Result<KitExportOutcome> {
    let episode_title: String = connection
        .query_row("SELECT title FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .map_err(|_| CoreError::Export("没有进行中的 Episode，无法导出".to_owned()))?;
    let (clips, _skipped) = filter_quick_selection(selected_clips(connection)?, None)?;
    let date: String = connection.query_row(
        "SELECT strftime('%Y-%m-%d', 'now', 'localtime')",
        [],
        |row| row.get(0),
    )?;
    let project_name = package_project_name(&episode_title);
    let dir = match destination {
        Some(destination) => unique_kit_path(
            &destination.canonicalize().unwrap_or_else(|_| destination.to_path_buf()),
            &project_name,
            &date,
        )
        .to_string_lossy()
        .into_owned(),
        None => kit_folder_name(&project_name, &date),
    };
    let missing = missing_source_names(connection, &clips)?;
    let ordinals = kit_chapter_ordinals(&clips);
    Ok(KitExportOutcome {
        job_id: None,
        dir,
        files: clips
            .iter()
            .zip(ordinals)
            .enumerate()
            .map(|(index, (clip, ordinal))| kit_relative_name(index + 1, ordinal, &clip.chapter_title, &clip.file_name))
            .collect(),
        order_file: KIT_ORDER_FILE.to_owned(),
        missing,
    })
}

/// Z-07:交付项里此刻原片不在原位的文件名(去重,保持镜头带顺序)。
fn missing_source_names(connection: &Connection, clips: &[ExportClip]) -> Result<Vec<String>> {
    let mut ids: Vec<i64> = Vec::new();
    for clip in clips {
        if !ids.contains(&clip.clip_id) {
            ids.push(clip.clip_id);
        }
    }
    super::media_source::missing_file_names(connection, &ids)
}

/// 按 `selection` 裁剪交付项:段 id 命中的段、素材 id 命中的段 / 整条收藏。命不中的 id
/// 记进 `skipped`;裁完为空(或给了空集)报错,不能静默退回"导全部"。
fn filter_quick_selection(
    clips: Vec<ExportClip>,
    selection: Option<&QuickExportSelection>,
) -> Result<(Vec<ExportClip>, Vec<QuickExportSkipped>)> {
    let Some(selection) = selection.filter(|selection| !selection.is_unfiltered()) else {
        if clips.is_empty() {
            return Err(CoreError::Export(
                "当前没有精选段或收藏素材；请先打点保存片段，或用 F 收藏整条素材".to_owned(),
            ));
        }
        return Ok((clips, Vec::new()));
    };
    let segment_ids = selection.segment_ids.clone().unwrap_or_default();
    let clip_ids = selection.clip_ids.clone().unwrap_or_default();
    let mut skipped = Vec::new();
    for segment_id in &segment_ids {
        if !clips.iter().any(|clip| clip.segment_id == Some(*segment_id)) {
            skipped.push(QuickExportSkipped {
                reason: format!("精选段 {segment_id} 不在本集的导出项里"),
            });
        }
    }
    for clip_id in &clip_ids {
        if !clips.iter().any(|clip| clip.clip_id == *clip_id) {
            skipped.push(QuickExportSkipped {
                reason: format!("素材 {clip_id} 没有精选段也没有收藏"),
            });
        }
    }
    let kept: Vec<ExportClip> = clips
        .into_iter()
        .filter(|clip| {
            clip.segment_id.is_some_and(|id| segment_ids.contains(&id)) || clip_ids.contains(&clip.clip_id)
        })
        .collect();
    if kept.is_empty() {
        return Err(CoreError::Export(
            "所选的素材里没有精选段或收藏；先打点保存片段,或按 F 收藏整条素材".to_owned(),
        ));
    }
    Ok((kept, skipped))
}

/// 目标目录必须存在、是文件夹、且真的写得进去(实际落一个探针文件再删)。
fn ensure_writable_directory(destination: &Path) -> Result<()> {
    let unavailable = |detail: String| {
        CoreError::Export(format!(
            "{QUICK_EXPORT_DEST_UNAVAILABLE}: 上次的文件夹现在用不了（{}）：{detail}",
            destination.display()
        ))
    };
    if !destination.is_dir() {
        return Err(unavailable("文件夹不存在".to_owned()));
    }
    let probe = destination.join(format!(
        ".tripcut-write-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ));
    match File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(error) => Err(unavailable(error.to_string())),
    }
}

/// 交付包 / 快速导出共用的排队逻辑;`mode` 决定文件夹命名与任务运行时跳过的阶段。
#[allow(clippy::too_many_arguments)]
fn enqueue_export(
    connection: &mut Connection,
    destination: &Path,
    override_platform: Option<&str>,
    override_orientation: Option<&str>,
    include_contact_sheet: bool,
    target_seconds: Option<u32>,
    mode: &str,
    selection: Option<&QuickExportSelection>,
) -> Result<i64> {
    validate_rough_cut_target(target_seconds)?;
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
    let (episode_id, episode_memory_id, episode_title): (i64, String, String) = transaction
        .query_row(
            "SELECT id, memory_id, title FROM episodes WHERE status = 'active'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| CoreError::Export("没有进行中的 Episode，无法创建交付任务".to_owned()))?;
    let platform_info: ExportPlatformInfo = platform::resolve_platform_with_orientation(
        &transaction,
        episode_id,
        override_platform,
        override_orientation,
    )?
    .into();
    let (clips, _skipped) = filter_quick_selection(selected_clips(&transaction)?, selection)?;
    // Z-07 / Z-08:排队前先 stat 原片——不在了就拒绝,给一句人话,不让任务跑到一半才「交付失败」。
    let missing = missing_source_names(&transaction, &clips)?;
    if !missing.is_empty() {
        return Err(CoreError::Export(super::media_source::missing_source_message(&missing)));
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
    // Z-11:快速导出的「只重试失败的」写回上一次的文件夹、沿用原编号。
    let retry = match selection.and_then(|selection| selection.retry_of_job_id) {
        Some(job_id) if mode == MODE_QUICK => retry_context(&transaction, job_id)?,
        _ => None,
    };
    let kit_ordinals = if mode == MODE_KIT { kit_chapter_ordinals(&clips) } else { Vec::new() };
    let items = clips
        .iter()
        .enumerate()
        .map(|(index, clip)| ExportItemStatus {
            clip_id: clip.clip_id,
            file_name: clip.file_name.clone(),
            output_name: if mode == MODE_KIT {
                kit_relative_name(index + 1, kit_ordinals[index], &clip.chapter_title, &clip.file_name)
            } else {
                quick_output_name(retry.as_ref(), index, clip)
            },
            status: "pending".to_owned(),
            note: None,
            warning: false,
        })
        .collect();
    let payload = ExportJobPayload {
        version: 5,
        episode_id: Some(episode_id),
        episode_memory_id: Some(episode_memory_id),
        destination: destination.to_string_lossy().into_owned(),
        project_name: package_project_name(&episode_title),
        date,
        selected_bytes,
        clips,
        platform_info,
        progress: ExportProgress {
            stage: "queued".to_owned(),
            completed_items: 0,
            failed_items: 0,
            cancel_requested: false,
            message: Some("等待交付任务开始".to_owned()),
            items,
        },
        output_path: None,
        include_contact_sheet,
        contact_sheet_glyph_fallbacks: None,
        contact_sheet_cover_failures: None,
        target_seconds,
        mode: mode.to_owned(),
        rough_cut_actual_ticks: None,
        rough_cut_actual_tb_num: None,
        rough_cut_actual_tb_den: None,
        retry_into: retry.map(|retry| retry.output_path.to_string_lossy().into_owned()),
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
    Ok(job_id)
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
            contact_sheet_glyph_fallbacks: None,
            contact_sheet_cover_failures: None,
            rough_cut_target_seconds: None,
            rough_cut_actual_ticks: None,
            rough_cut_actual_tb_num: None,
            rough_cut_actual_tb_den: None,
            canvas: preview_export_canvas(connection, None, None).ok(),
            mode: None,
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
        contact_sheet_glyph_fallbacks: payload.contact_sheet_glyph_fallbacks,
        contact_sheet_cover_failures: payload.contact_sheet_cover_failures,
        rough_cut_target_seconds: payload.target_seconds,
        rough_cut_actual_ticks: payload.rough_cut_actual_ticks,
        rough_cut_actual_tb_num: payload.rough_cut_actual_tb_num,
        rough_cut_actual_tb_den: payload.rough_cut_actual_tb_den,
        canvas: Some(ExportCanvas::from(&payload.platform_info)),
        mode: Some(payload.mode.clone()),
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

/// R6 Task 4:一次 `export_package` 任务成功落地(`status='done'`)时该发的
/// 系统通知——标题固定,正文是交付目标文件夹名(取自 `result_path`,与
/// `run_export_package_with` 里写进 `jobs.result_path` 的 `final_path` 同源)。
/// 调用点在 `jobs::run_one_with_executor` 里、`execute()` 返回之后重新读一次
/// 这条 job 行——不是在导出流程内部直接发通知,这样导出逻辑不必知道通知长
/// 什么样,也不会因为通知失败而拖累已经落地的交付包。
pub(crate) fn export_completion_notice(
    connection: &Connection,
    job: &Job,
) -> Result<Option<(String, String)>> {
    if job.kind != "export_package" {
        return Ok(None);
    }
    let row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT status, result_path FROM jobs WHERE id = ?1",
            [job.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((status, result_path)) = row else {
        return Ok(None);
    };
    if status != "done" {
        return Ok(None);
    }
    let Some(result_path) = result_path else {
        return Ok(None);
    };
    let folder_name = Path::new(&result_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or(result_path);
    Ok(Some((
        crate::notify::EXPORT_COMPLETE_TITLE.to_owned(),
        folder_name,
    )))
}

pub fn run_export_package(connection: &mut Connection, job: &Job) -> Result<()> {
    // R17 exportfix:配置的 ffmpeg 缺 VideoToolbox 时改用包内那份(见 settings::export_ffmpeg)。
    let ffmpeg = super::settings::export_ffmpeg(connection)?;
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

    // R11 车道 E:快速导出平铺在 `<集名>_导出_<日期>` 根目录,不建交付包的分层目录。
    // R14 车道 B:剪映素材包同样平铺,文件夹叫 `<集名>_剪映素材包_<日期>`,多一份「顺序.txt」。
    let kit = payload.mode == MODE_KIT;
    let quick = payload.mode == MODE_QUICK || kit;
    // Z-11:重试写回上一次的文件夹(它还在才算;被删了就照常新建)。
    let retry_into = payload
        .retry_into
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let final_path = if let Some(existing) = retry_into.clone() {
        existing
    } else if kit {
        unique_kit_path(&destination, &payload.project_name, &payload.date)
    } else if quick {
        unique_quick_path(&destination, &payload.project_name, &payload.date)
    } else {
        unique_package_path(&destination, &payload.project_name, &payload.date)
    };
    let staging_path = staging_path(&final_path, job.id, job.attempt);
    if staging_path.exists() {
        std::fs::remove_dir_all(&staging_path)?;
    }
    std::fs::create_dir(&staging_path)?;
    let mut staging = StagingDirectory::new(staging_path.clone());
    if !quick {
        std::fs::create_dir(staging_path.join(SELECTED_DIRECTORY))?;
        for directory in [
            NARRATION_DIRECTORY,
            ROUGH_CUT_DIRECTORY,
            SHOT_LIST_DIRECTORY,
            COLOR_NOTES_DIRECTORY,
        ] {
            std::fs::create_dir(staging_path.join(directory))?;
        }
    }

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

        let output_path = if quick {
            staging_path.join(&payload.progress.items[index].output_name)
        } else {
            staging_path
                .join(SELECTED_DIRECTORY)
                .join(&payload.progress.items[index].output_name)
        };
        // Z-11:重试时上次已经导好的文件不再重做(也不覆盖)。
        if let Some(existing) = retry_into
            .as_ref()
            .map(|folder| folder.join(&payload.progress.items[index].output_name))
            .filter(|path| path.is_file())
        {
            payload.progress.items[index].status = "done".to_owned();
            payload.progress.items[index].note = Some("上次已导好,跳过".to_owned());
            payload.progress.completed_items += 1;
            successful.push(SuccessfulClip {
                clip: payload.clips[index].clone(),
                path: existing,
            });
            persist_progress(connection, job, &payload)?;
            continue;
        }
        // J-04:素材包按章节落进子目录时 output_name 带一段路径(`01_章名/文件.mp4`);
        // 子目录还没建过就先建好(quick/full 没有子目录,create_dir_all 落在既有的
        // staging 目录上是没有作用的空操作)。
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
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
                payload.progress.items[index].note = Some(failure_note(&error));
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

    if kit {
        // J-05:字幕/音乐跟完整交付包判断同一份逻辑(见 copy_kit_subtitles / copy_kit_music
        // 顶上的说明),只是抄到素材包自己的位置——同名同目录、根目录一份配乐。
        copy_kit_subtitles(connection, &payload.clips, &payload.progress.items, &staging_path)?;
        if let Some(episode_id) = payload.episode_id {
            copy_kit_music(connection, episode_id, &staging_path)?;
        }
        write_synced(
            &staging_path.join(KIT_ORDER_FILE),
            kit_order_text(&payload.clips, &payload.progress.items).as_bytes(),
        )?;
    } else if !quick {
        write_package_extras(connection, job, &mut payload, &successful, &staging_path, ffmpeg, ffprobe, &cancellation.flag)?;
    }

    check_cancelled(&cancellation.flag)?;
    payload.progress.stage = "finalizing".to_owned();
    payload.progress.message = Some("正在完成原子交付".to_owned());
    persist_progress(connection, job, &payload)?;
    payload.progress.stage = "complete".to_owned();
    payload.progress.message = Some(completion_message(&payload));
    payload.output_path = Some(final_path.to_string_lossy().into_owned());
    write_completion_marker(
        &staging_path,
        job.id,
        job.attempt,
        &payload_hash,
    )?;
    finalize_export(
        connection,
        job,
        payload,
        &successful,
        staging_path,
        &mut staging,
        &final_path,
        &cancellation.flag,
    )
}

/// 交付完成的一句话:快速导出报文件数,交付包报"已生成"(失败条数照旧点出来)。
fn completion_message(payload: &ExportJobPayload) -> String {
    let failed = payload.progress.failed_items;
    if payload.mode == MODE_KIT {
        if failed == 0 {
            format!("已导出 {} 个片段", payload.progress.completed_items)
        } else {
            format!("已导出 {} 个片段；{failed} 条没导出来", payload.progress.completed_items)
        }
    } else if payload.mode == MODE_QUICK {
        if failed == 0 {
            format!("已导出 {} 个文件", payload.progress.completed_items)
        } else {
            format!("已导出 {} 个文件；{failed} 条没导出来", payload.progress.completed_items)
        }
    } else if failed == 0 {
        "交付包已生成".to_owned()
    } else {
        format!("交付包已生成；{failed} 条素材失败，详情见镜头表")
    }
}

/// 交付包独有的产物:参考粗剪、字幕、镜头表、联系表、地点卡、旁白稿、交付说明。
/// 快速导出整段跳过(规格 §2)。
#[allow(clippy::too_many_arguments)]
fn write_package_extras(
    connection: &mut Connection,
    job: &Job,
    payload: &mut ExportJobPayload,
    successful: &[SuccessfulClip],
    staging_path: &Path,
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    cancellation: &AtomicBool,
) -> Result<()> {
    payload.progress.stage = "rough_cut".to_owned();
    let rough_cut_canvas = ExportCanvas::from(&payload.platform_info);
    payload.progress.message = Some(format!(
        "正在转码 {}×{} H.264 参考粗剪",
        rough_cut_canvas.width, rough_cut_canvas.height
    ));
    persist_progress(connection, job, payload)?;
    let rough_cut_path = staging_path.join(ROUGH_CUT_FILE);
    let rough_cut_temporary = jobs::temporary_output_path(&rough_cut_path, job.attempt);
    remove_file_if_exists(&rough_cut_temporary)?;
    let (rough_cut_clips, rough_cut_summary) = select_rough_cut(successful, payload.target_seconds)?;
    transcode_rough_cut(
        ffmpeg,
        ffprobe,
        &rough_cut_clips,
        &rough_cut_temporary,
        &rough_cut_canvas,
        cancellation,
    )?;
    std::fs::rename(&rough_cut_temporary, &rough_cut_path)?;
    payload.rough_cut_actual_ticks = Some(rough_cut_summary.actual_ticks);
    payload.rough_cut_actual_tb_num = Some(rough_cut_summary.actual_tb_num);
    payload.rough_cut_actual_tb_den = Some(rough_cut_summary.actual_tb_den);

    check_cancelled(cancellation)?;
    payload.progress.stage = "documents".to_owned();
    payload.progress.message = Some("正在写入镜头表与交付说明".to_owned());
    persist_progress(connection, job, payload)?;
    let subtitle_count = copy_subtitles(
        connection,
        &payload.clips,
        &payload.progress.items,
        staging_path,
    )?;
    let csv = build_shot_list_csv(&payload.clips, &payload.progress.items, &payload.platform_info);
    write_synced(&staging_path.join(SHOT_LIST_FILE), csv.as_bytes())?;
    let episode_id = payload
        .episode_id
        .ok_or_else(|| CoreError::Export("交付任务缺少 Episode 归属".to_owned()))?;
    let contact_sheet_outcome = if payload.include_contact_sheet {
        match write_contact_sheet(connection, staging_path, episode_id, payload) {
            Ok(stats) => {
                payload.contact_sheet_glyph_fallbacks = Some(stats.glyph_fallbacks as u64);
                payload.contact_sheet_cover_failures = Some(stats.cover_failures as u64);
                ContactSheetOutcome::Written {
                    glyph_fallbacks: stats.glyph_fallbacks,
                    cover_failures: stats.cover_failures,
                }
            }
            Err(error) => {
                // 联系表只是镜头表之外的锦上添花；渲染失败绝不能拖垮整份已经
                // remux 成功的交付包——镜头表仍是权威产物。
                tracing::warn!(job_id = job.id, %error, "联系表生成失败");
                ContactSheetOutcome::Failed { message: error.to_string() }
            }
        }
    } else {
        ContactSheetOutcome::Disabled
    };
    let destination_count = write_destination_cards(connection, staging_path, episode_id)?;
    let narration_outcome = write_narration_script(connection, staging_path, episode_id)?;
    let instructions = build_instructions(
        payload,
        subtitle_count,
        destination_count,
        narration_outcome,
        &contact_sheet_outcome,
    );
    write_synced(&staging_path.join(README_FILE), instructions.as_bytes())?;
    Ok(())
}

/// 原子提交:staging → 最终文件夹 rename,再在一个事务里落 exports 行、频道记忆 outbox 与
/// 作业终态(取消赢在 rename 之后的窄窗时把文件夹删回去)。
#[allow(clippy::too_many_arguments)]
fn finalize_export(
    connection: &mut Connection,
    job: &Job,
    payload: ExportJobPayload,
    successful: &[SuccessfulClip],
    staging_path: PathBuf,
    staging: &mut StagingDirectory,
    final_path: &Path,
    cancellation: &AtomicBool,
) -> Result<()> {
    check_cancelled(cancellation)?;
    if payload.retry_into.is_some() && final_path.is_dir() {
        // Z-11:写回已有文件夹 —— 把暂存目录里的文件逐个搬进去(只会是这次新导出的),暂存目录随后删掉。
        for entry in std::fs::read_dir(&staging_path)? {
            let entry = entry?;
            let target = final_path.join(entry.file_name());
            if target.exists() {
                continue;
            }
            std::fs::rename(entry.path(), &target)?;
        }
        let _ = std::fs::remove_dir_all(&staging_path);
        staging.promoted = true;
    } else {
        std::fs::rename(&staging_path, final_path)?;
        staging.promoted = true;
    }
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
        let _ = std::fs::remove_dir_all(final_path);
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
    let jitter_threshold = super::settings::number_value(
        connection,
        super::settings::JITTER_THRESHOLD_KEY,
        super::settings::DEFAULT_JITTER_THRESHOLD,
    )?
    .clamp(0.0, 1.0);
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
                       AND j.clip_id = c.id
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
                c.volume_uuid, c.quick_hash, c.full_hash, c.selected_transcribe_track,
                c.manual_rotation,
                a.underexposed_ratio, a.out_of_focus_ratio, m.shake_score
         FROM clips c
         LEFT JOIN live_selects selected_segment ON selected_segment.clip_id = c.id
         LEFT JOIN clip_analysis a ON a.clip_id = c.id
         LEFT JOIN clip_motion m ON m.clip_id = c.id
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
        let underexposed = row.get::<_, Option<f64>>(31)?;
        let out_of_focus = row.get::<_, Option<f64>>(32)?;
        let shaky = row
            .get::<_, Option<f64>>(33)?
            .map(|shake| super::motion::shake_is_flagged(shake, jitter_threshold));
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
                underexposed,
                out_of_focus,
                shaky,
                audio_clipped,
                has_audio,
                focus_scores.as_deref(),
            ),
            has_audio,
            dialogue_summary: dialogue_summary(transcript_text.as_deref()),
            srt_rel_path: row.get(23)?,
            selected_transcribe_track: row.get(30)?,
            manual_rotation: row.get(31)?,
            audio_tracks: Vec::new(),
        })
    })?;
    let mut clips = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)?;
    sort_by_band_order(connection, &mut clips)?;
    attach_audio_tracks(connection, &mut clips)?;
    Ok(clips)
}

/// V14-01:三条导出(素材包 / 原生草稿 / 导出片段)与交付包的顺序 = 镜头带「按章节」视图的
/// 顺序,唯一来源是 [`super::story::ordered_band_items`]。上面 SQL 的 `story.position` 全局序是
/// 挑选先后 —— 两次自动挑选、后一批拍得更早时,它与带上画的顺序对不上(真机 V14-01)。
/// 不在带上的(候选、无 position)保持 SQL 原序排在带序之后;稳定排序,不打乱同键相对顺序。
fn sort_by_band_order(connection: &Connection, clips: &mut [ExportClip]) -> Result<()> {
    let band = super::story::ordered_band_items(connection)?;
    if band.is_empty() {
        return Ok(());
    }
    let rank: HashMap<String, usize> = band
        .into_iter()
        .enumerate()
        .map(|(index, item)| (item.key, index))
        .collect();
    clips.sort_by_key(|clip| {
        let item_kind = if clip.segment_id.is_some() { "segment" } else { "whole" };
        rank.get(&super::story::story_key(item_kind, clip.clip_id, clip.segment_id))
            .copied()
            .unwrap_or(usize::MAX)
    });
    Ok(())
}

/// R3 Task 6：`clip_audio_tracks` 是独立表，主查询已经很宽了，不再往里塞
/// `group_concat` 拼接——单独一次查询把每条素材的音轨列表挂回去，按 `clip_id`
/// 分组、`stream_index` 升序。素材数量以本次交付选中的为界，不是全库扫描。
fn attach_audio_tracks(connection: &Connection, clips: &mut [ExportClip]) -> Result<()> {
    if clips.is_empty() {
        return Ok(());
    }
    let mut by_clip: HashMap<i64, Vec<ExportAudioTrack>> = HashMap::new();
    {
        let selected_clip_ids: Vec<i64> = clips.iter().map(|clip| clip.clip_id).collect();
        let placeholders = std::iter::repeat_n("?", selected_clip_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT clip_id, stream_index, role_guess
             FROM clip_audio_tracks
             WHERE clip_id IN ({})
             ORDER BY clip_id, stream_index",
            placeholders
        );
        let mut statement = connection.prepare(&sql)?;
        let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(selected_clip_ids.len());
        for clip_id in &selected_clip_ids {
            values.push(clip_id);
        }
        let rows = statement.query_map(values.as_slice(), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                ExportAudioTrack {
                    stream_index: row.get(1)?,
                    role_guess: row.get(2)?,
                },
            ))
        })?;
        for row in rows {
            let (clip_id, track) = row?;
            by_clip.entry(clip_id).or_default().push(track);
        }
    }
    for clip in clips.iter_mut() {
        if let Some(tracks) = by_clip.remove(&clip.clip_id) {
            clip.audio_tracks = tracks;
        }
    }
    Ok(())
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

/// 导出清单里的「质量」一列。R14:与池子角标(`src/AnalysisPanel.tsx` `analysisBadgeKinds`)
/// 同一套口径——欠曝/过曝/虚焦/手持抖动/削波/静音/疑似失焦;「过暗」不再单独列
/// (它只是平均亮度低,夜景也低,判不了好坏,已随欠曝的高光守卫一起退场)。
#[allow(clippy::too_many_arguments)]
fn l1_summary(
    exposure: Option<f64>,
    overexposed: Option<f64>,
    underexposed: Option<f64>,
    out_of_focus: Option<f64>,
    shaky: Option<bool>,
    audio_clipped: Option<bool>,
    has_audio: Option<bool>,
    focus_scores: Option<&str>,
) -> String {
    if exposure.is_none() {
        return "未分析".to_owned();
    }
    let ratio = super::analysis::OVEREXPOSED_RATIO_THRESHOLD;
    let mut labels = Vec::new();
    if overexposed.is_some_and(|value| value > ratio) {
        labels.push("过曝");
    }
    if underexposed.is_some_and(|value| value > ratio) {
        labels.push("欠曝");
    }
    if out_of_focus.is_some_and(|value| value > ratio) {
        labels.push("虚焦");
    }
    if shaky == Some(true) {
        labels.push("手持抖动");
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
                transcode_whole_vfr(ffmpeg, clip, output_path, cancellation).map(|fallback_note| {
                    join_notes(
                        Some(format!("VFR 原样封装失败，已转码保留时间轴：{remux_error}")),
                        fallback_note,
                    )
                })
            }
            Err(error) => Err(error),
        };
    }

    // R17 exportfix ④:入点正好落在关键帧上的精选段先试 `-c copy` 帧精确 remux(和整条收藏
    // 一样不重编码),回读 PTS / 首尾帧指纹仍由 verify_segment_pts 把关;对不上就删掉重来,
    // 走转码。B 帧源的尾部常常会因为参考帧被 `-t` 截掉而过不了指纹,那就是「必须转码」的情形。
    if keyframe_aligned_in_point(ffprobe, clip, cancellation)? {
        let remuxed = remux_select_segment(ffmpeg, clip, output_path, cancellation)
            .and_then(|()| verify_segment_pts(ffmpeg, ffprobe, clip, output_path, cancellation));
        match remuxed {
            Ok(note) => return Ok(note),
            Err(error) if cancellation.load(Ordering::SeqCst) => return Err(error),
            Err(error) => {
                tracing::info!(segment_id = ?clip.segment_id, %error, "keyframe-aligned remux rejected; transcoding instead");
                remove_file_if_exists(output_path)?;
            }
        }
    }
    let fallback_note = transcode_select_segment(ffmpeg, clip, output_path, cancellation)?;
    let pts_note = verify_or_warn(
        verify_segment_pts(ffmpeg, ffprobe, clip, output_path, cancellation),
        cancellation,
    )?;
    Ok(join_notes(fallback_note, pts_note))
}

/// 转码本身成功后,回读核对若只是**超时**(不是核对不过),文件保留、结果记一句黄标——
/// 核对是给转码把关的,不能因为核对跑得慢就把正确的导出当失败。核对不过 / 取消照旧报错。
fn verify_or_warn(
    verified: Result<Option<String>>,
    cancellation: &AtomicBool,
) -> Result<Option<String>> {
    match verified {
        Err(CoreError::Export(message))
            if !cancellation.load(Ordering::SeqCst) && message.contains("秒未完成") =>
        {
            tracing::warn!(%message, "segment verification timed out; keeping exported file with a warning");
            Ok(Some("边界核对超时,未能逐帧核对;文件已导出".to_owned()))
        }
        other => other,
    }
}

/// 入点是否正好是源片的一个关键帧:`-skip_frame nokey` 只解关键帧,区间从入点前一点读到
/// 入点后两帧,任一关键帧的 best_effort_timestamp == in_ticks 即算对齐。探测失败按「不对齐」
/// 处理(走原来的转码路,不让探测本身拦住导出)。
fn keyframe_aligned_in_point(
    ffprobe: &OsStr,
    clip: &ExportClip,
    cancellation: &AtomicBool,
) -> Result<bool> {
    let Some(in_ticks) = clip.in_ticks else {
        return Ok(false);
    };
    let start = clip_start_seconds(clip)?;
    let frame = clip_frame_seconds(clip);
    let args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-skip_frame"),
        OsString::from("nokey"),
        OsString::from("-read_intervals"),
        OsString::from(source_probe_interval((start - 0.5).max(0.0), start + frame * 2.0)),
        OsString::from("-show_entries"),
        OsString::from("frame=best_effort_timestamp,key_frame"),
        OsString::from("-of"),
        OsString::from("json"),
        OsString::from(&clip.source_path),
    ];
    let output = execute_with_cancel(ffprobe, &args, TOOL_TIMEOUT, cancellation)
        .map_err(command_io_error)?;
    if !output.success {
        return Ok(false);
    }
    Ok(parse_keyframe_alignment(&output.stdout, in_ticks))
}

fn parse_keyframe_alignment(bytes: &[u8], in_ticks: i64) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    value
        .get("frames")
        .and_then(Value::as_array)
        .is_some_and(|frames| {
            frames.iter().any(|frame| {
                json_i64(frame.get("best_effort_timestamp")) == Some(in_ticks)
                    && json_i64(frame.get("key_frame")).unwrap_or(1) == 1
            })
        })
}

/// 关键帧对齐的精选段 remux 参数:`-ss` 在 `-i` 前(按关键帧 seek,入点本身就是关键帧)、
/// `-t` 截到出点、`-c copy`;不带任何编码器参数。
fn select_segment_copy_args(clip: &ExportClip, output_path: &Path) -> Result<Vec<OsString>> {
    let start = clip_start_seconds(clip)?;
    let duration = clip_duration_seconds(clip);
    if duration <= 0.0 {
        return Err(CoreError::Export(format!(
            "精选段 {} 时长无效",
            clip.segment_id.unwrap_or_default()
        )));
    }
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from(format!("{start:.9}")),
        OsString::from("-i"),
        OsString::from(&clip.source_path),
        OsString::from("-t"),
        OsString::from(format!("{duration:.9}")),
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
        OsString::from("-avoid_negative_ts"),
        OsString::from("make_zero"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-f"),
        OsString::from("mp4"),
        OsString::from("-y"),
        output_path.as_os_str().to_owned(),
    ]);
    Ok(args)
}

fn remux_select_segment(
    ffmpeg: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<()> {
    let args = select_segment_copy_args(clip, output_path)?;
    run_media_command(ffmpeg, &args, EXPORT_TIMEOUT, cancellation, "精选段关键帧 remux")?;
    validate_nonempty(output_path, "精选段")
}

fn join_notes(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(first), Some(second)) => Some(format!("{first};{second}")),
        (first, None) => first,
        (None, second) => second,
    }
}

fn transcode_whole_vfr(
    ffmpeg: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<Option<String>> {
    let encoder = media_tools::encoder_caps(ffmpeg).h264_encoder();
    let args = whole_vfr_args(clip, output_path, encoder);
    let label = format!("VFR 整条 {} 转码", encoder.label());
    run_media_command(ffmpeg, &args, EXPORT_TIMEOUT, cancellation, &label)?;
    validate_nonempty(output_path, "VFR 精选片段")
    .map_err(|error| {
        CoreError::Export(format!(
            "{label}失败（已允许系统软件编码）：{error}"
        ))
    })?;
    Ok(encoder.fallback_note())
}

fn whole_vfr_args(
    clip: &ExportClip,
    output_path: &Path,
    encoder: H264Encoder,
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
    ];
    args.extend(media_tools::h264_encoder_args(
        encoder,
        &export_video_bitrate(&[clip], SEGMENT_BITRATE_CEILING_BPS),
    ));
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

/// Pure arg builder for the frame-accurate select-segment transcode, pulled
/// out of `transcode_select_segment` so the negative LUT assertion (and any
/// other arg-shape test) doesn't need to spawn a real ffmpeg.
fn select_segment_ffmpeg_args(
    clip: &ExportClip,
    output_path: &Path,
    encoder: H264Encoder,
) -> Result<Vec<OsString>> {
    let start = clip_start_seconds(clip)?;
    let duration = clip_duration_seconds(clip);
    if duration <= 0.0 {
        return Err(CoreError::Export(format!(
            "精选段 {} 时长无效",
            clip.segment_id.unwrap_or_default()
        )));
    }
    let mut args = vec![
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
    ];
    args.extend(media_tools::h264_encoder_args(
        encoder,
        &export_video_bitrate(&[clip], SEGMENT_BITRATE_CEILING_BPS),
    ));
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
    Ok(args)
}

/// 帧精确转码;返回值是给用户看的 note(只有兼容编码兜底时才有)。
fn transcode_select_segment(
    ffmpeg: &OsStr,
    clip: &ExportClip,
    output_path: &Path,
    cancellation: &AtomicBool,
) -> Result<Option<String>> {
    let encoder = media_tools::encoder_caps(ffmpeg).h264_encoder();
    let args = select_segment_ffmpeg_args(clip, output_path, encoder)?;
    run_media_command(
        ffmpeg,
        &args,
        EXPORT_TIMEOUT,
        cancellation,
        "精选段帧精确转码",
    )?;
    validate_nonempty(output_path, "精选段")?;
    Ok(encoder.fallback_note())
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
/// 出点之后多解这么久:B 帧重排下 `-read_intervals` 的尾部会少吐最后几帧,出点只能靠
/// 「末帧 + 时长」推断,短 1 帧;多读一段让真正的出点帧被解出来(V-03)。
const SOURCE_PROBE_TAIL_SECONDS: f64 = 1.0;
/// mp4 封装把 AAC 编码器延迟(1024 采样,44.1 kHz ≈ 23 ms)用 `make_zero` 整体前推,
/// 输出视频首帧 pts 因而不是 0。这是封装偏移不是裁错帧,首帧校验放这么多(V-03)。
const MUX_SHIFT_ALLOWANCE_SECONDS: f64 = 0.05;

/// ffprobe `-read_intervals` 的区间串。起点回退到 0 时**不写起点**(`%end`):写 `0%`
/// 会让 ffprobe 向前 seek 到第一个非负关键帧,iPhone / `ffmpeg -ss` 剪出来的片子首个
/// 关键帧 pts 为负(edit list),0.5 s 的入点就被跳过去了(真机 IMG_0822「入点差 12000」)。
fn source_probe_interval(probe_start: f64, probe_end: f64) -> String {
    if probe_start <= 0.0 {
        format!("%{probe_end:.9}")
    } else {
        format!("{probe_start:.9}%{probe_end:.9}")
    }
}

fn mux_shift_allowance_ticks(tb_num: i64, tb_den: i64) -> i64 {
    if tb_num <= 0 || tb_den <= 0 {
        return 0;
    }
    (MUX_SHIFT_ALLOWANCE_SECONDS * tb_den as f64 / tb_num as f64).ceil() as i64
}

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
        return Err(command_failure("ffprobe 精选段 PTS 回读", ffprobe, &output));
    }
    let frame_seconds = clip_frame_seconds(clip);
    let bounds = parse_pts_bounds(&output.stdout, frame_seconds)?;
    let mapped_output = map_output_bounds_to_source_ticks(clip, bounds)?;
    validate_output_pts_bounds(
        mapped_output,
        source_bounds,
        clip_frame_ticks(clip),
        mux_shift_allowance_ticks(clip.tb_num.unwrap_or(0), clip.tb_den.unwrap_or(0)),
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
    let probe_end = end_seconds + clip_frame_seconds(clip) * 2.0 + SOURCE_PROBE_TAIL_SECONDS;
    let source_args = [
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-select_streams"),
        OsString::from("v:0"),
        OsString::from("-read_intervals"),
        // ffprobe seeks intervals to an earlier keyframe. Use an absolute end and
        // filter decoded frame PTS below instead of assuming start%+duration begins
        // exactly at the requested non-keyframe timestamp.
        OsString::from(source_probe_interval(probe_start, probe_end)),
        OsString::from("-show_entries"),
        OsString::from("frame=best_effort_timestamp,pkt_duration,duration"),
        OsString::from("-of"),
        OsString::from("json"),
        OsString::from(&clip.source_path),
    ];
    let source_output = execute_with_cancel(
        ffprobe,
        &source_args,
        probe_timeout(probe_end - probe_start),
        cancellation,
    )
    .map_err(command_io_error)?;
    if !source_output.success {
        return Err(command_failure("ffprobe 源片 PTS 边界回读", ffprobe, &source_output));
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
        return Err(pts_mismatch_error(first_delta, end_delta, tolerance));
    }
    Ok(())
}

/// 输出侧校验:首帧允许「1 帧 + 封装偏移」(见 `MUX_SHIFT_ALLOWANCE_SECONDS`),
/// 段长(尾 − 首)仍只容 1 帧 —— 偏移是整体平移,段长错了才是真裁错。
fn validate_output_pts_bounds(
    output: TickBounds,
    source: TickBounds,
    tolerance_ticks: i64,
    shift_allowance_ticks: i64,
) -> Result<()> {
    let tolerance = tolerance_ticks.max(1);
    let first_delta = output.first.abs_diff(source.first) as i64;
    let span_delta = (output.end - output.first).abs_diff(source.end - source.first) as i64;
    if first_delta > tolerance + shift_allowance_ticks.max(0) || span_delta > tolerance {
        return Err(pts_mismatch_error(first_delta, span_delta, tolerance));
    }
    Ok(())
}

/// 给用户看的话:不出 PTS / tick,差多少按帧说,并告诉他现在怎么办。
fn pts_mismatch_error(first_delta_ticks: i64, end_delta_ticks: i64, frame_ticks: i64) -> CoreError {
    let frames = |ticks: i64| (ticks as f64 / frame_ticks.max(1) as f64 * 10.0).round() / 10.0;
    CoreError::Export(format!(
        "这段的起止点和视频帧对不上（入点差 {} 帧，出点差 {} 帧），请在监视器里把入出点微调一下再导出",
        frames(first_delta_ticks),
        frames(end_delta_ticks)
    ))
}

/// 进度项的 note 是直接给用户看的一句话:`CoreError::Export` 已经是人话,去掉
/// `export failed:` 这种英文前缀;其它错误保留原文(至少不丢信息)。
fn failure_note(error: &CoreError) -> String {
    match error {
        CoreError::Export(message) => message.clone(),
        other => other.to_string(),
    }
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
    let output = execute_with_cancel(
        ffmpeg,
        &args,
        probe_timeout(SOURCE_PROBE_ROLLBACK_SECONDS + at_seconds.min(SOURCE_PROBE_ROLLBACK_SECONDS)),
        cancellation,
    )
    .map_err(command_io_error)?;
    if !output.success {
        return Err(command_failure(&format!("{label}内容指纹提取"), ffmpeg, &output));
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

/// R6 Task 6 G9：参考粗剪允许的目标时长——其它值一律拒绝，不猜测最接近值。
const ALLOWED_ROUGH_CUT_TARGETS: [u32; 3] = [30, 60, 180];

/// `rough_cut_actual_ticks`/`RoughCutSelectionSummary::actual_ticks` 的统一记账时基：
/// 毫秒（1/1000），只用于跨素材求和与展示，不参与实际裁切（裁切都在各素材原生
/// tb_num/tb_den 上用整数完成）。
const ROUGH_CUT_SUMMARY_TB_NUM: i64 = 1;
const ROUGH_CUT_SUMMARY_TB_DEN: i64 = 1000;

fn validate_rough_cut_target(target_seconds: Option<u32>) -> Result<()> {
    match target_seconds {
        None => Ok(()),
        Some(value) if ALLOWED_ROUGH_CUT_TARGETS.contains(&value) => Ok(()),
        Some(value) => Err(CoreError::Export(format!(
            "参考粗剪目标时长只能是 30/60/180 秒，收到 {value}"
        ))),
    }
}

/// 素材自己 time_base 下的完整选段区间；缺 ticks/tb（老数据或整条收藏走了别的
/// 兜底路径）时返回 `None`，调用方按"整条保留、不参与预算裁切"处理。
fn native_ticks(clip: &ExportClip) -> Option<(i64, i64, i64, i64)> {
    match (clip.in_ticks, clip.out_ticks, clip.tb_num, clip.tb_den) {
        (Some(start), Some(end), Some(num), Some(den)) if end >= start && num > 0 && den > 0 => {
            Some((start, end, num, den))
        }
        _ => None,
    }
}

/// `ticks`（该素材原生 tb）换算成毫秒，向下取整；只用于预算记账，不落地成
/// 裁切边界本身（裁切边界永远是整数 ticks）。
fn ticks_to_millis(ticks: i64, tb_num: i64, tb_den: i64) -> i64 {
    if tb_den <= 0 {
        return 0;
    }
    ((ticks as i128) * (tb_num as i128) * 1_000 / (tb_den as i128)) as i64
}

/// `seconds` 换算成该素材原生 tb 下的 ticks 数（整数除法，向下取整）。
fn seconds_to_ticks(seconds: i64, tb_num: i64, tb_den: i64) -> i64 {
    if tb_num <= 0 {
        return 0;
    }
    ((seconds as i128) * (tb_den as i128) / (tb_num as i128)) as i64
}

/// `millis` 换算成该素材原生 tb 下的 ticks 数（整数除法，向下取整）——
/// `ticks_to_millis` 的逆运算。第二轮延展把"剩余预算（毫秒）"换算回正在
/// 延展的这条素材自己的 tb 时用它，不能直接把别的素材算出来的 ticks 套用。
fn millis_to_ticks(millis: i64, tb_num: i64, tb_den: i64) -> i64 {
    if tb_num <= 0 {
        return 0;
    }
    ((millis as i128) * (tb_den as i128) / (tb_num as i128 * 1_000)) as i64
}

fn ticks_to_millis_for_clip(clip: &ExportClip) -> i64 {
    match native_ticks(clip) {
        Some((start, end, num, den)) => ticks_to_millis(end - start, num, den),
        None => (clip_duration_seconds(clip) * 1_000.0).round() as i64,
    }
}

/// 参考粗剪目标时长选段的汇总——全部按 ticks 记账，不落地浮点秒。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RoughCutSelectionSummary {
    actual_ticks: i64,
    actual_tb_num: i64,
    actual_tb_den: i64,
}

/// 按 beat 顺序（即 `clips` 本身的顺序）与预算截取参考粗剪要用到的素材：
/// - `cap = max(2s, target / clip_count)`（在每条素材自己的 tb 下用整数算出），
///   每条素材最多贡献这么多；
/// - 按顺序累计，一旦达到目标秒数就停止——后面的素材整条不出现在粗剪里；
/// - 单条素材的裁切结果不低于 1 秒，除非它本来就比 1 秒短（这时保留原长）；
/// - 第一遍跑完仍不够目标时，按素材原长从长到短把已选的素材补到全长，直到
///   用满预算或全部都已经是全长。
///
/// `target_seconds` 为 `None` 时原样返回全部素材（保持 G9 之前的行为）。
fn select_rough_cut(
    clips: &[SuccessfulClip],
    target_seconds: Option<u32>,
) -> Result<(Vec<SuccessfulClip>, RoughCutSelectionSummary)> {
    validate_rough_cut_target(target_seconds)?;

    let Some(target_seconds) = target_seconds else {
        let actual_ticks = clips.iter().map(|clip| ticks_to_millis_for_clip(&clip.clip)).sum();
        return Ok((
            clips.to_vec(),
            RoughCutSelectionSummary {
                actual_ticks,
                actual_tb_num: ROUGH_CUT_SUMMARY_TB_NUM,
                actual_tb_den: ROUGH_CUT_SUMMARY_TB_DEN,
            },
        ));
    };

    let clip_count = (clips.len() as i64).max(1);
    let target_millis = (target_seconds as i64) * 1_000;

    // 每条素材贡献多少 ticks（原生 tb）；`i64::MAX` 是哨兵值，表示"没有可用
    // ticks，整条保留、不参与预算裁切"。
    const KEEP_WHOLE: i64 = i64::MAX;
    let mut contributions: Vec<i64> = Vec::with_capacity(clips.len());
    let mut accumulated_millis: i64 = 0;
    let mut reached_budget = false;

    for clip in clips {
        if reached_budget {
            contributions.push(0);
            continue;
        }
        let Some((in_ticks, out_ticks, tb_num, tb_den)) = native_ticks(&clip.clip) else {
            accumulated_millis += ticks_to_millis_for_clip(&clip.clip);
            contributions.push(KEEP_WHOLE);
            reached_budget = accumulated_millis >= target_millis;
            continue;
        };
        let segment_ticks = out_ticks - in_ticks;
        let one_second_ticks = seconds_to_ticks(1, tb_num, tb_den);
        let two_second_ticks = seconds_to_ticks(2, tb_num, tb_den);
        let per_clip_budget_ticks = seconds_to_ticks(target_seconds as i64, tb_num, tb_den) / clip_count;
        let cap_ticks = two_second_ticks.max(per_clip_budget_ticks);
        let mut contribution_ticks = segment_ticks.min(cap_ticks).max(0);
        if contribution_ticks < one_second_ticks {
            contribution_ticks = segment_ticks.min(one_second_ticks).max(0);
        }
        contributions.push(contribution_ticks);
        accumulated_millis += ticks_to_millis(contribution_ticks, tb_num, tb_den);
        reached_budget = accumulated_millis >= target_millis;
    }

    if accumulated_millis < target_millis {
        let mut extendable: Vec<usize> = (0..clips.len())
            .filter(|&index| contributions[index] != KEEP_WHOLE)
            .collect();
        extendable.sort_by_key(|&index| {
            let (in_ticks, out_ticks, _, _) = native_ticks(&clips[index].clip).unwrap();
            std::cmp::Reverse(out_ticks - in_ticks)
        });
        for index in extendable {
            if accumulated_millis >= target_millis {
                break;
            }
            let (in_ticks, out_ticks, tb_num, tb_den) = native_ticks(&clips[index].clip).unwrap();
            let segment_ticks = out_ticks - in_ticks;
            if contributions[index] >= segment_ticks {
                continue;
            }
            // 只把这条素材延展到"用满剩余预算"或"到它自己的全长"为止，
            // 谁先到就停在谁那——不能像旧代码那样直接跳到全长，那会把
            // 30 秒的预算撑成 60 秒。剩余预算是毫秒记账，换算回这条素材
            // 自己的 tb 才能跟它的 ticks 相加减。
            let remaining_budget_millis = (target_millis - accumulated_millis).max(0);
            let remaining_budget_ticks = millis_to_ticks(remaining_budget_millis, tb_num, tb_den);
            let extend_by_ticks = remaining_budget_ticks
                .min(segment_ticks - contributions[index])
                .max(0);
            if extend_by_ticks == 0 {
                continue;
            }
            let old_millis = ticks_to_millis(contributions[index], tb_num, tb_den);
            contributions[index] += extend_by_ticks;
            accumulated_millis += ticks_to_millis(contributions[index], tb_num, tb_den) - old_millis;
        }
    }

    let mut selected = Vec::with_capacity(clips.len());
    for (clip, &contribution) in clips.iter().zip(contributions.iter()) {
        if contribution == 0 {
            continue;
        }
        if contribution == KEEP_WHOLE {
            selected.push(clip.clone());
            continue;
        }
        let (in_ticks, _, _, _) = native_ticks(&clip.clip).unwrap();
        let mut adjusted = clip.clone();
        adjusted.clip.out_ticks = Some(in_ticks + contribution);
        selected.push(adjusted);
    }

    let actual_ticks = selected.iter().map(|clip| ticks_to_millis_for_clip(&clip.clip)).sum();

    Ok((
        selected,
        RoughCutSelectionSummary {
            actual_ticks,
            actual_tb_num: ROUGH_CUT_SUMMARY_TB_NUM,
            actual_tb_den: ROUGH_CUT_SUMMARY_TB_DEN,
        },
    ))
}

fn transcode_rough_cut(
    ffmpeg: &OsStr,
    ffprobe: &OsStr,
    clips: &[SuccessfulClip],
    output_path: &Path,
    canvas: &ExportCanvas,
    cancellation: &AtomicBool,
) -> Result<()> {
    let audio_presence = clips
        .iter()
        .map(|item| match item.clip.has_audio {
            Some(value) => Ok(value),
            None => probe_has_audio(ffprobe, &item.path, cancellation),
        })
        .collect::<Result<Vec<_>>>()?;
    let encoder = media_tools::encoder_caps(ffmpeg).h264_encoder();
    if let Some(note) = encoder.fallback_note() {
        tracing::warn!(%note, "rough cut falls back to a software encoder");
    }
    let args = rough_cut_args(clips, &audio_presence, output_path, canvas, encoder);
    let label = format!("参考粗剪 {} 转码", encoder.label());
    run_media_command(ffmpeg, &args, EXPORT_TIMEOUT, cancellation, &label)
    .map_err(|error| {
        CoreError::Export(format!(
            "{label}失败（已允许系统软件编码）：{error}"
        ))
    })?;
    validate_nonempty(output_path, "参考粗剪")
}

/// R6 Task 7b:粗剪转码里 `clips.manual_rotation` 的 `vf` 前缀——只在 rotate
/// 标签兜底命中(没有 side_data 显示矩阵)时非空,插在 scale 之前才能让缩放
/// 按转正后的宽高比走,不然横竖颠倒的画面会被硬塞进 16:9。90°/270° 各转一次
/// `transpose`;180° 用 `hflip,vflip`(两次 transpose 与之等价,这里按任务卡
/// 指定的写法,和 `core::artifacts` 里另一套缩略图/预览用的 `transpose,transpose`
/// 写法不是同一处代码,不必统一)。
fn rough_cut_rotation_prefix(manual_rotation: Option<i64>) -> Option<&'static str> {
    match manual_rotation {
        Some(90) => Some("transpose=1,"),
        Some(180) => Some("hflip,vflip,"),
        Some(270) => Some("transpose=2,"),
        _ => None,
    }
}

fn rough_cut_args(
    clips: &[SuccessfulClip],
    audio_presence: &[bool],
    output_path: &Path,
    canvas: &ExportCanvas,
    encoder: H264Encoder,
) -> Vec<OsString> {
    // R10 R-03:画布来自本次交付解析出的 `ExportCanvas`(竖版 1080×1920 等),
    // 不再写死 1920×1080——否则竖版交付的参考粗剪会变成横片两侧黑边。
    let (canvas_w, canvas_h) = (canvas.width.max(2), canvas.height.max(2));
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
        let rotate_prefix = rough_cut_rotation_prefix(clip.clip.manual_rotation).unwrap_or("");
        filters.push(format!(
            "[{index}:v:0]{rotate_prefix}scale={canvas_w}:{canvas_h}:force_original_aspect_ratio=decrease,pad={canvas_w}:{canvas_h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,trim=duration={duration:.6},setpts=PTS-STARTPTS[v{index}]"
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
    ]);
    args.extend(media_tools::h264_encoder_args(
        encoder,
        &export_video_bitrate(
            &clips.iter().map(|item| &item.clip).collect::<Vec<_>>(),
            ROUGH_CUT_BITRATE_CEILING_BPS,
        ),
    ));
    args.extend([
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
        return Err(command_failure("ffprobe 音轨探测", ffprobe, &output));
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
        return Err(command_failure(label, executable, &output));
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
        CommandError::Io(error) if error.kind() == std::io::ErrorKind::TimedOut => {
            CoreError::Export(format!("媒体工具{error}（素材太大或电脑太忙）"))
        }
        CommandError::Io(error) => CoreError::Export(format!(
            "找不到或无法运行媒体工具（可设置 FFMPEG_PATH/FFPROBE_PATH）：{error}"
        )),
    }
}

/// 「<label>失败(退出码 n,ffmpeg 7.1.5 (…/MacOS/ffmpeg)):…」—— 带上是哪份工具
/// (只留父目录名 + 文件名,不泄露全路径),下次截图就能看出解析到了哪份 ffmpeg(R17 exportfix)。
fn command_failure(label: &str, executable: &OsStr, output: &CommandOutput) -> CoreError {
    CoreError::Export(format!(
        "{label}失败（退出码 {}，{}）：{}",
        output
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_owned()),
        media_tools::describe_tool(executable),
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

/// 交付包 / 素材包共用的判断:这条 clip 有没有一份可用的 SRT——已转写、没被裁剪过
/// (裁剪段的时间戳保证是错的,P3-D1 范围之外不做重新对时)、原文件此刻还在。两处只是
/// 各自决定抄到哪儿,判断逻辑不重复。
fn resolved_subtitle_source(cache_root: &Path, clip: &ExportClip, item: &ExportItemStatus) -> Option<PathBuf> {
    if item.status != "done" {
        return None;
    }
    let relative = clip.srt_rel_path.as_deref()?;
    if clip.selection_kind == "select" {
        return None;
    }
    let expected = PathBuf::from(clip.clip_id.to_string()).join(super::transcribe::SRT_FILE);
    if Path::new(relative) != expected.as_path() {
        return None;
    }
    let source = cache_root.join(&expected);
    source.is_file().then_some(source)
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
        let Some(source) = resolved_subtitle_source(&cache_root, clip, item) else {
            continue;
        };
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

/// J-05:素材包里的 SRT 跟视频同名同目录(有章节子目录时也在同一个子目录里),不像完整
/// 交付包那样收进单独的字幕文件夹——剪映用户把两个文件一起拖进时间线就能对上时间码。
/// 判断复用 [`resolved_subtitle_source`],不重抄一遍。
fn copy_kit_subtitles(
    connection: &Connection,
    clips: &[ExportClip],
    items: &[ExportItemStatus],
    staging_path: &Path,
) -> Result<u64> {
    let Some(db_path) = connection.path() else {
        return Ok(0);
    };
    let cache_root = super::artifacts::cache_root_for_db(Path::new(db_path));
    let mut copied = 0_u64;

    for (clip, item) in clips.iter().zip(items) {
        let Some(source) = resolved_subtitle_source(&cache_root, clip, item) else {
            continue;
        };
        let output_path = staging_path.join(Path::new(&item.output_name).with_extension("srt"));
        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = std::fs::read(&source)?;
        write_synced(&output_path, &bytes)?;
        copied += 1;
    }
    Ok(copied)
}

/// J-05:本集有配乐(与剪映草稿同一份 `music_tracks` 挑选逻辑,见
/// [`super::jianying::kit_selected_music_file`])就把原文件抄一份到素材包根目录;
/// 没有配乐、或原文件此刻不在了,静默跳过(不是缺陷,只是没有可带的音乐)。
fn copy_kit_music(connection: &Connection, episode_id: i64, staging_path: &Path) -> Result<()> {
    let Some((file_name, source_path)) = super::jianying::kit_selected_music_file(connection, episode_id)? else {
        return Ok(());
    };
    let bytes = std::fs::read(&source_path)?;
    write_synced(&staging_path.join(&file_name), &bytes)?;
    Ok(())
}

/// R4 Task 3:一条素材的封面 JPEG,原样按 `cache_artifacts` 的产物有效性规则
/// 核对(`kind='cover'` 且 `source_hash` 命中当前 `quick_hash`,rel_path 与
/// 期望路径一致)——和 `artifacts::cover_urls` 同一套判定,只是这里要的是文件
/// 字节而不是签名 URL。查不到、hash 不匹配或文件缺失都返回 `None`,联系表
/// 那一格退回灰色占位,不让一张坏封面炸掉整份 PDF。
fn resolve_cover_jpeg(connection: &Connection, cache_root: &Path, clip: &ExportClip) -> Option<Vec<u8>> {
    let rel_path: String = connection
        .query_row(
            "SELECT rel_path FROM cache_artifacts
             WHERE clip_id = ?1 AND kind = 'cover' AND source_hash = ?2",
            params![clip.clip_id, clip.quick_hash],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()?;
    let expected = super::artifacts::artifact_relative_path(clip.clip_id, super::artifacts::COVER_FILE);
    if Path::new(&rel_path) != expected.as_path() {
        return None;
    }
    std::fs::read(cache_root.join(&expected)).ok()
}

/// 联系表条目严格按 CSV 那一份顺序构建(同一个 `clips` 切片,同一次遍历)——
/// 剪辑师拿着两份纸对照时,序号必须一一对应。
fn build_contact_sheet_items(
    connection: &Connection,
    cache_root: &Path,
    clips: &[ExportClip],
) -> Vec<contact_sheet::ContactSheetItem> {
    clips
        .iter()
        .enumerate()
        .map(|(index, clip)| {
            let start_seconds = clip_start_seconds(clip).unwrap_or(0.0);
            let end_seconds = start_seconds + clip_duration_seconds(clip);
            contact_sheet::ContactSheetItem {
                order: index + 1,
                file_name: clip.file_name.clone(),
                in_clock: format_clock(start_seconds),
                out_clock: format_clock(end_seconds),
                chapter_title: (!clip.chapter_title.is_empty()).then(|| clip.chapter_title.clone()),
                cover_jpeg: resolve_cover_jpeg(connection, cache_root, clip),
            }
        })
        .collect()
}

/// R4 Task 3:渲染 `05_镜头表/联系表.pdf`。先渲染到一个同目录的临时文件,再
/// 整体读回、走 `write_synced` 落到最终路径——和 CSV/字幕同一套 fsync 纪律,
/// 不能因为这份产物是"锦上添花"就少一层落盘保证。渲染失败或临时文件读取
/// 失败都原样把错误往上抛,调用方负责把它降级成交付说明里的一句话而不是
/// 让整个导出失败。
/// R4 Task 3 复审:`render_contact_sheet` 成功之后,`fs::read` 或
/// `write_synced` 任何一步失败都不能把 `联系表.pdf.rendering` 这份临时文件
/// 留在 `05_镜头表/` 里被打包——它一进包就是一份剪辑师看不懂的杂物。用
/// `Drop` 兜底,不管返回路径是哪一条(`?` 提前返回也算),守卫离开作用域
/// 时都会尝试删除;文件已经被正常挪走(重命名/删除)后再删一次是
/// `NotFound`,原样忽略。
struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %self.0.display(), %error, "清理联系表临时文件失败");
            }
        }
    }
}

fn write_contact_sheet(
    connection: &Connection,
    staging_path: &Path,
    episode_id: i64,
    payload: &ExportJobPayload,
) -> Result<contact_sheet::ContactSheetStats> {
    let episode_title: String = connection.query_row(
        "SELECT title FROM episodes WHERE id = ?1",
        [episode_id],
        |row| row.get(0),
    )?;
    let db_path = connection
        .path()
        .ok_or_else(|| CoreError::ContactSheet("无法定位素材缓存目录".to_owned()))?;
    let cache_root = super::artifacts::cache_root_for_db(Path::new(db_path));
    let items = build_contact_sheet_items(connection, &cache_root, &payload.clips);
    let portrait = payload.platform_info.orientation == "portrait";
    let options = contact_sheet::ContactSheetOptions {
        title: format!("{episode_title} 联系表"),
        portrait,
        columns: if portrait { 3 } else { 4 },
    };
    let final_path = staging_path.join(CONTACT_SHEET_FILE);
    let temporary_path = final_path.with_extension("pdf.rendering");
    let stats = contact_sheet::render_contact_sheet(&items, &options, &temporary_path)?;
    let _guard = TempFileGuard(temporary_path.clone());
    let bytes = std::fs::read(&temporary_path)?;
    write_synced(&final_path, &bytes)?;
    Ok(stats)
}

fn build_shot_list_csv(
    clips: &[ExportClip],
    items: &[ExportItemStatus],
    platform_info: &ExportPlatformInfo,
) -> String {
    let mut csv = String::from(
        "\u{feff}顺序号,文件名,包内路径,入点,出点,段时长,分辨率,编码,FPS,VFR,拍摄时间,Chapter,Beat,星级,L1角标摘要,对白摘要,平台,画布,转录音轨,备注\r\n",
    );
    let platform_column = platform_info.display_name.clone();
    let canvas_column = format!("{}x{}", platform_info.canvas_width, platform_info.canvas_height);
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
        // 只有明确选择过、或探测到过音轨的素材才写序号；从没探测过音轨的
        // 旧素材留空，不能让空表也显示误导性的"0"。
        let transcribe_track_column = if clip.selected_transcribe_track.is_some()
            || !clip.audio_tracks.is_empty()
        {
            effective_transcribe_track(clip).to_string()
        } else {
            String::new()
        };
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
            platform_column.clone(),
            canvas_column.clone(),
            transcribe_track_column,
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

/// R3 Task 6：只要有素材探测到 ≥2 路音轨，就在交付说明里留一句人话映射，
/// 说清楚哪一路被转录用了、其余是什么角色——不然剪辑师打开草稿只看到一条
/// 混好的音轨，看不出转录字幕对应的是哪一路麦。最多列 3 条素材，超出的
/// 折成"等 N 条"（N 是列表之外还剩多少条，不含已展示的 3 条）。
fn audio_track_mapping_step(clips: &[ExportClip]) -> Option<String> {
    const MAX_LISTED: usize = 3;
    let multi_track_clips: Vec<&ExportClip> = clips
        .iter()
        .filter(|clip| clip.audio_tracks.len() >= 2)
        .collect();
    if multi_track_clips.is_empty() {
        return None;
    }
    let entries = multi_track_clips
        .iter()
        .take(MAX_LISTED)
        .map(|clip| {
            let transcribe_track = effective_transcribe_track(clip);
            let tracks = clip
                .audio_tracks
                .iter()
                .map(|track| {
                    let label = audio_role_label(track.role_guess.as_deref());
                    if track.stream_index == transcribe_track {
                        format!("{}={label}（转录）", track.stream_index)
                    } else {
                        format!("{}={label}", track.stream_index)
                    }
                })
                .collect::<Vec<_>>()
                .join("/");
            format!("{} {tracks}", clip.file_name)
        })
        .collect::<Vec<_>>()
        .join("；");
    let remaining = multi_track_clips.len().saturating_sub(MAX_LISTED);
    let suffix = if remaining > 0 {
        format!("；等 {remaining} 条")
    } else {
        String::new()
    };
    Some(format!("音轨映射：{entries}{suffix}"))
}

/// R4 Task 3:联系表这一步是否真的落地了 PDF,以及给交付说明追加什么话——
/// 关闭/失败两种情况都不能让 05 步的说明句提到一份并不存在的文件。
enum ContactSheetOutcome {
    Disabled,
    Written { glyph_fallbacks: usize, cover_failures: usize },
    Failed { message: String },
}

fn build_instructions(
    payload: &ExportJobPayload,
    subtitle_count: u64,
    destination_count: u64,
    narration_outcome: NarrationOutcome,
    contact_sheet: &ContactSheetOutcome,
) -> String {
    let subtitle_step = if subtitle_count > 0 {
        format!(
            "“{SUBTITLE_DIRECTORY}/”含 {subtitle_count} 条与精选素材同序号的标准 SRT；请在当前剪映版本导入并核对时间轴。"
        )
    } else {
        format!("本次没有可用转写，未创建“{SUBTITLE_DIRECTORY}/”；这不会阻塞素材交付。")
    };
    let narration_step = match narration_outcome {
        NarrationOutcome::WrittenConfirmed => format!(
            "“{NARRATION_DIRECTORY}/旁白稿.txt”按已确认的叙事分章与 beat 理由生成草稿，可直接改写后配音。旁白稿：已确认。"
        ),
        NarrationOutcome::WrittenSuggested => format!(
            "“{NARRATION_DIRECTORY}/旁白稿.txt”按 AI 建议(未经人工确认)的叙事分章与 beat 理由生成草稿，请人工核实后再配音。旁白稿：AI 建议稿（未确认）。"
        ),
        NarrationOutcome::NotWritten => format!(
            "本次无旁白稿，未在“{NARRATION_DIRECTORY}/”写入草稿；请在旅剪工作台确认叙事分章后重新生成交付包。"
        ),
    };
    let shot_list_step = if matches!(contact_sheet, ContactSheetOutcome::Written { .. }) {
        format!(
            "“{SHOT_LIST_FILE}”含包内路径、画面参数、VFR、星级、L1 角标和对白摘要，以及联系表 PDF（“{CONTACT_SHEET_FILE}”）。"
        )
    } else {
        format!("“{SHOT_LIST_FILE}”含包内路径、画面参数、VFR、星级、L1 角标和对白摘要。")
    };
    let mut steps: Vec<String> = vec![
        "打开剪映专业版，新建草稿。".to_owned(),
        format!("将“{SELECTED_DIRECTORY}”拖入素材区；文件名前三位就是推荐顺序。"),
        format!(
            "“{ROUGH_CUT_FILE}”是 {}×{} H.264/AAC 参考粗剪，可直接预览故事顺序。",
            payload.platform_info.canvas_width, payload.platform_info.canvas_height
        ),
        subtitle_step,
        shot_list_step,
        narration_step,
        format!("“{COLOR_NOTES_DIRECTORY}/”本版本为空目录，后续版本填充色彩说明。"),
    ];
    if let Some(target_seconds) = payload.target_seconds {
        let actual_seconds = payload.rough_cut_actual_ticks.map(|ticks| {
            let tb_num = payload.rough_cut_actual_tb_num.unwrap_or(1).max(1);
            let tb_den = payload.rough_cut_actual_tb_den.unwrap_or(1).max(1);
            ticks as f64 * tb_num as f64 / tb_den as f64
        });
        steps.push(match actual_seconds {
            Some(actual_seconds) => {
                format!("参考粗剪：目标 {target_seconds} 秒，实际 {actual_seconds:.1} 秒。")
            }
            None => format!("参考粗剪：目标 {target_seconds} 秒。"),
        });
    }
    match contact_sheet {
        ContactSheetOutcome::Written { glyph_fallbacks, cover_failures } => {
            if *glyph_fallbacks > 0 {
                steps.push(format!("联系表中 {glyph_fallbacks} 个字符字体不含，已用 □ 替代"));
            }
            if *cover_failures > 0 {
                steps.push(format!("联系表：{cover_failures} 张封面无法解码，已用灰框占位"));
            }
        }
        ContactSheetOutcome::Failed { message } => {
            steps.push(format!("联系表生成失败：{message}"));
        }
        _ => {}
    }
    if destination_count > 0 {
        steps.push(format!(
            "“{DESTINATION_DIRECTORY}/”含 {destination_count} 张地点卡；待核实卡只导出状态占位，不会把模型草稿写入交付说明。"
        ));
    }
    if let Some(mapping_step) = audio_track_mapping_step(&payload.clips) {
        steps.push(mapping_step);
    }
    let orientation_label = if payload.platform_info.orientation == "portrait" {
        "竖版"
    } else {
        "横版"
    };
    let budget_label = if payload.platform_info.duration_budget_seconds > 0 {
        format!("建议时长 ≤ {} s", payload.platform_info.duration_budget_seconds)
    } else {
        "不限时长".to_owned()
    };
    steps.push(format!(
        "目标平台：{}（{orientation_label} {}×{}，{budget_label}）",
        payload.platform_info.display_name,
        payload.platform_info.canvas_width,
        payload.platform_info.canvas_height,
    ));
    let numbered_steps = steps
        .iter()
        .enumerate()
        .map(|(index, step)| format!("{}. {step}", index + 1))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "旅剪工作台 · 稳定交付包\n\n\
         {numbered_steps}\n\n\
         本包不会修改原片。用户打点的精选段按源 time_base 入出点重编码，并回读首尾 PTS；超过 1 帧的偏差会在镜头表中以“⚠ 黄标”注明。没有精选段但用 F 收藏的素材仍按整条 remux。\n\
         参考粗剪统一为 30fps、画布 {}×{}，使用 macOS VideoToolbox，并允许系统提供的软件编码路径。\n\
         本次精选 {} 条，成功 {} 条，失败 {} 条。失败原因见镜头表“备注”列。\n",
        payload.platform_info.canvas_width,
        payload.platform_info.canvas_height,
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

const NARRATION_SCRIPT_FILE_NAME: &str = "旁白稿.txt";
const NARRATION_AI_DRAFT_HEADER: &str = "（AI 建议稿，未经人工确认）";

/// R6 Task 7b:交付包写入旁白稿草稿是否落地，以及信任等级——与
/// `write_destination_cards`（07_地点卡）和 beat order 对齐后，已确认
/// (confirmed) 与 AI 建议(suggested) 两种叙事修订都写，只是建议版会在文件
/// 与交付说明里标注“未经人工确认”，不让模型草稿被当成定稿直接配音。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NarrationOutcome {
    NotWritten,
    WrittenConfirmed,
    WrittenSuggested,
}

/// R2 G10 / R6 Task 7b:交付包写入旁白稿草稿——存在“已确认(confirmed)”或
/// “AI 建议(suggested)”叙事修订且至少一章时写入，来自该版本的章节标题与
/// beat rationale（旁白提示）。建议版会在文件头与交付说明里标注未经人工确认。
fn write_narration_script(
    connection: &Connection,
    staging_path: &Path,
    episode_id: i64,
) -> Result<NarrationOutcome> {
    if super::settings::string_value(connection, super::settings::LLM_ENABLED_KEY, "false")?
        != "true"
    {
        return Ok(NarrationOutcome::NotWritten);
    }
    let Some(revision) = super::narrative_revision::revision_info(connection, episode_id)? else {
        return Ok(NarrationOutcome::NotWritten);
    };
    let is_confirmed = match revision.kind.as_str() {
        "confirmed" => true,
        "suggested" => false,
        _ => return Ok(NarrationOutcome::NotWritten),
    };
    let Some(overview) = super::narrative::load_overview_for_episode(connection, episode_id)?
    else {
        return Ok(NarrationOutcome::NotWritten);
    };
    if overview.chapters.is_empty() {
        return Ok(NarrationOutcome::NotWritten);
    }

    let mut body = String::from("# 旁白稿（草稿，按需改写）\n");
    if !is_confirmed {
        body.push_str(NARRATION_AI_DRAFT_HEADER);
        body.push('\n');
    }
    for (index, chapter) in overview.chapters.iter().enumerate() {
        body.push_str(&format!("\n## 第 {} 章 {}\n", index + 1, chapter.title));
        for beat in &chapter.beats {
            let (file_name, in_ticks, out_ticks, tb_num, tb_den) =
                narration_beat_clip(connection, beat.clip_id, beat.segment_id)?;
            let start = format_clock(ticks_to_seconds(in_ticks, tb_num, tb_den));
            let end = format_clock(ticks_to_seconds(out_ticks, tb_num, tb_den));
            body.push_str(&format!("[{start}–{end}] {file_name} — {}\n", beat.rationale));
        }
    }
    write_synced(
        &staging_path.join(NARRATION_DIRECTORY).join(NARRATION_SCRIPT_FILE_NAME),
        body.as_bytes(),
    )?;
    Ok(if is_confirmed {
        NarrationOutcome::WrittenConfirmed
    } else {
        NarrationOutcome::WrittenSuggested
    })
}

/// beat 只存 clip_id/segment_id;旁白稿要落地时码与文件名，回查素材的
/// time_base 与（若有）精选段入出点——没有 segment 时按整条素材时长。
fn narration_beat_clip(
    connection: &Connection,
    clip_id: i64,
    segment_id: Option<i64>,
) -> Result<(String, i64, i64, i64, i64)> {
    let (rel_path, tb_num, tb_den, duration_ticks): (String, i64, i64, i64) = connection
        .query_row(
            "SELECT rel_path, COALESCE(tb_num, 0), COALESCE(tb_den, 0), COALESCE(duration_ticks, 0)
             FROM clips WHERE id = ?1",
            [clip_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let (in_ticks, out_ticks) = match segment_id {
        Some(id) => connection.query_row(
            "SELECT in_ticks, out_ticks FROM segments WHERE id = ?1",
            [id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?,
        None => (0, duration_ticks),
    };
    let file_name = Path::new(&rel_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or(rel_path);
    Ok((file_name, in_ticks, out_ticks, tb_num, tb_den))
}

fn ticks_to_seconds(ticks: i64, tb_num: i64, tb_den: i64) -> f64 {
    // 复用 canonical_time 的取整语义(四舍五入到微秒)而不是重复一份换算——
    // 与 canonical_time::ticks_to_micros 保持同一份实现。
    super::canonical_time::ticks_to_micros(ticks, tb_num, tb_den)
        .map(|micros| micros as f64 / 1_000_000.0)
        .unwrap_or(0.0)
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

/// 交付包文件夹里的集名:去掉路径分隔符与 macOS / Windows 都不接受的字符,压掉首尾空白与点
/// (以点开头会变隐藏目录),截到 [`PACKAGE_TITLE_MAX_CHARS`] 个字符;什么都不剩就回落「旅剪项目」。
fn package_project_name(episode_title: &str) -> String {
    const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'];
    let cleaned: String = episode_title
        .chars()
        .filter(|ch| !FORBIDDEN.contains(ch) && !ch.is_control())
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .trim()
        .chars()
        .take(PACKAGE_TITLE_MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_owned();
    if cleaned.is_empty() {
        PROJECT_NAME.to_owned()
    } else {
        cleaned
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

fn quick_folder_name(project_name: &str, date: &str) -> String {
    format!("{project_name}_{QUICK_SUFFIX}_{date}")
}

/// 快速导出的文件夹:`<集名>_导出_<日期>`,同名追加 `-2`、`-3`(规格 §2)。
fn unique_quick_path(destination: &Path, project_name: &str, date: &str) -> PathBuf {
    let base = quick_folder_name(project_name, date);
    let first = destination.join(&base);
    if !first.exists() {
        return first;
    }
    for suffix in 2_u64.. {
        let candidate = destination.join(format!("{base}-{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn kit_folder_name(project_name: &str, date: &str) -> String {
    format!("{project_name}_{KIT_SUFFIX}_{date}")
}

/// 素材包的文件夹:`<集名>_剪映素材包_<日期>`,同名追加 `-2`、`-3`(与快速导出同一规则)。
fn unique_kit_path(destination: &Path, project_name: &str, date: &str) -> PathBuf {
    let base = kit_folder_name(project_name, date);
    let first = destination.join(&base);
    if !first.exists() {
        return first;
    }
    for suffix in 2_u64.. {
        let candidate = destination.join(format!("{base}-{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// 文件名里的章名:走集名同一套清洗(非法字符、控制符、长度);空的记「未分章」。
fn kit_chapter_name(chapter_title: &str) -> String {
    if chapter_title.trim().is_empty() {
        return KIT_NO_CHAPTER.to_owned();
    }
    let cleaned = package_project_name(chapter_title);
    if cleaned == PROJECT_NAME {
        KIT_NO_CHAPTER.to_owned()
    } else {
        cleaned
    }
}

/// 素材包文件名 `NN_<章名>_<素材名>.mp4`:NN 两位起(超过 99 自然变三位),素材名与快速导出同一套
/// 清洗(`export_file_name` 的 stem 规则)。
fn kit_file_name(sequence: usize, chapter_title: &str, source_name: &str) -> String {
    let stem = export_file_name(0, source_name);
    let stem = stem
        .strip_prefix("000_")
        .and_then(|rest| rest.strip_suffix(".mp4"))
        .unwrap_or("clip");
    format!("{sequence:02}_{}_{stem}.mp4", kit_chapter_name(chapter_title))
}

/// J-04:每个镜按镜头带顺序落在哪个章节目录(1 起);整集没有任何章节标记时全部返回 `None`
/// (「无章节时保持拍平」——不建一个只装「未分章」的空壳子目录)。
fn kit_chapter_ordinals(clips: &[ExportClip]) -> Vec<Option<usize>> {
    if clips.iter().all(|clip| clip.chapter_title.trim().is_empty()) {
        return vec![None; clips.len()];
    }
    let mut seen: Vec<String> = Vec::new();
    clips
        .iter()
        .map(|clip| {
            let key = kit_chapter_name(&clip.chapter_title);
            let position = match seen.iter().position(|existing| existing == &key) {
                Some(position) => position,
                None => {
                    seen.push(key);
                    seen.len() - 1
                }
            };
            Some(position + 1)
        })
        .collect()
}

/// J-04:章节目录名 `NN_<章名>`(NN = 章节在镜头带上第几个出现,两位起)。
fn kit_chapter_directory(ordinal: usize, chapter_title: &str) -> String {
    format!("{ordinal:02}_{}", kit_chapter_name(chapter_title))
}

/// J-04:落盘 / 显示用的相对路径——有章节就是 `NN_章名/<文件名>`,没有章节就是拍平的 `<文件名>`。
fn kit_relative_name(sequence: usize, chapter_ordinal: Option<usize>, chapter_title: &str, source_name: &str) -> String {
    let base = kit_file_name(sequence, chapter_title, source_name);
    match chapter_ordinal {
        Some(ordinal) => format!("{}/{base}", kit_chapter_directory(ordinal, chapter_title)),
        None => base,
    }
}

/// 顺序清单里的时长:`12.4 秒`(新手看得懂的形式,不用 HH:MM:SS.mmm)。
fn kit_duration_label(seconds: f64) -> String {
    format!("{:.1} 秒", seconds.max(0.0))
}

/// 「顺序.txt」:有章节就用 `— NN_章名 —` 标出章节边界(与目录结构一致),每行
/// `NN 章名 素材名 时长`(与文件顺序一致;没导出来的行照写,编号不跳)。
fn kit_order_text(clips: &[ExportClip], items: &[ExportItemStatus]) -> String {
    let ordinals = kit_chapter_ordinals(clips);
    let mut text = String::new();
    let mut last_ordinal: Option<usize> = None;
    for (index, clip) in clips.iter().enumerate() {
        if let Some(ordinal) = ordinals[index] {
            if last_ordinal != Some(ordinal) {
                text.push_str(&format!("— {} —\n", kit_chapter_directory(ordinal, &clip.chapter_title)));
                last_ordinal = Some(ordinal);
            }
        }
        let failed = items.get(index).is_some_and(|item| item.status == "failed");
        text.push_str(&format!(
            "{:02} {} {} {}{}\n",
            index + 1,
            kit_chapter_name(&clip.chapter_title),
            clip.file_name,
            kit_duration_label(clip_duration_seconds(clip)),
            if failed { "(没导出来)" } else { "" }
        ));
    }
    text
}

fn staging_path(final_path: &Path, job_id: i64, attempt: i64) -> PathBuf {
    let name = final_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tripcut-export".to_owned());
    final_path.with_file_name(format!(".{name}.tmp-{job_id}-{attempt}"))
}

/// Z-11:重试时沿用上一次的文件名(同一素材同一段),找不到才按新序号起名。
fn quick_output_name(retry: Option<&RetryContext>, index: usize, clip: &ExportClip) -> String {
    retry
        .and_then(|retry| retry.names.get(&(clip.clip_id, clip.segment_id)).cloned())
        .unwrap_or_else(|| export_file_name(index + 1, &clip.file_name))
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

    #[test]
    fn probe_timeout_scales_with_media_length_and_is_bounded() {
        // 业主 2026-09-14:4K HEVC 10-bit 段固定 30 s 回读必超时。
        assert_eq!(probe_timeout(0.0), Duration::from_secs(60));
        assert_eq!(probe_timeout(30.0), Duration::from_secs(300));
        assert_eq!(probe_timeout(10_000.0), Duration::from_secs(15 * 60));
    }

    #[test]
    fn verification_timeout_keeps_the_file_with_a_warning_but_real_failures_still_fail() {
        let cancel = AtomicBool::new(false);
        let timed_out = Err(CoreError::Export("媒体工具命令超过 60 秒未完成（素材太大或电脑太忙）".to_owned()));
        let note = verify_or_warn(timed_out, &cancel).unwrap();
        assert!(note.unwrap().contains("边界核对超时"));

        let mismatch = Err(CoreError::Export("尾帧内容指纹不一致".to_owned()));
        assert!(verify_or_warn(mismatch, &cancel).is_err(), "核对不过必须仍是失败");

        let cancelled = AtomicBool::new(true);
        let timed_out = Err(CoreError::Export("媒体工具命令超过 60 秒未完成".to_owned()));
        assert!(verify_or_warn(timed_out, &cancelled).is_err(), "取消时不伪装成成功");
    }

    #[test]
    fn command_io_error_names_timeouts_instead_of_blaming_missing_tools() {
        let error = command_io_error(CommandError::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "命令超过 30 秒未完成",
        )));
        let text = format!("{error}");
        assert!(text.contains("超过 30 秒"), "{text}");
        assert!(!text.contains("找不到"), "超时不是找不到工具:{text}");
    }
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
            selected_transcribe_track: None,
            audio_tracks: Vec::new(),
            manual_rotation: None,
        }
    }

    fn export_payload_fixture(clips: Vec<ExportClip>) -> ExportJobPayload {
        ExportJobPayload {
            version: 5,
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
            platform_info: default_platform_info(),
            include_contact_sheet: true,
            contact_sheet_glyph_fallbacks: None,
            contact_sheet_cover_failures: None,
            target_seconds: None,
            mode: MODE_FULL.to_owned(),
            rough_cut_actual_ticks: None,
            rough_cut_actual_tb_num: None,
            rough_cut_actual_tb_den: None,
        retry_into: None,
        }
    }

    fn numbered_step_lines(text: &str) -> Vec<u32> {
        text.lines()
            .filter_map(|line| {
                let mut parts = line.splitn(2, ". ");
                let number = parts.next()?;
                parts.next()?;
                number.parse::<u32>().ok()
            })
            .collect()
    }

    #[test]
    fn build_instructions_numbers_steps_sequentially_with_subtitles_and_destinations() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);
        let text = build_instructions(&payload, 3, 2, NarrationOutcome::WrittenConfirmed, &ContactSheetOutcome::Disabled);
        let numbers = numbered_step_lines(&text);
        let expected = (1..=numbers.len() as u32).collect::<Vec<_>>();
        assert_eq!(numbers, expected, "rendered instructions:\n{text}");
    }

    #[test]
    fn build_instructions_numbers_steps_sequentially_without_subtitles_or_destinations() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);
        let numbers = numbered_step_lines(&text);
        let expected = (1..=numbers.len() as u32).collect::<Vec<_>>();
        assert_eq!(numbers, expected, "rendered instructions:\n{text}");
    }

    #[test]
    fn build_instructions_omits_audio_track_mapping_when_every_clip_is_single_track() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);
        assert!(!text.contains("音轨映射"), "rendered instructions:\n{text}");
    }

    #[test]
    fn build_instructions_states_audio_track_mapping_for_multi_track_clip() {
        let mut clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        clip.selected_transcribe_track = Some(1);
        clip.audio_tracks = vec![
            ExportAudioTrack { stream_index: 0, role_guess: Some("onboard_mic".to_owned()) },
            ExportAudioTrack { stream_index: 1, role_guess: Some("wireless_mic".to_owned()) },
        ];
        let payload = export_payload_fixture(vec![clip]);
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);
        assert!(
            text.contains("音轨映射：clip.mov 0=机内麦/1=无线麦（转录）"),
            "rendered instructions:\n{text}"
        );
        let numbers = numbered_step_lines(&text);
        let expected = (1..=numbers.len() as u32).collect::<Vec<_>>();
        assert_eq!(numbers, expected, "rendered instructions:\n{text}");
    }

    #[test]
    fn build_instructions_audio_track_mapping_lists_at_most_three_clips() {
        let mut clips = Vec::new();
        for index in 0..5 {
            let mut clip =
                export_clip_fixture(&format!("clip-{index}.mov"), 0, 1_000, 1, 1_000);
            clip.audio_tracks = vec![
                ExportAudioTrack { stream_index: 0, role_guess: Some("onboard_mic".to_owned()) },
                ExportAudioTrack { stream_index: 1, role_guess: Some("wireless_mic".to_owned()) },
            ];
            clips.push(clip);
        }
        let payload = export_payload_fixture(clips);
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);
        assert!(text.contains("clip-0.mov"), "rendered instructions:\n{text}");
        assert!(text.contains("clip-2.mov"), "rendered instructions:\n{text}");
        assert!(!text.contains("clip-3.mov"), "rendered instructions:\n{text}");
        assert!(text.contains("等 2 条"), "rendered instructions:\n{text}");
    }

    fn landscape_canvas() -> ExportCanvas {
        ExportCanvas::from(&default_platform_info())
    }

    fn douyin_portrait_platform_info() -> ExportPlatformInfo {
        ExportPlatformInfo {
            platform: "douyin".to_owned(),
            display_name: "抖音".to_owned(),
            orientation: "portrait".to_owned(),
            canvas_width: 1080,
            canvas_height: 1920,
            duration_budget_seconds: 60,
            orientation_source: "episode".to_owned(),
        }
    }

    #[test]
    fn build_instructions_states_douyin_portrait_platform_and_canvas() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = ExportJobPayload {
            platform_info: douyin_portrait_platform_info(),
            ..export_payload_fixture(vec![clip])
        };
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);
        assert!(text.contains("抖音"), "rendered instructions:\n{text}");
        assert!(text.contains("1080×1920"), "rendered instructions:\n{text}");
        assert!(text.contains("竖版"), "rendered instructions:\n{text}");
        assert!(text.contains("≤ 60 s"), "rendered instructions:\n{text}");
    }

    /// R10 R-03:参考粗剪要按解析出的画布缩放/补边,交付说明第 3 条也要写真画布。
    #[test]
    fn rough_cut_args_scale_and_pad_to_portrait_canvas() {
        let clips = [SuccessfulClip {
            clip: export_clip_fixture("clip.mov", 0, 3_000, 1, 1_000),
            path: PathBuf::from("selected.mp4"),
        }];
        let canvas = ExportCanvas::from(&douyin_portrait_platform_info());
        let args = rough_cut_args(&clips, &[true], Path::new("rough.mp4"), &canvas, H264Encoder::VideoToolbox);
        let joined = args
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            joined.contains("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:"),
            "rough cut must use the portrait canvas: {joined}"
        );
        assert!(!joined.contains("1920:1080"), "no landscape leftovers: {joined}");
    }

    #[test]
    fn build_instructions_rough_cut_step_states_real_canvas() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = ExportJobPayload {
            platform_info: douyin_portrait_platform_info(),
            ..export_payload_fixture(vec![clip])
        };
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);
        assert!(
            text.contains("1080×1920 H.264/AAC 参考粗剪"),
            "rendered instructions:\n{text}"
        );
        assert!(!text.contains("1080p"), "rendered instructions:\n{text}");
    }

    #[test]
    fn build_instructions_zero_budget_reads_unbounded() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]); // default_platform_info: budget 0
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);
        assert!(text.contains("不限时长"), "rendered instructions:\n{text}");
    }

    #[test]
    fn build_instructions_reports_contact_sheet_failure() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);
        let outcome = ContactSheetOutcome::Failed {
            message: "磁盘空间不足".to_owned(),
        };
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &outcome);
        assert!(
            text.contains("联系表生成失败：磁盘空间不足"),
            "rendered instructions:\n{text}"
        );
    }

    #[test]
    fn build_instructions_reports_contact_sheet_glyph_fallbacks() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);
        let outcome = ContactSheetOutcome::Written { glyph_fallbacks: 3, cover_failures: 0 };
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &outcome);
        assert!(
            text.contains("3 个字符字体不含"),
            "rendered instructions:\n{text}"
        );
    }

    #[test]
    fn build_instructions_reports_contact_sheet_cover_failures() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);
        let outcome = ContactSheetOutcome::Written { glyph_fallbacks: 0, cover_failures: 2 };
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &outcome);
        assert!(
            text.contains("联系表：2 张封面无法解码，已用灰框占位"),
            "rendered instructions:\n{text}"
        );
    }

    #[test]
    fn build_instructions_omits_cover_failures_sentence_when_zero() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);
        let outcome = ContactSheetOutcome::Written { glyph_fallbacks: 0, cover_failures: 0 };
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &outcome);
        assert!(
            !text.contains("封面无法解码"),
            "rendered instructions:\n{text}"
        );
    }

    #[test]
    fn build_instructions_override_platform_states_bilibili_without_touching_episode() {
        // Simulates a payload frozen with an override_platform ("bilibili") applied at
        // start_export time — the episode's own target_platform/canvas_orientation is
        // untouched; only the delivered instructions reflect the override.
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = ExportJobPayload {
            platform_info: ExportPlatformInfo {
                platform: "bilibili".to_owned(),
                display_name: "B站".to_owned(),
                orientation: "landscape".to_owned(),
                canvas_width: 1920,
                canvas_height: 1080,
                duration_budget_seconds: 600,
                orientation_source: "episode".to_owned(),
            },
            ..export_payload_fixture(vec![clip])
        };
        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);
        assert!(text.contains("B站"), "rendered instructions:\n{text}");
    }

    #[test]
    fn shot_list_csv_has_platform_and_canvas_columns() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let item = ExportItemStatus {
            clip_id: clip.clip_id,
            file_name: clip.file_name.clone(),
            output_name: "001_clip.mp4".to_owned(),
            status: "done".to_owned(),
            note: None,
            warning: false,
        };
        let csv = build_shot_list_csv(&[clip], &[item], &douyin_portrait_platform_info());
        assert!(csv.contains("平台,画布"));
        assert!(csv.contains("抖音"));
        assert!(csv.contains("1080x1920"));
    }

    #[test]
    fn shot_list_csv_leaves_transcribe_track_column_empty_without_audio_track_data() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let item = ExportItemStatus {
            clip_id: clip.clip_id,
            file_name: clip.file_name.clone(),
            output_name: "001_clip.mp4".to_owned(),
            status: "done".to_owned(),
            note: None,
            warning: false,
        };
        let csv = build_shot_list_csv(&[clip], &[item], &douyin_portrait_platform_info());
        let data_row = csv.lines().nth(1).unwrap();
        // 平台,画布,转录音轨,备注 → 转录音轨 is the second-to-last column.
        let fields: Vec<&str> = data_row.split(',').collect();
        assert_eq!(fields[fields.len() - 2], "");
    }

    #[test]
    fn shot_list_csv_states_selected_transcribe_track_index() {
        let mut clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        clip.selected_transcribe_track = Some(1);
        clip.audio_tracks = vec![
            ExportAudioTrack { stream_index: 0, role_guess: Some("onboard_mic".to_owned()) },
            ExportAudioTrack { stream_index: 1, role_guess: Some("wireless_mic".to_owned()) },
        ];
        let item = ExportItemStatus {
            clip_id: clip.clip_id,
            file_name: clip.file_name.clone(),
            output_name: "001_clip.mp4".to_owned(),
            status: "done".to_owned(),
            note: None,
            warning: false,
        };
        let csv = build_shot_list_csv(&[clip], &[item], &douyin_portrait_platform_info());
        assert!(csv.contains("转录音轨"));
        let data_row = csv.lines().nth(1).unwrap();
        let fields: Vec<&str> = data_row.split(',').collect();
        assert_eq!(fields[fields.len() - 2], "1");
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

    /// 8 s 25p,2 s GOP,B 帧(libx264 缺省 bf=3),带 48 kHz AAC(封装偏移的来源)。
    fn generate_b_frame_fixture(ffmpeg: &OsStr, path: &Path) -> bool {
        Command::new(ffmpeg)
            .args([
                "-y", "-v", "error",
                "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=8",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
                "-shortest",
                "-c:v", "libx264", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-bf", "3",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
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
        let first = directory.path().join("旅剪项目_交付_2026-08-31");
        let second = directory.path().join("旅剪项目_交付_2026-08-31_2");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();

        assert_eq!(
            unique_package_path(directory.path(), "旅剪项目", "2026-08-31"),
            directory.path().join("旅剪项目_交付_2026-08-31_3")
        );
    }

    /// R10 U-20:交付包文件夹叫 `<集名>_交付_<日期>`,集名按文件系统清洗,空则回落「旅剪项目」。
    #[test]
    fn package_folder_is_named_after_the_episode_title() {
        assert_eq!(package_project_name("北海道冬日"), "北海道冬日");
        assert_eq!(package_project_name("  Day 1 / 出发: 机场?  "), "Day 1  出发 机场");
        assert_eq!(package_project_name(""), "旅剪项目");
        assert_eq!(package_project_name(" ../ "), "旅剪项目");
        assert_eq!(package_project_name("a\u{0}b<>|"), "ab");
        let long = "长".repeat(80);
        assert_eq!(package_project_name(&long).chars().count(), PACKAGE_TITLE_MAX_CHARS);
        assert_eq!(
            unique_package_path(Path::new("/tmp"), &package_project_name("北海道冬日"), "2026-09-13"),
            PathBuf::from("/tmp/北海道冬日_交付_2026-09-13")
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

        let csv = build_shot_list_csv(&[clip], &[item], &default_platform_info());
        assert!(csv.as_bytes().starts_with(&[0xef, 0xbb, 0xbf]));
        assert!(csv.contains("\"A,\"\"B\"\".mov\""));
        assert!(csv.contains("\"bad, \"\"packet\"\"\""));
        assert!(csv.contains(",是,"));
        assert!(csv.contains("L1角标摘要,对白摘要,平台,画布,转录音轨,备注"));
        assert!(csv.contains("包内路径,入点,出点,段时长"));
        assert!(csv.contains("01_精选原片/001_A.mp4"));
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
    fn confirmed_narrative_revision_writes_narration_script_with_chapters_and_beat_rationale() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        super::super::settings::set_setting(
            &connection,
            super::super::settings::LLM_ENABLED_KEY,
            "true",
        )
        .unwrap();
        let active: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        connection.execute(
            "INSERT INTO narrative_revisions(episode_id, kind, title, theme, created_at)
             VALUES (?1, 'confirmed', '旅程', '测试', 'now')",
            [active],
        ).unwrap();
        let revision_id = connection.last_insert_rowid();

        let clip_a = insert_clip(&connection, Path::new("a.mov"), "2026-09-01T00:00:00Z", &[], None);
        let segment_a = insert_select_segment(&connection, clip_a, 0, 250, 0);
        let clip_b = insert_clip(&connection, Path::new("b.mov"), "2026-09-01T01:00:00Z", &[], None);
        let segment_b = insert_select_segment(&connection, clip_b, 100, 400, 0);
        let clip_c = insert_clip(&connection, Path::new("c.mov"), "2026-09-01T02:00:00Z", &[], None);
        let segment_c = insert_select_segment(&connection, clip_c, 0, 2_000, 0);

        connection.execute(
            "INSERT INTO narrative_chapters(
                episode_id, revision_id, kind, title, \"order\", promoted, score, rationale,
                promotion_reason, story_slots_json, missing_slots_json, dh_plan_json
             ) VALUES (?1, ?2, 'journey', '启程日', 0, 0, 0.8, '开篇', '', '[]', '[]', 'null')",
            params![active, revision_id],
        ).unwrap();
        let chapter_1 = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO narrative_chapters(
                episode_id, revision_id, kind, title, \"order\", promoted, score, rationale,
                promotion_reason, story_slots_json, missing_slots_json, dh_plan_json
             ) VALUES (?1, ?2, 'destination', '抵达营地', 1, 0, 0.8, '收尾', '', '[]', '[]', 'null')",
            params![active, revision_id],
        ).unwrap();
        let chapter_2 = connection.last_insert_rowid();

        connection.execute(
            "INSERT INTO narrative_beats(chapter_id, clip_id, segment_id, role, \"order\", score, rationale)
             VALUES (?1, ?2, ?3, 'beat', 0, 0.8, '出发前的整备')",
            params![chapter_1, clip_a, segment_a],
        ).unwrap();
        connection.execute(
            "INSERT INTO narrative_beats(chapter_id, clip_id, segment_id, role, \"order\", score, rationale)
             VALUES (?1, ?2, ?3, 'beat', 1, 0.8, '公路上的风景')",
            params![chapter_1, clip_b, segment_b],
        ).unwrap();
        connection.execute(
            "INSERT INTO narrative_beats(chapter_id, clip_id, segment_id, role, \"order\", score, rationale)
             VALUES (?1, ?2, ?3, 'beat', 0, 0.8, '营地夜话')",
            params![chapter_2, clip_c, segment_c],
        ).unwrap();
        // segment_id = NULL(整条素材)且 rationale 为空——不能因此拒绝旁白提示或
        // panic,应回退到素材整条时长并留下 "— " 结尾的空理由行。
        // 需要一条正向 binary 评分,整条素材才会出现在"当前已选"集合里
        // (narrative.rs::selected_item_refs),否则 load_overview_for_episode
        // 会因 current_refs != narrative_refs 判定叙事已过期而返回 None。
        let clip_d = insert_clip(&connection, Path::new("d.mov"), "2026-09-01T03:00:00Z", &[1], None);
        connection.execute(
            "INSERT INTO narrative_beats(chapter_id, clip_id, segment_id, role, \"order\", score, rationale)
             VALUES (?1, ?2, NULL, 'beat', 1, 0.8, '')",
            params![chapter_2, clip_d],
        ).unwrap();

        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::create_dir(staging.join(NARRATION_DIRECTORY)).unwrap();

        assert_eq!(
            write_narration_script(&connection, &staging, active).unwrap(),
            NarrationOutcome::WrittenConfirmed
        );
        let output = std::fs::read_to_string(
            staging.join(NARRATION_DIRECTORY).join("旁白稿.txt"),
        ).unwrap();
        assert!(output.starts_with("# 旁白稿（草稿，按需改写）\n"));
        // 已确认版本不带 AI 建议稿标记。
        assert!(!output.contains(NARRATION_AI_DRAFT_HEADER));
        assert!(output.contains("## 第 1 章 启程日"));
        assert!(output.contains("## 第 2 章 抵达营地"));
        assert!(output.contains("[00:00:00.000–00:00:00.250] a.mov — 出发前的整备"));
        assert!(output.contains("[00:00:00.100–00:00:00.400] b.mov — 公路上的风景"));
        assert!(output.contains("[00:00:00.000–00:00:02.000] c.mov — 营地夜话"));
        // 整条素材(segment_id = NULL)用 [00:00:00.000–素材时长] 与文件名;空理由不 panic,
        // 行以 "— " 结尾。
        assert!(output.contains("[00:00:00.000–00:00:02.000] d.mov — \n"));

        let payload = export_payload_fixture(vec![export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000)]);
        let instructions = build_instructions(
            &payload,
            0,
            0,
            NarrationOutcome::WrittenConfirmed,
            &ContactSheetOutcome::Disabled,
        );
        assert!(instructions.contains("旁白稿"));
        assert!(instructions.contains("旁白稿：已确认"));
        assert!(!instructions.contains("本次无旁白稿"));
    }

    #[test]
    fn suggested_narrative_revision_writes_narration_script_with_ai_draft_marker() {
        // R6 Task 7b:与 07_地点卡/beat order 对齐——AI 建议版(suggested)
        // 未经人工确认也要写旁白稿，但文件头与交付说明都要标注未确认。
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        super::super::settings::set_setting(
            &connection,
            super::super::settings::LLM_ENABLED_KEY,
            "true",
        )
        .unwrap();
        let active: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        connection.execute(
            "INSERT INTO narrative_revisions(episode_id, kind, title, theme, created_at)
             VALUES (?1, 'suggested', '旅程', '测试', 'now')",
            [active],
        ).unwrap();
        let revision_id = connection.last_insert_rowid();

        let clip_a = insert_clip(&connection, Path::new("a.mov"), "2026-09-01T00:00:00Z", &[], None);
        let segment_a = insert_select_segment(&connection, clip_a, 0, 250, 0);

        connection.execute(
            "INSERT INTO narrative_chapters(
                episode_id, revision_id, kind, title, \"order\", promoted, score, rationale,
                promotion_reason, story_slots_json, missing_slots_json, dh_plan_json
             ) VALUES (?1, ?2, 'journey', '启程日', 0, 0, 0.8, '开篇', '', '[]', '[]', 'null')",
            params![active, revision_id],
        ).unwrap();
        let chapter_1 = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO narrative_beats(chapter_id, clip_id, segment_id, role, \"order\", score, rationale)
             VALUES (?1, ?2, ?3, 'beat', 0, 0.8, '出发前的整备')",
            params![chapter_1, clip_a, segment_a],
        ).unwrap();

        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::create_dir(staging.join(NARRATION_DIRECTORY)).unwrap();

        assert_eq!(
            write_narration_script(&connection, &staging, active).unwrap(),
            NarrationOutcome::WrittenSuggested
        );
        let output = std::fs::read_to_string(
            staging.join(NARRATION_DIRECTORY).join("旁白稿.txt"),
        ).unwrap();
        assert!(output.starts_with("# 旁白稿（草稿，按需改写）\n"));
        assert!(output.contains(NARRATION_AI_DRAFT_HEADER));
        assert!(output.contains("## 第 1 章 启程日"));

        let payload = export_payload_fixture(vec![export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000)]);
        let instructions = build_instructions(
            &payload,
            0,
            0,
            NarrationOutcome::WrittenSuggested,
            &ContactSheetOutcome::Disabled,
        );
        assert!(instructions.contains("旁白稿：AI 建议稿（未确认）"));
        assert!(!instructions.contains("本次无旁白稿"));
    }

    #[test]
    fn no_narrative_revision_writes_no_narration_script() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        super::super::settings::set_setting(
            &connection,
            super::super::settings::LLM_ENABLED_KEY,
            "true",
        )
        .unwrap();
        let active: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        // 没有任何叙事修订——现有行为不变:不写旁白稿。

        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::create_dir(staging.join(NARRATION_DIRECTORY)).unwrap();

        assert_eq!(
            write_narration_script(&connection, &staging, active).unwrap(),
            NarrationOutcome::NotWritten
        );
        assert!(!staging.join(NARRATION_DIRECTORY).join("旁白稿.txt").exists());

        let payload = export_payload_fixture(vec![export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000)]);
        let instructions = build_instructions(
            &payload,
            0,
            0,
            NarrationOutcome::NotWritten,
            &ContactSheetOutcome::Disabled,
        );
        assert!(instructions.contains("本次无旁白稿"));
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
  *" -encoders "*) echo " V....D h264_videotoolbox    VideoToolbox H.264 Encoder"; exit 0 ;;
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

    /// R17 exportfix:失败 note 带上是哪份 ffmpeg(版本 + 父目录名/文件名),全路径不进文案。
    #[cfg(unix)]
    #[test]
    fn command_failure_names_the_ffmpeg_build_without_leaking_the_full_path() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let macos = directory.path().join("MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let fake_ffmpeg = macos.join("ffmpeg");
        std::fs::write(
            &fake_ffmpeg,
            r#"#!/bin/sh
case " $* " in
  *" -version "*) echo "ffmpeg version 7.1.5 Copyright (c) 2000-2026 the FFmpeg developers"; exit 0 ;;
  *" -encoders "*) exit 0 ;;
  *) echo "Unrecognized option 'allow_sw'. Error splitting the argument list: Option not found" >&2; exit 8 ;;
esac
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake_ffmpeg).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_ffmpeg, permissions).unwrap();
        let clip = export_clip_fixture("dji.mp4", 0, 3_000, 1, 1_000);

        let error = run_media_command(
            fake_ffmpeg.as_os_str(),
            &select_segment_ffmpeg_args(&clip, Path::new("out.mp4"), H264Encoder::VideoToolbox).unwrap(),
            EXPORT_TIMEOUT,
            &AtomicBool::new(false),
            "精选段帧精确转码",
        )
        .unwrap_err();

        let note = failure_note(&error);
        assert!(
            note.starts_with("精选段帧精确转码失败（退出码 8，ffmpeg 7.1.5 (…/MacOS/ffmpeg)）：Unrecognized option 'allow_sw'"),
            "{note}"
        );
        assert!(!note.contains(&directory.path().to_string_lossy().into_owned()), "{note}");
    }

    #[test]
    fn delivery_transcodes_match_the_bundled_videotoolbox_quality_contract() {
        // Z-02:高码率源(3 s × 40 Mbps)仍顶到原来的 16M / 12M 档位。
        let mut clip = export_clip_fixture("source.mov", 0, 3_000, 1, 1_000);
        clip.byte_size = 15_000_000;
        let whole = whole_vfr_args(&clip, Path::new("whole.mp4"), H264Encoder::VideoToolbox);
        let successful = [SuccessfulClip {
            clip,
            path: PathBuf::from("selected.mp4"),
        }];
        let rough = rough_cut_args(&successful, &[true], Path::new("rough.mp4"), &landscape_canvas(), H264Encoder::VideoToolbox);
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
        assert!(whole.contains("h264_videotoolbox -allow_sw 1 -b:v 16000k"), "{whole}");
        assert!(rough.contains("h264_videotoolbox -allow_sw 1 -b:v 12000k"), "{rough}");
        assert!(!whole.contains("libx264"));
        assert!(!rough.contains("libx264"));
    }

    /// R17 exportfix:三处 H.264 参数按 ffmpeg 编码器能力选 —— VT 可用照旧;没 VT 有 libx264
    /// 走 crf(绝不带 `-allow_sw`,那份 ffmpeg 不认这个选项名);都没有走 mpeg4 并带 warning note。
    #[test]
    fn h264_args_follow_encoder_caps_for_segment_whole_and_rough_cut() {
        let clip = export_clip_fixture("source.mov", 0, 3_000, 1, 1_000);
        let successful = [SuccessfulClip { clip: clip.clone(), path: PathBuf::from("selected.mp4") }];
        let all_three = |encoder: H264Encoder| -> Vec<String> {
            [
                select_segment_ffmpeg_args(&clip, Path::new("segment.mp4"), encoder).unwrap(),
                whole_vfr_args(&clip, Path::new("whole.mp4"), encoder),
                rough_cut_args(&successful, &[true], Path::new("rough.mp4"), &landscape_canvas(), encoder),
            ]
            .iter()
            .map(|args| args.iter().map(|v| v.to_string_lossy()).collect::<Vec<_>>().join(" "))
            .collect()
        };
        for args in all_three(H264Encoder::VideoToolbox) {
            assert!(args.contains("-c:v h264_videotoolbox -allow_sw 1 -b:v "), "{args}");
        }
        for args in all_three(H264Encoder::X264) {
            assert!(args.contains("-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p"), "{args}");
            assert!(!args.contains("allow_sw") && !args.contains("-b:v"), "{args}");
        }
        for args in all_three(H264Encoder::Mpeg4Fallback) {
            assert!(args.contains("-c:v mpeg4 -q:v 2 -pix_fmt yuv420p"), "{args}");
            assert!(!args.contains("allow_sw") && !args.contains("videotoolbox"), "{args}");
        }
        assert_eq!(H264Encoder::Mpeg4Fallback.fallback_note().as_deref(), Some(media_tools::SOFTWARE_FALLBACK_NOTE));
    }

    /// 没有任何 VT 编码器的 ffmpeg(业主另一台 Mac 的情形):精选段转码不能再发 `-allow_sw`,
    /// 走 mpeg4 兜底并把 warning 写进 note。
    #[cfg(unix)]
    #[test]
    fn segment_transcode_without_videotoolbox_uses_fallback_and_notes_it() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let fake_ffmpeg = directory.path().join("no-vt-ffmpeg");
        std::fs::write(
            &fake_ffmpeg,
            r#"#!/bin/sh
case " $* " in
  *" -encoders "*) echo " V.S... mpeg4    MPEG-4 part 2"; exit 0 ;;
  *" -allow_sw "*) echo "Unrecognized option 'allow_sw'." >&2; exit 8 ;;
  *" mpeg4 "*) for a in "$@"; do out="$a"; done; printf 'x' > "$out"; exit 0 ;;
  *) exit 7 ;;
esac
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake_ffmpeg).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_ffmpeg, permissions).unwrap();
        let output = directory.path().join("segment.tmp");
        let clip = export_clip_fixture("dji.mp4", 0, 3_000, 1, 1_000);

        let note = transcode_select_segment(fake_ffmpeg.as_os_str(), &clip, &output, &AtomicBool::new(false)).unwrap();

        assert_eq!(note.as_deref(), Some("当前 ffmpeg 不支持硬件 H.264,已用兼容编码"));
        assert!(output.is_file());
    }

    /// Z-02(R13 压测):396×720 / 1.6 Mbps 的源导成了 10.9 Mbps(7× 源)。目标码率按源 × 1.5,
    /// 下限 2 Mbps、上限原档位;源码率未知(时长 0)时退回上限。
    #[test]
    fn export_bitrate_follows_the_source_instead_of_a_fixed_16m() {
        // 8 s × 1.6 Mbps = 1.6 MB → 2.4 Mbps
        let mut low = export_clip_fixture("low.mp4", 0, 8_000, 1, 1_000);
        low.byte_size = 1_600_000;
        assert_eq!(export_video_bitrate(&[&low], SEGMENT_BITRATE_CEILING_BPS), "2400k");
        let segment = select_segment_ffmpeg_args(&low, Path::new("low-out.mp4"), H264Encoder::VideoToolbox).unwrap();
        let segment = segment.iter().map(|v| v.to_string_lossy()).collect::<Vec<_>>().join(" ");
        assert!(segment.contains("-b:v 2400k"), "{segment}");
        assert!(!segment.contains("16M"), "{segment}");

        // 8 s × 0.5 Mbps → 下限 2 Mbps
        let mut tiny = export_clip_fixture("tiny.mp4", 0, 8_000, 1, 1_000);
        tiny.byte_size = 500_000;
        assert_eq!(export_video_bitrate(&[&tiny], SEGMENT_BITRATE_CEILING_BPS), "2000k");

        // 粗剪取所有源里最高的那个,再受 12M 上限
        let mut mid = export_clip_fixture("mid.mp4", 0, 8_000, 1, 1_000);
        mid.byte_size = 6_000_000; // 6 Mbps → 9 Mbps
        assert_eq!(export_video_bitrate(&[&low, &mid], ROUGH_CUT_BITRATE_CEILING_BPS), "9000k");
        let mut big = export_clip_fixture("big.mp4", 0, 8_000, 1, 1_000);
        big.byte_size = 40_000_000; // 40 Mbps → 顶到 12M
        assert_eq!(export_video_bitrate(&[&low, &big], ROUGH_CUT_BITRATE_CEILING_BPS), "12000k");

        // 时长未知:退回上限
        let unknown = export_clip_fixture("unknown.mp4", 0, 0, 1, 1_000);
        assert_eq!(export_video_bitrate(&[&unknown], SEGMENT_BITRATE_CEILING_BPS), "16000k");
    }

    fn successful_clip_fixture(name: &str, duration_seconds: i64) -> SuccessfulClip {
        SuccessfulClip {
            clip: export_clip_fixture(name, 0, duration_seconds * 1_000, 1, 1_000),
            path: PathBuf::from(format!("{name}.mp4")),
        }
    }

    /// R6 Task 7b:`clips.manual_rotation`（rotate 标签兜底命中）必须在粗剪转码
    /// 的 vf 链里，插在 scale 之前——不然缩放会按未转正的宽高比走，横竖颠倒。
    #[test]
    fn rough_cut_args_inserts_transpose_before_scale_for_manual_rotation_90() {
        let mut rotated = successful_clip_fixture("rotated90.mp4", 4);
        rotated.clip.manual_rotation = Some(90);
        let clips = [rotated];

        let args = rough_cut_args(&clips, &[true], Path::new("rough.mp4"), &landscape_canvas(), H264Encoder::VideoToolbox);
        let joined = args
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            joined.contains("[0:v:0]transpose=1,scale=1920:1080"),
            "90° 应在 scale 前插入 transpose=1,：{joined}"
        );
    }

    #[test]
    fn rough_cut_args_inserts_hflip_vflip_before_scale_for_manual_rotation_180() {
        let mut rotated = successful_clip_fixture("rotated180.mp4", 4);
        rotated.clip.manual_rotation = Some(180);
        let clips = [rotated];

        let args = rough_cut_args(&clips, &[true], Path::new("rough.mp4"), &landscape_canvas(), H264Encoder::VideoToolbox);
        let joined = args
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            joined.contains("[0:v:0]hflip,vflip,scale=1920:1080"),
            "180° 应在 scale 前插入 hflip,vflip,：{joined}"
        );
    }

    #[test]
    fn rough_cut_args_inserts_transpose_2_before_scale_for_manual_rotation_270() {
        let mut rotated = successful_clip_fixture("rotated270.mp4", 4);
        rotated.clip.manual_rotation = Some(270);
        let clips = [rotated];

        let args = rough_cut_args(&clips, &[true], Path::new("rough.mp4"), &landscape_canvas(), H264Encoder::VideoToolbox);
        let joined = args
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            joined.contains("[0:v:0]transpose=2,scale=1920:1080"),
            "270° 应在 scale 前插入 transpose=2,：{joined}"
        );
    }

    /// side_data 显示矩阵旋转的素材 `manual_rotation` 必须是 NULL（见
    /// `import.rs` 对该列的注释）——不能在这条路径上多转一次。这是回归 pin：
    /// 确认没有 manual_rotation 时不插入任何 transpose/flip 前缀。
    #[test]
    fn rough_cut_args_pins_no_transpose_for_side_data_rotated_clip() {
        let clip = successful_clip_fixture("side-data-rotated.mp4", 4);
        assert_eq!(clip.clip.manual_rotation, None);
        let clips = [clip];

        let args = rough_cut_args(&clips, &[true], Path::new("rough.mp4"), &landscape_canvas(), H264Encoder::VideoToolbox);
        let joined = args
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            joined.contains("[0:v:0]scale=1920:1080"),
            "无 manual_rotation 时应直接 scale，无 transpose/flip 前缀：{joined}"
        );
        assert!(!joined.contains("transpose"));
        assert!(!joined.contains("hflip"));
        assert!(!joined.contains("vflip"));
    }

    /// R6 Task 6 G9：5 条 20 秒素材、目标 60 秒——cap = max(2, 60/5) = 12 秒，
    /// 每条都按 12 秒截取，累计正好落在 [55, 60] 秒区间，且每条都不低于 1 秒。
    #[test]
    fn select_rough_cut_caps_each_clip_and_lands_within_the_target_window() {
        let clips: Vec<SuccessfulClip> = (0..5)
            .map(|index| successful_clip_fixture(&format!("clip{index}.mov"), 20))
            .collect();

        let (selected, summary) = select_rough_cut(&clips, Some(60)).unwrap();

        assert_eq!(selected.len(), 5, "60 秒预算下 5 条素材应该全部入选");
        let total_seconds = summary.actual_ticks as f64 / 1_000.0;
        assert!(
            (55.0..=60.0).contains(&total_seconds),
            "总时长应落在 [55, 60] 秒：实际 {total_seconds}"
        );
        for clip in &selected {
            let (in_ticks, out_ticks, tb_num, tb_den) = native_ticks(&clip.clip).unwrap();
            let seconds = (out_ticks - in_ticks) as f64 * tb_num as f64 / tb_den as f64;
            assert!(seconds >= 1.0, "每条素材裁切后不应低于 1 秒：{seconds}");
        }
    }

    /// 目标 30 秒、2 条 5 秒素材：cap = max(2, 30/2) = 15 秒 > 素材原长，
    /// 两条都应该保留全长（5 秒），不报错、也不会被截短。
    #[test]
    fn select_rough_cut_keeps_short_clips_whole_when_target_exceeds_total_length() {
        let clips = vec![
            successful_clip_fixture("a.mov", 5),
            successful_clip_fixture("b.mov", 5),
        ];

        let (selected, summary) = select_rough_cut(&clips, Some(30)).unwrap();

        assert_eq!(selected.len(), 2);
        for clip in &selected {
            let (in_ticks, out_ticks, _, _) = native_ticks(&clip.clip).unwrap();
            assert_eq!(out_ticks - in_ticks, 5_000, "两条素材都应该保留原长 5 秒");
        }
        assert_eq!(summary.actual_ticks, 10_000);
    }

    /// 3 条素材 5s/5s/50s、目标 30 秒：第一轮每条 cap=max(2,10)=10s，
    /// 累计 5+5+10=20s，仍差 10s 预算。第二轮按原长从长到短延展——50s 的
    /// 那条不能被直接撑到全长（那会把总时长顶到 60s），只能吃掉剩下的
    /// 10s 预算，延展到约 20s，总时长落回 [29,30] 秒。
    #[test]
    fn select_rough_cut_second_pass_extends_only_by_remaining_budget_not_to_full_length() {
        let clips = vec![
            successful_clip_fixture("a.mov", 5),
            successful_clip_fixture("b.mov", 5),
            successful_clip_fixture("c.mov", 50),
        ];

        let (selected, summary) = select_rough_cut(&clips, Some(30)).unwrap();

        let total_seconds = summary.actual_ticks as f64 / 1_000.0;
        assert!(
            (29.0..=30.0).contains(&total_seconds),
            "第二轮延展后总时长应落在 [29, 30] 秒，不能被撑到 60 秒：实际 {total_seconds}"
        );
        let fifty_second_clip = selected
            .iter()
            .find(|clip| clip.clip.rel_path == "c.mov")
            .expect("50 秒那条素材应该入选");
        let (in_ticks, out_ticks, _, _) = native_ticks(&fifty_second_clip.clip).unwrap();
        let trimmed_seconds = (out_ticks - in_ticks) as f64 / 1_000.0;
        assert!(
            (19.0..=21.0).contains(&trimmed_seconds),
            "50 秒素材应该只被延展到约 20 秒，而不是全长 50 秒：实际 {trimmed_seconds}"
        );
    }

    #[test]
    fn select_rough_cut_rejects_targets_outside_the_allowed_set() {
        let clips = vec![successful_clip_fixture("a.mov", 20)];
        let error = select_rough_cut(&clips, Some(45)).unwrap_err();
        assert!(error.to_string().contains("30/60/180"), "{error}");
    }

    #[test]
    fn start_export_rejects_invalid_rough_cut_target() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"placeholder").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(&connection, &source, "2026-08-31T11:00:00Z", &[1], None);
        let error =
            start_export(&mut connection, directory.path(), None, true, Some(45)).unwrap_err();
        assert!(error.to_string().contains("30/60/180"), "{error}");
    }

    #[test]
    fn build_instructions_reports_rough_cut_target_and_actual_duration() {
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let mut payload = export_payload_fixture(vec![clip]);
        payload.target_seconds = Some(60);
        payload.rough_cut_actual_ticks = Some(58_400);
        payload.rough_cut_actual_tb_num = Some(1);
        payload.rough_cut_actual_tb_den = Some(1_000);

        let text = build_instructions(&payload, 0, 0, NarrationOutcome::NotWritten, &ContactSheetOutcome::Disabled);

        assert!(
            text.contains("参考粗剪：目标 60 秒，实际 58.4 秒"),
            "交付说明应记录目标与实际粗剪时长：{text}"
        );
    }

    /// 显示 LUT 是播放器预览专用的 `vf` 滤镜(见 `player::mpv_calls_for`),
    /// 绝不应该烧进任何交付产物——整片转码、精选段帧精确转码、粗剪拼接三条
    /// 路径都要钉住。烧录后不可逆,业主拿到的成片必须是未套 LUT 的原始分级。
    #[test]
    fn deliver_export_paths_never_carry_the_preview_display_lut() {
        let whole_clip = export_clip_fixture("source.mov", 0, 3_000, 1, 1_000);
        let whole = whole_vfr_args(&whole_clip, Path::new("whole.mp4"), H264Encoder::VideoToolbox);
        let whole_joined = whole
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!whole_joined.contains("lut3d"), "整片转码不应包含 lut3d：{whole_joined}");
        assert!(!whole_joined.contains("tripcut-lut"));

        let select_clip = export_clip_fixture("select.mov", 0, 3_000, 1, 1_000);
        let select_args = select_segment_ffmpeg_args(&select_clip, Path::new("select.mp4"), H264Encoder::VideoToolbox).unwrap();
        let select_joined = select_args
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!select_joined.contains("lut3d"), "精选段转码不应包含 lut3d：{select_joined}");
        assert!(!select_joined.contains("tripcut-lut"));

        let rough_clips = [SuccessfulClip {
            clip: export_clip_fixture("rough.mov", 0, 3_000, 1, 1_000),
            path: PathBuf::from("selected.mp4"),
        }];
        let rough = rough_cut_args(&rough_clips, &[true], Path::new("rough.mp4"), &landscape_canvas(), H264Encoder::VideoToolbox);
        let rough_joined = rough
            .iter()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!rough_joined.contains("lut3d"), "粗剪拼接不应包含 lut3d：{rough_joined}");
        assert!(!rough_joined.contains("tripcut-lut"));
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

    /// J-05:素材包的 SRT 跟视频同名同目录——章节子目录也要跟上,不是像完整交付包
    /// 那样收进单独的字幕文件夹。
    #[test]
    fn kit_subtitles_copied_beside_the_clip_including_chapter_subdirectory() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let connection = Connection::open(&db_path).unwrap();
        let cache_source = directory.path().join("cache/1/transcript.srt");
        std::fs::create_dir_all(cache_source.parent().unwrap()).unwrap();
        std::fs::write(&cache_source, "1\n00:00:00,000 --> 00:00:01,000\n大家好\n").unwrap();
        let staging = directory.path().join("kit.tmp");
        std::fs::create_dir(&staging).unwrap();
        let mut clip = export_clip_fixture("voice.mov", 0, 1_000, 1, 1_000);
        clip.segment_id = None;
        clip.selection_kind = "whole".to_owned();
        clip.srt_rel_path = Some("1/transcript.srt".to_owned());
        let clips = vec![clip];
        let items = vec![ExportItemStatus {
            clip_id: 1,
            file_name: "voice.mov".to_owned(),
            output_name: "01_海边/01_海边_voice.mp4".to_owned(),
            status: "done".to_owned(),
            note: None,
            warning: false,
        }];

        assert_eq!(copy_kit_subtitles(&connection, &clips, &items, &staging).unwrap(), 1);
        let output = staging.join("01_海边/01_海边_voice.srt");
        assert!(output.is_file(), "SRT 应该跟视频挨着,不是单独收进字幕文件夹");
        assert!(std::fs::read_to_string(output).unwrap().contains("大家好"));
        assert!(!staging.join(SUBTITLE_DIRECTORY).exists());
    }

    /// J-05:本集选了配乐 → 原文件抄一份到素材包根目录(不进任何章节子目录);
    /// 没有配乐就静默跳过,不报错。
    #[test]
    fn kit_music_copied_to_kit_root_when_episode_has_selected_track() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let episode_id: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
            .unwrap();
        let staging = directory.path().join("kit.tmp");
        std::fs::create_dir(&staging).unwrap();

        // 没有配乐:静默跳过。
        copy_kit_music(&connection, episode_id, &staging).unwrap();
        assert!(std::fs::read_dir(&staging).unwrap().next().is_none());

        let track = directory.path().join("bgm.mp3");
        std::fs::write(&track, b"bgm-bytes").unwrap();
        connection
            .execute(
                "INSERT INTO music_tracks(episode_id, file_name, rel_path, duration_ticks, analysis_status, created_at)
                 VALUES (?1, 'bgm.mp3', ?2, 4_000_000, 'done', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![episode_id, track.to_string_lossy()],
            )
            .unwrap();

        copy_kit_music(&connection, episode_id, &staging).unwrap();
        let copied = staging.join("bgm.mp3");
        assert!(copied.is_file());
        assert_eq!(std::fs::read(copied).unwrap(), b"bgm-bytes");
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
        let status = start_export(&mut connection, directory.path(), None, true, None).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();

        let finished = get_export_status(&connection, status.job_id).unwrap();
        assert_eq!(finished.status, "done");
        assert_eq!(finished.completed_items, 1);
        assert_eq!(finished.failed_items, 1);
        let output = PathBuf::from(finished.output_path.unwrap());
        // R10 U-20:文件夹名带当前集标题(db::open_project 的默认集叫「EP01」)。
        let folder = output.file_name().unwrap().to_string_lossy().into_owned();
        assert!(folder.starts_with("EP01_交付_20"), "{folder}");
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
    fn export_with_contact_sheet_enabled_writes_pdf_with_cjk_file_name() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("旅拍010.mov");
        if !generate_fixture(&ffmpeg, &source) {
            eprintln!("skipping contact sheet export fixture: encoder unavailable");
            return;
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(&connection, &source, "2026-08-31T10:00:00Z", &[1], None);

        let status = start_export(&mut connection, directory.path(), None, true, None).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();

        let finished = get_export_status(&connection, status.job_id).unwrap();
        assert_eq!(finished.status, "done");
        let output = PathBuf::from(finished.output_path.unwrap());
        let pdf_path = output.join(CONTACT_SHEET_FILE);
        assert!(pdf_path.is_file(), "联系表 PDF 应存在：{}", pdf_path.display());

        let text = contact_sheet::tests::extract_visible_text(&pdf_path);
        assert!(
            text.contains("旅拍010.mov"),
            "联系表文本流应含文件名「旅拍010.mov」: {text:?}"
        );

        let instructions =
            std::fs::read_to_string(output.join(README_FILE)).unwrap();
        assert!(instructions.contains("联系表 PDF"), "交付说明应提及联系表 PDF");
    }

    #[test]
    fn export_with_corrupted_cover_counts_cover_failure_in_status_and_readme() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("旅拍010.mov");
        if !generate_fixture(&ffmpeg, &source) {
            eprintln!("skipping corrupted cover export fixture: encoder unavailable");
            return;
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let clip_id = insert_clip(&connection, &source, "2026-08-31T10:00:00Z", &[1], None);
        let quick_hash: String = connection
            .query_row("SELECT quick_hash FROM clips WHERE id = ?1", [clip_id], |row| row.get(0))
            .unwrap();

        // 注册一份损坏的封面 artifact:合法 JPEG SOI 后接垃圾字节,解码必然
        // 失败——联系表应退化成灰框占位,而不是让整个导出失败。
        let cache_root = crate::core::artifacts::cache_root_for_db(&directory.db_path());
        let cover_relative = crate::core::artifacts::artifact_relative_path(
            clip_id,
            crate::core::artifacts::COVER_FILE,
        );
        let cover_path = cache_root.join(&cover_relative);
        std::fs::create_dir_all(cover_path.parent().unwrap()).unwrap();
        let mut garbage = vec![0xFFu8, 0xD8];
        garbage.extend(std::iter::repeat_n(0x5Au8, 198));
        std::fs::write(&cover_path, &garbage).unwrap();
        connection
            .execute(
                "INSERT INTO cache_artifacts(clip_id, kind, rel_path, source_hash, bytes, created_at)
                 VALUES (?1, 'cover', ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![
                    clip_id,
                    cover_relative.to_string_lossy().replace('\\', "/"),
                    quick_hash,
                    garbage.len() as i64,
                ],
            )
            .unwrap();

        let status = start_export(&mut connection, directory.path(), None, true, None).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();

        let finished = get_export_status(&connection, status.job_id).unwrap();
        assert_eq!(finished.status, "done");
        assert_eq!(
            finished.contact_sheet_cover_failures,
            Some(1),
            "唯一一张损坏封面应计入 contact_sheet_cover_failures = 1"
        );

        let output = PathBuf::from(finished.output_path.unwrap());
        let instructions = std::fs::read_to_string(output.join(README_FILE)).unwrap();
        assert!(
            instructions.contains("联系表：1 张封面无法解码，已用灰框占位"),
            "交付说明应提及损坏封面计数: {instructions:?}"
        );
    }

    #[test]
    fn export_with_contact_sheet_disabled_omits_pdf_and_readme_mention() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("旅拍010.mov");
        if !generate_fixture(&ffmpeg, &source) {
            eprintln!("skipping contact sheet export fixture: encoder unavailable");
            return;
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(&connection, &source, "2026-08-31T10:00:00Z", &[1], None);

        let status = start_export(&mut connection, directory.path(), None, false, None).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();

        let finished = get_export_status(&connection, status.job_id).unwrap();
        assert_eq!(finished.status, "done");
        let output = PathBuf::from(finished.output_path.unwrap());
        assert!(
            !output.join(CONTACT_SHEET_FILE).exists(),
            "关闭联系表时不应写入 PDF"
        );

        let instructions =
            std::fs::read_to_string(output.join(README_FILE)).unwrap();
        assert!(!instructions.contains("联系表"), "关闭联系表时交付说明不应提及联系表");
    }

    /// 复审 Task 3 第 1 点:`render_contact_sheet` 成功之后,`write_synced`
    /// 落到最终路径这一步失败——用"最终路径本身就是一个目录"来制造这个
    /// 失败,不依赖真实 ffmpeg。`TempFileGuard` 应该在 `write_contact_sheet`
    /// 返回 Err 的同时,把 `联系表.pdf.rendering` 这份临时文件清理掉。
    #[test]
    fn write_contact_sheet_cleans_up_temp_file_when_final_write_fails() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at) VALUES ('旅程', '主题', 'now')",
                [],
            )
            .unwrap();
        let episode_id = connection.last_insert_rowid();

        let staging = directory.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        std::fs::create_dir(staging.join(SHOT_LIST_DIRECTORY)).unwrap();
        // 让联系表的最终路径本身就是一个目录,`write_synced` 里的
        // `File::create` 必然报错。
        std::fs::create_dir(staging.join(CONTACT_SHEET_FILE)).unwrap();

        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let payload = export_payload_fixture(vec![clip]);

        let result = write_contact_sheet(&connection, &staging, episode_id, &payload);
        assert!(result.is_err(), "final_path 是目录时 write_contact_sheet 应报错");

        let temporary_path = staging
            .join(CONTACT_SHEET_FILE)
            .with_extension("pdf.rendering");
        assert!(
            !temporary_path.exists(),
            "失败后不应残留 .rendering 临时文件: {}",
            temporary_path.display()
        );
    }

    /// 复审 Task 3 第 3 点:联系表这一步真的失败时(不是靠字符串伪造,而是
    /// 真的让 `write_synced` 摔在目录冲突上),交付包其余部分——包括
    /// `.tripcut-complete.json` 完成标记——必须照常写出。`05_镜头表`
    /// 目录在流水线一开始(remux/转码之前)就已创建,给了一个足够宽裕的
    /// 窗口:后台线程一看到这个目录出现,立刻把「联系表.pdf」这个文件名
    /// 抢占成一个目录,当真正的渲染流程走到 `write_synced` 时必然撞见
    /// "Is a directory"。
    #[test]
    fn export_survives_contact_sheet_failure_and_still_writes_completion_marker() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("旅拍010.mov");
        if !generate_fixture(&ffmpeg, &source) {
            eprintln!("skipping contact sheet failure fixture: encoder unavailable");
            return;
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(&connection, &source, "2026-08-31T10:00:00Z", &[1], None);

        let status = start_export(&mut connection, directory.path(), None, true, None).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        let queued_payload = parse_payload(&job.payload).unwrap();
        let final_path = unique_package_path(
            Path::new(&queued_payload.destination),
            &queued_payload.project_name,
            &queued_payload.date,
        );
        let staging = staging_path(&final_path, job.id, job.attempt);
        let shot_list_dir = staging.join(SHOT_LIST_DIRECTORY);
        let hijacked_pdf_path = staging.join(CONTACT_SHEET_FILE);

        let watcher = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            while Instant::now() < deadline {
                if shot_list_dir.is_dir() {
                    let _ = std::fs::create_dir(&hijacked_pdf_path);
                    return;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        });

        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();
        watcher.join().unwrap();

        let finished = get_export_status(&connection, status.job_id).unwrap();
        assert_eq!(finished.status, "done");
        let output = PathBuf::from(finished.output_path.unwrap());
        assert!(
            output.join(COMPLETION_MARKER_FILE).is_file(),
            "联系表失败不应阻止完成标记落盘"
        );
        assert!(
            output.join(CONTACT_SHEET_FILE).is_dir(),
            "本用例故意抢占了这个文件名,证明失败确实发生在这一步"
        );
        assert!(
            !output
                .join(CONTACT_SHEET_FILE)
                .with_extension("pdf.rendering")
                .exists(),
            "失败后不应残留联系表的 .rendering 临时文件"
        );

        let instructions = std::fs::read_to_string(output.join(README_FILE)).unwrap();
        assert!(
            instructions.contains("联系表生成失败："),
            "交付说明应记录联系表失败原因：{instructions}"
        );
    }

    #[test]
    fn legacy_export_payload_without_contact_sheet_fields_defaults_to_enabled() {
        // 模拟 R4 Task 3 之前排队/未完成的旧交付任务:没有 include_contact_sheet /
        // contact_sheet_glyph_fallbacks 这两个字段,反序列化必须成功,且按"启用"
        // 回退——不能让升级悄悄关掉一份此前一直会生成的产物。
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let current_payload = export_payload_fixture(vec![clip]);
        let mut json_value: Value = serde_json::to_value(&current_payload).unwrap();

        if let Some(obj) = json_value.as_object_mut() {
            obj.remove("include_contact_sheet");
            obj.remove("contact_sheet_glyph_fallbacks");
        }

        let json_str = serde_json::to_string(&json_value).unwrap();
        let parsed: ExportJobPayload = serde_json::from_str(&json_str)
            .expect("旧负载缺少 include_contact_sheet 字段时应仍能反序列化");

        assert!(parsed.include_contact_sheet);
        assert_eq!(parsed.contact_sheet_glyph_fallbacks, None);
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
        start_export(&mut connection, directory.path(), None, true, None).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        let error = run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe)
            .unwrap_err();
        assert!(error.to_string().contains("所有精选片段"));
        let unexpected = std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .any(|name| name.contains("_交付_") || name.contains(".tmp-"));
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
        let started = start_export(&mut connection, directory.path(), None, true, None).unwrap();
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
    fn start_export_rejects_invalid_override_platform() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"placeholder").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(&connection, &source, "2026-08-31T11:00:00Z", &[1], None);
        let error = start_export(&mut connection, directory.path(), Some("youtube"), true, None).unwrap_err();
        assert!(error.to_string().contains("目标平台"));
    }

    #[test]
    fn start_export_freezes_episode_platform_into_payload() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"placeholder").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        platform::set_episode_platform(
            &mut connection,
            current.id,
            "douyin",
            "portrait",
        )
        .unwrap();
        insert_clip(&connection, &source, "2026-08-31T11:00:00Z", &[1], None);

        let started = start_export(&mut connection, directory.path(), None, true, None).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        let payload = parse_payload(&job.payload).unwrap();
        assert_eq!(payload.platform_info.platform, "douyin");
        assert_eq!(payload.platform_info.orientation, "portrait");
        assert_eq!(payload.platform_info.canvas_width, 1080);
        assert_eq!(payload.platform_info.canvas_height, 1920);
        assert_eq!(payload.platform_info.duration_budget_seconds, 60);
        assert!(started.job_id.is_some());
    }

    /// 走查 U-05:集没选过方向,选小红书交付 → 负载里画布 1080×1920,状态里带 canvas。
    #[test]
    fn xiaohongshu_export_freezes_a_portrait_canvas_and_reports_it() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"placeholder").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(&connection, &source, "2026-08-31T11:00:00Z", &[1], None);

        let idle = get_export_status(&connection, None).unwrap();
        let preview = preview_export_canvas(&connection, Some("xiaohongshu"), None).unwrap();
        assert_eq!((preview.width, preview.height), (1080, 1920));
        assert_eq!(preview.orientation_source, "preset");
        assert!(idle.canvas.is_some(), "idle 态也要能告诉抽屉将要用的画布");

        let started =
            start_export(&mut connection, directory.path(), Some("xiaohongshu"), true, None).unwrap();
        let canvas = started.canvas.expect("任务状态带画布");
        assert_eq!(canvas.platform, "xiaohongshu");
        assert_eq!(canvas.orientation, "portrait");
        assert_eq!((canvas.width, canvas.height), (1080, 1920));
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        let payload = parse_payload(&job.payload).unwrap();
        assert_eq!(payload.platform_info.orientation, "portrait");
        assert_eq!(payload.platform_info.canvas_height, 1920);

        // 抽屉手动切横版 → 本次按横版,集记录不动。
        let forced = start_export_with_canvas(
            &mut connection,
            directory.path(),
            Some("xiaohongshu"),
            Some("landscape"),
            true,
            None,
        );
        // 上一个任务还在排队时会被拒(单任务约束)或成功——两种情况都只看画布解析,
        // 所以这里用 preview 代替再起一个任务。
        drop(forced);
        let preview = preview_export_canvas(&connection, Some("xiaohongshu"), Some("landscape")).unwrap();
        assert_eq!(preview.orientation, "landscape");
        assert_eq!(preview.orientation_source, "override");
        assert_eq!((preview.width, preview.height), (1920, 1080));
        let orientation: String = connection
            .query_row("SELECT canvas_orientation FROM episodes WHERE status = 'active'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(orientation, "both");
    }

    #[test]
    fn start_export_override_leaves_episode_record_untouched() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"placeholder").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        platform::set_episode_platform(
            &mut connection,
            current.id,
            "douyin",
            "portrait",
        )
        .unwrap();
        insert_clip(&connection, &source, "2026-08-31T11:00:00Z", &[1], None);

        start_export(&mut connection, directory.path(), Some("bilibili"), true, None).unwrap();
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        let payload = parse_payload(&job.payload).unwrap();
        assert_eq!(payload.platform_info.platform, "bilibili");
        assert_eq!(payload.platform_info.display_name, "B站");
        // orientation still comes from the episode record ("portrait"), the override
        // only swaps the platform preset — never the episode's own columns.
        assert_eq!(payload.platform_info.orientation, "portrait");

        let (platform, orientation): (String, String) = connection
            .query_row(
                "SELECT target_platform, canvas_orientation FROM episodes WHERE id = ?1",
                [current.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(platform, "douyin");
        assert_eq!(orientation, "portrait");
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

        assert!(error.to_string().contains("起止点和视频帧对不上"), "{error}");
        assert!(!error.to_string().contains("PTS") && !error.to_string().contains("tick"), "文案不出术语:{error}");
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
        assert!(error.to_string().contains("起止点和视频帧对不上"), "{error}");
    }

    /// V-03:mp4 封装把 AAC 编码器延迟(1024 采样 ≈ 23 ms)用 make_zero 整体前推,输出视频
    /// 首帧 pts 不是 0。这是封装偏移不是裁错帧:首帧允许「1 帧 + 封装偏移上限」,段长仍按 1 帧比。
    /// 60 fps(1 帧 = 320 tick @ 1/19200)+ 44.1 kHz(446 tick)此前必炸。
    #[test]
    fn output_bounds_tolerate_muxer_shift_but_not_a_wrong_span() {
        let source = TickBounds { first: 38_400, end: 115_200 };
        let tolerance = 320;
        let allowance = mux_shift_allowance_ticks(1, 19_200);
        assert!(allowance >= 446, "{allowance}");
        // 整体前推 446 tick、段长分毫不差:通过。
        validate_output_pts_bounds(TickBounds { first: 38_846, end: 115_646 }, source, tolerance, allowance).unwrap();
        // 前推之外还多出 2 帧:段长错了,拒。
        let error = validate_output_pts_bounds(TickBounds { first: 38_846, end: 116_286 }, source, tolerance, allowance).unwrap_err();
        assert!(error.to_string().contains("起止点和视频帧对不上"), "{error}");
        // 首帧偏了 0.5 s:不是封装偏移,拒。
        assert!(validate_output_pts_bounds(TickBounds { first: 48_000, end: 124_800 }, source, tolerance, allowance).is_err());
    }

    /// V-03:进度项的 note 直接给用户看,不带 `export failed:` 英文前缀。
    #[test]
    fn failed_item_note_is_plain_words_without_the_error_prefix() {
        let note = failure_note(&CoreError::Export("这段的起止点和视频帧对不上".to_owned()));
        assert_eq!(note, "这段的起止点和视频帧对不上");
        let io = failure_note(&CoreError::Io(std::io::Error::other("disk")));
        assert!(!io.starts_with("export failed:"), "{io}");
    }

    /// V-03 真机根因 1:iPhone / ffmpeg -ss 剪出来的片子首个关键帧 pts 为负(edit list),
    /// ffprobe `-read_intervals 0%…` 会**向前**找到第一个非负关键帧,0.5 s 的入点因此
    /// 「入点差 12000 tick」。根因 2:B 帧重排让区间尾部少解出最后几帧,出点被推断短 1 帧,
    /// 再叠上输出侧 23 ms 的封装偏移就超容差。夹具:libx264 2 s GOP + B 帧 + AAC,
    /// `-ss 1.1 -c copy` 剪出带 edit list 的副本;入点 0.5 s 落在第一个非负关键帧之前。
    #[test]
    fn edit_list_trimmed_b_frame_source_exports_a_segment_starting_before_first_positive_keyframe() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let original = directory.path().join("bframes.mp4");
        if !generate_b_frame_fixture(&ffmpeg, &original) {
            eprintln!("skipping edit-list fixture: libx264 unavailable");
            return;
        }
        let source = directory.path().join("trimmed.mp4");
        let trimmed = Command::new(&ffmpeg)
            .args(["-y", "-v", "error", "-ss", "1.1", "-i"])
            .arg(&original)
            .args(["-c", "copy"])
            .arg(&source)
            .status()
            .is_ok_and(|status| status.success());
        assert!(trimmed, "edit list 副本");
        let meta = crate::core::import::probe_media(&source).unwrap();
        let per_sec = meta.tb_den / meta.tb_num;
        let (win_in, win_out) = (per_sec / 2, per_sec * 4);
        let mut clip = export_clip_fixture("trimmed.mp4", win_in, win_out, meta.tb_num, meta.tb_den);
        clip.source_path = source.to_string_lossy().into_owned();
        clip.fps_num = Some(25);
        clip.fps_den = Some(1);
        let cancel = AtomicBool::new(false);

        let bounds = probe_source_tick_bounds(&ffprobe, &clip, win_in, win_out, &cancel).unwrap();
        let frame_ticks = per_sec / 25;
        assert!(bounds.first.abs_diff(win_in) as i64 <= frame_ticks, "first={} win_in={win_in}", bounds.first);
        assert_eq!(bounds.end, win_out, "B 帧尾部不能少解一帧");

        let output = directory.path().join("segment.mp4");
        transcode_select_segment(&ffmpeg, &clip, &output, &cancel).unwrap();
        verify_segment_pts(&ffmpeg, &ffprobe, &clip, &output, &cancel).unwrap();
    }

    #[test]
    fn keyframe_alignment_is_read_from_ffprobe_key_frames_only() {
        let json = br#"{"frames":[{"key_frame":1,"best_effort_timestamp":0},{"key_frame":1,"best_effort_timestamp":1000},{"key_frame":0,"best_effort_timestamp":1040}]}"#;
        assert!(parse_keyframe_alignment(json, 1000));
        assert!(!parse_keyframe_alignment(json, 1040), "非关键帧不算对齐");
        assert!(!parse_keyframe_alignment(json, 1020));
        assert!(!parse_keyframe_alignment(b"not json", 0));
        assert!(!parse_keyframe_alignment(br#"{"frames":[]}"#, 0));
    }

    #[test]
    fn keyframe_aligned_segment_copy_args_carry_no_encoder() {
        let mut clip = export_clip_fixture("src.mov", 30_000, 90_000, 1, 30_000);
        clip.codec = Some("hevc".to_owned());
        let args = select_segment_copy_args(&clip, Path::new("seg.mp4")).unwrap();
        let args = args.iter().map(|v| v.to_string_lossy()).collect::<Vec<_>>().join(" ");
        assert!(args.starts_with("-hide_banner -loglevel error -nostdin -ss 1.000000000 -i src.mov -t 2.000000000 -map 0:v:0 -map 0:a:0? -c copy -tag:v hvc1"), "{args}");
        assert!(args.contains("-avoid_negative_ts make_zero"), "{args}");
        assert!(!args.contains("-c:v") && !args.contains("videotoolbox") && !args.contains("allow_sw"), "{args}");
        let zero_length = export_clip_fixture("src.mov", 30_000, 30_000, 1, 30_000);
        assert!(select_segment_copy_args(&zero_length, Path::new("seg.mp4")).is_err());
    }

    /// R17 exportfix ④:入点正好在关键帧上的精选段走 `-c copy`(输出仍是源的 mpeg4 流),
    /// 入点不在关键帧上的才转码(输出变成 H.264)。剪映素材包 / 快速导出 / 交付包同一条
    /// export_clip 路。
    #[test]
    fn keyframe_aligned_select_segment_is_remuxed_and_off_keyframe_is_transcoded() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("gop.mp4");
        let generated = Command::new(&ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-shortest", "-c:v", "mpeg4", "-q:v", "3", "-g", "25", "-bf", "0", "-c:a", "aac"])
            .arg(&source)
            .status()
            .is_ok_and(|status| status.success());
        if !generated {
            eprintln!("skipping keyframe remux fixture: encoder unavailable");
            return;
        }
        let meta = crate::core::import::probe_media(&source).unwrap();
        let per_sec = meta.tb_den / meta.tb_num;
        let cancel = AtomicBool::new(false);
        let codec_of = |path: &Path| -> String {
            let out = Command::new(&ffprobe)
                .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"])
                .arg(path)
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };

        // 入点 = 1 s,正好是第 2 个 GOP 的关键帧。
        let mut aligned = export_clip_fixture("gop.mp4", per_sec, per_sec * 3, meta.tb_num, meta.tb_den);
        aligned.source_path = source.to_string_lossy().into_owned();
        aligned.codec = Some("mpeg4".to_owned());
        assert!(keyframe_aligned_in_point(&ffprobe, &aligned, &cancel).unwrap());
        let aligned_out = directory.path().join("aligned.mp4");
        export_clip(&ffmpeg, &ffprobe, &aligned, &aligned_out, &cancel).unwrap();
        assert_eq!(codec_of(&aligned_out), "mpeg4", "关键帧对齐的段应当原样 remux");

        // 入点 = 1.2 s,不在关键帧上 → 转码。
        let mut off = aligned.clone();
        off.in_ticks = Some(per_sec + per_sec / 5);
        assert!(!keyframe_aligned_in_point(&ffprobe, &off, &cancel).unwrap());
        let off_out = directory.path().join("off.mp4");
        export_clip(&ffmpeg, &ffprobe, &off, &off_out, &cancel).unwrap();
        assert_ne!(codec_of(&off_out), "mpeg4", "不对齐的段必须转码");
    }

    /// B 帧源(libx264 bf=3)入点落在关键帧上:remux 要么通过回读校验,要么被拒后转码 ——
    /// 两条路都必须交出通过 verify_segment_pts 的文件,不能因为 remux 被拒就整段失败。
    #[test]
    fn keyframe_aligned_b_frame_segment_still_exports_when_copy_is_rejected() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let source = directory.path().join("bframes.mp4");
        if !generate_b_frame_fixture(&ffmpeg, &source) {
            eprintln!("skipping b-frame keyframe fixture: libx264 unavailable");
            return;
        }
        let meta = crate::core::import::probe_media(&source).unwrap();
        let per_sec = meta.tb_den / meta.tb_num;
        let cancel = AtomicBool::new(false);
        // GOP 50 帧 @25p = 2 s;入点 2 s 是关键帧,出点 3.5 s 落在 GOP 中间。
        let mut clip = export_clip_fixture("bframes.mp4", per_sec * 2, per_sec * 7 / 2, meta.tb_num, meta.tb_den);
        clip.source_path = source.to_string_lossy().into_owned();
        assert!(keyframe_aligned_in_point(&ffprobe, &clip, &cancel).unwrap());
        let output = directory.path().join("segment.mp4");
        export_clip(&ffmpeg, &ffprobe, &clip, &output, &cancel).unwrap();
        verify_segment_pts(&ffmpeg, &ffprobe, &clip, &output, &cancel).unwrap();
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

    /// target_seconds 和 include_contact_sheet 都改变实际产出的文件，不能被
    /// canonical_payload_hash 忽略掉——否则"只改目标时长/联系表开关再导出一
    /// 次"会去重成同一条排队任务，第二次请求悄悄拿到第一次的 job。
    #[test]
    fn canonical_hash_distinguishes_target_seconds_and_contact_sheet_choice() {
        let base = export_payload_fixture(vec![export_clip_fixture(
            "same-clips.mov",
            0,
            500,
            1,
            1_000,
        )]);
        let mut different_target = base.clone();
        different_target.target_seconds = Some(60);
        let mut different_contact_sheet = base.clone();
        different_contact_sheet.include_contact_sheet = !base.include_contact_sheet;

        let base_hash = canonical_payload_hash(&base).unwrap();
        let target_hash = canonical_payload_hash(&different_target).unwrap();
        let contact_sheet_hash = canonical_payload_hash(&different_contact_sheet).unwrap();

        assert_ne!(
            base_hash, target_hash,
            "target_seconds 不同必须产生不同的 payload hash"
        );
        assert_ne!(
            base_hash, contact_sheet_hash,
            "include_contact_sheet 不同必须产生不同的 payload hash"
        );
    }

    /// override_platform 会改变联系表方向与交付说明的措辞(见
    /// `build_instructions` 读 `payload.platform_info`),但 `canonical_payload_hash`
    /// 此前没有把它纳入哈希输入——两次只差平台的 `start_export` 会被去重成
    /// 同一个排队任务,第二次请求悄悄拿到第一次那个平台的产物。
    #[test]
    fn canonical_hash_distinguishes_platform_info() {
        let base = export_payload_fixture(vec![export_clip_fixture(
            "same-clips.mov",
            0,
            500,
            1,
            1_000,
        )]);
        let mut different_platform = base.clone();
        different_platform.platform_info = douyin_portrait_platform_info();

        let base_hash = canonical_payload_hash(&base).unwrap();
        let platform_hash = canonical_payload_hash(&different_platform).unwrap();

        assert_ne!(
            base_hash, platform_hash,
            "override_platform 不同必须产生不同的 payload hash"
        );
    }

    /// R6 6b 落地后 `manual_rotation` 会真的改变参考粗剪的画面朝向
    /// (`rough_cut_rotation_prefix`),但它此前不在 `selections` 元组里:
    /// 任务 pending 期间改了某片段的旋转,复用的仍是旧 payload,导出的
    /// 粗剪不会转。
    #[test]
    fn canonical_hash_distinguishes_manual_rotation() {
        let mut rotated_clip = export_clip_fixture("same-clips.mov", 0, 500, 1, 1_000);
        rotated_clip.manual_rotation = Some(90);
        let mut unrotated_clip = export_clip_fixture("same-clips.mov", 0, 500, 1, 1_000);
        unrotated_clip.manual_rotation = None;

        let base = export_payload_fixture(vec![unrotated_clip]);
        let rotated = export_payload_fixture(vec![rotated_clip]);

        let base_hash = canonical_payload_hash(&base).unwrap();
        let rotated_hash = canonical_payload_hash(&rotated).unwrap();

        assert_ne!(
            base_hash, rotated_hash,
            "manual_rotation 不同必须产生不同的 payload hash"
        );
    }

    /// 同一批精选素材，只改 target_seconds（30 → 60）再各调用一次
    /// `start_export`：两次必须各自排出一条独立任务，不能被当成重复请求
    /// 合并成同一条——否则第二次拿到的是第一次那条 30 秒任务的 job_id。
    #[test]
    fn start_export_with_different_target_seconds_creates_two_jobs() {
        let directory = TestDirectory::new();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"placeholder").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(&connection, &source, "2026-08-31T11:00:00Z", &[1], None);

        let first =
            start_export(&mut connection, directory.path(), None, true, Some(30)).unwrap();
        let second =
            start_export(&mut connection, directory.path(), None, true, Some(60)).unwrap();

        assert_ne!(
            first.job_id, second.job_id,
            "不同 target_seconds 的两次 start_export 必须产出两条不同的任务"
        );
    }

    #[test]
    fn package_layout_follows_owner_numbering() {
        assert_eq!(SELECTED_DIRECTORY, "01_精选原片");
        assert_eq!(NARRATION_DIRECTORY, "02_环境声与旁白");
        assert_eq!(SUBTITLE_DIRECTORY, "03_字幕");
        assert_eq!(ROUGH_CUT_FILE, "04_参考粗剪/参考粗剪.mp4");
        assert_eq!(SHOT_LIST_FILE, "05_镜头表/剪辑清单.csv");
        assert_eq!(CONTACT_SHEET_FILE, "05_镜头表/联系表.pdf");
        assert_eq!(COLOR_NOTES_DIRECTORY, "06_LUT与色彩说明");
        assert_eq!(DESTINATION_DIRECTORY, "07_地点卡");
    }

    #[test]
    fn legacy_v4_export_payload_without_platform_info_still_parses() {
        // Create a v4 payload JSON (before platform_info was added) by starting with
        // a current payload and removing the platform_info key and setting version to 4.
        let clip = export_clip_fixture("clip.mov", 0, 1_000, 1, 1_000);
        let current_payload = export_payload_fixture(vec![clip]);
        let mut json_value: Value = serde_json::to_value(&current_payload).unwrap();

        // Remove platform_info and set version to 4
        if let Some(obj) = json_value.as_object_mut() {
            obj.remove("platform_info");
            obj.insert("version".to_owned(), Value::from(4_u8));
        }

        let json_str = serde_json::to_string(&json_value).unwrap();
        let parsed: ExportJobPayload = serde_json::from_str(&json_str)
            .expect("v4 payload without platform_info should deserialize");

        assert_eq!(parsed.platform_info, default_platform_info());
    }

    #[test]
    fn attach_audio_tracks_excludes_tracks_for_unselected_clips() {
        // Verify that the query filters by the delivery's selected clip ids,
        // not a full table scan. A track from an unselected clip should not appear
        // in the audio_tracks list.
        let test_dir = TestDirectory::new();
        let connection = db::open_project(&test_dir.db_path()).unwrap();

        // Create two clips (insert_clip will manage the episode)
        let clip1 = insert_clip(&connection, Path::new("clip1.mov"), "2026-08-31T00:00:00Z", &[1], None);
        let clip2 = insert_clip(&connection, Path::new("clip2.mov"), "2026-08-31T00:01:00Z", &[1], None);

        // Insert audio tracks for clip1
        connection
            .execute(
                "INSERT INTO clip_audio_tracks(clip_id, stream_index, role_guess)
                 VALUES (?1, 0, 'onboard_mic')",
                [clip1],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clip_audio_tracks(clip_id, stream_index, role_guess)
                 VALUES (?1, 1, 'wireless_mic')",
                [clip1],
            )
            .unwrap();

        // Insert audio tracks for clip2 (which will NOT be in the delivery)
        connection
            .execute(
                "INSERT INTO clip_audio_tracks(clip_id, stream_index, role_guess)
                 VALUES (?1, 0, 'backup')",
                [clip2],
            )
            .unwrap();

        // Create export clips for only clip1 (not clip2)
        let mut export_clip1 = export_clip_fixture("clip1.mov", 0, 2000, 1, 1000);
        export_clip1.clip_id = clip1;

        let mut clips = vec![export_clip1];

        // Call attach_audio_tracks with only clip1
        attach_audio_tracks(&connection, &mut clips).unwrap();

        // Verify that clip1 has its two tracks
        assert_eq!(clips[0].audio_tracks.len(), 2);
        assert_eq!(clips[0].audio_tracks[0].stream_index, 0);
        assert_eq!(clips[0].audio_tracks[0].role_guess.as_deref(), Some("onboard_mic"));
        assert_eq!(clips[0].audio_tracks[1].stream_index, 1);
        assert_eq!(clips[0].audio_tracks[1].role_guess.as_deref(), Some("wireless_mic"));

        // Verify that clip2's tracks are NOT included (the key assertion)
        assert!(!clips[0].audio_tracks.iter().any(|track| track.role_guess.as_deref() == Some("backup")));
    }

    // ---------- R11 车道 E:快速导出 ----------

    /// 两段精选 + 一条整条收藏 → 文件夹里恰好三个文件,平铺在根目录;没有粗剪 / 镜头表 /
    /// 联系表 / 交付说明;文件夹叫 `<集名>_导出_<日期>`;状态带 `mode = quick`。
    #[test]
    fn quick_export_writes_only_remuxed_segments_and_favorites() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let segmented = directory.path().join("segmented.mp4");
        let whole = directory.path().join("whole.mp4");
        if !generate_fixture(&ffmpeg, &segmented) || !generate_fixture(&ffmpeg, &whole) {
            eprintln!("skipping quick export fixture: encoder unavailable");
            return;
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let whole_id = insert_clip(&connection, &whole, "2026-08-31T10:00:00Z", &[1], None);
        let segmented_id = insert_clip(&connection, &segmented, "2026-08-31T11:00:00Z", &[1], None);
        // insert_clip 硬写 1/1000 时基;精选段要帧精确回读 PTS,时基与时长必须是真探出来的。
        let meta = crate::core::import::probe_media(&segmented).unwrap();
        connection
            .execute(
                "UPDATE clips SET tb_num = ?1, tb_den = ?2, duration_ticks = ?3 WHERE id = ?4",
                params![meta.tb_num, meta.tb_den, meta.duration_ticks, segmented_id],
            )
            .unwrap();
        let frame = meta.tb_den / meta.tb_num / 25;
        insert_select_segment(&connection, segmented_id, 0, frame * 10, 0);
        insert_select_segment(&connection, segmented_id, frame * 12, frame * 22, 0);
        let dest = directory.path().join("out");
        std::fs::create_dir(&dest).unwrap();

        let outcome = start_quick_export(&mut connection, &dest, None).unwrap();
        assert_eq!(outcome.files.len(), 3, "{outcome:?}");
        assert!(outcome.skipped.is_empty());
        let job_id = outcome.job_id.expect("quick export enqueues a job");
        let queued = get_export_status(&connection, Some(job_id)).unwrap();
        assert_eq!(queued.mode.as_deref(), Some("quick"));
        assert_eq!(queued.selected_segment_count, 2);
        assert_eq!(queued.selected_whole_count, 1);

        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();
        let finished = get_export_status(&connection, Some(job_id)).unwrap();
        assert_eq!(finished.status, "done", "{:?}", finished.error);
        assert_eq!(finished.completed_items, 3, "{:?}", finished.items);
        assert_eq!(finished.failed_items, 0);
        let output = PathBuf::from(finished.output_path.unwrap());
        let folder = output.file_name().unwrap().to_string_lossy().into_owned();
        assert!(folder.starts_with("EP01_导出_20"), "{folder}");
        assert_eq!(output, PathBuf::from(&outcome.dir));
        let mut entries: Vec<String> = std::fs::read_dir(&output)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != COMPLETION_MARKER_FILE)
            .collect();
        entries.sort();
        assert_eq!(entries.len(), 3, "{entries:?}");
        assert!(entries.iter().all(|name| name.ends_with(".mp4")), "{entries:?}");
        assert!(!output.join(ROUGH_CUT_DIRECTORY).exists());
        assert!(!output.join(SELECTED_DIRECTORY).exists());
        assert!(!output.join(SHOT_LIST_FILE).exists());
        assert!(!output.join(README_FILE).exists());
        assert_eq!(finished.items.iter().filter(|item| item.clip_id == whole_id).count(), 1);
    }

    /// Z-11:「只重试失败的」写回同一个文件夹、沿用原编号,已导好的不重做;不再另开 `-2` 从 001 重排。
    #[test]
    fn quick_export_retry_writes_into_same_folder_with_original_numbers() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let first = directory.path().join("aaa.mp4");
        let second = directory.path().join("bbb.mp4");
        let third = directory.path().join("ccc.mp4");
        if !generate_fixture(&ffmpeg, &first) || !generate_fixture(&ffmpeg, &third) {
            eprintln!("skipping quick export retry fixture: encoder unavailable");
            return;
        }
        // 第二条先放一个假视频:remux 必然失败。
        std::fs::write(&second, b"not a video at all").unwrap();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let first_id = insert_clip(&connection, &first, "2026-08-31T10:00:00Z", &[1], None);
        let second_id = insert_clip(&connection, &second, "2026-08-31T11:00:00Z", &[1], None);
        let third_id = insert_clip(&connection, &third, "2026-08-31T12:00:00Z", &[1], None);
        let dest = directory.path().join("out");
        std::fs::create_dir(&dest).unwrap();

        let outcome = start_quick_export(&mut connection, &dest, None).unwrap();
        assert_eq!(outcome.files.len(), 3, "{outcome:?}");
        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();
        let finished = get_export_status(&connection, Some(job.id)).unwrap();
        assert_eq!((finished.completed_items, finished.failed_items), (2, 1), "{:?}", finished.items);
        let folder = PathBuf::from(finished.output_path.clone().unwrap());
        let failed_item = finished.items.iter().find(|item| item.status == "failed").unwrap();
        assert_eq!(failed_item.clip_id, second_id);
        assert!(failed_item.output_name.starts_with("002_"), "{}", failed_item.output_name);
        assert!(!folder.join(&failed_item.output_name).exists());

        // 用户把第二条换回真视频(模拟「腾出空间 / 修好文件」);素材身份跟着更新。
        assert!(generate_fixture(&ffmpeg, &second));
        let (quick, bytes) = crate::core::import::quick_fingerprint(&second).unwrap();
        let full = crate::core::import::full_fingerprint(&second).unwrap();
        connection
            .execute(
                "UPDATE clips SET byte_size = ?1, quick_hash = ?2, full_hash = ?3 WHERE id = ?4",
                params![bytes as i64, quick, full, second_id],
            )
            .unwrap();

        let retry = QuickExportSelection { segment_ids: None, clip_ids: Some(vec![second_id]), retry_of_job_id: Some(job.id) };
        let plan = plan_quick_export(&connection, Some(&dest), Some(&retry)).unwrap();
        assert_eq!(PathBuf::from(&plan.dir), folder, "重试写回上一次的文件夹,不是 -2");
        assert_eq!(plan.files, vec![failed_item.output_name.clone()], "沿用原编号");
        let retried = start_quick_export(&mut connection, &dest, Some(&retry)).unwrap();
        let retry_job = jobs::claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(Some(retry_job.id), retried.job_id);
        run_export_package_with(&mut connection, &retry_job, &ffmpeg, &ffprobe).unwrap();
        let done = get_export_status(&connection, Some(retry_job.id)).unwrap();
        assert_eq!(done.status, "done", "{:?}", done.error);
        assert_eq!((done.completed_items, done.failed_items), (1, 0), "{:?}", done.items);
        assert_eq!(done.output_path.as_deref().map(PathBuf::from), Some(folder.clone()));
        assert!(folder.join(&failed_item.output_name).is_file());
        assert!(!dest.join(format!("{}-2", folder.file_name().unwrap().to_string_lossy())).exists(), "不能另开 -2 文件夹");
        let mut names: Vec<String> = std::fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".mp4"))
            .collect();
        names.sort();
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(names[0].starts_with("001_") && names[1].starts_with("002_") && names[2].starts_with("003_"), "{names:?}");
        let _ = (first_id, third_id);

        // 再重试一次:文件已在,跳过不重做。
        let again = start_quick_export(&mut connection, &dest, Some(&retry)).unwrap();
        let again_job = jobs::claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(Some(again_job.id), again.job_id);
        let before = std::fs::metadata(folder.join(&failed_item.output_name)).unwrap().modified().unwrap();
        run_export_package_with(&mut connection, &again_job, &ffmpeg, &ffprobe).unwrap();
        let skipped = get_export_status(&connection, Some(again_job.id)).unwrap();
        assert_eq!(skipped.items[0].note.as_deref(), Some("上次已导好,跳过"));
        assert_eq!(std::fs::metadata(folder.join(&failed_item.output_name)).unwrap().modified().unwrap(), before);
    }

    /// 目标目录不存在 / 不可写 → 带 `dest_unavailable` 前缀的错误,前端据此回落到保存面板。
    #[test]
    fn quick_export_rejects_unwritable_destination() {
        use std::os::unix::fs::PermissionsExt;
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        insert_clip(&connection, Path::new("whole.mov"), "2026-08-31T10:00:00Z", &[1], None);

        let missing = directory.path().join("nope");
        // CoreError 的 Display 带「export failed: 」前缀,前端按 contains 判。
        let error = start_quick_export(&mut connection, &missing, None).unwrap_err().to_string();
        assert!(error.contains(QUICK_EXPORT_DEST_UNAVAILABLE), "{error}");

        let locked = directory.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let result = start_quick_export(&mut connection, &locked, None);
        let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));
        // root 跑测试时 0555 也写得进去;只在真的被拒时断言错误码,不假绿也不假红。
        if let Err(error) = result {
            assert!(error.to_string().contains(QUICK_EXPORT_DEST_UNAVAILABLE), "{error}");
        }
        let pending: i64 = connection
            .query_row("SELECT count(*) FROM jobs WHERE kind = 'export_package'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pending, 0, "不可写目录不能留下排队任务");
    }

    /// Z-07 / Z-08:原片不在原位 → 清单里列出、排队被拒、一句人话 + 下一步;文件回来就恢复。
    #[test]
    fn quick_export_refuses_missing_sources_with_plain_reason() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let trip = directory.path().join("trip");
        std::fs::create_dir_all(&trip).unwrap();
        let source = trip.join("IMG_0830_早餐.mov");
        std::fs::write(&source, b"clip bytes").unwrap();
        insert_clip(&connection, &source, "2026-08-31T10:00:00Z", &[1], None);
        let dest = directory.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();

        let moved = directory.path().join("trip-moved");
        std::fs::rename(&trip, &moved).unwrap();
        let plan = plan_quick_export(&connection, Some(&dest), None).unwrap();
        assert_eq!(plan.missing, vec!["IMG_0830_早餐.mov".to_owned()]);
        let kit_plan = plan_jianying_kit(&connection, Some(&dest)).unwrap();
        assert_eq!(kit_plan.missing, vec!["IMG_0830_早餐.mov".to_owned()]);

        let error = start_quick_export(&mut connection, &dest, None).unwrap_err().to_string();
        assert!(error.contains("原片不在原来的位置(可能拔了卡或移了文件夹):IMG_0830_早餐.mov"), "{error}");
        assert!(error.contains("去缺失素材页重新定位"), "{error}");
        assert!(!error.contains("os error"), "{error}");
        let queued: i64 = connection
            .query_row("SELECT count(*) FROM jobs WHERE kind = 'export_package'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(queued, 0, "原片缺失不能留下排队任务");
        assert_eq!(super::super::media_source::list_missing_clips(&connection).unwrap().len(), 1);

        std::fs::rename(&moved, &trip).unwrap();
        let plan = plan_quick_export(&connection, Some(&dest), None).unwrap();
        assert!(plan.missing.is_empty(), "{:?}", plan.missing);
        assert!(super::super::media_source::list_missing_clips(&connection).unwrap().is_empty());
        let outcome = start_quick_export(&mut connection, &dest, None).unwrap();
        assert!(outcome.job_id.is_some());
    }

    /// 同名文件夹追加 `-2`、`-3`(规格 §2;交付包那边的 `_2` 不动)。
    #[test]
    fn quick_export_folder_conflict_appends_dash_suffix() {
        let directory = TestDirectory::new();
        assert_eq!(
            unique_quick_path(directory.path(), "北海道", "2026-09-13"),
            directory.path().join("北海道_导出_2026-09-13")
        );
        std::fs::create_dir(directory.path().join("北海道_导出_2026-09-13")).unwrap();
        assert_eq!(
            unique_quick_path(directory.path(), "北海道", "2026-09-13"),
            directory.path().join("北海道_导出_2026-09-13-2")
        );
        std::fs::create_dir(directory.path().join("北海道_导出_2026-09-13-2")).unwrap();
        assert_eq!(
            unique_quick_path(directory.path(), "北海道", "2026-09-13"),
            directory.path().join("北海道_导出_2026-09-13-3")
        );
    }

    /// `selection` 只导指定的段 / 素材;不在本集精选里的 id 进 `skipped` 而不是报错。
    #[test]
    fn quick_export_selection_filters_segments_and_clips() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let whole = insert_clip(&connection, Path::new("whole.mov"), "2026-08-31T10:00:00Z", &[1], None);
        let segmented = insert_clip(&connection, Path::new("segmented.mov"), "2026-08-31T11:00:00Z", &[1], None);
        let first = insert_select_segment(&connection, segmented, 0, 400, 0);
        let _second = insert_select_segment(&connection, segmented, 500, 900, 0);

        let all = plan_quick_export(&connection, None, None).unwrap();
        assert_eq!(all.files.len(), 3);
        assert_eq!(all.job_id, None);
        assert!(all.dir.starts_with("EP01_导出_"), "{}", all.dir);

        let by_segment = plan_quick_export(
            &connection,
            None,
            Some(&QuickExportSelection { segment_ids: Some(vec![first, 9_999]), clip_ids: None, retry_of_job_id: None }),
        )
        .unwrap();
        assert_eq!(by_segment.files.len(), 1);
        assert_eq!(by_segment.skipped.len(), 1);
        assert!(by_segment.skipped[0].reason.contains("9999"), "{:?}", by_segment.skipped);

        let by_clip = plan_quick_export(
            &connection,
            None,
            Some(&QuickExportSelection { segment_ids: None, clip_ids: Some(vec![segmented]), retry_of_job_id: None }),
        )
        .unwrap();
        assert_eq!(by_clip.files.len(), 2, "该素材的两段精选");
        let by_whole_clip = plan_quick_export(
            &connection,
            None,
            Some(&QuickExportSelection { segment_ids: None, clip_ids: Some(vec![whole]), retry_of_job_id: None }),
        )
        .unwrap();
        assert_eq!(by_whole_clip.files.len(), 1, "整条收藏");

        let nothing = plan_quick_export(
            &connection,
            None,
            Some(&QuickExportSelection { segment_ids: Some(vec![]), clip_ids: Some(vec![]), retry_of_job_id: None }),
        );
        assert!(nothing.is_err(), "选了个空集要报错,不能静默导出全部");
    }

    // ---------- R14 车道 B:剪映素材包 ----------

    /// 章的 `start_at` 决定它在镜头带上的先后(V14-01:导出顺序 = 镜头带顺序)。
    fn insert_chapter_at(connection: &Connection, title: &str, start_at: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO chapters(title, start_at, end_at, manual, episode_id)
                 VALUES (?1, ?2, '2026-08-31T23:59:59Z', 1,
                         (SELECT id FROM episodes WHERE status = 'active'))",
                params![title, start_at],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn put_in_story_order(connection: &Connection, clip_id: i64, segment_id: Option<i64>, position: i64) {
        connection
            .execute(
                "INSERT INTO story_order(
                    item_kind, clip_id, segment_id, position, tombstone, created_at, updated_at, episode_id
                 ) VALUES (
                    ?1, ?2, ?3, ?4, 0, '2026-08-31T13:00:00Z', '2026-08-31T13:00:00Z',
                    (SELECT id FROM episodes WHERE status = 'active')
                 )",
                params![if segment_id.is_some() { "segment" } else { "whole" }, clip_id, segment_id, position],
            )
            .unwrap();
    }

    /// 两章三镜(海边 2 镜、山里 1 镜),镜头带顺序与拍摄时间相反(山里这一章排在海边前面,
    /// 海边章内 b 先于 a):文件按镜头带顺序 01/02/03 编号,章名与素材名进文件名,
    /// 顺序.txt 每行 `NN 章名 素材名 时长`。
    #[test]
    fn jianying_kit_plan_numbers_files_by_story_order_with_chapter_and_source_name() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let sea = insert_chapter_at(&connection, "海边", "2026-08-31T06:00:00Z");
        let hill = insert_chapter_at(&connection, "山里", "2026-08-31T05:00:00Z");
        let a = insert_clip(&connection, Path::new("IMG_0001.mov"), "2026-08-31T10:00:00Z", &[1], None);
        let b = insert_clip(&connection, Path::new("IMG_0002.mov"), "2026-08-31T11:00:00Z", &[1], None);
        let c = insert_clip(&connection, Path::new("IMG_0003.mov"), "2026-08-31T12:00:00Z", &[1], None);
        connection.execute("UPDATE clips SET chapter_id = ?1 WHERE id IN (?2, ?3)", params![sea, a, b]).unwrap();
        connection.execute("UPDATE clips SET chapter_id = ?1 WHERE id = ?2", params![hill, c]).unwrap();
        let seg_b = insert_select_segment(&connection, b, 200, 1400, 0);
        // 镜头带:c(整条)→ b(精选段)→ a(整条),与拍摄时间相反。
        put_in_story_order(&connection, c, None, 0);
        put_in_story_order(&connection, b, Some(seg_b), 1);
        put_in_story_order(&connection, a, None, 2);

        let plan = plan_jianying_kit(&connection, None).unwrap();
        // J-04:两章 → 两个章节子目录,「01_山里」先出现(镜头带顺序),「02_海边」第二个出现。
        assert_eq!(
            plan.files,
            vec![
                "01_山里/01_山里_IMG_0003.mp4",
                "02_海边/02_海边_IMG_0002.mp4",
                "02_海边/03_海边_IMG_0001.mp4",
            ]
        );
        assert_eq!(plan.order_file, KIT_ORDER_FILE);
        assert!(plan.dir.starts_with("EP01_剪映素材包_20"), "{}", plan.dir);
        assert!(plan.job_id.is_none());

        let clips = selected_clips(&connection).unwrap();
        let items: Vec<ExportItemStatus> = Vec::new();
        assert_eq!(
            kit_order_text(&clips, &items),
            "— 01_山里 —\n01 山里 IMG_0003.mov 2.0 秒\n— 02_海边 —\n02 海边 IMG_0002.mov 1.2 秒\n03 海边 IMG_0001.mov 2.0 秒\n"
        );
    }

    /// V14-01:两章、挑选顺序与章节顺序相反(先挑晚章两镜,再挑早章一镜)。镜头带「按章节」画的是
    /// 早章在前、章内按 position;素材包 / 导出片段 / `selected_clips`(草稿也从它取)都必须按这份
    /// 顺序,而不是 `position` 的全局序(即挑选先后)。
    #[test]
    fn exports_follow_band_order_not_pick_order_across_chapters() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let late = insert_chapter_at(&connection, "第 7 章", "2026-08-31T14:00:00Z");
        let early = insert_chapter_at(&connection, "第 1 章", "2026-08-31T09:00:00Z");
        // Z-07 之后导出规划会真的探原片是否在位:用目录里的真文件,否则三条都被判「缺失」、退出镜头带,排序就没得比。
        let make = |name: &str| {
            let path = directory.path().join(name);
            std::fs::write(&path, b"placeholder").unwrap();
            path
        };
        let img_a = insert_clip(&connection, &make("IMG_0831.mov"), "2026-08-31T14:40:00Z", &[1], None);
        let img_b = insert_clip(&connection, &make("IMG_0832.mov"), "2026-08-31T14:41:00Z", &[1], None);
        let clip_1 = insert_clip(&connection, &make("clip_1.mp4"), "2026-08-31T09:00:00Z", &[1], None);
        connection.execute("UPDATE clips SET chapter_id = ?1 WHERE id IN (?2, ?3)", params![late, img_a, img_b]).unwrap();
        connection.execute("UPDATE clips SET chapter_id = ?1 WHERE id = ?2", params![early, clip_1]).unwrap();
        let seg_b = insert_select_segment(&connection, img_b, 200, 1400, 0);
        // 挑选先后(position 全局序):img_a → img_b(精选段)→ clip_1。
        put_in_story_order(&connection, img_a, None, 0);
        put_in_story_order(&connection, img_b, Some(seg_b), 1);
        put_in_story_order(&connection, clip_1, None, 2);

        let band = crate::core::story::ordered_band_items(&connection).unwrap();
        assert_eq!(band.iter().map(|item| item.clip_id).collect::<Vec<_>>(), vec![clip_1, img_a, img_b]);

        let clips = selected_clips(&connection).unwrap();
        assert_eq!(
            clips.iter().map(|clip| (clip.clip_id, clip.segment_id)).collect::<Vec<_>>(),
            vec![(clip_1, None), (img_a, None), (img_b, Some(seg_b))],
            "selected_clips(草稿 / 交付包的输入)按镜头带顺序"
        );
        let kit = plan_jianying_kit(&connection, None).unwrap();
        assert_eq!(
            kit.files,
            vec![
                "01_第 1 章/01_第 1 章_clip_1.mp4",
                "02_第 7 章/02_第 7 章_IMG_0831.mp4",
                "02_第 7 章/03_第 7 章_IMG_0832.mp4",
            ]
        );
        let quick = plan_quick_export(&connection, None, None).unwrap();
        assert_eq!(
            quick.files.iter().map(|name| name.split('_').next().unwrap().to_owned()).collect::<Vec<_>>(),
            vec!["001", "002", "003"]
        );
        assert!(quick.files[0].contains("clip_1"), "{:?}", quick.files);
        assert!(quick.files[2].contains("IMG_0832"), "{:?}", quick.files);
    }

    #[test]
    fn kit_file_name_sanitizes_chapter_and_source_and_grows_past_two_digits() {
        assert_eq!(kit_file_name(1, "海边", "IMG_0001.MOV"), "01_海边_IMG_0001.mp4");
        assert_eq!(kit_file_name(7, "", "b:c.mp4"), "07_未分章_b_c.mp4");
        assert_eq!(kit_file_name(12, "第一天: 出发?", "x.mov"), "12_第一天 出发_x.mp4");
        assert_eq!(kit_file_name(100, "尾声", "y.mov"), "100_尾声_y.mp4");
    }

    /// J-04:章节目录 = `NN_章名`(NN 是章节在镜头带上第几个出现,不是文件序号);
    /// `kit_relative_name` 落文件名前缀这段路径,`kit_order_text` 用同一个名字标边界。
    #[test]
    fn kit_chapter_directory_numbers_by_first_appearance_not_file_sequence() {
        assert_eq!(kit_chapter_directory(1, "山里"), "01_山里");
        assert_eq!(kit_chapter_directory(2, "海边"), "02_海边");
        assert_eq!(
            kit_relative_name(3, Some(2), "海边", "IMG_0001.MOV"),
            "02_海边/03_海边_IMG_0001.mp4"
        );
        assert_eq!(kit_relative_name(3, None, "", "IMG_0001.MOV"), "03_未分章_IMG_0001.mp4");
    }

    /// J-04:整集一个章节标记都没有 → 全部拍平(不建「01_未分章」这种只有一个空壳的子目录)。
    #[test]
    fn kit_chapter_ordinals_is_all_none_when_episode_has_no_chapters() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let a = insert_clip(&connection, Path::new("IMG_0001.mov"), "2026-08-31T10:00:00Z", &[1], None);
        let b = insert_clip(&connection, Path::new("IMG_0002.mov"), "2026-08-31T11:00:00Z", &[1], None);
        put_in_story_order(&connection, a, None, 0);
        put_in_story_order(&connection, b, None, 1);
        let clips = selected_clips(&connection).unwrap();
        assert_eq!(kit_chapter_ordinals(&clips), vec![None, None]);
        let plan = plan_jianying_kit(&connection, None).unwrap();
        assert_eq!(plan.files, vec!["01_未分章_IMG_0001.mp4", "02_未分章_IMG_0002.mp4"]);
        assert!(plan.files.iter().all(|name| !name.contains('/')), "{:?}", plan.files);
    }

    /// J-04:真落盘(临时目录,不需要 ffmpeg)——章节子目录真的建出来了,`顺序.txt` 带 `— NN_章名 —`
    /// 边界行,且落在根目录而不是某个章节子目录里。用 [`enqueue_export`] 走真实 `MODE_KIT` 分支,
    /// 直接摆文件(不跑 ffmpeg),只验证目录结构 —— 编解码那部分已有
    /// `jianying_kit_export_writes_numbered_files_and_order_file` 覆盖。
    #[test]
    fn kit_output_paths_create_chapter_subdirectories_on_disk() {
        let sequence = [(Some(2_usize), "海边", "IMG_0001.mov"), (Some(1), "山里", "IMG_0002.mov")];
        let temp = TestDirectory::new();
        for (ordinal, chapter, source) in sequence {
            let relative = kit_relative_name(1, ordinal, chapter, source);
            let path = temp.path().join(&relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, b"placeholder").unwrap();
            assert!(path.is_file(), "{relative} 应该已经落盘");
        }
        assert!(temp.path().join("02_海边").is_dir());
        assert!(temp.path().join("01_山里").is_dir());
    }

    /// 真跑一遍(有 ffmpeg 才跑):两章三镜 → 文件夹 `<集名>_剪映素材包_<日期>` 里三个 mp4 编号连续、
    /// 顺序与镜头带一致,顺序.txt 内容正确;状态 `mode = kit`;完成语「已导出 3 个片段」。
    #[test]
    fn jianying_kit_export_writes_numbered_files_and_order_file() {
        let Some((ffmpeg, ffprobe)) = ffmpeg_tools() else { return };
        let directory = TestDirectory::new();
        let first = directory.path().join("first.mp4");
        let second = directory.path().join("second.mp4");
        let third = directory.path().join("third.mp4");
        if !generate_fixture(&ffmpeg, &first) || !generate_fixture(&ffmpeg, &second) || !generate_fixture(&ffmpeg, &third) {
            eprintln!("skipping kit export fixture: encoder unavailable");
            return;
        }
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let sea = insert_chapter_at(&connection, "海边", "2026-08-31T06:00:00Z");
        let hill = insert_chapter_at(&connection, "山里", "2026-08-31T05:00:00Z");
        let a = insert_clip(&connection, &first, "2026-08-31T10:00:00Z", &[1], None);
        let b = insert_clip(&connection, &second, "2026-08-31T11:00:00Z", &[1], None);
        let c = insert_clip(&connection, &third, "2026-08-31T12:00:00Z", &[1], None);
        connection.execute("UPDATE clips SET chapter_id = ?1 WHERE id IN (?2, ?3)", params![sea, a, b]).unwrap();
        connection.execute("UPDATE clips SET chapter_id = ?1 WHERE id = ?2", params![hill, c]).unwrap();
        let meta = crate::core::import::probe_media(&second).unwrap();
        connection
            .execute(
                "UPDATE clips SET tb_num = ?1, tb_den = ?2, duration_ticks = ?3 WHERE id = ?4",
                params![meta.tb_num, meta.tb_den, meta.duration_ticks, b],
            )
            .unwrap();
        let frame = meta.tb_den / meta.tb_num / 25;
        let seg_b = insert_select_segment(&connection, b, 0, frame * 10, 0);
        put_in_story_order(&connection, c, None, 0);
        put_in_story_order(&connection, b, Some(seg_b), 1);
        put_in_story_order(&connection, a, None, 2);
        let dest = directory.path().join("out");
        std::fs::create_dir(&dest).unwrap();

        let outcome = start_jianying_kit(&mut connection, &dest).unwrap();
        // J-04:两章 → 两个章节子目录,「顺序.txt」仍在根目录。
        assert_eq!(
            outcome.files,
            vec!["01_山里/01_山里_third.mp4", "02_海边/02_海边_second.mp4", "02_海边/03_海边_first.mp4"]
        );
        let job_id = outcome.job_id.expect("kit export enqueues a job");
        let queued = get_export_status(&connection, Some(job_id)).unwrap();
        assert_eq!(queued.mode.as_deref(), Some("kit"));
        assert_eq!(
            queued.items.iter().map(|item| item.output_name.clone()).collect::<Vec<_>>(),
            outcome.files
        );

        let job = jobs::claim_next(&mut connection).unwrap().unwrap();
        run_export_package_with(&mut connection, &job, &ffmpeg, &ffprobe).unwrap();
        let finished = get_export_status(&connection, Some(job_id)).unwrap();
        assert_eq!(finished.status, "done", "{:?}", finished.error);
        assert_eq!(finished.completed_items, 3, "{:?}", finished.items);
        let output = PathBuf::from(finished.output_path.unwrap());
        assert_eq!(output, PathBuf::from(&outcome.dir));
        let folder = output.file_name().unwrap().to_string_lossy().into_owned();
        assert!(folder.starts_with("EP01_剪映素材包_20"), "{folder}");
        let mut entries: Vec<String> = std::fs::read_dir(&output)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != COMPLETION_MARKER_FILE)
            .collect();
        entries.sort();
        assert_eq!(entries, vec!["01_山里", "02_海边", KIT_ORDER_FILE]);
        assert!(output.join("01_山里").join("01_山里_third.mp4").is_file());
        assert!(output.join("02_海边").join("02_海边_second.mp4").is_file());
        assert!(output.join("02_海边").join("03_海边_first.mp4").is_file());
        let order = std::fs::read_to_string(output.join(KIT_ORDER_FILE)).unwrap();
        let lines: Vec<&str> = order.lines().collect();
        assert_eq!(lines.len(), 5, "{order}");
        assert_eq!(lines[0], "— 01_山里 —");
        assert!(lines[1].starts_with("01 山里 third.mp4 "), "{order}");
        assert_eq!(lines[2], "— 02_海边 —");
        assert!(lines[3].starts_with("02 海边 second.mp4 0.4 秒"), "{order}");
        assert!(lines[4].starts_with("03 海边 first.mp4 "), "{order}");
        assert!(!output.join(SELECTED_DIRECTORY).exists());
        assert!(!output.join(README_FILE).exists());
        let payload = parse_payload(&connection.query_row("SELECT payload FROM jobs WHERE id = ?1", [job_id], |row| row.get::<_, String>(0)).unwrap()).unwrap();
        assert_eq!(completion_message(&payload), "已导出 3 个片段");
    }
}
