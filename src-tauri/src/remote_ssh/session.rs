//! SSH 会话底层设施：russh 客户端、SFTP 会话与健康探测、通道打开与重试、
//! 连接超时常量，以及 server 模式终端的传输池与租约。

use super::*;

#[derive(Clone)]
pub(super) struct SshClient {
    pub(super) expected_fingerprint: Option<String>,
    pub(super) observed_fingerprint: Arc<Mutex<Option<String>>>,
    /// 连接结束的原因（远端 DISCONNECT 或传输错误），供状态芯片展示和排查断线。
    pub(super) disconnect_reason: Arc<Mutex<Option<String>>>,
    pub(super) keepalive_window: Duration,
}

/// 把 russh 的断开原因转成用户可读文本。保活超时单独说明判定口径，
/// 便于区分「网络/远端无响应」与「远端主动断开」。
pub(super) fn describe_disconnect(
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

pub(super) struct ConnectedSession {
    /// Distinguishes authenticated SSH incarnations, including reconnects.
    pub(super) server_incarnation: Arc<()>,
    pub(super) handle: client::Handle<SshClient>,
    pub(super) config: Mutex<SshConnectionConfig>,
    /// 整条连接共用一个 SFTP 会话，请求在其中多路复用。每次操作都新开通道时，
    /// Windows OpenSSH 要为每次请求启动一个 sftp-server 进程，远端一卡就超时。
    pub(super) sftp: tokio::sync::Mutex<Option<CachedSftp>>,
    /// 与 [`SshClient::disconnect_reason`] 共享：传输结束后记录原因。
    pub(super) disconnect_reason: Arc<Mutex<Option<String>>>,
}

impl ConnectedSession {
    /// 连接已关闭时的断开原因；仍在线或原因未知返回 `None`。
    pub(super) fn closed_reason(&self) -> Option<String> {
        if !self.handle.is_closed() {
            return None;
        }
        self.disconnect_reason
            .lock()
            .ok()
            .and_then(|reason| reason.clone())
    }
}

pub(super) struct CachedSftp {
    pub(super) sftp: Arc<SftpSession>,
    pub(super) health: Arc<SftpHealth>,
}

/// Keep Windows physical-path metadata on the same authenticated connection.
/// The weak reference avoids a cycle through ConnectedSession's SFTP cache.
pub(super) struct SftpSession {
    pub(super) inner: Option<RawSftpSession>,
    pub(super) direct: Option<direct_fs::DirectFs>,
    pub(super) transport: std::sync::Weak<ConnectedSession>,
    pub(super) windows_guard: windows_path_guard::WindowsPathGuard,
}

impl SftpSession {
    pub(super) fn direct(
        config: direct::DirectConnectionConfig,
        root: Option<String>,
        trusted: bool,
    ) -> Self {
        Self {
            inner: None,
            direct: Some(direct_fs::DirectFs::new(config, root, trusted)),
            transport: std::sync::Weak::new(),
            windows_guard: windows_path_guard::WindowsPathGuard::default(),
        }
    }

    pub(super) async fn canonicalize(
        &self,
        path: impl Into<String>,
    ) -> Result<String, russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct.canonicalize(path).await
        } else {
            self.inner.as_ref().unwrap().canonicalize(path).await
        }
    }
    pub(super) async fn metadata(
        &self,
        path: impl Into<String>,
    ) -> Result<russh_sftp::protocol::FileAttributes, russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct.metadata(path, false).await
        } else {
            self.inner.as_ref().unwrap().metadata(path).await
        }
    }
    pub(super) async fn symlink_metadata(
        &self,
        path: impl Into<String>,
    ) -> Result<russh_sftp::protocol::FileAttributes, russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct.metadata(path, true).await
        } else {
            self.inner.as_ref().unwrap().symlink_metadata(path).await
        }
    }
    pub(super) async fn try_exists(
        &self,
        path: impl Into<String>,
    ) -> Result<bool, russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct.exists(path).await
        } else {
            self.inner.as_ref().unwrap().try_exists(path).await
        }
    }
    #[cfg(test)]
    pub(super) async fn read_link(
        &self,
        path: impl Into<String>,
    ) -> Result<String, russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct.read_link(path).await
        } else {
            self.inner.as_ref().unwrap().read_link(path).await
        }
    }
    pub(super) async fn read_dir(
        &self,
        path: impl Into<String>,
    ) -> Result<std::vec::IntoIter<direct_fs::RemoteDirEntry>, russh_sftp::client::error::Error>
    {
        let path = path.into();
        let entries = if let Some(direct) = &self.direct {
            direct.read_dir(path).await?
        } else {
            self.inner
                .as_ref()
                .unwrap()
                .read_dir(path)
                .await?
                .map(direct_fs::RemoteDirEntry::from_sftp)
                .collect()
        };
        Ok(entries.into_iter())
    }
    pub(super) async fn open(
        &self,
        path: impl Into<String>,
    ) -> Result<direct_fs::RemoteFile, russh_sftp::client::error::Error> {
        let path = path.into();
        self.open_with_flags(path, OpenFlags::READ).await
    }
    #[cfg(test)]
    pub(super) async fn create(
        &self,
        path: impl Into<String>,
    ) -> Result<direct_fs::RemoteFile, russh_sftp::client::error::Error> {
        self.open_with_flags(
            path,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
    }
    pub(super) async fn open_with_flags(
        &self,
        path: impl Into<String>,
        flags: OpenFlags,
    ) -> Result<direct_fs::RemoteFile, russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct.open(path, flags).await
        } else {
            self.inner
                .as_ref()
                .unwrap()
                .open_with_flags(path, flags)
                .await
                .map(|file| direct_fs::RemoteFile::Ssh(Box::new(file)))
        }
    }
    pub(super) async fn read(
        &self,
        path: impl Into<String>,
    ) -> Result<Vec<u8>, russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct.read(path).await
        } else {
            self.inner.as_ref().unwrap().read(path).await
        }
    }
    pub(super) async fn create_dir(
        &self,
        path: impl Into<String>,
    ) -> Result<(), russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct
                .simple("create_dir", serde_json::json!({"path":path}))
                .await
        } else {
            self.inner.as_ref().unwrap().create_dir(path).await
        }
    }
    pub(super) async fn remove_dir(
        &self,
        path: impl Into<String>,
    ) -> Result<(), russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct
                .simple("remove_dir", serde_json::json!({"path":path}))
                .await
        } else {
            self.inner.as_ref().unwrap().remove_dir(path).await
        }
    }
    pub(super) async fn remove_file(
        &self,
        path: impl Into<String>,
    ) -> Result<(), russh_sftp::client::error::Error> {
        let path = path.into();
        if let Some(direct) = &self.direct {
            direct
                .simple("remove_file", serde_json::json!({"path":path}))
                .await
        } else {
            self.inner.as_ref().unwrap().remove_file(path).await
        }
    }
    pub(super) async fn rename(
        &self,
        path: String,
        new_path: String,
    ) -> Result<(), russh_sftp::client::error::Error> {
        if let Some(direct) = &self.direct {
            direct
                .simple(
                    "rename",
                    serde_json::json!({"path":path,"newPath":new_path}),
                )
                .await
        } else {
            self.inner.as_ref().unwrap().rename(path, new_path).await
        }
    }
    #[cfg(test)]
    pub(super) async fn symlink(
        &self,
        path: String,
        target: String,
    ) -> Result<(), russh_sftp::client::error::Error> {
        if let Some(direct) = &self.direct {
            direct
                .simple("symlink", serde_json::json!({"path":target,"target":path}))
                .await
        } else {
            self.inner.as_ref().unwrap().symlink(path, target).await
        }
    }
    pub(super) async fn set_metadata(
        &self,
        path: String,
        attrs: russh_sftp::protocol::FileAttributes,
    ) -> Result<(), russh_sftp::client::error::Error> {
        if let Some(direct) = &self.direct {
            direct.set_metadata(path, attrs).await
        } else {
            self.inner.as_ref().unwrap().set_metadata(path, attrs).await
        }
    }
}

/// 缓存 SFTP 会话的健康状态，由通道流在读写时更新。
pub(super) struct SftpHealth {
    pub(super) closed: AtomicBool,
    pub(super) started: Instant,
    /// 上次读到回包之后第一条请求写出的时间（相对 `started` 的毫秒数 + 1）；0 表示没有未答请求。
    pub(super) unanswered_since_ms: AtomicU64,
}

impl SftpHealth {
    pub(super) fn new() -> Self {
        Self {
            closed: AtomicBool::new(false),
            started: Instant::now(),
            unanswered_since_ms: AtomicU64::new(0),
        }
    }

    pub(super) fn now_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis())
            .unwrap_or(u64::MAX)
            .saturating_add(1)
    }

    pub(super) fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
    }

    pub(super) fn note_write(&self) {
        let _ = self.unanswered_since_ms.compare_exchange(
            0,
            self.now_ms(),
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub(super) fn note_read(&self) {
        self.unanswered_since_ms.store(0, Ordering::Release);
    }

    /// 已关闭，或请求写出后 `stall` 内一直没有任何回包：通道多半已僵死，不再复用。
    pub(super) fn is_unusable(&self, stall: Duration) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return true;
        }
        let since = self.unanswered_since_ms.load(Ordering::Acquire);
        let stall_ms = u64::try_from(stall.as_millis()).unwrap_or(u64::MAX);
        since != 0 && self.now_ms().saturating_sub(since) >= stall_ms
    }
}

/// 包住 SFTP 通道流：读到 EOF 或读写出错时标记关闭，并记录请求 / 回包时间用于判断僵死。
pub(super) struct ClosedFlagStream<S> {
    pub(super) inner: S,
    pub(super) health: Arc<SftpHealth>,
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
pub(super) struct ChannelOpenError {
    pub(super) message: String,
    pub(super) stale: bool,
}

impl From<ChannelOpenError> for String {
    fn from(error: ChannelOpenError) -> Self {
        error.message
    }
}

/// 按 russh 错误类型判断连接是否失效；在已关闭的连接上开通道得到的是
/// `SendError` / `Disconnect`，而 keepalive 超时只会出现在后台连接任务里。
pub(super) fn is_stale_russh_error(error: &russh::Error) -> bool {
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
pub(super) const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// 会话已半死时 `channel_open_session` 也不会返回；超时后探测一次再决定是否重连。
pub(super) const SSH_CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const CHANNEL_OPEN_TIMEOUT_MARKER: &str = "通道超时";
/// 远端拒绝开通道（多为 MaxSessions 打满）时错误信息里的固定片段。
pub(super) const CHANNEL_REFUSED_MARKER: &str = "远端拒绝打开新通道";

pub(super) fn is_channel_refused_error(message: &str) -> bool {
    message.contains(CHANNEL_REFUSED_MARKER)
}
/// OpenSSH Linux 会以 AdministrativelyProhibited 表示 MaxSessions 打满，
/// Windows 等实现也可能返回 ConnectFailed。两者都允许有限退避，不把
/// AdministrativelyProhibited 当成连接失效去重建整条主连接。
pub(super) fn is_session_channel_refusal(error: &russh::Error) -> bool {
    matches!(
        error,
        russh::Error::ChannelOpenFailure(
            russh::ChannelOpenFailure::ConnectFailed
                | russh::ChannelOpenFailure::AdministrativelyProhibited
        )
    )
}

/// 远端拒绝开通道时的重试次数，共约 3 秒。
pub(super) const CHANNEL_OPEN_RETRIES: u32 = 5;
/// sshd 默认每条连接最多 10 个会话；主连接预留 1 个 SFTP、Windows 的 1 个路径校验
/// 和最多 6 个命令/主连接回退终端，留余量给 watch / scan 与重试。超出的命令排队。
pub(super) const MAX_CONCURRENT_EXEC_CHANNELS: usize = 6;
/// 终端各用独立连接；sshd 的 MaxStartups 默认 10:30:100，未认证连接到 10 个起会被随机拒绝，
/// 同时握手留在 6 个以内，给其它客户端留余量。
pub(super) const MAX_CONCURRENT_TERMINAL_HANDSHAKES: usize = 6;
/// 读取远端 sshd_config 的时限；超时按 OpenSSH 默认值处理，不阻塞新建终端太久。
pub(super) const SSHD_LIMITS_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 普通远程命令（status、diff、show…）的整体时限；挂住的命令会一直占着并发名额。
pub(super) const REMOTE_EXEC_TIMEOUT: Duration = Duration::from_secs(120);
/// 走网络的 Git 命令（fetch / pull / push / clone）可能很慢，单独放宽。
pub(super) const REMOTE_NETWORK_EXEC_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 共用 SFTP 会话上的请求超过这么久没有任何回包就视为僵死，下次换新会话（单次请求超时 30 秒）。
pub(super) const SFTP_STALL_TIMEOUT: Duration = Duration::from_secs(45);
/// 主动探测的等待上限；连接只是慢时不应拆掉它（会杀掉所有远端终端）。
/// 远端 CPU/内存占满时几秒不回包很常见，给足时间再判失效。
pub(super) const SSH_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// 重连失败后的冷却期：并发的终端恢复直接复用这次失败，不排队逐个重试握手。
pub(super) const SSH_RECONNECT_FAILURE_COOLDOWN: Duration = Duration::from_secs(3);
/// 主连接承载 SFTP、命令和 watch，取 10 秒 × 4 个周期（约 40 秒）兼顾恢复速度。
pub(super) const SSH_MAIN_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// russh 在首次保活后再等待 3 个周期，合计 4 个周期（约 40 秒）。
pub(super) const SSH_MAIN_KEEPALIVE_MAX: usize = 3;
pub(super) const SSH_MAIN_KEEPALIVE_WINDOW: Duration = Duration::from_secs(40);
/// 终端独占连接里的 TUI 可能在远端忙时长时间不响应，改回 15 秒 × 5 个周期（约 75 秒）。
pub(super) const SSH_TERMINAL_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// russh 在首次保活后再等待 4 个周期，合计 5 个周期（约 75 秒）。
pub(super) const SSH_TERMINAL_KEEPALIVE_MAX: usize = 4;
pub(super) const SSH_TERMINAL_KEEPALIVE_WINDOW: Duration = Duration::from_secs(75);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ConnectionPurpose {
    Main,
    Terminal,
}

pub(super) fn ssh_client_config(purpose: ConnectionPurpose) -> client::Config {
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

pub(super) fn keepalive_window(purpose: ConnectionPurpose) -> Duration {
    match purpose {
        ConnectionPurpose::Main => SSH_MAIN_KEEPALIVE_WINDOW,
        ConnectionPurpose::Terminal => SSH_TERMINAL_KEEPALIVE_WINDOW,
    }
}

/// 发一次 ping 并等待回包；超时或连接已关闭都视为失效。
pub(super) async fn connection_responds(handle: &client::Handle<SshClient>) -> bool {
    if handle.is_closed() {
        return false;
    }
    matches!(
        tokio::time::timeout(SSH_LIVENESS_PROBE_TIMEOUT, handle.send_ping()).await,
        Ok(Ok(()))
    ) && !handle.is_closed()
}

pub(super) async fn open_session_channel_once(
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
pub(super) async fn open_sftp_session(
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
        inner: Some(sftp),
        direct: None,
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
    pub(super) uri: String,
    pub(super) canonical_path: String,
    pub(super) trusted: bool,
}

pub(super) struct RemoteTerminalSession {
    pub(super) connection_id: String,
    /// 终端独占的 SSH 连接；终端结束、被替换或关闭时一并断开。
    pub(super) transport: Arc<ConnectedSession>,
    pub(super) input: tokio::sync::mpsc::Sender<Vec<u8>>,
    pub(super) writer: Arc<ChannelWriteHalf<client::Msg>>,
    /// Cleared when this channel is replaced or closed on purpose.
    /// A stale reader must not emit `terminal-exit` for the replacement.
    pub(super) alive: Arc<AtomicBool>,
}

/// Returns true only for the reader that still owns the terminal id.
pub(super) fn claim_terminal_exit(alive: &AtomicBool) -> bool {
    alive.swap(false, Ordering::AcqRel)
}

/// 远端正常结束会先发 ExitStatus / ExitSignal / Close；什么都没收到就结束，
/// 说明是连接断了，而不是 Shell 自己退出。
pub(super) fn is_terminal_end_message(message: &ChannelMsg) -> bool {
    matches!(
        message,
        ChannelMsg::ExitStatus { .. } | ChannelMsg::ExitSignal { .. } | ChannelMsg::Close
    )
}

/// 断开终端独占的连接；连接已关闭时忽略错误。
pub(super) async fn close_terminal_transport(transport: &ConnectedSession) {
    qingcode_server::diagnostics::record(
        "ssh.transport_close_requested",
        serde_json::json!({
        "connectionId":transport.config.lock().ok().map(|config|config.id.clone()),
        "transportId":format!("{:p}",Arc::as_ptr(&transport.server_incarnation)),
        "source":"lease_released_or_terminal_closed"}),
        false,
        false,
    );
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
pub(super) struct PooledTerminalTransport {
    pub(super) transport: Arc<ConnectedSession>,
    /// 已租出的通道名额。
    pub(super) leased: usize,
    /// 这条连接最多承载的终端数。
    pub(super) capacity: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SshdSessionLimitSource {
    /// 远端 sshd_config 中的 `MaxSessions`。
    Config,
    /// 读不到配置时的 OpenSSH 默认值。
    Default,
    /// 共享连接上开通道被 sshd 拒绝时实测得到。
    Observed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SshdSessionLimit {
    pub(super) max_sessions: usize,
    pub(super) source: SshdSessionLimitSource,
}

impl SshdSessionLimit {
    /// MaxSessions 为 0/1 时无法复用连接，退化为每个终端一条连接。
    pub(super) fn transport_capacity(self) -> usize {
        self.max_sessions.max(1)
    }

    pub(super) fn describe(self) -> String {
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
pub(super) struct TerminalTransportPoolState {
    pub(super) entries: Vec<PooledTerminalTransport>,
    /// 该连接的 sshd 会话上限；`None` 表示还没探测过。
    pub(super) limit: Option<SshdSessionLimit>,
    /// 借用主连接通道的终端数（专用连接握手失败时的回退），受
    /// [`TERMINAL_MAIN_FALLBACK_LIMIT`] 限制。
    pub(super) main_fallback: usize,
    /// 最近一次专用终端连接握手失败的时间与原因：冷却期内直接走主连接回退，
    /// 不再每开一个终端都白等握手超时（失败的握手还会让远端继续追加罚时）。
    pub(super) handshake_failure: Option<(Instant, String)>,
}

/// 主连接上最多借给终端的 daemon 通道数：主连接还要承载 SFTP、命令与
/// scan/search/watch，sshd 的 MaxSessions（默认 10）不能都给终端。
pub(super) const TERMINAL_MAIN_FALLBACK_LIMIT: usize = 4;
/// 专用终端连接握手失败后，多久内不再尝试新握手、直接回退主连接。
pub(super) const TERMINAL_HANDSHAKE_FAILURE_COOLDOWN: Duration = Duration::from_secs(120);

/// 专用终端连接握手失败时附带的排查提示。
///
/// OpenSSH 9.8+（含 Windows 版 9.8p2）默认开启 PerSourcePenalties：连接异常结束、
/// 认证前断开等都会给来源 IP 记罚时，罚时内该 IP 的新连接一律被拒（远端回
/// `Not allowed at this time` 或握手无响应），已建立的连接不受影响。
pub(super) const TERMINAL_HANDSHAKE_PENALTY_HINT: &str = "若远端为 OpenSSH 9.8 及以上（含 Windows 版），可能是 PerSourcePenalties 正对本机 IP 罚时拒绝新连接，可在远端 sshd_config 加入 PerSourcePenaltyExemptList <本机 IP> 或 PerSourcePenalties no 后重启 sshd";

/// 同一 SSH 连接配置下，server 模式终端共用的连接；锁同时串行化探测与新连接握手。
pub(super) type TerminalTransportPool = Arc<tokio::sync::Mutex<TerminalTransportPoolState>>;

/// 第一条未满的共享连接；参数为各连接的（已租出, 容量）。
pub(super) fn pick_terminal_transport(
    slots: impl IntoIterator<Item = (usize, usize)>,
) -> Option<usize> {
    slots
        .into_iter()
        .position(|(leased, capacity)| leased < capacity)
}

/// sshd 拒绝开新通道时，连接上已开的通道数就是它的实际上限。
///
/// `leased` 含本次被拒的租约；除它之外一个通道都没有时说明不是会话数打满，
/// 返回 `None`，不据此修正容量。
pub(super) fn observed_capacity_after_refusal(leased: usize) -> Option<usize> {
    leased.checked_sub(1).filter(|open| *open > 0)
}

pub(super) fn terminal_pool_full_notice(full: usize, limit: SshdSessionLimit) -> String {
    format!(
        "已有 {full} 条终端共享 SSH 连接均已占满（{}），已为新终端新开第 {} 条连接",
        limit.describe(),
        full + 1
    )
}

/// 共享终端连接上的一个 daemon 通道名额。
///
/// 归还最后一个名额时关闭这条空闲连接；`release` 可重复调用，Drop 时也会归还。
pub(super) struct TerminalTransportLease {
    pub(super) transport: Arc<ConnectedSession>,
    pub(super) released: AtomicBool,
    pub(super) pool: TerminalTransportPool,
    /// 借用的是主连接（专用连接握手失败时的回退）：归还时只减计数，绝不断开。
    pub(super) main_fallback: bool,
    /// 回退终端与命令共用主连接预算；release 时立即归还，不必等租约对象析构。
    pub(super) main_slot: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
    /// 已有共享连接全满、本次新开了连接时给用户的提示。
    pub(super) notice: Option<String>,
}

impl std::ops::Deref for TerminalTransportLease {
    type Target = ConnectedSession;

    fn deref(&self) -> &ConnectedSession {
        &self.transport
    }
}

impl TerminalTransportLease {
    pub(super) fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub(super) fn release(&self) {
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
    pub(super) async fn mark_refused(&self) -> bool {
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
pub(super) type ReconnectGate = Arc<tokio::sync::Mutex<Option<(Instant, String)>>>;
