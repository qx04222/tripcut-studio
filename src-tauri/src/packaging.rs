use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::path::BaseDirectory;
use tauri::Manager;

#[derive(Clone, Debug)]
pub struct SidecarPaths {
    pub python: PathBuf,
    pub service: PathBuf,
    pub setup_script: PathBuf,
}

static BUNDLED_SIDECAR_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn configure<R: tauri::Runtime>(app: &tauri::App<R>) {
    let development_root = development_sidecar_root();
    let resource_root = app
        .path()
        .resolve("sidecar", BaseDirectory::Resource)
        .ok()
        .filter(|path| path.join("clip_service.py").is_file())
        .unwrap_or(development_root);
    let _ = BUNDLED_SIDECAR_ROOT.set(resource_root);
}

pub fn sidecar_paths() -> SidecarPaths {
    let root = std::env::var_os("TRIPCUT_CLIP_SIDECAR_DIR")
        .map(PathBuf::from)
        .or_else(|| BUNDLED_SIDECAR_ROOT.get().cloned())
        .unwrap_or_else(development_sidecar_root);
    let python = std::env::var_os("TRIPCUT_CLIP_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| default_sidecar_python(&root));
    SidecarPaths {
        service: root.join("clip_service.py"),
        setup_script: root.join("setup.sh"),
        python,
    }
}

fn development_sidecar_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar")
}

fn default_sidecar_python(root: &std::path::Path) -> PathBuf {
    let user_python = crate::app_paths::app_support_root()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("sidecar")
        .join(".venv")
        .join("bin")
        .join("python");
    let legacy_development_python = root.join(".venv/bin/python");
    if user_python.is_file() || !legacy_development_python.is_file() {
        user_python
    } else {
        legacy_development_python
    }
}
