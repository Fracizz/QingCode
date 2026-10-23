use crate::file_encoding;
use crate::path_guard::PathAllowlist;
use crate::terminal::{
    encode_terminal_data, TerminalDataPayload, TerminalExitPayload, TerminalSpawnResult,
};
use russh::client;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, ReadBuf};

mod search;
mod transfer;
pub use search::*;
pub use transfer::*;

const SSH_URI_PREFIX: &str = "ssh://";
const MAX_EDITOR_FILE_SIZE: u64 = 100 * 1024 * 1024;
const MAX_SLICE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;

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

#[derive(Debug, Serialize)]
pub struct RemoteFileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct RemoteFileStat {
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileSlice {
    pub content: String,
    pub offset: u64,
    pub next_offset: u64,
    pub file_size: u64,
    pub eof: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSymlinkWriteCheck {
    pub needs_confirm: bool,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecResult {
    pub stdout: String,
    pub stderr: String,
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

#[derive(Clone)]
struct SshClient {
    expected_fingerprint: Option<String>,
    observed_fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        if let Ok(mut observed) = self.observed_fingerprint.lock() {
            *observed = Some(fingerprint.clone());
        }
        Ok(self
            .expected_fingerprint
            .as_deref()
            .is_some_and(|expected| expected == fingerprint))
    }
}

struct ConnectedSession {
    handle: client::Handle<SshClient>,
    config: Mutex<SshConnectionConfig>,
    /// 整条连接共用一个 SFTP 会话，请求在其中多路复用。每次操作都新开通道时，
    /// Windows OpenSSH 要为每次请求启动一个 sftp-server 进程，远端一卡就超时。
    sftp: tokio::sync::Mutex<Option<CachedSftp>>,
}

struct CachedSftp {
    sftp: Arc<SftpSession>,
    closed: Arc<AtomicBool>,
}

/// 包住 SFTP 通道流，读到 EOF 或读写出错时置位，缓存的会话就不再复用。
struct ClosedFlagStream<S> {
    inner: S,
    closed: Arc<AtomicBool>,
}

impl<S: AsyncRead + Unpin> AsyncRead for ClosedFlagStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let wants_data = buf.remaining() > 0;
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        let ended = match &result {
            Poll::Ready(Ok(())) => wants_data && buf.filled().len() == before,
            Poll::Ready(Err(_)) => true,
            Poll::Pending => false,
        };
        if ended {
            self.closed.store(true, Ordering::Release);
        }
        result
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for ClosedFlagStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if matches!(result, Poll::Ready(Err(_))) {
            self.closed.store(true, Ordering::Release);
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.closed.store(true, Ordering::Release);
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// 打开通道失败；`stale` 表示底层连接已不可用，应丢弃并重连。
struct ChannelOpenError {
    message: String,
    stale: bool,
}

impl From<ChannelOpenError> for String {
    fn from(error: ChannelOpenError) -> Self {
        error.message
    }
}

/// 按 russh 错误类型判断连接是否失效；在已关闭的连接上开通道得到的是
/// `SendError` / `Disconnect`，而 keepalive 超时只会出现在后台连接任务里。
fn is_stale_russh_error(error: &russh::Error) -> bool {
    matches!(
        error,
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed)
            | russh::Error::Disconnect
            | russh::Error::HUP
            | russh::Error::SendError
            | russh::Error::RecvError
            | russh::Error::KeepaliveTimeout
            | russh::Error::InactivityTimeout
            | russh::Error::ConnectionTimeout
            | russh::Error::IO(_)
    )
}

/// 服务端卡在横幅交换或认证时，russh 会无限等待；超时后才能把错误交给前端。
const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// 会话已半死时 `channel_open_session` 也不会返回；超时后探测一次再决定是否重连。
const SSH_CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const CHANNEL_OPEN_TIMEOUT_MARKER: &str = "通道超时";
/// 远端拒绝开通道（ConnectFailed）时的重试次数，共约 3 秒。
const CHANNEL_OPEN_RETRIES: u32 = 5;
/// sshd 默认每条连接最多 10 个会话；命令最多占 4 个，其余留给终端和 SFTP。
const MAX_CONCURRENT_EXEC_CHANNELS: usize = 4;
/// 主动探测的等待上限；连接只是慢时不应拆掉它（会杀掉所有远端终端）。
/// 远端 CPU/内存占满时几秒不回包很常见，给足时间再判失效。
const SSH_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// 重连失败后的冷却期：并发的终端恢复直接复用这次失败，不排队逐个重试握手。
const SSH_RECONNECT_FAILURE_COOLDOWN: Duration = Duration::from_secs(3);
const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// 连续 5 次（约 75 秒）收不到任何回包才判定断开。
const SSH_KEEPALIVE_MAX: usize = 4;

fn ssh_client_config() -> client::Config {
    client::Config {
        // russh 只在收到回包时重置空闲计时器，发出保活本身不算；Windows OpenSSH
        // 在 ConPTY 忙时回包很慢，空闲超时会误断。改为只以保活失败作为断开信号。
        inactivity_timeout: None,
        keepalive_interval: Some(SSH_KEEPALIVE_INTERVAL),
        keepalive_max: SSH_KEEPALIVE_MAX,
        nodelay: true,
        ..Default::default()
    }
}

/// 发一次 ping 并等待回包；超时或连接已关闭都视为失效。
async fn connection_responds(handle: &client::Handle<SshClient>) -> bool {
    if handle.is_closed() {
        return false;
    }
    matches!(
        tokio::time::timeout(SSH_LIVENESS_PROBE_TIMEOUT, handle.send_ping()).await,
        Ok(Ok(()))
    ) && !handle.is_closed()
}

async fn open_session_channel_once(
    session: &ConnectedSession,
    purpose: &str,
) -> Result<russh::Channel<client::Msg>, ChannelOpenError> {
    let mut retries = 0;
    loop {
        let opened = match tokio::time::timeout(
            SSH_CHANNEL_OPEN_TIMEOUT,
            session.handle.channel_open_session(),
        )
        .await
        {
            Ok(opened) => opened,
            Err(_) => {
                return Err(ChannelOpenError {
                    message: format!("打开 SSH {purpose}{CHANNEL_OPEN_TIMEOUT_MARKER}，远端未响应"),
                    stale: !connection_responds(&session.handle).await,
                })
            }
        };
        match opened {
            Ok(channel) => return Ok(channel),
            Err(russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed))
                if retries < CHANNEL_OPEN_RETRIES =>
            {
                // sshd 的会话数到上限（MaxSessions，默认 10）时也回 ConnectFailed；
                // 刚关闭的通道在卡顿的远端上要过一会儿才释放，退避久一点再试。
                retries += 1;
                tokio::time::sleep(Duration::from_millis(200 * u64::from(retries))).await;
            }
            Err(error) => {
                let detail = if matches!(
                    error,
                    russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed)
                ) && !session.handle.is_closed()
                {
                    "远端拒绝打开新通道，可能已达 sshd 的 MaxSessions 上限（默认 10，终端开得过多）"
                        .to_string()
                } else {
                    error.to_string()
                };
                return Err(ChannelOpenError {
                    message: format!("打开 SSH {purpose}通道失败：{detail}"),
                    stale: is_stale_russh_error(&error) || session.handle.is_closed(),
                });
            }
        }
    }
}

/// 复用连接上已有的 SFTP 会话；没有或已关闭时新开一个并缓存。
async fn open_sftp_session(
    session: &ConnectedSession,
) -> Result<Arc<SftpSession>, ChannelOpenError> {
    // 持锁新开：并发的首批请求只会开一个会话。
    let mut cached = session.sftp.lock().await;
    if let Some(entry) = cached.as_ref() {
        if !entry.closed.load(Ordering::Acquire) {
            return Ok(Arc::clone(&entry.sftp));
        }
    }
    *cached = None;
    let channel = open_session_channel_once(session, "SFTP ").await?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| ChannelOpenError {
            message: format!("远端未启用 SFTP：{error}"),
            stale: is_stale_russh_error(&error) || session.handle.is_closed(),
        })?;
    let closed = Arc::new(AtomicBool::new(false));
    let stream = ClosedFlagStream {
        inner: channel.into_stream(),
        closed: Arc::clone(&closed),
    };
    let sftp = SftpSession::new(stream)
        .await
        .map_err(|error| ChannelOpenError {
            message: format!("初始化 SFTP 失败：{error}"),
            stale: session.handle.is_closed(),
        })?;
    sftp.set_timeout(30);
    let sftp = Arc::new(sftp);
    *cached = Some(CachedSftp {
        sftp: Arc::clone(&sftp),
        closed,
    });
    Ok(sftp)
}

#[derive(Clone, Debug)]
struct RegisteredRoot {
    uri: String,
    canonical_path: String,
    trusted: bool,
}

struct RemoteTerminalSession {
    connection_id: String,
    input: tokio::sync::mpsc::Sender<Vec<u8>>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
    /// Cleared when this channel is replaced or closed on purpose.
    /// A stale reader must not emit `terminal-exit` for the replacement.
    alive: Arc<AtomicBool>,
}

/// Returns true only for the reader that still owns the terminal id.
fn claim_terminal_exit(alive: &AtomicBool) -> bool {
    alive.swap(false, Ordering::AcqRel)
}

/// 远端正常结束会先发 ExitStatus / ExitSignal / Close；什么都没收到就结束，
/// 说明是连接断了，而不是 Shell 自己退出。
fn is_terminal_end_message(message: &ChannelMsg) -> bool {
    matches!(
        message,
        ChannelMsg::ExitStatus { .. } | ChannelMsg::ExitSignal { .. } | ChannelMsg::Close
    )
}

const BUSY_CONNECTION_MARKER: &str = "为保留正在运行的终端未重连";

fn busy_connection_error(message: &str) -> String {
    format!("{message}（连接仍在，{BUSY_CONNECTION_MARKER}，请稍后重试）")
}

/// 同一连接的重连串行执行；记住最近一次失败，冷却期内直接返回。
type ReconnectGate = Arc<tokio::sync::Mutex<Option<(Instant, String)>>>;

pub struct SshManager {
    sessions: RwLock<HashMap<String, Arc<ConnectedSession>>>,
    roots: RwLock<HashMap<String, RegisteredRoot>>,
    terminals: RwLock<HashMap<String, Arc<RemoteTerminalSession>>>,
    reconnect_gates: Mutex<HashMap<String, ReconnectGate>>,
    exec_slots: Mutex<HashMap<String, Arc<tokio::sync::Semaphore>>>,
    /// 项目根相对仓库根的路径前缀（`git rev-parse --show-prefix`），按项目惰性缓存。
    git_prefixes: Mutex<HashMap<String, String>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            roots: RwLock::new(HashMap::new()),
            terminals: RwLock::new(HashMap::new()),
            reconnect_gates: Mutex::new(HashMap::new()),
            exec_slots: Mutex::new(HashMap::new()),
            git_prefixes: Mutex::new(HashMap::new()),
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

    /// 同一连接上同时运行的远程命令数上限，给终端和 SFTP 留出会话名额。
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

    fn remember_config(
        &self,
        connection_id: &str,
        config: SshConnectionConfig,
    ) -> Result<(), String> {
        let session = self.session(connection_id)?;
        let mut stored = session
            .config
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        *stored = config;
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
        let connected = match authenticate_session(config).await {
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

    async fn live_session(&self, connection_id: &str) -> Result<Arc<ConnectedSession>, String> {
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
            Err(error) if error.stale && self.keeps_busy_connection(connection_id, &session) => {
                Err(busy_connection_error(&error.message))
            }
            Err(error) if error.stale => {
                let session = self
                    .reconnect_after_channel_failure(connection_id, &session)
                    .await?;
                Ok(open_session_channel_once(&session, purpose).await?)
            }
            Err(error) => Err(error.message),
        }
    }

    /// 连接没真正关闭、上面还有终端在跑时不重连：远端多半只是卡顿（CPU/内存占满），
    /// 重连会断开旧连接，把这些终端里正在运行的进程一起杀掉。真断线由保活检测关闭连接后再重连。
    fn keeps_busy_connection(&self, connection_id: &str, session: &ConnectedSession) -> bool {
        !session.handle.is_closed() && self.has_live_terminals(connection_id)
    }

    fn has_live_terminals(&self, connection_id: &str) -> bool {
        self.terminals.read().is_ok_and(|terminals| {
            terminals.values().any(|session| {
                session.connection_id == connection_id && session.alive.load(Ordering::Acquire)
            })
        })
    }

    pub fn terminal_is_open(&self, id: &str) -> bool {
        self.terminals
            .read()
            .ok()
            .and_then(|terminals| {
                terminals
                    .get(id)
                    .map(|session| session.alive.load(Ordering::Acquire))
            })
            .unwrap_or(false)
    }

    fn session(&self, connection_id: &str) -> Result<Arc<ConnectedSession>, String> {
        self.sessions
            .read()
            .map_err(|_| "SSH 连接状态不可用".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| "SSH 连接尚未建立，请重新连接".to_string())
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

    fn root_is_registered(&self, uri: &str) -> Result<bool, String> {
        let normalized = normalize_remote_uri(uri);
        Ok(self
            .roots
            .read()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?
            .values()
            .any(|root| normalize_remote_uri(&root.uri) == normalized))
    }

    fn set_root_trust(&self, uri: &str, trusted: bool) -> Result<(), String> {
        let normalized = normalize_remote_uri(uri);
        let mut roots = self
            .roots
            .write()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?;
        if let Some(root) = roots
            .values_mut()
            .find(|root| normalize_remote_uri(&root.uri) == normalized)
        {
            root.trusted = trusted;
        }
        Ok(())
    }

    async fn open_sftp(&self, connection_id: &str) -> Result<Arc<SftpSession>, String> {
        let session = self.live_session(connection_id).await?;
        match open_sftp_session(&session).await {
            Ok(sftp) => Ok(sftp),
            Err(error) if error.stale && self.keeps_busy_connection(connection_id, &session) => {
                Err(busy_connection_error(&error.message))
            }
            Err(error) if error.stale => {
                let session = self
                    .reconnect_after_channel_failure(connection_id, &session)
                    .await?;
                Ok(open_sftp_session(&session).await?)
            }
            Err(error) => Err(error.message),
        }
    }

    async fn sftp_for_uri(
        &self,
        uri: &str,
        require_trust: bool,
    ) -> Result<(Arc<SftpSession>, RemoteUri, RegisteredRoot), String> {
        let parsed = parse_remote_uri(uri)?;
        let root = self.root_for_uri(uri, require_trust)?;
        let sftp = self.open_sftp(&parsed.connection_id).await?;
        Ok((sftp, parsed, root))
    }

    async fn exec_uri(
        &self,
        uri: &str,
        command: &str,
        require_trust: bool,
    ) -> Result<RemoteExecResult, String> {
        let parsed = parse_remote_uri(uri)?;
        reject_windows_remote_command(&parsed.path)?;
        self.exec_command(uri, command, None, require_trust).await
    }

    async fn exec_uri_with_input(
        &self,
        uri: &str,
        command: &str,
        input: &[u8],
        require_trust: bool,
    ) -> Result<RemoteExecResult, String> {
        let parsed = parse_remote_uri(uri)?;
        reject_windows_remote_command(&parsed.path)?;
        self.exec_command(uri, command, Some(input), require_trust)
            .await
    }

    /// 在 Windows OpenSSH 远端执行 git：脚本经 stdin 传给 PowerShell，避免默认 shell 的转义差异。
    async fn exec_windows_git(
        &self,
        uri: &str,
        native_root: &str,
        args: &[String],
        require_trust: bool,
    ) -> Result<RemoteExecResult, String> {
        let script = windows_git_script(native_root, args)?;
        if let Some(command) = windows_powershell_inline_command(&script) {
            return self.exec_command(uri, &command, None, require_trust).await;
        }
        let input = encode_terminal_data(script.as_bytes());
        self.exec_command(
            uri,
            &windows_powershell_stdin_command(),
            Some(input.as_bytes()),
            require_trust,
        )
        .await
    }

    async fn exec_command(
        &self,
        uri: &str,
        command: &str,
        input: Option<&[u8]>,
        require_trust: bool,
    ) -> Result<RemoteExecResult, String> {
        let parsed = parse_remote_uri(uri)?;
        self.root_for_uri(uri, require_trust)?;
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
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                _ => {}
            }
        }
        Ok(RemoteExecResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: exit_code.unwrap_or(255),
        })
    }
}

#[tauri::command]
pub fn ssh_set_workspace_trust(
    root_uri: String,
    trusted: bool,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    parse_remote_uri(&root_uri)?;
    manager.set_root_trust(&root_uri, trusted)
}

#[derive(Debug)]
struct RemoteUri {
    connection_id: String,
    path: String,
}

fn parse_remote_uri(uri: &str) -> Result<RemoteUri, String> {
    let rest = uri
        .strip_prefix(SSH_URI_PREFIX)
        .ok_or_else(|| "不是有效的 SSH 资源地址".to_string())?;
    let (connection_id, path_tail) = rest
        .split_once('/')
        .ok_or_else(|| "SSH 资源地址缺少远程路径".to_string())?;
    if connection_id.is_empty() {
        return Err("SSH 资源地址缺少连接 ID".to_string());
    }
    let path = format!("/{path_tail}");
    validate_remote_path(&path)?;
    Ok(RemoteUri {
        connection_id: connection_id.to_string(),
        path: normalize_remote_path(&path),
    })
}

fn validate_remote_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("远程路径必须是绝对 POSIX 路径".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("远程路径不允许包含 ..".to_string());
    }
    Ok(())
}

fn normalize_remote_path(path: &str) -> String {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

fn normalize_remote_uri(uri: &str) -> String {
    uri.trim_end_matches('/').to_string()
}

fn remote_uri_connection_id(uri: &str) -> Option<&str> {
    uri.strip_prefix(SSH_URI_PREFIX)?
        .split('/')
        .next()
        .filter(|value| !value.is_empty())
}

fn remote_uri_is_within(uri: &str, root: &str) -> bool {
    let uri = normalize_remote_uri(uri);
    let root = normalize_remote_uri(root);
    uri == root || uri.starts_with(&format!("{root}/"))
}

fn join_remote_uri(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

fn home_path_candidates(username: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if username == "root" {
        paths.push("/root".to_string());
    } else if !username.is_empty() {
        paths.push(format!("/home/{username}"));
        paths.push(format!("/C:/Users/{username}"));
    }
    paths.push("/root".to_string());
    paths.push("/".to_string());
    paths.dedup();
    paths
}

/// Windows OpenSSH SFTP paths look like `/D:/code/app`.
fn windows_native_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix('/')?;
    let mut chars = rest.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next() != Some(':') {
        return None;
    }
    let native = rest.replace('/', "\\");
    if native.ends_with(':') {
        Some(format!("{native}\\"))
    } else {
        Some(native)
    }
}

fn powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// 生成远端启动 PowerShell 的命令，脚本走 `-EncodedCommand`。
///
/// `quote` 只用于交互式 PTY。Win32-OpenSSH 把 PTY 命令拼成
/// `bash.exe -c <command>` 的一条命令行，不加引号时 bash 只把 `powershell.exe`
/// 当成脚本。包上双引号后，bash、cmd（`/c` 会去掉首尾引号）和 PowerShell 收到的是同一条命令。
///
/// 非 PTY 的 exec（例如 Git）不一样：OpenSSH 用 argv 调用 `bash -c <command>`，
/// `<command>` 已经是完整脚本。再包一层引号，Git Bash 会把整段当成一个文件名，
/// 报 `Permission denied`。
fn windows_encoded_powershell(launcher: &str, script: &str, quote: bool) -> String {
    let utf16 = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let command = format!(
        "{launcher} -EncodedCommand {}",
        encode_terminal_data(&utf16)
    );
    if quote {
        format!("\"{command}\"")
    } else {
        command
    }
}

/// 启动交互式 PowerShell / pwsh，并在提示符出现前进入项目目录。
///
/// 不能等 PTY 出字后再注入 `Set-Location; Clear-Host`。Windows OpenSSH 的
/// ConPTY 启动时会写出 `[2J[m`，注入的回车会把其中的 `m` 粘到最后一条
/// 命令上（`Clear-Hostm`），清屏失败，切目录命令和错误都留在屏幕上。
fn windows_powershell_terminal(
    executable: &str,
    native: &str,
    resolved_shell: &str,
    fallback_from: Option<String>,
) -> ResolvedSshTerminal {
    let script = format!("Set-Location -LiteralPath '{}'", powershell_literal(native));
    ResolvedSshTerminal {
        command: windows_encoded_powershell(
            &format!("{executable} -NoLogo -NoExit"),
            &script,
            true,
        ),
        enter_directory: None,
        resolved_shell: resolved_shell.to_string(),
        fallback_from,
    }
}

/// 由 PowerShell 切到项目目录后启动 `cmd /K`。
///
/// 直接发 `cmd.exe /K cd /d "D:\..."` 时，默认 shell 若是 Git Bash，路径里的引号和
/// 反斜杠会被 bash 先解释掉；走编码脚本则与默认 shell 无关。
fn windows_cmd_terminal(native: &str) -> ResolvedSshTerminal {
    let script = format!(
        "$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath '{}'; & cmd.exe /K rem; exit $LASTEXITCODE",
        powershell_literal(native)
    );
    ResolvedSshTerminal {
        command: windows_encoded_powershell(
            "powershell.exe -NoLogo -NoProfile -NonInteractive",
            &script,
            true,
        ),
        enter_directory: None,
        resolved_shell: "cmd".to_string(),
        fallback_from: None,
    }
}

/// 按 MSVCRT 规则给 Windows 进程命令行参数加引号。
fn windows_quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
        }
        quoted.push(ch);
        backslashes = 0;
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

const WINDOWS_POWERSHELL_EXEC: &str = "powershell.exe -NoLogo -NoProfile -NonInteractive";

/// 纯 ASCII 的引导命令，cmd.exe 或 PowerShell 作为默认 shell 时都能原样执行；
/// 真正的脚本以 Base64(UTF-8) 从 stdin 读入，不受命令行长度和转义影响。
fn windows_powershell_stdin_command() -> String {
    // 先关闭进度输出，否则首次加载模块会往 stderr 写 CLIXML 进度记录。
    let bootstrap = "$ProgressPreference = 'SilentlyContinue'; $s = [Console]::In.ReadToEnd(); Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s.Trim())))";
    windows_encoded_powershell(WINDOWS_POWERSHELL_EXEC, bootstrap, false)
}

/// cmd.exe 单条命令行上限是 8191 字符，留出余量。
const WINDOWS_INLINE_COMMAND_LIMIT: usize = 8000;

/// 脚本直接放进 `-EncodedCommand`，不读 stdin。
///
/// 默认 shell 是 Git Bash 时，stdin 的 EOF 不一定传到 PowerShell，
/// `ReadToEnd()` 会一直挂着，连接断开后进程也留在远端。命令行放不下时返回 None，
/// 由调用方退回 stdin 方式。
fn windows_powershell_inline_command(script: &str) -> Option<String> {
    let command = windows_encoded_powershell(WINDOWS_POWERSHELL_EXEC, script, false);
    (command.len() <= WINDOWS_INLINE_COMMAND_LIMIT).then_some(command)
}

/// 用 Process 直接启动 git 并原样转发 stdout 字节，避免 PowerShell 按行重编码破坏 `-z` 输出。
fn windows_git_script(native_root: &str, args: &[String]) -> Result<String, String> {
    if args.iter().any(|arg| arg.contains('\0')) || native_root.contains('\0') {
        return Err("Git 参数包含无效字符".to_string());
    }
    let command_line = std::iter::once("-C".to_string())
        .chain(std::iter::once(native_root.to_string()))
        .chain(args.iter().cloned())
        .map(|arg| windows_quote_arg(&arg))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stderr = [Console]::OpenStandardError()
function Write-RawError([string]$text) {{
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $stderr.Write($bytes, 0, $bytes.Length)
  $stderr.Flush()
}}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'git.exe'
$psi.Arguments = '{}'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardErrorEncoding = [Text.Encoding]::UTF8
try {{
  $process = [Diagnostics.Process]::Start($psi)
}} catch {{
  Write-RawError ('远端未安装 git 或 git 不在 PATH 中：' + $_.Exception.Message)
  exit 127
}}
$process.StandardInput.Close()
$errorTask = $process.StandardError.ReadToEndAsync()
$stdout = [Console]::OpenStandardOutput()
$process.StandardOutput.BaseStream.CopyTo($stdout)
$stdout.Flush()
$process.WaitForExit()
Write-RawError $errorTask.Result
exit $process.ExitCode
"#,
        powershell_literal(&command_line)
    ))
}

const WINDOWS_REMOTE_COMMAND_ERROR: &str =
    "Windows SSH 项目暂不支持远程命令、搜索、格式化和运行任务";

fn reject_windows_remote_command(path: &str) -> Result<(), String> {
    if windows_native_path(path).is_some() {
        Err(WINDOWS_REMOTE_COMMAND_ERROR.to_string())
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedSshTerminal {
    command: String,
    enter_directory: Option<String>,
    resolved_shell: String,
    fallback_from: Option<String>,
}

fn ssh_interactive_terminal_command(
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

async fn resolve_remote_home(sftp: &SftpSession, username: &str) -> String {
    if let Ok(path) = sftp.canonicalize(".".to_string()).await {
        let normalized = normalize_remote_path(&path);
        if normalized.starts_with('/') {
            return normalized;
        }
    }
    for candidate in home_path_candidates(username) {
        if sftp.try_exists(candidate.clone()).await.unwrap_or(false) {
            if let Ok(canonical) = sftp.canonicalize(candidate).await {
                return normalize_remote_path(&canonical);
            }
        }
    }
    "/".to_string()
}

fn remote_parent_path(path: &str) -> Result<&str, String> {
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .ok_or_else(|| "远程路径缺少父目录".to_string())
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        Err("名称不能为空或包含路径分隔符".to_string())
    } else {
        Ok(())
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn open_transport(
    config: &SshConnectionConfig,
    expected_fingerprint: Option<String>,
) -> Result<(client::Handle<SshClient>, String), String> {
    let observed = Arc::new(Mutex::new(None));
    let handler = SshClient {
        expected_fingerprint,
        observed_fingerprint: Arc::clone(&observed),
    };
    let client_config = ssh_client_config();
    let result = client::connect(
        Arc::new(client_config),
        (config.host.as_str(), config.port),
        handler,
    )
    .await;
    let fingerprint = observed
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .unwrap_or_default();
    let handle = result.map_err(|error| format!("SSH 连接失败：{error}"))?;
    if fingerprint.is_empty() {
        return Err("SSH 服务端未提供主机密钥".to_string());
    }
    Ok((handle, fingerprint))
}

fn explicit_private_key_path(config: &SshConnectionConfig) -> Option<PathBuf> {
    config
        .private_key_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

fn default_private_key_candidates(home: &Path) -> Vec<PathBuf> {
    let ssh_dir = home.join(".ssh");
    [
        "id_ed25519",
        "id_ecdsa",
        "id_rsa",
        "id_ed25519_sk",
        "id_ecdsa_sk",
    ]
    .into_iter()
    .map(|name| ssh_dir.join(name))
    .collect()
}

fn resolve_private_key_paths(config: &SshConnectionConfig) -> Result<Vec<PathBuf>, String> {
    if let Some(path) = explicit_private_key_path(config) {
        return Ok(vec![path]);
    }
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录以查找默认 SSH 私钥".to_string())?;
    let paths: Vec<PathBuf> = default_private_key_candidates(&home)
        .into_iter()
        .filter(|path| path.is_file())
        .collect();
    if paths.is_empty() {
        return Err(
            "未找到本机默认 SSH 私钥（~/.ssh/id_ed25519 等）。WSL 一般没有登录密码，请选择私钥或先配置公钥登录。".to_string(),
        );
    }
    Ok(paths)
}

async fn authenticate_public_key(
    handle: &mut client::Handle<SshClient>,
    config: &SshConnectionConfig,
    key_path: &Path,
) -> Result<bool, String> {
    let key = load_secret_key(key_path, config.passphrase.as_deref())
        .map_err(|error| format!("读取 SSH 私钥失败：{}：{error}", key_path.display()))?;
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|error| format!("协商 SSH 密钥算法失败：{error}"))?
        .flatten();
    let result = handle
        .authenticate_publickey(
            &config.username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await
        .map_err(|error| format!("SSH 私钥认证失败：{error}"))?;
    Ok(result.success())
}

async fn authenticate(
    handle: &mut client::Handle<SshClient>,
    config: &SshConnectionConfig,
) -> Result<(), String> {
    match config.auth_kind.as_str() {
        "password" => {
            let password = config
                .password
                .as_deref()
                .ok_or_else(|| "请输入 SSH 密码".to_string())?;
            let result = handle
                .authenticate_password(&config.username, password)
                .await
                .map_err(|error| format!("SSH 密码认证失败：{error}"))?;
            if result.success() {
                Ok(())
            } else {
                Err("SSH 认证失败，请检查用户名和凭据".to_string())
            }
        }
        _ => {
            let key_paths = resolve_private_key_paths(config)?;
            let mut last_error = None;
            for key_path in key_paths {
                match authenticate_public_key(handle, config, &key_path).await {
                    Ok(true) => return Ok(()),
                    Ok(false) => {
                        last_error = Some(format!("SSH 私钥认证失败：{}", key_path.display()));
                    }
                    Err(error) => last_error = Some(error),
                }
            }
            Err(last_error.unwrap_or_else(|| "SSH 认证失败，请检查用户名和凭据".to_string()))
        }
    }
}

#[tauri::command]
pub async fn ssh_probe_host(config: SshConnectionConfig) -> Result<SshHostProbe, String> {
    let observed = Arc::new(Mutex::new(None));
    let handler = SshClient {
        expected_fingerprint: None,
        observed_fingerprint: Arc::clone(&observed),
    };
    let result = client::connect(
        Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(15)),
            ..Default::default()
        }),
        (config.host.as_str(), config.port),
        handler,
    )
    .await;
    if let Ok(handle) = result {
        let _ = handle
            .disconnect(Disconnect::ByApplication, "host key probe", "en")
            .await;
    }
    let fingerprint = observed
        .lock()
        .map_err(|_| "SSH 主机密钥状态不可用".to_string())?
        .clone()
        .ok_or_else(|| "无法获取 SSH 主机指纹，请检查地址和端口".to_string())?;
    Ok(SshHostProbe { fingerprint })
}

fn existing_session(manager: &SshManager, connection_id: &str) -> Option<Arc<ConnectedSession>> {
    manager
        .session(connection_id)
        .ok()
        .filter(|session| !session.handle.is_closed())
}

fn ssh_handshake_timeout_error(config: &SshConnectionConfig) -> String {
    format!(
        "SSH 连接超时：{}:{} 在 {} 秒内未完成握手，请检查远端 sshd 是否正常",
        config.host,
        config.port,
        SSH_HANDSHAKE_TIMEOUT.as_secs()
    )
}

/// 建立并认证一条新连接，但不登记到连接表。
async fn authenticate_session(
    config: SshConnectionConfig,
) -> Result<(ConnectedSession, String), String> {
    let expected = config
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty());
    let (handle, fingerprint) = tokio::time::timeout(SSH_HANDSHAKE_TIMEOUT, async {
        let (mut handle, fingerprint) = open_transport(&config, expected).await?;
        authenticate(&mut handle, &config).await?;
        Ok::<_, String>((handle, fingerprint))
    })
    .await
    .map_err(|_| ssh_handshake_timeout_error(&config))??;
    Ok((
        ConnectedSession {
            handle,
            config: Mutex::new(config),
            sftp: tokio::sync::Mutex::new(None),
        },
        fingerprint,
    ))
}

async fn store_authenticated_session(
    manager: &SshManager,
    config: SshConnectionConfig,
) -> Result<(Arc<ConnectedSession>, String), String> {
    let id = config.id.clone();
    let (connected, fingerprint) = authenticate_session(config).await?;
    let connected = Arc::new(connected);
    manager
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .insert(id, Arc::clone(&connected));
    Ok((connected, fingerprint))
}

#[tauri::command]
pub async fn ssh_open_session(
    config: SshConnectionConfig,
    manager: State<'_, SshManager>,
) -> Result<SshSessionOpenResult, String> {
    let expected = config
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "连接前必须确认 SSH 主机指纹".to_string())?;
    let fingerprint = if existing_session(&manager, &config.id).is_some() {
        manager.remember_config(&config.id, config.clone())?;
        expected
    } else {
        let (_connected, fingerprint) =
            store_authenticated_session(&manager, config.clone()).await?;
        fingerprint
    };
    let sftp = manager.open_sftp(&config.id).await?;
    Ok(SshSessionOpenResult {
        fingerprint,
        home_path: resolve_remote_home(&sftp, &config.username).await,
    })
}

#[tauri::command]
pub async fn ssh_browse_directory(
    connection_id: String,
    path: String,
    manager: State<'_, SshManager>,
) -> Result<SshBrowseResult, String> {
    validate_remote_path(&path)?;
    let normalized = normalize_remote_path(&path);
    let sftp = manager.open_sftp(&connection_id).await?;
    let canonical = sftp
        .canonicalize(normalized)
        .await
        .map_err(|error| format!("远程目录不可用：{error}"))?;
    let metadata = sftp
        .metadata(canonical.clone())
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    if !metadata.is_dir() {
        return Err("远程路径不是目录".to_string());
    }
    let mut dirs = Vec::new();
    let entries = sftp
        .read_dir(canonical.clone())
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." || !entry.metadata().is_dir() {
            continue;
        }
        dirs.push(RemoteFileNode {
            path: join_remote_path(&canonical, &name),
            name,
            is_dir: true,
        });
    }
    dirs.sort_by_key(|node| node.name.to_lowercase());
    Ok(SshBrowseResult {
        path: normalize_remote_path(&canonical),
        entries: dirs,
    })
}

#[tauri::command]
pub async fn ssh_connect(
    config: SshConnectionConfig,
    root_uri: String,
    trusted: bool,
    manager: State<'_, SshManager>,
) -> Result<SshConnectResult, String> {
    let expected = config
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "连接前必须确认 SSH 主机指纹".to_string())?;
    let parsed_root = parse_remote_uri(&root_uri)?;
    if parsed_root.connection_id != config.id {
        return Err("SSH 项目与连接配置不匹配".to_string());
    }
    let fingerprint = if existing_session(&manager, &config.id).is_some() {
        manager.remember_config(&config.id, config.clone())?;
        expected
    } else {
        let (_connected, fingerprint) =
            store_authenticated_session(&manager, config.clone()).await?;
        fingerprint
    };
    let sftp = manager.open_sftp(&config.id).await?;
    let canonical_root = sftp
        .canonicalize(parsed_root.path)
        .await
        .map_err(|error| format!("远程项目目录不可用：{error}"))?;
    let metadata = sftp
        .metadata(canonical_root.clone())
        .await
        .map_err(|error| format!("读取远程项目目录失败：{error}"))?;
    if !metadata.is_dir() {
        return Err("远程项目路径不是目录".to_string());
    }
    manager
        .roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .insert(
            root_uri.clone(),
            RegisteredRoot {
                uri: normalize_remote_uri(&root_uri),
                canonical_path: canonical_root.clone(),
                trusted,
            },
        );
    Ok(SshConnectResult {
        fingerprint,
        canonical_root,
    })
}

#[tauri::command]
pub async fn ssh_disconnect(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    // 等进行中的重连结束再移除，否则重连完成后会把连接重新插回表里。
    let gate = manager.reconnect_gate(&connection_id)?;
    let mut last_failure = gate.lock().await;
    *last_failure = None;
    let session = manager
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .remove(&connection_id);
    manager
        .roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .retain(|_, root| remote_uri_connection_id(&root.uri) != Some(connection_id.as_str()));
    if let Some(session) = session {
        session
            .handle
            .disconnect(Disconnect::ByApplication, "QingCode disconnect", "en")
            .await
            .map_err(|error| format!("断开 SSH 连接失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_connection_status(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<bool, String> {
    Ok(manager
        .sessions
        .read()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .get(&connection_id)
        .is_some_and(|session| !session.handle.is_closed()))
}

#[tauri::command]
pub fn ssh_workspace_status(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<bool, String> {
    let parsed = parse_remote_uri(&root_uri)?;
    let connection_alive = manager
        .sessions
        .read()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .get(&parsed.connection_id)
        .is_some_and(|session| !session.handle.is_closed());
    Ok(connection_alive && manager.root_is_registered(&root_uri)?)
}

#[tauri::command]
pub async fn ssh_validate_directory(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("远程目录不可用：{error}"))?;
    if !metadata.is_dir() {
        return Err(format!("远程路径不是目录：{}", parsed.path));
    }
    let canonical = sftp
        .canonicalize(parsed.path)
        .await
        .map_err(|error| format!("无法解析远程目录：{error}"))?;
    if !remote_path_is_within(&canonical, &root.canonical_path) {
        return Err("远程目录通过符号链接跳出了项目根目录".to_string());
    }
    Ok(())
}

fn remote_path_is_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

async fn ensure_existing_path_within(
    sftp: &SftpSession,
    path: &str,
    root: &RegisteredRoot,
) -> Result<String, String> {
    let canonical = sftp
        .canonicalize(path.to_string())
        .await
        .map_err(|error| format!("无法解析远程路径：{error}"))?;
    if !remote_path_is_within(&canonical, &root.canonical_path) {
        return Err("远程路径通过符号链接跳出了项目根目录".to_string());
    }
    Ok(canonical)
}

async fn ensure_parent_path_within(
    sftp: &SftpSession,
    path: &str,
    root: &RegisteredRoot,
) -> Result<String, String> {
    ensure_existing_path_within(sftp, remote_parent_path(path)?, root).await
}

#[tauri::command]
pub async fn ssh_scan_directory(
    path: String,
    workspace_root: Option<String>,
    exclude_patterns: Option<Vec<String>>,
    _exclude_git_ignore: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteFileNode>, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    let canonical = sftp
        .canonicalize(parsed.path.clone())
        .await
        .map_err(|error| format!("无法解析远程目录：{error}"))?;
    if !remote_path_is_within(&canonical, &root.canonical_path) {
        return Err("远程目录通过符号链接跳出了项目根目录".to_string());
    }

    let root_posix = if let Some(ref ws_root) = workspace_root {
        if let Ok(p) = parse_remote_uri(ws_root) {
            p.path
        } else {
            root.canonical_path.clone()
        }
    } else {
        root.canonical_path.clone()
    };
    let root_posix = root_posix.trim_end_matches('/').to_string();

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let entries = sftp
        .read_dir(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    for entry in entries {
        let name = entry.file_name();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let full_posix = if parsed.path.ends_with('/') {
            format!("{}{name}", parsed.path)
        } else {
            format!("{}/{name}", parsed.path)
        };
        let rel = if full_posix.starts_with(&root_posix) {
            full_posix[root_posix.len()..].trim_start_matches('/')
        } else {
            &name
        };

        let should_skip = match exclude_patterns.as_deref() {
            Some(patterns) => {
                if rel.is_empty() {
                    false
                } else {
                    crate::exclude::is_path_excluded(rel, patterns)
                }
            }
            None => crate::exclude::default_hard_ignore_name(&name),
        };
        if should_skip {
            continue;
        }

        let node = RemoteFileNode {
            path: join_remote_uri(&path, &name),
            name,
            is_dir: entry.metadata().is_dir(),
        };
        if node.is_dir {
            dirs.push(node);
        } else {
            files.push(node);
        }
    }
    dirs.sort_by_key(|node| node.name.to_lowercase());
    files.sort_by_key(|node| node.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub async fn ssh_file_stat(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteFileStat, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    Ok(RemoteFileStat {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
    })
}

#[tauri::command]
pub async fn ssh_file_mtime(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Option<u64>, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件时间失败：{error}"))?;
    Ok(metadata.mtime.map(|seconds| u64::from(seconds) * 1000))
}

#[tauri::command]
pub async fn ssh_read_file(
    path: String,
    encoding: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    // Reject known-binary formats before pulling the whole file across SFTP.
    if crate::binary_ext::is_binary_extension(&parsed.path) {
        return Err(crate::binary_ext::unsupported_remote_binary_message(
            &parsed.path,
        ));
    }
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    if metadata.is_dir() {
        return Err("无法把远程目录作为文件打开".to_string());
    }
    if metadata.len() > MAX_EDITOR_FILE_SIZE {
        return Err("暂不支持编辑超过 100MB 的远程文件".to_string());
    }
    let bytes = sftp
        .read(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    file_encoding::decode(&bytes, file_encoding::parse(encoding.as_deref()))
        .map_err(|error| format!("远程文件解码失败：{error}"))
}

#[tauri::command]
pub async fn ssh_detect_file_encoding(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    // `detect` reads the head of the file; skip the round trip for formats that
    // are binary by definition so the UI can name the real reason.
    if crate::binary_ext::is_binary_extension(&parsed.path) {
        return Err(crate::binary_ext::unsupported_remote_binary_message(
            &parsed.path,
        ));
    }
    let bytes = sftp
        .read(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    file_encoding::detect(&bytes[..bytes.len().min(8192)])
        .map(|encoding| encoding.as_str().to_string())
        .map_err(|error| format!("检测远程文件编码失败：{error}"))
}

#[tauri::command]
pub async fn ssh_read_file_slice(
    path: String,
    offset: u64,
    max_bytes: u64,
    manager: State<'_, SshManager>,
) -> Result<RemoteFileSlice, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let mut file = sftp
        .open(parsed.path)
        .await
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    let file_size = metadata.len();
    if offset > file_size {
        return Err("读取偏移超出远程文件范围".to_string());
    }
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| format!("定位远程文件失败：{error}"))?;
    let requested = max_bytes.clamp(1, MAX_SLICE_BYTES).min(file_size - offset) as usize;
    let mut bytes = vec![0; requested];
    let read = file
        .read(&mut bytes)
        .await
        .map_err(|error| format!("读取远程文件片段失败：{error}"))?;
    bytes.truncate(read);
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let next_offset = offset + read as u64;
    Ok(RemoteFileSlice {
        content,
        offset,
        next_offset,
        file_size,
        eof: next_offset >= file_size,
    })
}

#[tauri::command]
pub async fn ssh_find_line_offset(
    path: String,
    line: u64,
    manager: State<'_, SshManager>,
) -> Result<crate::commands::cmd_stat::LineOffsetResult, String> {
    if line == 0 {
        return Err("行号必须从 1 开始".into());
    }
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let mut file = sftp
        .open(parsed.path)
        .await
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    if metadata.is_dir() {
        return Err("无法打开文件夹".into());
    }
    let file_size = metadata.len();
    if file_size == 0 {
        return Ok(crate::commands::cmd_stat::LineOffsetResult {
            line,
            offset: 0,
            found: line == 1,
            total_lines: 0,
            file_size: 0,
        });
    }
    if line == 1 {
        return Ok(crate::commands::cmd_stat::LineOffsetResult {
            line: 1,
            offset: 0,
            found: true,
            total_lines: 1,
            file_size,
        });
    }

    const BUF_SIZE: usize = 64 * 1024;
    let mut buf = [0u8; BUF_SIZE];
    let mut current_line: u64 = 1;
    let mut file_pos: u64 = 0;

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|error| format!("读取远程文件失败：{error}"))?;
        if n == 0 {
            break;
        }
        for (i, &b) in buf[..n].iter().enumerate() {
            if b == b'\n' {
                let next_offset = file_pos + i as u64 + 1;
                current_line += 1;
                if current_line == line {
                    return Ok(crate::commands::cmd_stat::LineOffsetResult {
                        line,
                        offset: next_offset.min(file_size),
                        found: true,
                        total_lines: line,
                        file_size,
                    });
                }
            }
        }
        file_pos += n as u64;
    }

    Ok(crate::commands::cmd_stat::LineOffsetResult {
        line,
        offset: file_size,
        found: false,
        total_lines: current_line,
        file_size,
    })
}

fn remote_write_flags(exclusive: bool) -> OpenFlags {
    let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
    if exclusive {
        flags | OpenFlags::EXCLUDE
    } else {
        flags
    }
}

async fn write_remote_file_contents(
    sftp: &SftpSession,
    path: String,
    bytes: &[u8],
    exclusive: bool,
) -> Result<(), String> {
    let mut file = sftp
        .open_with_flags(path, remote_write_flags(exclusive))
        .await
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .await
        .map_err(|error| error.to_string())?;
    file.shutdown().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    let bytes = file_encoding::encode(&content, file_encoding::parse(encoding.as_deref()))
        .map_err(|error| format!("远程文件编码失败：{error}"))?;
    if bytes.len() as u64 > MAX_EDITOR_FILE_SIZE {
        return Err("暂不支持保存超过 100MB 的远程文件".to_string());
    }
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
        let metadata = sftp
            .symlink_metadata(parsed.path.clone())
            .await
            .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
        if metadata.is_dir() {
            return Err("无法把远程目录作为文件保存".to_string());
        }
        // Preserve symlink semantics: an atomic rename would replace the link itself.
        if metadata.is_symlink() {
            return write_remote_file_contents(&sftp, parsed.path, &bytes, false)
                .await
                .map_err(|error| format!("保存远程符号链接目标失败：{error}"));
        }
    }
    let parent = remote_parent_path(&parsed.path)?;
    let name = parsed.path.rsplit('/').next().unwrap_or("file");
    let temp = format!("{parent}/.{name}.qingcode-{}.tmp", uuid::Uuid::new_v4());
    write_remote_file_contents(&sftp, temp.clone(), &bytes, true)
        .await
        .map_err(|error| format!("上传远程临时文件失败：{error}"))?;
    if let Err(rename_error) = sftp.rename(temp.clone(), parsed.path.clone()).await {
        // SFTP v3 servers are allowed to reject rename when the destination exists.
        // Keep atomic rename where supported, and safely fall back to truncating the
        // existing regular file without deleting it first.
        if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
            let fallback = write_remote_file_contents(&sftp, parsed.path.clone(), &bytes, false)
                .await
                .map_err(|write_error| {
                    format!("替换远程文件失败：{rename_error}；直接写入也失败：{write_error}")
                });
            let _ = sftp.remove_file(temp).await;
            fallback?;
        } else {
            let _ = sftp.remove_file(temp).await;
            return Err(format!("替换远程文件失败：{rename_error}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_check_symlink_write(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteSymlinkWriteCheck, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    let probe = if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        parsed.path
    } else {
        remote_parent_path(&parsed.path)?.to_string()
    };
    let canonical = sftp
        .canonicalize(probe)
        .await
        .map_err(|error| format!("无法解析远程符号链接目标：{error}"))?;
    if !remote_path_is_within(&canonical, &root.canonical_path) {
        return Err("远程路径通过符号链接跳出了项目根目录，已拒绝写入".to_string());
    }
    Ok(RemoteSymlinkWriteCheck {
        needs_confirm: false,
        resolved_path: Some(canonical),
    })
}

#[tauri::command]
pub async fn ssh_create_file(
    parent: String,
    name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let target_uri = join_remote_uri(&parent, &name);
    let (sftp, parsed, root) = manager.sftp_for_uri(&target_uri, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        return Err("同名文件或文件夹已存在".to_string());
    }
    write_remote_file_contents(&sftp, parsed.path, &[], true)
        .await
        .map_err(|error| format!("创建远程文件失败：{error}"))?;
    Ok(target_uri)
}

#[tauri::command]
pub async fn ssh_create_directory(
    parent: String,
    name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let target_uri = join_remote_uri(&parent, &name);
    let (sftp, parsed, root) = manager.sftp_for_uri(&target_uri, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    sftp.create_dir(parsed.path)
        .await
        .map_err(|error| format!("创建远程文件夹失败：{error}"))?;
    Ok(target_uri)
}

#[tauri::command]
pub async fn ssh_rename_path(
    path: String,
    new_name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&new_name)?;
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    let uri_parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .ok_or_else(|| "远程路径缺少父目录".to_string())?;
    let new_uri = join_remote_uri(uri_parent, &new_name);
    let new_path = format!(
        "{}/{}",
        remote_parent_path(&parsed.path)?.trim_end_matches('/'),
        new_name
    );
    sftp.rename(parsed.path, new_path)
        .await
        .map_err(|error| format!("重命名远程路径失败：{error}"))?;
    Ok(new_uri)
}

async fn remove_remote_tree(sftp: &SftpSession, path: String) -> Result<(), String> {
    let metadata = sftp
        .symlink_metadata(path.clone())
        .await
        .map_err(|error| format!("读取远程路径失败：{error}"))?;
    if metadata.is_dir() && !metadata.is_symlink() {
        let entries = sftp
            .read_dir(path.clone())
            .await
            .map_err(|error| format!("读取远程目录失败：{error}"))?;
        for entry in entries {
            Box::pin(remove_remote_tree(sftp, entry.path())).await?;
        }
        sftp.remove_dir(path)
            .await
            .map_err(|error| format!("删除远程目录失败：{error}"))
    } else {
        sftp.remove_file(path)
            .await
            .map_err(|error| format!("删除远程文件失败：{error}"))
    }
}

async fn resolve_remote_dest_child(
    sftp: &SftpSession,
    dest_dir: &str,
    file_name: &str,
    conflict_policy: Option<&str>,
) -> Result<(String, String, bool), String> {
    let preferred_path = if dest_dir.ends_with('/') {
        format!("{dest_dir}{file_name}")
    } else {
        format!("{dest_dir}/{file_name}")
    };
    if sftp.metadata(preferred_path.clone()).await.is_err() {
        return Ok((file_name.to_string(), preferred_path, false));
    }
    match conflict_policy.unwrap_or("fail") {
        "overwrite" => Ok((file_name.to_string(), preferred_path, true)),
        "rename" => {
            let (stem, ext) = match file_name.rsplit_once('.') {
                Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
                _ => (file_name, String::new()),
            };
            for i in 1..=1000 {
                let candidate_name = format!("{stem} ({i}){ext}");
                let candidate_path = if dest_dir.ends_with('/') {
                    format!("{dest_dir}{candidate_name}")
                } else {
                    format!("{dest_dir}/{candidate_name}")
                };
                if sftp.metadata(candidate_path.clone()).await.is_err() {
                    return Ok((candidate_name, candidate_path, false));
                }
            }
            Err("无法生成可用的远程目标文件名".to_string())
        }
        "fail" => Err("目标名称已存在".to_string()),
        other => Err(format!("未知的冲突策略：{other}")),
    }
}

async fn copy_remote_file(sftp: &SftpSession, src: String, dest: String) -> Result<(), String> {
    let mut reader = sftp
        .open(src)
        .await
        .map_err(|e| format!("打开远程源文件失败：{e}"))?;
    let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
    let mut writer = sftp
        .open_with_flags(dest, flags)
        .await
        .map_err(|e| format!("创建远程目标文件失败：{e}"))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取远程文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("写入远程文件失败：{e}"))?;
    }
    Ok(())
}

async fn copy_remote_tree(sftp: &SftpSession, src: String, dest: String) -> Result<(), String> {
    let metadata = sftp
        .symlink_metadata(src.clone())
        .await
        .map_err(|e| format!("读取远程路径失败：{e}"))?;
    if metadata.is_dir() && !metadata.is_symlink() {
        sftp.create_dir(dest.clone())
            .await
            .map_err(|e| format!("创建远程目录失败：{e}"))?;
        let entries = sftp
            .read_dir(src)
            .await
            .map_err(|e| format!("读取远程目录失败：{e}"))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_dest = format!("{}/{}", dest.trim_end_matches('/'), name);
            Box::pin(copy_remote_tree(sftp, entry.path().to_string(), child_dest)).await?;
        }
        Ok(())
    } else {
        copy_remote_file(sftp, src, dest).await
    }
}

#[tauri::command]
pub async fn ssh_move_path(
    path: String,
    dest_dir: String,
    conflict_policy: Option<String>,
    dest_name: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (source_sftp, source_parsed, source_root) = manager.sftp_for_uri(&path, true).await?;
    let (dest_sftp, dest_parsed, dest_root) = manager.sftp_for_uri(&dest_dir, true).await?;

    if source_parsed.connection_id != dest_parsed.connection_id {
        return Err("不支持跨 SSH 连接移动文件".to_string());
    }
    ensure_existing_path_within(&source_sftp, &source_parsed.path, &source_root).await?;
    ensure_existing_path_within(&dest_sftp, &dest_parsed.path, &dest_root).await?;

    if normalize_remote_uri(&path) == source_root.uri {
        return Err("不允许移动远程项目根目录".to_string());
    }

    let source_meta = source_sftp
        .symlink_metadata(source_parsed.path.clone())
        .await
        .map_err(|e| format!("读取源路径失败：{e}"))?;

    let dest_meta = dest_sftp
        .metadata(dest_parsed.path.clone())
        .await
        .map_err(|e| format!("读取目标文件夹失败：{e}"))?;
    if !dest_meta.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    let initial_name = dest_name.unwrap_or_else(|| {
        source_parsed
            .path
            .rsplit('/')
            .next()
            .unwrap_or(&source_parsed.path)
            .to_string()
    });
    validate_entry_name(&initial_name)?;

    let (final_name, final_dest_path, overwrite) = resolve_remote_dest_child(
        &dest_sftp,
        &dest_parsed.path,
        &initial_name,
        conflict_policy.as_deref(),
    )
    .await?;

    if source_meta.is_dir() {
        let src_prefix = if source_parsed.path.ends_with('/') {
            source_parsed.path.clone()
        } else {
            format!("{}/", source_parsed.path)
        };
        if final_dest_path == source_parsed.path || dest_parsed.path.starts_with(&src_prefix) {
            return Err("不能将文件夹移动到其自身或子目录中".to_string());
        }
    }

    if overwrite {
        remove_remote_tree(&dest_sftp, final_dest_path.clone()).await?;
    }

    dest_sftp
        .rename(source_parsed.path, final_dest_path)
        .await
        .map_err(|e| format!("移动远程路径失败：{e}"))?;

    Ok(join_remote_uri(&dest_dir, &final_name))
}

#[tauri::command]
pub async fn ssh_copy_path_into(
    path: String,
    dest_dir: String,
    conflict_policy: Option<String>,
    dest_name: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (source_sftp, source_parsed, source_root) = manager.sftp_for_uri(&path, false).await?;
    let (dest_sftp, dest_parsed, dest_root) = manager.sftp_for_uri(&dest_dir, true).await?;

    if source_parsed.connection_id != dest_parsed.connection_id {
        return Err("不支持跨 SSH 连接复制文件".to_string());
    }
    ensure_existing_path_within(&source_sftp, &source_parsed.path, &source_root).await?;
    ensure_existing_path_within(&dest_sftp, &dest_parsed.path, &dest_root).await?;

    let dest_meta = dest_sftp
        .metadata(dest_parsed.path.clone())
        .await
        .map_err(|e| format!("读取目标文件夹失败：{e}"))?;
    if !dest_meta.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    let initial_name = dest_name.unwrap_or_else(|| {
        source_parsed
            .path
            .rsplit('/')
            .next()
            .unwrap_or(&source_parsed.path)
            .to_string()
    });
    validate_entry_name(&initial_name)?;

    let (final_name, final_dest_path, overwrite) = resolve_remote_dest_child(
        &dest_sftp,
        &dest_parsed.path,
        &initial_name,
        conflict_policy.as_deref(),
    )
    .await?;

    if overwrite {
        remove_remote_tree(&dest_sftp, final_dest_path.clone()).await?;
    }

    copy_remote_tree(&dest_sftp, source_parsed.path, final_dest_path).await?;

    Ok(join_remote_uri(&dest_dir, &final_name))
}

#[tauri::command]
pub async fn ssh_delete_path(path: String, manager: State<'_, SshManager>) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    if normalize_remote_uri(&path) == root.uri {
        return Err("不允许删除远程项目根目录".to_string());
    }
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    remove_remote_tree(&sftp, parsed.path).await
}

#[tauri::command]
pub async fn ssh_directory_delete_stats(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<crate::commands::cmd_fs::DirectoryDeleteStats, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程路径失败：{error}"))?;
    if !metadata.is_dir() {
        return Err("路径不是文件夹".to_string());
    }

    let mut file_count = 0u64;
    let mut total_size = 0u64;
    let mut queue = vec![parsed.path];

    while let Some(dir) = queue.pop() {
        let entries = match sftp.read_dir(dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let meta = entry.metadata();
            if meta.is_dir() && !meta.is_symlink() {
                queue.push(entry.path().to_string());
            } else {
                file_count += 1;
                total_size = total_size.saturating_add(meta.len());
            }
        }
    }

    Ok(crate::commands::cmd_fs::DirectoryDeleteStats {
        path,
        file_count,
        total_size,
    })
}

#[tauri::command]
pub async fn ssh_upload_paths(
    destination: String,
    local_paths: Vec<String>,
    manager: State<'_, SshManager>,
    allowlist: State<'_, PathAllowlist>,
    app: AppHandle,
) -> Result<(), String> {
    let result = ssh_transfer_paths(
        uuid::Uuid::new_v4().to_string(),
        String::from("upload"),
        local_paths,
        destination,
        manager,
        allowlist,
        app,
    )
    .await?;
    result.error.map_or(Ok(()), Err)
}

#[tauri::command]
pub async fn ssh_download_paths(
    paths: Vec<String>,
    destination: String,
    manager: State<'_, SshManager>,
    allowlist: State<'_, PathAllowlist>,
    app: AppHandle,
) -> Result<(), String> {
    let result = ssh_transfer_paths(
        uuid::Uuid::new_v4().to_string(),
        String::from("download"),
        paths,
        destination,
        manager,
        allowlist,
        app,
    )
    .await?;
    result.error.map_or(Ok(()), Err)
}

fn fuzzy_contains(value: &str, query: &str) -> bool {
    let mut chars = query.chars();
    let mut wanted = chars.next();
    for ch in value.chars() {
        if Some(ch) == wanted {
            wanted = chars.next();
            if wanted.is_none() {
                return true;
            }
        }
    }
    wanted.is_none()
}

fn remote_relative_path(root_path: &str, full_path: &str) -> String {
    full_path
        .strip_prefix(root_path.trim_end_matches('/'))
        .unwrap_or(full_path)
        .trim_start_matches('/')
        .trim_start_matches("./")
        .to_string()
}

fn simple_glob_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.trim_start_matches("./").trim_start_matches('/');
    if pattern.is_empty() {
        return false;
    }
    let anchored = pattern.contains('/');
    let candidate = if anchored {
        value
    } else {
        value.rsplit('/').next().unwrap_or(value)
    };
    let pattern = pattern.replace("**", "*");
    let mut remaining = candidate;
    let mut first = true;
    for part in pattern.split('*') {
        if part.is_empty() {
            continue;
        }
        let Some(index) = remaining.find(part) else {
            return false;
        };
        if first && !pattern.starts_with('*') && index != 0 {
            return false;
        }
        remaining = &remaining[index + part.len()..];
        first = false;
    }
    pattern.ends_with('*') || remaining.is_empty()
}

#[tauri::command]
pub async fn ssh_list_file_extensions(
    roots: Vec<String>,
    max_files: Option<usize>,
    manager: State<'_, SshManager>,
) -> Result<Vec<String>, String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let max = max_files.unwrap_or(8_000).clamp(100, 50_000);
    for root in roots {
        if !root.starts_with(SSH_URI_PREFIX) {
            continue;
        }
        let parsed = parse_remote_uri(&root)?;
        let command = format!(
            "find {} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/target/*' -print | head -n {max}",
            shell_quote(&parsed.path)
        );
        let output = manager.exec_uri(&root, &command, false).await?;
        for path in output.stdout.lines() {
            if let Some((_, extension)) = path.rsplit_once('.') {
                let extension = extension.to_ascii_lowercase();
                if !extension.contains('/') && extension.len() <= 16 {
                    *counts.entry(extension).or_default() += 1;
                }
            }
        }
    }
    let mut extensions = counts.into_iter().collect::<Vec<_>>();
    extensions.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(extensions
        .into_iter()
        .map(|(extension, _)| extension)
        .take(80)
        .collect())
}

fn parse_git_branch_header(header: &str) -> (Option<String>, Option<String>, u32, u32) {
    let value = header.trim_start_matches("## ");
    if value.starts_with("No commits yet on ") {
        return (
            Some(value.trim_start_matches("No commits yet on ").to_string()),
            None,
            0,
            0,
        );
    }
    if value.starts_with("HEAD (no branch)") {
        return (Some("HEAD".to_string()), None, 0, 0);
    }
    let (head_part, counts) = value.split_once(" [").unwrap_or((value, ""));
    let (branch, upstream) = head_part
        .split_once("...")
        .map_or((head_part, None), |(branch, upstream)| {
            (branch, Some(upstream.to_string()))
        });
    let mut ahead = 0;
    let mut behind = 0;
    for item in counts.trim_end_matches(']').split(',') {
        let item = item.trim();
        if let Some(value) = item.strip_prefix("ahead ") {
            ahead = value.parse().unwrap_or(0);
        }
        if let Some(value) = item.strip_prefix("behind ") {
            behind = value.parse().unwrap_or(0);
        }
    }
    (Some(branch.to_string()), upstream, ahead, behind)
}

/// `git status --porcelain=v1 -z` 的解析结果；路径仍是「仓库根相对」。
#[derive(Debug, Default, PartialEq, Eq)]
struct RemoteGitStatusParse {
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    entries: Vec<(String, String)>,
}

/// 解析 `-z` 输出：分支头 + `XY<空格>PATH` 记录（R/C 后面紧跟原路径，需要跳过）。
/// 编辑器自身的临时产物在这里就被剔除，避免徽标随粘贴上传抖动。
fn parse_remote_git_status(stdout: &str) -> RemoteGitStatusParse {
    let records = stdout.split('\0').collect::<Vec<_>>();
    let mut parsed = RemoteGitStatusParse::default();
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.starts_with("## ") {
            let (branch, upstream, ahead, behind) = parse_git_branch_header(record);
            parsed.branch = branch;
            parsed.upstream = upstream;
            parsed.ahead = ahead;
            parsed.behind = behind;
            continue;
        }
        if record.len() < 4 {
            continue;
        }
        let status = record[..2].to_string();
        let relative = record[3..].to_string();
        if status.contains('R') || status.contains('C') {
            index += 1;
        }
        if crate::git_status::is_editor_artifact(&relative, &status) {
            continue;
        }
        parsed.entries.push((relative, status));
    }
    parsed
}

/// 项目根相对仓库根的路径前缀（如 `apps/web/`；项目根即仓库根时为空）。
///
/// 结果按项目缓存：`git status` 一个项目只探测一次，稳态不额外增加远程往返。
async fn remote_git_prefix(manager: &SshManager, path: &str) -> String {
    let key = normalize_remote_uri(path);
    if let Some(cached) = manager.cached_git_prefix(&key) {
        return cached;
    }
    let output = remote_git_command(
        manager,
        path,
        vec!["rev-parse".to_string(), "--show-prefix".to_string()],
        false,
    )
    .await;
    let Ok(output) = output else {
        return String::new();
    };
    if output.exit_code != 0 {
        return String::new();
    }
    let mut prefix = output.stdout.trim().to_string();
    if !prefix.is_empty() && !prefix.ends_with('/') {
        prefix.push('/');
    }
    manager.remember_git_prefix(&key, &prefix);
    prefix
}

#[tauri::command]
pub async fn ssh_git_status(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitStatus, String> {
    let output = remote_git_command(
        &manager,
        &path,
        [
            "status",
            "--porcelain=v1",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
            // 限定在项目子树内：否则仓库其它目录的改动也会算进项目徽标。
            "--",
            ".",
        ]
        .map(str::to_string)
        .to_vec(),
        false,
    )
    .await?;
    if output.exit_code != 0 {
        if output
            .stderr
            .to_ascii_lowercase()
            .contains("not a git repository")
        {
            return Ok(RemoteGitStatus {
                is_repository: false,
                branch: None,
                upstream: None,
                behind: 0,
                ahead: 0,
                last_fetch_at: None,
                last_pull_at: None,
                last_push_at: None,
                changes: Vec::new(),
            });
        }
        return Err(format!("读取远程 Git 状态失败：{}", output.stderr.trim()));
    }
    let parsed = parse_remote_git_status(&output.stdout);

    // porcelain 永远是「仓库根相对」；项目根是仓库子目录时要裁掉前缀，
    // 否则前端按 `项目根 + 相对路径` 拼出来的绝对路径是错的。
    let prefix = remote_git_prefix(&manager, &path).await;
    let prefix_matches = prefix.is_empty()
        || parsed
            .entries
            .iter()
            .all(|(relative, _)| relative.starts_with(prefix.as_str()));
    let prefix = if prefix_matches {
        prefix
    } else {
        // 缓存的前缀过期（项目被移动/重新 init）：本次退回仓库根相对，并让下次重新探测。
        manager.forget_git_prefix(&normalize_remote_uri(&path));
        String::new()
    };
    let changes = parsed
        .entries
        .into_iter()
        .filter_map(|(relative, status)| {
            crate::git_status::strip_git_prefix(&relative, &prefix)
                .map(|path| RemoteGitChange { path, status })
        })
        .collect::<Vec<_>>();
    Ok(RemoteGitStatus {
        is_repository: true,
        branch: parsed.branch,
        upstream: parsed.upstream,
        behind: parsed.behind,
        ahead: parsed.ahead,
        last_fetch_at: None,
        last_pull_at: None,
        last_push_at: None,
        changes,
    })
}

fn remote_git_file(root_uri: &str, value: &str) -> Result<String, String> {
    let relative = if value.starts_with(SSH_URI_PREFIX) {
        let root = parse_remote_uri(root_uri)?;
        let file = parse_remote_uri(value)?;
        if root.connection_id != file.connection_id
            || !remote_path_is_within(&file.path, &root.path)
        {
            return Err("仅允许操作当前 SSH 项目内的 Git 文件".to_string());
        }
        remote_relative_path(&root.path, &file.path)
    } else {
        value.replace('\\', "/")
    };
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.split('/').any(|part| part == "..")
    {
        return Err("仅允许操作当前 SSH 项目内的 Git 文件".to_string());
    }
    Ok(relative)
}

async fn remote_git_command(
    manager: &SshManager,
    path: &str,
    args: Vec<String>,
    require_trust: bool,
) -> Result<RemoteExecResult, String> {
    let parsed = parse_remote_uri(path)?;
    if let Some(native_root) = windows_native_path(&parsed.path) {
        return manager
            .exec_windows_git(path, &native_root, &args, require_trust)
            .await;
    }
    let command = format!(
        "git -C {} {}",
        shell_quote(&parsed.path),
        args.iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    manager.exec_uri(path, &command, require_trust).await
}

#[tauri::command]
pub async fn ssh_git_stage(
    path: String,
    files: Vec<String>,
    all: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let mut args = vec!["add".to_string()];
    if all.unwrap_or(false) || files.is_empty() {
        args.push("--all".to_string());
    } else {
        args.push("--".to_string());
        for file in files {
            args.push(remote_git_file(&path, &file)?);
        }
    }
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(output.stderr)
    }
}

#[tauri::command]
pub async fn ssh_git_unstage(
    path: String,
    files: Vec<String>,
    all: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let mut args = vec!["reset".to_string(), "HEAD".to_string()];
    if !all.unwrap_or(false) && !files.is_empty() {
        args.push("--".to_string());
        for file in files {
            args.push(remote_git_file(&path, &file)?);
        }
    }
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(output.stderr)
    }
}

#[tauri::command]
pub async fn ssh_git_commit(
    path: String,
    message: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    let output = remote_git_command(
        &manager,
        &path,
        vec!["commit".to_string(), "-m".to_string(), message],
        true,
    )
    .await?;
    if output.exit_code == 0 {
        Ok(output.stdout.trim().to_string())
    } else {
        Err(output.stderr)
    }
}

async fn remote_git_simple(
    manager: &SshManager,
    path: &str,
    args: Vec<String>,
) -> Result<String, String> {
    let output = remote_git_command(manager, path, args, true).await?;
    if output.exit_code == 0 {
        let summary = if output.stdout.trim().is_empty() {
            output.stderr.trim()
        } else {
            output.stdout.trim()
        };
        Ok(summary.to_string())
    } else {
        Err(output.stderr.trim().to_string())
    }
}

#[tauri::command]
pub async fn ssh_git_push(path: String, manager: State<'_, SshManager>) -> Result<String, String> {
    remote_git_simple(&manager, &path, vec!["push".to_string()]).await
}

#[tauri::command]
pub async fn ssh_git_fetch(path: String, manager: State<'_, SshManager>) -> Result<String, String> {
    remote_git_simple(
        &manager,
        &path,
        vec!["fetch".to_string(), "--prune".to_string()],
    )
    .await
}

#[tauri::command]
pub async fn ssh_git_pull(
    path: String,
    rebase: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitPullResult, String> {
    let mut args = vec!["pull".to_string()];
    if rebase.unwrap_or(false) {
        args.push("--rebase".to_string());
    }
    let summary = remote_git_simple(&manager, &path, args).await?;
    let status = ssh_git_status(path.clone(), manager).await?;
    let conflict_paths = status
        .changes
        .iter()
        .filter(|change| {
            matches!(
                change.status.as_str(),
                "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD"
            )
        })
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    Ok(RemoteGitPullResult {
        summary,
        has_conflicts: !conflict_paths.is_empty(),
        conflict_paths,
    })
}

fn validate_commit_rev(rev: &str) -> Result<&str, String> {
    let rev = rev.trim();
    if rev.is_empty() || rev.len() > 64 || !rev.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("无效的提交哈希".to_string());
    }
    Ok(rev)
}

fn validate_branch_name(branch: &str) -> Result<&str, String> {
    let branch = branch.trim();
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.starts_with("refs/")
        || branch.starts_with("remotes/")
        || branch.contains("..")
        || branch.contains(['\\', '\0', ' '])
    {
        return Err("无效的分支名".to_string());
    }
    Ok(branch)
}

#[tauri::command]
pub async fn ssh_git_log(
    path: String,
    limit: Option<u32>,
    skip: Option<u32>,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitCommitInfo>, String> {
    let limit = limit.unwrap_or(40).clamp(1, 100) as usize;
    let skip = skip.unwrap_or(0).min(100_000) as usize;
    let fetch = limit.saturating_add(skip).min(100_000);
    let output = remote_git_command(
        &manager,
        &path,
        vec![
            "log".to_string(),
            format!("-n{fetch}"),
            "--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%D".to_string(),
        ],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        let error = output.stderr.to_ascii_lowercase();
        if error.contains("does not have any commits")
            || error.contains("bad revision")
            || error.contains("unknown revision")
            || error.contains("尚无任何提交")
        {
            return Ok(Vec::new());
        }
        return Err(format!("读取远程提交记录失败：{}", output.stderr.trim()));
    }
    let commits = output
        .stdout
        .lines()
        .filter_map(|line| {
            let parts = line.split('\0').collect::<Vec<_>>();
            (parts.len() >= 5).then(|| RemoteGitCommitInfo {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                subject: parts[2].to_string(),
                author: parts[3].to_string(),
                date: parts[4].trim().to_string(),
                refs: parts.get(5).map_or("", |value| value.trim()).to_string(),
            })
        })
        .skip(skip)
        .take(limit)
        .collect();
    Ok(commits)
}

#[tauri::command]
pub async fn ssh_git_branch_list(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitBranchList, String> {
    let local_output = remote_git_command(
        &manager,
        &path,
        vec![
            "for-each-ref".to_string(),
            "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)".to_string(),
            "refs/heads".to_string(),
        ],
        false,
    )
    .await?;
    if local_output.exit_code != 0 {
        return Err(format!("读取本地分支失败：{}", local_output.stderr.trim()));
    }
    let local = local_output
        .stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let current = parts.next().unwrap_or_default() == "*";
            let upstream = parts.next().unwrap_or_default().trim();
            Some(RemoteGitBranchInfo {
                name: name.to_string(),
                current,
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            })
        })
        .collect();
    let remote_output = remote_git_command(
        &manager,
        &path,
        vec![
            "for-each-ref".to_string(),
            "--format=%(refname:short)".to_string(),
            "refs/remotes".to_string(),
        ],
        false,
    )
    .await?;
    // 与本地实现一致：远程跟踪分支读取失败时按无远程分支处理。
    let remote_stdout = if remote_output.exit_code == 0 {
        remote_output.stdout.as_str()
    } else {
        ""
    };
    let remote = remote_stdout
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.ends_with("/HEAD"))
        .map(str::to_string)
        .collect();
    Ok(RemoteGitBranchList { local, remote })
}

#[tauri::command]
pub async fn ssh_git_remotes(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitRemote>, String> {
    let output = remote_git_command(
        &manager,
        &path,
        vec!["remote".to_string(), "-v".to_string()],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(format!("读取远程地址失败：{}", output.stderr.trim()));
    }
    let mut order = Vec::new();
    let mut remotes: HashMap<String, RemoteGitRemote> = HashMap::new();
    for line in output.stdout.lines() {
        let Some((name, rest)) = line.trim().split_once(['\t', ' ']) else {
            continue;
        };
        let rest = rest.trim();
        let (url, kind) = rest.rfind(" (").map_or((rest, ""), |index| {
            (rest[..index].trim(), rest[index..].trim())
        });
        if name.is_empty() || url.is_empty() {
            continue;
        }
        if !remotes.contains_key(name) {
            order.push(name.to_string());
            remotes.insert(
                name.to_string(),
                RemoteGitRemote {
                    name: name.to_string(),
                    fetch_url: None,
                    push_urls: Vec::new(),
                },
            );
        }
        let remote = remotes.get_mut(name).expect("remote inserted");
        if kind.contains("fetch") {
            remote.fetch_url = Some(url.to_string());
        } else if kind.contains("push") && !remote.push_urls.iter().any(|item| item == url) {
            remote.push_urls.push(url.to_string());
        }
    }
    Ok(order
        .into_iter()
        .filter_map(|name| remotes.remove(&name))
        .collect())
}

#[tauri::command]
pub async fn ssh_git_switch(
    path: String,
    branch: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let branch = validate_branch_name(&branch)?.to_string();
    let remote_ref = format!("refs/remotes/{branch}");
    let local_ref = format!("refs/heads/{branch}");
    let remote = remote_git_command(
        &manager,
        &path,
        vec!["rev-parse".to_string(), "--verify".to_string(), remote_ref],
        true,
    )
    .await?;
    let local = remote_git_command(
        &manager,
        &path,
        vec!["rev-parse".to_string(), "--verify".to_string(), local_ref],
        true,
    )
    .await?;
    let args = if remote.exit_code == 0 && local.exit_code != 0 {
        vec!["switch".to_string(), "--track".to_string(), branch]
    } else {
        vec!["switch".to_string(), branch]
    };
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(format!("切换远程 Git 分支失败：{}", output.stderr.trim()))
    }
}

#[tauri::command]
pub async fn ssh_git_commit_files(
    path: String,
    rev: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitCommitFileChange>, String> {
    let rev = validate_commit_rev(&rev)?.to_string();
    let output = remote_git_command(
        &manager,
        &path,
        vec![
            "show".to_string(),
            "--name-status".to_string(),
            "--pretty=format:".to_string(),
            "--no-renames".to_string(),
            rev,
        ],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(format!("读取提交文件失败：{}", output.stderr.trim()));
    }
    Ok(output
        .stdout
        .lines()
        .filter_map(|line| {
            let (status, file) = line.split_once('\t')?;
            let status = status.chars().next()?.to_string();
            (!file.trim().is_empty()).then(|| RemoteGitCommitFileChange {
                status,
                path: file.trim().to_string(),
                previous_path: None,
            })
        })
        .collect())
}

async fn remote_git_show(
    manager: &SshManager,
    path: &str,
    revision: &str,
    file: &str,
) -> Result<String, String> {
    // `<rev>:<path>` 里的 path 是仓库根相对；项目根是子目录时要补回前缀，pathspec 则不用。
    let prefix = remote_git_prefix(manager, path).await;
    let spec = format!("{revision}:{prefix}{file}");
    let output = remote_git_command(
        manager,
        path,
        vec!["show".to_string(), "--textconv".to_string(), spec],
        false,
    )
    .await?;
    Ok(if output.exit_code == 0 {
        output.stdout
    } else {
        String::new()
    })
}

#[tauri::command]
pub async fn ssh_git_commit_file_contents(
    path: String,
    rev: String,
    file: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitFileContents, String> {
    let rev = validate_commit_rev(&rev)?.to_string();
    let file = remote_git_file(&path, &file)?;
    Ok(RemoteGitFileContents {
        original: remote_git_show(&manager, &path, &format!("{rev}^"), &file).await?,
        modified: remote_git_show(&manager, &path, &rev, &file).await?,
    })
}

#[tauri::command]
pub async fn ssh_git_file_contents(
    path: String,
    file: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitFileContents, String> {
    let file = remote_git_file(&path, &file)?;
    let file_uri = join_remote_uri(&path, &file);
    let modified = match manager.sftp_for_uri(&file_uri, false).await {
        Ok((sftp, parsed, root)) => {
            ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
            let metadata = sftp.metadata(parsed.path.clone()).await.ok();
            if metadata
                .as_ref()
                .is_some_and(|value| value.len() > MAX_DIFF_BYTES)
            {
                format!("… 文件过大，已跳过内容（最多 {MAX_DIFF_BYTES} bytes）\n")
            } else {
                match sftp.read(parsed.path).await {
                    Ok(bytes) => file_encoding::decode(&bytes, file_encoding::FileEncoding::Auto)
                        .unwrap_or_default(),
                    Err(_) => String::new(),
                }
            }
        }
        Err(_) => String::new(),
    };
    Ok(RemoteGitFileContents {
        original: remote_git_show(&manager, &path, "HEAD", &file).await?,
        modified,
    })
}

#[tauri::command]
pub async fn ssh_git_show_head_file(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Option<String>, String> {
    let root = manager.root_for_uri(&path, false)?;
    let file = remote_git_file(&root.uri, &path)?;
    let content = remote_git_show(&manager, &root.uri, "HEAD", &file).await?;
    Ok((!content.is_empty()).then_some(content))
}

#[tauri::command]
pub async fn ssh_git_discard(
    path: String,
    files: Vec<String>,
    staged: bool,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    for file in files {
        let file = remote_git_file(&path, &file)?;
        let status_output = remote_git_command(
            &manager,
            &path,
            vec![
                "status".to_string(),
                "--porcelain=v1".to_string(),
                "--".to_string(),
                file.clone(),
            ],
            true,
        )
        .await?;
        let status = status_output.stdout.get(..2).unwrap_or_default();
        let args = if status == "??" {
            vec![
                "clean".to_string(),
                "-f".to_string(),
                "--".to_string(),
                file,
            ]
        } else if staged && status.starts_with('A') {
            let unstage = remote_git_command(
                &manager,
                &path,
                vec![
                    "rm".to_string(),
                    "-f".to_string(),
                    "--cached".to_string(),
                    "--".to_string(),
                    file.clone(),
                ],
                true,
            )
            .await?;
            if unstage.exit_code != 0 {
                return Err(format!("丢弃远程 Git 更改失败：{}", unstage.stderr.trim()));
            }
            vec![
                "clean".to_string(),
                "-f".to_string(),
                "--".to_string(),
                file,
            ]
        } else if staged {
            vec![
                "restore".to_string(),
                "--source=HEAD".to_string(),
                "--staged".to_string(),
                "--worktree".to_string(),
                "--".to_string(),
                file,
            ]
        } else {
            vec![
                "restore".to_string(),
                "--worktree".to_string(),
                "--".to_string(),
                file,
            ]
        };
        let output = remote_git_command(&manager, &path, args, true).await?;
        if output.exit_code != 0 {
            return Err(format!("丢弃远程 Git 更改失败：{}", output.stderr.trim()));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_format_document(
    path: String,
    content: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let parsed = parse_remote_uri(&path)?;
    let root = manager.root_for_uri(&path, true)?;
    let extension = parsed
        .path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    let prettier = format!(
        "cd -- {} && if [ -x node_modules/.bin/prettier ]; then exec node_modules/.bin/prettier --stdin-filepath {}; elif command -v prettier >/dev/null 2>&1; then exec prettier --stdin-filepath {}; else echo '未找到 prettier（项目 node_modules 或远端 PATH）' >&2; exit 127; fi",
        shell_quote(&root.canonical_path),
        shell_quote(&parsed.path),
        shell_quote(&parsed.path)
    );
    let command = match extension.as_str() {
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" | "json" | "jsonc" | "json5"
        | "css" | "scss" | "less" | "html" | "htm" | "vue" | "svelte" | "md" | "markdown"
        | "mdx" | "yaml" | "yml" | "graphql" | "gql" | "astro" => prettier,
        "rs" => "command -v rustfmt >/dev/null 2>&1 && exec rustfmt --emit stdout || { echo '远端未安装 rustfmt' >&2; exit 127; }".to_string(),
        "go" => "command -v gofmt >/dev/null 2>&1 && exec gofmt || { echo '远端未安装 gofmt' >&2; exit 127; }".to_string(),
        "sh" | "bash" | "zsh" => "command -v shfmt >/dev/null 2>&1 && exec shfmt || { echo '远端未安装 shfmt' >&2; exit 127; }".to_string(),
        "py" | "pyi" => format!(
            "if command -v ruff >/dev/null 2>&1; then exec ruff format --stdin-filename {} -; elif command -v black >/dev/null 2>&1; then exec black --quiet -; else echo '远端未安装 ruff 或 black' >&2; exit 127; fi",
            shell_quote(&parsed.path)
        ),
        _ => return Err(format!("暂不支持格式化 .{extension} 远程文件")),
    };
    let output = manager
        .exec_uri_with_input(&path, &command, content.as_bytes(), true)
        .await?;
    if output.exit_code == 0 {
        Ok(output.stdout)
    } else {
        Err(format!("远程格式化失败：{}", output.stderr.trim()))
    }
}

#[allow(clippy::too_many_arguments)]
async fn spawn_ssh_terminal(
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
    let channel = manager
        .open_session_channel(&parsed.connection_id, "终端")
        .await?;
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
    let (mut reader, writer) = channel.split();
    let writer = Arc::new(writer);
    let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let alive = Arc::new(AtomicBool::new(true));
    {
        let mut terminals = manager
            .terminals
            .write()
            .map_err(|_| "SSH 终端状态不可用".to_string())?;
        if let Some(previous) = terminals.insert(
            id.clone(),
            Arc::new(RemoteTerminalSession {
                connection_id: parsed.connection_id.clone(),
                input: input_tx,
                writer: Arc::clone(&writer),
                alive: Arc::clone(&alive),
            }),
        ) {
            previous.alive.store(false, Ordering::Release);
        }
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
    let exit_alive = Arc::clone(&alive);
    tauri::async_runtime::spawn(async move {
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
                            let clean_data = &data[pos..];
                            let _ = app_clone.emit(
                                "terminal-data",
                                TerminalDataPayload {
                                    id: terminal_id.clone(),
                                    data: encode_terminal_data(clean_data),
                                },
                            );
                        }
                    } else {
                        let _ = app_clone.emit(
                            "terminal-data",
                            TerminalDataPayload {
                                id: terminal_id.clone(),
                                data: encode_terminal_data(&data),
                            },
                        );
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status,
                _ => {}
            }
        }
        if claim_terminal_exit(&exit_alive) {
            app_clone
                .state::<SshManager>()
                .forget_terminal(&terminal_id, &exit_alive);
            let _ = app_clone.emit(
                "terminal-exit",
                TerminalExitPayload {
                    id: terminal_id,
                    exit_code,
                    disconnected: !ended_by_remote,
                },
            );
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

#[tauri::command]
pub async fn ssh_create_terminal(
    id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    let parsed = parse_remote_uri(&cwd)?;
    let spec = ssh_interactive_terminal_command(&parsed.path, shell.as_deref())?;
    let mut result = spawn_ssh_terminal(
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
    result.resolved_shell = Some(spec.resolved_shell);
    result.fallback_from = spec.fallback_from;
    Ok(result)
}

fn remote_script_invocation(target: &str, env_prefix: &str) -> Result<String, String> {
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
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    let _ = shell;
    if matches!(shell_kind.as_str(), "ps1" | "bat") {
        return Err("SSH Linux 项目暂不支持 PowerShell 或 BAT 任务".to_string());
    }
    let parsed = parse_remote_uri(&cwd)?;
    reject_windows_remote_command(&parsed.path)?;
    let target = if target.starts_with(SSH_URI_PREFIX) {
        parse_remote_uri(&target)?.path
    } else {
        target
    };
    let mut env_prefix = String::new();
    for (key, value) in env {
        if key.is_empty()
            || !key.bytes().enumerate().all(|(index, byte)| {
                byte == b'_'
                    || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
            })
        {
            return Err(format!("无效的远程任务环境变量名：{key}"));
        }
        env_prefix.push_str(&format!("{key}={} ", shell_quote(&value)));
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
    let command = format!("cd -- {} && {invocation}", shell_quote(&parsed.path));
    spawn_ssh_terminal(id, cwd, cols, rows, app, &manager, command, None).await
}

#[tauri::command]
pub async fn ssh_write_terminal(
    id: String,
    data: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("单次终端输入不能超过 1MB，请分段粘贴".to_string());
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

#[tauri::command]
pub async fn ssh_resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
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
pub async fn ssh_kill_terminal(id: String, manager: State<'_, SshManager>) -> Result<(), String> {
    let session = manager
        .terminals
        .write()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .remove(&id);
    if let Some(session) = session {
        session.alive.store(false, Ordering::Release);
        session
            .writer
            .close()
            .await
            .map_err(|error| format!("关闭 SSH 终端失败：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn closed_flag_stream_marks_eof_but_not_data() {
        let (client, mut server) = tokio::io::duplex(64);
        let closed = Arc::new(AtomicBool::new(false));
        let mut stream = ClosedFlagStream {
            inner: client,
            closed: Arc::clone(&closed),
        };
        server.write_all(b"ok").await.unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(stream.read(&mut buf).await.unwrap(), 2);
        assert!(!closed.load(Ordering::Acquire));
        drop(server);
        assert_eq!(stream.read(&mut buf).await.unwrap(), 0);
        assert!(closed.load(Ordering::Acquire));
    }

    #[test]
    fn replaced_ssh_terminal_does_not_emit_exit() {
        let alive = AtomicBool::new(true);
        alive.store(false, Ordering::Release);
        assert!(!claim_terminal_exit(&alive));
    }

    #[test]
    fn current_ssh_terminal_exit_is_reported_once() {
        let alive = AtomicBool::new(true);
        assert!(claim_terminal_exit(&alive));
        assert!(!claim_terminal_exit(&alive));
    }

    #[test]
    fn parses_remote_uri_without_losing_case() {
        let uri = parse_remote_uri("ssh://abc/Home/User/Foo.ts").unwrap();
        assert_eq!(uri.connection_id, "abc");
        assert_eq!(uri.path, "/Home/User/Foo.ts");
    }

    #[test]
    fn rejects_parent_segments() {
        assert!(parse_remote_uri("ssh://abc/home/user/../secret").is_err());
    }

    #[test]
    fn remote_containment_has_path_boundary() {
        assert!(remote_uri_is_within(
            "ssh://abc/home/user/app/src",
            "ssh://abc/home/user/app"
        ));
        assert!(!remote_uri_is_within(
            "ssh://abc/home/user/application",
            "ssh://abc/home/user/app"
        ));
    }

    #[test]
    fn extracts_connection_id_from_root_uri() {
        assert_eq!(remote_uri_connection_id("ssh://abc"), Some("abc"));
        assert_eq!(remote_uri_connection_id("ssh://abc/"), Some("abc"));
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn remote_writes_create_and_truncate_destination_files() {
        let replace = remote_write_flags(false);
        assert!(replace.contains(OpenFlags::CREATE));
        assert!(replace.contains(OpenFlags::TRUNCATE));
        assert!(replace.contains(OpenFlags::WRITE));
        assert!(!replace.contains(OpenFlags::EXCLUDE));

        let create_new = remote_write_flags(true);
        assert!(create_new.contains(OpenFlags::EXCLUDE));
    }

    #[test]
    fn remote_scripts_use_an_interpreter_matching_the_extension() {
        let python = remote_script_invocation("scripts/dev.py", "PORT='3000' ").unwrap();
        assert!(python.contains("PORT='3000' exec python3 'scripts/dev.py'"));

        let typescript = remote_script_invocation("scripts/dev.ts", "").unwrap();
        assert!(typescript.contains("node_modules/.bin/tsx 'scripts/dev.ts'"));

        assert_eq!(
            remote_script_invocation("scripts/dev.sh", "MODE='test' ").unwrap(),
            "MODE='test' exec /bin/sh 'scripts/dev.sh'"
        );
    }

    #[test]
    fn remote_scripts_reject_windows_script_types() {
        assert!(remote_script_invocation("scripts/dev.ps1", "").is_err());
        assert!(remote_script_invocation("scripts/dev.bat", "").is_err());
    }

    #[test]
    fn simple_globs_cover_extensions_and_nested_directories() {
        assert!(simple_glob_matches("*.map", "dist/app.js.map"));
        assert!(simple_glob_matches(
            "**/node_modules/**",
            "packages/app/node_modules/lib/index.js"
        ));
        assert!(!simple_glob_matches("*.map", "src/app.ts"));
    }

    #[test]
    fn git_inputs_reject_command_like_values() {
        assert!(validate_commit_rev("abc123").is_ok());
        assert!(validate_commit_rev("HEAD; rm -rf /").is_err());
        assert!(validate_branch_name("feature/ssh").is_ok());
        assert!(validate_branch_name("--exec=evil").is_err());
        assert!(validate_branch_name("refs/heads/main").is_err());
    }

    fn sample_config(private_key_path: Option<&str>) -> SshConnectionConfig {
        SshConnectionConfig {
            id: "test".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_kind: "privateKey".to_string(),
            password: None,
            private_key_path: private_key_path.map(str::to_string),
            passphrase: None,
            host_key_fingerprint: None,
        }
    }

    #[test]
    fn default_key_candidates_prefer_ed25519() {
        let home = PathBuf::from("home").join("owner");
        let keys = default_private_key_candidates(&home);
        assert_eq!(keys[0], home.join(".ssh").join("id_ed25519"));
        assert!(keys.iter().any(|path| path.ends_with("id_rsa")));
    }

    #[test]
    fn explicit_private_key_wins_over_defaults() {
        let config = sample_config(Some("D:/keys/wsl"));
        assert_eq!(
            resolve_private_key_paths(&config).unwrap(),
            vec![PathBuf::from("D:/keys/wsl")]
        );
    }

    #[test]
    fn blank_private_key_falls_back_to_defaults() {
        let config = sample_config(Some("   "));
        assert!(explicit_private_key_path(&config).is_none());
    }

    #[test]
    fn empty_manager_has_no_existing_session() {
        let manager = SshManager::new();
        assert!(existing_session(&manager, "missing").is_none());
    }

    #[test]
    fn connected_root_trust_can_be_updated_without_reconnecting() {
        let manager = SshManager::new();
        manager.roots.write().unwrap().insert(
            "test".to_string(),
            RegisteredRoot {
                uri: "ssh://test/home/owner/app".to_string(),
                canonical_path: "/home/owner/app".to_string(),
                trusted: false,
            },
        );

        manager
            .set_root_trust("ssh://test/home/owner/app/", true)
            .unwrap();

        assert!(manager.roots.read().unwrap().get("test").unwrap().trusted);
    }

    #[test]
    fn same_connection_keeps_distinct_same_named_roots_registered() {
        let manager = SshManager::new();
        for (key, uri, canonical_path) in [
            ("team-app", "ssh://wsl/home/team/app", "/home/team/app"),
            ("work-app", "ssh://wsl/work/other/app", "/work/other/app"),
        ] {
            manager.roots.write().unwrap().insert(
                key.to_string(),
                RegisteredRoot {
                    uri: uri.to_string(),
                    canonical_path: canonical_path.to_string(),
                    trusted: true,
                },
            );
        }

        assert!(manager
            .root_is_registered("ssh://wsl/home/team/app/")
            .unwrap());
        assert!(manager
            .root_is_registered("ssh://wsl/work/other/app")
            .unwrap());
        assert!(!manager
            .root_is_registered("ssh://wsl/home/team/other")
            .unwrap());
    }

    #[test]
    fn join_remote_path_from_root_and_child() {
        assert_eq!(join_remote_path("/", "root"), "/root");
        assert_eq!(join_remote_path("/root", "go"), "/root/go");
        assert_eq!(join_remote_path("/root/", ".claude"), "/root/.claude");
    }

    #[test]
    fn home_path_candidates_prefer_user_home() {
        assert_eq!(
            home_path_candidates("owner"),
            vec![
                "/home/owner".to_string(),
                "/C:/Users/owner".to_string(),
                "/root".to_string(),
                "/".to_string()
            ]
        );
        assert_eq!(
            home_path_candidates("root"),
            vec!["/root".to_string(), "/".to_string()]
        );
    }

    #[test]
    fn windows_drive_path_becomes_native_directory() {
        assert_eq!(
            windows_native_path("/D:/code/nem-panel").as_deref(),
            Some(r"D:\code\nem-panel")
        );
        assert_eq!(windows_native_path("/C:").as_deref(), Some(r"C:\"));
        assert!(windows_native_path("/home/owner/app").is_none());
    }

    const BASE64_ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /// 去掉可选的外层双引号和启动前缀，返回 base64 部分，并确认只含 base64 字符。
    fn encoded_part<'a>(command: &'a str, launcher: &str) -> &'a str {
        let inner = command
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(command);
        let encoded = inner
            .strip_prefix(launcher)
            .and_then(|rest| rest.strip_prefix(" -EncodedCommand "))
            .unwrap();
        assert!(encoded
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=')));
        encoded
    }

    /// 把 base64(UTF-16LE) 还原成脚本文本，便于断言实际执行的内容。
    fn decoded_script(command: &str, launcher: &str) -> String {
        let mut bits = 0u32;
        let mut width = 0;
        let mut bytes = Vec::new();
        for ch in encoded_part(command, launcher)
            .bytes()
            .filter(|&ch| ch != b'=')
        {
            let value = BASE64_ALPHABET.iter().position(|&c| c == ch).unwrap() as u32;
            bits = (bits << 6) | value;
            width += 6;
            if width >= 8 {
                width -= 8;
                bytes.push((bits >> width) as u8);
                bits &= (1 << width) - 1;
            }
        }
        let utf16 = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&utf16).unwrap()
    }

    #[test]
    fn windows_terminal_starts_powershell_in_project() {
        let quoted = ssh_interactive_terminal_command("/D:/code/it's", Some("powershell")).unwrap();
        assert_eq!(
            decoded_script(&quoted.command, "powershell.exe -NoLogo -NoExit"),
            r"Set-Location -LiteralPath 'D:\code\it''s'"
        );
        assert!(quoted.command.starts_with('"') && quoted.command.ends_with('"'));
        assert!(quoted.enter_directory.is_none());

        let command = ssh_interactive_terminal_command("/D:/code/nem-panel", None).unwrap();
        assert_eq!(
            decoded_script(&command.command, "powershell.exe -NoLogo -NoExit"),
            "Set-Location -LiteralPath 'D:\\code\\nem-panel'",
        );
        assert!(command.enter_directory.is_none());
        assert_eq!(command.resolved_shell, "powershell");
        assert_eq!(command.fallback_from, None);

        let cmd_launcher = "powershell.exe -NoLogo -NoProfile -NonInteractive";
        let cmd_target =
            ssh_interactive_terminal_command("/D:/code/my project", Some("cmd")).unwrap();
        assert_eq!(
            decoded_script(&cmd_target.command, cmd_launcher),
            r"$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath 'D:\code\my project'; & cmd.exe /K rem; exit $LASTEXITCODE"
        );
        assert!(cmd_target.enter_directory.is_none());
        assert_eq!(cmd_target.resolved_shell, "cmd");
        assert_eq!(cmd_target.fallback_from, None);
        let cmd_percent = ssh_interactive_terminal_command("/D:/100%done", Some("cmd")).unwrap();
        assert!(decoded_script(&cmd_percent.command, cmd_launcher).contains(r"'D:\100%done'"));
        let cmd_root = ssh_interactive_terminal_command("/C:", Some("cmd")).unwrap();
        assert!(decoded_script(&cmd_root.command, cmd_launcher).contains("'C:\\'"));

        let pwsh_target =
            ssh_interactive_terminal_command("/D:/code/nem-panel", Some("pwsh")).unwrap();
        assert_eq!(
            decoded_script(&pwsh_target.command, "pwsh.exe -NoLogo -NoExit"),
            "Set-Location -LiteralPath 'D:\\code\\nem-panel'",
        );
        assert!(pwsh_target.enter_directory.is_none());
        assert_eq!(pwsh_target.resolved_shell, "pwsh");

        let fallback =
            ssh_interactive_terminal_command("/D:/code/nem-panel", Some("bash")).unwrap();
        assert_eq!(
            decoded_script(&fallback.command, "powershell.exe -NoLogo -NoExit"),
            "Set-Location -LiteralPath 'D:\\code\\nem-panel'",
        );
        assert!(fallback.enter_directory.is_none());
        assert_eq!(fallback.resolved_shell, "powershell");
        assert_eq!(fallback.fallback_from, Some("bash".to_string()));

        assert!(ssh_interactive_terminal_command("/D:/code/a\nb", None).is_err());
        assert!(reject_windows_remote_command("/D:/code/nem-panel").is_err());
    }

    #[test]
    fn ssh_client_waits_through_a_slow_keepalive_reply() {
        let config = ssh_client_config();
        assert!(config.inactivity_timeout.is_none());
        assert_eq!(config.keepalive_interval, Some(Duration::from_secs(15)));
        assert_eq!(config.keepalive_max, 4);
        assert!(config.nodelay);
    }

    #[test]
    fn closed_connection_errors_are_stale() {
        // 在已关闭的连接上开通道实际得到的是这两种错误。
        assert!(is_stale_russh_error(&russh::Error::SendError));
        assert!(is_stale_russh_error(&russh::Error::Disconnect));
        assert!(is_stale_russh_error(&russh::Error::HUP));
        assert!(is_stale_russh_error(&russh::Error::KeepaliveTimeout));
        assert!(is_stale_russh_error(&russh::Error::ChannelOpenFailure(
            russh::ChannelOpenFailure::ConnectFailed
        )));
        assert!(!is_stale_russh_error(&russh::Error::ChannelOpenFailure(
            russh::ChannelOpenFailure::AdministrativelyProhibited
        )));
        assert!(!is_stale_russh_error(&russh::Error::WrongChannel));
    }

    #[test]
    fn terminal_end_messages_distinguish_exit_from_disconnect() {
        assert!(is_terminal_end_message(&ChannelMsg::ExitStatus {
            exit_status: 0
        }));
        assert!(is_terminal_end_message(&ChannelMsg::Close));
        assert!(!is_terminal_end_message(&ChannelMsg::Eof));
    }

    #[test]
    fn windows_quote_arg_follows_msvcrt_rules() {
        assert_eq!(windows_quote_arg("status"), "status");
        assert_eq!(windows_quote_arg(""), "\"\"");
        assert_eq!(windows_quote_arg(r"D:\my code"), "\"D:\\my code\"");
        assert_eq!(windows_quote_arg(r"D:\my code\"), "\"D:\\my code\\\\\"");
        assert_eq!(windows_quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(windows_quote_arg(r#"a\"b"#), "\"a\\\\\\\"b\"");
        assert_eq!(windows_quote_arg("--format=%H%x00%s"), "--format=%H%x00%s");
    }

    #[test]
    fn windows_powershell_command_is_shell_neutral() {
        let command = windows_powershell_stdin_command();
        assert!(!command.starts_with('"'));
        encoded_part(&command, WINDOWS_POWERSHELL_EXEC);
    }

    #[test]
    fn windows_git_runs_inline_without_reading_stdin() {
        let script = windows_git_script(r"D:\code\app", &["status".to_string()]).unwrap();
        let command = windows_powershell_inline_command(&script).unwrap();
        assert_eq!(decoded_script(&command, WINDOWS_POWERSHELL_EXEC), script);
        assert!(
            !command.starts_with('"'),
            "exec git must stay an unquoted bash -c script"
        );
        assert!(command.len() <= WINDOWS_INLINE_COMMAND_LIMIT);

        let long_message = "x".repeat(WINDOWS_INLINE_COMMAND_LIMIT);
        let long = windows_git_script(
            r"D:\code\app",
            &["commit".to_string(), "-m".to_string(), long_message],
        )
        .unwrap();
        assert!(windows_powershell_inline_command(&long).is_none());
    }

    #[test]
    fn parse_remote_git_status_keeps_branch_and_skips_rename_source() {
        let stdout =
            "## test...origin/test [ahead 1]\0 M src/a.ts\0?? new.txt\0R  new.rs\0old.rs\0";
        let parsed = parse_remote_git_status(stdout);
        assert_eq!(parsed.branch.as_deref(), Some("test"));
        assert_eq!(parsed.upstream.as_deref(), Some("origin/test"));
        assert_eq!(parsed.ahead, 1);
        assert_eq!(
            parsed.entries,
            vec![
                ("src/a.ts".to_string(), " M".to_string()),
                ("new.txt".to_string(), "??".to_string()),
                ("new.rs".to_string(), "R ".to_string()),
            ]
        );
    }

    #[test]
    fn parse_remote_git_status_drops_editor_artifacts() {
        let stdout = concat!(
            "## main\0",
            " M src/a.ts\0",
            "?? .qingcode/terminal-paste/stamp/paste-1.png\0",
            "?? .qingcode-transfer-abcd.tmp\0",
            "?? .qingcode/run.json\0",
        );
        let parsed = parse_remote_git_status(stdout);
        assert_eq!(
            parsed.entries,
            vec![
                ("src/a.ts".to_string(), " M".to_string()),
                (".qingcode/run.json".to_string(), "??".to_string()),
            ]
        );
    }

    #[test]
    fn subdirectory_project_paths_are_rebased_onto_the_project_root() {
        // 项目是仓库子目录：porcelain 仍返回仓库根相对，按前缀裁掉后才对得上项目内的文件。
        let stdout = "## main\0 M apps/web/src/a.ts\0?? apps/web/new.txt\0";
        let parsed = parse_remote_git_status(stdout);
        let rebased: Vec<_> = parsed
            .entries
            .iter()
            .filter_map(|(path, _)| crate::git_status::strip_git_prefix(path, "apps/web/"))
            .collect();
        assert_eq!(rebased, vec!["src/a.ts".to_string(), "new.txt".to_string()]);
    }

    #[test]
    fn windows_git_script_quotes_arguments_for_powershell_and_git() {
        let script = windows_git_script(
            r"D:\my code\it's",
            &[
                "commit".to_string(),
                "-m".to_string(),
                "fix: \"a\" b".to_string(),
            ],
        )
        .unwrap();
        assert!(
            script.contains(r#"$psi.Arguments = '-C "D:\my code\it''s" commit -m "fix: \"a\" b"'"#)
        );
        assert!(script.contains("exit $process.ExitCode"));
        assert!(windows_git_script(r"D:\code", &["a\0b".to_string()]).is_err());
    }

    #[test]
    fn linux_terminal_still_uses_login_shell() {
        let default_target = ssh_interactive_terminal_command("/home/owner/app", None).unwrap();
        assert_eq!(
            default_target.command,
            "cd -- '/home/owner/app' && exec \"${SHELL:-/bin/sh}\" -l"
        );
        assert_eq!(default_target.resolved_shell, "auto");

        let bash_target =
            ssh_interactive_terminal_command("/home/owner/app", Some("bash")).unwrap();
        assert_eq!(
            bash_target.command,
            "cd -- '/home/owner/app' && exec bash -l"
        );
        assert_eq!(bash_target.resolved_shell, "bash");

        assert!(reject_windows_remote_command("/home/owner/app").is_ok());
    }
}
