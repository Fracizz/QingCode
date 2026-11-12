use crate::file_encoding;
use crate::git::validate_commit_rev;
use crate::path_guard::{validate_entry_name, PathAllowlist};
use crate::terminal::{encode_terminal_data, TerminalDataPayload, TerminalSpawnResult};
use russh::client;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use russh_sftp::client::SftpSession as RawSftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, ReadBuf};

mod config_import;
mod direct;
mod direct_firewall;
mod direct_fs;
mod direct_lifecycle;
mod direct_settings;
mod direct_update;
pub(crate) mod local_terminal;
pub use direct_firewall::*;
pub use direct_lifecycle::*;
pub use direct_settings::*;
pub use direct_update::*;
#[cfg(test)]
mod live_acceptance;
pub(crate) mod mobile_restore;
mod search;
mod server;
pub(crate) use server::git_push_sync;
mod server_status;
mod sshd_limits;
mod terminal_exit;
#[cfg(test)]
mod test_connection;
mod transfer;
mod tunnel;
pub(crate) use server::PersistentLaunch as HostedLaunch;
pub use terminal_exit::*;
mod windows_path_guard;
mod windows_sshd_repair;
pub use config_import::*;
pub use search::*;
pub use server_status::{SshServerLogs, SshServerState};
pub use transfer::*;
pub use windows_sshd_repair::*;
mod auth;
mod connection;
mod files;
mod git_cmds;
mod manager_exec;
mod manager_server;
mod manager_terminal;
mod paste_cleanup;
mod remote_path;
mod scan;
mod server_cmds;
mod session;
mod terminal_cmds;
mod windows_shell;
pub use auth::*;
pub use connection::*;
pub use files::*;
pub use git_cmds::*;
pub use paste_cleanup::*;
use remote_path::*;
pub use scan::*;
pub use server_cmds::*;
pub(crate) use session::*;
pub use terminal_cmds::*;
use windows_shell::*;

const SSH_URI_PREFIX: &str = "ssh://";
const MAX_EDITOR_FILE_SIZE: u64 = 100 * 1024 * 1024;
const MAX_SLICE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;
/// 图片查看上限：浏览器（WebView2）解码上限。与本地
/// `commands::cmd_stat::IMAGE_MAX_BYTES` 独立定义，值必须保持一致。
const IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionConfig {
    pub id: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth_kind: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    pub host_key_fingerprint: Option<String>,
    /// 连接模式（与 Zed / VS Code 一样属于连接本身）：连接时确定，会话期间不变，
    /// 修改后必须断开重连。`ssh_open_session` 可不带，`ssh_connect` 必须带。
    #[serde(default)]
    pub mode: Option<RemoteMode>,
}

/// SSH 连接模式。Server 模式下终端、运行任务、扫描、搜索、监听只走 qingcode-server，
/// 失败报错不回退；SSH 模式下不部署也不调用 server，全部直连。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteMode {
    Server,
    Ssh,
}

impl RemoteMode {
    fn label(self) -> &'static str {
        match self {
            RemoteMode::Server => "Server",
            RemoteMode::Ssh => "SSH",
        }
    }
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostProbe {
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectResult {
    pub fingerprint: String,
    pub canonical_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionOpenResult {
    pub fingerprint: String,
    pub home_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshBrowseResult {
    pub path: String,
    pub entries: Vec<RemoteFileNode>,
}

pub use qingcode_contracts::{RemoteFileNode, RemoteFileSlice, RemoteFileStat};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSymlinkWriteCheck {
    pub needs_confirm: bool,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecResult {
    pub stdout: String,
    pub stderr: String,
    #[serde(alias = "exit_code")]
    pub exit_code: u32,
}

#[derive(Debug, Serialize)]
pub struct RemoteSearchHit {
    pub name: String,
    pub path: String,
    pub relative: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct RemoteContentMatch {
    pub line: u32,
    pub text: String,
    pub match_start: u32,
    pub match_end: u32,
}

#[derive(Debug, Serialize)]
pub struct RemoteContentFile {
    pub name: String,
    pub path: String,
    pub relative: String,
    pub matches: Vec<RemoteContentMatch>,
}

#[derive(Debug, Serialize)]
pub struct RemoteContentResponse {
    pub files: Vec<RemoteContentFile>,
    pub match_count: usize,
    pub files_scanned: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitChange {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitStatus {
    pub is_repository: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub behind: u32,
    pub ahead: u32,
    pub last_fetch_at: Option<u64>,
    pub last_pull_at: Option<u64>,
    pub last_push_at: Option<u64>,
    pub changes: Vec<RemoteGitChange>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitPullResult {
    pub summary: String,
    pub has_conflicts: bool,
    pub conflict_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitBranchInfo {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitBranchList {
    pub local: Vec<RemoteGitBranchInfo>,
    pub remote: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitRemote {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_urls: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitCommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: String,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitCommitFileChange {
    pub status: String,
    pub path: String,
    pub previous_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitFileContents {
    pub original: String,
    pub modified: String,
}

pub struct SshManager {
    direct_connections: RwLock<HashMap<String, direct::DirectConnectionConfig>>,
    direct_active: RwLock<HashSet<String>>,
    direct_failures: RwLock<HashMap<String, String>>,
    sessions: RwLock<HashMap<String, Arc<ConnectedSession>>>,
    roots: RwLock<HashMap<String, RegisteredRoot>>,
    terminals: RwLock<HashMap<String, Arc<RemoteTerminalSession>>>,
    persistent_terminals: RwLock<HashMap<String, Arc<server::PersistentTerminal>>>,
    reconnect_gates: Mutex<HashMap<String, ReconnectGate>>,
    exec_slots: Mutex<HashMap<String, Arc<tokio::sync::Semaphore>>>,
    /// 同时进行的终端连接握手数；一次恢复大量终端时不超过 sshd 的 MaxStartups。
    terminal_handshakes: tokio::sync::Semaphore,
    /// server 模式终端共用的 SSH 连接池，按连接 id 分组。
    terminal_transport_pools: Mutex<HashMap<String, TerminalTransportPool>>,
    /// 项目根相对仓库根的路径前缀（`git rev-parse --show-prefix`），按项目惰性缓存。
    git_prefixes: Mutex<HashMap<String, String>>,
    /// 远端 server 状态缓存，key 为 `server_slot_key`（连接 id | 规范化项目根）。
    servers: RwLock<HashMap<String, server::ServerSlot>>,
    /// 同一 (连接, 根) 的 server 部署串行执行。
    server_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 本安装实例 UUID；daemon 的 clientId 为 `<uuid>:<connection_id>`。
    client_id: RwLock<String>,
    /// 本地 server 二进制查找目录（安装目录、资源目录、环境变量指定等）。
    server_binary_dirs: RwLock<Vec<PathBuf>>,
    /// 设置页手动选择的离线目录，查找时排在其余目录之前。
    server_offline_dir: RwLock<Option<PathBuf>>,
    /// Request-scoped settings; passive roots must not overwrite active projects.
    workspace_server_settings: RwLock<HashMap<String, WorkspaceServerSettings>>,
    /// Background registration does not subscribe a watch per saved project.
    passive_roots: RwLock<HashSet<String>>,
    /// 本地没有二进制时的下载缓存目录（`ssh.server.autoDownload` 开启时使用）。
    server_cache_dir: RwLock<Option<PathBuf>>,
    /// 本地缺失二进制时是否自动从 GitHub Release 下载（默认开：安装包不内置二进制）。
    server_auto_download: std::sync::atomic::AtomicBool,
    /// watch 监督任务句柄，key 同 server slot；连接断开或重连时替换。
    watch_supervisors: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    watch_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 已发给前端的 `ssh-server-state`，按规范化 root URI 去重。
    server_snapshots: Mutex<HashMap<String, server_status::SshServerState>>,
    /// 已解析并校验过的用户私有安装位置（家目录, 安装目录），按连接 id 缓存。
    /// 同一连接内不会变化；Windows 上每次解析都要起两次 PowerShell。
    server_installs: Mutex<HashMap<String, (String, String)>>,
    host_daemons: server::HostDaemonCache,
}

impl SshManager {
    /// Probe only an active direct transport; a status check must never reconnect it.
    async fn refresh_direct_status(&self, connection_id: &str) -> Result<(), String> {
        let Some(config) = self.direct_config(connection_id) else {
            return Ok(());
        };
        if !self
            .direct_active
            .read()
            .is_ok_and(|active| active.contains(connection_id))
        {
            return Ok(());
        }
        let result = direct::confirm_health(&config).await;
        // Disconnection or re-pairing may have completed while the probe was pending.
        let active = self.direct_active.read().map_err(|_| "Server 状态不可用")?;
        if !active.contains(connection_id)
            || !self.direct_config(connection_id).is_some_and(|current| {
                current.endpoint == config.endpoint
                    && current.certificate_fingerprint == config.certificate_fingerprint
                    && current.token == config.token
            })
        {
            return Ok(());
        }
        let mut failures = self
            .direct_failures
            .write()
            .map_err(|_| "Server 状态不可用")?;
        match result {
            Ok(_) => {
                failures.remove(connection_id);
            }
            Err(error) => {
                failures.insert(connection_id.into(), error);
            }
        }
        Ok(())
    }

    fn direct_config(&self, connection_id: &str) -> Option<direct::DirectConnectionConfig> {
        self.direct_connections
            .read()
            .ok()?
            .get(connection_id)
            .cloned()
    }
    fn detach_direct_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<Vec<RegisteredRoot>>, String> {
        let Some(config) = self.direct_config(connection_id) else {
            return Ok(None);
        };
        self.direct_active
            .write()
            .map_err(|_| "Server 状态不可用")?
            .remove(connection_id);
        self.direct_failures
            .write()
            .map_err(|_| "Server 状态不可用")?
            .remove(connection_id);
        direct::close_connection(&config.endpoint, connection_id);
        let roots = self.roots_for_connection(connection_id);
        for root in &roots {
            self.stop_watch_supervisor(&server::server_slot_key(
                connection_id,
                &root.canonical_path,
            ));
        }
        self.roots
            .write()
            .map_err(|_| "工作区状态不可用")?
            .retain(|_, root| remote_uri_connection_id(&root.uri) != Some(connection_id));
        self.purge_server_state(connection_id);
        Ok(Some(roots))
    }
    pub fn new() -> Self {
        Self {
            direct_connections: RwLock::new(HashMap::new()),
            direct_active: RwLock::new(HashSet::new()),
            direct_failures: RwLock::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
            roots: RwLock::new(HashMap::new()),
            terminals: RwLock::new(HashMap::new()),
            persistent_terminals: RwLock::new(HashMap::new()),
            reconnect_gates: Mutex::new(HashMap::new()),
            exec_slots: Mutex::new(HashMap::new()),
            terminal_handshakes: tokio::sync::Semaphore::new(MAX_CONCURRENT_TERMINAL_HANDSHAKES),
            terminal_transport_pools: Mutex::new(HashMap::new()),
            git_prefixes: Mutex::new(HashMap::new()),
            servers: RwLock::new(HashMap::new()),
            server_gates: Mutex::new(HashMap::new()),
            client_id: RwLock::new(uuid::Uuid::new_v4().to_string()),
            server_binary_dirs: RwLock::new(Vec::new()),
            server_offline_dir: RwLock::new(None),
            workspace_server_settings: RwLock::new(HashMap::new()),
            passive_roots: RwLock::new(HashSet::new()),
            server_cache_dir: RwLock::new(None),
            server_auto_download: std::sync::atomic::AtomicBool::new(true),
            watch_supervisors: Mutex::new(HashMap::new()),
            watch_cancellations: Mutex::new(HashMap::new()),
            server_snapshots: Mutex::new(HashMap::new()),
            server_installs: Mutex::new(HashMap::new()),
            host_daemons: server::HostDaemonCache::default(),
        }
    }

    fn cached_git_prefix(&self, project_uri: &str) -> Option<String> {
        self.git_prefixes
            .lock()
            .ok()
            .and_then(|prefixes| prefixes.get(project_uri).cloned())
    }

    fn remember_git_prefix(&self, project_uri: &str, prefix: &str) {
        if let Ok(mut prefixes) = self.git_prefixes.lock() {
            prefixes.insert(project_uri.to_string(), prefix.to_string());
        }
    }

    fn forget_git_prefix(&self, project_uri: &str) {
        if let Ok(mut prefixes) = self.git_prefixes.lock() {
            prefixes.remove(project_uri);
        }
    }

    /// 同一连接上同时运行的远程命令数上限，给 SFTP 留出会话名额。
    fn exec_slots(&self, connection_id: &str) -> Result<Arc<tokio::sync::Semaphore>, String> {
        let mut slots = self
            .exec_slots
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        Ok(Arc::clone(
            slots.entry(connection_id.to_string()).or_insert_with(|| {
                Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_EXEC_CHANNELS))
            }),
        ))
    }

    fn try_main_fallback_slot(
        &self,
        connection_id: &str,
    ) -> Option<tokio::sync::OwnedSemaphorePermit> {
        self.exec_slots(connection_id)
            .ok()?
            .try_acquire_owned()
            .ok()
    }

    fn remember_config(
        &self,
        connection_id: &str,
        mut config: SshConnectionConfig,
    ) -> Result<(), String> {
        let session = self.session(connection_id)?;
        let mut stored = session
            .config
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        require_matching_session_config(&stored, &config)?;
        // Browsing a saved live connection need not re-send its session secrets.
        if config.password.is_none() {
            config.password = stored.password.clone();
        }
        if config.passphrase.is_none() {
            config.passphrase = stored.passphrase.clone();
        }
        *stored = merge_remembered_config(stored.mode, config);
        Ok(())
    }

    fn reconnect_gate(&self, connection_id: &str) -> Result<ReconnectGate, String> {
        let mut gates = self
            .reconnect_gates
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        Ok(gates
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone())
    }

    /// 旧连接在新连接认证成功前一直留在表里：并发调用方会排队等这把锁而不是
    /// 拿到“尚未建立”，重连失败时保存的配置（含密码）也不会丢。
    async fn reconnect_after_channel_failure(
        &self,
        connection_id: &str,
        failed: &Arc<ConnectedSession>,
    ) -> Result<Arc<ConnectedSession>, String> {
        let gate = self.reconnect_gate(connection_id)?;
        let mut last_failure = gate.lock().await;
        // 等锁期间别人已重连成功则直接复用；连接被用户断开则不再复活。
        let current = self.session(connection_id)?;
        if !Arc::ptr_eq(&current, failed) {
            return Ok(current);
        }
        if let Some((failed_at, error)) = last_failure.as_ref() {
            if failed_at.elapsed() < SSH_RECONNECT_FAILURE_COOLDOWN {
                return Err(error.clone());
            }
        }
        let config = failed
            .config
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?
            .clone();
        let connected = match authenticate_session(config, ConnectionPurpose::Main).await {
            Ok((connected, _)) => Arc::new(connected),
            Err(error) => {
                *last_failure = Some((Instant::now(), error.clone()));
                return Err(error);
            }
        };
        *last_failure = None;
        self.sessions
            .write()
            .map_err(|_| "SSH 连接状态不可用".to_string())?
            .insert(connection_id.to_string(), Arc::clone(&connected));
        let _ = failed
            .handle
            .disconnect(Disconnect::ByApplication, "QingCode reconnect", "en")
            .await;
        Ok(connected)
    }

    /// 读取端结束后移除终端记录；被替换的新终端（`alive` 不同）不受影响。
    fn forget_terminal(&self, id: &str, alive: &Arc<AtomicBool>) {
        if let Ok(mut terminals) = self.terminals.write() {
            if terminals
                .get(id)
                .is_some_and(|session| Arc::ptr_eq(&session.alive, alive))
            {
                terminals.remove(id);
            }
        }
    }

    pub(crate) fn forget_persistent_terminal(&self, terminal: &Arc<server::PersistentTerminal>) {
        if let Ok(mut terminals) = self.persistent_terminals.write() {
            if terminals
                .get(terminal.id())
                .is_some_and(|current| Arc::ptr_eq(current, terminal))
            {
                terminals.remove(terminal.id());
            }
        }
    }

    async fn live_session(&self, connection_id: &str) -> Result<Arc<ConnectedSession>, String> {
        if self.direct_config(connection_id).is_some() {
            return Err("Server 直连不会回退到 SSH；请检查独立 TCP 端口和服务状态".into());
        }
        let session = self.session(connection_id)?;
        if session.handle.is_closed() {
            return self
                .reconnect_after_channel_failure(connection_id, &session)
                .await;
        }
        Ok(session)
    }

    async fn open_session_channel(
        &self,
        connection_id: &str,
        purpose: &str,
    ) -> Result<russh::Channel<client::Msg>, String> {
        let session = self.live_session(connection_id).await?;
        match open_session_channel_once(&session, purpose).await {
            Ok(channel) => Ok(channel),
            Err(error) if error.stale => {
                let session = self
                    .reconnect_after_channel_failure(connection_id, &session)
                    .await?;
                Ok(open_session_channel_once(&session, purpose).await?)
            }
            Err(error) => Err(error.message),
        }
    }

    fn session(&self, connection_id: &str) -> Result<Arc<ConnectedSession>, String> {
        self.sessions
            .read()
            .map_err(|_| "SSH 连接状态不可用".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| "SSH 连接尚未建立，请重新连接".to_string())
    }

    /// 会话仍在表里且传输未关闭。关闭的句柄不算已连接，状态机回到 disconnected。
    pub(crate) fn connection_is_open(&self, connection_id: &str) -> bool {
        if self.direct_config(connection_id).is_some() {
            return self
                .direct_active
                .read()
                .is_ok_and(|active| active.contains(connection_id))
                && self
                    .direct_failures
                    .read()
                    .is_ok_and(|failures| !failures.contains_key(connection_id));
        }
        self.session(connection_id)
            .ok()
            .is_some_and(|session| !session.handle.is_closed())
    }

    /// 主连接已断开时记录的原因（保活超时、远端断开等）；在线或未知返回 `None`。
    pub(crate) fn connection_closed_reason(&self, connection_id: &str) -> Option<String> {
        if self.direct_config(connection_id).is_some() {
            return self
                .direct_failures
                .read()
                .ok()?
                .get(connection_id)
                .cloned();
        }
        self.session(connection_id)
            .ok()
            .and_then(|session| session.closed_reason())
    }

    /// 主连接已关闭时立即重连（复用已确认的配置与指纹）；仍在线直接返回。
    /// watch 监督任务用它在断线后主动恢复，而不是等用户下一次操作。
    pub(crate) async fn ensure_connection_alive(&self, connection_id: &str) -> Result<(), String> {
        if let Some(config) = self.direct_config(connection_id) {
            if !self
                .direct_active
                .read()
                .is_ok_and(|active| active.contains(connection_id))
            {
                return Err("Server 连接已断开，请重新连接工作区".into());
            }
            let result = direct::confirm_health(&config).await.map(|_| ());
            if let Ok(mut failures) = self.direct_failures.write() {
                match &result {
                    Ok(()) => {
                        failures.remove(connection_id);
                    }
                    Err(error) => {
                        failures.insert(connection_id.into(), error.clone());
                    }
                }
            }
            return result;
        }
        self.live_session(connection_id).await.map(|_| ())
    }

    fn root_for_uri(&self, uri: &str, require_trust: bool) -> Result<RegisteredRoot, String> {
        let roots = self
            .roots
            .read()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?;
        let root = roots
            .values()
            .filter(|root| remote_uri_is_within(uri, &root.uri))
            .max_by_key(|root| root.uri.len())
            .cloned()
            .ok_or_else(|| "远程路径不在已注册项目内".to_string())?;
        if require_trust && !root.trusted {
            return Err("项目未信任（受限模式），无法修改文件或运行命令".to_string());
        }
        Ok(root)
    }

    fn roots_for_connection(&self, connection_id: &str) -> Vec<RegisteredRoot> {
        let Ok(roots) = self.roots.read() else {
            return Vec::new();
        };
        roots
            .values()
            .filter(|root| remote_uri_connection_id(&root.uri) == Some(connection_id))
            .cloned()
            .collect()
    }

    fn root_is_registered(&self, uri: &str) -> Result<bool, String> {
        let normalized = normalize_remote_uri(uri);
        Ok(self
            .roots
            .read()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?
            .values()
            .any(|root| normalize_remote_uri(&root.uri) == normalized))
    }

    /// 按 URI 精确匹配已注册项目根（规范化比较），供 server 监督任务克隆使用。
    pub(crate) fn registered_root(&self, uri: &str) -> Result<RegisteredRoot, String> {
        let normalized = normalize_remote_uri(uri);
        self.roots
            .read()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?
            .values()
            .find(|root| normalize_remote_uri(&root.uri) == normalized)
            .cloned()
            .ok_or_else(|| "远程路径不在已注册项目内".to_string())
    }
}

#[cfg(test)]
mod tests;
