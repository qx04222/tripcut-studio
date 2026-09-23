//! R29:播放诊断(`TRIPCUT_PLAYER_DIAG=1` 才开)。每秒一行 `player diag`(debug 级):实际呈现帧率(本线程
//! 真正画到屏上的帧数)、两种掉帧各自的增量、mpv 的解码 / 显示参数、每帧 render / flushBuffer 耗时、
//! 抽样 glFinish(GPU 剩余工作)与交换间隔。默认关闭:不观察任何额外属性、不多调一次 GL。
use std::{collections::BTreeMap, ffi::c_void, time::{Duration, Instant}};
use libmpv2::{events::PropertyData, Format, Mpv};

/// 观察 id 从 100 起,和 `mod.rs` 的 1–9 不冲突。全部按字符串观察,mpv 负责格式化。
pub const DIAG_PROPS: &[&str] = &[
    "hwdec-current", "video-params/pixelformat", "video-params/hw-pixelformat", "video-params/gamma",
    "video-params/primaries", "container-fps", "estimated-vf-fps", "display-fps", "estimated-display-fps",
    "speed", "video-sync", "vo-delayed-frame-count", "mistimed-frame-count", "vsync-jitter",
];
pub const DIAG_ID_BASE: u64 = 100;

pub fn enabled_from_env(value: Option<String>) -> bool {
    value.is_some_and(|v| { let v = v.trim(); !v.is_empty() && v != "0" })
}

pub fn observe(mpv: &Mpv) {
    for (index, name) in DIAG_PROPS.iter().enumerate() {
        if let Err(error) = mpv.observe_property(name, Format::String, DIAG_ID_BASE + index as u64) {
            tracing::debug!(%error, name, "诊断属性观察失败");
        }
    }
}

#[derive(Default)]
pub struct Diag {
    pub on: bool,
    props: BTreeMap<&'static str, String>,
    window_start: Option<Instant>,
    frames: u32,
    render: Duration,
    vo: i64, dec: i64, vo_mark: i64, dec_mark: i64,
    pub gpu: GpuTimer,
    flush: Duration,
    finish_ns: u64, finish_n: u32,
    swap_interval: Option<i32>,
}
impl Diag {
    pub fn new(on: bool) -> Self { Self { on, ..Self::default() } }
    /// 诊断属性的观察值;返回 true 表示这条事件是诊断用的(调用方不再处理)。
    pub fn on_property(&mut self, name: &str, change: &PropertyData) -> bool {
        let Some(key) = DIAG_PROPS.iter().find(|p| **p == name) else { return false; };
        let value = match change { PropertyData::Str(v) | PropertyData::OsdStr(v) => (*v).to_owned(),
            PropertyData::Double(v) => format!("{v:.3}"), PropertyData::Int64(v) => v.to_string(), PropertyData::Flag(v) => v.to_string() };
        self.props.insert(key, value);
        true
    }
    pub fn drops(&mut self, name: &str, value: i64) {
        if name == "decoder-frame-drop-count" { self.dec = value; } else { self.vo = value; }
    }
    pub fn frame(&mut self, render: Duration) {
        if !self.on { return; }
        self.frames += 1;
        self.render += render;
        if let Some(sample) = self.gpu.take_sample() { self.flush += sample.flush; if let Some(ns) = sample.finish_ns { self.finish_ns += ns; self.finish_n += 1; } }
        if self.swap_interval.is_none() { self.swap_interval = Some(swap_interval()); }
    }
    /// 每秒至多一行;`kind` = 当前来源,`playing` 为假时只重置窗口。
    pub fn tick(&mut self, kind: &str, playing: bool) {
        if !self.on { return; }
        let now = Instant::now();
        let start = *self.window_start.get_or_insert(now);
        if !playing { self.reset(now); return; }
        let elapsed = now.saturating_duration_since(start);
        if elapsed < Duration::from_secs(1) { return; }
        let secs = elapsed.as_secs_f64();
        let fps = f64::from(self.frames) / secs;
        let render_ms = if self.frames > 0 { self.render.as_secs_f64() * 1000.0 / f64::from(self.frames) } else { 0.0 };
        let flush_ms = if self.frames > 0 { self.flush.as_secs_f64() * 1000.0 / f64::from(self.frames) } else { 0.0 };
        let finish_ms = if self.finish_n > 0 { self.finish_ns as f64 / 1e6 / f64::from(self.finish_n) } else { -1.0 };
        let props = self.props.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ");
        tracing::debug!(kind, presented_fps = format!("{fps:.1}"), vo_drops = self.vo - self.vo_mark, dec_drops = self.dec - self.dec_mark,
            render_ms = format!("{render_ms:.2}"), flush_ms = format!("{flush_ms:.2}"), finish_ms = format!("{finish_ms:.2}"), swap_interval = self.swap_interval.unwrap_or(-9), props = props.as_str(), "player diag");
        self.reset(now);
    }
    fn reset(&mut self, now: Instant) {
        self.window_start = Some(now); self.frames = 0; self.render = Duration::ZERO;
        self.flush = Duration::ZERO; self.finish_ns = 0; self.finish_n = 0;
        self.vo_mark = self.vo; self.dec_mark = self.dec;
    }
}

/// 每帧:flushBuffer 耗时(看是否被垂直同步挡住);每 50 帧一次:render 返回后 glFinish 等 GPU 做完的时长。
/// (GL_TIME_ELAPSED 计时查询在 Apple Silicon 的 GL 上恒返回 0,真机实测不可用,所以用 glFinish 抽样。)
#[derive(Default)]
pub struct GpuTimer { count: u32, sample: Option<FrameSample>, flush_start: Option<Instant> }
pub struct FrameSample { pub flush: Duration, pub finish_ns: Option<u64> }
extern "C" { fn glFinish(); fn CGLGetCurrentContext() -> *mut c_void; fn CGLGetParameter(ctx: *mut c_void, pname: i32, value: *mut i32) -> i32; }
/// 当前上下文的 kCGLCPSwapInterval(222):1 = flushBuffer 等垂直同步。
fn swap_interval() -> i32 {
    let mut value = -1;
    // SAFETY: 渲染线程持有当前上下文;输出指针指向栈上变量。
    unsafe { let ctx = CGLGetCurrentContext(); if !ctx.is_null() { CGLGetParameter(ctx, 222, &mut value); } }
    value
}
impl GpuTimer {
    /// render 之后、flushBuffer 之前调用(在 CGL 锁内)。
    pub fn after_render(&mut self) {
        self.count = self.count.wrapping_add(1);
        let mut finish_ns = None;
        if self.count.is_multiple_of(50) {
            let started = Instant::now();
            // SAFETY: 当前线程持有 GL 上下文。
            unsafe { glFinish(); }
            finish_ns = Some(started.elapsed().as_nanos() as u64);
        }
        self.sample = Some(FrameSample { flush: Duration::ZERO, finish_ns });
        self.flush_start = Some(Instant::now());
    }
    pub fn after_flush(&mut self) {
        if let (Some(sample), Some(start)) = (&mut self.sample, self.flush_start.take()) { sample.flush = start.elapsed(); }
    }
    fn take_sample(&mut self) -> Option<FrameSample> { self.sample.take() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diag_is_opt_in() {
        assert!(!enabled_from_env(None));
        for off in ["", " ", "0"] { assert!(!enabled_from_env(Some(off.into()))); }
        assert!(enabled_from_env(Some("1".into())));
    }
    #[test]
    fn diag_ignores_foreign_properties_and_stores_its_own() {
        let mut diag = Diag::new(true);
        assert!(!diag.on_property("time-pos", &PropertyData::Double(1.0)));
        assert!(diag.on_property("hwdec-current", &PropertyData::Str("videotoolbox")));
        assert_eq!(diag.props.get("hwdec-current").map(String::as_str), Some("videotoolbox"));
    }
}
