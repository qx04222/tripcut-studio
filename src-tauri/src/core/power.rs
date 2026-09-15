//! R18 W-6:低电量模式探针。
//!
//! R18 之前全仓 grep `lowPowerMode|battery|powerSource` 是**零命中**——用户拔掉电源、
//! 系统进了低电量模式,应用照样开满解码许可。`thermal.rs` 读的 `NSProcessInfo` 上就挂着
//! `isLowPowerModeEnabled`,不需要新依赖。
//!
//! `TRIPCUT_LOW_POWER_FILE`(文件内容 `true`/`1`/`on`/`false`/`0`/`off`)优先,供单测与
//! 本机验证。读不到一律按「没开」——不误降速。
//!
//! 调度器怎么用见 `jobs::poll_backoff_once`:开着低电量模式时解码许可减半(至少 1),
//! 与散热退避、「只在空闲时做后台工作」取**更严**的那个。

/// 低电量模式是否开着。
pub fn low_power_enabled() -> bool {
    if let Ok(path) = std::env::var("TRIPCUT_LOW_POWER_FILE") {
        if let Some(value) = std::fs::read_to_string(&path).ok().and_then(|text| parse_flag(&text)) {
            return value;
        }
    }
    system_low_power_enabled().unwrap_or(false)
}

/// 注入文件的解析:`true`/`1`/`on`/`yes` → 真;`false`/`0`/`off`/`no` → 假;其它 → None。
pub fn parse_flag(text: &str) -> Option<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Some(true),
        "false" | "0" | "off" | "no" => Some(false),
        _ => None,
    }
}

/// 低电量模式下的解码许可上限:减半,至少 1。与 `ThermalState::decode_limit` 同一形状,
/// 好让调用方把两者取 min。
pub fn decode_limit(low_power: bool, configured: usize) -> usize {
    if low_power {
        (configured / 2).max(1)
    } else {
        configured.max(1)
    }
}

#[cfg(target_os = "macos")]
fn system_low_power_enabled() -> Option<bool> {
    use objc2_foundation::NSProcessInfo;
    Some(NSProcessInfo::processInfo().isLowPowerModeEnabled())
}

#[cfg(not(target_os = "macos"))]
fn system_low_power_enabled() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_parsing_accepts_the_usual_spellings_and_rejects_junk() {
        for text in ["true", "1", "on", " YES\n"] {
            assert_eq!(parse_flag(text), Some(true), "text={text:?}");
        }
        for text in ["false", "0", "off", "No"] {
            assert_eq!(parse_flag(text), Some(false), "text={text:?}");
        }
        for text in ["", "maybe", "2"] {
            assert_eq!(parse_flag(text), None, "text={text:?}");
        }
    }

    /// 低电量模式把预算减半,但永远不减到 0(减到 0 等于无声停摆)。
    #[test]
    fn low_power_halves_the_decode_budget_but_never_to_zero() {
        assert_eq!(decode_limit(false, 8), 8);
        assert_eq!(decode_limit(true, 8), 4);
        assert_eq!(decode_limit(true, 2), 1);
        assert_eq!(decode_limit(true, 1), 1);
        assert_eq!(decode_limit(false, 0), 1);
    }

    /// 注入文件优先于系统状态;文件内容是垃圾时退回系统读数(而不是当成「开着」)。
    #[test]
    fn injection_file_overrides_the_system_probe() {
        struct EnvGuard(&'static str);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                std::env::remove_var(self.0);
            }
        }
        let _guard = EnvGuard("TRIPCUT_LOW_POWER_FILE");
        let directory = crate::core::test_support::TestDirectory::new();
        let file = directory.path().join("low-power");
        std::fs::write(&file, "true").unwrap();
        std::env::set_var("TRIPCUT_LOW_POWER_FILE", &file);
        assert!(low_power_enabled());
        std::fs::write(&file, "off").unwrap();
        assert!(!low_power_enabled());
        std::fs::write(&file, "不知道").unwrap();
        // 解析不出来 → 退回系统读数;本机通常没开低电量,但不能断言系统状态,
        // 只断言它不 panic 且返回一个 bool。
        let _ = low_power_enabled();
    }
}
