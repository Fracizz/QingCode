//! Native-only storage and explicit pairing for independent Agent connections.
use super::direct::DirectConnectionConfig;
use super::*;
use serde_json::json;
static STORE_WRITE: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    enabled: bool,
    host: String,
    port: u16,
    certificate_fingerprint: String,
    token: String,
    #[serde(default)]
    previous_ports: Vec<u16>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectAgentInfo {
    enabled: bool,
    host: String,
    port: u16,
    certificate_fingerprint: String,
    token_saved: bool,
    previous_ports: Vec<u16>,
}
impl Saved {
    fn info(&self) -> DirectAgentInfo {
        DirectAgentInfo {
            enabled: self.enabled,
            host: self.host.clone(),
            port: self.port,
            certificate_fingerprint: self.certificate_fingerprint.clone(),
            token_saved: !self.token.is_empty(),
            previous_ports: self.previous_ports.clone(),
        }
    }
    fn config(&self) -> Result<DirectConnectionConfig, String> {
        Ok(DirectConnectionConfig {
            endpoint: endpoint(&self.host, self.port)?,
            certificate_fingerprint: self.certificate_fingerprint.clone(),
            token: self.token.clone(),
        })
    }
}
fn endpoint(host: &str, port: u16) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || "/@?#\\".contains(c))
        || port == 0
    {
        return Err("[direct:protocol] 请填写有效的主机和 TCP 端口".into());
    }
    let host = host.trim_matches(['[', ']']);
    Ok(if host.contains(':') {
        format!("https://[{host}]:{port}")
    } else {
        format!("https://{host}:{port}")
    })
}
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) async fn connect_root(
    manager: &SshManager,
    app: &AppHandle,
    config: &SshConnectionConfig,
    root_uri: &str,
    trusted: bool,
    deferred: bool,
) -> Result<SshConnectResult, String> {
    let gate = manager.server_gate(&format!("direct-config|{}", config.id))?;
    let _guard = gate.lock().await;
    let parsed = parse_remote_uri(root_uri)?;
    if parsed.connection_id != config.id {
        return Err("项目与 Server 连接不匹配".into());
    }
    let direct = manager
        .direct_config(&config.id)
        .ok_or("Server 配置不存在")?;
    direct::test(&direct).await?;
    manager
        .direct_failures
        .write()
        .map_err(|_| "Server 状态不可用")?
        .remove(&config.id);
    let sftp = SftpSession::direct(direct.clone(), None, false);
    let canonical = sftp
        .canonicalize(parsed.path)
        .await
        .map_err(|e| e.to_string())?;
    if !sftp
        .metadata(canonical.clone())
        .await
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("远程项目路径不是目录".into());
    }
    if manager.direct_config(&config.id).is_none_or(|current| {
        current.endpoint != direct.endpoint
            || current.certificate_fingerprint != direct.certificate_fingerprint
            || current.token != direct.token
    }) {
        return Err("Server 配置已变化，请重新连接".into());
    }
    let root = RegisteredRoot {
        uri: normalize_remote_uri(root_uri),
        canonical_path: canonical.clone(),
        trusted,
    };
    manager
        .roots
        .write()
        .map_err(|_| "工作区状态不可用")?
        .insert(root_uri.into(), root.clone());
    manager
        .direct_active
        .write()
        .map_err(|_| "Server 状态不可用")?
        .insert(config.id.clone());
    if deferred {
        manager
            .passive_roots
            .write()
            .map_err(|_| "工作区状态不可用")?
            .insert(normalize_remote_uri(root_uri));
    }
    if trusted && !deferred {
        manager.start_workspace_watch(app.clone(), &root);
    }
    server_status::publish_root_state(app, manager, &root);
    Ok(SshConnectResult {
        fingerprint: config
            .host_key_fingerprint
            .clone()
            .unwrap_or(direct.certificate_fingerprint),
        canonical_root: canonical,
    })
}
fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("direct-credentials");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    qingcode_server::direct::protect_private_directory(&dir)?;
    Ok(dir.join("connections.json"))
}
fn read(app: &AppHandle) -> Result<HashMap<String, Saved>, String> {
    let path = path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    if std::fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Server 凭据文件不能是链接".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Server 凭据配置格式无效".into())
}
fn write(app: &AppHandle, records: &HashMap<String, Saved>) -> Result<(), String> {
    use std::io::Write;
    let path = path(app)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(records).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    qingcode_server::direct::replace_private_file(&temporary, &path)
}
fn persist(app: &AppHandle, id: &str, mut saved: Saved) -> Result<Saved, String> {
    let _guard = STORE_WRITE.lock().map_err(|_| "Server 凭据存储不可用")?;
    let mut records = read(app)?;
    if let Some(previous) = records.get(id) {
        for port in previous
            .previous_ports
            .iter()
            .copied()
            .chain(std::iter::once(previous.port))
        {
            if port != saved.port && !saved.previous_ports.contains(&port) {
                saved.previous_ports.push(port);
            }
        }
    }
    saved.previous_ports.retain(|p| *p != saved.port);
    if saved.previous_ports.len() > 8 {
        saved.previous_ports.drain(..saved.previous_ports.len() - 8);
    }
    records.insert(id.into(), saved.clone());
    write(app, &records)?;
    Ok(saved)
}
pub fn configure_direct_connections(app: &AppHandle) -> Result<(), String> {
    let records = read(app)?;
    let manager = app.state::<SshManager>();
    let mut configs = manager
        .direct_connections
        .write()
        .map_err(|_| "Server 状态不可用")?;
    for (id, saved) in records {
        if saved.enabled {
            configs.insert(id, saved.config()?);
        }
    }
    Ok(())
}
#[tauri::command]
pub fn direct_agent_info(
    connection_id: String,
    app: AppHandle,
) -> Result<Option<DirectAgentInfo>, String> {
    Ok(read(&app)?.get(&connection_id).map(Saved::info))
}
#[tauri::command]
pub async fn direct_agent_probe(host: String, port: u16) -> Result<serde_json::Value, String> {
    Ok(json!({"certificateFingerprint":direct::probe(&endpoint(&host,port)?).await?}))
}
fn target(
    app: &AppHandle,
    id: &str,
    host: String,
    port: u16,
    fingerprint: String,
    token: Option<String>,
) -> Result<Saved, String> {
    let records = read(app)?;
    let old = records.get(id);
    let token = token
        .filter(|v| !v.is_empty())
        .or_else(|| {
            old.filter(|r| r.certificate_fingerprint.eq_ignore_ascii_case(&fingerprint))
                .map(|r| r.token.clone())
        })
        .ok_or("[direct:auth] 请导入该服务的配对信息")?;
    let mut previous = old.map(|r| r.previous_ports.clone()).unwrap_or_default();
    if let Some(old) = old {
        if old.port != port && !previous.contains(&old.port) {
            previous.push(old.port);
        }
    }
    previous.retain(|p| *p != port);
    if previous.len() > 8 {
        previous.drain(..previous.len() - 8);
    }
    Ok(Saved {
        enabled: true,
        host: host.trim().into(),
        port,
        certificate_fingerprint: fingerprint,
        token,
        previous_ports: previous,
    })
}
#[tauri::command]
pub async fn direct_agent_test(
    connection_id: String,
    host: String,
    port: u16,
    certificate_fingerprint: String,
    token: Option<String>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let saved = target(
        &app,
        &connection_id,
        host,
        port,
        certificate_fingerprint,
        token,
    )?;
    let health = direct::test(&saved.config()?).await?;
    Ok(json!({"version":health.server_version,"protocol":health.protocol}))
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn direct_agent_save(
    connection_id: String,
    host: String,
    port: u16,
    certificate_fingerprint: String,
    token: Option<String>,
    enabled: bool,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let gate = manager.server_gate(&format!("direct-config|{connection_id}"))?;
    let _guard = gate.lock().await;
    let saved = if enabled {
        let saved = target(
            &app,
            &connection_id,
            host,
            port,
            certificate_fingerprint,
            token,
        )?;
        direct::test(&saved.config()?).await?;
        saved
    } else {
        let mut old = read(&app)?
            .remove(&connection_id)
            .ok_or("尚无 Server 配置")?;
        old.enabled = false;
        old
    };
    let previous = manager.direct_config(&connection_id);
    let saved = persist(&app, &connection_id, saved)?;
    {
        let mut configs = manager
            .direct_connections
            .write()
            .map_err(|_| "Server 状态不可用")?;
        if enabled {
            configs.insert(connection_id.clone(), saved.config()?);
        } else {
            configs.remove(&connection_id);
        }
    }
    if let Some(old) = previous {
        direct::close_connection(&old.endpoint, &connection_id);
    }
    if enabled {
        manager
            .direct_failures
            .write()
            .map_err(|_| "Server 状态不可用")?
            .remove(&connection_id);
        manager
            .direct_active
            .write()
            .map_err(|_| "Server 状态不可用")?
            .insert(connection_id.clone());
        // Close only the old transport. Persistent PTYs reconnect by the same id.
        let transports = manager
            .terminal_transport_pools
            .lock()
            .ok()
            .and_then(|p| p.get(&connection_id).cloned());
        if let Some(pool) = transports {
            let transports = pool
                .lock()
                .await
                .entries
                .iter()
                .map(|entry| Arc::clone(&entry.transport))
                .collect::<Vec<_>>();
            for transport in transports {
                close_terminal_transport(&transport).await;
            }
        }
    } else {
        manager
            .direct_active
            .write()
            .map_err(|_| "Server 状态不可用")?
            .remove(&connection_id);
    }
    let roots = manager.roots_for_connection(&connection_id);
    for root in roots {
        let key = server::server_slot_key(&connection_id, &root.canonical_path);
        manager.stop_watch_supervisor(&key);
        manager
            .servers
            .write()
            .map_err(|_| "服务状态不可用")?
            .remove(&key);
        manager.start_workspace_watch(app.clone(), &root);
        server_status::publish_root_state(&app, &manager, &root);
    }
    Ok(())
}

// SFTP returns /C:/... on Windows; PowerShell requires a native drive path.
fn provision_commands(bin: &str, port: u16) -> (String, String) {
    let unix = format!(
        "{} direct --port {port} --detach && {} direct-info --include-secret",
        shell_quote(bin),
        shell_quote(bin)
    );
    let native = windows_native_path(bin).unwrap_or_else(|| bin.to_string());
    let quoted = powershell_quote(&native);
    let windows = format!("& {quoted} direct --port {port} --detach; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; & {quoted} direct-info --include-secret");
    (unix, windows)
}

#[tauri::command]
pub async fn direct_agent_provision(
    connection_id: String,
    port: Option<u16>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<DirectAgentInfo, String> {
    let gate = manager.server_gate(&format!("direct-config|{connection_id}"))?;
    let _guard = gate.lock().await;
    if manager.direct_config(&connection_id).is_some() {
        return Err(
            "请通过远端控制台修改服务监听端口，再导入配对信息；直连不会暗中使用 SSH".into(),
        );
    }
    let port = port.unwrap_or(qingcode_server::direct::DEFAULT_DIRECT_PORT);
    if port == 0 {
        return Err("监听端口必须为 1–65535".into());
    }
    let root = manager
        .roots_for_connection(&connection_id)
        .into_iter()
        .find(|r| r.trusted)
        .ok_or("请先连接一个已信任的 SSH 项目，或手动启动 Server 后导入配对信息")?;
    // Stage a separate executable; replacing the daemon binary can terminate
    // live terminals when a same-version build changes its content hash.
    let staged = server::stage_direct_gateway(&manager, &root).await?;
    let (unix, windows) = provision_commands(&staged, port);
    let result = manager
        .exec_remote_shell(&root.uri, &unix, &windows, true, Duration::from_secs(40))
        .await?;
    if result.exit_code != 0 {
        return Err("启动直连服务失败，请查看远端 direct 日志或检查监听端口是否被占用".into());
    }
    let descriptor: qingcode_server::direct::DirectInfo = result
        .stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .ok_or("未取得 Server 配对信息，请手动启动服务并导入")?;
    let session = manager.session(&connection_id)?;
    let host = session
        .config
        .lock()
        .map_err(|_| "SSH 配置不可用")?
        .host
        .clone();
    let records = read(&app)?;
    let mut previous = records
        .get(&connection_id)
        .map(|s| s.previous_ports.clone())
        .unwrap_or_default();
    previous.extend(descriptor.previous_ports);
    previous.sort_unstable();
    previous.dedup();
    previous.retain(|p| *p != descriptor.port);
    let saved = Saved {
        enabled: false,
        host,
        port: descriptor.port,
        certificate_fingerprint: descriptor.certificate_sha256,
        token: descriptor.token.ok_or("配对信息没有凭据")?,
        previous_ports: previous,
    };
    Ok(persist(&app, &connection_id, saved)?.info())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provisioning_converts_sftp_windows_paths_and_quotes_both_commands() {
        let (_, windows) = provision_commands("/C:/Users/O'Brien/Agent Folder/server.exe", 48763);
        assert_eq!(
            windows
                .matches("& 'C:\\Users\\O''Brien\\Agent Folder\\server.exe'")
                .count(),
            2
        );
        assert!(!windows.contains("/C:/"));
        let (unix, _) = provision_commands("/home/user/Agent Folder/server", 51234);
        assert!(
            unix.starts_with("'/home/user/Agent Folder/server' direct --port 51234 --detach &&")
        );
    }

    /// Opt-in deployment command + native TLS/WSS acceptance on an authorized host.
    /// QC_DIRECT_BIN is an already staged server; secrets never leave process memory.
    #[tokio::test]
    #[ignore = "requires authorized QC_DIRECT_HOST, QC_DIRECT_BIN and QC_SSHCTL"]
    async fn live_provision_and_native_direct_connection() {
        use qingcode_server::proto::{self, Frame, HelloRequest, Kind, PROTOCOL_VERSION};
        let host = std::env::var("QC_DIRECT_HOST").unwrap();
        let bin = std::env::var("QC_DIRECT_BIN").unwrap();
        let (unix, windows) = provision_commands(&bin, 48763);
        let command = if windows_native_path(&bin).is_some() {
            windows_encoded_powershell("powershell.exe -NoProfile -NonInteractive", &windows, false)
        } else {
            unix
        };
        let output = std::process::Command::new(std::env::var("QC_SSHCTL").unwrap())
            .args(["--insecure", "exec", &host, "--", &command])
            .output()
            .unwrap();
        assert!(output.status.success(), "remote provision command failed");
        let info: qingcode_server::direct::DirectInfo = String::from_utf8_lossy(&output.stdout)
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str::<qingcode_server::direct::DirectInfo>(line).ok())
            .expect("provision command must return pairing info");
        let config = DirectConnectionConfig {
            endpoint: endpoint(&host, info.port).unwrap(),
            certificate_fingerprint: info.certificate_sha256,
            token: info.token.expect("pairing token"),
        };
        assert_eq!(
            direct::probe(&config.endpoint).await.unwrap(),
            config.certificate_fingerprint
        );
        assert!(direct::test(&config).await.unwrap().healthy);
        let wrong_token = DirectConnectionConfig {
            token: "wrong-token".into(),
            ..config.clone()
        };
        assert!(direct::test(&wrong_token)
            .await
            .unwrap_err()
            .contains("[direct:auth]"));
        let wrong_identity = DirectConnectionConfig {
            certificate_fingerprint: "0".repeat(64),
            ..config.clone()
        };
        assert!(direct::test(&wrong_identity)
            .await
            .unwrap_err()
            .contains("[direct:identity]"));
        for _ in 0..2 {
            let mut stream = direct::open_stream_for(&config, "live-direct-acceptance")
                .await
                .unwrap();
            proto::write_frame(
                &mut stream,
                &Frame::new(
                    Kind::Hello,
                    0,
                    proto::encode(&HelloRequest {
                        client_id: "live-direct-acceptance".into(),
                        protocol_min: PROTOCOL_VERSION,
                        protocol_max: PROTOCOL_VERSION,
                        token: config.token.clone(),
                        resume_token: None,
                    })
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
            let frame =
                tokio::time::timeout(Duration::from_secs(15), proto::read_frame(&mut stream))
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(frame.kind, Kind::Hello);
            direct::close_connection(&config.endpoint, "live-direct-acceptance");
        }
        println!("LIVE_DIRECT_OK {host}:{} provision TLS health auth-rejection identity-rejection WSS reconnect", info.port);
    }

    #[test]
    fn validates_hosts_and_ipv6_endpoints() {
        assert_eq!(endpoint("::1", 48763).unwrap(), "https://[::1]:48763");
        for host in ["", "host/path", "host@evil", "host\nheader"] {
            assert!(endpoint(host, 48763).is_err());
        }
        assert!(endpoint("host", 0).is_err());
    }
}
