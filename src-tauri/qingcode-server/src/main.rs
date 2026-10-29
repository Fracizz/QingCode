//! `qingcode-server` CLI 入口。
//!
//! SSH 与独立端口入口共用一个二进制（全平台可用；`daemon`/`connect` 在 Unix 用
//! domain socket、Windows 用 named pipe，见 `ipc.rs`）：
//! - `serve`：旧的直连模式。`127.0.0.1` 上一条 TCP 连接承载一次操作，
//!   由主程序现有客户端使用，行为保持不变；
//! - `daemon`：常驻进程，持有 PTY 与监视状态，只监听本地 IPC；
//! - `connect --stdio`：SSH exec 进程里的连接代理，把 stdio 与 IPC 对接；
//! - `direct`：独立 HTTPS/WSS 入口，认证后桥接本地 daemon；
//! - `direct-info`：查看监听信息；仅显式 --include-secret 才输出配对凭据；
//! - `self-check`：安装完整性自检，打印自身二进制的 sha256（可对照期望值）。
//!
//! stdout 保持安静（`connect` 的 stdout 就是数据通道；`self-check` 的
//! stdout 是它的唯一输出，客户端不拿它当数据通道用）：所有诊断输出都走
//! stderr，并用退出码区分原因（参数错误 2、已有同 root 实例在运行 3、
//! 其余启动失败 1）。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use qingcode_server::{bind_server, generate_token, ServerCtx, ServerStateFile, SERVER_VERSION};

// `--detach`（Windows）：serve 再拉起一个脱离副本，stdout/stderr 接到 --log-file，客户端部署路径专用。
const USAGE: &str = "\
用法:
  qingcode-server --version
  qingcode-server serve --root <目录> --state <文件> [--port <端口>] [--detach --log-file <文件>]
  qingcode-server daemon [--state-dir <目录>] [--detach] [--max-ptys <数量>] [--scrollback-bytes <字节>]
                        [--detached-ttl-secs <秒>] [--idle-exit-secs <秒>]
  qingcode-server connect --stdio [--ensure-daemon] [--state-dir <目录>]
  qingcode-server daemon-token [--ensure-daemon] [--state-dir <目录>]
  qingcode-server direct [--detach] [--hostname <IP>] [--port <端口，默认 48763，后续沿用已保存值>] [--state-dir <目录>]\n\
  qingcode-server direct-info [--state-dir <目录>] [--include-secret]\n\
  qingcode-server self-check [--expect-sha256 <hex>]";

/// 已有同 root 实例在运行时的退出码。调用方据此判定「无需再起」，而不是启动失败。
const EXIT_ALREADY_RUNNING: u8 = 3;

/// pid 是否仍存活。Unix 用 `/proc/<pid>` 存在性判定，Windows 通过 `tasklist`
/// 查询；其他平台退化为「无法判定 → 视为未运行」，由后续 bind 失败兜底。
fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        pid > 0 && Path::new("/proc").join(pid.to_string()).exists()
    }
    #[cfg(windows)]
    {
        if pid == 0 {
            return false;
        }
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .ok()
            .is_some_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
            })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

/// 状态文件里是否记录了「同一 root 的存活实例」，返回该实例 pid。
///
/// 单实例锁的意义：两个实例同时服务同一 root 时，后启动的会换端口覆盖
/// `server.json`，先启动的变成孤儿进程，永久占住端口与 inotify 实例。
fn conflicting_instance(state: &Path, root: &Path) -> Option<u32> {
    let payload = std::fs::read(state).ok()?;
    let recorded: ServerStateFile = serde_json::from_slice(&payload).ok()?;
    if !is_pid_alive(recorded.pid) {
        return None;
    }
    // 状态文件里写的是 canonicalize 后的 root；旧文件也再解析一次，
    // 避免部署路径变化（如软链改名）造成误判。
    let recorded_root =
        std::fs::canonicalize(&recorded.root).unwrap_or_else(|_| PathBuf::from(&recorded.root));
    (recorded_root.as_path() == root).then_some(recorded.pid)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("qingcode-server {SERVER_VERSION}");
        return ExitCode::SUCCESS;
    }
    let Some(command) = args.first() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let rest = &args[1..];
    match command.as_str() {
        "serve" => run_serve(rest),
        "direct" => run_direct(rest),
        "direct-info" => run_direct_info(rest),
        "self-check" => run_self_check(rest),
        "daemon" => run_daemon(rest),
        "connect" => run_connect(rest),
        "daemon-token" => run_daemon_token(rest),
        other => {
            eprintln!("未知子命令: {other}\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// `serve`：保持既有行为与退出码，只把参数起点改成切片。
fn run_serve(args: &[String]) -> ExitCode {
    let mut root: Option<PathBuf> = None;
    let mut state: Option<PathBuf> = None;
    let mut port = 0u16;
    let mut detach = false;
    let mut log_file: Option<PathBuf> = None;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        // --detach 是无值开关，单独消费一个参数位。
        if flag == "--detach" {
            detach = true;
            index += 1;
            continue;
        }
        let Some(value) = args.get(index + 1) else {
            eprintln!("参数 {flag} 缺少取值\n{USAGE}");
            return ExitCode::from(2);
        };
        match flag {
            "--root" => root = Some(PathBuf::from(value)),
            "--state" => state = Some(PathBuf::from(value)),
            "--port" => match value.parse::<u16>() {
                Ok(parsed) => port = parsed,
                Err(_) => {
                    eprintln!("端口不是有效的 0-65535 数字: {value}\n{USAGE}");
                    return ExitCode::from(2);
                }
            },
            "--log-file" => log_file = Some(PathBuf::from(value)),
            other => {
                eprintln!("未知参数: {other}\n{USAGE}");
                return ExitCode::from(2);
            }
        }
        index += 2;
    }
    let (Some(root), Some(state)) = (root, state) else {
        eprintln!("缺少必填参数 --root / --state\n{USAGE}");
        return ExitCode::from(2);
    };

    // canonicalize 消除符号链接，供后续所有越界校验使用。
    let Ok(root) = std::fs::canonicalize(&root) else {
        eprintln!("项目根不存在或无法访问: {}", root.display());
        return ExitCode::from(1);
    };
    if !root.is_dir() {
        eprintln!("项目根不是目录: {}", root.display());
        return ExitCode::from(1);
    }

    // --detach（Windows 部署路径）：由 serve 自我再拉起一个脱离副本后立即退出，
    // 客户端不再用 PowerShell P/Invoke 起进程；子进程不带 --detach，走正常前台
    // 流程（单实例锁、状态文件写入都在子进程里完成）。
    if detach {
        #[cfg(windows)]
        {
            return spawn_detached_windows_serve(&root, &state, port, log_file.as_deref());
        }
        #[cfg(not(windows))]
        {
            // unix 客户端部署命令直接用 nohup/setsid 脱离 SSH 会话，--detach 在
            // 这里是 no-op（前台运行，行为与旧版一致），linux musl CI 构建照常编译。
            let _ = log_file;
        }
    }

    // 单实例锁：同 root 已有存活实例时直接按「已运行」退出，且不覆盖状态文件，
    // 否则会顶掉旧实例的端口/token，旧实例变成无人回收的孤儿进程。
    if let Some(pid) = conflicting_instance(&state, &root) {
        eprintln!(
            "已有实例在运行（pid {pid}），本次启动放弃且不覆盖状态文件: {}",
            state.display()
        );
        return ExitCode::from(EXIT_ALREADY_RUNNING);
    }

    let token = generate_token();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("创建异步运行时失败: {e}");
            return ExitCode::from(1);
        }
    };

    let server_root = root.clone();
    let server_token = token.clone();
    let (actual_port, accept) = match runtime.block_on(async move {
        let ctx = std::sync::Arc::new(ServerCtx {
            root: server_root,
            token: server_token,
        });
        bind_server(ctx, port).await
    }) {
        Ok(result) => result,
        Err(e) => {
            eprintln!("绑定 127.0.0.1:{port} 失败: {e}");
            return ExitCode::from(1);
        }
    };

    if let Err(message) = write_state_file(&state, actual_port, &token, &root) {
        eprintln!("{message}");
        return ExitCode::from(1);
    }

    // Ctrl+C 正常退出：select 等待信号或 accept 任务结束（监听器失效），
    // 两者任一发生即收尾。状态文件留给客户端，靠其中的 pid 存活检测感知退出。
    runtime.block_on(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = accept => {}
        }
    });
    ExitCode::SUCCESS
}

/// `serve --detach`（仅 Windows）：再拉起一个脱离当前会话的自身副本后立即退出。
/// stdout/stderr 接到 --log-file，启动失败的诊断（端口占用、单实例 rc=3 等）
/// 都落在这个文件里，脱离会话后仍可排查。`--detach` 与 `--log-file` 不传给
/// 子进程：子进程就是最终的前台 serve。脱离 spawn 的机制与安全约束见
/// `qingcode_server::winproc` 模块注释。
#[cfg(windows)]
fn spawn_detached_windows_serve(
    root: &Path,
    state: &Path,
    port: u16,
    log_path: Option<&Path>,
) -> ExitCode {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_ALWAYS,
    };

    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            eprintln!("定位自身二进制失败: {error}");
            return ExitCode::from(1);
        }
    };

    // 子进程命令行与真实 argv 逐字对应；lpApplicationName 直接给 exe 路径，
    // 不做任何 shell 解析，路径含空格也安全。
    let mut line = format!(
        "{} serve --root {} --state {}",
        qingcode_server::winproc::quote_windows_arg(exe.as_os_str()),
        qingcode_server::winproc::quote_windows_arg(root.as_os_str()),
        qingcode_server::winproc::quote_windows_arg(state.as_os_str()),
    );
    if port != 0 {
        line.push_str(&format!(" --port {port}"));
    }

    // 日志句柄：FILE_APPEND_DATA 追加写，bInheritHandle=1 让它可被继承；
    // 之后 HANDLE_LIST 把继承严格限定到这一个句柄。
    let h_log = match log_path {
        Some(path) => {
            let log_wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: std::ptr::null_mut(),
                bInheritHandle: 1,
            };
            // SAFETY: 常规 CreateFileW；句柄在出错路径释放、成功路径移交子进程。
            let handle = unsafe {
                CreateFileW(
                    log_wide.as_ptr(),
                    FILE_APPEND_DATA,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    &sa,
                    OPEN_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                eprintln!("打开日志文件失败: {}", path.display());
                return ExitCode::from(1);
            }
            Some(handle)
        }
        None => None,
    };

    let spawn = qingcode_server::winproc::DetachedSpawn {
        command_line: line,
        inherit: h_log.iter().copied().collect(),
        stdio_handle: h_log,
    };
    match qingcode_server::winproc::spawn_detached(spawn) {
        Ok(_) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            if let Some(handle) = h_log {
                // SAFETY: h_log 由 CreateFileW 返回且仍有效。
                unsafe { CloseHandle(handle) };
            }
            ExitCode::from(1)
        }
    }
}
/// `self-check`：安装完整性自检。
///
/// 语义：
/// - 无参数：向 stdout 打印 `sha256 <hex>`（自身二进制的小写十六进制摘要），
///   退出码 0；
/// - `--expect-sha256 <hex>`：与自身摘要比对，一致退出 0，不一致退出 1
///   （摘要照常打印，便于客户端在日志里看到实际值）；定位/读取自身失败
///   退出 1；参数错误退出 2。
///
/// noexec 探测依赖一个刻意保持的事实：本子命令不做任何"探测挂载点"的逻辑。
/// 客户端把二进制部署到 `~/.qingcode/server/<version>-<build>/` 后，直接 exec
/// 新目录里的 `qingcode-server self-check`：若该文件系统挂了 noexec，exec 本身
/// 就以 EACCES/ENOEXEC 失败，根本走不到本函数——客户端据此换目录重装；若
/// exec 成功，即证明该路径下的二进制可执行。因此客户端必须先 exec self-check
/// 成功（并校验 sha256 与 manifest 一致），才信任这次安装。
///
/// 比对不区分大小写：manifest.json 统一小写，这里对期望值做小写归一再比较。
fn run_self_check(args: &[String]) -> ExitCode {
    let expected = match parse_self_check_args(args) {
        Ok(expected) => expected,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let actual = match self_exe_sha256() {
        Ok(hex) => hex,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(1);
        }
    };
    println!("sha256 {actual}");
    if let Some(expected) = expected {
        if actual != expected {
            eprintln!("sha256 与期望值不一致: 期望 {expected}");
            return ExitCode::from(1);
        }
    }
    ExitCode::SUCCESS
}

/// 解析 self-check 参数。`--expect-sha256` 的取值必须是 64 位十六进制
/// （大小写均可，归一为小写），提前拒绝明显非法的输入避免客户端拿
/// 错误的期望值误判安装失败。
fn parse_self_check_args(args: &[String]) -> Result<Option<String>, String> {
    let mut expected: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--expect-sha256" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("参数 --expect-sha256 缺少取值".to_string());
                };
                if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(format!(
                        "--expect-sha256 需要 64 位十六进制 sha256，实际为 {value}"
                    ));
                }
                expected = Some(value.to_ascii_lowercase());
                index += 2;
            }
            other => return Err(format!("未知参数: {other}")),
        }
    }
    Ok(expected)
}

/// 自身二进制路径。Linux 优先 `/proc/self/exe`——内核维护的符号链接，
/// 不受 argv[0] 欺骗与当前目录影响；非 Linux unix（macOS 等）没有 /proc，
/// 与 Windows 一样退回 `current_exe()`。
fn self_exe_path() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        let proc_exe = Path::new("/proc/self/exe");
        if proc_exe.exists() {
            return Ok(proc_exe.to_path_buf());
        }
    }
    std::env::current_exe().map_err(|e| format!("定位自身二进制失败: {e}"))
}

/// 计算自身二进制的 sha256（小写十六进制）。
fn self_exe_sha256() -> Result<String, String> {
    let bytes = std::fs::read(self_exe_path()?).map_err(|e| format!("读取自身二进制失败: {e}"))?;
    Ok(sha256_hex(&bytes))
}

/// sha256 的小写十六进制编码。
fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `daemon`：常驻进程。抢不到单实例锁时按成功退出（已有实例在服务）。
/// `--detach`（Windows 部署路径）：再拉起一个脱离副本后立即以 0 退出，
/// 与 `serve --detach` 同机制（unix 上客户端用 nohup/setsid，--detach 是 no-op）。
fn run_daemon(args: &[String]) -> ExitCode {
    let (options, detach) = match parse_daemon_args(args) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if detach {
        #[cfg(windows)]
        {
            return match qingcode_server::winproc::spawn_detached_daemon(
                options.state_dir.as_deref(),
            ) {
                Ok(_) => ExitCode::SUCCESS,
                Err(message) => {
                    eprintln!("{message}");
                    ExitCode::from(1)
                }
            };
        }
        #[cfg(not(windows))]
        {
            // unix 客户端部署命令直接 nohup/setsid 脱离 SSH 会话；--detach
            // 在前台执行（行为与 serve 的 unix 分支一致），linux musl 构建照常编译。
        }
    }
    match qingcode_server::daemon::run(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

/// `connect --stdio`：代理退出即代表本次 SSH 会话结束，不触碰 daemon。
fn run_connect(args: &[String]) -> ExitCode {
    let options = match parse_connect_args(args, true) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match qingcode_server::connect::run_stdio(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

fn parse_daemon_args(
    args: &[String],
) -> Result<(qingcode_server::daemon::DaemonOptions, bool), String> {
    use qingcode_server::daemon::DaemonOptions;

    let mut options = DaemonOptions::default();
    let mut detach = false;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        // --detach 是无值开关，单独消费一个参数位（与 serve 一致）。
        if flag == "--detach" {
            detach = true;
            index += 1;
            continue;
        }
        let Some(value) = args.get(index + 1) else {
            return Err(format!("参数 {flag} 缺少取值"));
        };
        match flag {
            // `--state` 是 serve 的状态文件；daemon 这里收它的目录形式，
            // 两个名字都接受，避免调用方记混。
            "--state-dir" | "--state" => options.state_dir = Some(PathBuf::from(value)),
            "--max-ptys" => options.max_ptys = parse_usize(flag, value)?,
            "--scrollback-bytes" => options.scrollback_bytes = parse_usize(flag, value)?,
            "--pty-buffer-bytes" => options.pty_buffer_bytes = parse_usize(flag, value)?,
            "--detached-ttl-secs" => {
                options.detached_ttl = std::time::Duration::from_secs(parse_u64(flag, value)?)
            }
            "--idle-exit-secs" => {
                options.idle_exit = std::time::Duration::from_secs(parse_u64(flag, value)?)
            }
            other => return Err(format!("未知参数: {other}")),
        }
        index += 2;
    }
    if options.max_ptys == 0 {
        return Err("--max-ptys 必须大于 0".to_string());
    }
    Ok((options, detach))
}

/// `daemon-token`：确保 daemon 在跑并把 token 输出到 stdout（只有 token 一行）。
fn run_daemon_token(args: &[String]) -> ExitCode {
    let options = match parse_connect_args(args, false) {
        Ok(options) => options,
        Err(message) => {
            eprintln!(
                "{message}
{USAGE}"
            );
            return ExitCode::from(2);
        }
    };
    match qingcode_server::connect::ensure_daemon_token(&options) {
        Ok(token) => {
            println!("{token}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

/// `connect` 与 `daemon-token` 共用的参数解析；`require_stdio` 只对 connect 生效。
fn parse_connect_args(
    args: &[String],
    require_stdio: bool,
) -> Result<qingcode_server::connect::ConnectOptions, String> {
    use qingcode_server::connect::ConnectOptions;

    let mut options = ConnectOptions::default();
    let mut stdio = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--stdio" => {
                stdio = true;
                index += 1;
                continue;
            }
            "--ensure-daemon" => {
                options.ensure_daemon = true;
                index += 1;
                continue;
            }
            flag => {
                let Some(value) = args.get(index + 1) else {
                    return Err(format!("参数 {flag} 缺少取值"));
                };
                match flag {
                    "--state-dir" | "--state" => {
                        options.state_dir = Some(PathBuf::from(value));
                    }
                    "--start-timeout-secs" => {
                        options.start_timeout =
                            std::time::Duration::from_secs(parse_u64(flag, value)?);
                    }
                    other => return Err(format!("未知参数: {other}")),
                }
                index += 2;
            }
        }
    }
    if require_stdio && !stdio {
        return Err("connect 需要 --stdio（本期只支持 stdio 代理模式）".to_string());
    }
    Ok(options)
}

fn parse_usize(flag: &str, value: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|_| format!("{flag} 需要非负整数，实际为 {value}"))
}

fn parse_u64(flag: &str, value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{flag} 需要非负整数，实际为 {value}"))
}

/// 写出状态文件供客户端发现端口与 token，失败时进程以非零码退出。
fn write_state_file(state: &Path, port: u16, token: &str, root: &Path) -> Result<(), String> {
    let file = ServerStateFile {
        version: SERVER_VERSION.to_string(),
        port,
        pid: std::process::id(),
        token: token.to_string(),
        root: root.to_string_lossy().into_owned(),
    };
    let payload =
        serde_json::to_vec_pretty(&file).map_err(|e| format!("序列化状态文件失败: {e}"))?;

    // 状态文件含连接 token。Unix 上先以 0600 创建同目录临时文件，写完并
    // fsync 后再 rename，既没有「先写后 chmod」的泄露窗口，也保证读者只会
    // 看到完整 JSON。
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let parent = state
            .parent()
            .ok_or_else(|| format!("状态文件缺少父目录: {}", state.display()))?;
        let file_name = state
            .file_name()
            .ok_or_else(|| format!("状态文件路径无效: {}", state.display()))?
            .to_string_lossy();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let temp = parent.join(format!(".{file_name}.tmp.{}.{nanos}", std::process::id()));
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)?;
            file.write_all(&payload)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temp, state)
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("原子写入状态文件失败: {error}"));
        }
    }
    #[cfg(not(unix))]
    {
        std::fs::write(state, payload).map_err(|e| format!("写入状态文件失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 临时目录：进程 id + 纳秒时间戳保证唯一。
    fn temp_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "qingcode-server-single-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// 只有 unix 的单测会写入完整状态文件（存活判定依赖 /proc）。
    #[cfg(unix)]
    fn write_state(state: &Path, pid: u32, root: &Path) {
        let payload = serde_json::json!({
            "version": SERVER_VERSION,
            "port": 12345,
            "pid": pid,
            "token": "deadbeef",
            "root": root.to_string_lossy(),
        });
        std::fs::write(state, serde_json::to_vec(&payload).unwrap()).unwrap();
    }

    #[test]
    fn missing_state_file_is_not_a_conflict() {
        let root = temp_root("missing");
        let state = root.join("server.json");
        assert_eq!(conflicting_instance(&state, &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unparsable_state_file_is_not_a_conflict() {
        let root = temp_root("garbage");
        let state = root.join("server.json");
        std::fs::write(&state, b"not json").unwrap();
        assert_eq!(conflicting_instance(&state, &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn is_pid_alive_checks_proc_entries() {
        assert!(is_pid_alive(std::process::id()));
        // 几乎不可能存在的 pid：/proc/<pid> 不存在即视为已退出。
        assert!(!is_pid_alive(u32::MAX));
    }

    #[cfg(unix)]
    #[test]
    fn live_instance_for_same_root_is_a_conflict() {
        let root = temp_root("live");
        let state = root.join("server.json");
        write_state(&state, std::process::id(), &root);
        assert_eq!(
            conflicting_instance(&state, &root),
            Some(std::process::id())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn live_instance_for_other_root_is_not_a_conflict() {
        let root = temp_root("other-root");
        let other = temp_root("other-target");
        let state = root.join("server.json");
        write_state(&state, std::process::id(), &other);
        assert_eq!(conflicting_instance(&state, &root), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[cfg(unix)]
    #[test]
    fn stale_instance_is_not_a_conflict() {
        let root = temp_root("stale");
        let state = root.join("server.json");
        // pid 已退出：状态文件是残留，允许接管。
        write_state(&state, u32::MAX, &root);
        assert_eq!(conflicting_instance(&state, &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn write_state_file_is_private_for_create_and_replace() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("private-state");
        let state = root.join("server.json");

        write_state_file(&state, 12345, "fresh-token", &root).unwrap();
        let mode = std::fs::metadata(&state).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "新建状态文件权限不是 0600");
        let payload: ServerStateFile =
            serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
        assert_eq!(payload.token, "fresh-token");

        // 旧版本可能留下 0644 文件；原子替换后也必须恢复 0600。
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_state_file(&state, 12346, "rotated-token", &root).unwrap();
        let mode = std::fs::metadata(&state).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "替换后状态文件权限不是 0600");
        let payload: ServerStateFile =
            serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
        assert_eq!(payload.port, 12346);
        assert_eq!(payload.token, "rotated-token");
        assert!(
            std::fs::read_dir(&root).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp.")),
            "原子写入后残留临时文件"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn daemon_args_parse_and_reject_bad_values() {
        let args = vec![
            "--state-dir".to_string(),
            "/tmp/run".to_string(),
            "--max-ptys".to_string(),
            "8".to_string(),
            "--scrollback-bytes".to_string(),
            "4096".to_string(),
            "--detached-ttl-secs".to_string(),
            "60".to_string(),
        ];
        let (options, detach) = parse_daemon_args(&args).unwrap();
        assert!(!detach);
        assert_eq!(options.state_dir, Some(PathBuf::from("/tmp/run")));
        assert_eq!(options.max_ptys, 8);
        assert_eq!(options.scrollback_bytes, 4096);
        assert_eq!(options.detached_ttl, std::time::Duration::from_secs(60));
        // --detach 是无值开关；unix 上仍前台执行（由外部 nohup/setsid 脱离）。
        let (_, detach) = parse_daemon_args(&["--detach".to_string()]).unwrap();
        assert!(detach);

        assert!(parse_daemon_args(&["--max-ptys".to_string(), "0".to_string()]).is_err());
        assert!(parse_daemon_args(&["--max-ptys".to_string(), "abc".to_string()]).is_err());
        assert!(parse_daemon_args(&["--bogus".to_string(), "1".to_string()]).is_err());
        assert!(parse_daemon_args(&["--max-ptys".to_string()]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn connect_args_require_stdio() {
        assert!(parse_connect_args(&["--ensure-daemon".to_string()], true).is_err());
        let options = parse_connect_args(
            &[
                "--stdio".to_string(),
                "--ensure-daemon".to_string(),
                "--state-dir".to_string(),
                "/tmp/run".to_string(),
            ],
            true,
        )
        .unwrap();
        assert!(options.ensure_daemon);
        assert_eq!(options.state_dir, Some(PathBuf::from("/tmp/run")));
        assert_eq!(options.start_timeout, std::time::Duration::from_secs(10));
        assert!(parse_connect_args(&["--stdio".to_string(), "--nope".to_string()], true).is_err());
    }

    #[test]
    fn daemon_token_args_do_not_require_stdio() {
        let options = parse_connect_args(&["--ensure-daemon".to_string()], false).unwrap();
        assert!(options.ensure_daemon);
        assert!(parse_connect_args(&["--nope".to_string()], false).is_err());
    }

    #[test]
    fn sha256_hex_matches_known_vectors() {
        // FIPS 180-4 标准向量：空串与 "abc"。
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn self_exe_sha256_is_stable_and_hash_of_current_exe() {
        let first = self_exe_sha256().unwrap();
        assert_eq!(first.len(), 64);
        assert!(
            first.bytes().all(|b| b.is_ascii_hexdigit()) && first == first.to_lowercase(),
            "摘要必须是 64 位小写十六进制: {first}"
        );
        // 两次计算一致（排除读到不完整/变化的文件）。
        assert_eq!(self_exe_sha256().unwrap(), first);
        // 与 current_exe 内容的独立哈希一致，排除读错文件的回归。
        let raw = sha256_hex(&std::fs::read(std::env::current_exe().unwrap()).unwrap());
        assert_eq!(first, raw);
    }

    #[test]
    fn self_check_expect_mismatch_exits_1_and_match_exits_0() {
        let actual = self_exe_sha256().unwrap();
        // 全 0 期望值：几乎不可能与真实摘要一致 → 退出 1。
        assert_eq!(
            run_self_check(&["--expect-sha256".to_string(), "0".repeat(64)]),
            ExitCode::from(1)
        );
        // 大写期望值应归一后判定一致（manifest 统一小写，但客户端容错）。
        assert_eq!(
            run_self_check(&["--expect-sha256".to_string(), actual.to_uppercase()]),
            ExitCode::SUCCESS
        );
        // 无参数：仅打印摘要，成功退出。
        assert_eq!(run_self_check(&[]), ExitCode::SUCCESS);
        // 参数错误走 2。
        assert_eq!(run_self_check(&["--bogus".to_string()]), ExitCode::from(2));
        assert_eq!(
            run_self_check(&["--expect-sha256".to_string()]),
            ExitCode::from(2)
        );
    }

    #[test]
    fn self_check_args_reject_bad_hex() {
        assert_eq!(parse_self_check_args(&[]).unwrap(), None);
        assert!(parse_self_check_args(&["--expect-sha256".to_string(), "zz".to_string()]).is_err());
        assert!(
            parse_self_check_args(&["--expect-sha256".to_string(), "a".repeat(63)]).is_err(),
            "63 位 hex 必须被拒绝"
        );
        assert_eq!(
            parse_self_check_args(&["--expect-sha256".to_string(), "A".repeat(64)]).unwrap(),
            Some("a".repeat(64))
        );
    }
}

fn parse_direct_args(args: &[String]) -> Result<qingcode_server::direct::DirectOptions, String> {
    let mut options = qingcode_server::direct::DirectOptions::default();
    let mut index = 0;
    while index < args.len() {
        let flag = &args[index];
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("参数 {flag} 缺少取值"))?;
        match flag.as_str() {
            "--hostname" => options.hostname = value.clone(),
            "--port" => {
                options.port = value.parse().map_err(|_| "端口必须是 1-65535 的数字")?;
                if options.port == 0 {
                    return Err("端口必须是 1-65535 的数字".into());
                }
            }
            "--state-dir" => options.state_dir = Some(value.into()),
            _ => return Err(format!("未知直连参数: {flag}")),
        }
        index += 2;
    }
    Ok(options)
}

fn run_direct(args: &[String]) -> ExitCode {
    let detach = args.iter().any(|value| value == "--detach");
    let rest = args
        .iter()
        .filter(|value| value.as_str() != "--detach")
        .cloned()
        .collect::<Vec<_>>();
    let options = match parse_direct_args(&rest) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    if detach {
        return run_direct_detached(options);
    }
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("无法启动直连运行时: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(async {
        let gateway = qingcode_server::direct::Gateway::bind(options).await?;
        println!(
            "{}",
            serde_json::to_string(&gateway.info).map_err(|e| e.to_string())?
        );
        gateway.run().await
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run_direct_info(args: &[String]) -> ExitCode {
    let include_secret = args.iter().any(|value| value == "--include-secret");
    let rest = args
        .iter()
        .filter(|value| value.as_str() != "--include-secret")
        .cloned()
        .collect::<Vec<_>>();
    if !(rest.is_empty() || (rest.len() == 2 && rest[0] == "--state-dir")) {
        eprintln!("direct-info 只支持 --state-dir 和 --include-secret");
        return ExitCode::from(2);
    }
    let options = match parse_direct_args(&rest) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    match qingcode_server::direct::info(options.state_dir.as_deref(), include_secret) {
        Ok(value) => {
            println!("{}", serde_json::to_string(&value).unwrap());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run_direct_detached(options: qingcode_server::direct::DirectOptions) -> ExitCode {
    let result = (|| -> Result<qingcode_server::direct::DirectInfo, String> {
        if let Ok(info) = qingcode_server::direct::info(options.state_dir.as_deref(), false) {
            if qingcode_server::direct::process_alive(info.pid) {
                if options.port == 0 || options.port == info.port {
                    return Ok(info);
                }
                return Err(format!(
                    "直连服务仍监听端口 {}；请先停止旧直连服务，再修改端口",
                    info.port
                ));
            }
        }
        #[cfg(windows)]
        let child = qingcode_server::winproc::spawn_detached_direct(
            &options.hostname,
            options.port,
            options.state_dir.as_deref(),
        )?;
        #[cfg(unix)]
        let mut child = {
            use std::os::unix::process::CommandExt;
            use std::process::{Command, Stdio};
            let run = qingcode_server::daemon::RunDir::resolve(options.state_dir.as_deref())?;
            let dir = run.dir().join("direct");
            qingcode_server::direct::protect_private_directory(&dir)?;
            let log = qingcode_server::diagnostics::stderr_file(&dir.join("gateway.log"))
                .map_err(|e| format!("打开直连日志失败: {e}"))?;
            let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
            command
                .arg("direct")
                .arg("--hostname")
                .arg(&options.hostname)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
                .stderr(Stdio::from(log));
            if options.port != 0 {
                command.arg("--port").arg(options.port.to_string());
            }
            if let Some(dir) = &options.state_dir {
                command.arg("--state-dir").arg(dir);
            }
            // SAFETY: setsid is async-signal-safe and does not access Rust state.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            command
                .spawn()
                .map_err(|e| format!("启动直连服务失败: {e}"))?
        };
        let pid = child.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if let Ok(info) = qingcode_server::direct::info(options.state_dir.as_deref(), false) {
                if info.pid == pid {
                    return Ok(info);
                }
            }
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("直连服务启动失败；请检查端口占用和运行目录 direct/gateway.log".into());
            }
            if std::time::Instant::now() >= deadline {
                return Err("等待直连服务监听超时；请检查 direct/gateway.log".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    })();
    match result {
        Ok(info) => {
            println!("{}", serde_json::to_string(&info).unwrap());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod direct_cli_tests {
    use super::*;
    #[test]
    fn direct_port_requires_explicit_valid_port_and_preserves_saved_default() {
        assert_eq!(parse_direct_args(&[]).unwrap().port, 0);
        assert_eq!(qingcode_server::direct::DEFAULT_DIRECT_PORT, 48763);
        assert!(parse_direct_args(&["--port".into(), "0".into()]).is_err());
        assert!(parse_direct_args(&["--port".into(), "65536".into()]).is_err());
        assert_eq!(
            parse_direct_args(&["--port".into(), "51234".into()])
                .unwrap()
                .port,
            51234
        );
    }
}
