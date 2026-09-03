use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, TransactionBehavior};

use super::error::{CoreError, Result};
use super::migrations::{Migration, LATEST_SCHEMA_VERSION, MIGRATIONS};

static READ_ONLY_PROJECTS: OnceLock<RwLock<HashSet<PathBuf>>> = OnceLock::new();
pub const SNAPSHOT_RETENTION: usize = 5;

#[derive(Debug)]
pub struct ProjectFileLock {
    file: File,
    path: PathBuf,
}

impl ProjectFileLock {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ProjectFileLock {
    fn drop(&mut self) {
        // SAFETY: the descriptor belongs to `self.file` and remains valid for
        // the duration of this call.
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub fn try_acquire_project_lock(path: &Path) -> Result<Option<ProjectFileLock>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let lock_path = path.with_extension("db.lock");
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)?;
    // SAFETY: flock only observes the live descriptor; ownership stays with
    // ProjectFileLock until Drop releases it.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(Some(ProjectFileLock {
            file,
            path: lock_path,
        }));
    }
    let error = std::io::Error::last_os_error();
    if matches!(error.raw_os_error(), Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN)
    {
        return Ok(None);
    }
    Err(error.into())
}

pub fn register_project_read_only(path: &Path) {
    let projects = READ_ONLY_PROJECTS.get_or_init(|| RwLock::new(HashSet::new()));
    projects
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(path.to_path_buf());
}

fn is_registered_read_only(path: &Path) -> bool {
    READ_ONLY_PROJECTS
        .get()
        .is_some_and(|projects| {
            projects
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(path)
        })
}

pub fn open_project(path: &Path) -> Result<Connection> {
    if is_registered_read_only(path) {
        return open_project_read_only(path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let existing_database = path.exists() && path.metadata().is_ok_and(|metadata| metadata.len() > 0);
    let mut connection = Connection::open(path)?;
    configure_connection(&connection)?;
    if existing_database {
        create_pre_migration_snapshot_if_needed(&connection, path)?;
    }
    migrate(&mut connection)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(connection)
}

fn create_pre_migration_snapshot_if_needed(connection: &Connection, db_path: &Path) -> Result<()> {
    let has_version_table: i64 = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'schema_version'
         )",
        [],
        |row| row.get(0),
    )?;
    if has_version_table == 0 {
        return Ok(());
    }
    let version = schema_version(connection)?;
    if version >= LATEST_SCHEMA_VERSION {
        return Ok(());
    }
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let stamp = format!(
        "pre-migration-v{version}-{}-{:03}",
        elapsed.as_secs(),
        elapsed.subsec_millis()
    );
    let snapshots_root = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("snapshots");
    create_snapshot_at(connection, &snapshots_root, &stamp)?;
    Ok(())
}

pub fn open_project_read_only(path: &Path) -> Result<Connection> {
    let connection = open_read_only_for_snapshot_validation(path)?;
    let version = schema_version(&connection)?;
    if version != LATEST_SCHEMA_VERSION {
        return Err(CoreError::UnsupportedSchema {
            found: version,
            supported: LATEST_SCHEMA_VERSION,
        });
    }
    Ok(connection)
}

fn open_read_only_for_snapshot_validation(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    configure_connection(&connection)?;
    let version = schema_version(&connection)?;
    if version > LATEST_SCHEMA_VERSION {
        return Err(CoreError::UnsupportedSchema {
            found: version,
            supported: LATEST_SCHEMA_VERSION,
        });
    }
    Ok(connection)
}

pub fn initialize(path: &Path) -> Result<()> {
    let connection = open_project(path)?;
    drop(connection);
    Ok(())
}

pub fn create_snapshot(connection: &Connection, snapshots_root: &Path) -> Result<PathBuf> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let stamp = format!("{}-{:03}", elapsed.as_secs(), elapsed.subsec_millis());
    create_snapshot_at(connection, snapshots_root, &stamp)
}

fn create_snapshot_at(
    connection: &Connection,
    snapshots_root: &Path,
    stamp: &str,
) -> Result<PathBuf> {
    std::fs::create_dir_all(snapshots_root)?;
    let target = snapshots_root.join(format!("project-{stamp}.db"));
    if target.exists() {
        return Err(CoreError::BackgroundTask(format!(
            "快照目标已存在：{}",
            target.display()
        )));
    }
    connection.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    validate_database_file(&target)?;
    rotate_snapshots(snapshots_root, SNAPSHOT_RETENTION)?;
    Ok(target)
}

pub fn list_snapshots(snapshots_root: &Path) -> Result<Vec<PathBuf>> {
    if !snapshots_root.exists() {
        return Ok(Vec::new());
    }
    let mut snapshots = std::fs::read_dir(snapshots_root)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(std::ffi::OsStr::to_str)
                    .is_some_and(|name| name.starts_with("project-") && name.ends_with(".db"))
        })
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    Ok(snapshots)
}

fn rotate_snapshots(snapshots_root: &Path, keep: usize) -> Result<()> {
    let snapshots = list_snapshots(snapshots_root)?;
    for expired in snapshots.into_iter().skip(keep) {
        std::fs::remove_file(expired)?;
    }
    Ok(())
}

pub fn validate_database_file(path: &Path) -> Result<i64> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    configure_connection(&connection)?;
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(CoreError::InvalidSchema(format!(
            "数据库完整性检查失败：{integrity}"
        )));
    }
    let version = schema_version(&connection)?;
    if version > LATEST_SCHEMA_VERSION {
        return Err(CoreError::UnsupportedSchema {
            found: version,
            supported: LATEST_SCHEMA_VERSION,
        });
    }
    Ok(version)
}

pub fn restore_snapshot(db_path: &Path, snapshot_path: &Path) -> Result<PathBuf> {
    let snapshots_root = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("snapshots");
    let requested_parent = snapshot_path.parent().unwrap_or_else(|| Path::new("."));
    if requested_parent != snapshots_root || !list_snapshots(&snapshots_root)?.contains(&snapshot_path.to_path_buf()) {
        return Err(CoreError::BackgroundTask(
            "只能恢复当前项目 snapshots 目录中的已登记快照".to_owned(),
        ));
    }
    validate_database_file(snapshot_path)?;
    let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let restore_id = uuid::Uuid::new_v4();
    let staged = parent.join(format!(".project.restore-{restore_id}.db"));
    std::fs::copy(snapshot_path, &staged)?;
    OpenOptions::new().read(true).write(true).open(&staged)?.sync_all()?;
    validate_database_file(&staged)?;

    let backup = parent.join(format!("project.db.pre-restore-{restore_id}"));
    let wal_path = sqlite_sidecar_path(db_path, "-wal");
    let shm_path = sqlite_sidecar_path(db_path, "-shm");
    let backup_wal = sqlite_sidecar_path(&backup, "-wal");
    let backup_shm = sqlite_sidecar_path(&backup, "-shm");
    if db_path.exists() {
        std::fs::rename(db_path, &backup)?;
    }
    let sidecars_moved = (|| -> Result<()> {
        if wal_path.exists() {
            std::fs::rename(&wal_path, &backup_wal)?;
        }
        if shm_path.exists() {
            std::fs::rename(&shm_path, &backup_shm)?;
        }
        Ok(())
    })();
    if let Err(error) = sidecars_moved {
        if backup.exists() {
            let _ = std::fs::rename(&backup, db_path);
        }
        if backup_wal.exists() {
            let _ = std::fs::rename(&backup_wal, &wal_path);
        }
        if backup_shm.exists() {
            let _ = std::fs::rename(&backup_shm, &shm_path);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&staged, db_path) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, db_path);
        }
        if backup_wal.exists() {
            let _ = std::fs::rename(&backup_wal, &wal_path);
        }
        if backup_shm.exists() {
            let _ = std::fs::rename(&backup_shm, &shm_path);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(error.into());
    }
    OpenOptions::new().read(true).write(true).open(db_path)?.sync_all()?;
    validate_database_file(db_path)?;
    Ok(backup)
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn configure_connection(connection: &Connection) -> Result<()> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

fn prepare_version_table(connection: &mut Connection) -> Result<()> {
    let table_exists: i64 = connection.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'schema_version'
         )",
        [],
        |row| row.get(0),
    )?;

    if table_exists == 0 {
        let transaction =
            connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version(version) VALUES (0);
             CREATE UNIQUE INDEX schema_version_single_row
             ON schema_version((1));",
        )?;
        transaction.commit()?;
        return Ok(());
    }

    let row_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))?;
    match row_count {
        0 => {
            return Err(CoreError::InvalidSchema(
                "schema_version must contain one row, found 0".into(),
            ));
        }
        1 => {}
        count => {
            return Err(CoreError::InvalidSchema(format!(
                "schema_version must contain one row, found {count}"
            )));
        }
    }
    Ok(())
}

/// 只读探测库版本是否超前(不加锁不迁移):旧版应用启动时先行判断,给优雅退出的机会。
pub fn check_schema_supported(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let has_table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_version'",
        [],
        |row| row.get(0),
    )?;
    if has_table == 0 {
        return Ok(());
    }
    let found = schema_version(&connection)?;
    if found > LATEST_SCHEMA_VERSION {
        return Err(CoreError::UnsupportedSchema {
            found,
            supported: LATEST_SCHEMA_VERSION,
        });
    }
    Ok(())
}

pub fn schema_version(connection: &Connection) -> Result<i64> {
    let mut statement = connection.prepare("SELECT version FROM schema_version")?;
    let mut rows = statement.query([])?;
    let version = rows
        .next()?
        .ok_or_else(|| CoreError::InvalidSchema("schema_version is empty".into()))?
        .get(0)?;
    if rows.next()?.is_some() {
        return Err(CoreError::InvalidSchema(
            "schema_version contains more than one row".into(),
        ));
    }
    Ok(version)
}

fn migrate(connection: &mut Connection) -> Result<()> {
    prepare_version_table(connection)?;
    migrate_with(connection, MIGRATIONS)
}

fn migrate_with(connection: &mut Connection, migrations: &[Migration]) -> Result<()> {
    let mut current = schema_version(connection)?;

    if current > LATEST_SCHEMA_VERSION {
        return Err(CoreError::UnsupportedSchema {
            found: current,
            supported: LATEST_SCHEMA_VERSION,
        });
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for migration in migrations {
        if migration.version <= current {
            continue;
        }
        // Version numbers may be reserved by another integration lane. The migration
        // array remains the source of truth and must stay strictly ordered; applying
        // the next listed version makes an intentional numeric gap safe for both a
        // lane database (10 -> 12) and a merged database that already reached 11.

        transaction.execute_batch(migration.sql)?;
        let changed = transaction.execute(
            "UPDATE schema_version SET version = ?1 WHERE version = ?2",
            (migration.version, current),
        )?;
        if changed != 1 {
            return Err(CoreError::InvalidSchema(
                "schema_version changed while applying a migration".into(),
            ));
        }
        current = migration.version;
    }
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_support::TestDirectory;

    #[test]
    fn migrates_an_empty_database_to_latest() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).expect("database should initialize");

        assert_eq!(schema_version(&connection).unwrap(), LATEST_SCHEMA_VERSION);
        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN
                 ('volumes', 'clips', 'segments', 'ratings', 'tags', 'jobs', 'exports',
                  'cache_artifacts', 'clip_embeddings', 'transcript_segments',
                  'similar_groups', 'similar_group_members', 'chapters', 'story_order',
                  'story_history', 'llm_ledger', 'clip_dimensions', 'scenes',
                  'shot_stacks', 'shot_stack_members', 'shot_stack_preferences',
                  'episodes', 'narrative_chapters', 'narrative_beats',
                  'destination_cards', 'narrative_boundary_signals', 'rescue_ranges',
                  'ai_descriptions', 'proxy_time_map', 'vfr_time_map')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 30);
    }

    #[test]
    fn second_start_does_not_reapply_migrations() {
        let directory = TestDirectory::new();
        {
            let mut connection = open_project(&directory.db_path()).unwrap();
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "INSERT INTO volumes(uuid, label) VALUES ('volume-a', 'Camera A')",
                    [],
                )
                .unwrap();
            transaction.commit().unwrap();
        }

        let connection = open_project(&directory.db_path()).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM volumes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(schema_version(&connection).unwrap(), crate::core::migrations::LATEST_SCHEMA_VERSION);
    }

    #[test]
    fn upgrade_creates_a_valid_pre_migration_snapshot() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let mut connection = Connection::open(&db_path).unwrap();
        configure_connection(&connection).unwrap();
        prepare_version_table(&mut connection).unwrap();
        let migrations_through_v25 = MIGRATIONS
            .iter()
            .filter(|migration| migration.version <= 25)
            .map(|migration| Migration {
                version: migration.version,
                sql: migration.sql,
            })
            .collect::<Vec<_>>();
        migrate_with(&mut connection, &migrations_through_v25).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid, label) VALUES ('before-upgrade', 'kept')", [])
            .unwrap();
        drop(connection);

        let upgraded = open_project(&db_path).unwrap();
        assert_eq!(schema_version(&upgraded).unwrap(), LATEST_SCHEMA_VERSION);
        drop(upgraded);

        let snapshots = list_snapshots(&directory.path().join("snapshots")).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert!(snapshots[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("pre-migration-v25"));
        let snapshot = open_read_only_for_snapshot_validation(&snapshots[0]).unwrap();
        assert_eq!(schema_version(&snapshot).unwrap(), 25);
        let label: String = snapshot
            .query_row(
                "SELECT label FROM volumes WHERE uuid='before-upgrade'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(label, "kept");
    }

    #[test]
    fn migration_0028_splits_cross_episode_stacks_without_losing_manual_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        prepare_version_table(&mut connection).unwrap();
        let through_v27 = MIGRATIONS
            .iter()
            .filter(|migration| migration.version <= 27)
            .map(|migration| Migration {
                version: migration.version,
                sql: migration.sql,
            })
            .collect::<Vec<_>>();
        migrate_with(&mut connection, &through_v27).unwrap();
        let first_episode: i64 = connection
            .query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0))
            .unwrap();
        connection
            .execute(
                "UPDATE episodes SET status='archived', archived_at='now' WHERE id=?1",
                [first_episode],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number, memory_id)
                 VALUES ('EP02', '', 'now', 'active', 2, lower(hex(randomblob(16))))",
                [],
            )
            .unwrap();
        let second_episode = connection.last_insert_rowid();
        connection.execute("INSERT INTO volumes(uuid) VALUES ('v28')", []).unwrap();
        for (id, episode_id) in [(1_i64, first_episode), (2, second_episode), (3, first_episode)] {
            connection
                .execute(
                    "INSERT INTO clips(id, volume_uuid, rel_path, imported_at, episode_id)
                     VALUES (?1, 'v28', ?2, 'now', ?3)",
                    rusqlite::params![id, format!("{id}.mov"), episode_id],
                )
                .unwrap();
        }
        connection
            .execute("INSERT INTO scenes(id, name, kind) VALUES (1, '旧全局', 'unassigned')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO shot_stacks(id, scene_id, subject_label, function_label, created_at)
                 VALUES (1, 1, '风景', 'Atmosphere', 'now'),
                        (2, 1, '车辆', 'Action', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO shot_stack_members(
                    stack_id, clip_id, segment_id, best_take_score, score_breakdown_json, user_state
                 ) VALUES (1, 1, NULL, 0.4, '{}', 'rejected'),
                          (1, 2, NULL, 0.9, '{}', 'hero'),
                          (2, 3, NULL, 0.8, '{}', 'locked')",
                [],
            )
            .unwrap();

        let source = MIGRATIONS.iter().find(|migration| migration.version == 28).unwrap();
        let migration = Migration { version: source.version, sql: source.sql };
        migrate_with(&mut connection, &[migration]).unwrap();

        let rows: Vec<(i64, i64, String)> = {
            let mut statement = connection
                .prepare(
                    "SELECT scene.episode_id, member.clip_id, member.user_state
                       FROM shot_stack_members member
                       JOIN shot_stacks stack ON stack.id = member.stack_id
                       JOIN scenes scene ON scene.id = stack.scene_id
                      ORDER BY member.clip_id",
                )
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(
            rows,
            vec![
                (first_episode, 1, "rejected".to_owned()),
                (second_episode, 2, "hero".to_owned()),
                (first_episode, 3, "locked".to_owned()),
            ]
        );
        assert_eq!(schema_version(&connection).unwrap(), 28);
    }

    #[test]
    fn pending_migrations_commit_as_one_transaction() {
        let mut connection = Connection::open_in_memory().unwrap();
        configure_connection(&connection).unwrap();
        prepare_version_table(&mut connection).unwrap();
        let migrations = [
            Migration {
                version: 1,
                sql: "CREATE TABLE should_roll_back(id INTEGER PRIMARY KEY);",
            },
            Migration {
                version: 2,
                sql: "THIS IS NOT VALID SQL;",
            },
        ];

        assert!(migrate_with(&mut connection, &migrations).is_err());
        assert_eq!(schema_version(&connection).unwrap(), 0);
        let table_exists: i64 = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='should_roll_back')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 0);
    }

    #[test]
    fn rejects_a_database_newer_than_the_application() {
        let directory = TestDirectory::new();
        {
            let mut connection = open_project(&directory.db_path()).unwrap();
            let transaction = connection.transaction().unwrap();
            transaction
                .execute("UPDATE schema_version SET version = 99", [])
                .unwrap();
            transaction.commit().unwrap();
        }

        let error = open_project(&directory.db_path()).unwrap_err();
        assert!(matches!(
            error,
            CoreError::UnsupportedSchema {
                found: 99,
                supported: crate::core::migrations::LATEST_SCHEMA_VERSION
            }
        ));
    }

    #[test]
    fn enables_wal_foreign_keys_and_single_version_row() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();

        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        let version_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
            .unwrap();

        assert_eq!(journal_mode.to_lowercase(), "wal");
        assert_eq!(foreign_keys, 1);
        assert_eq!(version_rows, 1);
    }

    #[test]
    fn ratings_cannot_be_overwritten() {
        let directory = TestDirectory::new();
        let mut connection = open_project(&directory.db_path()).unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute("INSERT INTO volumes(uuid) VALUES ('volume-rating')", [])
            .unwrap();
        transaction
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path)
                 VALUES ('volume-rating', 'clip.mov')",
                [],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO segments(clip_id, in_ticks, out_ticks)
                 VALUES (1, 0, 100)",
                [],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO ratings(segment_id, rating_type, value, rated_at)
                 VALUES (1, 'stars', 4, '2026-08-31T00:00:00Z')",
                [],
            )
            .unwrap();
        transaction.commit().unwrap();

        let transaction = connection.transaction().unwrap();
        let update = transaction.execute("UPDATE ratings SET value = 5 WHERE id = 1", []);
        assert!(update.is_err());
    }

    #[test]
    fn cache_artifacts_are_unique_per_clip_kind_and_cascade_with_the_clip() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid) VALUES ('cache-volume')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO clips(volume_uuid, rel_path, quick_hash)
                 VALUES ('cache-volume', 'clip.mov', 'source-a')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO cache_artifacts(
                    clip_id, kind, rel_path, source_hash, bytes, created_at
                 ) VALUES (1, 'cover', '1/cover.jpg', 'source-a', 12,
                           '2026-08-31T00:00:00Z')",
                [],
            )
            .unwrap();

        assert!(connection
            .execute(
                "INSERT INTO cache_artifacts(
                    clip_id, kind, rel_path, source_hash, bytes, created_at
                 ) VALUES (1, 'cover', '1/cover-new.jpg', 'source-a', 12,
                           '2026-08-31T00:00:01Z')",
                [],
            )
            .is_err());
        connection.execute("DELETE FROM clips WHERE id = 1", []).unwrap();
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM cache_artifacts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn project_file_lock_allows_exactly_one_writer() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();

        let first = try_acquire_project_lock(&db_path).unwrap();
        let second = try_acquire_project_lock(&db_path).unwrap();

        assert!(first.is_some());
        assert!(second.is_none(), "第二实例不得取得项目写锁");
    }

    #[test]
    fn read_only_open_never_runs_migrations_or_accepts_writes() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        open_project(&db_path).unwrap();

        let connection = open_project_read_only(&db_path).unwrap();

        assert_eq!(schema_version(&connection).unwrap(), LATEST_SCHEMA_VERSION);
        assert!(connection
            .execute("INSERT INTO volumes(uuid) VALUES ('forbidden')", [])
            .is_err());
    }

    #[test]
    fn migration_0013_adds_lease_cancel_and_active_export_uniqueness() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();
        let columns: String = connection
            .query_row(
                "SELECT group_concat(name, ',') FROM pragma_table_info('jobs')
                 WHERE name IN ('owner_id', 'lease_expires_at', 'cancel_requested')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let index_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND name='jobs_active_export_payload_unique_idx'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(columns, "owner_id,lease_expires_at,cancel_requested");
        assert_eq!(index_exists, 1);
    }

    #[test]
    fn migration_0014_adds_scene_stack_state_and_feedback_tables() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();
        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN (
                   'scenes', 'shot_stacks', 'shot_stack_members', 'shot_stack_preferences'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let user_state_check: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'table' AND name = 'shot_stack_members'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(table_count, 4);
        assert!(user_state_check.contains("'auto', 'locked', 'rejected', 'hero'"));
    }

    #[test]
    fn migration_0015_adds_narrative_v2_and_extends_the_llm_ledger() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();
        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN (
                   'episodes', 'narrative_chapters', 'narrative_beats',
                   'destination_cards', 'narrative_boundary_signals'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let ledger_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_ledger'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(table_count, 5);
        assert!(ledger_sql.contains("'narrate_episode'"));
    }

    #[test]
    fn migration_0017_persists_the_latest_ai_description_per_clip() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();
        let sql: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_descriptions'",
            [],
            |row| row.get(0),
        ).unwrap();

        assert!(sql.contains("clip_id INTEGER PRIMARY KEY"));
        assert_eq!(schema_version(&connection).unwrap(), LATEST_SCHEMA_VERSION);
    }

    #[test]
    fn migration_0018_adds_temporal_metadata_and_proxy_mapping() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();

        let temporal_columns: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('clips')
                 WHERE name IN (
                    'audio_sample_rate', 'rotation', 'color_transfer', 'hdr_flag',
                    'tz_guess', 'tz_conflict', 'device_model', 'journey_offset_ms',
                    'journey_offset_source', 'journey_offset_confidence'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(temporal_columns, 10);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'table' AND name = 'proxy_time_map'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn migration_0019_adds_vfr_sampling_state_and_table() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();

        let checked_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('clips')
                 WHERE name = 'vfr_timing_checked' AND \"notnull\" = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let map_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'vfr_time_map'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!((checked_column, map_table), (1, 1));
        assert_eq!(schema_version(&connection).unwrap(), crate::core::migrations::LATEST_SCHEMA_VERSION);
    }

    #[test]
    fn snapshot_is_a_valid_standalone_copy_of_wal_state() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid, label) VALUES ('snapshot-a', 'A')", [])
            .unwrap();

        let snapshot = create_snapshot_at(&connection, &directory.path().join("snapshots"), "001")
            .unwrap();
        let copy = open_project_read_only(&snapshot).unwrap();
        let label: String = copy
            .query_row("SELECT label FROM volumes WHERE uuid='snapshot-a'", [], |row| row.get(0))
            .unwrap();

        assert_eq!(label, "A");
        assert_eq!(validate_database_file(&snapshot).unwrap(), LATEST_SCHEMA_VERSION);
    }

    #[test]
    fn snapshot_rotation_keeps_only_the_latest_five() {
        let directory = TestDirectory::new();
        let connection = open_project(&directory.db_path()).unwrap();
        let snapshots = directory.path().join("snapshots");

        for stamp in ["001", "002", "003", "004", "005", "006", "007"] {
            create_snapshot_at(&connection, &snapshots, stamp).unwrap();
        }

        let names = list_snapshots(&snapshots)
            .unwrap()
            .into_iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), SNAPSHOT_RETENTION);
        assert_eq!(names.first().map(String::as_str), Some("project-007.db"));
        assert_eq!(names.last().map(String::as_str), Some("project-003.db"));
    }

    #[test]
    fn restore_backfills_project_and_preserves_the_displaced_database() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        let connection = open_project(&db_path).unwrap();
        connection
            .execute("INSERT INTO volumes(uuid, label) VALUES ('before', 'snapshot')", [])
            .unwrap();
        let snapshot = create_snapshot_at(&connection, &directory.path().join("snapshots"), "001")
            .unwrap();
        connection
            .execute("UPDATE volumes SET label='changed' WHERE uuid='before'", [])
            .unwrap();
        drop(connection);

        let backup = restore_snapshot(&db_path, &snapshot).unwrap();
        let restored = open_project_read_only(&db_path).unwrap();
        let restored_label: String = restored
            .query_row("SELECT label FROM volumes WHERE uuid='before'", [], |row| row.get(0))
            .unwrap();
        let displaced = open_project_read_only(&backup).unwrap();
        let displaced_label: String = displaced
            .query_row("SELECT label FROM volumes WHERE uuid='before'", [], |row| row.get(0))
            .unwrap();

        assert_eq!(restored_label, "snapshot");
        assert_eq!(displaced_label, "changed");
    }

    #[test]
    fn restore_refuses_files_outside_the_project_snapshot_registry() {
        let directory = TestDirectory::new();
        let db_path = directory.db_path();
        open_project(&db_path).unwrap();
        let outsider = directory.path().join("outsider.db");
        std::fs::copy(&db_path, &outsider).unwrap();

        let error = restore_snapshot(&db_path, &outsider).unwrap_err();
        assert!(error.to_string().contains("snapshots"));
    }
}
