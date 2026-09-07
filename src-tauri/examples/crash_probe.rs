//! G18 崩溃恢复回归探针:对一个给定的项目库执行一条真实写路径(import/rate/
//! export),写路径本身照常提交,随后探针自己另开一段收尾写事务并可以在
//! 提交前异常退出——用来把崩溃点钉在 WAL 仍打开、尚未 checkpoint 的窗口。
//! 供 scripts/qa/crash-recovery.mjs 驱动:先在 TRIPCUT_CRASH_AT=before_commit
//! 下让它 abort,断言库仍然完整;再不带该变量正常跑一次,断言同一条路径依旧
//! 可写。
//!
//! 用法: cargo run --example crash_probe -- --db <库路径> --op import|rate|export
//!       [--folder <素材文件夹>] [--dest <交付目标目录>]
//!
//! 环境变量:
//!   TRIPCUT_CRASH_AT=before_commit  探针收尾事务的写语句已发出、COMMIT 之前
//!                                    abort() —— 正常的崩溃恢复场景。
//!   TRIPCUT_CRASH_AT=after_corrupt  测试专用,不代表真实崩溃:探针收尾事务
//!                                    正常提交后,把库文件从尾部截断 4096
//!                                    字节再退出。只用于证明
//!                                    crash-recovery.mjs 的完整性检查在库真
//!                                    的坏掉时会报 FAIL(检测器校准),不是
//!                                    生产代码路径。

use std::path::PathBuf;

use rusqlite::OptionalExtension;
use tripcut_studio_lib::core;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let db = PathBuf::from(arg("--db").expect("用法缺少 --db"));
    let op = arg("--op").expect("用法缺少 --op（import|rate|export）");
    let crash_at = std::env::var("TRIPCUT_CRASH_AT").ok();

    let mut conn = core::db::open_project(&db).expect("打开库失败");

    match op.as_str() {
        "import" => {
            let folder = PathBuf::from(arg("--folder").expect("op=import 缺少 --folder"));
            core::import::start_import(&mut conn, folder.as_path()).expect("start_import 失败");
        }
        "rate" => {
            let clip_id: i64 = conn
                .query_row(
                    "SELECT id FROM clips WHERE missing_since IS NULL ORDER BY id LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .expect("库中没有可评级的素材");
            core::ratings::rate_clip(&mut conn, clip_id, "binary", 1).expect("rate_clip 失败");
        }
        "export" => {
            let clip_id: i64 = conn
                .query_row(
                    "SELECT id FROM clips WHERE missing_since IS NULL ORDER BY id LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .expect("库中没有可交付的素材");
            // 交付前置条件:先收藏一条素材,保证 selected_clips 非空——这一步
            // 不是被测的崩溃路径,只是让 export 具备可执行条件。
            core::ratings::rate_clip(&mut conn, clip_id, "binary", 1).expect("交付前置收藏失败");
            // 幂等化:上一轮(可能是崩溃前)遗留的排队中导出任务会撞
            // migration_0013 的活跃导出唯一索引,取消掉才能让这条路径在
            // 崩溃后依旧可重复执行——这是真实使用场景(用户在崩溃后重开
            // 应用,看到卡住的交付任务先取消再重新开始),不是绕过测试。
            let stuck_job: Option<i64> = conn
                .query_row(
                    "SELECT id FROM jobs WHERE kind = 'export_package' AND status IN ('pending', 'running')
                     ORDER BY id DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .expect("查询在途导出任务失败");
            if let Some(job_id) = stuck_job {
                core::deliver::cancel_export(&mut conn, job_id).expect("取消在途导出任务失败");
            }
            let dest = PathBuf::from(arg("--dest").expect("op=export 缺少 --dest"));
            core::deliver::start_export(&mut conn, dest.as_path(), None, true, None).expect("start_export 失败");
        }
        other => panic!("未知 --op: {other}（应为 import|rate|export）"),
    }

    // 核心写路径的事务此时已经提交。这里另开一段独立的收尾写事务,并按需要
    // 在提交前异常退出,把崩溃点钉在"WAL 里还有一段未提交事务"这个窗口——
    // 下一次 open_project 必须能从这个状态干净恢复。
    conn.execute_batch("BEGIN IMMEDIATE;").expect("BEGIN IMMEDIATE 失败");
    conn.execute(
        "INSERT INTO settings(key, value, updated_at)
         VALUES ('crash_probe.marker', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [],
    )
    .expect("收尾事务写入失败");

    if crash_at.as_deref() == Some("before_commit") {
        std::process::abort();
    }

    conn.execute_batch("COMMIT;").expect("COMMIT 失败");

    if crash_at.as_deref() == Some("after_corrupt") {
        // 测试专用检测器校准模式:提交已经成功,这里人为把库文件尾部截掉
        // 一截,证明 crash-recovery.mjs 的 PRAGMA integrity_check 断言在库
        // 真正损坏时确实会报 FAIL,而不是不管库状态一律 PASS。
        drop(conn);
        let len = std::fs::metadata(&db).expect("stat 库文件失败").len();
        let truncated_len = len.saturating_sub(4096);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&db)
            .expect("打开库文件失败");
        file.set_len(truncated_len).expect("截断库文件失败");
        return;
    }

    println!("crash_probe ok: op={op}");
}
