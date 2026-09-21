//! Durable copy-only archive. A package is one conflict group, published by an
//! exclusive directory rename on the destination volume. No source is removed.
use super::error::{CoreError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Identity {
    dev: u64,
    ino: u64,
}
impl Identity {
    fn at(path: &Path) -> Result<Self> {
        let m = std::fs::symlink_metadata(path)?;
        if m.file_type().is_symlink() {
            return Err(problem("拒绝符号链接"));
        }
        Ok(Self {
            dev: m.dev(),
            ino: m.ino(),
        })
    }
    fn matches(&self, path: &Path) -> bool {
        Self::at(path).is_ok_and(|other| self.dev == other.dev && self.ino == other.ino)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Source {
    path: PathBuf,
    size: u64,
    hash: String,
    identity: Identity,
}
impl Source {
    fn read(path: &Path) -> Result<Self> {
        no_links(path)?;
        let mut file = open_read(path)?;
        if !file.metadata()?.is_file() {
            return Err(problem("只接受普通文件"));
        }
        let metadata = file.metadata()?;
        let size = metadata.len();
        let identity = Identity {
            dev: metadata.dev(),
            ino: metadata.ino(),
        };
        let hash = hash_reader(&mut file)?;
        if file.metadata()?.len() != size {
            return Err(problem("源文件在计划时发生变化"));
        }
        Ok(Self {
            path: path.to_path_buf(),
            size,
            hash,
            identity,
        })
    }
    fn verify(&self) -> Result<()> {
        let now = Self::read(&self.path)?;
        if now.size != self.size
            || now.hash != self.hash
            || now.identity.dev != self.identity.dev
            || now.identity.ino != self.identity.ino
        {
            return Err(problem(format!("文件已变化：{}", self.path.display())));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Member {
    original: Source,
    derived: bool,
    /// D-1:准备阶段判定的坏源 companion 组成员 —— 没有产物,永不复制 / 发布,状态记 failed
    /// 并带原因。与复制阶段可重试的 failed 区分开(那种在下次 execute 时会重新复制)。
    #[serde(default)]
    skipped: bool,
    relative: PathBuf,
    input: Source,
    temp: PathBuf,
    identity: Option<Identity>,
    quarantine: PathBuf,
    status: String,
    error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Plan {
    version: u32,
    conflict_policy: String,
    base: PathBuf,
    parent_identity: Identity,
    destination: PathBuf,
    stage: PathBuf,
    stage_identity: Option<Identity>,
    payload_identity: Option<Identity>,
    members: Vec<Member>,
    sealed: bool,
    undo: bool,
    job_id: Option<i64>,
    preparation: Option<PathBuf>,
    abandoned_stages: Vec<PathBuf>,
}
#[derive(Clone, Debug, Serialize)]
pub struct ArchiveFile {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub size: u64,
    pub source_hash: String,
    pub derived: bool,
    pub status: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct ArchiveOperation {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub destination: PathBuf,
    pub job_id: Option<i64>,
    pub needs_preparation: bool,
    pub undo_requested: bool,
    pub errors: Vec<String>,
    pub files: Vec<ArchiveFile>,
}
struct Loaded {
    plan: Plan,
    status: String,
    kind: String,
}
fn problem(message: impl Into<String>) -> CoreError {
    CoreError::Export(message.into())
}
fn encode(plan: &Plan) -> Result<String> {
    serde_json::to_string(plan).map_err(|e| problem(e.to_string()))
}
fn load(c: &Connection, id: &str) -> Result<Loaded> {
    let (json, status, kind): (String, String, String) = c.query_row(
        "SELECT plan_json,status,kind FROM archive_ops WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let plan = serde_json::from_str(&json).map_err(|e| problem(format!("归档日志损坏：{e}")))?;
    Ok(Loaded { plan, status, kind })
}
fn dto(id: &str, loaded: Loaded) -> ArchiveOperation {
    ArchiveOperation {
        id: id.into(),
        kind: loaded.kind,
        status: loaded.status,
        destination: loaded.plan.destination.clone(),
        files: loaded
            .plan
            .members
            .iter()
            .map(|m| ArchiveFile {
                source: m.original.path.clone(),
                destination: loaded.plan.destination.join(&m.relative),
                size: m.original.size,
                source_hash: m.original.hash.clone(),
                derived: m.derived,
                status: m.status.clone(),
            })
            .collect(),
        job_id: loaded.plan.job_id,
        needs_preparation: !loaded.plan.sealed,
        undo_requested: loaded.plan.undo,
        errors: loaded
            .plan
            .members
            .iter()
            .filter_map(|m| m.error.clone())
            .collect(),
    }
}
pub fn get(c: &Connection, id: &str) -> Result<ArchiveOperation> {
    Ok(dto(id, load(c, id)?))
}
fn save(c: &Connection, id: &str, plan: &Plan, status: &str) -> Result<()> {
    // Savepoint keeps JSON, per-file paths and states coherent, even during a suffix change.
    c.execute_batch("SAVEPOINT archive_save")?;
    let result = (|| -> Result<()> {
        c.execute("UPDATE archive_ops SET plan_json=?2,status=?3,started_at=CASE WHEN ?3='running' THEN COALESCE(started_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE started_at END,finished_at=CASE WHEN ?3 IN ('done','undone') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=?1",params![id,encode(plan)?,status])?;
        for (index, m) in plan.members.iter().enumerate() {
            c.execute("INSERT INTO archive_op_files(op_id,file_index,src_path,src_size,src_hash,dst_path,dst_temp,status,error) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(op_id,file_index) DO UPDATE SET dst_path=excluded.dst_path,dst_temp=excluded.dst_temp,status=excluded.status,error=excluded.error",params![id,index as i64,m.original.path.to_string_lossy(),m.original.size as i64,m.original.hash,plan.destination.join(&m.relative).to_string_lossy(),m.temp.to_string_lossy(),m.status,m.error])?;
        }
        Ok(())
    })();
    if result.is_ok() {
        c.execute_batch("RELEASE archive_save")?;
    } else {
        c.execute_batch("ROLLBACK TO archive_save; RELEASE archive_save")?;
    }
    result
}
fn no_links(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir) {
            return Err(problem("归档路径不能含 .."));
        }
        current.push(part);
        // macOS exposes these fixed system aliases; plans store canonical paths.
        if current == Path::new("/var") || current == Path::new("/tmp") {
            continue;
        }
        match std::fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(problem(format!(
                    "归档路径不能经过符号链接：{}",
                    current.display()
                )))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn open_read(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?)
}
fn hash_reader(input: &mut File) -> Result<String> {
    let mut hash = blake3::Hasher::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hash.finalize().to_hex().to_string())
}
fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}
fn relative_valid(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Freeze every original (including companions) before preparing any derived media.
pub fn begin(
    c: &Connection,
    kind: &str,
    destination: &Path,
    specs: Vec<(PathBuf, PathBuf)>,
    job_id: Option<i64>,
) -> Result<String> {
    begin_with_transforms(c, kind, destination, specs, job_id, &[])
}

pub(crate) fn begin_with_transforms(
    c: &Connection,
    kind: &str,
    destination: &Path,
    specs: Vec<(PathBuf, PathBuf)>,
    job_id: Option<i64>,
    derived: &[PathBuf],
) -> Result<String> {
    if specs.is_empty() {
        return Err(problem("归档计划为空"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| problem("缺少目标目录"))?
        .canonicalize()?;
    let destination = parent.join(
        destination
            .file_name()
            .ok_or_else(|| problem("缺少目标名称"))?,
    );
    no_links(&destination)?;
    let id = Uuid::new_v4().to_string();
    let stage = parent.join(format!(".tripcut-archive-{id}"));
    let mut members: Vec<Member> = Vec::new();
    for (source, relative) in specs {
        if !relative_valid(&relative) || members.iter().any(|m| m.relative == relative) {
            return Err(problem("归档文件目标重复或不安全"));
        }
        no_links(&source)?;
        let source = source.canonicalize()?;
        if source.starts_with(&destination) {
            return Err(problem("归档目标不能包含原片"));
        }
        let original = Source::read(&source)?;
        let index = members.len();
        members.push(Member {
            input: original.clone(),
            original,
            derived: derived.contains(&relative),
            skipped: false,
            relative,
            temp: stage.join(format!("part-{index}")),
            identity: None,
            quarantine: stage.join(format!("undo-{index}")),
            status: "planned".into(),
            error: None,
        });
    }
    let plan = Plan {
        version: 1,
        conflict_policy: "suffix_entire_package_no_replace".into(),
        parent_identity: Identity::at(destination.parent().unwrap())?,
        base: destination.clone(),
        destination,
        stage,
        stage_identity: None,
        payload_identity: None,
        members,
        sealed: false,
        undo: false,
        job_id,
        preparation: None,
        abandoned_stages: Vec::new(),
    };
    c.execute(
        "INSERT INTO archive_ops(id,kind,status,plan_json) VALUES(?1,?2,'planned',?3)",
        params![id, kind, encode(&plan)?],
    )?;
    save(c, &id, &plan, "planned")?;
    Ok(id)
}

pub fn for_job(c: &Connection, job_id: i64) -> Result<Option<ArchiveOperation>> {
    let id:Option<String>=c.query_row("SELECT id FROM archive_ops WHERE json_extract(plan_json,'$.job_id')=?1 ORDER BY rowid DESC LIMIT 1",[job_id],|r|r.get(0)).optional()?;
    id.map(|id| get(c, &id)).transpose()
}

pub fn verify_originals(c: &Connection, id: &str) -> Result<()> {
    for m in &load(c, id)?.plan.members {
        m.original.verify()?;
    }
    Ok(())
}

/// Preparation directories are never reused or recursively deleted after interruption.
pub fn preparation(c: &Connection, id: &str) -> Result<PathBuf> {
    let mut loaded = load(c, id)?;
    verify_parent(&loaded.plan)?;
    verify_originals(c, id)?;
    let path = loaded
        .plan
        .stage
        .with_file_name(format!(".tripcut-prepare-{id}-{}", Uuid::new_v4()));
    if let Some(previous) = loaded.plan.preparation.replace(path.clone()) {
        loaded.plan.abandoned_stages.push(previous);
    }
    // A fresh preparation re-renders every member: an earlier attempt's failed marks
    // (record_failure / D-1 skips) are evidence of that attempt, not of this one.
    for member in &mut loaded.plan.members {
        if member.status == "failed" {
            member.status = "planned".into();
            member.error = None;
            member.skipped = false;
        }
    }
    save(c, id, &loaded.plan, "running")?;
    std::fs::create_dir(&path)?;
    sync_dir(path.parent().unwrap())?;
    Ok(path)
}

/// Pure copy plans need no renderer. Used by callers that archive original files.
pub fn seal_copies(c: &Connection, id: &str) -> Result<()> {
    let mut loaded = load(c, id)?;
    verify_originals(c, id)?;
    loaded.plan.sealed = true;
    save(c, id, &loaded.plan, "planned")
}

/// Freeze renderer outputs only after the entire package is ready. Original hashes
/// remain separate from derived hashes (HEIC conversion and video remux are not copies).
pub fn seal_prepared(c: &Connection, id: &str, root: &Path) -> Result<()> {
    let mut loaded = load(c, id)?;
    if loaded.plan.sealed {
        return Err(problem("归档计划已冻结"));
    }
    verify_originals(c, id)?;
    no_links(root)?;
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| problem(e.to_string()))?;
        if entry.file_type().is_symlink() {
            return Err(problem("准备目录含符号链接"));
        }
        if entry.file_type().is_file() {
            entries.push(entry.path().to_path_buf());
        }
    }
    entries.sort();
    for m in &mut loaded.plan.members {
        // D-1:准备阶段已判失败的成员(坏源及其伴随组)没有产物,不冻结、不复制、不发布。
        if m.skipped {
            continue;
        }
        let path = root.join(&m.relative);
        m.input = Source::read(&path)?;
        if !m.derived && (m.input.hash != m.original.hash || m.input.size != m.original.size) {
            return Err(problem(format!(
                "复制产物与冻结原件不一致：{}",
                path.display()
            )));
        }
    }
    for path in entries {
        let relative = path
            .strip_prefix(root)
            .map_err(|e| problem(e.to_string()))?
            .to_path_buf();
        if loaded.plan.members.iter().any(|m| m.relative == relative) {
            continue;
        }
        let input = Source::read(&path)?;
        let index = loaded.plan.members.len();
        loaded.plan.members.push(Member {
            original: input.clone(),
            derived: false,
            skipped: false,
            input,
            relative,
            temp: loaded.plan.stage.join(format!("part-{index}")),
            identity: None,
            quarantine: loaded.plan.stage.join(format!("undo-{index}")),
            status: "planned".into(),
            error: None,
        });
    }
    loaded.plan.sealed = true;
    save(c, id, &loaded.plan, "planned")
}

/// All byte copies use exclusive creation, short-write handling, flush+fsync and
/// an independent full read of the output. Preparation copies are not completion.
pub(crate) fn copy_verified(source: &Path, destination: &Path) -> Result<()> {
    let expected = Source::read(source)?;
    let mut input = open_read(source)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(destination)?;
    std::io::copy(&mut input, &mut output)?;
    output.flush()?;
    output.sync_all()?;
    let actual = Source::read(destination)?;
    expected.verify()?;
    if actual.hash != expected.hash || actual.size != expected.size {
        return Err(problem("复制校验失败"));
    }
    Ok(())
}

/// D-1(0.11.0 语义):一条坏源只让它所在的 companion 组失败。调用方在准备阶段把该组的
/// 目标相对路径交进来,这些成员记 failed 并带原因;其余成员照常冻结、复制、发布,op 仍以
/// done 收尾(failed 成员留在日志里作为证据)。不在计划里的路径忽略。
pub(crate) fn skip_members(c: &Connection, id: &str, relatives: &[PathBuf], reason: &str) -> Result<()> {
    let mut loaded = load(c, id)?;
    if loaded.plan.sealed {
        return Err(problem("归档计划已冻结,不能再标记失败成员"));
    }
    for member in &mut loaded.plan.members {
        if member.status != "published" && relatives.iter().any(|r| r == &member.relative) {
            member.status = "failed".into();
            member.skipped = true;
            member.error = Some(reason.into());
        }
    }
    let status = loaded.status.clone();
    save(c, id, &loaded.plan, &status)
}

/// Nothing to recover (every source failed before anything was prepared): terminal
/// `failed`, leftovers swept, never listed as "上次交付未完成".
pub(crate) fn abandon(c: &Connection, id: &str, message: &str) -> Result<()> {
    let mut loaded = load(c, id)?;
    if loaded.status == "done" || loaded.status == "undone" || loaded.status == "failed" {
        return Ok(());
    }
    if loaded.plan.members.iter().any(|m| m.status == "published") {
        return Err(problem("已有成员发布,不能整体放弃"));
    }
    for member in &mut loaded.plan.members {
        member.status = "failed".into();
        if member.error.is_none() {
            member.error = Some(message.into());
        }
    }
    cleanup_terminal(c, id, &mut loaded.plan, "failed")
}

pub(crate) fn record_failure(c: &Connection, id: &str, message: &str) -> Result<()> {
    let mut loaded = load(c, id)?;
    if loaded.status == "done" || loaded.status == "undone" || loaded.status == "failed" {
        return Ok(());
    }
    for member in &mut loaded.plan.members {
        if member.status != "published" && !member.skipped {
            member.status = "failed".into();
            member.error = Some(message.into());
        }
    }
    save(c, id, &loaded.plan, "partial")
}

/// Explicit user retry requeues preparation/adoption through the existing job worker.
pub fn resume(c: &Connection, id: &str) -> Result<ArchiveOperation> {
    let loaded = load(c, id)?;
    if loaded.plan.undo {
        return undo(c, id);
    }
    if let Some(job) = loaded.plan.job_id {
        let status: String =
            c.query_row("SELECT status FROM jobs WHERE id=?1", [job], |r| r.get(0))?;
        if status == "running" || status == "pending" {
            return get(c, id);
        }
        if !loaded.plan.sealed {
            verify_originals(c, id)?;
        } else {
            execute(c, id)?;
        }
        c.execute("UPDATE jobs SET status='pending',cancel_requested=0,payload=json_set(payload,'$.progress.cancel_requested',json('false')),blocked_summary=NULL,owner_id=NULL,lease_expires_at=NULL,finished_at=NULL,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND status NOT IN ('pending','running')",[job])?;
        get(c, id)
    } else {
        execute(c, id)
    }
}

pub fn undo_idle(c: &Connection, id: &str) -> Result<ArchiveOperation> {
    if let Some(job) = load(c, id)?.plan.job_id {
        let active: bool = c.query_row(
            "SELECT status IN ('pending','running') FROM jobs WHERE id=?1",
            [job],
            |r| r.get(0),
        )?;
        if active {
            return Err(problem("交付仍在运行，请先取消再撤销"));
        }
    }
    undo(c, id)
}

pub fn recent(c: &Connection) -> Result<Vec<ArchiveOperation>> {
    let mut q = c.prepare("SELECT id FROM archive_ops WHERE status IN ('planned','running','partial','undoing') OR id IN (SELECT id FROM archive_ops ORDER BY rowid DESC LIMIT 30) ORDER BY rowid DESC")?;
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.iter().map(|id| get(c, id)).collect()
}

pub fn required_bytes(c: &Connection, id: &str) -> Result<u64> {
    Ok(load(c, id)?
        .plan
        .members
        .iter()
        .map(|m| m.original.size)
        .sum())
}

pub trait ArchiveFs {
    fn checkpoint(&self, _name: &str) -> std::io::Result<()> {
        Ok(())
    }
    fn copy(&self, input: &mut File, output: &mut File) -> std::io::Result<u64> {
        std::io::copy(input, output)
    }
    fn publish(&self, source: &Path, target: &Path) -> std::io::Result<()> {
        rename_exclusive(source, target)
    }
}
struct NativeFs;
impl ArchiveFs for NativeFs {}

/// macOS RENAME_EXCL closes the exists()/rename() race for files AND directories.
fn rename_exclusive(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
    let target = std::ffi::CString::new(target.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(not(target_os = "macos"))]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
fn verify_parent(plan: &Plan) -> Result<()> {
    if !plan.parent_identity.matches(plan.base.parent().unwrap()) {
        return Err(problem("目标卷或目录身份已改变，请接回原目标后重试"));
    }
    Ok(())
}
struct Claim {
    file: File,
    path: PathBuf,
}
impl Claim {
    fn acquire(plan: &Plan, id: &str) -> Result<Self> {
        verify_parent(plan)?;
        let lock = plan
            .base
            .parent()
            .unwrap()
            .join(format!(".tripcut-archive-{id}.lock"));
        no_links(&lock)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&lock)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(problem("此归档正在处理中"));
        }
        Ok(Self { file, path: lock })
    }
    /// Unlink the lock file while the lock is still held: a later claimant creates a
    /// fresh file, so nobody can ever observe two holders of one lock.
    fn release_and_remove(self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
impl Drop for Claim {
    fn drop(&mut self) {
        unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// After a terminal state nothing next to the delivery is ours to keep: the
/// preparation copies (a full second copy of the package), the private staging
/// directory and the lock file all go. Only directories this operation named and
/// logged are removed; an unlogged directory is left in place, as during recovery.
fn cleanup_terminal(c: &Connection, id: &str, plan: &mut Plan, status: &str) -> Result<()> {
    let parent = plan.base.parent().unwrap();
    let prepare_prefix = format!(".tripcut-prepare-{id}-");
    let mut candidates = std::mem::take(&mut plan.abandoned_stages);
    candidates.extend(plan.preparation.take());
    for path in candidates {
        let ours = path.parent() == Some(parent)
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(&prepare_prefix));
        // Leftovers never fail a finished delivery; a later run retries the removal.
        let removed = if ours && no_links(&path).is_ok() {
            std::fs::remove_dir_all(&path)
        } else {
            // A staging directory whose identity was never logged: only remove it when empty.
            std::fs::remove_dir(&path)
        };
        match removed {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => {
                tracing::warn!(op_id=%id,path=%path.display(),%e,"archive leftover kept");
                plan.abandoned_stages.push(path);
            }
        }
    }
    let payload = plan.stage.join("payload");
    let stage_ours = plan
        .stage_identity
        .as_ref()
        .is_some_and(|identity| identity.matches(&plan.stage));
    let payload_ours = match payload.try_exists()? {
        false => true,
        true => plan
            .payload_identity
            .as_ref()
            .is_some_and(|identity| identity.matches(&payload)),
    };
    if stage_ours && payload_ours {
        match std::fs::remove_dir_all(&plan.stage) {
            Ok(()) => plan.stage_identity = None,
            Err(e) => tracing::warn!(op_id=%id,path=%plan.stage.display(),%e,"archive staging kept"),
        }
    }
    let _ = sync_dir(parent);
    save(c, id, plan, status)
}

fn owned(m: &Member, path: &Path) -> bool {
    m.identity
        .as_ref()
        .is_some_and(|identity| identity.matches(path))
        && Source::read(path).is_ok_and(|s| s.hash == m.input.hash && s.size == m.input.size)
}
fn stage_init(c: &Connection, id: &str, plan: &mut Plan, fs: &dyn ArchiveFs) -> Result<()> {
    if (plan.stage_identity.is_none() && plan.stage.try_exists()?)
        || (plan.payload_identity.is_none() && plan.stage.join("payload").try_exists()?)
    {
        plan.abandoned_stages.push(plan.stage.clone());
        plan.stage = plan
            .base
            .parent()
            .unwrap()
            .join(format!(".tripcut-archive-{id}-{}", Uuid::new_v4()));
        plan.stage_identity = None;
        for (index, m) in plan.members.iter_mut().enumerate() {
            m.temp = plan.stage.join(format!("part-{index}"));
            m.quarantine = plan.stage.join(format!("undo-{index}"));
        }
        save(c, id, plan, "running")?;
    }
    no_links(&plan.stage)?;
    if let Some(identity) = &plan.stage_identity {
        if !identity.matches(&plan.stage) {
            return Err(problem("归档临时目录身份已改变"));
        }
    } else {
        // An unlogged directory is never assumed to be ours after a crash.
        if plan.stage.try_exists()? {
            return Err(problem("临时目录身份未确认，保留现场"));
        }
        std::fs::create_dir(&plan.stage)?;
        fs.checkpoint("stage_created")?;
        plan.stage_identity = Some(Identity::at(&plan.stage)?);
        sync_dir(plan.stage.parent().unwrap())?;
        save(c, id, plan, "running")?;
    }
    let payload = plan.stage.join("payload");
    if plan.payload_identity.is_none() {
        std::fs::create_dir(&payload)?;
        fs.checkpoint("payload_created")?;
        plan.payload_identity = Some(Identity::at(&payload)?);
        sync_dir(&plan.stage)?;
        save(c, id, plan, "running")?;
    }
    Ok(())
}
fn file_status(
    c: &Connection,
    id: &str,
    plan: &mut Plan,
    index: usize,
    status: &str,
) -> Result<()> {
    plan.members[index].status = status.into();
    plan.members[index].error = None;
    save(c, id, plan, "running")
}
fn copy_member(
    c: &Connection,
    id: &str,
    plan: &mut Plan,
    index: usize,
    fs: &dyn ArchiveFs,
) -> Result<()> {
    let staged = plan
        .stage
        .join("payload")
        .join(&plan.members[index].relative);
    no_links(&staged)?;
    if staged.try_exists()? {
        if !owned(&plan.members[index], &staged) {
            return Err(problem("临时交付文件已变化，保留"));
        }
        file_status(c, id, plan, index, "verified")?;
        return Ok(());
    }
    plan.members[index].input.verify()?;
    // Every retry uses a new exclusive temporary name. A short/unknown old file
    // stays in the private staging directory; never truncate a path after a crash.
    let temp = plan.stage.join(format!("part-{index}-{}", Uuid::new_v4()));
    plan.members[index].temp = temp.clone();
    plan.members[index].identity = None;
    file_status(c, id, plan, index, "planned")?;
    fs.checkpoint("planned")?;
    let mut input = open_read(&plan.members[index].input.path)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temp)?;
    plan.members[index].identity = Some(Identity::at(&temp)?);
    save(c, id, plan, "running")?;
    fs.checkpoint("temp_created")?;
    fs.copy(&mut input, &mut output)?;
    output.flush()?;
    output.sync_all()?;
    fs.checkpoint("copy_synced")?;
    file_status(c, id, plan, index, "copied")?;
    fs.checkpoint("copied")?;
    if !owned(&plan.members[index], &temp) {
        return Err(problem("目标全哈希校验失败"));
    }
    plan.members[index].input.verify()?;
    if let Some(parent) = staged.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rename_exclusive(&temp, &staged)?;
    sync_dir(staged.parent().unwrap())?;
    fs.checkpoint("staged")?;
    plan.members[index].temp = staged;
    file_status(c, id, plan, index, "verified")?;
    fs.checkpoint("verified")?;
    Ok(())
}
fn verify_outputs(plan: &Plan) -> Result<()> {
    no_links(&plan.destination)?;
    if !plan
        .payload_identity
        .as_ref()
        .is_some_and(|i| i.matches(&plan.destination))
    {
        return Err(problem("交付目录身份不匹配"));
    }
    for m in plan.members.iter().filter(|m| !m.skipped) {
        let path = plan.destination.join(&m.relative);
        no_links(&path)?;
        if !owned(m, &path) {
            return Err(problem(format!("交付文件缺失或已修改：{}", path.display())));
        }
    }
    Ok(())
}
pub fn execute(c: &Connection, id: &str) -> Result<ArchiveOperation> {
    execute_with(c, id, &NativeFs)
}
fn execute_with(c: &Connection, id: &str, fs: &dyn ArchiveFs) -> Result<ArchiveOperation> {
    let loaded = load(c, id)?;
    let claim = Claim::acquire(&loaded.plan, id)?;
    let mut loaded = load(c, id)?;
    if loaded.plan.undo || loaded.status == "undone" {
        return Err(problem("已开始撤销的归档不能再次发布"));
    }
    if loaded.status == "done" {
        verify_outputs(&loaded.plan)?;
        cleanup_terminal(c, id, &mut loaded.plan, "done")?;
        claim.release_and_remove();
        return get(c, id);
    }
    let result = run(c, id, &mut loaded.plan, fs);
    if let Err(error) = result {
        // Preserve individual failures; never turn a partial bundle into success.
        // D-1 skipped members already carry their own reason; a copy failure that
        // names one member leaves the others' reasons alone.
        if !loaded.plan.members.iter().any(|m| !m.skipped && m.error.is_some()) {
            for m in &mut loaded.plan.members {
                if m.status != "published" && !m.skipped {
                    m.error = Some(error.to_string());
                }
            }
        }
        save(c, id, &loaded.plan, "partial")?;
        fs.checkpoint("failed")?;
        fs.checkpoint("partial")?;
        return Err(error);
    }
    cleanup_terminal(c, id, &mut loaded.plan, "done")?;
    fs.checkpoint("cleaned")?;
    claim.release_and_remove();
    get(c, id)
}
fn run(c: &Connection, id: &str, plan: &mut Plan, fs: &dyn ArchiveFs) -> Result<()> {
    for m in plan.members.iter().filter(|m| !m.skipped) {
        m.original.verify()?;
    }
    if plan.members.iter().all(|m| m.skipped) {
        return Err(problem("归档计划里没有可发布的文件"));
    }
    if !plan.sealed {
        return Err(problem("上次交付未完成：需要继续准备文件"));
    }
    save(c, id, plan, "running")?;
    fs.checkpoint("running")?;
    let already_published = plan
        .payload_identity
        .as_ref()
        .is_some_and(|i| i.matches(&plan.destination));
    if !already_published {
        stage_init(c, id, plan, fs)?;
        if !plan
            .payload_identity
            .as_ref()
            .is_some_and(|i| i.matches(&plan.stage.join("payload")))
        {
            return Err(problem("暂存包身份不匹配"));
        }
        for index in 0..plan.members.len() {
            if plan.members[index].skipped {
                continue;
            }
            if let Err(error) = copy_member(c, id, plan, index, fs) {
                plan.members[index].status = "failed".into();
                plan.members[index].error = Some(error.to_string());
                return Err(error);
            }
        }
        // Sync each nested directory before its parent is made visible.
        for entry in walkdir::WalkDir::new(plan.stage.join("payload"))
            .contents_first(true)
            .follow_links(false)
        {
            let entry = entry.map_err(|e| problem(e.to_string()))?;
            if entry.file_type().is_dir() {
                sync_dir(entry.path())?;
            }
        }
        for m in plan.members.iter().filter(|m| !m.skipped) {
            m.original.verify()?;
        }
        let mut suffix = 2;
        loop {
            no_links(&plan.destination)?;
            fs.checkpoint("before_publish")?;
            match fs.publish(&plan.stage.join("payload"), &plan.destination) {
                Ok(()) => break,
                Err(e)
                    if e.kind() == std::io::ErrorKind::AlreadyExists
                        || e.raw_os_error() == Some(libc::ENOTEMPTY) =>
                {
                    let name = plan.base.file_name().unwrap().to_string_lossy();
                    plan.destination = plan.base.with_file_name(format!("{name}-{suffix}"));
                    suffix += 1;
                    save(c, id, plan, "running")?;
                }
                Err(e) => return Err(e.into()),
            }
        }
        sync_dir(plan.destination.parent().unwrap())?;
        fs.checkpoint("renamed")?;
    }
    verify_outputs(plan)?;
    for index in 0..plan.members.len() {
        if plan.members[index].skipped {
            continue;
        }
        file_status(c, id, plan, index, "published")?;
        fs.checkpoint("published")?;
    }
    save(c, id, plan, "done")?;
    fs.checkpoint("done")?;
    Ok(())
}

pub fn undo(c: &Connection, id: &str) -> Result<ArchiveOperation> {
    undo_with(c, id, &NativeFs)
}
fn undo_with(c: &Connection, id: &str, fs: &dyn ArchiveFs) -> Result<ArchiveOperation> {
    let loaded = load(c, id)?;
    let claim = Claim::acquire(&loaded.plan, id)?;
    let mut loaded = load(c, id)?;
    let plan = &mut loaded.plan;
    if loaded.status == "undone" {
        return get(c, id);
    }
    plan.undo = true;
    save(c, id, plan, "undoing")?;
    fs.checkpoint("undoing")?;
    // A finished delivery has had its staging directory cleaned up; quarantine needs one.
    let needs_quarantine = plan
        .members
        .iter()
        .any(|m| m.status != "undone" && plan.destination.join(&m.relative).try_exists().unwrap_or(true));
    if needs_quarantine && plan.stage_identity.is_none() && !plan.stage.try_exists()? {
        no_links(&plan.stage)?;
        std::fs::create_dir(&plan.stage)?;
        plan.stage_identity = Some(Identity::at(&plan.stage)?);
        sync_dir(plan.stage.parent().unwrap())?;
        save(c, id, plan, "undoing")?;
    }
    for index in 0..plan.members.len() {
        if plan.members[index].status == "undone" {
            continue;
        }
        if plan.members[index].skipped && !plan.destination.join(&plan.members[index].relative).try_exists()? {
            // D-1 skipped member: never published, nothing to quarantine.
            plan.members[index].status = "undone".into();
            plan.members[index].error = None;
            save(c, id, plan, "undoing")?;
            continue;
        }
        let outcome = undo_member(plan, index, fs);
        match outcome {
            Ok(()) => {
                plan.members[index].status = "undone".into();
                plan.members[index].error = None;
            }
            Err(e) => {
                plan.members[index].status = "conflict".into();
                plan.members[index].error = Some(e.to_string());
            }
        }
        save(c, id, plan, "undoing")?;
        if plan.members[index].status == "conflict" {
            fs.checkpoint("conflict")?;
        }
        fs.checkpoint("undone")?;
    }
    let status = if plan.members.iter().all(|m| m.status == "undone") {
        "undone"
    } else {
        "partial"
    };
    save(c, id, plan, status)?;
    if status == "undone" {
        cleanup_terminal(c, id, plan, status)?;
        claim.release_and_remove();
    }
    get(c, id)
}
fn undo_member(plan: &Plan, index: usize, fs: &dyn ArchiveFs) -> Result<()> {
    let m = &plan.members[index];
    let destination = plan.destination.join(&m.relative);
    no_links(&destination)?;
    no_links(&m.quarantine)?;
    if !destination.try_exists()? && !m.quarantine.try_exists()? {
        return Ok(());
    }
    if !plan
        .stage_identity
        .as_ref()
        .is_some_and(|i| i.matches(&plan.stage))
    {
        return Err(problem("撤销临时目录身份不匹配"));
    }
    if m.quarantine.try_exists()? {
        if !owned(m, &m.quarantine) {
            return Err(problem("隔离文件已被修改，保留"));
        }
    } else if destination.try_exists()? {
        if !plan
            .payload_identity
            .as_ref()
            .is_some_and(|i| i.matches(&plan.destination))
            || !owned(m, &destination)
        {
            return Err(problem(format!(
                "已修改或非本次创建，保留：{}",
                destination.display()
            )));
        }
        rename_exclusive(&destination, &m.quarantine)?;
        sync_dir(destination.parent().unwrap())?;
        sync_dir(&plan.stage)?;
        fs.checkpoint("quarantined")?;
        if !owned(m, &m.quarantine) {
            // A concurrent edit is preserved; put it back only if nobody took its name.
            rename_exclusive(&m.quarantine, &destination)?;
            return Err(problem("撤销期间文件被修改，保留"));
        }
    } else {
        // No published file is present: never search for or delete any source.
        return Ok(());
    }
    std::fs::remove_file(&m.quarantine)?;
    sync_dir(&plan.stage)?;
    fs.checkpoint("deleted")?;
    Ok(())
}

pub fn incomplete(c: &Connection) -> Result<Vec<ArchiveOperation>> {
    let mut query=c.prepare("SELECT id FROM archive_ops WHERE status IN ('planned','running','partial','undoing') ORDER BY rowid")?;
    let ids = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.iter().map(|id| get(c, id)).collect()
}
/// Reconcile each operation independently. Unplugged volumes keep errors/partial;
/// one unavailable operation must not prevent startup or another operation's recovery.
pub fn reconcile(c: &Connection) -> Result<Vec<ArchiveOperation>> {
    let operations = incomplete(c)?;
    for op in operations {
        let loaded = load(c, &op.id)?;
        let result = if loaded.plan.undo {
            undo(c, &op.id)
        } else {
            execute(c, &op.id)
        };
        if let Err(error) = result {
            tracing::warn!(op_id=%op.id,%error,"archive remains incomplete");
        }
    }
    // A crash between the terminal save and the cleanup leaves logged leftovers
    // (preparation copy, staging directory) beside a finished delivery; sweep them.
    let mut query = c.prepare("SELECT id,status FROM archive_ops WHERE status IN ('done','undone','failed') AND (json_extract(plan_json,'$.preparation') IS NOT NULL OR json_extract(plan_json,'$.stage_identity') IS NOT NULL OR json_array_length(plan_json,'$.abandoned_stages')>0)")?;
    let finished = query
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, status) in finished {
        let swept = (|| -> Result<()> {
            let loaded = load(c, &id)?;
            let claim = Claim::acquire(&loaded.plan, &id)?;
            let mut loaded = load(c, &id)?;
            if loaded.status != status {
                return Ok(());
            }
            cleanup_terminal(c, &id, &mut loaded.plan, &status)?;
            claim.release_and_remove();
            Ok(())
        })();
        if let Err(error) = swept {
            tracing::warn!(op_id=%id,%error,"archive leftovers remain");
        }
    }
    incomplete(c)
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;
