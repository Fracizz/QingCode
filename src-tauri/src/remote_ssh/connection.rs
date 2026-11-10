//! 连接与工作区生命周期命令：测试连接、打开/断开会话、目录浏览、
//! 工作区准备/激活/信任/状态与根目录登记。

use super::*;

#[tauri::command]
pub async fn ssh_set_workspace_trust(
    root_uri: String,
    trusted: bool,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    parse_remote_uri(&root_uri)?;
    if !trusted {
        manager.set_root_trust(&root_uri, false)?;
        if let Ok(root) = manager.registered_root(&root_uri) {
            if let Some(id) = remote_uri_connection_id(&root.uri) {
                manager.stop_watch_supervisor(&server::server_slot_key(id, &root.canonical_path));
            }
        }
        // 安全闸优先：撤销信任在任何连接状态下都必须生效，远端清理只尽力而为。
        manager.kill_persistent_terminals_for_root(&root_uri).await;
        if let Ok(root) = manager.registered_root(&root_uri) {
            kill_detached_terminals_best_effort(&app, &manager, &root).await;
        }
    }
    manager.set_root_trust(&root_uri, trusted)?;
    // 连接建立后才补信任的根不会经历 ssh_connect 的拉起路径：这里补一条
    // watch 监督任务（连接仍在、开关开启且没有存活任务时），否则远端变更
    // 事件永远缺位。已有健康任务时不重启，避免白白断开一条 watch 连接。
    if trusted {
        if let Ok(root) = manager.registered_root(&root_uri) {
            if let Ok(parsed) = parse_remote_uri(&root.uri) {
                if root.trusted
                    && !manager.root_is_passive(&root.uri)
                    && manager.server_mode(&parsed.connection_id)
                    && manager.connection_is_open(&parsed.connection_id)
                {
                    let key = server::server_slot_key(&parsed.connection_id, &root.canonical_path);
                    if !manager.has_watch_supervisor(&key) {
                        let handle = server::spawn_server_watch_supervisor(
                            app,
                            parsed.connection_id.clone(),
                            normalize_remote_uri(&root.uri),
                            root.canonical_path.clone(),
                        );
                        manager.replace_watch_supervisor(&key, handle);
                    }
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_test_connection(
    config: SshConnectionConfig,
) -> Result<SshSessionOpenResult, String> {
    if config
        .host_key_fingerprint
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err("连接前必须确认 SSH 主机指纹".into());
    }
    // Deliberately has no SshManager: testing never registers or changes an
    // application's live session, root, credentials, or shared daemon cache.
    let username = config.username.clone();
    let (connected, fingerprint) = authenticate_session(config, ConnectionPurpose::Main).await?;
    let connected = Arc::new(connected);
    let result = async {
        let sftp = open_sftp_session(&connected)
            .await
            .map_err(|error| error.message)?;
        Ok(SshSessionOpenResult {
            fingerprint,
            home_path: resolve_remote_home(&sftp, &username).await,
        })
    }
    .await;
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        connected
            .handle
            .disconnect(Disconnect::ByApplication, "connection test complete", "en"),
    )
    .await;
    result
}

#[tauri::command]
pub async fn ssh_open_session(
    config: SshConnectionConfig,
    manager: State<'_, SshManager>,
) -> Result<SshSessionOpenResult, String> {
    if let Some(direct) = manager.direct_config(&config.id) {
        direct::test(&direct).await?;
        let info = direct::workspace_request(&direct, &serde_json::json!({"op":"info"})).await?;
        manager
            .direct_active
            .write()
            .map_err(|_| "Server 状态不可用")?
            .insert(config.id.clone());
        return Ok(SshSessionOpenResult {
            fingerprint: config
                .host_key_fingerprint
                .unwrap_or(direct.certificate_fingerprint),
            home_path: info["homePath"].as_str().ok_or("Server 家目录无效")?.into(),
        });
    }
    let expected = config
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "连接前必须确认 SSH 主机指纹".to_string())?;
    let fingerprint = if existing_session(&manager, &config.id).is_some() {
        // 模式只由 ssh_connect 定下：测试连接或浏览目录不能改动在用会话的模式。
        manager.remember_config(
            &config.id,
            SshConnectionConfig {
                mode: None,
                ..config.clone()
            },
        )?;
        expected
    } else {
        let (_connected, fingerprint) =
            store_authenticated_session(&manager, config.clone()).await?;
        fingerprint
    };
    let sftp = manager.open_sftp(&config.id).await?;
    Ok(SshSessionOpenResult {
        fingerprint,
        home_path: resolve_remote_home(&sftp, &config.username).await,
    })
}

#[tauri::command]
pub async fn ssh_browse_directory(
    connection_id: String,
    path: String,
    manager: State<'_, SshManager>,
) -> Result<SshBrowseResult, String> {
    validate_remote_path(&path)?;
    let normalized = normalize_remote_path(&path);
    let sftp = manager.open_sftp(&connection_id).await?;
    let canonical = sftp
        .canonicalize(normalized)
        .await
        .map_err(|error| format!("远程目录不可用：{error}"))?;
    let metadata = sftp
        .metadata(canonical.clone())
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    if !metadata.is_dir() {
        return Err("远程路径不是目录".to_string());
    }
    let mut dirs = Vec::new();
    let entries = sftp
        .read_dir(canonical.clone())
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." || !entry.metadata().is_dir() {
            continue;
        }
        dirs.push(RemoteFileNode {
            path: join_remote_path(&canonical, &name),
            name,
            is_dir: true,
        });
    }
    dirs.sort_by_key(|node| node.name.to_lowercase());
    Ok(SshBrowseResult {
        path: normalize_remote_path(&canonical),
        entries: dirs,
    })
}

#[tauri::command]
pub async fn ssh_connect(
    config: SshConnectionConfig,
    root_uri: String,
    trusted: bool,
    defer_service: Option<bool>,
    app: tauri::AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshConnectResult, String> {
    if manager.direct_config(&config.id).is_some() {
        return direct_settings::connect_root(
            &manager,
            &app,
            &config,
            &root_uri,
            trusted,
            defer_service.unwrap_or(false),
        )
        .await;
    }
    let expected = config
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "连接前必须确认 SSH 主机指纹".to_string())?;
    let parsed_root = parse_remote_uri(&root_uri)?;
    if parsed_root.connection_id != config.id {
        return Err("SSH 项目与连接配置不匹配".to_string());
    }
    let mode = config
        .mode
        .ok_or_else(|| "SSH 连接缺少模式（Server / SSH）".to_string())?;
    // Frontends have per-window queues; serialize initial authentication across
    // windows too, and coordinate with explicit native disconnect/reconnect.
    let auth_gate = manager.reconnect_gate(&config.id)?;
    let mut auth_guard = auth_gate.lock().await;
    // 只有这次新建会话才发 authenticating；已有会话时第一眼就是 probing / readyDirect。
    let fresh_auth = existing_session(&manager, &config.id).is_none();
    let fingerprint = if !fresh_auth {
        ensure_mode_unchanged(&manager, &config.id, mode)?;
        manager.remember_config(&config.id, config.clone())?;
        expected
    } else {
        // 会话还不存在，接下来才做握手认证。成功后会被 probing / readyDirect 盖掉。
        server_status::publish_authenticating(&app, &manager, &config.id, &root_uri);
        match store_authenticated_session(&manager, config.clone()).await {
            Ok((_connected, fingerprint)) => fingerprint,
            Err(error) => {
                server_status::publish_disconnected(&app, &manager, &config.id, &root_uri);
                return Err(error);
            }
        }
    };
    *auth_guard = None;
    drop(auth_guard);
    let abandon_fresh_auth = |error: String| {
        if fresh_auth {
            server_status::publish_disconnected(&app, &manager, &config.id, &root_uri);
        }
        error
    };
    let sftp = manager
        .open_sftp(&config.id)
        .await
        .map_err(abandon_fresh_auth)?;
    let canonical_root = sftp
        .canonicalize(parsed_root.path)
        .await
        .map_err(|error| abandon_fresh_auth(format!("远程项目目录不可用：{error}")))?;
    reject_windows_sftp_links(&sftp, &canonical_root)
        .await
        .map_err(abandon_fresh_auth)?;
    let metadata = sftp
        .metadata(canonical_root.clone())
        .await
        .map_err(|error| abandon_fresh_auth(format!("读取远程项目目录失败：{error}")))?;
    if !metadata.is_dir() {
        return Err(abandon_fresh_auth("远程项目路径不是目录".to_string()));
    }
    // 并发的另一次 ssh_connect 可能在上面的 await 期间把会话改成了别的模式；
    // 登记根之前再确认一次，保证同一会话下所有根的模式一致。
    if manager.connection_mode(&config.id) != Some(mode) {
        return Err(abandon_fresh_auth(mode_changed_error(
            manager.connection_mode(&config.id),
            mode,
        )));
    }
    if defer_service.unwrap_or(false) && !manager.root_is_registered(&root_uri)? {
        manager
            .passive_roots
            .write()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?
            .insert(normalize_remote_uri(&root_uri));
    }
    manager
        .roots
        .write()
        .map_err(|_| abandon_fresh_auth("SSH 工作区状态不可用".to_string()))?
        .insert(
            root_uri.clone(),
            RegisteredRoot {
                uri: normalize_remote_uri(&root_uri),
                canonical_path: canonical_root.clone(),
                trusted,
            },
        );
    // 先公布稳态，再拉起监督任务，避免监督任务先发出 installing 后被 probing 盖掉。
    if let Ok(root) = manager.registered_root(&root_uri) {
        server_status::publish_root_state(&app, &manager, &root);
    }
    // 已信任的远端：启动 watch 监督任务（server 提供远端事件源）。
    // Windows 与 Linux 都优先 daemon（Windows 走命名管道），失败再回退 serve。
    // 重复连接同一根时先终止旧任务，避免出现两条并发的 watch 连接。
    if trusted && mode == RemoteMode::Server && !defer_service.unwrap_or(false) {
        let key = server::server_slot_key(&config.id, &canonical_root);
        let handle = server::spawn_server_watch_supervisor(
            app.clone(),
            config.id.clone(),
            normalize_remote_uri(&root_uri),
            canonical_root.clone(),
        );
        manager.replace_watch_supervisor(&key, handle);
    }
    Ok(SshConnectResult {
        fingerprint,
        canonical_root,
    })
}

#[tauri::command]
pub async fn ssh_disconnect(
    connection_id: String,
    app: tauri::AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let tunneled = manager
        .direct_config(&connection_id)
        .is_some_and(|config| config.tunnel.is_some());
    if let Some(roots) = manager.detach_direct_connection(&connection_id)? {
        if tunneled {
            tunnel::disconnect(&manager, &connection_id).await?;
        }
        for root in roots {
            server_status::publish_disconnected(&app, &manager, &connection_id, &root.uri);
        }
        return Ok(());
    }
    if let Err(error) = server::kill_detached_terminals(&connection_id, &app, &manager, None).await
    {
        eprintln!("[WARN] 断开连接时清理远端终端失败（{connection_id}）：{error}");
    }
    manager
        .kill_persistent_terminals_for_connection(&connection_id)
        .await;
    for root in manager.roots_for_connection(&connection_id) {
        server_status::publish_disconnected(&app, &manager, &connection_id, &root.uri);
    }
    // 等进行中的重连结束再移除，否则重连完成后会把连接重新插回表里。
    let gate = manager.reconnect_gate(&connection_id)?;
    let mut last_failure = gate.lock().await;
    *last_failure = None;
    let session = manager
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .remove(&connection_id);
    manager
        .roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .retain(|_, root| remote_uri_connection_id(&root.uri) != Some(connection_id.as_str()));
    // 取消该连接的所有 watch 代次，让读循环有机会发 EOF/CLOSE 后正常收尾。
    let prefix = format!("{connection_id}|");
    let stale = manager
        .watch_cancellations
        .lock()
        .map(|cancellations| {
            cancellations
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for key in stale {
        manager.stop_watch_supervisor(&key);
    }
    // server 的端口 / token 跟着远端进程走，重连后必须重新发现，缓存一律丢弃。
    manager.purge_server_state(&connection_id);
    if let Ok(mut policies) = manager.workspace_server_settings.write() {
        policies.retain(|uri, _| remote_uri_connection_id(uri) != Some(connection_id.as_str()));
    }
    if let Ok(mut passive) = manager.passive_roots.write() {
        passive.retain(|uri| remote_uri_connection_id(uri) != Some(connection_id.as_str()));
    }
    // 终端各用独立连接，主连接断开不会带走它们，需要逐个断开。
    let terminal_transports = manager
        .terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .values()
        .filter(|terminal| terminal.connection_id == connection_id)
        .map(|terminal| Arc::clone(&terminal.transport))
        .collect::<Vec<_>>();
    for transport in terminal_transports {
        close_terminal_transport(&transport).await;
    }
    if let Some(session) = session {
        session
            .handle
            .disconnect(Disconnect::ByApplication, "QingCode disconnect", "en")
            .await
            .map_err(|error| format!("断开 SSH 连接失败：{error}"))?;
    }
    if let Some(config) = manager.direct_config(&connection_id) {
        manager
            .direct_active
            .write()
            .map_err(|_| "Server 状态不可用")?
            .remove(&connection_id);
        direct::close_connection(&config.endpoint, &connection_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_connection_status(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<bool, String> {
    if manager.direct_config(&connection_id).is_some() {
        manager.refresh_direct_status(&connection_id).await?;
        return Ok(manager.connection_is_open(&connection_id));
    }
    Ok(manager
        .sessions
        .read()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .get(&connection_id)
        .is_some_and(|session| !session.handle.is_closed()))
}

#[tauri::command]
pub fn ssh_shared_server_ready(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<bool, String> {
    let parsed = parse_remote_uri(&root_uri)?;
    Ok(server::shared_server_known(&manager, &parsed.connection_id))
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceServerSettings {
    pub(super) auto_download: bool,
    pub(super) offline_dir: Option<PathBuf>,
}

impl WorkspaceServerSettings {
    pub(super) fn validated(mut self) -> Result<Self, String> {
        self.offline_dir = match self.offline_dir.filter(|dir| !dir.as_os_str().is_empty()) {
            Some(dir) => {
                let text = dir.to_string_lossy();
                if text.contains("://") || text.contains('\0') {
                    return Err("离线服务目录必须是本地目录".into());
                }
                Some(server::resolve_offline_server_dir(&dir)?)
            }
            None => None,
        };
        Ok(self)
    }
}

#[tauri::command]
pub async fn ssh_prepare_workspace(
    root_uri: String,
    settings: Option<WorkspaceServerSettings>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let parsed = parse_remote_uri(&root_uri)?;
    if !manager.connection_is_open(&parsed.connection_id) {
        return Err("SSH 连接未建立".to_string());
    }
    let root = manager.registered_root(&root_uri)?;
    if manager.direct_config(&parsed.connection_id).is_some() {
        direct_settings::prepare_root(&manager, &root, Some(&app)).await?;
        if !manager.root_is_passive(&root_uri) {
            manager.start_workspace_watch(app, &root);
        }
        return Ok(());
    }
    let session = manager.session(&parsed.connection_id)?;
    // A registered root is not a usable Server workspace yet. Files need the
    // service and terminals need its daemon; reuse their bounded preparation.
    // Restricted workspaces and explicit SSH mode retain their SFTP-only path.
    if root.trusted && manager.root_server_mode(&root) {
        if let Some(settings) = settings {
            let settings = settings.validated()?;
            let previous = manager
                .workspace_server_settings
                .write()
                .map_err(|_| "SSH 项目设置不可用".to_string())?
                .insert(normalize_remote_uri(&root_uri), settings.clone());
            if previous.as_ref() != Some(&settings) {
                let key = server::server_slot_key(&parsed.connection_id, &root.canonical_path);
                let mut slot = manager.server_slot(&key).unwrap_or_default();
                if slot.endpoint.is_none() {
                    slot.unavailable_reason = None;
                    slot.deploy_failures = 0;
                    slot.last_failure = None;
                    manager.set_server_slot(&key, slot);
                }
            }
        }
        server::require_server_endpoint(&app, &manager, &root, true).await?;
    }
    // Never report late success after disconnect, root removal or trust revocation.
    let current = manager.registered_root(&root_uri)?;
    let current_session = manager.session(&parsed.connection_id)?;
    if current.trusted != root.trusted
        || current_session.handle.is_closed()
        || !Arc::ptr_eq(
            &current_session.server_incarnation,
            &session.server_incarnation,
        )
    {
        return Err("SSH 项目状态已变化，请重新打开".into());
    }
    Ok(())
}

/// Called only after foreground preparation and directory reading complete.
/// Separating this from the long deployment prevents a cancelled open from
/// installing a watch subscription when its native deployment finishes late.
#[tauri::command]
pub fn ssh_activate_workspace(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let parsed = parse_remote_uri(&root_uri)?;
    if !manager.connection_is_open(&parsed.connection_id) {
        return Err("SSH 连接未建立".into());
    }
    let root = manager.registered_root(&root_uri)?;
    manager
        .passive_roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .remove(&normalize_remote_uri(&root_uri));
    manager.start_workspace_watch(app, &root);
    Ok(())
}

#[tauri::command]
pub fn ssh_workspace_status(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<bool, String> {
    let parsed = parse_remote_uri(&root_uri)?;
    if manager.direct_config(&parsed.connection_id).is_some() {
        return Ok(manager.connection_is_open(&parsed.connection_id)
            && manager.root_is_registered(&root_uri)?);
    }
    let connection_alive = manager
        .sessions
        .read()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .get(&parsed.connection_id)
        .is_some_and(|session| !session.handle.is_closed());
    Ok(connection_alive && manager.root_is_registered(&root_uri)?)
}

/// 连接管理页用：某连接下全部已注册项目根及其信任状态。
/// 根注册在内存里，连接断开即清空，重连后由 ssh_connect 重新登记。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshWorkspaceRoot {
    pub root_uri: String,
    pub trusted: bool,
}

#[tauri::command]
pub fn ssh_workspace_roots(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<SshWorkspaceRoot>, String> {
    Ok(manager
        .roots_for_connection(&connection_id)
        .into_iter()
        .map(|root| SshWorkspaceRoot {
            root_uri: root.uri,
            trusted: root.trusted,
        })
        .collect())
}

/// 连接管理页用：某连接下全部已注册根的代理状态聚合。
/// 单个根解析失败只跳过该根，不拖垮整个列表。
#[tauri::command]
pub fn ssh_server_states(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<server_status::SshServerState>, String> {
    Ok(manager
        .roots_for_connection(&connection_id)
        .iter()
        .filter_map(|root| server_status::state_for_root(&manager, root).ok())
        .collect())
}

#[tauri::command]
pub async fn ssh_validate_directory(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("远程目录不可用：{error}"))?;
    if !metadata.is_dir() {
        return Err(format!("远程路径不是目录：{}", parsed.path));
    }
    Ok(())
}

/// 项目从 QingCode 移除后注销对应根，并尽力结束其中仍由 daemon 托管的终端。
#[tauri::command]
pub async fn ssh_forget_workspace_root(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let normalized = normalize_remote_uri(&root_uri);
    if let Ok(mut policies) = manager.workspace_server_settings.write() {
        policies.remove(&normalized);
    }
    if let Ok(mut passive) = manager.passive_roots.write() {
        passive.remove(&normalized);
    }
    // 本次会话未注册（重启后未连接就移除）时没有可清理的连接状态，直接放行。
    if let Ok(root) = manager.registered_root(&root_uri) {
        if let Some(id) = remote_uri_connection_id(&root.uri) {
            manager.stop_watch_supervisor(&server::server_slot_key(id, &root.canonical_path));
        }
        manager.kill_persistent_terminals_for_root(&root.uri).await;
        kill_detached_terminals_best_effort(&app, &manager, &root).await;
    }
    manager
        .roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .remove(&normalized);
    Ok(())
}
