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

/// R10 U-28:`.cube` 文件大小上限。65³ 的 3D LUT 文本约 8 MB,64 MiB 足够宽裕;
/// 再大多半是选错文件。
const LUT_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// 只读文件头这么多字节找 `LUT_3D_SIZE` / `LUT_1D_SIZE`,不把整个文件读进内存。
const LUT_HEADER_PROBE_BYTES: usize = 64 * 1024;

/// R10 U-28:把用户选的 `.cube` 复制进 `luts/`,返回复制后的完整 LUT 列表。
/// 校验:扩展名 `.cube`(不分大小写)、非空且 ≤ 64 MiB、文件头带 `LUT_3D_SIZE` 或
/// `LUT_1D_SIZE`(Adobe cube 规范的必填关键字)。同名文件已存在且内容不同时拒绝
/// (不静默覆盖;改名再导),内容相同则视为已导入。源文件不动。
pub fn import_display_lut(source: &Path, dir: &Path) -> Result<Vec<PathBuf>> {
    let is_cube = source
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(LUT_EXTENSION));
    if !is_cube {
        return Err(CoreError::Player("只支持 .cube 格式的 LUT 文件".to_owned()));
    }
    if !source.is_file() {
        return Err(CoreError::Player(format!("LUT 文件不存在:{}", source.display())));
    }
    let size = std::fs::metadata(source)?.len();
    if size == 0 {
        return Err(CoreError::Player("LUT 文件是空的".to_owned()));
    }
    if size > LUT_MAX_BYTES {
        return Err(CoreError::Player(format!(
            "LUT 文件过大({} MB,上限 64 MB),多半不是 .cube 查找表",
            size / (1024 * 1024)
        )));
    }
    let header = {
        use std::io::Read;
        let mut file = std::fs::File::open(source)?;
        let mut buffer = vec![0_u8; LUT_HEADER_PROBE_BYTES.min(size as usize)];
        let mut filled = 0;
        while filled < buffer.len() {
            let read = file.read(&mut buffer[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        buffer.truncate(filled);
        String::from_utf8_lossy(&buffer).into_owned()
    };
    if !header.contains("LUT_3D_SIZE") && !header.contains("LUT_1D_SIZE") {
        return Err(CoreError::Player(
            "不是有效的 .cube 文件:文件头没有 LUT_3D_SIZE / LUT_1D_SIZE".to_owned(),
        ));
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| CoreError::Player("LUT 文件名无效".to_owned()))?;
    std::fs::create_dir_all(dir)?;
    let destination = dir.join(file_name);
    if destination.is_file() {
        let same = std::fs::metadata(&destination)?.len() == size
            && std::fs::read(&destination)? == std::fs::read(source)?;
        if !same {
            return Err(CoreError::Player(format!(
                "luts 目录里已有同名但内容不同的 {},请改名后再导入",
                file_name.to_string_lossy()
            )));
        }
    } else {
        std::fs::copy(source, &destination)?;
    }
    list_display_luts(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{audio_tracks::AudioStreamProbe, db, test_support::TestDirectory};

    const CUBE_HEADER: &[u8] = b"TITLE \"test\"\nLUT_3D_SIZE 2\n0 0 0\n1 1 1\n";

    #[test]
    fn import_display_lut_copies_a_valid_cube_and_returns_the_list() {
        let directory = TestDirectory::new();
        let luts_dir = directory.path().join("luts");
        let source = directory.path().join("Downloads").join("Teal.CUBE");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, CUBE_HEADER).unwrap();

        let listed = import_display_lut(&source, &luts_dir).unwrap();
        assert_eq!(listed, vec![luts_dir.join("Teal.CUBE")]);
        assert_eq!(std::fs::read(luts_dir.join("Teal.CUBE")).unwrap(), CUBE_HEADER);
        assert!(source.is_file(), "源文件不动");
        // 同内容再导一次 = 已导入,不报错。
        assert_eq!(import_display_lut(&source, &luts_dir).unwrap().len(), 1);
        // 同名不同内容 → 拒绝,目录里的文件不变。
        std::fs::write(&source, b"TITLE \"other\"\nLUT_3D_SIZE 2\n1 1 1\n0 0 0\n").unwrap();
        let error = import_display_lut(&source, &luts_dir).unwrap_err();
        assert!(error.to_string().contains("同名"), "{error}");
        assert_eq!(std::fs::read(luts_dir.join("Teal.CUBE")).unwrap(), CUBE_HEADER);
    }

    #[test]
    fn import_display_lut_rejects_wrong_extension_empty_and_headerless_files() {
        let directory = TestDirectory::new();
        let luts_dir = directory.path().join("luts");
        let not_cube = directory.path().join("look.3dl");
        std::fs::write(&not_cube, CUBE_HEADER).unwrap();
        assert!(import_display_lut(&not_cube, &luts_dir).unwrap_err().to_string().contains(".cube"));
        let empty = directory.path().join("empty.cube");
        std::fs::write(&empty, b"").unwrap();
        assert!(import_display_lut(&empty, &luts_dir).unwrap_err().to_string().contains("空"));
        let junk = directory.path().join("junk.cube");
        std::fs::write(&junk, b"hello world").unwrap();
        assert!(import_display_lut(&junk, &luts_dir).unwrap_err().to_string().contains("LUT_3D_SIZE"));
        let missing = directory.path().join("missing.cube");
        assert!(import_display_lut(&missing, &luts_dir).unwrap_err().to_string().contains("不存在"));
        assert!(list_display_luts(&luts_dir).unwrap().is_empty(), "被拒的文件一个都不该落进 luts/");
    }

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
