//! Shared filesystem locations for the app DB, settings, and CLI IPC.

use std::path::{Path, PathBuf};

fn executable_directory(executable: &Path) -> Option<&Path> {
    executable
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
}

/// Windows release builds must not inherit an arbitrary shortcut working directory.
/// Resolve command-line file arguments first, then call this before initializing
/// plugins or native language/terminal components.
pub fn stabilize_runtime_working_directory() {
    if cfg!(debug_assertions) || !cfg!(windows) {
        return;
    }
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let Some(directory) = executable_directory(&executable) else {
        return;
    };
    let _ = std::env::set_current_dir(directory);
}

/// Dev builds keep state under `<repo>/.dev/`; release uses the OS app data dir.
pub fn app_data_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let project_root = manifest.parent().expect("CARGO_MANIFEST_DIR has no parent");
        project_root.join(".dev")
    } else {
        dirs::data_dir()
            .expect("no data dir")
            .join("com.qingcode.app")
    }
}

pub fn db_file() -> PathBuf {
    app_data_dir().join("qingcode.db")
}

/// JSON file written by a running GUI instance: `{"port":u16,"pid":u32}`.
pub fn ipc_endpoint_file() -> PathBuf {
    app_data_dir().join("qingcode.ipc")
}

/// Absolute `sqlite:` URL for tauri-plugin-sql (dev) or relative name (release).
pub fn build_db_url() -> String {
    if cfg!(debug_assertions) {
        let db = db_file();
        let _ = std::fs::create_dir_all(db.parent().expect("no parent"));
        format!("sqlite:{}", db.display())
    } else {
        "sqlite:qingcode.db".to_string()
    }
}

pub fn default_settings_file() -> PathBuf {
    let dir = app_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("default-settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_directory_uses_the_binary_parent() {
        assert_eq!(
            executable_directory(Path::new("/opt/qingcode/qingcode")),
            Some(Path::new("/opt/qingcode"))
        );
        assert_eq!(executable_directory(Path::new("qingcode")), None);
    }
}
