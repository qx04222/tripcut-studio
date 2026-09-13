//! R3 目标平台预设:六套只读预设(尺寸/时长预算/时间基/字幕样式),
//! 供集设置目标平台与画布朝向时读取默认值。预设表由迁移 0031 播种,
//! 应用代码不写入 `platform_presets`——只有下一次迁移可以改变它。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::error::{CoreError, Result};

const VALID_PLATFORMS: &[&str] = &[
    "douyin",
    "xiaohongshu",
    "bilibili",
    "moments",
    "family",
    "general",
];

const VALID_ORIENTATIONS: &[&str] = &["landscape", "portrait", "both"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlatformPreset {
    pub platform: String,
    pub display_name: String,
    pub portrait: (i64, i64),
    pub landscape: (i64, i64),
    pub duration_budget_ticks: i64,
    pub tb_num: i64,
    pub tb_den: i64,
    pub subtitle_style: serde_json::Value,
    /// R10 U-05(迁移 0042):平台习惯的画布方向——`portrait` / `landscape` /
    /// `auto`(跟随本集素材多数方向)。集没有明确选方向(`both`)时交付按它取画布。
    pub default_orientation: String,
}

/// 六套只读预设。`platform_presets` 由迁移播种,这里只读取,从不写入。
pub fn list_platform_presets(connection: &Connection) -> Result<Vec<PlatformPreset>> {
    let mut statement = connection.prepare(
        "SELECT platform, display_name, portrait_w, portrait_h, landscape_w, landscape_h,
                duration_budget_ticks, tb_num, tb_den, subtitle_style_json, default_orientation
           FROM platform_presets
          ORDER BY platform",
    )?;
    let rows = statement
        .query_map([], |row| {
            let subtitle_style_json: String = row.get(9)?;
            Ok((
                PlatformPreset {
                    platform: row.get(0)?,
                    display_name: row.get(1)?,
                    portrait: (row.get(2)?, row.get(3)?),
                    landscape: (row.get(4)?, row.get(5)?),
                    duration_budget_ticks: row.get(6)?,
                    tb_num: row.get(7)?,
                    tb_den: row.get(8)?,
                    subtitle_style: serde_json::Value::Null,
                    default_orientation: row.get(10)?,
                },
                subtitle_style_json,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(mut preset, subtitle_style_json)| {
            preset.subtitle_style = serde_json::from_str(&subtitle_style_json).map_err(|error| {
                CoreError::Story(format!(
                    "平台预设 {} 的字幕样式解析失败:{error}",
                    preset.platform
                ))
            })?;
            Ok(preset)
        })
        .collect()
}

/// 交付层用的已解析平台：预设 + 本次实际使用的画布朝向(只会是 `portrait` 或
/// `landscape`;集的 `both` 已按 `orientation_source` 说明的规则落定)。
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPlatform {
    pub preset: PlatformPreset,
    pub orientation: String,
    /// 画布方向是怎么来的:`episode`(集明确选了横/竖)、`override`(本次交付
    /// 传入)、`preset`(平台习惯)、`clips`(通用平台按素材多数)、`fallback`
    /// (没有素材可数时的横版兜底)。前端抽屉照此解释「画布 1080×1920」。
    pub orientation_source: &'static str,
}

/// R10 U-05:统计当前集素材的多数方向(rotation + 像素综合,见 `core::orientation`)。
/// 竖 > 横 才返回 portrait;平手或没有可判素材 → None(由调用方兜底横版)。
pub fn majority_clip_orientation(connection: &Connection, episode_id: i64) -> Result<Option<&'static str>> {
    let mut statement = connection.prepare(
        "SELECT width, height, rotation FROM clips
          WHERE episode_id = ?1 AND missing_since IS NULL",
    )?;
    let mut portrait = 0_usize;
    let mut landscape = 0_usize;
    let rows = statement.query_map([episode_id], |row| {
        Ok((
            row.get::<_, Option<i64>>(0)?,
            row.get::<_, Option<i64>>(1)?,
            row.get::<_, Option<i64>>(2)?,
        ))
    })?;
    for row in rows {
        let (width, height, rotation) = row?;
        match super::orientation::clip_orientation(width, height, rotation) {
            super::orientation::Orientation::Portrait => portrait += 1,
            super::orientation::Orientation::Landscape => landscape += 1,
            _ => {}
        }
    }
    Ok(if portrait + landscape == 0 {
        None
    } else if portrait > landscape {
        Some("portrait")
    } else {
        Some("landscape")
    })
}

impl ResolvedPlatform {
    pub fn canvas(&self) -> (i64, i64) {
        if self.orientation == "portrait" {
            self.preset.portrait
        } else {
            self.preset.landscape
        }
    }

    /// `duration_budget_ticks` 换算成秒；0 表示不限时长。
    pub fn duration_budget_seconds(&self) -> i64 {
        if self.preset.duration_budget_ticks <= 0 || self.preset.tb_den <= 0 {
            return 0;
        }
        (self.preset.duration_budget_ticks * self.preset.tb_num) / self.preset.tb_den
    }
}

/// 解析交付/草稿要用的平台预设:`override_platform`(六选一,先校验)优先于
/// 集当前的 `target_platform`——override 只换皮肤,不改集记录。
///
/// 画布朝向(R10 U-05)按优先级落定:
/// 1. `override_orientation`(本次交付抽屉里手动切的,只能是 portrait/landscape);
/// 2. 集的 `canvas_orientation` 为 portrait/landscape(用户明确选过);
/// 3. 集是 `both`(默认,从没选过)→ 预设 `default_orientation`;
/// 4. 预设是 `auto` → 本集素材多数方向;没有素材可数 → landscape 兜底。
pub fn resolve_platform(
    connection: &Connection,
    episode_id: i64,
    override_platform: Option<&str>,
) -> Result<ResolvedPlatform> {
    resolve_platform_with_orientation(connection, episode_id, override_platform, None)
}

pub fn resolve_platform_with_orientation(
    connection: &Connection,
    episode_id: i64,
    override_platform: Option<&str>,
    override_orientation: Option<&str>,
) -> Result<ResolvedPlatform> {
    if let Some(candidate) = override_orientation {
        if !matches!(candidate, "portrait" | "landscape") {
            return Err(CoreError::Story(format!(
                "交付画布方向「{candidate}」不受支持;可选值:portrait、landscape"
            )));
        }
    }
    let platform = match override_platform {
        Some(candidate) => {
            if !VALID_PLATFORMS.contains(&candidate) {
                return Err(CoreError::Story(format!(
                    "目标平台「{candidate}」不受支持;可选值:{}",
                    VALID_PLATFORMS.join("、")
                )));
            }
            candidate.to_owned()
        }
        None => connection
            .query_row(
                "SELECT target_platform FROM episodes WHERE id = ?1",
                [episode_id],
                |row| row.get(0),
            )
            .map_err(|_| CoreError::Story(format!("集 {episode_id} 不存在")))?,
    };
    let orientation: String = connection
        .query_row(
            "SELECT canvas_orientation FROM episodes WHERE id = ?1",
            [episode_id],
            |row| row.get(0),
        )
        .map_err(|_| CoreError::Story(format!("集 {episode_id} 不存在")))?;
    let preset = list_platform_presets(connection)?
        .into_iter()
        .find(|preset| preset.platform == platform)
        .ok_or_else(|| CoreError::Story(format!("平台预设缺失:{platform}")))?;
    let (orientation, orientation_source) = if let Some(forced) = override_orientation {
        (forced.to_owned(), "override")
    } else if orientation != "both" {
        (orientation, "episode")
    } else if preset.default_orientation != "auto" {
        (preset.default_orientation.clone(), "preset")
    } else {
        match majority_clip_orientation(connection, episode_id)? {
            Some(majority) => (majority.to_owned(), "clips"),
            None => ("landscape".to_owned(), "fallback"),
        }
    };
    Ok(ResolvedPlatform { preset, orientation, orientation_source })
}

/// 校验目标平台 + 画布朝向枚举值;供 `set_episode_platform` 与
/// `episode::archive_current` 共用同一份枚举定义,避免两处漂移。
pub fn validate_platform_and_orientation(platform: &str, orientation: &str) -> Result<()> {
    if !VALID_PLATFORMS.contains(&platform) {
        return Err(CoreError::Story(format!(
            "目标平台「{platform}」不受支持;可选值:{}",
            VALID_PLATFORMS.join("、")
        )));
    }
    if !VALID_ORIENTATIONS.contains(&orientation) {
        return Err(CoreError::Story(format!(
            "画布朝向「{orientation}」不受支持;可选值:{}",
            VALID_ORIENTATIONS.join("、")
        )));
    }
    Ok(())
}

/// 设置当前(或指定)集的目标平台与画布朝向。
/// 枚举在 Rust 侧先校验一遍(给出清晰中文错误),CHECK 约束是最后一道防线。
/// 历史集是只读档案,拒绝写入——与 `episode::ensure_clip_writable` 同一守卫模式。
pub fn set_episode_platform(
    connection: &mut Connection,
    episode_id: i64,
    platform: &str,
    orientation: &str,
) -> Result<()> {
    validate_platform_and_orientation(platform, orientation)?;

    let status: Option<String> = connection
        .query_row(
            "SELECT status FROM episodes WHERE id = ?1",
            [episode_id],
            |row| row.get(0),
        )
        .optional()?;
    let status = status.ok_or_else(|| CoreError::Story(format!("集 {episode_id} 不存在")))?;
    if status != "active" {
        return Err(CoreError::Story("历史集为只读档案".to_owned()));
    }

    connection.execute(
        "UPDATE episodes SET target_platform = ?2, canvas_orientation = ?3 WHERE id = ?1",
        params![episode_id, platform, orientation],
    )?;
    Ok(())
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

    #[test]
    fn list_platform_presets_returns_six_rows_with_sizes() {
        let (_dir, connection) = test_connection();
        let presets = list_platform_presets(&connection).unwrap();
        assert_eq!(presets.len(), 6);
        for preset in &presets {
            assert!(preset.portrait.0 > 0 && preset.portrait.1 > 0);
            assert!(preset.landscape.0 > 0 && preset.landscape.1 > 0);
        }
        let douyin = presets.iter().find(|p| p.platform == "douyin").unwrap();
        assert_eq!(douyin.portrait, (1080, 1920));
    }

    #[test]
    fn set_episode_platform_rejects_invalid_platform() {
        let (_dir, mut connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        let error = set_episode_platform(&mut connection, current.id, "youtube", "both").unwrap_err();
        assert!(error.to_string().contains("目标平台"));
    }

    #[test]
    fn set_episode_platform_rejects_invalid_orientation() {
        let (_dir, mut connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        let error =
            set_episode_platform(&mut connection, current.id, "douyin", "sideways").unwrap_err();
        assert!(error.to_string().contains("画布朝向"));
    }

    #[test]
    fn set_episode_platform_rejects_archived_episode() {
        let (_dir, mut connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        connection
            .execute(
                "UPDATE episodes SET status = 'archived', archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  WHERE id = ?1",
                [current.id],
            )
            .unwrap();
        let error = set_episode_platform(&mut connection, current.id, "douyin", "both").unwrap_err();
        assert!(error.to_string().contains("历史集"));
    }

    /// R10 U-05 迁移自 `resolve_platform_folds_both_orientation_to_landscape`:
    /// 集没明确选方向(`both`)时不再一律横版——先看平台习惯,通用平台再看素材,
    /// 没素材才兜底横版。
    #[test]
    fn resolve_platform_both_orientation_follows_preset_then_clips_then_landscape() {
        let (_dir, mut connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        // 通用平台 + 没有素材 → 兜底横版(旧行为保留在这一支)。
        set_episode_platform(&mut connection, current.id, "general", "both").unwrap();
        let resolved = resolve_platform(&connection, current.id, None).unwrap();
        assert_eq!(resolved.orientation, "landscape");
        assert_eq!(resolved.orientation_source, "fallback");
        assert_eq!(resolved.canvas(), resolved.preset.landscape);
        // 抖音 + both → 平台习惯竖版。
        set_episode_platform(&mut connection, current.id, "douyin", "both").unwrap();
        let resolved = resolve_platform(&connection, current.id, None).unwrap();
        assert_eq!(resolved.preset.platform, "douyin");
        assert_eq!(resolved.orientation, "portrait");
        assert_eq!(resolved.orientation_source, "preset");
        assert_eq!(resolved.canvas(), (1080, 1920));
        // B站 + both → 横。
        let resolved = resolve_platform(&connection, current.id, Some("bilibili")).unwrap();
        assert_eq!(resolved.orientation, "landscape");
        assert_eq!(resolved.orientation_source, "preset");
    }

    /// 走查 U-05:选小红书交付 → 画布 1080×1920。
    #[test]
    fn xiaohongshu_delivery_uses_a_portrait_1080_by_1920_canvas() {
        let (_dir, connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        assert_eq!(current.canvas_orientation, "both", "新集默认没有选过方向");
        let resolved = resolve_platform(&connection, current.id, Some("xiaohongshu")).unwrap();
        assert_eq!(resolved.orientation, "portrait");
        assert_eq!(resolved.canvas(), (1080, 1920));
    }

    fn insert_sized_clip(connection: &Connection, id: i64, width: i64, height: i64, rotation: i64) {
        connection
            .execute("INSERT OR IGNORE INTO volumes(uuid, label) VALUES ('v', 'test')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(id, volume_uuid, rel_path, width, height, rotation, imported_at, episode_id)
                 VALUES (?1, 'v', ?2, ?3, ?4, ?5, 'now', (SELECT id FROM episodes WHERE status = 'active'))",
                params![id, format!("c{id}.mov"), width, height, rotation],
            )
            .unwrap();
    }

    /// 通用平台(`auto`)跟随素材多数方向;rotation 90 的横编码算竖。
    #[test]
    fn general_platform_follows_the_majority_clip_orientation() {
        let (_dir, connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        insert_sized_clip(&connection, 1, 1080, 1920, 0);
        insert_sized_clip(&connection, 2, 1920, 1080, 90);
        insert_sized_clip(&connection, 3, 1920, 1080, 0);
        let resolved = resolve_platform(&connection, current.id, Some("general")).unwrap();
        assert_eq!(resolved.orientation, "portrait");
        assert_eq!(resolved.orientation_source, "clips");
        // 平手 → 横。
        insert_sized_clip(&connection, 4, 3840, 2160, 0);
        let resolved = resolve_platform(&connection, current.id, Some("general")).unwrap();
        assert_eq!(resolved.orientation, "landscape");
    }

    /// 集明确选过方向、或本次交付手动切了方向,都压过平台习惯。
    #[test]
    fn explicit_episode_or_override_orientation_beats_the_preset() {
        let (_dir, mut connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        set_episode_platform(&mut connection, current.id, "xiaohongshu", "landscape").unwrap();
        let resolved = resolve_platform(&connection, current.id, None).unwrap();
        assert_eq!(resolved.orientation, "landscape");
        assert_eq!(resolved.orientation_source, "episode");
        let resolved =
            resolve_platform_with_orientation(&connection, current.id, None, Some("portrait")).unwrap();
        assert_eq!(resolved.orientation, "portrait");
        assert_eq!(resolved.orientation_source, "override");
        assert_eq!(resolved.canvas(), (1080, 1920));
        let error =
            resolve_platform_with_orientation(&connection, current.id, None, Some("both")).unwrap_err();
        assert!(error.to_string().contains("画布方向"));
    }

    #[test]
    fn resolve_platform_override_does_not_touch_episode_record() {
        let (_dir, mut connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        set_episode_platform(&mut connection, current.id, "douyin", "portrait").unwrap();
        let resolved = resolve_platform(&connection, current.id, Some("bilibili")).unwrap();
        assert_eq!(resolved.preset.platform, "bilibili");
        assert_eq!(resolved.orientation, "portrait");
        assert_eq!(resolved.canvas(), resolved.preset.portrait);

        let (platform, orientation): (String, String) = connection
            .query_row(
                "SELECT target_platform, canvas_orientation FROM episodes WHERE id = ?1",
                [current.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(platform, "douyin");
        assert_eq!(orientation, "portrait");
    }

    #[test]
    fn resolve_platform_rejects_invalid_override() {
        let (_dir, connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        let error = resolve_platform(&connection, current.id, Some("youtube")).unwrap_err();
        assert!(error.to_string().contains("目标平台"));
    }

    #[test]
    fn duration_budget_seconds_converts_ticks_and_zero_means_unbounded() {
        let (_dir, connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        let douyin = resolve_platform(&connection, current.id, Some("douyin")).unwrap();
        assert_eq!(douyin.duration_budget_seconds(), 60);
        let family = resolve_platform(&connection, current.id, Some("family")).unwrap();
        assert_eq!(family.duration_budget_seconds(), 0);
    }

    #[test]
    fn set_episode_platform_updates_current_episode_columns() {
        let (_dir, mut connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        set_episode_platform(&mut connection, current.id, "douyin", "portrait").unwrap();
        let (platform, orientation): (String, String) = connection
            .query_row(
                "SELECT target_platform, canvas_orientation FROM episodes WHERE id = ?1",
                [current.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(platform, "douyin");
        assert_eq!(orientation, "portrait");
    }
}
