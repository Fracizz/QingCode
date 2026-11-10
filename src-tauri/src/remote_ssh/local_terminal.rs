//! 本机托管终端的 Tauri 命令。输入、改尺寸和结束沿用 `ssh_*_terminal`
//! （托管终端和 SSH 持久终端登记在同一张表），这里只放入口不同的部分。

use super::server::local_terminal;
use super::terminal_exit::TerminalExitAction;
use super::*;
use crate::path_guard::PathAllowlist;
use crate::terminal::{hosted_local_launch, HostedLaunchRequest, TerminalManager};

fn fallback_result(mut result: TerminalSpawnResult, reason: Option<String>) -> TerminalSpawnResult {
    result.persistent_fallback_reason = reason;
    result
}

/// 能托管时交给宿主；不能托管或宿主失败时回退进程内 PTY，绝不让用户开不出终端。
async fn spawn_hosted_or<F>(
    id: String,
    cwd: String,
    size: (u16, u16),
    request: HostedLaunchRequest<'_>,
    app: AppHandle,
    manager: &SshManager,
    fallback: F,
) -> Result<TerminalSpawnResult, String>
where
    F: FnOnce() -> Result<TerminalSpawnResult, String>,
{
    let reason = match hosted_local_launch(&cwd, request)? {
        Ok(launch) => {
            match local_terminal::spawn_local_terminal(
                id.clone(),
                cwd,
                size.0,
                size.1,
                launch,
                app,
                manager,
            )
            .await
            {
                Ok(result) => return Ok(result),
                Err(error) => {
                    eprintln!("[WARN] local hosted terminal {id} fell back: {error}");
                    error
                }
            }
        }
        Err(reason) => reason,
    };
    fallback().map(|result| fallback_result(result, Some(reason)))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn local_host_create_terminal(
    id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    name: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
    terminals: State<'_, TerminalManager>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<TerminalSpawnResult, String> {
    crate::mobile::reject_desktop_use(&id)?;
    allowlist.ensure_executable(&cwd)?;
    let (cols, rows) = (cols.unwrap_or(80), rows.unwrap_or(24));
    let request = HostedLaunchRequest {
        shell: shell.as_deref(),
        startup: None,
        env: HashMap::new(),
        name,
    };
    let fallback_id = id.clone();
    let fallback_cwd = cwd.clone();
    let fallback_app = app.clone();
    spawn_hosted_or(id, cwd, (cols, rows), request, app, &manager, || {
        terminals.spawn(
            fallback_id,
            &fallback_cwd,
            shell.as_deref(),
            cols,
            rows,
            fallback_app,
        )
    })
    .await
}

/// 终端配置（启动命令后保留 Shell）。一次性运行任务不托管，仍走 `spawn_script`。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn local_host_spawn_profile(
    id: String,
    cwd: String,
    target: String,
    env: HashMap<String, String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    name: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
    terminals: State<'_, TerminalManager>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<TerminalSpawnResult, String> {
    crate::mobile::reject_desktop_use(&id)?;
    allowlist.ensure_executable(&cwd)?;
    let (cols, rows) = (cols.unwrap_or(80), rows.unwrap_or(24));
    let request = HostedLaunchRequest {
        shell: shell.as_deref(),
        startup: Some(&target),
        env: env.clone(),
        name,
    };
    let fallback_id = id.clone();
    let fallback_cwd = cwd.clone();
    let fallback_app = app.clone();
    spawn_hosted_or(id, cwd, (cols, rows), request, app, &manager, || {
        terminals.spawn_script(
            fallback_id,
            &fallback_cwd,
            "interactive",
            &target,
            env,
            shell.as_deref(),
            None,
            cols,
            rows,
            fallback_app,
        )
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn local_host_attach_terminal(
    id: String,
    pty_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    from_seq: Option<u64>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    crate::mobile::reject_desktop_use(&id)?;
    crate::mobile::reject_desktop_use(&pty_id)?;
    local_terminal::attach_local_terminal(id, pty_id, cols.zip(rows), from_seq, app, &manager).await
}

/// 终端里是否有前台子进程（关闭标签前的确认用）。
pub(crate) async fn has_children(pty_id: &str, manager: &SshManager) -> Result<bool, String> {
    local_terminal::has_children(pty_id, manager).await
}

/// 结束尚未接回的本地托管终端（恢复后没打开过就关闭的标签）。
#[tauri::command]
pub async fn local_host_kill_detached_terminal(
    pty_id: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    if pty_id.trim().is_empty() {
        return Err("ptyId 不能为空".to_string());
    }
    crate::mobile::reject_desktop_use(&pty_id)?;
    local_terminal::kill_owned(&pty_id, "detached_cleanup", true, &manager).await
}

/// 退出确认用：本地托管终端能否活过 QingCode。宿主被连带结束时（如 `pnpm tauri:dev`
/// 下 cargo 的作业对象），弹窗不能再承诺保留它们。
#[tauri::command]
pub fn local_host_survives_app_exit() -> bool {
    crate::local_pty_host::host_survives_app_exit()
}

/// 退出应用时保留或结束一个本地托管终端。
#[tauri::command]
pub async fn local_host_finish_terminal_on_exit(
    id: String,
    pty_id: String,
    action: TerminalExitAction,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    if pty_id.trim().is_empty() {
        return Err("ptyId 不能为空".to_string());
    }
    let terminal = manager
        .persistent_terminals
        .read()
        .map_err(|_| "终端状态不可用".to_string())?
        .get(&id)
        .cloned();
    if terminal
        .as_ref()
        .is_some_and(|terminal| terminal.pty_id() != pty_id)
    {
        return Err("终端会话已变化，请重新退出".to_string());
    }
    if matches!(action, TerminalExitAction::Terminate) {
        tokio::time::timeout(
            Duration::from_secs(8),
            local_terminal::kill_owned(&pty_id, "app_exit", false, &manager),
        )
        .await
        .map_err(|_| "本地终端宿主未确认结束终端，请重试或选择仍然退出".to_string())??;
    }
    if let Some(terminal) = terminal {
        terminal.detach_for_exit().await?;
    }
    Ok(())
}
