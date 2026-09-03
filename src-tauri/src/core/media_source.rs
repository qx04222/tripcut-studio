use std::path::PathBuf;
use std::process::{Command, Stdio};

use rusqlite::{Connection, OptionalExtension};

use super::error::{CoreError, Result};

#[derive(Debug)]
struct StoredSource {
    volume_uuid: String,
    rel_path: String,
    byte_size: Option<i64>,
    quick_hash: Option<String>,
    full_hash: Option<String>,
}

pub fn verified_clip_path(connection: &Connection, clip_id: i64) -> Result<PathBuf> {
    verified_clip_path_with_mount(connection, clip_id, resolve_uuid_mount)
}

pub fn clip_path_for_full_hash(connection: &Connection, clip_id: i64) -> Result<PathBuf> {
    resolve_and_verify(connection, clip_id, resolve_uuid_mount, false)
}

fn verified_clip_path_with_mount(
    connection: &Connection,
    clip_id: i64,
    resolve_mount: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<PathBuf> {
    resolve_and_verify(connection, clip_id, resolve_mount, true)
}

fn resolve_and_verify(
    connection: &Connection,
    clip_id: i64,
    resolve_mount: impl FnOnce(&str) -> Option<PathBuf>,
    require_external_full_hash: bool,
) -> Result<PathBuf> {
    let source = connection
        .query_row(
            "SELECT volume_uuid, rel_path, byte_size, quick_hash, full_hash
             FROM clips WHERE id=?1",
            [clip_id],
            |row| {
                Ok(StoredSource {
                    volume_uuid: row.get(0)?,
                    rel_path: row.get(1)?,
                    byte_size: row.get(2)?,
                    quick_hash: row.get(3)?,
                    full_hash: row.get(4)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::MediaSource(format!("素材 {clip_id} 不存在")))?;
    let stored_path = PathBuf::from(&source.rel_path);
    let external_rebind = !stored_path.is_absolute();
    let candidate = if external_rebind {
        let mount = resolve_mount(&source.volume_uuid).ok_or_else(|| {
            CoreError::MediaSource(format!(
                "未找到 UUID 为 {} 的外置盘；请人工重连素材",
                source.volume_uuid
            ))
        })?;
        mount.join(stored_path)
    } else {
        stored_path
    };
    let candidate = candidate.canonicalize().map_err(|error| {
        CoreError::MediaSource(format!(
            "素材 {clip_id} 当前不可访问（{}）：{error}",
            candidate.display()
        ))
    })?;
    if !candidate.is_file() {
        return Err(CoreError::MediaSource(format!(
            "素材 {clip_id} 不是普通文件：{}",
            candidate.display()
        )));
    }
    let actual_size = candidate.metadata()?.len();
    if source
        .byte_size
        .is_some_and(|expected| expected < 0 || expected as u64 != actual_size)
    {
        return Err(CoreError::MediaSource(format!(
            "素材 {clip_id} 大小不一致；拒绝静默重绑同名文件"
        )));
    }
    if let Some(expected) = source.quick_hash.as_deref() {
        let (actual, _) = super::import::quick_fingerprint(&candidate)?;
        if actual != expected {
            return Err(CoreError::MediaSource(format!(
                "素材 {clip_id} 快速哈希不一致；请人工重连"
            )));
        }
    }
    if external_rebind && require_external_full_hash && source.full_hash.is_none() {
        return Err(CoreError::MediaSource(format!(
            "素材 {clip_id} 尚无完整哈希，不能确认外置盘重绑；请等待完整哈希或人工确认"
        )));
    }
    if external_rebind && require_external_full_hash {
        let expected = source.full_hash.as_deref().expect("checked above");
        let actual = super::import::full_fingerprint(&candidate)?;
        if actual != expected {
            return Err(CoreError::MediaSource(format!(
                "素材 {clip_id} 完整哈希不一致；拒绝静默重绑同名文件"
            )));
        }
    }
    Ok(candidate)
}

fn resolve_uuid_mount(volume_uuid: &str) -> Option<PathBuf> {
    let output = Command::new("diskutil")
        .args(["info", "-plist", volume_uuid])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let plist = String::from_utf8(output.stdout).ok()?;
    if plist_string(&plist, "VolumeUUID")? != volume_uuid {
        return None;
    }
    plist_string(&plist, "MountPoint").map(PathBuf::from)
}

fn plist_string<'a>(plist: &'a str, key: &str) -> Option<&'a str> {
    let marker = format!("<key>{key}</key>");
    let after_key = plist.split_once(&marker)?.1;
    let after_open = after_key.split_once("<string>")?.1;
    after_open.split_once("</string>").map(|(value, _)| value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, import, test_support::TestDirectory};

    #[test]
    fn external_rebind_rejects_same_name_file_with_wrong_full_hash() {
        let directory = TestDirectory::new();
        let mount = directory.path().join("mounted-card");
        let relative = "DCIM/CLIP001.MOV";
        let candidate = mount.join(relative);
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        let expected = directory.path().join("expected.mov");
        let original = vec![7_u8; 12 * 1024 * 1024];
        let mut replacement = original.clone();
        replacement[6 * 1024 * 1024] = 9;
        std::fs::write(&expected, &original).unwrap();
        std::fs::write(&candidate, &replacement).unwrap();
        let expected_full = import::full_fingerprint(&expected).unwrap();
        let expected_quick = import::quick_fingerprint(&expected).unwrap().0;
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute(
                "INSERT INTO volumes(uuid, label) VALUES ('CARD-UUID', 'CARD')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, byte_size, quick_hash, full_hash)
                 VALUES (1, 'CARD-UUID', ?1, ?2, ?3, ?4)",
                rusqlite::params![
                    relative,
                    std::fs::metadata(&expected).unwrap().len() as i64,
                    expected_quick,
                    expected_full
                ],
            )
            .unwrap();

        let error = verified_clip_path_with_mount(&connection, 1, |_| Some(mount.clone()))
            .unwrap_err();

        assert!(error.to_string().contains("完整哈希不一致"));
    }

    #[test]
    fn external_rebind_accepts_uuid_mount_only_after_full_hash_confirmation() {
        let directory = TestDirectory::new();
        let mount = directory.path().join("mounted-card");
        let relative = "DCIM/CLIP001.MOV";
        let candidate = mount.join(relative);
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, b"the original clip bytes").unwrap();
        let (quick_hash, byte_size) = import::quick_fingerprint(&candidate).unwrap();
        let full_hash = import::full_fingerprint(&candidate).unwrap();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute(
                "INSERT INTO volumes(uuid, label) VALUES ('CARD-UUID', 'CARD')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, byte_size, quick_hash, full_hash)
                 VALUES (1, 'CARD-UUID', ?1, ?2, ?3, ?4)",
                rusqlite::params![relative, byte_size as i64, quick_hash, full_hash],
            )
            .unwrap();

        let resolved =
            verified_clip_path_with_mount(&connection, 1, |_| Some(mount.clone())).unwrap();

        assert_eq!(resolved, candidate.canonicalize().unwrap());
    }
}
