//! Windows 普通 Shell 的全应用空闲池。每个连接只持有一个 transient PTY，
//! 未领取时关闭连接即可由 daemon 回收；正式终端仍走原有持久化链路。
use super::*;
use crate::path_guard::PathAllowlist;
use crate::terminal::{hosted_local_launch, HostedLaunchRequest};
use std::time::Instant;
use tauri::Manager;

const GIB: u64 = 1024 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const RESERVATION_TTL: Duration = Duration::from_secs(15);

#[derive(Clone, PartialEq, Eq)]
struct LaunchKey {
    cwd: std::path::PathBuf,
    shell: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}
impl LaunchKey {
    fn new(cwd: &str, launch: &PersistentLaunch) -> Result<Self, String> {
        Ok(Self {
            cwd: std::fs::canonicalize(cwd).map_err(|error| error.to_string())?,
            shell: launch.shell.clone(),
            args: launch.args.clone(),
            env: launch.env.clone(),
        })
    }
}

#[derive(Clone)]
struct Target {
    key: LaunchKey,
    launch: PersistentLaunch,
    count: usize,
    window: String,
}

struct WarmShell {
    id: String,
    pty_id: String,
    key: LaunchKey,
    launch: PersistentLaunch,
    session: Option<DaemonSession>,
    reserved_at: Option<Instant>,
}
impl Drop for WarmShell {
    fn drop(&mut self) {
        if let Some(session) = &self.session {
            session.shutdown();
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
pub(crate) struct ShellPrewarmPool(Arc<Mutex<PoolState>>, Arc<Notify>);

fn resolve_count(value: &serde_json::Value, total_memory: u64) -> usize {
    if let Some(count) = value.as_u64() {
        return count.min(8) as usize;
    }
    (total_memory / (8 * GIB)).clamp(1, 8) as usize
}
/// Windows 的可用物理总量扣除了硬件保留，16 GiB 机器可能只报 15.x GiB；
/// 自动分档读取已安装容量，内存压力判断仍读取系统实际可用容量。
fn installed_memory(fallback: u64) -> u64 {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetPhysicallyInstalledSystemMemory(total_kilobytes: *mut u64) -> i32;
        }
        let mut kilobytes = 0u64;
        // SAFETY: the API writes one u64 to a valid pointer owned by this stack frame.
        if unsafe { GetPhysicallyInstalledSystemMemory(&mut kilobytes) } != 0 && kilobytes > 0 {
            return kilobytes.saturating_mul(1024);
        }
    }
    fallback
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

    pub(crate) fn configure(
        &self,
        app: AppHandle,
        window: String,
        cwd: Option<String>,
        shell: Option<String>,
        count: serde_json::Value,
    ) -> Result<usize, String> {
        let Some(cwd) = cwd.filter(|_| cfg!(windows)) else {
            self.clear_window(&window);
            return Ok(0);
        };
        app.state::<PathAllowlist>().ensure_executable(&cwd)?;
        let launch = resolve_launch(&cwd, shell.as_deref())?;
        let key = LaunchKey::new(&cwd, &launch)?;
        let mut memory = sysinfo::System::new();
        memory.refresh_memory();
        let count = resolve_count(&count, installed_memory(memory.total_memory()));
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
        let launch = resolve_launch(cwd, shell).ok()?;
        let key = LaunchKey::new(cwd, &launch).ok()?;
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

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn take(
        &self,
        id: &str,
        cwd: &str,
        shell: Option<&str>,
        size: (u16, u16),
        app: AppHandle,
        manager: &SshManager,
    ) -> Option<TerminalSpawnResult> {
        if !self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .shells
            .iter()
            .any(|entry| entry.id == id)
        {
            return None;
        }
        let launch = resolve_launch(cwd, shell).ok()?;
        let key = LaunchKey::new(cwd, &launch).ok()?;
        let mut entry = self.take_key(id, &key)?;
        let cleanup_app = app.clone();
        // 缓存失活不能让新建终端等待完整的 daemon 请求超时。
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            let session = entry.session.as_ref().ok_or("预热会话不可用")?;
            session
                .request("pty.claim", &serde_json::json!({ "id": entry.pty_id }))
                .await?;
            let session = entry.session.take().ok_or("预热会话不可用")?;
            attach_terminal_on_session(
                id.to_string(),
                entry.pty_id.clone(),
                TerminalHost::Local,
                LOCAL_CONNECTION_ID.to_string(),
                local_client_id(manager),
                Some(size),
                Some(0),
                SessionTransport::Local,
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
                    serde_json::json!({"terminalId": id}),
                    false,
                    false,
                );
                Some(result)
            }
            _ => {
                // claim 的应答也可能丢失，此时仍须清理已转为 detached 的 PTY。
                let pty_id = entry.pty_id.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = cleanup_app.state::<SshManager>();
                    let _ = kill_owned(&pty_id, "prewarm_attach_failed", false, &manager).await;
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
        Some(state.shells.remove(index))
    }

    async fn run(self, app: AppHandle) {
        loop {
            // 留出前台恢复/连续新建的时间；每轮最多创建一个。
            tokio::time::sleep(Duration::from_millis(1500)).await;
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
            let mut memory = sysinfo::System::new();
            memory.refresh_memory();
            let trusted = app
                .state::<PathAllowlist>()
                .ensure_executable(&target.key.cwd.to_string_lossy())
                .is_ok();
            if !trusted || under_pressure(memory.total_memory(), memory.available_memory()) {
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
            let manager = app.state::<SshManager>();
            let entry = tokio::select! {
                biased;
                _ = changed => continue,
                entry = create_warm_shell(&manager, &target) => entry,
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

async fn create_warm_shell(manager: &SshManager, target: &Target) -> Result<WarmShell, String> {
    let (_, session) = open_local_session(manager).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut entry = WarmShell {
        id,
        pty_id: String::new(),
        key: target.key.clone(),
        launch: target.launch.clone(),
        session: Some(session),
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

#[cfg(test)]
mod tests;
