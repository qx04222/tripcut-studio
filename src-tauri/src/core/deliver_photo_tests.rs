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
    assert_eq!(photo.media_kind, "photo");
    assert_eq!(photo.photo_hold_ms, 3500);
    // R21 W3:整包联系表 / 镜头表只收视频(video_only),照片的「整张 / 展示 N s」分支已删;
    // 这里只证明视频行原样(照片行的形状见 kit_order_text 的「NN 文件 照片」)。
    let video_clips = video_only(clips.clone());
    assert_eq!(video_clips.len(), 1);
    let contact = build_contact_sheet_items(&db, dir.path(), &video_clips);
    assert_eq!(contact[0].in_clock, "00:00:00.000");
    assert_eq!(contact[0].out_clock, "00:00:02.000");
    let payload = export_payload_fixture(video_clips.clone());
    let item = ExportItemStatus { clip_id: video_clips[0].clip_id, file_name: video_clips[0].file_name.clone(), output_name: "01.mp4".into(), status: "done".into(), note: None, warning: false };
    let csv = build_shot_list_csv(&payload.clips, &[item], &payload.platform_info);
    assert!(csv.contains(",00:00:00.000,00:00:02.000,00:00:02.000,"), "{csv}");
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
fn photo_delivery_kit_plan_is_video_only_and_photo_plan_is_flat() {
    let dir = TestDirectory::new();
    let db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let chapter = insert_chapter_at(&db, "章节", "2026-09-19");
    for name in ["a.mp4", "b.HEIC", "c.PNG", "d.jpg"] {
        let id = if name.ends_with("mp4") { insert_clip(&db, Path::new(name), "2026-09-19", &[1], None) } else { add_photo(&db, Path::new(name), 3000) };
        db.execute("UPDATE clips SET chapter_id=?1 WHERE id=?2", params![chapter, id]).unwrap();
    }
    // 照片线不套视频那一套:素材包只装视频;精选照片平铺 NN_<原名>,没有章名、没有「照片/」子目录。
    let plan = plan_jianying_kit(&db, None).unwrap();
    assert_eq!(plan.files, ["01_章节/01_章节_a.mp4"]);
    assert_eq!(plan.order_file, KIT_ORDER_FILE);
    let photos = plan_photo_export(&db, None).unwrap();
    assert_eq!(photos.files, ["01_b.jpg", "02_c.PNG", "03_d.jpg"]);
    assert!(photos.dir.contains("精选照片"), "{}", photos.dir);
    let clips = selected_clips(&db).unwrap();
    let text = kit_order_text(&clips[1..], &[]);
    assert_eq!(text.lines().count(), 3);
    assert_eq!(text.matches("照片").count(), 3);
    // 照片行没有时长、没有章名(hold_ms 只是内部字段)。
    assert!(text.lines().all(|l| !l.ends_with(" s")), "{text}");
    assert!(!text.contains("章节"), "{text}");
    assert!(!text.contains("未分章"), "{text}");
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
fn photo_delivery_mixed_kit_and_full_are_video_only_and_photos_export_separately() {
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
    // 素材包 / 整包:纯视频 —— 5 条,没有「视频/ 照片/」子目录、顺序.txt 里没有照片行。
    for mode in [MODE_KIT, MODE_FULL] {
        let destination = dir.path().join(mode);
        std::fs::create_dir(&destination).unwrap();
        let job_id = if mode == MODE_KIT { start_jianying_kit(&mut db, &destination).unwrap().job_id.unwrap() } else { start_export(&mut db, &destination, None, true, None).unwrap().job_id.unwrap() };
        let job = jobs::claim_next(&mut db).unwrap().unwrap();
        assert_eq!(job.id, job_id);
        run_export_package_with(&mut db, &job, &ffmpeg, &ffprobe).unwrap();
        let status = get_export_status(&db, Some(job_id)).unwrap();
        assert_eq!(status.completed_items, 5);
        assert_eq!(status.failed_items, 0);
        assert_eq!(status.selected_photo_count, 0);
        assert!(status.items.iter().all(|item| item.file_name.ends_with(".mp4")), "{:?}", status.items);
        let output = PathBuf::from(status.output_path.unwrap());
        let media = if mode == MODE_KIT { output.clone() } else { output.join(SELECTED_DIRECTORY) };
        assert!(!media.join("视频").exists());
        assert!(!media.join("照片").exists());
        let video_dir = if mode == MODE_KIT { media.join("01_章节") } else { media.clone() };
        assert_eq!(std::fs::read_dir(&video_dir).unwrap().filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "mp4")).count(), 5);
        let photo_files: Vec<String> = walkdir::WalkDir::new(&output).into_iter().filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| /* 交付包里不得出现照片 */ name.ends_with(".jpg") || name.ends_with(".PNG") || name.ends_with(".ARW") || name.ends_with(".xmp") || name.ends_with(".HEIC"))
            .filter(|name| name != CONTACT_SHEET_FILE)
            .collect();
        assert!(photo_files.is_empty(), "{mode} 里不得出现照片:{photo_files:?}");
        if mode == MODE_KIT {
            let order = std::fs::read_to_string(output.join(KIT_ORDER_FILE)).unwrap();
            assert_eq!(order.lines().count(), 5, "{order}");
            assert!(!order.contains("照片"), "{order}");
        } else {
            assert!(output.join(CONTACT_SHEET_FILE).is_file());
            assert!(output.join(ROUGH_CUT_FILE).is_file());
            let csv = std::fs::read_to_string(output.join(SHOT_LIST_FILE)).unwrap();
            assert_eq!(csv.matches(",,,00:00:03.000,").count(), 0);
            assert!(!csv.contains("source_9"), "{csv}");
        }
    }
    // 导出精选照片:5 张平铺 + 伴随两件 + 顺序.txt;HEIC 转 JPG(方向烘进像素、sRGB),其它逐字节。
    let destination = dir.path().join("photos");
    std::fs::create_dir(&destination).unwrap();
    let outcome = start_photo_export(&mut db, &destination).unwrap();
    let job_id = outcome.job_id.unwrap();
    assert_eq!(outcome.files, ["01_source_5.jpg", "02_source_6.PNG", "03_source_7.jpg", "04_source_8.jpg", "05_source_9.jpg"]);
    let job = jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db, &job, &ffmpeg, &ffprobe).unwrap();
    let status = get_export_status(&db, Some(job_id)).unwrap();
    assert_eq!(status.completed_items, 5);
    assert_eq!(status.failed_items, 0);
    assert_eq!(status.selected_photo_count, 5);
    assert_eq!(status.mode.as_deref(), Some(MODE_PHOTOS));
    let output = PathBuf::from(status.output_path.unwrap());
    assert!(output.file_name().unwrap().to_string_lossy().starts_with("EP01_精选照片_20"), "{}", output.display());
    let entries: Vec<String> = std::fs::read_dir(&output).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| !n.starts_with('.')).collect();
    assert_eq!(entries.len(), 8, "{entries:?}"); // 5 照片 + ARW + xmp + 顺序.txt
    let order = std::fs::read_to_string(output.join(KIT_ORDER_FILE)).unwrap();
    assert_eq!(order.lines().count(), 5, "{order}");
    assert!(order.lines().all(|line| line.contains("照片") && !line.ends_with(" s") && !line.contains("章")), "{order}");
    for (extension, role) in [("ARW", "raw"), ("xmp", "xmp")] {
        let companion = output.join(&status.items[4].output_name).with_extension(extension);
        assert_eq!(std::fs::read(companion).unwrap(), format!("fixture {role}").as_bytes());
    }
    let heic = output.join(&status.items[0].output_name);
    assert_eq!(heic.extension().unwrap(), "jpg");
    let dimensions = Command::new("/usr/bin/sips").args(["-g","pixelWidth","-g","pixelHeight","-g","profile"]).arg(&heic).output().unwrap();
    let dimensions = String::from_utf8(dimensions.stdout).unwrap();
    assert!(dimensions.contains("pixelWidth: 461") && dimensions.contains("pixelHeight: 451"), "{dimensions}");
    assert!(dimensions.contains("sRGB"), "{dimensions}");
    for index in [1, 2, 3, 4] {
        let original = dir.path().join(format!("source_{}.{}", index + 5, if index == 1 {"PNG"} else {"jpg"}));
        assert_eq!(std::fs::read(original).unwrap(), std::fs::read(output.join(&status.items[index].output_name)).unwrap());
    }
    let op = archive::for_job(&db, job_id).unwrap().unwrap();
    assert_eq!(op.kind, "photo");
    assert_eq!(op.status, "done");
    for (path, (size, mtime, hash)) in originals.iter().zip(snapshots) {
        assert_eq!(std::fs::metadata(path).unwrap().len(), size);
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), mtime);
        assert_eq!(blake3::hash(&std::fs::read(path).unwrap()), hash);
    }
}

#[test]
fn ph10_raw_photo_export_includes_jpeg_original_and_order_label() {
    let dir=TestDirectory::new();let mut db=db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let source=dir.path().join("solo.dng");
    let original=include_bytes!("../../../qa/ai-eval/raw/minimal-rgb.dng");
    std::fs::write(&source,original).unwrap();add_photo(&db,&source,3000);
    let destination=dir.path().join("photos");std::fs::create_dir(&destination).unwrap();
    let job_id=start_photo_export(&mut db,&destination).unwrap().job_id.unwrap();
    let job=jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db,&job,OsStr::new(""),OsStr::new("")).unwrap();
    let status=get_export_status(&db,Some(job_id)).unwrap();assert_eq!(status.failed_items,0);
    let root=PathBuf::from(status.output_path.unwrap());
    assert_eq!(std::fs::read(root.join("01_solo.dng")).unwrap(),original);
    let jpg=image::open(root.join("01_solo.jpg")).unwrap();
    assert_eq!((jpg.width(),jpg.height()),(48,64));
    let order=std::fs::read_to_string(root.join(KIT_ORDER_FILE)).unwrap();
    assert!(order.contains("RAW"),"{order}");assert_eq!(order.lines().count(),1);
    assert!(!order.trim_end().ends_with(" s"),"照片行不带时长:{order}");
    // 素材包不再带照片:只有一张 RAW 时素材包无东西可装。
    assert!(plan_jianying_kit(&db,None).is_err());
}

#[test]
fn ph11_photo_kit_logs_originals_and_undo_preserves_edits() {
    let dir=TestDirectory::new();
    let mut db=db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let source=dir.path().join("photo.jpg");
    let raw=dir.path().join("photo.ARW");
    std::fs::write(&source,b"original photo").unwrap(); std::fs::write(&raw,b"original raw").unwrap();
    let clip=add_photo(&db,&source,3000);
    db.execute("INSERT INTO clip_companions(clip_id,role,path) VALUES(?1,'raw',?2)",params![clip,raw.to_string_lossy()]).unwrap();
    let destination=dir.path().join("destination"); std::fs::create_dir(&destination).unwrap();
    let job_id=start_photo_export(&mut db,&destination).unwrap().job_id.unwrap();
    let job=jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db,&job,OsStr::new(""),OsStr::new("")).unwrap();
    let op=crate::core::archive::for_job(&db,job_id).unwrap().expect("delivery must have an archive operation");
    assert_eq!(op.status,"done");
    assert_eq!(op.kind,"photo");
    let status=get_export_status(&db,Some(job_id)).unwrap();
    let photo=op.destination.join(&status.items[0].output_name);
    std::fs::write(&photo,b"user edit").unwrap();
    crate::core::archive::undo(&db,&op.id).unwrap();
    assert_eq!(std::fs::read(photo).unwrap(),b"user edit");
    assert_eq!(std::fs::read(source).unwrap(),b"original photo");
    assert_eq!(std::fs::read(raw).unwrap(),b"original raw");
}

#[test]
fn ph11_photo_export_and_startup_adoption_share_one_archive() {
    let dir=TestDirectory::new();
    let mut db=db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let source=dir.path().join("photo.jpg");std::fs::write(&source,b"original photo").unwrap();
    add_photo(&db,&source,3000);
    let destination=dir.path().join("destination");std::fs::create_dir(&destination).unwrap();
    // 整包交付不再带照片:只有照片时整包无东西可装。
    assert!(start_export(&mut db,&destination,None,false,None).is_err());
    let id=start_photo_export(&mut db,&destination).unwrap().job_id.unwrap();
    let job=jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db,&job,OsStr::new(""),OsStr::new("")).unwrap();
    let op=archive::for_job(&db,id).unwrap().unwrap();
    assert!(op.destination.join(KIT_ORDER_FILE).is_file());
    assert!(!op.destination.join(SHOT_LIST_FILE).exists());
    assert!(!op.destination.join(README_FILE).exists());
    // Simulate the delivery job needing adoption after filesystem completion.
    db.execute("UPDATE jobs SET status='pending' WHERE id=?1",[id]).unwrap();
    archive::reconcile(&db).unwrap();archive::reconcile(&db).unwrap();
    let restarted=jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db,&restarted,OsStr::new(""),OsStr::new("")).unwrap();
    assert_eq!(archive::for_job(&db,id).unwrap().unwrap().destination,op.destination);
    assert_eq!(db.query_row("SELECT count(*) FROM archive_ops",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(get_export_status(&db,Some(id)).unwrap().status,"done");
    assert_eq!(std::fs::read(source).unwrap(),b"original photo");
}

#[test]
fn ph11_explicit_resume_clears_both_cancellation_records_before_preparation() {
    let dir=TestDirectory::new();let mut db=db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);let source=dir.path().join("photo.jpg");std::fs::write(&source,b"photo").unwrap();
    add_photo(&db,&source,3000);
    let destination=dir.path().join("dest");std::fs::create_dir(&destination).unwrap();
    let job=start_photo_export(&mut db,&destination).unwrap().job_id.unwrap();
    let payload:String=db.query_row("SELECT payload FROM jobs WHERE id=?1",[job],|r|r.get(0)).unwrap();
    let parsed=parse_payload(&payload).unwrap();
    let id=archive::begin(&db,"photo",&destination.join("resumed"),vec![(source.clone(),PathBuf::from(&parsed.progress.items[0].output_name))],Some(job)).unwrap();
    db.execute("UPDATE jobs SET status='failed',cancel_requested=1,payload=json_set(payload,'$.progress.cancel_requested',json('true')) WHERE id=?1",[job]).unwrap();
    let queued=archive::resume(&db,&id).unwrap();assert_ne!(queued.status,"done");
    let claimed=jobs::claim_next(&mut db).unwrap().unwrap();
    assert!(!parse_payload(&claimed.payload).unwrap().progress.cancel_requested);
    run_export_package_with(&mut db,&claimed,OsStr::new(""),OsStr::new("")).unwrap();
    assert_eq!(archive::get(&db,&id).unwrap().status,"done");
    assert_eq!(std::fs::read(source).unwrap(),b"photo");
}

#[test]
fn ph11_export_uses_frozen_auxiliary_inputs_instead_of_new_music_selection() {
    let dir=TestDirectory::new();let mut db=db::open_project(&dir.db_path()).unwrap();photo_schema(&db);
    let source=dir.path().join("photo.jpg");std::fs::write(&source,b"photo").unwrap();add_photo(&db,&source,3000);
    let music=dir.path().join("frozen.mp3");std::fs::write(&music,b"frozen music").unwrap();
    let destination=dir.path().join("dest");std::fs::create_dir(&destination).unwrap();
    let job_id=start_photo_export(&mut db,&destination).unwrap().job_id.unwrap();
    let job=jobs::claim_next(&mut db).unwrap().unwrap();let payload=parse_payload(&job.payload).unwrap();
    let op=archive::begin(&db,"photo",&destination.join("frozen-kit"),vec![
        (source,PathBuf::from(&payload.progress.items[0].output_name)),(music,"配乐.mp3".into())
    ],Some(job_id)).unwrap();
    // There is no music selection in the live DB; the frozen plan is authoritative.
    run_export_package_with(&mut db,&job,OsStr::new(""),OsStr::new("")).unwrap();
    let result=archive::get(&db,&op).unwrap();assert_eq!(result.status,"done");
    assert_eq!(std::fs::read(result.destination.join("配乐.mp3")).unwrap(),b"frozen music");
}

/// PH-11 端到端:5 视频 + 5 照片(含 RAW/XMP 伴随)—— 素材包只装 5 条视频(照片线不套视频那一套),
/// 精选照片另走「导出精选照片」;两个 op 都 `done`、每个文件 `published` 且目标哈希 = 冻结哈希、
/// 目标目录旁不留准备副本 / 空暂存目录 / 锁文件。
#[test]
fn ph11_end_to_end_kit_five_videos_five_photos_is_done_published_and_leaves_no_litter() {
    let (ffmpeg, ffprobe) = ffmpeg_tools().expect("e2e fixture requires ffmpeg/ffprobe");
    let dir = TestDirectory::new();
    let mut db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let chapter = insert_chapter_at(&db, "章节", "2026-09-20");
    let seed = dir.path().join("seed.mp4");
    assert!(generate_fixture(&ffmpeg, &seed));
    let tiff = dir.path().join("oriented.tiff");
    oriented_tiff(&tiff);
    let mut originals = Vec::new();
    for i in 0..10 {
        let source = dir.path().join(format!("source_{i}.{}", if i < 5 { "mp4" } else { "jpg" }));
        let id = if i < 5 {
            std::fs::copy(&seed, &source).unwrap();
            let id = insert_clip(&db, &source, "2026-09-20", &[], None);
            let meta = crate::core::import::probe_media(&source).unwrap();
            db.execute("UPDATE clips SET tb_num=?1,tb_den=?2,duration_ticks=?3 WHERE id=?4", params![meta.tb_num, meta.tb_den, meta.duration_ticks, id]).unwrap();
            let segment = insert_select_segment(&db, id, 0, meta.duration_ticks, 0);
            put_in_story_order(&db, id, Some(segment), i);
            id
        } else {
            sips_convert(&tiff, &source, "jpeg");
            let id = add_photo(&db, &source, 3000);
            put_in_story_order(&db, id, None, i);
            if i == 9 {
                for (role, ext) in [("raw", "ARW"), ("xmp", "xmp")] {
                    let companion = source.with_extension(ext);
                    std::fs::write(&companion, format!("fixture {role}")).unwrap();
                    db.execute("INSERT INTO clip_companions(clip_id,role,path) VALUES (?1,?2,?3)", params![id, role, companion.to_string_lossy()]).unwrap();
                    originals.push(companion);
                }
            }
            id
        };
        db.execute("UPDATE clips SET chapter_id=?1 WHERE id=?2", params![chapter, id]).unwrap();
        originals.push(source);
    }
    let snapshots: Vec<_> = originals.iter().map(|p| blake3::hash(&std::fs::read(p).unwrap())).collect();
    let destination = dir.path().join("交付目标");
    std::fs::create_dir(&destination).unwrap();
    let job_id = start_jianying_kit(&mut db, &destination).unwrap().job_id.unwrap();
    let job = jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db, &job, &ffmpeg, &ffprobe).unwrap();

    let status = get_export_status(&db, Some(job_id)).unwrap();
    assert_eq!((status.status.as_str(), status.completed_items, status.failed_items), ("done", 5, 0));
    let kit_output = PathBuf::from(status.output_path.clone().unwrap());
    let kit_op = archive::for_job(&db, job_id).unwrap().unwrap();
    assert_eq!((kit_op.kind.as_str(), kit_op.status.as_str()), ("kit", "done"));
    assert_eq!(kit_op.destination, kit_output);
    assert_eq!(std::fs::read_dir(kit_output.join("01_章节")).unwrap().count(), 5);
    assert!(!kit_output.join("视频").exists() && !kit_output.join("照片").exists());
    let kit_order = std::fs::read_to_string(kit_output.join(KIT_ORDER_FILE)).unwrap();
    assert_eq!(kit_order.lines().count(), 5, "{kit_order}");
    assert!(!kit_order.contains("照片"), "{kit_order}");
    assert_eq!(kit_op.files.iter().filter(|f| f.status == "published").count(), kit_op.files.len());
    assert_eq!(kit_op.files.iter().filter(|f| f.source.extension().is_some_and(|e| e == "mp4")).count(), 5);

    // 精选照片:另一个 op(kind=photo),5 照片 + RAW + XMP 冻结原件;顺序.txt 与完成标记冻结进同一日志。
    let job_id = start_photo_export(&mut db, &destination).unwrap().job_id.unwrap();
    let job = jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db, &job, &ffmpeg, &ffprobe).unwrap();
    let status = get_export_status(&db, Some(job_id)).unwrap();
    assert_eq!((status.status.as_str(), status.completed_items, status.failed_items), ("done", 5, 0));
    let output = PathBuf::from(status.output_path.clone().unwrap());
    let op = archive::for_job(&db, job_id).unwrap().unwrap();
    assert_eq!((op.kind.as_str(), op.status.as_str()), ("photo", "done"));
    assert_eq!(op.destination, output);
    let (op_status, finished): (String, Option<String>) = db.query_row("SELECT status,finished_at FROM archive_ops WHERE id=?1", [&op.id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(op_status, "done");
    assert!(finished.is_some());
    // 5 照片 + RAW + XMP 是冻结原件;顺序.txt 与完成标记在准备后被冻结进同一日志;全部 published。
    let mut rows = db.prepare("SELECT src_path,src_hash,dst_path,status FROM archive_op_files WHERE op_id=?1 ORDER BY file_index").unwrap();
    let files: Vec<(String, String, String, String)> = rows.query_map([&op.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect();
    assert_eq!(files.len(), 9, "{files:?}");
    let generated = [KIT_ORDER_FILE, COMPLETION_MARKER_FILE];
    for (src, src_hash, dst, file_status) in &files {
        assert_eq!(file_status, "published", "{dst}");
        assert!(Path::new(dst).starts_with(&output), "{dst}");
        assert!(Path::new(dst).is_file(), "{dst}");
        let is_generated = generated.iter().any(|name| src.ends_with(name));
        if is_generated {
            // 准备目录里的生成文件被冻结后原样复制到交付包。
            assert_eq!(blake3::hash(&std::fs::read(dst).unwrap()).to_hex().to_string(), *src_hash, "{dst}");
        } else {
            let root = dir.path().canonicalize().unwrap();
            assert!(Path::new(src).starts_with(&root) && !Path::new(src).starts_with(destination.canonicalize().unwrap()), "{src}");
            assert_eq!(blake3::hash(&std::fs::read(src).unwrap()).to_hex().to_string(), *src_hash, "{src}");
            if !src.ends_with(".mp4") {
                assert_eq!(std::fs::read(src).unwrap(), std::fs::read(dst).unwrap(), "原样复制:{dst}");
            }
        }
    }
    assert_eq!(files.iter().filter(|f| f.0.ends_with(".mp4")).count(), 0);
    assert_eq!(files.iter().filter(|f| f.0.ends_with(KIT_ORDER_FILE)).count(), 1);
    // 顺序.txt:根目录一份,5 行照片,没有时长、没有章名,内容 = kit_order_text。
    let payload = parse_payload(&db.query_row("SELECT payload FROM jobs WHERE id=?1", [job_id], |r| r.get::<_, String>(0)).unwrap()).unwrap();
    let text = std::fs::read_to_string(output.join(KIT_ORDER_FILE)).unwrap();
    assert_eq!(text, kit_order_text(&payload.clips, &payload.progress.items));
    assert_eq!(text.lines().count(), 5, "{text}");
    assert_eq!(text.matches("照片").count(), 5);
    assert!(text.lines().all(|l| !l.ends_with(" s") && !l.contains("章")), "{text}");
    assert!(!output.join("视频").exists() && !output.join("照片").exists());
    assert_eq!(std::fs::read_dir(&output).unwrap().filter(|e| !e.as_ref().unwrap().file_name().to_string_lossy().starts_with('.')).count(), 8);
    // 原件未动。
    for (path, hash) in originals.iter().zip(snapshots) {
        assert_eq!(blake3::hash(&std::fs::read(path).unwrap()), hash);
    }
    // 交付目标目录旁只剩交付包本身:没有 .tripcut-prepare-* 副本、空 .tripcut-archive-* 暂存目录或锁文件。
    let leftovers: Vec<String> = std::fs::read_dir(&destination).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|name| name.starts_with('.')).collect();
    assert!(leftovers.is_empty(), "交付完成后不应留下:{leftovers:?}");
    // 交付完成后,重启对账不应再改变任何东西。
    assert!(archive::reconcile(&db).unwrap().is_empty());
    assert_eq!(archive::get(&db, &op.id).unwrap().status, "done");
}

/// D-1(接线 W3,业主拍板):一条坏源只让它所在的 companion 组标 failed,其余文件照常发布;
/// op 终态 done + failed 计数,`顺序.txt` 给失败项留编号并标「(没导出来)」;目标旁不留 .tripcut-* 残留。
#[test]
fn d1_one_bad_source_fails_only_its_companion_group_and_the_rest_is_published() {
    let dir = TestDirectory::new();
    let mut db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    let tiff = dir.path().join("oriented.tiff");
    oriented_tiff(&tiff);
    let good_a = dir.path().join("a.jpg");
    sips_convert(&tiff, &good_a, "jpeg");
    let bad = dir.path().join("b.heic");
    std::fs::write(&bad, b"not a heic at all").unwrap();
    let bad_xmp = dir.path().join("b.xmp");
    std::fs::write(&bad_xmp, b"bad sidecar").unwrap();
    let good_c = dir.path().join("c.jpg");
    sips_convert(&tiff, &good_c, "jpeg");
    let good_c_raw = dir.path().join("c.ARW");
    std::fs::write(&good_c_raw, b"raw c").unwrap();
    let a = add_photo(&db, &good_a, 3000);
    let b = add_photo(&db, &bad, 3000);
    let c = add_photo(&db, &good_c, 3000);
    db.execute("INSERT INTO clip_companions(clip_id,role,path) VALUES(?1,'xmp',?2)", params![b, bad_xmp.to_string_lossy()]).unwrap();
    db.execute("INSERT INTO clip_companions(clip_id,role,path) VALUES(?1,'raw',?2)", params![c, good_c_raw.to_string_lossy()]).unwrap();
    for (order, id) in [a, b, c].iter().enumerate() { put_in_story_order(&db, *id, None, order as i64); }
    let destination = dir.path().join("destination");
    std::fs::create_dir(&destination).unwrap();
    let job_id = start_photo_export(&mut db, &destination).unwrap().job_id.unwrap();
    let job = jobs::claim_next(&mut db).unwrap().unwrap();
    run_export_package_with(&mut db, &job, OsStr::new(""), OsStr::new("")).expect("一条坏源不能让整包导出失败");

    let status = get_export_status(&db, Some(job_id)).unwrap();
    assert_eq!(status.status, "done");
    assert_eq!(status.completed_items, 2);
    assert_eq!(status.failed_items, 1);
    assert_eq!(status.items[1].status, "failed");
    let op = crate::core::archive::for_job(&db, job_id).unwrap().unwrap();
    assert_eq!(op.status, "done");
    let failed: Vec<String> = op.files.iter().filter(|f| f.status == "failed").map(|f| f.destination.file_name().unwrap().to_string_lossy().into_owned()).collect();
    let published = op.files.iter().filter(|f| f.status == "published").count();
    let bad_name = Path::new(&status.items[1].output_name);
    assert_eq!(failed, vec![bad_name.file_name().unwrap().to_string_lossy().into_owned(), format!("{}.xmp", bad_name.file_stem().unwrap().to_string_lossy())], "{:?}", op.files);
    assert!(published >= 4, "a.jpg、c.jpg、c.ARW、顺序.txt 至少四条已发布:{:?}", op.files);
    assert_eq!(op.kind, "photo");
    assert!(!op.errors.is_empty());
    let root = PathBuf::from(status.output_path.clone().unwrap());
    assert!(root.join(&status.items[0].output_name).is_file());
    assert!(root.join(&status.items[2].output_name).is_file());
    assert!(root.join(Path::new(&status.items[2].output_name).with_extension("ARW")).is_file());
    assert!(!root.join(&status.items[1].output_name).exists());
    assert!(!root.join(Path::new(&status.items[1].output_name).with_extension("xmp")).exists());
    let order = std::fs::read_to_string(root.join(KIT_ORDER_FILE)).unwrap();
    assert_eq!(order.lines().count(), 3, "{order}");
    assert!(order.lines().nth(1).unwrap().contains("(没导出来)"), "{order}");
    assert!(!order.lines().next().unwrap().contains("(没导出来)"), "{order}");
    let leftovers: Vec<String> = std::fs::read_dir(&destination).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with('.')).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert!(crate::core::archive::reconcile(&db).unwrap().is_empty());
    assert_eq!(std::fs::read(&bad).unwrap(), b"not a heic at all");
}

/// R21 W3 真机 F-W3-04:视频交付抽屉的「内容」行读的是空闲态 export_status —— 此前 selected_count /
/// total_duration_seconds 把精选照片(与它们的 hold_ms)也算进去(真机「8 项 · 预计 0:34」= 2 视频 + 6 照片 × 3 s)。
/// 空闲态只数视频;照片张数走 selected_photo_count(照片抽屉自己用)。
#[test]
fn idle_export_status_counts_only_videos_and_reports_photos_separately() {
    let dir = TestDirectory::new();
    let db = db::open_project(&dir.db_path()).unwrap();
    photo_schema(&db);
    insert_clip(&db, Path::new("video.mp4"), "2026-09-19T00:00:00Z", &[1], None);
    add_photo(&db, Path::new("a.jpg"), 3000);
    add_photo(&db, Path::new("b.HEIC"), 3000);
    let status = get_export_status(&db, None).unwrap();
    assert_eq!(status.job_id, None);
    assert_eq!(status.selected_count, 1, "{status:?}");
    assert_eq!(status.selected_whole_count + status.selected_segment_count, 1);
    assert_eq!(status.total_duration_seconds, 2.0);
    assert_eq!(status.selected_photo_count, 2);
}
