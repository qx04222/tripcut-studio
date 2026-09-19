//! R19 P-06 ②:模型后台下载。清单(`model_catalog`)之外的东西一概不下。
//!
//! 为什么是独立线程而不是 `jobs` 表:`jobs` 是「这份工程」的素材任务队列(按 worker 池与
//! 解码许可调度,随工程库切换),模型是「这台机器」的东西(落在 Application Support/models,
//! 所有工程共用),让它排在几十条 L1 分析后面、或者跟着工程库切换而丢,都不对。
//! 下载本身复用 `core/minimax.rs` 的形状:reqwest blocking + 读线程 + mpsc 逐块卡死检测 +
//! 临时文件 Drop 守卫;这里多两件事——边下边算 SHA-256、每块检查取消标志。
//!
//! 落地规则:写到同目录 `.<file>.download`,字节数与 SHA-256 都对上才 rename 成正式名;
//! 任何失败 / 取消路径都删临时文件,不留半文件。已经校验过的文件(重试时)跳过不重下。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use sha2::Digest;

use super::error::{CoreError, Result};
use super::model_catalog::{ModelFile, ModelSpec};

/// 进度事件名(与 R17 updater 的 `tripcut:update-progress` 同一套约定:tag = phase,kebab-case)。
pub const PROGRESS_EVENT: &str = "tripcut:model-download-progress";
/// 连续这么久收不到一个字节就判网络故障(与 minimax 下载同一口径)。
pub const DEFAULT_STALL_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum ModelProgress {
    Downloading { model_id: String, file: String, downloaded: u64, total: u64 },
    Verifying { model_id: String, file: String },
    Installed { model_id: String, dir: String },
    Cancelled { model_id: String },
    Error { model_id: String, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadOutcome {
    Installed { dir: PathBuf },
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct DownloadOptions {
    /// 测试 / 镜像:文件 URL 变成 `<base>/<model id>/<file name>`;规则同 updater 端点覆盖。
    pub base_url_override: Option<String>,
    pub stall_timeout: Duration,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self { base_url_override: base_url_override_from_env(), stall_timeout: DEFAULT_STALL_TIMEOUT }
    }
}

/// https 任意主机;http 只准回环;带 userinfo 一律拒(复用 updater.rs 的判定,不再写一遍)。
pub fn base_url_override_is_allowed(base_url: &str) -> bool {
    crate::updater::endpoint_override_is_allowed(base_url)
}

/// 读 `TRIPCUT_MODEL_BASE_URL`;不合规则的值当没设(并记一条 warn),绝不把明文非回环主机当模型源。
pub fn base_url_override_from_env() -> Option<String> {
    let raw = std::env::var("TRIPCUT_MODEL_BASE_URL").ok()?;
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    if base_url_override_is_allowed(trimmed) {
        Some(trimmed.to_owned())
    } else {
        tracing::warn!(base_url = trimmed, "TRIPCUT_MODEL_BASE_URL 不是 https 或回环 http,忽略");
        None
    }
}

fn file_url(spec: &ModelSpec, file: &ModelFile, options: &DownloadOptions) -> String {
    match &options.base_url_override {
        Some(base) => format!("{}/{}/{}", base.trim_end_matches('/'), spec.id, file.name),
        None => file.url.to_owned(),
    }
}

fn io_error(message: String) -> CoreError {
    CoreError::Io(std::io::Error::other(message))
}

/// 已落地且字节数 + 摘要都对:重试时跳过。
fn already_verified(path: &Path, file: &ModelFile) -> bool {
    let size_ok = std::fs::metadata(path).map(|meta| meta.is_file() && meta.len() == file.size_bytes).unwrap_or(false);
    size_ok && super::provisioning::sha256_of_file(path).map(|sha| sha == file.sha256).unwrap_or(false)
}

/// 同步下载一个模型的全部文件;调用方放线程里跑。`on_progress` 收到的最后一条一定是
/// `Installed` / `Cancelled` / `Error` 三者之一。
pub fn download_model(
    spec: &ModelSpec,
    models_dir: &Path,
    options: &DownloadOptions,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(ModelProgress),
) -> Result<DownloadOutcome> {
    let model_id = spec.id.to_owned();
    let dir = spec.install_dir(models_dir);
    let outcome = download_files(spec, &dir, options, cancel, &mut on_progress);
    match &outcome {
        Ok(DownloadOutcome::Installed { dir }) => {
            on_progress(ModelProgress::Installed { model_id, dir: dir.to_string_lossy().into_owned() })
        }
        Ok(DownloadOutcome::Cancelled) => on_progress(ModelProgress::Cancelled { model_id }),
        Err(error) => on_progress(ModelProgress::Error { model_id, message: error.to_string() }),
    }
    outcome
}

fn download_files(
    spec: &ModelSpec,
    dir: &Path,
    options: &DownloadOptions,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(ModelProgress),
) -> Result<DownloadOutcome> {
    std::fs::create_dir_all(dir)?;
    let total = spec.total_bytes();
    let mut done_bytes: u64 = 0;
    let http = reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| io_error(format!("无法创建下载客户端:{error}")))?;

    for file in spec.files {
        let destination = dir.join(file.name);
        if already_verified(&destination, file) {
            done_bytes += file.size_bytes;
            continue;
        }
        if cancel.load(Ordering::Acquire) {
            return Ok(DownloadOutcome::Cancelled);
        }
        let url = file_url(spec, file, options);
        let one = FileDownload { http: &http, url: &url, spec, file, destination: &destination, stall_timeout: options.stall_timeout, base_done: done_bytes, total };
        if one.run(cancel, on_progress)? == DownloadOutcome::Cancelled {
            return Ok(DownloadOutcome::Cancelled);
        }
        done_bytes += file.size_bytes;
    }
    on_progress(ModelProgress::Downloading {
        model_id: spec.id.to_owned(),
        file: spec.files.last().map(|file| file.name).unwrap_or_default().to_owned(),
        downloaded: total,
        total,
    });
    Ok(DownloadOutcome::Installed { dir: dir.to_path_buf() })
}

struct FileDownload<'a> {
    http: &'a reqwest::blocking::Client,
    url: &'a str,
    spec: &'a ModelSpec,
    file: &'a ModelFile,
    destination: &'a Path,
    stall_timeout: Duration,
    base_done: u64,
    total: u64,
}

impl FileDownload<'_> {
    fn run(&self, cancel: &AtomicBool, on_progress: &mut impl FnMut(ModelProgress)) -> Result<DownloadOutcome> {
        let file = self.file;
        let response = self
            .http
            .get(self.url)
            .send()
            .map_err(|error| io_error(format!("下载 {} 失败:{}", file.name, describe_reqwest(&error))))?;
        let status = response.status();
        if !status.is_success() {
            return Err(io_error(format!("下载 {} 失败:服务器返回 {}", file.name, status.as_u16())));
        }
        if let Some(length) = response.content_length() {
            if length != file.size_bytes {
                return Err(io_error(format!(
                    "下载 {} 失败:服务器给的大小 {length} 与清单 {} 不符,已拒绝",
                    file.name, file.size_bytes
                )));
            }
        }

        let tmp_path = self.destination.with_file_name(format!(".{}.download", file.name));
        let mut guard = TempFileGuard::new(tmp_path.clone());
        let mut out = std::fs::File::create(&tmp_path)?;
        let mut hasher = sha2::Sha256::new();

        // 读线程只管阻塞读 socket,主线程用 recv_timeout 做卡死检测(reqwest blocking 的 Read 没有逐次超时)。
        let (tx, rx) = mpsc::channel::<std::result::Result<Vec<u8>, String>>();
        std::thread::spawn(move || {
            let mut response = response;
            let mut buf = [0_u8; 64 * 1024];
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
                    Err(error) => {
                        let _ = tx.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });

        let mut written: u64 = 0;
        loop {
            if cancel.load(Ordering::Acquire) {
                drop(out);
                drop(guard); // 删临时文件
                return Ok(DownloadOutcome::Cancelled);
            }
            match rx.recv_timeout(self.stall_timeout) {
                Ok(Ok(chunk)) => {
                    if chunk.is_empty() {
                        break;
                    }
                    written += chunk.len() as u64;
                    if written > file.size_bytes {
                        return Err(io_error(format!("下载 {} 失败:收到的字节数超过清单 {},已拒绝", file.name, file.size_bytes)));
                    }
                    hasher.update(&chunk);
                    out.write_all(&chunk)?;
                    on_progress(ModelProgress::Downloading {
                        model_id: self.spec.id.to_owned(),
                        file: file.name.to_owned(),
                        downloaded: self.base_done + written,
                        total: self.total,
                    });
                }
                Ok(Err(message)) => return Err(io_error(format!("下载 {} 中断:{message}", file.name))),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(io_error(format!(
                        "下载 {} 失败:{} 秒没收到数据,网络可能断了",
                        file.name,
                        self.stall_timeout.as_secs()
                    )))
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        out.sync_all()?;
        drop(out);

        on_progress(ModelProgress::Verifying { model_id: self.spec.id.to_owned(), file: file.name.to_owned() });
        if written != file.size_bytes {
            return Err(io_error(format!(
                "下载 {} 不完整:收到 {written} 字节,清单要求 {},已丢弃",
                file.name, file.size_bytes
            )));
        }
        let digest = format!("{:x}", hasher.finalize());
        if digest != file.sha256 {
            return Err(io_error(format!(
                "{} 的 SHA-256 校验失败(收到 {digest},期望 {}),已丢弃,不会启用",
                file.name, file.sha256
            )));
        }
        let _ = std::fs::remove_file(self.destination);
        std::fs::rename(&tmp_path, self.destination)?;
        guard.commit();
        Ok(DownloadOutcome::Installed { dir: self.destination.parent().map(Path::to_path_buf).unwrap_or_default() })
    }
}

fn describe_reqwest(error: &reqwest::Error) -> String {
    if error.is_connect() {
        "连不上服务器".to_owned()
    } else if error.is_timeout() {
        "连接超时".to_owned()
    } else {
        error.to_string()
    }
}

/// 临时文件的 Drop 守卫(同 minimax.rs):没 commit 就删。
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model_catalog::{spec_for_id, CLIP_MODEL_ID};

    #[test]
    fn file_url_uses_the_override_layout_only_when_set() {
        let spec = spec_for_id(CLIP_MODEL_ID).unwrap();
        let file = &spec.files[0];
        let plain = DownloadOptions { base_url_override: None, stall_timeout: Duration::from_secs(1) };
        assert_eq!(file_url(spec, file, &plain), file.url);
        let mirrored = DownloadOptions { base_url_override: Some("http://127.0.0.1:9/".into()), stall_timeout: Duration::from_secs(1) };
        assert_eq!(file_url(spec, file, &mirrored), "http://127.0.0.1:9/chinese-clip-vit-b-16/config.json");
    }
}
