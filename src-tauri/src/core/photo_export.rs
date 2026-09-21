//! Read-only photo handoff. HEIC / ARW / DNG → JPG 走 photo_decode 的共用 ImageIO 渲染器(方向烘进像素、SDR sRGB),其它格式逐字节 copy;RAW 原片由 deliver_photo::companion_copies 作为归档成员另交一份。
use super::error::{CoreError, Result};
use std::path::Path;

pub(crate) fn output_extension(source: &str) -> String {
    let ext = Path::new(source)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("jpg");
    if matches!(ext.to_ascii_lowercase().as_str(), "heic" | "heif" | "arw" | "dng") {
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
    if matches!(ext.as_str(), "heic" | "heif" | "arw" | "dng") {
        encode_jpeg(source, destination)?;
    } else {
        // The shared archive copier checks the entire output, including metadata/alpha.
        super::archive::copy_verified(source, destination)?;
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
    fn ph10_raw_export_is_full_size_jpeg_plus_original() {
        let d=TestDirectory::new();let source=d.path().join("raw.dng");
        let original=include_bytes!("../../../qa/ai-eval/raw/minimal-rgb.dng");
        std::fs::write(&source,original).unwrap();
        assert_eq!(output_extension("raw.DNG"),"jpg");
        let output=d.path().join("01_raw.jpg");
        export(&source,&output).unwrap();
        crate::core::archive::copy_verified(&source,&d.path().join("01_raw.dng")).unwrap();
        let image=image::open(&output).unwrap();
        assert_eq!((image.width(),image.height()),(48,64));
        assert_eq!(std::fs::read(d.path().join("01_raw.dng")).unwrap(),original);
        assert_eq!(std::fs::read(&source).unwrap(),original);
    }

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

#[cfg(all(test, target_os = "macos"))]
#[test]
#[ignore = "需真样本：设置 TRIPCUT_RAW_SAMPLE 为 Sony A7R III ARW，验证原生 ImageIO 解码与全尺寸交付"]
fn ph10_real_arw_requires_camera_sample() {
    let path=std::path::PathBuf::from(std::env::var("TRIPCUT_RAW_SAMPLE").expect("需真样本"));
    assert_eq!(path.extension().unwrap().to_str().unwrap().to_ascii_lowercase(),"arw");
    let meta=super::photo_probe::probe(&path).unwrap();
    assert!(meta.camera.as_deref().is_some_and(|camera|camera.contains("ILCE-7RM3")));
    let preview=super::photo_decode::decode_preview(&path,2048).unwrap();
    assert!(preview.width>0 && preview.height>0);
    let full=super::photo_decode::render_sdr_srgb(&path,super::photo_decode::RenderOptions {max_size:None,quality:0.92,keep_alpha:false}).unwrap();
    let expected=if meta.orientation>=5 {(meta.height as u32,meta.width as u32)} else {(meta.width as u32,meta.height as u32)};
    assert_eq!((full.width,full.height),expected);
}
