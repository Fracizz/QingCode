//! Windows 普通 Shell 的全应用空闲池。每个连接只持有一个 transient PTY，
//! 未领取时关闭连接即可由 daemon 回收；正式终端仍走原有持久化链路。
//!
//! 目标二选一：本机 Windows 项目（本机 PTY 宿主），或远端为 Windows 的 SSH
//! Server 模式项目（远端 daemon）。Linux 远端与 SSH 直连模式不预热。
use super::*;
use crate::path_guard::PathAllowlist;
use crate::terminal::{hosted_local_launch, HostedLaunchRequest};
use std::time::Instant;
use tauri::Manager;

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
}
#[derive(Clone, Default)]
pub(crate) struct ShellPrewarmPool(Arc<Mutex<PoolState>>, Arc<Notify>, Arc<Notify>);

/// auto 固定保留 1 个：领取后会立即补充，常驻更多只对极快的连续新建有帮助。
fn resolve_count(value: &serde_json::Value) -> usize {
    value.as_u64().map_or(1, |count| count.min(8) as usize)
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
            state.target = None;
            state.generation += 1;
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
        if state.target.as_ref().is_none_or(|target| {
            target.key != key || target.count != count || target.window != window
        }) {
            state.shells.clear();
            state.generation += 1;
            self.1.notify_waiters();
        }
        state.target = (count > 0).then_some(Target {
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

    pub(crate) fn reserve(&self, cwd: &str, shell: Option<&str>) -> Option<String> {
        if !self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .shells
            .iter()
            .any(|entry| entry.reserved_at.is_none())
        {
            return None;
        }
        let key = if cwd.starts_with(SSH_URI_PREFIX) {
            remote_launch_key(cwd, shell).ok()?.1
        } else {
            let launch = resolve_launch(cwd, shell).ok()?;
            LaunchKey::new(cwd, &launch).ok()?
        };
        self.reserve_key(&key)
    }

    fn reserve_key(&self, key: &LaunchKey) -> Option<String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let entry = state
            .shells
            .iter_mut()
            .find(|entry| &entry.key == key && entry.reserved_at.is_none())?;
        entry.reserved_at = Some(Instant::now());
        Some(entry.id.clone())
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
    pub(crate) async fn take(
        &self,
        id: &str,
        cwd: &str,
        shell: Option<&str>,
        size: (u16, u16),
        app: AppHandle,
        manager: &SshManager,
    ) -> Option<TerminalSpawnResult> {
        if !self.has_entry(id) {
            return None;
        }
        let launch = resolve_launch(cwd, shell).ok()?;
        let key = LaunchKey::new(cwd, &launch).ok()?;
        let entry = self.take_key(id, &key)?;
        self.attach(id, entry, None, size, app, manager).await
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
        let entry = self.take_key(id, &key)?;
        let remote = entry.remote.as_ref()?;
        if remote.root.uri != root.uri
            || remote.root.canonical_path != root.canonical_path
            || !remote_target_valid(manager, remote)
        {
            return None;
        }
        // 与正常新建相同的 daemon 名称规则，接回孤儿终端时才能恢复标签名。
        let name = daemon_terminal_name(id, launch.name.as_deref());
        self.attach(id, entry, name, size, app, manager).await
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
                result.resolved_shell = Some(entry.launch.resolved_shell.clone());
                result.fallback_from = entry.launch.fallback_from.clone();
                qingcode_server::diagnostics::record(
                    "terminal.prewarm_hit",
                    serde_json::json!({"terminalId": id, "remote": remote.is_some()}),
                    false,
                    false,
                );
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
            let (target, generation) = {
                let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                state.shells.retain(|entry| {
                    entry
                        .reserved_at
                        .is_none_or(|at| at.elapsed() < RESERVATION_TTL)
                });
                let Some(target) = state.target.clone() else {
                    state.running = false;
                    return;
                };
                (target, state.generation)
            };
            let manager = app.state::<SshManager>();
            // 远端预热占用的是远端内存，本机内存压力只约束本机项目。
            let usable = match &target.remote {
                Some(remote) => remote_target_valid(&manager, remote),
                None => {
                    let mut memory = sysinfo::System::new();
                    memory.refresh_memory();
                    app.state::<PathAllowlist>()
                        .ensure_executable(&target.key.cwd)
                        .is_ok()
                        && !under_pressure(memory.total_memory(), memory.available_memory())
                }
            };
            if !usable {
                self.0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .shells
                    .clear();
                continue;
            }
            if self
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .shells
                .len()
                >= target.count
            {
                continue;
            }
            let entry = tokio::select! {
                biased;
                _ = changed => continue,
                entry = create_warm_shell(&app, &manager, &target) => entry,
            };
            if let Ok(entry) = entry {
                let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                if state.generation == generation && state.shells.len() < target.count {
                    state.shells.push(entry);
                }
            } else {
                // Profile 报错/交互阻塞、旧宿主不支持协议等情况下，避免持续拉起失败 Shell。
                if self.0.lock().unwrap_or_else(|e| e.into_inner()).generation != generation {
                    continue;
                }
                tokio::select! {
                    _ = self.1.notified() => {},
                    _ = tokio::time::sleep(Duration::from_secs(15)) => {},
                }
            }
        }
    }
}

/// 在用户 profile 执行后创建私有就绪标记，不注入输入历史，也不依赖 ConPTY
/// 是否转发未知 OSC。标记路径经环境传递，不拼接进 Shell 命令。
const READY_FILE_ENV: &str = "QINGCODE_PREWARM_READY_FILE";
fn ready_args(shell: &str, mut args: Vec<String>) -> Vec<String> {
    if shell == "cmd" {
        args.extend([
            "/K".into(),
            format!("@type nul > \"%{READY_FILE_ENV}%\" & set {READY_FILE_ENV}="),
        ]);
    } else {
        args.extend(["-NoExit".into(), "-Command".into(),
            format!("[System.IO.File]::WriteAllText($env:{READY_FILE_ENV}, ''); [Environment]::SetEnvironmentVariable('{READY_FILE_ENV}', $null, 'Process')")]);
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
    env.insert(
        READY_FILE_ENV.into(),
        ready_file.to_string_lossy().into_owned(),
    );
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
        while !ready_file.is_file() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "预热 Shell 就绪超时".to_string())?;
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
