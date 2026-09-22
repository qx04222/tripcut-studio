//! R6 Task 2：剪映真机金丝雀。
//!
//! 三段都对活环境做实读：
//!   (a) 从 `/Applications/VideoFusion-macOS.app` 的 Info.plist 读安装版本，
//!       断言它在 `SUPPORTED_JIANYING_VERSIONS` 白名单里；
//!   (b) 在草稿根下找最新的 `template.tmp`（剪映自己写的真草稿，不是我们生成
//!       的），解析成 JSON，断言其顶层键集与 `materials` 键集与我们内嵌金样
//!       （`jianying::golden_key_sets()`）逐键相等；
//!   (c) 用我们的生成器往一个临时 `TRIPCUT_JIANYING_DRAFT_ROOT` 里落一份草稿，
//!       断言 `generate_native_draft` 成功——它内部的 `build_draft`/
//!       `validate_written_draft` 会跑 `validate_draft`，成功即证明我们生成的
//!       草稿键集合和时间线也过了同一份金样校验。
//!
//! 剪映没装、或找不到任何 `template.tmp` 时：打印 `SKIP: <原因>` 后直接
//! return，不做任何断言——不允许假绿。这台机器上剪映 11.3.0 已装且至少有一份
//! 真草稿，所以正常情况下这个测试应该真的跑断言，而不是走 SKIP 分支。
//!
//! 只读 `~/Movies/JianyingPro`，不在里面写任何东西。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusqlite::params;
use serde_json::Value;

use tripcut_studio_lib::core::{db, import, jianying, ratings};

const JIANYING_APP_PLIST: &str = "/Applications/VideoFusion-macOS.app/Contents/Info.plist";

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "tripcut-jianying-canary-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
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

/// 读安装的剪映版本号。跟 `jianying.rs` 内部读法一样走 PlistBuddy，避免因为解析
/// 方式不同而验出两套"版本号"。
fn installed_jianying_version() -> Option<String> {
    if !Path::new(JIANYING_APP_PLIST).is_file() {
        return None;
    }
    let output = Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg("Print :CFBundleShortVersionString")
        .arg(JIANYING_APP_PLIST)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!version.is_empty()).then_some(version)
}

/// 草稿根目录下每个子目录里找 `template.tmp`，按 mtime 取最新那份。
fn newest_template_tmp(drafts_root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(drafts_root).ok()?;
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.filter_map(|entry| entry.ok()) {
        let candidate = entry.path().join("template.tmp");
        let Ok(metadata) = fs::metadata(&candidate) else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if newest.as_ref().is_none_or(|(seen, _)| modified > *seen) {
            newest = Some((modified, candidate));
        }
    }
    newest.map(|(_, path)| path)
}

fn drafts_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let root = PathBuf::from(home)
        .join("Movies")
        .join("JianyingPro")
        .join("User Data")
        .join("Projects")
        .join("com.lveditor.draft");
    root.is_dir().then_some(root)
}

fn key_set(object: &serde_json::Map<String, Value>) -> std::collections::BTreeSet<String> {
    object.keys().cloned().collect()
}

/// 往临时库播一条已收藏的素材,返回连接(生成器读它做草稿输入)。
fn seed_selected_clip(staging: &TestDirectory) -> rusqlite::Connection {
    let source = staging.path.join("selected.mov");
    fs::write(&source, b"jianying canary source bytes").unwrap();
    let (quick_hash, byte_size) = import::quick_fingerprint(&source).unwrap();
    let mut connection = db::open_project(&staging.db_path()).unwrap();
    connection
        .execute("INSERT INTO volumes(uuid) VALUES ('canary-volume')", [])
        .unwrap();
    connection
        .execute(
            "INSERT INTO clips(
                volume_uuid, rel_path, byte_size, quick_hash, tb_num, tb_den,
                duration_ticks, fps_num, fps_den, is_vfr, codec, width, height,
                imported_at, episode_id
             ) VALUES (
                'canary-volume', ?1, ?2, ?3, 1, 1000, 1000, 30, 1, 0,
                'h264', 1920, 1080, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                (SELECT id FROM episodes WHERE status='active')
             )",
            params![source.to_string_lossy(), byte_size as i64, quick_hash],
        )
        .unwrap();
    let clip_id = connection.last_insert_rowid();
    ratings::rate_clip(&mut connection, clip_id, "binary", 1).unwrap();
    connection
}

/// R14 §9 A 真机烟测:装的是「待人眼验证」版本时,走试验开关 —— 真读 Info.plist 的版本、
/// 真跑 `availability` + `generate_native_draft(force = true)`,草稿落到临时
/// `TRIPCUT_JIANYING_DRAFT_ROOT`(绝不写业主的 `~/Movies/JianyingPro/`),断言:
/// 不 force 被拒、force 成功且 `experimental`、目录名带「试验」+ 时间戳、`draft_info.json`
/// 顶层 / materials 键集与 11.3.0 金样逐键相等、连生成两次不撞名不覆盖。
fn force_smoke_for_pending_version(installed_version: &str) {
    let staging = TestDirectory::new("force");
    let draft_root = staging.path.join("drafts");
    fs::create_dir_all(&draft_root).unwrap();
    let mut connection = seed_selected_clip(&staging);

    // SAFETY(测试专用):本 crate 的这个测试文件只有一个 #[test],没有并发写环境变量。
    unsafe {
        std::env::set_var("TRIPCUT_JIANYING_DRAFT_ROOT", &draft_root);
    }
    let availability = jianying::availability(&connection);
    let refused = jianying::generate_native_draft(&mut connection, false, false);
    let first = jianying::generate_native_draft(&mut connection, true, false);
    let second = jianying::generate_native_draft(&mut connection, true, false);
    unsafe {
        std::env::remove_var("TRIPCUT_JIANYING_DRAFT_ROOT");
    }

    assert_eq!(availability.installed_version.as_deref(), Some(installed_version));
    assert!(!availability.usable && availability.force_allowed, "待验证版本应 usable=false、force_allowed=true:{availability:?}");
    assert!(refused.is_err(), "不 force 时待验证版本必须被拒");
    let first = first.unwrap_or_else(|error| panic!("force 生成失败：{error}"));
    let second = second.unwrap_or_else(|error| panic!("第二次 force 生成失败：{error}"));
    assert!(first.experimental && second.experimental);
    assert_eq!(first.jianying_version, installed_version);
    assert!(first.draft_name.contains("试验"), "目录名应带「试验」：{}", first.draft_name);
    assert_ne!(first.draft_path, second.draft_path, "两次 force 必须是两个新目录");
    assert!(Path::new(&first.draft_path).is_dir() && Path::new(&second.draft_path).is_dir());
    assert!(Path::new(&first.draft_path).starts_with(&draft_root), "草稿必须落在临时根下：{}", first.draft_path);

    let written: Value = serde_json::from_slice(&fs::read(Path::new(&first.draft_path).join("draft_info.json")).unwrap()).unwrap();
    let (golden_top, golden_materials) = jianying::golden_key_sets();
    assert_eq!(key_set(written.as_object().unwrap()), golden_top, "顶层键集与 11.3.0 金样不一致");
    assert_eq!(key_set(written["materials"].as_object().unwrap()), golden_materials, "materials 键集与 11.3.0 金样不一致");
    println!(
        "R14 force 烟测通过:剪映 {installed_version} · 草稿 {} 与 {} · 顶层 {} 键 / materials {} 键均与金样一致",
        first.draft_name,
        second.draft_name,
        golden_top.len(),
        golden_materials.len()
    );
}

#[test]
fn jianying_canary_against_live_environment() {
    // (a) 安装版本必须在白名单里。
    let Some(installed_version) = installed_jianying_version() else {
        println!("SKIP: 未找到剪映（{JIANYING_APP_PLIST} 缺失或不可读），跳过真机金丝雀");
        return;
    };
    if jianying::JIANYING_VERSIONS_PENDING_HUMAN_CHECK.contains(&installed_version.as_str()) {
        println!(
            "WARN: 已安装剪映 {installed_version} 在待人眼验证名单中(草稿文件已加密,键集比对不可行)——业主需在剪映里打开一次 TripCut 草稿确认;金丝雀改跑 R14 试验开关(force)烟测"
        );
        force_smoke_for_pending_version(&installed_version);
        return;
    }
    assert!(
        jianying::SUPPORTED_JIANYING_VERSIONS.contains(&installed_version.as_str()),
        "已安装剪映 {installed_version} 不在白名单 {:?} 中——先跑一轮 E0 金丝雀确认新版本 template.tmp 结构，再把版本号加进白名单",
        jianying::SUPPORTED_JIANYING_VERSIONS
    );
    println!("剪映已安装版本：{installed_version}（在白名单内）");

    // (b) 磁盘上最新一份真草稿的 template.tmp 键集，必须跟我们的内嵌金样一致。
    let Some(root) = drafts_root() else {
        println!("SKIP: 未找到剪映草稿根目录，跳过真机金丝雀");
        return;
    };
    let Some(template_path) = newest_template_tmp(&root) else {
        println!(
            "SKIP: {} 下没有任何草稿含 template.tmp，跳过真机金丝雀",
            root.display()
        );
        return;
    };
    println!("对比的真草稿模板：{}", template_path.display());

    let template_bytes = fs::read(&template_path)
        .unwrap_or_else(|error| panic!("无法读取 {}：{error}", template_path.display()));
    let template_value: Value = serde_json::from_slice(&template_bytes)
        .unwrap_or_else(|error| panic!("{} 不是合法 JSON：{error}", template_path.display()));
    let live_top_level = key_set(
        template_value
            .as_object()
            .expect("template.tmp 顶层必须是 JSON 对象"),
    );
    let live_materials = key_set(
        template_value
            .get("materials")
            .and_then(Value::as_object)
            .expect("template.tmp 必须含 materials 对象"),
    );

    let (golden_top_level, golden_materials) = jianying::golden_key_sets();

    println!(
        "顶层键集：真草稿 {} 个 / 金样 {} 个",
        live_top_level.len(),
        golden_top_level.len()
    );
    println!(
        "materials 键集：真草稿 {} 个 / 金样 {} 个",
        live_materials.len(),
        golden_materials.len()
    );

    assert_eq!(
        live_top_level, golden_top_level,
        "真草稿 {} 的顶层键集与内嵌金样不一致",
        template_path.display()
    );
    assert_eq!(
        live_materials, golden_materials,
        "真草稿 {} 的 materials 键集与内嵌金样不一致",
        template_path.display()
    );
    println!("真机键集比对通过：顶层与 materials 键集均与金样逐键相等");

    // (c) 用我们的生成器往临时草稿根落一份草稿，走一遍 build_draft/
    // validate_written_draft 里的 validate_draft，证明我们产出的草稿也过同一份
    // 金样校验——不是只有解析用的常量对得上。
    let staging = TestDirectory::new("gen");
    let draft_root = staging.path.join("drafts");
    fs::create_dir_all(&draft_root).unwrap();

    let mut connection = seed_selected_clip(&staging);

    // SAFETY(测试专用): std::env::set_var 在多线程测试里通常不安全，但这个
    // crate 里 jianying_canary.rs 只含这一个 #[test] 函数，不存在并发写同一个
    // 环境变量的风险。
    unsafe {
        std::env::set_var("TRIPCUT_JIANYING_DRAFT_ROOT", &draft_root);
    }
    let result = jianying::generate_native_draft(&mut connection, false, false);
    unsafe {
        std::env::remove_var("TRIPCUT_JIANYING_DRAFT_ROOT");
    }

    let result = result.unwrap_or_else(|error| panic!("生成器在临时草稿根下失败：{error}"));
    assert_eq!(result.status, "created");
    assert_eq!(result.jianying_version, installed_version);
    assert!(Path::new(&result.output_path).join("draft_info.json").is_file());
    println!(
        "生成器落草稿通过 validate_draft：{}（jianying_version={}）",
        result.output_path, result.jianying_version
    );
}
