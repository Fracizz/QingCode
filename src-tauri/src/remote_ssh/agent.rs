//! SSH 远端代理（qingcode-agent）的客户端集成。
//!
//! 代理通过 SSH `direct-tcpip` 通道接入远端 `127.0.0.1:<port>`，用于扫描、
//! 内容搜索与文件监视。所有集成点都遵循同一策略：agent 不可用时静默回退到
//! 既有 SFTP / rg 直连路径，绝不影响既有功能。

use super::*;
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

/// 一个已就绪的远端 agent 端点。
#[derive(Clone)]
pub(crate) struct AgentEndpoint {
    pub(crate) port: u16,
    pub(crate) token: String,
}

/// 每个连接 + 项目根的 agent 状态缓存：就绪端点或不可用原因。
/// 原因只记录「本次连接内不可能恢复」的情形（架构不支持、本地缺二进制），
/// 避免每次目录扫描都重复探测部署；瞬时失败不写原因，下次调用会再试。
#[derive(Default, Clone)]
pub(crate) struct AgentSlot {
    pub(crate) endpoint: Option<AgentEndpoint>,
    pub(crate) unavailable_reason: Option<String>,
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

pub(crate) fn agent_binary_path(canonical_root: &str, arch: &str) -> String {
    format!("{}/qingcode-agent-{arch}", agent_dir_path(canonical_root))
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
        let _ = manager
            .exec_command(
                &root.uri,
                &kill_agent_command(state.pid, &state_path),
                None,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await;
        return None;
    }
    let endpoint = AgentEndpoint {
        port: state.port,
        token: state.token,
    };
    ping_agent(manager, connection_id, &endpoint).await.ok()?;
    Some(endpoint)
}

/// 探测远端架构并找到本地对应的 agent 二进制。
async fn locate_local_agent_binary(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<(String, PathBuf), String> {
    let arch = manager
        .exec_command(&root.uri, "uname -m", None, true, REMOTE_EXEC_TIMEOUT)
        .await?
        .stdout
        .trim()
        .to_string();
    if arch != "x86_64" && arch != "aarch64" {
        return Err(format!("远端架构不支持（{arch}）"));
    }
    let binary_name = format!("qingcode-agent-{arch}");
    for dir in manager.agent_binary_dirs() {
        let candidate = dir.join(&binary_name);
        if candidate.is_file() {
            return Ok((arch, candidate));
        }
    }
    Err(format!(
        "本地未找到 QingCode agent 二进制（{arch}），已回退直连模式"
    ))
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
        let _ = manager
            .exec_command(
                &root.uri,
                &format!("rm -f -- {}", shell_quote(remote_bin)),
                None,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await;
        sftp.rename(temp.clone(), remote_bin.to_string())
            .await
            .map_err(|error| format!("提交 agent 二进制失败：{error}"))?;
    }
    // 赋可执行位；失败只影响本次启动，等就绪阶段兜底报错。
    let _ = manager
        .exec_command(
            &root.uri,
            &format!("chmod 755 -- {}", shell_quote(remote_bin)),
            None,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await;
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
async fn discover_or_deploy_agent(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
) -> Result<AgentEndpoint, AgentDeployError> {
    let sftp = manager.open_sftp(connection_id).await?;
    if let Some(endpoint) = try_discover_agent(manager, connection_id, &sftp, root).await {
        return Ok(endpoint);
    }
    let (arch, local_binary) = locate_local_agent_binary(manager, root)
        .await
        .map_err(AgentDeployError::permanent)?;
    let remote_bin = agent_binary_path(&root.canonical_path, &arch);
    upload_agent_binary(manager, &sftp, root, &local_binary, &remote_bin).await?;
    let state_path = agent_state_path(&root.canonical_path);
    let command = deploy_agent_command(&remote_bin, &root.canonical_path, &state_path);
    manager
        .exec_command(&root.uri, &command, None, true, REMOTE_EXEC_TIMEOUT)
        .await
        .map_err(|error| format!("启动远端 agent 失败：{error}"))?;
    wait_agent_ready(manager, connection_id, &sftp, root)
        .await
        .ok_or_else(|| AgentDeployError::from("agent 启动超时".to_string()))
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
    // 本地 Windows 项目、未信任项目不部署 agent。
    if !manager.agent_enabled()
        || windows_native_path(&root.canonical_path).is_some()
        || !root.trusted
    {
        return Ok(None);
    }
    let connection_id = parse_remote_uri(&root.uri)?.connection_id;
    let key = agent_slot_key(&connection_id, &root.canonical_path);
    if let Some(cached) = cached_agent_slot(manager, &key) {
        return Ok(cached);
    }
    // 同一 (连接, 根) 的部署串行执行；拿不到锁的并发调用方等结果落盘后复用。
    let gate = manager.agent_gate(&key)?;
    let _guard = gate.lock().await;
    if let Some(cached) = cached_agent_slot(manager, &key) {
        return Ok(cached);
    }
    match discover_or_deploy_agent(manager, &connection_id, root).await {
        Ok(endpoint) => {
            manager.set_agent_slot(
                &key,
                AgentSlot {
                    endpoint: Some(endpoint.clone()),
                    unavailable_reason: None,
                },
            );
            Ok(Some(endpoint))
        }
        Err(error) => {
            manager.set_agent_slot(
                &key,
                AgentSlot {
                    endpoint: None,
                    // 只有确定性失败才占住缓存，瞬时失败留空以便下次重试。
                    unavailable_reason: error.permanent.then_some(error.reason),
                },
            );
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
                break;
            }
            let Ok(root) = manager.registered_root(&root_uri) else {
                break;
            };
            if !root.trusted || !manager.agent_enabled() {
                break;
            }
            let key = agent_slot_key(&connection_id, &root.canonical_path);
            let endpoint = match ensure_agent_endpoint(&manager, &root).await {
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
            // 打开 watch 连接；失败休眠后重试（下一轮会重新校验退出条件）。
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
                                .unwrap_or("any")
                                .to_string();
                            let is_dir = event
                                .get("isDir")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false);
                            if should_skip_agent_watch_event(path, &canonical_root) {
                                continue;
                            }
                            let Some(uri) =
                                ssh_uri_for_watch_event(&root.uri, &canonical_root, path)
                            else {
                                continue;
                            };
                            // 前端按 ssh:// URI 识别远程资源，与文件树节点一致。
                            let _ = app.emit(
                                "fs-change",
                                crate::file_watcher::FsChangePayload {
                                    path: uri,
                                    kind,
                                    is_dir,
                                },
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
                }),
                unavailable_reason: None,
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
            },
        );
        assert_eq!(
            cached_agent_slot(&manager, &key).map(|cached| cached.is_none()),
            Some(true)
        );
    }
}
