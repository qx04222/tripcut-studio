use super::should_reload;

#[test]
fn avfoundation_near_fence_reloads_only_when_playing() {
    assert!(should_reload(false, Some(16.0), "avfoundation", Some(12.0)));
    assert!(should_reload(false, Some(16.0), "avfoundation", Some(16.0)));
    assert!(!should_reload(true, Some(16.0), "avfoundation", Some(16.0)));
}

#[test]
fn coreaudio_never_reloads() {
    assert!(!should_reload(false, Some(16.0), "coreaudio", Some(16.0)));
}

#[test]
fn no_fence_or_distant_position_does_not_reload() {
    assert!(!should_reload(false, None, "avfoundation", Some(16.0)));
    assert!(!should_reload(false, Some(16.0), "avfoundation", Some(11.999)));
}

#[test]
fn missing_or_invalid_properties_do_not_reload() {
    assert!(!should_reload(false, Some(16.0), "", Some(16.0)));
    assert!(!should_reload(false, Some(16.0), "avfoundation", None));
    for invalid in [f64::NAN, f64::INFINITY, -1.0] {
        assert!(!should_reload(false, Some(invalid), "avfoundation", Some(16.0)));
        assert!(!should_reload(false, Some(16.0), "avfoundation", Some(invalid)));
    }
}
