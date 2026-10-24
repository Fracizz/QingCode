//! `connect --stdio`：SSH `exec` 进程里的连接代理。
//!
//! 它只做一件事：把 stdin/stdout 与 daemon 的本地 IPC 双向对接。SSH 连接断开时
//! 本进程退出，daemon 与其持有的 PTY 完全不受影响；重连时启动新的代理即可。
//!
//! 之所以不让客户端直接连本地 IPC（unix 的 `direct-streamlocal` 转发），
//! 是因为 Windows OpenSSH 不支持这种转发，且 `AllowStreamLocalForwarding`
//! 常被关闭（设计 §3）。
//!
//! 代理本身**不解析帧**，也不携带 token：HELLO 由客户端在隧道里发出，
//! daemon 侧校验 token；代理这一层的安全性来自本地 IPC 的访问控制
//! （Unix 是同一 uid 才能连上 socket；Windows 是 named pipe 的用户 DACL）。
//!
//! 实现上 Unix 用两条阻塞的 `std::io::copy`（上行跑在独立线程）而不是
//! `tokio::io::copy`：`tokio::io::stdin` 会把读操作丢到 blocking 线程池，运行时
//! 析构要等它返回；SSH 挂起时 stdin 可能永远读不到数据，进程就会卡在退出上。
//! 这里所有 IO 都是一个短生命周期进程能做的最朴素的事：读到 EOF 就走。
//!
//! Windows 不行：命名管道的**同步**句柄同一时刻只允许一个在途 I/O，一边阻塞读时
//! 另一边写会立刻得到 `ERROR_NO_DATA(232)`。所以 Windows 侧用 tokio 的 overlapped
//! 客户端（`IpcEndpoint::connect`），读写各跑一个异步任务；stdin/stdout 仍由独立
//! OS 线程 + 有界通道桥接，不占用运行时工作线程。

#[cfg(any(unix, test))]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::daemon::{home_dir, RunDir};
use crate::ipc::IpcEndpoint;

/// `connect` 的启动参数。
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// 覆盖运行目录（与 daemon 的 `--state-dir` 一致）。
    pub state_dir: Option<PathBuf>,
    /// IPC 连不上时自动拉起 daemon（SSH exec 用 `--ensure-daemon`）。
    pub ensure_daemon: bool,
    /// 等 daemon 就绪的上限。
    pub start_timeout: Duration,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            state_dir: None,
            ensure_daemon: false,
            start_timeout: Duration::from_secs(10),
        }
    }
}

/// 入口：确保 daemon 在，然后把 stdio 与本地 IPC 对接，直到任一端 EOF。
///
/// 返回 `Ok(())` 表示隧道正常结束（对端关闭或 stdin EOF）。调用方（`main`）
/// 随后退出进程，不会等待可能仍阻塞在 stdin 上的上行线程。
pub fn run_stdio(options: ConnectOptions) -> Result<(), String> {
    let run_dir = RunDir::resolve(options.state_dir.as_deref())?;
    let endpoint = IpcEndpoint::new(run_dir.dir());

    #[cfg(unix)]
    {
        let pair = connect_blocking_or_spawn(&endpoint, &run_dir, &options)?;
        pump_blocking(pair)
    }
    #[cfg(windows)]
    {
        pump_windows(endpoint, run_dir, options)
    }
}

/// 先直连一次，失败且允许时拉起 daemon 再连（Unix：socket 阻塞客户端）。
#[cfg(unix)]
fn connect_blocking_or_spawn(
    endpoint: &IpcEndpoint,
    run_dir: &RunDir,
    options: &ConnectOptions,
) -> Result<crate::ipc::BlockingIpcPair, String> {
    match endpoint.blocking_connect() {
        Ok(pair) => Ok(pair),
        Err(first_error) => {
            if !options.ensure_daemon {
                return Err(format!(
                    "连接 {} 失败: {first_error}（未指定 --ensure-daemon）",
                    endpoint.describe()
                ));
            }
            let mut child = spawn_daemon(options.state_dir.as_deref())?;
            wait_ready(run_dir, options.start_timeout, &mut child)?;
            endpoint
                .blocking_connect()
                .map_err(|e| format!("daemon 已启动但连接失败: {e}"))
        }
    }
}

/// 阻塞泵（Unix）：socket 支持同时读写，两条 copy 分别在上行线程与主线程。
#[cfg(unix)]
fn pump_blocking(pair: crate::ipc::BlockingIpcPair) -> Result<(), String> {
    let crate::ipc::BlockingIpcPair {
        read: mut reader,
        write: writer,
    } = pair;

    // 上行：stdin → IPC。EOF 后关掉写半边，让 daemon 看到干净的 EOF，
    // 而不是等心跳超时（PTY 本身不受影响，仍按 detached 处理）。
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut writer = writer;
        let mut buffer = [0u8; 16 * 1024];
        let mut total = 0u64;
        loop {
            let read = match std::io::Read::read(&mut stdin, &mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    debug_log(format_args!("upstream read err {e}"));
                    break;
                }
            };
            match std::io::Write::write_all(&mut writer, &buffer[..read]) {
                Ok(()) => {
                    total += read as u64;
                    debug_log(format_args!("upstream wrote {total}B"));
                }
                Err(e) => {
                    debug_log(format_args!("upstream write err {e}"));
                    break;
                }
            }
        }
        debug_log(format_args!("upstream loop end total={total}"));
        let _ = writer.shutdown_write();
    });

    // 下行：IPC → stdout。读到 EOF 说明 daemon 关闭了连接（退出或心跳超时）。
    let mut stdout = std::io::stdout().lock();
    let result = copy_flushing(&mut reader, &mut stdout);
    debug_log(format_args!("downstream done: {result:?}"));
    let _ = stdout.flush();
    result
        .map(|_| ())
        .map_err(|e| format!("转发 daemon 输出失败: {e}"))
}

/// Windows 泵：命名管道的**同步**句柄同一时刻只允许一个在途 I/O——一边阻塞
/// 读时另一边写会立刻得到 `ERROR_NO_DATA(232)`，读端也只能看到 EOF（纯 Win32
/// 与 `DuplicateHandle` 可稳定复现）。所以 Windows 客户端必须用 overlapped
/// 句柄（tokio NamedPipeClient）：读写各跑一个异步任务。
///
/// stdin/stdout 仍是阻塞 IO，用独立 OS 线程 + 有界通道桥接：既不占用运行时
/// 工作线程，也保留端到端背压。下行结束即返回（与 Unix 一样不等 stdin 线程，
/// 进程退出时随之收摊）。
#[cfg(windows)]
fn pump_windows(
    endpoint: IpcEndpoint,
    run_dir: RunDir,
    options: ConnectOptions,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| format!("创建 IPC 运行失败: {e}"))?;

    let client = match runtime.block_on(connect_async(&endpoint)) {
        Ok(client) => client,
        Err(first_error) => {
            if !options.ensure_daemon {
                return Err(format!(
                    "连接 {} 失败: {first_error}（未指定 --ensure-daemon）",
                    endpoint.describe()
                ));
            }
            let mut child = spawn_daemon(options.state_dir.as_deref())?;
            wait_ready(&run_dir, options.start_timeout, &mut child)?;
            runtime
                .block_on(connect_async(&endpoint))
                .map_err(|e| format!("daemon 已启动但连接失败: {e}"))?
        }
    };

    runtime.block_on(async move {
        let (mut reader, mut writer) = tokio::io::split(client);

        let (up_tx, mut up_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut buffer = [0u8; 16 * 1024];
            let mut total = 0u64;
            loop {
                match std::io::Read::read(&mut stdin, &mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if up_tx.blocking_send(buffer[..n].to_vec()).is_err() {
                            break;
                        }
                        total += n as u64;
                        debug_log(format_args!("upstream wrote {total}B"));
                    }
                    Err(e) => {
                        debug_log(format_args!("upstream read err {e}"));
                        break;
                    }
                }
            }
            debug_log(format_args!("upstream loop end total={total}"));
        });

        let (down_tx, mut down_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
        let stdout_thread = std::thread::spawn(move || {
            let mut stdout = std::io::stdout().lock();
            while let Some(chunk) = down_rx.blocking_recv() {
                let written = std::io::Write::write_all(&mut stdout, &chunk)
                    .and_then(|_| std::io::Write::flush(&mut stdout));
                if written.is_err() {
                    break;
                }
            }
        });

        let mut upstream = tokio::spawn(async move {
            while let Some(chunk) = up_rx.recv().await {
                if let Err(e) = writer.write_all(&chunk).await {
                    debug_log(format_args!("upstream write err {e}"));
                    break;
                }
            }
            // 命名管道没有半关闭：不显式 shutdown，随进程退出关闭句柄。
            let _ = writer.flush().await;
        });

        // 上行结束（stdin EOF = 客户端已关闭 SSH 通道）也要立刻收尾：命名管道
        // 没有半关闭，daemon 看不到 EOF，若只等下行 EOF，代理会一直挂到 daemon
        // 的心跳 PING 写 stdout 失败为止（约 30s），期间白占 sshd 会话名额。
        let mut buffer = [0u8; 16 * 1024];
        let result = loop {
            tokio::select! {
                read = reader.read(&mut buffer) => match read {
                    Ok(0) => break Ok(()),
                    Ok(n) => {
                        if down_tx.send(buffer[..n].to_vec()).await.is_err() {
                            break Err("终端输出线程已退出".to_string());
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => break Err(format!("转发 daemon 输出失败: {e}")),
                },
                _ = &mut upstream => {
                    debug_log(format_args!("upstream finished, closing tunnel"));
                    break Ok(());
                }
            }
        };
        drop(down_tx);
        let _ = stdout_thread.join();
        upstream.abort();
        result
    })
}

/// 异步连接 + 与阻塞版本一致的瞬态重试（acceptor 补建实例的空窗）。
#[cfg(windows)]
async fn connect_async(endpoint: &IpcEndpoint) -> std::io::Result<crate::ipc::IpcStream> {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match endpoint.connect().await {
            Ok(stream) => return Ok(stream),
            Err(error) => {
                let transient = matches!(
                    error.raw_os_error(),
                    Some(2) | Some(231) // ERROR_FILE_NOT_FOUND / ERROR_PIPE_BUSY
                );
                if !transient || std::time::Instant::now() >= deadline {
                    return Err(error);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
}

/// 诊断日志（`QINGCODE_SERVER_DEBUG=1` 开启），只进 stderr，不污染数据通道。
fn debug_log(message: std::fmt::Arguments<'_>) {
    if crate::debug_enabled() {
        eprintln!("[connect] {message}");
    }
}

/// `std::io::copy` + 及时 flush：终端输出中间可能没有换行，留在缓冲里就等于丢帧。
/// Unix 泵使用；Windows 走异步分片，不需要它（测试仍覆盖这段逻辑）。
#[cfg(any(unix, test))]
fn copy_flushing(reader: &mut impl Read, writer: &mut impl Write) -> std::io::Result<u64> {
    let mut buffer = [0u8; 16 * 1024];
    let mut total = 0u64;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(total),
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        writer.write_all(&buffer[..read])?;
        writer.flush()?;
        total += read as u64;
    }
}

/// 拉起的 daemon 句柄：供 `wait_ready` 探测「立即退出」。
enum SpawnedDaemon {
    #[cfg(unix)]
    Unix(std::process::Child),
    #[cfg(windows)]
    Windows(crate::winproc::WindowsChild),
    /// 测试专用：直接包一个 std Child（Windows 上没有 Unix 变体可用）。
    #[cfg(all(test, windows))]
    Test(std::process::Child),
}

impl SpawnedDaemon {
    /// 非阻塞探测：已退出返回退出描述，仍在运行返回 None。
    fn try_wait(&mut self) -> std::io::Result<Option<String>> {
        match self {
            #[cfg(unix)]
            Self::Unix(child) => Ok(child.try_wait()?.map(|status| status.to_string())),
            #[cfg(windows)]
            Self::Windows(child) => Ok(child.try_wait()?.map(|code| format!("exit code {code}"))),
            #[cfg(all(test, windows))]
            Self::Test(child) => Ok(child.try_wait()?.map(|status| status.to_string())),
        }
    }

    #[cfg(test)]
    fn from_test_child(child: std::process::Child) -> Self {
        #[cfg(unix)]
        {
            Self::Unix(child)
        }
        #[cfg(windows)]
        {
            Self::Test(child)
        }
    }
}

/// 拉起 daemon 并脱离当前会话，保证 SSH 会话结束不带走它。
///
/// Unix：`setsid` + stdio 全 null。Windows：CreateProcessW + 空句柄继承表
/// （std spawn 会把 SSH 会话的 stdout 管道一并继承，详见 `winproc` 模块注释）。
fn spawn_daemon(state_dir: Option<&Path>) -> Result<SpawnedDaemon, String> {
    #[cfg(unix)]
    {
        use std::process::{Command, Stdio};
        let exe = std::env::current_exe().map_err(|e| format!("无法定位自身可执行文件: {e}"))?;
        let mut command = Command::new(exe);
        command
            .arg("daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(dir) = state_dir {
            command.arg("--state-dir").arg(dir);
        }
        // SAFETY: pre_exec 里只调用 setsid（async-signal-safe），不触碰 Rust 堆。
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .spawn()
            .map(SpawnedDaemon::Unix)
            .map_err(|e| format!("启动 daemon 失败: {e}"))
    }
    #[cfg(windows)]
    {
        crate::winproc::spawn_detached_daemon(state_dir).map(SpawnedDaemon::Windows)
    }
}

/// 等就绪标记与 token 出现。子进程提前退出（例如抢锁失败但锁被占）时立刻返回，
/// 避免白等满超时。
fn wait_ready(
    run_dir: &RunDir,
    timeout: Duration,
    child: &mut SpawnedDaemon,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if run_dir.ready_marker().exists() && run_dir.read_token().is_ok() {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            // 抢锁失败时子进程会直接退出：此时另一个 daemon 应该已经就绪。
            if run_dir.ready_marker().exists() && run_dir.read_token().is_ok() {
                return Ok(());
            }
            return Err(format!("daemon 启动后立即退出（{status}）"));
        }
        if Instant::now() >= deadline {
            return Err(format!("等待 daemon 就绪超时（{}s）", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 运行目录的默认位置，供诊断信息使用。
pub fn default_run_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".qingcode").join("server").join("run"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "qingcode-connect-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 一个立即退出的命令（跨平台）：探测 wait_ready 的 fail-fast。
    fn exit_now_command() -> std::process::Command {
        #[cfg(unix)]
        {
            std::process::Command::new("true")
        }
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("cmd");
            command.arg("/c").arg("rem");
            command
        }
    }

    /// 一个持续运行的命令（跨平台）：探测 wait_ready 的超时。
    fn sleep_command() -> std::process::Command {
        #[cfg(unix)]
        {
            let mut command = std::process::Command::new("sleep");
            command.arg("5");
            command
        }
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("ping");
            command.arg("-n").arg("5").arg("127.0.0.1");
            command
        }
    }

    #[test]
    fn wait_ready_fails_fast_when_child_exits() {
        let dir = temp_dir("exits");
        let run_dir = RunDir::resolve(Some(&dir)).unwrap();
        let mut spawned = SpawnedDaemon::from_test_child(exit_now_command().spawn().unwrap());
        let started = Instant::now();
        let result = wait_ready(&run_dir, Duration::from_secs(10), &mut spawned);
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "子进程退出后仍等满了超时"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wait_ready_times_out_without_daemon() {
        let dir = temp_dir("timeout");
        let run_dir = RunDir::resolve(Some(&dir)).unwrap();
        let mut spawned = SpawnedDaemon::from_test_child(sleep_command().spawn().unwrap());
        let result = wait_ready(&run_dir, Duration::from_millis(300), &mut spawned);
        assert!(matches!(result, Err(ref message) if message.contains("超时")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_flushing_forwards_bytes() {
        let input = b"hello terminal";
        let mut reader = std::io::Cursor::new(input.to_vec());
        let mut output = Vec::new();
        let copied = copy_flushing(&mut reader, &mut output).unwrap();
        assert_eq!(copied, input.len() as u64);
        assert_eq!(output, input);
    }

    #[test]
    fn default_run_dir_is_under_home() {
        if let Some(dir) = default_run_dir() {
            assert!(dir.ends_with("server/run"));
        }
    }
}
