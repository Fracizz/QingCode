//! Explicit SSH management action. Agent data traffic never falls back to SSH.
use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

const SCRIPT: &str = include_str!("direct_firewall.ps1");
const LIMIT: usize = 256 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectFirewallPlan {
    pub host: String,
    pub ssh_port: u16,
    pub username: String,
    pub host_fingerprint: String,
    pub port: u16,
    pub client_address: String,
    pub local_address: String,
    pub network_category: String,
    pub interface_alias: String,
    pub account: String,
    pub profiles: Vec<String>,
    pub rule_name: String,
    pub already_enabled: bool,
    pub can_apply: bool,
    pub reason: Option<String>,
    pub plan_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectFirewallResult {
    pub changed: bool,
    pub rule_name: String,
    pub port: u16,
    pub client_address: String,
    pub local_address: String,
    pub profiles: Vec<String>,
}

fn normalized_host(value: &str) -> String {
    value
        .trim()
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase()
}
fn validate_port(port: u16) -> Result<(), String> {
    if port == 0 {
        Err("[direct:firewall] TCP 端口必须为 1–65535".into())
    } else {
        Ok(())
    }
}
fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("[direct:firewall-stale] 放行计划无效，请重新检查".into());
    }
    Ok(())
}

fn management_config(
    manager: &SshManager,
    connection_id: &str,
    ssh_id: Option<&str>,
    provided: Option<SshConnectionConfig>,
    agent_host: Option<&str>,
) -> Result<SshConnectionConfig, String> {
    let ssh_id = ssh_id.unwrap_or(connection_id);
    let cached = manager
        .session(ssh_id)
        .ok()
        .and_then(|session| session.config.lock().ok().map(|c| c.clone()));
    let mut config = provided
        .or_else(|| cached.clone())
        .ok_or("[direct:ssh-auth] 请先选择已保存的 SSH 连接并提供本次授权凭据")?;
    if config.id != ssh_id {
        return Err("[direct:ssh-identity] SSH 连接与所选授权记录不一致".into());
    }
    let direct_host = manager
        .direct_config(connection_id)
        .map(|c| {
            url::Url::parse(&c.endpoint)
                .map_err(|_| "[direct:ssh-identity] Server 地址无效")
                .and_then(|u| {
                    u.host_str()
                        .map(str::to_string)
                        .ok_or("[direct:ssh-identity] Server 地址无效")
                })
        })
        .transpose()?;
    let expected = direct_host
        .as_deref()
        .or(agent_host)
        .ok_or("[direct:ssh-identity] 请先确定 Server 主机地址")?;
    if normalized_host(expected) != normalized_host(&config.host)
        || agent_host.is_some_and(|host| normalized_host(host) != normalized_host(expected))
    {
        return Err("[direct:ssh-identity] SSH 授权主机必须与当前 Server 主机一致；不支持自动推断别名或端口映射目标".into());
    }
    if config
        .host_key_fingerprint
        .as_deref()
        .is_none_or(|p| p.trim().is_empty())
    {
        return Err("[direct:ssh-identity] 请先测试 SSH 连接并确认主机指纹".into());
    }
    if let Some(previous) = cached {
        if require_matching_session_config(&previous, &config).is_ok() {
            if config.password.is_none() {
                config.password = previous.password;
            }
            if config.passphrase.is_none() {
                config.passphrase = previous.passphrase;
            }
        }
    }
    config.mode = None;
    Ok(config)
}

fn management_identity(config: &SshConnectionConfig) -> String {
    let identity = serde_json::json!([
        config.id,
        normalized_host(&config.host),
        config.port,
        config.username,
        config.host_key_fingerprint
    ]);
    format!("{:x}", Sha256::digest(identity.to_string().as_bytes()))
}

fn command(port: u16, expected: Option<&str>, identity: &str) -> Result<(String, String), String> {
    validate_port(port)?;
    validate_hash(identity)?;
    if let Some(hash) = expected {
        validate_hash(hash)?;
    }
    let operation = format!(
        "Invoke-QcFirewall {port} '{}' ${} '{identity}'",
        expected.unwrap_or(""),
        if expected.is_some() { "true" } else { "false" }
    );
    let script=format!("try{{\n{SCRIPT}\n{operation}|ConvertTo-Json -Depth 12 -Compress\n}}catch{{[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);[ordered]@{{ok=$false;code='[direct:firewall]';message='远端防火墙检查或操作失败，请检查管理员权限与服务状态。'}}|ConvertTo-Json -Compress;exit 1}}");
    let input = encode_terminal_data(script.as_bytes());
    // Read exactly the announced ASCII payload length. ReadToEnd waits forever under
    // some Windows Git Bash default shells, which do not forward stdin EOF.
    let bootstrap=format!("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$a=New-Object char[] {}; $i=0;while($i -lt $a.Length){{$n=[Console]::In.Read($a,$i,$a.Length-$i);if($n -le 0){{throw 'Incomplete SSH payload'}};$i+=$n}};Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((-join $a))))",input.len());
    let command = windows_powershell_inline_command(&bootstrap)
        .ok_or("[direct:firewall] 远端授权脚本超过 Windows 命令行限制")?;
    Ok((command, input))
}

async fn execute(
    config: SshConnectionConfig,
    port: u16,
    expected: Option<&str>,
) -> Result<(Value, String), String> {
    let (command, input) = command(port, expected, &management_identity(&config))?;
    let (session, fingerprint) = authenticate_session(config, ConnectionPurpose::Main)
        .await
        .map_err(|error| {
            if error.contains("指纹") || error.contains("fingerprint") || error.contains("host key")
            {
                format!("[direct:ssh-identity] {error}")
            } else {
                format!("[direct:ssh-auth] {error}")
            }
        })?;
    let action = async {
        let mut channel = open_session_channel_once(&session, "Server 防火墙授权")
            .await
            .map_err(|error| error.message)?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut code = None;
        let result = tokio::time::timeout(Duration::from_secs(35), async {
            channel
                .exec(true, command.as_bytes())
                .await
                .map_err(|_| "[direct:firewall] 无法执行 SSH 授权检查")?;
            channel
                .data(input.as_bytes())
                .await
                .map_err(|_| "[direct:firewall] 无法发送 SSH 授权检查脚本")?;
            channel
                .eof()
                .await
                .map_err(|_| "[direct:firewall] 无法结束 SSH 授权请求")?;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    _ => {}
                }
                if stdout.len() + stderr.len() > LIMIT {
                    return Err("[direct:firewall] 远端响应过大".into());
                }
            }
            let value: Value = serde_json::from_slice(&stdout).map_err(|_| {
                if code == Some(127) {
                    "[direct:firewall-unsupported] 该主机不支持 Windows PowerShell 防火墙授权"
                        .to_string()
                } else {
                    "[direct:firewall] 远端未返回有效的防火墙检查结果".to_string()
                }
            })?;
            if value.get("ok").and_then(Value::as_bool) != Some(true) {
                let code = value["code"].as_str().unwrap_or("[direct:firewall]");
                let message = value["message"].as_str().unwrap_or("远端防火墙操作失败");
                return Err(format!("{code} {message}"));
            }
            Ok::<Value, String>(value["value"].clone())
        })
        .await
        .map_err(|_| {
            "[direct:firewall] SSH 防火墙授权操作超时，规则状态未知，请重新检查".to_string()
        })?;
        let _ = channel.close().await;
        result
    }
    .await;
    let _ = session
        .handle
        .disconnect(
            Disconnect::ByApplication,
            "QingCode firewall authorization complete",
            "en",
        )
        .await;
    action.map(|value| (value, fingerprint))
}

#[tauri::command]
pub async fn direct_agent_firewall_plan(
    connection_id: String,
    port: u16,
    ssh_connection_id: Option<String>,
    config: Option<SshConnectionConfig>,
    agent_host: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<DirectFirewallPlan, String> {
    validate_port(port)?;
    let config = management_config(
        &manager,
        &connection_id,
        ssh_connection_id.as_deref(),
        config,
        agent_host.as_deref(),
    )?;
    let host = config.host.clone();
    let ssh_port = config.port;
    let username = config.username.clone();
    let (mut plan, fingerprint) = execute(config, port, None).await?;
    plan["host"] = serde_json::json!(host);
    plan["sshPort"] = serde_json::json!(ssh_port);
    plan["username"] = serde_json::json!(username);
    plan["hostFingerprint"] = serde_json::json!(fingerprint);
    serde_json::from_value(plan).map_err(|_| "[direct:firewall] 防火墙计划格式无效".into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn direct_agent_firewall_apply(
    connection_id: String,
    port: u16,
    expected_plan_sha256: String,
    ssh_connection_id: Option<String>,
    config: Option<SshConnectionConfig>,
    agent_host: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<DirectFirewallResult, String> {
    validate_port(port)?;
    validate_hash(&expected_plan_sha256)?;
    let config = management_config(
        &manager,
        &connection_id,
        ssh_connection_id.as_deref(),
        config,
        agent_host.as_deref(),
    )?;
    let (result, _) = execute(config, port, Some(&expected_plan_sha256)).await?;
    serde_json::from_value(result).map_err(|_| "[direct:firewall] 防火墙操作结果格式无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> SshConnectionConfig {
        SshConnectionConfig {
            id: "ssh".into(),
            host: "server.example".into(),
            port: 28822,
            username: "Administrator".into(),
            auth_kind: "password".into(),
            password: Some("secret-not-in-script".into()),
            private_key_path: None,
            passphrase: None,
            host_key_fingerprint: Some("SHA256:confirmed".into()),
            mode: None,
        }
    }
    #[test]
    fn rejects_unconfirmed_wrong_host_and_wrong_record_before_authentication() {
        let manager = SshManager::new();
        let config = sample();
        assert!(management_config(
            &manager,
            "agent",
            Some("ssh"),
            Some(config.clone()),
            Some("other.example")
        )
        .is_err());
        assert!(management_config(
            &manager,
            "agent",
            Some("different"),
            Some(config.clone()),
            Some("server.example")
        )
        .is_err());
        let mut missing = config;
        missing.host_key_fingerprint = None;
        assert!(management_config(
            &manager,
            "agent",
            Some("ssh"),
            Some(missing),
            Some("server.example")
        )
        .is_err());
    }
    #[test]
    fn edited_agent_host_cannot_override_configured_agent_identity() {
        let manager = SshManager::new();
        manager.direct_connections.write().unwrap().insert(
            "agent".into(),
            direct::DirectConnectionConfig {
                endpoint: "https://server.example:48763".into(),
                certificate_fingerprint: "a".repeat(64),
                token: "agent-secret".into(),
            },
        );
        let mut config = sample();
        config.host = "other.example".into();
        assert!(management_config(
            &manager,
            "agent",
            Some("ssh"),
            Some(config),
            Some("other.example")
        )
        .is_err());
        assert!(management_config(
            &manager,
            "agent",
            Some("ssh"),
            Some(sample()),
            Some("other.example")
        )
        .is_err());
        assert!(management_config(
            &manager,
            "agent",
            Some("ssh"),
            Some(sample()),
            Some("server.example")
        )
        .is_ok());
    }
    #[test]
    fn fixed_length_stdin_script_fits_cmd_limit_without_waiting_for_eof() {
        let (encoded_command, input) = command(
            48763,
            Some(&"a".repeat(64)),
            &management_identity(&sample()),
        )
        .unwrap();
        assert!(encoded_command.len() < WINDOWS_INLINE_COMMAND_LIMIT);
        assert!(!encoded_command.contains("secret-not-in-script"));
        assert!(!input.contains("secret-not-in-script"));
        assert!(!encoded_command.contains("ReadToEnd"));
        assert!(command(0, None, &management_identity(&sample())).is_err());
        assert!(super::command(
            48763,
            Some("x'; Remove-NetFirewallRule"),
            &management_identity(&sample())
        )
        .is_err());
    }
    #[test]
    fn confirmation_binds_ssh_host_port_account_and_fingerprint() {
        let config = sample();
        let expected = management_identity(&config);
        let mut changed = config.clone();
        changed.host = "other.example".into();
        assert_ne!(expected, management_identity(&changed));
        let mut changed = config.clone();
        changed.port += 1;
        assert_ne!(expected, management_identity(&changed));
        let mut changed = config.clone();
        changed.username = "other".into();
        assert_ne!(expected, management_identity(&changed));
        let mut changed = config.clone();
        changed.host_key_fingerprint = Some("SHA256:different".into());
        assert_ne!(expected, management_identity(&changed));
        let mut changed = config;
        changed.password = Some("changed-secret".into());
        assert_eq!(expected, management_identity(&changed));
        assert!(SCRIPT.contains("$identity + \"`n\""));
    }
    #[test]
    fn rule_plan_is_scoped_and_does_not_restart_or_delete_services() {
        assert!(SCRIPT.contains("-RemoteAddress $plan.clientAddress -LocalAddress $plan.localAddress -Profile $plan.profiles"));
        for forbidden in [
            "Remove-NetFirewallRule",
            "Set-NetFirewallRule",
            "Restart-Service",
            "Stop-Service",
            "-Profile Any",
            "-RemoteAddress Any",
        ] {
            assert!(!SCRIPT.contains(forbidden), "{forbidden}");
        }
        assert!(SCRIPT.contains("if ($hash -ne $expected)"));
    }
}
