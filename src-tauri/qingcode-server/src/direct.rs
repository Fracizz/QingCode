//! Independent HTTPS/WSS entry point. Network lifetime never owns PTY lifetime.
//!
//! Authentication happens before opening local IPC. The first protocol HELLO is
//! translated to the current daemon token, which never leaves the host. All
//! remaining bytes use the existing daemon protocol, including reconnect/replay.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_rustls::rustls::{self, pki_types::PrivatePkcs8KeyDer};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::{self, Message};

use crate::connect::{ensure_daemon_token, ConnectOptions};
use crate::daemon::RunDir;
use crate::ipc::IpcEndpoint;
use crate::proto::{self, HelloRequest, Kind};

pub const DEFAULT_DIRECT_PORT: u16 = 48763;

const MAX_HEADERS: usize = 16 * 1024;
const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 96;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub struct DirectOptions {
    pub hostname: String,
    /// Zero means use the persisted port, or DEFAULT_DIRECT_PORT on first start.
    pub port: u16,
    pub state_dir: Option<PathBuf>,
}

impl Default for DirectOptions {
    fn default() -> Self {
        Self {
            hostname: "0.0.0.0".into(),
            port: 0,
            state_dir: None,
        }
    }
}

/// Safe descriptor. Pairing secret appears only on explicit local export.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectInfo {
    pub hostname: String,
    pub port: u16,
    pub certificate_sha256: String,
    pub server_version: String,
    pub protocol: u32,
    pub pid: u32,
    #[serde(default)]
    pub previous_ports: Vec<u16>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub token: Option<String>,
}

struct Identity {
    token: String,
    certificate: Vec<u8>,
    key: Vec<u8>,
}

fn state_dir(options: Option<&Path>) -> Result<PathBuf, String> {
    let run = RunDir::resolve(options)?;
    let dir = run.dir().join("direct");
    protect_private_directory(&dir)?;
    Ok(dir)
}

/// Restrict a credentials directory to the current user on every platform.
pub fn protect_private_directory(path: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("凭据目录不能是符号链接".into());
    }
    std::fs::create_dir_all(path).map_err(|e| format!("创建凭据目录失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("收紧凭据目录权限失败: {e}"))?;
    }
    #[cfg(windows)]
    protect_windows_directory(path).map_err(|e| format!("收紧凭据目录权限失败: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn protect_windows_directory(path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    // All pointers below belong to local buffers or Win32 LocalAlloc allocations.
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut required = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required);
        let mut buffer = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut length = 0;
        while *sid.add(length) != 0 {
            length += 1;
        }
        let sid_text = String::from_utf16_lossy(std::slice::from_raw_parts(sid, length));
        LocalFree(sid.cast());
        let sddl = format!("D:P(A;OICI;FA;;;{sid_text})")
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut descriptor = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let ok = SetFileSecurityW(
            wide.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        );
        let error = io::Error::last_os_error();
        LocalFree(descriptor);
        if ok == 0 {
            return Err(error);
        }
    }
    Ok(())
}

/// Atomically replace a private file using a staged file on the same filesystem.
/// The caller creates the staging file with private permissions. A failed move
/// preserves the existing destination; there is never a remove-before-rename gap.
pub fn replace_private_file(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("读取临时凭据文件失败: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("临时凭据必须是普通文件".into());
    }
    if std::fs::symlink_metadata(destination).is_ok_and(|value| value.file_type().is_symlink()) {
        return Err("凭据目标不能是符号链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let mut source = source.as_os_str().encode_wide().collect::<Vec<_>>();
        let mut destination = destination.as_os_str().encode_wide().collect::<Vec<_>>();
        if source.contains(&0) || destination.contains(&0) {
            return Err("凭据路径包含无效字符".into());
        }
        source.push(0);
        destination.push(0);
        // SAFETY: paths are NUL-terminated UTF-16, live throughout the call;
        // COPY_ALLOWED is intentionally absent so cross-volume moves fail.
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(format!(
                "原子替换凭据文件失败: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    std::fs::rename(source, destination).map_err(|error| format!("原子替换凭据文件失败: {error}"))
}

fn private_write(path: &Path, content: &[u8]) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("直连配置不能是符号链接".into());
    }
    let temp = path.with_extension(format!("tmp.{}", crate::generate_token()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), String> {
        let mut file = options
            .open(&temp)
            .map_err(|error| format!("创建临时凭据文件失败: {error}"))?;
        file.write_all(content)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("写入临时凭据文件失败: {error}"))?;
        drop(file);
        replace_private_file(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn private_read(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("读取直连配置失败: {e}"))?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 64 * 1024 {
        return Err("直连配置文件类型或大小无效".into());
    }
    std::fs::read(path).map_err(|e| format!("读取直连配置失败: {e}"))
}

fn identity(dir: &Path) -> Result<Identity, String> {
    let token_path = dir.join("token");
    let cert_path = dir.join("certificate.der");
    let key_path = dir.join("private-key.der");
    if !token_path.exists() && !cert_path.exists() && !key_path.exists() {
        let certified =
            rcgen::generate_simple_self_signed(vec!["qingcode.local".into(), "localhost".into()])
                .map_err(|e| format!("生成直连证书失败: {e}"))?;
        private_write(&cert_path, certified.cert.der().as_ref())?;
        private_write(&key_path, &certified.key_pair.serialize_der())?;
        private_write(&token_path, crate::generate_token().as_bytes())?;
    }
    let token = read_pairing_token(dir)?;
    Ok(Identity {
        token,
        certificate: private_read(&cert_path)?,
        key: private_read(&key_path)?,
    })
}

fn read_pairing_token(dir: &Path) -> Result<String, String> {
    let token =
        String::from_utf8(private_read(&dir.join("token"))?).map_err(|_| "直连凭据编码无效")?;
    if token.len() != 32 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("直连凭据格式无效".into());
    }
    Ok(token)
}

pub fn info(state: Option<&Path>, include_secret: bool) -> Result<DirectInfo, String> {
    let dir = state_dir(state)?;
    let mut info: DirectInfo = serde_json::from_slice(&private_read(&dir.join("endpoint.json"))?)
        .map_err(|e| format!("直连端口尚未就绪或配置无效: {e}"))?;
    if include_secret {
        info.token = Some(read_pairing_token(&dir)?);
    }
    Ok(info)
}

pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as libc::pid_t, 0) == 0
                || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut code = 0;
            let alive = GetExitCodeProcess(process, &mut code) != 0 && code == STILL_ACTIVE as u32;
            CloseHandle(process);
            alive
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}

fn secure_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub struct Gateway {
    listener: TcpListener,
    _instance_lock: crate::ipc::IpcListener,
    acceptor: TlsAcceptor,
    token: String,
    endpoint: IpcEndpoint,
    daemon_options: ConnectOptions,
    pub info: DirectInfo,
}

impl Gateway {
    pub async fn bind(options: DirectOptions) -> Result<Self, String> {
        let dir = state_dir(options.state_dir.as_deref())?;
        let instance_lock = IpcEndpoint::new(&dir)
            .listen()
            .map_err(|e| format!("无法取得直连服务锁: {e}"))?
            .ok_or("直连服务已在运行；请先停止旧直连服务，再修改监听端口")?;
        let identity = identity(&dir)?;
        let previous = info(options.state_dir.as_deref(), false).ok();
        let port = if options.port == 0 {
            previous.as_ref().map_or(DEFAULT_DIRECT_PORT, |v| v.port)
        } else {
            options.port
        };
        if previous
            .as_ref()
            .is_some_and(|value| value.pid != std::process::id() && process_alive(value.pid))
        {
            return Err("直连服务仍在运行；请先停止旧直连服务，再修改监听端口".into());
        }
        let mut previous_ports = previous
            .as_ref()
            .map(|v| v.previous_ports.clone())
            .unwrap_or_default();
        if let Some(previous) = previous.as_ref().filter(|v| v.port != port) {
            previous_ports.retain(|value| *value != previous.port && *value != port);
            previous_ports.push(previous.port);
            if previous_ports.len() > 8 {
                previous_ports.remove(0);
            }
        }
        let listener = TcpListener::bind((options.hostname.as_str(), port)).await
            .map_err(|e| format!("无法监听直连 TCP 端口 {port}（可能被占用）；未自动改端口，请检查占用或显式指定新端口: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("读取监听端口失败: {e}"))?
            .port();
        let certificate_sha256 = format!("{:x}", Sha256::digest(&identity.certificate));
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("配置 TLS 失败: {e}"))?
        .with_no_client_auth()
        .with_single_cert(
            vec![identity.certificate.into()],
            PrivatePkcs8KeyDer::from(identity.key).into(),
        )
        .map_err(|e| format!("加载直连证书失败: {e}"))?;
        let info = DirectInfo {
            hostname: options.hostname,
            port,
            certificate_sha256,
            server_version: crate::SERVER_VERSION.into(),
            protocol: proto::PROTOCOL_VERSION,
            pid: std::process::id(),
            previous_ports,
            token: None,
        };
        private_write(
            &dir.join("endpoint.json"),
            &serde_json::to_vec(&info).map_err(|e| e.to_string())?,
        )?;
        let run = RunDir::resolve(options.state_dir.as_deref())?;
        Ok(Self {
            listener,
            _instance_lock: instance_lock,
            acceptor: TlsAcceptor::from(Arc::new(config)),
            token: identity.token,
            endpoint: IpcEndpoint::new(run.dir()),
            daemon_options: ConnectOptions {
                state_dir: options.state_dir,
                ensure_daemon: true,
                ..Default::default()
            },
            info,
        })
    }

    pub async fn run(self) -> Result<(), String> {
        let gateway = Arc::new(self);
        let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        loop {
            let (socket, _) = gateway
                .listener
                .accept()
                .await
                .map_err(|e| format!("直连监听失败: {e}"))?;
            let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                continue;
            };
            let gateway = Arc::clone(&gateway);
            tokio::spawn(async move {
                let _permit = permit;
                // Never log headers, credentials, URL query strings or terminal data.
                let _ = gateway.handle(socket).await;
            });
        }
    }

    async fn handle(&self, socket: TcpStream) -> Result<(), String> {
        let _ = socket.set_nodelay(true);
        let mut tls = tokio::time::timeout(HANDSHAKE_TIMEOUT, self.acceptor.accept(socket))
            .await
            .map_err(|_| "TLS 握手超时")?
            .map_err(|_| "TLS 握手失败")?;
        // Keep-alive is opt-in so older clients can still read until EOF.
        // Bound idle sockets and the number of requests per TLS connection.
        for index in 0..256 {
            let headers = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_headers(&mut tls))
                .await
                .map_err(|_| "HTTP 握手超时")??;
            let request = parse_headers(&headers)?;
            let expected = format!("Bearer {}", self.token);
            if !secure_eq(request.authorization.as_bytes(), expected.as_bytes()) {
                return http_response(&mut tls, 401, br#"{"error":"authenticationRequired"}"#)
                    .await;
            }
            let keep_alive = request.keep_alive && index < 255;
            let body = match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/health") if request.content_length == 0 => {
                    serde_json::to_vec(&serde_json::json!({ "healthy": true,
                        "serverVersion": self.info.server_version, "protocol": self.info.protocol,
                        "port": self.info.port, "previousPorts": self.info.previous_ports, "certificateSha256": self.info.certificate_sha256 }))
                        .map_err(|e| e.to_string())?
                }
                ("GET", "/connect") => {
                    if request.content_length != 0 {
                        return http_response(&mut tls, 400, br#"{"error":"invalidRequest"}"#).await;
                    }
                    let stream = ReplayStream { prefix: std::io::Cursor::new(headers), inner: tls };
                    let config = tungstenite::protocol::WebSocketConfig::default()
                        .max_message_size(Some(proto::MAX_FRAME_BYTES + 4))
                        .max_frame_size(Some(proto::MAX_FRAME_BYTES + 4));
                    let ws = tokio::time::timeout(HANDSHAKE_TIMEOUT,
                        tokio_tungstenite::accept_async_with_config(stream, Some(config)))
                        .await.map_err(|_| "WebSocket 握手超时")?.map_err(|_| "WebSocket 握手失败")?;
                    return self.bridge(ws).await;
                }
                ("POST", "/workspace") => {
                    if request.content_length == 0 {
                        return http_response(&mut tls, 400, br#"{"error":"emptyBody"}"#).await;
                    }
                    let mut body = vec![0; request.content_length];
                    tokio::time::timeout(HANDSHAKE_TIMEOUT, tls.read_exact(&mut body))
                        .await.map_err(|_| "工作区请求超时")?.map_err(|_| "工作区请求不完整")?;
                    let input = match serde_json::from_slice(&body) {
                        Ok(value) => value,
                        Err(_) => return http_response(&mut tls, 400, br#"{"error":"invalidJson"}"#).await,
                    };
                    let value = match crate::workspace::handle(input).await {
                        Ok(value) => serde_json::json!({"ok":true,"value":value}),
                        Err(error) => serde_json::json!({"ok":false,"error":error}),
                    };
                    serde_json::to_vec(&value).map_err(|e| e.to_string())?
                }
                _ => return http_response(&mut tls, 404, br#"{"error":"notFound"}"#).await,
            };
            http_response_connection(&mut tls, 200, &body, keep_alive).await?;
            if !keep_alive {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn bridge<S>(&self, mut ws: tokio_tungstenite::WebSocketStream<S>) -> Result<(), String>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let mut pending = Vec::new();
        let (mut frame, rest) = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Binary(bytes))) => {
                        pending.extend_from_slice(&bytes);
                        if pending.len() > proto::MAX_FRAME_BYTES + 4 {
                            return Err("HELLO 帧过大".to_string());
                        }
                        match proto::decode(&pending) {
                            Ok((frame, consumed)) => {
                                return Ok((frame, pending.split_off(consumed)))
                            }
                            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {}
                            Err(_) => return Err("HELLO 帧无效".into()),
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        ws.send(Message::Pong(bytes))
                            .await
                            .map_err(|_| "WebSocket 已断开")?;
                    }
                    _ => return Err("连接在 HELLO 前结束".into()),
                }
            }
        })
        .await
        .map_err(|_| "HELLO 超时")??;
        if frame.kind != Kind::Hello {
            return Err("首帧必须是 HELLO".into());
        }
        let mut hello: HelloRequest =
            proto::decode_value(&frame.payload).map_err(|_| "HELLO 参数无效")?;
        if !secure_eq(hello.token.as_bytes(), self.token.as_bytes()) {
            return Err("HELLO 认证失败".into());
        }
        let options = self.daemon_options.clone();
        hello.token = tokio::task::spawn_blocking(move || ensure_daemon_token(&options))
            .await
            .map_err(|_| "daemon 就绪检查失败")??;
        frame.payload = proto::encode(&hello).map_err(|e| e.to_string())?;
        let mut ipc = connect_ipc(&self.endpoint).await?;
        proto::write_frame(&mut ipc, &frame)
            .await
            .map_err(|_| "发送 daemon HELLO 失败")?;
        if !rest.is_empty() {
            ipc.write_all(&rest)
                .await
                .map_err(|_| "发送 daemon 数据失败")?;
        }
        let (mut ipc_read, mut ipc_write) = tokio::io::split(ipc);
        let (mut ws_write, mut ws_read) = ws.split();
        let (pong_tx, mut pong_rx) = tokio::sync::mpsc::channel(4);
        let upstream = async {
            while let Some(message) = ws_read.next().await {
                match message.map_err(|_| "WebSocket 读取失败")? {
                    Message::Binary(bytes) => ipc_write
                        .write_all(&bytes)
                        .await
                        .map_err(|_| "写入 daemon 失败")?,
                    Message::Ping(bytes) => {
                        let _ = pong_tx.send(bytes).await;
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    _ => return Err("终端通道只接受二进制消息".to_string()),
                }
            }
            Ok::<_, String>(())
        };
        let downstream = async {
            let mut buffer = vec![0u8; 32 * 1024];
            loop {
                tokio::select! {
                    read = ipc_read.read(&mut buffer) => {
                        let count = read.map_err(|_| "读取 daemon 失败")?;
                        if count == 0 { return Ok::<_, String>(()); }
                        ws_write.send(Message::Binary(buffer[..count].to_vec().into())).await.map_err(|_| "WebSocket 写入失败")?;
                    }
                    Some(bytes) = pong_rx.recv() => { ws_write.send(Message::Pong(bytes)).await.map_err(|_| "WebSocket 已断开")?; }
                }
            }
        };
        // Drop only this IPC connection. daemon retains PTYs and replay buffers.
        tokio::select! { result = upstream => result, result = downstream => result }
    }
}

async fn connect_ipc(endpoint: &IpcEndpoint) -> Result<crate::ipc::IpcStream, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        match endpoint.connect().await {
            Ok(stream) => return Ok(stream),
            Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(25)).await
            }
            Err(_) => return Err("连接本地 daemon 失败".into()),
        }
    }
}

async fn read_headers<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    // Reading one byte at a time avoids consuming any WebSocket body/frame bytes;
    // TLS buffers the records, so this does not cause one network read per byte.
    loop {
        let byte = stream.read_u8().await.map_err(|_| "HTTP 请求不完整")?;
        data.push(byte);
        if data.len() > MAX_HEADERS {
            return Err("HTTP 请求头过大".into());
        }
        if data.ends_with(b"\r\n\r\n") {
            return Ok(data);
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    authorization: String,
    content_length: usize,
    keep_alive: bool,
}

fn parse_headers(bytes: &[u8]) -> Result<HttpRequest, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "HTTP 请求头编码无效")?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().ok_or("HTTP 请求无效")?.split_whitespace();
    let method = first.next().ok_or("HTTP 方法缺失")?.to_string();
    let path = first.next().ok_or("HTTP 路径缺失")?.to_string();
    if first.next() != Some("HTTP/1.1") || first.next().is_some() {
        return Err("仅支持 HTTP/1.1".into());
    }
    let mut authorization = None;
    let mut content_length = None;
    let mut keep_alive = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or("HTTP 请求头无效")?;
        match name.to_ascii_lowercase().as_str() {
            "authorization" => {
                if authorization.replace(value.trim().to_string()).is_some() {
                    return Err("重复认证请求头".into());
                }
            }
            "content-length" => {
                let length = value.trim().parse::<usize>().map_err(|_| "请求长度无效")?;
                if length > MAX_BODY || content_length.replace(length).is_some() {
                    return Err("请求长度无效".into());
                }
            }
            "connection" => {
                if keep_alive
                    .replace(value.trim().eq_ignore_ascii_case("keep-alive"))
                    .is_some()
                {
                    return Err("重复连接请求头".into());
                }
            }
            "transfer-encoding" => return Err("不支持分块请求体".into()),
            _ => {}
        }
    }
    Ok(HttpRequest {
        method,
        path,
        authorization: authorization.unwrap_or_default(),
        content_length: content_length.unwrap_or(0),
        keep_alive: keep_alive.unwrap_or(false),
    })
}

async fn http_response<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    body: &[u8],
) -> Result<(), String> {
    http_response_connection(stream, status, body, false).await
}

async fn http_response_connection<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    body: &[u8],
    keep_alive: bool,
) -> Result<(), String> {
    let connection = if keep_alive { "keep-alive" } else { "close" };
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        _ => "Not Found",
    };
    let head = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: {connection}\r\n\r\n", body.len());
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|_| "HTTP 响应失败")?;
    stream.write_all(body).await.map_err(|_| "HTTP 响应失败")?;
    if keep_alive {
        stream.flush().await.map_err(|_| "HTTP 响应失败".into())
    } else {
        stream
            .shutdown()
            .await
            .map_err(|_| "HTTP 连接关闭失败".into())
    }
}

struct ReplayStream<S> {
    prefix: std::io::Cursor<Vec<u8>>,
    inner: S,
}
impl<S: AsyncRead + Unpin> AsyncRead for ReplayStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let position = self.prefix.position() as usize;
        let data = self.prefix.get_ref();
        if position < data.len() && buf.remaining() > 0 {
            let count = (data.len() - position).min(buf.remaining());
            buf.put_slice(&data[position..position + count]);
            self.prefix.set_position((position + count) as u64);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for ReplayStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_rustls::rustls::pki_types::ServerName;
    use tokio_rustls::TlsConnector;

    fn temporary() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qingcode-direct-{}", crate::generate_token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn available_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn options(dir: &Path, port: u16) -> DirectOptions {
        DirectOptions {
            hostname: "127.0.0.1".into(),
            port,
            state_dir: Some(dir.to_path_buf()),
        }
    }

    async fn tls(dir: &Path, port: u16) -> tokio_rustls::client::TlsStream<TcpStream> {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(
                private_read(&dir.join("direct/certificate.der"))
                    .unwrap()
                    .into(),
            )
            .unwrap();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        TlsConnector::from(Arc::new(config))
            .connect(
                ServerName::try_from("localhost").unwrap(),
                TcpStream::connect(("127.0.0.1", port)).await.unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn identity_port_and_history_survive_restart_and_conflicts_do_not_change_port() {
        async fn rebind_after_drop(options: DirectOptions) -> Gateway {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            loop {
                match Gateway::bind(options.clone()).await {
                    Ok(gateway) => return gateway,
                    Err(error)
                        if tokio::time::Instant::now() < deadline
                            && (error.contains("已在运行")
                                || error.contains("Address already in use")) =>
                    {
                        // Other parallel PTY tests fork. Their pre-exec child
                        // can briefly retain a listener until CLOEXEC runs.
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Err(error) => panic!("listener did not finish closing: {error}"),
                }
            }
        }
        let dir = temporary();
        let first = available_port();
        let gateway = Gateway::bind(options(&dir, first)).await.unwrap();
        let fingerprint = gateway.info.certificate_sha256.clone();
        assert!(!serde_json::to_string(&gateway.info)
            .unwrap()
            .contains("token"));
        assert!(Gateway::bind(options(&dir, available_port()))
            .await
            .err()
            .unwrap()
            .contains("运行"));
        drop(gateway);
        let gateway = rebind_after_drop(options(&dir, 0)).await;
        assert_eq!(gateway.info.port, first);
        assert_eq!(gateway.info.certificate_sha256, fingerprint);
        drop(gateway);
        let second = available_port();
        let gateway = rebind_after_drop(options(&dir, second)).await;
        assert_eq!(gateway.info.previous_ports, [first]);
        drop(gateway);
        let occupied = std::net::TcpListener::bind(("127.0.0.1", second)).unwrap();
        assert!(Gateway::bind(options(&dir, 0))
            .await
            .err()
            .unwrap()
            .contains("未自动改端口"));
        assert_eq!(info(Some(&dir), false).unwrap().port, second);
        drop(occupied);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn https_keep_alive_authenticates_every_request() {
        async fn response(stream: &mut (impl AsyncRead + Unpin)) -> (String, Vec<u8>) {
            let head = read_headers(stream).await.unwrap();
            let head = String::from_utf8(head).unwrap();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await.unwrap();
            (head, body)
        }
        let dir = temporary();
        let gateway = Gateway::bind(options(&dir, available_port()))
            .await
            .unwrap();
        let port = gateway.info.port;
        let token = info(Some(&dir), true).unwrap().token.unwrap();
        let running = tokio::spawn(gateway.run());
        let mut stream = tls(&dir, port).await;
        for credential in [token.as_str(), token.as_str(), "wrong"] {
            stream.write_all(format!("GET /health HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {credential}\r\nConnection: keep-alive\r\n\r\n").as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
            let (head, body) = tokio::time::timeout(Duration::from_secs(2), response(&mut stream))
                .await
                .unwrap();
            if credential == "wrong" {
                assert!(head.starts_with("HTTP/1.1 401 "));
                assert!(head.contains("Connection: close"));
            } else {
                assert!(head.starts_with("HTTP/1.1 200 "));
                assert!(head.contains("Connection: keep-alive"));
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap()["healthy"],
                    true
                );
            }
        }
        let mut trailing = Vec::new();
        stream.read_to_end(&mut trailing).await.unwrap();
        assert!(trailing.is_empty());
        running.abort();
        let _ = running.await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn https_health_requires_authentication_and_never_exposes_pairing_token() {
        let dir = temporary();
        let gateway = Gateway::bind(options(&dir, available_port()))
            .await
            .unwrap();
        let port = gateway.info.port;
        let token = info(Some(&dir), true).unwrap().token.unwrap();
        let running = tokio::spawn(gateway.run());
        for (credential, expected_status) in [("wrong", "401"), (token.as_str(), "200")] {
            let mut stream = tls(&dir, port).await;
            stream.write_all(format!("GET /health HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {credential}\r\n\r\n").as_bytes()).await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            let response = String::from_utf8(bytes).unwrap();
            assert!(response.starts_with(&format!("HTTP/1.1 {expected_status}")));
            assert!(!response.contains(&token));
        }
        running.abort();
        let _ = running.await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn websocket_rejects_bad_credentials_before_opening_daemon_ipc() {
        use tungstenite::client::IntoClientRequest;
        let dir = temporary();
        let gateway = Gateway::bind(options(&dir, available_port()))
            .await
            .unwrap();
        let port = gateway.info.port;
        let token = info(Some(&dir), true).unwrap().token.unwrap();
        let running = tokio::spawn(gateway.run());
        let stream = tls(&dir, port).await;
        let mut request = format!("wss://localhost:{port}/connect")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Authorization", "Bearer wrong".parse().unwrap());
        let result = tokio_tungstenite::client_async(request, stream).await;
        assert!(
            matches!(result, Err(tungstenite::Error::Http(response)) if response.status().as_u16() == 401)
        );
        let stream = tls(&dir, port).await;
        let mut request = format!("wss://localhost:{port}/connect")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::client_async(request, stream)
            .await
            .unwrap();
        let hello = HelloRequest {
            client_id: "wrong-hello-test".into(),
            protocol_min: 1,
            protocol_max: 1,
            token: "wrong".into(),
            resume_token: None,
        };
        socket
            .send(Message::Binary(
                proto::Frame::new(Kind::Hello, 0, proto::encode(&hello).unwrap())
                    .encode()
                    .unwrap()
                    .into(),
            ))
            .await
            .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap();
        assert!(
            closed.is_none()
                || closed.is_some_and(
                    |result| result.is_err() || matches!(result, Ok(Message::Close(_)))
                )
        );
        assert!(
            !dir.join("token").exists(),
            "unauthorized HELLO must not start daemon"
        );
        drop(socket);
        running.abort();
        let _ = running.await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn private_file_replacement_preserves_previous_contents_on_failure() {
        let dir = temporary();
        let destination = dir.join("credentials.json");
        let staged = dir.join("credentials.next");
        std::fs::write(&destination, b"previous").unwrap();
        std::fs::write(&staged, b"replacement").unwrap();
        replace_private_file(&staged, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"replacement");
        assert!(!staged.exists());
        assert!(replace_private_file(&staged, &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"replacement");
        let directory = dir.join("not-a-file");
        std::fs::create_dir(&directory).unwrap();
        assert!(replace_private_file(&directory, &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"replacement");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn request_parser_rejects_ambiguous_auth_and_unbounded_bodies() {
        assert!(parse_headers(
            b"GET /health HTTP/1.1\r\nAuthorization: Bearer a\r\nauthorization: Bearer b\r\n\r\n"
        )
        .is_err());
        assert!(
            parse_headers(b"POST /workspace HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")
                .is_err()
        );
        assert!(
            parse_headers(b"POST /workspace HTTP/1.1\r\nContent-Length: 99999999999\r\n\r\n")
                .is_err()
        );
        assert!(!secure_eq(b"correct", b"wrong"));
    }
}
