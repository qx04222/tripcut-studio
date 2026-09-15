//! R18 车道 native2 / M-10:外置卷弹出与 iCloud 没下载到本机。
//!
//! 两件事看起来都像"文件读不到",但对用户该说的话完全不同:
//! - 盘拔了 → 「那块盘不在了,插回去就好」。**不是错误**,不该刷一屏红字;
//! - iCloud 只有占位 → 「这条在 iCloud 里没下载到本机」,而且我们能替他下。
//!
//! 分不清这两者,就会把"插回去就好"说成"导入失败",用户只会以为软件坏了。
//!
//! 判定(`classify_from_facts`)是纯函数,事实(存不存在 / 是不是 dataless /
//! 卷挂没挂)由调用方喂进来——所以四条分支在没有外接盘、没有 iCloud 账号的
//! 机器上也能被单测钉死。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 文件就在本机,能直接读。
pub const STATE_OK: &str = "ok";
/// 文件所在的卷现在没挂上(拔卡、拔盘、网络盘断了)。
pub const STATE_EJECTED: &str = "ejected";
/// 文件在 iCloud 里,本机只有占位。
pub const STATE_CLOUD_ONLY: &str = "cloud_only";
/// 卷挂着,但这个位置上确实没有这个文件了(被删 / 被改名)。
pub const STATE_GONE: &str = "gone";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathCondition {
    pub path: String,
    pub state: &'static str,
    /// 卷名(`/Volumes/<名字>`)——只有 `ejected` 时才有,用来把话说具体。
    pub volume: Option<String>,
}

/// `/Volumes/TRIP_2026/...` → `("/Volumes/TRIP_2026", "TRIP_2026")`。
/// 启动盘上的路径没有卷根,返回 `None`。
pub fn volume_root_of(path: &Path) -> Option<(PathBuf, String)> {
    let mut components = path.components();
    if components.next()? != std::path::Component::RootDir {
        return None;
    }
    if components.next()?.as_os_str() != "Volumes" {
        return None;
    }
    let name = components.next()?.as_os_str().to_string_lossy().into_owned();
    Some((PathBuf::from("/Volumes").join(&name), name))
}

/// 纯判定。参数就是四条分支各自需要的那一个事实,别在这里碰文件系统。
pub fn classify_from_facts(
    path: &Path,
    exists: bool,
    dataless: bool,
    volume: Option<(PathBuf, String)>,
    volume_mounted: bool,
) -> PathCondition {
    let text = path.to_string_lossy().into_owned();
    if exists {
        let state = if dataless { STATE_CLOUD_ONLY } else { STATE_OK };
        return PathCondition { path: text, state, volume: None };
    }
    match volume {
        // 卷根都不在了:盘拔了。这一条不算错误。
        Some((_, name)) if !volume_mounted => PathCondition {
            path: text,
            state: STATE_EJECTED,
            volume: Some(name),
        },
        _ => PathCondition { path: text, state: STATE_GONE, volume: None },
    }
}

/// macOS `SF_DATALESS`:文件在,但内容还在云上(`ls -lO` 里那个 `dataless`)。
#[cfg(target_os = "macos")]
pub const SF_DATALESS: u32 = 0x4000_0000;

/// 这个位置是不是"只有占位"。两种形态都算:
/// 1. 新系统的 dataless 标志;
/// 2. 老一点的 `.名字.icloud` 占位文件(本体那个路径根本不存在)。
#[cfg(target_os = "macos")]
pub fn looks_cloud_only(path: &Path) -> bool {
    use std::os::macos::fs::MetadataExt;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.st_flags() & SF_DATALESS != 0 {
            return true;
        }
    }
    cloud_placeholder_for(path).is_some_and(|placeholder| placeholder.exists())
}

#[cfg(not(target_os = "macos"))]
pub fn looks_cloud_only(_path: &Path) -> bool {
    false
}

/// `/a/海边.mp4` → `/a/.海边.mp4.icloud`。
pub fn cloud_placeholder_for(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    if name.starts_with('.') && name.ends_with(".icloud") {
        return None;
    }
    Some(path.with_file_name(format!(".{name}.icloud")))
}

/// 打一条真路径。这是唯一碰文件系统的入口。
pub fn classify(path: &Path) -> PathCondition {
    let volume = volume_root_of(path);
    let mounted = volume.as_ref().is_some_and(|(root, _)| root.is_dir());
    let exists = std::fs::symlink_metadata(path).is_ok();
    classify_from_facts(path, exists, exists && looks_cloud_only(path), volume, mounted)
}

/// 「现在下载」:让 iCloud 把本体拉到本机。`brctl` 是系统自带的那个;
/// 它只是**请求**下载,回来之后文件可能还在下,所以调用方要重新打一次 `classify`。
pub fn request_download(path: &Path) -> std::io::Result<()> {
    let status = std::process::Command::new("/usr/bin/brctl")
        .arg("download")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("brctl download 退出码 {status}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_volume_path_yields_its_root_and_name() {
        let (root, name) = volume_root_of(Path::new("/Volumes/TRIP_2026/DCIM/a.mp4")).unwrap();
        assert_eq!(root, PathBuf::from("/Volumes/TRIP_2026"));
        assert_eq!(name, "TRIP_2026");
        assert_eq!(volume_root_of(Path::new("/Users/x/a.mp4")), None, "启动盘上的路径没有卷根");
        assert_eq!(volume_root_of(Path::new("/Volumes")), None, "只到 /Volumes 还没有卷名");
    }

    /// 盘拔了是 `ejected`,而且把卷名带上——话要说具体到"哪块盘"。
    #[test]
    fn an_unmounted_volume_is_ejected_not_an_error() {
        let path = Path::new("/Volumes/TRIP_2026/DCIM/a.mp4");
        let condition = classify_from_facts(path, false, false, volume_root_of(path), false);
        assert_eq!(condition.state, STATE_EJECTED);
        assert_eq!(condition.volume.as_deref(), Some("TRIP_2026"));
    }

    /// 卷挂着、文件真没了 —— 这条才是"找不到",不带卷名(插回去也没用)。
    #[test]
    fn a_mounted_volume_missing_the_file_is_gone() {
        let path = Path::new("/Volumes/TRIP_2026/DCIM/a.mp4");
        let condition = classify_from_facts(path, false, false, volume_root_of(path), true);
        assert_eq!(condition.state, STATE_GONE);
        assert_eq!(condition.volume, None);
    }

    /// 文件在、但只有占位 —— 不是缺失,是"没下载到本机",我们能替他下。
    #[test]
    fn a_dataless_file_is_cloud_only_not_missing() {
        let path = Path::new("/Users/x/iCloud/海边.mp4");
        assert_eq!(classify_from_facts(path, true, true, None, false).state, STATE_CLOUD_ONLY);
        assert_eq!(classify_from_facts(path, true, false, None, false).state, STATE_OK);
    }

    #[test]
    fn placeholder_name_is_the_hidden_dot_icloud_sibling() {
        assert_eq!(
            cloud_placeholder_for(Path::new("/a/海边.mp4")),
            Some(PathBuf::from("/a/.海边.mp4.icloud"))
        );
        assert_eq!(cloud_placeholder_for(Path::new("/a/.海边.mp4.icloud")), None, "占位本身不再套一层");
    }

    /// 真打一次文件系统:老形态的 `.名字.icloud` 占位在、本体不在 → cloud_only。
    /// (新形态的 `SF_DATALESS` 标志是内核置的,用户态造不出来,只能靠这一条覆盖
    ///  `looks_cloud_only` 的真实文件系统分支;dataless 那半由 `classify_from_facts`
    ///  的纯测试覆盖。)
    #[test]
    fn an_icloud_placeholder_next_to_a_missing_file_reads_as_cloud_only() {
        let directory = crate::core::test_support::TestDirectory::new();
        let file = directory.path().join("海边.mp4");
        assert_eq!(classify(&file).state, STATE_GONE, "什么都没有时是 gone");
        std::fs::write(directory.path().join(".海边.mp4.icloud"), b"").unwrap();
        assert!(looks_cloud_only(&file), "占位在旁边就说明本体在云上");
    }

    /// 真打一次文件系统:临时目录里的普通文件必须是 ok,删掉之后是 gone。
    #[test]
    fn classify_reads_the_real_filesystem() {
        let directory = crate::core::test_support::TestDirectory::new();
        let file = directory.path().join("a.mp4");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(classify(&file).state, STATE_OK);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(classify(&file).state, STATE_GONE);
    }
}
