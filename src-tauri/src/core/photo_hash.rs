//! R21 PH-06 分组基础设施：dHash（image_hasher，Gradient 8×8=64 bit）、连拍/
//! 事件硬切规则、文件尾号提取，以及进程内取消标志检查。
//!
//! cover() 复用 `photo_decode::decode_cover` 的 ImageIO 管线（方向已烘、SDR sRGB、
//! 长边 ≤512 px），只是把编码后的 JPEG 字节再解回 `DynamicImage` 供 dHash / 单帧
//! 曝光分析使用——不重新实现一遍解码器。
use std::path::Path;
use std::sync::atomic::Ordering;

use super::error::{CoreError, Result};

/// dHash 汉明距离阈值：≤18 判定视觉相似（image_hasher 3.0.0 / HashAlg::Gradient，
/// 8×8=64 bits 的默认配置）。
pub const DHASH_MAX_DISTANCE: u32 = 18;

/// 连拍：同机身且时间差 ≤1,200 ms，或文件名尾号差 ≤3。
const BURST_TIME_WINDOW_MS: i64 = 1_200;
const BURST_FILE_NUMBER_WINDOW: i64 = 3;

/// 事件硬切：相邻已知拍摄时间间隔 >30 分钟即划开事件，任意候选对超过此间隔也不
/// 直接连接。两个时间戳中任一缺失时不按时间判断硬切（由调用方按 episode /
/// 有无时间戳的显式过渡处理，避免无日期照片被这里误判成处处硬切）。
const EVENT_HARD_BREAK_MS: i64 = 30 * 60 * 1000;

/// 检查当前任务是否已被取消（`jobs::request_cancel` 设置的进程内标志）。
/// 分组/单帧分析的每个候选对、每次解码前后都应调用一次，取消后尽快退出而不是
/// 跑完整个 O(n²) 候选集合或全量解码。
pub fn check_cancelled() -> Result<()> {
    if super::jobs::current_cancellation_flag()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
    {
        return Err(CoreError::BackgroundTask("用户已取消".to_owned()));
    }
    Ok(())
}

/// 方向校正、SDR sRGB、长边 ≤512 px 的 cover——复用现有 ImageIO 解码器
/// （`photo_decode::decode_cover`），只是把它编码好的字节再解码回栅格供
/// dHash / 单帧曝光与清晰度分析使用。
pub fn cover(path: &Path) -> Result<image::DynamicImage> {
    let decoded = super::photo_decode::decode_cover(path, 512)?;
    image::load_from_memory(&decoded.bytes)
        .map_err(|error| CoreError::Analysis(format!("照片 cover 解码失败：{error}")))
}

/// image_hasher 的 Gradient dHash（8×8 = 64 bits，默认配置）。
pub fn dhash(image: &image::DynamicImage) -> image_hasher::ImageHash {
    image_hasher::HasherConfig::new().to_hasher().hash_image(image)
}

/// 相邻/候选两张照片之间是否应当被 30 分钟硬切隔开。只要两个时间戳都存在才按
/// 时间判断；任一缺失时交给调用方的显式过渡逻辑处理。
pub fn hard_break(a: Option<i64>, b: Option<i64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() > EVENT_HARD_BREAK_MS,
        _ => false,
    }
}

/// 连拍规则：非空同机身，且（时间差 ≤1,200 ms 或文件名尾号差 ≤3）。
pub fn is_burst(
    camera_a: Option<&str>,
    camera_b: Option<&str>,
    taken_a: Option<i64>,
    taken_b: Option<i64>,
    number_a: Option<i64>,
    number_b: Option<i64>,
) -> bool {
    let same_camera = match (camera_a, camera_b) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => a == b,
        _ => false,
    };
    if !same_camera {
        return false;
    }
    let time_close = matches!(
        (taken_a, taken_b),
        (Some(a), Some(b)) if (a - b).abs() <= BURST_TIME_WINDOW_MS
    );
    let number_close = matches!(
        (number_a, number_b),
        (Some(a), Some(b)) if (a - b).abs() <= BURST_FILE_NUMBER_WINDOW
    );
    time_close || number_close
}

/// 文件名（不含扩展名）末尾的连续数字串，例如 `IMG_0042.jpg` -> `Some(42)`、
/// `DSC00042.JPG` -> `Some(42)`、`night.png` -> `None`。按字符（不是字节）扫描，
/// 避免在多字节 Unicode 文件名上越界。
pub fn file_number(path: &Path) -> Option<i64> {
    let stem = path.file_stem()?.to_str()?;
    let chars: Vec<char> = stem.chars().collect();
    let mut start = chars.len();
    while start > 0 && chars[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start == chars.len() {
        return None;
    }
    let digits: String = chars[start..].iter().collect();
    digits.parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_number_reads_trailing_ascii_digits() {
        assert_eq!(file_number(Path::new("IMG_0042.jpg")), Some(42));
        assert_eq!(file_number(Path::new("DSC00042.JPG")), Some(42));
        assert_eq!(file_number(Path::new("quality-05.png")), Some(5));
    }

    #[test]
    fn file_number_is_none_without_trailing_digits() {
        assert_eq!(file_number(Path::new("night.png")), None);
        assert_eq!(file_number(Path::new("cover")), None);
    }

    #[test]
    fn file_number_handles_unicode_filenames_without_panicking() {
        assert_eq!(file_number(Path::new("烟花大会-0007.png")), Some(7));
        assert_eq!(file_number(Path::new("日落海边.png")), None);
    }

    #[test]
    fn hard_break_only_fires_when_both_timestamps_known_and_far_apart() {
        assert!(!hard_break(Some(0), Some(EVENT_HARD_BREAK_MS)));
        assert!(hard_break(Some(0), Some(EVENT_HARD_BREAK_MS + 1)));
        assert!(!hard_break(None, Some(0)));
        assert!(!hard_break(None, None));
    }

    #[test]
    fn is_burst_requires_same_nonempty_camera() {
        assert!(!is_burst(None, None, Some(0), Some(100), None, None));
        assert!(!is_burst(Some(""), Some(""), Some(0), Some(100), None, None));
        assert!(!is_burst(Some("a"), Some("b"), Some(0), Some(100), None, None));
    }

    #[test]
    fn is_burst_true_within_time_window_or_file_number_window() {
        assert!(is_burst(Some("cam"), Some("cam"), Some(0), Some(BURST_TIME_WINDOW_MS), None, None));
        assert!(!is_burst(Some("cam"), Some("cam"), Some(0), Some(BURST_TIME_WINDOW_MS + 1), None, None));
        assert!(is_burst(Some("cam"), Some("cam"), None, None, Some(10), Some(13)));
        assert!(!is_burst(Some("cam"), Some("cam"), None, None, Some(10), Some(14)));
    }

    #[test]
    fn dhash_identical_images_have_zero_distance_and_differing_ones_are_bounded() {
        let a = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(64, 64, |x, y| {
            image::Rgb([((x * 4) % 256) as u8, ((y * 4) % 256) as u8, 128])
        }));
        let b = a.clone();
        assert_eq!(dhash(&a).dist(&dhash(&b)), 0);

        let c = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(64, 64, |x, y| {
            image::Rgb([255 - ((x * 4) % 256) as u8, 255 - ((y * 4) % 256) as u8, 0])
        }));
        assert!(dhash(&a).dist(&dhash(&c)) > DHASH_MAX_DISTANCE);
    }

    #[test]
    fn check_cancelled_ok_without_an_active_flag() {
        // 没有正在运行的任务把取消标志装进 thread-local 时，检查必须放行——
        // 单元测试环境下没有 job runner 线程本地状态。
        assert!(check_cancelled().is_ok());
    }
}
