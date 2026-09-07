//! Persistence for player-only display preferences: the preview LUT
//! (`clips.display_lut_path`) and the selected monitor/transcribe audio
//! tracks (`clips.selected_monitor_track` / `selected_transcribe_track`).
//!
//! These are strictly preview concerns — nothing here ever touches proxy
//! generation (`core::artifacts::proxy_args`) or export/deliver argument
//! builders, and both of those are pinned with negative assertions that
//! they never emit `lut3d`.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use super::error::{CoreError, Result};
use super::episode;

const LUT_EXTENSION: &str = "cube";
const CLIP_SCOPE: &str = "clip";
const EPISODE_SCOPE: &str = "episode";

/// A `.cube` LUT must exist on disk and carry the `.cube` extension
/// (case-insensitive) — anything else is rejected before it ever reaches
/// the player worker or the database.
pub fn validate_lut_path(path: &Path) -> Result<()> {
    let has_cube_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(LUT_EXTENSION));
    if !has_cube_extension || !path.is_file() {
        return Err(CoreError::Player("LUT 必须是 .cube 文件".to_owned()));
    }
    Ok(())
}

/// Sets `display_lut_path` for one clip (`scope == "clip"`, `target_id` is a
/// clip id) or every clip of one episode (`scope == "episode"`, `target_id`
/// is an episode id). Guarded the same way any other write is: the target
/// must belong to the currently active episode.
pub fn set_display_lut(connection: &Connection, scope: &str, target_id: i64, path: &Path) -> Result<()> {
    validate_lut_path(path)?;
    let path_text = path.to_string_lossy().into_owned();
    write_scoped_lut(connection, scope, target_id, Some(&path_text))
}

/// Symmetric clear — same scoping and write guard as `set_display_lut`.
pub fn clear_display_lut(connection: &Connection, scope: &str, target_id: i64) -> Result<()> {
    write_scoped_lut(connection, scope, target_id, None)
}

fn write_scoped_lut(connection: &Connection, scope: &str, target_id: i64, value: Option<&str>) -> Result<()> {
    match scope {
        CLIP_SCOPE => {
            episode::ensure_clip_writable(connection, target_id)?;
            connection.execute(
                "UPDATE clips SET display_lut_path = ?2 WHERE id = ?1",
                params![target_id, value],
            )?;
        }
        EPISODE_SCOPE => {
            ensure_episode_writable(connection, target_id)?;
            connection.execute(
                "UPDATE clips SET display_lut_path = ?2 WHERE episode_id = ?1",
                params![target_id, value],
            )?;
        }
        other => return Err(CoreError::Player(format!("无效的 LUT 作用域：{other}"))),
    }
    Ok(())
}

/// Mirrors `episode::ensure_clip_writable`'s guard but keyed by episode id
/// directly, for the `scope == "episode"` bulk write path.
fn ensure_episode_writable(connection: &Connection, episode_id: i64) -> Result<()> {
    let active: Option<i64> = connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .optional()?;
    match active {
        None => Err(CoreError::Player("没有处于进行中的集；数据库状态异常".to_owned())),
        Some(active_id) if active_id != episode_id => Err(CoreError::Player(
            "该集已封存,只读不可修改;请回到当前集操作".to_owned(),
        )),
        Some(_) => Ok(()),
    }
}

/// `selected_monitor_track` — the audio track the player's monitor output
/// uses. Validated against `clip_audio_tracks` so a stale/typo'd index
/// fails loudly instead of silently no-op'ing at playback time.
pub fn set_playback_track(connection: &Connection, clip_id: i64, stream_index: i64) -> Result<()> {
    set_track_column(connection, clip_id, stream_index, "selected_monitor_track")
}

/// `selected_transcribe_track` — the audio track fed to transcription.
pub fn set_transcribe_track(connection: &Connection, clip_id: i64, stream_index: i64) -> Result<()> {
    set_track_column(connection, clip_id, stream_index, "selected_transcribe_track")
}

fn set_track_column(connection: &Connection, clip_id: i64, stream_index: i64, column: &str) -> Result<()> {
    episode::ensure_clip_writable(connection, clip_id)?;
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM clip_audio_tracks WHERE clip_id = ?1 AND stream_index = ?2",
            params![clip_id, stream_index],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(CoreError::Player(format!(
            "音轨 {stream_index} 不存在于素材 {clip_id}"
        )));
    }
    let sql = match column {
        "selected_monitor_track" => "UPDATE clips SET selected_monitor_track = ?2 WHERE id = ?1",
        "selected_transcribe_track" => "UPDATE clips SET selected_transcribe_track = ?2 WHERE id = ?1",
        other => return Err(CoreError::Player(format!("无效的音轨列：{other}"))),
    };
    connection.execute(sql, params![clip_id, stream_index])?;
    Ok(())
}

/// Lists every `.cube` file directly under `dir` (creating it if missing),
/// sorted for stable UI ordering. Returns absolute paths.
pub fn list_display_luts(dir: &Path) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(dir)?;
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let is_cube = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case(LUT_EXTENSION));
        if is_cube && path.is_file() {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{audio_tracks::AudioStreamProbe, db, test_support::TestDirectory};

    fn test_connection() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        (directory, connection)
    }

    fn insert_clip(connection: &Connection, name: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO volumes(uuid) SELECT 'vol-player-prefs'
                 WHERE NOT EXISTS (SELECT 1 FROM volumes WHERE uuid='vol-player-prefs')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den,
                                   duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                                   imported_at, episode_id)
                 VALUES ('vol-player-prefs', ?1, 1, ?1, 1, 1000, 1000, 30, 1, 0, 'h264', 1920, 1080,
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         (SELECT id FROM episodes WHERE status='active'))",
                [name],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn insert_audio_track(connection: &Connection, clip_id: i64, stream_index: i64) {
        crate::core::audio_tracks::replace_for_clip(
            connection,
            clip_id,
            &[AudioStreamProbe {
                stream_index,
                channels: Some(2),
                channel_layout: Some("stereo".to_owned()),
                sample_rate: Some(48_000),
                role_guess: "onboard_mic".to_owned(),
            }],
        )
        .unwrap();
    }

    #[test]
    fn validate_lut_path_rejects_missing_file_and_wrong_extension() {
        let directory = TestDirectory::new();
        let missing = directory.path().join("missing.cube");
        assert!(validate_lut_path(&missing).is_err());

        let wrong_extension = directory.path().join("look_x.png");
        std::fs::write(&wrong_extension, b"not a lut").unwrap();
        assert!(validate_lut_path(&wrong_extension).is_err());

        let real_cube = directory.path().join("Look_X.CUBE");
        std::fs::write(&real_cube, b"LUT_3D_SIZE 2").unwrap();
        assert!(validate_lut_path(&real_cube).is_ok(), "扩展名大小写不敏感");
    }

    #[test]
    fn set_and_clear_display_lut_round_trips_for_clip_scope() {
        let (directory, connection) = test_connection();
        let clip_id = insert_clip(&connection, "a.mp4");
        let lut = directory.path().join("look.cube");
        std::fs::write(&lut, b"LUT_3D_SIZE 2").unwrap();

        set_display_lut(&connection, "clip", clip_id, &lut).unwrap();
        let stored: Option<String> = connection
            .query_row("SELECT display_lut_path FROM clips WHERE id = ?1", [clip_id], |row| row.get(0))
            .unwrap();
        assert_eq!(stored.as_deref(), Some(lut.to_string_lossy().as_ref()));

        clear_display_lut(&connection, "clip", clip_id).unwrap();
        let cleared: Option<String> = connection
            .query_row("SELECT display_lut_path FROM clips WHERE id = ?1", [clip_id], |row| row.get(0))
            .unwrap();
        assert_eq!(cleared, None);
    }

    #[test]
    fn episode_scope_writes_every_clip_of_that_episode() {
        let (directory, connection) = test_connection();
        let active_episode: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0))
            .unwrap();
        let clip_a = insert_clip(&connection, "a.mp4");
        let clip_b = insert_clip(&connection, "b.mp4");
        let lut = directory.path().join("look.cube");
        std::fs::write(&lut, b"LUT_3D_SIZE 2").unwrap();

        set_display_lut(&connection, "episode", active_episode, &lut).unwrap();
        for clip_id in [clip_a, clip_b] {
            let stored: Option<String> = connection
                .query_row("SELECT display_lut_path FROM clips WHERE id = ?1", [clip_id], |row| row.get(0))
                .unwrap();
            assert_eq!(stored.as_deref(), Some(lut.to_string_lossy().as_ref()));
        }
    }

    #[test]
    fn invalid_scope_is_rejected() {
        let (directory, connection) = test_connection();
        let clip_id = insert_clip(&connection, "a.mp4");
        let lut = directory.path().join("look.cube");
        std::fs::write(&lut, b"LUT_3D_SIZE 2").unwrap();
        let error = set_display_lut(&connection, "project", clip_id, &lut).unwrap_err();
        assert!(error.to_string().contains("无效的 LUT 作用域"));
    }

    #[test]
    fn track_selection_validates_against_clip_audio_tracks() {
        let (_dir, connection) = test_connection();
        let clip_id = insert_clip(&connection, "a.mp4");
        insert_audio_track(&connection, clip_id, 0);

        set_playback_track(&connection, clip_id, 0).unwrap();
        let monitor: Option<i64> = connection
            .query_row("SELECT selected_monitor_track FROM clips WHERE id = ?1", [clip_id], |row| row.get(0))
            .unwrap();
        assert_eq!(monitor, Some(0));

        let error = set_transcribe_track(&connection, clip_id, 7).unwrap_err();
        assert!(error.to_string().contains("音轨 7 不存在"));

        set_transcribe_track(&connection, clip_id, 0).unwrap();
        let transcribe: Option<i64> = connection
            .query_row("SELECT selected_transcribe_track FROM clips WHERE id = ?1", [clip_id], |row| row.get(0))
            .unwrap();
        assert_eq!(transcribe, Some(0));
    }

    #[test]
    fn writes_are_refused_against_archived_episode_clips() {
        let (directory, mut connection) = test_connection();
        let clip_id = insert_clip(&connection, "a.mp4");
        insert_audio_track(&connection, clip_id, 0);
        episode::archive_current(&mut connection, None).unwrap();

        let lut = directory.path().join("look.cube");
        std::fs::write(&lut, b"LUT_3D_SIZE 2").unwrap();
        assert!(set_display_lut(&connection, "clip", clip_id, &lut).is_err());
        assert!(set_playback_track(&connection, clip_id, 0).is_err());
    }

    #[test]
    fn list_display_luts_creates_dir_and_lists_only_cube_files() {
        let directory = TestDirectory::new();
        let luts_dir = directory.path().join("luts");
        assert!(!luts_dir.exists());

        let empty = list_display_luts(&luts_dir).unwrap();
        assert!(empty.is_empty());
        assert!(luts_dir.is_dir());

        std::fs::write(luts_dir.join("a.cube"), b"x").unwrap();
        std::fs::write(luts_dir.join("b.CUBE"), b"x").unwrap();
        std::fs::write(luts_dir.join("notes.txt"), b"x").unwrap();

        let found = list_display_luts(&luts_dir).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|path| path.is_absolute()));
    }
}
