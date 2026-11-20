//! Local and SSH CLI handoff. Keep the launch profile fixed and verify the
//! destination before attaching the exclusive terminal to its project.
use super::*;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Only this empty child of the application's own local data directory can be
/// used as a trusted launch directory. Never follow a redirected child.
fn checked_anchor(parent: &Path, create: bool) -> Result<PathBuf, String> {
    let io = |err: std::io::Error| err.to_string();
    if create {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let path = parent.canonicalize().map_err(io)?.join("codex-prewarm");
    if create {
        match std::fs::create_dir(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(io(e)),
            _ => {}
        }
    }
    if path.canonicalize().map_err(io)? != path
        || std::fs::read_dir(&path).map_err(io)?.next().is_some()
    {
        return Err("Codex 预热目录必须是 QingCode 的专用空目录".into());
    }
    Ok(path)
}

pub(super) fn validate_anchor(app: &AppHandle, cwd: &str) -> Result<(), String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    if checked_anchor(&base, false)? != Path::new(cwd) {
        return Err("Codex 预热目录已变化".into());
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct LocalCodexPool {
    pub(crate) pool: ShellPrewarmPool,
}

impl LocalCodexPool {
    pub(super) fn configure(&self, app: &AppHandle, window: &str, profile: Option<PrewarmProfile>) {
        let target = profile.and_then(|mut profile| {
            if !cfg!(windows)
                || !supported(&profile.command)
                || !matches!(profile.shell.as_str(), "auto" | "pwsh" | "powershell")
            {
                return None;
            }
            let base = app.path().app_local_data_dir().ok()?;
            let anchor = checked_anchor(&base, true).ok()?;
            let (cwd, launch, mut key) =
                local_launch_key(anchor.to_str()?, Some(&profile.shell)).ok()?;
            if !matches!(launch.resolved_shell.as_str(), "pwsh" | "powershell") {
                return None;
            }
            profile.cwd.clone_from(&cwd);
            key.profile = Some(profile);
            Some(Target {
                project_path: cwd.clone(),
                cwd,
                key,
                launch,
                count: 1,
                window: window.into(),
                remote: None,
            })
        });
        if let Some(target) = target {
            self.pool.configure_target(app, target);
        } else {
            self.pool.stop();
        }
    }

    fn key(
        &self,
        cwd: &str,
        shell: Option<&str>,
        command: &str,
    ) -> Option<(String, LaunchKey, u64)> {
        let (target, generation) = {
            let state = self.pool.0.lock().ok()?;
            (state.target.as_ref()?.key.clone(), state.generation)
        };
        let profile = target.profile.as_ref()?;
        if command != profile.command || shell != Some(&profile.shell) {
            return None;
        }
        let (cwd, _, mut key) = local_launch_key(cwd, shell).ok()?;
        key.profile.clone_from(&target.profile);
        (key == target).then_some((cwd, key, generation))
    }

    pub(crate) fn reserve(
        &self,
        cwd: &str,
        shell: Option<&str>,
        profile_id: &str,
        command: &str,
    ) -> Option<String> {
        let (cwd, key, _) = self.key(cwd, shell, command)?;
        if key.profile.as_ref()?.profile_id != profile_id {
            return None;
        }
        self.pool.reserve_key(&key, &cwd, false).ok()
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn take(
        &self,
        id: &str,
        cwd: &str,
        shell: Option<&str>,
        command: &str,
        name: Option<&str>,
        size: (u16, u16),
        app: &AppHandle,
        manager: &SshManager,
    ) -> Result<Option<TerminalSpawnResult>, String> {
        if !self.pool.has_entry(id) {
            return Ok(None);
        }
        let Some((canonical, key, generation)) = self.key(cwd, shell, command) else {
            return Ok(None);
        };
        let Some(mut entry) = self.pool.take_key(id, &key, &canonical, true) else {
            return Ok(None);
        };
        let directory = crate::terminal::strip_windows_verbatim_prefix(&canonical);
        if directory.chars().any(char::is_control) {
            return Ok(None);
        }
        let trust = app.state::<PathAllowlist>();
        let validate = || {
            trust.ensure_executable(&canonical)?;
            validate_anchor(app, &entry.cwd)?;
            if self
                .pool
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .generation
                != generation
            {
                return Err("Codex 预热配置已变化".to_string());
            }
            Ok(())
        };
        if validate().is_err() {
            return Ok(None);
        }
        let codex = entry.codex.as_mut().expect("local Codex reservation");
        let session = entry.session.as_mut().expect("transient session");
        let switched = tokio::time::timeout(
            codex.switch_timeout(),
            codex.enter(session, &entry.pty_id, &directory, &entry.cwd, &validate),
        )
        .await;
        if !matches!(switched, Ok(Ok(()))) {
            trace("codex_directory_unconfirmed", serde_json::json!({}));
            return Ok(None);
        }
        if validate().is_err()
            || codex
                .handoff
                .as_mut()
                .is_some_and(|file| file.write_all(directory.as_bytes()).is_err())
        {
            return Ok(None);
        }
        let result = self
            .pool
            .attach(
                id,
                entry,
                daemon_terminal_name(id, name),
                Some(directory.into_owned()),
                size,
                app.clone(),
                manager,
            )
            .await;
        if result.is_some() {
            record_hit(id, false);
        }
        Ok(result)
    }
}

/// 远端 daemon 版本过旧、不支持 `pty.claimCwdFile` 时的错误；预热循环据此暂停并提示升级。
pub(super) const SERVER_OUTDATED: &str = "远端服务需要更新以交付 CLI 工作目录";

pub(super) fn supported(command: &str) -> bool {
    matches!(command, "codex" | "claude" | "opencode")
}

const PROMPT: &str = "Ask Codex to do anything";
const PWD: &str = "• Current working directory: ";
const CHANGED: &str = "• Working directory changed to: ";

fn idle(screen: &str) -> bool {
    screen
        .lines()
        .any(|line| line.trim_start().starts_with('›') && line.contains(PROMPT))
}

fn reports(screen: &str, label: &str, directory: &str) -> bool {
    if directory.starts_with('/') {
        return screen
            .lines()
            .filter_map(|line| line.trim().strip_prefix(label))
            .any(|value| value == directory);
    }
    let path = |s: &str| crate::terminal::strip_windows_verbatim_prefix(s).replace('\\', "/");
    screen
        .lines()
        .filter_map(|line| line.trim().strip_prefix(label))
        .any(|value| path(value) == path(directory))
}

#[derive(Default)]
pub(super) struct CodexStatus {
    idle: bool,
}

impl vt100::Callbacks for CodexStatus {
    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if let [b"7501", state] = params {
            self.idle = *state == b"state=idle:app=codex";
        }
    }
}

pub(super) struct CodexSession {
    pub(super) screen: vt100::Parser<CodexStatus>,
    input_seq: AtomicU64,
    agent: String,
    nonce: String,
    handoff: Option<tempfile::NamedTempFile>,
}

impl CodexSession {
    pub(super) fn switch_timeout(&self) -> Duration {
        // The OpenCode client starts after its warm server binds the target.
        if self.agent == "opencode" {
            Duration::from_secs(15)
        } else {
            Duration::from_secs(5)
        }
    }

    fn input_ready(&self) -> bool {
        self.screen.callbacks().idle && idle(&self.screen.screen().contents())
    }

    fn directory_confirmed(&self, label: &str, directory: &str) -> bool {
        self.input_ready() && reports(&self.screen.screen().contents(), label, directory)
    }

    fn composer_shows(&self, expected: &str) -> bool {
        if !self.screen.callbacks().idle {
            return false;
        }
        let screen = self.screen.screen();
        let (row, _) = screen.cursor_position();
        screen
            .rows(0, screen.size().1.get())
            .nth(usize::from(row))
            .is_some_and(|line| line.trim() == expected)
    }

    async fn wait_for(
        &mut self,
        session: &mut DaemonSession,
        id: &str,
        matches: impl Fn(&Self) -> bool,
    ) -> Result<(), String> {
        let events = session.events_mut().ok_or("Codex 预热事件流不可用")?;
        loop {
            if matches(self) {
                return Ok(());
            }
            match events.recv().await {
                Some(Event::PtyData {
                    id: owner, data, ..
                }) if owner == id => self.screen.process(&data),
                Some(Event::PtyExit { id: owner, .. }) if owner == id => break,
                None => break,
                _ => {}
            }
        }
        Err("Codex 预热会话已结束".into())
    }

    async fn submit(
        &mut self,
        session: &mut DaemonSession,
        id: &str,
        command: &str,
        before_enter: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.wait_for(session, id, Self::input_ready).await?;
        // Stage text without Enter. Only submit after the composer renders the
        // exact command. A login, trust or update dialog receives no approval.
        send_input_to_session(session, id, &self.input_seq, command.as_bytes().to_vec())
            .await
            .map_err(|e| e.0)?;
        let expected = format!("› {command}");
        self.wait_for(session, id, |view| view.composer_shows(&expected))
            .await?;
        before_enter()?;
        send_input_to_session(session, id, &self.input_seq, vec![b'\r'])
            .await
            .map_err(|e| e.0)
    }

    /// A fresh Claude installation asks for folder trust even in our empty
    /// application directory. Handle only this exact prompt in the unclaimed
    /// local PTY. Target projects and other Claude dialogs stay interactive.
    async fn trust_local_claude_anchor(
        &mut self,
        session: &mut DaemonSession,
        id: &str,
        cwd: &str,
    ) -> Result<(), String> {
        self.wait_for(session, id, |v| {
            let screen = claude_rows(v.screen.screen());
            claude_composer(&screen, "") || claude_trust_choice(&screen, cwd).is_some()
        })
        .await?;
        let screen = claude_rows(self.screen.screen());
        if claude_trust_choice(&screen, cwd).is_none() {
            return Ok(());
        }
        let path = Path::new(cwd);
        let check = || -> Result<(), String> {
            let parent = path.parent().ok_or("无效的预热目录")?;
            if checked_anchor(parent, false)? != path.canonicalize().map_err(|e| e.to_string())?
                || parent.ancestors().any(|dir| dir.join(".git").exists())
            {
                return Err("Claude 仅可在 QingCode 专用空目录初始化".into());
            }
            Ok(())
        };
        // Claude may redraw the initial selection while its TUI is mounting.
        // Re-read the completed frame before selecting and before pressing Enter.
        for _ in 0..2 {
            tokio::time::sleep(Duration::from_millis(800)).await;
            if session.drain_idle_pty(id, |bytes| self.screen.process(bytes)) {
                break;
            }
            match claude_trust_choice(&claude_rows(self.screen.screen()), cwd) {
                Some(false) => {
                    check()?;
                    send_input_to_session(session, id, &self.input_seq, b"\x1b[B".to_vec())
                        .await
                        .map_err(|e| e.0)?;
                    self.wait_for(session, id, |v| {
                        claude_trust_choice(&claude_rows(v.screen.screen()), cwd) == Some(true)
                    })
                    .await?;
                }
                Some(true) => {}
                None => break,
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
            if !session.drain_idle_pty(id, |bytes| self.screen.process(bytes))
                && claude_trust_choice(&claude_rows(self.screen.screen()), cwd) == Some(true)
            {
                check()?;
                return send_input_to_session(session, id, &self.input_seq, vec![b'\r'])
                    .await
                    .map_err(|e| e.0);
            }
        }
        Err("Claude 预热目录确认已变化".into())
    }

    async fn claude_cd(
        &mut self,
        session: &mut DaemonSession,
        id: &str,
        cwd: &str,
        change: bool,
        validate: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let path = if windows_native_path(cwd).is_some() {
            cwd.replace('\\', "/")
        } else {
            cwd.to_string()
        };
        self.wait_for(session, id, |v| {
            claude_composer(&claude_rows(v.screen.screen()), "")
        })
        .await?;
        send_input_to_session(session, id, &self.input_seq, b"/cd".to_vec())
            .await
            .map_err(|e| e.0)?;
        self.wait_for(session, id, |v| {
            let content = claude_rows(v.screen.screen());
            claude_composer(&content, "/cd")
                && content.lines().any(|line| {
                    line.contains("/cd")
                        && line.contains("Move this session to a new working directory")
                })
        })
        .await?;
        send_input_to_session(
            session,
            id,
            &self.input_seq,
            format!(" {path}").into_bytes(),
        )
        .await
        .map_err(|e| e.0)?;
        let draft = format!("/cd {path}");
        self.wait_for(session, id, |v| {
            claude_composer(&claude_rows(v.screen.screen()), &draft)
        })
        .await?;
        validate()?;
        send_input_to_session(session, id, &self.input_seq, vec![b'\r'])
            .await
            .map_err(|e| e.0)?;
        let expected = if change {
            format!("Moved to {path}")
        } else {
            format!("Already in {path}.")
        };
        self.wait_for(session, id, |v| {
            let screen = v.screen.screen();
            claude_composer(&claude_rows(screen), "")
                && claude_reports(screen, &expected, windows_native_path(cwd).is_some())
        })
        .await
    }

    pub(super) async fn enter(
        &mut self,
        session: &mut DaemonSession,
        id: &str,
        cwd: &str,
        anchor: &str,
        validate: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        if self.agent == "opencode" {
            validate()?;
            let nonce = self.nonce.clone();
            send_input_to_session(session, id, &self.input_seq, remote_input_line(cwd))
                .await
                .map_err(|error| error.0)?;
            session.wait_shell_marker(id, &nonce, "cwd").await?;
            self.wait_for(session, id, |view| {
                view.screen.screen().contents().contains("Ask anything…")
            })
            .await?;
            return validate();
        }
        if self.agent == "claude" {
            if cwd != crate::terminal::strip_windows_verbatim_prefix(anchor) {
                self.claude_cd(session, id, cwd, true, &validate).await?;
            }
            return self.claude_cd(session, id, cwd, false, &validate).await;
        }
        let anchor = crate::terminal::strip_windows_verbatim_prefix(anchor);
        if cwd != anchor {
            self.submit(
                session,
                id,
                &format!(
                    "/cd {}",
                    if cwd.starts_with('/') {
                        cwd.to_string()
                    } else {
                        cwd.replace('\\', "/")
                    }
                ),
                &validate,
            )
            .await?;
            self.wait_for(session, id, |view| view.directory_confirmed(CHANGED, cwd))
                .await?;
        }
        self.submit(session, id, "/pwd", validate).await?;
        self.wait_for(session, id, |view| view.directory_confirmed(PWD, cwd))
            .await
    }
}

fn claude_trust_choice(screen: &str, cwd: &str) -> Option<bool> {
    let mut lines = screen.lines().map(str::trim).filter(|l| !l.is_empty());
    lines.find(|line| *line == "Accessing workspace:")?;
    let shown = lines.next()?;
    if shown != cwd
        && windows_native_path(shown)
            .zip(windows_native_path(cwd))
            .is_none_or(|(a, b)| a != b)
    {
        return None;
    }
    let items: Vec<_> = lines.collect();
    if !items
        .iter()
        .any(|line| line.contains("Is this a project you created or one you trust?"))
        || !items.iter().any(|line| line.contains("Enter to confirm"))
    {
        return None;
    }
    let selected = |text| {
        items
            .iter()
            .any(|l| l.strip_prefix('❯').is_some_and(|v| v.trim() == text))
    };
    if selected("Yes, I trust this folder") && items.contains(&"No, exit") {
        Some(true)
    } else if selected("No, exit") && items.contains(&"Yes, I trust this folder") {
        Some(false)
    } else {
        None
    }
}

// ConPTY may soft-wrap from a padded command row directly into its result.
// Inspect physical rows so the command echo cannot hide the result prefix.
fn claude_reports(screen: &vt100::Screen, expected: &str, windows: bool) -> bool {
    screen.rows(0, screen.size().1.get()).any(|row| {
        row.trim()
            .strip_prefix('⎿')
            .map(str::trim)
            .is_some_and(|value| {
                value == expected || windows && value.replace('\\', "/") == expected
            })
    })
}

// ConPTY can soft-wrap a full-width rule into the prompt on the next row.
fn claude_rows(screen: &vt100::Screen) -> String {
    screen
        .rows(0, screen.size().1.get())
        .collect::<Vec<_>>()
        .join("\n")
}

// Claude renders the live input between two horizontal rules. History,
// autocomplete options and trust dialogs must never count as the prompt.
fn claude_composer(screen: &str, expected: &str) -> bool {
    let mut lines = screen.lines();
    let mut previous = "";
    while let Some(line) = lines.next() {
        if previous.trim_start().starts_with("───")
            && line
                .trim_start()
                .strip_prefix('❯')
                .is_some_and(|v| v.trim() == expected)
            && lines
                .clone()
                .next()
                .is_some_and(|v| v.trim_start().starts_with("───"))
        {
            return true;
        }
        previous = line;
    }
    false
}

pub(super) async fn prepare(entry: &mut WarmShell, target: &Target) -> Result<(), String> {
    let cwd = crate::terminal::strip_windows_verbatim_prefix(&target.cwd);
    prepare_at(entry, target, &cwd).await
}

pub(super) async fn prepare_at(
    entry: &mut WarmShell,
    target: &Target,
    cwd: &str,
) -> Result<(), String> {
    let profile = target.key.profile.as_ref().ok_or("缺少 CLI 预热配置")?;
    let agent = profile.command.as_str();
    if !supported(agent) || cwd.chars().any(char::is_control) {
        return Err("不支持此 CLI 或项目路径".into());
    }
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let remote = target.remote.is_some();
    let powershell = matches!(target.launch.resolved_shell.as_str(), "powershell" | "pwsh");
    if !entry.claim_cwd {
        return Err("本机宿主不支持领取时更新目录".into());
    }
    let handoff = (!remote && agent != "opencode")
        .then(tempfile::NamedTempFile::new)
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut env = target.launch.env.clone();
    let cwd_file = remote && agent != "opencode";
    if cwd_file
        && !entry
            .session
            .as_ref()
            .is_some_and(|s| s.supports("pty.claimCwdFile"))
    {
        return Err(SERVER_OUTDATED.into());
    }
    if let Some(handoff) = &handoff {
        env.insert(
            "QINGCODE_CODEX_HANDOFF".into(),
            handoff.path().to_string_lossy().into_owned(),
        );
    }
    if !remote {
        env.insert("QINGCODE_CODEX_ANCHOR".into(), cwd.into());
    }
    env.insert("QINGCODE_PREWARM_AGENT".into(), agent.into());
    env.insert("QINGCODE_PREWARM_NONCE".into(), nonce.clone());
    env.extend(crate::terminal::terminal_identity_env(&entry.id).map(|(k, v)| (k.into(), v)));
    let script = match (agent, powershell) {
        ("opencode", true) => include_str!("start-opencode.ps1"),
        ("opencode", false) => include_str!("start-opencode.sh"),
        (_, true) => include_str!("start-codex.ps1"),
        (_, false) => include_str!("start-agent.sh"),
    };
    let args = if remote {
        crate::remote_ssh::terminal_cmds::persistent_profile_launch(
            cwd,
            script.trim_end(),
            &HashMap::new(),
            Some(&profile.shell),
            None,
        )?
        .args
    } else {
        let mut args = target.launch.args.clone();
        args.extend(["-NoExit".into(), "-Command".into(), script.into()]);
        args
    };
    let shell = if remote && !powershell {
        Some("/bin/sh")
    } else {
        target.launch.shell.as_deref()
    };
    let session = entry.session.as_mut().ok_or("CLI 预热会话不可用")?;
    let created = session.request("pty.createTransient", &serde_json::json!({
        "cwd": cwd, "claimCwdFile": cwd_file, "shell": shell, "args": args, "env": env, "cols": 120, "rows": 30
    })).await?;
    entry.pty_id = created["id"].as_str().ok_or("预热应答缺少 id")?.into();
    let mut codex = CodexSession {
        screen: vt100::Parser::new_with_callbacks(
            30.try_into().unwrap(),
            120.try_into().unwrap(),
            0,
            CodexStatus::default(),
        ),
        input_seq: AtomicU64::new(0),
        agent: agent.into(),
        nonce: nonce.clone(),
        handoff,
    };
    let ready = tokio::time::timeout(READY_TIMEOUT, async {
        if agent == "opencode" {
            return session
                .wait_shell_marker(&entry.pty_id, &nonce, "ready")
                .await
                .map(|_| ());
        }
        if agent == "claude" {
            if !remote {
                codex
                    .trust_local_claude_anchor(session, &entry.pty_id, cwd)
                    .await?;
            }
            return codex
                .claude_cd(session, &entry.pty_id, cwd, false, &|| Ok(()))
                .await;
        }
        codex
            .submit(session, &entry.pty_id, "/pwd", || Ok(()))
            .await?;
        codex
            .wait_for(session, &entry.pty_id, |view| {
                view.directory_confirmed(PWD, cwd)
            })
            .await
    })
    .await
    .map_err(|_| "等待 CLI 输入界面或目录确认超时".to_string())
    .and_then(|result| result);
    #[cfg(test)]
    if ready.is_err() {
        eprintln!("CLI readiness screen: {}", codex.screen.screen().contents());
    }
    ready?;
    entry.codex = Some(codex);
    Ok(())
}

#[cfg(test)]
mod tests;
