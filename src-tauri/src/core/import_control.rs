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
        let mut statement = connection.prepare("SELECT id FROM jobs WHERE status IN ('pending','running') AND (import_batch_id=?1 OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.clip_id') IN (SELECT clip_id FROM import_batch_clips WHERE batch_id=?1 UNION SELECT id FROM clips WHERE import_batch_id=?1))")?;
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
pub fn preview(connection: &Connection, request: &RemovalRequest) -> Result<RemovalPreview> {
    let ids = removal_ids(connection, request)?;
    let mut result = RemovalPreview { clips: ids.len(), favorites: 0, selections: 0, cache_entries: 0 };
    for id in ids {
        result.favorites += connection.query_row("SELECT count(*) FROM ratings r JOIN segments s ON r.segment_id=s.id WHERE s.clip_id=?1", [id], |r| r.get::<_,i64>(0))?;
        result.selections += connection.query_row("SELECT count(*) FROM segments WHERE clip_id=?1 AND kind='select' AND tombstone=0", [id], |r| r.get::<_,i64>(0))?;
        result.cache_entries += connection.query_row("SELECT count(*) FROM cache_artifacts WHERE clip_id=?1", [id], |r| r.get::<_,i64>(0))?;
    }
    Ok(result)
}
/// Called in the maintenance prepare phase, before waiting for active workers.
pub fn prepare_removal(connection: &mut Connection, request: &RemovalRequest) -> Result<()> {
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
    let paths = super::import::list_clips(connection)?.into_iter().filter(|c| c.id.is_some_and(|id| ids.contains(&id))).map(|c| c.path).collect::<Vec<_>>();
    pause_overlapping_folders(connection, &paths)?;
    let jobs = {
        let mut statement = connection.prepare("SELECT id,payload FROM jobs WHERE status IN ('pending','running')")?;
        let rows = statement.query_map([], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (job_id, payload) in jobs {
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
        if value["clip_id"].as_i64().is_some_and(|id| ids.contains(&id)) || value["path"].as_str().is_some_and(|p| paths.iter().any(|path| path==p)) || (request.all && value["episode_id"].as_i64()==Some(super::episode::current_episode(connection)?.id)) {
            super::jobs::request_cancel(connection, job_id)?;
        }
    }
    Ok(())
}
/// Workers must be drained before entering. A snapshot is required by the caller.
pub fn remove_records(connection: &mut Connection, request: &RemovalRequest) -> Result<usize> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute("INSERT INTO settings(key,value,updated_at) VALUES ('import_generation','1',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    let ids = removal_ids(&transaction, request)?;
    let paths = super::import::list_clips(&transaction)?.into_iter().filter(|c| c.id.is_some_and(|id| ids.contains(&id))).map(|c| c.path).collect::<Vec<_>>();
    // Retain history but free dedupe keys. Old attempts stay fenced by status;
    // retained job ids also keep SQLite from recycling ids under late callbacks.
    for &id in &ids {
        transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id,blocked_summary='素材已从库中移除' WHERE json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.clip_id')=?1", [id])?;
    }
    for path in paths {
        transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id,blocked_summary='素材已从库中移除' WHERE kind='import_probe' AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.path')=?1", [path])?;
    }
    if request.all {
        transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id WHERE kind='import_probe' AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.episode_id')=(SELECT id FROM episodes WHERE status='active')", [])?;
        transaction.execute("UPDATE import_batches SET status='removed' WHERE episode_id=(SELECT id FROM episodes WHERE status='active')", [])?;
    } else if let Some(id) = request.batch_id {
        transaction.execute("UPDATE import_batches SET status='removed' WHERE id=?1", [id])?;
        transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id WHERE import_batch_id=?1", [id])?;
    }
    // Duplicate aliases may point at the removed content through another path.
    // Recheck them on the next explicit scan instead of keeping a stale done key.
    if !ids.is_empty() {
        transaction.execute("UPDATE jobs SET status='failed',cancel_requested=1,import_dismissed=1,payload_hash=payload_hash||':removed:'||id WHERE kind='import_probe' AND status='done' AND result_path IS NOT NULL AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.episode_id')=(SELECT id FROM episodes WHERE status='active')", [])?;
    }
    // Keep clip identifiers monotonic even after clearing the highest row. IDs
    // are used in cache paths and historical JSON, so they must not be recycled.
    let maximum: i64 = transaction.query_row("SELECT coalesce(max(id),0) FROM clips", [], |r| r.get(0))?;
    transaction.execute("INSERT INTO settings(key,value,updated_at) VALUES ('removed_clip_high_water',?1,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value=max(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))", [maximum.to_string()])?;
    for &id in &ids { transaction.execute("DELETE FROM clips WHERE id=?1", [id])?; }
    transaction.commit()?;
    Ok(ids.len())
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
}
