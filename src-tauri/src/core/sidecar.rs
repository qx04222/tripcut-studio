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
// First use may include the model download (S3 measured about 202 seconds).
const EMBEDDING_TIMEOUT: Duration = Duration::from_secs(600);
const STDERR_TAIL_LINES: usize = 8;

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
}

impl Default for SidecarClient {
    fn default() -> Self {
        Self {
            process: None,
            next_id: 1,
            last_ping: None,
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

        match self.call(method, params, timeout) {
            Ok(value) => Ok(value),
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
        let (python, service) = resolve_launch()?;
        let mut process = spawn_process(&python, &service)?;
        let id = self.take_id();
        match call_process(&mut process, id, "ping", json!({}), PING_TIMEOUT) {
            Ok(_) => {
                self.process = Some(process);
                self.last_ping = Some(Instant::now());
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
}

pub fn ping() -> Result<()> {
    with_client(|client| client.request("ping", json!({}), PING_TIMEOUT)).map(|_| ())
}

pub fn embed_text(query: &str) -> Result<Vec<f32>> {
    let value = with_client(|client| {
        client.request("embed_text", json!({ "query": query }), EMBEDDING_TIMEOUT)
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
            EMBEDDING_TIMEOUT,
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
            EMBEDDING_TIMEOUT,
        )
    })?;
    parse_classification_scores(value)
}

fn with_client<T>(operation: impl FnOnce(&mut SidecarClient) -> Result<T>) -> Result<T> {
    let client = SIDECAR.get_or_init(|| Mutex::new(SidecarClient::default()));
    let mut client = client.lock().unwrap_or_else(|error| error.into_inner());
    operation(&mut client)
}

fn resolve_launch() -> Result<(PathBuf, PathBuf)> {
    let paths = crate::packaging::sidecar_paths();
    let service = paths.service;
    let python = paths.python;
    if !service.is_file() || !python.is_file() {
        return Err(CoreError::Sidecar(
            "Chinese-CLIP 签名组件包尚未安装；正式版不会在线安装 Python 运行环境，画面语义搜索暂不可用"
                .to_owned(),
        ));
    }
    Ok((python, service))
}

fn spawn_process(python: &Path, service: &Path) -> Result<RunningSidecar> {
    let mut child = Command::new(python)
        .arg("-u")
        .arg(service)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CoreError::Sidecar(format!(
                "无法启动 Chinese-CLIP 签名组件包：{error}；请重新安装受信任的组件包"
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
