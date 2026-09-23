//! R29:自动档「这条素材本次会话已经判过」的记忆。原片真播不动退了代理,下次再打开同一条素材直接用代理播,
//! 不再每次先播几秒原片、卡住、再掉;反过来「代理也一样卡 = 整机忙」锁回原片的决定也记住。只在进程内存里,
//! 重启应用或换素材(不同 clip_id)都重新判。
use std::{collections::HashMap, sync::Mutex};
use super::preview_source::{initial_kind, playback_proxy, PreviewQuality, SourceKind, SourcePlan};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoDecision { Degraded, Blocked }

static DECISIONS: Mutex<Option<HashMap<i64, AutoDecision>>> = Mutex::new(None);

pub fn remember(clip_id: i64, decision: AutoDecision) {
    let mut guard = DECISIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.get_or_insert_with(HashMap::new).insert(clip_id, decision);
}
/// R29:打开素材时的来源。本次会话已判过「原片播不动」的素材开播就用代理(1080p 优先),不再先播几秒原片再掉。
pub fn open_kind(plan: &SourcePlan, clip_id: i64, start_paused: bool) -> SourceKind {
    let has_proxy = plan.proxy.is_some() || plan.proxy_hq.is_some();
    if plan.quality == PreviewQuality::Auto && !start_paused && has_proxy && recall(clip_id) == Some(AutoDecision::Degraded) {
        return playback_proxy(plan);
    }
    initial_kind(plan)
}
pub fn recall(clip_id: i64) -> Option<AutoDecision> {
    let guard = DECISIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.as_ref().and_then(|map| map.get(&clip_id).copied())
}
#[cfg(test)]
pub fn forget(clip_id: i64) {
    let mut guard = DECISIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(map) = guard.as_mut() { map.remove(&clip_id); }
}
