use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{types::ValueRef, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use super::db;
use super::error::{CoreError, Result};

const MIN_FREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PANIC_LOG_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const CACHE_SAMPLE_LIMIT: usize = 20;
const SENTINEL_FILE: &str = ".unclean-exit";
static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DoctorLevel {
    #[serde(rename = "OK")]
    Ok,
    #[serde(rename = "WARN")]
    Warn,
    #[serde(rename = "FAIL")]
    Fail,
}

impl DoctorLevel {
    fn severity(self) -> u8 {
        match self {
            Self::Ok => 0,
            Self::Warn => 1,
            Self::Fail => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DoctorCheck {
    pub id: String,
    pub title: String,
    pub status: DoctorLevel,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DoctorReport {
    pub status: DoctorLevel,
    pub checks: Vec<DoctorCheck>,
    pub abnormal_exit: bool,
    pub recovered_jobs: usize,
    pub cache_sampled: usize,
    pub cache_missing: usize,
    pub snapshots: Vec<String>,
    pub restart_required: bool,
}

impl DoctorReport {
    fn new(abnormal_exit: bool) -> Self {
        Self {
            status: DoctorLevel::Ok,
            checks: Vec::new(),
            abnormal_exit,
            recovered_jobs: 0,
            cache_sampled: 0,
            cache_missing: 0,
            snapshots: Vec::new(),
            restart_required: false,
        }
    }

    fn add(&mut self, id: &str, title: &str, status: DoctorLevel, detail: impl Into<String>) {
        self.checks.push(DoctorCheck {
            id: id.to_owned(),
            title: title.to_owned(),
            status,
            detail: detail.into(),
        });
        if status.severity() > self.status.severity() {
            self.status = status;
        }
    }

    pub fn record_recovery(&mut self, recovered_jobs: usize) {
        self.recovered_jobs = recovered_jobs;
        self.add(
            "job_recovery",
            "中断任务恢复",
            DoctorLevel::Ok,
            format!("已将 {recovered_jobs} 个中断任务恢复为待处理"),
        );
    }

    pub fn mark_restart_required(&mut self, detail: impl Into<String>) {
        self.restart_required = true;
        self.add("restart", "应用重启", DoctorLevel::Warn, detail);
    }

    pub fn record_snapshot(&mut self, snapshots_root: &Path, result: &Result<PathBuf>) {
        match result {
            Ok(_) => {
                self.snapshots = db::list_snapshots(snapshots_root)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|path| path.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .collect();
                self.add(
                    "startup_snapshot",
                    "启动快照",
                    DoctorLevel::Ok,
                    "本次成功启动的数据库快照已写入并完成轮转",
                );
            }
            Err(error) => self.add(
                "startup_snapshot",
                "启动快照",
                DoctorLevel::Warn,
                format!("启动完成，但创建快照失败：{error}"),
            ),
        }
    }

    pub fn record_cache_check_error(&mut self, error: &CoreError) {
        self.add(
            "cache_consistency",
            "缓存一致性抽查",
            DoctorLevel::Warn,
            format!("异常退出后的缓存抽查失败：{error}"),
        );
    }
}

pub fn begin_session(root: &Path) -> Result<bool> {
    std::fs::create_dir_all(root)?;
    let sentinel = root.join(SENTINEL_FILE);
    let previous_unclean = sentinel.exists();
    let temporary = root.join(format!(".{SENTINEL_FILE}.tmp-{}", std::process::id()));
    {
        let mut file = File::create(&temporary)?;
        writeln!(file, "pid={}", std::process::id())?;
        writeln!(file, "started_at_unix={}", unix_timestamp())?;
        file.sync_all()?;
    }
    std::fs::rename(temporary, sentinel)?;
    Ok(previous_unclean)
}

pub fn clear_sentinel(root: &Path) -> Result<()> {
    let path = root.join(SENTINEL_FILE);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn run_preflight(
    root: &Path,
    db_path: &Path,
    cache_root: &Path,
    abnormal_exit: bool,
) -> DoctorReport {
    let mut report = DoctorReport::new(abnormal_exit);
    check_database(&mut report, db_path);
    check_writable_directory(&mut report, cache_root);
    check_disk_space(&mut report, root);
    check_toolchain(&mut report, db_path);
    report.add(
        "previous_exit",
        "上次退出状态",
        if abnormal_exit {
            DoctorLevel::Warn
        } else {
            DoctorLevel::Ok
        },
        if abnormal_exit {
            "检测到异常退出标记，将恢复中断任务并抽查缓存一致性"
        } else {
            "上次会话正常结束"
        },
    );
    let snapshots_root = root.join("snapshots");
    match db::list_snapshots(&snapshots_root) {
        Ok(paths) => {
            report.snapshots = paths
                .iter()
                .filter_map(|path| path.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .collect();
            report.add(
                "snapshots",
                "数据库快照",
                if report.snapshots.is_empty() {
                    DoctorLevel::Warn
                } else {
                    DoctorLevel::Ok
                },
                if report.snapshots.is_empty() {
                    "尚无可恢复快照；首次成功启动后会自动创建"
                } else {
                    "快照目录可读取，恢复点已登记"
                },
            );
        }
        Err(error) => report.add(
            "snapshots",
            "数据库快照",
            DoctorLevel::Warn,
            format!("无法读取快照目录：{error}"),
        ),
    }
    report
}

fn check_database(report: &mut DoctorReport, db_path: &Path) {
    if !db_path.exists() {
        report.add(
            "database",
            "项目数据库",
            DoctorLevel::Ok,
            "数据库尚未创建，将在通过自检后初始化",
        );
        return;
    }
    match db::validate_database_file(db_path) {
        Ok(version) => report.add(
            "database",
            "项目数据库",
            DoctorLevel::Ok,
            format!("数据库可读且 quick_check 通过，schema V{version}"),
        ),
        Err(error @ CoreError::UnsupportedSchema { .. }) => report.add(
            "database",
            "项目数据库",
            DoctorLevel::Fail,
            format!("数据库版本超前，拒绝带病运行：{error}"),
        ),
        Err(error) => report.add(
            "database",
            "项目数据库",
            DoctorLevel::Fail,
            format!("数据库损坏或无法读取，拒绝带病运行：{error}"),
        ),
    }
}

fn check_writable_directory(report: &mut DoctorReport, cache_root: &Path) {
    let result = (|| -> Result<()> {
        std::fs::create_dir_all(cache_root)?;
        let probe = cache_root.join(format!(".doctor-write-{}", uuid::Uuid::new_v4()));
        OpenOptions::new().create_new(true).write(true).open(&probe)?.sync_all()?;
        std::fs::remove_file(probe)?;
        Ok(())
    })();
    match result {
        Ok(()) => report.add(
            "cache_writable",
            "缓存目录",
            DoctorLevel::Ok,
            "缓存目录可创建并写入",
        ),
        Err(error) => report.add(
            "cache_writable",
            "缓存目录",
            DoctorLevel::Fail,
            format!("缓存目录不可写，拒绝启动后台任务：{error}"),
        ),
    }
}

fn check_disk_space(report: &mut DoctorReport, root: &Path) {
    match available_bytes(root) {
        Ok(bytes) => report.add(
            "disk_space",
            "磁盘余量",
            if bytes > MIN_FREE_BYTES {
                DoctorLevel::Ok
            } else {
                DoctorLevel::Warn
            },
            format!("可用空间 {:.1} GB；建议保持 2 GB 以上", bytes as f64 / 1_073_741_824.0),
        ),
        Err(error) => report.add(
            "disk_space",
            "磁盘余量",
            DoctorLevel::Warn,
            format!("无法读取磁盘余量：{error}"),
        ),
    }
}

fn available_bytes(path: &Path) -> Result<u64> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        CoreError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "应用数据路径包含 NUL",
        ))
    })?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is a valid NUL-terminated string and stats points to writable memory.
    let result = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: statvfs returned success and initialized the structure.
    let stats = unsafe { stats.assume_init() };
    Ok((stats.f_bavail as u64).saturating_mul(stats.f_frsize))
}

fn check_toolchain(report: &mut DoctorReport, db_path: &Path) {
    let missing = [
        (super::settings::FFMPEG_PATH_KEY, "FFMPEG_PATH", "ffmpeg"),
        (super::settings::FFPROBE_PATH_KEY, "FFPROBE_PATH", "ffprobe"),
        (super::settings::WHISPER_PATH_KEY, "WHISPER_BIN", "whisper-cli"),
    ]
        .into_iter()
        .filter_map(|(setting_key, environment_key, name)| {
            (!tool_available(db_path, setting_key, environment_key, name)).then_some(name)
        })
        .collect::<Vec<_>>();
    report.add(
        "toolchain",
        "本地工具链",
        if missing.is_empty() {
            DoctorLevel::Ok
        } else {
            DoctorLevel::Warn
        },
        if missing.is_empty() {
            "ffmpeg、ffprobe 与 whisper-cli 均可探测".to_owned()
        } else {
            format!("未探测到 {}；可在设置页配置绝对路径", missing.join("、"))
        },
    );
}

fn tool_available(db_path: &Path, setting_key: &str, environment_key: &str, name: &str) -> bool {
    if command_available(name)
        || std::env::var_os(environment_key)
            .is_some_and(|path| Path::new(&path).is_file())
    {
        return true;
    }
    if !db_path.exists() {
        return false;
    }
    Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .ok()
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT value FROM settings WHERE key=?1",
                    [setting_key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
        })
        .is_some_and(|path| !path.is_empty() && Path::new(&path).is_file())
}

fn command_available(name: &str) -> bool {
    // 与设置页共用同一解析器,避免 Finder 启动的最小 PATH 导致两处判定不一致。
    super::settings::resolve_executable(std::ffi::OsStr::new(name)).is_some()
}

pub fn sample_cache_consistency(
    report: &mut DoctorReport,
    connection: &Connection,
    cache_root: &Path,
) -> Result<()> {
    let mut statement = connection.prepare(
        "SELECT rel_path FROM cache_artifacts ORDER BY created_at DESC, id DESC LIMIT ?1",
    )?;
    let paths = statement
        .query_map([CACHE_SAMPLE_LIMIT as i64], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let missing = paths
        .iter()
        .filter(|relative| !safe_cache_relative_path(relative) || !cache_root.join(relative).is_file())
        .count();
    report.cache_sampled = paths.len();
    report.cache_missing = missing;
    report.add(
        "cache_consistency",
        "缓存一致性抽查",
        if missing == 0 {
            DoctorLevel::Ok
        } else {
            DoctorLevel::Warn
        },
        format!("抽查 {} 条缓存记录，{} 条缺失或路径不安全", paths.len(), missing),
    );
    Ok(())
}

fn safe_cache_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && path.components().all(|component| {
            matches!(component, Component::Normal(_) | Component::CurDir)
        })
}

pub fn export_decision_data(db_path: &Path, recovery_root: &Path) -> Result<PathBuf> {
    let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.execute_batch("BEGIN DEFERRED TRANSACTION")?;
    let version = db::schema_version(&connection).ok();
    let tables = [
        "clips",
        "segments",
        "ratings",
        "tags",
        "chapters",
        "story_order",
        "shot_stack_preferences",
        "shot_stack_members",
        "destination_cards",
        "rescue_ranges",
        "settings",
    ];
    let mut exported = BTreeMap::new();
    let mut errors = BTreeMap::new();
    for table in tables {
        match table_exists(&connection, table) {
            Ok(true) => match export_table(&connection, table) {
                Ok(rows) => {
                    exported.insert(table.to_owned(), rows);
                }
                Err(error) => {
                    errors.insert(table.to_owned(), error.to_string());
                }
            },
            Ok(false) => {}
            Err(error) => {
                errors.insert(table.to_owned(), error.to_string());
            }
        }
    }
    let document = serde_json::json!({
        "format": "tripcut-decision-export-v1",
        "generated_at_unix": unix_timestamp(),
        "schema_version": version,
        "tables": exported,
        "errors": errors,
    });
    connection.execute_batch("COMMIT")?;
    std::fs::create_dir_all(recovery_root)?;
    let final_path = recovery_root.join(format!(
        "decisions-{}-{}.json",
        unix_timestamp(),
        uuid::Uuid::new_v4()
    ));
    let temporary = recovery_root.join(format!(".decisions-{}.tmp", uuid::Uuid::new_v4()));
    {
        let mut file = File::create(&temporary)?;
        serde_json::to_writer_pretty(&mut file, &document)
            .map_err(|error| CoreError::BackgroundTask(format!("无法序列化决策数据：{error}")))?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    std::fs::rename(temporary, &final_path)?;
    Ok(final_path)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )? != 0)
}

fn export_table(connection: &Connection, table: &str) -> Result<Vec<BTreeMap<String, serde_json::Value>>> {
    let mut statement = connection.prepare(&format!("SELECT * FROM \"{table}\""))?;
    let columns = statement.column_names().iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
    let rows = statement.query_map([], |row| {
        let mut exported = BTreeMap::new();
        for (index, column) in columns.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => serde_json::Value::Null,
                ValueRef::Integer(value) => value.into(),
                ValueRef::Real(value) => value.into(),
                ValueRef::Text(value) => String::from_utf8_lossy(value).into_owned().into(),
                ValueRef::Blob(value) => hex(value).into(),
            };
            exported.insert(column.clone(), value);
        }
        Ok(exported)
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(CoreError::from)
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

pub fn rebuild_cache_files(cache_root: &Path) -> Result<u64> {
    let bytes = directory_bytes(cache_root)?;
    let parent = cache_root.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let retired = parent.join(format!(".cache.recovery-{}", uuid::Uuid::new_v4()));
    if cache_root.exists() {
        std::fs::rename(cache_root, &retired)?;
    }
    if let Err(error) = std::fs::create_dir(cache_root) {
        if retired.exists() {
            let _ = std::fs::rename(&retired, cache_root);
        }
        return Err(error.into());
    }
    if retired.exists() {
        std::fs::remove_dir_all(retired)?;
    }
    Ok(bytes)
}

fn directory_bytes(root: &Path) -> Result<u64> {
    if !root.exists() {
        return Ok(0);
    }
    let mut total = 0_u64;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|error| CoreError::Io(std::io::Error::other(error)))?;
        if entry.file_type().is_file() {
            total = total.saturating_add(
                entry
                    .metadata()
                    .map_err(|error| CoreError::Io(error.into()))?
                    .len(),
            );
        }
    }
    Ok(total)
}

pub fn install_panic_hook(logs_root: PathBuf) {
    if PANIC_HOOK_INSTALLED.set(()).is_err() {
        return;
    }
    let _ = std::fs::create_dir_all(&logs_root);
    let _ = prune_panic_logs(&logs_root, SystemTime::now());
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_panic_log(&logs_root, info);
        previous(info);
    }));
}

fn write_panic_log(logs_root: &Path, info: &std::panic::PanicHookInfo<'_>) -> Result<()> {
    std::fs::create_dir_all(logs_root)?;
    let path = logs_root.join(format!(
        "panic-{}-{}-{}.log",
        unix_timestamp(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let payload = info
        .payload()
        .downcast_ref::<&str>()
        .map(|value| (*value).to_owned())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".to_owned());
    let location = info
        .location()
        .map(|location| {
            let file = Path::new(location.file())
                .file_name()
                .unwrap_or_default()
                .to_string_lossy();
            format!("{file}:{}:{}", location.line(), location.column())
        })
        .unwrap_or_else(|| "unknown".to_owned());
    let mut file = File::create(path)?;
    writeln!(file, "timestamp_unix={}", unix_timestamp())?;
    writeln!(file, "location={location}")?;
    writeln!(file, "message={}", sanitize_paths(&payload))?;
    file.sync_all()?;
    Ok(())
}

fn sanitize_paths(message: &str) -> String {
    message
        .split_whitespace()
        .map(|token| {
            if token.contains('/') {
                let trimmed = token.trim_matches(|character: char| {
                    matches!(character, '\'' | '"' | '(' | ')' | '[' | ']' | ',' | ';')
                });
                let file = Path::new(trimmed)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                format!("[path:{file}]")
            } else {
                token.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn prune_panic_logs(logs_root: &Path, now: SystemTime) -> Result<usize> {
    if !logs_root.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in std::fs::read_dir(logs_root)? {
        let entry = entry?;
        let path = entry.path();
        let is_panic_log = path
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|name| name.starts_with("panic-") && name.ends_with(".log"));
        if !is_panic_log {
            continue;
        }
        let age = now
            .duration_since(entry.metadata()?.modified()?)
            .unwrap_or_default();
        if age > PANIC_LOG_RETENTION {
            std::fs::remove_file(path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_support::TestDirectory;

    #[test]
    fn doctor_status_escalates_across_ok_warn_and_fail() {
        let mut report = DoctorReport::new(false);
        assert_eq!(report.status, DoctorLevel::Ok);
        report.add("warn", "warning", DoctorLevel::Warn, "warning");
        assert_eq!(report.status, DoctorLevel::Warn);
        report.add("fail", "failure", DoctorLevel::Fail, "failure");
        assert_eq!(report.status, DoctorLevel::Fail);
    }

    #[test]
    fn missing_database_is_healthy_for_first_run() {
        let directory = TestDirectory::new();
        let report = run_preflight(
            directory.path(),
            &directory.db_path(),
            &directory.path().join("cache"),
            false,
        );

        assert_ne!(report.status, DoctorLevel::Fail);
        assert_eq!(report.checks.iter().find(|check| check.id == "database").unwrap().status, DoctorLevel::Ok);
    }

    #[test]
    fn corrupt_database_is_a_hard_failure() {
        let directory = TestDirectory::new();
        std::fs::write(directory.db_path(), b"not sqlite").unwrap();

        let report = run_preflight(
            directory.path(),
            &directory.db_path(),
            &directory.path().join("cache"),
            false,
        );

        assert_eq!(report.status, DoctorLevel::Fail);
    }

    #[test]
    fn future_schema_is_a_hard_failure() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("UPDATE schema_version SET version=999", []).unwrap();
        drop(connection);

        let report = run_preflight(
            directory.path(),
            &directory.db_path(),
            &directory.path().join("cache"),
            false,
        );

        assert_eq!(report.status, DoctorLevel::Fail);
        assert!(report.checks.iter().any(|check| check.detail.contains("版本超前")));
    }

    #[test]
    fn sentinel_survives_until_an_explicit_clean_shutdown() {
        let directory = TestDirectory::new();
        assert!(!begin_session(directory.path()).unwrap());
        assert!(begin_session(directory.path()).unwrap());
        clear_sentinel(directory.path()).unwrap();
        assert!(!directory.path().join(SENTINEL_FILE).exists());
    }

    #[test]
    fn cache_sample_reports_missing_and_unsafe_entries() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        connection.execute("INSERT INTO clips(id, volume_uuid, rel_path) VALUES (1, 'v', 'a.mov')", []).unwrap();
        connection.execute(
            "INSERT INTO cache_artifacts(clip_id, kind, rel_path, source_hash, bytes, created_at)
             VALUES (1, 'cover', '../escape.jpg', 'h', 1, 'now')",
            [],
        ).unwrap();
        let mut report = DoctorReport::new(true);

        sample_cache_consistency(&mut report, &connection, &directory.path().join("cache")).unwrap();

        assert_eq!(report.cache_sampled, 1);
        assert_eq!(report.cache_missing, 1);
        assert_eq!(report.status, DoctorLevel::Warn);
    }

    #[test]
    fn decision_export_contains_user_tables_but_not_cache_tables() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v')", []).unwrap();
        connection.execute("INSERT INTO clips(id, volume_uuid, rel_path) VALUES (1, 'v', 'a.mov')", []).unwrap();
        drop(connection);

        let exported = export_decision_data(&directory.db_path(), &directory.path().join("recovery")).unwrap();
        let text = std::fs::read_to_string(exported).unwrap();

        assert!(text.contains("\"clips\""));
        assert!(!text.contains("\"cache_artifacts\""));
    }

    #[test]
    fn panic_messages_reduce_paths_to_file_names() {
        let sanitized = sanitize_paths("failed at /Users/person/Movies/private/clip.mov safely");
        assert_eq!(sanitized, "failed at [path:clip.mov] safely");
        assert!(!sanitized.contains("Users"));
    }

    #[test]
    fn file_only_cache_rebuild_swaps_the_directory() {
        let directory = TestDirectory::new();
        let cache = directory.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("partial.bin"), b"partial").unwrap();

        assert_eq!(rebuild_cache_files(&cache).unwrap(), 7);
        assert!(cache.is_dir());
        assert!(std::fs::read_dir(cache).unwrap().next().is_none());
    }
}
