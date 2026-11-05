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
/// 手机终端 24 小时内既无输入也无输出时自动结束，与对话的 Agent 进程一致。
const TERMINAL_IDLE: Duration = crate::agent::IDLE_SHUTDOWN;
const IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);
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
    /// 聊天式 Agent 对话（Claude / Codex / OpenCode）。
    agents: crate::agent::AgentHost,
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

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as u64)
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
    /// 带启动命令的终端配置名；程序未设置标题时代替「终端 N」。
    label: Option<String>,
    name_revision: u64,
    ready: bool,
    exit: Option<Exit>,
    drain_until: Option<Instant>,
    output: VecDeque<OutputChunk>,
    output_size: usize,
    next: u64,
    changed: Arc<Notify>,
    screen: MobileScreen,
    /// 最近一次输入或输出；轮询不算活动。
    last_active: Instant,
    last_active_ms: u64,
}

impl Session {
    fn new(project: Project, owner: String, number: u64) -> Self {
        Self {
            project,
            owner,
            number,
            custom_name: None,
            label: None,
            name_revision: 0,
            ready: false,
            exit: None,
            drain_until: None,
            output: VecDeque::new(),
            output_size: 0,
            next: 0,
            changed: Arc::new(Notify::new()),
            screen: MobileScreen::new(),
            last_active: Instant::now(),
            last_active_ms: unix_now_ms(),
        }
    }

    fn touch(&mut self) {
        self.last_active = Instant::now();
        self.last_active_ms = unix_now_ms();
    }

    fn push(&mut self, chunk: OutputChunk) {
        self.touch();
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
            .or(self.label.as_deref())
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
            "programTitle": self.screen.title(),
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision,
            "lastActiveAt": self.last_active_ms,
            "idleDeadline": self.exit.is_none().then(|| self.last_active_ms + TERMINAL_IDLE.as_millis() as u64) })
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
            "programTitle": self.screen.title(),
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
            "programTitle": self.screen.title(),
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
    Capabilities,
    Projects,
    Sessions {
        project: String,
    },
    /// 电脑端「终端配置」列表（只含 id / 名称 / 是否已信任，不含命令）。
    TerminalProfiles,
    Create {
        project: String,
        cols: u16,
        rows: u16,
        /// 电脑端终端配置 id；旧版手机不传，按普通终端启动。
        #[serde(default)]
        terminal_profile: Option<String>,
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
    AgentCatalog,
    AgentDefaults {
        provider: crate::agent::Provider,
        #[serde(default)]
        safety: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
    AgentThreads {
        #[serde(default)]
        project: Option<String>,
    },
    AgentCreate {
        project: String,
        provider: crate::agent::Provider,
        #[serde(default)]
        safety: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
    AgentSend {
        id: String,
        #[serde(default)]
        text: String,
        #[serde(default)]
        images: Vec<String>,
    },
    AgentImage {
        data: String,
    },
    AgentPoll {
        id: String,
        from: u64,
    },
    AgentHistory {
        id: String,
        before: String,
    },
    AgentRespond {
        id: String,
        approval: String,
        choice: String,
        #[serde(default)]
        answers: Value,
    },
    AgentInterrupt {
        id: String,
    },
    AgentConfigure {
        id: String,
        key: String,
        value: String,
    },
    AgentRename {
        id: String,
        title: String,
    },
    AgentClose {
        id: String,
    },
    AgentDelete {
        id: String,
    },
    AgentUsage {
        #[serde(default)]
        refresh: bool,
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
            // Invalidate reservations too; late spawns must close their PTY.
            .filter(|(_, session)| session.owner == id)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        owned
            .into_iter()
            .filter_map(|session_id| {
                let session = inner.sessions.remove(&session_id)?;
                (session.ready && session.exit.is_none())
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

    /// 取出空闲超过 `limit` 的在线会话（标记为关闭中，由调用方结束），并直接移除早已结束的记录。
    fn take_idle_sessions(&self, limit: Duration) -> Vec<(String, ProjectKind)> {
        let mut inner = self.inner.lock().unwrap();
        inner.sessions.retain(|_, session| {
            !(session.ready && session.exit.is_some() && session.last_active.elapsed() >= limit)
        });
        inner
            .sessions
            .iter_mut()
            .filter(|(_, session)| {
                session.ready && session.exit.is_none() && session.last_active.elapsed() >= limit
            })
            .map(|(id, session)| {
                session.ready = false;
                (id.clone(), session.project.kind)
            })
            .collect()
    }

    fn reserve_session(
        &self,
        id: String,
        project: Project,
        device: &str,
        label: Option<String>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        require_device(&inner, device)?;
        if inner.sessions.len() >= MAX_SESSIONS {
            return Err("终端数量已达上限，请结束闲置会话。".into());
        }
        inner.next_number += 1;
        let mut session = Session::new(project, device.to_string(), inner.next_number);
        session.label = label;
        inner.sessions.insert(id, session);
        Ok(())
    }

    /// A false result makes the caller close a successfully spawned PTY whose
    /// reservation was cancelled during a native/remote launch.
    fn finish_create(&self, id: &str, succeeded: bool) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let authorized = inner
            .sessions
            .get(id)
            .is_some_and(|session| require_device(&inner, &session.owner).is_ok());
        if !succeeded || !authorized {
            inner.sessions.remove(id);
            return false;
        }
        inner.sessions.get_mut(id).unwrap().ready = true;
        true
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
    if id.starts_with(crate::agent::TERMINAL_PREFIX) {
        if let (Some(state), Ok(bytes)) = (
            app.try_state::<MobileState>(),
            base64::engine::general_purpose::STANDARD.decode(&data),
        ) {
            state.agents.remote_data(id, &bytes);
        }
        return;
    }
    if let Some(state) = app.try_state::<MobileState>() {
        state
            .hub
            .with_session(id, |session| session.push(OutputChunk::Bytes(data)));
    }
}

/// Plain-text screen snapshot for a reattached `mobile-*` daemon terminal.
pub(crate) fn deliver_screen(app: &AppHandle, id: &str, data: String, cols: u16, rows: u16) {
    if id.starts_with(crate::agent::TERMINAL_PREFIX) {
        // Agent 的 JSON 流不能从屏幕快照恢复，只能提示中间输出缺失。
        if let Some(state) = app.try_state::<MobileState>() {
            state.agents.remote_gap(id);
        }
        return;
    }
    if let Some(state) = app.try_state::<MobileState>() {
        state.hub.with_session(id, |session| {
            session.push(OutputChunk::Screen { data, cols, rows })
        });
    }
}

pub(crate) fn deliver_exit(app: &AppHandle, id: &str, exit_code: u32, disconnected: bool) {
    if id.starts_with(crate::agent::TERMINAL_PREFIX) {
        if let Some(state) = app.try_state::<MobileState>() {
            let reason = if disconnected {
                "远端连接已断开".to_string()
            } else {
                format!("退出码 {exit_code}")
            };
            state.agents.remote_exit(id, Some(reason));
        }
        return;
    }
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

/// SSH 远端（直连与 Server 模式）的 Agent 启动器：复用远端终端通道。
struct RemoteAgents {
    app: AppHandle,
}

/// 登录 Shell 加载 profile 可能较慢（nvm 等）。
const REMOTE_READY_TIMEOUT: Duration = Duration::from_secs(60);

/// 远端终端单次写入上限为 1 MB，图片等长行分块发送。
const REMOTE_WRITE_CHUNK: usize = 256 * 1024;

fn remote_chunks(data: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut rest = data;
    while rest.len() > REMOTE_WRITE_CHUNK {
        let mut end = REMOTE_WRITE_CHUNK;
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&rest[..end]);
        rest = &rest[end..];
    }
    if !rest.is_empty() {
        chunks.push(rest);
    }
    chunks
}

async fn write_remote(app: &AppHandle, terminal: &str, data: &str) -> Result<(), String> {
    for chunk in remote_chunks(data) {
        let mut attempts = 0;
        loop {
            match crate::remote_ssh::ssh_write_terminal(
                terminal.to_string(),
                chunk.to_string(),
                app.state(),
            )
            .await
            {
                Ok(()) => break,
                // 直连通道缓冲满时稍后重试，保持行内顺序。
                Err(error) if error.contains("缓冲区已满") && attempts < 400 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

impl crate::agent::RemoteLauncher for RemoteAgents {
    fn launch(
        &self,
        terminal: String,
        project: crate::agent::AgentProject,
        script: String,
        mut commands: tokio::sync::mpsc::UnboundedReceiver<crate::agent::RemoteCommand>,
        ready: tokio::sync::oneshot::Receiver<()>,
    ) {
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let agents = app.state::<MobileState>().agents.clone();
            let started = crate::remote_ssh::ssh_spawn_agent(
                terminal.clone(),
                project.path,
                script,
                app.clone(),
            )
            .await;
            if let Err(error) = started {
                agents.remote_exit(&terminal, Some(error));
                return;
            }
            // 等远端关闭回显后再写入，否则握手消息可能被回显成“Agent 输出”。
            let failure = match tokio::time::timeout(REMOTE_READY_TIMEOUT, ready).await {
                Ok(Ok(())) => None,
                Ok(Err(_)) => Some(None),
                Err(_) => Some(Some(
                    "远端 Agent 未就绪，请确认远端为 Linux / macOS 且登录 Shell 可用。".to_string(),
                )),
            };
            if let Some(reason) = failure {
                let _ =
                    crate::remote_ssh::ssh_kill_terminal(terminal.clone(), None, None, app.state())
                        .await;
                agents.remote_exit(&terminal, reason);
                return;
            }
            while let Some(command) = commands.recv().await {
                match command {
                    crate::agent::RemoteCommand::Write(data) => {
                        if let Err(error) = write_remote(&app, &terminal, &data).await {
                            agents.remote_exit(
                                &terminal,
                                Some(format!("写入远端 Agent 失败：{error}")),
                            );
                            break;
                        }
                    }
                    crate::agent::RemoteCommand::Kill => break,
                }
            }
            let _ = crate::remote_ssh::ssh_kill_terminal(terminal.clone(), None, None, app.state())
                .await;
            agents.remote_exit(&terminal, None);
        });
    }
}

/// 定期结束空闲超过 24 小时的手机终端；结束失败的会话恢复原状，下一轮再试。
async fn sweep_idle_terminals(app: &AppHandle) {
    let hub = &app.state::<MobileState>().inner().hub;
    for (id, kind) in hub.take_idle_sessions(TERMINAL_IDLE) {
        let result = end(app, id.clone(), kind).await;
        let mut inner = hub.inner.lock().unwrap();
        if result.is_ok() {
            inner.sessions.remove(&id);
        } else if let Some(session) = inner.sessions.get_mut(&id) {
            session.ready = true;
        }
    }
}

/// Loads persisted pairings and restarts the listener if it was enabled.
pub fn initialize(app: &AppHandle) {
    let sweeper = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_SWEEP_INTERVAL).await;
            sweep_idle_terminals(&sweeper).await;
        }
    });
    let state = app.state::<MobileState>();
    state
        .agents
        .set_remote_launcher(Arc::new(RemoteAgents { app: app.clone() }));
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
    let agents = state.agents.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || agents.stop_all()).await;
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
    desktop_query(app, json!({ "project": project, "attachment": attachment })).await
}

/// 经主窗口查询电脑端保存的状态（项目、终端配置）。`request` 为不含 `id` 的请求体。
async fn desktop_query(app: &AppHandle, mut request: Value) -> Result<Value, String> {
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
        Operation::AgentCatalog
        | Operation::AgentDefaults { .. }
        | Operation::AgentThreads { .. }
        | Operation::AgentCreate { .. }
        | Operation::AgentSend { .. }
        | Operation::AgentImage { .. }
        | Operation::AgentPoll { .. }
        | Operation::AgentHistory { .. }
        | Operation::AgentRespond { .. }
        | Operation::AgentInterrupt { .. }
        | Operation::AgentConfigure { .. }
        | Operation::AgentRename { .. }
        | Operation::AgentClose { .. }
        | Operation::AgentDelete { .. }
        | Operation::AgentUsage { .. } => agent_operation(app, operation).await,
        Operation::Capabilities => Ok(json!({
            "protocolVersion": 1,
            "features": ["terminal_profiles", "session_names", "images", "latest_screen", "history"],
            "sessionScope": "shared",
        })),
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
        Operation::TerminalProfiles => desktop_query(app, json!({ "profiles": true })).await,
        Operation::Create {
            project,
            cols,
            rows,
            terminal_profile,
        } => {
            create(
                app,
                device,
                &project,
                terminal_profile.as_deref(),
                cols,
                rows,
            )
            .await
        }
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
            hub.with_session(&id, Session::touch);
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
            // A desktop prompt may have outlived revocation or session closure.
            {
                let inner = hub.inner.lock().unwrap();
                image_project(&inner, &id, device)?;
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
            hub.with_session(&id, Session::touch);
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

fn require_device(inner: &HubState, device: &str) -> Result<(), String> {
    if !inner.accepting || !inner.devices.iter().any(|entry| entry.saved.id == device) {
        return Err("移动连接已停止或设备已移除。".into());
    }
    Ok(())
}

fn image_project(inner: &HubState, id: &str, device: &str) -> Result<Project, String> {
    require_device(inner, device)?;
    let session = inner.sessions.get(id).ok_or("终端不存在。")?;
    // Paired devices share phone sessions. owner only selects lifecycle cleanup.
    if !session.ready || session.exit.is_some() {
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

/// 电脑端按 id 解析出的终端配置。命令只来自电脑端保存且已信任的配置，手机只传 id。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchProfile {
    name: String,
    /// 多行命令已由电脑端合并为单行；空串表示普通终端。
    command: String,
    /// 主机 shell 偏好（auto / powershell / pwsh / cmd / wsl / bash / zsh）。
    shell: String,
}

impl LaunchProfile {
    fn command(&self) -> Option<&str> {
        Some(self.command.trim()).filter(|command| !command.is_empty())
    }

    fn label(&self) -> Option<String> {
        let name = self.name.trim();
        (self.command().is_some() && !name.is_empty())
            .then(|| name.chars().filter(|c| !c.is_control()).take(80).collect())
    }
}

async fn launch_profile(app: &AppHandle, id: &str) -> Result<LaunchProfile, String> {
    serde_json::from_value(desktop_query(app, json!({ "profile": id })).await?)
        .map_err(|_| "电脑端返回的终端配置无效，请更新 Windows QingCode 后重试。".into())
}

async fn create(
    app: &AppHandle,
    device: &str,
    project_id: &str,
    profile_id: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let project: Project = serde_json::from_value(desktop(app, Some(project_id)).await?)
        .map_err(|error| error.to_string())?;
    let profile = match profile_id {
        Some(id) => Some(launch_profile(app, id).await?),
        None => None,
    };
    let id = format!("{TERMINAL_PREFIX}{}", Uuid::new_v4().simple());
    hub.reserve_session(
        id.clone(),
        project.clone(),
        device,
        profile.as_ref().and_then(LaunchProfile::label),
    )?;
    let (cols, rows) = size(cols, rows);
    hub.with_session(&id, |session| session.screen.resize(cols, rows));
    let command = profile
        .as_ref()
        .and_then(LaunchProfile::command)
        .map(str::to_owned);
    let shell = profile.map(|profile| profile.shell);
    let result = if project.kind == ProjectKind::Ssh {
        if let Some(command) = command {
            // 与电脑端配置终端同一路径：远端 Linux 用登录 shell 执行后保留 shell，
            // 远端 Windows 按配置的 shell 执行；daemon 名称沿用 `mobile-` id。
            crate::remote_ssh::ssh_spawn_script(
                id.clone(),
                project.path,
                "interactive".into(),
                command,
                HashMap::new(),
                Some(cols),
                Some(rows),
                shell,
                None,
                None,
                app.clone(),
                app.state(),
            )
            .await
        } else {
            crate::remote_ssh::ssh_create_terminal(
                id.clone(),
                project.path,
                Some(cols),
                Some(rows),
                shell,
                app.clone(),
                app.state(),
            )
            .await
        }
    } else {
        let app = app.clone();
        let id = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<crate::PathAllowlist>()
                .ensure_executable(&project.path)?;
            let manager = app.state::<crate::TerminalManager>();
            match (project.kind, command) {
                // WSL 项目在发行版内执行，主机 shell 偏好不适用。
                (ProjectKind::Wsl, command) => manager.spawn_mobile_wsl(
                    id,
                    &project.path,
                    command.as_deref(),
                    cols,
                    rows,
                    app.clone(),
                ),
                (_, Some(command)) => manager.spawn_script(
                    id,
                    &project.path,
                    "interactive",
                    &command,
                    HashMap::new(),
                    shell.as_deref(),
                    None,
                    cols,
                    rows,
                    app.clone(),
                ),
                (_, None) => {
                    manager.spawn(id, &project.path, shell.as_deref(), cols, rows, app.clone())
                }
            }
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result)
    };
    let kept = hub.finish_create(&id, result.is_ok());
    result?;
    if !kept {
        let _ = end(app, id, project.kind).await;
        return Err("移动连接已停止或设备已移除。".into());
    }
    let inner = hub.inner.lock().unwrap();
    let session = inner.sessions.get(&id).ok_or("终端不存在。")?;
    Ok(session.metadata(&id))
}

/// 重新向桌面端确认项目信任，返回 Agent 可用的项目描述。
async fn agent_project(
    app: &AppHandle,
    project_id: &str,
) -> Result<crate::agent::AgentProject, String> {
    // 桌面端确认信任并建立 SSH / Server 连接；远端根目录与符号链接由远端模块校验。
    let project: Project = serde_json::from_value(desktop(app, Some(project_id)).await?)
        .map_err(|error| error.to_string())?;
    if project.kind == ProjectKind::Local {
        app.state::<crate::PathAllowlist>()
            .ensure_executable(&project.path)?;
    }
    Ok(crate::agent::AgentProject {
        id: project.id,
        name: project.name,
        path: project.path,
        kind: match project.kind {
            ProjectKind::Local => "local",
            ProjectKind::Wsl => "wsl",
            ProjectKind::Ssh => "ssh",
        }
        .into(),
        host: project.host,
    })
}

/// 在阻塞线程池执行（可能启动子进程或短暂探测额度）。
async fn agents_blocking<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(&crate::agent::AgentHost) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let agents = app.state::<MobileState>().agents.clone();
    tauri::async_runtime::spawn_blocking(move || action(&agents))
        .await
        .map_err(|_| "Windows 端操作中断。".to_string())?
}

async fn agent_operation(app: &AppHandle, operation: Operation) -> Result<Value, String> {
    let agents = app.state::<MobileState>().agents.clone();
    match operation {
        Operation::AgentCatalog => agents_blocking(app, |agents| Ok(agents.catalog())).await,
        Operation::AgentDefaults {
            provider,
            safety,
            model,
        } => {
            agents_blocking(app, move |agents| {
                agents.set_defaults(provider, safety, model)
            })
            .await
        }
        Operation::AgentThreads { project } => {
            agents_blocking(app, move |agents| Ok(agents.list(project.as_deref()))).await
        }
        Operation::AgentCreate {
            project,
            provider,
            safety,
            model,
        } => {
            let project = agent_project(app, &project).await?;
            agents_blocking(app, move |agents| {
                agents.create(project, provider, safety, model)
            })
            .await
        }
        Operation::AgentSend { id, text, images } => {
            let (project, running) = agents.project(&id)?;
            // 进程未运行时会重新启动 Agent，先重新确认工作区信任与位置。
            let refreshed = if running {
                None
            } else {
                let current = agent_project(app, &project.id).await?;
                if current.path != project.path || current.kind != project.kind {
                    return Err("项目位置已变化，请新建对话。".into());
                }
                Some(current)
            };
            agents_blocking(app, move |agents| {
                agents.send(&id, &text, &images, refreshed)
            })
            .await
        }
        Operation::AgentImage { data } => {
            agents_blocking(app, move |agents| agents.attach(&data)).await
        }
        Operation::AgentPoll { id, from } => agents.poll(&id, from).await,
        Operation::AgentHistory { id, before } => agents.history(&id, &before),
        Operation::AgentRespond {
            id,
            approval,
            choice,
            answers,
        } => agents
            .respond(&id, &approval, &choice, &answers)
            .map(|_| Value::Null),
        Operation::AgentInterrupt { id } => agents.interrupt(&id).map(|_| Value::Null),
        Operation::AgentConfigure { id, key, value } => agents.configure(&id, &key, &value),
        Operation::AgentRename { id, title } => agents.rename(&id, &title),
        Operation::AgentClose { id } => agents.close(&id).map(|_| Value::Null),
        Operation::AgentDelete { id } => agents.delete(&id).map(|_| Value::Null),
        Operation::AgentUsage { refresh } => {
            agents_blocking(app, move |agents| Ok(agents.usage(refresh))).await
        }
        _ => unreachable!(),
    }
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
    fn image_upload_shares_live_sessions_between_paired_devices_only() {
        let hub = accepting_hub(Vec::new());
        let phone_token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
        let other_token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
        let phone = hub.authenticate(Some(&phone_token)).unwrap();
        let other = hub.authenticate(Some(&other_token)).unwrap();
        let mut inner = hub.inner.lock().unwrap();
        let mut session = Session::new(project(), phone.clone(), 1);
        session.ready = true;
        inner.sessions.insert("mobile-test".into(), session);
        assert!(image_project(&inner, "mobile-test", &phone).is_ok());
        assert!(image_project(&inner, "mobile-test", &other).is_ok());
        assert!(image_project(&inner, "mobile-test", "unpaired").is_err());
        assert!(image_project(&inner, "missing", &phone).is_err());
        inner.sessions.get_mut("mobile-test").unwrap().ready = false;
        assert!(image_project(&inner, "mobile-test", &phone).is_err());
        inner.sessions.get_mut("mobile-test").unwrap().ready = true;
        inner.accepting = false;
        assert!(image_project(&inner, "mobile-test", &phone).is_err());
    }

    #[test]
    fn revoked_device_cannot_reserve_after_a_desktop_prompt_completes() {
        let hub = accepting_hub(Vec::new());
        let token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
        let device = hub.authenticate(Some(&token)).unwrap();
        hub.forget_device(&device);
        assert!(hub
            .reserve_session("late".into(), project(), &device, None)
            .is_err());
        assert!(!hub.holds("late"));
    }

    #[tokio::test]
    async fn revocation_during_spawn_invalidates_the_reservation_and_rejects_late_completion() {
        let hub = Arc::new(accepting_hub(Vec::new()));
        let token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
        let device = hub.authenticate(Some(&token)).unwrap();
        hub.reserve_session("pending".into(), project(), &device, None)
            .unwrap();
        let (spawned, finish) = oneshot::channel();
        let launching = hub.clone();
        let late_spawn = tokio::spawn(async move {
            finish.await.unwrap();
            // false is the production signal to kill the late PTY.
            launching.finish_create("pending", true)
        });
        assert!(hub.forget_device(&device).is_empty());
        assert!(!hub.holds("pending"));
        spawned.send(()).unwrap();
        assert!(!late_spawn.await.unwrap());
        assert!(!hub.holds("pending"));
    }

    #[test]
    fn stopped_listener_or_failed_spawn_cannot_publish_a_session() {
        let hub = accepting_hub(Vec::new());
        let token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
        let device = hub.authenticate(Some(&token)).unwrap();
        hub.reserve_session("failed".into(), project(), &device, None)
            .unwrap();
        assert!(!hub.finish_create("failed", false));
        hub.reserve_session("stopped".into(), project(), &device, None)
            .unwrap();
        hub.inner.lock().unwrap().accepting = false;
        assert!(!hub.finish_create("stopped", true));
        assert!(!hub.holds("stopped"));
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
        push_title(&mut session, "⠋ 正在构建");
        for data in [
            session.metadata("mobile-7"),
            session.latest(),
            session.read(session.next),
        ] {
            assert_eq!(data["programTitle"], "⠋ 正在构建");
            assert_eq!(data["name"], "修复登录");
        }
        push_title(&mut session, "Claude");
        session.rename("").unwrap();
        assert_eq!(session.name(), "Claude");
        assert!(session.rename(&"中".repeat(81)).is_err());
        assert!(session.rename("bad\nname").is_err());
        assert_eq!(session.name(), "Claude");
    }

    #[test]
    fn create_accepts_an_optional_terminal_profile_id() {
        let legacy: Operation =
            serde_json::from_str(r#"{"op":"create","project":"p","cols":80,"rows":24}"#).unwrap();
        assert!(matches!(
            legacy,
            Operation::Create {
                terminal_profile: None,
                ..
            }
        ));
        let chosen: Operation = serde_json::from_str(
            r#"{"op":"create","project":"p","cols":80,"rows":24,"terminal_profile":"claude"}"#,
        )
        .unwrap();
        assert!(
            matches!(chosen, Operation::Create { terminal_profile: Some(ref id), .. } if id == "claude")
        );
        let list: Operation = serde_json::from_str(r#"{"op":"terminal_profiles"}"#).unwrap();
        assert!(matches!(list, Operation::TerminalProfiles));
        // 手机不能直接提交命令：未知字段被忽略，命令只来自电脑端配置。
        let injected: Operation = serde_json::from_str(
            r#"{"op":"create","project":"p","cols":80,"rows":24,"command":"rm -rf /"}"#,
        )
        .unwrap();
        assert!(matches!(
            injected,
            Operation::Create {
                terminal_profile: None,
                ..
            }
        ));
    }

    #[test]
    fn profile_sessions_fall_back_to_the_profile_name_until_a_title_arrives() {
        let profile = |name: &str, command: &str| LaunchProfile {
            name: name.into(),
            command: command.into(),
            shell: "auto".into(),
        };
        assert_eq!(profile("普通终端", "  ").command(), None);
        assert_eq!(profile("普通终端", "").label(), None);
        assert_eq!(profile(" ", "claude").label(), None);
        assert_eq!(profile(" Claude ", " claude ").command(), Some("claude"));

        let mut session = Session::new(project(), "phone".into(), 3);
        session.label = profile(" Claude\n", "claude").label();
        assert_eq!(session.name(), "Claude");
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode("\x1b]2;claude · app\x07"),
        ));
        assert_eq!(session.name(), "claude · app");
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
    fn remote_writes_are_chunked_on_character_boundaries() {
        let text = "你".repeat(REMOTE_WRITE_CHUNK / 3 + 10);
        let chunks = remote_chunks(&text);
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(|chunk| chunk.len() <= REMOTE_WRITE_CHUNK));
        assert_eq!(chunks.concat(), text);
        assert!(remote_chunks("").is_empty());
    }

    #[test]
    fn idle_sweep_ends_quiet_sessions_and_drops_old_exited_records() {
        let hub = Hub::default();
        {
            let mut inner = hub.inner.lock().unwrap();
            for (id, ready, exited, idle) in [
                ("mobile-quiet", true, false, true),
                ("mobile-busy", true, false, false),
                ("mobile-done", true, true, true),
                ("mobile-starting", false, false, true),
            ] {
                let mut session = Session::new(project(), "phone".into(), 1);
                session.ready = ready;
                if exited {
                    session.finish(Exit {
                        exit_code: 0,
                        disconnected: false,
                    });
                }
                if idle {
                    session.last_active = Instant::now() - Duration::from_secs(10);
                }
                inner.sessions.insert(id.into(), session);
            }
        }
        let idle = hub.take_idle_sessions(Duration::from_secs(5));
        assert_eq!(idle, [("mobile-quiet".to_string(), ProjectKind::Local)]);
        let inner = hub.inner.lock().unwrap();
        assert!(!inner.sessions["mobile-quiet"].ready, "结束期间不可再操作");
        assert!(!inner.sessions.contains_key("mobile-done"));
        assert!(inner.sessions["mobile-busy"].ready);
        assert!(inner.sessions.contains_key("mobile-starting"));
    }

    #[test]
    fn session_metadata_reports_idle_deadline_until_exit() {
        let mut session = Session::new(project(), "phone".into(), 1);
        let meta = session.metadata("mobile-1");
        assert_eq!(
            meta["idleDeadline"].as_u64().unwrap() - meta["lastActiveAt"].as_u64().unwrap(),
            TERMINAL_IDLE.as_millis() as u64
        );
        session.finish(Exit {
            exit_code: 0,
            disconnected: false,
        });
        assert!(session.metadata("mobile-1")["idleDeadline"].is_null());
    }

    #[test]
    fn device_names_are_trimmed_and_defaulted() {
        assert_eq!(device_name(None), "Android 设备");
        assert_eq!(device_name(Some("  ")), "Android 设备");
        assert_eq!(device_name(Some(&"x".repeat(80))).len(), MAX_DEVICE_NAME);
    }
}
