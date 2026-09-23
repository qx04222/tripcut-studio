//! R25：监视器取源策略。导出仍独立读取原片。
use std::{path::{Path, PathBuf}, time::{Duration, Instant}};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use libmpv2::Mpv;
use crate::core::{artifacts, canonical_time::{self, ProxyTimeMapper}, db, media_source, memory_profile, settings};
use super::PlayerStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewQuality { Auto, High, Original, Performance }
impl PreviewQuality {
    pub fn parse(value: &str) -> Self {
        match value { "high" => Self::High, "original" => Self::Original,
            "performance" => Self::Performance, _ => Self::Auto }
    }
    pub fn as_str(self) -> &'static str {
        match self { Self::Auto => "auto", Self::High => "high", Self::Original => "original", Self::Performance => "performance" }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind { Proxy, ProxyHq, Original }
impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self { Self::Proxy => "proxy", Self::ProxyHq => "proxy_hq", Self::Original => "original" }
    }
}
#[derive(Debug, Clone)]
pub struct SourceEntry { pub kind: SourceKind, pub path: PathBuf, pub mapper: Option<ProxyTimeMapper> }
#[derive(Debug, Clone)]
pub struct SourcePlan {
    /// 原片在「自动 / 性能优先」且已有代理时**延后**核验(外置盘要整文件哈希,不能压在打开路径上);
    /// 为 None 时不会切到原片,核验完由后台 `refresh_source_plan_for_clip` 补上。
    pub quality: PreviewQuality, pub original: Option<SourceEntry>, pub proxy: Option<SourceEntry>,
    pub proxy_hq: Option<SourceEntry>, pub low_memory: bool,
}
impl SourcePlan {
    pub fn entry(&self, kind: SourceKind) -> Option<&SourceEntry> {
        match kind { SourceKind::Original => self.original.as_ref(), SourceKind::Proxy => self.proxy.as_ref(), SourceKind::ProxyHq => self.proxy_hq.as_ref() }
    }
}
pub fn resolve_preview_plan(db_path: &Path, cache_root: &Path, clip_id: i64) -> Result<(Connection, SourcePlan), String> {
    resolve_preview_plan_with(db_path, cache_root, clip_id, false)
}
/// 打开路径先按档位决定要不要立刻核验原片:只有当前档位此刻就要读原片(原片档、缺 HQ 的高画质、
/// 没有代理、代理关闭、小尺寸源)才核验;核验失败但有代理时退回代理,不让离线外置盘挡住代理预览
/// (0.11.5 以前有代理就从不核验原片)。`force_original` 给后台补核验用。
pub fn resolve_preview_plan_with(db_path: &Path, cache_root: &Path, clip_id: i64, force_original: bool) -> Result<(Connection, SourcePlan), String> {
    let resolve = || -> crate::core::error::Result<_> {
        let connection = db::open_project(db_path)?;
        let quality = PreviewQuality::parse(&settings::string_value(&connection, settings::PREVIEW_QUALITY_KEY, "auto")?);
        let mut plan = SourcePlan { quality, original: None, proxy: None,
            proxy_hq: None, low_memory: memory_profile::resolve(&connection)?.low_memory_proxy() };
        let (width, height): (i64,i64) = connection.query_row("SELECT COALESCE(width,0),COALESCE(height,0) FROM clips WHERE id=?1", [clip_id], |r| Ok((r.get(0)?,r.get(1)?)))?;
        // 小尺寸原片不放大；关闭代理时不查询任何代理。原片档也查代理,但只在原片离线时兜底(角标如实写「代理」)。
        if settings::proxy_enabled(&connection)? && width.min(height) > 1080 {
            plan.proxy = cached_entry(&connection,cache_root,clip_id,SourceKind::Proxy)?;
            plan.proxy_hq = cached_entry(&connection,cache_root,clip_id,SourceKind::ProxyHq)?;
            if quality == PreviewQuality::High && plan.proxy_hq.is_none() {
                let enqueue = || -> crate::core::error::Result<_> {
                    // 映射丢失/文件被外部删除也属于缺 HQ；持写锁复查，避免抹掉刚完成的任务。
                    let transaction = rusqlite::Transaction::new_unchecked(&connection, rusqlite::TransactionBehavior::Immediate)?;
                    let ready = cached_entry(&transaction,cache_root,clip_id,SourceKind::ProxyHq)?;
                    if ready.is_none() {
                        transaction.execute("DELETE FROM cache_artifacts WHERE clip_id=?1 AND kind='proxy_hq'",[clip_id])?;
                        transaction.execute("DELETE FROM proxy_hq_time_map WHERE clip_id=?1",[clip_id])?;
                    }
                    transaction.commit()?;
                    if ready.is_none() { artifacts::enqueue_proxy_hq_if_needed(&connection,clip_id)?; }
                    Ok(ready)
                };
                match enqueue() {
                    Ok(ready) => plan.proxy_hq = ready,
                    Err(error) => tracing::warn!(%error, "高清代理入队失败，继续使用当前可用来源"),
                }
            }
        }
        if force_original || needs_original_now(&plan) {
            match media_source::verified_clip_path(&connection, clip_id) {
                Ok(path) => plan.original = Some(SourceEntry { kind: SourceKind::Original, path, mapper: None }),
                Err(error) if plan.proxy.is_some() || plan.proxy_hq.is_some() => {
                    tracing::warn!(%error, clip_id, "原片暂不可用,监视器退回代理");
                }
                Err(error) => return Err(error),
            }
        }
        Ok((connection,plan))
    };
    resolve().map_err(|e| e.to_string())
}
/// 当前档位此刻就要读原片吗(纯函数,`original` 尚未填)。
pub fn needs_original_now(plan: &SourcePlan) -> bool {
    match plan.quality {
        PreviewQuality::Original => true,
        PreviewQuality::High => plan.proxy_hq.is_none() && (!plan.low_memory || plan.proxy.is_none()),
        PreviewQuality::Auto | PreviewQuality::Performance => plan.proxy.is_none(),
    }
}
/// 原片是否被延后核验(自动档暂停看原片要它,后台补上)。
pub fn original_deferred(plan: &SourcePlan) -> bool {
    plan.original.is_none() && plan.quality == PreviewQuality::Auto && plan.proxy.is_some()
}
fn cached_entry(connection: &Connection, cache_root: &Path, clip_id: i64, kind: SourceKind) -> crate::core::error::Result<Option<SourceEntry>> {
    let relative: Option<String> = connection.query_row(
        "SELECT a.rel_path FROM cache_artifacts a JOIN clips c ON c.id=a.clip_id
         WHERE a.clip_id=?1 AND a.kind=?2 AND a.source_hash=c.quick_hash",
        rusqlite::params![clip_id,kind.as_str()], |r| r.get(0)).optional()?;
    let Some(relative) = relative else { return Ok(None); };
    let name = if kind == SourceKind::Proxy { artifacts::PROXY_FILE } else { artifacts::PROXY_HQ_FILE };
    if relative != format!("{clip_id}/{name}") { return Ok(None); }
    let path = cache_root.join(relative);
    // 缓存文件不能通过符号链接指回原片，touch 也只碰真正的缓存。
    if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file()) { return Ok(None); }
    let mapper = if kind == SourceKind::Proxy { canonical_time::load_proxy_mapper(connection,clip_id)? }
        else { canonical_time::load_proxy_hq_mapper(connection,clip_id)? };
    Ok(mapper.map(|mapper| SourceEntry { kind, path, mapper: Some(mapper) }))
}

pub fn initial_kind(plan: &SourcePlan) -> SourceKind {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    let order: &[SourceKind] = match plan.quality {
        PreviewQuality::Original => &[O, H, P],
        PreviewQuality::High if plan.low_memory => &[H, P, O],
        PreviewQuality::High => &[H, O, P],
        PreviewQuality::Auto | PreviewQuality::Performance => &[P, O, H],
    };
    order.iter().copied().find(|kind| plan.entry(*kind).is_some()).unwrap_or(O)
}
/// 自动档暂停去抖。真机(M5,4K50 HEVC 10-bit)载入原片到首帧 60–280 ms;去抖 150 ms + 50 ms 轮询粒度时
/// 暂停→原片 269–485 ms,贴着 0.5 s 验收线,所以降到 100 ms 并从 Pause 命令那一刻起算。
/// R26 P-3:真机量到去抖实际 113–171 ms(50 ms 轮询粒度);改为按剩余去抖精确唤醒(`debounce_wake`)并降到 80 ms。
/// 不再往下压:拖进度条 / 逐帧之间的停顿更容易被当成「暂停」而中途换源。
pub const AUTO_PAUSE_DEBOUNCE: Duration = Duration::from_millis(80);
/// 去抖未到时渲染线程该在多久后醒来补 `tick`(None = 不需要提前醒)。
pub fn debounce_wake(quality: PreviewQuality, paused: bool, eof: bool, paused_for: Duration, current: SourceKind) -> Option<Duration> {
    (quality == PreviewQuality::Auto && paused && !eof && current != SourceKind::Original && paused_for < AUTO_PAUSE_DEBOUNCE)
        .then(|| AUTO_PAUSE_DEBOUNCE - paused_for)
}
/// 可用来源由调用方检查，纯函数只负责时间与状态判定。
pub fn auto_target(quality: PreviewQuality, paused: bool, eof: bool, paused_for: Duration, current: SourceKind) -> Option<SourceKind> {
    if quality != PreviewQuality::Auto || eof { return None; }
    if paused && paused_for >= AUTO_PAUSE_DEBOUNCE && current != SourceKind::Original {
        Some(SourceKind::Original)
    } else if !paused && current == SourceKind::Original { Some(SourceKind::Proxy) } else { None }
}
pub fn swap_args(entry: &SourceEntry, seconds: f64, paused: bool) -> Vec<String> {
    let seconds = if seconds.is_finite() { seconds.max(0.0) } else { 0.0 };
    let mut args = super::loadfile_args(&entry.path.to_string_lossy(), Some(seconds), entry.mapper.as_ref());
    if !paused { args[3] = args[3].replace("pause=yes", "pause=no"); }
    args
}
/// `pending_seek`:换源载入期间来的 SeekAbs(源秒)。mpv 在新文件 playback 初始化前拒绝 seek / frame-step,
/// 直接执行会让命令报错、渲染线程退出,所以载入期间先记下,PlaybackRestart 后补做。
pub struct SwapInFlight { pub started: Instant, pub target_source_seconds: f64, pub resume: bool, pub pending_seek: Option<f64> }
/// 新文件迟迟不出首帧(源盘掉线、解码失败)时放弃等待,别让状态永远冻在换源中。
pub const SWAP_WATCHDOG: Duration = Duration::from_secs(3);
pub struct SourceSwitcher {
    pub plan: Option<SourcePlan>, pub current: SourceKind,
    current_mapper: Option<ProxyTimeMapper>, pub swapping: Option<SwapInFlight>,
    pub paused_since: Option<Instant>, loaded: bool, queued_kind: Option<SourceKind>,
    pub last_switch_ms: Option<f64>, pub last_error_s: Option<f64>,
    /// mpv `eof-reached` 的观察值(事件驱动,不在渲染线程同步读)。
    pub eof: bool, vo_drops: i64, decoder_drops: i64,
}
impl SourceSwitcher {
    pub fn new(mapper: Option<ProxyTimeMapper>) -> Self {
        Self { plan: None, current: if mapper.is_some() { SourceKind::Proxy } else { SourceKind::Original },
            current_mapper: mapper, swapping: None, paused_since: None, loaded: false, queued_kind: None, last_switch_ms: None, last_error_s: None, eof: false, vo_drops: 0, decoder_drops: 0 }
    }
    pub fn install(&mut self, plan: SourcePlan, opened: SourceKind, status: &mut PlayerStatus) {
        // 刷新计划时保留实际已打开文件的映射，Original 档计划可不含任何代理。
        if self.plan.is_none() {
            self.current = opened;
            self.current_mapper = plan.entry(opened).and_then(|e| e.mapper.clone());
        }
        self.plan = Some(plan);
        self.publish(status);
    }
    pub fn mapper(&self) -> Option<&ProxyTimeMapper> { self.current_mapper.as_ref() }
    fn publish(&self, status: &mut PlayerStatus) {
        status.source_kind = Some(self.current.as_str().into());
        status.preview_quality = self.plan.as_ref().map(|p| p.quality.as_str().into());
        status.source_switch_ms = self.last_switch_ms;
        status.source_switch_error_s = self.last_error_s;
    }
    pub fn begin_swap(&mut self, mpv: &Mpv, target: SourceKind, seconds: f64, paused: bool) -> Result<(), String> {
        if let Some(swap) = &mut self.swapping {
            swap.resume = !paused;
            self.queued_kind = (target != self.current).then_some(target);
            return Ok(());
        }
        if target == self.current { return Ok(()); }
        let Some(entry) = self.plan.as_ref().and_then(|p| p.entry(target)) else { return Ok(()); };
        let args = swap_args(entry, seconds.max(0.0), paused);
        mpv.command("loadfile", &args.iter().map(String::as_str).collect::<Vec<_>>()).map_err(|e| e.to_string())?;
        tracing::debug!(from = self.current.as_str(), to = target.as_str(), seconds, paused, "preview source switch begin");
        if target != SourceKind::Original {
            if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&entry.path) {
                let _ = file.set_modified(std::time::SystemTime::now());
            }
        }
        self.current_mapper = entry.mapper.clone();
        self.current = target;
        self.swapping = Some(SwapInFlight { started: Instant::now(), target_source_seconds: seconds, resume: !paused, pending_seek: None });
        self.loaded = false;
        Ok(())
    }
    pub fn file_loaded(&mut self) { self.loaded = true; self.eof = false; self.vo_drops = 0; self.decoder_drops = 0; }
    /// 两个掉帧计数各自的最新观察值求和(事件驱动,不回头同步读另一个)。
    pub fn record_drops(&mut self, name: &str, value: i64) -> i64 {
        if name == "decoder-frame-drop-count" { self.decoder_drops = value.max(0); } else { self.vo_drops = value.max(0); }
        self.vo_drops + self.decoder_drops
    }
    pub fn on_playback_restart(&mut self, mpv: &Mpv, status: &mut PlayerStatus) {
        // 旧文件排队的 restart 不能提前结束新文件切换。
        if !self.loaded { return; }
        if let Some(swap) = self.swapping.take() {
            let position = mpv.get_property::<f64>("time-pos").ok().filter(|p| p.is_finite());
            if let Some(position) = position {
                status.pos = self.mapper().map(|m| m.source_seconds_for_proxy_seconds(position)).unwrap_or(position);
            }
            // 载入期间用户仍可暂停/播放，以最后一次意图为准。
            if let Err(error) = mpv.set_property("pause", !swap.resume) { tracing::warn!(%error,"换源后更新暂停态失败"); }
            status.paused = !swap.resume;
            status.frame = mpv.get_property("estimated-frame-number").ok();
            // R26:宽高与来源同一刻发布(换源中的观察值被屏蔽),角标不会出现「代理 2160p」这种半新半旧。
            status.source_width = mpv.get_property("width").ok();
            status.source_height = mpv.get_property("height").ok();
            status.dropped_frames = Some(0);
            self.last_switch_ms = Some(swap.started.elapsed().as_secs_f64()*1000.0);
            self.last_error_s = position.map(|_| (status.pos-swap.target_source_seconds).abs());
            // R25 真机取证:换源耗时(loadfile → 新文件 PlaybackRestart)与时码误差,`TRIPCUT_LOG=debug` 下可读。
            tracing::debug!(kind = self.current.as_str(), ms = self.last_switch_ms, error_s = self.last_error_s,
                target_s = swap.target_source_seconds, "preview source switched");
            status.mark_ready();
            self.publish(status);
            if let Some(seconds) = swap.pending_seek {
                let target = self.mapper().map(|m| m.proxy_seconds_for_source_seconds(seconds)).unwrap_or(seconds);
                match mpv.command("seek", &[&format!("{target:.6}"), "absolute+exact"]) {
                    Ok(()) => status.pos = seconds,
                    Err(error) => tracing::warn!(%error, "换源后补做定位失败"),
                }
            }
            if let Some(target) = self.queued_kind.take() {
                if let Err(error) = self.begin_swap(mpv,target,status.pos,status.paused) { tracing::warn!(%error,"排队换源失败"); }
            }
        }
    }
    /// 下次该醒来的时刻(去抖剩余);换源中 / 没有计划时不提前醒。
    pub fn next_wake(&self, paused: bool) -> Option<Duration> {
        if self.swapping.is_some() { return None; }
        let plan = self.plan.as_ref()?;
        let paused_for = self.paused_since.map_or(Duration::ZERO, |since| since.elapsed());
        debounce_wake(plan.quality, paused, self.eof, paused_for, self.current)
    }
    /// 用户按下暂停的时刻就是去抖起点(不等下一次 tick 才发现已暂停)。
    pub fn note_pause_command(&mut self) { self.paused_since = Some(Instant::now()); }
    /// 载入期间的 SeekAbs / 逐帧:记下或吞掉,返回 true 表示这条命令已处理(不要再交给 mpv)。
    pub fn defer_during_swap(&mut self, command: &super::PlayerCommand) -> bool {
        let Some(swap) = &mut self.swapping else { return false; };
        match command {
            super::PlayerCommand::SeekAbs { seconds } => { swap.pending_seek = Some(*seconds); true }
            super::PlayerCommand::StepFwd | super::PlayerCommand::StepBack => { swap.resume = false; true }
            _ => false,
        }
    }
    pub fn tick(&mut self, mpv: &Mpv, status: &mut PlayerStatus) {
        if self.swapping.as_ref().is_some_and(|swap| swap.started.elapsed() >= SWAP_WATCHDOG) {
            tracing::warn!(kind = self.current.as_str(), "换源 3 秒未出首帧,放弃等待");
            self.swapping = None;
            self.queued_kind = None;
            status.paused = mpv.get_property("pause").unwrap_or(true);
        }
        if self.swapping.is_some() || status.phase != "ready" { return; }
        let Some(plan) = &self.plan else { return; };
        let elapsed = if status.paused { self.paused_since.get_or_insert_with(Instant::now).elapsed() }
            else { self.paused_since = None; Duration::ZERO };
        if let Some(target) = auto_target(plan.quality,status.paused,self.eof,elapsed,self.current) {
            if let Err(error) = self.begin_swap(mpv,target,status.pos,status.paused) { tracing::warn!(%error,"自动换源失败"); }
        }
    }
    pub fn before_play(&mut self, mpv: &Mpv, status: &mut PlayerStatus) -> bool {
        if self.plan.as_ref().is_some_and(|p| p.quality == PreviewQuality::Auto && p.proxy.is_some()) && self.current == SourceKind::Original && !self.eof {
            match self.begin_swap(mpv,SourceKind::Proxy,status.pos,false) {
                Ok(()) => { status.paused = false; self.paused_since = None; return true; }
                Err(error) => tracing::warn!(%error,"播放前切代理失败"),
            }
        }
        // 用户在载入期间更改播放意图，完成事件应遵从最新意图。
        if let Some(swap) = &mut self.swapping { swap.resume = true; }
        false
    }
    pub fn set_quality(&mut self, mpv: &Mpv, status: &mut PlayerStatus, quality: PreviewQuality) -> Result<(), String> {
        let Some(plan) = &mut self.plan else { return Ok(()); };
        plan.quality = quality;
        let target = initial_kind(plan);
        self.publish(status);
        self.begin_swap(mpv,target,status.pos,status.paused)
    }
}

#[cfg(test)]
#[path = "preview_source_tests.rs"]
mod tests;
