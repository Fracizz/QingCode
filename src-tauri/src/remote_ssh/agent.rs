//! SSH 远端代理（qingcode-agent）的客户端集成。
//!
//! scan / search / watch 有两条传输路径，按顺序回退：
//! - **daemon 传输**（优先）：SSH exec 通道运行 `connect --stdio --ensure-daemon`，
//!   与远端常驻 daemon 之间走协议 v1 帧流（`qingcode_agent::proto`）；
//! - **serve 传输**（回退）：每操作一条 `direct-tcpip` 通道连远端 `127.0.0.1:<port>`，
//!   JSON 帧（`AgentRequest` / `AgentResponse`）。
//!
//! 所有集成点都遵循同一策略：agent 任何一级失败都静默回退到下一级
//! （daemon → serve → 直连 SFTP / rg / 独立 PTY 终端），绝不影响既有功能。

use std::io;

use super::*;
use qingcode_agent::proto::{
    self, ErrorBody, Event, Frame, HelloRequest, HelloResponse, Kind, ReceiverWindow, Request,
    Response, StreamChunk, StreamEnd, WindowCredit, CONTROL_STREAM, PROTOCOL_VERSION, WINDOW_BYTES,
};
use qingcode_agent::{
    read_frame, write_frame, AgentOp, AgentRequest, AgentResponse, AgentStateFile, AGENT_VERSION,
};

/// agent 首次 ping / 单次往返的响应时限。
const AGENT_PING_TIMEOUT: Duration = Duration::from_secs(10);
/// 等待 agent 启动就绪（状态文件出现且 ping 通过）的总时限。
const AGENT_READY_TIMEOUT: Duration = Duration::from_secs(15);
/// agent 启动就绪轮询间隔。
const AGENT_READY_POLL: Duration = Duration::from_millis(300);
/// watch 通道异常断开后重启前的间隔。
const AGENT_WATCH_RESTART_DELAY: Duration = Duration::from_secs(2);
/// endpoint 尚未就绪时监督任务的重试间隔。
const AGENT_WATCH_RETRY_DELAY: Duration = Duration::from_secs(5);
/// endpoint 连续拿不到的次数上限，超过后监督任务退出。
const AGENT_WATCH_MAX_RETRIES: usize = 3;
/// watch 空闲轮询间隔：没有事件时定期回来检查会话存活与总开关。
const AGENT_WATCH_IDLE_POLL: Duration = Duration::from_secs(5);
/// watch 读帧超时：超过这个时间没收到任何帧就判定连接已死并重连。
///
/// 服务端每 15s 发一个心跳帧，45s 正好是 3 个心跳周期——既给慢网络留出
/// 抖动余量，又能在连接半死（TCP 未断开但不再有数据）时及时发现。超时只
/// 触发重连，不向前端发任何事件，避免空闲仓库被误判成变更。
const AGENT_WATCH_FRAME_TIMEOUT: Duration = Duration::from_secs(45);
/// daemon 握手应答时限：`connect --ensure-daemon` 可能在通道内现拉 daemon
/// （代理内部启动等待上限 10s），给足余量再判失败。
const AGENT_DAEMON_HELLO_TIMEOUT: Duration = Duration::from_secs(20);
/// 部署后 daemon 就绪探测的总时限（token 轮询 + 握手探针，超出即视为本轮无 daemon）。
const AGENT_DAEMON_ENSURE_TIMEOUT: Duration = Duration::from_secs(10);
/// daemon `fs.scan` 请求的整体时限（与 serve 路径的 15s 对齐）。
const AGENT_DAEMON_SCAN_TIMEOUT: Duration = Duration::from_secs(15);

/// 一个已就绪的远端 agent 端点。
#[derive(Clone)]
pub(crate) struct AgentEndpoint {
    pub(crate) port: u16,
    pub(crate) token: String,
    /// daemon 传输接入信息；`Some` 表示部署/发现后已通过真实握手探针验证。
    /// 操作失败时只会清掉这个标记（降级 serve），不会废弃整个端点。
    pub(crate) daemon: Option<DaemonAccess>,
}

/// daemon 传输的接入信息：远端二进制路径与会话 token。
///
/// token 由 daemon 启动时生成并写入 `~/.qingcode/agent/run/token`（`0600`），
/// 每次 daemon 重启都会轮换；校验失败时连接会被 daemon 直接断开。
#[derive(Clone)]
pub(crate) struct DaemonAccess {
    pub(crate) bin: String,
    pub(crate) token: String,
}

/// 每个连接 + 项目根的 agent 状态缓存：就绪端点或不可用原因。
/// 原因只记录「本次连接内不可能恢复」的情形（架构不支持、本地缺二进制），
/// 避免每次目录扫描都重复探测部署；瞬时失败不写原因，下次调用会再试。
#[derive(Default, Clone)]
pub(crate) struct AgentSlot {
    pub(crate) endpoint: Option<AgentEndpoint>,
    pub(crate) unavailable_reason: Option<String>,
    /// 发现/部署过程中的瞬时阶段（installing / handshaking）。稳态为 None。
    pub(crate) activity: Option<agent_status::AgentPhase>,
}

pub(crate) fn agent_slot_key(connection_id: &str, canonical_root: &str) -> String {
    format!("{connection_id}|{canonical_root}")
}

pub(crate) fn agent_dir_path(canonical_root: &str) -> String {
    let root = canonical_root.trim_end_matches('/');
    format!("{root}/.qingcode/agent")
}

pub(crate) fn agent_state_path(canonical_root: &str) -> String {
    format!("{}/agent.json", agent_dir_path(canonical_root))
}

pub(crate) fn agent_binary_file_name(windows: bool, arch: &str) -> String {
    if windows {
        format!("qingcode-agent-windows-{arch}.exe")
    } else {
        format!("qingcode-agent-{arch}")
    }
}

pub(crate) fn agent_binary_path(canonical_root: &str, arch: &str) -> String {
    format!(
        "{}/{}",
        agent_dir_path(canonical_root),
        agent_binary_file_name(false, arch)
    )
}

pub(crate) fn agent_binary_remote_path(canonical_root: &str, windows: bool, arch: &str) -> String {
    format!(
        "{}/{}",
        agent_dir_path(canonical_root),
        agent_binary_file_name(windows, arch)
    )
}

/// Windows 远端打印 `x86_64` 或 `aarch64`。不调用 `uname`，OpenSSH 默认 shell 不一定有它。
pub(crate) fn windows_agent_arch_script() -> &'static str {
    r"$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') { 'aarch64' } elseif ($arch -eq 'AMD64') { 'x86_64' } else { $arch }"
}

fn windows_agent_path_ok(path: &str) -> bool {
    !path.is_empty() && !path.contains('"') && !path.contains('\n') && !path.contains('\r')
}

/// 脱离 OpenSSH 的 Job，避免 exec 通道结束时把 serve 进程一起杀掉。
/// 不允许 breakaway 时退回 `Start-Process`。
pub(crate) fn windows_deploy_agent_script(bin: &str, root: &str, state: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$bin = '{bin}'
$root = '{root}'
$state = '{state}'
if (-not (Test-Path -LiteralPath $bin)) {{ throw 'agent binary missing' }}
$flags = 0x08000000 -bor 0x00000008 -bor 0x01000000
$started = $false
try {{
  if (-not ('QingCode.AgentProc' -as [type])) {{
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class QingCodeAgentProc {{
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {{
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }}
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {{
    public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId;
  }}
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
}}
'@
  }}
  $si = New-Object QingCode.AgentProc+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
  $pi = New-Object QingCode.AgentProc+PROCESS_INFORMATION
  $cmd = '"' + $bin + '" serve --root "' + $root + '" --state "' + $state + '"'
  $dir = Split-Path -Parent $bin
  $ok = [QingCode.AgentProc]::CreateProcess($null, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, $flags, [IntPtr]::Zero, $dir, [ref]$si, [ref]$pi)
  if ($ok) {{
    [QingCode.AgentProc]::CloseHandle($pi.hThread) | Out-Null
    [QingCode.AgentProc]::CloseHandle($pi.hProcess) | Out-Null
    $started = $true
  }}
}} catch {{}}
if (-not $started) {{
  Start-Process -FilePath $bin -ArgumentList @('serve','--root',$root,'--state',$state) -WindowStyle Hidden -WorkingDirectory (Split-Path -Parent $bin)
}}
"#,
        bin = powershell_literal(bin),
        root = powershell_literal(root),
        state = powershell_literal(state),
    )
}

pub(crate) fn windows_remove_file_script(path: &str) -> String {
    format!(
        "Remove-Item -LiteralPath '{}' -Force -ErrorAction SilentlyContinue",
        powershell_literal(path)
    )
}

/// 先核对进程名和命令行里的状态文件路径，再结束 serve。对不上就不杀。
pub(crate) fn windows_kill_agent_script(pid: u32, state_path: &str) -> String {
    format!(
        r"$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' -ErrorAction SilentlyContinue
if ($p -and $p.Name -like 'qingcode-agent*' -and $p.CommandLine -and $p.CommandLine.Contains('{state}')) {{
  Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue
}}",
        pid = pid,
        state = powershell_literal(state_path),
    )
}

fn windows_host_path(remote_path: &str) -> Option<String> {
    windows_native_path(remote_path).filter(|path| windows_agent_path_ok(path))
}

fn windows_deploy_for(
    remote_bin: &str,
    remote_root: &str,
    remote_state: &str,
) -> Result<String, String> {
    if windows_native_path(remote_root).is_none() {
        return Ok(String::new());
    }
    let bin = windows_host_path(remote_bin).ok_or("Windows agent 路径无效")?;
    let root = windows_host_path(remote_root).ok_or("Windows 项目路径无效")?;
    let state = windows_host_path(remote_state).ok_or("Windows agent 状态路径无效")?;
    Ok(windows_deploy_agent_script(&bin, &root, &state))
}

fn windows_remove_for(remote_bin: &str) -> String {
    windows_host_path(remote_bin)
        .map(|path| windows_remove_file_script(&path))
        .unwrap_or_default()
}

fn windows_kill_for(state_path: &str, pid: u32) -> String {
    windows_host_path(state_path)
        .map(|path| windows_kill_agent_script(pid, &path))
        .unwrap_or_default()
}

async fn exec_on_root(
    manager: &SshManager,
    root: &RegisteredRoot,
    unix_command: &str,
    windows_script: &str,
) -> Result<RemoteExecResult, String> {
    manager
        .exec_remote_shell(
            &root.uri,
            unix_command,
            windows_script,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
}

/// 生成远端启动命令：`nohup setsid` 让 agent 脱离本次 SSH 会话存活，
/// 输出丢弃避免占用通道。参数逐个 shell_quote 防注入。token 由 agent
/// 启动时自生成并写进状态文件，客户端从状态文件读取，无需在命令行传递。
pub(crate) fn deploy_agent_command(bin: &str, root: &str, state: &str) -> String {
    format!(
        "nohup setsid {} serve --root {} --state {} >/dev/null 2>&1 &",
        shell_quote(bin),
        shell_quote(root),
        shell_quote(state)
    )
}

/// 幂等启动远端 daemon：`nohup setsid` 脱离本次 SSH 会话，输出丢弃；
/// 已有实例时新进程因抢不到 `flock` 直接退出 0，重复执行无副作用。
pub(crate) fn start_daemon_command(bin: &str) -> String {
    format!("nohup setsid {} daemon >/dev/null 2>&1 &", shell_quote(bin))
}

/// 连接代理命令：在 exec 通道内运行，随通道生灭。`--ensure-daemon` 让代理
/// 在 daemon 缺席时自行拉起（`flock` 保证单实例）。
pub(crate) fn connect_daemon_command(bin: &str) -> String {
    format!("{} connect --stdio --ensure-daemon", shell_quote(bin))
}

/// 读取 daemon 会话 token 的命令。token 由 daemon 启动时写入
/// `$HOME/.qingcode/agent/run/token`（权限 `0600`），仅同一 SSH 用户可读。
pub(crate) fn daemon_token_command() -> String {
    "cat \"$HOME/.qingcode/agent/run/token\" 2>/dev/null".to_string()
}

/// 生成清理旧 agent 的命令：先校验 `/proc/<pid>/cmdline` 的进程身份再 kill。
///
/// 状态文件可能是上一轮部署的残留（pid 已被系统复用）或别的项目根遗留，
/// 直接按状态文件里的 pid `kill` 会误杀远端无关进程。因此要求同一进程的
/// 命令行里既出现二进制名 `qingcode-agent`，`--state` 参数又正好等于本项目的
/// 状态文件路径；任一条件不满足就不产生任何副作用。整条命令以 `|| true`
/// 收尾，属于尽力而为的清理，失败不影响后续部署。
pub(crate) fn kill_agent_command(pid: u32, state_path: &str) -> String {
    // /proc/<pid>/cmdline 以 NUL 分隔参数，先转成换行再按行匹配：
    // `grep -qxF` 用整行精确比对，避免路径前缀相同（如 a 与 a2）误判。
    format!(
        "test -r /proc/{pid}/cmdline \
         && tr '\\000' '\\n' < /proc/{pid}/cmdline | grep -q -- qingcode-agent \
         && tr '\\000' '\\n' < /proc/{pid}/cmdline | grep -qxF -- {} \
         && kill {pid} 2>/dev/null || true",
        shell_quote(state_path)
    )
}

/// watch 事件过滤：跳过 agent 自身部署目录、终端粘贴临时目录与自写临时文件，
/// 防止客户端自己的写操作触发前端刷新循环。
pub(crate) fn should_skip_agent_watch_event(abs_path: &str, canonical_root: &str) -> bool {
    let root = canonical_root.trim_end_matches('/');
    let rel = abs_path.strip_prefix(root).unwrap_or(abs_path);
    let segments: Vec<&str> = rel
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    for window in segments.windows(2) {
        if window[0] == ".qingcode" && (window[1] == "agent" || window[1] == "terminal-paste") {
            return true;
        }
    }
    segments
        .last()
        .is_some_and(|name| name.ends_with(".tmp") || name.ends_with(".backup"))
}

/// 把 watch 事件的远端绝对路径转成资源 URI。
///
/// 基址必须用注册时的 `root_uri`（用户打开项目时给的路径），而不是 canonical
/// 路径：用户以符号链接路径打开项目时，前端按 `root_uri` 前缀做
/// `findProjectForPath` 匹配，用 canonical 路径拼出来的 URI 会匹配不上，
/// 表现为自动刷新静默失效。相对路径取自 canonical_root，因此两者都能自洽。
///
/// 路径必须词法上落在 canonical_root 内（按 '/' 分段边界），越界返回 None。
pub(crate) fn ssh_uri_for_watch_event(
    root_uri: &str,
    canonical_root: &str,
    abs: &str,
) -> Option<String> {
    let root = canonical_root.trim_end_matches('/');
    let abs = abs.trim_end_matches('/');
    if abs.is_empty() || !abs.starts_with('/') {
        return None;
    }
    // 根自身（或文件系统根）没有相对路径，直接返回注册 URI。
    let rel = if root.is_empty() {
        abs.trim_start_matches('/')
    } else if abs == root {
        ""
    } else {
        // 必须先剥掉完整的根再加 '/', 否则 /srv/app2 会被当成 /srv/app 的子路径。
        let rest = abs.strip_prefix(root)?;
        rest.strip_prefix('/')?
    };
    if rel.is_empty() {
        return Some(normalize_remote_uri(root_uri));
    }
    Some(join_remote_uri(root_uri, rel))
}

pub(crate) fn parse_agent_state(bytes: &[u8]) -> Result<AgentStateFile, String> {
    let state: AgentStateFile = serde_json::from_slice(bytes)
        .map_err(|error| format!("解析 agent 状态文件失败：{error}"))?;
    if state.version.trim().is_empty() {
        return Err("agent 状态文件缺少版本号".to_string());
    }
    Ok(state)
}

/// 打开一条指向远端 agent 的 `direct-tcpip` 通道（单次尝试）。
async fn open_agent_channel_once(
    session: &ConnectedSession,
    port: u16,
) -> Result<russh::Channel<client::Msg>, ChannelOpenError> {
    let opened = tokio::time::timeout(
        SSH_CHANNEL_OPEN_TIMEOUT,
        session
            .handle
            .channel_open_direct_tcpip("127.0.0.1", u32::from(port), "127.0.0.1", 0),
    )
    .await;
    match opened {
        Ok(Ok(channel)) => Ok(channel),
        Ok(Err(error)) => Err(ChannelOpenError {
            message: format!("打开 agent 通道失败：{error}"),
            stale: is_stale_russh_error(&error) || session.handle.is_closed(),
        }),
        // 会话半死时开通道也不会返回；超时后探测一次再决定是否重连。
        Err(_) => Err(ChannelOpenError {
            message: "打开 SSH agent 通道超时，远端未响应".to_string(),
            stale: !connection_responds(&session.handle).await,
        }),
    }
}

/// 打开 agent 通道，镜像 `SshManager::open_session_channel` 的 stale/busy 处理。
pub(crate) async fn open_agent_channel(
    manager: &SshManager,
    connection_id: &str,
    port: u16,
) -> Result<russh::Channel<client::Msg>, String> {
    let session = manager.live_session(connection_id).await?;
    match open_agent_channel_once(&session, port).await {
        Ok(channel) => Ok(channel),
        Err(error) if error.stale => {
            let session = manager
                .reconnect_after_channel_failure(connection_id, &session)
                .await?;
            Ok(open_agent_channel_once(&session, port).await?)
        }
        Err(error) => Err(error.message),
    }
}

/// 发送一个请求帧并读取单个响应帧（带超时）。
async fn agent_roundtrip(
    channel: russh::Channel<client::Msg>,
    request: &AgentRequest,
) -> Result<AgentResponse, String> {
    let mut stream = channel.into_stream();
    let payload =
        serde_json::to_vec(request).map_err(|error| format!("编码 agent 请求失败：{error}"))?;
    write_frame(&mut stream, &payload)
        .await
        .map_err(|error| format!("发送 agent 请求失败：{error}"))?;
    let bytes = tokio::time::timeout(AGENT_PING_TIMEOUT, read_frame(&mut stream))
        .await
        .map_err(|_| "agent 响应超时".to_string())?
        .map_err(|error| format!("读取 agent 响应失败：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("解析 agent 响应失败：{error}"))
}

/// ping 校验：响应必须是 `Ok` 且版本与客户端一致（不一致说明需要重新部署）。
async fn ping_agent(
    manager: &SshManager,
    connection_id: &str,
    endpoint: &AgentEndpoint,
) -> Result<(), String> {
    let channel = open_agent_channel(manager, connection_id, endpoint.port).await?;
    let request = AgentRequest {
        token: endpoint.token.clone(),
        op: AgentOp::Ping,
    };
    match agent_roundtrip(channel, &request).await? {
        AgentResponse::Ok { version } if version == AGENT_VERSION => Ok(()),
        AgentResponse::Ok { version } => Err(format!(
            "agent 版本不匹配：远端 {version}，本端 {AGENT_VERSION}"
        )),
        AgentResponse::Error { message } => Err(message),
        _ => Err("agent 返回了意外的 ping 响应".to_string()),
    }
}

/// 在已有状态文件中发现存活 agent：版本一致且 ping 通过才算可用。
/// 版本不一致时尽力 kill 旧进程（错误忽略），随后走部署流程。
async fn try_discover_agent(
    manager: &SshManager,
    connection_id: &str,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
) -> Option<AgentEndpoint> {
    let state_path = agent_state_path(&root.canonical_path);
    let metadata = sftp.metadata(state_path.clone()).await.ok()?;
    if metadata.is_dir() {
        return None;
    }
    let bytes = sftp.read(state_path.clone()).await.ok()?;
    let state = parse_agent_state(&bytes).ok()?;
    if state.version != AGENT_VERSION {
        // 版本过期的 agent 不再复用；旧进程可能还占着端口，按身份校验后尽力清掉。
        let _ = exec_on_root(
            manager,
            root,
            &kill_agent_command(state.pid, &state_path),
            &windows_kill_for(&state_path, state.pid),
        )
        .await;
        return None;
    }
    let endpoint = AgentEndpoint {
        port: state.port,
        token: state.token,
        daemon: None,
    };
    // ping 之前进入握手；失败则调用方继续安装。
    agent_status::note_agent_activity(
        manager,
        app,
        root,
        connection_id,
        agent_status::AgentPhase::Handshaking,
    );
    ping_agent(manager, connection_id, &endpoint).await.ok()?;
    Some(endpoint)
}

/// 探测远端架构并找到本地对应的 agent 二进制。
async fn locate_local_agent_binary(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<(String, PathBuf), String> {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let arch = if windows {
        manager
            .exec_remote_shell(
                &root.uri,
                "uname -m",
                windows_agent_arch_script(),
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await?
            .stdout
    } else {
        manager
            .exec_command(&root.uri, "uname -m", None, true, REMOTE_EXEC_TIMEOUT)
            .await?
            .stdout
    };
    let arch = arch.trim().to_string();
    if arch != "x86_64" && arch != "aarch64" {
        return Err(format!("远端架构不支持（{arch}）"));
    }
    let binary_name = agent_binary_file_name(windows, &arch);
    for dir in manager.agent_binary_dirs() {
        let candidate = dir.join(&binary_name);
        if candidate.is_file() {
            return Ok((arch, candidate));
        }
    }
    // 随包未携带二进制（如便携版单文件 exe）：按设置从 GitHub Release 下载。
    if manager.agent_auto_download() {
        match download_agent_binary(manager, &binary_name).await {
            Ok(path) => return Ok((arch, path)),
            Err(error) => {
                return Err(format!(
                    "本地未找到 agent 二进制（{arch}），自动下载失败：{error}"
                ))
            }
        }
    }
    Err(format!(
        "本地未找到 QingCode agent 二进制（{binary_name}）。在线请打开「缺失时自动下载」；离线请把 agents 目录放到 QingCode.exe 旁边，或设置 QINGCODE_AGENT_DIR。已回退直连"
    ))
}

/// agent 二进制的 GitHub Release 下载基址（独立发布的 `agent-v<版本>` 系列标签）。
/// 可用 `QINGCODE_AGENT_DOWNLOAD_BASE` 覆盖（镜像/内网源）。
fn agent_download_base() -> String {
    if let Ok(base) = std::env::var("QINGCODE_AGENT_DOWNLOAD_BASE") {
        let base = base.trim_end_matches('/').to_string();
        if !base.is_empty() {
            return base;
        }
    }
    "https://github.com/Fracizz/QingCode/releases/download".to_string()
}

fn agent_release_tag() -> String {
    format!("agent-v{}", qingcode_agent::AGENT_VERSION)
}

/// 下载清单 URL 与二进制 URL（抽成纯函数便于单测）。
fn agent_download_urls(base: &str, tag: &str, binary_name: &str) -> (String, String) {
    (
        format!("{base}/{tag}/manifest.json"),
        format!("{base}/{tag}/{binary_name}"),
    )
}

#[derive(Debug, Clone, serde::Deserialize)]
struct AgentManifestArtifact {
    sha256: String,
    /// 保留以便未来做下载进度/体积预算；当前仅 manifest 完整性用。
    #[allow(dead_code)]
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct AgentManifest {
    /// 与 AGENT_VERSION 对应的发布版本；诊断日志用，运行时不读。
    #[allow(dead_code)]
    #[serde(default)]
    version: String,
    #[serde(default)]
    artifacts: std::collections::HashMap<String, AgentManifestArtifact>,
}

fn parse_agent_manifest(bytes: &[u8]) -> Result<AgentManifest, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("解析 agent manifest 失败：{e}"))
}

fn verify_agent_sha256(expected: &str, actual: &[u8; 32]) -> Result<(), String> {
    let actual_hex: String = actual.iter().map(|b| format!("{b:02x}")).collect();
    if actual_hex.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(format!(
            "agent 二进制 sha256 校验失败：期望 {expected}，实际 {actual_hex}"
        ))
    }
}

/// 从 GitHub Release 下载 agent 二进制到缓存目录（`ssh.agent.autoDownload`）。
/// 流程：取 manifest.json → 下载二进制（边下边算 sha256）→ 校验一致 → 原子落位。
/// 安全说明：清单与二进制来自同一 GitHub Release（HTTPS），校验保证传输完整性；
/// 不做代码签名，信任源是本仓库的 Release，可用环境变量指向内网镜像。
async fn download_agent_binary(manager: &SshManager, binary_name: &str) -> Result<PathBuf, String> {
    let cache_dir = manager.agent_cache_dir().ok_or("下载缓存目录未配置")?;
    let binary_name = binary_name.to_string();
    let (manifest_url, binary_url) =
        agent_download_urls(&agent_download_base(), &agent_release_tag(), &binary_name);
    tokio::task::spawn_blocking(move || {
        use sha2::Digest;
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(15))
            .timeout_read(std::time::Duration::from_secs(120))
            .build();
        let manifest_bytes = agent
            .get(&manifest_url)
            .call()
            .map_err(|e| format!("获取 manifest 失败：{e}"))?
            .into_string()
            .map_err(|e| format!("读取 manifest 失败：{e}"))?;
        let manifest = parse_agent_manifest(manifest_bytes.as_bytes())?;
        let expected = manifest
            .artifacts
            .get(&binary_name)
            .ok_or_else(|| format!("manifest 缺少 {binary_name} 条目"))?
            .sha256
            .clone();

        let response = agent
            .get(&binary_url)
            .call()
            .map_err(|e| format!("下载二进制失败：{e}"))?;
        let mut hasher = sha2::Sha256::new();
        let tmp_path = cache_dir.join(format!(".{binary_name}.download-{}", std::process::id()));
        std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败：{e}"))?;
        {
            let mut file =
                std::fs::File::create(&tmp_path).map_err(|e| format!("创建临时文件失败：{e}"))?;
            use std::io::Read;
            use std::io::Write as _;
            let mut reader = response.into_reader();
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| format!("下载中断：{e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                file.write_all(&buf[..n])
                    .map_err(|e| format!("写入临时文件失败：{e}"))?;
            }
            file.sync_all().ok();
        }
        let digest: [u8; 32] = hasher.finalize().into();
        verify_agent_sha256(&expected, &digest)?;
        let final_path = cache_dir.join(binary_name);
        // Windows 上 rename 不能覆盖已存在文件；先清旧再落位。
        let _ = std::fs::remove_file(&final_path);
        std::fs::rename(&tmp_path, &final_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("落位下载产物失败：{e}")
        })?;
        Ok(final_path)
    })
    .await
    .map_err(|e| format!("下载任务失败：{e}"))?
}

/// 在 agent 部署目录写一个忽略自身的 `.gitignore`：状态文件含连接 token，
/// 二进制也不该进用户仓库。已存在时按独占创建失败处理，不影响部署。
async fn write_agent_gitignore(sftp: &SftpSession, dir: &str) -> Result<(), String> {
    let mut file = sftp
        .open_with_flags(format!("{dir}/.gitignore"), remote_write_flags(true))
        .await
        .map_err(|error| format!("创建 agent .gitignore 失败：{error}"))?;
    file.write_all(b"*\n")
        .await
        .map_err(|error| format!("写入 agent .gitignore 失败：{error}"))?;
    file.shutdown()
        .await
        .map_err(|error| format!("完成 agent .gitignore 写入失败：{error}"))
}

/// 上传 agent 二进制：逐级建目录，临时文件 + rename 原子落位。
async fn upload_agent_binary(
    manager: &SshManager,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    local: &Path,
    remote_bin: &str,
) -> Result<(), String> {
    let dir = agent_dir_path(&root.canonical_path);
    let parent = format!("{}/.qingcode", root.canonical_path.trim_end_matches('/'));
    // 逐级建目录：SFTP 的 mkdir 不递归，父目录缺失时子目录必然失败。已存在则忽略错误。
    let _ = sftp.create_dir(parent).await;
    let _ = sftp.create_dir(dir.clone()).await;

    // 上传前先确认目录仍在项目根内（防止 root 被符号链接重定向）。
    let resolved_dir = sftp
        .canonicalize(dir.clone())
        .await
        .map_err(|error| format!("agent 部署目录不可用：{error}"))?;
    if !remote_path_is_within(&resolved_dir, &root.canonical_path) {
        return Err("agent 部署目录跳出了项目根".to_string());
    }

    // 状态文件含 token、二进制不该进用户仓库：目录内放一个忽略自身的 .gitignore。
    let _ = write_agent_gitignore(sftp, &resolved_dir).await;

    // 不做“远端已有同名文件就复用”的优化：版本升级后残留的旧二进制会让新
    // agent 以旧版本启动，导致 ping 版本校验永远失败（表现为永久不可用）。
    let bytes =
        std::fs::read(local).map_err(|error| format!("读取本地 agent 二进制失败：{error}"))?;
    // SFTP v3 的 rename 不覆盖已存在目标，先写临时文件再原子替换。
    let temp = format!(
        "{}/qingcode-agent.tmp-{}",
        dir,
        uuid::Uuid::new_v4().simple()
    );
    let write_result: Result<(), String> = async {
        let mut file = sftp
            .open_with_flags(temp.clone(), remote_write_flags(true))
            .await
            .map_err(|error| format!("创建远端临时文件失败：{error}"))?;
        for chunk in bytes.chunks(64 * 1024) {
            file.write_all(chunk)
                .await
                .map_err(|error| format!("上传 agent 二进制失败：{error}"))?;
        }
        file.shutdown()
            .await
            .map_err(|error| format!("完成 agent 上传失败：{error}"))?;
        Ok(())
    }
    .await;
    if let Err(error) = write_result {
        let _ = tokio::time::timeout(Duration::from_secs(2), sftp.remove_file(temp)).await;
        return Err(error);
    }
    let renamed = tokio::time::timeout(
        Duration::from_secs(15),
        sftp.rename(temp.clone(), remote_bin.to_string()),
    )
    .await
    .map_err(|_| "agent 二进制提交超时".to_string())?;
    if renamed.is_err() {
        // 目标已存在（SFTP v3 rename 拒绝覆盖）：清掉旧文件后再 rename 一次。
        let _ = exec_on_root(
            manager,
            root,
            &format!("rm -f -- {}", shell_quote(remote_bin)),
            &windows_remove_for(remote_bin),
        )
        .await;
        sftp.rename(temp.clone(), remote_bin.to_string())
            .await
            .map_err(|error| format!("提交 agent 二进制失败：{error}"))?;
    }
    // Linux 赋可执行位。Windows 的 .exe 不需要 chmod，失败只影响本次启动。
    if windows_native_path(&root.canonical_path).is_none() {
        let _ = manager
            .exec_command(
                &root.uri,
                &format!("chmod 755 -- {}", shell_quote(remote_bin)),
                None,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await;
    }
    Ok(())
}

/// 等待 agent 启动就绪：状态文件出现、可解析且 ping 通过。
async fn wait_agent_ready(
    manager: &SshManager,
    connection_id: &str,
    sftp: &SftpSession,
    root: &RegisteredRoot,
) -> Option<AgentEndpoint> {
    let state_path = agent_state_path(&root.canonical_path);
    let deadline = Instant::now() + AGENT_READY_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(AGENT_READY_POLL).await;
        if let Ok(bytes) = sftp.read(state_path.clone()).await {
            if let Ok(state) = parse_agent_state(&bytes) {
                let endpoint = AgentEndpoint {
                    port: state.port,
                    token: state.token,
                    daemon: None,
                };
                if ping_agent(manager, connection_id, &endpoint).await.is_ok() {
                    return Some(endpoint);
                }
            }
        }
    }
}

/// 部署失败原因。`permanent` 为真表示本次连接内不可能恢复（远端架构不支持、
/// 本地没有对应二进制），需要缓存成终态；其余按瞬时失败处理，下次调用重试。
struct AgentDeployError {
    reason: String,
    permanent: bool,
}

impl AgentDeployError {
    fn permanent(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            permanent: true,
        }
    }
}

impl From<String> for AgentDeployError {
    fn from(reason: String) -> Self {
        Self {
            reason,
            permanent: false,
        }
    }
}

/// 发现或部署远端 agent；不可用时返回原因，调用方回退直连。
///
/// serve 端点就绪后尽力补一步 daemon 传输探测（见 [`ensure_remote_daemon`]）：
/// 探测失败只表示本轮没有 daemon 可用，serve 模式照常返回。
async fn discover_or_deploy_agent(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
) -> Result<AgentEndpoint, AgentDeployError> {
    let sftp = manager.open_sftp(connection_id).await?;
    let (mut endpoint, remote_bin) = if let Some(endpoint) =
        try_discover_agent(manager, connection_id, &sftp, root, app).await
    {
        // 发现路径不知道部署时的二进制名，daemon 探测里现场用 `uname -m` 解析。
        (endpoint, None)
    } else {
        let (arch, local_binary) = locate_local_agent_binary(manager, root)
            .await
            .map_err(AgentDeployError::permanent)?;
        let remote_bin = agent_binary_remote_path(
            &root.canonical_path,
            windows_native_path(&root.canonical_path).is_some(),
            &arch,
        );
        // 上传之前才标 installing；找本地二进制仍算 probing。
        agent_status::note_agent_activity(
            manager,
            app,
            root,
            connection_id,
            agent_status::AgentPhase::Installing,
        );
        upload_agent_binary(manager, &sftp, root, &local_binary, &remote_bin).await?;
        let state_path = agent_state_path(&root.canonical_path);
        let command = deploy_agent_command(&remote_bin, &root.canonical_path, &state_path);
        let windows_script = windows_deploy_for(&remote_bin, &root.canonical_path, &state_path)
            .map_err(AgentDeployError::from)?;
        manager
            .exec_remote_shell(
                &root.uri,
                &command,
                &windows_script,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await
            .map_err(|error| format!("启动远端 agent 失败：{error}"))?;
        // serve ping 之前进入握手。
        agent_status::note_agent_activity(
            manager,
            app,
            root,
            connection_id,
            agent_status::AgentPhase::Handshaking,
        );
        let endpoint = wait_agent_ready(manager, connection_id, &sftp, root)
            .await
            .ok_or_else(|| AgentDeployError::from("agent 启动超时".to_string()))?;
        (endpoint, Some(remote_bin))
    };
    // daemon 握手（token + HELLO）之前再标一次；已是 handshaking 时不会重复发事件。
    agent_status::note_agent_activity(
        manager,
        app,
        root,
        connection_id,
        agent_status::AgentPhase::Handshaking,
    );
    endpoint.daemon =
        ensure_remote_daemon(manager, connection_id, root, remote_bin.as_deref()).await;
    Ok(endpoint)
}

fn publish_agent_if_watched(
    app: Option<&tauri::AppHandle>,
    manager: &SshManager,
    root: &RegisteredRoot,
) {
    if let Some(app) = app {
        agent_status::publish_root_state(app, manager, root);
    }
}

/// 读缓存：`Some(Some(..))` 命中端点，`Some(None)` 本次连接内已确定不可用，
/// `None` 表示还没有结论、需要走发现/部署。
fn cached_agent_slot(manager: &SshManager, key: &str) -> Option<Option<AgentEndpoint>> {
    let slot = manager.agent_slot(key)?;
    if let Some(endpoint) = slot.endpoint {
        return Some(Some(endpoint));
    }
    slot.unavailable_reason.is_some().then_some(None)
}

/// 确保（连接, 项目根）对应的 agent 端点可用。
///
/// 前置门不满足、agent 未部署或任何失败都返回 `Ok(None)`——调用方一律回退
/// 既有直连路径。成功结果缓存在 slot 里，之后走快路径；失败原因同样缓存，
/// 避免每次目录扫描都重复探测部署。
pub(crate) async fn ensure_agent_endpoint(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<Option<AgentEndpoint>, String> {
    ensure_agent_endpoint_with_app(manager, root, None).await
}

/// 同 [`ensure_agent_endpoint`]，并在 `app` 存在时发布阶段变化。
/// 目录扫描与搜索继续走无 app 的入口；watch 监督和 `ssh_agent_restart` 传入 app。
pub(crate) async fn ensure_agent_endpoint_with_app(
    manager: &SshManager,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
) -> Result<Option<AgentEndpoint>, String> {
    let connection_id = parse_remote_uri(&root.uri)?.connection_id;
    let key = agent_slot_key(&connection_id, &root.canonical_path);
    // 未信任项目、总开关关闭：不部署，直接公布直连原因。Windows 远端走 serve。
    if !manager.agent_enabled() || !root.trusted {
        publish_agent_if_watched(app, manager, root);
        return Ok(None);
    }
    if let Some(cached) = cached_agent_slot(manager, &key) {
        manager.set_agent_activity(&key, None);
        publish_agent_if_watched(app, manager, root);
        return Ok(cached);
    }
    // 同一 (连接, 根) 的部署串行执行；拿不到锁的并发调用方等结果落盘后复用。
    let gate = manager.agent_gate(&key)?;
    let _guard = gate.lock().await;
    if let Some(cached) = cached_agent_slot(manager, &key) {
        manager.set_agent_activity(&key, None);
        publish_agent_if_watched(app, manager, root);
        return Ok(cached);
    }
    // 新一轮从 probing 开始，清掉上次中断留下的瞬时阶段。
    manager.set_agent_activity(&key, None);
    publish_agent_if_watched(app, manager, root);
    match discover_or_deploy_agent(manager, &connection_id, root, app).await {
        Ok(endpoint) => {
            let mut slot = manager.agent_slot(&key).unwrap_or_default();
            slot.endpoint = Some(endpoint.clone());
            slot.unavailable_reason = None;
            slot.activity = None;
            manager.set_agent_slot(&key, slot);
            publish_agent_if_watched(app, manager, root);
            Ok(Some(endpoint))
        }
        Err(error) => {
            let mut slot = manager.agent_slot(&key).unwrap_or_default();
            slot.endpoint = None;
            slot.activity = None;
            // 只有确定性失败才占住缓存，瞬时失败留空以便下次重试。
            slot.unavailable_reason = error.permanent.then_some(error.reason);
            manager.set_agent_slot(&key, slot);
            publish_agent_if_watched(app, manager, root);
            Ok(None)
        }
    }
}

/// 单次流式操作的收尾方式。
pub(crate) enum AgentStreamOutcome {
    Done {
        truncated: bool,
        files_scanned: usize,
    },
    /// 客户端取消或 on_record 返回 false，提前结束。
    Stopped,
}

/// 通用流式调用：单连接承载单次操作，records 逐条交给 on_record，
/// 返回 false 即提前停止。帧读取错误一律返回 Err，由调用方决定回退。
pub(crate) async fn agent_stream_call(
    manager: &SshManager,
    connection_id: &str,
    endpoint: &AgentEndpoint,
    request: AgentRequest,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
    mut on_record: impl FnMut(&serde_json::Value) -> bool,
) -> Result<AgentStreamOutcome, String> {
    let channel = open_agent_channel(manager, connection_id, endpoint.port).await?;
    let mut stream = channel.into_stream();
    let payload =
        serde_json::to_vec(&request).map_err(|error| format!("编码 agent 请求失败：{error}"))?;
    write_frame(&mut stream, &payload)
        .await
        .map_err(|error| format!("发送 agent 请求失败：{error}"))?;
    loop {
        // 100ms 轮询窗口检查取消与超时，但读取 future 跨窗口保留：
        // `read_frame` 内部是 read_exact，被超时丢弃会吃掉半帧、破坏后续解析。
        let mut frame = Box::pin(read_frame(&mut stream));
        let bytes = loop {
            if cancelled() {
                // 丢弃通道即断开连接，远端会尽快收尾。
                return Ok(AgentStreamOutcome::Stopped);
            }
            if Instant::now() >= deadline {
                return Err("agent 操作超时".to_string());
            }
            match tokio::time::timeout(Duration::from_millis(100), &mut frame).await {
                Err(_) => continue,
                Ok(Err(error)) => return Err(format!("agent 连接中断：{error}")),
                Ok(Ok(bytes)) => break bytes,
            }
        };
        let response: AgentResponse = serde_json::from_slice(&bytes)
            .map_err(|error| format!("解析 agent 响应失败：{error}"))?;
        match response {
            AgentResponse::Records { data } => {
                for record in &data {
                    if !on_record(record) {
                        return Ok(AgentStreamOutcome::Stopped);
                    }
                }
            }
            AgentResponse::Done {
                truncated,
                files_scanned,
            } => {
                return Ok(AgentStreamOutcome::Done {
                    truncated,
                    files_scanned,
                });
            }
            AgentResponse::Error { message } => return Err(message),
            AgentResponse::Ok { version } => {
                // 单次操作连接只回 records/done/error，ok 只属于 ping。
                return Err(format!("agent 返回了意外的响应（版本 {version}）"));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// daemon 传输层（qingcode-agent daemon 模式，协议 v1）
// ---------------------------------------------------------------------------

/// 单请求 exec 通道上的请求 id。通道不做多路复用（见 [`DaemonChannel`]），
/// 一条通道同时只有一个在途请求。
const DAEMON_REQUEST_ID: u32 = 1;

/// 已完成 HELLO 握手的 daemon 连接：SSH exec 通道内运行
/// `connect --stdio --ensure-daemon`，代理把帧流原样转发给远端 daemon。
///
/// 通道策略（刻意从简）：**每次方法调用开一条独立的 exec 通道**，通道内只有
/// 一个在途请求（watch 也只有一路订阅流），请求 id 固定为
/// [`DAEMON_REQUEST_ID`]，不做多路复用。scan/search 是短命操作，通道开销
/// （一次 exec + connect 进程 + 本地 socket 转发）远小于请求路由与并发复用
/// 的复杂度；真正需要 stream_id 路由和发送优先级的是 PTY 接入（下一轮），
/// 届时再改为「一条常驻通道 + 按 stream_id 分发」。
pub(crate) struct DaemonChannel {
    channel: russh::Channel<client::Msg>,
    /// 已到达但尚未构成完整帧的字节：代理转发的是裸字节流，不保证按帧到达。
    buffer: Vec<u8>,
}

impl DaemonChannel {
    async fn send(&mut self, frame: &Frame) -> Result<(), String> {
        let bytes = frame
            .encode()
            .map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
        self.channel
            .data(&bytes[..])
            .await
            .map_err(|error| format!("发送 daemon 帧失败：{error}"))
    }

    /// 读取下一帧。PING 自动回 PONG——daemon 按「收到任意帧」计心跳，
    /// 空闲的 watch 连接全靠这个应答保活。
    ///
    /// deadline 前收不到完整帧返回 Err。`channel.wait()` 是 cancel-safe 的，
    /// 超时不会丢已到达的字节；但调用方此后应丢弃整条通道（回退 serve）。
    async fn next_frame(&mut self, deadline: Instant) -> Result<Frame, String> {
        loop {
            match proto::decode(&self.buffer) {
                Ok((frame, used)) => {
                    self.buffer.drain(..used);
                    if frame.kind == Kind::Ping {
                        let _ = self.send(&Frame::empty(Kind::Pong, frame.stream_id)).await;
                        continue;
                    }
                    return Ok(frame);
                }
                // 半帧：等待后续字节。
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {}
                Err(error) => return Err(format!("daemon 帧解析失败：{error}")),
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("daemon 响应超时".to_string());
            }
            match tokio::time::timeout(deadline - now, self.channel.wait()).await {
                // 代理进程退出（daemon 拒绝连接 / 已下线 / 会话结束）。
                Ok(None) => return Err("daemon 连接代理已退出".to_string()),
                Ok(Some(ChannelMsg::Data { data })) => self.buffer.extend_from_slice(&data),
                // 代理只转发 daemon 字节流，stderr 出现即启动失败（如 socket 连不上）。
                Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                    return Err(format!(
                        "daemon 连接代理报错：{}",
                        String::from_utf8_lossy(&data).trim()
                    ));
                }
                Ok(Some(ChannelMsg::Eof) | Some(ChannelMsg::Close)) => {
                    return Err("daemon 连接已关闭".to_string());
                }
                Ok(Some(_)) => {}
                Err(_) => return Err("daemon 响应超时".to_string()),
            }
        }
    }

    /// 尽力关闭通道：exec 通道被丢弃时不会自动 CLOSE，显式关闭避免长期
    /// 占用 sshd 的 MaxSessions 名额。
    async fn shutdown(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(1), self.channel.close()).await;
    }
}

/// 校验 daemon 的 HELLO 应答：协议版本、agent 版本一致，且本轮要用到的
/// 能力都已声明。任何不符都视为 daemon 不可用（回退 serve）。
fn validate_daemon_hello(response: &HelloResponse) -> Result<(), String> {
    if response.protocol != PROTOCOL_VERSION {
        return Err(format!("daemon 协议版本不兼容：{}", response.protocol));
    }
    if response.agent_version != AGENT_VERSION {
        return Err(format!(
            "daemon 版本不匹配：远端 {}，本端 {AGENT_VERSION}",
            response.agent_version
        ));
    }
    for capability in ["fs.scan", "search.content", "watch.subscribe"] {
        if !response.capabilities.iter().any(|item| item == capability) {
            return Err(format!("daemon 缺少能力 {capability}"));
        }
    }
    Ok(())
}

/// 打开一条 daemon 传输通道并完成握手。
///
/// exec 通道跑 `connect --stdio --ensure-daemon`：daemon 缺席时由代理拉起，
/// HELLO 携带 token 与协议区间 `[1, 1]`，daemon 校验 token / 协议后回 HELLO。
/// 任何一步失败都返回 Err，由调用方决定降级。
async fn open_daemon_channel(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
) -> Result<DaemonChannel, String> {
    let channel = manager
        .open_session_channel(connection_id, "agent 守护进程 ")
        .await?;
    if let Err(error) = channel
        .exec(true, connect_daemon_command(&daemon.bin))
        .await
    {
        let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        return Err(format!("启动 daemon 连接代理失败：{error}"));
    }
    let mut channel = DaemonChannel {
        channel,
        buffer: Vec::new(),
    };
    let hello = HelloRequest {
        // 设计上 client_id 标识 QingCode 安装实例；这里用连接 id（同一 SSH
        // 配置稳定不变）。daemon 本期只透传记录，不作鉴权。
        client_id: connection_id.to_string(),
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        token: daemon.token.clone(),
        resume_token: None,
    };
    channel
        .send(&Frame::new(
            Kind::Hello,
            CONTROL_STREAM,
            proto::encode(&hello).map_err(|error| format!("编码 HELLO 失败：{error}"))?,
        ))
        .await?;
    let response = channel
        .next_frame(Instant::now() + AGENT_DAEMON_HELLO_TIMEOUT)
        .await?;
    if response.kind != Kind::Hello {
        return Err(format!("daemon 握手应答异常（{}）", response.kind.as_str()));
    }
    let hello: HelloResponse = proto::decode_value(&response.payload)
        .map_err(|error| format!("解析 daemon HELLO 失败：{error}"))?;
    validate_daemon_hello(&hello)?;
    Ok(channel)
}

/// 握手探针：验证 token / 版本 / 能力后立即关闭。
async fn probe_daemon(manager: &SshManager, connection_id: &str, access: &DaemonAccess) -> bool {
    match open_daemon_channel(manager, connection_id, access).await {
        Ok(mut channel) => {
            channel.shutdown().await;
            true
        }
        Err(_) => false,
    }
}

/// serve agent 就绪后尽力补一步 daemon 传输探测：
/// 1. 幂等启动 daemon（重复执行因 `flock` 抢不到锁直接退出，无副作用）；
/// 2. 轮询读取 `run/token`（daemon 启动到 token 落盘有亚秒级延迟；旧 daemon
///    残留的 token 会被下一步的真实握手淘汰）；
/// 3. 用一次真实握手验证 token、版本与能力，通过才标记 daemon 可用。
///
/// 任一步失败都返回 `None`：仅表示本轮无 daemon，不影响 serve 模式。
async fn ensure_remote_daemon(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    remote_bin: Option<&str>,
) -> Option<DaemonAccess> {
    // daemon / connect 只在 unix 远端编译。Windows 停在 serve。
    if windows_native_path(&root.canonical_path).is_some() {
        return None;
    }
    let bin = match remote_bin {
        Some(bin) => bin.to_string(),
        None => {
            let arch = manager
                .exec_command(&root.uri, "uname -m", None, true, REMOTE_EXEC_TIMEOUT)
                .await
                .ok()?
                .stdout
                .trim()
                .to_string();
            if arch != "x86_64" && arch != "aarch64" {
                return None;
            }
            agent_binary_path(&root.canonical_path, &arch)
        }
    };
    let _ = manager
        .exec_command(
            &root.uri,
            &start_daemon_command(&bin),
            None,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await;
    let deadline = Instant::now() + AGENT_DAEMON_ENSURE_TIMEOUT;
    loop {
        if let Ok(result) = manager
            .exec_command(
                &root.uri,
                &daemon_token_command(),
                None,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await
        {
            let access = DaemonAccess {
                bin: bin.clone(),
                token: result.stdout.trim().to_string(),
            };
            if !access.token.is_empty() && probe_daemon(manager, connection_id, &access).await {
                return Some(access);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// 记录「daemon 传输暂不可用」：保留 serve 端点，只清 daemon 标记。
/// 该连接 + 根的后续操作直接走 serve 模式，直到端点被重新发现/部署。
pub(crate) fn downgrade_agent_daemon(manager: &SshManager, key: &str) {
    let Some(mut slot) = manager.agent_slot(key) else {
        return;
    };
    let Some(endpoint) = slot.endpoint.as_mut() else {
        return;
    };
    endpoint.daemon = None;
    manager.set_agent_slot(key, slot);
}

/// daemon 通道上的单请求 RPC：发 REQ、等 RES 或 ERR，返回 RES 的 result。
async fn daemon_rpc(
    channel: &mut DaemonChannel,
    method: &str,
    params: &serde_json::Value,
    deadline: Instant,
) -> Result<serde_json::Value, String> {
    let request = Request::with_params(DAEMON_REQUEST_ID, method, params)
        .map_err(|error| format!("编码 daemon 请求失败：{error}"))?;
    let payload =
        proto::encode(&request).map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
    channel
        .send(&Frame::new(Kind::Req, DAEMON_REQUEST_ID, payload))
        .await?;
    loop {
        let frame = channel.next_frame(deadline).await?;
        match frame.kind {
            Kind::Res if frame.stream_id == DAEMON_REQUEST_ID => {
                let response: Response = proto::decode_value(&frame.payload)
                    .map_err(|error| format!("解析 daemon 应答失败：{error}"))?;
                return Ok(response.result);
            }
            Kind::Err if frame.stream_id == DAEMON_REQUEST_ID => {
                let body: ErrorBody = proto::decode_value(&frame.payload)
                    .map_err(|error| format!("解析 daemon 错误帧失败：{error}"))?;
                return Err(format!(
                    "daemon {method} 失败（{}）：{}",
                    body.code, body.message
                ));
            }
            _ => {}
        }
    }
}

/// daemon 通道上列出目录直接子项，替代 serve 的 scan 请求。
/// 返回 (名称, 是否目录)，交给调用方 `collect_scan_nodes` 统一组装。
pub(crate) async fn daemon_scan_entries(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    canonical_root: &str,
    relative: &str,
) -> Result<Vec<(String, bool)>, String> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let params = serde_json::json!({ "root": canonical_root, "path": relative });
        let value = daemon_rpc(
            &mut channel,
            "fs.scan",
            &params,
            Instant::now() + AGENT_DAEMON_SCAN_TIMEOUT,
        )
        .await?;
        let entries = value
            .get("entries")
            .and_then(|entries| entries.as_array())
            .ok_or_else(|| "daemon scan 应答缺少 entries".to_string())?;
        let mut parsed = Vec::with_capacity(entries.len());
        for entry in entries {
            let Some(name) = entry.get("name").and_then(|value| value.as_str()) else {
                continue;
            };
            let is_dir = entry
                .get("isDir")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            parsed.push((name.to_string(), is_dir));
        }
        Ok(parsed)
    }
    .await;
    channel.shutdown().await;
    result
}

/// daemon 通道的内容搜索参数，与 daemon 的 `search.content` 方法一一对应。
pub(crate) struct DaemonSearchParams {
    pub root: String,
    pub query: String,
    pub ignore_case: bool,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub no_ignore: bool,
    pub max_matches: usize,
    pub max_per_file: usize,
    pub max_files: usize,
}

/// STREAM_DATA 分片重组：搜索是「记录流」（`seq` 为空，`last` 标记记录末块）。
/// SSH 通道保证字节有序，分片按到达顺序拼接即可，`offset` 只作校验用途。
#[derive(Default)]
struct RecordAssembler {
    buffer: Vec<u8>,
}

impl RecordAssembler {
    /// 追加一个分片；记录完整时返回整段字节并清空缓冲。
    fn push(&mut self, chunk: &StreamChunk) -> Option<Vec<u8>> {
        self.buffer.extend_from_slice(&chunk.data);
        chunk.last.then(|| std::mem::take(&mut self.buffer))
    }
}

/// daemon 通道上的流式内容搜索，替代 serve 的 searchContent：
/// STREAM_DATA 分片重组为 rg `--json` 同形记录（MessagePack 编码的 JSON 值），
/// 逐条交给 on_record（返回 false 即提前结束）。取消时发 CANCEL 帧后继续
/// 读到 STREAM_END，让 daemon 干净收尾；返回值语义与 serve 路径的
/// [`agent_stream_call`] 一致，调用方共用同一条回退链。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn daemon_search_content_call(
    manager: &SshManager,
    connection_id: &str,
    daemon: &DaemonAccess,
    params: DaemonSearchParams,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
    mut on_record: impl FnMut(&serde_json::Value) -> bool,
) -> Result<AgentStreamOutcome, String> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let request = Request::with_params(
            DAEMON_REQUEST_ID,
            "search.content",
            &serde_json::json!({
                "root": params.root,
                "query": params.query,
                "ignoreCase": params.ignore_case,
                "includeGlobs": params.include_globs,
                "excludeGlobs": params.exclude_globs,
                "noIgnore": params.no_ignore,
                "maxMatches": params.max_matches,
                "maxPerFile": params.max_per_file,
                "maxFiles": params.max_files,
            }),
        )
        .map_err(|error| format!("编码 daemon 请求失败：{error}"))?;
        let payload =
            proto::encode(&request).map_err(|error| format!("编码 daemon 帧失败：{error}"))?;
        channel
            .send(&Frame::new(Kind::Req, DAEMON_REQUEST_ID, payload))
            .await?;

        // daemon 发送侧有 256KB 信用窗口：消费后按半个窗口回补 WINDOW 帧，
        // 否则长流会在窗口耗尽时被卡死（serve 路径无流控，协议 v1 要求）。
        let mut receiver = ReceiverWindow::new(WINDOW_BYTES);
        let mut assembler = RecordAssembler::default();
        // CANCEL 已发出：继续读到 STREAM_END 让远端收尾，不再消费记录。
        let mut stopping = false;
        loop {
            if !stopping && cancelled() {
                channel
                    .send(&Frame::empty(Kind::Cancel, DAEMON_REQUEST_ID))
                    .await?;
                stopping = true;
            }
            if Instant::now() >= deadline {
                if stopping {
                    // CANCEL 已发但远端迟迟不收尾：放弃等待，通道随关闭收尾。
                    return Ok(AgentStreamOutcome::Stopped);
                }
                return Err("agent 操作超时".to_string());
            }
            let frame = channel.next_frame(deadline).await?;
            match frame.kind {
                Kind::StreamData if frame.stream_id == DAEMON_REQUEST_ID => {
                    if let Some(credit) = receiver.consume(frame.payload.len()) {
                        let payload = proto::encode(&WindowCredit { credit })
                            .map_err(|error| format!("编码 WINDOW 帧失败：{error}"))?;
                        let _ = channel
                            .send(&Frame::new(Kind::Window, DAEMON_REQUEST_ID, payload))
                            .await;
                    }
                    if stopping {
                        continue;
                    }
                    let chunk: StreamChunk = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 流分片失败：{error}"))?;
                    if let Some(record) = assembler.push(&chunk) {
                        let value: serde_json::Value = proto::decode_value(&record)
                            .map_err(|error| format!("解析 daemon 搜索记录失败：{error}"))?;
                        if !on_record(&value) {
                            channel
                                .send(&Frame::empty(Kind::Cancel, DAEMON_REQUEST_ID))
                                .await?;
                            stopping = true;
                        }
                    }
                }
                Kind::StreamEnd if frame.stream_id == DAEMON_REQUEST_ID => {
                    let end: StreamEnd = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 流结束帧失败：{error}"))?;
                    if stopping {
                        return Ok(AgentStreamOutcome::Stopped);
                    }
                    if !end.ok {
                        return Err(end.error.unwrap_or_else(|| "daemon 搜索失败".to_string()));
                    }
                    return Ok(AgentStreamOutcome::Done {
                        truncated: end
                            .summary
                            .get("truncated")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        files_scanned: end
                            .summary
                            .get("filesScanned")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as usize,
                    });
                }
                Kind::Err if frame.stream_id == DAEMON_REQUEST_ID => {
                    let body: ErrorBody = proto::decode_value(&frame.payload)
                        .map_err(|error| format!("解析 daemon 错误帧失败：{error}"))?;
                    return Err(format!(
                        "daemon 搜索失败（{}）：{}",
                        body.code, body.message
                    ));
                }
                _ => {}
            }
        }
    }
    .await;
    channel.shutdown().await;
    result
}

/// daemon 通道上的 watch 会话：订阅受理后循环接收 EVENT 推送并转成
/// `fs-change` 事件发给前端，直到会话失效、远端 watcher 结束或 agent 被关闭。
/// 返回 Err 仅代表订阅建立失败（通道/握手/RES 阶段），调用方据此降级 serve；
/// 会话中途结束一律返回 Ok，由监督任务的下一轮重连决定传输。
pub(crate) async fn daemon_watch_session(
    app: &tauri::AppHandle,
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    canonical_root: &str,
    daemon: &DaemonAccess,
) -> Result<(), String> {
    let mut channel = open_daemon_channel(manager, connection_id, daemon).await?;
    let result = async {
        let params = serde_json::json!({ "root": root.canonical_path });
        let response = daemon_rpc(
            &mut channel,
            "watch.subscribe",
            &params,
            Instant::now() + AGENT_PING_TIMEOUT,
        )
        .await?;
        if response
            .get("subscribed")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err("daemon watch 订阅未被受理".to_string());
        }
        // RES 只表示订阅受理；空闲时 daemon 每 15s 发一次 PING，
        // `next_frame` 自动回 PONG，使连接在无变更的仓库上也能保活。
        loop {
            if manager.session(connection_id).is_err() || !manager.agent_enabled() {
                return Ok(());
            }
            let deadline = Instant::now() + AGENT_WATCH_FRAME_TIMEOUT;
            let frame = channel.next_frame(deadline).await?;
            match frame.kind {
                Kind::Event => {
                    let Ok(event) = proto::decode_value::<Event>(&frame.payload) else {
                        // 无法解析的事件（新版本新增种类）直接跳过。
                        continue;
                    };
                    let Event::FsChange { path, kind, is_dir } = event else {
                        continue;
                    };
                    emit_agent_fs_change(app, &root.uri, canonical_root, &path, &kind, is_dir);
                }
                // STREAM_END / ERR：远端 watcher 结束（如根被删除），按断链重连。
                Kind::StreamEnd | Kind::Err => return Ok(()),
                _ => {}
            }
        }
    }
    .await;
    channel.shutdown().await;
    result
}

/// 把一条远端 watch 事件转成 ssh:// URI 并发给前端；serve 与 daemon 两条
/// watch 路径共用，保证过滤规则与 URI 语义一致。
fn emit_agent_fs_change(
    app: &tauri::AppHandle,
    root_uri: &str,
    canonical_root: &str,
    path: &str,
    kind: &str,
    is_dir: bool,
) {
    if should_skip_agent_watch_event(path, canonical_root) {
        return;
    }
    let Some(uri) = ssh_uri_for_watch_event(root_uri, canonical_root, path) else {
        return;
    };
    // 前端按 ssh:// URI 识别远程资源，与文件树节点一致。
    let _ = app.emit(
        "fs-change",
        crate::file_watcher::FsChangePayload {
            path: uri,
            kind: kind.to_string(),
            is_dir,
        },
    );
}

/// watch 监督任务：保活一条远端 watch 连接，把事件转成 `fs-change` 事件发给前端。
///
/// 连接断开后自动重连（复用新会话）；agent 被禁用、连接移除、根注销或明确
/// 不可用时任务退出。通道失败只影响 watch 本身，不触发终端重连逻辑。
pub(crate) fn spawn_agent_watch_supervisor(
    app: tauri::AppHandle,
    connection_id: String,
    root_uri: String,
    canonical_root: String,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures = 0usize;
        loop {
            let manager = app.state::<SshManager>();
            if manager.session(&connection_id).is_err()
                || !manager.root_is_registered(&root_uri).unwrap_or(false)
            {
                agent_status::publish_disconnected(&app, &manager, &connection_id, &root_uri);
                break;
            }
            let Ok(root) = manager.registered_root(&root_uri) else {
                agent_status::publish_disconnected(&app, &manager, &connection_id, &root_uri);
                break;
            };
            if !root.trusted || !manager.agent_enabled() {
                agent_status::publish_root_state(&app, &manager, &root);
                break;
            }
            let key = agent_slot_key(&connection_id, &root.canonical_path);
            let endpoint = match ensure_agent_endpoint_with_app(&manager, &root, Some(&app)).await {
                Ok(Some(endpoint)) => {
                    consecutive_failures = 0;
                    endpoint
                }
                Ok(None) => {
                    // 有明确不可用原因（架构不支持 / 没有二进制）就不再空转。
                    if manager
                        .agent_slot(&key)
                        .and_then(|slot| slot.unavailable_reason)
                        .is_some()
                    {
                        break;
                    }
                    consecutive_failures += 1;
                    if consecutive_failures >= AGENT_WATCH_MAX_RETRIES {
                        break;
                    }
                    tokio::time::sleep(AGENT_WATCH_RETRY_DELAY).await;
                    continue;
                }
                Err(_) => {
                    consecutive_failures += 1;
                    if consecutive_failures >= AGENT_WATCH_MAX_RETRIES {
                        break;
                    }
                    tokio::time::sleep(AGENT_WATCH_RETRY_DELAY).await;
                    continue;
                }
            };
            // daemon 传输优先：exec 通道内订阅，RES 受理后收 EVENT 推送。
            // 订阅建立失败只降级 daemon 标记（保留 serve 端点），serve 继续兜底。
            if let Some(daemon) = endpoint.daemon.clone() {
                match daemon_watch_session(
                    &app,
                    &manager,
                    &connection_id,
                    &root,
                    &canonical_root,
                    &daemon,
                )
                .await
                {
                    Ok(()) => {
                        tokio::time::sleep(AGENT_WATCH_RESTART_DELAY).await;
                        continue;
                    }
                    Err(_) => {
                        downgrade_agent_daemon(&manager, &key);
                        agent_status::publish_root_state(&app, &manager, &root);
                    }
                }
            }
            // serve 回退：打开 watch 连接；失败休眠后重试（下一轮会重新校验退出条件）。
            let stream = async {
                let channel = open_agent_channel(&manager, &connection_id, endpoint.port).await?;
                let mut stream = channel.into_stream();
                let request = AgentRequest {
                    token: endpoint.token.clone(),
                    op: AgentOp::Watch {
                        // "." 表示代理根（即注册的项目根）。
                        path: ".".to_string(),
                    },
                };
                let payload = serde_json::to_vec(&request)
                    .map_err(|error| format!("编码 agent 请求失败：{error}"))?;
                write_frame(&mut stream, &payload)
                    .await
                    .map_err(|error| format!("发送 agent 请求失败：{error}"))?;
                Ok::<_, String>(stream)
            }
            .await;
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(_) => {
                    // 端点可能已随远端进程消失（端口/token 失效）：清掉缓存，
                    // 下一轮重新走发现/部署，否则会一直对着死端口空转。
                    manager.clear_agent_endpoint(&key);
                    agent_status::publish_root_state(&app, &manager, &root);
                    tokio::time::sleep(AGENT_WATCH_RESTART_DELAY).await;
                    continue;
                }
            };
            // 读循环：空闲时每 5s 醒一次检查会话与开关，帧读取 future 跨轮保留，
            // 轮询不会丢半帧，也不会因为长时间没有事件而白白重连。
            'watch: loop {
                let mut frame = Box::pin(read_frame(&mut stream));
                // 每个帧重新计时：从"上一帧到达"起算 AGENT_WATCH_FRAME_TIMEOUT。
                let deadline = Instant::now() + AGENT_WATCH_FRAME_TIMEOUT;
                let bytes = loop {
                    if manager.session(&connection_id).is_err() || !manager.agent_enabled() {
                        break 'watch;
                    }
                    if Instant::now() >= deadline {
                        // 心跳缺席：连接半死。只重连，不 emit 任何事件。
                        break 'watch;
                    }
                    match tokio::time::timeout(AGENT_WATCH_IDLE_POLL, &mut frame).await {
                        Err(_) => continue,
                        Ok(Ok(bytes)) => break bytes,
                        // 通道断开（远端进程退出 / 连接失效）：重开 watch。
                        Ok(Err(_)) => break 'watch,
                    }
                };
                // 无法解析的帧（如 agent 新加的心跳帧）直接忽略并继续读下一帧：
                // 帧是长度前缀切好的，跳过不会破坏后续解析；若因此断开重连，
                // 心跳反而会变成周期性重连，回到本次修复要消除的问题。
                let Ok(response) = serde_json::from_slice::<AgentResponse>(&bytes) else {
                    continue 'watch;
                };
                match response {
                    AgentResponse::Records { data } => {
                        for event in &data {
                            let Some(path) = event.get("path").and_then(|value| value.as_str())
                            else {
                                continue;
                            };
                            let kind = event
                                .get("kind")
                                .and_then(|value| value.as_str())
                                .unwrap_or("any");
                            let is_dir = event
                                .get("isDir")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false);
                            emit_agent_fs_change(
                                &app,
                                &root.uri,
                                &canonical_root,
                                path,
                                kind,
                                is_dir,
                            );
                        }
                    }
                    AgentResponse::Error { .. } => break 'watch,
                    _ => {}
                }
            }
            // 丢弃流关闭通道，远端 watcher 随连接收尾。
            drop(stream);
            tokio::time::sleep(AGENT_WATCH_RESTART_DELAY).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_binary_name_and_deploy_script_use_native_paths() {
        assert_eq!(
            agent_binary_file_name(true, "x86_64"),
            "qingcode-agent-windows-x86_64.exe"
        );
        assert_eq!(
            agent_binary_remote_path("/D:/code/app", true, "aarch64"),
            "/D:/code/app/.qingcode/agent/qingcode-agent-windows-aarch64.exe"
        );
        let script = windows_deploy_for(
            "/D:/code/app/.qingcode/agent/qingcode-agent-windows-x86_64.exe",
            "/D:/code/app",
            "/D:/code/app/.qingcode/agent/agent.json",
        )
        .unwrap();
        assert!(script.contains(r"D:\code\app\.qingcode\agent\qingcode-agent-windows-x86_64.exe"));
        assert!(
            script.contains("CREATE")
                || script.contains("0x01000000")
                || script.contains("Start-Process")
        );
        assert!(script.contains(r"D:\code\app\.qingcode\agent\agent.json"));
        assert!(windows_deploy_for(
            "/srv/app/qingcode-agent-x86_64",
            "/srv/app",
            "/srv/app/agent.json"
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn agent_paths_handle_trailing_slash_root() {
        assert_eq!(
            agent_dir_path("/srv/project"),
            "/srv/project/.qingcode/agent"
        );
        assert_eq!(
            agent_dir_path("/srv/project/"),
            "/srv/project/.qingcode/agent"
        );
        assert_eq!(
            agent_state_path("/srv/project"),
            "/srv/project/.qingcode/agent/agent.json"
        );
        assert_eq!(
            agent_binary_path("/srv/project", "x86_64"),
            "/srv/project/.qingcode/agent/qingcode-agent-x86_64"
        );
    }

    #[test]
    fn slot_keys_pair_connection_with_root() {
        assert_eq!(agent_slot_key("conn-1", "/srv/a"), "conn-1|/srv/a");
        assert_ne!(
            agent_slot_key("conn-1", "/srv/a"),
            agent_slot_key("conn-2", "/srv/a")
        );
        assert_ne!(
            agent_slot_key("conn-1", "/srv/a"),
            agent_slot_key("conn-1", "/srv/b")
        );
    }

    #[test]
    fn deploy_command_quotes_all_arguments() {
        let command = deploy_agent_command(
            "/srv/app/.qingcode/agent/qingcode-agent-x86_64",
            "/srv/app",
            "/srv/app/.qingcode/agent/agent.json",
        );
        assert!(command.starts_with("nohup setsid '"));
        assert!(command.contains("serve --root '/srv/app'"));
        assert!(command.contains("--state '/srv/app/.qingcode/agent/agent.json'"));
        // 命令行不携带 token：agent 自生成并写进状态文件，避免凭据留在进程列表里。
        assert!(!command.contains("--token"));
        assert!(command.ends_with("' >/dev/null 2>&1 &"));
    }

    #[test]
    fn watch_event_filter_skips_agent_and_temp_files() {
        let root = "/srv/app";
        // agent 部署目录与其子树
        assert!(should_skip_agent_watch_event(
            "/srv/app/.qingcode/agent/agent.json",
            root
        ));
        assert!(should_skip_agent_watch_event(
            "/srv/app/.qingcode/agent/qingcode-agent-x86_64",
            root
        ));
        // 终端粘贴临时目录
        assert!(should_skip_agent_watch_event(
            "/srv/app/.qingcode/terminal-paste/paste.txt",
            root
        ));
        // 自写临时文件
        assert!(should_skip_agent_watch_event("/srv/app/main.rs.tmp", root));
        assert!(should_skip_agent_watch_event("/srv/app/a.rs.backup", root));
        // 正常源码不受影响
        assert!(!should_skip_agent_watch_event("/srv/app/src/main.rs", root));
        // 子目录里的同名 .qingcode 不属于部署目录
        assert!(!should_skip_agent_watch_event(
            "/srv/app/docs/.qingcode/agent.md",
            root
        ));
    }

    #[test]
    fn kill_command_verifies_process_identity_before_killing() {
        let command = kill_agent_command(1234, "/srv/app/.qingcode/agent/agent.json");
        // 必须先读 /proc/<pid>/cmdline 并确认二进制名，不能无条件 kill。
        assert!(command.contains("/proc/1234/cmdline"));
        assert!(command.contains("grep -q -- qingcode-agent"));
        // 状态文件路径整行精确匹配，避免误杀别的项目根的 agent。
        assert!(command.contains("grep -qxF -- '/srv/app/.qingcode/agent/agent.json'"));
        assert!(command.contains("kill 1234"));
        // best-effort：任何一步失败都不算错误。
        assert!(command.ends_with("|| true"));
        assert!(!command.contains("kill -9"));
    }

    #[test]
    fn kill_command_quotes_state_path() {
        let command = kill_agent_command(7, "/srv/it's/agent.json");
        assert!(command.contains("grep -qxF -- '/srv/it'\\''s/agent.json'"));
    }

    #[test]
    fn watch_uri_uses_registered_root_and_stays_within_canonical_root() {
        // 用户用符号链接路径打开项目：URI 必须以注册路径为基。
        let root_uri = "ssh://c1/home/user/app-link";
        let canonical = "/srv/app";
        assert_eq!(
            ssh_uri_for_watch_event(root_uri, canonical, "/srv/app/src/main.rs").as_deref(),
            Some("ssh://c1/home/user/app-link/src/main.rs")
        );
        // 根自身：直接用注册 URI，不追加空段。
        assert_eq!(
            ssh_uri_for_watch_event(root_uri, "/srv/app/", "/srv/app").as_deref(),
            Some("ssh://c1/home/user/app-link")
        );
        // 前缀相似但不在根内。
        assert!(ssh_uri_for_watch_event(root_uri, canonical, "/srv/app2/x").is_none());
        assert!(ssh_uri_for_watch_event(root_uri, canonical, "/etc/passwd").is_none());
        assert!(ssh_uri_for_watch_event(root_uri, canonical, "").is_none());
        assert!(ssh_uri_for_watch_event(root_uri, canonical, "relative/path").is_none());
        // 文件系统根作为项目根时不产生双斜杠。
        assert_eq!(
            ssh_uri_for_watch_event("ssh://c1/", "/", "/srv/x").as_deref(),
            Some("ssh://c1/srv/x")
        );
    }

    #[test]
    fn agent_state_parses_camel_case_and_rejects_missing_version() {
        let bytes = br#"{"version":"0.1.13-beta.3","port":45321,"pid":1234,"token":"abcdef","root":"/srv/app"}"#;
        let state = parse_agent_state(bytes).unwrap();
        assert_eq!(state.port, 45321);
        assert_eq!(state.pid, 1234);
        assert_eq!(state.token, "abcdef");
        assert!(parse_agent_state(br#"{"port":1,"pid":1,"token":"t","root":"/"}"#).is_err());
        assert!(parse_agent_state(b"not json").is_err());
    }

    #[test]
    fn agent_slot_cache_tracks_ready_and_unavailable_states() {
        let manager = SshManager::new();
        let key = agent_slot_key("c1", "/srv/app");
        // 还没有结论：调用方需要走发现/部署。
        assert!(cached_agent_slot(&manager, &key).is_none());

        manager.set_agent_slot(
            &key,
            AgentSlot {
                endpoint: Some(AgentEndpoint {
                    port: 4000,
                    token: "t".to_string(),
                    daemon: None,
                }),
                unavailable_reason: None,
                activity: None,
            },
        );
        assert_eq!(
            cached_agent_slot(&manager, &key).map(|cached| cached.map(|endpoint| endpoint.port)),
            Some(Some(4000))
        );

        // 端点失联后清缓存：回到需要重新发现的空状态。
        manager.clear_agent_endpoint(&key);
        assert!(cached_agent_slot(&manager, &key).is_none());

        // 确定性不可用：快路径直接判定不可用，不再重复部署。
        manager.set_agent_slot(
            &key,
            AgentSlot {
                endpoint: None,
                unavailable_reason: Some("远端架构不支持（armv7l）".to_string()),
                activity: None,
            },
        );
        assert_eq!(
            cached_agent_slot(&manager, &key).map(|cached| cached.is_none()),
            Some(true)
        );
    }

    fn sample_daemon_access() -> DaemonAccess {
        DaemonAccess {
            bin: "/srv/app/.qingcode/agent/qingcode-agent-x86_64".to_string(),
            token: "token-123".to_string(),
        }
    }

    fn hello_response(protocol: u32, version: &str, capabilities: &[&str]) -> HelloResponse {
        HelloResponse {
            protocol,
            agent_version: version.to_string(),
            pid: 42,
            os: "linux".into(),
            arch: "x86_64".into(),
            home: Some("/home/dev".into()),
            shells: vec!["bash".into()],
            capabilities: capabilities.iter().map(|item| item.to_string()).collect(),
            pty_count: 0,
        }
    }

    #[test]
    fn daemon_hello_validation_accepts_compatible_daemon() {
        let response = hello_response(
            PROTOCOL_VERSION,
            AGENT_VERSION,
            &[
                "fs.scan",
                "search.content",
                "watch.subscribe",
                "pty.persist",
            ],
        );
        assert!(validate_daemon_hello(&response).is_ok());
    }

    #[test]
    fn daemon_hello_validation_rejects_version_and_capability_gaps() {
        // 协议版本不符：回退 serve。
        assert!(validate_daemon_hello(&hello_response(99, AGENT_VERSION, &[])).is_err());
        // daemon 版本过期（旧进程还占着 flock 时可能出现）：回退 serve。
        assert!(validate_daemon_hello(&hello_response(
            PROTOCOL_VERSION,
            "0.0.9",
            &["fs.scan", "search.content", "watch.subscribe"]
        ))
        .is_err());
        // 能力缺失：回退 serve。
        assert!(validate_daemon_hello(&hello_response(
            PROTOCOL_VERSION,
            AGENT_VERSION,
            &["fs.scan"]
        ))
        .is_err());
    }

    #[test]
    fn daemon_commands_are_quoted_and_side_effect_free() {
        let bin = "/srv/app/.qingcode/agent/qingcode-agent-x86_64";
        let start = start_daemon_command(bin);
        // 后台 + 静默：命令立即返回，且不往通道输出任何东西。
        assert!(start.starts_with("nohup setsid '"));
        assert!(start.contains("' daemon >/dev/null 2>&1 &"));
        assert!(start.ends_with('&'));
        let connect = connect_daemon_command(bin);
        assert!(connect.starts_with("'"));
        assert!(connect.ends_with(" connect --stdio --ensure-daemon"));
        // token 读取限定在运行目录内，失败静默（文件不存在时返回空输出）。
        assert_eq!(
            daemon_token_command(),
            "cat \"$HOME/.qingcode/agent/run/token\" 2>/dev/null"
        );
    }

    #[test]
    fn record_assembler_reassembles_chunked_records_independently() {
        let mut assembler = RecordAssembler::default();
        // 第一条记录拆两个分片。
        let first = StreamChunk {
            seq: None,
            offset: 0,
            data: b"{\"type\":\"ma".to_vec(),
            last: false,
        };
        let second = StreamChunk {
            seq: None,
            offset: 12,
            data: b"tch\"}".to_vec(),
            last: true,
        };
        assert!(assembler.push(&first).is_none());
        assert_eq!(
            assembler.push(&second).as_deref(),
            Some(&b"{\"type\":\"match\"}"[..])
        );
        // 第二条记录单分片完整，与上一条互不混淆。
        let third = StreamChunk {
            seq: None,
            offset: 0,
            data: b"{}".to_vec(),
            last: true,
        };
        assert_eq!(assembler.push(&third).as_deref(), Some(&b"{}"[..]));
        // 空记录（空数据 + last）也要出结果。
        let empty = StreamChunk {
            seq: None,
            offset: 0,
            data: Vec::new(),
            last: true,
        };
        assert!(assembler
            .push(&empty)
            .is_some_and(|record| record.is_empty()));
    }

    #[test]
    fn daemon_downgrade_keeps_serve_endpoint() {
        let manager = SshManager::new();
        let key = agent_slot_key("c1", "/srv/app");
        // 没有端点时降级是空操作，不报错。
        downgrade_agent_daemon(&manager, &key);
        manager.set_agent_slot(
            &key,
            AgentSlot {
                endpoint: Some(AgentEndpoint {
                    port: 4000,
                    token: "t".to_string(),
                    daemon: Some(sample_daemon_access()),
                }),
                unavailable_reason: None,
                activity: None,
            },
        );
        downgrade_agent_daemon(&manager, &key);
        let slot = manager.agent_slot(&key).unwrap();
        let endpoint = slot.endpoint.as_ref().unwrap();
        // serve 端点保留，仅 daemon 标记被清掉：后续操作直接走 serve。
        assert_eq!(endpoint.port, 4000);
        assert!(endpoint.daemon.is_none());
    }

    #[test]
    fn daemon_request_params_roundtrip_as_msgpack_map() {
        let request = Request::with_params(
            DAEMON_REQUEST_ID,
            "fs.scan",
            &serde_json::json!({ "root": "/srv/app", "path": "src" }),
        )
        .unwrap();
        let bytes = proto::encode(&request).unwrap();
        let decoded: Request = proto::decode_value(&bytes).unwrap();
        assert_eq!(decoded.method, "fs.scan");
        let params: serde_json::Value = decoded.parse().unwrap();
        assert_eq!(params["root"], "/srv/app");
        assert_eq!(params["path"], "src");
        // HELLO 请求同样走 MessagePack map：字段名按 camelCase 编码。
        let hello = HelloRequest {
            client_id: "c1".into(),
            protocol_min: PROTOCOL_VERSION,
            protocol_max: PROTOCOL_VERSION,
            token: "t".into(),
            resume_token: None,
        };
        let decoded: HelloRequest = proto::decode_value(&proto::encode(&hello).unwrap()).unwrap();
        assert_eq!(decoded.client_id, "c1");
        assert_eq!(decoded.protocol_min, PROTOCOL_VERSION);
    }

    #[test]
    fn agent_download_urls_follow_release_layout() {
        let (manifest, binary) = agent_download_urls(
            "https://github.com/Fracizz/QingCode/releases/download",
            "agent-v0.1.13-beta.3",
            "qingcode-agent-x86_64",
        );
        assert_eq!(
            manifest,
            "https://github.com/Fracizz/QingCode/releases/download/agent-v0.1.13-beta.3/manifest.json"
        );
        assert_eq!(
            binary,
            "https://github.com/Fracizz/QingCode/releases/download/agent-v0.1.13-beta.3/qingcode-agent-x86_64"
        );
    }

    #[test]
    fn agent_download_base_follows_env_or_default() {
        // 不改环境变量（并行测试共享进程环境）：无论外部是否设置，
        // 函数返回值都应与「环境变量优先、默认 GitHub」的语义一致。
        let expected = std::env::var("QINGCODE_AGENT_DOWNLOAD_BASE")
            .ok()
            .map(|v| v.trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "https://github.com/Fracizz/QingCode/releases/download".to_string());
        assert_eq!(agent_download_base(), expected);
    }

    #[test]
    fn parse_agent_manifest_extracts_artifact_sha256() {
        let manifest = parse_agent_manifest(
            br#"{"version":"0.1.13-beta.3","artifacts":{"qingcode-agent-x86_64":{"sha256":"abc123","size":10}}}"#,
        )
        .unwrap();
        assert_eq!(manifest.version, "0.1.13-beta.3");
        assert_eq!(manifest.artifacts["qingcode-agent-x86_64"].sha256, "abc123");
        assert!(parse_agent_manifest(b"not json").is_err());
    }

    #[test]
    fn verify_agent_sha256_matches_case_insensitively_and_rejects_wrong() {
        use sha2::Digest;
        let digest: [u8; 32] = sha2::Sha256::digest(b"hello").into();
        let hex: String = digest.iter().map(|b| format!("{b:02X}")).collect();
        assert!(verify_agent_sha256(&hex.to_lowercase(), &digest).is_ok());
        assert!(verify_agent_sha256(&hex, &digest).is_ok());
        assert!(verify_agent_sha256(&"0".repeat(64), &digest).is_err());
    }
}
