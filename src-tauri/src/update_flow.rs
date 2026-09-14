//! R17 车道 A:应用内自动升级的后端(检查 / 后台下载暂存 / 退出或重启时替换)。
//!
//! 为什么不用插件自带的 `download_and_install`:macOS 上 `install` 是**立即**把
//! `/Applications/旅剪工作台.app` 换掉(先 rename 走旧包,再把新包 rename 进来)。
//! 运行中的旧进程之后再懒加载 `Resources/sidecar/*.py`、模型等文件,拿到的就是新版本的
//! 文件——一次会话里混用两版资源。所以后台路径是:`download()`(插件在返回字节前已做
//! minisign 校验)→ 暂存在内存 → 退出时(`RunEvent::Exit`)或用户点「立即重启」时再替换。
//! 用户不主动重启,下一次正常启动就已经是新版本。
//!
//! 真机诊断见 `.superpowers/sdd/r17/diagnosis.md`:机制本身两种端点都走通,业主看不到
//! 更新是因为从没有自动检查。前端接线由车道 B 做,这里只提供命令、事件与设置键。

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 进度事件名。payload 见 [`UpdateProgress`]。
pub const PROGRESS_EVENT: &str = "tripcut:update-progress";
/// 更新器拿不到包时给用户的兜底:手工下载 DMG。
pub const DMG_FALLBACK_URL: &str = "https://github.com/qx04222/tripcut-studio/releases/latest";
/// 自动检查的最小间隔:一天最多问端点几次,而不是每次打开设置页都问。
pub const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DOWNLOAD_ATTEMPTS: u32 = 3;

#[derive(Default)]
pub struct UpdateFlowState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// 最近一次 `check_for_update` 发现的更新(下载要用它的 url/签名)。
    found: Option<Update>,
    /// 已下载并通过签名校验、等待替换的包。
    staged: Option<Staged>,
    downloading: bool,
}

struct Staged {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UpdateCheck {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub current_version: String,
    /// 端点没连上(断网、超时、DNS):不是错误,静默;`available` 一定是 false。
    pub offline: bool,
    /// 这个版本被用户「跳过」过(`updater.skipped_version`);`available` 仍为 true,由前端决定提不提示。
    pub skipped: bool,
}

/// 启动时前端问一句「现在要不要自动检查」:开关、要不要先问、以及按间隔算出来的结论。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AutoUpdatePlan {
    pub auto_update: bool,
    pub ask_before_download: bool,
    pub should_check_now: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UpdateStatus {
    pub downloading: bool,
    pub staged_version: Option<String>,
    pub found_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum UpdateProgress {
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
        attempt: u32,
    },
    /// 下载完、签名已校验、已暂存;退出或重启时替换。
    Staged { version: String },
    /// bundle 已替换(用户点了立即安装/重启)。
    Installed { version: String },
    Error { version: String, message: String },
}

/// 给用户看的错误:一句白话 + DMG 兜底链接;英文原文附在后面当证据。
pub fn friendly_error(detail: &str) -> String {
    let detail = detail.trim();
    let lower = detail.to_ascii_lowercase();
    // 判据同 updaterClient.ts 的 R4 终审:只认 minisign / 插件真正会说的那几句,不认宽泛的
    // "signature"——GitHub 302 到的 S3 地址查询串里有 `X-Amz-Signature`,纯网络错误的
    // 错误串尾巴会带上它。
    let signature_failure = lower.contains("signature verification failed")
        || lower.contains("could not be decoded")
        || lower.contains("created with a different key")
        || lower.contains("untrusted comment")
        || lower.contains("invalid signature");
    let head = if signature_failure {
        "更新包签名校验失败，已拒绝安装。"
    } else if lower.contains("permission") || lower.contains("authentication") {
        "没有权限替换应用，请把「旅剪工作台」放在「应用程序」文件夹后再试。"
    } else if lower.contains("release json") || lower.contains("platforms") || lower.contains("status: 404") {
        "更新服务器上暂时没有可用的更新包。"
    } else {
        "更新没有完成，可能是网络不稳定。"
    };
    format!("{head}可以手动下载最新版：{DMG_FALLBACK_URL}（详情：{detail}）")
}

/// 断网/超时/DNS 这一类「端点没连上」:自动检查时静默,不当错误。
fn is_offline_error(error: &tauri_plugin_updater::Error) -> bool {
    match error {
        tauri_plugin_updater::Error::Reqwest(inner) => {
            inner.is_connect() || inner.is_timeout() || inner.is_request()
        }
        tauri_plugin_updater::Error::Network(_) => true,
        _ => false,
    }
}

/// 签名/包本身的问题重试也没用;只有传输类错误值得再试。
fn is_retryable(error: &tauri_plugin_updater::Error) -> bool {
    matches!(
        error,
        tauri_plugin_updater::Error::Reqwest(_) | tauri_plugin_updater::Error::Network(_) | tauri_plugin_updater::Error::Io(_)
    )
}

/// 自动检查要不要现在做:开关开着,且距上次检查超过 [`AUTO_CHECK_INTERVAL`]。
/// `last_check` 是 `updater.last_check` 里存的 unix 秒;解析不了当作从没查过。
pub fn should_auto_check(auto_update: &str, last_check: Option<&str>, now_secs: u64) -> bool {
    if auto_update != "true" {
        return false;
    }
    let Some(last) = last_check.and_then(|value| value.parse::<u64>().ok()) else {
        return true;
    };
    now_secs.saturating_sub(last) >= AUTO_CHECK_INTERVAL.as_secs()
}

fn pub_date_of(update: &Update) -> Option<String> {
    update
        .raw_json
        .get("pub_date")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

fn lock(state: &UpdateFlowState) -> std::sync::MutexGuard<'_, Inner> {
    state.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn emit<R: Runtime>(app: &AppHandle<R>, payload: UpdateProgress) {
    if let Err(error) = app.emit(PROGRESS_EVENT, payload) {
        tracing::warn!(%error, "could not emit update progress");
    }
}

/// 检查一次端点。`skipped_version` 是 `updater.skipped_version` 的值(没设传空串)。
pub async fn check<R: Runtime>(
    app: &AppHandle<R>,
    skipped_version: &str,
) -> Result<UpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| friendly_error(&error.to_string()))?;
    let offline = |current_version: String| UpdateCheck {
        available: false,
        version: None,
        notes: None,
        pub_date: None,
        current_version,
        offline: true,
        skipped: false,
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let check = UpdateCheck {
                available: true,
                version: Some(update.version.clone()),
                notes: update.body.clone(),
                pub_date: pub_date_of(&update),
                current_version,
                offline: false,
                skipped: !skipped_version.is_empty() && update.version == skipped_version,
            };
            lock(app.state::<UpdateFlowState>().inner()).found = Some(update);
            Ok(check)
        }
        Ok(None) => Ok(UpdateCheck {
            offline: false,
            ..offline(current_version)
        }),
        Err(error) if is_offline_error(&error) => {
            tracing::info!(%error, "update check skipped: endpoint unreachable");
            Ok(offline(current_version))
        }
        Err(error) => Err(friendly_error(&error.to_string())),
    }
}

/// 下载最近一次 `check` 发现的包,校验签名后暂存;不替换 bundle。
/// 传输类错误重试 [`DOWNLOAD_ATTEMPTS`] 次;签名错误立刻放弃。同一时间只允许一个下载。
pub async fn download<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let state = app.state::<UpdateFlowState>();
    let update = {
        let mut inner = lock(state.inner());
        if inner.downloading {
            return Err("已经在下载了。".to_owned());
        }
        if let Some(staged) = &inner.staged {
            return Ok(staged.update.version.clone());
        }
        let Some(update) = inner.found.clone() else {
            return Err("还没有检查到可用的更新。".to_owned());
        };
        inner.downloading = true;
        update
    };
    let version = update.version.clone();
    let mut update = update;
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let mut last_error = String::new();
    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        let mut downloaded = 0u64;
        let progress_app = app.clone();
        let progress_version = version.clone();
        let result = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    emit(
                        &progress_app,
                        UpdateProgress::Downloading {
                            version: progress_version.clone(),
                            downloaded,
                            total,
                            attempt,
                        },
                    );
                },
                || {},
            )
            .await;
        match result {
            Ok(bytes) => {
                let mut inner = lock(state.inner());
                inner.staged = Some(Staged {
                    update: update.clone(),
                    bytes,
                });
                inner.downloading = false;
                drop(inner);
                emit(app, UpdateProgress::Staged { version: version.clone() });
                return Ok(version);
            }
            Err(error) => {
                last_error = error.to_string();
                tracing::warn!(%error, attempt, "update download failed");
                if !is_retryable(&error) || attempt == DOWNLOAD_ATTEMPTS {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
            }
        }
    }
    lock(state.inner()).downloading = false;
    let message = friendly_error(&last_error);
    emit(
        app,
        UpdateProgress::Error {
            version,
            message: message.clone(),
        },
    );
    Err(message)
}

/// 把暂存的包装进去(替换 bundle)。返回装了哪个版本;没有暂存返回 `None`。
pub fn install_staged<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let state = app.state::<UpdateFlowState>();
    let staged = lock(state.inner()).staged.take();
    let Some(staged) = staged else {
        return Ok(None);
    };
    let version = staged.update.version.clone();
    match staged.update.install(&staged.bytes) {
        Ok(()) => {
            emit(app, UpdateProgress::Installed { version: version.clone() });
            Ok(Some(version))
        }
        Err(error) => {
            // 装失败把包放回去:用户还能再点一次,不用重新下载。
            lock(state.inner()).staged = Some(staged);
            let message = friendly_error(&error.to_string());
            emit(
                app,
                UpdateProgress::Error {
                    version,
                    message: message.clone(),
                },
            );
            Err(message)
        }
    }
}

/// 退出钩子:有暂存包就替换。失败只记日志——退出路径上没人看得到错误。
pub fn install_staged_on_exit<R: Runtime>(app: &AppHandle<R>) {
    match install_staged(app) {
        Ok(Some(version)) => tracing::info!(version, "staged update installed on exit"),
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, "staged update could not be installed on exit"),
    }
}

/// 真机自测(`TRIPCUT_UPDATER_SELFTEST=1`,通常配合 `TRIPCUT_UPDATER_ENDPOINT`):启动后不经前端,
/// 直接跑「检查 → 后台下载暂存 → 退出」,退出钩子负责替换 bundle。下一次启动就该是新版本。
/// 结果打到 stderr(`update selftest: …`);没发现更新或失败也退出,退出码都是 0——判据看 bundle 版本。
pub fn spawn_selftest_if_requested<R: Runtime>(app: &AppHandle<R>) {
    if std::env::var("TRIPCUT_UPDATER_SELFTEST").ok().as_deref() != Some("1") {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let check = check(&app, "").await?;
            if !check.available {
                return Ok::<_, String>(format!("no update (offline={})", check.offline));
            }
            let version = download(&app).await?;
            Ok(format!("staged {version}"))
        }
        .await;
        // 这个仓库没装 tracing subscriber,自测结果直接打到 stderr 让探针能读到。
        match outcome {
            Ok(summary) => eprintln!("update selftest: {summary}; exiting"),
            Err(error) => eprintln!("update selftest: FAILED: {error}; exiting"),
        }
        app.exit(0);
    });
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> UpdateStatus {
    let state = app.state::<UpdateFlowState>();
    let inner = lock(state.inner());
    UpdateStatus {
        downloading: inner.downloading,
        staged_version: inner.staged.as_ref().map(|staged| staged.update.version.clone()),
        found_version: inner.found.as_ref().map(|update| update.version.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_error_names_signature_failures_and_links_the_dmg() {
        let message = friendly_error("The signature verification failed");
        assert!(message.starts_with("更新包签名校验失败"), "{message}");
        assert!(message.contains(DMG_FALLBACK_URL));
        assert!(message.contains("The signature verification failed"), "英文原文要留作证据");
    }

    #[test]
    fn friendly_error_treats_transport_failures_as_network() {
        let message = friendly_error("error sending request for url (https://x/y?X-Amz-Signature=abc)");
        // 传输错误的 URL 尾巴里带 Signature 也不能被判成签名失败——同 updaterClient.ts 的 R4 终审。
        assert!(!message.starts_with("更新包签名校验失败"), "{message}");
        assert!(message.starts_with("更新没有完成"), "{message}");
        assert!(message.contains(DMG_FALLBACK_URL));
    }

    #[test]
    fn friendly_error_explains_permission_and_missing_release() {
        assert!(friendly_error("Failed to move the new app into place (PermissionDenied)").starts_with("没有权限"));
        assert!(friendly_error("Could not fetch a valid release JSON from the remote").starts_with("更新服务器上暂时没有"));
    }

    #[test]
    fn auto_check_respects_switch_and_interval() {
        let now = 1_800_000_000;
        assert!(should_auto_check("true", None, now), "从没查过就查");
        assert!(should_auto_check("true", Some("garbage"), now), "解析不了当没查过");
        assert!(!should_auto_check("false", None, now), "开关关了不查");
        let recent = (now - 60).to_string();
        assert!(!should_auto_check("true", Some(&recent), now), "一分钟前查过不再查");
        let stale = (now - AUTO_CHECK_INTERVAL.as_secs()).to_string();
        assert!(should_auto_check("true", Some(&stale), now), "到点了就查");
    }

    #[test]
    fn progress_payload_serializes_with_kebab_phase() {
        let json = serde_json::to_value(UpdateProgress::Downloading {
            version: "0.8.0".into(),
            downloaded: 10,
            total: Some(100),
            attempt: 1,
        })
        .unwrap();
        assert_eq!(json["phase"], "downloading");
        assert_eq!(json["total"], 100);
        let staged = serde_json::to_value(UpdateProgress::Staged { version: "0.8.0".into() }).unwrap();
        assert_eq!(staged["phase"], "staged");
    }
}
