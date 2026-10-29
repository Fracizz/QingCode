//! PTY 持久化宿主（设计文档 §6）。
//!
//! daemon 用它承载远端终端：PTY 归宿主所有，客户端断开只把终端标记为 detached，
//! 进程继续运行、输出继续进缓冲。重连时按 `seq` 补发缺失输出，补不上就给屏幕快照。
//!
//! 每个终端维护两份状态：
//!
//! - [`vt100::Parser`]：无界面终端模拟器，随时能导出当前屏幕（`contents_formatted`，
//!   含颜色与光标），用于「缓冲已被淘汰」时的兜底；
//! - [`RingBuffer`]：环形输出缓冲，保存 `(seq, bytes)` 分片，供 `attach{from_seq}` 重放。
//!
//! **seq 语义**：缓冲按「块」编号，每个数据块（一次 `read` 的产物）占一个 seq，从 0
//! 开始单调递增，块内字节连续（不是每字节一个 seq——那样序号会膨胀几个数量级，而
//! 客户端只需要知道「从哪块开始补」）。`seq_end` 是**下一个将被分配的 seq**，
//! 所以客户端重连时带 `from_seq = 已收到的最后一个 seq + 1`：
//! `attach{from_seq}` 重放所有 `seq >= from_seq` 的块，`from_seq == seq_end` 表示
//! 客户端已经追平，重放为空。
//!
//! **平台差异**：Linux/macOS 走 `openpty`，Windows 走 ConPTY，都由 `portable-pty`
//! 屏蔽。`has_children` 与 `reap` 依赖 `libc`/`/proc`，只在 unix 上实现；Windows
//! 退化为「无子进程」与「用 `ChildKiller` 结束进程」，行为差异写在各函数注释里。

// daemon 已在全平台使用本宿主（Windows 走 ConPTY，见 daemon.rs / ipc.rs），
// 不再需要按平台豁免 dead_code。

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc::Sender;
use vt100::Parser;

/// 单次从 master 读的字节数。和主程序终端一致：8KB 足够摊薄系统调用，
/// 又不会让单个 seq 块在环形缓冲里占太大地盘。
const READ_BUF_BYTES: usize = 8 * 1024;

/// 非阻塞 PTY 无数据时的等待周期。用 poll 而不是忙等，64 个空闲终端
/// 也只产生很低唤醒率。
#[cfg(unix)]
const READ_WAIT_TIMEOUT_MS: libc::c_int = 250;

/// 非阻塞写入遇到 `WouldBlock` 后的重试间隔。队列 task 在此期间仍可被取消。
const WRITE_RETRY_DELAY: Duration = Duration::from_millis(1);

/// 已退出终端在没有连接接手时的保留时长。保留 ring 与 parser 是为了让
/// 断线期间结束的进程仍能在重连后补发最后输出和退出码。
const EXITED_RETENTION: Duration = Duration::from_secs(30 * 60);

/// `vt100` 的 scrollback 以**行**为单位分配，一行 `cols` 个 cell，单 cell 十几字节。
/// 若直接按「字节预算 / 列数」折算，2MB/80 列 ≈ 26k 行，每个终端要吃掉几十 MB；
/// 屏幕快照只需要可见屏 + 少量历史，这里封顶 1000 行。
const MAX_PARSER_SCROLLBACK_LINES: usize = 1000;

/// PTY 尺寸下限：0 行/0 列会让 `vt100` 的网格退化，`ioctl` 也可能直接失败。
const MIN_COLS: u16 = 2;
const MIN_ROWS: u16 = 1;
const MAX_COLS: u16 = 1000;
const MAX_ROWS: u16 = 500;

/// 统一的加锁入口：任何线程 panic 都不该让宿主整体不可用，
/// 中毒的锁继续用（内部状态即使不完整，也比 daemon 直接 panic 好）。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 去掉 Windows canonicalize 产生的 verbatim 前缀（`\\?\D:\...`、`\\?\UNC\...`）。
///
/// CreateProcess 能接受该前缀，但 PowerShell 无法把它映射到盘符，提示符会显示成
/// `PS Microsoft.PowerShell.Core\FileSystem::\\?\D:\...>`，因此交给 shell 前必须还原。
fn strip_windows_verbatim_prefix(text: &str) -> Option<Cow<'_, str>> {
    let rest = text.strip_prefix(r"\\?\")?;
    if rest
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"UNC\"))
    {
        return Some(Cow::Owned(format!(r"\\{}", &rest[4..])));
    }
    Some(Cow::Borrowed(rest))
}

fn shell_working_directory(cwd: &Path) -> Cow<'_, Path> {
    if let Some(text) = cwd.to_str() {
        if let Some(stripped) = strip_windows_verbatim_prefix(text) {
            return Cow::Owned(PathBuf::from(stripped.as_ref()));
        }
    }
    Cow::Borrowed(cwd)
}

/// 创建一个 PTY 的参数。
#[derive(Debug, Clone)]
pub struct PtyCreateOptions {
    /// 终端工作目录（项目根）。
    pub cwd: PathBuf,
    /// 显式指定的 shell；`None` 时用 `$SHELL`，再退化到 `/bin/sh`（登录 shell）。
    /// Windows 默认 `powershell.exe`，显式值只允许 powershell、pwsh 和 cmd。
    pub shell: Option<String>,
    /// 传给 shell 的附加参数（终端配置文件的启动参数）。
    pub args: Vec<String>,
    /// 追加到 daemon 基础环境上的变量；固定 TERM / COLORTERM 不允许覆盖。
    pub env: BTreeMap<String, String>,
    /// 终端配置文件名称，仅作为终端元数据保留。
    pub name: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// 该终端环形缓冲的字节上限（0 表示不缓冲，重连一律走屏幕快照）。
    pub scrollback_bytes: usize,
    /// 发起创建/接入的客户端标识，用于 detach 时的归属校验。
    pub client_id: String,
}

/// `pty.list` 返回的单个终端信息。
#[derive(Debug, Clone)]
pub struct PtyInfo {
    pub id: String,
    pub name: Option<String>,
    /// 下一个应由客户端写入的输入序号。
    pub next_input_seq: u64,
    /// 发起创建/接入的客户端；detach 后保留，供应用重启时精确筛出孤儿终端。
    pub owner: Option<String>,
    /// PTY 的远端工作目录，用于映射回 QingCode 的 SSH 资源 URI。
    pub cwd: Option<String>,
    /// 下一个将被分配的 seq（即客户端已经收到的最大 seq + 1）。
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    /// `Some(code)` 表示进程已退出；`None` 表示仍在运行。
    pub exited: Option<i32>,
    /// 没有客户端接着。
    pub detached: bool,
}

/// `pty.attach` 的结果：两条互斥路径二选一。
///
/// - `screen = None, replay = 缺失块`：`from_seq` 仍被缓冲覆盖，客户端无缝接上；
/// - `screen = Some(快照), replay = 空`：缓冲已被覆盖或客户端序号超前，
///   客户端应先清屏再打印快照，然后接实时流。
#[derive(Debug, Clone)]
pub struct AttachResult {
    pub screen: Option<String>,
    pub replay: Vec<(u64, Vec<u8>)>,
    pub seq_end: u64,
    pub cols: u16,
    pub rows: u16,
    pub next_input_seq: u64,
    pub exited: Option<i32>,
}

/// [`PtyHost::write_input`] 的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputOutcome {
    Written,
    /// 该序号此前已写入，本次未重复写。
    Duplicate,
}

/// [`PtyHost::write_input`] 的失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputError {
    /// 序号跳号：客户端漏发了中间的输入。
    Gap {
        expected: u64,
    },
    Other(String),
}

/// 带序号写入的进度：`skip` 是续写起点，每写出一段就落到终端状态里。
#[derive(Clone, Copy)]
struct InputProgress {
    seq: u64,
    skip: usize,
}

/// 记录已写偏移；整笔写完（含 flush）后推进序号并清掉进度。
fn record_input_progress(
    term: &PtyTerm,
    progress: Option<InputProgress>,
    offset: usize,
    done: bool,
) {
    let Some(progress) = progress else {
        return;
    };
    let mut state = lock(&term.state);
    if state.next_input_seq != progress.seq {
        return;
    }
    if done {
        state.next_input_seq = state.next_input_seq.wrapping_add(1);
        state.input_partial = None;
    } else {
        state.input_partial = Some((progress.seq, offset));
    }
}

/// 宿主向 daemon 推送的事件。
#[derive(Debug, Clone)]
pub enum PtyEvent {
    /// `seq` 是该数据块的编号，`data` 是原始字节（可能含不完整 UTF-8 序列）。
    Data { id: String, seq: u64, data: Vec<u8> },
    /// 进程退出。`code` 取不到时为 `None`。
    Exit { id: String, code: Option<i32> },
}

/// 环形输出缓冲：按块保存 `(seq, bytes)`，超过容量从最旧的块开始淘汰。
///
/// 独立成结构体是为了能不依赖 PTY 单测「seq 重放 / 覆盖淘汰 / 容量上限」。
#[derive(Debug)]
struct RingBuffer {
    capacity: usize,
    blocks: VecDeque<(u64, Vec<u8>)>,
    bytes: usize,
    next_seq: u64,
    /// 已被淘汰的最高 seq。`None` 表示从第 0 块起都还在缓冲里。
    evicted_through: Option<u64>,
}

impl RingBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            blocks: VecDeque::new(),
            bytes: 0,
            next_seq: 0,
            evicted_through: None,
        }
    }

    fn bytes(&self) -> usize {
        self.bytes
    }

    fn seq_end(&self) -> u64 {
        self.next_seq
    }

    /// 追加一块输出，返回它占用的 seq。
    ///
    /// 单块超过缓冲上限时**整块丢弃**而不是保留尾部：保留局部数据会让
    /// 「重放 seq >= from_seq」得到半截块，客户端画面会花；整块丢弃后
    /// 该终端下次 attach 自动退化为屏幕快照，语义仍然正确。
    fn push(&mut self, data: &[u8]) -> u64 {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        if data.len() > self.capacity {
            self.evicted_through = Some(seq);
            return seq;
        }
        while self.bytes + data.len() > self.capacity {
            let Some((dropped, block)) = self.blocks.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(block.len());
            self.evicted_through = Some(dropped);
        }
        self.bytes += data.len();
        self.blocks.push_back((seq, data.to_vec()));
        seq
    }

    /// `from_seq` 是否仍被缓冲完整覆盖。
    ///
    /// 两种不覆盖的情况：`from_seq` 落在已被淘汰的前缀里（客户端漏掉了一段），
    /// 或者 `from_seq` 超前于 `seq_end`（换了 daemon / 序号错乱，无法判断客户端缺什么）。
    fn can_replay(&self, from_seq: u64) -> bool {
        if from_seq > self.next_seq {
            return false;
        }
        match self.evicted_through {
            Some(through) => from_seq > through,
            None => true,
        }
    }

    /// 重放 `seq >= from_seq` 的块；调用方应先确认 [`Self::can_replay`]。
    fn replay(&self, from_seq: u64) -> Vec<(u64, Vec<u8>)> {
        self.blocks
            .iter()
            .filter(|(seq, _)| *seq >= from_seq)
            .map(|(seq, data)| (*seq, data.clone()))
            .collect()
    }

    /// 丢弃全部缓冲（总量超预算时的淘汰动作）。进程和解析器不受影响，
    /// 之后 attach 会拿到屏幕快照。
    fn clear(&mut self) {
        if let Some((last, _)) = self.blocks.back() {
            self.evicted_through = Some(*last);
        }
        self.blocks.clear();
        self.bytes = 0;
    }
}

/// 终端数据态（解析器 + 缓冲 + 接入情况），与 PTY 句柄分开加锁。
struct TermState {
    parser: Parser,
    ring: RingBuffer,
    cols: u16,
    rows: u16,
    attached: bool,
    detached_at: Option<Instant>,
    exited: Option<i32>,
    exited_at: Option<Instant>,
    /// 当前接着的客户端；`detach` 只接受归属者，避免旧连接把别人接回的终端踢下线。
    owner: Option<String>,
    /// 单调输入序号；客户端重连时用同一序号重发，宿主据此去重。
    next_input_seq: u64,
    /// 当前序号已写入 PTY 的字节数 `(seq, offset)`：写到一半被取消或连接被中止时，
    /// 重发同一序号从这里续写，不重复写已送达的前缀。
    input_partial: Option<(u64, usize)>,
}

/// 进程控制句柄：`pid` 用于 `/proc` 查询与 `SIGHUP`，`killer` 是 portable-pty 的兜底。
struct ProcHandles {
    pid: Option<u32>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

struct PtyTerm {
    id: String,
    name: Option<String>,
    cwd: String,
    created: u64,
    /// Windows 上子进程退出后由等待线程取走并释放（关闭 ConPTY），读线程才能拿到 EOF；
    /// 取走后为 `None`，resize 视为无操作。
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    /// Unix 上 writer 与 reader 共享 master 的 open file description；把该
    /// description 置为非阻塞后，reader 必须走 poll，writer 才能安全取消。
    writer_nonblocking: bool,
    proc: Mutex<ProcHandles>,
    state: Mutex<TermState>,
    /// 带序号输入的串行闸：旧连接的写入结束（含 blocking 线程里仍在进行的写）
    /// 之前，新连接对同一序号的重发在这里等待，再按已推进的序号判定是否重复。
    input_gate: Arc<tokio::sync::Mutex<()>>,
    termination_requested: AtomicBool,
}

#[cfg(unix)]
type ReaderWakeup = Option<std::os::fd::RawFd>;

#[cfg(not(unix))]
type ReaderWakeup = ();

struct HostInner {
    terms: HashMap<String, Arc<PtyTerm>>,
    /// 普通 kill/reap 已释放槽位，但回收线程仍可能等待强杀；关服也要等它们。
    retiring: Vec<std::sync::Weak<PtyTerm>>,
    /// 所有终端环形缓冲的字节总和。只在持有宿主锁时读写，
    /// 保证「总缓冲 ≤ `total_buffer_bytes`」是硬约束而不是近似值。
    total_bytes: usize,
}

/// PTY 宿主。`Send + Sync`，内部用 `Mutex` 保护，daemon 里放 `Arc` 共享。
pub struct PtyHost {
    inner: Arc<Mutex<HostInner>>,
    max_ptys: usize,
    total_buffer_bytes: usize,
    event_sink: Sender<PtyEvent>,
    id_counter: AtomicU64,
    created_counter: AtomicU64,
}

impl std::fmt::Debug for PtyHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtyHost")
            .field("max_ptys", &self.max_ptys)
            .field("total_buffer_bytes", &self.total_buffer_bytes)
            .field("ptys", &self.list().len())
            .finish()
    }
}

impl PtyHost {
    pub fn new(max_ptys: usize, total_buffer_bytes: usize, event_sink: Sender<PtyEvent>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HostInner {
                terms: HashMap::new(),
                retiring: Vec::new(),
                total_bytes: 0,
            })),
            max_ptys,
            total_buffer_bytes,
            event_sink,
            id_counter: AtomicU64::new(0),
            created_counter: AtomicU64::new(0),
        }
    }

    /// 创建终端。整个「限额检查 + openpty + spawn」在同一把锁内完成，
    /// 保证并发创建也不会突破 `max_ptys`（spawn 只花几毫秒，可以接受）。
    pub fn create(&self, opts: PtyCreateOptions) -> Result<PtyInfo, String> {
        validate_create_options(&opts)?;
        let shell = resolve_shell(opts.shell.as_deref())?;
        let cols = clamp_cols(opts.cols);
        let rows = clamp_rows(opts.rows);
        let cwd = pty_working_directory(&opts.cwd);
        if !cwd.is_dir() {
            return Err(format!("终端工作目录不存在：{}", cwd.display()));
        }

        let mut inner = lock(&self.inner);
        let active_count = inner
            .terms
            .values()
            .filter(|term| lock(&term.state).exited.is_none())
            .count();
        if active_count >= self.max_ptys {
            return Err(format!(
                "终端数量已达上限（{} 个），请先结束其他终端",
                self.max_ptys
            ));
        }

        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|err| format!("无法创建 PTY：{err}"))?;
        let mut cmd = CommandBuilder::new(&shell.program);
        // Unix 的默认与显式 shell 都按登录 shell 启动，和直连终端规则一致。
        if shell.login {
            cmd.arg("-l");
        }
        cmd.args(&opts.args);
        // pty_working_directory 已还原盘符/UNC；这里再兜底剥一次，两者幂等。
        cmd.cwd(shell_working_directory(&cwd).as_ref());
        for (key, value) in &opts.env {
            cmd.env(key, value);
        }
        // 固定值最后写入，确保基础环境或调用方环境都不能改变 TUI 的色彩能力探测。
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // 继承自 sshd 会话的「忽略 Ctrl+C」会传给 shell，创建前先清掉。
        #[cfg(windows)]
        crate::winproc::restore_ctrl_c_for_children();
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|err| format!("无法启动终端程序「{}」：{err}", shell.program))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        // 关掉从端：主端读到 EOF/EIO 就等价于「shell 及其所有子进程都退出了」。
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| format!("无法读取 PTY：{err}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| format!("无法写入 PTY：{err}"))?;
        #[cfg(unix)]
        let master_fd = pair.master.as_raw_fd();
        #[cfg(unix)]
        let writer_nonblocking = master_fd.is_some_and(set_nonblocking);
        #[cfg(not(unix))]
        let writer_nonblocking = false;
        #[cfg(unix)]
        let reader_wakeup = master_fd.filter(|_| writer_nonblocking);
        #[cfg(not(unix))]
        let reader_wakeup = ();

        let id = self.next_id();
        let ring_capacity = opts.scrollback_bytes;
        let term = Arc::new(PtyTerm {
            id: id.clone(),
            name: opts.name.clone(),
            cwd: cwd.to_string_lossy().into_owned(),
            created: self.created_counter.fetch_add(1, Ordering::Relaxed),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(writer),
            writer_nonblocking,
            proc: Mutex::new(ProcHandles {
                pid,
                killer: Some(killer),
            }),
            state: Mutex::new(TermState {
                parser: Parser::new(rows, cols, parser_scrollback_lines(ring_capacity, cols)),
                ring: RingBuffer::new(ring_capacity),
                cols,
                rows,
                // create 由某个客户端发起，创建即接入。
                attached: true,
                detached_at: None,
                exited: None,
                exited_at: None,
                owner: Some(opts.client_id.clone()),
                next_input_seq: 0,
                input_partial: None,
            }),
            input_gate: Arc::new(tokio::sync::Mutex::new(())),
            termination_requested: AtomicBool::new(false),
        });
        crate::diagnostics::record(
            "pty.created",
            serde_json::json!({"ptyId":id,"shellPid":pid,
            "clientId":opts.client_id,"shell":shell.program,"cols":cols,"rows":rows}),
            false,
            false,
        );
        // 先把终端放进表里，读线程一启动就能找到自己（否则首批输出会丢）。
        inner.terms.insert(id.clone(), Arc::clone(&term));
        drop(inner);

        let inner_for_reader = Arc::clone(&self.inner);
        let sink = self.event_sink.clone();
        let budget = self.total_buffer_bytes;
        let thread_id = id.clone();
        let term_for_reader = Arc::clone(&term);
        // Windows ConPTY：子进程退出后伪控制台不关闭，读端永远等不到 EOF。
        // 单独起线程等子进程，退出后释放 master（ClosePseudoConsole），读线程随即
        // 读到 EOF，再从这里取退出码。
        #[cfg(windows)]
        let exit_source = {
            let (code_tx, code_rx) = std::sync::mpsc::channel::<Option<i32>>();
            let term_for_waiter = Arc::clone(&term);
            let mut child = child;
            let waiter = std::thread::Builder::new()
                .name(format!("pty-wait-{id}"))
                .spawn(move || {
                    let result = child.wait();
                    let code = result.as_ref().ok().map(|status| status.exit_code() as i32);
                    crate::diagnostics::record("pty.process_wait_returned", serde_json::json!({
                        "ptyId":term_for_waiter.id,"shellPid":lock(&term_for_waiter.proc).pid,
                        "exitCode":code,"waitFailed":result.is_err(),
                        "terminationRequested":term_for_waiter.termination_requested.load(Ordering::Acquire)
                    }), true, code != Some(0) && !term_for_waiter.termination_requested.load(Ordering::Acquire));
                    let _ = code_tx.send(code);
                    crate::diagnostics::record("pty.console_closing", serde_json::json!({"ptyId":term_for_waiter.id}), true, false);
                    let master = lock(&term_for_waiter.master).take();
                    drop(master);
                    crate::diagnostics::record("pty.console_closed", serde_json::json!({"ptyId":term_for_waiter.id}), false, false);
                });
            if let Err(err) = waiter {
                remove_term_locked(&mut lock(&self.inner), &id, &term);
                return Err(format!("无法启动终端等待线程：{err}"));
            }
            ExitSource::Waiter(code_rx)
        };
        #[cfg(not(windows))]
        let exit_source = ExitSource::Child(child);
        let spawned = std::thread::Builder::new()
            .name(format!("pty-{thread_id}"))
            .spawn(move || {
                read_loop(
                    inner_for_reader,
                    budget,
                    term_for_reader,
                    reader,
                    exit_source,
                    sink,
                    reader_wakeup,
                );
            });
        if let Err(err) = spawned {
            remove_term_locked(&mut lock(&self.inner), &id, &term);
            return Err(format!("无法启动终端读取线程：{err}"));
        }

        Ok(PtyInfo {
            id,
            name: opts.name,
            next_input_seq: 0,
            owner: Some(opts.client_id),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            seq: 0,
            cols,
            rows,
            exited: None,
            detached: false,
        })
    }

    /// 把客户端输入写进 PTY。写入可能因为内核缓冲满而阻塞，
    /// 期间不持有宿主锁（只持有该终端自己的写句柄）。
    #[cfg(test)]
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let term = self.term(id)?;
        write_blocking(&term, data, None, None)
    }

    /// daemon 队列使用的可取消写入。
    ///
    /// Unix 上 master 已置为非阻塞，`WouldBlock` 时让出执行权并检查取消标记，
    /// 因此连接断开后不会留下卡死在 `write(2)` 里的 blocking task。其他平台
    /// 仍走 blocking 线程池，取消标记会在进入写调用前生效。
    pub async fn write_interruptible(
        &self,
        id: &str,
        data: Vec<u8>,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let term = self.term(id)?;
        if lock(&term.state).exited.is_some() {
            return Err("终端进程已退出".to_string());
        }
        if term.writer_nonblocking {
            write_nonblocking(&term, &data, None, &cancel).await
        } else {
            tokio::task::spawn_blocking(move || {
                write_blocking(&term, &data, None, Some(cancel.as_ref()))
            })
            .await
            .map_err(|err| format!("写入终端任务异常结束：{err}"))?
        }
    }

    /// 调整终端尺寸：内核 winsize（触发 SIGWINCH）+ 解析器网格一起改。
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let cols = clamp_cols(cols);
        let rows = clamp_rows(rows);
        let term = self.term(id)?;
        if let Some(master) = lock(&term.master).as_ref() {
            master
                .resize(pty_size(cols, rows))
                .map_err(|err| format!("调整终端尺寸失败：{err}"))?;
        }
        let mut state = lock(&term.state);
        state.parser.set_size(rows, cols);
        state.cols = cols;
        state.rows = rows;
        Ok(())
    }

    /// 写入一笔带序号的客户端输入，保证每个序号至多写入一次、前缀不重复。
    ///
    /// 检查序号、写入、推进序号在同一终端的输入闸内完成：旧连接卡在写入上时，
    /// 新连接重发同一序号会等旧写入结束，再判定为重复；写到一半被取消的序号，
    /// 重发时从已写偏移续写。
    pub async fn write_input(
        &self,
        id: &str,
        seq: u64,
        data: Vec<u8>,
        cancel: Arc<AtomicBool>,
    ) -> Result<InputOutcome, InputError> {
        let term = self.term(id).map_err(InputError::Other)?;
        let gate = Arc::clone(&term.input_gate).lock_owned().await;
        let skip = {
            let state = lock(&term.state);
            if seq < state.next_input_seq {
                return Ok(InputOutcome::Duplicate);
            }
            if seq != state.next_input_seq {
                return Err(InputError::Gap {
                    expected: state.next_input_seq,
                });
            }
            if state.exited.is_some() {
                return Err(InputError::Other("终端进程已退出".to_string()));
            }
            state
                .input_partial
                .filter(|(partial_seq, _)| *partial_seq == seq)
                .map_or(0, |(_, offset)| offset.min(data.len()))
        };
        let progress = Some(InputProgress { seq, skip });
        let written = if term.writer_nonblocking {
            let written = write_nonblocking(&term, &data, progress, &cancel).await;
            drop(gate);
            written
        } else {
            // 闸随 blocking 写一起走：任务被中止后线程里的写入仍在进行，不能提前放行。
            tokio::task::spawn_blocking(move || {
                let _gate = gate;
                write_blocking(&term, &data, progress, Some(cancel.as_ref()))
            })
            .await
            .map_err(|err| InputError::Other(format!("写入终端任务异常结束：{err}")))?
        };
        written
            .map(|()| InputOutcome::Written)
            .map_err(InputError::Other)
    }

    /// 客户端接回终端。`from_seq` 仍被缓冲覆盖时只补缺失块，否则给屏幕快照。
    /// 无论哪条路径都会把终端标记为已接入（`detached = false`）。
    pub fn attach(&self, id: &str, from_seq: u64, client_id: &str) -> Result<AttachResult, String> {
        let term = self.term(id)?;
        let mut state = lock(&term.state);
        if state
            .owner
            .as_deref()
            .is_some_and(|owner| owner != client_id)
        {
            return Err("终端不属于当前客户端，拒绝接入".to_string());
        }
        state.attached = true;
        state.detached_at = None;
        state.owner = Some(client_id.to_string());
        let seq_end = state.ring.seq_end();
        let (screen, replay) = if state.ring.can_replay(from_seq) {
            (None, state.ring.replay(from_seq))
        } else {
            (Some(render_screen(&state.parser)), Vec::new())
        };
        Ok(AttachResult {
            screen,
            replay,
            seq_end,
            cols: state.cols,
            rows: state.rows,
            next_input_seq: state.next_input_seq,
            exited: state.exited,
        })
    }

    /// 客户端断开：只标记 detached 并记时间，进程与缓冲都不动。
    /// `client_id` 必须与当前归属者一致；不一致说明终端已被别的连接接走，
    /// 此时忽略（否则旧连接迟到的一次 detach 会把终端误标成无人看管）。
    pub fn detach(&self, id: &str, client_id: &str) -> Result<(), String> {
        let term = self.term(id)?;
        let mut state = lock(&term.state);
        if state.owner.as_deref() != Some(client_id) {
            return Ok(());
        }
        crate::diagnostics::record(
            "pty.detached",
            serde_json::json!({"ptyId":id,"clientId":client_id,"processPreserved":true}),
            false,
            false,
        );
        state.attached = false;
        state.detached_at = Some(Instant::now());
        // 保留 owner：应用重启后要按安装 UUID + 连接 id 找回无人接着的终端。
        // 后续 attach 若换了客户端会覆盖它，旧连接的迟到 detach 仍会因归属不符被忽略。
        Ok(())
    }

    /// release 已退出终端的墓碑。调用方必须先确认退出事件已成功交给客户端；
    /// 仍在运行的终端不受影响，避免迟到清理误杀活着进程。
    pub fn release_exited(&self, id: &str) {
        let term = lock(&self.inner).terms.get(id).cloned();
        let Some(term) = term else {
            return;
        };
        let exited = lock(&term.state).exited.is_some();
        if exited {
            remove_term_locked(&mut lock(&self.inner), id, &term);
        }
    }

    /// 结束终端：先对进程组发 `SIGHUP` 让 shell 能正常收尾，1 秒后仍未退出
    /// 再强制结束整个进程组。
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let Ok(term) = self.term(id) else {
            return Ok(());
        };
        let exited = lock(&term.state).exited.is_some();
        if exited {
            remove_term_locked(&mut lock(&self.inner), id, &term);
            return Ok(());
        }
        let terminated = terminate(&term, "client_request");
        // kill 是明确终止意图：立即释放 registry 槽位与缓冲记账。读线程仍持有
        // 实例并在进程真正退出后发送 Exit，路由由 Exit 收尾。
        remove_term_locked(&mut lock(&self.inner), id, &term);
        terminated
    }

    /// 进程退出前等 PTY 完成回收。普通 kill 保持异步，但 daemon 不能先于
    /// 一秒强杀看门狗退出，否则忽略 HUP 的 shell 会变成无人管理的进程。
    pub async fn shutdown(&self) {
        let terms: Vec<_> = {
            let inner = lock(&self.inner);
            inner
                .terms
                .values()
                .cloned()
                .chain(inner.retiring.iter().filter_map(std::sync::Weak::upgrade))
                .collect()
        };
        for term in &terms {
            let _ = terminate(term, "daemon_shutdown");
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if terms.iter().all(|term| lock(&term.state).exited.is_some()) {
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // 不能只依靠后台线程：退出路径在返回之前同步完成最终强杀。
        for term in &terms {
            if lock(&term.state).exited.is_none() {
                force_kill(term);
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while terms.iter().any(|term| lock(&term.state).exited.is_none())
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        let mut items: Vec<(u64, PtyInfo)> = {
            let inner = lock(&self.inner);
            inner
                .terms
                .values()
                .map(|term| {
                    let state = lock(&term.state);
                    (
                        term.created,
                        PtyInfo {
                            id: term.id.clone(),
                            name: term.name.clone(),
                            next_input_seq: state.next_input_seq,
                            owner: state.owner.clone(),
                            cwd: Some(term.cwd.clone()),
                            seq: state.ring.seq_end(),
                            cols: state.cols,
                            rows: state.rows,
                            exited: state.exited,
                            detached: !state.attached,
                        },
                    )
                })
                .collect()
        };
        items.sort_by_key(|(created, _)| *created);
        items.into_iter().map(|(_, info)| info).collect()
    }

    /// shell 是否还有**存活**的（非僵尸）子进程。
    ///
    /// 用途是「这个终端里是否还有活」的判断（比如是否有构建在跑），
    /// 所以 shell 自己不算，只看它的子进程。
    pub fn has_children(&self, id: &str) -> bool {
        let Ok(term) = self.term(id) else {
            return false;
        };
        if lock(&term.state).exited.is_some() {
            return false;
        }
        let pid = lock(&term.proc).pid;
        #[cfg(unix)]
        {
            pid.map(unix_has_live_children).unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            // Windows 没有等价的廉价接口（要走 Toolhelp/作业对象），
            // 这里保守返回 false，由 daemon 侧按「终端仍在运行」处理。
            let _ = pid;
            false
        }
    }

    /// 回收 detached 超过 `detached_ttl` 的终端，以及超过 30 分钟保留期的
    /// 退出墓碑，返回被回收的 id。运行中的终端会先 HUP，再由看门狗强杀。
    pub fn reap(&self, detached_ttl: Duration) -> Vec<String> {
        self.reap_at(Instant::now(), detached_ttl, EXITED_RETENTION)
    }

    fn reap_at(
        &self,
        now: Instant,
        detached_ttl: Duration,
        exited_retention: Duration,
    ) -> Vec<String> {
        let mut reclaimed: Vec<(String, Arc<PtyTerm>, bool)> = Vec::new();
        {
            let mut inner = lock(&self.inner);
            let expired: Vec<(String, Arc<PtyTerm>, bool)> = inner
                .terms
                .iter()
                .filter_map(|(id, term)| {
                    let state = lock(&term.state);
                    if let Some(exited_at) = state.exited_at {
                        if now.saturating_duration_since(exited_at) >= exited_retention {
                            return Some((id.clone(), Arc::clone(term), false));
                        }
                        return None;
                    }
                    if state.attached {
                        return None;
                    }
                    let detached_at = state.detached_at?;
                    if now.saturating_duration_since(detached_at) >= detached_ttl {
                        Some((id.clone(), Arc::clone(term), true))
                    } else {
                        None
                    }
                })
                .collect();
            for (id, term, was_running) in expired {
                if let Some(term) = remove_term_locked(&mut inner, &id, &term) {
                    reclaimed.push((id, term, was_running));
                }
            }
        }
        // 先在锁外发信号，避免 syscall / 阻塞拖住整个宿主。
        for (_, term, was_running) in &reclaimed {
            if !was_running {
                continue;
            }
            let _ = terminate(term, "detached_ttl");
        }
        reclaimed.into_iter().map(|(id, _, _)| id).collect()
    }

    fn term(&self, id: &str) -> Result<Arc<PtyTerm>, String> {
        lock(&self.inner)
            .terms
            .get(id)
            .cloned()
            .ok_or_else(|| format!("终端不存在或已回收：{id}"))
    }

    /// 16 位 hex id：时间戳 + 计数器 + pid 混洗，不引 uuid 依赖。
    fn next_id(&self) -> String {
        let counter = self.id_counter.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos() as u64)
            .unwrap_or(0);
        let mut mixed = nanos
            ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ u64::from(std::process::id()).rotate_left(32);
        mixed ^= mixed >> 33;
        mixed = mixed.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
        mixed ^= mixed >> 29;
        format!("{mixed:016x}")
    }

    /// 测试用：当前所有终端缓冲的字节总和（只在 unix 测试里用来验证总预算上限）。
    #[cfg(all(test, unix))]
    fn buffered_bytes(&self) -> usize {
        lock(&self.inner).total_bytes
    }
}

/// 从 registry 移除一个具体实例，并同步扣减它的缓冲记账。以 `Arc` 身份而不是
/// 仅按字符串删除，避免迟到的旧读线程误删后来复用同一 id 的新实例；重复调用
/// 返回 `None`，因此是幂等的。
fn remove_term_locked(
    host: &mut HostInner,
    id: &str,
    expected: &Arc<PtyTerm>,
) -> Option<Arc<PtyTerm>> {
    if !host
        .terms
        .get(id)
        .is_some_and(|current| Arc::ptr_eq(current, expected))
    {
        return None;
    }
    let term = host.terms.remove(id)?;
    let state = lock(&term.state);
    let freed = state.ring.bytes();
    if state.exited.is_none() {
        host.retiring.retain(|term| term.strong_count() > 0);
        host.retiring.push(Arc::downgrade(&term));
    }
    drop(state);
    host.total_bytes = host.total_bytes.saturating_sub(freed);
    Some(term)
}

fn write_blocking(
    term: &PtyTerm,
    data: &[u8],
    progress: Option<InputProgress>,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    if lock(&term.state).exited.is_some() {
        return Err("终端进程已退出".to_string());
    }

    let mut offset = progress.map_or(0, |progress| progress.skip);
    while offset < data.len() {
        if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            return Err("终端输入写入已取消".to_string());
        }
        let written = {
            let mut writer = lock(&term.writer);
            writer.write(&data[offset..])
        };
        match written {
            Ok(0) => return Err("写入终端失败：写入长度为 0".to_string()),
            Ok(written) => {
                offset += written;
                record_input_progress(term, progress, offset, false);
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(WRITE_RETRY_DELAY);
            }
            Err(err) => return Err(format!("写入终端失败：{err}")),
        }
    }

    loop {
        let flushed = {
            let mut writer = lock(&term.writer);
            writer.flush()
        };
        match flushed {
            Ok(()) => {
                record_input_progress(term, progress, offset, true);
                return Ok(());
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err("终端输入写入已取消".to_string());
                }
                std::thread::sleep(WRITE_RETRY_DELAY);
            }
            Err(err) => return Err(format!("写入终端失败：{err}")),
        }
    }
}

async fn write_nonblocking(
    term: &PtyTerm,
    data: &[u8],
    progress: Option<InputProgress>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut offset = progress.map_or(0, |progress| progress.skip);
    while offset < data.len() {
        if cancel.load(Ordering::SeqCst) {
            return Err("终端输入写入已取消".to_string());
        }
        let written = {
            let mut writer = lock(&term.writer);
            writer.write(&data[offset..])
        };
        match written {
            Ok(0) => return Err("写入终端失败：写入长度为 0".to_string()),
            Ok(written) => {
                offset += written;
                record_input_progress(term, progress, offset, false);
                // 即使内核连续接收多段数据，也把同一连接的其他 PTY 队列
                // 调度起来；不能让一个高速输入队列独占 current-thread runtime。
                tokio::task::yield_now().await;
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(WRITE_RETRY_DELAY).await;
            }
            Err(err) => return Err(format!("写入终端失败：{err}")),
        }
    }

    loop {
        let flushed = {
            let mut writer = lock(&term.writer);
            writer.flush()
        };
        match flushed {
            Ok(()) => {
                record_input_progress(term, progress, offset, true);
                return Ok(());
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if cancel.load(Ordering::SeqCst) {
                    return Err("终端输入写入已取消".to_string());
                }
                tokio::time::sleep(WRITE_RETRY_DELAY).await;
            }
            Err(err) => return Err(format!("写入终端失败：{err}")),
        }
    }
}

#[cfg(unix)]
fn set_nonblocking(fd: std::os::fd::RawFd) -> bool {
    // SAFETY: fd 来自仍存活的 MasterPty；F_GETFL/F_SETFL 只读写该 fd 的状态位。
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return false;
    }
    unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0 }
}

#[cfg(unix)]
fn wait_readable(fd: ReaderWakeup) {
    let Some(fd) = fd else {
        return;
    };
    if fd < 0 {
        std::thread::sleep(Duration::from_millis(READ_WAIT_TIMEOUT_MS as u64));
        return;
    }
    loop {
        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: pollfd 是栈上的有效对象，poll 只在本调用期间读写它；
        // fd 来自仍存活的 MasterPty。POLLHUP/POLLERR 也由随后的 read 处理。
        let result = unsafe { libc::poll(&mut pollfd, 1, READ_WAIT_TIMEOUT_MS) };
        if result >= 0 || std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
        {
            return;
        }
    }
}

#[cfg(not(unix))]
fn wait_readable(_: ReaderWakeup) {}

/// 读线程取退出码的来源：Unix 直接 `wait` 子进程；Windows 由等待线程转交。
enum ExitSource {
    #[cfg_attr(windows, allow(dead_code))]
    Child(Box<dyn Child + Send + Sync>),
    #[cfg_attr(not(windows), allow(dead_code))]
    Waiter(std::sync::mpsc::Receiver<Option<i32>>),
}

impl ExitSource {
    fn wait(self) -> Option<i32> {
        match self {
            ExitSource::Child(mut child) => {
                child.wait().ok().map(|status| status.exit_code() as i32)
            }
            ExitSource::Waiter(rx) => rx.recv().ok().flatten(),
        }
    }
}

/// 读线程主循环：把 master 的输出同时喂给解析器、环形缓冲和事件通道。
///
/// 读线程是唯一往缓冲里写的线程，因此 seq 天然单调；它最后负责 `wait` 出退出码，
/// 记录 `exited` 并推 `PtyEvent::Exit`。
fn read_loop(
    inner: Arc<Mutex<HostInner>>,
    budget: usize,
    term: Arc<PtyTerm>,
    mut reader: Box<dyn Read + Send>,
    exit_source: ExitSource,
    sink: Sender<PtyEvent>,
    reader_wakeup: ReaderWakeup,
) {
    let id = term.id.clone();
    let mut buf = [0u8; READ_BUF_BYTES];
    loop {
        wait_readable(reader_wakeup);
        match reader.read(&mut buf) {
            Ok(0) => {
                crate::diagnostics::record(
                    "pty.reader_eof",
                    serde_json::json!({"ptyId":id}),
                    false,
                    false,
                );
                break;
            }
            Ok(n) => {
                if !push_output(&inner, budget, &id, &sink, &buf[..n]) {
                    break;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => continue,
            // Linux 上从端全部关闭后主端返回 EIO，语义上等价 EOF。
            Err(error) => {
                crate::diagnostics::record(
                    "pty.reader_error",
                    serde_json::json!({"ptyId":id,"osError":error.raw_os_error(),"kind":format!("{:?}",error.kind())}),
                    false,
                    false,
                );
                break;
            }
        }
    }
    let code = exit_source.wait();
    let requested = term.termination_requested.load(Ordering::Acquire);
    crate::diagnostics::record(
        "pty.exited",
        serde_json::json!({"ptyId":id,
        "shellPid":lock(&term.proc).pid,"exitCode":code,"terminationRequested":requested,
        "cause":if requested {"requested"} else {"unknown"}}),
        true,
        !requested && code != Some(0) && !cfg!(windows),
    );
    {
        let mut state = lock(&term.state);
        state.exited = Some(code.unwrap_or(-1));
        state.exited_at = Some(Instant::now());
    }
    let _ = sink.blocking_send(PtyEvent::Exit { id, code });
}

/// 处理一块输出：解析、入缓冲、记账、必要时淘汰，最后推事件。
///
/// 这里刻意**同时持有宿主锁和该终端的锁**：只有把「追加缓冲 + 更新总量 + 淘汰」
/// 做成一个原子步骤，`total_buffer_bytes` 才是硬上限。代价是所有终端的解析被串行化，
/// 但单个 8KB 块的 vt100 解析是微秒级，64 个终端也远没到瓶颈。
fn push_output(
    inner: &Mutex<HostInner>,
    budget: usize,
    id: &str,
    sink: &Sender<PtyEvent>,
    data: &[u8],
) -> bool {
    if data.is_empty() {
        return true;
    }
    if sink.is_closed() {
        return false;
    }
    let seq = {
        let mut host = lock(inner);
        let Some(term) = host.terms.get(id).cloned() else {
            // 终端已从 registry 移除但读线程尚未结束：继续排空 master，
            // 否则进程可能因 PTY 输出缓冲写满而永远退不出去。
            return true;
        };
        let (seq, added) = {
            let mut state = lock(&term.state);
            state.parser.process(data);
            let before = state.ring.bytes();
            let seq = state.ring.push(data);
            (seq, state.ring.bytes().saturating_sub(before))
        };
        host.total_bytes += added;
        evict_locked(&mut host, budget);
        seq
    };
    sink.blocking_send(PtyEvent::Data {
        id: id.to_string(),
        seq,
        data: data.to_vec(),
    })
    .is_ok()
}

/// 总缓冲超预算时的淘汰：按「detached 最久优先」清空整条缓冲，进程保留。
///
/// detached 的都被清完还不够时，退而按同样顺序清 attached 的缓冲——
/// 这不是理想行为（该客户端下次重连要重新走屏幕快照），但总量上限是硬约束，
/// daemon 的内存不能被多个满负荷终端撑爆。调用方必须持有宿主锁。
fn evict_locked(host: &mut HostInner, budget: usize) {
    if host.total_bytes <= budget {
        return;
    }

    let now = Instant::now();
    let mut candidates: Vec<(bool, Instant, u64, Arc<PtyTerm>)> = host
        .terms
        .values()
        .map(|term| {
            let state = lock(&term.state);
            (
                // false 在 true 之前：detached 的先被淘汰。
                state.attached,
                state.detached_at.unwrap_or(now),
                term.created,
                Arc::clone(term),
            )
        })
        .collect();
    candidates
        .sort_by_key(|(attached, detached_at, created, _)| (*attached, *detached_at, *created));

    let mut total = host.total_bytes;
    for (_, _, _, term) in candidates {
        if total <= budget {
            break;
        }
        let mut state = lock(&term.state);
        let freed = state.ring.bytes();
        if freed == 0 {
            continue;
        }
        state.ring.clear();
        drop(state);
        total = total.saturating_sub(freed);
    }
    host.total_bytes = total;
}

/// 屏幕快照：`contents_formatted` 带 SGR 颜色、光标位置与当前备用屏内容，
/// 客户端打印后画面与断线前一致。非 UTF-8 字节用替换字符兜底（正常输出不会出现）。
fn render_screen(parser: &Parser) -> String {
    String::from_utf8_lossy(&parser.screen().contents_formatted()).into_owned()
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn clamp_cols(cols: u16) -> u16 {
    cols.clamp(MIN_COLS, MAX_COLS)
}

fn clamp_rows(rows: u16) -> u16 {
    rows.clamp(MIN_ROWS, MAX_ROWS)
}

/// 环形缓冲的字节预算折算成 `vt100` 的 scrollback 行数（见常量注释）。
fn parser_scrollback_lines(buffer_bytes: usize, cols: u16) -> usize {
    let cols = usize::from(cols.max(1));
    (buffer_bytes / cols).min(MAX_PARSER_SCROLLBACK_LINES)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShellLaunch {
    program: String,
    login: bool,
}

/// Windows 的 `canonicalize` 总会带上 verbatim 前缀（`\\?\D:\code\app`）。PTY 的
/// 当前目录会原样交给子进程：PowerShell 会把提示符显示成
/// `Microsoft.PowerShell.Core\FileSystem::\\?\D:\...`，`cmd.exe` 与批处理工具还会
/// 拒绝该目录并回落到 `C:\Windows`。交互 shell 只接受普通原生路径。
fn pty_working_directory(cwd: &Path) -> PathBuf {
    #[cfg(windows)]
    if let Some(plain) = plain_windows_path(cwd) {
        return plain;
    }
    cwd.to_path_buf()
}

/// 只还原盘符与 UNC 两种 verbatim 形态；`\\?\Volume{...}` 等设备路径原样保留。
#[cfg(windows)]
fn plain_windows_path(path: &Path) -> Option<PathBuf> {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return (!rest.is_empty()).then(|| PathBuf::from(format!(r"\\{rest}")));
    }
    let rest = text.strip_prefix(r"\\?\")?;
    let bytes = rest.as_bytes();
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        .then(|| PathBuf::from(rest))
}

fn validate_create_options(opts: &PtyCreateOptions) -> Result<(), String> {
    if opts.args.iter().any(|arg| arg.contains('\0')) {
        return Err("终端参数包含无效字符".to_string());
    }
    if opts.name.as_deref().is_some_and(|name| name.contains('\0')) {
        return Err("终端名称包含无效字符".to_string());
    }
    for (key, value) in &opts.env {
        if key.is_empty() || key.contains('=') || key.contains('\0') {
            return Err(format!("环境变量名「{key}」无效"));
        }
        if value.contains('\0') {
            return Err(format!("环境变量「{key}」的值包含无效字符"));
        }
        // 动态加载器变量能让任意共享库注入终端进程，必须在启动前拒绝。
        // TERM / COLORTERM 是固定能力声明，也不允许调用方覆盖。
        let upper = key.to_ascii_uppercase();
        if upper.starts_with("LD_")
            || upper.starts_with("DYLD_")
            || matches!(upper.as_str(), "TERM" | "COLORTERM")
        {
            return Err(format!("环境变量「{key}」不允许由 pty.create 覆盖"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn resolve_shell(requested: Option<&str>) -> Result<ShellLaunch, String> {
    fn executable(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    fn find_in_path(name: &str) -> Option<PathBuf> {
        let paths = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
            .filter(|paths| !paths.is_empty())
            .unwrap_or_else(|| {
                ["/bin", "/usr/bin", "/usr/local/bin"]
                    .into_iter()
                    .map(PathBuf::from)
                    .collect()
            });
        paths
            .into_iter()
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(name))
            .find(|candidate| executable(candidate))
    }

    fn explicit(value: &str) -> Result<ShellLaunch, String> {
        let requested = Path::new(value);
        let Some(name) = requested.file_name().and_then(|name| name.to_str()) else {
            return Err(format!("shell 路径无效：「{value}」"));
        };
        if !matches!(name, "bash" | "zsh" | "sh") {
            return Err(format!(
                "不支持 shell「{value}」；可用 shell：bash、zsh、sh"
            ));
        }
        let path = if requested.is_absolute() {
            requested.to_path_buf()
        } else if value.contains('/') {
            return Err(format!("shell 路径必须是绝对路径：「{value}」"));
        } else {
            find_in_path(name).ok_or_else(|| format!("shell 不存在或不可执行：「{value}」"))?
        };
        if !executable(&path) {
            return Err(format!("shell 不存在或不可执行：{}", path.display()));
        }
        Ok(ShellLaunch {
            program: path.to_string_lossy().into_owned(),
            login: true,
        })
    }

    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            if value.contains('\0') {
                return Err("shell 路径包含无效字符".to_string());
            }
            explicit(value)
        }
        None => {
            // 默认跟随登录用户的 SHELL；值失效时按方案回退到 /bin/sh。
            if let Ok(value) = std::env::var("SHELL") {
                let value = value.trim();
                if Path::new(value).is_absolute() && executable(Path::new(value)) {
                    return Ok(ShellLaunch {
                        program: value.to_string(),
                        login: true,
                    });
                }
            }
            let fallback = Path::new("/bin/sh");
            if executable(fallback) {
                Ok(ShellLaunch {
                    program: fallback.to_string_lossy().into_owned(),
                    login: true,
                })
            } else {
                Err("默认 shell /bin/sh 不存在或不可执行".to_string())
            }
        }
    }
}

#[cfg(windows)]
fn resolve_shell(requested: Option<&str>) -> Result<ShellLaunch, String> {
    fn canonical_name(value: &str) -> Option<&'static str> {
        let lower = value.to_ascii_lowercase();
        match lower.strip_suffix(".exe").unwrap_or(&lower) {
            "powershell" => Some("powershell.exe"),
            "pwsh" => Some("pwsh.exe"),
            "cmd" => Some("cmd.exe"),
            _ => None,
        }
    }

    fn find_in_path(name: &str) -> Option<PathBuf> {
        let paths = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
            .unwrap_or_default();
        paths
            .into_iter()
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    }

    fn find_known(name: &str) -> Option<PathBuf> {
        if name.eq_ignore_ascii_case("cmd.exe") {
            if let Some(comspec) = std::env::var_os("COMSPEC") {
                let path = PathBuf::from(comspec);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        if name.eq_ignore_ascii_case("powershell.exe") {
            let system_root = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
            let path = system_root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
            if path.is_file() {
                return Some(path);
            }
        }
        find_in_path(name)
    }

    let path = match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            if value.contains('\0') {
                return Err("shell 路径包含无效字符".to_string());
            }
            let candidate = Path::new(value);
            let base = candidate
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(canonical_name);
            let Some(name) = base else {
                return Err(format!(
                    "不支持 shell「{value}」；可用 shell：powershell、pwsh、cmd"
                ));
            };
            let path = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else if value.contains('/') || value.contains('\\') {
                return Err(format!("shell 路径必须是绝对路径：「{value}」"));
            } else {
                find_known(name).ok_or_else(|| format!("shell 不存在：「{value}」"))?
            };
            if !path.is_file() {
                return Err(format!("shell 不存在：{}", path.display()));
            }
            path
        }
        None => {
            let name = "powershell.exe";
            find_known(name).ok_or_else(|| "默认 shell powershell.exe 不存在".to_string())?
        }
    };
    Ok(ShellLaunch {
        program: path.to_string_lossy().into_owned(),
        login: false,
    })
}

#[cfg(not(any(unix, windows)))]
fn resolve_shell(requested: Option<&str>) -> Result<ShellLaunch, String> {
    let _ = requested;
    Err("当前平台不支持 daemon PTY".to_string())
}

/// 给终端进程（组）发 SIGHUP。unix 上同时打进程组和单个 pid：
/// 进程组能覆盖 shell 在前台跑的整条管道，单 pid 兜住「不是组长」的情况。
fn hangup(pid: Option<u32>, term: &PtyTerm) {
    #[cfg(unix)]
    {
        if let Some(pid) = pid.filter(|pid| *pid > 0) {
            let pid = pid as libc::pid_t;
            // SAFETY: kill(2) 只接受 pid_t，两个调用都不读写共享内存；
            // 失败（进程已退出 / 无权限）由返回值忽略，属正常竞态。
            unsafe {
                libc::kill(-pid, libc::SIGHUP);
                libc::kill(pid, libc::SIGHUP);
            }
            return;
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    // Windows（或 unix 上拿不到 pid）：交给 portable-pty；Windows 上是
    // TerminateProcess，unix 上无 pid 时最后仍会走该平台的安全兜底。
    force_kill(term);
}

/// 终止一个仍在运行的终端：先发 HUP 给进程组，给 shell 一秒收尾时间，
/// 到时仍未退出就强制结束。kill 与超时 reap 共用同一套看门狗。
fn terminate(term: &Arc<PtyTerm>, source: &str) -> Result<(), String> {
    term.termination_requested.store(true, Ordering::Release);
    crate::diagnostics::record(
        "pty.termination_requested",
        serde_json::json!({"ptyId":term.id,
        "shellPid":lock(&term.proc).pid,"source":source}),
        true,
        false,
    );
    if lock(&term.state).exited.is_some() {
        return Ok(());
    }
    let pid = lock(&term.proc).pid;
    hangup(pid, term);
    let term_for_watchdog = Arc::clone(term);
    let id = term.id.clone();
    std::thread::Builder::new()
        .name(format!("pty-terminate-{id}"))
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            if lock(&term_for_watchdog.state).exited.is_none() {
                force_kill(&term_for_watchdog);
            }
        })
        .map(|_| ())
        .map_err(|err| {
            // 看门狗起不来时立即强杀，至少不能把忽略 HUP 的进程留在后台。
            force_kill(term);
            format!("无法启动终端回收线程：{err}")
        })
}

fn force_kill(term: &PtyTerm) {
    crate::diagnostics::record(
        "pty.force_kill",
        serde_json::json!({"ptyId":term.id,
        "shellPid":lock(&term.proc).pid}),
        true,
        false,
    );
    #[cfg(unix)]
    {
        if let Some(pid) = lock(&term.proc).pid.filter(|pid| *pid > 0) {
            let pid = pid as libc::pid_t;
            // SAFETY: kill(2) 只读取 pid；先打进程组覆盖前台管道，再打单个
            // pid 兜住不是进程组长的 shell。SIGKILL 不可被 trap/nohup 忽略。
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
                libc::kill(pid, libc::SIGKILL);
            }
            return;
        }
    }
    if let Some(killer) = lock(&term.proc).killer.as_mut() {
        let _ = killer.kill();
    }
}

/// shell 是否还有存活的子进程。Linux 优先读 `/proc/<pid>/task/*/children`
/// （内核直接给出该线程的子进程列表，代价 O(子进程数)）；
/// 该文件不可用（未开 `CONFIG_PROC_CHILDREN`）时回退到遍历 `/proc/*/stat` 比 ppid。
/// 其他 unix（macOS 无 `/proc`）没有等价低成本接口，保守返回 false。
#[cfg(unix)]
fn unix_has_live_children(pid: u32) -> bool {
    let mut saw_children_file = false;
    if let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for entry in entries.flatten() {
            let path = entry.path().join("children");
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            saw_children_file = true;
            for token in text.split_whitespace() {
                if let Ok(child) = token.parse::<u32>() {
                    if process_is_live(child) {
                        return true;
                    }
                }
            }
        }
    }
    if saw_children_file {
        return false;
    }

    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Ok(child) = entry.file_name().to_string_lossy().parse::<u32>() else {
            return false;
        };
        if child == pid {
            return false;
        }
        match read_proc_stat(child) {
            Some((ppid, state)) => ppid == pid && state != 'Z',
            None => false,
        }
    })
}

/// 读取 `/proc/<pid>/stat` 的 `(ppid, state)`。
/// 格式是 `pid (comm) state ppid ...`，`comm` 里可能有空格和括号，
/// 所以从最后一个 `)` 之后开始切分。
#[cfg(unix)]
fn read_proc_stat(pid: u32) -> Option<(u32, char)> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = text.rfind(')')?;
    let mut fields = text.get(close + 1..)?.split_whitespace();
    let state = fields.next()?.chars().next()?;
    let ppid = fields.next()?.parse::<u32>().ok()?;
    Some((ppid, state))
}

#[cfg(unix)]
fn process_is_live(pid: u32) -> bool {
    // 僵尸进程已经死透，只是还没被父进程回收，不能算「有活在跑」。
    read_proc_stat(pid).is_some_and(|(_, state)| state != 'Z')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn host_is_send_sync() {
        assert_send_sync::<PtyHost>();
    }

    #[test]
    fn shell_working_directory_strips_verbatim_prefixes() {
        assert_eq!(
            shell_working_directory(Path::new(r"\\?\D:\code\qingcode")).as_ref(),
            Path::new(r"D:\code\qingcode")
        );
        assert_eq!(
            shell_working_directory(Path::new(r"\\?\UNC\server\share\project")).as_ref(),
            Path::new(r"\\server\share\project")
        );
    }

    #[test]
    fn shell_working_directory_leaves_normal_paths_untouched() {
        assert_eq!(
            shell_working_directory(Path::new(r"D:\code")).as_ref(),
            Path::new(r"D:\code")
        );
        assert_eq!(
            shell_working_directory(Path::new("/home/dev/code")).as_ref(),
            Path::new("/home/dev/code")
        );
    }

    #[test]
    fn ring_replays_from_seq_and_tracks_end() {
        let mut ring = RingBuffer::new(64);
        assert_eq!(ring.push(b"abc"), 0);
        assert_eq!(ring.push(b"def"), 1);
        assert_eq!(ring.seq_end(), 2);
        assert_eq!(ring.bytes(), 6);
        assert!(ring.can_replay(0));
        assert!(ring.can_replay(2));
        assert!(!ring.can_replay(3));
        assert_eq!(
            ring.replay(1),
            vec![(1u64, b"def".to_vec())],
            "重放应只给 seq >= from_seq 的块"
        );
        assert!(ring.replay(2).is_empty(), "追平后没有可重放的块");
    }

    #[test]
    fn ring_evicts_oldest_blocks_when_over_capacity() {
        let mut ring = RingBuffer::new(8);
        ring.push(b"abc"); // seq 0
        ring.push(b"def"); // seq 1
        assert_eq!(ring.bytes(), 6);
        // 再塞 3 字节就超 8，最旧的 seq 0 被淘汰。
        assert_eq!(ring.push(b"ghi"), 2);
        assert_eq!(ring.bytes(), 6);
        assert!(!ring.can_replay(0), "seq 0 已被覆盖");
        assert!(ring.can_replay(1));
        assert_eq!(
            ring.replay(0),
            vec![(1u64, b"def".to_vec()), (2u64, b"ghi".to_vec())]
        );
    }

    #[test]
    fn ring_drops_oversized_block_and_clear_resets_bytes() {
        let mut ring = RingBuffer::new(8);
        assert_eq!(ring.push(&[b'x'; 16]), 0);
        assert_eq!(ring.bytes(), 0);
        assert!(!ring.can_replay(0), "整块丢弃后只能走屏幕快照");
        assert_eq!(ring.seq_end(), 1);

        let mut ring = RingBuffer::new(32);
        ring.push(b"hello");
        assert!(ring.can_replay(0));
        ring.clear();
        assert_eq!(ring.bytes(), 0);
        assert!(!ring.can_replay(0));
        assert!(
            ring.can_replay(1),
            "clear 之后的新块从 seq 1 开始仍然可重放"
        );
    }

    #[test]
    fn zero_capacity_means_never_replayable() {
        let mut ring = RingBuffer::new(0);
        assert_eq!(ring.push(b"data"), 0);
        assert_eq!(ring.bytes(), 0);
        assert!(!ring.can_replay(0));
        assert!(ring.replay(0).is_empty());
    }

    #[test]
    fn parser_scrollback_lines_is_capped() {
        assert_eq!(parser_scrollback_lines(2 * 1024 * 1024, 80), 1000);
        assert_eq!(parser_scrollback_lines(800, 80), 10);
        assert_eq!(parser_scrollback_lines(0, 80), 0);
    }

    #[test]
    fn pty_working_directory_keeps_plain_paths() {
        let path = PathBuf::from(r"D:\code\app");
        assert_eq!(pty_working_directory(&path), path);
    }

    #[cfg(windows)]
    #[test]
    fn pty_working_directory_strips_verbatim_prefix() {
        assert_eq!(
            pty_working_directory(Path::new(r"\\?\D:\code\app")),
            PathBuf::from(r"D:\code\app")
        );
        assert_eq!(
            pty_working_directory(Path::new(r"\\?\UNC\server\share\app")),
            PathBuf::from(r"\\server\share\app")
        );
        let volume = Path::new(r"\\?\Volume{1f2e3d4c}\app");
        assert_eq!(
            pty_working_directory(volume),
            volume,
            "设备路径不能剥掉 verbatim 前缀"
        );
    }

    #[test]
    fn clamp_keeps_grid_sane() {
        let size = pty_size(clamp_cols(0), clamp_rows(0));
        assert_eq!((size.cols, size.rows), (MIN_COLS, MIN_ROWS));
        let size = pty_size(clamp_cols(u16::MAX), clamp_rows(u16::MAX));
        assert_eq!((size.cols, size.rows), (MAX_COLS, MAX_ROWS));
    }

    #[cfg(unix)]
    #[test]
    fn wait_readable_supports_fds_above_fd_setsize() {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

        let mut pipe_fds = [-1; 2];
        // SAFETY: pipe_fds 指向两个可写 int，pipe(2) 成功时填入两个新 fd。
        assert_eq!(unsafe { libc::pipe(pipe_fds.as_mut_ptr()) }, 0);
        // SAFETY: 两个 fd 刚由 pipe(2) 创建且所有权转移给 OwnedFd。
        let read_end = unsafe { OwnedFd::from_raw_fd(pipe_fds[0]) };
        let write_end = unsafe { OwnedFd::from_raw_fd(pipe_fds[1]) };

        // SAFETY: read_end 有效；F_DUPFD 只读取 fd 并返回新 fd，不转移所有权。
        let high_fd = unsafe { libc::fcntl(read_end.as_raw_fd(), libc::F_DUPFD, 1100) };
        if high_fd < 0 {
            // 测试进程 fd 配额不足时无法构造 >= 1024 的场景，直接跳过。
            return;
        }
        // SAFETY: fcntl 成功返回的新 fd 未在别处持有。
        let high_read = unsafe { OwnedFd::from_raw_fd(high_fd) };
        // SAFETY: write_end 有效，单字节缓冲区在调用期间存活。
        let written = unsafe {
            libc::write(
                write_end.as_raw_fd(),
                b"x".as_ptr().cast(),
                std::mem::size_of::<u8>(),
            )
        };
        assert_eq!(written, 1);

        let started = Instant::now();
        wait_readable(Some(high_read.as_raw_fd()));
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "poll 对高编号 fd 没有立即返回：{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn ids_are_unique_hex() {
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let host = PtyHost::new(4, 1024, tx);
        let first = host.next_id();
        let second = host.next_id();
        assert_ne!(first, second);
        assert_eq!(first.len(), 16);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    /// 按 id 累计数据块字节数，直到够 `want` 或超时。
    #[cfg(unix)]
    async fn wait_for_bytes(rx: &mut tokio::sync::mpsc::Receiver<PtyEvent>, id: &str, want: usize) {
        let mut got = 0usize;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while got < want {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "等待终端 {id} 输出超时（已收到 {got} 字节）"
            );
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(PtyEvent::Data {
                    id: event_id, data, ..
                })) if event_id == id => got += data.len(),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => panic!("等待终端 {id} 输出时事件流中断"),
            }
        }
    }

    async fn wait_for_text(rx: &mut tokio::sync::mpsc::Receiver<PtyEvent>, id: &str, needle: &str) {
        let mut output = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !String::from_utf8_lossy(&output).contains(needle) {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(!remaining.is_zero(), "等待终端 {id} 输出超时");
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(PtyEvent::Data {
                    id: event_id, data, ..
                })) if event_id == id => output.extend_from_slice(&data),
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => panic!("等待终端 {id} 输出时事件流中断"),
            }
        }
    }

    async fn wait_for_exit(
        rx: &mut tokio::sync::mpsc::Receiver<PtyEvent>,
        id: &str,
    ) -> Option<i32> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(!remaining.is_zero(), "等待终端 {id} 退出超时");
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(PtyEvent::Exit { id: event_id, code })) if event_id == id => return code,
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => panic!("等待终端 {id} 退出时事件流中断"),
            }
        }
    }

    #[cfg(unix)]
    fn sh_options(scrollback_bytes: usize, client_id: &str) -> PtyCreateOptions {
        PtyCreateOptions {
            cwd: std::env::temp_dir(),
            shell: Some("/bin/sh".to_string()),
            args: Vec::new(),
            env: BTreeMap::new(),
            name: None,
            cols: 80,
            rows: 24,
            scrollback_bytes,
            client_id: client_id.to_string(),
        }
    }

    /// 交互式 shell：Unix 用 /bin/sh，Windows 用 ConPTY 下的 PowerShell。
    fn interactive_options() -> PtyCreateOptions {
        #[cfg(unix)]
        {
            sh_options(64 * 1024, "client-a")
        }
        #[cfg(windows)]
        {
            PtyCreateOptions {
                cwd: std::env::temp_dir(),
                shell: Some("powershell.exe".to_string()),
                args: vec!["-NoProfile".to_string(), "-NoLogo".to_string()],
                env: BTreeMap::new(),
                name: None,
                cols: 80,
                rows: 24,
                scrollback_bytes: 64 * 1024,
                client_id: "client-a".to_string(),
            }
        }
    }

    #[tokio::test]
    async fn sequenced_input_is_written_at_most_once_and_resumes_partial_writes() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let host = Arc::new(PtyHost::new(4, 4 * 1024 * 1024, tx));
        let info = host.create(interactive_options()).unwrap();
        let cancel = || Arc::new(AtomicBool::new(false));
        let enter = if cfg!(windows) { "\r" } else { "\n" };
        let line = |text: &str| format!("{text}{enter}").into_bytes();

        // 同一序号并发重发（旧连接仍在写、新连接重发）：只写一次，另一笔判重复。
        let (first, second) = tokio::join!(
            host.write_input(&info.id, 0, line("echo one"), cancel()),
            host.write_input(&info.id, 0, line("echo one"), cancel()),
        );
        let mut outcomes = [first.unwrap(), second.unwrap()];
        outcomes.sort_by_key(|outcome| *outcome == InputOutcome::Duplicate);
        assert_eq!(outcomes, [InputOutcome::Written, InputOutcome::Duplicate]);

        // 跳号被拒绝，序号不推进。
        assert_eq!(
            host.write_input(&info.id, 2, b"x".to_vec(), cancel()).await,
            Err(InputError::Gap { expected: 1 })
        );

        // 模拟上次写到一半被中止：已送达 `echo ` 前缀，重发时只续写剩余部分。
        let term = host.term(&info.id).unwrap();
        lock(&term.state).input_partial = Some((1, b"echo ".len()));
        assert_eq!(
            host.write_input(&info.id, 1, line("echo resumed-marker"), cancel())
                .await,
            Ok(InputOutcome::Written)
        );
        {
            let state = lock(&term.state);
            assert_eq!(state.next_input_seq, 2);
            assert!(state.input_partial.is_none());
        }
        wait_for_text(&mut rx, &info.id, "resumed-marker").await;
        host.kill(&info.id).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_replays_while_running_then_keeps_exit_tombstone() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(4, 4 * 1024 * 1024, tx);
        let info = host
            .create(sh_options(64 * 1024, "client-a"))
            .expect("创建 PTY 失败");
        assert_eq!(info.owner.as_deref(), Some("client-a"));
        assert!(info.cwd.is_some());
        host.write(&info.id, b"printf hello; sleep 0.2\n")
            .expect("写入终端失败");

        let mut output = Vec::new();
        let mut seqs = Vec::new();
        while !String::from_utf8_lossy(&output).contains("hello") {
            match tokio::time::timeout(Duration::from_secs(20), rx.recv()).await {
                Ok(Some(PtyEvent::Data { id, seq, data, .. })) if id == info.id => {
                    seqs.push(seq);
                    output.extend_from_slice(&data);
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => panic!("等待 hello 输出超时"),
            }
        }

        let text = String::from_utf8_lossy(&output).into_owned();
        assert!(text.contains("hello"), "未收到 hello 输出：{text:?}");
        assert!(
            seqs.windows(2).all(|pair| pair[1] == pair[0] + 1),
            "seq 应严格递增且连续：{seqs:?}"
        );
        // 进程仍在运行时从 0 重放。
        let replay_all = host.attach(&info.id, 0, "client-a").expect("attach 失败");
        assert!(replay_all.screen.is_none(), "缓冲未淘汰时不该给屏幕快照");
        assert!(!replay_all.replay.is_empty());
        assert_eq!(replay_all.exited, None);
        assert_eq!(replay_all.replay[0].0, 0);
        assert_eq!((replay_all.cols, replay_all.rows), (80, 24));

        // 从 seq_end 接入：客户端已追平，重放为空。
        let caught_up = host
            .attach(&info.id, replay_all.seq_end, "client-a")
            .expect("attach 失败");
        assert!(caught_up.replay.is_empty());
        assert!(caught_up.screen.is_none());
        assert_eq!(caught_up.seq_end, replay_all.seq_end);

        // 序号超前（例如 daemon 重启后序号错乱）：退化为屏幕快照。
        let ahead = host
            .attach(&info.id, replay_all.seq_end + 10, "client-a")
            .expect("attach 失败");
        assert!(ahead.screen.is_some());
        assert!(ahead.replay.is_empty());

        host.write(&info.id, b"exit\n").unwrap();
        assert_eq!(wait_for_exit(&mut rx, &info.id).await, Some(0));
        assert_eq!(host.list().len(), 1, "未交付的退出终端应作为墓碑保留");
        let exited = host
            .attach(&info.id, 0, "client-a")
            .expect("退出后、释放前应还能 attach");
        assert_eq!(exited.exited, Some(0));
        assert!(exited.screen.is_some() || !exited.replay.is_empty());
        host.release_exited(&info.id);
        assert!(host.list().is_empty(), "Exit 交付后应释放墓碑");
        assert_eq!(host.buffered_bytes(), 0, "退出后缓冲记账未释放");
        assert!(
            host.attach(&info.id, 0, "client-a").is_err(),
            "已退出终端不应还能 attach"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detached_exit_keeps_replay_until_released() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(4, 1024 * 1024, tx);
        let info = host.create(sh_options(64 * 1024, "client-a")).unwrap();
        host.write(&info.id, b"echo done; exit 7\n").unwrap();
        host.detach(&info.id, "client-a").unwrap();

        assert_eq!(wait_for_exit(&mut rx, &info.id).await, Some(7));
        let attached = host
            .attach(&info.id, 0, "client-a")
            .expect("detached 退出后应能接回墓碑");
        assert_eq!(attached.exited, Some(7));
        let replay = attached
            .replay
            .iter()
            .flat_map(|(_, data)| data.iter().copied())
            .collect::<Vec<_>>();
        assert!(
            String::from_utf8_lossy(&replay).contains("done"),
            "退出后的重放缺少尾部输出：{:?}",
            String::from_utf8_lossy(&replay)
        );

        host.release_exited(&info.id);
        assert!(host.list().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exited_tombstones_do_not_consume_pty_limit() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(1, 64 * 1024, tx);

        let first = host.create(sh_options(16 * 1024, "client-a")).unwrap();
        host.write(&first.id, b"exit\n").unwrap();
        wait_for_exit(&mut rx, &first.id).await;
        assert_eq!(host.list().len(), 1, "首个终端应作为墓碑保留");

        let second = host
            .create(sh_options(16 * 1024, "client-b"))
            .expect("墓碑不应占用 max_ptys 名额");
        host.release_exited(&first.id);
        assert!(!host.list().is_empty(), "第二个终端应仍在运行");
        host.kill(&second.id).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reap_removes_expired_exit_tombstone() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(1, 64 * 1024, tx);
        let info = host.create(sh_options(4096, "client-a")).unwrap();
        host.write(&info.id, b"exit\n").unwrap();
        wait_for_exit(&mut rx, &info.id).await;

        assert!(
            host.reap_at(Instant::now(), Duration::ZERO, EXITED_RETENTION)
                .is_empty(),
            "未到保留期时不能回收墓碑"
        );
        assert_eq!(host.list().len(), 1);

        let removed = host.reap_at(
            Instant::now() + EXITED_RETENTION,
            Duration::ZERO,
            EXITED_RETENTION,
        );
        assert_eq!(removed, vec![info.id]);
        assert!(host.list().is_empty());
        assert_eq!(host.buffered_bytes(), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reap_default_ttl_expires_detached_terminal_after_three_hours_only() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(2, 128 * 1024, tx);
        let connected = host.create(sh_options(4096, "client-a")).unwrap();
        let detached = host.create(sh_options(4096, "client-a")).unwrap();
        host.detach(&detached.id, "client-a").unwrap();
        let detached_at = lock(&host.term(&detached.id).unwrap().state)
            .detached_at
            .unwrap();
        let ttl = crate::daemon::DaemonOptions::default().detached_ttl;
        let deadline = detached_at + Duration::from_secs(3 * 60 * 60);

        assert!(host
            .reap_at(deadline - Duration::from_secs(1), ttl, EXITED_RETENTION)
            .is_empty());
        assert_eq!(
            host.reap_at(deadline, ttl, EXITED_RETENTION),
            vec![detached.id.clone()]
        );
        assert_eq!(host.list().len(), 1);
        assert_eq!(host.list()[0].id, connected.id);
        assert_eq!(host.list()[0].exited, None);
        tokio::time::timeout(Duration::from_secs(5), wait_for_exit(&mut rx, &detached.id))
            .await
            .expect("到期的 detached 终端应结束进程");
        host.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reap_force_kills_terminal_that_ignores_hangup() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let host = PtyHost::new(2, 1024 * 1024, tx);
        let info = host.create(sh_options(64 * 1024, "client-a")).unwrap();
        let term = lock(&host.inner).terms.get(&info.id).cloned().unwrap();
        host.write(
            &info.id,
            b"trap '' HUP; m=REAP; printf '%s_READY\\n' \"$m\"; while :; do echo x; sleep 0.05; done\n",
        )
        .unwrap();
        wait_for_text(&mut rx, &info.id, "REAP_READY").await;
        host.detach(&info.id, "client-a").unwrap();

        assert_eq!(host.reap(Duration::ZERO), vec![info.id.clone()]);
        let exit =
            tokio::time::timeout(Duration::from_secs(5), wait_for_exit(&mut rx, &info.id)).await;
        if exit.is_err() {
            force_kill(&term);
        }
        exit.expect("回收后读线程未在 5 秒内等到退出事件");
        assert!(host.list().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn natural_exit_and_kill_release_slot_for_immediate_reuse() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(1, 64 * 1024, tx);

        let natural = host.create(sh_options(16 * 1024, "client-a")).unwrap();
        host.write(&natural.id, b"printf natural\nexit\n").unwrap();
        wait_for_exit(&mut rx, &natural.id).await;
        assert_eq!(host.list().len(), 1, "未交付的自然退出应保留墓碑");
        assert_eq!(host.list()[0].exited, Some(0));

        let killed = host.create(sh_options(16 * 1024, "client-a")).unwrap();
        host.kill(&killed.id).unwrap();
        wait_for_exit(&mut rx, &killed.id).await;
        assert_eq!(host.list().len(), 1, "只剩自然退出的墓碑");
        host.release_exited(&natural.id);
        assert!(host.list().is_empty());
        assert_eq!(host.buffered_bytes(), 0, "释放后 total_bytes 未归零");

        let replacement = host.create(sh_options(16 * 1024, "client-a")).unwrap();
        host.kill(&replacement.id).unwrap();
        wait_for_exit(&mut rx, &replacement.id).await;
        assert!(
            host.list().is_empty(),
            "kill 会立即释放 registry 槽位，不应留下墓碑"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remove_is_idempotent_and_never_deletes_a_reused_id() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(4, 64 * 1024, tx);
        let old_info = host.create(sh_options(4096, "client-a")).unwrap();
        let old_term = lock(&host.inner).terms.get(&old_info.id).cloned().unwrap();

        assert!(
            remove_term_locked(&mut lock(&host.inner), &old_info.id, &old_term).is_some(),
            "首次移除应成功"
        );
        assert!(
            remove_term_locked(&mut lock(&host.inner), &old_info.id, &old_term).is_none(),
            "重复移除必须幂等"
        );

        let new_info = host.create(sh_options(4096, "client-a")).unwrap();
        let new_term = lock(&host.inner).terms.get(&new_info.id).cloned().unwrap();
        {
            let mut inner = lock(&host.inner);
            inner.terms.remove(&new_info.id).unwrap();
            inner
                .terms
                .insert(old_info.id.clone(), Arc::clone(&new_term));
        }

        force_kill(&old_term);
        wait_for_exit(&mut rx, &old_info.id).await;
        assert!(
            Arc::ptr_eq(
                lock(&host.inner).terms.get(&old_info.id).unwrap(),
                &new_term
            ),
            "旧实例的迟到清理误删了同 id 新实例"
        );

        assert!(
            remove_term_locked(&mut lock(&host.inner), &old_info.id, &new_term).is_some(),
            "按实例身份仍应能移除新实例"
        );
        force_kill(&new_term);
        wait_for_exit(&mut rx, &new_info.id).await;
        assert_eq!(host.buffered_bytes(), 0);
    }

    /// 队列关闭时，非阻塞 writer 必须在下一次取消检查退出，不能留下卡在
    /// `write(2)` 的 blocking task（否则重连后的同一 PTY 会被旧写锁住）。
    #[cfg(unix)]
    #[tokio::test]
    async fn interruptible_write_stops_when_cancelled() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = Arc::new(PtyHost::new(4, 4 * 1024 * 1024, tx));
        let info = host
            .create(sh_options(64 * 1024, "client-a"))
            .expect("创建 PTY 失败");
        host.write(
            &info.id,
            b"stty -echo; printf 'WRITE%s\\n' _READY; exec sh -c 'while read x; do sleep 1; done'\n",
        )
        .unwrap();
        wait_for_text(&mut rx, &info.id, "WRITE_READY").await;

        let cancel = Arc::new(AtomicBool::new(false));
        let task_host = Arc::clone(&host);
        let task_id = info.id.clone();
        let task_cancel = Arc::clone(&cancel);
        let writer = tokio::spawn(async move {
            task_host
                .write_interruptible(&task_id, vec![b'x'; 8 * 1024 * 1024], task_cancel)
                .await
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel.store(true, Ordering::SeqCst);
        let result = tokio::time::timeout(Duration::from_secs(2), writer)
            .await
            .expect("取消后 writer 仍卡在写入")
            .expect("writer task panic");
        assert!(
            result.unwrap_err().contains("取消"),
            "取消写入应返回明确错误"
        );

        host.kill(&info.id).unwrap();
    }

    /// 没有消费者时 PTY reader 必须停在有界事件队列上，不能继续读 master
    /// 并把输出堆进用户态内存。
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bounded_event_sink_backpressures_pty_reader() {
        const EVENT_DEPTH: usize = 4;
        let (tx, rx) = tokio::sync::mpsc::channel(EVENT_DEPTH);
        let host = PtyHost::new(4, 1024 * 1024, tx);
        let info = host.create(sh_options(256 * 1024, "client-a")).unwrap();
        host.write(
            &info.id,
            b"i=0; while [ $i -lt 100000 ]; do echo qingcode-backpressure; i=$((i+1)); done\n",
        )
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        while rx.len() < EVENT_DEPTH {
            assert!(Instant::now() < deadline, "事件队列未被输出填满");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(rx.len(), EVENT_DEPTH, "事件队列不得超过容量");
        let stuck_at = host.list()[0].seq;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            host.list()[0].seq,
            stuck_at,
            "sink 满后 reader 仍继续推进 seq，说明背压没有生效"
        );

        host.kill(&info.id).unwrap();
        drop(rx);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detach_keeps_process_and_marks_info() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(4, 1024 * 1024, tx);
        let info = host.create(sh_options(4096, "client-a")).unwrap();
        // 不同客户端的 detach 不应生效，避免旧连接误伤。
        host.detach(&info.id, "client-b").unwrap();
        assert!(!host.list()[0].detached);

        host.detach(&info.id, "client-a").unwrap();
        let listed = host.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].detached);
        assert_eq!(listed[0].owner.as_deref(), Some("client-a"));
        assert!(listed[0].cwd.is_some());
        assert_eq!(listed[0].exited, None, "detach 不影响进程");
        assert!(
            host.attach(&info.id, 0, "client-b").is_err(),
            "不同安装/客户端不能接走已有 owner 的终端"
        );

        // 终端的 shell 仍在运行，可以继续接收输入。
        host.write(&info.id, b"printf alive\n").unwrap();
        wait_for_bytes(&mut rx, &info.id, 1).await;
        host.kill(&info.id).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn has_children_sees_running_command() {
        let (tx, _rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(4, 1024 * 1024, tx);
        let info = host.create(sh_options(4096, "client-a")).unwrap();

        host.write(&info.id, b"sleep 2\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !host.has_children(&info.id) {
            assert!(
                Instant::now() < deadline,
                "sleep 已启动，has_children 应返回 true"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        host.kill(&info.id).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn attach_after_buffer_eviction_returns_screen_snapshot() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let budget = 8 * 1024;
        let host = PtyHost::new(4, budget, tx);

        let first = host.create(sh_options(budget, "c1")).unwrap();
        host.write(
            &first.id,
            b"i=0; while [ $i -lt 2000 ]; do echo first$i; i=$((i+1)); done\n",
        )
        .unwrap();
        // 等第一个终端把缓冲填满（超过预算），再摘下它。
        wait_for_bytes(&mut rx, &first.id, budget + 1).await;
        host.detach(&first.id, "c1").unwrap();

        let second = host.create(sh_options(budget, "c2")).unwrap();
        host.write(
            &second.id,
            b"i=0; while [ $i -lt 2000 ]; do echo second$i; i=$((i+1)); done\n",
        )
        .unwrap();
        // 第二个终端的输出把总量顶过预算，触发淘汰。
        wait_for_bytes(&mut rx, &second.id, budget + 1).await;

        let reattached = host.attach(&first.id, 0, "c1").unwrap();
        assert!(
            reattached.screen.is_some(),
            "detached 最久的终端缓冲应被淘汰，退化为屏幕快照"
        );
        assert!(reattached.replay.is_empty());
        assert!(
            host.buffered_bytes() <= budget,
            "总缓冲 {} 超过预算 {budget}",
            host.buffered_bytes()
        );

        host.kill(&first.id).unwrap();
        host.kill(&second.id).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn random_disconnects_never_lose_or_duplicate_output() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2048);
        let host = PtyHost::new(2, 16 * 1024 * 1024, tx);
        let info = host
            .create(sh_options(8 * 1024 * 1024, "chaos-client"))
            .expect("创建混沌测试终端失败");
        host.write(
            &info.id,
            b"stty -echo; i=0; while [ $i -lt 120 ]; do printf 'chaos-%03d\\n' \"$i\"; i=$((i+1)); sleep 0.01; done; printf 'chaos-%s\\n' done\n",
        )
        .unwrap();

        let mut next_seq = 0u64;
        let mut output = Vec::new();
        let mut seen = std::collections::BTreeMap::new();
        let mut rng = 0x5eed_cafe_f00d_beefu64;

        for round in 0..50 {
            // 先消费少量“在线”输出，再随机断开；实际 daemon 的路由也按同样的
            // next_seq 语义丢弃 attach 与实时流之间的重叠块。
            let live_reads = (rng as usize % 5) + 1;
            for _ in 0..live_reads {
                if let Ok(Some(PtyEvent::Data { id, seq, data })) =
                    tokio::time::timeout(Duration::from_millis(20), rx.recv()).await
                {
                    if id == info.id && seq >= next_seq {
                        assert_eq!(seq, next_seq, "在线输出出现 seq 空洞");
                        assert!(seen.insert(seq, data.clone()).is_none());
                        output.extend_from_slice(&data);
                        next_seq += 1;
                    }
                }
            }

            host.detach(&info.id, "chaos-client").unwrap();
            tokio::time::sleep(Duration::from_millis(5 + rng % 11)).await;

            let attached = host
                .attach(&info.id, next_seq, "chaos-client")
                .expect("混沌重连失败");
            assert!(attached.screen.is_none(), "缓冲足够大时不应退化为屏幕快照");
            for (seq, data) in attached.replay {
                assert_eq!(seq, next_seq, "重放出现 seq 空洞");
                assert!(seen.insert(seq, data.clone()).is_none(), "重放出现重复 seq");
                output.extend_from_slice(&data);
                next_seq += 1;
            }
            while let Ok(PtyEvent::Data { id, seq, data }) = rx.try_recv() {
                if id != info.id || seq < next_seq {
                    continue;
                }
                assert_eq!(seq, next_seq, "attach 后排空实时事件出现 seq 空洞");
                assert!(
                    seen.insert(seq, data.clone()).is_none(),
                    "实时流出现重复 seq"
                );
                output.extend_from_slice(&data);
                next_seq += 1;
            }
            if String::from_utf8_lossy(&output).contains("chaos-done") {
                break;
            }
            rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(round + 1);
        }

        let deadline = Instant::now() + Duration::from_secs(20);
        while !String::from_utf8_lossy(&output).contains("chaos-done") {
            assert!(Instant::now() < deadline, "混沌输出未在 20 秒内完成");
            let remaining = deadline.saturating_duration_since(Instant::now());
            let Ok(Some(PtyEvent::Data { id, seq, data })) =
                tokio::time::timeout(remaining, rx.recv()).await
            else {
                panic!("混沌测试终端提前结束或事件流中断");
            };
            if id != info.id || seq < next_seq {
                continue;
            }
            assert_eq!(seq, next_seq, "收尾阶段出现 seq 空洞");
            assert!(
                seen.insert(seq, data.clone()).is_none(),
                "收尾阶段出现重复 seq"
            );
            output.extend_from_slice(&data);
            next_seq += 1;
        }

        let text = String::from_utf8_lossy(&output);
        let numbers: Vec<usize> = text
            .lines()
            .filter_map(|line| line.find("chaos-").map(|start| &line[start + 6..]))
            .filter_map(|value| {
                let digits = value
                    .char_indices()
                    .take_while(|(_, ch)| ch.is_ascii_digit())
                    .map(|(index, _)| index)
                    .last()
                    .map(|index| &value[..=index])?;
                (digits.len() == 3)
                    .then(|| digits.parse::<usize>().ok())
                    .flatten()
            })
            .collect();
        assert_eq!(
            numbers,
            (0..120).collect::<Vec<_>>(),
            "混沌重连后输出序号不连续或重复"
        );

        host.kill(&info.id).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_conpty_runs_powershell_command() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let host = PtyHost::new(2, 4 * 1024 * 1024, tx);
        let cwd = std::env::temp_dir().join(format!(
            "qingcode-conpty-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&cwd).unwrap();
        // 远端真实调用会先 canonicalize（Windows 上带 `\\?\` 前缀），PTY 必须
        // 用去掉前缀的普通路径，否则 PowerShell 提示符与 cmd 都会异常。
        let cwd = std::fs::canonicalize(&cwd).unwrap();
        assert!(
            cwd.to_string_lossy().starts_with(r"\\?\"),
            "前置条件：canonicalize 应返回 verbatim 路径"
        );
        let info = host
            .create(PtyCreateOptions {
                cwd: cwd.clone(),
                shell: Some("powershell.exe".to_string()),
                args: vec![
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    "Write-Output ok".to_string(),
                ],
                env: BTreeMap::new(),
                name: Some("windows-conpty".to_string()),
                cols: 80,
                rows: 24,
                scrollback_bytes: 1024 * 1024,
                client_id: "windows-test".to_string(),
            })
            .expect("ConPTY 创建失败");

        assert_eq!(
            info.cwd.as_deref(),
            Some(cwd.to_string_lossy().trim_start_matches(r"\\?\")),
            "PTY 工作目录不能带 verbatim 前缀"
        );
        wait_for_text(&mut rx, &info.id, "ok").await;
        assert_eq!(wait_for_exit(&mut rx, &info.id).await, Some(0));
        let _ = std::fs::remove_dir_all(cwd);
    }

    /// daemon 经 sshd exec 拉起时继承了「忽略 Ctrl+C」：这里先让测试进程进入同样
    /// 状态，再确认 ConPTY 里的前台循环仍能被 Ctrl+C 中断。
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_conpty_ctrl_c_interrupts_even_if_parent_ignores_it() {
        use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
        // SAFETY: 处理函数为 NULL 时只设置本进程的 Ctrl+C 忽略标记。
        unsafe { SetConsoleCtrlHandler(None, 1) };
        let (tx, mut rx) = tokio::sync::mpsc::channel(256);
        let host = PtyHost::new(2, 4 * 1024 * 1024, tx);
        let info = host
            .create(PtyCreateOptions {
                cwd: std::env::temp_dir(),
                shell: Some("powershell.exe".to_string()),
                args: vec![
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    "while ($true) { 'TICK'; Start-Sleep -Milliseconds 200 }".to_string(),
                ],
                env: BTreeMap::new(),
                name: Some("windows-ctrl-c".to_string()),
                cols: 80,
                rows: 24,
                scrollback_bytes: 1024 * 1024,
                client_id: "windows-test".to_string(),
            })
            .expect("ConPTY 创建失败");
        wait_for_text(&mut rx, &info.id, "TICK").await;
        host.write(&info.id, b"\x03").unwrap();
        // 忽略 Ctrl+C 时循环永不结束，wait_for_exit 会超时失败。
        wait_for_exit(&mut rx, &info.id).await;
    }
}
