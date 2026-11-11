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
mod hub;
mod launch;
mod network;
mod operate;
mod session;
mod settings;
mod tauri_commands;
pub(crate) use hub::*;
use launch::*;
use network::*;
use operate::*;
use session::*;
use settings::*;
pub use tauri_commands::*;

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
/// 空闲时改尺寸引发的重绘段：块间隔不超过这么久视为同一段，整段不算工作。
/// 须与前端 REDRAW_GAP_MS 一致。
const REDRAW_GAP: Duration = Duration::from_millis(1000);
/// 重绘段最长持续时间，之后的输出照常计入。须与前端 REDRAW_MAX_MS 一致。
const REDRAW_MAX: Duration = Duration::from_millis(10_000);

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

#[cfg(test)]
mod tests;
