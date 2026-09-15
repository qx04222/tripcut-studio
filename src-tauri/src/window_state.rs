//! R18 车道 native / M-02:窗口几何钳制 + 全屏态持久化。
//!
//! 两个实测缺陷(`.superpowers/sdd/r18/brainstorm-holistic.md` §1.3):
//! 1. 把 `window.x` 写成 5000 重启,窗口就停在 `5000,30`——**进程活着,用户什么都看不见**,
//!    现象是"双击图标没反应"。拔掉外接显示器必然复现。
//! 2. `⌘⌃F` 进全屏再 `⌘Q`,全屏的 1800×1130 被当成普通窗口尺寸存了下来,
//!    下次打开是一个几乎铺满屏幕的**普通**窗口,而全屏本身没有被记住。
//!
//! 这里只放**纯几何 + 一个设置键**,不碰 Tauri 类型,所以三条判定能在没有屏幕的
//! 测试进程里跑。调用点在 `lib.rs` 的 setup(恢复)与窗口事件(保存)。

use rusqlite::{params, Connection};

use crate::core::error::Result;

/// 逻辑坐标下的矩形(已经按各自屏幕的 `scale_factor` 换算过——
/// `available_monitors()` 给的是物理像素,直接比会在混合 DPI 下比错)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 与任一可用屏幕的交集小于窗口面积的这个比例,就判定为"用户看不见",居中重来。
pub const MIN_VISIBLE_FRACTION: f64 = 0.25;
/// 与 `tauri.conf.json` 的 `minWidth`/`minHeight` 一致;比这更小的尺寸恢复了也没法用。
pub const MIN_WIDTH: f64 = 1_280.0;
pub const MIN_HEIGHT: f64 = 800.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Placement {
    /// 原位(尺寸可能被夹到 [最小值, 屏幕可视区] 之间)。
    Keep(Rect),
    /// 看不见了:按这个尺寸居中到主屏。
    Center { width: f64, height: f64 },
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

fn intersection_area(rect: &Rect, monitor: &Rect) -> f64 {
    overlap(rect.x, rect.x + rect.width, monitor.x, monitor.x + monitor.width)
        * overlap(rect.y, rect.y + rect.height, monitor.y, monitor.y + monitor.height)
}

/// 恢复窗口位置前的最后一道闸。`monitors` 为空(拿不到屏幕信息)时一律居中——
/// 失败朝"看得见"那一侧倒,而不是朝"照着存的数放"那一侧。
pub fn clamp_to_monitors(rect: Rect, monitors: &[Rect]) -> Placement {
    // 夹到**最大**的那块屏:窗口可能本来就住在外接大屏上,按最小的屏夹会把它无故缩小。
    let (max_width, max_height) = monitors
        .iter()
        .fold((0.0_f64, 0.0_f64), |acc, monitor| (acc.0.max(monitor.width), acc.1.max(monitor.height)));
    let (max_width, max_height) = if monitors.is_empty() { (f64::INFINITY, f64::INFINITY) } else { (max_width, max_height) };
    let width = rect.width.max(MIN_WIDTH).min(max_width.max(MIN_WIDTH));
    let height = rect.height.max(MIN_HEIGHT).min(max_height.max(MIN_HEIGHT));
    let sized = Rect { width, height, ..rect };
    let visible = monitors
        .iter()
        .map(|monitor| intersection_area(&sized, monitor))
        .fold(0.0_f64, f64::max);
    let area = sized.width * sized.height;
    if area <= 0.0 || visible < area * MIN_VISIBLE_FRACTION {
        Placement::Center { width, height }
    } else {
        Placement::Keep(sized)
    }
}

/// 全屏态单独存一个键。**不**走 `settings::save_window_state`——全屏时的宽高不是窗口宽高,
/// 混进同一条写入就会把 1800×1130 当成用户的窗口大小存下来(这正是 §1.3 的缺陷 1)。
pub const FULLSCREEN_KEY: &str = "window.fullscreen";

fn settings_table_exists(connection: &Connection) -> Result<bool> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

pub fn stored_fullscreen(connection: &Connection) -> Result<bool> {
    if !settings_table_exists(connection)? {
        return Ok(false);
    }
    let value: Option<String> = connection
        .query_row("SELECT value FROM settings WHERE key=?1", params![FULLSCREEN_KEY], |row| row.get(0))
        .ok();
    Ok(value.as_deref() == Some("true"))
}

pub fn save_fullscreen(connection: &Connection, fullscreen: bool) -> Result<()> {
    if !settings_table_exists(connection)? {
        return Ok(());
    }
    connection.execute(
        "INSERT INTO settings(key, value, updated_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![FULLSCREEN_KEY, if fullscreen { "true" } else { "false" }],
    )?;
    Ok(())
}

/// 窗口事件攒下来要落盘的一份状态。`geometry` 为 `None` = 此刻是全屏/最大化,
/// 这一次**不**写宽高(但全屏标志照写)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowPersist {
    pub geometry: Option<crate::core::settings::WindowState>,
    pub fullscreen: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect { x: 0.0, y: 0.0, width: 1_512.0, height: 945.0 };

    fn window(x: f64, y: f64) -> Rect {
        Rect { x, y, width: 1_400.0, height: 900.0 }
    }

    /// ① 完全在屏内:原样返回。
    #[test]
    fn a_window_inside_a_monitor_is_left_alone() {
        assert_eq!(clamp_to_monitors(window(50.0, 30.0), &[LAPTOP]), Placement::Keep(window(50.0, 30.0)));
    }

    /// ② 实测那条:`window.x = 5000` 单屏 → 居中(否则用户"双击图标没反应")。
    #[test]
    fn a_window_completely_off_screen_is_centred() {
        assert_eq!(
            clamp_to_monitors(window(5_000.0, -2_000.0), &[LAPTOP]),
            Placement::Center { width: 1_400.0, height: 900.0 }
        );
    }

    /// ③ 部分出屏:露出来的还够(≥25%)就别动它——用户自己把窗口拖到边上是合法用法。
    #[test]
    fn a_mostly_visible_window_is_kept() {
        let rect = window(1_000.0, 100.0); // 露出 512/1400 ≈ 37% 宽度
        assert_eq!(clamp_to_monitors(rect, &[LAPTOP]), Placement::Keep(rect));
    }

    /// 露出来不到 25%(拔掉外接屏后的典型形态)→ 居中。
    #[test]
    fn a_barely_visible_window_is_centred() {
        let rect = window(1_400.0, 100.0); // 只露出 112/1400 = 8%
        assert!(matches!(clamp_to_monitors(rect, &[LAPTOP]), Placement::Center { .. }));
    }

    /// 双屏:主屏上看不见,但副屏上看得见 —— 不许居中(会把用户的窗口从外接屏搬走)。
    #[test]
    fn a_window_on_the_second_monitor_is_kept() {
        let external = Rect { x: 1_512.0, y: 0.0, width: 2_560.0, height: 1_440.0 };
        let rect = window(2_000.0, 200.0);
        assert_eq!(clamp_to_monitors(rect, &[LAPTOP, external]), Placement::Keep(rect));
    }

    /// 拿不到屏幕信息时失败朝"看得见"倒。
    #[test]
    fn no_monitors_means_centre() {
        assert!(matches!(clamp_to_monitors(window(0.0, 0.0), &[]), Placement::Center { .. }));
    }

    /// 存下来的是全屏尺寸(比屏幕还大)时,夹回屏幕可视区,不还一个比屏幕大的普通窗口。
    #[test]
    fn a_size_larger_than_the_screen_is_clamped() {
        let rect = Rect { x: 0.0, y: 0.0, width: 1_800.0, height: 1_130.0 };
        match clamp_to_monitors(rect, &[LAPTOP]) {
            Placement::Keep(kept) => {
                assert_eq!(kept.width, LAPTOP.width);
                assert_eq!(kept.height, LAPTOP.height);
            }
            other => panic!("不该居中:{other:?}"),
        }
    }

    /// 比 minWidth/minHeight 还小的历史值要被抬回可用尺寸。
    #[test]
    fn a_tiny_size_is_raised_to_the_minimum() {
        let rect = Rect { x: 10.0, y: 10.0, width: 300.0, height: 200.0 };
        match clamp_to_monitors(rect, &[LAPTOP]) {
            Placement::Keep(kept) => {
                assert_eq!((kept.width, kept.height), (MIN_WIDTH, MIN_HEIGHT));
            }
            Placement::Center { width, height } => {
                assert_eq!((width, height), (MIN_WIDTH, MIN_HEIGHT));
            }
        }
    }

    #[test]
    fn fullscreen_flag_round_trips_and_defaults_to_false() {
        let connection = Connection::open_in_memory().expect("内存库");
        connection
            .execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)", [])
            .expect("建表");
        assert!(!stored_fullscreen(&connection).expect("读默认值"));
        save_fullscreen(&connection, true).expect("写 true");
        assert!(stored_fullscreen(&connection).expect("读回 true"));
        save_fullscreen(&connection, false).expect("写 false");
        assert!(!stored_fullscreen(&connection).expect("读回 false"));
    }

    /// 没有 settings 表(库还没迁移完)时不许炸——启动路径上炸一次就是打不开应用。
    #[test]
    fn missing_settings_table_is_not_an_error() {
        let connection = Connection::open_in_memory().expect("内存库");
        assert!(!stored_fullscreen(&connection).expect("读"));
        save_fullscreen(&connection, true).expect("写");
    }
}
