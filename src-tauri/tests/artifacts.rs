use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use tripcut_studio_lib::core::{artifacts, db, import, jobs};

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "tripcut-artifacts-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn db_path(&self) -> PathBuf {
        self.path.join("project.db")
    }

    fn cache_root(&self) -> PathBuf {
        self.path.join("cache")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn ffmpeg_or_skip() -> Option<OsString> {
    let executable = std::env::var_os("FFMPEG_PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from("ffmpeg"));
    let available = Command::new(&executable)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !available {
        eprintln!("skipped: ffmpeg not found; install with `brew install ffmpeg`");
        return None;
    }
    Some(executable)
}

fn run_ffmpeg(ffmpeg: &OsStr, args: &[OsString]) -> Result<(), String> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error"])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

fn generate_video(ffmpeg: &OsStr, path: &Path, height: i64, with_audio: bool) -> Result<(), String> {
    let width = height * 16 / 9;
    let mut args = vec![
        OsString::from("-f"),
        OsString::from("lavfi"),
        OsString::from("-i"),
        OsString::from(format!("testsrc2=size={width}x{height}:rate=30")),
    ];
    if with_audio {
        args.extend([
            OsString::from("-f"),
            OsString::from("lavfi"),
            OsString::from("-i"),
            OsString::from("sine=frequency=440:sample_rate=48000"),
        ]);
    }
    args.extend([
        OsString::from("-t"),
        OsString::from("2"),
        OsString::from("-c:v"),
        OsString::from("libx264"),
        OsString::from("-pix_fmt"),
        OsString::from("yuv420p"),
    ]);
    if with_audio {
        args.extend([OsString::from("-c:a"), OsString::from("aac")]);
    } else {
        args.push(OsString::from("-an"));
    }
    args.extend([
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        OsString::from("-y"),
        path.as_os_str().to_owned(),
    ]);
    run_ffmpeg(ffmpeg, &args)
}

fn insert_clip(connection: &Connection, path: &Path, height: i64) -> (i64, String) {
    let (source_hash, bytes) = import::quick_fingerprint(path).unwrap();
    connection
        .execute("INSERT OR IGNORE INTO volumes(uuid) VALUES ('fixture-volume')", [])
        .unwrap();
    connection
        .execute(
            "INSERT INTO clips(
                volume_uuid, rel_path, byte_size, quick_hash,
                tb_num, tb_den, duration_ticks, fps_num, fps_den,
                codec, width, height, imported_at
             ) VALUES (
                'fixture-volume', ?1, ?2, ?3,
                1, 1000, 2000, 30, 1,
                'h264', ?4, ?5, 'now'
             )",
            params![
                path.to_string_lossy(),
                bytes as i64,
                source_hash,
                height * 16 / 9,
                height,
            ],
        )
        .unwrap();
    (connection.last_insert_rowid(), source_hash)
}

fn enqueue_and_claim(
    connection: &mut Connection,
    kind: &str,
    clip_id: i64,
    path: &Path,
    source_hash: &str,
) -> jobs::Job {
    let payload = serde_json::to_string(&artifacts::ArtifactJobPayload {
        clip_id,
        path: path.to_string_lossy().into_owned(),
        source_hash: source_hash.to_owned(),
    })
    .unwrap();
    jobs::enqueue(
        connection,
        kind,
        &payload,
        &format!("{kind}-{clip_id}-{source_hash}"),
    )
    .unwrap();
    jobs::claim_next(connection).unwrap().unwrap()
}

#[test]
fn thumbnail_generates_cover_and_single_horizontal_strip_and_records_both() {
    let Some(ffmpeg) = ffmpeg_or_skip() else { return };
    let directory = TestDirectory::new("thumbnail");
    let source = directory.path.join("source.mp4");
    generate_video(&ffmpeg, &source, 720, true).unwrap();
    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let (clip_id, source_hash) = insert_clip(&connection, &source, 720);
    let job = enqueue_and_claim(&mut connection, "thumbnail", clip_id, &source, &source_hash);

    artifacts::run_thumbnail(&mut connection, &job, &directory.cache_root()).unwrap();

    assert!(directory.cache_root().join(format!("{clip_id}/cover.jpg")).is_file());
    assert!(directory.cache_root().join(format!("{clip_id}/strip.jpg")).is_file());
    let records: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM cache_artifacts
             WHERE clip_id = ?1 AND kind IN ('cover', 'strip') AND source_hash = ?2",
            params![clip_id, source_hash],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(records, 2);
}

#[test]
fn waveform_decodes_pcm_and_persists_versioned_two_thousand_bin_json() {
    let Some(ffmpeg) = ffmpeg_or_skip() else { return };
    let directory = TestDirectory::new("waveform");
    let source = directory.path.join("source.mp4");
    generate_video(&ffmpeg, &source, 360, true).unwrap();
    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let (clip_id, source_hash) = insert_clip(&connection, &source, 360);
    let job = enqueue_and_claim(&mut connection, "waveform", clip_id, &source, &source_hash);

    artifacts::run_waveform(&mut connection, &job, &directory.cache_root()).unwrap();

    let bytes = fs::read(directory.cache_root().join(format!("{clip_id}/waveform.json"))).unwrap();
    let waveform: artifacts::WaveformData = serde_json::from_slice(&bytes).unwrap();
    assert_eq!((waveform.version, waveform.bins, waveform.peaks.len()), (1, 2_000, 2_000));
    assert!(waveform.peaks.iter().any(|peak| peak[0] < 0.0 && peak[1] > 0.0));
}

#[test]
fn proxy_generates_540p_file_and_database_record_for_larger_source() {
    let Some(ffmpeg) = ffmpeg_or_skip() else { return };
    let directory = TestDirectory::new("proxy");
    let source = directory.path.join("source.mp4");
    generate_video(&ffmpeg, &source, 720, true).unwrap();
    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let (clip_id, source_hash) = insert_clip(&connection, &source, 720);
    let job = enqueue_and_claim(&mut connection, "proxy", clip_id, &source, &source_hash);

    artifacts::run_proxy(&mut connection, &job, &directory.cache_root()).unwrap();

    assert!(directory.cache_root().join(format!("{clip_id}/proxy.mp4")).is_file());
    let records: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM cache_artifacts
             WHERE clip_id = ?1 AND kind = 'proxy' AND source_hash = ?2",
            params![clip_id, source_hash],
            |row| row.get(0),
        )
        .unwrap();
    let time_map_points: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM proxy_time_map WHERE clip_id = ?1",
            [clip_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(records, 1);
    assert!(time_map_points >= 2);
}

#[test]
fn proxy_marks_source_at_or_below_540p_as_direct_without_cache_file() {
    let directory = TestDirectory::new("direct-proxy");
    let source = directory.path.join("small-source.mp4");
    fs::write(&source, b"source bytes are enough because direct mode never decodes").unwrap();
    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let (clip_id, source_hash) = insert_clip(&connection, &source, 540);
    let job = enqueue_and_claim(&mut connection, "proxy", clip_id, &source, &source_hash);

    artifacts::run_proxy(&mut connection, &job, &directory.cache_root()).unwrap();

    let (status, result_path): (String, Option<String>) = connection
        .query_row(
            "SELECT status, result_path FROM jobs WHERE id = ?1",
            [job.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let records: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM cache_artifacts
             WHERE clip_id = ?1 AND kind = 'proxy'",
            [clip_id],
            |row| row.get(0),
        )
        .unwrap();
    let time_points: Vec<(i64, i64)> = connection
        .prepare(
            "SELECT proxy_ts_ms, source_ticks FROM proxy_time_map
             WHERE clip_id = ?1 ORDER BY proxy_ts_ms",
        )
        .unwrap()
        .query_map([clip_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!((status.as_str(), result_path.as_deref()), ("done", Some("direct")));
    assert_eq!(records, 0);
    assert_eq!(time_points, vec![(0, 0), (1_000, 1_000), (2_000, 2_000)]);
    assert!(!directory.cache_root().join(format!("{clip_id}/proxy.mp4")).exists());
}

#[test]
fn waveform_without_audio_writes_two_thousand_silent_peak_pairs() {
    let Some(ffmpeg) = ffmpeg_or_skip() else { return };
    let directory = TestDirectory::new("silent-waveform");
    let source = directory.path.join("silent.mp4");
    generate_video(&ffmpeg, &source, 360, false).unwrap();
    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let (clip_id, source_hash) = insert_clip(&connection, &source, 360);
    let job = enqueue_and_claim(&mut connection, "waveform", clip_id, &source, &source_hash);

    artifacts::run_waveform(&mut connection, &job, &directory.cache_root()).unwrap();

    let waveform: artifacts::WaveformData = serde_json::from_slice(
        &fs::read(directory.cache_root().join(format!("{clip_id}/waveform.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(waveform.peaks, vec![[0.0, 0.0]; 2_000]);
}

#[test]
fn corrupt_source_fails_each_artifact_independently_and_keeps_clip_metadata() {
    let Some(_) = ffmpeg_or_skip() else { return };
    let directory = TestDirectory::new("corrupt");
    let source = directory.path.join("corrupt.mp4");
    fs::write(&source, b"not a playable media file").unwrap();
    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let (clip_id, source_hash) = insert_clip(&connection, &source, 720);

    for kind in ["thumbnail", "waveform", "proxy"] {
        let job = enqueue_and_claim(&mut connection, kind, clip_id, &source, &source_hash);
        let result = match kind {
            "thumbnail" => artifacts::run_thumbnail(&mut connection, &job, &directory.cache_root()),
            "waveform" => artifacts::run_waveform(&mut connection, &job, &directory.cache_root()),
            _ => artifacts::run_proxy(&mut connection, &job, &directory.cache_root()),
        };
        assert!(result.is_err(), "{kind} unexpectedly succeeded");
        jobs::mark_failed(&mut connection, job.id, &result.unwrap_err().to_string()).unwrap();
    }

    let failed: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'failed' AND kind IN ('thumbnail', 'waveform', 'proxy')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let clips: i64 = connection
        .query_row("SELECT COUNT(*) FROM clips WHERE id = ?1", [clip_id], |row| row.get(0))
        .unwrap();
    assert_eq!((failed, clips), (3, 1));
}

#[test]
fn changed_source_hash_hides_old_record_and_missing_file_requeues_done_job() {
    let directory = TestDirectory::new("rebuild");
    let source = directory.path.join("source.mp4");
    fs::write(&source, b"current source").unwrap();
    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let (clip_id, source_hash) = insert_clip(&connection, &source, 720);
    let payload = serde_json::to_string(&artifacts::ArtifactJobPayload {
        clip_id,
        path: source.to_string_lossy().into_owned(),
        source_hash: source_hash.clone(),
    })
    .unwrap();
    let job_id = jobs::enqueue(&mut connection, "thumbnail", &payload, "rebuild-thumbnail").unwrap();
    connection
        .execute(
            "UPDATE jobs SET status = 'done', result_path = '/missing/cover.jpg' WHERE id = ?1",
            [job_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO cache_artifacts(
                clip_id, kind, rel_path, source_hash, bytes, created_at
             ) VALUES (?1, 'cover', ?2, 'old-source-hash', 4, 'now')",
            params![clip_id, format!("{clip_id}/cover.jpg")],
        )
        .unwrap();

    let artifacts = artifacts::get_clip_artifacts(
        &mut connection,
        &directory.cache_root(),
        4100,
        "session",
        clip_id,
    )
    .unwrap();
    let status: String = connection
        .query_row("SELECT status FROM jobs WHERE id = ?1", [job_id], |row| row.get(0))
        .unwrap();
    assert!(artifacts.cover.is_none());
    assert_eq!(status, "pending");
}

#[test]
#[ignore = "M5 benchmark: run explicitly on the target Apple Silicon fixture machine"]
fn m5_ten_thirty_second_1080p_samples_meet_cover_and_waveform_budgets() {
    let Some(ffmpeg) = ffmpeg_or_skip() else { return };
    let directory = TestDirectory::new("m5-benchmark");
    let seed = directory.path.join("sample-00.mp4");
    run_ffmpeg(
        &ffmpeg,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "30",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-y",
        ]
        .into_iter()
        .map(OsString::from)
        .chain(std::iter::once(seed.as_os_str().to_owned()))
        .collect::<Vec<_>>(),
    )
    .unwrap();

    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let mut fixtures = vec![seed];
    for index in 1..10 {
        let path = directory.path.join(format!("sample-{index:02}.mp4"));
        fs::copy(&fixtures[0], &path).unwrap();
        fixtures.push(path);
    }

    let cover_started = Instant::now();
    let mut clip_sources = Vec::new();
    for path in &fixtures {
        let (clip_id, source_hash) = insert_clip(&connection, path, 1080);
        connection
            .execute(
                "UPDATE clips SET duration_ticks = 30000 WHERE id = ?1",
                [clip_id],
            )
            .unwrap();
        let job = enqueue_and_claim(&mut connection, "thumbnail", clip_id, path, &source_hash);
        artifacts::run_thumbnail(&mut connection, &job, &directory.cache_root()).unwrap();
        clip_sources.push((clip_id, source_hash));
    }
    assert!(
        cover_started.elapsed() < Duration::from_secs(15),
        "ten covers took {:?}",
        cover_started.elapsed()
    );

    for ((clip_id, source_hash), path) in clip_sources.iter().zip(&fixtures) {
        let job = enqueue_and_claim(
            &mut connection,
            "waveform",
            *clip_id,
            path,
            source_hash,
        );
        let waveform_started = Instant::now();
        artifacts::run_waveform(&mut connection, &job, &directory.cache_root()).unwrap();
        assert!(
            waveform_started.elapsed() < Duration::from_secs(2),
            "waveform for {} took {:?}",
            path.display(),
            waveform_started.elapsed()
        );
    }
}
