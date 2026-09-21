use super::tests::*;
use super::*;
use crate::core::settings;

fn photo_schema(db: &Connection) {
    let has_kind = db.prepare("PRAGMA table_info(clips)").unwrap().query_map([], |r| r.get::<_, String>(1)).unwrap().any(|name| name.unwrap() == "kind");
    if !has_kind {
        db.execute_batch("ALTER TABLE clips ADD COLUMN kind TEXT NOT NULL DEFAULT 'video';").unwrap();
    }
    // Only this test's temporary DB: isolate the delivery contract from photo-core's
    // extra metadata constraints, including after migrations 0050/0051 are merged.
    db.execute_batch("DROP TABLE IF EXISTS clip_companions;
        DROP TABLE IF EXISTS photo_meta;
        CREATE TABLE photo_meta(clip_id INTEGER PRIMARY KEY, hold_ms INTEGER);
        CREATE TABLE clip_companions(clip_id INTEGER, role TEXT, path TEXT);").unwrap();
}

fn add_photo(db: &Connection, path: &Path, hold: i64) -> i64 {
    let id = insert_clip(db, path, "2026-09-19T00:00:00Z", &[1], None);
    db.execute("UPDATE clips SET kind='photo',duration_ticks=0,fps_num=NULL,fps_den=NULL WHERE id=?1", [id]).unwrap();
    db.execute("INSERT INTO photo_meta(clip_id,hold_ms) VALUES (?1,?2)", params![id, hold]).unwrap();
    id
}

fn add_unselected_photo(db: &Connection, path: &Path, captured_at: &str, stars: Option<i64>) -> i64 {
    let id = insert_clip(db, path, captured_at, &[], stars);
    db.execute("UPDATE clips SET kind='photo',duration_ticks=0,fps_num=NULL,fps_den=NULL WHERE id=?1", [id]).unwrap();
    db.execute("INSERT INTO photo_meta(clip_id,hold_ms) VALUES (?1,3000)", [id]).unwrap();
    id
}

fn add_photo_select(db: &Connection, clip_id: i64) -> i64 {
    db.execute(
        "INSERT INTO segments(clip_id,in_ticks,out_ticks,kind,tombstone,source)
         VALUES(?1,0,0,'select',0,'test')",
        [clip_id],
    ).unwrap();
    db.last_insert_rowid()
}

#[test]
fn photo_delivery_hold_and_legacy_schema() {
    let dir = TestDirectory::new();
    let db = db::open_project(&dir.db_path()).unwrap();
    insert_clip(&db, Path::new("video.mp4"), "2026-09-19", &[1], None);
    assert_eq!(total_duration_seconds(&selected_clips(&db).unwrap()), 2.0);
    let legacy = Connection::open_in_memory().unwrap();
    legacy.execute_batch("CREATE TABLE clips(id INTEGER PRIMARY KEY);").unwrap();
    let mut old_clips = selected_clips(&db).unwrap();
    photo::attach(&legacy, &mut old_clips).unwrap();
    assert_eq!(old_clips[0].media_kind, "video");
    photo_schema(&db);
    add_photo(&db, Path::new("still.jpg"), 3500);
    let clips = selected_clips(&db).unwrap();
    assert_eq!(total_duration_seconds(&clips), 5.5);
    let photo = clips.iter().find(|c| c.file_name == "still.jpg").unwrap();
    let contact = build_contact_sheet_items(&db, dir.path(), std::slice::from_ref(photo));
    assert_eq!(contact[0].in_clock, "整张");
    assert_eq!(contact[0].out_clock, "展示 3.5 s");
    let payload = export_payload_fixture(vec![photo.clone()]);
    let item = ExportItemStatus { clip_id: photo.clip_id, file_name: photo.file_name.clone(), output_name: "01.jpg".into(), status: "done".into(), note: None, warning: false };
    let csv = build_shot_list_csv(&payload.clips, &[item], &payload.platform_info);
    assert!(csv.contains(",,,00:00:03.500,"), "{csv}");
}

#[test]
fn photo_delivery_quick_ignores_photos_and_uses_normal_empty_error() {
    let dir = TestDirectory::new();
    let mut db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let source = dir.path().join("still.jpg");
    std::fs::write(&source, b"photo").unwrap();
    add_photo(&db, &source, 3000);
    let error = plan_quick_export(&db, None, None).unwrap_err().to_string();
    assert!(error.contains("当前没有精选段或收藏素材"), "{error}");
    assert!(!error.contains("photo_not_supported"), "{error}");
    let error = start_quick_export(&mut db, dir.path(), None).unwrap_err().to_string();
    assert!(error.contains("当前没有精选段或收藏素材"), "{error}");
    assert!(!error.contains("photo_not_supported"), "{error}");
    assert_eq!(db.query_row("SELECT count(*) FROM jobs WHERE kind='export_package'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn photo_delivery_quick_mixed_plan_and_payload_only_keep_video() {
    let dir = TestDirectory::new();
    let mut db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let video = dir.path().join("video.mp4");
    let still = dir.path().join("still.jpg");
    std::fs::write(&video, b"video").unwrap();
    std::fs::write(&still, b"photo").unwrap();
    insert_clip(&db, &video, "2026-09-19T00:00:00Z", &[1], None);
    add_photo(&db, &still, 3000);

    let plan = plan_quick_export(&db, None, None).unwrap();
    assert_eq!(plan.files.len(), 1);
    assert!(plan.files[0].ends_with("video.mp4"), "{:?}", plan.files);
    let job_id = start_quick_export(&mut db, dir.path(), None).unwrap().job_id.unwrap();
    let payload = parse_payload(
        &db.query_row("SELECT payload FROM jobs WHERE id=?1", [job_id], |row| row.get::<_, String>(0)).unwrap(),
    ).unwrap();
    assert_eq!(payload.version, 6);
    assert_eq!(payload.clips.len(), 1);
    assert_eq!(payload.clips[0].media_kind, "video");
}

#[test]
fn photo_delivery_kit_plan_keeps_image_extensions_and_one_line_per_item() {
    let dir = TestDirectory::new();
    let db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let chapter = insert_chapter_at(&db, "章节", "2026-09-19");
    for name in ["a.mp4", "b.HEIC", "c.PNG", "d.jpg"] {
        let id = if name.ends_with("mp4") { insert_clip(&db, Path::new(name), "2026-09-19", &[1], None) } else { add_photo(&db, Path::new(name), 3000) };
        db.execute("UPDATE clips SET chapter_id=?1 WHERE id=?2", params![chapter, id]).unwrap();
    }
    let plan = plan_jianying_kit(&db, None).unwrap();
    assert_eq!(plan.files, ["视频/01_章节/01_章节_a.mp4", "照片/01_b.jpg", "照片/02_c.PNG", "照片/03_d.jpg"]);
    assert_eq!(plan.order_file, KIT_ORDER_FILE);
    let text = kit_order_text(&selected_clips(&db).unwrap(), &[]);
    assert_eq!(text.lines().count(), 4);
    assert_eq!(text.matches("照片 · 3 s").count(), 3);
}

#[test]
fn photo_delivery_candidates_dedupe_and_reject_wins() {
    let dir = TestDirectory::new();
    let db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let favorite = add_photo(&db, Path::new("favorite.jpg"), 3000);
    let starred = add_unselected_photo(&db, Path::new("starred.jpg"), "2026-09-19T00:01:00Z", Some(3));
    let selected = add_unselected_photo(&db, Path::new("selected.jpg"), "2026-09-19T00:02:00Z", None);
    add_photo_select(&db, selected);
    add_photo_select(&db, selected);
    let rejected = add_unselected_photo(&db, Path::new("rejected.jpg"), "2026-09-19T00:03:00Z", Some(5));
    add_photo_select(&db, rejected);
    let whole: i64 = db.query_row(
        "SELECT id FROM segments WHERE clip_id=?1 AND kind='whole'",
        [rejected],
        |row| row.get(0),
    ).unwrap();
    db.execute(
        "INSERT INTO ratings(segment_id,rating_type,value,rated_at)
         VALUES(?1,'binary',-1,'2026-09-19T23:59:59Z')",
        [whole],
    ).unwrap();

    let clips = selected_clips(&db).unwrap();
    assert_eq!(clips.iter().map(|clip| clip.clip_id).collect::<Vec<_>>(), [favorite, starred, selected]);
}

#[test]
fn photo_rating_and_delivery_agree_after_reject_clear_and_restore() {
    let dir = TestDirectory::new();
    let mut db = db::open_project(&dir.db_path()).unwrap();
    let photo = add_unselected_photo(
        &db,
        Path::new("selected-photo.jpg"),
        "2026-09-19T00:02:00Z",
        None,
    );
    add_photo_select(&db, photo);
    let unrated = add_unselected_photo(
        &db,
        Path::new("unrated-photo.jpg"),
        "2026-09-19T00:03:00Z",
        None,
    );
    let rejected_before_select = add_unselected_photo(
        &db,
        Path::new("rejected-before-select.jpg"),
        "2026-09-19T00:04:00Z",
        None,
    );
    db.execute(
        "UPDATE photo_meta SET width=100,height=80 WHERE clip_id IN (?1,?2,?3)",
        params![photo, unrated, rejected_before_select],
    ).unwrap();

    let listed = crate::core::import::list_clips(&db).unwrap();
    assert_eq!(listed.iter().find(|clip| clip.id == Some(photo)).unwrap().binary_rating, Some(1));
    assert_eq!(listed.iter().find(|clip| clip.id == Some(photo)).unwrap().select_count, 1);
    assert_eq!(listed.iter().find(|clip| clip.id == Some(unrated)).unwrap().binary_rating, None);

    // scope=all 可先收进一张已按 X 的照片：后建 select 自带的 +1 不能反盖 whole 上
    // 的显式拒绝，否则 UI 和交付会再次分裂。
    crate::core::ratings::rate_clip(&mut db, rejected_before_select, "binary", -1).unwrap();
    let selected_after_reject = add_photo_select(&db, rejected_before_select);
    db.execute(
        "INSERT INTO ratings(segment_id,rating_type,value,rated_at)
         VALUES(?1,'binary',1,'9999-12-31T23:59:59Z')",
        [selected_after_reject],
    ).unwrap();
    let relisted = crate::core::import::list_clips(&db).unwrap();
    assert_eq!(
        relisted.iter().find(|clip| clip.id == Some(rejected_before_select)).unwrap().binary_rating,
        Some(-1),
    );
    assert!(!selected_clips(&db).unwrap().iter().any(|clip| clip.clip_id == rejected_before_select));

    crate::core::ratings::rate_clip(&mut db, photo, "binary", -1).unwrap();
    let rejected = crate::core::import::list_clips(&db).unwrap();
    let rejected = rejected.iter().find(|clip| clip.id == Some(photo)).unwrap();
    assert_eq!((rejected.binary_rating, rejected.select_count), (Some(-1), 1));
    assert!(!selected_clips(&db).unwrap().iter().any(|clip| clip.clip_id == photo));

    // 0 是“清除显式评级”标记，不能和从未评级的 NULL 混淆；live select 仍让
    // 照片留在精选/交付集合，但界面会把 binary=0 显示成“未评”。
    crate::core::ratings::rate_clip(&mut db, photo, "binary", 0).unwrap();
    let cleared = crate::core::import::list_clips(&db).unwrap();
    assert_eq!(cleared.iter().find(|clip| clip.id == Some(photo)).unwrap().binary_rating, Some(0));
    assert_eq!(cleared.iter().find(|clip| clip.id == Some(unrated)).unwrap().binary_rating, None);
    assert!(selected_clips(&db).unwrap().iter().any(|clip| clip.clip_id == photo));

    crate::core::ratings::rate_clip(&mut db, photo, "binary", -1).unwrap();
    crate::core::ratings::rate_clip(&mut db, photo, "binary", 1).unwrap();
    let restored = crate::core::import::list_clips(&db).unwrap();
    assert_eq!(restored.iter().find(|clip| clip.id == Some(photo)).unwrap().binary_rating, Some(1));
    assert!(selected_clips(&db).unwrap().iter().any(|clip| clip.clip_id == photo));
}

#[test]
fn video_live_select_keeps_existing_binary_fallback() {
    let dir = TestDirectory::new();
    let mut db = db::open_project(&dir.db_path()).unwrap();
    let video = insert_clip(
        &db,
        Path::new("selected-video.mp4"),
        "2026-09-19T00:00:00Z",
        &[],
        None,
    );
    insert_select_segment(&db, video, 0, 1000, 0);
    crate::core::ratings::rate_clip(&mut db, video, "binary", -1).unwrap();

    let listed = crate::core::import::list_clips(&db).unwrap();
    let listed = listed.iter().find(|clip| clip.id == Some(video)).unwrap();
    assert_eq!((listed.binary_rating, listed.select_count), (Some(1), 1));
    assert!(selected_clips(&db).unwrap().iter().any(|clip| clip.clip_id == video));
}

#[test]
fn photo_delivery_order_prefers_saved_unique_ids_then_capture_time() {
    let dir = TestDirectory::new();
    let db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let video = insert_clip(&db, Path::new("video.mp4"), "2026-09-19T00:04:00Z", &[1], None);
    let early = add_photo(&db, Path::new("early.jpg"), 3000);
    db.execute("UPDATE clips SET captured_at='2026-09-19T00:01:00Z' WHERE id=?1", [early]).unwrap();
    let late = add_photo(&db, Path::new("late.jpg"), 3000);
    db.execute("UPDATE clips SET captured_at='2026-09-19T00:03:00Z' WHERE id=?1", [late]).unwrap();
    let pinned = add_photo(&db, Path::new("pinned.jpg"), 3000);
    db.execute("UPDATE clips SET captured_at='2026-09-19T00:02:00Z' WHERE id=?1", [pinned]).unwrap();
    let no_exif = add_photo(&db, Path::new("no-exif.jpg"), 3000);
    db.execute("UPDATE clips SET captured_at=NULL WHERE id=?1", [no_exif]).unwrap();
    let no_exif_second = add_photo(&db, Path::new("no-exif-2.jpg"), 3000);
    db.execute("UPDATE clips SET captured_at=NULL WHERE id=?1", [no_exif_second]).unwrap();
    let episode_id: i64 = db.query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0)).unwrap();
    settings::set_setting(
        &db,
        &format!("ui.photo.order.{episode_id}"),
        &format!("[{pinned},{pinned},999999]"),
    ).unwrap();
    let clips = selected_clips(&db).unwrap();
    assert_eq!(clips.iter().map(|clip| clip.clip_id).collect::<Vec<_>>(), [video, pinned, early, late, no_exif, no_exif_second]);

    settings::set_setting(&db, &format!("ui.photo.order.{episode_id}"), "not-json").unwrap();
    let clips = selected_clips(&db).unwrap();
    assert_eq!(clips.iter().map(|clip| clip.clip_id).collect::<Vec<_>>(), [video, early, pinned, late, no_exif, no_exif_second]);
}

// Tiny uncompressed RGB TIFF: 40x20, EXIF orientation 6 (displayed as 20x40).
fn oriented_tiff(path: &Path) {
    let entries: [(u16,u16,u32,u32); 11] = [(256,4,1,40),(257,4,1,20),(258,3,3,146),(259,3,1,1),(262,3,1,2),(273,4,1,152),(274,3,1,6),(277,3,1,3),(278,4,1,20),(279,4,1,2400),(284,3,1,1)];
    let mut bytes = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
    bytes.extend(11u16.to_le_bytes());
    for (tag, kind, count, value) in entries {
        bytes.extend(tag.to_le_bytes()); bytes.extend(kind.to_le_bytes());
        bytes.extend(count.to_le_bytes()); bytes.extend(value.to_le_bytes());
    }
    bytes.extend(0u32.to_le_bytes());
    bytes.extend([8,0,8,0,8,0]);
    for _ in 0..800 { bytes.extend([220,30,10]); }
    std::fs::write(path, bytes).unwrap();
}
fn sips_convert(source: &Path, dest: &Path, format: &str) {
    if format == "heic" {
        std::fs::write(dest, include_bytes!("photo_fixtures/orientation-6.heic")).unwrap();
        return;
    }
    let output = Command::new("/usr/bin/sips").args(["-s","format",format]).arg(source).arg("--out").arg(dest).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn photo_delivery_mixed_kit_and_full_preserve_sources_and_companions() {
    let (ffmpeg, ffprobe) = ffmpeg_tools().expect("mixed fixture requires ffmpeg/ffprobe");
    let dir = TestDirectory::new();
    let mut db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let chapter = insert_chapter_at(&db, "章节", "2026-09-19");
    let seed = dir.path().join("seed.mp4");
    assert!(generate_fixture(&ffmpeg, &seed));
    let tiff = dir.path().join("oriented.tiff");
    oriented_tiff(&tiff);
    let mut originals = Vec::new();
    for i in 0..10 {
        let source = dir.path().join(format!("source_{i}.{}", if i < 5 {"mp4"} else if i == 5 {"HEIC"} else if i == 6 {"PNG"} else {"jpg"}));
        let id = if i < 5 {
            std::fs::copy(&seed, &source).unwrap();
            let id = insert_clip(&db, &source, "2026-09-19", &[], None);
            let meta = crate::core::import::probe_media(&source).unwrap();
            db.execute("UPDATE clips SET tb_num=?1,tb_den=?2,duration_ticks=?3 WHERE id=?4", params![meta.tb_num,meta.tb_den,meta.duration_ticks,id]).unwrap();
            let segment = insert_select_segment(&db, id, 0, meta.duration_ticks, 0);
            put_in_story_order(&db, id, Some(segment), i);
            id
        } else {
            sips_convert(&tiff, &source, if i == 5 {"heic"} else if i == 6 {"png"} else {"jpeg"});
            let id = add_photo(&db, &source, 3000);
            put_in_story_order(&db, id, None, i);
            if i == 9 {
                for (role, ext) in [("raw","ARW"),("xmp","xmp")] {
                    let companion = source.with_extension(ext);
                    std::fs::write(&companion, format!("fixture {role}")).unwrap();
                    db.execute("INSERT INTO clip_companions(clip_id,role,path) VALUES (?1,?2,?3)", params![id,role,companion.to_string_lossy()]).unwrap();
                    originals.push(companion);
                }
            }
            id
        };
        db.execute("UPDATE clips SET chapter_id=?1 WHERE id=?2", params![chapter,id]).unwrap();
        originals.push(source);
    }
    let snapshots: Vec<_> = originals.iter().map(|p| (std::fs::metadata(p).unwrap().len(), std::fs::metadata(p).unwrap().modified().unwrap(), blake3::hash(&std::fs::read(p).unwrap()))).collect();
    for mode in [MODE_KIT, MODE_FULL] {
        let destination = dir.path().join(mode);
        std::fs::create_dir(&destination).unwrap();
        let job_id = if mode == MODE_KIT { start_jianying_kit(&mut db, &destination).unwrap().job_id.unwrap() } else { start_export(&mut db, &destination, None, true, None).unwrap().job_id.unwrap() };
        let job = jobs::claim_next(&mut db).unwrap().unwrap();
        assert_eq!(job.id, job_id);
        run_export_package_with(&mut db, &job, &ffmpeg, &ffprobe).unwrap();
        let status = get_export_status(&db, Some(job_id)).unwrap();
        assert_eq!(status.completed_items, 10);
        assert_eq!(status.failed_items, 0);
        let output = PathBuf::from(status.output_path.unwrap());
        let selected_root = if mode == MODE_KIT { output.clone() } else { output.join(SELECTED_DIRECTORY) };
        let video_order = std::fs::read_to_string(selected_root.join("视频").join(KIT_ORDER_FILE)).unwrap();
        let photo_order = std::fs::read_to_string(selected_root.join("照片").join(KIT_ORDER_FILE)).unwrap();
        assert_eq!(video_order.lines().count(), 5, "{video_order}");
        assert_eq!(photo_order.lines().count(), 5, "{photo_order}");
        assert_eq!(photo_order.matches("照片 · 3 s").count(), 5);
        let media = if mode == MODE_KIT { output.clone() } else { output.join(SELECTED_DIRECTORY) };
        assert_eq!(std::fs::read_dir(media.join("视频").join("01_章节")).unwrap().count(), 5);
        assert_eq!(std::fs::read_dir(media.join("照片")).unwrap().count(), 8);
        for (extension, role) in [("ARW", "raw"), ("xmp", "xmp")] {
            let companion = media.join(&status.items[9].output_name).with_extension(extension);
            assert_eq!(std::fs::read(companion).unwrap(), format!("fixture {role}").as_bytes());
        }
        let heic = media.join(&status.items[5].output_name);
        assert_eq!(heic.extension().unwrap(), "jpg");
        let dimensions = Command::new("/usr/bin/sips").args(["-g","pixelWidth","-g","pixelHeight","-g","profile"]).arg(&heic).output().unwrap();
        let dimensions = String::from_utf8(dimensions.stdout).unwrap();
        assert!(dimensions.contains("pixelWidth: 461") && dimensions.contains("pixelHeight: 451"), "{dimensions}");
        assert!(dimensions.contains("sRGB"), "{dimensions}");
        for index in [6,7,8,9] {
            let original = dir.path().join(format!("source_{index}.{}", if index == 6 {"PNG"} else {"jpg"}));
            assert_eq!(std::fs::read(original).unwrap(), std::fs::read(media.join(&status.items[index].output_name)).unwrap());
        }
        if mode == MODE_FULL {
            assert!(output.join(CONTACT_SHEET_FILE).is_file());
            assert!(output.join(ROUGH_CUT_FILE).is_file());
            let csv = std::fs::read_to_string(output.join(SHOT_LIST_FILE)).unwrap();
            assert_eq!(csv.matches(",,,00:00:03.000,").count(), 5);
        }
    }
    // 已经排队的 v5 混合任务冻结的是旧输出名；升级后恢复执行仍按旧根目录布局完成。
    let legacy_destination = dir.path().join("legacy-v5");
    std::fs::create_dir(&legacy_destination).unwrap();
    let legacy_job_id = start_jianying_kit(&mut db, &legacy_destination).unwrap().job_id.unwrap();
    let mut legacy_payload = parse_payload(
        &db.query_row("SELECT payload FROM jobs WHERE id=?1", [legacy_job_id], |row| row.get::<_, String>(0)).unwrap(),
    ).unwrap();
    legacy_payload.version = 5;
    let ordinals = kit_chapter_ordinals(&legacy_payload.clips);
    for (index, (clip, item)) in legacy_payload.clips.iter().zip(legacy_payload.progress.items.iter_mut()).enumerate() {
        item.output_name = photo::relative_name(index + 1, ordinals[index], clip);
    }
    db.execute(
        "UPDATE jobs SET payload=?2 WHERE id=?1",
        params![legacy_job_id, serialize_payload(&legacy_payload).unwrap()],
    ).unwrap();
    let legacy_job = jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db, &legacy_job, &ffmpeg, &ffprobe).unwrap();
    let legacy_status = get_export_status(&db, Some(legacy_job_id)).unwrap();
    let legacy_output = PathBuf::from(legacy_status.output_path.unwrap());
    assert!(legacy_output.join(KIT_ORDER_FILE).is_file());
    assert!(!legacy_output.join("视频").exists());
    assert!(!legacy_output.join("照片").exists());
    assert_eq!(std::fs::read_dir(legacy_output.join("01_章节")).unwrap().count(), 12);
    for (path, (size, mtime, hash)) in originals.iter().zip(snapshots) {
        assert_eq!(std::fs::metadata(path).unwrap().len(), size);
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), mtime);
        assert_eq!(blake3::hash(&std::fs::read(path).unwrap()), hash);
    }
}
