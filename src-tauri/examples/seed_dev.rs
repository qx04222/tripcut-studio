//! 主审验收辅助:绕过原生文件对话框,直接对开发库执行 start_import。
//! 用法:cargo run --example seed_dev -- <素材文件夹>
use std::path::PathBuf;

fn main() {
    let folder = std::env::args().nth(1).expect("用法: seed_dev <folder>");
    let home = std::env::var("HOME").unwrap();
    let db = PathBuf::from(home)
        .join("Library/Application Support/TripCutStudio/dev/project.db");
    let mut conn = tripcut_studio_lib::core::db::open_project(&db).expect("打开开发库失败");
    let started = tripcut_studio_lib::core::import::start_import(&mut conn, PathBuf::from(&folder).as_path())
        .expect("start_import 失败");
    println!("seeded: {started:?}");
}
