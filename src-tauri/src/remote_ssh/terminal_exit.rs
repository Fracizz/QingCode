use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalExitAction {
    Preserve,
    Terminate,
}

/// A window supplies explicit PTY ids; never sweep a connection or stop its Server.
#[tauri::command]
pub async fn ssh_finish_terminal_on_exit(
    id: String,
    pty_id: String,
    cwd: String,
    action: TerminalExitAction,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    if pty_id.trim().is_empty() {
        return Err("ptyId 不能为空".to_string());
    }
    let terminal = manager
        .persistent_terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .cloned();
    if let Some(terminal) = &terminal {
        if terminal.pty_id() != pty_id
            || remote_uri_connection_id(&cwd) != Some(terminal.connection_id())
        {
            return Err("终端会话已变化，请重新退出".to_string());
        }
    }
    if matches!(action, TerminalExitAction::Terminate) {
        let root = manager.root_for_uri(&cwd, true)?;
        tokio::time::timeout(
            Duration::from_secs(8),
            server::kill_terminal_for_exit(&pty_id, &root, &app, &manager),
        )
        .await
        .map_err(|_| "远端未确认结束终端，请重试或选择仍然退出".to_string())??;
    }
    if let Some(terminal) = terminal {
        terminal.detach_for_exit().await?;
    }
    Ok(())
}
