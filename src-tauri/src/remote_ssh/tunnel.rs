//! SSH 隧道：Server 的 HTTPS/WSS 流量经已认证 SSH 会话的 `direct-tcpip`
//! 通道到远端网关的回环地址，只开放 SSH 端口的主机也能使用 Server。
//!
//! 隧道会话不放进主 `SshManager` 的会话表：主管理器看到 `direct_config`
//! 后一律走 Server 路径，不会把隧道会话当成 SSH 模式使用。这里用一个独立的
//! `SshManager` 持有会话，复用其认证、断线重连与远端命令执行能力。

use super::*;
use std::sync::OnceLock;

#[cfg(test)]
mod live_acceptance;

static SESSIONS: OnceLock<SshManager> = OnceLock::new();

/// 持有隧道 SSH 会话的独立管理器；同时用于部署、读取网关配对信息等维护命令。
pub(super) fn sessions() -> &'static SshManager {
    SESSIONS.get_or_init(SshManager::new)
}

/// 移除并断开隧道会话；已建立的通道随之结束，daemon 中的终端不受影响。
pub(super) async fn close(connection_id: &str) {
    direct::discard_tunnel_idle(connection_id);
    let removed = sessions()
        .sessions
        .write()
        .ok()
        .and_then(|mut sessions| sessions.remove(connection_id));
    if let Some(session) = removed {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            session
                .handle
                .disconnect(Disconnect::ByApplication, "QingCode tunnel closed", "en"),
        )
        .await;
    }
}

fn open_failure(error: &russh::Error, host: &str, port: u16) -> Option<String> {
    let russh::Error::ChannelOpenFailure(reason) = error else {
        return None;
    };
    Some(match reason {
        russh::ChannelOpenFailure::AdministrativelyProhibited => {
            "[direct:unreachable] 远端 SSH 禁止端口转发（AllowTcpForwarding），请改用 SSH 兼容模式或端口直连"
                .to_string()
        }
        // 会话本身正常，只是远端回环端口无人监听：网关未启动或已退出。
        russh::ChannelOpenFailure::ConnectFailed => format!(
            "[direct:unreachable] 远端 {host}:{port} 没有运行中的 Server 网关，请重新连接以启动服务"
        ),
        _ => format!("[direct:unreachable] 远端拒绝建立 SSH 隧道通道：{error}"),
    })
}

/// 单次打开 `direct-tcpip` 通道；`stale` 表示 SSH 会话已失效、值得重连一次。
async fn open_once(
    session: &ConnectedSession,
    host: &str,
    port: u16,
) -> Result<russh::Channel<client::Msg>, ChannelOpenError> {
    let opened = tokio::time::timeout(
        SSH_CHANNEL_OPEN_TIMEOUT,
        session
            .handle
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0),
    )
    .await;
    match opened {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(error)) => match open_failure(&error, host, port) {
            Some(message) => Err(ChannelOpenError {
                message,
                stale: session.handle.is_closed(),
            }),
            None => Err(ChannelOpenError {
                message: format!("[direct:unreachable] 打开 SSH 隧道通道失败：{error}"),
                stale: is_stale_russh_error(&error) || session.handle.is_closed(),
            }),
        },
        Err(_) => Err(ChannelOpenError {
            message: "[direct:timeout] 打开 SSH 隧道通道超时，远端未响应".to_string(),
            stale: !connection_responds(&session.handle).await,
        }),
    }
}

/// 把主管理器已认证的 SSH 会话交给隧道表持有（同一条连接，不重新认证）。
fn adopt(connection_id: &str, session: Arc<ConnectedSession>) -> Result<(), String> {
    sessions()
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .insert(connection_id.to_string(), session);
    Ok(())
}

/// 网关监听地址对应的远端回环目标：通配地址经回环可达，具体地址原样使用。
fn tunnel_host(hostname: &str) -> String {
    match hostname.trim().trim_matches(['[', ']']) {
        "" | "0.0.0.0" => "127.0.0.1".into(),
        "::" => "::1".into(),
        host => host.into(),
    }
}

fn tunnel_config(
    connection_id: &str,
    info: &qingcode_server::direct::DirectInfo,
) -> Result<direct::DirectConnectionConfig, String> {
    let host = tunnel_host(&info.hostname);
    let endpoint = if host.contains(':') {
        format!("https://[{host}]:{}", info.port)
    } else {
        format!("https://{host}:{}", info.port)
    };
    Ok(direct::DirectConnectionConfig {
        endpoint,
        certificate_fingerprint: info.certificate_sha256.clone(),
        token: info.token.clone().ok_or("远端 Server 配对信息缺少凭据")?,
        tunnel: Some(connection_id.to_string()),
    })
}

fn parse_descriptor(output: &RemoteExecResult) -> Option<qingcode_server::direct::DirectInfo> {
    if output.exit_code != 0 {
        return None;
    }
    output
        .stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
}

async fn run(
    manager: &SshManager,
    root: &RegisteredRoot,
    commands: (String, String),
) -> Result<RemoteExecResult, String> {
    manager
        .exec_remote_shell(
            &root.uri,
            &commands.0,
            &commands.1,
            true,
            Duration::from_secs(40),
        )
        .await
}

/// 读取当前 SSH 用户的网关描述（端口、证书、凭据）；从未启动过时为 `None`。
async fn read_gateway(
    manager: &SshManager,
    root: &RegisteredRoot,
    bin: &str,
) -> Result<Option<qingcode_server::direct::DirectInfo>, String> {
    let output = run(manager, root, direct_update::read_commands(bin)).await?;
    Ok(parse_descriptor(&output))
}

async fn start_gateway(
    manager: &SshManager,
    root: &RegisteredRoot,
    bin: &str,
    at: &qingcode_server::direct::DirectInfo,
) -> Result<qingcode_server::direct::DirectInfo, String> {
    let started = run(manager, root, direct_update::start_commands(bin, at)).await?;
    if started.exit_code != 0 {
        return Err(format!(
            "启动远端 Server 网关失败（{}:{}）：{}",
            at.hostname,
            at.port,
            started.stderr.trim()
        ));
    }
    read_gateway(manager, root, bin)
        .await?
        .ok_or_else(|| "远端 Server 网关已启动，但未取得配对信息".to_string())
}

/// 经 SFTP 直接读取默认运行目录中的网关描述与配对凭据（与 `direct-info
/// --include-secret` 读取同一组用户私有文件）。SFTP 初始目录即家目录；
/// 任何一步失败都返回 `None`，由调用方走完整准备流程。
async fn read_gateway_files(
    manager: &SshManager,
    connection_id: &str,
) -> Option<qingcode_server::direct::DirectInfo> {
    const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
    let sftp = manager.open_sftp(connection_id).await.ok()?;
    let home = sftp.canonicalize(".".to_string()).await.ok()?;
    let dir = [".qingcode", "server", "run", "direct"]
        .iter()
        .fold(home, |path, name| join_remote_path(&path, name));
    let read = |name: &str| {
        let path = join_remote_path(&dir, name);
        let sftp = Arc::clone(&sftp);
        async move {
            let file = sftp.open(path).await.ok()?;
            let mut text = String::new();
            file.take(MAX_DESCRIPTOR_BYTES)
                .read_to_string(&mut text)
                .await
                .ok()?;
            Some(text)
        }
    };
    let mut info: qingcode_server::direct::DirectInfo =
        serde_json::from_str(&read("endpoint.json").await?).ok()?;
    let token = read("token").await?.trim().to_string();
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    info.token = Some(token);
    Some(info)
}

/// 首次启动的网关只监听回环地址：经 SSH 隧道访问，不需要防火墙放行。
fn loopback_gateway() -> qingcode_server::direct::DirectInfo {
    qingcode_server::direct::DirectInfo {
        hostname: "127.0.0.1".into(),
        port: qingcode_server::direct::DEFAULT_DIRECT_PORT,
        certificate_sha256: String::new(),
        server_version: String::new(),
        protocol: 0,
        pid: 0,
        previous_ports: Vec::new(),
        token: None,
    }
}

/// 让 Server 模式连接改经 SSH 隧道使用直连网关：暂存同版本服务程序，
/// 复用运行中的网关（更旧版本则替换），没有则启动仅回环可达的网关，
/// 最后把连接登记为隧道直连。daemon 由网关按需拉起，异版本 daemon 的
/// 沿用或替换在其后的 HELLO 探测中按兼容契约处理。
pub(super) async fn activate(
    manager: &SshManager,
    root: &RegisteredRoot,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let id = parse_remote_uri(&root.uri)?.connection_id;
    let gate = manager.server_gate(&format!("tunnel|{id}"))?;
    let _guard = gate.lock().await;
    if manager.direct_config(&id).is_some() {
        return Ok(());
    }
    let session = manager.live_session(&id).await?;
    adopt(&id, session)?;
    // 快速路径：网关已在运行且版本合用时直接接入，不必暂存程序（Windows 上
    // 校验程序摘要要十几秒）。描述读不到或网关不可用再走完整准备。
    if let Some(info) = read_gateway_files(manager, &id).await {
        let config = tunnel_config(&id, &info)?;
        if let Ok(health) = direct::test(&config).await {
            if direct::require_usable_gateway(&config, &health).is_ok() {
                return switch_to_tunnel(manager, &id, config);
            }
        }
    }
    server_status::note_server_activity(
        manager,
        app,
        root,
        &id,
        server_status::ServerPhase::Installing,
    );
    let staged = server::stage_direct_gateway(manager, root).await?;
    server_status::note_server_activity(
        manager,
        app,
        root,
        &id,
        server_status::ServerPhase::Handshaking,
    );
    let info = match read_gateway(manager, root, &staged).await? {
        Some(info) => {
            let config = tunnel_config(&id, &info)?;
            match direct::test(&config).await {
                Ok(health) if direct::require_usable_gateway(&config, &health).is_ok() => info,
                Ok(_) => {
                    // 更旧的网关：只停止经身份核对的这一个网关进程，daemon 与终端保留。
                    let stopped =
                        run(manager, root, direct_update::stop_commands(&staged, &info)).await?;
                    if stopped.exit_code != 0 {
                        return Err(format!(
                            "停止旧版远端 Server 网关失败：{}",
                            stopped.stderr.trim()
                        ));
                    }
                    start_gateway(manager, root, &staged, &info).await?
                }
                // 网关未运行（或描述过期）：按原监听地址与端口重新启动。
                Err(_) => start_gateway(manager, root, &staged, &info).await?,
            }
        }
        None => start_gateway(manager, root, &staged, &loopback_gateway()).await?,
    };
    let config = tunnel_config(&id, &info)?;
    let health = direct::test(&config).await?;
    direct::require_usable_gateway(&config, &health)?;
    switch_to_tunnel(manager, &id, config)
}

/// 显式更新：撤销隧道登记后重新建立（更旧的网关随之替换），再按「替换」
/// 语义处理更旧的 daemon。用户已确认会结束旧服务托管的终端。
pub(super) async fn update(
    manager: &SshManager,
    root: &RegisteredRoot,
    app: &AppHandle,
) -> Result<(), String> {
    let id = parse_remote_uri(&root.uri)?.connection_id;
    if let Some(config) = manager.direct_config(&id) {
        direct::close_connection(&config.endpoint, &id);
    }
    manager
        .direct_connections
        .write()
        .map_err(|_| "Server 状态不可用")?
        .remove(&id);
    activate(manager, root, Some(app)).await?;
    let config = manager.direct_config(&id).ok_or("远端 Server 隧道未建立")?;
    let access = server::DaemonAccess {
        bin: "direct".into(),
        token: config.token,
    };
    // 先按常规探测：更旧但仍有终端的 daemon 会被登记为沿用，这里再按显式更新替换。
    server::ensure_server_endpoint_with_app(manager, root, Some(app)).await?;
    if server::kept_daemon(&access).is_some_and(|kept| !kept.newer) {
        server::shutdown_remote_daemon(manager, &id, &access).await;
        server::forget_kept_daemon(&access);
        manager.clear_server_endpoint(&server::server_slot_key(&id, &root.canonical_path));
        server::ensure_server_endpoint_with_app(manager, root, Some(app)).await?;
    }
    Ok(())
}

/// 把连接登记为隧道直连；该连接下其他项目的旧服务状态作废，下次按 Server 路径重新就绪。
fn switch_to_tunnel(
    manager: &SshManager,
    connection_id: &str,
    config: direct::DirectConnectionConfig,
) -> Result<(), String> {
    manager
        .direct_connections
        .write()
        .map_err(|_| "Server 状态不可用")?
        .insert(connection_id.to_string(), config);
    manager
        .direct_failures
        .write()
        .map_err(|_| "Server 状态不可用")?
        .remove(connection_id);
    manager
        .direct_active
        .write()
        .map_err(|_| "Server 状态不可用")?
        .insert(connection_id.to_string());
    let prefix = format!("{connection_id}|");
    if let Ok(mut servers) = manager.servers.write() {
        servers.retain(|key, _| !key.starts_with(&prefix));
    }
    Ok(())
}

/// 断开隧道连接：撤销隧道登记并关闭 SSH 会话。与端口直连一致，只断开通信，
/// 不结束 daemon 托管的终端，重新连接后接回。
pub(super) async fn disconnect(manager: &SshManager, connection_id: &str) -> Result<(), String> {
    manager
        .direct_connections
        .write()
        .map_err(|_| "Server 状态不可用")?
        .remove(connection_id);
    close(connection_id).await;
    let gate = manager.reconnect_gate(connection_id)?;
    let mut last_failure = gate.lock().await;
    *last_failure = None;
    let session = manager
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .remove(connection_id);
    if let Ok(mut policies) = manager.workspace_server_settings.write() {
        policies.retain(|uri, _| remote_uri_connection_id(uri) != Some(connection_id));
    }
    if let Ok(mut passive) = manager.passive_roots.write() {
        passive.retain(|uri| remote_uri_connection_id(uri) != Some(connection_id));
    }
    if let Some(session) = session {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            session
                .handle
                .disconnect(Disconnect::ByApplication, "QingCode disconnect", "en"),
        )
        .await;
    }
    Ok(())
}

#[cfg(test)]
static TEST_ROUTES: Mutex<Option<HashMap<String, u16>>> = Mutex::new(None);

/// 测试用：把该连接的隧道请求转到本机回环端口，覆盖隧道以上的全部逻辑。
#[cfg(test)]
pub(super) fn route_for_test(connection_id: &str, local_port: Option<u16>) {
    let mut routes = TEST_ROUTES.lock().unwrap_or_else(|e| e.into_inner());
    let routes = routes.get_or_insert_with(HashMap::new);
    match local_port {
        Some(port) => routes.insert(connection_id.into(), port),
        None => routes.remove(connection_id),
    };
}

/// 经隧道连到远端 `host:port`，供 TLS 使用。SSH 会话失效时重连一次。
pub(super) async fn open(
    connection_id: &str,
    host: &str,
    port: u16,
) -> Result<Box<dyn direct::Transport>, String> {
    #[cfg(test)]
    {
        let routed = TEST_ROUTES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|routes| routes.get(connection_id).copied());
        if let Some(local) = routed {
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", local))
                .await
                .map_err(|_| "[direct:unreachable] 测试隧道端口不可用".to_string())?;
            return Ok(Box::new(stream));
        }
    }
    let manager = sessions();
    let session = manager
        .session(connection_id)
        .map_err(|_| "[direct:unreachable] SSH 隧道尚未建立，请重新连接".to_string())?;
    let session = if session.handle.is_closed() {
        let session = manager
            .reconnect_after_channel_failure(connection_id, &session)
            .await?;
        direct::discard_tunnel_idle(connection_id);
        session
    } else {
        session
    };
    let channel = match open_once(&session, host, port).await {
        Ok(channel) => channel,
        Err(error) if error.stale => {
            let session = manager
                .reconnect_after_channel_failure(connection_id, &session)
                .await?;
            direct::discard_tunnel_idle(connection_id);
            open_once(&session, host, port).await?
        }
        Err(error) => return Err(error.message),
    };
    Ok(Box::new(channel.into_stream()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarding_refusals_explain_the_remote_cause() {
        let prohibited =
            russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited);
        assert!(open_failure(&prohibited, "127.0.0.1", 48763)
            .unwrap()
            .contains("AllowTcpForwarding"));
        let refused = russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed);
        let message = open_failure(&refused, "127.0.0.1", 48763).unwrap();
        assert!(message.contains("127.0.0.1:48763"), "{message}");
        assert!(message.starts_with("[direct:unreachable]"));
        assert!(open_failure(&russh::Error::Disconnect, "127.0.0.1", 1).is_none());
    }

    fn paired(hostname: &str) -> qingcode_server::direct::DirectInfo {
        let mut info = loopback_gateway();
        info.hostname = hostname.into();
        info.token = Some("secret".into());
        info.certificate_sha256 = "ab".repeat(32);
        info
    }

    #[test]
    fn tunnel_targets_the_gateway_listen_address_over_loopback() {
        for (hostname, endpoint) in [
            ("0.0.0.0", "https://127.0.0.1:48763"),
            ("", "https://127.0.0.1:48763"),
            ("::", "https://[::1]:48763"),
            ("[::]", "https://[::1]:48763"),
            ("127.0.0.1", "https://127.0.0.1:48763"),
            ("192.168.1.9", "https://192.168.1.9:48763"),
        ] {
            let config = tunnel_config("conn", &paired(hostname)).unwrap();
            assert_eq!(config.endpoint, endpoint);
            assert_eq!(config.tunnel.as_deref(), Some("conn"));
        }
        let mut unpaired = paired("127.0.0.1");
        unpaired.token = None;
        assert!(tunnel_config("conn", &unpaired).is_err());
    }

    #[test]
    fn descriptor_is_read_from_the_last_json_line_of_a_successful_command() {
        let mut info = paired("127.0.0.1");
        info.port = 50123;
        let line = serde_json::to_string(&info).unwrap();
        let ok = RemoteExecResult {
            stdout: format!("banner\n{line}\n"),
            stderr: String::new(),
            exit_code: 0,
        };
        assert_eq!(parse_descriptor(&ok).unwrap().port, 50123);
        let failed = RemoteExecResult { exit_code: 1, ..ok };
        assert!(parse_descriptor(&failed).is_none());
    }

    #[test]
    fn tunnel_accepts_same_or_newer_gateways_but_port_direct_requires_the_same_version() {
        let health = |version: &str| direct::DirectHealth {
            healthy: true,
            server_version: version.into(),
            protocol: qingcode_server::proto::PROTOCOL_VERSION,
            port: 48763,
            certificate_sha256: String::new(),
        };
        let mut config = tunnel_config("conn", &paired("127.0.0.1")).unwrap();
        let current = qingcode_server::SERVER_VERSION;
        assert!(direct::require_usable_gateway(&config, &health(current)).is_ok());
        assert!(direct::require_usable_gateway(&config, &health("99.0.0")).is_ok());
        assert!(direct::require_usable_gateway(&config, &health("0.0.1")).is_err());
        config.tunnel = None;
        assert!(direct::require_usable_gateway(&config, &health("99.0.0")).is_err());
        assert!(direct::require_usable_gateway(&config, &health(current)).is_ok());
    }

    #[tokio::test]
    async fn missing_tunnel_session_is_reported_without_falling_back_to_tcp() {
        let error = open("tunnel-never-established", "127.0.0.1", 1)
            .await
            .err()
            .unwrap();
        assert!(error.contains("SSH 隧道尚未建立"), "{error}");
    }
}
