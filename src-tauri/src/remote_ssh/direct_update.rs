//! SSH maintenance of a paired HTTPS gateway. The SSH session
//! is isolated from workspace traffic and never replaces the direct connection.
use super::*;
use direct::DirectConnectionConfig;
use qingcode_server::direct::DirectInfo;
use tauri::ipc::Channel;
mod packages;
pub use packages::*;
use packages::{configure_package_source, management_root, progress};

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
$state = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.qingcode\server\run'))
$customState = $p -and $p.CommandLine -match '--state-dir' -and $p.CommandLine -notmatch ('--state-dir\s+"?' + [regex]::Escape($state) + '"?\s*$')
if (!$p -or !$p.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($p.ExecutablePath) -notin @('qingcode-server-windows-x86_64.exe','qingcode-server-windows-aarch64.exe') -or $p.CommandLine -notmatch '\s+direct(?:\s|$)' -or $customState) {{ throw 'Refusing to stop an unrecognized gateway' }}
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

fn read_commands(bin: &str) -> (String, String) {
    let native = windows_native_path(bin).unwrap_or_else(|| bin.into());
    (
        format!("{} direct-info --include-secret", shell_quote(bin)),
        format!("& {} direct-info --include-secret", quote(&native)),
    )
}

fn start_commands(bin: &str, info: &DirectInfo) -> (String, String) {
    let native = windows_native_path(bin).unwrap_or_else(|| bin.into());
    (
        format!(
            "{} direct --hostname {} --port {} --detach",
            shell_quote(bin),
            shell_quote(&info.hostname),
            info.port
        ),
        start_script(&native, info),
    )
}

fn stop_commands(bin: &str, info: &DirectInfo) -> (String, String) {
    let native = windows_native_path(bin).unwrap_or_else(|| bin.into());
    (
        format!(
            "{} direct-stop --expect-pid {} --expect-port {} --expect-certificate {}",
            shell_quote(bin),
            info.pid,
            info.port,
            shell_quote(&info.certificate_sha256)
        ),
        stop_script(&native, info),
    )
}

async fn execute_commands(
    manager: &SshManager,
    root: &RegisteredRoot,
    commands: (String, String),
) -> Result<RemoteExecResult, String> {
    let result = manager
        .exec_remote_shell(
            &root.uri,
            &commands.0,
            &commands.1,
            true,
            Duration::from_secs(40),
        )
        .await?;
    if result.exit_code != 0 {
        return Err(format!("直连服务更新命令失败：{}", result.stderr.trim()));
    }
    Ok(result)
}

#[cfg(test)]
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
    auto_start: bool,
    package_directory: Option<&str>,
    on_progress: Option<&Channel<String>>,
) -> Result<(), String> {
    let maintenance = SshManager::new();
    progress(on_progress, "checkingPackage");
    let directory = match package_directory {
        Some(directory) => Some(packages::checked_directory(directory).await?),
        None => None,
    };
    configure_package_source(&maintenance, source, root, directory);
    // Staging must never download. Background preparation below is explicit.
    maintenance
        .server_auto_download
        .store(false, Ordering::SeqCst);
    progress(on_progress, "connecting");
    let id = config.id.clone();
    let (session, _) = store_authenticated_session(&maintenance, config).await?;
    let result = async {
        let management_root = management_root(&maintenance, root, &id).await?;
        let mut package =
            server::recovery::package_info(&maintenance, &management_root.uri, package_directory)
                .await?;
        // Background callers retain their saved policy. An explicitly selected
        // directory can never fall back to the network or other local packages.
        if package_directory.is_none()
            && package.problem.is_some()
            && source.server_auto_download_for_root(&root.uri)
        {
            progress(on_progress, "downloading");
            package =
                server::recovery::download_package(&maintenance, &management_root.uri).await?;
        }
        if let Some(directory) = &package.directory {
            maintenance.set_server_binary_dirs(vec![PathBuf::from(directory)]);
        }
        if let Some(problem) = package.problem {
            return Err(problem);
        }
        progress(on_progress, "uploading");
        // Reuse the client-side manifest/digest checks and atomic SFTP upload.
        // No target-host download, running executable replacement, or broad kill.
        let staged = server::stage_direct_gateway(&maintenance, &management_root).await?;
        let read = execute_commands(&maintenance, &management_root, read_commands(&staged)).await?;
        let info = descriptor(&read)?;
        check_identity(&info, direct)?;
        let current = source.registered_root(&root.uri)?;
        if !current.trusted || current.canonical_path != root.canonical_path {
            return Err("项目授权已变化；更新未执行".into());
        }
        // Stop only the descriptor's gateway. PTYs live in the daemon, not the
        // gateway: an outdated daemon that still hosts running terminals is kept
        // (the new gateway reaches it over local IPC) and retired by the client
        // once idle; an idle one is authenticated and shut down right away.
        progress(on_progress, "restarting");
        let stopped = execute_commands(
            &maintenance,
            &management_root,
            stop_commands(&staged, &info),
        )
        .await?;
        let previous = stopped
            .stdout
            .lines()
            .last()
            .ok_or("未取得原服务路径")?
            .trim();
        let replaced = async {
            server::ensure_remote_daemon(
                &maintenance,
                &id,
                &management_root,
                &staged,
                server::StaleDaemon::DeferWhileBusy,
            )
            .await?;
            execute_commands(
                &maintenance,
                &management_root,
                start_commands(&staged, &info),
            )
            .await?;
            progress(on_progress, "verifying");
            let health = direct::test(direct).await?;
            direct::require_current_version(&health)?;
            let read =
                execute_commands(&maintenance, &management_root, read_commands(&staged)).await?;
            check_identity(&descriptor(&read)?, direct)?;
            if auto_start {
                execute_commands(
                    &maintenance,
                    &management_root,
                    direct_settings::startup_commands(&staged, "enable"),
                )
                .await?;
            }
            Ok(())
        }
        .await;
        if let Err(reason) = &replaced {
            progress(on_progress, "restoring");
            // A new gateway may already be running when health/startup fails.
            // Stop only that paired gateway before restoring the old binary.
            if let Ok(read) =
                execute_commands(&maintenance, &management_root, read_commands(&staged)).await
            {
                if let Ok(current) = descriptor(&read) {
                    if check_identity(&current, direct).is_ok() && current.pid != info.pid {
                        let _ = execute_commands(
                            &maintenance,
                            &management_root,
                            stop_commands(&staged, &current),
                        )
                        .await;
                    }
                }
            }
            let restored = execute_commands(
                &maintenance,
                &management_root,
                start_commands(previous, &info),
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedUpdateOptions {
    package_directory: String,
    on_progress: tauri::ipc::JavaScriptChannelId,
}

#[tauri::command]
pub async fn direct_agent_update(
    root_uri: String,
    ssh_connection_id: String,
    config: SshConnectionConfig,
    options: Option<PreparedUpdateOptions>,
    webview: tauri::Webview,
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
    let on_progress = options
        .as_ref()
        .map(|options| options.on_progress.channel_on(webview));
    let package_directory = options
        .as_ref()
        .map(|options| options.package_directory.as_str());
    let auto_start = direct_settings::startup_enabled(&app, &id)?;
    for bound in manager.roots_for_connection(&id) {
        manager.stop_watch_supervisor(&server::server_slot_key(&id, &bound.canonical_path));
    }
    let result = update_over_ssh(
        &manager,
        &root,
        config,
        &direct,
        auto_start,
        package_directory,
        on_progress.as_ref(),
    )
    .await;
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
