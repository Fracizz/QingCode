//! watch 监督任务：保活 daemon / serve 两条远端 watch 连接，把事件转成
//! `fs-change` 发给前端；断链自动重连，退避与退出条件见各常量注释。

use super::daemon::{daemon_rpc, open_daemon_channel, DaemonCallError};
use super::serve::open_server_channel;
use super::*;
use qingcode_server::proto::{self, Event, Kind};
use qingcode_server::{read_frame, write_frame, ServerOp, ServerRequest, ServerResponse};
use std::sync::atomic::{AtomicBool, Ordering};

/// watch 通道异常断开后重启前的间隔。
const AGENT_WATCH_RESTART_DELAY: Duration = Duration::from_secs(2);
/// endpoint 未就绪或主连接中断时的重试间隔表（秒），对齐 VS Code Remote 的重连节奏：
/// 断开后第一次重连立即进行（循环里不先睡），失败后依次等 5、5、10…秒，
/// 此后固定 30 秒。监督任务不再因连续失败退出：此前连续 3 次失败（约 15 秒）
/// 就永久退出，断网稍久 watch 就再也回不来，只能手动重连项目。
const AGENT_WATCH_RETRY_SCHEDULE: [u64; 8] = [5, 5, 10, 10, 10, 10, 10, 30];

/// 第 `failures` 次连续失败后的等待时长（`failures` 从 1 起算）。
pub(crate) fn watch_retry_delay(failures: u32) -> Duration {
    let index = (failures.max(1) as usize - 1).min(AGENT_WATCH_RETRY_SCHEDULE.len() - 1);
    Duration::from_secs(AGENT_WATCH_RETRY_SCHEDULE[index])
}
/// watch 空闲轮询间隔：没有事件时定期回来检查会话存活与总开关。
const AGENT_WATCH_IDLE_POLL: Duration = Duration::from_secs(5);
/// watch 读帧超时：超过这个时间没收到任何帧就判定连接已死并重连。
///
/// 服务端每 15s 发一个心跳帧，45s 正好是 3 个心跳周期——既给慢网络留出
/// 抖动余量，又能在连接半死（TCP 未断开但不再有数据）时及时发现。超时只
/// 触发重连，不向前端发任何事件，避免空闲仓库被误判成变更。
const AGENT_WATCH_FRAME_TIMEOUT: Duration = Duration::from_secs(45);

/// Windows 远端的 watch 事件路径来自远端 notify：典型形态是 verbatim
/// （`\\?\C:\dir\file`，canonicalize 的返回值被 notify 原样拼进事件）或原生
/// 反斜杠；而注册根是 URI 形态（`/C:/dir`）。归一成与 canonical_root 同构的
/// 形态后再做过滤与 URI 转换，否则 Windows 项目的事件会在 URI 转换处被静默
/// 丢弃（表现为文件树自动刷新失效）。Linux 路径原样返回——反斜杠在 Linux
/// 文件名里合法，不可改写。归一是幂等的，可对已归一路径重复调用。
pub(crate) fn normalize_watch_event_path(path: &str, windows: bool) -> String {
    if !windows {
        return path.to_string();
    }
    let text = path.strip_prefix(r"\\?\").unwrap_or(path);
    let text = match text.strip_prefix(r"UNC\") {
        Some(rest) => format!("//{rest}"),
        None => text.to_string(),
    };
    let unified = text.replace('\\', "/");
    if unified.starts_with('/') || unified.is_empty() {
        unified
    } else if unified.as_bytes().get(1) == Some(&b':') {
        // `C:/dir` → `/C:/dir`，与注册根的 URI 形态对齐。
        format!("/{unified}")
    } else {
        unified
    }
}

fn watch_event_paths_are_windows(canonical_root: &str) -> bool {
    windows_native_path(canonical_root).is_some()
}

fn watch_root_is_active(
    manager: &SshManager,
    root: &RegisteredRoot,
    cancelled: &AtomicBool,
) -> bool {
    !cancelled.load(Ordering::Acquire)
        && manager.root_server_mode(root)
        && manager
            .registered_root(&root.uri)
            .is_ok_and(|current| current.trusted && current.canonical_path == root.canonical_path)
}

/// watch 事件过滤：跳过 server 自身部署目录、终端粘贴临时目录与自写临时文件，
/// 防止客户端自己的写操作触发前端刷新循环。
pub(crate) fn should_skip_server_watch_event(abs_path: &str, canonical_root: &str) -> bool {
    let abs_path =
        normalize_watch_event_path(abs_path, watch_event_paths_are_windows(canonical_root));
    let root = canonical_root.trim_end_matches('/');
    let rel = abs_path.strip_prefix(root).unwrap_or(&abs_path);
    let segments: Vec<&str> = rel
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    for window in segments.windows(2) {
        if window[0] == ".qingcode" && (window[1] == "server" || window[1] == "terminal-paste") {
            return true;
        }
    }
    segments
        .last()
        .is_some_and(|name| name.ends_with(".tmp") || name.ends_with(".backup"))
}

/// 按分段边界剥掉根前缀，返回剩余部分（可为空）。不在根内返回 None。
/// Windows 路径大小写不敏感：用户可能以小写盘符打开项目，而远端
/// canonicalize 返回的盘符大小写与之相反，按字节比较会把真实项目内的事件
/// 误判为越界。
fn strip_root_prefix<'a>(abs: &'a str, root: &str, windows: bool) -> Option<&'a str> {
    if windows {
        if abs.len() < root.len() {
            return None;
        }
        let (head, rest) = abs.split_at(root.len());
        head.eq_ignore_ascii_case(root).then_some(rest)
    } else {
        abs.strip_prefix(root)
    }
}

/// 把 watch 事件的远端绝对路径转成资源 URI。
///
/// 基址必须用注册时的 `root_uri`（用户打开项目时给的路径），而不是 canonical
/// 路径：用户以符号链接路径打开项目时，前端按 `root_uri` 前缀做
/// `findProjectForPath` 匹配，用 canonical 路径拼出来的 URI 会匹配不上，
/// 表现为自动刷新静默失效。相对路径取自 canonical_root，因此两者都能自洽。
///
/// Windows 远端的事件路径先经 [`normalize_watch_event_path`] 归一（verbatim
/// 前缀与反斜杠）。路径必须词法上落在 canonical_root 内（按 '/' 分段边界），
/// 越界返回 None。
pub(crate) fn ssh_uri_for_watch_event(
    root_uri: &str,
    canonical_root: &str,
    abs: &str,
) -> Option<String> {
    let windows = watch_event_paths_are_windows(canonical_root);
    let abs = normalize_watch_event_path(abs, windows);
    let abs = abs.trim_end_matches('/');
    let root = canonical_root.trim_end_matches('/');
    if abs.is_empty() || !abs.starts_with('/') {
        return None;
    }
    // 根自身（或文件系统根）没有相对路径，直接返回注册 URI。
    let rel = if root.is_empty() {
        abs.trim_start_matches('/')
    } else {
        match strip_root_prefix(abs, root, windows)? {
            "" => "",
            // 必须先剥掉完整的根再加 '/', 否则 /srv/app2 会被当成 /srv/app 的子路径。
            rest => rest.strip_prefix('/')?,
        }
    };
    if rel.is_empty() {
        return Some(normalize_remote_uri(root_uri));
    }
    Some(join_remote_uri(root_uri, rel))
}

/// daemon 通道上的 watch 会话：订阅受理后循环接收 EVENT 推送并转成
/// `fs-change` 事件发给前端，直到会话失效、远端 watcher 结束或 server 被关闭。
/// 返回 Err 仅代表订阅建立失败（通道/握手/RES 阶段），调用方据此降级 serve；
/// 会话中途结束（读帧超时、通道关闭、连接断开）一律返回 Ok，由监督任务的下一轮
/// 重连决定传输——此前中途错误也会冒泡成 Err，网络一抖就把 daemon 降级 5 分钟。
pub(crate) async fn daemon_watch_session(
    app: &tauri::AppHandle,
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    canonical_root: &str,
    daemon: &DaemonAccess,
    cancelled: &AtomicBool,
) -> Result<(), DaemonCallError> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let params = serde_json::json!({ "root": root.canonical_path });
        let response = daemon_rpc(
            &mut channel,
            "watch.subscribe",
            &params,
            Instant::now() + AGENT_PING_TIMEOUT,
        )
        .await?;
        if response
            .get("subscribed")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(DaemonCallError::Remote(
                "daemon watch 订阅未被受理".to_string(),
            ));
        }
        // RES 只表示订阅受理；空闲时 daemon 每 15s 发一次 PING，
        // `next_frame` 自动回 PONG，使连接在无变更的仓库上也能保活。
        loop {
            if !watch_root_is_active(manager, root, cancelled) {
                return Ok(());
            }
            let mut next = Box::pin(channel.next_watch_frame(AGENT_WATCH_FRAME_TIMEOUT));
            let frame = loop {
                if !watch_root_is_active(manager, root, cancelled) {
                    return Ok(());
                }
                match tokio::time::timeout(AGENT_WATCH_IDLE_POLL, &mut next).await {
                    Err(_) => continue,
                    Ok(Ok(frame)) => break frame,
                    Ok(Err(_)) => return Ok(()),
                }
            };
            drop(next);
            match frame.kind {
                Kind::Event => {
                    let Ok(event) = proto::decode_value::<Event>(&frame.payload) else {
                        // 无法解析的事件（新版本新增种类）直接跳过。
                        continue;
                    };
                    let Event::FsChange { path, kind, is_dir } = event else {
                        continue;
                    };
                    emit_server_fs_change(app, &root.uri, canonical_root, &path, &kind, is_dir);
                }
                // STREAM_END / ERR：远端 watcher 结束（如根被删除），按断链重连。
                Kind::StreamEnd | Kind::Err => return Ok(()),
                _ => {}
            }
        }
    }
    .await;
    channel.shutdown().await;
    result
}

/// 把一条远端 watch 事件转成 ssh:// URI 并发给前端；serve 与 daemon 两条
/// watch 路径共用，保证过滤规则与 URI 语义一致。
fn emit_server_fs_change(
    app: &tauri::AppHandle,
    root_uri: &str,
    canonical_root: &str,
    path: &str,
    kind: &str,
    is_dir: bool,
) {
    if should_skip_server_watch_event(path, canonical_root) {
        return;
    }
    let Some(uri) = ssh_uri_for_watch_event(root_uri, canonical_root, path) else {
        return;
    };
    // 前端按 ssh:// URI 识别远程资源，与文件树节点一致。
    let _ = app.emit(
        "fs-change",
        crate::file_watcher::FsChangePayload {
            path: uri,
            kind: kind.to_string(),
            is_dir,
        },
    );
}

/// watch 监督任务：保活一条远端 watch 连接，把事件转成 `fs-change` 事件发给前端。
///
/// 连接断开后自动重连（复用新会话）；server 被禁用、连接移除、根注销或明确
/// 不可用时任务退出。通道失败只影响 watch 本身，不触发终端重连逻辑。
pub(crate) fn spawn_server_watch_supervisor(
    app: tauri::AppHandle,
    connection_id: String,
    root_uri: String,
    canonical_root: String,
) -> tauri::async_runtime::JoinHandle<()> {
    let key = server_slot_key(&connection_id, &canonical_root);
    let cancelled = app.state::<SshManager>().begin_watch_supervisor(&key);
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures = 0u32;
        loop {
            if cancelled.load(Ordering::Acquire) {
                break;
            }
            let manager = app.state::<SshManager>();
            if !manager.connection_is_open(&connection_id)
                || !manager.root_is_registered(&root_uri).unwrap_or(false)
            {
                server_status::publish_disconnected(&app, &manager, &connection_id, &root_uri);
                break;
            }
            let Ok(root) = manager.registered_root(&root_uri) else {
                server_status::publish_disconnected(&app, &manager, &connection_id, &root_uri);
                break;
            };
            if !root.trusted || !manager.server_mode(&connection_id) {
                server_status::publish_root_state(&app, &manager, &root);
                break;
            }
            let key = server_slot_key(&connection_id, &root.canonical_path);
            // 主连接已断开（保活超时、远端断开）：先主动重连，不动 slot——远端
            // serve/daemon 进程不随 SSH 连接退出，重连后端点照样可用，免去整轮
            // 重新发现。断开期间芯片显示「已断开」及原因。
            if !manager.connection_is_open(&connection_id) {
                server_status::publish_root_state(&app, &manager, &root);
                if manager
                    .ensure_connection_alive(&connection_id)
                    .await
                    .is_err()
                {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    tokio::time::sleep(watch_retry_delay(consecutive_failures)).await;
                    continue;
                }
                server_status::publish_root_state(&app, &manager, &root);
            }
            let mut endpoint =
                match ensure_server_endpoint_with_app(&manager, &root, Some(&app)).await {
                    Ok(Some(endpoint)) => {
                        consecutive_failures = 0;
                        endpoint
                    }
                    Ok(None) => {
                        // 有明确不可用原因（架构不支持 / 没有二进制）就不再空转。
                        if manager
                            .server_slot(&key)
                            .and_then(|slot| slot.unavailable_reason)
                            .is_some()
                        {
                            break;
                        }
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        tokio::time::sleep(watch_retry_delay(consecutive_failures)).await;
                        continue;
                    }
                    Err(_) => {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        tokio::time::sleep(watch_retry_delay(consecutive_failures)).await;
                        continue;
                    }
                };
            // daemon 传输优先：exec 通道内订阅，RES 受理后收 EVENT 推送。
            // 订阅建立失败只降级 daemon 标记（保留 serve 端点），serve 继续兜底。
            if let Some(daemon) = endpoint.daemon.clone() {
                match daemon_watch_session(
                    &app,
                    &manager,
                    &connection_id,
                    &root,
                    &canonical_root,
                    &daemon,
                    &cancelled,
                )
                .await
                {
                    Ok(()) => {
                        tokio::time::sleep(AGENT_WATCH_RESTART_DELAY).await;
                        continue;
                    }
                    // 连接本身断了不是 daemon 的错：回到循环顶部重连，保留 daemon 标记。
                    Err(_) if !manager.connection_is_open(&connection_id) => continue,
                    // Root permission/watch limits do not invalidate a healthy
                    // user daemon shared by unrelated projects.
                    Err(error) if !error.is_transport() => {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        tokio::time::sleep(watch_retry_delay(consecutive_failures)).await;
                        continue;
                    }
                    Err(_) => {
                        downgrade_server_daemon(&manager, &key, &daemon);
                        server_status::publish_root_state(&app, &manager, &root);
                    }
                }
            }
            if endpoint.serve.is_none() {
                match require_serve_endpoint(&app, &manager, &root).await {
                    Ok(fallback) => endpoint = fallback,
                    Err(_) => {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        tokio::time::sleep(watch_retry_delay(consecutive_failures)).await;
                        continue;
                    }
                }
            }
            // serve 回退：打开 watch 连接；失败休眠后重试（下一轮会重新校验退出条件）。
            let stream = async {
                let serve = endpoint.serve.as_ref().ok_or("项目 serve 尚未启动")?;
                let channel = open_server_channel(&manager, &connection_id, serve.port).await?;
                let mut stream = channel.into_stream();
                let request = ServerRequest {
                    token: serve.token.clone(),
                    op: ServerOp::Watch {
                        // "." 表示代理根（即注册的项目根）。
                        path: ".".to_string(),
                    },
                };
                let payload = serde_json::to_vec(&request)
                    .map_err(|error| format!("编码 server 请求失败：{error}"))?;
                write_frame(&mut stream, &payload)
                    .await
                    .map_err(|error| format!("发送 server 请求失败：{error}"))?;
                Ok::<_, String>(stream)
            }
            .await;
            let mut stream = match stream {
                Ok(stream) => stream,
                // 同上：连接断开时端点未必失效，不清缓存，重连后直接复用。
                Err(_) if !manager.connection_is_open(&connection_id) => continue,
                Err(_) => {
                    // 端点可能已随远端进程消失（端口/token 失效）：清掉缓存，
                    // 下一轮重新走发现/部署，否则会一直对着死端口空转。
                    manager.clear_server_endpoint(&key);
                    server_status::publish_root_state(&app, &manager, &root);
                    tokio::time::sleep(AGENT_WATCH_RESTART_DELAY).await;
                    continue;
                }
            };
            // 读循环：空闲时每 5s 醒一次检查会话与开关，帧读取 future 跨轮保留，
            // 轮询不会丢半帧，也不会因为长时间没有事件而白白重连。
            'watch: loop {
                let mut frame = Box::pin(read_frame(&mut stream));
                // 每个帧重新计时：从"上一帧到达"起算 AGENT_WATCH_FRAME_TIMEOUT。
                let deadline = Instant::now() + AGENT_WATCH_FRAME_TIMEOUT;
                let bytes = loop {
                    if !watch_root_is_active(&manager, &root, &cancelled) {
                        break 'watch;
                    }
                    if Instant::now() >= deadline {
                        // 心跳缺席：连接半死。只重连，不 emit 任何事件。
                        break 'watch;
                    }
                    // 后台 daemon 探测已通过：断开 serve watch，下一轮改走 daemon。
                    if manager
                        .server_slot(&key)
                        .and_then(|slot| slot.endpoint)
                        .is_some_and(|endpoint| endpoint.daemon.is_some())
                    {
                        break 'watch;
                    }
                    match tokio::time::timeout(AGENT_WATCH_IDLE_POLL, &mut frame).await {
                        Err(_) => continue,
                        Ok(Ok(bytes)) => break bytes,
                        // 通道断开（远端进程退出 / 连接失效）：重开 watch。
                        Ok(Err(_)) => break 'watch,
                    }
                };
                // 无法解析的帧（如 server 新加的心跳帧）直接忽略并继续读下一帧：
                // 帧是长度前缀切好的，跳过不会破坏后续解析；若因此断开重连，
                // 心跳反而会变成周期性重连，回到本次修复要消除的问题。
                let Ok(response) = serde_json::from_slice::<ServerResponse>(&bytes) else {
                    continue 'watch;
                };
                match response {
                    ServerResponse::Records { data } => {
                        for event in &data {
                            let Some(path) = event.get("path").and_then(|value| value.as_str())
                            else {
                                continue;
                            };
                            let kind = event
                                .get("kind")
                                .and_then(|value| value.as_str())
                                .unwrap_or("any");
                            let is_dir = event
                                .get("isDir")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false);
                            emit_server_fs_change(
                                &app,
                                &root.uri,
                                &canonical_root,
                                path,
                                kind,
                                is_dir,
                            );
                        }
                    }
                    ServerResponse::Error { .. } => break 'watch,
                    _ => {}
                }
            }
            // 丢弃流关闭通道，远端 watcher 随连接收尾。
            drop(stream);
            tokio::time::sleep(AGENT_WATCH_RESTART_DELAY).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_retry_delay_backs_off_and_caps() {
        assert_eq!(watch_retry_delay(1), Duration::from_secs(5));
        assert_eq!(watch_retry_delay(2), Duration::from_secs(5));
        assert_eq!(watch_retry_delay(3), Duration::from_secs(10));
        assert_eq!(watch_retry_delay(7), Duration::from_secs(10));
        // 表尾之后固定 30 秒，也不会溢出。
        assert_eq!(watch_retry_delay(8), Duration::from_secs(30));
        assert_eq!(watch_retry_delay(u32::MAX), Duration::from_secs(30));
        // 0 视同第一次失败。
        assert_eq!(watch_retry_delay(0), Duration::from_secs(5));
    }

    #[test]
    fn watch_event_filter_skips_server_and_temp_files() {
        let root = "/srv/app";
        // server 部署目录与其子树
        assert!(should_skip_server_watch_event(
            "/srv/app/.qingcode/server/server.json",
            root
        ));
        assert!(should_skip_server_watch_event(
            "/srv/app/.qingcode/server/qingcode-server-x86_64",
            root
        ));
        // 终端粘贴临时目录
        assert!(should_skip_server_watch_event(
            "/srv/app/.qingcode/terminal-paste/paste.txt",
            root
        ));
        // 自写临时文件
        assert!(should_skip_server_watch_event("/srv/app/main.rs.tmp", root));
        assert!(should_skip_server_watch_event("/srv/app/a.rs.backup", root));
        // 正常源码不受影响
        assert!(!should_skip_server_watch_event(
            "/srv/app/src/main.rs",
            root
        ));
        // 子目录里的同名 .qingcode 不属于部署目录
        assert!(!should_skip_server_watch_event(
            "/srv/app/docs/.qingcode/server.md",
            root
        ));
    }

    #[test]
    fn watch_uri_uses_registered_root_and_stays_within_canonical_root() {
        // 用户用符号链接路径打开项目：URI 必须以注册路径为基。
        let root_uri = "ssh://c1/home/user/app-link";
        let canonical = "/srv/app";
        assert_eq!(
            ssh_uri_for_watch_event(root_uri, canonical, "/srv/app/src/main.rs").as_deref(),
            Some("ssh://c1/home/user/app-link/src/main.rs")
        );
        // 根自身：直接用注册 URI，不追加空段。
        assert_eq!(
            ssh_uri_for_watch_event(root_uri, "/srv/app/", "/srv/app").as_deref(),
            Some("ssh://c1/home/user/app-link")
        );
        // 前缀相似但不在根内。
        assert!(ssh_uri_for_watch_event(root_uri, canonical, "/srv/app2/x").is_none());
        assert!(ssh_uri_for_watch_event(root_uri, canonical, "/etc/passwd").is_none());
        assert!(ssh_uri_for_watch_event(root_uri, canonical, "").is_none());
        assert!(ssh_uri_for_watch_event(root_uri, canonical, "relative/path").is_none());
        // 文件系统根作为项目根时不产生双斜杠。
        assert_eq!(
            ssh_uri_for_watch_event("ssh://c1/", "/", "/srv/x").as_deref(),
            Some("ssh://c1/srv/x")
        );
    }

    #[test]
    fn watch_uri_accepts_windows_verbatim_event_paths() {
        // Windows 真机实测的事件形态：notify 把 canonicalize 的 verbatim 根
        // 原样拼进事件，路径形如 `\\?\C:\...` 且用反斜杠；注册根是 URI 形态。
        let root_uri = "ssh://c1/C:/Users/Administrator/qc-e2e-win/project";
        let canonical = "/C:/Users/Administrator/qc-e2e-win/project";
        assert_eq!(
            ssh_uri_for_watch_event(
                root_uri,
                canonical,
                r"\\?\C:\Users\Administrator\qc-e2e-win\project\newfile-5052.txt"
            )
            .as_deref(),
            Some("ssh://c1/C:/Users/Administrator/qc-e2e-win/project/newfile-5052.txt")
        );
        // 非 verbatim 的原生反斜杠同样归一。
        assert_eq!(
            ssh_uri_for_watch_event(
                root_uri,
                canonical,
                r"C:\Users\Administrator\qc-e2e-win\project\src\main.rs"
            )
            .as_deref(),
            Some("ssh://c1/C:/Users/Administrator/qc-e2e-win/project/src/main.rs")
        );
        // 已归一的路径幂等。
        assert_eq!(
            ssh_uri_for_watch_event(
                root_uri,
                canonical,
                "/C:/Users/Administrator/qc-e2e-win/project/a.txt"
            )
            .as_deref(),
            Some("ssh://c1/C:/Users/Administrator/qc-e2e-win/project/a.txt")
        );
        // 盘符大小写与注册根相反（用户以小写盘符打开）不丢事件。
        assert_eq!(
            ssh_uri_for_watch_event(
                "ssh://c1/c:/Users/Administrator/qc-e2e-win/project",
                "/c:/Users/Administrator/qc-e2e-win/project",
                r"\\?\C:\Users\Administrator\qc-e2e-win\project\late.txt"
            )
            .as_deref(),
            Some("ssh://c1/c:/Users/Administrator/qc-e2e-win/project/late.txt")
        );
        // Windows 下越界依旧拒绝（含前缀相似目录）。
        assert!(
            ssh_uri_for_watch_event(root_uri, canonical, r"\\?\C:\Windows\notepad.exe").is_none()
        );
        assert!(ssh_uri_for_watch_event(
            root_uri,
            canonical,
            r"\\?\C:\Users\Administrator\qc-e2e-win\project2\x"
        )
        .is_none());
        // Linux 远端路径不受 Windows 归一影响（反斜杠是合法文件名字符）。
        assert_eq!(
            ssh_uri_for_watch_event("ssh://c1/srv/app", "/srv/app", r"/srv/app/a\b.txt").as_deref(),
            Some("ssh://c1/srv/app/a\\b.txt")
        );
    }

    #[test]
    fn watch_event_filter_skips_server_dir_on_windows_paths() {
        // 归一后的 Windows 事件路径同样命中部署目录与临时文件过滤。
        let root = "/C:/Users/Administrator/app";
        assert!(should_skip_server_watch_event(
            r"\\?\C:\Users\Administrator\app\.qingcode\server\server.json",
            root
        ));
        assert!(should_skip_server_watch_event(
            r"\\?\C:\Users\Administrator\app\.qingcode\terminal-paste\paste.txt",
            root
        ));
        assert!(should_skip_server_watch_event(
            r"\\?\C:\Users\Administrator\app\main.rs.tmp",
            root
        ));
        assert!(!should_skip_server_watch_event(
            r"\\?\C:\Users\Administrator\app\src\main.rs",
            root
        ));
    }
}
