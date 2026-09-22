//! R22 on-demand scrub previews. No player calls; ffmpeg runs on a blocking worker.
use super::error::{CoreError, Result};
use rusqlite::Connection;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

static EXTRACTION: Mutex<()> = Mutex::new(());
const LIMIT: usize = 200;

fn frame_key(seconds: f64, duration: f64) -> Result<u64> {
    if !seconds.is_finite()
        || !duration.is_finite()
        || duration <= 0.0
        || seconds < 0.0
        || seconds > duration
    {
        return Err(CoreError::Artifact("预览时间不在素材范围内".into()));
    }
    Ok((seconds * 1000.0).round() as u64)
}

pub(crate) fn is_frame_name(name: &str) -> bool {
    let Some(body) = name
        .strip_prefix("scrub-")
        .and_then(|s| s.strip_suffix(".jpg"))
    else {
        return false;
    };
    let Some((hash, tick)) = body.split_once('-') else {
        return false;
    };
    (6..=64).contains(&hash.len())
        && hash.bytes().all(|b| b.is_ascii_hexdigit())
        && !tick.is_empty()
        && tick.len() <= 20
        && tick.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Default)]
struct FrameLru;
impl FrameLru {
    /// Persist recency in mtime, so restart also respects the 200 frame cap.
    fn touch(&mut self, root: &Path, path: &Path) -> Result<()> {
        let file = std::fs::File::options().write(true).open(path)?;
        file.set_times(std::fs::FileTimes::new().set_modified(SystemTime::now()))?;
        let mut files = Vec::new();
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            if !is_frame_name(&entry.file_name().to_string_lossy()) || !entry.file_type()?.is_file()
            {
                continue;
            }
            files.push((entry.metadata()?.modified()?, entry.path()));
        }
        files.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let remove = files.len().saturating_sub(LIMIT);
        for (_, old) in files.into_iter().filter(|(_, p)| p != path).take(remove) {
            std::fs::remove_file(old)?;
        }
        Ok(())
    }
}

fn frame_filter(rotation: Option<i64>) -> String {
    let rotation = match rotation {
        Some(90) => "transpose=1,",
        Some(180) => "transpose=1,transpose=1,",
        Some(270) => "transpose=2,",
        _ => "",
    };
    format!("{rotation}scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2")
}

fn extract(
    ffmpeg: &OsStr,
    source: &Path,
    seconds: f64,
    rotation: Option<i64>,
    output: &Path,
) -> Result<()> {
    super::artifacts::run_ffmpeg_file_with_fallback(
        ffmpeg,
        |hardware| {
            let mut args: Vec<OsString> = [
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-threads",
                "1",
            ]
            .into_iter()
            .map(Into::into)
            .collect();
            if hardware {
                args.extend(["-hwaccel".into(), "videotoolbox".into()]);
            }
            args.extend([
                "-ss".into(),
                format!("{seconds:.6}").into(),
                "-i".into(),
                source.as_os_str().to_owned(),
                "-map".into(),
                "0:v:0".into(),
                "-frames:v".into(),
                "1".into(),
                "-an".into(),
                "-vf".into(),
                frame_filter(rotation).into(),
                "-threads".into(),
                "1".into(),
                "-q:v".into(),
                "5".into(),
                "-f".into(),
                "image2".into(),
                "-y".into(),
                output.as_os_str().to_owned(),
            ]);
            args
        },
        Duration::from_secs(10),
        output,
    )
}

pub fn frame_at(
    connection: &Connection,
    root: &Path,
    clip_id: i64,
    seconds: f64,
) -> Result<PathBuf> {
    let _guard = EXTRACTION
        .lock()
        .map_err(|_| CoreError::Artifact("预览缓存锁不可用".into()))?;
    let source = super::media_source::verified_clip_path(connection, clip_id)
        .map_err(|e| CoreError::Artifact(e.to_string()))?;
    let (ticks, num, den, rotation, hash): (i64, i64, i64, Option<i64>, String) = connection.query_row(
        "SELECT duration_ticks, tb_num, tb_den, manual_rotation, quick_hash FROM clips WHERE id = ?1 AND kind = 'video'",
        [clip_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?;
    let duration = ticks as f64 * num as f64 / den as f64;
    let key = frame_key(seconds, duration)?;
    let fingerprint = blake3::hash(format!("{hash}:{rotation:?}").as_bytes()).to_hex();
    let directory = root.join(clip_id.to_string());
    std::fs::create_dir_all(&directory)?;
    let output = directory.join(format!("scrub-{}-{key}.jpg", &fingerprint[..16]));
    if !output.is_file() {
        let ffmpeg = super::settings::configured_executable(
            connection,
            super::settings::FFMPEG_PATH_KEY,
            "FFMPEG_PATH",
            "ffmpeg",
        )?;
        let temporary = output.with_extension("tmp.jpg");
        // End-of-file is not itself a decoded frame; use the last source tick.
        let at = (key as f64 / 1000.0).min((duration - num as f64 / den as f64).max(0.0));
        if let Err(error) = extract(&ffmpeg, &source, at, rotation, &temporary) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        std::fs::rename(&temporary, &output)?;
    }
    FrameLru.touch(&directory, &output)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_seconds_and_names_are_strict() {
        assert!(frame_key(f64::NAN, 60.0).is_err());
        assert!(frame_key(-1.0, 60.0).is_err());
        assert!(frame_key(61.0, 60.0).is_err());
        assert_eq!(frame_key(1.2345, 60.0).unwrap(), 1235);
        assert!(is_frame_name("scrub-abcdef-1235.jpg"));
        let url = super::super::media_server::signed_cache_url(
            1421,
            "test-token",
            9,
            "scrub-abcdef-1235.jpg",
        )
        .unwrap();
        assert!(url.contains("/cache/9/scrub-abcdef-1235.jpg?expires="));
        assert!(super::super::media_server::signed_cache_url(
            1421,
            "test-token",
            9,
            "../scrub-abcdef-1235.jpg"
        )
        .is_err());
        assert!(!is_frame_name("../scrub-abcdef-1235.jpg"));
        assert!(!is_frame_name("scrub-a-1.jpg"));
    }
    #[test]
    fn lru_keeps_two_hundred_and_touch_moves_entry_to_end() {
        let root = std::env::temp_dir().join(format!("r22-lru-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut lru = FrameLru;
        for i in 0..200 {
            let path = root.join(format!("scrub-abcdef-{i}.jpg"));
            std::fs::write(&path, b"x").unwrap();
            lru.touch(&root, &path).unwrap();
        }
        lru.touch(&root, &root.join("scrub-abcdef-0.jpg")).unwrap();
        let newest = root.join("scrub-abcdef-200.jpg");
        std::fs::write(&newest, b"x").unwrap();
        lru.touch(&root, &newest).unwrap();
        assert!(root.join("scrub-abcdef-0.jpg").exists());
        assert!(!root.join("scrub-abcdef-1.jpg").exists());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 200);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn frame_filter_preserves_rotation_and_letterboxes_to_160_by_90() {
        assert_eq!(frame_filter(Some(90)), "transpose=1,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2");
        assert!(!frame_filter(None).contains("transpose"));
    }
}

#[cfg(test)]
mod extraction_tests {
    use super::*;
    #[test]
    fn extracts_real_small_frame_caches_and_invalidates_rotation() {
        use crate::core::{db, import::quick_fingerprint, test_support::TestDirectory};
        let dir = TestDirectory::new();
        let source = dir.path().join("source.mp4");
        let connection = db::open_project(&dir.path().join("project.db")).unwrap();
        let ffmpeg = super::super::settings::configured_executable(
            &connection,
            super::super::settings::FFMPEG_PATH_KEY,
            "FFMPEG_PATH",
            "ffmpeg",
        )
        .unwrap();
        let generated = std::process::Command::new(&ffmpeg)
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x180:r=25:d=2",
                "-c:v",
                "mpeg4",
                "-y",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(
            generated.success(),
            "ffmpeg fixture generation must succeed"
        );
        let (hash, bytes) = quick_fingerprint(&source).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('r22-local')", [])
            .unwrap();
        connection.execute("INSERT INTO clips(volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den, duration_ticks, width, height)
            VALUES ('r22-local', ?1, ?2, ?3, 1, 1000, 2000, 320, 180)", rusqlite::params![source.to_string_lossy(), bytes as i64, hash]).unwrap();
        let id = connection.last_insert_rowid();
        let root = dir.path().join("artifacts");
        let first = frame_at(&connection, &root, id, 0.5).unwrap();
        assert_eq!(image::image_dimensions(&first).unwrap(), (160, 90));
        // An unusable executable on the second request proves an actual cache hit.
        connection
            .execute(
                "INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, '2026-09-21')",
                [
                    super::super::settings::FFMPEG_PATH_KEY,
                    "\"/nonexistent/r22-ffmpeg\"",
                ],
            )
            .unwrap();
        assert_eq!(frame_at(&connection, &root, id, 0.5).unwrap(), first);
        connection
            .execute("UPDATE clips SET manual_rotation = 90 WHERE id = ?1", [id])
            .unwrap();
        assert!(
            frame_at(&connection, &root, id, 0.5).is_err(),
            "rotation changes the cache key and requires extraction"
        );
        assert_eq!(
            std::fs::read_dir(root.join(id.to_string()))
                .unwrap()
                .count(),
            1,
            "failed extraction leaves no temporary frame"
        );
    }
}
