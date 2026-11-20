//! 普通 Shell 的空闲池（本机 Windows；远端 Server 模式的 Windows 与 Linux/macOS）。
//! 每个预热会话持有一个 transient PTY，
//! 未领取时关闭连接即可由 daemon 回收；正式终端仍走原有持久化链路。
//!
//! 本机目标由项目窗口协调；远端由 connections 按已认证连接补充，空闲时在用户主目录，
//! 领取时确认项目目录后才交付启动命令。
mod codex;
mod connections;
use super::*;
use crate::path_guard::PathAllowlist;
use crate::terminal::{hosted_local_launch, HostedLaunchRequest};
pub(crate) use codex::LocalCodexPool;
pub(crate) use connections::ConnectionShellPools;
use qingcode_server::ipc::{IpcEndpoint, IpcStream};
use std::time::Instant;
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const GIB: u64 = 1024 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const RESERVATION_TTL: Duration = Duration::from_secs(15);
/// 本机领取只经命名管道；远端领取要经过 SSH 往返，给更宽的上限。
const LOCAL_CLAIM_TIMEOUT: Duration = Duration::from_secs(2);
const REMOTE_CLAIM_TIMEOUT: Duration = Duration::from_secs(5);
/// daemon 支持在 `pty.claim` 时改记工作目录。
const CLAIM_CWD_CAPABILITY: &str = "pty.claimCwd";

/// 复用条件：同一主机上启动参数相同。工作目录不在键里，见 [`WarmShell::can_rebind`]。
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrewarmProfile {
    #[serde(default)] // Only remote profiles supply a directory.
    cwd: String,
    #[serde(skip)]
    cross_project: bool,
    profile_id: String,
    shell: String,
    command: String,
}

#[derive(Clone, PartialEq, Eq)]
struct LaunchKey {
    /// `None` 为本机 PTY 宿主；远端为 SSH 连接 id。
    host: Option<String>,
    profile: Option<PrewarmProfile>,
    shell: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}
impl LaunchKey {
    fn from_parts(host: Option<String>, launch: &PersistentLaunch) -> Self {
        Self {
            host,
            profile: None,
            shell: launch.shell.clone(),
            args: launch.args.clone(),
            env: launch.env.clone(),
        }
    }
}

/// 本机项目：规范化后的目录、启动参数与复用键。
fn local_launch_key(
    cwd: &str,
    shell: Option<&str>,
) -> Result<(String, PersistentLaunch, LaunchKey), String> {
    let launch = resolve_launch(cwd, shell)?;
    let cwd = std::fs::canonicalize(cwd).map_err(|error| error.to_string())?;
    let key = LaunchKey::from_parts(None, &launch);
    Ok((cwd.to_string_lossy().into_owned(), launch, key))
}

/// 远端目标：已认证的 daemon 和允许打开传输的受信任项目根。
#[derive(Clone)]
struct RemoteTarget {
    root: RegisteredRoot,
    connection_id: String,
    daemon: server::DaemonAccess,
    incarnation: Option<Arc<()>>,
    direct_peer: Option<(String, String)>,
}

#[derive(Clone)]
struct Target {
    project_path: String,
    /// 新预热项的启动目录：本机为规范化路径，远端为空，表示由 daemon 在用户主目录启动。
    cwd: String,
    key: LaunchKey,
    launch: PersistentLaunch,
    count: usize,
    window: String,
    remote: Option<RemoteTarget>,
}

struct WarmShell {
    id: String,
    pty_id: String,
    key: LaunchKey,
    /// 启动目录，与 [`Target::cwd`] 同一形态；领取到其他目录时需要切换。
    cwd: String,
    /// daemon 能在领取时改记目录（远端切换目录的前提）。
    claim_cwd: bool,
    launch: PersistentLaunch,
    remote: Option<RemoteTarget>,
    codex: Option<codex::CodexSession>,
    startup_pipe: Option<IpcStream>,
    /// 远端 PowerShell 预热项在 profile 后停住，等领取方经 PTY 输入交付一行（可为空）。
    startup_input: bool,
    marker: String,
    from_seq: u64,
    input_seq: AtomicU64,
    session: Option<DaemonSession>,
    transport: Option<SessionTransport>,
    reserved_at: Option<Instant>,
}
impl WarmShell {
    /// 远端先切换目录并由 daemon 改记 PTY 工作目录，供接回时验证项目根。
    fn can_rebind(&self) -> bool {
        if self.key.profile.is_some() {
            return self.codex.is_some() && self.claim_cwd;
        }
        match &self.remote {
            None => self.startup_pipe.is_some(),
            Some(_) => self.claim_cwd && self.input_mode().is_some(),
        }
    }

    /// 远端预热项领取时经 PTY 输入交付目录与命令的方式；不支持的 Shell 为 None。
    fn input_mode(&self) -> Option<RemoteInput> {
        let remote = self.remote.as_ref()?;
        RemoteInput::for_launch(
            &remote.root.canonical_path,
            &self.launch,
            self.startup_input,
        )
    }

    fn alive(&mut self) -> bool {
        let Some(session) = &mut self.session else {
            return true;
        };
        session.closed_reason().is_none()
            && !session.drain_idle_pty(&self.pty_id, |bytes| {
                if let Some(codex) = &mut self.codex {
                    codex.screen.process(bytes);
                }
            })
    }

    fn has_startup_channel(&self) -> bool {
        self.startup_pipe.is_some()
            || self.startup_input
            || matches!(self.input_mode(), Some(RemoteInput::Posix(_)))
    }
}

impl Drop for WarmShell {
    fn drop(&mut self) {
        if let Some(session) = &self.session {
            session.shutdown();
        }
        // 远端预热项占用共享终端连接的一个通道，回收时归还租约。
        if let Some(transport) = &self.transport {
            transport.release();
        }
    }
}
#[derive(Default)]
struct PoolState {
    /// 最近获得原生焦点的窗口。应用在后台或预热关闭时仍保留，直到移交或销毁。
    coordinator: Option<String>,
    target: Option<Target>,
    generation: u64,
    shells: Vec<WarmShell>,
    running: bool,
    paused_reason: Option<&'static str>,
    preparing: bool,
}
#[derive(Clone, Default)]
pub(crate) struct ShellPrewarmPool(Arc<Mutex<PoolState>>, Arc<Notify>, Arc<Notify>);

/// auto 固定保留 1 个：领取后会立即补充，常驻更多只对极快的连续新建有帮助。
fn resolve_count(value: &serde_json::Value) -> usize {
    value.as_u64().map_or(1, |count| count.min(8) as usize)
}

/// 预热链路的诊断事件：配置、就绪、失败、丢弃与领取结果，便于在用户机器上排查未命中。
/// 不记录路径与命令，只记录阶段、原因与耗时。
fn trace(stage: &str, mut fields: serde_json::Value) {
    fields["stage"] = stage.into();
    qingcode_server::diagnostics::record("terminal.prewarm", fields, false, false);
}

fn under_pressure(total: u64, available: u64) -> bool {
    total > 0 && available < (total / 10).max(GIB)
}

fn resolve_launch(cwd: &str, shell: Option<&str>) -> Result<PersistentLaunch, String> {
    hosted_local_launch(
        cwd,
        HostedLaunchRequest {
            shell,
            startup: None,
            env: HashMap::new(),
            name: None,
        },
    )?
}

/// 走 Server 模式（远端 daemon 托管 PTY）的 SSH 项目才预热；Windows 与 POSIX 远端都支持。
fn remote_server_connection(manager: &SshManager, cwd: &str) -> Option<String> {
    let parsed = parse_remote_uri(cwd).ok()?;
    manager
        .server_mode(&parsed.connection_id)
        .then_some(parsed.connection_id)
}

/// 远端 Shell 的原生工作目录：Windows 为 `C:\...`，POSIX 为绝对路径本身。
fn remote_native_directory(path: &str) -> Option<String> {
    windows_native_path(path).or_else(|| path.starts_with('/').then(|| path.to_string()))
}

/// POSIX 远端交互 Shell 的输入写法。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PosixShell {
    /// sh，或「自动」（登录用户的 `$SHELL`，可能是 fish 等）：只用各家通用的写法。
    Plain,
    /// bash / zsh：用 `builtin` 绕开用户定义的同名函数（如 zoxide 接管的 cd）。
    Builtin,
}

/// 远端预热项交付目录（与命令）的方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RemoteInput {
    /// profile 之后读取一行 base64（不回显）。
    PowerShell,
    /// 普通 CMD 输入，只支持普通终端。
    Cmd,
    /// 交互 Shell 的普通输入：rc 照常加载，行首空格让开启 ignorespace 的 Shell 不记入历史。
    Posix(PosixShell),
}
impl RemoteInput {
    pub(crate) fn for_launch(
        root_path: &str,
        launch: &PersistentLaunch,
        powershell_ready: bool,
    ) -> Option<Self> {
        if windows_native_path(root_path).is_some() {
            return if powershell_ready {
                Some(Self::PowerShell)
            } else {
                (launch.resolved_shell == "cmd").then_some(Self::Cmd)
            };
        }
        match launch.resolved_shell.as_str() {
            "sh" | "auto" => Some(Self::Posix(PosixShell::Plain)),
            "bash" | "zsh" => Some(Self::Posix(PosixShell::Builtin)),
            _ => None,
        }
    }
}

/// 与 `ssh_create_terminal` 相同的启动参数；两侧一致才能命中。
fn remote_launch_key(
    cwd: &str,
    shell: Option<&str>,
) -> Result<(PersistentLaunch, LaunchKey), String> {
    let parsed = parse_remote_uri(cwd)?;
    let launch = crate::remote_ssh::terminal_cmds::persistent_shell_launch(&parsed.path, shell)?;
    let key = LaunchKey::from_parts(Some(parsed.connection_id), &launch);
    Ok((launch, key))
}

impl RemoteTarget {
    fn connected(manager: &SshManager, id: &str, root: &RegisteredRoot) -> Option<Self> {
        if !manager.connection_is_open(id) || !manager.server_mode(id) {
            return None;
        }
        let direct = manager.direct_config(id);
        let direct_peer = direct
            .as_ref()
            .map(|cfg| (cfg.endpoint.clone(), cfg.certificate_fingerprint.clone()));
        let daemon = match direct {
            Some(config) => server::DaemonAccess {
                bin: "direct".into(),
                token: config.token,
            },
            None => {
                manager
                    .server_slot(&server::server_slot_key(id, &root.canonical_path))
                    .and_then(|s| s.endpoint)?
                    .daemon?
            }
        };
        let incarnation = manager
            .session(id)
            .ok()
            .map(|s| s.server_incarnation.clone());
        Some(Self {
            root: root.clone(),
            connection_id: id.into(),
            daemon,
            incarnation,
            direct_peer,
        })
    }

    fn same_connection(&self, other: &Self) -> bool {
        self.connection_id == other.connection_id
            && self.direct_peer == other.direct_peer
            && self.daemon == other.daemon
            && match (&self.incarnation, &other.incarnation) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            }
    }
}
fn remote_target_valid(manager: &SshManager, remote: &RemoteTarget) -> bool {
    manager
        .registered_root(&remote.root.uri)
        .ok()
        .filter(|root| root.trusted && root.canonical_path == remote.root.canonical_path)
        .and_then(|root| RemoteTarget::connected(manager, &remote.connection_id, &root))
        .is_some_and(|binding| binding.same_connection(remote))
}

impl PoolState {
    // Keep at most one extra transient PTY while a reservation is waiting for its view.
    fn refill_slots(&self, count: usize) -> usize {
        if self
            .target
            .as_ref()
            .is_some_and(|target| target.key.profile.is_some())
        {
            return count.saturating_sub(self.shells.len());
        }
        let idle = self
            .shells
            .iter()
            .filter(|s| s.reserved_at.is_none())
            .count();
        count
            .saturating_sub(idle)
            .min((count + 1).saturating_sub(self.shells.len()))
    }

    fn trim_idle(&mut self, target: &Target) {
        let mut remaining = target.count;
        self.shells.retain(|entry| {
            if entry.key != target.key {
                return false;
            }
            if let Some(at) = entry.reserved_at {
                return at.elapsed() < RESERVATION_TTL;
            }
            if remaining == 0 || (entry.cwd != target.cwd && !entry.can_rebind()) {
                return false;
            }
            remaining -= 1;
            true
        });
    }

    fn prune_idle(&mut self) -> usize {
        let before = self.shells.len();
        self.shells.retain_mut(|entry| {
            if !entry.alive() {
                if entry.key.profile.is_some() {
                    // An opted-in command may deliberately exit. Never relaunch it on a timer.
                    self.paused_reason = Some("profile_exited");
                }
                return false;
            }
            entry
                .reserved_at
                .is_none_or(|at| at.elapsed() < RESERVATION_TTL)
        });
        before - self.shells.len()
    }
}

impl ShellPrewarmPool {
    pub(crate) fn focus_window(&self, window: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).coordinator = Some(window.to_owned());
    }

    fn lock_for_window(&self, window: &str) -> Option<std::sync::MutexGuard<'_, PoolState>> {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        (state.coordinator.as_deref() == Some(window)).then_some(state)
    }

    pub(crate) fn close_window(&self, window: &str) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.coordinator.as_deref() == Some(window) {
            state.coordinator = None;
        } else if state.target.as_ref().is_none_or(|t| t.window != window) {
            return;
        }
        self.clear(&mut state, window);
    }

    pub(crate) fn clear_window(&self, window: &str) {
        if let Some(mut state) = self.lock_for_window(window) {
            self.clear(&mut state, window);
        }
    }

    fn clear(&self, state: &mut PoolState, window: &str) {
        trace(
            "cleared",
            serde_json::json!({"window": window, "dropped": state.shells.len()}),
        );
        state.target = None;
        state.generation += 1;
        state.preparing = false;
        state.paused_reason = None;
        state.shells.clear();
        self.1.notify_waiters();
    }

    fn stop(&self) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.target.is_none() {
            return;
        }
        self.clear(&mut state, "connection");
        self.2.notify_one();
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn configure(
        &self,
        app: &AppHandle,
        window: &str,
        cwd: Option<String>,
        shell: Option<String>,
        count: serde_json::Value,
        profile: Option<PrewarmProfile>,
        local_profile: Option<PrewarmProfile>,
        anchored_profiles: Vec<PrewarmProfile>,
    ) -> Result<usize, String> {
        let Some(mut state) = self.lock_for_window(window) else {
            return Ok(0);
        };
        let count = resolve_count(&count);
        app.state::<LocalCodexPool>()
            .configure(app, window, local_profile.filter(|_| count > 0));
        app.state::<ConnectionShellPools>().set_profiles(
            window,
            profile,
            anchored_profiles,
            count > 0,
        );
        if let Some(shell) = &shell {
            app.state::<ConnectionShellPools>()
                .configure(app, shell, count);
        }
        // A projectless or remote-only window may update the global setting while
        // another window still owns the local project. Keep that project's budget.
        let local_owner = state.target.as_ref().map(|t| t.window.as_str());
        let owns_local = local_owner.is_none_or(|owner| owner == window);
        if count == 0 || shell.as_deref() == Some("wsl") {
            if shell.is_some() || owns_local {
                self.clear(&mut state, window);
            }
            return Ok(0);
        }
        let (cwd, owner) = match cwd.filter(|path| !path.starts_with(SSH_URI_PREFIX)) {
            Some(path) if cfg!(windows) => (path, window.to_owned()),
            _ if !owns_local => {
                let target = state.target.as_ref().unwrap();
                (target.project_path.clone(), target.window.clone())
            }
            _ => {
                self.clear(&mut state, window);
                return Ok(0);
            }
        };
        app.state::<PathAllowlist>().ensure_executable(&cwd)?;
        let (target_cwd, launch, key) = local_launch_key(&cwd, shell.as_deref())?;
        self.set_target(
            app,
            &mut state,
            Target {
                project_path: cwd,
                cwd: target_cwd,
                key,
                launch,
                count,
                window: owner,
                remote: None,
            },
        );
        Ok(count)
    }

    fn configure_target(&self, app: &AppHandle, target: Target) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        self.set_target(app, &mut state, target);
    }

    fn set_target(&self, app: &AppHandle, state: &mut PoolState, target: Target) {
        let same_transport = match (
            state.target.as_ref().and_then(|t| t.remote.as_ref()),
            &target.remote,
        ) {
            (Some(a), Some(b)) => {
                a.same_connection(b)
                    && (target.key.profile.is_none()
                        || a.root.canonical_path == b.root.canonical_path)
            }
            (None, None) => true,
            _ => false,
        };
        let changed = !same_transport
            || state.target.as_ref().is_none_or(|old| {
                old.key != target.key
                    || old.count != target.count
                    || old.window != target.window
                    || (target.remote.is_none()
                        && target.launch.resolved_shell == "cmd"
                        && old.cwd != target.cwd)
            });
        if changed {
            if !same_transport {
                state.shells.clear();
            }
            state.trim_idle(&target);
            trace(
                "configured",
                serde_json::json!({"count": target.count, "remote":target.remote.is_some()}),
            );
            state.generation += 1;
            state.preparing = false;
            state.paused_reason = None;
            self.1.notify_waiters();
            self.2.notify_one();
        }
        state.target = Some(target);
        if !state.running {
            state.running = true;
            let pool = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move { pool.run(app).await });
        }
    }

    pub(crate) fn status(&self, cwd: &str) -> serde_json::Value {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(target) = state.target.as_ref().filter(|t| {
            t.project_path == cwd
                || t.remote.is_none() && t.key.profile.is_some() && !cwd.starts_with(SSH_URI_PREFIX)
                || (t.key.profile.is_none()
                    || t.key.profile.as_ref().is_some_and(|p| p.cross_project))
                    && t.remote
                        .as_ref()
                        .is_some_and(|r| remote_uri_connection_id(cwd) == Some(&r.connection_id))
        }) else {
            return serde_json::json!({"target": 0, "ready": 0, "preparing": 0, "reserved": 0,
                "reason": if state.target.is_some() { "other_project" } else { "no_target" }});
        };
        let matching = state.shells.iter().filter(|s| s.key == target.key);
        let ready = matching.clone().filter(|s| s.reserved_at.is_none()).count();
        let reserved = matching.count() - ready;
        serde_json::json!({"target": target.count, "ready": ready, "preparing": usize::from(state.preparing),
            "reserved": reserved, "reason": state.paused_reason})
    }

    pub(crate) fn reserve(
        &self,
        cwd: &str,
        shell: Option<&str>,
        has_startup: bool,
    ) -> Result<String, &'static str> {
        let remote = cwd.starts_with(SSH_URI_PREFIX);
        let attempt = || {
            {
                let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                if state.shells.is_empty() {
                    return Err(if state.target.is_none() {
                        "no_target"
                    } else {
                        state.paused_reason.unwrap_or(if state.preparing {
                            "preparing"
                        } else {
                            "empty"
                        })
                    });
                }
            }
            let (cwd, key) = if remote {
                remote_launch_key(cwd, shell).map(|(_, key)| (cwd.to_string(), key))
            } else {
                local_launch_key(cwd, shell).map(|(cwd, _, key)| (cwd, key))
            }
            .map_err(|_| "launch_unavailable")?;
            self.reserve_key(&key, &cwd, has_startup)
        };
        let result = attempt();
        match &result {
            Ok(_) => trace("reserved", serde_json::json!({"remote": remote})),
            Err(reason) => trace(
                "reserve_miss",
                serde_json::json!({"reason": reason, "remote": remote}),
            ),
        }
        result
    }

    /// 预留一个空闲项并改按调用方的终端 id 领取。手机终端必须用 `mobile-` 前缀的 id
    /// 才能把输出路由给手机；电脑端重启要沿用原标签 id。之后照常用 `take` / `take_remote` 领取。
    pub(crate) fn reserve_as(
        &self,
        id: &str,
        cwd: &str,
        shell: Option<&str>,
        has_startup: bool,
    ) -> Result<(), &'static str> {
        // 同一 id 已有未过期的预留（例如上次重启未领取）时不再占用第二个空闲项。
        if self.has_entry(id) {
            trace(
                "reserve_miss",
                serde_json::json!({"reason": "id_in_use", "remote": cwd.starts_with(SSH_URI_PREFIX)}),
            );
            return Err("id_in_use");
        }
        let warm_id = self.reserve(cwd, shell, has_startup)?;
        self.rename_reserved(&warm_id, id)
    }

    fn rename_reserved(&self, warm_id: &str, id: &str) -> Result<(), &'static str> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // 预留期间另一请求已占用同一 id：放回空闲，按未命中处理。
        if state.shells.iter().any(|entry| entry.id == id) {
            if let Some(entry) = state.shells.iter_mut().find(|entry| entry.id == warm_id) {
                entry.reserved_at = None;
                if let Some(target) = state.target.clone() {
                    state.trim_idle(&target);
                }
            }
            return Err("id_in_use");
        }
        // 预留与改名之间池可能被重配清空，此时按未命中处理。
        let entry = state
            .shells
            .iter_mut()
            .find(|entry| entry.id == warm_id && entry.reserved_at.is_some())
            .ok_or("empty")?;
        entry.id = id.to_string();
        Ok(())
    }

    fn reserve_key(
        &self,
        key: &LaunchKey,
        cwd: &str,
        has_startup: bool,
    ) -> Result<String, &'static str> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // A dead primary must not hide a ready standby before the next maintenance tick.
        if state.prune_idle() > 0 {
            self.2.notify_one();
        }
        let mut idle_entries = state
            .shells
            .iter()
            .filter(|entry| entry.reserved_at.is_none())
            .peekable();
        if idle_entries.peek().is_none() {
            return Err(if state.shells.is_empty() {
                if state.preparing {
                    "preparing"
                } else {
                    "empty"
                }
            } else {
                "all_reserved"
            });
        }
        let entry = idle_entries
            .find(|entry| entry.key.host == key.host)
            .ok_or("host_mismatch")?;
        if entry.key.shell != key.shell {
            return Err("shell_mismatch");
        }
        if entry.key.args != key.args {
            return Err("args_mismatch");
        }
        if entry.key.env != key.env {
            return Err("env_mismatch");
        }
        let idle = |entry: &WarmShell| entry.reserved_at.is_none() && entry.key == *key;
        let startup_ok = |entry: &WarmShell| !has_startup || entry.has_startup_channel();
        // 优先原目录的预热项；否则取能切换目录的项。
        let index = state
            .shells
            .iter()
            .position(|entry| idle(entry) && entry.cwd == cwd && startup_ok(entry))
            .or_else(|| {
                state.shells.iter().position(|entry| {
                    idle(entry) && entry.cwd != cwd && entry.can_rebind() && startup_ok(entry)
                })
            });
        let Some(index) = index else {
            let same_cwd = state
                .shells
                .iter()
                .any(|entry| idle(entry) && entry.cwd == cwd);
            return Err(if same_cwd {
                "startup_unsupported"
            } else {
                "cwd_mismatch"
            });
        };
        let entry = &mut state.shells[index];
        entry.reserved_at = Some(Instant::now());
        self.2.notify_one();
        Ok(entry.id.clone())
    }

    pub(crate) fn has_entry(&self, id: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .shells
            .iter()
            .any(|entry| entry.id == id)
    }

    pub(crate) fn reserve_profile(
        &self,
        cwd: &str,
        shell: Option<&str>,
        profile_id: &str,
        command: &str,
    ) -> Option<String> {
        let (_, mut key) = remote_launch_key(cwd, shell).ok()?;
        let profile = self.0.lock().ok()?.target.as_ref()?.key.profile.clone()?;
        if profile.profile_id != profile_id || profile.shell != shell? || profile.command != command
        {
            return None;
        }
        key.profile = Some(profile);
        self.reserve_key(&key, cwd, false).ok()
    }

    /// 同 [`Self::reserve_profile`]，命中后改按调用方的终端 id 领取（手机终端需 `mobile-` id）。
    pub(crate) fn reserve_profile_as(
        &self,
        id: &str,
        cwd: &str,
        shell: Option<&str>,
        profile_id: &str,
        command: &str,
    ) -> bool {
        if self.has_entry(id) {
            return false;
        }
        self.reserve_profile(cwd, shell, profile_id, command)
            .is_some_and(|warm_id| self.rename_reserved(&warm_id, id).is_ok())
    }

    /// 本机项目领取。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn take(
        &self,
        id: &str,
        cwd: &str,
        shell: Option<&str>,
        startup: Option<&str>,
        size: (u16, u16),
        app: AppHandle,
        manager: &SshManager,
    ) -> Result<Option<TerminalSpawnResult>, String> {
        if !self.has_entry(id) {
            return Ok(None);
        }
        let (cwd, _, key) = local_launch_key(cwd, shell)?;
        let Some(mut entry) = self.take_key(id, &key, &cwd, true) else {
            trace("take_miss", serde_json::json!({"remote": false}));
            return Ok(None);
        };
        let directory = (entry.cwd != cwd)
            .then(|| crate::terminal::strip_windows_verbatim_prefix(&cwd).into_owned());
        let script = claim_script(directory.as_deref(), startup);
        let mut pipe = entry.startup_pipe.take();
        if let Some(pipe) = &mut pipe {
            // 接回之前只交付命令文本。此时即使管道断开，普通冷启动仍可安全重试。
            if !matches!(
                tokio::time::timeout(
                    LOCAL_CLAIM_TIMEOUT,
                    stage_startup(pipe, script.as_deref().unwrap_or_default())
                )
                .await,
                Ok(Ok(()))
            ) {
                return Ok(None);
            }
        } else if script.is_some() {
            return Ok(None);
        }
        let pty_id = entry.pty_id.clone();
        // 与正常新建相同的 daemon 名称规则：手机终端用 `mobile-` id，电脑重启后才能找回。
        let name = daemon_terminal_name(id, None);
        let Some(result) = self
            .attach(id, entry, name, directory, size, app, manager)
            .await
        else {
            return Ok(None);
        };
        if let Some(mut pipe) = pipe {
            // 宿主已接回，才允许 PowerShell 执行。提交后的应答可能丢失，绝不能重跑命令。
            let committed = tokio::time::timeout(LOCAL_CLAIM_TIMEOUT, async {
                pipe.write_u8(1).await?;
                read_startup_ack(&mut pipe).await
            })
            .await;
            if !matches!(committed, Ok(Ok(()))) {
                drop(pipe);
                let _ = kill_owned(&pty_id, "prewarm_attach_failed", false, manager).await;
                return Err("预热 PowerShell 启动确认失败".into());
            }
        }
        record_hit(id, false);
        Ok(Some(result))
    }

    /// 远端 SSH 项目领取：同一连接上启动参数一致即可。`launch` 是不带启动命令的
    /// 普通 Shell 参数（复用键），配置终端的命令经 `startup` 在接回后通过 PTY 输入交付。
    /// Shell 确认进入已校验的项目目录后才领取，并让 daemon 记录该目录以供接回。
    /// 未命中返回 None 走正常新建；命令交付失败返回错误，不再冷启动，避免执行两次。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn take_remote(
        &self,
        id: &str,
        cwd: &str,
        working_directory: &str,
        launch: &PersistentLaunch,
        startup: Option<&str>,
        root: &RegisteredRoot,
        size: (u16, u16),
        app: AppHandle,
        manager: &SshManager,
    ) -> Option<Result<TerminalSpawnResult, String>> {
        if !self.has_entry(id) {
            return None;
        }
        let connection_id = parse_remote_uri(cwd).ok()?.connection_id;
        let mut key = LaunchKey::from_parts(Some(connection_id), launch);
        let (profile, generation) = {
            let state = self.0.lock().ok()?;
            (state.target.as_ref()?.key.profile.clone(), state.generation)
        };
        let cross_project = profile.as_ref().is_some_and(|p| p.cross_project);
        if let Some(profile) = &profile {
            if (!cross_project && profile.cwd != cwd) || Some(profile.command.as_str()) != startup {
                return None;
            }
        }
        key.profile = profile;
        let native = remote_native_directory(working_directory);
        let Some(mut entry) = self.take_key(id, &key, cwd, cross_project || native.is_some())
        else {
            trace("take_miss", serde_json::json!({"remote": true}));
            return None;
        };
        let remote = entry.remote.as_ref()?;
        if key.profile.is_none() && startup.is_some() && !entry.has_startup_channel() {
            return None;
        }
        let current = match manager.root_for_uri(cwd, true) {
            Ok(current)
                if current.uri == root.uri && current.canonical_path == root.canonical_path =>
            {
                current
            }
            _ => return Some(Err("预热领取期间项目授权已变化".into())),
        };
        if !RemoteTarget::connected(manager, &remote.connection_id, root)
            .is_some_and(|binding| binding.same_connection(remote))
        {
            trace(
                "take_stale",
                serde_json::json!({"remote": true, "reason": "connection"}),
            );
            return None;
        }
        if cross_project {
            let binding = RemoteTarget {
                root: current.clone(),
                ..remote.clone()
            };
            let valid = || {
                if self
                    .0
                    .lock()
                    .map(|s| s.generation == generation)
                    .unwrap_or(false)
                    && remote_target_valid(manager, remote)
                    && remote_target_valid(manager, &binding)
                {
                    Ok(())
                } else {
                    Err("项目授权、预热配置或远程连接已变化".into())
                }
            };
            let directory = native.as_deref().unwrap_or(working_directory);
            let anchor_path = windows_native_path(&remote.root.canonical_path);
            let anchor = anchor_path
                .as_deref()
                .unwrap_or(&remote.root.canonical_path);
            if let Err(error) = valid() {
                return Some(Err(error));
            }
            if current.uri != cwd || directory.chars().any(char::is_control) {
                return None;
            }
            let adapter = entry.codex.as_mut()?;
            let switched = tokio::time::timeout(
                adapter.switch_timeout(),
                adapter.enter(
                    entry.session.as_mut()?,
                    &entry.pty_id,
                    directory,
                    anchor,
                    &valid,
                ),
            )
            .await;
            if let Err(error) = valid() {
                return Some(Err(error));
            }
            if !matches!(switched, Ok(Ok(()))) {
                return None;
            }
            let parsed = parse_remote_uri(cwd).ok()?;
            // Re-resolve the registered path after waiting for the CLI. A
            // replaced symlink or a reconnect must not rebind this PTY.
            let recheck = async {
                let sftp = manager.open_sftp(&parsed.connection_id).await?;
                let path = ensure_existing_path_within(&sftp, &parsed.path, &current).await?;
                if path != working_directory {
                    return Err("领取期间远程项目目录已变化".into());
                }
                valid()
            };
            match tokio::time::timeout(REMOTE_CLAIM_TIMEOUT, recheck).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return Some(Err(error)),
                Err(_) => return Some(Err("重新校验远程项目目录超时".into())),
            }
            entry.remote.as_mut()?.root = current;
            let result = self
                .attach(
                    id,
                    entry,
                    daemon_terminal_name(id, launch.name.as_deref()),
                    Some(working_directory.into()),
                    size,
                    app,
                    manager,
                )
                .await?;
            record_hit(id, true);
            return Some(Ok(result));
        }
        let directory = native?;
        let input = entry.input_mode().and_then(|mode| {
            Some((
                mode,
                directory_input(&directory, mode, &entry.marker)?,
                startup_input_line(startup.unwrap_or_default().trim(), mode)?,
            ))
        });
        let Some((_, line, startup_line)) = input else {
            trace(
                "take_stale",
                serde_json::json!({"remote": true, "reason": "input"}),
            );
            return None;
        };
        match entry
            .session
            .as_mut()?
            .enter_prewarm_directory(&entry.pty_id, &entry.input_seq, &entry.marker, line)
            .await
        {
            Ok(seq) => entry.from_seq = seq,
            Err(_) => {
                trace("cwd_failed", serde_json::json!({"remote": true}));
                return None;
            }
        }
        // Trust and the authenticated connection may change while awaiting the PTY.
        let binding = RemoteTarget {
            root: current.clone(),
            ..remote.clone()
        };
        if !remote_target_valid(manager, &binding) {
            return Some(Err("预热领取期间项目授权或远程连接已变化".into()));
        }
        entry.remote.as_mut()?.root = current;
        // 与正常新建相同的 daemon 名称规则，接回孤儿终端时才能恢复标签名。
        let name = daemon_terminal_name(id, launch.name.as_deref());
        let claim_cwd = Some(working_directory.to_string());
        let result = self
            .attach(id, entry, name, claim_cwd, size, app, manager)
            .await?;
        if !startup_line.is_empty() {
            let line = startup_line;
            let terminal = manager
                .persistent_terminals
                .read()
                .ok()
                .and_then(|terminals| terminals.get(id).cloned());
            let delivered = terminal.as_ref().map(|terminal| terminal.write(line));
            if !matches!(delivered, Some(Ok(()))) {
                trace(
                    "startup_failed",
                    serde_json::json!({"remote": true, "command": startup.is_some(), "rebind": true}),
                );
                let terminal = manager
                    .persistent_terminals
                    .write()
                    .ok()
                    .and_then(|mut t| t.remove(id));
                if let Some(terminal) = terminal {
                    let _ = terminal.kill().await;
                }
                return Some(Err("预热 Shell 启动命令交付失败".to_string()));
            }
        }
        record_hit(id, true);
        Some(Ok(result))
    }

    #[allow(clippy::too_many_arguments)]
    async fn attach(
        &self,
        id: &str,
        mut entry: WarmShell,
        name: Option<String>,
        cwd: Option<String>,
        size: (u16, u16),
        app: AppHandle,
        manager: &SshManager,
    ) -> Option<TerminalSpawnResult> {
        let cleanup_app = app.clone();
        let remote = entry.remote.clone();
        let (host, connection_id, client_id, limit) = match &remote {
            Some(remote) => (
                TerminalHost::Remote(remote.root.clone()),
                remote.connection_id.clone(),
                manager.daemon_client_id(&remote.connection_id),
                REMOTE_CLAIM_TIMEOUT,
            ),
            None => (
                TerminalHost::Local,
                LOCAL_CONNECTION_ID.to_string(),
                local_client_id(manager),
                LOCAL_CLAIM_TIMEOUT,
            ),
        };
        // 缓存失活不能让新建终端等待完整的 daemon 请求超时。
        let result = tokio::time::timeout(limit, async {
            let session = entry.session.as_ref().ok_or("预热会话不可用")?;
            let mut claim = serde_json::json!({ "id": entry.pty_id });
            if let Some(name) = name {
                claim["name"] = name.into();
            }
            // 旧 daemon 不认识 cwd：远端在预留时已排除，本机宿主没有项目根校验，不传即可。
            if let Some(cwd) = cwd.filter(|_| session.supports(CLAIM_CWD_CAPABILITY)) {
                claim["cwd"] = cwd.into();
            }
            session.request("pty.claim", &claim).await?;
            let session = entry.session.take().ok_or("预热会话不可用")?;
            // 租约随会话一起交给正式终端，由其结束时归还。
            let transport = entry.transport.take().unwrap_or(SessionTransport::Local);
            attach_terminal_on_session(
                id.to_string(),
                entry.pty_id.clone(),
                host,
                connection_id,
                client_id,
                Some(size),
                Some(entry.from_seq),
                transport,
                session,
                app,
                manager,
            )
            .await
        })
        .await;
        match result {
            Ok(Ok(mut result)) => {
                result.prewarm_hit = true;
                result.resolved_shell = Some(entry.launch.resolved_shell.clone());
                result.fallback_from = entry.launch.fallback_from.clone();
                Some(result)
            }
            _ => {
                // claim 的应答也可能丢失，此时仍须清理已转为 detached 的 PTY。
                let pty_id = entry.pty_id.clone();
                drop(entry);
                tauri::async_runtime::spawn(async move {
                    let manager = cleanup_app.state::<SshManager>();
                    let _ = match remote {
                        Some(remote) => {
                            kill_detached_terminal(&pty_id, &remote.root, &cleanup_app, &manager)
                                .await
                        }
                        None => kill_owned(&pty_id, "prewarm_attach_failed", false, &manager).await,
                    };
                });
                None
            }
        }
    }

    /// `allow_rebind` 为 false 时只认原目录的预热项（调用方无法切换到目标目录）。
    fn take_key(
        &self,
        id: &str,
        key: &LaunchKey,
        cwd: &str,
        allow_rebind: bool,
    ) -> Option<WarmShell> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let index = state.shells.iter().position(|entry| {
            entry.id == id
                && &entry.key == key
                && (entry.cwd == cwd || allow_rebind && entry.can_rebind())
                && entry
                    .reserved_at
                    .is_some_and(|at| at.elapsed() < RESERVATION_TTL)
        })?;
        let entry = state.shells.remove(index);
        // 领走即补位；notify_one 会保留许可，补充循环正忙时也不会漏掉。
        self.2.notify_one();
        Some(entry)
    }

    async fn run(self, app: AppHandle) {
        loop {
            // 平时每 1.5 秒复查内存/信任；领取后立即补位。每轮最多创建一个。
            tokio::select! {
                _ = self.2.notified() => {},
                _ = tokio::time::sleep(Duration::from_millis(1500)) => {},
            }
            let changed = self.1.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let (target, generation) = {
                let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                let dropped = state.prune_idle();
                if dropped > 0 {
                    trace("expired", serde_json::json!({"dropped": dropped}));
                }
                let Some(target) = state.target.clone() else {
                    state.running = false;
                    return;
                };
                (target, state.generation)
            };
            let manager = app.state::<SshManager>();
            // 远端预热占用的是远端内存，本机内存压力只约束本机项目。
            let paused_reason = match &target.remote {
                Some(remote) => {
                    (!remote_target_valid(&manager, remote)).then_some("remote_unavailable")
                }
                None => {
                    let mut memory = sysinfo::System::new();
                    memory.refresh_memory();
                    let allowed = if target.key.profile.is_some() {
                        codex::validate_anchor(&app, &target.cwd)
                    } else {
                        app.state::<PathAllowlist>().ensure_executable(&target.cwd)
                    };
                    if allowed.is_err() {
                        Some("untrusted")
                    } else {
                        under_pressure(memory.total_memory(), memory.available_memory())
                            .then_some("memory_pressure")
                    }
                }
            };
            let needs_another = {
                let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                if state.generation != generation {
                    continue;
                }
                if let Some(reason) = paused_reason {
                    let before = state.shells.len();
                    state.shells.clear();
                    if state.paused_reason != Some(reason) {
                        trace(
                            "unusable",
                            serde_json::json!({"reason": reason, "dropped": before - state.shells.len()}),
                        );
                    }
                }
                if paused_reason.is_none()
                    && matches!(
                        state.paused_reason,
                        Some("profile_exited" | "codex_not_ready" | "cli_not_ready")
                    )
                {
                    continue;
                }
                state.paused_reason = paused_reason;
                let slots = state.refill_slots(target.count);
                if paused_reason.is_some() || slots == 0 {
                    continue;
                }
                state.preparing = true;
                slots > 1
            };
            let started = Instant::now();
            let remote = target.remote.is_some();
            let entry = tokio::select! {
                biased;
                _ = &mut changed => {
                    trace("create_cancelled", serde_json::json!({"remote": remote, "ms": started.elapsed().as_millis() as u64}));
                    continue;
                }
                entry = create_warm_shell(&manager, &target) => entry,
            };
            let ms = started.elapsed().as_millis() as u64;
            if let Ok(entry) = entry {
                let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                if state.generation == generation {
                    state.preparing = false;
                    if state.refill_slots(target.count) == 0 {
                        continue;
                    }
                    trace("ready", serde_json::json!({"remote": remote, "ms": ms}));
                    state.shells.push(entry);
                    if needs_another {
                        self.2.notify_one();
                    }
                } else {
                    trace("stale", serde_json::json!({"remote": remote, "ms": ms}));
                }
            } else if let Err(error) = entry {
                trace(
                    "create_failed",
                    serde_json::json!({"remote": remote, "ms": ms, "error": error}),
                );
                // Profile 报错/交互阻塞、旧宿主不支持协议等情况下，避免持续拉起失败 Shell。
                {
                    let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                    if state.generation != generation {
                        continue;
                    }
                    state.preparing = false;
                    if target
                        .key
                        .profile
                        .as_ref()
                        .is_some_and(|p| !remote || p.cross_project)
                    {
                        // A login or upgrade prompt can persist until the user resolves it.
                        state.paused_reason = Some(
                            if target
                                .key
                                .profile
                                .as_ref()
                                .is_some_and(|p| p.command == "codex")
                            {
                                "codex_not_ready"
                            } else {
                                "cli_not_ready"
                            },
                        );
                        continue;
                    }
                    state.paused_reason = Some("create_failed_backoff");
                }
                tokio::select! {
                    _ = &mut changed => {},
                    _ = tokio::time::sleep(Duration::from_secs(15)) => {},
                }
            }
        }
    }
}

fn record_hit(id: &str, remote: bool) {
    qingcode_server::diagnostics::record(
        "terminal.prewarm_hit",
        serde_json::json!({"terminalId": id, "remote": remote}),
        false,
        false,
    );
}

async fn read_startup_ack(pipe: &mut IpcStream) -> std::io::Result<()> {
    if pipe.read_u8().await? == 1 {
        Ok(())
    } else {
        Err(std::io::Error::other("PowerShell 启动应答无效"))
    }
}

async fn stage_startup(pipe: &mut IpcStream, command: &str) -> std::io::Result<()> {
    let length = i32::try_from(command.len()).map_err(std::io::Error::other)?;
    pipe.write_i32_le(length).await?;
    pipe.write_all(command.as_bytes()).await?;
    read_startup_ack(pipe).await
}

/// 领取时交付给预热 PowerShell 的脚本：先切到目标目录，再执行配置命令。配置命令单独
/// 解析，即使有语法错误也不影响切换目录；都没有时返回 None（普通 Shell）。
fn claim_script(directory: Option<&str>, startup: Option<&str>) -> Option<String> {
    let Some(directory) = directory else {
        return startup.map(str::to_string);
    };
    let location = format!(
        "Set-Location -LiteralPath '{}'",
        powershell_literal(directory)
    );
    Some(match startup {
        Some(startup) => format!(
            "{location}; & ([ScriptBlock]::Create('{}'))",
            powershell_literal(startup)
        ),
        None => location,
    })
}

impl DaemonSession {
    pub(in crate::remote_ssh::server::terminal) async fn enter_prewarm_directory(
        &mut self,
        pty_id: &str,
        input_seq: &AtomicU64,
        marker: &str,
        line: Vec<u8>,
    ) -> Result<u64, String> {
        tokio::time::timeout(REMOTE_CLAIM_TIMEOUT, async {
            send_input_to_session(self, pty_id, input_seq, line)
                .await
                .map_err(|e| e.0)?;
            self.wait_shell_marker(pty_id, marker, "cwd").await
        })
        .await
        .map_err(|_| "等待预热 Shell 确认工作目录超时".to_string())?
    }
    // ConPTY 可在任意字节处拆帧。只保留标记长度的后缀，不缓存 profile 的输出。
    pub(in crate::remote_ssh::server::terminal) async fn wait_shell_marker(
        &mut self,
        pty_id: &str,
        nonce: &str,
        phase: &str,
    ) -> Result<u64, String> {
        let expected = format!("QC-{nonce}-{phase}!");
        let failed = format!("QC-{nonce}-error!");
        let keep = expected.len().max(failed.len()) - 1;
        let mut tail = Vec::new();
        let events = self.events_mut().ok_or("预热会话没有事件流")?;
        while let Some(event) = events.recv().await {
            match event {
                Event::PtyData { id, seq, data, .. } if id == pty_id => {
                    tail.extend(data);
                    if tail.windows(failed.len()).any(|s| s == failed.as_bytes()) {
                        return Err("远端 Shell 无法进入已校验的项目目录".into());
                    }
                    if tail
                        .windows(expected.len())
                        .any(|s| s == expected.as_bytes())
                    {
                        return Ok(seq + 1);
                    }
                    tail.drain(..tail.len().saturating_sub(keep));
                }
                Event::PtyExit { id, .. } if id == pty_id => break,
                _ => {}
            }
        }
        Err("远端预热 Shell 已退出或连接已关闭".into())
    }
}

/// 远端预热 PowerShell 读取的一行：UTF-8 命令的 base64（只含可打印 ASCII，ReadKey 不回显），
/// 以回车结束；空命令只发回车，进入普通提示符。
pub(in crate::remote_ssh::server::terminal) fn remote_input_line(command: &str) -> Vec<u8> {
    use base64::Engine;
    let mut line = base64::engine::general_purpose::STANDARD
        .encode(command)
        .into_bytes();
    line.push(b'\r');
    line
}

/// POSIX 单引号字面量：`'` 写成 `'\''`。
fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// 经 PTY 输入一行交付的文本不能含控制字符（换行会拆成多条命令）。
fn single_line(value: &str) -> bool {
    !value.chars().any(char::is_control)
}

fn posix_builtin(shell: PosixShell, command: &str) -> String {
    match shell {
        PosixShell::Plain => command.to_string(),
        PosixShell::Builtin => format!("builtin {command}"),
    }
}

/// 输出标记的命令。格式串与 nonce 分开写，回显的命令行不会误命中；也不经环境变量，
/// 不在用户的 Shell 里留下额外变量。
fn posix_marker(shell: PosixShell, nonce: &str, phase: &str) -> String {
    format!(
        "{} 'QC-%s-{phase}!\\n' '{nonce}'",
        posix_builtin(shell, "printf")
    )
}

/// POSIX 预热 Shell 加载完 rc、进入提示符后才会读到这一行，借此确认就绪。
pub(crate) fn posix_ready_input(shell: PosixShell, nonce: &str) -> Vec<u8> {
    format!(" {}\r", posix_marker(shell, nonce, "ready")).into_bytes()
}

/// 接回后交付的一行（可为空）。CMD 清除 nonce 并清屏，不支持配置命令；POSIX 接回时
/// 屏幕上只有项目目录下的新提示符，普通终端无需输入，配置命令须为单行。
/// 不能交付时返回 None，照常新建。
fn startup_input_line(command: &str, mode: RemoteInput) -> Option<Vec<u8>> {
    match mode {
        RemoteInput::PowerShell => Some(remote_input_line(command)),
        RemoteInput::Cmd => command
            .is_empty()
            .then(|| b"@set \"QINGCODE_PREWARM_NONCE=\" & cls\r".to_vec()),
        RemoteInput::Posix(_) if command.is_empty() => Some(Vec::new()),
        RemoteInput::Posix(_) => single_line(command).then(|| format!("{command}\r").into_bytes()),
    }
}

/// 领取时让预热 Shell 进入项目目录并回报结果。POSIX 目录是以 `/` 开头的绝对路径，
/// 不需要 `--`（fish 等不一定认）。
fn directory_input(directory: &str, mode: RemoteInput, nonce: &str) -> Option<Vec<u8>> {
    let shell = match mode {
        RemoteInput::PowerShell => return Some(remote_input_line(directory)),
        RemoteInput::Cmd => return cmd_directory_input(directory),
        RemoteInput::Posix(shell) => shell,
    };
    if !single_line(directory) || !directory.starts_with('/') {
        return None;
    }
    Some(
        format!(
            " {} {} && {} || {}\r",
            posix_builtin(shell, "cd"),
            posix_quote(directory),
            posix_marker(shell, nonce, "cwd"),
            posix_marker(shell, nonce, "error"),
        )
        .into_bytes(),
    )
}

fn cmd_directory_input(directory: &str) -> Option<Vec<u8>> {
    // CMD expands percent variables even inside quotes. Use normal creation for
    // paths the command parser cannot represent literally.
    if directory.contains(['%', '"', '!', '\r', '\n']) || directory.chars().any(char::is_control) {
        return None;
    }
    Some(format!("@cd /d \"{directory}\" && echo QC-%QINGCODE_PREWARM_NONCE%-cwd! || echo QC-%QINGCODE_PREWARM_NONCE%-error!\r").into_bytes())
}

/// 远端 PowerShell 预热参数：在原 UTF-8 设置之后等待领取方交付启动命令。
/// CMD 使用普通输入确认目录，仅支持普通终端。
pub(crate) fn remote_ready_args(launch: &PersistentLaunch) -> (Vec<String>, bool) {
    let mut args = launch.args.clone();
    let count = args.len();
    if launch.resolved_shell == "cmd" {
        if let Some(setup) = args.last_mut() {
            setup.push_str(" & echo QC-%QINGCODE_PREWARM_NONCE%-ready!");
        }
        args.insert(0, "/V:OFF".into());
        return (args, false);
    }
    if count < 2 || !args[count - 2].eq_ignore_ascii_case("-Command") {
        return (args, false);
    }
    let last = &mut args[count - 1];
    last.push_str("; ");
    last.push_str(include_str!("prewarm/start-remote-profile.ps1"));
    (args, true)
}

const READY_FILE_ENV: &str = "QINGCODE_PREWARM_READY_FILE";
const STARTUP_PIPE_ENV: &str = "QINGCODE_PREWARM_PIPE";

fn ready_args(shell: &str, mut args: Vec<String>) -> Vec<String> {
    if shell == "cmd" {
        args.extend([
            "/K".into(),
            format!("@type nul > \"%{READY_FILE_ENV}%\" & set {READY_FILE_ENV}="),
        ]);
    } else {
        args.extend([
            "-NoExit".into(),
            "-Command".into(),
            include_str!("prewarm/start-profile.ps1").into(),
        ]);
    }
    args
}

struct ReadyDirectory(std::path::PathBuf);
impl Drop for ReadyDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn create_warm_shell(manager: &SshManager, target: &Target) -> Result<WarmShell, String> {
    match &target.remote {
        Some(remote) => create_remote_warm_shell(manager, target, remote).await,
        None => create_local_warm_shell(manager, target).await,
    }
}

async fn create_local_warm_shell(
    manager: &SshManager,
    target: &Target,
) -> Result<WarmShell, String> {
    let (_, session) = open_local_session(manager).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut entry = WarmShell {
        id,
        pty_id: String::new(),
        key: target.key.clone(),
        cwd: target.cwd.clone(),
        claim_cwd: session.supports(CLAIM_CWD_CAPABILITY),
        launch: target.launch.clone(),
        remote: None,
        codex: None,
        startup_pipe: None,
        startup_input: false,
        marker: String::new(),
        from_seq: 0,
        input_seq: AtomicU64::new(0),
        session: Some(session),
        transport: None,
        reserved_at: None,
    };
    if target.key.profile.is_some() {
        codex::prepare(&mut entry, target).await?;
        return Ok(entry);
    }
    let ready_dir = ReadyDirectory(
        std::env::temp_dir().join(format!("qingcode-shell-ready-{}", uuid::Uuid::new_v4())),
    );
    std::fs::create_dir(&ready_dir.0).map_err(|error| error.to_string())?;
    let ready_file = ready_dir.0.join("ready");
    let mut env = target.launch.env.clone();
    let endpoint = IpcEndpoint::new(&ready_dir.0);
    let listener = if target.launch.resolved_shell == "cmd" {
        env.insert(
            READY_FILE_ENV.into(),
            ready_file.to_string_lossy().into_owned(),
        );
        None
    } else {
        let listener = endpoint
            .listen()
            .map_err(|e| e.to_string())?
            .ok_or("预热管道已被占用")?;
        let address = endpoint.describe();
        let name = address.strip_prefix(r"\\.\pipe\").ok_or("预热管道名无效")?;
        env.insert(STARTUP_PIPE_ENV.into(), name.into());
        Some(listener)
    };
    env.extend(
        crate::terminal::terminal_identity_env(&entry.id)
            .map(|(key, value)| (key.to_string(), value)),
    );
    let session = entry.session.as_mut().unwrap();
    let response = session
        .request(
            "pty.createTransient",
            &serde_json::json!({
                "cwd": target.cwd, "shell": target.launch.shell, "env": env,
                "args": ready_args(&target.launch.resolved_shell, target.launch.args.clone()),
                "cols": 120, "rows": 30,
            }),
        )
        .await?;
    entry.pty_id = response
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or("预热应答缺少 id")?
        .to_string();
    tokio::time::timeout(READY_TIMEOUT, async {
        if let Some(mut listener) = listener {
            let pipe = listener.accept().await?;
            pipe.verify_peer()?;
            entry.startup_pipe = Some(pipe);
        } else {
            while !ready_file.is_file() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        Ok::<_, std::io::Error>(())
    })
    .await
    .map_err(|_| "预热 Shell 就绪超时".to_string())?
    .map_err(|e| e.to_string())?;
    Ok(entry)
}

/// 连接已认证且具有就绪 daemon；不在后台触发部署或重新登录。
async fn create_remote_warm_shell(
    manager: &SshManager,
    target: &Target,
    remote: &RemoteTarget,
) -> Result<WarmShell, String> {
    let directory = if target.key.profile.is_some() {
        let parsed = parse_remote_uri(&target.project_path)?;
        let sftp = manager.open_sftp(&remote.connection_id).await?;
        let canonical = ensure_existing_path_within(&sftp, &parsed.path, &remote.root).await?;
        if remote_native_directory(&canonical)
            != remote_native_directory(&remote.root.canonical_path)
        {
            return Err("预热终端需要匹配已注册项目根目录".into());
        }
        Some(canonical)
    } else {
        None
    };
    let client_id = manager.daemon_client_id(&remote.connection_id);
    let (transport, session) = open_terminal_daemon_session(
        manager,
        &remote.connection_id,
        &remote.root.uri,
        &client_id,
        &remote.daemon,
    )
    .await?;
    if !remote_target_valid(manager, remote) {
        session.shutdown();
        transport.release();
        return Err("预热期间项目授权或连接已变化".into());
    }
    prepare_remote_shell(target, remote, transport, session, directory).await
}

async fn prepare_remote_shell(
    target: &Target,
    remote: &RemoteTarget,
    transport: SessionTransport,
    session: DaemonSession,
    directory: Option<String>,
) -> Result<WarmShell, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut entry = WarmShell {
        id,
        pty_id: String::new(),
        key: target.key.clone(),
        cwd: target.cwd.clone(),
        claim_cwd: session.supports(CLAIM_CWD_CAPABILITY),
        launch: target.launch.clone(),
        remote: Some(remote.clone()),
        codex: None,
        startup_pipe: None,
        startup_input: false,
        marker: String::new(),
        from_seq: 0,
        input_seq: AtomicU64::new(0),
        session: Some(session),
        transport: Some(transport),
        reserved_at: None,
    };
    let mut env = target.launch.env.clone();
    env.extend(
        crate::terminal::terminal_identity_env(&entry.id)
            .map(|(key, value)| (key.to_string(), value)),
    );
    if !entry.claim_cwd {
        return Err("远端 daemon 不支持预热终端切换目录".into());
    }
    if target.key.profile.is_some() {
        let directory = directory.ok_or("缺少已校验的预热目录")?;
        let native = windows_native_path(&directory);
        codex::prepare_at(&mut entry, target, native.as_deref().unwrap_or(&directory)).await?;
        return Ok(entry);
    }
    entry.marker = uuid::Uuid::new_v4().simple().to_string();
    let (args, startup_input) = remote_ready_args(&target.launch);
    let mode = RemoteInput::for_launch(&remote.root.canonical_path, &target.launch, startup_input)
        .ok_or("该远端 Shell 不支持连接预热")?;
    if !matches!(mode, RemoteInput::Posix(_)) {
        env.insert("QINGCODE_PREWARM_NONCE".into(), entry.marker.clone());
    }
    // POSIX Shell 不改启动参数，正常加载 rc；就绪由下面的输入行确认。
    let args = if matches!(mode, RemoteInput::Posix(_)) {
        target.launch.args.clone()
    } else {
        args
    };
    entry.startup_input = mode == RemoteInput::PowerShell;
    let session = entry.session.as_mut().unwrap();
    let response = session
        .request(
            "pty.createTransient",
            &serde_json::json!({
                "shell": target.launch.shell, "env": env,
                "args": args, "cols": 120, "rows": 30,
            }),
        )
        .await?;
    entry.pty_id = response
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or("预热应答缺少 id")?
        .to_string();
    if let RemoteInput::Posix(shell) = mode {
        // 输入先进 PTY 缓冲，Shell 加载完 rc 进入提示符后才读取执行。
        send_input_to_session(
            session,
            &entry.pty_id,
            &entry.input_seq,
            posix_ready_input(shell, &entry.marker),
        )
        .await
        .map_err(|e| e.0)?;
    }
    entry.from_seq = tokio::time::timeout(
        READY_TIMEOUT,
        session.wait_shell_marker(&entry.pty_id, &entry.marker, "ready"),
    )
    .await
    .map_err(|_| "远端 Shell 配置未在时限内就绪".to_string())??;
    Ok(entry)
}

#[cfg(test)]
mod tests;
