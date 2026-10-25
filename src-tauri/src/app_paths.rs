//! Shared filesystem locations for the app DB, settings, and CLI IPC.

use std::io::Write;
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

pub fn client_id_file() -> PathBuf {
    app_data_dir().join("qingcode-client-id")
}

/// 读取安装实例 UUID；缺失或损坏时生成并原子替换。
///
/// daemon 用 `"<安装 UUID>:<连接 id>"` 区分同一安装留下的 PTY。应用升级、
/// 重启不能改变它，否则 P3 接回与 detach 归属都会失效。
pub fn load_or_create_client_id() -> Result<String, String> {
    load_or_create_client_id_at(&client_id_file())
}

fn load_or_create_client_id_at(path: &Path) -> Result<String, String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let existing = existing.trim();
        if uuid::Uuid::parse_str(existing).is_ok() {
            return Ok(existing.to_string());
        }
    }

    let dir = path
        .parent()
        .ok_or_else(|| "客户端 ID 文件缺少父目录".to_string())?;
    std::fs::create_dir_all(dir).map_err(|error| format!("创建应用数据目录失败：{error}"))?;
    let client_id = uuid::Uuid::new_v4().to_string();
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut file = std::fs::File::create(&temporary)
            .map_err(|error| format!("创建客户端 ID 临时文件失败：{error}"))?;
        file.write_all(client_id.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("写入客户端 ID 失败：{error}"))?;
    }
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("保存客户端 ID 失败：{error}")
    })?;
    Ok(client_id)
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

    #[test]
    fn client_id_is_stable_and_replaces_invalid_content() {
        let dir = std::env::temp_dir().join(format!(
            "qingcode-client-id-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let path = dir.join("qingcode-client-id");
        let _ = std::fs::remove_dir_all(&dir);

        let first = load_or_create_client_id_at(&path).unwrap();
        assert!(uuid::Uuid::parse_str(&first).is_ok());
        assert_eq!(load_or_create_client_id_at(&path).unwrap(), first);

        std::fs::write(&path, "not-a-uuid").unwrap();
        let replacement = load_or_create_client_id_at(&path).unwrap();
        assert!(uuid::Uuid::parse_str(&replacement).is_ok());
        assert_ne!(replacement, first);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
