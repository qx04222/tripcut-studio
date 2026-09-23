use super::*;

#[test]
fn sync_deserializes_as_an_empty_mpv_barrier() {
    let command: PlayerCommand = serde_json::from_str(r#"{"type":"sync"}"#).unwrap();
    assert!(mpv_calls_for(command).unwrap().is_empty());
}

#[test]
fn r27_pause_drain_is_wired_before_pause() {
    // 接线回归:换回基线 mod.rs 时此测试仍会执行,防止纯函数存在却未接入 Pause。
    let source = include_str!("mod.rs");
    let execute = source.split("fn execute_command(").nth(1).unwrap();
    let pause = execute.split("PlayerCommand::Pause => {").nth(1).unwrap()
        .split("PlayerCommand::StepFwd =>").next().unwrap();
    let guard = pause.find("pause_drain::").expect("Pause 必须先执行音频排空防护");
    assert!(guard < pause.find("set_property(\"pause\", true)").unwrap());
}
