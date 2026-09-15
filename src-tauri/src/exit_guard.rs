//! R18 车道 native / F2:关窗口时后台任务还没做完的确认。
//!
//! 「后台任务被无声打断最容易让用户对软件失去信任」(`brainstorm-settings.md` F2)。
//! 但**不是所有正在跑的任务都值得拦人**:缓存清理(`cache_gc`)是空闲时自己做的家务,
//! 下次启动照样能接着做,为它弹一个确认框只会教会用户无脑点「仍要退出」。
//!
//! 判定是纯函数,所以"哪些 kind 算数"能被单测钉死;副作用(prevent_close / emit /
//! `confirm_exit`)留在 `lib.rs`。

use std::sync::atomic::{AtomicBool, Ordering};

/// 空闲家务类:正在跑也不拦人。与 `core::jobs` 的 kind 字面量对齐。
pub const IDLE_KINDS: &[&str] = &["cache_gc", "noop"];

/// 值得拦一次的任务数。0 = 直接放行。
pub fn blocking_job_count<'a>(kinds: impl IntoIterator<Item = &'a str>) -> usize {
    kinds.into_iter().filter(|kind| !IDLE_KINDS.contains(kind)).count()
}

/// 「还有 n 个后台任务没做完」这句话里的 n;前端按它渲染文案。
pub fn close_requested_payload(count: usize) -> serde_json::Value {
    serde_json::json!({ "running": count })
}

/// 用户已经在确认框里点过「仍要退出」。第二次 `CloseRequested` 不再拦
/// (`api.prevent_close()` 用法必须配一个"已确认"标志位,否则应用退不掉)。
#[derive(Debug, Default)]
pub struct ExitState {
    confirmed: AtomicBool,
}

impl ExitState {
    pub fn confirm(&self) {
        self.confirmed.store(true, Ordering::SeqCst);
    }

    pub fn is_confirmed(&self) -> bool {
        self.confirmed.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_running_means_nothing_to_confirm() {
        assert_eq!(blocking_job_count(std::iter::empty()), 0);
    }

    /// 空闲家务不拦人——为 cache_gc 弹确认框会把确认框教成"闭眼点过"。
    #[test]
    fn idle_housekeeping_does_not_block_exit() {
        assert_eq!(blocking_job_count(["cache_gc", "noop"]), 0);
    }

    /// 用户的活儿(分析 / 转写 / 导出)一条都不能被无声打断。
    #[test]
    fn user_work_blocks_exit_and_is_counted() {
        assert_eq!(blocking_job_count(["transcribe", "cache_gc", "export_package", "analyze_l1"]), 3);
    }

    #[test]
    fn payload_carries_the_count() {
        assert_eq!(close_requested_payload(3)["running"], serde_json::json!(3));
    }

    /// 确认过一次之后就不许再拦:否则点了「仍要退出」应用还退不掉。
    #[test]
    fn confirmation_is_sticky() {
        let state = ExitState::default();
        assert!(!state.is_confirmed());
        state.confirm();
        assert!(state.is_confirmed());
        state.confirm();
        assert!(state.is_confirmed());
    }
}
