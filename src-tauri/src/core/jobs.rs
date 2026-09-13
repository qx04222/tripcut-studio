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

/// R6 Task 4:交付/批量分析完成通知出口的类型——`(标题, 正文)`,返回是否
/// 投递成功。调用点(`notify_on_completion`)把它包进 `std::thread::spawn`
/// 做成 fire-and-forget:它是在持有数据库连接和任务租约的 `spawn_blocking`
/// worker 线程上被触发的,不能同步等一个可能很慢的系统通知服务占住 worker
/// 槽位。
type NotificationFn = dyn Fn(&str, &str) -> bool + Send + Sync;
/// R10 U-25:「第一个后台任务开始了」的一次性钩子。Tauri 层用它在固定时机把 macOS
/// 通知权限弹框引出来(发一条「已开始后台处理」的系统通知——桌面端插件的
/// `request_permission` 是空实现,只有第一次 `show()` 才真弹框),而不是等到
/// 几分钟后某条分析完成时突然弹。进程生命周期内只调一次。
type FirstJobFn = dyn Fn() + Send + Sync;
/// R10 U-19:任务落地后发给前端的应用内事件出口 (事件名, JSON 负载)。Tauri 层接
/// `app.emit`;测试接一个收集器;没接时静默跳过。与系统通知(`NotificationFn`)
/// 分开:前端刷新用的事件不该依赖用户有没有开通知权限。
type EventSinkFn = dyn Fn(&str, serde_json::Value) + Send + Sync;

// M5 benchmark reconciliation showed that four concurrent workers move the
// 500-item workload from roughly 100 minutes into the 10-minute range.
pub const WORKER_COUNT: usize = super::settings::DEFAULT_WORKER_COUNT;

const BUSY_RETRY_LIMIT: usize = 3;
const BUSY_RETRY_DELAY: Duration = Duration::from_millis(25);
const LEASE_SECONDS: i64 = 30;
const LEASE_HEARTBEAT: Duration = Duration::from_secs(10);
const MEMORY_POLL_INTERVAL: Duration = Duration::from_secs(5);
const SIDECAR_IDLE_POLL_INTERVAL: Duration = Duration::from_secs(30);
const SIDECAR_IDLE_THRESHOLD: Duration = Duration::from_secs(60);

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

/// 资源类:同一类内的并发受许可约束(P5)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResourceClass {
    /// 解码密集:占用视频解码器与大块像素缓冲。
    Decode,
    /// 大模型推理:占用统一内存里的权重。
    HeavyModel,
    /// 其余任务:只受总 worker 数约束。
    Light,
}

pub(crate) fn resource_class(kind: &str) -> ResourceClass {
    match kind {
        "thumbnail" | "strip" | "analyze_l1" | "analyze_motion" | "proxy" | "music_analyze"
        | "moments" => ResourceClass::Decode,
        "clip_embed" | "classify_dims" | "transcribe" => ResourceClass::HeavyModel,
        _ => ResourceClass::Light,
    }
}

/// SQL 字面量:与 `resource_class` 的 Decode 分支必须逐字一致。
pub(crate) const DECODE_KINDS_SQL: &str =
    "('thumbnail','strip','analyze_l1','analyze_motion','proxy','music_analyze','moments')";
/// SQL 字面量:与 `resource_class` 的 HeavyModel 分支必须逐字一致。
pub(crate) const HEAVY_KINDS_SQL: &str = "('clip_embed','classify_dims','transcribe')";

/// 大模型类同时只允许一个任务在跑。
const HEAVY_MODEL_LIMIT: usize = 1;
/// 解码许可数的兜底值(未经 `with_decode_limit` 接线时使用)。
const DEFAULT_DECODE_LIMIT: usize = 4;
/// 内存压力恢复阈值:暂停后必须回到该百分比才恢复认领(滞回)。
const RESUME_ABOVE_PERCENT: u32 = 25;

/// 内存压力暂停的滞回判定,纯函数以便单测。
pub(crate) fn next_pause_state(paused: bool, percent: u32) -> bool {
    if paused {
        percent < RESUME_ABOVE_PERCENT
    } else {
        percent < super::memory_profile::PAUSE_BELOW_PERCENT
    }
}

/// R7 Task 5:补镜结果需要在 `generation_poll` 自己这次执行里,同步跑完它
/// 刚入队的那一个 `import_probe`——不等常规 worker 轮到它,否则
/// `generation_requests` 拿不到 `result_clip_id`。只转移这一个指定 id 的
/// pending→running,不走 `claim_next_for_owner_excluding` 的优先级/资源类
/// 挑选(调用方已经确定就是这一个 job,不需要再选)。
pub(crate) fn claim_specific_pending_job(connection: &mut Connection, id: i64) -> Result<Job> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'running', attempt = attempt + 1,
             owner_id = 'generation-poll-inline',
             lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+300 seconds'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = NULL
         WHERE id = ?1 AND status = 'pending'",
        params![id],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {id} could not be claimed for inline execution"
        )));
    }
    let job = transaction.query_row(
        "SELECT id, kind, payload, status, attempt, blocked_summary, result_path
         FROM jobs WHERE id = ?1",
        [id],
        read_job,
    )?;
    transaction.commit()?;
    Ok(job)
}

pub fn claim_next(connection: &mut Connection) -> Result<Option<Job>> {
    claim_next_for_owner(connection, "legacy-worker")
}

pub fn claim_next_for_owner(connection: &mut Connection, owner_id: &str) -> Result<Option<Job>> {
    claim_next_for_owner_excluding(connection, owner_id, false, false)
}

/// 认领下一个任务,并排除已饱和的资源类;解码类另外按 `clip_id` 串行——
/// 同一素材上已有解码任务在跑时,它的其它解码任务不可认领。
pub fn claim_next_for_owner_excluding(
    connection: &mut Connection,
    owner_id: &str,
    exclude_decode: bool,
    exclude_heavy: bool,
) -> Result<Option<Job>> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let select_sql = format!(
        "SELECT id FROM jobs
             WHERE status = 'pending'
               AND cancel_requested = 0
               AND COALESCE(next_attempt_at, created_at)
                   <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               AND (?1 = 0 OR kind NOT IN {DECODE_KINDS_SQL})
               AND (?2 = 0 OR kind NOT IN {HEAVY_KINDS_SQL})
               AND NOT (
                     kind IN {DECODE_KINDS_SQL}
                     AND json_valid(jobs.payload)
                     AND EXISTS (
                       SELECT 1 FROM jobs running_decode
                       WHERE running_decode.status = 'running'
                         AND running_decode.kind IN {DECODE_KINDS_SQL}
                         AND json_valid(running_decode.payload)
                         AND json_extract(running_decode.payload, '$.clip_id')
                             = json_extract(jobs.payload, '$.clip_id')))
             ORDER BY CASE kind
                        WHEN 'export_package' THEN 100
                        WHEN 'import_probe' THEN 60
                        WHEN 'metadata_backfill' THEN 57
                        WHEN 'align_clocks' THEN 56
                        WHEN 'chapterize' THEN 55
                        WHEN 'thumbnail' THEN 40
                        WHEN 'strip' THEN 39
                        WHEN 'analyze_l1' THEN 30
                        WHEN 'analyze_motion' THEN 28
                        WHEN 'moments' THEN 27
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
             LIMIT 1"
    );
    let id = transaction
        .query_row(
            &select_sql,
            params![i64::from(exclude_decode), i64::from(exclude_heavy)],
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

pub fn mark_failed(connection: &mut Connection, id: i64, attempt: i64, summary: &str) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "UPDATE jobs
         SET status = 'failed', blocked_summary = ?2,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?1 AND status = 'running' AND attempt = ?3",
        params![id, summary, attempt],
    )?;
    if changed != 1 {
        return Err(CoreError::InvalidTransition(format!(
            "job {id} is not running"
        )));
    }
    transaction.commit()?;
    Ok(())
}

pub fn retry_or_block(connection: &mut Connection, id: i64, expected_attempt: i64) -> Result<JobStatus> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let attempt = transaction
        .query_row(
            "SELECT attempt FROM jobs WHERE id = ?1 AND status = 'failed' AND attempt = ?2 AND cancel_requested = 0",
            params![id, expected_attempt],
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
        // `UPDATE OR IGNORE`: migration 0036 的部分唯一索引会在这条 failed 行改回
        // pending 时与一条同 (kind,payload_hash) 的既有 pending/running 行相撞
        // (ocr.rs:396 允许失败后再排一条)。撞上时应静默丢弃这次重试,而不是让
        // 整条命令报 UNIQUE constraint failed 崩出去。
        transaction.execute(
            "UPDATE OR IGNORE jobs
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
    // `UPDATE OR IGNORE`: 这是一条批量 UPDATE,覆盖本轮所有到期租约。若其中一条
    // (通常是 ocr_scan)撞上 migration 0036 的部分唯一索引,SQLite 对
    // `OR IGNORE` 的处理是只丢弃那一行、继续处理批次里的其它行,而不是让整条
    // UPDATE 报 UNIQUE constraint failed 并回滚本轮全部回收。
    let recovered = transaction.execute(
        "UPDATE OR IGNORE jobs
         SET status = 'pending', blocked_summary = NULL,
             owner_id = NULL, lease_expires_at = NULL,
             next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE status = 'running' AND cancel_requested = 0
           AND (lease_expires_at IS NULL
                OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        [],
    )?;
    // 被 OR IGNORE 跳过的行仍然停在 running 状态、租约已过期、owner 是旧 owner——
    // 它们既不会被再次认领(owner 校验会挡住),也不会悄悄提升成撞车的 pending。
    // 把它们标记为 failed,让它们退出"卡死的 running"状态,便于重试/告警路径处理,
    // 而不是无限期占用一个已经不存在的 owner。
    let dropped = transaction.execute(
        "UPDATE jobs SET status = 'failed',
             blocked_summary = '租约过期回收时与既有任务冲突(kind+payload_hash 重复)',
             owner_id = NULL, lease_expires_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE status = 'running' AND cancel_requested = 0
           AND (lease_expires_at IS NULL
                OR lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        [],
    )?;
    transaction.commit()?;
    Ok(recovered + dropped)
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
    // Failure, cancellation and retry are one attempt-scoped transition. A
    // worker whose lease was reclaimed must never change its successor's state.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let cancelled = transaction.query_row(
        "SELECT cancel_requested != 0 FROM jobs
         WHERE id=?1 AND attempt=?2 AND status='running'",
        params![job.id, job.attempt], |row| row.get::<_, bool>(0),
    ).optional()?.ok_or_else(|| CoreError::InvalidTransition(format!(
        "job {} attempt {} is no longer running", job.id, job.attempt
    )))? || summary.contains("用户已取消");
    let status = if cancelled { JobStatus::Failed }
        else if job.attempt >= MAX_ATTEMPTS { JobStatus::Blocked }
        else { JobStatus::Pending };
    let message = if cancelled { Some("用户已取消") }
        else if status == JobStatus::Blocked { Some(summary) }
        else { None };
    let delay = 1_i64 << job.attempt.saturating_sub(1).min(30) as u32;
    transaction.execute(
        "UPDATE jobs SET status=?3, blocked_summary=?4, owner_id=NULL,
         lease_expires_at=NULL, cancel_requested=?5,
         next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?6),
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         finished_at=CASE WHEN ?3='pending' THEN NULL
                    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
         WHERE id=?1 AND attempt=?2 AND status='running'",
        params![job.id, job.attempt, status.as_str(), message, cancelled,
                format!("+{delay} seconds")],
    )?;
    transaction.commit()?;
    Ok(status)
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

struct WorkerPoolState {
    active_regular_jobs: usize,
    export_pending: bool,
    export_active: bool,
    maintenance_active: bool,
    active_decode: usize,
    active_heavy: usize,
    decode_limit: usize,
    paused_for_memory: bool,
}

impl Default for WorkerPoolState {
    fn default() -> Self {
        Self {
            active_regular_jobs: 0,
            export_pending: false,
            export_active: false,
            maintenance_active: false,
            active_decode: 0,
            active_heavy: 0,
            decode_limit: DEFAULT_DECODE_LIMIT,
            paused_for_memory: false,
        }
    }
}

#[derive(Default)]
struct WorkerPoolCoordinator {
    claim_lock: Mutex<()>,
    state: Mutex<WorkerPoolState>,
    state_changed: Condvar,
    /// R6 Task 4:睡眠唤醒后用来把还在 `idle_delay` 里睡觉的 worker 提前叫醒,
    /// 别等满 250ms 才发现刚恢复的过期租约。`notify_waiters` 对没人在等的
    /// 情况是无操作,所以清醒时调用也无害。
    wake: tokio::sync::Notify,
    /// R6 Task 4:交付/批量分析完成的通知出口,由 Tauri 层在启动时接线一次
    /// (`JobRunner::with_notifier`)。测试环境不设置时保持 `None`,
    /// `run_one_with_executor` 里的完成检测直接跳过,不产生任何副作用。
    notifier: OnceLock<Arc<NotificationFn>>,
    /// R10 U-19:应用内事件出口(`JobRunner::with_event_sink`),见 `EventSinkFn`。
    event_sink: OnceLock<Arc<EventSinkFn>>,
    /// R10 U-25:首个后台任务开始时的一次性钩子(`JobRunner::with_first_job_hook`)。
    first_job_hook: OnceLock<Arc<FirstJobFn>>,
    /// `first_job_hook` 只放行一次的闸(`Once` 没有 `Default`,用 `OnceLock<()>` 代替)。
    first_job_once: OnceLock<()>,
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
        // 内存压力暂停期间只挡解码与大模型两类;Light 类(export_package、waveform 等)
        // 照常认领——导出不吃解码器也不吃模型权重,把它一起挡住会让内存一紧就无声卡死。
        let (exclude_decode, exclude_heavy) = if state.paused_for_memory {
            (true, true)
        } else {
            (
                state.active_decode >= state.decode_limit,
                state.active_heavy >= HEAVY_MODEL_LIMIT,
            )
        };
        drop(state);

        let Some(job) = with_busy_retry(|| {
            claim_next_for_owner_excluding(connection, owner_id, exclude_decode, exclude_heavy)
        })?
        else {
            return Ok(None);
        };

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let class = resource_class(&job.kind);
        match class {
            ResourceClass::Decode => state.active_decode += 1,
            ResourceClass::HeavyModel => state.active_heavy += 1,
            ResourceClass::Light => {}
        }
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
                class,
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

    /// 解码许可数(由内存档位决定),启动接线时设置一次。
    pub fn set_decode_limit(&self, limit: usize) {
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.decode_limit = limit.max(1);
        drop(state);
        self.coordinator.state_changed.notify_all();
    }

    /// 当前在跑的解码类任务数。
    pub fn active_decode(&self) -> usize {
        let state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.active_decode
    }

    /// 解码类是否已经吃满许可——前端「等待解码许可」的判据。
    pub fn decode_saturated(&self) -> bool {
        let state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.active_decode >= state.decode_limit
    }

    /// R6 Task 4:睡眠唤醒后叫醒还在 idle 轮询里睡觉的 worker,让它立刻重新
    /// 认领一次而不是等满 `idle_delay`。谁都没在等时是无操作。
    pub fn wake_worker(&self) {
        self.coordinator.wake.notify_waiters();
    }

    /// 当前是否因内存压力暂停认领。
    pub fn pause_state(&self) -> bool {
        let state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.paused_for_memory
    }

    fn set_paused_for_memory(&self, paused: bool) {
        let mut state = self
            .coordinator
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.paused_for_memory = paused;
        drop(state);
        self.coordinator.state_changed.notify_all();
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
    class: ResourceClass,
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
        match self.class {
            ResourceClass::Decode => {
                debug_assert!(state.active_decode > 0);
                state.active_decode = state.active_decode.saturating_sub(1);
            }
            ResourceClass::HeavyModel => {
                debug_assert!(state.active_heavy > 0);
                state.active_heavy = state.active_heavy.saturating_sub(1);
            }
            ResourceClass::Light => {}
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

    /// 按内存档位接线解码类许可数(`MemoryProfile::decode_permits`)。
    pub fn with_decode_limit(self, limit: usize) -> Self {
        self.control().set_decode_limit(limit);
        self
    }

    /// R6 Task 4:接一个通知出口——交付完成、批量分析完成时,worker 会带着
    /// (标题, 正文) 调它。Tauri 层接的是绑定了 `AppHandle` 的
    /// `notify::post` 闭包;测试/`run_one` 一次性入口不接,`OnceLock` 保持
    /// 空,完成检测直接跳过。只能接一次——第二次调用是无操作,这与「进程
    /// 生命周期内只有一套 worker 池」的前提一致。
    pub fn with_notifier(self, notifier: Arc<NotificationFn>) -> Self {
        let _ = self.coordinator.notifier.set(notifier);
        self
    }

    /// R10 U-19:接应用内事件出口(音乐分析完成等),只能接一次,规则同 `with_notifier`。
    pub fn with_event_sink(self, sink: Arc<EventSinkFn>) -> Self {
        let _ = self.coordinator.event_sink.set(sink);
        self
    }

    /// R10 U-25:接「首个后台任务开始」钩子,只能接一次;worker 认领到第一条任务时
    /// 在独立线程调它恰好一次(见 `FirstJobFn`)。
    pub fn with_first_job_hook(self, hook: Arc<FirstJobFn>) -> Self {
        let _ = self.coordinator.first_job_hook.set(hook);
        self
    }

    pub fn run_one(db_path: &Path) -> Result<bool> {
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        Self::run_one_with_coordinator(db_path, &coordinator)
    }

    /// F-R1-9:非 tokio 调用方(perf 装置)按 self 持有的**同一个**协调器认领
    /// 并执行一步——与 `run()` 里每个 worker 调的是同一条路径
    /// (`run_one_with_owner`),因此吃同一份解码/大模型许可与内存暂停状态。
    /// 不同于 `run_one()`:后者每次调用都新建一个空协调器,许可与暂停状态
    /// 从不跨调用累积,等于完全绕开了协调器——那正是 perf 装置此前的 bug。
    ///
    /// 把这一步真正认领并跑完的 job kind 带出来——
    /// 不需要调用方再另开一条连接去猜"最近完成的是哪条"(`ORDER BY
    /// finished_at DESC LIMIT 1`那条路径在多个 worker 几毫秒内先后收尾时
    /// 会被撞车重复读到同一行,把 strip/ocr_scan 这类几毫秒就跑完的任务
    /// 计成两次以上)。`Ok(None)` 表示这一步没能认领到任何 job。
    pub fn run_one_step_with_kind(&self) -> Result<Option<String>> {
        Self::run_one_with_executor_kind(&self.db_path, &self.coordinator, &self.owner_id, Self::execute_claimed)
    }

    /// F-R1-9:内存压力单拍轮询,供不跑 tokio 事件循环的调用方使用——与
    /// `watch_memory_pressure` 的 5 秒循环调的是同一个 `poll_memory_pressure_once`,
    /// 只是由调用方自己决定节奏(perf 装置在自己的采样循环里敲拍)。
    pub fn poll_memory_pressure(&self) {
        poll_memory_pressure_once(&self.coordinator);
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
        Self::run_one_with_executor(db_path, coordinator, owner_id, Self::execute_claimed)
    }

    /// 认领一步 + 执行一步。执行部分是参数,测试用假执行器(睡一会儿再 mark_done)
    /// 就能在不跑真解码的前提下观察许可上限。
    fn run_one_with_executor(
        db_path: &Path,
        coordinator: &Arc<WorkerPoolCoordinator>,
        owner_id: &str,
        execute: impl FnOnce(&Path, &mut Connection, &Job) -> Result<()>,
    ) -> Result<bool> {
        Self::run_one_with_executor_kind(db_path, coordinator, owner_id, execute).map(|kind| kind.is_some())
    }

    /// 同 `run_one_with_executor`,多返回一份"认领到的是哪个 kind"——
    /// `run_one_step_with_kind` 靠它把 kind 直接带给调用方,不用再另开
    /// 连接去猜。
    fn run_one_with_executor_kind(
        db_path: &Path,
        coordinator: &Arc<WorkerPoolCoordinator>,
        owner_id: &str,
        execute: impl FnOnce(&Path, &mut Connection, &Job) -> Result<()>,
    ) -> Result<Option<String>> {
        // The connection is created inside the blocking worker iteration and is
        // never shared with another worker or moved across an execution boundary.
        let mut connection = db::open_project(db_path)?;
        recover_expired(&mut connection)?;
        let Some(claimed) = coordinator.claim_for_owner(&mut connection, owner_id)? else {
            return Ok(None);
        };
        let _cancellation = CancellationRegistration::register(&connection, claimed.job.id)?;
        let _lease = LeaseHeartbeat::start(db_path, &claimed.job, owner_id);
        let kind = claimed.job.kind.clone();
        Self::fire_first_job_hook(coordinator);
        execute(db_path, &mut connection, &claimed.job)?;
        Self::notify_on_completion(coordinator, &connection, &claimed.job);
        Self::emit_on_completion(coordinator, &connection, &claimed.job);
        Ok(Some(kind))
    }

    /// R10 U-25:进程内第一条任务被认领时调一次钩子(fire-and-forget,不占 worker 线程);
    /// 没接钩子(测试 / `run_one`)什么都不做,之后的任务也不再进来。
    fn fire_first_job_hook(coordinator: &Arc<WorkerPoolCoordinator>) {
        coordinator.first_job_once.get_or_init(|| {
            if let Some(hook) = coordinator.first_job_hook.get() {
                let hook = hook.clone();
                std::thread::spawn(move || hook());
            }
        });
    }

    /// R10 U-19:`execute()` 落地之后,把需要前端立刻刷新的终态以应用内事件发出去。
    /// 目前只有音乐分析(`tripcut:music-analyzed`);检测失败只记日志,不影响任务结果。
    /// 投递同样 fire-and-forget(`app.emit` 走 IPC,不占 worker 线程)。
    fn emit_on_completion(coordinator: &Arc<WorkerPoolCoordinator>, connection: &Connection, job: &Job) {
        let Some(sink) = coordinator.event_sink.get() else {
            return;
        };
        match super::music::analyzed_event(connection, job) {
            Ok(Some(event)) => {
                let payload = match serde_json::to_value(&event) {
                    Ok(payload) => payload,
                    Err(error) => {
                        tracing::warn!(%error, job_id = job.id, "音乐分析事件序列化失败");
                        return;
                    }
                };
                let sink = sink.clone();
                std::thread::spawn(move || sink(super::music::MUSIC_ANALYZED_EVENT, payload));
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, job_id = job.id, "音乐分析完成事件检测失败"),
        }
    }

    /// R6 Task 4:`execute()` 落地之后重新读一次这条 job——交付包成功、或
    /// 某个导入批次的分析队列刚好排空,就把 (标题, 正文) 递给接线好的通知
    /// 出口。没接通知出口(测试、`run_one` 一次性入口)时提前退出,不碰库。
    /// 检测函数本身返回 `Err` 不会拖垮这次成功的任务执行——只记日志。
    ///
    /// 投递本身用 `std::thread::spawn` 做成 fire-and-forget:这里是在
    /// `run_one_with_executor` 内部,`connection`(数据库连接)和调用方持有
    /// 的任务租约都还活着,决不能在这条 worker 线程上同步等一个可能很慢的
    /// 系统通知服务——那会把这个 worker 槽白占住,直到通知服务响应。
    ///
    /// 批量分析批次的「已通知」去重标记只在 `notifier` 真的返回成功之后才
    /// 落(`import::mark_batch_analysis_notified`);在那之前只是「检测到刚
    /// 排空」,还没有确认送达。
    fn notify_on_completion(coordinator: &Arc<WorkerPoolCoordinator>, connection: &Connection, job: &Job) {
        let Some(notifier) = coordinator.notifier.get() else {
            return;
        };
        let db_key = connection.path().unwrap_or("<memory>").to_owned();
        let export_event = match super::deliver::export_completion_notice(connection, job) {
            Ok(found) => found,
            Err(error) => {
                tracing::warn!(%error, job_id = job.id, "交付完成通知检测失败");
                None
            }
        };
        if let Some((title, body)) = export_event {
            let notifier = notifier.clone();
            std::thread::spawn(move || {
                notifier(&title, &body);
            });
            return;
        }
        let batch_event = match super::import::batch_analysis_completion_notice(&db_key, connection, job) {
            Ok(found) => found,
            Err(error) => {
                tracing::warn!(%error, job_id = job.id, "批量分析完成通知检测失败");
                None
            }
        };
        if let Some((batch_id, title, body)) = batch_event {
            let notifier = notifier.clone();
            std::thread::spawn(move || {
                if notifier(&title, &body) {
                    super::import::mark_batch_analysis_notified(&db_key, batch_id);
                }
            });
            return;
        }
        // R7 Task 5:这条只在 `run_poll_job` 真的把请求推进到 `imported` 的
        // 那一次 `execute()` 调用里返回 `Some`——那次调用同时把 job 标成
        // `done`,之后这个 job 不会再被认领、`execute()` 不会再跑第二次,
        // 所以天然「恰好一次」,不需要像批量分析那样另开一个「已通知」
        // 去重集合。
        let generation_event = match super::generation::completion_notice(connection, job) {
            Ok(found) => found,
            Err(error) => {
                tracing::warn!(%error, job_id = job.id, "补镜完成通知检测失败");
                None
            }
        };
        if let Some((title, body)) = generation_event {
            let notifier = notifier.clone();
            std::thread::spawn(move || {
                notifier(&title, &body);
            });
        }
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
            // R11:老库「补齐时刻分」。失败走常规退避重试;不碰 clip_analysis。
            "moments" => match super::moments::run_moments_job(connection, job) {
                Ok(()) => mark_done(connection, job.id, job.attempt)?,
                Err(error) => {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            },
            "transcribe" => match super::transcribe::run_transcribe(connection, job, &cache_root) {
                Ok(()) => {
                    super::asset_safety::refresh_all(connection)?;
                    enqueue_dimensions_after(connection, job, &cache_root);
                    // R11:有了转写就用它覆盖时刻分的「有人声」判定。
                    if let Some(clip_id) = serde_json::from_str::<serde_json::Value>(&job.payload)
                        .ok()
                        .and_then(|payload| payload.get("clip_id").and_then(serde_json::Value::as_i64))
                    {
                        if let Err(error) = super::moments::refresh_speech_from_transcript(connection, clip_id) {
                            tracing::warn!(%error, clip_id, "转写后重打「有人声」失败,时刻分保持原样");
                        }
                    }
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
                        retry_or_block(connection, job.id, job.attempt)?;
                    }
                }
            }
            "music_analyze" => {
                if let Err(error) = super::music::run_music_analyze(connection, job) {
                    fail_or_retry(connection, job, &error.to_string())?;
                }
            }
            // R7 Task 5:`generation_poll` 管自己的收尾——`run_poll_job`
            // 内部按结果分别 `mark_done`(成功/终态失败)或直接改写 jobs 行
            // 重排下一次退避(仍在排队/生成中),不走这里通用的
            // `fail_or_retry`(那套重试上限/退避节奏是给别的 job kind 用的,
            // `generation_poll` 有自己的 10s→…→300s / 2 小时上限,详见
            // `generation::backoff_delay_seconds`/`requeue_or_timeout`)。
            "generation_poll" => {
                let project_root = db_path.parent().unwrap_or_else(|| Path::new("."));
                super::generation::run_poll_job(connection, job, project_root)?;
            }
            "thumbnail" | "strip" | "waveform" | "proxy" => {
                match super::artifacts::run_artifact_job(connection, job, &cache_root) {
                    Ok(()) if job.kind == "waveform" => {
                        enqueue_dimensions_after(connection, job, &cache_root);
                    }
                    // R6 Task 7d/F-R1-8:封面(thumbnail)先行,胶片条(strip)
                    // 随后单独跑。OCR 是在胶片条格子上裁切的,只有 strip 落
                    // 地之后才有东西可扫,所以触发点从 thumbnail 挪到 strip。
                    Ok(()) if job.kind == "strip" => {
                        if let Err(error) = super::ocr::enqueue_after_strip(connection, job, &cache_root) {
                            tracing::warn!(clip_dependency = %job.kind, %error, "could not enqueue ocr scan");
                        }
                    }
                    Ok(()) => {}
                    Err(error) => {
                        fail_or_retry(connection, job, &error.to_string())?;
                    }
                }
            }
            "ocr_scan" => match super::ocr::run_ocr_scan(connection, job, &cache_root) {
                Ok(()) => {}
                Err(error) => {
                    // 工具没装是确定性错误：直接 blocked，不烧三次重试。
                    if super::ocr::is_missing_tool_error(&error) {
                        mark_blocked_deterministic(connection, job.id, job.attempt, &error.to_string())?;
                    } else {
                        fail_or_retry(connection, job, &error.to_string())?;
                    }
                }
            },
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
            // R6 Task 4:睡眠唤醒调 `WorkerControl::wake_worker` 时提前结束这次
            // idle 等待,不用干等到 `idle_delay` 走完才发现刚恢复的过期租约。
            tokio::select! {
                () = tokio::time::sleep(idle_delay) => {}
                () = coordinator.wake.notified() => {}
            }
        }
    }

    /// 每 30 秒检查一次:队列里是否还有排队/在跑的嵌入/分类任务;有则 CLIP
    /// 子进程需要保留("keep"),否则可在空闲超过阈值后被 `sidecar::unload_if_idle` 卸载。
    async fn watch_sidecar_idle(db_path: PathBuf) {
        loop {
            tokio::time::sleep(SIDECAR_IDLE_POLL_INTERVAL).await;
            let iteration_path = db_path.clone();
            let keep = tokio::task::spawn_blocking(move || -> Result<bool> {
                let connection = db::open_project(&iteration_path)?;
                embedding_work_pending(&connection)
            })
            .await;
            let keep = match keep {
                Ok(Ok(keep)) => keep,
                Ok(Err(error)) => {
                    tracing::error!(%error, "sidecar idle check failed to read job queue");
                    continue;
                }
                Err(error) => {
                    tracing::error!(%error, "sidecar idle check task panicked");
                    continue;
                }
            };
            let unloaded =
                tokio::task::spawn_blocking(move || super::sidecar::unload_if_idle(SIDECAR_IDLE_THRESHOLD, keep))
                    .await
                    .unwrap_or(false);
            if unloaded {
                tracing::info!("CLIP sidecar 已因空闲超过阈值被卸载");
            }
        }
    }

    /// 每 5 秒探一次可用内存,按滞回(<15% 暂停,≥25% 恢复)切换认领开关。
    async fn watch_memory_pressure(coordinator: Arc<WorkerPoolCoordinator>) {
        loop {
            tokio::time::sleep(MEMORY_POLL_INTERVAL).await;
            poll_memory_pressure_once(&coordinator);
        }
    }

    pub async fn run(self) {
        // 两个轮询任务的生命周期挂在这个守卫上:run() 正常返回、被 abort 掉、
        // 或者 future 被丢弃时,守卫析构都会把它们 abort,不留后台任务。
        let _pollers = PollerHandles::new(vec![
            tokio::spawn(Self::watch_memory_pressure(self.coordinator.clone())).abort_handle(),
            tokio::spawn(Self::watch_sidecar_idle(self.db_path.clone())).abort_handle(),
        ]);
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

/// 后台轮询任务的句柄:析构即 abort。`JobRunner::run` 把它作为局部变量持有,
/// 所以 run() 无论怎样离开(返回、被取消、panic)轮询任务都不会泄漏。
struct PollerHandles {
    handles: Vec<tokio::task::AbortHandle>,
}

impl PollerHandles {
    fn new(handles: Vec<tokio::task::AbortHandle>) -> Self {
        Self { handles }
    }
}

impl Drop for PollerHandles {
    fn drop(&mut self) {
        for handle in self.handles.drain(..) {
            handle.abort();
        }
    }
}

/// 单次内存压力采样:读当前暂停态、探可用内存、按滞回决定是否切换。
/// 从 5 秒循环里抽出来,好让端到端测试用 `TRIPCUT_MEMORY_PRESSURE_FILE` 逐拍驱动。
fn poll_memory_pressure_once(coordinator: &Arc<WorkerPoolCoordinator>) {
    let control = WorkerControl::new(coordinator.clone());
    let paused = control.pause_state();
    let percent = super::memory_profile::available_percent();
    let next = next_pause_state(paused, percent);
    if next == paused {
        return;
    }
    control.set_paused_for_memory(next);
    if next {
        tracing::warn!(
            available_percent = percent,
            "内存可用率过低,暂停认领解码与大模型任务"
        );
    } else {
        tracing::warn!(available_percent = percent, "内存已回落,恢复认领新任务");
    }
}

/// 队列里是否还有待跑/在跑的嵌入或八维分类任务("keep"信号的来源)。
fn embedding_work_pending(connection: &Connection) -> Result<bool> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM jobs WHERE status IN ('pending','running') AND kind IN ('clip_embed','classify_dims')",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
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

    /// 认领 SQL 的优先级 CASE 覆盖的全部 kind,加上 noop——`kinds_sql_literals_agree_with_resource_class`
    /// 的反向断言就打在这份名单上。
    const ALL_JOB_KINDS: &[&str] = &[
        "noop",
        "export_package",
        "import_probe",
        "metadata_backfill",
        "align_clocks",
        "chapterize",
        "full_hash",
        "thumbnail",
        "strip",
        "analyze_l1",
        "analyze_motion",
        "clip_embed",
        "classify_dims",
        "waveform",
        "transcribe",
        "proxy",
        "similar_cluster",
        "ocr_scan",
        "music_analyze",
        "moments",
    ];

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
    fn stale_failure_cannot_change_a_reclaimed_attempt() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(&mut connection, "noop", "{}", "stale-failure").unwrap();
        let old = claim_next(&mut connection).unwrap().unwrap();
        connection.execute(
            "UPDATE jobs SET attempt=attempt+1, owner_id='new-worker' WHERE id=?1", [id]
        ).unwrap();
        let current = get(&connection, id).unwrap();
        assert!(fail_or_retry(&mut connection, &old, "late decoder failure").is_err());
        assert_eq!(get(&connection, id).unwrap(), current);
        let owner: String = connection.query_row("SELECT owner_id FROM jobs WHERE id=?1", [id], |row| row.get(0)).unwrap();
        assert_eq!(owner, "new-worker");
    }

    #[test]
    fn failed_job_is_requeued_with_backoff_before_attempt_three() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let id = enqueue(&mut connection, "unknown", "{}", "hash-2").unwrap();
        claim_next(&mut connection).unwrap().unwrap();

        mark_failed(&mut connection, id, 1, "transient failure").unwrap();
        assert_eq!(get(&connection, id).unwrap().status, JobStatus::Failed);
        assert_eq!(
            retry_or_block(&mut connection, id, 1).unwrap(),
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

    /// 这是 migration 0036 实际会撞上的、完全合法可达的场景:同一 payload_hash
    /// 的旧行已经 failed(`ocr.rs:396` 允许失败后再排一条 pending),新行仍在
    /// pending/running。此时对旧的 failed 行调用 `retry_or_block` 会撞上新行,
    /// 必须静默丢弃这次重试(旧行保持 failed),而不是让命令报
    /// `UNIQUE constraint failed` 崩出去。
    #[test]
    fn retry_or_block_silently_drops_when_colliding_with_an_active_duplicate() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();

        // 旧行:ocr_scan,已经 failed。
        let old = enqueue(&mut connection, "ocr_scan", r#"{"clip_id":1}"#, "dup-hash").unwrap();
        claim_next(&mut connection).unwrap().unwrap();
        mark_failed(&mut connection, old, 1, "旧行失败").unwrap();
        assert_eq!(get(&connection, old).unwrap().status, JobStatus::Failed);

        // 新行:旧行失败后按 ocr.rs 的规则被允许排队(同哈希),仍处于 pending。
        let new_pending =
            enqueue_idempotent(&mut connection, "ocr_scan", r#"{"clip_id":1}"#, "dup-hash").unwrap();
        assert_eq!(get(&connection, new_pending).unwrap().status, JobStatus::Pending);

        // 对旧的 failed 行重试:不能报错,只能静默无效(旧行仍是 failed)。
        let status = retry_or_block(&mut connection, old, 1).unwrap();
        assert_eq!(
            status,
            JobStatus::Pending,
            "retry_or_block 的返回值描述的是它尝试的目标状态,不代表写入一定生效"
        );
        assert_eq!(
            get(&connection, old).unwrap().status,
            JobStatus::Failed,
            "旧行撞上新行的唯一约束时必须保持 failed,不能被静默提升为撞车的 pending"
        );
        // 新行完全不受影响。
        assert_eq!(get(&connection, new_pending).unwrap().status, JobStatus::Pending);
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

        mark_failed(&mut connection, id, 3, "three attempts exhausted").unwrap();
        assert_eq!(
            retry_or_block(&mut connection, id, 3).unwrap(),
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

        mark_failed(&mut connection, id, first_attempt.attempt, "interrupted write").unwrap();
        retry_or_block(&mut connection, id, 1).unwrap();
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

    /// R6 Task 7d/F-R1-8:三条素材都排了 thumbnail(封面)与 strip(胶片条)。
    /// 三个封面必须全部先认领完,才轮到任何一条胶片条——用不同 clip_id 避免
    /// 撞上"同一 clip 的解码类互斥"那条串行规则,单纯看优先级。
    #[test]
    fn all_thumbnails_are_claimed_before_any_strip() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        for clip_id in 1..=3 {
            enqueue(
                &mut connection,
                "thumbnail",
                &format!(r#"{{"clip_id":{clip_id}}}"#),
                &format!("thumbnail-{clip_id}"),
            )
            .unwrap();
        }
        // strip 通常是 thumbnail 完成后才动态入队的,但优先级只取决于 kind,
        // 提前把三条 strip 也摆进队列同样必须排在三条 thumbnail 之后。
        for clip_id in 1..=3 {
            enqueue(
                &mut connection,
                "strip",
                &format!(r#"{{"clip_id":{clip_id}}}"#),
                &format!("strip-{clip_id}"),
            )
            .unwrap();
        }

        let mut claimed_order = Vec::new();
        for _ in 0..6 {
            let job = claim_next(&mut connection).unwrap().unwrap();
            claimed_order.push(job.kind.clone());
            mark_done(&mut connection, job.id, job.attempt).unwrap();
        }
        assert_eq!(
            claimed_order,
            vec!["thumbnail", "thumbnail", "thumbnail", "strip", "strip", "strip"],
            "三条封面必须全部先于任何一条胶片条被认领"
        );
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

    /// migration 0036 在 `(kind, payload_hash)` 上建了一条部分唯一索引:
    /// `kind='ocr_scan' AND status IN ('pending','running')`。这条不变式本身
    /// 使得"一条 pending、一条 running,哈希相同"这个具体持久化状态在该索引存续期间
    /// 无法通过任何写入序列真正达成(任何让第二行也落进该分区的写入都会当场被挡)。
    /// 为了仍然在真实的 `jobs` 表结构上验证 `recover_expired` 那条批量 UPDATE
    /// 遇到约束冲突时不拖累整批——而不是伪造一个数据库自己都不允许存在的状态——
    /// 这里给 `jobs` 表临时加一条等价的 CHECK 约束(同样受 `OR IGNORE` 约束解决算法
    /// 管辖),只毒化"某条到期 running 任务被改回 pending"这一步,精确复现同一类
    /// 约束冲突,而不依赖一个自相矛盾的前置状态。
    #[test]
    fn recover_expired_does_not_abort_the_whole_batch_on_a_constraint_collision() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();

        let poisoned = enqueue(&mut connection, "ocr_scan", r#"{"clip_id":1}"#, "poison-hash").unwrap();
        connection
            .execute(
                "UPDATE jobs SET status='running', attempt=1, owner_id='old',
                 lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
                 WHERE id=?1",
                [poisoned],
            )
            .unwrap();
        // 同一批次里还有一条不相关、正常应该被回收的过期任务。
        let unrelated = enqueue(&mut connection, "noop", "{}", "unrelated-expired").unwrap();
        connection
            .execute(
                "UPDATE jobs SET status='running', attempt=1, owner_id='old',
                 lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
                 WHERE id=?1",
                [unrelated],
            )
            .unwrap();

        // 把 jobs 表整体重建成带一条额外 CHECK 约束的版本:
        // "payload_hash='poison-hash' 的行不能被写成 status='pending'"——
        // 这精确模拟了 0036 那条唯一索引在真实撞车场景里会做的事(挡下这一行
        // 变成 pending),同时是 SQLite 文档明确说明 `OR IGNORE` 会遵守的
        // 约束类别(UNIQUE / NOT NULL / CHECK 都算,唯独不算 FK/触发器)。
        let create_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(create_sql.trim_end().ends_with(')'));
        let augmented_sql = format!(
            "{trimmed}, CHECK (NOT (payload_hash = 'poison-hash' AND status = 'pending')))",
            trimmed = &create_sql.trim_end()[..create_sql.trim_end().len() - 1]
        );
        connection
            .execute_batch(&format!(
                "ALTER TABLE jobs RENAME TO jobs_old;
                 {augmented_sql};
                 INSERT INTO jobs SELECT * FROM jobs_old;
                 DROP TABLE jobs_old;"
            ))
            .unwrap();

        // 不能 panic / 不能返回 Err;冲突只应吞掉那一条,不拖累 unrelated。
        let recovered = recover_expired(&mut connection).unwrap();

        // 不相关的任务必须仍被正常回收。
        assert_eq!(
            get(&connection, unrelated).unwrap().status,
            JobStatus::Pending,
            "同批次里不相关的过期任务必须照常被回收,不能被这一条冲突拖累"
        );
        // 被毒化的那条不能被静默地"提升"成撞约束的 pending;根据本次修复,
        // 它应该被第二道扫尾 UPDATE 标记为 failed(退出卡死的 running)。
        let poisoned_status = get(&connection, poisoned).unwrap().status;
        assert_ne!(
            poisoned_status,
            JobStatus::Pending,
            "撞约束的过期任务不能被静默提升为 pending"
        );
        assert_eq!(
            poisoned_status,
            JobStatus::Failed,
            "撞约束的过期任务应该被标记为 failed,退出卡死的 running,而不是原地不动"
        );
        assert_eq!(recovered, 2, "两条过期任务都应计入回收计数(一条 pending,一条 failed)");
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

    #[test]
    fn decode_jobs_for_same_clip_do_not_run_concurrently() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":7}"#, "a").unwrap();
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":7}"#, "b").unwrap();
        enqueue(&mut connection, "analyze_l1", r#"{"clip_id":8}"#, "c").unwrap();

        let first = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(first.kind, "thumbnail");
        let second = claim_next(&mut connection).unwrap().unwrap();
        assert_eq!(second.payload, r#"{"clip_id":8}"#);
        assert!(claim_next(&mut connection).unwrap().is_none());
    }

    #[test]
    fn saturated_decode_class_is_skipped_but_light_jobs_still_claim() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "proxy", r#"{"clip_id":1}"#, "p").unwrap();
        enqueue(&mut connection, "waveform", r#"{"clip_id":2}"#, "w").unwrap();

        let job = claim_next_for_owner_excluding(&mut connection, "t", true, false)
            .unwrap()
            .unwrap();
        assert_eq!(job.kind, "waveform");
    }

    #[test]
    fn saturated_heavy_model_class_is_skipped() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "clip_embed", r#"{"clip_id":1}"#, "e").unwrap();
        enqueue(&mut connection, "waveform", r#"{"clip_id":2}"#, "w2").unwrap();

        let job = claim_next_for_owner_excluding(&mut connection, "t", false, true)
            .unwrap()
            .unwrap();
        assert_eq!(job.kind, "waveform");
    }

    #[test]
    fn resource_classes_map_each_job_kind() {
        assert!(matches!(resource_class("thumbnail"), ResourceClass::Decode));
        assert!(matches!(resource_class("proxy"), ResourceClass::Decode));
        assert!(matches!(
            resource_class("clip_embed"),
            ResourceClass::HeavyModel
        ));
        assert!(matches!(
            resource_class("transcribe"),
            ResourceClass::HeavyModel
        ));
        assert!(matches!(resource_class("waveform"), ResourceClass::Light));
        assert!(matches!(
            resource_class("export_package"),
            ResourceClass::Light
        ));
        assert!(matches!(
            resource_class("music_analyze"),
            ResourceClass::Decode
        ));
        // R7 Task 5:generation_poll 不解码、不占大模型权重,落在默认分支——
        // 必须是 Light,`generation_poll_is_light_and_not_paused_by_memory_pressure`
        // 靠这一点保证内存压力暂停挡不住它。
        assert!(matches!(resource_class("generation_poll"), ResourceClass::Light));
    }

    /// R7 Task 5:内存压力暂停期间(`exclude_decode=true, exclude_heavy=true`,
    /// 见 `WorkerPoolCoordinator::claim_for_owner` 里 `paused_for_memory` 分支)
    /// `generation_poll` 仍然可以被认领——它是 Light 类,认领 SQL 只按
    /// `DECODE_KINDS_SQL`/`HEAVY_KINDS_SQL` 排除,从不排除 Light。等云端结果
    /// 时被暂停只会白等,不解码也不占显存。
    #[test]
    fn generation_poll_is_light_and_not_paused_by_memory_pressure() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "generation_poll", r#"{"request_id":1}"#, "1").unwrap();
        let job = claim_next_for_owner_excluding(&mut connection, "t", true, true)
            .unwrap()
            .unwrap();
        assert_eq!(job.kind, "generation_poll");
    }

    #[test]
    fn saturated_decode_class_skips_music_analyze_too() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "music_analyze", r#"{"clip_id":1}"#, "m").unwrap();

        // 内存压力暂停期间(exclude_decode=true),music_analyze 必须像其它 Decode
        // 类一样被挡下——它是唯一在队列里的任务,所以没有可认领的。
        let none = claim_next_for_owner_excluding(&mut connection, "t", true, false).unwrap();
        assert!(
            none.is_none(),
            "music_analyze 在解码暂停期间不应被认领,但被认领了: {:?}",
            none.map(|j| j.kind)
        );

        // 压力解除后(exclude_decode=false)应能正常认领。
        let job = claim_next_for_owner_excluding(&mut connection, "t", false, false)
            .unwrap()
            .unwrap();
        assert_eq!(job.kind, "music_analyze");
    }

    #[test]
    fn memory_pause_uses_hysteresis_between_fifteen_and_twenty_five() {
        // 未暂停时,只有跌破 15% 才暂停。
        assert!(!next_pause_state(false, 20));
        assert!(!next_pause_state(false, 15));
        assert!(next_pause_state(false, 14));
        // 已暂停时,必须回到 25% 才恢复。
        assert!(next_pause_state(true, 16));
        assert!(next_pause_state(true, 24));
        assert!(!next_pause_state(true, 25));
    }

    #[test]
    fn memory_pause_blocks_decode_and_heavy_but_not_light_jobs() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let mut connection = db::open_project(&db_path).unwrap();
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":1}"#, "paused-d").unwrap();
        enqueue(&mut connection, "clip_embed", r#"{"clip_id":2}"#, "paused-h").unwrap();
        let export_id = enqueue(&mut connection, "export_package", "{}", "paused-x").unwrap();

        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let control = WorkerControl::new(coordinator.clone());
        control.set_paused_for_memory(true);
        assert!(control.pause_state());

        // Light 类照常认领:导出不吃解码器也不吃模型权重。
        let claimed = coordinator
            .claim_for_owner(&mut connection, "paused-owner")
            .unwrap()
            .expect("export_package 必须能在内存暂停期间被认领");
        assert_eq!(claimed.job.id, export_id);
        assert_eq!(claimed.job.kind, "export_package");
        mark_done(&mut connection, claimed.job.id, claimed.job.attempt).unwrap();
        drop(claimed);

        // 解码与大模型两类被挡住:队列里只剩它们,所以认领不到只可能来自暂停。
        assert!(coordinator
            .claim_for_owner(&mut connection, "paused-owner")
            .unwrap()
            .is_none());

        control.set_paused_for_memory(false);
        let resumed = coordinator
            .claim_for_owner(&mut connection, "paused-owner")
            .unwrap()
            .expect("解除暂停后解码任务应可认领");
        assert_eq!(resumed.job.kind, "thumbnail");
    }

    /// 4 个线程抢同一个 coordinator,假执行器睡 50ms 并在睡前采样 `active_decode`。
    /// 返回观察到的解码并发峰值。
    fn observed_decode_peak(decode_limit: usize, job_count: usize) -> usize {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        {
            let mut connection = db::open_project(&db_path).unwrap();
            for index in 0..job_count {
                // clip_id 各不相同,免得同素材串行规则替许可上限背了锅。
                enqueue(
                    &mut connection,
                    "thumbnail",
                    &format!(r#"{{"clip_id":{}}}"#, index + 1),
                    &format!("decode-limit-{decode_limit}-{index}"),
                )
                .unwrap();
            }
        }
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let control = WorkerControl::new(coordinator.clone());
        control.set_decode_limit(decode_limit);
        let peak = Arc::new(AtomicUsize::new(0));

        let handles: Vec<_> = (0..4)
            .map(|_| {
                let thread_path = db_path.clone();
                let thread_coordinator = coordinator.clone();
                let thread_control = control.clone();
                let thread_peak = peak.clone();
                std::thread::spawn(move || loop {
                    let ran = JobRunner::run_one_with_executor(
                        &thread_path,
                        &thread_coordinator,
                        "limit-probe",
                        |_db_path, connection, job| {
                            // 采样点在许可持有期内:permit 在这个闭包返回之后才 drop。
                            let active = thread_control.active_decode();
                            thread_peak.fetch_max(active, Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(50));
                            mark_done(connection, job.id, job.attempt)
                        },
                    )
                    .unwrap();
                    if !ran {
                        // 认领不到有两种可能:队列空了,或者解码类正好饱和。
                        // 只有队列真的空了才收工。
                        let connection = db::open_project(&thread_path).unwrap();
                        let remaining: i64 = connection
                            .query_row(
                                "SELECT COUNT(*) FROM jobs WHERE status IN ('pending','running')",
                                [],
                                |row| row.get(0),
                            )
                            .unwrap();
                        if remaining == 0 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let connection = db::open_project(&db_path).unwrap();
        let done: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE status='done'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(done, job_count as i64, "所有解码任务都应跑完");
        peak.load(Ordering::SeqCst)
    }

    #[test]
    fn four_threads_never_exceed_a_decode_limit_of_one() {
        assert_eq!(observed_decode_peak(1, 8), 1);
    }

    #[test]
    fn four_threads_reach_but_never_exceed_a_decode_limit_of_two() {
        let peak = observed_decode_peak(2, 8);
        // 上限守住,而且并发确实发生了——否则"≤2"可能只是因为从来没并行过。
        assert!(peak <= 2, "解码并发峰值 {peak} 超过许可上限 2");
        assert!(peak >= 2, "解码并发峰值只有 {peak},没能证明真的并行了");
    }

    struct MemoryPressureEnvGuard {
        previous: Option<OsString>,
    }

    impl MemoryPressureEnvGuard {
        fn set(path: &Path) -> Self {
            let previous = std::env::var_os("TRIPCUT_MEMORY_PRESSURE_FILE");
            std::env::set_var("TRIPCUT_MEMORY_PRESSURE_FILE", path);
            Self { previous }
        }
    }

    impl Drop for MemoryPressureEnvGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("TRIPCUT_MEMORY_PRESSURE_FILE", value),
                None => std::env::remove_var("TRIPCUT_MEMORY_PRESSURE_FILE"),
            }
        }
    }

    /// 写压力文件 → 敲一拍轮询 → 看暂停态。`TRIPCUT_MEMORY_PRESSURE_FILE` 是进程级的,
    /// `memory_profile` 的测试也会动它,所以每一拍都重新指名自己的文件并允许重试,
    /// 免得被并行测试的 env 改动打成偶发红。
    fn tick_until(
        coordinator: &Arc<WorkerPoolCoordinator>,
        control: &WorkerControl,
        pressure_file: &Path,
        percent: &str,
        expected_paused: bool,
    ) -> bool {
        for _ in 0..40 {
            std::fs::write(pressure_file, percent).unwrap();
            std::env::set_var("TRIPCUT_MEMORY_PRESSURE_FILE", pressure_file);
            poll_memory_pressure_once(coordinator);
            if control.pause_state() == expected_paused {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[test]
    fn memory_pressure_file_drives_pause_and_resume_end_to_end() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let pressure_file = db_path.with_file_name("memory-pressure");
        let mut connection = db::open_project(&db_path).unwrap();
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":1}"#, "e2e-decode").unwrap();
        enqueue(&mut connection, "waveform", r#"{"clip_id":2}"#, "e2e-light").unwrap();

        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let control = WorkerControl::new(coordinator.clone());
        let _env = MemoryPressureEnvGuard::set(&pressure_file);

        // 可用内存 5% —— 一拍轮询后必须暂停。
        assert!(
            tick_until(&coordinator, &control, &pressure_file, "5", true),
            "5% 可用内存应触发暂停"
        );

        // 暂停期间:解码认领不到,Light 的 waveform 照常。
        let claimed = coordinator
            .claim_for_owner(&mut connection, "e2e-owner")
            .unwrap()
            .expect("waveform 应能在暂停期间被认领");
        assert_eq!(claimed.job.kind, "waveform");
        mark_done(&mut connection, claimed.job.id, claimed.job.attempt).unwrap();
        drop(claimed);
        assert!(
            coordinator
                .claim_for_owner(&mut connection, "e2e-owner")
                .unwrap()
                .is_none(),
            "暂停期间不该认领到解码任务"
        );

        // 回到 40% —— 一拍轮询后恢复,解码任务可认领。
        assert!(
            tick_until(&coordinator, &control, &pressure_file, "40", false),
            "40% 可用内存应恢复认领"
        );
        let resumed = coordinator
            .claim_for_owner(&mut connection, "e2e-owner")
            .unwrap()
            .expect("恢复后解码任务应可认领");
        assert_eq!(resumed.job.kind, "thumbnail");
    }

    /// F-R1-9:证明 perf 装置改走的新入口(`run_one_step_with_kind`/`poll_memory_pressure`)
    /// 真的是协调器路径——压力生效期间,同一个 `JobRunner` 认不到 decode 类
    /// (thumbnail),但 Light 类(noop)照常认领并跑完。用 `noop` 而不是
    /// `waveform` 是为了不需要真实素材文件就能走完整条 `run_one_with_executor`
    /// 执行路径。
    #[test]
    fn run_one_step_honours_memory_pressure_like_the_real_worker_pool() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let pressure_file = db_path.with_file_name("memory-pressure-run-one-step");
        let mut connection = db::open_project(&db_path).unwrap();
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":1}"#, "step-decode").unwrap();
        enqueue(&mut connection, "noop", "{}", "step-light").unwrap();
        drop(connection);

        let runner = JobRunner::new(db_path.clone(), 1);
        let _env = MemoryPressureEnvGuard::set(&pressure_file);

        let mut paused = false;
        for _ in 0..40 {
            std::fs::write(&pressure_file, "5").unwrap();
            std::env::set_var("TRIPCUT_MEMORY_PRESSURE_FILE", &pressure_file);
            runner.poll_memory_pressure();
            if runner.control().pause_state() {
                paused = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(paused, "5% 可用内存应通过 poll_memory_pressure 触发暂停");

        // 暂停期间:run_one_step_with_kind 不该认领 decode(thumbnail),但要认领并跑完 Light(noop)。
        assert_eq!(
            runner.run_one_step_with_kind().unwrap().as_deref(),
            Some("noop"),
            "暂停期间不该认领到 thumbnail(decode),应精确认到 noop"
        );

        // 队列里只剩 thumbnail(decode 类),暂停期间 run_one_step_with_kind 应认领不到。
        assert_eq!(
            runner.run_one_step_with_kind().unwrap(),
            None,
            "暂停期间不该认领到解码任务"
        );
    }

    /// R6 Task 7d 修复:perf 装置此前用「全局查一次最近完成的是哪条」来给
    /// 每一步计时打标签——多个 worker 在几毫秒内先后收尾时,这条查询可能
    /// 被好几个 worker 同时读到同一行,导致 `strip`/`ocr_scan` 这类几毫秒
    /// 就跑完的任务被重复计数(实测 500 条素材记出 1027 条 strip 计时样
    /// 本)。`run_one_step_with_kind` 直接把"这一步真正认领并跑完的是哪个
    /// job"带出来,不再需要那次容易撞车的重新查询。
    #[test]
    fn run_one_step_with_kind_attributes_exactly_the_job_it_claimed() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let mut connection = db::open_project(&db_path).unwrap();
        enqueue(&mut connection, "noop", "{}", "kind-a").unwrap();
        enqueue(&mut connection, "waveform", r#"{"clip_id":1}"#, "kind-b").unwrap();
        drop(connection);

        // waveform 优先级(20)高于 noop(不在优先级表里,ELSE 0),所以先认领到的是 waveform。
        let runner = JobRunner::new(db_path.clone(), 1);
        let first = runner.run_one_step_with_kind().unwrap();
        assert_eq!(
            first.as_deref(),
            Some("waveform"),
            "第一步应精确认到 waveform——waveform 缺真实素材会执行失败,\
             但 attempt 计入 blocked/failed 之前 kind 依然要如实带出来"
        );
        let second = runner.run_one_step_with_kind().unwrap();
        assert_eq!(second.as_deref(), Some("noop"), "第二步应精确认到 noop,不是猜出来的");
        let third = runner.run_one_step_with_kind().unwrap();
        assert_eq!(third, None, "队列空了应该是 None,不是某条历史 job 的 kind");
    }

    #[test]
    fn poller_handles_abort_their_tasks_when_dropped() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let never_ends = tokio::spawn(async {
                loop {
                    tokio::time::sleep(Duration::from_secs(3_600)).await;
                }
            });
            let handles = PollerHandles::new(vec![never_ends.abort_handle()]);
            assert!(!never_ends.is_finished());
            drop(handles);

            let deadline = Instant::now() + Duration::from_secs(1);
            while !never_ends.is_finished() {
                assert!(Instant::now() < deadline, "轮询任务在 1s 内没有被终止");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(never_ends.is_finished());
        });
    }

    /// `DECODE_KINDS_SQL` / `HEAVY_KINDS_SQL` 是手抄给 SQL 的名单,与
    /// `resource_class()` 的 match 分支必须一一对上——两边任一处改动都在这里红。
    fn parse_kinds_sql(literal: &str) -> Vec<String> {
        literal
            .trim_start_matches('(')
            .trim_end_matches(')')
            .split(',')
            .map(|kind| kind.trim().trim_matches('\'').to_owned())
            .collect()
    }

    #[test]
    fn kinds_sql_literals_agree_with_resource_class() {
        let decode = parse_kinds_sql(DECODE_KINDS_SQL);
        let heavy = parse_kinds_sql(HEAVY_KINDS_SQL);
        // 期望长度从 `resource_class` 在全部已知 kind 上的判定推导,不再手抄数字——
        // 字面量和 match 分支任一边新增/删减一个 kind,这里都会红,不会漂移出一个
        // "凑巧都是 5/3" 的假绿。
        let expected_decode = ALL_JOB_KINDS
            .iter()
            .filter(|kind| matches!(resource_class(kind), ResourceClass::Decode))
            .count();
        let expected_heavy = ALL_JOB_KINDS
            .iter()
            .filter(|kind| matches!(resource_class(kind), ResourceClass::HeavyModel))
            .count();
        assert_eq!(
            decode.len(),
            expected_decode,
            "DECODE_KINDS_SQL 的条目数与 resource_class 判成 Decode 的 kind 数不一致"
        );
        assert_eq!(
            heavy.len(),
            expected_heavy,
            "HEAVY_KINDS_SQL 的条目数与 resource_class 判成 HeavyModel 的 kind 数不一致"
        );
        for kind in &decode {
            assert!(
                matches!(resource_class(kind), ResourceClass::Decode),
                "{kind} 在 DECODE_KINDS_SQL 里,但 resource_class 不认为它是 Decode"
            );
        }
        for kind in &heavy {
            assert!(
                matches!(resource_class(kind), ResourceClass::HeavyModel),
                "{kind} 在 HEAVY_KINDS_SQL 里,但 resource_class 不认为它是 HeavyModel"
            );
        }
        // 反向:除这两份名单外,没有别的 kind 会被判成 Decode/HeavyModel。
        for kind in ALL_JOB_KINDS {
            match resource_class(kind) {
                ResourceClass::Decode => assert!(
                    decode.iter().any(|listed| listed == kind),
                    "{kind} 被判成 Decode,却不在 DECODE_KINDS_SQL 里"
                ),
                ResourceClass::HeavyModel => assert!(
                    heavy.iter().any(|listed| listed == kind),
                    "{kind} 被判成 HeavyModel,却不在 HEAVY_KINDS_SQL 里"
                ),
                ResourceClass::Light => {
                    assert!(!decode.iter().any(|listed| listed == kind));
                    assert!(!heavy.iter().any(|listed| listed == kind));
                }
            }
        }
    }

    /// 认领 SQL 的相关子查询在深队列下的耗时:一次性测量,不进常规门禁。
    /// 跑法:`cargo test --manifest-path src-tauri/Cargo.toml claim_sql_cost -- --ignored --nocapture`
    #[test]
    #[ignore = "基准测量,手动跑"]
    fn claim_sql_cost_under_a_deep_queue() {
        const PENDING: usize = 5_000;
        const RUNNING: usize = 4;
        const SAMPLES: usize = 100;

        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let mut connection = db::open_project(&db_path).unwrap();
        for index in 0..PENDING {
            enqueue(
                &mut connection,
                "thumbnail",
                &format!(r#"{{"clip_id":{index}}}"#),
                &format!("bench-{index}"),
            )
            .unwrap();
        }
        for index in 0..RUNNING {
            let id = enqueue(
                &mut connection,
                "analyze_l1",
                &format!(r#"{{"clip_id":{}}}"#, 900_000 + index),
                &format!("bench-running-{index}"),
            )
            .unwrap();
            connection
                .execute("UPDATE jobs SET status='running' WHERE id=?1", [id])
                .unwrap();
        }

        let started = Instant::now();
        for _ in 0..SAMPLES {
            let job = claim_next(&mut connection).unwrap().unwrap();
            mark_done(&mut connection, job.id, job.attempt).unwrap();
        }
        let deep = started.elapsed();

        // 浅队列基线:同样是 claim + mark_done 两笔写事务,只是没有 5000 行要扫。
        // 两者之差才是相关子查询在深队列上的额外成本。
        let shallow_directory = TestDirectory::new();
        let mut shallow = db::open_project(&shallow_directory.db_path()).unwrap();
        for index in 0..SAMPLES {
            enqueue(
                &mut shallow,
                "thumbnail",
                &format!(r#"{{"clip_id":{index}}}"#),
                &format!("shallow-{index}"),
            )
            .unwrap();
        }
        let started = Instant::now();
        for _ in 0..SAMPLES {
            let job = claim_next(&mut shallow).unwrap().unwrap();
            mark_done(&mut shallow, job.id, job.attempt).unwrap();
        }
        let baseline = started.elapsed();

        let per = |value: Duration| value.as_secs_f64() * 1_000.0 / SAMPLES as f64;
        println!(
            "claim+mark_done 深队列 {:.3} ms/claim({PENDING} pending + {RUNNING} running),\
             浅队列基线 {:.3} ms/claim,差值 {:.3} ms —— {SAMPLES} 次采样",
            per(deep),
            per(baseline),
            per(deep) - per(baseline)
        );
    }

    #[test]
    fn decode_permit_counts_track_active_decode_jobs() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let mut connection = db::open_project(&db_path).unwrap();
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":1}"#, "d1").unwrap();
        enqueue(&mut connection, "thumbnail", r#"{"clip_id":2}"#, "d2").unwrap();

        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let control = WorkerControl::new(coordinator.clone());
        control.set_decode_limit(1);

        let claimed = coordinator
            .claim_for_owner(&mut connection, "decode-owner")
            .unwrap()
            .unwrap();
        assert_eq!(control.active_decode(), 1);
        assert!(control.decode_saturated());
        // 第二个解码任务因为类饱和而不可认领。
        assert!(coordinator
            .claim_for_owner(&mut connection, "decode-owner")
            .unwrap()
            .is_none());
        drop(claimed);
        assert_eq!(control.active_decode(), 0);
    }

    #[test]
    fn embedding_work_pending_is_false_with_no_jobs() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        assert!(!embedding_work_pending(&connection).unwrap());
    }

    #[test]
    fn embedding_work_pending_is_true_with_a_pending_clip_embed() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        enqueue(&mut connection, "clip_embed", "{}", "e1").unwrap();
        assert!(embedding_work_pending(&connection).unwrap());
    }

    #[test]
    fn embedding_work_pending_is_false_with_only_a_done_clip_embed() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let job_id = enqueue(&mut connection, "clip_embed", "{}", "e2").unwrap();
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let claimed = coordinator
            .claim_for_owner(&mut connection, "done-owner")
            .unwrap()
            .unwrap();
        assert_eq!(claimed.job.id, job_id);
        mark_done(&mut connection, job_id, claimed.job.attempt).unwrap();
        assert!(!embedding_work_pending(&connection).unwrap());
    }

    /// R6 Task 4:交付完成时,接线好的通知出口恰好收到一条——不多不少。假
    /// 执行器直接把 job 落成「完成态、带 result_path」,不真的跑 ffmpeg;
    /// `notify_on_completion` 认的是 DB 里这条 job 行的最终状态,不是执行器
    /// 内部怎么走到那的,所以这个假执行器足够撑起这条契约测试。
    ///
    /// 投递现在是 fire-and-forget(`std::thread::spawn`),所以测试用
    /// `mpsc` channel 等实际那条通知落地,而不是 sleep 猜时间。
    #[test]
    fn notifier_fires_exactly_once_for_a_completed_export_package() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        {
            let mut connection = db::open_project(&db_path).unwrap();
            enqueue(&mut connection, "export_package", "{}", "export-notify").unwrap();
        }
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let (sender, receiver) = std::sync::mpsc::channel::<(String, String)>();
        let sender = Mutex::new(sender);
        coordinator
            .notifier
            .set(Arc::new(move |title: &str, body: &str| {
                sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .send((title.to_owned(), body.to_owned()))
                    .is_ok()
            }))
            .ok();

        let ran = JobRunner::run_one_with_executor(&db_path, &coordinator, "export-owner", |_db_path, connection, job| {
            connection.execute(
                "UPDATE jobs SET status='done', result_path=?2 WHERE id=?1",
                params![job.id, "/tmp/我的交付包_2026-09-06"],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(ran);

        let received = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("fire-and-forget 通知必须在超时前送达");
        assert_eq!(received, ("交付完成".to_owned(), "我的交付包_2026-09-06".to_owned()));
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(200)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "不多不少,恰好一条"
        );
    }

    /// R10 U-25:首个后台任务开始时钩子恰好调一次——跑两条任务只收到一次;
    /// 通知出口(`notifier`)不因此多收任何一条。
    #[test]
    fn first_job_hook_fires_exactly_once_across_many_jobs() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        {
            let mut connection = db::open_project(&db_path).unwrap();
            enqueue(&mut connection, "noop", "{}", "first-hook-1").unwrap();
            enqueue(&mut connection, "noop", "{}", "first-hook-2").unwrap();
        }
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let (sender, receiver) = std::sync::mpsc::channel::<()>();
        let sender = Mutex::new(sender);
        coordinator
            .first_job_hook
            .set(Arc::new(move || {
                let _ = sender.lock().unwrap_or_else(|error| error.into_inner()).send(());
            }))
            .ok();
        let (notify_sender, notify_receiver) = std::sync::mpsc::channel::<(String, String)>();
        let notify_sender = Mutex::new(notify_sender);
        coordinator
            .notifier
            .set(Arc::new(move |title: &str, body: &str| {
                notify_sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .send((title.to_owned(), body.to_owned()))
                    .is_ok()
            }))
            .ok();

        assert!(JobRunner::run_one_with_executor(&db_path, &coordinator, "hook-owner", JobRunner::execute_claimed).unwrap());
        assert!(JobRunner::run_one_with_executor(&db_path, &coordinator, "hook-owner", JobRunner::execute_claimed).unwrap());

        receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("第一条任务开始就该调钩子");
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(200)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "第二条任务不再调"
        );
        assert_eq!(
            notify_receiver.recv_timeout(Duration::from_millis(200)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "noop 任务不产生系统通知,钩子也不借通知出口"
        );
    }

    /// R10 U-19:music_analyze 落到终态(这里是缺文件 → 轨 failed)后事件出口收到
    /// 恰好一条 `tripcut:music-analyzed`;别的 kind 不发。
    #[test]
    fn event_sink_receives_music_analyzed_once_per_terminal_music_job() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        {
            let mut connection = db::open_project(&db_path).unwrap();
            let episode_id: i64 = connection
                .query_row("SELECT id FROM episodes WHERE status = 'active'", [], |row| row.get(0))
                .unwrap();
            connection
                .execute(
                    "INSERT INTO music_tracks(id, episode_id, file_name, rel_path, quick_hash, analysis_status, created_at)
                     VALUES (3, ?1, 'gone.wav', ?2, 'h', 'pending', 'now')",
                    params![episode_id, directory.path().join("gone.wav").to_string_lossy()],
                )
                .unwrap();
            enqueue(&mut connection, "music_analyze", r#"{"track_id":3}"#, "music-event").unwrap();
            enqueue(&mut connection, "noop", "{}", "noop-event").unwrap();
        }
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let (sender, receiver) = std::sync::mpsc::channel::<(String, serde_json::Value)>();
        let sender = Mutex::new(sender);
        coordinator
            .event_sink
            .set(Arc::new(move |name: &str, payload: serde_json::Value| {
                let _ = sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .send((name.to_owned(), payload));
            }))
            .ok();

        assert!(JobRunner::run_one_with_executor(&db_path, &coordinator, "music-owner", JobRunner::execute_claimed).unwrap());
        assert!(JobRunner::run_one_with_executor(&db_path, &coordinator, "music-owner", JobRunner::execute_claimed).unwrap());

        let (name, payload) = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("音乐分析终态必须发事件");
        assert_eq!(name, "tripcut:music-analyzed");
        assert_eq!(payload["track_id"], 3);
        assert_eq!(payload["analysis_status"], "failed");
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(200)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "noop 不发事件,音乐只发一条"
        );
    }

    /// R6 Task 4:批量分析队列排空时通知出口恰好收到一条。两条分析 job 属
    /// 于同一个导入批次;第一条完成时批次还没排空(不该发),第二条完成时
    /// 排空了(该发,且只发一次)。
    #[test]
    fn notifier_fires_exactly_once_when_a_batchs_analysis_queue_drains() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let (job_a, job_b) = {
            let mut connection = db::open_project(&db_path).unwrap();
            connection
                .execute(
                    "INSERT INTO clips(id, rel_path) VALUES (1, 'a.mov'), (2, 'b.mov')",
                    [],
                )
                .unwrap();
            let batch_id = super::super::import_control::create_batch(&connection, "/fixture").unwrap();
            connection
                .execute(
                    "INSERT INTO import_batch_clips(batch_id, clip_id) VALUES (?1, 1), (?1, 2)",
                    [batch_id],
                )
                .unwrap();
            let job_a = enqueue(&mut connection, "analyze_l1", r#"{"clip_id":1}"#, "batch-notify-a").unwrap();
            let job_b = enqueue(&mut connection, "analyze_l1", r#"{"clip_id":2}"#, "batch-notify-b").unwrap();
            (job_a, job_b)
        };
        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let (sender, receiver) = std::sync::mpsc::channel::<(String, String)>();
        let sender = Mutex::new(sender);
        coordinator
            .notifier
            .set(Arc::new(move |title: &str, body: &str| {
                sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .send((title.to_owned(), body.to_owned()))
                    .is_ok()
            }))
            .ok();
        let mark_one_done = |_db_path: &Path, connection: &mut Connection, job: &Job| -> Result<()> {
            mark_done(connection, job.id, job.attempt)
        };

        let ran_a = JobRunner::run_one_with_executor(&db_path, &coordinator, "batch-owner", mark_one_done).unwrap();
        assert!(ran_a);
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(200)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "第一条完成时批次还没排空,不该通知"
        );

        let ran_b = JobRunner::run_one_with_executor(&db_path, &coordinator, "batch-owner", mark_one_done).unwrap();
        assert!(ran_b);
        let received = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("批次排空后必须(异步)通知,等在这里而不是 sleep 猜时间");
        assert_eq!(received.0, "批量分析完成");
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(200)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "必须恰好通知一次"
        );
        let _ = (job_a, job_b);
    }

    /// R7 Task 5:生成请求补镜完成时,通知出口恰好收到一条「补镜完成」。假
    /// 执行器直接把 `generation_requests.status` 落成 `imported` 再
    /// `mark_done`——`generation::completion_notice` 认的是这条 job 行 +
    /// 请求状态,不关心执行器内部是不是真的下载/导入了视频,所以这个假
    /// 执行器足够撑起「恰好一次」这条契约。
    #[test]
    fn notifier_fires_exactly_once_for_a_completed_generation() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let request_id = {
            let mut connection = db::open_project(&db_path).unwrap();
            let episode_id: i64 = connection
                .query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0))
                .unwrap();
            connection
                .execute(
                    "INSERT INTO narrative_revisions(episode_id, kind, created_at)
                     VALUES (?1, 'confirmed', 'now')",
                    [episode_id],
                )
                .unwrap();
            let revision_id = connection.last_insert_rowid();
            connection
                .execute(
                    "INSERT INTO narrative_chapters(
                        episode_id, kind, title, \"order\", promoted, score, rationale, promotion_reason
                     ) VALUES (?1, 'atmosphere', '第一章', 0, 1, 0.9, 'r', 'p')",
                    [episode_id],
                )
                .unwrap();
            let chapter_id = connection.last_insert_rowid();
            connection
                .execute(
                    "INSERT INTO story_gaps(
                        episode_id, revision_id, chapter_id, slot, reason, status, detected_at, updated_at
                     ) VALUES (?1, ?2, ?3, 'ATMOSPHERE', 'r', 'requested', 'now', 'now')",
                    params![episode_id, revision_id, chapter_id],
                )
                .unwrap();
            let gap_id = connection.last_insert_rowid();
            connection
                .execute(
                    "INSERT INTO generation_requests(
                        gap_id, provider, model, mode, prompt, refs_json, duration_s,
                        resolution, ratio, estimated_cost_usd, status, task_id, created_at, updated_at
                     ) VALUES (?1, 'minimax', 'MiniMax-H3-Max', 't2v', 'p', '[]', 4,
                        '480P', '16:9', 0.2, 'queued', 'task-x', 'now', 'now')",
                    [gap_id],
                )
                .unwrap();
            let request_id = connection.last_insert_rowid();
            enqueue(
                &mut connection,
                "generation_poll",
                &format!("{{\"request_id\":{request_id}}}"),
                &request_id.to_string(),
            )
            .unwrap();
            request_id
        };

        let coordinator = Arc::new(WorkerPoolCoordinator::default());
        let (sender, receiver) = std::sync::mpsc::channel::<(String, String)>();
        let sender = Mutex::new(sender);
        coordinator
            .notifier
            .set(Arc::new(move |title: &str, body: &str| {
                sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .send((title.to_owned(), body.to_owned()))
                    .is_ok()
            }))
            .ok();

        // 走生产那条跃迁函数(带 `status <> 'imported'` 谓词),而不是裸
        // UPDATE——通知现在绑定的是「这次真的发生了跃迁」这个事件。
        let ran = JobRunner::run_one_with_executor(&db_path, &coordinator, "gen-owner", move |_db_path, connection, job| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            crate::core::generation::transition_to_imported(&transaction, request_id, None, None)?;
            transaction.commit()?;
            mark_done(connection, job.id, job.attempt)
        })
        .unwrap();
        assert!(ran);

        let received = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("fire-and-forget 通知必须在超时前送达");
        assert_eq!(
            received,
            ("补镜完成".to_owned(), format!("生成请求 #{request_id} 的素材已导入"))
        );
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(200)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "不多不少,恰好一条"
        );

        // R7 Task 5 复审 P3-2:同一条请求被**重新认领**(崩溃恢复、手工重排)
        // 时不能再响一次。请求已经是 imported,这次跃迁不会发生。
        {
            let mut connection = db::open_project(&db_path).unwrap();
            enqueue(
                &mut connection,
                "generation_poll",
                &format!("{{\"request_id\":{request_id}}}"),
                &format!("{request_id}-again"),
            )
            .unwrap();
        }
        let ran_again = JobRunner::run_one_with_executor(&db_path, &coordinator, "gen-owner", move |_db_path, connection, job| {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let transitioned =
                crate::core::generation::transition_to_imported(&transaction, request_id, None, None)?;
            transaction.commit()?;
            assert!(!transitioned, "已经是 imported 的请求不该再跃迁一次");
            mark_done(connection, job.id, job.attempt)
        })
        .unwrap();
        assert!(ran_again);
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(500)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout),
            "重新认领一条已经导入的请求不能再发一次通知"
        );
    }
}
