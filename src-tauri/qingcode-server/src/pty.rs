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

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc::UnboundedSender;
use vt100::Parser;

/// 单次从 master 读的字节数。和主程序终端一致：8KB 足够摊薄系统调用，
/// 又不会让单个 seq 块在环形缓冲里占太大地盘。
const READ_BUF_BYTES: usize = 8 * 1024;

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

/// 创建一个 PTY 的参数。
#[derive(Debug, Clone)]
pub struct PtyCreateOptions {
    /// 终端工作目录（项目根）。
    pub cwd: PathBuf,
    /// 显式指定的 shell；`None` 时用 `$SHELL`，再退化到 `/bin/sh`（登录 shell）。
    pub shell: Option<String>,
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
    pub exited: Option<i32>,
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
    /// 当前接着的客户端；`detach` 只接受归属者，避免旧连接把别人接回的终端踢下线。
    owner: Option<String>,
}

/// 进程控制句柄：`pid` 用于 `/proc` 查询与 `SIGHUP`，`killer` 是 portable-pty 的兜底。
struct ProcHandles {
    pid: Option<u32>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

struct PtyTerm {
    id: String,
    created: u64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    proc: Mutex<ProcHandles>,
    state: Mutex<TermState>,
}

struct HostInner {
    terms: HashMap<String, Arc<PtyTerm>>,
    /// 所有终端环形缓冲的字节总和。只在持有宿主锁时读写，
    /// 保证「总缓冲 ≤ `total_buffer_bytes`」是硬约束而不是近似值。
    total_bytes: usize,
}

/// PTY 宿主。`Send + Sync`，内部用 `Mutex` 保护，daemon 里放 `Arc` 共享。
pub struct PtyHost {
    inner: Arc<Mutex<HostInner>>,
    max_ptys: usize,
    total_buffer_bytes: usize,
    event_sink: UnboundedSender<PtyEvent>,
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
    pub fn new(
        max_ptys: usize,
        total_buffer_bytes: usize,
        event_sink: UnboundedSender<PtyEvent>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HostInner {
                terms: HashMap::new(),
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
        let cols = clamp_cols(opts.cols);
        let rows = clamp_rows(opts.rows);
        if !opts.cwd.is_dir() {
            return Err(format!("终端工作目录不存在：{}", opts.cwd.display()));
        }
        let program = opts.shell.clone().unwrap_or_else(default_shell);

        let mut inner = lock(&self.inner);
        if inner.terms.len() >= self.max_ptys {
            return Err(format!(
                "终端数量已达上限（{} 个），请先结束其他终端",
                self.max_ptys
            ));
        }

        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|err| format!("无法创建 PTY：{err}"))?;
        let mut cmd = CommandBuilder::new(&program);
        // 默认 shell 走登录 shell（与直连模式一致，加载用户的 profile）。
        // 显式指定 shell 时按调用方给的程序原样启动。
        #[cfg(unix)]
        if opts.shell.is_none() {
            cmd.arg("-l");
        }
        cmd.cwd(&opts.cwd);
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|err| format!("无法启动终端程序「{program}」：{err}"))?;
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

        let id = self.next_id();
        let ring_capacity = opts.scrollback_bytes;
        let term = Arc::new(PtyTerm {
            id: id.clone(),
            created: self.created_counter.fetch_add(1, Ordering::Relaxed),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
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
                owner: Some(opts.client_id),
            }),
        });
        // 先把终端放进表里，读线程一启动就能找到自己（否则首批输出会丢）。
        inner.terms.insert(id.clone(), Arc::clone(&term));
        drop(inner);

        let inner_for_reader = Arc::clone(&self.inner);
        let sink = self.event_sink.clone();
        let budget = self.total_buffer_bytes;
        let thread_id = id.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("pty-{thread_id}"))
            .spawn(move || {
                read_loop(inner_for_reader, budget, thread_id, reader, child, sink);
            });
        if let Err(err) = spawned {
            lock(&self.inner).terms.remove(&id);
            return Err(format!("无法启动终端读取线程：{err}"));
        }

        Ok(PtyInfo {
            id,
            seq: 0,
            cols,
            rows,
            exited: None,
            detached: false,
        })
    }

    /// 把客户端输入写进 PTY。写入可能因为内核缓冲满而阻塞，
    /// 期间不持有宿主锁（只持有该终端自己的写句柄）。
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let term = self.term(id)?;
        if lock(&term.state).exited.is_some() {
            return Err("终端进程已退出".to_string());
        }
        let mut writer = lock(&term.writer);
        writer
            .write_all(data)
            .map_err(|err| format!("写入终端失败：{err}"))?;
        writer.flush().map_err(|err| format!("写入终端失败：{err}"))
    }

    /// 调整终端尺寸：内核 winsize（触发 SIGWINCH）+ 解析器网格一起改。
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let cols = clamp_cols(cols);
        let rows = clamp_rows(rows);
        let term = self.term(id)?;
        lock(&term.master)
            .resize(pty_size(cols, rows))
            .map_err(|err| format!("调整终端尺寸失败：{err}"))?;
        let mut state = lock(&term.state);
        state.parser.set_size(rows, cols);
        state.cols = cols;
        state.rows = rows;
        Ok(())
    }

    /// 客户端接回终端。`from_seq` 仍被缓冲覆盖时只补缺失块，否则给屏幕快照。
    /// 无论哪条路径都会把终端标记为已接入（`detached = false`）。
    pub fn attach(&self, id: &str, from_seq: u64, client_id: &str) -> Result<AttachResult, String> {
        let term = self.term(id)?;
        let mut state = lock(&term.state);
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
        state.attached = false;
        state.detached_at = Some(Instant::now());
        state.owner = None;
        Ok(())
    }

    /// 结束终端：先对进程组发 `SIGHUP` 让 shell 能正常收尾，1 秒后仍未退出
    /// 再用 portable-pty 的 killer（unix 上是 `SIGKILL`）兜底。
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let term = self.term(id)?;
        if lock(&term.state).exited.is_some() {
            return Ok(());
        }
        let pid = lock(&term.proc).pid;
        hangup(pid, &term);
        let term_for_watchdog = Arc::clone(&term);
        std::thread::Builder::new()
            .name(format!("pty-kill-{id}"))
            .spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                if lock(&term_for_watchdog.state).exited.is_none() {
                    force_kill(&term_for_watchdog);
                }
            })
            .map_err(|err| format!("无法启动终端回收线程：{err}"))?;
        Ok(())
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

    /// 回收 detached 超过 `detached_ttl` 的终端：发 `SIGHUP` 并从宿主移除，
    /// 返回被回收的 id。进程退出后由读线程收尾，事件仍会照常发 `pty.exit`。
    pub fn reap(&self, detached_ttl: Duration) -> Vec<String> {
        let now = Instant::now();
        let mut reclaimed: Vec<(String, Arc<PtyTerm>)> = Vec::new();
        {
            let mut inner = lock(&self.inner);
            let expired: Vec<String> = inner
                .terms
                .iter()
                .filter_map(|(id, term)| {
                    let state = lock(&term.state);
                    if state.attached {
                        return None;
                    }
                    let detached_at = state.detached_at?;
                    if now.saturating_duration_since(detached_at) >= detached_ttl {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();
            for id in expired {
                if let Some(term) = inner.terms.remove(&id) {
                    // 回收的终端连同它的缓冲一起释放，总量账目同步扣减。
                    let freed = lock(&term.state).ring.bytes();
                    inner.total_bytes = inner.total_bytes.saturating_sub(freed);
                    reclaimed.push((id, term));
                }
            }
        }
        // 先在锁外发信号，避免 syscall / 阻塞拖住整个宿主。
        for (_, term) in &reclaimed {
            let pid = lock(&term.proc).pid;
            hangup(pid, term);
        }
        reclaimed.into_iter().map(|(id, _)| id).collect()
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

/// 读线程主循环：把 master 的输出同时喂给解析器、环形缓冲和事件通道。
///
/// 读线程是唯一往缓冲里写的线程，因此 seq 天然单调；它最后负责 `wait` 出退出码，
/// 记录 `exited` 并推 `PtyEvent::Exit`。
fn read_loop(
    inner: Arc<Mutex<HostInner>>,
    budget: usize,
    id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    sink: UnboundedSender<PtyEvent>,
) {
    let mut buf = [0u8; READ_BUF_BYTES];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => push_output(&inner, budget, &id, &sink, &buf[..n]),
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            // Linux 上从端全部关闭后主端返回 EIO，语义上等价 EOF。
            Err(_) => break,
        }
    }
    let code = child.wait().ok().map(|status| status.exit_code() as i32);
    if let Some(term) = lock(&inner).terms.get(&id).cloned() {
        // `wait` 失败（极罕见）时仍需标记已退出，否则 attach 会一直报「运行中」。
        lock(&term.state).exited = Some(code.unwrap_or(-1));
    }
    let _ = sink.send(PtyEvent::Exit { id, code });
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
    sink: &UnboundedSender<PtyEvent>,
    data: &[u8],
) {
    if data.is_empty() {
        return;
    }
    let seq = {
        let mut host = lock(inner);
        let Some(term) = host.terms.get(id).cloned() else {
            return;
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
    let _ = sink.send(PtyEvent::Data {
        id: id.to_string(),
        seq,
        data: data.to_vec(),
    });
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

fn default_shell() -> String {
    #[cfg(unix)]
    {
        // daemon 的 `$SHELL` 就是登录用户的默认 shell；路径不存在时退回 /bin/sh，
        // 免得远端环境变量指到一个已卸载的 shell 上直接起不来。
        if let Ok(shell) = std::env::var("SHELL") {
            let shell = shell.trim().to_string();
            if !shell.is_empty() && std::path::Path::new(&shell).exists() {
                return shell;
            }
        }
        "/bin/sh".to_string()
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
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
    // Windows（或 unix 上拿不到 pid）：用 portable-pty 的 Killer，
    // Windows 上是 TerminateProcess，unix 上是 SIGKILL。
    force_kill(term);
}

fn force_kill(term: &PtyTerm) {
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
    fn clamp_keeps_grid_sane() {
        let size = pty_size(clamp_cols(0), clamp_rows(0));
        assert_eq!((size.cols, size.rows), (MIN_COLS, MIN_ROWS));
        let size = pty_size(clamp_cols(u16::MAX), clamp_rows(u16::MAX));
        assert_eq!((size.cols, size.rows), (MAX_COLS, MAX_ROWS));
    }

    #[test]
    fn ids_are_unique_hex() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let host = PtyHost::new(4, 1024, tx);
        let first = host.next_id();
        let second = host.next_id();
        assert_ne!(first, second);
        assert_eq!(first.len(), 16);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    /// 按 id 累计数据块字节数，直到够 `want` 或超时。
    #[cfg(unix)]
    async fn wait_for_bytes(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<PtyEvent>,
        id: &str,
        want: usize,
    ) {
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

    #[cfg(unix)]
    fn sh_options(scrollback_bytes: usize, client_id: &str) -> PtyCreateOptions {
        PtyCreateOptions {
            cwd: std::env::temp_dir(),
            shell: Some("/bin/sh".to_string()),
            cols: 80,
            rows: 24,
            scrollback_bytes,
            client_id: client_id.to_string(),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_streams_data_then_exit_and_replays_from_seq() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let host = PtyHost::new(4, 4 * 1024 * 1024, tx);
        let info = host
            .create(sh_options(64 * 1024, "client-a"))
            .expect("创建 PTY 失败");
        host.write(&info.id, b"printf hello; sleep 0.2; exit\n")
            .expect("写入终端失败");

        let mut output = Vec::new();
        let mut seqs = Vec::new();
        let mut exit = None;
        loop {
            match tokio::time::timeout(Duration::from_secs(20), rx.recv()).await {
                Ok(Some(PtyEvent::Data { seq, data, .. })) => {
                    seqs.push(seq);
                    output.extend_from_slice(&data);
                }
                Ok(Some(PtyEvent::Exit { code, .. })) => {
                    exit = Some(code);
                    break;
                }
                Ok(None) => break,
                Err(_) => panic!("等待 exit 事件超时"),
            }
        }

        let text = String::from_utf8_lossy(&output).into_owned();
        assert!(text.contains("hello"), "未收到 hello 输出：{text:?}");
        assert!(
            seqs.windows(2).all(|pair| pair[1] == pair[0] + 1),
            "seq 应严格递增且连续：{seqs:?}"
        );
        assert_eq!(exit, Some(Some(0)), "sh 正常退出应带 code 0");

        // 从 0 重放：缓冲还在，给缺失块而不是快照。
        let replay_all = host.attach(&info.id, 0, "client-a").expect("attach 失败");
        assert!(replay_all.screen.is_none(), "缓冲未淘汰时不该给屏幕快照");
        assert!(!replay_all.replay.is_empty());
        assert_eq!(replay_all.exited, Some(0));
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
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detach_keeps_process_and_marks_info() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let host = PtyHost::new(4, 1024 * 1024, tx);
        let info = host.create(sh_options(4096, "client-a")).unwrap();
        // 不同客户端的 detach 不应生效，避免旧连接误伤。
        host.detach(&info.id, "client-b").unwrap();
        assert!(!host.list()[0].detached);

        host.detach(&info.id, "client-a").unwrap();
        let listed = host.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].detached);
        assert_eq!(listed[0].exited, None, "detach 不影响进程");

        // 终端的 shell 仍在运行，可以继续接收输入。
        host.write(&info.id, b"printf alive\n").unwrap();
        wait_for_bytes(&mut rx, &info.id, 1).await;
        assert!(!host.has_children(&info.id), "空闲 shell 没有子进程");
        host.kill(&info.id).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn has_children_sees_running_command() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let host = PtyHost::new(4, 1024 * 1024, tx);
        let info = host.create(sh_options(4096, "client-a")).unwrap();
        assert!(!host.has_children(&info.id), "刚起来的 shell 没有子进程");

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
    async fn total_buffer_budget_evicts_longest_detached_buffer() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
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
}
