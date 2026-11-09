//! LAN companion endpoint. Only projects selected by the desktop bridge and
//! terminals allocated by this endpoint are addressable by paired devices.
//!
//! Pairings are persisted as SHA-256 token digests so a phone stays paired across
//! desktop restarts. Terminal output for `mobile-*` sessions is delivered here
//! directly by the PTY / SSH emitters instead of being broadcast to webviews.
use std::collections::{HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::mobile_screen::{MobileScreen, ProgramState};
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
/// 同时保持的 TLS 连接上限（含空闲 keep-alive），超出的新连接会被直接丢弃。
/// 手机端有 5 个单线程请求队列，加上空闲连接约占 5～6 条，按每台 8 条留余量，避免多设备互相挤占。
const MAX_CONNECTIONS: usize = MAX_DEVICES * 8;
const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_INPUT: usize = 16 * 1024;
const MAX_IMAGE: usize = 8 * 1024 * 1024;
/// Upper bound for one poll response body before JSON framing.
const MAX_POLL_BYTES: usize = 192 * 1024;
/// 电脑端「终端管理」只读预览附带的最近历史行数。
const PREVIEW_HISTORY_LINES: usize = 200;
/// 手机终端有新输出时通知电脑端预览的事件，只带会话 id，内容由预览自行读取。
const PREVIEW_OUTPUT_EVENT: &str = "mobile-session-output";
/// 同一会话的通知合并间隔：持续输出的 TUI 不会把预览刷新推到这个频率以上。
const PREVIEW_NOTIFY_INTERVAL: Duration = Duration::from_millis(100);
/// 电脑只读查看手机终端时积压的上限；超过后丢弃增量，下一轮改发整屏快照。
const MAX_VIEW_BACKLOG: usize = 256 * 1024;
/// 旧使用权发来的输入与改尺寸一律拒绝；手机端按这句文案进入被接管状态。
const TAKEN_OVER: &str = "终端已在其他设备接入。";
/// 使用权变化时通知电脑端：`controller` 为设备名表示电脑只读，为 null 表示电脑可操作。
const CONTROL_EVENT: &str = "terminal-control";
const DESKTOP_NAME: &str = "电脑";
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
/// 手机终端 24 小时内既无输入也无输出时自动结束。
const TERMINAL_IDLE: Duration = Duration::from_secs(24 * 60 * 60);
/// 程序标题出现转圈帧后保持「忙碌」的时间。按时间窗口而不是按轮询瞬间的标题判断：
/// 轮询可能正好取到空白帧或两次工具调用之间短暂的普通标题，直接取样会让转圈时转时停。
const SPINNER_HOLD: Duration = Duration::from_millis(3000);
/// 输入或改尺寸之后这段时间内的输出视为回显/重绘，不算程序在工作。
/// 须与 src/lib/terminal/terminalProgramActivity.ts 的 OUTPUT_QUIET_AFTER_INPUT_MS 一致。
const OUTPUT_QUIET_AFTER_INPUT: Duration = Duration::from_millis(500);
/// 输出需连续这么久才算运行中，过滤提示符重绘等一次性短输出。须与前端 OUTPUT_STREAK_MS 一致。
const OUTPUT_STREAK: Duration = Duration::from_millis(1000);

/// 标题开头的转圈帧字符：盲文点阵（含空白帧 U+2800）与常见的圆形/方块转圈。
fn is_spinner_glyph(character: char) -> bool {
    matches!(
        character,
        '\u{2800}'..='\u{28FF}'
            | '\u{25D0}'..='\u{25D3}' // ◐◑◒◓
            | '\u{25E2}'..='\u{25E5}' // ◢◣◤◥
            | '\u{25F0}'..='\u{25F7}' // ◰◱◲◳◴◵◶◷
    )
}

/// 去掉标题开头的转圈帧和装饰符，动画不会引起落盘；只剩动画时返回 `None`。
fn stable_title(title: &str) -> Option<String> {
    let title = title.trim();
    let text = match title.chars().next() {
        Some(first) if is_spinner_glyph(first) => title[first.len_utf8()..].trim_start(),
        _ => split_title_glyph(title).map_or(title, |(_, rest)| rest),
    };
    (!text.is_empty()).then(|| text.to_owned())
}

/// 拆出标题开头的单个符号（非字母数字、非空白）与其后的文本。
fn split_title_glyph(title: &str) -> Option<(char, &str)> {
    let mut chars = title.chars();
    let first = chars.next()?;
    if first.is_alphanumeric() || first.is_whitespace() {
        return None;
    }
    if !chars.as_str().chars().next()?.is_whitespace() {
        return None;
    }
    let rest = chars.as_str().trim_start();
    (!rest.is_empty()).then_some((first, rest))
}

/// 这次标题变化是否为一帧转圈动画：新标题以已知转圈字符开头，
/// 或者只有开头的符号变了、其后的文字不变（兼容未知的转圈字符，如 `| - / \`）。
fn is_spinner_frame(previous: Option<&str>, current: Option<&str>) -> bool {
    let Some(current) = current else {
        return false;
    };
    if current.chars().next().is_some_and(is_spinner_glyph) {
        return true;
    }
    match (
        previous.and_then(split_title_glyph),
        split_title_glyph(current),
    ) {
        (Some((before, before_rest)), Some((after, after_rest))) => {
            before != after && before_rest == after_rest
        }
        _ => false,
    }
}
const IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// 手机拉会话列表时，最多隔这么久扫描一次远端遗留的手机终端。
const RESTORE_SCAN_INTERVAL: Duration = Duration::from_secs(10);
/// 检查手机会话名称是否需要落盘的间隔。内容没变不写文件。
const SESSION_NAMES_SAVE_INTERVAL: Duration = Duration::from_secs(2);
/// 重启后等待接回的名称最多保留这么久，超过默认的 daemon 回收时长，留足余量。
const SAVED_NAME_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
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
    /// 手机接入的电脑终端。与 `sessions` 分表：清理、撤销、停止连接等结束进程的路径只遍历
    /// `sessions`，因此不可能结束电脑上的终端。
    mirrors: HashMap<String, Session>,
    /// 正在电脑标签里查看的手机终端，用于在会话被移除时通知标签。
    desktop_views: HashSet<String>,
    desktop_terminals: bool,
    next_number: u64,
    restore: RestoreScan,
    /// 上次运行保存、还没接回的手机会话名称，接回成功后移除。
    pending_names: HashMap<String, SavedSessionName>,
}

/// 电脑重启后接回手机终端的扫描进度，只在本次运行内有效。
#[derive(Default)]
struct RestoreScan {
    running: bool,
    last_started: Option<Instant>,
    /// 后台连接远端项目只请求一次，避免反复用保存的凭据尝试登录。
    connect_requested: bool,
    /// 已完整接回的连接；之后新脱离的终端由各自的代理负责重连。
    finished: HashSet<String>,
}

impl HubState {
    fn live(&self, id: &str) -> Option<&Session> {
        self.sessions.get(id).or_else(|| self.mirrors.get(id))
    }

    fn live_mut(&mut self, id: &str) -> Option<&mut Session> {
        if self.sessions.contains_key(id) {
            self.sessions.get_mut(id)
        } else {
            self.mirrors.get_mut(id)
        }
    }

    fn controller_name(&self, controller: &Controller) -> String {
        match controller {
            Controller::Desktop => DESKTOP_NAME.into(),
            Controller::Device(id) => self
                .devices
                .iter()
                .find(|entry| entry.saved.id == *id)
                .map_or_else(|| "其他设备".into(), |entry| entry.saved.name.clone()),
        }
    }

    /// 持旧使用权的轮询得到被接管答复，由手机显示「已在 X 上接入」。
    fn takeover_reply(&self, id: &str, lease: Option<u64>) -> Option<Value> {
        let session = self.live(id)?;
        let stale = match lease {
            Some(lease) => lease != session.lease,
            // 旧版手机不带使用权，只能用手机会话；电脑终端必须先接入。
            None => self.mirrors.contains_key(id),
        };
        stale.then(|| json!({ "takenOver": true, "by": self.controller_name(&session.controller) }))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Controller {
    Desktop,
    Device(String),
}

/// 电脑只读查看手机终端时待发送的输出，按预览通知的节奏合并后发出。
#[derive(Default)]
struct ViewBacklog {
    bytes: Vec<u8>,
    snapshot: bool,
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
    /// 允许手机接入电脑上开的终端；默认关闭，由用户在设置中显式开启。
    #[serde(default)]
    desktop_terminals: bool,
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

fn session_names_path() -> PathBuf {
    crate::app_paths::app_data_dir()
        .join("mobile")
        .join("session-names.json")
}

/// 名称文件只影响显示，读取失败按没有保存过处理，不影响接回终端。
fn load_session_names() -> HashMap<String, SavedSessionName> {
    let path = session_names_path();
    if std::fs::symlink_metadata(&path).is_err() {
        return HashMap::new();
    }
    qingcode_server::direct::private_read(&path)
        .and_then(|content| serde_json::from_slice(&content).map_err(|error| error.to_string()))
        .unwrap_or_else(|error| {
            eprintln!("[WARN] 读取手机会话名称失败：{error}");
            HashMap::new()
        })
}

fn save_session_names(names: &HashMap<String, SavedSessionName>) -> Result<(), String> {
    let path = session_names_path();
    qingcode_server::direct::protect_private_directory(path.parent().unwrap())?;
    let content = serde_json::to_vec(names).map_err(|error| error.to_string())?;
    qingcode_server::direct::private_write(&path, &content)
}

/// 定期把手机会话名称写入磁盘，电脑重启或升级后接回时恢复。只有这一个写入方。
async fn persist_session_names(app: AppHandle, mut written: HashMap<String, SavedSessionName>) {
    loop {
        tokio::time::sleep(SESSION_NAMES_SAVE_INTERVAL).await;
        let names = app.state::<MobileState>().hub.session_names_snapshot();
        if names == written {
            continue;
        }
        let content = names.clone();
        let result = tauri::async_runtime::spawn_blocking(move || save_session_names(&content))
            .await
            .map_err(|error| error.to_string())
            .and_then(|saved| saved);
        if let Err(error) = result {
            eprintln!("[WARN] 保存手机会话名称失败：{error}");
        }
        // 失败也更新：下次内容变化时重试，避免磁盘问题时每两秒写一次日志。
        written = names;
    }
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

/// 随电脑重启保留的手机会话名称信息，接回时按会话 id 恢复。
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct SavedSessionName {
    number: u64,
    custom_name: Option<String>,
    label: Option<String>,
    /// 去掉转圈帧的程序标题。daemon 的屏幕快照不带标题，接回后只能靠这里。
    title: Option<String>,
    created_at_ms: u64,
    /// 开始等待接回的时间（Unix 毫秒），用于淘汰再也接不回的记录；在线会话为空。
    detached_since_ms: Option<u64>,
}

struct Session {
    project: Project,
    owner: String,
    number: u64,
    custom_name: Option<String>,
    /// 带启动命令的终端配置名；程序未设置标题时代替「终端 N」。
    label: Option<String>,
    /// 重启前最后的程序标题，程序发出新标题后不再使用。
    restored_title: Option<String>,
    name_revision: u64,
    activity_revision: AtomicU64,
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
    /// 会话创建时间（Unix 毫秒），供手机与电脑端「终端管理」显示。
    created_at_ms: u64,
    /// 最近一次程序标题转圈帧的时间，用于平滑的「忙碌」状态。
    last_spinner_frame: Option<Instant>,
    /// 最近一次输入或改尺寸，其后短时间内的输出视为回显/重绘。
    last_input: Option<Instant>,
    /// 当前这段连续输出的开始与最近一次（间隔达到 `SPINNER_HOLD` 即断开）。
    output_streak_start: Option<Instant>,
    last_output: Option<Instant>,
    /// 已安排一次预览通知且尚未发出。
    preview_notify_pending: bool,
    /// 当前使用这个终端的一方，同一时刻只有一个。
    controller: Controller,
    /// 使用权编号，每次接管加一；持旧编号的输入和改尺寸被拒绝。
    lease: u64,
    /// 电脑已接回的镜像：停止接收输出，只保留编号，让被顶下去的手机知道是谁接走的。
    dormant: bool,
    view: Option<ViewBacklog>,
}

impl Session {
    fn new(project: Project, owner: String, number: u64) -> Self {
        let now_ms = unix_now_ms();
        Self {
            project,
            controller: Controller::Device(owner.clone()),
            lease: 1,
            dormant: false,
            view: None,
            owner,
            number,
            custom_name: None,
            label: None,
            restored_title: None,
            name_revision: 0,
            activity_revision: AtomicU64::new(0),
            ready: false,
            exit: None,
            drain_until: None,
            output: VecDeque::new(),
            output_size: 0,
            next: 0,
            changed: Arc::new(Notify::new()),
            screen: MobileScreen::new(),
            last_active: Instant::now(),
            last_active_ms: now_ms,
            created_at_ms: now_ms,
            last_spinner_frame: None,
            last_input: None,
            output_streak_start: None,
            last_output: None,
            preview_notify_pending: false,
        }
    }

    /// 程序是否在忙：有 OSC 7501 上报时以上报为准，否则看标题仍是转圈帧或最近
    /// `SPINNER_HOLD` 内出现过转圈帧；终端退出后一律不忙。
    fn program_busy_at(&self, now: Instant) -> bool {
        if let Some(state) = self.screen.program_state() {
            return self.exit.is_none() && state == ProgramState::Working;
        }
        self.exit.is_none()
            && (self
                .screen
                .title()
                .and_then(|title| title.chars().next())
                .is_some_and(is_spinner_glyph)
                || self
                    .last_spinner_frame
                    .is_some_and(|frame| now.saturating_duration_since(frame) < SPINNER_HOLD))
    }

    fn program_busy(&self) -> bool {
        self.program_busy_at(Instant::now())
    }

    /// 持续输出（连续至少 `OUTPUT_STREAK`，且最近 `SPINNER_HOLD` 内仍有输出）。
    /// 覆盖 build / test 等不改标题的命令；只用于列表显示，后台提醒仍只看标题转圈，
    /// 免得 `tail -f` 这类间歇输出反复触发「已停下」通知。
    fn output_busy_at(&self, now: Instant) -> bool {
        if self.screen.program_state().is_some() {
            return false;
        }
        self.exit.is_none()
            && match (self.output_streak_start, self.last_output) {
                (Some(start), Some(last)) => {
                    now.saturating_duration_since(last) < SPINNER_HOLD
                        && last.saturating_duration_since(start) >= OUTPUT_STREAK
                }
                _ => false,
            }
    }

    /// 列表显示与排序用的「运行中」：标题转圈或持续输出。
    fn display_busy(&self) -> bool {
        let now = Instant::now();
        self.program_busy_at(now) || self.output_busy_at(now)
    }

    /// 输入或改尺寸：既算会话活动，也让随后的回显/重绘不计入输出活跃。
    fn note_input(&mut self) {
        self.touch();
        self.last_input = Some(self.last_active);
    }

    /// 用户输入：回车提交时作废之前的上报（可能来自已退出的程序），由程序重新上报。
    fn note_user_input(&mut self, data: &str) {
        self.note_input();
        if data.contains('\r') {
            self.screen.clear_program_state();
        }
    }

    fn note_output_at(&mut self, now: Instant) {
        if self
            .last_input
            .is_some_and(|input| now.saturating_duration_since(input) < OUTPUT_QUIET_AFTER_INPUT)
        {
            return;
        }
        if self
            .last_output
            .is_none_or(|last| now.saturating_duration_since(last) >= SPINNER_HOLD)
        {
            self.output_streak_start = Some(now);
        }
        self.last_output = Some(now);
    }

    fn touch(&mut self) {
        self.last_active = Instant::now();
        self.last_active_ms = unix_now_ms();
    }

    fn push(&mut self, chunk: OutputChunk) {
        self.touch();
        let mut previous_title = self.screen.title().map(str::to_owned);
        match &chunk {
            OutputChunk::Bytes(data) => {
                self.note_output_at(self.last_active);
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                    for section in bytes.split_inclusive(|byte| matches!(*byte, 0x07 | 0x1b)) {
                        self.screen.process(section);
                        self.observe_program_title(&mut previous_title);
                    }
                    self.queue_view_bytes(&bytes);
                }
            }
            OutputChunk::Screen { data, cols, rows } => {
                self.screen.replace(data, *cols, *rows);
                self.screen.forget_program_status(is_spinner_glyph);
                if let Some(view) = self.view.as_mut() {
                    view.bytes = Vec::new();
                    view.snapshot = true;
                }
            }
        }
        self.observe_program_title(&mut previous_title);
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

    fn queue_view_bytes(&mut self, bytes: &[u8]) {
        let Some(view) = self.view.as_mut() else {
            return;
        };
        if view.snapshot {
            return;
        }
        view.bytes.extend_from_slice(bytes);
        if view.bytes.len() > MAX_VIEW_BACKLOG {
            view.bytes = Vec::new();
            view.snapshot = true;
        }
    }

    /// 电脑接回：丢弃缓存并停止接收，但保留表项让旧使用权的手机得到被接管答复。
    fn release_mirror(&mut self) {
        self.controller = Controller::Desktop;
        self.lease += 1;
        self.dormant = true;
        self.output.clear();
        self.output_size = 0;
        self.screen = MobileScreen::new();
        self.changed.notify_waiters();
    }

    fn observe_program_title(&mut self, previous_title: &mut Option<String>) {
        if previous_title.as_deref() != self.screen.title() {
            self.name_revision += 1;
            if is_spinner_frame(previous_title.as_deref(), self.screen.title()) {
                self.last_spinner_frame = Some(Instant::now());
            }
            *previous_title = self.screen.title().map(str::to_owned);
        }
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
            .or(self.restored_title.as_deref())
            .or(self.label.as_deref())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("终端 {}", self.number))
    }

    fn saved_name(&self) -> SavedSessionName {
        SavedSessionName {
            number: self.number,
            custom_name: self.custom_name.clone(),
            label: self.label.clone(),
            title: self
                .screen
                .title()
                .and_then(stable_title)
                .or_else(|| self.restored_title.clone()),
            created_at_ms: self.created_at_ms,
            detached_since_ms: None,
        }
    }

    fn restore_name(&mut self, saved: SavedSessionName) {
        self.number = saved.number;
        self.custom_name = saved.custom_name;
        self.label = saved.label;
        self.restored_title = saved.title;
        self.created_at_ms = saved.created_at_ms;
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
            "activityRevision": self.activity_revision.fetch_add(1, Ordering::Relaxed),
            "programTitle": self.screen.title(), "programBusy": self.display_busy(),
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision,
            "lastActiveAt": self.last_active_ms, "createdAt": self.created_at_ms,
            "idleDeadline": self.exit.is_none().then(|| self.last_active_ms + TERMINAL_IDLE.as_millis() as u64) })
    }

    /// 后台提醒只需要状态：名称用于通知标题，不返回程序标题之外的终端内容。
    fn attention(&self, id: &str) -> Value {
        json!({ "id": id, "name": self.name(), "project": self.project.id,
            "projectName": self.project.name, "busy": self.program_busy(),
            "exited": self.exit.is_some(), "bells": self.screen.attention_count() })
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
            "activityRevision": self.activity_revision.fetch_add(1, Ordering::Relaxed),
            "next": next,
            "more": next < self.next,
            "reset": reset,
            "exit": exit,
            "historyBefore": self.screen.history_before(),
            "historyAvailable": self.screen.has_history(),
            "programTitle": self.screen.title(), "programBusy": self.display_busy(),
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision,
        })
    }

    /// 支持 `tail` 的手机端落后太多时改发最新画面：游标已被淘汰，或积压超过一次轮询的上限。
    /// 全屏程序（如 OpenCode 加载长会话）瞬间重绘大量中间帧，逐帧回放会让手机 WebView 长时间卡死；
    /// 跳过的普通输出仍保留在 `MobileScreen` 历史里，可在只读历史中查看。
    fn should_send_latest(&self, from: u64) -> bool {
        let base = self.next - self.output.len() as u64;
        if from < base || from > self.next {
            return true;
        }
        let mut pending = 0;
        for chunk in self.output.iter().skip((from - base) as usize) {
            pending += chunk.encoded_len();
            if pending > MAX_POLL_BYTES {
                return true;
            }
        }
        false
    }

    fn latest(&self) -> Value {
        let exit = self
            .exit
            .as_ref()
            .filter(|_| self.drain_until.is_none_or(|until| Instant::now() >= until));
        json!({
            "chunks": [self.screen.snapshot()], "next": self.next,
            "activityRevision": self.activity_revision.fetch_add(1, Ordering::Relaxed),
            "more": false, "reset": false, "snapshot": true, "exit": exit,
            "historyBefore": self.screen.history_before(),
            "historyAvailable": self.screen.has_history(),
            "programTitle": self.screen.title(), "programBusy": self.display_busy(),
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
        /// 不传时返回这台电脑上全部项目的手机会话（附项目与创建设备），供手机纵览。
        #[serde(default)]
        project: Option<String>,
        /// 手机支持使用权时传 true，纵览里并入电脑上开的终端。
        #[serde(default)]
        desktop: bool,
    },
    /// 接入终端并取得使用权。`take` 仅在用户主动点击时为 true；重连和恢复界面传 false，不抢。
    Attach {
        id: String,
        #[serde(default)]
        take: bool,
    },
    /// 手机后台提醒：所有项目会话的忙碌、退出和提醒计数，不含任何终端内容。
    Attention,
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
        #[serde(default)]
        lease: Option<u64>,
    },
    History {
        id: String,
        before: u64,
        /// 新版手机端请求带颜色的历史；旧版不传，仍收到纯文本。
        #[serde(default)]
        formatted: bool,
    },
    Input {
        id: String,
        data: String,
        #[serde(default)]
        lease: Option<u64>,
    },
    Image {
        id: String,
        data: String,
        #[serde(default)]
        lease: Option<u64>,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        lease: Option<u64>,
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
    desktop_terminals: bool,
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
        inner.desktop_terminals = settings.desktop_terminals;
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
        let session = inner.live(id).ok_or("终端不存在。")?;
        if !session.ready || session.dormant || session.exit.is_some() || !inner.accepting {
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
        // 镜像只回收记录，绝不返回给调用方结束进程。
        inner.mirrors.retain(|_, mirror| {
            !((mirror.dormant || mirror.exit.is_some()) && mirror.last_active.elapsed() >= limit)
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
            // 保留 pending_names：这次没接回，下一轮扫描还要用。
            inner.sessions.remove(id);
            return false;
        }
        inner.sessions.get_mut(id).unwrap().ready = true;
        inner.pending_names.remove(id);
        true
    }

    /// 载入上次保存的名称并淘汰过期记录。新终端的编号排在待接回的之后，不会撞号。
    fn load_session_names(&self, saved: HashMap<String, SavedSessionName>, now_ms: u64) {
        let mut inner = self.inner.lock().unwrap();
        for (id, mut name) in saved {
            let since = *name.detached_since_ms.get_or_insert(now_ms);
            if now_ms.saturating_sub(since) < SAVED_NAME_RETENTION.as_millis() as u64 {
                inner.next_number = inner.next_number.max(name.number);
                inner.pending_names.insert(id, name);
            }
        }
    }

    /// 需要落盘的名称：能在电脑重启后接回的在线会话，加上还没接回的记录。
    /// 已结束或被关闭的会话不在其中，记录随下一次写入消失。
    fn session_names_snapshot(&self) -> HashMap<String, SavedSessionName> {
        let inner = self.inner.lock().unwrap();
        let mut names = inner.pending_names.clone();
        names.extend(
            inner
                .sessions
                .iter()
                .filter(|(_, session)| {
                    session.ready
                        && session.project.kind == ProjectKind::Ssh
                        && session.exit.as_ref().is_none_or(|exit| exit.disconnected)
                })
                .map(|(id, session)| (id.clone(), session.saved_name())),
        );
        names
    }

    /// 接回时恢复名称。版本号改用当前时间：手机可能还留着重启前较大的版本号，
    /// 从 0 重新计数的名称会被它当成迟到的旧响应丢弃。
    fn restore_session_name(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let saved = inner.pending_names.get(id).cloned();
        if let Some(session) = inner.sessions.get_mut(id) {
            if let Some(saved) = saved {
                session.restore_name(saved);
            }
            session.name_revision = unix_now_ms();
        }
    }

    /// 单飞且限频；返回 false 表示这次不用扫描。
    fn begin_restore_scan(&self, now: Instant) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let throttled = inner
            .restore
            .last_started
            .is_some_and(|last| now.saturating_duration_since(last) < RESTORE_SCAN_INTERVAL);
        if !inner.accepting || inner.restore.running || throttled {
            return false;
        }
        inner.restore.running = true;
        inner.restore.last_started = Some(now);
        true
    }

    fn finish_restore_scan(&self, connect_requested: bool, finished: Vec<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.restore.running = false;
        inner.restore.connect_requested |= connect_requested;
        inner.restore.finished.extend(finished);
    }

    fn restore_connect_requested(&self) -> bool {
        self.inner.lock().unwrap().restore.connect_requested
    }

    fn restore_finished(&self, connection: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .restore
            .finished
            .contains(connection)
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
        if let Some(session) = self.inner.lock().unwrap().live_mut(id) {
            update(session);
        }
    }

    fn desktop_terminals_enabled(&self) -> bool {
        self.inner.lock().unwrap().desktop_terminals
    }

    /// 校验使用权。手机会话兼容不带编号的旧版手机；电脑终端必须持当前编号。
    fn authorize(&self, id: &str, lease: Option<u64>) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        if let Some(session) = inner.sessions.get(id) {
            return if lease.is_none_or(|lease| lease == session.lease) {
                Ok(())
            } else {
                Err(TAKEN_OVER.into())
            };
        }
        let mirror = inner.mirrors.get(id).ok_or("终端不存在。")?;
        if lease == Some(mirror.lease) && !mirror.dormant {
            Ok(())
        } else {
            Err(TAKEN_OVER.into())
        }
    }

    /// 取得或确认使用权。已持有时返回原编号；被占用且 `take` 为 false 时返回被接管答复。
    fn claim(&self, id: &str, device: &str, take: bool) -> Result<Value, String> {
        let mut inner = self.inner.lock().unwrap();
        require_device(&inner, device)?;
        let controller = Controller::Device(device.to_string());
        let session = inner
            .live(id)
            .filter(|session| session.ready && !session.dormant)
            .ok_or("终端不存在。")?;
        if session.controller == controller {
            return Ok(json!({ "lease": session.lease }));
        }
        if !take {
            let by = inner.controller_name(&session.controller);
            return Ok(json!({ "takenOver": true, "by": by }));
        }
        let session = inner.live_mut(id).ok_or("终端不存在。")?;
        session.controller = controller;
        session.lease += 1;
        // 叫醒长轮询，被顶下去的设备立刻收到答复。
        session.changed.notify_waiters();
        Ok(json!({ "lease": session.lease }))
    }

    fn mirror_active(&self, id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .mirrors
            .get(id)
            .is_some_and(|mirror| !mirror.dormant)
    }

    fn is_phone_session(&self, id: &str) -> bool {
        self.inner.lock().unwrap().sessions.contains_key(id)
    }

    /// 用电脑当前画面建立镜像；编号沿用旧表项，迟到的手机请求不会误通过。
    #[allow(clippy::too_many_arguments)]
    fn seed_mirror(
        &self,
        id: String,
        project: Project,
        device: &str,
        name: Option<String>,
        cols: u16,
        rows: u16,
        data: &str,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        require_device(&inner, device)?;
        if !inner.desktop_terminals {
            return Err("电脑端未开启手机接入电脑终端。".into());
        }
        let lease = inner.mirrors.get(&id).map_or(1, |mirror| mirror.lease + 1);
        let mut session = Session::new(project, device.to_string(), 0);
        session.ready = true;
        session.lease = lease;
        session.label = name;
        let (cols, rows) = size(cols, rows);
        session.screen.resize(cols, rows);
        session.screen.process(data.as_bytes());
        inner.mirrors.insert(id, session);
        Ok(())
    }

    fn mirror_push(&self, id: &str, chunk: OutputChunk) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(mirror) = inner.mirrors.get_mut(id).filter(|mirror| !mirror.dormant) {
            mirror.push(chunk);
        }
    }

    fn mirror_finish(&self, id: &str, exit: Exit) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(mirror) = inner.mirrors.get_mut(id).filter(|mirror| !mirror.dormant) {
            mirror.finish(exit);
        }
    }

    /// 让出手机设备的镜像（全部或指定设备），返回受影响的终端，由调用方通知电脑端恢复操作。
    fn release_mirrors(&self, device: Option<&str>) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        inner
            .mirrors
            .iter_mut()
            .filter(|(_, mirror)| {
                !mirror.dormant
                    && device.is_none_or(|device| {
                        mirror.controller == Controller::Device(device.to_string())
                    })
            })
            .map(|(id, mirror)| {
                mirror.release_mirror();
                id.clone()
            })
            .collect()
    }

    fn take_for_desktop(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(session) = inner.sessions.get_mut(id) {
            if session.controller != Controller::Desktop {
                session.controller = Controller::Desktop;
                session.lease += 1;
                session.changed.notify_waiters();
            }
            return Ok(());
        }
        let mirror = inner.mirrors.get_mut(id).ok_or("终端不存在。")?;
        if !mirror.dormant {
            mirror.release_mirror();
        }
        Ok(())
    }

    /// 给电脑终端列表补上当前使用者。
    fn annotate_desktop_terminals(&self, items: Vec<Value>, viewer: &str) -> Vec<Value> {
        let inner = self.inner.lock().unwrap();
        items
            .into_iter()
            .filter_map(|mut item| {
                let id = item.get("id")?.as_str()?.to_owned();
                let holder = inner
                    .mirrors
                    .get(&id)
                    .filter(|mirror| !mirror.dormant && mirror.exit.is_none())
                    .map_or(Controller::Desktop, |mirror| mirror.controller.clone());
                let name = inner.controller_name(&holder);
                let map = item.as_object_mut()?;
                map.insert("origin".into(), json!("desktop"));
                map.insert("number".into(), json!(0));
                map.insert("exit".into(), Value::Null);
                map.insert("controllerName".into(), json!(name));
                map.insert(
                    "inUseHere".into(),
                    json!(holder == Controller::Device(viewer.to_string())),
                );
                Some(item)
            })
            .collect()
    }

    /// 开始在电脑标签中查看手机终端；首次发送整屏快照，之后走增量。
    fn open_view(&self, id: &str) -> Result<Value, String> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .get(id)
            .filter(|session| session.ready)
            .ok_or("终端不存在。")?;
        let (cols, rows) = session.screen.size();
        let holder = (session.controller != Controller::Desktop)
            .then(|| inner.controller_name(&session.controller));
        let reply = json!({
            "name": session.name(), "projectId": session.project.id, "path": session.project.path,
            "kind": session.project.kind, "controller": holder, "cols": cols, "rows": rows,
            "exit": session.exit,
        });
        inner.desktop_views.insert(id.to_string());
        if let Some(session) = inner.sessions.get_mut(id) {
            session.view = Some(ViewBacklog {
                bytes: Vec::new(),
                snapshot: true,
            });
        }
        Ok(reply)
    }

    fn close_view(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.desktop_views.remove(id);
        if let Some(session) = inner.sessions.get_mut(id) {
            session.view = None;
        }
    }

    fn desktop_controls(&self, id: &str) -> Result<ProjectKind, String> {
        let inner = self.inner.lock().unwrap();
        let session = inner.sessions.get(id).ok_or("终端不存在。")?;
        if session.controller != Controller::Desktop {
            return Err(TAKEN_OVER.into());
        }
        if !session.ready || session.exit.is_some() {
            return Err("终端已结束或正在启动。".into());
        }
        Ok(session.project.kind)
    }

    /// 取出待发给电脑标签的内容：积压过多时给整屏快照，并附带退出信息。
    fn take_view_output(&self, id: &str) -> Option<(ViewOutput, Option<(u32, bool)>)> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner.sessions.get_mut(id)?;
        let exit = session
            .exit
            .as_ref()
            .map(|exit| (exit.exit_code, exit.disconnected));
        let output = if session.view.as_ref()?.snapshot {
            let screen = session.screen.snapshot();
            let view = session.view.as_mut()?;
            view.snapshot = false;
            view.bytes = Vec::new();
            ViewOutput::Screen(screen)
        } else {
            ViewOutput::Bytes(std::mem::take(&mut session.view.as_mut()?.bytes))
        };
        Some((output, exit))
    }

    fn take_view_mark(&self, id: &str) -> bool {
        self.inner.lock().unwrap().desktop_views.remove(id)
    }

    /// 更新会话画面。返回 true 表示调用方需要安排一次预览通知；
    /// 通知发出前的后续更新只返回 false，由已安排的那次一并覆盖。
    fn update_for_preview(&self, id: &str, update: impl FnOnce(&mut Session)) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(session) = inner.sessions.get_mut(id) else {
            return false;
        };
        update(session);
        !std::mem::replace(&mut session.preview_notify_pending, true)
    }

    fn rename_session(&self, id: &str, name: &str) -> Result<Value, String> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner.sessions.get_mut(id).ok_or("终端不存在。")?;
        if !session.ready {
            return Err("终端正在启动或关闭。".into());
        }
        session.rename(name)?;
        Ok(session.metadata(id))
    }

    /// 全部已就绪的手机会话，附项目与创建设备，按项目名、编号排序。
    /// viewer 为请求的手机设备时额外标出 `ownDevice`（是否由这台手机创建）。
    fn session_summaries(&self, viewer: Option<&str>) -> Vec<Value> {
        let inner = self.inner.lock().unwrap();
        let mut sessions: Vec<_> = inner
            .sessions
            .iter()
            .filter(|(_, session)| session.ready)
            .collect();
        sessions.sort_by(|(_, a), (_, b)| {
            (a.project.name.as_str(), a.project.id.as_str(), a.number).cmp(&(
                b.project.name.as_str(),
                b.project.id.as_str(),
                b.number,
            ))
        });
        sessions
            .into_iter()
            .map(|(id, session)| {
                let device = inner
                    .devices
                    .iter()
                    .find(|entry| entry.saved.id == session.owner);
                let mut value = session.metadata(id);
                if let Value::Object(map) = &mut value {
                    map.insert(
                        "project".into(),
                        json!({
                            "id": session.project.id, "name": session.project.name,
                            "path": session.project.path, "kind": session.project.kind,
                            "host": session.project.host,
                        }),
                    );
                    map.insert(
                        "deviceName".into(),
                        json!(device.map(|entry| entry.saved.name.as_str())),
                    );
                    map.insert(
                        "controllerName".into(),
                        json!(inner.controller_name(&session.controller)),
                    );
                    if let Some(viewer) = viewer {
                        map.insert("ownDevice".into(), json!(session.owner == viewer));
                        map.insert(
                            "inUseHere".into(),
                            json!(session.controller == Controller::Device(viewer.to_string())),
                        );
                    }
                }
                value
            })
            .collect()
    }

    fn session_preview(&self, id: &str) -> Result<Value, String> {
        let inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .get(id)
            .filter(|session| session.ready)
            .ok_or("终端不存在。")?;
        let mut preview = session.screen.preview(PREVIEW_HISTORY_LINES);
        if let Value::Object(map) = &mut preview {
            map.insert("name".into(), json!(session.name()));
            map.insert("exit".into(), json!(session.exit));
        }
        Ok(preview)
    }

    #[cfg(test)]
    fn holds(&self, id: &str) -> bool {
        self.inner.lock().unwrap().sessions.contains_key(id)
    }
}

pub(crate) fn is_mobile_terminal(id: &str) -> bool {
    id.starts_with(TERMINAL_PREFIX)
}

/// 更新手机会话，并在合并间隔结束时通知电脑端预览。
/// 通知排在间隔末尾，一段输出的最后一块也能被预览读到；
/// 没有预览在监听时，Tauri 不会把事件发给 webview。
fn deliver_update(app: &AppHandle, id: &str, update: impl FnOnce(&mut Session)) {
    let Some(state) = app.try_state::<MobileState>() else {
        return;
    };
    if !state.hub.update_for_preview(id, update) {
        return;
    }
    schedule_output_notify(app.clone(), id.to_owned());
}

/// 合并间隔结束后发给电脑标签与预览，电脑端比手机晚约 100ms 显示，换取较低的刷新开销。
fn schedule_output_notify(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PREVIEW_NOTIFY_INTERVAL).await;
        // 先清标记再发事件：之后到达的输出会再安排一次通知，不会漏掉。
        if let Some(state) = app.try_state::<MobileState>() {
            state.hub.with_session(&id, |session| {
                session.preview_notify_pending = false;
            });
        }
        flush_view(&app, &id);
        let _ = app.emit(PREVIEW_OUTPUT_EVENT, json!({ "id": id }));
    });
}

enum ViewOutput {
    Bytes(Vec<u8>),
    Screen(Value),
}

/// 把积压的手机终端输出交给电脑标签，事件名与普通终端相同，电脑端无需另写渲染。
fn flush_view(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<MobileState>() else {
        return;
    };
    let Some((output, exit)) = state.hub.take_view_output(id) else {
        return;
    };
    match output {
        ViewOutput::Bytes(bytes) if bytes.is_empty() => {}
        ViewOutput::Bytes(bytes) => {
            let data = crate::terminal::encode_terminal_data(&bytes);
            let _ = app.emit("terminal-data", json!({ "id": id, "data": data }));
        }
        ViewOutput::Screen(mut screen) => {
            screen["id"] = json!(id);
            let _ = app.emit("terminal-screen", screen);
        }
    }
    if let Some((exit_code, disconnected)) = exit {
        emit_view_exit(app, id, exit_code, disconnected);
    }
}

/// 只通知一次：退出事件和各条移除路径都可能走到这里。
fn emit_view_exit(app: &AppHandle, id: &str, exit_code: u32, disconnected: bool) {
    let Some(state) = app.try_state::<MobileState>() else {
        return;
    };
    if state.hub.take_view_mark(id) {
        let _ = app.emit(
            "terminal-exit",
            json!({ "id": id, "exitCode": exit_code, "disconnected": disconnected }),
        );
    }
}

fn emit_control(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<MobileState>() else {
        return;
    };
    let payload = {
        let inner = state.hub.inner.lock().unwrap();
        let Some(session) = inner.live(id) else {
            return;
        };
        let holder = (session.controller != Controller::Desktop && !session.dormant)
            .then(|| inner.controller_name(&session.controller));
        let (cols, rows) = session.screen.size();
        json!({ "id": id, "controller": holder, "cols": cols, "rows": rows })
    };
    let _ = app.emit(CONTROL_EVENT, payload);
}

/// Base64 PTY output for a `mobile-*` terminal.
pub(crate) fn deliver_data(app: &AppHandle, id: &str, data: String) {
    deliver_update(app, id, |session| session.push(OutputChunk::Bytes(data)));
}

/// Plain-text screen snapshot for a reattached `mobile-*` daemon terminal.
pub(crate) fn deliver_screen(app: &AppHandle, id: &str, data: String, cols: u16, rows: u16) {
    deliver_update(app, id, |session| {
        session.push(OutputChunk::Screen { data, cols, rows })
    });
}

pub(crate) fn deliver_exit(app: &AppHandle, id: &str, exit_code: u32, disconnected: bool) {
    deliver_update(app, id, |session| {
        session.finish(Exit {
            exit_code,
            disconnected,
        })
    });
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
    let (saved_port, configured, enabled, fingerprint, desktop_terminals, mut devices) = {
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
            inner.desktop_terminals,
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
        desktop_terminals,
    }
}

/// 定期结束空闲超过 24 小时的手机终端；结束失败的会话恢复原状，下一轮再试。
async fn sweep_idle_terminals(app: &AppHandle) {
    let hub = &app.state::<MobileState>().inner().hub;
    for (id, kind) in hub.take_idle_sessions(TERMINAL_IDLE) {
        let result = end(app, id.clone(), kind).await;
        {
            let mut inner = hub.inner.lock().unwrap();
            if result.is_ok() {
                inner.sessions.remove(&id);
            } else if let Some(session) = inner.sessions.get_mut(&id) {
                session.ready = true;
            }
        }
        if result.is_ok() {
            emit_view_exit(app, &id, 0, false);
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
    let saved_names = load_session_names();
    state
        .hub
        .load_session_names(saved_names.clone(), unix_now_ms());
    tauri::async_runtime::spawn(persist_session_names(app.clone(), saved_names));
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
        let _ = end(&app, id.clone(), kind).await;
        emit_view_exit(&app, &id, 0, false);
    }
    // 只让出使用权：电脑上开的终端继续运行，电脑恢复可操作。
    for id in state.hub.release_mirrors(None) {
        emit_control(&app, &id);
    }
    Ok(status(&state))
}

#[tauri::command]
pub async fn mobile_revoke_device(id: String, app: AppHandle) -> Result<Status, String> {
    let state = app.state::<MobileState>();
    let _lifecycle = state.lifecycle.lock().await;
    update_settings(|settings| settings.devices.retain(|device| device.id != id))?;
    for (session, kind) in state.hub.forget_device(&id) {
        let _ = end(&app, session.clone(), kind).await;
        emit_view_exit(&app, &session, 0, false);
    }
    for terminal in state.hub.release_mirrors(Some(&id)) {
        emit_control(&app, &terminal);
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
        Operation::Capabilities => Ok(json!({
            "protocolVersion": 1,
            "features": ["terminal_profiles", "session_names", "images", "latest_screen", "history", "attention", "all_sessions", "handoff"],
            "sessionScope": "shared",
        })),
        Operation::Projects => desktop(app, None).await,
        Operation::Sessions {
            project: None,
            desktop,
        } => {
            schedule_restore_scan(app, device);
            let mut list = hub.session_summaries(Some(device));
            if desktop && hub.desktop_terminals_enabled() {
                // 电脑窗口暂时无响应时只少了电脑终端，手机会话列表照常返回。
                if let Ok(Value::Array(items)) =
                    desktop_query(app, json!({ "desktopTerminals": true })).await
                {
                    list.extend(hub.annotate_desktop_terminals(items, device));
                }
            }
            Ok(json!(list))
        }
        Operation::Attach { id, take } => attach(app, device, id, take).await,
        Operation::Sessions {
            project: Some(project),
            ..
        } => {
            schedule_restore_scan(app, device);
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
        Operation::Attention => {
            let inner = hub.inner.lock().unwrap();
            let mut sessions: Vec<_> = inner
                .sessions
                .iter()
                .filter(|(_, session)| session.ready)
                .collect();
            sessions.sort_by_key(|(_, session)| session.number);
            Ok(json!(sessions
                .into_iter()
                .map(|(id, session)| session.attention(id))
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
        Operation::History {
            id,
            before,
            formatted,
        } => {
            let inner = hub.inner.lock().unwrap();
            let session = inner.live(&id).ok_or("终端不存在。")?;
            Ok(session.screen.history_page(before, formatted))
        }
        Operation::Poll {
            id,
            from,
            latest,
            tail,
            lease,
        } => {
            let wait = {
                let inner = hub.inner.lock().unwrap();
                if let Some(reply) = inner.takeover_reply(&id, lease) {
                    return Ok(reply);
                }
                let session = inner.live(&id).ok_or("终端不存在。")?;
                if latest || (tail && session.should_send_latest(from)) {
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
            if let Some(reply) = inner.takeover_reply(&id, lease) {
                return Ok(reply);
            }
            let session = inner.live(&id).ok_or("终端不存在。")?;
            Ok(if tail && session.should_send_latest(from) {
                session.latest()
            } else {
                session.read(from)
            })
        }
        Operation::Input { id, data, lease } => {
            if data.len() > MAX_INPUT {
                return Err("单次终端输入超过 16 KiB。".into());
            }
            hub.authorize(&id, lease)?;
            hub.with_session(&id, |session| session.note_user_input(&data));
            let kind = hub.session_kind(&id)?;
            write_input(app, kind, id, data).await?;
            Ok(Value::Null)
        }
        Operation::Image { id, data, lease } => {
            hub.authorize(&id, lease)?;
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
        Operation::Resize {
            id,
            cols,
            rows,
            lease,
        } => {
            hub.authorize(&id, lease)?;
            hub.with_session(&id, Session::note_input);
            let kind = hub.session_kind(&id)?;
            apply_resize(app, kind, &id, cols, rows).await?;
            // 电脑只读画面跟随使用者的行列，内容不错位。
            emit_control(app, &id);
            Ok(Value::Null)
        }
        Operation::RenameSession { id, name } => hub.rename_session(&id, &name),
        Operation::End { id } => {
            if hub.is_phone_session(&id) {
                end_session(app, id).await?;
            } else {
                // 电脑上的终端交给电脑端关闭，标签、提示和记录走桌面原有流程。
                if !hub.desktop_terminals_enabled() {
                    return Err("电脑端未开启手机接入电脑终端。".into());
                }
                desktop_query(app, json!({ "endTerminal": id })).await?;
            }
            Ok(Value::Null)
        }
    }
}

/// 本机宿主托管的电脑终端属于本地项目，但和 SSH 持久终端登记在同一张表。
fn routes_through_ssh_table(app: &AppHandle, kind: ProjectKind, id: &str) -> bool {
    kind == ProjectKind::Ssh
        || app
            .state::<crate::remote_ssh::SshManager>()
            .local_hosted_pty_id(id)
            .is_some()
}

async fn write_input(
    app: &AppHandle,
    kind: ProjectKind,
    id: String,
    data: String,
) -> Result<(), String> {
    if routes_through_ssh_table(app, kind, &id) {
        crate::remote_ssh::ssh_write_terminal_unchecked(id, data, app.state()).await
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<crate::TerminalManager>().write(&id, &data)
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

async fn apply_resize(
    app: &AppHandle,
    kind: ProjectKind,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (cols, rows) = size(cols, rows);
    if routes_through_ssh_table(app, kind, id) {
        crate::remote_ssh::ssh_resize_terminal_unchecked(id.to_owned(), cols, rows, app.state())
            .await?;
    } else {
        app.state::<crate::TerminalManager>()
            .resize(id, cols, rows)?;
    }
    app.state::<MobileState>()
        .hub
        .with_session(id, |session| session.screen.resize(cols, rows));
    Ok(())
}

/// 手机接入终端。电脑终端首次接入时由电脑端抓取当前画面并开始转发。
async fn attach(app: &AppHandle, device: &str, id: String, take: bool) -> Result<Value, String> {
    let hub = &app.state::<MobileState>().inner().hub;
    if !hub.is_phone_session(&id) && !hub.mirror_active(&id) {
        if !hub.desktop_terminals_enabled() {
            return Err("电脑端未开启手机接入电脑终端。".into());
        }
        if !take {
            return Ok(json!({ "takenOver": true, "by": DESKTOP_NAME }));
        }
        desktop_query(app, json!({ "mirrorStart": id, "device": device })).await?;
    }
    let reply = hub.claim(&id, device, take)?;
    emit_control(app, &id);
    Ok(reply)
}

/// 结束手机会话；已退出的会话直接移除。手机端与电脑端「终端管理」共用。
async fn end_session(app: &AppHandle, id: String) -> Result<(), String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let kind = {
        let mut inner = hub.inner.lock().unwrap();
        let session = inner.sessions.get_mut(&id).ok_or("终端不存在。")?;
        if !session.ready {
            return Err("终端正在启动或关闭。".into());
        }
        if session.exit.is_some() {
            inner.sessions.remove(&id);
            drop(inner);
            emit_view_exit(app, &id, 0, false);
            return Ok(());
        }
        session.ready = false;
        session.project.kind
    };
    let result = end(app, id.clone(), kind).await;
    {
        let mut inner = hub.inner.lock().unwrap();
        if result.is_ok() {
            inner.sessions.remove(&id);
        } else if let Some(session) = inner.sessions.get_mut(&id) {
            session.ready = true;
        }
    }
    if result.is_ok() {
        emit_view_exit(app, &id, 0, false);
    }
    result
}

/// 电脑端的普通终端入口一律拒绝 `mobile-*` id。手机终端要在电脑上看或操作时，
/// 走「终端管理」和带使用权校验的 `mobile_view_*` 命令。
pub(crate) fn reject_desktop_use(id: &str) -> Result<(), String> {
    if is_mobile_terminal(id) {
        Err("手机终端请从「终端管理」打开后接管；普通终端入口不能操作。".into())
    } else {
        Ok(())
    }
}

/// 电脑端「终端管理」列出全部手机会话（跨项目），只含元数据，不含输出。
#[tauri::command]
pub fn mobile_sessions(state: State<'_, MobileState>) -> Vec<Value> {
    state.hub.session_summaries(None)
}

/// 电脑端只读预览：最近历史与当前画面的纯文本，不改尺寸、不输入。
#[tauri::command]
pub fn mobile_session_preview(id: String, state: State<'_, MobileState>) -> Result<Value, String> {
    state.hub.session_preview(&id)
}

#[tauri::command]
pub fn mobile_rename_session(
    id: String,
    name: String,
    state: State<'_, MobileState>,
) -> Result<Value, String> {
    state.hub.rename_session(&id, &name)
}

#[tauri::command]
pub async fn mobile_end_session(id: String, app: AppHandle) -> Result<(), String> {
    if !is_mobile_terminal(&id) {
        return Err("终端不存在。".into());
    }
    end_session(&app, id).await
}

/// 手机正在使用这个电脑终端时，电脑端输入被拒绝、改尺寸被忽略。
pub(crate) fn desktop_blocked(state: &MobileState, id: &str) -> bool {
    state
        .hub
        .inner
        .lock()
        .unwrap()
        .mirrors
        .get(id)
        .is_some_and(|mirror| {
            !mirror.dormant && mirror.exit.is_none() && mirror.controller != Controller::Desktop
        })
}

pub(crate) fn check_desktop_write(state: &MobileState, id: &str) -> Result<(), String> {
    if desktop_blocked(state, id) {
        Err("终端正在其他设备上使用，请先点「接回」。".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn mobile_set_desktop_terminals(enabled: bool, app: AppHandle) -> Result<Status, String> {
    update_settings(|settings| settings.desktop_terminals = enabled)?;
    let state = app.state::<MobileState>();
    state.hub.inner.lock().unwrap().desktop_terminals = enabled;
    if !enabled {
        for id in state.hub.release_mirrors(None) {
            emit_control(&app, &id);
        }
    }
    Ok(status(&state))
}

#[tauri::command]
pub fn mobile_terminal_take(id: String, app: AppHandle) -> Result<(), String> {
    app.state::<MobileState>().hub.take_for_desktop(&id)?;
    emit_control(&app, &id);
    Ok(())
}

/// 主窗口重载后转发已丢失：把镜像全部还给电脑，手机按被接管处理。
#[tauri::command]
pub fn mobile_release_mirrors(app: AppHandle, window: WebviewWindow) {
    if window.label() != "main" {
        return;
    }
    for id in app.state::<MobileState>().hub.release_mirrors(None) {
        emit_control(&app, &id);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mobile_mirror_seed(
    window: WebviewWindow,
    state: State<'_, MobileState>,
    id: String,
    device: String,
    project: Value,
    name: Option<String>,
    cols: u16,
    rows: u16,
    data: String,
) -> Result<(), String> {
    if window.label() != "main" || is_mobile_terminal(&id) {
        return Err("终端不存在。".into());
    }
    let project: Project = serde_json::from_value(project).map_err(|error| error.to_string())?;
    state
        .hub
        .seed_mirror(id, project, &device, name, cols, rows, &data)
}

#[tauri::command]
pub fn mobile_mirror_output(state: State<'_, MobileState>, id: String, data: String) {
    state.hub.mirror_push(&id, OutputChunk::Bytes(data));
}

#[tauri::command]
pub fn mobile_mirror_screen(
    state: State<'_, MobileState>,
    id: String,
    data: String,
    cols: u16,
    rows: u16,
) {
    state
        .hub
        .mirror_push(&id, OutputChunk::Screen { data, cols, rows });
}

#[tauri::command]
pub fn mobile_mirror_finish(
    state: State<'_, MobileState>,
    id: String,
    exit_code: u32,
    disconnected: bool,
) {
    state.hub.mirror_finish(
        &id,
        Exit {
            exit_code,
            disconnected,
        },
    );
}

/// 在电脑标签中打开手机终端：默认只读，整屏快照随下一轮输出通知发出。
#[tauri::command]
pub fn mobile_view_open(id: String, app: AppHandle) -> Result<Value, String> {
    if !is_mobile_terminal(&id) {
        return Err("终端不存在。".into());
    }
    let state = app.state::<MobileState>();
    let reply = state.hub.open_view(&id)?;
    if state.hub.update_for_preview(&id, |_| {}) {
        schedule_output_notify(app.clone(), id);
    }
    Ok(reply)
}

#[tauri::command]
pub fn mobile_view_close(id: String, state: State<'_, MobileState>) {
    state.hub.close_view(&id);
}

#[tauri::command]
pub async fn mobile_view_input(id: String, data: String, app: AppHandle) -> Result<(), String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let kind = hub.desktop_controls(&id)?;
    hub.with_session(&id, |session| session.note_user_input(&data));
    write_input(&app, kind, id, data).await
}

/// 手机仍在使用时电脑的布局变化不影响终端尺寸，这里直接忽略。
#[tauri::command]
pub async fn mobile_view_resize(
    id: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
) -> Result<(), String> {
    let hub = &app.state::<MobileState>().inner().hub;
    match hub.desktop_controls(&id) {
        Ok(kind) => apply_resize(&app, kind, &id, cols, rows).await,
        Err(_) => Ok(()),
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
    let session = inner.live(id).ok_or("终端不存在。")?;
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
            crate::remote_ssh::ssh_spawn_script_unchecked(
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
            crate::remote_ssh::ssh_create_terminal_unchecked(
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

/// 手机会话记录只在电脑内存里，电脑重启或升级后要从 daemon 找回仍在运行的终端。
/// 在后台进行，不阻塞列表；手机下一次刷新就能看到。
fn schedule_restore_scan(app: &AppHandle, device: &str) {
    if !app
        .state::<MobileState>()
        .hub
        .begin_restore_scan(Instant::now())
    {
        return;
    }
    let app = app.clone();
    let device = device.to_owned();
    tauri::async_runtime::spawn(async move {
        let (connect_requested, finished) = scan_detached_sessions(&app, &device).await;
        app.state::<MobileState>()
            .hub
            .finish_restore_scan(connect_requested, finished);
    });
}

async fn scan_detached_sessions(app: &AppHandle, device: &str) -> (bool, Vec<String>) {
    let hub = &app.state::<MobileState>().inner().hub;
    let connect_requested = hub.restore_connect_requested()
        || desktop_query(app, json!({ "connectRemoteProjects": true }))
            .await
            .is_ok();
    let mut finished = Vec::new();
    for connection in crate::remote_ssh::mobile_restore::restorable_connections(app) {
        if hub.restore_finished(&connection) {
            continue;
        }
        let listed = crate::remote_ssh::mobile_restore::list_detached(&connection, app).await;
        match listed {
            Ok(terminals) => {
                if restore_detached_sessions(app, device, terminals).await {
                    finished.push(connection);
                }
            }
            // 守护进程还没就绪时下一轮再查。
            Err(error) => eprintln!("[WARN] 查询遗留手机终端失败：{error}"),
        }
    }
    (connect_requested, finished)
}

/// 返回 false 表示有终端这次没接回，下一轮再试。
async fn restore_detached_sessions(
    app: &AppHandle,
    device: &str,
    terminals: Vec<crate::remote_ssh::mobile_restore::DetachedMobileTerminal>,
) -> bool {
    let hub = &app.state::<MobileState>().inner().hub;
    let terminals: Vec<_> = terminals
        .into_iter()
        .filter(|terminal| !hub.is_phone_session(&terminal.session_id))
        .collect();
    if terminals.is_empty() {
        return true;
    }
    let Some(projects) = desktop(app, None)
        .await
        .ok()
        .and_then(|value| serde_json::from_value::<Vec<Project>>(value).ok())
    else {
        return false;
    };
    let mut complete = true;
    for terminal in terminals {
        // 项目已移除或不再受信任：不接回，留给 daemon 回收。
        let Some(project) = projects.iter().find(|project| {
            crate::remote_ssh::mobile_restore::is_same_root(&project.path, &terminal.root_uri)
        }) else {
            continue;
        };
        let id = terminal.session_id.clone();
        if let Err(error) = hub.reserve_session(id.clone(), project.clone(), device, None) {
            eprintln!("[WARN] 手机终端未接回：{error}");
            return false;
        }
        hub.restore_session_name(&id);
        hub.with_session(&id, |session| {
            session.screen.resize(terminal.cols, terminal.rows)
        });
        let result = crate::remote_ssh::mobile_restore::attach(&terminal, app).await;
        let attached = result.is_ok();
        if let Err(error) = result {
            eprintln!("[WARN] 手机终端接回失败：{error}");
            complete = false;
        }
        if !hub.finish_create(&id, attached) && attached {
            crate::remote_ssh::mobile_restore::detach(&id, app).await;
        }
    }
    complete
}

async fn end(app: &AppHandle, id: String, kind: ProjectKind) -> Result<(), String> {
    if routes_through_ssh_table(app, kind, &id) {
        crate::remote_ssh::ssh_kill_terminal_unchecked(id, None, None, app.state()).await
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
            desktop_terminals: false,
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
            Operation::Image { id, data, .. } => {
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

    fn handoff_hub() -> Hub {
        let hub = accepting_hub(vec![device("phone"), device("tablet")]);
        hub.inner.lock().unwrap().desktop_terminals = true;
        hub
    }

    fn device(id: &str) -> Device {
        Device {
            id: id.into(),
            name: format!("{id}-name"),
            token_digest: token_digest(id),
            paired_at: 0,
        }
    }

    fn ready_session(hub: &Hub, id: &str, owner: &str) {
        hub.reserve_session(id.into(), project(), owner, None)
            .unwrap();
        assert!(hub.finish_create(id, true));
    }

    #[test]
    fn takeover_requires_an_explicit_take_and_invalidates_the_old_lease() {
        let hub = handoff_hub();
        ready_session(&hub, "mobile-a", "phone");
        assert_eq!(hub.claim("mobile-a", "phone", false).unwrap()["lease"], 1);
        // 重连与恢复界面不抢使用权。
        let passive = hub.claim("mobile-a", "tablet", false).unwrap();
        assert_eq!(passive["takenOver"], true);
        assert_eq!(passive["by"], "phone-name");
        assert_eq!(hub.claim("mobile-a", "tablet", true).unwrap()["lease"], 2);
        assert_eq!(hub.authorize("mobile-a", Some(1)).unwrap_err(), TAKEN_OVER);
        assert!(hub.authorize("mobile-a", Some(2)).is_ok());
        let inner = hub.inner.lock().unwrap();
        assert_eq!(
            inner.takeover_reply("mobile-a", Some(1)).unwrap()["by"],
            "tablet-name"
        );
        assert!(inner.takeover_reply("mobile-a", Some(2)).is_none());
    }

    #[test]
    fn restore_scan_runs_once_at_a_time_and_is_throttled() {
        let hub = handoff_hub();
        let start = Instant::now();
        assert!(hub.begin_restore_scan(start));
        // 上一轮没结束时，到了间隔也不并发。
        assert!(!hub.begin_restore_scan(start + RESTORE_SCAN_INTERVAL));
        hub.finish_restore_scan(true, vec!["conn-a".into()]);
        assert!(!hub.begin_restore_scan(start + Duration::from_secs(1)));
        assert!(hub.begin_restore_scan(start + RESTORE_SCAN_INTERVAL));
        assert!(hub.restore_connect_requested());
        assert!(hub.restore_finished("conn-a"));
        assert!(!hub.restore_finished("conn-b"));
    }

    #[test]
    fn restore_scan_stays_off_while_the_listener_is_stopped() {
        let hub = handoff_hub();
        hub.inner.lock().unwrap().accepting = false;
        assert!(!hub.begin_restore_scan(Instant::now()));
    }

    #[test]
    fn phones_without_a_lease_keep_using_phone_sessions() {
        let hub = handoff_hub();
        ready_session(&hub, "mobile-a", "phone");
        hub.claim("mobile-a", "tablet", true).unwrap();
        assert!(hub.authorize("mobile-a", None).is_ok());
        assert!(hub
            .inner
            .lock()
            .unwrap()
            .takeover_reply("mobile-a", None)
            .is_none());
    }

    #[test]
    fn mirrors_never_reach_paths_that_end_processes() {
        let hub = handoff_hub();
        hub.seed_mirror("term-1".into(), project(), "phone", None, 80, 24, "x")
            .unwrap();
        ready_session(&hub, "mobile-a", "phone");
        assert!(!hub
            .take_idle_sessions(Duration::ZERO)
            .iter()
            .any(|(id, _)| id == "term-1"));
        assert!(!hub
            .forget_device("phone")
            .iter()
            .any(|(id, _)| id == "term-1"));
        assert!(!hub
            .take_live_sessions()
            .iter()
            .any(|(id, _)| id == "term-1"));
        assert_eq!(hub.release_mirrors(None), vec!["term-1".to_string()]);
    }

    #[test]
    fn desktop_takeback_stops_the_mirror_and_tells_the_phone_who_took_it() {
        let hub = handoff_hub();
        hub.seed_mirror("term-1".into(), project(), "phone", None, 80, 24, "x")
            .unwrap();
        let lease = hub.claim("term-1", "phone", true).unwrap()["lease"].as_u64();
        assert!(hub.authorize("term-1", lease).is_ok());
        assert!(hub.authorize("term-1", None).is_err());
        hub.take_for_desktop("term-1").unwrap();
        assert_eq!(hub.authorize("term-1", lease).unwrap_err(), TAKEN_OVER);
        assert!(!hub.mirror_active("term-1"));
        hub.mirror_push("term-1", OutputChunk::Bytes("eA==".into()));
        let inner = hub.inner.lock().unwrap();
        assert_eq!(inner.mirrors["term-1"].next, 0);
        assert_eq!(
            inner.takeover_reply("term-1", lease).unwrap()["by"],
            DESKTOP_NAME
        );
    }

    #[test]
    fn reseeded_mirror_never_reuses_an_old_lease() {
        let hub = handoff_hub();
        hub.seed_mirror("term-1".into(), project(), "phone", None, 80, 24, "x")
            .unwrap();
        let old = hub.claim("term-1", "phone", true).unwrap()["lease"].as_u64();
        hub.take_for_desktop("term-1").unwrap();
        hub.seed_mirror("term-1".into(), project(), "tablet", None, 80, 24, "y")
            .unwrap();
        let new = hub.claim("term-1", "tablet", true).unwrap()["lease"].as_u64();
        assert!(new > old);
        assert!(hub.authorize("term-1", old).is_err());
    }

    #[test]
    fn mirrors_need_the_feature_enabled() {
        let hub = accepting_hub(vec![device("phone")]);
        let error = hub
            .seed_mirror("term-1".into(), project(), "phone", None, 80, 24, "x")
            .unwrap_err();
        assert!(error.contains("未开启"));
    }

    #[test]
    fn desktop_view_starts_with_a_snapshot_then_streams_and_falls_back_when_backlogged() {
        let hub = handoff_hub();
        ready_session(&hub, "mobile-a", "phone");
        hub.open_view("mobile-a").unwrap();
        assert!(matches!(
            hub.take_view_output("mobile-a"),
            Some((ViewOutput::Screen(_), None))
        ));
        hub.with_session("mobile-a", |session| {
            session.push(OutputChunk::Bytes("aGk=".into()));
        });
        match hub.take_view_output("mobile-a") {
            Some((ViewOutput::Bytes(bytes), None)) => assert_eq!(bytes, b"hi"),
            _ => panic!("expected incremental output"),
        }
        let huge =
            base64::engine::general_purpose::STANDARD.encode(vec![b'x'; MAX_VIEW_BACKLOG + 1]);
        hub.with_session("mobile-a", |session| session.push(OutputChunk::Bytes(huge)));
        assert!(matches!(
            hub.take_view_output("mobile-a"),
            Some((ViewOutput::Screen(_), None))
        ));
    }

    #[test]
    fn only_the_desktop_controller_may_type_into_a_viewed_phone_session() {
        let hub = handoff_hub();
        ready_session(&hub, "mobile-a", "phone");
        assert_eq!(hub.desktop_controls("mobile-a").unwrap_err(), TAKEN_OVER);
        hub.take_for_desktop("mobile-a").unwrap();
        assert!(hub.desktop_controls("mobile-a").is_ok());
        assert_eq!(
            hub.claim("mobile-a", "phone", false).unwrap()["by"],
            DESKTOP_NAME
        );
    }

    #[test]
    fn saved_settings_default_desktop_terminals_off() {
        let mut value = serde_json::to_value(settings(Vec::new())).unwrap();
        value.as_object_mut().unwrap().remove("desktop_terminals");
        let loaded: SavedSettings = serde_json::from_value(value).unwrap();
        assert!(!loaded.desktop_terminals);
    }

    #[test]
    fn desktop_entry_points_reject_mobile_terminals() {
        assert!(reject_desktop_use("mobile-abc").is_err());
        assert!(reject_desktop_use("term-1").is_ok());
    }

    #[test]
    fn desktop_summaries_list_every_project_with_device_and_skip_unready() {
        let hub = accepting_hub(Vec::new());
        let token = hub.pair(PEER, CODE, Some("Pixel"), |_| Ok(())).unwrap();
        let owner = hub.authenticate(Some(&token)).unwrap();
        {
            let mut inner = hub.inner.lock().unwrap();
            let mut other = project();
            other.id = "q".into();
            other.name = "a-first".into();
            for (id, project, ready) in [
                ("mobile-b", project(), true),
                ("mobile-a", other, true),
                ("mobile-starting", project(), false),
            ] {
                let mut session = Session::new(project, owner.clone(), 1);
                session.ready = ready;
                inner.sessions.insert(id.into(), session);
            }
        }
        let list = hub.session_summaries(None);
        let ids: Vec<_> = list
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["mobile-a", "mobile-b"]);
        assert_eq!(list[0]["project"]["id"], "q");
        assert_eq!(list[0]["deviceName"], "Pixel");
        assert!(list[0].get("ownDevice").is_none());
        let phone = hub.session_summaries(Some(&owner));
        assert_eq!(phone.len(), 2);
        assert_eq!(phone[0]["ownDevice"], true);
        assert_eq!(
            hub.session_summaries(Some("other-device"))[0]["ownDevice"],
            false
        );
        assert!(hub.session_preview("mobile-starting").is_err());
    }

    #[test]
    fn desktop_preview_is_plain_text_of_history_and_screen() {
        let hub = accepting_hub(Vec::new());
        {
            let mut inner = hub.inner.lock().unwrap();
            let mut session = Session::new(project(), "owner".into(), 1);
            session.ready = true;
            session.screen.resize(20, 2);
            session
                .screen
                .process(b"\x1b[31mone\x1b[0m\r\ntwo\r\nthree");
            inner.sessions.insert("mobile-a".into(), session);
        }
        let preview = hub.session_preview("mobile-a").unwrap();
        assert_eq!(preview["history"], json!(["one"]));
        assert_eq!(preview["screen"], "two\nthree");
        assert_eq!(preview["alternate"], false);
        assert!(hub.rename_session("mobile-a", "构建").is_ok());
        assert_eq!(hub.session_preview("mobile-a").unwrap()["name"], "构建");
    }

    #[test]
    fn preview_notification_is_scheduled_once_until_sent() {
        let hub = accepting_hub(Vec::new());
        hub.inner.lock().unwrap().sessions.insert(
            "mobile-a".into(),
            Session::new(project(), "owner".into(), 1),
        );
        let write = |session: &mut Session| session.push(OutputChunk::Bytes("aGk=".into()));

        assert!(hub.update_for_preview("mobile-a", write));
        assert!(!hub.update_for_preview("mobile-a", write));
        hub.with_session("mobile-a", |session| {
            session.preview_notify_pending = false;
        });
        assert!(hub.update_for_preview("mobile-a", write));
        assert!(!hub.update_for_preview("mobile-missing", write));
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
    fn tail_poll_skips_a_redraw_burst_larger_than_one_page() {
        let mut session = Session::new(project(), "phone".into(), 1);
        session.screen.resize(40, 4);
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(b"prompt"),
        ));
        let caught_up = session.next;
        assert!(!session.should_send_latest(caught_up));
        // 小量新输出照常逐字节回放。
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(b"small"),
        ));
        assert!(!session.should_send_latest(caught_up));
        // 模拟全屏程序瞬间重绘大量中间帧：积压超过一次轮询上限即改发最新画面。
        let frame = "\x1b[H".to_string() + &"x".repeat(4096);
        for index in 0..64 {
            session.push(OutputChunk::Bytes(
                base64::engine::general_purpose::STANDARD.encode(format!("{frame}{index}")),
            ));
        }
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(b"\x1b[2J\x1b[HFINAL FRAME"),
        ));
        assert!(session.should_send_latest(caught_up));
        let latest = session.latest();
        assert_eq!(latest["next"], session.next);
        assert!(latest["chunks"][0]["data"]
            .as_str()
            .unwrap()
            .contains("FINAL FRAME"));
        // 游标越界（已淘汰或来自未来）仍改发最新画面；已追平则不需要。
        assert!(session.should_send_latest(session.next + 1));
        assert!(!session.should_send_latest(session.next));
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

    fn ssh_session(hub: &Hub, id: &str, number: u64) {
        let mut session = Session::new(
            Project {
                kind: ProjectKind::Ssh,
                ..project()
            },
            "phone".into(),
            number,
        );
        session.ready = true;
        hub.inner
            .lock()
            .unwrap()
            .sessions
            .insert(id.into(), session);
    }

    fn push_title(hub: &Hub, id: &str, title: &str) {
        hub.with_session(id, |session| {
            session.push(OutputChunk::Bytes(
                base64::engine::general_purpose::STANDARD.encode(format!("\x1b]2;{title}\x07")),
            ))
        });
    }

    /// 模拟电脑重启：快照经 JSON 落盘，新进程载入后接回同一个 id。
    fn restart_hub(previous: &Hub) -> Hub {
        let file = serde_json::to_vec(&previous.session_names_snapshot()).unwrap();
        let hub = accepting_hub(vec![device("phone")]);
        hub.load_session_names(serde_json::from_slice(&file).unwrap(), unix_now_ms());
        hub
    }

    fn reserve_restored(hub: &Hub, id: &str) {
        let project = Project {
            kind: ProjectKind::Ssh,
            ..project()
        };
        hub.reserve_session(id.into(), project, "phone", None)
            .unwrap();
        hub.restore_session_name(id);
    }

    #[test]
    fn restored_session_keeps_manual_name_and_identity_after_restart() {
        let before = accepting_hub(vec![device("phone")]);
        ssh_session(&before, "mobile-a", 5);
        before.rename_session("mobile-a", "修复登录").unwrap();
        let created_at = before.inner.lock().unwrap().sessions["mobile-a"].created_at_ms;

        let hub = restart_hub(&before);
        reserve_restored(&hub, "mobile-a");
        let inner = hub.inner.lock().unwrap();
        let session = &inner.sessions["mobile-a"];
        assert_eq!(session.name(), "修复登录");
        assert_eq!(session.custom_name.as_deref(), Some("修复登录"));
        assert_eq!(session.number, 5);
        assert_eq!(session.created_at_ms, created_at);
    }

    #[test]
    fn restored_session_shows_last_program_title_until_a_new_one_arrives() {
        let before = accepting_hub(vec![device("phone")]);
        ssh_session(&before, "mobile-a", 1);
        push_title(&before, "mobile-a", "✳ Claude Code");

        let hub = restart_hub(&before);
        reserve_restored(&hub, "mobile-a");
        hub.with_session("mobile-a", |session| {
            // daemon 的屏幕快照不带标题。
            session.push(OutputChunk::Screen {
                data: "prompt".into(),
                cols: 80,
                rows: 24,
            });
            assert_eq!(session.name(), "Claude Code");
        });
        push_title(&hub, "mobile-a", "OpenCode");
        hub.with_session("mobile-a", |session| assert_eq!(session.name(), "OpenCode"));
    }

    #[test]
    fn restored_label_is_kept_when_the_program_has_no_title() {
        let before = accepting_hub(vec![device("phone")]);
        ssh_session(&before, "mobile-a", 2);
        before
            .inner
            .lock()
            .unwrap()
            .sessions
            .get_mut("mobile-a")
            .unwrap()
            .label = Some("Claude".into());

        let hub = restart_hub(&before);
        reserve_restored(&hub, "mobile-a");
        assert_eq!(
            hub.inner.lock().unwrap().sessions["mobile-a"].name(),
            "Claude"
        );
    }

    #[test]
    fn restored_name_outranks_revisions_the_phone_kept_from_before_restart() {
        let hub = accepting_hub(vec![device("phone")]);
        reserve_restored(&hub, "mobile-a");
        let revision = hub.inner.lock().unwrap().sessions["mobile-a"].name_revision;
        assert!(revision > 1_000_000_000_000);
    }

    #[test]
    fn new_sessions_are_numbered_after_terminals_waiting_for_restore() {
        let before = accepting_hub(vec![device("phone")]);
        ssh_session(&before, "mobile-a", 9);
        let hub = restart_hub(&before);
        ready_session(&hub, "mobile-b", "phone");
        assert_eq!(hub.inner.lock().unwrap().sessions["mobile-b"].number, 10);
    }

    #[test]
    fn spinner_frames_do_not_change_saved_names() {
        let hub = accepting_hub(vec![device("phone")]);
        ssh_session(&hub, "mobile-a", 1);
        push_title(&hub, "mobile-a", "⠋ 正在构建");
        let first = hub.session_names_snapshot();
        push_title(&hub, "mobile-a", "⠙ 正在构建");
        assert_eq!(hub.session_names_snapshot(), first);
        assert_eq!(first["mobile-a"].title.as_deref(), Some("正在构建"));
    }

    #[test]
    fn only_sessions_that_can_be_reattached_are_saved() {
        let hub = accepting_hub(vec![device("phone")]);
        ready_session(&hub, "mobile-local", "phone");
        ssh_session(&hub, "mobile-exited", 1);
        ssh_session(&hub, "mobile-lost", 2);
        for (id, disconnected) in [("mobile-exited", false), ("mobile-lost", true)] {
            hub.with_session(id, |session| {
                session.finish(Exit {
                    exit_code: 0,
                    disconnected,
                })
            });
        }
        let names = hub.session_names_snapshot();
        assert_eq!(names.keys().collect::<Vec<_>>(), vec!["mobile-lost"]);
    }

    #[test]
    fn saved_name_survives_failed_restore_until_attach_succeeds() {
        let before = accepting_hub(vec![device("phone")]);
        ssh_session(&before, "mobile-a", 3);
        before.rename_session("mobile-a", "构建").unwrap();
        let hub = restart_hub(&before);

        reserve_restored(&hub, "mobile-a");
        assert!(!hub.finish_create("mobile-a", false));
        assert_eq!(
            hub.session_names_snapshot()["mobile-a"]
                .custom_name
                .as_deref(),
            Some("构建")
        );

        reserve_restored(&hub, "mobile-a");
        assert!(hub.finish_create("mobile-a", true));
        assert!(hub.inner.lock().unwrap().pending_names.is_empty());
        assert_eq!(
            hub.inner.lock().unwrap().sessions["mobile-a"].name(),
            "构建"
        );
    }

    #[test]
    fn ended_sessions_drop_their_saved_name() {
        let hub = accepting_hub(vec![device("phone")]);
        ssh_session(&hub, "mobile-a", 1);
        assert!(hub.session_names_snapshot().contains_key("mobile-a"));
        hub.inner.lock().unwrap().sessions.remove("mobile-a");
        assert!(hub.session_names_snapshot().is_empty());
    }

    #[test]
    fn saved_names_expire_and_keep_their_original_wait_start() {
        let now = unix_now_ms();
        let retention = SAVED_NAME_RETENTION.as_millis() as u64;
        let saved = |since: Option<u64>| SavedSessionName {
            detached_since_ms: since,
            ..SavedSessionName::default()
        };
        let hub = accepting_hub(vec![device("phone")]);
        hub.load_session_names(
            HashMap::from([
                ("expired".to_string(), saved(Some(now - retention))),
                ("waiting".to_string(), saved(Some(now - 1000))),
                ("fresh".to_string(), saved(None)),
            ]),
            now,
        );
        let names = hub.session_names_snapshot();
        assert!(!names.contains_key("expired"));
        assert_eq!(names["waiting"].detached_since_ms, Some(now - 1000));
        assert_eq!(names["fresh"].detached_since_ms, Some(now));
    }

    #[test]
    fn stable_title_strips_animation_and_keeps_plain_titles() {
        assert_eq!(stable_title("⠋ 构建").as_deref(), Some("构建"));
        assert_eq!(
            stable_title("✳ Claude Code").as_deref(),
            Some("Claude Code")
        );
        assert_eq!(stable_title("OpenCode").as_deref(), Some("OpenCode"));
        assert_eq!(stable_title("\u{2800}"), None);
    }

    #[test]
    fn spinner_frames_are_known_glyphs_or_leading_symbol_changes() {
        assert!(is_spinner_frame(None, Some("⠋ 构建")));
        assert!(is_spinner_frame(Some("⠋ 构建"), Some("\u{2800} 构建")));
        assert!(is_spinner_frame(
            Some("◐ Claude Code"),
            Some("◓ Claude Code")
        ));
        assert!(is_spinner_frame(Some("| build"), Some("/ build")));
        assert!(!is_spinner_frame(None, Some("Claude Code")));
        assert!(!is_spinner_frame(Some("Claude"), Some("OpenCode")));
        assert!(!is_spinner_frame(Some("✳ Claude Code"), Some("✳ 修复登录")));
        assert!(!is_spinner_frame(Some("[1] build"), Some("[2] build")));
        assert!(!is_spinner_frame(Some("/tmp/build"), Some("\\tmp/build")));
        assert!(!is_spinner_frame(Some("!task"), Some("?task")));
        assert!(!is_spinner_frame(Some("⠋ 构建"), None));
    }

    #[test]
    fn attention_reports_busy_exit_and_bells_without_terminal_content() {
        let mut session = Session::new(project(), "phone".into(), 1);
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode("secret output"),
        ));
        let value = session.attention("mobile-1");
        assert_eq!(value["id"], "mobile-1");
        assert_eq!(value["project"], session.project.id);
        assert_eq!(value["busy"], false);
        assert_eq!(value["exited"], false);
        assert_eq!(value["bells"], 1);
        assert!(!value.to_string().contains("secret output"));
    }

    #[test]
    fn program_busy_holds_across_gaps_between_spinner_frames() {
        let mut session = Session::new(project(), "phone".into(), 1);
        let push_title = |session: &mut Session, title: &str| {
            session.push(OutputChunk::Bytes(
                base64::engine::general_purpose::STANDARD.encode(format!("\x1b]2;{title}\x07")),
            ));
        };
        push_title(&mut session, "✳ Claude Code");
        assert!(!session.program_busy());
        assert_eq!(session.metadata("mobile-1")["programBusy"], false);
        push_title(&mut session, "⠂ Claude Code");
        push_title(&mut session, "⠐ Claude Code");
        // 转圈中途短暂换回普通标题，状态不翻转；原始标题与名称原样保留。
        push_title(&mut session, "✳ Claude Code");
        assert!(session.program_busy());
        assert_eq!(session.read(session.next)["programBusy"], true);
        assert_eq!(session.latest()["programTitle"], "✳ Claude Code");
        assert_eq!(session.name(), "✳ Claude Code");
        let frame = session.last_spinner_frame.unwrap();
        assert!(session.program_busy_at(frame + SPINNER_HOLD - Duration::from_millis(1)));
        assert!(!session.program_busy_at(frame + SPINNER_HOLD));
        session.finish(Exit {
            exit_code: 0,
            disconnected: false,
        });
        assert!(!session.program_busy());
    }

    #[test]
    fn program_report_overrides_heuristics_until_submit_or_snapshot() {
        let encode =
            |text: &str| OutputChunk::Bytes(base64::engine::general_purpose::STANDARD.encode(text));
        let mut session = Session::new(project(), "phone".into(), 1);
        session.push(encode(
            "\x1b]2;⠼ 构建\x07\x1b]7501;state=done:app=codex\x1b\\",
        ));
        assert!(!session.program_busy());
        assert!(!session.display_busy());

        // 上报空闲时持续输出也不算运行中；回车提交后回到输出判定。
        let start = Instant::now();
        session.note_output_at(start);
        session.note_output_at(start + OUTPUT_STREAK);
        assert!(!session.output_busy_at(start + OUTPUT_STREAK));
        session.note_user_input("x");
        assert!(!session.output_busy_at(start + OUTPUT_STREAK));
        session.note_user_input("build\r");
        assert!(session.output_busy_at(start + OUTPUT_STREAK));

        session.push(encode(
            "\x1b]2;构建\x07\x1b]7501;state=working:app=codex\x1b\\",
        ));
        assert!(session.program_busy_at(Instant::now() + SPINNER_HOLD * 100));
        session.finish(Exit {
            exit_code: 0,
            disconnected: false,
        });
        assert!(!session.program_busy());
    }

    #[test]
    fn screen_snapshot_releases_a_spinner_title_that_will_never_finish() {
        let mut session = Session::new(project(), "phone".into(), 1);
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode("\x1b]2;⠼ 构建\x07"),
        ));
        let frame = session.last_spinner_frame.unwrap();
        assert!(session.program_busy_at(frame + SPINNER_HOLD * 4));
        session.push(OutputChunk::Screen {
            data: "\x1b[Hdone".into(),
            cols: 80,
            rows: 24,
        });
        assert!(!session.program_busy_at(frame + SPINNER_HOLD * 4));
        assert_eq!(session.name(), "构建");
    }

    #[test]
    fn output_busy_needs_a_sustained_streak_and_ignores_echo() {
        let mut session = Session::new(project(), "phone".into(), 1);
        let start = Instant::now();
        let step = Duration::from_millis(200);
        // 短促输出（如提示符重绘）不算运行中。
        session.note_output_at(start);
        session.note_output_at(start + step);
        assert!(!session.output_busy_at(start + step));
        // 持续输出满 OUTPUT_STREAK 才算，并保持 SPINNER_HOLD。
        let last = start + OUTPUT_STREAK;
        session.note_output_at(last);
        assert!(session.output_busy_at(last));
        assert!(session.output_busy_at(last + SPINNER_HOLD - Duration::from_millis(1)));
        assert!(!session.output_busy_at(last + SPINNER_HOLD));
        // 后台提醒用的 program_busy 不受输出影响。
        assert!(!session.program_busy_at(last));

        // 紧跟输入的回显不计。
        let mut echo = Session::new(project(), "phone".into(), 2);
        echo.note_input();
        let typed = echo.last_input.unwrap();
        echo.note_output_at(typed + step);
        assert!(echo.last_output.is_none());
        echo.note_output_at(typed + OUTPUT_QUIET_AFTER_INPUT);
        assert!(echo.last_output.is_some());

        session.finish(Exit {
            exit_code: 0,
            disconnected: false,
        });
        assert!(!session.output_busy_at(last));
    }

    #[test]
    fn program_busy_keeps_current_spinner_but_stops_for_exit() {
        let mut session = Session::new(project(), "phone".into(), 1);
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode("\x1b]2;\u{2800} 构建\x07"),
        ));
        let frame = session.last_spinner_frame.unwrap();
        assert!(session.program_busy_at(frame + SPINNER_HOLD * 4));
        assert_eq!(session.metadata("mobile-1")["name"], "\u{2800} 构建");
        session.finish(Exit {
            exit_code: 0,
            disconnected: false,
        });
        assert!(!session.program_busy_at(frame + SPINNER_HOLD));
    }

    #[test]
    fn program_busy_observes_intermediate_titles_in_one_output_chunk() {
        for terminator in ["\x07", "\x1b\\"] {
            let mut session = Session::new(project(), "phone".into(), 1);
            session.push(OutputChunk::Bytes(
                base64::engine::general_purpose::STANDARD.encode(format!(
                    "\x1b]2;⠋ 构建{terminator}\x1b]2;✳ Claude Code{terminator}"
                )),
            ));
            assert!(session.program_busy());
            assert_eq!(session.name(), "✳ Claude Code");
            assert_eq!(session.latest()["programTitle"], "✳ Claude Code");
            assert_eq!(session.name_revision, 2);
            let frame = session.last_spinner_frame.unwrap();
            assert!(!session.program_busy_at(frame + SPINNER_HOLD));
        }
    }

    #[test]
    fn program_busy_handles_osc_and_unicode_split_across_chunks() {
        let output = "\x1b]2;⠋ 构建\x1b\\\x1b]2;✳ Claude Code\x07".as_bytes();
        for split in 1..output.len() {
            let mut session = Session::new(project(), "phone".into(), 1);
            for data in [&output[..split], &output[split..]] {
                session.push(OutputChunk::Bytes(
                    base64::engine::general_purpose::STANDARD.encode(data),
                ));
            }
            assert!(session.program_busy());
            assert_eq!(session.name(), "✳ Claude Code");
            assert_eq!(session.name_revision, 2);
        }
    }

    #[test]
    fn activity_revisions_order_responses_without_changing_original_titles() {
        let mut session = Session::new(project(), "phone".into(), 1);
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode("\x1b]2;◐ 原始标题\x07"),
        ));
        session.rename("我的终端").unwrap();
        let responses = [
            session.metadata("mobile-1"),
            session.read(0),
            session.latest(),
        ];
        for (index, response) in responses.iter().enumerate() {
            assert_eq!(response["activityRevision"], index as u64);
            assert_eq!(response["name"], "我的终端");
            assert_eq!(response["programTitle"], "◐ 原始标题");
            assert_eq!(response["programBusy"], true);
        }
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
    fn session_metadata_keeps_created_at_after_activity() {
        let mut session = Session::new(project(), "phone".into(), 1);
        let created = session.metadata("mobile-1")["createdAt"].as_u64().unwrap();
        assert_eq!(created, session.last_active_ms);
        session.last_active_ms += 60_000;
        let meta = session.metadata("mobile-1");
        assert_eq!(meta["createdAt"].as_u64().unwrap(), created);
        assert!(meta["lastActiveAt"].as_u64().unwrap() > created);
    }

    #[test]
    fn device_names_are_trimmed_and_defaulted() {
        assert_eq!(device_name(None), "Android 设备");
        assert_eq!(device_name(Some("  ")), "Android 设备");
        assert_eq!(device_name(Some(&"x".repeat(80))).len(), MAX_DEVICE_NAME);
    }
}
