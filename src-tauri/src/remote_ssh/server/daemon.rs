//! daemon 传输层（qingcode-server daemon 模式，协议 v1 帧流）：
//! SSH exec 通道内运行 `connect --stdio --ensure-daemon`，与远端常驻
//! daemon 之间完成 HELLO 握手、RPC、scan/search/watch 调用与降级管理。

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use super::paths::windows_host_path;
use super::scripts::{
    connect_daemon_command, connect_daemon_command_existing, daemon_token_command,
    windows_connect_daemon_command, windows_connect_daemon_command_existing,
    windows_daemon_token_command,
};
use super::*;
#[cfg(test)]
mod live_parity;
use qingcode_server::proto::{
    self, ErrorBody, Event, Frame, HelloRequest, HelloResponse, Kind, ReceiverWindow, Request,
    Response, StreamChunk, StreamEnd, WindowCredit, CONTROL_STREAM, PROTOCOL_VERSION, WINDOW_BYTES,
};
use qingcode_server::SERVER_VERSION;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

/// daemon 握手应答时限：`connect --ensure-daemon` 可能在通道内现拉 daemon
/// （代理内部启动等待上限 10s），给足余量再判失败。
const AGENT_DAEMON_HELLO_TIMEOUT: Duration = Duration::from_secs(20);
/// 部署后 daemon 就绪探测的总时限：覆盖启动、token 轮询、握手探针与旧版本
/// 淘汰的全部步骤，每一步的超时都按剩余预算截断（见 [`daemon_step_budget`]），
/// 超出即视为本轮无 daemon、直接发布 serve 端点。此前只在轮询末尾检查，
/// 单步 exec（120s）或握手（20s）阻塞时状态会长时间停在「正在握手」。
const AGENT_DAEMON_ENSURE_TIMEOUT: Duration = Duration::from_secs(30);
/// daemon 启动与 token 读取单步 exec 的上限（正常亚秒级完成）。
const AGENT_DAEMON_STEP_TIMEOUT: Duration = Duration::from_secs(15);
// 单步上限都不超过总时限，最坏情况下探测也在总截止时收口。
const _: () = assert!(AGENT_DAEMON_STEP_TIMEOUT.as_secs() <= AGENT_DAEMON_ENSURE_TIMEOUT.as_secs());
const _: () =
    assert!(AGENT_DAEMON_HELLO_TIMEOUT.as_secs() <= AGENT_DAEMON_ENSURE_TIMEOUT.as_secs());
/// daemon `fs.scan` 请求的整体时限（与 serve 路径的 15s 对齐）。
const AGENT_DAEMON_SCAN_TIMEOUT: Duration = Duration::from_secs(15);
/// daemon 传输降级后的重试冷却：降级时间戳超过这个时长，ensure 快路径
/// 才会重新探测 daemon，避免每次操作都对着一个已知失败的 daemon 空转。
const AGENT_DAEMON_RETRY_AFTER_DOWNGRADE: Duration = Duration::from_secs(5 * 60);
const DAEMON_SESSION_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// 慢终端消费者最多积压 2MB 编码后的事件，且最多 256 条（限制小帧元数据开销）。
/// 普通 PTY 块为 8KB。溢出时关闭当前通道，以 next_seq + attach 恢复；不能在读循环
/// 等待消费者，否则同一通道的 RPC 应答、PONG 也会被堵住。
const SESSION_EVENT_QUEUE_BYTES: usize = 2 * 1024 * 1024;
const SESSION_EVENT_QUEUE_DEPTH: usize = 256;

/// 单请求 exec 通道上的请求 id。通道不做多路复用（见 [`DaemonChannel`]），
/// 一条通道同时只有一个在途请求。
const DAEMON_REQUEST_ID: u32 = 1;

/// 已完成 HELLO 握手的 daemon 连接：SSH exec 通道内运行
/// `connect --stdio --ensure-daemon`，代理把帧流原样转发给远端 daemon。
///
/// 通道策略（刻意从简）：**每次方法调用开一条独立的 exec 通道**，通道内只有
/// 一个在途请求（watch 也只有一路订阅流），请求 id 固定为
/// [`DAEMON_REQUEST_ID`]，不做多路复用。scan/search 是短命操作，通道开销
/// （一次 exec + connect 进程 + 本地 socket 转发）远小于请求路由与并发复用
/// 的复杂度；真正需要 stream_id 路由和发送优先级的是 PTY 接入（下一轮），
/// 届时再改为「一条常驻通道 + 按 stream_id 分发」。
pub(crate) struct DaemonChannel {
    channel: DaemonTransport,
    /// 已到达但尚未构成完整帧的字节：代理转发的是裸字节流，不保证按帧到达。
    buffer: Vec<u8>,
    /// 代理/中间 shell 落在 stderr 的输出。不参与帧流，只在通道关闭时
    /// 并入错误信息（Windows 的 shell 启动噪声会到这里，不能当失败）。
    stderr_notes: Vec<String>,
    capabilities: Vec<String>,
    /// HELLO 应答里的 server 版本与 PTY 数（含已退出未回收的），供探测判断是否推迟升级。
    server_version: String,
    pty_count: usize,
}

impl DaemonChannel {
    fn new(channel: DaemonTransport) -> Self {
        Self {
            channel,
            buffer: Vec::new(),
            stderr_notes: Vec::new(),
            capabilities: Vec::new(),
            server_version: String::new(),
            pty_count: 0,
        }
    }
}

/// 版本与客户端不同、但经兼容判定后被刻意沿用的 daemon。
///
/// 参照 VS Code「能接回就接回、接不回就不保留旧后端」，但不按构建号一刀切，而是按
/// 显式的终端兼容契约（协议 + `pty.compat` 级别，见 `proto::pty_compatible`）判断：
/// - 远端更旧、兼容且仍托管运行中的终端：推迟升级，终端照常接回；全部结束后的下次
///   健康探测再淘汰并换成新版本；
/// - 远端更新且兼容：沿用，绝不降级（另一台装了更新客户端的电脑可能正在使用它）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeptDaemon {
    pub(crate) running_version: String,
    pub(crate) live_ptys: usize,
    /// 远端版本比本客户端新。
    pub(crate) newer: bool,
}

/// 按 daemon 访问凭据记录被沿用的实例。SSH 下是 daemon token，每次 daemon 启动都会
/// 轮换，唯一对应一个实例；端口直连下是固定的配对凭据，探测到版本一致时清除。
fn kept_daemons() -> std::sync::MutexGuard<'static, HashMap<String, KeptDaemon>> {
    static KEPT: std::sync::OnceLock<Mutex<HashMap<String, KeptDaemon>>> =
        std::sync::OnceLock::new();
    KEPT.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 该 daemon 是否为被沿用的异版本实例；用于状态展示与常规通道放行版本差异。
pub(crate) fn kept_daemon(access: &DaemonAccess) -> Option<KeptDaemon> {
    kept_daemons().get(&access.token).cloned()
}

fn keep_daemon(access: &DaemonAccess, info: KeptDaemon) {
    kept_daemons().insert(access.token.clone(), info);
}

pub(crate) fn forget_kept_daemon(access: &DaemonAccess) {
    kept_daemons().remove(&access.token);
}

/// 遇到版本落后的 daemon 时的处理方式（版本更新的 daemon 两种方式都不会降级）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StaleDaemon {
    /// 隐式准备：兼容且仍有运行中的终端就推迟升级，继续使用旧 daemon。
    DeferWhileBusy,
    /// 用户显式更新：立即淘汰旧 daemon（会结束其托管的终端）。
    Replace,
}

/// 比较两个 server 版本（semver 优先级，含预发布号，如 `0.1.17-beta.12`）。
/// 无法解析时返回 `None`，调用方按「旧版本」处理，与引入比较前的行为一致。
pub(crate) fn compare_server_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    fn parse(raw: &str) -> Option<(Vec<u64>, Option<Vec<&str>>)> {
        let raw = raw.trim().trim_start_matches(['v', 'V']);
        let raw = raw.split('+').next()?;
        let (core, pre) = match raw.split_once('-') {
            Some((core, pre)) => (core, Some(pre.split('.').collect::<Vec<_>>())),
            None => (raw, None),
        };
        let core = core
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()?;
        (core.len() == 3).then_some((core, pre))
    }
    fn identifier(left: &str, right: &str) -> Ordering {
        match (left.parse::<u64>(), right.parse::<u64>()) {
            (Ok(left), Ok(right)) => left.cmp(&right),
            // 数字标识符低于字母数字标识符。
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => left.cmp(right),
        }
    }
    let (left_core, left_pre) = parse(left)?;
    let (right_core, right_pre) = parse(right)?;
    Some(left_core.cmp(&right_core).then_with(|| {
        match (left_pre, right_pre) {
            (None, None) => Ordering::Equal,
            // 正式版高于同号预发布版。
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(left), Some(right)) => left
                .iter()
                .zip(&right)
                .map(|(left, right)| identifier(left, right))
                .find(|order| order.is_ne())
                .unwrap_or_else(|| left.len().cmp(&right.len())),
        }
    }))
}

enum DaemonTransport {
    Ssh(russh::Channel<client::Msg>),
    Direct(tokio::io::DuplexStream),
    /// 本机 PTY 宿主的命名管道，访问控制由管道 DACL 与 token 承担。
    Local(qingcode_server::ipc::IpcStream),
}

enum DaemonReader {
    Ssh(russh::ChannelReadHalf),
    Direct(tokio::io::ReadHalf<tokio::io::DuplexStream>),
    Local(tokio::io::ReadHalf<qingcode_server::ipc::IpcStream>),
}

enum DaemonWriter {
    Ssh(russh::ChannelWriteHalf<client::Msg>),
    Direct(tokio::io::WriteHalf<tokio::io::DuplexStream>),
    Local(tokio::io::WriteHalf<qingcode_server::ipc::IpcStream>),
}

impl DaemonTransport {
    async fn data(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self {
            Self::Ssh(channel) => channel.data(bytes).await.map_err(|error| error.to_string()),
            Self::Direct(stream) => stream
                .write_all(bytes)
                .await
                .map_err(|error| error.to_string()),
            Self::Local(stream) => stream
                .write_all(bytes)
                .await
                .map_err(|error| error.to_string()),
        }
    }

    async fn wait(&mut self) -> Option<ChannelMsg> {
        match self {
            Self::Ssh(channel) => channel.wait().await,
            Self::Direct(stream) => read_direct_message(stream).await,
            Self::Local(stream) => read_direct_message(stream).await,
        }
    }

    async fn eof(&mut self) -> Result<(), String> {
        match self {
            Self::Ssh(channel) => channel.eof().await.map_err(|error| error.to_string()),
            Self::Direct(stream) => stream.shutdown().await.map_err(|error| error.to_string()),
            Self::Local(stream) => stream.shutdown().await.map_err(|error| error.to_string()),
        }
    }

    async fn close(&mut self) -> Result<(), String> {
        match self {
            Self::Ssh(channel) => channel.close().await.map_err(|error| error.to_string()),
            Self::Direct(stream) => stream.shutdown().await.map_err(|error| error.to_string()),
            Self::Local(stream) => stream.shutdown().await.map_err(|error| error.to_string()),
        }
    }

    fn split(self) -> (DaemonReader, DaemonWriter) {
        match self {
            Self::Ssh(channel) => {
                let (reader, writer) = channel.split();
                (DaemonReader::Ssh(reader), DaemonWriter::Ssh(writer))
            }
            Self::Direct(stream) => {
                let (reader, writer) = tokio::io::split(stream);
                (DaemonReader::Direct(reader), DaemonWriter::Direct(writer))
            }
            Self::Local(stream) => {
                let (reader, writer) = tokio::io::split(stream);
                (DaemonReader::Local(reader), DaemonWriter::Local(writer))
            }
        }
    }
}

async fn read_direct_message(reader: &mut (impl AsyncRead + Unpin)) -> Option<ChannelMsg> {
    let mut bytes = vec![0; 64 * 1024];
    let size = reader.read(&mut bytes).await.ok()?;
    if size == 0 {
        return Some(ChannelMsg::Eof);
    }
    bytes.truncate(size);
    Some(ChannelMsg::Data { data: bytes.into() })
}

impl DaemonReader {
    async fn wait(&mut self) -> Option<ChannelMsg> {
        match self {
            Self::Ssh(reader) => reader.wait().await,
            Self::Direct(reader) => read_direct_message(reader).await,
            Self::Local(reader) => read_direct_message(reader).await,
        }
    }
}

impl DaemonWriter {
    async fn data(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self {
            Self::Ssh(writer) => writer.data(bytes).await.map_err(|error| error.to_string()),
            Self::Direct(writer) => writer
                .write_all(bytes)
                .await
                .map_err(|error| error.to_string()),
            Self::Local(writer) => writer
                .write_all(bytes)
                .await
                .map_err(|error| error.to_string()),
        }
    }

    async fn eof(&mut self) -> Result<(), String> {
        match self {
            Self::Ssh(writer) => writer.eof().await.map_err(|error| error.to_string()),
            Self::Direct(writer) => writer.shutdown().await.map_err(|error| error.to_string()),
            Self::Local(writer) => writer.shutdown().await.map_err(|error| error.to_string()),
        }
    }

    async fn close(&mut self) -> Result<(), String> {
        match self {
            Self::Ssh(writer) => writer.close().await.map_err(|error| error.to_string()),
            Self::Direct(writer) => writer.shutdown().await.map_err(|error| error.to_string()),
            Self::Local(writer) => writer.shutdown().await.map_err(|error| error.to_string()),
        }
    }
}

impl DaemonChannel {
    async fn send(&mut self, frame: &Frame) -> Result<(), String> {
        let bytes = frame
            .encode()
            .map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
        self.channel
            .data(&bytes[..])
            .await
            .map_err(|error| format!("发送 daemon 帧失败：{error}"))
    }

    /// 读取下一帧。PING 自动回 PONG——daemon 按「收到任意帧」计心跳，
    /// 空闲的 watch 连接全靠这个应答保活。
    ///
    /// deadline 前收不到完整帧返回 Err。`channel.wait()` 是 cancel-safe 的，
    /// 超时不会丢已到达的字节；但调用方此后应丢弃整条通道（回退 serve）。
    pub(super) async fn next_frame(&mut self, deadline: Instant) -> Result<Frame, String> {
        self.next_frame_with_policy(FrameDeadline::fixed(deadline))
            .await
    }

    pub(super) async fn next_watch_frame(&mut self, idle: Duration) -> Result<Frame, String> {
        self.next_frame_with_policy(FrameDeadline::idle(Instant::now(), idle))
            .await
    }

    async fn next_frame_with_policy(
        &mut self,
        mut timeout: FrameDeadline,
    ) -> Result<Frame, String> {
        loop {
            match proto::decode(&self.buffer) {
                Ok((frame, used)) => {
                    self.buffer.drain(..used);
                    timeout.note_frame(Instant::now());
                    if frame.kind == Kind::Ping {
                        let _ = self.send(&Frame::empty(Kind::Pong, frame.stream_id)).await;
                        continue;
                    }
                    return Ok(frame);
                }
                // 半帧：等待后续字节。
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {}
                Err(error) => return Err(format!("daemon 帧解析失败：{error}")),
            }
            let now = Instant::now();
            if now >= timeout.deadline {
                return Err("daemon 响应超时".to_string());
            }
            match tokio::time::timeout(timeout.deadline - now, self.channel.wait()).await {
                // 代理进程退出（daemon 拒绝连接 / 已下线 / 会话结束）。
                Ok(None) => return Err("daemon 连接代理已退出".to_string()),
                Ok(Some(ChannelMsg::Data { data })) => self.buffer.extend_from_slice(&data),
                // stderr：不立即判失败——Windows 远端的代理可能经由 PowerShell
                // 等中间 shell 启动，其启动噪声（CLIXML/进度流）会落到 stderr，
                // 但真正的帧流不受影响。记下来，通道关闭时并入错误信息。
                Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                    let note = String::from_utf8_lossy(&data).trim().to_string();
                    if !note.is_empty() {
                        self.stderr_notes.push(note);
                    }
                }
                Ok(Some(ChannelMsg::Eof) | Some(ChannelMsg::Close)) => {
                    let notes = self.stderr_notes.join(" ");
                    if notes.is_empty() {
                        return Err("daemon 连接已关闭".to_string());
                    }
                    return Err(format!("daemon 连接已关闭：{notes}"));
                }
                Ok(Some(_)) => {}
                Err(_) => return Err("daemon 响应超时".to_string()),
            }
        }
    }

    /// 尽力关闭通道：exec 通道被丢弃时不会自动 CLOSE，显式关闭避免长期
    /// 占用 sshd 的 MaxSessions 名额。
    pub(super) async fn shutdown(&mut self) {
        // 先发 EOF 再 CLOSE：远端代理读到 stdin EOF 即退出并断开 daemon 连接，
        // 不必等 sshd 回收 exec 进程（Windows OpenSSH 上可能拖到心跳超时）。
        let _ = tokio::time::timeout(Duration::from_secs(1), self.channel.eof()).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), self.channel.close()).await;
    }
}

struct FrameDeadline {
    deadline: Instant,
    idle: Option<Duration>,
}

impl FrameDeadline {
    fn fixed(deadline: Instant) -> Self {
        Self {
            deadline,
            idle: None,
        }
    }

    fn idle(now: Instant, idle: Duration) -> Self {
        Self {
            deadline: now + idle,
            idle: Some(idle),
        }
    }

    fn note_frame(&mut self, now: Instant) {
        if let Some(idle) = self.idle {
            self.deadline = now + idle;
        }
    }
}

enum SessionInbound {
    Response(serde_json::Value),
    Error(String),
    StreamData(StreamChunk),
    StreamEnd(StreamEnd),
}

enum SessionOutbound {
    Frame(Frame),
    Shutdown,
}

mod session_outbound;

struct QueuedSessionEvent {
    event: Event,
    _budget: OwnedSemaphorePermit,
}

struct SessionEventSender {
    sender: mpsc::Sender<QueuedSessionEvent>,
    budget: Arc<Semaphore>,
}

pub(super) struct SessionEventReceiver {
    receiver: mpsc::Receiver<QueuedSessionEvent>,
}

impl SessionEventReceiver {
    pub(super) async fn recv(&mut self) -> Option<Event> {
        self.receiver.recv().await.map(|queued| queued.event)
    }
}

fn session_event_channel() -> (SessionEventSender, SessionEventReceiver) {
    let (sender, receiver) = mpsc::channel(SESSION_EVENT_QUEUE_DEPTH);
    (
        SessionEventSender {
            sender,
            budget: Arc::new(Semaphore::new(SESSION_EVENT_QUEUE_BYTES)),
        },
        SessionEventReceiver { receiver },
    )
}

impl SessionEventSender {
    fn try_send(&self, event: Event, encoded_bytes: usize) -> Result<(), ()> {
        let size = u32::try_from(encoded_bytes).map_err(|_| ())?;
        let budget = Arc::clone(&self.budget)
            .try_acquire_many_owned(size)
            .map_err(|_| ())?;
        self.sender
            .try_send(QueuedSessionEvent {
                event,
                _budget: budget,
            })
            .map_err(|_| ())
    }
}

struct SessionState {
    pending: Mutex<HashMap<u32, oneshot::Sender<Result<serde_json::Value, String>>>>,
    streams: Mutex<HashMap<u32, mpsc::UnboundedSender<SessionInbound>>>,
    events: SessionEventSender,
    next_stream_id: AtomicU32,
    closed: AtomicBool,
    closed_reason: Mutex<Option<String>>,
    closed_notify: tokio::sync::Notify,
    last_frame: Mutex<Instant>,
}

impl SessionState {
    async fn wait_closed(&self) {
        loop {
            let notified = self.closed_notify.notified();
            if self.closed.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }

    fn mark_closed(&self, reason: &str) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut closed_reason) = self.closed_reason.lock() {
            *closed_reason = Some(reason.to_string());
        }
        let pending = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *pending)
        };
        for (_, sender) in pending {
            let _ = sender.send(Err(reason.to_string()));
        }
        let streams = {
            let mut streams = self
                .streams
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *streams)
        };
        for (_, sender) in streams {
            let _ = sender.send(SessionInbound::Error(reason.to_string()));
        }
        self.closed_notify.notify_waiters();
    }

    fn note_frame(&self) {
        if let Ok(mut last_frame) = self.last_frame.lock() {
            *last_frame = Instant::now();
        }
    }
}

/// 一条常驻 daemon 通道上的多路复用会话。
///
/// 写端串行发送，读端按 `stream_id` 把 REQ/RES/ERR/STREAM_* 路由到各自的
/// 请求通道；PTY 事件走单独的事件队列。旧的 [`daemon_rpc`] 继续保留给
/// scan/search/watch 的单请求通道，两者互不影响。
pub(super) struct DaemonSession {
    outbound: session_outbound::SessionSender,
    state: Arc<SessionState>,
    events: Option<SessionEventReceiver>,
}

pub(super) struct DaemonAttachResult {
    pub(super) response: serde_json::Value,
    pub(super) chunks: Vec<StreamChunk>,
    pub(super) stream_end: StreamEnd,
}

impl DaemonSession {
    pub(super) async fn open_direct(
        config: &super::super::direct::DirectConnectionConfig,
        connection_id: &str,
        client_id: &str,
        daemon: &DaemonAccess,
    ) -> Result<Self, String> {
        let channel = open_direct_daemon_channel(
            config,
            connection_id,
            client_id,
            daemon,
            HelloPolicy::TERMINAL,
        )
        .await?;
        Ok(Self::from_channel(channel))
    }
    /// 在本机 PTY 宿主的命名管道上建立 daemon 会话；不经过 SSH。
    pub(super) async fn open_local(
        stream: qingcode_server::ipc::IpcStream,
        client_id: &str,
        token: String,
    ) -> Result<Self, String> {
        if client_id.trim().is_empty() {
            return Err("daemon clientId 不能为空".to_string());
        }
        let mut channel = DaemonChannel::new(DaemonTransport::Local(stream));
        let access = DaemonAccess {
            bin: "local".into(),
            token,
        };
        match daemon_hello(
            &mut channel,
            client_id,
            &access,
            HelloPolicy::TERMINAL,
            Instant::now() + AGENT_DAEMON_HELLO_TIMEOUT,
        )
        .await
        {
            Ok(()) => Ok(Self::from_channel(channel)),
            Err(error) => {
                channel.shutdown().await;
                Err(error)
            }
        }
    }

    /// 在调用者明确传入的独占终端连接上建立 daemon 会话。
    ///
    /// 这个构造器刻意不接收 [`SshManager`]，避免持久化终端误把 daemon 帧
    /// 发到共享主连接上。`client_id` 也必须由调用者显式传入，确保 create、
    /// reconnect 和应用重启后的 attach 使用同一个安装/连接归属。
    pub(super) async fn open_on_transport(
        transport: &ConnectedSession,
        client_id: &str,
        daemon: &DaemonAccess,
    ) -> Result<Self, String> {
        if client_id.trim().is_empty() {
            return Err("daemon clientId 不能为空".to_string());
        }
        let channel = open_daemon_channel_on_transport(
            transport,
            client_id,
            daemon,
            HelloPolicy::TERMINAL,
            true,
            Instant::now() + AGENT_DAEMON_HELLO_TIMEOUT,
        )
        .await?;
        Ok(Self::from_channel(channel))
    }

    fn from_channel(channel: DaemonChannel) -> Self {
        let (mut reader, mut writer) = channel.channel.split();
        let stderr_notes = channel.stderr_notes;
        let (outbound_tx, mut outbound_rx) = session_outbound::channel();
        let (events_tx, events_rx) = session_event_channel();
        let state = Arc::new(SessionState {
            pending: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            events: events_tx,
            next_stream_id: AtomicU32::new(1),
            closed: AtomicBool::new(false),
            closed_reason: Mutex::new(None),
            closed_notify: tokio::sync::Notify::new(),
            last_frame: Mutex::new(Instant::now()),
        });

        let writer_state = Arc::clone(&state);
        tauri::async_runtime::spawn(async move {
            loop {
                let outbound = tokio::select! {
                    biased;
                    _ = writer_state.wait_closed() => break,
                    outbound = outbound_rx.recv() => match outbound {
                        Some(outbound) => outbound,
                        None => break,
                    },
                };
                match outbound {
                    SessionOutbound::Frame(frame) => {
                        let Ok(bytes) = frame.encode() else {
                            writer_state.mark_closed("编码 daemon 帧失败");
                            break;
                        };
                        let sent = tokio::select! {
                            biased;
                            _ = writer_state.wait_closed() => break,
                            sent = writer.data(&bytes[..]) => sent,
                        };
                        if let Err(error) = sent {
                            writer_state.mark_closed(&format!("发送 daemon 帧失败：{error}"));
                            break;
                        }
                    }
                    SessionOutbound::Shutdown => break,
                }
            }
            writer_state.mark_closed("daemon 写入通道已关闭");
            // 关闭不依赖发送队列有空位；输出积压或 SSH 窗口停滞时也能回收代理会话。
            let _ = tokio::time::timeout(Duration::from_secs(1), writer.eof()).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), writer.close()).await;
        });

        let reader_state = Arc::clone(&state);
        let ping_writer = outbound_tx.clone();
        let reader_notes = stderr_notes;
        tauri::async_runtime::spawn(async move {
            let mut buffer = Vec::new();
            let mut stderr_notes = reader_notes;
            loop {
                let message = tokio::select! {
                    biased;
                    _ = reader_state.wait_closed() => return,
                    message = reader.wait() => match message {
                        Some(message) => message,
                        None => break,
                    },
                };
                match message {
                    ChannelMsg::Data { data } => {
                        buffer.extend_from_slice(&data);
                        loop {
                            match proto::decode(&buffer) {
                                Ok((frame, used)) => {
                                    buffer.drain(..used);
                                    reader_state.note_frame();
                                    if frame.kind == Kind::Ping {
                                        let _ = ping_writer.try_send(SessionOutbound::Frame(
                                            Frame::empty(Kind::Pong, frame.stream_id),
                                        ));
                                    } else {
                                        route_session_frame(&reader_state, frame);
                                        if reader_state.closed.load(Ordering::Acquire) {
                                            return;
                                        }
                                    }
                                }
                                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                                    break;
                                }
                                Err(error) => {
                                    reader_state
                                        .mark_closed(&format!("daemon 帧解析失败：{error}"));
                                    return;
                                }
                            }
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        let note = String::from_utf8_lossy(&data).trim().to_string();
                        if !note.is_empty() {
                            stderr_notes.push(note);
                        }
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => {
                        let note = stderr_notes.join(" ");
                        let reason = if note.is_empty() {
                            "daemon 连接已关闭".to_string()
                        } else {
                            format!("daemon 连接已关闭：{note}")
                        };
                        reader_state.mark_closed(&reason);
                        return;
                    }
                    _ => {}
                }
            }
            let note = stderr_notes.join(" ");
            reader_state.mark_closed(&if note.is_empty() {
                "daemon 连接代理已退出".to_string()
            } else {
                format!("daemon 连接代理已退出：{note}")
            });
        });

        Self {
            outbound: outbound_tx,
            state,
            events: Some(events_rx),
        }
    }

    fn begin_oneshot_request<T: serde::Serialize>(
        &self,
        method: &str,
        params: &T,
    ) -> Result<(u32, oneshot::Receiver<Result<serde_json::Value, String>>), String> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err("daemon 连接已关闭".to_string());
        }
        let stream_id = self.state.next_stream_id.fetch_add(1, Ordering::Relaxed);
        let request = Request::with_params(stream_id, method, params)
            .map_err(|error| format!("编码 daemon 请求失败：{error}"))?;
        let payload =
            proto::encode(&request).map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
        let (reply_tx, reply_rx) = oneshot::channel();
        self.state
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(stream_id, reply_tx);
        if self
            .outbound
            .try_send(SessionOutbound::Frame(Frame::new(
                Kind::Req,
                stream_id,
                payload,
            )))
            .is_err()
        {
            self.finish_request(stream_id);
            return Err("daemon 请求发送队列已关闭".to_string());
        }
        Ok((stream_id, reply_rx))
    }

    fn begin_stream_request<T: serde::Serialize>(
        &self,
        method: &str,
        params: &T,
    ) -> Result<(u32, mpsc::UnboundedReceiver<SessionInbound>), String> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err("daemon 连接已关闭".to_string());
        }
        let stream_id = self.state.next_stream_id.fetch_add(1, Ordering::Relaxed);
        let request = Request::with_params(stream_id, method, params)
            .map_err(|error| format!("编码 daemon 请求失败：{error}"))?;
        let payload =
            proto::encode(&request).map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
        let (reply_tx, reply_rx) = mpsc::unbounded_channel();
        self.state
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(stream_id, reply_tx);
        if self
            .outbound
            .try_send(SessionOutbound::Frame(Frame::new(
                Kind::Req,
                stream_id,
                payload,
            )))
            .is_err()
        {
            self.finish_stream_request(stream_id);
            return Err("daemon 请求发送队列已关闭".to_string());
        }
        Ok((stream_id, reply_rx))
    }

    fn finish_request(&self, stream_id: u32) {
        self.state
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&stream_id);
    }

    fn finish_stream_request(&self, stream_id: u32) {
        self.state
            .streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&stream_id);
    }

    pub(super) async fn request<T: serde::Serialize>(
        &self,
        method: &str,
        params: &T,
    ) -> Result<serde_json::Value, String> {
        self.request_with_timeout(method, params, DAEMON_SESSION_REQUEST_TIMEOUT)
            .await
    }

    async fn request_with_timeout<T: serde::Serialize>(
        &self,
        method: &str,
        params: &T,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let (stream_id, replies) = self.begin_oneshot_request(method, params)?;
        let deadline = tokio::time::Instant::now() + timeout;
        match tokio::time::timeout_at(deadline, replies).await {
            Ok(Ok(result)) => result.map_err(|message| format!("daemon {method} 失败：{message}")),
            Ok(Err(_)) => Err("daemon 连接已关闭".to_string()),
            Err(_) => {
                self.finish_request(stream_id);
                Err(format!("daemon {method} 请求超时"))
            }
        }
    }

    /// `screen_on_alternate`：终端停在全屏 TUI 时要求 daemon 给快照而非补发增量
    /// （旧 daemon 忽略该字段，照常按 `from_seq` 补发）。
    pub(super) async fn attach(
        &self,
        pty_id: &str,
        from_seq: u64,
        screen_on_alternate: bool,
    ) -> Result<DaemonAttachResult, String> {
        self.attach_with_screen(pty_id, from_seq, screen_on_alternate, false)
            .await
    }

    /// `prefer_screen`：增量补发反复失败时要求 daemon 总给屏幕快照，避免断线越久
    /// 待补发越多、永远接不回（旧 daemon 忽略该字段，照常补发）。
    pub(super) async fn attach_with_screen(
        &self,
        pty_id: &str,
        from_seq: u64,
        screen_on_alternate: bool,
        prefer_screen: bool,
    ) -> Result<DaemonAttachResult, String> {
        let (stream_id, mut replies) = self.begin_stream_request(
            "pty.attach",
            &serde_json::json!({
                "id": pty_id,
                "fromSeq": from_seq,
                "screenOnAlternate": screen_on_alternate,
                "preferScreen": prefer_screen,
            }),
        )?;
        let deadline = tokio::time::Instant::now() + DAEMON_SESSION_REQUEST_TIMEOUT;
        let mut response = None;
        let mut chunks = Vec::new();
        let mut receiver = ReceiverWindow::new(WINDOW_BYTES);
        loop {
            let reply = match tokio::time::timeout_at(deadline, replies.recv()).await {
                Ok(reply) => reply,
                Err(_) => {
                    self.finish_stream_request(stream_id);
                    return Err("daemon pty.attach 请求超时".to_string());
                }
            };
            match reply {
                Some(SessionInbound::Response(value)) => response = Some(value),
                Some(SessionInbound::Error(message)) => {
                    self.finish_stream_request(stream_id);
                    return Err(message);
                }
                Some(SessionInbound::StreamData(chunk)) => {
                    if let Some(credit) = receiver.consume(
                        proto::encode(&chunk)
                            .map(|payload| payload.len())
                            .unwrap_or_default(),
                    ) {
                        if let Ok(payload) = proto::encode(&WindowCredit { credit }) {
                            let _ = self.outbound.try_send(SessionOutbound::Frame(Frame::new(
                                Kind::Window,
                                stream_id,
                                payload,
                            )));
                        }
                    }
                    chunks.push(chunk);
                }
                Some(SessionInbound::StreamEnd(stream_end)) => {
                    self.finish_stream_request(stream_id);
                    let response =
                        response.ok_or_else(|| "daemon pty.attach 缺少应答".to_string())?;
                    return Ok(DaemonAttachResult {
                        response,
                        chunks,
                        stream_end,
                    });
                }
                None => {
                    self.finish_stream_request(stream_id);
                    return Err("daemon 连接已关闭".to_string());
                }
            }
        }
    }

    pub(super) fn send_ping(&self) {
        let _ = self.outbound.try_send(SessionOutbound::Frame(Frame::empty(
            Kind::Ping,
            CONTROL_STREAM,
        )));
    }

    pub(super) fn last_frame_age(&self) -> Duration {
        self.state
            .last_frame
            .lock()
            .map(|last| last.elapsed())
            .unwrap_or(Duration::MAX)
    }

    pub(super) fn closed_reason(&self) -> Option<String> {
        self.state
            .closed_reason
            .lock()
            .ok()
            .and_then(|reason| reason.clone())
    }

    pub(super) async fn wait_closed(&self) {
        self.state.wait_closed().await;
    }

    pub(super) fn take_events(&mut self) -> Option<SessionEventReceiver> {
        self.events.take()
    }

    pub(super) fn shutdown(&self) {
        let _ = self.outbound.try_send(SessionOutbound::Shutdown);
        self.state.mark_closed("daemon 会话已关闭");
    }
}

fn route_session_frame(state: &SessionState, frame: Frame) {
    match frame.kind {
        Kind::Event => {
            if let Ok(event) = proto::decode_value::<Event>(&frame.payload) {
                if state
                    .events
                    .try_send(event, frame.payload.len() + proto::FRAME_HEADER_BYTES)
                    .is_err()
                {
                    state.mark_closed("终端输出积压已达上限，重新接回以恢复输出");
                }
            }
        }
        Kind::Res => {
            if let Ok(response) = proto::decode_value::<Response>(&frame.payload) {
                let sender = state
                    .pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&response.id);
                if let Some(sender) = sender {
                    let _ = sender.send(Ok(response.result));
                } else {
                    dispatch_session_stream(
                        state,
                        response.id,
                        SessionInbound::Response(response.result),
                    );
                }
            }
        }
        Kind::Err => {
            if let Ok(error) = proto::decode_value::<ErrorBody>(&frame.payload) {
                let message = format!("{}：{}", error.code, error.message);
                let sender = state
                    .pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&error.id);
                if let Some(sender) = sender {
                    let _ = sender.send(Err(message));
                } else {
                    dispatch_session_stream(state, error.id, SessionInbound::Error(message));
                }
            }
        }
        Kind::StreamData => {
            if let Ok(chunk) = proto::decode_value::<StreamChunk>(&frame.payload) {
                dispatch_session_stream(state, frame.stream_id, SessionInbound::StreamData(chunk));
            }
        }
        Kind::StreamEnd => {
            if let Ok(end) = proto::decode_value::<StreamEnd>(&frame.payload) {
                dispatch_session_stream(state, frame.stream_id, SessionInbound::StreamEnd(end));
            }
        }
        _ => {}
    }
}

fn dispatch_session_stream(state: &SessionState, stream_id: u32, reply: SessionInbound) {
    let sender = state
        .streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&stream_id)
        .cloned();
    if let Some(sender) = sender {
        let _ = sender.send(reply);
    }
}

/// HELLO 握手校验策略。
///
/// **协议版本永远校验**：不同协议的帧格式可能不同，放宽它会导致向不兼容的
/// daemon 盲发帧。可放宽的只有 server 版本与能力声明。
#[derive(Clone, Copy)]
struct HelloPolicy {
    require_version: bool,
    required_capabilities: &'static [&'static str],
    /// 要求终端兼容级别满足客户端下限（见 `proto::pty_compatible`）。
    require_pty_compat: bool,
}

impl HelloPolicy {
    /// 常规通道：版本一致 + 能力齐全（默认行为）。
    const STRICT: Self = Self {
        require_version: true,
        required_capabilities: &["fs.scan", "search.content", "watch.subscribe"],
        require_pty_compat: false,
    };
    /// 持久化终端通道按显式的终端兼容契约判断（协议版本 + `pty.compat` 级别），
    /// 不要求 server 版本一致：兼容的旧 daemon 上的终端可被新客户端接回、列出和
    /// 结束；不兼容的会在准备阶段被淘汰。
    const TERMINAL: Self = Self {
        require_version: false,
        required_capabilities: &[],
        require_pty_compat: true,
    };
    /// 健康探测：只校验协议，版本与能力由调用方读取 HELLO 后分类，以便区分
    /// 「兼容且仍托管终端，推迟升级」与「不兼容或空闲，直接淘汰」。
    const PROBE: Self = Self {
        require_version: false,
        required_capabilities: &[],
        require_pty_compat: false,
    };

    fn tolerating_version(self) -> Self {
        Self {
            require_version: false,
            ..self
        }
    }
    /// 仅供「淘汰旧 daemon」：只要协议与 token 对得上就允许握手，不要求
    /// server 版本匹配或能力齐全——旧实例本就该被拒绝于常规通道之外，
    /// 这里只是借它的 token 取到连接并请求其退出。
    const LENIENT: Self = Self {
        require_version: false,
        required_capabilities: &[],
        require_pty_compat: false,
    };
}

/// 校验 daemon 的 HELLO 应答（策略化）。协议版本无条件校验；server 版本与
/// 能力声明由 `policy` 决定。常规通道用 [`HelloPolicy::STRICT`]。
fn validate_daemon_hello_with(response: &HelloResponse, policy: HelloPolicy) -> Result<(), String> {
    if response.protocol != PROTOCOL_VERSION {
        return Err(format!("daemon 协议版本不兼容：{}", response.protocol));
    }
    if policy.require_version && response.server_version != SERVER_VERSION {
        return Err(format!(
            "daemon 版本不匹配：远端 {}，本端 {SERVER_VERSION}",
            response.server_version
        ));
    }
    missing_capability(&response.capabilities, policy.required_capabilities)?;
    if policy.require_pty_compat {
        proto::pty_compatible(response.protocol, &response.capabilities)?;
    }
    Ok(())
}

fn missing_capability(capabilities: &[String], required: &[&str]) -> Result<(), String> {
    match required
        .iter()
        .find(|capability| !capabilities.iter().any(|item| item == *capability))
    {
        Some(capability) => Err(format!("daemon 缺少能力 {capability}")),
        None => Ok(()),
    }
}

/// 打开一条 daemon 传输通道并完成握手。
///
/// exec 通道跑 `connect --stdio --ensure-daemon`：daemon 缺席时由代理拉起，
/// HELLO 携带 token 与协议区间 `[1, 1]`，daemon 校验 token / 协议后回 HELLO。
/// Windows 远端直接 exec 二进制本体（不经 PowerShell，避免其启动噪声破坏
/// 帧流，见 [`windows_connect_daemon_command`]）。任何一步失败都返回 Err，
/// 由调用方决定降级。
pub(super) async fn open_daemon_channel(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
) -> Result<DaemonChannel, String> {
    open_daemon_channel_with(
        manager,
        connection_id,
        daemon,
        HelloPolicy::STRICT,
        true,
        Instant::now() + AGENT_DAEMON_HELLO_TIMEOUT,
    )
    .await
}

/// 按给定 HELLO 校验策略打开 daemon 通道。除 [`shutdown_remote_daemon`]
/// 的淘汰路径外都应使用 [`HelloPolicy::STRICT`]。
///
/// `ensure_daemon = false` 时只连已有实例：daemon 缺席立即失败，不会顺手拉起
/// 一个（升级替换二进制前必须这样，否则会先启动旧版 daemon）。
/// `hello_deadline` 是 HELLO 应答的截止时刻，探测路径用它把握手限制在总预算内。
async fn open_daemon_channel_with(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    policy: HelloPolicy,
    ensure_daemon: bool,
    hello_deadline: Instant,
) -> Result<DaemonChannel, String> {
    if let Some(config) = manager.direct_config(connection_id) {
        return open_direct_daemon_channel(
            &config,
            connection_id,
            &manager.daemon_client_id(connection_id),
            daemon,
            policy,
        )
        .await;
    }
    let channel = manager
        .open_session_channel(connection_id, "server 守护进程 ")
        .await?;
    let client_id = manager.daemon_client_id(connection_id);
    open_daemon_channel_on_opened_channel(
        channel,
        &client_id,
        daemon,
        policy,
        ensure_daemon,
        hello_deadline,
    )
    .await
}

async fn open_direct_daemon_channel(
    config: &super::super::direct::DirectConnectionConfig,
    connection_id: &str,
    client_id: &str,
    daemon: &DaemonAccess,
    policy: HelloPolicy,
) -> Result<DaemonChannel, String> {
    let stream = super::super::direct::open_stream_for(config, connection_id).await?;
    let mut channel = DaemonChannel::new(DaemonTransport::Direct(stream));
    let access = DaemonAccess {
        bin: daemon.bin.clone(),
        token: config.token.clone(),
    };
    match daemon_hello(
        &mut channel,
        client_id,
        &access,
        policy,
        Instant::now() + AGENT_DAEMON_HELLO_TIMEOUT,
    )
    .await
    {
        Ok(()) => Ok(channel),
        Err(error) => {
            channel.shutdown().await;
            Err(error)
        }
    }
}

/// 在已经由调用者选定并独占的 SSH 连接上打开 daemon 通道。
///
/// 持久化终端必须使用这个入口；它不会触碰 `SshManager` 的共享 session，
/// 因此创建、重连和离线 kill 的 daemon 帧都只经过终端自己的 SSH channel。
async fn open_daemon_channel_on_transport(
    transport: &ConnectedSession,
    client_id: &str,
    daemon: &DaemonAccess,
    policy: HelloPolicy,
    ensure_daemon: bool,
    hello_deadline: Instant,
) -> Result<DaemonChannel, String> {
    let channel = open_session_channel_once(transport, "server 守护进程 ").await?;
    open_daemon_channel_on_opened_channel(
        channel,
        client_id,
        daemon,
        policy,
        ensure_daemon,
        hello_deadline,
    )
    .await
}

fn daemon_connect_command(daemon: &DaemonAccess, ensure_daemon: bool) -> String {
    let windows = windows_native_path(&daemon.bin).is_some();
    match (windows, ensure_daemon) {
        (true, true) => windows_connect_daemon_command(&daemon.bin),
        (true, false) => windows_connect_daemon_command_existing(&daemon.bin),
        (false, true) => connect_daemon_command(&daemon.bin),
        (false, false) => connect_daemon_command_existing(&daemon.bin),
    }
}

async fn open_daemon_channel_on_opened_channel(
    channel: russh::Channel<client::Msg>,
    client_id: &str,
    daemon: &DaemonAccess,
    policy: HelloPolicy,
    ensure_daemon: bool,
    hello_deadline: Instant,
) -> Result<DaemonChannel, String> {
    let command = daemon_connect_command(daemon, ensure_daemon);
    if let Err(error) = channel.exec(true, command).await {
        let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        return Err(format!("启动 daemon 连接代理失败：{error}"));
    }
    let mut channel = DaemonChannel::new(DaemonTransport::Ssh(channel));
    // 握手失败也要关通道：直接丢弃 exec 通道不会发 CLOSE，会一直占着会话名额。
    match daemon_hello(&mut channel, client_id, daemon, policy, hello_deadline).await {
        Ok(()) => Ok(channel),
        Err(error) => {
            channel.shutdown().await;
            Err(error)
        }
    }
}

/// 在已打开的 daemon 通道里完成 HELLO 握手与版本/能力校验。
async fn daemon_hello(
    channel: &mut DaemonChannel,
    client_id: &str,
    daemon: &DaemonAccess,
    policy: HelloPolicy,
    deadline: Instant,
) -> Result<(), String> {
    let hello = HelloRequest {
        client_id: client_id.to_string(),
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        token: daemon.token.clone(),
        resume_token: None,
    };
    channel
        .send(&Frame::new(
            Kind::Hello,
            CONTROL_STREAM,
            proto::encode(&hello).map_err(|error| format!("编码 HELLO 失败：{error}"))?,
        ))
        .await?;
    let response = channel.next_frame(deadline).await?;
    if response.kind != Kind::Hello {
        return Err(format!("daemon 握手应答异常（{}）", response.kind.as_str()));
    }
    let hello: HelloResponse = proto::decode_value(&response.payload)
        .map_err(|error| format!("解析 daemon HELLO 失败：{error}"))?;
    // 经兼容判定而沿用的异版本 daemon 在常规通道上也放行版本差异；
    // 协议版本与能力仍按策略校验。
    let policy = if kept_daemon(daemon).is_some() {
        policy.tolerating_version()
    } else {
        policy
    };
    // 协议版本无条件校验；版本与能力按策略放宽。
    validate_daemon_hello_with(&hello, policy)?;
    channel.capabilities = hello.capabilities;
    channel.server_version = hello.server_version;
    channel.pty_count = hello.pty_count;
    Ok(())
}

/// serve server 就绪后尽力补一步 daemon 传输探测（后台执行，见 deploy 的
/// `spawn_daemon_probe`）。每轮两次 exec：
/// 1. `daemon-token --ensure-daemon`：二进制自己确保 daemon 在跑（缺席即脱离
///    会话拉起并等就绪）后输出 token。此前是「读 token → 拉起 → 再读 token」
///    三次 exec，Windows 上每次都是一次 PowerShell 冷启动（真机约 2.5s/次）；
/// 2. 用一次真实握手验证 token、版本与能力，通过才标记 daemon 可用。
///    远端 daemon 版本落后时（升级后旧 daemon 仍持锁），凭有效 token 发
///    `server.shutdown` 淘汰旧实例，下一轮由 `daemon-token` 拉起新版并复验。
///
/// 任一步失败都返回最后一次失败原因：仅表示本轮无 daemon，不影响 serve 模式；
/// 原因留给 Server 模式的终端报错展示，否则用户只能看到笼统的「不可用」。
///
/// `stale = DeferWhileBusy` 时，旧 daemon 仍有运行中的终端就不淘汰：记录推迟升级
/// 并直接返回它的凭据，终端继续可接回；终端全部结束后的下次健康探测再升级。
pub(crate) async fn ensure_remote_daemon(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    remote_bin: &str,
    stale: StaleDaemon,
) -> Result<DaemonAccess, String> {
    let windows = windows_native_path(&root.canonical_path).is_some();
    // 这里只接受调用方已经通过可信 SHA-256 校验的路径。此前 `None` 会按
    // 项目根重新解析 `<项目>/.qingcode/server/...`，构成项目内代码执行路径；
    // 现在可选路径 API 已删除，编译器不允许再传入无校验回退。
    let bin = remote_bin.to_string();
    if windows {
        // Windows 二进制路径无法换算成本机路径时不做任何远端调用。
        windows_host_path(&bin).ok_or("Windows server 路径无效")?;
    }
    // 总截止从第一步开始计：拉起、握手、淘汰旧版本都扣同一份预算。
    let deadline = Instant::now() + AGENT_DAEMON_ENSURE_TIMEOUT;
    let mut shut_down_stale = false;
    loop {
        let last_error = match ensure_daemon_token(manager, root, &bin, windows, deadline).await {
            Ok(token) => {
                let access = DaemonAccess {
                    bin: bin.clone(),
                    token,
                };
                match probe_daemon_versioned(manager, connection_id, &access, deadline).await {
                    ProbeOutcome::Ready => return Ok(access),
                    ProbeOutcome::Skewed(info) => match info.decision(stale) {
                        SkewDecision::Keep => {
                            keep_daemon(&access, info.kept);
                            return Ok(access);
                        }
                        SkewDecision::RefuseNewer => return Err(info.reason()),
                        SkewDecision::Replace if !shut_down_stale => {
                            // 旧版 daemon 还持着单实例锁：拿它自己的 token 请求退出，
                            // 下一轮 daemon-token 按新二进制拉起。只做一次，避免循环。
                            shut_down_stale = true;
                            forget_kept_daemon(&access);
                            shutdown_remote_daemon_until(manager, connection_id, &access, deadline)
                                .await;
                            info.reason()
                        }
                        SkewDecision::Replace => info.reason(),
                    },
                    ProbeOutcome::Unavailable(reason) => reason,
                }
            }
            Err(reason) => reason,
        };
        if Instant::now() >= deadline {
            return Err(last_error);
        }
        // 旧实例退出、管道/socket 释放有短暂空窗，稍等再试。
        tokio::time::sleep(Duration::from_millis(300).min(deadline - Instant::now())).await;
    }
}

/// 单步可用的时长：剩余总预算与单步上限取小；预算耗尽返回 `None`，调用方跳过该步。
fn daemon_step_budget(deadline: Instant, now: Instant, cap: Duration) -> Option<Duration> {
    let remaining = deadline.checked_duration_since(now)?;
    (!remaining.is_zero()).then(|| remaining.min(cap))
}

/// 探测结果：版本一致可用、版本不同（交由兼容判定）、连不上。
enum ProbeOutcome {
    Ready,
    Skewed(SkewedDaemon),
    Unavailable(String),
}

/// 版本与客户端不同的 daemon 及其兼容判定结果。
struct SkewedDaemon {
    kept: KeptDaemon,
    /// 本客户端能否继续使用它：终端兼容契约满足且常规能力齐全。`Err` 带原因。
    compatible: Result<(), String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SkewDecision {
    /// 沿用：兼容且（远端更新，或仍托管运行中的终端且非显式替换）。
    Keep,
    /// 淘汰旧实例并按本客户端版本重新拉起（其托管的终端随之结束）。
    Replace,
    /// 远端更新且不兼容：不降级、不结束别人的终端，提示升级客户端。
    RefuseNewer,
}

impl SkewedDaemon {
    fn decision(&self, stale: StaleDaemon) -> SkewDecision {
        match (self.kept.newer, self.compatible.is_ok()) {
            (true, true) => SkewDecision::Keep,
            (true, false) => SkewDecision::RefuseNewer,
            (false, true) if stale == StaleDaemon::DeferWhileBusy && self.kept.live_ptys > 0 => {
                SkewDecision::Keep
            }
            (false, _) => SkewDecision::Replace,
        }
    }

    fn reason(&self) -> String {
        let running = &self.kept.running_version;
        if self.kept.newer {
            // 刻意不含「版本不匹配」：前端据此提供的「更新远端服务」会把它降级。
            let why = self.compatible.as_ref().err().map_or("", String::as_str);
            return format!(
                "远端服务 v{running} 比本客户端 v{SERVER_VERSION} 新且不兼容（{why}），请升级 QingCode"
            );
        }
        let base = format!("daemon 版本不匹配：远端 {running}，本端 {SERVER_VERSION}");
        match &self.compatible {
            Ok(()) => base,
            Err(why) => format!("{base}（不兼容：{why}）"),
        }
    }
}

/// 版本不同的 daemon 能否被本客户端继续使用（含终端接回与文件操作）。
fn skewed_daemon_compatible(capabilities: &[String]) -> Result<(), String> {
    proto::pty_compatible(PROTOCOL_VERSION, capabilities)?;
    missing_capability(capabilities, HelloPolicy::STRICT.required_capabilities)
}

/// 从 `pty.list` 应答统计尚未退出的终端；`exited` 为数值即已退出。
fn count_live_ptys(listed: &serde_json::Value) -> Option<usize> {
    let ptys = listed.get("ptys")?.as_array()?;
    Some(
        ptys.iter()
            .filter(|item| item.get("exited").is_none_or(serde_json::Value::is_null))
            .count(),
    )
}

async fn probe_daemon_versioned(
    manager: &SshManager,
    connection_id: &str,
    access: &DaemonAccess,
    deadline: Instant,
) -> ProbeOutcome {
    let Some(budget) = daemon_step_budget(deadline, Instant::now(), AGENT_DAEMON_HELLO_TIMEOUT)
    else {
        return ProbeOutcome::Unavailable("daemon 探测超时".to_string());
    };
    let mut channel = match open_daemon_channel_with(
        manager,
        connection_id,
        access,
        HelloPolicy::PROBE,
        true,
        Instant::now() + budget,
    )
    .await
    {
        Ok(channel) => channel,
        Err(reason) => return ProbeOutcome::Unavailable(reason),
    };
    if channel.server_version == SERVER_VERSION {
        let capable = missing_capability(
            &channel.capabilities,
            HelloPolicy::STRICT.required_capabilities,
        );
        channel.shutdown().await;
        forget_kept_daemon(access);
        return match capable {
            Ok(()) => ProbeOutcome::Ready,
            Err(reason) => ProbeOutcome::Unavailable(reason),
        };
    }
    // 版本不同：交由兼容判定。是否推迟升级取决于运行中的终端数；HELLO 的 pty_count
    // 含已退出未回收的终端，兼容时用 pty.list 精确统计，查询失败按 HELLO 计数保守处理。
    let compatible = skewed_daemon_compatible(&channel.capabilities);
    let newer = compare_server_versions(&channel.server_version, SERVER_VERSION)
        == Some(std::cmp::Ordering::Greater);
    let mut live_ptys = channel.pty_count;
    if live_ptys > 0 && compatible.is_ok() {
        let rpc_deadline = deadline.min(Instant::now() + AGENT_PING_TIMEOUT);
        if let Ok(listed) = daemon_rpc(
            &mut channel,
            "pty.list",
            &serde_json::json!({}),
            rpc_deadline,
        )
        .await
        {
            live_ptys = count_live_ptys(&listed).unwrap_or(live_ptys);
        }
    }
    let running_version = std::mem::take(&mut channel.server_version);
    channel.shutdown().await;
    ProbeOutcome::Skewed(SkewedDaemon {
        kept: KeptDaemon {
            running_version,
            live_ptys,
            newer,
        },
        compatible,
    })
}

/// 共享 daemon 的健康探测（隐式准备语义，即 [`StaleDaemon::DeferWhileBusy`]）。
///
/// 版本不同的 daemon 按 [`SkewedDaemon::decision`] 判定：沿用则照常可用；远端更新
/// 且不兼容则报错，不降级；需要淘汰（更旧且不兼容或已空闲）时：
/// - SSH：返回错误，由调用方重新准备，淘汰旧实例并按新二进制拉起；
/// - Server 端口直连：网关已是当前版本（健康检查保证），这里凭配对凭据请求旧 daemon
///   退出，网关在下一次 HELLO 时用自身二进制重新拉起，再复验一次。
pub(super) async fn probe_shared_daemon(
    manager: &SshManager,
    connection_id: &str,
    access: &DaemonAccess,
) -> Result<(), String> {
    let probe = |deadline| probe_daemon_versioned(manager, connection_id, access, deadline);
    let settle = |outcome: ProbeOutcome| -> Result<Result<(), String>, SkewedDaemon> {
        match outcome {
            ProbeOutcome::Ready => Ok(Ok(())),
            ProbeOutcome::Unavailable(reason) => Ok(Err(reason)),
            ProbeOutcome::Skewed(info) => match info.decision(StaleDaemon::DeferWhileBusy) {
                SkewDecision::Keep => {
                    keep_daemon(access, info.kept);
                    Ok(Ok(()))
                }
                SkewDecision::RefuseNewer => Ok(Err(info.reason())),
                SkewDecision::Replace => Err(info),
            },
        }
    };
    let info = match settle(probe(Instant::now() + AGENT_DAEMON_HELLO_TIMEOUT).await) {
        Ok(result) => return result,
        Err(info) => info,
    };
    forget_kept_daemon(access);
    let reason = info.reason();
    if manager.direct_config(connection_id).is_none()
        || !shutdown_remote_daemon(manager, connection_id, access).await
    {
        return Err(reason);
    }
    // 旧实例退出、IPC 端点释放有短暂空窗；网关拉起新 daemon 的等待上限为 10s，
    // 复验握手时限已覆盖。只复验一次，避免与外部托管（如 systemd）的旧版本循环。
    tokio::time::sleep(Duration::from_millis(300)).await;
    match settle(probe(Instant::now() + AGENT_DAEMON_HELLO_TIMEOUT).await) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!(
            "已请求旧版服务退出（{reason}），新版服务尚未就绪：{error}"
        )),
        Err(info) => Err(info.reason()),
    }
}

/// 一次 exec 确保 daemon 在跑并取回 token（见 [`daemon_token_command`]）。
/// 直接 exec 二进制本体，Windows 上不经 PowerShell 包装。
async fn ensure_daemon_token(
    manager: &SshManager,
    root: &RegisteredRoot,
    bin: &str,
    windows: bool,
    deadline: Instant,
) -> Result<String, String> {
    let timeout = daemon_step_budget(deadline, Instant::now(), AGENT_DAEMON_STEP_TIMEOUT)
        .ok_or("daemon 探测超时")?;
    let command = if windows {
        windows_daemon_token_command(bin)
    } else {
        daemon_token_command(bin)
    };
    let result = manager
        .exec_command(&root.uri, &command, None, true, timeout)
        .await?;
    let token = result.stdout.trim();
    if result.exit_code != 0 || token.is_empty() {
        let detail = result.stderr.trim();
        return Err(if detail.is_empty() {
            format!("启动 daemon 失败（退出码 {}）", result.exit_code)
        } else {
            format!("启动 daemon 失败：{detail}")
        });
    }
    Ok(token.to_string())
}

/// 记录「daemon 传输暂不可用」：保留 serve 端点，只清 daemon 标记并记下降级
/// 时间。该连接 + 根的后续操作直接走 serve 模式；冷却
/// [`AGENT_DAEMON_RETRY_AFTER_DOWNGRADE`] 后 ensure 快路径会重新探测——
/// 之前一次失败就永久清标记，daemon 崩溃后整条连接再也回不去 daemon 传输。
pub(crate) fn downgrade_server_daemon(manager: &SshManager, key: &str, expected: &DaemonAccess) {
    if let Some((connection_id, _)) = key.split_once('|') {
        super::host_runtime::invalidate_failed_daemon(manager, connection_id, expected);
    }
    let Some(mut slot) = manager.server_slot(key) else {
        return;
    };
    let Some(endpoint) = slot.endpoint.as_mut() else {
        return;
    };
    if endpoint
        .daemon
        .as_ref()
        .is_some_and(|current| current != expected)
    {
        return;
    }
    endpoint.daemon = None;
    if endpoint.serve.is_none() {
        slot.endpoint = None;
    }
    slot.daemon_downgraded_at = Some(Instant::now());
    manager.set_server_slot(key, slot);
}

/// SSH can retry via serve; a port connection must retain its actual WSS error
/// and reconnect through the same endpoint. HTTPS file access remains usable.
pub(crate) fn handle_daemon_transport_error(
    manager: &SshManager,
    key: &str,
    expected: &DaemonAccess,
    error: &DaemonCallError,
) -> Result<(), String> {
    if key
        .split_once('|')
        .is_some_and(|(id, _)| manager.direct_config(id).is_some())
    {
        let reason = format!("Server 端口直连失败：{error}");
        let mut slot = manager.server_slot(key).unwrap_or_default();
        if slot
            .endpoint
            .as_ref()
            .and_then(|endpoint| endpoint.daemon.as_ref())
            == Some(expected)
        {
            slot.endpoint = None;
            slot.last_failure = Some(reason.clone());
            slot.daemon_failure = Some(error.to_string());
            manager.set_server_slot(key, slot);
        }
        return Err(reason);
    }
    downgrade_server_daemon(manager, key, expected);
    Ok(())
}

/// 尽力让远端 daemon 退出：一次真实握手（token 校验）+ `server.shutdown` RPC。
/// daemon 已下线、token 失效或通道失败都只返回 false——调用方（restart/stop）
/// 把它当 best-effort，随后的 ensure 会重新拉起 daemon。
///
/// 这里用 [`HelloPolicy::LENIENT`]：本函数的典型调用场景正是淘汰版本落后的
/// 旧 daemon，严格策略会因 server 版本不匹配在握手阶段失败，从而永远无法
/// 让旧实例退出。协议版本仍然严格校验，避免对不兼容帧格式盲发 shutdown。
pub(crate) async fn shutdown_remote_daemon(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
) -> bool {
    let now = Instant::now();
    shutdown_remote_daemon_with(
        manager,
        connection_id,
        daemon,
        true,
        now + AGENT_DAEMON_HELLO_TIMEOUT,
        now + AGENT_DAEMON_HELLO_TIMEOUT + AGENT_PING_TIMEOUT,
    )
    .await
}

/// ensure 探测里淘汰旧版本 daemon：握手与 RPC 都不越过探测总截止。
async fn shutdown_remote_daemon_until(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    deadline: Instant,
) -> bool {
    let now = Instant::now();
    let Some(hello) = daemon_step_budget(deadline, now, AGENT_DAEMON_HELLO_TIMEOUT) else {
        return false;
    };
    shutdown_remote_daemon_with(
        manager,
        connection_id,
        daemon,
        true,
        now + hello,
        deadline.min(now + hello + AGENT_PING_TIMEOUT),
    )
    .await
}

/// [`shutdown_remote_daemon`] 的实现。`ensure_daemon = false` 用于升级替换
/// 二进制之前：只连已有 daemon，缺席时不做任何事，绝不能先拉起旧版实例。
/// `hello_deadline` / `rpc_deadline` 分别限制握手与 `server.shutdown` 应答。
async fn shutdown_remote_daemon_with(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    ensure_daemon: bool,
    hello_deadline: Instant,
    rpc_deadline: Instant,
) -> bool {
    let mut channel = match open_daemon_channel_with(
        manager,
        connection_id,
        daemon,
        HelloPolicy::LENIENT,
        ensure_daemon,
        hello_deadline,
    )
    .await
    {
        Ok(channel) => channel,
        Err(_) => return false,
    };
    let result = daemon_rpc(
        &mut channel,
        "server.shutdown",
        &serde_json::json!({}),
        rpc_deadline,
    )
    .await;
    channel.shutdown().await;
    result.is_ok()
}

/// daemon 调用失败的两类：daemon 正常应答了错误，与传输层故障。
///
/// 只有传输故障说明 daemon 不可用、值得降级。业务错误（目录已删除、无权限、
/// 正则无效）是请求本身的问题：此前一并降级，文件树刷新一个刚删掉的目录就让
/// daemon 冷却 5 分钟，期间 Server 模式新建终端全部报「daemon 不可用」。
#[derive(Debug)]
pub(crate) enum DaemonCallError {
    /// daemon 回了 ERR 帧或以失败结束流：daemon 本身工作正常。
    Remote(String),
    /// 握手、收发帧、超时、解析失败等传输问题。
    Transport(String),
}

impl DaemonCallError {
    pub(crate) fn is_transport(&self) -> bool {
        matches!(self, Self::Transport(_))
    }
}

impl From<String> for DaemonCallError {
    fn from(message: String) -> Self {
        Self::Transport(message)
    }
}

impl From<DaemonCallError> for String {
    fn from(error: DaemonCallError) -> Self {
        error.to_string()
    }
}

impl std::fmt::Display for DaemonCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Remote(message) | Self::Transport(message) => f.write_str(message),
        }
    }
}

/// daemon 通道上的单请求 RPC：发 REQ、等 RES 或 ERR，返回 RES 的 result。
pub(super) async fn daemon_rpc(
    channel: &mut DaemonChannel,
    method: &str,
    params: &serde_json::Value,
    deadline: Instant,
) -> Result<serde_json::Value, DaemonCallError> {
    let request = Request::with_params(DAEMON_REQUEST_ID, method, params)
        .map_err(|error| format!("编码 daemon 请求失败：{error}"))?;
    let payload =
        proto::encode(&request).map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
    channel
        .send(&Frame::new(Kind::Req, DAEMON_REQUEST_ID, payload))
        .await?;
    loop {
        let frame = channel.next_frame(deadline).await?;
        match frame.kind {
            Kind::Res if frame.stream_id == DAEMON_REQUEST_ID => {
                let response: Response = proto::decode_value(&frame.payload)
                    .map_err(|error| format!("解析 daemon 应答失败：{error}"))?;
                return Ok(response.result);
            }
            Kind::Err if frame.stream_id == DAEMON_REQUEST_ID => {
                let body: ErrorBody = proto::decode_value(&frame.payload)
                    .map_err(|error| format!("解析 daemon 错误帧失败：{error}"))?;
                return Err(DaemonCallError::Remote(format!(
                    "daemon {method} 失败（{}）：{}",
                    body.code, body.message
                )));
            }
            _ => {}
        }
    }
}

/// daemon 通道上列出目录直接子项，替代 serve 的 scan 请求。
/// 返回 (名称, 是否目录)，交给调用方 `collect_scan_nodes` 统一组装。
pub(crate) async fn daemon_scan_entries(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    canonical_root: &str,
    relative: &str,
) -> Result<Vec<(String, bool)>, DaemonCallError> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let paged = channel.capabilities.iter().any(|cap| cap == "fs.scanPaged");
        let deadline = Instant::now() + AGENT_DAEMON_SCAN_TIMEOUT;
        let mut offset = 0usize;
        let mut parsed = Vec::new();
        loop {
            let mut params = serde_json::json!({ "root": canonical_root, "path": relative });
            if paged {
                params["offset"] = serde_json::json!(offset);
                params["limit"] = serde_json::json!(256);
            }
            let value = daemon_rpc(&mut channel, "fs.scan", &params, deadline).await?;
            let next = append_scan_page(&value, offset, &mut parsed)?;
            match next.filter(|_| paged) {
                Some(next) => offset = next,
                None => break,
            }
        }
        Ok(parsed)
    }
    .await;
    channel.shutdown().await;
    result
}

/// One bounded page for background preparation. A partial listing is never
/// presented as a complete tree; large roots are read only on explicit open.
pub(crate) async fn daemon_warmup_entries(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    canonical_root: &str,
) -> Result<Option<Vec<(String, bool)>>, DaemonCallError> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        if !channel.capabilities.iter().any(|cap| cap == "fs.scanPaged") {
            return Ok(None);
        }
        let value = daemon_rpc(
            &mut channel,
            "fs.scan",
            &serde_json::json!({
                "root": canonical_root, "path": "", "offset": 0, "limit": 256,
            }),
            Instant::now() + AGENT_DAEMON_SCAN_TIMEOUT,
        )
        .await?;
        let mut entries = Vec::new();
        let next = append_scan_page(&value, 0, &mut entries)?;
        Ok((next.is_none() && entries.len() <= 256).then_some(entries))
    }
    .await;
    channel.shutdown().await;
    result
}

fn append_scan_page(
    value: &serde_json::Value,
    offset: usize,
    parsed: &mut Vec<(String, bool)>,
) -> Result<Option<usize>, DaemonCallError> {
    let entries = value
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| DaemonCallError::from("daemon scan 应答缺少 entries".to_string()))?;
    if value.get("truncated").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err(DaemonCallError::from(
            "daemon scan 目录结果不完整".to_string(),
        ));
    }
    let next = match value.get("nextOffset") {
        None | Some(serde_json::Value::Null) => None,
        Some(next) => {
            let next = next
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .filter(|next| *next > offset && *next == offset.saturating_add(entries.len()))
                .ok_or_else(|| DaemonCallError::from("daemon scan 分页偏移无效".to_string()))?;
            Some(next)
        }
    };
    for entry in entries {
        let name = entry
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| DaemonCallError::from("daemon scan 条目缺少名称".to_string()))?;
        let is_dir = entry
            .get("isDir")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        parsed.push((name.to_string(), is_dir));
    }
    Ok(next)
}

/// daemon 通道的内容搜索参数，与 daemon 的 `search.content` 方法一一对应。
pub(crate) struct DaemonSearchParams {
    pub root: String,
    pub query: String,
    pub ignore_case: bool,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub no_ignore: bool,
    pub max_matches: usize,
    pub max_per_file: usize,
    pub max_files: usize,
}

/// STREAM_DATA 分片重组：搜索是「记录流」（`seq` 为空，`last` 标记记录末块）。
/// SSH 通道保证字节有序，分片按到达顺序拼接即可，`offset` 只作校验用途。
#[derive(Default)]
struct RecordAssembler {
    buffer: Vec<u8>,
}

impl RecordAssembler {
    /// 追加一个分片；记录完整时返回整段字节并清空缓冲。
    fn push(&mut self, chunk: &StreamChunk) -> Option<Vec<u8>> {
        self.buffer.extend_from_slice(&chunk.data);
        chunk.last.then(|| std::mem::take(&mut self.buffer))
    }
}

/// daemon 通道上的流式内容搜索，替代 serve 的 searchContent：
/// STREAM_DATA 分片重组为 rg `--json` 同形记录（MessagePack 编码的 JSON 值），
/// 逐条交给 on_record（返回 false 即提前结束）。取消时发 CANCEL 帧后继续
/// 读到 STREAM_END，让 daemon 干净收尾；返回值语义与 serve 路径的
/// [`server_stream_call`] 一致，调用方共用同一条回退链。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn daemon_search_content_call(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    params: DaemonSearchParams,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
    mut on_record: impl FnMut(&serde_json::Value) -> bool,
) -> Result<ServerStreamOutcome, DaemonCallError> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let request = Request::with_params(
            DAEMON_REQUEST_ID,
            "search.content",
            &serde_json::json!({
                "root": params.root,
                "query": params.query,
                "ignoreCase": params.ignore_case,
                "includeGlobs": params.include_globs,
                "excludeGlobs": params.exclude_globs,
                "noIgnore": params.no_ignore,
                "maxMatches": params.max_matches,
                "maxPerFile": params.max_per_file,
                "maxFiles": params.max_files,
            }),
        )
        .map_err(|error| format!("编码 daemon 请求失败：{error}"))?;
        let payload =
            proto::encode(&request).map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
        channel
            .send(&Frame::new(Kind::Req, DAEMON_REQUEST_ID, payload))
            .await?;

        // daemon 发送侧有 256KB 信用窗口：消费后按半个窗口回补 WINDOW 帧，
        // 否则长流会在窗口耗尽时被卡死（serve 路径无流控，协议 v1 要求）。
        let mut receiver = ReceiverWindow::new(WINDOW_BYTES);
        let mut assembler = RecordAssembler::default();
        // CANCEL 已发出：继续读到 STREAM_END 让远端收尾，不再消费记录。
        let mut stopping = false;
        loop {
            if !stopping && cancelled() {
                channel
                    .send(&Frame::empty(Kind::Cancel, DAEMON_REQUEST_ID))
                    .await?;
                stopping = true;
            }
            if Instant::now() >= deadline {
                if stopping {
                    // CANCEL 已发但远端迟迟不收尾：放弃等待，通道随关闭收尾。
                    return Ok(ServerStreamOutcome::Stopped);
                }
                return Err("server 操作超时".to_string().into());
            }
            let frame = channel.next_frame(deadline).await?;
            match frame.kind {
                Kind::StreamData if frame.stream_id == DAEMON_REQUEST_ID => {
                    if let Some(credit) = receiver.consume(frame.payload.len()) {
                        let payload = proto::encode(&WindowCredit { credit })
                            .map_err(|error| format!("编码 WINDOW 帧失败：{error}"))?;
                        let _ = channel
                            .send(&Frame::new(Kind::Window, DAEMON_REQUEST_ID, payload))
                            .await;
                    }
                    if stopping {
                        continue;
                    }
                    let chunk: StreamChunk = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 流分片失败：{error}"))?;
                    if let Some(record) = assembler.push(&chunk) {
                        let value: serde_json::Value = proto::decode_value(&record)
                            .map_err(|error| format!("解析 daemon 搜索记录失败：{error}"))?;
                        if !on_record(&value) {
                            channel
                                .send(&Frame::empty(Kind::Cancel, DAEMON_REQUEST_ID))
                                .await?;
                            stopping = true;
                        }
                    }
                }
                Kind::StreamEnd if frame.stream_id == DAEMON_REQUEST_ID => {
                    let end: StreamEnd = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 流结束帧失败：{error}"))?;
                    if stopping {
                        return Ok(ServerStreamOutcome::Stopped);
                    }
                    if !end.ok {
                        return Err(DaemonCallError::Remote(
                            end.error.unwrap_or_else(|| "daemon 搜索失败".to_string()),
                        ));
                    }
                    return Ok(ServerStreamOutcome::Done {
                        truncated: end
                            .summary
                            .get("truncated")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        files_scanned: end
                            .summary
                            .get("filesScanned")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as usize,
                    });
                }
                Kind::Err if frame.stream_id == DAEMON_REQUEST_ID => {
                    let body: ErrorBody = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 错误帧失败：{error}"))?;
                    return Err(DaemonCallError::Remote(format!(
                        "daemon 搜索失败（{}）：{}",
                        body.code, body.message
                    )));
                }
                _ => {}
            }
        }
    }
    .await;
    channel.shutdown().await;
    result
}

/// daemon 降级冷却是否到点。`None`（从未降级）不需要重试。
pub(super) fn daemon_downgrade_retry_ready(downgraded_at: Option<Instant>, now: Instant) -> bool {
    downgraded_at.is_some_and(|at| now.duration_since(at) >= AGENT_DAEMON_RETRY_AFTER_DOWNGRADE)
}

#[cfg(test)]
mod tests;
