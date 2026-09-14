//! R17 exportfix:ffmpeg 编码器能力探测与 H.264 编码参数选择。
//!
//! 业主真机上剪映素材包 11/11 条失败:`Unrecognized option 'allow_sw'` —— 那份 ffmpeg
//! 里没有任何 VideoToolbox 编码器(AVOption 按全部编码器私有类查找,没有 VT 就连
//! `-allow_sw` 这个选项名都不认)。这里跑一次 `ffmpeg -hide_banner -encoders`,按
//! 路径 + mtime 缓存,导出 / 代理 / 粗剪三处按能力选编码器,而不是写死 VT。

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// 一份 ffmpeg 二进制里有哪些我们关心的编码器。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EncoderCaps {
    pub h264_videotoolbox: bool,
    pub hevc_videotoolbox: bool,
    pub libx264: bool,
    pub mpeg4: bool,
}

/// H.264 交付实际选用的编码器。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum H264Encoder {
    /// 硬件 H.264(现状参数,`-allow_sw 1` 允许系统软件编码兜底)。
    VideoToolbox,
    /// 没有 VT 但有 libx264:`-preset veryfast -crf 18`。
    X264,
    /// 两者都没有:`mpeg4 -q:v 2`,结果 note 里标 warning。
    Mpeg4Fallback,
}

/// 兼容编码兜底时写进结果 note 的一句话(`warning = true`)。
pub const SOFTWARE_FALLBACK_NOTE: &str = "当前 ffmpeg 不支持硬件 H.264,已用兼容编码";

impl EncoderCaps {
    pub fn h264_encoder(self) -> H264Encoder {
        if self.h264_videotoolbox {
            H264Encoder::VideoToolbox
        } else if self.libx264 {
            H264Encoder::X264
        } else {
            H264Encoder::Mpeg4Fallback
        }
    }
}

impl H264Encoder {
    /// 兜底编码(不是 H.264)时给用户的提示;VT / x264 都是正经 H.264,不提示。
    pub fn fallback_note(self) -> Option<String> {
        matches!(self, H264Encoder::Mpeg4Fallback).then(|| SOFTWARE_FALLBACK_NOTE.to_owned())
    }

    /// 出错信息里的编码器名(「VFR 整条 VideoToolbox 转码」那种 label 用)。
    pub fn label(self) -> &'static str {
        match self {
            H264Encoder::VideoToolbox => "VideoToolbox",
            H264Encoder::X264 => "x264",
            H264Encoder::Mpeg4Fallback => "兼容编码",
        }
    }
}

/// `-c:v …` 一段:VT 带 `-allow_sw 1 -b:v <bitrate>`;x264 走 crf(不带 `-allow_sw`,也不带
/// `-b:v`,crf 与码率互斥);mpeg4 走 `-q:v 2`。
pub fn h264_encoder_args(encoder: H264Encoder, bitrate: &str) -> Vec<OsString> {
    match encoder {
        H264Encoder::VideoToolbox => vec![
            OsString::from("-c:v"),
            OsString::from("h264_videotoolbox"),
            OsString::from("-allow_sw"),
            OsString::from("1"),
            OsString::from("-b:v"),
            OsString::from(bitrate),
        ],
        H264Encoder::X264 => vec![
            OsString::from("-c:v"),
            OsString::from("libx264"),
            OsString::from("-preset"),
            OsString::from("veryfast"),
            OsString::from("-crf"),
            OsString::from("18"),
        ],
        H264Encoder::Mpeg4Fallback => vec![
            OsString::from("-c:v"),
            OsString::from("mpeg4"),
            OsString::from("-q:v"),
            OsString::from("2"),
        ],
    }
}

/// 解析 `ffmpeg -hide_banner -encoders` 的输出:每行 ` V....D name  描述`,名字在第二列。
pub fn parse_encoder_caps(text: &str) -> EncoderCaps {
    let mut caps = EncoderCaps::default();
    for line in text.lines() {
        let mut columns = line.split_whitespace();
        let (Some(flags), Some(name)) = (columns.next(), columns.next()) else {
            continue;
        };
        // 只认编码器行:flags 是 6 个字符、首字符是 V/A/S(视频/音频/字幕)。
        if flags.len() != 6 || !flags.starts_with(['V', 'A', 'S']) {
            continue;
        }
        match name {
            "h264_videotoolbox" => caps.h264_videotoolbox = true,
            "hevc_videotoolbox" => caps.hevc_videotoolbox = true,
            "libx264" => caps.libx264 = true,
            "mpeg4" => caps.mpeg4 = true,
            _ => {}
        }
    }
    caps
}

#[derive(Debug, Clone)]
struct CachedTool {
    mtime: Option<SystemTime>,
    caps: EncoderCaps,
    version: Option<String>,
}

static TOOL_CACHE: OnceLock<Mutex<HashMap<OsString, CachedTool>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<OsString, CachedTool>> {
    TOOL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mtime_of(executable: &OsStr) -> Option<SystemTime> {
    std::fs::metadata(executable).ok()?.modified().ok()
}

fn probe(executable: &OsStr) -> CachedTool {
    // 探测在临时目录里跑:万一配置的「ffmpeg」是个把最后一个参数当输出路径的脚本,
    // 别让它把 `-encoders` / `-version` 文件写进当前目录。
    let scratch = std::env::temp_dir();
    let caps = Command::new(executable)
        .args(["-hide_banner", "-encoders"])
        .current_dir(&scratch)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| parse_encoder_caps(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default();
    let version = Command::new(executable)
        .arg("-version")
        .current_dir(&scratch)
        .stdin(Stdio::null())
        .output()
        .ok()
        .and_then(|output| {
            let text = if output.stdout.is_empty() { output.stderr } else { output.stdout };
            String::from_utf8_lossy(&text)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_owned)
        });
    CachedTool {
        mtime: mtime_of(executable),
        caps,
        version,
    }
}

fn cached(executable: &OsStr) -> CachedTool {
    let mtime = mtime_of(executable);
    let mut map = cache().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(entry) = map.get(executable) {
        if entry.mtime == mtime {
            return entry.clone();
        }
    }
    let entry = probe(executable);
    map.insert(executable.to_owned(), entry.clone());
    entry
}

/// 这份 ffmpeg 的编码器能力(按路径 + mtime 缓存;探测失败 = 全无)。
pub fn encoder_caps(ffmpeg: &OsStr) -> EncoderCaps {
    cached(ffmpeg).caps
}

/// 这份 ffmpeg 的版本首行(`ffmpeg version 7.1.5 Copyright …`),按路径 + mtime 缓存。
pub fn version_line(ffmpeg: &OsStr) -> Option<String> {
    cached(ffmpeg).version
}

/// 出错信息里的工具身份:`ffmpeg 7.1.5 (…/MacOS/ffmpeg)`。路径只留父目录名 + 文件名
/// (与前端 `stripPaths` 同款,不泄露全路径);版本探测失败时只给路径。
pub fn describe_tool(executable: &OsStr) -> String {
    describe_tool_with(executable, version_line(executable).as_deref())
}

pub(crate) fn describe_tool_with(executable: &OsStr, version_line: Option<&str>) -> String {
    let path = Path::new(executable);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| executable.to_string_lossy().into_owned());
    let short_path = match path.parent().and_then(Path::file_name) {
        Some(parent) => format!("…/{}/{name}", parent.to_string_lossy()),
        None => name.clone(),
    };
    let version = version_line.and_then(short_version);
    match version {
        Some(version) => format!("{name} {version} ({short_path})"),
        None => format!("{name} ({short_path})"),
    }
}

/// `ffmpeg version 7.1.5 Copyright (c) …` → `7.1.5`;`ffmpeg version n7.1-3-gabc` → `n7.1-3-gabc`。
fn short_version(line: &str) -> Option<String> {
    let mut words = line.split_whitespace();
    let first = words.next()?;
    let second = words.next()?;
    if second == "version" {
        words.next().map(str::to_owned)
    } else if first.starts_with("ffmpeg") || first.starts_with("ffprobe") {
        Some(second.to_owned())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOMEBREW_STYLE: &str = "Encoders:\n V..... = Video\n ------\n V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)\n V....D hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)\n V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)\n V.S... mpeg4                MPEG-4 part 2\n A....D aac                  AAC (Advanced Audio Coding)\n";
    const NO_VT_STYLE: &str = "Encoders:\n ------\n V..... libx264              libx264 H.264 (codec h264)\n V.S... mpeg4                MPEG-4 part 2\n";
    const BARE_STYLE: &str = "Encoders:\n ------\n V.S... mpeg4                MPEG-4 part 2\n A....D aac                  AAC\n";

    fn joined(args: &[OsString]) -> String {
        args.iter().map(|value| value.to_string_lossy()).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn parses_encoder_list_into_caps() {
        let caps = parse_encoder_caps(HOMEBREW_STYLE);
        assert_eq!(
            caps,
            EncoderCaps { h264_videotoolbox: true, hevc_videotoolbox: true, libx264: true, mpeg4: true }
        );
        let caps = parse_encoder_caps(NO_VT_STYLE);
        assert!(!caps.h264_videotoolbox && caps.libx264 && caps.mpeg4);
        assert_eq!(parse_encoder_caps(""), EncoderCaps::default());
        // 描述里出现 libx264 字样不算数(只看名字列)。
        assert!(!parse_encoder_caps(" V..... h264_omx  something libx264-like\n").libx264);
    }

    #[test]
    fn h264_encoder_prefers_videotoolbox_then_x264_then_mpeg4() {
        assert_eq!(parse_encoder_caps(HOMEBREW_STYLE).h264_encoder(), H264Encoder::VideoToolbox);
        assert_eq!(parse_encoder_caps(NO_VT_STYLE).h264_encoder(), H264Encoder::X264);
        assert_eq!(parse_encoder_caps(BARE_STYLE).h264_encoder(), H264Encoder::Mpeg4Fallback);
    }

    #[test]
    fn encoder_args_shape_for_all_three_caps() {
        let vt = joined(&h264_encoder_args(H264Encoder::VideoToolbox, "16000k"));
        assert_eq!(vt, "-c:v h264_videotoolbox -allow_sw 1 -b:v 16000k");
        let x264 = joined(&h264_encoder_args(H264Encoder::X264, "16000k"));
        assert_eq!(x264, "-c:v libx264 -preset veryfast -crf 18");
        assert!(!x264.contains("allow_sw"));
        let mpeg4 = joined(&h264_encoder_args(H264Encoder::Mpeg4Fallback, "16000k"));
        assert_eq!(mpeg4, "-c:v mpeg4 -q:v 2");
        assert!(!mpeg4.contains("allow_sw"));
    }

    #[test]
    fn only_the_mpeg4_fallback_carries_a_warning_note() {
        assert_eq!(H264Encoder::VideoToolbox.fallback_note(), None);
        assert_eq!(H264Encoder::X264.fallback_note(), None);
        assert_eq!(
            H264Encoder::Mpeg4Fallback.fallback_note().as_deref(),
            Some("当前 ffmpeg 不支持硬件 H.264,已用兼容编码")
        );
    }

    #[test]
    fn describe_tool_keeps_only_parent_dir_and_file_name() {
        let described = describe_tool_with(
            OsStr::new("/Applications/旅剪工作台.app/Contents/MacOS/ffmpeg"),
            Some("ffmpeg version 7.1.5 Copyright (c) 2000-2026 the FFmpeg developers"),
        );
        assert_eq!(described, "ffmpeg 7.1.5 (…/MacOS/ffmpeg)");
        assert!(!described.contains("Applications"));
        assert_eq!(
            describe_tool_with(OsStr::new("/opt/homebrew/bin/ffmpeg"), None),
            "ffmpeg (…/bin/ffmpeg)"
        );
        assert_eq!(describe_tool_with(OsStr::new("ffmpeg"), Some("ffmpeg version n7.1-3-gabc")), "ffmpeg n7.1-3-gabc (ffmpeg)");
    }

    #[cfg(unix)]
    #[test]
    fn caps_are_probed_from_a_real_executable_and_cached_by_mtime() {
        use std::os::unix::fs::PermissionsExt;
        let directory = crate::core::test_support::TestDirectory::new();
        let fake = directory.path().join("fake-ffmpeg");
        let write_fake = |body: &str| {
            std::fs::write(&fake, body).unwrap();
            let mut permissions = std::fs::metadata(&fake).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&fake, permissions).unwrap();
        };
        write_fake("#!/bin/sh\ncase \" $* \" in\n  *\" -encoders \"*) printf ' V..... libx264  x\\n V.S... mpeg4  y\\n' ;;\n  *\" -version \"*) echo 'ffmpeg version 6.0 Copyright' ;;\nesac\n");
        let caps = encoder_caps(fake.as_os_str());
        assert_eq!(caps.h264_encoder(), H264Encoder::X264);
        let parent = directory.path().file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(describe_tool(fake.as_os_str()), format!("fake-ffmpeg 6.0 (…/{parent}/fake-ffmpeg)"));

        // 同一路径、同一 mtime:不重新探测(即便脚本内容变了)。
        let mtime = std::fs::metadata(&fake).unwrap().modified().unwrap();
        write_fake("#!/bin/sh\ncase \" $* \" in\n  *\" -encoders \"*) printf ' V....D h264_videotoolbox  x\\n' ;;\nesac\n");
        filetime_set(&fake, mtime);
        assert_eq!(encoder_caps(fake.as_os_str()).h264_encoder(), H264Encoder::X264);

        // mtime 变了:重探。
        filetime_set(&fake, mtime + std::time::Duration::from_secs(5));
        assert_eq!(encoder_caps(fake.as_os_str()).h264_encoder(), H264Encoder::VideoToolbox);
        // 探测不到(不是 ffmpeg 的脚本)= 全无 → 兜底。
        assert_eq!(encoder_caps(OsStr::new("/nonexistent/ffmpeg")).h264_encoder(), H264Encoder::Mpeg4Fallback);
    }

    #[cfg(unix)]
    fn filetime_set(path: &Path, time: SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }
}
