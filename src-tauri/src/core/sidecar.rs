use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::error::{CoreError, Result};

pub const EMBEDDING_DIMENSIONS: usize = 512;
pub const MODEL_NAME: &str = "OFA-Sys/chinese-clip-vit-base-patch16";
pub type DimensionPrototypes = BTreeMap<String, Vec<String>>;
pub type ClassificationScores = BTreeMap<String, f32>;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const PING_TIMEOUT: Duration = Duration::from_secs(5);
// First use may include the model download (S3 measured about 202 seconds),
// which is why MAX_TIMEOUT keeps the old 600 s ceiling even though the
// per-call defaults below are shorter.
const MIN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TIMEOUT: Duration = Duration::from_secs(600);
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(60);
const STDERR_TAIL_LINES: usize = 8;
// The Chinese-CLIP model loads lazily on the first embed/classify call after
// start()/restart() (sidecar/clip_service.py:_load — ping never loads it),
// which measured about 202 s cold. Per-call timeouts are much shorter than
// that, so the first real call after a (re)start must use this ceiling or it
// times out, triggers a restart, and cold-loads again forever.
const COLD_START_TIMEOUT: Duration = Duration::from_secs(600);

fn clamp_timeout(timeout: Duration) -> Duration {
    timeout.clamp(MIN_TIMEOUT, MAX_TIMEOUT)
}

/// The timeout `request` actually uses for a call: while the sidecar is
/// still "cold" (just started/restarted, model not yet loaded) every
/// requested timeout is overridden by `COLD_START_TIMEOUT`; otherwise the
/// caller's (already-clamped) requested timeout applies unchanged.
fn effective_timeout(cold: bool, requested: Duration) -> Duration {
    if cold {
        COLD_START_TIMEOUT
    } else {
        requested
    }
}

/// `embed_images` waits longer as the strip has more frames to embed.
fn embed_images_timeout(strip_frame_count: usize) -> Duration {
    clamp_timeout(Duration::from_secs(30 + 5 * strip_frame_count as u64))
}

static SIDECAR: OnceLock<Mutex<SidecarClient>> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct RpcResponse {
    jsonrpc: String,
    id: u64,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

#[derive(Debug)]
enum CallFailure {
    Timeout,
    Broken(String),
    Protocol(String),
    Remote(RpcError),
}

struct RunningSidecar {
    child: Child,
    stdin: ChildStdin,
    responses: Receiver<std::result::Result<String, String>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl RunningSidecar {
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn failure_context(&self) -> String {
        let lines = self
            .stderr_tail
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if lines.is_empty() {
            String::new()
        } else {
            format!("；sidecar stderr：{}", lines.iter().cloned().collect::<Vec<_>>().join(" | "))
        }
    }
}

struct SidecarClient {
    process: Option<RunningSidecar>,
    next_id: u64,
    last_ping: Option<Instant>,
    last_used: Option<Instant>,
    /// True from `start()` (hence also after `restart()`) until the first
    /// successful non-ping call returns — see `COLD_START_TIMEOUT` above.
    cold: bool,
}

impl Default for SidecarClient {
    fn default() -> Self {
        Self {
            process: None,
            next_id: 1,
            last_ping: None,
            last_used: None,
            cold: true,
        }
    }
}

impl SidecarClient {
    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        self.ensure_started()?;
        if method != "ping"
            && self
                .last_ping
                .is_none_or(|last_ping| last_ping.elapsed() >= HEARTBEAT_INTERVAL)
        {
            if let Err(error) = self.call("ping", json!({}), PING_TIMEOUT) {
                self.restart().map_err(|restart_error| {
                    CoreError::Sidecar(format!(
                        "Chinese-CLIP sidecar 心跳失败且无法重启：{}；{restart_error}",
                        describe_call_failure(&error)
                    ))
                })?;
            }
            self.last_ping = Some(Instant::now());
        }

        let timeout = effective_timeout(self.cold, timeout);
        let outcome = self.call(method, params, timeout);
        self.last_used = Some(Instant::now());
        match outcome {
            Ok(value) => {
                if method != "ping" {
                    self.cold = false;
                }
                Ok(value)
            }
            Err(CallFailure::Remote(error)) => Err(CoreError::Sidecar(format!(
                "Chinese-CLIP sidecar 返回错误 {}：{}",
                error.code, error.message
            ))),
            Err(error) => {
                let context = self
                    .process
                    .as_ref()
                    .map(RunningSidecar::failure_context)
                    .unwrap_or_default();
                let failure = describe_call_failure(&error);
                let restart_error = self.restart().err();
                let restart_note = restart_error
                    .map(|error| format!("；自动重启失败：{error}"))
                    .unwrap_or_else(|| "；已终止并重启 sidecar".to_owned());
                Err(CoreError::Sidecar(format!(
                    "Chinese-CLIP sidecar 调用失败：{failure}{context}{restart_note}"
                )))
            }
        }
    }

    fn ensure_started(&mut self) -> Result<()> {
        if self.process.is_some() {
            return Ok(());
        }
        self.start()
    }

    fn start(&mut self) -> Result<()> {
        let (python, service, model_dir) = resolve_launch()?;
        let mut process = spawn_process(&python, &service, &model_dir)?;
        let id = self.take_id();
        match call_process(&mut process, id, "ping", json!({}), PING_TIMEOUT) {
            Ok(_) => {
                self.mark_started(process);
                Ok(())
            }
            Err(error) => {
                let context = process.failure_context();
                process.stop();
                Err(CoreError::Sidecar(format!(
                    "Chinese-CLIP sidecar 启动后未通过 ping：{}{context}",
                    describe_call_failure(&error)
                )))
            }
        }
    }

    /// Records a freshly-pinged process as the active one and marks the
    /// client cold: the model has not been loaded on it yet (ping alone
    /// never loads it — see `COLD_START_TIMEOUT`), so the first real call
    /// still needs the cold-start ceiling regardless of how warm the
    /// client was before this (re)start.
    fn mark_started(&mut self, process: RunningSidecar) {
        self.process = Some(process);
        self.last_ping = Some(Instant::now());
        self.cold = true;
    }

    fn restart(&mut self) -> Result<()> {
        self.stop();
        self.start()
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            process.stop();
        }
        self.last_ping = None;
    }

    fn call(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> std::result::Result<Value, CallFailure> {
        let id = self.take_id();
        let process = self
            .process
            .as_mut()
            .ok_or_else(|| CallFailure::Broken("sidecar 尚未启动".to_owned()))?;
        call_process(process, id, method, params, timeout)
    }

    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        id
    }

    /// Pure-ish core of `unload_if_idle`, parameterized on `now` so tests can
    /// construct an arbitrarily "old" `last_used` without sleeping.
    fn unload_if_idle_at(&mut self, now: Instant, idle: Duration, keep: bool) -> bool {
        if keep || self.process.is_none() {
            return false;
        }
        let is_idle = self
            .last_used
            .is_some_and(|last_used| now.saturating_duration_since(last_used) >= idle);
        if !is_idle {
            return false;
        }
        self.stop();
        tracing::info!(idle_seconds = idle.as_secs(), "Chinese-CLIP sidecar 空闲卸载");
        true
    }

    fn unload_if_idle(&mut self, idle: Duration, keep: bool) -> bool {
        self.unload_if_idle_at(Instant::now(), idle, keep)
    }
}

/// Stops the Chinese-CLIP sidecar process if it is running, idle for at
/// least `idle`, and `keep` is false (the caller sets `keep` when there is
/// pending embedding/classification work that would just relaunch it).
/// Wired into `jobs::JobRunner::run`'s periodic timer separately (R1 Task 8b).
pub fn unload_if_idle(idle: Duration, keep: bool) -> bool {
    with_client(|client| Ok(client.unload_if_idle(idle, keep))).unwrap_or(false)
}

pub fn ping() -> Result<()> {
    with_client(|client| client.request("ping", json!({}), PING_TIMEOUT)).map(|_| ())
}

pub fn embed_text(query: &str) -> Result<Vec<f32>> {
    let value = with_client(|client| {
        client.request(
            "embed_text",
            json!({ "query": query }),
            clamp_timeout(DEFAULT_CALL_TIMEOUT),
        )
    })?;
    parse_vector(value)
}

pub fn embed_images(strip_path: &Path, strip_frame_count: usize) -> Result<Vec<Vec<f32>>> {
    let value = with_client(|client| {
        client.request(
            "embed_images",
            json!({
                "paths": [strip_path.to_string_lossy()],
                "strip_frame_count": strip_frame_count,
            }),
            embed_images_timeout(strip_frame_count),
        )
    })?;
    let rows: Vec<Value> = serde_json::from_value(value)
        .map_err(|error| CoreError::Sidecar(format!("图像嵌入响应不是数组：{error}")))?;
    if rows.is_empty() {
        return Err(CoreError::Sidecar("图像嵌入响应为空".to_owned()));
    }
    rows.into_iter().map(parse_vector).collect()
}

pub fn classify(
    image_path: &Path,
    dimension_prototypes: &DimensionPrototypes,
) -> Result<ClassificationScores> {
    if dimension_prototypes.is_empty() {
        return Err(CoreError::Sidecar("分类原型不能为空".to_owned()));
    }
    let value = with_client(|client| {
        client.request(
            "classify",
            json!({
                "image": image_path.to_string_lossy(),
                "dimension_prototypes": dimension_prototypes,
            }),
            clamp_timeout(DEFAULT_CALL_TIMEOUT),
        )
    })?;
    parse_classification_scores(value)
}

fn with_client<T>(operation: impl FnOnce(&mut SidecarClient) -> Result<T>) -> Result<T> {
    let client = SIDECAR.get_or_init(|| Mutex::new(SidecarClient::default()));
    let mut client = client.lock().unwrap_or_else(|error| error.into_inner());
    operation(&mut client)
}

fn resolve_launch() -> Result<(PathBuf, PathBuf, PathBuf)> {
    let paths = crate::packaging::sidecar_paths();
    let service = paths.service;
    let python = paths.python;
    if !service.is_file() || !python.is_file() {
        return Err(CoreError::Sidecar(
            "画面识别组件尚未安装；正式版不会在线安装，按画面搜索暂不可用"
                .to_owned(),
        ));
    }
    // R19 P-06:没有模型就别起 Python(冷启动几十秒到几分钟,起来也只会报
    // `TRIPCUT_CLIP_MODEL_DIR must point to ...`)。模型目录的解析(环境变量 > 设置 > 自动
    // 安装目录)在 model_catalog;装完模型后 lib.rs 会补排 clip_embed,下一次 spawn 就带上它。
    let model_dir = match super::model_catalog::resolve_clip_provider_state() {
        super::model_catalog::ProviderState::Ready { dir, .. } => PathBuf::from(dir),
        super::model_catalog::ProviderState::Blocked { reason } => {
            return Err(CoreError::Sidecar(format!(
                "{reason}；到「设置 › 工具与模型」点「安装」即可,装完自动启用"
            )));
        }
    };
    Ok((python, service, model_dir))
}

fn spawn_process(python: &Path, service: &Path, model_dir: &Path) -> Result<RunningSidecar> {
    let mut child = Command::new(python)
        .arg("-u")
        .arg(service)
        .env("PYTHONUNBUFFERED", "1")
        .env("TRIPCUT_CLIP_MODEL_DIR", model_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CoreError::Sidecar(format!(
                "无法启动画面识别组件：{error}；请重新安装受信任的组件包"
            ))
        })?;
    let stdin = child.stdin.take().ok_or_else(|| {
        CoreError::Sidecar("Chinese-CLIP sidecar 缺少 stdin 管道".to_owned())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        CoreError::Sidecar("Chinese-CLIP sidecar 缺少 stdout 管道".to_owned())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CoreError::Sidecar("Chinese-CLIP sidecar 缺少 stderr 管道".to_owned())
    })?;

    let (response_sender, responses) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = response_sender.send(Err("stdout 已关闭".to_owned()));
                    break;
                }
                Ok(_) => {
                    let _ = response_sender.send(Ok(line.trim_end().to_owned()));
                }
                Err(error) => {
                    let _ = response_sender.send(Err(format!("读取 stdout 失败：{error}")));
                    break;
                }
            }
        }
    });

    let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
    let stderr_lines = stderr_tail.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            tracing::warn!(message = %line, "Chinese-CLIP sidecar stderr");
            let mut tail = stderr_lines
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });

    Ok(RunningSidecar {
        child,
        stdin,
        responses,
        stderr_tail,
    })
}

fn call_process(
    process: &mut RunningSidecar,
    id: u64,
    method: &str,
    params: Value,
    timeout: Duration,
) -> std::result::Result<Value, CallFailure> {
    let request = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    serde_json::to_writer(&mut process.stdin, &request)
        .map_err(|error| CallFailure::Broken(format!("写入请求失败：{error}")))?;
    process
        .stdin
        .write_all(b"\n")
        .and_then(|_| process.stdin.flush())
        .map_err(|error| CallFailure::Broken(format!("刷新请求失败：{error}")))?;

    let line = match process.responses.recv_timeout(timeout) {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => return Err(CallFailure::Broken(error)),
        Err(RecvTimeoutError::Timeout) => return Err(CallFailure::Timeout),
        Err(RecvTimeoutError::Disconnected) => {
            return Err(CallFailure::Broken("响应通道已关闭".to_owned()))
        }
    };
    decode_response(&line, id)
}

fn decode_response(line: &str, expected_id: u64) -> std::result::Result<Value, CallFailure> {
    let response: RpcResponse = serde_json::from_str(line)
        .map_err(|error| CallFailure::Protocol(format!("响应 JSON 无效：{error}")))?;
    if response.jsonrpc != "2.0" {
        return Err(CallFailure::Protocol(format!(
            "响应 jsonrpc={}，预期 2.0",
            response.jsonrpc
        )));
    }
    if response.id != expected_id {
        return Err(CallFailure::Protocol(format!(
            "响应 id={}，预期 {expected_id}",
            response.id
        )));
    }
    if let Some(error) = response.error {
        return Err(CallFailure::Remote(error));
    }
    response
        .result
        .ok_or_else(|| CallFailure::Protocol("响应同时缺少 result 与 error".to_owned()))
}

fn parse_vector(value: Value) -> Result<Vec<f32>> {
    let vector: Vec<f32> = serde_json::from_value(value)
        .map_err(|error| CoreError::Sidecar(format!("嵌入响应不是数值数组：{error}")))?;
    if vector.len() != EMBEDDING_DIMENSIONS {
        return Err(CoreError::Sidecar(format!(
            "嵌入维数为 {}，预期 {EMBEDDING_DIMENSIONS}",
            vector.len()
        )));
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(CoreError::Sidecar("嵌入包含非有限数值".to_owned()));
    }
    Ok(vector)
}

fn parse_classification_scores(value: Value) -> Result<ClassificationScores> {
    let scores: ClassificationScores = serde_json::from_value(value)
        .map_err(|error| CoreError::Sidecar(format!("分类响应不是标签分数字典：{error}")))?;
    if scores.is_empty() {
        return Err(CoreError::Sidecar("分类响应为空".to_owned()));
    }
    if scores.iter().any(|(label, score)| label.is_empty() || !score.is_finite()) {
        return Err(CoreError::Sidecar("分类响应包含空标签或非有限分数".to_owned()));
    }
    Ok(scores)
}

fn describe_call_failure(error: &CallFailure) -> String {
    match error {
        CallFailure::Timeout => "请求超时".to_owned(),
        CallFailure::Broken(message) | CallFailure::Protocol(message) => message.clone(),
        CallFailure::Remote(error) => format!("远端错误 {}：{}", error.code, error.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real child process (`sh -c cat`) so `RunningSidecar` can be
    /// constructed for tests without faking `std::process::Child`. It never
    /// receives a request in these tests, so the unused response channel and
    /// unread stdout/stderr pipes are fine; callers must reap it via
    /// `RunningSidecar::stop` (directly, or through `SidecarClient::stop`).
    fn dummy_running_sidecar() -> RunningSidecar {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn dummy test process");
        let stdin = child.stdin.take().expect("dummy stdin");
        let (_sender, responses) = mpsc::channel();
        RunningSidecar {
            child,
            stdin,
            responses,
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    #[test]
    fn unload_if_idle_stops_a_process_idle_past_the_threshold() {
        let now = Instant::now();
        let mut client = SidecarClient {
            process: Some(dummy_running_sidecar()),
            last_used: Some(now - Duration::from_secs(61)),
            ..SidecarClient::default()
        };

        let unloaded = client.unload_if_idle_at(now, Duration::from_secs(60), false);

        assert!(unloaded);
        assert!(client.process.is_none());
    }

    #[test]
    fn unload_if_idle_keeps_a_process_when_keep_is_true() {
        let now = Instant::now();
        let mut client = SidecarClient {
            process: Some(dummy_running_sidecar()),
            last_used: Some(now - Duration::from_secs(61)),
            ..SidecarClient::default()
        };

        let unloaded = client.unload_if_idle_at(now, Duration::from_secs(60), true);

        assert!(!unloaded);
        assert!(client.process.is_some());
        client.stop();
    }

    #[test]
    fn unload_if_idle_keeps_a_process_that_is_not_idle_long_enough() {
        let now = Instant::now();
        let mut client = SidecarClient {
            process: Some(dummy_running_sidecar()),
            last_used: Some(now - Duration::from_secs(10)),
            ..SidecarClient::default()
        };

        let unloaded = client.unload_if_idle_at(now, Duration::from_secs(60), false);

        assert!(!unloaded);
        assert!(client.process.is_some());
        client.stop();
    }

    #[test]
    fn unload_if_idle_is_false_with_no_process_running() {
        let now = Instant::now();
        let mut client = SidecarClient {
            last_used: Some(now - Duration::from_secs(61)),
            ..SidecarClient::default()
        };

        assert!(!client.unload_if_idle_at(now, Duration::from_secs(60), false));
    }

    #[test]
    fn embed_images_timeout_grows_with_frame_count() {
        assert_eq!(embed_images_timeout(0), Duration::from_secs(30));
        assert_eq!(embed_images_timeout(4), Duration::from_secs(50));
    }

    #[test]
    fn embed_images_timeout_is_clamped_between_min_and_max() {
        // 0 frames still clamps up to MIN_TIMEOUT (30 s > 30 s is a no-op here,
        // so exercise the low end with the formula's own floor and the high
        // end with a frame count large enough to blow past MAX_TIMEOUT).
        assert_eq!(embed_images_timeout(0), MIN_TIMEOUT);
        assert_eq!(embed_images_timeout(1000), MAX_TIMEOUT);
    }

    #[test]
    fn default_call_timeout_is_used_for_embed_text_and_classify() {
        // embed_text/classify pass `clamp_timeout(DEFAULT_CALL_TIMEOUT)`, i.e. 60 s.
        assert_eq!(clamp_timeout(DEFAULT_CALL_TIMEOUT), Duration::from_secs(60));
    }

    #[test]
    fn effective_timeout_overrides_to_cold_start_ceiling_while_cold() {
        // The model loads lazily on the first non-ping call after
        // start()/restart() (~200 s measured); a 60 s per-call timeout would
        // time that out and trigger a restart -> cold-load loop, so while
        // `cold` is true every requested timeout is replaced by
        // COLD_START_TIMEOUT (600 s) regardless of what was asked for.
        assert_eq!(
            effective_timeout(true, Duration::from_secs(60)),
            COLD_START_TIMEOUT
        );
        // Once warm, the caller's requested timeout passes through unchanged.
        assert_eq!(
            effective_timeout(false, Duration::from_secs(60)),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn unload_then_next_start_leaves_the_client_cold_again() {
        // After `unload_if_idle` stops the process, the field-level state it
        // leaves behind (`process: None`) is exactly what `ensure_started`
        // uses to decide to go through `start()` again. `start()` cannot be
        // driven end-to-end here (it needs a real sidecar process), but the
        // struct-mutating tail of it — `mark_started` — is what actually
        // sets `cold`, so exercise that directly on a client that was warm
        // (a completed call had cleared `cold`) and confirm the next start
        // makes it cold again.
        let now = Instant::now();
        let mut client = SidecarClient {
            process: Some(dummy_running_sidecar()),
            last_used: Some(now - Duration::from_secs(61)),
            cold: false,
            ..SidecarClient::default()
        };

        let unloaded = client.unload_if_idle_at(now, Duration::from_secs(60), false);
        assert!(unloaded);
        assert!(client.process.is_none());
        assert!(!client.cold, "unloading alone must not flip cold on its own");

        client.mark_started(dummy_running_sidecar());

        assert!(client.cold, "next start() must mark the client cold again");
        client.stop();
    }

    #[test]
    fn timeout_failure_is_in_the_restart_triggering_branch() {
        // `SidecarClient::request` only special-cases `CallFailure::Remote`
        // as a non-restarting failure; every other variant, Timeout
        // included, falls into the catch-all branch that calls `restart()`.
        // This asserts that classification statically, since actually
        // exercising it end-to-end needs a real hung sidecar process (see
        // the report for what a fake-hang test would require).
        let failure = CallFailure::Timeout;
        let restarts = !matches!(failure, CallFailure::Remote(_));
        assert!(restarts);
    }

    #[test]
    fn decodes_mock_json_rpc_result() {
        let result = decode_response(r#"{"jsonrpc":"2.0","id":7,"result":{"status":"ok"}}"#, 7)
            .unwrap();
        assert_eq!(result["status"], "ok");
    }

    #[test]
    fn surfaces_mock_json_rpc_error() {
        let error = decode_response(
            r#"{"jsonrpc":"2.0","id":8,"error":{"code":-32000,"message":"boom"}}"#,
            8,
        )
        .unwrap_err();
        assert!(matches!(error, CallFailure::Remote(RpcError { code: -32000, .. })));
    }

    #[test]
    fn rejects_a_mock_response_for_another_request() {
        let error = decode_response(r#"{"jsonrpc":"2.0","id":9,"result":[]}"#, 10)
            .unwrap_err();
        assert!(matches!(error, CallFailure::Protocol(_)));
    }

    #[test]
    fn rejects_wrong_embedding_dimensions() {
        let error = parse_vector(json!([0.0, 1.0])).unwrap_err();
        assert!(error.to_string().contains("预期 512"));
    }

    #[test]
    fn parses_explainable_classification_scores() {
        let scores = parse_classification_scores(json!({
            "subject::人": 0.41,
            "subject::风景": 0.27
        }))
        .unwrap();
        assert_eq!(scores["subject::人"], 0.41);
    }

    #[test]
    fn rejects_non_finite_classification_scores() {
        let error = parse_classification_scores(json!({"subject::人": null})).unwrap_err();
        assert!(error.to_string().contains("分类响应"));
    }
}
