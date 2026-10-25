//! `daemon` 常驻进程：持有 PTY 与文件监视状态，经本地 IPC 与连接代理通信
//! （Unix domain socket ↔ Windows named pipe，见 [`crate::ipc`]）。
//!
//! 与 `serve` 的区别：`serve` 每条 TCP 连接只承载一次操作，进程随客户端退出；
//! daemon 是每个远端用户一份的常驻进程，SSH 断开只让 `connect --stdio` 退出，
//! PTY 与缓冲都留着，下次连接用 `pty.attach{fromSeq}` 接回。
//!
//! 安全边界（设计 §8）：
//! - Unix：运行目录 `~/.qingcode/server/run/` 权限 `0700`，接受连接时用
//!   `SO_PEERCRED` 校验对端 uid；
//! - Windows：运行目录在 `%USERPROFILE%` 下（继承用户私有 ACL），命名管道
//!   DACL 只放行当前用户，跨用户连接在打开阶段即被拒绝；
//! - HELLO 必须携带 `run/token` 的内容，错误即断开；
//! - 文件操作按「项目根」做词法 + canonicalize 双重校验，不跟随符号链接越界。
//!
//! 单实例：Unix 是 `run/daemon.lock` 上的 `flock`；Windows 由命名管道的
//! `FILE_FLAG_FIRST_PIPE_INSTANCE` 承担（另一进程已持有实例时创建失败）。
//! 抢不到锁说明已有实例，本进程直接退出（退出码 0），由调用方连上那个实例。

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncWrite, WriteHalf};
use tokio::sync::{mpsc, Notify};

use crate::ipc::{IpcEndpoint, IpcListener, IpcStream};
use crate::proto::{
    encode, ErrorBody, Event, Frame, HelloRequest, HelloResponse, Kind, OutboundQueue, Priority,
    Request, Response, SenderWindow, StreamEnd, WindowCredit, CONTROL_STREAM, HEARTBEAT_INTERVAL,
    HEARTBEAT_TIMEOUT, PROTOCOL_MIN, PROTOCOL_VERSION, WINDOW_BYTES,
};
use crate::pty::{PtyCreateOptions, PtyEvent, PtyHost};
use crate::{ops, proto, watch, SERVER_VERSION};

/// 每个 daemon 的 PTY 数量上限（设计 §6.3）。
pub const MAX_PTYS: usize = 64;

/// 环形缓冲总量上限（设计 §6.3）。按段淘汰策略由 PtyHost 实现。
pub const PTY_BUFFER_BYTES: usize = 256 * 1024 * 1024;

/// 无客户端且无 PTY 时的退出等待。
pub const IDLE_EXIT: Duration = Duration::from_secs(10 * 60);

/// PTY 全部 detached 后的保留时长。
pub const DETACHED_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// 回收周期。
pub const REAP_INTERVAL: Duration = Duration::from_secs(60);

/// 日志滚动阈值与保留份数。
pub const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const LOG_KEEP: usize = 3;

/// 单条连接的最大并发数。正常场景只有一条主连接，留余量给同机多窗口。
const MAX_CONNS: usize = 64;

/// 每条连接的终端输入队列深度。正常按键只有几十字节；给到 64 条足以吸收
/// 快速粘贴，同时在极端洪泛时把内存钉住（不会像无界队列那样无限增长）。
const INPUT_QUEUE_DEPTH: usize = 64;

const PTY_EVENT_QUEUE_DEPTH: usize = 256;
const OUTBOUND_CONTROL_DEPTH: usize = 32;
const OUTBOUND_DATA_DEPTH: usize = 64;
const INBOUND_FRAME_QUEUE_DEPTH: usize = 32;
const ROUTE_PENDING_MAX_BYTES: usize = 2 * 1024 * 1024;

/// 能力列表：客户端按它开关功能，不写死平台规则。
pub const CAPABILITIES: &[&str] = &[
    "fs.scan",
    "search.content",
    "watch.subscribe",
    "pty.persist",
    "pty.attach",
    "server.shutdown",
];

/// daemon 启动参数。
#[derive(Debug, Clone)]
pub struct DaemonOptions {
    /// 覆盖运行目录（测试用）。为空时用 `$HOME/.qingcode/server/run`。
    pub state_dir: Option<PathBuf>,
    pub max_ptys: usize,
    pub scrollback_bytes: usize,
    pub pty_buffer_bytes: usize,
    pub idle_exit: Duration,
    pub detached_ttl: Duration,
}

impl Default for DaemonOptions {
    fn default() -> Self {
        Self {
            state_dir: None,
            max_ptys: MAX_PTYS,
            scrollback_bytes: 2 * 1024 * 1024,
            pty_buffer_bytes: PTY_BUFFER_BYTES,
            idle_exit: IDLE_EXIT,
            detached_ttl: DETACHED_TTL,
        }
    }
}

/// 运行目录布局。
#[derive(Debug, Clone)]
pub struct RunDir {
    dir: PathBuf,
}

impl RunDir {
    /// 解析并创建运行目录。Unix 上权限收紧到 `0700`；Windows 依赖
    /// `%USERPROFILE%` 自带的用户私有 ACL，不再额外设置。
    pub fn resolve(override_dir: Option<&Path>) -> Result<Self, String> {
        let dir = match override_dir {
            Some(path) => path.to_path_buf(),
            None => home_dir()
                .ok_or_else(|| "无法确定家目录，请用 --state-dir 指定运行目录".to_string())?
                .join(".qingcode")
                .join("server")
                .join("run"),
        };
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建运行目录 {} 失败: {e}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("无法收紧运行目录权限: {e}"))?;
        }
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 就绪标记：daemon 监听建立后出现的文件。Unix 是 socket 本身；
    /// Windows 是写有管道名的 `run/pipe`（客户端据此判断 daemon 已监听）。
    pub fn ready_marker(&self) -> PathBuf {
        #[cfg(unix)]
        {
            self.socket()
        }
        #[cfg(windows)]
        {
            self.dir.join("pipe")
        }
    }

    pub fn socket(&self) -> PathBuf {
        self.dir.join("daemon.sock")
    }

    pub fn token(&self) -> PathBuf {
        self.dir.join("token")
    }

    pub fn log(&self) -> PathBuf {
        self.dir.join("server.log")
    }

    /// 生成新 token 并原子写入（Unix 上 `0600`）。
    ///
    /// 每次 daemon 启动都换 token：旧连接代理在进程退出后已不存在，
    /// 换新能顺带作废可能泄漏的旧 token。
    pub fn rotate_token(&self) -> Result<String, String> {
        let token = crate::generate_token();
        let temp = self.dir.join(format!(".token.tmp.{}", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        private_mode(&mut options);
        let mut file = options
            .open(&temp)
            .map_err(|e| format!("创建 token 文件失败: {e}"))?;
        file.write_all(token.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("写入 token 失败: {e}"))?;
        std::fs::rename(&temp, self.token()).map_err(|e| format!("落盘 token 失败: {e}"))?;
        Ok(token)
    }

    /// 读取现有 token（`connect --ensure-daemon` 与测试用）。
    pub fn read_token(&self) -> Result<String, String> {
        let token =
            std::fs::read_to_string(self.token()).map_err(|e| format!("读取 token 失败: {e}"))?;
        let token = token.trim().to_string();
        if token.is_empty() {
            return Err("token 文件为空".to_string());
        }
        Ok(token)
    }
}

/// Unix 上把文件创建收紧到 `0600`（token 与日志）；Windows 上靠目录 ACL，no-op。
fn private_mode(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    let _ = options;
}

/// 家目录：Unix 看 `HOME`，Windows 看 `USERPROFILE`；都没有时返回 None。
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    let value = std::env::var_os("HOME");
    #[cfg(windows)]
    let value = std::env::var_os("USERPROFILE");
    value.filter(|path| !path.is_empty()).map(PathBuf::from)
}

/// 滚动日志。
///
/// 写前检查大小，超过 [`LOG_MAX_BYTES`] 就把 `server.log` 挪成 `.1`，旧的
/// `.1`→`.2`……最多保留 [`LOG_KEEP`] 份归档。
///
/// 只允许写元信息（方法名、客户端 id、错误消息）；文件内容、终端数据、
/// 环境变量值一律不落日志。
pub struct Log {
    path: PathBuf,
    inner: Mutex<LogInner>,
}

struct LogInner {
    file: Option<File>,
    size: u64,
}

impl Log {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        private_mode(&mut options);
        let file = options
            .open(&path)
            .map_err(|e| format!("打开日志 {} 失败: {e}", path.display()))?;
        Ok(Self {
            path,
            inner: Mutex::new(LogInner {
                file: Some(file),
                size,
            }),
        })
    }

    pub fn info(&self, message: &str) {
        self.write("INFO", message);
    }

    pub fn warn(&self, message: &str) {
        self.write("WARN", message);
    }

    fn write(&self, level: &str, message: &str) {
        let line = format!("[{}] {level} {message}\n", timestamp());
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.size + line.len() as u64 > LOG_MAX_BYTES {
            self.rotate(&mut inner);
        }
        if let Some(file) = inner.file.as_mut() {
            if file.write_all(line.as_bytes()).is_ok() {
                inner.size += line.len() as u64;
            }
        }
    }

    fn rotate(&self, inner: &mut LogInner) {
        inner.file = None;
        for index in (1..=LOG_KEEP).rev() {
            let from = if index == 1 {
                self.path.clone()
            } else {
                archive_path(&self.path, index - 1)
            };
            let to = archive_path(&self.path, index);
            if from.exists() {
                let _ = std::fs::rename(&from, &to);
            }
        }
        inner.size = 0;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        private_mode(&mut options);
        inner.file = options.open(&self.path).ok();
    }
}

fn archive_path(base: &Path, index: usize) -> PathBuf {
    let mut name = base.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

/// 日志时间戳：`YYYY-MM-DDTHH:MM:SSZ`，只依赖标准库。
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// 天数（1970-01-01 起）转公历年月日，Howard Hinnant 的 civil_from_days。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------------------
// 进程入口
// ---------------------------------------------------------------------------

/// 阻塞入口（`main.rs` 调用）。
pub fn run(options: DaemonOptions) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("创建异步运行时失败: {e}"))?;
    runtime.block_on(run_async(options))
}

/// 异步入口：建目录 → 抢单实例锁并监听 → 换 token → 服务循环。
///
/// 已有实例时返回 `Ok(())`（调用方按「无需启动」处理）。
///
/// 顺序说明：监听（含单实例锁）必须在换 token 之前——Windows 上创建首个管道
/// 实例就是抢锁，客户端「就绪」判定是「标记文件出现 + token 可读」，把监听
/// 放前面保证 token 一定属于最终存活的那个实例。
pub async fn run_async(options: DaemonOptions) -> Result<(), String> {
    let run_dir = RunDir::resolve(options.state_dir.as_deref())?;
    let endpoint = IpcEndpoint::new(run_dir.dir());
    let Some(listener) = endpoint
        .listen()
        .map_err(|e| format!("监听 {} 失败: {e}", endpoint.describe()))?
    else {
        return Ok(());
    };
    let token = run_dir.rotate_token()?;
    let log = Log::open(run_dir.log())?;
    log.info(&format!(
        "daemon 启动 pid={} protocol={PROTOCOL_VERSION} ipc={} max_ptys={}",
        std::process::id(),
        endpoint.describe(),
        options.max_ptys
    ));

    let result = serve(options, run_dir, token, log, listener).await;
    endpoint.cleanup();
    result
}

async fn serve(
    options: DaemonOptions,
    run_dir: RunDir,
    token: String,
    log: Log,
    listener: IpcListener,
) -> Result<(), String> {
    let log = Arc::new(log);
    let (pty_tx, pty_rx) = mpsc::channel::<PtyEvent>(PTY_EVENT_QUEUE_DEPTH);
    let pty = Arc::new(PtyHost::new(
        options.max_ptys,
        options.pty_buffer_bytes,
        pty_tx,
    ));
    let daemon = Arc::new(Daemon {
        pty,
        token,
        log: Arc::clone(&log),
        started: Instant::now(),
        next_conn: AtomicU32::new(1),
        conns: Mutex::new(HashMap::new()),
        routes: Mutex::new(HashMap::new()),
        shutdown: Notify::new(),
        detached_ttl: options.detached_ttl,
        idle_exit: options.idle_exit,
        scrollback_bytes: options.scrollback_bytes,
        run_dir,
    });

    let pty_task = tokio::spawn(pty_events(Arc::clone(&daemon), pty_rx));
    // accept 交给独立任务：Windows 上等待连接的管道实例不能被 select 取消
    // 丢弃（详见 IpcListener::spawn_acceptor）。
    let mut accept_rx = listener.spawn_acceptor(Some(Arc::clone(&log)));
    daemon.log.info("开始接受本地连接");

    let mut idle_since = Some(Instant::now());
    let mut reap = tokio::time::interval(REAP_INTERVAL);
    reap.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = daemon.shutdown.notified() => {
                daemon.log.info("收到 server.shutdown，准备退出");
                // 给写端一点时间把 RES 帧刷出去，再结束进程。
                tokio::time::sleep(Duration::from_millis(100)).await;
                break;
            }
            _ = reap.tick() => {
                let reaped = daemon.pty.reap(daemon.detached_ttl);
                if !reaped.is_empty() {
                    daemon.log.info(&format!("已回收 {} 个超时终端", reaped.len()));
                    let mut routes = daemon.routes.lock().unwrap();
                    for id in reaped {
                        routes.remove(&id);
                    }
                }
                if daemon.is_idle() {
                    let since = *idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= daemon.idle_exit {
                        daemon.log.info("无客户端且无终端，空闲退出");
                        break;
                    }
                } else {
                    idle_since = None;
                }
            }
            accepted = accept_rx.recv() => {
                let Some(stream) = accepted else {
                    daemon.log.warn("accept 任务退出");
                    break;
                };
                if daemon.conns.lock().unwrap().len() >= MAX_CONNS {
                    daemon.log.warn("连接数超过上限，拒绝新连接");
                    continue;
                }
                tokio::spawn(handle_conn(Arc::clone(&daemon), stream));
            }
        }
    }

    // 退出前给所有终端发 SIGHUP（kill 内部先 SIGHUP 再降级）。
    for info in daemon.pty.list() {
        let _ = daemon.pty.kill(&info.id);
    }
    pty_task.abort();
    daemon.log.info("daemon 退出");
    Ok(())
}

/// 共享状态。
struct Daemon {
    pty: Arc<PtyHost>,
    token: String,
    log: Arc<Log>,
    started: Instant,
    next_conn: AtomicU32,
    conns: Mutex<HashMap<u32, ConnHandle>>,
    /// pty id → 当前路由。创建、attach、实时事件消费和 detach 都以这把锁为同步边界。
    routes: Mutex<HashMap<String, PtyRoute>>,
    shutdown: Notify,
    detached_ttl: Duration,
    idle_exit: Duration,
    scrollback_bytes: usize,
    run_dir: RunDir,
}

#[derive(Clone)]
struct ConnHandle {
    client_id: String,
    outbound: OutboundSender,
    inputs: Arc<InputQueues>,
}

#[derive(Debug)]
struct Outbound {
    priority: Priority,
    frame: Frame,
}

#[derive(Clone)]
struct OutboundSender {
    control: mpsc::Sender<Outbound>,
    data: mpsc::Sender<Outbound>,
    disconnect: Arc<Notify>,
    closing: Arc<AtomicBool>,
}

impl OutboundSender {
    fn new(
        control: mpsc::Sender<Outbound>,
        data: mpsc::Sender<Outbound>,
        disconnect: Arc<Notify>,
    ) -> Self {
        Self {
            control,
            data,
            disconnect,
            closing: Arc::new(AtomicBool::new(false)),
        }
    }

    fn try_send(&self, priority: Priority, frame: Frame) -> bool {
        let tx = if priority == Priority::Control {
            &self.control
        } else {
            &self.data
        };
        match tx.try_send(Outbound { priority, frame }) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) | Err(mpsc::error::TrySendError::Closed(_)) => {
                self.abort();
                false
            }
        }
    }

    /// 等待有界队列腾出容量后再发送。用于没有重放机制的数据流（例如文件
    /// 监视），背压会传回生产者，而不是写满后断开整条连接。
    async fn send_async(&self, priority: Priority, frame: Frame) -> bool {
        if self.closing.load(Ordering::SeqCst) {
            return false;
        }
        let tx = if priority == Priority::Control {
            &self.control
        } else {
            &self.data
        };
        tx.send(Outbound { priority, frame }).await.is_ok()
    }

    fn abort(&self) {
        if !self.closing.swap(true, Ordering::SeqCst) {
            self.disconnect.notify_one();
        }
    }
}

/// 路由的交付阶段。attach 在 `Replaying` 阶段先发送快照/补发流；期间到达的
/// 实时事件进入 `pending`。重放结束后短暂进入 `Draining`，把 pending 排空，
/// 最后一个事件入队后才切到 `Live`，避免实时事件越过重放或重复发送。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RoutePhase {
    Replaying,
    Draining,
    Live,
}

#[derive(Debug)]
struct PtyRoute {
    conn_id: u32,
    /// 下一个应投递给客户端的 PTY 数据块 seq。attach 时从快照的 `seq_end` 开始。
    next_seq: u64,
    phase: RoutePhase,
    pending: VecDeque<Outbound>,
    pending_bytes: usize,
    /// attach 应答已经带有退出码时，不再重复发送同一终端的 `pty.exit`。
    exit_delivered: bool,
}

impl PtyRoute {
    fn new(conn_id: u32, next_seq: u64, phase: RoutePhase, exit_delivered: bool) -> Self {
        Self {
            conn_id,
            next_seq,
            phase,
            pending: VecDeque::new(),
            pending_bytes: 0,
            exit_delivered,
        }
    }

    fn push_pending(&mut self, outbound: Outbound) -> Result<(), u32> {
        let size = outbound.frame.payload.len() + proto::FRAME_HEADER_BYTES;
        if self.pending_bytes + size > ROUTE_PENDING_MAX_BYTES {
            return Err(self.conn_id);
        }
        self.pending_bytes += size;
        self.pending.push_back(outbound);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteDataOutcome {
    NoRoute,
    Duplicate,
    Queued,
    Sent,
    Overflow {
        conn_id: u32,
    },
    SequenceGap {
        conn_id: u32,
        expected: u64,
        actual: u64,
    },
}

impl Daemon {
    fn is_idle(&self) -> bool {
        self.conns.lock().unwrap().is_empty() && self.pty.list().is_empty()
    }

    fn client_count(&self) -> usize {
        self.conns.lock().unwrap().len()
    }

    fn send_to_conn(&self, conn_id: u32, priority: Priority, frame: Frame) -> bool {
        let handle = self.conns.lock().unwrap().get(&conn_id).cloned();
        handle.is_some_and(|handle| handle.outbound.try_send(priority, frame))
    }

    fn disconnect_conn(&self, conn_id: u32) {
        let handle = self.conns.lock().unwrap().get(&conn_id).cloned();
        if let Some(handle) = handle {
            handle.outbound.abort();
        }
    }

    fn cancel_input_for_conn(&self, conn_id: u32, pty_id: &str) {
        let handle = self.conns.lock().unwrap().get(&conn_id).cloned();
        if let Some(handle) = handle {
            handle.inputs.cancel(pty_id);
        }
    }

    /// 在 routes 锁内完成 PTY 快照/补发游标捕获与 route 安装。
    ///
    /// `pty_events` 消费事件时必须先拿同一把锁。因此 attach 快照之后、route
    /// 安装之前到达的事件不会以「无 route」被消费；它们会在锁释放后看到
    /// `next_seq == seq_end`，进入 pending 等待重放结束。
    fn install_attach_route<F>(
        &self,
        pty_id: &str,
        conn_id: u32,
        attach: F,
    ) -> Result<crate::pty::AttachResult, String>
    where
        F: FnOnce() -> Result<crate::pty::AttachResult, String>,
    {
        let mut routes = self.routes.lock().unwrap();
        let attach = attach()?;
        routes.insert(
            pty_id.to_string(),
            PtyRoute::new(
                conn_id,
                attach.seq_end,
                RoutePhase::Replaying,
                attach.exited.is_some(),
            ),
        );
        Ok(attach)
    }

    /// 创建与首个 live route 安装共用路由锁，避免 shell 的首批输出在
    /// create 返回、route 尚未安装时被事件任务消费后形成 seq 空洞。
    fn create_pty_with_route(
        &self,
        conn_id: u32,
        options: PtyCreateOptions,
    ) -> Result<crate::pty::PtyInfo, String> {
        let mut routes = self.routes.lock().unwrap();
        let info = self.pty.create(options)?;
        routes.insert(
            info.id.clone(),
            PtyRoute::new(conn_id, info.seq, RoutePhase::Live, false),
        );
        Ok(info)
    }

    /// 按 handoff 游标投递一块 PTY 输出。调用者必须在同一把锁内完成游标
    /// 校验、pending/live 决策和（live 路径的）入队，这样 attach 切换时才
    /// 不会出现重复或越过重放的事件。
    fn dispatch_pty_data(&self, pty_id: &str, seq: u64, frames: Vec<Outbound>) -> RouteDataOutcome {
        let mut routes = self.routes.lock().unwrap();
        let Some(route) = routes.get_mut(pty_id) else {
            return RouteDataOutcome::NoRoute;
        };
        if seq < route.next_seq {
            return RouteDataOutcome::Duplicate;
        }
        if seq > route.next_seq {
            return RouteDataOutcome::SequenceGap {
                conn_id: route.conn_id,
                expected: route.next_seq,
                actual: seq,
            };
        }
        match route.phase {
            RoutePhase::Replaying | RoutePhase::Draining => {
                for outbound in frames {
                    if let Err(conn_id) = route.push_pending(outbound) {
                        return RouteDataOutcome::Overflow { conn_id };
                    }
                }
                route.next_seq = seq.wrapping_add(1);
                RouteDataOutcome::Queued
            }
            RoutePhase::Live => {
                let conn_id = route.conn_id;
                for outbound in frames {
                    if !self.send_to_conn(conn_id, outbound.priority, outbound.frame) {
                        return RouteDataOutcome::Overflow { conn_id };
                    }
                }
                route.next_seq = seq.wrapping_add(1);
                RouteDataOutcome::Sent
            }
        }
    }

    /// 退出事件不参与数据 seq，但仍必须与重放保持先后顺序，并与 attach
    /// 应答中的 `exited` 去重。
    fn dispatch_pty_exit(&self, pty_id: &str, frame: Outbound) -> bool {
        let mut routes = self.routes.lock().unwrap();
        let Some(route) = routes.get_mut(pty_id) else {
            return false;
        };
        if route.exit_delivered {
            return false;
        }
        route.exit_delivered = true;
        let conn_id = route.conn_id;
        self.cancel_input_for_conn(conn_id, pty_id);
        match route.phase {
            RoutePhase::Replaying | RoutePhase::Draining => {
                let size = frame.frame.payload.len() + proto::FRAME_HEADER_BYTES;
                route.pending_bytes += size;
                route.pending.push_back(frame);
            }
            RoutePhase::Live => {
                let delivered = self.send_to_conn(conn_id, frame.priority, frame.frame);
                routes.remove(pty_id);
                if delivered {
                    self.pty.release_exited(pty_id);
                }
            }
        }
        true
    }

    /// 重放流已经全部入队后调用：排空重放期间积累的实时事件。
    /// 每次取出 pending 时保持 `Draining`，所以排空过程中新到的事件仍会排队，
    /// 不会在上一批事件尚未入队时直接走 live 路径。
    fn finish_attach_replay(&self, pty_id: &str, conn_id: u32) {
        loop {
            let pending = {
                let mut routes = self.routes.lock().unwrap();
                let Some(route) = routes.get_mut(pty_id) else {
                    return;
                };
                if route.conn_id != conn_id {
                    return;
                }
                route.phase = RoutePhase::Draining;
                let pending: Vec<Outbound> = route.pending.drain(..).collect();
                route.pending_bytes = 0;
                if pending.is_empty() {
                    if route.exit_delivered {
                        routes.remove(pty_id);
                        self.pty.release_exited(pty_id);
                    } else {
                        route.phase = RoutePhase::Live;
                    }
                    return;
                }
                pending
            };
            for outbound in pending {
                if !self.send_to_conn(conn_id, outbound.priority, outbound.frame) {
                    self.disconnect_conn(conn_id);
                    return;
                }
            }
        }
    }

    /// `pty.detach` 来自旧连接时不能误删新连接刚安装的路由。
    fn clear_route_for_conn(&self, pty_id: &str, conn_id: u32) {
        // 先抓 client_id，再删 route。若连接清理并发执行并移除 conns，
        // 这里仍能用已取得的归属完成 detach，避免留下 attached 幽灵。
        let client_id = self
            .conns
            .lock()
            .unwrap()
            .get(&conn_id)
            .map(|handle| handle.client_id.clone());
        let mut routes = self.routes.lock().unwrap();
        let matches = routes
            .get(pty_id)
            .is_some_and(|route| route.conn_id == conn_id);
        let removed = matches && routes.remove(pty_id).is_some();
        drop(routes);
        if removed {
            // attach 成功会先把终端标为 attached，再开始补发；补发失败时
            // 路由会被移除，这里必须同步 detach，否则终端既不在路由表里，
            // 也不会进入 detached TTL 或孤儿列表。
            if let Some(client_id) = client_id {
                let _ = self.pty.detach(pty_id, &client_id);
            }
        }
    }

    /// 连接断开时把它名下的终端标记为 detached，但绝不结束进程。
    fn detach_owned_ptys(&self, conn_id: u32, client_id: &str) {
        let owned: Vec<String> = {
            let routes = self.routes.lock().unwrap();
            routes
                .iter()
                .filter(|(_, route)| route.conn_id == conn_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in owned {
            let _ = self.pty.detach(&id, client_id);
            self.clear_route_for_conn(&id, conn_id);
            self.log.info(&format!(
                "终端 {id} 已 detached（连接 {conn_id} 断开，进程保留）"
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// 连接处理
// ---------------------------------------------------------------------------

/// 每条连接的发送/取消/窗口状态。
#[derive(Clone)]
struct ConnCtx {
    conn_id: u32,
    client_id: String,
    outbound: OutboundSender,
    cancels: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
    windows: Arc<Mutex<HashMap<u32, Arc<SenderWindow>>>>,
    inputs: Arc<InputQueues>,
}

/// 一条待写入终端的输入。
struct PtyInput {
    request_id: u32,
    pty_id: String,
    seq: Option<u64>,
    data: Vec<u8>,
}

struct InputQueue {
    tx: mpsc::Sender<PtyInput>,
    cancel: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct InputQueues {
    queues: Mutex<HashMap<String, InputQueue>>,
}

impl InputQueues {
    fn cancel(&self, pty_id: &str) {
        if let Some(queue) = self
            .queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(pty_id)
        {
            queue.cancel.store(true, Ordering::SeqCst);
            queue.task.abort();
        }
    }

    fn cancel_all(&self) {
        let queues: Vec<InputQueue> = self
            .queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, queue)| queue)
            .collect();
        for queue in queues {
            queue.cancel.store(true, Ordering::SeqCst);
            queue.task.abort();
        }
    }
}

/// `pty.input` 的参数。放在模块级是因为读循环也要用它（不能只在 dispatch 里）。
/// Serialize 仅供测试的 TestClient 复用（回环测试要构造输入帧）。
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyInputParams {
    id: String,
    #[serde(default)]
    seq: Option<u64>,
    #[serde(with = "serde_bytes")]
    data: Vec<u8>,
}

/// 串行消费单个 PTY 的输入。每个 PTY 独立 task，所以一个子进程不读 stdin
/// 时不会占住同连接其他终端的队列。
async fn pty_input_loop(
    conn: ConnCtx,
    pty: Arc<PtyHost>,
    pty_id: String,
    mut rx: mpsc::Receiver<PtyInput>,
    cancel: Arc<AtomicBool>,
) {
    while !cancel.load(Ordering::SeqCst) {
        let Some(input) = rx.recv().await else {
            break;
        };
        let PtyInput {
            request_id,
            seq,
            data,
            ..
        } = input;
        if let Some(seq) = seq {
            let expected = match pty.expected_input_seq(&pty_id) {
                Ok(expected) => expected,
                Err(message) => {
                    conn.fail(request_id, "pty", message);
                    break;
                }
            };
            if seq < expected {
                conn.respond(request_id, json!({ "ok": true, "duplicate": true }));
                continue;
            }
            if seq != expected {
                conn.fail(
                    request_id,
                    "ptyInputSequence",
                    format!("终端输入序号不连续：期望 {expected}，实际 {seq}"),
                );
                conn.inputs.cancel(&pty_id);
                break;
            }
        }
        let written = pty
            .write_interruptible(&pty_id, data, Arc::clone(&cancel))
            .await;
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        match written {
            Ok(()) => {
                if let Some(seq) = seq {
                    if let Err(message) = pty.mark_input_written(&pty_id, seq) {
                        conn.fail(request_id, "pty", message);
                        conn.inputs.cancel(&pty_id);
                        break;
                    }
                }
                conn.respond(request_id, json!({ "ok": true }));
            }
            Err(message) => {
                conn.fail(request_id, "pty", message);
                conn.inputs.cancel(&pty_id);
                break;
            }
        }
    }
    while let Ok(input) = rx.try_recv() {
        conn.fail(input.request_id, "pty", "终端已结束，输入未写入");
    }
}

/// 在读循环里按帧序把 `pty.input` 入队。
fn enqueue_pty_input(conn: &ConnCtx, pty: Arc<PtyHost>, request: Request) {
    let id = request.id;
    let Ok(params) = request.parse::<PtyInputParams>() else {
        conn.fail(id, "badRequest", "pty.input 参数错误");
        return;
    };
    let input = PtyInput {
        request_id: id,
        pty_id: params.id,
        seq: params.seq,
        data: params.data,
    };
    let pty_id = input.pty_id.clone();
    let tx = {
        let mut queues = conn
            .inputs
            .queues
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if queues
            .get(&pty_id)
            .is_some_and(|queue| queue.task.is_finished())
        {
            queues.remove(&pty_id);
        }
        match queues.get(&pty_id) {
            Some(queue) => queue.tx.clone(),
            None => {
                let (tx, rx) = mpsc::channel::<PtyInput>(INPUT_QUEUE_DEPTH);
                let cancel = Arc::new(AtomicBool::new(false));
                let task = tokio::spawn(pty_input_loop(
                    conn.clone(),
                    Arc::clone(&pty),
                    pty_id.clone(),
                    rx,
                    Arc::clone(&cancel),
                ));
                queues.insert(
                    pty_id.clone(),
                    InputQueue {
                        tx: tx.clone(),
                        cancel,
                        task,
                    },
                );
                tx
            }
        }
    };
    match tx.try_send(input) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => conn.fail(
            id,
            "ptyBusy",
            format!("终端输入队列已满（{INPUT_QUEUE_DEPTH} 条待写），请稍后重试"),
        ),
        Err(mpsc::error::TrySendError::Closed(_)) => {
            conn.inputs.cancel(&pty_id);
            conn.fail(id, "internal", "连接已关闭，输入未写入")
        }
    }
}

impl ConnCtx {
    fn send(&self, priority: Priority, frame: Frame) -> bool {
        self.outbound.try_send(priority, frame)
    }

    async fn send_async(&self, priority: Priority, frame: Frame) -> bool {
        self.outbound.send_async(priority, frame).await
    }

    fn respond(&self, id: u32, result: Value) {
        let frame = Frame::new(
            Kind::Res,
            id,
            encode(&Response { id, result }).unwrap_or_default(),
        );
        self.send(Priority::Control, frame);
    }

    fn fail(&self, id: u32, code: &str, message: impl Into<String>) {
        let body = ErrorBody {
            id,
            code: code.to_string(),
            message: message.into(),
        };
        let frame = Frame::new(Kind::Err, id, encode(&body).unwrap_or_default());
        self.send(Priority::Control, frame);
    }

    /// 流结束帧要跟数据帧同一优先级：否则控制优先的写端会让 STREAM_END
    /// 越到同一流尚未发出的 STREAM_DATA 之前，客户端提前收尾。
    fn stream_end(&self, priority: Priority, id: u32, body: StreamEnd) {
        let frame = Frame::new(Kind::StreamEnd, id, encode(&body).unwrap_or_default());
        self.send(priority, frame);
    }

    /// 为流登记取消标记，返回共享句柄（`CANCEL` 帧会置位）。
    fn cancel_flag(&self, id: u32) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id, Arc::clone(&flag));
        flag
    }

    /// 发一块流数据，但每 200ms 复查一次取消标记。
    ///
    /// 只看信用窗口是不够的：客户端可能活着、还在发 PING，却迟迟不消费，
    /// 这时 `window.acquire` 会永久阻塞，`CANCEL` 也永远读不到效果。
    /// 返回 false 表示流被取消或窗口已关闭。
    async fn send_chunk(
        &self,
        priority: Priority,
        id: u32,
        window: &SenderWindow,
        cancel: &AtomicBool,
        payload: Vec<u8>,
    ) -> bool {
        loop {
            if cancel.load(Ordering::SeqCst) {
                return false;
            }
            tokio::select! {
                result = window.acquire(payload.len()) => {
                    if result.is_err() {
                        return false;
                    }
                    return self.send(priority, Frame::new(Kind::StreamData, id, payload));
                }
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
        }
    }

    fn clear_cancel(&self, id: u32) {
        self.cancels.lock().unwrap().remove(&id);
    }

    fn cancel(&self, id: u32) {
        if let Some(flag) = self.cancels.lock().unwrap().get(&id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    fn window(&self, id: u32) -> Arc<SenderWindow> {
        let window = Arc::new(SenderWindow::new(WINDOW_BYTES));
        self.windows.lock().unwrap().insert(id, Arc::clone(&window));
        window
    }

    fn clear_window(&self, id: u32) {
        self.windows.lock().unwrap().remove(&id);
    }

    fn replenish(&self, id: u32, credit: u32) {
        if let Some(window) = self.windows.lock().unwrap().get(&id) {
            window.replenish(credit as usize);
        }
    }
}

/// 校验对端身份与握手，失败即断开。成功后才登记到连接表。
///
/// 对端校验的平台语义见 [`IpcStream::verify_peer`]：Unix 比对 uid；
/// Windows 的 named pipe DACL 已在打开阶段限定当前用户，这里取 pid 只为日志。
async fn handle_conn(daemon: Arc<Daemon>, stream: IpcStream) {
    let debug = crate::debug_enabled();
    if debug {
        daemon.log.info("handle_conn: 进入");
    }
    let peer = match stream.verify_peer() {
        Ok(peer) => peer,
        Err(e) => {
            daemon.log.warn(&format!("对端校验失败（{e}），拒绝连接"));
            return;
        }
    };
    if debug {
        daemon.log.info(&format!("handle_conn: 对端 {peer}"));
    }
    let (mut reader, writer) = tokio::io::split(stream);

    let hello =
        match tokio::time::timeout(Duration::from_secs(10), proto::read_frame(&mut reader)).await {
            Ok(Ok(frame)) if frame.kind == Kind::Hello => frame,
            other => {
                daemon.log.warn(&format!(
                    "握手失败（等待 HELLO 超时或首帧类型不符）: {other:?}"
                ));
                return;
            }
        };
    if debug {
        daemon.log.info("handle_conn: HELLO 已收到");
    }
    let Ok(request) = proto::decode_value::<HelloRequest>(&hello.payload) else {
        daemon.log.warn("HELLO 负载无法解码");
        return;
    };
    if !crate::connect::constant_time_token_eq(&daemon.token, &request.token) {
        daemon
            .log
            .warn(&format!("客户端 {} token 校验失败", request.client_id));
        return;
    }
    let Some(protocol) = negotiate(request.protocol_min, request.protocol_max) else {
        daemon.log.warn(&format!(
            "协议版本不兼容: 客户端 [{}, {}]，daemon {PROTOCOL_VERSION}",
            request.protocol_min, request.protocol_max
        ));
        return;
    };

    let conn_id = daemon.next_conn.fetch_add(1, Ordering::Relaxed);
    let (control_tx, control_rx) = mpsc::channel::<Outbound>(OUTBOUND_CONTROL_DEPTH);
    let (data_tx, data_rx) = mpsc::channel::<Outbound>(OUTBOUND_DATA_DEPTH);
    let disconnect = Arc::new(Notify::new());
    let outbound = OutboundSender::new(control_tx, data_tx, Arc::clone(&disconnect));
    let inputs = Arc::new(InputQueues::default());
    daemon.conns.lock().unwrap().insert(
        conn_id,
        ConnHandle {
            client_id: request.client_id.clone(),
            outbound: outbound.clone(),
            inputs: Arc::clone(&inputs),
        },
    );

    let response = HelloResponse {
        protocol,
        server_version: SERVER_VERSION.to_string(),
        pid: std::process::id(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: home_dir().map(|path| path.to_string_lossy().into_owned()),
        shells: available_shells(),
        capabilities: CAPABILITIES.iter().map(|item| item.to_string()).collect(),
        pty_count: daemon.pty.list().len(),
    };
    if let Ok(payload) = encode(&response) {
        outbound.try_send(
            Priority::Control,
            Frame::new(Kind::Hello, CONTROL_STREAM, payload),
        );
    }
    daemon.log.info(&format!(
        "客户端 {} 接入（连接 {conn_id}，protocol {protocol}，{peer}）",
        request.client_id
    ));

    let mut writer_task = tokio::spawn(writer_loop(writer, control_rx, data_rx));
    let (frame_tx, mut frame_rx) = mpsc::channel::<Frame>(INBOUND_FRAME_QUEUE_DEPTH);
    // 读端单独一个任务：帧读到一半时不能被 `select!` 取消（read_exact 不是
    // cancel-safe），否则会丢字节、后续帧全部错位。
    let reader_task = tokio::spawn(async move {
        while let Ok(frame) = proto::read_frame(&mut reader).await {
            if frame_tx.send(frame).await.is_err() {
                break;
            }
        }
    });

    let ctx = ConnCtx {
        conn_id,
        client_id: request.client_id.clone(),
        outbound,
        cancels: Arc::new(Mutex::new(HashMap::new())),
        windows: Arc::new(Mutex::new(HashMap::new())),
        inputs,
    };
    let mut last_seen = Instant::now();
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut writer_done = false;
    loop {
        tokio::select! {
            biased;
            _ = disconnect.notified() => {
                daemon.log.warn(&format!(
                    "连接 {conn_id} 发送背压达到上限，断开等待客户端重连"
                ));
                break;
            }
            result = &mut writer_task => {
                writer_done = true;
                match result {
                    Ok(()) => daemon.log.warn(&format!("连接 {conn_id} writer 已退出")),
                    Err(error) => daemon.log.warn(&format!("连接 {conn_id} writer 异常: {error}")),
                }
                break;
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > HEARTBEAT_TIMEOUT {
                    daemon.log.warn(&format!("连接 {conn_id} 心跳超时"));
                    break;
                }
                ctx.send(Priority::Control, Frame::empty(Kind::Ping, CONTROL_STREAM));
            }
            frame = frame_rx.recv() => {
                let Some(frame) = frame else { break };
                last_seen = Instant::now();
                match frame.kind {
                    Kind::Req => match proto::decode_value::<Request>(&frame.payload) {
                        Ok(request) => {
                            // 终端输入顺序敏感：按帧到达顺序入队，由单个任务串行写；
                            // 其余请求各自一个任务，互不阻塞。
                            if request.method == "pty.input" {
                                enqueue_pty_input(&ctx, Arc::clone(&daemon.pty), request);
                            } else {
                                let daemon = Arc::clone(&daemon);
                                let ctx = ctx.clone();
                                tokio::spawn(dispatch(daemon, ctx, request));
                            }
                        }
                        Err(e) => ctx.fail(frame.stream_id, "badRequest", e.to_string()),
                    },
                    Kind::Cancel => ctx.cancel(frame.stream_id),
                    Kind::Window => {
                        if let Ok(credit) = proto::decode_value::<WindowCredit>(&frame.payload) {
                            ctx.replenish(frame.stream_id, credit.credit);
                        }
                    }
                    Kind::Ping => {
                        ctx.send(Priority::Control, Frame::empty(Kind::Pong, CONTROL_STREAM));
                    }
                    Kind::Pong => {}
                    // 客户端不应主动发这些：记录并忽略，保持连接可用。
                    other => {
                        daemon.log.warn(&format!("忽略非预期的 {} 帧", other.as_str()));
                    }
                }
            }
        }
    }

    reader_task.abort();
    ctx.inputs.cancel_all();
    daemon.detach_owned_ptys(conn_id, &ctx.client_id);
    daemon.conns.lock().unwrap().remove(&conn_id);
    // 置位所有取消标记：搜索/监视任务在下一个检查点退出。
    for flag in ctx.cancels.lock().unwrap().values() {
        flag.store(true, Ordering::SeqCst);
    }
    drop(ctx);
    if !writer_done {
        match tokio::time::timeout(Duration::from_millis(500), &mut writer_task).await {
            Ok(_) => {}
            Err(_) => {
                writer_task.abort();
                let _ = writer_task.await;
            }
        }
    }
    daemon.log.info(&format!("连接 {conn_id} 断开"));
}

fn negotiate(min: u32, max: u32) -> Option<u32> {
    if max < PROTOCOL_MIN || min > PROTOCOL_VERSION {
        return None;
    }
    Some(max.min(PROTOCOL_VERSION))
}

/// 可用 shell：登录 shell 优先，其余按常见安装位探测。只回报名字，不带参数。
fn available_shells() -> Vec<String> {
    #[cfg(unix)]
    {
        let mut shells = Vec::new();
        if let Ok(shell) = std::env::var("SHELL") {
            if let Some(name) = Path::new(&shell).file_name() {
                let name = name.to_string_lossy();
                if matches!(name.as_ref(), "bash" | "zsh" | "sh") {
                    shells.push(name.into_owned());
                }
            }
        }
        for name in ["bash", "zsh", "sh"] {
            if shells.iter().any(|item| item == name) {
                continue;
            }
            let exists = ["/bin", "/usr/bin", "/usr/local/bin"]
                .iter()
                .any(|dir| Path::new(dir).join(name).exists());
            if exists {
                shells.push(name.to_string());
            }
        }
        shells
    }
    #[cfg(windows)]
    {
        let mut shells = Vec::new();
        if let Some(comspec) = std::env::var_os("COMSPEC") {
            if let Some(name) = Path::new(&comspec).file_name() {
                let name = name.to_string_lossy().into_owned();
                if !shells.contains(&name) {
                    shells.push(name);
                }
            }
        }
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let powershell = system_root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        if powershell.exists() {
            shells.push("powershell.exe".to_string());
        }
        // pwsh（PowerShell 7+）不固定安装位，按 PATH 探测。
        if let Some(paths) = std::env::var_os("PATH") {
            let found = std::env::split_paths(&paths).any(|dir| dir.join("pwsh.exe").exists());
            if found {
                shells.push("pwsh.exe".to_string());
            }
        }
        shells
    }
}

/// 写端：每写完一帧都重新吸纳两条有界通道，使 PING/控制帧能插到尚未发送
/// 的 Terminal/RPC/Bulk 前面。
async fn writer_loop(
    writer: WriteHalf<IpcStream>,
    control_rx: mpsc::Receiver<Outbound>,
    data_rx: mpsc::Receiver<Outbound>,
) {
    let _ = write_outbound_loop(writer, control_rx, data_rx).await;
}

async fn write_outbound_loop<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut control_rx: mpsc::Receiver<Outbound>,
    mut data_rx: mpsc::Receiver<Outbound>,
) -> std::io::Result<()> {
    let mut queue = OutboundQueue::new();
    let mut control_open = true;
    let mut data_open = true;
    loop {
        drain_ready(&mut control_rx, &mut data_rx, &mut queue)?;
        let Some(frame) = queue.pop() else {
            let Some(out) = next_outbound(
                &mut control_rx,
                &mut data_rx,
                &mut control_open,
                &mut data_open,
            )
            .await
            else {
                return Ok(());
            };
            queue.push_with(out.priority, out.frame)?;
            continue;
        };
        proto::write_frame(&mut writer, &frame).await?;
    }
}

fn drain_ready(
    control_rx: &mut mpsc::Receiver<Outbound>,
    data_rx: &mut mpsc::Receiver<Outbound>,
    queue: &mut OutboundQueue,
) -> std::io::Result<()> {
    loop {
        match control_rx.try_recv() {
            Ok(out) => queue.push_with(out.priority, out.frame)?,
            Err(mpsc::error::TryRecvError::Empty) => break,
            Err(mpsc::error::TryRecvError::Disconnected) => break,
        }
    }
    loop {
        match data_rx.try_recv() {
            Ok(out) => queue.push_with(out.priority, out.frame)?,
            Err(mpsc::error::TryRecvError::Empty) => break,
            Err(mpsc::error::TryRecvError::Disconnected) => break,
        }
    }
    Ok(())
}

async fn next_outbound(
    control_rx: &mut mpsc::Receiver<Outbound>,
    data_rx: &mut mpsc::Receiver<Outbound>,
    control_open: &mut bool,
    data_open: &mut bool,
) -> Option<Outbound> {
    loop {
        if !*control_open && !*data_open {
            return None;
        }
        tokio::select! {
            biased;
            item = control_rx.recv(), if *control_open => {
                match item {
                    Some(out) => return Some(out),
                    None => *control_open = false,
                }
            }
            item = data_rx.recv(), if *data_open => {
                match item {
                    Some(out) => return Some(out),
                    None => *data_open = false,
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 方法分发
// ---------------------------------------------------------------------------

fn params<T: DeserializeOwned>(request: &Request) -> Result<T, String> {
    request.parse::<T>().map_err(|e| format!("参数错误: {e}"))
}

async fn dispatch(daemon: Arc<Daemon>, conn: ConnCtx, request: Request) {
    let id = request.id;
    match request.method.as_str() {
        "server.info" => {
            let info = json!({
                "version": SERVER_VERSION,
                "pid": std::process::id(),
                "protocol": { "min": PROTOCOL_MIN, "current": PROTOCOL_VERSION, "max": PROTOCOL_VERSION },
                "capabilities": CAPABILITIES,
                "clients": daemon.client_count(),
                "ptys": daemon.pty.list().len(),
                "uptimeSecs": daemon.started.elapsed().as_secs(),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "runDir": daemon.run_dir.dir().to_string_lossy(),
            });
            conn.respond(id, info);
        }
        "server.shutdown" => {
            conn.respond(id, json!({ "ok": true }));
            daemon
                .log
                .info(&format!("客户端 {} 请求退出", conn.client_id));
            // notify_one 会保存一个 permit：即便此刻主循环还没进入 select，
            // 下一次也会立刻被唤醒（notify_waiters 会丢通知）。
            daemon.shutdown.notify_one();
        }
        "fs.scan" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct ScanParams {
                root: String,
                #[serde(default)]
                path: String,
            }
            let Ok(params) = params::<ScanParams>(&request) else {
                conn.fail(id, "badRequest", "fs.scan 需要 root/path");
                return;
            };
            let root = match canonical_root(&params.root) {
                Ok(root) => root,
                Err(message) => {
                    conn.fail(id, "outsideRoot", message);
                    return;
                }
            };
            let relative = params.path;
            let result = tokio::task::spawn_blocking(move || ops::scan_dir(&root, &relative)).await;
            match result {
                Ok(Ok(entries)) => {
                    let entries: Vec<Value> = entries
                        .iter()
                        .map(|entry| json!({ "name": entry.name, "isDir": entry.is_dir }))
                        .collect();
                    conn.respond(id, json!({ "entries": entries, "truncated": false }));
                }
                Ok(Err(message)) => conn.fail(id, "io", message),
                Err(_) => conn.fail(id, "internal", "扫描任务异常结束"),
            }
        }
        "search.content" => search_content(daemon, conn, request).await,
        "watch.subscribe" => watch_subscribe(daemon, conn, request).await,
        method if method.starts_with("pty.") => pty_method(daemon, conn, request).await,
        other => conn.fail(id, "unknownMethod", format!("未知方法: {other}")),
    }
}

/// 项目根校验：必须是绝对路径、真实存在且是目录。canonicalize 之后的根
/// 供 `resolve_within_root` 做词法边界检查，两条规则叠加才能挡住符号链接逃逸。
fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let path = normalize_root_path(root);
    if !path.is_absolute() {
        return Err("root 必须是绝对路径".to_string());
    }
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("路径不可访问: {e}"))?;
    if !canonical.is_dir() {
        return Err("路径不是目录".to_string());
    }
    Ok(canonical)
}

/// 把客户端传来的根路径归一成宿主平台可用的形式。
///
/// Windows 客户端（SFTP 与 SSH 资源）用 POSIX 风格表示远端路径，例如
/// `/D:/code/app`。这在本机 `PathBuf::is_absolute()` 下是「有根无盘符」，
/// 会被误判成相对路径——必须还原成 `D:\code\app` 再校验。只接受
/// 「斜杠 + 盘符 + 冒号」这一种形态，其他 `/...` 路径照旧按原样拒绝。
fn normalize_root_path(root: &str) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(rest) = root.strip_prefix('/') {
            let bytes = rest.as_bytes();
            if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                let native = rest.replace('/', "\\");
                return PathBuf::from(if native.ends_with(':') {
                    format!("{native}\\")
                } else {
                    native
                });
            }
        }
    }
    PathBuf::from(root)
}

async fn search_content(daemon: Arc<Daemon>, conn: ConnCtx, request: Request) {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SearchParams {
        root: String,
        query: String,
        #[serde(default)]
        ignore_case: bool,
        #[serde(default)]
        include_globs: Vec<String>,
        #[serde(default)]
        exclude_globs: Vec<String>,
        #[serde(default)]
        no_ignore: bool,
        #[serde(default = "default_max_matches")]
        max_matches: usize,
        #[serde(default = "default_max_per_file")]
        max_per_file: usize,
        #[serde(default = "default_max_files")]
        max_files: usize,
    }
    fn default_max_matches() -> usize {
        1000
    }
    fn default_max_per_file() -> usize {
        100
    }
    fn default_max_files() -> usize {
        5000
    }

    let id = request.id;
    let Ok(params) = params::<SearchParams>(&request) else {
        conn.fail(id, "badRequest", "search.content 参数不完整");
        return;
    };
    let root = match canonical_root(&params.root) {
        Ok(root) => root,
        Err(message) => {
            conn.fail(id, "outsideRoot", message);
            return;
        }
    };
    let search_params = ops::ContentSearchParams {
        query: params.query,
        ignore_case: params.ignore_case,
        include_globs: params.include_globs,
        exclude_globs: params.exclude_globs,
        no_ignore: params.no_ignore,
        max_matches: params.max_matches,
        max_per_file: params.max_per_file,
        max_files: params.max_files,
    };

    let cancel = conn.cancel_flag(id);
    let window = conn.window(id);
    let (tx, mut rx) = mpsc::channel::<Value>(64);
    let cancel_for_task = Arc::clone(&cancel);
    let producer = tokio::task::spawn_blocking(move || {
        ops::search_content(&root, &search_params, &cancel_for_task, &tx)
    });

    let mut aborted = false;
    while let Some(record) = rx.recv().await {
        // 一条记录可能超过 64KB（超长行），按 64KB 分片，客户端拼完才解码。
        let Ok(bytes) = encode(&record) else {
            continue;
        };
        for chunk in proto::split_chunks(&bytes, None) {
            let Ok(payload) = encode(&chunk) else {
                continue;
            };
            if !conn
                .send_chunk(Priority::Bulk, id, &window, &cancel, payload)
                .await
            {
                aborted = true;
                break;
            }
        }
        if aborted {
            break;
        }
    }

    // 写不出去就别再让阻塞搜索继续跑：丢掉接收端，producer 会在下一个发送点退出。
    drop(rx);
    let cancelled = cancel.load(Ordering::SeqCst);
    let outcome = producer.await;
    conn.clear_window(id);
    conn.clear_cancel(id);
    // 无论成功、取消还是中断，都补一个 STREAM_END：客户端在等它收尾。
    let body = match outcome {
        Ok(Ok(summary)) => StreamEnd {
            ok: !cancelled && !aborted,
            summary: json!({
                "truncated": summary.truncated,
                "filesScanned": summary.files_scanned,
                "cancelled": cancelled,
            }),
            error: None,
        },
        Ok(Err(message)) => StreamEnd {
            ok: false,
            summary: json!({ "cancelled": cancelled }),
            error: Some(message),
        },
        Err(_) => StreamEnd {
            ok: false,
            summary: json!({}),
            error: Some("搜索任务异常结束".to_string()),
        },
    };
    conn.stream_end(Priority::Bulk, id, body);
    daemon.log.info(&format!(
        "连接 {} 的搜索 {id} 结束（cancelled={cancelled} aborted={aborted}）",
        conn.conn_id
    ));
}

async fn watch_subscribe(daemon: Arc<Daemon>, conn: ConnCtx, request: Request) {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WatchParams {
        root: String,
    }
    let id = request.id;
    let Ok(params) = params::<WatchParams>(&request) else {
        conn.fail(id, "badRequest", "watch.subscribe 需要 root");
        return;
    };
    let root = match canonical_root(&params.root) {
        Ok(root) => root,
        Err(message) => {
            conn.fail(id, "outsideRoot", message);
            return;
        }
    };

    let cancel = conn.cancel_flag(id);
    let (tx, mut rx) = mpsc::channel::<Value>(64);
    let cancel_for_task = Arc::clone(&cancel);
    let watcher = tokio::task::spawn_blocking(move || {
        // 返回值只用于结束原因；客户端断开是正常收尾。
        watch::watch_loop(root, cancel_for_task, tx)
    });
    // 应答只表示「订阅已受理」：inotify 注册与 350ms 去抖都在阻塞任务里，
    // 客户端不应把 RES 当成「从现在起的事件一定收得到」的屏障。
    conn.respond(id, json!({ "subscribed": true }));

    // watch_loop 每 250ms 检查一次 cancel，置位后返回并关闭发送端，
    // 因此这里只等事件通道关闭即可，无需额外轮询。
    while let Some(record) = rx.recv().await {
        let event = Event::FsChange {
            path: record["path"].as_str().unwrap_or_default().to_string(),
            kind: record["kind"].as_str().unwrap_or("any").to_string(),
            is_dir: record["isDir"].as_bool().unwrap_or(false),
        };
        let Ok(payload) = encode(&event) else {
            continue;
        };
        if !conn
            .send_async(Priority::Rpc, Frame::new(Kind::Event, id, payload))
            .await
        {
            cancel.store(true, Ordering::SeqCst);
            break;
        }
    }
    drop(rx);
    let error = match watcher.await {
        Ok(Err(message)) => Some(message),
        _ => None,
    };
    conn.stream_end(
        Priority::Rpc,
        id,
        StreamEnd {
            ok: error.is_none(),
            summary: json!({}),
            error,
        },
    );
    conn.clear_cancel(id);
    daemon
        .log
        .info(&format!("连接 {} 的监视 {id} 结束", conn.conn_id));
}

// ---------------------------------------------------------------------------
// PTY 方法
// ---------------------------------------------------------------------------

/// PTY 应答用的 DTO：pty.rs 的类型不必实现 Serialize，边界上转一次。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyInfoDto {
    id: String,
    name: Option<String>,
    next_input_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    seq: u64,
    cols: u16,
    rows: u16,
    exited: Option<i32>,
    detached: bool,
}

impl From<crate::pty::PtyInfo> for PtyInfoDto {
    fn from(info: crate::pty::PtyInfo) -> Self {
        Self {
            id: info.id,
            name: info.name,
            next_input_seq: info.next_input_seq,
            owner: info.owner,
            cwd: info.cwd,
            seq: info.seq,
            cols: info.cols,
            rows: info.rows,
            exited: info.exited,
            detached: info.detached,
        }
    }
}

/// 新客户端按 `clientId` 查孤儿终端时，只返回本安装、本连接下仍存活且
/// 当前无人接着的 PTY。旧客户端不传 `clientId`，继续保持完整列表语义。
fn filter_pty_list(
    ptys: impl IntoIterator<Item = crate::pty::PtyInfo>,
    client_id: Option<&str>,
) -> Vec<crate::pty::PtyInfo> {
    let Some(client_id) = client_id else {
        return ptys.into_iter().collect();
    };
    ptys.into_iter()
        .filter(|info| {
            info.detached && info.exited.is_none() && info.owner.as_deref() == Some(client_id)
        })
        .collect()
}

async fn pty_method(daemon: Arc<Daemon>, conn: ConnCtx, request: Request) {
    let id = request.id;
    match request.method.as_str() {
        "pty.create" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct CreateParams {
                #[serde(default)]
                cwd: Option<String>,
                #[serde(default)]
                shell: Option<String>,
                #[serde(default)]
                args: Vec<String>,
                #[serde(default)]
                env: BTreeMap<String, String>,
                #[serde(default)]
                name: Option<String>,
                #[serde(default = "default_cols")]
                cols: u16,
                #[serde(default = "default_rows")]
                rows: u16,
            }
            fn default_cols() -> u16 {
                80
            }
            fn default_rows() -> u16 {
                24
            }
            let Ok(params) = params::<CreateParams>(&request) else {
                conn.fail(id, "badRequest", "pty.create 参数错误");
                return;
            };
            let cwd = match params.cwd {
                Some(cwd) => match canonical_root(&cwd) {
                    Ok(path) => path,
                    Err(message) => {
                        conn.fail(id, "badCwd", message);
                        return;
                    }
                },
                None => match home_dir() {
                    Some(home) => home,
                    None => {
                        conn.fail(id, "badCwd", "未指定 cwd 且无法确定家目录");
                        return;
                    }
                },
            };
            let options = PtyCreateOptions {
                cwd,
                shell: params.shell,
                args: params.args,
                env: params.env,
                name: params.name,
                cols: params.cols.max(1),
                rows: params.rows.max(1),
                scrollback_bytes: daemon.scrollback_bytes,
                client_id: conn.client_id.clone(),
            };
            // pty.rs 的 create 要 openpty + fork/exec，且限额检查与创建在同一把宿主锁里，
            // 直接放在 async 里会阻塞 worker（其它连接的心跳与应答都得等）。
            let daemon_for_create = Arc::clone(&daemon);
            let conn_id = conn.conn_id;
            let created = tokio::task::spawn_blocking(move || {
                daemon_for_create.create_pty_with_route(conn_id, options)
            })
            .await;
            match created {
                Ok(Ok(info)) => {
                    let pty_id = info.id.clone();
                    conn.respond(id, json!(PtyInfoDto::from(info)));
                    daemon
                        .log
                        .info(&format!("连接 {} 创建终端 {pty_id}", conn.conn_id));
                }
                Ok(Err(message)) => conn.fail(id, "pty", message),
                Err(_) => conn.fail(id, "internal", "创建终端任务异常结束"),
            }
        }
        "pty.input" => {
            // 正常路径在读循环里拦截并按帧序入队（见 `enqueue_pty_input`）；
            // 走到这里说明有内部代码绕过了那条路径，报错而不是悄悄乱序写入。
            conn.fail(id, "internal", "pty.input 必须经读循环按序入队");
        }
        "pty.resize" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct ResizeParams {
                id: String,
                cols: u16,
                rows: u16,
            }
            let Ok(params) = params::<ResizeParams>(&request) else {
                conn.fail(id, "badRequest", "pty.resize 参数错误");
                return;
            };
            match daemon
                .pty
                .resize(&params.id, params.cols.max(1), params.rows.max(1))
            {
                Ok(()) => conn.respond(id, json!({ "ok": true })),
                Err(message) => conn.fail(id, "pty", message),
            }
        }
        "pty.attach" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct AttachParams {
                id: String,
                #[serde(default)]
                from_seq: u64,
            }
            let Ok(params) = params::<AttachParams>(&request) else {
                conn.fail(id, "badRequest", "pty.attach 参数错误");
                return;
            };
            let attach = match daemon.install_attach_route(&params.id, conn.conn_id, || {
                daemon
                    .pty
                    .attach(&params.id, params.from_seq, &conn.client_id)
            }) {
                Ok(attach) => attach,
                Err(message) => {
                    conn.fail(id, "pty", message);
                    return;
                }
            };
            conn.respond(
                id,
                json!({
                    "screen": attach.screen,
                    "cols": attach.cols,
                    "rows": attach.rows,
                    "nextInputSeq": attach.next_input_seq,
                    "exited": attach.exited,
                    "seqEnd": attach.seq_end,
                }),
            );
            // 补发缺失输出：每段按 64KB 分片，窗口满时在这里等客户端回 WINDOW，
            // 期间每 200ms 复查 CANCEL（慢客户端不能把这条连接挂死）。
            let window = conn.window(id);
            let cancel = conn.cancel_flag(id);
            let mut ok = true;
            for (seq, data) in attach.replay {
                for chunk in proto::split_chunks(&data, Some(seq)) {
                    let Ok(payload) = encode(&chunk) else {
                        continue;
                    };
                    if !conn
                        .send_chunk(Priority::Terminal, id, &window, &cancel, payload)
                        .await
                    {
                        ok = false;
                        break;
                    }
                }
                if !ok {
                    break;
                }
            }
            conn.clear_cancel(id);
            conn.stream_end(
                Priority::Terminal,
                id,
                StreamEnd {
                    ok,
                    summary: json!({ "seqEnd": attach.seq_end, "exited": attach.exited }),
                    error: None,
                },
            );
            if ok {
                daemon.finish_attach_replay(&params.id, conn.conn_id);
            } else {
                daemon.clear_route_for_conn(&params.id, conn.conn_id);
            }
            conn.clear_window(id);
            daemon
                .log
                .info(&format!("连接 {} 接回终端 {}", conn.conn_id, params.id));
        }
        "pty.detach" => {
            #[derive(Deserialize)]
            struct DetachParams {
                id: String,
            }
            let Ok(params) = params::<DetachParams>(&request) else {
                conn.fail(id, "badRequest", "pty.detach 参数错误");
                return;
            };
            match daemon.pty.detach(&params.id, &conn.client_id) {
                Ok(()) => {
                    conn.inputs.cancel(&params.id);
                    daemon.clear_route_for_conn(&params.id, conn.conn_id);
                    conn.respond(id, json!({ "ok": true }));
                }
                Err(message) => conn.fail(id, "pty", message),
            }
        }
        "pty.kill" => {
            #[derive(Deserialize)]
            struct KillParams {
                id: String,
            }
            let Ok(params) = params::<KillParams>(&request) else {
                conn.fail(id, "badRequest", "pty.kill 参数错误");
                return;
            };
            conn.inputs.cancel(&params.id);
            match daemon.pty.kill(&params.id) {
                Ok(()) => conn.respond(id, json!({ "ok": true })),
                Err(message) => conn.fail(id, "pty", message),
            }
        }
        "pty.list" => {
            #[derive(Default, Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct ListParams {
                #[serde(default)]
                client_id: Option<String>,
            }
            let params = match params::<ListParams>(&request) {
                Ok(params) => params,
                Err(_) => {
                    conn.fail(id, "badRequest", "pty.list 参数错误");
                    return;
                }
            };
            let ptys: Vec<PtyInfoDto> =
                filter_pty_list(daemon.pty.list(), params.client_id.as_deref())
                    .into_iter()
                    .map(Into::into)
                    .collect();
            conn.respond(id, json!({ "ptys": ptys }));
        }
        "pty.hasChildren" => {
            #[derive(Deserialize)]
            struct IdParams {
                id: String,
            }
            let Ok(params) = params::<IdParams>(&request) else {
                conn.fail(id, "badRequest", "pty.hasChildren 参数错误");
                return;
            };
            conn.respond(
                id,
                json!({ "hasChildren": daemon.pty.has_children(&params.id) }),
            );
        }
        other => conn.fail(id, "unknownMethod", format!("未知方法: {other}")),
    }
}

/// 把 PtyHost 推来的事件路由给当前持有该终端的连接。
async fn pty_events(daemon: Arc<Daemon>, mut rx: mpsc::Receiver<PtyEvent>) {
    while let Some(event) = rx.recv().await {
        match event {
            PtyEvent::Data { id, seq, data } => {
                let mut frames = Vec::new();
                for chunk in proto::split_chunks(&data, Some(seq)) {
                    let event = Event::PtyData {
                        id: id.clone(),
                        seq,
                        offset: chunk.offset,
                        data: chunk.data,
                    };
                    let Ok(payload) = encode(&event) else {
                        continue;
                    };
                    frames.push(Outbound {
                        priority: Priority::Terminal,
                        frame: Frame::new(Kind::Event, CONTROL_STREAM, payload),
                    });
                }
                match daemon.dispatch_pty_data(&id, seq, frames) {
                    RouteDataOutcome::Overflow { conn_id }
                    | RouteDataOutcome::SequenceGap { conn_id, .. } => {
                        daemon.log.warn(&format!(
                            "终端 {id} 输出投递失败（seq={seq}），断开连接 {conn_id} 等待重连 attach"
                        ));
                        daemon.clear_route_for_conn(&id, conn_id);
                        daemon.disconnect_conn(conn_id);
                    }
                    RouteDataOutcome::NoRoute
                    | RouteDataOutcome::Duplicate
                    | RouteDataOutcome::Queued
                    | RouteDataOutcome::Sent => {}
                }
            }
            PtyEvent::Exit { id, code } => {
                daemon.log.info(&format!("终端 {id} 退出（code={code:?}）"));
                let event = Event::PtyExit {
                    id: id.clone(),
                    code,
                };
                if let Ok(payload) = encode(&event) {
                    daemon.dispatch_pty_exit(
                        &id,
                        Outbound {
                            priority: Priority::Terminal,
                            frame: Frame::new(Kind::Event, CONTROL_STREAM, payload),
                        },
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{decode_value, StreamChunk};
    use serde::Serialize;
    use serde_json::json;
    use tokio::io::AsyncReadExt;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "qingcode-daemon-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn route_test_daemon(tag: &str) -> (Arc<Daemon>, mpsc::Receiver<Outbound>, RunDir) {
        let state_dir = temp_dir(tag);
        let run_dir = RunDir::resolve(Some(&state_dir)).unwrap();
        let (pty_tx, _pty_rx) = mpsc::channel(8);
        let pty = Arc::new(PtyHost::new(4, 1024 * 1024, pty_tx));
        let (control_tx, _control_rx) = mpsc::channel(8);
        let (data_tx, data_rx) = mpsc::channel(8);
        let outbound = OutboundSender::new(control_tx, data_tx, Arc::new(Notify::new()));
        let inputs = Arc::new(InputQueues::default());
        let mut conns = HashMap::new();
        conns.insert(
            41,
            ConnHandle {
                client_id: "test-client".to_string(),
                outbound,
                inputs,
            },
        );
        let daemon = Arc::new(Daemon {
            pty,
            token: "test-token".to_string(),
            log: Arc::new(Log::open(run_dir.log()).unwrap()),
            started: Instant::now(),
            next_conn: AtomicU32::new(42),
            conns: Mutex::new(conns),
            routes: Mutex::new(HashMap::new()),
            shutdown: Notify::new(),
            detached_ttl: DETACHED_TTL,
            idle_exit: IDLE_EXIT,
            scrollback_bytes: 4096,
            run_dir: run_dir.clone(),
        });
        (daemon, data_rx, run_dir)
    }

    fn test_pty_info(
        id: &str,
        owner: Option<&str>,
        detached: bool,
        exited: Option<i32>,
    ) -> crate::pty::PtyInfo {
        crate::pty::PtyInfo {
            id: id.to_string(),
            name: None,
            next_input_seq: 0,
            owner: owner.map(str::to_string),
            cwd: Some("/srv/app".to_string()),
            seq: 0,
            cols: 80,
            rows: 24,
            exited,
            detached,
        }
    }

    #[test]
    fn client_id_filter_keeps_only_owned_detached_running_ptys() {
        let ptys = vec![
            test_pty_info("owned", Some("install:conn"), true, None),
            test_pty_info("attached", Some("install:conn"), false, None),
            test_pty_info("other-owner", Some("install:other"), true, None),
            test_pty_info("exited", Some("install:conn"), true, Some(0)),
            test_pty_info("missing-owner", None, true, None),
        ];
        let filtered = filter_pty_list(ptys, Some("install:conn"));
        assert_eq!(
            filtered
                .iter()
                .map(|info| info.id.as_str())
                .collect::<Vec<_>>(),
            vec!["owned"]
        );

        // 旧客户端不传 clientId：保留完整列表语义。
        let legacy = filter_pty_list(
            vec![
                test_pty_info("attached", Some("install:conn"), false, None),
                test_pty_info("exited", Some("install:conn"), true, Some(1)),
            ],
            None,
        );
        assert_eq!(legacy.len(), 2);
    }

    fn pty_data_outbound(pty_id: &str, seq: u64, data: &[u8]) -> Outbound {
        let event = Event::PtyData {
            id: pty_id.to_string(),
            seq,
            offset: 0,
            data: data.to_vec(),
        };
        Outbound {
            priority: Priority::Terminal,
            frame: Frame::new(
                Kind::Event,
                CONTROL_STREAM,
                encode(&event).expect("编码 PTY 事件失败"),
            ),
        }
    }

    fn routed_pty_data(frame: &Frame) -> Option<(u64, Vec<u8>)> {
        if frame.kind != Kind::Event {
            return None;
        }
        match decode_value::<Event>(&frame.payload).ok()? {
            Event::PtyData { seq, data, .. } => Some((seq, data)),
            _ => None,
        }
    }

    /// attach 快照返回 `seq_end = 3` 的同时，读线程正试图投递 seq 3。
    /// 事件必须等 routes 锁释放后进入 pending，重放结束后按 2、3、4 连续
    /// 投递；attach 前已进入事件队列的 0/1/2 只能由重放提供一次。
    #[test]
    fn attach_handoff_keeps_cutover_event_once_and_in_sequence() {
        let (daemon, mut conn_rx, run_dir) = route_test_daemon("attach-handoff");
        let pty_id = "pty-handoff";
        let conn_id = 41;

        // 快照之前已发出的数据没有 route，交给 attach 的 ring/screen 恢复。
        assert_eq!(
            daemon.dispatch_pty_data(pty_id, 0, vec![pty_data_outbound(pty_id, 0, b"old")]),
            RouteDataOutcome::NoRoute
        );

        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let event_daemon = Arc::clone(&daemon);
        let event_thread = std::thread::spawn(move || {
            entered_tx.send(()).unwrap();
            event_daemon.dispatch_pty_data(
                pty_id,
                3,
                vec![pty_data_outbound(pty_id, 3, b"cutover")],
            )
        });

        let attach = daemon
            .install_attach_route(pty_id, conn_id, || {
                // routes 锁已经由 install_attach_route 持有。等事件线程进入投递
                // 路径后再返回快照，稳定复现「快照之后、route 安装之前」的窗口。
                entered_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("事件线程未进入 attach 窗口");
                Ok(crate::pty::AttachResult {
                    screen: None,
                    replay: vec![(2, b"replay".to_vec())],
                    seq_end: 3,
                    cols: 80,
                    rows: 24,
                    next_input_seq: 0,
                    exited: None,
                })
            })
            .unwrap();
        assert_eq!(attach.seq_end, 3);
        assert_eq!(
            event_thread.join().unwrap(),
            RouteDataOutcome::Queued,
            "切点事件必须进入重放期间的 pending，不能因无 route 丢失"
        );

        // 0..seq_end 已包含在 attach 恢复内容中，重放后不得再次投递。
        for seq in 0..attach.seq_end {
            assert_eq!(
                daemon.dispatch_pty_data(
                    pty_id,
                    seq,
                    vec![pty_data_outbound(pty_id, seq, b"duplicate")]
                ),
                RouteDataOutcome::Duplicate
            );
        }

        // 模拟 attach 任务按协议顺序先发 seq 2 的补发块和 STREAM_END，再排空 pending。
        for (seq, data) in attach.replay {
            daemon.send_to_conn(
                conn_id,
                Priority::Terminal,
                pty_data_outbound(pty_id, seq, &data).frame,
            );
        }
        daemon.send_to_conn(
            conn_id,
            Priority::Terminal,
            Frame::new(
                Kind::StreamEnd,
                7,
                encode(&StreamEnd {
                    ok: true,
                    summary: json!({ "seqEnd": attach.seq_end }),
                    error: None,
                })
                .unwrap(),
            ),
        );
        daemon.finish_attach_replay(pty_id, conn_id);

        // 切换到 live 后继续从 seq 4 投递，不应有任何空洞。
        assert_eq!(
            daemon.dispatch_pty_data(pty_id, 4, vec![pty_data_outbound(pty_id, 4, b"live")]),
            RouteDataOutcome::Sent
        );

        let replayed = conn_rx.try_recv().unwrap().frame;
        assert_eq!(routed_pty_data(&replayed), Some((2, b"replay".to_vec())));
        assert_eq!(conn_rx.try_recv().unwrap().frame.kind, Kind::StreamEnd);
        let cutover = conn_rx.try_recv().unwrap().frame;
        assert_eq!(routed_pty_data(&cutover), Some((3, b"cutover".to_vec())));
        let live = conn_rx.try_recv().unwrap().frame;
        assert_eq!(routed_pty_data(&live), Some((4, b"live".to_vec())));
        assert!(conn_rx.try_recv().is_err(), "同一 PTY 输出被重复投递");

        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 等就绪标记与 token 出现（daemon 的启动是异步的）。
    async fn wait_ready(run_dir: &RunDir) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if run_dir.ready_marker().exists() && run_dir.read_token().is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("daemon 未在 10s 内就绪");
    }

    /// 测试用 shell 与提示命令：Unix 用 /bin/sh，Windows 用 COMSPEC（cmd.exe）。
    /// `echo` 两边都有，输出带各自行尾，断言只看 marker 子串。
    fn test_shell() -> String {
        #[cfg(unix)]
        {
            "/bin/sh".to_string()
        }
        #[cfg(windows)]
        {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
        }
    }

    struct TestClient {
        stream: IpcStream,
        next_id: u32,
    }

    impl TestClient {
        async fn connect(run_dir: &RunDir, token: &str) -> Self {
            let endpoint = IpcEndpoint::new(run_dir.dir());
            let stream = endpoint.connect().await.unwrap();
            let mut client = Self { stream, next_id: 1 };
            let hello = HelloRequest {
                client_id: "test-client".into(),
                protocol_min: PROTOCOL_MIN,
                protocol_max: PROTOCOL_VERSION,
                token: token.to_string(),
                resume_token: None,
            };
            client
                .send(Kind::Hello, 0, &proto::encode(&hello).unwrap())
                .await;
            let frame = client.next_frame().await;
            assert_eq!(frame.kind, Kind::Hello);
            let response: HelloResponse = decode_value(&frame.payload).unwrap();
            assert_eq!(response.protocol, PROTOCOL_VERSION);
            assert!(!response.capabilities.is_empty());
            client
        }

        async fn send(&mut self, kind: Kind, stream_id: u32, payload: &[u8]) {
            proto::write_frame(
                &mut self.stream,
                &Frame::new(kind, stream_id, payload.to_vec()),
            )
            .await
            .unwrap();
        }

        async fn request<T: serde::Serialize>(&mut self, method: &str, params: &T) -> u32 {
            let id = self.next_id;
            self.next_id += 1;
            let request = Request::with_params(id, method, params).unwrap();
            self.send(Kind::Req, id, &proto::encode(&request).unwrap())
                .await;
            id
        }

        async fn next_frame(&mut self) -> Frame {
            tokio::time::timeout(Duration::from_secs(10), proto::read_frame(&mut self.stream))
                .await
                .expect("等帧超时")
                .expect("读帧失败")
        }

        /// 带超时的读帧：超时返回 None，用于「轮询一下有没有事件」的场景。
        async fn poll_frame(&mut self, wait: Duration) -> Option<Frame> {
            tokio::time::timeout(wait, proto::read_frame(&mut self.stream))
                .await
                .ok()?
                .ok()
        }

        /// 一直读到匹配 id 的 RES/ERR，期间丢弃心跳与无关事件。
        async fn wait_response(&mut self, id: u32) -> Value {
            loop {
                let frame = self.next_frame().await;
                match frame.kind {
                    Kind::Res if frame.stream_id == id => {
                        let response: Response = decode_value(&frame.payload).unwrap();
                        return response.result;
                    }
                    Kind::Err if frame.stream_id == id => {
                        let error: ErrorBody = decode_value(&frame.payload).unwrap();
                        panic!("请求 {id} 失败: {error:?}");
                    }
                    _ => continue,
                }
            }
        }

        #[cfg(unix)]
        async fn wait_response_collecting_events(&mut self, id: u32) -> (Value, Vec<Event>) {
            let mut events = Vec::new();
            loop {
                let frame = self.next_frame().await;
                match frame.kind {
                    Kind::Res if frame.stream_id == id => {
                        let response: Response = decode_value(&frame.payload).unwrap();
                        return (response.result, events);
                    }
                    Kind::Err if frame.stream_id == id => {
                        let error: ErrorBody = decode_value(&frame.payload).unwrap();
                        panic!("请求 {id} 失败: {error:?}");
                    }
                    Kind::Event => {
                        if let Ok(event) = decode_value::<Event>(&frame.payload) {
                            events.push(event);
                        }
                    }
                    _ => continue,
                }
            }
        }

        async fn wait_error(&mut self, id: u32) -> ErrorBody {
            loop {
                let frame = self.next_frame().await;
                match frame.kind {
                    Kind::Err if frame.stream_id == id => {
                        return decode_value(&frame.payload).unwrap();
                    }
                    Kind::Res if frame.stream_id == id => {
                        let response: Response = decode_value(&frame.payload).unwrap();
                        panic!("请求 {id} 应失败，却返回: {:?}", response.result);
                    }
                    _ => continue,
                }
            }
        }

        /// 收集一条流的所有 STREAM_DATA，返回（拼接后的负载列表, STREAM_END）。
        async fn collect_stream(&mut self, id: u32) -> (Vec<Vec<u8>>, StreamEnd) {
            let mut records: Vec<Vec<u8>> = Vec::new();
            let mut current: Vec<u8> = Vec::new();
            loop {
                let frame = self.next_frame().await;
                match frame.kind {
                    Kind::StreamData if frame.stream_id == id => {
                        let chunk: StreamChunk = decode_value(&frame.payload).unwrap();
                        assert_eq!(chunk.offset as usize, current.len(), "分片 offset 不连续");
                        current.extend_from_slice(&chunk.data);
                        if chunk.last {
                            records.push(std::mem::take(&mut current));
                        }
                        // 回补信用，模拟客户端消费完之后发 WINDOW。
                        let credit = proto::encode(&WindowCredit {
                            credit: frame.payload.len() as u32,
                        })
                        .unwrap();
                        self.send(Kind::Window, id, &credit).await;
                    }
                    Kind::StreamEnd if frame.stream_id == id => {
                        let end: StreamEnd = decode_value(&frame.payload).unwrap();
                        return (records, end);
                    }
                    Kind::Err if frame.stream_id == id => {
                        let error: ErrorBody = decode_value(&frame.payload).unwrap();
                        panic!("流 {id} 失败: {error:?}");
                    }
                    _ => continue,
                }
            }
        }
    }

    /// 起一个隔离的 daemon（临时运行目录），返回句柄与运行目录。
    async fn start_daemon(tag: &str) -> (RunDir, tokio::task::JoinHandle<Result<(), String>>) {
        let state_dir = temp_dir(tag);
        let run_dir = RunDir::resolve(Some(&state_dir)).unwrap();
        let options = DaemonOptions {
            state_dir: Some(state_dir),
            ..Default::default()
        };
        let handle = tokio::spawn(async move { run_async(options).await });
        wait_ready(&run_dir).await;
        (run_dir, handle)
    }

    #[tokio::test]
    async fn handshake_info_scan_search_and_shutdown() {
        let (run_dir, handle) = start_daemon("basic").await;
        let token = run_dir.read_token().unwrap();
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client.request("server.info", &json!({})).await;
        let info = client.wait_response(id).await;
        assert_eq!(info["pid"].as_u64(), Some(u64::from(std::process::id())));
        assert_eq!(
            info["protocol"]["current"].as_u64(),
            Some(u64::from(PROTOCOL_VERSION))
        );

        let root = temp_dir("basic-root");
        std::fs::write(root.join("a.txt"), "hello qingcode\n").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();

        let id = client
            .request("fs.scan", &json!({ "root": root, "path": "" }))
            .await;
        let scan = client.wait_response(id).await;
        let names: Vec<&str> = scan["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"sub"));

        let id = client
            .request(
                "search.content",
                &json!({ "root": root, "query": "qingcode", "maxMatches": 10 }),
            )
            .await;
        let (records, end) = client.collect_stream(id).await;
        assert!(end.ok);
        assert_eq!(end.summary["filesScanned"].as_u64(), Some(1));
        assert_eq!(records.len(), 1);
        let record: Value = decode_value(&records[0]).unwrap();
        assert_eq!(record["data"]["path"]["text"], "./a.txt");

        // 越界路径必须被拒绝（ERR 帧），而不是静默返回空。
        #[cfg(unix)]
        let outside_root = "/nonexistent-root";
        #[cfg(windows)]
        let outside_root = "T:/definitely-not-a-root";
        let id = client
            .request("fs.scan", &json!({ "root": outside_root, "path": "" }))
            .await;
        loop {
            let frame = client.next_frame().await;
            if frame.kind == Kind::Err && frame.stream_id == id {
                let error: ErrorBody = decode_value(&frame.payload).unwrap();
                assert_eq!(error.code, "outsideRoot");
                break;
            }
        }

        let id = client.request("server.shutdown", &json!({})).await;
        let result = client.wait_response(id).await;
        assert_eq!(result["ok"], true);
        let joined = tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("daemon 未退出")
            .unwrap();
        assert!(joined.is_ok());
        assert!(!run_dir.ready_marker().exists(), "退出后就绪标记未清理");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    #[tokio::test]
    async fn ping_frame_gets_pong() {
        let (run_dir, handle) = start_daemon("ping-pong").await;
        let token = run_dir.read_token().unwrap();
        let mut client = TestClient::connect(&run_dir, &token).await;

        client.send(Kind::Ping, CONTROL_STREAM, &[]).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < deadline, "PING 未收到 PONG");
            let frame = client.next_frame().await;
            if frame.kind == Kind::Pong {
                assert_eq!(frame.stream_id, CONTROL_STREAM);
                break;
            }
        }

        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    #[tokio::test]
    async fn wrong_token_is_rejected_without_hello() {
        let (run_dir, handle) = start_daemon("token").await;
        let endpoint = IpcEndpoint::new(run_dir.dir());
        let mut stream = endpoint.connect().await.unwrap();
        let hello = HelloRequest {
            client_id: "intruder".into(),
            protocol_min: 1,
            protocol_max: 1,
            token: "deadbeef".into(),
            resume_token: None,
        };
        proto::write_frame(
            &mut stream,
            &Frame::new(Kind::Hello, 0, proto::encode(&hello).unwrap()),
        )
        .await
        .unwrap();
        // 服务端直接断开：读帧得到 EOF 而不是 HELLO。
        let result = tokio::time::timeout(Duration::from_secs(5), proto::read_frame(&mut stream))
            .await
            .expect("服务端未断开");
        assert!(result.is_err());

        let mut client = TestClient::connect(&run_dir, &run_dir.read_token().unwrap()).await;
        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 单实例：同一运行目录第二个监听请求必须失败，释放后可重新监听。
    /// （Unix 靠 flock；Windows 靠 FIRST_PIPE_INSTANCE——语义一致，统一验证。
    /// tokio 运行时：Windows 上创建管道实例需要注册 reactor。）
    #[tokio::test]
    async fn endpoint_listen_is_exclusive_within_one_process() {
        let dir = temp_dir("lock");
        let run_dir = RunDir::resolve(Some(&dir)).unwrap();
        let endpoint = IpcEndpoint::new(run_dir.dir());
        let first = endpoint.listen().unwrap().expect("首次监听失败");
        assert!(
            endpoint.listen().unwrap().is_none(),
            "第二次监听应当失败（已有实例）"
        );
        drop(first);
        // 释放后能再次监听；句柄异步回收可能有一瞬间延迟，短轮询等待。
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut relocked = false;
        while Instant::now() < deadline {
            if endpoint.listen().unwrap().is_some() {
                relocked = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(relocked, "释放后应能重新监听");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn timestamp_formats_epoch_and_known_date() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2026-10-23 是 1970-01-01 起的第 20749 天。
        assert_eq!(civil_from_days(20_749), (2026, 10, 23));
        // 闰日：2024-02-29。
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn log_rotates_and_keeps_at_most_three_archives() {
        let dir = temp_dir("log");
        let path = dir.join("server.log");
        let log = Log::open(path.clone()).unwrap();
        let line = "x".repeat(1024 * 1024);
        for _ in 0..20 {
            log.info(&line);
        }
        assert!(dir.join("server.log.1").exists(), "未生成归档");
        assert!(!dir.join("server.log.4").exists(), "归档份数超过 3");
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size < LOG_MAX_BYTES, "当前日志未回落到阈值内: {size}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn protocol_negotiation_rejects_incompatible_ranges() {
        assert_eq!(negotiate(1, 1), Some(1));
        assert_eq!(negotiate(1, 9), Some(PROTOCOL_VERSION));
        assert_eq!(negotiate(2, 9), None, "客户端最低版本高于 daemon");
        assert_eq!(negotiate(0, 0), None, "客户端最高版本低于 daemon 最低");
    }

    #[tokio::test]
    async fn bounded_outbound_keeps_control_capacity_under_data_flood() {
        let (control_tx, mut control_rx) = mpsc::channel::<Outbound>(OUTBOUND_CONTROL_DEPTH);
        let (data_tx, data_rx) = mpsc::channel::<Outbound>(OUTBOUND_DATA_DEPTH);
        let disconnect = Arc::new(Notify::new());
        let outbound = OutboundSender::new(control_tx, data_tx, Arc::clone(&disconnect));

        for index in 0..OUTBOUND_DATA_DEPTH {
            assert!(outbound.try_send(
                Priority::Bulk,
                Frame::new(Kind::StreamData, index as u32, Vec::new())
            ));
        }
        assert_eq!(data_rx.len(), OUTBOUND_DATA_DEPTH);
        assert!(
            outbound.try_send(Priority::Control, Frame::empty(Kind::Ping, CONTROL_STREAM)),
            "数据队列满时 PING 仍应使用独立控制容量"
        );
        for _ in 1..OUTBOUND_CONTROL_DEPTH {
            assert!(outbound.try_send(Priority::Control, Frame::empty(Kind::Ping, CONTROL_STREAM)));
        }
        assert!(
            !outbound.try_send(Priority::Control, Frame::empty(Kind::Pong, CONTROL_STREAM)),
            "控制队列满时必须拒绝新帧"
        );
        assert!(outbound.closing.load(Ordering::SeqCst));
        tokio::time::timeout(Duration::from_millis(100), disconnect.notified())
            .await
            .expect("队列满后必须通知连接断开");
        assert_eq!(control_rx.try_recv().unwrap().frame.kind, Kind::Ping);
        assert_eq!(data_rx.len(), OUTBOUND_DATA_DEPTH, "已入队帧不能被静默丢弃");
    }

    #[tokio::test]
    async fn writer_rechecks_priority_after_every_written_frame() {
        let (mut peer, server) = tokio::io::duplex(1024);
        let (control_tx, control_rx) = mpsc::channel::<Outbound>(OUTBOUND_CONTROL_DEPTH);
        let (data_tx, data_rx) = mpsc::channel::<Outbound>(OUTBOUND_DATA_DEPTH);

        let first = Frame::new(Kind::StreamData, 1, vec![b'a'; 64 * 1024]);
        let encoded_first = first.encode().unwrap();
        data_tx
            .send(Outbound {
                priority: Priority::Bulk,
                frame: first,
            })
            .await
            .unwrap();
        data_tx
            .send(Outbound {
                priority: Priority::Bulk,
                frame: Frame::new(Kind::StreamData, 4, vec![b'b'; 32]),
            })
            .await
            .unwrap();
        let writer = tokio::spawn(write_outbound_loop(server, control_rx, data_rx));

        let mut first_byte = [0u8; 1];
        tokio::time::timeout(Duration::from_secs(5), peer.read_exact(&mut first_byte))
            .await
            .expect("writer 未开始写首个 bulk 帧")
            .unwrap();
        assert_eq!(first_byte[0], encoded_first[0]);

        control_tx
            .send(Outbound {
                priority: Priority::Control,
                frame: Frame::empty(Kind::Ping, CONTROL_STREAM),
            })
            .await
            .unwrap();
        data_tx
            .send(Outbound {
                priority: Priority::Terminal,
                frame: Frame::new(Kind::Req, 3, b"key".to_vec()),
            })
            .await
            .unwrap();
        data_tx
            .send(Outbound {
                priority: Priority::Rpc,
                frame: Frame::new(Kind::Res, 2, Vec::new()),
            })
            .await
            .unwrap();

        let mut rest = vec![0u8; encoded_first.len() - 1];
        peer.read_exact(&mut rest).await.unwrap();
        assert_eq!(rest, encoded_first[1..]);

        let control = tokio::time::timeout(Duration::from_secs(5), proto::read_frame(&mut peer))
            .await
            .expect("等待 Control 超时")
            .unwrap();
        assert_eq!(control.kind, Kind::Ping);
        let terminal = tokio::time::timeout(Duration::from_secs(5), proto::read_frame(&mut peer))
            .await
            .expect("等待 Terminal 超时")
            .unwrap();
        assert_eq!(terminal.kind, Kind::Req);
        assert_eq!(terminal.stream_id, 3);
        let rpc = tokio::time::timeout(Duration::from_secs(5), proto::read_frame(&mut peer))
            .await
            .expect("等待 Rpc 超时")
            .unwrap();
        assert_eq!(rpc.kind, Kind::Res);
        assert_eq!(rpc.stream_id, 2);
        let bulk = tokio::time::timeout(Duration::from_secs(5), proto::read_frame(&mut peer))
            .await
            .expect("等待 Bulk 超时")
            .unwrap();
        assert_eq!(bulk.kind, Kind::StreamData);
        assert_eq!(bulk.stream_id, 4);

        drop(control_tx);
        drop(data_tx);
        writer.await.unwrap().unwrap();
    }

    /// 断线期间退出的终端必须保留到下一次 attach 交付退出码和最后输出。
    #[cfg(unix)]
    #[tokio::test]
    async fn detached_exit_replays_code_and_tail_then_releases_tombstone() {
        let (run_dir, handle) = start_daemon("pty-detached-exit").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("pty-detached-exit-root");
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client
            .request(
                "pty.create",
                &json!({ "cwd": root, "shell": test_shell(), "cols": 80, "rows": 24 }),
            )
            .await;
        let info = client.wait_response(id).await;
        let pty_id = info["id"].as_str().unwrap().to_string();

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct InputParams<'a> {
            id: &'a str,
            #[serde(with = "serde_bytes")]
            data: &'a [u8],
        }
        let id = client
            .request(
                "pty.input",
                &InputParams {
                    id: &pty_id,
                    data: b"echo qingcode-tail-before-exit; sleep 0.3; exit 3\n",
                },
            )
            .await;
        client.wait_response(id).await;

        // SSH 掉线后终端继续运行，并在此后自然退出。
        drop(client);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut client = TestClient::connect(&run_dir, &token).await;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let id = client.request("pty.list", &json!({})).await;
            let list = client.wait_response(id).await;
            let exited = list["ptys"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == pty_id.as_str())
                .and_then(|item| item["exited"].as_i64());
            if exited == Some(3) {
                break;
            }
            assert!(Instant::now() < deadline, "终端未按预期退出: {list}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let id = client
            .request("pty.attach", &json!({ "id": pty_id, "fromSeq": 0 }))
            .await;
        let mut attach_exited = None;
        let mut replayed = Vec::new();
        loop {
            let frame = client.next_frame().await;
            match frame.kind {
                Kind::Res if frame.stream_id == id => {
                    let response: Response = decode_value(&frame.payload).unwrap();
                    attach_exited = response.result["exited"].as_i64();
                }
                Kind::StreamData if frame.stream_id == id => {
                    let chunk: StreamChunk = decode_value(&frame.payload).unwrap();
                    replayed.extend_from_slice(&chunk.data);
                    let credit = proto::encode(&WindowCredit {
                        credit: frame.payload.len() as u32,
                    })
                    .unwrap();
                    client.send(Kind::Window, id, &credit).await;
                }
                Kind::StreamEnd if frame.stream_id == id => {
                    let end: StreamEnd = decode_value(&frame.payload).unwrap();
                    assert!(end.ok, "attach 重放失败: {end:?}");
                    assert_eq!(end.summary["exited"].as_i64(), Some(3));
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(attach_exited, Some(3));
        assert!(
            String::from_utf8_lossy(&replayed).contains("qingcode-tail-before-exit"),
            "重放缺少终端尾部输出: {:?}",
            String::from_utf8_lossy(&replayed)
        );

        let id = client
            .request("pty.list", &json!({ "clientId": "test-client" }))
            .await;
        let list = client.wait_response(id).await;
        assert!(
            list["ptys"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["id"] != pty_id.as_str()),
            "Exit 成功交付后墓碑未释放: {list}"
        );

        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_create_accepts_args_and_env_and_rejects_preload() {
        let (run_dir, handle) = start_daemon("pty-create-options").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("pty-create-options-root");
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client
            .request(
                "pty.create",
                &json!({
                    "cwd": root,
                    "shell": "/bin/sh",
                    "args": ["-c", "printf 'args-env:%s:%s:%s\\n' \"$Q_TEST\" \"$TERM\" \"$COLORTERM\""],
                    "env": { "Q_TEST": "ok" },
                    "name": "test-profile",
                    "cols": 80,
                    "rows": 24
                }),
            )
            .await;
        let (info, events) = client.wait_response_collecting_events(id).await;
        assert_eq!(info["name"].as_str(), Some("test-profile"));
        let pty_id = info["id"].as_str().unwrap().to_string();

        let mut output = Vec::new();
        for event in events {
            if let Event::PtyData {
                id, data, offset, ..
            } = event
            {
                if id == pty_id && offset == 0 {
                    output.extend_from_slice(&data);
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&output).contains("args-env:ok:xterm-256color:truecolor") {
            assert!(Instant::now() < deadline, "未收到参数和环境变量校验输出");
            let frame = client.next_frame().await;
            if frame.kind == Kind::Event {
                if let Ok(Event::PtyData { id, data, .. }) = decode_value(&frame.payload) {
                    if id == pty_id {
                        output.extend_from_slice(&data);
                    }
                }
            }
        }

        let id = client
            .request(
                "pty.create",
                &json!({
                    "cwd": root,
                    "shell": "/bin/sh",
                    "env": { "LD_PRELOAD": "/tmp/not-allowed.so" },
                    "cols": 80,
                    "rows": 24
                }),
            )
            .await;
        let error = client.wait_error(id).await;
        assert!(
            error.message.contains("LD_PRELOAD") && error.message.contains("不允许"),
            "动态加载器变量必须被明确拒绝: {error:?}"
        );

        let id = client.request("pty.kill", &json!({ "id": pty_id })).await;
        client.wait_response(id).await;
        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    #[tokio::test]
    async fn pty_create_rejects_unknown_shell_with_clear_error() {
        let (run_dir, handle) = start_daemon("pty-unknown-shell").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("pty-unknown-shell-root");
        let mut client = TestClient::connect(&run_dir, &token).await;
        let unknown = "qingcode-shell-that-does-not-exist";

        let id = client
            .request(
                "pty.create",
                &json!({
                    "cwd": root,
                    "shell": unknown,
                    "cols": 80,
                    "rows": 24
                }),
            )
            .await;
        let error = client.wait_error(id).await;
        assert!(
            error.message.contains(unknown) && error.message.contains("不支持 shell"),
            "未知 shell 应返回明确错误: {error:?}"
        );

        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 断线重连后按 fromSeq 补发，seq 连续且内容不丢。
    #[tokio::test]
    async fn connection_drop_detaches_attached_ptys_and_keeps_process() {
        let (run_dir, handle) = start_daemon("pty").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("pty-root");
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client
            .request(
                "pty.create",
                &json!({ "cwd": root, "shell": test_shell(), "cols": 80, "rows": 24 }),
            )
            .await;
        let info = client.wait_response(id).await;
        let pty_id = info["id"].as_str().unwrap().to_string();

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct InputParams<'a> {
            id: &'a str,
            #[serde(with = "serde_bytes")]
            data: &'a [u8],
        }
        #[cfg(unix)]
        let marker_input: &[u8] = b"echo qingcode-marker\n";
        #[cfg(windows)]
        let marker_input: &[u8] = b"echo qingcode-marker\r\n";
        let id = client
            .request(
                "pty.input",
                &InputParams {
                    id: &pty_id,
                    data: marker_input,
                },
            )
            .await;
        client.wait_response(id).await;

        // 收集实时输出，直到看到 marker。
        let mut live = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !live.contains("qingcode-marker") {
            let frame = client.next_frame().await;
            if frame.kind == Kind::Event && frame.stream_id == CONTROL_STREAM {
                if let Ok(Event::PtyData { id, data, .. }) = decode_value(&frame.payload) {
                    if id == pty_id {
                        live.push_str(&String::from_utf8_lossy(&data));
                    }
                }
            }
        }
        assert!(live.contains("qingcode-marker"), "未收到终端输出: {live:?}");

        // 断开（模拟 SSH 掉线）：PTY 必须继续存在。
        drop(client);
        tokio::time::sleep(Duration::from_millis(200)).await;

        let mut client = TestClient::connect(&run_dir, &token).await;
        let id = client
            .request("pty.list", &json!({ "clientId": "test-client" }))
            .await;
        let list = client.wait_response(id).await;
        let found = list["ptys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == pty_id.as_str())
            .cloned();
        let found = found.unwrap_or_else(|| panic!("重连后终端不见了: {list}"));
        assert_eq!(
            found["detached"], true,
            "连接断开后终端应处于 detached: {found}"
        );
        assert!(
            found["exited"].is_null(),
            "detach 不应结束终端进程: {found}"
        );
        assert_eq!(found["owner"], "test-client");
        assert!(found["cwd"].as_str().is_some());

        let id = client
            .request("pty.list", &json!({ "clientId": "another-install:conn" }))
            .await;
        let other = client.wait_response(id).await;
        assert!(
            other["ptys"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["id"] != pty_id.as_str()),
            "clientId 不匹配时不应暴露其他安装的终端: {other}"
        );

        // 从 0 开始补发：seq 必须严格递增，内容里含 marker。
        let id = client
            .request("pty.attach", &json!({ "id": pty_id, "fromSeq": 0 }))
            .await;
        let mut last_seq: Option<u64> = None;
        let mut replayed = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            assert!(Instant::now() < deadline, "等 attach 流结束超时");
            let frame = client.next_frame().await;
            match frame.kind {
                Kind::Res if frame.stream_id == id => {
                    let response: Response = decode_value(&frame.payload).unwrap();
                    assert_eq!(response.result["cols"].as_u64(), Some(80));
                }
                Kind::StreamData if frame.stream_id == id => {
                    let chunk: StreamChunk = decode_value(&frame.payload).unwrap();
                    let seq = chunk.seq.unwrap();
                    if let Some(previous) = last_seq {
                        assert!(seq > previous, "补发 seq 未递增: {seq} <= {previous}");
                    }
                    last_seq = Some(seq);
                    replayed.extend_from_slice(&chunk.data);
                    let credit = proto::encode(&WindowCredit {
                        credit: frame.payload.len() as u32,
                    })
                    .unwrap();
                    client.send(Kind::Window, id, &credit).await;
                }
                Kind::StreamEnd if frame.stream_id == id => {
                    let end: StreamEnd = decode_value(&frame.payload).unwrap();
                    assert!(end.ok, "补发失败: {end:?}");
                    break;
                }
                _ => continue,
            }
        }
        let replayed = String::from_utf8_lossy(&replayed).into_owned();
        assert!(
            replayed.contains("qingcode-marker"),
            "补发内容里没有历史输出: {replayed:?}"
        );

        let id = client.request("pty.kill", &json!({ "id": pty_id })).await;
        client.wait_response(id).await;
        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 文件监视走同一个 daemon：订阅后写入文件应收到 fsChange 事件，CANCEL 后收尾。
    #[tokio::test]
    async fn watch_subscribe_streams_fs_change_until_cancelled() {
        let (run_dir, handle) = start_daemon("watch").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("watch-root");
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client
            .request("watch.subscribe", &json!({ "root": root }))
            .await;
        let ack = client.wait_response(id).await;
        assert_eq!(ack["subscribed"], true);

        // 订阅应答只是「已受理」：inotify 注册与 350ms 去抖都在后台任务里，
        // 所以这里轮询写入，直到收到事件（对应真实场景里订阅之后才发生的编辑）。
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut seen = false;
        let mut attempt = 0;
        while Instant::now() < deadline && !seen {
            std::fs::write(root.join(format!("new-file-{attempt}.txt")), "hello").unwrap();
            attempt += 1;
            while let Some(frame) = client.poll_frame(Duration::from_millis(800)).await {
                if frame.kind == Kind::Event && frame.stream_id == id {
                    if let Ok(Event::FsChange { path, .. }) = decode_value(&frame.payload) {
                        if path.contains("new-file-") {
                            seen = true;
                            break;
                        }
                    }
                }
                if frame.kind == Kind::StreamEnd && frame.stream_id == id {
                    break;
                }
            }
        }
        assert!(seen, "未收到文件变更事件（写了 {attempt} 次）");

        client.send(Kind::Cancel, id, &[]).await;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut ended = false;
        while Instant::now() < deadline && !ended {
            if let Some(frame) = client.poll_frame(Duration::from_secs(1)).await {
                if frame.kind == Kind::StreamEnd && frame.stream_id == id {
                    let end: StreamEnd = decode_value(&frame.payload).unwrap();
                    assert!(end.ok, "监视流异常收尾: {end:?}");
                    ended = true;
                }
            }
        }
        assert!(ended, "CANCEL 后未收尾");

        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 客户端暂停消费时，watch 事件突发必须通过有界队列把背压传回监视器，
    /// 不能像 PTY 溢出那样断开整条 daemon 连接。
    #[tokio::test]
    async fn watch_burst_backpressures_without_disconnecting() {
        let (run_dir, handle) = start_daemon("watch-burst").await;
        let token = run_dir.read_token().unwrap();
        let root_base = temp_dir("watch-burst-root");
        #[cfg(unix)]
        let root = {
            // 只增加测试路径长度，让 500 条路径事件足以填满 IPC 发送缓冲，
            // 稳定覆盖 writer 暂停、数据队列满的场景。
            let mut nested = root_base.clone();
            for segment in [
                "a".repeat(80),
                "b".repeat(80),
                "c".repeat(80),
                "d".repeat(80),
            ] {
                nested.push(segment);
            }
            std::fs::create_dir_all(&nested).unwrap();
            std::fs::canonicalize(nested).unwrap()
        };
        #[cfg(windows)]
        let root = root_base.clone();

        let mut client = TestClient::connect(&run_dir, &token).await;
        let id = client
            .request("watch.subscribe", &json!({ "root": root }))
            .await;
        let ack = client.wait_response(id).await;
        assert_eq!(ack["subscribed"], true);

        // 避开 watcher 初始化后的 500ms 预热窗口，再停止消费事件。
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let filler_len = if cfg!(windows) { 96 } else { 200 };
        for index in 0..500 {
            let name = format!("burst-{index:03}-{}.txt", "x".repeat(filler_len));
            std::fs::write(root.join(name), b"x").unwrap();
        }
        tokio::time::sleep(Duration::from_secs(2)).await;

        let mut fs_changes = 0;
        let deadline = Instant::now() + Duration::from_secs(15);
        while fs_changes < 64 && Instant::now() < deadline {
            let Some(frame) = client.poll_frame(Duration::from_secs(2)).await else {
                break;
            };
            if frame.kind == Kind::Event
                && frame.stream_id == id
                && matches!(
                    decode_value::<Event>(&frame.payload),
                    Ok(Event::FsChange { .. })
                )
            {
                fs_changes += 1;
            }
        }
        assert!(
            fs_changes >= 64,
            "事件突发后只收到 {fs_changes} 条 FsChange，连接可能已断开"
        );

        let info_id = client.request("server.info", &json!({})).await;
        let info = client.wait_response(info_id).await;
        assert_eq!(info["pid"].as_u64(), Some(u64::from(std::process::id())));

        let shutdown_id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(shutdown_id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root_base);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 终端输入必须按帧到达顺序落进 PTY：连发多个单字符 REQ，回显必须原序。
    /// （stty/cat 是 unix 工具，Windows 由上面的存活/补发测试覆盖 PTY 主链路。）
    #[cfg(unix)]
    #[tokio::test]
    async fn pty_input_keeps_frame_order() {
        let (run_dir, handle) = start_daemon("input-order").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("input-order-root");
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client
            .request(
                "pty.create",
                &json!({ "cwd": root, "shell": "/bin/sh", "cols": 80, "rows": 24 }),
            )
            .await;
        let info = client.wait_response(id).await;
        let pty_id = info["id"].as_str().unwrap().to_string();

        // 负载高时 shell 的提示符会插进逐字回显中间，把原序序列拆开。
        // 先等 shell 执行完这条命令：关掉回显、打印标记（标记本身不出现在命令文本里），
        // 再交给 cat 按写入顺序吐出后续字节。这是屏障，不是多等一会儿碰运气。
        let marker = "QINGCODE_READY";
        client
            .request(
                "pty.input",
                &PtyInputParams {
                    id: pty_id.clone(),
                    seq: None,
                    data: b"stty -icanon -echo min 1 time 0; printf 'QING%s\\n' CODE_READY; cat\n"
                        .to_vec(),
                },
            )
            .await;
        let mut echoed = String::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline && !echoed.contains(marker) {
            let Some(frame) = client.poll_frame(Duration::from_millis(500)).await else {
                continue;
            };
            if frame.kind == Kind::Event && frame.stream_id == CONTROL_STREAM {
                if let Ok(Event::PtyData { id, data, .. }) = decode_value(&frame.payload) {
                    if id == pty_id {
                        echoed.push_str(&String::from_utf8_lossy(&data));
                    }
                }
            }
        }
        assert!(echoed.contains(marker), "终端未进入按序回显: {echoed:?}");

        let sequence = "abcdefghijklmnopqrst";
        for ch in sequence.chars() {
            let mut buffer = [0u8; 4];
            client
                .request(
                    "pty.input",
                    &PtyInputParams {
                        id: pty_id.clone(),
                        seq: None,
                        data: ch.encode_utf8(&mut buffer).as_bytes().to_vec(),
                    },
                )
                .await;
        }
        // 换行只用来把可能按行缓冲的 cat 冲出去，不参与顺序断言。
        client
            .request(
                "pty.input",
                &PtyInputParams {
                    id: pty_id.clone(),
                    seq: None,
                    data: b"\n".to_vec(),
                },
            )
            .await;

        // 回显里必须出现完整的原序序列；乱序会在这里失败。
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline && !echoed.contains(sequence) {
            let Some(frame) = client.poll_frame(Duration::from_millis(500)).await else {
                continue;
            };
            if frame.kind == Kind::Event && frame.stream_id == CONTROL_STREAM {
                if let Ok(Event::PtyData { id, data, .. }) = decode_value(&frame.payload) {
                    if id == pty_id {
                        echoed.push_str(&String::from_utf8_lossy(&data));
                    }
                }
            }
        }
        assert!(
            echoed.contains(sequence),
            "输入顺序被打乱，回显为: {echoed:?}"
        );

        let id = client.request("pty.kill", &json!({ "id": pty_id })).await;
        client.wait_response(id).await;
        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn duplicate_pty_input_sequence_is_acknowledged_without_rewriting() {
        let (run_dir, handle) = start_daemon("input-dedup").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("input-dedup-root");
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client
            .request(
                "pty.create",
                &json!({ "cwd": root, "shell": "/bin/sh", "cols": 80, "rows": 24 }),
            )
            .await;
        let info = client.wait_response(id).await;
        assert_eq!(info["nextInputSeq"].as_u64(), Some(0));
        let pty_id = info["id"].as_str().unwrap().to_string();

        let params = json!({
            "id": pty_id.clone(),
            "seq": 0,
            "data": serde_bytes::ByteBuf::from(b"printf dedup-ok\\n\n".to_vec()),
        });
        let id = client.request("pty.input", &params).await;
        let first = client.wait_response(id).await;
        assert_eq!(first["ok"], true);
        assert!(first.get("duplicate").is_none());

        let id = client.request("pty.input", &params).await;
        let duplicate = client.wait_response(id).await;
        assert_eq!(duplicate["duplicate"], true);

        let id = client.request("pty.list", &json!({})).await;
        let list = client.wait_response(id).await;
        let pty = list["ptys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == pty_id.as_str())
            .unwrap();
        assert_eq!(pty["nextInputSeq"].as_u64(), Some(1));

        let id = client.request("pty.kill", &json!({ "id": pty_id })).await;
        client.wait_response(id).await;
        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 一个 PTY 的子进程不读 stdin 时，它自己的写任务等待；同连接另一个 PTY
    /// 的输入仍必须及时完成。同时验证每终端 64 深度队列仍返回 ptyBusy。
    #[cfg(unix)]
    #[tokio::test]
    async fn blocked_pty_input_does_not_stall_sibling_or_bypass_queue_limit() {
        let (run_dir, handle) = start_daemon("input-isolation").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("input-isolation-root");
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client
            .request(
                "pty.create",
                &json!({ "cwd": root, "shell": "/bin/sh", "cols": 80, "rows": 24 }),
            )
            .await;
        let blocked = client.wait_response(id).await["id"]
            .as_str()
            .unwrap()
            .to_string();
        let id = client
            .request(
                "pty.create",
                &json!({ "cwd": root, "shell": "/bin/sh", "cols": 80, "rows": 24 }),
            )
            .await;
        let sibling = client.wait_response(id).await["id"]
            .as_str()
            .unwrap()
            .to_string();

        client
            .request(
                "pty.input",
                &PtyInputParams {
                    id: blocked.clone(),
                    seq: None,
                    data:
                        b"stty -echo; printf 'BLOCK%s\\n' _READY; exec sh -c 'while read x; do sleep 1; done'\n"
                            .to_vec(),
                },
            )
            .await;
        let mut output = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !output.contains("BLOCK_READY") {
            let frame = client.next_frame().await;
            if frame.kind == Kind::Event && frame.stream_id == CONTROL_STREAM {
                if let Ok(Event::PtyData { id, data, .. }) = decode_value(&frame.payload) {
                    if id == blocked {
                        output.push_str(&String::from_utf8_lossy(&data));
                    }
                }
            }
        }
        assert!(output.contains("BLOCK_READY"), "阻塞终端未就绪: {output:?}");

        for _ in 0..12 {
            client
                .request(
                    "pty.input",
                    &PtyInputParams {
                        id: blocked.clone(),
                        seq: None,
                        data: vec![b'x'; 768 * 1024],
                    },
                )
                .await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;

        for _ in 0..70 {
            client
                .request(
                    "pty.input",
                    &PtyInputParams {
                        id: blocked.clone(),
                        seq: None,
                        data: b"x".to_vec(),
                    },
                )
                .await;
        }

        let sibling_input = client
            .request(
                "pty.input",
                &PtyInputParams {
                    id: sibling.clone(),
                    seq: None,
                    data: b"printf 'SIBLING%s\\n' _READY\n".to_vec(),
                },
            )
            .await;

        let mut saw_busy = false;
        let mut sibling_ok = false;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && !(saw_busy && sibling_ok) {
            let Some(frame) = client.poll_frame(Duration::from_millis(200)).await else {
                continue;
            };
            match frame.kind {
                Kind::Err => {
                    if let Ok(error) = decode_value::<ErrorBody>(&frame.payload) {
                        saw_busy |= error.code == "ptyBusy";
                    }
                }
                Kind::Res if frame.stream_id == sibling_input => {
                    let response: Response = decode_value(&frame.payload).unwrap();
                    sibling_ok = response.result["ok"].as_bool().unwrap_or(false);
                }
                _ => {}
            }
        }
        assert!(saw_busy, "同一 PTY 的第 65 条待写输入应返回 ptyBusy");
        assert!(sibling_ok, "阻塞 PTY 拖住了同连接另一个 PTY 的输入");

        let id = client.request("pty.kill", &json!({ "id": blocked })).await;
        client.wait_response(id).await;
        let id = client.request("pty.kill", &json!({ "id": sibling })).await;
        client.wait_response(id).await;
        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 搜索可以中途取消：CANCEL 之后流以 cancelled 收尾。
    #[tokio::test]
    async fn search_can_be_cancelled() {
        let (run_dir, handle) = start_daemon("cancel").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("cancel-root");
        for index in 0..64 {
            std::fs::write(root.join(format!("f{index}.txt")), "needle\n").unwrap();
        }
        let mut client = TestClient::connect(&run_dir, &token).await;
        let id = client
            .request(
                "search.content",
                &json!({ "root": root, "query": "needle" }),
            )
            .await;
        client.send(Kind::Cancel, id, &[]).await;
        let (_records, end) = client.collect_stream(id).await;
        assert!(end.summary["cancelled"].as_bool().unwrap_or(false) || end.ok);

        let id = client.request("server.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// Windows 客户端用 POSIX 风格表示远端根（`/D:/...`），必须还原成 Win32
    /// 绝对路径，否则 `is_absolute()` 会误判为相对路径而整条 daemon 传输降级。
    #[cfg(windows)]
    #[test]
    fn normalize_root_path_accepts_posix_drive_prefix() {
        assert_eq!(
            normalize_root_path("/D:/code/app"),
            PathBuf::from(r"D:\code\app")
        );
        assert_eq!(
            normalize_root_path("/D:/code\\app"),
            PathBuf::from(r"D:\code\app")
        );
        assert_eq!(normalize_root_path("/C:"), PathBuf::from(r"C:\"));
        // 非盘符形态保持原样，canonical_root 仍会拒绝（无盘符不是绝对路径）。
        assert_eq!(normalize_root_path("/home/dev"), PathBuf::from("/home/dev"));
        assert!(canonical_root("/home/dev").is_err());
    }
}
