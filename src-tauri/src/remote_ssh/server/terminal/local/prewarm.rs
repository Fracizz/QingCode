//! Windows 普通 Shell 的全应用空闲池。每个连接只持有一个 transient PTY，
//! 未领取时关闭连接即可由 daemon 回收；正式终端仍走原有持久化链路。
//!
//! 目标二选一：本机 Windows 项目（本机 PTY 宿主），或远端为 Windows 的 SSH
//! Server 模式项目（远端 daemon）。Linux 远端与 SSH 直连模式不预热。
//!
//! 预热项按主机复用：同一主机（本机或同一条 SSH 连接）上启动参数相同即可领取，
//! 切换到同机的其他项目时不清空。领取到别的项目目录时，经 PowerShell 启动通道先
//! `Set-Location` 再出提示符；远端还要让 daemon 改记 PTY 目录（`pty.claimCwd`），
//! 接回、找回与结束时的项目根校验才会以新目录为准。
//!
//! 切到另一主机（本机 ↔ SSH、换连接，或切到不预热的项目）时，为上一个主机保留 1 个
//! 空闲项，来回切换后立即新建也能命中；它不补充，再换到第三个主机时回收。
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
/// daemon 支持在 `pty.claim` 时改记工作目录。
const CLAIM_CWD_CAPABILITY: &str = "pty.claimCwd";

/// 复用条件：同一主机上启动参数相同。工作目录不在键里，见 [`WarmShell::can_rebind`]。
#[derive(Clone, PartialEq, Eq)]
struct LaunchKey {
    /// `None` 为本机 PTY 宿主；远端为 SSH 连接 id。
    host: Option<String>,
    shell: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}
impl LaunchKey {
    fn from_parts(host: Option<String>, launch: &PersistentLaunch) -> Self {
        Self {
            host,
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
    /// 新预热项的启动目录：本机为规范化路径，远端为 `ssh://` 资源。
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
    startup_pipe: Option<IpcStream>,
    /// 远端 PowerShell 预热项在 profile 后停住，等领取方经 PTY 输入交付一行（可为空）。
    startup_input: bool,
    session: Option<DaemonSession>,
    transport: Option<SessionTransport>,
    reserved_at: Option<Instant>,
}
impl WarmShell {
    /// 能否领取到同主机的其他目录：要有不回显的启动通道先切换目录；远端还要 daemon
    /// 改记 PTY 目录，否则接回时的项目根校验会拒绝。CMD 没有启动通道，只能原目录领取。
    fn can_rebind(&self) -> bool {
        match &self.remote {
            None => self.startup_pipe.is_some(),
            Some(_) => self.startup_input && self.claim_cwd,
        }
    }

    fn has_startup_channel(&self) -> bool {
        self.startup_pipe.is_some() || self.startup_input
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

/// 换主机时为上一个主机保留的空闲项数。
const PREVIOUS_HOST_KEEP: usize = 1;

impl PoolState {
    /// 换补充目标时整理池，返回回收数量。保留：未过期的预留项（正在领取）；新目标键的
    /// 空闲项（此前换走时保留的，最多 `count` 个）；目标换到另一主机或不预热时，上一个
    /// 目标键的空闲项 1 个。其余回收。
    fn retarget(&mut self, next: Option<(&LaunchKey, usize)>) -> usize {
        let previous = self
            .target
            .as_ref()
            .filter(|target| next.is_none_or(|(key, _)| key.host != target.key.host))
            .map(|target| target.key.clone());
        let before = self.shells.len();
        let (mut kept_next, mut kept_previous) = (0, 0);
        self.shells.retain(|entry| {
            if let Some(at) = entry.reserved_at {
                return at.elapsed() < RESERVATION_TTL;
            }
            if let Some((_, count)) = next.filter(|(key, _)| entry.key == **key) {
                kept_next += 1;
                return kept_next <= count;
            }
            if previous.as_ref().is_some_and(|key| entry.key == *key) {
                kept_previous += 1;
                return kept_previous <= PREVIOUS_HOST_KEEP;
            }
            false
        });
        before - self.shells.len()
    }
}

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
    let key = LaunchKey::from_parts(Some(parsed.connection_id), &launch);
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

    /// 窗口切到不预热的项目（Linux 远端、SSH 直连等）：停止补充，但为上一个主机保留 1 个空闲项。
    fn retire_window(&self, window: &str) {
        let Some(mut state) = self.lock_for_window(window) else {
            return;
        };
        if state.target.is_none() {
            return;
        }
        let dropped = state.retarget(None);
        trace(
            "retired",
            serde_json::json!({"window": window, "dropped": dropped, "kept": state.shells.len()}),
        );
        state.target = None;
        state.generation += 1;
        state.preparing = false;
        state.paused_reason = None;
        self.1.notify_waiters();
    }

    pub(crate) async fn configure(
        &self,
        app: AppHandle,
        window: String,
        cwd: Option<String>,
        shell: Option<String>,
        count: serde_json::Value,
    ) -> Result<usize, String> {
        if self.lock_for_window(&window).is_none() {
            return Ok(0);
        }
        let count = resolve_count(&count);
        let Some(cwd) = cwd.filter(|_| count > 0) else {
            self.clear_window(&window);
            return Ok(0);
        };
        let (target_cwd, key, launch, remote) = if cwd.starts_with(SSH_URI_PREFIX) {
            let manager = app.state::<SshManager>();
            let Some(connection_id) = remote_windows_connection(&manager, &cwd) else {
                self.retire_window(&window);
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
            (cwd.clone(), key, launch, Some(remote))
        } else {
            if !cfg!(windows) {
                self.retire_window(&window);
                return Ok(0);
            }
            app.state::<PathAllowlist>().ensure_executable(&cwd)?;
            let (target_cwd, launch, key) = local_launch_key(&cwd, shell.as_deref())?;
            (target_cwd, key, launch, None)
        };
        // 远端 SFTP 校验期间可能发生窗口移交，提交配置与归属检查共用一把锁。
        let Some(mut state) = self.lock_for_window(&window) else {
            return Ok(0);
        };
        // 同主机换项目只移动补充目标，已就绪项保留，切换目录后仍可领取。
        let changed = state.target.as_ref().is_none_or(|target| {
            target.key != key || target.count != count || target.window != window
        });
        let moved = !changed
            && state
                .target
                .as_ref()
                .is_some_and(|target| target.cwd != target_cwd);
        // 换主机时保留上一个主机的 1 个空闲项，以及此前为新主机保留的项。
        let dropped = if changed {
            state.retarget(Some((&key, count)))
        } else {
            0
        };
        trace(
            "configured",
            serde_json::json!({
                "window": window, "count": count, "remote": remote.is_some(),
                "changed": changed, "moved": moved, "dropped": dropped,
                "kept": if changed { state.shells.len() } else { 0 },
            }),
        );
        if changed {
            state.generation += 1;
            state.preparing = false;
            state.paused_reason = None;
            self.1.notify_waiters();
        }
        state.target = Some(Target {
            project_path: cwd,
            cwd: target_cwd,
            key,
            launch,
            count,
            window,
            remote,
        });
        if !state.running {
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
                // 没有补充目标时仍可能留着上一个主机的空闲项。
                if state.shells.is_empty() {
                    return Err(if state.target.is_none() {
                        "no_target"
                    } else {
                        state.paused_reason.unwrap_or("empty")
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
    /// 才能把输出路由给手机，不能沿用预热时分配的 id；之后照常用 `take` / `take_remote` 领取。
    pub(crate) fn reserve_as(
        &self,
        id: &str,
        cwd: &str,
        shell: Option<&str>,
        has_startup: bool,
    ) -> Result<(), &'static str> {
        let warm_id = self.reserve(cwd, shell, has_startup)?;
        self.rename_reserved(&warm_id, id)
    }

    fn rename_reserved(&self, warm_id: &str, id: &str) -> Result<(), &'static str> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
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
        // Reconfiguring the pool invalidates all entries. Every idle shell shares its target's launch key.
        // 池里可能同时有上一个主机保留的项，先按主机挑出可比较的空闲项。
        let mut idle_entries = state
            .shells
            .iter()
            .filter(|entry| entry.reserved_at.is_none())
            .peekable();
        if idle_entries.peek().is_none() {
            return Err("empty");
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
    /// `working_directory` 是调用方已校验在 `root` 内的目录；预热项在别的项目目录时，
    /// 领取请 daemon 改记目录，接回后先切换过去。
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
        let key = LaunchKey::from_parts(Some(connection_id), launch);
        let native = windows_native_path(working_directory);
        let Some(mut entry) = self.take_key(id, &key, cwd, native.is_some()) else {
            trace("take_miss", serde_json::json!({"remote": true}));
            return None;
        };
        let remote = entry.remote.as_ref()?;
        let rebind = entry.cwd != cwd;
        let valid = if rebind {
            // 新目录已由调用方按 `root` 校验；预热项只是同一连接上的普通 Shell。
            root.trusted && manager.server_mode(&remote.connection_id)
        } else {
            remote.root.uri == root.uri
                && remote.root.canonical_path == root.canonical_path
                && remote_target_valid(manager, remote)
        };
        if !valid {
            trace(
                "take_miss",
                serde_json::json!({"remote": true, "reason": "root"}),
            );
            return None;
        }
        if (startup.is_some() || rebind) && !entry.startup_input {
            trace(
                "take_miss",
                serde_json::json!({"remote": true, "reason": "startup_unsupported"}),
            );
            return None;
        }
        if rebind {
            // 之后的接回、清理与结束都按新项目的根校验。
            entry.remote = Some(RemoteTarget {
                root: root.clone(),
                connection_id: remote.connection_id.clone(),
                working_directory: working_directory.to_string(),
            });
        }
        let script = claim_script(native.as_deref().filter(|_| rebind), startup);
        let startup_input = entry.startup_input;
        // 与正常新建相同的 daemon 名称规则，接回孤儿终端时才能恢复标签名。
        let name = daemon_terminal_name(id, launch.name.as_deref());
        let claim_cwd = rebind.then(|| working_directory.to_string());
        let result = self
            .attach(id, entry, name, claim_cwd, size, app, manager)
            .await?;
        if startup_input {
            // 已接回才交付；空行即普通 Shell。写入排在用户的任何输入之前。
            let line = remote_startup_line(script.as_deref().unwrap_or_default());
            let terminal = manager
                .persistent_terminals
                .read()
                .ok()
                .and_then(|terminals| terminals.get(id).cloned());
            let delivered = terminal.as_ref().map(|terminal| terminal.write(line));
            if !matches!(delivered, Some(Ok(()))) {
                trace(
                    "startup_failed",
                    serde_json::json!({"remote": true, "command": startup.is_some(), "rebind": rebind}),
                );
                if script.is_some() {
                    let removed = manager
                        .persistent_terminals
                        .write()
                        .ok()
                        .and_then(|mut terminals| terminals.remove(id));
                    if let Some(terminal) = removed {
                        let _ = terminal.kill().await;
                    }
                    // 只差切换目录时命令尚未执行，可安全改走正常新建。
                    return startup
                        .is_some()
                        .then(|| Err("预热 PowerShell 启动命令交付失败".to_string()));
                }
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
                        .ensure_executable(&target.cwd)
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
                    // 内存紧张回收全部；目标不可用只回收目标主机的项，上一个主机保留的项照常可领。
                    let before = state.shells.len();
                    if reason == "memory_pressure" {
                        state.shells.clear();
                    } else {
                        state.shells.retain(|entry| entry.key != target.key);
                    }
                    if state.paused_reason != Some(reason) {
                        trace(
                            "unusable",
                            serde_json::json!({"reason": reason, "dropped": before - state.shells.len()}),
                        );
                    }
                }
                state.paused_reason = paused_reason;
                let target_shells = state
                    .shells
                    .iter()
                    .filter(|entry| entry.key == target.key)
                    .count();
                if paused_reason.is_some() || target_shells >= target.count {
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

/// 远端预热 PowerShell 读取的一行：UTF-8 命令的 base64（只含可打印 ASCII，ReadKey 不回显），
/// 以回车结束；空命令只发回车，进入普通提示符。
fn remote_startup_line(command: &str) -> Vec<u8> {
    use base64::Engine;
    let mut line = base64::engine::general_purpose::STANDARD
        .encode(command.trim())
        .into_bytes();
    line.push(b'\r');
    line
}

/// 远端 PowerShell 预热参数：在原 UTF-8 设置之后等待领取方交付启动命令。
/// CMD 无法不回显地读取输入，保持原参数，不支持配置命令。
pub(crate) fn remote_ready_args(launch: &PersistentLaunch) -> (Vec<String>, bool) {
    let mut args = launch.args.clone();
    let count = args.len();
    if launch.resolved_shell == "cmd"
        || count < 2
        || !args[count - 2].eq_ignore_ascii_case("-Command")
    {
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
        cwd: target.cwd.clone(),
        claim_cwd: session.supports(CLAIM_CWD_CAPABILITY),
        launch: target.launch.clone(),
        remote: None,
        startup_pipe: None,
        startup_input: false,
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

/// 远端无法观察本机标记文件：PTY 创建成功即入池，profile 在后台继续加载，
/// 提前领取时用户直接看到加载中的 Shell，仍比冷启动快。PowerShell 加载完 profile 后
/// 停在不回显的读行上，领取后由 `take_remote` 交付启动命令或空行。
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
        cwd: target.cwd.clone(),
        claim_cwd: session.supports(CLAIM_CWD_CAPABILITY),
        launch: target.launch.clone(),
        remote: Some(remote.clone()),
        startup_pipe: None,
        startup_input: false,
        session: Some(session),
        transport: Some(transport),
        reserved_at: None,
    };
    let mut env = target.launch.env.clone();
    env.extend(
        crate::terminal::terminal_identity_env(&entry.id)
            .map(|(key, value)| (key.to_string(), value)),
    );
    let (args, startup_input) = remote_ready_args(&target.launch);
    entry.startup_input = startup_input;
    let session = entry.session.as_mut().unwrap();
    let response = session
        .request(
            "pty.createTransient",
            &serde_json::json!({
                "cwd": remote.working_directory, "shell": target.launch.shell, "env": env,
                "args": args, "cols": 120, "rows": 30,
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
