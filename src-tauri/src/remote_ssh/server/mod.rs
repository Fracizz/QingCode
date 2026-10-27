//! SSH 远端代理（qingcode-server）的客户端集成。
//!
//! scan / search / watch 有两条传输路径，按顺序回退：
//! - **daemon 传输**（优先）：SSH exec 通道运行 `connect --stdio --ensure-daemon`，
//!   与远端常驻 daemon 之间走协议 v1 帧流（`qingcode_server::proto`）；
//! - **serve 传输**（回退）：每操作一条 `direct-tcpip` 通道连远端 `127.0.0.1:<port>`，
//!   JSON 帧（`ServerRequest` / `ServerResponse`）。
//!
//! Server 模式优先按已认证的主机/用户/指纹共享 daemon。项目只挂载各自的
//! 规范化根；文件操作在 daemon 传输失败时惰性启动该项目的 serve，终端必须
//! 使用 daemon。SSH 兼容模式与受限项目走原有 SFTP/直连路径。
//!
//! 子模块按职责划分：
//! - [`paths`]：远端部署路径 / 二进制命名 / 状态文件解析；
//! - [`scripts`]：远端脚本与命令构造（纯函数）；
//! - [`download`]：本地二进制定位与 GitHub Release 下载；
//! - [`serve`]：serve 传输通道（direct-tcpip + JSON 帧）；
//! - [`deploy`]：发现 / 部署编排与 slot 缓存；
//! - [`host_runtime`]：跨项目共享 daemon 与连接健康校验；
//! - [`daemon`]：daemon 传输通道（协议 v1 帧流）；
//! - [`watch`]：watch 监督任务与事件转发。

use super::*;

mod daemon;
mod deploy;
mod download;
mod host_runtime;
mod install_cache;
mod paths;
mod scripts;
mod serve;
mod terminal;
mod watch;

pub(crate) use daemon::{
    daemon_scan_entries, daemon_search_content_call, downgrade_server_daemon,
    shutdown_remote_daemon, DaemonSearchParams,
};
pub(crate) use deploy::{
    ensure_server_endpoint_with_app, kick_server_discovery, note_server_endpoint_lost,
    ready_server_endpoint, require_serve_endpoint, require_server_endpoint, server_mode_error,
    SERVER_MODE_ERROR_PREFIX,
};
pub(crate) use download::resolve_offline_server_dir;
pub(crate) use host_runtime::{invalidate_shared_daemon, shared_server_known, HostDaemonCache};
pub(crate) use paths::{
    parse_server_state, server_serve_log_path, server_state_path, windows_host_path,
};
pub(crate) use scripts::{kill_server_command, windows_kill_server_script};
pub(crate) use serve::{server_stream_call, ServerStreamOutcome};
pub(crate) use terminal::{
    attach_persistent_terminal, kill_detached_terminals, list_detached_terminals,
    spawn_persistent_terminal, DetachedTerminal, PersistentLaunch, PersistentTerminal,
};
pub(crate) use watch::spawn_server_watch_supervisor;

/// server 首次 ping / 单次往返的响应时限。
const AGENT_PING_TIMEOUT: Duration = Duration::from_secs(10);

/// 一个已就绪的远端 server 端点。
#[derive(Clone)]
pub(crate) struct ServerEndpoint {
    pub(crate) serve: Option<ServeEndpoint>,
    /// A daemon-only endpoint has no project serve process. Create serve lazily
    /// if the shared daemon transport fails.
    pub(crate) daemon: Option<DaemonAccess>,
}

#[derive(Clone)]
pub(crate) struct ServeEndpoint {
    pub(crate) port: u16,
    pub(crate) token: String,
}

/// daemon 传输的接入信息：远端二进制路径与会话 token。
///
/// token 由 daemon 启动时生成并写入 `~/.qingcode/server/run/token`（`0600`），
/// 每次 daemon 重启都会轮换；校验失败时连接会被 daemon 直接断开。
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DaemonAccess {
    pub(crate) bin: String,
    pub(crate) token: String,
}

/// 每个连接 + 项目根的挂载状态：共享 daemon 绑定、可选 serve 或不可用原因。
/// 原因只记录「本次连接内不可能恢复」的情形（架构不支持、本地缺二进制），
/// 避免每次目录扫描都重复探测部署；瞬时失败不写原因，下次调用会再试。
#[derive(Default, Clone)]
pub(crate) struct ServerSlot {
    pub(crate) endpoint: Option<ServerEndpoint>,
    pub(crate) unavailable_reason: Option<String>,
    /// 发现/部署过程中的瞬时阶段（installing / handshaking）。稳态为 None。
    pub(crate) activity: Option<server_status::ServerPhase>,
    /// daemon 传输最近一次降级的时间：冷却 [`daemon::AGENT_DAEMON_RETRY_AFTER_DOWNGRADE`]
    /// 后由 ensure 快路径重新探测，daemon 崩溃不至于永久留在 serve 模式。
    pub(crate) daemon_downgraded_at: Option<Instant>,
    /// 连续「完整部署后仍未就绪」的次数，达到阈值触发部署退避；成功后清零。
    pub(crate) deploy_failures: u32,
    /// 最近一次瞬时失败的原因，仅用于展示（阶段仍是探测/进行中，之后会自动
    /// 重试）。与 [`ServerSlot::unavailable_reason`] 的区别：这里不代表终态，
    /// 不参与端点缓存判断；成功部署或清除不可用原因时一并清掉。
    pub(crate) last_failure: Option<String>,
    /// 最近一次发现/部署的分阶段耗时摘要（如「目录 0.8s · 校验 1.1s · 合计 2.3s」），
    /// 仅用于详情面板展示与性能回归对照。
    pub(crate) last_timings: Option<String>,
    /// 后台 daemon 探测正在进行：避免发现成功与冷却重试同时各拉一轮。
    pub(crate) daemon_probe_pending: bool,
    /// 最近一次 daemon 探测的失败原因，Server 模式终端报错时展示；探测成功即清掉。
    pub(crate) daemon_failure: Option<String>,
}

pub(crate) fn server_slot_key(connection_id: &str, canonical_root: &str) -> String {
    format!("{connection_id}|{canonical_root}")
}

/// 部署失败原因。`permanent` 为真表示本次连接内不可能恢复（远端架构不支持、
/// 本地没有对应二进制、sha256 校验失败），需要缓存成终态；其余按瞬时失败
/// 处理，下次调用重试。`after_deploy` 标记失败发生在完整部署阶段（上传/
/// 启动/等就绪），供部署退避计数使用。
struct ServerDeployError {
    reason: String,
    permanent: bool,
    after_deploy: bool,
}

impl ServerDeployError {
    fn permanent(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            permanent: true,
            after_deploy: false,
        }
    }

    /// 部署阶段（Installing 之后）的失败：本身按瞬时处理，但计入退避。
    fn deploy_stage(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            permanent: false,
            after_deploy: true,
        }
    }
}

impl From<String> for ServerDeployError {
    fn from(reason: String) -> Self {
        Self {
            reason,
            permanent: false,
            after_deploy: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_keys_pair_connection_with_root() {
        assert_eq!(server_slot_key("conn-1", "/srv/a"), "conn-1|/srv/a");
        assert_ne!(
            server_slot_key("conn-1", "/srv/a"),
            server_slot_key("conn-2", "/srv/a")
        );
        assert_ne!(
            server_slot_key("conn-1", "/srv/a"),
            server_slot_key("conn-1", "/srv/b")
        );
    }
}
