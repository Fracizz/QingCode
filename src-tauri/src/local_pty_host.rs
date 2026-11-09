//! 本机 PTY 宿主：让本地交互式终端活在 QingCode 进程之外，应用重启后可接回。
//!
//! 宿主就是 `qingcode-server` 的 daemon（命名管道 + token，只放行当前用户），
//! 运行体是当前 QingCode.exe 的版本化副本：
//!
//! - 不直接跑安装目录里的 exe，否则宿主运行期间安装包无法覆盖它；
//! - 不单独打包一个二进制，便携版和安装版行为一致；
//! - 进程名是 `qingcode-pty-host.exe`，任务管理器里能和主程序区分开。
//!
//! 运行目录与 SSH 远端 daemon 的 `~/.qingcode/server/run` 分开，用户 SSH 回本机时
//! 两者互不影响；开发构建落在 `.dev` 下，不会连上已安装版本的宿主。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use qingcode_server::connect::{ensure_daemon_token, ConnectOptions};
use qingcode_server::daemon::{DaemonOptions, RunDir};
use qingcode_server::ipc::IpcEndpoint;

/// 本机托管终端在前端标签上的连接标识，须与 `LOCAL_TERMINAL_CONNECTION_ID` 一致。
pub(crate) const LOCAL_CONNECTION_ID: &str = "__local__";

const HOST_EXE_STEM: &str = "qingcode-pty-host";
const HOST_START_TIMEOUT: Duration = Duration::from_secs(15);

/// 目前只在 Windows 启用；其他平台的新建请求回退到进程内 PTY。
pub(crate) const HOST_SUPPORTED: bool = cfg!(windows);

/// 同时恢复多个标签时只拉起一次宿主，避免 token 轮换期间读到旧值。
static ENSURE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) struct LocalHostAccess {
    pub(crate) endpoint: IpcEndpoint,
    pub(crate) token: String,
}

fn base_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        crate::app_paths::app_data_dir().join("pty-host")
    } else {
        // 用 Local 而不是 Roaming：副本有几十 MB，不应参与漫游配置同步。
        dirs::data_local_dir()
            .unwrap_or_else(crate::app_paths::app_data_dir)
            .join("com.qingcode.app")
            .join("pty-host")
    }
}

fn run_dir_path() -> PathBuf {
    base_dir().join("run")
}

/// 副本目录名：同版本重新编译（开发期）也要换副本，所以带上大小与修改时间。
fn copy_stamp(version: &str, len: u64, modified_secs: u64) -> String {
    format!("{version}-{len:x}-{modified_secs:x}")
}

fn is_host_executable(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case(HOST_EXE_STEM))
}

/// 从 argv 解析宿主入口；只接受 `daemon --state-dir <dir>` 的精确形式。
fn parse_host_args(args: &[String]) -> Option<PathBuf> {
    match args {
        [_, command, flag, dir] if command == "daemon" && flag == "--state-dir" => {
            Some(PathBuf::from(dir))
        }
        _ => None,
    }
}

/// 进程入口：当前可执行文件是宿主副本时跑 daemon 并返回退出码。
pub fn try_run_host() -> Option<i32> {
    let exe = std::env::current_exe().ok()?;
    if !is_host_executable(&exe) {
        return None;
    }
    let argv: Vec<String> = std::env::args().collect();
    let state_dir = parse_host_args(&argv)?;
    let options = DaemonOptions {
        state_dir: Some(state_dir),
        ..Default::default()
    };
    Some(match qingcode_server::daemon::run(options) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    })
}

/// 把当前 exe 复制成宿主副本，并尽力清理旧版本的副本（仍在运行的会因占用而跳过）。
fn prepare_host_executable() -> Result<PathBuf, String> {
    let source = std::env::current_exe().map_err(|e| format!("定位 QingCode 程序失败: {e}"))?;
    let metadata = std::fs::metadata(&source).map_err(|e| format!("读取程序信息失败: {e}"))?;
    let modified_secs = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_secs());
    let bin_root = base_dir().join("bin");
    let stamp = copy_stamp(env!("CARGO_PKG_VERSION"), metadata.len(), modified_secs);
    let dir = bin_root.join(&stamp);
    let target = dir.join(format!("{HOST_EXE_STEM}.exe"));
    let current = std::fs::metadata(&target).is_ok_and(|meta| meta.len() == metadata.len());
    if !current {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建宿主目录失败: {e}"))?;
        let temp = dir.join(format!(".{HOST_EXE_STEM}.{}.tmp", std::process::id()));
        std::fs::copy(&source, &temp).map_err(|e| format!("复制宿主程序失败: {e}"))?;
        std::fs::rename(&temp, &target).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            format!("落盘宿主程序失败: {e}")
        })?;
    }
    if let Ok(entries) = std::fs::read_dir(&bin_root) {
        for entry in entries.flatten() {
            if entry.file_name() != stamp.as_str() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(target)
}

/// 确保宿主在运行并返回连接凭据。阻塞调用，须放到阻塞线程池。
pub(crate) fn ensure_running() -> Result<LocalHostAccess, String> {
    if !HOST_SUPPORTED {
        return Err("当前平台暂不支持本地终端持久化".to_string());
    }
    let _guard = ENSURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state_dir = run_dir_path();
    let probe = ConnectOptions {
        state_dir: Some(state_dir.clone()),
        ensure_daemon: false,
        ..Default::default()
    };
    let token = match ensure_daemon_token(&probe) {
        Ok(token) => token,
        // 宿主未运行才需要副本，已在运行时不做任何文件操作。
        Err(_) => ensure_daemon_token(&ConnectOptions {
            state_dir: Some(state_dir.clone()),
            ensure_daemon: true,
            start_timeout: HOST_START_TIMEOUT,
            daemon_program: Some(prepare_host_executable()?),
        })?,
    };
    let run_dir = RunDir::resolve(Some(&state_dir))?;
    Ok(LocalHostAccess {
        endpoint: IpcEndpoint::new(run_dir.dir()),
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn host_entry_only_accepts_exact_daemon_arguments() {
        assert_eq!(
            parse_host_args(&argv(&["host.exe", "daemon", "--state-dir", "C:\\run"])),
            Some(PathBuf::from("C:\\run"))
        );
        assert_eq!(parse_host_args(&argv(&["host.exe", "daemon"])), None);
        assert_eq!(
            parse_host_args(&argv(&["host.exe", "serve", "--state-dir", "C:\\run"])),
            None
        );
        assert_eq!(
            parse_host_args(&argv(&[
                "host.exe",
                "daemon",
                "--state-dir",
                "C:\\run",
                "--detach"
            ])),
            None
        );
    }

    #[test]
    fn only_the_host_copy_runs_as_daemon() {
        assert!(is_host_executable(Path::new(
            r"C:\data\bin\qingcode-pty-host.exe"
        )));
        assert!(!is_host_executable(Path::new(r"C:\apps\QingCode.exe")));
    }

    #[test]
    fn copy_stamp_changes_when_the_build_changes() {
        let base = copy_stamp("1.0.0", 100, 200);
        assert_ne!(base, copy_stamp("1.0.1", 100, 200));
        assert_ne!(base, copy_stamp("1.0.0", 101, 200));
        assert_ne!(base, copy_stamp("1.0.0", 100, 201));
    }
}
