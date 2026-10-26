//! qingcode-server daemon 托管的持久化终端。
//!
//! 终端共用 SSH 连接（每条最多 6 个），各占一条 daemon 会话。SSH 断开只销毁代理通道，
//! daemon 里的 PTY 继续运行；重连时按 seq 补发输出，缓冲已淘汰时先 reset
//! 前端 xterm 再写屏幕快照。

use super::daemon::{DaemonAttachResult, DaemonSession, SessionEventReceiver};
use super::*;
use crate::terminal::{encode_terminal_data, TerminalDataPayload, TerminalSpawnResult};
use qingcode_server::proto::{Event, StreamChunk};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{mpsc, oneshot, Notify};

/// 待发送输入的积压上限。在线与重连期间共用同一个有序队列；超出时拒绝本次
/// 输入并报错，不静默丢弃（单次输入上限 1MB，见 `ssh_write_terminal`）。
const PENDING_INPUT_LIMIT: usize = 2 * 1024 * 1024;
const INPUT_CHUNK_BYTES: usize = 16 * 1024;
const DAEMON_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const DAEMON_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
const OFFLINE_KILL_TIMEOUT: Duration = Duration::from_secs(5);

type InputSendFailure = (String, Vec<u8>);

#[derive(Clone)]
pub(crate) struct PersistentLaunch {
    pub(crate) shell: Option<String>,
    pub(crate) args: Vec<String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) name: Option<String>,
    pub(crate) resolved_shell: String,
    pub(crate) fallback_from: Option<String>,
}

enum TerminalCommand {
    Resize,
    Kill(Option<oneshot::Sender<()>>),
}

pub(crate) struct PersistentTerminal {
    id: String,
    pty_id: String,
    connection_id: String,
    root_uri: String,
    next_seq: AtomicU64,
    next_input_seq: AtomicU64,
    size: Mutex<(u16, u16)>,
    /// 唯一的有序输入队列：在线时由会话循环按序取出发送，重连期间继续积压，
    /// 接回后从队首续发。发送失败的剩余部分放回队首，保证先后顺序不变。
    pending_input: Mutex<VecDeque<Vec<u8>>>,
    /// 有新输入入队时唤醒会话循环。
    input_ready: Notify,
    closed: AtomicBool,
    commands: mpsc::Sender<TerminalCommand>,
}

impl PersistentTerminal {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn pty_id(&self) -> &str {
        &self.pty_id
    }

    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub(crate) fn root_uri(&self) -> &str {
        &self.root_uri
    }

    pub(crate) fn is_open(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }

    pub(crate) fn write(&self, data: Vec<u8>) -> Result<(), String> {
        if !self.is_open() {
            return Err("SSH 终端已结束".to_string());
        }
        enqueue_input(self, data)?;
        self.input_ready.notify_one();
        Ok(())
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("终端尺寸必须大于 0".to_string());
        }
        *self
            .size
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = (cols, rows);
        self.commands
            .try_send(TerminalCommand::Resize)
            .map_err(|_| "SSH 终端已结束".to_string())
    }

    pub(crate) async fn kill(&self) -> Result<(), String> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let deadline = tokio::time::Instant::now() + OFFLINE_KILL_TIMEOUT;
        let (ack_tx, ack_rx) = oneshot::channel();
        if !matches!(
            tokio::time::timeout_at(
                deadline,
                self.commands.send(TerminalCommand::Kill(Some(ack_tx))),
            )
            .await,
            Ok(Ok(()))
        ) {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let _ = tokio::time::timeout(remaining, ack_rx).await;
        Ok(())
    }

    fn pop_pending(&self) -> Option<Vec<u8>> {
        self.pending_input
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_front()
    }

    /// 发送失败的剩余输入放回队首，下次按原顺序续发。
    fn requeue_front(&self, data: Vec<u8>) {
        if data.is_empty() {
            return;
        }
        self.pending_input
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_front(data);
    }

    fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
    }
}

/// 输入入队；积压超过上限时拒绝整笔输入（不截断、不丢弃已排队的内容）。
fn enqueue_input(term: &PersistentTerminal, data: Vec<u8>) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let mut pending = term
        .pending_input
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let total = pending.iter().map(Vec::len).sum::<usize>();
    if total + data.len() > PENDING_INPUT_LIMIT {
        return Err(format!(
            "终端输入积压已超过 {} MB（远端未及时读取或正在重连），本次输入未发送",
            PENDING_INPUT_LIMIT / (1024 * 1024)
        ));
    }
    pending.push_back(data);
    Ok(())
}

fn drain_kill_acks(commands: &mut mpsc::Receiver<TerminalCommand>) -> Vec<oneshot::Sender<()>> {
    let mut acks = Vec::new();
    while let Ok(command) = commands.try_recv() {
        if let TerminalCommand::Kill(Some(ack)) = command {
            acks.push(ack);
        }
    }
    acks
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RestoreKind {
    Snapshot,
    Replay,
    None,
    Exit,
}

fn attach_result_maps_to_restore_kind(
    has_screen: bool,
    replay_chunks: usize,
    exited: bool,
) -> RestoreKind {
    if exited {
        RestoreKind::Exit
    } else if has_screen {
        RestoreKind::Snapshot
    } else if replay_chunks > 0 {
        RestoreKind::Replay
    } else {
        RestoreKind::None
    }
}

fn reconnect_delay_schedule(attempt: u32) -> Duration {
    match attempt {
        1 => Duration::ZERO,
        2 | 3 => Duration::from_secs(5),
        4..=8 => Duration::from_secs(10),
        _ => Duration::from_secs(30),
    }
}

fn seq_is_new(seq: u64, next_seq: u64) -> bool {
    seq >= next_seq
}

fn attach_terminal_is_gone(error: &str) -> bool {
    error.contains("终端不存在") || error.contains("不存在或已回收") || error.contains("已回收")
}

/// attach 已确认退出时，daemon 可以立即回收终端；此后不能再调整尺寸或补发输入。
/// 把存活会话的准备工作放在惰性 future 中，保证退出路径不会向已回收的 PTY 发 RPC。
async fn prepare_reconnected_terminal<F>(
    exited: Option<i32>,
    prepare_live: F,
) -> Result<Option<u32>, String>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    if let Some(code) = exited {
        return Ok(Some(u32::try_from(code).unwrap_or(0)));
    }
    prepare_live.await?;
    Ok(None)
}

/// 把 attach 的 STREAM_DATA 分片按 seq/offset 还原成完整逻辑块。
fn assemble_attach_chunks(chunks: &[StreamChunk]) -> Result<Vec<(u64, Vec<u8>)>, String> {
    let mut assembled = Vec::new();
    let mut current_seq = None;
    let mut current = Vec::new();
    for chunk in chunks {
        let seq = chunk
            .seq
            .ok_or_else(|| "pty.attach 重放分片缺少 seq".to_string())?;
        if current_seq != Some(seq) {
            if let Some(previous_seq) = current_seq {
                if !current.is_empty() {
                    return Err(format!("pty.attach seq {previous_seq} 缺少结束分片"));
                }
            }
            current_seq = Some(seq);
            current.clear();
        }
        if chunk.offset as usize != current.len() {
            return Err(format!(
                "pty.attach seq {seq} 分片偏移不连续：期望 {}，实际 {}",
                current.len(),
                chunk.offset
            ));
        }
        current.extend_from_slice(&chunk.data);
        if chunk.last {
            assembled.push((seq, std::mem::take(&mut current)));
            current_seq = None;
        }
    }
    if !current.is_empty() {
        return Err("pty.attach 重放流缺少 STREAM_END 前的最后分片".to_string());
    }
    Ok(assembled)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    id: String,
    exit_code: u32,
    disconnected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalConnectionPayload {
    id: String,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    restore: Option<&'static str>,
}

#[derive(Clone, Serialize)]
struct TerminalResetPayload {
    id: String,
}

/// `pty.list` 中 P3 需要的字段；owner/cwd 对旧 daemon 可缺省。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyInfoWire {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    #[serde(default)]
    exited: Option<i32>,
    detached: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtyListResponse {
    ptys: Vec<PtyInfoWire>,
}

/// 返回给前端的孤儿终端；`cwd` 已映射回 SSH 资源 URI。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetachedTerminal {
    pty_id: String,
    connection_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

fn comparable_daemon_path(path: &str) -> Option<String> {
    if let Some(native) = windows_native_path(path) {
        let normalized = native
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        return (!normalized.is_empty()).then_some(normalized);
    }
    let normalized = path.trim_end_matches('/');
    if !normalized.starts_with('/') {
        return None;
    }
    Some(if normalized.is_empty() {
        "/".to_string()
    } else {
        normalized.to_string()
    })
}

fn daemon_path_is_within(path: &str, root: &str) -> bool {
    let (Some(path), Some(root)) = (comparable_daemon_path(path), comparable_daemon_path(root))
    else {
        return false;
    };
    path == root
        || if root == "/" {
            path.starts_with('/')
        } else {
            path.starts_with(&format!("{root}/"))
        }
}

fn daemon_path_to_uri(connection_id: &str, path: &str) -> Option<String> {
    if let Some(native) = windows_native_path(path) {
        let normalized = native.replace('\\', "/");
        let normalized = normalized.trim_end_matches('/');
        return Some(format!("ssh://{connection_id}/{normalized}"));
    }
    let normalized = normalize_remote_path(path);
    (path.starts_with('/') && !connection_id.is_empty())
        .then(|| format!("ssh://{connection_id}{normalized}"))
}

fn trusted_root_for_daemon_path<'a>(
    roots: &'a [RegisteredRoot],
    path: &str,
) -> Option<&'a RegisteredRoot> {
    roots
        .iter()
        .filter(|root| root.trusted && daemon_path_is_within(path, &root.canonical_path))
        .max_by_key(|root| {
            comparable_daemon_path(&root.canonical_path).map_or(0, |path| path.len())
        })
}

fn owned_detached_ptys(ptys: Vec<PtyInfoWire>, client_id: &str) -> Vec<PtyInfoWire> {
    ptys.into_iter()
        .filter(|info| {
            info.detached
                && info.exited.is_none()
                && info.owner.as_deref() == Some(client_id)
                && info.cols > 0
                && info.rows > 0
        })
        .collect()
}

fn detached_terminal_from_info(
    info: PtyInfoWire,
    connection_id: &str,
    roots: &[RegisteredRoot],
) -> Option<DetachedTerminal> {
    let cwd = info.cwd.as_deref()?;
    trusted_root_for_daemon_path(roots, cwd)?;
    Some(DetachedTerminal {
        pty_id: info.id,
        connection_id: connection_id.to_string(),
        cwd: daemon_path_to_uri(connection_id, cwd)?,
        cols: info.cols,
        rows: info.rows,
        name: info.name.filter(|name| !name.trim().is_empty()),
    })
}

async fn request_owned_detached_ptys(
    session: &DaemonSession,
    client_id: &str,
) -> Result<Vec<PtyInfoWire>, String> {
    let response = session
        .request("pty.list", &serde_json::json!({ "clientId": client_id }))
        .await?;
    let response: PtyListResponse = serde_json::from_value(response)
        .map_err(|error| format!("解析 pty.list 应答失败：{error}"))?;
    Ok(owned_detached_ptys(response.ptys, client_id))
}

fn emit_data(app: &AppHandle, id: &str, data: &[u8]) {
    let _ = app.emit(
        "terminal-data",
        TerminalDataPayload {
            id: id.to_string(),
            data: encode_terminal_data(data),
        },
    );
}

fn emit_connection(
    app: &AppHandle,
    id: &str,
    state: &'static str,
    attempt: Option<u32>,
    reason: Option<String>,
    restore: Option<&'static str>,
) {
    let _ = app.emit(
        "terminal-connection",
        TerminalConnectionPayload {
            id: id.to_string(),
            state,
            attempt,
            reason,
            restore,
        },
    );
}

fn emit_exit(
    app: &AppHandle,
    id: &str,
    exit_code: u32,
    disconnected: bool,
    reason: Option<String>,
) {
    let _ = app.emit(
        "terminal-exit",
        TerminalExitPayload {
            id: id.to_string(),
            exit_code,
            disconnected,
            reason,
        },
    );
}

struct ActiveSession {
    transport: TerminalTransportLease,
    session: DaemonSession,
    events: SessionEventReceiver,
}

/// 在共享终端连接上打开 daemon 会话。
///
/// 连接因 sshd 会话数打满而拒绝开通道时，按实测值修正该连接容量，换一条连接重试一次。
async fn open_terminal_daemon_session(
    manager: &SshManager,
    connection_id: &str,
    root_uri: &str,
    client_id: &str,
    daemon: &DaemonAccess,
) -> Result<(TerminalTransportLease, DaemonSession), String> {
    let mut retried = false;
    loop {
        let transport = manager
            .lease_daemon_terminal_transport(connection_id, root_uri)
            .await?;
        match DaemonSession::open_on_transport(&transport, client_id, daemon).await {
            Ok(session) => return Ok((transport, session)),
            Err(error) => {
                let retry =
                    !retried && is_channel_refused_error(&error) && transport.mark_refused().await;
                transport.release();
                if !retry {
                    return Err(error);
                }
                retried = true;
            }
        }
    }
}

/// 已有共享连接全满、新开了连接时提示用户（前端以 info toast 展示）。
fn emit_terminal_pool_notice(
    app: &AppHandle,
    connection_id: &str,
    transport: &TerminalTransportLease,
) {
    if let Some(message) = transport.notice() {
        let _ = app.emit(
            "ssh-terminal-pool-notice",
            serde_json::json!({ "connectionId": connection_id, "message": message }),
        );
    }
}

enum ConnectedEnd {
    Exited(u32),
    Disconnected(String),
    Closed,
}

enum ReconnectEnd {
    Connected(ActiveSession),
    Exited(u32),
    Terminated(String),
    Retry,
    Closed,
}

pub(crate) async fn list_detached_terminals(
    connection_id: &str,
    app: &AppHandle,
    manager: &SshManager,
) -> Result<Vec<DetachedTerminal>, String> {
    if !manager.server_mode(connection_id) {
        return Ok(Vec::new());
    }
    let roots = manager.roots_for_connection(connection_id);
    let Some(endpoint_root) = roots
        .iter()
        .filter(|root| root.trusted)
        .max_by_key(|root| {
            comparable_daemon_path(&root.canonical_path).map_or(0, |path| path.len())
        })
        .cloned()
    else {
        return Ok(Vec::new());
    };
    let endpoint = server::ready_server_endpoint(app, manager, &endpoint_root)
        .await
        .ok_or_else(|| "远端 daemon 尚未就绪".to_string())?;
    let daemon = endpoint
        .daemon
        .as_ref()
        .ok_or_else(|| "远端 server 当前没有 daemon 端点".to_string())?;
    let client_id = manager.daemon_client_id(connection_id);
    let (transport, session) = open_terminal_daemon_session(
        manager,
        connection_id,
        &endpoint_root.uri,
        &client_id,
        daemon,
    )
    .await?;
    let result = async {
        let ptys = request_owned_detached_ptys(&session, &client_id).await?;
        Ok(ptys
            .into_iter()
            .filter_map(|info| detached_terminal_from_info(info, connection_id, &roots))
            .collect())
    }
    .await;
    session.shutdown();
    transport.release();
    result
}

/// 结束本安装留在 daemon 里、但当前没有本地活动会话的终端。
///
/// 仅按连接或项目根清理时也要覆盖应用重启后尚未接回的 PTY；它们不在
/// `SshManager::persistent_terminals` 中，不能只遍历进程内表。
pub(crate) async fn kill_detached_terminals(
    connection_id: &str,
    app: &AppHandle,
    manager: &SshManager,
    root_uri: Option<&str>,
) -> Result<usize, String> {
    // SSH 模式的连接没有 daemon，也就没有托管终端可清理。
    if !manager.server_mode(connection_id) {
        return Ok(0);
    }
    let roots = manager.roots_for_connection(connection_id);
    let Some(endpoint_root) = roots
        .iter()
        .filter(|root| root.trusted)
        .max_by_key(|root| {
            comparable_daemon_path(&root.canonical_path).map_or(0, |path| path.len())
        })
        .cloned()
    else {
        return Ok(0);
    };
    let endpoint = server::ready_server_endpoint(app, manager, &endpoint_root)
        .await
        .ok_or_else(|| "远端 daemon 尚未就绪".to_string())?;
    let daemon = endpoint
        .daemon
        .as_ref()
        .ok_or_else(|| "远端 server 当前没有 daemon 端点".to_string())?;
    let client_id = manager.daemon_client_id(connection_id);
    let (transport, session) = open_terminal_daemon_session(
        manager,
        connection_id,
        &endpoint_root.uri,
        &client_id,
        daemon,
    )
    .await?;
    let result = async {
        let mut killed = 0usize;
        for info in request_owned_detached_ptys(&session, &client_id).await? {
            let Some(cwd) = info.cwd.as_deref() else {
                continue;
            };
            if trusted_root_for_daemon_path(&roots, cwd).is_none() {
                continue;
            }
            if root_uri.is_some_and(|root| !daemon_path_is_within(cwd, root)) {
                continue;
            }
            if session
                .request("pty.kill", &serde_json::json!({ "id": info.id }))
                .await
                .is_ok()
            {
                killed += 1;
            }
        }
        Ok(killed)
    }
    .await;
    session.shutdown();
    transport.release();
    result
}

pub(crate) async fn attach_persistent_terminal(
    id: String,
    pty_id: String,
    root: RegisteredRoot,
    cols: u16,
    rows: u16,
    app: AppHandle,
    manager: &SshManager,
) -> Result<TerminalSpawnResult, String> {
    if pty_id.trim().is_empty() {
        return Err("ptyId 不能为空".to_string());
    }
    if cols == 0 || rows == 0 {
        return Err("终端尺寸必须大于 0".to_string());
    }
    let parsed = parse_remote_uri(&root.uri)?;
    // Server 模式：等部署与 daemon 探测完成，不可用时报错，不回退直连。
    let endpoint = server::require_server_endpoint(&app, manager, &root, true).await?;
    let daemon = endpoint
        .daemon
        .as_ref()
        .ok_or_else(|| server::server_mode_error("远端 daemon 不可用"))?;
    let client_id = manager.daemon_client_id(&parsed.connection_id);
    let (transport, mut session) = open_terminal_daemon_session(
        manager,
        &parsed.connection_id,
        &root.uri,
        &client_id,
        daemon,
    )
    .await?;
    emit_terminal_pool_notice(&app, &parsed.connection_id, &transport);

    let owned = request_owned_detached_ptys(&session, &client_id).await;
    let info = match owned {
        Ok(ptys) => match ptys.into_iter().find(|info| info.id == pty_id) {
            Some(info) => info,
            None => {
                session.shutdown();
                transport.release();
                return Err(format!("PTY 不存在、已退出或不属于当前客户端：{pty_id}"));
            }
        },
        Err(error) => {
            session.shutdown();
            transport.release();
            return Err(error);
        }
    };
    let Some(cwd) = info.cwd.as_deref() else {
        session.shutdown();
        transport.release();
        return Err(format!("PTY 缺少工作目录，无法安全接回：{pty_id}"));
    };
    if !root.trusted || !daemon_path_is_within(cwd, &root.canonical_path) {
        session.shutdown();
        transport.release();
        return Err("PTY 工作目录不在当前可信项目根内".to_string());
    }

    let attach = match session.attach(&pty_id, 0).await {
        Ok(attach) => attach,
        Err(error) if attach_terminal_is_gone(&error) => {
            session.shutdown();
            transport.release();
            return Err(format!("PTY 不存在或已退出：{pty_id}"));
        }
        Err(error) => {
            session.shutdown();
            transport.release();
            return Err(error);
        }
    };
    let exited = attach
        .response
        .get("exited")
        .and_then(serde_json::Value::as_i64);
    let next_input_seq = attach
        .response
        .get("nextInputSeq")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if exited.is_some() {
        let _ = session
            .request("pty.kill", &serde_json::json!({ "id": pty_id }))
            .await;
        session.shutdown();
        transport.release();
        return Err(format!("PTY 已退出，无法接回：{pty_id}"));
    }
    let Some(events) = session.take_events() else {
        session.shutdown();
        transport.release();
        return Err("daemon 会话事件流已初始化".to_string());
    };

    let (command_tx, command_rx) = mpsc::channel(8);
    let terminal = Arc::new(PersistentTerminal {
        id: id.clone(),
        pty_id: pty_id.clone(),
        connection_id: parsed.connection_id.clone(),
        root_uri: normalize_remote_uri(&root.uri),
        next_seq: AtomicU64::new(0),
        next_input_seq: AtomicU64::new(next_input_seq),
        size: Mutex::new((cols, rows)),
        pending_input: Mutex::new(VecDeque::new()),
        input_ready: Notify::new(),
        closed: AtomicBool::new(false),
        commands: command_tx,
    });
    // 接回出错只放弃本次接回，绝不 kill：远端进程仍在运行，留作 detached 终端，
    // 稍后可从孤儿终端提示再次接回。
    let (_, restore) = match apply_attach_restore(&terminal, &app, &attach).await {
        Ok(result) => result,
        Err(error) => {
            session.shutdown();
            transport.release();
            return Err(error);
        }
    };
    if let Err(error) = resize_session(&session, &pty_id, cols, rows).await {
        // 尺寸下发失败不影响接回：交给会话循环稍后重试。
        eprintln!("[WARN] persistent terminal {id} resize after attach failed: {error}");
        let _ = terminal.commands.try_send(TerminalCommand::Resize);
    }

    let inserted = {
        match manager.persistent_terminals.write() {
            Ok(mut terminals) => Ok(terminals.insert(id.clone(), Arc::clone(&terminal))),
            Err(_) => Err(()),
        }
    };
    let previous = match inserted {
        Ok(previous) => previous,
        Err(()) => {
            session.shutdown();
            transport.release();
            return Err("SSH 终端状态不可用".to_string());
        }
    };
    if let Some(previous) = previous {
        previous.mark_closed();
        if previous.pty_id() != pty_id {
            let _ = previous.commands.try_send(TerminalCommand::Kill(None));
        }
    }

    let task_terminal = Arc::clone(&terminal);
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_persistent_terminal(
            task_terminal,
            root,
            task_app,
            ActiveSession {
                transport,
                session,
                events,
            },
            command_rx,
        )
        .await;
    });

    let restore_name = match restore {
        RestoreKind::Snapshot => "snapshot",
        RestoreKind::Replay => "replay",
        RestoreKind::None | RestoreKind::Exit => "none",
    };
    emit_connection(
        &app,
        &terminal.id,
        "attached",
        None,
        None,
        Some(restore_name),
    );
    Ok(TerminalSpawnResult {
        resolved_shell: None,
        fallback_from: None,
        persistent: true,
        pty_id: Some(pty_id),
        connection_id: Some(parsed.connection_id),
        persistent_fallback_reason: None,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn spawn_persistent_terminal(
    id: String,
    root: RegisteredRoot,
    working_directory: String,
    cols: u16,
    rows: u16,
    launch: PersistentLaunch,
    app: AppHandle,
    manager: &SshManager,
) -> Result<TerminalSpawnResult, String> {
    let parsed = parse_remote_uri(&root.uri)?;
    // Server 模式：等部署与 daemon 探测完成，不可用时报错，不回退直连。
    let endpoint = server::require_server_endpoint(&app, manager, &root, true).await?;
    let daemon = endpoint
        .daemon
        .as_ref()
        .ok_or_else(|| server::server_mode_error("远端 daemon 不可用"))?;
    let client_id = manager.daemon_client_id(&parsed.connection_id);
    let (transport, mut session) = open_terminal_daemon_session(
        manager,
        &parsed.connection_id,
        &root.uri,
        &client_id,
        daemon,
    )
    .await?;
    emit_terminal_pool_notice(&app, &parsed.connection_id, &transport);
    let opened = async {
        let response = session
            .request(
                "pty.create",
                &serde_json::json!({
                    "cwd": working_directory,
                    "shell": launch.shell,
                    "args": launch.args,
                    "env": launch.env,
                    "name": launch.name,
                    "cols": cols.max(1),
                    "rows": rows.max(1),
                }),
            )
            .await?;
        let pty_id = response
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "pty.create 应答缺少 id".to_string())?
            .to_string();
        let seq = response
            .get("seq")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let next_input_seq = response
            .get("nextInputSeq")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let events = session
            .take_events()
            .ok_or_else(|| "daemon 会话事件流已初始化".to_string())?;
        Ok::<_, String>((events, pty_id, seq, next_input_seq))
    }
    .await;
    let (events, pty_id, seq, next_input_seq) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            session.shutdown();
            transport.release();
            return Err(error);
        }
    };

    let (command_tx, command_rx) = mpsc::channel(8);
    let terminal = Arc::new(PersistentTerminal {
        id: id.clone(),
        pty_id: pty_id.clone(),
        connection_id: parsed.connection_id.clone(),
        root_uri: normalize_remote_uri(&root.uri),
        next_seq: AtomicU64::new(seq),
        next_input_seq: AtomicU64::new(next_input_seq),
        size: Mutex::new((cols.max(1), rows.max(1))),
        pending_input: Mutex::new(VecDeque::new()),
        input_ready: Notify::new(),
        closed: AtomicBool::new(false),
        commands: command_tx,
    });
    let previous = {
        let inserted = manager
            .persistent_terminals
            .write()
            .map(|mut terminals| terminals.insert(id.clone(), Arc::clone(&terminal)))
            .map_err(|_| ());
        match inserted {
            Ok(previous) => previous,
            Err(_) => {
                session.shutdown();
                transport.release();
                return Err("SSH 终端状态不可用".to_string());
            }
        }
    };
    if let Some(previous) = previous {
        previous.mark_closed();
        let _ = previous.commands.try_send(TerminalCommand::Kill(None));
    }

    let task_terminal = Arc::clone(&terminal);
    tauri::async_runtime::spawn(async move {
        run_persistent_terminal(
            task_terminal,
            root,
            app,
            ActiveSession {
                transport,
                session,
                events,
            },
            command_rx,
        )
        .await;
    });

    Ok(TerminalSpawnResult {
        resolved_shell: Some(launch.resolved_shell),
        fallback_from: launch.fallback_from,
        persistent: true,
        pty_id: Some(pty_id),
        connection_id: Some(parsed.connection_id),
        persistent_fallback_reason: None,
    })
}

async fn run_persistent_terminal(
    terminal: Arc<PersistentTerminal>,
    root: RegisteredRoot,
    app: AppHandle,
    mut active: ActiveSession,
    mut command_rx: mpsc::Receiver<TerminalCommand>,
) {
    let manager = app.state::<SshManager>();
    loop {
        match run_connected(&terminal, &app, &mut active, &mut command_rx).await {
            ConnectedEnd::Exited(code) => {
                terminal.mark_closed();
                // shell 正常退出也要释放独占的 SSH 连接与 daemon 会话。
                active.session.shutdown();
                active.transport.release();
                emit_exit(&app, &terminal.id, code, false, None);
                remove_persistent_terminal(&app, &terminal);
                return;
            }
            ConnectedEnd::Closed => {
                terminal.mark_closed();
                active.session.shutdown();
                active.transport.release();
                remove_persistent_terminal(&app, &terminal);
                return;
            }
            ConnectedEnd::Disconnected(reason) => {
                active.session.shutdown();
                active.transport.release();
                let mut kill_acks = Vec::new();
                let mut attempt = 0u32;
                loop {
                    attempt = attempt.saturating_add(1);
                    emit_connection(
                        &app,
                        &terminal.id,
                        "reconnecting",
                        Some(attempt),
                        Some(reason.clone()),
                        None,
                    );
                    if terminal.closed.load(Ordering::Acquire) {
                        kill_acks.extend(drain_kill_acks(&mut command_rx));
                        break;
                    }
                    let delay = reconnect_delay_schedule(attempt);
                    if !delay.is_zero() {
                        let sleep = tokio::time::sleep(delay);
                        tokio::pin!(sleep);
                        loop {
                            tokio::select! {
                                _ = &mut sleep => break,
                                command = command_rx.recv() => {
                                    match command {
                                        Some(TerminalCommand::Kill(ack)) => {
                                            terminal.closed.store(true, Ordering::Release);
                                            if let Some(ack) = ack {
                                                kill_acks.push(ack);
                                            }
                                        }
                                        Some(TerminalCommand::Resize) | None => {}
                                    }
                                }
                            }
                            if terminal.closed.load(Ordering::Acquire) {
                                kill_acks.extend(drain_kill_acks(&mut command_rx));
                                break;
                            }
                        }
                    }
                    if terminal.closed.load(Ordering::Acquire) {
                        kill_acks.extend(drain_kill_acks(&mut command_rx));
                        break;
                    }
                    match reconnect_terminal(&terminal, &root, &app, &manager).await {
                        ReconnectEnd::Connected(connected) => {
                            active = connected;
                            break;
                        }
                        ReconnectEnd::Terminated(reason) => {
                            terminal.mark_closed();
                            for ack in kill_acks.drain(..) {
                                let _ = ack.send(());
                            }
                            emit_exit(&app, &terminal.id, 0, true, Some(reason));
                            remove_persistent_terminal(&app, &terminal);
                            return;
                        }
                        ReconnectEnd::Exited(code) => {
                            terminal.mark_closed();
                            for ack in kill_acks.drain(..) {
                                let _ = ack.send(());
                            }
                            emit_exit(&app, &terminal.id, code, false, None);
                            remove_persistent_terminal(&app, &terminal);
                            return;
                        }
                        ReconnectEnd::Retry => {
                            if terminal.closed.load(Ordering::Acquire) {
                                kill_acks.extend(drain_kill_acks(&mut command_rx));
                                break;
                            }
                            continue;
                        }
                        ReconnectEnd::Closed => {
                            kill_acks.extend(drain_kill_acks(&mut command_rx));
                            break;
                        }
                    }
                }
                if terminal.closed.load(Ordering::Acquire) {
                    kill_offline(&terminal, &root, &app).await;
                    for ack in kill_acks {
                        let _ = ack.send(());
                    }
                    terminal.mark_closed();
                    remove_persistent_terminal(&app, &terminal);
                    return;
                }
            }
        }
    }
}

async fn run_connected(
    terminal: &Arc<PersistentTerminal>,
    app: &AppHandle,
    active: &mut ActiveSession,
    command_rx: &mut mpsc::Receiver<TerminalCommand>,
) -> ConnectedEnd {
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + DAEMON_HEARTBEAT_INTERVAL,
        DAEMON_HEARTBEAT_INTERVAL,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            event = active.events.recv() => {
                match event {
                    Some(Event::PtyData { id, seq, data, .. }) if id == terminal.pty_id => {
                        let next = terminal.next_seq.load(Ordering::Acquire);
                        if seq > next {
                            return ConnectedEnd::Disconnected(format!(
                                "终端输出序号不连续：期望 {next}，收到 {seq}"
                            ));
                        }
                        if seq_is_new(seq, next) {
                            emit_data(app, &terminal.id, &data);
                            terminal.next_seq.store(seq.wrapping_add(1), Ordering::Release);
                        }
                    }
                    Some(Event::PtyExit { id, code }) if id == terminal.pty_id => {
                        return ConnectedEnd::Exited(
                            code.and_then(|code| u32::try_from(code).ok()).unwrap_or(0)
                        );
                    }
                    Some(_) => {}
                    None => {
                        return ConnectedEnd::Disconnected(session_disconnect_reason(active));
                    }
                }
            }
            _ = terminal.input_ready.notified() => {
                if let Err(error) = flush_pending_to_session(terminal, &active.session).await {
                    return ConnectedEnd::Disconnected(error);
                }
            }
            command = command_rx.recv() => {
                match command {
                    Some(TerminalCommand::Resize) => {
                        let (cols, rows) = *terminal
                            .size
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if let Err(error) = resize_active(active, &terminal.pty_id, cols, rows).await {
                            return ConnectedEnd::Disconnected(error);
                        }
                    }
                    Some(TerminalCommand::Kill(ack)) => {
                        terminal.closed.store(true, Ordering::Release);
                        let _ = active.session.request(
                            "pty.kill",
                            &serde_json::json!({ "id": terminal.pty_id }),
                        ).await;
                        if let Some(ack) = ack {
                            let _ = ack.send(());
                        }
                        return ConnectedEnd::Closed;
                    }
                    None => return ConnectedEnd::Closed,
                }
            }
            _ = heartbeat.tick() => {
                if active.session.last_frame_age() >= DAEMON_HEARTBEAT_TIMEOUT {
                    return ConnectedEnd::Disconnected(
                        "约 30 秒未收到远端 daemon 回包".to_string()
                    );
                }
                active.session.send_ping();
            }
            _ = active.session.wait_closed() => {
                return ConnectedEnd::Disconnected(session_disconnect_reason(active));
            }
        }
    }
}

fn session_disconnect_reason(active: &ActiveSession) -> String {
    active
        .transport
        .closed_reason()
        .or_else(|| active.session.closed_reason())
        .unwrap_or_else(|| "daemon 连接已断开".to_string())
}

async fn resize_active(
    active: &ActiveSession,
    pty_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    active
        .session
        .request(
            "pty.resize",
            &serde_json::json!({ "id": pty_id, "cols": cols, "rows": rows }),
        )
        .await
        .map(|_| ())
}

async fn reconnect_terminal(
    terminal: &PersistentTerminal,
    root: &RegisteredRoot,
    app: &AppHandle,
    manager: &SshManager,
) -> ReconnectEnd {
    let parsed = match parse_remote_uri(&root.uri) {
        Ok(parsed) => parsed,
        Err(error) => return ReconnectEnd::Terminated(error),
    };
    if terminal.closed.load(Ordering::Acquire) {
        return ReconnectEnd::Closed;
    }
    if manager
        .ensure_connection_alive(&parsed.connection_id)
        .await
        .is_err()
    {
        return ReconnectEnd::Retry;
    }
    let endpoint = match server::ready_server_endpoint(app, manager, root).await {
        Some(endpoint) => endpoint,
        None => return ReconnectEnd::Retry,
    };
    let Some(daemon) = endpoint.daemon.as_ref() else {
        return ReconnectEnd::Retry;
    };
    let client_id = manager.daemon_client_id(&parsed.connection_id);
    // 握手失败（HELLO 超时、通道被拒、网络刚恢复时的 reset）都是瞬时故障，
    // 不能据此断定 daemon 已重启：只有握手成功后 attach 明确返回「终端不存在」
    // 才结束终端，否则继续重试，进程仍在 daemon 里运行。
    let (transport, mut session) = match open_terminal_daemon_session(
        manager,
        &parsed.connection_id,
        &root.uri,
        &client_id,
        daemon,
    )
    .await
    {
        Ok(opened) => opened,
        Err(error) => {
            eprintln!(
                "[WARN] persistent terminal {} daemon handshake failed, will retry: {error}",
                terminal.id
            );
            return ReconnectEnd::Retry;
        }
    };
    let from_seq = terminal.next_seq.load(Ordering::Acquire);
    let attach = match session.attach(&terminal.pty_id, from_seq).await {
        Ok(attach) => attach,
        Err(error) if attach_terminal_is_gone(&error) => {
            session.shutdown();
            transport.release();
            return ReconnectEnd::Terminated("远端 daemon 已重启，终端进程已结束".to_string());
        }
        Err(_) => {
            session.shutdown();
            transport.release();
            return ReconnectEnd::Retry;
        }
    };
    let Some(events) = session.take_events() else {
        session.shutdown();
        transport.release();
        return ReconnectEnd::Retry;
    };
    let (exited, restore) = match apply_attach_restore(terminal, app, &attach).await {
        Ok(result) => result,
        Err(error) => {
            // 已写出的输出已推进 next_seq，下次 attach 从缺口续补。
            session.shutdown();
            transport.release();
            eprintln!(
                "[WARN] persistent terminal {} attach restore failed, will retry: {error}",
                terminal.id
            );
            return ReconnectEnd::Retry;
        }
    };
    match prepare_reconnected_terminal(exited, async {
        let (cols, rows) = *terminal
            .size
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        resize_session(&session, &terminal.pty_id, cols, rows).await?;
        flush_pending_to_session(terminal, &session).await
    })
    .await
    {
        Ok(Some(code)) => {
            session.shutdown();
            transport.release();
            return ReconnectEnd::Exited(code);
        }
        Ok(None) => {}
        Err(error) => {
            session.shutdown();
            transport.release();
            eprintln!(
                "[WARN] persistent terminal {} could not prepare live session after attach: {error}",
                terminal.id
            );
            return ReconnectEnd::Retry;
        }
    }
    let restore_name = match restore {
        RestoreKind::Snapshot => Some("snapshot"),
        RestoreKind::Replay => Some("replay"),
        RestoreKind::None | RestoreKind::Exit => Some("none"),
    };
    emit_connection(app, &terminal.id, "attached", None, None, restore_name);
    ReconnectEnd::Connected(ActiveSession {
        transport,
        session,
        events,
    })
}

async fn apply_attach_restore(
    terminal: &PersistentTerminal,
    app: &AppHandle,
    attach: &DaemonAttachResult,
) -> Result<(Option<i32>, RestoreKind), String> {
    let screen = attach
        .response
        .get("screen")
        .and_then(serde_json::Value::as_str);
    let seq_end = attach
        .response
        .get("seqEnd")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            attach
                .stream_end
                .summary
                .get("seqEnd")
                .and_then(serde_json::Value::as_u64)
        })
        .unwrap_or_else(|| terminal.next_seq.load(Ordering::Acquire));
    let exited = attach
        .response
        .get("exited")
        .and_then(serde_json::Value::as_i64)
        .map(|value| value as i32)
        .or_else(|| {
            attach
                .stream_end
                .summary
                .get("exited")
                .and_then(serde_json::Value::as_i64)
                .map(|value| value as i32)
        });
    if !attach.stream_end.ok {
        return Err(attach
            .stream_end
            .error
            .clone()
            .unwrap_or_else(|| "pty.attach 重放失败".to_string()));
    }
    let replay = assemble_attach_chunks(&attach.chunks)?;
    let restore =
        attach_result_maps_to_restore_kind(screen.is_some(), replay.len(), exited.is_some());
    match restore {
        RestoreKind::Snapshot => {
            let _ = app.emit(
                "terminal-reset",
                TerminalResetPayload {
                    id: terminal.id.clone(),
                },
            );
            if let Some(screen) = screen {
                emit_data(app, &terminal.id, screen.as_bytes());
            }
            terminal.next_seq.store(seq_end, Ordering::Release);
        }
        RestoreKind::Replay => {
            let mut next_seq = terminal.next_seq.load(Ordering::Acquire);
            for (seq, data) in &replay {
                if *seq > next_seq {
                    return Err(format!(
                        "pty.attach 重放序号不连续：期望 {next_seq}，收到 {seq}"
                    ));
                }
                if seq_is_new(*seq, next_seq) {
                    emit_data(app, &terminal.id, data);
                    next_seq = seq.wrapping_add(1);
                    terminal.next_seq.store(next_seq, Ordering::Release);
                }
            }
            if next_seq != seq_end {
                return Err(format!(
                    "pty.attach 重放结束序号不连续：期望 {seq_end}，实际 {next_seq}"
                ));
            }
        }
        RestoreKind::None => {
            let next_seq = terminal.next_seq.load(Ordering::Acquire);
            if seq_end > next_seq {
                return Err("pty.attach 未提供缺失输出或屏幕快照".to_string());
            }
        }
        RestoreKind::Exit => {}
    }
    if restore == RestoreKind::Exit {
        if let Some(screen) = screen {
            let _ = app.emit(
                "terminal-reset",
                TerminalResetPayload {
                    id: terminal.id.clone(),
                },
            );
            emit_data(app, &terminal.id, screen.as_bytes());
            terminal.next_seq.store(seq_end, Ordering::Release);
        } else {
            let mut next_seq = terminal.next_seq.load(Ordering::Acquire);
            for (seq, data) in &replay {
                if *seq > next_seq {
                    return Err(format!(
                        "pty.attach 退出前重放序号不连续：期望 {next_seq}，收到 {seq}"
                    ));
                }
                if seq_is_new(*seq, next_seq) {
                    emit_data(app, &terminal.id, data);
                    next_seq = seq.wrapping_add(1);
                    terminal.next_seq.store(next_seq, Ordering::Release);
                }
            }
            if next_seq != seq_end {
                return Err(format!(
                    "pty.attach 退出前重放结束序号不连续：期望 {seq_end}，实际 {next_seq}"
                ));
            }
        }
    }
    Ok((exited, restore))
}

async fn kill_offline(terminal: &PersistentTerminal, root: &RegisteredRoot, app: &AppHandle) {
    let manager = app.state::<SshManager>();
    let deadline = tokio::time::Instant::now() + OFFLINE_KILL_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        let parsed = match parse_remote_uri(&root.uri) {
            Ok(parsed) => parsed,
            Err(_) => return,
        };
        if manager
            .ensure_connection_alive(&parsed.connection_id)
            .await
            .is_ok()
        {
            if let Some(endpoint) = server::ready_server_endpoint(app, &manager, root).await {
                if let Some(daemon) = endpoint.daemon.as_ref() {
                    let client_id = manager.daemon_client_id(&parsed.connection_id);
                    if let Ok((transport, session)) = open_terminal_daemon_session(
                        &manager,
                        &parsed.connection_id,
                        &root.uri,
                        &client_id,
                        daemon,
                    )
                    .await
                    {
                        let killed = session
                            .request("pty.kill", &serde_json::json!({ "id": terminal.pty_id }))
                            .await
                            .is_ok();
                        session.shutdown();
                        transport.release();
                        if killed {
                            return;
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    eprintln!(
        "[WARN] persistent terminal {} could not reconnect within 5s to kill remote PTY {}",
        terminal.id, terminal.pty_id
    );
}

async fn resize_session(
    session: &DaemonSession,
    pty_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    session
        .request(
            "pty.resize",
            &serde_json::json!({ "id": pty_id, "cols": cols, "rows": rows }),
        )
        .await
        .map(|_| ())
}

/// 按序发送队列里的全部输入；失败时把未送达部分放回队首并返回原因。
async fn flush_pending_to_session(
    terminal: &PersistentTerminal,
    session: &DaemonSession,
) -> Result<(), String> {
    while let Some(input) = terminal.pop_pending() {
        if let Err((error, unsent)) =
            send_input_to_session(session, &terminal.pty_id, &terminal.next_input_seq, input).await
        {
            terminal.requeue_front(unsent);
            return Err(error);
        }
    }
    Ok(())
}

async fn send_input_to_session(
    session: &DaemonSession,
    pty_id: &str,
    next_input_seq: &AtomicU64,
    input: Vec<u8>,
) -> Result<(), InputSendFailure> {
    struct Bytes<'a>(&'a [u8]);

    impl Serialize for Bytes<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            serializer.serialize_bytes(self.0)
        }
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InputParams<'a> {
        id: &'a str,
        seq: u64,
        data: Bytes<'a>,
    }

    for (index, chunk) in input.chunks(INPUT_CHUNK_BYTES).enumerate() {
        let seq = next_input_seq.load(Ordering::Acquire);
        if let Err(error) = session
            .request(
                "pty.input",
                &InputParams {
                    id: pty_id,
                    seq,
                    data: Bytes(chunk),
                },
            )
            .await
        {
            return Err((error, input[index * INPUT_CHUNK_BYTES..].to_vec()));
        }
        next_input_seq.store(seq.wrapping_add(1), Ordering::Release);
    }
    Ok(())
}

fn remove_persistent_terminal(app: &AppHandle, terminal: &Arc<PersistentTerminal>) {
    app.state::<SshManager>()
        .forget_persistent_terminal(terminal);
}

#[cfg(test)]
mod real_host_stability;

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use qingcode_server::daemon::{run_async as run_loopback_daemon, DaemonOptions, RunDir};
    #[cfg(unix)]
    use qingcode_server::ipc::IpcEndpoint;
    #[cfg(unix)]
    use qingcode_server::proto::{
        self, ErrorBody, Frame, HelloRequest, Kind, Request, Response, StreamEnd, WindowCredit,
        CONTROL_STREAM, PROTOCOL_VERSION, WINDOW_BYTES,
    };
    #[cfg(unix)]
    use tokio::io::{AsyncRead, AsyncWrite};

    #[test]
    fn reconnect_delay_schedule_matches_watch() {
        let delays = (1..=10)
            .map(|attempt| reconnect_delay_schedule(attempt).as_secs())
            .collect::<Vec<_>>();
        assert_eq!(delays, vec![0, 5, 5, 10, 10, 10, 10, 10, 30, 30]);
    }

    #[test]
    fn seq_dedup_drops_overlapping_replay() {
        assert!(!seq_is_new(7, 8));
        assert!(seq_is_new(8, 8));
        assert!(seq_is_new(9, 8));
    }

    fn test_terminal() -> PersistentTerminal {
        let (commands, _rx) = mpsc::channel(1);
        PersistentTerminal {
            id: "t".into(),
            pty_id: "p".into(),
            connection_id: "c".into(),
            root_uri: "ssh://c/root".into(),
            next_seq: AtomicU64::new(0),
            next_input_seq: AtomicU64::new(0),
            size: Mutex::new((80, 24)),
            pending_input: Mutex::new(VecDeque::new()),
            input_ready: Notify::new(),
            closed: AtomicBool::new(false),
            commands,
        }
    }

    #[tokio::test]
    async fn reconnect_to_exited_terminal_preserves_exit_without_sending_pending_input() {
        let terminal = test_terminal();
        let pending = b"echo queued-during-disconnect\n".to_vec();
        terminal.write(pending.clone()).unwrap();

        // 模拟 attach 已报告退出、daemon 随即回收 PTY。旧逻辑会先发 resize/input，
        // 将这里的「不存在」误作传输故障重试，最终误报 daemon 重启并丢失退出码。
        let result = prepare_reconnected_terminal(Some(7), async {
            terminal.pop_pending();
            Err("终端不存在或已回收".to_string())
        })
        .await;
        assert_eq!(result, Ok(Some(7)));
        assert_eq!(terminal.pop_pending(), Some(pending));
    }

    #[tokio::test]
    async fn reconnect_to_live_terminal_prepares_session_and_propagates_failure() {
        let terminal = test_terminal();
        terminal.write(b"echo live\n".to_vec()).unwrap();
        let result = prepare_reconnected_terminal(None, async {
            assert_eq!(terminal.pop_pending(), Some(b"echo live\n".to_vec()));
            Ok(())
        })
        .await;
        assert_eq!(result, Ok(None));

        let result = prepare_reconnected_terminal(None, async {
            Err("daemon pty.resize 请求超时".to_string())
        })
        .await;
        assert_eq!(result, Err("daemon pty.resize 请求超时".to_string()));
    }

    #[test]
    fn pending_input_rejects_overflow_without_dropping_and_keeps_order() {
        let terminal = test_terminal();
        terminal.write(vec![b'a'; 1024 * 1024]).unwrap();
        terminal.write(vec![b'b'; 1024 * 1024]).unwrap();
        // 超过积压上限：整笔拒绝，已排队内容一字节不丢。
        let error = terminal.write(vec![b'c'; 1]).unwrap_err();
        assert!(error.contains("积压"));
        // 发送失败的剩余部分放回队首，仍排在后来的输入之前。
        let first = terminal.pop_pending().unwrap();
        assert_eq!(first[0], b'a');
        terminal.requeue_front(first[512 * 1024..].to_vec());
        let resumed = terminal.pop_pending().unwrap();
        assert_eq!(resumed.len(), 512 * 1024);
        assert_eq!(resumed[0], b'a');
        assert_eq!(terminal.pop_pending().unwrap()[0], b'b');
        assert!(terminal.pop_pending().is_none());
        // 关闭后不再接受输入。
        terminal.mark_closed();
        assert!(terminal.write(vec![b'x']).is_err());
    }

    #[test]
    fn attach_restore_kind_is_selected() {
        assert_eq!(
            attach_result_maps_to_restore_kind(true, 0, false),
            RestoreKind::Snapshot
        );
        assert_eq!(
            attach_result_maps_to_restore_kind(false, 2, false),
            RestoreKind::Replay
        );
        assert_eq!(
            attach_result_maps_to_restore_kind(false, 0, false),
            RestoreKind::None
        );
        assert_eq!(
            attach_result_maps_to_restore_kind(false, 0, true),
            RestoreKind::Exit
        );
    }

    #[test]
    fn attach_chunks_are_reassembled_by_seq_and_offset() {
        let chunks = vec![
            StreamChunk {
                seq: Some(1),
                offset: 0,
                data: b"ab".to_vec(),
                last: false,
            },
            StreamChunk {
                seq: Some(1),
                offset: 2,
                data: b"cd".to_vec(),
                last: true,
            },
        ];
        assert_eq!(
            assemble_attach_chunks(&chunks).unwrap(),
            vec![(1, b"abcd".to_vec())]
        );
    }

    #[test]
    fn persistent_event_payloads_match_frontend_contract() {
        let reconnecting = serde_json::to_value(TerminalConnectionPayload {
            id: "t1".into(),
            state: "reconnecting",
            attempt: Some(2),
            reason: Some("network lost".into()),
            restore: None,
        })
        .unwrap();
        assert_eq!(reconnecting["state"], "reconnecting");
        assert_eq!(reconnecting["attempt"], 2);
        assert!(reconnecting.get("restore").is_none());

        let attached = serde_json::to_value(TerminalConnectionPayload {
            id: "t1".into(),
            state: "attached",
            attempt: None,
            reason: None,
            restore: Some("snapshot"),
        })
        .unwrap();
        assert_eq!(attached["restore"], "snapshot");
        assert!(attached.get("attempt").is_none());

        let reset = serde_json::to_value(TerminalResetPayload { id: "t1".into() }).unwrap();
        assert_eq!(reset["id"], "t1");

        let exit = serde_json::to_value(TerminalExitPayload {
            id: "t1".into(),
            exit_code: 7,
            disconnected: true,
            reason: Some("daemon restarted".into()),
        })
        .unwrap();
        assert_eq!(exit["exitCode"], 7);
        assert_eq!(exit["disconnected"], true);
        assert_eq!(exit["reason"], "daemon restarted");

        let spawn = serde_json::to_value(TerminalSpawnResult {
            resolved_shell: Some("bash".into()),
            fallback_from: None,
            persistent: false,
            pty_id: None,
            connection_id: None,
            persistent_fallback_reason: Some("daemon unavailable".into()),
        })
        .unwrap();
        assert_eq!(spawn["persistent"], false);
        assert_eq!(spawn["persistentFallbackReason"], "daemon unavailable");
        assert!(spawn.get("persistent_fallback_reason").is_none());

        let persistent = serde_json::to_value(TerminalSpawnResult {
            resolved_shell: None,
            fallback_from: None,
            persistent: true,
            pty_id: Some("pty-1".into()),
            connection_id: Some("remote-a".into()),
            persistent_fallback_reason: None,
        })
        .unwrap();
        assert_eq!(persistent["ptyId"], "pty-1");
        assert_eq!(persistent["connectionId"], "remote-a");
        assert!(persistent.get("pty_id").is_none());
    }

    fn pty_info(id: &str, owner: Option<&str>, cwd: &str) -> PtyInfoWire {
        PtyInfoWire {
            id: id.into(),
            name: Some("opencode".into()),
            owner: owner.map(str::to_string),
            cwd: Some(cwd.into()),
            cols: 120,
            rows: 40,
            exited: None,
            detached: true,
        }
    }

    #[test]
    fn detached_terminal_maps_owned_pty_cwd_to_ssh_uri() {
        let roots = vec![RegisteredRoot {
            uri: "ssh://remote-a/home/dev/app".into(),
            canonical_path: "/home/dev/app".into(),
            trusted: true,
        }];
        let terminal = detached_terminal_from_info(
            pty_info("pty-1", Some("install:remote-a"), "/home/dev/app"),
            "remote-a",
            &roots,
        )
        .unwrap();
        assert_eq!(terminal.pty_id, "pty-1");
        assert_eq!(terminal.connection_id, "remote-a");
        assert_eq!(terminal.cwd, "ssh://remote-a/home/dev/app");
        assert_eq!((terminal.cols, terminal.rows), (120, 40));
        assert_eq!(terminal.name.as_deref(), Some("opencode"));
        let json = serde_json::to_value(&terminal).unwrap();
        assert_eq!(json["ptyId"], "pty-1");
        assert_eq!(json["connectionId"], "remote-a");
        assert!(json.get("pty_id").is_none());

        let windows_roots = vec![RegisteredRoot {
            uri: "ssh://remote-a/D:/code/app".into(),
            canonical_path: "/D:/code/app".into(),
            trusted: true,
        }];
        let windows = detached_terminal_from_info(
            pty_info("pty-win", Some("install:remote-a"), r"\\?\D:\code\app"),
            "remote-a",
            &windows_roots,
        )
        .unwrap();
        assert_eq!(windows.cwd, "ssh://remote-a/D:/code/app");
    }

    #[test]
    fn detached_terminal_list_requires_exact_owner_and_trusted_root() {
        let client_id = "install:remote-a";
        let owned = owned_detached_ptys(
            vec![
                pty_info("owned", Some(client_id), "/home/dev/app"),
                pty_info("other", Some("install:remote-b"), "/home/dev/app"),
                pty_info("legacy", None, "/home/dev/app"),
            ],
            client_id,
        );
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0].id, "owned");

        let untrusted = vec![RegisteredRoot {
            uri: "ssh://remote-a/home/dev/app".into(),
            canonical_path: "/home/dev/app".into(),
            trusted: false,
        }];
        assert!(detached_terminal_from_info(
            pty_info("owned", Some(client_id), "/home/dev/app"),
            "remote-a",
            &untrusted,
        )
        .is_none());
    }

    #[test]
    fn missing_attach_terminal_is_classified_as_daemon_restart() {
        assert!(attach_terminal_is_gone("终端不存在或已回收：abc"));
        assert!(!attach_terminal_is_gone("daemon 响应超时"));
    }

    #[cfg(unix)]
    struct LoopbackClient {
        stream: qingcode_server::ipc::IpcStream,
        next_id: u32,
    }

    #[cfg(unix)]
    impl LoopbackClient {
        async fn connect(run_dir: &RunDir) -> Self {
            let endpoint = IpcEndpoint::new(run_dir.dir());
            let mut stream = endpoint.connect().await.unwrap();
            let hello = HelloRequest {
                client_id: "loopback-client".to_string(),
                protocol_min: PROTOCOL_VERSION,
                protocol_max: PROTOCOL_VERSION,
                token: run_dir.read_token().unwrap(),
                resume_token: None,
            };
            write_loopback_frame(
                &mut stream,
                &Frame::new(Kind::Hello, CONTROL_STREAM, proto::encode(&hello).unwrap()),
            )
            .await;
            let frame = read_loopback_frame(&mut stream).await;
            assert_eq!(frame.kind, Kind::Hello);
            Self { stream, next_id: 1 }
        }

        async fn request<T: Serialize>(&mut self, method: &str, params: &T) -> u32 {
            let id = self.next_id;
            self.next_id += 1;
            let request = Request::with_params(id, method, params).unwrap();
            write_loopback_frame(
                &mut self.stream,
                &Frame::new(Kind::Req, id, proto::encode(&request).unwrap()),
            )
            .await;
            id
        }

        async fn wait_response(&mut self, id: u32) -> serde_json::Value {
            loop {
                let frame = read_loopback_frame(&mut self.stream).await;
                maybe_ack_loopback_ping(&mut self.stream, &frame).await;
                match frame.kind {
                    Kind::Res if frame.stream_id == id => {
                        return proto::decode_value::<Response>(&frame.payload)
                            .unwrap()
                            .result;
                    }
                    Kind::Err if frame.stream_id == id => {
                        let error = proto::decode_value::<ErrorBody>(&frame.payload).unwrap();
                        panic!("loopback request {id} failed: {error:?}");
                    }
                    _ => {}
                }
            }
        }

        async fn wait_response_collecting_events(
            &mut self,
            id: u32,
        ) -> (serde_json::Value, Vec<Event>) {
            let mut events = Vec::new();
            loop {
                let frame = read_loopback_frame(&mut self.stream).await;
                maybe_ack_loopback_ping(&mut self.stream, &frame).await;
                match frame.kind {
                    Kind::Res if frame.stream_id == id => {
                        let result = proto::decode_value::<Response>(&frame.payload)
                            .unwrap()
                            .result;
                        return (result, events);
                    }
                    Kind::Err if frame.stream_id == id => {
                        let error = proto::decode_value::<ErrorBody>(&frame.payload).unwrap();
                        panic!("loopback request {id} failed: {error:?}");
                    }
                    Kind::Event => {
                        if let Ok(event) = proto::decode_value::<Event>(&frame.payload) {
                            events.push(event);
                        }
                    }
                    _ => {}
                }
            }
        }

        async fn wait_attach(&mut self, id: u32) -> (serde_json::Value, Vec<StreamChunk>) {
            let mut response = None;
            let mut chunks = Vec::new();
            let mut window = qingcode_server::proto::ReceiverWindow::new(WINDOW_BYTES);
            loop {
                let frame = read_loopback_frame(&mut self.stream).await;
                maybe_ack_loopback_ping(&mut self.stream, &frame).await;
                match frame.kind {
                    Kind::Res if frame.stream_id == id => {
                        response = Some(
                            proto::decode_value::<Response>(&frame.payload)
                                .unwrap()
                                .result,
                        );
                    }
                    Kind::StreamData if frame.stream_id == id => {
                        if let Some(credit) = window.consume(frame.payload.len()) {
                            let payload = proto::encode(&WindowCredit { credit }).unwrap();
                            write_loopback_frame(
                                &mut self.stream,
                                &Frame::new(Kind::Window, id, payload),
                            )
                            .await;
                        }
                        chunks.push(proto::decode_value(&frame.payload).unwrap());
                    }
                    Kind::StreamEnd if frame.stream_id == id => {
                        let end: StreamEnd = proto::decode_value(&frame.payload).unwrap();
                        assert!(end.ok, "attach stream failed: {end:?}");
                        return (response.expect("attach response"), chunks);
                    }
                    Kind::Err if frame.stream_id == id => {
                        let error = proto::decode_value::<ErrorBody>(&frame.payload).unwrap();
                        panic!("loopback attach failed: {error:?}");
                    }
                    _ => {}
                }
            }
        }
    }

    #[cfg(unix)]
    async fn write_loopback_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) {
        proto::write_frame(writer, frame).await.unwrap();
    }

    #[cfg(unix)]
    async fn read_loopback_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Frame {
        tokio::time::timeout(Duration::from_secs(10), proto::read_frame(reader))
            .await
            .expect("loopback frame timeout")
            .expect("loopback read failed")
    }

    #[cfg(unix)]
    async fn maybe_ack_loopback_ping<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) {
        if frame.kind == Kind::Ping {
            write_loopback_frame(writer, &Frame::empty(Kind::Pong, CONTROL_STREAM)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn loopback_persistent_terminal_survives_channel_drop() {
        let state_dir = std::env::temp_dir().join(format!(
            "qingcode-terminal-loopback-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = state_dir.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let run_dir = RunDir::resolve(Some(&state_dir.join("run"))).unwrap();
        let options = DaemonOptions {
            state_dir: Some(state_dir.join("run")),
            ..Default::default()
        };
        let handle = tokio::spawn(async move { run_loopback_daemon(options).await });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while run_dir.read_token().is_err() {
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let mut client = LoopbackClient::connect(&run_dir).await;
        let create_id = client
            .request(
                "pty.create",
                &serde_json::json!({
                    "cwd": root,
                    "shell": "/bin/sh",
                    "cols": 80,
                    "rows": 24
                }),
            )
            .await;
        let created = client.wait_response(create_id).await;
        let pty_id = created["id"].as_str().unwrap().to_string();

        #[derive(Serialize)]
        struct Input<'a> {
            id: &'a str,
            data: ByteArray<'a>,
        }
        struct ByteArray<'a>(&'a [u8]);
        impl Serialize for ByteArray<'_> {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                serializer.serialize_bytes(self.0)
            }
        }
        let input_id = client
            .request(
                "pty.input",
                &Input {
                    id: &pty_id,
                    data: ByteArray(b"echo qingcode-loopback\n"),
                },
            )
            .await;
        let (_, early_events) = client.wait_response_collecting_events(input_id).await;

        let mut live = Vec::new();
        for event in early_events {
            if let Event::PtyData { id, data, .. } = event {
                if id == pty_id {
                    live.extend_from_slice(&data);
                }
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !String::from_utf8_lossy(&live).contains("qingcode-loopback") {
            assert!(tokio::time::Instant::now() < deadline);
            let frame = read_loopback_frame(&mut client.stream).await;
            maybe_ack_loopback_ping(&mut client.stream, &frame).await;
            if frame.kind == Kind::Event {
                if let Ok(Event::PtyData { id, data, .. }) = proto::decode_value(&frame.payload) {
                    if id == pty_id {
                        live.extend_from_slice(&data);
                    }
                }
            }
        }

        drop(client);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut client = LoopbackClient::connect(&run_dir).await;
        let list_id = client.request("pty.list", &serde_json::json!({})).await;
        let listed = client.wait_response(list_id).await;
        let entry = listed["ptys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == pty_id)
            .cloned()
            .expect("daemon dropped the persistent PTY");
        assert_eq!(entry["detached"], true);

        let attach_id = client
            .request(
                "pty.attach",
                &serde_json::json!({ "id": pty_id, "fromSeq": 0 }),
            )
            .await;
        let (_, chunks) = client.wait_attach(attach_id).await;
        let replay = assemble_attach_chunks(&chunks).unwrap();
        let replayed = replay
            .into_iter()
            .flat_map(|(_, data)| data)
            .collect::<Vec<_>>();
        assert!(String::from_utf8_lossy(&replayed).contains("qingcode-loopback"));

        drop(client);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut client = LoopbackClient::connect(&run_dir).await;
        let kill_id = client
            .request("pty.kill", &serde_json::json!({ "id": pty_id }))
            .await;
        client.wait_response(kill_id).await;
        let list_id = client.request("pty.list", &serde_json::json!({})).await;
        let listed = client.wait_response(list_id).await;
        assert!(listed["ptys"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["id"] != pty_id));

        let shutdown_id = client
            .request("server.shutdown", &serde_json::json!({}))
            .await;
        client.wait_response(shutdown_id).await;
        let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
        let _ = std::fs::remove_dir_all(&state_dir);
    }
}
