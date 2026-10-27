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
#[cfg(test)]
mod live_acceptance;
mod search;
mod server;
mod server_status;
mod sshd_limits;
#[cfg(test)]
mod test_connection;
mod transfer;
mod windows_path_guard;
mod windows_sshd_repair;
pub use config_import::*;
pub use search::*;
pub use server_status::{SshServerLogs, SshServerState};
pub use transfer::*;
pub use windows_sshd_repair::*;

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
    /// 连接结束的原因（远端 DISCONNECT 或传输错误），供状态芯片展示和排查断线。
    disconnect_reason: Arc<Mutex<Option<String>>>,
    keepalive_window: Duration,
}

/// 把 russh 的断开原因转成用户可读文本。保活超时单独说明判定口径，
/// 便于区分「网络/远端无响应」与「远端主动断开」。
fn describe_disconnect(
    reason: &client::DisconnectReason<russh::Error>,
    keepalive_window: Duration,
) -> String {
    match reason {
        client::DisconnectReason::ReceivedDisconnect(info) => {
            let message = info.message.trim();
            if message.is_empty() {
                format!("远端主动断开（{:?}）", info.reason_code)
            } else {
                format!("远端主动断开（{:?}）：{message}", info.reason_code)
            }
        }
        client::DisconnectReason::Error(russh::Error::KeepaliveTimeout) => format!(
            "保活超时：约 {} 秒未收到远端任何回包（网络中断、远端休眠或 sshd 无响应）",
            keepalive_window.as_secs()
        ),
        client::DisconnectReason::Error(error) => format!("连接异常断开：{error}"),
    }
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

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        if let Ok(mut slot) = self.disconnect_reason.lock() {
            slot.get_or_insert_with(|| describe_disconnect(&reason, self.keepalive_window));
        }
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(error) => Err(error),
        }
    }
}

struct ConnectedSession {
    /// Distinguishes authenticated SSH incarnations, including reconnects.
    server_incarnation: Arc<()>,
    handle: client::Handle<SshClient>,
    config: Mutex<SshConnectionConfig>,
    /// 整条连接共用一个 SFTP 会话，请求在其中多路复用。每次操作都新开通道时，
    /// Windows OpenSSH 要为每次请求启动一个 sftp-server 进程，远端一卡就超时。
    sftp: tokio::sync::Mutex<Option<CachedSftp>>,
    /// 与 [`SshClient::disconnect_reason`] 共享：传输结束后记录原因。
    disconnect_reason: Arc<Mutex<Option<String>>>,
}

impl ConnectedSession {
    /// 连接已关闭时的断开原因；仍在线或原因未知返回 `None`。
    fn closed_reason(&self) -> Option<String> {
        if !self.handle.is_closed() {
            return None;
        }
        self.disconnect_reason
            .lock()
            .ok()
            .and_then(|reason| reason.clone())
    }
}

struct CachedSftp {
    sftp: Arc<SftpSession>,
    health: Arc<SftpHealth>,
}

/// Keep Windows physical-path metadata on the same authenticated connection.
/// The weak reference avoids a cycle through ConnectedSession's SFTP cache.
struct SftpSession {
    inner: RawSftpSession,
    transport: std::sync::Weak<ConnectedSession>,
    windows_guard: windows_path_guard::WindowsPathGuard,
}

impl std::ops::Deref for SftpSession {
    type Target = RawSftpSession;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

/// 缓存 SFTP 会话的健康状态，由通道流在读写时更新。
struct SftpHealth {
    closed: AtomicBool,
    started: Instant,
    /// 上次读到回包之后第一条请求写出的时间（相对 `started` 的毫秒数 + 1）；0 表示没有未答请求。
    unanswered_since_ms: AtomicU64,
}

impl SftpHealth {
    fn new() -> Self {
        Self {
            closed: AtomicBool::new(false),
            started: Instant::now(),
            unanswered_since_ms: AtomicU64::new(0),
        }
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis())
            .unwrap_or(u64::MAX)
            .saturating_add(1)
    }

    fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
    }

    fn note_write(&self) {
        let _ = self.unanswered_since_ms.compare_exchange(
            0,
            self.now_ms(),
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    fn note_read(&self) {
        self.unanswered_since_ms.store(0, Ordering::Release);
    }

    /// 已关闭，或请求写出后 `stall` 内一直没有任何回包：通道多半已僵死，不再复用。
    fn is_unusable(&self, stall: Duration) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return true;
        }
        let since = self.unanswered_since_ms.load(Ordering::Acquire);
        let stall_ms = u64::try_from(stall.as_millis()).unwrap_or(u64::MAX);
        since != 0 && self.now_ms().saturating_sub(since) >= stall_ms
    }
}

/// 包住 SFTP 通道流：读到 EOF 或读写出错时标记关闭，并记录请求 / 回包时间用于判断僵死。
struct ClosedFlagStream<S> {
    inner: S,
    health: Arc<SftpHealth>,
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
            self.health.mark_closed();
        } else if matches!(result, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.health.note_read();
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
        match &result {
            Poll::Ready(Err(_)) => self.health.mark_closed(),
            Poll::Ready(Ok(written)) if *written > 0 => self.health.note_write(),
            _ => {}
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.health.mark_closed();
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
/// 远端拒绝开通道（多为 MaxSessions 打满）时错误信息里的固定片段。
const CHANNEL_REFUSED_MARKER: &str = "远端拒绝打开新通道";

fn is_channel_refused_error(message: &str) -> bool {
    message.contains(CHANNEL_REFUSED_MARKER)
}
/// OpenSSH Linux 会以 AdministrativelyProhibited 表示 MaxSessions 打满，
/// Windows 等实现也可能返回 ConnectFailed。两者都允许有限退避，不把
/// AdministrativelyProhibited 当成连接失效去重建整条主连接。
fn is_session_channel_refusal(error: &russh::Error) -> bool {
    matches!(
        error,
        russh::Error::ChannelOpenFailure(
            russh::ChannelOpenFailure::ConnectFailed
                | russh::ChannelOpenFailure::AdministrativelyProhibited
        )
    )
}

/// 远端拒绝开通道时的重试次数，共约 3 秒。
const CHANNEL_OPEN_RETRIES: u32 = 5;
/// sshd 默认每条连接最多 10 个会话；主连接预留 1 个 SFTP、Windows 的 1 个路径校验
/// 和最多 6 个命令/主连接回退终端，留余量给 watch / scan 与重试。超出的命令排队。
const MAX_CONCURRENT_EXEC_CHANNELS: usize = 6;
/// 终端各用独立连接；sshd 的 MaxStartups 默认 10:30:100，未认证连接到 10 个起会被随机拒绝，
/// 同时握手留在 6 个以内，给其它客户端留余量。
const MAX_CONCURRENT_TERMINAL_HANDSHAKES: usize = 6;
/// 读取远端 sshd_config 的时限；超时按 OpenSSH 默认值处理，不阻塞新建终端太久。
const SSHD_LIMITS_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 普通远程命令（status、diff、show…）的整体时限；挂住的命令会一直占着并发名额。
const REMOTE_EXEC_TIMEOUT: Duration = Duration::from_secs(120);
/// 走网络的 Git 命令（fetch / pull / push / clone）可能很慢，单独放宽。
const REMOTE_NETWORK_EXEC_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 共用 SFTP 会话上的请求超过这么久没有任何回包就视为僵死，下次换新会话（单次请求超时 30 秒）。
const SFTP_STALL_TIMEOUT: Duration = Duration::from_secs(45);
/// 主动探测的等待上限；连接只是慢时不应拆掉它（会杀掉所有远端终端）。
/// 远端 CPU/内存占满时几秒不回包很常见，给足时间再判失效。
const SSH_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// 重连失败后的冷却期：并发的终端恢复直接复用这次失败，不排队逐个重试握手。
const SSH_RECONNECT_FAILURE_COOLDOWN: Duration = Duration::from_secs(3);
/// 主连接承载 SFTP、命令和 watch，取 10 秒 × 4 个周期（约 40 秒）兼顾恢复速度。
const SSH_MAIN_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// russh 在首次保活后再等待 3 个周期，合计 4 个周期（约 40 秒）。
const SSH_MAIN_KEEPALIVE_MAX: usize = 3;
const SSH_MAIN_KEEPALIVE_WINDOW: Duration = Duration::from_secs(40);
/// 终端独占连接里的 TUI 可能在远端忙时长时间不响应，改回 15 秒 × 5 个周期（约 75 秒）。
const SSH_TERMINAL_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// russh 在首次保活后再等待 4 个周期，合计 5 个周期（约 75 秒）。
const SSH_TERMINAL_KEEPALIVE_MAX: usize = 4;
const SSH_TERMINAL_KEEPALIVE_WINDOW: Duration = Duration::from_secs(75);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionPurpose {
    Main,
    Terminal,
}

fn ssh_client_config(purpose: ConnectionPurpose) -> client::Config {
    let (keepalive_interval, keepalive_max) = match purpose {
        ConnectionPurpose::Main => (Some(SSH_MAIN_KEEPALIVE_INTERVAL), SSH_MAIN_KEEPALIVE_MAX),
        ConnectionPurpose::Terminal => (
            Some(SSH_TERMINAL_KEEPALIVE_INTERVAL),
            SSH_TERMINAL_KEEPALIVE_MAX,
        ),
    };

    client::Config {
        // russh 只在收到回包时重置空闲计时器，发出保活本身不算；Windows OpenSSH
        // 在 ConPTY 忙时回包很慢，空闲超时会误断。改为只以保活失败作为断开信号。
        inactivity_timeout: None,
        keepalive_interval,
        keepalive_max,
        nodelay: true,
        ..Default::default()
    }
}

fn keepalive_window(purpose: ConnectionPurpose) -> Duration {
    match purpose {
        ConnectionPurpose::Main => SSH_MAIN_KEEPALIVE_WINDOW,
        ConnectionPurpose::Terminal => SSH_TERMINAL_KEEPALIVE_WINDOW,
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
            Err(error) if is_session_channel_refusal(&error) && retries < CHANNEL_OPEN_RETRIES => {
                // sshd 的会话数到上限（MaxSessions，默认 10）时会拒绝新通道；
                // 刚关闭的通道在卡顿的远端上要过一会儿才释放，退避久一点再试。
                retries += 1;
                tokio::time::sleep(Duration::from_millis(200 * u64::from(retries))).await;
            }
            Err(error) => {
                let detail = if is_session_channel_refusal(&error) && !session.handle.is_closed() {
                    format!("{CHANNEL_REFUSED_MARKER}，可能已达 sshd 的 MaxSessions 上限（默认 10，可在远端 sshd_config 调大 MaxSessions 后重启 sshd）")
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
    session: &Arc<ConnectedSession>,
) -> Result<Arc<SftpSession>, ChannelOpenError> {
    // 持锁新开：并发的首批请求只会开一个会话。
    let mut cached = session.sftp.lock().await;
    if let Some(entry) = cached.as_ref() {
        if !entry.health.is_unusable(SFTP_STALL_TIMEOUT) {
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
    let health = Arc::new(SftpHealth::new());
    let stream = ClosedFlagStream {
        inner: channel.into_stream(),
        health: Arc::clone(&health),
    };
    let sftp = RawSftpSession::new(stream)
        .await
        .map_err(|error| ChannelOpenError {
            message: format!("初始化 SFTP 失败：{error}"),
            stale: session.handle.is_closed(),
        })?;
    sftp.set_timeout(30);
    let sftp = Arc::new(SftpSession {
        inner: sftp,
        transport: Arc::downgrade(session),
        windows_guard: Default::default(),
    });
    *cached = Some(CachedSftp {
        sftp: Arc::clone(&sftp),
        health,
    });
    Ok(sftp)
}

/// 已注册的远程项目根。类型对 crate 内可见（server 集成在子模块里使用），
/// 字段仍是本模块私有。
#[derive(Clone, Debug)]
pub(crate) struct RegisteredRoot {
    uri: String,
    canonical_path: String,
    trusted: bool,
}

struct RemoteTerminalSession {
    connection_id: String,
    /// 终端独占的 SSH 连接；终端结束、被替换或关闭时一并断开。
    transport: Arc<ConnectedSession>,
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

/// 断开终端独占的连接；连接已关闭时忽略错误。
async fn close_terminal_transport(transport: &ConnectedSession) {
    let _ = transport
        .handle
        .disconnect(Disconnect::ByApplication, "QingCode terminal closed", "en")
        .await;
}

/// server 模式的持久终端共用 SSH 连接，每个终端占一个 daemon 通道。
///
/// 每条连接能开的通道数由远端 sshd 的 `MaxSessions` 决定（OpenSSH 默认 10）。容量取自
/// 远端 sshd_config；读不到时用默认值，实际被 sshd 拒绝时按当时已开的通道数修正。
/// 满了再开一条共享连接，终端总数不设上限（daemon 自身另有 PTY 上限）。
struct PooledTerminalTransport {
    transport: Arc<ConnectedSession>,
    /// 已租出的通道名额。
    leased: usize,
    /// 这条连接最多承载的终端数。
    capacity: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SshdSessionLimitSource {
    /// 远端 sshd_config 中的 `MaxSessions`。
    Config,
    /// 读不到配置时的 OpenSSH 默认值。
    Default,
    /// 共享连接上开通道被 sshd 拒绝时实测得到。
    Observed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SshdSessionLimit {
    max_sessions: usize,
    source: SshdSessionLimitSource,
}

impl SshdSessionLimit {
    /// MaxSessions 为 0/1 时无法复用连接，退化为每个终端一条连接。
    fn transport_capacity(self) -> usize {
        self.max_sessions.max(1)
    }

    fn describe(self) -> String {
        let source = match self.source {
            SshdSessionLimitSource::Config => "远端 sshd_config 的 MaxSessions",
            SshdSessionLimitSource::Default => "未读到 sshd_config，按 OpenSSH 默认 MaxSessions",
            SshdSessionLimitSource::Observed => "sshd 实际拒绝新通道时测得",
        };
        format!(
            "每条连接最多 {} 个终端，{source}",
            self.transport_capacity()
        )
    }
}

#[derive(Default)]
struct TerminalTransportPoolState {
    entries: Vec<PooledTerminalTransport>,
    /// 该连接的 sshd 会话上限；`None` 表示还没探测过。
    limit: Option<SshdSessionLimit>,
    /// 借用主连接通道的终端数（专用连接握手失败时的回退），受
    /// [`TERMINAL_MAIN_FALLBACK_LIMIT`] 限制。
    main_fallback: usize,
    /// 最近一次专用终端连接握手失败的时间与原因：冷却期内直接走主连接回退，
    /// 不再每开一个终端都白等握手超时（失败的握手还会让远端继续追加罚时）。
    handshake_failure: Option<(Instant, String)>,
}

/// 主连接上最多借给终端的 daemon 通道数：主连接还要承载 SFTP、命令与
/// scan/search/watch，sshd 的 MaxSessions（默认 10）不能都给终端。
const TERMINAL_MAIN_FALLBACK_LIMIT: usize = 4;
/// 专用终端连接握手失败后，多久内不再尝试新握手、直接回退主连接。
const TERMINAL_HANDSHAKE_FAILURE_COOLDOWN: Duration = Duration::from_secs(120);

/// 专用终端连接握手失败时附带的排查提示。
///
/// OpenSSH 9.8+（含 Windows 版 9.8p2）默认开启 PerSourcePenalties：连接异常结束、
/// 认证前断开等都会给来源 IP 记罚时，罚时内该 IP 的新连接一律被拒（远端回
/// `Not allowed at this time` 或握手无响应），已建立的连接不受影响。
const TERMINAL_HANDSHAKE_PENALTY_HINT: &str = "若远端为 OpenSSH 9.8 及以上（含 Windows 版），可能是 PerSourcePenalties 正对本机 IP 罚时拒绝新连接，可在远端 sshd_config 加入 PerSourcePenaltyExemptList <本机 IP> 或 PerSourcePenalties no 后重启 sshd";

/// 同一 SSH 连接配置下，server 模式终端共用的连接；锁同时串行化探测与新连接握手。
type TerminalTransportPool = Arc<tokio::sync::Mutex<TerminalTransportPoolState>>;

/// 第一条未满的共享连接；参数为各连接的（已租出, 容量）。
fn pick_terminal_transport(slots: impl IntoIterator<Item = (usize, usize)>) -> Option<usize> {
    slots
        .into_iter()
        .position(|(leased, capacity)| leased < capacity)
}

/// sshd 拒绝开新通道时，连接上已开的通道数就是它的实际上限。
///
/// `leased` 含本次被拒的租约；除它之外一个通道都没有时说明不是会话数打满，
/// 返回 `None`，不据此修正容量。
fn observed_capacity_after_refusal(leased: usize) -> Option<usize> {
    leased.checked_sub(1).filter(|open| *open > 0)
}

fn terminal_pool_full_notice(full: usize, limit: SshdSessionLimit) -> String {
    format!(
        "已有 {full} 条终端共享 SSH 连接均已占满（{}），已为新终端新开第 {} 条连接",
        limit.describe(),
        full + 1
    )
}

/// 共享终端连接上的一个 daemon 通道名额。
///
/// 归还最后一个名额时关闭这条空闲连接；`release` 可重复调用，Drop 时也会归还。
struct TerminalTransportLease {
    transport: Arc<ConnectedSession>,
    released: AtomicBool,
    pool: TerminalTransportPool,
    /// 借用的是主连接（专用连接握手失败时的回退）：归还时只减计数，绝不断开。
    main_fallback: bool,
    /// 回退终端与命令共用主连接预算；release 时立即归还，不必等租约对象析构。
    main_slot: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
    /// 已有共享连接全满、本次新开了连接时给用户的提示。
    notice: Option<String>,
}

impl std::ops::Deref for TerminalTransportLease {
    type Target = ConnectedSession;

    fn deref(&self) -> &ConnectedSession {
        &self.transport
    }
}

impl TerminalTransportLease {
    fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        drop(self.main_slot.lock().unwrap().take());
        let transport = Arc::clone(&self.transport);
        let pool = Arc::clone(&self.pool);
        let main_fallback = self.main_fallback;
        tauri::async_runtime::spawn(async move {
            // 名额只在池锁内增减，这里持锁判断空闲不会与新租约竞争。
            let mut state = pool.lock().await;
            if main_fallback {
                state.main_fallback = state.main_fallback.saturating_sub(1);
                return;
            }
            let Some(index) = state
                .entries
                .iter()
                .position(|entry| Arc::ptr_eq(&entry.transport, &transport))
            else {
                return;
            };
            let entry = &mut state.entries[index];
            entry.leased = entry.leased.saturating_sub(1);
            if entry.leased > 0 {
                return;
            }
            state.entries.remove(index);
            drop(state);
            close_terminal_transport(&transport).await;
        });
    }

    /// sshd 拒绝在这条连接上开新通道：把它标满，并按实测值修正该连接以后的容量。
    ///
    /// 返回 `true` 表示确实是会话数打满，调用方应换一条连接重试一次。
    async fn mark_refused(&self) -> bool {
        let mut state = self.pool.lock().await;
        let Some(entry) = state
            .entries
            .iter_mut()
            .find(|entry| Arc::ptr_eq(&entry.transport, &self.transport))
        else {
            return false;
        };
        let Some(observed) = observed_capacity_after_refusal(entry.leased) else {
            return false;
        };
        entry.capacity = observed;
        let lowered = state
            .limit
            .is_none_or(|limit| observed < limit.transport_capacity());
        if lowered {
            state.limit = Some(SshdSessionLimit {
                max_sessions: observed,
                source: SshdSessionLimitSource::Observed,
            });
        }
        true
    }
}

impl Drop for TerminalTransportLease {
    fn drop(&mut self) {
        self.release();
    }
}

/// 同一连接的重连串行执行；记住最近一次失败，冷却期内直接返回。
type ReconnectGate = Arc<tokio::sync::Mutex<Option<(Instant, String)>>>;

pub struct SshManager {
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
    pub fn new() -> Self {
        Self {
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

    /// 为终端新建一条独占连接，沿用主连接已确认的配置（含主机指纹）。
    ///
    /// 终端不与 SFTP / 远程命令共用主连接：sshd 每条连接的会话数有上限（MaxSessions，默认 10），
    /// 多个项目的终端挤在一条连接上很快就满；主连接卡死重连时也会把上面的终端一起断开。
    async fn open_terminal_transport(
        &self,
        connection_id: &str,
    ) -> Result<Arc<ConnectedSession>, String> {
        self.handshake_terminal_transport(connection_id).await.map_err(|error| {
            format!("{error}（每个终端单独占用一条 SSH 连接，终端很多时可在远端 sshd_config 调大 MaxStartups 后重启 sshd）")
        })
    }

    /// 为 server 模式终端租一个 daemon 通道名额：优先复用已有共享连接，
    /// 都满了（或已失效）才握手新建，避免每个终端都新开 SSH 连接导致握手超时。
    ///
    /// `root_uri` 只用于首次读取远端 sshd 的 MaxSessions。
    async fn lease_daemon_terminal_transport(
        &self,
        connection_id: &str,
        root_uri: &str,
    ) -> Result<TerminalTransportLease, String> {
        let pool = {
            let mut pools = self
                .terminal_transport_pools
                .lock()
                .map_err(|_| "SSH 连接状态不可用".to_string())?;
            Arc::clone(pools.entry(connection_id.to_string()).or_default())
        };
        let mut state = pool.lock().await;
        let limit = match state.limit {
            Some(limit) => limit,
            None => {
                let limit = self.probe_sshd_session_limit(root_uri).await;
                state.limit = Some(limit);
                limit
            }
        };
        // 半死的连接上开通道会一直卡到超时；只对将要复用的连接探测一次，失效就换掉。
        // 它上面其它终端的 daemon 会话会各自重连，进程不受影响。
        while let Some(index) = pick_terminal_transport(
            state
                .entries
                .iter()
                .map(|entry| (entry.leased, entry.capacity)),
        ) {
            if !connection_responds(&state.entries[index].transport.handle).await {
                let stale = state.entries.remove(index);
                close_terminal_transport(&stale.transport).await;
                continue;
            }
            let entry = &mut state.entries[index];
            entry.leased += 1;
            return Ok(TerminalTransportLease {
                transport: Arc::clone(&entry.transport),
                released: AtomicBool::new(false),
                pool: Arc::clone(&pool),
                main_fallback: false,
                main_slot: Mutex::new(None),
                notice: None,
            });
        }
        let full = state.entries.len();
        // 刚失败过的握手在冷却期内不再重试：直接回退主连接，避免每个终端都等满
        // 握手超时，也避免失败握手让远端 sshd 继续给本机 IP 追加罚时。
        let cooling = state
            .handshake_failure
            .as_ref()
            .filter(|(at, _)| at.elapsed() < TERMINAL_HANDSHAKE_FAILURE_COOLDOWN)
            .map(|(_, error)| error.clone());
        let fresh_failure = cooling.is_none();
        let handshake = match cooling {
            Some(error) => Err(error),
            None => self.handshake_terminal_transport(connection_id).await,
        };
        let transport = match handshake {
            Ok(transport) => {
                state.handshake_failure = None;
                transport
            }
            Err(error) => {
                if fresh_failure {
                    eprintln!(
                        "[WARN] terminal transport handshake failed for {connection_id}: {error}"
                    );
                    state.handshake_failure = Some((Instant::now(), error.clone()));
                }
                if let Some(lease) = self
                    .lease_main_fallback(connection_id, &pool, &mut state, &error, fresh_failure)
                    .await
                {
                    return Ok(lease);
                }
                return Err(if full == 0 {
                    format!("{error}（终端共享 SSH 连接握手失败，可检查远端 sshd 状态与 MaxStartups；{TERMINAL_HANDSHAKE_PENALTY_HINT}）")
                } else {
                    format!(
                        "{error}（已有 {full} 条终端共享连接均已占满，{}；可在远端 sshd_config 调大 MaxSessions 后重启 sshd）",
                        limit.describe()
                    )
                });
            }
        };
        state.entries.push(PooledTerminalTransport {
            transport: Arc::clone(&transport),
            leased: 1,
            capacity: limit.transport_capacity(),
        });
        Ok(TerminalTransportLease {
            transport,
            released: AtomicBool::new(false),
            pool: Arc::clone(&pool),
            main_fallback: false,
            main_slot: Mutex::new(None),
            notice: (full > 0).then(|| terminal_pool_full_notice(full, limit)),
        })
    }

    /// 专用终端连接握手失败时，向已认证的主连接借一个 daemon 通道。
    ///
    /// 只用现有主连接、不触发重连（重连同样要新握手）；主连接无响应或借用数已达
    /// [`TERMINAL_MAIN_FALLBACK_LIMIT`] 时返回 `None`，由调用方按原错误报错。
    /// `announce` 为真时附带提示（只在刚失败那一次提示，冷却期内静默借用）。
    async fn lease_main_fallback(
        &self,
        connection_id: &str,
        pool: &TerminalTransportPool,
        state: &mut TerminalTransportPoolState,
        error: &str,
        announce: bool,
    ) -> Option<TerminalTransportLease> {
        if state.main_fallback >= TERMINAL_MAIN_FALLBACK_LIMIT {
            return None;
        }
        let main = self.session(connection_id).ok()?;
        if !connection_responds(&main.handle).await {
            return None;
        }
        let slot = self.try_main_fallback_slot(connection_id)?;
        state.main_fallback += 1;
        Some(TerminalTransportLease {
            transport: main,
            released: AtomicBool::new(false),
            pool: Arc::clone(pool),
            main_fallback: true,
            main_slot: Mutex::new(Some(slot)),
            notice: announce.then(|| {
                format!(
                    "终端专用 SSH 连接握手失败（{error}），已改用主连接承载终端（最多 {TERMINAL_MAIN_FALLBACK_LIMIT} 个）；{TERMINAL_HANDSHAKE_PENALTY_HINT}"
                )
            }),
        })
    }

    /// 读取远端 sshd 的 MaxSessions；读不到、超时或无法解析时按 OpenSSH 默认值。
    async fn probe_sshd_session_limit(&self, root_uri: &str) -> SshdSessionLimit {
        let fallback = SshdSessionLimit {
            max_sessions: sshd_limits::OPENSSH_DEFAULT_MAX_SESSIONS,
            source: SshdSessionLimitSource::Default,
        };
        // 开通道本身在主连接卡顿时也可能等很久，时限要覆盖整个探测。
        let probed = tokio::time::timeout(
            SSHD_LIMITS_PROBE_TIMEOUT,
            self.exec_remote_shell(
                root_uri,
                sshd_limits::SSHD_CONFIG_UNIX_COMMAND,
                sshd_limits::SSHD_CONFIG_WINDOWS_SCRIPT,
                true,
                SSHD_LIMITS_PROBE_TIMEOUT,
            ),
        )
        .await
        .unwrap_or_else(|_| Err("读取 sshd_config 超时".to_string()));
        match probed {
            Ok(result) => sshd_limits::parse_sshd_max_sessions(&result.stdout).map_or(
                fallback,
                |max_sessions| SshdSessionLimit {
                    max_sessions,
                    source: SshdSessionLimitSource::Config,
                },
            ),
            Err(error) => {
                eprintln!("[WARN] reading remote sshd MaxSessions failed: {error}");
                fallback
            }
        }
    }

    async fn handshake_terminal_transport(
        &self,
        connection_id: &str,
    ) -> Result<Arc<ConnectedSession>, String> {
        let config = self
            .live_session(connection_id)
            .await?
            .config
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?
            .clone();
        let _handshake = self
            .terminal_handshakes
            .acquire()
            .await
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        let (transport, _) = authenticate_session(config, ConnectionPurpose::Terminal).await?;
        Ok(Arc::new(transport))
    }

    pub fn terminal_is_open(&self, id: &str) -> bool {
        let direct = self
            .terminals
            .read()
            .ok()
            .and_then(|terminals| {
                terminals
                    .get(id)
                    .map(|session| session.alive.load(Ordering::Acquire))
            })
            .unwrap_or(false);
        direct
            || self
                .persistent_terminals
                .read()
                .ok()
                .and_then(|terminals| terminals.get(id).map(|terminal| terminal.is_open()))
                .unwrap_or(false)
    }

    pub(crate) fn set_client_id(&self, client_id: String) {
        if let Ok(mut current) = self.client_id.write() {
            *current = client_id;
        }
    }

    pub(crate) fn daemon_client_id(&self, connection_id: &str) -> String {
        let installation = self
            .client_id
            .read()
            .map(|client_id| client_id.clone())
            .unwrap_or_else(|_| "unknown-install".to_string());
        format!("{installation}:{connection_id}")
    }

    async fn kill_persistent_terminals_where(
        &self,
        predicate: impl Fn(&server::PersistentTerminal) -> bool,
    ) {
        let terminals = self
            .persistent_terminals
            .read()
            .map(|terminals| {
                terminals
                    .values()
                    .filter(|terminal| predicate(terminal))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let handles = terminals
            .into_iter()
            .map(|terminal| {
                tauri::async_runtime::spawn(async move {
                    let _ = terminal.kill().await;
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            let _ = handle.await;
        }
    }

    async fn kill_persistent_terminals_for_connection(&self, connection_id: &str) {
        self.kill_persistent_terminals_where(|terminal| terminal.connection_id() == connection_id)
            .await;
    }

    async fn kill_persistent_terminals_for_root(&self, root_uri: &str) {
        let root_uri = normalize_remote_uri(root_uri);
        self.kill_persistent_terminals_where(|terminal| {
            normalize_remote_uri(terminal.root_uri()) == root_uri
        })
        .await;
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
        self.session(connection_id)
            .ok()
            .is_some_and(|session| !session.handle.is_closed())
    }

    /// 主连接已断开时记录的原因（保活超时、远端断开等）；在线或未知返回 `None`。
    pub(crate) fn connection_closed_reason(&self, connection_id: &str) -> Option<String> {
        self.session(connection_id)
            .ok()
            .and_then(|session| session.closed_reason())
    }

    /// 主连接已关闭时立即重连（复用已确认的配置与指纹）；仍在线直接返回。
    /// watch 监督任务用它在断线后主动恢复，而不是等用户下一次操作。
    pub(crate) async fn ensure_connection_alive(&self, connection_id: &str) -> Result<(), String> {
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

    fn server_gate(&self, key: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
        let mut gates = self
            .server_gates
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        Ok(gates
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone())
    }

    /// 会话在 `ssh_connect` 时固定的模式；会话不存在或尚未经 `ssh_connect` 定下模式时为 `None`。
    pub(crate) fn connection_mode(&self, connection_id: &str) -> Option<RemoteMode> {
        let session = self.session(connection_id).ok()?;
        let config = session.config.lock().ok()?;
        config.mode
    }

    /// 该连接是否处于 Server 模式。会话不存在时为 false：所有 server 路径据此停下，
    /// SSH 模式的连接从头到尾不会触碰 server 状态。
    pub(crate) fn server_mode(&self, connection_id: &str) -> bool {
        self.connection_mode(connection_id) == Some(RemoteMode::Server)
    }

    /// 项目根所在连接是否处于 Server 模式。
    pub(crate) fn root_server_mode(&self, root: &RegisteredRoot) -> bool {
        remote_uri_connection_id(&root.uri).is_some_and(|id| self.server_mode(id))
    }

    pub(crate) fn set_server_cache_dir(&self, dir: PathBuf) {
        if let Ok(mut slot) = self.server_cache_dir.write() {
            *slot = Some(dir);
        }
    }

    pub(crate) fn server_cache_dir(&self) -> Option<PathBuf> {
        self.server_cache_dir
            .read()
            .ok()
            .and_then(|slot| slot.clone())
    }

    pub(crate) fn server_auto_download(&self) -> bool {
        self.server_auto_download.load(Ordering::SeqCst)
    }

    /// 设置本地 server 二进制查找目录：去重且仅保留真实存在的目录。
    pub(crate) fn set_server_binary_dirs(&self, dirs: Vec<PathBuf>) {
        let mut seen = std::collections::HashSet::new();
        let filtered = dirs
            .into_iter()
            .filter(|dir| dir.is_dir() && seen.insert(dir.clone()))
            .collect();
        if let Ok(mut slot) = self.server_binary_dirs.write() {
            if *slot == filtered {
                return;
            }
            *slot = filtered;
        }
        self.reset_shared_services();
    }

    pub(crate) fn set_server_offline_dir(&self, dir: Option<PathBuf>) {
        let dir = dir.filter(|path| path.is_dir());
        if let Ok(mut slot) = self.server_offline_dir.write() {
            if *slot == dir {
                return;
            }
            *slot = dir;
        }
        self.reset_shared_services();
    }

    fn reset_shared_services(&self) {
        self.host_daemons.invalidate_all();
        if let Ok(mut slots) = self.servers.write() {
            for slot in slots.values_mut() {
                if let Some(endpoint) = slot.endpoint.as_mut() {
                    endpoint.daemon = None;
                    if endpoint.serve.is_none() {
                        slot.endpoint = None;
                    }
                }
            }
        }
    }

    /// 手动选择的目录排在最前；与自动目录重复时只保留这一次。
    pub(crate) fn server_binary_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = self
            .server_binary_dirs
            .read()
            .map(|dirs| dirs.clone())
            .unwrap_or_default();
        let offline = self
            .server_offline_dir
            .read()
            .ok()
            .and_then(|slot| slot.clone())
            .filter(|dir| dir.is_dir());
        if let Some(offline) = offline {
            dirs.retain(|dir| dir != &offline);
            dirs.insert(0, offline);
        }
        dirs
    }

    fn workspace_server_settings(&self, uri: &str) -> Option<WorkspaceServerSettings> {
        self.workspace_server_settings
            .read()
            .ok()?
            .get(&normalize_remote_uri(uri))
            .cloned()
    }

    fn server_binary_dirs_for_root(&self, uri: &str) -> Vec<PathBuf> {
        let Some(policy) = self.workspace_server_settings(uri) else {
            return self.server_binary_dirs();
        };
        let mut dirs = self
            .server_binary_dirs
            .read()
            .map(|dirs| dirs.clone())
            .unwrap_or_default();
        if let Some(offline) = policy.offline_dir {
            dirs.retain(|dir| dir != &offline);
            dirs.insert(0, offline);
        }
        dirs
    }

    fn server_auto_download_for_root(&self, uri: &str) -> bool {
        self.workspace_server_settings(uri).map_or_else(
            || self.server_auto_download(),
            |policy| policy.auto_download,
        )
    }

    fn root_is_passive(&self, uri: &str) -> bool {
        self.passive_roots
            .read()
            .map(|roots| roots.contains(&normalize_remote_uri(uri)))
            .unwrap_or(true)
    }

    fn start_workspace_watch(&self, app: AppHandle, root: &RegisteredRoot) {
        let Some(id) = remote_uri_connection_id(&root.uri) else {
            return;
        };
        if !root.trusted || !self.server_mode(id) || self.root_is_passive(&root.uri) {
            return;
        }
        let key = server::server_slot_key(id, &root.canonical_path);
        if self.has_watch_supervisor(&key) {
            return;
        }
        let handle = server::spawn_server_watch_supervisor(
            app,
            id.to_string(),
            normalize_remote_uri(&root.uri),
            root.canonical_path.clone(),
        );
        self.replace_watch_supervisor(&key, handle);
    }

    /// 离线目录变更后，让之前因缺二进制而失败的槽重新尝试部署。
    pub(crate) fn clear_unavailable_servers(&self) {
        if let Ok(mut servers) = self.servers.write() {
            for slot in servers.values_mut() {
                if slot.endpoint.is_none() {
                    slot.unavailable_reason = None;
                    slot.activity = None;
                    slot.last_failure = None;
                }
            }
        }
    }

    pub(crate) fn server_slot(&self, key: &str) -> Option<server::ServerSlot> {
        self.servers
            .read()
            .ok()
            .and_then(|servers| servers.get(key).cloned())
    }

    pub(crate) fn set_server_slot(&self, key: &str, slot: server::ServerSlot) {
        if let Ok(mut servers) = self.servers.write() {
            servers.insert(key.to_string(), slot);
        }
    }

    /// server 调用失败后清空端点、不可用原因、部署退避计数与降级时间戳，
    /// 下次再走完整的发现/部署。
    pub(crate) fn clear_server_endpoint(&self, key: &str) {
        if let Ok(mut servers) = self.servers.write() {
            if let Some(slot) = servers.get_mut(key) {
                slot.endpoint = None;
                slot.unavailable_reason = None;
                slot.activity = None;
                slot.last_failure = None;
                slot.daemon_downgraded_at = None;
                slot.daemon_failure = None;
                slot.deploy_failures = 0;
            }
        }
    }

    fn pause_project_server(&self, key: &str) {
        self.stop_watch_supervisor(key);
        self.set_server_slot(
            key,
            server::ServerSlot {
                unavailable_reason: Some("项目远端服务已停止，请重启服务或重新连接".into()),
                ..Default::default()
            },
        );
    }

    /// 记录发现/部署中的阶段。`None` 清掉瞬时阶段；没有 slot 时不新建空槽。
    pub(crate) fn set_server_activity(
        &self,
        key: &str,
        activity: Option<server_status::ServerPhase>,
    ) {
        let Ok(mut servers) = self.servers.write() else {
            return;
        };
        if activity.is_none() && !servers.contains_key(key) {
            return;
        }
        let slot = servers.entry(key.to_string()).or_default();
        slot.activity = activity;
    }

    /// 快照变化时返回 true，调用方再 emit。相同载荷不重复发。
    /// 转移表只做诊断，不因为跳步就丢掉这次发布。
    pub(crate) fn record_server_snapshot(&self, state: &server_status::SshServerState) -> bool {
        let Ok(mut snapshots) = self.server_snapshots.lock() else {
            return true;
        };
        let key = normalize_remote_uri(&state.root_uri);
        let previous = snapshots.get(&key).cloned();
        if previous.as_ref() == Some(state) {
            return false;
        }
        let legal = match &previous {
            Some(previous) => {
                server_status::server_phase_transition_allowed(previous.phase, state.phase)
            }
            None => true,
        };
        // 转移表不拦截发布：跳步时仍以当前槽位为准，避免界面停在过期阶段。
        let _: bool = legal;
        snapshots.insert(key, state.clone());
        true
    }

    /// 连接断开时丢弃该连接的全部 server 缓存：端口与 token 随远端进程生命周期变化，
    /// 重连后必须重新发现/部署。前缀匹配 `server_slot_key` 的 `连接id|根` 形式。
    fn purge_server_state(&self, connection_id: &str) {
        let prefix = format!("{connection_id}|");
        if let Ok(mut servers) = self.servers.write() {
            servers.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut gates) = self.server_gates.lock() {
            gates.retain(|key, _| !key.starts_with(&prefix));
        }
        self.forget_server_install(connection_id);
    }

    /// 该连接已校验过的（家目录, 安装目录）。
    pub(crate) fn cached_server_install(&self, connection_id: &str) -> Option<(String, String)> {
        self.server_installs
            .lock()
            .ok()
            .and_then(|installs| installs.get(connection_id).cloned())
    }

    pub(crate) fn remember_server_install(
        &self,
        connection_id: &str,
        home: &str,
        install_dir: &str,
    ) {
        if let Ok(mut installs) = self.server_installs.lock() {
            installs.insert(
                connection_id.to_string(),
                (home.to_string(), install_dir.to_string()),
            );
        }
    }

    /// 部署失败或断开时丢弃缓存：安装目录可能已被远端删除，下次重新创建并校验。
    pub(crate) fn forget_server_install(&self, connection_id: &str) {
        if let Ok(mut installs) = self.server_installs.lock() {
            installs.remove(connection_id);
        }
    }

    /// 替换某个 (连接, 根) 的 watch 监督任务；重复连接同一根时先终止旧任务。
    fn replace_watch_supervisor(&self, key: &str, handle: tauri::async_runtime::JoinHandle<()>) {
        if let Ok(mut supervisors) = self.watch_supervisors.lock() {
            // Starting a new incarnation already cancelled the previous one.
            // Detach its task so its watch loop can send EOF/CLOSE gracefully.
            supervisors.insert(key.to_string(), handle);
        }
    }

    /// 该 (连接, 根) 是否已有未结束的 watch 监督任务；补信任时据此避免重启
    /// 一条健康的 watch 连接。tauri 的句柄要经 `inner()` 才拿到 tokio 的完成态。
    fn has_watch_supervisor(&self, key: &str) -> bool {
        self.watch_supervisors
            .lock()
            .ok()
            .is_some_and(|supervisors| {
                supervisors
                    .get(key)
                    .is_some_and(|handle| !handle.inner().is_finished())
            })
    }

    fn stop_watch_supervisor(&self, key: &str) {
        if let Ok(mut cancellations) = self.watch_cancellations.lock() {
            if let Some(cancelled) = cancellations.remove(key) {
                cancelled.store(true, Ordering::Release);
            }
        }
        if let Ok(mut supervisors) = self.watch_supervisors.lock() {
            supervisors.remove(key);
        }
    }

    fn begin_watch_supervisor(&self, key: &str) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Ok(mut cancellations) = self.watch_cancellations.lock() {
            if let Some(previous) = cancellations.insert(key.into(), Arc::clone(&cancelled)) {
                previous.store(true, Ordering::Release);
            }
        }
        cancelled
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
        self.exec_uri_with_timeout(uri, command, require_trust, REMOTE_EXEC_TIMEOUT)
            .await
    }

    async fn exec_uri_with_timeout(
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

    async fn exec_uri_with_input(
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
    async fn exec_windows_git(
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

    async fn exec_command(
        &self,
        uri: &str,
        command: &str,
        input: Option<&[u8]>,
        require_trust: bool,
        timeout: Duration,
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

#[tauri::command]
pub async fn ssh_set_workspace_trust(
    root_uri: String,
    trusted: bool,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    parse_remote_uri(&root_uri)?;
    if !trusted {
        manager.set_root_trust(&root_uri, false)?;
        if let Ok(root) = manager.registered_root(&root_uri) {
            if let Some(id) = remote_uri_connection_id(&root.uri) {
                manager.stop_watch_supervisor(&server::server_slot_key(id, &root.canonical_path));
            }
        }
        // 安全闸优先：撤销信任在任何连接状态下都必须生效，远端清理只尽力而为。
        manager.kill_persistent_terminals_for_root(&root_uri).await;
        if let Ok(root) = manager.registered_root(&root_uri) {
            kill_detached_terminals_best_effort(&app, &manager, &root).await;
        }
    }
    manager.set_root_trust(&root_uri, trusted)?;
    // 连接建立后才补信任的根不会经历 ssh_connect 的拉起路径：这里补一条
    // watch 监督任务（连接仍在、开关开启且没有存活任务时），否则远端变更
    // 事件永远缺位。已有健康任务时不重启，避免白白断开一条 watch 连接。
    if trusted {
        if let Ok(root) = manager.registered_root(&root_uri) {
            if let Ok(parsed) = parse_remote_uri(&root.uri) {
                if root.trusted
                    && !manager.root_is_passive(&root.uri)
                    && manager.server_mode(&parsed.connection_id)
                    && manager.connection_is_open(&parsed.connection_id)
                {
                    let key = server::server_slot_key(&parsed.connection_id, &root.canonical_path);
                    if !manager.has_watch_supervisor(&key) {
                        let handle = server::spawn_server_watch_supervisor(
                            app,
                            parsed.connection_id.clone(),
                            normalize_remote_uri(&root.uri),
                            root.canonical_path.clone(),
                        );
                        manager.replace_watch_supervisor(&key, handle);
                    }
                }
            }
        }
    }
    Ok(())
}

/// 查询某个 SSH 项目根当前的代理阶段。非 ssh URI 或未注册根直接拒绝。
#[tauri::command]
pub fn ssh_server_info(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshServerState, String> {
    let state = server_status::ssh_server_info(root_uri.clone(), manager.clone())?;
    // 「正在探测」却没有任务在推进（端点被清掉、监督任务已退出等）时，
    // 查询顺手补一轮后台发现，结果经状态事件推回芯片。
    if state.phase == server_status::ServerPhase::Probing && !manager.root_is_passive(&root_uri) {
        if let Ok(root) = manager.registered_root(&root_uri) {
            server::kick_server_discovery(&app, &manager, &root);
        }
    }
    Ok(state)
}

/// 清掉该根的 server slot，必要时按 server.json 里的 pid 结束 serve 进程，再重新 ensure。
#[tauri::command]
pub async fn ssh_server_restart(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshServerState, String> {
    server_status::ssh_server_restart(root_uri, app, manager).await
}

/// 停掉某根的项目绑定与未共享的 serve，保留其他项目使用的用户级 daemon。
#[tauri::command]
pub async fn ssh_server_stop(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    server_status::ssh_server_stop(root_uri, app, manager).await
}

/// 读取远端日志：daemon 日志（`$HOME/.qingcode/server/run/server.log`）在前，
/// 项目 serve 日志（`<root>/.qingcode/server/serve.log`）在后，以分隔行拼接。
/// 两者都缺时返回说明文字，不报错。
#[tauri::command]
pub async fn ssh_server_logs(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<SshServerLogs, String> {
    server_status::ssh_server_logs(root_uri, manager).await
}

/// `ssh.server.autoDownload`：本地缺失 server 二进制时是否自动从 GitHub Release
/// 下载（sha256 校验）。默认开启；离线用户在设置里选择离线目录即可。
#[tauri::command]
pub fn ssh_set_server_auto_download(
    enabled: bool,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    manager
        .server_auto_download
        .store(enabled, std::sync::atomic::Ordering::SeqCst);
    // 与 offline_dir 一致：开关状态变化后让之前「本地缺二进制」的不可用槽
    // 重新尝试，用户重开开关即可立即重试下载，不必断开重连。
    manager.clear_unavailable_servers();
    Ok(())
}

/// `ssh.server.offlineDir`：手动指定本机离线代理目录。空字符串表示清除。
/// 目录本身或其中的 `servers` 子目录必须含有 `qingcode-server` 文件。
#[tauri::command]
pub fn ssh_set_server_offline_dir(
    dir: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        manager.set_server_offline_dir(None);
        manager.clear_unavailable_servers();
        return Ok(String::new());
    }
    if trimmed.len() > 1024 || trimmed.contains('\0') || trimmed.contains("ssh://") {
        return Err("离线目录必须是本机文件夹".to_string());
    }
    let resolved = server::resolve_offline_server_dir(Path::new(trimmed))?;
    let text = resolved.to_string_lossy().into_owned();
    manager.set_server_offline_dir(Some(resolved));
    manager.clear_unavailable_servers();
    Ok(text)
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

/// Windows OpenSSH SFTP paths look like `/D:/code/app`. The server writes the
/// canonicalized root with the Windows verbatim prefix (`\\?\D:\code\app`), so
/// both forms must normalize to the same native drive path.
fn windows_native_path(path: &str) -> Option<String> {
    let path = path.trim().trim_matches('"');
    let path = path
        .strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
        .unwrap_or(path);
    let rest = path.strip_prefix('/').unwrap_or(path);
    let mut chars = rest.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next() != Some(':') {
        return None;
    }
    // Reject drive-relative paths such as `D:code`; only `D:`, `D:\...` and
    // `D:/...` identify an absolute Windows location.
    if chars
        .next()
        .is_some_and(|separator| separator != '\\' && separator != '/')
    {
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

/// Windows 远端 PowerShell 的 UTF-8 启动设置。
///
/// Windows PowerShell 5.1 的 `Get-Content`（`cat` / `type`）默认按系统 ANSI
/// 代码页解码文件，读 UTF-8 文本时中文会显示成 `ä¸­æ–‡`。控制台读写与文件
/// 读取统一固定为 UTF-8，不再依赖远端系统区域设置。
const WINDOWS_POWERSHELL_UTF8_SETUP: &str = "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = [Console]::OutputEncoding } catch { }; $OutputEncoding = [Console]::OutputEncoding; $PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'";

/// cmd.exe 的对应设置：`type` 按控制台代码页解码文件。
const WINDOWS_CMD_UTF8_SETUP: &str = "chcp 65001>nul";

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
    let script = format!(
        "{WINDOWS_POWERSHELL_UTF8_SETUP}; Set-Location -LiteralPath '{}'",
        powershell_literal(native)
    );
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
        "$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath '{}'; & cmd.exe /K '{}'; exit $LASTEXITCODE",
        powershell_literal(native),
        WINDOWS_CMD_UTF8_SETUP
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn open_transport(
    config: &SshConnectionConfig,
    expected_fingerprint: Option<String>,
    purpose: ConnectionPurpose,
) -> Result<OpenedTransport, String> {
    let observed = Arc::new(Mutex::new(None));
    let disconnect_reason = Arc::new(Mutex::new(None));
    let handler = SshClient {
        expected_fingerprint,
        observed_fingerprint: Arc::clone(&observed),
        disconnect_reason: Arc::clone(&disconnect_reason),
        keepalive_window: keepalive_window(purpose),
    };
    let client_config = ssh_client_config(purpose);
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
    Ok((handle, fingerprint, disconnect_reason))
}

/// 已握手的传输：句柄、主机指纹、断开原因槽位。
type OpenedTransport = (
    client::Handle<SshClient>,
    String,
    Arc<Mutex<Option<String>>>,
);

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
    probe_host_with_timeout(&config, SSH_HANDSHAKE_TIMEOUT).await
}

async fn probe_host_with_timeout(
    config: &SshConnectionConfig,
    timeout: Duration,
) -> Result<SshHostProbe, String> {
    let observed = Arc::new(Mutex::new(None));
    let handler = SshClient {
        expected_fingerprint: None,
        observed_fingerprint: Arc::clone(&observed),
        disconnect_reason: Arc::new(Mutex::new(None)),
        keepalive_window: keepalive_window(ConnectionPurpose::Main),
    };
    // russh 的 inactivity_timeout 要等 banner 读取后启动 Session 才生效。
    // TCP 已接受却不发 SSH banner 的主机必须由探测整体 deadline 收口。
    tokio::time::timeout(timeout, async {
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
    })
    .await
    .map_err(|_| {
        format!(
            "SSH 主机指纹探测超时：{}:{} 在 {} 秒内未完成握手，请检查远端 sshd 是否正常",
            config.host,
            config.port,
            timeout.as_secs_f64()
        )
    })?;
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

/// An authenticated transport cannot adopt an edited identity or credentials.
/// Otherwise file operations would keep using the old host while reconnect and
/// terminal transports authenticate against the newly remembered configuration.
fn require_matching_session_config(
    authenticated: &SshConnectionConfig,
    requested: &SshConnectionConfig,
) -> Result<(), String> {
    if authenticated.host.eq_ignore_ascii_case(&requested.host)
        && authenticated.port == requested.port
        && authenticated.username == requested.username
        && authenticated.auth_kind == requested.auth_kind
        && authenticated.private_key_path == requested.private_key_path
        && requested
            .password
            .as_ref()
            .is_none_or(|password| authenticated.password.as_ref() == Some(password))
        && requested
            .passphrase
            .as_ref()
            .is_none_or(|passphrase| authenticated.passphrase.as_ref() == Some(passphrase))
        && authenticated.host_key_fingerprint == requested.host_key_fingerprint
    {
        Ok(())
    } else {
        Err("SSH 连接配置已变更，请先断开现有连接再重连；测试连接不会更新在用会话".into())
    }
}

/// 不带模式的调用（浏览目录的 ssh_open_session）不能抹掉会话已定下的模式。
fn merge_remembered_config(
    stored_mode: Option<RemoteMode>,
    config: SshConnectionConfig,
) -> SshConnectionConfig {
    let mode = config.mode.or(stored_mode);
    SshConnectionConfig { mode, ..config }
}

/// 前端据「连接模式已变更」识别该错误：切换模式必须先 `ssh_disconnect` 再连接。
fn mode_changed_error(current: Option<RemoteMode>, requested: RemoteMode) -> String {
    let current = current.map_or("未定", RemoteMode::label);
    format!(
        "连接模式已变更：该连接当前为 {current} 模式，请求 {} 模式，请先断开连接再重连",
        requested.label()
    )
}

/// 会话已有项目根时模式不可改：只有浏览目录用的会话（还没有根）可以在连接时定下新模式。
fn mode_conflict(
    current: Option<RemoteMode>,
    requested: RemoteMode,
    has_roots: bool,
) -> Option<String> {
    match current {
        Some(current) if current != requested && has_roots => {
            Some(mode_changed_error(Some(current), requested))
        }
        _ => None,
    }
}

fn ensure_mode_unchanged(
    manager: &SshManager,
    connection_id: &str,
    requested: RemoteMode,
) -> Result<(), String> {
    let has_roots = !manager.roots_for_connection(connection_id).is_empty();
    match mode_conflict(manager.connection_mode(connection_id), requested, has_roots) {
        Some(error) => Err(error),
        None => Ok(()),
    }
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
    purpose: ConnectionPurpose,
) -> Result<(ConnectedSession, String), String> {
    let expected = config
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty());
    let (handle, fingerprint, disconnect_reason) =
        tokio::time::timeout(SSH_HANDSHAKE_TIMEOUT, async {
            let (mut handle, fingerprint, disconnect_reason) =
                open_transport(&config, expected, purpose).await?;
            authenticate(&mut handle, &config).await?;
            Ok::<_, String>((handle, fingerprint, disconnect_reason))
        })
        .await
        .map_err(|_| ssh_handshake_timeout_error(&config))??;
    Ok((
        ConnectedSession {
            server_incarnation: Arc::new(()),
            handle,
            config: Mutex::new(config),
            sftp: tokio::sync::Mutex::new(None),
            disconnect_reason,
        },
        fingerprint,
    ))
}

async fn store_authenticated_session(
    manager: &SshManager,
    config: SshConnectionConfig,
) -> Result<(Arc<ConnectedSession>, String), String> {
    let id = config.id.clone();
    let (connected, fingerprint) = authenticate_session(config, ConnectionPurpose::Main).await?;
    let connected = Arc::new(connected);
    manager
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .insert(id, Arc::clone(&connected));
    Ok((connected, fingerprint))
}

#[tauri::command]
pub async fn ssh_test_connection(
    config: SshConnectionConfig,
) -> Result<SshSessionOpenResult, String> {
    if config
        .host_key_fingerprint
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err("连接前必须确认 SSH 主机指纹".into());
    }
    // Deliberately has no SshManager: testing never registers or changes an
    // application's live session, root, credentials, or shared daemon cache.
    let username = config.username.clone();
    let (connected, fingerprint) = authenticate_session(config, ConnectionPurpose::Main).await?;
    let connected = Arc::new(connected);
    let result = async {
        let sftp = open_sftp_session(&connected)
            .await
            .map_err(|error| error.message)?;
        Ok(SshSessionOpenResult {
            fingerprint,
            home_path: resolve_remote_home(&sftp, &username).await,
        })
    }
    .await;
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        connected
            .handle
            .disconnect(Disconnect::ByApplication, "connection test complete", "en"),
    )
    .await;
    result
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
        // 模式只由 ssh_connect 定下：测试连接或浏览目录不能改动在用会话的模式。
        manager.remember_config(
            &config.id,
            SshConnectionConfig {
                mode: None,
                ..config.clone()
            },
        )?;
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
    defer_service: Option<bool>,
    app: tauri::AppHandle,
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
    let mode = config
        .mode
        .ok_or_else(|| "SSH 连接缺少模式（Server / SSH）".to_string())?;
    // Frontends have per-window queues; serialize initial authentication across
    // windows too, and coordinate with explicit native disconnect/reconnect.
    let auth_gate = manager.reconnect_gate(&config.id)?;
    let mut auth_guard = auth_gate.lock().await;
    // 只有这次新建会话才发 authenticating；已有会话时第一眼就是 probing / readyDirect。
    let fresh_auth = existing_session(&manager, &config.id).is_none();
    let fingerprint = if !fresh_auth {
        ensure_mode_unchanged(&manager, &config.id, mode)?;
        manager.remember_config(&config.id, config.clone())?;
        expected
    } else {
        // 会话还不存在，接下来才做握手认证。成功后会被 probing / readyDirect 盖掉。
        server_status::publish_authenticating(&app, &manager, &config.id, &root_uri);
        match store_authenticated_session(&manager, config.clone()).await {
            Ok((_connected, fingerprint)) => fingerprint,
            Err(error) => {
                server_status::publish_disconnected(&app, &manager, &config.id, &root_uri);
                return Err(error);
            }
        }
    };
    *auth_guard = None;
    drop(auth_guard);
    let abandon_fresh_auth = |error: String| {
        if fresh_auth {
            server_status::publish_disconnected(&app, &manager, &config.id, &root_uri);
        }
        error
    };
    let sftp = manager
        .open_sftp(&config.id)
        .await
        .map_err(abandon_fresh_auth)?;
    let canonical_root = sftp
        .canonicalize(parsed_root.path)
        .await
        .map_err(|error| abandon_fresh_auth(format!("远程项目目录不可用：{error}")))?;
    reject_windows_sftp_links(&sftp, &canonical_root)
        .await
        .map_err(abandon_fresh_auth)?;
    let metadata = sftp
        .metadata(canonical_root.clone())
        .await
        .map_err(|error| abandon_fresh_auth(format!("读取远程项目目录失败：{error}")))?;
    if !metadata.is_dir() {
        return Err(abandon_fresh_auth("远程项目路径不是目录".to_string()));
    }
    // 并发的另一次 ssh_connect 可能在上面的 await 期间把会话改成了别的模式；
    // 登记根之前再确认一次，保证同一会话下所有根的模式一致。
    if manager.connection_mode(&config.id) != Some(mode) {
        return Err(abandon_fresh_auth(mode_changed_error(
            manager.connection_mode(&config.id),
            mode,
        )));
    }
    if defer_service.unwrap_or(false) && !manager.root_is_registered(&root_uri)? {
        manager
            .passive_roots
            .write()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?
            .insert(normalize_remote_uri(&root_uri));
    }
    manager
        .roots
        .write()
        .map_err(|_| abandon_fresh_auth("SSH 工作区状态不可用".to_string()))?
        .insert(
            root_uri.clone(),
            RegisteredRoot {
                uri: normalize_remote_uri(&root_uri),
                canonical_path: canonical_root.clone(),
                trusted,
            },
        );
    // 先公布稳态，再拉起监督任务，避免监督任务先发出 installing 后被 probing 盖掉。
    if let Ok(root) = manager.registered_root(&root_uri) {
        server_status::publish_root_state(&app, &manager, &root);
    }
    // 已信任的远端：启动 watch 监督任务（server 提供远端事件源）。
    // Windows 与 Linux 都优先 daemon（Windows 走命名管道），失败再回退 serve。
    // 重复连接同一根时先终止旧任务，避免出现两条并发的 watch 连接。
    if trusted && mode == RemoteMode::Server && !defer_service.unwrap_or(false) {
        let key = server::server_slot_key(&config.id, &canonical_root);
        let handle = server::spawn_server_watch_supervisor(
            app.clone(),
            config.id.clone(),
            normalize_remote_uri(&root_uri),
            canonical_root.clone(),
        );
        manager.replace_watch_supervisor(&key, handle);
    }
    Ok(SshConnectResult {
        fingerprint,
        canonical_root,
    })
}

#[tauri::command]
pub async fn ssh_disconnect(
    connection_id: String,
    app: tauri::AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    if let Err(error) = server::kill_detached_terminals(&connection_id, &app, &manager, None).await
    {
        eprintln!("[WARN] 断开连接时清理远端终端失败（{connection_id}）：{error}");
    }
    manager
        .kill_persistent_terminals_for_connection(&connection_id)
        .await;
    for root in manager.roots_for_connection(&connection_id) {
        server_status::publish_disconnected(&app, &manager, &connection_id, &root.uri);
    }
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
    // 取消该连接的所有 watch 代次，让读循环有机会发 EOF/CLOSE 后正常收尾。
    let prefix = format!("{connection_id}|");
    let stale = manager
        .watch_cancellations
        .lock()
        .map(|cancellations| {
            cancellations
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for key in stale {
        manager.stop_watch_supervisor(&key);
    }
    // server 的端口 / token 跟着远端进程走，重连后必须重新发现，缓存一律丢弃。
    manager.purge_server_state(&connection_id);
    if let Ok(mut policies) = manager.workspace_server_settings.write() {
        policies.retain(|uri, _| remote_uri_connection_id(uri) != Some(connection_id.as_str()));
    }
    if let Ok(mut passive) = manager.passive_roots.write() {
        passive.retain(|uri| remote_uri_connection_id(uri) != Some(connection_id.as_str()));
    }
    // 终端各用独立连接，主连接断开不会带走它们，需要逐个断开。
    let terminal_transports = manager
        .terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .values()
        .filter(|terminal| terminal.connection_id == connection_id)
        .map(|terminal| Arc::clone(&terminal.transport))
        .collect::<Vec<_>>();
    for transport in terminal_transports {
        close_terminal_transport(&transport).await;
    }
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
pub fn ssh_shared_server_ready(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<bool, String> {
    let parsed = parse_remote_uri(&root_uri)?;
    Ok(server::shared_server_known(&manager, &parsed.connection_id))
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceServerSettings {
    auto_download: bool,
    offline_dir: Option<PathBuf>,
}

impl WorkspaceServerSettings {
    fn validated(mut self) -> Result<Self, String> {
        self.offline_dir = match self.offline_dir.filter(|dir| !dir.as_os_str().is_empty()) {
            Some(dir) => {
                let text = dir.to_string_lossy();
                if text.contains("://") || text.contains('\0') {
                    return Err("离线服务目录必须是本地目录".into());
                }
                Some(server::resolve_offline_server_dir(&dir)?)
            }
            None => None,
        };
        Ok(self)
    }
}

#[tauri::command]
pub async fn ssh_prepare_workspace(
    root_uri: String,
    settings: Option<WorkspaceServerSettings>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let parsed = parse_remote_uri(&root_uri)?;
    if !manager.connection_is_open(&parsed.connection_id) {
        return Err("SSH 连接未建立".to_string());
    }
    let root = manager.registered_root(&root_uri)?;
    let session = manager.session(&parsed.connection_id)?;
    // A registered root is not a usable Server workspace yet. Files need the
    // service and terminals need its daemon; reuse their bounded preparation.
    // Restricted workspaces and explicit SSH mode retain their SFTP-only path.
    if root.trusted && manager.root_server_mode(&root) {
        if let Some(settings) = settings {
            let settings = settings.validated()?;
            let previous = manager
                .workspace_server_settings
                .write()
                .map_err(|_| "SSH 项目设置不可用".to_string())?
                .insert(normalize_remote_uri(&root_uri), settings.clone());
            if previous.as_ref() != Some(&settings) {
                let key = server::server_slot_key(&parsed.connection_id, &root.canonical_path);
                let mut slot = manager.server_slot(&key).unwrap_or_default();
                if slot.endpoint.is_none() {
                    slot.unavailable_reason = None;
                    slot.deploy_failures = 0;
                    slot.last_failure = None;
                    manager.set_server_slot(&key, slot);
                }
            }
        }
        server::require_server_endpoint(&app, &manager, &root, true).await?;
    }
    // Never report late success after disconnect, root removal or trust revocation.
    let current = manager.registered_root(&root_uri)?;
    let current_session = manager.session(&parsed.connection_id)?;
    if current.trusted != root.trusted
        || current_session.handle.is_closed()
        || !Arc::ptr_eq(
            &current_session.server_incarnation,
            &session.server_incarnation,
        )
    {
        return Err("SSH 项目状态已变化，请重新打开".into());
    }
    Ok(())
}

/// Called only after foreground preparation and directory reading complete.
/// Separating this from the long deployment prevents a cancelled open from
/// installing a watch subscription when its native deployment finishes late.
#[tauri::command]
pub fn ssh_activate_workspace(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let parsed = parse_remote_uri(&root_uri)?;
    if !manager.connection_is_open(&parsed.connection_id) {
        return Err("SSH 连接未建立".into());
    }
    let root = manager.registered_root(&root_uri)?;
    manager
        .passive_roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .remove(&normalize_remote_uri(&root_uri));
    manager.start_workspace_watch(app, &root);
    Ok(())
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

/// 连接管理页用：某连接下全部已注册项目根及其信任状态。
/// 根注册在内存里，连接断开即清空，重连后由 ssh_connect 重新登记。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshWorkspaceRoot {
    pub root_uri: String,
    pub trusted: bool,
}

#[tauri::command]
pub fn ssh_workspace_roots(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<SshWorkspaceRoot>, String> {
    Ok(manager
        .roots_for_connection(&connection_id)
        .into_iter()
        .map(|root| SshWorkspaceRoot {
            root_uri: root.uri,
            trusted: root.trusted,
        })
        .collect())
}

/// 连接管理页用：某连接下全部已注册根的代理状态聚合。
/// 单个根解析失败只跳过该根，不拖垮整个列表。
#[tauri::command]
pub fn ssh_server_states(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<server_status::SshServerState>, String> {
    Ok(manager
        .roots_for_connection(&connection_id)
        .iter()
        .filter_map(|root| server_status::state_for_root(&manager, root).ok())
        .collect())
}

#[tauri::command]
pub async fn ssh_validate_directory(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("远程目录不可用：{error}"))?;
    if !metadata.is_dir() {
        return Err(format!("远程路径不是目录：{}", parsed.path));
    }
    Ok(())
}

fn remote_path_is_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

/// Windows OpenSSH 的 REALPATH 只做词法归一，不解析 NTFS reparse point。
/// 必须从盘符根逐组件检查（包含项目根及其祖先），不能只检查最后一个文件。
fn windows_sftp_guard_components(path: &str) -> Vec<String> {
    let Some(native) = windows_native_path(path) else {
        return Vec::new();
    };
    let posix = native.replace('\\', "/");
    let mut current = format!("/{}/", &posix[..2]);
    let mut components = vec![current.clone()];
    for component in posix[2..].split('/').filter(|part| !part.is_empty()) {
        if !current.ends_with('/') {
            current.push('/');
        }
        current.push_str(component);
        components.push(current.clone());
    }
    components
}

async fn reject_windows_sftp_links(sftp: &SftpSession, path: &str) -> Result<(), String> {
    sftp.windows_guard.check(&sftp.transport, path).await
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
    reject_windows_sftp_links(sftp, &canonical).await?;
    Ok(canonical)
}

async fn ensure_parent_path_within(
    sftp: &SftpSession,
    path: &str,
    root: &RegisteredRoot,
) -> Result<String, String> {
    ensure_existing_path_within(sftp, remote_parent_path(path)?, root).await
}

/// 把一组 (名称, 是否目录) 条目转成目录树节点：应用排除规则、按名称排序、目录优先。
/// SFTP 与 server 两条扫描路径共用，保证行为一致。
fn collect_scan_nodes(
    uri: &str,
    path: &str,
    root_posix: &str,
    entries: impl IntoIterator<Item = (String, bool)>,
    exclude_patterns: Option<&[String]>,
) -> Vec<RemoteFileNode> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for (name, is_dir) in entries {
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let full_posix = if path.ends_with('/') {
            format!("{path}{name}")
        } else {
            format!("{path}/{name}")
        };
        let rel = match full_posix.strip_prefix(root_posix) {
            Some(rest) => rest.trim_start_matches('/'),
            None => &name,
        };

        let should_skip = match exclude_patterns {
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
            path: join_remote_uri(uri, &name),
            name,
            is_dir,
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
    dirs
}

/// 计算绝对路径相对项目根的 POSIX 相对路径（server scan/watch 参数约定，根为 ""）。
fn remote_relative_to_root(canonical: &str, canonical_root: &str) -> String {
    let root = canonical_root.trim_end_matches('/');
    if root.is_empty() {
        return canonical.trim_matches('/').to_string();
    }
    canonical
        .strip_prefix(root)
        .unwrap_or(canonical)
        .trim_start_matches('/')
        .to_string()
}

/// Server 模式下经远端 server 列出目录的直接子项，不回退 SFTP；失败时清空端点
/// 缓存、后台重新发现，并返回带模式前缀的错误。返回 (名称, 是否目录) 交给
/// `collect_scan_nodes` 统一组装。
async fn server_scan_entries(
    app: &AppHandle,
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    canonical: &str,
) -> Result<Vec<(String, bool)>, String> {
    let key = server::server_slot_key(connection_id, &root.canonical_path);
    let mut endpoint = server::require_server_endpoint(app, manager, root, false).await?;
    let relative = remote_relative_to_root(canonical, &root.canonical_path);
    // daemon 传输优先：一次 RPC 往返，目录树刷新与 watch 事件同源。传输失败
    // 只降级 daemon 标记（保留 serve 端点），继续走 serve 请求；daemon 应答的
    // 业务错误（目录已删除、无权限）直接返回，daemon 与 serve 端点都不受牵连。
    if let Some(daemon) = endpoint.daemon.as_ref() {
        match server::daemon_scan_entries(
            manager,
            connection_id,
            daemon,
            &root.canonical_path,
            &relative,
        )
        .await
        {
            Ok(entries) => return Ok(entries),
            Err(error) if !error.is_transport() => {
                return Err(format!("读取远程目录失败：{error}"));
            }
            Err(_) => {
                server::downgrade_server_daemon(manager, &key, daemon);
                // 传输从 daemon 降到 serve，状态芯片要跟着变。
                server_status::publish_root_state(app, manager, root);
            }
        }
    }
    if endpoint.serve.is_none() {
        endpoint = server::require_serve_endpoint(app, manager, root).await?;
    }
    let request = qingcode_server::ServerRequest {
        token: endpoint
            .serve
            .as_ref()
            .ok_or("项目 serve 尚未启动")?
            .token
            .clone(),
        op: qingcode_server::ServerOp::Scan { path: relative },
    };
    let mut entries = Vec::new();
    let outcome = server::server_stream_call(
        manager,
        connection_id,
        &endpoint,
        request,
        Instant::now() + Duration::from_secs(15),
        || false,
        |record| {
            let Some(name) = record.get("name").and_then(|value| value.as_str()) else {
                return true;
            };
            let is_dir = record
                .get("isDir")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            entries.push((name.to_string(), is_dir));
            true
        },
    )
    .await;
    match outcome {
        Ok(server::ServerStreamOutcome::Done { .. }) => Ok(entries),
        other => {
            // 扫描失败说明 server 可能已失联；清掉端点并在后台重新发现/部署。
            server::note_server_endpoint_lost(app, manager, root, &key);
            let detail = match other {
                Err(error) => error,
                Ok(_) => "server 未完成扫描".to_string(),
            };
            Err(server::server_mode_error(format!(
                "读取远程目录失败：{detail}"
            )))
        }
    }
}

#[tauri::command]
pub async fn ssh_warmup_directory(
    root_uri: String,
    exclude_patterns: Option<Vec<String>>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<Option<Vec<RemoteFileNode>>, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&root_uri, true).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    if !manager.server_mode(&parsed.connection_id) {
        return Ok(None);
    }
    let endpoint = server::require_server_endpoint(&app, &manager, &root, true).await?;
    let daemon = endpoint.daemon.ok_or("远端服务尚未就绪")?;
    let entries = server::daemon_warmup_entries(
        &manager,
        &parsed.connection_id,
        &daemon,
        &root.canonical_path,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(entries.map(|entries| {
        collect_scan_nodes(
            &root_uri,
            &parsed.path,
            &parsed.path,
            entries,
            exclude_patterns.as_deref(),
        )
    }))
}

#[tauri::command]
pub async fn ssh_scan_directory(
    path: String,
    workspace_root: Option<String>,
    exclude_patterns: Option<Vec<String>>,
    _exclude_git_ignore: Option<bool>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteFileNode>, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    let canonical = ensure_existing_path_within(&sftp, &parsed.path, &root).await?;

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

    // Server 模式只经 server 扫描，与 watch 事件同源，失败直接报错；SSH 模式与
    // 未受信任项目（不部署 server）走 SFTP。
    if root.trusted && manager.server_mode(&parsed.connection_id) {
        let entries =
            server_scan_entries(&app, &manager, &parsed.connection_id, &root, &canonical).await?;
        return Ok(collect_scan_nodes(
            &path,
            &parsed.path,
            &root_posix,
            entries,
            exclude_patterns.as_deref(),
        ));
    }

    let entries = sftp
        .read_dir(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    Ok(collect_scan_nodes(
        &path,
        &parsed.path,
        &root_posix,
        entries
            .into_iter()
            .map(|entry| (entry.file_name(), entry.metadata().is_dir())),
        exclude_patterns.as_deref(),
    ))
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

/// 图片查看专用：与 `ssh_read_file` 同一套守卫（sftp 会话 + 根目录边界 + 非目录 +
/// 大小上限），但扩展名检查方向相反——只放行图片白名单（图片是主动允许的二进制）。
/// 内容以原始字节（`tauri::ipc::Response`）直通前端，不做编码转换。
#[tauri::command]
pub async fn ssh_read_image_file(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<tauri::ipc::Response, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    // 与 ssh_read_file 的黑名单方向相反：非图片扩展名直接拒绝，省一次 SFTP 往返。
    if !crate::binary_ext::is_image_extension(&parsed.path) {
        return Err(crate::binary_ext::unsupported_image_format_message(
            &parsed.path,
        ));
    }
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    if metadata.is_dir() {
        return Err("无法把远程目录作为图片打开".to_string());
    }
    if metadata.len() > IMAGE_MAX_BYTES {
        return Err(crate::binary_ext::image_too_large_message(metadata.len()));
    }
    let bytes = sftp
        .read(parsed.path)
        .await
        .map_err(|error| format!("读取远程图片失败：{error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
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
    let canonical = ensure_existing_path_within(&sftp, &probe, &root).await?;
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
    if let Some(native) = windows_native_path(&path) {
        if let Some(component) = sftp
            .windows_guard
            .first_reparse_component(&sftp.transport, &path)
            .await?
        {
            if !native
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(component.trim_end_matches('\\'))
            {
                return Err(format!("拒绝通过 Windows 链接删除项目外路径：{component}"));
            }
            // Only this entry is a reparse point: remove the link, not its target.
            if sftp.remove_file(path.clone()).await.is_ok() {
                return Ok(());
            }
            return sftp
                .remove_dir(path)
                .await
                .map_err(|e| format!("删除远程目录链接失败：{e}"));
        }
    }
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
        match sftp.remove_file(path.clone()).await {
            Ok(()) => Ok(()),
            Err(_) if metadata.is_symlink() && windows_native_path(&path).is_some() => {
                // Windows 目录 symlink/Junction 需要 RMDIR；只移除链接自身，绝不递归目标。
                sftp.remove_dir(path)
                    .await
                    .map_err(|error| format!("删除远程目录链接失败：{error}"))
            }
            Err(error) => Err(format!("删除远程文件失败：{error}")),
        }
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

async fn copy_remote_tree(
    sftp: &SftpSession,
    src: String,
    dest: String,
    source_root: &RegisteredRoot,
) -> Result<(), String> {
    // 顶层目录在根内不代表它的子项也安全：逐节点拒绝指向根外的文件链接。
    ensure_existing_path_within(sftp, &src, source_root).await?;
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
            Box::pin(copy_remote_tree(
                sftp,
                entry.path().to_string(),
                child_dest,
                source_root,
            ))
            .await?;
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

    copy_remote_tree(
        &dest_sftp,
        source_parsed.path,
        final_dest_path,
        &source_root,
    )
    .await?;

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
        ensure_existing_path_within(&sftp, &dir, &root).await?;
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
/// 探测失败时返回错误，而不是退回空前缀把子目录项目的路径挂错。
async fn remote_git_prefix(manager: &SshManager, path: &str) -> Result<String, String> {
    let key = normalize_remote_uri(path);
    if let Some(cached) = manager.cached_git_prefix(&key) {
        return Ok(cached);
    }
    let output = remote_git_command(
        manager,
        path,
        vec!["rev-parse".to_string(), "--show-prefix".to_string()],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(format!(
            "读取远程 Git 项目前缀失败：{}",
            output.stderr.trim()
        ));
    }
    let mut prefix = output.stdout.trim().to_string();
    if !prefix.is_empty() && !prefix.ends_with('/') {
        prefix.push('/');
    }
    manager.remember_git_prefix(&key, &prefix);
    Ok(prefix)
}

/// 状态条目是否都落在 `prefix` 下；`-- .` 限定子树后，不满足说明缓存的前缀已过期。
fn entries_share_prefix(entries: &[(String, String)], prefix: &str) -> bool {
    prefix.is_empty()
        || entries
            .iter()
            .all(|(relative, _)| relative.starts_with(prefix))
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
    let mut prefix = remote_git_prefix(&manager, &path).await?;
    if !entries_share_prefix(&parsed.entries, &prefix) {
        // 缓存的前缀过期（项目被移动 / 重新 init）：丢掉缓存，立刻重新探测一次。
        manager.forget_git_prefix(&normalize_remote_uri(&path));
        prefix = remote_git_prefix(&manager, &path).await?;
    }
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
    let timeout = remote_git_timeout(&args);
    if let Some(native_root) = windows_native_path(&parsed.path) {
        return manager
            .exec_windows_git(path, &native_root, &args, require_trust, timeout)
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
    manager
        .exec_uri_with_timeout(path, &command, require_trust, timeout)
        .await
}

/// 走网络的 Git 子命令放宽时限，其余按普通命令处理。
fn remote_git_timeout(args: &[String]) -> Duration {
    match args.first().map(String::as_str) {
        Some("fetch" | "pull" | "push" | "clone") => REMOTE_NETWORK_EXEC_TIMEOUT,
        _ => REMOTE_EXEC_TIMEOUT,
    }
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
            // 只列项目子树内的文件，路径相对项目根（与状态、Diff 的路径基准一致）。
            "--relative".to_string(),
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
    // `<rev>:<path>` 默认按仓库根解析；`./` 让 Git 按 `-C` 所在的项目目录解析，
    // 项目是仓库子目录时也不用额外探测前缀。
    let spec = format!("{revision}:./{file}");
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    id: String,
    exit_code: u32,
    disconnected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// 读循环可能先于 russh 的 disconnected 回调结束；短暂等待原因写入后再上报。
async fn wait_for_closed_reason(transport: &ConnectedSession) -> Option<String> {
    if let Some(reason) = transport.closed_reason() {
        return Some(reason);
    }
    let wait_for_reason = async {
        loop {
            if let Some(reason) = transport.closed_reason() {
                return reason;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_millis(500), wait_for_reason)
        .await
        .ok()
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
    let transport = manager
        .open_terminal_transport(&parsed.connection_id)
        .await?;
    let channel = match start_terminal_channel(&transport, cols, rows, command).await {
        Ok(channel) => channel,
        Err(error) => {
            close_terminal_transport(&transport).await;
            return Err(error);
        }
    };
    let (mut reader, writer) = channel.split();
    let writer = Arc::new(writer);
    let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let alive = Arc::new(AtomicBool::new(true));
    let previous = {
        let mut terminals = manager
            .terminals
            .write()
            .map_err(|_| "SSH 终端状态不可用".to_string())?;
        terminals.insert(
            id.clone(),
            Arc::new(RemoteTerminalSession {
                connection_id: parsed.connection_id.clone(),
                transport: Arc::clone(&transport),
                input: input_tx,
                writer: Arc::clone(&writer),
                alive: Arc::clone(&alive),
            }),
        )
    };
    if let Some(previous) = previous {
        // 同一 id 重新创建：旧终端的连接不再有人使用，断开以免残留远端 Shell。
        previous.alive.store(false, Ordering::Release);
        tauri::async_runtime::spawn(async move {
            close_terminal_transport(&previous.transport).await;
        });
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
    let connection_id = parsed.connection_id.clone();
    let exit_alive = Arc::clone(&alive);
    let reader_transport = Arc::clone(&transport);
    tauri::async_runtime::spawn(async move {
        let started_at = Instant::now();
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
        let disconnected = !ended_by_remote;
        let reason = if disconnected {
            wait_for_closed_reason(&reader_transport).await
        } else {
            None
        };
        close_terminal_transport(&reader_transport).await;
        if claim_terminal_exit(&exit_alive) {
            app_clone
                .state::<SshManager>()
                .forget_terminal(&terminal_id, &exit_alive);
            if disconnected {
                let reason_text = reason.as_deref().unwrap_or("原因未知");
                eprintln!(
                    "[WARN] terminal {terminal_id} 连接 {connection_id} 断开：{reason_text}，存活 {:.1} 秒",
                    started_at.elapsed().as_secs_f64()
                );
            }
            let _ = app_clone.emit(
                "terminal-exit",
                TerminalExitPayload {
                    id: terminal_id,
                    exit_code,
                    disconnected,
                    reason,
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

/// 在终端独占的连接上打开会话通道、申请 PTY 并启动命令。
async fn start_terminal_channel(
    transport: &ConnectedSession,
    cols: Option<u16>,
    rows: Option<u16>,
    command: String,
) -> Result<russh::Channel<client::Msg>, String> {
    let channel = open_session_channel_once(transport, "终端").await?;
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
    Ok(channel)
}

fn persistent_shell_launch(
    path: &str,
    shell: Option<&str>,
) -> Result<server::PersistentLaunch, String> {
    let resolved = ssh_interactive_terminal_command(path, shell)?;
    let resolved_shell = resolved.resolved_shell;
    let windows = windows_native_path(path).is_some();
    let shell = if windows {
        Some(resolved_shell.clone())
    } else {
        matches!(resolved_shell.as_str(), "bash" | "zsh" | "sh").then(|| resolved_shell.clone())
    };
    // daemon 直接启动 shell（不经 OpenSSH 的 -EncodedCommand），启动参数要在这里
    // 补齐，否则远端 PowerShell 5.1 仍会按 ANSI 代码页解码 `cat` 的输出。
    let args = if !windows {
        Vec::new()
    } else if resolved_shell == "cmd" {
        vec!["/K".to_string(), WINDOWS_CMD_UTF8_SETUP.to_string()]
    } else {
        vec![
            "-NoLogo".to_string(),
            "-NoExit".to_string(),
            "-Command".to_string(),
            WINDOWS_POWERSHELL_UTF8_SETUP.to_string(),
        ]
    };
    Ok(server::PersistentLaunch {
        shell,
        args,
        env: std::collections::BTreeMap::new(),
        name: None,
        resolved_shell,
        fallback_from: resolved.fallback_from,
    })
}

/// 配置文件终端交给 daemon 的名称：优先用前端标签名，缺省才退回终端 id。
fn profile_terminal_name<'a>(name: Option<&'a str>, id: &'a str) -> &'a str {
    name.map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(id)
}

fn persistent_profile_launch(
    path: &str,
    target: &str,
    env: &HashMap<String, String>,
    shell: Option<&str>,
    name: &str,
) -> Result<server::PersistentLaunch, String> {
    let mut launch = persistent_shell_launch(path, shell)?;
    launch.name = Some(name.to_string());
    launch.env = env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if windows_native_path(path).is_some() {
        launch.args = if launch.resolved_shell == "cmd" {
            vec![
                "/K".to_string(),
                format!("{WINDOWS_CMD_UTF8_SETUP} & {target}"),
            ]
        } else {
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!("{WINDOWS_POWERSHELL_UTF8_SETUP}; {target}"),
            ]
        };
    } else {
        launch.args = vec![
            "-c".to_string(),
            format!("{target}; exec \"${{SHELL:-/bin/sh}}\" -l"),
        ];
    }
    Ok(launch)
}

/// 一次性运行任务交给 daemon：由 /bin/sh 执行与直连相同的调用串（含环境变量前缀），
/// 工作目录由 daemon 的 cwd 设置；进程结束即终端结束。
fn persistent_task_launch(invocation: &str, name: &str) -> server::PersistentLaunch {
    server::PersistentLaunch {
        shell: Some("/bin/sh".to_string()),
        args: vec!["-c".to_string(), invocation.to_string()],
        env: std::collections::BTreeMap::new(),
        name: Some(name.to_string()),
        resolved_shell: "sh".to_string(),
        fallback_from: None,
    }
}

fn direct_windows_profile_command(
    path: &str,
    target: &str,
    env: &HashMap<String, String>,
    shell: Option<&str>,
) -> Result<String, String> {
    let native = windows_native_path(path)
        .ok_or_else(|| "直连 profile 终端需要 Windows 远程路径".to_string())?;
    let launch = persistent_profile_launch(path, target, env, shell, "profile")?;
    let mut script = String::new();
    for (key, value) in env {
        script.push_str(&format!("$env:{key} = '{}'; ", powershell_literal(value)));
    }
    if launch.resolved_shell == "cmd" {
        script.push_str(&format!(
            "$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath '{}'; & cmd.exe /K '{}'; exit $LASTEXITCODE",
            powershell_literal(&native),
            powershell_literal(&format!("{WINDOWS_CMD_UTF8_SETUP} & {target}"))
        ));
        Ok(windows_encoded_powershell(
            "powershell.exe -NoLogo -NoProfile -NonInteractive",
            &script,
            true,
        ))
    } else {
        let launcher = if launch.resolved_shell == "pwsh" {
            "pwsh.exe -NoLogo -NoExit"
        } else {
            "powershell.exe -NoLogo -NoExit"
        };
        script.push_str(&format!(
            "{WINDOWS_POWERSHELL_UTF8_SETUP}; Set-Location -LiteralPath '{}'; {target}",
            powershell_literal(&native)
        ));
        Ok(windows_encoded_powershell(launcher, &script, true))
    }
}

/// SSH 模式下终端直连、断线即结束进程；前端据此在标签上提示。
const SSH_MODE_DIRECT_REASON: &str = "SSH 模式（连接配置），终端直连";

/// Server 模式下的失败统一带上模式前缀，前端据此提供「切到 SSH 模式」。
fn into_server_mode_error(error: String) -> String {
    if error.contains(server::SERVER_MODE_ERROR_PREFIX) {
        error
    } else {
        server::server_mode_error(error)
    }
}

fn direct_spawn_result_fallback(
    mut result: TerminalSpawnResult,
    reason: Option<String>,
) -> TerminalSpawnResult {
    result.persistent = false;
    result.persistent_fallback_reason = reason;
    result
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
    let root = manager.root_for_uri(&cwd, true)?;
    let sftp = manager.open_sftp(&parsed.connection_id).await?;
    let working_directory = ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let spec = ssh_interactive_terminal_command(&parsed.path, shell.as_deref())?;
    // Server 模式只走 daemon，SSH 模式只走直连，两者不再互相回退。
    if manager.server_mode(&parsed.connection_id) {
        let launch = persistent_shell_launch(&parsed.path, shell.as_deref())?;
        return server::spawn_persistent_terminal(
            id,
            root,
            working_directory,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
            launch,
            app,
            &manager,
        )
        .await
        .map_err(into_server_mode_error);
    }
    let persistent_reason = Some(SSH_MODE_DIRECT_REASON.to_string());
    let result = spawn_ssh_terminal(
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
    let mut result = direct_spawn_result_fallback(result, persistent_reason);
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
pub async fn ssh_run_environment(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<crate::run_environment::RunEnvironment, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let result = manager
        .exec_remote_shell(
            &path,
            "uname -s",
            "[Console]::Write('Windows_NT')",
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await?;
    if result.exit_code != 0 {
        return Err(format!("无法识别远端执行系统：{}", result.stderr.trim()));
    }
    Ok(crate::run_environment::RunEnvironment {
        os: crate::run_environment::unix_os(&result.stdout)?.into(),
        kind: "ssh".into(),
        distro: None,
    })
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
    name: Option<String>,
    project_root: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    if matches!(shell_kind.as_str(), "ps1" | "bat") {
        return Err("SSH Linux 项目暂不支持 PowerShell 或 BAT 任务".to_string());
    }
    let parsed = parse_remote_uri(&cwd)?;
    let root_uri = project_root.as_deref().unwrap_or(&cwd);
    if parse_remote_uri(root_uri)?.connection_id != parsed.connection_id {
        return Err("任务工作目录必须使用当前项目的 SSH 连接".into());
    }
    let root = manager.root_for_uri(root_uri, true)?;
    let server_mode = manager.server_mode(&parsed.connection_id);
    let persistent_cwd = {
        let sftp = manager.open_sftp(&parsed.connection_id).await?;
        Some(ensure_existing_path_within(&sftp, &parsed.path, &root).await?)
    };
    if shell_kind != "interactive" {
        reject_windows_remote_command(&parsed.path)?;
    }
    let target = if target.starts_with(SSH_URI_PREFIX) {
        let script = parse_remote_uri(&target)?;
        if script.connection_id != parsed.connection_id {
            return Err("脚本必须使用当前项目的 SSH 连接".into());
        }
        script.path
    } else {
        target
    };
    if matches!(shell_kind.as_str(), "sh" | "script") {
        let path = if target.starts_with('/') {
            target.clone()
        } else {
            join_remote_path(&parsed.path, &target)
        };
        let sftp = manager.open_sftp(&parsed.connection_id).await?;
        ensure_existing_path_within(&sftp, &path, &root).await?;
    }
    let mut env_prefix = String::new();
    for (key, value) in &env {
        if key.is_empty()
            || !key.bytes().enumerate().all(|(index, byte)| {
                byte == b'_'
                    || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
            })
        {
            return Err(format!("无效的远程任务环境变量名：{key}"));
        }
        env_prefix.push_str(&format!("{key}={} ", shell_quote(value)));
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
    let command = if shell_kind == "interactive" && windows_native_path(&parsed.path).is_some() {
        direct_windows_profile_command(&parsed.path, &target, &env, shell.as_deref())?
    } else {
        format!("cd -- {} && {invocation}", shell_quote(&parsed.path))
    };
    // Server 模式下交互式配置终端与一次性运行任务都交给 daemon；SSH 模式只走直连。
    if server_mode {
        let working_directory =
            persistent_cwd.expect("server mode validates the task working directory");
        let launch = if shell_kind == "interactive" {
            persistent_profile_launch(
                &parsed.path,
                &target,
                &env,
                shell.as_deref(),
                profile_terminal_name(name.as_deref(), &id),
            )?
        } else {
            persistent_task_launch(&invocation, profile_terminal_name(name.as_deref(), &id))
        };
        return server::spawn_persistent_terminal(
            id,
            root,
            working_directory,
            cols.unwrap_or(80),
            rows.unwrap_or(24),
            launch,
            app,
            &manager,
        )
        .await
        .map_err(into_server_mode_error);
    }
    let persistent_reason = Some(SSH_MODE_DIRECT_REASON.to_string());
    let result = spawn_ssh_terminal(id, cwd, cols, rows, app, &manager, command, None).await?;
    Ok(direct_spawn_result_fallback(result, persistent_reason))
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
    let persistent = manager
        .persistent_terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .cloned();
    if let Some(terminal) = persistent {
        return terminal.write(data.into_bytes());
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
    let persistent = manager
        .persistent_terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .cloned();
    if let Some(terminal) = persistent {
        return terminal.resize(cols, rows);
    }
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
    let persistent = manager
        .persistent_terminals
        .write()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .remove(&id);
    if let Some(terminal) = persistent {
        terminal.kill().await?;
        return Ok(());
    }
    let session = manager
        .terminals
        .write()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .remove(&id);
    if let Some(session) = session {
        session.alive.store(false, Ordering::Release);
        let closed = session.writer.close().await;
        // 远端不回 Close 时读取端不会结束，这里直接断开终端独占的连接。
        close_terminal_transport(&session.transport).await;
        closed.map_err(|error| format!("关闭 SSH 终端失败：{error}"))?;
    }
    Ok(())
}

/// 直接结束当前可信项目内、本安装遗留的 PTY，不接回或重放终端输出。
#[tauri::command]
pub async fn ssh_kill_detached_terminal(
    pty_id: String,
    cwd: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    if pty_id.trim().is_empty() {
        return Err("ptyId 不能为空".to_string());
    }
    let root = manager.root_for_uri(&cwd, true)?;
    server::kill_detached_terminal(&pty_id, &root, &app, &manager).await
}

/// 查询当前 QingCode 安装在该 SSH 连接下遗留的持久化终端。
#[tauri::command]
pub async fn ssh_list_detached_terminals(
    connection_id: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<Vec<server::DetachedTerminal>, String> {
    if connection_id.trim().is_empty() {
        return Err("connectionId 不能为空".to_string());
    }
    server::list_detached_terminals(&connection_id, &app, &manager).await
}

/// 把本地标签接回一个仍由 daemon 托管的 PTY。
#[tauri::command]
pub async fn ssh_attach_terminal(
    id: String,
    pty_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    let parsed = parse_remote_uri(&cwd)?;
    let root = manager.root_for_uri(&cwd, true)?;
    if remote_uri_connection_id(&root.uri) != Some(parsed.connection_id.as_str()) {
        return Err("终端工作目录与 SSH 连接不匹配".to_string());
    }
    server::attach_persistent_terminal(id, pty_id, root, cols, rows, app, &manager).await
}

/// 项目从 QingCode 移除后注销对应根，并尽力结束其中仍由 daemon 托管的终端。
#[tauri::command]
pub async fn ssh_forget_workspace_root(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let normalized = normalize_remote_uri(&root_uri);
    if let Ok(mut policies) = manager.workspace_server_settings.write() {
        policies.remove(&normalized);
    }
    if let Ok(mut passive) = manager.passive_roots.write() {
        passive.remove(&normalized);
    }
    // 本次会话未注册（重启后未连接就移除）时没有可清理的连接状态，直接放行。
    if let Ok(root) = manager.registered_root(&root_uri) {
        if let Some(id) = remote_uri_connection_id(&root.uri) {
            manager.stop_watch_supervisor(&server::server_slot_key(id, &root.canonical_path));
        }
        manager.kill_persistent_terminals_for_root(&root.uri).await;
        kill_detached_terminals_best_effort(&app, &manager, &root).await;
    }
    manager
        .roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .remove(&normalized);
    Ok(())
}

/// 尽力结束该根下本安装留在 daemon 里的 detached 终端。离线、daemon 未就绪或
/// 关闭 server 时无法触达远端，只记日志：这些终端在根未受信任时不会被列出或
/// 接回（接回要求可信根），由 daemon 的 detached TTL（默认 3 小时）回收。
async fn kill_detached_terminals_best_effort(
    app: &AppHandle,
    manager: &SshManager,
    root: &RegisteredRoot,
) {
    let Ok(parsed) = parse_remote_uri(&root.uri) else {
        return;
    };
    // 限时：离线时不能让撤销信任或移除项目卡在重连、部署上。
    let killed = tokio::time::timeout(
        Duration::from_secs(5),
        server::kill_detached_terminals(
            &parsed.connection_id,
            app,
            manager,
            Some(&root.canonical_path),
        ),
    )
    .await
    .unwrap_or_else(|_| Err("5 秒内未能连上远端 daemon".to_string()));
    if let Err(error) = killed {
        eprintln!(
            "[WARN] 未能结束 {} 下的远端 detached 终端，交由 daemon 超时回收：{error}",
            root.uri
        );
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_sftp_guard_includes_project_ancestors_and_file_components() {
        let components = super::windows_sftp_guard_components("/C:/Users/dev/project/file.txt");
        assert_eq!(
            components,
            vec![
                "/C:/",
                "/C:/Users",
                "/C:/Users/dev",
                "/C:/Users/dev/project",
                "/C:/Users/dev/project/file.txt"
            ]
        );
        assert_eq!(
            components,
            super::windows_sftp_guard_components(r"\\?\C:\Users\dev\project\file.txt")
        );
        assert!(super::windows_sftp_guard_components("/home/dev/project").is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires authorized QC_LIVE_* Windows SSH target and verified fingerprint"]
    async fn live_windows_sftp_reparse_points_cannot_escape_project() {
        use super::*;

        let required = |name: &str| std::env::var(name).expect(name);
        let config = SshConnectionConfig {
            id: format!("pathguard-{}", uuid::Uuid::new_v4()),
            host: required("QC_LIVE_HOST"),
            port: required("QC_LIVE_PORT").parse().unwrap(),
            username: required("QC_LIVE_USER"),
            auth_kind: "password".into(),
            password: Some(required("QC_LIVE_PASSWORD")),
            private_key_path: None,
            passphrase: None,
            host_key_fingerprint: Some(required("QC_LIVE_FINGERPRINT")),
            mode: Some(RemoteMode::Server),
        };
        let manager = SshManager::new();
        let transport = if let Ok(seconds) = std::env::var("QC_LIVE_DIAGNOSTIC_HANDSHAKE_SECS") {
            let seconds: u64 = seconds.parse().unwrap();
            assert!((20..=90).contains(&seconds));
            // Diagnostic connection acquisition only; production retains its 20s deadline.
            println!("LIVE_WINDOWS_DIAGNOSTIC_HANDSHAKE_SECONDS {seconds}");
            let (handle, disconnect_reason) =
                tokio::time::timeout(Duration::from_secs(seconds), async {
                    let (mut handle, _, disconnect_reason) = open_transport(
                        &config,
                        config.host_key_fingerprint.clone(),
                        ConnectionPurpose::Main,
                    )
                    .await?;
                    authenticate(&mut handle, &config).await?;
                    Ok::<_, String>((handle, disconnect_reason))
                })
                .await
                .expect("diagnostic SSH handshake exceeded its deadline")
                .unwrap();
            let transport = Arc::new(ConnectedSession {
                server_incarnation: Arc::new(()),
                handle,
                config: Mutex::new(config.clone()),
                sftp: tokio::sync::Mutex::new(None),
                disconnect_reason,
            });
            manager
                .sessions
                .write()
                .unwrap()
                .insert(config.id.clone(), Arc::clone(&transport));
            transport
        } else {
            store_authenticated_session(&manager, config.clone())
                .await
                .unwrap()
                .0
        };
        let sftp = manager.open_sftp(&config.id).await.unwrap();
        let base = join_remote_path(
            &required("QC_LIVE_PARENT"),
            &format!("qingcode-pathguard-{}", uuid::Uuid::new_v4()),
        );
        let project = join_remote_path(&base, "project");
        let outside = join_remote_path(&base, "outside");
        let link = join_remote_path(&project, "escape");
        let junction = join_remote_path(&project, "junction");
        let sentinel = join_remote_path(&outside, "sentinel.txt");
        let owned_marker = b"qingcode-owned-pathguard-sentinel";
        sftp.create_dir(base.clone()).await.unwrap();
        sftp.create_dir(project.clone()).await.unwrap();
        sftp.create_dir(outside.clone()).await.unwrap();
        write_remote_file_contents(&sftp, sentinel.clone(), owned_marker, true)
            .await
            .unwrap();
        let canonical_root = sftp.canonicalize(project.clone()).await.unwrap();
        let uri = format!("ssh://{}{canonical_root}", config.id);
        let root = RegisteredRoot {
            uri: uri.clone(),
            canonical_path: canonical_root,
            trusted: true,
        };
        manager
            .roots
            .write()
            .unwrap()
            .insert(uri.clone(), root.clone());

        let result = async {
            let normal = join_remote_path(&project, "ordinary-中文[1].txt");
            write_remote_file_contents(&sftp, normal.clone(), b"ordinary", true).await?;
            let cold_started = Instant::now();
            ensure_existing_path_within(&sftp, &project, &root).await?;
            let cold_ms = cold_started.elapsed().as_secs_f64() * 1000.0;
            let mut warm_ms = Vec::new();
            for _ in 0..20 {
                let started = Instant::now();
                ensure_existing_path_within(&sftp, &normal, &root).await?;
                if sftp.read(normal.clone()).await.map_err(|e| e.to_string())? != b"ordinary" { return Err("ordinary read failed".into()); }
                ensure_parent_path_within(&sftp, &normal, &root).await?;
                write_remote_file_contents(&sftp, normal.clone(), b"ordinary", false).await?;
                warm_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            warm_ms.sort_by(f64::total_cmp);
            println!("LIVE_WINDOWS_GUARD_PERFORMANCE {}", serde_json::json!({
                "cold_path_check_ms": cold_ms, "warm_guarded_read_write_iterations": warm_ms.len(),
                "warm_guarded_read_write_p50_ms": warm_ms[warm_ms.len()/2],
                "warm_guarded_read_write_p95_ms": warm_ms[(warm_ms.len()*95).div_ceil(100)-1],
                "warm_guarded_read_write_max_ms": warm_ms[warm_ms.len()-1],
                "warm_guarded_read_write_ms": warm_ms,
                "worker_starts": sftp.windows_guard.worker_starts(),
            }));
            sftp.symlink(outside.clone(), link.clone()).await.map_err(|e| e.to_string())?;
            let actual_link = sftp.canonicalize(link.clone()).await.map_err(|e| e.to_string())?;
            let link_metadata = sftp.symlink_metadata(link.clone()).await.map_err(|e| e.to_string())?;
            let link_target = sftp.read_link(link.clone()).await;
            let guard = ensure_existing_path_within(&sftp, &link, &root).await;
            let child_guard = ensure_existing_path_within(&sftp, &join_remote_path(&link, "sentinel.txt"), &root).await;
            let write_guard = ensure_parent_path_within(&sftp, &join_remote_path(&link, "rejected.txt"), &root).await;
            let raw_read = sftp.read(join_remote_path(&link, "sentinel.txt")).await.map_err(|e| e.to_string())?;
            assert_eq!(raw_read, owned_marker);
            println!("LIVE_WINDOWS_SYMLINK {}", serde_json::json!({
                "root": root.canonical_path, "link": link, "realpath": actual_link,
                "lstat_symlink": link_metadata.is_symlink(), "lstat_dir": link_metadata.is_dir(),
                "readlink": format!("{link_target:?}"), "own_outside_sentinel_reachable_via_raw_sftp": true,
                "guard_rejected": guard.is_err(), "child_guard_rejected": child_guard.is_err(),
                "write_guard_rejected": write_guard.is_err(),
            }));
            let native_link = windows_native_path(&link).ok_or("not a Windows fixture")?;
            let attributes = manager.exec_remote_shell(&uri, "false", &format!(
                "Get-Item -LiteralPath '{}' -Force | Select-Object FullName,Attributes,LinkType,Target | ConvertTo-Json -Compress",
                powershell_literal(&native_link)
            ), true, Duration::from_secs(10)).await?;
            println!("LIVE_WINDOWS_NTFS {}", attributes.stdout);
            let native_junction = windows_native_path(&junction).ok_or("invalid junction fixture")?;
            let native_outside = windows_native_path(&outside).ok_or("invalid outside fixture")?;
            let made = manager.exec_remote_shell(&uri, "false", &format!(
                "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",
                powershell_literal(&native_junction), powershell_literal(&native_outside)
            ), true, Duration::from_secs(10)).await?;
            if made.exit_code != 0 { return Err(format!("junction creation failed: {}", made.stderr)); }
            let junction_metadata = sftp.symlink_metadata(junction.clone()).await.map_err(|e| e.to_string())?;
            let junction_target = sftp.read_link(junction.clone()).await;
            let junction_guard = ensure_existing_path_within(&sftp, &junction, &root).await;
            let junction_child_guard = ensure_existing_path_within(&sftp, &join_remote_path(&junction, "sentinel.txt"), &root).await;
            let junction_write_guard = ensure_parent_path_within(&sftp, &join_remote_path(&junction, "rejected.txt"), &root).await;
            let linked_root = RegisteredRoot { uri: uri.clone(), canonical_path: junction.clone(), trusted: true };
            let linked_root_guard = ensure_existing_path_within(&sftp, &join_remote_path(&junction, "sentinel.txt"), &linked_root).await;
            let junction_raw_read = sftp.read(join_remote_path(&junction, "sentinel.txt")).await.map_err(|e| e.to_string())?;
            if junction_raw_read != owned_marker { return Err("junction fixture did not reach owned sentinel".into()); }
            let copied = join_remote_path(&base, "copy");
            let copy_guard = copy_remote_tree(&sftp, project.clone(), copied.clone(), &root).await;
            let copied_outside = sftp.try_exists(join_remote_path(&copied, "escape/sentinel.txt")).await.map_err(|e| e.to_string())?;
            // Ordinary files and directories must keep working through the strengthened guard.
            ensure_existing_path_within(&sftp, &normal, &root).await?;
            ensure_parent_path_within(&sftp, &join_remote_path(&project, "new.txt"), &root).await?;
            let nested_delete = remove_remote_tree(&sftp, join_remote_path(&junction, "sentinel.txt")).await;
            remove_remote_tree(&sftp, link.clone()).await?;
            remove_remote_tree(&sftp, junction.clone()).await?;
            let target_preserved = sftp.read(sentinel.clone()).await.map_err(|e| e.to_string())? == owned_marker;
            let links_removed = !sftp.try_exists(link.clone()).await.map_err(|e| e.to_string())?
                && !sftp.try_exists(junction.clone()).await.map_err(|e| e.to_string())?;
            println!("LIVE_WINDOWS_JUNCTION {}", serde_json::json!({
                "lstat_symlink": junction_metadata.is_symlink(),
                "readlink": format!("{junction_target:?}"),
                "guard_rejected": junction_guard.is_err(), "child_guard_rejected": junction_child_guard.is_err(),
                "write_guard_rejected": junction_write_guard.is_err(), "root_ancestor_link_rejected": linked_root_guard.is_err(),
                "ordinary_file_allowed": true, "recursive_copy_rejected": copy_guard.is_err(),
                "outside_sentinel_not_copied": !copied_outside,
                "one_metadata_worker_reused": sftp.windows_guard.worker_starts() == 1,
                "nested_delete_rejected": nested_delete.is_err(), "link_delete_target_preserved": target_preserved,
                "links_removed_without_recursion": links_removed,
            }));
            Ok::<_, String>(guard.is_err() && child_guard.is_err() && write_guard.is_err()
                && junction_guard.is_err() && junction_child_guard.is_err() && junction_write_guard.is_err()
                && linked_root_guard.is_err() && copy_guard.is_err() && !copied_outside
                && sftp.windows_guard.worker_starts() == 1 && nested_delete.is_err()
                && target_preserved && links_removed)
        }.await;

        if let Err(error) = &result {
            eprintln!("LIVE_WINDOWS_GUARD_FIRST_ERROR {error}");
        }

        // Remove the link itself before the dedicated base; never recurse through it.
        for reparse in [link, junction] {
            if sftp.remove_file(reparse.clone()).await.is_err() {
                let _ = sftp.remove_dir(reparse).await;
            }
        }
        let cleanup = remove_remote_tree(&sftp, base.clone()).await;
        if let Ok(previous) = std::env::var("QC_LIVE_CLEANUP_ROOT") {
            let parent = required("QC_LIVE_PARENT");
            assert_eq!(remote_parent_path(&previous).unwrap(), parent);
            let name = previous.rsplit('/').next().unwrap();
            uuid::Uuid::parse_str(
                name.strip_prefix("qingcode-live-")
                    .expect("not a live fixture"),
            )
            .unwrap();
            if sftp.try_exists(previous.clone()).await.unwrap() {
                remove_remote_tree(&sftp, previous).await.unwrap();
            }
            println!("LIVE_WINDOWS_PREVIOUS_FIXTURE_REMOVED true");
        }
        let worker_pid = sftp.windows_guard.worker_pid();
        let cached = transport.sftp.lock().await.take();
        drop(cached);
        let mut owned_sftp = match Arc::try_unwrap(sftp) {
            Ok(owned) => owned,
            Err(_) => panic!("test retained another SFTP wrapper reference"),
        };
        let guard = std::mem::take(&mut owned_sftp.windows_guard);
        std::thread::spawn(move || drop(guard))
            .join()
            .expect("guard Drop panicked without entered runtime");
        drop(owned_sftp);
        let worker_exit = if worker_pid > 0 {
            manager.exec_remote_shell(&uri, "false", &format!(
                "$p = Get-Process -Id {worker_pid} -ErrorAction SilentlyContinue; if ($p -and -not $p.WaitForExit(5000)) {{ [Console]::Write('alive') }} else {{ [Console]::Write('gone') }}"
            ), true, Duration::from_secs(10)).await
                .map(|output| output.exit_code == 0 && output.stdout == "gone")
        } else {
            Ok(false)
        };
        close_terminal_transport(&transport).await;
        println!(
            "LIVE_WINDOWS_GUARD_TEARDOWN {}",
            serde_json::json!({
                "drop_without_runtime_did_not_panic": true, "worker_pid": worker_pid,
                "worker_exited": worker_exit.as_ref().copied().unwrap_or(false),
            })
        );
        if let Err(error) = &cleanup {
            eprintln!("LIVE_WINDOWS_GUARD_CLEANUP_ERROR {error}");
        }
        cleanup.unwrap();
        assert!(
            result.unwrap(),
            "Windows SFTP reparse point escaped registered project root"
        );
        assert!(
            worker_exit.unwrap(),
            "metadata worker remained after guard teardown"
        );
    }

    #[tokio::test]
    async fn host_fingerprint_probe_times_out_on_silent_tcp_server_and_closes_socket() {
        use std::time::Duration;
        use tokio::io::AsyncReadExt;

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
                .await
                .expect("probe never connected to test server")
                .unwrap();
            // Deliberately withhold the server banner. Cancellation must close
            // the actual accepted socket, rather than leave a detached probe.
            let mut client_banner = Vec::new();
            tokio::time::timeout(
                Duration::from_secs(2),
                stream.read_to_end(&mut client_banner),
            )
            .await
            .expect("probe timeout did not close its TCP socket")
            .unwrap();
            assert!(client_banner.starts_with(b"SSH-2.0-"));
        });
        let mut config = sample_config(None);
        config.host = address.ip().to_string();
        config.port = address.port();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            super::probe_host_with_timeout(&config, Duration::from_millis(50)),
        )
        .await
        .expect("fingerprint probe exceeded its overall deadline");
        let error = result.unwrap_err();
        assert!(error.contains("SSH 主机指纹探测超时"), "{error}");
        assert!(error.contains(&address.to_string()), "{error}");
        server.await.unwrap();
    }

    #[test]
    fn connection_mode_deserializes_lowercase_and_defaults_to_none() {
        let with_mode: super::SshConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "c1", "host": "h", "username": "u", "mode": "ssh"
        }))
        .unwrap();
        assert_eq!(with_mode.mode, Some(super::RemoteMode::Ssh));
        let without: super::SshConnectionConfig =
            serde_json::from_value(serde_json::json!({ "id": "c1", "host": "h", "username": "u" }))
                .unwrap();
        assert_eq!(without.mode, None);
        assert!(
            serde_json::from_value::<super::SshConnectionConfig>(serde_json::json!({
                "id": "c1", "host": "h", "username": "u", "mode": "direct"
            }))
            .is_err()
        );
    }

    #[test]
    fn mode_conflict_only_when_roots_registered_under_other_mode() {
        use super::{mode_conflict, RemoteMode::*};
        assert!(mode_conflict(Some(Server), Ssh, true)
            .unwrap()
            .contains("连接模式已变更"));
        assert!(mode_conflict(Some(Ssh), Server, true).is_some());
        // 只用来浏览目录的会话（还没有根）可以在连接时定下模式。
        assert!(mode_conflict(Some(Server), Ssh, false).is_none());
        assert!(mode_conflict(None, Ssh, true).is_none());
        assert!(mode_conflict(Some(Ssh), Ssh, true).is_none());
    }

    #[test]
    fn remembered_config_keeps_mode_when_incoming_has_none() {
        use super::{merge_remembered_config, RemoteMode};
        let kept = merge_remembered_config(Some(RemoteMode::Server), sample_config(None));
        assert_eq!(kept.mode, Some(RemoteMode::Server));
        let mut incoming = sample_config(None);
        incoming.mode = Some(RemoteMode::Ssh);
        let replaced = merge_remembered_config(Some(RemoteMode::Server), incoming);
        assert_eq!(replaced.mode, Some(RemoteMode::Ssh));
    }

    #[test]
    fn server_mode_is_false_without_session() {
        let manager = super::SshManager::new();
        assert_eq!(manager.connection_mode("missing"), None);
        assert!(!manager.server_mode("missing"));
    }

    #[test]
    fn server_mode_errors_carry_prefix_once() {
        let wrapped = super::into_server_mode_error("远端 daemon 尚未就绪".to_string());
        assert!(wrapped.starts_with(super::server::SERVER_MODE_ERROR_PREFIX));
        // 已带前缀的错误不重复包装。
        assert_eq!(super::into_server_mode_error(wrapped.clone()), wrapped);
    }

    #[test]
    fn server_mode_task_launch_runs_invocation_with_sh() {
        let launch = super::persistent_task_launch("FOO='1' exec /bin/sh 'build.sh'", "构建");
        assert_eq!(launch.shell.as_deref(), Some("/bin/sh"));
        assert_eq!(
            launch.args,
            vec![
                "-c".to_string(),
                "FOO='1' exec /bin/sh 'build.sh'".to_string()
            ]
        );
        assert_eq!(launch.name.as_deref(), Some("构建"));
        assert_eq!(launch.resolved_shell, "sh");
    }

    #[test]
    fn terminal_pool_picks_first_transport_with_room() {
        assert_eq!(super::pick_terminal_transport([(10, 10), (3, 10)]), Some(1));
        assert_eq!(super::pick_terminal_transport([(10, 10), (4, 4)]), None);
        assert_eq!(super::pick_terminal_transport(std::iter::empty()), None);
    }

    #[test]
    fn main_terminal_fallback_and_commands_share_session_budget() {
        let manager = SshManager::new();
        let slots = manager.exec_slots("budget-test").unwrap();
        let mut terminals: Vec<_> = (0..TERMINAL_MAIN_FALLBACK_LIMIT)
            .map(|_| manager.try_main_fallback_slot("budget-test").unwrap())
            .collect();
        let commands: Vec<_> = (TERMINAL_MAIN_FALLBACK_LIMIT..MAX_CONCURRENT_EXEC_CHANNELS)
            .map(|_| Arc::clone(&slots).try_acquire_owned().unwrap())
            .collect();
        assert_eq!(slots.available_permits(), 0);
        assert!(manager.try_main_fallback_slot("budget-test").is_none());
        assert!(Arc::clone(&slots).try_acquire_owned().is_err());

        drop(terminals.pop());
        let replacement = Arc::clone(&slots).try_acquire_owned().unwrap();
        assert!(manager.try_main_fallback_slot("budget-test").is_none());
        drop((terminals, commands, replacement));
        assert_eq!(slots.available_permits(), MAX_CONCURRENT_EXEC_CHANNELS);
    }

    #[test]
    fn terminal_pool_refusal_learns_open_channel_count() {
        // 含本次被拒的租约：已开 3 个通道时 sshd 拒绝，实际上限就是 3。
        assert_eq!(super::observed_capacity_after_refusal(4), Some(3));
        // 一个通道都没开就被拒，不是会话数打满，不修正容量。
        assert_eq!(super::observed_capacity_after_refusal(1), None);
        assert_eq!(super::observed_capacity_after_refusal(0), None);
    }

    #[test]
    fn terminal_pool_capacity_follows_sshd_max_sessions() {
        let limit = |max_sessions, source| super::SshdSessionLimit {
            max_sessions,
            source,
        };
        use super::SshdSessionLimitSource::{Config, Default, Observed};
        assert_eq!(limit(20, Config).transport_capacity(), 20);
        assert_eq!(limit(10, Default).transport_capacity(), 10);
        // MaxSessions 0/1 无法复用连接，退化为每个终端一条连接。
        assert_eq!(limit(0, Config).transport_capacity(), 1);
        assert_eq!(limit(1, Observed).transport_capacity(), 1);
    }

    #[test]
    fn terminal_pool_full_notice_names_count_and_source() {
        let notice = super::terminal_pool_full_notice(
            2,
            super::SshdSessionLimit {
                max_sessions: 10,
                source: super::SshdSessionLimitSource::Config,
            },
        );
        assert!(notice.contains("已有 2 条"));
        assert!(notice.contains("每条连接最多 10 个终端"));
        assert!(notice.contains("MaxSessions"));
        assert!(notice.contains("第 3 条"));
    }

    use super::*;

    #[test]
    fn profile_terminal_name_prefers_tab_name_over_terminal_id() {
        assert_eq!(
            profile_terminal_name(Some(" OpenCode "), "uuid-1"),
            "OpenCode"
        );
        assert_eq!(profile_terminal_name(Some("  "), "uuid-1"), "uuid-1");
        assert_eq!(profile_terminal_name(None, "uuid-1"), "uuid-1");
    }

    #[test]
    fn image_read_limit_stays_at_64mb_like_the_local_viewer() {
        // 本地 `cmd_stat::IMAGE_MAX_BYTES` 以同值字面量独立断言；两侧一起防漂移。
        assert_eq!(IMAGE_MAX_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn workspace_download_policies_do_not_overwrite_each_other_or_global_defaults() {
        let manager = SshManager::new();
        let automatic =
            std::env::temp_dir().join(format!("qingcode-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&automatic).unwrap();
        manager.set_server_binary_dirs(vec![automatic.clone()]);
        manager.workspace_server_settings.write().unwrap().extend([
            (
                "ssh://c/a".into(),
                WorkspaceServerSettings {
                    auto_download: false,
                    offline_dir: Some(PathBuf::from("offline-a")),
                },
            ),
            (
                "ssh://c/b".into(),
                WorkspaceServerSettings {
                    auto_download: true,
                    offline_dir: None,
                },
            ),
        ]);
        assert_eq!(
            manager.server_binary_dirs_for_root("ssh://c/a/"),
            vec![PathBuf::from("offline-a"), automatic.clone()]
        );
        assert_eq!(
            manager.server_binary_dirs_for_root("ssh://c/b"),
            vec![automatic.clone()]
        );
        assert!(!manager.server_auto_download_for_root("ssh://c/a"));
        assert!(manager.server_auto_download_for_root("ssh://c/b"));
        assert!(manager.server_auto_download());
        assert_eq!(manager.server_binary_dirs(), vec![automatic.clone()]);
        std::fs::remove_dir(automatic).unwrap();
    }

    #[test]
    fn workspace_download_policy_rejects_remote_paths_and_accepts_empty_offline_override() {
        for path in [
            "ssh://host/home/server",
            "https://example.test/server",
            "bad\0path",
        ] {
            assert!(WorkspaceServerSettings {
                auto_download: false,
                offline_dir: Some(PathBuf::from(path))
            }
            .validated()
            .is_err());
        }
        let settings: WorkspaceServerSettings =
            serde_json::from_value(serde_json::json!({"autoDownload":false,"offlineDir":""}))
                .unwrap();
        assert_eq!(
            settings.validated().unwrap(),
            WorkspaceServerSettings {
                auto_download: false,
                offline_dir: None
            }
        );
    }

    #[test]
    fn passive_registration_remains_passive_across_trust_changes() {
        let manager = SshManager::new();
        manager
            .passive_roots
            .write()
            .unwrap()
            .insert("ssh://c/a".into());
        manager.roots.write().unwrap().insert(
            "ssh://c/a".into(),
            RegisteredRoot {
                uri: "ssh://c/a".into(),
                canonical_path: "/a".into(),
                trusted: true,
            },
        );
        manager.set_root_trust("ssh://c/a", false).unwrap();
        manager.set_root_trust("ssh://c/a", true).unwrap();
        assert!(manager.root_is_passive("ssh://c/a/"));
        assert!(!manager.root_is_passive("ssh://c/other"));
        assert!(manager.watch_supervisors.lock().unwrap().is_empty());
    }

    #[test]
    fn offline_dir_is_searched_before_other_server_dirs() {
        let manager = SshManager::new();
        let root =
            std::env::temp_dir().join(format!("qingcode-offline-order-{}", std::process::id()));
        let offline = root.join("picked");
        let other = root.join("bundled");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&offline).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        manager.set_server_binary_dirs(vec![other.clone(), offline.clone()]);
        manager.set_server_offline_dir(Some(offline.clone()));
        let dirs = manager.server_binary_dirs();
        assert_eq!(dirs.first(), Some(&offline));
        assert_eq!(dirs.iter().filter(|dir| *dir == &offline).count(), 1);
        manager.set_server_offline_dir(None);
        assert_eq!(manager.server_binary_dirs().first(), Some(&other));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn closed_flag_stream_marks_eof_but_not_data() {
        let (client, mut server) = tokio::io::duplex(64);
        let health = Arc::new(SftpHealth::new());
        let mut stream = ClosedFlagStream {
            inner: client,
            health: Arc::clone(&health),
        };
        server.write_all(b"ok").await.unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(stream.read(&mut buf).await.unwrap(), 2);
        assert!(!health.is_unusable(Duration::from_secs(3600)));
        drop(server);
        assert_eq!(stream.read(&mut buf).await.unwrap(), 0);
        assert!(health.is_unusable(Duration::from_secs(3600)));
    }

    #[tokio::test]
    async fn sftp_health_flags_requests_left_unanswered() {
        let (client, mut server) = tokio::io::duplex(64);
        let health = Arc::new(SftpHealth::new());
        let mut stream = ClosedFlagStream {
            inner: client,
            health: Arc::clone(&health),
        };
        // 空闲会话不算僵死，无论空闲多久。
        assert!(!health.is_unusable(Duration::ZERO));

        stream.write_all(b"req").await.unwrap();
        assert!(health.is_unusable(Duration::ZERO));
        assert!(!health.is_unusable(Duration::from_secs(3600)));

        // 收到回包后不再有未答请求。
        server.write_all(b"resp").await.unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(stream.read(&mut buf).await.unwrap(), 4);
        assert!(!health.is_unusable(Duration::ZERO));
    }

    #[test]
    fn remote_git_network_commands_get_a_longer_timeout() {
        let args = |name: &str| vec![name.to_string(), "origin".to_string()];
        assert_eq!(
            remote_git_timeout(&args("fetch")),
            REMOTE_NETWORK_EXEC_TIMEOUT
        );
        assert_eq!(
            remote_git_timeout(&args("push")),
            REMOTE_NETWORK_EXEC_TIMEOUT
        );
        assert_eq!(remote_git_timeout(&args("status")), REMOTE_EXEC_TIMEOUT);
        assert_eq!(remote_git_timeout(&[]), REMOTE_EXEC_TIMEOUT);
    }

    #[test]
    fn entries_share_prefix_detects_a_stale_cached_prefix() {
        let entries = vec![("apps/web/a.ts".to_string(), " M".to_string())];
        assert!(entries_share_prefix(&entries, ""));
        assert!(entries_share_prefix(&entries, "apps/web/"));
        assert!(!entries_share_prefix(&entries, "apps/api/"));
        assert!(entries_share_prefix(&[], "apps/api/"));
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
            mode: None,
        }
    }

    #[test]
    fn live_session_config_rejects_identity_and_credential_changes() {
        let original = sample_config(Some("/keys/one"));
        let mut requested = original.clone();
        requested.host = "LOCALHOST".into();
        assert!(require_matching_session_config(&original, &requested).is_err());
        requested = original.clone();
        requested.password = Some("wrong-password".into());
        assert!(require_matching_session_config(&original, &requested).is_err());
        requested = original.clone();
        requested.host_key_fingerprint = Some("SHA256:other-host".into());
        assert!(require_matching_session_config(&original, &requested).is_err());
        requested = original.clone();
        requested.mode = Some(RemoteMode::Server);
        assert!(require_matching_session_config(&original, &requested).is_ok());
        assert_eq!(original.host, "127.0.0.1");
        assert!(original.password.is_none());
    }

    #[test]
    fn pausing_one_project_preserves_other_shared_daemon_bindings() {
        let manager = SshManager::new();
        let daemon = server::DaemonAccess {
            bin: "/home/u/server".into(),
            token: "shared".into(),
        };
        for key in ["one|/srv/a", "two|/srv/b"] {
            manager.set_server_slot(
                key,
                server::ServerSlot {
                    endpoint: Some(server::ServerEndpoint {
                        serve: None,
                        daemon: Some(daemon.clone()),
                    }),
                    ..Default::default()
                },
            );
        }
        manager.pause_project_server("one|/srv/a");
        let stopped = manager.server_slot("one|/srv/a").unwrap();
        assert!(stopped.endpoint.is_none());
        assert!(stopped.unavailable_reason.is_some());
        let other = manager.server_slot("two|/srv/b").unwrap().endpoint.unwrap();
        assert!(other.daemon.as_ref() == Some(&daemon));
        manager.clear_server_endpoint("one|/srv/a");
        assert!(manager
            .server_slot("one|/srv/a")
            .unwrap()
            .unavailable_reason
            .is_none());
    }

    #[test]
    fn cancelling_a_watch_incarnation_cannot_revive_when_its_root_is_retrusted() {
        let manager = SshManager::new();
        let old = manager.begin_watch_supervisor("one|/srv/a");
        manager.stop_watch_supervisor("one|/srv/a");
        assert!(old.load(Ordering::Acquire));
        let replacement = manager.begin_watch_supervisor("one|/srv/a");
        assert!(old.load(Ordering::Acquire));
        assert!(!replacement.load(Ordering::Acquire));
        let third = manager.begin_watch_supervisor("one|/srv/a");
        assert!(replacement.load(Ordering::Acquire));
        assert!(!third.load(Ordering::Acquire));
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
    fn daemon_client_id_combines_install_uuid_and_connection() {
        let manager = SshManager::new();
        manager.set_client_id("8f2af0e7-7a7e-4af0-9f67-2bc588c9146e".to_string());
        assert_eq!(
            manager.daemon_client_id("remote-a"),
            "8f2af0e7-7a7e-4af0-9f67-2bc588c9146e:remote-a"
        );
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
    fn roots_for_connection_filters_by_connection_id() {
        let manager = SshManager::new();
        for (key, uri) in [
            ("wsl-app", "ssh://wsl/home/app"),
            ("wsl-docs", "ssh://wsl/home/docs"),
            ("win-app", "ssh://w1n/D:/code/app"),
        ] {
            manager.roots.write().unwrap().insert(
                key.to_string(),
                RegisteredRoot {
                    uri: uri.to_string(),
                    canonical_path: uri
                        .trim_start_matches("ssh://")
                        .split_once('/')
                        .map(|(_, path)| format!("/{path}"))
                        .unwrap_or_else(|| "/".to_string()),
                    trusted: key != "wsl-docs",
                },
            );
        }
        let roots = manager.roots_for_connection("wsl");
        assert_eq!(roots.len(), 2);
        assert!(roots.iter().all(|root| root.uri.starts_with("ssh://wsl/")));
        assert!(manager.roots_for_connection("missing").is_empty());
    }

    #[test]
    fn ssh_workspace_root_serializes_camel_case() {
        let root = SshWorkspaceRoot {
            root_uri: "ssh://wsl/home/app".to_string(),
            trusted: true,
        };
        let value = serde_json::to_value(&root).unwrap();
        assert_eq!(value["rootUri"], "ssh://wsl/home/app");
        assert_eq!(value["trusted"], true);
        assert!(value.get("root_uri").is_none());
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
        assert_eq!(
            windows_native_path(r"\\?\D:\code\nem-panel").as_deref(),
            Some(r"D:\code\nem-panel")
        );
        assert_eq!(
            windows_native_path("//?/D:/code/nem-panel").as_deref(),
            Some(r"D:\code\nem-panel")
        );
        assert_eq!(windows_native_path("/C:").as_deref(), Some(r"C:\"));
        assert!(windows_native_path("/home/owner/app").is_none());
        assert!(windows_native_path(r"D:code\relative").is_none());
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
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect::<Vec<_>>();
        String::from_utf16(&utf16).unwrap()
    }

    #[test]
    fn windows_terminal_starts_powershell_in_project() {
        let quoted = ssh_interactive_terminal_command("/D:/code/it's", Some("powershell")).unwrap();
        assert_eq!(
            decoded_script(&quoted.command, "powershell.exe -NoLogo -NoExit"),
            format!(
                "{}; Set-Location -LiteralPath 'D:\\code\\it''s'",
                WINDOWS_POWERSHELL_UTF8_SETUP
            )
        );
        assert!(quoted.command.starts_with('"') && quoted.command.ends_with('"'));
        assert!(quoted.enter_directory.is_none());

        let command = ssh_interactive_terminal_command("/D:/code/nem-panel", None).unwrap();
        assert_eq!(
            decoded_script(&command.command, "powershell.exe -NoLogo -NoExit"),
            format!(
                "{}; Set-Location -LiteralPath 'D:\\code\\nem-panel'",
                WINDOWS_POWERSHELL_UTF8_SETUP
            ),
        );
        assert!(command.enter_directory.is_none());
        assert_eq!(command.resolved_shell, "powershell");
        assert_eq!(command.fallback_from, None);

        let cmd_launcher = "powershell.exe -NoLogo -NoProfile -NonInteractive";
        let cmd_target =
            ssh_interactive_terminal_command("/D:/code/my project", Some("cmd")).unwrap();
        assert_eq!(
            decoded_script(&cmd_target.command, cmd_launcher),
            r"$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath 'D:\code\my project'; & cmd.exe /K 'chcp 65001>nul'; exit $LASTEXITCODE"
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
            format!(
                "{}; Set-Location -LiteralPath 'D:\\code\\nem-panel'",
                WINDOWS_POWERSHELL_UTF8_SETUP
            ),
        );
        assert!(pwsh_target.enter_directory.is_none());
        assert_eq!(pwsh_target.resolved_shell, "pwsh");

        let fallback =
            ssh_interactive_terminal_command("/D:/code/nem-panel", Some("bash")).unwrap();
        assert_eq!(
            decoded_script(&fallback.command, "powershell.exe -NoLogo -NoExit"),
            format!(
                "{}; Set-Location -LiteralPath 'D:\\code\\nem-panel'",
                WINDOWS_POWERSHELL_UTF8_SETUP
            ),
        );
        assert!(fallback.enter_directory.is_none());
        assert_eq!(fallback.resolved_shell, "powershell");
        assert_eq!(fallback.fallback_from, Some("bash".to_string()));

        assert!(ssh_interactive_terminal_command("/D:/code/a\nb", None).is_err());
        assert!(reject_windows_remote_command("/D:/code/nem-panel").is_err());
    }

    #[test]
    fn persistent_windows_shell_forces_utf8_console_and_file_reading() {
        // `cat` 是 Get-Content 的别名；只设置控制台编码不够，必须固定文件读取编码。
        assert!(WINDOWS_POWERSHELL_UTF8_SETUP.contains("Get-Content:Encoding"));
        assert!(WINDOWS_CMD_UTF8_SETUP.contains("65001"));

        let powershell = persistent_shell_launch("/D:/code/app", None).unwrap();
        assert_eq!(powershell.shell.as_deref(), Some("powershell"));
        assert_eq!(
            powershell.args,
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                WINDOWS_POWERSHELL_UTF8_SETUP.to_string(),
            ]
        );

        let cmd = persistent_shell_launch("/D:/code/app", Some("cmd")).unwrap();
        assert_eq!(cmd.shell.as_deref(), Some("cmd"));
        assert_eq!(
            cmd.args,
            vec!["/K".to_string(), WINDOWS_CMD_UTF8_SETUP.to_string()]
        );

        let profile = persistent_profile_launch(
            "/D:/code/app",
            "opencode",
            &HashMap::new(),
            Some("powershell"),
            "OpenCode",
        )
        .unwrap();
        assert_eq!(profile.name.as_deref(), Some("OpenCode"));
        assert!(profile.args[3].starts_with(WINDOWS_POWERSHELL_UTF8_SETUP));
        assert!(profile.args[3].ends_with("; opencode"));

        let unix = persistent_shell_launch("/srv/app", Some("bash")).unwrap();
        assert!(unix.args.is_empty());
    }

    #[test]
    fn windows_profile_direct_fallback_sets_cwd_env_and_command() {
        let env = HashMap::from([("OPENCODE_MODE".to_string(), "dev".to_string())]);
        let powershell = direct_windows_profile_command(
            "/D:/code/my project",
            "opencode --watch",
            &env,
            Some("powershell"),
        )
        .unwrap();
        let script = decoded_script(&powershell, "powershell.exe -NoLogo -NoExit");
        assert!(script.contains(WINDOWS_POWERSHELL_UTF8_SETUP));
        assert!(script.contains(r"$env:OPENCODE_MODE = 'dev'"));
        assert!(script.contains(r"Set-Location -LiteralPath 'D:\code\my project'"));
        assert!(script.ends_with("opencode --watch"));

        let cmd = direct_windows_profile_command(
            "/D:/code/my project",
            "opencode --watch",
            &HashMap::new(),
            Some("cmd"),
        )
        .unwrap();
        let script = decoded_script(&cmd, "powershell.exe -NoLogo -NoProfile -NonInteractive");
        assert!(script.contains(r"& cmd.exe /K 'chcp 65001>nul & opencode --watch'"));
    }

    #[test]
    fn disconnect_reason_explains_keepalive_timeout_and_remote_close() {
        let keepalive = describe_disconnect(
            &client::DisconnectReason::Error(russh::Error::KeepaliveTimeout),
            keepalive_window(ConnectionPurpose::Main),
        );
        assert!(keepalive.starts_with("保活超时"));
        assert!(keepalive.contains("40 秒"));
        let terminal_keepalive = describe_disconnect(
            &client::DisconnectReason::Error(russh::Error::KeepaliveTimeout),
            keepalive_window(ConnectionPurpose::Terminal),
        );
        assert!(terminal_keepalive.starts_with("保活超时"));
        assert!(terminal_keepalive.contains("75 秒"));
        let remote = describe_disconnect(
            &client::DisconnectReason::ReceivedDisconnect(client::RemoteDisconnectInfo {
                reason_code: russh::Disconnect::ByApplication,
                message: " sshd restarting ".to_string(),
                lang_tag: String::new(),
            }),
            keepalive_window(ConnectionPurpose::Main),
        );
        assert!(remote.starts_with("远端主动断开"));
        assert!(remote.ends_with("sshd restarting"));
        let io = describe_disconnect(
            &client::DisconnectReason::Error(russh::Error::HUP),
            keepalive_window(ConnectionPurpose::Main),
        );
        assert!(io.starts_with("连接异常断开"));
    }

    #[test]
    fn ssh_client_waits_through_a_slow_keepalive_reply() {
        let main = ssh_client_config(ConnectionPurpose::Main);
        assert!(main.inactivity_timeout.is_none());
        assert_eq!(main.keepalive_interval, Some(Duration::from_secs(10)));
        assert_eq!(main.keepalive_max, 3);
        assert!(main.nodelay);

        let terminal = ssh_client_config(ConnectionPurpose::Terminal);
        assert!(terminal.inactivity_timeout.is_none());
        assert_eq!(terminal.keepalive_interval, Some(Duration::from_secs(15)));
        assert_eq!(terminal.keepalive_max, 4);
        assert!(terminal.nodelay);
    }

    #[test]
    fn terminal_exit_payload_serializes_reason_only_when_present() {
        let disconnected = serde_json::to_value(TerminalExitPayload {
            id: "terminal-1".to_string(),
            exit_code: 1,
            disconnected: true,
            reason: Some("保活超时：约 75 秒未收到远端任何回包".to_string()),
        })
        .unwrap();
        assert_eq!(
            disconnected.get("reason").and_then(|value| value.as_str()),
            Some("保活超时：约 75 秒未收到远端任何回包")
        );

        let completed = serde_json::to_value(TerminalExitPayload {
            id: "terminal-1".to_string(),
            exit_code: 0,
            disconnected: false,
            reason: None,
        })
        .unwrap();
        assert!(completed.get("reason").is_none());
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
    fn linux_session_capacity_refusal_retries_without_treating_transport_as_stale() {
        let capacity =
            russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited);
        assert!(is_session_channel_refusal(&capacity));
        assert!(!is_stale_russh_error(&capacity));
        assert!(is_session_channel_refusal(
            &russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed,)
        ));
        assert!(!is_session_channel_refusal(
            &russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::UnknownChannelType,)
        ));
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

    #[test]
    fn collect_scan_nodes_orders_dirs_first_and_applies_excludes() {
        let entries = vec![
            ("zeta.ts".to_string(), false),
            ("src".to_string(), true),
            ("target".to_string(), true),
            ("alpha.md".to_string(), false),
        ];
        let nodes = collect_scan_nodes("ssh://c1", "/srv/app", "/srv/app", entries, None);
        let names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
        // 目录优先（排序），其次文件（排序）；默认硬忽略目录被剔除。
        assert_eq!(names, vec!["src", "alpha.md", "zeta.ts"]);
        assert!(nodes.iter().all(|node| node.path.starts_with("ssh://c1/")));
    }

    #[test]
    fn collect_scan_nodes_honors_exclude_patterns() {
        let entries = vec![
            ("keep.rs".to_string(), false),
            ("skip.rs".to_string(), false),
            ("sub".to_string(), true),
            ("other".to_string(), true),
        ];
        let patterns = vec!["skip.rs".to_string()];
        let nodes =
            collect_scan_nodes("ssh://c1", "/srv/app", "/srv/app", entries, Some(&patterns));
        // 目录优先（排序），被排除的 skip.rs 不出现。
        let names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, vec!["other", "sub", "keep.rs"]);
    }

    #[test]
    fn collect_scan_nodes_matches_excludes_against_path_relative_to_root() {
        let entries = vec![("mod.rs".to_string(), false), ("nested".to_string(), true)];
        // 排除规则按「相对项目根」匹配：扫描子目录时 src/nested 仍能被命中。
        let patterns = vec!["src/nested".to_string()];
        let nodes = collect_scan_nodes(
            "ssh://c1",
            "/srv/app/src",
            "/srv/app",
            entries,
            Some(&patterns),
        );
        let names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, vec!["mod.rs"]);
        assert_eq!(nodes[0].path, "ssh://c1/mod.rs");
    }

    #[test]
    fn relative_to_root_handles_root_and_children() {
        assert_eq!(remote_relative_to_root("/srv/app", "/srv/app"), "");
        assert_eq!(remote_relative_to_root("/srv/app/src", "/srv/app"), "src");
        assert_eq!(remote_relative_to_root("/srv/app/", "/srv/app/"), "");
    }
}
