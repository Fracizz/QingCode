//! LAN companion endpoint. Only projects selected by the desktop bridge and
//! terminals allocated by this endpoint are addressable by the paired device.
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use rustls::pki_types::PrivatePkcs8KeyDer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter, Listener, Manager, State, WebviewWindow};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Notify, Semaphore};
use tokio_rustls::TlsAcceptor;
use uuid::Uuid;

const PORT: u16 = 48764;
const MAX_SESSIONS: usize = 16;
const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_INPUT: usize = 16 * 1024;
const CODE_TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct MobileState {
    running: Mutex<Option<Arc<Gateway>>>,
    pending: Mutex<HashMap<Uuid, oneshot::Sender<Result<Value, String>>>>,
}

struct Gateway {
    address: SocketAddrV4,
    fingerprint: String,
    stop: watch::Sender<bool>,
    inner: Mutex<GatewayState>,
}

#[derive(Default)]
struct GatewayState {
    code: Option<(String, Instant)>,
    token: Option<String>,
    sessions: HashMap<String, Session>,
    next_number: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    path: String,
    kind: ProjectKind,
    host: String,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ProjectKind {
    Local,
    Wsl,
    Ssh,
}

struct Session {
    project: Project,
    number: u64,
    ready: bool,
    exit: Option<Exit>,
    drain_until: Option<Instant>,
    output: VecDeque<OutputChunk>,
    output_size: usize,
    next: u64,
    changed: Arc<Notify>,
}

impl Session {
    fn new(project: Project, number: u64) -> Self {
        Self {
            project,
            number,
            ready: false,
            exit: None,
            drain_until: None,
            output: VecDeque::new(),
            output_size: 0,
            next: 0,
            changed: Arc::new(Notify::new()),
        }
    }

    fn push(&mut self, chunk: OutputChunk) {
        if matches!(chunk, OutputChunk::Screen { .. }) {
            self.output.clear();
            self.output_size = 0;
        }
        self.output_size += chunk.len();
        self.output.push_back(chunk);
        self.next += 1;
        while self.output_size > MAX_OUTPUT {
            if let Some(removed) = self.output.pop_front() {
                self.output_size -= removed.len();
            }
        }
        self.changed.notify_waiters();
    }

    fn read(&self, from: u64) -> Value {
        let base = self.next - self.output.len() as u64;
        let reset = from < base || from > self.next;
        let start = if reset { 0 } else { (from - base) as usize };
        // Bound each HTTP response independently of the retained history.
        let chunks: Vec<&OutputChunk> = self.output.iter().skip(start).take(4).collect();
        let next = base + (start + chunks.len()) as u64;
        let exit = self
            .exit
            .as_ref()
            .filter(|_| self.drain_until.is_none_or(|until| Instant::now() >= until));
        json!({
            "chunks": chunks,
            "next": next,
            "more": next < self.next,
            "reset": reset,
            "exit": exit,
        })
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum OutputChunk {
    Bytes(String),
    Screen { data: String, cols: u16, rows: u16 },
}

impl OutputChunk {
    fn len(&self) -> usize {
        match self {
            Self::Bytes(data) | Self::Screen { data, .. } => data.len(),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    #[serde(alias = "exit_code")]
    exit_code: u32,
    #[serde(default)]
    disconnected: bool,
}

#[derive(Deserialize)]
struct DataEvent {
    id: String,
    data: String,
}

#[derive(Deserialize)]
struct ScreenEvent {
    id: String,
    data: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
struct ExitEvent {
    id: String,
    #[serde(flatten)]
    exit: Exit,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Operation {
    Pair {
        secret: String,
    },
    Projects,
    Sessions {
        project: String,
    },
    Create {
        project: String,
        cols: u16,
        rows: u16,
    },
    Poll {
        id: String,
        from: u64,
    },
    Input {
        id: String,
        data: String,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    End {
        id: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    address: Option<String>,
    paired: bool,
}

#[derive(Serialize)]
pub struct Pairing {
    address: String,
    code: String,
}

impl Gateway {
    fn pairing(&self) -> Result<Pairing, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.token.is_some() {
            return Err("已有设备配对。请先停止移动连接再重新配对。".into());
        }
        let secret = Uuid::new_v4().simple().to_string();
        inner.code = Some((secret.clone(), Instant::now() + CODE_TTL));
        let address = self.address.to_string();
        Ok(Pairing {
            code: format!("QC1:{address}:{}:{secret}", self.fingerprint),
            address,
        })
    }

    fn authenticate(&self, bearer: Option<&str>) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        if !*self.stop.borrow()
            && inner
                .token
                .as_deref()
                .zip(bearer)
                .is_some_and(|(token, value)| bool::from(token.as_bytes().ct_eq(value.as_bytes())))
        {
            Ok(())
        } else {
            Err("配对已失效，请重新配对。".into())
        }
    }

    fn consume_code(&self, secret: &str) -> Result<String, String> {
        let mut inner = self.inner.lock().unwrap();
        if *self.stop.borrow()
            || !inner.code.as_ref().is_some_and(|(expected, expires)| {
                Instant::now() < *expires
                    && bool::from(expected.as_bytes().ct_eq(secret.as_bytes()))
            })
        {
            return Err("验证码无效、已使用或已过期。".into());
        }
        inner.code = None;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        inner.token = Some(token.clone());
        Ok(token)
    }

    fn session_kind(&self, id: &str) -> Result<ProjectKind, String> {
        let inner = self.inner.lock().unwrap();
        let session = inner.sessions.get(id).ok_or("终端不存在。")?;
        if !session.ready || session.exit.is_some() || *self.stop.borrow() {
            return Err("终端已结束或正在启动。".into());
        }
        Ok(session.project.kind)
    }
}

pub fn listen(app: &AppHandle) {
    let output_app = app.clone();
    app.listen("terminal-data", move |event| {
        let state = output_app.state::<MobileState>();
        let Some(gateway) = state.running.lock().unwrap().clone() else {
            return;
        };
        let Ok(data) = serde_json::from_str::<DataEvent>(event.payload()) else {
            return;
        };
        if let Some(session) = gateway.inner.lock().unwrap().sessions.get_mut(&data.id) {
            session.push(OutputChunk::Bytes(data.data));
        };
    });
    let screen_app = app.clone();
    app.listen("terminal-screen", move |event| {
        let state = screen_app.state::<MobileState>();
        let Some(gateway) = state.running.lock().unwrap().clone() else {
            return;
        };
        let Ok(screen) = serde_json::from_str::<ScreenEvent>(event.payload()) else {
            return;
        };
        if let Some(session) = gateway.inner.lock().unwrap().sessions.get_mut(&screen.id) {
            session.push(OutputChunk::Screen {
                data: screen.data,
                cols: screen.cols,
                rows: screen.rows,
            });
        };
    });
    let exit_app = app.clone();
    app.listen("terminal-exit", move |event| {
        let state = exit_app.state::<MobileState>();
        let Some(gateway) = state.running.lock().unwrap().clone() else {
            return;
        };
        let Ok(exit) = serde_json::from_str::<ExitEvent>(event.payload()) else {
            return;
        };
        if let Some(session) = gateway.inner.lock().unwrap().sessions.get_mut(&exit.id) {
            session.exit = Some(exit.exit);
            session.drain_until = Some(Instant::now() + Duration::from_millis(150));
            session.changed.notify_waiters();
        };
    });
}

#[tauri::command]
pub fn mobile_status(state: State<'_, MobileState>) -> Status {
    let running = state.running.lock().unwrap();
    Status {
        address: running.as_ref().map(|gateway| gateway.address.to_string()),
        paired: running
            .as_ref()
            .is_some_and(|gateway| gateway.inner.lock().unwrap().token.is_some()),
    }
}

#[tauri::command]
pub fn mobile_suggest_address() -> Option<String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

#[tauri::command]
pub async fn mobile_start(address: String, app: AppHandle) -> Result<Pairing, String> {
    let state = app.state::<MobileState>();
    if let Some(gateway) = state.running.lock().unwrap().as_ref() {
        if address != gateway.address.ip().to_string() {
            return Err("更改监听地址前请先停止移动连接。".into());
        }
        return gateway.pairing();
    }
    let ip: Ipv4Addr = address
        .parse()
        .map_err(|_| "请输入 Windows 本机的局域网 IPv4 地址。")?;
    if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
        return Err("请选择具体的 Windows 网卡 IPv4 地址。".into());
    }
    let address = SocketAddrV4::new(ip, PORT);
    let listener = TcpListener::bind(address)
        .await
        .map_err(|error| format!("无法监听 {address}：{error}"))?;
    let certificate =
        rcgen::generate_simple_self_signed(vec![ip.to_string()]).map_err(|e| e.to_string())?;
    let der = certificate.cert.der().clone();
    let fingerprint = format!("{:x}", Sha256::digest(&der));
    let key = PrivatePkcs8KeyDer::from(certificate.key_pair.serialize_der());
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_no_client_auth()
    .with_single_cert(vec![der], key.into())
    .map_err(|e| e.to_string())?;
    let (stop, stop_rx) = watch::channel(false);
    let gateway = Arc::new(Gateway {
        address,
        fingerprint,
        stop,
        inner: Mutex::default(),
    });
    let pairing = gateway.pairing()?;
    {
        let mut running = state.running.lock().unwrap();
        if running.is_some() {
            return Err("移动连接已经启动。".into());
        }
        *running = Some(gateway.clone());
    }
    tauri::async_runtime::spawn(serve(
        app,
        gateway,
        listener,
        TlsAcceptor::from(Arc::new(config)),
        stop_rx,
    ));
    Ok(pairing)
}

#[tauri::command]
pub async fn mobile_stop(app: AppHandle) {
    let state = app.state::<MobileState>();
    let gateway = state.running.lock().unwrap().take();
    let Some(gateway) = gateway else { return };
    gateway.stop.send_replace(true);
    let sessions = std::mem::take(&mut gateway.inner.lock().unwrap().sessions);
    for (id, session) in sessions {
        if session.ready && session.exit.is_none() {
            let _ = end(&app, id, session.project.kind).await;
        }
    }
}

#[tauri::command]
pub fn mobile_bridge_reply(
    window: WebviewWindow,
    state: State<'_, MobileState>,
    id: Uuid,
    data: Option<Value>,
    error: Option<String>,
) {
    if window.label() == "main" {
        if let Some(sender) = state.pending.lock().unwrap().remove(&id) {
            let _ = sender.send(error.map_or_else(|| Ok(data.unwrap_or(Value::Null)), Err));
        }
    }
}

async fn desktop(app: &AppHandle, project: Option<&str>) -> Result<Value, String> {
    let state = app.state::<MobileState>();
    let id = Uuid::new_v4();
    let (sender, receiver) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, sender);
    let result = match app.emit_to(
        "main",
        "mobile-request",
        json!({ "id": id, "project": project }),
    ) {
        Ok(()) => match tokio::time::timeout(Duration::from_secs(20), receiver).await {
            Ok(Ok(result)) => result,
            _ => Err("Windows QingCode 未及时响应，请确认主窗口和远程连接可用。".into()),
        },
        Err(error) => Err(error.to_string()),
    };
    state.pending.lock().unwrap().remove(&id);
    result
}

async fn serve(
    app: AppHandle,
    gateway: Arc<Gateway>,
    listener: TcpListener,
    acceptor: TlsAcceptor,
    mut stop: watch::Receiver<bool>,
) {
    let capacity = Arc::new(Semaphore::new(16));
    loop {
        let stream = tokio::select! {
            _ = stop.changed() => break,
            result = listener.accept() => match result {
                Ok((stream, _)) => stream,
                Err(_) => break,
            },
        };
        let Ok(permit) = capacity.clone().try_acquire_owned() else {
            continue;
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        let gateway = gateway.clone();
        let mut stopped = stop.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let Ok(Ok(stream)) =
                tokio::time::timeout(Duration::from_secs(5), acceptor.accept(stream)).await
            else {
                return;
            };
            let service = service_fn(|request| request_handler(&app, &gateway, request));
            let mut builder = http1::Builder::new();
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

async fn request_handler(
    app: &AppHandle,
    gateway: &Arc<Gateway>,
    request: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    if request.method() != Method::POST || request.uri().path() != "/v1/rpc" {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Full::default())
            .unwrap());
    }
    let (parts, body) = request.into_parts();
    let body = tokio::time::timeout(
        Duration::from_secs(5),
        Limited::new(body, 128 * 1024).collect(),
    )
    .await;
    let request = body
        .ok()
        .and_then(Result::ok)
        .and_then(|body| serde_json::from_slice::<Operation>(&body.to_bytes()).ok());
    let (status, result) = match request {
        Some(Operation::Pair { secret }) => (
            StatusCode::OK,
            gateway
                .consume_code(&secret)
                .map(|token| json!({ "token": token })),
        ),
        Some(operation) => {
            let bearer = parts
                .headers
                .get(hyper::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "));
            match gateway.authenticate(bearer) {
                Ok(()) => {
                    // The operation owns cleanup even if the HTTP stream is dropped.
                    let app = app.clone();
                    let gateway = gateway.clone();
                    let result = tauri::async_runtime::spawn(async move {
                        operate(&app, &gateway, operation).await
                    })
                    .await
                    .unwrap_or_else(|_| Err("Windows 端操作中断。".into()));
                    (StatusCode::OK, result)
                }
                Err(error) => (StatusCode::UNAUTHORIZED, Err(error)),
            }
        }
        None => (StatusCode::BAD_REQUEST, Err("请求格式无效。".into())),
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

async fn operate(
    app: &AppHandle,
    gateway: &Gateway,
    operation: Operation,
) -> Result<Value, String> {
    match operation {
        Operation::Pair { .. } => unreachable!(),
        Operation::Projects => desktop(app, None).await,
        Operation::Sessions { project } => {
            let inner = gateway.inner.lock().unwrap();
            let mut sessions: Vec<_> = inner
                .sessions
                .iter()
                .filter(|(_, session)| session.ready && session.project.id == project)
                .collect();
            sessions.sort_by_key(|(_, session)| session.number);
            Ok(json!(sessions
                .into_iter()
                .map(|(id, session)| json!({
                    "id": id, "number": session.number, "exit": session.exit
                }))
                .collect::<Vec<_>>()))
        }
        Operation::Create {
            project,
            cols,
            rows,
        } => create(app, gateway, &project, cols, rows).await,
        Operation::Poll { id, from } => {
            let wait = {
                let inner = gateway.inner.lock().unwrap();
                let session = inner.sessions.get(&id).ok_or("终端不存在。")?;
                if from != session.next
                    || session
                        .drain_until
                        .is_some_and(|until| Instant::now() >= until)
                {
                    return Ok(session.read(from));
                }
                session.changed.clone().notified_owned()
            };
            let _ = tokio::time::timeout(Duration::from_millis(900), wait).await;
            let inner = gateway.inner.lock().unwrap();
            Ok(inner.sessions.get(&id).ok_or("终端不存在。")?.read(from))
        }
        Operation::Input { id, data } => {
            if data.len() > MAX_INPUT {
                return Err("单次终端输入超过 16 KiB。".into());
            }
            if gateway.session_kind(&id)? == ProjectKind::Ssh {
                crate::remote_ssh::ssh_write_terminal(id, data, app.state()).await?;
            } else {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    app.state::<crate::TerminalManager>().write(&id, &data)
                })
                .await
                .map_err(|error| error.to_string())??;
            }
            Ok(Value::Null)
        }
        Operation::Resize { id, cols, rows } => {
            let (cols, rows) = size(cols, rows);
            if gateway.session_kind(&id)? == ProjectKind::Ssh {
                crate::remote_ssh::ssh_resize_terminal(id, cols, rows, app.state()).await?;
            } else {
                app.state::<crate::TerminalManager>()
                    .resize(&id, cols, rows)?;
            }
            Ok(Value::Null)
        }
        Operation::End { id } => {
            let kind = {
                let mut inner = gateway.inner.lock().unwrap();
                let session = inner.sessions.get_mut(&id).ok_or("终端不存在。")?;
                if !session.ready {
                    return Err("终端正在启动或关闭。".into());
                }
                if session.exit.is_some() {
                    inner.sessions.remove(&id);
                    return Ok(Value::Null);
                }
                session.ready = false;
                session.project.kind
            };
            let result = end(app, id.clone(), kind).await;
            let mut inner = gateway.inner.lock().unwrap();
            if result.is_ok() {
                inner.sessions.remove(&id);
            } else if let Some(session) = inner.sessions.get_mut(&id) {
                session.ready = true;
            }
            result?;
            Ok(Value::Null)
        }
    }
}

fn size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(2, 300), rows.clamp(2, 150))
}

async fn create(
    app: &AppHandle,
    gateway: &Gateway,
    project_id: &str,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    let project: Project = serde_json::from_value(desktop(app, Some(project_id)).await?)
        .map_err(|error| error.to_string())?;
    let id = format!("mobile-{}", Uuid::new_v4().simple());
    let number = {
        let mut inner = gateway.inner.lock().unwrap();
        if *gateway.stop.borrow() {
            return Err("移动连接已停止。".into());
        }
        if inner.sessions.len() >= MAX_SESSIONS {
            return Err("终端数量已达上限，请结束闲置会话。".into());
        }
        inner.next_number += 1;
        let number = inner.next_number;
        inner
            .sessions
            .insert(id.clone(), Session::new(project.clone(), number));
        number
    };
    let (cols, rows) = size(cols, rows);
    let result = if project.kind == ProjectKind::Ssh {
        crate::remote_ssh::ssh_create_terminal(
            id.clone(),
            project.path,
            Some(cols),
            Some(rows),
            None,
            app.clone(),
            app.state(),
        )
        .await
    } else {
        let app = app.clone();
        let id = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<crate::PathAllowlist>()
                .ensure_executable(&project.path)?;
            let manager = app.state::<crate::TerminalManager>();
            if project.kind == ProjectKind::Wsl {
                manager.spawn_mobile_wsl(id, &project.path, cols, rows, app.clone())
            } else {
                manager.spawn(id, &project.path, None, cols, rows, app.clone())
            }
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result)
    };
    let kept = {
        let mut inner = gateway.inner.lock().unwrap();
        if result.is_err() {
            inner.sessions.remove(&id);
            false
        } else if let Some(session) = inner.sessions.get_mut(&id) {
            session.ready = true;
            true
        } else {
            false
        }
    };
    result?;
    if !kept {
        let _ = end(app, id, project.kind).await;
        return Err("移动连接已停止。".into());
    }
    Ok(json!({ "id": id, "number": number }))
}

async fn end(app: &AppHandle, id: String, kind: ProjectKind) -> Result<(), String> {
    if kind == ProjectKind::Ssh {
        crate::remote_ssh::ssh_kill_terminal(id, None, None, app.state()).await
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<crate::TerminalManager>().kill(&id)
        })
        .await
        .map_err(|error| error.to_string())?
    }
}
