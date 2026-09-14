use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::error::{CoreError, Result};

/// 一条缺失素材，供前端「重连」面板按卷分组展示。
#[derive(Debug, Serialize)]
pub struct MissingClip {
    pub clip_id: i64,
    pub file_name: String,
    pub volume_uuid: String,
    pub volume_label: Option<String>,
    pub rel_path: String,
    pub missing_since: String,
}

/// 重连一张卷下所有缺失素材后的结果：重绑数量、按哈希拒绝的文件名（同名不同内容）、仍未找到的数量。
#[derive(Debug, Default, Serialize)]
pub struct RelinkOutcome {
    pub relinked: usize,
    pub rejected: Vec<String>,
    pub still_missing: usize,
}

fn file_name_of(rel_path: &str) -> String {
    Path::new(rel_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel_path.to_owned())
}

pub fn list_missing_clips(connection: &Connection) -> Result<Vec<MissingClip>> {
    let mut statement = connection.prepare(
        "SELECT c.id, c.rel_path, c.volume_uuid, v.label, c.missing_since
         FROM clips c LEFT JOIN volumes v ON v.uuid = c.volume_uuid
         WHERE c.missing_since IS NOT NULL
         ORDER BY c.volume_uuid, c.rel_path",
    )?;
    let rows = statement.query_map([], |row| {
        let rel_path: String = row.get(1)?;
        Ok(MissingClip {
            clip_id: row.get(0)?,
            file_name: file_name_of(&rel_path),
            volume_uuid: row.get(2)?,
            volume_label: row.get(3)?,
            rel_path,
            missing_since: row.get(4)?,
        })
    })?;
    let mut clips = Vec::new();
    for row in rows {
        clips.push(row?);
    }
    Ok(clips)
}

/// 用户选了新挂载点：对该卷下所有缺失素材按 rel_path 在新位置查找文件，
/// 只有完整哈希一致才重绑（清除 missing_since）；同名但内容不同一律拒绝并列出，
/// 绝不静默猜测。从不移动或修改磁盘上的原始文件。
pub fn relink_volume(
    connection: &mut Connection,
    volume_uuid: &str,
    new_mount: &Path,
) -> Result<RelinkOutcome> {
    relink_volume_with(connection, volume_uuid, new_mount, |path| {
        Ok(super::import::diskutil_volume_identity(path))
    })
}

/// `relink_volume` 的可注入版本：`identity` 用于探测 `new_mount` 实际所在卷的身份
/// （生产路径传真实 diskutil 探测，测试注入桩）。
///
/// 只清 `missing_since` 而不更新 `volume_uuid` 会让「换到新硬盘」的重连看起来成功，
/// 但下一次播放仍按旧 UUID 走 `resolve_uuid_mount` 解析，从而失败——所以这里必须
/// 先确定新位置真实所属的卷身份，再决定是否可以安全重绑。
pub(crate) fn relink_volume_with(
    connection: &mut Connection,
    volume_uuid: &str,
    new_mount: &Path,
    identity: impl Fn(&Path) -> Result<Option<super::import::VolumeIdentity>>,
) -> Result<RelinkOutcome> {
    let (new_volume_uuid, new_volume_label) = match identity(new_mount)? {
        Some(identity) => (identity.uuid, identity.label),
        None => {
            // 无法探测新位置的卷身份（例如测试里的普通文件夹）。只有当旧卷此刻仍能
            // 解析时，才可以保守地认为用户没有换盘——否则必须拒绝整个重连，
            // 绝不能把「无法确认卷身份」报告为成功。
            if resolve_uuid_mount(volume_uuid).is_some() {
                (volume_uuid.to_owned(), None)
            } else {
                return Err(CoreError::MediaSource(
                    "无法识别所选位置所在的卷".to_owned(),
                ));
            }
        }
    };

    struct Candidate {
        clip_id: i64,
        rel_path: String,
        byte_size: Option<i64>,
        quick_hash: Option<String>,
        full_hash: Option<String>,
    }
    let candidates: Vec<Candidate> = {
        let mut statement = connection.prepare(
            "SELECT id, rel_path, byte_size, quick_hash, full_hash
             FROM clips WHERE volume_uuid = ?1 AND missing_since IS NOT NULL",
        )?;
        let rows = statement.query_map([volume_uuid], |row| {
            Ok(Candidate {
                clip_id: row.get(0)?,
                rel_path: row.get(1)?,
                byte_size: row.get(2)?,
                quick_hash: row.get(3)?,
                full_hash: row.get(4)?,
            })
        })?;
        let mut collected = Vec::new();
        for row in rows {
            collected.push(row?);
        }
        collected
    };

    let mut outcome = RelinkOutcome::default();
    let transaction = connection.transaction()?;
    // 卷身份可能变了（换了新硬盘），下面的 UPDATE 会把 clips.volume_uuid 指向
    // new_volume_uuid，而它必须先在 volumes 表里存在（外键约束）。
    transaction.execute(
        "INSERT INTO volumes(uuid, label) VALUES (?1, ?2)
         ON CONFLICT(uuid) DO UPDATE SET label = COALESCE(excluded.label, volumes.label)",
        rusqlite::params![new_volume_uuid, new_volume_label],
    )?;
    for candidate in candidates {
        let file_name = file_name_of(&candidate.rel_path);
        let found = new_mount.join(&candidate.rel_path);
        if !found.is_file() {
            outcome.still_missing += 1;
            continue;
        }
        let actual_size = match found.metadata() {
            Ok(metadata) => metadata.len(),
            Err(_) => {
                outcome.still_missing += 1;
                continue;
            }
        };
        if candidate
            .byte_size
            .is_some_and(|expected| expected < 0 || expected as u64 != actual_size)
        {
            outcome.rejected.push(file_name);
            continue;
        }
        if let Some(expected) = candidate.quick_hash.as_deref() {
            match super::import::quick_fingerprint(&found) {
                Ok((actual, _)) if actual == expected => {}
                _ => {
                    outcome.rejected.push(file_name);
                    continue;
                }
            }
        }
        let hash_matches = match candidate.full_hash.as_deref() {
            Some(expected) => super::import::full_fingerprint(&found)
                .map(|actual| actual == expected)
                .unwrap_or(false),
            // 没有完整哈希（素材尚未算出）时不能确认，保守拒绝而非静默重绑。
            None => false,
        };
        if !hash_matches {
            outcome.rejected.push(file_name);
            continue;
        }
        transaction.execute(
            "UPDATE clips SET volume_uuid = ?1, rel_path = ?2, missing_since = NULL WHERE id = ?3",
            rusqlite::params![new_volume_uuid, candidate.rel_path, candidate.clip_id],
        )?;
        outcome.relinked += 1;
    }
    transaction.commit()?;
    Ok(outcome)
}

/// Z-07:「原片不在原来的位置」的一句话原因(导出拒绝 / 任务失败 / 缺失页都用它,不出现内部词)。
pub const MISSING_SOURCE_REASON: &str = "原片不在原来的位置(可能拔了卡或移了文件夹)";
/// Z-07:跟在原因后面的下一步。
pub const MISSING_SOURCE_NEXT: &str = "去缺失素材页重新定位";

/// 一轮存活检查的结果:查了多少条、新标为缺失多少条、从缺失恢复多少条。
#[derive(Debug, Default, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct MissingRefresh {
    pub checked: usize,
    pub newly_missing: usize,
    pub restored: usize,
}

/// Z-07:廉价的存活检查——对每条素材 `stat` 一次绝对路径,不在就写 `missing_since`,
/// 回来了就清掉。这是 `clips.missing_since` 唯一的生产写入点(此前只有重绑置 NULL),
/// 缺失素材页、媒体池「缺失」角标与导出预检都读它。`clip_ids` 为 `None` 时查整库。
pub fn refresh_missing_flags(connection: &Connection, clip_ids: Option<&[i64]>) -> Result<MissingRefresh> {
    refresh_missing_flags_with(connection, clip_ids, resolve_uuid_mount)
}

pub(crate) fn refresh_missing_flags_with(
    connection: &Connection,
    clip_ids: Option<&[i64]>,
    mut resolve_mount: impl FnMut(&str) -> Option<PathBuf>,
) -> Result<MissingRefresh> {
    struct Row {
        clip_id: i64,
        volume_uuid: String,
        rel_path: String,
        missing: bool,
    }
    let mut statement = connection.prepare(
        "SELECT id, volume_uuid, rel_path, missing_since IS NOT NULL FROM clips ORDER BY id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(Row {
            clip_id: row.get(0)?,
            volume_uuid: row.get(1)?,
            rel_path: row.get(2)?,
            missing: row.get::<_, i64>(3)? == 1,
        })
    })?;
    // 外置卷的挂载点按卷只探一次(diskutil 慢),同卷的素材共用。
    let mut mounts: std::collections::HashMap<String, Option<PathBuf>> = std::collections::HashMap::new();
    let mut outcome = MissingRefresh::default();
    for row in rows {
        let row = row?;
        if clip_ids.is_some_and(|ids| !ids.contains(&row.clip_id)) {
            continue;
        }
        outcome.checked += 1;
        let stored = PathBuf::from(&row.rel_path);
        let present = if stored.is_absolute() {
            stored.is_file()
        } else {
            let mount = mounts
                .entry(row.volume_uuid.clone())
                .or_insert_with(|| resolve_mount(&row.volume_uuid));
            mount.as_ref().is_some_and(|mount| mount.join(&stored).is_file())
        };
        match (present, row.missing) {
            (false, false) => {
                connection.execute(
                    "UPDATE clips SET missing_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     WHERE id = ?1 AND missing_since IS NULL",
                    [row.clip_id],
                )?;
                outcome.newly_missing += 1;
            }
            (true, true) => {
                connection.execute(
                    "UPDATE clips SET missing_since = NULL WHERE id = ?1",
                    [row.clip_id],
                )?;
                outcome.restored += 1;
            }
            _ => {}
        }
    }
    Ok(outcome)
}

/// Z-07:同一库 `interval` 内最多真查一次(状态条每 3 秒轮询缺失列表,不能每次都 stat 全库)。
/// 返回 `None` 表示这次被节流跳过。
pub fn refresh_missing_flags_throttled(
    connection: &Connection,
    interval: std::time::Duration,
) -> Result<Option<MissingRefresh>> {
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    static LAST_RUN: OnceLock<Mutex<std::collections::HashMap<String, Instant>>> = OnceLock::new();
    let key = connection.path().unwrap_or("<memory>").to_owned();
    let last_run = LAST_RUN.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    {
        let mut guard = last_run.lock().unwrap_or_else(|error| error.into_inner());
        if guard.get(&key).is_some_and(|at| at.elapsed() < interval) {
            return Ok(None);
        }
        guard.insert(key, Instant::now());
    }
    refresh_missing_flags(connection, None).map(Some)
}

/// Z-07:一组素材里此刻缺失的文件名(先做一轮存活检查再读旗标)。导出预检用:非空就拒绝。
pub fn missing_file_names(connection: &Connection, clip_ids: &[i64]) -> Result<Vec<String>> {
    if clip_ids.is_empty() {
        return Ok(Vec::new());
    }
    refresh_missing_flags(connection, Some(clip_ids))?;
    let mut names = Vec::new();
    for clip_id in clip_ids {
        let rel_path: Option<String> = connection
            .query_row(
                "SELECT rel_path FROM clips WHERE id = ?1 AND missing_since IS NOT NULL",
                [clip_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(rel_path) = rel_path {
            names.push(file_name_of(&rel_path));
        }
    }
    Ok(names)
}

/// 「原片不在原来的位置(可能拔了卡或移了文件夹):A.mov、B.mov;去缺失素材页重新定位」。
pub fn missing_source_message(names: &[String]) -> String {
    let listed = if names.len() > 3 {
        format!("{} 等 {} 条", names[..3].join("、"), names.len())
    } else {
        names.join("、")
    };
    format!("{MISSING_SOURCE_REASON}:{listed};{MISSING_SOURCE_NEXT}")
}

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
        if error.kind() == std::io::ErrorKind::NotFound {
            // Z-07:文件不在了就顺手记为缺失(缺失页 / 状态条据此亮起),给用户的是一句人话。
            let _ = connection.execute(
                "UPDATE clips SET missing_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1 AND missing_since IS NULL",
                [clip_id],
            );
            return CoreError::MediaSource(missing_source_message(&[file_name_of(&source.rel_path)]));
        }
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

    fn seed_clip(connection: &Connection, id: i64, path: &Path) {
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path) VALUES (?1, 'fixture', ?2)",
                rusqlite::params![id, path.to_string_lossy().as_ref()],
            )
            .unwrap();
    }

    fn missing_since(connection: &Connection, id: i64) -> Option<String> {
        connection
            .query_row("SELECT missing_since FROM clips WHERE id = ?1", [id], |row| row.get(0))
            .unwrap()
    }

    /// Z-07:文件夹移走 → 标缺失;移回来 → 清掉。这是 `missing_since` 的唯一生产写入点。
    #[test]
    fn refresh_missing_flags_marks_moved_folder_and_clears_when_it_returns() {
        let directory = TestDirectory::new();
        let trip = directory.path().join("trip");
        std::fs::create_dir_all(&trip).unwrap();
        let clip_a = trip.join("IMG_0830.mov");
        let clip_b = trip.join("IMG_0831.mov");
        std::fs::write(&clip_a, b"a").unwrap();
        std::fs::write(&clip_b, b"b").unwrap();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('fixture')", []).unwrap();
        seed_clip(&connection, 1, &clip_a);
        seed_clip(&connection, 2, &clip_b);

        let before = refresh_missing_flags(&connection, None).unwrap();
        assert_eq!(before, MissingRefresh { checked: 2, newly_missing: 0, restored: 0 });
        assert!(list_missing_clips(&connection).unwrap().is_empty());

        let moved = directory.path().join("trip-moved");
        std::fs::rename(&trip, &moved).unwrap();
        let gone = refresh_missing_flags(&connection, None).unwrap();
        assert_eq!(gone, MissingRefresh { checked: 2, newly_missing: 2, restored: 0 });
        assert!(missing_since(&connection, 1).is_some());
        let listed = list_missing_clips(&connection).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].file_name, "IMG_0830.mov");
        // 再查一次不重复计数、不改时间戳。
        let stamp = missing_since(&connection, 1);
        let again = refresh_missing_flags(&connection, None).unwrap();
        assert_eq!(again, MissingRefresh { checked: 2, newly_missing: 0, restored: 0 });
        assert_eq!(missing_since(&connection, 1), stamp);

        std::fs::rename(&moved, &trip).unwrap();
        let back = refresh_missing_flags(&connection, None).unwrap();
        assert_eq!(back, MissingRefresh { checked: 2, newly_missing: 0, restored: 2 });
        assert!(missing_since(&connection, 1).is_none());
        assert!(list_missing_clips(&connection).unwrap().is_empty());
    }

    /// Z-07:外置卷解析不到挂载点(拔卡)= 该卷全部缺失;只查给定 id 时别的素材不动。
    #[test]
    fn refresh_missing_flags_uses_mount_resolution_and_honours_clip_id_filter() {
        let directory = TestDirectory::new();
        let mount = directory.path().join("card");
        std::fs::create_dir_all(mount.join("DCIM")).unwrap();
        std::fs::write(mount.join("DCIM/A.MOV"), b"a").unwrap();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('CARD')", []).unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path) VALUES (1, 'CARD', 'DCIM/A.MOV'), (2, 'CARD', 'DCIM/B.MOV')",
                [],
            )
            .unwrap();
        let outcome =
            refresh_missing_flags_with(&connection, Some(&[1]), |_| Some(mount.clone())).unwrap();
        assert_eq!(outcome, MissingRefresh { checked: 1, newly_missing: 0, restored: 0 });
        assert!(missing_since(&connection, 2).is_none(), "未列入 id 的素材不动");

        let unplugged = refresh_missing_flags_with(&connection, None, |_| None).unwrap();
        assert_eq!(unplugged, MissingRefresh { checked: 2, newly_missing: 2, restored: 0 });
        let names = missing_file_names(&connection, &[1, 2]).unwrap();
        assert_eq!(names, vec!["A.MOV".to_owned(), "B.MOV".to_owned()]);
        let message = missing_source_message(&names);
        assert!(message.starts_with("原片不在原来的位置(可能拔了卡或移了文件夹):A.MOV、B.MOV"));
        assert!(message.ends_with("去缺失素材页重新定位"));
    }

    /// Z-07 / Z-08:导出时解析到不存在的文件 → 人话原因 + 顺手记为缺失。
    #[test]
    fn verified_clip_path_reports_plain_reason_and_flags_missing_file() {
        let directory = TestDirectory::new();
        let gone = directory.path().join("gone/IMG_0830_早餐.mov");
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('fixture')", []).unwrap();
        seed_clip(&connection, 1, &gone);
        let error = verified_clip_path(&connection, 1).unwrap_err().to_string();
        assert!(error.contains("原片不在原来的位置(可能拔了卡或移了文件夹):IMG_0830_早餐.mov"), "{error}");
        assert!(!error.contains("os error"), "{error}");
        assert!(missing_since(&connection, 1).is_some());
    }

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

    #[test]
    fn relink_volume_relinks_hash_matches_and_rejects_hash_mismatches() {
        let directory = TestDirectory::new();
        let new_mount = directory.path().join("relinked-card");
        let relative_a = "DCIM/CLIP_A.MOV";
        let relative_b = "DCIM/CLIP_B.MOV";
        let path_a = new_mount.join(relative_a);
        let path_b = new_mount.join(relative_b);
        std::fs::create_dir_all(path_a.parent().unwrap()).unwrap();
        std::fs::create_dir_all(path_b.parent().unwrap()).unwrap();

        // A: 新位置的文件内容和 clips 表记录的哈希不一致（同名不同内容）。
        let original_a = vec![1_u8; 12 * 1024 * 1024];
        let mut replaced_a = original_a.clone();
        replaced_a[6 * 1024 * 1024] = 2;
        std::fs::write(&path_a, &replaced_a).unwrap();
        let stashed_a = directory.path().join("stashed_a.mov");
        std::fs::write(&stashed_a, &original_a).unwrap();
        let (quick_a, size_a) = import::quick_fingerprint(&stashed_a).unwrap();
        let full_a = import::full_fingerprint(&stashed_a).unwrap();

        // B: 新位置的文件内容与记录一致，应当重绑。
        std::fs::write(&path_b, b"unchanged clip bytes for B").unwrap();
        let (quick_b, size_b) = import::quick_fingerprint(&path_b).unwrap();
        let full_b = import::full_fingerprint(&path_b).unwrap();

        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute(
                "INSERT INTO volumes(uuid, label) VALUES ('vol-1', 'External Card')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, byte_size, quick_hash, full_hash, missing_since)
                 VALUES (1, 'vol-1', ?1, ?2, ?3, ?4, '2026-09-01T00:00:00Z')",
                rusqlite::params![relative_a, size_a as i64, quick_a, full_a],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, byte_size, quick_hash, full_hash, missing_since)
                 VALUES (2, 'vol-1', ?1, ?2, ?3, ?4, '2026-09-01T00:00:00Z')",
                rusqlite::params![relative_b, size_b as i64, quick_b, full_b],
            )
            .unwrap();

        // 本测试关注哈希匹配/拒绝逻辑，不关注换盘场景，所以注入身份解析结果为同一块卷。
        let outcome = relink_volume_with(&mut connection, "vol-1", &new_mount, |_| {
            Ok(Some(import::VolumeIdentity {
                uuid: "vol-1".to_owned(),
                label: Some("External Card".to_owned()),
                fs_type: None,
                mount_point: Some(new_mount.clone()),
            }))
        })
        .unwrap();

        assert_eq!(outcome.relinked, 1);
        assert_eq!(outcome.rejected, vec!["CLIP_A.MOV".to_string()]);
        assert_eq!(outcome.still_missing, 0);

        let missing_a: Option<String> = connection
            .query_row("SELECT missing_since FROM clips WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let missing_b: Option<String> = connection
            .query_row("SELECT missing_since FROM clips WHERE id = 2", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(missing_a.is_some());
        assert!(missing_b.is_none());
    }

    #[test]
    fn relink_volume_writes_new_volume_uuid_when_identity_resolves() {
        let directory = TestDirectory::new();
        let new_mount = directory.path().join("new-ssd");
        let relative = "DCIM/CLIP.MOV";
        let candidate = new_mount.join(relative);
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, b"clip bytes surviving the move to a new disk").unwrap();
        let (quick_hash, byte_size) = import::quick_fingerprint(&candidate).unwrap();
        let full_hash = import::full_fingerprint(&candidate).unwrap();

        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute(
                "INSERT INTO volumes(uuid, label) VALUES ('old-uuid', 'Old Card')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, byte_size, quick_hash, full_hash, missing_since)
                 VALUES (1, 'old-uuid', ?1, ?2, ?3, ?4, '2026-09-01T00:00:00Z')",
                rusqlite::params![relative, byte_size as i64, quick_hash, full_hash],
            )
            .unwrap();

        let outcome = relink_volume_with(&mut connection, "old-uuid", &new_mount, |_| {
            Ok(Some(import::VolumeIdentity {
                uuid: "new-uuid".to_owned(),
                label: Some("New SSD".to_owned()),
                fs_type: None,
                mount_point: Some(new_mount.clone()),
            }))
        })
        .unwrap();

        assert_eq!(outcome.relinked, 1);

        let (stored_uuid, stored_rel_path, stored_missing): (String, String, Option<String>) =
            connection
                .query_row(
                    "SELECT volume_uuid, rel_path, missing_since FROM clips WHERE id = 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
        assert_eq!(stored_uuid, "new-uuid");
        assert_eq!(stored_rel_path, relative);
        assert!(stored_missing.is_none());

        // 重连写回的 volume_uuid/rel_path 正是 verified_clip_path 之后会用来解析的那对值：
        // 只要 resolve_uuid_mount("new-uuid") 能解析出 new_mount，这条素材就能被找到。
        let resolved_mount = new_mount.clone();
        let resolved = verified_clip_path_with_mount(&connection, 1, move |uuid| {
            assert_eq!(uuid, "new-uuid");
            Some(resolved_mount)
        })
        .unwrap();
        assert_eq!(resolved, candidate.canonicalize().unwrap());
    }

    #[test]
    fn relink_volume_rejects_when_identity_unresolvable_and_old_volume_gone() {
        let directory = TestDirectory::new();
        let new_mount = directory.path().join("mystery-folder");
        let relative = "DCIM/CLIP.MOV";
        let candidate = new_mount.join(relative);
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&candidate, b"clip bytes").unwrap();
        let (quick_hash, byte_size) = import::quick_fingerprint(&candidate).unwrap();
        let full_hash = import::full_fingerprint(&candidate).unwrap();

        let mut connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute(
                "INSERT INTO volumes(uuid, label) VALUES ('gone-uuid', 'Gone Card')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, byte_size, quick_hash, full_hash, missing_since)
                 VALUES (1, 'gone-uuid', ?1, ?2, ?3, ?4, '2026-09-01T00:00:00Z')",
                rusqlite::params![relative, byte_size as i64, quick_hash, full_hash],
            )
            .unwrap();

        // 'gone-uuid' 不是真实的 macOS 卷 UUID，所以生产用的 resolve_uuid_mount 也无法
        // 解析它——用真实 diskutil 路径覆盖旧卷判定分支同样会拒绝，这里直接注入
        // identity 探测失败来触发该分支。
        let error = relink_volume_with(&mut connection, "gone-uuid", &new_mount, |_| Ok(None))
            .unwrap_err();

        assert!(error.to_string().contains("无法识别"));

        let (stored_uuid, stored_missing): (String, Option<String>) = connection
            .query_row(
                "SELECT volume_uuid, missing_since FROM clips WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored_uuid, "gone-uuid");
        assert!(stored_missing.is_some());
    }

    #[test]
    fn list_missing_clips_returns_only_missing_grouped_by_volume() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection
            .execute(
                "INSERT INTO volumes(uuid, label) VALUES ('vol-1', 'External Card')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, missing_since)
                 VALUES (1, 'vol-1', 'DCIM/A.MOV', '2026-09-01T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, missing_since)
                 VALUES (2, 'vol-1', 'DCIM/B.MOV', NULL)",
                [],
            )
            .unwrap();

        let missing = list_missing_clips(&connection).unwrap();

        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].clip_id, 1);
        assert_eq!(missing[0].file_name, "A.MOV");
        assert_eq!(missing[0].volume_label.as_deref(), Some("External Card"));
    }
}
