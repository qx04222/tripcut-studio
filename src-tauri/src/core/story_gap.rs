//! R7 Task 2：故事缺口检测（纯 Rust，无 LLM）。
//!
//! 判定：活跃修订（confirmed 优先，否则最新 suggested）里，每个章节计划到的槽位
//! （`narrative_chapters.story_slots_json`）若落在可生成白名单里，且本章下
//! `narrative_beats` 挂的真实素材（`clips.generated_source IS NULL`）里没有一条
//! 被 `clip_dimensions(dimension='function')` 判为对应画面功能类型，就是缺口。
//! `DH INTRO`/`DH OVERLAY`/`MAP`/`REAL/HUMAN`/`REAL/EXPERIENCE` 不在白名单里，
//! 永不产生缺口行——数字人与地图由既有管线负责，人物/体验镜头生成出来是假的
//! 旅行记录。
//!
//! 幂等：`UNIQUE(chapter_id, slot)`。重跑只在 `status='open'` 时刷新 `reason`/
//! `updated_at`；已 `requested`/`filled`/`dismissed` 的行永不被检测器自动改回
//! `open`。缺口不再成立（真实素材补上了）时把 `open` 行置为 `dismissed`。
//! 因为 `chapter_id` 本身是修订内的行（每次新建 confirmed/suggested 都是新
//! id），换修订会自然产生新的 (chapter_id, slot) 组合，不需要额外的"重新打开"
//! 逻辑。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::error::{CoreError, Result};
use super::narrative::STORY_SLOTS;
use super::narrative_revision::active_revision_id;

/// 可生成的槽位白名单：只有这四种允许云端补镜；其余槽位（DH/MAP/人物/体验）
/// 根本不产生缺口行。
pub const GENERATABLE_SLOTS: [&str; 4] =
    ["REAL/ESTABLISHING", "REAL/DETAIL", "ATMOSPHERE", "TRANSITION"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GenerationRequestSummary {
    pub id: i64,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StoryGap {
    pub id: i64,
    /// `narrative_chapters.id`(叙事章)。**不是**镜头带用的 D2 `chapters.id`。
    pub chapter_id: i64,
    /// R10(车道 D 发现的 ID 空间碰撞):这个缺口应挂在镜头带的哪一章——D2
    /// `chapters.id`,按本叙事章 beats 所指素材的 `clips.chapter_id` 多数决(平手取
    /// 小 id);叙事章没有 beat、或素材都没分章时为 `None`。带上匹配请用它,别用
    /// `chapter_id`——两张表的 id 相等只是巧合。
    pub band_chapter_id: Option<i64>,
    pub chapter_title: String,
    pub beat_id: Option<i64>,
    pub slot: String,
    pub slot_label_zh: String,
    pub reason: String,
    pub status: String,
    pub latest_request: Option<GenerationRequestSummary>,
}

fn slot_label_zh(slot: &str) -> &'static str {
    match slot {
        "DH INTRO" => "数字人开场",
        "MAP" => "地图",
        "REAL/ESTABLISHING" => "建立镜头",
        "REAL/EXPERIENCE" => "体验镜头",
        "REAL/DETAIL" => "细节镜头",
        "DH OVERLAY" => "数字人插播",
        "REAL/HUMAN" => "人物镜头",
        "ATMOSPHERE" => "氛围镜头",
        "TRANSITION" => "转场镜头",
        _ => "未知槽位",
    }
}

/// `clip_dimensions(dimension='function')` 的英文标签，用于 reason 里指名"没
/// 有一条被判为 XXX"。
fn function_label_for_slot(slot: &str) -> &'static str {
    match slot {
        "REAL/ESTABLISHING" => "Establishing",
        "REAL/DETAIL" => "Detail",
        "ATMOSPHERE" => "Atmosphere",
        "TRANSITION" => "Transition",
        _ => "",
    }
}

/// 反向映射：真实素材的画面功能标签落在哪个 slot 上，判定"覆盖"。
fn slot_for_function_label(label: &str) -> Option<&'static str> {
    match label {
        // Orientation 与 Establishing 同组:见 narrative.rs 的 `is_establishing`。
        "Establishing" | "Orientation" => Some("REAL/ESTABLISHING"),
        "Detail" => Some("REAL/DETAIL"),
        "Atmosphere" => Some("ATMOSPHERE"),
        "Transition" => Some("TRANSITION"),
        // Experience/Human-Reaction/Information 不在可生成白名单里,真实素材
        // 打这些标签不算覆盖任何缺口槽位(它们本就不产生缺口)。
        "Experience" | "Human-Reaction" | "Information" => None,
        _ => None,
    }
}

fn active_episode_id(connection: &Connection) -> Result<Option<i64>> {
    connection
        .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
        .optional()
        .map_err(Into::into)
}

fn now_string(connection: &Connection) -> Result<String> {
    connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| row.get(0))
        .map_err(Into::into)
}

fn parse_slots(json: &str) -> Result<Vec<String>> {
    serde_json::from_str(json)
        .map_err(|error| CoreError::InvalidSchema(format!("story_slots_json 无效：{error}")))
}

/// 只支持单集活跃场景；封存集里的缺口不检测。没有活跃集或活跃修订时是 no-op。
///
/// 返回值：跑完这一轮后，全库处于 `open` 状态的缺口总数（供调用方判断是否需要
/// 在界面上提示"有新缺口"；具体差异由调用方在写入前后各查一次 `list()` 自行
/// diff，这里只给一个廉价的汇总数）。
pub fn detect(connection: &mut Connection) -> Result<usize> {
    let Some(episode_id) = active_episode_id(connection)? else {
        return Ok(0);
    };
    let Some(revision_id) = active_revision_id(connection, episode_id)? else {
        return Ok(0);
    };

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now_string(&transaction)?;

    struct ChapterRow {
        id: i64,
        title: String,
        order: i64,
        story_slots_json: String,
    }
    let chapters = {
        let mut statement = transaction.prepare(
            "SELECT id, title, \"order\", story_slots_json
               FROM narrative_chapters WHERE revision_id = ?1",
        )?;
        let rows = statement
            .query_map([revision_id], |row| {
                Ok(ChapterRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    order: row.get(2)?,
                    story_slots_json: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };

    for chapter in chapters {
        let planned = match parse_slots(&chapter.story_slots_json) {
            Ok(planned) => planned,
            Err(error) => {
                // 单个章节的 story_slots_json 结构损坏不该让整集检测失败;跳过
                // 这一章,继续处理本集其余章节。
                tracing::warn!(
                    chapter_id = chapter.id,
                    %error,
                    "story_slots_json 无法解析,跳过该章节的缺口检测"
                );
                continue;
            }
        };
        let generatable: Vec<&str> = STORY_SLOTS
            .iter()
            .copied()
            .filter(|slot| GENERATABLE_SLOTS.contains(slot) && planned.iter().any(|p| p == slot))
            .collect();
        if generatable.is_empty() {
            continue;
        }

        let mut covered = std::collections::BTreeSet::new();
        let mut real_clip_count: i64 = 0;
        {
            let mut statement = transaction.prepare(
                "SELECT function.label
                   FROM narrative_beats beat
                   JOIN clips c ON c.id = beat.clip_id
                   LEFT JOIN clip_dimensions function
                     ON function.clip_id = c.id AND function.dimension = 'function'
                  WHERE beat.chapter_id = ?1 AND c.generated_source IS NULL",
            )?;
            let rows = statement.query_map([chapter.id], |row| row.get::<_, Option<String>>(0))?;
            for row in rows {
                real_clip_count += 1;
                if let Some(label) = row? {
                    if let Some(slot) = slot_for_function_label(&label) {
                        covered.insert(slot);
                    }
                }
            }
        }

        for slot in &generatable {
            if covered.contains(slot) {
                let reason = format!(
                    "第 {} 章《{}》计划的{}已由本章真实素材覆盖，缺口自动关闭。覆盖判定只看精选/点赞的素材，未经筛选的素材不计入。",
                    chapter.order + 1,
                    chapter.title,
                    slot_label_zh(slot)
                );
                transaction.execute(
                    "UPDATE story_gaps SET status = 'dismissed', reason = ?1, updated_at = ?2
                      WHERE chapter_id = ?3 AND slot = ?4 AND status = 'open'",
                    params![reason, now, chapter.id, slot],
                )?;
            } else {
                let reason = format!(
                    "第 {} 章《{}》计划了{}，但本章 {} 条素材里没有一条被判为 {}。覆盖判定只看精选/点赞的素材，未经筛选的素材不计入。",
                    chapter.order + 1,
                    chapter.title,
                    slot_label_zh(slot),
                    real_clip_count,
                    function_label_for_slot(slot)
                );
                transaction.execute(
                    "INSERT INTO story_gaps(
                        episode_id, revision_id, chapter_id, beat_id, slot, reason,
                        status, detected_at, updated_at
                     ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'open', ?6, ?6)
                     ON CONFLICT(chapter_id, slot) DO UPDATE SET
                        reason = excluded.reason,
                        updated_at = excluded.updated_at,
                        revision_id = excluded.revision_id
                     WHERE story_gaps.status = 'open'",
                    params![episode_id, revision_id, chapter.id, slot, reason, now],
                )?;
            }
        }
    }

    // 收口:本集里挂在非活跃修订(旧 suggested/被替换的 confirmed)上的缺口行
    // 不该无限期停留。有请求历史(requested/filled)的必须保留审计痕迹,只改
    // 状态并写明原因;从未被请求过的 open 行没有历史可留,直接删除。
    let stale_reason = "所属修订已被更替，缺口随旧修订失效。";
    transaction.execute(
        "UPDATE story_gaps SET status = 'dismissed', reason = ?1, updated_at = ?2
          WHERE episode_id = ?3 AND revision_id != ?4 AND status IN ('requested', 'filled')",
        params![stale_reason, now, episode_id, revision_id],
    )?;
    transaction.execute(
        "DELETE FROM story_gaps
          WHERE episode_id = ?1 AND revision_id != ?2 AND status = 'open'",
        params![episode_id, revision_id],
    )?;

    transaction.commit()?;
    let open_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM story_gaps WHERE status = 'open' AND episode_id = ?1",
        [episode_id],
        |row| row.get(0),
    )?;
    Ok(open_count as usize)
}

/// 当前活跃集的所有缺口（不限状态），按章节顺序、槽位排序。
pub fn list(connection: &Connection) -> Result<Vec<StoryGap>> {
    let Some(episode_id) = active_episode_id(connection)? else {
        return Ok(Vec::new());
    };
    let Some(revision_id) = active_revision_id(connection, episode_id)? else {
        return Ok(Vec::new());
    };
    let mut statement = connection.prepare(
        "SELECT g.id, g.chapter_id, c.title, g.beat_id, g.slot, g.reason, g.status,
                r.id, r.status, r.error,
                (SELECT clip.chapter_id
                   FROM narrative_beats beat
                   JOIN clips clip ON clip.id = beat.clip_id
                  WHERE beat.chapter_id = g.chapter_id AND clip.chapter_id IS NOT NULL
                  GROUP BY clip.chapter_id
                  ORDER BY COUNT(*) DESC, clip.chapter_id
                  LIMIT 1)
           FROM story_gaps g
           JOIN narrative_chapters c ON c.id = g.chapter_id
           LEFT JOIN generation_requests r ON r.id = (
               SELECT id FROM generation_requests
                WHERE gap_id = g.id ORDER BY id DESC LIMIT 1
           )
          WHERE g.episode_id = ?1 AND g.revision_id = ?2
          ORDER BY c.\"order\", g.slot",
    )?;
    let rows = statement
        .query_map(params![episode_id, revision_id], |row| {
            let slot: String = row.get(4)?;
            let request_id: Option<i64> = row.get(7)?;
            let latest_request = request_id.map(|id| GenerationRequestSummary {
                id,
                status: row.get(8).unwrap_or_default(),
                error: row.get(9).unwrap_or_default(),
            });
            Ok(StoryGap {
                id: row.get(0)?,
                chapter_id: row.get(1)?,
                band_chapter_id: row.get(10)?,
                chapter_title: row.get(2)?,
                beat_id: row.get(3)?,
                slot_label_zh: slot_label_zh(&slot).to_owned(),
                slot,
                reason: row.get(5)?,
                status: row.get(6)?,
                latest_request,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 业主手动忽略一个缺口；不再被检测器重新打开（除非明确 `reopen`）。
pub fn dismiss(connection: &mut Connection, gap_id: i64) -> Result<()> {
    let now = now_string(connection)?;
    let changed = connection.execute(
        "UPDATE story_gaps SET status = 'dismissed', updated_at = ?2 WHERE id = ?1",
        params![gap_id, now],
    )?;
    if changed == 0 {
        return Err(CoreError::StoryGap(format!("缺口 {gap_id} 不存在")));
    }
    Ok(())
}

/// 业主手动恢复一个已忽略的缺口，使其重新可被"生成候选"。
pub fn reopen(connection: &mut Connection, gap_id: i64) -> Result<()> {
    let now = now_string(connection)?;
    let changed = connection.execute(
        "UPDATE story_gaps SET status = 'open', updated_at = ?2
          WHERE id = ?1 AND status = 'dismissed'",
        params![gap_id, now],
    )?;
    if changed == 0 {
        return Err(CoreError::StoryGap(format!(
            "缺口 {gap_id} 不存在或不是已忽略状态，无法重新打开"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn setup() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('sg')", []).unwrap();
        (directory, connection)
    }

    fn insert_clip(connection: &Connection, name: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, duration_ticks, tb_num, tb_den)
                 VALUES ('sg', ?1, 1000, 1, 1000)",
                [name],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn tag_function(connection: &Connection, clip_id: i64, label: &str) {
        connection
            .execute(
                "INSERT INTO clip_dimensions(clip_id, dimension, label, score, source)
                 VALUES (?1, 'function', ?2, 0.9, 'test')",
                params![clip_id, label],
            )
            .unwrap();
    }

    /// 造一个 suggested revision:一个章节，规划的 story_slots 由调用方传入；
    /// 章节下按 (clip_name, Option<function_label>) 列表插入 beat。返回
    /// (episode_id, chapter_id)。
    fn seed_chapter(
        connection: &Connection,
        story_slots: &[&str],
        clips: &[(&str, Option<&str>)],
    ) -> (i64, i64) {
        let episode: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        connection
            .execute(
                "INSERT INTO narrative_revisions(episode_id, kind, created_at)
                 VALUES (?1, 'suggested', 'now')",
                [episode],
            )
            .unwrap();
        let revision = connection.last_insert_rowid();
        let slots_json = serde_json::to_string(story_slots).unwrap();
        connection
            .execute(
                "INSERT INTO narrative_chapters(
                    episode_id, kind, title, \"order\", promoted, score, rationale,
                    promotion_reason, story_slots_json, missing_slots_json, dh_plan_json, revision_id)
                 VALUES (?1, 'journey', '黑石峡谷', 0, 0, 0.8, 'r', '', ?2, '[]', 'null', ?3)",
                params![episode, slots_json, revision],
            )
            .unwrap();
        let chapter = connection.last_insert_rowid();
        for (order, (name, function_label)) in clips.iter().enumerate() {
            let clip_id = insert_clip(connection, name);
            if let Some(label) = function_label {
                tag_function(connection, clip_id, label);
            }
            connection
                .execute(
                    "INSERT INTO narrative_beats(chapter_id, clip_id, role, \"order\", score, rationale)
                     VALUES (?1, ?2, 'beat', ?3, 0.8, 'r')",
                    params![chapter, clip_id, order as i64],
                )
                .unwrap();
        }
        (episode, chapter)
    }

    /// R10 ID 空间碰撞:叙事章 id 与 D2 章 id 不相等时,缺口要挂到 beats 所指素材的
    /// D2 章上;没 beat 的叙事章 → None。
    #[test]
    fn gap_carries_the_band_chapter_id_resolved_through_its_beats() {
        let (_d, mut connection) = setup();
        let episode: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |r| r.get(0))
            .unwrap();
        // 先占掉 narrative_chapters 的低位 id,让两套 id 错开:叙事章将是 3,D2 章是 1/2。
        connection
            .execute(
                "INSERT INTO narrative_revisions(episode_id, kind, created_at) VALUES (?1, 'suggested', 'old')",
                [episode],
            )
            .unwrap();
        let old_revision = connection.last_insert_rowid();
        for order in 0..2 {
            connection
                .execute(
                    "INSERT INTO narrative_chapters(
                        episode_id, kind, title, \"order\", promoted, score, rationale,
                        promotion_reason, story_slots_json, missing_slots_json, dh_plan_json, revision_id)
                     VALUES (?1, 'journey', 'old', ?2, 0, 0.5, 'r', '', '[]', '[]', 'null', ?3)",
                    params![episode, order, old_revision],
                )
                .unwrap();
        }
        for (id, title) in [(1, "第1段"), (2, "第2段")] {
            connection
                .execute(
                    "INSERT INTO chapters(id, title, start_at, end_at, episode_id)
                     VALUES (?1, ?2, '2026-09-13T14:40:00Z', '2026-09-13T14:41:00Z', ?3)",
                    params![id, title, episode],
                )
                .unwrap();
        }
        let (_episode, narrative_chapter) = seed_chapter(
            &connection,
            &["REAL/ESTABLISHING"],
            &[("a.mov", None), ("b.mov", None), ("c.mov", None)],
        );
        assert!(narrative_chapter > 2, "夹具前提:叙事章 id 必须与 D2 章 id 错开");
        // 三条 beat 素材:两条在 D2 章 2,一条在章 1 → 多数决 2。
        connection
            .execute("UPDATE clips SET chapter_id = 2 WHERE rel_path IN ('a.mov', 'b.mov')", [])
            .unwrap();
        connection
            .execute("UPDATE clips SET chapter_id = 1 WHERE rel_path = 'c.mov'", [])
            .unwrap();
        detect(&mut connection).unwrap();
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].chapter_id, narrative_chapter);
        assert_eq!(gaps[0].band_chapter_id, Some(2));
        assert_ne!(gaps[0].band_chapter_id, Some(gaps[0].chapter_id));

        // 素材全部没分章 → None(带上不该凭 chapter_id 乱挂)。
        connection.execute("UPDATE clips SET chapter_id = NULL", []).unwrap();
        assert_eq!(list(&connection).unwrap()[0].band_chapter_id, None);
    }

    #[test]
    fn dh_map_and_human_slots_never_produce_gaps() {
        let (_d, mut connection) = setup();
        let all_slots: Vec<&str> = STORY_SLOTS.to_vec();
        let (_episode, _chapter) = seed_chapter(&connection, &all_slots, &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 4, "只应出 4 条可生成缺口: {gaps:?}");
        for forbidden in ["DH INTRO", "DH OVERLAY", "MAP", "REAL/HUMAN", "REAL/EXPERIENCE"] {
            assert!(
                gaps.iter().all(|g| g.slot != forbidden),
                "{forbidden} 不应产生缺口"
            );
        }
        for slot in GENERATABLE_SLOTS {
            assert!(gaps.iter().any(|g| g.slot == slot), "缺少 {slot} 的缺口行");
            assert_eq!(gaps.iter().find(|g| g.slot == slot).unwrap().status, "open");
        }
    }

    #[test]
    fn reason_names_the_chapter_and_the_slot() {
        let (_d, mut connection) = setup();
        seed_chapter(&connection, &["REAL/ESTABLISHING"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1);
        assert!(gaps[0].reason.contains("黑石峡谷"));
        assert!(gaps[0].reason.contains("建立镜头"));
    }

    #[test]
    fn detect_is_idempotent_and_does_not_reopen_requested_gaps() {
        let (_d, mut connection) = setup();
        seed_chapter(&connection, &["ATMOSPHERE", "TRANSITION"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        let first = list(&connection).unwrap();
        assert_eq!(first.len(), 2);

        detect(&mut connection).unwrap();
        let second = list(&connection).unwrap();
        assert_eq!(second.len(), 2, "重跑不应新增或删除行");

        // 手动把一行推进到 requested,再跑一次不能被打回 open。
        let gap_id = first[0].id;
        connection
            .execute("UPDATE story_gaps SET status = 'requested' WHERE id = ?1", [gap_id])
            .unwrap();
        detect(&mut connection).unwrap();
        let after: String = connection
            .query_row("SELECT status FROM story_gaps WHERE id = ?1", [gap_id], |r| r.get(0))
            .unwrap();
        assert_eq!(after, "requested");
    }

    #[test]
    fn gap_closes_when_a_real_clip_covers_the_slot() {
        let (_d, mut connection) = setup();
        let (_episode, chapter) =
            seed_chapter(&connection, &["REAL/ESTABLISHING"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        assert_eq!(list(&connection).unwrap()[0].status, "open");

        let clip_id = insert_clip(&connection, "b.mov");
        tag_function(&connection, clip_id, "Establishing");
        connection
            .execute(
                "INSERT INTO narrative_beats(chapter_id, clip_id, role, \"order\", score, rationale)
                 VALUES (?1, ?2, 'beat', 1, 0.8, 'r')",
                params![chapter, clip_id],
            )
            .unwrap();
        detect(&mut connection).unwrap();
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].status, "dismissed");
    }

    #[test]
    fn generated_clip_alone_does_not_close_a_gap_by_itself() {
        let (_d, mut connection) = setup();
        let (_episode, chapter) =
            seed_chapter(&connection, &["REAL/ESTABLISHING"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        assert_eq!(list(&connection).unwrap()[0].status, "open");

        let clip_id = insert_clip(&connection, "gen.mov");
        tag_function(&connection, clip_id, "Establishing");
        connection
            .execute("UPDATE clips SET generated_source = 'minimax' WHERE id = ?1", [clip_id])
            .unwrap();
        connection
            .execute(
                "INSERT INTO narrative_beats(chapter_id, clip_id, role, \"order\", score, rationale)
                 VALUES (?1, ?2, 'beat', 1, 0.8, 'r')",
                params![chapter, clip_id],
            )
            .unwrap();
        detect(&mut connection).unwrap();
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].status, "open", "生成片不能替检测器自动收口");
    }

    #[test]
    fn dismiss_persists_across_rerun() {
        let (_d, mut connection) = setup();
        seed_chapter(&connection, &["ATMOSPHERE"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        let gap_id = list(&connection).unwrap()[0].id;
        dismiss(&mut connection, gap_id).unwrap();
        detect(&mut connection).unwrap();
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].status, "dismissed");
    }

    #[test]
    fn new_revision_reopens_the_gap() {
        let (_d, mut connection) = setup();
        let (episode, _chapter) =
            seed_chapter(&connection, &["ATMOSPHERE"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        let gap_id = list(&connection).unwrap()[0].id;
        dismiss(&mut connection, gap_id).unwrap();

        // 再造一版 suggested(比如重跑 AI):同一集,同样规划,新的 chapter 行。
        seed_chapter(&connection, &["ATMOSPHERE"], &[("z.mov", None)]);
        // active_revision_id 取最新的 suggested。detect() 之后 list() 只应看到
        // 新修订上的缺口——旧修订已被超越,不该再列出来(哪怕它当年是被手动
        // dismiss 掉的,不属于本轮 detect() 的收口范围,但 list() 按活跃修订过滤)。
        detect(&mut connection).unwrap();
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1, "list() 不应再看到旧修订的缺口行: {gaps:?}");
        assert_eq!(gaps[0].status, "open", "新修订上的缺口应是 open");
        let _ = episode;
    }

    /// FINDING 1: 重命名章节会新建一版 confirmed revision(深拷贝旧章节+beat)。
    /// 旧 suggested 修订上从未被请求过的 open 缺口行,应在新一轮 detect() 里被
    /// 直接删除(没有请求历史,不需要留痕);list() 只应看到新修订上的一条缺口。
    #[test]
    fn renaming_a_chapter_creates_a_new_revision_and_stale_open_gap_is_gone() {
        let (_d, mut connection) = setup();
        let (episode, chapter) =
            seed_chapter(&connection, &["ATMOSPHERE"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        let before = list(&connection).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].status, "open");

        // 重命名章节 -> 深拷贝出 confirmed revision,apply_op 内部会自动重跑 detect()。
        crate::core::narrative_revision::apply_op(
            &mut connection,
            episode,
            crate::core::narrative_revision::NarrativeOp::RenameChapter {
                chapter_id: chapter,
                title: "新名字".to_owned(),
            },
        )
        .unwrap();

        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1, "不应同时看到旧修订与新修订的缺口: {gaps:?}");
        assert_eq!(gaps[0].status, "open");
        assert_eq!(gaps[0].chapter_title, "新名字", "应是 confirmed 版章节的缺口");

        // 旧 suggested 版上的行(从未被请求过)应已被删除,不是仅仅列表过滤掉。
        let total: i64 =
            connection.query_row("SELECT COUNT(*) FROM story_gaps", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1, "从未被请求过的旧修订缺口应被删除,而不是留着");
    }

    /// FINDING 1: 若旧修订上的缺口已经有过请求历史(requested/filled),换修订时
    /// 不能删除它——必须保留审计痕迹,只把状态改成 dismissed 并写明原因。
    #[test]
    fn stale_gap_with_request_history_is_dismissed_not_deleted() {
        let (_d, mut connection) = setup();
        let (episode, chapter) =
            seed_chapter(&connection, &["ATMOSPHERE"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        let gap_id = list(&connection).unwrap()[0].id;
        connection
            .execute("UPDATE story_gaps SET status = 'requested' WHERE id = ?1", [gap_id])
            .unwrap();

        crate::core::narrative_revision::apply_op(
            &mut connection,
            episode,
            crate::core::narrative_revision::NarrativeOp::RenameChapter {
                chapter_id: chapter,
                title: "新名字2".to_owned(),
            },
        )
        .unwrap();

        let (status, reason): (String, String) = connection
            .query_row(
                "SELECT status, reason FROM story_gaps WHERE id = ?1",
                [gap_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "dismissed", "有请求历史的旧缺口要保留审计痕迹,不能删除");
        assert!(reason.contains("修订"), "reason 应说明是因为修订更替: {reason}");

        // list() 仍旧只看到新修订上的那条 open 缺口。
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].status, "open");
    }

    /// FINDING 2: `clip_dimensions(dimension='function')` 共 8 个画面功能类
    /// 标签(见 clip_dimensions.rs 的 `prototypes_use_d3_eight_function_classes`),
    /// 逐一核对 `slot_for_function_label` 的映射——特别是 narrative.rs 里
    /// `is_establishing`(Establishing/Orientation 同组)与 `is_experience`
    /// (Experience/Human-Reaction 同组)已经定义的口径,`slot_for_function_label`
    /// 必须与之对齐;Information 不在可生成白名单里,也不映射到任何槽位。
    #[test]
    fn slot_for_function_label_covers_all_eight_function_classes() {
        let cases: [(&str, Option<&str>); 8] = [
            ("Establishing", Some("REAL/ESTABLISHING")),
            ("Orientation", Some("REAL/ESTABLISHING")),
            ("Detail", Some("REAL/DETAIL")),
            ("Atmosphere", Some("ATMOSPHERE")),
            ("Transition", Some("TRANSITION")),
            ("Experience", None),
            ("Human-Reaction", None),
            ("Information", None),
        ];
        for (label, expected) in cases {
            assert_eq!(
                slot_for_function_label(label),
                expected,
                "画面功能标签 {label} 映射不符预期"
            );
        }
    }

    /// FINDING 4a: detect() 的返回值(全库 open 缺口数)不该把别的集(哪怕是刚
    /// 被封存、留着历史 open 行的集)算进来——只应统计当前活跃集。
    #[test]
    fn detect_return_count_is_scoped_to_the_active_episode() {
        let (_d, mut connection) = setup();
        let (first_episode, _chapter) =
            seed_chapter(&connection, &["ATMOSPHERE"], &[("a.mov", None)]);
        let open_count = detect(&mut connection).unwrap();
        assert_eq!(open_count, 1);

        // 把第一集封存,建第二集为活跃集,并留一条属于第二集、规划量不同的缺口。
        connection
            .execute(
                "UPDATE episodes SET status = 'archived' WHERE id = ?1",
                [first_episode],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id)
                 VALUES ('EP02', '', 'now', 'active', 2, lower(hex(randomblob(16))))",
                [],
            )
            .unwrap();
        seed_chapter(&connection, &["TRANSITION"], &[("b.mov", None)]);

        let open_count = detect(&mut connection).unwrap();
        assert_eq!(
            open_count, 1,
            "应只统计当前活跃集(EP02)的 open 缺口,不该把已封存 EP01 遗留的 open 行也数进来"
        );
    }

    /// FINDING 4b: 一个章节的 story_slots_json 若损坏(非法 JSON),detect() 必须
    /// 跳过它继续处理本集其余章节,而不是整体报错中止。
    #[test]
    fn malformed_story_slots_json_is_skipped_not_fatal() {
        let (_d, mut connection) = setup();
        let (episode, good_chapter) =
            seed_chapter(&connection, &["ATMOSPHERE"], &[("a.mov", None)]);
        let revision: i64 = connection
            .query_row(
                "SELECT revision_id FROM narrative_chapters WHERE id = ?1",
                [good_chapter],
                |r| r.get(0),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO narrative_chapters(
                    episode_id, kind, title, \"order\", promoted, score, rationale,
                    promotion_reason, story_slots_json, missing_slots_json, dh_plan_json, revision_id)
                 VALUES (?1, 'journey', '坏章节', 1, 0, 0.8, 'r', '', '{\"oops\": 1}', '[]', 'null', ?2)",
                params![episode, revision],
            )
            .unwrap();

        let result = detect(&mut connection);
        assert!(result.is_ok(), "损坏的 story_slots_json 不该让整个 detect() 报错: {result:?}");
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1, "好章节的缺口仍应正常检出");
        assert_eq!(gaps[0].chapter_title, "黑石峡谷");
    }

    /// FINDING 4c: reason 文案要点明"覆盖判定只看精选/点赞素材"，避免用户误以
    /// 为随便进的素材就能填上缺口。
    #[test]
    fn reason_mentions_only_triaged_clips_count_as_coverage() {
        let (_d, mut connection) = setup();
        seed_chapter(&connection, &["ATMOSPHERE"], &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        let gaps = list(&connection).unwrap();
        assert_eq!(gaps.len(), 1);
        assert!(
            gaps[0].reason.contains("精选") || gaps[0].reason.contains("点赞"),
            "reason 应说明覆盖判定只看精选/点赞素材: {}",
            gaps[0].reason
        );
    }

    #[test]
    fn detect_never_writes_generation_requests() {
        let (_d, mut connection) = setup();
        let all_slots: Vec<&str> = STORY_SLOTS.to_vec();
        seed_chapter(&connection, &all_slots, &[("a.mov", None)]);
        detect(&mut connection).unwrap();
        detect(&mut connection).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM generation_requests", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
