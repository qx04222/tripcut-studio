//! R18 车道 settings:失败任务清单(F8)与导出诊断包(M-04)。
//!
//! 两件事放一个文件,是因为它们要的是同一份事实:「后台有哪些活没干成」。
//! F8 把它画到「后台任务」页并给一颗「清空全部失败」;M-04 把它连同版本、
//! 工具链、内存档和最近三天的日志一起打进一个 zip 给人发出去。
//!
//! **F8 为什么不是前端循环 `cancel_job`**:头脑风暴里写的是「对所有 Blocked
//! 批量调 `cancel_job`」,但 `jobs::request_cancel`(jobs.rs:697)对 `blocked`
//! 与 `failed` 两个状态直接 `return Ok(())` —— 循环调一万次,界面上那几条失败
//! 任务一条都不会少。真正能把它们从视野里拿掉的是 `import_dismissed=1`,这也
//! 是 `import_control::dismiss_import_notices` 与删素材路径一直在用的那个字段。

use rusqlite::Connection;
use serde::Serialize;

use super::error::{CoreError, Result};

/// 一条没干成的后台任务。`summary` 是 `blocked_summary`(白话失败原因),可能为空。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FailedJob {
    pub id: i64,
    pub kind: String,
    pub status: String,
    pub clip_id: Option<i64>,
    pub file_name: Option<String>,
    pub summary: Option<String>,
    pub finished_at: Option<String>,
}

/// 「失败」= `failed` / `blocked`,且**不是用户自己取消的**(`cancel_requested=0`),
/// 且还没被清掉(`import_dismissed=0`)。取消掉的任务不是失败,不该混进这张清单
/// 逼用户再确认一遍。
const FAILED_WHERE: &str =
    "j.status IN ('failed','blocked') AND j.cancel_requested = 0 AND j.import_dismissed = 0";

pub fn list_failed_jobs(connection: &Connection, limit: usize) -> Result<Vec<FailedJob>> {
    let mut statement = connection.prepare(&format!(
        "SELECT j.id, j.kind, j.status, j.clip_id, c.rel_path, j.blocked_summary, j.finished_at
           FROM jobs j LEFT JOIN clips c ON c.id = j.clip_id
          WHERE {FAILED_WHERE}
          ORDER BY COALESCE(j.finished_at, j.updated_at) DESC, j.id DESC
          LIMIT ?1"
    ))?;
    let rows = statement.query_map([limit as i64], |row| {
        let rel_path: Option<String> = row.get(4)?;
        Ok(FailedJob {
            id: row.get(0)?,
            kind: row.get(1)?,
            status: row.get(2)?,
            clip_id: row.get(3)?,
            file_name: rel_path.map(|path| {
                std::path::Path::new(&path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or(path)
            }),
            summary: row.get(5)?,
            finished_at: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 「清空全部失败」:把这些行标成已知晓(`import_dismissed=1`),返回清掉几条。
/// 不删行 —— 失败原因留在库里,诊断包还要拿它;只是不再占着用户的注意力。
pub fn clear_failed_jobs(connection: &Connection) -> Result<usize> {
    Ok(connection.execute(
        &format!("UPDATE jobs AS j SET import_dismissed = 1 WHERE {FAILED_WHERE}"),
        [],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    fn seed(connection: &Connection, kind: &str, status: &str, cancelled: bool, summary: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO jobs (kind, payload, payload_hash, status, cancel_requested, blocked_summary, attempt,
                                   created_at, updated_at, finished_at)
                 VALUES (?1, '{}', ?2, ?3, ?4, ?5, 0,
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![kind, format!("{kind}:{status}:{summary}"), status, i64::from(cancelled), summary],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    /// F8:清单只收「真失败」,清空之后一条不剩;用户自己取消的、已经清过的都不算。
    #[test]
    fn failed_jobs_exclude_user_cancelled_and_clear_empties_the_list() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let blocked = seed(&connection, "analyze_l1", "blocked", false, "连续失败 3 次");
        let failed = seed(&connection, "proxy", "failed", false, "磁盘已满");
        seed(&connection, "analyze_motion", "failed", true, "用户已取消");
        seed(&connection, "ocr", "done", false, "");

        let listed = list_failed_jobs(&connection, 50).unwrap();
        let ids: Vec<i64> = listed.iter().map(|job| job.id).collect();
        assert!(ids.contains(&blocked) && ids.contains(&failed), "blocked 与 failed 都要进清单");
        assert_eq!(listed.len(), 2, "用户取消的与已完成的不算失败:{listed:?}");
        assert_eq!(
            listed.iter().find(|job| job.id == failed).unwrap().summary.as_deref(),
            Some("磁盘已满"),
        );

        assert_eq!(clear_failed_jobs(&connection).unwrap(), 2);
        assert!(list_failed_jobs(&connection, 50).unwrap().is_empty());
        // 再清一次是 0 条,不会把用户取消的那条也卷进去。
        assert_eq!(clear_failed_jobs(&connection).unwrap(), 0);
        // 行还在,失败原因没被删掉(诊断包还要读)。
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM jobs WHERE blocked_summary='磁盘已满'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    /// F8 的反证:头脑风暴建议的「循环 cancel_job」对 blocked 一行都动不了。
    /// 这条测试存在的意义是把那个假设钉死,别人再想改回去时会看见它红。
    #[test]
    fn request_cancel_does_not_clear_blocked_jobs() {
        let directory = TestDirectory::new();
        let mut connection = db::open_project(&directory.db_path()).unwrap();
        let blocked = seed(&connection, "analyze_l1", "blocked", false, "连续失败 3 次");
        crate::core::jobs::request_cancel(&mut connection, blocked).unwrap();
        assert_eq!(
            list_failed_jobs(&connection, 50).unwrap().len(),
            1,
            "cancel_job 对 blocked 是空操作 —— 「清空全部失败」不能靠它",
        );
    }
}

// ---------------------------------------------------------------------------
// R18 车道 settings M-04:导出诊断包
// ---------------------------------------------------------------------------

use std::path::{Path, PathBuf};

/// 包里带几天的日志。M-03 一共留 7 天,诊断包只要最近三天 —— 再往前的问题
/// 靠一个 zip 也查不动,反而把包撑大。
pub const BUNDLE_LOG_DAYS: u64 = 3;
/// 包里列几条失败任务。
pub const BUNDLE_FAILURE_LIMIT: usize = 20;

/// 这一句是隐私承诺,不是弹框:包里有什么、没有什么,用户在发出去之前看得到。
pub const BUNDLE_MANIFEST: &str = "\
这个包里有什么
- 应用版本、数据版本、后台线程数、内存档
- 工具链检测结果(视频处理 / 媒体信息 / 转写 / 画面识别 是否可用、版本)
- 设置里每一项的键和值(路径类的值已经换成 ~ 或 <路径>)
- 最近 3 天的运行日志(写进日志时就已经脱敏)
- 最近 20 条没干成的后台任务和它们的失败原因

这个包里没有什么
- 你的原片、封面、预览文件,一帧都没有
- 转写文字、GPS 坐标、拍摄地点
- 文件名之外的任何素材内容;绝对路径一律已经脱敏
- 任何密码 / API Key(它们在系统钥匙串里,不在设置表里)
";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DiagnosticsBundle {
    pub path: String,
    pub log_files: usize,
    pub failed_jobs: usize,
}

/// 诊断包要的失败清单:跟 F8 的那张表同源,但**不管有没有被「清空全部失败」清过** ——
/// 用户按了清空按钮不等于那次失败没发生过,排障的人还要看。
pub fn list_recent_failures(connection: &Connection, limit: usize) -> Result<Vec<FailedJob>> {
    let mut statement = connection.prepare(
        "SELECT j.id, j.kind, j.status, j.clip_id, c.rel_path, j.blocked_summary, j.finished_at
           FROM jobs j LEFT JOIN clips c ON c.id = j.clip_id
          WHERE j.status IN ('failed','blocked') AND j.cancel_requested = 0
          ORDER BY COALESCE(j.finished_at, j.updated_at) DESC, j.id DESC
          LIMIT ?1",
    )?;
    let rows = statement.query_map([limit as i64], |row| {
        let rel_path: Option<String> = row.get(4)?;
        Ok(FailedJob {
            id: row.get(0)?,
            kind: row.get(1)?,
            status: row.get(2)?,
            clip_id: row.get(3)?,
            file_name: rel_path.map(|path| {
                std::path::Path::new(&path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or(path)
            }),
            summary: row.get(5)?,
            finished_at: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 每一段文本进包之前都过这一道。**脱敏一律走 `logging::redact`** —— 一处实现,
/// 日志和诊断包给出同样的结果,不会出现"日志干净、诊断包带路径"这种半拉子。
fn clean(text: &str) -> String {
    crate::logging::redact(text).0
}

/// 把包的内容摊到一个目录里(还没打成 zip)。拆出来是为了能测:
/// 测试直接 grep 这个目录,不用先解压。
pub fn stage_bundle(
    connection: &Connection,
    cache_root: &Path,
    logs_dir: &Path,
    app_version: &str,
    stage: &Path,
) -> Result<(usize, usize)> {
    std::fs::create_dir_all(stage)?;
    std::fs::write(stage.join("这个包里有什么.txt"), BUNDLE_MANIFEST)?;

    let mut overview = String::new();
    overview.push_str(&format!("应用版本:{app_version}\n"));
    overview.push_str(&format!(
        "内存档:{}\n",
        super::memory_profile::resolve(connection).map(|profile| profile.as_str().to_owned()).unwrap_or_else(|_| "未知".to_owned())
    ));
    match super::settings::status(connection, cache_root) {
        Ok(status) => {
            let tool = |label: &str, available: bool, version: Option<&String>| {
                format!("{label}:{}{}\n", if available { "可用" } else { "缺失" }, version.map(|v| format!(" {v}")).unwrap_or_default())
            };
            overview.push_str(&tool("视频处理", status.ffmpeg.available, status.ffmpeg.version.as_ref()));
            overview.push_str(&tool("媒体信息", status.ffprobe.available, status.ffprobe.version.as_ref()));
            overview.push_str(&tool("转写", status.whisper.binary.available, status.whisper.binary.version.as_ref()));
            overview.push_str(&format!("转写模型:{}({})\n", if status.whisper.model_available { "已安装" } else { "缺失" }, status.whisper.model_tier));
            overview.push_str(&format!("画面识别:{}\n", if status.clip_sidecar.available { "已安装" } else { "未安装" }));
            overview.push_str(&format!("缓存:数据库记录 {} 字节 / 目录实测 {} 字节\n", status.cache.database_bytes, status.cache.disk_bytes));
        }
        Err(error) => overview.push_str(&format!("工具链检测失败:{error}\n")),
    }
    std::fs::write(stage.join("概况.txt"), clean(&overview))?;

    let mut settings_dump = String::new();
    for (key, value) in super::settings::get_settings(connection)? {
        settings_dump.push_str(&format!("{key} = {value}\n"));
    }
    std::fs::write(stage.join("设置.txt"), clean(&settings_dump))?;

    let failures = list_recent_failures(connection, BUNDLE_FAILURE_LIMIT)?;
    let mut failure_dump = String::new();
    for job in &failures {
        failure_dump.push_str(&format!(
            "[{}] {} {} — {}\n",
            job.status,
            job.kind,
            job.file_name.as_deref().unwrap_or("(没有对应素材)"),
            job.summary.as_deref().unwrap_or("没说原因"),
        ));
    }
    if failures.is_empty() {
        failure_dump.push_str("最近没有失败的后台任务。\n");
    }
    std::fs::write(stage.join("失败任务.txt"), clean(&failure_dump))?;

    let logs_out = stage.join("logs");
    std::fs::create_dir_all(&logs_out)?;
    let mut log_files = 0_usize;
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(BUNDLE_LOG_DAYS * 24 * 60 * 60);
    if logs_dir.is_dir() {
        for entry in std::fs::read_dir(logs_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let fresh = entry.metadata().and_then(|m| m.modified()).map(|modified| modified >= cutoff).unwrap_or(false);
            if !fresh {
                continue;
            }
            // 日志写进去的时候就脱过敏了;这里再过一道是因为 panic 日志走的是
            // `doctor::install_panic_hook`,不经过 M-03 那个 writer。
            let raw = std::fs::read(entry.path())?;
            std::fs::write(logs_out.join(entry.file_name()), clean(&String::from_utf8_lossy(&raw)))?;
            log_files += 1;
        }
    }
    Ok((log_files, failures.len()))
}

/// M-04:摊开 → 用系统自带的 `ditto` 打成 zip → 删掉摊开的那份。
/// 用 `ditto`(每台 Mac 都有)而不是引一个 zip crate:这个包一年也导不了几次,
/// 不值得为它多一条供应链。
pub fn export_diagnostics_bundle(
    connection: &Connection,
    cache_root: &Path,
    logs_dir: &Path,
    app_version: &str,
    target_zip: &Path,
) -> Result<DiagnosticsBundle> {
    let parent = target_zip.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let stem = target_zip.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "旅剪诊断".to_owned());
    let stage: PathBuf = parent.join(format!(".{stem}-staging-{}", uuid::Uuid::new_v4().simple()));

    let staged = stage_bundle(connection, cache_root, logs_dir, app_version, &stage.join(&stem));
    let (log_files, failed_jobs) = match staged {
        Ok(value) => value,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&stage);
            return Err(error);
        }
    };

    let status = std::process::Command::new("/usr/bin/ditto")
        .args(["-c", "-k", "--sequesterRsrc"])
        .arg(stage.join(&stem))
        .arg(target_zip)
        .status();
    let _ = std::fs::remove_dir_all(&stage);
    match status {
        Ok(code) if code.success() => Ok(DiagnosticsBundle {
            path: target_zip.to_string_lossy().into_owned(),
            log_files,
            failed_jobs,
        }),
        Ok(code) => Err(CoreError::BackgroundTask(format!(
            "打包没成功(ditto 退出码 {:?})。现在怎么办:换一个你有写入权限的位置再导一次,比如桌面。",
            code.code()
        ))),
        Err(error) => Err(CoreError::BackgroundTask(format!(
            "打包没成功:{error}。现在怎么办:换一个你有写入权限的位置再导一次,比如桌面。"
        ))),
    }
}

#[cfg(test)]
mod bundle_tests {
    use super::*;
    use crate::core::{db, test_support::TestDirectory};

    /// M-04 的判据:**整包 grep `/Users/` 必须 0 命中**。
    /// 先用一条故意含绝对路径的样本证明这个 grep 会红(控制组),否则
    /// "0 命中"可能只是因为根本没扫到文件。
    #[test]
    fn bundle_contains_no_absolute_paths_and_the_grep_would_have_caught_them() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let logs_dir = directory.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        let sample = "ERROR probe 失败 /Users/xin/Movies/旅行/a.mov;卷 /Volumes/西数盘/DCIM\n";
        std::fs::write(logs_dir.join("tripcut.log.2026-09-14"), sample).unwrap();
        // 设置里也塞一条带绝对路径的值(工具路径就是这么存的)。
        crate::core::settings::set_setting(&connection, crate::core::settings::FFMPEG_PATH_KEY, "/Users/xin/bin/ffmpeg").unwrap();

        // 控制组:同一套扫描规则扫样本,必须命中 —— 证明这个检测器会红。
        assert!(scan_for_paths(&logs_dir) > 0, "扫描器对含路径的样本都不报,它就是坏的");

        let stage = directory.path().join("bundle");
        let (log_files, _failures) =
            stage_bundle(&connection, &directory.path().join("cache"), &logs_dir, "0.9.0", &stage).unwrap();
        assert_eq!(log_files, 1, "最近 3 天的日志要进包");
        assert_eq!(scan_for_paths(&stage), 0, "包里还有绝对路径");
        let logged = std::fs::read_to_string(stage.join("logs/tripcut.log.2026-09-14")).unwrap();
        assert!(logged.contains("~/Movies/旅行/a.mov") && logged.contains("<卷>/DCIM"), "{logged}");
        assert!(std::fs::read_to_string(stage.join("设置.txt")).unwrap().contains("~/bin/ffmpeg"));
        // 隐私承诺那一页必须在包里,不在弹框里。
        assert!(std::fs::read_to_string(stage.join("这个包里有什么.txt")).unwrap().contains("一帧都没有"));
    }

    /// 三天前的日志不进包(包会越滚越大,而且那么久之前的也查不动了)。
    #[test]
    fn bundle_only_takes_the_last_three_days_of_logs() {
        let directory = TestDirectory::new();
        let connection = db::open_project(&directory.db_path()).unwrap();
        let logs_dir = directory.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        for (name, age_days) in [("fresh.log", 1_u64), ("stale.log", 9)] {
            let path = logs_dir.join(name);
            std::fs::write(&path, "一行日志\n").unwrap();
            let when = std::time::SystemTime::now() - std::time::Duration::from_secs(age_days * 24 * 60 * 60);
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
        }
        let stage = directory.path().join("bundle");
        let (log_files, _) = stage_bundle(&connection, &directory.path().join("cache"), &logs_dir, "0.9.0", &stage).unwrap();
        assert_eq!(log_files, 1);
        assert!(stage.join("logs/fresh.log").is_file());
        assert!(!stage.join("logs/stale.log").exists());
    }

    /// 整个目录里出现几次「以 / 开头的真实绝对路径」。这就是 M-04 的判据本身。
    fn scan_for_paths(root: &Path) -> usize {
        let mut hits = 0;
        for entry in walkdir::WalkDir::new(root).follow_links(false) {
            let entry = entry.unwrap();
            if !entry.file_type().is_file() {
                continue;
            }
            let text = String::from_utf8_lossy(&std::fs::read(entry.path()).unwrap()).into_owned();
            hits += text.matches("/Users/").count() + text.matches("/Volumes/").count();
        }
        hits
    }
}
