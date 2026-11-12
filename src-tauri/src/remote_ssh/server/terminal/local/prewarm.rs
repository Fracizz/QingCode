//! Windows 普通 Shell 的全应用空闲池。每个连接只持有一个 transient PTY，
//! 未领取时关闭连接即可由 daemon 回收；正式终端仍走原有持久化链路。
//!
//! 目标二选一：本机 Windows 项目（本机 PTY 宿主），或远端为 Windows 的 SSH
//! Server 模式项目（远端 daemon）。Linux 远端与 SSH 直连模式不预热。
use super::*;
use crate::path_guard::PathAllowlist;
use crate::terminal::{hosted_local_launch, HostedLaunchRequest};
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

/// 复用条件。本机 `cwd` 是规范化后的本地路径；远端是前端传入的 `ssh://` 资源，
/// 两个域的字符串形态不同，不会互相命中。
#[derive(Clone, PartialEq, Eq)]
struct LaunchKey {
    cwd: String,
    shell: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}
impl LaunchKey {
    fn new(cwd: &str, launch: &PersistentLaunch) -> Result<Self, String> {
        let cwd = std::fs::canonicalize(cwd).map_err(|error| error.to_string())?;
        Ok(Self::from_parts(cwd.to_string_lossy().into_owned(), launch))
    }

    fn from_parts(cwd: String, launch: &PersistentLaunch) -> Self {
        Self {
            cwd,
            shell: launch.shell.clone(),
            args: launch.args.clone(),
            env: launch.env.clone(),
        }
    }
}

/// 远端目标：PTY 在配置时校验过的项目内目录中启动。
#[derive(Clone)]
struct RemoteTarget {
    root: RegisteredRoot,
    connection_id: String,
    working_directory: String,
}

#[derive(Clone)]
struct Target {
    project_path: String,
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
    launch: PersistentLaunch,
    remote: Option<RemoteTarget>,
    startup_pipe: Option<IpcStream>,
    session: Option<DaemonSession>,
    transport: Option<SessionTransport>,
    reserved_at: Option<Instant>,
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

/// 只有远端为 Windows（`/C:/...` 形态）且走 Server 模式的 SSH 项目才预热。
fn remote_windows_connection(manager: &SshManager, cwd: &str) -> Option<String> {
    let parsed = parse_remote_uri(cwd).ok()?;
    (windows_native_path(&parsed.path).is_some() && manager.server_mode(&parsed.connection_id))
        .then_some(parsed.connection_id)
}

/// 与 `ssh_create_terminal` 相同的启动参数；两侧一致才能命中。
fn remote_launch_key(
    cwd: &str,
    shell: Option<&str>,
) -> Result<(PersistentLaunch, LaunchKey), String> {
    let parsed = parse_remote_uri(cwd)?;
    let launch = crate::remote_ssh::terminal_cmds::persistent_shell_launch(&parsed.path, shell)?;
    let key = LaunchKey::from_parts(cwd.to_string(), &launch);
    Ok((launch, key))
}

/// 远端项目仍已注册、已信任、根未变化且仍是 Server 模式。
fn remote_target_valid(manager: &SshManager, remote: &RemoteTarget) -> bool {
    manager.server_mode(&remote.connection_id)
        && manager
            .registered_root(&remote.root.uri)
            .is_ok_and(|root| root.trusted && root.canonical_path == remote.root.canonical_path)
}

impl ShellPrewarmPool {
    pub(crate) fn clear_window(&self, window: &str) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .target
            .as_ref()
            .is_some_and(|target| target.window == window)
        {
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
    }

    pub(crate) async fn configure(
        &self,
        app: AppHandle,
        window: String,
        cwd: Option<String>,
        shell: Option<String>,
        count: serde_json::Value,
    ) -> Result<usize, String> {
        let Some(cwd) = cwd else {
            self.clear_window(&window);
            return Ok(0);
        };
        let (key, launch, remote) = if cwd.starts_with(SSH_URI_PREFIX) {
            let manager = app.state::<SshManager>();
            let Some(connection_id) = remote_windows_connection(&manager, &cwd) else {
                self.clear_window(&window);
                return Ok(0);
            };
            let root = manager.root_for_uri(&cwd, true)?;
            let parsed = parse_remote_uri(&cwd)?;
            let sftp = manager.open_sftp(&connection_id).await?;
            let working_directory = ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
            let (launch, key) = remote_launch_key(&cwd, shell.as_deref())?;
            let remote = RemoteTarget {
                root,
                connection_id,
                working_directory,
            };
            (key, launch, Some(remote))
        } else {
            if !cfg!(windows) {
                self.clear_window(&window);
                return Ok(0);
            }
            app.state::<PathAllowlist>().ensure_executable(&cwd)?;
            let launch = resolve_launch(&cwd, shell.as_deref())?;
            (LaunchKey::new(&cwd, &launch)?, launch, None)
        };
        let count = resolve_count(&count);
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let changed = state.target.as_ref().is_none_or(|target| {
            target.key != key || target.count != count || target.window != window
        });
        trace(
            "configured",
            serde_json::json!({
                "window": window, "count": count, "remote": remote.is_some(),
                "changed": changed, "dropped": if changed { state.shells.len() } else { 0 },
            }),
        );
        if changed {
            state.shells.clear();
            state.generation += 1;
            state.preparing = false;
            state.paused_reason = None;
            self.1.notify_waiters();
        }
        state.target = (count > 0).then_some(Target {
            project_path: cwd,
            key,
            launch,
            count,
            window,
            remote,
        });
        if !state.running && count > 0 {
            state.running = true;
            let pool = self.clone();
            tauri::async_runtime::spawn(async move { pool.run(app).await });
        }
        Ok(count)
    }

    pub(crate) fn status(&self, cwd: &str) -> serde_json::Value {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(target) = state.target.as_ref().filter(|t| t.project_path == cwd) else {
            return serde_json::json!({"target": 0, "ready": 0, "preparing": 0, "reserved": 0,
                "reason": if state.target.is_some() { "other_project" } else { "no_target" }});
        };
        let ready = state
            .shells
            .iter()
            .filter(|s| s.reserved_at.is_none())
            .count();
        serde_json::json!({"target": target.count, "ready": ready, "preparing": usize::from(state.preparing),
            "reserved": state.shells.len() - ready, "reason": state.paused_reason})
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
                if state.target.is_none() {
                    return Err("no_target");
                }
                if state.shells.is_empty() {
                    return Err(state.paused_reason.unwrap_or("empty"));
                }
            }
            let key = if remote {
                remote_launch_key(cwd, shell).map(|(_, key)| key)
            } else {
                resolve_launch(cwd, shell).and_then(|launch| LaunchKey::new(cwd, &launch))
            }
            .map_err(|_| "launch_unavailable")?;
            self.reserve_key(&key, has_startup)
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

    fn reserve_key(&self, key: &LaunchKey, has_startup: bool) -> Result<String, &'static str> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Reconfiguring the pool invalidates all entries. Every idle shell shares its target's launch key.
        let entry = state
            .shells
            .iter_mut()
            .find(|entry| entry.reserved_at.is_none())
            .ok_or("empty")?;
        if entry.key.cwd != key.cwd {
            return Err("cwd_mismatch");
        }
        if entry.key.shell != key.shell {
            return Err("shell_mismatch");
        }
        if entry.key.args != key.args {
            return Err("args_mismatch");
        }
        if entry.key.env != key.env {
            return Err("env_mismatch");
        }
        if has_startup && entry.startup_pipe.is_none() {
            return Err("startup_unsupported");
        }
        entry.reserved_at = Some(Instant::now());
        Ok(entry.id.clone())
    }

    fn has_entry(&self, id: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .shells
            .iter()
            .any(|entry| entry.id == id)
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
        let launch = resolve_launch(cwd, shell)?;
        let key = LaunchKey::new(cwd, &launch)?;
        let Some(mut entry) = self.take_key(id, &key) else {
            trace("take_miss", serde_json::json!({"remote": false}));
            return Ok(None);
        };
        let mut pipe = entry.startup_pipe.take();
        if let Some(pipe) = &mut pipe {
            // 接回之前只交付命令文本。此时即使管道断开，普通冷启动仍可安全重试。
            if !matches!(
                tokio::time::timeout(
                    LOCAL_CLAIM_TIMEOUT,
                    stage_startup(pipe, startup.unwrap_or_default())
                )
                .await,
                Ok(Ok(()))
            ) {
                return Ok(None);
            }
        } else if startup.is_some() {
            return Ok(None);
        }
        let pty_id = entry.pty_id.clone();
        let Some(result) = self.attach(id, entry, None, size, app, manager).await else {
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

    /// 远端 SSH 项目领取：启动参数与项目根都必须与预热时一致。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn take_remote(
        &self,
        id: &str,
        cwd: &str,
        launch: &PersistentLaunch,
        root: &RegisteredRoot,
        size: (u16, u16),
        app: AppHandle,
        manager: &SshManager,
    ) -> Option<TerminalSpawnResult> {
        if !self.has_entry(id) {
            return None;
        }
        let key = LaunchKey::from_parts(cwd.to_string(), launch);
        let Some(entry) = self.take_key(id, &key) else {
            trace("take_miss", serde_json::json!({"remote": true}));
            return None;
        };
        let remote = entry.remote.as_ref()?;
        if remote.root.uri != root.uri
            || remote.root.canonical_path != root.canonical_path
            || !remote_target_valid(manager, remote)
        {
            trace(
                "take_miss",
                serde_json::json!({"remote": true, "reason": "root"}),
            );
            return None;
        }
        // 与正常新建相同的 daemon 名称规则，接回孤儿终端时才能恢复标签名。
        let name = daemon_terminal_name(id, launch.name.as_deref());
        let result = self.attach(id, entry, name, size, app, manager).await?;
        record_hit(id, true);
        Some(result)
    }

    async fn attach(
        &self,
        id: &str,
        mut entry: WarmShell,
        name: Option<String>,
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
                Some(0),
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

    fn take_key(&self, id: &str, key: &LaunchKey) -> Option<WarmShell> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let index = state.shells.iter().position(|entry| {
            entry.id == id
                && &entry.key == key
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
                let before = state.shells.len();
                state.shells.retain(|entry| {
                    entry
                        .reserved_at
                        .is_none_or(|at| at.elapsed() < RESERVATION_TTL)
                });
                if state.shells.len() < before {
                    trace(
                        "reservation_expired",
                        serde_json::json!({"dropped": before - state.shells.len()}),
                    );
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
                    if app
                        .state::<PathAllowlist>()
                        .ensure_executable(&target.key.cwd)
                        .is_err()
                    {
                        Some("untrusted")
                    } else {
                        under_pressure(memory.total_memory(), memory.available_memory())
                            .then_some("memory_pressure")
                    }
                }
            };
            {
                let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                if state.generation != generation {
                    continue;
                }
                if let Some(reason) = paused_reason {
                    if state.paused_reason != Some(reason) {
                        trace(
                            "unusable",
                            serde_json::json!({"reason": reason, "dropped": state.shells.len()}),
                        );
                    }
                    state.shells.clear();
                }
                state.paused_reason = paused_reason;
                if paused_reason.is_some() || state.shells.len() >= target.count {
                    continue;
                }
                state.preparing = true;
            }
            let started = Instant::now();
            let remote = target.remote.is_some();
            let entry = tokio::select! {
                biased;
                _ = &mut changed => {
                    trace("create_cancelled", serde_json::json!({"remote": remote, "ms": started.elapsed().as_millis() as u64}));
                    continue;
                }
                entry = create_warm_shell(&app, &manager, &target) => entry,
            };
            let ms = started.elapsed().as_millis() as u64;
            if let Ok(entry) = entry {
                let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                if state.generation == generation {
                    state.preparing = false;
                    trace("ready", serde_json::json!({"remote": remote, "ms": ms}));
                    state.shells.push(entry);
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

async fn create_warm_shell(
    app: &AppHandle,
    manager: &SshManager,
    target: &Target,
) -> Result<WarmShell, String> {
    match &target.remote {
        Some(remote) => create_remote_warm_shell(app, manager, target, remote).await,
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
        launch: target.launch.clone(),
        remote: None,
        startup_pipe: None,
        session: Some(session),
        transport: None,
        reserved_at: None,
    };
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
                "cwd": target.key.cwd, "shell": target.launch.shell, "env": env,
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

/// 远端无法观察本机标记文件：PTY 创建成功即入池，profile 在后台继续加载，
/// 提前领取时用户直接看到加载中的 Shell，仍比冷启动快。
async fn create_remote_warm_shell(
    app: &AppHandle,
    manager: &SshManager,
    target: &Target,
    remote: &RemoteTarget,
) -> Result<WarmShell, String> {
    let endpoint = server::require_server_endpoint(app, manager, &remote.root, true).await?;
    let daemon = endpoint
        .daemon
        .as_ref()
        .ok_or_else(|| server::server_mode_error("远端 daemon 不可用"))?;
    let client_id = manager.daemon_client_id(&remote.connection_id);
    let (transport, session) = open_terminal_daemon_session(
        manager,
        &remote.connection_id,
        &remote.root.uri,
        &client_id,
        daemon,
    )
    .await?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut entry = WarmShell {
        id,
        pty_id: String::new(),
        key: target.key.clone(),
        launch: target.launch.clone(),
        remote: Some(remote.clone()),
        startup_pipe: None,
        session: Some(session),
        transport: Some(transport),
        reserved_at: None,
    };
    let mut env = target.launch.env.clone();
    env.extend(
        crate::terminal::terminal_identity_env(&entry.id)
            .map(|(key, value)| (key.to_string(), value)),
    );
    let session = entry.session.as_mut().unwrap();
    let response = session
        .request(
            "pty.createTransient",
            &serde_json::json!({
                "cwd": remote.working_directory, "shell": target.launch.shell, "env": env,
                "args": target.launch.args, "cols": 120, "rows": 30,
            }),
        )
        .await?;
    entry.pty_id = response
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or("预热应答缺少 id")?
        .to_string();
    Ok(entry)
}

#[cfg(test)]
mod tests;
