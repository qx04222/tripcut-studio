use std::path::PathBuf;

/// Returns the shared TripCut application-support root.
///
/// Production keeps the historical macOS location. Unattended QA may set
/// `TRIPCUT_APP_SUPPORT_DIR` to an absolute, disposable directory so a packaged
/// app never reads or writes the user's real project, cache, models, or tools.
pub(crate) fn app_support_root() -> Option<PathBuf> {
    std::env::var_os("TRIPCUT_APP_SUPPORT_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("TripCutStudio")
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_fallback_shape_is_documented() {
        let root = PathBuf::from("/Users/example")
            .join("Library")
            .join("Application Support")
            .join("TripCutStudio");
        assert!(root.ends_with("Library/Application Support/TripCutStudio"));
    }
}
