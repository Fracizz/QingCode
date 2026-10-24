//! 部署编排：发现存活 server / 上传-校验-启动 / 等就绪，以及
//! (连接, 根) 粒度的 slot 缓存、幂等跳过与部署退避。

use super::daemon::{daemon_downgrade_retry_ready, ensure_remote_daemon};
use super::download::locate_local_server_binary;
use super::paths::{
    legacy_agent_state_path, parse_server_state, server_binary_remote_path, server_dir_path,
    server_serve_log_path, server_state_path,
};
use super::scripts::{
    deploy_server_command, kill_server_command, legacy_agent_cleanup_command,
    remote_sha256_command, remote_sha256_matches, self_check_command, sha256_of_file,
    windows_deploy_for, windows_kill_for, windows_legacy_agent_cleanup_script,
    windows_remote_sha256_script, windows_remove_for, windows_self_check_script,
};
use super::serve::ping_server;
use super::*;
use qingcode_server::SERVER_VERSION;

/// 等待 server 启动就绪（状态文件出现且 ping 通过）的总时限。
const AGENT_READY_TIMEOUT: Duration = Duration::from_secs(15);
/// server 启动就绪轮询间隔。
const AGENT_READY_POLL: Duration = Duration::from_millis(300);
/// 部署退避阈值：同一 (连接, 根) 连续这么多次完整部署都等不到就绪，
/// 说明不是瞬时抖动（典型如 sshd 禁了 TCP 转发），缓存成不可用等人介入。
pub(crate) const SERVER_DEPLOY_BACKOFF_THRESHOLD: u32 = 2;

async fn exec_on_root(
    manager: &SshManager,
    root: &RegisteredRoot,
    unix_command: &str,
    windows_script: &str,
) -> Result<RemoteExecResult, String> {
    manager
        .exec_remote_shell(
            &root.uri,
            unix_command,
            windows_script,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
}

/// 在已有状态文件中发现存活 server：版本一致且 ping 通过才算可用。
/// 版本不一致时尽力 kill 旧进程（错误忽略），随后走部署流程。
async fn try_discover_server(
    manager: &SshManager,
    connection_id: &str,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
) -> Option<ServerEndpoint> {
    let state_path = server_state_path(&root.canonical_path);
    let metadata = sftp.metadata(state_path.clone()).await.ok()?;
    if metadata.is_dir() {
        return None;
    }
    let bytes = sftp.read(state_path.clone()).await.ok()?;
    let state = parse_server_state(&bytes).ok()?;
    if state.version != SERVER_VERSION {
        // 版本过期的 server 不再复用；旧进程可能还占着端口，按身份校验后尽力清掉。
        let _ = exec_on_root(
            manager,
            root,
            &kill_server_command(state.pid, &state_path),
            &windows_kill_for(&state_path, state.pid),
        )
        .await;
        return None;
    }
    let endpoint = ServerEndpoint {
        port: state.port,
        token: state.token,
        daemon: None,
    };
    // ping 之前进入握手；失败则调用方继续安装。
    server_status::note_server_activity(
        manager,
        app,
        root,
        connection_id,
        server_status::ServerPhase::Handshaking,
    );
    ping_server(manager, connection_id, &endpoint).await.ok()?;
    Some(endpoint)
}

/// 在 server 部署目录写一个忽略自身的 `.gitignore`：状态文件含连接 token，
/// 二进制也不该进用户仓库。已存在时按独占创建失败处理，不影响部署。
async fn write_server_gitignore(sftp: &SftpSession, dir: &str) -> Result<(), String> {
    let mut file = sftp
        .open_with_flags(format!("{dir}/.gitignore"), remote_write_flags(true))
        .await
        .map_err(|error| format!("创建 server .gitignore 失败：{error}"))?;
    file.write_all(b"*\n")
        .await
        .map_err(|error| format!("写入 server .gitignore 失败：{error}"))?;
    file.shutdown()
        .await
        .map_err(|error| format!("完成 server .gitignore 写入失败：{error}"))
}

/// 上传 server 二进制：逐级建目录，临时文件 + rename 原子落位。
///
/// 幂等优化：上传前先在远端算已存在二进制的 sha256，与本地一致就跳过上传。
/// 之前每次部署失败重试都是全量 SFTP 上传（ping 打不通时变成热循环：上传
/// 几十 MB → 新 serve 因旧实例 rc=3 退出 → 15s 轮询超时 → 再来一遍）。
/// sha256 逐字节一致则版本必然一致（版本升级 = 二进制变化 = sha 变化），
/// 不会出现旧注释担心的「复用出旧版本 serve」；远端算不出摘要或对不上
/// 时照常走全量上传，安全回退。返回 true 表示实际上传，false 表示跳过。
async fn upload_server_binary(
    manager: &SshManager,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    local: &Path,
    remote_bin: &str,
    local_sha256: &str,
) -> Result<bool, String> {
    if remote_binary_sha_matches(manager, root, remote_bin, local_sha256).await {
        return Ok(false);
    }
    let dir = server_dir_path(&root.canonical_path);
    let parent = format!("{}/.qingcode", root.canonical_path.trim_end_matches('/'));
    // 逐级建目录：SFTP 的 mkdir 不递归，父目录缺失时子目录必然失败。已存在则忽略错误。
    let _ = sftp.create_dir(parent).await;
    let _ = sftp.create_dir(dir.clone()).await;

    // 上传前先确认目录仍在项目根内（防止 root 被符号链接重定向）。
    let resolved_dir = sftp
        .canonicalize(dir.clone())
        .await
        .map_err(|error| format!("server 部署目录不可用：{error}"))?;
    if !remote_path_is_within(&resolved_dir, &root.canonical_path) {
        return Err("server 部署目录跳出了项目根".to_string());
    }

    // 状态文件含 token、二进制不该进用户仓库：目录内放一个忽略自身的 .gitignore。
    let _ = write_server_gitignore(sftp, &resolved_dir).await;

    let bytes =
        std::fs::read(local).map_err(|error| format!("读取本地 server 二进制失败：{error}"))?;
    // SFTP v3 的 rename 不覆盖已存在目标，先写临时文件再原子替换。
    let temp = format!(
        "{}/qingcode-server.tmp-{}",
        dir,
        uuid::Uuid::new_v4().simple()
    );
    let write_result: Result<(), String> = async {
        let mut file = sftp
            .open_with_flags(temp.clone(), remote_write_flags(true))
            .await
            .map_err(|error| format!("创建远端临时文件失败：{error}"))?;
        for chunk in bytes.chunks(64 * 1024) {
            file.write_all(chunk)
                .await
                .map_err(|error| format!("上传 server 二进制失败：{error}"))?;
        }
        file.shutdown()
            .await
            .map_err(|error| format!("完成 server 上传失败：{error}"))?;
        Ok(())
    }
    .await;
    if let Err(error) = write_result {
        let _ = tokio::time::timeout(Duration::from_secs(2), sftp.remove_file(temp)).await;
        return Err(error);
    }
    let renamed = tokio::time::timeout(
        Duration::from_secs(15),
        sftp.rename(temp.clone(), remote_bin.to_string()),
    )
    .await
    .map_err(|_| "server 二进制提交超时".to_string())?;
    if renamed.is_err() {
        // 目标已存在（SFTP v3 rename 拒绝覆盖）：清掉旧文件后再 rename 一次。
        let _ = exec_on_root(
            manager,
            root,
            &format!("rm -f -- {}", shell_quote(remote_bin)),
            &windows_remove_for(remote_bin),
        )
        .await;
        sftp.rename(temp.clone(), remote_bin.to_string())
            .await
            .map_err(|error| format!("提交 server 二进制失败：{error}"))?;
    }
    Ok(true)
}

/// 远端已部署二进制与本地摘要是否一致。任何一步失败（工具缺失、输出异常）
/// 都按「不一致」处理，调用方回退全量上传。
async fn remote_binary_sha_matches(
    manager: &SshManager,
    root: &RegisteredRoot,
    remote_bin: &str,
    local_sha256: &str,
) -> bool {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let windows_script = if windows {
        windows_host_path(remote_bin)
            .as_deref()
            .map(windows_remote_sha256_script)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let Ok(result) = exec_on_root(
        manager,
        root,
        &remote_sha256_command(remote_bin),
        &windows_script,
    )
    .await
    else {
        return false;
    };
    remote_sha256_matches(&result.stdout, local_sha256)
}

/// 远端 exec `self-check --expect-sha256`：校验落盘二进制与本地逐字节一致，
/// 同时探测部署目录是否 noexec（exec 失败会以非零码暴露）。失败按 permanent
/// 处理——传输损坏 / 磁盘坏 / noexec 不会因重试自愈，缓存成不可用等人工介入。
async fn verify_remote_binary(
    manager: &SshManager,
    root: &RegisteredRoot,
    remote_bin: &str,
    local_sha256: &str,
) -> Result<(), ServerDeployError> {
    // unix 上 exec 前补可执行位：跳过上传的旧文件可能权限被改动过。
    if windows_native_path(&root.canonical_path).is_none() {
        let _ = manager
            .exec_command(
                &root.uri,
                &format!("chmod 755 -- {}", shell_quote(remote_bin)),
                None,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await;
    }
    let windows_script = windows_host_path(remote_bin)
        .map(|path| windows_self_check_script(&path, local_sha256))
        .unwrap_or_default();
    let result = manager
        .exec_remote_shell(
            &root.uri,
            &self_check_command(remote_bin, local_sha256),
            &windows_script,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
        .map_err(|error| {
            ServerDeployError::permanent(format!("远端 server 自检执行失败：{error}"))
        })?;
    if result.exit_code != 0 {
        let detail = result.stderr.trim();
        let detail = if detail.is_empty() {
            format!("退出码 {}", result.exit_code)
        } else {
            detail.to_string()
        };
        return Err(ServerDeployError::permanent(format!(
            "远端 server 自检失败（{detail}）：二进制可能损坏或部署目录禁止执行（noexec），请检查远端磁盘后重试"
        )));
    }
    Ok(())
}

/// 清理改名前的旧版遗留：`.qingcode/agent/agent.json` 还在时，按其中的 pid
/// 尽力杀掉旧 serve 并删除该状态文件（不删整个旧目录）。任何失败都不影响
/// 本次部署——旧进程最多多占一个端口，不值得为它中断升级。
async fn cleanup_legacy_agent_state(
    manager: &SshManager,
    root: &RegisteredRoot,
    sftp: &SftpSession,
) {
    let legacy_state = legacy_agent_state_path(&root.canonical_path);
    let Ok(bytes) = sftp.read(legacy_state.clone()).await else {
        return;
    };
    let Ok(state) = parse_server_state(&bytes) else {
        return;
    };
    let windows_script = windows_host_path(&legacy_state)
        .map(|path| windows_legacy_agent_cleanup_script(state.pid, &path))
        .unwrap_or_default();
    let _ = exec_on_root(
        manager,
        root,
        &legacy_agent_cleanup_command(state.pid, &legacy_state),
        &windows_script,
    )
    .await;
}

/// 等待 server 启动就绪：状态文件出现、可解析且 ping 通过。
async fn wait_server_ready(
    manager: &SshManager,
    connection_id: &str,
    sftp: &SftpSession,
    root: &RegisteredRoot,
) -> Option<ServerEndpoint> {
    let state_path = server_state_path(&root.canonical_path);
    let deadline = Instant::now() + AGENT_READY_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(AGENT_READY_POLL).await;
        if let Ok(bytes) = sftp.read(state_path.clone()).await {
            if let Ok(state) = parse_server_state(&bytes) {
                let endpoint = ServerEndpoint {
                    port: state.port,
                    token: state.token,
                    daemon: None,
                };
                if ping_server(manager, connection_id, &endpoint).await.is_ok() {
                    return Some(endpoint);
                }
            }
        }
    }
}

/// 部署退避决策：连续失败次数达到阈值后给出的不可用原因（None = 继续按瞬时
/// 处理）。抽成纯函数便于单测。
fn deploy_backoff_reason(failures: u32) -> Option<&'static str> {
    (failures >= SERVER_DEPLOY_BACKOFF_THRESHOLD).then_some(
        "连续多次部署后 server 仍未就绪：请检查远端 sshd 是否允许 TCP 转发（AllowTcpForwarding）、重启远端 server 进程，或断开重连后再试",
    )
}

/// 发现或部署远端 server；不可用时返回原因，调用方回退直连。
///
/// serve 端点就绪后尽力补一步 daemon 传输探测（见 [`ensure_remote_daemon`]）：
/// 探测失败只表示本轮没有 daemon 可用，serve 模式照常返回。
async fn discover_or_deploy_server(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
) -> Result<ServerEndpoint, ServerDeployError> {
    let sftp = manager.open_sftp(connection_id).await?;
    let (mut endpoint, remote_bin) = if let Some(endpoint) =
        try_discover_server(manager, connection_id, &sftp, root, app).await
    {
        // 发现路径不知道部署时的二进制名，daemon 探测里现场用 `uname -m` 解析。
        (endpoint, None)
    } else {
        let (arch, local_binary) = locate_local_server_binary(manager, root).await?;
        let remote_bin = server_binary_remote_path(
            &root.canonical_path,
            windows_native_path(&root.canonical_path).is_some(),
            &arch,
        );
        // 上传之前才标 installing；找本地二进制仍算 probing。
        server_status::note_server_activity(
            manager,
            app,
            root,
            connection_id,
            server_status::ServerPhase::Installing,
        );
        // 本地摘要一份两用：幂等跳过上传 + 远端 self-check 期望值。
        let local_sha256 = sha256_of_file(&local_binary).map_err(ServerDeployError::from)?;
        upload_server_binary(
            manager,
            &sftp,
            root,
            &local_binary,
            &remote_bin,
            &local_sha256,
        )
        .await
        .map_err(ServerDeployError::deploy_stage)?;
        // 落盘校验（sha256 + noexec 探测）通过才允许启动。
        verify_remote_binary(manager, root, &remote_bin, &local_sha256).await?;
        // 顺手清掉改名前的旧版遗留（旧 serve 进程 + agent.json），尽力而为。
        cleanup_legacy_agent_state(manager, root, &sftp).await;
        let state_path = server_state_path(&root.canonical_path);
        let serve_log = server_serve_log_path(&root.canonical_path);
        let command =
            deploy_server_command(&remote_bin, &root.canonical_path, &state_path, &serve_log);
        let windows_script =
            windows_deploy_for(&remote_bin, &root.canonical_path, &state_path, &serve_log)
                .map_err(ServerDeployError::from)?;
        manager
            .exec_remote_shell(
                &root.uri,
                &command,
                &windows_script,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await
            .map_err(|error| {
                ServerDeployError::deploy_stage(format!("启动远端 server 失败：{error}"))
            })?;
        // serve ping 之前进入握手。
        server_status::note_server_activity(
            manager,
            app,
            root,
            connection_id,
            server_status::ServerPhase::Handshaking,
        );
        let endpoint = wait_server_ready(manager, connection_id, &sftp, root)
            .await
            .ok_or_else(|| ServerDeployError::deploy_stage("server 启动超时".to_string()))?;
        (endpoint, Some(remote_bin))
    };
    // daemon 握手（token + HELLO）之前再标一次；已是 handshaking 时不会重复发事件。
    server_status::note_server_activity(
        manager,
        app,
        root,
        connection_id,
        server_status::ServerPhase::Handshaking,
    );
    endpoint.daemon =
        ensure_remote_daemon(manager, connection_id, root, remote_bin.as_deref()).await;
    Ok(endpoint)
}

fn publish_server_if_watched(
    app: Option<&tauri::AppHandle>,
    manager: &SshManager,
    root: &RegisteredRoot,
) {
    if let Some(app) = app {
        server_status::publish_root_state(app, manager, root);
    }
}

/// 读缓存：`Some(Some(..))` 命中端点，`Some(None)` 本次连接内已确定不可用，
/// `None` 表示还没有结论、需要走发现/部署。
fn cached_server_slot(manager: &SshManager, key: &str) -> Option<Option<ServerEndpoint>> {
    let slot = manager.server_slot(key)?;
    if let Some(endpoint) = slot.endpoint {
        return Some(Some(endpoint));
    }
    slot.unavailable_reason.is_some().then_some(None)
}

/// 确保（连接, 项目根）对应的 server 端点可用。
///
/// 前置门不满足、server 未部署或任何失败都返回 `Ok(None)`——调用方一律回退
/// 既有直连路径。成功结果缓存在 slot 里，之后走快路径；失败原因同样缓存，
/// 避免每次目录扫描都重复探测部署。
pub(crate) async fn ensure_server_endpoint(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<Option<ServerEndpoint>, String> {
    ensure_server_endpoint_with_app(manager, root, None).await
}

/// 同 [`ensure_server_endpoint`]，并在 `app` 存在时发布阶段变化。
/// 目录扫描与搜索继续走无 app 的入口；watch 监督和 `ssh_server_restart` 传入 app。
pub(crate) async fn ensure_server_endpoint_with_app(
    manager: &SshManager,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
) -> Result<Option<ServerEndpoint>, String> {
    let connection_id = parse_remote_uri(&root.uri)?.connection_id;
    let key = server_slot_key(&connection_id, &root.canonical_path);
    // 未信任项目、总开关关闭：不部署，直接公布直连原因。Windows 远端走 serve。
    if !manager.server_enabled() || !root.trusted {
        publish_server_if_watched(app, manager, root);
        return Ok(None);
    }
    if let Some(cached) = cached_server_slot(manager, &key) {
        // daemon 降级满冷却期后补一次探测：降级只清 daemon 标记，若不重试，
        // daemon 崩溃后这条连接永远回不去 daemon 传输，直到端点整体重建。
        if cached
            .as_ref()
            .is_some_and(|endpoint| endpoint.daemon.is_none())
            && daemon_downgrade_retry_ready(
                manager
                    .server_slot(&key)
                    .and_then(|slot| slot.daemon_downgraded_at),
                Instant::now(),
            )
        {
            retry_downgraded_daemon(manager, &connection_id, root, &key).await;
        }
        manager.set_server_activity(&key, None);
        publish_server_if_watched(app, manager, root);
        return Ok(cached);
    }
    // 同一 (连接, 根) 的部署串行执行；拿不到锁的并发调用方等结果落盘后复用。
    let gate = manager.server_gate(&key)?;
    let _guard = gate.lock().await;
    if let Some(cached) = cached_server_slot(manager, &key) {
        manager.set_server_activity(&key, None);
        publish_server_if_watched(app, manager, root);
        return Ok(cached);
    }
    // 新一轮从 probing 开始，清掉上次中断留下的瞬时阶段。
    manager.set_server_activity(&key, None);
    publish_server_if_watched(app, manager, root);
    match discover_or_deploy_server(manager, &connection_id, root, app).await {
        Ok(endpoint) => {
            let mut slot = manager.server_slot(&key).unwrap_or_default();
            slot.endpoint = Some(endpoint.clone());
            slot.unavailable_reason = None;
            slot.activity = None;
            // 部署成功：退避计数清零，下一次失败重新从 1 数起。
            slot.deploy_failures = 0;
            manager.set_server_slot(&key, slot);
            publish_server_if_watched(app, manager, root);
            Ok(Some(endpoint))
        }
        Err(error) => {
            let mut slot = manager.server_slot(&key).unwrap_or_default();
            slot.endpoint = None;
            slot.activity = None;
            let mut permanent = error.permanent;
            let mut reason = error.reason;
            if error.after_deploy {
                slot.deploy_failures = slot.deploy_failures.saturating_add(1);
                // 部署退避：连续多次完整部署都等不到就绪（典型如 sshd 禁了
                // TCP 转发，ping 永远打不通），再重试只是热循环，缓存成
                // 不可用并提示人介入，直到重连或 clear_unavailable_servers。
                if let Some(backoff) = deploy_backoff_reason(slot.deploy_failures) {
                    permanent = true;
                    reason = backoff.to_string();
                }
            }
            // 只有确定性失败才占住缓存，瞬时失败留空以便下次重试。
            slot.unavailable_reason = permanent.then_some(reason);
            manager.set_server_slot(&key, slot);
            publish_server_if_watched(app, manager, root);
            Ok(None)
        }
    }
}

/// daemon 降级冷却到点后的重试：拿部署门闩串行化并发探测，成功恢复
/// daemon 标记；失败把降级时间戳重置为现在，再等一个完整冷却期，
/// 避免后续每次操作都对着已知失败的 daemon 白白探测一轮。
async fn retry_downgraded_daemon(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    key: &str,
) {
    let Ok(gate) = manager.server_gate(key) else {
        return;
    };
    let _guard = gate.lock().await;
    let Some(mut slot) = manager.server_slot(key) else {
        return;
    };
    let daemon_missing = slot
        .endpoint
        .as_ref()
        .is_some_and(|endpoint| endpoint.daemon.is_none());
    if !daemon_missing || !daemon_downgrade_retry_ready(slot.daemon_downgraded_at, Instant::now()) {
        return;
    }
    match ensure_remote_daemon(manager, connection_id, root, None).await {
        Some(access) => {
            if let Some(endpoint) = slot.endpoint.as_mut() {
                endpoint.daemon = Some(access);
            }
            slot.daemon_downgraded_at = None;
            manager.set_server_slot(key, slot);
        }
        None => {
            slot.daemon_downgraded_at = Some(Instant::now());
            manager.set_server_slot(key, slot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_slot_cache_tracks_ready_and_unavailable_states() {
        let manager = SshManager::new();
        let key = server_slot_key("c1", "/srv/app");
        // 还没有结论：调用方需要走发现/部署。
        assert!(cached_server_slot(&manager, &key).is_none());

        manager.set_server_slot(
            &key,
            ServerSlot {
                endpoint: Some(ServerEndpoint {
                    port: 4000,
                    token: "t".to_string(),
                    daemon: None,
                }),
                ..Default::default()
            },
        );
        assert_eq!(
            cached_server_slot(&manager, &key).map(|cached| cached.map(|endpoint| endpoint.port)),
            Some(Some(4000))
        );

        // 端点失联后清缓存：回到需要重新发现的空状态。
        manager.clear_server_endpoint(&key);
        assert!(cached_server_slot(&manager, &key).is_none());

        // 确定性不可用：快路径直接判定不可用，不再重复部署。
        manager.set_server_slot(
            &key,
            ServerSlot {
                unavailable_reason: Some("远端架构不支持（armv7l）".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(
            cached_server_slot(&manager, &key).map(|cached| cached.is_none()),
            Some(true)
        );
    }

    #[test]
    fn deploy_backoff_kicks_in_after_consecutive_failures() {
        // 前两次失败仍按瞬时处理，给网络抖动留重试空间。
        assert!(deploy_backoff_reason(0).is_none());
        assert!(deploy_backoff_reason(1).is_none());
        // 连续 2 次完整部署未就绪 → 缓存不可用并提示 AllowTcpForwarding / 重启。
        let reason = deploy_backoff_reason(SERVER_DEPLOY_BACKOFF_THRESHOLD).unwrap();
        assert!(reason.contains("AllowTcpForwarding"));
        assert!(deploy_backoff_reason(3).is_some());
    }

    #[test]
    fn deploy_error_flags_distinguish_permanent_and_deploy_stage() {
        let permanent = ServerDeployError::permanent("架构不支持");
        assert!(permanent.permanent);
        assert!(!permanent.after_deploy);
        let stage = ServerDeployError::deploy_stage("server 启动超时");
        assert!(!stage.permanent);
        assert!(stage.after_deploy);
        // 普通字符串错误保持瞬时且不计退避（如 SFTP 打开失败）。
        let transient = ServerDeployError::from("open sftp 失败".to_string());
        assert!(!transient.permanent && !transient.after_deploy);
    }
}
