//! Explicit SSH control of a paired gateway, including when no workspace can
//! connect. The temporary session only stages user-private binaries and changes
//! the paired user's boot registration; it grants no project trust.
use super::*;

fn descriptor(output: &RemoteExecResult) -> Result<qingcode_server::direct::DirectInfo, String> {
    if output.exit_code != 0 {
        return Err("[direct:identity] 无法读取此 SSH 用户的 Server 配对信息，未启动服务".into());
    }
    output
        .stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .ok_or("[direct:identity] 无法核对 Server 配对身份，未启动服务".into())
}

fn check_identity(
    info: &qingcode_server::direct::DirectInfo,
    config: &direct::DirectConnectionConfig,
) -> Result<(), String> {
    let url = url::Url::parse(&config.endpoint).map_err(|_| "[direct:identity] Server 地址无效")?;
    if !info
        .certificate_sha256
        .eq_ignore_ascii_case(&config.certificate_fingerprint)
        || info.token.as_deref() != Some(config.token.as_str())
        || Some(info.port) != url.port_or_known_default()
    {
        return Err(
            "[direct:identity] 此 SSH 用户的配对信息与 Server 不一致，请核对远端账户；未修改服务"
                .into(),
        );
    }
    Ok(())
}

fn start_commands(bin: &str, info: &qingcode_server::direct::DirectInfo) -> (String, String) {
    let native = windows_native_path(bin).unwrap_or_else(|| bin.to_string());
    let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
    (
        format!("{} direct --hostname {} --port {} --detach && {} direct-info --include-secret", shell_quote(bin), shell_quote(&info.hostname), info.port, shell_quote(bin)),
        format!("& {} direct --hostname {} --port {} --detach; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; & {} direct-info --include-secret", quote(&native), quote(&info.hostname), info.port, quote(&native)),
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn direct_agent_manage(
    connection_id: String,
    ssh_connection_id: String,
    config: SshConnectionConfig,
    agent_host: String,
    port: u16,
    auto_start: bool,
    start: bool,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<direct_settings::DirectAgentInfo, String> {
    let gate = manager.server_gate(&format!("direct-config|{connection_id}"))?;
    let _guard = gate.lock().await;
    let paired = direct_settings::paired_config(&app, &connection_id)?;
    let expected =
        url::Url::parse(&paired.endpoint).map_err(|_| "[direct:identity] Server 地址无效")?;
    if port == 0 || expected.port_or_known_default() != Some(port) {
        return Err("[direct:identity] 请使用已保存的 Server 端口启动服务".into());
    }
    let config = direct_firewall::management_config(
        &manager,
        &connection_id,
        Some(&ssh_connection_id),
        Some(config),
        Some(&agent_host),
    )?;
    // management_config also handles disabled profiles, but they still must
    // match the persisted paired host before any remote authentication.
    if expected.host_str().map(|h| {
        h.trim_matches(['[', ']'])
            .trim_end_matches('.')
            .to_ascii_lowercase()
    }) != Some(
        config
            .host
            .trim_matches(['[', ']'])
            .trim_end_matches('.')
            .to_ascii_lowercase(),
    ) {
        return Err("[direct:ssh-identity] SSH 主机与已保存的 Server 主机不一致".into());
    }
    let maintenance = manager.maintenance_manager();
    let id = config.id.clone();
    let (session, _) = store_authenticated_session(&maintenance, config)
        .await
        .map_err(|error| {
            if error.contains("指纹") || error.contains("host key") {
                format!("[direct:ssh-identity] {error}")
            } else {
                format!("[direct:ssh-auth] {error}")
            }
        })?;
    let result = async {
        let sftp = maintenance.open_sftp(&id).await?;
        let home = sftp.canonicalize(".").await.map_err(|e| e.to_string())?;
        reject_windows_sftp_links(&sftp, &home).await?;
        let root = RegisteredRoot {
            uri: format!("ssh://{id}{home}"),
            canonical_path: home,
            trusted: true,
        };
        maintenance
            .roots
            .write()
            .map_err(|_| "SSH 状态不可用")?
            .insert(root.uri.clone(), root.clone());
        let staged = server::stage_direct_gateway(&maintenance, &root).await?;
        let execute = |unix: String, windows: String| {
            let maintenance = &maintenance;
            let uri = &root.uri;
            async move {
                maintenance
                    .exec_remote_shell(uri, &unix, &windows, true, Duration::from_secs(60))
                    .await
            }
        };
        let native = windows_native_path(&staged).unwrap_or_else(|| staged.clone());
        let quoted = format!("'{}'", native.replace('\'', "''"));
        let read = execute(
            format!("{} direct-info --include-secret", shell_quote(&staged)),
            format!("& {quoted} direct-info --include-secret"),
        )
        .await?;
        let existing = descriptor(&read)?;
        check_identity(&existing, &paired)?;
        if start {
            let (unix, windows) = start_commands(&staged, &existing);
            let output = execute(unix, windows).await?;
            check_identity(&descriptor(&output)?, &paired)?;
        }
        let action = if auto_start { "enable" } else { "disable" };
        let (unix, windows) = direct_settings::startup_commands(&staged, action);
        let startup_warning =
            direct_settings::startup_outcome(action, execute(unix, windows).await)?;
        let mut info = direct_settings::record_startup(
            &app,
            &connection_id,
            auto_start && startup_warning.is_none(),
        )?;
        info.startup_warning = startup_warning;
        if start {
            direct::test(&paired).await?;
        }
        Ok(info)
    }
    .await;
    let _ = session
        .handle
        .disconnect(Disconnect::ByApplication, "Server lifecycle finished", "en")
        .await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_wrong_account_pairing_or_port_without_mutating_server() {
        let config = direct::DirectConnectionConfig {
            endpoint: "https://host:48763".into(),
            certificate_fingerprint: "a".repeat(64),
            token: "secret".into(),
            tunnel: None,
        };
        let mut info = qingcode_server::direct::DirectInfo {
            hostname: "0.0.0.0".into(),
            port: 48763,
            certificate_sha256: "a".repeat(64),
            server_version: "test".into(),
            protocol: 1,
            pid: 123,
            token: Some("secret".into()),
            previous_ports: vec![],
        };
        assert!(check_identity(&info, &config).is_ok());
        info.token = Some("another-user".into());
        assert!(check_identity(&info, &config).is_err());
        info.token = Some("secret".into());
        info.port = 51234;
        assert!(check_identity(&info, &config).is_err());
        info.hostname = "127.0.0.1".into();
        let (unix, windows) = start_commands("/C:/Users/O'Brien/server.exe", &info);
        assert!(unix.contains("--hostname '127.0.0.1' --port 51234"));
        assert!(windows.contains("--hostname '127.0.0.1' --port 51234"));
        assert!(windows.contains("O''Brien"));
    }
}
