use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tripcut_studio_lib::core::{db, import, jobs};

static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let unique = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tripcut-import-fixtures-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
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

struct FixtureSet {
    h264: PathBuf,
    hevc: PathBuf,
    vfr: PathBuf,
    corrupt: PathBuf,
    renamed_duplicate: PathBuf,
}

fn executable_from_env(variable: &str, fallback: &str) -> OsString {
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from(fallback))
}

fn command_exists(executable: &OsStr) -> bool {
    Command::new(executable)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn required_media_tools() -> OsString {
    let ffmpeg = executable_from_env("FFMPEG_PATH", "ffmpeg");
    let ffprobe = executable_from_env("FFPROBE_PATH", "ffprobe");
    assert!(
        command_exists(&ffmpeg) && command_exists(&ffprobe),
        "media integration tests require executable ffmpeg and ffprobe; set FFMPEG_PATH/FFPROBE_PATH explicitly"
    );
    ffmpeg
}

fn run_ffmpeg(ffmpeg: &OsStr, args: &[OsString]) -> Result<(), String> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error"])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
}

fn h264_args(path: &Path) -> Vec<OsString> {
    [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-t",
        "3",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
    ]
    .into_iter()
    .map(OsString::from)
    .chain(std::iter::once(path.as_os_str().to_owned()))
    .collect()
}

fn generate_h264(ffmpeg: &OsStr, path: &Path) -> Result<(), String> {
    run_ffmpeg(ffmpeg, &h264_args(path))
}

fn generate_fixture_set(ffmpeg: &OsStr, root: &Path) -> Result<FixtureSet, String> {
    let h264 = root.join("h264.mp4");
    let hevc = root.join("hevc.mov");
    let vfr = root.join("vfr.mp4");
    let corrupt = root.join("truncated.mp4");
    let renamed_duplicate = root.join("renamed-copy.mp4");

    generate_h264(ffmpeg, &h264)?;
    run_ffmpeg(
        ffmpeg,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30",
            "-t",
            "3",
            "-an",
            "-c:v",
            "libx265",
            "-tag:v",
            "hvc1",
            "-pix_fmt",
            "yuv420p",
            "-y",
        ]
        .into_iter()
        .map(OsString::from)
        .chain(std::iter::once(hevc.as_os_str().to_owned()))
        .collect::<Vec<_>>(),
    )?;
    run_ffmpeg(
        ffmpeg,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30",
            "-t",
            "3",
            "-an",
            "-vf",
            "setpts=PTS+floor(N/5)*0.04/TB",
            "-fps_mode",
            "vfr",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-y",
        ]
        .into_iter()
        .map(OsString::from)
        .chain(std::iter::once(vfr.as_os_str().to_owned()))
        .collect::<Vec<_>>(),
    )?;

    fs::copy(&h264, &corrupt).map_err(|error| error.to_string())?;
    fs::OpenOptions::new()
        .write(true)
        .open(&corrupt)
        .and_then(|file| file.set_len(256))
        .map_err(|error| error.to_string())?;
    fs::copy(&h264, &renamed_duplicate).map_err(|error| error.to_string())?;

    Ok(FixtureSet {
        h264,
        hevc,
        vfr,
        corrupt,
        renamed_duplicate,
    })
}

fn drain_jobs(db_path: &Path) {
    while jobs::JobRunner::run_one(db_path).unwrap() {}
}

#[test]
fn ffmpeg_generates_h264_hevc_vfr_corrupt_and_duplicate_fixtures_at_runtime() {
    let ffmpeg = required_media_tools();
    let directory = TestDirectory::new();
    let fixtures = generate_fixture_set(&ffmpeg, &directory.path).unwrap();

    assert_eq!(import::probe_media(&fixtures.h264).unwrap().codec.as_deref(), Some("h264"));
    assert_eq!(import::probe_media(&fixtures.hevc).unwrap().codec.as_deref(), Some("hevc"));
    assert!(import::probe_media(&fixtures.vfr).unwrap().is_vfr);
    assert!(import::probe_media(&fixtures.corrupt).is_err());
    assert_eq!(
        import::quick_fingerprint(&fixtures.h264).unwrap(),
        import::quick_fingerprint(&fixtures.renamed_duplicate).unwrap()
    );
}

#[test]
fn renamed_content_is_deduplicated_and_full_hash_is_filled_in() {
    let ffmpeg = required_media_tools();
    let directory = TestDirectory::new();
    let source = directory.path.join("source");
    fs::create_dir_all(&source).unwrap();
    let original = source.join("a-original.mp4");
    let renamed = source.join("b-renamed.mp4");
    generate_h264(&ffmpeg, &original).unwrap();
    fs::copy(&original, &renamed).unwrap();

    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let started = import::start_import(&mut connection, &source).unwrap();
    assert_eq!((started.total, started.enqueued), (2, 2));
    drop(connection);
    drain_jobs(&directory.db_path());

    let connection = db::open_project(&directory.db_path()).unwrap();
    let clip_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))
        .unwrap();
    let full_hash_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM clips WHERE full_hash IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let listed = import::list_clips(&connection).unwrap();
    assert_eq!(clip_count, 1);
    assert_eq!(full_hash_count, 1);
    assert!(listed.iter().any(|clip| clip.status == "duplicate"));
}

#[test]
fn interrupted_import_recovers_without_duplicate_or_omission_and_restart_is_idempotent() {
    let ffmpeg = required_media_tools();
    let directory = TestDirectory::new();
    let source = directory.path.join("resume-source");
    fs::create_dir_all(&source).unwrap();
    let seed = source.join("clip-000.mp4");
    generate_h264(&ffmpeg, &seed).unwrap();
    for index in 1..50 {
        fs::copy(&seed, source.join(format!("clip-{index:03}.mp4"))).unwrap();
    }

    let mut connection = db::open_project(&directory.db_path()).unwrap();
    let first = import::start_import(&mut connection, &source).unwrap();
    let second = import::start_import(&mut connection, &source).unwrap();
    assert_eq!(first.enqueued, 50);
    assert_eq!(second.enqueued, 0);
    assert_eq!(second.skipped, 50);
    let claimed = jobs::claim_next(&mut connection).unwrap().unwrap();
    assert_eq!(claimed.kind, "import_probe");
    drop(connection);

    let mut reopened = db::open_project(&directory.db_path()).unwrap();
    reopened
        .execute(
            "UPDATE jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
             WHERE status='running'",
            [],
        )
        .unwrap();
    assert_eq!(jobs::recover_running(&mut reopened).unwrap(), 1);
    drop(reopened);
    drain_jobs(&directory.db_path());

    let connection = db::open_project(&directory.db_path()).unwrap();
    let progress = import::get_import_progress(&connection).unwrap();
    assert_eq!(progress.total, 50);
    assert_eq!(progress.done, 50);
    assert_eq!(progress.failed, 0);
}

#[test]
fn truncated_media_fails_one_job_and_remains_visible_without_stopping_the_queue() {
    let ffmpeg = required_media_tools();
    let directory = TestDirectory::new();
    let source = directory.path.join("corrupt-source");
    fs::create_dir_all(&source).unwrap();
    let valid = source.join("will-be-truncated.mp4");
    generate_h264(&ffmpeg, &valid).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&valid)
        .unwrap()
        .set_len(256)
        .unwrap();

    let mut connection = db::open_project(&directory.db_path()).unwrap();
    import::start_import(&mut connection, &source).unwrap();
    drop(connection);
    drain_jobs(&directory.db_path());

    let connection = db::open_project(&directory.db_path()).unwrap();
    let progress = import::get_import_progress(&connection).unwrap();
    let listed = import::list_clips(&connection).unwrap();
    assert_eq!(progress.failed, 1);
    assert!(listed.iter().any(|clip| {
        clip.status == "unreadable"
            && clip.error.as_deref().is_some_and(|error| error.contains("ffprobe"))
    }));
}

#[test]
fn one_hundred_sample_import_finishes_within_sixty_seconds() {
    let ffmpeg = required_media_tools();
    let directory = TestDirectory::new();
    let source = directory.path.join("hundred-source");
    fs::create_dir_all(&source).unwrap();
    let seed = source.join("sample-000.mp4");
    generate_h264(&ffmpeg, &seed).unwrap();
    for index in 1..100 {
        fs::copy(&seed, source.join(format!("sample-{index:03}.mp4"))).unwrap();
    }

    let started_at = Instant::now();
    let mut connection = db::open_project(&directory.db_path()).unwrap();
    import::start_import(&mut connection, &source).unwrap();
    drop(connection);
    drain_jobs(&directory.db_path());
    let elapsed = started_at.elapsed();

    let connection = db::open_project(&directory.db_path()).unwrap();
    assert_eq!(import::get_import_progress(&connection).unwrap().done, 100);
    assert!(
        elapsed < Duration::from_secs(60),
        "100-file import took {elapsed:?}"
    );
}
