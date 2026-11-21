//! Explicit SSH management action. Agent data traffic never falls back to SSH.
use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

const SCRIPT: &str = include_str!("direct_firewall.ps1");
const LINUX_SCRIPT: &str = include_str!("direct_firewall.sh");
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

pub(super) fn management_config(
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
    // Server 模式的隧道登记指向远端回环地址，不是用户配置的 Server 主机，不参与比对。
    let direct_host = manager
        .direct_config(connection_id)
        .filter(|c| c.tunnel.is_none())
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

/// Linux：脚本经 base64 放在命令行里，stdin 只留给 sudo 读密码；非 root 时用
/// `sudo -S`，免密 sudo 不读 stdin，密码行原样丢弃，不会被当作命令执行。
fn linux_command(port: u16, expected: Option<&str>, identity: &str) -> Result<String, String> {
    validate_port(port)?;
    validate_hash(identity)?;
    if let Some(hash) = expected {
        validate_hash(hash)?;
    }
    // Windows 检出（autocrlf）可能把脚本转成 CRLF，sh 会把 CR 当作命令的一部分。
    let script = encode_terminal_data(LINUX_SCRIPT.replace("\r\n", "\n").as_bytes());
    let args = format!(
        "qc {port} \"{}\" {} {identity} \"$C\" \"$U\"",
        expected.unwrap_or(""),
        u8::from(expected.is_some())
    );
    Ok(format!(
        "sh -c 'S=$(printf %s {script} | base64 -d) || exit 127; C=$SSH_CONNECTION; U=$(id -un); if [ \"$(id -u)\" = 0 ]; then sh -c \"$S\" {args}; else sudo -S -p \"\" sh -c \"$S\" {args} || printf \"%s\\n\" \"{{\\\"ok\\\":false,\\\"code\\\":\\\"[direct:firewall-admin]\\\",\\\"message\\\":\\\"sudo\\\"}}\"; fi'"
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteOs {
    Windows,
    Linux,
}

/// `uname -s` 只在类 Unix shell 下有输出；Windows 的 cmd/PowerShell 报错，
/// Git Bash 输出 MINGW*，都按 Windows 处理。macOS 暂不支持自动放行。
fn remote_os(uname: &str) -> Result<RemoteOs, String> {
    match uname.trim() {
        "Linux" => Ok(RemoteOs::Linux),
        "Darwin" => Err("[direct:firewall-unsupported] macOS 暂不支持通过 SSH 自动放行".into()),
        _ => Ok(RemoteOs::Windows),
    }
}

async fn run_channel(
    session: &ConnectedSession,
    command: &str,
    input: &[u8],
    timeout: Duration,
) -> Result<(Vec<u8>, Option<u32>), String> {
    let mut channel = open_session_channel_once(session, "Server 防火墙授权")
        .await
        .map_err(|error| error.message)?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = None;
    let result = tokio::time::timeout(timeout, async {
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|_| "[direct:firewall] 无法执行 SSH 授权检查")?;
        if !input.is_empty() {
            channel
                .data(input)
                .await
                .map_err(|_| "[direct:firewall] 无法发送 SSH 授权检查脚本")?;
        }
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
                return Err("[direct:firewall] 远端响应过大".to_string());
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| "[direct:firewall] SSH 防火墙授权操作超时，规则状态未知，请重新检查".to_string());
    let _ = channel.close().await;
    result??;
    Ok((stdout, code))
}

fn parse_result(stdout: &[u8], code: Option<u32>, os: RemoteOs) -> Result<Value, String> {
    // Linux 的 sudo 失败兜底行可能跟在其他输出后，取最后一行 JSON。
    let text = String::from_utf8_lossy(stdout);
    let value: Value = text
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line.trim()).ok())
        .ok_or_else(|| {
            if code == Some(127) {
                match os {
                    RemoteOs::Windows => {
                        "[direct:firewall-unsupported] 该主机不支持 Windows PowerShell 防火墙授权"
                    }
                    RemoteOs::Linux => {
                        "[direct:firewall-unsupported] 该主机缺少 base64/sh，无法自动放行"
                    }
                }
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
    Ok(value["value"].clone())
}

async fn execute(
    config: SshConnectionConfig,
    port: u16,
    expected: Option<&str>,
) -> Result<(Value, String), String> {
    let identity = management_identity(&config);
    // 只有密码登录时才把同一密码交给 sudo；私钥口令不是系统密码。
    let sudo_password = (config.auth_kind == "password")
        .then(|| config.password.clone())
        .flatten();
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
        let (uname, _) = run_channel(&session, "uname -s", &[], Duration::from_secs(10)).await?;
        let os = remote_os(&String::from_utf8_lossy(&uname))?;
        let (stdout, code) = match os {
            RemoteOs::Windows => {
                let (command, input) = command(port, expected, &identity)?;
                run_channel(
                    &session,
                    &command,
                    input.as_bytes(),
                    Duration::from_secs(35),
                )
                .await?
            }
            RemoteOs::Linux => {
                let command = linux_command(port, expected, &identity)?;
                let input = sudo_password
                    .as_deref()
                    .map(|password| format!("{password}\n"))
                    .unwrap_or_default();
                run_channel(
                    &session,
                    &command,
                    input.as_bytes(),
                    Duration::from_secs(35),
                )
                .await?
            }
        };
        parse_result(&stdout, code, os)
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

/// 非登录 shell 的普通用户 PATH 常常不含 sbin，而 ufw 就在 /usr/sbin 下。
const PLATFORM_PROBE: &str = "PATH=\"$PATH:/usr/sbin:/sbin\"; case \"$(uname -s)\" in Darwin) echo macos;; Linux) if command -v firewall-cmd >/dev/null 2>&1; then echo firewalld; elif command -v ufw >/dev/null 2>&1; then echo ufw; fi;; esac";

fn parse_firewall_platform(stdout: &str) -> Option<String> {
    let value = stdout.trim();
    matches!(value, "firewalld" | "ufw" | "macos").then(|| value.to_string())
}

/// 只读识别远端系统，用于选中手动放行命令。只复用已有的已信任会话，不新建 SSH
/// 认证；识别不了时返回 None，由用户自己选择，不猜测默认系统。
#[tauri::command]
pub async fn direct_agent_firewall_platform(
    connection_id: String,
    ssh_connection_id: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<Option<String>, String> {
    for id in ssh_connection_id
        .iter()
        .chain(std::iter::once(&connection_id))
    {
        let Some(root) = manager
            .roots_for_connection(id)
            .into_iter()
            .find(|root| root.trusted)
        else {
            continue;
        };
        if windows_native_path(&root.canonical_path).is_some() {
            return Ok(Some("windows".into()));
        }
        let tunneled = manager
            .direct_config(id)
            .is_some_and(|config| config.tunnel.is_some());
        let maintenance;
        let target: &SshManager = if tunneled {
            let Ok(session) = tunnel::tunnel_maintenance(&manager, id, &root) else {
                continue;
            };
            maintenance = session;
            &maintenance
        } else {
            &manager
        };
        if let Ok(output) = target
            .exec_command(
                &root.uri,
                PLATFORM_PROBE,
                None,
                true,
                Duration::from_secs(10),
            )
            .await
        {
            return Ok(parse_firewall_platform(&output.stdout));
        }
    }
    Ok(None)
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
    #[test]
    fn firewall_platform_probe_accepts_only_known_tools() {
        assert_eq!(
            parse_firewall_platform("firewalld\n").as_deref(),
            Some("firewalld")
        );
        assert_eq!(parse_firewall_platform("ufw").as_deref(), Some("ufw"));
        assert_eq!(parse_firewall_platform("macos").as_deref(), Some("macos"));
        for output in ["", "windows", "firewalld\nsomething else"] {
            assert_eq!(parse_firewall_platform(output), None, "{output:?}");
        }
    }
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
                tunnel: None,
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
    fn tunnel_loopback_endpoint_is_not_treated_as_server_host() {
        let manager = SshManager::new();
        manager.direct_connections.write().unwrap().insert(
            "ssh".into(),
            direct::DirectConnectionConfig {
                endpoint: "https://127.0.0.1:48763".into(),
                certificate_fingerprint: "a".repeat(64),
                token: "agent-secret".into(),
                tunnel: Some("ssh".into()),
            },
        );
        assert!(management_config(
            &manager,
            "ssh",
            Some("ssh"),
            Some(sample()),
            Some("server.example")
        )
        .is_ok());
        // 隧道不放宽校验：填写的 Server 主机仍必须与 SSH 主机一致。
        assert!(management_config(
            &manager,
            "ssh",
            Some("ssh"),
            Some(sample()),
            Some("other.example")
        )
        .is_err());
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
    fn remote_os_detection_defaults_to_windows_and_rejects_macos() {
        assert_eq!(remote_os("Linux\n"), Ok(RemoteOs::Linux));
        assert_eq!(remote_os(""), Ok(RemoteOs::Windows));
        assert_eq!(remote_os("MINGW64_NT-10.0"), Ok(RemoteOs::Windows));
        assert!(remote_os("Darwin")
            .unwrap_err()
            .contains("[direct:firewall-unsupported]"));
    }
    #[test]
    fn linux_command_keeps_secrets_out_and_quotes_safely() {
        let identity = management_identity(&sample());
        let command = linux_command(48763, Some(&"b".repeat(64)), &identity).unwrap();
        assert!(!command.contains("secret-not-in-script"));
        assert!(command.starts_with("sh -c '") && command.ends_with('\''));
        // 外层单引号内不得再出现单引号，否则会提前结束字符串。
        assert_eq!(command.matches('\'').count(), 2);
        assert!(command.contains("sudo -S -p"));
        assert!(linux_command(48763, Some("x; rm -rf /"), &identity).is_err());
        assert!(linux_command(0, None, &identity).is_err());
    }
    #[test]
    fn linux_script_only_adds_scoped_rules() {
        assert!(LINUX_SCRIPT
            .contains("source address=\\\"$client\\\" destination address=\\\"$local\\\""));
        assert!(LINUX_SCRIPT
            .contains("ufw allow proto tcp from \"$client\" to \"$local\" port \"$port\""));
        for forbidden in [
            "--remove-",
            "ufw delete",
            "--reload",
            "ufw disable",
            "iptables -F",
        ] {
            assert!(!LINUX_SCRIPT.contains(forbidden), "{forbidden}");
        }
        assert!(LINUX_SCRIPT.contains("[ \"$hash\" = \"$expected\" ]"));
    }
    #[test]
    fn parse_result_uses_last_json_line() {
        let out =
            b"noise\n{\"ok\":false,\"code\":\"[direct:firewall-admin]\",\"message\":\"sudo\"}\n";
        assert!(parse_result(out, Some(1), RemoteOs::Linux)
            .unwrap_err()
            .starts_with("[direct:firewall-admin]"));
        assert_eq!(
            parse_result(
                b"{\"ok\":true,\"value\":{\"port\":1}}",
                Some(0),
                RemoteOs::Linux
            )
            .unwrap()["port"],
            1
        );
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
