//! 远端目录扫描与预热：直连 / server / SFTP 三种来源的文件树构建。

use super::*;

/// 把一组 (名称, 是否目录) 条目转成目录树节点：应用排除规则、按名称排序、目录优先。
/// SFTP 与 server 两条扫描路径共用，保证行为一致。
pub(super) fn collect_scan_nodes(
    uri: &str,
    path: &str,
    root_posix: &str,
    entries: impl IntoIterator<Item = (String, bool)>,
    exclude_patterns: Option<&[String]>,
) -> Vec<RemoteFileNode> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for (name, is_dir) in entries {
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let full_posix = if path.ends_with('/') {
            format!("{path}{name}")
        } else {
            format!("{path}/{name}")
        };
        let rel = match full_posix.strip_prefix(root_posix) {
            Some(rest) => rest.trim_start_matches('/'),
            None => &name,
        };

        let should_skip = match exclude_patterns {
            Some(patterns) => {
                if rel.is_empty() {
                    false
                } else {
                    crate::exclude::is_path_excluded(rel, patterns)
                }
            }
            None => crate::exclude::default_hard_ignore_name(&name),
        };
        if should_skip {
            continue;
        }

        let node = RemoteFileNode {
            path: join_remote_uri(uri, &name),
            name,
            is_dir,
        };
        if node.is_dir {
            dirs.push(node);
        } else {
            files.push(node);
        }
    }
    dirs.sort_by_key(|node| node.name.to_lowercase());
    files.sort_by_key(|node| node.name.to_lowercase());
    dirs.extend(files);
    dirs
}

/// 计算绝对路径相对项目根的 POSIX 相对路径（server scan/watch 参数约定，根为 ""）。
pub(super) fn remote_relative_to_root(canonical: &str, canonical_root: &str) -> String {
    let root = canonical_root.trim_end_matches('/');
    if root.is_empty() {
        return canonical.trim_matches('/').to_string();
    }
    canonical
        .strip_prefix(root)
        .unwrap_or(canonical)
        .trim_start_matches('/')
        .to_string()
}

pub(super) fn scan_root_path(workspace_root: Option<&str>, root: &RegisteredRoot) -> String {
    workspace_root
        .and_then(|uri| parse_remote_uri(uri).ok())
        .map(|parsed| parsed.path)
        .unwrap_or_else(|| root.canonical_path.clone())
        .trim_end_matches('/')
        .to_string()
}

/// Agent file browsing uses the authenticated HTTPS workspace API, independently
/// of the WSS daemon used for terminals/watch. Never enter SSH serve discovery.
pub(super) async fn direct_scan_directory(
    manager: &SshManager,
    path: &str,
    workspace_root: Option<&str>,
    exclude_patterns: Option<&[String]>,
) -> Result<Option<Vec<RemoteFileNode>>, String> {
    let parsed = parse_remote_uri(path)?;
    if manager.direct_config(&parsed.connection_id).is_none() {
        return Ok(None);
    }
    let (sftp, parsed, root) = manager.sftp_for_uri(path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let entries = sftp
        .read_dir(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    Ok(Some(collect_scan_nodes(
        path,
        &parsed.path,
        &scan_root_path(workspace_root, &root),
        entries.map(|entry| (entry.file_name(), entry.metadata().is_dir())),
        exclude_patterns,
    )))
}

/// Server 模式下经远端 server 列出目录的直接子项，不回退 SFTP；失败时清空端点
/// 缓存、后台重新发现，并返回带模式前缀的错误。返回 (名称, 是否目录) 交给
/// `collect_scan_nodes` 统一组装。
pub(super) async fn server_scan_entries(
    app: &AppHandle,
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    canonical: &str,
) -> Result<Vec<(String, bool)>, String> {
    let key = server::server_slot_key(connection_id, &root.canonical_path);
    let mut endpoint = server::require_server_endpoint(app, manager, root, false).await?;
    let relative = remote_relative_to_root(canonical, &root.canonical_path);
    // daemon 传输优先：一次 RPC 往返，目录树刷新与 watch 事件同源。传输失败
    // 只降级 daemon 标记（保留 serve 端点），继续走 serve 请求；daemon 应答的
    // 业务错误（目录已删除、无权限）直接返回，daemon 与 serve 端点都不受牵连。
    if let Some(daemon) = endpoint.daemon.as_ref() {
        match server::daemon_scan_entries(
            manager,
            connection_id,
            daemon,
            &root.canonical_path,
            &relative,
        )
        .await
        {
            Ok(entries) => return Ok(entries),
            Err(error) if !error.is_transport() => {
                return Err(format!("读取远程目录失败：{error}"));
            }
            Err(error) => {
                let fallback = server::handle_daemon_transport_error(manager, &key, daemon, &error);
                // 传输从 daemon 降到 serve，状态芯片要跟着变。
                server_status::publish_root_state(app, manager, root);
                fallback?;
            }
        }
    }
    if endpoint.serve.is_none() {
        endpoint = server::require_serve_endpoint(app, manager, root).await?;
    }
    let request = qingcode_server::ServerRequest {
        token: endpoint
            .serve
            .as_ref()
            .ok_or("项目 serve 尚未启动")?
            .token
            .clone(),
        op: qingcode_server::ServerOp::Scan { path: relative },
    };
    let mut entries = Vec::new();
    let outcome = server::server_stream_call(
        manager,
        connection_id,
        &endpoint,
        request,
        Instant::now() + Duration::from_secs(15),
        || false,
        |record| {
            let Some(name) = record.get("name").and_then(|value| value.as_str()) else {
                return true;
            };
            let is_dir = record
                .get("isDir")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            entries.push((name.to_string(), is_dir));
            true
        },
    )
    .await;
    match outcome {
        Ok(server::ServerStreamOutcome::Done { .. }) => Ok(entries),
        other => {
            // 扫描失败说明 server 可能已失联；清掉端点并在后台重新发现/部署。
            server::note_server_endpoint_lost(app, manager, root, &key);
            let detail = match other {
                Err(error) => error,
                Ok(_) => "server 未完成扫描".to_string(),
            };
            Err(server::server_mode_error(format!(
                "读取远程目录失败：{detail}"
            )))
        }
    }
}

#[tauri::command]
pub async fn ssh_warmup_directory(
    root_uri: String,
    exclude_patterns: Option<Vec<String>>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<Option<Vec<RemoteFileNode>>, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&root_uri, true).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    if !manager.server_mode(&parsed.connection_id) {
        return Ok(None);
    }
    let endpoint = server::require_server_endpoint(&app, &manager, &root, true).await?;
    let daemon = endpoint.daemon.ok_or("远端服务尚未就绪")?;
    let entries = server::daemon_warmup_entries(
        &manager,
        &parsed.connection_id,
        &daemon,
        &root.canonical_path,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(entries.map(|entries| {
        collect_scan_nodes(
            &root_uri,
            &parsed.path,
            &parsed.path,
            entries,
            exclude_patterns.as_deref(),
        )
    }))
}

#[tauri::command]
pub async fn ssh_scan_directory(
    path: String,
    workspace_root: Option<String>,
    exclude_patterns: Option<Vec<String>>,
    _exclude_git_ignore: Option<bool>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteFileNode>, String> {
    if let Some(nodes) = direct_scan_directory(
        &manager,
        &path,
        workspace_root.as_deref(),
        exclude_patterns.as_deref(),
    )
    .await?
    {
        return Ok(nodes);
    }
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    let canonical = ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let root_posix = scan_root_path(workspace_root.as_deref(), &root);

    // Server 模式只经 server 扫描，与 watch 事件同源，失败直接报错；SSH 模式与
    // 未受信任项目（不部署 server）走 SFTP。
    if root.trusted && manager.server_mode(&parsed.connection_id) {
        let entries =
            server_scan_entries(&app, &manager, &parsed.connection_id, &root, &canonical).await?;
        return Ok(collect_scan_nodes(
            &path,
            &parsed.path,
            &root_posix,
            entries,
            exclude_patterns.as_deref(),
        ));
    }

    let entries = sftp
        .read_dir(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    Ok(collect_scan_nodes(
        &path,
        &parsed.path,
        &root_posix,
        entries
            .into_iter()
            .map(|entry| (entry.file_name(), entry.metadata().is_dir())),
        exclude_patterns.as_deref(),
    ))
}
