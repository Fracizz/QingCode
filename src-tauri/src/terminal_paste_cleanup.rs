//! Background cleanup for trusted local and WSL project attachments.
use crate::path_guard::PathAllowlist;
use tauri::Manager;

mod local;
pub(crate) use local::{cleanup_cutoff, MAX_CLEANUP_ENTRIES};

#[tauri::command]
pub async fn cleanup_terminal_paste(
    app: tauri::AppHandle,
    path: String,
    retention_days: u32,
    excluded_paths: Vec<String>,
) -> Result<usize, String> {
    let cutoff = cleanup_cutoff(retention_days)?;
    tauri::async_runtime::spawn_blocking(move || {
        let allowlist = app.state::<PathAllowlist>();
        allowlist.ensure_executable(&path)?;
        local::cleanup_local(&path, cutoff, &excluded_paths, |target| {
            allowlist.ensure_executable(&path)?;
            allowlist.ensure_writable(&target.to_string_lossy())
        })
    })
    .await
    .map_err(|error| format!("清理粘贴文件任务失败：{error}"))?
}
