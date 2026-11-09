//! Localhost JSON-line IPC between `qingcode.exe` CLI and a running GUI.

use crate::app_paths;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// CLI 与 GUI 之间的请求约定版本；新增或改变 op 语义时递增。
pub const PROTOCOL_VERSION: u32 = 2;

const FRONTEND_RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);
/// 必须长于服务端等待，超时结论统一由服务端给出，客户端不会先放弃。
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(75);
const BRIDGE_READY_WAIT: Duration = Duration::from_secs(10);
const FRONTEND_TIMEOUT_ERROR: &str =
    "QingCode did not finish within 60s; the operation may still be running. Check its state before retrying";
const UI_NOT_READY_ERROR: &str = "QingCode is still loading its UI; retry shortly";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 各 op 自己的附加参数，例如 `task`、`tail`、`scope`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<serde_json::Value>,
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
    /// 每次 GUI 启动随机生成；只有能读取端点文件的进程才能发起请求。
    #[serde(default)]
    token: String,
}

/// 线路格式：令牌只在 CLI 与原生层之间传递，绝不转发给 WebView。
#[derive(Debug, Serialize, Deserialize)]
struct IpcEnvelope {
    #[serde(default)]
    token: String,
    #[serde(flatten)]
    request: IpcRequest,
}

type PendingMap = Mutex<HashMap<String, Sender<IpcResponse>>>;

fn pending() -> &'static PendingMap {
    static PENDING: OnceLock<PendingMap> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub enum ClientError {
    AppNotRunning(String),
    Timeout(String),
    Other(String),
}

/// 已完成 `cli-request` 订阅的窗口。事件不排队，订阅前发出的请求会丢失。
fn bridge_ready_windows() -> &'static Mutex<HashSet<String>> {
    static READY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    READY.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn mark_bridge_ready(label: &str) {
    if let Ok(mut ready) = bridge_ready_windows().lock() {
        ready.insert(label.to_string());
    }
}

fn is_bridge_ready(label: &str) -> bool {
    bridge_ready_windows()
        .lock()
        .map(|ready| ready.contains(label))
        .unwrap_or(false)
}

fn wait_for_bridge(label: &str) -> bool {
    let begin = Instant::now();
    while !is_bridge_ready(label) {
        if begin.elapsed() >= BRIDGE_READY_WAIT {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

fn preferred_window(app: &AppHandle) -> Option<String> {
    if app.get_webview_window("main").is_some() {
        Some("main".to_string())
    } else {
        app.webview_windows().keys().next().cloned()
    }
}

fn write_response(writer: &mut TcpStream, response: &IpcResponse) -> Result<(), String> {
    let out = serde_json::to_string(response).map_err(|e| e.to_string())?;
    writeln!(writer, "{out}").map_err(|e| format!("write response: {e}"))
}

fn ok_response(id: String, data: serde_json::Value) -> IpcResponse {
    IpcResponse {
        id,
        ok: true,
        data: Some(data),
        error: None,
    }
}

fn error_response(id: String, error: impl Into<String>) -> IpcResponse {
    IpcResponse {
        id,
        ok: false,
        data: None,
        error: Some(error.into()),
    }
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
    let token = generate_token();
    let body = serde_json::to_string_pretty(&EndpointFile {
        port,
        pid: std::process::id(),
        token: token.clone(),
    })
    .map_err(|e| e.to_string())?;
    write_endpoint_file(&endpoint, &(body + "\n")).map_err(|e| format!("write ipc file: {e}"))?;

    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let app = app.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            if let Err(e) = handle_client(app, stream, &token) {
                eprintln!("qingcode ipc client error: {e}");
            }
        });
    }
    Ok(())
}

fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 先收紧权限再写入内容，避免令牌出现在可被其他用户读取的文件里。
fn write_endpoint_file(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        // 旧版本留下的文件可能是 0644，mode() 对已存在的文件不生效。
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(body.as_bytes())
}

/// 比较耗时与首个不同字节的位置无关。
fn token_matches(expected: &str, provided: &str) -> bool {
    let (a, b) = (expected.as_bytes(), provided.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// 解析一行请求；令牌不匹配时拒绝，且不会把内容交给后续处理。
fn parse_authorized_request(line: &str, token: &str) -> Result<IpcRequest, String> {
    let envelope: IpcEnvelope =
        serde_json::from_str(line.trim()).map_err(|e| format!("bad request json: {e}"))?;
    if !token_matches(token, &envelope.token) {
        return Err("unauthorized IPC request".into());
    }
    Ok(envelope.request)
}

fn handle_client(app: AppHandle, stream: TcpStream, token: &str) -> Result<(), String> {
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
    let req = match parse_authorized_request(&line, token) {
        Ok(req) => req,
        Err(error) => {
            write_response(&mut writer, &error_response(String::new(), error.clone()))?;
            return Err(error);
        }
    };

    // 原生层直接回答，界面还在加载时也能用来判断应用状态。
    if req.op == "app.info" {
        let ui_ready = preferred_window(&app).is_some_and(|label| is_bridge_ready(&label));
        let data = serde_json::json!({
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": PROTOCOL_VERSION,
            "uiReady": ui_ready,
        });
        return write_response(&mut writer, &ok_response(req.id, data));
    }

    // `qingcode open ...` follows Explorer's independent-file-window model.
    // Acknowledging the native queue keeps this reliable even before its WebView
    // has subscribed; open/read errors are then rendered in the target tab.
    if req.op == "open" {
        let targets = req.paths.clone().unwrap_or_default();
        let response = if targets.is_empty() {
            error_response(req.id, "paths required")
        } else {
            match crate::route_external_file_targets(&app, targets.clone()) {
                Ok(()) => ok_response(req.id, serde_json::json!({ "queued": targets })),
                Err(error) => error_response(req.id, error),
            }
        };
        return write_response(&mut writer, &response);
    }

    let Some(target) = preferred_window(&app) else {
        return Err("no QingCode window is available".into());
    };
    if !wait_for_bridge(&target) {
        return write_response(&mut writer, &error_response(req.id, UI_NOT_READY_ERROR));
    }

    let (tx, rx) = channel::<IpcResponse>();
    pending()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(req.id.clone(), tx);

    if let Err(e) = app.emit_to(&target, "cli-request", &req) {
        pending().lock().ok().map(|mut g| g.remove(&req.id));
        return Err(format!("emit cli-request: {e}"));
    }

    let resp = rx
        .recv_timeout(FRONTEND_RESPONSE_TIMEOUT)
        .unwrap_or_else(|_| error_response(req.id.clone(), FRONTEND_TIMEOUT_ERROR));
    pending().lock().ok().map(|mut g| g.remove(&req.id));

    write_response(&mut writer, &resp)
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
    stream.set_read_timeout(Some(CLIENT_READ_TIMEOUT)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let body = serde_json::to_string(&IpcEnvelope {
        token: endpoint.token,
        request: req.clone(),
    })
    .map_err(|e| ClientError::Other(e.to_string()))?;
    writeln!(stream, "{body}").map_err(|e| ClientError::Other(format!("send: {e}")))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| match e.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => {
            ClientError::Timeout(FRONTEND_TIMEOUT_ERROR.to_string())
        }
        _ => ClientError::Other(format!("recv: {e}")),
    })?;
    if line.trim().is_empty() {
        return Err(ClientError::Other(
            "empty response from QingCode app (is the UI still loading?)".into(),
        ));
    }
    let response: IpcResponse = serde_json::from_str(line.trim())
        .map_err(|e| ClientError::Other(format!("bad response: {e}")))?;
    classify_response(response)
}

/// 超时和界面未就绪需要调用方采取不同动作，不能和普通失败共用退出码。
fn classify_response(response: IpcResponse) -> Result<IpcResponse, ClientError> {
    match response.error.as_deref() {
        Some(FRONTEND_TIMEOUT_ERROR) => {
            Err(ClientError::Timeout(FRONTEND_TIMEOUT_ERROR.to_string()))
        }
        Some(UI_NOT_READY_ERROR) => Err(ClientError::AppNotRunning(UI_NOT_READY_ERROR.to_string())),
        _ => Ok(response),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn request_line(token: &str) -> String {
        serde_json::to_string(&IpcEnvelope {
            token: token.into(),
            request: IpcRequest {
                id: "1".into(),
                op: "terminal.send".into(),
                project: None,
                config: Some("t".into()),
                path: None,
                paths: None,
                content: Some("x".into()),
                options: None,
            },
        })
        .unwrap()
    }

    #[test]
    fn client_waits_longer_than_the_server_so_timeouts_are_never_premature() {
        assert!(CLIENT_READ_TIMEOUT > FRONTEND_RESPONSE_TIMEOUT + BRIDGE_READY_WAIT);
    }

    #[test]
    fn timeout_and_loading_responses_get_their_own_client_errors() {
        let timed_out = classify_response(error_response("1".into(), FRONTEND_TIMEOUT_ERROR));
        assert!(matches!(timed_out, Err(ClientError::Timeout(_))));
        let loading = classify_response(error_response("1".into(), UI_NOT_READY_ERROR));
        assert!(matches!(loading, Err(ClientError::AppNotRunning(_))));
        let failed = classify_response(error_response("1".into(), "boom"))
            .ok()
            .unwrap();
        assert_eq!(failed.error.as_deref(), Some("boom"));
    }

    #[test]
    fn bridge_readiness_is_tracked_per_window() {
        assert!(!is_bridge_ready("test-window-a"));
        mark_bridge_ready("test-window-a");
        assert!(is_bridge_ready("test-window-a"));
        assert!(!is_bridge_ready("test-window-b"));
    }

    #[test]
    fn older_requests_without_options_still_parse() {
        let request: IpcRequest = serde_json::from_str(r#"{"id":"1","op":"run.status"}"#).unwrap();
        assert!(request.options.is_none());
    }

    #[test]
    fn ipc_request_with_correct_token_is_accepted_without_exposing_it() {
        let req = parse_authorized_request(&request_line("secret"), "secret").unwrap();
        assert_eq!(req.op, "terminal.send");
        assert_eq!(req.content.as_deref(), Some("x"));
        // 转发给 WebView 的是 IpcRequest，序列化结果不能带令牌。
        assert!(!serde_json::to_string(&req).unwrap().contains("secret"));
    }

    #[test]
    fn ipc_request_with_wrong_or_missing_token_is_rejected() {
        for line in [
            request_line("wrong!"),
            request_line(""),
            r#"{"id":"1","op":"trust.grant","path":"D:/x"}"#.to_string(),
        ] {
            assert_eq!(
                parse_authorized_request(&line, "secret").unwrap_err(),
                "unauthorized IPC request"
            );
        }
    }

    #[test]
    fn empty_expected_token_never_matches() {
        assert!(!token_matches("", ""));
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("abc", "abcd"));
    }

    #[test]
    fn generated_tokens_are_long_and_unique() {
        let (a, b) = (generate_token(), generate_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn endpoint_file_without_token_parses_as_unauthenticated() {
        let ep: EndpointFile = serde_json::from_str(r#"{"port":1,"pid":2}"#).unwrap();
        assert!(ep.token.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn endpoint_file_is_private_even_when_it_already_exists() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("qingcode.ipc");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_endpoint_file(&path, "new").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }
}
