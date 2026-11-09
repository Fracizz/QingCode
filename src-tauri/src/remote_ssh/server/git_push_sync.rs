//! 「Git 多端同步」的 SSH 通道：订阅远端 reflog 推送事件，执行后台 Git 命令。
//! 只使用已就绪的 daemon，不触发部署或连接；移除清单见 docs/git-push-sync.md。

use super::daemon::{daemon_rpc, open_daemon_channel, DaemonCallError};
use super::watch::watch_retry_delay;
use super::*;
use crate::git_push_sync::{emit_pushed, emit_state, DetectionState};
use qingcode_server::proto::{self, Event, Kind};
use std::sync::atomic::{AtomicBool, Ordering};

/// 连接或 daemon 尚未就绪时的本机状态复查间隔，不产生任何网络请求。
const NOT_READY_RECHECK: Duration = Duration::from_secs(5);
const SESSION_RESTART_DELAY: Duration = Duration::from_secs(2);
const CANCEL_CHECK: Duration = Duration::from_secs(1);
/// daemon 每 15 秒发一次心跳，3 个周期没有帧就认为连接已失效。
const FRAME_TIMEOUT: Duration = Duration::from_secs(45);

enum Readiness {
    Ready {
        connection_id: String,
        root: RegisteredRoot,
        daemon: DaemonAccess,
    },
    /// 暂时不可用：连接断开或 daemon 还没准备好。
    Waiting,
    /// 当前连接方式没有可订阅的远端进程。
    Unsupported(&'static str),
}

fn readiness(manager: &SshManager, uri: &str) -> Readiness {
    let Ok(parsed) = parse_remote_uri(uri) else {
        return Readiness::Unsupported("无效的远程路径");
    };
    let connection_id = parsed.connection_id;
    if !manager.connection_is_open(&connection_id) {
        return Readiness::Waiting;
    }
    let Ok(root) = manager.registered_root(uri) else {
        return Readiness::Waiting;
    };
    if !root.trusted {
        return Readiness::Waiting;
    }
    if manager.direct_config(&connection_id).is_some() {
        return Readiness::Unsupported("端口直连不支持监听推送");
    }
    if !manager.root_server_mode(&root) {
        return Readiness::Unsupported("兼容模式没有远端服务");
    }
    let key = server_slot_key(&connection_id, &root.canonical_path);
    let daemon = manager
        .server_slot(&key)
        .and_then(|slot| slot.endpoint)
        .and_then(|endpoint| endpoint.daemon);
    match daemon {
        Some(daemon) => Readiness::Ready {
            connection_id,
            root,
            daemon,
        },
        None => Readiness::Waiting,
    }
}

async fn sleep_unless_cancelled(duration: Duration, cancelled: &AtomicBool) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline && !cancelled.load(Ordering::Acquire) {
        tokio::time::sleep(CANCEL_CHECK.min(duration)).await;
    }
}

async fn watch_session(
    app: &AppHandle,
    manager: &SshManager,
    uri: &str,
    target: (&str, &RegisteredRoot, &DaemonAccess),
    since: &mut Option<i64>,
    cancelled: &AtomicBool,
) -> Result<(), DaemonCallError> {
    let (connection_id, root, daemon) = target;
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let params = serde_json::json!({ "root": root.canonical_path, "since": *since });
        let response = daemon_rpc(
            &mut channel,
            "git.watchPush",
            &params,
            Instant::now() + AGENT_PING_TIMEOUT,
        )
        .await?;
        if response
            .get("subscribed")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(DaemonCallError::Remote("daemon 未受理推送监听".to_string()));
        }
        if since.is_none() {
            *since = response.get("now").and_then(serde_json::Value::as_i64);
        }
        emit_state(app, uri, DetectionState::Live, None);
        loop {
            let mut next = Box::pin(channel.next_watch_frame(FRAME_TIMEOUT));
            let frame = loop {
                if cancelled.load(Ordering::Acquire) {
                    return Ok(());
                }
                match tokio::time::timeout(CANCEL_CHECK, &mut next).await {
                    Err(_) => continue,
                    Ok(Ok(frame)) => break frame,
                    Ok(Err(_)) => return Ok(()),
                }
            };
            drop(next);
            match frame.kind {
                Kind::Event => {
                    if let Ok(Event::GitPush(push)) = proto::decode_value::<Event>(&frame.payload) {
                        *since = Some(push.at);
                        emit_pushed(app, uri, push);
                    }
                }
                Kind::StreamEnd | Kind::Err => return Ok(()),
                _ => {}
            }
        }
    }
    .await;
    channel.shutdown().await;
    result
}

/// 监听一个远程项目，直到取消或确认当前连接不支持。
pub(crate) fn spawn_watch(
    app: AppHandle,
    uri: String,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let mut since = None;
        let mut failures = 0u32;
        while !cancelled.load(Ordering::Acquire) {
            let manager = app.state::<SshManager>();
            let (connection_id, root, daemon) = match readiness(&manager, &uri) {
                Readiness::Ready {
                    connection_id,
                    root,
                    daemon,
                } => (connection_id, root, daemon),
                Readiness::Waiting => {
                    emit_state(&app, &uri, DetectionState::Waiting, None);
                    sleep_unless_cancelled(NOT_READY_RECHECK, &cancelled).await;
                    continue;
                }
                Readiness::Unsupported(reason) => {
                    emit_state(&app, &uri, DetectionState::PanelOnly, Some(reason.into()));
                    break;
                }
            };
            let target = (connection_id.as_str(), &root, &daemon);
            match watch_session(&app, &manager, &uri, target, &mut since, &cancelled).await {
                Ok(()) => {
                    failures = 0;
                    sleep_unless_cancelled(SESSION_RESTART_DELAY, &cancelled).await;
                }
                // 旧版 Server 没有此方法，或仓库不支持：等下次同步监听列表时再试。
                Err(DaemonCallError::Remote(message)) => {
                    emit_state(&app, &uri, DetectionState::PanelOnly, Some(message));
                    break;
                }
                Err(DaemonCallError::Transport(_)) => {
                    failures = failures.saturating_add(1);
                    emit_state(&app, &uri, DetectionState::Waiting, None);
                    sleep_unless_cancelled(watch_retry_delay(failures), &cancelled).await;
                }
            }
        }
        finished.store(true, Ordering::Release);
    });
}

/// 在远程项目中运行后台 Git 命令；时限独立于普通 fetch 的 15 分钟上限。
pub(crate) async fn run_git(
    manager: &SshManager,
    uri: &str,
    args: Vec<String>,
    limit: Duration,
) -> Result<String, String> {
    let output = tokio::time::timeout(limit, remote_git_command(manager, uri, args, true))
        .await
        .map_err(|_| "后台 Git 命令超时".to_string())??;
    if output.exit_code == 0 {
        return Ok(output.stdout.trim().to_string());
    }
    let stderr = output.stderr.trim();
    Err(if stderr.is_empty() {
        output.stdout.trim().to_string()
    } else {
        stderr.to_string()
    })
}
