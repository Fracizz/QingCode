//! `qingcode-agent` CLI 入口。
//!
//! stdout 保持安静：客户端靠轮询状态文件发现端口，任何常规输出都可能
//! 干扰链路。错误一律走 stderr 并用非零退出码收尾
//! （参数错误 2、已有同 root 实例在运行 3、其余启动失败 1）。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use qingcode_agent::{bind_server, generate_token, AgentStateFile, ServerCtx, AGENT_VERSION};

const USAGE: &str =
    "用法: qingcode-agent (--version | serve --root <目录> --state <文件> [--port <端口>])";

/// 已有同 root 实例在运行时的退出码。调用方据此判定「无需再起」，而不是启动失败。
const EXIT_ALREADY_RUNNING: u8 = 3;

/// pid 是否仍存活。代理只跑在 Linux 远端，用 `/proc/<pid>` 存在性判定（无新依赖）；
/// 其他平台没有便宜的等价手段，退化为「无法判定 → 视为未运行」，
/// 由后续 bind 失败兜底。
fn is_pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        pid > 0 && Path::new("/proc").join(pid.to_string()).exists()
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// 状态文件里是否记录了「同一 root 的存活实例」，返回该实例 pid。
///
/// 单实例锁的意义：两个实例同时服务同一 root 时，后启动的会换端口覆盖
/// `agent.json`，先启动的变成孤儿进程，永久占住端口与 inotify 实例。
fn conflicting_instance(state: &Path, root: &Path) -> Option<u32> {
    let payload = std::fs::read(state).ok()?;
    let recorded: AgentStateFile = serde_json::from_slice(&payload).ok()?;
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
        println!("qingcode-agent {AGENT_VERSION}");
        return ExitCode::SUCCESS;
    }
    let Some(command) = args.first() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    if command != "serve" {
        eprintln!("未知子命令: {command}\n{USAGE}");
        return ExitCode::from(2);
    }

    let mut root: Option<PathBuf> = None;
    let mut state: Option<PathBuf> = None;
    let mut port = 0u16;
    let mut index = 1;
    while index < args.len() {
        let flag = args[index].as_str();
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

/// 写出状态文件供客户端发现端口与 token，失败时进程以非零码退出。
fn write_state_file(state: &Path, port: u16, token: &str, root: &Path) -> Result<(), String> {
    let file = AgentStateFile {
        version: AGENT_VERSION.to_string(),
        port,
        pid: std::process::id(),
        token: token.to_string(),
        root: root.to_string_lossy().into_owned(),
    };
    let payload =
        serde_json::to_vec_pretty(&file).map_err(|e| format!("序列化状态文件失败: {e}"))?;
    std::fs::write(state, payload).map_err(|e| format!("写入状态文件失败: {e}"))?;
    // 状态文件含连接 token，远端部署时收紧到仅属主可读写。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(state, std::fs::Permissions::from_mode(0o600));
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
            "qingcode-agent-single-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// 只有 unix 的单测会写入完整状态文件（存活判定依赖 /proc）。
    #[cfg(unix)]
    fn write_state(state: &Path, pid: u32, root: &Path) {
        let payload = serde_json::json!({
            "version": AGENT_VERSION,
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
        let state = root.join("agent.json");
        assert_eq!(conflicting_instance(&state, &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unparsable_state_file_is_not_a_conflict() {
        let root = temp_root("garbage");
        let state = root.join("agent.json");
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
        let state = root.join("agent.json");
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
        let state = root.join("agent.json");
        write_state(&state, std::process::id(), &other);
        assert_eq!(conflicting_instance(&state, &root), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[cfg(unix)]
    #[test]
    fn stale_instance_is_not_a_conflict() {
        let root = temp_root("stale");
        let state = root.join("agent.json");
        // pid 已退出：状态文件是残留，允许接管。
        write_state(&state, u32::MAX, &root);
        assert_eq!(conflicting_instance(&state, &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
