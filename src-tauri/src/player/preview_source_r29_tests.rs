//! R29:播不动判据(呈现帧率)、遮挡 / 倍速 / 不在屏上不评判、本次会话按素材记住的决定。
use super::*;

/// R29 迁移自 R28 `r28_drop_watch_needs_sustained_spread_drops_after_grace`:判据从「mpv 掉帧计数」改成
/// 「实际呈现帧率」,R28 的三条意图(起步宽限、单次卡顿不降级、零星掉帧不成片)原样保留。
#[test]
fn r29_drop_watch_judges_presented_frames_after_grace() {
    let t0 = Instant::now(); let at = |ms: u64| t0 + Duration::from_millis(ms);
    // 以 `fps` 帧/秒在 [from, to) 毫秒内呈现,每 50 ms 结算一次(渲染线程 tick 粒度);返回是否判成播不动。
    fn run(w: &mut DropWatch, at: &dyn Fn(u64) -> Instant, from: u64, to: u64, fps: u64, source: f64) -> bool {
        let mut hit = false; let mut next_frame = from as f64; let step = if fps == 0 { f64::INFINITY } else { 1000.0 / fps as f64 };
        let mut t = from;
        while t < to {
            while next_frame < (t + 50) as f64 && next_frame < to as f64 { w.frame(at(next_frame as u64)); next_frame += step; }
            t += 50; hit |= w.observe(at(t), source);
        }
        hit
    }
    let mut w = DropWatch::default();
    assert!(!w.observe(at(0), 50.0), "未开播不计");
    w.set_eligible(at(0), true);
    assert!(!run(&mut w, &at, 0, 3000, 0, 50.0), "起步宽限内一帧没画也不算");
    assert!(!run(&mut w, &at, 3000, 23_000, 50, 50.0), "满帧 20 秒不降级");
    // 单次卡顿:一秒里只画 35 帧,其余满帧 —— 不降级。
    assert!(!run(&mut w, &at, 23_000, 24_000, 35, 50.0));
    assert!(!run(&mut w, &at, 24_000, 34_000, 50, 50.0), "单次卡顿不降级");
    // 零星丢帧:每秒 47 帧(94%)永远不成片。
    assert!(!run(&mut w, &at, 34_000, 54_000, 47, 50.0), "零星丢帧不降级");
    // 持续播不动:每秒只画 40 帧(80%),5 秒内判定。
    assert!(run(&mut w, &at, 54_000, 60_000, 40, 50.0), "持续低于 90% 要降级");
    // 素材帧率未知不评判;120p 素材在 60 Hz 屏上呈现 58 帧不算坏(应有帧率封顶 60)。
    let mut w = DropWatch::default(); w.set_eligible(at(0), true);
    assert!(!run(&mut w, &at, 0, 20_000, 0, 0.0), "帧率未知不评判");
    let mut w = DropWatch::default(); w.set_eligible(at(0), true);
    assert!(!run(&mut w, &at, 0, 20_000, 58, 120.0), "高帧率素材按 60 封顶");
    // 不合格(暂停 / 遮挡 / 倍速)清零,重新进入重新计宽限。
    w.set_eligible(at(30_000), false); w.set_eligible(at(30_000), true);
    assert!(!run(&mut w, &at, 30_000, 33_000, 0, 50.0));
}
/// R29 根因:监视器被覆盖层盖住(导入 / 交付抽屉、设置、命令面板、帮助、首页、引导气泡)时原生视图不画,
/// mpv 把每一帧都记成掉帧(真机 50p 每秒 50–60 帧),R28 的判据 6 秒内就把自动档降成 540p。
#[test]
fn r29_hidden_monitor_and_non_1x_speed_never_count_as_cannot_play() {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    let plan = SourcePlan { quality: PreviewQuality::Auto, original: Some(entry(O)), proxy: Some(entry(P)),
        proxy_hq: Some(entry(H)), low_memory: false, original_external: false };
    let mut status = PlayerStatus::closed(); status.phase = "ready".into(); status.paused = false;
    let mut sw = SourceSwitcher::new(None);
    sw.install(plan, O, &mut status);
    sw.set_source_fps(50.0);
    let t0 = Instant::now();
    // 遮挡中 20 秒:一帧没画、mpv 掉帧计数每秒涨 55。
    sw.set_hidden(true);
    for i in 0..400u64 {
        sw.record_drops("frame-drop-count", (i * 55 / 20) as i64);
        sw.update_watch(t0 + Duration::from_millis(i * 50), true);
    }
    assert!(!sw.drop_burst, "被覆盖层盖住不是原片播不动");
    // 解除遮挡、2 倍速 20 秒:不评判。
    sw.set_hidden(false); sw.set_speed(2.0);
    for i in 400..800u64 { sw.update_watch(t0 + Duration::from_millis(i * 50), true); }
    assert!(!sw.drop_burst, "倍速不评判");
    // 1 倍速、看得见、却一帧都画不出来:这才是播不动。
    sw.set_speed(1.0);
    for i in 800..1100u64 { sw.update_watch(t0 + Duration::from_millis(i * 50), true); }
    assert!(sw.drop_burst, "看得见且 1 倍速仍画不出帧才判播不动");
}
/// R29:降级后同一素材下次打开直接用代理(1080p 优先);换素材重新判。
#[test]
fn r29_session_remembers_degrade_per_clip() {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    use super::auto_memory::{forget, open_kind, remember, AutoDecision};
    let plan = |hq: bool| SourcePlan { quality: PreviewQuality::Auto, original: Some(entry(O)), proxy: Some(entry(P)),
        proxy_hq: hq.then(|| entry(H)), low_memory: false, original_external: false };
    let (clip, other) = (9_290_001_i64, 9_290_002_i64);
    forget(clip); forget(other);
    assert_eq!(open_kind(&plan(true), clip, false), O, "没判过:原片");
    remember(clip, AutoDecision::Degraded);
    assert_eq!(open_kind(&plan(true), clip, false), H, "判过播不动:开播直接 1080p");
    assert_eq!(open_kind(&plan(false), clip, false), P, "还没有 1080p 时先 540p");
    assert_eq!(open_kind(&plan(true), clip, true), O, "暂停打开仍看原片");
    assert_eq!(open_kind(&plan(true), other, false), O, "换素材重新判");
    let mut status = PlayerStatus::closed(); status.phase = "ready".into(); status.clip_id = Some(clip);
    let mut sw = SourceSwitcher::new(None);
    sw.install(plan(true), H, &mut status);
    assert!(sw.degraded && sw.plays_proxy());
    assert_eq!(status.auto_policy.as_deref(), Some("degraded"));
    remember(other, AutoDecision::Blocked);
    let mut status = PlayerStatus::closed(); status.clip_id = Some(other);
    let mut sw = SourceSwitcher::new(None);
    sw.install(plan(true), O, &mut status);
    assert!(sw.degrade_blocked && !sw.degraded, "整机忙锁回原片的决定也记住");
    forget(clip); forget(other);
}
/// R29:窗口最小化 / 被整个盖住 / 应用隐藏时 AppKit 把画帧节流到每秒个位数(真机最小化后 0.8–8 帧/秒),
/// 与 DOM 遮挡一样不评判 —— 源码门禁钉住「不在屏上」并进 `set_hidden`。
#[test]
fn r29_offscreen_window_is_treated_like_hidden_monitor() {
    let source = include_str!("mod.rs");
    assert!(source.contains("fn probe_window_visible("), "要有主线程上的窗口在屏探测");
    assert!(source.contains("isMiniaturized()") && source.contains("NSWindowOcclusionState::Visible"));
    assert!(source.contains("switcher.set_hidden(hidden || !seen_visible);"), "每轮把不在屏上并进遮挡");
    assert!(source.contains("switcher.set_hidden(occluded || !seen_visible);"), "DOM 遮挡变化时也带上在屏状态");
}
