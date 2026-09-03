use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::db;
use super::error::{CoreError, Result};

pub const MAX_ATTEMPTS: i64 = 3;

// M5 benchmark reconciliation showed that four concurrent workers move the
// 500-item workload from roughly 100 minutes into the 10-minute range.
pub const WORKER_COUNT: usize = super::settings::DEFAULT_WORKER_COUNT;

const BUSY_RETRY_LIMIT: usize = 3;
const BUSY_RETRY_DELAY: Duration = Duration::from_millis(25);
const LEASE_SECONDS: i64 = 30;
const LEASE_HEARTBEAT: Duration = Duration::from_secs(10);

type CancellationMap = HashMap<(String, i64), Arc<AtomicBool>>;

static ACTIVE_CANCELLATIONS: OnceLock<Mutex<CancellationMap>> = OnceLock::new();
thread_local! {
    static CURRENT_CANCELLATION: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Pending,
    Running,
    Done,
    Failed,
    Blocked,
    #[allow(dead_code)]
    Cancelling,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Cancelling => "cancelling",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            "blocked" => Ok(Self::Blocked),
            "cancelling" => Ok(Self::Cancelling),
            other => Err(CoreError::InvalidSchema(format!(
                "unknown job status {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: i64,
    pub kind: String,
    pub payload: String,
    pub status: JobStatus,
    pub attempt: i64,
    pub blocked_summary: Option<String>,
    pub result_path: Option<String>,
}

fn read_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    let status: String = row.get(3)?;
    let status = JobStatus::parse(&status).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;

    Ok(Job {
        id: row.get(0)?,
        kind: row.get(1)?,
        payload: row.get(2)?,
        status,
        attempt: row.get(4)?,
        blocked_summary: row.get(5)?,
        result_path: row.get(6)?,
    })
}

pub fn enqueue(
    connection: &mut Connection,
    kind: &str,
    payload: &str,
    payload_hash: &str,
) -> Result<i64> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, 'pending', 0,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )",
        params![kind, payload, payload_hash],
    )?;
    let id = transaction.last_insert_rowid();
    transaction.commit()?;
    Ok(id)
}

pub fn enqueue_idempotent(
    connection: &mut Connection,
    kind: &str,
    payload: &str,
    payload_hash: &str,
) -> Result<i64> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let inserted = transaction.execute(
        "INSERT INTO jobs(
            kind, payload, payload_hash, status, attempt,
            next_attempt_at, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, 'pending', 0,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ) ON CONFLICT DO NOTHING",
        params![kind, payload, payload_hash],
    )?;
    let id = if inserted == 1 {
        transaction.last_insert_rowid()
    } else {
        transaction.query_row(
            "SELECT id FROM jobs
             WHERE kind=?1 AND payload_hash=?2 AND status IN ('pending', 'running')
             ORDER BY id DESC LIMIT 1",
            params![kind, payload_hash],
            |row| row.get(0),
        )?
    };
    transaction.commit()?;
    Ok(id)
}

pub fn get(connection: &Connection, id: i64) -> Result<Job> {
    connection
        .query_row(
            "SELECT id, kind, payload, status, attempt, blocked_summary, result_path
             FROM jobs WHERE id = ?1",
            [id],
            read_job,
        )
        .map_err(CoreError::from)
}

pub fn claim_next(connection: &mut Connection) -> Result<Option<Job>> {
    claim_next_for_owner(connection, "legacy-worker")
}

pub fn claim_next_for_owner(connection: &mut Connection, owner_id: &str) -> Result<Option<Job>> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let id = transaction
        .query_row(
            "SELECT id FROM jobs
             WHERE status = 'pending'
               AND cancel_requested = 0
               AND COALESCE(next_attempt_at, created_at)
                   <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             ORDER BY CASE kind
                        WHEN 'export_package' THEN 100
                        WHEN 'import_probe' THEN 60
                        WHEN 'metadata_backfill' THEN 57
                        WHEN 'align_clocks' THEN 56
                        WHEN 'chapterize' THEN 55
                        WHEN 'thumbnail' THEN 40
                        WHEN 'analyze_l1' THEN 30
                        WHEN 'analyze_motion' THEN 28
                        WHEN 'clip_embed' THEN 25
                        WHEN 'classify_dims' THEN 22
                        WHEN 'waveform' THEN 20
                        WHEN 'transcribe' THEN 15
                        WHEN 'proxy' THEN 10
                        WHEN 'similar_cluster' THEN 5
                        WHEN 'full_hash' THEN 58
                        ELSE 0
                      END DESC,
                      created_at, id
             LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;

    let Some(id) = id else {
        transaction.commit()?;
        return Ok(None);
    };

    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'running', attempt = attempt + 1,
             owner_id = ?2,
             lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?3),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = NULL
         WHERE id = ?1 AND status = 'pending' AND cancel_requested = 0",
        params![id, owner_id, format!("+{LEASE_SECONDS} seconds")],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {id} could not be claimed"
        )));
    }

    let job = transaction.query_row(
        "SELECT id, kind, payload, status, attempt, blocked_summary, result_path
         FROM jobs WHERE id = ?1",
        [id],
        read_job,
    )?;
    transaction.commit()?;
    Ok(Some(job))
}

pub fn mark_done(connection: &mut Connection, id: i64, attempt: i64) -> Result<()> {
    finish_done(connection, id, attempt, None)
}

pub fn mark_done_with_result_path(
    connection: &mut Connection,
    id: i64,
    attempt: i64,
    result_path: &Path,
) -> Result<()> {
    finish_done(connection, id, attempt, Some(result_path))
}

fn finish_done(
    connection: &mut Connection,
    id: i64,
    attempt: i64,
    result_path: Option<&Path>,
) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result_path = result_path.map(|path| path.to_string_lossy().into_owned());
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', result_path = COALESCE(?3, result_path),
             blocked_summary = NULL,
             owner_id = NULL, lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2
           AND cancel_requested = 0",
        params![id, attempt, result_path],
    )?;
    if changed != 1 && cancel_requested(&transaction, id)? {
        transaction.execute(
            "UPDATE jobs SET status='failed', blocked_summary='用户已取消',
             owner_id=NULL, lease_expires_at=NULL,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id=?1 AND status='running' AND attempt=?2",
            params![id, attempt],
        )?;
        transaction.commit()?;
        return Ok(());
    }
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {id} attempt {attempt} is not running"
        )));
    }
    transaction.commit()?;
    Ok(())
}

/// 确定性错误(损坏媒体等)直接进 blocked:不烧重试、清租约、写完成时间。
pub fn mark_blocked_deterministic(
    connection: &mut Connection,
    id: i64,
    attempt: i64,
    summary: &str,
) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'blocked', blocked_summary = ?3,
             owner_id = NULL, lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2",
        params![id, attempt, summary],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {id} is not running; cannot block"
        )));
    }
    transaction.commit()?;
    Ok(())
}

pub fn mark_failed(connection: &mut Connection, id: i64, summary: &str) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'failed', blocked_summary = ?2,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running'",
        params![id, summary],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {id} is not running"
        )));
    }
    transaction.commit()?;
    Ok(())
}

pub fn retry_or_block(connection: &mut Connection, id: i64) -> Result<JobStatus> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let attempt = transaction
        .query_row(
            "SELECT attempt FROM jobs WHERE id = ?1 AND status = 'failed'",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| {
            CoreError::InvalidTransition(format!("job {id} is not in failed state"))
        })?;

    let status = if attempt >= MAX_ATTEMPTS {
        transaction.execute(
            "UPDATE jobs
             SET status = 'blocked', owner_id = NULL, lease_expires_at = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND status = 'failed'",
            [id],
        )?;
        JobStatus::Blocked
    } else {
        let delay_seconds = 1_i64 << (attempt.saturating_sub(1) as u32);
        let modifier = format!("+{delay_seconds} seconds");
        transaction.execute(
            "UPDATE jobs
             SET status = 'pending', blocked_summary = NULL,
                 owner_id = NULL, lease_expires_at = NULL,
                 cancel_requested = 0, finished_at = NULL,
                 next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1 AND status = 'failed'",
            params![id, modifier],
        )?;
        JobStatus::Pending
    };

    transaction.commit()?;
    Ok(status)
}

pub fn recover_expired(connection: &mut Connection) -> Result<usize> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "UPDATE jobs SET status='failed', blocked_summary='用户已取消',
         owner_id=NULL, lease_expires_at=NULL,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE status='running' AND cancel_requested=1
           AND (lease_expires_at IS NULL
                OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        [],
    )?;
    let recovered = transaction.execute(
        "UPDATE jobs
         SET status = 'pending', blocked_summary = NULL,
             owner_id = NULL, lease_expires_at = NULL,
             next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE status = 'running' AND cancel_requested = 0
           AND (lease_expires_at IS NULL
                OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        [],
    )?;
    transaction.commit()?;
    Ok(recovered)
}

pub fn recover_running(connection: &mut Connection) -> Result<usize> {
    recover_expired(connection)
}

/// A persisted unclean-exit sentinel proves that no owner from the previous
/// process can still renew a lease, so recovery must not wait for lease expiry.
pub fn recover_after_unclean_shutdown(connection: &mut Connection) -> Result<usize> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "UPDATE jobs SET status='failed', blocked_summary='用户已取消',
         owner_id=NULL, lease_expires_at=NULL,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE status='running' AND cancel_requested=1",
        [],
    )?;
    let recovered = transaction.execute(
        "UPDATE jobs
         SET status='pending', blocked_summary=NULL,
             owner_id=NULL, lease_expires_at=NULL, cancel_requested=0,
             next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE status='running' AND cancel_requested=0",
        [],
    )?;
    transaction.commit()?;
    Ok(recovered)
}

fn cancel_requested(connection: &Connection, id: i64) -> Result<bool> {
    connection
        .query_row(
            "SELECT cancel_requested != 0 FROM jobs WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(CoreError::from)
}

fn cancellation_flags() -> &'static Mutex<CancellationMap> {
    ACTIVE_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancellation_key(connection: &Connection, job_id: i64) -> (String, i64) {
    (connection.path().unwrap_or("<memory>").to_owned(), job_id)
}

pub fn request_cancel(connection: &mut Connection, id: i64) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let status = transaction
        .query_row("SELECT status FROM jobs WHERE id=?1", [id], |row| row.get::<_, String>(0))
        .optional()?
        .ok_or_else(|| CoreError::InvalidTransition(format!("job {id} does not exist")))?;
    match status.as_str() {
        "pending" => {
            transaction.execute(
                "UPDATE jobs SET status='failed', cancel_requested=1,
                 blocked_summary='用户已取消', owner_id=NULL, lease_expires_at=NULL,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id=?1 AND status='pending'",
                [id],
            )?;
        }
        "running" => {
            transaction.execute(
                "UPDATE jobs SET cancel_requested=1,
                 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id=?1 AND status='running'",
                [id],
            )?;
        }
        _ => {
            transaction.commit()?;
            return Ok(());
        }
    }
    transaction.commit()?;
    let key = cancellation_key(connection, id);
    if let Some(flag) = cancellation_flags()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&key)
    {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

pub fn cancel_cache_jobs(connection: &mut Connection) -> Result<usize> {
    let mut statement = connection.prepare(
        "SELECT id FROM jobs
         WHERE status='running'
           AND kind IN ('thumbnail', 'waveform', 'proxy', 'clip_embed')",
    )?;
    let ids = statement
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(statement);
    for id in &ids {
        request_cancel(connection, *id)?;
    }
    Ok(ids.len())
}

fn fail_or_retry(connection: &mut Connection, job: &Job, summary: &str) -> Result<JobStatus> {
    let cancelled = cancel_requested(connection, job.id)? || summary.contains("用户已取消");
    mark_failed(
        connection,
        job.id,
        if cancelled { "用户已取消" } else { summary },
    )?;
    if cancelled {
        connection.execute(
            "UPDATE jobs SET owner_id=NULL, lease_expires_at=NULL,
             finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?1",
            [job.id],
        )?;
        Ok(JobStatus::Failed)
    } else {
        retry_or_block(connection, job.id)
    }
}

pub fn current_cancellation_requested() -> bool {
    CURRENT_CANCELLATION.with(|current| {
        current
            .borrow()
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    })
}

struct CancellationRegistration {
    key: (String, i64),
}

impl CancellationRegistration {
    fn register(connection: &Connection, job_id: i64) -> Result<Self> {
        let key = cancellation_key(connection, job_id);
        let flag = Arc::new(AtomicBool::new(cancel_requested(connection, job_id)?));
        cancellation_flags()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key.clone(), flag.clone());
        CURRENT_CANCELLATION.with(|current| *current.borrow_mut() = Some(flag));
        Ok(Self { key })
    }
}

impl Drop for CancellationRegistration {
    fn drop(&mut self) {
        CURRENT_CANCELLATION.with(|current| *current.borrow_mut() = None);
        cancellation_flags()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key);
    }
}

pub fn temporary_output_path(final_path: &Path, attempt: i64) -> PathBuf {
    let mut temporary_name: OsString = final_path.as_os_str().to_owned();
    temporary_name.push(format!(".tmp-{attempt}"));
    PathBuf::from(temporary_name)
}

pub fn complete_with_output(
    connection: &mut Connection,
    id: i64,
    attempt: i64,
    final_path: &Path,
    bytes: &[u8],
) -> Result<()> {
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let is_current_attempt = transaction
        .query_row(
            "SELECT 1 FROM jobs
             WHERE id = ?1 AND status = 'running' AND attempt = ?2",
            params![id, attempt],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !is_current_attempt {
        return Err(CoreError::InvalidTransition(format!(
            "job {id} attempt {attempt} is not running"
        )));
    }

    let temporary_path = temporary_output_path(final_path, attempt);
    let mut temporary_file = std::fs::File::create(&temporary_path)?;
    std::io::Write::write_all(&mut temporary_file, bytes)?;
    temporary_file.sync_all()?;
    drop(temporary_file);
    std::fs::rename(&temporary_path, final_path)?;

    let result_path = final_path.to_string_lossy().into_owned();
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'done', result_path = ?3, blocked_summary = NULL,
             owner_id = NULL, lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?2
           AND cancel_requested = 0",
        params![id, attempt, result_path],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {id} attempt {attempt} changed during output finalization"
        )));
    }
    transaction.commit()?;
    Ok(())
}

fn is_busy_error(error: &CoreError) -> bool {
    matches!(
        error,
        CoreError::Database(rusqlite::Error::SqliteFailure(sqlite_error, _))
            if matches!(
                sqlite_error.code,
                rusqlite::ffi::ErrorCode::DatabaseBusy
                    | rusqlite::ffi::ErrorCode::DatabaseLocked
            )
    )
}

fn with_busy_retry<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    // open_project already installs SQLite's 5-second busy timeout. These
    // retries cover a transient writer that is still present after that wait.
    let mut retries = 0;
    loop {
        match operation() {
            Err(error) if is_busy_error(&error) && retries < BUSY_RETRY_LIMIT => {
                retries += 1;
                std::thread::sleep(BUSY_RETRY_DELAY * retries as u32);
            }
            result => return result,
        }
    }
}

#[derive(Default)]
struct WorkerPoolState {
    active_regular_jobs: usize,
    export_pending: bool,
    export_active: bool,
    maintenance_active: bool,
}

#[derive(Default)]
struct WorkerPoolCoordinator {
    claim_lock: Mutex<()>,
    state: Mutex<WorkerPoolState>,
    state_changed: Condvar,
}

impl WorkerPoolCoordinator {
    #[allow(dead_code)] // 保留:池外单步调用入口,doctor/基准复用
    fn claim(self: &Arc<Self>, connection: &mut Connection) -> Result<Option<ClaimedJob>> {
        self.claim_for_owner(connection, "legacy-coordinator")
    }

    fn claim_for_owner(
        self: &Arc<Self>,
        connection: &mut Connection,
        owner_id: &str,
    ) -> Result<Option<ClaimedJob>> {
        // Serializing this short section closes the gap between claiming an export and
        // publishing its exclusive state. claim_next remains transaction-safe on its own.
        let _claim_guard = self
            .claim_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while state.maintenance_active || state.export_pending || state.export_active {
            state = self
                .state_changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        drop(state);

        let Some(job) = with_busy_retry(|| claim_next_for_owner(connection, owner_id))? else {
            return Ok(None);
        };

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let permit_kind = if job.kind == "export_package" {
            state.export_pending = true;
            while state.active_regular_jobs > 0 {
                state = self
                    .state_changed
                    .wait(state)
                    .unwrap_or_else(|error| error.into_inner());
            }
            state.export_pending = false;
            state.export_active = true;
            PermitKind::Export
        } else {
            state.active_regular_jobs += 1;
            PermitKind::Regular
        };
        drop(state);

        Ok(Some(ClaimedJob {
            job,
            _permit: ExecutionPermit {
                coordinator: self.clone(),
                kind: permit_kind,
            },
        }))
    }

    #[cfg(test)]
    fn try_begin_claim_for_test(&self) -> Option<std::sync::MutexGuard<'_, ()>> {
        match self.claim_lock.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(error)) => Some(error.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }
}

#[derive(Clone)]
pub struct WorkerControl {
    coordinator: Arc<WorkerPoolCoordinator>,
}

impl WorkerControl {
    fn new(coordinator: Arc<WorkerPoolCoordinator>) -> Self {
        Self { coordinator }
    }

    pub fn with_maintenance<T>(
        &self,
        prepare: impl FnOnce() -> Result<()>,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let _claim_guard = self
            .coordinator
            .claim_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        {
            let mut state = self
                .coordinator
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.maintenance_active = true;
        }
        if let Err(error) = prepare() {
            self.finish_maintenance();
            return Err(error);
        }
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while state.active_regular_jobs > 0 || state.export_active || state.export_pending {
            state = self
                .coordinator
                .state_changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        drop(state);
        let result = operation();
        self.finish_maintenance();
        result
    }

    fn finish_maintenance(&self) {
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.maintenance_active = false;
        drop(state);
        self.coordinator.state_changed.notify_all();
    }
}

#[derive(Clone, Copy)]
enum PermitKind {
    Regular,
    Export,
}

struct ExecutionPermit {
    coordinator: Arc<WorkerPoolCoordinator>,
    kind: PermitKind,
}

impl Drop for ExecutionPermit {
    fn drop(&mut self) {
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match self.kind {
            PermitKind::Regular => {
                debug_assert!(state.active_regular_jobs > 0);
                state.active_regular_jobs = state.active_regular_jobs.saturating_sub(1);
            }
            PermitKind::Export => state.export_active = false,
        }
        drop(state);
        self.coordinator.state_changed.notify_all();
    }
}

struct ClaimedJob {
    job: Job,
    _permit: ExecutionPermit,
}

struct LeaseHeartbeat {
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl LeaseHeartbeat {
    fn start(db_path: &Path, job: &Job, owner_id: &str) -> Self {
        let (stop, receiver) = std::sync::mpsc::channel();
        let path = db_path.to_path_buf();
        let job_id = job.id;
        let attempt = job.attempt;
        let owner = owner_id.to_owned();
        let thread = std::thread::spawn(move || loop {
            if receiver.recv_timeout(LEASE_HEARTBEAT).is_ok() {
                break;
            }
            let Ok(connection) = db::open_project(&path) else {
                continue;
            };
            let _ = connection.execute(
                "UPDATE jobs SET
                   lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?4),
                   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id=?1 AND status='running' AND attempt=?2 AND owner_id=?3",
                params![
                    job_id,
                    attempt,
                    &owner,
                    format!("+{LEASE_SECONDS} seconds")
                ],
            );
        });
        Self {
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}

impl Drop for LeaseHeartbeat {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub struct JobRunner {
    db_path: PathBuf,
    idle_delay: Duration,
    worker_count: usize,
    coordinator: Arc<WorkerPoolCoordinator>,
    owner_id: String,
}

impl JobRunner {
    pub fn new(db_path: PathBuf, worker_count: usize) -> Self {
        Self {
            db_path,
            idle_delay: Duration::from_millis(250),
            worker_count: worker_count.clamp(1, 8),
            coordinator: Arc::new(WorkerPoolCoordinator::default()),
            owner_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub fn control(&self) -> WorkerControl {
        WorkerControl::new(self.coordinator.clone())
    }

    pub fn run_one(db_path: &Path) -> Result<bool> {
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        Self::run_one_with_coordinator(db_path, &coordinator)
    }

    fn run_one_with_coordinator(
        db_path: &Path,
        coordinator: &Arc<WorkerPoolCoordinator>,
    ) -> Result<bool> {
        Self::run_one_with_owner(db_path, coordinator, "run-one")
    }

    fn run_one_with_owner(
        db_path: &Path,
        coordinator: &Arc<WorkerPoolCoordinator>,
        owner_id: &str,
    ) -> Result<bool> {
        // The connection is created inside the blocking worker iteration and is
        // never shared with another worker or moved across an execution boundary.
        let mut connection = db::open_project(db_path)?;
        recover_expired(&mut connection)?;
        let Some(claimed) = coordinator.claim_for_owner(&mut connection, owner_id)? else {
            return Ok(false);
        };
        let _cancellation = CancellationRegistration::register(&connection, claimed.job.id)?;
        let _lease = LeaseHeartbeat::start(db_path, &claimed.job, owner_id);
        Self::execute_claimed(db_path, &mut connection, &claimed.job)?;
        Ok(true)
    }

    fn execute_claimed(db_path: &Path, connection: &mut Connection, job: &Job) -> Result<()> {
        let cache_root = super::artifacts::cache_root_for_db(db_path);

        match job.kind.as_str() {
            "noop" => mark_done(connection, job.id, job.attempt)?,
            "import_probe" => {
                match super::import::run_import_probe(connection, job) {
                    Ok(super::import::ImportProbeOutcome::Imported) => {
                        mark_done(connection, job.id, job.attempt)?;
                    }
                    Ok(super::import::ImportProbeOutcome::Duplicate(path)) => {
                        mark_done_with_result_path(connection, job.id, job.attempt, &path)?;
                    }
                    Err(error) => {
                        // 确定性媒体错误(损坏/不可读)重试无意义:直接置 blocked 可见,
                        // 不占三次退避;瞬态IO错(超时)仍走重试。
                        if Self::is_deterministic_import_failure(&error) {
                            mark_blocked_deterministic(connection, job.id, job.attempt, &error.to_string())?;
                        } else {
                            fail_or_retry(connection, job, &error.to_string())?;
                        }
                    }
                }
                super::canonical_time::enqueue_align_if_ready(connection)?;
                super::story::enqueue_if_import_complete(connection)?;
            }
            "metadata_backfill" => match super::import::run_metadata_backfill(connection, job) {
                Ok(()) => {
                    mark_done(connection, job.id, job.attempt)?;
                    super::canonical_time::enqueue_align_if_ready(connection)?;
                }
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                    super::canonical_time::enqueue_align_if_ready(connection)?;
                }
            },
            "align_clocks" => match super::canonical_time::align_clocks(connection) {
                Ok(_) => mark_done(connection, job.id, job.attempt)?,
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "chapterize" => match super::story::run_chapterize_job(connection, &job.payload)
                .and_then(|()| super::shot_stack::rebuild(connection).map(|_| ()))
            {
                Ok(()) => mark_done(connection, job.id, job.attempt)?,
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "full_hash" => match super::import::run_full_hash(connection, job) {
                Ok(()) => mark_done(connection, job.id, job.attempt)?,
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "analyze_l1" => match super::analysis::run_analyze_l1(connection, job) {
                Ok(()) => {
                    mark_done(connection, job.id, job.attempt)?;
                    enqueue_dimensions_after(connection, job, &cache_root);
                }
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "analyze_motion" => match super::motion::run_analyze_motion(connection, job) {
                Ok(()) => {
                    super::asset_safety::refresh_all(connection)?;
                    mark_done(connection, job.id, job.attempt)?;
                    enqueue_dimensions_after(connection, job, &cache_root);
                }
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "transcribe" => match super::transcribe::run_transcribe(connection, job, &cache_root) {
                Ok(()) => {
                    super::asset_safety::refresh_all(connection)?;
                    enqueue_dimensions_after(connection, job, &cache_root);
                }
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "clip_embed" => match super::clip_search::run_clip_embed(connection, job) {
                Ok(()) => {
                    mark_done(connection, job.id, job.attempt)?;
                    enqueue_dimensions_after(connection, job, &cache_root);
                    super::similar::enqueue_if_ready(connection)?;
                }
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                    super::similar::enqueue_if_ready(connection)?;
                }
            },
            "classify_dims" => match super::clip_dimensions::run_classify_dims(connection, job)
                .and_then(|()| super::asset_safety::refresh_all(connection).map(|_| ()))
                .and_then(|()| super::shot_stack::rebuild(connection).map(|_| ()))
            {
                Ok(()) => mark_done(connection, job.id, job.attempt)?,
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "similar_cluster" => match super::similar::run_similar_cluster(connection, job)
                .and_then(|()| super::shot_stack::rebuild(connection).map(|_| ()))
            {
                Ok(()) => mark_done(connection, job.id, job.attempt)?,
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "narrate_episode" => match super::llm::run_narrate_episode(connection, job)
                .and_then(|()| super::asset_safety::refresh_all(connection).map(|_| ()))
                .and_then(|()| super::shot_stack::rebuild(connection).map(|_| ()))
            {
                Ok(()) => mark_done(connection, job.id, job.attempt)?,
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "export_package" => {
                if let Err(error) = super::deliver::run_export_package(connection, job) {
                    super::deliver::mark_export_failed(connection, job, &error.to_string())?;
                    if !cancel_requested(connection, job.id)? {
                        retry_or_block(connection, job.id)?;
                    }
                }
            }
            "thumbnail" | "waveform" | "proxy" => {
                match super::artifacts::run_artifact_job(connection, job, &cache_root) {
                    Ok(()) if job.kind == "waveform" => {
                        enqueue_dimensions_after(connection, job, &cache_root);
                    }
                    Ok(()) => {}
                    Err(error) => {
                        fail_or_retry(connection, job, &error.to_string())?;
                    }
                }
            }
            _ => {
                let summary = format!("unsupported job kind: {}", job.kind);
                fail_or_retry(
                    connection,
                    job,
                    &summary,
                )?;
            }
        }
        Ok(())
    }

    fn is_deterministic_import_failure(error: &CoreError) -> bool {
        let CoreError::Import(summary) = error else {
            return false;
        };
        !summary.contains("命令超过")
            && !summary.contains("timed out")
            && (summary.contains("ffprobe 失败（退出码")
                || summary.contains("文件中没有视频流")
                || summary.contains("ffprobe 输出缺少")
                || summary.contains("ffprobe VFR PTS 输出缺少")
                || summary.contains("ffprobe JSON 无效")
                || summary.contains("ffprobe VFR PTS JSON 无效")
                || summary.contains("视频流 time_base 无效")
                || summary.contains("视频流帧率无效")
                || summary.contains("视频流时长无效")
                || summary.contains("没有足够的 PTS 采样点"))
    }

    async fn run_worker(
        worker_id: usize,
        db_path: PathBuf,
        idle_delay: Duration,
        coordinator: Arc<WorkerPoolCoordinator>,
        owner_id: String,
    ) {
        loop {
            let iteration_path = db_path.clone();
            let iteration_coordinator = coordinator.clone();
            let iteration_owner = owner_id.clone();
            let result = tokio::task::spawn_blocking(move || {
                Self::run_one_with_owner(
                    &iteration_path,
                    &iteration_coordinator,
                    &iteration_owner,
                )
            })
            .await;
            match result {
                Ok(Ok(true)) => continue,
                Ok(Ok(false)) => {}
                Ok(Err(error)) => {
                    tracing::error!(worker_id, %error, "job worker iteration failed")
                }
                Err(error) => tracing::error!(worker_id, %error, "job worker task panicked"),
            }
            tokio::time::sleep(idle_delay).await;
        }
    }

    pub async fn run(self) {
        let mut workers = Vec::with_capacity(self.worker_count);
        for worker_id in 0..self.worker_count {
            workers.push(tokio::spawn(Self::run_worker(
                worker_id,
                self.db_path.clone(),
                self.idle_delay,
                self.coordinator.clone(),
                self.owner_id.clone(),
            )));
        }

        for worker in workers {
            if let Err(error) = worker.await {
                tracing::error!(%error, "job worker exited unexpectedly");
            }
        }
    }
}

fn enqueue_dimensions_after(connection: &mut Connection, job: &Job, cache_root: &Path) {
    if let Err(error) =
        super::clip_dimensions::enqueue_for_dependency_job(connection, job, cache_root)
    {
        tracing::warn!(
            clip_dependency = %job.kind,
            %error,
            "could not enqueue eight-dimension refresh"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_support::TestDirectory;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Barrier};
    use std::time::Instant;

    fn run_pool_until_empty(db_path: PathBuf, coordinator: Arc<WorkerPoolCoordinator>) {
        while JobRunner::run_one_with_coordinator(&db_path, &coordinator).unwrap() {}
    }

    fn wait_for_job_status(
        connection: &Connection,
        job_id: i64,
        expected: JobStatus,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if get(connection, job_id).unwrap().status == expected {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn two_connections_cannot_claim_the_same_job() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let job_id = {
            let mut connection = db::open_project(&db_path).unwrap();
            enqueue(&mut connection, "noop", "{}", "claim-race").unwrap()
        };
        let barrier = Arc::new(Barrier::new(3));
        let (sender, receiver) = mpsc::channel();
        let mut handles = Vec::new();

        for _ in 0..2 {
            let thread_path = db_path.clone();
            let thread_barrier = barrier.clone();
            let thread_sender = sender.clone();
            handles.push(std::thread::spawn(move || {
                let mut connection = db::open_project(&thread_path).unwrap();
                thread_barrier.wait();
                let claimed = claim_next(&mut connection).unwrap().map(|job| job.id);
                thread_sender.send(claimed).unwrap();
            }));
        }
        drop(sender);
        barrier.wait();

        let claims: Vec<Option<i64>> = receiver.iter().collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            claims
                .iter()
                .filter(|claim| **claim == Some(job_id))
                .count(),
            1
        );
        assert_eq!(claims.iter().filter(|claim| claim.is_none()).count(), 1);
    }

    #[test]
    fn four_worker_pool_completes_every_job_once() {
        const JOB_COUNT: usize = 24;

        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        {
            let mut connection = db::open_project(&db_path).unwrap();
            for index in 0..JOB_COUNT {
                enqueue(
                    &mut connection,
                    "noop",
                    "{}",
                    &format!("pool-complete-{index}"),
                )
                .unwrap();
            }
        }
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let handles: Vec<_> = (0..WORKER_COUNT)
            .map(|_| {
                let thread_path = db_path.clone();
                let thread_coordinator = coordinator.clone();
                std::thread::spawn(move || {
                    run_pool_until_empty(thread_path, thread_coordinator)
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let connection = db::open_project(&db_path).unwrap();
        let (done, attempts): (i64, i64) = connection
            .query_row(
                "SELECT COUNT(*) FILTER (WHERE status = 'done'), SUM(attempt) FROM jobs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(done, JOB_COUNT as i64);
        assert_eq!(attempts, JOB_COUNT as i64);
    }

    #[test]
    fn claimed_export_waits_for_running_work_and_blocks_new_claims() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let mut first_connection = db::open_project(&db_path).unwrap();
        let first_id = enqueue(&mut first_connection, "noop", "{}", "before-export").unwrap();
        let first_claim = coordinator.claim(&mut first_connection).unwrap().unwrap();
        assert_eq!(first_claim.job.id, first_id);

        let export_id = enqueue(
            &mut first_connection,
            "export_package",
            "{}",
            "exclusive-export",
        )
        .unwrap();
        enqueue(&mut first_connection, "noop", "{}", "after-export").unwrap();

        let (export_active_sender, export_active_receiver) = mpsc::channel();
        let (release_export_sender, release_export_receiver) = mpsc::channel();
        let export_path = db_path.clone();
        let export_coordinator = coordinator.clone();
        let export_handle = std::thread::spawn(move || {
            let mut connection = db::open_project(&export_path).unwrap();
            let claim = export_coordinator.claim(&mut connection).unwrap().unwrap();
            export_active_sender.send(claim.job.id).unwrap();
            let _ = release_export_receiver.recv_timeout(Duration::from_secs(2));
            mark_done(&mut connection, claim.job.id, claim.job.attempt).unwrap();
        });

        let export_was_claimed = wait_for_job_status(
            &first_connection,
            export_id,
            JobStatus::Running,
            Duration::from_secs(5),
        );
        let (next_claim_sender, next_claim_receiver) = mpsc::channel();
        let next_path = db_path.clone();
        let next_coordinator = coordinator.clone();
        let next_handle = std::thread::spawn(move || {
            let mut connection = db::open_project(&next_path).unwrap();
            let claim = next_coordinator.claim(&mut connection).unwrap().unwrap();
            let kind = claim.job.kind.clone();
            mark_done(&mut connection, claim.job.id, claim.job.attempt).unwrap();
            next_claim_sender.send(kind).unwrap();
        });

        mark_done(
            &mut first_connection,
            first_claim.job.id,
            first_claim.job.attempt,
        )
        .unwrap();
        drop(first_claim);
        let active_export = export_active_receiver.recv_timeout(Duration::from_secs(5)).ok();
        let premature_claim = next_claim_receiver
            .recv_timeout(Duration::from_millis(75))
            .ok();
        let _ = release_export_sender.send(());
        let next_kind = if let Some(kind) = premature_claim.clone() {
            Some(kind)
        } else {
            next_claim_receiver
                .recv_timeout(Duration::from_secs(5))
                .ok()
        };

        export_handle.join().unwrap();
        next_handle.join().unwrap();
        assert!(export_was_claimed);
        assert_eq!(active_export, Some(export_id));
        assert!(premature_claim.is_none());
        assert_eq!(next_kind.as_deref(), Some("noop"));
    }

    #[test]
    fn transient_busy_errors_are_retried_with_a_bound() {
        let calls = AtomicUsize::new(0);
        let value = with_busy_retry(|| {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            if call < 2 {
                return Err(CoreError::Database(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                    Some("injected busy".to_owned()),
                )));
            }
            Ok(42)
        })
        .unwrap();

        assert_eq!(value, 42);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn interrupted_concurrent_jobs_recover_without_loss_or_extra_attempts() {
        const JOB_COUNT: usize = 12;

        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        {
            let mut connection = db::open_project(&db_path).unwrap();
            for index in 0..JOB_COUNT {
                enqueue(
                    &mut connection,
                    "noop",
                    "{}",
                    &format!("recovery-{index}"),
                )
                .unwrap();
            }
        }
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let barrier = Arc::new(Barrier::new(WORKER_COUNT));
        let initial_handles: Vec<_> = (0..WORKER_COUNT)
            .map(|worker_id| {
                let thread_path = db_path.clone();
                let thread_coordinator = coordinator.clone();
                let thread_barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut connection = db::open_project(&thread_path).unwrap();
                    let claim = thread_coordinator.claim(&mut connection).unwrap().unwrap();
                    thread_barrier.wait();
                    let completed = worker_id % 2 == 0;
                    if completed {
                        mark_done(&mut connection, claim.job.id, claim.job.attempt).unwrap();
                    }
                    (claim.job.id, completed)
                })
            })
            .collect();
        let initial: Vec<(i64, bool)> = initial_handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();

        let interrupted_ids: Vec<i64> = initial
            .iter()
            .filter_map(|(id, completed)| (!completed).then_some(*id))
            .collect();
        let mut recovery_connection = db::open_project(&db_path).unwrap();
        recovery_connection
            .execute(
                "UPDATE jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
                 WHERE status='running'",
                [],
            )
            .unwrap();
        assert_eq!(
            recover_running(&mut recovery_connection).unwrap(),
            interrupted_ids.len()
        );
        drop(recovery_connection);

        let recovery_coordinator = Arc::new(WorkerPoolCoordinator::default());
        let recovery_handles: Vec<_> = (0..WORKER_COUNT)
            .map(|_| {
                let thread_path = db_path.clone();
                let thread_coordinator = recovery_coordinator.clone();
                std::thread::spawn(move || {
                    run_pool_until_empty(thread_path, thread_coordinator)
                })
            })
            .collect();
        for handle in recovery_handles {
            handle.join().unwrap();
        }

        let connection = db::open_project(&db_path).unwrap();
        let done: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE status = 'done'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let retried: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE attempt = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let over_retried: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE attempt > 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(done, JOB_COUNT as i64);
        assert_eq!(retried, interrupted_ids.len() as i64);
        assert_eq!(over_retried, 0);
    }

    #[test]
    fn exclusive_state_is_isolated_between_database_runners() {
        let first_directory = TestDirectory::new();
        let second_directory = TestDirectory::new();
        let first_coordinator = Arc::new(WorkerPoolCoordinator::default());
        let second_coordinator = Arc::new(WorkerPoolCoordinator::default());
        let mut first_connection = db::open_project(&first_directory.db_path()).unwrap();
        enqueue(
            &mut first_connection,
            "export_package",
            "{}",
            "isolated-export",
        )
        .unwrap();
        let export_claim = first_coordinator
            .claim(&mut first_connection)
            .unwrap()
            .unwrap();

        let second_path = second_directory.db_path();
        {
            let mut connection = db::open_project(&second_path).unwrap();
            enqueue(&mut connection, "noop", "{}", "other-database").unwrap();
        }
        let (sender, receiver) = mpsc::channel();
        let second_thread_coordinator = second_coordinator.clone();
        let handle = std::thread::spawn(move || {
            let mut connection = db::open_project(&second_path).unwrap();
            let claim = second_thread_coordinator
                .claim(&mut connection)
                .unwrap()
                .unwrap();
            let kind = claim.job.kind.clone();
            mark_done(&mut connection, claim.job.id, claim.job.attempt).unwrap();
            sender.send(kind).unwrap();
        });
        let other_kind = receiver.recv_timeout(Duration::from_secs(5)).ok();

        mark_done(
            &mut first_connection,
            export_claim.job.id,
            export_claim.job.attempt,
        )
        .unwrap();
        drop(export_claim);
        handle.join().unwrap();
        assert_eq!(other_kind.as_deref(), Some("noop"));
    }

    #[test]
    fn pending_job_is_claimed_and_completed() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(&mut connection, "noop", "{}", "hash-1").unwrap();

        let claimed = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(claimed.id, id);
        assert_eq!(claimed.status, JobStatus::Running);
        assert_eq!(claimed.attempt, 1);

        mark_done(&mut connection, id, claimed.attempt).unwrap();
        assert_eq!(get(&connection, id).unwrap().status, JobStatus::Done);
    }

    #[test]
    fn failed_job_is_requeued_with_backoff_before_attempt_three() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(&mut connection, "unknown", "{}", "hash-2").unwrap();
        claim_next(&mut connection).unwrap().unwrap();

        mark_failed(&mut connection, id, "transient failure").unwrap();
        assert_eq!(get(&connection, id).unwrap().status, JobStatus::Failed);
        assert_eq!(
            retry_or_block(&mut connection, id).unwrap(),
            JobStatus::Pending
        );

        let (status, delayed): (String, i64) = connection
            .query_row(
                "SELECT status, next_attempt_at > created_at FROM jobs WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(delayed, 1);
    }

    #[test]
    fn import_probe_timeout_is_retryable_not_deterministic_damage() {
        let timeout = CoreError::Import(
            "ffprobe 无法采样 VFR PTS clip.mov：命令超过 30 秒未完成".to_owned(),
        );

        assert!(!JobRunner::is_deterministic_import_failure(&timeout));
    }

    #[test]
    fn import_probe_invalid_container_is_deterministic_damage() {
        let damaged = CoreError::Import(
            "ffprobe 失败（退出码 1）：moov atom not found; Invalid data found".to_owned(),
        );

        assert!(JobRunner::is_deterministic_import_failure(&damaged));
    }

    #[test]
    fn third_failed_attempt_becomes_blocked_with_summary() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(&mut connection, "unknown", "{}", "hash-3").unwrap();
        connection
            .execute(
                "UPDATE jobs SET status = 'running', attempt = 3 WHERE id = ?1",
                [id],
            )
            .unwrap();

        mark_failed(&mut connection, id, "three attempts exhausted").unwrap();
        assert_eq!(
            retry_or_block(&mut connection, id).unwrap(),
            JobStatus::Blocked
        );
        let job = get(&connection, id).unwrap();
        assert_eq!(job.status, JobStatus::Blocked);
        assert_eq!(
            job.blocked_summary.as_deref(),
            Some("three attempts exhausted")
        );
    }

    #[test]
    fn restart_recovers_running_jobs_to_pending() {
        let directory = TestDirectory::new();
        let id;
        {
            let mut connection = db::open_project(&directory.db_path()).unwrap();
            id = enqueue(&mut connection, "noop", "{}", "hash-4").unwrap();
            claim_next(&mut connection).unwrap().unwrap();
        }

        let mut reopened = db::open_project(&directory.db_path()).unwrap();
        reopened
            .execute(
                "UPDATE jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
                 WHERE id=?1",
                [id],
            )
            .unwrap();
        assert_eq!(recover_running(&mut reopened).unwrap(), 1);
        let recovered = get(&reopened, id).unwrap();
        assert_eq!(recovered.status, JobStatus::Pending);
        assert_eq!(recovered.attempt, 1);
    }

    #[test]
    fn unclean_shutdown_immediately_recovers_inflight_import_before_lease_expiry() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(
            &mut connection,
            "import_probe",
            r#"{"path":"/Volumes/Card/interrupted.mov"}"#,
            "unclean-import",
        )
        .unwrap();
        let claimed = claim_next_for_owner(&mut connection, "dead-process").unwrap().unwrap();

        assert_eq!(claimed.id, id);
        assert_eq!(recover_after_unclean_shutdown(&mut connection).unwrap(), 1);
        let recovered = get(&connection, id).unwrap();
        assert_eq!(recovered.status, JobStatus::Pending);
        assert_eq!(recovered.attempt, 1);
        let lease: Option<String> = connection
            .query_row("SELECT lease_expires_at FROM jobs WHERE id=?1", [id], |row| row.get(0))
            .unwrap();
        assert!(lease.is_none());
    }

    #[test]
    fn unclean_shutdown_requeues_inflight_delivery_without_marking_it_done() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(
            &mut connection,
            "export_package",
            r#"{"dest":"/tmp/interrupted-export"}"#,
            "unclean-export",
        )
        .unwrap();
        let claimed = claim_next_for_owner(&mut connection, "dead-process").unwrap().unwrap();
        let partial = directory.path().join("delivery.tmp-1");
        std::fs::write(&partial, b"partial delivery").unwrap();

        assert_eq!(claimed.id, id);
        assert_eq!(recover_after_unclean_shutdown(&mut connection).unwrap(), 1);
        let recovered = get(&connection, id).unwrap();
        assert_eq!(recovered.status, JobStatus::Pending);
        assert_eq!(recovered.attempt, 1);
        assert!(partial.exists(), "恢复不得把部分产物误当成完成产物或静默删除证据");
    }

    #[test]
    fn output_is_written_to_attempt_file_then_atomically_renamed() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(&mut connection, "noop", "{}", "hash-5").unwrap();
        let job = claim_next(&mut connection).unwrap().unwrap();
        let final_path = directory.path().join("cache/result.bin");
        let temporary_path = temporary_output_path(&final_path, job.attempt);

        complete_with_output(
            &mut connection,
            id,
            job.attempt,
            &final_path,
            b"complete",
        )
        .unwrap();

        assert_eq!(std::fs::read(&final_path).unwrap(), b"complete");
        assert!(!temporary_path.exists());
        let finished = get(&connection, id).unwrap();
        assert_eq!(finished.status, JobStatus::Done);
        assert_eq!(
            finished.result_path.as_deref(),
            Some(final_path.to_string_lossy().as_ref())
        );
        let finished_at: Option<String> = connection
            .query_row(
                "SELECT finished_at FROM jobs WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(finished_at.is_some());
    }

    #[test]
    fn missing_partial_attempt_file_does_not_prevent_retry() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(&mut connection, "noop", "{}", "hash-retry-output").unwrap();
        let first_attempt = claim_next(&mut connection).unwrap().unwrap();
        let final_path = directory.path().join("cache/retried.bin");
        std::fs::create_dir_all(final_path.parent().unwrap()).unwrap();
        let abandoned_path = temporary_output_path(&final_path, first_attempt.attempt);
        std::fs::write(&abandoned_path, b"partial").unwrap();
        std::fs::remove_file(&abandoned_path).unwrap();

        mark_failed(&mut connection, id, "interrupted write").unwrap();
        retry_or_block(&mut connection, id).unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "UPDATE jobs
                 SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                [id],
            )
            .unwrap();
        transaction.commit().unwrap();

        let second_attempt = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(second_attempt.attempt, 2);
        complete_with_output(
            &mut connection,
            id,
            second_attempt.attempt,
            &final_path,
            b"complete after retry",
        )
        .unwrap();

        assert_eq!(
            std::fs::read(final_path).unwrap(),
            b"complete after retry"
        );
        assert_eq!(get(&connection, id).unwrap().status, JobStatus::Done);
    }

    #[test]
    fn built_in_noop_job_drives_runner_step() {
        let directory = TestDirectory::new();
        let id = {
            let mut connection = db::open_project(&directory.db_path()).unwrap();
            enqueue(&mut connection, "noop", "{}", "hash-6").unwrap()
        };

        assert!(JobRunner::run_one(&directory.db_path()).unwrap());
        let connection = db::open_project(&directory.db_path()).unwrap();
        assert_eq!(get(&connection, id).unwrap().status, JobStatus::Done);
    }

    #[test]
    fn full_hash_waits_for_import_probe_but_precedes_analysis() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let hash_id = enqueue(&mut connection, "full_hash", "{}", "hash-before-analysis").unwrap();
        let import_id = enqueue(&mut connection, "import_probe", "{}", "import-first").unwrap();
        enqueue(&mut connection, "analyze_l1", "{}", "analysis-after-hash").unwrap();

        let first = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(first.id, import_id);
        mark_done(&mut connection, first.id, first.attempt).unwrap();
        let second = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(second.id, hash_id);
        assert_eq!(second.kind, "full_hash");
    }

    #[test]
    fn full_hash_is_claimed_before_analyze_l1() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "full_hash", "{}", "hash-last").unwrap();
        enqueue(&mut connection, "analyze_l1", "{}", "analysis-second").unwrap();

        let claimed = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(claimed.kind, "full_hash");
    }

    #[test]
    fn motion_is_claimed_after_l1_and_before_clip_embedding() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "clip_embed", "{}", "embedding-later").unwrap();
        let motion_id = enqueue(&mut connection, "analyze_motion", "{}", "motion-middle").unwrap();
        let analysis_id = enqueue(&mut connection, "analyze_l1", "{}", "analysis-first").unwrap();

        let first = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(first.id, analysis_id);
        mark_done(&mut connection, first.id, first.attempt).unwrap();
        let second = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(second.id, motion_id);
    }

    #[test]
    fn artifact_jobs_are_claimed_in_thumbnail_waveform_proxy_order() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "proxy", "{}", "proxy-priority").unwrap();
        enqueue(&mut connection, "waveform", "{}", "waveform-priority").unwrap();
        enqueue(&mut connection, "thumbnail", "{}", "thumbnail-priority").unwrap();

        let first = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(first.kind, "thumbnail");
        mark_done(&mut connection, first.id, first.attempt).unwrap();
        let second = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(second.kind, "waveform");
        mark_done(&mut connection, second.id, second.attempt).unwrap();
        let third = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(third.kind, "proxy");
    }

    #[test]
    fn dimension_classification_is_priority_22_between_embedding_and_waveform() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "waveform", "{}", "waveform-later").unwrap();
        enqueue(&mut connection, "classify_dims", "{}", "dimensions-middle").unwrap();
        enqueue(&mut connection, "clip_embed", "{}", "embedding-first").unwrap();

        let first = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(first.kind, "clip_embed");
        mark_done(&mut connection, first.id, first.attempt).unwrap();
        let second = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(second.kind, "classify_dims");
        mark_done(&mut connection, second.id, second.attempt).unwrap();
        assert_eq!(claim_next(&mut connection).unwrap().unwrap().kind, "waveform");
    }

    #[test]
    fn transcribe_is_claimed_between_waveform_and_proxy() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "proxy", "{}", "proxy-after-transcribe").unwrap();
        enqueue(&mut connection, "transcribe", "{}", "transcribe-priority").unwrap();
        enqueue(&mut connection, "waveform", "{}", "waveform-before-transcribe").unwrap();

        let first = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(first.kind, "waveform");
        mark_done(&mut connection, first.id, first.attempt).unwrap();
        let second = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(second.kind, "transcribe");
        mark_done(&mut connection, second.id, second.attempt).unwrap();
        let third = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(third.kind, "proxy");
    }

    #[test]
    fn deterministic_block_requires_matching_attempt_cas() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "import_probe", "{}", "cas-probe").unwrap();
        let job = claim_next(&mut connection).unwrap().unwrap();
        // 过期 attempt 必须拒绝(CAS 失败)
        assert!(mark_blocked_deterministic(&mut connection, job.id, job.attempt + 1, "stale").is_err());
        // 当前 attempt 成功且 finished_at/租约清空
        mark_blocked_deterministic(&mut connection, job.id, job.attempt, "确定性损坏").unwrap();
        let (status, finished, owner): (String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT status, finished_at, owner_id FROM jobs WHERE id = ?1",
                [job.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "blocked");
        assert!(finished.is_some());
        assert!(owner.is_none());
    }

    #[test]
    fn import_probe_is_not_blocked_behind_a_long_proxy_encode() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "proxy", "{}", "proxy-before-import").unwrap();
        enqueue(&mut connection, "import_probe", "{}", "import-after-proxy").unwrap();

        let claimed = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(claimed.kind, "import_probe");
    }

    #[test]
    fn recovery_reclaims_only_expired_leases() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let expired = enqueue(&mut connection, "noop", "{}", "expired-lease").unwrap();
        let live = enqueue(&mut connection, "noop", "{}", "live-lease").unwrap();
        connection
            .execute(
                "UPDATE jobs SET status='running', attempt=1, owner_id='old',
                 lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
                 WHERE id=?1",
                [expired],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE jobs SET status='running', attempt=1, owner_id='live',
                 lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour')
                 WHERE id=?1",
                [live],
            )
            .unwrap();

        assert_eq!(recover_expired(&mut connection).unwrap(), 1);
        assert_eq!(get(&connection, expired).unwrap().status, JobStatus::Pending);
        assert_eq!(get(&connection, live).unwrap().status, JobStatus::Running);
    }

    #[test]
    fn import_and_export_failures_share_the_three_attempt_block_rule() {
        for (kind, payload, hash) in [
            ("import_probe", "{broken", "retry-import"),
            (
                "export_package",
                r#"{"version":3,"destination":"/definitely-missing-tripcut-destination","project_name":"test","date":"2026-09-01","selected_bytes":0,"clips":[],"progress":{"stage":"queued","completed_items":0,"failed_items":0,"cancel_requested":false,"message":null,"items":[]},"output_path":null}"#,
                "retry-export",
            ),
        ] {
            let directory = TestDirectory::new();
            let db_path = directory.db_path();
            let mut connection = db::open_project(&db_path).unwrap();
            let id = enqueue(&mut connection, kind, payload, hash).unwrap();
            connection
                .execute(
                    "UPDATE jobs SET status='pending', attempt=2,
                     next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?1",
                    [id],
                )
                .unwrap();

            JobRunner::run_one(&db_path).unwrap();

            assert_eq!(get(&connection, id).unwrap().status, JobStatus::Blocked, "{kind}");
        }
    }

    #[test]
    fn persistent_cancel_prevents_claim_and_never_retries() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(&mut connection, "import_probe", "{}", "cancel-import").unwrap();

        request_cancel(&mut connection, id).unwrap();

        assert!(claim_next(&mut connection).unwrap().is_none());
        let job = get(&connection, id).unwrap();
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.blocked_summary.as_deref(), Some("用户已取消"));
    }

    #[test]
    fn maintenance_barrier_blocks_claims_until_rebuild_finishes() {
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let control = WorkerControl::new(coordinator.clone());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let thread_control = control.clone();
        let handle = std::thread::spawn(move || {
            thread_control
                .with_maintenance(
                    || Ok(()),
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                        Ok(())
                    },
                )
                .unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        assert!(coordinator.try_begin_claim_for_test().is_none());
        release_tx.send(()).unwrap();
        handle.join().unwrap();
        assert!(coordinator.try_begin_claim_for_test().is_some());
    }
}
