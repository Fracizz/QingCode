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
    if path.canonicalize().map_err(io)? != path {
        return Err("Codex 预热目录必须是 QingCode 的专用空目录".into());
    }
    remove_empty_dirs(&path);
    if std::fs::read_dir(&path).map_err(io)?.next().is_some() {
        return Err("Codex 预热目录必须是 QingCode 的专用空目录".into());
    }
    Ok(path)
}

/// 此前在专用目录启动的 CLI 会话可能留下空目录（如 Claude 的 `.claude`）。
/// 只删除空目录、不进入链接；仍有文件时保留，由调用方按非空处理。
fn remove_empty_dirs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        // DirEntry::file_type 不跟随链接；Windows 目录联接同样视为链接。
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let path = entry.path();
            remove_empty_dirs(&path);
            let _ = std::fs::remove_dir(&path);
        }
    }
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

    /// 同 [`Self::reserve`]，命中后改按调用方的终端 id 领取（手机终端需 `mobile-` id）。
    pub(crate) fn reserve_as(
        &self,
        id: &str,
        cwd: &str,
        shell: Option<&str>,
        profile_id: &str,
        command: &str,
    ) -> bool {
        if self.pool.has_entry(id) {
            return false;
        }
        self.reserve(cwd, shell, profile_id, command)
            .is_some_and(|warm_id| self.pool.rename_reserved(&warm_id, id).is_ok())
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
const UPGRADE_REQUIRED: &str = "cli_upgrade_required";
const LOGIN_REQUIRED: &str = "cli_login_required";
const TRUST_REQUIRED: &str = "cli_trust_required";
const SCRIPT_BLOCKED: &str = "cli_script_blocked";
const HANDOFF_UNAVAILABLE: &str = "cli_handoff_unavailable";
/// 启动脚本在 PATH 上找不到所选 CLI。
pub(super) const CLI_NOT_INSTALLED: &str = "cli_not_installed";
/// 专用启动目录里仍有文件（多为已领取的 CLI 会话正在使用），不是需要用户处理的阻塞，稍后自动重试。
pub(super) const ANCHOR_BUSY: &str = "cli_anchor_busy";
/// 预热途中 daemon 会话断开（如远端服务升级重启 daemon）：与 CLI 本身无关，稍后自动重试。
const SESSION_LOST: &str = "cli_session_lost";
/// CLI 启动前的连接、目录校验或建 PTY 失败（远端服务刚重启/升级、网络抖动等）：
/// CLI 尚未运行，与 CLI 本身无关，稍后自动重试。
const TRANSPORT_FAILED: &str = "cli_transport_failed";
/// 单次创建超过总时限（连接或启动卡住）：属于暂时性失败，退避后重试。
pub(super) const CREATE_TIMED_OUT: &str = "prewarm_create_timeout";
/// CLI 在时限内未出现输入界面或未确认目录：多为偶发启动慢，先重试；连续超时才暂停。
pub(super) const READY_TIMED_OUT: &str = "等待 CLI 输入界面或目录确认超时";
/// 连续就绪超时达到该次数才暂停为 `cli_not_ready`（即超时后自动重试一次）。
pub(super) const READY_TIMEOUT_PAUSE_AFTER: u32 = 2;
/// 诊断里保留的屏幕末尾行数与单行长度上限。
const SCREEN_TAIL_LINES: usize = 8;
const SCREEN_TAIL_CHARS: usize = 120;

/// 就绪超时时的屏幕末尾，用于诊断卡在哪个画面。
/// 去掉专用目录和疑似路径的片段，不把用户路径写进诊断。
fn screen_tail_for_diagnostics(screen: &str, anchor: &str) -> Vec<String> {
    let anchors = [anchor.to_string(), anchor.replace('\\', "/")];
    let mut lines: Vec<String> = screen
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut line = line.to_string();
            for anchor in anchors.iter().filter(|a| !a.is_empty()) {
                line = line.replace(anchor.as_str(), "<anchor>");
            }
            line.split(' ')
                .map(|word| {
                    if word.contains('/') || word.contains('\\') {
                        "<path>"
                    } else {
                        word
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(SCREEN_TAIL_CHARS)
                .collect()
        })
        .collect();
    let skip = lines.len().saturating_sub(SCREEN_TAIL_LINES);
    lines.drain(..skip);
    lines
}

/// 暂时性失败：按普通失败退避重试，不暂停预热、不要求用户切换配置。
pub(super) fn retry_later(error: &str) -> bool {
    error == ANCHOR_BUSY
        || error == CREATE_TIMED_OUT
        || error.starts_with(SESSION_LOST)
        || error.starts_with(TRANSPORT_FAILED)
}

/// 把 CLI 启动前的基础设施错误标为 [`TRANSPORT_FAILED`]，预热循环据此退避重试而不暂停为 `cli_not_ready`。
pub(super) fn transport_error(error: impl std::fmt::Display) -> String {
    format!("{TRANSPORT_FAILED}: {error}")
}

/// 会话已关闭时，把超时等表象错误归为 [`SESSION_LOST`]，保留关闭原因便于诊断。
fn session_error(session: &DaemonSession, error: String) -> String {
    match session.closed_reason() {
        Some(reason) => format!("{SESSION_LOST}: {reason}"),
        None => error,
    }
}

pub(super) fn interaction_blocker(error: &str) -> Option<&'static str> {
    match error {
        UPGRADE_REQUIRED => Some(UPGRADE_REQUIRED),
        LOGIN_REQUIRED => Some(LOGIN_REQUIRED),
        TRUST_REQUIRED => Some(TRUST_REQUIRED),
        SCRIPT_BLOCKED => Some(SCRIPT_BLOCKED),
        HANDOFF_UNAVAILABLE => Some(HANDOFF_UNAVAILABLE),
        CLI_NOT_INSTALLED => Some(CLI_NOT_INSTALLED),
        _ => None,
    }
}

fn startup_blocker(agent: &str, screen: &str, anchor: &str, nonce: &str) -> Option<&'static str> {
    let has = |text| screen.contains(text);
    let marker = format!("QC-{nonce}-script_blocked!");
    if screen.lines().any(|line| line.trim() == marker) {
        return Some(SCRIPT_BLOCKED);
    }
    let missing = format!("QC-{nonce}-cli_not_installed!");
    if screen.lines().any(|line| line.trim() == missing) {
        return Some(CLI_NOT_INSTALLED);
    }
    let busy = format!("QC-{nonce}-anchor_busy!");
    if screen.lines().any(|line| line.trim() == busy) {
        return Some(ANCHOR_BUSY);
    }
    if agent == "codex" {
        if has("Update available") && has("Update now") && has("Skip until next version") {
            return Some(UPGRADE_REQUIRED);
        }
        if has("Sign in with ChatGPT") && has("Use an API key") {
            return Some(LOGIN_REQUIRED);
        }
        if has("Do you trust the contents") && has("Yes, continue") && has("No, quit") {
            return Some(TRUST_REQUIRED);
        }
    }
    if agent == "claude" {
        if has("Select login method") && has("Claude account") && has("Anthropic Console") {
            return Some(LOGIN_REQUIRED);
        }
        if has("Moving to a new directory:")
            && has("No, stay put")
            && has("Yes, move here")
            && has("Enter to confirm")
        {
            return Some(TRUST_REQUIRED);
        }
        let mut lines = screen
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty());
        if lines.any(|line| line == "Accessing workspace:")
            && lines
                .next()
                .is_some_and(|shown| claude_trust_choice(screen, shown).is_some())
            && claude_trust_choice(screen, anchor).is_none()
        {
            return Some(TRUST_REQUIRED);
        }
    }
    None
}

/// CLI 启动脚本统一为 LF 换行。Windows 检出（core.autocrlf=true）会把脚本变成 CRLF
/// 编进二进制；远端 dash 把 `\r` 当作参数的一部分（如 `unset NAME\r` 报
/// bad variable name），特殊内建失败后以 2 退出，CLI 预热会在启动瞬间结束。
pub(super) fn launch_script(agent: &str, powershell: bool) -> String {
    let script = match (agent, powershell) {
        ("opencode", true) => include_str!("start-opencode.ps1"),
        ("opencode", false) => include_str!("start-opencode.sh"),
        ("pi", true) => return pi_script(include_str!("start-pi.ps1")),
        ("pi", false) => return pi_script(include_str!("start-pi.sh")),
        (_, true) => include_str!("start-codex.ps1"),
        (_, false) => include_str!("start-agent.sh"),
    };
    script.replace("\r\n", "\n")
}

/// pi 的启动脚本内嵌 Node 预加载器（PowerShell here-string / sh heredoc）。
fn pi_script(script: &str) -> String {
    let preload = include_str!("pi-preload.mjs").replace("\r\n", "\n");
    script
        .replace("\r\n", "\n")
        .replace("__QINGCODE_PI_PRELOAD__", preload.trim_end())
}

pub(super) fn supported(command: &str) -> bool {
    matches!(command, "codex" | "claude" | "opencode" | "pi")
}

/// 这些 CLI 无法在会话内换目录：启动脚本自己读取一行目标目录、切换后再运行，
/// 并负责 CLI 退出后 Shell 的目录，不使用交接文件或远端 `pty.claimCwdFile`。
fn shell_handoff(agent: &str) -> bool {
    matches!(agent, "opencode" | "pi")
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
    /// CLI 启动所在的专用空目录（本机 `codex-prewarm`，远端 `~/.qingcode/cli-prewarm`）。
    pub(super) anchor: String,
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
            if let Some(reason) = startup_blocker(
                &self.agent,
                &claude_rows(self.screen.screen()),
                &self.anchor,
                &self.nonce,
            ) {
                return Err(reason.into());
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
    /// PTY. Target projects and other Claude dialogs stay interactive.
    /// 本机在磁盘上复查专用目录；远端由启动脚本在启动 Claude 前校验同一条件。
    async fn trust_claude_anchor(
        &mut self,
        session: &mut DaemonSession,
        id: &str,
        cwd: &str,
        local: bool,
    ) -> Result<(), String> {
        self.wait_for(session, id, |v| {
            let screen = claude_rows(v.screen.screen());
            claude_composer(&claude_input_rows(v.screen.screen()), "")
                || claude_trust_choice(&screen, cwd).is_some()
        })
        .await?;
        let screen = claude_rows(self.screen.screen());
        if claude_trust_choice(&screen, cwd).is_none() {
            return Ok(());
        }
        let path = Path::new(cwd);
        let check = || -> Result<(), String> {
            if !local {
                return Ok(());
            }
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
            claude_composer(&claude_input_rows(v.screen.screen()), "")
        })
        .await?;
        send_input_to_session(session, id, &self.input_seq, b"/cd".to_vec())
            .await
            .map_err(|e| e.0)?;
        self.wait_for(session, id, |v| {
            let content = claude_rows(v.screen.screen());
            claude_composer(&claude_input_rows(v.screen.screen()), "/cd")
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
            claude_composer(&claude_input_rows(v.screen.screen()), &draft)
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
            claude_composer(&claude_input_rows(screen), "")
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
        let record_stage = |stage, agent: &str, started: Instant| {
            trace(
                stage,
                serde_json::json!({"agent": agent, "ms": started.elapsed().as_millis() as u64}),
            );
        };
        if shell_handoff(&self.agent) {
            validate()?;
            let nonce = self.nonce.clone();
            send_input_to_session(session, id, &self.input_seq, remote_input_line(cwd))
                .await
                .map_err(|error| error.0)?;
            session.wait_shell_marker(id, &nonce, "cwd").await?;
            if self.agent == "opencode" {
                self.wait_for(session, id, |view| {
                    view.screen.screen().contents().contains("Ask anything…")
                })
                .await?;
            }
            return validate();
        }
        if self.agent == "claude" {
            if cwd != crate::terminal::strip_windows_verbatim_prefix(anchor) {
                let started = Instant::now();
                self.claude_cd(session, id, cwd, true, &validate).await?;
                record_stage("cli_cwd_switch", &self.agent, started);
            }
            let started = Instant::now();
            self.claude_cd(session, id, cwd, false, &validate).await?;
            record_stage("cli_cwd_verify", &self.agent, started);
            return Ok(());
        }
        let anchor = crate::terminal::strip_windows_verbatim_prefix(anchor);
        if cwd != anchor {
            let started = Instant::now();
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
            record_stage("cli_cwd_switch", &self.agent, started);
        }
        let started = Instant::now();
        self.submit(session, id, "/pwd", validate).await?;
        self.wait_for(session, id, |view| view.directory_confirmed(PWD, cwd))
            .await?;
        record_stage("cli_cwd_verify", &self.agent, started);
        Ok(())
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

/// 输入框判定用的画面：去掉暗色（dim）单元格。Claude 空输入框会以暗色显示
/// `Try "..."` 之类的示例占位，直接按文本判断会误认为已有输入，预热一直等到超时。
fn claude_input_rows(screen: &vt100::Screen) -> String {
    let (rows, cols) = screen.size();
    (0..rows.get())
        .map(|row| {
            let mut line = String::new();
            for col in 0..cols.get() {
                let Some(cell) = screen.cell(row, col) else {
                    continue;
                };
                if cell.is_wide_continuation() {
                    continue;
                }
                if cell.dim() || !cell.has_contents() {
                    line.push(' ');
                } else {
                    line.push_str(cell.contents());
                }
            }
            line.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join(
            "
",
        )
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
    prepare_at(entry, target, &cwd, &cwd).await
}

/// `cwd` 是 CLI 的专用空启动目录；`launch_dir` 是创建 PTY 时已存在的目录。
/// 远端专用目录可能尚不存在，由启动脚本在家目录下创建并校验为空、非链接后进入。
pub(super) async fn prepare_at(
    entry: &mut WarmShell,
    target: &Target,
    cwd: &str,
    launch_dir: &str,
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
    let handoff = (!remote && !shell_handoff(agent))
        .then(tempfile::NamedTempFile::new)
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut env = target.launch.env.clone();
    let cwd_file = remote && !shell_handoff(agent);
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
    env.insert("QINGCODE_CODEX_ANCHOR".into(), cwd.into());
    env.insert("QINGCODE_PREWARM_AGENT".into(), agent.into());
    env.insert("QINGCODE_PREWARM_NONCE".into(), nonce.clone());
    env.extend(crate::terminal::terminal_identity_env(&entry.id).map(|(k, v)| (k.into(), v)));
    let script = launch_script(agent, powershell);
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
        args.extend(["-NoExit".into(), "-Command".into(), script]);
        args
    };
    let shell = if remote && !powershell {
        Some("/bin/sh")
    } else {
        target.launch.shell.as_deref()
    };
    let session = entry.session.as_mut().ok_or("CLI 预热会话不可用")?;
    let created = session.request("pty.createTransient", &serde_json::json!({
        "cwd": launch_dir, "claimCwdFile": cwd_file, "shell": shell, "args": args, "env": env, "cols": 120, "rows": 30
    })).await.map_err(|error| match session.closed_reason() {
        Some(_) => session_error(session, error),
        // 建 PTY 失败时 CLI 还没启动，不能据此判定 CLI 未就绪。
        None => transport_error(error),
    })?;
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
        anchor: cwd.into(),
    };
    let ready = tokio::time::timeout(READY_TIMEOUT, async {
        if shell_handoff(agent) {
            return session
                .wait_shell_marker(&entry.pty_id, &nonce, "ready")
                .await
                .map(|_| ());
        }
        if agent == "claude" {
            codex
                .trust_claude_anchor(session, &entry.pty_id, cwd, !remote)
                .await?;
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
    .map_err(|_| {
        if agent == "codex"
            && !codex.screen.callbacks().idle
            && idle(&codex.screen.screen().contents())
        {
            HANDOFF_UNAVAILABLE.to_string()
        } else {
            READY_TIMED_OUT.to_string()
        }
    })
    .and_then(|result| result)
    .map_err(|error| session_error(session, error));
    if ready.as_ref().is_err_and(|error| error == READY_TIMED_OUT) {
        super::trace(
            "ready_timeout_screen",
            serde_json::json!({
                "agent": agent,
                "remote": remote,
                "screen": screen_tail_for_diagnostics(&codex.screen.screen().contents(), cwd),
            }),
        );
    }
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
