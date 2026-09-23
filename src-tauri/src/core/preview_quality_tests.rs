//! R25：代理隔离、迁移与导出取源回归（仅临时目录）。
use super::{artifacts, canonical_time, db, jobs, migrations, settings, test_support::TestDirectory};
use rusqlite::{params, Connection};

#[test]
fn r25_migration_55_preserves_proxy_rows_and_map() {
    let directory = TestDirectory::new();
    let old_proxy = directory.path().join("proxy.mp4");
    std::fs::write(&old_proxy,b"540p unchanged").unwrap();
    let c = Connection::open(directory.db_path()).unwrap();
    c.pragma_update(None,"foreign_keys",true).unwrap();
    for migration in migrations::MIGRATIONS.iter().filter(|m| m.version <= 54) { c.execute_batch(migration.sql).unwrap(); }
    c.execute_batch("INSERT INTO clips(id,rel_path,quick_hash) VALUES(1,'source.mov','hash');
        INSERT INTO cache_artifacts(id,clip_id,kind,rel_path,source_hash,bytes,created_at)
        VALUES(91,1,'proxy','1/proxy.mp4','hash',123,'original-date');
        INSERT INTO proxy_time_map VALUES(1,0,0),(1,1000,2000);").unwrap();
    let read = |c: &Connection| c.query_row("SELECT id,clip_id,kind,rel_path,source_hash,bytes,created_at FROM cache_artifacts WHERE id=91",[],
        |r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,String>(6)?))).unwrap();
    let before = read(&c);
    c.execute_batch("CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(54);").unwrap();
    drop(c);
    let c = db::open_project(&directory.db_path()).unwrap();
    assert_eq!(db::schema_version(&c).unwrap(),55);
    assert_eq!(before,read(&c));
    assert_eq!(std::fs::read(&old_proxy).unwrap(),b"540p unchanged");
    assert_eq!(c.query_row("SELECT source_ticks FROM proxy_time_map WHERE proxy_ts_ms=1000",[],|r|r.get::<_,i64>(0)).unwrap(),2000);
    c.execute("INSERT INTO cache_artifacts(clip_id,kind,rel_path,source_hash,bytes,created_at) VALUES(1,'proxy_hq','1/proxy_1080.mp4','hash',456,'now')",[]).unwrap();
    assert!(c.execute("INSERT INTO cache_artifacts(clip_id,kind,rel_path,source_hash,bytes,created_at) VALUES(1,'invalid','bad','hash',0,'now')",[]).is_err());
    c.execute_batch("INSERT INTO proxy_hq_time_map VALUES(1,0,0),(1,1000,2000); DELETE FROM clips WHERE id=1;").unwrap();
    assert_eq!(c.query_row("SELECT count(*) FROM proxy_hq_time_map",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}
#[test]
fn r25_quality_setting_whitelist_and_default() {
    let d = TestDirectory::new(); let c = db::open_project(&d.db_path()).unwrap();
    assert_eq!(settings::get_settings(&c).unwrap()[settings::PREVIEW_QUALITY_KEY],"auto");
    for q in ["auto","high","original","performance"] { settings::set_setting(&c,settings::PREVIEW_QUALITY_KEY,q).unwrap(); }
    for q in ["", "1080", "HIGH", "bogus"] { assert!(settings::set_setting(&c,settings::PREVIEW_QUALITY_KEY,q).is_err()); }
}
#[test]
fn r25_enqueue_idempotent_and_small_source_completes_without_file() {
    let d = TestDirectory::new(); let mut c = db::open_project(&d.db_path()).unwrap();
    let path = d.path().join("source.mov"); std::fs::write(&path,"小源文件".as_bytes()).unwrap();
    let (hash,size) = super::import::quick_fingerprint(&path).unwrap();
    c.execute("INSERT INTO volumes(uuid) VALUES('local')",[]).unwrap();
    c.execute("INSERT INTO clips(id,volume_uuid,rel_path,quick_hash,byte_size,width,height,tb_num,tb_den,duration_ticks)
        VALUES(1,'local',?1,?2,?3,1920,1080,1,1000,2000)",params![path.to_string_lossy(),hash,size as i64]).unwrap();
    assert!(artifacts::enqueue_proxy_hq_if_needed(&c,1).unwrap());
    assert!(!artifacts::enqueue_proxy_hq_if_needed(&c,1).unwrap());
    let job = jobs::claim_next(&mut c).unwrap().unwrap();
    artifacts::run_proxy_hq(&mut c,&job,&d.path().join("cache")).unwrap();
    assert_eq!(jobs::get(&c,job.id).unwrap().result_path.as_deref(),Some("direct"));
    assert!(!d.path().join("cache/1/proxy_1080.mp4").exists());
    c.execute("INSERT INTO cache_artifacts(clip_id,kind,rel_path,source_hash,bytes,created_at) VALUES(1,'proxy_hq','1/proxy_1080.mp4',?1,12,'now')",[hash]).unwrap();
    assert!(!artifacts::enqueue_proxy_hq_if_needed(&c,1).unwrap());
}
#[test]
fn r25_lru_counts_and_evicts_both_proxy_kinds_and_maps() {
    let d=TestDirectory::new(); let mut c=db::open_project(&d.db_path()).unwrap();
    // 6 GiB 每份，默认总上限 10 GiB；第三份保留，两种旧代理均应淘汰。
    for (id,kind,file) in [(1,"proxy","proxy.mp4"),(2,"proxy_hq","proxy_1080.mp4"),(3,"proxy","proxy.mp4")] {
        c.execute("INSERT INTO clips(id,rel_path,quick_hash,tb_num,tb_den) VALUES(?1,?2,'hash',1,1000)",params![id,format!("source-{id}")]).unwrap();
        std::fs::create_dir_all(d.path().join(id.to_string())).unwrap();
        std::fs::write(d.path().join(format!("{id}/{file}")),b"cache").unwrap();
        c.execute("INSERT INTO cache_artifacts(clip_id,kind,rel_path,source_hash,bytes,created_at) VALUES(?1,?2,?3,'hash',?4,'now')",params![id,kind,format!("{id}/{file}"),6_i64<<30]).unwrap();
        let points=canonical_time::build_linear_proxy_map(2000,1,1000,2000);
        if kind=="proxy" { canonical_time::replace_proxy_map(&mut c,id,&points).unwrap(); }
        else { canonical_time::replace_proxy_hq_map(&mut c,id,&points).unwrap(); }
    }
    assert_eq!(artifacts::proxy_cache_bytes(&c).unwrap(),18_u64<<30);
    let result=artifacts::enforce_proxy_cache_limit(&c,d.path(),Some(3)).unwrap();
    assert_eq!(result.removed,2); assert_eq!(artifacts::proxy_cache_bytes(&c).unwrap(),6_u64<<30);
    assert!(canonical_time::load_proxy_mapper(&c,1).unwrap().is_none());
    assert!(canonical_time::load_proxy_hq_mapper(&c,2).unwrap().is_none());
    assert!(canonical_time::load_proxy_mapper(&c,3).unwrap().is_some());
    assert!(!d.path().join("1/proxy.mp4").exists()); assert!(!d.path().join("2/proxy_1080.mp4").exists());
}
