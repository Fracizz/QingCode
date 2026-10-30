//! Explicit SSH maintenance of a paired Windows HTTPS gateway. The SSH session
//! is isolated from workspace traffic and never replaces the direct connection.
use super::*;
use direct::DirectConnectionConfig;
use qingcode_server::direct::DirectInfo;

#[cfg(test)]
mod live_acceptance;

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn descriptor(output: &RemoteExecResult) -> Result<DirectInfo, String> {
    if output.exit_code != 0 {
        return Err("无法读取当前 SSH 用户的直连服务；更新未执行".into());
    }
    output
        .stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .ok_or_else(|| "直连服务描述无效；更新未执行".into())
}

fn check_identity(info: &DirectInfo, direct: &DirectConnectionConfig) -> Result<(), String> {
    let endpoint = url::Url::parse(&direct.endpoint).map_err(|_| "Server 地址无效")?;
    if !info
        .certificate_sha256
        .eq_ignore_ascii_case(&direct.certificate_fingerprint)
        || info.token.as_deref() != Some(direct.token.as_str())
        || Some(info.port) != endpoint.port_or_known_default()
        || info.pid == 0
    {
        return Err("SSH 用户的直连服务与当前配对身份不一致；更新未执行".into());
    }
    Ok(())
}

fn stop_script(bin: &str, info: &DirectInfo) -> String {
    format!(
        r#"$ErrorActionPreference='Stop'
$d = & {bin} direct-info | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $d.pid -ne {pid} -or $d.port -ne {port} -or $d.certificateSha256 -ne {fingerprint}) {{ throw 'Direct identity changed; retry update' }}
$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}'
$prefix = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.qingcode\server')) + '\'
if (!$p -or !$p.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($p.ExecutablePath) -notin @('qingcode-server-windows-x86_64.exe','qingcode-server-windows-aarch64.exe') -or $p.CommandLine -notmatch '\s+direct(?:\s|$)' -or $p.CommandLine -match '--state-dir') {{ throw 'Refusing to stop an unrecognized gateway' }}
$old = $p.ExecutablePath
Stop-Process -Id {pid} -ErrorAction Stop
Wait-Process -Id {pid} -Timeout 10 -ErrorAction SilentlyContinue
[Console]::WriteLine($old)
"#,
        bin = quote(bin),
        pid = info.pid,
        port = info.port,
        fingerprint = quote(&info.certificate_sha256)
    )
}

fn start_script(bin: &str, info: &DirectInfo) -> String {
    format!("& {} direct --hostname {} --port {} --detach; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}",
        quote(bin), quote(&info.hostname), info.port)
}

async fn execute(
    manager: &SshManager,
    root: &RegisteredRoot,
    script: &str,
) -> Result<RemoteExecResult, String> {
    let result = manager
        .exec_remote_shell(&root.uri, "false", script, true, Duration::from_secs(40))
        .await?;
    if result.exit_code != 0 {
        return Err(format!("直连服务更新命令失败：{}", result.stderr.trim()));
    }
    Ok(result)
}

async fn update_over_ssh(
    source: &SshManager,
    root: &RegisteredRoot,
    config: SshConnectionConfig,
    direct: &DirectConnectionConfig,
) -> Result<(), String> {
    if windows_native_path(&root.canonical_path).is_none() {
        return Err("通过 SSH 更新直连服务目前仅支持 Windows；请在远端手动更新 Server".into());
    }
    let maintenance = SshManager::new();
    maintenance.set_server_binary_dirs(source.server_binary_dirs_for_root(&root.uri));
    maintenance.server_auto_download.store(
        source.server_auto_download_for_root(&root.uri),
        Ordering::SeqCst,
    );
    if let Ok(mut cache) = maintenance.server_cache_dir.write() {
        *cache = source
            .server_cache_dir
            .read()
            .ok()
            .and_then(|value| value.clone());
    }
    let id = config.id.clone();
    let (session, _) = store_authenticated_session(&maintenance, config).await?;
    let result = async {
        let sftp = maintenance.open_sftp(&id).await?;
        let canonical = sftp
            .canonicalize(parse_remote_uri(&root.uri)?.path)
            .await
            .map_err(|e| e.to_string())?;
        if !server::remote_roots_equivalent(&canonical, &root.canonical_path, true) {
            return Err("SSH 项目目录与当前直连项目不一致；更新未执行".into());
        }
        reject_windows_sftp_links(&sftp, &canonical).await?;
        let management_root = RegisteredRoot {
            uri: format!("ssh://{id}{canonical}"),
            canonical_path: canonical,
            trusted: true,
        };
        maintenance
            .roots
            .write()
            .map_err(|_| "SSH 状态不可用")?
            .insert(management_root.uri.clone(), management_root.clone());
        // Reuse the client-side manifest/digest checks and atomic SFTP upload.
        // No target-host download, running executable replacement, or broad kill.
        let staged = server::stage_direct_gateway(&maintenance, &management_root).await?;
        let native = windows_native_path(&staged).ok_or("Windows Server 路径无效")?;
        let read = execute(
            &maintenance,
            &management_root,
            &format!("& {} direct-info --include-secret", quote(&native)),
        )
        .await?;
        let info = descriptor(&read)?;
        check_identity(&info, direct)?;
        let current = source.registered_root(&root.uri)?;
        if !current.trusted || current.canonical_path != root.canonical_path {
            return Err("项目授权已变化；更新未执行".into());
        }
        // Stop only the descriptor's gateway. The existing version-aware daemon
        // handover authenticates the old daemon before requesting its shutdown.
        let stopped = execute(&maintenance, &management_root, &stop_script(&native, &info)).await?;
        let previous = stopped
            .stdout
            .lines()
            .last()
            .ok_or("未取得原服务路径")?
            .trim();
        let replaced = async {
            server::ensure_remote_daemon(&maintenance, &id, &management_root, &staged).await?;
            execute(
                &maintenance,
                &management_root,
                &start_script(&native, &info),
            )
            .await?;
            let health = direct::test(direct).await?;
            direct::require_current_version(&health)?;
            let read = execute(
                &maintenance,
                &management_root,
                &format!("& {} direct-info --include-secret", quote(&native)),
            )
            .await?;
            check_identity(&descriptor(&read)?, direct)
        }
        .await;
        if let Err(reason) = &replaced {
            let restored = execute(
                &maintenance,
                &management_root,
                &start_script(previous, &info),
            )
            .await;
            if restored.is_err() {
                return Err(format!(
                    "{}；原直连服务恢复启动失败，请通过 SSH 检查远端服务",
                    reason
                ));
            }
        }
        replaced
    }
    .await;
    // The temporary authenticated session owns no user workspace or terminals.
    let _ = session
        .handle
        .disconnect(Disconnect::ByApplication, "maintenance finished", "en")
        .await;
    result
}

#[tauri::command]
pub async fn direct_agent_update(
    root_uri: String,
    ssh_connection_id: String,
    config: SshConnectionConfig,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<server_status::SshServerState, String> {
    let root = server_status::require_trusted_root(&manager, &root_uri)?;
    let id = parse_remote_uri(&root.uri)?.connection_id;
    let gate = manager.server_gate(&format!("direct-config|{id}"))?;
    let _guard = gate.lock().await;
    let direct = manager
        .direct_config(&id)
        .ok_or("此连接不是 Server 端口直连")?;
    let config = direct_firewall::management_config(
        &manager,
        &id,
        Some(&ssh_connection_id),
        Some(config),
        None,
    )?;
    for bound in manager.roots_for_connection(&id) {
        manager.stop_watch_supervisor(&server::server_slot_key(&id, &bound.canonical_path));
    }
    let result = update_over_ssh(&manager, &root, config, &direct).await;
    direct::close_connection(&direct.endpoint, &id);
    for bound in manager.roots_for_connection(&id) {
        manager.clear_server_endpoint(&server::server_slot_key(&id, &bound.canonical_path));
        manager.start_workspace_watch(app.clone(), &bound);
        server_status::publish_root_state(&app, &manager, &bound);
    }
    result?;
    server::ensure_server_endpoint_with_app(&manager, &root, Some(&app)).await?;
    server_status::state_for_root(&manager, &root)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_another_user_or_gateway_before_stopping_processes() {
        let direct = DirectConnectionConfig {
            endpoint: "https://host:48763".into(),
            certificate_fingerprint: "a".repeat(64),
            token: "secret".into(),
        };
        let mut info = DirectInfo {
            hostname: "0.0.0.0".into(),
            port: 48763,
            certificate_sha256: "a".repeat(64),
            server_version: "old".into(),
            protocol: 1,
            pid: 123,
            previous_ports: vec![],
            token: Some("secret".into()),
        };
        assert!(check_identity(&info, &direct).is_ok());
        info.token = Some("other".into());
        assert!(check_identity(&info, &direct).is_err());
        info.token = Some("secret".into());
        info.port = 51234;
        assert!(check_identity(&info, &direct).is_err());
        info.port = 48763;
        info.certificate_sha256 = "b".repeat(64);
        assert!(check_identity(&info, &direct).is_err());
    }
}
