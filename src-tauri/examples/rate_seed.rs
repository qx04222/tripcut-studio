//! 主审验收辅助:无头给前 N 条素材打收藏,为交付包走查备数据。
//! 用法:cargo run --example rate_seed -- <N>
use std::path::PathBuf;

fn main() {
    let n: i64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(6);
    let home = std::env::var("HOME").unwrap();
    let db = PathBuf::from(home).join("Library/Application Support/TripCutStudio/dev/project.db");
    let mut conn = tripcut_studio_lib::core::db::open_project(&db).expect("打开开发库失败");
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM clips WHERE missing_since IS NULL ORDER BY captured_at LIMIT ?1")
            .unwrap();
        stmt.query_map([n], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    for id in &ids {
        tripcut_studio_lib::core::ratings::rate_clip(&mut conn, *id, "binary", 1).expect("评级失败");
    }
    println!("favorited {} clips: {:?}", ids.len(), ids);
}
