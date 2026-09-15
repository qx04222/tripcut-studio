//! R15:缓存文件的后台删除任务(`cache_gc`)。
//!
//! 删素材 / 删集 / 清理缓存 / 重置项目库都会产生一堆要删的目录。此前它们在命令
//! 里同步 `remove_dir_all`,用户就得盯着按钮转圈等磁盘;现在数据库那一步只登记
//! 「这些目录可以删了」,真正的 unlink 交给 worker 池,状态条显示「正在清理缓存文件」。
//!
//! 两种载荷:
//! - `{"dirs":["12","13"]}`:`cache_root/<id>/` 下按素材 id 命名的目录;
//! - `{"retired":"/abs/.cache.retired-<uuid>"}`:整个缓存目录改名后的旧目录。
//!
//! 只删这两种形状的路径(素材 id 目录必须在 cache_root 里,退役目录必须与
//! cache_root 同父目录且名字以 `.cache` 开头),载荷被改坏也删不到别处。
//! 目录已不存在 = 成功(任务可重跑、可在崩溃后由恢复流程续跑)。

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::error::{CoreError, Result};
use super::jobs::Job;

pub const KIND: &str = "cache_gc";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Payload {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    dirs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retired: Option<String>,
}

/// 登记「这些素材的缓存目录可以删了」。在调用方的事务里写,与删除素材同一次提交。
pub fn enqueue_clip_dirs(connection: &Connection, clip_ids: &[i64]) -> Result<Option<i64>> {
    if clip_ids.is_empty() {
        return Ok(None);
    }
    let payload = Payload {
        dirs: clip_ids.iter().map(|id| id.to_string()).collect(),
        retired: None,
    };
    let payload = serde_json::to_string(&payload)
        .map_err(|error| CoreError::BackgroundTask(format!("缓存清理任务载荷序列化失败:{error}")))?;
    let hash = format!(
        "cache_gc:clips:{}:{}:{}",
        clip_ids.first().copied().unwrap_or_default(),
        clip_ids.last().copied().unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    );
    super::jobs::enqueue_within(connection, KIND, &payload, &hash).map(Some)
}

/// 登记「整个退役缓存目录可以删了」。
pub fn enqueue_retired_dir(connection: &Connection, retired: &Path) -> Result<i64> {
    let payload = Payload {
        dirs: Vec::new(),
        retired: Some(retired.to_string_lossy().into_owned()),
    };
    let payload = serde_json::to_string(&payload)
        .map_err(|error| CoreError::BackgroundTask(format!("缓存清理任务载荷序列化失败:{error}")))?;
    let hash = format!("cache_gc:retired:{}", uuid::Uuid::new_v4().simple());
    super::jobs::enqueue_within(connection, KIND, &payload, &hash)
}

/// 还有多少清理任务没做完(状态条用)。
pub fn pending_count(connection: &Connection) -> Result<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM jobs WHERE kind = ?1 AND status IN ('pending', 'running')",
        [KIND],
        |row| row.get(0),
    )?)
}

fn is_clip_dir_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit())
}

/// 退役目录必须与 cache_root 同父、名字以 `.cache` 开头(`settings::clear_cache_and_rebuild`
/// 与 `doctor::rebuild_cache_files` 就是这么起名的)。
fn is_retired_dir(cache_root: &Path, candidate: &Path) -> bool {
    let same_parent = candidate.parent().is_some_and(|parent| Some(parent) == cache_root.parent());
    let name_ok = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".cache"));
    same_parent && name_ok && candidate != cache_root
}

fn remove_if_present(path: &Path) -> Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    let bytes = super::doctor::directory_bytes(path).unwrap_or(0);
    std::fs::remove_dir_all(path)?;
    Ok(bytes)
}

/// 执行一条清理任务。返回删掉的字节数(只作日志)。
pub fn run(job: &Job, cache_root: &Path) -> Result<u64> {
    let payload: Payload = serde_json::from_str(&job.payload)
        .map_err(|error| CoreError::BackgroundTask(format!("缓存清理任务载荷无效:{error}")))?;
    let mut removed = 0_u64;
    for dir in &payload.dirs {
        if super::jobs::current_cancellation_requested() {
            return Err(CoreError::BackgroundTask("用户已取消".to_owned()));
        }
        if !is_clip_dir_name(dir) {
            tracing::warn!(dir, "cache_gc 跳过不像素材目录的名字");
            continue;
        }
        removed += remove_if_present(&cache_root.join(dir))?;
    }
    if let Some(retired) = payload.retired.as_deref().map(PathBuf::from) {
        if is_retired_dir(cache_root, &retired) {
            removed += remove_if_present(&retired)?;
        } else {
            tracing::warn!(path = %retired.display(), "cache_gc 拒绝删除不在缓存目录旁边的路径");
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, jobs, test_support::TestDirectory};

    fn job_with(payload: &str) -> Job {
        Job {
            id: 1,
            kind: KIND.to_owned(),
            payload: payload.to_owned(),
            status: jobs::JobStatus::Running,
            attempt: 1,
            blocked_summary: None,
            result_path: None,
        }
    }

    #[test]
    fn removes_clip_dirs_and_retired_dir_but_nothing_else() {
        let directory = TestDirectory::new();
        let cache_root = directory.path().join("cache");
        std::fs::create_dir_all(cache_root.join("12")).unwrap();
        std::fs::write(cache_root.join("12/proxy.mp4"), b"xx").unwrap();
        std::fs::create_dir_all(cache_root.join("13")).unwrap();
        std::fs::create_dir_all(cache_root.join("keep")).unwrap();
        let retired = directory.path().join(".cache.retired-abc");
        std::fs::create_dir_all(retired.join("1")).unwrap();
        let elsewhere = directory.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();

        let payload = format!(
            r#"{{"dirs":["12","13","keep","../elsewhere"],"retired":"{}"}}"#,
            retired.display()
        );
        run(&job_with(&payload), &cache_root).unwrap();
        assert!(!cache_root.join("12").exists());
        assert!(!cache_root.join("13").exists());
        assert!(cache_root.join("keep").exists(), "非数字目录名不是素材目录,不能删");
        assert!(elsewhere.exists(), "../ 逃出缓存目录的名字不能删");
        assert!(!retired.exists());

        // 退役目录必须在缓存目录旁边:别处的同名目录不删。
        let stray = directory.path().join("sub/.cache.retired-x");
        std::fs::create_dir_all(&stray).unwrap();
        let payload = format!(r#"{{"retired":"{}"}}"#, stray.display());
        run(&job_with(&payload), &cache_root).unwrap();
        assert!(stray.exists());

        // 目录已经不在 = 成功(可重跑)。
        run(&job_with(r#"{"dirs":["12"]}"#), &cache_root).unwrap();
    }

    #[test]
    fn enqueue_records_a_pending_job_counted_by_pending_count() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        assert_eq!(pending_count(&connection).unwrap(), 0);
        assert_eq!(enqueue_clip_dirs(&connection, &[]).unwrap(), None);
        enqueue_clip_dirs(&connection, &[3, 4]).unwrap().unwrap();
        enqueue_retired_dir(&connection, Path::new("/tmp/.cache.retired-x")).unwrap();
        assert_eq!(pending_count(&connection).unwrap(), 2);
        let payload: String = connection
            .query_row("SELECT payload FROM jobs WHERE kind = 'cache_gc' ORDER BY id LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(payload, r#"{"dirs":["3","4"]}"#);
    }
}

// ---------------------------------------------------------------------------
// R18 车道 settings F6:按天数自动清理缓存
// ---------------------------------------------------------------------------

/// 一次自动清理的结果。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StaleSweep {
    pub removed: usize,
    pub bytes: u64,
}

/// 「多久没用就自动清掉」:把 `days` 天没再被读写过的预览小文件删掉,连同它在
/// `cache_artifacts` 里的行。只碰 `kind='proxy'` —— 这是唯一一类「删了会自动重建、
/// 删了也不影响任何已有判断」的缓存;封面、指纹这些删掉会让界面出现空白格。
///
/// 判据用文件自己的 mtime(`enforce_proxy_cache_limit` 用的也是它当「最近播过」),
/// 不用数据库里的 created_at:用户上周又看了一遍的片子不该被当成「一个月没动过」。
/// `now` 是参数,好让测试不用真的等 30 天。
pub fn sweep_stale_proxies(
    connection: &Connection,
    cache_root: &Path,
    days: u32,
    now: std::time::SystemTime,
) -> Result<StaleSweep> {
    let mut report = StaleSweep::default();
    if days == 0 {
        return Ok(report);
    }
    let max_age = std::time::Duration::from_secs(u64::from(days) * 24 * 60 * 60);
    let stale: Vec<(i64, String, u64)> = {
        let mut statement = connection
            .prepare("SELECT clip_id, rel_path, bytes FROM cache_artifacts WHERE kind = 'proxy'")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?.max(0) as u64))
        })?;
        rows.filter_map(std::result::Result::ok)
            .filter(|(_, rel_path, _)| {
                // 读不到 mtime(文件已经不在了)也算过期:那一行本来就该清掉。
                match std::fs::metadata(cache_root.join(rel_path)).and_then(|m| m.modified()) {
                    Ok(modified) => now.duration_since(modified).is_ok_and(|age| age > max_age),
                    Err(_) => true,
                }
            })
            .collect()
    };
    for (clip_id, rel_path, bytes) in stale {
        let path = cache_root.join(&rel_path);
        if path.exists() {
            std::fs::remove_file(&path).map_err(CoreError::Io)?;
        }
        connection.execute(
            "DELETE FROM cache_artifacts WHERE clip_id = ?1 AND kind = 'proxy' AND rel_path = ?2",
            rusqlite::params![clip_id, rel_path],
        )?;
        report.removed += 1;
        report.bytes = report.bytes.saturating_add(bytes);
    }
    if report.removed > 0 {
        tracing::info!(removed = report.removed, bytes = report.bytes, days, "按天数自动清理了预览小文件");
    }
    Ok(report)
}

#[cfg(test)]
mod stale_sweep_tests {
    use super::*;
    use crate::core::{db, settings, test_support::TestDirectory};

    fn insert_clip(connection: &Connection, name: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO volumes(uuid) SELECT 'vol-cache-gc'
                 WHERE NOT EXISTS (SELECT 1 FROM volumes WHERE uuid='vol-cache-gc')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den,
                                   duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                                   imported_at, episode_id)
                 VALUES ('vol-cache-gc', ?1, 1, ?1, 1, 1000, 1000, 30, 1, 0, 'h264', 1920, 1080,
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         (SELECT id FROM episodes WHERE status='active'))",
                [name],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn seed_proxy(connection: &Connection, cache_root: &Path, name: &str, rel_path: &str, age_days: u64) {
        let clip_id = insert_clip(connection, name);
        let path = cache_root.join(rel_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![1_u8; 100]).unwrap();
        // 用 std 的 set_modified 造「几天没动过」,不为一条测试引入 filetime 依赖。
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(age_days * 24 * 60 * 60);
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
        connection
            .execute(
                "INSERT INTO cache_artifacts (clip_id, kind, rel_path, source_hash, bytes, created_at)
                 VALUES (?1, 'proxy', ?2, 'hash', 100, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![clip_id, rel_path],
            )
            .unwrap();
    }

    /// F6:设 15 天 → 20 天没动的那条被清掉(文件和数据库行都没了),3 天前动过的留着;
    /// 设「从不」一条都不清。
    #[test]
    fn sweep_removes_only_files_older_than_the_chosen_window() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let cache_root = directory.path().join("cache");
        seed_proxy(&connection, &cache_root, "old.mp4", "1/proxy.mp4", 20);
        seed_proxy(&connection, &cache_root, "fresh.mp4", "2/proxy.mp4", 3);
        let now = std::time::SystemTime::now();

        // 「从不」= 一条都不动。
        assert_eq!(sweep_stale_proxies(&connection, &cache_root, 0, now).unwrap().removed, 0);
        assert!(cache_root.join("1/proxy.mp4").is_file());

        let swept = sweep_stale_proxies(&connection, &cache_root, 15, now).unwrap();
        assert_eq!(swept.removed, 1);
        assert_eq!(swept.bytes, 100);
        assert!(!cache_root.join("1/proxy.mp4").exists(), "20 天没动的要被清掉");
        assert!(cache_root.join("2/proxy.mp4").is_file(), "3 天前动过的必须留着");
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM cache_artifacts WHERE kind='proxy'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1, "数据库行要跟着文件一起走,不能留孤儿");

        // 再跑一次不重复计数。
        assert_eq!(sweep_stale_proxies(&connection, &cache_root, 15, now).unwrap().removed, 0);
    }

    /// F6:天数从设置里读,"0"/没存过 = 从不。
    #[test]
    fn auto_clean_days_setting_defaults_to_never() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        assert_eq!(settings::cache_auto_clean_days(&connection), None);
        settings::set_setting(&connection, settings::CACHE_AUTO_CLEAN_DAYS_KEY, "30").unwrap();
        assert_eq!(settings::cache_auto_clean_days(&connection), Some(30));
        assert!(
            settings::set_setting(&connection, settings::CACHE_AUTO_CLEAN_DAYS_KEY, "7").is_err(),
            "档位之外的天数不许存进来",
        );
        settings::set_setting(&connection, settings::CACHE_AUTO_CLEAN_DAYS_KEY, "0").unwrap();
        assert_eq!(settings::cache_auto_clean_days(&connection), None);
    }
}
