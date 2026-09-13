//! P6-G1 Episode Spine:集生命周期。
//!
//! Episode 语义冻结：
//! - 任意时刻恰好一个 `status='active'` 生产集(部分唯一索引强制);
//! - 新导入素材归属 active 集;历史集只读可查;
//! - 「封存本集」= 单事务:统计快照写 episode_archives(只增)→ active 置 archived
//!   → 新建下一集 active。频道记忆入账仍由交付成功时的
//!   `channel_memory::record_successful_export` 负责,封存不重复入账。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::error::{CoreError, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EpisodeSummary {
    pub id: i64,
    pub title: String,
    pub theme: String,
    pub episode_number: Option<i64>,
    pub status: String,
    pub created_at: String,
    pub archived_at: Option<String>,
    pub clip_count: i64,
    pub favorite_count: i64,
    pub export_count: i64,
    pub target_platform: String,
    pub canvas_orientation: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ArchiveOutcome {
    pub archived: EpisodeSummary,
    pub next: EpisodeSummary,
}

fn summary_by_id(connection: &Connection, id: i64) -> Result<EpisodeSummary> {
    connection
        .query_row(
            "SELECT e.id, e.title, e.theme, e.episode_number, e.status, e.created_at, e.archived_at,
                    e.target_platform, e.canvas_orientation,
                    (SELECT COUNT(*) FROM clips c WHERE c.episode_id = e.id),
                    (SELECT COUNT(*) FROM clips c2
                      WHERE c2.episode_id = e.id
                        AND (
                          EXISTS (
                            SELECT 1 FROM segments selected
                             WHERE selected.clip_id = c2.id
                               AND selected.kind = 'select'
                               AND selected.tombstone = 0
                          )
                          OR 1 = (
                            SELECT r.value FROM ratings r
                              JOIN segments s ON s.id = r.segment_id
                             WHERE s.clip_id = c2.id
                               AND s.tombstone = 0
                               AND COALESCE(s.kind, 'whole') != 'select'
                               AND r.rating_type = 'binary'
                             ORDER BY r.rated_at DESC, r.id DESC
                             LIMIT 1
                          )
                        )),
                    (SELECT COUNT(*) FROM exports x
                       WHERE x.episode_id = e.id)
             FROM episodes e WHERE e.id = ?1",
            [id],
            |row| {
                Ok(EpisodeSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    theme: row.get(2)?,
                    episode_number: row.get(3)?,
                    status: row.get(4)?,
                    created_at: row.get(5)?,
                    archived_at: row.get(6)?,
                    target_platform: row.get(7)?,
                    canvas_orientation: row.get(8)?,
                    clip_count: row.get(9)?,
                    favorite_count: row.get(10)?,
                    export_count: row.get(11)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::Story(format!("Episode {id} 不存在")))
}

pub fn current_episode(connection: &Connection) -> Result<EpisodeSummary> {
    let id: i64 = connection
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::Story("没有处于进行中的集;数据库状态异常".to_owned()))?;
    summary_by_id(connection, id)
}

pub fn list_episodes(connection: &Connection) -> Result<Vec<EpisodeSummary>> {
    let mut statement = connection.prepare(
        "SELECT id FROM episodes ORDER BY status = 'active' DESC, id DESC",
    )?;
    let ids = statement
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ids.into_iter()
        .map(|id| summary_by_id(connection, id))
        .collect()
}

pub fn rename_current(connection: &mut Connection, title: &str, theme: &str) -> Result<EpisodeSummary> {
    let title = title.trim();
    let theme = theme.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(CoreError::Story("集标题必须为 1-120 字".to_owned()));
    }
    if theme.chars().count() > 240 {
        return Err(CoreError::Story("集主题最多 240 字".to_owned()));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = current_episode(&transaction)?;
    transaction.execute(
        "UPDATE episodes SET title = ?1, theme = ?2 WHERE id = ?3",
        params![title, theme, current.id],
    )?;
    let summary = summary_by_id(&transaction, current.id)?;
    transaction.commit()?;
    Ok(summary)
}

/// 封存当前集并开启下一集,不改变下一集的平台/朝向默认值(即继承)。
/// 保留原签名,供既有调用方(不关心平台默认值)使用。
pub fn archive_current(connection: &mut Connection, next_title: Option<&str>) -> Result<ArchiveOutcome> {
    archive_current_with_platform(connection, next_title, None, None)
}

/// 封存当前集并开启下一集。单事务;快照只增,可回查不可改。
///
/// `next_platform`/`next_orientation` 为 `None` 时,下一集继承被封存集当前的
/// `target_platform`/`canvas_orientation`;给出 `Some` 时按同一套枚举校验
/// (与 `platform::set_episode_platform` 共用 `validate_platform_and_orientation`),
/// 非法值使整个事务失败回滚——不建下一集,也不把当前集置为已封存。
pub fn archive_current_with_platform(
    connection: &mut Connection,
    next_title: Option<&str>,
    next_platform: Option<&str>,
    next_orientation: Option<&str>,
) -> Result<ArchiveOutcome> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let current_id: i64 = transaction
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::Story("没有处于进行中的集,无法封存".to_owned()))?;
    let current = summary_by_id(&transaction, current_id)?;
    if current.clip_count == 0 {
        return Err(CoreError::Story(
            "当前集还没有任何素材;空集不允许封存,可直接重命名继续使用".to_owned(),
        ));
    }
    let unfinished_imports: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM jobs
          WHERE kind = 'import_probe'
            AND status IN ('pending', 'running')
            AND json_extract(payload, '$.episode_id') = ?1",
        [current_id],
        |row| row.get(0),
    )?;
    if unfinished_imports > 0 {
        return Err(CoreError::Story(format!(
            "当前集还有 {unfinished_imports} 个导入任务未完成；请等待导入结束后再封存"
        )));
    }

    let archived_at: String = transaction.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [],
        |row| row.get(0),
    )?;
    transaction.execute(
        "UPDATE episodes
            SET status = 'archived', archived_at = ?2
          WHERE id = ?1",
        params![current_id, archived_at],
    )?;
    let snapshot = summary_by_id(&transaction, current_id)?;
    let summary_json = serde_json::to_string(&snapshot)
        .map_err(|error| CoreError::Story(format!("集快照序列化失败:{error}")))?;
    transaction.execute(
        "INSERT INTO episode_archives(episode_id, archived_at, summary_json)
         VALUES (?1, ?2, ?3)",
        params![current_id, archived_at, summary_json],
    )?;

    let next_number: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(episode_number), 0) + 1 FROM episodes",
        [],
        |row| row.get(0),
    )?;
    let default_title = format!("EP{next_number:02}");
    let title = next_title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&default_title);
    if title.chars().count() > 120 {
        return Err(CoreError::Story("集标题必须为 1-120 字".to_owned()));
    }

    // None → 继承被封存集当前值;Some → 按 platform 模块同一套枚举校验,
    // 非法值让整个事务失败(未提交,current 保持 active,next 不创建)。
    let platform = next_platform.unwrap_or(&current.target_platform);
    let orientation = next_orientation.unwrap_or(&current.canvas_orientation);
    super::platform::validate_platform_and_orientation(platform, orientation)?;

    transaction.execute(
        "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id,
                               target_platform, canvas_orientation)
         VALUES (?1, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'active', ?2,
                 lower(hex(randomblob(16))), ?3, ?4)",
        params![title, next_number, platform, orientation],
    )?;
    let next_id = transaction.last_insert_rowid();

    let archived = summary_by_id(&transaction, current_id)?;
    let next = summary_by_id(&transaction, next_id)?;
    transaction.commit()?;
    Ok(ArchiveOutcome { archived, next })
}

/// R10 U-16:「新建集」。名称必填(1-120 字)。
///
/// 集模型是「任意时刻恰好一个 active」,所以新建 = 把当前集封存、开一个新的
/// active 集并切换过去——与 `archive_current_with_platform` 同一条事务路径,
/// 平台/朝向继承当前集。唯一的差别:当前集**还没有任何素材**时,不留一个
/// 空档案(封存守卫本来就拒绝空集),而是直接把这个空集改成要的名字继续用
/// ——用户看到的结果一样是「一个叫这个名字的空集,处于进行中」。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CreateEpisodeOutcome {
    pub episode: EpisodeSummary,
    /// 当前集是空的、被就地改名复用(没有封存任何东西)。
    pub reused_empty: bool,
    /// 被封存的前一集(`reused_empty` 时为 `None`)。
    pub archived: Option<EpisodeSummary>,
}

pub fn create_episode(connection: &mut Connection, title: &str) -> Result<CreateEpisodeOutcome> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(CoreError::Story("集标题必须为 1-120 字".to_owned()));
    }
    let current = current_episode(connection)?;
    if current.clip_count == 0 {
        let episode = rename_current(connection, title, &current.theme)?;
        return Ok(CreateEpisodeOutcome { episode, reused_empty: true, archived: None });
    }
    let outcome = archive_current_with_platform(connection, Some(title), None, None)?;
    Ok(CreateEpisodeOutcome {
        episode: outcome.next,
        reused_empty: false,
        archived: Some(outcome.archived),
    })
}

/// 写操作守卫:素材必须属于当前进行中的集。
/// 历史集是只读档案——UI 会禁用写控件,但**后端必须独立校验**,
/// 不能把界面禁用当权限边界(回归测试覆盖该缺口)。
pub fn ensure_clip_writable(connection: &Connection, clip_id: i64) -> Result<()> {
    let owner: Option<Option<i64>> = connection
        .query_row(
            "SELECT episode_id FROM clips WHERE id = ?1",
            [clip_id],
            |row| row.get(0),
        )
        .optional()?;
    let active: Option<i64> = connection
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    // episode_id 为空的旧数据视为属于当前集(迁移前导入的素材)。
    match (owner, active) {
        (None, _) => Err(CoreError::Story(format!("素材 {clip_id} 不存在"))),
        (_, None) => Err(CoreError::Story("没有处于进行中的集;数据库状态异常".to_owned())),
        (Some(Some(owner_id)), Some(active_id)) if owner_id != active_id => Err(CoreError::Story(
            "该素材属于已封存的历史集,只读不可修改;请回到当前集操作".to_owned(),
        )),
        _ => Ok(()),
    }
}

/// 新导入素材归属:import 在建 clip 后调用。
pub fn assign_clip_to_current(connection: &Connection, clip_id: i64) -> Result<()> {
    let episode_id: i64 = connection
        .query_row(
            "SELECT id FROM episodes WHERE status = 'active'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Story("没有进行中的 Episode，无法归属素材".to_owned()))?;
    assign_clip_to_episode(connection, clip_id, episode_id)?;
    Ok(())
}

/// Import jobs pin ownership when they are queued. A delayed probe must never silently move
/// footage into whichever Episode happens to be active when the worker eventually runs.
pub fn assign_clip_to_episode(
    connection: &Connection,
    clip_id: i64,
    episode_id: i64,
) -> Result<()> {
    let exists: i64 = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM episodes WHERE id = ?1)",
        [episode_id],
        |row| row.get(0),
    )?;
    if exists != 1 {
        return Err(CoreError::Story(format!(
            "导入任务所属 Episode {episode_id} 已不存在"
        )));
    }
    connection.execute(
        "UPDATE clips SET episode_id = ?2 WHERE id = ?1 AND episode_id IS NULL",
        params![clip_id, episode_id],
    )?;
    let owner: Option<i64> = connection
        .query_row(
            "SELECT episode_id FROM clips WHERE id = ?1",
            [clip_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    match owner {
        Some(owner) if owner == episode_id => Ok(()),
        Some(_) => Err(CoreError::Story(
            "素材已属于另一个 Episode，不能更改历史归属".to_owned(),
        )),
        None => Err(CoreError::Story("素材不存在或没有 Episode 归属".to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn test_connection() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        (directory, connection)
    }

    fn insert_clip(connection: &Connection, name: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO volumes(uuid) SELECT 'vol-episode'
                 WHERE NOT EXISTS (SELECT 1 FROM volumes WHERE uuid='vol-episode')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den,
                                   duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                                   imported_at, episode_id)
                 VALUES ('vol-episode', ?1, 1, ?1, 1, 1000, 1000, 30, 1, 0, 'h264', 1920, 1080,
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         (SELECT id FROM episodes WHERE status='active'))",
                [name],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn migration_seeds_exactly_one_active_episode() {
        let (_dir, connection) = test_connection();
        let current = current_episode(&connection).unwrap();
        assert_eq!(current.status, "active");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn archive_rolls_to_next_active_and_keeps_snapshot() {
        let (_dir, mut connection) = test_connection();
        let first = current_episode(&connection).unwrap();
        insert_clip(&connection, "a.mp4");
        let outcome = archive_current(&mut connection, None).unwrap();
        assert_eq!(outcome.archived.id, first.id);
        assert_eq!(outcome.archived.status, "archived");
        assert!(outcome.archived.archived_at.is_some());
        assert_eq!(outcome.next.status, "active");
        assert_ne!(outcome.next.id, first.id);
        // 快照只增且可回查
        let archives: i64 = connection
            .query_row("SELECT COUNT(*) FROM episode_archives WHERE episode_id=?1", [first.id], |r| r.get(0))
            .unwrap();
        assert_eq!(archives, 1);
        let (snapshot_archived_at, summary_json): (String, String) = connection
            .query_row(
                "SELECT archived_at, summary_json FROM episode_archives WHERE episode_id=?1",
                [first.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&summary_json).unwrap();
        assert_eq!(snapshot["status"], "archived");
        assert_eq!(snapshot["archived_at"], snapshot_archived_at);
        // 旧素材仍属旧集,新导入落新集
        let new_clip = insert_clip(&connection, "b.mp4");
        let owner: i64 = connection
            .query_row("SELECT episode_id FROM clips WHERE id=?1", [new_clip], |r| r.get(0))
            .unwrap();
        assert_eq!(owner, outcome.next.id);
    }

    // ---- R10 U-16:新建集 ----

    #[test]
    fn create_episode_archives_a_non_empty_current_and_switches_to_the_new_one() {
        let (_dir, mut connection) = test_connection();
        let first = current_episode(&connection).unwrap();
        insert_clip(&connection, "a.mp4");
        let outcome = create_episode(&mut connection, "  多伦多两日  ").unwrap();
        assert!(!outcome.reused_empty);
        assert_eq!(outcome.episode.title, "多伦多两日");
        assert_eq!(outcome.episode.status, "active");
        assert_eq!(outcome.episode.clip_count, 0);
        assert_ne!(outcome.episode.id, first.id);
        assert_eq!(outcome.archived.as_ref().map(|e| e.id), Some(first.id));
        assert_eq!(current_episode(&connection).unwrap().id, outcome.episode.id);
        let active: i64 = connection
            .query_row("SELECT COUNT(*) FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(active, 1);
    }

    #[test]
    fn create_episode_reuses_an_empty_current_episode_in_place() {
        let (_dir, mut connection) = test_connection();
        let first = current_episode(&connection).unwrap();
        let outcome = create_episode(&mut connection, "新集").unwrap();
        assert!(outcome.reused_empty);
        assert!(outcome.archived.is_none());
        assert_eq!(outcome.episode.id, first.id);
        assert_eq!(outcome.episode.title, "新集");
        let archives: i64 = connection
            .query_row("SELECT COUNT(*) FROM episode_archives", [], |r| r.get(0))
            .unwrap();
        assert_eq!(archives, 0, "空集不留空档案");
    }

    #[test]
    fn create_episode_requires_a_title() {
        let (_dir, mut connection) = test_connection();
        insert_clip(&connection, "a.mp4");
        let error = create_episode(&mut connection, "   ").unwrap_err();
        assert!(error.to_string().contains("集标题"));
        assert_eq!(current_episode(&connection).unwrap().clip_count, 1, "失败不改当前集");
    }

    /// 走查 U-16「0 素材」:后端计数是 COUNT(*) 现算,导入后立刻就是 21——
    /// 「0」来自前端只在挂载时刷新一次的缓存,不是后端。
    #[test]
    fn episode_clip_count_is_live() {
        let (_dir, connection) = test_connection();
        assert_eq!(current_episode(&connection).unwrap().clip_count, 0);
        insert_clip(&connection, "a.mp4");
        insert_clip(&connection, "b.mp4");
        assert_eq!(current_episode(&connection).unwrap().clip_count, 2);
        assert_eq!(list_episodes(&connection).unwrap()[0].clip_count, 2);
    }

    #[test]
    fn episode_memory_identity_and_export_counts_use_explicit_ownership() {
        let (_dir, mut connection) = test_connection();
        let first = current_episode(&connection).unwrap();
        let first_memory_id: String = connection
            .query_row(
                "SELECT memory_id FROM episodes WHERE id = ?1",
                [first.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first_memory_id.len(), 32);
        insert_clip(&connection, "first.mov");
        connection
            .execute(
                "INSERT INTO exports(tier, manifest, created_at, output_path, episode_id)
                 VALUES ('stable_package', '{}', '2099-01-01T00:00:00Z', '/same/path', ?1)",
                [first.id],
            )
            .unwrap();

        let outcome = archive_current(&mut connection, None).unwrap();
        connection
            .execute(
                "INSERT INTO exports(tier, manifest, created_at, output_path, episode_id)
                 VALUES ('stable_package', '{}', '2000-01-01T00:00:00Z', '/same/path', ?1)",
                [outcome.next.id],
            )
            .unwrap();
        let next_memory_id: String = connection
            .query_row(
                "SELECT memory_id FROM episodes WHERE id = ?1",
                [outcome.next.id],
                |row| row.get(0),
            )
            .unwrap();

        assert_ne!(first_memory_id, next_memory_id);
        assert_eq!(summary_by_id(&connection, first.id).unwrap().export_count, 1);
        assert_eq!(
            summary_by_id(&connection, outcome.next.id)
                .unwrap()
                .export_count,
            1
        );
    }

    #[test]
    fn favorite_count_excludes_rejected_binary_ratings() {
        let (_dir, mut connection) = test_connection();
        let favorite = insert_clip(&connection, "favorite.mov");
        let rejected = insert_clip(&connection, "rejected.mov");
        crate::core::ratings::rate_clip(&mut connection, favorite, "binary", 1).unwrap();
        crate::core::ratings::rate_clip(&mut connection, rejected, "binary", -1).unwrap();

        assert_eq!(current_episode(&connection).unwrap().favorite_count, 1);
    }

    #[test]
    fn favorite_count_tracks_latest_binary_state_per_clip() {
        let (_dir, mut connection) = test_connection();
        let clip = insert_clip(&connection, "state.mov");

        crate::core::ratings::rate_clip(&mut connection, clip, "binary", 1).unwrap();
        assert_eq!(current_episode(&connection).unwrap().favorite_count, 1);
        crate::core::ratings::rate_clip(&mut connection, clip, "binary", -1).unwrap();
        assert_eq!(current_episode(&connection).unwrap().favorite_count, 0);
        crate::core::ratings::rate_clip(&mut connection, clip, "binary", 1).unwrap();
        crate::core::ratings::rate_clip(&mut connection, clip, "binary", 1).unwrap();
        assert_eq!(current_episode(&connection).unwrap().favorite_count, 1);
        crate::core::ratings::clear_clip_rating(&mut connection, clip).unwrap();
        assert_eq!(current_episode(&connection).unwrap().favorite_count, 0);
    }

    #[test]
    fn favorite_count_counts_live_selects_once_and_ignores_tombstones() {
        let (_dir, mut connection) = test_connection();
        let clip = insert_clip(&connection, "segments.mov");
        let first = crate::core::ratings::create_select_segment(&mut connection, clip, 0.1, 0.2).unwrap();
        let second = crate::core::ratings::create_select_segment(&mut connection, clip, 0.3, 0.4).unwrap();
        assert_eq!(current_episode(&connection).unwrap().favorite_count, 1);
        crate::core::ratings::delete_select_segment(&mut connection, first.id).unwrap();
        assert_eq!(current_episode(&connection).unwrap().favorite_count, 1);
        crate::core::ratings::delete_select_segment(&mut connection, second.id).unwrap();
        assert_eq!(current_episode(&connection).unwrap().favorite_count, 0);
    }

    #[test]
    fn empty_episode_refuses_to_archive() {
        let (_dir, mut connection) = test_connection();
        let error = archive_current(&mut connection, None).unwrap_err();
        assert!(error.to_string().contains("空集"));
    }

    #[test]
    fn episode_with_unfinished_import_refuses_to_archive() {
        let (_dir, mut connection) = test_connection();
        insert_clip(&connection, "queued.mov");
        let current = current_episode(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO jobs(kind, payload, payload_hash, status, attempt,
                                  next_attempt_at, created_at, updated_at)
                 VALUES ('import_probe', ?1, 'queued-import', 'pending', 0,
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                [format!(r#"{{"path":"/tmp/queued.mov","episode_id":{}}}"#, current.id)],
            )
            .unwrap();

        let error = archive_current(&mut connection, None).unwrap_err();
        assert!(error.to_string().contains("导入任务未完成"));
        assert_eq!(current_episode(&connection).unwrap().id, current.id);
    }

    #[test]
    fn archived_episode_clips_are_refused_for_writes() {
        let (_d, mut connection) = test_connection();
        let old_clip = insert_clip(&connection, "old.mov");
        // 封存后旧素材应被写守卫拒绝
        archive_current(&mut connection, None).unwrap();
        let error = ensure_clip_writable(&connection, old_clip).unwrap_err();
        assert!(error.to_string().contains("历史集"));
        // 新集里的素材照常可写
        let new_clip = insert_clip(&connection, "new.mov");
        assert!(ensure_clip_writable(&connection, new_clip).is_ok());
    }

    #[test]
    fn archived_episode_select_segment_delete_and_restore_are_refused() {
        let (_d, mut connection) = test_connection();
        let old_clip = insert_clip(&connection, "old-select.mov");
        let segment =
            crate::core::ratings::create_select_segment(&mut connection, old_clip, 0.1, 0.2).unwrap();
        archive_current(&mut connection, None).unwrap();

        let delete_error =
            crate::core::ratings::delete_select_segment(&mut connection, segment.id).unwrap_err();
        assert!(delete_error.to_string().contains("历史集"));

        let restore_error =
            crate::core::ratings::restore_select_segment(&mut connection, segment.id).unwrap_err();
        assert!(restore_error.to_string().contains("历史集"));
    }

    #[test]
    fn archive_with_none_platform_inherits_archived_episodes_values() {
        let (_dir, mut connection) = test_connection();
        let current = current_episode(&connection).unwrap();
        crate::core::platform::set_episode_platform(&mut connection, current.id, "bilibili", "portrait")
            .unwrap();
        insert_clip(&connection, "a.mp4");
        let outcome = archive_current_with_platform(&mut connection, None, None, None).unwrap();
        assert_eq!(outcome.archived.target_platform, "bilibili");
        assert_eq!(outcome.archived.canvas_orientation, "portrait");
        assert_eq!(outcome.next.target_platform, "bilibili");
        assert_eq!(outcome.next.canvas_orientation, "portrait");
    }

    #[test]
    fn archive_with_some_platform_applies_the_given_values() {
        let (_dir, mut connection) = test_connection();
        insert_clip(&connection, "a.mp4");
        let outcome =
            archive_current_with_platform(&mut connection, None, Some("douyin"), Some("portrait"))
                .unwrap();
        assert_eq!(outcome.next.target_platform, "douyin");
        assert_eq!(outcome.next.canvas_orientation, "portrait");
    }

    #[test]
    fn archive_with_invalid_platform_errors_and_archives_nothing() {
        let (_dir, mut connection) = test_connection();
        let current = current_episode(&connection).unwrap();
        insert_clip(&connection, "a.mp4");
        let error =
            archive_current_with_platform(&mut connection, None, Some("youtube"), None).unwrap_err();
        assert!(error.to_string().contains("目标平台"));
        // 事务整体回滚:当前集仍是 active,没有新集,没有快照
        let still_current = current_episode(&connection).unwrap();
        assert_eq!(still_current.id, current.id);
        assert_eq!(still_current.status, "active");
        let episode_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM episodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(episode_count, 1);
        let archive_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM episode_archives", [], |r| r.get(0))
            .unwrap();
        assert_eq!(archive_count, 0);
    }

    #[test]
    fn archive_with_invalid_orientation_errors_and_archives_nothing() {
        let (_dir, mut connection) = test_connection();
        insert_clip(&connection, "a.mp4");
        let error =
            archive_current_with_platform(&mut connection, None, Some("douyin"), Some("sideways"))
                .unwrap_err();
        assert!(error.to_string().contains("画布朝向"));
        let episode_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM episodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(episode_count, 1);
    }

    #[test]
    fn assign_clip_refuses_to_steal_existing_ownership() {
        let (_dir, mut connection) = test_connection();
        let clip = insert_clip(&connection, "c.mp4");
        let before = current_episode(&connection).unwrap();
        insert_clip(&connection, "keep.mp4");
        archive_current(&mut connection, Some("EP-Next")).unwrap();
        // 已归属素材不被抢走
        let error = assign_clip_to_current(&connection, clip).unwrap_err();
        assert!(error.to_string().contains("另一个 Episode"));
        let owner: i64 = connection
            .query_row("SELECT episode_id FROM clips WHERE id=?1", [clip], |r| r.get(0))
            .unwrap();
        assert_eq!(owner, before.id);
    }
}
