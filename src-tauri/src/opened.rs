//! R18 车道 native2 / M-06①:Dock 图标拖入与「打开方式」进来的那批 URL,
//! 翻成一次导入请求。
//!
//! 为什么单独一个纯函数:macOS 递过来的是 `file://` URL(百分号编码、中文路径、
//! 目录带尾斜杠),而导入入口吃的是本机绝对路径字符串。中间这段翻译在没有窗口、
//! 没有真机、没有 Dock 的情况下也必须能被判定——所以它不碰文件系统,
//! 「这条是不是目录」由调用方用闭包喂进来。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 认得的视频扩展名。与 `tauri.conf.json` 的 `bundle.fileAssociations` 是同一份清单——
/// 两边不一致时,Finder 会把我们接不住的类型也交给我们。
pub const IMPORTABLE_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v"];

/// 前端订阅的事件名(`src/workspace/useGlobalDrop.ts` 里是同一个字面量)。
pub const OPENED_PATHS_EVENT: &str = "tripcut:opened-paths";

/// 扩展名在清单里就算。大小写不敏感——相机导出的 `.MOV` 是常态。
pub fn is_importable_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            IMPORTABLE_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(extension))
        })
}

/// 把 `RunEvent::Opened { urls }` 翻成导入路径列表。
///
/// 规则(每条都有测试):
/// 1. 只收 `file:` scheme——`http:`/`tripcut:` 这类深链不是素材,静默丢掉而不是报错;
/// 2. 目录照收;文件按扩展名过滤(拖个 PDF 进来不该排一个必然失败的导入任务);
/// 3. 去重,并且**丢掉已被同批某个目录覆盖住的子路径**——否则同一批素材会导两遍
///    (后端会按哈希跳过,但用户看到的 total 会翻倍,那句提示就成了假话);
/// 4. 顺序按原样保留,方便日志与提示复现用户真实的拖放顺序。
pub fn opened_paths_to_import_request<F>(urls: &[url::Url], is_directory: F) -> Vec<String>
where
    F: Fn(&Path) -> bool,
{
    let mut directories: Vec<PathBuf> = Vec::new();
    let mut kept: Vec<PathBuf> = Vec::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();

    for url in urls {
        if url.scheme() != "file" {
            continue;
        }
        // 目录的 URL 带尾斜杠,`to_file_path` 会把它留成 `/card/`;
        // `starts_with` 与去重都按组件比,所以这里先规范化掉尾斜杠。
        let Ok(path) = url.to_file_path() else { continue };
        let path: PathBuf = path.components().collect();
        if !seen.insert(path.clone()) {
            continue;
        }
        if is_directory(&path) {
            directories.push(path.clone());
            kept.push(path);
        } else if is_importable_file(&path) {
            kept.push(path);
        }
    }

    kept.into_iter()
        .filter(|path| {
            !directories
                .iter()
                .any(|directory| directory != path && path.starts_with(directory))
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> url::Url {
        url::Url::parse(text).unwrap()
    }

    #[test]
    fn keeps_videos_and_folders_and_drops_everything_else() {
        let urls = [
            url("file:///Users/x/a.mp4"),
            url("file:///Users/x/b.MOV"),
            url("file:///Users/x/c.m4v"),
            url("file:///Users/x/notes.pdf"),
            url("file:///Users/x/card/"),
            url("https://example.com/a.mp4"),
        ];
        let paths = opened_paths_to_import_request(&urls, |path| path.ends_with("card"));
        assert_eq!(
            paths,
            vec![
                "/Users/x/a.mp4".to_owned(),
                "/Users/x/b.MOV".to_owned(),
                "/Users/x/c.m4v".to_owned(),
                "/Users/x/card".to_owned(),
            ]
        );
    }

    #[test]
    fn percent_encoded_chinese_paths_come_back_decoded() {
        let urls = [url("file:///Users/x/%E6%97%85%E8%A1%8C/%E6%B5%B7%E8%BE%B9.mp4")];
        let paths = opened_paths_to_import_request(&urls, |_| false);
        assert_eq!(paths, vec!["/Users/x/旅行/海边.mp4".to_owned()]);
    }

    #[test]
    fn a_file_inside_a_selected_folder_is_not_imported_twice() {
        let urls = [
            url("file:///Users/x/card/"),
            url("file:///Users/x/card/a.mp4"),
            url("file:///Users/x/other.mp4"),
        ];
        let paths = opened_paths_to_import_request(&urls, |path| path.ends_with("card"));
        assert_eq!(paths, vec!["/Users/x/card".to_owned(), "/Users/x/other.mp4".to_owned()]);
    }

    #[test]
    fn the_same_url_twice_imports_once() {
        let urls = [url("file:///Users/x/a.mp4"), url("file:///Users/x/a.mp4")];
        assert_eq!(opened_paths_to_import_request(&urls, |_| false).len(), 1);
    }

    /// 配置与代码里的清单必须是同一份:Finder 按 `tauri.conf.json` 决定把什么交给我们,
    /// `is_importable_file` 决定我们接不接。两边漂了,用户会看到"打开了却什么也没发生"。
    #[test]
    fn file_associations_in_the_bundle_config_match_the_extension_list() {
        const CONFIG: &str = include_str!("../tauri.conf.json");
        let config: serde_json::Value = serde_json::from_str(CONFIG).expect("tauri.conf.json 必须是合法 JSON");
        let associations = config["bundle"]["fileAssociations"]
            .as_array()
            .expect("bundle.fileAssociations 缺失——Dock 拖入与「打开方式」都不会落到我们身上");
        let declared: BTreeSet<String> = associations
            .iter()
            .filter_map(|entry| entry["ext"].as_array())
            .flatten()
            .filter_map(|ext| ext.as_str())
            .map(str::to_owned)
            .collect();
        let expected: BTreeSet<String> = IMPORTABLE_EXTENSIONS.iter().map(|e| (*e).to_owned()).collect();
        assert_eq!(declared, expected, "配置里的扩展名与 IMPORTABLE_EXTENSIONS 必须一致");

        let content_types: BTreeSet<String> = associations
            .iter()
            .filter_map(|entry| entry["contentTypes"].as_array())
            .flatten()
            .filter_map(|value| value.as_str())
            .map(str::to_owned)
            .collect();
        assert!(
            content_types.contains("public.folder"),
            "整个文件夹拖到 Dock 图标上也要能导入(LSItemContentTypes 要有 public.folder)"
        );
    }
}
