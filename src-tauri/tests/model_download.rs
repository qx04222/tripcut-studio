//! R19 P-06 ②:模型后台下载的集成测试。起一个进程内的回环 HTTP 夹具(std TcpListener,
//! 不依赖 node),把清单里的文件 URL 用 `TRIPCUT_MODEL_BASE_URL` 那套覆盖机制指到它——
//! 与 R17 updater 的 `TRIPCUT_UPDATER_ENDPOINT` 同一条规则(https 任意主机 / http 只准回环)。
//! 覆盖:下载 → 校验 → 落地;坏 SHA → 不落地、不留半文件;取消 → 不留半文件;错误后可重试。
//!
//! 夹具的「模型」是按清单字节数造的小文件?不——清单里 CLIP 的 pytorch_model.bin 是 753 MB,
//! 夹具不可能造这么大。所以夹具用 `ModelSpec` 的可注入版本:测试自己拼一份小清单
//! (`tripcut_studio_lib::core::model_catalog::ModelSpec` 的字段全是 pub),摘要是夹具内容的真摘要。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tripcut_studio_lib::core::model_catalog::{ModelFile, ModelKind, ModelSpec};
use tripcut_studio_lib::core::model_download::{download_model, DownloadOptions, DownloadOutcome, ModelProgress};

/// 一个最小 HTTP/1.1 服务:按路径回固定字节;`corrupt` 路径回一份内容被改过一字节的副本。
struct Fixture {
    base_url: String,
    _thread: std::thread::JoinHandle<()>,
}

fn serve(routes: Vec<(String, Vec<u8>)>, chunk_delay: Duration) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    let routes = Arc::new(routes);
    let thread = std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let routes = routes.clone();
            std::thread::spawn(move || {
                let mut buffer = [0_u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
                match routes.iter().find(|(route, _)| *route == path) {
                    Some((_, body)) => {
                        let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = stream.write_all(head.as_bytes());
                        for chunk in body.chunks(16 * 1024) {
                            if !chunk_delay.is_zero() {
                                std::thread::sleep(chunk_delay);
                            }
                            if stream.write_all(chunk).is_err() {
                                break;
                            }
                        }
                    }
                    None => {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
            });
        }
    });
    Fixture { base_url: format!("http://127.0.0.1:{port}"), _thread: thread }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn leak(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}

/// 两文件的假 CLIP 清单:一个小 json + 一个 200 KB 的「权重」。
fn fake_clip_spec(weights: &[u8], config: &[u8]) -> ModelSpec {
    let files: &'static [ModelFile] = Box::leak(Box::new([
        ModelFile {
            name: "config.json",
            url: "https://example.invalid/clip/config.json",
            sha256: leak(sha256_hex(config)),
            size_bytes: config.len() as u64,
        },
        ModelFile {
            name: "pytorch_model.bin",
            url: "https://example.invalid/clip/pytorch_model.bin",
            sha256: leak(sha256_hex(weights)),
            size_bytes: weights.len() as u64,
        },
    ]));
    ModelSpec {
        id: "fake-clip",
        title: "假画面模型",
        purpose: "测试用",
        kind: ModelKind::Clip,
        files,
        min_memory_profile: "low",
    }
}

fn temp_models_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tripcut-model-dl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn options(base_url: &str) -> DownloadOptions {
    DownloadOptions {
        base_url_override: Some(base_url.to_owned()),
        stall_timeout: Duration::from_secs(5),
    }
}

fn leftovers(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".download"))
        .collect()
}

#[test]
fn downloads_verifies_and_installs_into_models_dir() {
    let weights: Vec<u8> = (0..200_000_u32).map(|i| (i % 251) as u8).collect();
    let config = br#"{"model_type":"chinese_clip"}"#.to_vec();
    let spec = fake_clip_spec(&weights, &config);
    let fixture = serve(
        vec![("/fake-clip/config.json".into(), config.clone()), ("/fake-clip/pytorch_model.bin".into(), weights.clone())],
        Duration::ZERO,
    );
    let models = temp_models_dir();
    let cancel = AtomicBool::new(false);
    let events = Mutex::new(Vec::new());

    let outcome = download_model(&spec, &models, &options(&fixture.base_url), &cancel, |event| {
        events.lock().unwrap().push(event);
    })
    .expect("download should succeed");

    let install_dir = models.join("fake-clip");
    assert_eq!(outcome, DownloadOutcome::Installed { dir: install_dir.clone() });
    assert_eq!(std::fs::read(install_dir.join("pytorch_model.bin")).unwrap(), weights);
    assert_eq!(std::fs::read(install_dir.join("config.json")).unwrap(), config);
    assert!(spec.installed(&models), "落地后 installed() 必须为真");
    assert!(leftovers(&install_dir).is_empty(), "不留 .download 临时文件");

    let events = events.lock().unwrap();
    let downloading: Vec<_> = events.iter().filter(|e| matches!(e, ModelProgress::Downloading { .. })).collect();
    assert!(!downloading.is_empty(), "要有进度事件");
    if let Some(ModelProgress::Downloading { total, downloaded, .. }) = downloading.last() {
        assert_eq!(*total, spec.total_bytes());
        assert_eq!(*downloaded, spec.total_bytes(), "最后一条进度应到满");
    }
    assert!(matches!(events.last(), Some(ModelProgress::Installed { .. })), "末尾应是 installed,实际 {:?}", events.last());
    let _ = std::fs::remove_dir_all(&models);
}

#[test]
fn a_bad_digest_is_refused_and_leaves_no_file_behind() {
    let weights: Vec<u8> = (0..100_000_u32).map(|i| (i % 13) as u8).collect();
    let config = b"{}".to_vec();
    let spec = fake_clip_spec(&weights, &config);
    // 夹具回的权重末尾改一字节:长度一样,摘要不同——size 校验过、SHA 校验必须拦。
    let mut corrupted = weights.clone();
    let last = corrupted.len() - 1;
    corrupted[last] ^= 0xff;
    let fixture = serve(
        vec![("/fake-clip/config.json".into(), config), ("/fake-clip/pytorch_model.bin".into(), corrupted)],
        Duration::ZERO,
    );
    let models = temp_models_dir();
    let cancel = AtomicBool::new(false);
    let mut last_event = None;

    let error = download_model(&spec, &models, &options(&fixture.base_url), &cancel, |event| last_event = Some(event))
        .expect_err("坏摘要必须报错");
    let message = error.to_string();
    assert!(message.contains("SHA-256") || message.contains("校验"), "错误要说清是校验失败:{message}");
    let install_dir = models.join("fake-clip");
    assert!(!install_dir.join("pytorch_model.bin").exists(), "坏文件不得落地");
    assert!(leftovers(&install_dir).is_empty(), "不留 .download 临时文件:{:?}", leftovers(&install_dir));
    assert!(!spec.installed(&models));
    assert!(matches!(last_event, Some(ModelProgress::Error { .. })), "末尾事件应是 error:{last_event:?}");
    let _ = std::fs::remove_dir_all(&models);
}

#[test]
fn cancel_stops_the_download_and_leaves_no_partial_file() {
    let weights: Vec<u8> = vec![7_u8; 512 * 1024];
    let config = b"{}".to_vec();
    let spec = fake_clip_spec(&weights, &config);
    // 每 16 KB 停 20 ms:512 KB 要 ~640 ms,足够在中途取消。
    let fixture = serve(
        vec![("/fake-clip/config.json".into(), config), ("/fake-clip/pytorch_model.bin".into(), weights)],
        Duration::from_millis(20),
    );
    let models = temp_models_dir();
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_from_callback = cancel.clone();
    let mut seen_chunks = 0_u32;

    let outcome = download_model(&spec, &models, &options(&fixture.base_url), &cancel, |event| {
        if let ModelProgress::Downloading { file, .. } = &event {
            if file == "pytorch_model.bin" {
                seen_chunks += 1;
                if seen_chunks == 3 {
                    cancel_from_callback.store(true, Ordering::Release);
                }
            }
        }
    })
    .expect("取消不是错误");
    assert_eq!(outcome, DownloadOutcome::Cancelled);
    let install_dir = models.join("fake-clip");
    assert!(!install_dir.join("pytorch_model.bin").exists(), "取消后不得留下权重文件");
    assert!(leftovers(&install_dir).is_empty(), "取消后不留 .download:{:?}", leftovers(&install_dir));
    assert!(!spec.installed(&models));
    let _ = std::fs::remove_dir_all(&models);
}

#[test]
fn a_failed_download_can_be_retried_and_then_succeeds() {
    let weights: Vec<u8> = (0..50_000_u32).map(|i| (i % 7) as u8).collect();
    let config = b"{}".to_vec();
    let spec = fake_clip_spec(&weights, &config);
    // 第一次:夹具没有权重路由 → 404 → 失败;config.json 已校验落地。
    let fixture = serve(vec![("/fake-clip/config.json".into(), config.clone())], Duration::ZERO);
    let models = temp_models_dir();
    let cancel = AtomicBool::new(false);
    download_model(&spec, &models, &options(&fixture.base_url), &cancel, |_| {}).expect_err("404 必须失败");
    assert!(!spec.installed(&models));
    assert!(leftovers(&models.join("fake-clip")).is_empty());

    // 第二次:换一个齐全的夹具重试 → 成功;已校验过的 config.json 不必重下(事件里没有它的 downloading)。
    let fixture = serve(
        vec![("/fake-clip/config.json".into(), config), ("/fake-clip/pytorch_model.bin".into(), weights)],
        Duration::ZERO,
    );
    let mut files_downloaded = Vec::new();
    let outcome = download_model(&spec, &models, &options(&fixture.base_url), &cancel, |event| {
        if let ModelProgress::Downloading { file, .. } = event {
            if !files_downloaded.contains(&file) {
                files_downloaded.push(file);
            }
        }
    })
    .expect("重试应成功");
    assert!(matches!(outcome, DownloadOutcome::Installed { .. }));
    assert!(spec.installed(&models));
    assert_eq!(files_downloaded, vec!["pytorch_model.bin".to_owned()], "已校验的文件跳过重下");
    let _ = std::fs::remove_dir_all(&models);
}

#[test]
fn base_url_override_refuses_plain_http_off_loopback() {
    use tripcut_studio_lib::core::model_download::base_url_override_is_allowed;
    assert!(base_url_override_is_allowed("http://127.0.0.1:8765"));
    assert!(base_url_override_is_allowed("http://localhost:8765"));
    assert!(base_url_override_is_allowed("https://mirror.example.com/models"));
    assert!(!base_url_override_is_allowed("http://10.0.0.5:8765"));
    assert!(!base_url_override_is_allowed("http://127.0.0.1:8080@evil.com/x"));
}
