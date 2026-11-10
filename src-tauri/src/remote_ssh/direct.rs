//! Independent Agent connection. Discovery never sends credentials; every
//! authenticated request pins the certificate explicitly accepted by the user.

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::net::TcpStream;
use tokio_rustls::{client::TlsStream, TlsConnector};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http, Message};
use tokio_tungstenite::WebSocketStream;

mod workspace_http;
pub(super) use workspace_http::{discard_tunnel_idle, WorkspaceClient};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEALTH_BYTES: usize = 64 * 1024;
/// TCP 拨号失败文案的固定开头，前端 serverModeError.ts 靠它提供“重试”。
const DIAL_FAILED_PREFIX: &str = "[direct:unreachable] 无法连接";
/// 连接超时的分类标签；前端 serverModeError.ts 靠它提供“重试”而非重启服务。
const TIMEOUT_TAG: &str = "[direct:timeout]";
/// 建立终端通道时的拨号重试间隔，用来跨过客户端更新重启、链路抖动这类短暂中断。
/// 总耗时受 CONNECT_TIMEOUT 约束；设置页的连接测试不重试，保持快速失败。
const DIAL_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(1_000)];
/// 把连接判定为断开前，健康检查失败后再确认一次的等待时间。
const HEALTH_RETRY_DELAY: Duration = Duration::from_millis(500);

/// 直连通道的探活参数。路径上的设备可能静默丢弃已建立的 TCP 连接（无 FIN/RST），
/// 只能靠应用层探测发现。有入站数据就不发 ping，正常使用时几乎没有额外流量。
#[derive(Clone, Copy)]
struct StreamProbeTimings {
    /// 入站静默多久后发一次 ping。
    idle_ms: u64,
    /// 发出数据后多久仍无任何入站就提前 ping，让正在输入的终端更快发现断流。
    after_send_ms: u64,
    /// ping 发出后多久仍无任何入站，判定连接已死。
    timeout_ms: u64,
}

const STREAM_PROBE_DIRECT: StreamProbeTimings = StreamProbeTimings {
    idle_ms: 5_000,
    after_send_ms: 1_000,
    timeout_ms: 4_000,
};

/// SSH 隧道延迟更高且有自己的 keepalive，放宽判定，避免慢链路上误重连。
const STREAM_PROBE_TUNNEL: StreamProbeTimings = StreamProbeTimings {
    idle_ms: 10_000,
    after_send_ms: 3_000,
    timeout_ms: 15_000,
};

#[derive(Debug, PartialEq, Eq)]
enum ProbeStep {
    /// 什么都不用做，到这个时刻（毫秒）再检查。
    Wait(u64),
    Ping,
    Dead,
}

#[derive(Default)]
struct StreamProbe {
    last_sent: Option<u64>,
    ping_at: Option<u64>,
}

impl StreamProbe {
    /// `consumer_busy`：本端正等上层腾出缓冲，此时收不到 pong 不代表连接已死。
    fn step(
        &mut self,
        timings: &StreamProbeTimings,
        now: u64,
        last_inbound: u64,
        consumer_busy: bool,
    ) -> ProbeStep {
        if consumer_busy {
            self.ping_at = None;
            return ProbeStep::Wait(now + timings.idle_ms);
        }
        if self.ping_at.is_some_and(|at| last_inbound >= at) {
            self.ping_at = None;
        }
        if let Some(at) = self.ping_at {
            let deadline = at + timings.timeout_ms;
            return if now >= deadline {
                ProbeStep::Dead
            } else {
                ProbeStep::Wait(deadline)
            };
        }
        let mut due = last_inbound + timings.idle_ms;
        if let Some(sent) = self.last_sent.filter(|sent| *sent >= last_inbound) {
            due = due.min(sent + timings.after_send_ms);
        }
        if now >= due {
            self.ping_at = Some(now);
            ProbeStep::Ping
        } else {
            ProbeStep::Wait(due)
        }
    }
}

/// 通道异常结束的真实原因，只写入诊断日志；本端主动关闭不算异常。
#[derive(Debug)]
struct StreamFailure {
    cause: &'static str,
    detail: Option<String>,
    os_error: Option<i32>,
    idle_ms: u64,
}

impl StreamFailure {
    fn new(cause: &'static str) -> Self {
        Self {
            cause,
            detail: None,
            os_error: None,
            idle_ms: 0,
        }
    }

    fn websocket(cause: &'static str, error: &tokio_tungstenite::tungstenite::Error) -> Self {
        let os_error = match error {
            tokio_tungstenite::tungstenite::Error::Io(error) => error.raw_os_error(),
            _ => None,
        };
        Self {
            detail: Some(qingcode_server::diagnostics::error_summary(
                &error.to_string(),
            )),
            os_error,
            ..Self::new(cause)
        }
    }
}

/// 在 WebSocket 与上层字节流之间转发，并探测连接存活。上传、探活共用一个循环和
/// 一个定时器，定时器只在到期时检查，不随每条消息重置，高吞吐时没有额外开销。
async fn bridge_stream<S>(
    socket: WebSocketStream<S>,
    network: DuplexStream,
    cancelled: Arc<tokio::sync::Notify>,
    timings: StreamProbeTimings,
) -> Result<(), StreamFailure>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let started = tokio::time::Instant::now();
    let elapsed_ms = || started.elapsed().as_millis() as u64;
    let last_inbound = AtomicU64::new(0);
    let consumer_busy = AtomicBool::new(false);
    let local_closing = AtomicBool::new(false);
    let (mut sender, mut receiver) = socket.split();
    let (mut input, mut output) = tokio::io::split(network);
    let upload = async {
        let mut buffer = vec![0u8; 64 * 1024];
        let mut probe = StreamProbe::default();
        loop {
            let step = probe.step(
                &timings,
                elapsed_ms(),
                last_inbound.load(Ordering::Relaxed),
                consumer_busy.load(Ordering::Relaxed),
            );
            let wake_at = match step {
                ProbeStep::Dead => return Err(StreamFailure::new("probe_timeout")),
                ProbeStep::Ping => {
                    sender
                        .send(Message::Ping(Vec::new().into()))
                        .await
                        .map_err(|error| StreamFailure::websocket("write_error", &error))?;
                    continue;
                }
                ProbeStep::Wait(at) => at,
            };
            tokio::select! {
                read = input.read(&mut buffer) => {
                    let size = read.unwrap_or(0);
                    if size == 0 {
                        break;
                    }
                    sender
                        .send(Message::Binary(buffer[..size].to_vec().into()))
                        .await
                        .map_err(|error| StreamFailure::websocket("write_error", &error))?;
                    probe.last_sent = Some(elapsed_ms());
                }
                _ = tokio::time::sleep_until(started + Duration::from_millis(wake_at)) => {}
            }
        }
        local_closing.store(true, Ordering::Relaxed);
        let _ = sender.close().await;
        Ok(())
    };
    let download = async {
        while let Some(message) = receiver.next().await {
            let message =
                message.map_err(|error| StreamFailure::websocket("read_error", &error))?;
            match message {
                Message::Binary(bytes) => {
                    consumer_busy.store(true, Ordering::Relaxed);
                    let written = output.write_all(&bytes).await;
                    consumer_busy.store(false, Ordering::Relaxed);
                    if written.is_err() {
                        return Ok(());
                    }
                }
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) => {}
                _ => return Err(StreamFailure::new("protocol_error")),
            }
            last_inbound.store(elapsed_ms(), Ordering::Relaxed);
        }
        if local_closing.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(StreamFailure::new("peer_closed"))
        }
    };
    let result = tokio::select! {
        result = upload => result,
        result = download => result,
        _ = cancelled.notified() => Ok(()),
    };
    result.map_err(|mut failure| {
        failure.idle_ms = elapsed_ms().saturating_sub(last_inbound.load(Ordering::Relaxed));
        failure
    })
}

fn record_stream_failure(connection_id: &str, tunnel: bool, failure: &StreamFailure) {
    qingcode_server::diagnostics::record(
        "direct.stream_closed",
        serde_json::json!({
            "connectionId": qingcode_server::diagnostics::identifier(Some(connection_id)),
            "tunnel": tunnel,
            "cause": failure.cause,
            "detail": failure.detail,
            "osError": failure.os_error,
            "idleMs": failure.idle_ms,
        }),
        false,
        false,
    );
}

/// TLS 之下的字节流：TCP 直连，或 SSH 隧道的 `direct-tcpip` 通道。
pub(super) trait Transport: AsyncRead + AsyncWrite + Unpin + Send {
    /// 本端 TCP 地址；隧道通道没有。测试用它确认连接被复用。
    #[cfg_attr(not(test), allow(dead_code))]
    fn local_addr(&self) -> Option<std::net::SocketAddr> {
        None
    }
}
impl Transport for TcpStream {
    fn local_addr(&self) -> Option<std::net::SocketAddr> {
        TcpStream::local_addr(self).ok()
    }
}
impl Transport for russh::ChannelStream<russh::client::Msg> {}
pub(super) type ServerStream = TlsStream<Box<dyn Transport>>;

type ActiveStreams = Mutex<HashMap<(String, String), Vec<Weak<tokio::sync::Notify>>>>;
static ACTIVE_STREAMS: OnceLock<ActiveStreams> = OnceLock::new();

fn register_stream(address: &str, connection_id: &str) -> Arc<tokio::sync::Notify> {
    let cancelled = Arc::new(tokio::sync::Notify::new());
    let key = endpoint(address)
        .map(|endpoint| endpoint.authority)
        .unwrap_or_else(|_| address.into());
    let mut streams = ACTIVE_STREAMS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let entries = streams.entry((key, connection_id.to_string())).or_default();
    entries.retain(|entry| entry.strong_count() > 0);
    entries.push(Arc::downgrade(&cancelled));
    cancelled
}

/// Stop network bridges to force protocol reconnection after a transport change.
/// No PTY detach/kill request is sent; the daemon keeps the running process.
pub(super) fn close_connection(address: &str, connection_id: &str) {
    let key = endpoint(address)
        .map(|endpoint| endpoint.authority)
        .unwrap_or_else(|_| address.into());
    let Some(streams) = ACTIVE_STREAMS.get() else {
        return;
    };
    let entries = streams
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&(key, connection_id.to_string()))
        .unwrap_or_default();
    for cancelled in entries.into_iter().filter_map(|entry| entry.upgrade()) {
        cancelled.notify_one();
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectConnectionConfig {
    pub endpoint: String,
    pub certificate_fingerprint: String,
    pub token: String,
    /// 经该连接 ID 的 SSH 会话转发（`direct-tcpip`）；`None` 为 TCP 直连。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel: Option<String>,
}

// Credentials must never enter Debug output, including connection errors.
impl std::fmt::Debug for DirectConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirectConnectionConfig")
            .field("endpoint", &self.endpoint)
            .field("certificate_fingerprint", &self.certificate_fingerprint)
            .field("tunnel", &self.tunnel)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectHealth {
    pub healthy: bool,
    pub server_version: String,
    pub protocol: u32,
    pub port: u16,
    pub certificate_sha256: String,
}

struct Endpoint {
    host: String,
    port: u16,
    authority: String,
}

fn endpoint(value: &str) -> Result<Endpoint, String> {
    let url = url::Url::parse(value)
        .map_err(|_| "[direct:protocol] Server 地址必须是 https://主机:端口".to_string())?;
    if !matches!(url.scheme(), "https" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(
            "[direct:protocol] Server 地址只接受 HTTPS/WSS 主机与端口，不接受账号、路径或参数"
                .into(),
        );
    }
    let host = url
        .host_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "[direct:protocol] Server 主机不能为空".to_string())?
        .trim_matches(['[', ']'])
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    if port == 0 {
        return Err("[direct:protocol] 连接端口必须为 1–65535".into());
    }
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    Ok(Endpoint {
        host,
        port,
        authority,
    })
}

fn normalized_fingerprint(value: &str) -> Result<String, String> {
    let value = value.replace(':', "").to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("[direct:identity] 请先核对并确认 Server 的 SHA-256 证书指纹".into());
    }
    Ok(value)
}

#[derive(Debug)]
struct PinnedCertificate {
    expected: Option<String>,
    observed: Arc<Mutex<Option<String>>>,
}

impl ServerCertVerifier for PinnedCertificate {
    fn verify_server_cert(
        &self,
        certificate: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = format!("{:x}", Sha256::digest(certificate.as_ref()));
        *self
            .observed
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(fingerprint.clone());
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| expected != &fingerprint)
        {
            return Err(rustls::Error::General(
                "Server certificate fingerprint changed".into(),
            ));
        }
        // Trust is an explicit certificate pin, not a public CA/DNS assertion.
        // TLS handshake signatures below still prove possession of its key.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            certificate,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            certificate,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// 建立 TLS 之下的字节流。隧道只换掉这一步，证书固定与认证完全相同。
async fn dial(endpoint: &Endpoint, tunnel: Option<&str>) -> Result<Box<dyn Transport>, String> {
    if let Some(connection_id) = tunnel {
        return super::tunnel::open(connection_id, &endpoint.host, endpoint.port).await;
    }
    let stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .await
        .map_err(|error| {
            qingcode_server::diagnostics::record(
                "direct.dial_failed",
                serde_json::json!({
                    "port": endpoint.port,
                    "kind": format!("{:?}", error.kind()),
                    "osError": error.raw_os_error(),
                }),
                false,
                false,
            );
            dial_failure_message(endpoint, error.raw_os_error())
        })?;
    let _ = stream.set_nodelay(true);
    Ok(Box::new(stream))
}

fn dial_failure_message(endpoint: &Endpoint, os_error: Option<i32>) -> String {
    let code = os_error
        .map(|code| format!("（系统错误 {code}）"))
        .unwrap_or_default();
    format!(
        "{DIAL_FAILED_PREFIX} {}{code}，请确认 Server 已启动且 TCP {} 已放行",
        endpoint.authority, endpoint.port
    )
}

/// 拨号失败时还没有发送任何数据，重试是安全的；TLS、认证等其他失败立即返回。
async fn retry_dial<T, F, Fut>(mut attempt: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut delays = DIAL_RETRY_DELAYS.into_iter();
    loop {
        match attempt().await {
            Err(error) if error.starts_with(DIAL_FAILED_PREFIX) => match delays.next() {
                Some(delay) => tokio::time::sleep(delay).await,
                None => return Err(error),
            },
            result => return result,
        }
    }
}

/// 建立终端通道超时后再完整重试一次。远端瞬时繁忙（CPU/IO 尖峰）或链路抖动时，
/// TCP 已连上但 TLS / WebSocket 握手迟迟不完成，拨号重试覆盖不到这种情况。
/// WebSocket 升级完成前网关不会创建任何会话或 PTY，重试没有副作用。
async fn retry_timeout_once<T, F, Fut>(mut attempt: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    match attempt().await {
        Err(error) if error.starts_with(TIMEOUT_TAG) => {
            qingcode_server::diagnostics::record(
                "direct.stream_timeout_retry",
                serde_json::json!({}),
                false,
                false,
            );
            attempt().await
        }
        result => result,
    }
}

/// 认证、证书身份、协议版本错误重试也不会变好，应立即反馈给用户。
fn health_failure_is_transient(error: &str) -> bool {
    !["[direct:auth]", "[direct:identity]", "[direct:version]"]
        .iter()
        .any(|tag| error.starts_with(tag))
}

/// 单次健康检查可能撞上网络瞬断；失败后再确认一次，避免把仍在线的连接标记为断开。
async fn retry_transient_health<T, F, Fut>(mut attempt: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    match attempt().await {
        Err(error) if health_failure_is_transient(&error) => {
            // 只记录错误类别：完整消息带有目标地址。
            qingcode_server::diagnostics::record(
                "direct.health_retry",
                serde_json::json!({ "cause": error.split(' ').next().unwrap_or_default() }),
                false,
                false,
            );
            tokio::time::sleep(HEALTH_RETRY_DELAY).await;
            attempt().await
        }
        result => result,
    }
}

/// 用于判定连接存活的健康检查，结果会写入断开状态，因此容忍一次瞬时失败。
pub(super) async fn confirm_health(
    config: &DirectConnectionConfig,
) -> Result<DirectHealth, String> {
    retry_transient_health(|| test(config)).await
}

/// 直连断开时给用户的提示：带上最近一次探测失败的真实原因，去掉内部分类标签。
pub(super) fn disconnected_message(reason: Option<&str>) -> String {
    let detail = reason
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| {
            text.strip_prefix("[direct:")
                .and_then(|rest| rest.split_once(']'))
                .map_or(text, |(_, message)| message.trim())
        });
    match detail {
        Some(detail) if !detail.is_empty() => format!("Server 连接已断开：{detail}"),
        _ => "Server 连接已断开".into(),
    }
}

async fn tls(
    endpoint: &Endpoint,
    tunnel: Option<&str>,
    expected: Option<String>,
) -> Result<(ServerStream, String), String> {
    let observed = Arc::new(Mutex::new(None));
    let verifier = Arc::new(PinnedCertificate {
        expected,
        observed: Arc::clone(&observed),
    });
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| "[direct:protocol] 无法初始化 TLS".to_string())?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
    let stream = dial(endpoint, tunnel).await?;
    let name = ServerName::try_from(endpoint.host.clone())
        .map_err(|_| "[direct:protocol] Server 主机名无效".to_string())?;
    let stream = TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .map_err(|error| {
            let actual = observed.lock().unwrap_or_else(|error| error.into_inner());
            if actual.is_some() {
                "[direct:identity] Server TLS 身份验证失败；请核对证书指纹，未发送连接凭据"
                    .to_string()
            } else {
                format!(
                    "[direct:tls] TLS 握手失败（{:?}），请确认该端口运行 QingCode HTTPS Server",
                    error.kind()
                )
            }
        })?;
    let fingerprint = observed
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
        .ok_or_else(|| "[direct:identity] Server 未提供服务器证书".to_string())?;
    Ok((stream, fingerprint))
}

fn timeout_error() -> String {
    format!("{TIMEOUT_TAG} Server 连接超时，请检查地址、端口、防火墙和网络连通性")
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 4096 || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("[direct:auth] Server 连接凭据无效".into());
    }
    Ok(())
}

async fn write_http_request<S: AsyncWrite + Unpin>(
    stream: &mut S,
    headers: &str,
    body: &[u8],
) -> std::io::Result<()> {
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await?;
    // TlsStream may retain ciphertext when the socket is backpressured.
    // Reads do not flush it: finish sending before waiting for the response.
    stream.flush().await
}

/// Discover the untrusted certificate without sending a password or token.
pub(super) async fn probe(address: &str) -> Result<String, String> {
    let endpoint = endpoint(address)?;
    tokio::time::timeout(CONNECT_TIMEOUT, tls(&endpoint, None, None))
        .await
        .map_err(|_| timeout_error())?
        .map(|(_, fingerprint)| fingerprint)
}

pub(super) async fn test(config: &DirectConnectionConfig) -> Result<DirectHealth, String> {
    validate_token(&config.token)?;
    let endpoint = endpoint(&config.endpoint)?;
    let expected = normalized_fingerprint(&config.certificate_fingerprint)?;
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let (mut stream, _) = tls(&endpoint, config.tunnel.as_deref(), Some(expected)).await?;
        let request = format!(
            "GET /health HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            endpoint.authority, config.token
        );
        write_http_request(&mut stream, &request, &[]).await
            .map_err(|error| format!("[direct:unreachable] Server 健康检查发送失败（{:?}）", error.kind()))?;
        let mut bytes = Vec::new();
        stream.take((MAX_HEALTH_BYTES + 1) as u64).read_to_end(&mut bytes).await
            .map_err(|error| format!("[direct:protocol] Server 健康检查响应中断（{:?}）", error.kind()))?;
        if bytes.len() > MAX_HEALTH_BYTES {
            return Err("[direct:protocol] Server 健康检查响应过大".into());
        }
        let split = bytes.windows(4).position(|window| window == b"\r\n\r\n")
            .ok_or_else(|| "[direct:protocol] Server 健康检查响应格式无效".to_string())?;
        let headers = std::str::from_utf8(&bytes[..split])
            .map_err(|_| "[direct:protocol] Server 响应头无效".to_string())?;
        let status = headers.lines().next().unwrap_or_default();
        if status.contains(" 401 ") || status.contains(" 403 ") {
            return Err("[direct:auth] Server 连接凭据错误或已失效".into());
        }
        if !status.contains(" 200 ") {
            return Err("[direct:protocol] Server 健康检查未成功".into());
        }
        let health: DirectHealth = serde_json::from_slice(&bytes[split + 4..])
            .map_err(|_| "[direct:protocol] Server 健康检查 JSON 无效".to_string())?;
        if !health.healthy || health.protocol != qingcode_server::proto::PROTOCOL_VERSION {
            return Err("[direct:version] Server 不健康或协议版本不兼容".into());
        }
        Ok(health)
    }).await.map_err(|_| timeout_error())?
}

pub(super) fn require_current_version(health: &DirectHealth) -> Result<(), String> {
    if health.server_version != qingcode_server::SERVER_VERSION {
        return Err(format!(
            "Server 版本不匹配：远端 {}，本端 {}",
            health.server_version,
            qingcode_server::SERVER_VERSION
        ));
    }
    Ok(())
}

/// 端口直连要求网关与客户端同版本（配对网关由用户维护）。SSH 隧道沿用 daemon
/// 的「不降级」规则：同版本或更新版本（协议已在健康检查中核对）可直接使用，
/// 避免不同版本的客户端轮流替换同一用户的网关；更旧的网关由隧道建立流程替换。
pub(super) fn require_usable_gateway(
    config: &DirectConnectionConfig,
    health: &DirectHealth,
) -> Result<(), String> {
    if config.tunnel.is_none() {
        return require_current_version(health);
    }
    match super::server::compare_server_versions(
        &health.server_version,
        qingcode_server::SERVER_VERSION,
    ) {
        Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater) => Ok(()),
        _ => require_current_version(health),
    }
}

pub(super) async fn workspace_request(
    config: &DirectConnectionConfig,
    request: impl std::borrow::Borrow<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    WorkspaceClient::new(config.clone())
        .request(request.borrow())
        .await
}

/// Convert binary WebSocket messages to a bounded byte stream. This adapter
/// owns only the network connection, never the daemon or its terminal handles.
pub(super) async fn open_stream_for(
    config: &DirectConnectionConfig,
    connection_id: &str,
) -> Result<DuplexStream, String> {
    if connection_id.trim().is_empty() || connection_id.len() > 256 {
        return Err("[direct:protocol] Server 连接标识无效".into());
    }
    validate_token(&config.token)?;
    let endpoint = endpoint(&config.endpoint)?;
    let expected = normalized_fingerprint(&config.certificate_fingerprint)?;
    let cancelled = register_stream(&config.endpoint, connection_id);
    let connect_once = || {
        tokio::time::timeout(CONNECT_TIMEOUT, async {
            let (stream, _) =
                retry_dial(|| tls(&endpoint, config.tunnel.as_deref(), Some(expected.clone())))
                    .await?;
            let mut request = format!("wss://{}/connect", endpoint.authority)
                .into_client_request()
                .map_err(|_| "[direct:protocol] Server WebSocket 地址无效".to_string())?;
            request.headers_mut().insert(
                http::header::AUTHORIZATION,
                http::HeaderValue::from_str(&format!("Bearer {}", config.token))
                    .map_err(|_| "[direct:auth] Server 连接凭据无效".to_string())?,
            );
            let websocket_config =
                tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                    .max_message_size(Some(qingcode_server::proto::MAX_FRAME_BYTES + 4))
                    .max_frame_size(Some(qingcode_server::proto::MAX_FRAME_BYTES + 4));
            tokio_tungstenite::client_async_with_config(request, stream, Some(websocket_config))
                .await
                .map(|(socket, _)| socket)
                .map_err(|error| match error {
                    tokio_tungstenite::tungstenite::Error::Http(response)
                        if matches!(response.status().as_u16(), 401 | 403) =>
                    {
                        "[direct:auth] Server 连接凭据错误或已失效".to_string()
                    }
                    _ => "[direct:protocol] Server WebSocket 握手失败".to_string(),
                })
        })
    };
    let connect =
        retry_timeout_once(|| async { connect_once().await.map_err(|_| timeout_error())? });
    let socket = tokio::select! {
        result = connect => result?,
        _ = cancelled.notified() => return Err("[direct:unreachable] Server 连接已由当前连接配置关闭".into()),
    };
    let (client, network) = tokio::io::duplex(256 * 1024);
    let tunnel = config.tunnel.is_some();
    let timings = if tunnel {
        STREAM_PROBE_TUNNEL
    } else {
        STREAM_PROBE_DIRECT
    };
    let connection_id = connection_id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(failure) = bridge_stream(socket, network, cancelled, timings).await {
            record_stream_failure(&connection_id, tunnel, &failure);
        }
    });
    Ok(client)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::protocol::Role;

    const TEST_TIMINGS: StreamProbeTimings = StreamProbeTimings {
        idle_ms: 60,
        after_send_ms: 20,
        timeout_ms: 80,
    };

    const PROBE: StreamProbeTimings = StreamProbeTimings {
        idle_ms: 5_000,
        after_send_ms: 1_000,
        timeout_ms: 4_000,
    };

    #[test]
    fn probe_stays_quiet_while_inbound_traffic_is_recent() {
        let mut probe = StreamProbe::default();
        assert_eq!(
            probe.step(&PROBE, 3_000, 2_000, false),
            ProbeStep::Wait(7_000)
        );
        assert_eq!(
            probe.step(&PROBE, 9_000, 8_500, false),
            ProbeStep::Wait(13_500)
        );
    }

    #[test]
    fn probe_pings_when_idle_and_declares_dead_after_timeout() {
        let mut probe = StreamProbe::default();
        assert_eq!(probe.step(&PROBE, 5_000, 0, false), ProbeStep::Ping);
        assert_eq!(probe.step(&PROBE, 8_999, 0, false), ProbeStep::Wait(9_000));
        assert_eq!(probe.step(&PROBE, 9_000, 0, false), ProbeStep::Dead);
    }

    #[test]
    fn probe_recovers_when_anything_arrives_after_ping() {
        let mut probe = StreamProbe::default();
        assert_eq!(probe.step(&PROBE, 5_000, 0, false), ProbeStep::Ping);
        assert_eq!(
            probe.step(&PROBE, 5_100, 5_050, false),
            ProbeStep::Wait(10_050)
        );
    }

    #[test]
    fn probe_pings_early_when_sent_data_gets_no_reply() {
        let mut probe = StreamProbe {
            last_sent: Some(2_000),
            ping_at: None,
        };
        assert_eq!(
            probe.step(&PROBE, 2_500, 1_900, false),
            ProbeStep::Wait(3_000)
        );
        assert_eq!(probe.step(&PROBE, 3_000, 1_900, false), ProbeStep::Ping);
    }

    #[test]
    fn probe_ignores_send_already_answered_by_inbound() {
        let mut probe = StreamProbe {
            last_sent: Some(2_000),
            ping_at: None,
        };
        assert_eq!(
            probe.step(&PROBE, 3_500, 2_010, false),
            ProbeStep::Wait(7_010)
        );
    }

    #[test]
    fn probe_never_declares_dead_while_the_local_consumer_is_blocked() {
        let mut probe = StreamProbe::default();
        assert_eq!(probe.step(&PROBE, 5_000, 0, false), ProbeStep::Ping);
        assert_eq!(probe.step(&PROBE, 20_000, 0, true), ProbeStep::Wait(25_000));
        assert_eq!(probe.ping_at, None);
    }

    async fn bridged(
        peer_buffer: usize,
        local_buffer: usize,
    ) -> (
        tokio::task::JoinHandle<Result<(), StreamFailure>>,
        DuplexStream,
        WebSocketStream<DuplexStream>,
        Arc<tokio::sync::Notify>,
    ) {
        let (near, far) = tokio::io::duplex(peer_buffer);
        let (client, network) = tokio::io::duplex(local_buffer);
        let cancelled = Arc::new(tokio::sync::Notify::new());
        let socket = WebSocketStream::from_raw_socket(near, Role::Client, None).await;
        let peer = WebSocketStream::from_raw_socket(far, Role::Server, None).await;
        let task = tokio::spawn(bridge_stream(
            socket,
            network,
            Arc::clone(&cancelled),
            TEST_TIMINGS,
        ));
        (task, client, peer, cancelled)
    }

    #[tokio::test]
    async fn bridge_closes_a_silently_dropped_connection() {
        // 对端保持 TCP 打开但不再读写，等同路径上静默丢弃连接。
        let (task, mut client, _silent_peer, _cancelled) = bridged(64 * 1024, 64 * 1024).await;
        let failure = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("死连接必须被探活发现")
            .unwrap()
            .unwrap_err();
        assert_eq!(failure.cause, "probe_timeout");
        assert!(failure.idle_ms >= TEST_TIMINGS.timeout_ms);
        // 上层字节流随之 EOF，RPC 才能立刻失败并进入重连。
        let mut byte = [0u8; 1];
        assert_eq!(client.read(&mut byte).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn bridge_stays_open_when_peer_answers_pings() {
        let (task, _client, mut peer, cancelled) = bridged(64 * 1024, 64 * 1024).await;
        let responder = tokio::spawn(async move {
            while let Some(Ok(message)) = peer.next().await {
                if let Message::Ping(bytes) = message {
                    if peer.send(Message::Pong(bytes)).await.is_err() {
                        break;
                    }
                }
            }
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!task.is_finished(), "有 pong 的连接不能被判死");
        cancelled.notify_one();
        assert!(task.await.unwrap().is_ok(), "主动取消不算异常");
        responder.abort();
    }

    #[tokio::test]
    async fn bridge_does_not_kill_a_connection_blocked_on_a_slow_local_reader() {
        // 本端不读：下载卡在写缓冲上，收不到 pong 不代表连接已死。
        let (task, mut client, mut peer, cancelled) = bridged(256 * 1024, 1024).await;
        peer.send(Message::Binary(vec![7u8; 32 * 1024].into()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!task.is_finished(), "慢消费者不能触发重连");
        let mut received = vec![0u8; 32 * 1024];
        client.read_exact(&mut received).await.unwrap();
        assert!(received.iter().all(|byte| *byte == 7));
        cancelled.notify_one();
        assert!(task.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn bridge_reports_peer_close_but_not_local_close() {
        let (task, _client, mut peer, _cancelled) = bridged(64 * 1024, 64 * 1024).await;
        peer.close(None).await.unwrap();
        let failure = task.await.unwrap().unwrap_err();
        assert_eq!(failure.cause, "peer_closed");

        let (task, client, mut peer, _cancelled) = bridged(64 * 1024, 64 * 1024).await;
        let drain = tokio::spawn(async move { while peer.next().await.is_some() {} });
        drop(client);
        assert!(task.await.unwrap().is_ok(), "本端关闭不写诊断");
        drain.abort();
    }

    #[tokio::test]
    async fn latency_requires_an_active_trusted_root_and_does_not_change_health() {
        use super::super::{measure_direct_latency, RegisteredRoot, SshManager};
        let (config, gateway, directory) = gateway().await;
        let manager = SshManager::new();
        let id = "latency-probe";
        let uri = "ssh://latency-probe/project";
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert(id.into(), config.clone());
        manager.direct_active.write().unwrap().insert(id.into());
        assert!(measure_direct_latency(&manager, uri).await.is_err());
        manager.roots.write().unwrap().insert(
            uri.into(),
            RegisteredRoot {
                uri: uri.into(),
                canonical_path: "/project".into(),
                trusted: false,
            },
        );
        assert!(measure_direct_latency(&manager, uri)
            .await
            .unwrap_err()
            .contains("未信任"));
        manager.set_root_trust(uri, true).unwrap();
        let elapsed = measure_direct_latency(&manager, uri).await.unwrap();
        assert!(elapsed.is_finite() && elapsed >= 0.0);
        // Probe authentication failures must not update the connection's health cache.
        manager.direct_connections.write().unwrap().insert(
            id.into(),
            DirectConnectionConfig {
                token: "invalid-token".into(),
                ..config
            },
        );
        assert!(measure_direct_latency(&manager, uri)
            .await
            .unwrap_err()
            .starts_with("[direct:auth]"));
        assert!(manager.connection_is_open(id));
        assert!(manager.direct_failures.read().unwrap().is_empty());
        manager.detach_direct_connection(id).unwrap();
        assert!(measure_direct_latency(&manager, uri).await.is_err());
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn status_probe_detects_closed_port_and_never_reactivates_a_detached_connection() {
        use super::super::{server_status, RegisteredRoot, SshManager};
        let (config, gateway, directory) = gateway().await;
        let manager = SshManager::new();
        let id = "status-probe";
        let uri = "ssh://status-probe/project";
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert(id.into(), config);
        manager.direct_active.write().unwrap().insert(id.into());
        manager.roots.write().unwrap().insert(
            uri.into(),
            RegisteredRoot {
                uri: uri.into(),
                canonical_path: "/project".into(),
                trusted: true,
            },
        );
        manager.refresh_direct_status(id).await.unwrap();
        assert!(manager.connection_is_open(id));
        gateway.abort();
        let _ = gateway.await;
        manager.refresh_direct_status(id).await.unwrap();
        assert!(!manager.connection_is_open(id));
        let error = manager.sftp_for_uri(uri, false).await.err().unwrap();
        assert!(
            error.starts_with("Server 连接已断开：") && error.contains("无法连接"),
            "断开提示必须带上探测失败的真实原因：{error}"
        );
        let state = server_status::state_for_uri(&manager, uri).unwrap();
        assert_eq!(state.phase, server_status::ServerPhase::Disconnected);
        assert_eq!(state.transport, Some(server_status::ServerTransport::Agent));
        assert!(state.reason.is_some());
        manager.detach_direct_connection(id).unwrap();
        manager.refresh_direct_status(id).await.unwrap();
        let detached = server_status::state_for_uri(&manager, uri).unwrap();
        assert_eq!(detached.phase, server_status::ServerPhase::Disconnected);
        assert!(detached.reason.is_none());
        assert!(!manager.connection_is_open(id));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn http_requests_flush_buffered_uploads_before_waiting_for_response() {
        // Like rustls under socket backpressure, this writer can acknowledge
        // plaintext while retaining bytes that reads will never flush.
        for body in [
            Vec::new(),
            serde_json::to_vec(&vec![255u8; 64 * 1024]).unwrap(),
        ] {
            let headers = format!(
                "POST /workspace HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            let expected = [headers.as_bytes(), &body].concat();
            let (client, mut server) = tokio::io::duplex(64);
            let mut client = tokio::io::BufWriter::with_capacity(expected.len() + 1, client);
            let exchange = async {
                tokio::join!(
                    async {
                        write_http_request(&mut client, &headers, &body)
                            .await
                            .unwrap();
                        assert_eq!(client.read_u8().await.unwrap(), b'!');
                    },
                    async {
                        let mut received = vec![0; expected.len()];
                        server.read_exact(&mut received).await.unwrap();
                        assert_eq!(received, expected);
                        server.write_all(b"!").await.unwrap();
                    }
                );
            };
            tokio::time::timeout(Duration::from_secs(2), exchange)
                .await
                .expect("request bytes must reach the server before waiting for its response");
        }
    }

    pub(in super::super) async fn gateway() -> (
        DirectConnectionConfig,
        tokio::task::JoinHandle<Result<(), String>>,
        std::path::PathBuf,
    ) {
        gateway_with_version(qingcode_server::SERVER_VERSION).await
    }

    async fn gateway_with_version(
        version: &str,
    ) -> (
        DirectConnectionConfig,
        tokio::task::JoinHandle<Result<(), String>>,
        std::path::PathBuf,
    ) {
        let directory = std::env::temp_dir().join(format!(
            "qingcode-direct-client-{}",
            qingcode_server::generate_token()
        ));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut gateway = loop {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            match qingcode_server::direct::Gateway::bind(qingcode_server::direct::DirectOptions {
                hostname: "127.0.0.1".into(),
                port,
                state_dir: Some(directory.clone()),
                require_daemon: false,
            })
            .await
            {
                Ok(gateway) => break gateway,
                Err(error)
                    if tokio::time::Instant::now() < deadline
                        && (error.contains("Address already in use")
                            || error.contains("已在运行")) =>
                {
                    // Other parallel tests may claim the chosen port or fork
                    // while a failed bind's instance lock is being released.
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("temporary test gateway could not bind: {error}"),
            }
        };
        gateway.info.server_version = version.into();
        let info = qingcode_server::direct::info(Some(&directory), true).unwrap();
        let config = DirectConnectionConfig {
            endpoint: format!("https://127.0.0.1:{}", info.port),
            certificate_fingerprint: info.certificate_sha256,
            token: info.token.unwrap(),
            tunnel: None,
        };
        let task = tokio::spawn(gateway.run());
        (config, task, directory)
    }

    #[tokio::test]
    async fn startup_preparation_rejects_a_healthy_old_gateway_even_with_a_cached_endpoint() {
        use super::super::server::{server_slot_key, DaemonAccess, ServerSlot};
        use super::super::{direct_settings, server, RegisteredRoot, SshManager};
        let (config, gateway, directory) = gateway_with_version("0.0.0-stale").await;
        let manager = SshManager::new();
        let id = "startup-old-version";
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert(id.into(), config.clone());
        manager.direct_active.write().unwrap().insert(id.into());
        let root = RegisteredRoot {
            uri: format!("ssh://{id}/project"),
            canonical_path: "/project".into(),
            trusted: true,
        };
        let key = server_slot_key(id, &root.canonical_path);
        manager.set_server_slot(
            &key,
            ServerSlot {
                endpoint: Some(server::ServerEndpoint {
                    serve: None,
                    daemon: Some(DaemonAccess {
                        bin: "direct".into(),
                        token: config.token,
                    }),
                }),
                ..Default::default()
            },
        );
        // This was the previous startup path: it accepts the stale version.
        manager.ensure_connection_alive(id).await.unwrap();
        let error = direct_settings::prepare_root(&manager, &root, None)
            .await
            .unwrap_err();
        assert!(error.contains("Server 版本不匹配"), "{error}");
        assert!(error.contains("0.0.0-stale"), "{error}");
        assert!(error.contains(qingcode_server::SERVER_VERSION), "{error}");
        assert!(manager.server_slot(&key).unwrap().endpoint.is_none());
        assert!(manager.sessions.read().unwrap().is_empty());
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn startup_preparation_keeps_restricted_old_gateways_read_only() {
        use super::super::{direct_settings, RegisteredRoot, SshManager};
        let (config, gateway, directory) = gateway_with_version("0.0.0-stale").await;
        let manager = SshManager::new();
        let id = "startup-restricted";
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert(id.into(), config);
        manager.direct_active.write().unwrap().insert(id.into());
        let root = RegisteredRoot {
            uri: format!("ssh://{id}/project"),
            canonical_path: "/project".into(),
            trusted: false,
        };
        direct_settings::prepare_root(&manager, &root, None)
            .await
            .unwrap();
        assert!(manager.servers.read().unwrap().is_empty());
        assert!(manager.sessions.read().unwrap().is_empty());
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn startup_preparation_preserves_a_current_ready_gateway_and_checks_authentication() {
        use super::super::server::{server_slot_key, DaemonAccess, ServerSlot};
        use super::super::{direct_settings, server, RegisteredRoot, SshManager};
        let (config, gateway, directory) = gateway().await;
        let manager = SshManager::new();
        let id = "startup-current";
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert(id.into(), config.clone());
        manager.direct_active.write().unwrap().insert(id.into());
        let root = RegisteredRoot {
            uri: format!("ssh://{id}/project"),
            canonical_path: "/project".into(),
            trusted: true,
        };
        let key = server_slot_key(id, &root.canonical_path);
        manager.set_server_slot(
            &key,
            ServerSlot {
                endpoint: Some(server::ServerEndpoint {
                    serve: None,
                    daemon: Some(DaemonAccess {
                        bin: "direct".into(),
                        token: config.token.clone(),
                    }),
                }),
                ..Default::default()
            },
        );
        direct_settings::prepare_root(&manager, &root, None)
            .await
            .unwrap();
        assert!(manager.server_slot(&key).unwrap().endpoint.is_some());
        manager.direct_connections.write().unwrap().insert(
            id.into(),
            DirectConnectionConfig {
                token: "invalid-token".into(),
                ..config
            },
        );
        let error = direct_settings::prepare_root(&manager, &root, None)
            .await
            .unwrap_err();
        assert!(error.contains("[direct:auth]"), "{error}");
        assert!(!error.contains("版本不匹配"), "{error}");
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn closing_one_profile_preserves_another_profile_on_the_same_agent() {
        let (config, gateway, directory) = gateway().await;
        let mut first = open_stream_for(&config, "profile-a").await.unwrap();
        let alias = DirectConnectionConfig {
            endpoint: config.endpoint.replacen("https://", "wss://", 1),
            ..config.clone()
        };
        let mut sibling = open_stream_for(&alias, "profile-b").await.unwrap();
        close_connection(&config.endpoint, "profile-a");
        let mut byte = [0u8; 1];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), first.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(100), sibling.read(&mut byte))
                .await
                .is_err(),
            "closing profile-a must leave profile-b connected to the same server"
        );
        close_connection(&config.endpoint, "profile-b");
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), sibling.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        drop(first);
        drop(sibling);
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn dial_failure_message_keeps_the_prefix_and_reports_the_os_error() {
        let target = endpoint("https://192.0.2.1:48763").unwrap();
        let message = dial_failure_message(&target, Some(10061));
        assert!(message.starts_with(DIAL_FAILED_PREFIX));
        assert!(message.contains("192.0.2.1:48763（系统错误 10061）"));
        assert!(!dial_failure_message(&target, None).contains("系统错误"));
    }

    #[tokio::test]
    async fn stream_open_retries_one_timeout_then_succeeds() {
        let mut attempts = 0;
        let result = retry_timeout_once(|| {
            attempts += 1;
            let current = attempts;
            async move {
                if current == 1 {
                    Err(timeout_error())
                } else {
                    Ok(current)
                }
            }
        })
        .await;
        assert_eq!(result, Ok(2));
    }

    #[tokio::test]
    async fn stream_open_does_not_retry_non_timeout_failures() {
        let mut attempts = 0;
        let result: Result<(), String> = retry_timeout_once(|| {
            attempts += 1;
            async { Err("[direct:auth] Server 连接凭据错误或已失效".to_string()) }
        })
        .await;
        assert!(result.unwrap_err().starts_with("[direct:auth]"));
        assert_eq!(attempts, 1);
    }

    #[tokio::test]
    async fn stream_open_reports_the_second_timeout() {
        let mut attempts = 0;
        let result: Result<(), String> = retry_timeout_once(|| {
            attempts += 1;
            async { Err(timeout_error()) }
        })
        .await;
        assert!(result.unwrap_err().starts_with(TIMEOUT_TAG));
        assert_eq!(attempts, 2);
    }

    #[tokio::test]
    async fn health_retry_keeps_connection_online_after_one_transient_failure() {
        let mut attempts = 0;
        let result = retry_transient_health(|| {
            attempts += 1;
            let current = attempts;
            async move {
                if current == 1 {
                    Err(timeout_error())
                } else {
                    Ok(current)
                }
            }
        })
        .await;
        assert_eq!(result, Ok(2));
    }

    #[tokio::test]
    async fn health_retry_reports_the_last_failure_after_one_retry() {
        let mut attempts = 0;
        let result: Result<(), String> = retry_transient_health(|| {
            attempts += 1;
            let current = attempts;
            async move { Err(format!("[direct:tls] attempt {current}")) }
        })
        .await;
        assert_eq!(result, Err("[direct:tls] attempt 2".to_string()));
        assert_eq!(attempts, 2);
    }

    #[tokio::test]
    async fn health_retry_does_not_repeat_permanent_failures() {
        for error in [
            "[direct:auth] a",
            "[direct:identity] b",
            "[direct:version] c",
        ] {
            let mut attempts = 0;
            let result: Result<(), String> = retry_transient_health(|| {
                attempts += 1;
                async move { Err(error.to_string()) }
            })
            .await;
            assert_eq!(result, Err(error.to_string()));
            assert_eq!(attempts, 1, "{error}");
        }
    }

    #[test]
    fn disconnected_message_shows_the_reason_without_internal_tag() {
        assert_eq!(
            disconnected_message(Some("[direct:timeout] Server 连接超时")),
            "Server 连接已断开：Server 连接超时"
        );
        assert_eq!(
            disconnected_message(Some("未分类原因")),
            "Server 连接已断开：未分类原因"
        );
        for empty in [None, Some(""), Some("  "), Some("[direct:timeout] ")] {
            assert_eq!(disconnected_message(empty), "Server 连接已断开");
        }
    }

    #[tokio::test]
    async fn retry_dial_recovers_from_transient_dial_failures() {
        let mut attempts = 0;
        let result = retry_dial(|| {
            attempts += 1;
            let current = attempts;
            async move {
                if current < 3 {
                    Err(format!("{DIAL_FAILED_PREFIX} target"))
                } else {
                    Ok(current)
                }
            }
        })
        .await;
        assert_eq!(result, Ok(3));
    }

    #[tokio::test]
    async fn retry_dial_gives_up_after_the_last_delay() {
        let mut attempts = 0;
        let result: Result<(), String> = retry_dial(|| {
            attempts += 1;
            async { Err(format!("{DIAL_FAILED_PREFIX} target")) }
        })
        .await;
        assert!(result.unwrap_err().starts_with(DIAL_FAILED_PREFIX));
        assert_eq!(attempts, DIAL_RETRY_DELAYS.len() + 1);
    }

    #[tokio::test]
    async fn retry_dial_does_not_repeat_other_failures() {
        let mut attempts = 0;
        let result: Result<(), String> = retry_dial(|| {
            attempts += 1;
            async { Err("[direct:tls] TLS 握手失败".to_string()) }
        })
        .await;
        assert!(result.unwrap_err().starts_with("[direct:tls]"));
        assert_eq!(attempts, 1);
    }

    #[tokio::test]
    async fn closing_a_profile_also_cancels_its_pending_tls_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = DirectConnectionConfig {
            endpoint: format!("https://127.0.0.1:{port}"),
            certificate_fingerprint: "a".repeat(64),
            token: "pairing-token".into(),
            tunnel: None,
        };
        let address = config.endpoint.clone();
        let opening =
            tokio::spawn(async move { open_stream_for(&config, "pending-profile").await });
        let (_socket, _) = listener.accept().await.unwrap();
        close_connection(&address, "pending-profile");
        assert!(tokio::time::timeout(Duration::from_secs(3), opening)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .starts_with("[direct:unreachable]"));
    }

    #[tokio::test]
    async fn tls_discovery_pinning_and_authentication_are_separate() {
        let (config, gateway, directory) = gateway().await;
        assert_eq!(
            probe(&config.endpoint).await.unwrap(),
            config.certificate_fingerprint
        );
        assert!(test(&config).await.unwrap().healthy);
        let wrong_identity = DirectConnectionConfig {
            certificate_fingerprint: "0".repeat(64),
            ..config.clone()
        };
        assert!(test(&wrong_identity)
            .await
            .unwrap_err()
            .starts_with("[direct:identity]"));
        let wrong_token = DirectConnectionConfig {
            token: "incorrect-token".into(),
            ..config
        };
        assert!(test(&wrong_token)
            .await
            .unwrap_err()
            .starts_with("[direct:auth]"));
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    /// 隧道只替换拨号：地址指向无人监听的端口，流量仍经隧道到达网关；
    /// 证书固定、认证、HTTPS 复用与 WSS HELLO 行为不变，且不与 TCP 直连共池。
    #[tokio::test]
    async fn tunnel_carries_health_workspace_and_websocket_with_the_same_pinning() {
        use qingcode_server::proto::{self, Frame, HelloRequest, Kind, PROTOCOL_VERSION};
        let (direct, gateway, directory) = gateway().await;
        let port = endpoint(&direct.endpoint).unwrap().port;
        let id = format!("tunnel-test-{}", uuid::Uuid::new_v4());
        super::super::tunnel::route_for_test(&id, Some(port));
        let config = DirectConnectionConfig {
            endpoint: "https://127.0.0.1:1".into(),
            tunnel: Some(id.clone()),
            ..direct.clone()
        };
        assert!(test(&config).await.unwrap().healthy);
        let wrong_identity = DirectConnectionConfig {
            certificate_fingerprint: "0".repeat(64),
            ..config.clone()
        };
        assert!(test(&wrong_identity)
            .await
            .unwrap_err()
            .starts_with("[direct:identity]"));
        let client = WorkspaceClient::new(config.clone());
        for _ in 0..2 {
            assert!(client
                .request(&serde_json::json!({"op":"info"}))
                .await
                .unwrap()["homePath"]
                .is_string());
        }
        // 同一地址的 TCP 直连不能复用隧道连接。
        let untunneled = DirectConnectionConfig {
            tunnel: None,
            ..config.clone()
        };
        assert!(
            workspace_request(&untunneled, serde_json::json!({"op":"info"}))
                .await
                .unwrap_err()
                .starts_with("[direct:unreachable]")
        );
        let daemon = tokio::spawn(qingcode_server::daemon::run_async(
            qingcode_server::daemon::DaemonOptions {
                state_dir: Some(directory.clone()),
                ..Default::default()
            },
        ));
        for _ in 0..100 {
            if directory.join("token").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut stream = open_stream_for(&config, &id).await.unwrap();
        proto::write_frame(
            &mut stream,
            &Frame::new(
                Kind::Hello,
                0,
                proto::encode(&HelloRequest {
                    client_id: format!("test-install:{id}"),
                    protocol_min: PROTOCOL_VERSION,
                    protocol_max: PROTOCOL_VERSION,
                    token: config.token.clone(),
                    resume_token: None,
                })
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(15), proto::read_frame(&mut stream))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.kind, Kind::Hello);
        close_connection(&config.endpoint, &id);
        super::super::tunnel::route_for_test(&id, None);
        assert!(test(&config)
            .await
            .unwrap_err()
            .contains("SSH 隧道尚未建立"));
        daemon.abort();
        let _ = daemon.await;
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn direct_files_stream_seek_preserve_exclusive_create_and_reject_escape() {
        use super::super::direct_fs::DirectFs;
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::AsyncSeekExt;
        let (config, gateway, directory) = gateway().await;
        let project = directory.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let root = std::fs::canonicalize(&project)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let fs = DirectFs::new(config.clone(), Some(root.clone()), true);
        let path = project.join("file.bin").to_string_lossy().into_owned();
        let bytes: Vec<u8> = (0..(384 * 1024 + 71))
            .map(|index| (index % 251) as u8)
            .collect();
        let mut output = fs
            .open(
                path.clone(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            )
            .await
            .unwrap();
        // Terminal paste transfers submit 64 KiB at a time, below the direct
        // file adapter's 128 KiB limit.
        for chunk in bytes.chunks(64 * 1024) {
            output.write_all(chunk).await.unwrap();
        }
        output.close().await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(fs
            .open(
                path.clone(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE
            )
            .await
            .is_err());
        let mut input = fs.open(path.clone(), OpenFlags::READ).await.unwrap();
        assert_eq!(input.metadata().await.unwrap().len(), bytes.len() as u64);
        input
            .seek(std::io::SeekFrom::Start(128 * 1024 + 9))
            .await
            .unwrap();
        let mut suffix = Vec::new();
        input.read_to_end(&mut suffix).await.unwrap();
        input.close().await.unwrap();
        assert_eq!(suffix, bytes[128 * 1024 + 9..]);
        let untrusted = DirectFs::new(config, Some(root), false);
        assert!(untrusted
            .write(
                project.join("denied").to_string_lossy().into_owned(),
                b"denied"
            )
            .await
            .is_err());
        let outside = directory.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), b"outside").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, project.join("escape")).unwrap();
            assert!(fs
                .open(
                    project.join("escape/secret").to_string_lossy().into_owned(),
                    OpenFlags::READ
                )
                .await
                .is_err());
        }
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn directory_scan_uses_https_without_a_daemon_or_ssh_session() {
        use super::super::{direct_scan_directory, RegisteredRoot, SshManager};
        let (config, gateway, directory) = gateway().await;
        let project = directory.join("project");
        let worktree = project.join(".claude/worktrees/report-allure-status");
        std::fs::create_dir_all(worktree.join("src")).unwrap();
        std::fs::write(worktree.join("src/delete-me.txt"), b"temporary").unwrap();
        std::fs::write(worktree.join(".git"), b"gitdir: /unavailable/worktree").unwrap();
        std::fs::write(worktree.join("readme.txt"), b"worktree").unwrap();
        std::fs::write(worktree.join("skip.log"), b"excluded").unwrap();
        let canonical = workspace_request(
            &config,
            &serde_json::json!({"op":"canonicalize","path":project.to_string_lossy()}),
        )
        .await
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
        let uri = format!("ssh://direct-scan{canonical}");
        let path = format!("{uri}/.claude/worktrees/report-allure-status");
        let manager = SshManager::new();
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert("direct-scan".into(), config.clone());
        manager
            .direct_active
            .write()
            .unwrap()
            .insert("direct-scan".into());
        manager.roots.write().unwrap().insert(
            uri.clone(),
            RegisteredRoot {
                uri: uri.clone(),
                canonical_path: canonical,
                trusted: true,
            },
        );
        let excludes = vec!["**/*.log".to_string()];
        let nodes = direct_scan_directory(&manager, &path, Some(&uri), Some(&excludes))
            .await
            .unwrap()
            .expect("direct mode must handle the scan without SSH serve");
        assert_eq!(
            nodes
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            ["src", ".git", "readme.txt"]
        );
        assert!(nodes[0].is_dir);
        assert!(!nodes[1].is_dir);
        assert_eq!(nodes[0].path, format!("{path}/src"));

        // Reads remain available without workspace trust; writes still require it.
        manager
            .roots
            .write()
            .unwrap()
            .get_mut(&uri)
            .unwrap()
            .trusted = false;
        assert!(
            direct_scan_directory(&manager, &path, Some(&uri), Some(&excludes))
                .await
                .unwrap()
                .is_some()
        );
        assert!(manager
            .sftp_for_uri(&format!("{path}/new.txt"), true)
            .await
            .is_err());
        assert!(
            direct_scan_directory(&manager, &format!("{uri}/../outside"), None, None)
                .await
                .is_err()
        );
        #[cfg(unix)]
        {
            let outside = directory.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, worktree.join("escape")).unwrap();
            assert!(
                direct_scan_directory(&manager, &format!("{path}/escape"), None, None)
                    .await
                    .is_err()
            );
        }
        let missing = direct_scan_directory(&manager, &format!("{path}/missing"), None, None)
            .await
            .unwrap_err();
        assert!(!missing.contains("不会回退到 SSH"));

        manager
            .roots
            .write()
            .unwrap()
            .get_mut(&uri)
            .unwrap()
            .trusted = true;
        let (fs, parsed, _) = manager
            .sftp_for_uri(&format!("{path}/src"), true)
            .await
            .unwrap();
        super::super::remove_remote_tree(&fs, parsed.path)
            .await
            .unwrap();
        assert!(!worktree.join("src").exists());

        // An invalid Agent identity must fail, even when a listing was cached.
        manager.direct_connections.write().unwrap().insert(
            "direct-scan".into(),
            DirectConnectionConfig {
                token: "invalid-token".into(),
                ..config
            },
        );
        assert!(direct_scan_directory(&manager, &path, None, None)
            .await
            .unwrap_err()
            .contains("[direct:auth]"));
        assert!(manager.sessions.read().unwrap().is_empty());
        assert!(manager.servers.read().unwrap().is_empty());
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn manager_routes_workspace_files_and_commands_without_an_ssh_session() {
        use super::super::{ensure_existing_path_within, RegisteredRoot, SshManager};
        use russh_sftp::protocol::OpenFlags;
        let (config, gateway, directory) = gateway().await;
        let project = directory.join("registered-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("read.txt"), b"direct workspace").unwrap();
        let canonical = std::fs::canonicalize(&project)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let uri = format!("ssh://direct-loopback{canonical}");
        let manager = SshManager::new();
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert("direct-loopback".into(), config);
        manager
            .direct_active
            .write()
            .unwrap()
            .insert("direct-loopback".into());
        manager.direct_failures.write().unwrap().insert(
            "direct-loopback".into(),
            "[direct:timeout] previous connection attempt timed out".into(),
        );
        assert!(!manager.connection_is_open("direct-loopback"));
        assert_eq!(
            manager.connection_mode("direct-loopback"),
            Some(super::super::RemoteMode::Server)
        );
        manager
            .ensure_connection_alive("direct-loopback")
            .await
            .unwrap();
        assert!(
            manager.connection_is_open("direct-loopback"),
            "a real healthy HTTPS response must clear the previous failure"
        );
        assert!(!manager
            .direct_failures
            .read()
            .unwrap()
            .contains_key("direct-loopback"));
        assert!(manager
            .live_session("direct-loopback")
            .await
            .err()
            .unwrap()
            .contains("不会回退到 SSH"));
        manager.roots.write().unwrap().insert(
            uri.clone(),
            RegisteredRoot {
                uri: uri.clone(),
                canonical_path: canonical,
                trusted: true,
            },
        );
        let (sftp, parsed, root) = manager
            .sftp_for_uri(&format!("{uri}/read.txt"), false)
            .await
            .unwrap();
        ensure_existing_path_within(&sftp, &parsed.path, &root)
            .await
            .unwrap();
        assert_eq!(sftp.read(parsed.path).await.unwrap(), b"direct workspace");
        let (sftp, parsed, _) = manager
            .sftp_for_uri(&format!("{uri}/written.txt"), true)
            .await
            .unwrap();
        let mut output = sftp
            .open_with_flags(
                parsed.path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            )
            .await
            .unwrap();
        output.write_all(b"written over HTTPS").await.unwrap();
        output.close().await.unwrap();
        let command = manager
            .exec_uri(&uri, "printf stdout; printf stderr >&2; exit 7", true)
            .await
            .unwrap();
        assert_eq!(command.stdout, "stdout");
        assert_eq!(command.stderr, "stderr");
        assert_eq!(command.exit_code, 7);
        let input = manager
            .exec_uri_with_input(&uri, "cat", b"input through HTTPS", true)
            .await
            .unwrap();
        assert_eq!(input.stdout, "input through HTTPS");
        manager
            .roots
            .write()
            .unwrap()
            .get_mut(&uri)
            .unwrap()
            .trusted = false;
        assert!(manager
            .sftp_for_uri(&format!("{uri}/written.txt"), true)
            .await
            .is_err());
        assert!(manager.exec_uri(&uri, "printf denied", true).await.is_err());
        assert!(
            manager.sessions.read().unwrap().is_empty(),
            "direct operations must not bootstrap SSH"
        );
        gateway.abort();
        let _ = gateway.await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn websocket_disconnect_and_transport_switch_preserve_the_same_pty() {
        use super::super::{RegisteredRoot, SshManager};
        use qingcode_server::proto::{
            self, Frame, HelloRequest, Kind, Request, Response, PROTOCOL_VERSION,
        };
        async fn hello(config: &DirectConnectionConfig, connection_id: &str) -> DuplexStream {
            let mut stream = open_stream_for(config, connection_id).await.unwrap();
            proto::write_frame(
                &mut stream,
                &Frame::new(
                    Kind::Hello,
                    0,
                    proto::encode(&HelloRequest {
                        client_id: format!("test-install:{connection_id}"),
                        protocol_min: PROTOCOL_VERSION,
                        protocol_max: PROTOCOL_VERSION,
                        token: config.token.clone(),
                        resume_token: None,
                    })
                    .unwrap(),
                ),
            )
            .await
            .unwrap();
            assert_eq!(
                proto::read_frame(&mut stream).await.unwrap().kind,
                Kind::Hello
            );
            stream
        }
        async fn request(
            stream: &mut DuplexStream,
            id: u32,
            method: &str,
            params: serde_json::Value,
        ) -> serde_json::Value {
            let request = Request::with_params(id, method, &params).unwrap();
            proto::write_frame(
                stream,
                &Frame::new(Kind::Req, id, proto::encode(&request).unwrap()),
            )
            .await
            .unwrap();
            loop {
                let frame =
                    tokio::time::timeout(Duration::from_secs(10), proto::read_frame(stream))
                        .await
                        .unwrap()
                        .unwrap();
                if frame.kind == Kind::Ping {
                    proto::write_frame(stream, &Frame::empty(Kind::Pong, frame.stream_id))
                        .await
                        .unwrap();
                    continue;
                }
                if frame.kind == Kind::Res && frame.stream_id == id {
                    return proto::decode_value::<Response>(&frame.payload)
                        .unwrap()
                        .result;
                }
                assert_ne!(
                    frame.kind,
                    Kind::Err,
                    "{}",
                    String::from_utf8_lossy(&frame.payload)
                );
            }
        }
        let (config, gateway, directory) = gateway().await;
        let manager = SshManager::new();
        let connection_id = "direct-reconnect";
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert(connection_id.into(), config.clone());
        manager
            .direct_active
            .write()
            .unwrap()
            .insert(connection_id.into());
        let canonical = std::fs::canonicalize(&directory)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let uri = format!("ssh://{connection_id}{canonical}");
        manager.roots.write().unwrap().insert(
            uri.clone(),
            RegisteredRoot {
                uri: uri.clone(),
                canonical_path: canonical,
                trusted: true,
            },
        );
        let daemon_directory = directory.clone();
        let daemon = tokio::spawn(qingcode_server::daemon::run_async(
            qingcode_server::daemon::DaemonOptions {
                state_dir: Some(daemon_directory),
                ..Default::default()
            },
        ));
        for _ in 0..100 {
            if directory.join("token").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut first = hello(&config, connection_id).await;
        let created=request(&mut first,1,"pty.create",serde_json::json!({
            "cwd":directory,"shell":"/bin/sh","args":["-c","printf DIRECT_RESUME; while :; do sleep 1; done"],"cols":80,"rows":24,
        })).await;
        let id = created["id"].as_str().unwrap().to_string();
        let detached_roots = manager
            .detach_direct_connection(connection_id)
            .unwrap()
            .unwrap();
        assert_eq!(detached_roots.len(), 1);
        assert!(!manager.connection_is_open(connection_id));
        assert!(manager.registered_root(&uri).is_err());
        let mut eof = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), first.read_to_end(&mut eof))
            .await
            .unwrap()
            .unwrap();
        drop(first);
        manager
            .direct_active
            .write()
            .unwrap()
            .insert(connection_id.into());
        for root in detached_roots {
            manager
                .roots
                .write()
                .unwrap()
                .insert(root.uri.clone(), root);
        }
        manager
            .ensure_connection_alive(connection_id)
            .await
            .unwrap();
        let mut second = hello(&config, connection_id).await;
        let listed = request(&mut second, 2, "pty.list", serde_json::json!({})).await;
        let original = listed["ptys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == id)
            .unwrap();
        assert!(
            original["exited"].is_null(),
            "disconnect must not terminate the original PTY"
        );
        request(
            &mut second,
            3,
            "pty.attach",
            serde_json::json!({"id":id,"fromSeq":0}),
        )
        .await;
        request(&mut second, 4, "pty.kill", serde_json::json!({"id":id})).await;
        request(&mut second, 5, "server.shutdown", serde_json::json!({})).await;
        drop(second);
        gateway.abort();
        let _ = gateway.await;
        tokio::time::timeout(Duration::from_secs(10), daemon)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn endpoint_rejects_credentials_plaintext_and_ambiguous_paths() {
        for address in [
            "http://host:38822",
            "https://user:secret@host:38822",
            "https://host:0",
            "https://host/path",
            "https://host?token=secret",
        ] {
            assert!(endpoint(address).is_err(), "{address}");
        }
        assert_eq!(endpoint("https://[::1]:38822").unwrap().host, "::1");
        assert_eq!(endpoint("https://host:38822").unwrap().port, 38822);
    }

    #[test]
    fn fingerprints_are_exact_and_debug_redacts_credentials() {
        assert!(normalized_fingerprint("not-a-fingerprint").is_err());
        assert_eq!(
            normalized_fingerprint(&format!("{}AA", "AA:".repeat(31))).unwrap(),
            "aa".repeat(32)
        );
        let config = DirectConnectionConfig {
            endpoint: "https://host:38822".into(),
            certificate_fingerprint: "a".repeat(64),
            token: "private-secret".into(),
            tunnel: None,
        };
        assert!(!format!("{config:?}").contains("private-secret"));
        assert!(validate_token("secret\r\nInjected: true").is_err());
    }
}
