//! R7 Task 7:设置页「云端补镜（MiniMax）」分区的读取端——启用状态、Keychain
//! 是否已配置、本月预算余额,以及最近 100 条账本供表格渲染。
//!
//! 只读函数(`availability`/`ledger_summary`)接受 `has_key` 作为参数而不是自己
//! 调用 `secret::has_minimax_key()`——Keychain 访问是一次子进程调用,把它跟数据库
//! 读隔开,调用方(Tauri 命令层)负责拼两者,这里保持可脱离真实 Keychain 单测。

use rusqlite::Connection;
use serde::Serialize;

use super::error::{CoreError, Result};
use super::settings::{
    self, clamp_minimax_monthly_budget, DEFAULT_MINIMAX_MONTHLY_BUDGET, MINIMAX_ENABLED_KEY,
    MINIMAX_MONTHLY_BUDGET_KEY,
};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GenerationAvailability {
    pub enabled: bool,
    pub has_key: bool,
    pub budget_remaining_usd: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GenerationLedgerEntry {
    pub at: String,
    pub request_id: i64,
    /// 触发这次生成的章节标题(`story_gaps.chapter_id` → `narrative_chapters.title`)。
    pub chapter_title: String,
    /// 缺口 slot,如 `REAL/ESTABLISHING`(见 `story_gaps.slot`)。
    pub slot: String,
    pub seconds: i64,
    pub images: i64,
    pub cost_usd: f64,
    pub model: String,
    pub resolution: String,
    /// `generation_requests.status`——draft/submitted/queued/succeeded/failed/
    /// cancelled/imported 之一;账本行是提交时写的,这里读的是请求当前状态。
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GenerationLedgerSummary {
    pub month: String,
    pub spent_usd: f64,
    pub budget_usd: f64,
    pub entries: Vec<GenerationLedgerEntry>,
}

/// 读设置里存的月度预算,夹到 [0, 500] 上限——即使表里存了一个已损坏/超限的
/// 历史值,展示层也绝不放大成负预算或天价预算。
pub fn monthly_budget_usd(connection: &Connection) -> Result<f64> {
    let stored = settings::string_value(
        connection,
        MINIMAX_MONTHLY_BUDGET_KEY,
        &DEFAULT_MINIMAX_MONTHLY_BUDGET.to_string(),
    )?;
    let parsed = stored.parse::<f64>().unwrap_or(DEFAULT_MINIMAX_MONTHLY_BUDGET);
    Ok(clamp_minimax_monthly_budget(parsed))
}

/// 本 UTC 自然月(数据库 `at` 列已经是 `strftime('%Y-%m-%dT%H:%M:%fZ')` UTC
/// 格式)在 `generation_ledger` 里的预估花费合计。
pub fn spent_this_month_usd(connection: &Connection) -> Result<f64> {
    let spent: f64 = connection.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0.0) FROM generation_ledger
         WHERE substr(at, 1, 7) = strftime('%Y-%m', 'now')",
        [],
        |row| row.get(0),
    )?;
    Ok(spent)
}

pub fn minimax_enabled(connection: &Connection) -> Result<bool> {
    Ok(settings::string_value(connection, MINIMAX_ENABLED_KEY, "false")? == "true")
}

/// `enabled`/`budget_remaining_usd` 来自数据库,`has_key` 由调用方传入(来自
/// Keychain 探测)。预算余额永不为负——超支只会让它停在 0,不会倒挂成负数
/// 误导前端显示"还能生成负的时长"。
pub fn availability(connection: &Connection, has_key: bool) -> Result<GenerationAvailability> {
    let enabled = minimax_enabled(connection)?;
    let budget = monthly_budget_usd(connection)?;
    let spent = spent_this_month_usd(connection)?;
    Ok(GenerationAvailability {
        enabled,
        has_key,
        budget_remaining_usd: (budget - spent).max(0.0),
    })
}

/// 最近 100 条账本,按时间倒序(最新在前),供设置页表格直接渲染。
pub fn ledger_summary(connection: &Connection) -> Result<GenerationLedgerSummary> {
    let budget = monthly_budget_usd(connection)?;
    let spent = spent_this_month_usd(connection)?;
    let month: String = connection.query_row("SELECT strftime('%Y-%m', 'now')", [], |row| row.get(0))?;

    let mut statement = connection.prepare(
        "SELECT gl.at, gl.request_id, gl.seconds, gl.images, gl.cost_usd,
                gr.model, gr.resolution, gr.status, nc.title, sg.slot
         FROM generation_ledger gl
         JOIN generation_requests gr ON gr.id = gl.request_id
         JOIN story_gaps sg ON sg.id = gr.gap_id
         JOIN narrative_chapters nc ON nc.id = sg.chapter_id
         ORDER BY gl.at DESC, gl.id DESC
         LIMIT 100",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(GenerationLedgerEntry {
            at: row.get(0)?,
            request_id: row.get(1)?,
            seconds: row.get(2)?,
            images: row.get(3)?,
            cost_usd: row.get(4)?,
            model: row.get(5)?,
            resolution: row.get(6)?,
            status: row.get(7)?,
            chapter_title: row.get(8)?,
            slot: row.get(9)?,
        })
    })?;
    let entries = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(CoreError::from)?;

    Ok(GenerationLedgerSummary {
        month,
        spent_usd: spent,
        budget_usd: budget,
        entries,
    })
}

/// API Key 写入前的校验——去空白、拒绝空值。放在 Rust 而不是前端,这样即使
/// 前端状态过期或被绕过,也不会把一个空字符串写进 Keychain 变成"看起来已配置
/// 实则无效"的坏状态。
pub fn validate_key_input(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidSchema("API Key 不能为空".to_owned()));
    }
    Ok(trimmed.to_owned())
}

/// 只读窗口的写操作闸——设置/清除 Key 都要过这一道,跟仓库里其它「只读窗口不能
/// XX」的错误文案保持同一措辞规范。
pub fn guard_writable(read_only: bool) -> Result<()> {
    if read_only {
        Err(CoreError::InvalidSchema("只读窗口不能修改 MiniMax API Key".to_owned()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, settings::set_setting, test_support::TestDirectory};

    fn test_connection() -> (TestDirectory, Connection) {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        (directory, connection)
    }

    /// 插好 episode → narrative_revision → narrative_chapter → story_gap →
    /// generation_request 这条 FK 链,返回新建 `generation_requests.id`,供
    /// 测试直接往 `generation_ledger` 挂账。`at_expr` 是一段 SQLite 时间表达式
    /// (如 `"strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 month')"`),用于精确
    /// 制造"上个月"的账本行,不依赖 Rust 端引入日期库。
    fn seed_request(connection: &Connection, model: &str, resolution: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at) VALUES ('ep', 'theme', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                [],
            )
            .unwrap();
        let episode_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO narrative_revisions(episode_id, kind, title, theme, created_at)
                 VALUES (?1, 'suggested', 't', 'th', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                [episode_id],
            )
            .unwrap();
        let revision_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO narrative_chapters(
                    episode_id, revision_id, kind, title, \"order\", promoted, score,
                    rationale, promotion_reason
                 ) VALUES (?1, ?2, 'journey', '第一章', 0, 0, 0.5, 'r', 'p')",
                [episode_id, revision_id],
            )
            .unwrap();
        let chapter_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO story_gaps(
                    episode_id, revision_id, chapter_id, slot, reason, status,
                    detected_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'REAL/ESTABLISHING', 'r', 'open',
                    strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                [episode_id, revision_id, chapter_id],
            )
            .unwrap();
        let gap_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO generation_requests(
                    gap_id, provider, model, mode, prompt, duration_s, resolution,
                    estimated_cost_usd, status, created_at, updated_at
                 ) VALUES (?1, 'minimax', ?2, 't2v', 'p', 6, ?3, 0.48, 'imported',
                    strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![gap_id, model, resolution],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn seed_ledger_row(connection: &Connection, request_id: i64, cost_usd: f64, at_expr: &str) {
        connection
            .execute(
                &format!(
                    "INSERT INTO generation_ledger(request_id, cost_usd, seconds, images, at)
                     VALUES (?1, ?2, 6, 0, {at_expr})"
                ),
                rusqlite::params![request_id, cost_usd],
            )
            .unwrap();
    }

    #[test]
    fn availability_reports_disabled_by_default_with_full_budget() {
        let (_dir, connection) = test_connection();
        let result = availability(&connection, false).unwrap();
        assert!(!result.enabled);
        assert!(!result.has_key);
        assert_eq!(result.budget_remaining_usd, DEFAULT_MINIMAX_MONTHLY_BUDGET);
    }

    #[test]
    fn availability_math_only_counts_current_utc_month() {
        let (_dir, connection) = test_connection();
        set_setting(&connection, MINIMAX_ENABLED_KEY, "true").unwrap();
        set_setting(&connection, MINIMAX_MONTHLY_BUDGET_KEY, "10").unwrap();
        let request_id = seed_request(&connection, "MiniMax-H3-Max", "768P");
        // 上个月的花费不该计入本月余额。
        seed_ledger_row(&connection, request_id, 8.0, "strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 month')");
        // 本月花了 3。
        seed_ledger_row(&connection, request_id, 3.0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')");

        let result = availability(&connection, true).unwrap();
        assert!(result.enabled);
        assert!(result.has_key);
        assert_eq!(result.budget_remaining_usd, 7.0);
    }

    #[test]
    fn budget_remaining_never_goes_negative_when_overspent() {
        let (_dir, connection) = test_connection();
        set_setting(&connection, MINIMAX_MONTHLY_BUDGET_KEY, "5").unwrap();
        let request_id = seed_request(&connection, "MiniMax-H3", "2K");
        seed_ledger_row(&connection, request_id, 20.0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')");

        let result = availability(&connection, false).unwrap();
        assert_eq!(result.budget_remaining_usd, 0.0);

        let summary = ledger_summary(&connection).unwrap();
        assert_eq!(summary.spent_usd, 20.0);
        assert_eq!(summary.budget_usd, 5.0);
    }

    /// `set_setting` 已经在写入路径夹住/校验预算(见 `settings::validate_setting`),
    /// 这里绕过它直写 `settings` 表,模拟"数据库里已经存在一个损坏值"(比如手工改库、
    /// 或早期版本没有这条校验时写入的)——展示层的第二道防线不能假设写入路径永远干净。
    #[test]
    fn monthly_budget_is_clamped_to_five_hundred_even_if_the_stored_value_is_corrupted() {
        let (_dir, connection) = test_connection();
        connection
            .execute(
                "INSERT INTO settings(key, value, updated_at)
                 VALUES (?1, '999999', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [MINIMAX_MONTHLY_BUDGET_KEY],
            )
            .unwrap();
        assert_eq!(monthly_budget_usd(&connection).unwrap(), 500.0);

        connection
            .execute(
                "UPDATE settings SET value = 'not-a-number' WHERE key = ?1",
                [MINIMAX_MONTHLY_BUDGET_KEY],
            )
            .unwrap();
        assert_eq!(monthly_budget_usd(&connection).unwrap(), DEFAULT_MINIMAX_MONTHLY_BUDGET);
    }

    #[test]
    fn ledger_summary_orders_entries_most_recent_first_and_joins_model_resolution() {
        let (_dir, connection) = test_connection();
        let request_id = seed_request(&connection, "MiniMax-H3-Max", "480P");
        seed_ledger_row(&connection, request_id, 0.20, "strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')");
        seed_ledger_row(&connection, request_id, 0.20, "strftime('%Y-%m-%dT%H:%M:%fZ','now')");
        seed_ledger_row(&connection, request_id, 0.20, "strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minutes')");

        let summary = ledger_summary(&connection).unwrap();
        assert_eq!(summary.entries.len(), 3);
        let ats: Vec<&str> = summary.entries.iter().map(|entry| entry.at.as_str()).collect();
        let mut sorted = ats.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(ats, sorted, "账本必须按时间倒序(最新在前)");
        for entry in &summary.entries {
            assert_eq!(entry.model, "MiniMax-H3-Max");
            assert_eq!(entry.resolution, "480P");
            assert_eq!(entry.request_id, request_id);
            assert_eq!(entry.chapter_title, "第一章");
            assert_eq!(entry.slot, "REAL/ESTABLISHING");
            assert_eq!(entry.status, "imported");
        }
    }

    #[test]
    fn validate_key_input_trims_and_rejects_blank() {
        assert_eq!(validate_key_input("  sk-abc  ").unwrap(), "sk-abc");
        assert!(validate_key_input("").is_err());
        assert!(validate_key_input("   ").is_err());
    }

    #[test]
    fn guard_writable_refuses_read_only_window() {
        assert!(guard_writable(true).is_err());
        assert!(guard_writable(false).is_ok());
    }
}
