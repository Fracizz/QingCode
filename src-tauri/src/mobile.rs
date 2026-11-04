//! LAN companion endpoint. Only projects selected by the desktop bridge and
//! terminals allocated by this endpoint are addressable by paired devices.
//!
//! Pairings are persisted as SHA-256 token digests so a phone stays paired across
//! desktop restarts. Terminal output for `mobile-*` sessions is delivered here
//! directly by the PTY / SSH emitters instead of being broadcast to webviews.
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::mobile_screen::MobileScreen;
use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use ring::pbkdf2;
use rustls::pki_types::PrivatePkcs8KeyDer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Notify, Semaphore};
use tokio_rustls::TlsAcceptor;
use uuid::Uuid;

/// Terminal ids owned by the companion endpoint. Emitters route these ids here.
pub(crate) const TERMINAL_PREFIX: &str = "mobile-";
const DEFAULT_PORT: u16 = 48764;
const MAX_SESSIONS: usize = 16;
const MAX_DEVICES: usize = 8;
const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_INPUT: usize = 16 * 1024;
const MAX_IMAGE: usize = 8 * 1024 * 1024;
/// Upper bound for one poll response body before JSON framing.
const MAX_POLL_BYTES: usize = 192 * 1024;
/// 长轮询被新输出唤醒后再等一小段，把同一帧 TUI 重绘的后续字节一起返回，
/// 避免一帧被拆成两次响应而在手机上露出半帧（闪烁）。
const OUTPUT_COALESCE: Duration = Duration::from_millis(24);
const ATTEMPT_WINDOW: Duration = Duration::from_secs(60);
const MAX_PEER_ATTEMPTS: usize = 5;
/// Bounds PBKDF2 work across all sources; per-source limits stop lockouts by one host.
const MAX_TOTAL_ATTEMPTS: usize = 20;
const ONLINE_WINDOW: Duration = Duration::from_secs(15);
const PROJECTS_TIMEOUT: Duration = Duration::from_secs(20);
/// Opening a project may wait for a desktop prompt such as host-key confirmation.
const CREATE_TIMEOUT: Duration = Duration::from_secs(90);
#[cfg(not(test))]
const CODE_ROUNDS: NonZeroU32 = NonZeroU32::new(600_000).unwrap();
// Unoptimized test builds would spend seconds per derivation.
#[cfg(test)]
const CODE_ROUNDS: NonZeroU32 = NonZeroU32::new(1_000).unwrap();
const MAX_DEVICE_NAME: usize = 48;

/// Serializes read-modify-write cycles of the settings file.
static SETTINGS_FILE: Mutex<()> = Mutex::new(());

#[derive(Default)]
pub struct MobileState {
    hub: Hub,
    running: Mutex<Option<RunningListener>>,
    lifecycle: tokio::sync::Mutex<()>,
    pending: Mutex<HashMap<Uuid, oneshot::Sender<Result<Value, String>>>>,
    last_error: Mutex<Option<String>>,
}

struct RunningListener {
    port: u16,
    stop: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl RunningListener {
    async fn shutdown(mut self) {
        self.stop.send_replace(true);
        let _ = (&mut self.task).await;
    }
}

#[derive(Default)]
struct Hub {
    inner: Mutex<HubState>,
}

#[derive(Default)]
struct HubState {
    accepting: bool,
    configured: bool,
    enabled: bool,
    saved_port: Option<u16>,
    fingerprint: Option<String>,
    code: Option<CodeVerifier>,
    devices: Vec<DeviceEntry>,
    attempts: HashMap<IpAddr, VecDeque<Instant>>,
    total_attempts: VecDeque<Instant>,
    sessions: HashMap<String, Session>,
    next_number: u64,
}

struct DeviceEntry {
    saved: Device,
    last_seen: Option<Instant>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    token_digest: [u8; 32],
    paired_at: u64,
}

#[derive(Serialize, Deserialize)]
struct SavedSettings {
    #[serde(flatten)]
    endpoint: SavedEndpoint,
    certificate: Vec<u8>,
    private_key: Vec<u8>,
    code: CodeVerifier,
    /// Kept with the certificate key in the owner-only settings file so the desktop can
    /// restore and reveal it. Legacy verifier-only files still load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    /// Restart the listener automatically when the desktop starts.
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    devices: Vec<Device>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum SavedEndpoint {
    Port { port: u16 },
    Legacy { address: SocketAddrV4 },
}

impl SavedEndpoint {
    fn port(&self) -> u16 {
        match self {
            Self::Port { port } => *port,
            Self::Legacy { address } => address.port(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct CodeVerifier {
    salt: [u8; 16],
    digest: [u8; 32],
}

fn valid_code(code: &str) -> bool {
    (6..=20).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_graphic())
}

impl CodeVerifier {
    fn new(code: &str) -> Result<Self, String> {
        if !valid_code(code) {
            return Err("密码须为 6–20 位，可使用数字、英文字母或符号，无需组合。".into());
        }
        let salt = *Uuid::new_v4().as_bytes();
        let mut digest = [0; 32];
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA256,
            CODE_ROUNDS,
            &salt,
            code.as_bytes(),
            &mut digest,
        );
        Ok(Self { salt, digest })
    }

    fn matches(&self, code: &str) -> bool {
        valid_code(code)
            && pbkdf2::verify(
                pbkdf2::PBKDF2_HMAC_SHA256,
                CODE_ROUNDS,
                &self.salt,
                code.as_bytes(),
                &self.digest,
            )
            .is_ok()
    }
}

fn settings_path() -> PathBuf {
    crate::app_paths::app_data_dir()
        .join("mobile")
        .join("settings.json")
}

fn load_settings() -> Result<Option<SavedSettings>, String> {
    let path = settings_path();
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let content = qingcode_server::direct::private_read(&path)?;
    serde_json::from_slice(&content)
        .map(Some)
        .map_err(|error| format!("读取移动连接设置失败：{error}"))
}

fn save_settings(settings: &SavedSettings) -> Result<(), String> {
    let path = settings_path();
    qingcode_server::direct::protect_private_directory(path.parent().unwrap())?;
    let content = serde_json::to_vec(settings).map_err(|error| error.to_string())?;
    qingcode_server::direct::private_write(&path, &content)
}

fn update_settings(change: impl FnOnce(&mut SavedSettings)) -> Result<(), String> {
    let _guard = SETTINGS_FILE.lock().unwrap();
    let Some(mut settings) = load_settings()? else {
        return Ok(());
    };
    change(&mut settings);
    save_settings(&settings)
}

fn fingerprint(certificate: &[u8]) -> String {
    format!("{:x}", Sha256::digest(certificate))
}

fn token_digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn device_name(name: Option<&str>) -> String {
    let name: String = name
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DEVICE_NAME)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "Android 设备".into()
    } else {
        name.into()
    }
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ProjectKind {
    Local,
    Wsl,
    Ssh,
}

struct Session {
    project: Project,
    owner: String,
    number: u64,
    custom_name: Option<String>,
    name_revision: u64,
    ready: bool,
    exit: Option<Exit>,
    drain_until: Option<Instant>,
    output: VecDeque<OutputChunk>,
    output_size: usize,
    next: u64,
    changed: Arc<Notify>,
    screen: MobileScreen,
}

impl Session {
    fn new(project: Project, owner: String, number: u64) -> Self {
        Self {
            project,
            owner,
            number,
            custom_name: None,
            name_revision: 0,
            ready: false,
            exit: None,
            drain_until: None,
            output: VecDeque::new(),
            output_size: 0,
            next: 0,
            changed: Arc::new(Notify::new()),
            screen: MobileScreen::new(),
        }
    }

    fn push(&mut self, chunk: OutputChunk) {
        let previous_title = self.screen.title().map(str::to_owned);
        match &chunk {
            OutputChunk::Bytes(data) => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                    self.screen.process(&bytes);
                }
            }
            OutputChunk::Screen { data, cols, rows } => self.screen.replace(data, *cols, *rows),
        }
        if previous_title.as_deref() != self.screen.title() {
            self.name_revision += 1;
        }
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

    fn finish(&mut self, exit: Exit) {
        self.exit = Some(exit);
        self.drain_until = Some(Instant::now() + Duration::from_millis(150));
        self.changed.notify_waiters();
    }

    fn name(&self) -> String {
        self.custom_name
            .as_deref()
            .or_else(|| self.screen.title())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("终端 {}", self.number))
    }

    fn rename(&mut self, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("会话名称最多 80 个字符，不能包含控制字符。".into());
        }
        self.custom_name = if name.is_empty() {
            None
        } else {
            Some(name.into())
        };
        self.name_revision += 1;
        self.changed.notify_waiters();
        Ok(())
    }

    fn metadata(&self, id: &str) -> Value {
        json!({ "id": id, "number": self.number, "exit": self.exit,
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision })
    }

    fn read(&self, from: u64) -> Value {
        let base = self.next - self.output.len() as u64;
        let reset = from < base || from > self.next;
        let start = if reset { 0 } else { (from - base) as usize };
        // Bound each HTTP response independently of the retained history.
        let mut budget = 0;
        let chunks: Vec<&OutputChunk> = self
            .output
            .iter()
            .skip(start)
            .take_while(|chunk| {
                let first = budget == 0;
                budget += chunk.encoded_len();
                first || budget <= MAX_POLL_BYTES
            })
            .collect();
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
            "historyBefore": self.screen.history_before(),
            "historyAvailable": self.screen.has_history(),
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision,
        })
    }

    fn latest(&self) -> Value {
        let exit = self
            .exit
            .as_ref()
            .filter(|_| self.drain_until.is_none_or(|until| Instant::now() >= until));
        json!({
            "chunks": [self.screen.snapshot()], "next": self.next,
            "more": false, "reset": false, "snapshot": true, "exit": exit,
            "historyBefore": self.screen.history_before(),
            "historyAvailable": self.screen.has_history(),
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision,
        })
    }
}

/// `Bytes` carries base64 PTY output. `Screen` carries a daemon screen snapshot as
/// plain terminal text that replaces the visible screen.
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

    /// Escape sequences in snapshots expand to `\u001b` inside JSON.
    fn encoded_len(&self) -> usize {
        match self {
            Self::Bytes(data) => data.len(),
            Self::Screen { data, .. } => data.len() * 3,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    exit_code: u32,
    disconnected: bool,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Operation {
    Pair {
        secret: String,
        #[serde(default)]
        device: Option<String>,
    },
    Ping,
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
        #[serde(default)]
        latest: bool,
        #[serde(default)]
        tail: bool,
    },
    History {
        id: String,
        before: u64,
    },
    Input {
        id: String,
        data: String,
    },
    Image {
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
    RenameSession {
        id: String,
        name: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    port: Option<u16>,
    saved_port: u16,
    configured: bool,
    enabled: bool,
    fingerprint: Option<String>,
    devices: Vec<DeviceStatus>,
    addresses: Vec<String>,
    computer: String,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStatus {
    id: String,
    name: String,
    paired_at: u64,
    online: bool,
}

#[derive(Serialize)]
pub struct QrMatrix {
    size: usize,
    /// Row-major modules, `1` for dark.
    modules: String,
}

fn prune(attempts: &mut VecDeque<Instant>, now: Instant) {
    while attempts
        .front()
        .is_some_and(|time| now.duration_since(*time) >= ATTEMPT_WINDOW)
    {
        attempts.pop_front();
    }
}

fn remove_attempt(attempts: &mut VecDeque<Instant>, time: Instant) {
    if let Some(index) = attempts.iter().position(|item| *item == time) {
        attempts.remove(index);
    }
}

impl Hub {
    fn load(&self, settings: &SavedSettings) {
        let mut inner = self.inner.lock().unwrap();
        inner.configured = true;
        inner.enabled = settings.enabled;
        inner.saved_port = Some(settings.endpoint.port());
        inner.fingerprint = Some(fingerprint(&settings.certificate));
        inner.code = Some(settings.code.clone());
        let previous: HashMap<String, Option<Instant>> = inner
            .devices
            .drain(..)
            .map(|entry| (entry.saved.id, entry.last_seen))
            .collect();
        inner.devices = settings
            .devices
            .iter()
            .map(|device| DeviceEntry {
                saved: device.clone(),
                last_seen: previous.get(&device.id).copied().flatten(),
            })
            .collect();
    }

    /// Reserves a pairing attempt before the expensive code check runs unlocked.
    fn begin_pair(&self, peer: IpAddr, now: Instant) -> Result<CodeVerifier, String> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.accepting {
            return Err("移动连接已停止。".into());
        }
        if inner.devices.len() >= MAX_DEVICES {
            return Err("已配对设备已达上限，请先在 Windows 端移除不用的设备。".into());
        }
        let code = inner.code.clone().ok_or("移动连接尚未设置密码。")?;
        prune(&mut inner.total_attempts, now);
        inner.attempts.retain(|_, attempts| {
            prune(attempts, now);
            !attempts.is_empty()
        });
        let peer_attempts = inner.attempts.get(&peer).map_or(0, VecDeque::len);
        if peer_attempts >= MAX_PEER_ATTEMPTS || inner.total_attempts.len() >= MAX_TOTAL_ATTEMPTS {
            return Err("密码尝试过多，请在一分钟后重试。".into());
        }
        inner.attempts.entry(peer).or_default().push_back(now);
        inner.total_attempts.push_back(now);
        Ok(code)
    }

    fn finish_pair(
        &self,
        peer: IpAddr,
        started: Instant,
        name: Option<&str>,
    ) -> Result<(String, Device), String> {
        let mut inner = self.inner.lock().unwrap();
        inner.attempts.remove(&peer);
        remove_attempt(&mut inner.total_attempts, started);
        if !inner.accepting {
            return Err("移动连接已停止。".into());
        }
        if inner.devices.len() >= MAX_DEVICES {
            return Err("已配对设备已达上限，请先在 Windows 端移除不用的设备。".into());
        }
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let device = Device {
            id: Uuid::new_v4().to_string(),
            name: device_name(name),
            token_digest: token_digest(&token),
            paired_at: unix_now(),
        };
        inner.devices.push(DeviceEntry {
            saved: device.clone(),
            last_seen: Some(Instant::now()),
        });
        Ok((token, device))
    }

    fn pair(
        &self,
        peer: IpAddr,
        secret: &str,
        name: Option<&str>,
        persist: impl FnOnce(&Device) -> Result<(), String>,
    ) -> Result<String, String> {
        let started = Instant::now();
        let code = self.begin_pair(peer, started)?;
        if !code.matches(secret) {
            return Err("密码不正确。".into());
        }
        let (token, device) = self.finish_pair(peer, started, name)?;
        if let Err(error) = persist(&device) {
            self.forget_device(&device.id);
            return Err(format!("保存配对失败：{error}"));
        }
        Ok(token)
    }

    /// Removes a device and returns the live sessions it created.
    fn forget_device(&self, id: &str) -> Vec<(String, ProjectKind)> {
        let mut inner = self.inner.lock().unwrap();
        inner.devices.retain(|entry| entry.saved.id != id);
        let owned: Vec<String> = inner
            .sessions
            .iter()
            .filter(|(_, session)| session.owner == id && session.ready)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        owned
            .into_iter()
            .filter_map(|session_id| {
                let session = inner.sessions.remove(&session_id)?;
                session
                    .exit
                    .is_none()
                    .then_some((session_id, session.project.kind))
            })
            .collect()
    }

    /// Returns the device id. A stopped endpoint answers 503 so phones keep their
    /// pairing; only an unknown token is reported as revoked (401).
    fn authenticate(&self, bearer: Option<&str>) -> Result<String, (StatusCode, String)> {
        let digest = bearer.map(token_digest);
        let mut inner = self.inner.lock().unwrap();
        if !inner.accepting {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Windows 端已停止移动连接。".into(),
            ));
        }
        if let Some(digest) = digest {
            let mut found = None;
            // Compare every digest so timing does not reveal the matching slot.
            for entry in &mut inner.devices {
                if bool::from(entry.saved.token_digest.ct_eq(&digest)) {
                    entry.last_seen = Some(Instant::now());
                    found = Some(entry.saved.id.clone());
                }
            }
            if let Some(id) = found {
                return Ok(id);
            }
        }
        Err((StatusCode::UNAUTHORIZED, "配对已失效，请重新配对。".into()))
    }

    fn session_kind(&self, id: &str) -> Result<ProjectKind, String> {
        let inner = self.inner.lock().unwrap();
        let session = inner.sessions.get(id).ok_or("终端不存在。")?;
        if !session.ready || session.exit.is_some() || !inner.accepting {
            return Err("终端已结束或正在启动。".into());
        }
        Ok(session.project.kind)
    }

    fn take_live_sessions(&self) -> Vec<(String, ProjectKind)> {
        let sessions = std::mem::take(&mut self.inner.lock().unwrap().sessions);
        sessions
            .into_iter()
            .filter(|(_, session)| session.ready && session.exit.is_none())
            .map(|(id, session)| (id, session.project.kind))
            .collect()
    }

    fn with_session(&self, id: &str, update: impl FnOnce(&mut Session)) {
        if let Some(session) = self.inner.lock().unwrap().sessions.get_mut(id) {
            update(session);
        }
    }

    #[cfg(test)]
    fn holds(&self, id: &str) -> bool {
        self.inner.lock().unwrap().sessions.contains_key(id)
    }
}

pub(crate) fn is_mobile_terminal(id: &str) -> bool {
    id.starts_with(TERMINAL_PREFIX)
}

/// Base64 PTY output for a `mobile-*` terminal.
pub(crate) fn deliver_data(app: &AppHandle, id: &str, data: String) {
    if let Some(state) = app.try_state::<MobileState>() {
        state
            .hub
            .with_session(id, |session| session.push(OutputChunk::Bytes(data)));
    }
}

/// Plain-text screen snapshot for a reattached `mobile-*` daemon terminal.
pub(crate) fn deliver_screen(app: &AppHandle, id: &str, data: String, cols: u16, rows: u16) {
    if let Some(state) = app.try_state::<MobileState>() {
        state.hub.with_session(id, |session| {
            session.push(OutputChunk::Screen { data, cols, rows })
        });
    }
}

pub(crate) fn deliver_exit(app: &AppHandle, id: &str, exit_code: u32, disconnected: bool) {
    if let Some(state) = app.try_state::<MobileState>() {
        state.hub.with_session(id, |session| {
            session.finish(Exit {
                exit_code,
                disconnected,
            })
        });
    }
}

fn lan_ipv4(ip: Ipv4Addr) -> bool {
    let [first, second, ..] = ip.octets();
    // 100.64.0.0/10 is shared address space used by Tailscale and carrier NAT.
    ip.is_private() || ip.is_link_local() || (first == 100 && second & 0xc0 == 64)
}

fn lan_peer(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => ip.is_loopback() || lan_ipv4(ip),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .is_some_and(|ip| ip.is_loopback() || lan_ipv4(ip)),
    }
}

/// Pairable IPv4 addresses of this computer, the default-route address first.
fn lan_addresses() -> Vec<Ipv4Addr> {
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

fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Windows".into())
}

fn status(state: &MobileState) -> Status {
    let port = state
        .running
        .lock()
        .unwrap()
        .as_ref()
        .map(|running| running.port);
    let error = state.last_error.lock().unwrap().clone();
    let now = Instant::now();
    let (saved_port, configured, enabled, fingerprint, mut devices) = {
        let inner = state.hub.inner.lock().unwrap();
        let devices: Vec<DeviceStatus> = inner
            .devices
            .iter()
            .map(|entry| DeviceStatus {
                id: entry.saved.id.clone(),
                name: entry.saved.name.clone(),
                paired_at: entry.saved.paired_at,
                online: port.is_some()
                    && entry
                        .last_seen
                        .is_some_and(|seen| now.duration_since(seen) < ONLINE_WINDOW),
            })
            .collect();
        (
            inner.saved_port.unwrap_or(DEFAULT_PORT),
            inner.configured,
            inner.enabled,
            inner.fingerprint.clone(),
            devices,
        )
    };
    devices.sort_by_key(|device| std::cmp::Reverse(device.paired_at));
    let addresses = if port.is_some() {
        lan_addresses().iter().map(ToString::to_string).collect()
    } else {
        Vec::new()
    };
    Status {
        port,
        saved_port,
        configured,
        enabled,
        fingerprint,
        devices,
        addresses,
        computer: computer_name(),
        error,
    }
}

/// Loads persisted pairings and restarts the listener if it was enabled.
pub fn initialize(app: &AppHandle) {
    let state = app.state::<MobileState>();
    let settings = match load_settings() {
        Ok(Some(settings)) => settings,
        Ok(None) => return,
        Err(error) => {
            *state.last_error.lock().unwrap() = Some(error);
            return;
        }
    };
    state.hub.load(&settings);
    if !settings.enabled {
        return;
    }
    let port = settings.endpoint.port();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<MobileState>();
        let _lifecycle = state.lifecycle.lock().await;
        if state.running.lock().unwrap().is_some() {
            return;
        }
        if let Err(error) = start_locked(&app, port, None).await {
            eprintln!("[WARN] mobile connection did not start: {error}");
            *state.last_error.lock().unwrap() = Some(format!("自动启用失败：{error}"));
        }
    });
}

#[derive(Serialize)]
pub struct SettingsSummary {
    port: u16,
    configured: bool,
    password: Option<String>,
}

/// Saved port and remembered password for the settings form; read once when it opens.
#[tauri::command]
pub fn mobile_saved_settings() -> Result<SettingsSummary, String> {
    let saved = load_settings()?;
    Ok(SettingsSummary {
        port: saved
            .as_ref()
            .map_or(DEFAULT_PORT, |settings| settings.endpoint.port()),
        configured: saved.is_some(),
        password: saved.and_then(|settings| settings.password),
    })
}

#[tauri::command]
pub fn mobile_status(state: State<'_, MobileState>) -> Status {
    status(&state)
}

#[tauri::command]
pub async fn mobile_start(
    port: u16,
    code: Option<String>,
    app: AppHandle,
) -> Result<Status, String> {
    let state = app.state::<MobileState>();
    let _lifecycle = state.lifecycle.lock().await;
    start_locked(&app, port, code).await?;
    Ok(status(&state))
}

fn tls_acceptor(settings: &SavedSettings) -> Result<TlsAcceptor, String> {
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

async fn start_locked(app: &AppHandle, port: u16, code: Option<String>) -> Result<(), String> {
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

/// Stops listening and ends phone terminals. `disable` keeps it off on next launch;
/// closing the app passes `false` so the listener returns with the desktop.
#[tauri::command]
pub async fn mobile_stop(disable: Option<bool>, app: AppHandle) -> Result<Status, String> {
    let state = app.state::<MobileState>();
    let _lifecycle = state.lifecycle.lock().await;
    let disable = disable.unwrap_or(true);
    if disable {
        update_settings(|settings| settings.enabled = false)?;
        state.hub.inner.lock().unwrap().enabled = false;
    }
    let running = state.running.lock().unwrap().take();
    state.hub.inner.lock().unwrap().accepting = false;
    if let Some(running) = running {
        running.shutdown().await;
    }
    for (id, kind) in state.hub.take_live_sessions() {
        let _ = end(&app, id, kind).await;
    }
    Ok(status(&state))
}

#[tauri::command]
pub async fn mobile_revoke_device(id: String, app: AppHandle) -> Result<Status, String> {
    let state = app.state::<MobileState>();
    let _lifecycle = state.lifecycle.lock().await;
    update_settings(|settings| settings.devices.retain(|device| device.id != id))?;
    for (session, kind) in state.hub.forget_device(&id) {
        let _ = end(&app, session, kind).await;
    }
    Ok(status(&state))
}

#[tauri::command]
pub fn mobile_pairing_qr(text: String) -> Result<QrMatrix, String> {
    if text.len() > 512 || !text.starts_with("qingcode://pair?") {
        return Err("配对链接无效。".into());
    }
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M)
        .map_err(|error| error.to_string())?;
    let modules = code
        .to_colors()
        .into_iter()
        .map(|color| {
            if color == qrcode::Color::Dark {
                '1'
            } else {
                '0'
            }
        })
        .collect();
    Ok(QrMatrix {
        size: code.width(),
        modules,
    })
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
    desktop_request(app, project, None).await
}

async fn desktop_request(
    app: &AppHandle,
    project: Option<&str>,
    attachment: Option<&str>,
) -> Result<Value, String> {
    let state = app.state::<MobileState>();
    let id = Uuid::new_v4();
    let (sender, receiver) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, sender);
    let timeout = if project.is_some() {
        CREATE_TIMEOUT
    } else {
        PROJECTS_TIMEOUT
    };
    let result = match app.emit_to(
        "main",
        "mobile-request",
        json!({ "id": id, "project": project, "attachment": attachment }),
    ) {
        Ok(()) => match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            _ if project.is_some() => Err(
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

async fn serve(
    app: AppHandle,
    listener: TcpListener,
    acceptor: TlsAcceptor,
    mut stop: watch::Receiver<bool>,
) {
    let capacity = Arc::new(Semaphore::new(16));
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

async fn request_handler(
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

async fn read_operation<B>(
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

async fn operate(app: &AppHandle, device: &str, operation: Operation) -> Result<Value, String> {
    let hub = &app.state::<MobileState>().inner().hub;
    match operation {
        Operation::Pair { .. } => unreachable!(),
        // Authentication is checked by request_handler before any operation runs.
        // Never wait for terminal output or the desktop WebView bridge here.
        Operation::Ping => Ok(json!({ "pong": true })),
        Operation::Projects => desktop(app, None).await,
        Operation::Sessions { project } => {
            let inner = hub.inner.lock().unwrap();
            let mut sessions: Vec<_> = inner
                .sessions
                .iter()
                .filter(|(_, session)| session.ready && session.project.id == project)
                .collect();
            sessions.sort_by_key(|(_, session)| session.number);
            Ok(json!(sessions
                .into_iter()
                .map(|(id, session)| session.metadata(id))
                .collect::<Vec<_>>()))
        }
        Operation::Create {
            project,
            cols,
            rows,
        } => create(app, device, &project, cols, rows).await,
        Operation::History { id, before } => {
            let inner = hub.inner.lock().unwrap();
            let session = inner.sessions.get(&id).ok_or("终端不存在。")?;
            Ok(session.screen.history(before))
        }
        Operation::Poll {
            id,
            from,
            latest,
            tail,
        } => {
            let wait = {
                let inner = hub.inner.lock().unwrap();
                let session = inner.sessions.get(&id).ok_or("终端不存在。")?;
                let base = session.next - session.output.len() as u64;
                if latest || (tail && (from < base || from > session.next)) {
                    return Ok(session.latest());
                }
                if from != session.next
                    || session
                        .drain_until
                        .is_some_and(|until| Instant::now() >= until)
                {
                    return Ok(session.read(from));
                }
                session.changed.clone().notified_owned()
            };
            if tokio::time::timeout(Duration::from_millis(900), wait)
                .await
                .is_ok()
            {
                tokio::time::sleep(OUTPUT_COALESCE).await;
            }
            let inner = hub.inner.lock().unwrap();
            let session = inner.sessions.get(&id).ok_or("终端不存在。")?;
            let base = session.next - session.output.len() as u64;
            Ok(if tail && from < base {
                session.latest()
            } else {
                session.read(from)
            })
        }
        Operation::Input { id, data } => {
            if data.len() > MAX_INPUT {
                return Err("单次终端输入超过 16 KiB。".into());
            }
            if hub.session_kind(&id)? == ProjectKind::Ssh {
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
        Operation::Image { id, data } => {
            let project = {
                let inner = hub.inner.lock().unwrap();
                image_project(&inner, &id, device)?
            };
            // Re-read saved trust and connection state before materializing an attachment.
            let current: Project = serde_json::from_value(desktop(app, Some(&project.id)).await?)
                .map_err(|error| error.to_string())?;
            if current.path != project.path || current.kind != project.kind {
                return Err("项目位置已变化，请重新打开终端后发送图片。".into());
            }
            let bytes = decode_image(&data)?;
            let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "png"
            } else {
                "jpg"
            };
            let storage_project = project.clone();
            let storage_app = app.clone();
            let path = tauri::async_runtime::spawn_blocking(move || {
                let name = format!("mobile-image.{extension}");
                if storage_project.kind == ProjectKind::Ssh {
                    // Only the SSH transfer needs a temporary local source.
                    crate::clipboard_files::store_attachment(&name, &bytes)
                } else {
                    crate::clipboard_files::store_project_attachment(
                        &crate::run_environment::to_host_path(&storage_project.path),
                        &name,
                        &bytes,
                        &storage_app.state::<crate::PathAllowlist>(),
                    )
                }
            })
            .await
            .map_err(|error| error.to_string())??;
            let result = if project.kind == ProjectKind::Ssh {
                desktop_request(app, Some(&project.id), Some(&path)).await
            } else {
                local_image_path(&project, &path).map(|path| json!({ "path": path }))
            };
            // SSH has its own uploaded copy. Failed local/WSL preparations do not retain a file.
            if project.kind == ProjectKind::Ssh || result.is_err() {
                let _ = std::fs::remove_file(&path);
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    let _ = std::fs::remove_dir(parent);
                }
            }
            result
        }
        Operation::Resize { id, cols, rows } => {
            let (cols, rows) = size(cols, rows);
            if hub.session_kind(&id)? == ProjectKind::Ssh {
                crate::remote_ssh::ssh_resize_terminal(id.clone(), cols, rows, app.state()).await?;
            } else {
                app.state::<crate::TerminalManager>()
                    .resize(&id, cols, rows)?;
            }
            hub.with_session(&id, |session| session.screen.resize(cols, rows));
            Ok(Value::Null)
        }
        Operation::RenameSession { id, name } => {
            let mut inner = hub.inner.lock().unwrap();
            let session = inner.sessions.get_mut(&id).ok_or("终端不存在。")?;
            if !session.ready {
                return Err("终端正在启动或关闭。".into());
            }
            session.rename(&name)?;
            Ok(session.metadata(&id))
        }
        Operation::End { id } => {
            let kind = {
                let mut inner = hub.inner.lock().unwrap();
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
            let mut inner = hub.inner.lock().unwrap();
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

fn image_project(inner: &HubState, id: &str, device: &str) -> Result<Project, String> {
    let session = inner.sessions.get(id).ok_or("终端不存在。")?;
    if !inner.accepting || !session.ready || session.exit.is_some() || session.owner != device {
        return Err("当前设备没有可用的终端会话。".into());
    }
    Ok(session.project.clone())
}

fn decode_image(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if data.len() > MAX_IMAGE.div_ceil(3) * 4 {
        return Err("图片不能超过 8 MB。".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "图片编码无效。")?;
    if bytes.len() > MAX_IMAGE {
        return Err("图片不能超过 8 MB。".into());
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") && !bytes.starts_with(b"\xff\xd8\xff") {
        return Err("仅支持 PNG / JPEG 图片；其他格式请选择压缩后发送。".into());
    }
    Ok(bytes)
}

fn local_image_path(project: &Project, path: &str) -> Result<String, String> {
    if project.kind == ProjectKind::Wsl {
        let wsl =
            crate::run_environment::parse_wsl_path(&project.path).ok_or("无法识别 WSL 发行版。")?;
        let root = crate::run_environment::to_host_path(&project.path);
        let relative = std::path::Path::new(path)
            .strip_prefix(&root)
            .map_err(|_| "附件不在当前 WSL 项目内。")?;
        if relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("附件不在当前 WSL 项目内。".into());
        }
        let path = format!(
            "{}/{}",
            wsl.path.trim_end_matches('/'),
            relative.to_string_lossy().replace('\\', "/")
        );
        return Ok(format!("'{}'", path.replace('\'', "'\\''")));
    }
    #[cfg(windows)]
    return Ok(format!("'{}'", path.replace('\'', "''")));
    #[cfg(not(windows))]
    Ok(format!("'{}'", path.replace('\'', "'\\''")))
}

fn size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(2, 300), rows.clamp(2, 150))
}

async fn create(
    app: &AppHandle,
    device: &str,
    project_id: &str,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let project: Project = serde_json::from_value(desktop(app, Some(project_id)).await?)
        .map_err(|error| error.to_string())?;
    let id = format!("{TERMINAL_PREFIX}{}", Uuid::new_v4().simple());
    {
        let mut inner = hub.inner.lock().unwrap();
        if !inner.accepting {
            return Err("移动连接已停止。".into());
        }
        if inner.sessions.len() >= MAX_SESSIONS {
            return Err("终端数量已达上限，请结束闲置会话。".into());
        }
        inner.next_number += 1;
        let number = inner.next_number;
        inner.sessions.insert(
            id.clone(),
            Session::new(project.clone(), device.to_string(), number),
        );
    }
    let (cols, rows) = size(cols, rows);
    hub.with_session(&id, |session| session.screen.resize(cols, rows));
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
        let mut inner = hub.inner.lock().unwrap();
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
        return Err("移动连接已停止或设备已移除。".into());
    }
    let inner = hub.inner.lock().unwrap();
    let session = inner.sessions.get(&id).ok_or("终端不存在。")?;
    Ok(session.metadata(&id))
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

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "a1B@3!";
    const PEER: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));

    fn settings(devices: Vec<Device>) -> SavedSettings {
        SavedSettings {
            endpoint: SavedEndpoint::Port { port: 49123 },
            certificate: vec![1, 2, 3],
            private_key: vec![],
            code: CodeVerifier::new(CODE).unwrap(),
            password: Some(CODE.into()),
            enabled: true,
            devices,
        }
    }

    fn accepting_hub(devices: Vec<Device>) -> Hub {
        let hub = Hub::default();
        hub.load(&settings(devices));
        hub.inner.lock().unwrap().accepting = true;
        hub
    }

    fn project() -> Project {
        Project {
            id: "p".into(),
            name: "p".into(),
            path: "C:\\p".into(),
            kind: ProjectKind::Local,
            host: "Windows".into(),
        }
    }

    #[cfg(windows)]
    #[test]
    fn local_image_path_uses_wsl_repository_instead_of_windows_cache() {
        let mut project = project();
        project.kind = ProjectKind::Wsl;
        project.path = "wsl://Ubuntu/home/owner/app's workspace".into();
        let root = crate::run_environment::to_host_path(&project.path);
        let path =
            std::path::Path::new(&root).join(".qingcode/terminal-paste/batch/mobile-image.jpg");
        assert_eq!(
            local_image_path(&project, &path.to_string_lossy()).unwrap(),
            "'/home/owner/app'\\''s workspace/.qingcode/terminal-paste/batch/mobile-image.jpg'"
        );
        assert!(local_image_path(
            &project,
            r"C:\Users\owner\AppData\Local\Temp\mobile-image.jpg"
        )
        .is_err());
        let escape = std::path::Path::new(&root).join("../outside.jpg");
        assert!(local_image_path(&project, &escape.to_string_lossy()).is_err());
    }

    #[test]
    fn image_upload_requires_a_live_session_owned_by_the_device() {
        let mut inner = HubState {
            accepting: true,
            ..HubState::default()
        };
        let mut session = Session::new(project(), "phone".into(), 1);
        session.ready = true;
        inner.sessions.insert("mobile-test".into(), session);
        assert!(image_project(&inner, "mobile-test", "phone").is_ok());
        assert!(image_project(&inner, "mobile-test", "other-phone").is_err());
        assert!(image_project(&inner, "missing", "phone").is_err());
        inner.sessions.get_mut("mobile-test").unwrap().ready = false;
        assert!(image_project(&inner, "mobile-test", "phone").is_err());
        inner.sessions.get_mut("mobile-test").unwrap().ready = true;
        inner.accepting = false;
        assert!(image_project(&inner, "mobile-test", "phone").is_err());
    }

    #[test]
    fn image_upload_rejects_invalid_encoding_formats_and_oversized_payloads() {
        use base64::Engine;
        let encode = |bytes| base64::engine::general_purpose::STANDARD.encode(bytes);
        for bytes in [b"\x89PNG\r\n\x1a\n".as_slice(), b"\xff\xd8\xff"] {
            assert_eq!(decode_image(&encode(bytes)).unwrap(), bytes);
        }
        assert!(decode_image("not base64!").is_err());
        assert!(decode_image(&encode(b"<script>code</script>")).is_err());
        assert!(decode_image(&"A".repeat(MAX_IMAGE.div_ceil(3) * 4 + 1)).is_err());
    }

    #[tokio::test]
    async fn image_request_accepts_eight_mb_after_base64_and_json_framing() {
        let mut image = vec![0; MAX_IMAGE];
        image[..3].copy_from_slice(b"\xff\xd8\xff");
        let data = base64::engine::general_purpose::STANDARD.encode(&image);
        let request = json!({ "op": "image", "id": "mobile-test", "data": data }).to_string();
        assert!(request.len() > 128 * 1024);
        let operation = read_operation(
            Full::new(Bytes::from(request)),
            12 * 1024 * 1024,
            Duration::from_secs(60),
        )
        .await
        .unwrap_or_else(|error| panic!("image request rejected: {error:?}"));
        match operation {
            Operation::Image { id, data } => {
                assert_eq!(id, "mobile-test");
                assert_eq!(decode_image(&data).unwrap(), image);
            }
            _ => panic!("expected image upload"),
        }
    }

    #[tokio::test]
    async fn image_request_distinguishes_size_limit_from_invalid_json() {
        let request = json!({ "op": "image", "id": "mobile-test", "data": "A".repeat(128 * 1024) });
        let result = read_operation(
            Full::new(Bytes::from(request.to_string())),
            128 * 1024,
            Duration::from_secs(15),
        )
        .await;
        assert!(matches!(result, Err((StatusCode::PAYLOAD_TOO_LARGE, _))));
        let result = read_operation(
            Full::new(Bytes::from_static(b"{broken")),
            128 * 1024,
            Duration::from_secs(15),
        )
        .await;
        assert!(matches!(result, Err((StatusCode::BAD_REQUEST, _))));
    }

    #[tokio::test]
    async fn image_request_reports_timeout_and_interrupted_body_separately() {
        let pending =
            futures_util::stream::pending::<Result<hyper::body::Frame<Bytes>, std::io::Error>>();
        let result = read_operation(
            http_body_util::StreamBody::new(pending),
            1024,
            Duration::from_millis(5),
        )
        .await;
        assert!(matches!(result, Err((StatusCode::REQUEST_TIMEOUT, _))));
        let interrupted = futures_util::stream::once(async {
            Err::<hyper::body::Frame<Bytes>, _>(std::io::Error::other("disconnected"))
        });
        let result = read_operation(
            http_body_util::StreamBody::new(interrupted),
            1024,
            Duration::from_secs(1),
        )
        .await;
        assert!(
            matches!(result, Err((StatusCode::BAD_REQUEST, message)) if message.contains("传输中断"))
        );
    }

    #[test]
    fn password_accepts_six_to_twenty_graphic_characters_without_complexity_rules() {
        for invalid in [
            "",
            "12345",
            "123456789012345678901",
            "abc 12",
            "a1中BC",
            "abcdef\n",
        ] {
            assert!(!valid_code(invalid));
        }
        for valid in ["123456", "abcdef", "!!!!!!", CODE, "12345678901234567890"] {
            assert!(valid_code(valid));
        }
    }

    #[test]
    fn legacy_settings_migrate_without_pairings_or_a_remembered_password() {
        let legacy = json!({
            "address": "127.0.0.1:49123",
            "certificate": [],
            "private_key": [],
            "code": CodeVerifier::new(CODE).unwrap(),
        });
        let mut restored: SavedSettings = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.endpoint.port(), 49123);
        assert!(!restored.enabled);
        assert!(restored.devices.is_empty());
        // Verifier-only files stay valid; the password is remembered once set again.
        assert!(restored.password.is_none());
        assert!(!serde_json::to_string(&restored).unwrap().contains(CODE));
        restored.password = Some(CODE.into());
        let remembered: SavedSettings =
            serde_json::from_str(&serde_json::to_string(&restored).unwrap()).unwrap();
        assert!(remembered
            .code
            .matches(remembered.password.as_deref().unwrap()));
        restored.password = None;
        restored.endpoint = SavedEndpoint::Port { port: 49124 };
        let migrated = serde_json::to_value(&restored).unwrap();
        assert_eq!(migrated["port"], 49124);
        assert!(migrated.get("address").is_none());
        assert!(!migrated.to_string().contains(CODE));
    }

    #[test]
    fn pairings_persist_as_digests_and_survive_reload() {
        let hub = accepting_hub(Vec::new());
        let mut saved = Vec::new();
        let token = hub
            .pair(PEER, CODE, Some(" Pixel\u{7} 8 "), |device| {
                saved.push(device.clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(saved[0].name, "Pixel 8");
        let file = serde_json::to_string(&settings(saved.clone())).unwrap();
        assert!(!file.contains(&token));

        let restarted = Hub::default();
        restarted.load(&serde_json::from_str(&file).unwrap());
        restarted.inner.lock().unwrap().accepting = true;
        assert_eq!(restarted.authenticate(Some(&token)).unwrap(), saved[0].id);
        assert_eq!(
            restarted.authenticate(Some("other")).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
        // Stopping the listener must not look like a revoked pairing to the phone.
        restarted.inner.lock().unwrap().accepting = false;
        assert_eq!(
            restarted.authenticate(Some(&token)).unwrap_err().0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn several_devices_pair_until_the_limit_and_revocation_ends_their_sessions() {
        let hub = accepting_hub(Vec::new());
        let mut tokens = Vec::new();
        for _ in 0..MAX_DEVICES {
            tokens.push(hub.pair(PEER, CODE, None, |_| Ok(())).unwrap());
        }
        assert!(hub
            .pair(PEER, CODE, None, |_| Ok(()))
            .unwrap_err()
            .contains("上限"));
        let first = hub.authenticate(Some(&tokens[0])).unwrap();
        let second = hub.authenticate(Some(&tokens[1])).unwrap();
        {
            let mut inner = hub.inner.lock().unwrap();
            for (id, owner) in [("mobile-a", &first), ("mobile-b", &second)] {
                let mut session = Session::new(project(), owner.clone(), 1);
                session.ready = true;
                inner.sessions.insert(id.into(), session);
            }
        }
        let ended = hub.forget_device(&first);
        assert_eq!(ended, vec![("mobile-a".to_string(), ProjectKind::Local)]);
        assert!(hub.authenticate(Some(&tokens[0])).is_err());
        assert!(hub.holds("mobile-b"));
    }

    #[test]
    fn failed_persistence_rolls_back_the_pairing() {
        let hub = accepting_hub(Vec::new());
        let error = hub
            .pair(PEER, CODE, None, |_| Err("disk".into()))
            .unwrap_err();
        assert!(error.contains("disk"));
        assert!(hub.inner.lock().unwrap().devices.is_empty());
    }

    #[test]
    fn pairing_attempts_are_limited_per_source_and_in_total() {
        let hub = accepting_hub(Vec::new());
        for _ in 0..MAX_PEER_ATTEMPTS {
            assert_eq!(
                hub.pair(PEER, "wrong", None, |_| Ok(())).unwrap_err(),
                "密码不正确。"
            );
        }
        assert!(hub
            .pair(PEER, CODE, None, |_| Ok(()))
            .unwrap_err()
            .contains("尝试过多"));
        // Another phone is not locked out by the first source.
        let other = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 21));
        assert!(hub.pair(other, CODE, None, |_| Ok(())).is_ok());

        let aged = Instant::now() - ATTEMPT_WINDOW;
        {
            let mut inner = hub.inner.lock().unwrap();
            inner
                .attempts
                .insert(PEER, VecDeque::from([aged; MAX_PEER_ATTEMPTS]));
            inner.total_attempts = VecDeque::from([Instant::now(); MAX_TOTAL_ATTEMPTS]);
        }
        let third = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 22));
        assert!(hub
            .pair(third, CODE, None, |_| Ok(()))
            .unwrap_err()
            .contains("尝试过多"));
        hub.inner.lock().unwrap().total_attempts.clear();
        assert!(hub.pair(PEER, CODE, None, |_| Ok(())).is_ok());
    }

    #[test]
    fn latest_attach_skips_replay_and_subsequent_poll_only_returns_new_output() {
        let mut session = Session::new(project(), "phone".into(), 1);
        session.screen.resize(40, 4);
        for index in 0..1000 {
            session.push(OutputChunk::Bytes(
                base64::engine::general_purpose::STANDARD.encode(format!("record {index}\r\n")),
            ));
        }
        let attach = session.latest();
        assert_eq!(attach["chunks"].as_array().unwrap().len(), 1);
        assert_eq!(attach["next"], 1000);
        assert_eq!(attach["more"], false);
        assert_eq!(attach["snapshot"], true);
        assert_eq!(attach["historyAvailable"], true);
        let screen = attach["chunks"][0]["data"].as_str().unwrap();
        assert!(screen.contains("record 999"));
        assert!(!screen.contains("record 0"));
        assert!(screen.len() < 1024);
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(b"live prompt"),
        ));
        let follow = session.read(1000);
        assert_eq!(follow["chunks"].as_array().unwrap().len(), 1);
        assert_eq!(follow["next"], 1001);
        assert_eq!(follow["reset"], false);
    }

    #[test]
    fn older_phone_poll_requests_keep_the_replay_contract() {
        let operation: Operation =
            serde_json::from_value(json!({"op":"poll", "id":"mobile-1", "from":0})).unwrap();
        assert!(matches!(
            operation,
            Operation::Poll {
                latest: false,
                tail: false,
                ..
            }
        ));
        let mut session = Session::new(project(), "phone".into(), 1);
        session.push(OutputChunk::Bytes("aGk=".into()));
        assert_eq!(session.read(0)["chunks"], json!(["aGk="]));
    }

    #[test]
    fn session_names_follow_program_titles_and_manual_names_survive_reconnect() {
        let mut session = Session::new(project(), "phone".into(), 7);
        assert_eq!(session.name(), "终端 7");
        let push_title = |session: &mut Session, title: &str| {
            session.push(OutputChunk::Bytes(
                base64::engine::general_purpose::STANDARD.encode(format!("\x1b]2;{title}\x07")),
            ));
        };
        push_title(&mut session, "OpenCode");
        assert_eq!(session.name(), "OpenCode");
        session.rename("  修复登录  ").unwrap();
        let revision = session.name_revision;
        push_title(&mut session, "Claude");
        assert_eq!(session.name(), "修复登录");
        assert!(session.name_revision > revision);
        assert_eq!(session.latest()["name"], "修复登录");
        assert_eq!(session.read(session.next)["customName"], "修复登录");
        assert_eq!(session.metadata("mobile-7")["name"], "修复登录");
        session.rename("").unwrap();
        assert_eq!(session.name(), "Claude");
        assert!(session.rename(&"中".repeat(81)).is_err());
        assert!(session.rename("bad\nname").is_err());
        assert_eq!(session.name(), "Claude");
    }

    #[test]
    fn poll_reads_are_bounded_and_resume_by_sequence() {
        let mut session = Session::new(project(), "d".into(), 1);
        let chunk = "A".repeat(64 * 1024);
        for _ in 0..5 {
            session.push(OutputChunk::Bytes(chunk.clone()));
        }
        let first = session.read(0);
        assert_eq!(first["chunks"].as_array().unwrap().len(), 3);
        assert_eq!(first["next"], 3);
        assert_eq!(first["more"], true);
        let rest = session.read(3);
        assert_eq!(rest["chunks"].as_array().unwrap().len(), 2);
        assert_eq!(rest["more"], false);
        assert_eq!(rest["reset"], false);

        // A single chunk larger than the budget is still delivered.
        session.push(OutputChunk::Bytes("B".repeat(MAX_POLL_BYTES * 2)));
        assert_eq!(session.read(5)["chunks"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn evicted_or_future_sequences_reset_and_screens_replace_history() {
        let mut session = Session::new(project(), "d".into(), 1);
        for _ in 0..20 {
            session.push(OutputChunk::Bytes("x".repeat(64 * 1024)));
        }
        assert!(session.output_size <= MAX_OUTPUT);
        assert_eq!(session.read(0)["reset"], true);
        assert_eq!(session.read(99)["reset"], true);

        session.push(OutputChunk::Screen {
            data: "\u{1b}[2Jprompt$ ".into(),
            cols: 80,
            rows: 24,
        });
        let read = session.read(20);
        let chunks = read["chunks"].as_array().unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0]["data"], "\u{1b}[2Jprompt$ ");
        assert_eq!(chunks[0]["cols"], 80);
        assert_eq!(read["reset"], false);
    }

    #[test]
    fn exit_is_reported_after_the_output_drain_window() {
        let mut session = Session::new(project(), "d".into(), 1);
        session.finish(Exit {
            exit_code: 3,
            disconnected: false,
        });
        assert!(session.read(0)["exit"].is_null());
        session.drain_until = Some(Instant::now() - Duration::from_millis(1));
        assert_eq!(session.read(0)["exit"]["exitCode"], 3);
    }

    #[test]
    fn automatic_listener_accepts_lan_sources() {
        for allowed in [
            "127.0.0.1",
            "192.168.1.2",
            "172.18.0.2",
            "10.0.0.2",
            "169.254.2.3",
            "100.64.0.1",
            "100.127.255.254",
            "::ffff:192.168.1.2",
        ] {
            assert!(lan_peer(allowed.parse().unwrap()), "{allowed}");
        }
        for denied in [
            "0.0.0.0",
            "8.8.8.8",
            "172.32.0.2",
            "100.128.0.1",
            "100.63.255.255",
            "2001:db8::1",
        ] {
            assert!(!lan_peer(denied.parse().unwrap()), "{denied}");
        }
    }

    #[test]
    fn pairing_qr_encodes_only_pairing_links() {
        let qr = mobile_pairing_qr("qingcode://pair?v=1&host=192.168.1.2&port=48764&fp=00".into())
            .unwrap();
        assert_eq!(qr.modules.len(), qr.size * qr.size);
        assert!(qr.modules.contains('1'));
        assert!(mobile_pairing_qr("https://example.com".into()).is_err());
    }

    #[test]
    fn device_names_are_trimmed_and_defaulted() {
        assert_eq!(device_name(None), "Android 设备");
        assert_eq!(device_name(Some("  ")), "Android 设备");
        assert_eq!(device_name(Some(&"x".repeat(80))).len(), MAX_DEVICE_NAME);
    }
}
