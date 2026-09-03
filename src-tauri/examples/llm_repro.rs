//! L3 闪退复现:模拟打包环境(贫 PATH)调 describe_clip。
use std::path::PathBuf;
fn main() {
    std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"); // 打包 GUI 的真实 PATH
    let home = std::env::var("HOME").unwrap();
    let db = PathBuf::from(home).join("Library/Application Support/TripCutStudio/dev/project.db");
    let mut conn = tripcut_studio_lib::core::db::open_project(&db).expect("open");
    // 开启 LLM 并锁 claude
    tripcut_studio_lib::core::settings::set_setting(&conn, "llm_enabled", "true").unwrap();
    tripcut_studio_lib::core::settings::set_setting(&conn, "llm_provider", "claude").unwrap();
    let clip: i64 = conn.query_row("SELECT id FROM clips LIMIT 1", [], |r| r.get(0)).unwrap();
    println!("calling describe_clip({clip})...");
    match tripcut_studio_lib::core::llm::describe_clip(&mut conn, clip) {
        Ok(r) => println!("OK: {r:?}"),
        Err(e) => println!("ERR(正常路径,不崩): {e}"),
    }
    println!("survived");
}
