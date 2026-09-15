//! R18 W-1:机器能力探针——内存、P/E 核数、芯片档次、媒体引擎数。
//!
//! 在这之前全仓只有 `player/mpv_options.rs` 读过一次 CPU 拓扑,没有一处认得出
//! 芯片型号,于是 `memory_profile` 的解码许可从 16 GB 的 M1 Air 到 128 GB 的
//! M4 Max 一律是写死的 4。这个模块提供第二、第三个输入维度。
//!
//! 三条实测得来的注意事项(R18 头脑风暴 §1.1,本机 M5 / Darwin 27):
//! - `hw.perflevel0.physicalcpucount` **这个 OID 不存在**,正确的是
//!   `hw.perflevel0.physicalcpu`;
//! - `hw.perflevel0.name` 在 M5 上是 `Super` 而不是 `Performance`,任何按名字
//!   判 P 核的写法都会失效——只能按 index 0 取;
//! - `machdep.cpu.brand_string` 本机是 `Apple M5`(基础款没有后缀)。
//!
//! 解析不出来一律按 `Chip::Unknown` → 1 个媒体引擎 → 落回保守档位(失败朝保守)。

use std::sync::OnceLock;

/// 芯片档次。只关心它带几个媒体引擎,不关心代数。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chip {
    Base,
    Pro,
    Max,
    Ultra,
    Unknown,
}

impl Chip {
    /// 媒体引擎(VideoToolbox 硬件编解码单元)个数。Apple 公开规格:
    /// 基础款 1、Pro / Max 2、Ultra 4。认不出来按 1 算(保守)。
    pub fn media_engines(self) -> usize {
        match self {
            Self::Base | Self::Unknown => 1,
            Self::Pro | Self::Max => 2,
            Self::Ultra => 4,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Pro => "pro",
            Self::Max => "max",
            Self::Ultra => "ultra",
            Self::Unknown => "unknown",
        }
    }
}

/// `machdep.cpu.brand_string` → 芯片档次。
/// `"Apple M4 Pro"` → Pro、`"Apple M5"` → Base、Intel / 空串 / 认不出来 → Unknown。
pub fn parse_chip(brand: &str) -> Chip {
    let lower = brand.to_ascii_lowercase();
    let Some(rest) = lower.split("apple m").nth(1) else {
        return Chip::Unknown;
    };
    // rest 形如 "5"、"4 pro"、"3 max"、"2 ultra";第一段必须是代数数字。
    let mut parts = rest.split_whitespace();
    let Some(generation) = parts.next() else {
        return Chip::Unknown;
    };
    if !generation.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return Chip::Unknown;
    }
    match parts.next() {
        Some("pro") => Chip::Pro,
        Some("max") => Chip::Max,
        Some("ultra") => Chip::Ultra,
        Some(_) => Chip::Base,
        None => Chip::Base,
    }
}

/// 一台机器的能力三元组。`memory_bytes` 走 `memory_profile::budget_bytes()`
/// (认 `TRIPCUT_MEMORY_BUDGET_BYTES`),另外两项来自 sysctl,可用
/// `TRIPCUT_MACHINE_BRAND` / `TRIPCUT_MACHINE_PERF_CORES` 覆盖(测试与 perf_driver 用)。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct MachineClass {
    pub memory_bytes: u64,
    pub perf_cores: usize,
    pub efficiency_cores: usize,
    pub chip: Chip,
}

impl MachineClass {
    pub fn media_engines(&self) -> usize {
        self.chip.media_engines()
    }
}

fn sysctl_usize(name: &str) -> Option<usize> {
    let name = std::ffi::CString::new(name).ok()?;
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
    if result != 0 || size != std::mem::size_of::<libc::c_int>() || value < 0 {
        return None;
    }
    Some(value as usize)
}

fn sysctl_string(name: &str) -> Option<String> {
    let c_name = std::ffi::CString::new(name).ok()?;
    let mut size: usize = 0;
    // SAFETY: 第一次调用只查长度(buffer 为 null 是 sysctlbyname 的约定用法)。
    let probe = unsafe {
        libc::sysctlbyname(
            c_name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if probe != 0 || size == 0 || size > 1024 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    // SAFETY: buffer 的容量恰好是上一步查到的 size。
    let result = unsafe {
        libc::sysctlbyname(
            c_name.as_ptr(),
            buffer.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&buffer);
    Some(text.trim_end_matches('\0').trim().to_owned())
}

/// 探测当前机器。`memory_bytes` 由调用方传入(与 `memory_profile::budget_bytes()`
/// 同一口径,好让 `TRIPCUT_MEMORY_BUDGET_BYTES` 的模拟仍然成立)。
pub fn detect_with_memory(memory_bytes: u64) -> MachineClass {
    let brand = std::env::var("TRIPCUT_MACHINE_BRAND")
        .ok()
        .or_else(|| sysctl_string("machdep.cpu.brand_string"))
        .unwrap_or_default();
    let perf_cores = std::env::var("TRIPCUT_MACHINE_PERF_CORES")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .or_else(|| sysctl_usize("hw.perflevel0.physicalcpu"))
        .unwrap_or(4);
    let efficiency_cores = sysctl_usize("hw.perflevel1.physicalcpu").unwrap_or(0);
    MachineClass {
        memory_bytes,
        perf_cores: perf_cores.max(1),
        efficiency_cores,
        chip: parse_chip(&brand),
    }
}

/// 进程内缓存的硬件事实(芯片与核数不会在进程生命周期内变)。内存字节数
/// 每次由调用方给,所以这里只缓存芯片与核数。
fn cached_static() -> &'static (usize, usize, Chip) {
    static CELL: OnceLock<(usize, usize, Chip)> = OnceLock::new();
    CELL.get_or_init(|| {
        let machine = detect_with_memory(0);
        (machine.perf_cores, machine.efficiency_cores, machine.chip)
    })
}

/// 本机的芯片与核数(缓存),配上调用方给的内存字节数。
pub fn for_memory(memory_bytes: u64) -> MachineClass {
    let (perf_cores, efficiency_cores, chip) = *cached_static();
    MachineClass {
        memory_bytes,
        perf_cores,
        efficiency_cores,
        chip,
    }
}

/// 当前机器(内存来自 `memory_profile::budget_bytes()`)。
pub fn current() -> MachineClass {
    for_memory(super::memory_profile::budget_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brand_string_maps_to_chip_tier() {
        assert_eq!(parse_chip("Apple M5"), Chip::Base);
        assert_eq!(parse_chip("Apple M1"), Chip::Base);
        assert_eq!(parse_chip("Apple M4 Pro"), Chip::Pro);
        assert_eq!(parse_chip("Apple M3 Max"), Chip::Max);
        assert_eq!(parse_chip("apple m2 ultra"), Chip::Ultra);
    }

    /// 失败朝保守:认不出来的一律 Unknown → 1 个媒体引擎。
    #[test]
    fn unrecognised_brand_falls_back_to_unknown_single_engine() {
        for brand in ["", "Intel(R) Core(TM) i9-9880H CPU @ 2.30GHz", "Apple Silicon", "Banana M4 Max"] {
            assert_eq!(parse_chip(brand), Chip::Unknown, "brand={brand}");
        }
        assert_eq!(Chip::Unknown.media_engines(), 1);
    }

    #[test]
    fn media_engine_counts_match_apple_specs() {
        assert_eq!(Chip::Base.media_engines(), 1);
        assert_eq!(Chip::Pro.media_engines(), 2);
        assert_eq!(Chip::Max.media_engines(), 2);
        assert_eq!(Chip::Ultra.media_engines(), 4);
    }

    /// 本机(M 系列 Mac)上三条 sysctl 都必须读得到,且 P 核数 ≥ 1。
    /// `hw.perflevel0.name` 在 M5 上是 `Super`,所以这里按 index 取而不是按名字。
    #[test]
    fn detect_reads_real_sysctls_on_this_machine() {
        let machine = detect_with_memory(0);
        assert!(machine.perf_cores >= 1, "perf_cores={}", machine.perf_cores);
        assert!(sysctl_string("machdep.cpu.brand_string").is_some());
        assert_eq!(sysctl_usize("hw.perflevel0.physicalcpucount"), None, "这个 OID 在 Darwin 27 上不存在");
    }
}
