//! R6 Task 4:交付完成 / 批量分析完成的系统通知出口。
//!
//! `post` 不直接依赖 `tauri::AppHandle` 的具体实现细节——它对任何实现了
//! [`NotificationSink`] 的类型都能发。生产代码把 `tauri::AppHandle` 接到这个
//! trait 上(内部走 `tauri-plugin-notification`);测试用 [`MockSink`] 收集调用,
//! 不需要起一个真正的 Tauri App 就能断言「恰好一条」。

#[cfg(test)]
use std::sync::Mutex;

/// 能收系统通知的目的地。生产实现是 `tauri::AppHandle`;测试用 `MockSink`。
/// 返回值是「这条通知是否真的送出去了」——调用方(`core::jobs`)拿它来决定
/// 一个批量分析批次的去重标记能不能落(只在成功投递后才落,见
/// `core::import::mark_batch_analysis_notified` 上的注释)。
pub trait NotificationSink {
    fn notify(&self, title: &str, body: &str) -> bool;

    /// R18 H-16:带一个动作按钮的通知。默认实现忽略动作,退回普通通知——
    /// 失败朝"少一个按钮"而不是"少一条通知"。
    fn notify_with_reveal(&self, title: &str, body: &str, _reveal: Option<&RevealAction>) -> bool {
        self.notify(title, body)
    }
}

/// R18 H-16:「交付完成」通知上那个「在 Finder 中显示」按钮要打开的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealAction {
    pub label: &'static str,
    pub path: String,
}

/// 按钮文案。用户看到的就是这句,测试按字面量钉着。
pub const REVEAL_ACTION_LABEL: &str = "在 Finder 中显示";

/// 这条通知配不配一个「在 Finder 中显示」。
///
/// 只有交付完成配:批量分析完成没有"一个可以打开的东西"(结果散在库里),
/// 给它一个按钮只会让人点开一个不知道是什么的文件夹。
///
/// 路径从**刚做完的那条 `export_package`** 身上取(`result_path`)。为什么不
/// 由调用方传进来:通知出口的签名 `Fn(&str, &str) -> bool` 是 `core::jobs`
/// 的(不归本车道),改它等于改所有调用方;而"最近一条做完的交付"在这里
/// 一次查询就能拿到,语义与那条通知说的是同一件事。
pub fn reveal_action_for(connection: &rusqlite::Connection, title: &str) -> Option<RevealAction> {
    if title != EXPORT_COMPLETE_TITLE {
        return None;
    }
    let path: Option<String> = connection
        .query_row(
            "SELECT result_path FROM jobs
             WHERE kind = 'export_package' AND status = 'done' AND result_path IS NOT NULL
             ORDER BY updated_at DESC, id DESC
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    path.map(|path| RevealAction { label: REVEAL_ACTION_LABEL, path })
}

impl NotificationSink for tauri::AppHandle {
    fn notify(&self, title: &str, body: &str) -> bool {
        use tauri_plugin_notification::NotificationExt;
        match self.notification().builder().title(title).body(body).show() {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(%error, title, "系统通知发送失败");
                false
            }
        }
    }

    /// 带动作的那条走 `notify-rust`(插件的桌面 builder 给不了按钮),
    /// 没有动作的照旧走插件——只有需要按钮的那一条改路,别的一行不动。
    fn notify_with_reveal(&self, title: &str, body: &str, reveal: Option<&RevealAction>) -> bool {
        match reveal {
            #[cfg(target_os = "macos")]
            Some(action) => show_with_reveal(self, title, body, action),
            #[cfg(not(target_os = "macos"))]
            Some(_) => self.notify(title, body),
            None => self.notify(title, body),
        }
    }
}

/// 发一条带按钮的通知。
///
/// **必须整条搬到另一根线程上**:NSUserNotification 这条路 `show()` 是同步的,
/// 要一直等到用户点了按钮或者通知自己消失才返回。调用方(`core::jobs` 的通知出口)
/// 拿返回值决定去重标记落不落,在那里同步等于把一个 worker 槽押给用户的手速。
/// 所以这里投递出去就算成功——交付完成这条没有去重标记依赖它(有依赖的是
/// 批量分析完成那条,而那条不带按钮,走的仍是插件的原路)。
#[cfg(target_os = "macos")]
fn show_with_reveal(app: &tauri::AppHandle, title: &str, body: &str, action: &RevealAction) -> bool {
    let identifier = app.config().identifier.clone();
    let title = title.to_owned();
    let body = body.to_owned();
    let label = action.label.to_owned();
    let path = std::path::PathBuf::from(&action.path);
    std::thread::Builder::new()
        .name("notify-reveal".to_owned())
        .spawn(move || {
            // 与插件同一套:开发态没有 bundle,借 Terminal 的身份才发得出来。
            let _ = notify_rust::set_application(if tauri::is_dev() { "com.apple.Terminal" } else { &identifier });
            let mut notification = notify_rust::Notification::new();
            notification.summary(&title).body(&body).action("reveal", &label);
            match notification.show() {
                Ok(handle) => handle.wait_for_action(|identifier| {
                    if identifier == "reveal" {
                        if let Err(error) = crate::reveal_in_finder(&path) {
                            tracing::warn!(%error, "「在 Finder 中显示」没能打开交付包");
                        }
                    }
                }),
                Err(error) => tracing::warn!(%error, title, "带动作的系统通知发送失败"),
            }
        })
        .map(|_| true)
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "带动作的通知线程没起来");
            false
        })
}

/// 发一条系统通知,返回是否投递成功。薄封装,存在的意义是给测试一个可
/// mock 的注入点。
pub fn post(sink: &impl NotificationSink, title: &str, body: &str) -> bool {
    sink.notify(title, body)
}

/// R18 F1:这条标题归哪个开关管。没登记的标题 = 不受开关约束(永远发)。
pub fn setting_key_for_title(title: &str) -> Option<&'static str> {
    match title {
        EXPORT_COMPLETE_TITLE => Some(crate::core::settings::NOTIFY_EXPORT_COMPLETE_KEY),
        BATCH_ANALYSIS_COMPLETE_TITLE => Some(crate::core::settings::NOTIFY_BATCH_COMPLETE_KEY),
        _ => None,
    }
}

/// R18 F1:查一次开关再发。关掉的那条**一次 `sink.notify` 都不调**(不是发了再丢),
/// 所以 `MockSink::calls` 必须是空的——这正是 `post_gated_stays_silent_when_switched_off` 钉的事。
/// 数据库读不出来时按「开」走:通知宁可多一条,也不能因为一次读失败把用户配置好的提醒静默吞掉。
pub fn post_gated(sink: &impl NotificationSink, connection: &rusqlite::Connection, title: &str, body: &str) -> bool {
    if let Some(key) = setting_key_for_title(title) {
        if !crate::core::settings::notification_enabled(connection, key) {
            return false;
        }
    }
    // R18 H-16:交付完成那条带「在 Finder 中显示」;其余照旧。
    let reveal = reveal_action_for(connection, title);
    sink.notify_with_reveal(title, body, reveal.as_ref())
}

/// R18 F1:两条完成通知都关掉时,首次后台任务那条「引权限弹框」的通知也不该发——
/// 用户已经说了不要通知,再去要一次系统权限是骚扰。
pub fn any_completion_enabled(connection: &rusqlite::Connection) -> bool {
    crate::core::settings::notification_enabled(connection, crate::core::settings::NOTIFY_EXPORT_COMPLETE_KEY)
        || crate::core::settings::notification_enabled(connection, crate::core::settings::NOTIFY_BATCH_COMPLETE_KEY)
}

/// 交付完成通知的标题;正文是交付目标文件夹名。
pub const EXPORT_COMPLETE_TITLE: &str = "交付完成";
/// 批量分析完成通知的标题;正文由调用方按批次信息拼。
pub const BATCH_ANALYSIS_COMPLETE_TITLE: &str = "批量分析完成";
/// R10 U-25:首个后台任务开始时的一条通知——它的作用是把 macOS 的通知权限弹框固定在这个时机。
pub const BACKGROUND_STARTED_TITLE: &str = "旅剪已开始后台处理";

#[cfg(test)]
#[derive(Default)]
pub struct MockSink {
    pub calls: Mutex<Vec<(String, String)>>,
    /// 每条通知带的动作(没有就是 `None`)——H-16 的判据。
    pub reveals: Mutex<Vec<Option<RevealAction>>>,
}

#[cfg(test)]
impl NotificationSink for MockSink {
    fn notify(&self, title: &str, body: &str) -> bool {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((title.to_owned(), body.to_owned()));
        true
    }

    fn notify_with_reveal(&self, title: &str, body: &str, reveal: Option<&RevealAction>) -> bool {
        self.reveals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(reveal.cloned());
        self.notify(title, body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::core::{db, settings, test_support::TestDirectory};

    /// F1:关掉开关之后 `MockSink` 一次都不该被调到(零调用,不是"调了但返回 false")。
    #[test]
    fn post_gated_stays_silent_when_switched_off() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let sink = MockSink::default();

        // 默认开:照发。
        assert!(post_gated(&sink, &connection, EXPORT_COMPLETE_TITLE, "包"));
        assert_eq!(sink.calls.lock().unwrap().len(), 1);

        settings::set_setting(&connection, settings::NOTIFY_EXPORT_COMPLETE_KEY, "false").unwrap();
        assert!(!post_gated(&sink, &connection, EXPORT_COMPLETE_TITLE, "包"));
        // 批量分析那条还开着,互不牵连。
        assert!(post_gated(&sink, &connection, BATCH_ANALYSIS_COMPLETE_TITLE, "12 条"));
        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "关掉的那条必须零调用");
        assert_eq!(calls[1].0, BATCH_ANALYSIS_COMPLETE_TITLE);
    }

    /// F1:两条都关 → 连首次那条引权限的通知也不发。
    #[test]
    fn first_job_primer_is_suppressed_when_both_switches_are_off() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        assert!(any_completion_enabled(&connection));
        settings::set_setting(&connection, settings::NOTIFY_EXPORT_COMPLETE_KEY, "false").unwrap();
        assert!(any_completion_enabled(&connection));
        settings::set_setting(&connection, settings::NOTIFY_BATCH_COMPLETE_KEY, "false").unwrap();
        assert!(!any_completion_enabled(&connection));
    }

    /// H-16:交付完成带「在 Finder 中显示」,按钮指向刚做完那条交付的 result_path;
    /// 批量分析完成不配按钮(它没有"一个可以打开的东西")。
    #[test]
    fn only_the_export_notification_carries_a_reveal_action() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let sink = MockSink::default();

        // 还没有任何交付做完:有开关、有通知,但没有可打开的东西 → 不硬造一个按钮。
        assert!(post_gated(&sink, &connection, EXPORT_COMPLETE_TITLE, "包"));
        assert_eq!(sink.reveals.lock().unwrap()[0], None);

        let id = crate::core::jobs::enqueue(&mut connection, "export_package", "{}", "e-1").unwrap();
        connection
            .execute(
                "UPDATE jobs SET status='done', result_path='/Users/x/交付/我的交付包' WHERE id=?1",
                [id],
            )
            .unwrap();

        assert!(post_gated(&sink, &connection, EXPORT_COMPLETE_TITLE, "我的交付包"));
        assert_eq!(
            sink.reveals.lock().unwrap()[1],
            Some(RevealAction { label: REVEAL_ACTION_LABEL, path: "/Users/x/交付/我的交付包".to_owned() })
        );

        assert!(post_gated(&sink, &connection, BATCH_ANALYSIS_COMPLETE_TITLE, "12 条"));
        assert_eq!(sink.reveals.lock().unwrap()[2], None, "批量分析完成不配「在 Finder 中显示」");
    }

    /// 关掉的那条连动作都不该构造——它一次 `notify_with_reveal` 都不调。
    #[test]
    fn a_switched_off_notification_does_not_reach_the_action_path() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let sink = MockSink::default();
        settings::set_setting(&connection, settings::NOTIFY_EXPORT_COMPLETE_KEY, "false").unwrap();
        assert!(!post_gated(&sink, &connection, EXPORT_COMPLETE_TITLE, "包"));
        assert!(sink.reveals.lock().unwrap().is_empty());
    }

    #[test]
    fn post_records_exactly_one_call_on_the_mock_sink() {
        let sink = MockSink::default();
        post(&sink, EXPORT_COMPLETE_TITLE, "我的交付包_2026-09-06");
        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0],
            (
                EXPORT_COMPLETE_TITLE.to_owned(),
                "我的交付包_2026-09-06".to_owned()
            )
        );
    }
}
