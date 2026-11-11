//! SshManager：SFTP 获取与远端命令执行（含超时、stdin 与 Windows Git）。

use super::*;

impl SshManager {
    pub(super) async fn open_sftp(&self, connection_id: &str) -> Result<Arc<SftpSession>, String> {
        if let Some(config) = self.direct_config(connection_id) {
            return Ok(Arc::new(SftpSession::direct(config, None, false)));
        }
        let session = self.live_session(connection_id).await?;
        match open_sftp_session(&session).await {
            Ok(sftp) => Ok(sftp),
            Err(error) if error.stale => {
                let session = self
                    .reconnect_after_channel_failure(connection_id, &session)
                    .await?;
                Ok(open_sftp_session(&session).await?)
            }
            Err(error) => Err(error.message),
        }
    }

    pub(super) async fn sftp_for_uri(
        &self,
        uri: &str,
        require_trust: bool,
    ) -> Result<(Arc<SftpSession>, RemoteUri, RegisteredRoot), String> {
        let parsed = parse_remote_uri(uri)?;
        let root = self.root_for_uri(uri, require_trust)?;
        if let Some(config) = self.direct_config(&parsed.connection_id) {
            if !self.connection_is_open(&parsed.connection_id) {
                return Err(direct::disconnected_message(
                    self.connection_closed_reason(&parsed.connection_id)
                        .as_deref(),
                ));
            }
            let sftp = Arc::new(SftpSession::direct(
                config,
                Some(root.canonical_path.clone()),
                root.trusted,
            ));
            return Ok((sftp, parsed, root));
        }
        let sftp = self.open_sftp(&parsed.connection_id).await?;
        Ok((sftp, parsed, root))
    }

    pub(super) async fn exec_uri(
        &self,
        uri: &str,
        command: &str,
        require_trust: bool,
    ) -> Result<RemoteExecResult, String> {
        self.exec_uri_with_timeout(uri, command, require_trust, REMOTE_EXEC_TIMEOUT)
            .await
    }

    pub(super) async fn exec_uri_with_timeout(
        &self,
        uri: &str,
        command: &str,
        require_trust: bool,
        timeout: Duration,
    ) -> Result<RemoteExecResult, String> {
        let parsed = parse_remote_uri(uri)?;
        reject_windows_remote_command(&parsed.path)?;
        self.exec_command(uri, command, None, require_trust, timeout)
            .await
    }

    /// Unix 走 shell 命令；Windows OpenSSH 把脚本放进 `powershell.exe -EncodedCommand`，
    /// 避免默认 shell 是 cmd 还是 Git Bash 时转义不一致。只给代理部署这种固定脚本用。
    pub(crate) async fn exec_remote_shell(
        &self,
        uri: &str,
        unix_command: &str,
        windows_script: &str,
        require_trust: bool,
        timeout: Duration,
    ) -> Result<RemoteExecResult, String> {
        let parsed = parse_remote_uri(uri)?;
        #[cfg(test)]
        super::direct_update::trace_exec(windows_script);
        if windows_native_path(&parsed.path).is_some() {
            if let Some(command) = windows_powershell_inline_command(windows_script) {
                return self
                    .exec_command(uri, &command, None, require_trust, timeout)
                    .await;
            }
            let input = encode_terminal_data(windows_script.as_bytes());
            return self
                .exec_command(
                    uri,
                    &windows_powershell_stdin_command(),
                    Some(input.as_bytes()),
                    require_trust,
                    timeout,
                )
                .await;
        }
        self.exec_command(uri, unix_command, None, require_trust, timeout)
            .await
    }

    pub(super) async fn exec_uri_with_input(
        &self,
        uri: &str,
        command: &str,
        input: &[u8],
        require_trust: bool,
    ) -> Result<RemoteExecResult, String> {
        let parsed = parse_remote_uri(uri)?;
        reject_windows_remote_command(&parsed.path)?;
        self.exec_command(
            uri,
            command,
            Some(input),
            require_trust,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
    }

    /// 在 Windows OpenSSH 远端执行 git：脚本经 stdin 传给 PowerShell，避免默认 shell 的转义差异。
    pub(super) async fn exec_windows_git(
        &self,
        uri: &str,
        native_root: &str,
        args: &[String],
        require_trust: bool,
        timeout: Duration,
    ) -> Result<RemoteExecResult, String> {
        let script = windows_git_script(native_root, args)?;
        if let Some(command) = windows_powershell_inline_command(&script) {
            return self
                .exec_command(uri, &command, None, require_trust, timeout)
                .await;
        }
        let input = encode_terminal_data(script.as_bytes());
        self.exec_command(
            uri,
            &windows_powershell_stdin_command(),
            Some(input.as_bytes()),
            require_trust,
            timeout,
        )
        .await
    }

    pub(super) async fn exec_command(
        &self,
        uri: &str,
        command: &str,
        input: Option<&[u8]>,
        require_trust: bool,
        timeout: Duration,
    ) -> Result<RemoteExecResult, String> {
        #[cfg(test)]
        super::direct_update::trace_exec(&format!(
            "ssh-exec {}",
            command.chars().take(40).collect::<String>()
        ));
        let parsed = parse_remote_uri(uri)?;
        let root = self.root_for_uri(uri, require_trust)?;
        if let Some(config) = self.direct_config(&parsed.connection_id) {
            let value = direct::workspace_request(
                &config,
                &serde_json::json!({
                    "op":"exec","root":root.canonical_path,"trusted":root.trusted,
                    "path":parsed.path,"command":command,"input":input.unwrap_or_default(),
                    "timeoutSeconds":timeout.as_secs()
                }),
            )
            .await?;
            return serde_json::from_value(value).map_err(|_| "Server 命令响应格式无效".into());
        }
        let _slot = self
            .exec_slots(&parsed.connection_id)?
            .acquire_owned()
            .await
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        let mut channel = self
            .open_session_channel(&parsed.connection_id, "命令")
            .await?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|error| format!("执行远程命令失败：{error}"))?;
        if let Some(input) = input {
            channel
                .data(input)
                .await
                .map_err(|error| format!("发送远程命令输入失败：{error}"))?;
            channel
                .eof()
                .await
                .map_err(|error| format!("结束远程命令输入失败：{error}"))?;
        }

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let collected = tokio::time::timeout(timeout, async {
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    _ => {}
                }
            }
        })
        .await;
        if collected.is_err() {
            // 关掉通道释放并发名额；远端进程随通道结束。
            let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
            return Err(format!(
                "远程命令超过 {} 秒未结束，已中止",
                timeout.as_secs()
            ));
        }
        Ok(RemoteExecResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: exit_code.unwrap_or(255),
        })
    }
}
