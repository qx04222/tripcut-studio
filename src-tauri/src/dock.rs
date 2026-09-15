//! R18 车道 native2 / H-15:后台任务跑着的时候 Dock 图标显示进度条。
//!
//! 业主原则里「任务数徽标不做」——徽标是个数字,看了还得自己算还剩多少;
//! 进度条一眼就知道"快好了"还是"刚开始"。
//!
//! 判定是纯的:`DockProgress` 只吃「这一拍还有几条活儿」,吐「Dock 上要显示百分之几」。
//! 取数(SQL)与副作用(`set_progress_bar`)分开,所以"进度怎么算"在没有窗口、
//! 没有 Dock、没有数据库的情况下也能被单测钉死。

/// 一批后台任务的进度。峰值法:一批活儿最多的时候有几条,就拿它当分母;
/// 干完清零,下一批重新记峰值。
///
/// 为什么不记"这批一共几条":任务是滚进来的(导入一边扫一边入队),
/// 开跑那一刻的条数根本不是总数,拿它当分母会出现进度条走到 90% 又倒回去。
/// 峰值只增不减,进度因此单调不回头;新任务涌进来时峰值抬高,进度停住而不是倒退。
#[derive(Debug, Default)]
pub struct DockProgress {
    peak: u64,
}

impl DockProgress {
    pub fn new() -> Self {
        Self::default()
    }

    /// 这一拍要显示的百分比(0–100);`None` = 把 Dock 进度条清掉。
    pub fn observe(&mut self, active: u64) -> Option<u64> {
        if active == 0 {
            self.peak = 0;
            return None;
        }
        self.peak = self.peak.max(active);
        let done = self.peak - active;
        // 还有活儿的时候封到 99:满格配着还在转的任务是骗人的。
        Some((done * 100 / self.peak).min(99))
    }

    #[cfg(test)]
    fn peak(&self) -> u64 {
        self.peak
    }
}

/// 这一拍还有几条**值得显示**的活儿。空闲家务(`cache_gc`/`noop`)不算——
/// 与退出确认用的是同一份 `exit_guard::IDLE_KINDS`,两处对"算不算数"必须一致,
/// 否则会出现「Dock 上转着圈,关窗口却说没任务」。
pub fn active_job_count(connection: &rusqlite::Connection) -> rusqlite::Result<u64> {
    let mut statement = connection.prepare("SELECT kind FROM jobs WHERE status IN ('pending', 'running')")?;
    let kinds: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(crate::exit_guard::blocking_job_count(kinds.iter().map(String::as_str)) as u64)
}

/// 每一拍之间隔多久。1 秒:Dock 进度条不需要比这更灵敏,而每秒开一次库
/// 比常驻一个连接更不容易跟 worker 抢锁。
pub const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// 把一拍的判定结果落到 Dock 上。`None` 时发 `ProgressBarStatus::None` 清掉它。
pub fn apply<R: tauri::Runtime>(window: &tauri::Window<R>, percent: Option<u64>) {
    let state = match percent {
        Some(value) => tauri::window::ProgressBarState {
            status: Some(tauri::window::ProgressBarStatus::Normal),
            progress: Some(value),
        },
        None => tauri::window::ProgressBarState {
            status: Some(tauri::window::ProgressBarStatus::None),
            progress: None,
        },
    };
    if let Err(error) = window.set_progress_bar(state) {
        tracing::warn!(%error, "Dock 进度条没能更新");
    }
}

/// 起一根轮询线程:每秒数一次活儿,变了才写 Dock。
/// 读不到库当作"没活儿"——Dock 上留一根永远不动的条,比什么都不做更糟。
pub fn spawn_watcher<R: tauri::Runtime>(window: tauri::Window<R>, db_path: std::path::PathBuf) {
    std::thread::Builder::new()
        .name("dock-progress".to_owned())
        .spawn(move || {
            let mut progress = DockProgress::new();
            let mut shown: Option<Option<u64>> = None;
            loop {
                std::thread::sleep(POLL_INTERVAL);
                let active = crate::core::db::open_project(&db_path)
                    .ok()
                    .and_then(|connection| active_job_count(&connection).ok())
                    .unwrap_or(0);
                let next = progress.observe(active);
                if shown != Some(next) {
                    apply(&window, next);
                    shown = Some(next);
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|error| tracing::warn!(%error, "Dock 进度条线程没起来"));
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::core::{db, jobs, test_support::TestDirectory};

    /// 空闲家务不该让 Dock 转圈:与退出确认同一份判定。
    #[test]
    fn housekeeping_jobs_do_not_light_up_the_dock() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        assert_eq!(active_job_count(&connection).unwrap(), 0);

        jobs::enqueue(&mut connection, "cache_gc", "{}", "gc-1").unwrap();
        assert_eq!(active_job_count(&connection).unwrap(), 0, "缓存清理不算活儿");

        jobs::enqueue(&mut connection, "analyze_l1", "{}", "a-1").unwrap();
        jobs::enqueue(&mut connection, "transcribe", "{}", "t-1").unwrap();
        assert_eq!(active_job_count(&connection).unwrap(), 2);
    }

    /// 没活儿就不该在 Dock 上留一根条——「完成后清除」。
    #[test]
    fn idle_clears_the_dock_progress() {
        let mut progress = DockProgress::new();
        assert_eq!(progress.observe(0), None);
    }

    /// 一批 4 条:刚开始 0%,干掉一条 25%,干完清除并且峰值归零。
    #[test]
    fn a_batch_advances_from_zero_and_clears_when_done() {
        let mut progress = DockProgress::new();
        assert_eq!(progress.observe(4), Some(0));
        assert_eq!(progress.observe(3), Some(25));
        assert_eq!(progress.observe(1), Some(75));
        assert_eq!(progress.observe(0), None);
        assert_eq!(progress.peak(), 0, "干完要归零,下一批重新记峰值");
    }

    /// 滚进来的新任务只把峰值抬高,进度停住——绝不倒退。
    /// (导入是一边扫一边入队的,开跑那一刻的条数不是总数。)
    #[test]
    fn progress_never_goes_backwards_when_more_work_arrives() {
        let mut progress = DockProgress::new();
        assert_eq!(progress.observe(2), Some(0));
        assert_eq!(progress.observe(1), Some(50));
        // 又来了 9 条:峰值 2 → 10,还剩 10 条。进度回到 0 而不是负数,
        // 并且后面每一步都不会低于这一刻。
        assert_eq!(progress.observe(10), Some(0));
        assert_eq!(progress.observe(5), Some(50));
    }

    /// 还有活儿的时候不许显示 100%——满格的进度条配着还在转的任务是骗人。
    #[test]
    fn never_shows_full_while_work_remains() {
        let mut progress = DockProgress::new();
        progress.observe(200);
        assert_eq!(progress.observe(1), Some(99), "199/200 只能取到 99");
    }
}
