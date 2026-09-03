use std::path::{Path, PathBuf};

use uuid::Uuid;

pub struct TestDirectory {
    path: PathBuf,
}

impl Default for TestDirectory {
    fn default() -> Self {
        Self::new()
    }
}

impl TestDirectory {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tripcut-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("test directory should be created");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn db_path(&self) -> PathBuf {
        self.path.join("project.db")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
