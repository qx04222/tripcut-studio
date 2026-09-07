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
}

/// 六套只读预设。`platform_presets` 由迁移播种,这里只读取,从不写入。
pub fn list_platform_presets(connection: &Connection) -> Result<Vec<PlatformPreset>> {
    let mut statement = connection.prepare(
        "SELECT platform, display_name, portrait_w, portrait_h, landscape_w, landscape_h,
                duration_budget_ticks, tb_num, tb_den, subtitle_style_json
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

/// 交付层用的已解析平台：预设 + 本次实际使用的画布朝向(`both` 已折成
/// `landscape`——「横竖同时制作，草稿按横版画布」)。
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPlatform {
    pub preset: PlatformPreset,
    pub orientation: String,
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
/// 集当前的 `target_platform`;画布朝向永远来自集的 `canvas_orientation`,
/// `both` 在这里折成 `landscape`——override 只换皮肤,不改集记录。
pub fn resolve_platform(
    connection: &Connection,
    episode_id: i64,
    override_platform: Option<&str>,
) -> Result<ResolvedPlatform> {
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
    let orientation = if orientation == "both" {
        "landscape".to_owned()
    } else {
        orientation
    };
    let preset = list_platform_presets(connection)?
        .into_iter()
        .find(|preset| preset.platform == platform)
        .ok_or_else(|| CoreError::Story(format!("平台预设缺失:{platform}")))?;
    Ok(ResolvedPlatform { preset, orientation })
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

    #[test]
    fn resolve_platform_folds_both_orientation_to_landscape() {
        let (_dir, mut connection) = test_connection();
        let current = crate::core::episode::current_episode(&connection).unwrap();
        set_episode_platform(&mut connection, current.id, "douyin", "both").unwrap();
        let resolved = resolve_platform(&connection, current.id, None).unwrap();
        assert_eq!(resolved.preset.platform, "douyin");
        assert_eq!(resolved.orientation, "landscape");
        assert_eq!(resolved.canvas(), resolved.preset.landscape);
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
