//! 主审验收辅助:无头端到端跑一次稳定交付包(读 dev 库真实收藏)。
//! export_package 优先级最高,claim 一次即命中,不扰动其余队列。
use std::path::PathBuf;

fn main() {
    let dest = std::env::args().nth(1).expect("用法: export_e2e <目标目录>");
    let home = std::env::var("HOME").unwrap();
    let db = PathBuf::from(home).join("Library/Application Support/TripCutStudio/dev/project.db");
    let mut conn = tripcut_studio_lib::core::db::open_project(&db).expect("打开开发库失败");
    let status =
        tripcut_studio_lib::core::deliver::start_export(&mut conn, PathBuf::from(&dest).as_path())
            .expect("start_export 失败");
    println!("started: {status:?}");
    let job = tripcut_studio_lib::core::jobs::claim_next(&mut conn)
        .expect("claim 失败")
        .expect("队列为空");
    assert_eq!(job.kind, "export_package", "claim 到的不是导出任务: {}", job.kind);
    match tripcut_studio_lib::core::deliver::run_export_package(&mut conn, &job) {
        Ok(()) => println!("export ok"),
        Err(e) => println!("export err: {e}"),
    }
    let fin = tripcut_studio_lib::core::deliver::get_export_status(&conn, None).expect("status");
    println!("final: {fin:?}");
}
