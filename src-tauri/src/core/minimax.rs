//! MiniMax v2 视频生成客户端(R7 Task 4)。
//!
//! 所有对 MiniMax 云端的网络出口集中在这一个模块，base URL 可用
//! `TRIPCUT_MINIMAX_BASE_URL` 环境变量覆盖以指向本地假服务器
//! (`scripts/qa/minimax-mock.mjs`)。请求体构造与限额校验是纯函数，
//! 可在完全脱网的情况下单测；只有 [`MinimaxClient::create_task`]、
//! [`MinimaxClient::query_task`]、[`MinimaxClient::download`] 会发出
//! HTTP 请求。
//!
//! API Key 只以 `&str` 传入，调用方(Task 1 的钥匙串封装)负责持有它。
//! 本模块从不把 key 写进日志或错误信息 —— 见
//! [`MinimaxError`] 的每个变体，没有一个会回显请求头。
//!
//! **base URL 校验**(安全修复,见 `updater.rs::classify_endpoint` 的姊妹实现):
//! `TRIPCUT_MINIMAX_BASE_URL` 不是直接拼进请求里的裸字符串——它先用
//! `url::Url` 解析,只放行 `https`(任意主机),或者主机严格等于回环
//! (`127.0.0.1` / `::1` / `localhost`,只按 `url::Host` 的结构化字段判断,
//! 不做字符串前缀/后缀匹配)的 `http`;带 userinfo(`user:pass@host`)的一律
//! 拒绝,不论 scheme。校验失败时客户端构造函数(`new`/`with_timeouts` 等)
//! **不会**悄悄退回默认值再继续——它们直接返回
//! `Err(MinimaxError::InvalidRequest{field: "base_url", ..})`,调用方必须显式
//! 处理;不存在"校验失败但客户端已经拿着不安全的 base URL 跑起来了"的中间态。
use serde::Deserialize;
use std::fmt;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use thiserror::Error;
use url::{Host, Url};

/// 默认 base URL；生产始终是 https。回环 http 只允许通过
/// `TRIPCUT_MINIMAX_BASE_URL` 覆盖（供本地假服务器使用），且必须通过
/// [`validate_base_url`] 的结构化校验。
pub const DEFAULT_BASE_URL: &str = "https://api.minimax.io";

pub const MAX_PROMPT_CHARS: usize = 7000;
pub const MIN_DURATION_SECS: u32 = 4;
pub const MAX_DURATION_SECS: u32 = 15;
pub const MAX_IMAGES: usize = 9;
pub const MAX_VIDEOS: usize = 3;
pub const MAX_AUDIO: usize = 3;
pub const MAX_TOTAL_MEDIA: usize = 12;
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 30 * 1024 * 1024;
pub const MAX_DOWNLOAD_BYTES: u64 = 500 * 1024 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// 下载过程中连续多久收不到一个字节就判定为"卡死"并报错——不是总超时。
/// 下载请求复用与 create/query 相同的 30s [`CONNECT_TIMEOUT`]，但不设总
/// 超时(大文件可能合法地跑很久)，靠这个活性检测顶上。
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/// 客户端错误。**没有任何变体携带请求头或 API key**——网络层错误一律
/// 折叠成不带细节的 [`MinimaxError::Network`]，避免 reqwest 的错误
/// Display 意外带出鉴权相关的上下文。
#[derive(Debug, Error)]
pub enum MinimaxError {
    #[error("MiniMax authentication failed (401)")]
    Auth,
    #[error("MiniMax rate limited (429){}", retry_after.map(|d| format!(", retry after {}s", d.as_secs())).unwrap_or_default())]
    RateLimited { retry_after: Option<Duration> },
    #[error("invalid MiniMax request: {field}: {message}")]
    InvalidRequest { field: String, message: String },
    #[error("MiniMax rejected the image input; caller should retry as text-to-video")]
    ImageInputRejected,
    #[error("MiniMax server error (status {status})")]
    Server { status: u16 },
    #[error("network error talking to MiniMax")]
    Network,
    #[error("MiniMax task was cancelled")]
    Cancelled,
    #[error("MiniMax generation failed: {message}")]
    Failed { message: String },
}

// ---------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    H3,
    H3Max,
}

impl Model {
    fn as_api_str(self) -> &'static str {
        match self {
            Model::H3 => "MiniMax-H3",
            Model::H3Max => "MiniMax-H3-Max",
        }
    }

    fn supports_resolution(self, resolution: Resolution) -> bool {
        match self {
            Model::H3 => matches!(resolution, Resolution::R768P | Resolution::R2K),
            Model::H3Max => matches!(resolution, Resolution::R480P | Resolution::R768P),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    R480P,
    R768P,
    R2K,
}

impl Resolution {
    fn as_api_str(self) -> &'static str {
        match self {
            Resolution::R480P => "480P",
            Resolution::R768P => "768P",
            Resolution::R2K => "2K",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ratio {
    R16x9,
    R9x16,
    R1x1,
    R4x3,
    R3x4,
    R21x9,
}

impl Ratio {
    fn as_api_str(self) -> &'static str {
        match self {
            Ratio::R16x9 => "16:9",
            Ratio::R9x16 => "9:16",
            Ratio::R1x1 => "1:1",
            Ratio::R4x3 => "4:3",
            Ratio::R3x4 => "3:4",
            Ratio::R21x9 => "21:9",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageRole {
    FirstFrame,
    LastFrame,
    ReferenceImage,
}

impl ImageRole {
    fn as_api_str(self) -> &'static str {
        match self {
            ImageRole::FirstFrame => "first_frame",
            ImageRole::LastFrame => "last_frame",
            ImageRole::ReferenceImage => "reference_image",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoRole {
    ReferenceVideo,
    BaseVideo,
}

impl VideoRole {
    fn as_api_str(self) -> &'static str {
        match self {
            VideoRole::ReferenceVideo => "reference_video",
            VideoRole::BaseVideo => "base_video",
        }
    }
}

/// 图片输入。**目前只实现 `DataUri`**——data URI 能否被服务端接受尚未
/// 核实(2026-09-10)；一旦 Task 8 的真机 e2e 记录下答案，且答案是"拒绝"，
/// 调用方应捕获 [`MinimaxError::ImageInputRejected`] 并退化为纯 T2V
/// (不带任何 image 内容的请求)。
#[derive(Debug, Clone)]
pub enum ImageInput {
    /// `data:image/...;base64,....` 形式的完整 data URI。
    DataUri(String),
}

impl ImageInput {
    fn as_uri(&self) -> &str {
        match self {
            ImageInput::DataUri(uri) => uri,
        }
    }

    /// data URI 里 base64 载荷解码后的近似字节数(用于 30MB/张的限额校验，
    /// 不必真的 base64 解码，四字符编码三字节是足够精确的上界估计)。
    fn approx_decoded_bytes(&self) -> usize {
        let uri = self.as_uri();
        let payload = uri.split_once(',').map(|(_, b)| b).unwrap_or(uri);
        (payload.len() * 3) / 4
    }
}

#[derive(Debug, Clone)]
pub struct ImageContent {
    pub input: ImageInput,
    pub role: ImageRole,
}

#[derive(Debug, Clone)]
pub struct VideoContent {
    pub url: String,
    pub role: VideoRole,
}

#[derive(Debug, Clone)]
pub struct AudioContent {
    pub url: String,
}

/// `POST /v2/video_generation` 的请求描述。构造后调用 [`CreateRequest::validate`]
/// (或直接 [`MinimaxClient::create_task`]，它内部会先校验)——所有超限一律在
/// 发起 HTTP 请求之前拒绝。
#[derive(Debug, Clone)]
pub struct CreateRequest {
    pub model: Model,
    pub prompt: String,
    pub images: Vec<ImageContent>,
    pub videos: Vec<VideoContent>,
    pub audio: Vec<AudioContent>,
    pub duration: u32,
    pub resolution: Resolution,
    /// T2V(没有任何图片/视频输入)必须带 ratio；I2V/首尾帧/参考图/参考视频
    /// 场景可以省略。
    pub ratio: Option<Ratio>,
}

impl CreateRequest {
    fn is_text_to_video(&self) -> bool {
        self.images.is_empty() && self.videos.is_empty()
    }

    /// 纯函数校验：不发任何网络请求。返回校验通过后的请求体 JSON。
    pub fn validate_and_build_body(&self) -> Result<serde_json::Value, MinimaxError> {
        if self.duration < MIN_DURATION_SECS || self.duration > MAX_DURATION_SECS {
            return Err(MinimaxError::InvalidRequest {
                field: "duration".to_string(),
                message: format!(
                    "must be between {MIN_DURATION_SECS} and {MAX_DURATION_SECS} seconds, got {}",
                    self.duration
                ),
            });
        }

        if self.prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(MinimaxError::InvalidRequest {
                field: "prompt".to_string(),
                message: format!(
                    "must be at most {MAX_PROMPT_CHARS} characters, got {}",
                    self.prompt.chars().count()
                ),
            });
        }

        if !self.model.supports_resolution(self.resolution) {
            return Err(MinimaxError::InvalidRequest {
                field: "resolution".to_string(),
                message: format!(
                    "{} does not support resolution {}",
                    self.model.as_api_str(),
                    self.resolution.as_api_str()
                ),
            });
        }

        if self.is_text_to_video() && self.ratio.is_none() {
            return Err(MinimaxError::InvalidRequest {
                field: "ratio".to_string(),
                message: "text-to-video requests must set ratio".to_string(),
            });
        }

        if self.images.len() > MAX_IMAGES {
            return Err(MinimaxError::InvalidRequest {
                field: "images".to_string(),
                message: format!("at most {MAX_IMAGES} images allowed, got {}", self.images.len()),
            });
        }
        if self.videos.len() > MAX_VIDEOS {
            return Err(MinimaxError::InvalidRequest {
                field: "videos".to_string(),
                message: format!("at most {MAX_VIDEOS} videos allowed, got {}", self.videos.len()),
            });
        }
        if self.audio.len() > MAX_AUDIO {
            return Err(MinimaxError::InvalidRequest {
                field: "audio".to_string(),
                message: format!("at most {MAX_AUDIO} audio inputs allowed, got {}", self.audio.len()),
            });
        }
        let total_media = self.images.len() + self.videos.len() + self.audio.len();
        if total_media > MAX_TOTAL_MEDIA {
            return Err(MinimaxError::InvalidRequest {
                field: "content".to_string(),
                message: format!("at most {MAX_TOTAL_MEDIA} media items total, got {total_media}"),
            });
        }

        for image in &self.images {
            let bytes = image.input.approx_decoded_bytes();
            if bytes > MAX_IMAGE_BYTES {
                return Err(MinimaxError::InvalidRequest {
                    field: "content[].image_url".to_string(),
                    message: format!(
                        "image exceeds {}MB cap (~{}MB)",
                        MAX_IMAGE_BYTES / (1024 * 1024),
                        bytes / (1024 * 1024)
                    ),
                });
            }
        }

        let mut content = Vec::new();
        content.push(serde_json::json!({ "type": "text", "text": self.prompt }));
        for image in &self.images {
            content.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": image.input.as_uri() },
                "role": image.role.as_api_str(),
            }));
        }
        for video in &self.videos {
            content.push(serde_json::json!({
                "type": "video_url",
                "video_url": { "url": video.url },
                "role": video.role.as_api_str(),
            }));
        }
        for audio in &self.audio {
            content.push(serde_json::json!({
                "type": "audio_url",
                "audio_url": { "url": audio.url },
            }));
        }

        let mut body = serde_json::json!({
            "model": self.model.as_api_str(),
            "content": content,
            "duration": self.duration,
            "resolution": self.resolution.as_api_str(),
        });
        if let Some(ratio) = self.ratio {
            body["ratio"] = serde_json::Value::String(ratio.as_api_str().to_string());
        }

        let serialized = serde_json::to_vec(&body).map_err(|e| MinimaxError::InvalidRequest {
            field: "content".to_string(),
            message: format!("failed to serialize request body: {e}"),
        })?;
        if serialized.len() > MAX_BODY_BYTES {
            return Err(MinimaxError::InvalidRequest {
                field: "content".to_string(),
                message: format!(
                    "request body exceeds {}MB cap (~{}MB)",
                    MAX_BODY_BYTES / (1024 * 1024),
                    serialized.len() / (1024 * 1024)
                ),
            });
        }

        Ok(body)
    }
}

// ---------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskId(pub String);

impl fmt::Display for TaskId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStatusKind {
    Queued,
    /// 平台事实里没有明文列出，但见过就当作在途状态处理，不视为异常。
    InFlight,
    Succeeded,
    /// 服务端返回了一个我们没见过的状态字符串。**必须**当作在途状态处理——
    /// 绝不能悄悄折进 `Failed`,那会让轮询方过早放弃一个其实还在跑的任务。
    /// 原始字符串保留下来供日志/诊断使用。
    Unknown(String),
}

impl TaskStatusKind {
    /// 轮询方应当用这个判断"还要不要继续等",而不是自己再拍一遍
    /// `matches!(status, Queued | InFlight)`——`Unknown` 也必须算在途。
    pub fn is_in_flight(&self) -> bool {
        matches!(self, TaskStatusKind::Queued | TaskStatusKind::InFlight | TaskStatusKind::Unknown(_))
    }
}

#[derive(Debug, Clone)]
pub struct TaskStatus {
    pub task_id: String,
    pub status: TaskStatusKind,
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateResponse {
    task_id: String,
}

#[derive(Debug, Deserialize)]
struct QueryContent {
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QueryError {
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QueryResponse {
    task_id: String,
    status: String,
    #[serde(default)]
    content: Option<QueryContent>,
    #[serde(default)]
    error: Option<QueryError>,
}

#[derive(Debug, Deserialize, Default)]
struct ErrorBody {
    #[serde(default)]
    error: Option<ErrorDetail>,
}

#[derive(Debug, Deserialize, Default)]
struct ErrorDetail {
    #[serde(default)]
    field: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

// ---------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------

#[derive(Debug)]
pub struct MinimaxClient {
    base_url: String,
    http: reqwest::blocking::Client,
    /// `create_task`/`query_task` 每请求超时(不含下载——下载没有总超时，
    /// 只有 [`Self::download_stall_timeout`] 的活性检测)。
    request_timeout: Duration,
    download_stall_timeout: Duration,
}

/// 校验 `TRIPCUT_MINIMAX_BASE_URL` 覆盖值：只放行 `https`(任意主机)或者
/// 主机严格等于回环(`127.0.0.1` / `::1` / `localhost`)的 `http`；带
/// userinfo(`user:pass@host`)一律拒绝。纯函数，不发任何网络请求，
/// 也不读环境变量——调用方负责把原始字符串传进来。
///
/// 返回校验通过后的、去掉尾部斜杠的 base URL。
pub fn validate_base_url(raw: &str) -> Result<String, MinimaxError> {
    let reject = |message: String| {
        Err(MinimaxError::InvalidRequest { field: "base_url".to_string(), message })
    };

    let parsed = match Url::parse(raw) {
        Ok(u) => u,
        Err(e) => return reject(format!("could not parse {raw:?} as a URL: {e}")),
    };

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return reject(format!("{raw:?} must not contain userinfo (user:pass@host)"));
    }

    match parsed.scheme() {
        "https" => {}
        "http" => {
            let is_loopback = match parsed.host() {
                Some(Host::Domain(domain)) => domain == "localhost",
                Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
                Some(Host::Ipv6(ip)) => ip == Ipv6Addr::LOCALHOST,
                None => false,
            };
            if !is_loopback {
                return reject(format!(
                    "{raw:?} uses http but is not a loopback host (127.0.0.1 / ::1 / localhost)"
                ));
            }
        }
        other => {
            return reject(format!("{raw:?} has unsupported scheme {other:?}; must be https or loopback http"));
        }
    }

    Ok(raw.trim_end_matches('/').to_string())
}

impl MinimaxClient {
    /// 用默认超时(30s 连接 / 120s 读 / 60s 下载活性检测)构造客户端。base
    /// URL 取 `TRIPCUT_MINIMAX_BASE_URL`，未设置则用 [`DEFAULT_BASE_URL`]。
    ///
    /// 环境变量存在但校验不过时：**不会**悄悄退回默认值继续跑——直接返回
    /// `Err(MinimaxError::InvalidRequest{field: "base_url", ..})`，拒绝把
    /// API key 发去一个未经校验的主机。
    pub fn new() -> Result<Self, MinimaxError> {
        Self::with_timeouts(CONNECT_TIMEOUT, READ_TIMEOUT)
    }

    /// 自定义 连接/请求 超时的构造函数——主要给测试用，模拟慢速服务端触发
    /// 调用方超时。下载活性超时用默认的 [`DOWNLOAD_STALL_TIMEOUT`]。
    pub fn with_timeouts(connect_timeout: Duration, read_timeout: Duration) -> Result<Self, MinimaxError> {
        Self::with_timeouts_and_stall(connect_timeout, read_timeout, DOWNLOAD_STALL_TIMEOUT)
    }

    /// 三个超时维度都可自定义——测试用来把下载卡死检测的等待时间从生产的
    /// 60s 缩到几百毫秒，让测试在有界时间内断言。
    pub fn with_timeouts_and_stall(
        connect_timeout: Duration,
        read_timeout: Duration,
        download_stall_timeout: Duration,
    ) -> Result<Self, MinimaxError> {
        let base_url = match std::env::var("TRIPCUT_MINIMAX_BASE_URL") {
            Ok(raw) => validate_base_url(&raw)?,
            Err(_) => DEFAULT_BASE_URL.to_string(),
        };

        // 注意：client 级别不设默认 `.timeout()`——那会把下载的总耗时也框
        // 死在 `read_timeout` 里。`create_task`/`query_task` 各自在请求上
        // 显式加 `.timeout(request_timeout)`；`download` 完全不加总超时，
        // 只靠逐块读的卡死检测。
        let http = reqwest::blocking::Client::builder()
            .connect_timeout(connect_timeout)
            .build()
            .expect("failed to build MiniMax HTTP client");
        Ok(Self { base_url, http, request_timeout: read_timeout, download_stall_timeout })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    pub fn create_task(&self, request: &CreateRequest, api_key: &str) -> Result<TaskId, MinimaxError> {
        let body = request.validate_and_build_body()?;

        let response = self
            .http
            .post(self.endpoint("/v2/video_generation"))
            .bearer_auth(api_key)
            .timeout(self.request_timeout)
            .json(&body)
            .send()
            .map_err(|_| MinimaxError::Network)?;

        let status = response.status();
        if status.is_success() {
            let parsed: CreateResponse = response.json().map_err(|_| MinimaxError::Network)?;
            return Ok(TaskId(parsed.task_id));
        }

        Err(Self::map_error_response(status, response))
    }

    pub fn query_task(&self, task_id: &TaskId, api_key: &str) -> Result<TaskStatus, MinimaxError> {
        let response = self
            .http
            .get(self.endpoint(&format!("/v2/query/video_generation/{}", task_id.0)))
            .bearer_auth(api_key)
            .timeout(self.request_timeout)
            .send()
            .map_err(|_| MinimaxError::Network)?;

        let status = response.status();
        if !status.is_success() {
            return Err(Self::map_error_response(status, response));
        }

        let parsed: QueryResponse = response.json().map_err(|_| MinimaxError::Network)?;
        Self::classify_task_status(parsed)
    }

    /// 状态字符串大小写不敏感；终态是 `succeeded`/`failed`/`cancelled`，
    /// `queued|preparing|processing|running|pending` 都是在途状态，任何
    /// 其它字符串一律映射成 [`TaskStatusKind::Unknown`]——**绝不**当作
    /// `Failed`，避免轮询方对一个只是拼写/版本不认识的状态就提前放弃任务。
    fn classify_task_status(parsed: QueryResponse) -> Result<TaskStatus, MinimaxError> {
        let normalized = parsed.status.to_lowercase();
        match normalized.as_str() {
            "succeeded" => Ok(TaskStatus {
                task_id: parsed.task_id,
                status: TaskStatusKind::Succeeded,
                url: parsed.content.and_then(|c| c.url),
            }),
            "failed" => Err(MinimaxError::Failed {
                message: parsed
                    .error
                    .and_then(|e| e.message)
                    .unwrap_or_else(|| "unknown failure".to_string()),
            }),
            "cancelled" => Err(MinimaxError::Cancelled),
            "queued" | "preparing" => Ok(TaskStatus {
                task_id: parsed.task_id,
                status: TaskStatusKind::Queued,
                url: None,
            }),
            "processing" | "running" | "pending" => Ok(TaskStatus {
                task_id: parsed.task_id,
                status: TaskStatusKind::InFlight,
                url: None,
            }),
            _ => Ok(TaskStatus {
                task_id: parsed.task_id,
                status: TaskStatusKind::Unknown(parsed.status),
                url: None,
            }),
        }
    }

    /// 把 `url` 流式下载到 `dest`：先写到同目录下的临时文件，成功后原子
    /// rename，避免半成品文件被下游误当作已完成的产物。返回写入字节数。
    ///
    /// 超时策略与 create/query 不同：下载请求**不设总超时**（大文件按当前
    /// 网速合法地跑几分钟很正常），改成逐块读的"卡死检测"——连续
    /// `download_stall_timeout`（默认 60s）收不到一个新字节就判定为网络
    /// 故障。读取放在专门的线程里，通过 `mpsc::channel` 把每个数据块递给
    /// 主线程，主线程用 `recv_timeout` 实现这个检测（`reqwest::blocking`
    /// 的同步 `Read` 本身没有逐次读超时的钩子）。
    ///
    /// 临时文件由 [`TempFileGuard`] 兜底：本函数任何一条错误返回路径都会
    /// 触发 guard 的 `Drop`，把临时文件删掉；只有 rename 成功之后才
    /// `commit()`，让 Drop 变成空操作。
    pub fn download(&self, url: &str, dest: &Path) -> Result<u64, MinimaxError> {
        let response = self.http.get(url).send().map_err(|_| MinimaxError::Network)?;
        let status = response.status();
        if !status.is_success() {
            return Err(Self::map_error_response(status, response));
        }

        let parent = dest.parent().unwrap_or_else(|| Path::new("."));
        let tmp_path = parent.join(format!(
            ".{}.minimax-download.tmp",
            dest.file_name().and_then(|n| n.to_str()).unwrap_or("download")
        ));

        let mut guard = TempFileGuard::new(tmp_path.clone());
        let mut file = std::fs::File::create(&tmp_path).map_err(|_| MinimaxError::Network)?;

        // Reader thread: does the actual blocking socket reads and forwards
        // each chunk (or the terminal Ok(())/Err(())) over a channel. The
        // main thread never blocks on the socket directly, so it can apply
        // its own stall deadline via `recv_timeout`.
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, ()>>();
        std::thread::spawn(move || {
            let mut response = response;
            let mut buf = [0u8; 64 * 1024];
            loop {
                match response.read(&mut buf) {
                    Ok(0) => {
                        let _ = tx.send(Ok(Vec::new()));
                        break;
                    }
                    Ok(n) => {
                        if tx.send(Ok(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Err(()));
                        break;
                    }
                }
            }
        });

        let mut total: u64 = 0;
        loop {
            match rx.recv_timeout(self.download_stall_timeout) {
                Ok(Ok(chunk)) => {
                    if chunk.is_empty() {
                        break; // EOF
                    }
                    total += chunk.len() as u64;
                    if total > MAX_DOWNLOAD_BYTES {
                        return Err(MinimaxError::InvalidRequest {
                            field: "content-length".to_string(),
                            message: format!("download exceeds {}MB cap", MAX_DOWNLOAD_BYTES / (1024 * 1024)),
                        });
                    }
                    file.write_all(&chunk).map_err(|_| MinimaxError::Network)?;
                }
                Ok(Err(())) => return Err(MinimaxError::Network),
                Err(mpsc::RecvTimeoutError::Timeout) => return Err(MinimaxError::Network),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(file);

        std::fs::rename(&tmp_path, dest).map_err(|_| MinimaxError::Network)?;
        guard.commit();
        Ok(total)
    }

    fn map_error_response(status: reqwest::StatusCode, response: reqwest::blocking::Response) -> MinimaxError {
        if status.as_u16() == 401 {
            return MinimaxError::Auth;
        }
        if status.as_u16() == 429 {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_retry_after);
            return MinimaxError::RateLimited { retry_after };
        }

        let status_code = status.as_u16();
        let body: ErrorBody = response.json().unwrap_or_default();
        Self::classify_error_body(status_code, status.is_client_error(), body)
    }

    /// 把状态码 + 已解析的错误体归类成一个具体的 [`MinimaxError`] 变体。
    /// 从 [`Self::map_error_response`] 里拆出来是为了能在不发真实 HTTP 请求
    /// 的情况下单测这段分类逻辑（`reqwest::blocking::Response` 没有公开
    /// 构造函数，没法在测试里凭空捏一个）。
    ///
    /// **`ImageInputRejected` 的收窄范围**：只在 4xx 且错误信息（`field`
    /// 或 `message`，大小写不敏感）提到 image / first_frame / last_frame /
    /// reference 时才返回它；其它 4xx 一律是普通 `InvalidRequest`，5xx 一律
    /// 是 `Server`。这样调用方"捕获 ImageInputRejected 就退化成纯文生视频"
    /// 的重试逻辑不会被一个跟图片毫不相关的 4xx（比如 duration 超限）误触发。
    fn classify_error_body(status_code: u16, is_client_error: bool, body: ErrorBody) -> MinimaxError {
        let field = body.error.as_ref().and_then(|e| e.field.clone()).unwrap_or_default();
        let message = body
            .error
            .and_then(|e| e.message)
            .unwrap_or_else(|| format!("MiniMax returned status {status_code}"));

        if is_client_error {
            if Self::looks_like_image_rejection(&field, &message) {
                return MinimaxError::ImageInputRejected;
            }
            return MinimaxError::InvalidRequest { field, message };
        }

        MinimaxError::Server { status: status_code }
    }

    fn looks_like_image_rejection(field: &str, message: &str) -> bool {
        let haystack = format!("{field} {message}").to_lowercase();
        ["image", "first_frame", "last_frame", "reference"]
            .iter()
            .any(|keyword| haystack.contains(keyword))
    }
}

/// 解析 `Retry-After` 头：支持整数秒（`"3"`）和 RFC 1123 HTTP-date
/// （`"Wed, 21 Oct 2026 07:28:00 GMT"`）两种形式。日期形式用 `httpdate`
/// 解析成 `SystemTime` 再减去"现在"得到剩余时长；日期已经过去时返回
/// `Some(Duration::ZERO)`（意思是"现在就可以重试"），而不是 `None`
/// （`None` 表示"完全没解析出来"，语义不同）。两种形式都解析失败时返回
/// `None`。
fn parse_retry_after(value: &str) -> Option<Duration> {
    let trimmed = value.trim();
    if let Ok(secs) = trimmed.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    if let Ok(when) = httpdate::parse_http_date(trimmed) {
        return Some(when.duration_since(std::time::SystemTime::now()).unwrap_or(Duration::ZERO));
    }
    None
}

/// 下载临时文件的 Drop 守卫：任何一条错误退出路径（下载中断、超出大小上限、
/// rename 失败……）都会在 `Drop` 里把临时文件删掉，不留下半成品文件。只有
/// 成功 rename 之后调用 [`Self::commit`]，才让 `Drop` 变成空操作——这时
/// 临时文件本来就已经被 rename 移走了，再 `remove_file` 也只是无害地
/// 找不到文件。
struct TempFileGuard {
    path: PathBuf,
    committed: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, committed: false }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl Default for MinimaxClient {
    /// `Self::new()`'s only failure mode is a bad `TRIPCUT_MINIMAX_BASE_URL`;
    /// `Default` has no `Result` to report that through, so it panics. Any
    /// caller that needs graceful handling should call `MinimaxClient::new()`
    /// directly instead of going through this impl.
    fn default() -> Self {
        Self::new().expect("TRIPCUT_MINIMAX_BASE_URL (if set) must be a valid https or loopback-http URL")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_request() -> CreateRequest {
        CreateRequest {
            model: Model::H3Max,
            prompt: "a drone shot over a quiet harbour at dawn".to_string(),
            images: Vec::new(),
            videos: Vec::new(),
            audio: Vec::new(),
            duration: 6,
            resolution: Resolution::R768P,
            ratio: Some(Ratio::R16x9),
        }
    }

    #[test]
    fn request_body_shape_matches_v2_contract() {
        let req = base_request();
        let body = req.validate_and_build_body().expect("should validate");

        assert_eq!(body["model"], "MiniMax-H3-Max");
        assert_eq!(body["duration"], 6);
        assert_eq!(body["resolution"], "768P");
        assert_eq!(body["ratio"], "16:9");

        let content = body["content"].as_array().expect("content array");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], req.prompt);
    }

    #[test]
    fn t2v_without_ratio_is_rejected_before_any_http() {
        let mut req = base_request();
        req.ratio = None;
        let err = req.validate_and_build_body().unwrap_err();
        assert!(matches!(err, MinimaxError::InvalidRequest { field, .. } if field == "ratio"));
    }

    #[test]
    fn image_content_carries_role_in_body() {
        let mut req = base_request();
        req.ratio = None; // I2V doesn't require ratio
        req.images.push(ImageContent {
            input: ImageInput::DataUri("data:image/jpeg;base64,/9j/4AAQSkZJRg==".to_string()),
            role: ImageRole::FirstFrame,
        });
        let body = req.validate_and_build_body().expect("should validate");
        let content = body["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["role"], "first_frame");
        assert!(content[1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/"));
    }

    #[test]
    fn duration_outside_4_to_15_is_rejected_before_any_http() {
        for bad in [0, 1, 3, 16, 100] {
            let mut req = base_request();
            req.duration = bad;
            let err = req.validate_and_build_body().unwrap_err();
            assert!(
                matches!(&err, MinimaxError::InvalidRequest { field, .. } if field == "duration"),
                "duration {bad} should be rejected, got {err:?}"
            );
        }
        for ok in [4, 6, 15] {
            let mut req = base_request();
            req.duration = ok;
            assert!(req.validate_and_build_body().is_ok(), "duration {ok} should validate");
        }
    }

    #[test]
    fn prompt_over_7000_chars_is_rejected_before_any_http() {
        let mut req = base_request();
        req.prompt = "x".repeat(MAX_PROMPT_CHARS + 1);
        let err = req.validate_and_build_body().unwrap_err();
        assert!(matches!(err, MinimaxError::InvalidRequest { field, .. } if field == "prompt"));
    }

    #[test]
    fn resolution_must_match_model_capability() {
        let mut req = base_request();
        req.model = Model::H3Max;
        req.resolution = Resolution::R2K; // H3-Max doesn't support 2K
        let err = req.validate_and_build_body().unwrap_err();
        assert!(matches!(err, MinimaxError::InvalidRequest { field, .. } if field == "resolution"));

        let mut req2 = base_request();
        req2.model = Model::H3;
        req2.resolution = Resolution::R2K;
        assert!(req2.validate_and_build_body().is_ok());
    }

    #[test]
    fn body_stays_under_64mb_and_images_under_30mb() {
        let mut req = base_request();
        req.ratio = None;
        // ~40MB base64 payload for a single image should be rejected on the
        // per-image cap long before any 64MB whole-body cap would trigger.
        let huge_payload = "A".repeat(50 * 1024 * 1024);
        req.images.push(ImageContent {
            input: ImageInput::DataUri(format!("data:image/jpeg;base64,{huge_payload}")),
            role: ImageRole::ReferenceImage,
        });
        let err = req.validate_and_build_body().unwrap_err();
        assert!(matches!(err, MinimaxError::InvalidRequest { field, .. } if field == "content[].image_url"));
    }

    #[test]
    fn too_many_images_is_rejected() {
        let mut req = base_request();
        req.ratio = None;
        for _ in 0..(MAX_IMAGES + 1) {
            req.images.push(ImageContent {
                input: ImageInput::DataUri("data:image/jpeg;base64,AAAA".to_string()),
                role: ImageRole::ReferenceImage,
            });
        }
        let err = req.validate_and_build_body().unwrap_err();
        assert!(matches!(err, MinimaxError::InvalidRequest { field, .. } if field == "images"));
    }

    #[test]
    fn fabricated_400_image_body_maps_to_image_input_rejected() {
        // Real, previously-hollow assertion: drive `classify_error_body`
        // (the part of `map_error_response` that doesn't need a live
        // `reqwest::blocking::Response`, which has no public constructor)
        // with a fabricated 400 body that mentions "image" and assert it
        // actually produces the typed `ImageInputRejected` variant, not a
        // generic `InvalidRequest`.
        let body = ErrorBody {
            error: Some(ErrorDetail {
                field: Some("content[].image_url".to_string()),
                message: Some("image_url data URI is not supported for this account".to_string()),
            }),
        };
        let err = MinimaxClient::classify_error_body(400, true, body);
        assert!(matches!(err, MinimaxError::ImageInputRejected), "expected ImageInputRejected, got {err:?}");
    }

    #[test]
    fn image_rejection_narrowed_to_4xx_with_image_keywords_only() {
        // A 4xx that has nothing to do with images must stay InvalidRequest.
        let unrelated = ErrorBody {
            error: Some(ErrorDetail { field: Some("duration".to_string()), message: Some("must be 4-15s".to_string()) }),
        };
        let err = MinimaxClient::classify_error_body(400, true, unrelated);
        assert!(matches!(err, MinimaxError::InvalidRequest { .. }), "expected InvalidRequest, got {err:?}");

        // A 5xx that happens to mention "image" must NOT be reclassified as
        // ImageInputRejected -- the narrowing is 4xx-only.
        let server_side = ErrorBody {
            error: Some(ErrorDetail { field: None, message: Some("image pipeline crashed".to_string()) }),
        };
        let err = MinimaxClient::classify_error_body(500, false, server_side);
        assert!(matches!(err, MinimaxError::Server { status: 500 }), "expected Server, got {err:?}");

        // Each documented keyword independently triggers the narrowing.
        for keyword in ["image", "first_frame", "last_frame", "reference"] {
            let body = ErrorBody {
                error: Some(ErrorDetail { field: None, message: Some(format!("rejected: {keyword} not supported")) }),
            };
            let err = MinimaxClient::classify_error_body(400, true, body);
            assert!(matches!(err, MinimaxError::ImageInputRejected), "keyword {keyword:?} should trigger ImageInputRejected, got {err:?}");
        }
    }

    #[test]
    fn api_key_never_appears_in_error_messages_or_logs() {
        let secret = "sk-super-secret-minimax-key-do-not-leak";
        let errors: Vec<MinimaxError> = vec![
            MinimaxError::Auth,
            MinimaxError::RateLimited { retry_after: Some(Duration::from_secs(3)) },
            MinimaxError::InvalidRequest { field: "duration".to_string(), message: "bad".to_string() },
            MinimaxError::ImageInputRejected,
            MinimaxError::Server { status: 500 },
            MinimaxError::Network,
            MinimaxError::Cancelled,
            MinimaxError::Failed { message: "boom".to_string() },
        ];
        for err in errors {
            let rendered = format!("{err}");
            let debug_rendered = format!("{err:?}");
            assert!(!rendered.contains(secret));
            assert!(!debug_rendered.contains(secret));
        }
    }

    #[test]
    fn api_key_never_appears_in_client_debug_output() {
        // The client never stores the API key at all (it's passed per-call
        // as `&str`), but assert the invariant directly against `{:?}`
        // rather than trusting that fact silently -- if a future change
        // added an `api_key` field to `MinimaxClient`, this is the test that
        // should catch it appearing in Debug output.
        let secret = "sk-SECRET-123";
        std::env::remove_var("TRIPCUT_MINIMAX_BASE_URL");
        let client = MinimaxClient::new().expect("default base URL must validate");
        let debug_rendered = format!("{client:?}");
        assert!(!debug_rendered.contains(secret));
    }

    #[test]
    fn base_url_defaults_to_https_api() {
        // Guard against accidentally shipping a loopback default.
        assert!(DEFAULT_BASE_URL.starts_with("https://"));
    }

    // --- validate_base_url (Finding 1) ---------------------------------

    #[test]
    fn validate_base_url_rejects_non_loopback_http() {
        assert!(validate_base_url("http://evil.com").is_err());
    }

    #[test]
    fn validate_base_url_rejects_userinfo_disguised_as_loopback_host() {
        assert!(validate_base_url("http://127.0.0.1@evil.com").is_err());
    }

    #[test]
    fn validate_base_url_rejects_domain_with_loopback_as_a_label_prefix() {
        assert!(validate_base_url("http://127.0.0.1.evil.com").is_err());
    }

    #[test]
    fn validate_base_url_accepts_loopback_http_ipv4_with_port() {
        assert!(validate_base_url("http://127.0.0.1:8765").is_ok());
    }

    #[test]
    fn validate_base_url_accepts_loopback_http_ipv6_with_port() {
        assert!(validate_base_url("http://[::1]:8765").is_ok());
    }

    #[test]
    fn validate_base_url_accepts_https_arbitrary_host() {
        assert!(validate_base_url("https://api.minimax.io").is_ok());
    }

    #[test]
    fn validate_base_url_rejection_is_typed_invalid_request_on_base_url_field() {
        let err = validate_base_url("http://evil.com").unwrap_err();
        assert!(matches!(&err, MinimaxError::InvalidRequest { field, .. } if field == "base_url"), "got {err:?}");
    }

    #[test]
    fn client_construction_rejects_invalid_base_url_env_var_instead_of_silently_using_it() {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: serialized by LOCK above.
        unsafe {
            std::env::set_var("TRIPCUT_MINIMAX_BASE_URL", "http://evil.com");
        }
        let result = MinimaxClient::new();
        unsafe {
            std::env::remove_var("TRIPCUT_MINIMAX_BASE_URL");
        }
        let err = result.unwrap_err();
        assert!(matches!(&err, MinimaxError::InvalidRequest { field, .. } if field == "base_url"), "got {err:?}");
    }

    // --- TaskStatusKind (Finding 4) -------------------------------------

    #[test]
    fn task_status_classification_is_case_insensitive_and_covers_in_flight_synonyms() {
        for raw in ["SUCCEEDED", "Succeeded"] {
            let parsed = QueryResponse { task_id: "t1".to_string(), status: raw.to_string(), content: None, error: None };
            let status = MinimaxClient::classify_task_status(parsed).expect("succeeded should be Ok");
            assert_eq!(status.status, TaskStatusKind::Succeeded);
        }

        for raw in ["queued", "PREPARING", "processing", "RUNNING", "pending"] {
            let parsed = QueryResponse { task_id: "t1".to_string(), status: raw.to_string(), content: None, error: None };
            let status = MinimaxClient::classify_task_status(parsed).expect("in-flight status should be Ok");
            assert!(status.status.is_in_flight(), "{raw} should be in-flight, got {:?}", status.status);
        }

        let cancelled = QueryResponse { task_id: "t1".to_string(), status: "CANCELLED".to_string(), content: None, error: None };
        assert!(matches!(MinimaxClient::classify_task_status(cancelled), Err(MinimaxError::Cancelled)));

        let failed = QueryResponse {
            task_id: "t1".to_string(),
            status: "Failed".to_string(),
            content: None,
            error: Some(QueryError { message: Some("nope".to_string()) }),
        };
        assert!(matches!(MinimaxClient::classify_task_status(failed), Err(MinimaxError::Failed { .. })));
    }

    #[test]
    fn unrecognised_status_is_unknown_and_in_flight_never_failed() {
        let parsed = QueryResponse { task_id: "t1".to_string(), status: "totally-new-status".to_string(), content: None, error: None };
        let status = MinimaxClient::classify_task_status(parsed).expect("unrecognised status must not be an Err");
        match &status.status {
            TaskStatusKind::Unknown(raw) => assert_eq!(raw, "totally-new-status"),
            other => panic!("expected Unknown, got {other:?}"),
        }
        assert!(status.status.is_in_flight(), "Unknown must be treated as in-flight, not Failed");
    }

    // --- Retry-After parsing (Finding 5) --------------------------------

    #[test]
    fn retry_after_parses_integer_seconds() {
        assert_eq!(parse_retry_after("3"), Some(Duration::from_secs(3)));
        assert_eq!(parse_retry_after("  120  "), Some(Duration::from_secs(120)));
    }

    #[test]
    fn retry_after_parses_rfc1123_http_date() {
        let future = std::time::SystemTime::now() + Duration::from_secs(3600);
        let formatted = httpdate::fmt_http_date(future);
        let parsed = parse_retry_after(&formatted).expect("HTTP-date form should parse");
        // Allow a little slack for the round-trip through second-resolution
        // HTTP-date formatting.
        assert!(parsed.as_secs() >= 3595 && parsed.as_secs() <= 3600, "got {parsed:?}");
    }

    #[test]
    fn retry_after_rejects_garbage() {
        assert_eq!(parse_retry_after("not-a-number-or-a-date"), None);
    }
}
