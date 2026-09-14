//! P6 内存档位与预算探针;R16 车道 E 升级为三档(自动档 v2)。
//!
//! `resolve()` 读取 `performance.memory_profile`("auto" | "standard" | "low")与
//! `performance.low_spec_mode`("auto" | "on" | "off"),按 `budget_bytes()` 落到
//! Standard / Low / LowSpec:
//! - LowSpec(省电 / 低配):`low_spec_mode = on`,或 `auto` 且物理内存 ≤ 8 GiB;
//! - Low(省内存):其余情况下 < 24 GiB(16 GiB 机器落这一档);
//! - Standard:≥ 24 GiB。
//!
//! `decode_permits()` 等方法是各档位对调度器 / 转写 / 侧车 / 播放器的约束单一来源。

use rusqlite::Connection;

use super::error::Result;
use super::settings::{string_value, LOW_SPEC_MODE_KEY, MEMORY_PROFILE_KEY};

/// 24 GiB,auto 档位 Standard / Low 的分界线。
const LOW_PROFILE_THRESHOLD_BYTES: u64 = 24 * 1024 * 1024 * 1024;
/// 8 GiB(含),auto 档位落到「省电 / 低配」的上限:M1/M2 Air、mini 基础款。
const LOW_SPEC_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// 内存压力探针:可用内存百分比低于该值时应当暂停新增重活。
pub const PAUSE_BELOW_PERCENT: u32 = 15;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MemoryProfile {
    Standard,
    Low,
    /// R16:省电 / 低配档(≤ 8 GiB 或用户手选)。
    LowSpec,
}

impl MemoryProfile {
    /// 解码并发许可数。LowSpec 是 2 份许可,但 4K 素材占 2 份(`uhd_decode_weight`),
    /// 所以「两条 1080p 并行」与「一条 4K 独占」内存相同。
    pub fn decode_permits(self) -> usize {
        match self {
            Self::Standard => 4,
            Self::Low | Self::LowSpec => 2,
        }
    }

    /// 一条 4K(任一边 > 1920)解码任务占几份许可。
    pub fn uhd_decode_weight(self) -> usize {
        match self {
            Self::Standard | Self::Low => 1,
            Self::LowSpec => 2,
        }
    }

    /// 单条大文件是否允许借走空闲解码许可做分段并行(R15-perf)。
    pub fn borrows_spare_decode_slots(self) -> bool {
        !matches!(self, Self::LowSpec)
    }

    /// 软解码线程数(0 = 交给 ffmpeg 默认)。
    pub fn software_decode_threads(self) -> usize {
        match self {
            Self::Standard => 0,
            Self::Low | Self::LowSpec => 4,
        }
    }

    /// worker 线程数上限(设置值再 clamp 到这里)。
    pub fn max_worker_count(self) -> usize {
        match self {
            Self::Standard | Self::Low => 8,
            Self::LowSpec => 2,
        }
    }

    /// 用户没选过 Whisper 模型档时的默认档。
    pub fn default_whisper_tier(self) -> &'static str {
        match self {
            Self::Standard | Self::Low => super::transcribe::DEFAULT_MODEL_TIER,
            Self::LowSpec => super::transcribe::LOW_POWER_MODEL_TIER,
        }
    }

    /// 是否启动 OCR / CLIP 侧车(LowSpec 不起:侧车冷启动 200 s、常驻 0.4–1 GB)。
    pub fn sidecars_enabled(self) -> bool {
        !matches!(self, Self::LowSpec)
    }

    /// 代理生成走「省内存」参数(码率上限 2.5M、软解限线程、realtime)。
    pub fn low_memory_proxy(self) -> bool {
        !matches!(self, Self::Standard)
    }

    /// 播放器用低配 mpv 参数表。
    pub fn low_spec_player(self) -> bool {
        matches!(self, Self::LowSpec)
    }

    /// 设置页 / 诊断用的档位名。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Low => "low",
            Self::LowSpec => "low_spec",
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

/// 纯函数版本,供测试与 `resolve()` 共用:给定预算字节数、`memory_profile` 与
/// `low_spec_mode` 两个设置值,返回落地的档位。`low_spec_mode` 优先:
/// `on` 直接 LowSpec;`auto` 且预算 ≤ 8 GiB 也是 LowSpec(不管 `memory_profile`
/// 选了什么——8 GB 机器手选「标准」只会把自己拖进 swap,想关就把开关拨到 `off`)。
pub fn profile_for_budget_and_mode(budget: u64, setting_value: &str, low_spec_mode: &str) -> MemoryProfile {
    match low_spec_mode {
        "on" => return MemoryProfile::LowSpec,
        "off" => {}
        _ => {
            if budget <= LOW_SPEC_THRESHOLD_BYTES {
                return MemoryProfile::LowSpec;
            }
        }
    }
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

/// 兼容旧调用:`low_spec_mode = auto`。
pub fn profile_for_budget(budget: u64, setting_value: &str) -> MemoryProfile {
    profile_for_budget_and_mode(budget, setting_value, "auto")
}

/// 解析当前生效的内存档位:读取两个设置(默认都是 `"auto"`),按 `budget_bytes()` 决定。
pub fn resolve(connection: &Connection) -> Result<MemoryProfile> {
    let setting_value = string_value(connection, MEMORY_PROFILE_KEY, "auto")?;
    let low_spec_mode = string_value(connection, LOW_SPEC_MODE_KEY, "auto")?;
    Ok(profile_for_budget_and_mode(budget_bytes(), &setting_value, &low_spec_mode))
}

/// 当前档位是否启动 OCR / CLIP 侧车;读设置失败按「启动」处理(不因为设置表坏了
/// 就静默少做分析)。各入队点(`artifacts` 的 clip_embed、`jobs` 的 ocr_scan、启动补扫)
/// 共用这一句。
pub fn sidecars_enabled(connection: &Connection) -> bool {
    resolve(connection).map(MemoryProfile::sidecars_enabled).unwrap_or(true)
}

/// 0–100 的可用内存百分比:`TRIPCUT_MEMORY_PRESSURE_FILE`(文件内容为整数)
/// 优先;否则读 `kern.memorystatus_level`(R16:这是 `memory_pressure` 命令与
/// 系统「内存压力」图的同一口径,压缩页与文件缓存不算「不可用」;旧算法
/// `(free+inactive+speculative)/total` 在本机读到 24–28% 时系统实际是 50–54%,
/// 8 GB 机器上会贴着 15/25 滞回带来回抖);sysctl 不可用时才退回
/// `host_statistics64` 那套。任何失败都返回 100(不误触发暂停)。
pub fn available_percent() -> u32 {
    if let Ok(path) = std::env::var("TRIPCUT_MEMORY_PRESSURE_FILE") {
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if let Ok(parsed) = contents.trim().parse::<u32>() {
                return parsed;
            }
        }
    }
    memorystatus_level()
        .or_else(host_available_percent)
        .unwrap_or(100)
}

/// `sysctl kern.memorystatus_level`:内核 jetsam 口径的「可用内存百分比」(0–100)。
/// 读不到(非 macOS、旧内核)返回 None。
fn memorystatus_level() -> Option<u32> {
    let name = std::ffi::CString::new("kern.memorystatus_level").ok()?;
    let mut value: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: `name` 是有效的 NUL 结尾 C 字符串;`value`/`size` 指向大小正确的缓冲区。
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut value as *mut libc::c_int as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || size != std::mem::size_of::<libc::c_int>() {
        return None;
    }
    u32::try_from(value).ok().map(|percent| percent.min(100))
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

    /// R16 自动档 v2:8 GiB(含)落省电 / 低配档,16 GiB 仍是省内存档,≥ 24 GiB 标准档。
    #[test]
    fn auto_v2_splits_8_16_and_24_gib_into_three_tiers() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(profile_for_budget_and_mode(8 * GIB, "auto", "auto"), MemoryProfile::LowSpec);
        assert_eq!(profile_for_budget_and_mode(8 * GIB - 1, "auto", "auto"), MemoryProfile::LowSpec);
        assert_eq!(profile_for_budget_and_mode(16 * GIB, "auto", "auto"), MemoryProfile::Low);
        assert_eq!(profile_for_budget_and_mode(24 * GIB, "auto", "auto"), MemoryProfile::Standard);
        assert_eq!(profile_for_budget_and_mode(0, "auto", "auto"), MemoryProfile::LowSpec);
    }

    /// 开关三态:on 在 32 GiB 机器上也是低配档;off 让 8 GiB 机器退回旧的省内存档;
    /// auto 时 8 GiB 机器手选「标准」不生效(低配优先)。
    #[test]
    fn low_spec_switch_overrides_memory_and_profile_setting() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(profile_for_budget_and_mode(32 * GIB, "auto", "on"), MemoryProfile::LowSpec);
        assert_eq!(profile_for_budget_and_mode(32 * GIB, "standard", "on"), MemoryProfile::LowSpec);
        assert_eq!(profile_for_budget_and_mode(8 * GIB, "auto", "off"), MemoryProfile::Low);
        assert_eq!(profile_for_budget_and_mode(8 * GIB, "standard", "off"), MemoryProfile::Standard);
        assert_eq!(profile_for_budget_and_mode(8 * GIB, "standard", "auto"), MemoryProfile::LowSpec);
    }

    /// 低配档对各子系统的约束:4K 独占(2 份许可里占 2)、不借槽、Whisper small、不起侧车、
    /// worker 最多 2、播放器低配参数;其它两档保持原状。
    #[test]
    fn low_spec_profile_constraints() {
        let profile = MemoryProfile::LowSpec;
        assert_eq!(profile.decode_permits(), 2);
        assert_eq!(profile.uhd_decode_weight(), 2);
        assert!(!profile.borrows_spare_decode_slots());
        assert_eq!(profile.default_whisper_tier(), "small");
        assert!(!profile.sidecars_enabled());
        assert_eq!(profile.max_worker_count(), 2);
        assert!(profile.low_spec_player());
        assert!(profile.low_memory_proxy());
        for other in [MemoryProfile::Standard, MemoryProfile::Low] {
            assert_eq!(other.uhd_decode_weight(), 1);
            assert!(other.borrows_spare_decode_slots());
            assert_eq!(other.default_whisper_tier(), "large-v3-turbo");
            assert!(other.sidecars_enabled());
            assert_eq!(other.max_worker_count(), 8);
            assert!(!other.low_spec_player());
        }
        assert!(!MemoryProfile::Standard.low_memory_proxy());
        assert!(MemoryProfile::Low.low_memory_proxy());
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
        assert_eq!(MemoryProfile::LowSpec.decode_permits(), 2);
        assert_eq!(MemoryProfile::Standard.software_decode_threads(), 0);
        assert_eq!(MemoryProfile::Low.software_decode_threads(), 4);
        assert_eq!(MemoryProfile::LowSpec.software_decode_threads(), 4);
    }

    /// R16:本机上内核口径必须读得到,且与旧口径同为 0–100;两者的差(内核把压缩页 /
    /// 文件缓存算可用)就是改口径的理由,这里只断言两者都在合法范围、内核口径 ≥ 旧口径。
    #[test]
    fn memorystatus_level_is_readable_and_not_below_legacy_probe() {
        let kernel = memorystatus_level().expect("macOS 上 kern.memorystatus_level 应可读");
        let legacy = host_available_percent().expect("host_statistics64 应可读");
        assert!(kernel <= 100 && legacy <= 100, "kernel={kernel} legacy={legacy}");
        assert!(kernel + 5 >= legacy, "内核口径 {kernel}% 不该明显低于旧口径 {legacy}%(旧口径把压缩页算成不可用;留 5 点采样抖动)");
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
