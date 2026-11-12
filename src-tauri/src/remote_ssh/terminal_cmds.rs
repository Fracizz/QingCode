//! 远端终端命令：交互终端构造、持久终端/脚本启动、读写、调整尺寸、
//! 结束与分离终端管理。

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ResolvedSshTerminal {
    pub(super) command: String,
    pub(super) enter_directory: Option<String>,
    pub(super) resolved_shell: String,
    pub(super) fallback_from: Option<String>,
}

pub(super) fn ssh_interactive_terminal_command(
    path: &str,
    shell: Option<&str>,
) -> Result<ResolvedSshTerminal, String> {
    if let Some(native) = windows_native_path(path) {
        if native.contains('\n') || native.contains('\r') {
            return Err("Windows 远程路径包含无法用于终端的字符".to_string());
        }
        let normalized = shell
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("auto");

        match normalized {
            "cmd" => Ok(windows_cmd_terminal(&native)),
            "pwsh" => Ok(windows_powershell_terminal(
                "pwsh.exe", &native, "pwsh", None,
            )),
            "powershell" | "auto" => Ok(windows_powershell_terminal(
                "powershell.exe",
                &native,
                "powershell",
                None,
            )),
            unsupported => Ok(windows_powershell_terminal(
                "powershell.exe",
                &native,
                "powershell",
                Some(unsupported.to_string()),
            )),
        }
    } else {
        let quoted = shell_quote(path);
        let normalized = shell
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("auto");

        match normalized {
            "bash" | "zsh" | "sh" => Ok(ResolvedSshTerminal {
                command: format!("cd -- {quoted} && exec {normalized} -l"),
                enter_directory: None,
                resolved_shell: normalized.to_string(),
                fallback_from: None,
            }),
            _ => Ok(ResolvedSshTerminal {
                command: format!("cd -- {quoted} && exec \"${{SHELL:-/bin/sh}}\" -l"),
                enter_directory: None,
                resolved_shell: "auto".to_string(),
                fallback_from: None,
            }),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalExitPayload {
    pub(super) id: String,
    pub(super) exit_code: u32,
    pub(super) disconnected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<String>,
}

/// 读循环可能先于 russh 的 disconnected 回调结束；短暂等待原因写入后再上报。
pub(super) async fn wait_for_closed_reason(transport: &ConnectedSession) -> Option<String> {
    if let Some(reason) = transport.closed_reason() {
        return Some(reason);
    }
    let wait_for_reason = async {
        loop {
            if let Some(reason) = transport.closed_reason() {
                return reason;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_millis(500), wait_for_reason)
        .await
        .ok()
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn spawn_ssh_terminal(
    id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    app: AppHandle,
    manager: &SshManager,
    command: String,
    enter_directory: Option<String>,
) -> Result<TerminalSpawnResult, String> {
    let parsed = parse_remote_uri(&cwd)?;
    manager.root_for_uri(&cwd, true)?;
    let command = with_terminal_identity(command, &id, &parsed.path);
    let transport = manager
        .open_terminal_transport(&parsed.connection_id)
        .await?;
    let channel = match start_terminal_channel(&transport, cols, rows, command).await {
        Ok(channel) => channel,
        Err(error) => {
            close_terminal_transport(&transport).await;
            return Err(error);
        }
    };
    let (mut reader, writer) = channel.split();
    let writer = Arc::new(writer);
    let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let alive = Arc::new(AtomicBool::new(true));
    let previous = {
        let mut terminals = manager
            .terminals
            .write()
            .map_err(|_| "SSH 终端状态不可用".to_string())?;
        terminals.insert(
            id.clone(),
            Arc::new(RemoteTerminalSession {
                connection_id: parsed.connection_id.clone(),
                transport: Arc::clone(&transport),
                input: input_tx,
                writer: Arc::clone(&writer),
                alive: Arc::clone(&alive),
            }),
        )
    };
    if let Some(previous) = previous {
        // 同一 id 重新创建：旧终端的连接不再有人使用，断开以免残留远端 Shell。
        previous.alive.store(false, Ordering::Release);
        tauri::async_runtime::spawn(async move {
            close_terminal_transport(&previous.transport).await;
        });
    }

    let (started_tx, started_rx) = if enter_directory.is_some() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };

    let is_filtering = Arc::new(AtomicBool::new(enter_directory.is_some()));
    let filtering_clone = Arc::clone(&is_filtering);
    let app_clone = app.clone();
    let terminal_id = id.clone();
    let connection_id = parsed.connection_id.clone();
    let exit_alive = Arc::clone(&alive);
    let reader_transport = Arc::clone(&transport);
    tauri::async_runtime::spawn(async move {
        let started_at = Instant::now();
        let mut started_tx = started_tx;
        let mut exit_code = 0;
        let mut ended_by_remote = false;
        let clear_sequence = b"\x1b[3J";
        while let Some(message) = reader.wait().await {
            ended_by_remote |= is_terminal_end_message(&message);
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if let Some(tx) = started_tx.take() {
                        let _ = tx.send(());
                    }
                    if filtering_clone.load(Ordering::Relaxed) {
                        if let Some(pos) = data
                            .windows(clear_sequence.len())
                            .position(|window| window == clear_sequence)
                        {
                            filtering_clone.store(false, Ordering::Relaxed);
                            emit_direct_terminal_data(&app_clone, &terminal_id, &data[pos..]);
                        }
                    } else {
                        emit_direct_terminal_data(&app_clone, &terminal_id, &data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status,
                _ => {}
            }
        }
        let disconnected = !ended_by_remote;
        let reason = if disconnected {
            wait_for_closed_reason(&reader_transport).await
        } else {
            None
        };
        close_terminal_transport(&reader_transport).await;
        if claim_terminal_exit(&exit_alive) {
            app_clone
                .state::<SshManager>()
                .forget_terminal(&terminal_id, &exit_alive);
            if disconnected {
                let reason_text = reason.as_deref().unwrap_or("原因未知");
                eprintln!(
                    "[WARN] terminal {terminal_id} 连接 {connection_id} 断开：{reason_text}，存活 {:.1} 秒",
                    started_at.elapsed().as_secs_f64()
                );
            }
            qingcode_server::diagnostics::record(
                "terminal.direct_exit",
                serde_json::json!({
                "terminalId":terminal_id,"connectionId":connection_id,"exitCode":exit_code,
                "disconnected":disconnected,"reason":reason.as_deref().map(qingcode_server::diagnostics::error_summary),
                "lifetimeMs":started_at.elapsed().as_millis()}),
                true,
                true,
            );
            if crate::mobile::is_mobile_terminal(&terminal_id) {
                crate::mobile::deliver_exit(&app_clone, &terminal_id, exit_code, disconnected);
            } else {
                let _ = app_clone.emit(
                    "terminal-exit",
                    TerminalExitPayload {
                        id: terminal_id,
                        exit_code,
                        disconnected,
                        reason,
                    },
                );
            }
        }
    });

    if let (Some(input), Some(started_rx)) = (enter_directory, started_rx) {
        let writer_for_startup = Arc::clone(&writer);
        let filtering_for_timeout = Arc::clone(&is_filtering);
        tauri::async_runtime::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_millis(1500), started_rx).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            if writer_for_startup
                .data_bytes(input.into_bytes())
                .await
                .is_err()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2000)).await;
            filtering_for_timeout.store(false, Ordering::Relaxed);
        });
    }

    let writer_for_input = Arc::clone(&writer);
    tauri::async_runtime::spawn(async move {
        while let Some(bytes) = input_rx.recv().await {
            if writer_for_input.data_bytes(bytes).await.is_err() {
                break;
            }
        }
    });
    Ok(TerminalSpawnResult::default())
}

/// 兼容模式的终端身份：sshd 默认不接受客户端传环境变量，只能写进启动命令。
/// Windows 远端的启动命令是整段 `-EncodedCommand`，无法在外层追加，不注入。
pub(super) fn with_terminal_identity(command: String, id: &str, remote_path: &str) -> String {
    if windows_native_path(remote_path).is_some() {
        return command;
    }
    let exports = crate::terminal::terminal_identity_env(id)
        .iter()
        .map(|(name, value)| format!("{name}={}", shell_quote(value)))
        .collect::<Vec<_>>()
        .join(" ");
    format!("export {exports}; {command}")
}

/// 在终端独占的连接上打开会话通道、申请 PTY 并启动命令。
pub(super) async fn start_terminal_channel(
    transport: &ConnectedSession,
    cols: Option<u16>,
    rows: Option<u16>,
    command: String,
) -> Result<russh::Channel<client::Msg>, String> {
    let channel = open_session_channel_once(transport, "终端").await?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            u32::from(cols.unwrap_or(80)),
            u32::from(rows.unwrap_or(24)),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("申请远程 PTY 失败：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("启动远程 Shell 失败：{error}"))?;
    Ok(channel)
}

/// Companion terminals go to the mobile buffer instead of every webview.
pub(super) fn emit_direct_terminal_data(app: &AppHandle, id: &str, data: &[u8]) {
    if crate::mobile::is_mobile_terminal(id) {
        crate::mobile::deliver_data(app, id, encode_terminal_data(data));
    } else {
        let _ = app.emit(
            "terminal-data",
            TerminalDataPayload {
                id: id.to_string(),
                data: encode_terminal_data(data),
            },
        );
    }
}

pub(super) fn persistent_shell_launch(
    path: &str,
    shell: Option<&str>,
) -> Result<server::PersistentLaunch, String> {
    let resolved = ssh_interactive_terminal_command(path, shell)?;
    let resolved_shell = resolved.resolved_shell;
    let windows = windows_native_path(path).is_some();
    let shell = if windows {
        Some(resolved_shell.clone())
    } else {
        matches!(resolved_shell.as_str(), "bash" | "zsh" | "sh").then(|| resolved_shell.clone())
    };
    // daemon 直接启动 shell（不经 OpenSSH 的 -EncodedCommand），启动参数要在这里
    // 补齐，否则远端 PowerShell 5.1 仍会按 ANSI 代码页解码 `cat` 的输出。
    let args = if !windows {
        Vec::new()
    } else if resolved_shell == "cmd" {
        vec!["/K".to_string(), WINDOWS_CMD_UTF8_SETUP.to_string()]
    } else {
        vec![
            "-NoLogo".to_string(),
            "-NoExit".to_string(),
            "-Command".to_string(),
            WINDOWS_POWERSHELL_UTF8_SETUP.to_string(),
        ]
    };
    Ok(server::PersistentLaunch {
        shell,
        args,
        env: std::collections::BTreeMap::new(),
        name: None,
        resolved_shell,
        fallback_from: resolved.fallback_from,
    })
}

pub(super) fn persistent_profile_launch(
    path: &str,
    target: &str,
    env: &HashMap<String, String>,
    shell: Option<&str>,
    name: Option<String>,
) -> Result<server::PersistentLaunch, String> {
    let mut launch = persistent_shell_launch(path, shell)?;
    launch.name = name;
    launch.env = env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if windows_native_path(path).is_some() {
        launch.args = if launch.resolved_shell == "cmd" {
            vec![
                "/K".to_string(),
                format!("{WINDOWS_CMD_UTF8_SETUP} & {target}"),
            ]
        } else {
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!("{WINDOWS_POWERSHELL_UTF8_SETUP}; {target}"),
            ]
        };
    } else {
        launch.args = vec![
            "-c".to_string(),
            format!("{target}; exec \"${{SHELL:-/bin/sh}}\" -l"),
        ];
    }
    Ok(launch)
}

/// 一次性运行任务交给 daemon：由 /bin/sh 执行与直连相同的调用串（含环境变量前缀），
/// 工作目录由 daemon 的 cwd 设置；进程结束即终端结束。
pub(super) fn persistent_task_launch(
    invocation: &str,
    name: Option<String>,
) -> server::PersistentLaunch {
    server::PersistentLaunch {
        shell: Some("/bin/sh".to_string()),
        args: vec!["-c".to_string(), invocation.to_string()],
        env: std::collections::BTreeMap::new(),
        name,
        resolved_shell: "sh".to_string(),
        fallback_from: None,
    }
}

pub(super) fn direct_windows_profile_command(
    path: &str,
    target: &str,
    env: &HashMap<String, String>,
    shell: Option<&str>,
) -> Result<String, String> {
    let native = windows_native_path(path)
        .ok_or_else(|| "直连 profile 终端需要 Windows 远程路径".to_string())?;
    let launch = persistent_profile_launch(path, target, env, shell, None)?;
    let mut script = String::new();
    for (key, value) in env {
        script.push_str(&format!("$env:{key} = '{}'; ", powershell_literal(value)));
    }
    if launch.resolved_shell == "cmd" {
        script.push_str(&format!(
            "$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath '{}'; & cmd.exe /K '{}'; exit $LASTEXITCODE",
            powershell_literal(&native),
            powershell_literal(&format!("{WINDOWS_CMD_UTF8_SETUP} & {target}"))
        ));
        Ok(windows_encoded_powershell(
            "powershell.exe -NoLogo -NoProfile -NonInteractive",
            &script,
            true,
        ))
    } else {
        let launcher = if launch.resolved_shell == "pwsh" {
            "pwsh.exe -NoLogo -NoExit"
        } else {
            "powershell.exe -NoLogo -NoExit"
        };
        script.push_str(&format!(
            "{WINDOWS_POWERSHELL_UTF8_SETUP}; Set-Location -LiteralPath '{}'; {target}",
            powershell_literal(&native)
        ));
        Ok(windows_encoded_powershell(launcher, &script, true))
    }
}

/// SSH 模式下终端直连、断线即结束进程；前端据此在标签上提示。
pub(super) const SSH_MODE_DIRECT_REASON: &str = "SSH 模式（连接配置），终端直连";

/// Server 模式下的失败统一带上模式前缀，前端据此提供「切到 SSH 模式」。
pub(super) fn into_server_mode_error(error: String) -> String {
    if error.contains(server::SERVER_MODE_ERROR_PREFIX) {
        error
    } else {
        server::server_mode_error(error)
    }
}

pub(super) fn direct_spawn_result_fallback(
    mut result: TerminalSpawnResult,
    reason: Option<String>,
) -> TerminalSpawnResult {
    result.persistent = false;
    result.persistent_fallback_reason = reason;
    result
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn ssh_create_terminal_unchecked(
    id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    name: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    let parsed = parse_remote_uri(&cwd)?;
    let root = manager.root_for_uri(&cwd, true)?;
    let sftp = manager.open_sftp(&parsed.connection_id).await?;
    let working_directory = ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let spec = ssh_interactive_terminal_command(&parsed.path, shell.as_deref())?;
    // Server 模式只走 daemon，SSH 模式只走直连，两者不再互相回退。
    if manager.server_mode(&parsed.connection_id) {
        let mut launch = persistent_shell_launch(&parsed.path, shell.as_deref())?;
        launch.name = name;
        return server::spawn_persistent_terminal(
            id,
            root,
            working_directory,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
            launch,
            app,
            &manager,
        )
        .await
        .map_err(into_server_mode_error);
    }
    let persistent_reason = Some(SSH_MODE_DIRECT_REASON.to_string());
    let result = spawn_ssh_terminal(
        id,
        cwd,
        cols,
        rows,
        app,
        &manager,
        spec.command,
        spec.enter_directory,
    )
    .await?;
    let mut result = direct_spawn_result_fallback(result, persistent_reason);
    result.resolved_shell = Some(spec.resolved_shell);
    result.fallback_from = spec.fallback_from;
    Ok(result)
}

pub(super) fn remote_script_invocation(target: &str, env_prefix: &str) -> Result<String, String> {
    let quoted = shell_quote(target);
    let extension = target
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(_, extension)| extension))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let command = match extension.as_str() {
        "ps1" | "bat" | "cmd" => {
            return Err("SSH Linux 项目不支持 PowerShell、BAT 或 CMD 脚本".to_string())
        }
        "py" => format!(
            "if command -v python3 >/dev/null 2>&1; then {env_prefix}exec python3 {quoted}; elif command -v python >/dev/null 2>&1; then {env_prefix}exec python {quoted}; else echo '远端未安装 python3 或 python' >&2; exit 127; fi"
        ),
        "js" | "mjs" | "cjs" => format!(
            "if command -v node >/dev/null 2>&1; then {env_prefix}exec node {quoted}; elif command -v bun >/dev/null 2>&1; then {env_prefix}exec bun {quoted}; else echo '远端未安装 node 或 bun' >&2; exit 127; fi"
        ),
        "ts" | "mts" | "cts" | "tsx" => format!(
            "if [ -x node_modules/.bin/tsx ]; then {env_prefix}exec node_modules/.bin/tsx {quoted}; elif command -v tsx >/dev/null 2>&1; then {env_prefix}exec tsx {quoted}; elif command -v bun >/dev/null 2>&1; then {env_prefix}exec bun {quoted}; else echo '远端未安装项目内 tsx、全局 tsx 或 bun' >&2; exit 127; fi"
        ),
        "rb" => format!(
            "command -v ruby >/dev/null 2>&1 && {env_prefix}exec ruby {quoted} || {{ echo '远端未安装 ruby' >&2; exit 127; }}"
        ),
        "php" => format!(
            "command -v php >/dev/null 2>&1 && {env_prefix}exec php {quoted} || {{ echo '远端未安装 php' >&2; exit 127; }}"
        ),
        "pl" => format!(
            "command -v perl >/dev/null 2>&1 && {env_prefix}exec perl {quoted} || {{ echo '远端未安装 perl' >&2; exit 127; }}"
        ),
        "bash" => format!(
            "command -v bash >/dev/null 2>&1 && {env_prefix}exec bash {quoted} || {{ echo '远端未安装 bash' >&2; exit 127; }}"
        ),
        "zsh" => format!(
            "command -v zsh >/dev/null 2>&1 && {env_prefix}exec zsh {quoted} || {{ echo '远端未安装 zsh' >&2; exit 127; }}"
        ),
        "sh" => format!("{env_prefix}exec /bin/sh {quoted}"),
        _ => format!(
            "if [ -x {quoted} ]; then {env_prefix}exec {quoted}; else {env_prefix}exec /bin/sh {quoted}; fi"
        ),
    };
    Ok(command)
}

#[tauri::command]
pub async fn ssh_run_environment(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<crate::run_environment::RunEnvironment, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let result = manager
        .exec_remote_shell(
            &path,
            "uname -s",
            "[Console]::Write('Windows_NT')",
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await?;
    if result.exit_code != 0 {
        return Err(format!("无法识别远端执行系统：{}", result.stderr.trim()));
    }
    Ok(crate::run_environment::RunEnvironment {
        os: crate::run_environment::unix_os(&result.stdout)?.into(),
        kind: "ssh".into(),
        distro: None,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn ssh_spawn_script_unchecked(
    id: String,
    cwd: String,
    shell_kind: String,
    target: String,
    env: HashMap<String, String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    name: Option<String>,
    project_root: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    if matches!(shell_kind.as_str(), "ps1" | "bat") {
        return Err("SSH Linux 项目暂不支持 PowerShell 或 BAT 任务".to_string());
    }
    let parsed = parse_remote_uri(&cwd)?;
    let root_uri = project_root.as_deref().unwrap_or(&cwd);
    if parse_remote_uri(root_uri)?.connection_id != parsed.connection_id {
        return Err("任务工作目录必须使用当前项目的 SSH 连接".into());
    }
    let root = manager.root_for_uri(root_uri, true)?;
    let server_mode = manager.server_mode(&parsed.connection_id);
    let persistent_cwd = {
        let sftp = manager.open_sftp(&parsed.connection_id).await?;
        Some(ensure_existing_path_within(&sftp, &parsed.path, &root).await?)
    };
    if shell_kind != "interactive" {
        reject_windows_remote_command(&parsed.path)?;
    }
    let target = if target.starts_with(SSH_URI_PREFIX) {
        let script = parse_remote_uri(&target)?;
        if script.connection_id != parsed.connection_id {
            return Err("脚本必须使用当前项目的 SSH 连接".into());
        }
        script.path
    } else {
        target
    };
    if matches!(shell_kind.as_str(), "sh" | "script") {
        let path = if target.starts_with('/') {
            target.clone()
        } else {
            join_remote_path(&parsed.path, &target)
        };
        let sftp = manager.open_sftp(&parsed.connection_id).await?;
        ensure_existing_path_within(&sftp, &path, &root).await?;
    }
    let mut env_prefix = String::new();
    for (key, value) in &env {
        if key.is_empty()
            || !key.bytes().enumerate().all(|(index, byte)| {
                byte == b'_'
                    || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
            })
        {
            return Err(format!("无效的远程任务环境变量名：{key}"));
        }
        env_prefix.push_str(&format!("{key}={} ", shell_quote(value)));
    }
    let invocation = match shell_kind.as_str() {
        "sh" => format!("{env_prefix}exec /bin/sh {}", shell_quote(&target)),
        "script" => remote_script_invocation(&target, &env_prefix)?,
        "interactive" => format!(
            "{env_prefix}/bin/sh -lc {}; exec \"${{SHELL:-/bin/sh}}\" -l",
            shell_quote(&target)
        ),
        _ => format!("{env_prefix}exec /bin/sh -lc {}", shell_quote(&target)),
    };
    let command = if shell_kind == "interactive" && windows_native_path(&parsed.path).is_some() {
        direct_windows_profile_command(&parsed.path, &target, &env, shell.as_deref())?
    } else {
        format!("cd -- {} && {invocation}", shell_quote(&parsed.path))
    };
    // Server 模式下交互式配置终端与一次性运行任务都交给 daemon；SSH 模式只走直连。
    if server_mode {
        let working_directory =
            persistent_cwd.expect("server mode validates the task working directory");
        let launch = if shell_kind == "interactive" {
            persistent_profile_launch(&parsed.path, &target, &env, shell.as_deref(), name)?
        } else {
            persistent_task_launch(&invocation, name)
        };
        return server::spawn_persistent_terminal(
            id,
            root,
            working_directory,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
            launch,
            app,
            &manager,
        )
        .await
        .map_err(into_server_mode_error);
    }
    let persistent_reason = Some(SSH_MODE_DIRECT_REASON.to_string());
    let result = spawn_ssh_terminal(id, cwd, cols, rows, app, &manager, command, None).await?;
    Ok(direct_spawn_result_fallback(result, persistent_reason))
}

pub(crate) async fn ssh_write_terminal_unchecked(
    id: String,
    data: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("单次终端输入不能超过 1MB，请分段粘贴".to_string());
    }
    let persistent = manager
        .persistent_terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .cloned();
    if let Some(terminal) = persistent {
        return terminal.write(data.into_bytes());
    }
    let input = manager
        .terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .map(|session| session.input.clone())
        .ok_or_else(|| "SSH 终端不存在".to_string())?;
    input
        .try_send(data.into_bytes())
        .map_err(|error| match error {
            tokio::sync::mpsc::error::TrySendError::Full(_) => {
                "终端输入缓冲区已满，请等待当前命令处理后重试".to_string()
            }
            tokio::sync::mpsc::error::TrySendError::Closed(_) => "终端输入通道已关闭".to_string(),
        })
}

pub(crate) async fn ssh_resize_terminal_unchecked(
    id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let persistent = manager
        .persistent_terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .cloned();
    if let Some(terminal) = persistent {
        return terminal.resize(cols, rows);
    }
    let writer = manager
        .terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .map(|session| Arc::clone(&session.writer))
        .ok_or_else(|| "SSH 终端不存在".to_string())?;
    writer
        .window_change(u32::from(cols), u32::from(rows), 0, 0)
        .await
        .map_err(|error| format!("调整 SSH 终端尺寸失败：{error}"))
}

#[tauri::command]
pub async fn ssh_terminal_diagnostic_log(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    tokio::time::timeout(
        Duration::from_secs(15),
        server_status::terminal_diagnostic_log(root_uri, &manager),
    )
    .await
    .map_err(|_| "读取远端终端诊断超时，本机日志仍可导出".to_string())?
}

pub(crate) async fn ssh_kill_terminal_unchecked(
    id: String,
    source: Option<String>,
    operation_id: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let source = qingcode_server::diagnostics::termination_source(source.as_deref());
    let operation_id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    qingcode_server::diagnostics::record(
        "terminal.kill_requested",
        serde_json::json!({
        "terminalId":id,"source":source,"operationId":operation_id}),
        true,
        false,
    );
    let persistent = manager
        .persistent_terminals
        .write()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .remove(&id);
    if let Some(terminal) = persistent {
        terminal.set_kill_context(source, &operation_id);
        let result = terminal.kill().await;
        qingcode_server::diagnostics::record(
            "terminal.kill_completed",
            serde_json::json!({
            "terminalId":id,"operationId":operation_id,"ok":result.is_ok()}),
            true,
            false,
        );
        return result;
    }
    let session = manager
        .terminals
        .write()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .remove(&id);
    if let Some(session) = session {
        session.alive.store(false, Ordering::Release);
        let closed = session.writer.close().await;
        // 远端不回 Close 时读取端不会结束，这里直接断开终端独占的连接。
        close_terminal_transport(&session.transport).await;
        closed.map_err(|error| format!("关闭 SSH 终端失败：{error}"))?;
    }
    Ok(())
}

/// 直接结束当前可信项目内、本安装遗留的 PTY，不接回或重放终端输出。
#[tauri::command]
pub async fn ssh_kill_detached_terminal(
    pty_id: String,
    cwd: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    if pty_id.trim().is_empty() {
        return Err("ptyId 不能为空".to_string());
    }
    crate::mobile::reject_desktop_use(&pty_id)?;
    let root = manager.root_for_uri(&cwd, true)?;
    server::kill_detached_terminal(&pty_id, &root, &app, &manager).await
}

/// 查询当前 QingCode 安装在该 SSH 连接下遗留的持久化终端。
#[tauri::command]
pub async fn ssh_list_detached_terminals(
    connection_id: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<Vec<server::DetachedTerminal>, String> {
    if connection_id.trim().is_empty() {
        return Err("connectionId 不能为空".to_string());
    }
    server::list_detached_terminals(&connection_id, &app, &manager).await
}

// 电脑端入口：手机终端（`mobile-*`）只归手机使用，电脑端不得新建同名、输入、改尺寸或结束。
// 手机端走对应的 `*_unchecked` 内部实现。

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_create_terminal(
    id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    name: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    crate::mobile::reject_desktop_use(&id)?;
    ssh_create_terminal_unchecked(id, cwd, cols, rows, shell, name, app, manager).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_spawn_script(
    id: String,
    cwd: String,
    shell_kind: String,
    target: String,
    env: HashMap<String, String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    name: Option<String>,
    project_root: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    crate::mobile::reject_desktop_use(&id)?;
    ssh_spawn_script_unchecked(
        id,
        cwd,
        shell_kind,
        target,
        env,
        cols,
        rows,
        shell,
        name,
        project_root,
        app,
        manager,
    )
    .await
}

#[tauri::command]
pub async fn ssh_write_terminal(
    id: String,
    data: String,
    manager: State<'_, SshManager>,
    mobile_state: State<'_, crate::mobile::MobileState>,
) -> Result<(), String> {
    crate::mobile::reject_desktop_use(&id)?;
    let _control = mobile_state.lock_control(&id).await;
    crate::mobile::check_desktop_write(&mobile_state, &id)?;
    ssh_write_terminal_unchecked(id, data, manager).await
}

#[tauri::command]
pub async fn ssh_resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, SshManager>,
    mobile_state: State<'_, crate::mobile::MobileState>,
) -> Result<(), String> {
    crate::mobile::reject_desktop_use(&id)?;
    let _control = mobile_state.lock_control(&id).await;
    if crate::mobile::desktop_blocked(&mobile_state, &id) {
        return Ok(());
    }
    ssh_resize_terminal_unchecked(id.clone(), cols, rows, manager).await?;
    crate::mobile::desktop_resized(&mobile_state, &id, cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn ssh_kill_terminal(
    id: String,
    source: Option<String>,
    operation_id: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    crate::mobile::reject_desktop_use(&id)?;
    ssh_kill_terminal_unchecked(id, source, operation_id, manager).await
}

/// 把本地标签接回一个仍由 daemon 托管的 PTY。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_attach_terminal(
    id: String,
    pty_id: String,
    cwd: String,
    // 视图实测网格；缺省时沿用 PTY 现有尺寸接回，不先改尺寸（见 attach_persistent_terminal）。
    cols: Option<u16>,
    rows: Option<u16>,
    from_seq: Option<u64>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    crate::mobile::reject_desktop_use(&id)?;
    crate::mobile::reject_desktop_use(&pty_id)?;
    let parsed = parse_remote_uri(&cwd)?;
    let root = manager.root_for_uri(&cwd, true)?;
    if remote_uri_connection_id(&root.uri) != Some(parsed.connection_id.as_str()) {
        return Err("终端工作目录与 SSH 连接不匹配".to_string());
    }
    let size = cols.zip(rows);
    server::attach_persistent_terminal(id, pty_id, root, size, from_seq, app, &manager).await
}

/// 尽力结束该根下本安装留在 daemon 里的 detached 终端。离线、daemon 未就绪或
/// 关闭 server 时无法触达远端，只记日志：这些终端在根未受信任时不会被列出或
/// 接回（接回要求可信根），由 daemon 的 detached TTL（默认 24 小时）回收。
pub(super) async fn kill_detached_terminals_best_effort(
    app: &AppHandle,
    manager: &SshManager,
    root: &RegisteredRoot,
) {
    let Ok(parsed) = parse_remote_uri(&root.uri) else {
        return;
    };
    // 限时：离线时不能让撤销信任或移除项目卡在重连、部署上。
    let killed = tokio::time::timeout(
        Duration::from_secs(5),
        server::kill_detached_terminals(
            &parsed.connection_id,
            app,
            manager,
            Some(&root.canonical_path),
        ),
    )
    .await
    .unwrap_or_else(|_| Err("5 秒内未能连上远端 daemon".to_string()));
    if let Err(error) = killed {
        eprintln!(
            "[WARN] 未能结束 {} 下的远端 detached 终端，交由 daemon 超时回收：{error}",
            root.uri
        );
    }
}
