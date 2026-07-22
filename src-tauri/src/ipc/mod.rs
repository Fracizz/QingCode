//! Localhost JSON-line IPC between `qingcode.exe` CLI and a running GUI.

use crate::app_paths;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcRequest {
    pub id: String,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcResponse {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct EndpointFile {
    port: u16,
    pid: u32,
}

type PendingMap = Mutex<HashMap<String, Sender<IpcResponse>>>;

fn pending() -> &'static PendingMap {
    static PENDING: OnceLock<PendingMap> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub enum ClientError {
    AppNotRunning(String),
    Other(String),
}

/// Start the IPC listener in a background thread and publish the endpoint file.
pub fn start_server(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(e) = serve(app) {
            eprintln!("qingcode ipc server failed: {e}");
        }
    });
}

fn serve(app: AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind ipc: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    let endpoint = app_paths::ipc_endpoint_file();
    if let Some(parent) = endpoint.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create ipc dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(&EndpointFile {
        port,
        pid: std::process::id(),
    })
    .map_err(|e| e.to_string())?;
    std::fs::write(&endpoint, body + "\n").map_err(|e| format!("write ipc file: {e}"))?;

    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = handle_client(app, stream) {
                eprintln!("qingcode ipc client error: {e}");
            }
        });
    }
    Ok(())
}

fn handle_client(app: AppHandle, stream: TcpStream) -> Result<(), String> {
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(30))).ok();
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut writer = stream;
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("read request: {e}"))?;
    if line.trim().is_empty() {
        return Ok(());
    }
    let req: IpcRequest =
        serde_json::from_str(line.trim()).map_err(|e| format!("bad request json: {e}"))?;

    let (tx, rx) = channel::<IpcResponse>();
    pending()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(req.id.clone(), tx);

    if let Err(e) = app.emit("cli-request", &req) {
        pending().lock().ok().map(|mut g| g.remove(&req.id));
        return Err(format!("emit cli-request: {e}"));
    }

    let resp = rx
        .recv_timeout(Duration::from_secs(20))
        .unwrap_or_else(|_| IpcResponse {
            id: req.id.clone(),
            ok: false,
            data: None,
            error: Some("frontend did not respond in time".into()),
        });
    pending().lock().ok().map(|mut g| g.remove(&req.id));

    let out = serde_json::to_string(&resp).map_err(|e| e.to_string())?;
    writeln!(writer, "{out}").map_err(|e| format!("write response: {e}"))?;
    Ok(())
}

pub fn resolve_request(id: &str, ok: bool, data: Option<serde_json::Value>, error: Option<String>) {
    let resp = IpcResponse {
        id: id.to_string(),
        ok,
        data,
        error,
    };
    if let Ok(mut guard) = pending().lock() {
        if let Some(tx) = guard.remove(id) {
            let _ = tx.send(resp);
        }
    }
}

pub fn client_request(req: &IpcRequest) -> Result<IpcResponse, ClientError> {
    let endpoint = read_live_endpoint().map_err(ClientError::AppNotRunning)?;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], endpoint.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| {
        ClientError::AppNotRunning(format!(
            "QingCode app is not running (connect 127.0.0.1:{} failed: {e})",
            endpoint.port
        ))
    })?;
    stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let body = serde_json::to_string(req).map_err(|e| ClientError::Other(e.to_string()))?;
    writeln!(stream, "{body}").map_err(|e| ClientError::Other(format!("send: {e}")))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| ClientError::Other(format!("recv: {e}")))?;
    if line.trim().is_empty() {
        return Err(ClientError::Other(
            "empty response from QingCode app (is the UI still loading?)".into(),
        ));
    }
    serde_json::from_str(line.trim()).map_err(|e| ClientError::Other(format!("bad response: {e}")))
}

fn read_live_endpoint() -> Result<EndpointFile, String> {
    let path = app_paths::ipc_endpoint_file();
    if !path.exists() {
        return Err("QingCode app is not running (no ipc endpoint)".into());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read ipc file: {e}"))?;
    let ep: EndpointFile =
        serde_json::from_str(&raw).map_err(|e| format!("invalid ipc file: {e}"))?;
    if !process_alive(ep.pid) {
        let _ = std::fs::remove_file(&path);
        return Err("QingCode app is not running (stale ipc endpoint)".into());
    }
    Ok(ep)
}

fn process_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.process(Pid::from_u32(pid)).is_some()
}
