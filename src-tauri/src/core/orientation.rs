//! R10 U-13 / U-02 / U-05:素材方向与分辨率档的唯一判定点。
//!
//! 方向 = `rotation`(已含 tag 兜底的 `manual_rotation`,导入时合成进
//! `clips.rotation`)+ 像素宽高比综合:先按 90°/270° 把宽高对调得到**显示**
//! 尺寸,再比较显示宽高。检查器「方向」字段、Stack 分组键、交付画布的
//! 「跟随素材多数」都从这里取值,三处不再各判各的。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Landscape,
    Portrait,
    Square,
    Unknown,
}

impl Orientation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Landscape => "landscape",
            Self::Portrait => "portrait",
            Self::Square => "square",
            Self::Unknown => "unknown",
        }
    }
}

/// 把编码尺寸按 rotation 转成显示尺寸(宽, 高)。
pub fn display_dimensions(
    width: Option<i64>,
    height: Option<i64>,
    rotation: Option<i64>,
) -> Option<(i64, i64)> {
    let (width, height) = (width?, height?);
    if width <= 0 || height <= 0 {
        return None;
    }
    let angle = rotation.unwrap_or(0).rem_euclid(360);
    if matches!(angle, 90 | 270) {
        Some((height, width))
    } else {
        Some((width, height))
    }
}

pub fn clip_orientation(width: Option<i64>, height: Option<i64>, rotation: Option<i64>) -> Orientation {
    match display_dimensions(width, height, rotation) {
        None => Orientation::Unknown,
        Some((w, h)) if w == h => Orientation::Square,
        Some((w, h)) if h > w => Orientation::Portrait,
        Some(_) => Orientation::Landscape,
    }
}

/// 分辨率档:按显示尺寸的长边分档——480p / 720p / 1080p / 4K;没有尺寸记 `unknown`。
pub fn resolution_tier(width: Option<i64>, height: Option<i64>) -> &'static str {
    let Some((w, h)) = display_dimensions(width, height, None) else {
        return "unknown";
    };
    match w.max(h) {
        long_side if long_side <= 854 => "480p",
        long_side if long_side <= 1280 => "720p",
        long_side if long_side <= 1920 => "1080p",
        _ => "4K",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portrait_pixels_without_rotation_are_portrait() {
        // 走查 U-13:1080×1920、rotation 0 被写成「横屏」——像素本身就是竖的。
        assert_eq!(clip_orientation(Some(1080), Some(1920), Some(0)), Orientation::Portrait);
        assert_eq!(clip_orientation(Some(1080), Some(1920), None), Orientation::Portrait);
    }

    #[test]
    fn rotation_flips_encoded_landscape_into_portrait() {
        assert_eq!(clip_orientation(Some(1920), Some(1080), Some(90)), Orientation::Portrait);
        assert_eq!(clip_orientation(Some(1920), Some(1080), Some(270)), Orientation::Portrait);
        assert_eq!(clip_orientation(Some(1920), Some(1080), Some(-90)), Orientation::Portrait);
        assert_eq!(clip_orientation(Some(1920), Some(1080), Some(180)), Orientation::Landscape);
        // 编码已是竖的再转 90° → 横。
        assert_eq!(clip_orientation(Some(1080), Some(1920), Some(90)), Orientation::Landscape);
    }

    #[test]
    fn square_and_unknown_are_distinct() {
        assert_eq!(clip_orientation(Some(1080), Some(1080), Some(90)), Orientation::Square);
        assert_eq!(clip_orientation(None, Some(1080), None), Orientation::Unknown);
        assert_eq!(clip_orientation(Some(0), Some(1080), None), Orientation::Unknown);
    }

    #[test]
    fn resolution_tiers_follow_the_long_side() {
        assert_eq!(resolution_tier(Some(704), Some(1280)), "720p");
        assert_eq!(resolution_tier(Some(1080), Some(1920)), "1080p");
        assert_eq!(resolution_tier(Some(1920), Some(1080)), "1080p");
        assert_eq!(resolution_tier(Some(3840), Some(2160)), "4K");
        assert_eq!(resolution_tier(Some(854), Some(480)), "480p");
        assert_eq!(resolution_tier(None, None), "unknown");
    }
}
