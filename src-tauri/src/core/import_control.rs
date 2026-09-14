//! Non-destructive import controls. Source media is never removed.
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;
use super::{error::{CoreError, Result}, jobs::Job};

#[derive(Debug, Serialize)]
pub struct ImportBatch {
    pub id: i64, pub source: String, pub status: String,
    pub total: i64, pub done: i64, pub running: i64, pub failed: i64,
    pub duplicates: i64, pub imported: i64,
}
pub fn create_batch(connection: &Connection, source: &str) -> Result<i64> {
    Ok(connection.query_row("INSERT INTO import_batches(episode_id,source) SELECT id,?1 FROM episodes WHERE status='active' RETURNING id", [source], |row| row.get(0))?)
}
pub fn ensure_batch_active(connection: &Connection, id: i64) -> Result<()> {
    let valid: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM import_batches b JOIN episodes e ON e.id=b.episode_id WHERE b.id=?1 AND b.status IN ('scanning','queued') AND e.status='active')", [id], |r| r.get(0))?;
    if valid { Ok(()) } else { Err(CoreError::Import("本次导入已取消".into())) }
}
pub fn ensure_job_current(connection: &Connection, job: &Job) -> Result<()> {
    let valid: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM jobs j LEFT JOIN import_batches b ON b.id=j.import_batch_id WHERE j.id=?1 AND j.attempt=?2 AND j.status='running' AND j.cancel_requested=0 AND (j.import_batch_id IS NULL OR b.status IN ('scanning','queued')))", params![job.id, job.attempt], |r| r.get(0))?;
    if valid { Ok(()) } else { Err(CoreError::Import("本次导入已取消或由新任务接管".into())) }
}
pub fn fail_scans(connection: &mut Connection, batch_id: Option<i64>) -> Result<()> {
    let transaction=connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute("UPDATE jobs SET cancel_requested=1,status=CASE WHEN status='pending' THEN 'failed' ELSE status END,blocked_summary='扫描中断，请重新导入',finished_at=CASE WHEN status='pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE finished_at END WHERE status IN ('pending','running') AND import_batch_id IN (SELECT id FROM import_batches WHERE status='scanning' AND (?1 IS NULL OR id=?1))",[batch_id])?;
    transaction.execute("UPDATE import_batches SET status='failed' WHERE status='scanning' AND (?1 IS NULL OR id=?1)",[batch_id])?;
    transaction.commit()?;
    Ok(())
}
pub fn list_batches(connection: &Connection) -> Result<Vec<ImportBatch>> {
    let mut statement = connection.prepare("SELECT b.id,b.source,CASE WHEN b.status='queued' AND NOT EXISTS(SELECT 1 FROM jobs WHERE import_batch_id=b.id AND status IN ('pending','running')) THEN 'completed' ELSE b.status END,
        (SELECT count(*) FROM jobs WHERE import_batch_id=b.id),
        (SELECT count(*) FROM jobs WHERE import_batch_id=b.id AND status='done'),
        (SELECT count(*) FROM jobs WHERE import_batch_id=b.id AND status='running'),
        (SELECT count(*) FROM jobs WHERE import_batch_id=b.id AND status IN ('failed','blocked') AND cancel_requested=0),
        (SELECT count(*) FROM jobs WHERE import_batch_id=b.id AND status='done' AND result_path IS NOT NULL),
        (SELECT count(*) FROM clips WHERE import_batch_id=b.id)
        FROM import_batches b JOIN episodes e ON b.episode_id=e.id WHERE e.status='active' AND b.status!='removed' ORDER BY b.id DESC LIMIT 12")?;
    let rows = statement.query_map([], |r| Ok(ImportBatch { id:r.get(0)?, source:r.get(1)?, status:r.get(2)?, total:r.get(3)?, done:r.get(4)?, running:r.get(5)?, failed:r.get(6)?, duplicates:r.get(7)?, imported:r.get(8)? }))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
fn ensure_batch_owned(connection: &Connection, id: i64) -> Result<()> {
    let owns: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM import_batches b JOIN episodes e ON b.episode_id=e.id WHERE b.id=?1 AND e.status='active')", [id], |r| r.get(0))?;
    if owns { Ok(()) } else { Err(CoreError::Import("不能改动已封存集的导入记录".into())) }
}
pub fn cancel_batch(connection: &mut Connection, id: i64) -> Result<()> {
    ensure_batch_owned(connection, id)?;
    connection.execute("UPDATE import_batches SET status='cancelled' WHERE id=?1 AND status!='removed'", [id])?;
    // Disable only roots overlapping this source, so auto-sync cannot resurrect
    // a cancelled/removed import. Sync can be explicitly enabled again in UI.
    let source: String = connection.query_row("SELECT source FROM import_batches WHERE id=?1", [id], |r| r.get(0))?;
    pause_overlapping_folders(connection, &[source])?;
    let ids = {
        let mut statement = connection.prepare("SELECT id FROM jobs WHERE status IN ('pending','running') AND (import_batch_id=?1 OR clip_id IN (SELECT clip_id FROM import_batch_clips WHERE batch_id=?1 UNION SELECT id FROM clips WHERE import_batch_id=?1))")?;
        let rows = statement.query_map([id], |r| r.get::<_,i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for job_id in ids { super::jobs::request_cancel(connection, job_id)?; }
    Ok(())
}
fn pause_overlapping_folders(connection: &Connection, sources: &[String]) -> Result<()> {
    for folder in super::import::list_watched_folders(connection)? {
        if sources.iter().any(|source| {
            let source = std::path::Path::new(source);
            let root = std::path::Path::new(&folder.path);
            source.starts_with(root) || root.starts_with(source)
        }) { super::import::set_watched_folder_sync(connection, folder.id, false)?; }
    }
    Ok(())
}
pub fn dismiss_notices(connection: &Connection) -> Result<usize> {
    Ok(connection.execute("UPDATE jobs SET import_dismissed=1 WHERE kind='import_probe' AND status IN ('done','failed','blocked') AND (result_path IS NOT NULL OR status!='done') AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.episode_id')=(SELECT id FROM episodes WHERE status='active')", [])?)
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RemovalRequest { pub batch_id: Option<i64>, pub clip_ids: Vec<i64>, pub all: bool }
#[derive(Debug, Serialize)]
pub struct RemovalPreview { pub clips: usize, pub favorites: i64, pub selections: i64, pub cache_entries: i64 }

/// R15:一组 id 变成 SQL 里能 `IN (SELECT value FROM json_each(?))` 的 JSON 数组文本。
pub(crate) fn ids_json(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_owned())
}
pub(crate) fn strings_json(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_owned())
}

pub fn removal_ids(connection: &Connection, request: &RemovalRequest) -> Result<Vec<i64>> {
    if request.all && (request.batch_id.is_some() || !request.clip_ids.is_empty()) { return Err(CoreError::Import("移除范围冲突".into())); }
    if request.batch_id.is_some() && !request.clip_ids.is_empty() { return Err(CoreError::Import("移除范围冲突".into())); }
    if let Some(id) = request.batch_id { ensure_batch_owned(connection, id)?; }
    let mut ids = if request.all || request.batch_id.is_some() {
        let mut statement = connection.prepare("SELECT c.id FROM clips c JOIN episodes e ON c.episode_id=e.id WHERE e.status='active' AND (?1 OR c.import_batch_id=?2)")?;
        let rows = statement.query_map(params![request.all, request.batch_id], |r| r.get::<_,i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    } else { request.clip_ids.clone() };
    ids.sort_unstable(); ids.dedup();
    for &id in &ids { super::episode::ensure_clip_writable(connection, id)?; }
    Ok(ids)
}
/// R15:三条集合查询,不再每条素材问三次。
pub fn preview(connection: &Connection, request: &RemovalRequest) -> Result<RemovalPreview> {
    let ids = removal_ids(connection, request)?;
    let json = ids_json(&ids);
    let favorites = connection.query_row("SELECT count(*) FROM ratings r JOIN segments s ON r.segment_id=s.id WHERE s.clip_id IN (SELECT value FROM json_each(?1))", [&json], |r| r.get::<_,i64>(0))?;
    let selections = connection.query_row("SELECT count(*) FROM segments WHERE kind='select' AND tombstone=0 AND clip_id IN (SELECT value FROM json_each(?1))", [&json], |r| r.get::<_,i64>(0))?;
    let cache_entries = connection.query_row("SELECT count(*) FROM cache_artifacts WHERE clip_id IN (SELECT value FROM json_each(?1))", [&json], |r| r.get::<_,i64>(0))?;
    Ok(RemovalPreview { clips: ids.len(), favorites, selections, cache_entries })
}
pub(crate) fn clip_paths(connection: &Connection, ids_json: &str) -> Result<Vec<String>> {
    let mut statement = connection.prepare("SELECT rel_path FROM clips WHERE id IN (SELECT value FROM json_each(?1))")?;
    let rows = statement.query_map([ids_json], |r| r.get::<_,String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
/// R15:把与这些素材 / 路径相关、还没跑完的任务一次性取消:pending 的一条 UPDATE 置 failed,
/// running 的逐个 `request_cancel`(要设进程内的取消标志,ffmpeg 才会被 kill),running 最多
/// 只有 worker 数那么几条。此前每个任务一次事务,2 000 个 pending 就是 2 000 次提交。
pub(crate) fn cancel_related_jobs(connection: &mut Connection, ids_json: &str, paths_json: &str, episode: Option<i64>) -> Result<()> {
    let active_episode = episode;
    let predicate = "clip_id IN (SELECT value FROM json_each(?1)) OR (kind='import_probe' AND json_valid(payload) AND json_extract(payload,'$.path') IN (SELECT value FROM json_each(?2))) OR (?3 IS NOT NULL AND json_valid(payload) AND json_extract(payload,'$.episode_id')=?3)";
    connection.execute(&format!("UPDATE jobs SET status='failed', cancel_requested=1, blocked_summary='用户已取消', owner_id=NULL, lease_expires_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending' AND ({predicate})"), params![ids_json, paths_json, active_episode])?;
    let running = {
        let mut statement = connection.prepare(&format!("SELECT id FROM jobs WHERE status='running' AND cancel_requested=0 AND ({predicate})"))?;
        let rows = statement.query_map(params![ids_json, paths_json, active_episode], |r| r.get::<_,i64>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for job_id in running { super::jobs::request_cancel(connection, job_id)?; }
    Ok(())
}
/// Called before pausing claims. Cancels every job that could still write for these clips
/// and returns the ids that will be removed.
pub fn prepare_removal(connection: &mut Connection, request: &RemovalRequest) -> Result<Vec<i64>> {
    let exports: i64 = connection.query_row("SELECT count(*) FROM jobs WHERE kind='export_package' AND status IN ('pending','running')", [], |r| r.get(0))?;
    if exports > 0 { return Err(CoreError::Import("有交付任务未结束，请先完成或取消交付，再移除素材".into())); }
    if request.all {
        let batch_ids = {
            let mut statement = connection.prepare("SELECT b.id FROM import_batches b JOIN episodes e ON b.episode_id=e.id WHERE e.status='active' AND b.status!='removed'")?;
            let rows = statement.query_map([], |r| r.get::<_,i64>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in batch_ids { cancel_batch(connection, id)?; }
        connection.execute("UPDATE watched_folders SET auto_sync=0", [])?;
    } else if let Some(id) = request.batch_id { cancel_batch(connection, id)?; }
    let ids = removal_ids(connection, request)?;
    let json = ids_json(&ids);
    let paths = clip_paths(connection, &json)?;
    pause_overlapping_folders(connection, &paths)?;
    let episode = if request.all { Some(super::episode::current_episode(connection)?.id) } else { None };
    cancel_related_jobs(connection, &json, &strings_json(&paths), episode)?;
    Ok(ids)
}
/// R15:等本次范围内 running 的任务退出(它们已被标 cancel,ffmpeg 20 ms 内被 kill),
/// 最多等 `timeout`;别的素材的任务不等。
pub fn wait_for_related_jobs(connection: &Connection, ids: &[i64], timeout: std::time::Duration) -> Result<bool> {
    let json = ids_json(ids);
    super::jobs::wait_until_no_running(connection, "clip_id IN (SELECT value FROM json_each(?1))", &[&json], timeout)
}
/// One transaction: retire job rows, delete the clips (foreign keys cascade to every
/// clip-scoped table) and hand the cache directories to a `cache_gc` job. A snapshot is
/// required by the caller. Claims must be paused by the caller.
pub fn remove_records(connection: &mut Connection, request: &RemovalRequest) -> Result<usize> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute("INSERT INTO settings(key,value,updated_at) VALUES ('import_generation','1',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    let ids = removal_ids(&transaction, request)?;
    let json = ids_json(&ids);
    let paths = strings_json(&clip_paths(&transaction, &json)?);
    // Retain history but free dedupe keys. Old attempts stay fenced by status;
    // retained job ids also keep SQLite from recycling ids under late callbacks.
    transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id,blocked_summary='素材已从库中移除' WHERE clip_id IN (SELECT value FROM json_each(?1))", [&json])?;
    transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id,blocked_summary='素材已从库中移除' WHERE kind='import_probe' AND json_valid(payload) AND json_extract(payload,'$.path') IN (SELECT value FROM json_each(?1))", [&paths])?;
    if request.all {
        transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id WHERE kind='import_probe' AND json_valid(payload) AND json_extract(payload,'$.episode_id')=(SELECT id FROM episodes WHERE status='active')", [])?;
        transaction.execute("UPDATE import_batches SET status='removed' WHERE episode_id=(SELECT id FROM episodes WHERE status='active')", [])?;
    } else if let Some(id) = request.batch_id {
        transaction.execute("UPDATE import_batches SET status='removed' WHERE id=?1", [id])?;
        transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id WHERE import_batch_id=?1", [id])?;
    }
    // Duplicate aliases may point at the removed content through another path.
    // Recheck them on the next explicit scan instead of keeping a stale done key.
    if !ids.is_empty() {
        transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id WHERE kind='import_probe' AND status='done' AND result_path IS NOT NULL AND json_valid(payload) AND json_extract(payload,'$.episode_id')=(SELECT id FROM episodes WHERE status='active')", [])?;
    }
    // Keep clip identifiers monotonic even after clearing the highest row. IDs
    // are used in cache paths and historical JSON, so they must not be recycled.
    let maximum: i64 = transaction.query_row("SELECT coalesce(max(id),0) FROM clips", [], |r| r.get(0))?;
    transaction.execute("INSERT INTO settings(key,value,updated_at) VALUES ('removed_clip_high_water',?1,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value=max(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))", [maximum.to_string()])?;
    transaction.execute("DELETE FROM clips WHERE id IN (SELECT value FROM json_each(?1))", [&json])?;
    super::cache_gc::enqueue_clip_dirs(&transaction, &ids)?;
    transaction.commit()?;
    Ok(ids.len())
}

/// R16 P2-4:「重新分析这条」的结果——重排了几项(0 = 这条已经分析完,没有需要重跑的)。
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RetryAnalysisOutcome { pub clip_id: i64, pub reset: usize, pub enqueued: usize }

/// R16 P2-4:这条素材上会被「重新分析」触及的任务种类——画质 / 运镜 / 时刻分 / 封面等派生物。
const RETRY_ANALYSIS_KINDS_SQL: &str = "('analyze_l1','analyze_motion','moments','thumbnail','strip','waveform','proxy')";

/// R16 P2-4:单条重跑分析。先把这条素材上失败 / 受阻的任务行**原地复位成 pending**(清失败标记;
/// `artifacts::enqueue_for_clip` 见到任何同哈希旧行都不再入队,所以失败的封面任务只能复位不能新建),
/// 再按既有入队逻辑补 L1 / 运镜 / 时刻分 / 封面(从没排过的这里补上;已经 done 的不重排)。
/// 原片不在原位时直接拒绝,给的是缺失页那句人话。
pub fn retry_clip_analysis(connection: &mut Connection, clip_id: i64) -> Result<RetryAnalysisOutcome> {
    let quick_hash: Option<String> = connection
        .query_row("SELECT quick_hash FROM clips WHERE id=?1", [clip_id], |r| r.get(0))
        .map_err(|_| CoreError::Import(format!("素材 {clip_id} 不存在")))?;
    let Some(quick_hash) = quick_hash else {
        return Err(CoreError::Import("这条素材还没登记成功;请重新导入它所在的文件夹".into()));
    };
    let path = super::media_source::verified_clip_path(connection, clip_id)
        .map_err(|error| CoreError::Import(error.to_string()))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let reset = transaction.execute(&format!(
        "UPDATE jobs SET status='pending', attempt=0, cancel_requested=0, blocked_summary=NULL,
             owner_id=NULL, lease_expires_at=NULL, finished_at=NULL,
             next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE clip_id=?1 AND status IN ('failed','blocked') AND kind IN {RETRY_ANALYSIS_KINDS_SQL}"), [clip_id])?;
    transaction.commit()?;
    let mut enqueued = 0;
    if super::analysis::enqueue_for_clip(connection, clip_id, &path, &quick_hash)?.is_some() { enqueued += 1; }
    if super::motion::enqueue_for_clip(connection, clip_id, &path, &quick_hash)?.is_some() { enqueued += 1; }
    if super::moments::enqueue_for_clip(connection, clip_id, &path, &quick_hash)?.is_some() { enqueued += 1; }
    let before: i64 = connection.query_row("SELECT count(*) FROM jobs WHERE clip_id=?1", [clip_id], |r| r.get(0))?;
    super::artifacts::enqueue_for_clip(connection, clip_id, &path, &quick_hash)?;
    let after: i64 = connection.query_row("SELECT count(*) FROM jobs WHERE clip_id=?1", [clip_id], |r| r.get(0))?;
    enqueued += usize::try_from(after - before).unwrap_or(0);
    Ok(RetryAnalysisOutcome { clip_id, reset, enqueued })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};
    #[test]
    fn interrupted_scan_cancels_partial_queue_and_updated_clip_analysis_is_stoppable() {
        let directory=TestDirectory::new(); let mut c=db::open_project(&directory.db_path()).unwrap();
        let batch=create_batch(&c,"/card").unwrap();
        let job=super::super::jobs::enqueue(&mut c,"import_probe","{}","partial").unwrap();
        c.execute("UPDATE jobs SET import_batch_id=?1 WHERE id=?2",params![batch,job]).unwrap();
        fail_scans(&mut c,None).unwrap();
        assert!(super::super::jobs::claim_next(&mut c).unwrap().is_none());
        assert_eq!(super::super::jobs::get(&c,job).unwrap().status,super::super::jobs::JobStatus::Failed);
        let second=create_batch(&c,"/card").unwrap();
        c.execute("INSERT INTO volumes(uuid) VALUES ('fixture')",[]).unwrap();
        c.execute("INSERT INTO clips(id,volume_uuid,rel_path,episode_id,import_batch_id) VALUES (1,'fixture','a.mp4',1,?1)",[batch]).unwrap();
        c.execute("INSERT INTO import_batch_clips(batch_id,clip_id) VALUES (?1,1)",[second]).unwrap();
        let derived=super::super::jobs::enqueue(&mut c,"analyze_l1",r#"{"clip_id":1}"#,"updated").unwrap();
        cancel_batch(&mut c,second).unwrap();
        assert_eq!(super::super::jobs::get(&c,derived).unwrap().status,super::super::jobs::JobStatus::Failed);
        assert!(removal_ids(&c,&RemovalRequest{batch_id:Some(second),clip_ids:vec![],all:false}).unwrap().is_empty());
    }

    /// A16-01(0.8.0 真机):「全部暂停」态 = 任务全是 pending、没有 running。这种批次必须仍按
    /// queued 列出、进度总数照旧 —— 这两条读取都不许按「有没有在跑」把它过滤成空。
    #[test]
    fn queued_batch_with_only_pending_jobs_is_still_listed_and_counted() {
        let directory=TestDirectory::new(); let mut c=db::open_project(&directory.db_path()).unwrap();
        let batch=create_batch(&c,"/walk-media").unwrap();
        c.execute("UPDATE import_batches SET status='queued' WHERE id=?1",[batch]).unwrap();
        c.execute("INSERT INTO volumes(uuid) VALUES ('fixture')",[]).unwrap();
        for id in 1..=3 {
            c.execute("INSERT INTO clips(id,volume_uuid,rel_path,episode_id,import_batch_id) VALUES (?1,'fixture',?2,1,?3)",params![id,format!("/walk-media/{id}.mp4"),batch]).unwrap();
            let job=super::super::jobs::enqueue(&mut c,"import_probe",&format!(r#"{{"episode_id":1,"clip_id":{id}}}"#),&format!("probe-{id}")).unwrap();
            c.execute("UPDATE jobs SET import_batch_id=?1 WHERE id=?2",params![batch,job]).unwrap();
        }
        let listed=list_batches(&c).unwrap();
        assert_eq!(listed.len(),1,"pending 任务的批次仍要列出");
        assert_eq!(listed[0].status,"queued");
        assert_eq!((listed[0].total,listed[0].done,listed[0].imported),(3,0,3));
        let progress=super::super::import::get_import_progress(&c).unwrap();
        assert_eq!((progress.total,progress.done,progress.running),(3,0,0),"暂停态总数照旧,只是没在跑");
    }

    #[test]
    fn undo_preserves_other_batches_original_files_and_cascades_selections() {
        let directory=TestDirectory::new();
        let mut c=db::open_project(&directory.db_path()).unwrap();
        let a=create_batch(&c,"/card-a").unwrap(); let b=create_batch(&c,"/card-b").unwrap();
        c.execute("INSERT INTO volumes(uuid) VALUES ('fixture')",[]).unwrap();
        for (id,batch) in [(1,a),(2,b)] {
            let path=directory.path().join(format!("{id}.mp4")); std::fs::write(&path,b"original").unwrap();
            c.execute("INSERT INTO clips(id,volume_uuid,rel_path,episode_id,import_batch_id) VALUES (?1,'fixture',?2,1,?3)",params![id,path.to_string_lossy(),batch]).unwrap();
        }
        c.execute("INSERT INTO segments(id,clip_id,in_ticks,out_ticks,kind,tombstone) VALUES (1,2,0,10,'select',0)",[]).unwrap();
        c.execute("INSERT INTO ratings(segment_id,rating_type,value,rated_at) VALUES (1,'binary',1,'now')",[]).unwrap();
        c.execute("INSERT INTO jobs(kind,payload,payload_hash,status,created_at,updated_at) VALUES ('noop','{','malformed','blocked','now','now')",[]).unwrap();
        let request=RemovalRequest{batch_id:Some(b),clip_ids:vec![],all:false};
        let impact=preview(&c,&request).unwrap(); assert_eq!(impact.clips,1);assert_eq!(impact.selections,1);assert_eq!(impact.favorites,1);
        prepare_removal(&mut c,&request).unwrap(); assert_eq!(remove_records(&mut c,&request).unwrap(),1);
        assert_eq!(c.query_row("SELECT id FROM clips",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(c.query_row("SELECT count(*) FROM ratings",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert!(directory.path().join("2.mp4").exists());
        assert_eq!(c.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    /// R15:撤销一批不等别的批次正在跑的任务;缓存目录交给 cache_gc,不在命令里同步删。
    #[test]
    fn removal_cancels_only_related_jobs_and_defers_cache_files() {
        let directory=TestDirectory::new(); let mut c=db::open_project(&directory.db_path()).unwrap();
        let cache=directory.path().join("cache");
        let a=create_batch(&c,"/card-a").unwrap(); let b=create_batch(&c,"/card-b").unwrap();
        c.execute("INSERT INTO volumes(uuid) VALUES ('fixture')",[]).unwrap();
        for (id,batch) in [(1,a),(2,a),(3,b)] {
            c.execute("INSERT INTO clips(id,volume_uuid,rel_path,episode_id,import_batch_id) VALUES (?1,'fixture',?2,1,?3)",params![id,format!("/card/{id}.mp4"),batch]).unwrap();
            std::fs::create_dir_all(cache.join(id.to_string())).unwrap();
        }
        let related=super::super::jobs::enqueue(&mut c,"proxy",r#"{"clip_id":1}"#,"p1").unwrap();
        let pending=super::super::jobs::enqueue(&mut c,"waveform",r#"{"clip_id":2}"#,"w2").unwrap();
        let unrelated=super::super::jobs::enqueue(&mut c,"proxy",r#"{"clip_id":3}"#,"p3").unwrap();
        c.execute("UPDATE jobs SET status='running' WHERE id IN (?1,?2)",params![related,unrelated]).unwrap();
        let request=RemovalRequest{batch_id:Some(a),clip_ids:vec![],all:false};
        let ids=prepare_removal(&mut c,&request).unwrap();
        assert_eq!(ids,vec![1,2]);
        assert_eq!(super::super::jobs::get(&c,pending).unwrap().status,super::super::jobs::JobStatus::Failed,"本批 pending 任务一次置 failed");
        let flagged: i64=c.query_row("SELECT cancel_requested FROM jobs WHERE id=?1",[related],|r|r.get(0)).unwrap();
        assert_eq!(flagged,1,"本批 running 任务要设取消标志");
        assert_eq!(super::super::jobs::get(&c,unrelated).unwrap().status,super::super::jobs::JobStatus::Running,"别的批次的任务不动");
        // 等相关任务:模拟 worker 退出后再等,超时也只是返回 false。
        assert!(!wait_for_related_jobs(&c,&ids,std::time::Duration::from_millis(120)).unwrap());
        c.execute("UPDATE jobs SET status='failed' WHERE id=?1",[related]).unwrap();
        assert!(wait_for_related_jobs(&c,&ids,std::time::Duration::from_millis(120)).unwrap());
        assert_eq!(remove_records(&mut c,&request).unwrap(),2);
        assert_eq!(c.query_row("SELECT count(*) FROM clips",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(super::super::jobs::get(&c,unrelated).unwrap().status,super::super::jobs::JobStatus::Running);
        assert!(cache.join("1").exists()&&cache.join("2").exists(),"缓存目录留给 cache_gc 后台删");
        let payload: String=c.query_row("SELECT payload FROM jobs WHERE kind='cache_gc' AND status='pending'",[],|r|r.get(0)).unwrap();
        assert_eq!(payload,r#"{"dirs":["1","2"]}"#);
        assert_eq!(c.query_row("SELECT count(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn removal_refuses_archived_clips_and_pending_exports_before_cancellation() {
        let directory=TestDirectory::new(); let mut c=db::open_project(&directory.db_path()).unwrap();
        c.execute("INSERT INTO volumes(uuid) VALUES ('fixture')",[]).unwrap();
        c.execute("INSERT INTO clips(id,volume_uuid,rel_path,episode_id) VALUES (1,'fixture','a.mp4',1)",[]).unwrap();
        super::super::episode::archive_current(&mut c,None).unwrap();
        assert!(removal_ids(&c,&RemovalRequest{batch_id:None,clip_ids:vec![1],all:false}).is_err());
        let id=super::super::jobs::enqueue(&mut c,"export_package","{}","export").unwrap();
        assert!(prepare_removal(&mut c,&RemovalRequest{batch_id:None,clip_ids:vec![],all:true}).is_err());
        assert_eq!(super::super::jobs::get(&c,id).unwrap().status,super::super::jobs::JobStatus::Pending);
    }

    /// R16 P2-4:失败的任务行原地复位成 pending(封面类只能复位,入队函数见旧行就跳过);
    /// 从没排过的 L1 补入队;已 done 的不重排;原片不在原位时拒绝。
    #[test]
    fn retry_clip_analysis_resets_failed_rows_and_enqueues_missing_ones() {
        let directory=TestDirectory::new(); let mut c=db::open_project(&directory.db_path()).unwrap();
        let file=directory.path().join("A.MOV"); std::fs::write(&file,b"video").unwrap();
        c.execute("INSERT INTO volumes(uuid) VALUES ('fixture')",[]).unwrap();
        let (quick,_)=super::super::import::quick_fingerprint(&file).unwrap();
        c.execute("INSERT INTO clips(id,volume_uuid,rel_path,episode_id,quick_hash,byte_size) VALUES (1,'fixture',?1,1,?2,5)",params![file.to_string_lossy().as_ref(),quick]).unwrap();
        // 一个失败的封面任务 + 一个已完成的运镜任务;L1 从没排过。
        let thumb=super::super::jobs::enqueue(&mut c,"thumbnail",r#"{"clip_id":1}"#,"t1").unwrap();
        c.execute("UPDATE jobs SET status='failed', blocked_summary='ffmpeg 退出 1', attempt=3 WHERE id=?1",[thumb]).unwrap();
        let motion=super::super::jobs::enqueue(&mut c,"analyze_motion",r#"{"clip_id":1}"#,"m1").unwrap();
        c.execute("UPDATE jobs SET status='done' WHERE id=?1",[motion]).unwrap();

        let outcome=retry_clip_analysis(&mut c,1).unwrap();
        assert_eq!(outcome.reset,1,"失败的封面任务复位");
        let (status,attempt,summary):(String,i64,Option<String>)=c.query_row("SELECT status,attempt,blocked_summary FROM jobs WHERE id=?1",[thumb],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!((status.as_str(),attempt,summary),("pending",0,None));
        assert!(outcome.enqueued>=1,"L1 从没排过,这次要补上");
        let l1: i64=c.query_row("SELECT count(*) FROM jobs WHERE kind='analyze_l1' AND clip_id=1 AND status='pending'",[],|r|r.get(0)).unwrap();
        assert_eq!(l1,1);
        assert_eq!(super::super::jobs::get(&c,motion).unwrap().status,super::super::jobs::JobStatus::Done,"已完成的不重排");

        // 原片不在了:拒绝,且不动任何行。
        std::fs::remove_file(&file).unwrap();
        let error=retry_clip_analysis(&mut c,1).unwrap_err().to_string();
        assert!(error.contains("原片不在原来的位置"),"{error}");
    }
}
