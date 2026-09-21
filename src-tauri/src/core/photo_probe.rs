//! ImageIO metadata only: no ffprobe or RAW development.
//!
//! 时间口径(R21 W1 验收 P1):`clips.captured_at` 全库是 UTC 瞬时(视频 `creation_time` 本来就是
//! `…Z`),排序 / 日期分组 / 分章都拿它比。EXIF `DateTimeOriginal` 是不带时区的本地钟,
//! 直接存进去会与视频差一个时区(同一分钟拍的被排开几小时、分到不同章)。所以:
//! 有 `OffsetTimeOriginal` / `OffsetTime` 用它;没有就按**导入时本机时区**(按拍摄日期算夏令时)
//! 换成 UTC。`taken_at` 存 UTC RFC3339(`…Z`),`taken_at_local` 存带 offset 的本地原文给检查器看,
//! 用到的 offset 同时写进 `clips.tz_guess`(`UTC-04:00`),章名的时分才按它换回本地。
use std::path::Path;
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL, ConcreteType};
use objc2_image_io::{CGImageSource, CGImageSourceStatus};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use super::error::{CoreError, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PhotoMetaDto {
    pub width: i64,
    pub height: i64,
    pub orientation: i64,
    /// UTC RFC3339(`2026-09-19T14:02:00Z`),与视频 `captured_at` 同一口径。
    pub taken_at: Option<String>,
    /// 本地钟原文 + 实际用的 offset(`2026-09-19T10:02:00-04:00`),只给检查器显示。
    pub taken_at_local: Option<String>,
    /// 换算用的 offset,`UTC±HH:MM`(与视频 `tz_guess` 同格式),写进 `clips.tz_guess`。
    pub tz_guess: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub hold_ms: i64,
    pub color_space: Option<String>,
    pub has_alpha: bool,
    pub companions_ambiguous: bool,
    pub preview_url: Option<String>,
}

pub(crate) fn error(message: &str) -> CoreError { CoreError::Import(format!("照片无法读取：{message}")) }

pub(crate) fn source(path: &Path) -> Result<CFRetained<CGImageSource>> {
    let url=CFURL::from_file_path(path).ok_or_else(||error("路径无效"))?;
    // SAFETY: URL is retained for the call; ImageIO owns its returned source.
    let source=unsafe { CGImageSource::with_url(&url,None) }.ok_or_else(||error("不是有效图片"))?;
    // Reject truncated input even if ImageIO can recover a partial thumbnail.
    if unsafe { source.status() } != CGImageSourceStatus::StatusComplete {
        return Err(error("图片不完整或已损坏"));
    }
    // 实测(2026-09-19,macOS 26):文件 URL 来源的半截 JPEG,`status()` / `status_at_index(0)`
    // 都报 Complete,增量来源也分不出来——ImageIO 会把缺的那半张画成灰。截断只能看
    // 容器结尾:JPEG 的熵编码段里 0xFF 后只能跟 0x00 / RSTn,EOI(FF D9)不可能出现在
    // 被截断的扫描数据里;PNG 以 IEND 收尾。
    let uti = unsafe { source.r#type() }.map(|t| t.to_string()).unwrap_or_default();
    if !trailer_is_complete(path, &uti)? {
        return Err(error("图片不完整或已损坏"));
    }
    Ok(source)
}

/// 只看文件尾 1 MiB:相机在 EOI 之后追加的 trailer(Samsung SEF、MPF 第二张图)
/// 都在这个范围内,而且它们自己也以 EOI 结束;截断文件的尾部是纯扫描数据。
fn trailer_is_complete(path: &Path, uti: &str) -> Result<bool> {
    use std::io::{Read, Seek, SeekFrom};
    let needle: &[u8] = match uti {
        "public.jpeg" => &[0xff, 0xd9],
        "public.png" => b"IEND",
        _ => return Ok(true),
    };
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let window = len.min(1 << 20);
    file.seek(SeekFrom::Start(len - window))?;
    let mut tail = vec![0u8; window as usize];
    file.read_exact(&mut tail)?;
    Ok(tail.windows(needle.len()).any(|w| w == needle))
}

pub(crate) fn property<T: ConcreteType>(dict: &CFDictionary, key: &str) -> Option<CFRetained<T>> {
    let key=CFString::from_str(key);
    // SAFETY: ImageIO property dictionaries use retained CFType keys/values.
    // We type-check each value before interpreting it; no borrowed value escapes.
    let value=unsafe { dict.value((&*key as *const CFString).cast()) };
    let value=unsafe { value.cast::<CFType>().as_ref() }?;
    value.downcast_ref::<T>().map(|v| unsafe { CFRetained::retain(std::ptr::NonNull::from(v)) })
}
fn text(d: &CFDictionary,k: &str)->Option<String> { property::<CFString>(d,k).map(|s|s.to_string()) }
fn number(d: &CFDictionary,k: &str)->Option<f64> { property::<CFNumber>(d,k)?.as_f64() }

pub(crate) fn probe_with_source(path:&Path)->Result<(PhotoMetaDto,CFRetained<CGImageSource>)> {
    let source=source(path)?;
    let metadata=probe_source(&source)?;
    Ok((metadata,source))
}

pub fn probe(path: &Path) -> Result<PhotoMetaDto> {
    probe_with_source(path).map(|(metadata,_)|metadata)
}

fn probe_source(source:&CGImageSource)->Result<PhotoMetaDto> {
    let props=unsafe { source.properties_at_index(0,None) }.ok_or_else(||error("缺少图片元数据"))?;
    let width=number(&props,"PixelWidth").unwrap_or(0.0) as i64;
    let height=number(&props,"PixelHeight").unwrap_or(0.0) as i64;
    if width<=0 || height<=0 { return Err(error("图片尺寸无效")); }
    let exif=property::<CFDictionary>(&props,"{Exif}");
    let tiff=property::<CFDictionary>(&props,"{TIFF}");
    let gps=property::<CFDictionary>(&props,"{GPS}");
    let taken=exif.as_ref().and_then(|d| capture_time(text(d,"DateTimeOriginal"),text(d,"SubsecTimeOriginal"),text(d,"OffsetTimeOriginal").or_else(||text(d,"OffsetTime")),local_offset_minutes));
    let coordinate=|key: &str, reference: &str, negative: &str| gps.as_ref().and_then(|d| {
        let v=number(d,key)?;
        let sign=text(d,reference)?;
        let max=if key=="Latitude" {90.0} else {180.0};
        if !v.is_finite() || v.abs()>max || !matches!(sign.as_str(),"N"|"S"|"E"|"W") { return None; }
        Some(if sign==negative {-v.abs()} else {v.abs()})
    });
    let orientation=number(&props,"Orientation").unwrap_or(1.0) as i64;
    Ok(PhotoMetaDto {
        width,height,orientation: if (1..=8).contains(&orientation) {orientation} else {1},
        taken_at:taken.as_ref().map(|t|t.utc.clone()),taken_at_local:taken.as_ref().map(|t|t.local.clone()),
        tz_guess:taken.as_ref().map(|t|format_offset(t.offset_minutes)),gps_lat:coordinate("Latitude","LatitudeRef","S"),gps_lon:coordinate("Longitude","LongitudeRef","W"),
        camera:tiff.as_ref().and_then(|d|text(d,"Model").or_else(||text(d,"Make"))),
        lens:exif.as_ref().and_then(|d|text(d,"LensModel")),hold_ms:3000,
        color_space:text(&props,"ProfileName").or_else(||text(&props,"ColorModel")),
        has_alpha:property::<CFBoolean>(&props,"HasAlpha").is_some_and(|b|b.as_bool()),
        companions_ambiguous:false,preview_url:None,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureTime { pub utc: String, pub local: String, pub offset_minutes: i64 }

/// `local_offset` 只在 EXIF 没给 offset 时被问一次:本地钟 `[y,mo,d,h,mi,s]` → 本机时区分钟数。
pub fn capture_time(date: Option<String>,subsec: Option<String>,offset: Option<String>,local_offset: impl FnOnce([i64;6])->i64)->Option<CaptureTime> {
    let date=date?;
    if date.len()!=19 || !date.is_ascii() {return None;}
    let bytes=date.as_bytes();
    if bytes[4]!=b':' || bytes[7]!=b':' || bytes[10]!=b' ' || bytes[13]!=b':' || bytes[16]!=b':' {return None;}
    let field=|a:usize,b:usize| date[a..b].parse::<i64>().ok();
    let parts=[field(0,4)?,field(5,7)?,field(8,10)?,field(11,13)?,field(14,16)?,field(17,19)?];
    if !(1..=12).contains(&parts[1]) || !(1..=31).contains(&parts[2]) || parts[3]>23 || parts[4]>59 || parts[5]>60 {return None;}
    let frac=subsec.filter(|s|!s.is_empty() && s.bytes().all(|b|b.is_ascii_digit())).map(|s|format!(".{s}")).unwrap_or_default();
    let offset_minutes=offset.as_deref().and_then(parse_offset).unwrap_or_else(||local_offset(parts));
    let local=format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{}",parts[0],parts[1],parts[2],parts[3],parts[4],parts[5],frac,&format_offset(offset_minutes)[3..]);
    let epoch=days_from_civil(parts[0],parts[1],parts[2])*86_400+parts[3]*3600+parts[4]*60+parts[5]-offset_minutes*60;
    let (y,mo,d)=civil_from_days(epoch.div_euclid(86_400));
    let rem=epoch.rem_euclid(86_400);
    let utc=format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}{frac}Z",rem/3600,rem%3600/60,rem%60);
    Some(CaptureTime{utc,local,offset_minutes})
}

/// EXIF `OffsetTime*` 形如 `+08:00` / `-04:00`;别的一律当没有。
fn parse_offset(o: &str)->Option<i64> {
    let b=o.as_bytes();
    if b.len()!=6 || !matches!(b[0],b'+'|b'-') || b[3]!=b':' || !b[1..3].iter().chain(&b[4..]).all(|c|c.is_ascii_digit()) {return None;}
    let minutes=o[1..3].parse::<i64>().ok()?*60+o[4..6].parse::<i64>().ok()?;
    if minutes>14*60 {return None;}
    Some(if b[0]==b'-' {-minutes} else {minutes})
}

/// 与 `import.rs::format_timezone_offset` 同格式(`UTC-04:00`),章名时分换算只认这个形状。
pub fn format_offset(minutes: i64)->String {
    let sign=if minutes<0 {'-'} else {'+'};
    format!("UTC{sign}{:02}:{:02}",minutes.abs()/60,minutes.abs()%60)
}

/// 导入机在这个本地钟时刻的 UTC 偏移(分钟),夏令时按那一天算(`mktime` + `tm_isdst=-1`)。
pub fn local_offset_minutes(parts: [i64;6])->i64 {
    // SAFETY: `tm` 全零初始化后逐字段填,`mktime` 只读写这一个栈上结构(它自己会 tzset)。
    unsafe {
        let mut tm: libc::tm=std::mem::zeroed();
        tm.tm_year=(parts[0]-1900) as _; tm.tm_mon=(parts[1]-1) as _; tm.tm_mday=parts[2] as _;
        tm.tm_hour=parts[3] as _; tm.tm_min=parts[4] as _; tm.tm_sec=parts[5] as _; tm.tm_isdst= -1;
        if libc::mktime(&mut tm)==-1 {return 0;}
        tm.tm_gmtoff/60
    }
}

fn days_from_civil(y: i64,m: i64,d: i64)->i64 {
    let y=if m<=2 {y-1} else {y};
    let era=y.div_euclid(400);
    let yoe=y-era*400;
    let doy=(153*(if m>2 {m-3} else {m+9})+2)/5+d-1;
    let doe=yoe*365+yoe/4-yoe/100+doy;
    era*146_097+doe-719_468
}

fn civil_from_days(z: i64)->(i64,i64,i64) {
    let z=z+719_468;
    let era=z.div_euclid(146_097);
    let doe=z-era*146_097;
    let yoe=(doe-doe/1460+doe/36_524-doe/146_096)/365;
    let doy=doe-(365*yoe+yoe/4-yoe/100);
    let mp=(5*doy+2)/153;
    let d=doy-(153*mp+2)/5+1;
    let m=if mp<10 {mp+3} else {mp-9};
    (yoe+era*400+i64::from(m<=2),m,d)
}

pub fn is_photo(connection: &Connection,clip_id: i64)->Result<bool> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM clips WHERE id=?1 AND kind='photo')",[clip_id],|r|r.get(0))?)
}

/// Worker dispatch and direct retry entry points share this terminal skip guard.
pub fn job_is_photo(connection: &Connection,job: &super::jobs::Job)->Result<bool> {
    let payload: serde_json::Value=serde_json::from_str(&job.payload).unwrap_or_default();
    let Some(id)=payload.get("clip_id").and_then(|v|v.as_i64()) else {return Ok(false);};
    is_photo(connection,id)
}

pub fn skip_video_job(connection: &mut Connection,job: &super::jobs::Job)->Result<bool> {
    if !job_is_photo(connection,job)? { return Ok(false); }
    super::jobs::mark_done(connection,job.id,job.attempt)?;
    Ok(true)
}

pub fn store(connection: &Connection,clip_id: i64,m: &PhotoMetaDto)->Result<()> {
    connection.execute("INSERT INTO photo_meta(clip_id,width,height,orientation,taken_at,gps_lat,gps_lon,camera,lens,color_space,has_alpha,taken_at_local)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
        ON CONFLICT(clip_id) DO UPDATE SET width=excluded.width,height=excluded.height,orientation=excluded.orientation,taken_at=excluded.taken_at,
        gps_lat=excluded.gps_lat,gps_lon=excluded.gps_lon,camera=excluded.camera,lens=excluded.lens,color_space=excluded.color_space,has_alpha=excluded.has_alpha,
        taken_at_local=excluded.taken_at_local,error=NULL",
        params![clip_id,m.width,m.height,m.orientation,m.taken_at,m.gps_lat,m.gps_lon,m.camera,m.lens,m.color_space,m.has_alpha,m.taken_at_local])?;
    Ok(())
}

pub fn load(connection: &Connection,clip_id: i64)->Result<Option<PhotoMetaDto>> {
    Ok(connection.query_row("SELECT p.width,p.height,p.orientation,p.taken_at,p.gps_lat,p.gps_lon,p.camera,p.lens,p.hold_ms,p.color_space,p.has_alpha,p.companions_ambiguous,p.taken_at_local,c.tz_guess
        FROM photo_meta p JOIN clips c ON c.id=p.clip_id WHERE p.clip_id=?1 AND p.error IS NULL",[clip_id],|r|Ok(PhotoMetaDto {
        width:r.get(0)?,height:r.get(1)?,orientation:r.get(2)?,taken_at:r.get(3)?,gps_lat:r.get(4)?,gps_lon:r.get(5)?,camera:r.get(6)?,lens:r.get(7)?,hold_ms:r.get(8)?,color_space:r.get(9)?,has_alpha:r.get(10)?,companions_ambiguous:r.get(11)?,
        taken_at_local:r.get(12)?,tz_guess:r.get(13)?,preview_url:None,
    })).optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn r21_capture_time_converts_exif_local_clock_to_utc() {
        let never=|_: [i64;6]| panic!("EXIF 自带 offset 时不许问本机时区");
        let t=capture_time(Some("2026:09:19 12:34:56".into()),Some("0123".into()),Some("-04:00".into()),never).unwrap();
        assert_eq!((t.utc.as_str(),t.local.as_str(),t.offset_minutes),("2026-09-19T16:34:56.0123Z","2026-09-19T12:34:56.0123-04:00",-240));
        // 没 offset:按导入机时区(这里假装东八区)换算,本地原文带上实际用的 offset;跨日进位。
        let t=capture_time(Some("2026:09:19 02:10:00".into()),None,None,|parts|{assert_eq!(parts,[2026,9,19,2,10,0]);480}).unwrap();
        assert_eq!((t.utc.as_str(),t.local.as_str(),t.offset_minutes),("2026-09-18T18:10:00Z","2026-09-19T02:10:00+08:00",480));
        // 坏 offset 当没有;非法日期整个丢弃。
        assert_eq!(capture_time(Some("2026:12:31 23:59:59".into()),None,Some("+0800".into()),|_|-300).unwrap().utc,"2027-01-01T04:59:59Z");
        assert!(capture_time(Some("2026:13:01 00:00:00".into()),None,None,|_|0).is_none());
        assert_eq!(format_offset(-240),"UTC-04:00");assert_eq!(format_offset(345),"UTC+05:45");
    }
    /// 本机 offset 与 SQLite 的 `localtime`/`utc` 修饰符同源(章名 Z-15 那条退路用的就是它),两边必须一致,含夏令时日期。
    #[test]
    fn r21_local_offset_matches_sqlite_localtime() {
        let c=Connection::open_in_memory().unwrap();
        for (parts,text) in [([2026,7,1,12,0,0],"2026-07-01T12:00:00"),([2026,1,15,3,30,0],"2026-01-15T03:30:00")] {
            let expected:i64=c.query_row("SELECT (strftime('%s',?1)-strftime('%s',?1,'utc'))/60",[text],|r|r.get(0)).unwrap();
            assert_eq!(local_offset_minutes(parts),expected,"{text}");
        }
    }
    /// 三件素材按真实时间排:带 offset 的照片(+08:00 的 10:00 = 02:00Z)、不带 offset 的照片
    /// (本机 -04:00 的 01:00 = 05:00Z)、视频(03:00Z)。按字符串或混合时区排会把它们排成 01:00 < 03:00 < 10:00。
    #[test]
    fn r21_mixed_offset_photos_and_video_sort_by_true_instant() {
        let with_offset=capture_time(Some("2026:09:19 10:00:00".into()),None,Some("+08:00".into()),|_|0).unwrap();
        let without=capture_time(Some("2026:09:19 01:00:00".into()),None,None,|_|-240).unwrap();
        let video="2026-09-19T03:00:00Z";
        let mut order=[(without.utc.as_str(),"无offset照片"),(video,"视频"),(with_offset.utc.as_str(),"带offset照片")];
        order.sort();
        assert_eq!(order.iter().map(|o|o.1).collect::<Vec<_>>(),["带offset照片","视频","无offset照片"]);
        // 章名换算靠 tz_guess:UTC 05:00 按 -04:00 回到 01:00。
        let c=Connection::open_in_memory().unwrap();
        let hhmm:String=c.query_row("SELECT strftime('%H:%M',?1,'-14400 seconds')",[without.utc.as_str()],|r|r.get(0)).unwrap();
        assert_eq!((hhmm.as_str(),format_offset(without.offset_minutes).as_str()),("01:00","UTC-04:00"));
    }
    #[test]
    fn r21_imageio_reads_camera_lens_gps_and_capture_time() {
        use objc2_image_io::{CGImageDestination,kCGImagePropertyExifDictionary,kCGImagePropertyTIFFDictionary,kCGImagePropertyGPSDictionary};
        let d=crate::core::test_support::TestDirectory::new();let input=d.path().join("input.jpg");
        image::RgbImage::from_pixel(32,24,image::Rgb([200,120,60])).save(&input).unwrap();
        let output=d.path().join("metadata.jpg");
        let exif_keys:Vec<_>=["DateTimeOriginal","SubsecTimeOriginal","OffsetTimeOriginal","LensModel"].into_iter().map(CFString::from_str).collect();
        let exif_values:Vec<_>=["2026:09:19 12:34:56","0123","-04:00","Test 35mm"].into_iter().map(CFString::from_str).collect();
        let exif=CFDictionary::from_slices(&exif_keys.iter().map(|v|&**v).collect::<Vec<_>>(),&exif_values.iter().map(|v|&**v).collect::<Vec<_>>());
        let tiff=CFDictionary::from_slices(&[&*CFString::from_str("Model")],&[&*CFString::from_str("Test Camera")]);
        let gps_keys:Vec<_>=["Latitude","LatitudeRef","Longitude","LongitudeRef"].into_iter().map(CFString::from_str).collect();
        let lat=CFNumber::new_f64(43.25);let lon=CFNumber::new_f64(79.5);let n=CFString::from_str("N");let w=CFString::from_str("W");
        let gps=CFDictionary::<CFString,CFType>::from_slices(&gps_keys.iter().map(|v|&**v).collect::<Vec<_>>(),&[&lat,&n,&lon,&w]);
        let props=unsafe {CFDictionary::<CFString,CFType>::from_slices(&[kCGImagePropertyExifDictionary,kCGImagePropertyTIFFDictionary,kCGImagePropertyGPSDictionary],&[exif.as_opaque(),tiff.as_opaque(),gps.as_opaque()])};
        let source=source(&input).unwrap();let url=CFURL::from_file_path(&output).unwrap();
        let dest=unsafe {CGImageDestination::with_url(&url,&CFString::from_str("public.jpeg"),1,None)}.unwrap();
        unsafe {dest.add_image_from_source(&source,0,Some(props.as_opaque()));assert!(dest.finalize());}
        let meta=probe(&output).unwrap();
        assert_eq!((meta.width,meta.height),(32,24));
        assert_eq!(meta.camera.as_deref(),Some("Test Camera"));assert_eq!(meta.lens.as_deref(),Some("Test 35mm"));
        assert_eq!(meta.taken_at.as_deref(),Some("2026-09-19T16:34:56.0123Z"));
        assert_eq!(meta.taken_at_local.as_deref(),Some("2026-09-19T12:34:56.0123-04:00"));
        assert_eq!(meta.tz_guess.as_deref(),Some("UTC-04:00"));
        assert_eq!(meta.gps_lat,Some(43.25));assert_eq!(meta.gps_lon,Some(-79.5));
    }

    /// 任务书原话是「坏图(截断 JPG)」:头部完整、扫描数据被截断的 JPEG,ImageIO
    /// 仍能读出尺寸甚至给出半张缩略图,只有 `status()` 能识别;这条测试就是为了
    /// 那道守卫——去掉 `StatusComplete` 检查它必须红。
    #[test]
    fn r21_truncated_jpeg_is_rejected_by_probe_and_decode() {
        let d=crate::core::test_support::TestDirectory::new();let full=d.path().join("full.jpg");
        image::RgbImage::from_fn(640,480,|x,y|image::Rgb([(x%256) as u8,(y%256) as u8,((x*y)%256) as u8])).save(&full).unwrap();
        let bytes=std::fs::read(&full).unwrap();
        let cut=d.path().join("cut.jpg");
        std::fs::write(&cut,&bytes[..bytes.len()/2]).unwrap();
        assert!(probe(&full).is_ok());
        assert!(probe(&cut).is_err(),"截断 JPEG 必须被 probe 拒绝");
        assert!(super::super::photo_decode::decode_cover(&cut,512).is_err(),"截断 JPEG 不得产出封面");
        let png=d.path().join("full.png");
        image::RgbImage::from_fn(300,200,|x,y|image::Rgb([(x%256) as u8,(y%256) as u8,7])).save(&png).unwrap();
        let bytes=std::fs::read(&png).unwrap();let cut_png=d.path().join("cut.png");
        std::fs::write(&cut_png,&bytes[..bytes.len()/2]).unwrap();
        assert!(probe(&png).is_ok());
        assert!(probe(&cut_png).is_err(),"截断 PNG 必须被 probe 拒绝");
    }

    #[test]
    fn r21_broken_image_probe_returns_error() {
        let d=crate::core::test_support::TestDirectory::new();let p=d.path().join("bad.jpg");
        std::fs::write(&p,[0xff,0xd8,0xff,0xe1,0,120]).unwrap();
        assert!(probe(&p).is_err());
    }
}
