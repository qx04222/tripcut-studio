//! P6 内存档位与预算探针。
//!
//! `resolve()` 读取 `performance.memory_profile` 设置（"auto" | "standard" | "low"），
//! `auto` 时按 `budget_bytes()` 与 24 GiB 的比较结果落到 Standard/Low。
//! `decode_permits()` / `software_decode_threads()` 供后续任务（R1 Task 7/9）接线消费。

use rusqlite::Connection;

use super::error::Result;
use super::settings::{string_value, MEMORY_PROFILE_KEY};

/// 24 GiB，auto 档位的分界线。
const LOW_PROFILE_THRESHOLD_BYTES: u64 = 24 * 1024 * 1024 * 1024;

/// 内存压力探针：可用内存百分比低于该值时应当暂停新增重活。
pub const PAUSE_BELOW_PERCENT: u32 = 15;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MemoryProfile {
    Standard,
    Low,
}

impl MemoryProfile {
    /// R1 Task 7 接线：解码并发许可数。
    #[allow(dead_code)] // R1 Task 7 接线
    pub fn decode_permits(self) -> usize {
        match self {
            Self::Standard => 4,
            Self::Low => 2,
        }
    }

    /// R1 Task 9 接线：软解码线程数（0 = 交给 ffmpeg 默认）。
    #[allow(dead_code)] // R1 Task 9 接线
    pub fn software_decode_threads(self) -> usize {
        match self {
            Self::Standard => 0,
            Self::Low => 4,
        }
    }
}

/// 内存预算（字节）：`TRIPCUT_MEMORY_BUDGET_BYTES` 环境变量优先，否则读取
/// `sysctlbyname("hw.memsize")`。任何失败都返回 0（视作最保守情形）。
pub fn budget_bytes() -> u64 {
    if let Ok(value) = std::env::var("TRIPCUT_MEMORY_BUDGET_BYTES") {
        if let Ok(parsed) = value.trim().parse::<u64>() {
            return parsed;
        }
    }
    hw_memsize().unwrap_or(0)
}

fn hw_memsize() -> Option<u64> {
    let name = std::ffi::CString::new("hw.memsize").ok()?;
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: `name` is a valid NUL-terminated C string kept alive for the
    // duration of the call; `value`/`size` point at a correctly sized buffer.
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut value as *mut u64 as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result == 0 {
        Some(value)
    } else {
        None
    }
}

/// 纯函数版本，供测试与 `resolve()` 共用：给定预算字节数与设置字符串值，
/// 返回落地的档位。
pub fn profile_for_budget(budget: u64, setting_value: &str) -> MemoryProfile {
    match setting_value {
        "low" => MemoryProfile::Low,
        "standard" => MemoryProfile::Standard,
        _ => {
            if budget < LOW_PROFILE_THRESHOLD_BYTES {
                MemoryProfile::Low
            } else {
                MemoryProfile::Standard
            }
        }
    }
}

/// 解析当前生效的内存档位：读取设置（默认 `"auto"`），auto 时按
/// `budget_bytes()` 与 24 GiB 的比较结果决定。
pub fn resolve(connection: &Connection) -> Result<MemoryProfile> {
    let setting_value = string_value(connection, MEMORY_PROFILE_KEY, "auto")?;
    Ok(profile_for_budget(budget_bytes(), &setting_value))
}

/// 0–100 的可用内存百分比：`TRIPCUT_MEMORY_PRESSURE_FILE`（文件内容为整数）
/// 优先；否则通过 `host_statistics64` 计算 `(free+inactive+speculative)/total`，
/// 其中 total 优先取物理内存总量（`hw.memsize`/页大小，天然包含压缩页与其它
/// 一切），失败时退回 `vm_statistics64` 各分区之和。任何失败都返回 100（不
/// 误触发暂停）。
pub fn available_percent() -> u32 {
    if let Ok(path) = std::env::var("TRIPCUT_MEMORY_PRESSURE_FILE") {
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = contents.trim().parse::<u32>() {
                return parsed;
            }
        }
    }
    host_available_percent().unwrap_or(100)
}

/// 纯函数版本：给定 free/inactive/speculative 页数与 total_pages（物理内存
/// 总页数），返回 0–100 的可用百分比。total 为 0，或分子超过分母（不同来源
/// 的页数计数在边界处可能不完全一致）都视作 100（最保守：不误触发暂停）。
fn available_percent_from(free: u64, inactive: u64, speculative: u64, total_pages: u64) -> u32 {
    if total_pages == 0 {
        return 100;
    }
    let available_pages = free + inactive + speculative;
    if available_pages >= total_pages {
        return 100;
    }
    ((available_pages * 100) / total_pages).min(100) as u32
}

fn host_available_percent() -> Option<u32> {
    // SAFETY: `mach_host_self()` returns a borrowed send-right that does not
    // need to be deallocated for the special "self" port. `vm_page_size` is a
    // static populated by libSystem before `main` runs. `host_statistics64`
    // is called with a correctly sized `vm_statistics64` buffer and its
    // matching word count, matching Apple's documented usage.
    #[allow(deprecated)] // no `mach2` dependency available; libc's mach_host_self still works
    unsafe {
        let host = libc::mach_host_self();
        let page_size = libc::vm_page_size;
        if page_size == 0 {
            return None;
        }

        let mut stats: libc::vm_statistics64 = std::mem::zeroed();
        let mut count = (std::mem::size_of::<libc::vm_statistics64>()
            / std::mem::size_of::<libc::integer_t>()) as libc::mach_msg_type_number_t;
        let result = libc::host_statistics64(
            host,
            libc::HOST_VM_INFO64,
            &mut stats as *mut libc::vm_statistics64 as *mut libc::integer_t,
            &mut count,
        );
        if result != libc::KERN_SUCCESS {
            return None;
        }

        let free_pages = u64::from(stats.free_count);
        let inactive_pages = u64::from(stats.inactive_count);
        let speculative_pages = u64::from(stats.speculative_count);

        // 分母优先用物理内存总量（不受 TRIPCUT_MEMORY_BUDGET_BYTES 覆盖影响），
        // 按构造天然包含压缩页与投机页；hw.memsize 不可用时才退回各分区之和。
        let total_pages = match hw_memsize() {
            Some(physical_bytes) if physical_bytes > 0 => physical_bytes / page_size as u64,
            _ => {
                free_pages
                    + inactive_pages
                    + u64::from(stats.active_count)
                    + u64::from(stats.wire_count)
                    + speculative_pages
                    + u64::from(stats.compressor_page_count)
            }
        };

        Some(available_percent_from(
            free_pages,
            inactive_pages,
            speculative_pages,
            total_pages,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的环境变量守卫：作用域结束时自动 `remove_var`，即便中途断言
    /// panic 也不会把变量泄漏给同进程的其它测试。
    struct EnvGuard(&'static str);

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    #[test]
    fn budget_env_overrides_hw_memsize_and_low_profile_below_24_gib() {
        let _guard = EnvGuard("TRIPCUT_MEMORY_BUDGET_BYTES");
        std::env::set_var("TRIPCUT_MEMORY_BUDGET_BYTES", "12884901888");
        assert_eq!(budget_bytes(), 12_884_901_888);
        assert_eq!(profile_for_budget(12_884_901_888, "auto"), MemoryProfile::Low);
        assert_eq!(profile_for_budget(34_359_738_368, "auto"), MemoryProfile::Standard);
        assert_eq!(profile_for_budget(34_359_738_368, "low"), MemoryProfile::Low);
    }

    #[test]
    fn pressure_file_overrides_host_statistics() {
        let _guard = EnvGuard("TRIPCUT_MEMORY_PRESSURE_FILE");
        let directory = crate::core::test_support::TestDirectory::new();
        let file = directory.path().join("pressure");
        std::fs::write(&file, "9").unwrap();
        std::env::set_var("TRIPCUT_MEMORY_PRESSURE_FILE", &file);
        assert_eq!(available_percent(), 9);
        drop(_guard);
        assert!(available_percent() <= 100);
    }

    #[test]
    fn decode_permits_and_threads_match_profile() {
        assert_eq!(MemoryProfile::Standard.decode_permits(), 4);
        assert_eq!(MemoryProfile::Low.decode_permits(), 2);
        assert_eq!(MemoryProfile::Standard.software_decode_threads(), 0);
        assert_eq!(MemoryProfile::Low.software_decode_threads(), 4);
    }

    #[test]
    fn available_percent_from_quarter_free_is_25() {
        assert_eq!(available_percent_from(250, 0, 0, 1000), 25);
    }

    #[test]
    fn available_percent_from_zero_total_is_100() {
        assert_eq!(available_percent_from(0, 0, 0, 0), 100);
    }

    #[test]
    fn available_percent_from_numerator_over_total_is_100() {
        assert_eq!(available_percent_from(600, 300, 300, 1000), 100);
    }
}
