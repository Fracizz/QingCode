//! `connect --stdio`：SSH `exec` 进程里的连接代理。
//!
//! 它只做一件事：把 stdin/stdout 与 daemon 的本地 socket 双向对接。SSH 连接断开时
//! 本进程退出，daemon 与其持有的 PTY 完全不受影响；重连时启动新的代理即可。
//!
//! 之所以不让客户端直接连 socket（`direct-streamlocal`），是因为 Windows OpenSSH
//! 不支持这种转发，且 `AllowStreamLocalForwarding` 常被关闭（设计 §3）。
//!
//! 代理本身**不解析帧**，也不携带 token：HELLO 由客户端在隧道里发出，
//! daemon 侧校验 token；代理这一层的安全性来自 `SO_PEERCRED`（同一 uid 才能连上 socket）。
//!
//! 实现上用两条阻塞的 `std::io::copy`（上行跑在独立线程）而不是 `tokio::io::copy`：
//! `tokio::io::stdin` 会把读操作丢到 blocking 线程池，运行时析构要等它返回；
//! SSH 挂起时 stdin 可能永远读不到数据，进程就会卡在退出上。这里所有 IO 都是
//! 一个短生命周期进程能做的最朴素的事：读到 EOF 就走。

#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::daemon::{home_dir, RunDir};

/// `connect` 的启动参数。
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// 覆盖运行目录（与 daemon 的 `--state-dir` 一致）。
    pub state_dir: Option<PathBuf>,
    /// socket 连不上时自动拉起 daemon（SSH exec 用 `--ensure-daemon`）。
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

/// 入口：确保 daemon 在，然后把 stdio 与 socket 对接，直到任一端 EOF。
///
/// 返回 `Ok(())` 表示隧道正常结束（对端关闭或 stdin EOF）。调用方（`main`）
/// 随后退出进程，不会等待可能仍阻塞在 stdin 上的上行线程。
pub fn run_stdio(options: ConnectOptions) -> Result<(), String> {
    let run_dir = RunDir::resolve(options.state_dir.as_deref())?;
    let socket_path = run_dir.socket();

    // 先直接连一次：已有 daemon 时省掉一次 spawn。
    let stream = match UnixStream::connect(&socket_path) {
        Ok(stream) => stream,
        Err(first_error) => {
            if !options.ensure_daemon {
                return Err(format!(
                    "连接 {} 失败: {first_error}（未指定 --ensure-daemon）",
                    socket_path.display()
                ));
            }
            let mut child = spawn_daemon(options.state_dir.as_deref())?;
            wait_ready(&run_dir, options.start_timeout, &mut child)?;
            UnixStream::connect(&socket_path)
                .map_err(|e| format!("daemon 已启动但连接失败: {e}"))?
        }
    };

    let mut reader = stream
        .try_clone()
        .map_err(|e| format!("复制 socket 句柄失败: {e}"))?;
    let mut writer = stream;

    // 上行：stdin → socket。EOF 后关掉写半边，让 daemon 看到干净的 EOF，
    // 而不是等心跳超时（PTY 本身不受影响，仍按 detached 处理）。
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let _ = std::io::copy(&mut stdin, &mut writer);
        let _ = writer.shutdown(std::net::Shutdown::Write);
    });

    // 下行：socket → stdout。读到 EOF 说明 daemon 关闭了连接（退出或心跳超时）。
    let mut stdout = std::io::stdout().lock();
    let result = copy_flushing(&mut reader, &mut stdout);
    let _ = stdout.flush();
    result
        .map(|_| ())
        .map_err(|e| format!("转发 daemon 输出失败: {e}"))
}

/// `std::io::copy` + 及时 flush：终端输出中间可能没有换行，留在缓冲里就等于丢帧。
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

/// 拉起 daemon：脱离当前会话（`setsid`）并丢弃 stdio，保证 SSH 会话结束不带走它。
fn spawn_daemon(state_dir: Option<&Path>) -> Result<std::process::Child, String> {
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
        .map_err(|e| format!("启动 daemon 失败: {e}"))
}

/// 等 socket 与 token 就绪。子进程提前退出（例如抢锁失败但锁被占）时立刻返回，
/// 避免白等满 10 秒。
fn wait_ready(
    run_dir: &RunDir,
    timeout: Duration,
    child: &mut std::process::Child,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if run_dir.socket().exists() && run_dir.read_token().is_ok() {
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            // 抢锁失败时子进程会直接退出：此时另一个 daemon 应该已经就绪。
            if run_dir.socket().exists() && run_dir.read_token().is_ok() {
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
    home_dir().map(|home| home.join(".qingcode").join("agent").join("run"))
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

    #[test]
    fn wait_ready_fails_fast_when_child_exits() {
        let dir = temp_dir("exits");
        let run_dir = RunDir::resolve(Some(&dir)).unwrap();
        // `true` 立即退出：不应等满超时。
        let mut child = Command::new("true").spawn().unwrap();
        let started = Instant::now();
        let result = wait_ready(&run_dir, Duration::from_secs(10), &mut child);
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "子进程退出后仍等满了超时"
        );
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wait_ready_times_out_without_daemon() {
        let dir = temp_dir("timeout");
        let run_dir = RunDir::resolve(Some(&dir)).unwrap();
        // 一个还在运行的子进程（sleep），没有任何 socket/token 出现。
        let mut child = Command::new("sleep").arg("5").spawn().unwrap();
        let result = wait_ready(&run_dir, Duration::from_millis(300), &mut child);
        assert!(matches!(result, Err(ref message) if message.contains("超时")));
        let _ = child.kill();
        let _ = child.wait();
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
            assert!(dir.ends_with("agent/run"));
        }
    }
}
