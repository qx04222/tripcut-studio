//! Photo-specific DB projection and handoff, kept separate from video trim/copy logic.
//! 只服务「导出精选照片」(deliver.rs 的 MODE_PHOTOS);素材包 / 整包 / 快速导出不再带照片。
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Companion {
    pub role: String,
    pub path: String,
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut query = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = query
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|name| name == column))
}

pub(super) fn attach(connection: &Connection, clips: &mut [ExportClip]) -> Result<()> {
    // Merge-safe with schema 0049: never prepare a SELECT referencing a missing column.
    if !has_column(connection, "clips", "kind")? {
        return Ok(());
    }
    let has_hold = has_column(connection, "photo_meta", "hold_ms")?;
    let has_companions = has_column(connection, "clip_companions", "path")?;
    for clip in clips {
        clip.media_kind =
            connection.query_row("SELECT kind FROM clips WHERE id=?1", [clip.clip_id], |r| {
                r.get(0)
            })?;
        if clip.media_kind != "photo" {
            continue;
        }
        clip.photo_hold_ms = if has_hold {
            connection
                .query_row(
                    "SELECT hold_ms FROM photo_meta WHERE clip_id=?1",
                    [clip.clip_id],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .optional()?
                .flatten()
                .filter(|n| *n > 0)
                .unwrap_or(3000)
        } else {
            3000
        };
        if has_companions {
            let mut query = connection.prepare("SELECT role,path FROM clip_companions WHERE clip_id=?1 AND role IN ('raw','xmp','live_mov','jpg') ORDER BY role,path")?;
            clip.companions = query
                .query_map([clip.clip_id], |r| {
                    Ok(Companion {
                        role: r.get(0)?,
                        path: r.get(1)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
        }
    }
    Ok(())
}

pub(super) fn count(clips: &[ExportClip]) -> u64 {
    clips
        .iter()
        .filter(|clip| clip.media_kind == "photo")
        .count() as u64
}

/// 「导出精选照片」的文件名:`NN_<原名>.<ext>`,平铺;HEIC / RAW 转出 JPG,原名扩展名其它照常。
/// 没有章名、没有「视频/ 照片/」子目录——照片线不套视频那一套。
pub(super) fn output_name(sequence: usize, clip: &ExportClip) -> String {
    let stem = Path::new(&clip.file_name)
        .file_stem()
        .map(|value| value.to_string_lossy())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "photo".into());
    let extension = super::super::photo_export::output_extension(&clip.file_name);
    format!("{sequence:02}_{stem}.{extension}")
}

pub(super) fn output_names(clips: &[ExportClip]) -> Vec<String> {
    clips.iter().enumerate().map(|(index, clip)| output_name(index + 1, clip)).collect()
}

fn companion_source(clip: &ExportClip, companion: &Companion) -> PathBuf {
    let path = PathBuf::from(&companion.path);
    if path.is_absolute() {
        path
    } else {
        Path::new(&clip.source_path)
            .parent()
            .unwrap_or(Path::new(""))
            .join(path)
    }
}

pub(super) fn companion_copies(clip: &ExportClip, output: &Path) -> Result<Vec<(PathBuf, PathBuf)>> {
    let mut copies = Vec::new();
    let stem = output.file_stem().unwrap_or_default().to_string_lossy();
    let source_stem = Path::new(&clip.file_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let mut reserved = vec![output.to_path_buf()];
    // PH-10 × PH-11:RAW 交付出两份 —— 转出的 JPG(`output`,归档里记为 derived)+ 逐字节的原片。
    // 原片作为一条普通 copy 成员交给 archive.rs(冻结哈希 → copy_verified → 发布),不在这里直接写文件。
    if super::super::import::is_raw(Path::new(&clip.file_name)) {
        let original = output.with_extension(Path::new(&clip.file_name).extension().unwrap_or_default());
        reserved.push(original.clone());
        copies.push((PathBuf::from(&clip.source_path), original));
    }
    for (index, companion) in clip.companions.iter().enumerate() {
        let source = companion_source(clip, companion);
        let name = source
            .file_name()
            .ok_or_else(|| CoreError::Export("伴随文件名无效".into()))?
            .to_string_lossy();
        // Keep RAW/JPG/XMP stems paired, including IMG.ARW.xmp. A JPG companion
        // of converted HEIC must get a distinct name rather than overwrite the JPEG.
        let suffix = name
            .get(source_stem.len()..)
            .filter(|suffix| suffix.starts_with('.'));
        let mut target = match suffix {
            Some(suffix) if name[..source_stem.len()].eq_ignore_ascii_case(&source_stem) => {
                output.with_file_name(format!("{stem}{suffix}"))
            }
            _ => output.with_file_name(format!("{stem}__{}_{index}_{name}", companion.role)),
        };
        if reserved.iter().any(|path| {
            path.to_string_lossy()
                .eq_ignore_ascii_case(&target.to_string_lossy())
        }) {
            target = output.with_file_name(format!("{stem}__{}_{index}_{name}", companion.role));
        }
        reserved.push(target.clone());
        copies.push((source, target));
    }
    Ok(copies)
}

pub(super) fn copy_companions(clip: &ExportClip, output: &Path) -> Result<()> {
    for (source, target) in companion_copies(clip, output)? {
        super::super::archive::copy_verified(&source, &target)?;
    }
    Ok(())
}
