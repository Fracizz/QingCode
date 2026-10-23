//! SSH 远端代理的连接阶段。
//!
//! 这里只做可查询、可订阅的阶段模型，以及 daemon / serve / direct 分派标签
//! （`SshAgentState::transport`）。不把文件与 Git 命令改写到 `RemoteBackend`
//! （那是能力迁移，不在这一层）。
//!
//! 稳态由会话、总开关、信任、Windows OpenSSH 与 [`super::agent::AgentSlot`] 决定。
//! 部署过程中的 installing / handshaking 记在 slot 的 `activity` 上，有
//! `AppHandle` 时才发 `ssh-agent-state`，且快照不变不重复发。

use super::*;
use serde::{Deserialize, Serialize};

/// 前端订阅的事件名。
pub(crate) const SSH_AGENT_STATE_EVENT: &str = "ssh-agent-state";

/// 日志只读这条固定命令。`$HOME` 由远端 shell 展开，禁止把用户路径拼进命令。
/// 项目里的 `.qingcode/agent` 是 serve 状态目录，不是 daemon 日志。
pub(crate) const AGENT_LOG_TAIL_COMMAND: &str =
    "tail -n 200 \"$HOME/.qingcode/agent/run/agent.log\"";

const AGENT_LOG_MAX_LINES: usize = 200;
const AGENT_LOG_MAX_BYTES: usize = 64 * 1024;
const AGENT_LOG_MISSING: &str = "远端代理日志不存在";

const REASON_AGENT_DISABLED: &str = "已关闭 ssh.agent.enabled";
const REASON_WINDOWS_OPENSSH: &str = "Windows OpenSSH 不部署远端代理";
const REASON_UNTRUSTED: &str = "工作区未信任";

/// 连接阶段。serde 用 camelCase，与前端约定一致。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentPhase {
    Disconnected,
    Authenticating,
    Probing,
    Installing,
    Handshaking,
    ReadyAgent,
    ReadyDirect,
}

/// 当前对外模式。探测和握手完成前是 `unknown`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentMode {
    Agent,
    Direct,
    Unknown,
}

/// 分派标签：daemon（常驻代理）、serve（按次 JSON）、direct（直连）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTransport {
    Daemon,
    Serve,
    Direct,
}

/// `ssh-agent-state` 与 `ssh_agent_info` / `ssh_agent_restart` 的载荷。
/// `Option` 序列化为 null，不用 `skip_serializing_if`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentState {
    pub connection_id: String,
    pub root_uri: String,
    pub phase: AgentPhase,
    pub mode: AgentMode,
    pub version: Option<String>,
    pub transport: Option<AgentTransport>,
    pub reason: Option<String>,
}

/// `ssh_agent_logs` 的返回值。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentLogs {
    pub text: String,
}

/// 计算阶段时看到的 slot 切片，避免单元测试依赖完整的端点。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AgentSlotView<'a> {
    /// `None` 没有端点；`Some(true)` 已接通 daemon；`Some(false)` 只有 serve。
    pub endpoint_has_daemon: Option<bool>,
    pub unavailable_reason: Option<&'a str>,
    pub activity: Option<AgentPhase>,
}

/// [`phase_for_slot`] 的输入。调用方负责填会话与门闩，本函数不读全局状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AgentSteadyInputs<'a> {
    pub connection_id: &'a str,
    pub root_uri: &'a str,
    pub session_connected: bool,
    pub agent_enabled: bool,
    pub windows_native: bool,
    pub trusted: bool,
    pub slot: Option<AgentSlotView<'a>>,
}

/// 由会话、门闩和 slot 得到稳态（以及 slot 上记录的瞬时阶段）。
pub(crate) fn phase_for_slot(input: &AgentSteadyInputs<'_>) -> SshAgentState {
    if !input.session_connected {
        return plain_state(input, AgentPhase::Disconnected);
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
            return ready_agent(input, has_daemon);
        }
        if let Some(reason) = slot.unavailable_reason {
            return ready_direct(input, reason);
        }
    }
    plain_state(input, AgentPhase::Probing)
}

fn is_in_progress(phase: AgentPhase) -> bool {
    matches!(
        phase,
        AgentPhase::Authenticating
            | AgentPhase::Probing
            | AgentPhase::Installing
            | AgentPhase::Handshaking
    )
}

fn direct_gate_reason(input: &AgentSteadyInputs<'_>) -> Option<&'static str> {
    if !input.agent_enabled {
        return Some(REASON_AGENT_DISABLED);
    }
    if input.windows_native {
        return Some(REASON_WINDOWS_OPENSSH);
    }
    if !input.trusted {
        return Some(REASON_UNTRUSTED);
    }
    None
}

fn plain_state(input: &AgentSteadyInputs<'_>, phase: AgentPhase) -> SshAgentState {
    SshAgentState {
        connection_id: input.connection_id.to_string(),
        root_uri: input.root_uri.to_string(),
        phase,
        mode: AgentMode::Unknown,
        version: None,
        transport: None,
        reason: None,
    }
}

fn ready_direct(input: &AgentSteadyInputs<'_>, reason: &str) -> SshAgentState {
    SshAgentState {
        connection_id: input.connection_id.to_string(),
        root_uri: input.root_uri.to_string(),
        phase: AgentPhase::ReadyDirect,
        mode: AgentMode::Direct,
        version: None,
        transport: Some(AgentTransport::Direct),
        reason: Some(reason.to_string()),
    }
}

fn ready_agent(input: &AgentSteadyInputs<'_>, has_daemon: bool) -> SshAgentState {
    SshAgentState {
        connection_id: input.connection_id.to_string(),
        root_uri: input.root_uri.to_string(),
        phase: AgentPhase::ReadyAgent,
        mode: AgentMode::Agent,
        version: Some(qingcode_agent::AGENT_VERSION.to_string()),
        transport: Some(if has_daemon {
            AgentTransport::Daemon
        } else {
            AgentTransport::Serve
        }),
        reason: None,
    }
}

/// 阶段转移是否允许。
///
/// 正向主路径是 Disconnected →（Authenticating →）Probing →（Installing →）
/// Handshaking → ReadyAgent。任意阶段都可以到 ReadyDirect 或 Disconnected。
/// 已有端点时允许 Probing 直接到 ReadyAgent；重启允许回到 Probing。
/// 运行时仍按 slot 发布，不用本函数丢事件。
pub(crate) fn agent_phase_transition_allowed(from: AgentPhase, to: AgentPhase) -> bool {
    if from == to {
        return true;
    }
    if matches!(to, AgentPhase::ReadyDirect | AgentPhase::Disconnected) {
        return true;
    }
    matches!(
        (from, to),
        (AgentPhase::Disconnected, AgentPhase::Authenticating)
            | (AgentPhase::Disconnected, AgentPhase::Probing)
            | (AgentPhase::Authenticating, AgentPhase::Probing)
            | (AgentPhase::Probing, AgentPhase::Installing)
            | (AgentPhase::Probing, AgentPhase::Handshaking)
            | (AgentPhase::Probing, AgentPhase::ReadyAgent)
            | (AgentPhase::Installing, AgentPhase::Handshaking)
            | (AgentPhase::Handshaking, AgentPhase::ReadyAgent)
            | (AgentPhase::Handshaking, AgentPhase::Installing)
            | (AgentPhase::Installing, AgentPhase::Probing)
            | (AgentPhase::Handshaking, AgentPhase::Probing)
            | (AgentPhase::ReadyAgent, AgentPhase::Probing)
            | (AgentPhase::ReadyDirect, AgentPhase::Probing)
    )
}

/// 保留最后 200 行，再把字节数压到约 64KB（按字符边界截尾部）。
pub(crate) fn truncate_agent_log(text: &str) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > AGENT_LOG_MAX_LINES {
        let start = lines.len() - AGENT_LOG_MAX_LINES;
        lines = lines.split_off(start);
    }
    let mut out = lines.join("\n");
    if out.len() > AGENT_LOG_MAX_BYTES {
        let mut start = out.len() - AGENT_LOG_MAX_BYTES;
        while start < out.len() && !out.is_char_boundary(start) {
            start += 1;
        }
        out = out[start..].to_string();
    }
    out
}

fn agent_log_is_missing(exit_code: u32, stderr: &str) -> bool {
    if exit_code == 0 {
        return false;
    }
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("no such file") || stderr.contains("没有那个文件")
}

fn agent_log_text(exit_code: u32, stdout: &str, stderr: &str) -> Result<String, String> {
    if agent_log_is_missing(exit_code, stderr) {
        return Ok(AGENT_LOG_MISSING.to_string());
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
    Ok(truncate_agent_log(stdout))
}

pub(crate) fn state_for_root(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<SshAgentState, String> {
    let parsed = parse_remote_uri(&root.uri)?;
    let key = agent::agent_slot_key(&parsed.connection_id, &root.canonical_path);
    let slot = manager.agent_slot(&key);
    let view = slot.as_ref().map(|slot| AgentSlotView {
        endpoint_has_daemon: slot
            .endpoint
            .as_ref()
            .map(|endpoint| endpoint.daemon.is_some()),
        unavailable_reason: slot.unavailable_reason.as_deref(),
        activity: slot.activity,
    });
    Ok(phase_for_slot(&AgentSteadyInputs {
        connection_id: &parsed.connection_id,
        root_uri: &normalize_remote_uri(&root.uri),
        session_connected: manager.connection_is_open(&parsed.connection_id),
        agent_enabled: manager.agent_enabled(),
        windows_native: windows_native_path(&root.canonical_path).is_some(),
        trusted: root.trusted,
        slot: view,
    }))
}

fn emit_state(app: &AppHandle, manager: &SshManager, state: &SshAgentState) {
    if manager.record_agent_snapshot(state) {
        let _ = app.emit(SSH_AGENT_STATE_EVENT, state);
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
        &SshAgentState {
            connection_id: connection_id.to_string(),
            root_uri: normalize_remote_uri(root_uri),
            phase: AgentPhase::Authenticating,
            mode: AgentMode::Unknown,
            version: None,
            transport: None,
            reason: None,
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
        &SshAgentState {
            connection_id: connection_id.to_string(),
            root_uri: normalize_remote_uri(root_uri),
            phase: AgentPhase::Disconnected,
            mode: AgentMode::Unknown,
            version: None,
            transport: None,
            reason: None,
        },
    );
}

/// 把部署中的阶段写进 slot，并在有 AppHandle 时发布。
pub(crate) fn note_agent_activity(
    manager: &SshManager,
    app: Option<&AppHandle>,
    root: &RegisteredRoot,
    connection_id: &str,
    activity: AgentPhase,
) {
    let key = agent::agent_slot_key(connection_id, &root.canonical_path);
    manager.set_agent_activity(&key, Some(activity));
    if let Some(app) = app {
        publish_root_state(app, manager, root);
    }
}

fn require_registered_root(manager: &SshManager, root_uri: &str) -> Result<RegisteredRoot, String> {
    parse_remote_uri(root_uri)?;
    manager.registered_root(root_uri)
}

/// 只在 agent.json 解析出 pid 和状态路径后，才复用 [`agent::kill_agent_command`]。
/// 不按用户字符串拼 shell，也不杀 daemon 或其他 pid。
async fn stop_recorded_serve_agent(manager: &SshManager, root: &RegisteredRoot) {
    let Ok(parsed) = parse_remote_uri(&root.uri) else {
        return;
    };
    let state_path = agent::agent_state_path(&root.canonical_path);
    let Ok(sftp) = manager.open_sftp(&parsed.connection_id).await else {
        return;
    };
    let Ok(bytes) = sftp.read(state_path.clone()).await else {
        return;
    };
    let Ok(state) = agent::parse_agent_state(&bytes) else {
        return;
    };
    let command = agent::kill_agent_command(state.pid, &state_path);
    let _ = manager
        .exec_command(&root.uri, &command, None, true, REMOTE_EXEC_TIMEOUT)
        .await;
}

pub(crate) fn ssh_agent_info(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<SshAgentState, String> {
    let root = require_registered_root(&manager, &root_uri)?;
    state_for_root(&manager, &root)
}

pub(crate) async fn ssh_agent_restart(
    root_uri: String,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<SshAgentState, String> {
    let root = require_registered_root(&manager, &root_uri)?;
    let parsed = parse_remote_uri(&root.uri)?;
    manager.session(&parsed.connection_id)?;
    // 先停已记录的 serve 进程，再清 slot，避免 ensure 立刻复用刚要重启的端点。
    stop_recorded_serve_agent(&manager, &root).await;
    let key = agent::agent_slot_key(&parsed.connection_id, &root.canonical_path);
    manager.clear_agent_endpoint(&key);
    publish_root_state(&app, &manager, &root);
    agent::ensure_agent_endpoint_with_app(&manager, &root, Some(&app)).await?;
    state_for_root(&manager, &root)
}

pub(crate) async fn ssh_agent_logs(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<SshAgentLogs, String> {
    let root = require_registered_root(&manager, &root_uri)?;
    if windows_native_path(&root.canonical_path).is_some() {
        return Ok(SshAgentLogs {
            text: "Windows OpenSSH 不部署远端代理，没有代理日志".to_string(),
        });
    }
    let result = manager
        .exec_command(
            &root.uri,
            AGENT_LOG_TAIL_COMMAND,
            None,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await?;
    Ok(SshAgentLogs {
        text: agent_log_text(result.exit_code, &result.stdout, &result.stderr)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs<'a>(
        session_connected: bool,
        agent_enabled: bool,
        windows_native: bool,
        trusted: bool,
        slot: Option<AgentSlotView<'a>>,
    ) -> AgentSteadyInputs<'a> {
        AgentSteadyInputs {
            connection_id: "c1",
            root_uri: "ssh://c1/srv/app",
            session_connected,
            agent_enabled,
            windows_native,
            trusted,
            slot,
        }
    }

    fn ready_inputs(slot: Option<AgentSlotView<'_>>) -> AgentSteadyInputs<'_> {
        inputs(true, true, false, true, slot)
    }

    fn assert_direct(state: &SshAgentState, reason: &str) {
        assert_eq!(state.phase, AgentPhase::ReadyDirect);
        assert_eq!(state.mode, AgentMode::Direct);
        assert_eq!(state.transport, Some(AgentTransport::Direct));
        assert_eq!(state.version, None);
        assert_eq!(state.reason.as_deref(), Some(reason));
        assert_eq!(state.connection_id, "c1");
        assert_eq!(state.root_uri, "ssh://c1/srv/app");
    }

    #[test]
    fn disabled_agent_is_ready_direct() {
        let state = phase_for_slot(&inputs(true, false, false, true, None));
        assert_direct(&state, REASON_AGENT_DISABLED);
    }

    #[test]
    fn windows_openssh_is_ready_direct() {
        let state = phase_for_slot(&inputs(true, true, true, true, None));
        assert_direct(&state, REASON_WINDOWS_OPENSSH);
    }

    #[test]
    fn untrusted_root_is_ready_direct() {
        let state = phase_for_slot(&inputs(true, true, false, false, None));
        assert_direct(&state, REASON_UNTRUSTED);
    }

    #[test]
    fn daemon_endpoint_is_ready_agent() {
        let state = phase_for_slot(&ready_inputs(Some(AgentSlotView {
            endpoint_has_daemon: Some(true),
            unavailable_reason: None,
            activity: None,
        })));
        assert_eq!(state.phase, AgentPhase::ReadyAgent);
        assert_eq!(state.mode, AgentMode::Agent);
        assert_eq!(state.transport, Some(AgentTransport::Daemon));
        assert_eq!(
            state.version.as_deref(),
            Some(qingcode_agent::AGENT_VERSION)
        );
        assert_eq!(state.reason, None);
    }

    #[test]
    fn serve_endpoint_is_ready_agent_without_daemon() {
        let state = phase_for_slot(&ready_inputs(Some(AgentSlotView {
            endpoint_has_daemon: Some(false),
            unavailable_reason: None,
            activity: None,
        })));
        assert_eq!(state.phase, AgentPhase::ReadyAgent);
        assert_eq!(state.mode, AgentMode::Agent);
        assert_eq!(state.transport, Some(AgentTransport::Serve));
        assert_eq!(
            state.version.as_deref(),
            Some(qingcode_agent::AGENT_VERSION)
        );
        assert_eq!(state.reason, None);
    }

    #[test]
    fn unavailable_reason_is_ready_direct() {
        let state = phase_for_slot(&ready_inputs(Some(AgentSlotView {
            endpoint_has_daemon: None,
            unavailable_reason: Some("远端架构不支持（armv7l）"),
            activity: None,
        })));
        assert_direct(&state, "远端架构不支持（armv7l）");
    }

    #[test]
    fn connected_without_slot_is_probing() {
        let state = phase_for_slot(&ready_inputs(None));
        assert_eq!(state.phase, AgentPhase::Probing);
        assert_eq!(state.mode, AgentMode::Unknown);
        assert_eq!(state.transport, None);
        assert_eq!(state.version, None);
        assert_eq!(state.reason, None);
    }

    #[test]
    fn missing_session_is_disconnected_even_with_endpoint() {
        let state = phase_for_slot(&inputs(
            false,
            true,
            false,
            true,
            Some(AgentSlotView {
                endpoint_has_daemon: Some(true),
                unavailable_reason: None,
                activity: Some(AgentPhase::Handshaking),
            }),
        ));
        assert_eq!(state.phase, AgentPhase::Disconnected);
        assert_eq!(state.mode, AgentMode::Unknown);
        assert_eq!(state.transport, None);
        assert_eq!(state.version, None);
        assert_eq!(state.reason, None);
    }

    #[test]
    fn installing_activity_wins_over_a_cached_endpoint() {
        let state = phase_for_slot(&ready_inputs(Some(AgentSlotView {
            endpoint_has_daemon: Some(true),
            unavailable_reason: None,
            activity: Some(AgentPhase::Installing),
        })));
        assert_eq!(state.phase, AgentPhase::Installing);
        assert_eq!(state.mode, AgentMode::Unknown);
        assert_eq!(state.transport, None);
    }

    #[test]
    fn disabled_gate_wins_over_installing_activity() {
        let state = phase_for_slot(&inputs(
            true,
            false,
            false,
            true,
            Some(AgentSlotView {
                endpoint_has_daemon: None,
                unavailable_reason: None,
                activity: Some(AgentPhase::Installing),
            }),
        ));
        assert_direct(&state, REASON_AGENT_DISABLED);
    }

    #[test]
    fn legal_path_reaches_ready_agent_and_fallback_is_open() {
        let forward = [
            AgentPhase::Disconnected,
            AgentPhase::Probing,
            AgentPhase::Installing,
            AgentPhase::Handshaking,
            AgentPhase::ReadyAgent,
        ];
        for pair in forward.windows(2) {
            assert!(
                agent_phase_transition_allowed(pair[0], pair[1]),
                "{:?} → {:?}",
                pair[0],
                pair[1]
            );
        }
        assert!(agent_phase_transition_allowed(
            AgentPhase::Disconnected,
            AgentPhase::Authenticating
        ));
        assert!(agent_phase_transition_allowed(
            AgentPhase::Authenticating,
            AgentPhase::Probing
        ));
        let phases = [
            AgentPhase::Disconnected,
            AgentPhase::Authenticating,
            AgentPhase::Probing,
            AgentPhase::Installing,
            AgentPhase::Handshaking,
            AgentPhase::ReadyAgent,
            AgentPhase::ReadyDirect,
        ];
        for phase in phases {
            assert!(agent_phase_transition_allowed(
                phase,
                AgentPhase::ReadyDirect
            ));
            assert!(agent_phase_transition_allowed(
                phase,
                AgentPhase::Disconnected
            ));
        }
    }

    #[test]
    fn disconnected_cannot_skip_to_ready_agent() {
        assert!(!agent_phase_transition_allowed(
            AgentPhase::Disconnected,
            AgentPhase::ReadyAgent
        ));
        assert!(!agent_phase_transition_allowed(
            AgentPhase::Disconnected,
            AgentPhase::Installing
        ));
        assert!(!agent_phase_transition_allowed(
            AgentPhase::Disconnected,
            AgentPhase::Handshaking
        ));
        assert!(!agent_phase_transition_allowed(
            AgentPhase::Installing,
            AgentPhase::ReadyAgent
        ));
    }

    #[test]
    fn ssh_agent_state_serializes_camel_case_with_nulls() {
        let ready = phase_for_slot(&ready_inputs(Some(AgentSlotView {
            endpoint_has_daemon: Some(true),
            unavailable_reason: None,
            activity: None,
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
                "mode",
                "phase",
                "reason",
                "rootUri",
                "transport",
                "version",
            ]
        );
        assert_eq!(value["connectionId"], "c1");
        assert_eq!(value["rootUri"], "ssh://c1/srv/app");
        assert_eq!(value["phase"], "readyAgent");
        assert_eq!(value["mode"], "agent");
        assert_eq!(value["version"], qingcode_agent::AGENT_VERSION);
        assert_eq!(value["transport"], "daemon");
        assert!(value["reason"].is_null());
        assert!(value.get("connection_id").is_none());

        let direct = phase_for_slot(&inputs(true, true, false, false, None));
        let value = serde_json::to_value(&direct).unwrap();
        assert_eq!(value["phase"], "readyDirect");
        assert_eq!(value["mode"], "direct");
        assert!(value["version"].is_null());
        assert_eq!(value["transport"], "direct");
        assert_eq!(value["reason"], REASON_UNTRUSTED);
        let restored: SshAgentState = serde_json::from_value(value).unwrap();
        assert_eq!(restored, direct);
    }

    #[test]
    fn truncate_agent_log_keeps_the_tail_within_line_and_byte_caps() {
        let text = (0..500)
            .map(|index| format!("line-{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let truncated = truncate_agent_log(&text);
        let lines: Vec<_> = truncated.lines().collect();
        assert_eq!(lines.len(), AGENT_LOG_MAX_LINES);
        assert_eq!(lines[0], "line-300");
        assert_eq!(lines[199], "line-499");
        assert_eq!(truncate_agent_log("short"), "short");

        let long = "字".repeat(70_000);
        let truncated = truncate_agent_log(&long);
        assert!(truncated.len() <= AGENT_LOG_MAX_BYTES);
        assert!(truncated.ends_with('字'));
        assert!(!truncated.is_empty());
    }

    #[test]
    fn agent_log_command_reads_the_fixed_daemon_log() {
        assert_eq!(
            AGENT_LOG_TAIL_COMMAND,
            "tail -n 200 \"$HOME/.qingcode/agent/run/agent.log\""
        );
        assert!(!AGENT_LOG_TAIL_COMMAND.contains("{"));
        assert_eq!(
            agent_log_text(1, "", "tail: cannot open: No such file or directory").unwrap(),
            AGENT_LOG_MISSING
        );
        assert_eq!(agent_log_text(0, "hello\n", "").unwrap(), "hello");
    }
}
