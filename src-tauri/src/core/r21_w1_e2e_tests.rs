//! R21 W1 端到端联调(接线人,2026-09-19):同一个隔离临时目录里 5 段视频 + 5 张照片,
//! 走**真实**链路 —— `start_import` → JobRunner 排空(photo_probe / thumbnail / companions /
//! chapterize + 视频的 ffprobe/proxy/…)→ 评级选中 → `start_jianying_kit` → 同一 JobRunner
//! 跑 `export_package` → 素材包落盘。
//! 判据(规格 §3 PH-08a / §6 W1):`顺序.txt` 10 行、`01_章节/` 10 主文件 + 伴随、HEIC→JPG 且
//! 方向 6 已烘进像素、伴随文件与主文件同目录、源文件哈希不变、照片零视频任务。
//! 与 `deliver_photo_tests` 的区别:那边手搭最小 schema 直接插行;这里从磁盘扫描开始,
//! 迁移 0050/0051 的真实表、photo-core 的真实 DTO、photo-deliver 的真实 attach 一起过。
//! 不碰业主目录:所有路径都在 `TestDirectory`(系统临时目录)下,cache 在库旁边。
use std::ffi::OsString;
use std::path::Path;
use std::process::Command;

use rusqlite::Connection;

use super::db;
use super::deliver::{get_export_status, start_jianying_kit, start_photo_export, KIT_ORDER_FILE};
use super::import::{list_clips, start_import};
use super::jobs::JobRunner;
use super::photo_probe;
use super::ratings::rate_clip;
use super::test_support::TestDirectory;

fn ffmpeg() -> Option<OsString> {
    let connection = Connection::open_in_memory().unwrap();
    let ffmpeg = super::settings::configured_executable(&connection, super::settings::FFMPEG_PATH_KEY, "FFMPEG_PATH", "ffmpeg").ok()?;
    Command::new(&ffmpeg).arg("-version").output().ok().filter(|o| o.status.success())?;
    Some(ffmpeg)
}

/// 每段不同的音频频率 → 字节不同,否则导入会按 quick_hash 判重(「已存在相同素材」)。
fn video(ffmpeg: &OsString, path: &Path, seconds: u32, hz: u32, minute: u32) {
    let status = Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", &format!("testsrc2=s=320x180:r=25:d={seconds}"),
               "-f", "lavfi", "-i", &format!("sine=frequency={hz}:sample_rate=48000:duration={seconds}"),
               "-shortest", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac",
               "-metadata", &format!("creation_time=2026-09-19T10:{minute:02}:00Z")])
        .arg(path).status().unwrap();
    assert!(status.success(), "ffmpeg fixture {}", path.display());
}

/// 96×64 横幅 JPEG(image crate)+ 拼进一段最小 EXIF APP1:IFD0 = Orientation + ExifIFD 指针,
/// Exif IFD = DateTimeOriginal(2026-09-19 10:MM:00)+ 可选 OffsetTimeOriginal(`Some("+00:00")` 让它与
/// 视频的 `…Z` 同一瞬时;`None` = 相机没写时区,photo_probe 必须按导入机时区换成 UTC)。
/// `seed` 让每张字节不同(否则导入按 quick_hash 判重)。
fn jpeg_with_orientation(path: &Path, orientation: u8, seed: u8, datetime: &str, offset: Option<&str>) {
    let mut img = image::RgbImage::new(96, 64);
    for (x, y, p) in img.enumerate_pixels_mut() { *p = image::Rgb([(x * 2) as u8, (y * 3) as u8, 90u8.wrapping_add(seed.wrapping_mul(37))]); }
    let mut bytes = std::io::Cursor::new(Vec::new());
    img.write_to(&mut bytes, image::ImageFormat::Jpeg).unwrap();
    let jpeg = bytes.into_inner();
    let mut tiff: Vec<u8> = vec![b'I', b'I', 42, 0, 8, 0, 0, 0];
    // IFD0 @8: 2 entries, next IFD 0 → ends @38
    tiff.extend_from_slice(&2u16.to_le_bytes());
    tiff.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0]);
    tiff.extend_from_slice(&[0x69, 0x87, 4, 0, 1, 0, 0, 0]); tiff.extend_from_slice(&38u32.to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes());
    // Exif IFD @38: DateTimeOriginal ASCII×20 [+ OffsetTimeOriginal ASCII×7], next 0, 数据紧跟其后
    let entries = 1 + u16::from(offset.is_some());
    let data_at = 38 + 2 + 12 * u32::from(entries) + 4;
    tiff.extend_from_slice(&entries.to_le_bytes());
    tiff.extend_from_slice(&[0x03, 0x90, 2, 0, 20, 0, 0, 0]); tiff.extend_from_slice(&data_at.to_le_bytes());
    if offset.is_some() { tiff.extend_from_slice(&[0x11, 0x90, 2, 0, 7, 0, 0, 0]); tiff.extend_from_slice(&(data_at + 20).to_le_bytes()); }
    tiff.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(datetime.len(), 19, "{datetime}");
    tiff.extend_from_slice(format!("{datetime}\0").as_bytes());
    if let Some(o) = offset { tiff.extend_from_slice(format!("{o}\0").as_bytes()); }
    assert_eq!(tiff.len(), if offset.is_some() { 95 } else { 76 });
    let mut app1 = vec![0xff, 0xe1];
    app1.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
    app1.extend_from_slice(b"Exif\0\0");
    app1.extend_from_slice(&tiff);
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    std::fs::write(path, out).unwrap();
}

/// sips 把 JPEG 转 HEIC 时会把 EXIF orientation 一起带过去(ImageIO 读回 6;`sips -g orientation` 不显示,别信它)。
fn sips(source: &Path, dest: &Path, format: &str, tmp: &Path) {
    let output = Command::new("/usr/bin/sips").env("TMPDIR", tmp).args(["-s", "format", format]).arg(source).arg("--out").arg(dest).output().unwrap();
    assert!(output.status.success(), "sips {format}: {}", String::from_utf8_lossy(&output.stderr));
}

fn sips_props(path: &Path) -> String {
    let output = Command::new("/usr/bin/sips").args(["-g", "pixelWidth", "-g", "pixelHeight", "-g", "profile"]).arg(path).output().unwrap();
    String::from_utf8(output.stdout).unwrap()
}

fn drain(db_path: &Path, what: &str) {
    let mut steps = 0;
    while JobRunner::run_one(db_path).unwrap() {
        steps += 1;
        assert!(steps < 2000, "{what}: JobRunner 没有收敛(>2000 步)");
    }
}

#[test]
fn r21_w1_e2e_import_five_videos_five_photos_then_jianying_kit() {
    let Some(ffmpeg) = ffmpeg() else { eprintln!("skip: ffmpeg not available"); return; };
    let dir = TestDirectory::new();
    let media = dir.path().join("media");
    let tmp = dir.path().join("tmp");
    std::fs::create_dir_all(&media).unwrap();
    std::fs::create_dir_all(&tmp).unwrap();

    // 文件名交错(扫描按名排序),让媒体池 / 顺序.txt 天然混排:视频 01,03,05,07,09;照片 02,04,06,08,10。
    // 拍摄时间 10:01…10:10 逐分钟交错(视频 creation_time `…Z` / 照片 DateTimeOriginal + OffsetTimeOriginal
    // `+00:00`),chapterize 分进同一章。C10 故意不带 offset:相机没写时区,EXIF 写的是 10:10Z 在**本机时区**
    // 的钟面(多伦多是 06:10),photo_probe 必须按导入机时区把它换回 10:10Z 才能排在 C09 后面、进同一章;
    // 修前它会被当成 10:10 UTC 字面值(多伦多机上偏 4 小时)。
    for n in [1u32, 3, 5, 7, 9] { video(&ffmpeg, &media.join(format!("C{n:02}.mp4")), 1, 300 + n * 40, n); }
    let base = tmp.join("base_o6.jpg");
    jpeg_with_orientation(&base, 6, 1, "2026:09:19 10:02:00", Some("+00:00"));
    sips(&base, &media.join("C02.HEIC"), "heic", &tmp);          // HEIC,方向 6
    let base_png = tmp.join("base_png.jpg");
    jpeg_with_orientation(&base_png, 1, 2, "2026:09:19 10:04:00", Some("+00:00"));
    sips(&base_png, &media.join("C04.PNG"), "png", &tmp);        // PNG
    jpeg_with_orientation(&media.join("C06.jpg"), 1, 3, "2026:09:19 10:06:00", Some("+00:00"));     // JPG
    jpeg_with_orientation(&media.join("DSC00042.JPG"), 1, 4, "2026:09:19 10:08:00", Some("+00:00")); // 假 ARW + JPG + xmp 一组
    std::fs::write(media.join("DSC00042.ARW"), b"fake raw bytes for companion pairing").unwrap();
    std::fs::write(media.join("DSC00042.xmp"), b"<x:xmpmeta/>").unwrap();
    let local_1010: String = Connection::open_in_memory().unwrap()
        .query_row("SELECT strftime('%Y:%m:%d %H:%M:%S','2026-09-19T10:10:00Z','localtime')", [], |r| r.get(0)).unwrap();
    jpeg_with_orientation(&media.join("C10.jpg"), 1, 5, &local_1010, None);

    let originals: Vec<_> = std::fs::read_dir(&media).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(originals.len(), 12, "10 主文件 + ARW + xmp");
    let hashes: Vec<_> = originals.iter().map(|p| blake3::hash(&std::fs::read(p).unwrap())).collect();

    let mut connection = db::open_project(&dir.db_path()).unwrap();
    let started = start_import(&mut connection, &media).unwrap();
    assert_eq!(started.total, 10, "扫描:5 视频 + 5 照片,RAW/xmp 不建档");
    drain(&dir.db_path(), "import");

    // —— 入库形状(photo-core)——
    let clips = list_clips(&connection).unwrap();
    if std::env::var("R21_E2E_DEBUG").is_ok() {
        let mut q = connection.prepare("SELECT j.id,j.kind,j.status,j.clip_id,c.rel_path,j.blocked_summary FROM jobs j LEFT JOIN clips c ON c.id=j.clip_id ORDER BY j.id").unwrap();
        for row in q.query_map([], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,Option<i64>>(3)?, r.get::<_,Option<String>>(4)?, r.get::<_,Option<String>>(5)?))).unwrap() { eprintln!("job {:?}", row.unwrap()); }
        for c in &clips { eprintln!("clip {} kind={} status={} cover={:?} err={:?}", c.file_name, c.kind, c.status, c.cover_url.is_some(), c.error); }
    }
    assert_eq!(clips.len(), 10);
    let photos: Vec<_> = clips.iter().filter(|c| c.kind == "photo").collect();
    let videos: Vec<_> = clips.iter().filter(|c| c.kind == "video").collect();
    assert_eq!((photos.len(), videos.len()), (5, 5));
    for p in &photos {
        assert_eq!((p.duration_ticks, p.fps_num, p.fps_den), (Some(0), None, None), "{}", p.file_name);
        let meta = p.photo.as_ref().unwrap_or_else(|| panic!("{} 没有 photo_meta", p.file_name));
        assert_eq!(meta.hold_ms, 3000);
        assert!(p.status == "ready", "{} status={} err={:?}", p.file_name, p.status, p.error);
        // cover_url / photo.preview_url 的签名 URL 在 lib.rs(媒体服务器)那一层才填;core 层看 cache_artifacts + 文件。
        let id = p.id.unwrap();
        let cover_rel: String = connection.query_row("SELECT rel_path FROM cache_artifacts WHERE clip_id=?1 AND kind='cover'", [id], |r| r.get(0))
            .unwrap_or_else(|e| panic!("{} 没有 cover 记录:{e}", p.file_name));
        let cover_path = dir.path().join("cache").join(&cover_rel);
        assert!(cover_path.is_file(), "{}", cover_path.display());
        let preview = cover_path.with_file_name(format!("preview.{}", cover_path.extension().unwrap().to_str().unwrap()));
        assert!(preview.is_file(), "{} 没有 preview:{}", p.file_name, preview.display());
    }
    let heic = photos.iter().find(|p| p.file_name == "C02.HEIC").unwrap();
    let heic_meta = heic.photo.as_ref().unwrap();
    assert_eq!((heic_meta.width, heic_meta.height, heic_meta.orientation), (96, 64, 6), "photo_meta 存原始像素 + 方向");
    assert_eq!((heic.width, heic.height), (Some(64), Some(96)), "clips.width/height 按方向换算(竖)");
    let raw_jpg = photos.iter().find(|p| p.file_name == "DSC00042.JPG").unwrap();
    let mut roles: Vec<_> = raw_jpg.companions.iter().map(|c| c.role.as_str()).collect();
    roles.sort_unstable();
    assert_eq!(roles, ["raw", "xmp"]);
    assert!(!raw_jpg.photo.as_ref().unwrap().companions_ambiguous);
    for p in &photos { if p.file_name != "DSC00042.JPG" { assert!(p.companions.is_empty(), "{}", p.file_name); } }
    // 照片零视频任务
    let bad: i64 = connection.query_row(
        "SELECT count(*) FROM jobs j JOIN clips c ON c.id = j.clip_id WHERE c.kind='photo' AND j.kind IN ('import_probe','proxy','waveform','strip','analyze_motion','transcribe','metadata_backfill')",
        [], |r| r.get(0)).unwrap();
    assert_eq!(bad, 0);
    // cover 文件真在 cache 里,并且 HEIC 的 cover 是 jpg(不透明)、方向已烘(竖)
    let cache = dir.path().join("cache").join(heic.id.unwrap().to_string());
    assert!(cache.join("cover.jpg").is_file() && cache.join("preview.jpg").is_file(), "{}", cache.display());
    let cover = sips_props(&cache.join("cover.jpg"));
    assert!(cover.contains("pixelWidth: 64") && cover.contains("pixelHeight: 96"), "{cover}");

    // —— 媒体池混排:按 captured_at(10:01Z 视频、10:02Z 照片、…)交错;全部是 UTC `…Z`,同一口径 ——
    let mut by_id: Vec<_> = clips.iter().collect();
    by_id.sort_by_key(|c| (c.captured_at.clone(), c.id));
    for c in &by_id { assert!(c.captured_at.as_deref().is_some_and(|t| t.ends_with('Z')), "{} captured_at 不是 UTC:{:?}", c.file_name, c.captured_at); }
    let names: Vec<&str> = by_id.iter().map(|c| c.file_name.as_str()).collect();
    assert_eq!(names, ["C01.mp4", "C02.HEIC", "C03.mp4", "C04.PNG", "C05.mp4", "C06.jpg", "C07.mp4", "DSC00042.JPG", "C09.mp4", "C10.jpg"], "照片(带 / 不带 offset)与视频按真实时间逐分钟交错");
    // 无 offset 的 C10:本机钟面换成 UTC 正好是 10:10Z,tz_guess 记下用的 offset,检查器原文带 offset。
    let c10 = clips.iter().find(|c| c.file_name == "C10.jpg").unwrap();
    let expected = photo_probe::capture_time(Some(local_1010.clone()), None, None, photo_probe::local_offset_minutes).unwrap();
    assert_eq!(c10.captured_at.as_deref(), Some("2026-09-19T10:10:00Z"));
    assert_eq!(expected.utc, "2026-09-19T10:10:00Z");
    assert_eq!(c10.tz_guess.as_deref(), Some(photo_probe::format_offset(expected.offset_minutes).as_str()));
    let c10_meta = photo_probe::load(&connection, c10.id.unwrap()).unwrap().unwrap();
    assert_eq!((c10_meta.taken_at.as_deref(), c10_meta.taken_at_local.as_deref()), (Some(expected.utc.as_str()), Some(expected.local.as_str())));
    // 视频章节只由视频决定；末尾的 10:10 照片不能把视频章节边界从 10:09 推到 10:10。
    // 时分统一按本机时区，修前 perf_driver 露出的 UTC / 本地混用也不能再出现。
    let titles: Vec<String> = connection.prepare("SELECT title FROM chapters WHERE tombstone=0 ORDER BY start_at, id").unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
    let (local_1001, local_hhmm_1009): (String, String) = connection.query_row(
        "SELECT strftime('%H:%M','2026-09-19T10:01:00Z','localtime'), strftime('%H:%M','2026-09-19T10:09:00Z','localtime')", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(titles, [format!("第 1 章 · {local_1001}-{local_hhmm_1009}")]);

    // —— 选中:全部 10 条整条收藏(binary=1),照片在 W1 没有 select 段,走 whole 路径 ——
    for c in &clips { rate_clip(&mut connection, c.id.unwrap(), "binary", 1).unwrap(); }

    // —— 素材包导出(真 export_package 任务,同一 JobRunner):照片线不套视频那一套,素材包只装 5 条视频 ——
    let destination = dir.path().join("kit");
    std::fs::create_dir(&destination).unwrap();
    let outcome = start_jianying_kit(&mut connection, &destination).unwrap();
    let job_id = outcome.job_id.expect("kit job");
    drain(&dir.db_path(), "export");
    let status = get_export_status(&connection, Some(job_id)).unwrap();
    assert_eq!(status.status, "done", "{:?}", status.error);
    assert_eq!((status.completed_items, status.failed_items, status.selected_photo_count), (5, 0, 0));
    let output = Path::new(status.output_path.as_deref().unwrap());
    assert!(!output.join("视频").exists() && !output.join("照片").exists(), "素材包不再分「视频/ 照片/」");
    let video_order = std::fs::read_to_string(output.join(KIT_ORDER_FILE)).unwrap();
    assert_eq!(video_order.lines().count(), 5, "{video_order}");
    assert!(!video_order.contains("照片"), "{video_order}");
    let expected: Vec<&str> = by_id.iter().filter(|clip| clip.kind == "video").map(|c| c.file_name.as_str()).collect();
    let positions: Vec<usize> = expected.iter().map(|name| {
        let stem = Path::new(name).file_stem().unwrap().to_str().unwrap();
        video_order.lines().position(|l| l.contains(stem)).unwrap_or_else(|| panic!("{name} 不在 顺序.txt:\n{video_order}"))
    }).collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "顺序.txt 行序 {positions:?} 与池序不一致:\n{video_order}");
    // 视频保留章节目录;素材包里一张照片都不能有。
    let video_chapters: Vec<_> = std::fs::read_dir(output).unwrap().map(|e| e.unwrap().path()).filter(|p| p.is_dir()).collect();
    assert_eq!(video_chapters.len(), 1, "{video_chapters:?}");
    let kit_photos: Vec<String> = walkdir::WalkDir::new(output).into_iter().filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|f| f.to_ascii_lowercase().ends_with(".jpg") || f.ends_with(".PNG") || f.ends_with(".HEIC") || f.ends_with(".ARW") || f.ends_with(".xmp"))
        .collect();
    assert!(kit_photos.is_empty(), "素材包里不得出现照片:{kit_photos:?}");

    // —— 导出精选照片(照片线唯一的导出,同一 JobRunner):5 张平铺 + 伴随,HEIC 转 JPG ——
    let destination = dir.path().join("photos");
    std::fs::create_dir(&destination).unwrap();
    let outcome = start_photo_export(&mut connection, &destination).unwrap();
    let job_id = outcome.job_id.expect("photo job");
    drain(&dir.db_path(), "export");
    let status = get_export_status(&connection, Some(job_id)).unwrap();
    assert_eq!(status.status, "done", "{:?}", status.error);
    assert_eq!((status.completed_items, status.failed_items, status.selected_photo_count), (5, 0, 5));
    let output = Path::new(status.output_path.as_deref().unwrap());
    let photo_order = std::fs::read_to_string(output.join(KIT_ORDER_FILE)).unwrap();
    assert_eq!(photo_order.lines().count(), 5, "{photo_order}");
    assert_eq!(photo_order.matches("照片").count(), 5, "{photo_order}");
    assert!(!photo_order.contains(" s"), "照片行不带时长:{photo_order}");
    let expected: Vec<&str> = by_id.iter().filter(|clip| clip.kind == "photo").map(|c| c.file_name.as_str()).collect();
    let positions: Vec<usize> = expected.iter().map(|name| {
        let stem = Path::new(name).file_stem().unwrap().to_str().unwrap();
        photo_order.lines().position(|l| l.contains(stem)).unwrap_or_else(|| panic!("{name} 不在 顺序.txt:\n{photo_order}"))
    }).collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "顺序.txt 行序 {positions:?} 与池序不一致:\n{photo_order}");
    let files: Vec<String> = std::fs::read_dir(output).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|f| f != KIT_ORDER_FILE && !f.starts_with('.')).collect();
    assert_eq!(files.len(), 7, "{files:?}");
    let heic_item = status.items.iter().find(|i| i.file_name == "C02.HEIC").unwrap();
    assert!(heic_item.output_name.ends_with(".jpg"), "{}", heic_item.output_name);
    let heic_out = output.join(&heic_item.output_name);
    let props = sips_props(&heic_out);
    assert!(props.contains("pixelWidth: 64") && props.contains("pixelHeight: 96"), "HEIC→JPG 方向 6 必须烘进像素:{props}");
    assert!(props.contains("sRGB"), "{props}");
    let raw_item = status.items.iter().find(|i| i.file_name == "DSC00042.JPG").unwrap();
    let raw_stem = Path::new(&raw_item.output_name).file_stem().unwrap().to_string_lossy().into_owned();
    assert!(files.iter().any(|f| f == &format!("{raw_stem}.ARW")) && files.iter().any(|f| f == &format!("{raw_stem}.xmp")), "伴随文件要与主文件同目录同 stem:{files:?}");
    assert_eq!(std::fs::read(output.join(format!("{raw_stem}.ARW"))).unwrap(), b"fake raw bytes for companion pairing");
    for item in status.items.iter().filter(|i| i.file_name.ends_with(".jpg") || i.file_name.ends_with(".JPG") || i.file_name.ends_with(".PNG")) {
        let out = output.join(&item.output_name);
        assert_eq!(std::fs::read(&out).unwrap(), std::fs::read(media.join(&item.file_name)).unwrap(), "{} 非 HEIC 照片必须逐字节 copy", item.file_name);
    }
    // 源文件哈希不变
    for (path, hash) in originals.iter().zip(hashes) {
        assert_eq!(blake3::hash(&std::fs::read(path).unwrap()), hash, "{}", path.display());
    }
}
