use super::*;

#[test]
fn sync_deserializes_as_an_empty_mpv_barrier() {
    let command: PlayerCommand = serde_json::from_str(r#"{"type":"sync"}"#).unwrap();
    assert!(mpv_calls_for(command).unwrap().is_empty());
}
