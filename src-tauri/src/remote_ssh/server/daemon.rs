//! daemon 传输层（qingcode-server daemon 模式，协议 v1 帧流）：
//! SSH exec 通道内运行 `connect --stdio --ensure-daemon`，与远端常驻
//! daemon 之间完成 HELLO 握手、RPC、scan/search/watch 调用与降级管理。

use std::io;

use super::paths::server_binary_path;
use super::scripts::{connect_daemon_command, daemon_token_command, start_daemon_command};
use super::*;
use qingcode_server::proto::{
    self, ErrorBody, Frame, HelloRequest, HelloResponse, Kind, ReceiverWindow, Request, Response,
    StreamChunk, StreamEnd, WindowCredit, CONTROL_STREAM, PROTOCOL_VERSION, WINDOW_BYTES,
};
use qingcode_server::SERVER_VERSION;

/// daemon 握手应答时限：`connect --ensure-daemon` 可能在通道内现拉 daemon
/// （代理内部启动等待上限 10s），给足余量再判失败。
const AGENT_DAEMON_HELLO_TIMEOUT: Duration = Duration::from_secs(20);
/// 部署后 daemon 就绪探测的总时限（token 轮询 + 握手探针，超出即视为本轮无 daemon）。
const AGENT_DAEMON_ENSURE_TIMEOUT: Duration = Duration::from_secs(10);
/// daemon `fs.scan` 请求的整体时限（与 serve 路径的 15s 对齐）。
const AGENT_DAEMON_SCAN_TIMEOUT: Duration = Duration::from_secs(15);
/// daemon 传输降级后的重试冷却：降级时间戳超过这个时长，ensure 快路径
/// 才会重新探测 daemon，避免每次操作都对着一个已知失败的 daemon 空转。
const AGENT_DAEMON_RETRY_AFTER_DOWNGRADE: Duration = Duration::from_secs(5 * 60);

/// 单请求 exec 通道上的请求 id。通道不做多路复用（见 [`DaemonChannel`]），
/// 一条通道同时只有一个在途请求。
const DAEMON_REQUEST_ID: u32 = 1;

/// 已完成 HELLO 握手的 daemon 连接：SSH exec 通道内运行
/// `connect --stdio --ensure-daemon`，代理把帧流原样转发给远端 daemon。
///
/// 通道策略（刻意从简）：**每次方法调用开一条独立的 exec 通道**，通道内只有
/// 一个在途请求（watch 也只有一路订阅流），请求 id 固定为
/// [`DAEMON_REQUEST_ID`]，不做多路复用。scan/search 是短命操作，通道开销
/// （一次 exec + connect 进程 + 本地 socket 转发）远小于请求路由与并发复用
/// 的复杂度；真正需要 stream_id 路由和发送优先级的是 PTY 接入（下一轮），
/// 届时再改为「一条常驻通道 + 按 stream_id 分发」。
pub(crate) struct DaemonChannel {
    channel: russh::Channel<client::Msg>,
    /// 已到达但尚未构成完整帧的字节：代理转发的是裸字节流，不保证按帧到达。
    buffer: Vec<u8>,
}

impl DaemonChannel {
    async fn send(&mut self, frame: &Frame) -> Result<(), String> {
        let bytes = frame
            .encode()
            .map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
        self.channel
            .data(&bytes[..])
            .await
            .map_err(|error| format!("发送 daemon 帧失败：{error}"))
    }

    /// 读取下一帧。PING 自动回 PONG——daemon 按「收到任意帧」计心跳，
    /// 空闲的 watch 连接全靠这个应答保活。
    ///
    /// deadline 前收不到完整帧返回 Err。`channel.wait()` 是 cancel-safe 的，
    /// 超时不会丢已到达的字节；但调用方此后应丢弃整条通道（回退 serve）。
    pub(super) async fn next_frame(&mut self, deadline: Instant) -> Result<Frame, String> {
        loop {
            match proto::decode(&self.buffer) {
                Ok((frame, used)) => {
                    self.buffer.drain(..used);
                    if frame.kind == Kind::Ping {
                        let _ = self.send(&Frame::empty(Kind::Pong, frame.stream_id)).await;
                        continue;
                    }
                    return Ok(frame);
                }
                // 半帧：等待后续字节。
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {}
                Err(error) => return Err(format!("daemon 帧解析失败：{error}")),
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("daemon 响应超时".to_string());
            }
            match tokio::time::timeout(deadline - now, self.channel.wait()).await {
                // 代理进程退出（daemon 拒绝连接 / 已下线 / 会话结束）。
                Ok(None) => return Err("daemon 连接代理已退出".to_string()),
                Ok(Some(ChannelMsg::Data { data })) => self.buffer.extend_from_slice(&data),
                // 代理只转发 daemon 字节流，stderr 出现即启动失败（如 socket 连不上）。
                Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                    return Err(format!(
                        "daemon 连接代理报错：{}",
                        String::from_utf8_lossy(&data).trim()
                    ));
                }
                Ok(Some(ChannelMsg::Eof) | Some(ChannelMsg::Close)) => {
                    return Err("daemon 连接已关闭".to_string());
                }
                Ok(Some(_)) => {}
                Err(_) => return Err("daemon 响应超时".to_string()),
            }
        }
    }

    /// 尽力关闭通道：exec 通道被丢弃时不会自动 CLOSE，显式关闭避免长期
    /// 占用 sshd 的 MaxSessions 名额。
    pub(super) async fn shutdown(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(1), self.channel.close()).await;
    }
}

/// 校验 daemon 的 HELLO 应答：协议版本、server 版本一致，且本轮要用到的
/// 能力都已声明。任何不符都视为 daemon 不可用（回退 serve）。
fn validate_daemon_hello(response: &HelloResponse) -> Result<(), String> {
    if response.protocol != PROTOCOL_VERSION {
        return Err(format!("daemon 协议版本不兼容：{}", response.protocol));
    }
    if response.server_version != SERVER_VERSION {
        return Err(format!(
            "daemon 版本不匹配：远端 {}，本端 {SERVER_VERSION}",
            response.server_version
        ));
    }
    for capability in ["fs.scan", "search.content", "watch.subscribe"] {
        if !response.capabilities.iter().any(|item| item == capability) {
            return Err(format!("daemon 缺少能力 {capability}"));
        }
    }
    Ok(())
}

/// 打开一条 daemon 传输通道并完成握手。
///
/// exec 通道跑 `connect --stdio --ensure-daemon`：daemon 缺席时由代理拉起，
/// HELLO 携带 token 与协议区间 `[1, 1]`，daemon 校验 token / 协议后回 HELLO。
/// 任何一步失败都返回 Err，由调用方决定降级。
pub(super) async fn open_daemon_channel(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
) -> Result<DaemonChannel, String> {
    let channel = manager
        .open_session_channel(connection_id, "server 守护进程 ")
        .await?;
    if let Err(error) = channel
        .exec(true, connect_daemon_command(&daemon.bin))
        .await
    {
        let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        return Err(format!("启动 daemon 连接代理失败：{error}"));
    }
    let mut channel = DaemonChannel {
        channel,
        buffer: Vec::new(),
    };
    let hello = HelloRequest {
        // 设计上 client_id 标识 QingCode 安装实例；这里用连接 id（同一 SSH
        // 配置稳定不变）。daemon 本期只透传记录，不作鉴权。
        client_id: connection_id.to_string(),
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        token: daemon.token.clone(),
        resume_token: None,
    };
    channel
        .send(&Frame::new(
            Kind::Hello,
            CONTROL_STREAM,
            proto::encode(&hello).map_err(|error| format!("编码 HELLO 失败：{error}"))?,
        ))
        .await?;
    let response = channel
        .next_frame(Instant::now() + AGENT_DAEMON_HELLO_TIMEOUT)
        .await?;
    if response.kind != Kind::Hello {
        return Err(format!("daemon 握手应答异常（{}）", response.kind.as_str()));
    }
    let hello: HelloResponse = proto::decode_value(&response.payload)
        .map_err(|error| format!("解析 daemon HELLO 失败：{error}"))?;
    validate_daemon_hello(&hello)?;
    Ok(channel)
}

/// 握手探针：验证 token / 版本 / 能力后立即关闭。
async fn probe_daemon(manager: &SshManager, connection_id: &str, access: &DaemonAccess) -> bool {
    match open_daemon_channel(manager, connection_id, access).await {
        Ok(mut channel) => {
            channel.shutdown().await;
            true
        }
        Err(_) => false,
    }
}

/// serve server 就绪后尽力补一步 daemon 传输探测：
/// 1. 幂等启动 daemon（重复执行因 `flock` 抢不到锁直接退出，无副作用）；
/// 2. 轮询读取 `run/token`（daemon 启动到 token 落盘有亚秒级延迟；旧 daemon
///    残留的 token 会被下一步的真实握手淘汰）；
/// 3. 用一次真实握手验证 token、版本与能力，通过才标记 daemon 可用。
///
/// 任一步失败都返回 `None`：仅表示本轮无 daemon，不影响 serve 模式。
pub(super) async fn ensure_remote_daemon(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    remote_bin: Option<&str>,
) -> Option<DaemonAccess> {
    // daemon / connect 只在 unix 远端编译。Windows 停在 serve。
    if windows_native_path(&root.canonical_path).is_some() {
        return None;
    }
    let bin = match remote_bin {
        Some(bin) => bin.to_string(),
        None => {
            let arch = manager
                .exec_command(&root.uri, "uname -m", None, true, REMOTE_EXEC_TIMEOUT)
                .await
                .ok()?
                .stdout
                .trim()
                .to_string();
            if arch != "x86_64" && arch != "aarch64" {
                return None;
            }
            server_binary_path(&root.canonical_path, &arch)
        }
    };
    let _ = manager
        .exec_command(
            &root.uri,
            &start_daemon_command(&bin),
            None,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await;
    let deadline = Instant::now() + AGENT_DAEMON_ENSURE_TIMEOUT;
    loop {
        if let Ok(result) = manager
            .exec_command(
                &root.uri,
                &daemon_token_command(),
                None,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await
        {
            let access = DaemonAccess {
                bin: bin.clone(),
                token: result.stdout.trim().to_string(),
            };
            if !access.token.is_empty() && probe_daemon(manager, connection_id, &access).await {
                return Some(access);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// 记录「daemon 传输暂不可用」：保留 serve 端点，只清 daemon 标记并记下降级
/// 时间。该连接 + 根的后续操作直接走 serve 模式；冷却
/// [`AGENT_DAEMON_RETRY_AFTER_DOWNGRADE`] 后 ensure 快路径会重新探测——
/// 之前一次失败就永久清标记，daemon 崩溃后整条连接再也回不去 daemon 传输。
pub(crate) fn downgrade_server_daemon(manager: &SshManager, key: &str) {
    let Some(mut slot) = manager.server_slot(key) else {
        return;
    };
    let Some(endpoint) = slot.endpoint.as_mut() else {
        return;
    };
    endpoint.daemon = None;
    slot.daemon_downgraded_at = Some(Instant::now());
    manager.set_server_slot(key, slot);
}

/// 尽力让远端 daemon 退出：一次真实握手（token 校验）+ `server.shutdown` RPC。
/// daemon 已下线、token 失效或通道失败都只返回 false——调用方（restart/stop）
/// 把它当 best-effort，随后的 ensure 会重新拉起 daemon。
pub(crate) async fn shutdown_remote_daemon(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
) -> bool {
    let mut channel = match open_daemon_channel(manager, connection_id, daemon).await {
        Ok(channel) => channel,
        Err(_) => return false,
    };
    let result = daemon_rpc(
        &mut channel,
        "server.shutdown",
        &serde_json::json!({}),
        Instant::now() + AGENT_PING_TIMEOUT,
    )
    .await;
    channel.shutdown().await;
    result.is_ok()
}

/// daemon 通道上的单请求 RPC：发 REQ、等 RES 或 ERR，返回 RES 的 result。
pub(super) async fn daemon_rpc(
    channel: &mut DaemonChannel,
    method: &str,
    params: &serde_json::Value,
    deadline: Instant,
) -> Result<serde_json::Value, String> {
    let request = Request::with_params(DAEMON_REQUEST_ID, method, params)
        .map_err(|error| format!("编码 daemon 请求失败：{error}"))?;
    let payload =
        proto::encode(&request).map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
    channel
        .send(&Frame::new(Kind::Req, DAEMON_REQUEST_ID, payload))
        .await?;
    loop {
        let frame = channel.next_frame(deadline).await?;
        match frame.kind {
            Kind::Res if frame.stream_id == DAEMON_REQUEST_ID => {
                let response: Response = proto::decode_value(&frame.payload)
                    .map_err(|error| format!("解析 daemon 应答失败：{error}"))?;
                return Ok(response.result);
            }
            Kind::Err if frame.stream_id == DAEMON_REQUEST_ID => {
                let body: ErrorBody = proto::decode_value(&frame.payload)
                    .map_err(|error| format!("解析 daemon 错误帧失败：{error}"))?;
                return Err(format!(
                    "daemon {method} 失败（{}）：{}",
                    body.code, body.message
                ));
            }
            _ => {}
        }
    }
}

/// daemon 通道上列出目录直接子项，替代 serve 的 scan 请求。
/// 返回 (名称, 是否目录)，交给调用方 `collect_scan_nodes` 统一组装。
pub(crate) async fn daemon_scan_entries(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    canonical_root: &str,
    relative: &str,
) -> Result<Vec<(String, bool)>, String> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let params = serde_json::json!({ "root": canonical_root, "path": relative });
        let value = daemon_rpc(
            &mut channel,
            "fs.scan",
            &params,
            Instant::now() + AGENT_DAEMON_SCAN_TIMEOUT,
        )
        .await?;
        let entries = value
            .get("entries")
            .and_then(|entries| entries.as_array())
            .ok_or_else(|| "daemon scan 应答缺少 entries".to_string())?;
        let mut parsed = Vec::with_capacity(entries.len());
        for entry in entries {
            let Some(name) = entry.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            let is_dir = entry
                .get("isDir")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            parsed.push((name.to_string(), is_dir));
        }
        Ok(parsed)
    }
    .await;
    channel.shutdown().await;
    result
}

/// daemon 通道的内容搜索参数，与 daemon 的 `search.content` 方法一一对应。
pub(crate) struct DaemonSearchParams {
    pub root: String,
    pub query: String,
    pub ignore_case: bool,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub no_ignore: bool,
    pub max_matches: usize,
    pub max_per_file: usize,
    pub max_files: usize,
}

/// STREAM_DATA 分片重组：搜索是「记录流」（`seq` 为空，`last` 标记记录末块）。
/// SSH 通道保证字节有序，分片按到达顺序拼接即可，`offset` 只作校验用途。
#[derive(Default)]
struct RecordAssembler {
    buffer: Vec<u8>,
}

impl RecordAssembler {
    /// 追加一个分片；记录完整时返回整段字节并清空缓冲。
    fn push(&mut self, chunk: &StreamChunk) -> Option<Vec<u8>> {
        self.buffer.extend_from_slice(&chunk.data);
        chunk.last.then(|| std::mem::take(&mut self.buffer))
    }
}

/// daemon 通道上的流式内容搜索，替代 serve 的 searchContent：
/// STREAM_DATA 分片重组为 rg `--json` 同形记录（MessagePack 编码的 JSON 值），
/// 逐条交给 on_record（返回 false 即提前结束）。取消时发 CANCEL 帧后继续
/// 读到 STREAM_END，让 daemon 干净收尾；返回值语义与 serve 路径的
/// [`server_stream_call`] 一致，调用方共用同一条回退链。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn daemon_search_content_call(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    params: DaemonSearchParams,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
    mut on_record: impl FnMut(&serde_json::Value) -> bool,
) -> Result<ServerStreamOutcome, String> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let request = Request::with_params(
            DAEMON_REQUEST_ID,
            "search.content",
            &serde_json::json!({
                "root": params.root,
                "query": params.query,
                "ignoreCase": params.ignore_case,
                "includeGlobs": params.include_globs,
                "excludeGlobs": params.exclude_globs,
                "noIgnore": params.no_ignore,
                "maxMatches": params.max_matches,
                "maxPerFile": params.max_per_file,
                "maxFiles": params.max_files,
            }),
        )
        .map_err(|error| format!("编码 daemon 请求失败：{error}"))?;
        let payload =
            proto::encode(&request).map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
        channel
            .send(&Frame::new(Kind::Req, DAEMON_REQUEST_ID, payload))
            .await?;

        // daemon 发送侧有 256KB 信用窗口：消费后按半个窗口回补 WINDOW 帧，
        // 否则长流会在窗口耗尽时被卡死（serve 路径无流控，协议 v1 要求）。
        let mut receiver = ReceiverWindow::new(WINDOW_BYTES);
        let mut assembler = RecordAssembler::default();
        // CANCEL 已发出：继续读到 STREAM_END 让远端收尾，不再消费记录。
        let mut stopping = false;
        loop {
            if !stopping && cancelled() {
                channel
                    .send(&Frame::empty(Kind::Cancel, DAEMON_REQUEST_ID))
                    .await?;
                stopping = true;
            }
            if Instant::now() >= deadline {
                if stopping {
                    // CANCEL 已发但远端迟迟不收尾：放弃等待，通道随关闭收尾。
                    return Ok(ServerStreamOutcome::Stopped);
                }
                return Err("server 操作超时".to_string());
            }
            let frame = channel.next_frame(deadline).await?;
            match frame.kind {
                Kind::StreamData if frame.stream_id == DAEMON_REQUEST_ID => {
                    if let Some(credit) = receiver.consume(frame.payload.len()) {
                        let payload = proto::encode(&WindowCredit { credit })
                            .map_err(|error| format!("编码 WINDOW 帧失败：{error}"))?;
                        let _ = channel
                            .send(&Frame::new(Kind::Window, DAEMON_REQUEST_ID, payload))
                            .await;
                    }
                    if stopping {
                        continue;
                    }
                    let chunk: StreamChunk = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 流分片失败：{error}"))?;
                    if let Some(record) = assembler.push(&chunk) {
                        let value: serde_json::Value = proto::decode_value(&record)
                            .map_err(|error| format!("解析 daemon 搜索记录失败：{error}"))?;
                        if !on_record(&value) {
                            channel
                                .send(&Frame::empty(Kind::Cancel, DAEMON_REQUEST_ID))
                                .await?;
                            stopping = true;
                        }
                    }
                }
                Kind::StreamEnd if frame.stream_id == DAEMON_REQUEST_ID => {
                    let end: StreamEnd = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 流结束帧失败：{error}"))?;
                    if stopping {
                        return Ok(ServerStreamOutcome::Stopped);
                    }
                    if !end.ok {
                        return Err(end.error.unwrap_or_else(|| "daemon 搜索失败".to_string()));
                    }
                    return Ok(ServerStreamOutcome::Done {
                        truncated: end
                            .summary
                            .get("truncated")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        files_scanned: end
                            .summary
                            .get("filesScanned")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as usize,
                    });
                }
                Kind::Err if frame.stream_id == DAEMON_REQUEST_ID => {
                    let body: ErrorBody = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 错误帧失败：{error}"))?;
                    return Err(format!(
                        "daemon 搜索失败（{}）：{}",
                        body.code, body.message
                    ));
                }
                _ => {}
            }
        }
    }
    .await;
    channel.shutdown().await;
    result
}

/// daemon 降级冷却是否到点。`None`（从未降级）不需要重试。
pub(super) fn daemon_downgrade_retry_ready(downgraded_at: Option<Instant>, now: Instant) -> bool {
    downgraded_at.is_some_and(|at| now.duration_since(at) >= AGENT_DAEMON_RETRY_AFTER_DOWNGRADE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_daemon_access() -> DaemonAccess {
        DaemonAccess {
            bin: "/srv/app/.qingcode/server/qingcode-server-x86_64".to_string(),
            token: "token-123".to_string(),
        }
    }

    fn hello_response(protocol: u32, version: &str, capabilities: &[&str]) -> HelloResponse {
        HelloResponse {
            protocol,
            server_version: version.to_string(),
            pid: 42,
            os: "linux".into(),
            arch: "x86_64".into(),
            home: Some("/home/dev".into()),
            shells: vec!["bash".into()],
            capabilities: capabilities.iter().map(|item| item.to_string()).collect(),
            pty_count: 0,
        }
    }

    #[test]
    fn daemon_hello_validation_accepts_compatible_daemon() {
        let response = hello_response(
            PROTOCOL_VERSION,
            SERVER_VERSION,
            &[
                "fs.scan",
                "search.content",
                "watch.subscribe",
                "pty.persist",
            ],
        );
        assert!(validate_daemon_hello(&response).is_ok());
    }

    #[test]
    fn daemon_hello_validation_rejects_version_and_capability_gaps() {
        // 协议版本不符：回退 serve。
        assert!(validate_daemon_hello(&hello_response(99, SERVER_VERSION, &[])).is_err());
        // daemon 版本过期（旧进程还占着 flock 时可能出现）：回退 serve。
        assert!(validate_daemon_hello(&hello_response(
            PROTOCOL_VERSION,
            "0.0.9",
            &["fs.scan", "search.content", "watch.subscribe"]
        ))
        .is_err());
        // 能力缺失：回退 serve。
        assert!(validate_daemon_hello(&hello_response(
            PROTOCOL_VERSION,
            SERVER_VERSION,
            &["fs.scan"]
        ))
        .is_err());
    }

    #[test]
    fn record_assembler_reassembles_chunked_records_independently() {
        let mut assembler = RecordAssembler::default();
        // 第一条记录拆两个分片。
        let first = StreamChunk {
            seq: None,
            offset: 0,
            data: b"{\"type\":\"ma".to_vec(),
            last: false,
        };
        let second = StreamChunk {
            seq: None,
            offset: 12,
            data: b"tch\"}".to_vec(),
            last: true,
        };
        assert!(assembler.push(&first).is_none());
        assert_eq!(
            assembler.push(&second).as_deref(),
            Some(&b"{\"type\":\"match\"}"[..])
        );
        // 第二条记录单分片完整，与上一条互不混淆。
        let third = StreamChunk {
            seq: None,
            offset: 0,
            data: b"{}".to_vec(),
            last: true,
        };
        assert_eq!(assembler.push(&third).as_deref(), Some(&b"{}"[..]));
        // 空记录（空数据 + last）也要出结果。
        let empty = StreamChunk {
            seq: None,
            offset: 0,
            data: Vec::new(),
            last: true,
        };
        assert!(assembler
            .push(&empty)
            .is_some_and(|record| record.is_empty()));
    }

    #[test]
    fn daemon_downgrade_keeps_serve_endpoint() {
        let manager = SshManager::new();
        let key = server_slot_key("c1", "/srv/app");
        // 没有端点时降级是空操作，不报错。
        downgrade_server_daemon(&manager, &key);
        manager.set_server_slot(
            &key,
            ServerSlot {
                endpoint: Some(ServerEndpoint {
                    port: 4000,
                    token: "t".to_string(),
                    daemon: Some(sample_daemon_access()),
                }),
                ..Default::default()
            },
        );
        downgrade_server_daemon(&manager, &key);
        let slot = manager.server_slot(&key).unwrap();
        let endpoint = slot.endpoint.as_ref().unwrap();
        // serve 端点保留，仅 daemon 标记被清掉：后续操作直接走 serve。
        assert_eq!(endpoint.port, 4000);
        assert!(endpoint.daemon.is_none());
        // 降级时间被记录：冷却 5 分钟后 ensure 快路径才会重新探测 daemon。
        assert!(slot.daemon_downgraded_at.is_some());
        assert!(!daemon_downgrade_retry_ready(
            slot.daemon_downgraded_at,
            Instant::now()
        ));
        assert!(daemon_downgrade_retry_ready(
            slot.daemon_downgraded_at
                .map(|at| at - AGENT_DAEMON_RETRY_AFTER_DOWNGRADE),
            Instant::now()
        ));
        // 从未降级（None）不需要重试。
        assert!(!daemon_downgrade_retry_ready(None, Instant::now()));
    }

    #[test]
    fn daemon_request_params_roundtrip_as_msgpack_map() {
        let request = Request::with_params(
            DAEMON_REQUEST_ID,
            "fs.scan",
            &serde_json::json!({ "root": "/srv/app", "path": "src" }),
        )
        .unwrap();
        let bytes = proto::encode(&request).unwrap();
        let decoded: Request = proto::decode_value(&bytes).unwrap();
        assert_eq!(decoded.method, "fs.scan");
        let params: serde_json::Value = decoded.parse().unwrap();
        assert_eq!(params["root"], "/srv/app");
        assert_eq!(params["path"], "src");
        // HELLO 请求同样走 MessagePack map：字段名按 camelCase 编码。
        let hello = HelloRequest {
            client_id: "c1".into(),
            protocol_min: PROTOCOL_VERSION,
            protocol_max: PROTOCOL_VERSION,
            token: "t".into(),
            resume_token: None,
        };
        let decoded: HelloRequest = proto::decode_value(&proto::encode(&hello).unwrap()).unwrap();
        assert_eq!(decoded.client_id, "c1");
        assert_eq!(decoded.protocol_min, PROTOCOL_VERSION);
    }
}
