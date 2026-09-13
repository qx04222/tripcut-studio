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
}

/// 发一条系统通知,返回是否投递成功。薄封装,存在的意义是给测试一个可
/// mock 的注入点。
pub fn post(sink: &impl NotificationSink, title: &str, body: &str) -> bool {
    sink.notify(title, body)
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
