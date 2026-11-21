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
//!
//! 运行目录按构建区分（`hosts/<版本-大小-修改时间>`）：宿主常驻且托管的终端会被接回，
//! 若各版本共用一个宿主，升级后新开的终端仍跑在旧代码里（例如旧宿主用系统 conhost，
//! pi 全屏收不到鼠标上报，滚轮变成方向键）。现在新终端一律进当前构建的宿主；旧宿主
//! （含早期共用的 `run/`）只负责接回、结束它自己的终端，终端全部结束后按空闲超时退出。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use qingcode_server::connect::{ensure_daemon_token, ConnectOptions};
use qingcode_server::daemon::{DaemonOptions, RunDir};
use qingcode_server::ipc::IpcEndpoint;

/// 本机托管终端在前端标签上的连接标识，须与 `LOCAL_TERMINAL_CONNECTION_ID` 一致。
pub(crate) const LOCAL_CONNECTION_ID: &str = "__local__";

const HOST_EXE_STEM: &str = "qingcode-pty-host";
const HOST_START_TIMEOUT: Duration = Duration::from_secs(15);
/// 其他构建的运行目录无人使用超过这么久才清理，避免误删另一个构建正在启动的宿主。
const STALE_RUN_DIR_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// 目前只在 Windows 启用；其他平台的新建请求回退到进程内 PTY。
pub(crate) const HOST_SUPPORTED: bool = cfg!(windows);

/// 同时恢复多个标签时只拉起一次宿主，避免 token 轮换期间读到旧值。
static ENSURE_LOCK: Mutex<()> = Mutex::new(());

/// 本进程拉起的宿主仍在调用方作业对象里、会随 QingCode 一起结束（如 `pnpm tauri:dev`
/// 下 cargo 的作业且无法以 Shell 为父进程脱离）。宿主是之前的实例拉起、本进程直接
/// 连上的，说明它已经活过了上一个实例，保持 false。
static HOST_TIED_TO_APP: AtomicBool = AtomicBool::new(false);

/// 退出时托管终端能否活过 QingCode：宿主会被连带结束时为 false。
pub(crate) fn host_survives_app_exit() -> bool {
    !HOST_TIED_TO_APP.load(Ordering::SeqCst)
}

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

/// 早期所有版本共用的运行目录，只用于接回其中仍在运行的旧宿主。
fn shared_legacy_run_dir() -> PathBuf {
    base_dir().join("run")
}

fn hosts_dir() -> PathBuf {
    base_dir().join("hosts")
}

/// 当前构建：宿主副本与运行目录都以 `stamp` 命名。进程内只算一次，
/// 运行期间程序文件被覆盖也不会把同一进程的终端分到两个宿主。
struct CurrentBuild {
    source: PathBuf,
    len: u64,
    stamp: String,
}

fn current_build() -> Result<&'static CurrentBuild, String> {
    static BUILD: OnceLock<Result<CurrentBuild, String>> = OnceLock::new();
    BUILD
        .get_or_init(|| {
            let source =
                std::env::current_exe().map_err(|e| format!("定位 QingCode 程序失败: {e}"))?;
            let metadata =
                std::fs::metadata(&source).map_err(|e| format!("读取程序信息失败: {e}"))?;
            let modified_secs = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |elapsed| elapsed.as_secs());
            let len = metadata.len();
            Ok(CurrentBuild {
                stamp: copy_stamp(env!("CARGO_PKG_VERSION"), len, modified_secs),
                source,
                len,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// 其他构建可能仍有宿主在运行的目录：早期共用的 `run/` 与 `hosts/` 下的其他构建。
fn other_run_dirs(hosts: &Path, shared_legacy: &Path, current_stamp: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if shared_legacy.is_dir() {
        dirs.push(shared_legacy.to_path_buf());
    }
    if let Ok(entries) = std::fs::read_dir(hosts) {
        let mut others: Vec<PathBuf> = entries
            .flatten()
            .filter(|entry| entry.file_name() != current_stamp)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        others.sort();
        dirs.extend(others);
    }
    dirs
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
        pty_inherited_env_exclusions: crate::terminal::AGENT_INJECTED_ENV,
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
fn prepare_host_executable(build: &CurrentBuild) -> Result<PathBuf, String> {
    let bin_root = base_dir().join("bin");
    let dir = bin_root.join(&build.stamp);
    let target = dir.join(format!("{HOST_EXE_STEM}.exe"));
    let current = std::fs::metadata(&target).is_ok_and(|meta| meta.len() == build.len);
    if !current {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建宿主目录失败: {e}"))?;
        let temp = dir.join(format!(".{HOST_EXE_STEM}.{}.tmp", std::process::id()));
        std::fs::copy(&build.source, &temp).map_err(|e| format!("复制宿主程序失败: {e}"))?;
        std::fs::rename(&temp, &target).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            format!("落盘宿主程序失败: {e}")
        })?;
    }
    if let Ok(entries) = std::fs::read_dir(&bin_root) {
        for entry in entries.flatten() {
            if entry.file_name() != build.stamp.as_str() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(target)
}

fn probe_options(state_dir: &Path) -> ConnectOptions {
    ConnectOptions {
        state_dir: Some(state_dir.to_path_buf()),
        ensure_daemon: false,
        ..Default::default()
    }
}

fn access_for(state_dir: &Path, token: String) -> Result<LocalHostAccess, String> {
    let run_dir = RunDir::resolve(Some(state_dir))?;
    Ok(LocalHostAccess {
        endpoint: IpcEndpoint::new(run_dir.dir()),
        token,
    })
}

/// 目录及其直接子项里最新的修改时间（宿主日志、token 轮换都会刷新）。
fn last_activity(dir: &Path) -> Option<SystemTime> {
    let own = std::fs::metadata(dir)
        .and_then(|meta| meta.modified())
        .ok()?;
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.metadata().and_then(|meta| meta.modified()).ok())
        .chain(std::iter::once(own))
        .max()
}

/// 清理 `hosts/` 下早已无人使用的其他构建运行目录；仍在运行或近期活动过的保留。
fn prune_stale_run_dirs(current_stamp: &str) {
    let Ok(entries) = std::fs::read_dir(hosts_dir()) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name() == current_stamp || !path.is_dir() {
            continue;
        }
        let stale = last_activity(&path)
            .and_then(|time| now.duration_since(time).ok())
            .is_some_and(|age| age >= STALE_RUN_DIR_AGE);
        if stale && ensure_daemon_token(&probe_options(&path)).is_err() {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// 其他构建仍在运行的宿主（只探测、不拉起），供接回、结束它们托管的旧终端。
/// 阻塞调用，须放到阻塞线程池。
pub(crate) fn running_other_hosts() -> Vec<LocalHostAccess> {
    if !HOST_SUPPORTED {
        return Vec::new();
    }
    let Ok(build) = current_build() else {
        return Vec::new();
    };
    running_hosts_in(other_run_dirs(
        &hosts_dir(),
        &shared_legacy_run_dir(),
        &build.stamp,
    ))
}

/// 只保留宿主仍在监听的运行目录；已退出的目录不会被拉起。
fn running_hosts_in(dirs: Vec<PathBuf>) -> Vec<LocalHostAccess> {
    dirs.into_iter()
        .filter_map(|dir| {
            let token = ensure_daemon_token(&probe_options(&dir)).ok()?;
            access_for(&dir, token).ok()
        })
        .collect()
}

/// 确保当前构建的宿主在运行并返回连接凭据。阻塞调用，须放到阻塞线程池。
pub(crate) fn ensure_running() -> Result<LocalHostAccess, String> {
    if !HOST_SUPPORTED {
        return Err("当前平台暂不支持本地终端持久化".to_string());
    }
    let _guard = ENSURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let build = current_build()?;
    let state_dir = hosts_dir().join(&build.stamp);
    let token = match ensure_daemon_token(&probe_options(&state_dir)) {
        Ok(token) => token,
        // 宿主未运行才需要副本，已在运行时不做任何文件操作。
        Err(_) => {
            let token = ensure_daemon_token(&ConnectOptions {
                state_dir: Some(state_dir.clone()),
                ensure_daemon: true,
                start_timeout: HOST_START_TIMEOUT,
                daemon_program: Some(prepare_host_executable(build)?),
                escape_caller_job: true,
            })?;
            HOST_TIED_TO_APP.store(host_spawn_tied_to_app(), Ordering::SeqCst);
            prune_stale_run_dirs(&build.stamp);
            token
        }
    };
    access_for(&state_dir, token)
}

#[cfg(windows)]
fn host_spawn_tied_to_app() -> bool {
    qingcode_server::winproc::last_daemon_tied_to_caller_job()
}

#[cfg(not(windows))]
fn host_spawn_tied_to_app() -> bool {
    false
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
    fn other_run_dirs_lists_shared_legacy_and_other_builds_only() {
        let base = tempfile::tempdir().unwrap();
        let hosts = base.path().join("hosts");
        let shared = base.path().join("run");
        assert!(other_run_dirs(&hosts, &shared, "cur").is_empty());

        for name in ["cur", "old-b", "old-a"] {
            std::fs::create_dir_all(hosts.join(name)).unwrap();
        }
        std::fs::write(hosts.join("stray-file"), b"").unwrap();
        std::fs::create_dir_all(&shared).unwrap();
        assert_eq!(
            other_run_dirs(&hosts, &shared, "cur"),
            vec![shared.clone(), hosts.join("old-a"), hosts.join("old-b")]
        );
    }

    #[test]
    fn last_activity_tracks_the_newest_entry() {
        let dir = tempfile::tempdir().unwrap();
        let before = last_activity(dir.path()).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.path().join("server.log"), b"x").unwrap();
        assert!(last_activity(dir.path()).unwrap() >= before);
        assert!(last_activity(&dir.path().join("missing")).is_none());
    }

    /// 真实 daemon：其他构建的宿主仍在运行时能被探测到并给出有效 token，
    /// 已退出的运行目录只被跳过，不会被重新拉起。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn running_hosts_in_finds_live_hosts_without_spawning_dead_ones() {
        let base = tempfile::tempdir().unwrap();
        let live = base.path().join("hosts").join("old-build");
        let dead = base.path().join("run");
        std::fs::create_dir_all(&dead).unwrap();
        let run_dir = RunDir::resolve(Some(&live)).unwrap();
        let options = DaemonOptions {
            state_dir: Some(live.clone()),
            ..Default::default()
        };
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let daemon = tokio::spawn(async move {
            tokio::select! {
                _ = qingcode_server::daemon::run_async(options) => {}
                _ = stopped => {}
            }
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let dirs = vec![dead.clone(), live.clone()];
            let found = tokio::task::spawn_blocking(move || running_hosts_in(dirs))
                .await
                .unwrap();
            // 监听先于 token 轮换：等探测结果与磁盘上的新 token 一致。
            if let [access] = found.as_slice() {
                if run_dir.read_token().ok().as_deref() == Some(access.token.as_str()) {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "未探测到运行中的宿主");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !dead.join("pipe").exists(),
            "已退出的运行目录不应被拉起宿主"
        );
        let _ = stop.send(());
        let _ = daemon.await;
    }

    #[test]
    fn copy_stamp_changes_when_the_build_changes() {
        let base = copy_stamp("1.0.0", 100, 200);
        assert_ne!(base, copy_stamp("1.0.1", 100, 200));
        assert_ne!(base, copy_stamp("1.0.0", 101, 200));
        assert_ne!(base, copy_stamp("1.0.0", 100, 201));
    }
}
