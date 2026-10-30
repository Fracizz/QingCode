//! Independent Agent connection. Discovery never sends credentials; every
//! authenticated request pins the certificate explicitly accepted by the user.

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::net::TcpStream;
use tokio_rustls::{client::TlsStream, TlsConnector};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http, Message};

mod workspace_http;
pub(super) use workspace_http::WorkspaceClient;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEALTH_BYTES: usize = 64 * 1024;

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
}

// Credentials must never enter Debug output, including connection errors.
impl std::fmt::Debug for DirectConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirectConnectionConfig")
            .field("endpoint", &self.endpoint)
            .field("certificate_fingerprint", &self.certificate_fingerprint)
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

async fn tls(
    endpoint: &Endpoint,
    expected: Option<String>,
) -> Result<(TlsStream<TcpStream>, String), String> {
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
    let stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .await
        .map_err(|_| {
            format!(
                "[direct:unreachable] 无法连接 {}，请确认 Server 已启动且 TCP {} 已放行",
                endpoint.authority, endpoint.port
            )
        })?;
    let _ = stream.set_nodelay(true);
    let name = ServerName::try_from(endpoint.host.clone())
        .map_err(|_| "[direct:protocol] Server 主机名无效".to_string())?;
    let stream = TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .map_err(|_| {
            let actual = observed.lock().unwrap_or_else(|error| error.into_inner());
            if actual.is_some() {
                "[direct:identity] Server TLS 身份验证失败；请核对证书指纹，未发送连接凭据"
                    .to_string()
            } else {
                "[direct:protocol] TLS 握手失败，请确认该端口运行 QingCode HTTPS Server".to_string()
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
    "[direct:timeout] Server 连接超时，请检查地址、端口、防火墙和网络连通性".into()
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
    tokio::time::timeout(CONNECT_TIMEOUT, tls(&endpoint, None))
        .await
        .map_err(|_| timeout_error())?
        .map(|(_, fingerprint)| fingerprint)
}

pub(super) async fn test(config: &DirectConnectionConfig) -> Result<DirectHealth, String> {
    validate_token(&config.token)?;
    let endpoint = endpoint(&config.endpoint)?;
    let expected = normalized_fingerprint(&config.certificate_fingerprint)?;
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let (mut stream, _) = tls(&endpoint, Some(expected)).await?;
        let request = format!(
            "GET /health HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            endpoint.authority, config.token
        );
        write_http_request(&mut stream, &request, &[]).await
            .map_err(|_| "[direct:unreachable] Server 健康检查发送失败".to_string())?;
        let mut bytes = Vec::new();
        stream.take((MAX_HEALTH_BYTES + 1) as u64).read_to_end(&mut bytes).await
            .map_err(|_| "[direct:protocol] Server 健康检查响应中断".to_string())?;
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
            return Err("[direct:protocol] Server 不健康或协议版本不兼容".into());
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
    let connect = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let (stream, _) = tls(&endpoint, Some(expected)).await?;
        let mut request = format!("wss://{}/connect", endpoint.authority)
            .into_client_request()
            .map_err(|_| "[direct:protocol] Server WebSocket 地址无效".to_string())?;
        request.headers_mut().insert(
            http::header::AUTHORIZATION,
            http::HeaderValue::from_str(&format!("Bearer {}", config.token))
                .map_err(|_| "[direct:auth] Server 连接凭据无效".to_string())?,
        );
        let websocket_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
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
    });
    let socket = tokio::select! {
        result = connect => result.map_err(|_| timeout_error())??,
        _ = cancelled.notified() => return Err("[direct:unreachable] Server 连接已由当前连接配置关闭".into()),
    };
    let (client, network) = tokio::io::duplex(256 * 1024);
    tauri::async_runtime::spawn(async move {
        let (mut sender, mut receiver) = socket.split();
        let (mut input, mut output) = tokio::io::split(network);
        let upload = async {
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let size = input.read(&mut buffer).await.map_err(|_| ())?;
                if size == 0 {
                    break;
                }
                sender
                    .send(Message::Binary(buffer[..size].to_vec().into()))
                    .await
                    .map_err(|_| ())?;
            }
            let _ = sender.close().await;
            Ok::<(), ()>(())
        };
        let download = async {
            while let Some(message) = receiver.next().await {
                match message.map_err(|_| ())? {
                    Message::Binary(bytes) => output.write_all(&bytes).await.map_err(|_| ())?,
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                    _ => return Err(()),
                }
            }
            Ok::<(), ()>(())
        };
        tokio::select! { _ = upload => {}, _ = download => {}, _ = cancelled.notified() => {} }
    });
    Ok(client)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

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
        let directory = std::env::temp_dir().join(format!(
            "qingcode-direct-client-{}",
            qingcode_server::generate_token()
        ));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let gateway = loop {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            match qingcode_server::direct::Gateway::bind(qingcode_server::direct::DirectOptions {
                hostname: "127.0.0.1".into(),
                port,
                state_dir: Some(directory.clone()),
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
        let info = qingcode_server::direct::info(Some(&directory), true).unwrap();
        let config = DirectConnectionConfig {
            endpoint: format!("https://127.0.0.1:{}", info.port),
            certificate_fingerprint: info.certificate_sha256,
            token: info.token.unwrap(),
        };
        let task = tokio::spawn(gateway.run());
        (config, task, directory)
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

    #[tokio::test]
    async fn closing_a_profile_also_cancels_its_pending_tls_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = DirectConnectionConfig {
            endpoint: format!("https://127.0.0.1:{port}"),
            certificate_fingerprint: "a".repeat(64),
            token: "pairing-token".into(),
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
        };
        assert!(!format!("{config:?}").contains("private-secret"));
        assert!(validate_token("secret\r\nInjected: true").is_err());
    }
}
