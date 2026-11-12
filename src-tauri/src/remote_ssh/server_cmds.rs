//! 远端 qingcode-server 管理命令：信息、延迟、重启、更新、停止、日志与离线包。

use super::*;

/// 查询项目阶段；断开后保留可恢复的离线状态。
#[tauri::command]
pub async fn ssh_server_info(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshServerState, String> {
    let parsed = parse_remote_uri(&root_uri)?;
    manager.refresh_direct_status(&parsed.connection_id).await?;
    let state = server_status::ssh_server_info(root_uri.clone(), manager.clone())?;
    // 「正在探测」却没有任务在推进（端点被清掉、监督任务已退出等）时，
    // 查询顺手补一轮后台发现，结果经状态事件推回芯片。
    if state.phase == server_status::ServerPhase::Probing && !manager.root_is_passive(&root_uri) {
        if let Ok(root) = manager.registered_root(&root_uri) {
            server::kick_server_discovery(&app, &manager, &root);
        }
    }
    Ok(state)
}

/// Measure an authenticated Server request without changing connection health.
#[tauri::command]
pub async fn ssh_server_latency(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<f64, String> {
    measure_direct_latency(&manager, &root_uri).await
}

/// A read-only probe must not reconnect or alter the connection's health state.
pub(super) async fn measure_direct_latency(
    manager: &SshManager,
    root_uri: &str,
) -> Result<f64, String> {
    manager.root_for_uri(root_uri, true)?;
    let parsed = parse_remote_uri(root_uri)?;
    let id = &parsed.connection_id;
    let config = manager
        .direct_config(id)
        .filter(|_| manager.connection_is_open(id))
        .ok_or("Server 连接尚未建立")?;
    let elapsed = direct::WorkspaceClient::new(config.clone())
        .latency_ms()
        .await?;
    // Reject results from a transport that was disconnected or re-paired in flight.
    if !manager.connection_is_open(id)
        || !manager.direct_config(id).is_some_and(|current| {
            current.endpoint == config.endpoint
                && current.certificate_fingerprint == config.certificate_fingerprint
                && current.token == config.token
        })
    {
        return Err("Server 连接已变更".into());
    }
    Ok(elapsed)
}

/// 清掉该根的 server slot，必要时按 server.json 里的 pid 结束 serve 进程，再重新 ensure。
#[tauri::command]
pub async fn ssh_server_restart(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshServerState, String> {
    server_status::ssh_server_restart(root_uri, app, manager).await
}

#[tauri::command]
pub async fn ssh_deferred_upgrade_impact(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<server_status::DeferredUpgrade, String> {
    let root = server_status::require_trusted_root(&manager, &root_uri)?;
    server::deferred_upgrade_impact(&manager, &root).await
}

/// 安装匹配客户端的服务，并等待常驻 daemon 的版本握手完成。
#[tauri::command]
pub async fn ssh_server_update(
    root_uri: String,
    confirmed_upgrade: Option<server_status::DeferredUpgrade>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshServerState, String> {
    if let Some(confirmed) = confirmed_upgrade {
        let root = server_status::require_trusted_root(&manager, &root_uri)?;
        confirmed.verify(&server::deferred_upgrade_impact(&manager, &root).await?)?;
    }
    server_status::ssh_server_update(root_uri, app, manager).await
}

/// 停掉某根的项目绑定与未共享的 serve，保留其他项目使用的用户级 daemon。
#[tauri::command]
pub async fn ssh_server_stop(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    server_status::ssh_server_stop(root_uri, app, manager).await
}

/// 读取远端日志：daemon 日志（`$HOME/.qingcode/server/run/server.log`）在前，
/// 项目 serve 日志（`<root>/.qingcode/server/serve.log`）在后，以分隔行拼接。
/// 两者都缺时返回说明文字，不报错。
#[tauri::command]
pub async fn ssh_server_logs(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<SshServerLogs, String> {
    server_status::ssh_server_logs(root_uri, manager).await
}

/// `ssh.server.autoDownload`：本地缺失 server 二进制时是否自动从 GitHub Release
/// 下载（sha256 校验）。默认开启；离线用户在设置里选择离线目录即可。
#[tauri::command]
pub fn ssh_set_server_auto_download(
    enabled: bool,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    manager
        .server_auto_download
        .store(enabled, std::sync::atomic::Ordering::SeqCst);
    // 与 offline_dir 一致：开关状态变化后让之前「本地缺二进制」的不可用槽
    // 重新尝试，用户重开开关即可立即重试下载，不必断开重连。
    manager.clear_unavailable_servers();
    Ok(())
}

/// `ssh.server.offlineDir`：手动指定本机离线代理目录。空字符串表示清除。
/// 目录本身或其中的 `servers` 子目录必须含有 `qingcode-server` 文件。
#[tauri::command]
pub fn ssh_set_server_offline_dir(
    dir: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        manager.set_server_offline_dir(None);
        manager.clear_unavailable_servers();
        return Ok(String::new());
    }
    if trimmed.len() > 1024 || trimmed.contains('\0') || trimmed.contains("ssh://") {
        return Err("离线目录必须是本机文件夹".to_string());
    }
    let resolved = server::resolve_offline_server_dir(Path::new(trimmed))?;
    let text = resolved.to_string_lossy().into_owned();
    manager.set_server_offline_dir(Some(resolved));
    manager.clear_unavailable_servers();
    Ok(text)
}

#[tauri::command]
pub async fn ssh_server_package_info(
    root_uri: String,
    dir: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<server::recovery::ServerPackageInfo, String> {
    server::recovery::package_info(&manager, &root_uri, dir.as_deref()).await
}

#[tauri::command]
pub async fn ssh_validate_server_offline_dir(dir: String) -> Result<String, String> {
    server::recovery::validate_directory(&dir).await
}

#[tauri::command]
pub async fn ssh_download_server_package(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<server::recovery::ServerPackageInfo, String> {
    server::recovery::download_package(&manager, &root_uri).await
}

#[tauri::command]
pub fn ssh_reset_server_failure(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    server::recovery::reset_failure(&manager, &root_uri)
}
