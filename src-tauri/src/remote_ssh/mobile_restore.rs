//! 电脑重启或升级后，把 daemon 上仍在运行的手机终端接回手机会话。
//!
//! 这里只接回、只分离，任何失败都不结束远端进程：接不回的终端继续留在 daemon，
//! 下一轮扫描再试，或由 detached TTL 回收。

use super::*;

pub(crate) use server::DetachedMobileTerminal;

/// 已建立且处于 Server 模式、存在可信项目根的连接；只有它们的 daemon 托管持久终端。
pub(crate) fn restorable_connections(app: &AppHandle) -> Vec<String> {
    let manager = app.state::<SshManager>();
    let Ok(roots) = manager.roots.read() else {
        return Vec::new();
    };
    let mut connections: Vec<String> = roots
        .values()
        .filter(|root| root.trusted)
        .filter_map(|root| remote_uri_connection_id(&root.uri).map(str::to_owned))
        .filter(|id| manager.server_mode(id))
        .collect();
    connections.sort_unstable();
    connections.dedup();
    connections
}

pub(crate) async fn list_detached(
    connection_id: &str,
    app: &AppHandle,
) -> Result<Vec<DetachedMobileTerminal>, String> {
    let manager = app.state::<SshManager>();
    server::list_detached_mobile_terminals(connection_id, app, &manager).await
}

/// 沿用 PTY 现有尺寸接回，手机接入时再按自己的屏幕调整。
pub(crate) async fn attach(
    terminal: &DetachedMobileTerminal,
    app: &AppHandle,
) -> Result<(), String> {
    let manager = app.state::<SshManager>();
    let root = manager.registered_root(&terminal.root_uri)?;
    server::attach_persistent_terminal(
        terminal.session_id.clone(),
        terminal.pty_id.clone(),
        root,
        None,
        None,
        app.clone(),
        &manager,
    )
    .await
    .map(|_| ())
}

/// 接回后发现手机连接已停止时只断开代理，远端进程留给 daemon。
pub(crate) async fn detach(id: &str, app: &AppHandle) {
    let terminal = app
        .state::<SshManager>()
        .persistent_terminals
        .read()
        .ok()
        .and_then(|terminals| terminals.get(id).cloned());
    if let Some(terminal) = terminal {
        let _ = terminal.detach_for_exit().await;
    }
}

pub(crate) fn is_same_root(project_path: &str, root_uri: &str) -> bool {
    normalize_remote_uri(project_path) == normalize_remote_uri(root_uri)
}
