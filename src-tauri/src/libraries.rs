//! Library selection is applied only on restart: workers never change databases
//! underneath an in-flight job. Removing a library only hides its registry entry.
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::core::{db, error::{CoreError, Result}};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Library {
    pub id: String,
    pub name: String,
    pub hidden: bool,
}
#[derive(Serialize, Deserialize)]
pub struct Registry {
    pub active: String,
    pub libraries: Vec<Library>,
}
fn scope() -> &'static str { if cfg!(debug_assertions) { "dev" } else { "default" } }
fn registry_path(base: &Path) -> PathBuf { base.join(format!("libraries-{}.json", scope())) }
pub fn base() -> Result<PathBuf> {
    crate::app_paths::app_support_root().ok_or_else(|| CoreError::Import("无法确定素材库保存位置".into()))
}
pub fn path(base: &Path, id: &str) -> Result<PathBuf> {
    if id == "original" { return Ok(base.join(scope())); }
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(CoreError::Import("无效的素材库标识".into()));
    }
    Ok(base.join(format!("libraries-{}", scope())).join(id))
}
pub fn load(base: &Path) -> Result<Registry> {
    let file = registry_path(base);
    if !file.exists() {
        return Ok(Registry { active: "original".into(), libraries: vec![Library {
            id: "original".into(), name: "原有素材库".into(), hidden: false,
        }] });
    }
    let registry: Registry = serde_json::from_slice(&std::fs::read(file)?)
        .map_err(|e| CoreError::Import(format!("素材库列表无法读取，请保留文件后恢复：{e}")))?;
    if !registry.libraries.iter().any(|l| l.id == registry.active && !l.hidden) {
        return Err(CoreError::Import("当前素材库不在可用列表中".into()));
    }
    for library in &registry.libraries { path(base, &library.id)?; }
    Ok(registry)
}
fn save(base: &Path, registry: &Registry) -> Result<()> {
    std::fs::create_dir_all(base)?;
    let file = registry_path(base);
    let temp = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(registry).map_err(|e| CoreError::Import(e.to_string()))?;
    use std::io::Write;
    let mut output = std::fs::File::create(&temp)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    std::fs::rename(temp, file)?;
    std::fs::File::open(base)?.sync_all()?;
    Ok(())
}
pub fn active_path(base: &Path) -> Result<PathBuf> {
    let root=path(base, &load(base)?.active)?;
    if registry_path(base).exists() && !root.join("project.db").is_file() {
        return Err(CoreError::Import(format!("素材库文件缺失：{}。请恢复库文件，未创建空库覆盖。",root.display())));
    }
    Ok(root)
}
fn lock_registry(base: &Path) -> Result<db::ProjectFileLock> {
    db::try_acquire_project_lock(&registry_path(base))?.ok_or_else(|| CoreError::Import("另一个窗口正在修改素材库列表，请稍后重试".into()))
}
pub fn create(base: &Path, name: &str) -> Result<Registry> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 { return Err(CoreError::Import("库名称须为 1–80 个字".into())); }
    let _registry_lock = lock_registry(base)?;
    let mut registry = load(base)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let root = path(base, &id)?;
    std::fs::create_dir(&root).or_else(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { std::fs::create_dir_all(root.parent().unwrap())?; std::fs::create_dir(&root) } else { Err(e) }
    })?;
    db::initialize(&root.join("project.db"))?;
    registry.libraries.push(Library { id, name: name.into(), hidden: false });
    if let Err(error) = save(base, &registry) { let _ = std::fs::remove_dir_all(root); return Err(error); }
    Ok(registry)
}
pub fn select(base: &Path, id: &str) -> Result<()> {
    let _registry_lock = lock_registry(base)?;
    let mut registry = load(base)?;
    if !registry.libraries.iter().any(|l| l.id == id && !l.hidden) { return Err(CoreError::Import("素材库不存在或已移除".into())); }
    let root = path(base, id)?;
    if !root.join("project.db").is_file() { return Err(CoreError::Import("库文件不可用，请检查磁盘；未切换当前库".into())); }
    let _lock = db::try_acquire_project_lock(&root.join("project.db"))?
        .ok_or_else(|| CoreError::Import("目标素材库正由另一个窗口使用".into()))?;
    // Validate before persisting the restart target; never replace an invalid DB.
    db::validate_database_file(&root.join("project.db"))?;
    let connection = db::open_project(&root.join("project.db"))?;
    crate::core::episode::current_episode(&connection)?;
    registry.active = id.into();
    save(base, &registry)
}
pub fn set_hidden(base: &Path, id: &str, hidden: bool) -> Result<Registry> {
    let _registry_lock = lock_registry(base)?;
    let mut registry = load(base)?;
    if id == registry.active && hidden { return Err(CoreError::Import("请先切换到另一个库，再移除当前库".into())); }
    let entry = registry.libraries.iter_mut().find(|l| l.id == id)
        .ok_or_else(|| CoreError::Import("素材库不存在".into()))?;
    entry.hidden = hidden;
    save(base, &registry)?;
    Ok(registry)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn library_switch_hide_restore_preserves_databases_and_legacy_root() {
        let base = std::env::temp_dir().join(format!("tripcut-libraries-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        assert_eq!(active_path(&base).unwrap(), base.join(scope()));
        db::initialize(&base.join(scope()).join("project.db")).unwrap();
        let registry = create(&base, "旅行 A").unwrap();
        let id = &registry.libraries[1].id;
        assert!(set_hidden(&base, "original", true).is_err());
        select(&base, id).unwrap();
        set_hidden(&base, "original", true).unwrap();
        assert!(base.join(scope()).join("project.db").exists());
        assert!(select(&base, "original").is_err());
        set_hidden(&base, "original", false).unwrap();
        select(&base, "original").unwrap();
        assert!(path(&base, "../../outside").is_err());
        select(&base,id).unwrap();
        let child=path(&base,id).unwrap().join("project.db");
        std::fs::remove_file(&child).unwrap();
        assert!(active_path(&base).is_err());
        assert!(!child.exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}
