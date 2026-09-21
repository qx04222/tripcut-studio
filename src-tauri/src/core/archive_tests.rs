use super::*;
use crate::core::{db, test_support::TestDirectory};
use std::cell::Cell;

struct Fixture {
    dir: TestDirectory,
    db: Connection,
    sources: Vec<PathBuf>,
    id: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = TestDirectory::new();
        let db = db::open_project(&dir.db_path()).unwrap();
        let sources: Vec<_> = ["IMG.JPG", "IMG.ARW", "IMG.ARW.xmp"]
            .iter()
            .map(|n| dir.path().join(n))
            .collect();
        for (i, source) in sources.iter().enumerate() {
            std::fs::write(source, format!("original-{i}").repeat(10000)).unwrap();
        }
        let specs = sources
            .iter()
            .map(|p| (p.clone(), PathBuf::from(p.file_name().unwrap())))
            .collect();
        let id = begin(&db, "photo", &dir.path().join("export"), specs, None).unwrap();
        seal_copies(&db, &id).unwrap();
        Self {
            dir,
            db,
            sources,
            id,
        }
    }
    fn originals(&self) {
        for (i, p) in self.sources.iter().enumerate() {
            assert_eq!(
                std::fs::read(p).unwrap(),
                format!("original-{i}").repeat(10000).as_bytes()
            );
        }
    }
    fn reopen(&mut self) {
        self.db = db::open_project(&self.dir.db_path()).unwrap();
    }
}

struct Fault {
    at: &'static str,
    panic: bool,
    fired: Cell<bool>,
    code: i32,
}
impl ArchiveFs for Fault {
    fn checkpoint(&self, name: &str) -> std::io::Result<()> {
        if name == self.at && (name != "before_publish" || self.panic) && !self.fired.replace(true)
        {
            if self.panic {
                panic!("crash after {name}");
            }
            return Err(std::io::Error::from_raw_os_error(self.code));
        }
        Ok(())
    }
    fn copy(&self, input: &mut File, output: &mut File) -> std::io::Result<u64> {
        if self.at == "write" && !self.fired.replace(true) {
            output.write_all(b"short write")?;
            return Err(std::io::Error::from_raw_os_error(self.code));
        }
        std::io::copy(input, output)
    }
    fn publish(&self, source: &Path, target: &Path) -> std::io::Result<()> {
        if self.at == "before_publish" && !self.panic && !self.fired.replace(true) {
            return Err(std::io::Error::from_raw_os_error(self.code));
        }
        rename_exclusive(source, target)
    }
}
fn fault(at: &'static str, panic: bool, code: i32) -> Fault {
    Fault {
        at,
        panic,
        code,
        fired: Cell::new(false),
    }
}

#[test]
fn all_faults_are_partial_and_retry_without_touching_originals() {
    for (at, code) in [
        ("write", libc::ENOSPC),
        ("before_publish", libc::EIO),
        ("before_publish", libc::EXDEV),
    ] {
        let mut f = Fixture::new();
        assert!(
            execute_with(&f.db, &f.id, &fault(at, false, code)).is_err(),
            "{at}"
        );
        assert_eq!(get(&f.db, &f.id).unwrap().status, "partial");
        f.originals();
        f.reopen();
        let result = execute(&f.db, &f.id).unwrap();
        assert_eq!(result.status, "done");
        assert_eq!(
            execute(&f.db, &f.id).unwrap().destination,
            result.destination
        );
        f.originals();
        for p in &f.sources {
            assert_eq!(
                std::fs::read(p).unwrap(),
                std::fs::read(result.destination.join(p.file_name().unwrap())).unwrap()
            );
        }
    }
}

#[test]
fn crash_at_every_durable_and_filesystem_boundary_is_idempotent() {
    for at in [
        "running",
        "temp_created",
        "copy_synced",
        "copied",
        "verified",
        "before_publish",
        "renamed",
        "published",
        "done",
    ] {
        let mut f = Fixture::new();
        let injected = fault(at, true, libc::EIO);
        let crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            execute_with(&f.db, &f.id, &injected)
        }));
        assert!(crash.is_err(), "did not visit {at}");
        f.originals();
        f.reopen();
        reconcile(&f.db).unwrap();
        reconcile(&f.db).unwrap();
        let result = execute(&f.db, &f.id).unwrap();
        assert_eq!(result.status, "done", "{at}");
        f.originals();
        assert_eq!(std::fs::read_dir(result.destination).unwrap().count(), 3);
    }
}

#[test]
fn conflict_moves_whole_group_and_preserves_foreign_data() {
    let f = Fixture::new();
    let existing = f.dir.path().join("export");
    std::fs::create_dir(&existing).unwrap();
    std::fs::write(existing.join("IMG.JPG"), b"foreign").unwrap();
    let result = execute(&f.db, &f.id).unwrap();
    assert_ne!(result.destination, existing);
    assert_eq!(std::fs::read(existing.join("IMG.JPG")).unwrap(), b"foreign");
    for source in &f.sources {
        assert!(result
            .destination
            .join(source.file_name().unwrap())
            .is_file());
    }
    f.originals();
}

#[test]
fn undo_preserves_edited_and_identical_replacement_files() {
    let f = Fixture::new();
    let out = execute(&f.db, &f.id).unwrap().destination;
    std::fs::write(out.join("IMG.JPG"), b"user edit").unwrap();
    let replacement = f.dir.path().join("replacement");
    std::fs::copy(&f.sources[1], &replacement).unwrap();
    std::fs::rename(replacement, out.join("IMG.ARW")).unwrap();
    let result = undo(&f.db, &f.id).unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(std::fs::read(out.join("IMG.JPG")).unwrap(), b"user edit");
    assert!(out.join("IMG.ARW").exists());
    assert!(!out.join("IMG.ARW.xmp").exists());
    undo(&f.db, &f.id).unwrap();
    reconcile(&f.db).unwrap();
    f.originals();
    assert_eq!(
        f.db.query_row(
            "SELECT count(*) FROM archive_op_files WHERE op_id=?1 AND status='conflict'",
            [&f.id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn undo_crashes_are_recoverable_and_do_not_recopy() {
    for at in ["undoing", "quarantined", "deleted", "undone"] {
        let mut f = Fixture::new();
        let out = execute(&f.db, &f.id).unwrap().destination;
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| undo_with(
                &f.db,
                &f.id,
                &fault(at, true, libc::EIO)
            )))
            .is_err(),
            "{at}"
        );
        f.reopen();
        reconcile(&f.db).unwrap();
        reconcile(&f.db).unwrap();
        assert_eq!(get(&f.db, &f.id).unwrap().status, "undone");
        for p in &f.sources {
            assert!(!out.join(p.file_name().unwrap()).exists());
        }
        f.originals();
    }
}

#[test]
fn source_change_and_corrupt_published_file_never_report_done() {
    let f = Fixture::new();
    std::fs::write(&f.sources[1], b"changed by user").unwrap();
    assert!(execute(&f.db, &f.id).is_err());
    assert_ne!(get(&f.db, &f.id).unwrap().status, "done");
    let f = Fixture::new();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        execute_with(&f.db, &f.id, &fault("renamed", true, libc::EIO))
    }));
    let out = get(&f.db, &f.id).unwrap().destination;
    std::fs::write(out.join("IMG.JPG"), b"edit after crash").unwrap();
    reconcile(&f.db).unwrap();
    reconcile(&f.db).unwrap();
    assert_ne!(get(&f.db, &f.id).unwrap().status, "done");
    assert_eq!(
        std::fs::read(out.join("IMG.JPG")).unwrap(),
        b"edit after crash"
    );
    f.originals();
}

#[test]
fn preparation_is_durable_and_never_claimed_complete() {
    let f = Fixture::new();
    let specs = f
        .sources
        .iter()
        .map(|p| (p.clone(), PathBuf::from(p.file_name().unwrap())))
        .collect();
    let id = begin(&f.db, "kit", &f.dir.path().join("incomplete"), specs, None).unwrap();
    reconcile(&f.db).unwrap();
    assert_ne!(get(&f.db, &id).unwrap().status, "done");
    assert!(!f.dir.path().join("incomplete").exists());
    f.originals();
}

#[test]
fn symlinks_and_output_inside_source_are_rejected() {
    let f = Fixture::new();
    let link = f.dir.path().join("link");
    std::os::unix::fs::symlink(&f.sources[0], &link).unwrap();
    assert!(begin(
        &f.db,
        "photo",
        &f.dir.path().join("symlink-out"),
        vec![(link, "a".into())],
        None
    )
    .is_err());
    assert!(begin(
        &f.db,
        "photo",
        f.dir.path(),
        vec![(f.sources[0].clone(), "a".into())],
        None
    )
    .is_err());
    assert!(begin(
        &f.db,
        "photo",
        &f.dir.path().join("out"),
        vec![(f.sources[0].clone(), "../escape".into())],
        None
    )
    .is_err());
    f.originals();
}

#[test]
fn migration_0054_archive_protocol() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    for migration in super::super::migrations::MIGRATIONS {
        c.execute_batch(migration.sql).unwrap();
    }
    c.execute(
        "INSERT INTO archive_ops(id,kind,status,plan_json) VALUES('test','photo','undoing','{}')",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO archive_op_files(op_id,src_path,src_size,src_hash,dst_path,dst_temp,status) VALUES('test','src',1,'hash','dst','tmp','planned')", []).unwrap();
    assert!(c.execute("UPDATE archive_ops SET kind='move'", []).is_err());
}

#[test]
fn unlogged_directory_creation_and_file_publish_crashes_recover() {
    for at in ["stage_created", "payload_created", "planned", "staged"] {
        let mut f = Fixture::new();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute_with(
                &f.db,
                &f.id,
                &fault(at, true, libc::EIO)
            )))
            .is_err(),
            "{at}"
        );
        f.reopen();
        reconcile(&f.db).unwrap();
        reconcile(&f.db).unwrap();
        assert_eq!(get(&f.db, &f.id).unwrap().status, "done");
        f.originals();
    }
}

#[test]
fn undo_unstarted_plan_finishes_without_touching_sources() {
    let f = Fixture::new();
    assert_eq!(undo(&f.db, &f.id).unwrap().status, "undone");
    reconcile(&f.db).unwrap();
    f.originals();
}

#[test]
fn claim_serializes_the_same_operation_and_undo_keeps_extra_files() {
    let f = Fixture::new();
    let plan = load(&f.db, &f.id).unwrap().plan;
    let claim = Claim::acquire(&plan, &f.id).unwrap();
    assert!(execute(&f.db, &f.id).is_err());
    drop(claim);
    let out = execute(&f.db, &f.id).unwrap().destination;
    std::fs::write(out.join("user-added.txt"), b"keep").unwrap();
    assert_eq!(undo(&f.db, &f.id).unwrap().status, "undone");
    assert_eq!(std::fs::read(out.join("user-added.txt")).unwrap(), b"keep");
    f.originals();
}

struct CompanionFailure {
    copies: Cell<usize>,
    crash: Option<&'static str>,
}
impl ArchiveFs for CompanionFailure {
    fn copy(&self, input: &mut File, output: &mut File) -> std::io::Result<u64> {
        let count = self.copies.get() + 1;
        self.copies.set(count);
        if count == 2 {
            output.write_all(b"partial RAW")?;
            return Err(std::io::Error::from_raw_os_error(libc::ENOSPC));
        }
        std::io::copy(input, output)
    }
    fn checkpoint(&self, name: &str) -> std::io::Result<()> {
        if self.crash == Some(name) {
            panic!("crash after {name}");
        }
        Ok(())
    }
}
#[test]
fn companion_failure_and_failed_partial_status_crashes_never_complete_a_subset() {
    for crash in [None, Some("failed"), Some("partial")] {
        let mut f = Fixture::new();
        let fault = CompanionFailure {
            copies: Cell::new(0),
            crash,
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            execute_with(&f.db, &f.id, &fault)
        }));
        if crash.is_some() {
            assert!(result.is_err());
        } else {
            assert!(result.unwrap().is_err());
        }
        assert_eq!(get(&f.db, &f.id).unwrap().status, "partial");
        assert!(!f.dir.path().join("export").exists());
        assert_eq!(
            f.db.query_row(
                "SELECT count(*) FROM archive_op_files WHERE op_id=?1 AND status='verified'",
                [&f.id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        f.reopen();
        reconcile(&f.db).unwrap();
        reconcile(&f.db).unwrap();
        assert_eq!(get(&f.db, &f.id).unwrap().status, "done");
        f.originals();
    }
}

#[test]
fn replaced_destination_volume_is_not_silently_adopted() {
    let f = Fixture::new();
    let mount = f.dir.path().join("mount");
    std::fs::create_dir(&mount).unwrap();
    let id = begin(
        &f.db,
        "photo",
        &mount.join("out"),
        vec![(f.sources[0].clone(), "IMG.JPG".into())],
        None,
    )
    .unwrap();
    seal_copies(&f.db, &id).unwrap();
    std::fs::rename(&mount, f.dir.path().join("detached")).unwrap();
    std::fs::create_dir(&mount).unwrap();
    assert!(execute(&f.db, &id).is_err());
    assert!(!mount.join("out").exists());
    f.originals();
}

#[test]
fn source_identity_is_frozen_even_when_replacement_has_identical_bytes() {
    let f = Fixture::new();
    let replacement = f.dir.path().join("new-source");
    std::fs::copy(&f.sources[0], &replacement).unwrap();
    std::fs::rename(replacement, &f.sources[0]).unwrap();
    assert!(execute(&f.db, &f.id).is_err());
    assert!(!f.dir.path().join("export").exists());
    f.originals();
}

#[test]
fn a_target_created_at_the_publish_boundary_is_never_overwritten() {
    struct Racer(Cell<bool>);
    impl ArchiveFs for Racer {
        fn publish(&self, source: &Path, target: &Path) -> std::io::Result<()> {
            if !self.0.replace(true) {
                std::fs::create_dir(target)?;
                std::fs::write(target.join("IMG.JPG"), b"created concurrently")?;
            }
            rename_exclusive(source, target)
        }
    }
    let f = Fixture::new();
    let out = execute_with(&f.db, &f.id, &Racer(Cell::new(false)))
        .unwrap()
        .destination;
    assert_ne!(out, f.dir.path().join("export"));
    assert_eq!(
        std::fs::read(f.dir.path().join("export/IMG.JPG")).unwrap(),
        b"created concurrently"
    );
    assert_eq!(std::fs::read_dir(out).unwrap().count(), 3);
    f.originals();
}

#[test]
fn a_crash_after_recording_undo_conflict_preserves_user_edits() {
    let mut f = Fixture::new();
    let out = execute(&f.db, &f.id).unwrap().destination;
    std::fs::write(out.join("IMG.JPG"), b"edited").unwrap();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| undo_with(
            &f.db,
            &f.id,
            &fault("conflict", true, libc::EIO)
        )))
        .is_err()
    );
    f.reopen();
    reconcile(&f.db).unwrap();
    reconcile(&f.db).unwrap();
    assert_eq!(get(&f.db, &f.id).unwrap().status, "partial");
    assert_eq!(std::fs::read(out.join("IMG.JPG")).unwrap(), b"edited");
    f.originals();
}

#[test]
fn prepared_copy_must_match_frozen_original_not_just_its_own_hash() {
    let f = Fixture::new();
    let id = begin(
        &f.db,
        "photo",
        &f.dir.path().join("prepared-copy"),
        vec![(f.sources[0].clone(), "IMG.JPG".into())],
        None,
    )
    .unwrap();
    let prep = preparation(&f.db, &id).unwrap();
    std::fs::write(prep.join("IMG.JPG"), b"wrong copied data").unwrap();
    assert!(seal_prepared(&f.db, &id, &prep).is_err());
    f.originals();
}

#[test]
fn declared_derivatives_keep_original_and_output_hashes_distinct() {
    let f = Fixture::new();
    let id = begin_with_transforms(
        &f.db,
        "photo",
        &f.dir.path().join("converted"),
        vec![(f.sources[0].clone(), "image.jpg".into())],
        None,
        &["image.jpg".into()],
    )
    .unwrap();
    let prep = preparation(&f.db, &id).unwrap();
    std::fs::write(prep.join("image.jpg"), b"converted").unwrap();
    seal_prepared(&f.db, &id, &prep).unwrap();
    let out = execute(&f.db, &id).unwrap().destination;
    assert_eq!(std::fs::read(out.join("image.jpg")).unwrap(), b"converted");
    let m = &load(&f.db, &id).unwrap().plan.members[0];
    assert_ne!(m.original.hash, m.input.hash);
    f.originals();
}

/// 两次交付同时指向同一目标目录:各自认领,发布瞬间在同一屏障上会合。
/// 期望:一份拿到 `export`,另一份整组顺延 `export-2`;没有覆盖、没有混包、都 done。
/// 同一 op 的第二次并发执行则被认领锁拒绝(见 claim_serializes_the_same_operation…)。
#[test]
fn two_concurrent_deliveries_to_one_target_never_overwrite_each_other() {
    struct Rendezvous(std::sync::Arc<std::sync::Barrier>, Cell<bool>);
    impl ArchiveFs for Rendezvous {
        fn publish(&self, source: &Path, target: &Path) -> std::io::Result<()> {
            // Only the first publish attempt meets at the barrier; the loser's
            // suffix retry must not wait for a partner that already finished.
            if !self.1.replace(true) {
                self.0.wait();
            }
            rename_exclusive(source, target)
        }
    }
    let f = Fixture::new();
    let second_sources: Vec<_> = ["B.JPG", "B.ARW", "B.ARW.xmp"]
        .iter()
        .map(|n| f.dir.path().join(n))
        .collect();
    for (i, source) in second_sources.iter().enumerate() {
        std::fs::write(source, format!("second-{i}").repeat(10000)).unwrap();
    }
    let second = begin(
        &f.db,
        "photo",
        &f.dir.path().join("export"),
        second_sources
            .iter()
            .map(|p| (p.clone(), PathBuf::from(p.file_name().unwrap())))
            .collect(),
        None,
    )
    .unwrap();
    seal_copies(&f.db, &second).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let db_path = f.dir.db_path();
    let handles: Vec<_> = [f.id.clone(), second.clone()]
        .into_iter()
        .map(|id| {
            let barrier = barrier.clone();
            let db_path = db_path.clone();
            std::thread::spawn(move || {
                let c = db::open_project(&db_path).unwrap();
                execute_with(&c, &id, &Rendezvous(barrier, Cell::new(false))).map(|op| op.destination)
            })
        })
        .collect();
    let outputs: Vec<PathBuf> = handles
        .into_iter()
        .map(|h| h.join().unwrap().unwrap())
        .collect();
    assert_ne!(outputs[0], outputs[1]);
    let names: std::collections::BTreeSet<_> = outputs
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["export", "export-2"].into_iter().map(String::from).collect());
    for (id, sources, out) in [(&f.id, &f.sources, &outputs[0]), (&second, &second_sources, &outputs[1])] {
        assert_eq!(get(&f.db, id).unwrap().status, "done");
        assert_eq!(std::fs::read_dir(out).unwrap().count(), 3);
        for source in sources {
            assert_eq!(
                std::fs::read(source).unwrap(),
                std::fs::read(out.join(source.file_name().unwrap())).unwrap()
            );
        }
    }
    f.originals();
    let leftovers: Vec<_> = std::fs::read_dir(f.dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".tripcut-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// 在 done 落库之后、清场之前崩溃:重启对账要把准备副本 / 暂存目录 / 锁文件扫掉。
#[test]
fn crash_between_done_and_cleanup_is_swept_by_reconcile() {
    let mut f = Fixture::new();
    let prep = preparation(&f.db, &f.id).unwrap();
    for p in &f.sources {
        std::fs::copy(p, prep.join(p.file_name().unwrap())).unwrap();
    }
    // 准备后再冻结(与真实交付相同的路径:preparation → seal_prepared → execute)。
    let mut loaded = load(&f.db, &f.id).unwrap();
    loaded.plan.sealed = false;
    save(&f.db, &f.id, &loaded.plan, "planned").unwrap();
    seal_prepared(&f.db, &f.id, &prep).unwrap();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute_with(
        &f.db,
        &f.id,
        &fault("done", true, libc::EIO)
    )))
    .is_err());
    assert!(prep.is_dir(), "崩溃点在清场之前,副本应还在");
    f.reopen();
    assert!(reconcile(&f.db).unwrap().is_empty());
    assert_eq!(get(&f.db, &f.id).unwrap().status, "done");
    let litter: Vec<_> = std::fs::read_dir(f.dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".tripcut-"))
        .collect();
    assert!(litter.is_empty(), "{litter:?}");
    assert_eq!(std::fs::read_dir(f.dir.path().join("export")).unwrap().count(), 3);
    f.originals();
}

/// 交付完成后清场,之后撤销仍能自建隔离目录;撤销完成后同样不留痕。
#[test]
fn done_cleans_staging_and_undo_after_cleanup_still_works_and_cleans_again() {
    let f = Fixture::new();
    let out = execute(&f.db, &f.id).unwrap().destination;
    let litter = || -> Vec<String> {
        std::fs::read_dir(f.dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".tripcut-"))
            .collect()
    };
    assert!(litter().is_empty(), "{:?}", litter());
    assert_eq!(undo(&f.db, &f.id).unwrap().status, "undone");
    for p in &f.sources {
        assert!(!out.join(p.file_name().unwrap()).exists());
    }
    assert!(litter().is_empty(), "{:?}", litter());
    f.originals();
}

/// 验收表:五种故障各跑一遍,打印「原件哈希一致 / 首次目标状态 / 重复恢复结果」。
/// `cargo test --lib fault_matrix_table -- --nocapture` 直接得到 lane 报告里的那张表。
#[test]
fn fault_matrix_table_originals_intact_and_recovery_idempotent() {
    fn hashes(f: &Fixture) -> Vec<String> {
        f.sources
            .iter()
            .map(|p| blake3::hash(&std::fs::read(p).unwrap()).to_hex().to_string())
            .collect()
    }
    fn statuses(f: &Fixture) -> String {
        let op = get(&f.db, &f.id).unwrap();
        let files: Vec<_> = op.files.iter().map(|x| x.status.as_str()).collect();
        format!("op={} files={}", op.status, files.join("/"))
    }
    let mut rows = Vec::new();
    type Inject = Box<dyn Fn(&Fixture) -> bool>;
    let mut cases: Vec<(String, Inject)> = vec![
        (
            "空间满(复制中 ENOSPC 短写)".into(),
            Box::new(|f| execute_with(&f.db, &f.id, &fault("write", false, libc::ENOSPC)).is_err()),
        ),
        (
            "断盘(发布 rename 返回 EIO)".into(),
            Box::new(|f| execute_with(&f.db, &f.id, &fault("before_publish", false, libc::EIO)).is_err()),
        ),
        (
            "EXDEV(发布 rename 跨卷)".into(),
            Box::new(|f| execute_with(&f.db, &f.id, &fault("before_publish", false, libc::EXDEV)).is_err()),
        ),
        (
            "目标冲突(预先放同名目录+文件)".into(),
            Box::new(|f| {
                let existing = f.dir.path().join("export");
                std::fs::create_dir(&existing).unwrap();
                std::fs::write(existing.join("IMG.JPG"), b"foreign").unwrap();
                execute(&f.db, &f.id).is_ok()
            }),
        ),
    ];
    for at in [
        "running", "stage_created", "payload_created", "planned", "temp_created", "copy_synced",
        "copied", "staged", "verified", "before_publish", "renamed", "published", "done",
    ] {
        cases.push((
            format!("崩溃于 {at} 之后(panic 再重开库)"),
            Box::new(move |f| {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    execute_with(&f.db, &f.id, &fault(at, true, libc::EIO))
                }))
                .is_err()
            }),
        ));
    }
    for (name, inject) in cases {
        let mut f = Fixture::new();
        let before = hashes(&f);
        let fired = inject(&f);
        assert!(fired, "{name}");
        let first = statuses(&f);
        let intact_after_fault = hashes(&f) == before;
        f.reopen();
        let r1 = reconcile(&f.db).unwrap().len();
        let r2 = reconcile(&f.db).unwrap().len();
        let after = statuses(&f);
        let op = get(&f.db, &f.id).unwrap();
        let count = std::fs::read_dir(&op.destination).map(|d| d.count()).unwrap_or(0);
        let intact_after_recovery = hashes(&f) == before;
        assert!(intact_after_fault && intact_after_recovery, "{name}");
        assert_eq!(op.status, "done", "{name}");
        assert_eq!(count, 3, "{name}");
        let foreign = f.dir.path().join("export").join("IMG.JPG");
        let conflict_note = if name.starts_with("目标冲突") {
            assert_eq!(std::fs::read(&foreign).unwrap(), b"foreign");
            format!(" 原有 export/IMG.JPG 仍为 foreign,本次整组落在 {}", op.destination.file_name().unwrap().to_string_lossy())
        } else {
            String::new()
        };
        rows.push(format!(
            "| {name} | 故障后一致={intact_after_fault},恢复后一致={intact_after_recovery} | {first} | 对账①未完成数={r1},②={r2};最终 {after};目标 {count} 文件{conflict_note} |"
        ));
        f.originals();
    }
    println!("FAULT_TABLE_BEGIN");
    println!("| 故障 | 原件哈希一致 | 首次目标状态 | 重复恢复结果 |");
    println!("|---|---|---|---|");
    for row in &rows {
        println!("{row}");
    }
    println!("FAULT_TABLE_END");
}
