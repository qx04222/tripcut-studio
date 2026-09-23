//! R16 车道 E(§3 ⑥):libmpv 初始化选项表——`mod.rs` 的 `run_worker` 只按这张表逐条
//! `set_property`,不再手写。低配档(`memory_profile::MemoryProfile::low_spec_player`)换一套
//! 更省内存 / 更省 GPU 的参数:
//! - `demuxer-max-bytes` 150 → 64 MiB、`demuxer-max-back-bytes` 50 → 16 MiB、`cache-secs` 10 → 5:
//!   解复用缓存少 120 MiB;
//! - `scale=bilinear`、`dither=no`:默认 lanczos 在 4K→面板缩放时是最贵的一步;
//! - `vd-lavc-threads` = 性能核数(`hw.perflevel0.logicalcpu`,读不到用 ncpu/2,至少 2):
//!   软解回退时不把 10 个线程各一份 4K 参考帧都开出来。
//! 档位由 `set_low_spec` 在启动接线时写一次(`lib.rs`),播放器打开时读。

use std::sync::atomic::{AtomicBool, Ordering};

static LOW_SPEC: AtomicBool = AtomicBool::new(false);

/// 启动接线:是否用低配参数表。
pub fn set_low_spec(low_spec: bool) {
    LOW_SPEC.store(low_spec, Ordering::Relaxed);
}

pub fn low_spec_enabled() -> bool {
    LOW_SPEC.load(Ordering::Relaxed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MpvValue {
    Str(&'static str),
    Bool(bool),
    Int(i64),
}

/// 一条初始化选项:`required` 为真时设置失败就让整个播放器初始化失败(vo / hwdec 这种没有
/// 就不能播);为假时只告警——分发版 libmpv 是 `-Dcplayer=false`,`osc` 这类 cplayer 属性不存在。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MpvOption {
    pub name: &'static str,
    pub value: MpvValue,
    pub required: bool,
}

const fn required(name: &'static str, value: MpvValue) -> MpvOption {
    MpvOption { name, value, required: true }
}

const fn optional(name: &'static str, value: MpvValue) -> MpvOption {
    MpvOption { name, value, required: false }
}

/// 当前档位的选项表(按接线时的 `set_low_spec`)。
pub fn init_options() -> Vec<MpvOption> {
    init_options_for(low_spec_enabled(), performance_core_count())
}

/// 纯函数版本,供单测:`low_spec` 档位与用于 `vd-lavc-threads` 的线程数。
pub fn init_options_for(low_spec: bool, decode_threads: usize) -> Vec<MpvOption> {
    let mut options = vec![
        required("vo", MpvValue::Str("libmpv")),
        required("hwdec", MpvValue::Str("videotoolbox")),
        required("keep-open", MpvValue::Str("yes")),
        // osc 是 cplayer 的屏幕控制器开关,内嵌 render API 模式下本来就没有它;分发版
        // 链接的 LGPL libmpv 用 -Dcplayer=false 编译,该属性不存在,只能是 optional。
        optional("osc", MpvValue::Bool(false)),
        required("pause", MpvValue::Bool(true)),
        // 单声道布局被 coreaudio 拒绝(-50)后会回退 avfoundation,其约 4 s 音频缓冲
        // 提前撞到 end/EOF;Pause 经 ao_drain 等缓冲放完,卡约 2 s。监视器预览下混
        // 成立体声不损失预览用途,导出不经 mpv;两档均请求 stereo 以保持 coreaudio。
        optional("audio-channels", MpvValue::Str("stereo")),
    ];
    if low_spec {
        options.extend([
            optional("demuxer-max-bytes", MpvValue::Str("64MiB")),
            optional("demuxer-max-back-bytes", MpvValue::Str("16MiB")),
            optional("cache-secs", MpvValue::Int(5)),
            optional("scale", MpvValue::Str("bilinear")),
            optional("dither", MpvValue::Str("no")),
            optional("vd-lavc-threads", MpvValue::Int(decode_threads.max(1) as i64)),
        ]);
    } else {
        // 解复用缓存上限:避免长时间播放 / 拖动时 demuxer 缓存无界增长占满内存。这三项属于
        // demuxer 核心而非 cplayer,理论上总是存在;仍以 optional 兜底,缺失时告警不阻断。
        options.extend([
            optional("demuxer-max-bytes", MpvValue::Str("150MiB")),
            optional("demuxer-max-back-bytes", MpvValue::Str("50MiB")),
            optional("cache-secs", MpvValue::Int(10)),
        ]);
    }
    options
}

/// 真机诊断显式开启;空白视为未设置,有内容的路径原样保留。
pub fn mpv_log_file_from_env(value: Option<String>) -> Option<String> {
    value.filter(|path| !path.trim().is_empty())
}

/// 性能核数:`hw.perflevel0.logicalcpu`;读不到用 `hw.ncpu / 2`;都读不到按 2。
pub fn performance_core_count() -> usize {
    sysctl_usize("hw.perflevel0.logicalcpu")
        .or_else(|| sysctl_usize("hw.ncpu").map(|ncpu| ncpu / 2))
        .filter(|count| *count >= 1)
        .unwrap_or(2)
        .max(2)
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
    (result == 0 && value > 0).then_some(value as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_profiles_request_optional_stereo_preview_audio() {
        for low_spec in [false, true] {
            let options = init_options_for(low_spec, 4);
            assert_eq!(find(&options, "audio-channels"), Some(&optional("audio-channels", MpvValue::Str("stereo"))));
        }
    }

    #[test]
    fn diagnostic_log_file_is_opt_in_and_preserves_the_path() {
        assert_eq!(mpv_log_file_from_env(None), None);
        for empty in ["", " ", "\t\n"] {
            assert_eq!(mpv_log_file_from_env(Some(empty.into())), None);
        }
        for path in ["/tmp/mpv-r26.log", "/tmp/mpv log.txt", " /tmp/space "] {
            assert_eq!(mpv_log_file_from_env(Some(path.into())), Some(path.into()));
        }
    }

    fn find<'a>(options: &'a [MpvOption], name: &str) -> Option<&'a MpvOption> {
        options.iter().find(|option| option.name == name)
    }

    #[test]
    fn standard_table_keeps_the_pre_r16_values() {
        let options = init_options_for(false, 4);
        assert_eq!(find(&options, "vo").unwrap().value, MpvValue::Str("libmpv"));
        assert!(find(&options, "vo").unwrap().required);
        assert_eq!(find(&options, "hwdec").unwrap().value, MpvValue::Str("videotoolbox"));
        assert_eq!(find(&options, "keep-open").unwrap().value, MpvValue::Str("yes"));
        assert!(!find(&options, "osc").unwrap().required);
        assert_eq!(find(&options, "pause").unwrap().value, MpvValue::Bool(true));
        assert_eq!(find(&options, "demuxer-max-bytes").unwrap().value, MpvValue::Str("150MiB"));
        assert_eq!(find(&options, "demuxer-max-back-bytes").unwrap().value, MpvValue::Str("50MiB"));
        assert_eq!(find(&options, "cache-secs").unwrap().value, MpvValue::Int(10));
        for absent in ["scale", "dither", "vd-lavc-threads"] {
            assert!(find(&options, absent).is_none(), "标准档不该设 {absent}");
        }
    }

    #[test]
    fn low_spec_table_shrinks_cache_and_uses_cheap_scaler_and_core_count() {
        let options = init_options_for(true, 4);
        assert_eq!(find(&options, "hwdec").unwrap().value, MpvValue::Str("videotoolbox"));
        assert_eq!(find(&options, "demuxer-max-bytes").unwrap().value, MpvValue::Str("64MiB"));
        assert_eq!(find(&options, "demuxer-max-back-bytes").unwrap().value, MpvValue::Str("16MiB"));
        assert_eq!(find(&options, "cache-secs").unwrap().value, MpvValue::Int(5));
        assert_eq!(find(&options, "scale").unwrap().value, MpvValue::Str("bilinear"));
        assert_eq!(find(&options, "dither").unwrap().value, MpvValue::Str("no"));
        assert_eq!(find(&options, "vd-lavc-threads").unwrap().value, MpvValue::Int(4));
        assert!(options.iter().filter(|option| option.name != "vo" && option.name != "hwdec" && option.name != "keep-open" && option.name != "pause").all(|option| !option.required));
        assert_eq!(init_options_for(true, 0).iter().find(|o| o.name == "vd-lavc-threads").unwrap().value, MpvValue::Int(1));
    }

    /// 两套表里的每一项都要被本机链接的 libmpv 认识(`scale` / `dither` / `vd-lavc-threads`
    /// 是 vo_gpu / vd_lavc 的选项,分发版 -Dcplayer=false 也有);唯一允许失败的是 `osc`。
    #[test]
    fn every_option_in_both_tables_is_accepted_by_libmpv_except_osc() {
        for low_spec in [false, true] {
            let options = init_options_for(low_spec, 4);
            let rejected = std::sync::Mutex::new(Vec::new());
            let mpv = libmpv2::Mpv::with_initializer(|initializer| {
                for option in &options {
                    let result = match option.value {
                        MpvValue::Str(value) => initializer.set_property(option.name, value),
                        MpvValue::Bool(value) => initializer.set_property(option.name, value),
                        MpvValue::Int(value) => initializer.set_property(option.name, value),
                    };
                    if let Err(error) = result {
                        rejected.lock().unwrap().push(format!("{}: {error}", option.name));
                    }
                }
                Ok(())
            });
            assert!(mpv.is_ok(), "low_spec={low_spec}: {:?}", mpv.err());
            let rejected = rejected.into_inner().unwrap();
            assert!(
                rejected.iter().all(|line| line.starts_with("osc:")),
                "low_spec={low_spec} 被 libmpv 拒绝的选项:{rejected:?}"
            );
        }
    }

    #[test]
    fn switch_selects_the_table_and_core_count_is_sane() {
        set_low_spec(true);
        assert!(init_options().iter().any(|option| option.name == "scale"));
        set_low_spec(false);
        assert!(!init_options().iter().any(|option| option.name == "scale"));
        let cores = performance_core_count();
        assert!((2..=64).contains(&cores), "cores={cores}");
    }
}
