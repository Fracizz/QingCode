//! 协议 v1：帧编解码、MessagePack 消息、信用窗口与发送优先级。
//!
//! 与旧的 `serve` 路径（`lib.rs` 的 4 字节小端长度 + JSON + 每操作一条连接）并存：
//! 新路径用于 `daemon` / `connect --stdio`，一条连接上多路复用所有请求与流。
//!
//! 帧格式（设计 §5.1）：
//!
//! ```text
//! frame := u32_be length | u8 kind | u32_be stream_id | payload
//! ```
//!
//! `length` 是**长度字段之后**的字节数，即 `1 + 4 + payload.len()`。这样取值域是
//! `5..=MAX_FRAME_BYTES`：0 或超过 1MB 一律按协议错误断开连接。选这种定义是因为
//! 纯控制帧（PING/PONG/CANCEL）可以不带 `payload`，不必为它们编一个空 MessagePack 值。
//!
//! `payload` 一律是 MessagePack（`rmp-serde`），字节数据用 `serde_bytes` 走 `bin`
//! 类型原样放入，不做 base64。

use std::collections::VecDeque;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Semaphore;

/// 协议主版本。客户端在 HELLO 里声明 `[protocol_min, protocol_max]`，daemon 回报实际值。
pub const PROTOCOL_VERSION: u32 = 1;

/// 本实现能接受的最低协议版本（向后兼容 2 个次版本的设计预留位）。
pub const PROTOCOL_MIN: u32 = 1;

/// 单帧上限（`length` 字段的取值范围上限）。超限直接断开，不再读取剩余字节。
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// 长度字段之后的固定表头：kind(1) + stream_id(4)。
pub const BODY_HEADER_BYTES: usize = 5;

/// 完整帧的固定开销：长度字段(4) + kind(1) + stream_id(4)。
pub const FRAME_HEADER_BYTES: usize = 4 + BODY_HEADER_BYTES;

/// 大数据切片：`STREAM_DATA` 每块最多 64KB。
pub const STREAM_CHUNK_BYTES: usize = 64 * 1024;

/// 每个流的初始信用窗口（字节）。
pub const WINDOW_BYTES: usize = 256 * 1024;

/// 心跳间隔与判定断开阈值（设计 §5.1：15s 发 PING，45s 收不到任何帧即断开）。
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);

/// 连接级控制流（不属于任何请求）固定用 0 号流。
pub const CONTROL_STREAM: u32 = 0;

/// 帧类型。数值即线上编码，**不得复用**：删除的类型要留空号。
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Hello = 1,
    Req = 2,
    Res = 3,
    Err = 4,
    Event = 5,
    StreamData = 6,
    StreamEnd = 7,
    Window = 8,
    Cancel = 9,
    Ping = 10,
    Pong = 11,
}

impl Kind {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Hello),
            2 => Some(Self::Req),
            3 => Some(Self::Res),
            4 => Some(Self::Err),
            5 => Some(Self::Event),
            6 => Some(Self::StreamData),
            7 => Some(Self::StreamEnd),
            8 => Some(Self::Window),
            9 => Some(Self::Cancel),
            10 => Some(Self::Ping),
            11 => Some(Self::Pong),
            _ => None,
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }

    /// 日志用名字，避免往 `server.log` 里写裸数字。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hello => "HELLO",
            Self::Req => "REQ",
            Self::Res => "RES",
            Self::Err => "ERR",
            Self::Event => "EVENT",
            Self::StreamData => "STREAM_DATA",
            Self::StreamEnd => "STREAM_END",
            Self::Window => "WINDOW",
            Self::Cancel => "CANCEL",
            Self::Ping => "PING",
            Self::Pong => "PONG",
        }
    }
}

/// 一帧。`payload` 可为空（PING/PONG/CANCEL），非空时是 MessagePack。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: Kind,
    pub stream_id: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: Kind, stream_id: u32, payload: Vec<u8>) -> Self {
        Self {
            kind,
            stream_id,
            payload,
        }
    }

    /// 不带负载的控制帧。
    pub fn empty(kind: Kind, stream_id: u32) -> Self {
        Self::new(kind, stream_id, Vec::new())
    }

    /// 编码成可直接写入的字节（长度字段 + 表头 + 负载）。
    pub fn encode(&self) -> io::Result<Vec<u8>> {
        let body = BODY_HEADER_BYTES + self.payload.len();
        if body > MAX_FRAME_BYTES {
            return Err(invalid(format!(
                "帧过大: {body} 字节，上限 {MAX_FRAME_BYTES}"
            )));
        }
        let mut out = Vec::with_capacity(4 + body);
        out.extend_from_slice(&(body as u32).to_be_bytes());
        out.push(self.kind.as_u8());
        out.extend_from_slice(&self.stream_id.to_be_bytes());
        out.extend_from_slice(&self.payload);
        Ok(out)
    }
}

/// 从缓冲区里解出一帧，返回（帧, 已消费字节数）。
///
/// 半帧返回 `UnexpectedEof`（调用方继续读即可），长度非法或类型未知返回
/// `InvalidData`（必须断开连接）。
pub fn decode(buf: &[u8]) -> io::Result<(Frame, usize)> {
    if buf.len() < 4 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "半帧：缺少长度字段",
        ));
    }
    let body = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if !(BODY_HEADER_BYTES..=MAX_FRAME_BYTES).contains(&body) {
        return Err(invalid(format!("非法帧长度: {body}")));
    }
    let total = 4 + body;
    if buf.len() < total {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "半帧：负载未读满",
        ));
    }
    let Some(kind) = Kind::from_u8(buf[4]) else {
        return Err(invalid(format!("未知帧类型: {}", buf[4])));
    };
    let stream_id = u32::from_be_bytes([buf[5], buf[6], buf[7], buf[8]]);
    Ok((
        Frame {
            kind,
            stream_id,
            payload: buf[9..total].to_vec(),
        },
        total,
    ))
}

/// 从异步读端读一帧。读端 EOF 时返回 `UnexpectedEof`。
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Frame> {
    let mut header = [0u8; FRAME_HEADER_BYTES];
    reader.read_exact(&mut header[..4]).await?;
    let body = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
    if !(BODY_HEADER_BYTES..=MAX_FRAME_BYTES).contains(&body) {
        return Err(invalid(format!("非法帧长度: {body}")));
    }
    reader.read_exact(&mut header[4..]).await?;
    let Some(kind) = Kind::from_u8(header[4]) else {
        return Err(invalid(format!("未知帧类型: {}", header[4])));
    };
    let stream_id = u32::from_be_bytes([header[5], header[6], header[7], header[8]]);
    let mut payload = vec![0u8; body - BODY_HEADER_BYTES];
    reader.read_exact(&mut payload).await?;
    Ok(Frame {
        kind,
        stream_id,
        payload,
    })
}

/// 写一帧并 flush。调用方应串行化写入（单个 writer 任务）。
pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) -> io::Result<()> {
    let bytes = frame.encode()?;
    writer.write_all(&bytes).await?;
    writer.flush().await
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

// ---------------------------------------------------------------------------
// MessagePack 负载
// ---------------------------------------------------------------------------

/// 按 MessagePack 的 named 形式编码（结构体 → map），便于跨语言与字段演进。
pub fn encode<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    rmp_serde::to_vec_named(value).map_err(|e| invalid(format!("MessagePack 编码失败: {e}")))
}

/// 解码 MessagePack 负载。长度或类型不符都按协议错误处理。
pub fn decode_value<T: DeserializeOwned>(payload: &[u8]) -> io::Result<T> {
    rmp_serde::from_slice(payload).map_err(|e| invalid(format!("MessagePack 解码失败: {e}")))
}

/// 握手首帧：客户端在 10s 内必须发出，之后才允许其他帧。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloRequest {
    /// 每个 QingCode 安装实例固定的随机 ID，用来接回自己留下的终端。
    pub client_id: String,
    pub protocol_min: u32,
    pub protocol_max: u32,
    /// `run/token` 的内容。校验失败直接断开。
    pub token: String,
    /// 应用重启后希望接回的会话标识（本期只做透传，不用作鉴权）。
    #[serde(default)]
    pub resume_token: Option<String>,
}

/// 握手应答：能力协商结果，客户端据此开关功能。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    /// daemon 选定并将在整条连接上使用的协议版本。
    pub protocol: u32,
    pub server_version: String,
    pub pid: u32,
    pub os: String,
    pub arch: String,
    /// 家目录，供客户端默认 cwd 使用；不可判定时为 None。
    #[serde(default)]
    pub home: Option<String>,
    /// 可用 shell 名字（登录 shell 优先）。
    #[serde(default)]
    pub shells: Vec<String>,
    pub capabilities: Vec<String>,
    /// 当前存活的 PTY 数量，方便客户端决定是否提示「远端还有 N 个终端」。
    pub pty_count: usize,
}

/// 请求：`id` 在连接内唯一，`RES`/`ERR` 用它回指。
///
/// `params` 不是 JSON，而是一段**独立的 MessagePack 文档**（外层用 `bin` 包裹）：
/// 这样终端输入、文件块等二进制字段能保持 `bin` 类型，不必经 JSON 数组中转。
/// 每个方法用 [`decode_value`] 解成自己的参数结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: u32,
    pub method: String,
    #[serde(default, with = "serde_bytes")]
    pub params: Vec<u8>,
}

impl Request {
    /// 用任意可序列化结构做参数。
    pub fn with_params<T: Serialize>(
        id: u32,
        method: impl Into<String>,
        params: &T,
    ) -> io::Result<Self> {
        Ok(Self {
            id,
            method: method.into(),
            params: encode(params)?,
        })
    }

    /// 无参数请求。
    pub fn empty(id: u32, method: impl Into<String>) -> Self {
        Self {
            id,
            method: method.into(),
            params: Vec::new(),
        }
    }

    /// 解出方法参数。
    pub fn parse<T: DeserializeOwned>(&self) -> io::Result<T> {
        decode_value(&self.params)
    }
}

/// 非流式请求的成功应答。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub id: u32,
    #[serde(default)]
    pub result: serde_json::Value,
}

/// 失败应答（`ERR`）。`code` 是稳定的机器可读分类，`message` 给人看。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub id: u32,
    pub code: String,
    pub message: String,
}

/// 流结束（`STREAM_END`）。`summary` 放统计字段，如 `{ truncated, filesScanned }`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEnd {
    pub ok: bool,
    #[serde(default)]
    pub summary: serde_json::Value,
    #[serde(default)]
    pub error: Option<String>,
}

/// 推送事件（`EVENT`）。用内部标签区分种类，字节字段走 `bin`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum Event {
    /// 终端输出。`seq` 单调递增，客户端据此判断是否需要补发。
    ///
    /// 单个 ring 段超过 [`STREAM_CHUNK_BYTES`] 时会被拆成多条事件：
    /// `seq` 相同、`offset` 从 0 递增，客户端按序拼接即可。
    PtyData {
        id: String,
        seq: u64,
        #[serde(default)]
        offset: u32,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    /// 终端进程退出；`code` 为 None 表示被信号结束或无法判定。
    PtyExit { id: String, code: Option<i32> },
    /// 文件变更，字段与主程序 `file_watcher.rs` 的事件一致。
    FsChange {
        path: String,
        kind: String,
        is_dir: bool,
    },
}

/// `STREAM_DATA` 负载：一个逻辑数据块的分片。
///
/// 两类流共用一个结构：
/// - 搜索结果是「记录流」：`seq` 为空，`data` 是一条记录编码后的字节，
///   `offset` 是这条记录内的字节偏移，`last` 标记记录末块；
/// - 终端补发是「字节流」：`seq` 是 ring 段的序号，`offset` 是段内偏移，
///   `last` 标记该段末块。
///
/// 分片统一 64KB，客户端必须按 `offset` 顺序拼接、遇到 `last` 才解码。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default)]
    pub offset: u32,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    #[serde(default)]
    pub last: bool,
}

/// 把一段字节切成不超过 [`STREAM_CHUNK_BYTES`] 的分片，`seq` 原样带到每一片。
pub fn split_chunks(data: &[u8], seq: Option<u64>) -> Vec<StreamChunk> {
    if data.is_empty() {
        return vec![StreamChunk {
            seq,
            offset: 0,
            data: Vec::new(),
            last: true,
        }];
    }
    let mut chunks = Vec::with_capacity(data.len().div_ceil(STREAM_CHUNK_BYTES));
    for (index, piece) in data.chunks(STREAM_CHUNK_BYTES).enumerate() {
        let offset = index * STREAM_CHUNK_BYTES;
        chunks.push(StreamChunk {
            seq,
            offset: offset as u32,
            data: piece.to_vec(),
            last: offset + piece.len() == data.len(),
        });
    }
    chunks
}

/// `WINDOW` 负载。流号在帧头里，这里只回补信用字节数。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowCredit {
    pub credit: u32,
}

// ---------------------------------------------------------------------------
// 流控
// ---------------------------------------------------------------------------

/// 发送侧信用窗口。
///
/// 语义（发送方必须遵守）：
/// - 新流创建时窗口 = [`WINDOW_BYTES`]，双方对这一初始值有共识，不需要先发 WINDOW；
/// - 每次要发 `STREAM_DATA` 前先 `acquire(n)`，n 是即将发送的负载字节数（不含帧头）；
/// - 对端每消费 n 字节回一个 `WINDOW{credit:n}`，`replenish` 把信用还回来；
/// - 窗口总量不会超过 `capacity`。对端超发的 credit 被静默截断（协议错误，但
///   不影响已排队数据的顺序，记日志即可）。
///
/// 实现用 `Semaphore` 计数：`acquire` 拿到的 permit 立即 `forget()`，
/// 表示这部分信用被永久消耗，只能靠对端 WINDOW 归还。
pub struct SenderWindow {
    permits: Arc<Semaphore>,
    capacity: usize,
}

impl SenderWindow {
    pub fn new(capacity: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(capacity)),
            capacity,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// 剩余可用信用（近似值：并发 acquire/replenish 时可能瞬时不准）。
    pub fn available(&self) -> usize {
        self.permits.available_permits()
    }

    /// 等待信用。`bytes` 超过窗口容量说明调用方切块过大，直接报错而不是死等。
    pub async fn acquire(&self, bytes: usize) -> io::Result<()> {
        if bytes == 0 {
            return Ok(());
        }
        if bytes > self.capacity {
            return Err(invalid(format!(
                "单次发送 {bytes} 字节超过窗口容量 {}",
                self.capacity
            )));
        }
        let Ok(bytes) = u32::try_from(bytes) else {
            return Err(invalid("单次发送长度溢出"));
        };
        let permit = self
            .permits
            .clone()
            .acquire_many_owned(bytes)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "流控窗口已关闭"))?;
        // 信用被消耗，不能随 permit 归还。
        permit.forget();
        Ok(())
    }

    /// 非阻塞版本，主要给单测和「有信用就发、没有就排队」的场景用。
    pub fn try_acquire(&self, bytes: usize) -> bool {
        match u32::try_from(bytes) {
            Ok(bytes) if bytes > 0 && bytes as usize <= self.capacity => self
                .permits
                .try_acquire_many(bytes)
                .map(|permit| permit.forget())
                .is_ok(),
            _ => false,
        }
    }

    /// 对端消费后归还信用。超出容量的部分截断。
    pub fn replenish(&self, credit: usize) {
        if credit == 0 {
            return;
        }
        let available = self.permits.available_permits();
        let room = self.capacity.saturating_sub(available);
        let add = credit.min(room);
        if add > 0 {
            self.permits.add_permits(add);
        }
    }
}

/// 接收侧窗口：记录「已消费但还没回补」的字节数，攒到半个窗口就回一个 WINDOW。
///
/// 攒批而不是逐块回补，是为了让 64KB 分块的长流不产生等量的控制帧。
pub struct ReceiverWindow {
    capacity: usize,
    unacked: usize,
}

impl ReceiverWindow {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            unacked: 0,
        }
    }

    /// 记录消费。返回需要回补的 credit（`None` 表示还没攒够）。
    pub fn consume(&mut self, bytes: usize) -> Option<u32> {
        self.unacked = self.unacked.saturating_add(bytes);
        let threshold = (self.capacity / 2).max(1);
        if self.unacked < threshold {
            return None;
        }
        let credit = u32::try_from(self.unacked).unwrap_or(u32::MAX);
        self.unacked = 0;
        Some(credit)
    }

    pub fn pending(&self) -> usize {
        self.unacked
    }
}

// ---------------------------------------------------------------------------
// 发送优先级
// ---------------------------------------------------------------------------

/// 发送优先级。数值越大越先发。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    /// 批量数据：搜索结果、传输、大文件读。
    Bulk = 0,
    /// 普通 RPC 应答。
    Rpc = 1,
    /// 终端输入输出。
    Terminal = 2,
    /// 控制帧：握手、WINDOW、CANCEL、PING/PONG、错误。
    Control = 3,
}

impl Priority {
    /// 按帧类型定级。REQ/EVENT 的定级由调用方用 [`OutboundQueue::push_with`] 覆盖：
    /// 终端输入是 REQ，但必须走 Terminal 档；搜索结果按 REQ 进来、按 Bulk 出去。
    pub fn of(kind: Kind) -> Self {
        match kind {
            Kind::Hello
            | Kind::Res
            | Kind::Err
            | Kind::Window
            | Kind::Cancel
            | Kind::Ping
            | Kind::Pong
            | Kind::StreamEnd => Self::Control,
            Kind::StreamData => Self::Bulk,
            Kind::Req | Kind::Event => Self::Rpc,
        }
    }
}

/// 待发帧队列。
///
/// 近似之处（与设计 §5.1「按优先级轮转发帧」的差异）：
/// - 这里做的是**严格优先级 + 批量保底**：控制帧永远先发，终端次之，RPC 再次，
///   批量数据最后。设计里的「轮转」要求每条连接维护完整的公平调度器，而实际约束
///   是「终端回显延迟不超过发送一块数据的时间」，严格优先级已经满足；
/// - 为避免长连接上的批量流被持续的控制/终端帧饿死，每发 8 帧高优先级就强制放行
///   1 个批量帧（`BULK_QUOTA`）；
/// - 同一优先级内保持入队顺序（FIFO），不做进一步细分。
pub struct OutboundQueue {
    control: VecDeque<Frame>,
    terminal: VecDeque<Frame>,
    rpc: VecDeque<Frame>,
    bulk: VecDeque<Frame>,
    bytes: usize,
    high_streak: u32,
}

impl Default for OutboundQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl OutboundQueue {
    /// 队列字节上限：写端被对端窗口卡住时，防止订阅类事件在内存里无限堆积。
    pub const MAX_BYTES: usize = 8 * 1024 * 1024;

    /// 每放行这么多帧高优先级，强制放行 1 个批量帧。
    const BULK_QUOTA: u32 = 8;

    pub fn new() -> Self {
        Self {
            control: VecDeque::new(),
            terminal: VecDeque::new(),
            rpc: VecDeque::new(),
            bulk: VecDeque::new(),
            bytes: 0,
            high_streak: 0,
        }
    }

    /// 按帧类型自动定级。
    pub fn push(&mut self, frame: Frame) -> io::Result<()> {
        let priority = Priority::of(frame.kind);
        self.push_with(priority, frame)
    }

    pub fn push_with(&mut self, priority: Priority, frame: Frame) -> io::Result<()> {
        let size = FRAME_HEADER_BYTES + frame.payload.len();
        if self.bytes + size > Self::MAX_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "发送队列已满，请稍后重试",
            ));
        }
        self.bytes += size;
        match priority {
            Priority::Control => self.control.push_back(frame),
            Priority::Terminal => self.terminal.push_back(frame),
            Priority::Rpc => self.rpc.push_back(frame),
            Priority::Bulk => self.bulk.push_back(frame),
        }
        Ok(())
    }

    pub fn pop(&mut self) -> Option<Frame> {
        let frame = self.pick()?;
        self.bytes -= FRAME_HEADER_BYTES + frame.payload.len();
        Some(frame)
    }

    pub fn is_empty(&self) -> bool {
        self.bytes == 0
    }

    pub fn len(&self) -> usize {
        self.control.len() + self.terminal.len() + self.rpc.len() + self.bulk.len()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// 按优先级取下一帧；连续放行高优先级帧达到配额后强制插一个批量帧。
    fn pick(&mut self) -> Option<Frame> {
        if !self.bulk.is_empty() && self.high_streak >= Self::BULK_QUOTA {
            self.high_streak = 0;
            return self.bulk.pop_front();
        }
        if let Some(frame) = self.control.pop_front() {
            self.high_streak += 1;
            return Some(frame);
        }
        if let Some(frame) = self.terminal.pop_front() {
            self.high_streak += 1;
            return Some(frame);
        }
        if let Some(frame) = self.rpc.pop_front() {
            self.high_streak += 1;
            return Some(frame);
        }
        self.high_streak = 0;
        self.bulk.pop_front()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_preserves_kind_stream_and_payload() {
        let frame = Frame::new(Kind::StreamData, 7, vec![1, 2, 3]);
        let bytes = frame.encode().unwrap();
        assert_eq!(
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize,
            BODY_HEADER_BYTES + 3
        );
        let (decoded, consumed) = decode(&bytes).unwrap();
        assert_eq!(decoded, frame);
        assert_eq!(consumed, bytes.len());
    }

    #[test]
    fn decode_accepts_trailing_bytes_for_the_next_frame() {
        let a = Frame::empty(Kind::Ping, 0);
        let b = Frame::new(Kind::Pong, 1, vec![9]);
        let mut bytes = a.encode().unwrap();
        bytes.extend_from_slice(&b.encode().unwrap());
        let (first, used) = decode(&bytes).unwrap();
        assert_eq!(first, a);
        let (second, _) = decode(&bytes[used..]).unwrap();
        assert_eq!(second, b);
    }

    #[test]
    fn decode_rejects_zero_and_oversized_lengths() {
        let zero = 0u32.to_be_bytes();
        assert_eq!(
            decode(&zero).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let oversized = u32::try_from(MAX_FRAME_BYTES + 1).unwrap().to_be_bytes();
        assert_eq!(
            decode(&oversized).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn decode_rejects_unknown_kind() {
        let mut bytes = vec![0u8; 9];
        bytes[..4].copy_from_slice(&5u32.to_be_bytes());
        bytes[4] = 0x7f;
        let error = decode(&bytes).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("未知帧类型"));
    }

    #[test]
    fn decode_reports_half_frames_without_consuming() {
        let frame = Frame::new(Kind::Req, 3, vec![7; 32]);
        let bytes = frame.encode().unwrap();
        // 表头都没齐。
        assert_eq!(
            decode(&bytes[..3]).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        // 表头齐了、负载没齐。
        assert_eq!(
            decode(&bytes[..bytes.len() - 1]).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn encode_rejects_payload_over_limit() {
        let frame = Frame::new(Kind::StreamData, 1, vec![0u8; MAX_FRAME_BYTES]);
        assert_eq!(
            frame.encode().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[tokio::test]
    async fn async_read_write_roundtrip_over_duplex() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let frame = Frame::new(
            Kind::Event,
            11,
            encode(&Event::FsChange {
                path: "/a".into(),
                kind: "any".into(),
                is_dir: false,
            })
            .unwrap(),
        );
        write_frame(&mut client, &frame).await.unwrap();
        let read = read_frame(&mut server).await.unwrap();
        assert_eq!(read, frame);
    }

    #[tokio::test]
    async fn async_read_frame_fails_on_half_frame_eof() {
        let (mut client, mut server) = tokio::io::duplex(64);
        client.write_all(&[0, 0, 0, 9, 2, 0]).await.unwrap();
        drop(client);
        let error = read_frame(&mut server).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn request_and_response_use_msgpack_maps() {
        let request =
            Request::with_params(1, "fs.scan", &serde_json::json!({ "path": "src" })).unwrap();
        let payload = encode(&request).unwrap();
        let decoded: Request = decode_value(&payload).unwrap();
        assert_eq!(decoded.method, "fs.scan");
        assert_eq!(decoded.parse::<serde_json::Value>().unwrap()["path"], "src");

        let response = Response {
            id: 1,
            result: serde_json::json!({ "ok": true }),
        };
        let decoded: Response = decode_value(&encode(&response).unwrap()).unwrap();
        assert_eq!(decoded.id, 1);
    }

    #[tokio::test]
    async fn sender_window_blocks_until_replenished() {
        let window = SenderWindow::new(64);
        assert_eq!(window.available(), 64);
        window.acquire(48).await.unwrap();
        assert_eq!(window.available(), 16);
        // 剩余信用不足：必须等待，而不是超发。
        let blocked = tokio::time::timeout(Duration::from_millis(50), window.acquire(32)).await;
        assert!(blocked.is_err(), "窗口无信用时不应放行");
        window.replenish(48);
        window.acquire(32).await.unwrap();
        assert_eq!(window.available(), 32);
    }

    #[test]
    fn sender_window_replenish_never_exceeds_capacity() {
        let window = SenderWindow::new(100);
        window.replenish(1000);
        assert_eq!(window.available(), 100);
        window.replenish(0);
        assert_eq!(window.available(), 100);
    }

    #[tokio::test]
    async fn sender_window_rejects_oversized_chunk() {
        let window = SenderWindow::new(1024);
        let error = window.acquire(2048).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(!window.try_acquire(2048));
        assert!(window.try_acquire(1024));
    }

    #[test]
    fn receiver_window_batches_credit_at_half_capacity() {
        let mut window = ReceiverWindow::new(1024);
        // 半个窗口是 512：不足不回补。
        assert_eq!(window.consume(511), None);
        assert_eq!(window.pending(), 511);
        assert_eq!(window.consume(1), Some(512));
        assert_eq!(window.pending(), 0);
        assert_eq!(window.consume(4096), Some(4096));
    }

    #[test]
    fn outbound_queue_sends_control_before_terminal_before_bulk() {
        let mut queue = OutboundQueue::new();
        queue
            .push_with(Priority::Bulk, Frame::new(Kind::StreamData, 1, vec![0; 8]))
            .unwrap();
        queue
            .push_with(Priority::Rpc, Frame::new(Kind::Res, 2, vec![]))
            .unwrap();
        queue
            .push_with(
                Priority::Terminal,
                Frame::new(Kind::Req, 3, b"key".to_vec()),
            )
            .unwrap();
        queue.push(Frame::empty(Kind::Ping, 0)).unwrap();

        assert_eq!(queue.pop().unwrap().kind, Kind::Ping);
        assert_eq!(queue.pop().unwrap().stream_id, 3);
        assert_eq!(queue.pop().unwrap().kind, Kind::Res);
        assert_eq!(queue.pop().unwrap().kind, Kind::StreamData);
        assert!(queue.pop().is_none());
        assert!(queue.is_empty());
        assert_eq!(queue.bytes(), 0);
    }

    #[test]
    fn outbound_queue_gives_bulk_a_slot_after_quota() {
        let mut queue = OutboundQueue::new();
        queue
            .push_with(Priority::Bulk, Frame::new(Kind::StreamData, 1, vec![0; 4]))
            .unwrap();
        for index in 0..OutboundQueue::BULK_QUOTA {
            queue.push(Frame::empty(Kind::Pong, 100 + index)).unwrap();
        }
        // 高优先级先走满配额。
        for _ in 0..OutboundQueue::BULK_QUOTA {
            assert_eq!(queue.pop().unwrap().kind, Kind::Pong);
        }
        // 配额用尽：放行 1 个批量帧，避免长连接上批量流饿死。
        assert_eq!(queue.pop().unwrap().kind, Kind::StreamData);
    }

    #[test]
    fn outbound_queue_refuses_to_grow_past_limit() {
        let mut queue = OutboundQueue::new();
        let chunk = Frame::new(Kind::StreamData, 1, vec![0; 1024 * 1024 - 9]);
        let mut pushed = 0;
        while queue.push(chunk.clone()).is_ok() {
            pushed += 1;
            assert!(pushed <= OutboundQueue::MAX_BYTES, "队列未在上限处拒绝");
        }
        assert_eq!(
            queue.pop().unwrap().kind,
            Kind::StreamData,
            "已入队的帧应可正常取出"
        );
    }

    #[test]
    fn stream_data_priority_is_bulk_and_terminal_req_can_override() {
        assert_eq!(Priority::of(Kind::StreamData), Priority::Bulk);
        assert_eq!(Priority::of(Kind::Ping), Priority::Control);
        assert_eq!(Priority::of(Kind::Cancel), Priority::Control);
        assert_eq!(Priority::of(Kind::Event), Priority::Rpc);

        let mut queue = OutboundQueue::new();
        // 终端输入是 REQ，但必须走 Terminal 档才能压过搜索结果。
        queue
            .push_with(Priority::Terminal, Frame::new(Kind::Req, 1, b"ls".to_vec()))
            .unwrap();
        queue
            .push_with(Priority::Bulk, Frame::new(Kind::StreamData, 2, vec![]))
            .unwrap();
        assert_eq!(queue.pop().unwrap().stream_id, 1);
    }

    #[test]
    fn cancel_and_ping_frames_carry_no_payload() {
        let cancel = Frame::empty(Kind::Cancel, 42);
        let (decoded, _) = decode(&cancel.encode().unwrap()).unwrap();
        assert_eq!(decoded.kind, Kind::Cancel);
        assert_eq!(decoded.stream_id, 42);
        assert!(decoded.payload.is_empty());

        let ping = Frame::empty(Kind::Ping, CONTROL_STREAM);
        let (decoded, _) = decode(&ping.encode().unwrap()).unwrap();
        assert_eq!(decoded.kind, Kind::Ping);
        assert!(decoded.payload.is_empty());
    }

    #[test]
    fn request_params_keep_binary_payload_as_bin() {
        #[derive(Serialize, Deserialize, Debug, PartialEq)]
        struct Input {
            id: String,
            #[serde(with = "serde_bytes")]
            data: Vec<u8>,
        }
        let original = Input {
            id: "pty-1".into(),
            data: vec![0, 1, 2, 0xff],
        };
        let request = Request::with_params(9, "pty.input", &original).unwrap();
        // 外层 params 是 bin，内层是独立 MessagePack 文档（fixmap）。
        assert_eq!(request.params[0] & 0xf0, 0x80);
        let decoded: Request = decode_value(&encode(&request).unwrap()).unwrap();
        assert_eq!(decoded.parse::<Input>().unwrap(), original);
    }

    #[test]
    fn split_chunks_marks_offsets_and_last_piece() {
        let data = vec![7u8; STREAM_CHUNK_BYTES + 10];
        let chunks = split_chunks(&data, Some(5));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].offset, 0);
        assert_eq!(chunks[0].data.len(), STREAM_CHUNK_BYTES);
        assert!(!chunks[0].last);
        assert_eq!(chunks[1].offset, STREAM_CHUNK_BYTES as u32);
        assert_eq!(chunks[1].data.len(), 10);
        assert!(chunks[1].last);
        assert_eq!(chunks[1].seq, Some(5));

        // 空数据也要出一片，客户端才能按 last 结束拼接。
        let empty = split_chunks(&[], None);
        assert_eq!(empty.len(), 1);
        assert!(empty[0].last);
        assert!(empty[0].data.is_empty());
    }

    #[test]
    fn hello_roundtrip_negotiates_protocol_fields() {
        let hello = HelloResponse {
            protocol: PROTOCOL_VERSION,
            server_version: "0.1.13".into(),
            pid: 42,
            os: "linux".into(),
            arch: "x86_64".into(),
            home: Some("/home/dev".into()),
            shells: vec!["bash".into()],
            capabilities: vec!["fs.scan".into(), "pty.persist".into()],
            pty_count: 0,
        };
        let decoded: HelloResponse = decode_value(&encode(&hello).unwrap()).unwrap();
        assert_eq!(decoded.protocol, PROTOCOL_VERSION);
        assert_eq!(decoded.capabilities.len(), 2);
    }
}
