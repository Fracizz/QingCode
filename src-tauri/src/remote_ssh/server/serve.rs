//! serve 传输通道：每操作一条 `direct-tcpip` 通道连远端 `127.0.0.1:<port>`，
//! JSON 帧（`ServerRequest` / `ServerResponse`）。含 ping 校验与通用流式调用。

use super::*;
use qingcode_server::{
    read_frame, write_frame, ServerOp, ServerRequest, ServerResponse, SERVER_VERSION,
};

/// 打开一条指向远端 server 的 `direct-tcpip` 通道（单次尝试）。
async fn open_server_channel_once(
    session: &ConnectedSession,
    port: u16,
) -> Result<russh::Channel<client::Msg>, ChannelOpenError> {
    let opened = tokio::time::timeout(
        SSH_CHANNEL_OPEN_TIMEOUT,
        session
            .handle
            .channel_open_direct_tcpip("127.0.0.1", u32::from(port), "127.0.0.1", 0),
    )
    .await;
    match opened {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(error)) => Err(ChannelOpenError {
            message: format!("打开 server 通道失败：{error}"),
            stale: is_stale_russh_error(&error) || session.handle.is_closed(),
        }),
        // 会话半死时开通道也不会返回；超时后探测一次再决定是否重连。
        Err(_) => Err(ChannelOpenError {
            message: "打开 SSH server 通道超时，远端未响应".to_string(),
            stale: !connection_responds(&session.handle).await,
        }),
    }
}

/// 打开 server 通道，镜像 `SshManager::open_session_channel` 的 stale/busy 处理。
pub(crate) async fn open_server_channel(
    manager: &SshManager,
    connection_id: &str,
    port: u16,
) -> Result<russh::Channel<client::Msg>, String> {
    let session = manager.live_session(connection_id).await?;
    match open_server_channel_once(&session, port).await {
        Ok(channel) => Ok(channel),
        Err(error) if error.stale => {
            let session = manager
                .reconnect_after_channel_failure(connection_id, &session)
                .await?;
            Ok(open_server_channel_once(&session, port).await?)
        }
        Err(error) => Err(error.message),
    }
}

/// 发送一个请求帧并读取单个响应帧（带超时）。
async fn server_roundtrip(
    channel: russh::Channel<client::Msg>,
    request: &ServerRequest,
) -> Result<ServerResponse, String> {
    let mut stream = channel.into_stream();
    let payload =
        serde_json::to_vec(request).map_err(|error| format!("编码 server 请求失败：{error}"))?;
    write_frame(&mut stream, &payload)
        .await
        .map_err(|error| format!("发送 server 请求失败：{error}"))?;
    let bytes = tokio::time::timeout(AGENT_PING_TIMEOUT, read_frame(&mut stream))
        .await
        .map_err(|_| "server 响应超时".to_string())?
        .map_err(|error| format!("读取 server 响应失败：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析 server 响应失败：{error}"))
}

/// ping 校验：响应必须是 `Ok` 且版本与客户端一致（不一致说明需要重新部署）。
pub(super) async fn ping_server(
    manager: &SshManager,
    connection_id: &str,
    endpoint: &ServerEndpoint,
) -> Result<(), String> {
    let serve = endpoint.serve.as_ref().ok_or("项目 serve 尚未启动")?;
    let channel = open_server_channel(manager, connection_id, serve.port).await?;
    let request = ServerRequest {
        token: serve.token.clone(),
        op: ServerOp::Ping,
    };
    match server_roundtrip(channel, &request).await? {
        ServerResponse::Ok { version } if version == SERVER_VERSION => Ok(()),
        ServerResponse::Ok { version } => Err(format!(
            "server 版本不匹配：远端 {version}，本端 {SERVER_VERSION}"
        )),
        ServerResponse::Error { message } => Err(message),
        _ => Err("server 返回了意外的 ping 响应".to_string()),
    }
}

/// 单次流式操作的收尾方式。
pub(crate) enum ServerStreamOutcome {
    Done {
        truncated: bool,
        files_scanned: usize,
    },
    /// 客户端取消或 on_record 返回 false，提前结束。
    Stopped,
}

/// 通用流式调用：单连接承载单次操作，records 逐条交给 on_record，
/// 返回 false 即提前停止。帧读取错误一律返回 Err，由调用方决定回退。
pub(crate) async fn server_stream_call(
    manager: &SshManager,
    connection_id: &str,
    endpoint: &ServerEndpoint,
    request: ServerRequest,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
    mut on_record: impl FnMut(&serde_json::Value) -> bool,
) -> Result<ServerStreamOutcome, String> {
    let serve = endpoint.serve.as_ref().ok_or("项目 serve 尚未启动")?;
    let channel = open_server_channel(manager, connection_id, serve.port).await?;
    let mut stream = channel.into_stream();
    let payload =
        serde_json::to_vec(&request).map_err(|error| format!("编码 server 请求失败：{error}"))?;
    write_frame(&mut stream, &payload)
        .await
        .map_err(|error| format!("发送 server 请求失败：{error}"))?;
    loop {
        // 100ms 轮询窗口检查取消与超时，但读取 future 跨窗口保留：
        // `read_frame` 内部是 read_exact，被超时丢弃会吃掉半帧、破坏后续解析。
        let mut frame = Box::pin(read_frame(&mut stream));
        let bytes = loop {
            if cancelled() {
                // 丢弃通道即断开连接，远端会尽快收尾。
                return Ok(ServerStreamOutcome::Stopped);
            }
            if Instant::now() >= deadline {
                return Err("server 操作超时".to_string());
            }
            match tokio::time::timeout(Duration::from_millis(100), &mut frame).await {
                Err(_) => continue,
                Ok(Err(error)) => return Err(format!("server 连接中断：{error}")),
                Ok(Ok(bytes)) => break bytes,
            }
        };
        let response: ServerResponse = serde_json::from_slice(&bytes)
            .map_err(|error| format!("解析 server 响应失败：{error}"))?;
        match response {
            ServerResponse::Records { data } => {
                for record in &data {
                    if !on_record(record) {
                        return Ok(ServerStreamOutcome::Stopped);
                    }
                }
            }
            ServerResponse::Done {
                truncated,
                files_scanned,
            } => {
                return Ok(ServerStreamOutcome::Done {
                    truncated,
                    files_scanned,
                });
            }
            ServerResponse::Error { message } => return Err(message),
            ServerResponse::Ok { version } => {
                // 单次操作连接只回 records/done/error，ok 只属于 ping。
                return Err(format!("server 返回了意外的响应（版本 {version}）"));
            }
        }
    }
}
