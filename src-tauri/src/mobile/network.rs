//! 手机桥接网络层：局域网地址、TLS 监听、HTTP 请求处理与桌面端转发。

use super::*;

pub(super) fn lan_ipv4(ip: Ipv4Addr) -> bool {
    let [first, second, ..] = ip.octets();
    // 100.64.0.0/10 is shared address space used by Tailscale and carrier NAT.
    ip.is_private() || ip.is_link_local() || (first == 100 && second & 0xc0 == 64)
}

pub(super) fn lan_peer(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => ip.is_loopback() || lan_ipv4(ip),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .is_some_and(|ip| ip.is_loopback() || lan_ipv4(ip)),
    }
}

/// Pairable IPv4 addresses of this computer, the default-route address first.
pub(super) fn lan_addresses() -> Vec<Ipv4Addr> {
    let primary = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|socket| {
            // UDP connect selects a route without sending packets.
            socket.connect((Ipv4Addr::new(8, 8, 8, 8), 53))?;
            socket.local_addr()
        })
        .ok()
        .and_then(|address| match address.ip() {
            IpAddr::V4(ip) => Some(ip),
            IpAddr::V6(_) => None,
        });
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let mut addresses: Vec<Ipv4Addr> = networks
        .values()
        .flat_map(|data| data.ip_networks().iter().map(|network| network.addr))
        .filter_map(|address| match address {
            IpAddr::V4(ip) if lan_ipv4(ip) && !ip.is_link_local() => Some(ip),
            _ => None,
        })
        .collect();
    addresses.sort();
    addresses.dedup();
    if let Some(primary) = primary.filter(|ip| addresses.contains(ip)) {
        addresses.retain(|ip| *ip != primary);
        addresses.insert(0, primary);
    }
    addresses
}

pub(super) fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Windows".into())
}

pub(super) fn tls_acceptor(settings: &SavedSettings) -> Result<TlsAcceptor, String> {
    let key = PrivatePkcs8KeyDer::from(settings.private_key.clone());
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| error.to_string())?
    .with_no_client_auth()
    .with_single_cert(vec![settings.certificate.clone().into()], key.into())
    .map_err(|error| error.to_string())?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

pub(super) async fn start_locked(
    app: &AppHandle,
    port: u16,
    code: Option<String>,
) -> Result<(), String> {
    let state = app.state::<MobileState>();
    if port == 0 {
        return Err("端口须在 1–65535 之间。".into());
    }
    let current = state
        .running
        .lock()
        .unwrap()
        .as_ref()
        .map(|running| running.port);
    if current.is_some() && code.is_some() {
        return Err("更换密码前请先停止移动连接。".into());
    }
    if current == Some(port) {
        return Ok(());
    }
    let password = code;
    let code = password.as_deref().map(CodeVerifier::new).transpose()?;
    // Reserve the new port before changing settings or closing the old one.
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))
        .await
        .map_err(|error| format!("无法监听端口 {port}：{error}"))?;
    let (settings, acceptor) = {
        let _guard = SETTINGS_FILE.lock().unwrap();
        let mut settings = match load_settings()? {
            Some(mut saved) => {
                if let Some(code) = code {
                    saved.code = code;
                    saved.password = password;
                }
                saved
            }
            None => {
                let code = code.ok_or("请设置 6–20 位密码。")?;
                let certificate = rcgen::generate_simple_self_signed(vec!["qingcode.local".into()])
                    .map_err(|error| error.to_string())?;
                SavedSettings {
                    endpoint: SavedEndpoint::Port { port },
                    certificate: certificate.cert.der().to_vec(),
                    private_key: certificate.key_pair.serialize_der(),
                    code,
                    password,
                    enabled: true,
                    devices: Vec::new(),
                    desktop_terminals: false,
                }
            }
        };
        settings.endpoint = SavedEndpoint::Port { port };
        settings.enabled = true;
        let acceptor = tls_acceptor(&settings)?;
        save_settings(&settings)?;
        (settings, acceptor)
    };
    let previous = state.running.lock().unwrap().take();
    if let Some(previous) = previous {
        // Paired devices and terminals survive a port switch; only the socket moves.
        previous.shutdown().await;
    }
    state.hub.load(&settings);
    state.hub.inner.lock().unwrap().accepting = true;
    let (stop, stop_rx) = watch::channel(false);
    let task = tauri::async_runtime::spawn(serve(app.clone(), listener, acceptor, stop_rx));
    *state.running.lock().unwrap() = Some(RunningListener { port, stop, task });
    *state.last_error.lock().unwrap() = None;
    Ok(())
}

pub(super) async fn desktop(app: &AppHandle, project: Option<&str>) -> Result<Value, String> {
    desktop_request(app, project, None).await
}

pub(super) async fn desktop_request(
    app: &AppHandle,
    project: Option<&str>,
    attachment: Option<&str>,
) -> Result<Value, String> {
    desktop_query(app, json!({ "project": project, "attachment": attachment })).await
}

/// 经主窗口查询电脑端保存的状态（项目、终端配置）。`request` 为不含 `id` 的请求体。
pub(super) async fn desktop_query(app: &AppHandle, mut request: Value) -> Result<Value, String> {
    let state = app.state::<MobileState>();
    let id = Uuid::new_v4();
    let (sender, receiver) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, sender);
    let opens_project = request
        .get("project")
        .is_some_and(|project| !project.is_null());
    let timeout = if opens_project {
        CREATE_TIMEOUT
    } else {
        PROJECTS_TIMEOUT
    };
    request["id"] = json!(id);
    let result = match app.emit_to("main", "mobile-request", request) {
        Ok(()) => match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            _ if opens_project => Err(
                "Windows QingCode 未及时响应。若电脑上弹出确认（如远端主机指纹），请在电脑上处理后重试。"
                    .into(),
            ),
            _ => Err("Windows QingCode 未及时响应，请确认主窗口和远程连接可用。".into()),
        },
        Err(error) => Err(error.to_string()),
    };
    state.pending.lock().unwrap().remove(&id);
    result
}

pub(super) async fn serve(
    app: AppHandle,
    listener: TcpListener,
    acceptor: TlsAcceptor,
    mut stop: watch::Receiver<bool>,
) {
    let capacity = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (stream, peer) = tokio::select! {
            biased;
            _ = stop.changed() => break,
            result = listener.accept() => match result {
                Ok((stream, peer)) if lan_peer(peer.ip()) => (stream, peer.ip()),
                Ok(_) => continue,
                Err(_) => break,
            },
        };
        let Ok(permit) = capacity.clone().try_acquire_owned() else {
            continue;
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        let mut stopped = stop.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let Ok(Ok(stream)) =
                tokio::time::timeout(Duration::from_secs(5), acceptor.accept(stream)).await
            else {
                return;
            };
            let service = service_fn(|request| request_handler(&app, peer, request));
            let mut builder = http1::Builder::new();
            // Idle keep-alive connections close after this; phones expire theirs sooner.
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(15));
            // Let an authenticated operation finish cleanup if the network disappears.
            let connection = builder.serve_connection(TokioIo::new(stream), service);
            tokio::pin!(connection);
            tokio::select! {
                _ = &mut connection => {},
                _ = stopped.changed() => {
                    connection.as_mut().graceful_shutdown();
                    let _ = connection.await;
                },
            }
        });
    }
}

pub(super) async fn request_handler(
    app: &AppHandle,
    peer: IpAddr,
    request: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    if request.method() != Method::POST || request.uri().path() != "/v1/rpc" {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Full::default())
            .unwrap());
    }
    let (parts, body) = request.into_parts();
    let bearer = parts
        .headers
        .get(hyper::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let (limit, timeout) = if app.state::<MobileState>().hub.authenticate(bearer).is_ok() {
        // Base64 images can take longer than small terminal RPCs over a mobile uplink.
        (12 * 1024 * 1024, Duration::from_secs(60))
    } else {
        (128 * 1024, Duration::from_secs(15))
    };
    let request = read_operation(body, limit, timeout).await;
    let (status, result) = match request {
        Ok(Operation::Pair { secret, device }) => {
            let app = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                app.state::<MobileState>()
                    .hub
                    .pair(peer, &secret, device.as_deref(), |device| {
                        update_settings(|settings| {
                            settings.devices.retain(|saved| saved.id != device.id);
                            settings.devices.push(device.clone());
                        })
                    })
            })
            .await
            .map_err(|_| "配对处理失败。".to_string())
            .and_then(|result| result);
            (
                StatusCode::OK,
                result.map(|token| json!({ "token": token })),
            )
        }
        Ok(operation) => {
            let bearer = parts
                .headers
                .get(hyper::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "));
            match app.state::<MobileState>().hub.authenticate(bearer) {
                Ok(device) => {
                    // The operation owns cleanup even if the HTTP stream is dropped.
                    let app = app.clone();
                    let result = tauri::async_runtime::spawn(async move {
                        operate(&app, &device, operation).await
                    })
                    .await
                    .unwrap_or_else(|_| Err("Windows 端操作中断。".into()));
                    (StatusCode::OK, result)
                }
                Err((status, error)) => (status, Err(error)),
            }
        }
        Err((status, error)) => (status, Err(error)),
    };
    let response = match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    Ok(Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::from(response.to_string())))
        .unwrap())
}

pub(super) async fn read_operation<B>(
    body: B,
    limit: usize,
    timeout: Duration,
) -> Result<Operation, (StatusCode, String)>
where
    B: hyper::body::Body,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let body = tokio::time::timeout(timeout, Limited::new(body, limit).collect())
        .await
        .map_err(|_| {
            (
                StatusCode::REQUEST_TIMEOUT,
                "读取上传请求超时，请检查手机到电脑的网络后重试。".into(),
            )
        })?
        .map_err(|error| {
            if error.is::<http_body_util::LengthLimitError>() {
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "请求过大，请提高图片压缩等级后重试。".into(),
                )
            } else {
                (
                    StatusCode::BAD_REQUEST,
                    "请求传输中断，请检查网络后重试。".into(),
                )
            }
        })?;
    serde_json::from_slice::<Operation>(&body.to_bytes())
        .map_err(|_| (StatusCode::BAD_REQUEST, "请求格式无效。".into()))
}
