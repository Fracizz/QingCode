//! Shared filesystem locations for the app DB, settings, and CLI IPC.

use std::path::PathBuf;

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
