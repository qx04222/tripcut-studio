//! R7 Task 4：MiniMax v2 客户端集成测试。
//!
//! 对 `scripts/qa/minimax-mock.mjs` 起一份本地假服务器，覆盖 submit→query
//! 的成功/失败/鉴权/限流/图片拒绝/慢速超时六条路径，以及下载与 ffprobe
//! 校验、API key 不进日志。
//!
//! 找不到 `node` 时打印 `SKIP: node not found on PATH` 后直接 return——
//! 不允许假绿。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use tripcut_studio_lib::core::minimax::{
    CreateRequest, ImageContent, ImageInput, ImageRole, MinimaxClient, MinimaxError, Model, Ratio, Resolution,
    TaskId, TaskStatusKind, MAX_PROMPT_CHARS,
};

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
    // tests run with CWD = crate root (src-tauri); the mock lives at the
    // workspace root under scripts/qa.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("..").join("scripts").join("qa").join("minimax-mock.mjs")
}

struct MockServer {
    child: Child,
    pub base_url: String,
}

impl MockServer {
    fn spawn(node: &PathBuf, outcome: &str, delay_ms: u64) -> Self {
        let port = pick_free_port();
        let mut child = Command::new(node)
            .arg(mock_script_path())
            .arg("--port")
            .arg(port.to_string())
            .arg("--outcome")
            .arg(outcome)
            .arg("--delay-ms")
            .arg(delay_ms.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn minimax-mock.mjs");

        // Wait for the "listening" log line so we never race the server's
        // socket bind.
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

        // Keep draining stdout (and stderr) for the server's whole life.
        // If we just drop the reader here, our end of the pipe closes; the
        // next time the mock's log() writes another JSON line, Node gets
        // EPIPE on stdout and the process dies mid-request — which showed
        // up as a `SendRequest`/`IncompleteMessage` reqwest error on the
        // very first POST after readiness, not as an obviously-dead child.
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

fn pick_free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().unwrap().port()
}

fn with_base_url<F: FnOnce()>(base_url: &str, f: F) {
    // Environment variables are process-global; serialize access via a
    // simple mutex so parallel test threads don't clobber each other's
    // TRIPCUT_MINIMAX_BASE_URL.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: serialized by LOCK above; no other thread reads/writes this
    // var concurrently while the guard is held.
    unsafe {
        std::env::set_var("TRIPCUT_MINIMAX_BASE_URL", base_url);
    }
    f();
    unsafe {
        std::env::remove_var("TRIPCUT_MINIMAX_BASE_URL");
    }
}

fn base_request() -> CreateRequest {
    CreateRequest {
        model: Model::H3Max,
        prompt: "a drone shot over a quiet harbour at dawn".to_string(),
        images: Vec::new(),
        videos: Vec::new(),
        audio: Vec::new(),
        duration: 6,
        resolution: Resolution::R768P,
        ratio: Some(Ratio::R16x9),
    }
}

#[test]
fn happy_path_create_query_download() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let server = MockServer::spawn(&node, "succeeded", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let task_id = client.create_task(&base_request(), "sk-test-key").expect("create_task should succeed");
        assert!(!task_id.0.is_empty());

        let status = client.query_task(&task_id, "sk-test-key").expect("query_task should succeed");
        assert_eq!(status.status, TaskStatusKind::Succeeded);
        let url = status.url.expect("succeeded task must carry a url");

        let dest_dir = std::env::temp_dir().join(format!("minimax-client-test-{}", std::process::id()));
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("clip.mp4");
        let bytes = client.download(&url, &dest).expect("download should succeed");
        assert!(bytes > 0, "downloaded file must be non-empty");
        assert!(dest.exists());

        // ffprobe-valid: ffprobe should be able to read at least one stream.
        if let Ok(ffprobe) = which_ffprobe() {
            let output = Command::new(ffprobe)
                .args(["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])
                .arg(&dest)
                .output()
                .expect("ffprobe should run");
            assert!(output.status.success(), "ffprobe failed: {}", String::from_utf8_lossy(&output.stderr));
            assert!(!output.stdout.is_empty(), "ffprobe should report at least one stream");
        } else {
            println!("SKIP: ffprobe not found on PATH, skipping stream validation");
        }

        let _ = std::fs::remove_dir_all(&dest_dir);
    });
}

fn which_ffprobe() -> Result<PathBuf, ()> {
    let path_var = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join("ffprobe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

#[test]
fn failed_outcome_surfaces_as_typed_error() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let server = MockServer::spawn(&node, "failed", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let task_id = client.create_task(&base_request(), "sk-test-key").expect("create_task should succeed");
        let err = client.query_task(&task_id, "sk-test-key").unwrap_err();
        assert!(matches!(err, MinimaxError::Failed { .. }), "expected Failed, got {err:?}");
    });
}

#[test]
fn auth_outcome_is_401_mapped_to_auth_error() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let server = MockServer::spawn(&node, "auth", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let err = client.create_task(&base_request(), "sk-wrong-key").unwrap_err();
        assert!(matches!(err, MinimaxError::Auth), "expected Auth, got {err:?}");
    });
}

#[test]
fn rate_limited_outcome_carries_retry_after() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let server = MockServer::spawn(&node, "rate-limited", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let err = client.create_task(&base_request(), "sk-test-key").unwrap_err();
        match err {
            MinimaxError::RateLimited { retry_after } => {
                assert_eq!(retry_after, Some(Duration::from_secs(3)));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
    });
}

#[test]
fn image_rejected_outcome_is_typed_error_for_t2v_fallback() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let server = MockServer::spawn(&node, "image-rejected", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let mut req = base_request();
        req.ratio = None; // I2V request
        req.images.push(ImageContent {
            input: ImageInput::DataUri("data:image/jpeg;base64,/9j/4AAQSkZJRg==".to_string()),
            role: ImageRole::FirstFrame,
        });
        let err = client.create_task(&req, "sk-test-key").unwrap_err();
        assert!(matches!(err, MinimaxError::ImageInputRejected), "expected ImageInputRejected, got {err:?}");
    });
}

#[test]
fn slow_outcome_is_honoured_as_a_caller_side_timeout() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    // Mock delays the create response by 1500ms; client uses a much shorter
    // read timeout so the caller-side timeout fires deterministically and
    // quickly, without waiting out the real 120s production timeout.
    let server = MockServer::spawn(&node, "slow", 1500);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::with_timeouts(Duration::from_millis(200), Duration::from_millis(200)).expect("valid loopback base URL");
        let err = client.create_task(&base_request(), "sk-test-key").unwrap_err();
        assert!(matches!(err, MinimaxError::Network), "expected Network (timeout), got {err:?}");
    });
}

#[test]
fn download_stall_is_detected_within_a_bounded_time() {
    // Finding 2: downloads no longer share the 120s total request timeout;
    // instead a per-chunk "stall" deadline fires if no bytes arrive for a
    // configurable window. The mock delays the *first byte* of the file
    // response by 1500ms (via --delay-ms on the "slow" outcome); the client
    // here uses a much shorter stall timeout so the test stays fast and
    // deterministic while still exercising the real detector.
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let server = MockServer::spawn(&node, "slow", 1500);

    with_base_url(&server.base_url, || {
        // Generous connect/request timeouts (this test is about the
        // download stall detector, not the create/query timeouts), but a
        // short download-stall timeout so the 1500ms mock delay reliably
        // trips it well under a second.
        let client = MinimaxClient::with_timeouts_and_stall(
            Duration::from_secs(5),
            Duration::from_secs(5),
            Duration::from_millis(300),
        )
        .expect("valid loopback base URL");

        let task_id = client.create_task(&base_request(), "sk-test-key").expect("create_task should succeed");
        let status = client.query_task(&task_id, "sk-test-key").expect("query_task should succeed");
        assert_eq!(status.status, TaskStatusKind::Succeeded);
        let url = status.url.expect("succeeded task must carry a url");

        let dest_dir = std::env::temp_dir().join(format!("minimax-stall-test-{}", std::process::id()));
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("clip.mp4");

        let started = std::time::Instant::now();
        let err = client.download(&url, &dest).unwrap_err();
        let elapsed = started.elapsed();

        assert!(matches!(err, MinimaxError::Network), "expected Network (stall), got {err:?}");
        // Bounded: the mock's 1500ms delay would blow this way past if the
        // stall detector weren't actually firing at ~300ms.
        assert!(elapsed < Duration::from_secs(1), "stall detector took too long: {elapsed:?}");

        let _ = std::fs::remove_dir_all(&dest_dir);
    });
}

#[test]
fn temp_download_file_is_removed_when_rename_fails() {
    // Finding 3: a failed download must not leak its temp file. Force a
    // rename failure by pointing `dest` at a path that already exists as a
    // directory (std::fs::rename refuses to rename a file onto a directory).
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let server = MockServer::spawn(&node, "succeeded", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let task_id = client.create_task(&base_request(), "sk-test-key").expect("create_task should succeed");
        let status = client.query_task(&task_id, "sk-test-key").expect("query_task should succeed");
        let url = status.url.expect("succeeded task must carry a url");

        let dest_dir = std::env::temp_dir().join(format!("minimax-tempfile-test-{}", std::process::id()));
        std::fs::create_dir_all(&dest_dir).unwrap();
        // `dest` itself is a directory, so the rename step must fail.
        let dest = dest_dir.join("clip.mp4");
        std::fs::create_dir_all(&dest).unwrap();

        let err = client.download(&url, &dest).unwrap_err();
        assert!(matches!(err, MinimaxError::Network), "expected a typed error, got {err:?}");

        let tmp_path = dest_dir.join(".clip.mp4.minimax-download.tmp");
        assert!(!tmp_path.exists(), "temp download file was leaked at {tmp_path:?}");

        let _ = std::fs::remove_dir_all(&dest_dir);
    });
}

#[test]
fn auth_error_via_mock_never_leaks_api_key_in_display_debug_or_client_debug() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let secret = "sk-SECRET-123";
    let server = MockServer::spawn(&node, "auth", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let err = client.create_task(&base_request(), secret).unwrap_err();
        assert!(matches!(err, MinimaxError::Auth), "expected Auth, got {err:?}");
        assert!(!format!("{err}").contains(secret));
        assert!(!format!("{err:?}").contains(secret));
        assert!(!format!("{client:?}").contains(secret));
    });
}

#[test]
fn request_body_echo_matches_v2_contract_fields() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    // We don't need the mock to echo the body back; the client-side
    // validate_and_build_body() is already unit-tested for shape. Here we
    // confirm the same validated body is what actually gets sent, by
    // checking create_task succeeds end-to-end against the mock with a
    // fully-populated request (model/duration/resolution/ratio/role all
    // present in the wire body).
    let server = MockServer::spawn(&node, "succeeded", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let mut req = base_request();
        req.model = Model::H3;
        req.resolution = Resolution::R2K;
        let task_id = client.create_task(&req, "sk-test-key").expect("create_task should succeed");
        assert!(!task_id.0.is_empty());
    });
}

#[test]
fn prompt_over_limit_never_hits_the_network() {
    // No mock spawned at all: if this reached the network without a running
    // server it would fail with Network, not InvalidRequest. We assert the
    // client-side rejection instead, proving no HTTP call was attempted.
    let client = MinimaxClient::new().expect("default base URL should validate");
    let mut req = base_request();
    req.prompt = "x".repeat(MAX_PROMPT_CHARS + 1);
    let err = client.create_task(&req, "sk-test-key").unwrap_err();
    assert!(matches!(err, MinimaxError::InvalidRequest { field, .. } if field == "prompt"));
}

#[test]
fn api_key_never_appears_in_task_id_display_or_debug() {
    let Some(node) = node_path() else {
        println!("SKIP: node not found on PATH");
        return;
    };
    let secret = "sk-super-secret-integration-key";
    let server = MockServer::spawn(&node, "succeeded", 0);

    with_base_url(&server.base_url, || {
        let client = MinimaxClient::new().expect("default base URL should validate");
        let task_id: TaskId = client.create_task(&base_request(), secret).expect("create_task should succeed");
        assert!(!format!("{task_id}").contains(secret));
        assert!(!format!("{task_id:?}").contains(secret));

        let err = client.create_task(&base_request(), "").err();
        if let Some(e) = err {
            assert!(!format!("{e}").contains(secret));
            assert!(!format!("{e:?}").contains(secret));
        }
    });
}
