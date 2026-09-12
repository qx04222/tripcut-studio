//! R7 Task 5：submit → poll → download → import → 账本 → 缺口回流的端到端
//! 测试。对 `scripts/qa/minimax-mock.mjs` 起一份本地假服务器，覆盖
//! succeeded / failed / image-rejected(触发 t2v 降级) / budget-exhausted /
//! key-missing / 幂等重复入队六条路径。
//!
//! 轮询的 10s→…→300s 退避不真的 sleep——每轮循环前把
//! `jobs.next_attempt_at` 直接改回"现在"，用 `jobs::claim_next` +
//! `generation::run_poll_job` 手动驱动，这是本仓库测试后台任务时一贯的
//! 快进手法(直接改写时间戳字段，而不是等真实时钟)。
//!
//! notify「恰好一次」不在这个文件断言——`notify::MockSink` 是
//! `#[cfg(test)]` 门控的库内类型，外部集成测试二进制看不到它；那条契约
//! 由 `core::jobs::tests::notifier_fires_exactly_once_for_a_completed_generation`
//! 覆盖。
//!
//! 找不到 `node` 时打印 `SKIP: node not found on PATH` 后直接 return——
//! 不允许假绿。

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;
use tripcut_studio_lib::core::{db, generation, jobs, settings};

fn node_path() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join("node");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn mock_script_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("..").join("scripts").join("qa").join("minimax-mock.mjs")
}

fn pick_free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().unwrap().port()
}

struct MockServer {
    child: Child,
    base_url: String,
}

impl MockServer {
    fn spawn(node: &Path, outcome: &str, extra_args: &[&str]) -> Self {
        let port = pick_free_port();
        let mut child = Command::new(node)
            .arg(mock_script_path())
            .arg("--port")
            .arg(port.to_string())
            .arg("--outcome")
            .arg(outcome)
            .args(extra_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn minimax-mock.mjs");

        let stdout = child.stdout.take().expect("mock stdout");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut ready = false;
        for _ in 0..200 {
            line.clear();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            if line.contains("\"event\":\"listening\"") {
                ready = true;
                break;
            }
        }
        assert!(ready, "mock server did not report listening in time");

        // 持续排空 stdout/stderr,否则管道写满会让 mock 进程在下一次请求时
        // 卡死(EPIPE),而不是明显地"死掉"。
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = String::new();
            loop {
                buf.clear();
                if reader.read_line(&mut buf).unwrap_or(0) == 0 {
                    break;
                }
            }
        });
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buf = String::new();
                loop {
                    buf.clear();
                    if reader.read_line(&mut buf).unwrap_or(0) == 0 {
                        break;
                    }
                }
            });
        }

        Self { child, base_url: format!("http://127.0.0.1:{port}") }
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 环境变量是进程全局的——`with_env` 把"设置 base URL/测试 key → 跑断言 →
/// 清理"串行化,避免并行跑的测试互相踩。
fn with_env<F: FnOnce()>(base_url: &str, api_key: &str, f: F) {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // SAFETY: 串行化于 LOCK,持锁期间不会有其它线程读写这两个变量。
    unsafe {
        std::env::set_var("TRIPCUT_MINIMAX_BASE_URL", base_url);
        std::env::set_var("TRIPCUT_MINIMAX_TEST_API_KEY", api_key);
    }
    f();
    unsafe {
        std::env::remove_var("TRIPCUT_MINIMAX_BASE_URL");
        std::env::remove_var("TRIPCUT_MINIMAX_TEST_API_KEY");
    }
}

static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let unique = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tripcut-generation-e2e-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn db_path(&self) -> PathBuf {
        self.path.join("project.db")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn open_project() -> (TestDirectory, Connection) {
    let directory = TestDirectory::new();
    db::initialize(&directory.db_path()).unwrap();
    let connection = db::open_project(&directory.db_path()).unwrap();
    (directory, connection)
}

fn enable_minimax(connection: &Connection, budget: f64) {
    settings::set_setting(connection, settings::MINIMAX_ENABLED_KEY, "true").unwrap();
    settings::set_setting(connection, settings::MINIMAX_MONTHLY_BUDGET_KEY, &budget.to_string()).unwrap();
}

/// 造一个可提交的缺口:active episode → 一条 confirmed revision → 一个
/// narrative_chapters 章节 → 章节下的一条 story_gaps。
fn seed_gap(connection: &Connection) -> i64 {
    let episode_id: i64 = connection
        .query_row("SELECT id FROM episodes WHERE status='active'", [], |row| row.get(0))
        .unwrap();
    connection
        .execute(
            "INSERT INTO narrative_revisions(episode_id, kind, created_at)
             VALUES (?1, 'confirmed', '2026-09-10T00:00:00Z')",
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
             ) VALUES (?1, ?2, ?3, 'ATMOSPHERE', 'r', 'open', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')",
            rusqlite::params![episode_id, revision_id, chapter_id],
        )
        .unwrap();
    connection.last_insert_rowid()
}

fn minimal_draft(gap_id: i64) -> generation::GenerationRequestDraft {
    generation::GenerationRequestDraft {
        gap_id,
        retry_of: None,
        mode: "t2v".to_owned(),
        model: "MiniMax-H3-Max".to_owned(),
        resolution: "480P".to_owned(),
        duration_s: 4,
        ratio: Some("16:9".to_owned()),
        prompt: "端到端测试提示词".to_owned(),
        refs: Vec::new(),
        estimated_cost_usd: 0.20,
        notes: Vec::new(),
    }
}

/// 快进驱动轮询到终态。**走真实的 worker 路径**——
/// `jobs::JobRunner::run_one(db_path)`,也就是 `claim_for_owner` →
/// `execute_claimed` 的 `"generation_poll" => run_poll_job(project_root)`
/// 那条接线(复审 P3-1:此前这里直接调 `run_poll_job`,`jobs.rs` 里的分支
/// 从来没有被端到端跑过)。
///
/// 两处快进,都只动时间戳、不动任何业务状态:
/// 1. 把这条 `generation_poll` 的 `next_attempt_at` 改回"现在",不等真实的
///    10s→…→300s 退避;
/// 2. 把**其它** kind 的 pending job(导入触发的 analysis/thumbnail/… 一大
///    串)推到很远的将来,让协调器每一步都只可能认领到我们要的这条 poll
///    ——否则 `run_one` 会去跑真解码任务,既慢又要求这台机器上有 ffmpeg。
fn drive_poll_to_terminal(connection: &mut Connection, db_path: &Path, request_id: i64) -> String {
    for _ in 0..50 {
        let status: String = connection
            .query_row("SELECT status FROM generation_requests WHERE id=?1", [request_id], |row| row.get(0))
            .unwrap();
        if matches!(status.as_str(), "imported" | "failed" | "cancelled") {
            return status;
        }
        connection
            .execute(
                "UPDATE jobs SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day')
                 WHERE kind<>'generation_poll' AND status='pending'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE jobs SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE kind='generation_poll' AND payload_hash=?1 AND status='pending'",
                [request_id.to_string()],
            )
            .unwrap();
        let claimed = jobs::JobRunner::run_one(db_path).unwrap();
        assert!(claimed, "request {request_id} 应该还有一个可认领的 generation_poll job");
    }
    panic!("generation_poll 在 50 轮快进内没有到达终态");
}

fn read_jsonl(path: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("每行都应该是合法 JSON"))
        .collect()
}

#[test]
fn succeeded_outcome_imports_a_generated_clip_and_fills_the_gap() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let mock = MockServer::spawn(&node, "succeeded", &[]);
    with_env(&mock.base_url, "test-key", || {
        let (directory, mut connection) = open_project();
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);

        // 模拟原始素材/监听目录——回流结束后必须原封不动:不只是"没多出
        // 文件",连既有文件的 inode/大小/mtime 都不能变。
        let watched_dir = directory.path().join("watched_media");
        let fixture_dir = directory.path().join("fixtures");
        fs::create_dir_all(&watched_dir).unwrap();
        fs::create_dir_all(fixture_dir.join("nested")).unwrap();
        fs::write(watched_dir.join("original.mp4"), b"pretend this is the owner's footage").unwrap();
        fs::write(fixture_dir.join("nested").join("reference.jpg"), b"pretend this is a reference frame").unwrap();
        let watched_before = directory_fingerprint(&watched_dir);
        let fixture_before = directory_fingerprint(&fixture_dir);
        assert_eq!(watched_before.len(), 1);
        assert_eq!(fixture_before.len(), 1);

        let request_id = generation::submit_request(&mut connection, minimal_draft(gap_id)).unwrap();
        let final_status = drive_poll_to_terminal(&mut connection, &directory.db_path(), request_id);
        assert_eq!(final_status, "imported");

        let (result_clip_id, error): (Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT result_clip_id, error FROM generation_requests WHERE id=?1",
                [request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let clip_id = result_clip_id.expect("成功回流必须写 result_clip_id");
        assert!(error.is_none());

        let generated_source: Option<String> = connection
            .query_row("SELECT generated_source FROM clips WHERE id=?1", [clip_id], |row| row.get(0))
            .unwrap();
        assert_eq!(generated_source.as_deref(), Some("minimax"));

        let gap_status: String = connection
            .query_row("SELECT status FROM story_gaps WHERE id=?1", [gap_id], |row| row.get(0))
            .unwrap();
        assert_eq!(gap_status, "filled");

        let ledger_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM generation_ledger WHERE request_id=?1",
                [request_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_rows, 1, "提交时应该恰好写一条账本行");

        // 结果只出现在 generated/ 之内——监听目录与夹具目录逐文件比对
        // inode/大小/mtime,一个字节、一次 touch 都不许动。
        assert_eq!(
            directory_fingerprint(&watched_dir),
            watched_before,
            "监听/原始素材目录必须原封不动"
        );
        assert_eq!(
            directory_fingerprint(&fixture_dir),
            fixture_before,
            "夹具目录必须原封不动"
        );

        let generated_root = generation::generated_root_for_db(&directory.db_path());
        assert!(generated_root.is_dir(), "生成物必须落在 generated/ 目录下");
        assert!(walk_has_any_file(&generated_root), "generated/ 目录下应该有下载下来的文件");

        // 落盘文件名必须**精确**是 generated/<episode_id>/<request_id>-<task_id>.mp4。
        let episode_id: i64 = connection
            .query_row("SELECT episode_id FROM story_gaps WHERE id=?1", [gap_id], |row| row.get(0))
            .unwrap();
        let task_id: String = connection
            .query_row("SELECT task_id FROM generation_requests WHERE id=?1", [request_id], |row| row.get(0))
            .unwrap();
        let expected = generated_root
            .join(episode_id.to_string())
            .join(format!("{request_id}-{task_id}.mp4"));
        assert!(expected.is_file(), "期望的落盘路径不存在：{}", expected.display());
        assert_eq!(
            directory_fingerprint(&generated_root),
            vec![format!(
                "{}/{}-{}.mp4|ino={}|len={}|mtime={}.{}",
                episode_id,
                request_id,
                task_id,
                {
                    use std::os::unix::fs::MetadataExt;
                    fs::metadata(&expected).unwrap().ino()
                },
                fs::metadata(&expected).unwrap().len(),
                {
                    use std::os::unix::fs::MetadataExt;
                    fs::metadata(&expected).unwrap().mtime()
                },
                {
                    use std::os::unix::fs::MetadataExt;
                    fs::metadata(&expected).unwrap().mtime_nsec()
                }
            )],
            "generated/ 下必须**只有**这一个文件"
        );
    });
}

/// R7 Task 5 复审 P3-1:目录指纹——每个文件的相对路径 + inode + 大小 +
/// mtime。"零新增文件"这句断言只看 `read_dir().next().is_none()` 是不够的:
/// 原地覆盖、截断、把 mtime 改掉都不会让目录多出一项。这个清单比对能抓到。
fn directory_fingerprint(root: &Path) -> Vec<String> {
    use std::os::unix::fs::MetadataExt;
    fn walk(root: &Path, current: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(current) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(root, &path, out);
                continue;
            }
            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
            out.push(format!(
                "{relative}|ino={}|len={}|mtime={}.{}",
                meta.ino(),
                meta.len(),
                meta.mtime(),
                meta.mtime_nsec()
            ));
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn walk_has_any_file(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else { return false };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            return true;
        }
        if path.is_dir() && walk_has_any_file(&path) {
            return true;
        }
    }
    false
}

#[test]
fn failed_outcome_reopens_the_gap_and_records_the_error() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let mock = MockServer::spawn(&node, "failed", &[]);
    with_env(&mock.base_url, "test-key", || {
        let (directory, mut connection) = open_project();
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);

        let request_id = generation::submit_request(&mut connection, minimal_draft(gap_id)).unwrap();
        let final_status = drive_poll_to_terminal(&mut connection, &directory.db_path(), request_id);
        assert_eq!(final_status, "failed");

        let error: Option<String> = connection
            .query_row("SELECT error FROM generation_requests WHERE id=?1", [request_id], |row| row.get(0))
            .unwrap();
        assert!(error.unwrap_or_default().contains("content policy violation"));

        let gap_status: String = connection
            .query_row("SELECT status FROM story_gaps WHERE id=?1", [gap_id], |row| row.get(0))
            .unwrap();
        assert_eq!(gap_status, "open", "失败必须把缺口退回 open,便于重新生成");

        // 复审 P2-1 的另一半:任务已经被平台接受过(拿到过 task_id),之后
        // 远端才报失败——钱可能真的花了,预留必须留在账本上。
        let ledger: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM generation_ledger WHERE request_id=?1",
                [request_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger, 1, "远端失败不退预留");
    });
}

#[test]
fn image_rejected_downgrades_to_t2v_and_retries_exactly_once() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let (directory, mut connection) = open_project();
    let record_path = directory.path().join("requests.jsonl");
    let mock = MockServer::spawn(
        &node,
        "image-rejected",
        &["--record", record_path.to_str().unwrap()],
    );
    with_env(&mock.base_url, "test-key", || {
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);

        let reference_path = directory.path().join("frame.jpg");
        fs::write(&reference_path, b"not a real jpeg, just bytes for the data URI").unwrap();
        let mut draft = minimal_draft(gap_id);
        draft.mode = "i2v".to_owned();
        draft.ratio = None;
        draft.refs = vec![generation::RefImage {
            path: reference_path.to_string_lossy().into_owned(),
            role: "first_frame".to_owned(),
        }];

        // MiniMax mock 在 outcome=image-rejected 下,无论请求体有没有图片都
        // 400——所以降级重试之后仍然会失败,我们要断言的不是"最终成功",而是
        // "确实又打了一次不带图片的请求"。
        let result = generation::submit_request(&mut connection, draft);
        assert!(result.is_err());

        let request_id: i64 = connection
            .query_row(
                "SELECT id FROM generation_requests WHERE gap_id=?1 ORDER BY id DESC LIMIT 1",
                [gap_id],
                |row| row.get(0),
            )
            .unwrap();
        let status: String = connection
            .query_row("SELECT status FROM generation_requests WHERE id=?1", [request_id], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "failed");
    });
    drop(mock);

    let requests = read_jsonl(&record_path);
    let create_calls: Vec<&serde_json::Value> = requests
        .iter()
        .filter(|entry| entry["path"] == "/v2/video_generation")
        .collect();
    assert_eq!(create_calls.len(), 2, "必须先带图片打一次,被拒后不带图片重试恰好一次");
    let first_content = create_calls[0]["body"]["content"].as_array().unwrap();
    assert!(
        first_content.iter().any(|item| item["type"] == "image_url"),
        "第一次请求应该带图片"
    );
    let second_content = create_calls[1]["body"]["content"].as_array().unwrap();
    assert!(
        second_content.iter().all(|item| item["type"] != "image_url"),
        "降级重试的第二次请求不应该再带图片"
    );
}

#[test]
fn budget_exhausted_never_reaches_the_mock() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let (directory, mut connection) = open_project();
    let record_path = directory.path().join("requests.jsonl");
    let mock = MockServer::spawn(
        &node,
        "succeeded",
        &["--record", record_path.to_str().unwrap()],
    );
    with_env(&mock.base_url, "test-key", || {
        enable_minimax(&connection, 0.10);
        let gap_id = seed_gap(&connection);
        let mut draft = minimal_draft(gap_id);
        draft.estimated_cost_usd = 5.0;
        let error = generation::submit_request(&mut connection, draft).unwrap_err();
        assert!(error.to_string().contains("预算"));
    });
    drop(mock);
    let byte_len = fs::metadata(&record_path).map(|meta| meta.len()).unwrap_or(0);
    assert_eq!(byte_len, 0, "预算熔断必须发生在任何网络请求之前,mock 不应该收到任何记录");
}

#[test]
fn missing_api_key_never_reaches_the_mock() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let (directory, mut connection) = open_project();
    let record_path = directory.path().join("requests.jsonl");
    let mock = MockServer::spawn(
        &node,
        "succeeded",
        &["--record", record_path.to_str().unwrap()],
    );
    with_env(&mock.base_url, "", || {
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);
        let error = generation::submit_request(&mut connection, minimal_draft(gap_id)).unwrap_err();
        assert!(error.to_string().contains("API Key"));
    });
    drop(mock);
    let byte_len = fs::metadata(&record_path).map(|meta| meta.len()).unwrap_or(0);
    assert_eq!(byte_len, 0, "未配置 API Key 必须发生在任何网络请求之前");
}

#[test]
fn double_enqueue_for_the_same_request_creates_only_one_job() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let mock = MockServer::spawn(&node, "succeeded", &[]);
    with_env(&mock.base_url, "test-key", || {
        let (_directory, mut connection) = open_project();
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);
        let request_id = generation::submit_request(&mut connection, minimal_draft(gap_id)).unwrap();

        // submit_request 内部已经 enqueue_idempotent 过一次;再手动调用一次
        // 模拟"重复提交/重复触发"不应该多开一条 job。
        jobs::enqueue_idempotent(
            &mut connection,
            "generation_poll",
            &format!("{{\"request_id\":{request_id}}}"),
            &request_id.to_string(),
        )
        .unwrap();

        let job_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE kind='generation_poll' AND payload_hash=?1",
                [request_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(job_count, 1, "同一个 request_id 的 generation_poll 只能有一条 job");
    });
}

/// R7 Task 5 复审 P1-1(钱):重复提交同一个缺口——两次调用只能产生一行
/// 请求、一行账本、一次 `create_task`。这条是靠 mock 的 `--record` 数
/// **真的打出去几次网络请求**,不是只看数据库。
#[test]
fn double_submit_for_the_same_gap_charges_exactly_once() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let (directory, mut connection) = open_project();
    let record_path = directory.path().join("requests.jsonl");
    let mock = MockServer::spawn(&node, "queued", &["--record", record_path.to_str().unwrap()]);
    with_env(&mock.base_url, "test-key", || {
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);

        let first = generation::submit_request(&mut connection, minimal_draft(gap_id)).unwrap();
        let second = generation::submit_request(&mut connection, minimal_draft(gap_id));
        assert!(second.is_err(), "同一缺口的第二次提交必须被拒绝");
        assert!(
            second.unwrap_err().to_string().contains("该缺口已有生成请求进行中"),
            "拒绝理由必须是幂等闸"
        );

        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM generation_requests WHERE gap_id=?1", [gap_id], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1, "只能有一行生成请求");
        let ledger: i64 = connection
            .query_row("SELECT COUNT(*) FROM generation_ledger", [], |row| row.get(0))
            .unwrap();
        assert_eq!(ledger, 1, "只能记一次账（一次计费）");
        let _ = first;
    });
    drop(mock);

    let create_calls = read_jsonl(&record_path)
        .into_iter()
        .filter(|entry| entry["path"] == "/v2/video_generation")
        .count();
    assert_eq!(create_calls, 1, "MiniMax 只能收到一次建任务请求");
}

/// R7 Task 5 复审 P2-2:回流做到一半崩溃(文件已下载、clip 已入库,但
/// `generation_requests.status` 还没写)。恢复后这条 poll 会被重新认领,
/// `run_import_probe` 这次返回 `Duplicate`——旧实现在 `import_batch_clips`
/// 里找不到 clip,于是把一条其实**已经成功**的请求判成 failed,缺口也被
/// 退回 open。修复后:按目标路径找回既有 clip,请求照样落到 imported。
#[test]
fn second_poll_after_a_crashed_import_reuses_the_existing_clip() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let mock = MockServer::spawn(&node, "succeeded", &[]);
    with_env(&mock.base_url, "test-key", || {
        let (directory, mut connection) = open_project();
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);

        let request_id = generation::submit_request(&mut connection, minimal_draft(gap_id)).unwrap();
        assert_eq!(drive_poll_to_terminal(&mut connection, &directory.db_path(), request_id), "imported");
        let first_clip_id: i64 = connection
            .query_row("SELECT result_clip_id FROM generation_requests WHERE id=?1", [request_id], |row| row.get(0))
            .unwrap();

        // 把状态倒回"崩溃前"的样子:请求还在 queued、缺口还是 requested、
        // 结果字段还没写——但磁盘上的文件和 clips 行都已经存在了。
        connection
            .execute(
                "UPDATE generation_requests SET status='queued', result_clip_id=NULL, result_url=NULL, error=NULL WHERE id=?1",
                [request_id],
            )
            .unwrap();
        connection
            .execute("UPDATE story_gaps SET status='requested' WHERE id=?1", [gap_id])
            .unwrap();
        jobs::enqueue_idempotent(
            &mut connection,
            "generation_poll",
            &format!("{{\"request_id\":{request_id}}}"),
            &request_id.to_string(),
        )
        .unwrap();

        assert_eq!(
            drive_poll_to_terminal(&mut connection, &directory.db_path(), request_id),
            "imported",
            "恢复后的第二次轮询必须复用已有 clip,而不是把成功的请求判成失败"
        );
        let (clip_id, error): (Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT result_clip_id, error FROM generation_requests WHERE id=?1",
                [request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(clip_id, Some(first_clip_id), "必须复用同一条 clip,不能再建一条");
        assert!(error.is_none(), "不应该留下失败原因：{error:?}");

        let gap_status: String = connection
            .query_row("SELECT status FROM story_gaps WHERE id=?1", [gap_id], |row| row.get(0))
            .unwrap();
        assert_eq!(gap_status, "filled");

        let clip_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM clips WHERE generated_source='minimax'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(clip_rows, 1, "不能因为重跑而多出一条生成片");
    });
}

/// R7 Task 5 复审 P2-3:2 小时的轮询窗口里业主完全可能封存当前 Episode
/// 再开一集。生成片必须回到**提交时那一集**,而不是轮询那一刻恰好活跃的
/// 那一集。
#[test]
fn episode_switch_during_the_poll_still_imports_into_the_original_episode() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let mock = MockServer::spawn(&node, "succeeded", &[]);
    with_env(&mock.base_url, "test-key", || {
        let (directory, mut connection) = open_project();
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);
        let original_episode_id: i64 = connection
            .query_row("SELECT episode_id FROM story_gaps WHERE id=?1", [gap_id], |row| row.get(0))
            .unwrap();

        let request_id = generation::submit_request(&mut connection, minimal_draft(gap_id)).unwrap();

        // 提交之后、轮询之前切集。
        connection
            .execute("UPDATE episodes SET status='archived' WHERE status='active'", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO episodes(title, theme, created_at, status, episode_number)
                 VALUES ('EP02', '', '2026-09-10T00:00:00Z', 'active', 2)",
                [],
            )
            .unwrap();
        let new_episode_id = connection.last_insert_rowid();
        assert_ne!(new_episode_id, original_episode_id);

        assert_eq!(
            drive_poll_to_terminal(&mut connection, &directory.db_path(), request_id),
            "imported",
            "切集不该让回流失败"
        );

        let clip_id: i64 = connection
            .query_row("SELECT result_clip_id FROM generation_requests WHERE id=?1", [request_id], |row| row.get(0))
            .unwrap();
        let owner: Option<i64> = connection
            .query_row("SELECT episode_id FROM clips WHERE id=?1", [clip_id], |row| row.get(0))
            .unwrap();
        assert_eq!(owner, Some(original_episode_id), "生成片必须回到提交时那一集");

        // 落盘目录也必须按原始 Episode 分目录。
        let generated_root = generation::generated_root_for_db(&directory.db_path());
        assert!(
            generated_root.join(original_episode_id.to_string()).is_dir(),
            "结果文件必须落在 generated/<原始 episode_id>/ 下"
        );
        assert!(!generated_root.join(new_episode_id.to_string()).exists());
    });
}

/// 用 lavfi 造一段极小的真视频。ffmpeg 不在 PATH 上时返回 None,调用方打
/// SKIP——不允许假绿。
fn make_lavfi_clip(dest: &Path, color: &str) -> Option<()> {
    let status = Command::new("ffmpeg")
        .args([
            "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            &format!("color=c={color}:s=160x120:d=1:r=10"),
            "-pix_fmt", "yuv420p",
        ])
        .arg(dest)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    (status.success() && dest.is_file()).then_some(())
}

/// 把一条 clip 直接插进库:`rel_path` 用绝对路径(内置卷的存法),
/// `media_source::verified_clip_path` 会原样解析它。
fn seed_clip(connection: &Connection, path: &Path) -> i64 {
    connection
        .execute("INSERT OR IGNORE INTO volumes(uuid, label) VALUES ('v', 'test')", [])
        .unwrap();
    connection
        .execute(
            "INSERT INTO clips(
                volume_uuid, rel_path, tb_num, tb_den, duration_ticks, width, height,
                fps_num, fps_den, imported_at, missing_since, episode_id
             ) VALUES ('v', ?1, 1, 1000, 1000, 160, 120, 10, 1, '2026-09-10T00:00:00Z', NULL,
                (SELECT id FROM episodes WHERE status='active'))",
            [path.to_string_lossy().into_owned()],
        )
        .unwrap();
    connection.last_insert_rowid()
}

/// R7 Task 5 复审「延后项现在要做」:缺口相邻镜头的首尾帧抽取。
/// 前一 beat 主选片的**末**帧 → `first_frame`,后一 beat 主选片的**首**帧
/// → `last_frame`,落在 app 缓存目录里(绝不写原始素材目录),`build_request`
/// 据此把模式选成 `fl2v`。
#[test]
fn neighbour_frames_are_extracted_and_sent_as_first_and_last_refs() {
    let Some(node) = node_path() else {
        eprintln!("SKIP: node not found on PATH");
        return;
    };
    let (directory, mut connection) = open_project();

    // 原始素材目录(夹具):回流全过程必须原封不动。
    let fixture_dir = directory.path().join("fixtures");
    fs::create_dir_all(&fixture_dir).unwrap();
    let prev_clip_path = fixture_dir.join("prev.mp4");
    let next_clip_path = fixture_dir.join("next.mp4");
    if make_lavfi_clip(&prev_clip_path, "red").is_none() || make_lavfi_clip(&next_clip_path, "blue").is_none() {
        eprintln!("SKIP: ffmpeg not usable on PATH");
        return;
    }
    let fixture_before = directory_fingerprint(&fixture_dir);
    assert_eq!(fixture_before.len(), 2);

    let record_path = directory.path().join("requests.jsonl");
    let mock = MockServer::spawn(&node, "succeeded", &["--record", record_path.to_str().unwrap()]);
    with_env(&mock.base_url, "test-key", || {
        enable_minimax(&connection, 100.0);
        let gap_id = seed_gap(&connection);
        let (episode_id, gap_chapter_id): (i64, i64) = connection
            .query_row("SELECT episode_id, chapter_id FROM story_gaps WHERE id=?1", [gap_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();

        // 缺口所在章节里已经有一个 beat(它就是「前一个 beat」),后面再来
        // 一个章节,它的第一个 beat 就是「后一个 beat」。
        let prev_clip = seed_clip(&connection, &prev_clip_path);
        let next_clip = seed_clip(&connection, &next_clip_path);
        connection
            .execute(
                "INSERT INTO narrative_beats(chapter_id, clip_id, role, \"order\", score, rationale)
                 VALUES (?1, ?2, 'beat', 0, 0.9, 'r')",
                rusqlite::params![gap_chapter_id, prev_clip],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO narrative_chapters(
                    episode_id, kind, title, \"order\", promoted, score, rationale, promotion_reason
                 ) VALUES (?1, 'atmosphere', '第二章', 1, 1, 0.9, 'r', 'p')",
                [episode_id],
            )
            .unwrap();
        let next_chapter_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO narrative_beats(chapter_id, clip_id, role, \"order\", score, rationale)
                 VALUES (?1, ?2, 'beat', 0, 0.9, 'r')",
                rusqlite::params![next_chapter_id, next_clip],
            )
            .unwrap();

        // H3(不是 H3-Max)才支持首尾帧;H3-Max 会按既有降级规则退成 i2v。
        let overrides = serde_json::from_value::<generation::GenerationOverrides>(
            serde_json::json!({"model": "MiniMax-H3", "resolution": "768P"}),
        )
        .unwrap();
        let draft = generation::draft_for_gap(&connection, gap_id, &overrides).unwrap();
        assert_eq!(draft.mode, "fl2v", "前后都有相邻镜头时必须是首尾帧模式");
        assert_eq!(draft.refs.len(), 2, "必须挂两张参考帧");
        assert_eq!(draft.refs[0].role, "first_frame");
        assert_eq!(draft.refs[1].role, "last_frame");

        // 帧文件落在 app 缓存目录,不在原始素材目录。
        for reference in &draft.refs {
            let path = PathBuf::from(&reference.path);
            assert!(path.is_file(), "参考帧文件不存在：{}", path.display());
            assert!(
                path.starts_with(
                    directory.path().canonicalize().unwrap().join("cache").join("generation")
                ) || path.starts_with(directory.path().join("cache").join("generation")),
                "参考帧必须落在 cache/generation/ 下：{}",
                path.display()
            );
            assert!(fs::metadata(&path).unwrap().len() > 0, "参考帧不能是空文件");
        }

        generation::submit_request(&mut connection, draft).unwrap();
    });
    drop(mock);

    // 夹具目录原封不动。
    assert_eq!(
        directory_fingerprint(&fixture_dir),
        fixture_before,
        "抽帧绝不能改动原始素材目录"
    );

    let requests = read_jsonl(&record_path);
    let create_call = requests
        .iter()
        .find(|entry| entry["path"] == "/v2/video_generation")
        .expect("必须打过一次建任务请求");
    let images: Vec<&serde_json::Value> = create_call["body"]["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "image_url")
        .collect();
    assert_eq!(images.len(), 2, "请求体里必须有两张图");
    assert_eq!(images[0]["role"], "first_frame");
    assert_eq!(images[1]["role"], "last_frame");
    for image in images {
        assert!(
            image["image_url"]["url"].as_str().unwrap().starts_with("data:image/"),
            "参考帧必须以 data URI 送出"
        );
    }
}
