//! 新手友好供给:组件体检。正式包不下载或执行远程代码。
//!
//! 设计约束:
//! - FFmpeg/FFprobe/whisper-cli 必须来自签名 DMG；缺失时要求重新安装；
//! - Chinese-CLIP 的 Python 运行时尚未形成带哈希的签名组件包，因此不在线安装；
//! - Whisper 模型下载在固定版本与 SHA-256 清单落地前保持关闭。
//!
//! 回滚:无论组件是怎么落地到托管目录的(将来的签名安装、手工放置、还是
//! 已废弃的在线安装路径),只要它经过 `install_with_rollback` 落地,旧版本
//! 就会被保留为同目录下的 `<file>.prev`(只留一代,新安装会覆盖更早的
//! `.prev`)。`rollback_component` 用三步 rename 把 `.prev` 换回当前版本,
//! 而且这一步也会自检,自检失败会把刚才的交换原样撤销,绝不会把一个能跑的
//! 版本换丢。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::Connection;
use serde::Serialize;

use super::error::{CoreError, Result};

/// 本次进程运行期间,`sweep_rolling_orphans` 从孤儿 `.rolling` 恢复过的文件名
/// (如 `"ffmpeg"`)。只在启动时写入一次;`component_statuses` 据此把
/// `recovered_from_rolling` 置真,让用户知道刚才发生过一次崩溃恢复。
fn recovered_from_rolling_registry() -> &'static Mutex<HashSet<String>> {
    static REGISTRY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 三步交换(`swap_current_and_prev`)中途崩溃可能留下 `<name>.rolling`:
/// - 只有 `.rolling`,`<name>` 缺失 → 换步 1 之后、换步 2 之前中断;
///   把 `.rolling` 原样 rename 回 `<name>`,恢复成崩溃前的状态。
/// - `.rolling` 和 `<name>` 同时存在 → 换步 2 已完成(新版本已经是
///   `<name>`),只是换步 3(`.rolling` → `prev`)没跑完;`.rolling` 是
///   废弃的旧版本副本,直接删除。
/// - 干净目录(没有 `.rolling`)→ 不做任何事。
///
/// 在启动时对托管目录调用一次;每个被恢复的文件名记入
/// `recovered_from_rolling_registry`,供 `component_statuses` 展示。
pub fn sweep_rolling_orphans(managed_dir: &Path) -> Result<()> {
    let entries = match std::fs::read_dir(managed_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(CoreError::Io(error)),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(base_name) = file_name.strip_suffix(".rolling") else {
            continue;
        };
        let destination = managed_dir.join(base_name);
        if destination.is_file() {
            // 换步 2 已完成:destination 就是新版本,.rolling 是废弃的旧副本。
            std::fs::remove_file(&path)?;
            tracing::info!(
                component = base_name,
                "removed orphaned .rolling left over after a completed provisioning swap"
            );
        } else {
            // destination 缺失:换步 2 没跑完,.rolling 仍是唯一可用的版本。
            std::fs::rename(&path, &destination)?;
            recovered_from_rolling_registry()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(base_name.to_owned());
            tracing::info!(
                component = base_name,
                "recovered a component from an orphaned .rolling file after an interrupted provisioning swap"
            );
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ComponentStatus {
    pub id: String,
    pub title: String,
    pub installed: bool,
    pub detail: String,
    pub installable: bool,
    pub approx_size_mb: u64,
    /// 托管目录里是否留有可回滚的上一版本(`<file>.prev`)。
    pub has_previous: bool,
    /// 上一版本的版本串(来自 `-version` 输出的第一行);拿不到时为 None。
    pub previous_version: Option<String>,
    /// 本次进程启动时,`sweep_rolling_orphans` 是否从一个孤儿 `.rolling`
    /// 文件恢复过这个组件(即上次进程在三步交换的换步 2 之前崩溃)。
    pub recovered_from_rolling: bool,
    /// R10 U-24:只有 `whisper-model` 填——官方下载地址、期望 SHA-256、目标路径,
    /// 让「模型缺失」变成一条可执行的路径(其它组件为 `None`)。
    pub download_url: Option<String>,
    pub expected_sha256: Option<String>,
    pub target_path: Option<String>,
}

/// R10 U-24:`import_whisper_model` 的结果。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WhisperModelImportOutcome {
    /// 按文件 SHA-256 识别出的模型档(`large-v3-turbo` / `small`)。
    pub tier: String,
    pub file_name: String,
    pub target_path: String,
    pub sha256: String,
    /// 导入的档是否就是设置里当前选的档;不是时前端可提示切换 `tools.whisper_model_tier`。
    pub matches_active_tier: bool,
}

/// 流式算 SHA-256(模型 0.5–1.6 GB,不能整段读进内存)。
pub fn sha256_of_file(path: &Path) -> Result<String> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// R10 U-24:把用户自己下载的模型文件校验后放进 models 目录。
/// 1. 算 SHA-256,必须命中 `transcribe::WHISPER_MODEL_SPECS` 里某一档的期望值——
///    档由摘要决定,不由文件名决定(用户改过名也认);不匹配则拒绝并把两档期望值
///    都列出来。
/// 2. 先复制到 `models/<file>.staging`,再走 `install_with_rollback` 原子落位
///    (已有同名旧文件备份成 `.prev`,自检失败自动换回)。
///
/// 源文件不动。
pub fn import_whisper_model(connection: &Connection, source: &Path) -> Result<WhisperModelImportOutcome> {
    let active_tier = super::settings::whisper_model_tier(connection)?;
    import_whisper_model_into(
        source,
        &models_dir()?,
        &active_tier,
        &super::transcribe::WHISPER_MODEL_SPECS,
    )
}

/// `import_whisper_model` 的可注入内核:models 目录、当前档、期望摘要表都由调用方给,
/// 测试不用动 `TRIPCUT_APP_SUPPORT_DIR`(进程级环境变量,并行测试会互相踩)。
pub(crate) fn import_whisper_model_into(
    source: &Path,
    models: &Path,
    active_tier: &str,
    specs: &[super::transcribe::WhisperModelSpec],
) -> Result<WhisperModelImportOutcome> {
    if !source.is_file() {
        return Err(CoreError::Io(std::io::Error::other(format!(
            "模型文件不存在:{}",
            source.display()
        ))));
    }
    let sha256 = sha256_of_file(source)?;
    let Some(spec) = specs.iter().find(|spec| spec.expected_sha256 == sha256) else {
        let expected = specs
            .iter()
            .map(|spec| format!("{}({})= {}", spec.file_name, spec.tier, spec.expected_sha256))
            .collect::<Vec<_>>()
            .join(";");
        return Err(CoreError::Io(std::io::Error::other(format!(
            "SHA-256 不匹配任何受支持的 Whisper 模型,已拒绝导入。文件摘要 {sha256};期望 {expected}"
        ))));
    };
    std::fs::create_dir_all(models)?;
    let destination = models.join(spec.file_name);
    let staged = models.join(format!("{}.staging", spec.file_name));
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(source, &staged)?;
    let expected_size = std::fs::metadata(source)?.len();
    let install = install_with_rollback(&destination, &staged, |installed| {
        verify_file_nonempty(installed)?;
        let size = std::fs::metadata(installed)?.len();
        if size != expected_size {
            return Err(CoreError::Io(std::io::Error::other(
                "模型复制后大小不一致,已回滚",
            )));
        }
        Ok(())
    });
    let _ = std::fs::remove_file(&staged);
    install?;
    Ok(WhisperModelImportOutcome {
        tier: spec.tier.to_owned(),
        file_name: spec.file_name.to_owned(),
        target_path: destination.to_string_lossy().into_owned(),
        sha256,
        matches_active_tier: active_tier == spec.tier,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InstallProgress {
    pub component: String,
    pub phase: String,
    pub downloaded_bytes: u64,
    pub total_hint_mb: u64,
    pub done: bool,
    pub error: Option<String>,
}

pub fn managed_bin_dir() -> Result<PathBuf> {
    let root = crate::app_paths::app_support_root().ok_or_else(|| {
        CoreError::Io(std::io::Error::other(
            "neither TRIPCUT_APP_SUPPORT_DIR nor HOME is set",
        ))
    })?;
    Ok(root.join("bin"))
}

pub fn models_dir() -> Result<PathBuf> {
    let root = crate::app_paths::app_support_root().ok_or_else(|| {
        CoreError::Io(std::io::Error::other(
            "neither TRIPCUT_APP_SUPPORT_DIR nor HOME is set",
        ))
    })?;
    Ok(root.join("models"))
}

/// 同目录下的 `.prev` 备份路径。
fn prev_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("component");
    path.with_file_name(format!("{file_name}.prev"))
}

/// 同目录下用于三步交换的临时路径,避免中途中断丢失任一版本。
fn rolling_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("component");
    path.with_file_name(format!("{file_name}.rolling"))
}

/// 实跑 `-version`,失败说明这个可执行文件装坏了。
fn verify_executable_runs(path: &Path) -> Result<()> {
    let output = Command::new(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| {
            CoreError::Io(std::io::Error::other(format!("安装的程序无法运行:{error}")))
        })?;
    if !output.status.success() {
        return Err(CoreError::Io(std::io::Error::other(
            "安装的程序无法正常启动,已回滚",
        )));
    }
    Ok(())
}

/// 数据文件(如 whisper 模型)没有 `-version`,自检退化为「非空文件」。
fn verify_file_nonempty(path: &Path) -> Result<()> {
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 {
        return Err(CoreError::Io(std::io::Error::other(
            "文件为空,自检失败,已回滚",
        )));
    }
    Ok(())
}

/// 尽力读取一个可执行文件的版本串(`-version` 输出的第一行);跑不起来则 None。
fn probe_version(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let output = Command::new(path)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    let text = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        String::from_utf8_lossy(&output.stderr).into_owned()
    };
    text.lines().next().map(|line| line.trim().to_owned())
}

/// 把 `staged_source` 原子地装到 `destination`,装之前把现有文件备份为
/// `<file>.prev`(只留一代);装完用 `self_check` 校验,失败则把 `.prev`
/// 换回来并返回错误(自动回滚),成功则保留 `.prev` 供之后手动回滚。
///
/// 目前没有生产调用点:`install_component` 是商用构建的硬门,不落任何文件
/// (见文件顶部说明),因此这条原子安装+自检+备份链路只被测试直接调用。
/// 保留为 `pub(crate)` 是为了在「签名组件包」或「手工侧载单个组件」这类
/// 未来能力落地时,复用这里已经踩过坑的自动回滚语义,而不是让那天的实现
/// 重新发明一遍原子替换。
#[allow(dead_code)]
pub(crate) fn install_with_rollback(
    destination: &Path,
    staged_source: &Path,
    self_check: impl Fn(&Path) -> Result<()>,
) -> Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let prev = prev_path_for(destination);
    let had_previous_file = destination.is_file();
    if had_previous_file {
        let _ = std::fs::remove_file(&prev);
        std::fs::rename(destination, &prev)?;
    }

    let install_result = std::fs::rename(staged_source, destination)
        .or_else(|_| std::fs::copy(staged_source, destination).map(|_| ()));
    if let Err(error) = install_result {
        // 落地这一步都没成功,把旧版本换回去,不留半装状态。
        if had_previous_file {
            let _ = std::fs::rename(&prev, destination);
        }
        return Err(CoreError::Io(error));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(destination) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(permissions.mode() | 0o111);
            let _ = std::fs::set_permissions(destination, permissions);
        }
    }
    let _ = Command::new("/usr/bin/xattr")
        .args(["-d", "com.apple.quarantine"])
        .arg(destination)
        .status();

    if let Err(error) = self_check(destination) {
        let _ = std::fs::remove_file(destination);
        if had_previous_file {
            std::fs::rename(&prev, destination)?;
        }
        return Err(error);
    }
    Ok(())
}

/// 把 `destination` 和它的 `.prev` 互换。要求 `.prev` 存在;中途用
/// `.rolling` 临时名,保证任一步中断都不会同时丢失两个版本。
fn swap_current_and_prev(destination: &Path, prev: &Path) -> Result<()> {
    if !prev.is_file() {
        return Err(CoreError::Io(std::io::Error::other(
            "没有可回滚的上一版本",
        )));
    }
    let rolling = rolling_path_for(destination);
    let _ = std::fs::remove_file(&rolling);
    let had_current = destination.is_file();
    if had_current {
        std::fs::rename(destination, &rolling)?;
    }
    std::fs::rename(prev, destination)?;
    if had_current {
        std::fs::rename(&rolling, prev)?;
    }
    Ok(())
}

/// 把 `destination` 换回 `.prev` 保存的上一版本,并自检;自检失败会把这次
/// 交换原样撤销(即换回失败前的当前版本),保证不会把一个能跑的版本弄丢。
fn rollback_with_selfcheck(destination: &Path, self_check: impl Fn(&Path) -> Result<()>) -> Result<()> {
    let prev = prev_path_for(destination);
    swap_current_and_prev(destination, &prev)?;
    if let Err(error) = self_check(destination) {
        let _ = swap_current_and_prev(destination, &prev);
        return Err(error);
    }
    Ok(())
}

fn component_title(component: &str) -> String {
    match component {
        "ffmpeg" => "视频处理组件(FFmpeg)",
        "ffprobe" => "媒体信息组件(FFprobe)",
        "whisper-cli" => "转写组件(Whisper)",
        "whisper-model" => "转写模型",
        "clip-sidecar" => "画面识别组件",
        other => return other.to_owned(),
    }
    .to_owned()
}

/// 组件在托管目录里的落地路径;只有真正会被 `install_with_rollback` 写入
/// 托管目录的组件才支持回滚(clip-sidecar 是整套服务安装,不是单文件,不在此列)。
fn managed_path_for(component: &str, model_tier: &str) -> Result<Option<PathBuf>> {
    Ok(match component {
        "ffmpeg" | "ffprobe" | "whisper-cli" => Some(managed_bin_dir()?.join(component)),
        "whisper-model" => Some(models_dir()?.join(super::settings::model_file_for_tier(model_tier))),
        _ => None,
    })
}

fn self_check_for(component: &str) -> impl Fn(&Path) -> Result<()> {
    let is_binary = matches!(component, "ffmpeg" | "ffprobe" | "whisper-cli");
    move |path: &Path| {
        if is_binary {
            verify_executable_runs(path)
        } else {
            verify_file_nonempty(path)
        }
    }
}

/// 这个组件的托管文件名(如 `"ffmpeg"`)本次启动是否被
/// `sweep_rolling_orphans` 从孤儿 `.rolling` 恢复过。
fn recovered_flag_for(component: &str, model_tier: &str) -> bool {
    let Ok(Some(path)) = managed_path_for(component, model_tier) else {
        return false;
    };
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    recovered_from_rolling_registry()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(file_name)
}

/// 单个组件当前的回滚状态,不依赖数据库连接。
fn component_status_single(component: &str, model_tier: &str) -> Result<ComponentStatus> {
    let destination = managed_path_for(component, model_tier)?;
    let (installed, detail, has_previous, previous_version) = match &destination {
        Some(path) => {
            let prev = prev_path_for(path);
            let installed = path.is_file();
            let detail = if installed {
                path.display().to_string()
            } else {
                "未安装".into()
            };
            (installed, detail, prev.is_file(), probe_version(&prev))
        }
        None => (false, "组件不支持回滚".into(), false, None),
    };
    Ok(ComponentStatus {
        id: component.into(),
        title: component_title(component),
        installed,
        detail,
        installable: false,
        approx_size_mb: 0,
        has_previous,
        previous_version,
        recovered_from_rolling: recovered_flag_for(component, model_tier),
        download_url: None,
        expected_sha256: None,
        target_path: None,
    })
}

/// 手动回滚一个组件到上一版本;自检失败会自动撤销这次回滚。
pub fn rollback_component(component: &str, model_tier: &str) -> Result<ComponentStatus> {
    let destination = managed_path_for(component, model_tier)?.ok_or_else(|| {
        CoreError::Io(std::io::Error::other(format!(
            "组件 {component} 不支持回滚"
        )))
    })?;
    rollback_with_selfcheck(&destination, self_check_for(component))?;
    component_status_single(component, model_tier)
}

/// [`rollback_component`] 前置一道闸:批量任务是每个片段各自新起一个子进程,
/// 跑到一半回滚 ffmpeg/whisper-cli 会让同一批次的产出混着新旧两种二进制。
/// 只读窗口(`lib.rs` 里已有的检查)挡的是"这份工程当前不可写";这里额外挡
/// "当前有任务在跑",且必须在触碰任何文件之前生效。
pub fn rollback_component_guarded(
    connection: &Connection,
    component: &str,
    model_tier: &str,
) -> Result<ComponentStatus> {
    let running: i64 = connection.query_row(
        "SELECT COUNT(*) FROM jobs WHERE status = 'running'",
        [],
        |row| row.get(0),
    )?;
    if running > 0 {
        return Err(CoreError::InvalidTransition(
            "有任务正在运行，请等待完成后再回滚".to_owned(),
        ));
    }
    rollback_component(component, model_tier)
}

/// R16 P2-6:删除一档已导入的转写模型文件(`models/<file>` 连同 `.prev` 备份)。不可逆,
/// 确认在界面做;有转写任务在跑时拒绝(与回滚同一道闸)。文件本来就不在 = 无事可做,不算错。
pub fn delete_whisper_model(connection: &Connection, tier: &str) -> Result<u64> {
    let running: i64 = connection.query_row(
        "SELECT COUNT(*) FROM jobs WHERE status = 'running' AND kind = 'transcribe'",
        [],
        |row| row.get(0),
    )?;
    if running > 0 {
        return Err(CoreError::InvalidTransition(
            "有转写任务正在运行,请等它完成后再删除模型".to_owned(),
        ));
    }
    delete_whisper_model_in(&models_dir()?, tier)
}

/// `delete_whisper_model` 的可注入内核:返回释放的字节数。
pub(crate) fn delete_whisper_model_in(models: &Path, tier: &str) -> Result<u64> {
    if !matches!(tier, "large-v3-turbo" | "small") {
        return Err(CoreError::InvalidSchema(format!("未知的转写模型档:{tier}")));
    }
    let destination = models.join(super::settings::model_file_for_tier(tier));
    let mut freed = 0_u64;
    for path in [destination.clone(), prev_path_for(&destination)] {
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                freed = freed.saturating_add(metadata.len());
                std::fs::remove_file(&path)?;
            }
            _ => {}
        }
    }
    Ok(freed)
}

/// R16 P2-6:删除 `luts/` 里的一个 `.cube`。只认**文件名**(不接受路径,挡住目录穿越),
/// 顺手把引用它的 `clips.display_lut_path` 清掉(否则播放器下次会拿一个不存在的文件)。
/// 返回删后完整列表(与 `list_display_luts` 同形)。
pub fn delete_display_lut(connection: &Connection, luts_dir: &Path, name: &str) -> Result<Vec<PathBuf>> {
    let is_plain_name = !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && name != "."
        && name != "..";
    let is_cube = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cube"));
    if !is_plain_name || !is_cube {
        return Err(CoreError::Player(format!("不是可删除的调色文件名:{name}")));
    }
    let target = luts_dir.join(name);
    if target.is_file() {
        std::fs::remove_file(&target)?;
    }
    connection.execute(
        "UPDATE clips SET display_lut_path = NULL WHERE display_lut_path = ?1",
        [target.to_string_lossy().as_ref()],
    )?;
    super::player_prefs::list_display_luts(luts_dir)
}

pub fn component_statuses(connection: &Connection) -> Result<Vec<ComponentStatus>> {
    let cache_root = super::channel_memory::channel_path_for_project(connection)
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("cache")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let settings = super::settings::status(connection, &cache_root)?;
    let model_tier = super::settings::whisper_model_tier(connection)?;
    let model_file = super::settings::model_file_for_tier(&model_tier);
    let model_ok = models_dir()?.join(model_file).is_file();

    let previous_of = |component: &str| -> (bool, Option<String>) {
        match managed_path_for(component, &model_tier) {
            Ok(Some(path)) => {
                let prev = prev_path_for(&path);
                (prev.is_file(), probe_version(&prev))
            }
            _ => (false, None),
        }
    };

    let mut list = Vec::new();
    let (ffmpeg_prev, ffmpeg_prev_version) = previous_of("ffmpeg");
    list.push(ComponentStatus {
        id: "ffmpeg".into(),
        title: "视频处理组件(FFmpeg)".into(),
        installed: settings.ffmpeg.available,
        detail: if settings.ffmpeg.available {
            settings.ffmpeg.resolved_path.clone()
        } else {
            "正式组件缺失；请重新安装完整签名 DMG".into()
        },
        installable: false,
        approx_size_mb: 0,
        has_previous: ffmpeg_prev,
        previous_version: ffmpeg_prev_version,
        recovered_from_rolling: recovered_flag_for("ffmpeg", &model_tier),
        download_url: None,
        expected_sha256: None,
        target_path: None,
    });
    let (ffprobe_prev, ffprobe_prev_version) = previous_of("ffprobe");
    list.push(ComponentStatus {
        id: "ffprobe".into(),
        title: "媒体信息组件(FFprobe)".into(),
        installed: settings.ffprobe.available,
        detail: if settings.ffprobe.available {
            settings.ffprobe.resolved_path.clone()
        } else {
            "正式组件缺失；请重新安装完整签名 DMG".into()
        },
        installable: false,
        approx_size_mb: 0,
        has_previous: ffprobe_prev,
        previous_version: ffprobe_prev_version,
        recovered_from_rolling: recovered_flag_for("ffprobe", &model_tier),
        download_url: None,
        expected_sha256: None,
        target_path: None,
    });
    let (whisper_cli_prev, whisper_cli_prev_version) = previous_of("whisper-cli");
    list.push(ComponentStatus {
        id: "whisper-cli".into(),
        title: "转写组件(Whisper)".into(),
        installed: settings.whisper.binary.available,
        detail: if settings.whisper.binary.available {
            settings.whisper.binary.resolved_path.clone()
        } else {
            "正式组件缺失；请重新安装完整签名 DMG".into()
        },
        installable: false,
        approx_size_mb: 0,
        has_previous: whisper_cli_prev,
        previous_version: whisper_cli_prev_version,
        recovered_from_rolling: recovered_flag_for("whisper-cli", &model_tier),
        download_url: None,
        expected_sha256: None,
        target_path: None,
    });
    let (model_prev, model_prev_version) = previous_of("whisper-model");
    let model_spec = super::transcribe::model_spec_for_tier(&model_tier);
    let model_target = models_dir()?.join(model_file);
    list.push(ComponentStatus {
        id: "whisper-model".into(),
        title: format!("转写模型({model_tier})"),
        installed: model_ok,
        detail: if model_ok {
            "已就绪".into()
        } else {
            format!(
                "缺少 {}:从官方地址下载后用「导入模型文件…」导入(会校验 SHA-256),或自行放到 {}",
                model_spec.file_name,
                model_target.display()
            )
        },
        installable: false,
        approx_size_mb: model_spec.size_bytes / (1024 * 1024),
        has_previous: model_prev,
        previous_version: model_prev_version,
        recovered_from_rolling: recovered_flag_for("whisper-model", &model_tier),
        download_url: Some(model_spec.download_url.to_owned()),
        expected_sha256: Some(model_spec.expected_sha256.to_owned()),
        target_path: Some(model_target.to_string_lossy().into_owned()),
    });
    list.push(ComponentStatus {
        id: "clip-sidecar".into(),
        title: "画面识别组件".into(),
        installed: settings.clip_sidecar.available && settings.clip_sidecar.service_available,
        detail: if settings.clip_sidecar.available && settings.clip_sidecar.service_available {
            settings.clip_sidecar.note.clone()
        } else {
            "正式版不在线安装；等待带签名的组件包".into()
        },
        installable: false,
        approx_size_mb: 0,
        has_previous: false,
        previous_version: None,
        recovered_from_rolling: false,
        download_url: None,
        expected_sha256: None,
        target_path: None,
    });
    Ok(list)
}

/// 商用构建的后端硬门：不得下载或执行远程组件。
pub fn install_component(
    component: &str,
    _model_tier: &str,
    _running: Arc<AtomicBool>,
) -> Result<String> {
    Err(CoreError::Io(std::io::Error::other(format!(
        "正式版禁止在线安装组件 {component}；请重新安装完整签名 DMG"
    ))))
}

/// 供进度轮询:返回 (下载中文件字节数, 是否存在)。
pub fn download_progress(_component: &str, _model_tier: &str) -> Result<u64> {
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, jobs};
    use crate::core::test_support::TestDirectory;

    /// 写一个会打印版本号、exit 0 的假可执行脚本(模拟 ffmpeg/ffprobe/whisper-cli)。
    fn write_fake_binary(path: &Path, version_line: &str) {
        std::fs::write(
            path,
            format!("#!/bin/sh\necho \"{version_line}\"\nexit 0\n"),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// 写一个总是以非零码退出的假脚本,模拟自检失败(装坏的可执行文件)。
    fn write_failing_binary(path: &Path) {
        std::fs::write(path, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    // ---- R10 U-24:导入 Whisper 模型文件 ----

    fn fake_spec(file_name: &'static str, tier: &'static str, sha: &str) -> crate::core::transcribe::WhisperModelSpec {
        crate::core::transcribe::WhisperModelSpec {
            tier,
            file_name,
            download_url: "https://example.invalid/model.bin",
            expected_sha256: Box::leak(sha.to_owned().into_boxed_str()),
            size_bytes: 0,
        }
    }

    #[test]
    fn sha256_of_file_matches_a_known_digest() {
        let directory = TestDirectory::new();
        let path = directory.path().join("abc.txt");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_of_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn importing_a_model_with_the_wrong_digest_is_refused_and_leaves_models_dir_untouched() {
        let directory = TestDirectory::new();
        let source = directory.path().join("ggml-small.bin");
        std::fs::write(&source, b"not the real model").unwrap();
        let models = directory.path().join("models");
        let error = import_whisper_model_into(
            &source,
            &models,
            "small",
            &crate::core::transcribe::WHISPER_MODEL_SPECS,
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("SHA-256 不匹配"), "{message}");
        assert!(message.contains("1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"));
        assert!(!models.join("ggml-small.bin").exists());
        assert!(!models.join("ggml-small.bin.staging").exists());
        assert!(source.is_file(), "源文件不动");
    }

    #[test]
    fn importing_a_verified_model_copies_it_into_models_dir_by_digest_not_by_name() {
        let directory = TestDirectory::new();
        // 用户改过名的文件也认——档由摘要决定。
        let source = directory.path().join("下载 (1).bin");
        std::fs::write(&source, b"pretend model bytes").unwrap();
        let sha = sha256_of_file(&source).unwrap();
        let specs = [fake_spec("ggml-small.bin", "small", &sha)];
        let models = directory.path().join("models");
        let outcome = import_whisper_model_into(&source, &models, "large-v3-turbo", &specs).unwrap();
        assert_eq!(outcome.tier, "small");
        assert_eq!(outcome.file_name, "ggml-small.bin");
        assert_eq!(outcome.sha256, sha);
        assert!(!outcome.matches_active_tier);
        assert_eq!(std::fs::read(models.join("ggml-small.bin")).unwrap(), b"pretend model bytes");
        assert!(!models.join("ggml-small.bin.staging").exists());
        assert!(source.is_file(), "源文件不动");
        // 再导一次:旧文件备份成 .prev,新文件落位。
        std::fs::write(&source, b"pretend model bytes v2").unwrap();
        let sha2 = sha256_of_file(&source).unwrap();
        let specs = [fake_spec("ggml-small.bin", "small", &sha2)];
        let outcome = import_whisper_model_into(&source, &models, "small", &specs).unwrap();
        assert!(outcome.matches_active_tier);
        assert_eq!(std::fs::read(models.join("ggml-small.bin")).unwrap(), b"pretend model bytes v2");
        assert_eq!(std::fs::read(models.join("ggml-small.bin.prev")).unwrap(), b"pretend model bytes");
    }

    #[test]
    fn whisper_model_status_carries_official_url_digest_and_target_path() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let statuses = component_statuses(&connection).unwrap();
        let model = statuses.iter().find(|status| status.id == "whisper-model").unwrap();
        assert_eq!(
            model.download_url.as_deref(),
            Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin")
        );
        assert_eq!(
            model.expected_sha256.as_deref(),
            Some("1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69")
        );
        assert!(model
            .target_path
            .as_deref()
            .is_some_and(|path| path.ends_with("models/ggml-large-v3-turbo.bin")));
        assert!(model.approx_size_mb > 1_000);
        for other in statuses.iter().filter(|status| status.id != "whisper-model") {
            assert!(other.download_url.is_none() && other.expected_sha256.is_none() && other.target_path.is_none());
        }
    }

    #[test]
    fn every_online_component_install_is_refused_before_work_starts() {
        for component in ["ffmpeg", "ffprobe", "whisper-model", "clip-sidecar", "nope"] {
            let error = install_component(component, "small", Arc::new(AtomicBool::new(true)))
                .unwrap_err();
            assert!(error.to_string().contains("禁止在线安装"));
        }
    }

    #[test]
    fn managed_dirs_are_under_app_support() {
        assert!(managed_bin_dir().unwrap().ends_with("TripCutStudio/bin"));
        assert!(models_dir().unwrap().ends_with("TripCutStudio/models"));
    }

    #[test]
    fn install_v2_over_v1_keeps_v1_as_prev() {
        let directory = TestDirectory::new();
        let destination = directory.path().join("whisper-cli");
        let staged = directory.path().join("incoming");

        write_fake_binary(&destination, "v1.0.0");
        write_fake_binary(&staged, "v2.0.0");

        install_with_rollback(&destination, &staged, verify_executable_runs).unwrap();

        let prev = prev_path_for(&destination);
        assert!(prev.is_file(), ".prev 应保留旧版本");
        assert_eq!(probe_version(&prev).as_deref(), Some("v1.0.0"));
        assert_eq!(probe_version(&destination).as_deref(), Some("v2.0.0"));
    }

    #[test]
    fn rollback_swaps_current_and_prev_and_selfchecks() {
        let directory = TestDirectory::new();
        let destination = directory.path().join("whisper-cli");
        let staged = directory.path().join("incoming");

        write_fake_binary(&destination, "v1.0.0");
        write_fake_binary(&staged, "v2.0.0");
        install_with_rollback(&destination, &staged, verify_executable_runs).unwrap();
        assert_eq!(probe_version(&destination).as_deref(), Some("v2.0.0"));

        rollback_with_selfcheck(&destination, verify_executable_runs).unwrap();

        assert_eq!(probe_version(&destination).as_deref(), Some("v1.0.0"), "回滚后应恢复 v1");
        let prev = prev_path_for(&destination);
        assert_eq!(probe_version(&prev).as_deref(), Some("v2.0.0"), ".prev 应改持有 v2");
    }

    #[test]
    fn failed_self_check_on_install_auto_rolls_back() {
        let directory = TestDirectory::new();
        let destination = directory.path().join("whisper-cli");
        let staged = directory.path().join("incoming");

        write_fake_binary(&destination, "v1.0.0");
        write_failing_binary(&staged);

        let error =
            install_with_rollback(&destination, &staged, verify_executable_runs)
                .unwrap_err();
        assert!(error.to_string().contains("已回滚"));

        // v1 必须原样恢复,且必须能跑。
        assert_eq!(probe_version(&destination).as_deref(), Some("v1.0.0"));
        assert!(!prev_path_for(&destination).is_file(), "自检失败时不应留下 .prev");
    }

    #[test]
    fn has_previous_reflects_reality() {
        let directory = TestDirectory::new();
        let destination = directory.path().join("whisper-cli");
        let staged = directory.path().join("incoming");

        write_fake_binary(&destination, "v1.0.0");
        assert!(!prev_path_for(&destination).is_file());

        write_fake_binary(&staged, "v2.0.0");
        install_with_rollback(&destination, &staged, verify_executable_runs).unwrap();
        assert!(prev_path_for(&destination).is_file());
    }

    #[test]
    fn rollback_without_previous_version_is_refused() {
        let directory = TestDirectory::new();
        let destination = directory.path().join("whisper-cli");
        write_fake_binary(&destination, "v1.0.0");

        let error = rollback_with_selfcheck(&destination, verify_executable_runs)
            .unwrap_err();
        assert!(error.to_string().contains("没有可回滚的上一版本"));
        // 当前版本必须原封不动。
        assert_eq!(probe_version(&destination).as_deref(), Some("v1.0.0"));
    }

    #[test]
    fn model_file_selfcheck_is_nonempty_check() {
        let directory = TestDirectory::new();
        let destination = directory.path().join("model.bin");
        let staged = directory.path().join("incoming.bin");

        std::fs::write(&destination, b"v1-bytes").unwrap();
        std::fs::write(&staged, b"").unwrap(); // 空文件,模拟下载被截断

        let error =
            install_with_rollback(&destination, &staged, verify_file_nonempty).unwrap_err();
        assert!(error.to_string().contains("自检失败"));
        assert_eq!(std::fs::read(&destination).unwrap(), b"v1-bytes", "应回滚到原文件");
    }

    #[test]
    fn sweep_recovers_a_rolling_orphan_when_destination_is_missing() {
        // 换步 1(destination → .rolling)完成、换步 2(prev → destination)
        // 之前崩溃:目录里只有 .rolling,destination 缺失。
        let directory = TestDirectory::new();
        let name = "sweep-recover-missing";
        let rolling = directory.path().join(format!("{name}.rolling"));
        write_fake_binary(&rolling, "v1.0.0");
        let destination = directory.path().join(name);
        assert!(!destination.is_file());

        sweep_rolling_orphans(directory.path()).unwrap();

        assert!(destination.is_file(), ".rolling 应被恢复为原文件名");
        assert!(!rolling.is_file(), "恢复后不应再留下 .rolling");
        assert_eq!(probe_version(&destination).as_deref(), Some("v1.0.0"));
        assert!(
            recovered_from_rolling_registry()
                .lock()
                .unwrap()
                .contains(name),
            "应记入 recovered_from_rolling 登记表"
        );
    }

    #[test]
    fn sweep_deletes_a_rolling_orphan_when_destination_already_exists() {
        // 换步 2(prev → destination)已完成,只是换步 3
        // (.rolling → prev)没跑完:destination 和 .rolling 同时存在,
        // .rolling 是废弃的旧版本副本,应直接删除。
        let directory = TestDirectory::new();
        let name = "sweep-clean-both";
        let destination = directory.path().join(name);
        let rolling = directory.path().join(format!("{name}.rolling"));
        write_fake_binary(&destination, "v2.0.0");
        write_fake_binary(&rolling, "v1.0.0");

        sweep_rolling_orphans(directory.path()).unwrap();

        assert!(destination.is_file(), "已完成换步的 destination 不应被动");
        assert_eq!(probe_version(&destination).as_deref(), Some("v2.0.0"));
        assert!(!rolling.is_file(), "废弃的 .rolling 应被删除");
        assert!(
            !recovered_from_rolling_registry()
                .lock()
                .unwrap()
                .contains(name),
            "此情形是清理而非恢复,不应记入登记表"
        );
    }

    #[test]
    fn sweep_on_a_clean_directory_is_a_noop() {
        let directory = TestDirectory::new();
        let name = "sweep-clean-dir";
        let destination = directory.path().join(name);
        write_fake_binary(&destination, "v1.0.0");

        sweep_rolling_orphans(directory.path()).unwrap();

        assert!(destination.is_file());
        assert_eq!(probe_version(&destination).as_deref(), Some("v1.0.0"));
        assert!(
            !recovered_from_rolling_registry()
                .lock()
                .unwrap()
                .contains(name)
        );
    }

    /// 批量任务是每片段各自新起一个子进程;跑到一半回滚 ffmpeg/whisper 会让
    /// 同一批次产出混着新旧两种二进制。只读窗口挡的是"工程当前不可写",
    /// 这条额外挡"当前有任务在跑",在真正触碰任何文件之前就必须生效。
    #[test]
    fn rollback_component_guarded_refuses_while_a_job_is_running() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        jobs::enqueue(&mut connection, "noop", "{}", "guard-running").unwrap();
        jobs::claim_next(&mut connection).unwrap().unwrap();

        // 故意用一个不认识的组件名("nope")——它在真正的 rollback_component
        // 内部会报"不支持回滚",这里绝不能看到那句话,否则说明请求已经穿透
        // 闸门碰到了真实的(会触碰 app-support 目录下真实文件的)回滚逻辑。
        let error = rollback_component_guarded(&connection, "nope", "large-v3-turbo")
            .unwrap_err();
        assert!(
            error.to_string().contains("有任务正在运行，请等待完成后再回滚"),
            "实际错误：{error}"
        );
        assert!(
            !error.to_string().contains("不支持回滚") && !error.to_string().contains("没有可回滚"),
            "有任务在跑时不应该跑到真正的回滚逻辑：{error}"
        );
    }

    #[test]
    fn rollback_component_guarded_proceeds_as_before_when_no_job_is_running() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        // 不认识的组件名会在真正的 rollback_component 内部报"不支持回滚"——
        // 用它来证明闸门放行了,请求确实穿透到了原有逻辑,而不是被吞掉或
        // 提前返回成功。
        let error = rollback_component_guarded(&connection, "nope", "large-v3-turbo")
            .unwrap_err();
        assert!(
            error.to_string().contains("不支持回滚"),
            "没有任务在跑时应该像此前一样放行到 rollback_component 本体：{error}"
        );
    }

    /// R16 P2-6:删模型连 `.prev` 一起删并报释放字节;未知档拒绝;不在 = 0。
    #[test]
    fn delete_whisper_model_removes_file_and_prev_backup() {
        let directory = TestDirectory::new();
        let models = directory.path().join("models");
        std::fs::create_dir_all(&models).unwrap();
        let file = models.join(crate::core::settings::model_file_for_tier("small"));
        std::fs::write(&file, b"12345").unwrap();
        std::fs::write(prev_path_for(&file), b"123").unwrap();
        assert_eq!(delete_whisper_model_in(&models, "small").unwrap(), 8);
        assert!(!file.exists() && !prev_path_for(&file).exists());
        assert_eq!(delete_whisper_model_in(&models, "small").unwrap(), 0);
        assert!(delete_whisper_model_in(&models, "medium").is_err());
    }

    /// R16 P2-6:删 LUT 只认文件名、清掉引用它的素材偏好、返回剩余列表。
    #[test]
    fn delete_display_lut_refuses_paths_and_clears_clip_references() {
        let directory = TestDirectory::new();
        let luts = directory.path().join("luts");
        std::fs::create_dir_all(&luts).unwrap();
        std::fs::write(luts.join("Teal.cube"), b"LUT_3D_SIZE 2").unwrap();
        std::fs::write(luts.join("Warm.cube"), b"LUT_3D_SIZE 2").unwrap();
        let connection = crate::core::db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, display_lut_path) VALUES (1, 'v', 'a.mov', ?1), (2, 'v', 'b.mov', ?2)",
                [luts.join("Teal.cube").to_string_lossy().as_ref(), luts.join("Warm.cube").to_string_lossy().as_ref()],
            )
            .unwrap();
        assert!(delete_display_lut(&connection, &luts, "../Teal.cube").is_err());
        assert!(delete_display_lut(&connection, &luts, "notes.txt").is_err());
        let remaining = delete_display_lut(&connection, &luts, "Teal.cube").unwrap();
        assert_eq!(remaining, vec![luts.join("Warm.cube")]);
        let (a, b): (Option<String>, Option<String>) = connection
            .query_row("SELECT (SELECT display_lut_path FROM clips WHERE id=1), (SELECT display_lut_path FROM clips WHERE id=2)", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert!(a.is_none(), "引用被删 LUT 的素材要清掉偏好");
        assert!(b.is_some(), "别的 LUT 不动");
    }
}
