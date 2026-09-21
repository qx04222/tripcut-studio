//! Same-directory companion discovery. Never modify or follow links to originals.
use std::path::{Path, PathBuf};
use rusqlite::{params, Connection};
use serde::Serialize;
use super::error::Result;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CompanionDto {
    pub id: i64,
    pub clip_id: i64,
    pub path: String,
    pub role: String,
    pub size: i64,
    pub mtime: Option<i64>,
}

#[derive(Debug, Default)]
pub struct CompanionGroup {
    pub files: Vec<(PathBuf, &'static str)>,
    pub ambiguous: bool,
}

pub fn discover(primary: &Path) -> Result<CompanionGroup> {
    let Some(parent) = primary.parent() else { return Ok(CompanionGroup::default()); };
    let Some(stem) = primary.file_stem() else { return Ok(CompanionGroup::default()); };
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        let path=entry.path();
        let same_stem=path.file_stem()==Some(stem);
        let double_stem=path.extension().and_then(|value|value.to_str()).is_some_and(|value|value.eq_ignore_ascii_case("xmp"))
            && path.file_stem().is_some_and(|value|Path::new(value).file_stem()==Some(stem));
        // 大目录里绝大多数文件与当前照片无关。先按名字过滤，只对可能成为
        // companion 的少数条目查询 file_type、排序，避免每张照片重复 stat+sort 整个目录。
        if (same_stem||double_stem) && entry.file_type()?.is_file() {entries.push(path);}
    }
    entries.sort();
    // Case-sensitive stem comparison respects case-sensitive source volumes.
    // Extensions alone are case-insensitive (camera exports commonly use uppercase).
    let primaries = entries.iter().filter(|p| p.file_stem() == Some(stem)
        && super::import::media_kind(p) == Some("photo") && !super::import::is_raw(p)).count();
    if primaries > 1 { return Ok(CompanionGroup { files: Vec::new(), ambiguous: true }); }
    let live = matches!(extension(primary).as_str(), "heic" | "heif");
    let mut group = CompanionGroup::default();
    for path in entries {
        if path == primary { continue; }
        let ext = extension(&path);
        let same_stem = path.file_stem() == Some(stem);
        let role = if same_stem && matches!(ext.as_str(),"arw"|"dng"|"cr2"|"cr3"|"nef"|"nrw"|"raf"|"rw2"|"orf"|"pef"|"srw"|"raw"|"sr2"|"srf"|"rwl") {
            Some("raw")
        } else if ext == "xmp" && (same_stem || path.file_stem().is_some_and(|s| Path::new(s).file_stem() == Some(stem))) {
            Some("xmp")
        } else if same_stem && live && ext == "mov" { Some("live_mov") } else { None };
        if let Some(role) = role { group.files.push((path,role)); }
    }
    Ok(group)
}

fn extension(path: &Path) -> String {
    path.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Only suppress a MOV when there is exactly one unambiguous HEIC/HEIF primary.
pub fn is_live_companion(path: &Path) -> Result<bool> {
    if extension(path) != "mov" { return Ok(false); }
    let Some(parent)=path.parent() else { return Ok(false); };
    for e in std::fs::read_dir(parent)? {
        let e=e?;
        let p=e.path();
        if e.file_type()?.is_file() && p.file_stem()==path.file_stem()
            && matches!(extension(&p).as_str(),"heic"|"heif") {
            return Ok(discover(&p)?.files.iter().any(|(p,r)|p==path && *r=="live_mov"));
        }
    }
    Ok(false)
}

pub fn store(connection: &Connection, clip_id: i64, group: &CompanionGroup) -> Result<()> {
    let paths:Vec<_>=group.files.iter().map(|(p,_)|p.to_string_lossy().into_owned()).collect();
    let paths=serde_json::to_string(&paths).map_err(|e|super::error::CoreError::Import(e.to_string()))?;
    connection.execute("DELETE FROM clip_companions WHERE clip_id=?1 AND path NOT IN (SELECT value FROM json_each(?2))",params![clip_id,paths])?;
    connection.execute("UPDATE photo_meta SET companions_ambiguous=?2 WHERE clip_id=?1", params![clip_id,group.ambiguous])?;
    for (path, role) in &group.files {
        let meta = std::fs::metadata(path)?;
        let mtime = meta.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t|t.as_secs() as i64);
        connection.execute("INSERT INTO clip_companions(clip_id,path,role,size,mtime) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(clip_id,path) DO UPDATE SET role=excluded.role,size=excluded.size,mtime=excluded.mtime", params![clip_id,path.to_string_lossy(),role,meta.len() as i64,mtime])?;
    }
    Ok(())
}

pub fn list(connection: &Connection, clip_id: i64) -> Result<Vec<CompanionDto>> {
    let mut stmt = connection.prepare("SELECT id,clip_id,path,role,size,mtime FROM clip_companions WHERE clip_id=?1 ORDER BY path")?;
    let rows = stmt.query_map([clip_id], |r| Ok(CompanionDto { id:r.get(0)?,clip_id:r.get(1)?,path:r.get(2)?,role:r.get(3)?,size:r.get(4)?,mtime:r.get(5)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_support::TestDirectory;
    fn files(dir: &Path, names: &[&str]) { for n in names { std::fs::write(dir.join(n), b"fixture").unwrap(); } }
    #[test]
    fn r21_raw_jpg_xmp_and_double_extension() {
        let d=TestDirectory::new();
        files(d.path(), &["IMG.JPG","IMG.ARW","IMG.xmp","IMG.CR3.xmp"]);
        let g=discover(&d.path().join("IMG.JPG")).unwrap();
        assert!(!g.ambiguous);
        assert_eq!(g.files.iter().map(|(_,r)|*r).collect::<Vec<_>>(), ["raw","xmp","xmp"]);
    }
    #[test]
    fn r21_cross_directory_never_pairs() {
        let d=TestDirectory::new();
        std::fs::create_dir(d.path().join("other")).unwrap();
        files(d.path(), &["IMG.JPG"]);
        files(&d.path().join("other"), &["IMG.ARW","IMG.xmp"]);
        assert!(discover(&d.path().join("IMG.JPG")).unwrap().files.is_empty());
    }
    #[test]
    fn r21_ambiguous_primaries_do_not_claim_companions() {
        let d=TestDirectory::new(); files(d.path(), &["IMG.JPG","IMG.PNG","IMG.ARW"]);
        let g=discover(&d.path().join("IMG.JPG")).unwrap();
        assert!(g.ambiguous); assert!(g.files.is_empty());
    }
    #[test]
    fn r21_heic_mov_is_live_companion() {
        let d=TestDirectory::new(); files(d.path(), &["IMG.HEIC","IMG.MOV"]);
        let g=discover(&d.path().join("IMG.HEIC")).unwrap();
        assert_eq!(g.files[0].1,"live_mov");
    }
}
