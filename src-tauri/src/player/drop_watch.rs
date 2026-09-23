//! 原片「播不动」的判定(自动档据此退代理,见 `preview_source::SourceSwitcher`)。
//!
//! R29 改判据:只看**观看者实际看到的帧率** —— 渲染线程每真正画到屏上一帧记一次(`frame`),每满 1 秒
//! 结一个桶:这一秒呈现的帧数低于「应有帧率」的 90% 就是坏秒。起步 / 换源 / 定位 / 恢复播放 / 解除遮挡后
//! 先给 `DEGRADE_GRACE` 宽限;之后最近 `DEGRADE_WINDOW_SECS` 个桶里坏秒 ≥ `DEGRADE_BAD_SECS` 才算播不动。
//!
//! 为什么不再数 mpv 的 `frame-drop-count`(R28 的判据):监视器被 DOM 覆盖层(导入 / 交付抽屉、设置、命令
//! 面板、帮助、首页、引导气泡)盖住时原生视图不画(`hidden`),mpv 照常播,等不到渲染的每一帧都被 vo_libmpv
//! 在 200 ms 超时后记成掉帧 —— 真机 50p 素材每秒「掉」50–60 帧,6 秒内必定降级到 540p(R29 真机:打开
//! 「导入素材」12 秒,原片 → 代理 → 回原片并锁死)。那不是原片播不动,是没让它画。遮挡期间、非 1 倍速
//! 期间都不评判(调用方经 `set_eligible` 控制),应有帧率也封顶 60(素材帧率高于屏幕刷新时不苛求)。
use std::{collections::VecDeque, time::{Duration, Instant}};

pub const DEGRADE_GRACE: Duration = Duration::from_secs(3);
pub const DEGRADE_WINDOW_SECS: usize = 6;
pub const DEGRADE_BAD_SECS: usize = 4;
/// 一秒里呈现帧数低于应有帧率的这个比例就是坏秒。
pub const PRESENTED_RATIO: f64 = 0.9;
/// 应有帧率封顶:60 Hz 屏上 120p 素材本来就只能呈现 60 帧。
pub const EXPECTED_FPS_CAP: f64 = 60.0;

#[derive(Debug, Default)]
pub struct DropWatch { armed: Option<Instant>, bucket_start: Option<Instant>, frames: u32, bad: VecDeque<bool> }
impl DropWatch {
    /// 渲染线程每轮报一次「此刻是否在评判」(正在 1 倍速播、没被遮挡、不在换源);不在就清空,
    /// 重新进入时从头计宽限。
    pub fn set_eligible(&mut self, now: Instant, eligible: bool) {
        if !eligible { *self = Self::default(); }
        else if self.armed.is_none() { self.armed = Some(now); }
    }
    /// 真正画到屏上的一帧。
    pub fn frame(&mut self, now: Instant) {
        if self.bucket_start.is_some_and(|start| now >= start) { self.frames += 1; }
    }
    /// 结算到 `now` 为止的整秒桶;返回 true 表示「持续播不动」。`source_fps` 未知(≤0)时不评判。
    pub fn observe(&mut self, now: Instant, source_fps: f64) -> bool {
        let Some(armed) = self.armed else { return false; };
        if source_fps.is_nan() || source_fps <= 0.0 { return false; }
        let start = *self.bucket_start.get_or_insert(armed + DEGRADE_GRACE);
        if now < start { self.frames = 0; return false; }
        let elapsed = now.saturating_duration_since(start);
        if elapsed < Duration::from_secs(1) { return false; }
        let expected = source_fps.min(EXPECTED_FPS_CAP) * elapsed.as_secs_f64();
        self.bad.push_back(f64::from(self.frames) < PRESENTED_RATIO * expected);
        while self.bad.len() > DEGRADE_WINDOW_SECS { self.bad.pop_front(); }
        self.bucket_start = Some(now);
        self.frames = 0;
        self.bad.iter().filter(|bad| **bad).count() >= DEGRADE_BAD_SECS
    }
}
