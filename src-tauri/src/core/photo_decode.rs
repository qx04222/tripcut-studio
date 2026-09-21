//! Bounded ImageIO thumbnails. Only small SDR sRGB rasters leave the decoder.
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFMutableData, CFNumber, CFString, CFType, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, kCGColorSpaceSRGB};
use objc2_image_io::*;
use rusqlite::{params, Connection, OptionalExtension};
use super::error::Result;
use super::photo_probe::error;

pub const PHOTO_DECODE_THREADS: usize = 4;
static ACTIVE: Mutex<usize> = Mutex::new(0);
static AVAILABLE: Condvar = Condvar::new();
struct Permit;
impl Permit {
    fn acquire()->Self {
        let mut active=ACTIVE.lock().unwrap_or_else(|e|e.into_inner());
        while *active>=PHOTO_DECODE_THREADS {active=AVAILABLE.wait(active).unwrap_or_else(|e|e.into_inner());}
        *active+=1;Self
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        *ACTIVE.lock().unwrap_or_else(|e|e.into_inner())-=1;
        AVAILABLE.notify_one();
    }
}

#[derive(Debug)]
pub struct DecodedPhoto {
    pub bytes: Vec<u8>,
    pub extension: &'static str,
    pub width: u32,
    pub height: u32,
}

pub fn decode_cover(path: &Path,max_size: u32)->Result<DecodedPhoto> { decode(path,max_size.min(512),0.9,None) }
pub fn decode_preview(path: &Path,max_size: u32)->Result<DecodedPhoto> { decode(path,max_size.min(2048),0.9,None) }

pub(crate) fn decode_cover_with_source(source:&CGImageSource,has_alpha:bool)->Result<DecodedPhoto> {
    let _permit=Permit::acquire();
    image_io_with_source(source,512,0.9,Some(has_alpha))
}

fn decode(path: &Path,max_size: u32,quality:f64,known_alpha:Option<bool>)->Result<DecodedPhoto> {
    if max_size==0 {return Err(error("缩略图尺寸必须大于 0"));}
    let _permit=Permit::acquire();
    // 完整性门在前:半截 JPEG/PNG 在这里就被拒,不许 `image` 后备把灰掉的半张当封面。
    let source=super::photo_probe::source(path)?;
    match image_io_with_source(&source,max_size,quality,known_alpha) {
        Ok(image)=>Ok(image),
        Err(original)=>{
            let ext=path.extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();
            if !matches!(ext.as_str(),"jpg"|"jpeg"|"png") {return Err(original);}
            fallback(path,max_size).map_err(|_|original)
        }
    }
}

/// ImageIO 渲染参数。缩略/预览与素材包导出(photo_export)共用同一条解码路径:
/// 方向烘进像素、DecodeToSDR、8-bit sRGB 画布真转换(不是改标签)。
#[derive(Clone, Copy, Debug)]
pub(crate) struct RenderOptions {
    /// `Some(n)`:长边 ≤ n 的缩略图;`None`:全分辨率(导出用,绝不能拿缩略尺寸交付)。
    pub max_size: Option<u32>,
    /// JPEG 质量(0.9 缩略 / 0.92 导出)。
    pub quality: f64,
    /// true:源标 HasAlpha 就写 PNG(透明 PNG 保留);false:一律不透明 JPEG。
    pub keep_alpha: bool,
}

#[cfg(test)]
fn image_io(path: &Path,max_size: u32)->Result<DecodedPhoto> {
    let source=super::photo_probe::source(path)?;
    image_io_with_source(&source,max_size,0.9,None)
}

fn image_io_with_source(source:&CGImageSource,max_size:u32,quality:f64,known_alpha:Option<bool>)->Result<DecodedPhoto> {
    render_sdr_srgb_with_source(source,RenderOptions{max_size:Some(max_size),quality,keep_alpha:true},known_alpha)
}

/// 共用渲染器(`image_io` 与 `photo_export::encode_jpeg` 都走这里)。完整性门(截断 JPEG/PNG)在 `photo_probe::source` 里。
pub(crate) fn render_sdr_srgb(path: &Path,opts: RenderOptions)->Result<DecodedPhoto> {
    let source=super::photo_probe::source(path)?;
    render_sdr_srgb_with_source(&source,opts,None)
}

fn render_sdr_srgb_with_source(source:&CGImageSource,opts:RenderOptions,known_alpha:Option<bool>)->Result<DecodedPhoto> {
    let size=opts.max_size.map(|m|CFNumber::new_i32(m as i32));
    // SAFETY: all option keys are ImageIO constants and all values have the
    // documented CF types. Each source/context is confined to this worker.
    let options=unsafe {
        let mut keys=vec![kCGImageSourceCreateThumbnailFromImageAlways,
          kCGImageSourceCreateThumbnailWithTransform,kCGImageSourceShouldCache,
          kCGImageSourceShouldAllowFloat,kCGImageSourceDecodeRequest];
        let t=CFBoolean::new(true);let f=CFBoolean::new(false);
        let mut values:Vec<&CFType>=vec![&t,&t,&f,&f,kCGImageSourceDecodeToSDR];
        // 不给 MaxPixelSize 就是全分辨率 + 方向变换(导出路径)。
        if let Some(size)=size.as_ref() {keys.push(kCGImageSourceThumbnailMaxPixelSize);values.push(size);}
        CFDictionary::<CFString,CFType>::from_slices(&keys,&values)
    };
    let thumb=unsafe { source.thumbnail_at_index(0,Some(options.as_opaque())) }.ok_or_else(||error("ImageIO 缩略解码失败"))?;
    let width=CGImage::width(Some(&thumb));let height=CGImage::height(Some(&thumb));
    if width==0 || height==0 {return Err(error("缩略图尺寸越界"));}
    if let Some(max)=opts.max_size { if width>max as usize || height>max as usize {return Err(error("缩略图尺寸越界"));} }
    // 透明与否看源文件属性(与 photo_meta.has_alpha 同一来源):HEVC 解码出的缩略图
    // 一律带 alpha 通道,按 `CGImage::alpha_info` 判会把不透明 HEIC 全写成 PNG。
    let alpha=opts.keep_alpha && known_alpha.unwrap_or_else(||unsafe { source.properties_at_index(0,None) }
        .and_then(|props| super::photo_probe::property::<CFBoolean>(&props,"HasAlpha"))
        .is_some_and(|b| b.as_bool()));
    let space=CGColorSpace::with_name(Some(unsafe {kCGColorSpaceSRGB})).ok_or_else(||error("无法创建 sRGB 色彩空间"))?;
    // A bounded 8-bit sRGB context performs actual color conversion, rather than
    // relabelling the input ICC profile. ImageIO has already requested SDR.
    let alpha_info=if alpha {CGImageAlphaInfo::PremultipliedLast} else {CGImageAlphaInfo::NoneSkipLast};
    let context=unsafe { CGBitmapContextCreate(std::ptr::null_mut(),width,height,8,width*4,Some(&space),alpha_info.0) }.ok_or_else(||error("无法创建缩略图画布"))?;
    CGContext::draw_image(Some(&context),CGRect{origin:CGPoint{x:0.0,y:0.0},size:CGSize{width:width as f64,height:height as f64}},Some(&thumb));
    let image=CGBitmapContextCreateImage(Some(&context)).ok_or_else(||error("sRGB 转换失败"))?;
    let data=CFMutableData::new(None,0).ok_or_else(||error("无法创建输出缓冲"))?;
    let extension=if alpha {"png"} else {"jpg"};
    let uti=CFString::from_str(if alpha {"public.png"} else {"public.jpeg"});
    let destination=unsafe { CGImageDestination::with_data(&data,&uti,1,None) }.ok_or_else(||error("无法创建图片编码器"))?;
    let quality=CFNumber::new_f64(opts.quality);
    let properties=unsafe { CFDictionary::<CFString,CFType>::from_slices(&[kCGImageDestinationLossyCompressionQuality],&[&quality]) };
    unsafe {destination.add_image(&image,Some(properties.as_opaque()));}
    if !unsafe {destination.finalize()} {return Err(error("图片编码失败"));}
    Ok(DecodedPhoto{bytes:data.to_vec(),extension,width:width as u32,height:height as u32})
}

fn fallback(path: &Path,max_size: u32)->Result<DecodedPhoto> {
    use image::ImageDecoder;
    let reader=image::ImageReader::open(path).map_err(|e|error(&e.to_string()))?;
    let mut decoder=reader.into_decoder().map_err(|e|error(&e.to_string()))?;
    // The fallback is deliberately bounded too: ImageIO must handle large
    // images using its thumbnail API; never full-decode a 48 MP fallback.
    let (w,h)=decoder.dimensions();
    if u64::from(w)*u64::from(h)>16_000_000 {return Err(error("大图需使用 ImageIO 缩略解码"));}
    let orientation=decoder.orientation().map_err(|e|error(&e.to_string()))?;
    // Avoid silently labelling wide-gamut fallback pixels sRGB.
    if decoder.icc_profile().map_err(|e|error(&e.to_string()))?.is_some() {return Err(error("带 ICC 的图片需使用 ImageIO 色彩转换"));}
    let mut image=image::DynamicImage::from_decoder(decoder).map_err(|e|error(&e.to_string()))?;
    image.apply_orientation(orientation);
    let image=if image.width()>max_size || image.height()>max_size { image.thumbnail(max_size,max_size) } else { image };
    let alpha=image.color().has_alpha();
    let mut bytes=std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes,if alpha {image::ImageFormat::Png} else {image::ImageFormat::Jpeg}).map_err(|e|error(&e.to_string()))?;
    Ok(DecodedPhoto{bytes:bytes.into_inner(),extension:if alpha {"png"} else {"jpg"},width:image.width(),height:image.height()})
}

pub fn enqueue(connection: &mut Connection,clip_id: i64,path: &Path,source_hash: &str)->Result<()> {
    let payload=serde_json::to_string(&super::artifacts::ArtifactJobPayload{clip_id,path:path.to_string_lossy().into_owned(),source_hash:source_hash.into()}).map_err(|e|error(&e.to_string()))?;
    let hash=blake3::hash(format!("thumbnail\0{clip_id}\0{source_hash}").as_bytes()).to_hex().to_string();
    let exists:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='thumbnail' AND payload_hash=?1)",[&hash],|r|r.get(0))?;
    if !exists { super::jobs::enqueue(connection,"thumbnail",&payload,&hash)?; }
    Ok(())
}

fn thumbnail_payload_hash(clip_id:i64,source_hash:&str)->String {
    blake3::hash(format!("thumbnail\0{clip_id}\0{source_hash}").as_bytes()).to_hex().to_string()
}

fn valid_cover(cache_root:&Path,clip_id:i64,source_hash:&str,artifact:Option<(String,String)>)->bool {
    let Some((rel_path,artifact_hash))=artifact else {return false;};
    if artifact_hash!=source_hash {return false;}
    let Some(name)=Path::new(&rel_path).file_name().and_then(|value|value.to_str()) else {return false;};
    matches!(name,"cover.jpg"|"cover.png")
        && rel_path==format!("{clip_id}/{name}")
        && cache_root.join(rel_path).is_file()
}

pub(crate) fn enqueue_missing_covers_within(connection:&Connection,cache_root:&Path)->Result<usize> {
    let candidates={
        let mut statement=connection.prepare(
            "SELECT c.id,c.rel_path,c.quick_hash,a.rel_path,a.source_hash
             FROM clips c
             LEFT JOIN cache_artifacts a ON a.clip_id=c.id AND a.kind='cover'
             LEFT JOIN photo_meta pm ON pm.clip_id=c.id
             WHERE c.kind='photo' AND c.quick_hash IS NOT NULL AND c.missing_since IS NULL
               AND NULLIF(TRIM(pm.error),'') IS NULL",
        )?;
        let rows=statement.query_map([],|row|Ok((
            row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,
            row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?,
        )))?;
        rows.collect::<std::result::Result<Vec<_>,_>>()?
    };
    let mut enqueued=0;
    for (clip_id,path,source_hash,cover_rel,cover_hash) in candidates {
        let artifact=cover_rel.zip(cover_hash);
        if valid_cover(cache_root,clip_id,&source_hash,artifact) {continue;}
        connection.execute("DELETE FROM cache_artifacts WHERE clip_id=?1 AND kind='cover'",[clip_id])?;
        let hash=thumbnail_payload_hash(clip_id,&source_hash);
        let latest:Option<(i64,String)>=connection.query_row(
            "SELECT id,status FROM jobs WHERE kind='thumbnail' AND payload_hash=?1 ORDER BY id DESC LIMIT 1",
            [&hash],|row|Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        match latest {
            Some((_id,status)) if matches!(status.as_str(),"pending"|"running")=>{}
            Some((id,_))=>{
                connection.execute(
                    "UPDATE jobs SET status='pending',attempt=0,blocked_summary=NULL,result_path=NULL,
                     finished_at=NULL,owner_id=NULL,lease_expires_at=NULL,cancel_requested=0,
                     next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                     updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                    [id],
                )?;
                enqueued+=1;
            }
            None=>{
                let payload=serde_json::to_string(&super::artifacts::ArtifactJobPayload{clip_id,path,source_hash}).map_err(|e|error(&e.to_string()))?;
                super::jobs::enqueue_within(connection,"thumbnail",&payload,&hash)?;
                enqueued+=1;
            }
        }
    }
    Ok(enqueued)
}

/// 启动/缓存重建补扫：照片记录存在、源哈希仍当前，但没有真实可读 cover 时，
/// 即使历史上从未有过 thumbnail job，也补排一条可恢复的封面任务。
pub fn enqueue_missing_covers(connection:&mut Connection,cache_root:&Path)->Result<usize> {
    let tx=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let enqueued=enqueue_missing_covers_within(&tx,cache_root)?;
    tx.commit()?;
    Ok(enqueued)
}

fn preview_payload_hash(clip_id:i64,source_hash:&str)->String {
    blake3::hash(format!("photo_preview\0{clip_id}\0{source_hash}").as_bytes()).to_hex().to_string()
}

/// 在现有事务中排 2048 预览。封面与任务同一次提交，崩溃时不会留下“有 cover、无任务”的常态；
/// 启动补扫仍覆盖文件系统发布与事务之间的极窄异常窗口。
fn enqueue_preview_within(connection:&Connection,payload:&super::artifacts::ArtifactJobPayload)->Result<bool> {
    let hash=preview_payload_hash(payload.clip_id,&payload.source_hash);
    let exists:bool=connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='photo_preview' AND payload_hash=?1)",
        [&hash],|row|row.get(0),
    )?;
    if exists {return Ok(false);}
    let payload=serde_json::to_string(payload).map_err(|e|error(&e.to_string()))?;
    super::jobs::enqueue_within(connection,"photo_preview",&payload,&hash)?;
    Ok(true)
}

pub fn run_thumbnail(connection: &mut Connection,job: &super::jobs::Job,cache_root: &Path)->Result<()> {
    let payload:super::artifacts::ArtifactJobPayload=serde_json::from_str(&job.payload).map_err(|e|error(&e.to_string()))?;
    let path=super::media_source::verified_clip_path(connection,payload.clip_id)?;
    let has_alpha:Option<bool>=connection.query_row("SELECT has_alpha FROM photo_meta WHERE clip_id=?1",[payload.clip_id],|row|row.get(0)).optional()?;
    let cover=decode(&path,512,0.9,has_alpha)?;
    publish_cover(connection,job,cache_root,&payload,cover,true)
}

pub(crate) fn publish_import_cover(connection:&mut Connection,job:&super::jobs::Job,cache_root:&Path,clip_id:i64,path:&Path,source_hash:&str,cover:DecodedPhoto)->Result<()> {
    let payload=super::artifacts::ArtifactJobPayload {clip_id,path:path.to_string_lossy().into_owned(),source_hash:source_hash.into()};
    publish_cover(connection,job,cache_root,&payload,cover,false)
}

fn publish_cover(connection:&mut Connection,job:&super::jobs::Job,cache_root:&Path,payload:&super::artifacts::ArtifactJobPayload,cover:DecodedPhoto,complete_job:bool)->Result<()> {
    let dir=cache_root.join(payload.clip_id.to_string());std::fs::create_dir_all(&dir)?;
    let cover_name=format!("cover.{}",cover.extension);
    let temp_cover=dir.join(format!("{cover_name}.tmp-{}-{}",job.id,job.attempt));
    struct Cleanup(Vec<PathBuf>);
    impl Drop for Cleanup {fn drop(&mut self){for p in &self.0 {let _=std::fs::remove_file(p);}}}
    let _cleanup=Cleanup(vec![temp_cover.clone()]);
    std::fs::write(&temp_cover,&cover.bytes)?;
    let tx=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    super::import_control::ensure_job_current(&tx,job)?;
    let current:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM clips WHERE id=?1 AND kind='photo' AND quick_hash=?2)",params![payload.clip_id,payload.source_hash],|r|r.get(0))?;
    if !current {return Err(error("生成缩略图期间源文件已变化"));}
    // 只有同一 source_hash 的 preview 已完成时才保留；源文件变化后绝不短暂展示旧预览。
    let preview_ready:bool=tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='photo_preview' AND payload_hash=?1 AND status='done')",
        [preview_payload_hash(payload.clip_id,&payload.source_hash)],|row|row.get(0),
    )?;
    if !preview_ready {for name in ["preview.jpg","preview.png"] {let _=std::fs::remove_file(dir.join(name));}}
    std::fs::rename(&temp_cover,dir.join(&cover_name))?;
    tx.execute("INSERT INTO cache_artifacts(clip_id,kind,rel_path,source_hash,bytes,created_at) VALUES(?1,'cover',?2,?3,?4,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(clip_id,kind) DO UPDATE SET rel_path=excluded.rel_path,source_hash=excluded.source_hash,bytes=excluded.bytes,created_at=excluded.created_at",params![payload.clip_id,format!("{}/{cover_name}",payload.clip_id),payload.source_hash,cover.bytes.len() as i64])?;
    enqueue_preview_within(&tx,payload)?;
    if !complete_job {
        // 启动补扫可能在 photo_probe 已建 clip、尚未发布 cover 的窄窗口补出 thumbnail。
        // 两者同 clip 受 decode 互斥；photo_probe 先发布成功时把尚未认领的重复任务收敛掉。
        tx.execute(
            "UPDATE jobs SET status='done',result_path=?2,owner_id=NULL,lease_expires_at=NULL,
             blocked_summary=NULL,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE kind='thumbnail' AND payload_hash=?1 AND status='pending'",
            params![thumbnail_payload_hash(payload.clip_id,&payload.source_hash),dir.join(&cover_name).to_string_lossy()],
        )?;
    }
    if complete_job {
        let changed=tx.execute("UPDATE jobs SET status='done',result_path=?3,owner_id=NULL,lease_expires_at=NULL,blocked_summary=NULL,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND attempt=?2 AND status='running' AND cancel_requested=0",params![job.id,job.attempt,dir.join(&cover_name).to_string_lossy()])?;
        if changed!=1 {return Err(error("缩略图任务已过期"));}
    }
    tx.commit()?;
    Ok(())
}

pub fn run_preview(connection:&mut Connection,job:&super::jobs::Job,cache_root:&Path)->Result<()> {
    let payload:super::artifacts::ArtifactJobPayload=serde_json::from_str(&job.payload).map_err(|e|error(&e.to_string()))?;
    let path=super::media_source::verified_clip_path(connection,payload.clip_id)?;
    let preview=decode_preview(&path,2048)?;
    let dir=cache_root.join(payload.clip_id.to_string());std::fs::create_dir_all(&dir)?;
    let preview_name=format!("preview.{}",preview.extension);
    let temp=dir.join(format!("{preview_name}.tmp-{}-{}",job.id,job.attempt));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {fn drop(&mut self){let _=std::fs::remove_file(&self.0);}}
    let _cleanup=Cleanup(temp.clone());
    std::fs::write(&temp,&preview.bytes)?;
    let tx=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    super::import_control::ensure_job_current(&tx,job)?;
    let current:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM clips WHERE id=?1 AND kind='photo' AND quick_hash=?2)",params![payload.clip_id,payload.source_hash],|row|row.get(0))?;
    if !current {return Err(error("生成照片预览期间源文件已变化"));}
    for other in ["preview.jpg","preview.png"] {if other!=preview_name {let _=std::fs::remove_file(dir.join(other));}}
    std::fs::rename(&temp,dir.join(&preview_name))?;
    let changed=tx.execute("UPDATE jobs SET status='done',result_path=?3,owner_id=NULL,lease_expires_at=NULL,blocked_summary=NULL,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND attempt=?2 AND status='running' AND cancel_requested=0",params![job.id,job.attempt,dir.join(&preview_name).to_string_lossy()])?;
    if changed!=1 {return Err(error("照片预览任务已过期"));}
    tx.commit()?;
    Ok(())
}

/// 启动补扫：当前照片已有 cover 但缺 preview，且没有在途任务时补回一条。
pub fn enqueue_missing_previews(connection:&mut Connection,cache_root:&Path)->Result<usize> {
    let tx=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let candidates={
        let mut statement=tx.prepare("SELECT c.id,c.rel_path,c.quick_hash,a.rel_path FROM clips c JOIN cache_artifacts a ON a.clip_id=c.id AND a.kind='cover' AND a.source_hash=c.quick_hash WHERE c.kind='photo' AND c.quick_hash IS NOT NULL")?;
        let rows=statement.query_map([],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?)))?;
        rows.collect::<std::result::Result<Vec<_>,_>>()?
    };
    let mut enqueued=0;
    for (clip_id,path,source_hash,cover_rel) in candidates {
        let extension=Path::new(&cover_rel).extension().and_then(|value|value.to_str()).unwrap_or("jpg");
        let preview_exists=cache_root.join(clip_id.to_string()).join(format!("preview.{extension}")).is_file();
        let hash=preview_payload_hash(clip_id,&source_hash);
        let latest:Option<(i64,String,bool)>=tx.query_row("SELECT id,status,cancel_requested FROM jobs WHERE kind='photo_preview' AND payload_hash=?1 ORDER BY id DESC LIMIT 1",[&hash],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
        match latest {
            Some((_id,status,_)) if status=="done"&&preview_exists=>continue,
            Some((_id,status,_)) if matches!(status.as_str(),"pending"|"running")=>continue,
            Some((_id,status,true)) if matches!(status.as_str(),"failed"|"blocked")=>continue,
            Some((id,status,false)) if matches!(status.as_str(),"done"|"failed"|"blocked")=>{
                tx.execute("UPDATE jobs SET status='pending',attempt=0,blocked_summary=NULL,result_path=NULL,finished_at=NULL,owner_id=NULL,lease_expires_at=NULL,cancel_requested=0,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",[id])?;
                enqueued+=1;
            }
            None=>{
                let payload=serde_json::to_string(&super::artifacts::ArtifactJobPayload{clip_id,path,source_hash}).map_err(|e|error(&e.to_string()))?;
                super::jobs::enqueue_within(&tx,"photo_preview",&payload,&hash)?;
                enqueued+=1;
            }
            _=>{}
        }
    }
    tx.commit()?;
    Ok(enqueued)
}

pub fn urls(connection: &Connection,cache_root: &Path,clip_id: i64,port: u16,token: &str)->Result<Option<(String,Option<String>)>> {
    let cover:Option<(String,String)>=connection.query_row("SELECT a.rel_path,a.source_hash FROM cache_artifacts a JOIN clips c ON c.id=a.clip_id WHERE a.clip_id=?1 AND a.kind='cover' AND c.kind='photo' AND a.source_hash=c.quick_hash",[clip_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((cover,source_hash))=cover else {return Ok(None);};
    let Some(name)=Path::new(&cover).file_name().and_then(|s|s.to_str()) else {return Ok(None);};
    if !matches!(name,"cover.jpg"|"cover.png") || cover!=format!("{clip_id}/{name}") {return Ok(None);}
    let preview=format!("{clip_id}/{}",name.replace("cover.","preview."));
    if !cache_root.join(&cover).is_file() {return Ok(None);}
    let preview_done:bool=connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='photo_preview' AND payload_hash=?1 AND status='done')",
        [preview_payload_hash(clip_id,&source_hash)],|row|row.get(0),
    )?;
    let preview=(preview_done&&cache_root.join(&preview).is_file()).then(||super::media_server::signed_cache_url(port,token,clip_id,&name.replace("cover.","preview."))).transpose()?;
    Ok(Some((super::media_server::signed_cache_url(port,token,clip_id,name)?,preview)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, import, import_control, jobs, test_support::TestDirectory};
    fn test_image()->image::RgbImage {
        image::RgbImage::from_fn(96,64,|x,y|image::Rgb(match (x<48,y<32) {
            (true,true)=>[240,20,20],(false,true)=>[20,240,20],(true,false)=>[20,20,240],(false,false)=>[230,220,20],
        }))
    }
    fn jpeg_with_orientation(path: &Path,orientation: u8) {
        let mut bytes=Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes,100).encode_image(&image::DynamicImage::ImageRgb8(test_image())).unwrap();
        // Minimal little-endian TIFF IFD: EXIF orientation tag 0x0112, SHORT.
        let mut app=vec![0xff,0xe1,0,34,b'E',b'x',b'i',b'f',0,0,b'I',b'I',42,0,8,0,0,0,1,0,0x12,1,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0];
        app.extend_from_slice(&bytes[2..]);
        let mut result=vec![0xff,0xd8];result.extend(app);
        std::fs::write(path,result).unwrap();
    }
    fn claimed_photo_thumbnail() -> (TestDirectory, Connection, super::super::jobs::Job, PathBuf) {
        let d=TestDirectory::new();
        let source=d.path().join("source.jpg");
        test_image().save(&source).unwrap();
        let (source_hash,byte_size)=super::super::import::quick_fingerprint(&source).unwrap();
        let mut connection=db::open_project(&d.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('fixture')",[]).unwrap();
        connection.execute(
            "INSERT INTO clips(id,volume_uuid,rel_path,byte_size,quick_hash,kind) VALUES(42,'fixture',?1,?2,?3,'photo')",
            params![source.to_string_lossy(),byte_size as i64,source_hash],
        ).unwrap();
        enqueue(&mut connection,42,&source,&source_hash).unwrap();
        let job=jobs::claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(job.kind,"thumbnail");
        (d,connection,job,source)
    }

    /// 确定性坏图已经由 photo_meta.error 留下可见证据后，启动补扫不得把 blocked
    /// thumbnail 永久复位；没有确定性错误的临时失败仍应恢复。
    #[test]
    fn r21_missing_cover_sweep_skips_confirmed_bad_photo_but_recovers_transient_failure() {
        let d=TestDirectory::new();
        let cache=d.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let mut connection=db::open_project(&d.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('photos')",[]).unwrap();
        connection.execute_batch(
            "INSERT INTO clips(id,volume_uuid,rel_path,quick_hash,kind) VALUES
               (41,'photos','bad.heic','bad-hash','photo'),
               (42,'photos','retry.heic','retry-hash','photo');
             INSERT INTO photo_meta(clip_id,error) VALUES(41,'图片不完整或已损坏');
             INSERT INTO photo_meta(clip_id,error) VALUES(42,NULL);",
        ).unwrap();
        enqueue(&mut connection,41,Path::new("bad.heic"),"bad-hash").unwrap();
        enqueue(&mut connection,42,Path::new("retry.heic"),"retry-hash").unwrap();
        connection.execute(
            "UPDATE jobs SET status='blocked',attempt=3,blocked_summary='decode failed',finished_at='now'
             WHERE kind='thumbnail'",
            [],
        ).unwrap();

        assert_eq!(enqueue_missing_covers(&mut connection,&cache).unwrap(),1);
        assert_eq!(enqueue_missing_covers(&mut connection,&cache).unwrap(),0);
        let bad:(i64,String,i64)=connection.query_row(
            "SELECT COUNT(*),MIN(status),MIN(attempt) FROM jobs WHERE kind='thumbnail' AND clip_id=41",
            [],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        let retry:(i64,String,i64)=connection.query_row(
            "SELECT COUNT(*),MIN(status),MIN(attempt) FROM jobs WHERE kind='thumbnail' AND clip_id=42",
            [],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(bad,(1,"blocked".into(),3),"确定性坏图的状态与 attempt 必须稳定");
        assert_eq!(retry,(1,"pending".into(),0),"健康照片的临时失败仍应由启动补扫恢复");
    }

    /// 首屏契约：cover 落地后 thumbnail 立即完成；2048 preview 另排低优先任务。
    /// 这条在修复前会看到 preview 已同步落地，且队列里没有 photo_preview。
    #[test]
    fn r21_photo_thumbnail_publishes_cover_before_preview() {
        let (d,mut connection,job,_source)=claimed_photo_thumbnail();
        let cache=d.path().join("cache");
        run_thumbnail(&mut connection,&job,&cache).unwrap();
        assert!(cache.join("42/cover.jpg").is_file());
        assert!(!cache.join("42/preview.jpg").exists(),"首屏 cover 不应再被 2048 preview 阻塞");
        let (thumbnail_status,preview_jobs):(String,i64)=connection.query_row(
            "SELECT (SELECT status FROM jobs WHERE id=?1),
                    (SELECT COUNT(*) FROM jobs WHERE kind='photo_preview' AND clip_id=42 AND status='pending')",
            [job.id],|row|Ok((row.get(0)?,row.get(1)?)),
        ).unwrap();
        assert_eq!(thumbnail_status,"done");
        assert_eq!(preview_jobs,1,"cover 完成后应恰好排一条 preview");
        let (cover_url,preview_url)=urls(&connection,&cache,42,1234,"secret").unwrap().unwrap();
        assert!(cover_url.contains("cover.jpg"));
        assert!(preview_url.is_none(),"preview 未完成时 cover URL 必须已经可用");
        let revision_with_cover=import::clips_revision(&connection).unwrap();
        std::fs::copy(cache.join("42/cover.jpg"),cache.join("42/preview.jpg")).unwrap();
        assert!(urls(&connection,&cache,42,1234,"secret").unwrap().unwrap().1.is_none(),"只有文件、任务未完成时不得伪装成可用 preview");
        let preview_job=jobs::claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(preview_job.kind,"photo_preview");
        run_preview(&mut connection,&preview_job,&cache).unwrap();
        assert!(cache.join("42/preview.jpg").is_file());
        assert_ne!(revision_with_cover,import::clips_revision(&connection).unwrap(),"导入页与全局 feed 共用的 clips revision 必须在 preview 完成时推进");
        assert!(urls(&connection,&cache,42,1234,"secret").unwrap().unwrap().1.is_some());
    }

    /// 失败的 preview 必须既能被「重新分析这条」恢复，也能被重启补扫恢复；
    /// 两条路径都只能复位原任务，不能撞同 payload_hash 再造重复行。
    #[test]
    fn r21_failed_photo_preview_recovers_on_retry_and_restart_without_duplicate() {
        let (d,mut connection,job,_source)=claimed_photo_thumbnail();
        let cache=d.path().join("cache");
        run_thumbnail(&mut connection,&job,&cache).unwrap();
        let preview_id:i64=connection.query_row("SELECT id FROM jobs WHERE kind='photo_preview'",[],|row|row.get(0)).unwrap();
        connection.execute("UPDATE jobs SET status='failed',attempt=3,blocked_summary='decode failed' WHERE id=?1",[preview_id]).unwrap();
        let retried=import_control::retry_clip_analysis(&mut connection,42).unwrap();
        assert_eq!(retried.reset,1,"单条重试必须复位失败的 photo_preview");
        let after_retry:(i64,String)=connection.query_row("SELECT COUNT(*),MIN(status) FROM jobs WHERE kind='photo_preview' AND clip_id=42",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(after_retry,(1,"pending".into()),"单条重试不得重复入队");

        connection.execute("UPDATE jobs SET status='blocked',attempt=3,blocked_summary='decode blocked' WHERE id=?1",[preview_id]).unwrap();
        std::fs::copy(cache.join("42/cover.jpg"),cache.join("42/preview.jpg")).unwrap();
        assert_eq!(enqueue_missing_previews(&mut connection,&cache).unwrap(),1);
        assert_eq!(enqueue_missing_previews(&mut connection,&cache).unwrap(),0);
        let after_restart:(i64,String)=connection.query_row("SELECT COUNT(*),MIN(status) FROM jobs WHERE kind='photo_preview' AND clip_id=42",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(after_restart,(1,"pending".into()),"重启补扫必须复位旧行且保持幂等");
    }
    #[test]
    fn r21_all_eight_exif_orientations_match_golden_pixels() {
        let d=TestDirectory::new();
        for orientation in 1..=8 {
            let path=d.path().join(format!("o{orientation}.jpg"));jpeg_with_orientation(&path,orientation);
            let meta=super::super::photo_probe::probe(&path).unwrap();assert_eq!(meta.orientation,i64::from(orientation));
            let decoded=image_io(&path,512).unwrap();
            let actual=image::load_from_memory(&decoded.bytes).unwrap().to_rgb8();
            let src=test_image();
            // Independent coordinate golden (EXIF convention), not decoder helper.
            let (w,h)=if orientation>=5 {(64,96)} else {(96,64)};
            assert_eq!((actual.width(),actual.height()),(w,h),"orientation {orientation}");
            for (x,y) in [(w/4,h/4),(3*w/4,h/4),(w/4,3*h/4),(3*w/4,3*h/4)] {
                let (sx,sy)=match orientation {
                    1=>(x,y),2=>(95-x,y),3=>(95-x,63-y),4=>(x,63-y),
                    5=>(y,x),6=>(y,63-x),7=>(95-y,63-x),8=>(95-y,x),_=>unreachable!(),
                };
                for c in 0..3 {assert!((i16::from(actual.get_pixel(x,y)[c])-i16::from(src.get_pixel(sx,sy)[c])).abs()<18,"orientation {orientation} pixel ({x},{y})");}
            }
        }
    }
    #[test]
    fn r21_transparent_png_stays_transparent_and_preview_is_bounded() {
        let d=TestDirectory::new();let p=d.path().join("alpha.png");
        image::RgbaImage::from_pixel(3000,1000,image::Rgba([250,0,0,64])).save(&p).unwrap();
        let cover=decode_cover(&p,512).unwrap();let preview=decode_preview(&p,2048).unwrap();
        assert_eq!(cover.extension,"png");assert_eq!(cover.width,512);assert_eq!(preview.width,2048);
        let image=image::load_from_memory(&cover.bytes).unwrap().to_rgba8();
        assert!((60..=68).contains(&image.get_pixel(50,50)[3]));
        let out=d.path().join("cover.png");std::fs::write(&out,&cover.bytes).unwrap();
        assert!(super::super::photo_probe::probe(&out).unwrap().color_space.unwrap().contains("sRGB"));
    }
    #[test]
    fn r21_48mp_input_produces_bounded_preview() {
        let d=TestDirectory::new();let p=d.path().join("48mp.jpg");
        image::RgbImage::from_pixel(8000,6000,image::Rgb([40,80,120])).save(&p).unwrap();
        let out=image_io(&p,2048).unwrap();
        assert_eq!((out.width,out.height),(2048,1536));
        assert!(out.bytes.len()<2_000_000);
        assert!(fallback(&p,2048).is_err(),"large-image fallback must not full-decode");
    }

    #[tokio::test]
    async fn r21_photo_artifacts_serve_with_signed_urls_and_correct_mime() {
        use axum::http::{Request,StatusCode};use tower::ServiceExt;
        let d=TestDirectory::new();std::fs::create_dir(d.path().join("42")).unwrap();
        let app=crate::core::media_server::router(crate::core::media_server::MediaServerState::new(d.path().to_path_buf(),"secret".into()));
        for (name,mime) in [("cover.png","image/png"),("preview.jpg","image/jpeg"),("preview.png","image/png")] {
            std::fs::write(d.path().join("42").join(name),b"fixture").unwrap();
            let signed=crate::core::media_server::signed_cache_url(1234,"secret",42,name).unwrap();
            let uri=signed.strip_prefix("http://127.0.0.1:1234").unwrap();
            let response=app.clone().oneshot(Request::builder().uri(uri).header("Origin","tauri://localhost").body(axum::body::Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(),StatusCode::OK);assert_eq!(response.headers()["content-type"],mime);
        }
    }

    /// 真机 25 张夹具跑出来的坑:HEVC 解出的缩略 CGImage 带 alpha 通道,按它判会把每张
    /// 不透明 HEIC 都写成 PNG(20 张 28 MB)。透明与否要问源文件属性,不问解码器。
    #[test]
    fn r21_opaque_heic_cover_is_jpeg_not_png() {
        let d=TestDirectory::new();let jpg=d.path().join("src.jpg");let heic=d.path().join("src.heic");
        test_image().save(&jpg).unwrap();
        let source=super::super::photo_probe::source(&jpg).unwrap();
        let url=objc2_core_foundation::CFURL::from_file_path(&heic).unwrap();
        let dest=unsafe {CGImageDestination::with_url(&url,&CFString::from_str("public.heic"),1,None)}.unwrap();
        unsafe {dest.add_image_from_source(&source,0,None);assert!(dest.finalize(),"本机 ImageIO 必须能编码 HEIC");}
        assert!(!super::super::photo_probe::probe(&heic).unwrap().has_alpha);
        let cover=decode_cover(&heic,512).unwrap();
        assert_eq!(cover.extension,"jpg","不透明 HEIC 的封面必须是 JPEG");
        assert_eq!(decode_preview(&heic,2048).unwrap().extension,"jpg");
    }

    #[test]
    fn r21_bad_decode_returns_error_without_panic() {
        let d=TestDirectory::new();let p=d.path().join("bad.jpg");
        std::fs::write(&p,[0xff,0xd8,0xff,0xe1,0,120]).unwrap();
        assert!(decode_cover(&p,512).is_err());assert!(decode_preview(&p,2048).is_err());
        assert!(decode_cover(&p,0).is_err());
    }
    #[test]
    fn r21_jpg_png_fallback_decodes_and_respects_orientation() {
        let d=TestDirectory::new();let p=d.path().join("fallback.jpg");jpeg_with_orientation(&p,6);
        let image=fallback(&p,512).unwrap();assert_eq!((image.width,image.height),(64,96));
        let p=d.path().join("fallback.png");image::RgbaImage::from_pixel(10,10,image::Rgba([10,20,30,100])).save(&p).unwrap();
        assert_eq!(fallback(&p,512).unwrap().extension,"png");
    }
    #[test]
    #[ignore = "requires macOS HEIC encoder outside the restricted sandbox; run explicitly with --ignored"]
    fn r21_100_synthetic_heic_covers_four_threads_benchmark() {
        let d=TestDirectory::new();let jpg=d.path().join("base.jpg");
        image::RgbImage::from_fn(2048,1536,|x,y|image::Rgb([(x%251) as u8,(y%251) as u8,((x+y)%251) as u8])).save(&jpg).unwrap();
        let heic=d.path().join("base.heic");
        let result=std::process::Command::new("/usr/bin/sips").env("TMPDIR",d.path()).args(["-s","format","heic"]).arg(&jpg).arg("--out").arg(&heic).output().unwrap();
        assert!(result.status.success(),"sips: {}",String::from_utf8_lossy(&result.stderr));
        let paths:Vec<_>=(0..100).map(|i|{let p=d.path().join(format!("{i}.heic"));std::fs::copy(&heic,&p).unwrap();p}).collect();
        let start=std::time::Instant::now();
        std::thread::scope(|scope| {
            let handles:Vec<_>=paths.chunks(25).map(|chunk|scope.spawn(move || {
                for p in chunk {let cover=decode_cover(p,512).unwrap();std::fs::write(p.with_extension("cover.jpg"),cover.bytes).unwrap();}
            })).collect();
            for handle in handles {handle.join().unwrap();}
        });
        eprintln!("R21 HEIC 100 x 2048x1536, four threads, decode+write: {:.3}s (target <=4s; synthetic copies, warm filesystem)",start.elapsed().as_secs_f64());
    }
}
