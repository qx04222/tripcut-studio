use libmpv2::Mpv;

/// avfoundation 的长音频缓冲在围栏附近可能已到 EOF,暂停前需丢弃排空等待。
pub(super) fn should_reload(paused: bool, end: Option<f64>, ao: &str, pos: Option<f64>) -> bool {
    if paused || ao != "avfoundation" { return false; }
    match (end, pos) {
        (Some(end), Some(pos)) => end.is_finite() && end >= 0.0
            && pos.is_finite() && pos >= 0.0 && pos >= end - 4.0,
        _ => false,
    }
}

pub(super) fn prepare_pause(mpv: &Mpv, end: Option<f64>) {
    // 属性无法回读时不猜测设备或位置,仍让调用方正常暂停。
    if end.is_none() || mpv.get_property::<bool>("pause").unwrap_or(true) { return; }
    let ao = mpv.get_property::<String>("current-ao").unwrap_or_default();
    if should_reload(false, end, &ao, mpv.get_property::<f64>("time-pos").ok()) {
        if let Err(error) = mpv.command("ao-reload", &[]) {
            tracing::warn!(%error, "暂停前重载音频输出失败,继续暂停");
        }
    }
}

#[cfg(test)]
#[path = "pause_drain_tests.rs"]
mod tests;
