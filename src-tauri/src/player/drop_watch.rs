//! R28:原片播放「持续」掉帧的判定(自动档据此退代理,见 `preview_source::SourceSwitcher`)。
use std::{collections::VecDeque, time::{Duration, Instant}};

/// R28:原片播放「持续」掉帧的判定。开播(或换源、定位、恢复播放)后先给 `DEGRADE_GRACE` 起步宽限
/// (载入瞬间的掉帧不算);之后最近 `DEGRADE_WINDOW` 内掉 ≥ `DEGRADE_DROPS` 帧(50p 下 10%),且掉帧分散在
/// ≥ `DEGRADE_SPREAD_SECS` 个不同的秒里才算。真机:业主机被别的程序抢一下时,0.3 s 内一口气掉 15 帧,
/// 同一时刻 1080p 代理也一样掉 —— 那是整机卡顿,不是解不动原片,不该因此把监视器降成代理。
pub const DEGRADE_GRACE: Duration = Duration::from_secs(3);
pub const DEGRADE_WINDOW: Duration = Duration::from_secs(6);
pub const DEGRADE_DROPS: i64 = 30;
pub const DEGRADE_SPREAD_SECS: usize = 4;
#[derive(Debug, Default)]
pub struct DropWatch { armed: Option<Instant>, samples: VecDeque<(Instant, i64)> }
impl DropWatch {
    /// 渲染线程每轮报一次「此刻是否在播原片」;不在就清空,重新进入时从头计宽限。
    pub fn set_eligible(&mut self, now: Instant, eligible: bool) {
        if !eligible { self.armed = None; self.samples.clear(); }
        else if self.armed.is_none() { self.armed = Some(now); }
    }
    /// 记一次累计掉帧观察值;返回 true 表示掉帧成片。
    pub fn observe(&mut self, now: Instant, total: i64) -> bool {
        let Some(armed) = self.armed else { return false; };
        if now.saturating_duration_since(armed) < DEGRADE_GRACE { self.samples.clear(); self.samples.push_back((now, total)); return false; }
        self.samples.push_back((now, total));
        while self.samples.len() > 1 && self.samples.front().is_some_and(|(t, _)| now.saturating_duration_since(*t) > DEGRADE_WINDOW) {
            self.samples.pop_front();
        }
        let Some(&(_, first)) = self.samples.front() else { return false; };
        // 掉帧落在哪些秒里:只数计数真的涨了的观察点。
        let mut seconds: Vec<u64> = self.samples.iter().zip(self.samples.iter().skip(1))
            .filter(|(before, after)| after.1 > before.1)
            .map(|(_, after)| after.0.saturating_duration_since(armed).as_secs()).collect();
        seconds.dedup();
        total - first >= DEGRADE_DROPS && seconds.len() >= DEGRADE_SPREAD_SECS
    }
}
