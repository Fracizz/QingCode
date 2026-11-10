//! 建立 SSH 传输、私钥/密码认证、主机探测，以及已认证会话的复用与模式校验。

use super::*;

pub(super) async fn open_transport(
    config: &SshConnectionConfig,
    expected_fingerprint: Option<String>,
    purpose: ConnectionPurpose,
) -> Result<OpenedTransport, String> {
    let observed = Arc::new(Mutex::new(None));
    let disconnect_reason = Arc::new(Mutex::new(None));
    let handler = SshClient {
        expected_fingerprint,
        observed_fingerprint: Arc::clone(&observed),
        disconnect_reason: Arc::clone(&disconnect_reason),
        keepalive_window: keepalive_window(purpose),
    };
    let client_config = ssh_client_config(purpose);
    let result = client::connect(
        Arc::new(client_config),
        (config.host.as_str(), config.port),
        handler,
    )
    .await;
    let fingerprint = observed
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .unwrap_or_default();
    let handle = result.map_err(|error| format!("SSH 连接失败：{error}"))?;
    if fingerprint.is_empty() {
        return Err("SSH 服务端未提供主机密钥".to_string());
    }
    Ok((handle, fingerprint, disconnect_reason))
}

/// 已握手的传输：句柄、主机指纹、断开原因槽位。
pub(super) type OpenedTransport = (
    client::Handle<SshClient>,
    String,
    Arc<Mutex<Option<String>>>,
);

pub(super) fn explicit_private_key_path(config: &SshConnectionConfig) -> Option<PathBuf> {
    config
        .private_key_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

pub(super) fn default_private_key_candidates(home: &Path) -> Vec<PathBuf> {
    let ssh_dir = home.join(".ssh");
    [
        "id_ed25519",
        "id_ecdsa",
        "id_rsa",
        "id_ed25519_sk",
        "id_ecdsa_sk",
    ]
    .into_iter()
    .map(|name| ssh_dir.join(name))
    .collect()
}

pub(super) fn resolve_private_key_paths(
    config: &SshConnectionConfig,
) -> Result<Vec<PathBuf>, String> {
    if let Some(path) = explicit_private_key_path(config) {
        return Ok(vec![path]);
    }
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录以查找默认 SSH 私钥".to_string())?;
    let paths: Vec<PathBuf> = default_private_key_candidates(&home)
        .into_iter()
        .filter(|path| path.is_file())
        .collect();
    if paths.is_empty() {
        return Err(
            "未找到本机默认 SSH 私钥（~/.ssh/id_ed25519 等）。WSL 一般没有登录密码，请选择私钥或先配置公钥登录。".to_string(),
        );
    }
    Ok(paths)
}

pub(super) async fn authenticate_public_key(
    handle: &mut client::Handle<SshClient>,
    config: &SshConnectionConfig,
    key_path: &Path,
) -> Result<bool, String> {
    let key = load_secret_key(key_path, config.passphrase.as_deref())
        .map_err(|error| format!("读取 SSH 私钥失败：{}：{error}", key_path.display()))?;
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|error| format!("协商 SSH 密钥算法失败：{error}"))?
        .flatten();
    let result = handle
        .authenticate_publickey(
            &config.username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await
        .map_err(|error| format!("SSH 私钥认证失败：{error}"))?;
    Ok(result.success())
}

pub(super) async fn authenticate(
    handle: &mut client::Handle<SshClient>,
    config: &SshConnectionConfig,
) -> Result<(), String> {
    match config.auth_kind.as_str() {
        "password" => {
            let password = config
                .password
                .as_deref()
                .ok_or_else(|| "请输入 SSH 密码".to_string())?;
            let result = handle
                .authenticate_password(&config.username, password)
                .await
                .map_err(|error| format!("SSH 密码认证失败：{error}"))?;
            if result.success() {
                Ok(())
            } else {
                Err("SSH 认证失败，请检查用户名和凭据".to_string())
            }
        }
        _ => {
            let key_paths = resolve_private_key_paths(config)?;
            let mut last_error = None;
            for key_path in key_paths {
                match authenticate_public_key(handle, config, &key_path).await {
                    Ok(true) => return Ok(()),
                    Ok(false) => {
                        last_error = Some(format!("SSH 私钥认证失败：{}", key_path.display()));
                    }
                    Err(error) => last_error = Some(error),
                }
            }
            Err(last_error.unwrap_or_else(|| "SSH 认证失败，请检查用户名和凭据".to_string()))
        }
    }
}

#[tauri::command]
pub async fn ssh_probe_host(config: SshConnectionConfig) -> Result<SshHostProbe, String> {
    probe_host_with_timeout(&config, SSH_HANDSHAKE_TIMEOUT).await
}

pub(super) async fn probe_host_with_timeout(
    config: &SshConnectionConfig,
    timeout: Duration,
) -> Result<SshHostProbe, String> {
    let observed = Arc::new(Mutex::new(None));
    let handler = SshClient {
        expected_fingerprint: None,
        observed_fingerprint: Arc::clone(&observed),
        disconnect_reason: Arc::new(Mutex::new(None)),
        keepalive_window: keepalive_window(ConnectionPurpose::Main),
    };
    // russh 的 inactivity_timeout 要等 banner 读取后启动 Session 才生效。
    // TCP 已接受却不发 SSH banner 的主机必须由探测整体 deadline 收口。
    tokio::time::timeout(timeout, async {
        let result = client::connect(
            Arc::new(client::Config {
                inactivity_timeout: Some(Duration::from_secs(15)),
                ..Default::default()
            }),
            (config.host.as_str(), config.port),
            handler,
        )
        .await;
        if let Ok(handle) = result {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "host key probe", "en")
                .await;
        }
    })
    .await
    .map_err(|_| {
        format!(
            "SSH 主机指纹探测超时：{}:{} 在 {} 秒内未完成握手，请检查远端 sshd 是否正常",
            config.host,
            config.port,
            timeout.as_secs_f64()
        )
    })?;
    let fingerprint = observed
        .lock()
        .map_err(|_| "SSH 主机密钥状态不可用".to_string())?
        .clone()
        .ok_or_else(|| "无法获取 SSH 主机指纹，请检查地址和端口".to_string())?;
    Ok(SshHostProbe { fingerprint })
}

pub(super) fn existing_session(
    manager: &SshManager,
    connection_id: &str,
) -> Option<Arc<ConnectedSession>> {
    manager
        .session(connection_id)
        .ok()
        .filter(|session| !session.handle.is_closed())
}

/// An authenticated transport cannot adopt an edited identity or credentials.
/// Otherwise file operations would keep using the old host while reconnect and
/// terminal transports authenticate against the newly remembered configuration.
pub(super) fn require_matching_session_config(
    authenticated: &SshConnectionConfig,
    requested: &SshConnectionConfig,
) -> Result<(), String> {
    if authenticated.host.eq_ignore_ascii_case(&requested.host)
        && authenticated.port == requested.port
        && authenticated.username == requested.username
        && authenticated.auth_kind == requested.auth_kind
        && authenticated.private_key_path == requested.private_key_path
        && requested
            .password
            .as_ref()
            .is_none_or(|password| authenticated.password.as_ref() == Some(password))
        && requested
            .passphrase
            .as_ref()
            .is_none_or(|passphrase| authenticated.passphrase.as_ref() == Some(passphrase))
        && authenticated.host_key_fingerprint == requested.host_key_fingerprint
    {
        Ok(())
    } else {
        Err("SSH 连接配置已变更，请先断开现有连接再重连；测试连接不会更新在用会话".into())
    }
}

/// 不带模式的调用（浏览目录的 ssh_open_session）不能抹掉会话已定下的模式。
pub(super) fn merge_remembered_config(
    stored_mode: Option<RemoteMode>,
    config: SshConnectionConfig,
) -> SshConnectionConfig {
    let mode = config.mode.or(stored_mode);
    SshConnectionConfig { mode, ..config }
}

/// 前端据「连接模式已变更」识别该错误：切换模式必须先 `ssh_disconnect` 再连接。
pub(super) fn mode_changed_error(current: Option<RemoteMode>, requested: RemoteMode) -> String {
    let current = current.map_or("未定", RemoteMode::label);
    format!(
        "连接模式已变更：该连接当前为 {current} 模式，请求 {} 模式，请先断开连接再重连",
        requested.label()
    )
}

/// 会话已有项目根时模式不可改：只有浏览目录用的会话（还没有根）可以在连接时定下新模式。
pub(super) fn mode_conflict(
    current: Option<RemoteMode>,
    requested: RemoteMode,
    has_roots: bool,
) -> Option<String> {
    match current {
        Some(current) if current != requested && has_roots => {
            Some(mode_changed_error(Some(current), requested))
        }
        _ => None,
    }
}

pub(super) fn ensure_mode_unchanged(
    manager: &SshManager,
    connection_id: &str,
    requested: RemoteMode,
) -> Result<(), String> {
    let has_roots = !manager.roots_for_connection(connection_id).is_empty();
    match mode_conflict(manager.connection_mode(connection_id), requested, has_roots) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

pub(super) fn ssh_handshake_timeout_error(config: &SshConnectionConfig) -> String {
    format!(
        "SSH 连接超时：{}:{} 在 {} 秒内未完成握手，请检查远端 sshd 是否正常",
        config.host,
        config.port,
        SSH_HANDSHAKE_TIMEOUT.as_secs()
    )
}

/// 建立并认证一条新连接，但不登记到连接表。
pub(super) async fn authenticate_session(
    config: SshConnectionConfig,
    purpose: ConnectionPurpose,
) -> Result<(ConnectedSession, String), String> {
    let expected = config
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty());
    let (handle, fingerprint, disconnect_reason) =
        tokio::time::timeout(SSH_HANDSHAKE_TIMEOUT, async {
            let (mut handle, fingerprint, disconnect_reason) =
                open_transport(&config, expected, purpose).await?;
            authenticate(&mut handle, &config).await?;
            Ok::<_, String>((handle, fingerprint, disconnect_reason))
        })
        .await
        .map_err(|_| ssh_handshake_timeout_error(&config))??;
    Ok((
        ConnectedSession {
            server_incarnation: Arc::new(()),
            handle,
            config: Mutex::new(config),
            sftp: tokio::sync::Mutex::new(None),
            disconnect_reason,
        },
        fingerprint,
    ))
}

pub(super) async fn store_authenticated_session(
    manager: &SshManager,
    config: SshConnectionConfig,
) -> Result<(Arc<ConnectedSession>, String), String> {
    let id = config.id.clone();
    let (connected, fingerprint) = authenticate_session(config, ConnectionPurpose::Main).await?;
    let connected = Arc::new(connected);
    manager
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .insert(id, Arc::clone(&connected));
    Ok((connected, fingerprint))
}
