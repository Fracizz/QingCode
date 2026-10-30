//! SSH 远端代理的连接阶段。
//!
//! 这里只做可查询、可订阅的阶段模型，以及 daemon / serve / direct 分派标签
//! （`SshServerState::transport`）。不把文件与 Git 命令改写到 `RemoteBackend`
//! （那是能力迁移，不在这一层）。
//!
//! 稳态由会话、总开关、信任、Windows OpenSSH 与 [`super::server::ServerSlot`] 决定。
//! 部署过程中的 installing / handshaking 记在 slot 的 `activity` 上，有
//! `AppHandle` 时才发 `ssh-server-state`，且快照不变不重复发。

use super::*;
use serde::{Deserialize, Serialize};

/// 前端订阅的事件名。
pub(crate) const SSH_SERVER_STATE_EVENT: &str = "ssh-server-state";

/// 日志只读这条固定命令。`$HOME` 由远端 shell 展开，禁止把用户路径拼进命令。
/// 项目里的 `.qingcode/server` 是 serve 状态目录，不是 daemon 日志。
pub(crate) const SERVER_LOG_TAIL_COMMAND: &str =
    "tail -n 200 \"$HOME/.qingcode/server/run/server.log\"";

/// 「日志文件不存在」的脚本退出码标记。Windows PowerShell 的报错文本随系统
/// 语言变化，用固定退出码判定比解析 stderr 可靠；unix 的 tail 不会用这个码。
const SERVER_LOG_MISSING_EXIT: u32 = 3;

/// Windows 日志一律按 UTF-8 读取并直接写出 UTF-8 字节。
///
/// `Get-Content` 在 Windows PowerShell 5.1 中会按系统 ANSI 代码页解码文件，
/// 再把字符串按控制台代码页重编码；qingcode-server 写的是 UTF-8，中文日志
/// 因此会变成乱码。固定文件编码 + 标准输出原始字节可绕开两层代码页转换。
fn windows_read_log_tail_script(log_expression: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$log = {log_expression}
if (-not (Test-Path -LiteralPath $log)) {{ exit {missing_exit} }}
$utf8 = [System.Text.UTF8Encoding]::new($false)
$share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
$stream = [System.IO.File]::Open($log, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
$reader = $null
try {{
  $reader = [System.IO.StreamReader]::new($stream, $utf8, $true)
  $text = $reader.ReadToEnd()
}} finally {{
  if ($null -ne $reader) {{ $reader.Dispose() }} else {{ $stream.Dispose() }}
}}
$lines = $text -split '\r?\n'
if ($lines.Count -gt 1 -and [string]::IsNullOrEmpty($lines[-1])) {{
  $lines = $lines[0..($lines.Count - 2)]
}}
if ($lines.Count -gt {max_lines}) {{
  $lines = $lines[($lines.Count - {max_lines})..($lines.Count - 1)]
}}
$bytes = $utf8.GetBytes(($lines -join "`n"))
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()"#,
        max_lines = SERVER_LOG_MAX_LINES,
        missing_exit = SERVER_LOG_MISSING_EXIT,
    )
}

/// Windows daemon 日志在 `%USERPROFILE%\.qingcode\server\run\server.log`：
/// 文件在就读末尾，不存在用 [`SERVER_LOG_MISSING_EXIT`] 告知调用方跳过该段。
fn windows_daemon_log_script() -> String {
    windows_read_log_tail_script("Join-Path $env:USERPROFILE '.qingcode\\server\\run\\server.log'")
}

/// Diagnostic export uses fixed user-private paths. No project file is executed,
/// no daemon is started or upgraded, and each section is bounded before transport.
const DIAGNOSTIC_SECTION: &str = "__QINGCODE_DIAGNOSTIC_SECTION__:";

const UNIX_DIAGNOSTIC_COMMAND: &str = r#"base="$HOME/.qingcode/server/run"
for name in lifecycle.jsonl.3 lifecycle.jsonl.2 lifecycle.jsonl.1 lifecycle.jsonl daemon.stderr.log; do
  printf '\n__QINGCODE_DIAGNOSTIC_SECTION__:%s\n' "$name"
  if [ -f "$base/$name" ] && [ ! -L "$base/$name" ]; then tail -c 524288 "$base/$name"; fi
done
if [ -d "$base/incidents" ]; then
  find "$base/incidents" -maxdepth 1 -type f -name '*.jsonl' | sort | tail -n 2 | while IFS= read -r file; do
    printf '\n__QINGCODE_DIAGNOSTIC_SECTION__:incident\n'
    tail -c 524288 "$file"
  done
fi"#;

const WINDOWS_DIAGNOSTIC_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$base = Join-Path $env:USERPROFILE '.qingcode\server\run'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$output = [Console]::OpenStandardOutput()
function Emit-Tail([string]$path, [string]$name) {
  $marker = $utf8.GetBytes("`n__QINGCODE_DIAGNOSTIC_SECTION__:$name`n")
  $output.Write($marker, 0, $marker.Length)
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
  if ((Get-Item -LiteralPath $path).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return }
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
  try {
    $length = [int][Math]::Min(524288, $stream.Length)
    [void]$stream.Seek(-$length, [System.IO.SeekOrigin]::End)
    $bytes = New-Object byte[] $length
    $offset = 0
    while ($offset -lt $length) {
      $count = $stream.Read($bytes, $offset, $length - $offset)
      if ($count -eq 0) { break }
      $offset += $count
    }
    $output.Write($bytes, 0, $offset)
  } finally { $stream.Dispose() }
}
foreach ($name in @('lifecycle.jsonl.3','lifecycle.jsonl.2','lifecycle.jsonl.1','lifecycle.jsonl','daemon.stderr.log')) {
  Emit-Tail (Join-Path $base $name) $name
}
$incidents = Join-Path $base 'incidents'
if (Test-Path -LiteralPath $incidents) {
  Get-ChildItem -LiteralPath $incidents -File -Filter '*.jsonl' |
    Where-Object { $_.Name -match '^\d+-\d+-\d+\.jsonl$' } |
    Sort-Object Name -Descending | Select-Object -First 2 |
    ForEach-Object { Emit-Tail $_.FullName 'incident' }
}"#;

fn diagnostic_sections(text: &str) -> String {
    let mut output = String::new();
    let mut stderr = false;
    for line in text.lines() {
        if let Some(section) = line.strip_prefix(DIAGNOSTIC_SECTION) {
            stderr = section == "daemon.stderr.log";
            output.push_str(&format!("{}\n", serde_json::json!({"section":section})));
        } else if stderr {
            if !line.is_empty() {
                output.push_str(&format!(
                    "{}\n",
                    serde_json::json!({"event":"daemon.stderr_tail",
                    "summary":qingcode_server::diagnostics::error_summary(line)})
                ));
            }
        } else if serde_json::from_str::<serde_json::Value>(line).is_ok() {
            output.push_str(line);
            output.push('\n');
        }
    }
    output
}

pub(crate) async fn terminal_diagnostic_log(
    root_uri: String,
    manager: &SshManager,
) -> Result<String, String> {
    let root = require_trusted_root(manager, &root_uri)?;
    let result = manager
        .exec_remote_shell(
            &root.uri,
            UNIX_DIAGNOSTIC_COMMAND,
            WINDOWS_DIAGNOSTIC_SCRIPT,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await?;
    if result.exit_code != 0 {
        return Err("远端诊断日志读取失败".into());
    }
    Ok(diagnostic_sections(&result.stdout))
}

/// 项目 serve 日志的读取命令（unix）。路径来自 canonical root，必须 shell_quote。
fn serve_log_tail_command(path: &str) -> String {
    format!("tail -n {SERVER_LOG_MAX_LINES} -- {}", shell_quote(path))
}

/// 项目 serve 日志的读取脚本（Windows）。文件不存在同样用退出码标记跳过。
fn windows_serve_log_script(path: &str) -> String {
    let Some(native) = server::windows_host_path(path) else {
        return String::new();
    };
    windows_read_log_tail_script(&format!("'{}'", powershell_literal(&native)))
}

const SERVER_LOG_MAX_LINES: usize = 200;
const SERVER_LOG_MAX_BYTES: usize = 64 * 1024;
const SERVER_LOG_MISSING: &str = "远端代理日志不存在";

const REASON_SSH_MODE: &str = "SSH 模式（连接配置）";
const REASON_UNTRUSTED: &str = "工作区未信任";
/// restart / logs / stop 这类会触碰远端进程的命令在未信任根上直接拒绝。
const REASON_UNTRUSTED_COMMAND: &str = "工作区未信任，无法操作远端服务";
const REASON_SSH_MODE_COMMAND: &str =
    "该连接为 SSH 模式，没有远端服务；如需 Server 模式请在「远程连接」中切换";

/// 连接阶段。serde 用 camelCase，与前端约定一致。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerPhase {
    Disconnected,
    Authenticating,
    Probing,
    Installing,
    Handshaking,
    ReadyServer,
    ReadyDirect,
}

/// 当前对外模式。探测和握手完成前是 `unknown`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerMode {
    Server,
    Direct,
    Unknown,
}

/// 分派标签：daemon（常驻代理）、serve（按次 JSON）、direct（直连）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerTransport {
    Daemon,
    Serve,
    Direct,
    Agent,
}

/// `ssh-server-state` 与 `ssh_server_info` / `ssh_server_restart` 的载荷。
/// `Option` 序列化为 null，不用 `skip_serializing_if`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshServerState {
    pub connection_id: String,
    pub root_uri: String,
    pub phase: ServerPhase,
    pub mode: ServerMode,
    /// 连接配置里的模式（连接时固定）；会话不存在时为 null。
    pub connection_mode: Option<RemoteMode>,
    pub version: Option<String>,
    pub transport: Option<ServerTransport>,
    pub reason: Option<String>,
    /// 最近一次发现/部署的分阶段耗时摘要；只在就绪时给出。
    pub timings: Option<String>,
}

/// `ssh_server_logs` 的返回值。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshServerLogs {
    pub text: String,
}

/// 计算阶段时看到的 slot 切片，避免单元测试依赖完整的端点。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ServerSlotView<'a> {
    /// `None` 没有端点；`Some(true)` 已接通 daemon；`Some(false)` 只有 serve。
    pub endpoint_has_daemon: Option<bool>,
    pub unavailable_reason: Option<&'a str>,
    pub activity: Option<ServerPhase>,
    /// 最近一次瞬时失败原因，仅展示用；阶段保持探测，之后会重试。
    pub last_failure: Option<&'a str>,
}

/// [`phase_for_slot`] 的输入。调用方负责填会话与门闩，本函数不读全局状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ServerSteadyInputs<'a> {
    pub connection_id: &'a str,
    pub root_uri: &'a str,
    pub session_connected: bool,
    pub connection_mode: Option<RemoteMode>,
    pub trusted: bool,
    pub slot: Option<ServerSlotView<'a>>,
}

/// 由会话、门闩和 slot 得到稳态（以及 slot 上记录的瞬时阶段）。
pub(crate) fn phase_for_slot(input: &ServerSteadyInputs<'_>) -> SshServerState {
    if !input.session_connected {
        return plain_state(input, ServerPhase::Disconnected);
    }
    if let Some(reason) = direct_gate_reason(input) {
        return ready_direct(input, reason);
    }
    if let Some(activity) = input.slot.and_then(|slot| slot.activity) {
        if is_in_progress(activity) {
            return plain_state(input, activity);
        }
    }
    if let Some(slot) = input.slot {
        if let Some(has_daemon) = slot.endpoint_has_daemon {
            return ready_server(input, has_daemon);
        }
        if let Some(reason) = slot.unavailable_reason {
            return ready_direct(input, reason);
        }
        if let Some(reason) = slot.last_failure {
            let mut state = plain_state(input, ServerPhase::Probing);
            state.reason = Some(reason.to_string());
            return state;
        }
    }
    plain_state(input, ServerPhase::Probing)
}

fn is_in_progress(phase: ServerPhase) -> bool {
    matches!(
        phase,
        ServerPhase::Authenticating
            | ServerPhase::Probing
            | ServerPhase::Installing
            | ServerPhase::Handshaking
    )
}

fn direct_gate_reason(input: &ServerSteadyInputs<'_>) -> Option<&'static str> {
    if input.connection_mode != Some(RemoteMode::Server) {
        return Some(REASON_SSH_MODE);
    }
    if !input.trusted {
        return Some(REASON_UNTRUSTED);
    }
    None
}

fn plain_state(input: &ServerSteadyInputs<'_>, phase: ServerPhase) -> SshServerState {
    SshServerState {
        connection_id: input.connection_id.to_string(),
        root_uri: input.root_uri.to_string(),
        phase,
        mode: ServerMode::Unknown,
        connection_mode: input.connection_mode,
        version: None,
        transport: None,
        reason: None,
        timings: None,
    }
}

fn ready_direct(input: &ServerSteadyInputs<'_>, reason: &str) -> SshServerState {
    SshServerState {
        connection_id: input.connection_id.to_string(),
        root_uri: input.root_uri.to_string(),
        phase: ServerPhase::ReadyDirect,
        mode: ServerMode::Direct,
        connection_mode: input.connection_mode,
        version: None,
        transport: Some(ServerTransport::Direct),
        reason: Some(reason.to_string()),
        timings: None,
    }
}

fn ready_server(input: &ServerSteadyInputs<'_>, has_daemon: bool) -> SshServerState {
    SshServerState {
        connection_id: input.connection_id.to_string(),
        root_uri: input.root_uri.to_string(),
        phase: ServerPhase::ReadyServer,
        mode: ServerMode::Server,
        connection_mode: input.connection_mode,
        version: Some(qingcode_server::SERVER_VERSION.to_string()),
        transport: Some(if has_daemon {
            ServerTransport::Daemon
        } else {
            ServerTransport::Serve
        }),
        reason: None,
        timings: None,
    }
}

/// 阶段转移是否允许。
///
/// 正向主路径是 Disconnected →（Authenticating →）Probing →（Installing →）
/// Handshaking → ReadyServer。任意阶段都可以到 ReadyDirect 或 Disconnected。
/// 已有端点时允许 Probing 直接到 ReadyServer；重启允许回到 Probing。
/// 运行时仍按 slot 发布，不用本函数丢事件。
pub(crate) fn server_phase_transition_allowed(from: ServerPhase, to: ServerPhase) -> bool {
    if from == to {
        return true;
    }
    if matches!(to, ServerPhase::ReadyDirect | ServerPhase::Disconnected) {
        return true;
    }
    matches!(
        (from, to),
        (ServerPhase::Disconnected, ServerPhase::Authenticating)
            | (ServerPhase::Disconnected, ServerPhase::Probing)
            | (ServerPhase::Authenticating, ServerPhase::Probing)
            | (ServerPhase::Probing, ServerPhase::Installing)
            | (ServerPhase::Probing, ServerPhase::Handshaking)
            | (ServerPhase::Probing, ServerPhase::ReadyServer)
            | (ServerPhase::Installing, ServerPhase::Handshaking)
            | (ServerPhase::Handshaking, ServerPhase::ReadyServer)
            | (ServerPhase::Handshaking, ServerPhase::Installing)
            | (ServerPhase::Installing, ServerPhase::Probing)
            | (ServerPhase::Handshaking, ServerPhase::Probing)
            | (ServerPhase::ReadyServer, ServerPhase::Probing)
            | (ServerPhase::ReadyDirect, ServerPhase::Probing)
    )
}

/// 保留最后 200 行，再把字节数压到约 64KB（按字符边界截尾部）。
pub(crate) fn truncate_server_log(text: &str) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > SERVER_LOG_MAX_LINES {
        let start = lines.len() - SERVER_LOG_MAX_LINES;
        lines = lines.split_off(start);
    }
    let mut out = lines.join("\n");
    if out.len() > SERVER_LOG_MAX_BYTES {
        let mut start = out.len() - SERVER_LOG_MAX_BYTES;
        while start < out.len() && !out.is_char_boundary(start) {
            start += 1;
        }
        out = out[start..].to_string();
    }
    out
}

fn server_log_is_missing(exit_code: u32, stderr: &str) -> bool {
    // Windows 脚本用固定退出码标记「文件不存在」，不依赖本地化报错文本。
    if exit_code == SERVER_LOG_MISSING_EXIT {
        return true;
    }
    if exit_code == 0 {
        return false;
    }
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("no such file") || stderr.contains("没有那个文件")
}

/// 单段日志的读取结果：`Ok(None)` 表示文件不存在（该段跳过），
/// `Err` 表示读取本身失败（权限、连接中断等，需要上抛）。
fn server_log_section(
    exit_code: u32,
    stdout: &str,
    stderr: &str,
) -> Result<Option<String>, String> {
    if server_log_is_missing(exit_code, stderr) {
        return Ok(None);
    }
    if exit_code != 0 {
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            format!("退出码 {exit_code}")
        } else {
            detail.to_string()
        };
        return Err(format!("读取远端代理日志失败：{detail}"));
    }
    Ok(Some(truncate_server_log(stdout)))
}

/// 拼接 daemon 日志与项目 serve 日志：文件不存在的段落直接跳过；两段都在时
/// 以带路径的分隔行隔开，前端日志面板里能直接看到各自来源；两段都缺时保留
/// 「日志不存在」的说明文字。
fn merge_server_logs(daemon: Option<&str>, serve_log_path: &str, serve: Option<&str>) -> String {
    // 只裁段尾换行；纯空白的段落（Windows 缺文件时 stdout 为空）按缺失处理。
    let daemon = daemon
        .map(str::trim_end)
        .filter(|text| !text.trim().is_empty());
    let serve = serve
        .map(str::trim_end)
        .filter(|text| !text.trim().is_empty());
    match (daemon, serve) {
        (Some(daemon), Some(serve)) => {
            format!("{daemon}\n===== project serve log: {serve_log_path} =====\n{serve}")
        }
        (Some(daemon), None) => daemon.to_string(),
        (None, Some(serve)) => serve.to_string(),
        (None, None) => SERVER_LOG_MISSING.to_string(),
    }
}

pub(crate) fn state_for_root(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<SshServerState, String> {
    let parsed = parse_remote_uri(&root.uri)?;
    let key = server::server_slot_key(&parsed.connection_id, &root.canonical_path);
    let slot = manager.server_slot(&key);
    let view = slot.as_ref().map(|slot| ServerSlotView {
        endpoint_has_daemon: slot
            .endpoint
            .as_ref()
            .map(|endpoint| endpoint.daemon.is_some()),
        unavailable_reason: slot.unavailable_reason.as_deref(),
        activity: slot.activity,
        last_failure: slot.last_failure.as_deref(),
    });
    let mut state = phase_for_slot(&ServerSteadyInputs {
        connection_id: &parsed.connection_id,
        root_uri: &normalize_remote_uri(&root.uri),
        session_connected: manager.connection_is_open(&parsed.connection_id),
        connection_mode: manager.connection_mode(&parsed.connection_id),
        trusted: root.trusted,
        slot: view,
    });
    if manager.direct_config(&parsed.connection_id).is_some() {
        state.transport = Some(ServerTransport::Agent);
    }
    match state.phase {
        ServerPhase::ReadyServer => {
            state.timings = slot.and_then(|slot| slot.last_timings);
        }
        // 意外断线（保活超时、远端断开）带上原因；用户主动断开时没有原因。
        ServerPhase::Disconnected => {
            state.reason = manager.connection_closed_reason(&parsed.connection_id);
        }
        _ => {}
    }
    Ok(state)
}

fn emit_state(app: &AppHandle, manager: &SshManager, state: &SshServerState) {
    if manager.record_server_snapshot(state) {
        let _ = app.emit(SSH_SERVER_STATE_EVENT, state);
    }
}

pub(crate) fn publish_root_state(app: &AppHandle, manager: &SshManager, root: &RegisteredRoot) {
    if let Ok(state) = state_for_root(manager, root) {
        emit_state(app, manager, &state);
    }
}

pub(crate) fn publish_authenticating(
    app: &AppHandle,
    manager: &SshManager,
    connection_id: &str,
    root_uri: &str,
) {
    emit_state(
        app,
        manager,
        &SshServerState {
            connection_id: connection_id.to_string(),
            root_uri: normalize_remote_uri(root_uri),
            phase: ServerPhase::Authenticating,
            mode: ServerMode::Unknown,
            connection_mode: manager.connection_mode(connection_id),
            version: None,
            transport: None,
            reason: None,
            timings: None,
        },
    );
}

pub(crate) fn publish_disconnected(
    app: &AppHandle,
    manager: &SshManager,
    connection_id: &str,
    root_uri: &str,
) {
    emit_state(
        app,
        manager,
        &SshServerState {
            connection_id: connection_id.to_string(),
            root_uri: normalize_remote_uri(root_uri),
            phase: ServerPhase::Disconnected,
            mode: ServerMode::Unknown,
            connection_mode: manager.connection_mode(connection_id),
            version: None,
            transport: None,
            reason: None,
            timings: None,
        },
    );
}

/// 把部署中的阶段写进 slot，并在有 AppHandle 时发布。
pub(crate) fn note_server_activity(
    manager: &SshManager,
    app: Option<&AppHandle>,
    root: &RegisteredRoot,
    connection_id: &str,
    activity: ServerPhase,
) {
    let key = server::server_slot_key(connection_id, &root.canonical_path);
    manager.set_server_activity(&key, Some(activity));
    if let Some(app) = app {
        publish_root_state(app, manager, root);
    }
}

fn require_registered_root(manager: &SshManager, root_uri: &str) -> Result<RegisteredRoot, String> {
    parse_remote_uri(root_uri)?;
    manager.registered_root(root_uri)
}

/// restart / logs / stop 这类直接操作远端进程与文件的命令要求根已信任：
/// 未信任的工作区不允许以我们的身份在远端执行任何命令。
pub(super) fn require_trusted_root(
    manager: &SshManager,
    root_uri: &str,
) -> Result<RegisteredRoot, String> {
    let root = require_registered_root(manager, root_uri)?;
    if !root.trusted {
        return Err(REASON_UNTRUSTED_COMMAND.to_string());
    }
    Ok(root)
}

/// 只在 server.json 解析出 pid 和状态路径后，才复用 [`server::kill_server_command`]。
/// 不按用户字符串拼 shell，也不杀 daemon 或其他 pid。
async fn stop_recorded_serve_server(manager: &SshManager, root: &RegisteredRoot) {
    let Ok(parsed) = parse_remote_uri(&root.uri) else {
        return;
    };
    let state_path = server::server_state_path(&root.canonical_path);
    let Ok(sftp) = manager.open_sftp(&parsed.connection_id).await else {
        return;
    };
    let Ok(bytes) = sftp.read(state_path.clone()).await else {
        return;
    };
    let Ok(state) = server::parse_server_state(&bytes) else {
        return;
    };
    let command = server::kill_server_command(state.pid, &state_path);
    let native_state = windows_native_path(&state_path).unwrap_or(state_path);
    let windows_script = server::windows_kill_server_script(state.pid, &native_state);
    let _ = manager
        .exec_remote_shell(
            &root.uri,
            &command,
            &windows_script,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await;
}

pub(crate) fn ssh_server_info(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<SshServerState, String> {
    let root = require_registered_root(&manager, &root_uri)?;
    state_for_root(&manager, &root)
}

/// 重启、日志只属于 Server 模式；SSH 模式的连接不部署也不读取远端 server。
/// 停止不受此限：切换到 SSH 模式前后都允许清理遗留的远端进程。
fn require_server_mode_connection(manager: &SshManager, connection_id: &str) -> Result<(), String> {
    if manager.server_mode(connection_id) {
        Ok(())
    } else {
        Err(REASON_SSH_MODE_COMMAND.to_string())
    }
}

pub(crate) async fn ssh_server_update(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshServerState, String> {
    let root = require_trusted_root(&manager, &root_uri)?;
    let parsed = parse_remote_uri(&root.uri)?;
    if manager.direct_config(&parsed.connection_id).is_some() {
        return Err("Server 端口直连不支持通过 SSH 更新服务，请在远端管理服务".into());
    }
    manager.session(&parsed.connection_id)?;
    require_server_mode_connection(&manager, &parsed.connection_id)?;
    server::update_server_endpoint_with_app(&manager, &root, Some(&app)).await?;
    state_for_root(&manager, &root)
}

pub(crate) async fn ssh_server_restart(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshServerState, String> {
    let root = require_trusted_root(&manager, &root_uri)?;
    let parsed = parse_remote_uri(&root.uri)?;
    if let Some(config) = manager.direct_config(&parsed.connection_id) {
        super::direct::test(&config).await?;
        super::direct::close_connection(&config.endpoint, &parsed.connection_id);
        let key = server::server_slot_key(&parsed.connection_id, &root.canonical_path);
        manager.stop_watch_supervisor(&key);
        manager.start_workspace_watch(app.clone(), &root);
        publish_root_state(&app, &manager, &root);
        return state_for_root(&manager, &root);
    }
    manager.session(&parsed.connection_id)?;
    require_server_mode_connection(&manager, &parsed.connection_id)?;
    let key = server::server_slot_key(&parsed.connection_id, &root.canonical_path);
    // 重启应把 serve 与 daemon 一起重建：daemon 活着时先请求其退出
    // （`server.shutdown`），发送失败（不在/通道坏/token 失效）只跳过——
    // 随后的 ensure 会重新拉起 daemon。
    if let Some(daemon) = manager
        .server_slot(&key)
        .and_then(|slot| slot.endpoint)
        .and_then(|endpoint| endpoint.daemon)
    {
        server::shutdown_remote_daemon(&manager, &parsed.connection_id, &daemon).await;
    }
    server::invalidate_shared_daemon(&manager, &parsed.connection_id);
    // 先停已记录的 serve 进程，再清 slot，避免 ensure 立刻复用刚要重启的端点。
    stop_recorded_serve_server(&manager, &root).await;
    manager.clear_server_endpoint(&key);
    publish_root_state(&app, &manager, &root);
    server::ensure_server_endpoint_with_app(&manager, &root, Some(&app)).await?;
    state_for_root(&manager, &root)
}

/// 停止本项目绑定。用户级 daemon 可能正承载其他连接的终端，不能随项目停止。
pub(crate) async fn ssh_server_stop(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let root = require_trusted_root(&manager, &root_uri)?;
    let parsed = parse_remote_uri(&root.uri)?;
    if manager.direct_config(&parsed.connection_id).is_some() {
        return Err("Server 直连的服务由远端独立管理；请断开工作区或在远端停止服务".into());
    }
    manager.session(&parsed.connection_id)?;
    let key = server::server_slot_key(&parsed.connection_id, &root.canonical_path);
    manager.pause_project_server(&key);
    // Project serve state belongs to a path, rather than a saved connection ID.
    // Conservatively leave it running if another registered root uses that path.
    let used_elsewhere = manager.roots.read().is_ok_and(|roots| {
        roots
            .values()
            .any(|other| other.canonical_path == root.canonical_path && other.uri != root.uri)
    });
    if !used_elsewhere {
        stop_recorded_serve_server(&manager, &root).await;
    }
    publish_root_state(&app, &manager, &root);
    Ok(())
}

pub(crate) async fn ssh_server_logs(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<SshServerLogs, String> {
    let root = require_trusted_root(&manager, &root_uri)?;
    require_server_mode_connection(&manager, &parse_remote_uri(&root.uri)?.connection_id)?;
    // 段一：daemon 日志（固定路径，远端 home 下）。
    let daemon = manager
        .exec_remote_shell(
            &root.uri,
            SERVER_LOG_TAIL_COMMAND,
            &windows_daemon_log_script(),
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
        .and_then(|result| server_log_section(result.exit_code, &result.stdout, &result.stderr))?;
    // 段二：项目 serve 日志（serve 的 stdout/stderr 落在这里）。
    let serve_log = server::server_serve_log_path(&root.canonical_path);
    let serve = manager
        .exec_remote_shell(
            &root.uri,
            &serve_log_tail_command(&serve_log),
            &windows_serve_log_script(&serve_log),
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
        .and_then(|result| server_log_section(result.exit_code, &result.stdout, &result.stderr))?;
    Ok(SshServerLogs {
        text: merge_server_logs(daemon.as_deref(), &serve_log, serve.as_deref()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_diagnostic_export_keeps_complete_json_and_masks_stderr_credentials() {
        let output = diagnostic_sections(concat!(
            "__QINGCODE_DIAGNOSTIC_SECTION__:lifecycle.jsonl\n",
            "partial UTF8 / JSON record\n",
            "{\"event\":\"pty.exited\",\"fields\":{\"exitCode\":1}}\n",
            "__QINGCODE_DIAGNOSTIC_SECTION__:daemon.stderr.log\n",
            "authorization: bearer sensitive-value\n",
            "__QINGCODE_DIAGNOSTIC_SECTION__:incident\n",
            "{\"event\":\"pty.kill_requested\"}\n",
        ));
        let records: Vec<serde_json::Value> = output
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(records.iter().any(|line| line["event"] == "pty.exited"));
        assert!(records
            .iter()
            .any(|line| line["event"] == "pty.kill_requested"));
        assert!(!output.contains("sensitive-value"));
        assert!(!output.contains("partial UTF8"));
        assert!(WINDOWS_DIAGNOSTIC_SCRIPT.contains("ReadWrite -bor [System.IO.FileShare]::Delete"));
        assert!(WINDOWS_DIAGNOSTIC_SCRIPT.contains("Select-Object -First 2"));
    }

    fn inputs<'a>(
        session_connected: bool,
        server_mode: bool,
        trusted: bool,
        slot: Option<ServerSlotView<'a>>,
    ) -> ServerSteadyInputs<'a> {
        ServerSteadyInputs {
            connection_id: "c1",
            root_uri: "ssh://c1/srv/app",
            session_connected,
            connection_mode: Some(if server_mode {
                RemoteMode::Server
            } else {
                RemoteMode::Ssh
            }),
            trusted,
            slot,
        }
    }

    fn ready_inputs(slot: Option<ServerSlotView<'_>>) -> ServerSteadyInputs<'_> {
        inputs(true, true, true, slot)
    }

    fn assert_direct(state: &SshServerState, reason: &str) {
        assert_eq!(state.phase, ServerPhase::ReadyDirect);
        assert_eq!(state.mode, ServerMode::Direct);
        assert_eq!(state.transport, Some(ServerTransport::Direct));
        assert_eq!(state.version, None);
        assert_eq!(state.reason.as_deref(), Some(reason));
        assert_eq!(state.connection_id, "c1");
        assert_eq!(state.root_uri, "ssh://c1/srv/app");
    }

    #[test]
    fn ssh_mode_connection_is_ready_direct() {
        let state = phase_for_slot(&inputs(true, false, true, None));
        assert_direct(&state, REASON_SSH_MODE);
        assert_eq!(state.connection_mode, Some(RemoteMode::Ssh));
    }

    #[test]
    fn unknown_connection_mode_never_deploys() {
        // 会话尚未经 ssh_connect 定下模式时按直连处理，不能默认成 Server。
        let mut input = inputs(true, true, true, None);
        input.connection_mode = None;
        let state = phase_for_slot(&input);
        assert_direct(&state, REASON_SSH_MODE);
    }

    #[test]
    fn untrusted_root_is_ready_direct() {
        let state = phase_for_slot(&inputs(true, true, false, None));
        assert_direct(&state, REASON_UNTRUSTED);
    }

    #[test]
    fn daemon_endpoint_is_ready_server() {
        let state = phase_for_slot(&ready_inputs(Some(ServerSlotView {
            endpoint_has_daemon: Some(true),
            unavailable_reason: None,
            activity: None,
            last_failure: None,
        })));
        assert_eq!(state.phase, ServerPhase::ReadyServer);
        assert_eq!(state.mode, ServerMode::Server);
        assert_eq!(state.transport, Some(ServerTransport::Daemon));
        assert_eq!(
            state.version.as_deref(),
            Some(qingcode_server::SERVER_VERSION)
        );
        assert_eq!(state.reason, None);
    }

    #[test]
    fn serve_endpoint_is_ready_server_without_daemon() {
        let state = phase_for_slot(&ready_inputs(Some(ServerSlotView {
            endpoint_has_daemon: Some(false),
            unavailable_reason: None,
            activity: None,
            last_failure: None,
        })));
        assert_eq!(state.phase, ServerPhase::ReadyServer);
        assert_eq!(state.mode, ServerMode::Server);
        assert_eq!(state.transport, Some(ServerTransport::Serve));
        assert_eq!(
            state.version.as_deref(),
            Some(qingcode_server::SERVER_VERSION)
        );
        assert_eq!(state.reason, None);
    }

    #[test]
    fn unavailable_reason_is_ready_direct() {
        let state = phase_for_slot(&ready_inputs(Some(ServerSlotView {
            endpoint_has_daemon: None,
            unavailable_reason: Some("远端架构不支持（armv7l）"),
            activity: None,
            last_failure: None,
        })));
        assert_direct(&state, "远端架构不支持（armv7l）");
    }

    #[test]
    fn connected_without_slot_is_probing() {
        let state = phase_for_slot(&ready_inputs(None));
        assert_eq!(state.phase, ServerPhase::Probing);
        assert_eq!(state.mode, ServerMode::Unknown);
        assert_eq!(state.transport, None);
        assert_eq!(state.version, None);
        assert_eq!(state.reason, None);
    }

    #[test]
    fn last_failure_keeps_probing_but_surfaces_reason() {
        // 瞬时失败不是终态：阶段保持探测（之后自动重试），但原因要能展示，
        // 芯片不再是「正在探测」却查不出任何解释。
        let state = phase_for_slot(&ready_inputs(Some(ServerSlotView {
            endpoint_has_daemon: None,
            unavailable_reason: None,
            activity: None,
            last_failure: Some("获取 manifest 失败：status code 404"),
        })));
        assert_eq!(state.phase, ServerPhase::Probing);
        assert_eq!(state.mode, ServerMode::Unknown);
        assert_eq!(state.transport, None);
        assert_eq!(state.version, None);
        assert_eq!(
            state.reason.as_deref(),
            Some("获取 manifest 失败：status code 404")
        );
    }

    #[test]
    fn unavailable_reason_wins_over_last_failure() {
        let state = phase_for_slot(&ready_inputs(Some(ServerSlotView {
            endpoint_has_daemon: None,
            unavailable_reason: Some("远端架构不支持（armv7l）"),
            activity: None,
            last_failure: Some("获取 manifest 失败：status code 404"),
        })));
        assert_direct(&state, "远端架构不支持（armv7l）");
    }

    #[test]
    fn activity_wins_over_last_failure() {
        // 新一轮部署已在进行：展示进行中阶段，不再显示上次的失败原因。
        let state = phase_for_slot(&ready_inputs(Some(ServerSlotView {
            endpoint_has_daemon: None,
            unavailable_reason: None,
            activity: Some(ServerPhase::Installing),
            last_failure: Some("server 启动超时"),
        })));
        assert_eq!(state.phase, ServerPhase::Installing);
        assert_eq!(state.reason, None);
    }

    #[test]
    fn missing_session_is_disconnected_even_with_endpoint() {
        let state = phase_for_slot(&inputs(
            false,
            true,
            true,
            Some(ServerSlotView {
                endpoint_has_daemon: Some(true),
                unavailable_reason: None,
                activity: Some(ServerPhase::Handshaking),
                last_failure: None,
            }),
        ));
        assert_eq!(state.phase, ServerPhase::Disconnected);
        assert_eq!(state.mode, ServerMode::Unknown);
        assert_eq!(state.transport, None);
        assert_eq!(state.version, None);
        assert_eq!(state.reason, None);
    }

    #[test]
    fn installing_activity_wins_over_a_cached_endpoint() {
        let state = phase_for_slot(&ready_inputs(Some(ServerSlotView {
            endpoint_has_daemon: Some(true),
            unavailable_reason: None,
            activity: Some(ServerPhase::Installing),
            last_failure: None,
        })));
        assert_eq!(state.phase, ServerPhase::Installing);
        assert_eq!(state.mode, ServerMode::Unknown);
        assert_eq!(state.transport, None);
    }

    #[test]
    fn disabled_gate_wins_over_installing_activity() {
        let state = phase_for_slot(&inputs(
            true,
            false,
            true,
            Some(ServerSlotView {
                endpoint_has_daemon: None,
                unavailable_reason: None,
                activity: Some(ServerPhase::Installing),
                last_failure: None,
            }),
        ));
        assert_direct(&state, REASON_SSH_MODE);
    }

    #[test]
    fn legal_path_reaches_ready_server_and_fallback_is_open() {
        let forward = [
            ServerPhase::Disconnected,
            ServerPhase::Probing,
            ServerPhase::Installing,
            ServerPhase::Handshaking,
            ServerPhase::ReadyServer,
        ];
        for pair in forward.windows(2) {
            assert!(
                server_phase_transition_allowed(pair[0], pair[1]),
                "{:?} → {:?}",
                pair[0],
                pair[1]
            );
        }
        assert!(server_phase_transition_allowed(
            ServerPhase::Disconnected,
            ServerPhase::Authenticating
        ));
        assert!(server_phase_transition_allowed(
            ServerPhase::Authenticating,
            ServerPhase::Probing
        ));
        let phases = [
            ServerPhase::Disconnected,
            ServerPhase::Authenticating,
            ServerPhase::Probing,
            ServerPhase::Installing,
            ServerPhase::Handshaking,
            ServerPhase::ReadyServer,
            ServerPhase::ReadyDirect,
        ];
        for phase in phases {
            assert!(server_phase_transition_allowed(
                phase,
                ServerPhase::ReadyDirect
            ));
            assert!(server_phase_transition_allowed(
                phase,
                ServerPhase::Disconnected
            ));
        }
    }

    #[test]
    fn disconnected_cannot_skip_to_ready_server() {
        assert!(!server_phase_transition_allowed(
            ServerPhase::Disconnected,
            ServerPhase::ReadyServer
        ));
        assert!(!server_phase_transition_allowed(
            ServerPhase::Disconnected,
            ServerPhase::Installing
        ));
        assert!(!server_phase_transition_allowed(
            ServerPhase::Disconnected,
            ServerPhase::Handshaking
        ));
        assert!(!server_phase_transition_allowed(
            ServerPhase::Installing,
            ServerPhase::ReadyServer
        ));
    }

    #[test]
    fn ssh_server_state_serializes_camel_case_with_nulls() {
        let ready = phase_for_slot(&ready_inputs(Some(ServerSlotView {
            endpoint_has_daemon: Some(true),
            unavailable_reason: None,
            activity: None,
            last_failure: None,
        })));
        let value = serde_json::to_value(&ready).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "connectionId",
                "connectionMode",
                "mode",
                "phase",
                "reason",
                "rootUri",
                "timings",
                "transport",
                "version",
            ]
        );
        // 耗时摘要由 state_for_root 按 slot 填充；纯阶段计算不带。
        assert!(value["timings"].is_null());
        assert_eq!(value["connectionId"], "c1");
        assert_eq!(value["rootUri"], "ssh://c1/srv/app");
        assert_eq!(value["phase"], "readyServer");
        assert_eq!(value["mode"], "server");
        assert_eq!(value["connectionMode"], "server");
        assert_eq!(value["version"], qingcode_server::SERVER_VERSION);
        assert_eq!(value["transport"], "daemon");
        assert!(value["reason"].is_null());
        assert!(value.get("connection_id").is_none());

        let direct = phase_for_slot(&inputs(true, true, false, None));
        let value = serde_json::to_value(&direct).unwrap();
        assert_eq!(value["phase"], "readyDirect");
        assert_eq!(value["mode"], "direct");
        assert!(value["version"].is_null());
        assert_eq!(value["transport"], "direct");
        assert_eq!(value["reason"], REASON_UNTRUSTED);
        let restored: SshServerState = serde_json::from_value(value).unwrap();
        assert_eq!(restored, direct);
    }

    #[test]
    fn truncate_server_log_keeps_the_tail_within_line_and_byte_caps() {
        let text = (0..500)
            .map(|index| format!("line-{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let truncated = truncate_server_log(&text);
        let lines: Vec<_> = truncated.lines().collect();
        assert_eq!(lines.len(), SERVER_LOG_MAX_LINES);
        assert_eq!(lines[0], "line-300");
        assert_eq!(lines[199], "line-499");
        assert_eq!(truncate_server_log("short"), "short");

        let long = "字".repeat(70_000);
        let truncated = truncate_server_log(&long);
        assert!(truncated.len() <= SERVER_LOG_MAX_BYTES);
        assert!(truncated.ends_with('字'));
        assert!(!truncated.is_empty());
    }

    #[test]
    fn server_log_command_reads_the_fixed_daemon_log() {
        assert_eq!(
            SERVER_LOG_TAIL_COMMAND,
            "tail -n 200 \"$HOME/.qingcode/server/run/server.log\""
        );
        assert!(!SERVER_LOG_TAIL_COMMAND.contains("{"));
        let windows_daemon = windows_daemon_log_script();
        assert!(windows_daemon
            .contains("Join-Path $env:USERPROFILE '.qingcode\\server\\run\\server.log'"));
        assert!(windows_daemon.contains("[System.IO.FileShare]::ReadWrite"));
        assert!(windows_daemon.contains("[System.IO.StreamReader]::new($stream, $utf8, $true)"));
        assert!(!windows_daemon.contains("Get-Content"));
        // unix：tail 报 No such file → 该段跳过（None），不再占位说明文字。
        assert_eq!(
            server_log_section(1, "", "tail: cannot open: No such file or directory").unwrap(),
            None
        );
        assert_eq!(
            server_log_section(0, "hello\n", "").unwrap().as_deref(),
            Some("hello")
        );
        // Windows 脚本用固定退出码标记缺失，不受系统语言影响。
        assert_eq!(
            server_log_section(SERVER_LOG_MISSING_EXIT, "", "").unwrap(),
            None
        );
        // 其余非零退出是真实读取失败，必须上抛。
        assert!(server_log_section(1, "", "permission denied").is_err());
    }

    #[test]
    fn merge_server_logs_concatenates_present_sections_only() {
        let path = "/srv/app/.qingcode/server/serve.log";
        // 两段都在：分隔行带 serve 日志路径，便于在日志面板里定位来源。
        let merged = merge_server_logs(Some("daemon\n"), path, Some("serve\n"));
        assert_eq!(
            merged,
            format!("daemon\n===== project serve log: {path} =====\nserve")
        );
        // 只有 daemon / 只有 serve：存在的段落原样返回，不造空段。
        assert_eq!(merge_server_logs(Some("daemon"), path, None), "daemon");
        assert_eq!(merge_server_logs(None, path, Some("serve")), "serve");
        // 两段都缺：保留「日志不存在」的说明。
        assert_eq!(merge_server_logs(None, path, None), SERVER_LOG_MISSING);
        // 空白内容的段落按缺失处理（Windows 缺文件时 stdout 为空）。
        assert_eq!(
            merge_server_logs(Some("  \n"), path, None),
            SERVER_LOG_MISSING
        );
    }

    #[test]
    fn serve_log_tail_command_quotes_the_path() {
        let command = serve_log_tail_command("/srv/a b/.qingcode/server/serve.log");
        assert!(command.contains("tail -n 200"));
        // 项目根可能带空格，路径必须整体单引号包裹。
        assert!(command.contains("'/srv/a b/.qingcode/server/serve.log'"));
        let script = windows_serve_log_script("/D:/code/app/.qingcode/server/serve.log");
        assert!(script.contains(r"$log = 'D:\code\app\.qingcode\server\serve.log'"));
        // 日志固定按 UTF-8 解码并原样写字节，不能回退到受系统代码页影响的 Get-Content。
        assert!(script.contains("[System.Text.UTF8Encoding]::new($false)"));
        assert!(script.contains("[System.IO.FileShare]::ReadWrite"));
        assert!(script.contains("[System.IO.StreamReader]::new($stream, $utf8, $true)"));
        assert!(script.contains("[Console]::OpenStandardOutput()"));
        assert!(!script.contains("Get-Content"));
        // 退出码标记与判定函数共用同一常量，避免两处数字漂移。
        assert!(script.contains(&format!("exit {SERVER_LOG_MISSING_EXIT}")));
    }

    #[test]
    fn untrusted_command_gate_uses_dedicated_message() {
        // restart / logs / stop 的未信任错误与状态机里的 ReadyDirect 原因
        // 是两套文案：前者是命令报错，后者是 UI 说明，不能复用。
        assert_eq!(REASON_UNTRUSTED_COMMAND, "工作区未信任，无法操作远端服务");
        assert_ne!(REASON_UNTRUSTED_COMMAND, REASON_UNTRUSTED);
    }
}
