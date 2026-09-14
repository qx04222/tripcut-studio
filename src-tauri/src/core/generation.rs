//! R7 Task 3:缺口 → 生成请求构造与成本预估。R7 Task 5 在同一个模块里接上
//! `submit_request`/`run_poll_job`/`import_result`:提交、轮询、回流三步全部
//! 落在这里,`story_gaps`/`generation_requests`/`generation_ledger` 三张表
//! 与 `clips.generated_source` 只在这个文件里被写。
//!
//! 只做纯值构造(提示词、参考帧列表、模式判定、成本预估),不碰
//! `story_gaps`/`generation_requests` 表——那两张表是 Task 1 在同一轮并行
//! 加的迁移,这里不对其产生编译期依赖,把持久化留给之后接线。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;

use super::error::{CoreError, Result as CoreResult};
use super::jobs::{self, Job};
use super::minimax::{
    CreateRequest, ImageContent, ImageInput, ImageRole, MinimaxClient, MinimaxError, Model, Ratio,
    Resolution, TaskId, TaskStatusKind,
};
use super::secret;
use super::settings;

const PROMPT_MAX_CHARS: usize = 7_000;
const KEYWORDS_MAX_CHARS: usize = 240;
const MAX_REFERENCE_IMAGES: usize = 3;
const MAX_TOTAL_REFS: usize = 12;

/// 提示词模板与负向约束共用的收尾句——不要人脸、不要文字水印。
const NEGATIVE_CONSTRAINT: &str = "不要出现人脸、不要文字水印。";

/// 一张参考图/参考帧,`role` 取 MiniMax 接口的角色名之一：
/// `first_frame` / `last_frame` / `reference_image`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefImage {
    pub path: String,
    pub role: String,
}

impl RefImage {
    fn new(path: impl Into<String>, role: &'static str) -> Self {
        Self {
            path: path.into(),
            role: role.to_owned(),
        }
    }
}

/// 缺口相邻镜头(前一 beat 主选片的末帧 / 后一 beat 主选片的首帧)抽出来的
/// 单帧路径,连同该镜头的画面尺寸(用来推导 `ratio`;探测不到就是 `None`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeighbourFrame {
    pub path: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// 构造一次生成请求所需的全部输入——纯值,不带数据库连接。调用方(未来的
/// `story_gap`/命令层)负责从 `narrative`/`clips`/`transcribe` 读出这些字段。
#[derive(Debug, Clone)]
pub struct BuildRequestInput<'a> {
    /// 这次要填的缺口——`submit_request` 落 `generation_requests.gap_id`、
    /// 读 `story_gaps.episode_id` 判只读、成功后把 `story_gaps.status` 推进
    /// 都靠它,详见 R7 Task 5。
    pub gap_id: i64,
    /// 必须是可生成白名单四个 slot 之一：`REAL/ESTABLISHING`、`ATMOSPHERE`、
    /// `TRANSITION`、`REAL/DETAIL`。其它值一律退化为 `REAL/DETAIL` 的模板。
    pub slot: &'a str,
    pub chapter_title: &'a str,
    pub destination_text: &'a str,
    pub transcript_keywords: &'a str,
    pub model: &'a str,
    pub resolution: &'a str,
    pub duration_s: u32,
    pub prev_last_frame: Option<NeighbourFrame>,
    pub next_first_frame: Option<NeighbourFrame>,
    /// 除首尾帧之外的额外参考图(如业主手动挑的风格参考);超过
    /// `MAX_REFERENCE_IMAGES` 张按顺序截断。
    pub extra_reference_images: Vec<String>,
}

/// 一次生成请求的草稿——`gap_id`、预算已用/上限等持久化字段留给接线
/// `story_gaps`/`generation_requests` 表的下一任务,这里只产出纯值。
#[derive(Debug, Clone, PartialEq)]
pub struct GenerationRequestDraft {
    /// 见 `BuildRequestInput::gap_id`。
    pub gap_id: i64,
    /// 非空表示这是「重新生成」新开的一行,指向被重试的旧
    /// `generation_requests.id`——旧行本身永不被这条新行修改。
    pub retry_of: Option<i64>,
    /// `t2v` / `i2v` / `fl2v`(`r2v` 是参考图生成,当前无输入路径产不出)。
    pub mode: String,
    pub model: String,
    pub resolution: String,
    pub duration_s: u32,
    /// 仅 `t2v` 必填;`i2v`/`fl2v` 由 MiniMax 按参考帧自适应,留 `None`。
    pub ratio: Option<String>,
    pub prompt: String,
    pub refs: Vec<RefImage>,
    pub estimated_cost_usd: f64,
    /// 模型能力门控产生的降级说明(如"H3-Max 不支持首尾帧,已降级为图生视频")。
    /// 正常路径为空。
    pub notes: Vec<String>,
}

/// `build_request` 的失败路径——目前只有分辨率与模型不匹配一种。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildRequestError {
    UnsupportedResolution { model: String, resolution: String },
}

impl std::fmt::Display for BuildRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BuildRequestError::UnsupportedResolution { model, resolution } => {
                write!(f, "模型 {model} 不支持分辨率 {resolution}")
            }
        }
    }
}

impl std::error::Error for BuildRequestError {}

/// 每个模型允许的分辨率白名单——H3: 768P/2K;H3-Max: 480P/768P。
fn resolution_allowed(model: &str, resolution: &str) -> bool {
    match model {
        "MiniMax-H3" => matches!(resolution, "768P" | "2K"),
        "MiniMax-H3-Max" => matches!(resolution, "480P" | "768P"),
        // 未知模型不在这里拦截,交给 estimate_cost_usd 的 0 计价兜底。
        _ => true,
    }
}

/// H3 768P $0.08/s、2K $0.13/s；H3-Max 480P $0.05/s、768P $0.08/s；
/// 前 5 张输入图免费，之后每张 $0.04。未知的 model/resolution 组合按 0
/// 计价(上层预算熔断看到 0 只会拒绝所有真实请求，不会静默漏计费)。
pub fn estimate_cost_usd(model: &str, resolution: &str, seconds: u32, images: u32) -> f64 {
    let per_second_usd = match (model, resolution) {
        ("MiniMax-H3", "768P") => 0.08,
        ("MiniMax-H3", "2K") => 0.13,
        ("MiniMax-H3-Max", "480P") => 0.05,
        ("MiniMax-H3-Max", "768P") => 0.08,
        _ => 0.0,
    };
    let billable_images = images.saturating_sub(5);
    let raw = per_second_usd * f64::from(seconds) + f64::from(billable_images) * 0.04;
    (raw * 100.0).round() / 100.0
}

/// 从相邻镜头的画面尺寸推导比例——宽≥高判 `16:9`，否则 `9:16`；
/// 探测不到尺寸(尚未跑分析、或压根没有相邻帧)一律 `16:9`。
fn ratio_from_dims(dims: Option<(i64, i64)>) -> String {
    match dims {
        Some((width, height)) if width > 0 && height > 0 && height > width => "9:16".to_owned(),
        _ => "16:9".to_owned(),
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    text.chars().take(max_chars).collect()
}

/// 四个可生成 slot 各一套中文提示词模板；其它 slot(不在白名单里,理论上
/// 调用方在 `story_gap::detect` 那一层就已经排除)退化为 `REAL/DETAIL` 的
/// 句式,不 panic。
fn slot_template(slot: &str, location: &str, keywords: &str) -> String {
    match slot {
        "REAL/ESTABLISHING" => {
            format!("航拍缓推：{location}，自然光，{keywords}，写实纪录片质感，无人物，无文字，无字幕。")
        }
        "ATMOSPHERE" => {
            format!("环境气氛空镜：{location}，{keywords}，光影自然流动，写实纪录片质感，无人物，无文字，无字幕。")
        }
        "TRANSITION" => {
            format!("场景过渡空镜：{location}，镜头缓慢移动，{keywords}，写实纪录片质感，无人物，无文字，无字幕。")
        }
        _ => {
            format!("细节特写：{location}，{keywords}，写实纪录片质感，无人物，无文字，无字幕。")
        }
    }
}

fn build_prompt(input: &BuildRequestInput) -> String {
    let keywords = truncate_chars(input.transcript_keywords, KEYWORDS_MAX_CHARS);
    let location = if input.destination_text.trim().is_empty() {
        input.chapter_title.to_owned()
    } else {
        format!("{}·{}", input.chapter_title, input.destination_text)
    };
    let mut prompt = slot_template(input.slot, &location, &keywords);
    if !prompt.contains(NEGATIVE_CONSTRAINT) {
        prompt.push_str(NEGATIVE_CONSTRAINT);
    }
    truncate_chars(&prompt, PROMPT_MAX_CHARS)
}

/// 缺口 → 生成请求草稿。模式按相邻帧是否都能抽到降级：
/// 两侧都有 → `fl2v`；只有一侧 → `i2v`；都没有 → `t2v`(此时 `ratio` 必填)。
/// 参考图先取首尾帧,再补业主指定的额外参考图,总数按
/// `MAX_REFERENCE_IMAGES`(额外参考图)与 `MAX_TOTAL_REFS`(全部 refs)两道
/// 上限截断——同一处理无关调用方传了多少张,永远不会拼出超限请求体。
pub fn build_request(input: BuildRequestInput) -> Result<GenerationRequestDraft, BuildRequestError> {
    if !resolution_allowed(input.model, input.resolution) {
        return Err(BuildRequestError::UnsupportedResolution {
            model: input.model.to_owned(),
            resolution: input.resolution.to_owned(),
        });
    }

    let is_h3_max = input.model == "MiniMax-H3-Max";
    let mut refs = Vec::new();
    let mut notes = Vec::new();
    let mode;
    let mut ratio = None;

    match (&input.prev_last_frame, &input.next_first_frame) {
        (Some(prev), Some(next)) => {
            if is_h3_max {
                // H3-Max 不支持首尾帧(fl2v),降级为图生视频:只保留首帧参考,
                // 丢弃末帧,使其不计费(estimate_cost_usd 按 refs.len() 算图数)。
                mode = "i2v";
                refs.push(RefImage::new(prev.path.clone(), "first_frame"));
                notes.push("H3-Max 不支持首尾帧，已降级为图生视频".to_owned());
            } else {
                mode = "fl2v";
                refs.push(RefImage::new(prev.path.clone(), "first_frame"));
                refs.push(RefImage::new(next.path.clone(), "last_frame"));
            }
        }
        (Some(only), None) | (None, Some(only)) => {
            mode = "i2v";
            refs.push(RefImage::new(only.path.clone(), "first_frame"));
        }
        (None, None) => {
            mode = "t2v";
            let dims = input
                .prev_last_frame
                .as_ref()
                .or(input.next_first_frame.as_ref())
                .and_then(|frame| frame.width.zip(frame.height));
            ratio = Some(ratio_from_dims(dims));
        }
    }

    let extra_count = input.extra_reference_images.len().min(MAX_REFERENCE_IMAGES);
    for path in input.extra_reference_images.iter().take(extra_count) {
        if refs.len() >= MAX_TOTAL_REFS {
            break;
        }
        refs.push(RefImage::new(path.clone(), "reference_image"));
    }
    refs.truncate(MAX_TOTAL_REFS);

    let prompt = build_prompt(&input);
    let estimated_cost_usd = estimate_cost_usd(
        input.model,
        input.resolution,
        input.duration_s,
        refs.len() as u32,
    );

    Ok(GenerationRequestDraft {
        gap_id: input.gap_id,
        retry_of: None,
        mode: mode.to_owned(),
        model: input.model.to_owned(),
        resolution: input.resolution.to_owned(),
        duration_s: input.duration_s,
        ratio,
        prompt,
        refs,
        estimated_cost_usd,
        notes,
    })
}

// ---------------------------------------------------------------------
// R7 Task 5: submit / poll / reflow
// ---------------------------------------------------------------------

/// 轮询指数退避:10s → 20s → 40s → … 上限 5 分钟(300s)。`attempt` 是
/// `jobs::claim_next_for_owner_excluding` 认领时已经 `+1` 过的值,第一次
/// 执行时是 1。
const POLL_BACKOFF_CAP_SECONDS: i64 = 300;
/// 从提交到彻底放弃的总时长上限。
const POLL_TIMEOUT_SECONDS: i64 = 2 * 60 * 60;
/// 超时后写进 `generation_requests.error` 的中文原因。
const POLL_TIMEOUT_REASON: &str = "超时";

/// 测试专用的 API Key 覆盖:非空字符串视为"已配置"的 key 本身,空字符串
/// 视为"强制未配置"——绕开真实 macOS 钥匙串,让 key-missing/key-present
/// 两条路径在任何一台开发机上都确定性可复现,不受这台机器是否真的存过
/// MiniMax key 影响,也不会让自动化测试写坏开发者本人的真实 Keychain 项。
/// 生产路径(未设置这个环境变量时)照常走 `secret::has_minimax_key`/
/// `secret::read_minimax_key`。
const TEST_API_KEY_ENV: &str = "TRIPCUT_MINIMAX_TEST_API_KEY";

fn resolve_api_key() -> CoreResult<Option<String>> {
    if let Ok(value) = std::env::var(TEST_API_KEY_ENV) {
        return Ok(if value.is_empty() { None } else { Some(value) });
    }
    secret::read_minimax_key()
        .map_err(|error| CoreError::Generation(format!("读取 MiniMax API Key 失败：{error}")))
}

#[derive(Debug, Deserialize)]
struct PollPayload {
    request_id: i64,
}

struct GenerationRequestRow {
    id: i64,
    gap_id: i64,
    task_id: Option<String>,
    status: String,
}

/// `<db 所在目录>/generated`——`run_poll_job` 落盘的根目录,永远不是原始
/// 素材目录或监听目录。命令层(拿得到 `db_path` 却还没起一个 job)用这个
/// 算出同一个根,便于「结果只出现在 generated/ 之外零新增文件」这类断言。
pub fn generated_root_for_db(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("generated")
}

/// 只读窗口(同一个工程被第二个窗口打开时拿不到工程锁的那一个)不能发起
/// 任何花钱的云端补镜写操作。`submit_generation`/`retry_generation`/
/// `cancel_generation` 三个命令都必须先过这一道,措辞与仓库里其它
/// 「只读窗口不能 XX」保持一致。
pub fn guard_writable(read_only: bool) -> CoreResult<()> {
    if read_only {
        Err(CoreError::Generation("只读窗口不能提交云端补镜请求".to_owned()))
    } else {
        Ok(())
    }
}

fn gap_episode_id(connection: &Connection, gap_id: i64) -> CoreResult<i64> {
    connection
        .query_row(
            "SELECT episode_id FROM story_gaps WHERE id = ?1",
            [gap_id],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Generation(format!("缺口 {gap_id} 不存在")))
}

fn ensure_episode_writable(connection: &Connection, episode_id: i64) -> CoreResult<()> {
    let active: i64 = connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .map_err(|_| CoreError::Generation("没有进行中的 Episode".to_owned()))?;
    if active != episode_id {
        return Err(CoreError::Generation(
            "该缺口所属 Episode 已封存，只读不可提交生成请求".to_owned(),
        ));
    }
    Ok(())
}

/// 本月预算熔断读的花费口径——复用 Task 7(`generation_settings`)已经写好
/// 的同一条查询,不再另起一份(两边的日期匹配写法此前分别是
/// `strftime('%Y-%m',at)=...` 和 `substr(at,1,7)=...`,同一个 ISO 时间戳格式
/// 下等价,统一到一处避免以后各自漂移)。
///
/// **这一条查询本身已经覆盖"在途请求"**,不需要在它之外再对
/// `generation_requests(status IN ('submitted','queued'))` 单独求和相加——
/// `generation_ledger` 的写入时机是 `submit_request` 那次事务(见下方
/// `submit_request` 里"预算熔断 → 写账本 → 发请求 → 入队"的顺序),也就是
/// 提交的那一刻,而不是任务真正完成的那一刻;一条请求从 `submitted`/
/// `queued` 一路走到 `imported`/`failed`/`cancelled`,它的账本行从提交起
/// 就已经存在且不会被删除或改写金额。换句话说 `generation_ledger` 记的从
/// 来就是"预估"而不是"实际扣费"(design doc §6 原话:"账本自述是预估")——
/// 每一条在途请求的预算占用已经通过它自己的账本行体现在这个 SUM 里了。
/// 如果再按 `generation_requests.status` 加一次同一批行的
/// `estimated_cost_usd`,会把同一笔钱数两次,让预算熔断变得比设计更保守
/// (还没轮询完的请求一多,新提交会被误拒)。
fn month_to_date_ledger_usd(connection: &Connection) -> CoreResult<f64> {
    super::generation_settings::spent_this_month_usd(connection)
}

fn serialize_refs(refs: &[RefImage]) -> CoreResult<String> {
    let value: Vec<serde_json::Value> = refs
        .iter()
        .map(|reference| serde_json::json!({"path": reference.path, "role": reference.role}))
        .collect();
    serde_json::to_string(&value)
        .map_err(|error| CoreError::Generation(format!("序列化参考帧失败：{error}")))
}

fn deserialize_refs(refs_json: &str) -> CoreResult<Vec<RefImage>> {
    let values: Vec<serde_json::Value> = serde_json::from_str(refs_json)
        .map_err(|error| CoreError::Generation(format!("解析参考帧失败：{error}")))?;
    Ok(values
        .into_iter()
        .map(|value| RefImage {
            path: value.get("path").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
            role: value.get("role").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
        })
        .collect())
}

fn model_from_str(value: &str) -> CoreResult<Model> {
    match value {
        "MiniMax-H3" => Ok(Model::H3),
        "MiniMax-H3-Max" => Ok(Model::H3Max),
        other => Err(CoreError::Generation(format!("不支持的模型：{other}"))),
    }
}

fn resolution_from_str(value: &str) -> CoreResult<Resolution> {
    match value {
        "480P" => Ok(Resolution::R480P),
        "768P" => Ok(Resolution::R768P),
        "2K" => Ok(Resolution::R2K),
        other => Err(CoreError::Generation(format!("不支持的分辨率：{other}"))),
    }
}

fn ratio_from_str(value: &str) -> CoreResult<Ratio> {
    match value {
        "16:9" => Ok(Ratio::R16x9),
        "9:16" => Ok(Ratio::R9x16),
        "1:1" => Ok(Ratio::R1x1),
        "4:3" => Ok(Ratio::R4x3),
        "3:4" => Ok(Ratio::R3x4),
        "21:9" => Ok(Ratio::R21x9),
        other => Err(CoreError::Generation(format!("不支持的画面比例：{other}"))),
    }
}

fn data_uri_for_file(path: &Path) -> CoreResult<String> {
    let bytes = std::fs::read(path)
        .map_err(|error| CoreError::Generation(format!("读取参考帧失败 {}：{error}", path.display())))?;
    let mime = match path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase) {
        Some(ext) if ext == "png" => "image/png",
        _ => "image/jpeg",
    };
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn build_create_request(draft: &GenerationRequestDraft, model: Model, resolution: Resolution) -> CoreResult<CreateRequest> {
    let mut images = Vec::with_capacity(draft.refs.len());
    for reference in &draft.refs {
        let role = match reference.role.as_str() {
            "first_frame" => ImageRole::FirstFrame,
            "last_frame" => ImageRole::LastFrame,
            _ => ImageRole::ReferenceImage,
        };
        images.push(ImageContent {
            input: ImageInput::DataUri(data_uri_for_file(Path::new(&reference.path))?),
            role,
        });
    }
    let ratio = draft.ratio.as_deref().map(ratio_from_str).transpose()?;
    Ok(CreateRequest {
        model,
        prompt: draft.prompt.clone(),
        images,
        videos: Vec::new(),
        audio: Vec::new(),
        duration: draft.duration_s,
        resolution,
        ratio,
    })
}

fn minimax_to_core_error(error: MinimaxError) -> CoreError {
    CoreError::Generation(error.to_string())
}

/// 失败收尾时,提交那一刻写下的账本预留怎么处理。R7 Task 5 复审 P2-1。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reservation {
    /// **请求从未到达平台**(建任务这一步就失败:网络不通、鉴权被拒、图片
    /// 被拒后降级重试也被拒)。平台那边根本没有这个任务,不可能计费——
    /// 预留必须退回,否则每一次失败的提交都会永久吃掉一份本月预算,连着
    /// 几次就把预算熔断误触发了。
    Release,
    /// **请求已经被平台接受**(`task_id` 已经拿到),之后远端报 failed /
    /// cancelled、本地判超时、或回流那一步出错。这些情况下算力可能已经真
    /// 的被消耗、平台可能已经真的计费——账本是"预估花费"的账,宁可多记也
    /// 不能少记,预留一律留着。
    Keep,
}

/// 提交失败(网络/鉴权/两次降级都被拒绝)时的收尾:请求行置 `failed`,
/// 缺口退回 `open`——和 `run_poll_job` 里 MiniMax 报 `failed`/`cancelled`
/// 时的收尾完全一致,业主看到的都是「失败：原因」+「重新生成」。
/// `reservation` 决定账本行退不退,见 `Reservation` 上的两条注释。
fn fail_request(
    connection: &mut Connection,
    request_id: i64,
    gap_id: i64,
    reason: &str,
    reservation: Reservation,
) -> CoreResult<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "UPDATE generation_requests SET status='failed', error=?2,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        params![request_id, reason],
    )?;
    if reservation == Reservation::Release {
        transaction.execute(
            "DELETE FROM generation_ledger WHERE request_id=?1",
            [request_id],
        )?;
    }
    transaction.execute(
        "UPDATE story_gaps SET status='open', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        [gap_id],
    )?;
    transaction.commit()?;
    Ok(())
}

/// 调 MiniMax 建任务,`ImageInputRejected` 时退化成纯文本生成再重试一次
/// (T3.1 局限里记的未核实项:一旦被拒,本机没有公网 URL,只能退化)。
/// 只在这一层负责把 `task_id`/`status='queued'`/(降级时)`mode='t2v'` 写回
/// `generation_requests`;调用方只需要处理 `Result<(), CoreError>`。
fn dispatch_create_task(
    connection: &mut Connection,
    request_id: i64,
    draft: &GenerationRequestDraft,
    api_key: &str,
) -> CoreResult<()> {
    let client = MinimaxClient::new().map_err(minimax_to_core_error)?;
    let model = model_from_str(&draft.model)?;
    let resolution = resolution_from_str(&draft.resolution)?;
    let create_request = build_create_request(draft, model, resolution)?;

    match client.create_task(&create_request, api_key) {
        Ok(task_id) => persist_task_id(connection, request_id, &task_id, None),
        Err(MinimaxError::ImageInputRejected) => {
            tracing::info!(request_id, "MiniMax 拒绝图片输入，已降级为纯文本生成并重试一次");
            let fallback_ratio = draft
                .ratio
                .as_deref()
                .map(ratio_from_str)
                .transpose()?
                .unwrap_or(Ratio::R16x9);
            let fallback = CreateRequest {
                model,
                prompt: draft.prompt.clone(),
                images: Vec::new(),
                videos: Vec::new(),
                audio: Vec::new(),
                duration: draft.duration_s,
                resolution,
                ratio: Some(fallback_ratio),
            };
            let task_id = client
                .create_task(&fallback, api_key)
                .map_err(minimax_to_core_error)?;
            persist_task_id(connection, request_id, &task_id, Some("t2v"))
        }
        Err(error) => Err(minimax_to_core_error(error)),
    }
}

fn persist_task_id(
    connection: &mut Connection,
    request_id: i64,
    task_id: &TaskId,
    downgraded_mode: Option<&str>,
) -> CoreResult<()> {
    match downgraded_mode {
        Some(mode) => connection.execute(
            "UPDATE generation_requests
             SET task_id=?2, status='queued', mode=?3, ratio=NULL,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id=?1",
            params![request_id, task_id.0, mode],
        ),
        None => connection.execute(
            "UPDATE generation_requests
             SET task_id=?2, status='queued',
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id=?1",
            params![request_id, task_id.0],
        ),
    }
    .map(|_| ())
    .map_err(CoreError::from)
}

/// 界面层(`GenerationDialog.tsx`)可覆盖的几个字段——都是可选的,缺省时
/// 分别取设置里的默认模型/分辨率与本模块的默认时长,`prompt` 缺省时用
/// `build_request` 按 slot 模板生成的那句。
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct GenerationOverrides {
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub duration_s: Option<u32>,
}

/// 未显式覆盖时的默认生成时长——落在 MiniMax 4–15s 合法区间中段。
const DEFAULT_GENERATION_DURATION_S: u32 = 6;

fn gap_prompt_context(connection: &Connection, gap_id: i64) -> CoreResult<(String, String, String)> {
    connection
        .query_row(
            "SELECT sg.slot, nc.title,
                    COALESCE(
                        (SELECT dc.name FROM destination_cards dc WHERE dc.chapter_id = sg.chapter_id LIMIT 1),
                        ''
                    )
             FROM story_gaps sg
             JOIN narrative_chapters nc ON nc.id = sg.chapter_id
             WHERE sg.id = ?1",
            [gap_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| CoreError::Generation(format!("缺口 {gap_id} 不存在")))
}

/// 抽一帧的超时上限——lavfi 级别的小文件是毫秒级,真素材(4K/HEVC)最慢
/// 也就几秒;20 秒还没出来说明 ffmpeg 卡住了,宁可退化成 t2v。
const FRAME_EXTRACT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 一个相邻 beat 解析出来的抽帧输入。
struct NeighbourBeatFrame {
    clip_id: i64,
    tick: i64,
    timebase: (i64, i64),
    width: Option<i64>,
    height: Option<i64>,
}

/// 缺口的「前一个 beat」与「后一个 beat」。
///
/// `story_gaps.beat_id` 目前恒为 NULL(`story_gap::detect` 只按 (章节, slot)
/// 建缺口,不锚定到某个 beat),所以这里的规则是:
/// - **前**:`beat_id` 有值就是它;否则取缺口所在叙事章节里 `"order"` 最大
///   的那个 beat——缺口补的是这一章缺的那种镜头,插在这一章已有内容之后;
/// - **后**:同章里排在「前」之后的下一个 beat;同章没有了(前面那条规则下
///   通常如此)就取**下一章**的第一个 beat。
///
/// 任何一侧找不到就是 `None`,`build_request` 会自动退化成 `i2v`/`t2v`。
fn neighbour_beats(connection: &Connection, gap_id: i64) -> CoreResult<(Option<i64>, Option<i64>)> {
    let (chapter_id, beat_id): (i64, Option<i64>) = connection
        .query_row(
            "SELECT chapter_id, beat_id FROM story_gaps WHERE id=?1",
            [gap_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| CoreError::Generation(format!("缺口 {gap_id} 不存在")))?;

    let previous: Option<(i64, i64)> = match beat_id {
        Some(id) => connection
            .query_row(
                "SELECT id, \"order\" FROM narrative_beats WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
        None => connection
            .query_row(
                "SELECT id, \"order\" FROM narrative_beats WHERE chapter_id=?1
                 ORDER BY \"order\" DESC LIMIT 1",
                [chapter_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
    };

    let next = match previous {
        Some((_, order)) => connection
            .query_row(
                "SELECT id FROM narrative_beats WHERE chapter_id=?1 AND \"order\" > ?2
                 ORDER BY \"order\" LIMIT 1",
                params![chapter_id, order],
                |row| row.get::<_, i64>(0),
            )
            .optional()?,
        None => None,
    };
    let next = match next {
        Some(id) => Some(id),
        // 同一章里没有下一个了 —— 顺到下一章的第一个 beat。
        None => connection
            .query_row(
                "SELECT b.id FROM narrative_beats b
                 JOIN narrative_chapters c ON c.id = b.chapter_id
                 WHERE c.episode_id = (SELECT episode_id FROM narrative_chapters WHERE id=?1)
                   AND c.\"order\" > (SELECT \"order\" FROM narrative_chapters WHERE id=?1)
                 ORDER BY c.\"order\", b.\"order\" LIMIT 1",
                [chapter_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?,
    };

    Ok((previous.map(|(id, _)| id), next))
}

/// 一个 beat 的主选片 + 要抽的那一帧的 tick。`want_last` 为真取**末**帧,
/// 为假取**首**帧(段落 `in_ticks`,没有段落就是 0)。
///
/// 末帧不能直接用 `out_ticks`/`duration_ticks`,也不能只往回退一个 tick:
/// 时长是「最后一帧的 PTS + 一帧」,`-ss` 落在最后一帧 PTS **之后**时 ffmpeg
/// 一个包都读不到、直接失败(实测 1s@10fps 的片子 `-ss 0.999` 退出码 234)。
/// 所以往回退**整整一帧**——帧长由 `clips.fps_num/fps_den` 算;那两列为空时
/// 保守按 10 fps 退 100ms(比真实帧长退得多不会出错,只会离片尾稍远一点)。
fn beat_frame_input(
    connection: &Connection,
    beat_id: i64,
    want_last: bool,
) -> CoreResult<Option<NeighbourBeatFrame>> {
    #[allow(clippy::type_complexity)]
    let row: Option<(i64, i64, i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>)> = connection
        .query_row(
            "SELECT b.clip_id, COALESCE(c.tb_num, 1), COALESCE(c.tb_den, 1000),
                    c.duration_ticks, c.width, c.height, s.in_ticks, s.out_ticks,
                    c.fps_num, c.fps_den
             FROM narrative_beats b
             JOIN clips c ON c.id = b.clip_id
             LEFT JOIN segments s ON s.id = b.segment_id
             WHERE b.id = ?1",
            [beat_id],
            |row| {
                Ok((
                    row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                    row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?,
                    row.get(8)?, row.get(9)?,
                ))
            },
        )
        .optional()?;
    let Some((clip_id, tb_num, tb_den, duration_ticks, width, height, in_ticks, out_ticks, fps_num, fps_den)) = row else {
        return Ok(None);
    };
    let tick = if want_last {
        let end = out_ticks.or(duration_ticks).unwrap_or(0);
        (end - one_frame_in_ticks(tb_num, tb_den, fps_num, fps_den)).max(0)
    } else {
        in_ticks.unwrap_or(0).max(0)
    };
    Ok(Some(NeighbourBeatFrame {
        clip_id,
        tick,
        timebase: (tb_num, tb_den),
        width,
        height,
    }))
}

/// 一帧有多少个 tick。`tick × tb_num / tb_den = 秒`,一帧 = `fps_den/fps_num`
/// 秒,所以一帧 = `fps_den × tb_den / (fps_num × tb_num)` 个 tick。fps 未知
/// (导入时探测不到)就按 10 fps 保守估算,至少 1 个 tick。
fn one_frame_in_ticks(tb_num: i64, tb_den: i64, fps_num: Option<i64>, fps_den: Option<i64>) -> i64 {
    let (fps_num, fps_den) = match (fps_num, fps_den) {
        (Some(num), Some(den)) if num > 0 && den > 0 => (num, den),
        _ => (10, 1),
    };
    if tb_num <= 0 || tb_den <= 0 {
        return 1;
    }
    (fps_den.saturating_mul(tb_den) / fps_num.saturating_mul(tb_num)).max(1)
}

/// 把一个相邻 beat 的那一帧抽到 app 缓存目录里。
///
/// 落盘根是 `artifacts::cache_root_for_db(<库路径>)/generation/<gap_id>/`,
/// 文件名 `first.jpg`(= 前一个 beat 的末帧,送给 MiniMax 时角色是
/// `first_frame`,也就是生成片的**起**帧)与 `last.jpg`(= 后一个 beat 的
/// 首帧 → `last_frame`,生成片的**止**帧)。**绝不**写进原始素材目录或监听
/// 目录。
///
/// 目录键用的是 `gap_id` 而不是 `request_id`:抽帧发生在 `draft_for_gap`
/// 里,那时请求行还不存在(`preview_generation` 只预览、根本不会产生
/// request_id),而同一个缺口的预览与提交必须看到同一张图。
///
/// 任何一步失败(ffmpeg 不在、素材离线、解码失败)都只记一条 warn 并返回
/// `None`——`build_request` 会顺势退化成 `i2v`/`t2v`,不让抽帧失败堵死整条
/// 生成路径。
fn extract_neighbour_frame(
    connection: &Connection,
    gap_id: i64,
    beat_id: i64,
    want_last: bool,
) -> Option<NeighbourFrame> {
    let input = match beat_frame_input(connection, beat_id, want_last) {
        Ok(Some(input)) => input,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(%error, beat_id, "相邻 beat 读取失败，参考帧退化");
            return None;
        }
    };
    let source = match super::media_source::verified_clip_path(connection, input.clip_id) {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(%error, clip_id = input.clip_id, "相邻镜头素材不可访问，参考帧退化");
            return None;
        }
    };
    let ffmpeg = match settings::configured_executable(
        connection,
        settings::FFMPEG_PATH_KEY,
        "FFMPEG_PATH",
        "ffmpeg",
    ) {
        Ok(ffmpeg) => ffmpeg,
        Err(error) => {
            tracing::warn!(%error, "找不到 ffmpeg，参考帧退化");
            return None;
        }
    };
    let db_path = PathBuf::from(connection.path()?);
    let output_dir = super::artifacts::cache_root_for_db(&db_path)
        .join("generation")
        .join(gap_id.to_string());
    if let Err(error) = std::fs::create_dir_all(&output_dir) {
        tracing::warn!(%error, directory = %output_dir.display(), "无法创建参考帧缓存目录，参考帧退化");
        return None;
    }
    let output = output_dir.join(if want_last { "first.jpg" } else { "last.jpg" });
    if let Err(error) = super::artifacts::extract_frame_at_tick(
        &ffmpeg,
        &source,
        input.tick,
        input.timebase,
        &output,
        None,
        FRAME_EXTRACT_TIMEOUT,
    ) {
        tracing::warn!(%error, clip_id = input.clip_id, tick = input.tick, "抽帧失败，参考帧退化");
        return None;
    }
    Some(NeighbourFrame {
        path: output.to_string_lossy().into_owned(),
        width: input.width,
        height: input.height,
    })
}

/// 缺口 + 界面覆盖 → 完整草稿,给 `preview_generation`/`submit_generation`
/// 命令共用。相邻镜头的首尾参考帧在这里抽(见 `extract_neighbour_frame`):
/// 前一 beat 主选片的**末**帧 + 后一 beat 主选片的**首**帧,两张都有就是
/// `fl2v`(H3-Max 按 `build_request` 里既有的规则降级成 i2v),只有一张是
/// `i2v`,一张都没有退化成 `t2v`。转录关键词仍留空,不影响 prompt 模板本身
/// 产出合法文本。
pub fn draft_for_gap(
    connection: &Connection,
    gap_id: i64,
    overrides: &GenerationOverrides,
) -> CoreResult<GenerationRequestDraft> {
    let (slot, chapter_title, destination_text) = gap_prompt_context(connection, gap_id)?;
    let model = match &overrides.model {
        Some(model) => model.clone(),
        None => settings::string_value(connection, settings::MINIMAX_MODEL_KEY, settings::DEFAULT_MINIMAX_MODEL)?,
    };
    let resolution = match &overrides.resolution {
        Some(resolution) => resolution.clone(),
        None => settings::string_value(
            connection,
            settings::MINIMAX_RESOLUTION_KEY,
            settings::DEFAULT_MINIMAX_RESOLUTION,
        )?,
    };
    let duration_s = overrides.duration_s.unwrap_or(DEFAULT_GENERATION_DURATION_S);
    let (previous_beat, next_beat) = neighbour_beats(connection, gap_id)?;
    let prev_last_frame =
        previous_beat.and_then(|beat| extract_neighbour_frame(connection, gap_id, beat, true));
    let next_first_frame =
        next_beat.and_then(|beat| extract_neighbour_frame(connection, gap_id, beat, false));
    let input = BuildRequestInput {
        gap_id,
        slot: &slot,
        chapter_title: &chapter_title,
        destination_text: &destination_text,
        transcript_keywords: "",
        model: &model,
        resolution: &resolution,
        duration_s,
        prev_last_frame,
        next_first_frame,
        extra_reference_images: Vec::new(),
    };
    let mut draft = build_request(input).map_err(|error| CoreError::Generation(error.to_string()))?;
    if let Some(prompt) = &overrides.prompt {
        draft.prompt = truncate_chars(prompt, PROMPT_MAX_CHARS);
    }
    Ok(draft)
}

/// R7 Task 5 接口冻结:`submit_request(connection, draft) -> CoreResult<i64>`。
/// 顺序固定为「预算熔断 → 写账本 → 发请求 → 入队」——账本在网络调用之前就
/// 写(见 design doc §6:"提交成功即写 generation_ledger（按预估计价)"),
/// 预算是乐观预留,不因为 MiniMax 那次调用最终失败而回滚。
pub fn submit_request(connection: &mut Connection, draft: GenerationRequestDraft) -> CoreResult<i64> {
    submit_request_inner(connection, draft, None)
}

/// 同一个缺口在这些状态下算「已有请求进行中」——再提交一次就是再花一次
/// 钱。`imported` 不在其中(结果已经回流,缺口是 `filled`,界面上根本不再
/// 提供生成入口),`failed`/`cancelled` 更不在(业主必须还能重来)。
const IN_FLIGHT_STATUSES: &str = "'submitted','queued','succeeded'";

/// `submit_request` 的真身。`retry_target` 非空表示这次是「重新生成」,
/// 被重试的那一行必须在**同一个 IMMEDIATE 事务里**被重新读出来核对状态——
/// 在事务外读完再进事务写,两个并发调用会双双读到 `failed` 然后各写一行。
///
/// R7 Task 5 复审 P1-1:幂等闸放在 `BEGIN IMMEDIATE` 之内。SQLite 的
/// IMMEDIATE 事务一开始就拿到写锁,同一个库上的第二个调用会被阻塞到第一个
/// 提交之后才能开始读——这就是这里需要的 `SELECT … FOR UPDATE` 语义,不
/// 需要(这一轮也不允许新增)部分唯一索引。早退时事务在 `Drop` 里回滚,
/// 请求行与账本行都不会落地。
fn submit_request_inner(
    connection: &mut Connection,
    draft: GenerationRequestDraft,
    retry_target: Option<i64>,
) -> CoreResult<i64> {
    let episode_id = gap_episode_id(connection, draft.gap_id)?;
    ensure_episode_writable(connection, episode_id)?;

    let enabled = settings::string_value(connection, settings::MINIMAX_ENABLED_KEY, "false")? == "true";
    if !enabled {
        return Err(CoreError::Generation(
            "云端补镜（MiniMax）未启用，请先在设置里打开开关".to_owned(),
        ));
    }

    let Some(api_key) = resolve_api_key()? else {
        return Err(CoreError::Generation(
            "未配置 MiniMax API Key，请先在设置里保存".to_owned(),
        ));
    };

    let budget = settings::number_value(
        connection,
        settings::MINIMAX_MONTHLY_BUDGET_KEY,
        settings::DEFAULT_MINIMAX_MONTHLY_BUDGET,
    )?;
    let used_this_month = month_to_date_ledger_usd(connection)?;
    if used_this_month + draft.estimated_cost_usd > budget {
        return Err(CoreError::Generation(format!(
            "本月云端补镜预算已用尽（已用 {used_this_month:.2} / 上限 {budget:.2} USD），\
             本次预估 {:.2} USD 已被熔断，未发起任何网络请求",
            draft.estimated_cost_usd
        )));
    }

    let refs_json = serialize_refs(&draft.refs)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    // 重试闸先于幂等闸:重试一条 `queued` 的请求,业主要听到的是「它还没
    // 结束」而不是泛泛的「该缺口已有请求进行中」。
    if let Some(target) = retry_target {
        let status: String = transaction
            .query_row(
                "SELECT status FROM generation_requests WHERE id=?1",
                [target],
                |row| row.get(0),
            )
            .map_err(|_| CoreError::Generation(format!("生成请求 {target} 不存在")))?;
        if !matches!(status.as_str(), "failed" | "cancelled") {
            return Err(CoreError::GenerationNotRetryable(target));
        }
    }

    let in_flight: Option<i64> = transaction
        .query_row(
            &format!(
                "SELECT id FROM generation_requests
                 WHERE gap_id=?1 AND status IN ({IN_FLIGHT_STATUSES})
                 ORDER BY id LIMIT 1"
            ),
            [draft.gap_id],
            |row| row.get(0),
        )
        .optional()?;
    if in_flight.is_some() {
        return Err(CoreError::GenerationInFlight);
    }

    transaction.execute(
        "INSERT INTO generation_requests(
            gap_id, retry_of, provider, model, mode, prompt, refs_json,
            duration_s, resolution, ratio, estimated_cost_usd, status,
            created_at, updated_at
         ) VALUES (?1, ?2, 'minimax', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'submitted',
            strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            draft.gap_id,
            draft.retry_of,
            draft.model,
            draft.mode,
            draft.prompt,
            refs_json,
            draft.duration_s,
            draft.resolution,
            draft.ratio,
            draft.estimated_cost_usd,
        ],
    )?;
    let request_id = transaction.last_insert_rowid();
    transaction.execute(
        "INSERT INTO generation_ledger(request_id, cost_usd, seconds, images, at)
         VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            request_id,
            draft.estimated_cost_usd,
            draft.duration_s,
            draft.refs.len() as i64,
        ],
    )?;
    transaction.execute(
        "UPDATE story_gaps SET status='requested', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?1",
        [draft.gap_id],
    )?;
    transaction.commit()?;

    match dispatch_create_task(connection, request_id, &draft, &api_key) {
        Ok(()) => {
            jobs::enqueue_idempotent(
                connection,
                "generation_poll",
                &format!("{{\"request_id\":{request_id}}}"),
                &request_id.to_string(),
            )?;
            Ok(request_id)
        }
        Err(error) => {
            // 这一步失败 = 任务从未在平台上建起来,退预留。
            fail_request(connection, request_id, draft.gap_id, &error.to_string(), Reservation::Release)?;
            Err(error)
        }
    }
}

/// 重新生成:新开一行 `retry_of` 指向旧行,旧行原样不动,走一遍
/// `submit_request` 的全套熔断/账本/入队。
pub fn retry_generation(connection: &mut Connection, request_id: i64) -> CoreResult<i64> {
    let (gap_id, model, mode, prompt, refs_json, duration_s, resolution, ratio, estimated_cost_usd) = connection
        .query_row(
            "SELECT gap_id, model, mode, prompt, refs_json, duration_s, resolution, ratio, estimated_cost_usd
             FROM generation_requests WHERE id=?1",
            [request_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, u32>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, f64>(8)?,
                ))
            },
        )
        .map_err(|_| CoreError::Generation(format!("生成请求 {request_id} 不存在")))?;
    let draft = GenerationRequestDraft {
        gap_id,
        retry_of: Some(request_id),
        mode,
        model,
        resolution,
        duration_s,
        ratio,
        prompt,
        refs: deserialize_refs(&refs_json)?,
        estimated_cost_usd,
        notes: Vec::new(),
    };
    submit_request_inner(connection, draft, Some(request_id))
}

fn load_request(connection: &Connection, id: i64) -> CoreResult<GenerationRequestRow> {
    connection
        .query_row(
            "SELECT id, gap_id, task_id, status FROM generation_requests WHERE id=?1",
            [id],
            |row| {
                Ok(GenerationRequestRow {
                    id: row.get(0)?,
                    gap_id: row.get(1)?,
                    task_id: row.get(2)?,
                    status: row.get(3)?,
                })
            },
        )
        .map_err(|_| CoreError::Generation(format!("生成请求 {id} 不存在")))
}

/// 第 `attempt` 次(从 1 开始)执行的退避秒数:10 → 20 → 40 → … 上限 300。
fn backoff_delay_seconds(attempt: i64) -> i64 {
    let exponent = attempt.saturating_sub(1).clamp(0, 62) as u32;
    10_i64
        .checked_shl(exponent)
        .unwrap_or(POLL_BACKOFF_CAP_SECONDS)
        .min(POLL_BACKOFF_CAP_SECONDS)
}

/// 仍在排队/生成中(或查询本身瞬时失败),按退避重新入队;累计耗时一旦
/// 超过 2 小时就直接判超时失败,不再排下一轮。
fn requeue_or_timeout(connection: &mut Connection, job: &Job, request: &GenerationRequestRow) -> CoreResult<()> {
    let elapsed_seconds: f64 = connection.query_row(
        "SELECT (julianday('now') - julianday(created_at)) * 86400.0
         FROM generation_requests WHERE id=?1",
        [request.id],
        |row| row.get(0),
    )?;
    if elapsed_seconds > POLL_TIMEOUT_SECONDS as f64 {
        fail_request(connection, request.id, request.gap_id, POLL_TIMEOUT_REASON, Reservation::Keep)?;
        jobs::mark_done(connection, job.id, job.attempt)?;
        return Ok(());
    }

    let delay = backoff_delay_seconds(job.attempt);
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "UPDATE jobs
         SET status='pending', owner_id=NULL, lease_expires_at=NULL, finished_at=NULL,
             next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?3),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id=?1 AND status='running' AND attempt=?2",
        params![job.id, job.attempt, format!("+{delay} seconds")],
    )?;
    if changed != 1 {
        return Err(CoreError::Generation(format!(
            "generation_poll job {} 状态已在其它地方改变，跳过重排",
            job.id
        )));
    }
    transaction.commit()?;
    Ok(())
}

/// 缺口所在 `narrative_chapters` 行与 `clips.chapter_id` 引用的 `chapters`
/// 表不是同一个 ID 空间(前者是叙事结构章节,后者是按时间轴自动分出的
/// Shot Stack 场景)。生成片要落进"和它的叙事邻居同一个 Shot Stack 场景"，
/// 就必须借道 `narrative_beats` 找一个已经在这个叙事章节里的真实素材，
/// 抄它的 `chapters.id`——直接把 `story_gaps.chapter_id`(叙事章节 id)
/// 塞进 `clips.chapter_id` 会撞 `REFERENCES chapters(id)` 外键。缺口所在
/// 叙事章节里一个真实 beat 都没有时返回 `None`(生成片进"未分类"场景，
/// 不阻塞回流)。
fn timeline_chapter_for_gap(connection: &Connection, gap_id: i64) -> CoreResult<Option<i64>> {
    let narrative_chapter_id: i64 = connection
        .query_row("SELECT chapter_id FROM story_gaps WHERE id=?1", [gap_id], |row| row.get(0))
        .map_err(|_| CoreError::Generation(format!("缺口 {gap_id} 不存在")))?;
    connection
        .query_row(
            "SELECT clips.chapter_id
             FROM narrative_beats
             JOIN clips ON clips.id = narrative_beats.clip_id
             WHERE narrative_beats.chapter_id = ?1
             ORDER BY narrative_beats.\"order\"
             LIMIT 1",
            [narrative_chapter_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(CoreError::from)
}

/// `succeeded` 之后的回流:下载 → 走普通导入 → 打生成片标记 → 缺口填上 →
/// Stack 重建。每一步失败都留下可读的 `error`(调用方统一走 `fail_request`)。
/// **绝不**把结果写进原始素材目录或监听目录——落盘根永远是
/// `generated_root_for_db` 那一个目录。
fn import_result(
    connection: &mut Connection,
    request: &GenerationRequestRow,
    client: &MinimaxClient,
    url: &str,
    project_root: &Path,
) -> CoreResult<()> {
    let episode_id = gap_episode_id(connection, request.gap_id)?;
    let dest_dir = generated_root_for_project(project_root).join(episode_id.to_string());
    std::fs::create_dir_all(&dest_dir)
        .map_err(|error| CoreError::Generation(format!("无法创建生成物目录 {}：{error}", dest_dir.display())))?;
    let task_id = request.task_id.clone().unwrap_or_default();
    let dest = dest_dir.join(format!("{}-{}.mp4", request.id, task_id));

    // R7 Task 5 复审 P2-2:回流做到一半崩溃(文件下好了、clip 也入库了,但
    // `generation_requests.status` 还没写)时,恢复后这条 poll 会被重新
    // 认领。此时目标路径上的 clip 已经存在——不能再下载一次、更不能因为
    // `run_import_probe` 返回 `Duplicate`(于是导入批次里没有新的
    // `import_batch_clips` 行)就把一条其实已经成功的请求判成失败。先按
    // 目标路径把既有 clip 找回来,找到就直接进最后的落库那一步。
    let clip_id = match super::import::clip_id_for_path(connection, &dest)? {
        Some(existing) => {
            tracing::info!(request_id = request.id, clip_id = existing, "生成物已在库中，复用既有 clip");
            existing
        }
        None => import_downloaded_clip(connection, client, url, &dest, episode_id)?,
    };

    let timeline_chapter_id = timeline_chapter_for_gap(connection, request.gap_id)?;

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "UPDATE clips SET generated_source='minimax', chapter_id=?2 WHERE id=?1",
        params![clip_id, timeline_chapter_id],
    )?;
    transition_to_imported(&transaction, request.id, Some(clip_id), Some(url))?;
    transaction.execute(
        "UPDATE story_gaps SET status='filled', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        [request.gap_id],
    )?;
    transaction.commit()?;

    super::shot_stack::rebuild(connection)?;
    Ok(())
}

/// 下载 → 走普通导入 → 拿到 clip id。抽出来是为了让 `import_result` 的
/// "已经有 clip 了就复用"这条恢复路径读起来只有一行。
///
/// `episode_id` 是**提交请求时**那一集(由 `story_gaps.episode_id` 推出),
/// 不是轮询这一刻恰好活跃的那一集——2 小时的窗口里业主完全可能已经封存它
/// 并开了新一集(复审 P2-3)。0041 的 `generation_requests` 没有
/// `episode_id` 列,本轮迁移冻结,所以每次都从缺口推导。
fn import_downloaded_clip(
    connection: &mut Connection,
    client: &MinimaxClient,
    url: &str,
    dest: &Path,
    episode_id: i64,
) -> CoreResult<i64> {
    client
        .download(url, dest)
        .map_err(|error| CoreError::Generation(format!("下载生成结果失败：{error}")))?;

    let import_start = super::import::start_import_files_into_episode(
        connection,
        std::slice::from_ref(&dest.to_path_buf()),
        episode_id,
    )?;
    let probe_job_id: i64 = connection
        .query_row(
            "SELECT id FROM jobs WHERE import_batch_id=?1 AND kind='import_probe' ORDER BY id DESC LIMIT 1",
            [import_start.batch_id],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Generation("生成物导入任务未入队".to_owned()))?;
    let probe_job = jobs::claim_specific_pending_job(connection, probe_job_id)?;
    let duplicate_of = match super::import::run_import_probe(connection, &probe_job) {
        Ok(super::import::ImportProbeOutcome::Imported) => {
            jobs::mark_done(connection, probe_job.id, probe_job.attempt)?;
            None
        }
        // 同一份内容已经在库里(崩溃重跑,或平台重复返回同一段视频)——
        // 按同一套「路径 → quick_hash」把既有 clip 解析出来,而不是去
        // `import_batch_clips` 里找一条根本不会被写进去的行。
        Ok(super::import::ImportProbeOutcome::Duplicate(path)) => {
            jobs::mark_done_with_result_path(connection, probe_job.id, probe_job.attempt, &path)?;
            Some(path)
        }
        // Z-13:生成物路径已属于另一集(与此前的 Err 分支同义:不改写归属)。
        Ok(super::import::ImportProbeOutcome::OwnedElsewhere { note, .. }) => {
            return Err(CoreError::Generation(format!("生成物导入失败：{note}")));
        }
        Err(error) => {
            return Err(CoreError::Generation(format!("生成物导入失败：{error}")));
        }
    };
    super::canonical_time::enqueue_align_if_ready(connection)?;
    super::story::enqueue_if_import_complete(connection)?;

    if let Some(path) = duplicate_of {
        if let Some(existing) = super::import::clip_id_for_path(connection, &path)? {
            return Ok(existing);
        }
    }
    connection
        .query_row(
            "SELECT clip_id FROM import_batch_clips WHERE batch_id=?1 ORDER BY clip_id DESC LIMIT 1",
            [import_start.batch_id],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Generation("生成物导入未产出 clip".to_owned()))
}

fn generated_root_for_project(project_root: &Path) -> PathBuf {
    project_root.join("generated")
}

/// R7 Task 5 接口冻结:`run_poll_job(connection, job, project_root) -> CoreResult<()>`。
/// `project_root` 是工程目录(与 `generated_root_for_db(db_path)` 的
/// `db_path.parent()` 同一个目录)——调用方(`jobs.rs`)已经手上有
/// `db_path`,直接传 `db_path.parent()` 进来,不必再算一遍。
pub fn run_poll_job(connection: &mut Connection, job: &Job, project_root: &Path) -> CoreResult<()> {
    let payload: PollPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Generation(format!("generation_poll payload 无效：{error}")))?;
    let request = load_request(connection, payload.request_id)?;

    if matches!(request.status.as_str(), "imported" | "failed" | "cancelled") {
        // 竞态兜底:请求已经是终态(例如业主同时点了取消),这条 poll 直接
        // 收尾,不再打任何网络请求。
        jobs::mark_done(connection, job.id, job.attempt)?;
        return Ok(());
    }

    let Some(api_key) = resolve_api_key()? else {
        fail_request(connection, request.id, request.gap_id, "未配置 MiniMax API Key", Reservation::Keep)?;
        jobs::mark_done(connection, job.id, job.attempt)?;
        return Ok(());
    };
    let Some(task_id_raw) = request.task_id.clone() else {
        // 没有 task_id 就意味着平台上从来没有过这个任务(防御性分支:
        // `submit_request` 里建任务失败已经走过 `Reservation::Release`
        // 了),同样不该占预算。
        fail_request(connection, request.id, request.gap_id, "生成请求缺少 task_id，无法轮询", Reservation::Release)?;
        jobs::mark_done(connection, job.id, job.attempt)?;
        return Ok(());
    };

    let client = MinimaxClient::new().map_err(minimax_to_core_error)?;
    let task_id = TaskId(task_id_raw);
    match client.query_task(&task_id, &api_key) {
        Ok(status) if status.status == TaskStatusKind::Succeeded => {
            let Some(url) = status.url else {
                fail_request(connection, request.id, request.gap_id, "MiniMax 返回成功但没有下载链接", Reservation::Keep)?;
                return jobs::mark_done(connection, job.id, job.attempt);
            };
            match import_result(connection, &request, &client, &url, project_root) {
                Ok(()) => jobs::mark_done(connection, job.id, job.attempt)?,
                Err(error) => {
                    fail_request(connection, request.id, request.gap_id, &error.to_string(), Reservation::Keep)?;
                    jobs::mark_done(connection, job.id, job.attempt)?;
                }
            }
            Ok(())
        }
        Ok(_) => requeue_or_timeout(connection, job, &request),
        Err(MinimaxError::Cancelled) => {
            fail_request(connection, request.id, request.gap_id, "MiniMax 任务已取消", Reservation::Keep)?;
            jobs::mark_done(connection, job.id, job.attempt)
        }
        Err(MinimaxError::Failed { message }) => {
            fail_request(connection, request.id, request.gap_id, &message, Reservation::Keep)?;
            jobs::mark_done(connection, job.id, job.attempt)
        }
        // 瞬态网络/限流错误:和"仍在排队"同样处理——按同一套退避重试，
        // 不提前判失败,也不额外多烧一份 2 小时预算之外的重试次数。
        Err(_) => requeue_or_timeout(connection, job, &request),
    }
}

/// 生成请求汇总——形状与 `src/api.ts` 的 `GenerationRequestSummary` 一一对应
/// (Task 6 的 `GenerationDialog.tsx`/`Storyboard.tsx` 已经按这个形状写好了
/// UI 与测试)。`actual_cost_usd` 恒为 `None`——平台不回单次实际扣费,账本
/// 全程只有预估值(design doc §6/§9),这个字段留给以后业主对账时手工核对。
#[derive(Debug, Clone, serde::Serialize)]
pub struct GenerationRequestSummary {
    pub id: i64,
    pub status: String,
    pub error: Option<String>,
    pub estimated_cost_usd: f64,
    pub actual_cost_usd: Option<f64>,
    pub result_clip_id: Option<i64>,
}

pub fn generation_request_summary(connection: &Connection, id: i64) -> CoreResult<GenerationRequestSummary> {
    connection
        .query_row(
            "SELECT id, status, error, estimated_cost_usd, result_clip_id
             FROM generation_requests WHERE id=?1",
            [id],
            |row| {
                Ok(GenerationRequestSummary {
                    id: row.get(0)?,
                    status: row.get(1)?,
                    error: row.get(2)?,
                    estimated_cost_usd: row.get(3)?,
                    actual_cost_usd: None,
                    result_clip_id: row.get(4)?,
                })
            },
        )
        .map_err(|_| CoreError::Generation(format!("生成请求 {id} 不存在")))
}

pub fn list_generation_requests(connection: &Connection, episode_id: i64) -> CoreResult<Vec<GenerationRequestSummary>> {
    let mut statement = connection.prepare(
        "SELECT gr.id, gr.status, gr.error, gr.estimated_cost_usd, gr.result_clip_id
         FROM generation_requests gr
         JOIN story_gaps sg ON sg.id = gr.gap_id
         WHERE sg.episode_id = ?1
         ORDER BY gr.id DESC",
    )?;
    let rows = statement.query_map([episode_id], |row| {
        Ok(GenerationRequestSummary {
            id: row.get(0)?,
            status: row.get(1)?,
            error: row.get(2)?,
            estimated_cost_usd: row.get(3)?,
            actual_cost_usd: None,
            result_clip_id: row.get(4)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}

/// 本进程内「刚刚真的发生过 succeeded → imported 跃迁、还没发通知」的请求。
/// 键是 (库路径, request_id)——同一个进程可能先后开过不同工程。
///
/// R7 Task 5 复审 P3-2:通知过去只看「现在的状态是不是 imported」,那是一个
/// **状态**而不是一个**事件**——同一条请求被重新认领(崩溃恢复、手工重排、
/// 竞态兜底那条 `已终态直接 mark_done` 的分支)都会让它再响一次。现在改成
/// 只有 `transition_to_imported` 里那条带 `status <> 'imported'` 谓词的
/// UPDATE 真的改到了一行,才在这里登记一次待发通知;`completion_notice`
/// **取走**它(take,不是 peek),所以结构上至多响一次。
static PENDING_IMPORT_NOTICES: std::sync::Mutex<std::collections::BTreeSet<(String, i64)>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

fn notice_scope(connection: &Connection) -> String {
    connection.path().unwrap_or("<memory>").to_owned()
}

/// 把一条请求推进 `imported`,**并且只在这次调用真的完成了跃迁时**登记一条
/// 待发通知。谓词 `status <> 'imported'` 就是那道跃迁闸:重新认领一条已经
/// `imported` 的请求时 `changes()` 是 0,什么都不会被登记。
///
/// 登记发生在事务提交之前(调用方紧接着就 commit)。万一那次 commit 失败,
/// 最坏结果是多发一条通知,而不是少发或错发——通知本身不改任何状态。
pub(crate) fn transition_to_imported(
    transaction: &rusqlite::Transaction<'_>,
    request_id: i64,
    clip_id: Option<i64>,
    result_url: Option<&str>,
) -> CoreResult<bool> {
    let changed = transaction.execute(
        "UPDATE generation_requests
         SET status='imported',
             result_clip_id=COALESCE(?2, result_clip_id),
             result_url=COALESCE(?3, result_url),
             error=NULL,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?1 AND status <> 'imported'",
        params![request_id, clip_id, result_url],
    )?;
    if changed == 1 {
        PENDING_IMPORT_NOTICES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert((notice_scope(transaction), request_id));
    }
    Ok(changed == 1)
}

/// R7 Task 5:`jobs::notify_on_completion` 的检测点——只在这次 `generation_poll`
/// 执行**真的把请求从非 imported 推到 imported** 时才返回 `Some`,并且把这
/// 条待发通知取走(见 `PENDING_IMPORT_NOTICES`)。重新认领一条已经 imported
/// 的请求不会再响。
pub(crate) fn completion_notice(connection: &Connection, job: &Job) -> CoreResult<Option<(String, String)>> {
    if job.kind != "generation_poll" {
        return Ok(None);
    }
    let payload: PollPayload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::Generation(format!("generation_poll payload 无效：{error}")))?;
    let transitioned = PENDING_IMPORT_NOTICES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&(notice_scope(connection), payload.request_id));
    if !transitioned {
        return Ok(None);
    }
    Ok(Some((
        "补镜完成".to_owned(),
        format!("生成请求 #{} 的素材已导入", payload.request_id),
    )))
}

/// 尽力而为的本地取消——MiniMax 没有取消 API。只改本地状态、让缺口回到
/// `open`,并给还没跑到的 `generation_poll` job 打上 `cancel_requested`,
/// 防止它在取消之后又跑一轮轮询。
pub fn cancel_generation(connection: &mut Connection, request_id: i64) -> CoreResult<()> {
    let request = load_request(connection, request_id)?;
    if matches!(request.status.as_str(), "imported" | "failed" | "cancelled") {
        return Err(CoreError::Generation("该生成请求已是终态，无法取消".to_owned()));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "UPDATE generation_requests SET status='cancelled', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=?1",
        [request_id],
    )?;
    transaction.execute(
        "UPDATE story_gaps SET status='open', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        [request.gap_id],
    )?;
    transaction.execute(
        "UPDATE jobs SET cancel_requested=1
         WHERE kind='generation_poll' AND payload_hash=?1 AND status IN ('pending','running')",
        [request_id.to_string()],
    )?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_input<'a>(
        slot: &'a str,
        prev: Option<NeighbourFrame>,
        next: Option<NeighbourFrame>,
    ) -> BuildRequestInput<'a> {
        BuildRequestInput {
            gap_id: 1,
            slot,
            chapter_title: "第 3 章 黑石峡谷",
            destination_text: "黑石峡谷·峡谷地貌·黄昏",
            transcript_keywords: "岩壁 河流 落日",
            model: "MiniMax-H3-Max",
            resolution: "768P",
            duration_s: 6,
            prev_last_frame: prev,
            next_first_frame: next,
            extra_reference_images: Vec::new(),
        }
    }

    #[test]
    fn estimate_cost_matches_published_pricing() {
        assert_eq!(estimate_cost_usd("MiniMax-H3", "768P", 6, 0), 0.48);
        assert_eq!(estimate_cost_usd("MiniMax-H3", "2K", 10, 0), 1.30);
        assert_eq!(estimate_cost_usd("MiniMax-H3-Max", "480P", 4, 0), 0.20);
        // 7 张图:前 5 免费,后 2 张 * 0.04 = 0.08,附加在时长费用之上。
        let with_images = estimate_cost_usd("MiniMax-H3-Max", "768P", 4, 7);
        let without_images = estimate_cost_usd("MiniMax-H3-Max", "768P", 4, 0);
        assert!((with_images - without_images - 0.08).abs() < 1e-9);
        // 前 5 张免费:5 张和 0 张同价。
        assert_eq!(
            estimate_cost_usd("MiniMax-H3-Max", "768P", 4, 5),
            estimate_cost_usd("MiniMax-H3-Max", "768P", 4, 0),
        );
    }

    #[test]
    fn mode_is_fl2v_when_both_neighbour_frames_exist() {
        // H3(非 H3-Max)支持 fl2v——H3-Max 的降级路径见
        // `h3_max_downgrades_fl2v_to_i2v_and_drops_last_frame`。
        let prev = NeighbourFrame { path: "/cache/1/prev_last.jpg".into(), width: Some(1920), height: Some(1080) };
        let next = NeighbourFrame { path: "/cache/2/next_first.jpg".into(), width: Some(1920), height: Some(1080) };
        let mut input = base_input("REAL/ESTABLISHING", Some(prev.clone()), Some(next.clone()));
        input.model = "MiniMax-H3";
        let draft = build_request(input).unwrap();
        assert_eq!(draft.mode, "fl2v");
        assert_eq!(draft.ratio, None);
        assert_eq!(draft.refs.len(), 2);
        assert_eq!(draft.refs[0], RefImage { path: prev.path, role: "first_frame".into() });
        assert_eq!(draft.refs[1], RefImage { path: next.path, role: "last_frame".into() });
        assert!(draft.notes.is_empty());
    }

    #[test]
    fn h3_max_downgrades_fl2v_to_i2v_and_drops_last_frame() {
        let prev = NeighbourFrame { path: "/cache/1/prev_last.jpg".into(), width: Some(1920), height: Some(1080) };
        let next = NeighbourFrame { path: "/cache/2/next_first.jpg".into(), width: Some(1920), height: Some(1080) };
        // base_input 默认 model 就是 MiniMax-H3-Max。
        let draft = build_request(base_input("REAL/ESTABLISHING", Some(prev.clone()), Some(next))).unwrap();
        assert_eq!(draft.mode, "i2v");
        assert_eq!(draft.refs, vec![RefImage { path: prev.path, role: "first_frame".into() }]);
        assert_eq!(draft.notes, vec!["H3-Max 不支持首尾帧，已降级为图生视频".to_owned()]);
    }

    #[test]
    fn falls_back_to_i2v_with_only_one_neighbour() {
        let prev = NeighbourFrame { path: "/cache/1/prev_last.jpg".into(), width: Some(1920), height: Some(1080) };
        let draft = build_request(base_input("ATMOSPHERE", Some(prev.clone()), None)).unwrap();
        assert_eq!(draft.mode, "i2v");
        assert_eq!(draft.ratio, None);
        assert_eq!(draft.refs, vec![RefImage { path: prev.path, role: "first_frame".into() }]);

        let next = NeighbourFrame { path: "/cache/2/next_first.jpg".into(), width: Some(1080), height: Some(1920) };
        let draft2 = build_request(base_input("ATMOSPHERE", None, Some(next.clone()))).unwrap();
        assert_eq!(draft2.mode, "i2v");
        assert_eq!(draft2.refs, vec![RefImage { path: next.path, role: "first_frame".into() }]);
    }

    #[test]
    fn falls_back_to_t2v_and_requires_ratio() {
        let draft = build_request(base_input("TRANSITION", None, None)).unwrap();
        assert_eq!(draft.mode, "t2v");
        assert!(draft.refs.is_empty());
        assert_eq!(draft.ratio, Some("16:9".to_owned()));
    }

    #[test]
    fn prompt_contains_chapter_title_destination_and_slot_template() {
        let draft = build_request(base_input("REAL/ESTABLISHING", None, None)).unwrap();
        assert!(draft.prompt.contains("第 3 章 黑石峡谷"));
        assert!(draft.prompt.contains("黑石峡谷·峡谷地貌·黄昏"));
        assert!(draft.prompt.contains("岩壁 河流 落日"));
        assert!(draft.prompt.contains("航拍缓推"));
        assert!(draft.prompt.contains("不要出现人脸"));
        assert!(!draft.prompt.contains("/cache/"));
    }

    #[test]
    fn prompt_is_capped_at_7000_chars() {
        let long_keywords = "关键词".repeat(5_000);
        let input = BuildRequestInput {
            transcript_keywords: &long_keywords,
            ..base_input("ATMOSPHERE", None, None)
        };
        let draft = build_request(input).unwrap();
        assert!(draft.prompt.chars().count() <= 7_000);
    }

    #[test]
    fn reference_images_capped_at_three_and_total_items_at_twelve() {
        let prev = NeighbourFrame { path: "/cache/1/prev_last.jpg".into(), width: None, height: None };
        let next = NeighbourFrame { path: "/cache/2/next_first.jpg".into(), width: None, height: None };
        let many_extra: Vec<String> = (0..10).map(|index| format!("/refs/{index}.jpg")).collect();
        let mut input = base_input("REAL/DETAIL", Some(prev), Some(next));
        input.model = "MiniMax-H3";
        input.extra_reference_images = many_extra;
        let draft = build_request(input).unwrap();
        // fl2v 的两张首尾帧 + 最多 3 张额外参考图 = 5,远低于 12 的总量上限,
        // 断言的是"额外参考图本身被截到 3 张"这条独立规则。
        let reference_image_count = draft
            .refs
            .iter()
            .filter(|r| r.role == "reference_image")
            .count();
        assert_eq!(reference_image_count, 3);
        assert!(draft.refs.len() <= MAX_TOTAL_REFS);
    }

    #[test]
    fn frame_extraction_failure_degrades_mode_without_panicking() {
        // 模拟"末帧抽取失败"——调用方拿不到 prev_last_frame,只传 None,
        // 而不是让抽帧的 Err 冒泡到这里 panic。降级路径本身就是
        // mode_is_fl2v_when_both_neighbour_frames_exist /
        // falls_back_to_i2v_with_only_one_neighbour /
        // falls_back_to_t2v_and_requires_ratio 三个测试共同覆盖的同一段代码,
        // 这里再断言一次三档降级互不 panic、互不报错。
        for (prev, next) in [
            (None, None),
            (
                Some(NeighbourFrame { path: "/cache/1/prev_last.jpg".into(), width: Some(100), height: Some(100) }),
                None,
            ),
            (
                None,
                Some(NeighbourFrame { path: "/cache/2/next_first.jpg".into(), width: Some(100), height: Some(100) }),
            ),
            (
                Some(NeighbourFrame { path: "/cache/1/prev_last.jpg".into(), width: Some(100), height: Some(100) }),
                Some(NeighbourFrame { path: "/cache/2/next_first.jpg".into(), width: Some(100), height: Some(100) }),
            ),
        ] {
            let draft = build_request(base_input("REAL/DETAIL", prev, next)).unwrap();
            assert!(!draft.mode.is_empty());
            assert!(draft.estimated_cost_usd >= 0.0);
        }
    }

    #[test]
    fn h3_max_rejects_2k_and_h3_rejects_480p() {
        let mut h3_max_2k = base_input("REAL/DETAIL", None, None);
        h3_max_2k.resolution = "2K";
        assert_eq!(
            build_request(h3_max_2k).unwrap_err(),
            BuildRequestError::UnsupportedResolution {
                model: "MiniMax-H3-Max".to_owned(),
                resolution: "2K".to_owned(),
            }
        );

        let mut h3_480p = base_input("REAL/DETAIL", None, None);
        h3_480p.model = "MiniMax-H3";
        h3_480p.resolution = "480P";
        assert_eq!(
            build_request(h3_480p).unwrap_err(),
            BuildRequestError::UnsupportedResolution {
                model: "MiniMax-H3".to_owned(),
                resolution: "480P".to_owned(),
            }
        );
    }

    // -------------------------------------------------------------
    // R7 Task 5: submit / poll / reflow
    // -------------------------------------------------------------

    use crate::core::{db, test_support::TestDirectory};

    /// 环境变量是进程全局的,`cargo test` 默认多线程跑同一个测试二进制——
    /// 用一把锁把"设置 base URL / test API key → 跑断言 → 清理"这一整段
    /// 串行化,不然并行测试会互相踩环境变量。镜像
    /// `tests/minimax_client.rs::with_base_url` 的手法。
    fn with_env<F: FnOnce()>(base_url: Option<&str>, api_key: Option<&str>, f: F) {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // SAFETY: 串行化于 LOCK,持锁期间不会有其它线程读写这两个变量。
        unsafe {
            match base_url {
                Some(value) => std::env::set_var("TRIPCUT_MINIMAX_BASE_URL", value),
                None => std::env::remove_var("TRIPCUT_MINIMAX_BASE_URL"),
            }
            match api_key {
                Some(value) => std::env::set_var(TEST_API_KEY_ENV, value),
                None => std::env::remove_var(TEST_API_KEY_ENV),
            }
        }
        f();
        unsafe {
            std::env::remove_var("TRIPCUT_MINIMAX_BASE_URL");
            std::env::remove_var(TEST_API_KEY_ENV);
        }
    }

    fn open_project() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        db::initialize(&directory.db_path()).unwrap();
        let connection = db::open_project(&directory.db_path()).unwrap();
        (directory, connection)
    }

    fn enable_minimax(connection: &Connection, budget: f64) {
        settings::set_setting(connection, settings::MINIMAX_ENABLED_KEY, "true").unwrap();
        settings::set_setting(connection, settings::MINIMAX_MONTHLY_BUDGET_KEY, &budget.to_string()).unwrap();
    }

    /// 造一个可提交的缺口:active episode → 一条 confirmed revision → 一个
    /// narrative_chapters 章节 → 章节下的一条 story_gaps。
    fn seed_gap(connection: &Connection) -> i64 {
        let episode_id: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0))
            .unwrap();
        connection
            .execute(
                "INSERT INTO narrative_revisions(episode_id, kind, created_at)
                 VALUES (?1, 'confirmed', '2026-09-10T00:00:00Z')",
                [episode_id],
            )
            .unwrap();
        let revision_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO narrative_chapters(
                    episode_id, kind, title, \"order\", promoted, score, rationale, promotion_reason
                 ) VALUES (?1, 'atmosphere', '第一章', 0, 1, 0.9, 'r', 'p')",
                [episode_id],
            )
            .unwrap();
        let chapter_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO story_gaps(
                    episode_id, revision_id, chapter_id, slot, reason, status, detected_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'ATMOSPHERE', 'r', 'open',
                    '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')",
                params![episode_id, revision_id, chapter_id],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn minimal_draft(gap_id: i64) -> GenerationRequestDraft {
        GenerationRequestDraft {
            gap_id,
            retry_of: None,
            mode: "t2v".to_owned(),
            model: "MiniMax-H3-Max".to_owned(),
            resolution: "480P".to_owned(),
            duration_s: 4,
            ratio: Some("16:9".to_owned()),
            prompt: "测试提示词".to_owned(),
            refs: Vec::new(),
            estimated_cost_usd: 0.20,
            notes: Vec::new(),
        }
    }

    /// 直接插一条完整的历史请求行,不经过 `submit_request`——给
    /// `retry_generation`/轮询相关测试当"已经存在的旧行"用。
    fn insert_full_request(connection: &Connection, gap_id: i64, status: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO generation_requests(
                    gap_id, provider, model, mode, prompt, refs_json,
                    duration_s, resolution, ratio, estimated_cost_usd, status,
                    task_id, created_at, updated_at
                 ) VALUES (?1, 'minimax', 'MiniMax-H3-Max', 't2v', '测试提示词', '[]',
                    4, '480P', '16:9', 0.20, ?2, 'task-x',
                    strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![gap_id, status],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn disabled_provider_refuses_before_any_http() {
        with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
            let (_directory, mut connection) = open_project();
            let gap_id = seed_gap(&connection);
            // minimax_enabled 默认就是 'false',不用手动关。
            let error = submit_request(&mut connection, minimal_draft(gap_id)).unwrap_err();
            assert!(error.to_string().contains("未启用"), "错误信息应提示未启用：{error}");
            let count: i64 = connection
                .query_row("SELECT COUNT(*) FROM generation_requests", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 0, "被拒绝的请求不应该留下任何数据库行");
        });
    }

    #[test]
    fn budget_exhausted_refuses_before_any_http() {
        with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
            let (_directory, mut connection) = open_project();
            enable_minimax(&connection, 0.10);
            let gap_id = seed_gap(&connection);
            let mut draft = minimal_draft(gap_id);
            draft.estimated_cost_usd = 5.0;
            let error = submit_request(&mut connection, draft).unwrap_err();
            assert!(error.to_string().contains("预算"), "错误信息应提示预算熔断：{error}");
            let count: i64 = connection
                .query_row("SELECT COUNT(*) FROM generation_requests", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 0, "预算熔断必须发生在任何数据库写入/网络请求之前");
        });
    }

    /// 造一条"历史/在途"请求 + 它自己的账本行——`submit_request` 真实提交
    /// 时账本行和请求行是同一个事务里一起落的(见 `submit_request`),这里
    /// 直接手插两行模拟"这条请求已经提交过,占着预算"这个既成状态。
    fn insert_full_request_with_ledger(connection: &Connection, gap_id: i64, status: &str, cost_usd: f64) -> i64 {
        let request_id = insert_full_request(connection, gap_id, status);
        connection
            .execute(
                "UPDATE generation_requests SET estimated_cost_usd=?2 WHERE id=?1",
                params![request_id, cost_usd],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO generation_ledger(request_id, cost_usd, seconds, images, at)
                 VALUES (?1, ?2, 4, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![request_id, cost_usd],
            )
            .unwrap();
        request_id
    }

    /// 预算熔断的口径必须已经把"在途"(`submitted`/`queued`,还没轮询完)的
    /// 请求算进去——不是靠再对 `generation_requests.status` 单独求和相加
    /// (那会跟账本重复计数,见 `month_to_date_ledger_usd` 上的注释),而是
    /// 因为在途请求自己在提交那一刻就已经写过一行账本、天然被
    /// `month_to_date_ledger_usd` 的 SUM 覆盖。这里造一条几乎正好花完预算
    /// 的在途请求,断言"它自己单独一条"就足以让下一次提交被拒——不需要它
    /// 走到 `imported`/`failed` 才算数。
    #[test]
    fn a_single_in_flight_request_alone_can_exhaust_the_budget() {
        with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
            let (_directory, mut connection) = open_project();
            enable_minimax(&connection, 1.0);
            let gap_id = seed_gap(&connection);
            insert_full_request_with_ledger(&connection, gap_id, "submitted", 0.95);

            let mut draft = minimal_draft(gap_id);
            draft.estimated_cost_usd = 0.10;
            let error = submit_request(&mut connection, draft).unwrap_err();
            assert!(error.to_string().contains("预算"), "在途请求应该已经占住预算：{error}");

            let count_after: i64 = connection
                .query_row("SELECT COUNT(*) FROM generation_requests", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count_after, 1, "被拒绝的这次提交不应该新增任何请求行");
        });
    }

    /// 同上,但换成"单条在途请求自己不够花完预算,加上这次新请求的预估才会
    /// 超支"这个更贴近真实场景的组合。
    #[test]
    fn ledger_reservation_plus_new_estimate_together_exceed_budget() {
        with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
            let (_directory, mut connection) = open_project();
            enable_minimax(&connection, 1.0);
            let gap_id = seed_gap(&connection);
            // 单独 0.6 不会超支(< 1.0),必须叠加这次新请求的 0.5 才会。
            insert_full_request_with_ledger(&connection, gap_id, "queued", 0.60);

            let mut draft = minimal_draft(gap_id);
            draft.estimated_cost_usd = 0.50;
            let error = submit_request(&mut connection, draft).unwrap_err();
            assert!(error.to_string().contains("预算"), "叠加后应该超出预算：{error}");
        });
    }

    #[test]
    fn missing_api_key_refuses_before_any_http() {
        with_env(Some("http://127.0.0.1:9"), Some(""), || {
            let (_directory, mut connection) = open_project();
            enable_minimax(&connection, 100.0);
            let gap_id = seed_gap(&connection);
            let error = submit_request(&mut connection, minimal_draft(gap_id)).unwrap_err();
            assert!(error.to_string().contains("API Key"), "错误信息应提示未配置 API Key：{error}");
        });
    }

    #[test]
    fn archived_episode_gap_refuses_submission() {
        with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
            let (_directory, mut connection) = open_project();
            enable_minimax(&connection, 100.0);
            let gap_id = seed_gap(&connection);
            connection
                .execute("UPDATE episodes SET status='archived' WHERE status='active'", [])
                .unwrap();
            connection
                .execute(
                    "INSERT INTO episodes(title, theme, created_at, status, episode_number)
                     VALUES ('EP02', '', '2026-09-10T00:00:00Z', 'active', 2)",
                    [],
                )
                .unwrap();
            let error = submit_request(&mut connection, minimal_draft(gap_id)).unwrap_err();
            assert!(error.to_string().contains("封存"), "错误信息应提示 Episode 已封存：{error}");
        });
    }

    #[test]
    fn retry_creates_a_new_row_referencing_the_old_one() {
        with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
            let (_directory, mut connection) = open_project();
            enable_minimax(&connection, 100.0);
            let gap_id = seed_gap(&connection);
            let old_id = insert_full_request(&connection, gap_id, "failed");

            // base URL 打不通,这次重试必然在网络这一步失败——但我们要断言的是
            // 数据库形状,与这次网络调用成败无关。
            let _ = retry_generation(&mut connection, old_id);

            let new_id: i64 = connection
                .query_row(
                    "SELECT id FROM generation_requests WHERE retry_of = ?1",
                    [old_id],
                    |row| row.get(0),
                )
                .expect("retry 必须新开一行,retry_of 指向旧行");
            assert_ne!(new_id, old_id);

            let old_status: String = connection
                .query_row("SELECT status FROM generation_requests WHERE id=?1", [old_id], |row| row.get(0))
                .unwrap();
            assert_eq!(old_status, "failed", "旧行必须原样不动");
        });
    }

    #[test]
    fn backoff_delay_follows_10_20_40_capped_at_300() {
        assert_eq!(backoff_delay_seconds(1), 10);
        assert_eq!(backoff_delay_seconds(2), 20);
        assert_eq!(backoff_delay_seconds(3), 40);
        assert_eq!(backoff_delay_seconds(4), 80);
        assert_eq!(backoff_delay_seconds(5), 160);
        assert_eq!(backoff_delay_seconds(6), 300);
        assert_eq!(backoff_delay_seconds(50), 300);
    }

    #[test]
    fn poll_backs_off_exponentially_and_gives_up_after_two_hours() {
        let (_directory, mut connection) = open_project();
        let gap_id = seed_gap(&connection);
        let request_id = insert_full_request(&connection, gap_id, "queued");
        let payload = format!("{{\"request_id\":{request_id}}}");
        let job_id = jobs::enqueue(&mut connection, "generation_poll", &payload, &request_id.to_string()).unwrap();
        connection
            .execute("UPDATE jobs SET status='running', attempt=1 WHERE id=?1", [job_id])
            .unwrap();
        let job = Job {
            id: job_id,
            kind: "generation_poll".to_owned(),
            payload: payload.clone(),
            status: jobs::JobStatus::Running,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        };
        let request = GenerationRequestRow {
            id: request_id,
            gap_id,
            task_id: Some("task-x".to_owned()),
            status: "queued".to_owned(),
        };

        let before: (String, String) = connection
            .query_row("SELECT next_attempt_at, created_at FROM jobs WHERE id=?1", [job_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        requeue_or_timeout(&mut connection, &job, &request).unwrap();
        let (status, next_attempt_at, attempt): (String, String, i64) = connection
            .query_row(
                "SELECT status, next_attempt_at, attempt FROM jobs WHERE id=?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "pending");
        assert!(next_attempt_at > before.0, "重排必须把 next_attempt_at 往后推");
        assert_eq!(attempt, 1, "requeue_or_timeout 本身不改 attempt,attempt 由认领时的 claim 递增");

        // 把提交时间拨回 3 小时前,模拟总耗时已经超过 2 小时上限。
        connection
            .execute(
                "UPDATE generation_requests SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours')
                 WHERE id=?1",
                [request_id],
            )
            .unwrap();
        connection
            .execute("UPDATE jobs SET status='running' WHERE id=?1", [job_id])
            .unwrap();
        requeue_or_timeout(&mut connection, &job, &request).unwrap();

        let (final_status, error): (String, Option<String>) = connection
            .query_row(
                "SELECT status, error FROM generation_requests WHERE id=?1",
                [request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(final_status, "failed");
        assert_eq!(error.as_deref(), Some(POLL_TIMEOUT_REASON));
        let gap_status: String = connection
            .query_row("SELECT status FROM story_gaps WHERE id=?1", [gap_id], |row| row.get(0))
            .unwrap();
        assert_eq!(gap_status, "open", "超时失败必须把缺口退回 open");
        let job_status: String = connection.query_row("SELECT status FROM jobs WHERE id=?1", [job_id], |row| row.get(0)).unwrap();
        assert_eq!(job_status, "done");
    }

    #[test]
    fn already_terminal_request_is_a_no_op_for_poll() {
        let (_directory, mut connection) = open_project();
        let gap_id = seed_gap(&connection);
        let request_id = insert_full_request(&connection, gap_id, "imported");
        let payload = format!("{{\"request_id\":{request_id}}}");
        let job_id = jobs::enqueue(&mut connection, "generation_poll", &payload, &request_id.to_string()).unwrap();
        connection
            .execute("UPDATE jobs SET status='running', attempt=1 WHERE id=?1", [job_id])
            .unwrap();
        let job = Job {
            id: job_id,
            kind: "generation_poll".to_owned(),
            payload,
            status: jobs::JobStatus::Running,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        };
        run_poll_job(&mut connection, &job, _directory.path()).unwrap();
        let job_status: String = connection.query_row("SELECT status FROM jobs WHERE id=?1", [job_id], |row| row.get(0)).unwrap();
        assert_eq!(job_status, "done");
        let request_status: String = connection
            .query_row("SELECT status FROM generation_requests WHERE id=?1", [request_id], |row| row.get(0))
            .unwrap();
        assert_eq!(request_status, "imported", "已经是终态的请求不应该被 poll 改动");
    }

    #[test]
    fn generated_root_for_db_is_a_sibling_of_the_project_database() {
        let db_path = Path::new("/tmp/some-project/project.db");
        assert_eq!(generated_root_for_db(db_path), Path::new("/tmp/some-project/generated"));
    }

    // -------------------------------------------------------------
    // R7 Task 5 复审 P1-1:同一缺口的幂等闸(钱)
    // -------------------------------------------------------------

    /// 缺口上已经有一条在途请求时,第二次提交必须在写任何行、打任何网络
    /// 请求之前就被挡住——否则一次重复点击就是两条请求行、两条账本行、
    /// 两次真实计费。
    #[test]
    fn submit_refuses_a_second_request_while_one_is_in_flight() {
        for in_flight_status in ["submitted", "queued", "succeeded"] {
            with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
                let (_directory, mut connection) = open_project();
                enable_minimax(&connection, 100.0);
                let gap_id = seed_gap(&connection);
                insert_full_request(&connection, gap_id, in_flight_status);

                let error = submit_request(&mut connection, minimal_draft(gap_id)).unwrap_err();
                assert!(
                    matches!(error, CoreError::GenerationInFlight),
                    "{in_flight_status} 状态下重复提交必须被幂等闸挡住，实际：{error}"
                );

                let rows: i64 = connection
                    .query_row("SELECT COUNT(*) FROM generation_requests", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(rows, 1, "{in_flight_status}：被拒的提交不能新增请求行");
                let ledger: i64 = connection
                    .query_row("SELECT COUNT(*) FROM generation_ledger", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(ledger, 0, "{in_flight_status}：被拒的提交不能新增账本行");
            });
        }
    }

    /// 终态(失败/取消/已导入)不再挡新提交——失败之后业主必须还能再来一次。
    #[test]
    fn submit_allows_a_new_request_after_the_previous_one_is_terminal() {
        with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
            let (_directory, mut connection) = open_project();
            enable_minimax(&connection, 100.0);
            let gap_id = seed_gap(&connection);
            insert_full_request(&connection, gap_id, "failed");

            // base URL 打不通,提交必然在网络那一步失败——但要断言的是幂等闸
            // 放行了它,也就是**新开了**一行请求。
            let _ = submit_request(&mut connection, minimal_draft(gap_id));
            let rows: i64 = connection
                .query_row("SELECT COUNT(*) FROM generation_requests", [], |row| row.get(0))
                .unwrap();
            assert_eq!(rows, 2, "上一条已终态时必须允许再提交一次");
        });
    }

    /// 重新生成只对失败/取消开放:已导入的请求再点重试会白花一次钱。
    #[test]
    fn retry_refuses_when_the_target_is_not_failed_or_cancelled() {
        for status in ["submitted", "queued", "succeeded", "imported"] {
            with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
                let (_directory, mut connection) = open_project();
                enable_minimax(&connection, 100.0);
                let gap_id = seed_gap(&connection);
                let old_id = insert_full_request(&connection, gap_id, status);

                let error = retry_generation(&mut connection, old_id).unwrap_err();
                assert!(
                    matches!(error, CoreError::GenerationNotRetryable(id) if id == old_id),
                    "{status} 状态不该允许重试，实际：{error}"
                );
                let rows: i64 = connection
                    .query_row("SELECT COUNT(*) FROM generation_requests", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(rows, 1, "{status}：被拒的重试不能新增请求行");
            });
        }
    }

    // -------------------------------------------------------------
    // R7 Task 5 复审 P2-1:预留金泄漏
    // -------------------------------------------------------------

    /// 建任务这一步就失败(网络不通/鉴权/两次都被拒)时,这条请求从来没有
    /// 到达平台,平台不会为它扣一分钱——账本上的预留必须被退回,否则每次
    /// 失败的提交都在永久吃掉本月预算。
    #[test]
    fn submit_failure_before_the_api_releases_the_reservation() {
        with_env(Some("http://127.0.0.1:9"), Some("test-key"), || {
            let (_directory, mut connection) = open_project();
            enable_minimax(&connection, 100.0);
            let gap_id = seed_gap(&connection);

            let error = submit_request(&mut connection, minimal_draft(gap_id)).unwrap_err();
            assert!(!matches!(error, CoreError::GenerationInFlight));

            let request_id: i64 = connection
                .query_row("SELECT id FROM generation_requests WHERE gap_id=?1", [gap_id], |row| row.get(0))
                .unwrap();
            let status: String = connection
                .query_row("SELECT status FROM generation_requests WHERE id=?1", [request_id], |row| row.get(0))
                .unwrap();
            assert_eq!(status, "failed");

            let ledger: i64 = connection
                .query_row("SELECT COUNT(*) FROM generation_ledger WHERE request_id=?1", [request_id], |row| row.get(0))
                .unwrap();
            assert_eq!(ledger, 0, "没打到平台的请求不能占用预算");
            let spent = month_to_date_ledger_usd(&connection).unwrap();
            assert_eq!(spent, 0.0, "本月已用金额必须回到 0");
        });
    }

    /// 反过来:任务已经被平台接受(有 `task_id`),之后远端报失败/超时——钱
    /// 可能已经花了,预留必须留在账本上,不能退。
    #[test]
    fn remote_failure_after_acceptance_keeps_the_reservation() {
        let (_directory, mut connection) = open_project();
        let gap_id = seed_gap(&connection);
        let request_id = insert_full_request_with_ledger(&connection, gap_id, "queued", 0.20);

        fail_request(&mut connection, request_id, gap_id, "远端报失败", Reservation::Keep).unwrap();

        let ledger: i64 = connection
            .query_row("SELECT COUNT(*) FROM generation_ledger WHERE request_id=?1", [request_id], |row| row.get(0))
            .unwrap();
        assert_eq!(ledger, 1, "已被平台接受的请求,预留必须留着——钱可能真的花了");
    }

    /// 末帧要往回退**整整一帧**:直接用 `duration_ticks`(或 `-1 tick`)会让
    /// `-ss` 落在最后一帧的 PTS 之后,ffmpeg 一个包都读不到、抽帧直接失败
    /// (1s@10fps 的片子 `-ss 0.999` 实测退出码 234),整条 fl2v 就悄悄退化成
    /// 了 i2v。
    #[test]
    fn one_frame_in_ticks_backs_off_a_whole_frame() {
        // tb=1/1000(毫秒),10 fps → 一帧 100ms = 100 ticks。
        assert_eq!(one_frame_in_ticks(1, 1000, Some(10), Some(1)), 100);
        // 23.976 fps,tb=1001/24000 → 一帧正好 1 个 tick。
        assert_eq!(one_frame_in_ticks(1001, 24_000, Some(24_000), Some(1001)), 1);
        // fps 未知 → 按 10 fps 保守退 100ms。
        assert_eq!(one_frame_in_ticks(1, 1000, None, None), 100);
        // 坏数据不能除以零,也不能返回 0(返回 0 等于没退)。
        assert_eq!(one_frame_in_ticks(1, 1000, Some(0), Some(0)), 100);
        assert_eq!(one_frame_in_ticks(0, 0, Some(30), Some(1)), 1);
        assert_eq!(one_frame_in_ticks(1, 30, Some(30), Some(1)), 1);
    }

    /// 只读窗口(第二个窗口打开同一个工程)不能提交/重试/取消生成请求。
    #[test]
    fn guard_writable_refuses_read_only_window() {
        assert!(guard_writable(true).is_err());
        assert!(guard_writable(false).is_ok());
    }
}
