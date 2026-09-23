use super::*;
use crate::core::{test_support::TestDirectory, canonical_time::ProxyTimePoint};

fn entry(kind: SourceKind) -> SourceEntry { SourceEntry { kind, path: "/素材,a:b.mov".into(), mapper: None } }
#[test]
fn r25_initial_truth_table() {
    use SourceKind::{Original as O, Proxy as P, ProxyHq as H};
    // 顺序：proxy × hq × low_memory，各维先 false 后 true。
    for (quality, expected) in [
        (PreviewQuality::Auto, [O,O,O,O,P,P,P,P]),
        (PreviewQuality::High, [O,O,H,H,O,P,H,H]),
        (PreviewQuality::Original, [O,O,O,O,O,O,O,O]),
        (PreviewQuality::Performance, [O,O,O,O,P,P,P,P]),
    ] {
        let mut index = 0;
        for proxy in [false,true] { for hq in [false,true] { for low in [false,true] {
            let plan = SourcePlan { quality, original: Some(entry(SourceKind::Original)), proxy: proxy.then(||entry(SourceKind::Proxy)),
                proxy_hq: hq.then(||entry(SourceKind::ProxyHq)), low_memory: low };
            assert_eq!(initial_kind(&plan),expected[index],"{quality:?} {proxy} {hq} {low}");
            index += 1;
        } } }
    }
}
#[test]
fn r25_auto_debounce_eof_and_serialization() {
    for ms in [0,99,100,101] {
        assert_eq!(auto_target(PreviewQuality::Auto,true,false,Duration::from_millis(ms),SourceKind::Proxy),
            (ms>=100).then_some(SourceKind::Original));
    }
    assert_eq!(auto_target(PreviewQuality::Auto,true,true,Duration::from_secs(1),SourceKind::Proxy),None);
    assert_eq!(auto_target(PreviewQuality::Auto,false,false,Duration::ZERO,SourceKind::Original),Some(SourceKind::Proxy));
    for q in [PreviewQuality::High,PreviewQuality::Original,PreviewQuality::Performance] {
        assert_eq!(auto_target(q,true,false,Duration::from_secs(1),SourceKind::Proxy),None);
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
    let plan = |quality, proxy: bool, hq: bool, low: bool, original: bool| SourcePlan { quality,
        original: original.then(|| entry(O)), proxy: proxy.then(|| entry(P)), proxy_hq: hq.then(|| entry(H)), low_memory: low };
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
    assert!(!switcher.defer_during_swap(&crate::player::PlayerCommand::Pause), "暂停是属性,载入中也能设");
    assert!(!switcher.defer_during_swap(&crate::player::PlayerCommand::SetEnd { seconds: Some(4.0) }));
}
#[test]
fn r25_offline_original_never_blocks_proxy_preview() {
    let (dir,c,cache) = fixture();
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
