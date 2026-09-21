//! Photo-specific DB projection and handoff, kept separate from video trim/copy logic.
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

pub(super) fn relative_name(sequence: usize, chapter: Option<usize>, clip: &ExportClip) -> String {
    let path = kit_relative_name(sequence, chapter, &clip.chapter_title, &clip.file_name);
    if clip.media_kind == "photo" {
        Path::new(&path)
            .with_extension(super::super::photo_export::output_extension(
                &clip.file_name,
            ))
            .to_string_lossy()
            .into_owned()
    } else {
        path
    }
}

pub(super) fn split_relative_name(
    video_sequence: usize,
    photo_sequence: usize,
    chapter: Option<usize>,
    clip: &ExportClip,
) -> String {
    if clip.media_kind == "photo" {
        let stem = Path::new(&clip.file_name)
            .file_stem()
            .map(|value| value.to_string_lossy())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "photo".into());
        let extension = super::super::photo_export::output_extension(&clip.file_name);
        format!("照片/{photo_sequence:02}_{stem}.{extension}")
    } else {
        format!(
            "视频/{}",
            kit_relative_name(video_sequence, chapter, &clip.chapter_title, &clip.file_name)
        )
    }
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

pub(super) fn copy_companions(clip: &ExportClip, output: &Path) -> Result<()> {
    let stem = output.file_stem().unwrap_or_default().to_string_lossy();
    let source_stem = Path::new(&clip.file_name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let mut reserved = vec![output.to_path_buf()];
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
        let mut input = File::open(&source)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        std::io::copy(&mut input, &mut file)?;
        file.sync_all()?;
    }
    Ok(())
}
