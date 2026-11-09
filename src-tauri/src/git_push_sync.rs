//! 「Git 多端同步」的桌面端入口（独立功能，移除清单见 docs/git-push-sync.md）。
//!
//! 只提供事件源和固定的 Git 操作；是否同步、同步给谁全部由前端模块决定。

use crate::git_command;
use crate::path_guard::PathAllowlist;
use crate::remote_ssh::{self, SshManager};
use qingcode_server::git_push_watch::{watch_pushes, PushEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const PUSHED_EVENT: &str = "git-push-sync:pushed";
const STATE_EVENT: &str = "git-push-sync:state";
const SSH_PREFIX: &str = "ssh://";
const FETCH_LIMIT: Duration = Duration::from_secs(60);
const MERGE_LIMIT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DetectionState {
    Live,
    Waiting,
    PanelOnly,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushedPayload<'a> {
    project_path: &'a str,
    #[serde(flatten)]
    event: PushEvent,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload<'a> {
    project_path: &'a str,
    state: DetectionState,
    detail: Option<String>,
}

pub(crate) fn emit_pushed(app: &AppHandle, project_path: &str, event: PushEvent) {
    let _ = app.emit(
        PUSHED_EVENT,
        PushedPayload {
            project_path,
            event,
        },
    );
}

pub(crate) fn emit_state(
    app: &AppHandle,
    project_path: &str,
    state: DetectionState,
    detail: Option<String>,
) {
    let _ = app.emit(
        STATE_EVENT,
        StatePayload {
            project_path,
            state,
            detail,
        },
    );
}

struct WatchHandle {
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct GitPushSyncManager {
    watches: Mutex<HashMap<String, WatchHandle>>,
}

fn spawn_local_watch(
    app: AppHandle,
    path: String,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        emit_state(&app, &path, DetectionState::Live, None);
        let result = watch_pushes(Path::new(&path), None, &cancelled, |event| {
            emit_pushed(&app, &path, event);
            true
        });
        if let Err(message) = result {
            emit_state(&app, &path, DetectionState::PanelOnly, Some(message));
        }
        finished.store(true, Ordering::Release);
    });
}

/// 用完整目标列表替换监听集合；已结束的监听会重新启动。
#[tauri::command]
pub async fn git_push_sync_set_watches(
    paths: Vec<String>,
    app: AppHandle,
    manager: State<'_, GitPushSyncManager>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    let mut watches = manager
        .watches
        .lock()
        .map_err(|_| "推送监听状态不可用".to_string())?;
    watches.retain(|path, handle| {
        let keep = paths.contains(path) && !handle.finished.load(Ordering::Acquire);
        if !keep {
            handle.cancelled.store(true, Ordering::Release);
        }
        keep
    });
    for path in paths {
        if watches.contains_key(&path) {
            continue;
        }
        let is_remote = path.starts_with(SSH_PREFIX);
        if !is_remote {
            if let Err(message) = allowlist.ensure_allowed(&path) {
                emit_state(&app, &path, DetectionState::PanelOnly, Some(message));
                continue;
            }
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        if is_remote {
            remote_ssh::git_push_sync::spawn_watch(
                app.clone(),
                path.clone(),
                Arc::clone(&cancelled),
                Arc::clone(&finished),
            );
        } else {
            spawn_local_watch(
                app.clone(),
                path.clone(),
                Arc::clone(&cancelled),
                Arc::clone(&finished),
            );
        }
        watches.insert(
            path,
            WatchHandle {
                cancelled,
                finished,
            },
        );
    }
    Ok(())
}

/// 上游名来自 Git 状态，仍按命令参数校验，防止被解析成选项或修订表达式。
fn validate_upstream(upstream: &str) -> Result<(), String> {
    let invalid = upstream.is_empty()
        || upstream.starts_with('-')
        || upstream.contains("..")
        || upstream.contains("@{")
        || upstream
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || "~^:?*[\\".contains(ch));
    if invalid {
        return Err("无效的上游分支名".to_string());
    }
    Ok(())
}

/// 运行不会弹出凭据提示的 Git 命令，超时后结束进程。
fn run_local_git(root: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut command = git_command::command(root, args);
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法运行 Git：{error}"))?;
    let read_pipe = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).trim().to_string()
        })
    };
    let stdout = read_pipe(child.stdout.take().map(|p| Box::new(p) as _));
    let stderr = read_pipe(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(format!("等待 Git 失败：{error}")),
        }
    };
    // 超时后不等待读取线程：git-remote-* 等子进程可能仍持有管道。
    let Some(status) = status else {
        return Err("后台 Git 命令超时".to_string());
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else if stderr.is_empty() {
        Err(stdout)
    } else {
        Err(stderr)
    }
}

async fn run_git(
    path: String,
    args: Vec<String>,
    limit: Duration,
    ssh: &SshManager,
    allowlist: &PathAllowlist,
) -> Result<String, String> {
    if path.starts_with(SSH_PREFIX) {
        return remote_ssh::git_push_sync::run_git(ssh, &path, args, limit).await;
    }
    allowlist.ensure_allowed(&path)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        run_local_git(&root, &args, limit)
    })
    .await
    .map_err(|error| format!("后台 Git 任务失败：{error}"))?
}

#[tauri::command]
pub async fn git_push_sync_fetch(
    path: String,
    ssh: State<'_, SshManager>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    let args = vec!["fetch".to_string(), "--prune".to_string()];
    run_git(path, args, FETCH_LIMIT, &ssh, &allowlist)
        .await
        .map(|_| ())
}

/// 只允许快进：有分叉或本地改动会被覆盖时，Git 拒绝且不修改工作区。
#[tauri::command]
pub async fn git_push_sync_merge_ff(
    path: String,
    upstream: String,
    ssh: State<'_, SshManager>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    validate_upstream(&upstream)?;
    let args = vec!["merge".to_string(), "--ff-only".to_string(), upstream];
    run_git(path, args, MERGE_LIMIT, &ssh, &allowlist)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_forward_updates_clone_and_refuses_divergence() {
        fn git(dir: &Path, args: &[&str]) -> String {
            let output = git_command::output(dir, args).unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        fn commit(dir: &Path, message: &str) {
            git(
                dir,
                &[
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@example.com",
                    "commit",
                    "--allow-empty",
                    "-m",
                    message,
                ],
            );
        }
        let limit = Duration::from_secs(30);
        let base = std::env::temp_dir().join(format!(
            "qc-push-sync-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (remote, a, b) = (base.join("r.git"), base.join("a"), base.join("b"));
        for dir in [&remote, &a] {
            std::fs::create_dir_all(dir).unwrap();
        }
        git(&remote, &["init", "--bare", "-b", "main"]);
        git(&a, &["init", "-b", "main"]);
        git(&a, &["remote", "add", "origin", &remote.to_string_lossy()]);
        commit(&a, "one");
        git(&a, &["push", "-u", "origin", "main"]);
        git(
            &base,
            &["clone", &remote.to_string_lossy(), &b.to_string_lossy()],
        );

        commit(&a, "two");
        git(&a, &["push"]);
        run_local_git(&b, &["fetch", "--prune"], limit).unwrap();
        run_local_git(&b, &["merge", "--ff-only", "origin/main"], limit).unwrap();
        assert_eq!(
            git(&a, &["rev-parse", "HEAD"]),
            git(&b, &["rev-parse", "HEAD"])
        );

        commit(&b, "local");
        commit(&a, "three");
        git(&a, &["push"]);
        let before = git(&b, &["rev-parse", "HEAD"]);
        run_local_git(&b, &["fetch", "--prune"], limit).unwrap();
        assert!(run_local_git(&b, &["merge", "--ff-only", "origin/main"], limit).is_err());
        assert_eq!(git(&b, &["rev-parse", "HEAD"]), before);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn validate_upstream_accepts_tracking_names() {
        assert!(validate_upstream("origin/test").is_ok());
        assert!(validate_upstream("origin/feat/a-b_c.1").is_ok());
    }

    #[test]
    fn validate_upstream_rejects_options_and_revision_syntax() {
        for value in [
            "",
            "--abort",
            "origin/a..b",
            "HEAD@{1}",
            "a b",
            "a~1",
            "a^",
            "a:b",
        ] {
            assert!(validate_upstream(value).is_err(), "{value}");
        }
    }

    #[test]
    fn run_local_git_kills_command_after_limit() {
        let root = std::env::temp_dir();
        let started = Instant::now();
        let result = run_local_git(
            &root,
            &["-c", "alias.w=!sleep 5", "w"],
            Duration::from_millis(200),
        );
        assert_eq!(result.unwrap_err(), "后台 Git 命令超时");
        // alias 的子进程仍持有管道，超时返回不能等待它结束。
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}
