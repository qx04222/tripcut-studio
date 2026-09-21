//! Reproducible synthetic regression set, not a real-camera calibration set.
use crate::core::{analysis, db, jobs, similar, smart_select, test_support::TestDirectory};
use rusqlite::{params, Connection};
use serde_json::json;
use std::path::{Path, PathBuf};

fn content(seed: u32) -> image::RgbImage {
    image::RgbImage::from_fn(512, 384, |x, y| {
        let mut n = (x / 32 + (y / 32) * 16).wrapping_add(seed * 1039 + 7);
        n ^= n << 13; n ^= n >> 17; n ^= n << 5;
        let v = 40 + (n % 170) as u8;
        image::Rgb([v, v.saturating_add((seed % 25) as u8), v])
    })
}
fn fixture_root() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../qa/ai-eval/photos") }

#[test]
#[ignore = "explicit fixture regeneration only"]
fn r21_generate_photo_fixtures() {
    let root = fixture_root();
    std::fs::create_dir_all(&root).unwrap();
    let mut manifest = Vec::new();
    for group in 0..10 {
        let base = content(group + 1);
        for variant in 0..3 {
            let name = format!("IMG_{:04}.png", group*100+variant*10);
            let picture = image::RgbImage::from_fn(512, 384, |x, y| {
                let p = base.get_pixel(x.saturating_sub(variant), y.saturating_sub(variant));
                image::Rgb(p.0.map(|v| v.saturating_add(variant as u8 * 3)))
            });
            picture.save(root.join(&name)).unwrap();
            manifest.push(json!({"file":name,"group":group,"event":0,"camera":"fixture-camera", "taken_at":format!("2026-09-19T12:{group:02}:{:02}Z",variant*5),"file_number":group*100+variant*10}));
        }
    }
    let mut quality = Vec::new();
    for i in 0..20 {
        let base = content(i % 10 + 1);
        let (label, picture) = if i < 5 { ("blur", image::imageops::blur(&base, 8.0)) }
            else if i < 10 { ("underexposed", image::RgbImage::from_fn(512,384,|x,y|image::Rgb(base.get_pixel(x,y).0.map(|v| v/8)))) }
            else { ("good", base) };
        let file = format!("quality-{i:02}.png"); picture.save(root.join(&file)).unwrap();
        quality.push(json!({"file":file,"label":label}));
    }
    let night = image::RgbImage::from_fn(512,384,|x,y| image::Rgb(if (200..230).contains(&x) && (150..180).contains(&y) {[245;3]} else {[12;3]}));
    night.save(root.join("night.png")).unwrap();
    std::fs::write(root.join("manifest.json"), serde_json::to_string_pretty(&json!({"version":1,"generator":"image 0.25; deterministic tile scenes; shift 0-2px; +0-6 levels; Gaussian sigma=8; -3EV divide8", "groups":manifest,"quality":quality,"protected":[{"file":"night.png","label":"night_highlights"}]})).unwrap()).unwrap();
}

fn seed(c: &Connection, id:i64, path:&Path, time:&str) {
    let (hash, _) = crate::core::import::quick_fingerprint(path).unwrap();
    c.execute("INSERT OR IGNORE INTO volumes(uuid) VALUES('photos')",[]).unwrap();
    c.execute("INSERT INTO clips(id,volume_uuid,rel_path,quick_hash,kind,tb_num,tb_den,duration_ticks,episode_id,captured_at) VALUES(?1,'photos',?2,?3,'photo',1,1000,0,(SELECT id FROM episodes WHERE status='active'),?4)",params![id,path.to_str().unwrap(),hash,time]).unwrap();
    c.execute("INSERT INTO photo_meta(clip_id,width,height,camera,taken_at,hold_ms) VALUES(?1,512,384,'fixture-camera',?2,3000)",params![id,time]).unwrap();
}
fn analyze(c:&mut Connection,id:i64,path:&Path) {
    let hash:String=c.query_row("SELECT quick_hash FROM clips WHERE id=?1",[id],|r|r.get(0)).unwrap();
    let job_id=analysis::enqueue_for_clip(c,id,path,&hash).unwrap().expect("photo analyze_l1 must enqueue");
    c.execute("UPDATE jobs SET status='running',attempt=1 WHERE id=?1",[job_id]).unwrap();
    let job=jobs::get(c,job_id).unwrap();
    analysis::run_analyze_l1(c,&job).unwrap();
    jobs::mark_done(c,job_id,job.attempt).unwrap();
}
fn grouping(c:&mut Connection) {
    let id=similar::enqueue_if_ready(c).unwrap().expect("photos must group without CLIP");
    c.execute("UPDATE jobs SET status='running',attempt=1 WHERE id=?1",[id]).unwrap();
    let job=jobs::get(c,id).unwrap(); similar::run_similar_cluster(c,&job).unwrap(); jobs::mark_done(c,id,job.attempt).unwrap();
}
#[test]
fn r21_ph06_groups_without_clip_and_never_crosses_events() {
    let d=TestDirectory::new(); let mut c=db::open_project(&d.db_path()).unwrap();
    for g in 0..10 { for v in 0..3 {
        let id=g*3+v+1; let p=fixture_root().join(format!("IMG_{:04}.png", g*100+v*10));
        seed(&c,id,&p,&format!("2026-09-19T12:{g:02}:{:02}Z",v*5));
    }}
    // Same pixels as group 0, more than 30 minutes away.
    let later=d.path().join("later-event.png");
    std::fs::copy(fixture_root().join("IMG_0000.png"),&later).unwrap();
    seed(&c,31,&later,"2026-09-19T14:00:00Z");
    grouping(&mut c);
    let groups=similar::similar_groups(&c).unwrap();
    let correct=groups.iter().filter(|g| g.members.len()==3 && g.members.iter().all(|m|(m.clip_id-1)/3==(g.members[0].clip_id-1)/3)).count();
    assert!(correct>=9,"correct={correct}, groups={groups:?}");
    assert!(groups.iter().all(|g| !g.members.iter().any(|m|m.clip_id==31)));
    eprintln!("PH06 correct={correct}/10 cross_event=0 no_clip={correct}/10");
}
#[test]
fn r21_ph07_quality_recall_and_night_guard() {
    let d=TestDirectory::new(); let mut c=db::open_project(&d.db_path()).unwrap(); let mut tp=0; let mut fp=0;
    for i in 0..21 {
        let path=fixture_root().join(if i==20 {"night.png".into()} else {format!("quality-{i:02}.png")});
        seed(&c,i+1,&path,"2026-09-19T12:00:00Z"); analyze(&mut c,i+1,&path);
        let a=analysis::get_clip_analysis(&c,i+1).unwrap().expect("persisted analysis");
        let suspect=a.underexposed_ratio>0.15 || a.out_of_focus_ratio>0.15 || a.overexposed_ratio>0.15;
        if i<10 && suspect {tp+=1;} else if (10..20).contains(&i) && suspect {fp+=1;}
        if i==20 {assert_eq!(a.underexposed_ratio,0.0);}
    }
    eprintln!("PH07 recall={tp}/10 false_positive={fp}/10 night_underexposed=0");
    assert!(tp>=8); assert!(fp<=1);
}
#[test]
fn r21_ph09_selects_one_primary_per_group_excludes_bad_and_counts_hold() {
    let d=TestDirectory::new(); let mut c=db::open_project(&d.db_path()).unwrap();
    for g in 0..10 { for v in 0..3 {
        let id=g*3+v+1; let p=fixture_root().join(format!("IMG_{:04}.png", g*100+v*10));
        seed(&c,id,&p,&format!("2026-09-19T12:{g:02}:{:02}Z",v*5)); analyze(&mut c,id,&p);
    }}
    for i in 0..5 {let id=31+i;let p=fixture_root().join(format!("quality-{i:02}.png"));seed(&c,id,&p,"2026-09-19T14:00:00Z"); analyze(&mut c,id,&p);}
    grouping(&mut c);
    let out=smart_select::auto_select_episode_with(&mut c,smart_select::AutoSelectParams{scope:Some("all".into()),prompt:Some("挑 20 张照片".into()),..Default::default()}).unwrap();
    assert_eq!(out.created.len(),10); assert_eq!(out.total_secs,30.0);
    let view=crate::core::smart_select_runs::list_run(&c,&out.run_id).unwrap();
    let mut groups=std::collections::BTreeSet::new();
    for row in view.rows {assert!(row.clip_id<=30);assert!(groups.insert((row.clip_id-1)/3));assert_eq!(row.secs,3.0);assert!(row.reasons.contains(&"同组 3 张最清晰".into()));assert_eq!((row.in_ticks,row.out_ticks),(0,0));}
}
