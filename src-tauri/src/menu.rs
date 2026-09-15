//! R18 车道 native / M-01:中文原生菜单栏。
//!
//! 背景(`.superpowers/sdd/r18/brainstorm-holistic.md` §1.1–1.2 实测):代码里一行菜单
//! 都没有,线上跑的是 Tauri 默认菜单——**全英文**,而且里面那条**启用状态**的
//! `Edit ▸ Undo` 会在 `NSApplication sendEvent:` 阶段就吃掉 ⌘Z,WKWebView 的
//! `keydown` 永不触发,R16 做的 `undoStack.ts` 键盘上完全够不着。
//!
//! 所以这里的两条硬规则:
//! 1. 菜单标题一律中文(`菜单标题全是中文` 单测按码点断言,不按空格分词——CJK 没有空格);
//! 2. 编辑菜单的「撤销 / 重做」**必须是自定义 `MenuItem`**,不能用
//!    `PredefinedMenuItem::undo/redo`。自定义项点下去只发一条
//!    `tripcut:menu` 事件,由前端 `src/workspace/menuBridge.ts` 决定是走
//!    应用撤销栈还是让输入框自己撤销。
//!
//! 菜单结构是**纯数据**(`menu_spec()`),构建函数只把数据翻成 Tauri 调用——
//! 这样"菜单里有什么"能在没有窗口、没有真机的情况下被单测判定。

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// 菜单点击转发给前端的事件名(前端 `menuBridge.ts` 监听同名事件)。
pub const MENU_EVENT: &str = "tripcut:menu";

/// 系统预定义项——标题也自己给中文,不吃 AppKit 的英文默认值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Predefined {
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ItemSpec {
    /// 转发给前端的动作 id;前端按它分发。
    pub id: &'static str,
    pub title: &'static str,
    /// Tauri 加速键写法(`CmdOrCtrl+Z`);`None` = 不挂快捷键。
    pub accelerator: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// 自定义项:只发事件,不碰系统责任链。
    Custom(ItemSpec),
    Separator,
    System(Predefined, &'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubmenuSpec {
    pub title: &'static str,
    pub entries: &'static [Entry],
}

const APP_MENU: &[Entry] = &[
    Entry::Custom(ItemSpec { id: "about", title: "关于旅剪工作台", accelerator: None }),
    Entry::Custom(ItemSpec { id: "check-update", title: "检查更新…", accelerator: None }),
    Entry::Separator,
    Entry::Custom(ItemSpec { id: "settings", title: "偏好设置…", accelerator: Some("CmdOrCtrl+,") }),
    Entry::Separator,
    Entry::System(Predefined::Services, "服务"),
    Entry::Separator,
    Entry::System(Predefined::Hide, "隐藏旅剪工作台"),
    Entry::System(Predefined::HideOthers, "隐藏其他"),
    Entry::System(Predefined::ShowAll, "全部显示"),
    Entry::Separator,
    Entry::System(Predefined::Quit, "退出旅剪工作台"),
];

const FILE_MENU: &[Entry] = &[
    Entry::Custom(ItemSpec { id: "import", title: "导入素材…", accelerator: Some("CmdOrCtrl+I") }),
    Entry::Custom(ItemSpec { id: "export", title: "导出…", accelerator: Some("CmdOrCtrl+E") }),
    Entry::Separator,
    Entry::System(Predefined::CloseWindow, "关闭窗口"),
];

const EDIT_MENU: &[Entry] = &[
    // ⌘Z / ⇧⌘Z 必须是自定义项:预定义的 undo/redo 会让 AppKit 在 WKWebView 之前吃掉按键。
    Entry::Custom(ItemSpec { id: "undo", title: "撤销", accelerator: Some("CmdOrCtrl+Z") }),
    Entry::Custom(ItemSpec { id: "redo", title: "重做", accelerator: Some("Shift+CmdOrCtrl+Z") }),
    Entry::Separator,
    Entry::System(Predefined::Cut, "剪切"),
    Entry::System(Predefined::Copy, "拷贝"),
    Entry::System(Predefined::Paste, "粘贴"),
    Entry::System(Predefined::SelectAll, "全选"),
];

const VIEW_MENU: &[Entry] = &[
    Entry::Custom(ItemSpec { id: "command-palette", title: "命令面板", accelerator: Some("CmdOrCtrl+K") }),
    Entry::Separator,
    Entry::System(Predefined::Fullscreen, "进入全屏"),
];

const WINDOW_MENU: &[Entry] = &[
    Entry::System(Predefined::Minimize, "最小化"),
    Entry::System(Predefined::Maximize, "缩放"),
];

const HELP_MENU: &[Entry] = &[
    Entry::Custom(ItemSpec { id: "help-manual", title: "旅剪使用手册", accelerator: None }),
    Entry::Custom(ItemSpec { id: "help-shortcuts", title: "快捷键表", accelerator: None }),
];

const SPEC: &[SubmenuSpec] = &[
    SubmenuSpec { title: "旅剪工作台", entries: APP_MENU },
    SubmenuSpec { title: "文件", entries: FILE_MENU },
    SubmenuSpec { title: "编辑", entries: EDIT_MENU },
    SubmenuSpec { title: "显示", entries: VIEW_MENU },
    SubmenuSpec { title: "窗口", entries: WINDOW_MENU },
    SubmenuSpec { title: "帮助", entries: HELP_MENU },
];

/// 菜单结构的单一来源。真机 AX 审计(`scripts/qa/native-audit/menu-audit.mjs`)
/// 与 Rust 单测判的是同一份数据。
pub fn menu_spec() -> &'static [SubmenuSpec] {
    SPEC
}

fn push_entry<'m, R: Runtime>(
    builder: SubmenuBuilder<'m, R, AppHandle<R>>,
    app: &'m AppHandle<R>,
    entry: &Entry,
) -> tauri::Result<SubmenuBuilder<'m, R, AppHandle<R>>> {
    Ok(match entry {
        Entry::Custom(spec) => {
            let mut item = MenuItemBuilder::with_id(spec.id, spec.title);
            if let Some(accelerator) = spec.accelerator {
                item = item.accelerator(accelerator);
            }
            builder.item(&item.build(app)?)
        }
        Entry::Separator => builder.separator(),
        Entry::System(kind, title) => match kind {
            Predefined::Services => builder.services_with_text(title),
            Predefined::Hide => builder.hide_with_text(title),
            Predefined::HideOthers => builder.hide_others_with_text(title),
            Predefined::ShowAll => builder.show_all_with_text(title),
            Predefined::Quit => builder.quit_with_text(title),
            Predefined::CloseWindow => builder.close_window_with_text(title),
            Predefined::Cut => builder.cut_with_text(title),
            Predefined::Copy => builder.copy_with_text(title),
            Predefined::Paste => builder.paste_with_text(title),
            Predefined::SelectAll => builder.select_all_with_text(title),
            Predefined::Fullscreen => builder.fullscreen_with_text(title),
            Predefined::Minimize => builder.minimize_with_text(title),
            Predefined::Maximize => builder.maximize_with_text(title),
        },
    })
}

/// 建菜单并挂上去;菜单点击一律转成 `tripcut:menu` 事件交给前端。
/// 失败不该拦住启动——调用方只记一条 warn(没有菜单的应用仍然能用)。
pub fn attach<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let mut menu = MenuBuilder::new(app);
    for submenu in menu_spec() {
        let mut builder = SubmenuBuilder::new(app, submenu.title);
        for entry in submenu.entries {
            builder = push_entry(builder, app, entry)?;
        }
        menu = menu.item(&builder.build()?);
    }
    let menu = menu.build()?;
    app.set_menu(menu)?;
    let handle = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref().to_owned();
        if let Err(error) = handle.emit(MENU_EVENT, id.clone()) {
            tracing::warn!(%error, %id, "菜单事件没能转发给前端");
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom_items() -> Vec<ItemSpec> {
        menu_spec()
            .iter()
            .flat_map(|submenu| submenu.entries.iter())
            .filter_map(|entry| match entry {
                Entry::Custom(spec) => Some(*spec),
                _ => None,
            })
            .collect()
    }

    fn titles() -> Vec<&'static str> {
        menu_spec()
            .iter()
            .flat_map(|submenu| {
                std::iter::once(submenu.title).chain(submenu.entries.iter().filter_map(|entry| match entry {
                    Entry::Custom(spec) => Some(spec.title),
                    Entry::System(_, title) => Some(*title),
                    Entry::Separator => None,
                }))
            })
            .collect()
    }

    /// H-01:一个通体中文的应用不该顶着一条英文菜单栏。判据按**码点**而不是空格分词
    /// (业主记忆:词数统计必须处理 CJK),每条标题至少要有一个 CJK 字。
    #[test]
    fn every_menu_title_is_chinese() {
        for title in titles() {
            assert!(
                title.chars().any(|character| matches!(character, '\u{4e00}'..='\u{9fff}')),
                "菜单标题不是中文:{title}"
            );
        }
    }

    /// M-01 的核心:撤销/重做必须是自定义项 + ⌘Z/⇧⌘Z,否则 AppKit 继续吞键。
    #[test]
    fn undo_and_redo_are_custom_items_with_accelerators() {
        let items = custom_items();
        let undo = items.iter().find(|item| item.id == "undo").expect("编辑菜单缺少自定义撤销项");
        let redo = items.iter().find(|item| item.id == "redo").expect("编辑菜单缺少自定义重做项");
        assert_eq!(undo.accelerator, Some("CmdOrCtrl+Z"));
        assert_eq!(redo.accelerator, Some("Shift+CmdOrCtrl+Z"));
    }

    #[test]
    fn menu_never_uses_predefined_undo_or_redo() {
        let systems: Vec<Predefined> = menu_spec()
            .iter()
            .flat_map(|submenu| submenu.entries.iter())
            .filter_map(|entry| match entry {
                Entry::System(kind, _) => Some(*kind),
                _ => None,
            })
            .collect();
        // 预定义 undo/redo 根本没进 `Predefined` 枚举——这条断言守的是"别有人再加回来"。
        assert!(!systems.is_empty());
        assert!(!format!("{systems:?}").contains("Undo"));
        assert!(!format!("{systems:?}").contains("Redo"));
    }

    /// 前端按 id 分发,id 撞车会让两条菜单干同一件事。
    #[test]
    fn custom_menu_ids_are_unique() {
        let items = custom_items();
        let mut ids: Vec<&str> = items.iter().map(|item| item.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "菜单 id 有重复");
    }

    /// 任务书点名的六个顶级菜单与应用自己的命令一条都不能少。
    #[test]
    fn spec_covers_the_six_submenus_and_the_app_commands() {
        let submenu_titles: Vec<&str> = menu_spec().iter().map(|submenu| submenu.title).collect();
        assert_eq!(submenu_titles, vec!["旅剪工作台", "文件", "编辑", "显示", "窗口", "帮助"]);
        let ids: Vec<&str> = custom_items().iter().map(|item| item.id).collect();
        for expected in [
            "about",
            "check-update",
            "settings",
            "import",
            "export",
            "undo",
            "redo",
            "command-palette",
            "help-manual",
            "help-shortcuts",
        ] {
            assert!(ids.contains(&expected), "菜单少了动作 {expected}");
        }
    }

    /// 键位表里的 ⌘, / ⌘I / ⌘E / ⌘K 必须和菜单一致,否则用户看到的和按下去的是两套。
    #[test]
    fn accelerators_match_the_app_keymap() {
        let items = custom_items();
        for (id, accelerator) in [
            ("settings", "CmdOrCtrl+,"),
            ("import", "CmdOrCtrl+I"),
            ("export", "CmdOrCtrl+E"),
            ("command-palette", "CmdOrCtrl+K"),
        ] {
            let item = items.iter().find(|item| item.id == id).expect("菜单缺项");
            assert_eq!(item.accelerator, Some(accelerator), "{id} 的快捷键和键位表对不上");
        }
    }
}
