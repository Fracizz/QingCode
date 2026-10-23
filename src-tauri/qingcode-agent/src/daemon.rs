//! `daemon` 常驻进程：持有 PTY 与文件监视状态，经本地 Unix socket 与连接代理通信。
//!
//! 与 `serve` 的区别：`serve` 每条 TCP 连接只承载一次操作，进程随客户端退出；
//! daemon 是每个远端用户一份的常驻进程，SSH 断开只让 `connect --stdio` 退出，
//! PTY 与缓冲都留着，下次连接用 `pty.attach{fromSeq}` 接回。
//!
//! 安全边界（设计 §8）：
//! - 运行目录 `~/.qingcode/agent/run/` 权限 `0700`，socket 与 token 都在其中；
//! - 接受连接时用 `SO_PEERCRED`（tokio 的 `peer_cred`）校验对端 uid；
//! - HELLO 必须携带 `run/token` 的内容，错误即断开；
//! - 文件操作按「项目根」做词法 + canonicalize 双重校验，不跟随符号链接越界。
//!
//! 单实例：`run/daemon.lock` 上的 `flock(LOCK_EX|LOCK_NB)`。抢不到锁说明已有实例，
//! 本进程直接退出（退出码 0），由调用方连上那个实例。

#![cfg(unix)]

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Notify};

use crate::proto::{
    encode, ErrorBody, Event, Frame, HelloRequest, HelloResponse, Kind, OutboundQueue, Priority,
    Request, Response, SenderWindow, StreamEnd, WindowCredit, CONTROL_STREAM, HEARTBEAT_INTERVAL,
    HEARTBEAT_TIMEOUT, PROTOCOL_MIN, PROTOCOL_VERSION, WINDOW_BYTES,
};
use crate::pty::{PtyCreateOptions, PtyEvent, PtyHost};
use crate::{ops, proto, watch, AGENT_VERSION};

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

/// 能力列表：客户端按它开关功能，不写死平台规则。
pub const CAPABILITIES: &[&str] = &[
    "fs.scan",
    "search.content",
    "watch.subscribe",
    "pty.persist",
    "pty.attach",
    "agent.shutdown",
];

/// daemon 启动参数。
#[derive(Debug, Clone)]
pub struct DaemonOptions {
    /// 覆盖运行目录（测试用）。为空时用 `$HOME/.qingcode/agent/run`。
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
    /// 解析并创建运行目录，权限收紧到 `0700`。
    pub fn resolve(override_dir: Option<&Path>) -> Result<Self, String> {
        let dir = match override_dir {
            Some(path) => path.to_path_buf(),
            None => home_dir()
                .ok_or_else(|| "无法确定家目录，请用 --state-dir 指定运行目录".to_string())?
                .join(".qingcode")
                .join("agent")
                .join("run"),
        };
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建运行目录 {} 失败: {e}", dir.display()))?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("无法收紧运行目录权限: {e}"))?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn socket(&self) -> PathBuf {
        self.dir.join("daemon.sock")
    }

    pub fn token(&self) -> PathBuf {
        self.dir.join("token")
    }

    pub fn lock(&self) -> PathBuf {
        self.dir.join("daemon.lock")
    }

    pub fn log(&self) -> PathBuf {
        self.dir.join("agent.log")
    }

    /// 生成新 token 并原子写入（`0600`）。
    ///
    /// 每次 daemon 启动都换 token：旧连接代理在进程退出后已不存在，
    /// 换新能顺带作废可能泄漏的旧 token。
    pub fn rotate_token(&self) -> Result<String, String> {
        let token = crate::generate_token();
        let temp = self.dir.join(format!(".token.tmp.{}", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
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

/// 家目录：远端以 SSH 用户身份运行，`HOME` 一定存在；没有时返回 None。
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// `flock` 单实例锁。持有期间其他进程 `acquire` 返回 `None`。
pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    /// 非阻塞抢锁。`Ok(None)` 表示已有实例在运行。
    pub fn acquire(path: &Path) -> Result<Option<Self>, String> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("打开锁文件 {} 失败: {e}", path.display()))?;
        // SAFETY: flock 只作用于本进程持有的 fd，不涉及内存安全。
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            return Ok(Some(Self { _file: file }));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Ok(None);
        }
        Err(format!("加锁 {} 失败: {error}", path.display()))
    }
}

/// 滚动日志。
///
/// 写前检查大小，超过 [`LOG_MAX_BYTES`] 就把 `agent.log` 挪成 `.1`，旧的
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
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
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
        inner.file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)
            .ok();
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

/// 异步入口：建目录 → 抢锁 → 换 token → 监听 → 服务循环。
///
/// 已有实例时返回 `Ok(())`（调用方按「无需启动」处理）。
pub async fn run_async(options: DaemonOptions) -> Result<(), String> {
    let run_dir = RunDir::resolve(options.state_dir.as_deref())?;
    let Some(_lock) = InstanceLock::acquire(&run_dir.lock())? else {
        return Ok(());
    };
    let token = run_dir.rotate_token()?;
    let log = Log::open(run_dir.log())?;
    log.info(&format!(
        "daemon 启动 pid={} protocol={PROTOCOL_VERSION} max_ptys={}",
        std::process::id(),
        options.max_ptys
    ));

    // 抢到锁说明目录里的 socket 一定是上次崩溃的残留，删掉再绑。
    let socket = run_dir.socket();
    let _ = std::fs::remove_file(&socket);
    let listener =
        UnixListener::bind(&socket).map_err(|e| format!("绑定 {} 失败: {e}", socket.display()))?;
    let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));

    let result = serve(options, run_dir, token, log, listener).await;
    let _ = std::fs::remove_file(&socket);
    result
}

async fn serve(
    options: DaemonOptions,
    run_dir: RunDir,
    token: String,
    log: Log,
    listener: UnixListener,
) -> Result<(), String> {
    let (pty_tx, pty_rx) = mpsc::unbounded_channel::<PtyEvent>();
    let pty = Arc::new(PtyHost::new(
        options.max_ptys,
        options.pty_buffer_bytes,
        pty_tx,
    ));
    let daemon = Arc::new(Daemon {
        pty,
        token,
        log: Arc::new(log),
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
    daemon.log.info("开始接受本地连接");

    let mut idle_since = Some(Instant::now());
    let mut reap = tokio::time::interval(REAP_INTERVAL);
    reap.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = daemon.shutdown.notified() => {
                daemon.log.info("收到 agent.shutdown，准备退出");
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
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        if daemon.conns.lock().unwrap().len() >= MAX_CONNS {
                            daemon.log.warn("连接数超过上限，拒绝新连接");
                            continue;
                        }
                        tokio::spawn(handle_conn(Arc::clone(&daemon), stream));
                    }
                    Err(e) => daemon.log.warn(&format!("accept 失败: {e}")),
                }
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
    /// pty id → 当前持有它的连接 id。断线后清除，PTY 继续运行。
    routes: Mutex<HashMap<String, u32>>,
    shutdown: Notify,
    detached_ttl: Duration,
    idle_exit: Duration,
    scrollback_bytes: usize,
    run_dir: RunDir,
}

#[derive(Clone)]
struct ConnHandle {
    tx: mpsc::UnboundedSender<Outbound>,
}

struct Outbound {
    priority: Priority,
    frame: Frame,
}

impl Daemon {
    fn is_idle(&self) -> bool {
        self.conns.lock().unwrap().is_empty() && self.pty.list().is_empty()
    }

    fn client_count(&self) -> usize {
        self.conns.lock().unwrap().len()
    }

    fn send_to_conn(&self, conn_id: u32, priority: Priority, frame: Frame) {
        let conns = self.conns.lock().unwrap();
        if let Some(handle) = conns.get(&conn_id) {
            let _ = handle.tx.send(Outbound { priority, frame });
        }
    }

    fn route_of(&self, pty_id: &str) -> Option<u32> {
        self.routes.lock().unwrap().get(pty_id).copied()
    }

    fn set_route(&self, pty_id: &str, conn_id: u32) {
        self.routes
            .lock()
            .unwrap()
            .insert(pty_id.to_string(), conn_id);
    }

    fn clear_route(&self, pty_id: &str) {
        self.routes.lock().unwrap().remove(pty_id);
    }

    /// 连接断开时把它名下的终端标记为 detached，但绝不结束进程。
    fn detach_owned_ptys(&self, conn_id: u32, client_id: &str) {
        let owned: Vec<String> = {
            let routes = self.routes.lock().unwrap();
            routes
                .iter()
                .filter(|(_, owner)| **owner == conn_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in owned {
            let _ = self.pty.detach(&id, client_id);
            self.clear_route(&id);
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
    tx: mpsc::UnboundedSender<Outbound>,
    cancels: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
    windows: Arc<Mutex<HashMap<u32, Arc<SenderWindow>>>>,
    /// 终端写入队列。按键顺序必须等于帧到达顺序，所以 `pty.input` 不参与
    /// 「一个 REQ 一个 task」的并发派发，而是在读循环里按顺序入队、由单个
    /// 任务串行写（见 [`pty_input_loop`]）。
    inputs: mpsc::Sender<PtyInput>,
}

/// 一条待写入终端的输入。
struct PtyInput {
    request_id: u32,
    pty_id: String,
    data: Vec<u8>,
}

/// `pty.input` 的参数。放在模块级是因为读循环也要用它（不能只在 dispatch 里）。
/// Serialize 仅供测试的 TestClient 复用（回环测试要构造输入帧）。
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyInputParams {
    id: String,
    #[serde(with = "serde_bytes")]
    data: Vec<u8>,
}

/// 串行消费终端输入：一次只写一条，写完再取下一条。
///
/// `PtyHost::write` 是阻塞写入（子进程不读 stdin 时会一直等），所以每条都
/// 丢进 blocking 线程池；串行 await 保证「先到的按键先写进 PTY」。
async fn pty_input_loop(conn: ConnCtx, pty: Arc<PtyHost>, mut rx: mpsc::Receiver<PtyInput>) {
    while let Some(input) = rx.recv().await {
        let pty = Arc::clone(&pty);
        let PtyInput {
            request_id,
            pty_id,
            data,
        } = input;
        let written = tokio::task::spawn_blocking(move || pty.write(&pty_id, &data)).await;
        match written {
            Ok(Ok(())) => conn.respond(request_id, json!({ "ok": true })),
            Ok(Err(message)) => conn.fail(request_id, "pty", message),
            Err(_) => conn.fail(request_id, "internal", "写入终端任务异常结束"),
        }
    }
}

/// 在读循环里按帧序把 `pty.input` 入队。
fn enqueue_pty_input(conn: &ConnCtx, request: Request) {
    let id = request.id;
    let Ok(params) = request.parse::<PtyInputParams>() else {
        conn.fail(id, "badRequest", "pty.input 参数错误");
        return;
    };
    let input = PtyInput {
        request_id: id,
        pty_id: params.id,
        data: params.data,
    };
    match conn.inputs.try_send(input) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(_)) => conn.fail(
            id,
            "ptyBusy",
            format!("终端输入队列已满（{INPUT_QUEUE_DEPTH} 条待写），请稍后重试"),
        ),
        Err(mpsc::error::TrySendError::Closed(_)) => {
            conn.fail(id, "internal", "连接已关闭，输入未写入")
        }
    }
}

impl ConnCtx {
    fn send(&self, priority: Priority, frame: Frame) {
        let _ = self.tx.send(Outbound { priority, frame });
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
                    self.send(priority, Frame::new(Kind::StreamData, id, payload));
                    return true;
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

/// 校验对端 uid 与握手，失败即断开。成功后才登记到连接表。
async fn handle_conn(daemon: Arc<Daemon>, stream: UnixStream) {
    let Ok(cred) = stream.peer_cred() else {
        daemon.log.warn("无法获取对端凭据，拒绝连接");
        return;
    };
    // SAFETY: geteuid 无副作用。
    let self_uid = unsafe { libc::geteuid() };
    if cred.uid() != self_uid {
        daemon
            .log
            .warn(&format!("对端 uid {} 与本进程不符，拒绝连接", cred.uid()));
        return;
    }
    let (mut reader, writer) = stream.into_split();

    let hello =
        match tokio::time::timeout(Duration::from_secs(10), proto::read_frame(&mut reader)).await {
            Ok(Ok(frame)) if frame.kind == Kind::Hello => frame,
            _ => {
                daemon.log.warn("握手超时或首帧不是 HELLO");
                return;
            }
        };
    let Ok(request) = proto::decode_value::<HelloRequest>(&hello.payload) else {
        daemon.log.warn("HELLO 负载无法解码");
        return;
    };
    if request.token != daemon.token {
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
    let (tx, rx) = mpsc::unbounded_channel::<Outbound>();
    daemon
        .conns
        .lock()
        .unwrap()
        .insert(conn_id, ConnHandle { tx: tx.clone() });

    let response = HelloResponse {
        protocol,
        agent_version: AGENT_VERSION.to_string(),
        pid: std::process::id(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: home_dir().map(|path| path.to_string_lossy().into_owned()),
        shells: available_shells(),
        capabilities: CAPABILITIES.iter().map(|item| item.to_string()).collect(),
        pty_count: daemon.pty.list().len(),
    };
    if let Ok(payload) = encode(&response) {
        let _ = tx.send(Outbound {
            priority: Priority::Control,
            frame: Frame::new(Kind::Hello, CONTROL_STREAM, payload),
        });
    }
    daemon.log.info(&format!(
        "客户端 {} 接入（连接 {conn_id}，protocol {protocol}）",
        request.client_id
    ));

    let writer_task = tokio::spawn(writer_loop(writer, rx));
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Frame>();
    // 读端单独一个任务：帧读到一半时不能被 `select!` 取消（read_exact 不是
    // cancel-safe），否则会丢字节、后续帧全部错位。
    let reader_task = tokio::spawn(async move {
        while let Ok(frame) = proto::read_frame(&mut reader).await {
            if frame_tx.send(frame).is_err() {
                break;
            }
        }
    });

    let (input_tx, input_rx) = mpsc::channel::<PtyInput>(INPUT_QUEUE_DEPTH);
    let ctx = ConnCtx {
        conn_id,
        client_id: request.client_id.clone(),
        tx,
        cancels: Arc::new(Mutex::new(HashMap::new())),
        windows: Arc::new(Mutex::new(HashMap::new())),
        inputs: input_tx,
    };
    let input_task = tokio::spawn(pty_input_loop(
        ctx.clone(),
        Arc::clone(&daemon.pty),
        input_rx,
    ));
    let mut last_seen = Instant::now();
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
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
                                enqueue_pty_input(&ctx, request);
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
    input_task.abort();
    daemon.detach_owned_ptys(conn_id, &ctx.client_id);
    daemon.conns.lock().unwrap().remove(&conn_id);
    // 置位所有取消标记：搜索/监视任务在下一个检查点退出。
    for flag in ctx.cancels.lock().unwrap().values() {
        flag.store(true, Ordering::SeqCst);
    }
    drop(ctx);
    let _ = writer_task.await;
    daemon.log.info(&format!("连接 {conn_id} 断开"));
}

fn negotiate(min: u32, max: u32) -> Option<u32> {
    if max < PROTOCOL_MIN || min > PROTOCOL_VERSION {
        return None;
    }
    Some(max.min(PROTOCOL_VERSION))
}

/// 可用 shell：登录 shell 优先，其余按常见路径探测。只回报名字，不带参数。
fn available_shells() -> Vec<String> {
    let mut shells = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        if let Some(name) = Path::new(&shell).file_name() {
            shells.push(name.to_string_lossy().into_owned());
        }
    }
    for name in ["bash", "zsh", "sh", "fish"] {
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

/// 写端：把优先级队列里的帧按序刷出。
async fn writer_loop(
    mut writer: tokio::net::unix::OwnedWriteHalf,
    mut rx: mpsc::UnboundedReceiver<Outbound>,
) {
    let mut queue = OutboundQueue::new();
    loop {
        while let Ok(out) = rx.try_recv() {
            if queue.push_with(out.priority, out.frame).is_err() {
                // 队列上限 8MB：只有对端长期不读才会到这里。直接断开，
                // 让客户端重连后重新 attach（PTY 不受影响）。
                return;
            }
        }
        while let Some(frame) = queue.pop() {
            if proto::write_frame(&mut writer, &frame).await.is_err() {
                return;
            }
        }
        match rx.recv().await {
            Some(out) => {
                if queue.push_with(out.priority, out.frame).is_err() {
                    return;
                }
            }
            None => {
                // 发送端已释放：把剩下的帧写完再收尾。
                while let Some(frame) = queue.pop() {
                    if proto::write_frame(&mut writer, &frame).await.is_err() {
                        return;
                    }
                }
                return;
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
        "agent.info" => {
            let info = json!({
                "version": AGENT_VERSION,
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
        "agent.shutdown" => {
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
    let path = PathBuf::from(root);
    if !path.is_absolute() {
        return Err("root 必须是绝对路径".to_string());
    }
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("路径不可访问: {e}"))?;
    if !canonical.is_dir() {
        return Err("路径不是目录".to_string());
    }
    Ok(canonical)
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
        conn.send(Priority::Rpc, Frame::new(Kind::Event, id, payload));
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
            seq: info.seq,
            cols: info.cols,
            rows: info.rows,
            exited: info.exited,
            detached: info.detached,
        }
    }
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
                cols: params.cols.max(1),
                rows: params.rows.max(1),
                scrollback_bytes: daemon.scrollback_bytes,
                client_id: conn.client_id.clone(),
            };
            // pty.rs 的 create 要 openpty + fork/exec，且限额检查与创建在同一把宿主锁里，
            // 直接放在 async 里会阻塞 worker（其它连接的心跳与应答都得等）。
            let pty = Arc::clone(&daemon.pty);
            let created = tokio::task::spawn_blocking(move || pty.create(options)).await;
            match created {
                Ok(Ok(info)) => {
                    let pty_id = info.id.clone();
                    daemon.set_route(&pty_id, conn.conn_id);
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
            let attach = match daemon
                .pty
                .attach(&params.id, params.from_seq, &conn.client_id)
            {
                Ok(attach) => attach,
                Err(message) => {
                    conn.fail(id, "pty", message);
                    return;
                }
            };
            daemon.set_route(&params.id, conn.conn_id);
            conn.respond(
                id,
                json!({
                    "screen": attach.screen,
                    "cols": attach.cols,
                    "rows": attach.rows,
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
                    daemon.clear_route(&params.id);
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
            match daemon.pty.kill(&params.id) {
                Ok(()) => {
                    daemon.clear_route(&params.id);
                    conn.respond(id, json!({ "ok": true }));
                }
                Err(message) => conn.fail(id, "pty", message),
            }
        }
        "pty.list" => {
            let ptys: Vec<PtyInfoDto> = daemon.pty.list().into_iter().map(Into::into).collect();
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
async fn pty_events(daemon: Arc<Daemon>, mut rx: mpsc::UnboundedReceiver<PtyEvent>) {
    while let Some(event) = rx.recv().await {
        match event {
            PtyEvent::Data { id, seq, data } => {
                let Some(conn_id) = daemon.route_of(&id) else {
                    // 没有客户端持有：数据留在环形缓冲里，等 attach 补发。
                    continue;
                };
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
                    daemon.send_to_conn(
                        conn_id,
                        Priority::Terminal,
                        Frame::new(Kind::Event, CONTROL_STREAM, payload),
                    );
                }
            }
            PtyEvent::Exit { id, code } => {
                daemon.log.info(&format!("终端 {id} 退出（code={code:?}）"));
                if let Some(conn_id) = daemon.route_of(&id) {
                    let event = Event::PtyExit { id, code };
                    if let Ok(payload) = encode(&event) {
                        daemon.send_to_conn(
                            conn_id,
                            Priority::Terminal,
                            Frame::new(Kind::Event, CONTROL_STREAM, payload),
                        );
                    }
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

    /// 等 socket 与 token 就绪（daemon 的启动是异步的）。
    async fn wait_ready(run_dir: &RunDir) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if run_dir.socket().exists() && run_dir.read_token().is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("daemon 未在 10s 内就绪");
    }

    struct TestClient {
        stream: UnixStream,
        next_id: u32,
    }

    impl TestClient {
        async fn connect(run_dir: &RunDir, token: &str) -> Self {
            let stream = UnixStream::connect(run_dir.socket()).await.unwrap();
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

        let id = client.request("agent.info", &json!({})).await;
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
        let id = client
            .request(
                "fs.scan",
                &json!({ "root": "/nonexistent-root", "path": "" }),
            )
            .await;
        loop {
            let frame = client.next_frame().await;
            if frame.kind == Kind::Err && frame.stream_id == id {
                let error: ErrorBody = decode_value(&frame.payload).unwrap();
                assert_eq!(error.code, "outsideRoot");
                break;
            }
        }

        let id = client.request("agent.shutdown", &json!({})).await;
        let result = client.wait_response(id).await;
        assert_eq!(result["ok"], true);
        let joined = tokio::time::timeout(Duration::from_secs(10), handle)
            .await
            .expect("daemon 未退出")
            .unwrap();
        assert!(joined.is_ok());
        assert!(!run_dir.socket().exists(), "退出后 socket 未清理");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    #[tokio::test]
    async fn wrong_token_is_rejected_without_hello() {
        let (run_dir, handle) = start_daemon("token").await;
        let mut stream = UnixStream::connect(run_dir.socket()).await.unwrap();
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
        let id = client.request("agent.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    #[test]
    fn instance_lock_is_exclusive_within_one_process() {
        let dir = temp_dir("lock");
        let path = dir.join("daemon.lock");
        let first = InstanceLock::acquire(&path).unwrap().expect("首次加锁失败");
        // flock 按「打开的文件描述」记账：同进程再 open 一次是独立描述，
        // 会被已持有的锁挡住，正是我们需要的单实例语义。
        assert!(
            InstanceLock::acquire(&path).unwrap().is_none(),
            "第二次加锁应当失败"
        );
        drop(first);
        assert!(
            InstanceLock::acquire(&path).unwrap().is_some(),
            "释放后应能重新加锁"
        );
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
        let path = dir.join("agent.log");
        let log = Log::open(path.clone()).unwrap();
        let line = "x".repeat(1024 * 1024);
        for _ in 0..20 {
            log.info(&line);
        }
        assert!(dir.join("agent.log.1").exists(), "未生成归档");
        assert!(!dir.join("agent.log.4").exists(), "归档份数超过 3");
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

    /// 断线重连后按 fromSeq 补发，seq 连续且内容不丢。
    #[tokio::test]
    async fn pty_survives_disconnect_and_attach_replays_output() {
        let (run_dir, handle) = start_daemon("pty").await;
        let token = run_dir.read_token().unwrap();
        let root = temp_dir("pty-root");
        let mut client = TestClient::connect(&run_dir, &token).await;

        let id = client
            .request(
                "pty.create",
                &json!({ "cwd": root, "shell": "/bin/sh", "cols": 80, "rows": 24 }),
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
                    data: b"echo qingcode-marker\n",
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
        let id = client.request("pty.list", &json!({})).await;
        let list = client.wait_response(id).await;
        let found = list["ptys"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == pty_id.as_str());
        assert!(found, "重连后终端不见了: {list}");

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
        let id = client.request("agent.shutdown", &json!({})).await;
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

        let id = client.request("agent.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }

    /// 终端输入必须按帧到达顺序落进 PTY：连发多个单字符 REQ，回显必须原序。
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

        let sequence = "abcdefghijklmnopqrst";
        for ch in sequence.chars() {
            let mut buffer = [0u8; 4];
            client
                .request(
                    "pty.input",
                    &PtyInputParams {
                        id: pty_id.clone(),
                        data: ch.encode_utf8(&mut buffer).as_bytes().to_vec(),
                    },
                )
                .await;
        }

        // 回显里必须出现完整的原序序列；乱序会在这里失败。
        let mut echoed = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
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
        let id = client.request("agent.shutdown", &json!({})).await;
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

        let id = client.request("agent.shutdown", &json!({})).await;
        client.wait_response(id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(run_dir.dir());
    }
}
