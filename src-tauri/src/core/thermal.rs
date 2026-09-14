//! R16 车道 E(§3 ⑤):散热与「只在空闲时做后台工作」的两个探针。
//!
//! - `thermal_state()`:`NSProcessInfo.thermalState` 四档(nominal / fair / serious / critical);
//!   `TRIPCUT_THERMAL_STATE_FILE`(文件内容为档名或 0–3)优先,供单测与本机验证——本机 M5
//!   诱发不了热限流。读不到按 nominal(不误退避)。
//! - `seconds_since_user_input()`:`CGEventSourceSecondsSinceLastEventType`(合并会话态、任意
//!   输入事件),不需要辅助功能权限;`TRIPCUT_IDLE_SECONDS_FILE` 优先。读不到按 0(视作用户
//!   正在用电脑,不误认领)。
//!
//! 调度器怎么用这两个值见 `jobs::poll_backoff_once`。

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum ThermalState {
    Nominal,
    Fair,
    Serious,
    Critical,
}

impl ThermalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nominal => "nominal",
            Self::Fair => "fair",
            Self::Serious => "serious",
            Self::Critical => "critical",
        }
    }

    /// 解析文件 / 环境注入的值:档名(不分大小写)或 0–3。
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "nominal" | "0" => Some(Self::Nominal),
            "fair" | "1" => Some(Self::Fair),
            "serious" | "2" => Some(Self::Serious),
            "critical" | "3" => Some(Self::Critical),
            _ => None,
        }
    }

    /// 本档位下解码类许可的有效上限:nominal 全速;fair 少一份(至少 1);serious / critical 只剩 1。
    pub fn decode_limit(self, configured: usize) -> usize {
        match self {
            Self::Nominal => configured.max(1),
            Self::Fair => configured.saturating_sub(1).max(1),
            Self::Serious | Self::Critical => 1,
        }
    }
}

/// 当前散热状态(见模块注释)。
pub fn thermal_state() -> ThermalState {
    if let Ok(path) = std::env::var("TRIPCUT_THERMAL_STATE_FILE") {
        if let Some(state) = std::fs::read_to_string(&path).ok().and_then(|text| ThermalState::parse(&text)) {
            return state;
        }
    }
    process_info_thermal_state().unwrap_or(ThermalState::Nominal)
}

#[cfg(target_os = "macos")]
fn process_info_thermal_state() -> Option<ThermalState> {
    use objc2_foundation::{NSProcessInfo, NSProcessInfoThermalState};
    let state = NSProcessInfo::processInfo().thermalState();
    Some(match state {
        NSProcessInfoThermalState::Nominal => ThermalState::Nominal,
        NSProcessInfoThermalState::Fair => ThermalState::Fair,
        NSProcessInfoThermalState::Serious => ThermalState::Serious,
        NSProcessInfoThermalState::Critical => ThermalState::Critical,
        _ => return None,
    })
}

#[cfg(not(target_os = "macos"))]
fn process_info_thermal_state() -> Option<ThermalState> {
    None
}

/// 用户多少秒没碰键鼠 / 触控板(见模块注释)。
pub fn seconds_since_user_input() -> f64 {
    if let Ok(path) = std::env::var("TRIPCUT_IDLE_SECONDS_FILE") {
        if let Some(seconds) = std::fs::read_to_string(&path).ok().and_then(|text| text.trim().parse::<f64>().ok()) {
            if seconds.is_finite() && seconds >= 0.0 {
                return seconds;
            }
        }
    }
    system_seconds_since_input().unwrap_or(0.0)
}

#[cfg(target_os = "macos")]
fn system_seconds_since_input() -> Option<f64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState = 1;kCGAnyInputEventType = !0。
    // SAFETY: 纯查询函数,无指针参数;返回 CFTimeInterval。
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) };
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds)
}

#[cfg(not(target_os = "macos"))]
fn system_seconds_since_input() -> Option<f64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard(&'static str);

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    #[test]
    fn thermal_file_overrides_process_info_and_parses_names_or_digits() {
        let _guard = EnvGuard("TRIPCUT_THERMAL_STATE_FILE");
        let directory = crate::core::test_support::TestDirectory::new();
        let file = directory.path().join("thermal");
        std::env::set_var("TRIPCUT_THERMAL_STATE_FILE", &file);
        for (text, expected) in [
            ("serious", ThermalState::Serious),
            ("CRITICAL\n", ThermalState::Critical),
            ("1", ThermalState::Fair),
            ("0", ThermalState::Nominal),
        ] {
            std::fs::write(&file, text).unwrap();
            assert_eq!(thermal_state(), expected, "{text:?}");
        }
        // 写坏了 / 没写:退回系统值(本机应是 nominal 或 fair,总归可读)。
        std::fs::write(&file, "hot?").unwrap();
        let _ = thermal_state();
        drop(_guard);
        assert!(process_info_thermal_state().is_some(), "macOS 上 NSProcessInfo.thermalState 应可读");
    }

    #[test]
    fn thermal_decode_limit_three_tiers() {
        assert_eq!(ThermalState::Nominal.decode_limit(4), 4);
        assert_eq!(ThermalState::Fair.decode_limit(4), 3);
        assert_eq!(ThermalState::Fair.decode_limit(1), 1);
        assert_eq!(ThermalState::Serious.decode_limit(4), 1);
        assert_eq!(ThermalState::Critical.decode_limit(2), 1);
    }

    #[test]
    fn idle_seconds_file_overrides_system_and_rejects_garbage() {
        let _guard = EnvGuard("TRIPCUT_IDLE_SECONDS_FILE");
        let directory = crate::core::test_support::TestDirectory::new();
        let file = directory.path().join("idle");
        std::env::set_var("TRIPCUT_IDLE_SECONDS_FILE", &file);
        std::fs::write(&file, "75.5").unwrap();
        assert_eq!(seconds_since_user_input(), 75.5);
        std::fs::write(&file, "-3").unwrap();
        let fallback = seconds_since_user_input();
        assert!(fallback >= 0.0);
        drop(_guard);
        assert!(system_seconds_since_input().is_some(), "macOS 上 CGEventSourceSecondsSinceLastEventType 应可读");
    }
}
