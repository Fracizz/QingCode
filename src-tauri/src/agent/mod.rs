//! 手机端聊天式 Agent：在电脑上以结构化协议运行 Claude Code、Codex 与 OpenCode。
//!
//! - 每个对话对应一个 Agent 子进程（stdio），由各家适配器把原生协议归并成统一条目；
//! - 对话内容保存在电脑端（仅当前用户可读），手机按修订号增量拉取；
//! - 进程退出或电脑重启后，再次发送消息会用 Agent 自己的会话 ID 恢复上下文；
//! - 各家的默认安全选项保存在电脑端，可在手机上修改；「完全访问」时不再向手机请求审批。
mod claude;

mod codex;
#[cfg(test)]
mod e2e;
mod opencode;
mod process;
mod thread;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::Notify;

pub use process::RemoteCommand;
use thread::{Status, Thread, ThreadData};

const MAX_THREADS: usize = 200;
const MAX_ATTACHMENTS: usize = 16;
const MAX_IMAGE: usize = 8 * 1024 * 1024;
const ATTACHMENT_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_PROMPT: usize = 64 * 1024;
const POLL_WAIT: Duration = Duration::from_secs(20);
/// 空闲（无输入也无 Agent 输出）超过该时长的 Agent 进程会被关闭，与手机终端一致；
/// 对话保留，下次发送时自动恢复会话。
pub const IDLE_SHUTDOWN: Duration = Duration::from_secs(24 * 60 * 60);
const SAVE_INTERVAL: Duration = Duration::from_secs(2);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as u64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Opencode,
}

impl Provider {
    const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Opencode];

    fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
            Provider::Opencode => "OpenCode",
        }
    }

    fn program(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Opencode => "opencode",
        }
    }

    fn safety(self) -> &'static [(&'static str, &'static str, &'static str)] {
        match self {
            Provider::Claude => claude::SAFETY,
            Provider::Codex => codex::SAFETY,
            Provider::Opencode => opencode::SAFETY,
        }
    }

    fn default_safety(self) -> &'static str {
        match self {
            Provider::Claude => claude::DEFAULT_SAFETY,
            Provider::Codex => codex::DEFAULT_SAFETY,
            Provider::Opencode => opencode::DEFAULT_SAFETY,
        }
    }

    /// 「完全访问」选项：不再向手机请求审批。
    fn full_access(self) -> &'static str {
        match self {
            Provider::Claude => "bypassPermissions",
            Provider::Codex | Provider::Opencode => "full",
        }
    }

    fn valid_safety(self, value: &str) -> bool {
        self.safety().iter().any(|(id, ..)| *id == value)
    }
}

/// 桌面端已信任的项目（由 Windows QingCode 主窗口确认）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProject {
    pub id: String,
    pub name: String,
    pub path: String,
    /// `local` / `wsl` / `ssh`
    pub kind: String,
    pub host: String,
}

impl AgentProject {
    /// Agent 进程看到的工作目录：本机为 Windows 路径，WSL 与 SSH 远端为 Linux 路径。
    fn agent_cwd(&self) -> String {
        if self.kind == "wsl" {
            if let Some(path) = crate::run_environment::parse_wsl_path(&self.path) {
                return path.path;
            }
        }
        if self.kind == "ssh" {
            if let Some(rest) = self.path.strip_prefix("ssh://") {
                return rest
                    .find('/')
                    .map_or_else(|| "/".into(), |index| rest[index..].to_string());
            }
        }
        crate::terminal::strip_windows_verbatim_prefix(&self.path).into_owned()
    }
}

#[derive(Clone)]
pub struct Image {
    pub mime: String,
    /// Base64（不含 data: 前缀）。
    pub data: String,
}

pub struct Prompt {
    pub text: String,
    pub images: Vec<Image>,
}

/// 适配器处理一条消息时的上下文：修改对话、排队写给 Agent 的行、上报额度。
pub struct Cx<'a> {
    pub thread: &'a mut Thread,
    pub out: Vec<String>,
    pub quota: Option<Value>,
}

impl<'a> Cx<'a> {
    pub fn new(thread: &'a mut Thread) -> Self {
        Self {
            thread,
            out: Vec::new(),
            quota: None,
        }
    }

    pub fn send(&mut self, message: Value) {
        self.out.push(message.to_string());
    }
}

pub trait Adapter: Send {
    fn launch(&self) -> process::Launch;
    /// 写入握手消息。
    fn start(&mut self, cx: &mut Cx);
    fn on_line(&mut self, message: Value, cx: &mut Cx);
    fn send(&mut self, prompt: Prompt, cx: &mut Cx) -> Result<(), String>;
    fn interrupt(&mut self, cx: &mut Cx) -> Result<(), String>;
    fn respond(
        &mut self,
        approval: &str,
        choice: &str,
        answers: &Value,
        cx: &mut Cx,
    ) -> Result<(), String>;
    /// 返回 `true` 表示需要重启进程才能生效（空闲时自动重启并恢复会话）。
    fn configure(&mut self, key: &str, value: &str, cx: &mut Cx) -> Result<bool, String>;
    fn refresh_usage(&mut self, _cx: &mut Cx) {}
    fn pending_requests(&self) -> usize;
}

fn make_adapter(data: &ThreadData) -> Box<dyn Adapter> {
    let cwd = data.project.agent_cwd();
    match data.provider {
        Provider::Codex => Box::new(codex::Codex::new(
            cwd,
            data.safety.clone(),
            data.model.clone(),
            data.effort.clone(),
            data.session.clone(),
        )),
        Provider::Claude => Box::new(claude::Claude::new(
            data.safety.clone(),
            data.model.clone(),
            data.effort.clone(),
            data.session.clone(),
        )),
        Provider::Opencode => Box::new(opencode::Opencode::new(
            cwd,
            data.safety.clone(),
            data.model.clone(),
            data.effort.clone(),
            data.mode.clone(),
            data.session.clone(),
        )),
    }
}

// ---------- 适配器共用的小工具 ----------

pub fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

pub fn set_option(thread: &mut Thread, key: &str, value: Value) {
    if !thread.options.is_object() {
        thread.options = json!({});
    }
    thread.options[key] = value;
    thread.bump();
}

/// 修改工具卡片（`item.tool`）。
pub fn tool(thread: &mut Thread, id: &str, change: impl FnOnce(&mut Map<String, Value>)) {
    thread.upsert(id, "tool", |item| {
        let tool = item.entry("tool").or_insert_with(|| json!({}));
        if let Some(tool) = tool.as_object_mut() {
            change(tool);
        }
    });
}

pub fn append_output(thread: &mut Thread, id: &str, delta: &str) {
    tool(thread, id, |tool| {
        let mut output = tool
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        output.push_str(delta);
        tool.insert(
            "output".into(),
            json!(thread::clip_tail(&output, thread::MAX_TOOL_OUTPUT)),
        );
    });
}

/// MCP / 工具结果里的文本内容。
pub fn content_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(content_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                text.to_string()
            } else if let Some(content) = map.get("content") {
                content_text(content)
            } else {
                compact_json(Some(value))
            }
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub fn compact_json(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => thread::clip_head(&value.to_string(), 400),
    }
}

/// JSON-RPC 请求 id → 条目 id 片段。
pub fn rpc_key(id: &Value) -> String {
    match id {
        Value::String(text) => text
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
            .collect(),
        other => other.to_string(),
    }
}

pub fn approval_item(
    thread: &mut Thread,
    id: &str,
    kind: &str,
    title: &str,
    detail: &str,
    options: Value,
    questions: Option<Value>,
) {
    thread.upsert(id, "approval", |item| {
        let mut approval = json!({
            "type": kind,
            "title": title,
            "detail": detail,
            "options": options,
            "state": "pending",
        });
        if let Some(questions) = questions {
            approval["questions"] = questions;
        }
        item.insert("approval".into(), approval);
    });
}

pub fn approval_resolved(thread: &mut Thread, id: &str, choice: &str, answers: &Value) {
    thread.upsert(id, "approval", |item| {
        if let Some(approval) = item.get_mut("approval").and_then(Value::as_object_mut) {
            approval.insert("state".into(), json!("resolved"));
            approval.insert("choice".into(), json!(choice));
            if !answers.is_null() {
                approval.insert("answers".into(), answers.clone());
            }
        }
    });
}

// ---------- 宿主 ----------

struct Runtime {
    adapter: Box<dyn Adapter>,
    process: process::Process,
    generation: u64,
}

struct Core {
    thread: Thread,
    runtime: Option<Runtime>,
    generation: u64,
    last_active: Instant,
    /// 最近活动的墙上时间（毫秒），用于手机显示空闲时长与自动结束时间。
    last_active_ms: u64,
    /// 设置需要重启进程，当前轮结束后关闭。
    restart: bool,
}

impl Core {
    fn touch(&mut self) {
        self.last_active = Instant::now();
        self.last_active_ms = now_ms();
    }

    /// 对话元数据，进程在线时附带空闲信息。
    fn metadata(&self) -> Value {
        let mut meta = self.thread.metadata(self.runtime.is_some());
        if self.runtime.is_some() {
            meta["lastActiveAt"] = json!(self.last_active_ms);
            meta["idleDeadline"] = json!(self.last_active_ms + IDLE_SHUTDOWN.as_millis() as u64);
        }
        meta
    }
}

struct Slot {
    core: Mutex<Core>,
    changed: Arc<Notify>,
}

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    defaults: HashMap<Provider, ProviderDefaults>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDefaults {
    #[serde(default)]
    safety: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

/// 远端 Agent 终端 id 前缀；带 `mobile-` 前缀，使远端终端输出回调到移动端模块。
pub const TERMINAL_PREFIX: &str = "mobile-agent-";

/// 在 SSH 远端启动 Agent 并按序执行写入 / 结束命令（由 `mobile.rs` 提供，需要 AppHandle）。
pub trait RemoteLauncher: Send + Sync {
    fn launch(
        &self,
        terminal: String,
        project: AgentProject,
        script: String,
        commands: tokio::sync::mpsc::UnboundedReceiver<process::RemoteCommand>,
        ready: tokio::sync::oneshot::Receiver<()>,
    );
}

struct RemoteStream {
    slot: Arc<Slot>,
    generation: u64,
    buffer: process::LineBuffer,
    /// 远端关闭回显后通知启动器开始写入。
    ready: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Default)]
struct Shared {
    threads: Mutex<HashMap<String, Arc<Slot>>>,
    remote_launcher: OnceLock<Arc<dyn RemoteLauncher>>,
    /// 远端终端 id → 对话，用于分发远端输出。
    remote_streams: Mutex<HashMap<String, RemoteStream>>,
    quotas: Mutex<HashMap<Provider, Value>>,
    settings: Mutex<Option<Settings>>,
    attachments: Mutex<HashMap<String, (Image, Instant)>>,
    started: OnceLock<()>,
    /// 测试时为 `None`，不写盘。
    directory: Mutex<Option<PathBuf>>,
}

#[derive(Default, Clone)]
pub struct AgentHost {
    shared: Arc<Shared>,
}

fn store_dir() -> PathBuf {
    crate::app_paths::app_data_dir()
        .join("mobile")
        .join("agents")
}

fn write_private(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        qingcode_server::direct::protect_private_directory(parent)?;
    }
    qingcode_server::direct::private_write(path, content)
}

impl Shared {
    fn store_quota(&self, provider: Provider, mut quota: Value) {
        if !quota.is_object() {
            return;
        }
        quota["updatedAt"] = json!(now_ms());
        self.quotas.lock().unwrap().insert(provider, quota);
    }

    fn directory(&self) -> Option<PathBuf> {
        self.directory.lock().unwrap().clone()
    }

    fn save(&self, data: &ThreadData) {
        let Some(directory) = self.directory() else {
            return;
        };
        let path = directory.join("threads").join(format!("{}.json", data.id));
        match serde_json::to_vec(data) {
            Ok(content) => {
                if let Err(error) = write_private(&path, &content) {
                    eprintln!("[WARN] 保存手机对话失败：{error}");
                }
            }
            Err(error) => eprintln!("[WARN] 序列化手机对话失败：{error}"),
        }
    }
}

/// 把适配器排队的输出写给进程，处理额度更新与写入失败。
fn drive<R>(
    shared: &Shared,
    core: &mut Core,
    action: impl FnOnce(&mut dyn Adapter, &mut Cx) -> R,
) -> Option<R> {
    let Core {
        thread, runtime, ..
    } = core;
    let runtime_ref = runtime.as_mut()?;
    let provider = thread.data.provider;
    let mut cx = Cx::new(thread);
    let result = action(runtime_ref.adapter.as_mut(), &mut cx);
    let Cx { out, quota, .. } = cx;
    let mut failure = None;
    for line in out {
        if let Err(error) = runtime_ref.process.write_line(&line) {
            failure = Some(error);
            break;
        }
    }
    if let Some(quota) = quota {
        shared.store_quota(provider, quota);
    }
    if let Some(error) = failure {
        if let Some(runtime) = runtime.take() {
            runtime.process.shutdown();
        }
        thread.settle("expired");
        thread.fail(error);
    }
    Some(result)
}

fn stop_runtime(core: &mut Core, status: Status) {
    if let Some(runtime) = core.runtime.take() {
        runtime.process.shutdown();
    }
    core.restart = false;
    core.thread.settle("expired");
    if core.thread.status != Status::Error || status == Status::Closed {
        core.thread.set_status(status);
    }
}

/// 处理 Agent 输出的一行 JSON。
fn handle_line(shared: &Shared, slot: &Slot, generation: u64, line: &str) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let mut core = slot.core.lock().unwrap();
    if core.runtime.as_ref().map(|runtime| runtime.generation) != Some(generation) {
        return;
    }
    core.touch();
    drive(shared, &mut core, |adapter, cx| {
        adapter.on_line(message, cx)
    });
    if core.restart && core.thread.status == Status::Idle {
        stop_runtime(&mut core, Status::Closed);
    }
    drop(core);
    slot.changed.notify_waiters();
}

/// Agent 进程（或远端终端）结束。`reason` 为错误输出末尾或断开原因。
fn handle_exit(slot: &Slot, generation: u64, reason: String) {
    let mut core = slot.core.lock().unwrap();
    if core.runtime.as_ref().map(|runtime| runtime.generation) == Some(generation) {
        core.runtime = None;
        let unexpected = matches!(core.thread.status, Status::Starting | Status::Running);
        core.thread.settle("expired");
        if unexpected {
            let reason = if reason.is_empty() {
                "无错误输出".to_string()
            } else {
                reason
            };
            core.thread.fail(format!("Agent 进程意外退出：{reason}"));
        } else if core.thread.status != Status::Error {
            core.thread.set_status(Status::Closed);
        }
    }
    drop(core);
    slot.changed.notify_waiters();
}

fn start_runtime(shared: &Arc<Shared>, slot: &Arc<Slot>, core: &mut Core) -> Result<(), String> {
    if core.runtime.is_some() {
        return Ok(());
    }
    let adapter = make_adapter(&core.thread.data);
    let launch = adapter.launch();
    let project = core.thread.data.project.clone();
    let generation = core.generation + 1;
    let (process, pipes) = if project.kind == "ssh" {
        let launcher = shared
            .remote_launcher
            .get()
            .cloned()
            .ok_or("远端对话不可用。")?;
        let terminal = format!("{TERMINAL_PREFIX}{}", uuid::Uuid::new_v4().simple());
        let (remote, commands) = process::RemoteProcess::new();
        let (ready, ready_receiver) = tokio::sync::oneshot::channel();
        shared.remote_streams.lock().unwrap().insert(
            terminal.clone(),
            RemoteStream {
                slot: slot.clone(),
                generation,
                buffer: process::LineBuffer::default(),
                ready: Some(ready),
            },
        );
        launcher.launch(
            terminal,
            project,
            process::remote_script(&launch),
            commands,
            ready_receiver,
        );
        (process::Process::Remote(remote), None)
    } else {
        let (process, pipes) = process::spawn(&project, &launch)?;
        (process, Some(pipes))
    };
    core.generation = generation;
    core.runtime = Some(Runtime {
        adapter,
        process,
        generation,
    });
    core.touch();
    core.thread.error = None;
    core.thread.set_status(Status::Starting);
    drive(shared, core, |adapter, cx| adapter.start(cx));

    let Some(pipes) = pipes else {
        return Ok(());
    };
    let stderr = std::thread::spawn(move || process::read_tail(pipes.stderr, 2048));
    let shared = shared.clone();
    let slot = slot.clone();
    let stdout = pipes.stdout;
    std::thread::spawn(move || {
        process::read_lines(stdout, |line| handle_line(&shared, &slot, generation, line));
        let tail = stderr.join().unwrap_or_default();
        handle_exit(&slot, generation, tail);
    });
    Ok(())
}

fn decode_image(data: &str) -> Result<Image, String> {
    if data.len() > MAX_IMAGE.div_ceil(3) * 4 {
        return Err("图片不能超过 8 MB。".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "图片编码无效。")?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else {
        return Err("仅支持 PNG / JPEG 图片。".into());
    };
    Ok(Image {
        mime: mime.into(),
        data: data.into(),
    })
}

fn safety_catalog(provider: Provider) -> Value {
    json!(provider
        .safety()
        .iter()
        .map(|(id, label, description)| json!({
            "id": id,
            "label": label,
            "description": description,
            "full": *id == provider.full_access(),
        }))
        .collect::<Vec<_>>())
}

impl AgentHost {
    #[cfg(test)]
    fn in_memory() -> Self {
        let host = Self::default();
        host.shared.started.get_or_init(|| {});
        *host.shared.settings.lock().unwrap() = Some(Settings::default());
        host
    }

    /// 由移动端模块注册 SSH 远端启动器（需要 AppHandle）。
    pub fn set_remote_launcher(&self, launcher: Arc<dyn RemoteLauncher>) {
        let _ = self.shared.remote_launcher.set(launcher);
    }

    /// 远端 Agent 终端输出（原始字节）。
    pub fn remote_data(&self, terminal: &str, data: &[u8]) {
        let (slot, generation, lines) = {
            let mut streams = self.shared.remote_streams.lock().unwrap();
            let Some(stream) = streams.get_mut(terminal) else {
                return;
            };
            let (became_ready, lines) = stream.buffer.push(data);
            if became_ready {
                if let Some(ready) = stream.ready.take() {
                    let _ = ready.send(());
                }
            }
            (stream.slot.clone(), stream.generation, lines)
        };
        for line in lines {
            handle_line(&self.shared, &slot, generation, &line);
        }
    }

    /// 远端终端重连时缓冲已淘汰，只能拿到屏幕快照：丢弃半行，提示可能缺失输出。
    pub fn remote_gap(&self, terminal: &str) {
        let slot = {
            let mut streams = self.shared.remote_streams.lock().unwrap();
            let Some(stream) = streams.get_mut(terminal) else {
                return;
            };
            stream.buffer.clear();
            stream.slot.clone()
        };
        slot.core.lock().unwrap().thread.notice(
            "warn",
            "远端连接中断期间部分输出未能接收，可能缺少中间过程。",
        );
        slot.changed.notify_waiters();
    }

    /// 远端 Agent 终端结束或启动失败。
    pub fn remote_exit(&self, terminal: &str, reason: Option<String>) {
        let Some(stream) = self.shared.remote_streams.lock().unwrap().remove(terminal) else {
            return;
        };
        handle_exit(&stream.slot, stream.generation, reason.unwrap_or_default());
    }

    /// 首次使用时加载磁盘上的对话并启动后台保存线程。
    fn ensure_started(&self) {
        let shared = self.shared.clone();
        self.shared.started.get_or_init(move || {
            let directory = store_dir();
            *shared.directory.lock().unwrap() = Some(directory.clone());
            let settings = qingcode_server::direct::private_read(&directory.join("settings.json"))
                .ok()
                .and_then(|content| serde_json::from_slice(&content).ok())
                .unwrap_or_default();
            *shared.settings.lock().unwrap() = Some(settings);
            let mut threads = HashMap::new();
            if let Ok(entries) = std::fs::read_dir(directory.join("threads")) {
                for entry in entries.flatten() {
                    let Ok(content) = qingcode_server::direct::private_read(&entry.path()) else {
                        continue;
                    };
                    let Ok(data) = serde_json::from_slice::<ThreadData>(&content) else {
                        continue;
                    };
                    threads.insert(
                        data.id.clone(),
                        Arc::new(Slot {
                            core: Mutex::new(Core {
                                thread: Thread::new(data, Status::Closed),
                                runtime: None,
                                generation: 0,
                                last_active: Instant::now(),
                                last_active_ms: now_ms(),
                                restart: false,
                            }),
                            changed: Arc::new(Notify::new()),
                        }),
                    );
                }
            }
            *shared.threads.lock().unwrap() = threads;
            let saver = shared.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(SAVE_INTERVAL);
                let slots: Vec<Arc<Slot>> =
                    saver.threads.lock().unwrap().values().cloned().collect();
                for slot in slots {
                    let mut core = slot.core.lock().unwrap();
                    let idle = core.runtime.is_some()
                        && core.thread.status == Status::Idle
                        && core.last_active.elapsed() > IDLE_SHUTDOWN
                        && core
                            .runtime
                            .as_ref()
                            .is_some_and(|runtime| runtime.adapter.pending_requests() == 0);
                    if idle {
                        stop_runtime(&mut core, Status::Closed);
                    }
                    let data = core.thread.dirty.then(|| {
                        core.thread.dirty = false;
                        core.thread.data.clone()
                    });
                    drop(core);
                    if idle {
                        slot.changed.notify_waiters();
                    }
                    if let Some(data) = data {
                        saver.save(&data);
                    }
                }
            });
        });
    }

    fn slot(&self, id: &str) -> Result<Arc<Slot>, String> {
        self.ensure_started();
        self.shared
            .threads
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "对话不存在或已删除。".to_string())
    }

    fn defaults(&self, provider: Provider) -> ProviderDefaults {
        self.ensure_started();
        self.shared
            .settings
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|settings| settings.defaults.get(&provider).cloned())
            .unwrap_or_default()
    }

    fn save_settings(&self) -> Result<(), String> {
        let Some(directory) = self.shared.directory() else {
            return Ok(());
        };
        let content = {
            let settings = self.shared.settings.lock().unwrap();
            serde_json::to_vec(settings.as_ref().unwrap_or(&Settings::default()))
                .map_err(|error| error.to_string())?
        };
        write_private(&directory.join("settings.json"), &content)
    }

    /// 三家 Agent 的安全选项与默认设置。
    pub fn catalog(&self) -> Value {
        json!(Provider::ALL
            .iter()
            .map(|provider| {
                let defaults = self.defaults(*provider);
                json!({
                    "id": provider,
                    "name": provider.name(),
                    "safety": safety_catalog(*provider),
                    "defaultSafety": defaults
                        .safety
                        .filter(|safety| provider.valid_safety(safety))
                        .unwrap_or_else(|| provider.default_safety().to_string()),
                    "defaultModel": defaults.model,
                    "installed": process::locate(provider.program()).is_some(),
                })
            })
            .collect::<Vec<_>>())
    }

    pub fn set_defaults(
        &self,
        provider: Provider,
        safety: Option<String>,
        model: Option<String>,
    ) -> Result<Value, String> {
        if let Some(safety) = &safety {
            if !provider.valid_safety(safety) {
                return Err("无效的安全选项。".into());
            }
        }
        self.ensure_started();
        {
            let mut settings = self.shared.settings.lock().unwrap();
            let settings = settings.get_or_insert_with(Settings::default);
            let entry = settings.defaults.entry(provider).or_default();
            if safety.is_some() {
                entry.safety = safety;
            }
            if let Some(model) = model {
                entry.model = Some(model).filter(|model| !model.is_empty());
            }
        }
        self.save_settings()?;
        Ok(self.catalog())
    }

    pub fn list(&self, project: Option<&str>) -> Value {
        self.ensure_started();
        let slots: Vec<Arc<Slot>> = self
            .shared
            .threads
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        let mut threads: Vec<Value> = slots
            .iter()
            .filter_map(|slot| {
                let core = slot.core.lock().unwrap();
                if project.is_some_and(|project| core.thread.data.project.id != project) {
                    return None;
                }
                let mut meta = core.metadata();
                // 列表不需要模型选项等大字段。
                meta.as_object_mut().map(|meta| meta.remove("options"));
                Some(meta)
            })
            .collect();
        threads.sort_by_key(|thread| std::cmp::Reverse(thread["updatedAt"].as_u64().unwrap_or(0)));
        json!(threads)
    }

    fn insert(&self, data: ThreadData) -> Arc<Slot> {
        let slot = Arc::new(Slot {
            core: Mutex::new(Core {
                thread: Thread::new(data, Status::Closed),
                runtime: None,
                generation: 0,
                last_active: Instant::now(),
                last_active_ms: now_ms(),
                restart: false,
            }),
            changed: Arc::new(Notify::new()),
        });
        let id = slot.core.lock().unwrap().thread.data.id.clone();
        let mut threads = self.shared.threads.lock().unwrap();
        threads.insert(id, slot.clone());
        if threads.len() > MAX_THREADS {
            // 清理最久未更新且未运行的对话。
            let mut idle: Vec<(u64, String)> = threads
                .iter()
                .filter_map(|(id, slot)| {
                    let core = slot.core.try_lock().ok()?;
                    core.runtime
                        .is_none()
                        .then(|| (core.thread.data.updated_at, id.clone()))
                })
                .collect();
            idle.sort();
            let excess = threads.len() - MAX_THREADS;
            for (_, id) in idle.into_iter().take(excess) {
                threads.remove(&id);
                if let Some(directory) = self.shared.directory() {
                    let _ =
                        std::fs::remove_file(directory.join("threads").join(format!("{id}.json")));
                }
            }
        }
        slot
    }

    /// 新建对话并启动 Agent。`project` 须已由桌面端确认信任。
    pub fn create(
        &self,
        project: AgentProject,
        provider: Provider,
        safety: Option<String>,
        model: Option<String>,
    ) -> Result<Value, String> {
        self.ensure_started();
        let defaults = self.defaults(provider);
        let safety = safety
            .or(defaults.safety)
            .filter(|safety| provider.valid_safety(safety))
            .unwrap_or_else(|| provider.default_safety().to_string());
        let now = now_ms();
        let data = ThreadData {
            id: format!("agent-{}", uuid::Uuid::new_v4().simple()),
            provider,
            project,
            title: String::new(),
            title_manual: false,
            created_at: now,
            updated_at: now,
            safety,
            model: model.or(defaults.model).filter(|model| !model.is_empty()),
            effort: None,
            mode: None,
            session: None,
            usage: Value::Null,
            items: Vec::new(),
            rev: 0,
        };
        let slot = self.insert(data);
        let mut core = slot.core.lock().unwrap();
        core.thread.dirty = true;
        if let Err(error) = start_runtime(&self.shared, &slot, &mut core) {
            let id = core.thread.data.id.clone();
            drop(core);
            self.shared.threads.lock().unwrap().remove(&id);
            return Err(error);
        }
        let meta = core.metadata();
        drop(core);
        slot.changed.notify_waiters();
        Ok(meta)
    }

    /// 对话的项目；进程未运行时调用方须重新确认工作区信任后再发送。
    pub fn project(&self, id: &str) -> Result<(AgentProject, bool), String> {
        let slot = self.slot(id)?;
        let core = slot.core.lock().unwrap();
        Ok((core.thread.data.project.clone(), core.runtime.is_some()))
    }

    pub fn attach(&self, data: &str) -> Result<Value, String> {
        let image = decode_image(data)?;
        let mut attachments = self.shared.attachments.lock().unwrap();
        attachments.retain(|_, (_, time)| time.elapsed() < ATTACHMENT_TTL);
        if attachments.len() >= MAX_ATTACHMENTS {
            return Err("待发送的图片过多，请先发送或稍后重试。".into());
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mime = image.mime.clone();
        attachments.insert(id.clone(), (image, Instant::now()));
        Ok(json!({ "id": id, "mime": mime }))
    }

    pub fn send(
        &self,
        id: &str,
        text: &str,
        attachments: &[String],
        refreshed: Option<AgentProject>,
    ) -> Result<Value, String> {
        if text.len() > MAX_PROMPT {
            return Err("单条消息不能超过 64 KiB。".into());
        }
        let images: Vec<Image> = {
            let mut store = self.shared.attachments.lock().unwrap();
            attachments
                .iter()
                .map(|attachment| {
                    store
                        .remove(attachment)
                        .map(|(image, _)| image)
                        .ok_or("图片已过期，请重新选择。")
                })
                .collect::<Result<_, _>>()?
        };
        if text.trim().is_empty() && images.is_empty() {
            return Err("请输入消息。".into());
        }
        let slot = self.slot(id)?;
        let mut core = slot.core.lock().unwrap();
        if core.thread.status == Status::Running {
            return Err("Agent 正在执行，请等待完成或先停止。".into());
        }
        if core.thread.pending_approvals() > 0 {
            return Err("请先处理待审批的请求。".into());
        }
        if let Some(project) = refreshed {
            core.thread.data.project = project;
        }
        let item = format!("u-{}", uuid::Uuid::new_v4().simple());
        let count = images.len();
        core.thread.upsert(&item, "user", |entry| {
            entry.insert("text".into(), json!(text));
            if count > 0 {
                entry.insert("images".into(), json!(count));
            }
        });
        core.thread.set_title_from(text);
        if core.runtime.is_none() {
            if let Err(error) = start_runtime(&self.shared, &slot, &mut core) {
                core.thread.fail(error.clone());
                drop(core);
                slot.changed.notify_waiters();
                return Err(error);
            }
        }
        core.touch();
        if core.thread.status != Status::Starting {
            core.thread.set_status(Status::Running);
        }
        let prompt = Prompt {
            text: text.to_string(),
            images,
        };
        let result = drive(&self.shared, &mut core, |adapter, cx| {
            adapter.send(prompt, cx)
        });
        if let Some(Err(error)) = &result {
            core.thread.notice("error", error.clone());
            core.thread.set_status(Status::Idle);
        }
        let meta = core.metadata();
        drop(core);
        slot.changed.notify_waiters();
        match result {
            Some(Err(error)) => Err(error),
            _ => Ok(meta),
        }
    }

    fn snapshot(core: &Core, from: u64) -> Value {
        let (full, items) = core.thread.changes(from);
        json!({
            "thread": core.metadata(),
            "items": items,
            "full": full,
            "rev": core.thread.data.rev,
        })
    }

    /// 长轮询：有变化立即返回，否则最多等待 20 秒。
    pub async fn poll(&self, id: &str, from: u64) -> Result<Value, String> {
        let slot = self.slot(id)?;
        let deadline = tokio::time::Instant::now() + POLL_WAIT;
        let wait = {
            let core = slot.core.lock().unwrap();
            if core.thread.data.rev != from {
                return Ok(Self::snapshot(&core, from));
            }
            slot.changed.clone().notified_owned()
        };
        if tokio::time::timeout_at(deadline, wait).await.is_ok() {
            // 合并同一批流式增量，减少请求次数。
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        let core = slot.core.lock().unwrap();
        Ok(Self::snapshot(&core, from))
    }

    pub fn history(&self, id: &str, before: &str) -> Result<Value, String> {
        let slot = self.slot(id)?;
        let core = slot.core.lock().unwrap();
        Ok(json!({ "items": core.thread.history(before, 100) }))
    }

    fn with_runtime<R>(
        &self,
        id: &str,
        action: impl FnOnce(&mut dyn Adapter, &mut Cx) -> Result<R, String>,
    ) -> Result<R, String> {
        let slot = self.slot(id)?;
        let mut core = slot.core.lock().unwrap();
        if core.runtime.is_none() {
            return Err("Agent 未运行，请重新发送消息以恢复会话。".into());
        }
        core.touch();
        let result =
            drive(&self.shared, &mut core, action).unwrap_or_else(|| Err("Agent 未运行。".into()));
        drop(core);
        slot.changed.notify_waiters();
        result
    }

    pub fn respond(
        &self,
        id: &str,
        approval: &str,
        choice: &str,
        answers: &Value,
    ) -> Result<(), String> {
        self.with_runtime(id, |adapter, cx| {
            adapter.respond(approval, choice, answers, cx)
        })
    }

    pub fn interrupt(&self, id: &str) -> Result<(), String> {
        self.with_runtime(id, |adapter, cx| adapter.interrupt(cx))
    }

    pub fn configure(&self, id: &str, key: &str, value: &str) -> Result<Value, String> {
        let slot = self.slot(id)?;
        let mut core = slot.core.lock().unwrap();
        let provider = core.thread.data.provider;
        match key {
            "safety" if !provider.valid_safety(value) => return Err("无效的安全选项。".into()),
            "safety" | "model" | "effort" => {}
            "mode" if provider == Provider::Opencode => {}
            _ => return Err("不支持该设置。".into()),
        }
        let stored = Some(value.to_string()).filter(|value| !value.is_empty());
        match key {
            "safety" => core.thread.data.safety = value.to_string(),
            "model" => core.thread.data.model = stored,
            "effort" => core.thread.data.effort = stored,
            _ => core.thread.data.mode = stored,
        }
        core.thread.bump();
        if core.runtime.is_some() {
            let restart = drive(&self.shared, &mut core, |adapter, cx| {
                adapter.configure(key, value, cx)
            })
            .unwrap_or(Ok(false))?;
            if restart {
                if core.thread.status == Status::Running {
                    core.restart = true;
                } else {
                    stop_runtime(&mut core, Status::Closed);
                }
            }
        }
        let meta = core.metadata();
        drop(core);
        slot.changed.notify_waiters();
        Ok(meta)
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<Value, String> {
        let title = title.trim();
        if title.chars().count() > 80 {
            return Err("名称最多 80 个字符。".into());
        }
        let slot = self.slot(id)?;
        let mut core = slot.core.lock().unwrap();
        core.thread.data.title = title.to_string();
        core.thread.data.title_manual = !title.is_empty();
        core.thread.bump();
        let meta = core.metadata();
        drop(core);
        slot.changed.notify_waiters();
        Ok(meta)
    }

    /// 结束 Agent 进程，保留对话；之后发送消息会恢复会话。
    pub fn close(&self, id: &str) -> Result<(), String> {
        let slot = self.slot(id)?;
        let mut core = slot.core.lock().unwrap();
        stop_runtime(&mut core, Status::Closed);
        drop(core);
        slot.changed.notify_waiters();
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let slot = self.slot(id)?;
        stop_runtime(&mut slot.core.lock().unwrap(), Status::Closed);
        self.shared.threads.lock().unwrap().remove(id);
        if let Some(directory) = self.shared.directory() {
            let _ = std::fs::remove_file(directory.join("threads").join(format!("{id}.json")));
        }
        slot.changed.notify_waiters();
        Ok(())
    }

    /// 结束所有 Agent 进程（关闭移动连接或退出时）。
    pub fn stop_all(&self) {
        let slots: Vec<Arc<Slot>> = self
            .shared
            .threads
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for slot in slots {
            let mut core = slot.core.lock().unwrap();
            if core.runtime.is_some() {
                stop_runtime(&mut core, Status::Closed);
            }
            drop(core);
            slot.changed.notify_waiters();
        }
    }

    /// 各家额度。`refresh` 时向运行中的 Agent 请求更新，没有运行中的进程则在本机短暂启动探测。
    pub fn usage(&self, refresh: bool) -> Value {
        self.ensure_started();
        if refresh {
            let mut live = HashMap::new();
            let slots: Vec<Arc<Slot>> = self
                .shared
                .threads
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect();
            for slot in slots {
                let mut core = slot.core.lock().unwrap();
                let provider = core.thread.data.provider;
                if core.runtime.is_some() && !live.contains_key(&provider) {
                    drive(&self.shared, &mut core, |adapter, cx| {
                        adapter.refresh_usage(cx)
                    });
                    live.insert(provider, ());
                }
            }
            let probes: Vec<_> = [Provider::Codex, Provider::Claude]
                .into_iter()
                .filter(|provider| !live.contains_key(provider))
                .map(|provider| {
                    let shared = self.shared.clone();
                    std::thread::spawn(move || {
                        let quota = probe_quota(provider);
                        shared.store_quota(provider, quota);
                    })
                })
                .collect();
            for probe in probes {
                let _ = probe.join();
            }
            if !live.is_empty() {
                // 运行中的 Agent 异步返回额度，稍等片刻。
                std::thread::sleep(Duration::from_millis(1500));
            }
        }
        let quotas = self.shared.quotas.lock().unwrap();
        json!(Provider::ALL
            .iter()
            .map(|provider| {
                let mut quota = quotas.get(provider).cloned().unwrap_or_else(|| json!({}));
                quota["provider"] = json!(provider);
                quota["name"] = json!(provider.name());
                if *provider == Provider::Opencode && quota.get("note").is_none() {
                    quota["note"] = json!("OpenCode 按所选模型的提供方计费，额度请在提供方查看；对话内显示本会话用量。");
                }
                quota
            })
            .collect::<Vec<_>>())
    }
}

fn probe_project() -> AgentProject {
    AgentProject {
        id: "probe".into(),
        name: "probe".into(),
        path: dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .to_string_lossy()
            .into_owned(),
        kind: "local".into(),
        host: "Windows".into(),
    }
}

/// 在本机短暂启动 Agent 读取额度（不发送任何对话内容）。
fn probe_quota(provider: Provider) -> Value {
    let project = probe_project();
    if process::locate(provider.program()).is_none() {
        return json!({ "error": format!("电脑上未安装 {}。", provider.name()) });
    }
    let mut quota = None;
    let result = match provider {
        Provider::Codex => {
            let launch = process::Launch {
                program: "codex".into(),
                args: vec!["app-server".into()],
                env: Vec::new(),
            };
            let initialize = json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "qingcode", "version": env!("CARGO_PKG_VERSION") } } });
            process::probe(
                &project,
                &launch,
                vec![initialize.to_string()],
                PROBE_TIMEOUT,
                |message| match message.get("id").and_then(Value::as_u64) {
                    Some(1) => Ok(vec![
                        json!({ "method": "initialized" }).to_string(),
                        json!({ "id": 2, "method": "account/rateLimits/read" }).to_string(),
                    ]),
                    Some(2) => {
                        quota = Some(
                            match message.pointer("/error/message").and_then(Value::as_str) {
                                Some(error) if error.contains("authentication") => {
                                    json!({ "error": "Codex 未登录，请先在电脑上运行 codex 登录。" })
                                }
                                Some(error) => json!({ "error": error }),
                                None => codex::quota(
                                    message
                                        .pointer("/result/rateLimits")
                                        .unwrap_or(&Value::Null),
                                ),
                            },
                        );
                        Err(())
                    }
                    _ => Ok(Vec::new()),
                },
            )
        }
        Provider::Claude => {
            let launch = process::Launch {
                program: "claude".into(),
                args: [
                    "-p",
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                ]
                .map(String::from)
                .to_vec(),
                env: Vec::new(),
            };
            let initialize = json!({ "type": "control_request", "request_id": "init", "request": { "subtype": "initialize" } });
            process::probe(
                &project,
                &launch,
                vec![initialize.to_string()],
                PROBE_TIMEOUT,
                |message| {
                    if str_at(message, "/type") != Some("control_response") {
                        return Ok(Vec::new());
                    }
                    match str_at(message, "/response/request_id") {
                    Some("init") => Ok(vec![json!({ "type": "control_request", "request_id": "usage", "request": { "subtype": "get_usage" } }).to_string()]),
                    Some("usage") => {
                        quota = Some(match str_at(message, "/response/subtype") {
                            Some("success") => claude::quota(message.pointer("/response/response").unwrap_or(&Value::Null)),
                            _ => json!({ "error": str_at(message, "/response/error").unwrap_or("Claude 未返回额度。") }),
                        });
                        Err(())
                    }
                    _ => Ok(Vec::new()),
                }
                },
            )
        }
        Provider::Opencode => Ok(()),
    };
    match (quota, result) {
        (Some(quota), _) => quota,
        (None, Err(error)) => {
            json!({ "error": format!("读取 {} 额度失败：{error}", provider.name()) })
        }
        (None, Ok(())) => json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> AgentProject {
        AgentProject {
            id: "p1".into(),
            name: "demo".into(),
            path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\demo".into(),
            kind: "wsl".into(),
            host: "Ubuntu".into(),
        }
    }

    #[test]
    fn wsl_projects_run_agents_in_the_linux_path() {
        assert_eq!(project().agent_cwd(), "/home/me/demo");
        let ssh = AgentProject {
            path: "ssh://conn-1/srv/api".into(),
            kind: "ssh".into(),
            ..project()
        };
        assert_eq!(ssh.agent_cwd(), "/srv/api");
    }

    type Launched = (
        String,
        String,
        tokio::sync::mpsc::UnboundedReceiver<process::RemoteCommand>,
        tokio::sync::oneshot::Receiver<()>,
    );

    struct FakeLauncher(Mutex<Vec<Launched>>);

    impl RemoteLauncher for FakeLauncher {
        fn launch(
            &self,
            terminal: String,
            _project: AgentProject,
            script: String,
            commands: tokio::sync::mpsc::UnboundedReceiver<process::RemoteCommand>,
            ready: tokio::sync::oneshot::Receiver<()>,
        ) {
            self.0
                .lock()
                .unwrap()
                .push((terminal, script, commands, ready));
        }
    }

    #[test]
    fn ssh_threads_run_through_the_remote_launcher_and_stream_lines() {
        let host = AgentHost::in_memory();
        let launcher = Arc::new(FakeLauncher(Mutex::new(Vec::new())));
        host.set_remote_launcher(launcher.clone());
        let ssh = AgentProject {
            path: "ssh://conn-1/srv/api".into(),
            kind: "ssh".into(),
            ..project()
        };
        let meta = host
            .create(ssh, Provider::Codex, Some("full".into()), None)
            .unwrap();
        let id = meta["id"].as_str().unwrap().to_string();
        // 在线的 Agent 带空闲信息：24 小时无活动后自动结束。
        assert_eq!(
            meta["idleDeadline"].as_u64().unwrap() - meta["lastActiveAt"].as_u64().unwrap(),
            IDLE_SHUTDOWN.as_millis() as u64
        );
        let (terminal, script, mut commands, mut ready) = launcher.0.lock().unwrap().pop().unwrap();
        assert!(terminal.starts_with(TERMINAL_PREFIX));
        assert!(script.starts_with("stty raw -echo"));
        assert!(ready.try_recv().is_err());
        assert!(script.ends_with("'codex' 'app-server'"));
        let initialize = match commands.try_recv().unwrap() {
            process::RemoteCommand::Write(line) => line,
            other => panic!("unexpected {other:?}"),
        };
        assert!(initialize.contains("\"initialize\""));
        // 远端分片输出：登录提示、被回显的写入、就绪标记，再是跨块的 JSON 行。
        host.remote_data(
            &terminal,
            b"Last login: today\r\n{\"echo\":1}\r\n\nQINGCODE_AGENT_READY\n{\"id\":1,",
        );
        assert!(ready.try_recv().is_ok());
        host.remote_data(&terminal, b"\"result\":{}}\n");
        let thread_start = std::iter::from_fn(|| commands.try_recv().ok())
            .filter_map(|command| match command {
                process::RemoteCommand::Write(line) => Some(line),
                process::RemoteCommand::Kill => None,
            })
            .find(|line| line.contains("thread/start"))
            .expect("应发送 thread/start");
        assert!(thread_start.contains("\"cwd\":\"/srv/api\""));
        assert!(thread_start.contains("danger-full-access"));
        host.remote_data(
            &terminal,
            b"{\"id\":2,\"result\":{\"thread\":{\"id\":\"th\"}}}\n",
        );
        let slot = host.slot(&id).unwrap();
        assert_eq!(slot.core.lock().unwrap().thread.status, Status::Idle);
        host.remote_gap(&terminal);
        host.remote_exit(&terminal, Some("连接断开".into()));
        let core = slot.core.lock().unwrap();
        assert!(core.runtime.is_none());
        assert_eq!(core.thread.status, Status::Closed);
        drop(core);
        // 结束后的迟到输出被忽略。
        host.remote_data(&terminal, b"{\"id\":3}\n");
    }

    #[test]
    fn remote_launch_failure_marks_a_starting_thread_as_failed() {
        let host = AgentHost::in_memory();
        let launcher = Arc::new(FakeLauncher(Mutex::new(Vec::new())));
        host.set_remote_launcher(launcher.clone());
        let ssh = AgentProject {
            path: "ssh://conn-1/srv/api".into(),
            kind: "ssh".into(),
            ..project()
        };
        let id = host.create(ssh, Provider::Claude, None, None).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let (terminal, ..) = launcher.0.lock().unwrap().pop().unwrap();
        host.remote_exit(&terminal, Some("Windows 远端暂不支持对话模式".into()));
        let slot = host.slot(&id).unwrap();
        let core = slot.core.lock().unwrap();
        assert_eq!(core.thread.status, Status::Error);
        assert!(core
            .thread
            .error
            .as_deref()
            .unwrap()
            .contains("Windows 远端"));
    }

    #[test]
    fn catalog_marks_full_access_options_and_validates_defaults() {
        let host = AgentHost::in_memory();
        let catalog = host.catalog();
        let codex = catalog
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "codex")
            .unwrap();
        assert_eq!(codex["defaultSafety"], "auto");
        assert!(codex["safety"]
            .as_array()
            .unwrap()
            .iter()
            .any(|option| option["id"] == "full" && option["full"] == true));
        assert!(host
            .set_defaults(Provider::Codex, Some("bogus".into()), None)
            .is_err());
        let catalog = host
            .set_defaults(
                Provider::Claude,
                Some("bypassPermissions".into()),
                Some("sonnet".into()),
            )
            .unwrap();
        let claude = catalog
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == "claude")
            .unwrap();
        assert_eq!(claude["defaultSafety"], "bypassPermissions");
        assert_eq!(claude["defaultModel"], "sonnet");
    }

    #[test]
    fn attachments_accept_only_png_and_jpeg() {
        let host = AgentHost::in_memory();
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        assert_eq!(host.attach(&png).unwrap()["mime"], "image/png");
        let gif = base64::engine::general_purpose::STANDARD.encode(b"GIF89a");
        assert!(host.attach(&gif).is_err());
        assert!(host.attach("%%%").is_err());
    }

    #[test]
    fn thread_operations_without_a_runtime_report_clear_errors() {
        let host = AgentHost::in_memory();
        let now = now_ms();
        let slot = host.insert(ThreadData {
            id: "agent-x".into(),
            provider: Provider::Codex,
            project: project(),
            title: String::new(),
            title_manual: false,
            created_at: now,
            updated_at: now,
            safety: "auto".into(),
            model: None,
            effort: None,
            mode: None,
            session: Some("th".into()),
            usage: Value::Null,
            items: Vec::new(),
            rev: 0,
        });
        assert!(host.interrupt("agent-x").unwrap_err().contains("未运行"));
        let meta = host.configure("agent-x", "safety", "full").unwrap();
        assert_eq!(meta["safety"], "full");
        assert!(host.configure("agent-x", "mode", "plan").is_err());
        assert!(host.configure("agent-x", "safety", "nope").is_err());
        let meta = host.rename("agent-x", "  修 bug ").unwrap();
        assert_eq!(meta["title"], "修 bug");
        assert_eq!(meta["titleManual"], true);
        assert_eq!(host.list(Some("p1")).as_array().unwrap().len(), 1);
        assert_eq!(host.list(Some("other")).as_array().unwrap().len(), 0);
        assert_eq!(slot.core.lock().unwrap().thread.status, Status::Closed);
        host.delete("agent-x").unwrap();
        assert!(host.slot("agent-x").is_err());
    }

    #[tokio::test]
    async fn poll_returns_changes_immediately_and_waits_when_current() {
        let host = AgentHost::in_memory();
        let now = now_ms();
        let slot = host.insert(ThreadData {
            id: "agent-y".into(),
            provider: Provider::Opencode,
            project: project(),
            title: String::new(),
            title_manual: false,
            created_at: now,
            updated_at: now,
            safety: "ask".into(),
            model: None,
            effort: None,
            mode: None,
            session: None,
            usage: Value::Null,
            items: Vec::new(),
            rev: 0,
        });
        slot.core.lock().unwrap().thread.notice("info", "hello");
        let first = host.poll("agent-y", 0).await.unwrap();
        assert_eq!(first["full"], true);
        assert_eq!(first["items"].as_array().unwrap().len(), 1);
        let rev = first["rev"].as_u64().unwrap();
        let waiting = {
            let host = host.clone();
            tokio::spawn(async move { host.poll("agent-y", rev).await.unwrap() })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        slot.core.lock().unwrap().thread.notice("info", "second");
        slot.changed.notify_waiters();
        let second = waiting.await.unwrap();
        assert_eq!(second["full"], false);
        assert_eq!(second["items"][0]["text"], "second");
    }
}
