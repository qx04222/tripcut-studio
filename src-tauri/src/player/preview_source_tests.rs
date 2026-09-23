use super::*;
use crate::core::{test_support::TestDirectory, canonical_time::ProxyTimePoint};

fn entry(kind: SourceKind) -> SourceEntry { SourceEntry { kind, path: "/素材,a:b.mov".into(), mapper: None } }
#[test]
fn r25_initial_truth_table() {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    // 顺序：proxy × hq × low_memory，各维先 false 后 true。
    for (quality, expected) in [
        // R28:自动档标准机一直原片;省内存机播放用代理(1080p 优先)。
        (PreviewQuality::Auto, [O,O,O,H,O,P,O,H]),
        (PreviewQuality::High, [O,O,H,H,O,P,H,H]),
        (PreviewQuality::Original, [O,O,O,O,O,O,O,O]),
        (PreviewQuality::Performance, [O,O,O,O,P,P,P,P]),
    ] {
        let mut index = 0;
        for proxy in [false,true] { for hq in [false,true] { for low in [false,true] {
            let plan = SourcePlan { quality, original: Some(entry(SourceKind::Original)), proxy: proxy.then(||entry(SourceKind::Proxy)),
                proxy_hq: hq.then(||entry(SourceKind::ProxyHq)), low_memory: low, original_external: false };
            assert_eq!(initial_kind(&plan),expected[index],"{quality:?} {proxy} {hq} {low}");
            index += 1;
        } } }
    }
}
#[test]
fn r25_auto_debounce_eof_and_serialization() {
    // R26 P-3:去抖 100 → 80 ms(唤醒改为按剩余去抖精确定时,不再吃 50 ms 轮询粒度)。
    for ms in [0,79,80,81] {
        assert_eq!(auto_target(PreviewQuality::Auto,true,true,false,Duration::from_millis(ms),SourceKind::Proxy),
            (ms>=80).then_some(SourceKind::Original));
    }
    assert_eq!(auto_target(PreviewQuality::Auto,true,true,true,Duration::from_secs(1),SourceKind::Proxy),None);
    assert_eq!(auto_target(PreviewQuality::Auto,true,false,false,Duration::ZERO,SourceKind::Original),Some(SourceKind::Proxy));
    for q in [PreviewQuality::High,PreviewQuality::Original,PreviewQuality::Performance] {
        assert_eq!(auto_target(q,true,true,false,Duration::from_secs(1),SourceKind::Proxy),None);
    }
    for (kind,name) in [(SourceKind::Proxy,"proxy"),(SourceKind::ProxyHq,"proxy_hq"),(SourceKind::Original,"original")] {
        assert_eq!(serde_json::to_value(kind).unwrap(),name);
    }
    for value in ["", "bad", "auto"] { assert_eq!(PreviewQuality::parse(value),PreviewQuality::Auto); }
}
#[test]
fn r25_swap_uses_target_map_and_separate_path() {
    let mut source = entry(SourceKind::ProxyHq);
    source.mapper = ProxyTimeMapper::from_points(1,1000,vec![ProxyTimePoint { proxy_ts_ms:0,source_ticks:0 },ProxyTimePoint { proxy_ts_ms:5000,source_ticks:10000 }]);
    assert_eq!(swap_args(&source,7.4,true),["/素材,a:b.mov","replace","-1","start=3.7,pause=yes"]);
    assert_eq!(swap_args(&source,7.4,false)[3],"start=3.7,pause=no");
    assert_eq!(swap_args(&entry(SourceKind::Original),7.4,true)[3],"start=7.4,pause=yes");
}
#[test]
fn r25_status_closed_serializes_all_new_fields() {
    let value = serde_json::to_value(PlayerStatus::closed()).unwrap();
    for field in ["source_kind","source_width","source_height","preview_quality","source_switch_ms","source_switch_error_s","dropped_frames"] {
        assert!(value.as_object().unwrap().contains_key(field)); assert!(value[field].is_null());
    }
}
/// 档位不跟测试机内存走:省内存(`low`)或标准(`standard`),低配开关关掉。
fn machine(c: &Connection, low: bool) {
    settings::set_setting(c, settings::MEMORY_PROFILE_KEY, if low { "low" } else { "standard" }).unwrap();
    settings::set_setting(c, settings::LOW_SPEC_MODE_KEY, "off").unwrap();
}
fn fixture() -> (TestDirectory,Connection,PathBuf) {
    let directory = TestDirectory::new();
    let connection = db::open_project(&directory.db_path()).unwrap();
    let source = directory.path().join("source.mov");
    std::fs::write(&source,"原片只读".as_bytes()).unwrap();
    let (hash,size) = crate::core::import::quick_fingerprint(&source).unwrap();
    connection.execute("INSERT INTO volumes(uuid) VALUES ('local')",[]).unwrap();
    connection.execute("INSERT INTO clips(id,volume_uuid,rel_path,quick_hash,byte_size,width,height,tb_num,tb_den,duration_ticks)
        VALUES(1,'local',?1,?2,?3,3840,2160,1,1000,10000)",rusqlite::params![source.to_string_lossy(),hash,size as i64]).unwrap();
    let cache = directory.path().join("cache"); std::fs::create_dir_all(cache.join("1")).unwrap();
    std::fs::write(cache.join("1/proxy.mp4"),"代理".as_bytes()).unwrap();
    connection.execute("INSERT INTO cache_artifacts(clip_id,kind,rel_path,source_hash,bytes,created_at) VALUES(1,'proxy','1/proxy.mp4',?1,6,'now')",[hash]).unwrap();
    connection.execute_batch("INSERT INTO proxy_time_map VALUES(1,0,0),(1,10000,10000)").unwrap();
    (directory,connection,cache)
}
#[test]
fn r25_resolver_checks_hash_map_file_settings_and_enqueues_high() {
    let (dir,connection,cache) = fixture();
    machine(&connection, true); // R28:「自动档打开即代理」只在省内存机上成立
    let resolve = || resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1;
    assert_eq!(initial_kind(&resolve()),SourceKind::Proxy);
    connection.execute("UPDATE cache_artifacts SET source_hash='stale'",[]).unwrap();
    assert!(resolve().proxy.is_none());
    connection.execute("UPDATE cache_artifacts SET source_hash=(SELECT quick_hash FROM clips WHERE id=1)",[]).unwrap();
    settings::set_setting(&connection,settings::PREVIEW_QUALITY_KEY,"original").unwrap();
    assert_eq!(initial_kind(&resolve()),SourceKind::Original, "原片档:原片在就读原片");
    assert!(resolve().original.is_some());
    settings::set_setting(&connection,settings::PREVIEW_QUALITY_KEY,"high").unwrap();
    settings::set_setting(&connection,settings::PROXY_ENABLED_KEY,"false").unwrap();
    assert_eq!(initial_kind(&resolve()),SourceKind::Original);
    assert_eq!(connection.query_row("SELECT count(*) FROM jobs WHERE kind='proxy_hq'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    settings::set_setting(&connection,settings::PROXY_ENABLED_KEY,"true").unwrap();
    resolve(); resolve();
    assert_eq!(connection.query_row("SELECT count(*) FROM jobs WHERE kind='proxy_hq'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    connection.execute("DELETE FROM proxy_time_map",[]).unwrap(); assert!(resolve().proxy.is_none());
    connection.execute_batch("INSERT INTO proxy_time_map VALUES(1,0,0),(1,10000,10000)").unwrap();
    std::fs::remove_file(cache.join("1/proxy.mp4")).unwrap(); assert!(resolve().proxy.is_none());
}
#[test]
fn r25_small_sources_ignore_even_existing_proxies() {
    let (dir,c,cache) = fixture();
    c.execute("UPDATE clips SET width=1920,height=1080",[]).unwrap();
    for q in ["auto","high","original","performance"] {
        settings::set_setting(&c,settings::PREVIEW_QUALITY_KEY,q).unwrap();
        assert_eq!(initial_kind(&resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1),SourceKind::Original);
    }
    assert_eq!(c.query_row("SELECT count(*) FROM jobs",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn r25_high_recovers_missing_hq_file_or_map() {
    for has_file in [false,true] {
        let (dir,c,cache)=fixture();
        settings::set_setting(&c,settings::PREVIEW_QUALITY_KEY,"high").unwrap();
        c.execute("INSERT INTO cache_artifacts(clip_id,kind,rel_path,source_hash,bytes,created_at)
            SELECT id,'proxy_hq','1/proxy_1080.mp4',quick_hash,3,'now' FROM clips WHERE id=1",[]).unwrap();
        if has_file { std::fs::write(cache.join("1/proxy_1080.mp4"),b"hq").unwrap(); }
        else { c.execute_batch("INSERT INTO proxy_hq_time_map VALUES(1,0,0),(1,10000,10000)").unwrap(); }
        let plan=resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1;
        assert!(plan.proxy_hq.is_none());
        assert_eq!(c.query_row("SELECT count(*) FROM jobs WHERE kind='proxy_hq'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert!(cache.join("1/proxy.mp4").is_file());
    }
}
#[test]
fn r25_high_loads_ready_hq_with_its_own_map() {
    let (dir,mut c,cache)=fixture();
    settings::set_setting(&c,settings::PREVIEW_QUALITY_KEY,"high").unwrap();
    std::fs::write(cache.join("1/proxy_1080.mp4"),b"hq").unwrap();
    c.execute("INSERT INTO cache_artifacts(clip_id,kind,rel_path,source_hash,bytes,created_at)
        SELECT id,'proxy_hq','1/proxy_1080.mp4',quick_hash,2,'now' FROM clips WHERE id=1",[]).unwrap();
    canonical_time::replace_proxy_hq_map(&mut c,1,&[ProxyTimePoint {proxy_ts_ms:0,source_ticks:0}, ProxyTimePoint {proxy_ts_ms:5000,source_ticks:10000}]).unwrap();
    let plan=resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1;
    assert_eq!(initial_kind(&plan),SourceKind::ProxyHq);
    assert_eq!(plan.proxy_hq.unwrap().mapper.unwrap().proxy_seconds_for_source_seconds(7.4),3.7);
    assert_eq!(c.query_row("SELECT count(*) FROM jobs",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn r25_original_is_deferred_and_optional() {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    // R28:这组断言讲的是「外置盘原片延后核验」,原片设为外置。
    let plan = |quality, proxy: bool, hq: bool, low: bool, original: bool| SourcePlan { quality,
        original: original.then(|| entry(O)), proxy: proxy.then(|| entry(P)), proxy_hq: hq.then(|| entry(H)), low_memory: low, original_external: true };
    // 自动 / 性能优先有 540p 代理就不在打开路径上核验原片(外置盘整文件哈希);原片档、缺 HQ 的高画质要。
    assert!(!needs_original_now(&plan(PreviewQuality::Auto, true, false, false, false)));
    assert!(!needs_original_now(&plan(PreviewQuality::Performance, true, false, false, false)));
    assert!(needs_original_now(&plan(PreviewQuality::Auto, false, false, false, false)));
    assert!(needs_original_now(&plan(PreviewQuality::Original, true, true, false, false)));
    assert!(needs_original_now(&plan(PreviewQuality::High, true, false, false, false)));
    assert!(!needs_original_now(&plan(PreviewQuality::High, true, false, true, false)));
    assert!(!needs_original_now(&plan(PreviewQuality::High, true, true, false, false)));
    assert!(original_deferred(&plan(PreviewQuality::Auto, true, false, false, false)));
    assert!(!original_deferred(&plan(PreviewQuality::Performance, true, false, false, false)));
    // 原片离线(None)时任何档位都退回现有代理,而不是打不开。
    assert_eq!(initial_kind(&plan(PreviewQuality::Original, true, false, false, false)), P);
    assert_eq!(initial_kind(&plan(PreviewQuality::Original, true, true, false, false)), H);
    assert_eq!(initial_kind(&plan(PreviewQuality::High, true, false, false, false)), P);
}

#[test]
fn r25_seek_and_step_during_swap_are_deferred_not_sent() {
    let mut switcher = SourceSwitcher::new(None);
    assert!(!switcher.defer_during_swap(&crate::player::PlayerCommand::SeekAbs { seconds: 3.0 }), "不在换源时照常交给 mpv");
    switcher.swapping = Some(SwapInFlight { started: Instant::now(), target_source_seconds: 1.0, resume: true, pending_seek: None });
    assert!(switcher.defer_during_swap(&crate::player::PlayerCommand::SeekAbs { seconds: 7.5 }));
    assert_eq!(switcher.swapping.as_ref().unwrap().pending_seek, Some(7.5));
    assert!(switcher.defer_during_swap(&crate::player::PlayerCommand::StepFwd));
    assert!(!switcher.swapping.as_ref().unwrap().resume, "逐帧意味着要停住");
    assert!(!switcher.defer_during_swap(&crate::player::PlayerCommand::Sync), "栅栏不被换源拦截");
    assert!(!switcher.defer_during_swap(&crate::player::PlayerCommand::Pause), "暂停是属性,载入中也能设");
    assert!(!switcher.defer_during_swap(&crate::player::PlayerCommand::SetEnd { seconds: Some(4.0) }));
}
#[test]
fn r25_offline_original_never_blocks_proxy_preview() {
    let (dir,c,cache) = fixture();
    machine(&c, true); // R28:本机盘原片在标准机自动档会当场核验;延后核验的是省内存机 / 外置盘
    // 自动档有代理:打开路径不核验原片(original 延后),后台 force 时才核验。
    let plan = resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1;
    assert!(plan.original.is_none() && original_deferred(&plan));
    let forced = resolve_preview_plan_with(&dir.db_path(),&cache,1,true).unwrap().1;
    assert!(forced.original.is_some());
    // 原片不在了(外置盘拔掉):自动档照样开代理,也不在打开时把素材记成缺失。
    std::fs::remove_file(dir.path().join("source.mov")).unwrap();
    let plan = resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1;
    assert_eq!(initial_kind(&plan),SourceKind::Proxy);
    let missing: Option<String> = c.query_row("SELECT missing_since FROM clips WHERE id=1",[],|r|r.get(0)).unwrap();
    assert!(missing.is_none(), "代理预览不该触发原片核验");
    assert!(resolve_preview_plan_with(&dir.db_path(),&cache,1,true).unwrap().1.original.is_none());
    // 原片档:原片离线时退回代理(角标写「代理」),而不是整块报错。
    settings::set_setting(&c,settings::PREVIEW_QUALITY_KEY,"original").unwrap();
    assert_eq!(initial_kind(&resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1),SourceKind::Proxy);
    // 高画质缺 HQ:要原片但原片离线 → 退回 540p 代理。
    settings::set_setting(&c,settings::PREVIEW_QUALITY_KEY,"high").unwrap();
    assert_eq!(initial_kind(&resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1),SourceKind::Proxy);
}

#[test]
fn r25_drop_counts_sum_observed_values_and_reset_per_file() {
    let mut switcher = SourceSwitcher::new(None);
    assert_eq!(switcher.record_drops("frame-drop-count", 3), 3);
    assert_eq!(switcher.record_drops("decoder-frame-drop-count", 2), 5);
    assert_eq!(switcher.record_drops("frame-drop-count", 4), 6);
    switcher.eof = true;
    switcher.file_loaded();
    assert!(!switcher.eof, "新文件载入清掉片尾标记");
    assert_eq!(switcher.record_drops("frame-drop-count", 1), 1);
}
#[test]
fn r26_debounce_wake_is_the_remaining_debounce() {
    use super::debounce_wake;
    let d = |ms| Duration::from_millis(ms);
    // 自动档、暂停在代理上、去抖未到:按剩余时间唤醒,而不是等下一次 50 ms 轮询。
    assert_eq!(debounce_wake(PreviewQuality::Auto,true,true,false,d(30),SourceKind::Proxy),Some(d(50)));
    assert_eq!(debounce_wake(PreviewQuality::Auto,true,true,false,d(0),SourceKind::Proxy),Some(AUTO_PAUSE_DEBOUNCE));
    // 已到期 / 在播 / EOF / 已是原片 / 非自动档:不需要提前唤醒。
    assert_eq!(debounce_wake(PreviewQuality::Auto,true,true,false,d(80),SourceKind::Proxy),None);
    assert_eq!(debounce_wake(PreviewQuality::Auto,true,false,false,d(0),SourceKind::Proxy),None);
    assert_eq!(debounce_wake(PreviewQuality::Auto,true,true,true,d(10),SourceKind::Proxy),None);
    assert_eq!(debounce_wake(PreviewQuality::Auto,true,true,false,d(10),SourceKind::Original),None);
    for q in [PreviewQuality::High,PreviewQuality::Original,PreviewQuality::Performance] {
        assert_eq!(debounce_wake(q,true,true,false,d(10),SourceKind::Proxy),None);
    }
}
#[test]
fn r26_file_loaded_during_swap_does_no_sync_property_reads() {
    // 真机:换源 FileLoaded 上同步 get_property 与新文件 vo reconfig 互等 200 ms。换源分支必须先于任何同步读返回。
    let source = include_str!("mod.rs");
    let start = source.find("Some(Ok(Event::FileLoaded)) => {").expect("FileLoaded 分支");
    let body = &source[start..start + 1600];
    let guard = body.find("if switcher.swapping.is_some() { switcher.file_loaded(); continue; }").expect("换源分支提前返回");
    let first_read = body.find("mpv.get_property").expect("非换源路径仍读属性");
    assert!(guard < first_read, "换源分支必须在第一次同步读之前");
}

#[test]
fn r28_auto_standard_machine_plays_original_while_playing() {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    let d = Duration::from_millis;
    // 标准机(plays_proxy=false):播放中、暂停中都要原片,不等去抖;已在原片 / EOF 不动。
    assert_eq!(auto_target(PreviewQuality::Auto,false,false,false,d(0),P),Some(O), "播放中也换原片");
    assert_eq!(auto_target(PreviewQuality::Auto,false,false,false,d(0),H),Some(O));
    assert_eq!(auto_target(PreviewQuality::Auto,false,true,false,d(0),P),Some(O), "暂停不用等去抖");
    assert_eq!(auto_target(PreviewQuality::Auto,false,false,false,d(0),O),None, "播放中不再退代理");
    assert_eq!(auto_target(PreviewQuality::Auto,false,false,true,d(0),P),None);
    assert_eq!(debounce_wake(PreviewQuality::Auto,false,true,false,d(10),P),None);
    // 性能优先档不受影响:永远 540p。
    let plan = |low| SourcePlan { quality: PreviewQuality::Performance, original: Some(entry(O)), proxy: Some(entry(P)),
        proxy_hq: Some(entry(H)), low_memory: low, original_external: false };
    for low in [false,true] { assert_eq!(initial_kind(&plan(low)),P); }
    for p in [PreviewQuality::Performance,PreviewQuality::High,PreviewQuality::Original] {
        assert_eq!(auto_target(p,false,false,false,d(0),P),None);
    }
}
#[test]
fn r28_playback_proxy_prefers_1080p() {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    let plan = |hq: bool| SourcePlan { quality: PreviewQuality::Auto, original: Some(entry(O)), proxy: Some(entry(P)),
        proxy_hq: hq.then(|| entry(H)), low_memory: true, original_external: false };
    assert_eq!(playback_proxy(&plan(true)),H);
    assert_eq!(playback_proxy(&plan(false)),P);
}
#[test]
fn r28_resolver_auto_opens_original_on_standard_internal_and_defers_external() {
    let (dir,c,cache) = fixture();
    machine(&c,false);
    let plan = resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1;
    assert!(!plan.original_external);
    assert!(plan.original.is_some(), "本机盘原片当场核验");
    assert!(!original_deferred(&plan));
    assert_eq!(initial_kind(&plan),SourceKind::Original, "标准机自动档打开即原片");
    // 外置盘(相对路径):不在打开路径上整文件哈希,先开代理,后台核验后换原片。
    c.execute("UPDATE clips SET rel_path='DCIM/source.mov'",[]).unwrap();
    let plan = resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1;
    assert!(plan.original_external && plan.original.is_none() && original_deferred(&plan));
    assert_eq!(initial_kind(&plan),SourceKind::Proxy);
    // 省内存机:照旧先代理。
    c.execute("UPDATE clips SET rel_path=?1",[dir.path().join("source.mov").to_string_lossy()]).unwrap();
    machine(&c,true);
    let plan = resolve_preview_plan(&dir.db_path(),&cache,1).unwrap().1;
    assert!(plan.low_memory && original_deferred(&plan));
    assert_eq!(initial_kind(&plan),SourceKind::Proxy);
}
#[test]
fn r28_switcher_degrades_auto_to_proxy_after_burst_and_publishes_policy() {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    let mpv = libmpv2::Mpv::with_initializer(|i| { i.set_property("vo","null")?; i.set_property("ao","null")?; Ok(()) }).unwrap();
    let plan = |low| SourcePlan { quality: PreviewQuality::Auto, original: Some(entry(O)), proxy: Some(entry(P)),
        proxy_hq: Some(entry(H)), low_memory: low, original_external: false };
    let mut status = PlayerStatus::closed(); status.phase = "ready".into(); status.paused = false;
    let mut sw = SourceSwitcher::new(None);
    sw.install(plan(false), O, &mut status);
    assert_eq!(status.auto_policy.as_deref(), Some("original"));
    sw.tick(&mpv, &mut status);
    assert_eq!(sw.current, O, "标准机播放中留在原片");
    assert!(!sw.before_play(&mpv, &mut status), "开播前不再切代理");
    assert_eq!(sw.current, O);
    sw.drop_burst = true;
    sw.tick(&mpv, &mut status);
    assert!(sw.degraded);
    assert_eq!(sw.current, H, "掉帧后播放退 1080p 代理");
    assert_eq!(status.auto_policy.as_deref(), Some("degraded"));
    // 代理也持续掉帧(真机:WindowServer / 别的程序抢 GPU):不是原片的锅 → 回原片,本次不再降级。
    sw.swapping = None; // 换源落地
    sw.proxy_burst = true;
    sw.tick(&mpv, &mut status);
    assert!(!sw.degraded && sw.degrade_blocked);
    assert_eq!(status.auto_policy.as_deref(), Some("original"));
    // 回原片要等换源完成(PlaybackRestart);这里模拟换源落地。
    sw.swapping = None;
    sw.tick(&mpv, &mut status);
    assert_eq!(sw.current, O, "回到原片");
    sw.swapping = None;
    sw.drop_burst = true;
    sw.tick(&mpv, &mut status);
    assert!(!sw.degraded, "本次不再降级");
    assert_eq!(sw.current, O);
    // 原片档掉帧后切回自动:立即按掉帧处理(播放中给代理)。
    let mut sw = SourceSwitcher::new(None); let mut status2 = status.clone();
    let mut original = plan(false); original.quality = PreviewQuality::Original;
    sw.install(original, O, &mut status2);
    assert_eq!(status2.auto_policy, None);
    sw.drop_burst = true;
    sw.set_quality(&mpv, &mut status2, PreviewQuality::Auto).unwrap();
    assert!(sw.degraded && sw.current == H);
    // 省内存机:策略 proxy。
    let mut sw = SourceSwitcher::new(None); let mut status3 = status.clone();
    sw.install(plan(true), H, &mut status3);
    assert_eq!(status3.auto_policy.as_deref(), Some("proxy"));
}
#[test]
fn r28_gl_view_asks_for_best_resolution_surface_before_it_is_placed() {
    let source = include_str!("mod.rs");
    let start = source.find("fn build_surface(").expect("build_surface");
    let body = &source[start..start + 4000];
    let set = body.find("gl_view.setWantsBestResolutionOpenGLSurface(true);").expect("显式要 Retina 原生像素 drawable");
    let place = body.find("handoff::place_view(").expect("place_view");
    assert!(set < place, "挂进窗口前就要设好");
}

/// R29 的判据 / 遮挡 / 记忆测试(文件行数上限,分出去)。
#[path = "preview_source_r29_tests.rs"]
mod r29;
