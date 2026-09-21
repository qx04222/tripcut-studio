//! Read-only photo handoff. HEIC → JPG 走 photo_decode 的共用 ImageIO 渲染器(方向烘进像素、SDR sRGB),其它格式逐字节 copy。
use super::error::{CoreError, Result};
use std::path::Path;

pub(crate) fn output_extension(source: &str) -> String {
    let ext = Path::new(source)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("jpg");
    if matches!(ext.to_ascii_lowercase().as_str(), "heic" | "heif") {
        "jpg".into()
    } else {
        ext.into()
    }
}

pub(crate) fn export(source: &Path, destination: &Path) -> Result<()> {
    let ext = source
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(ext.as_str(), "heic" | "heif") {
        encode_jpeg(source, destination)?;
    } else {
        // Byte-for-byte copy preserves PNG alpha and all JPEG metadata.
        let mut input = std::fs::File::open(source)?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn encode_jpeg(source: &Path, destination: &Path) -> Result<()> {
    // 与缩略/预览同一条 ImageIO 路径(photo_decode::render_sdr_srgb):方向烘进像素、
    // DecodeToSDR、sRGB 真转换、截断图拒绝。区别只在参数:全分辨率(max_size None,
    // 绝不能拿缩略尺寸交付)、JPEG 0.92、不留 alpha。
    let rendered = super::photo_decode::render_sdr_srgb(
        source,
        super::photo_decode::RenderOptions { max_size: None, quality: 0.92, keep_alpha: false },
    )
    .map_err(|e| CoreError::Export(format!("照片转换失败:{} —— {e}", source.display())))?;
    debug_assert_eq!(rendered.extension, "jpg");
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    std::io::Write::write_all(&mut output, &rendered.bytes)?;
    output.sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn encode_jpeg(_source: &Path, _destination: &Path) -> Result<()> {
    Err(CoreError::Export("HEIC 导出需要 macOS ImageIO".into()))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::core::test_support::TestDirectory;

    #[test]
    fn exif_rotation_is_baked_and_source_is_unchanged() {
        let dir = TestDirectory::new();
        let source = dir.path().join("orientation6.tiff");
        let target = dir.path().join("display.jpg");
        let entries: [(u16, u16, u32, u32); 11] = [
            (256, 4, 1, 40),
            (257, 4, 1, 20),
            (258, 3, 3, 146),
            (259, 3, 1, 1),
            (262, 3, 1, 2),
            (273, 4, 1, 152),
            (274, 3, 1, 6),
            (277, 3, 1, 3),
            (278, 4, 1, 20),
            (279, 4, 1, 2400),
            (284, 3, 1, 1),
        ];
        let mut bytes = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
        bytes.extend(11u16.to_le_bytes());
        for (tag, kind, count, value) in entries {
            bytes.extend(tag.to_le_bytes());
            bytes.extend(kind.to_le_bytes());
            bytes.extend(count.to_le_bytes());
            bytes.extend(value.to_le_bytes());
        }
        bytes.extend(0u32.to_le_bytes());
        bytes.extend([8, 0, 8, 0, 8, 0]);
        for _ in 0..800 {
            bytes.extend([220, 30, 10]);
        }
        std::fs::write(&source, &bytes).unwrap();
        encode_jpeg(&source, &target).unwrap();
        let result = std::process::Command::new("/usr/bin/sips")
            .args(["-g", "pixelWidth", "-g", "pixelHeight", "-g", "profile"])
            .arg(target)
            .output()
            .unwrap();
        let properties = String::from_utf8(result.stdout).unwrap();
        assert!(
            properties.contains("pixelWidth: 20") && properties.contains("pixelHeight: 40"),
            "{properties}"
        );
        assert!(properties.contains("sRGB"), "{properties}");
        assert_eq!(std::fs::read(source).unwrap(), bytes);
    }
}
