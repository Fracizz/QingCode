//! QingCode SSH 工作区远端代理：协议定义、路径安全与服务器骨架。
//!
//! 客户端（qingcode 主程序）与本 crate 共用帧编解码和消息类型，避免两端协议漂移。
//! 代理只监听 `127.0.0.1`，由客户端经 SSH `direct-tcpip` 通道接入，不存在公网暴露；
//! 所有操作都限制在启动参数 `--root` 指定的项目根内，越界请求一律拒绝。
//!
//! 连接模型：每条 TCP 连接承载一次操作。首帧是带 token 的请求，随后服务端
//! 按操作回 `records`（流式记录）/ `done`（结束）/ `error`；`watch` 连接会持续
//! 推送事件记录，直到客户端断开。

// 实现层：文件系统操作、文件监视与 PTY 宿主，协议契约全部在本文件内定义。
mod ops;
mod pty;
mod watch;

// 协议 v1 + daemon/connect：与上面的 `serve` 契约并存，互不影响。
pub mod connect;
pub mod daemon;
pub mod proto;

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

/// 与 qingcode 主程序版本保持一致：客户端用它判断远端代理是否需要重新部署。
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 单帧上限。内容搜索单条记录（一行匹配文本）按客户端约定不超过 2MB，
/// 这里放宽到 4MB 兼容超长行的 lossy 截断。
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// watch 心跳间隔：无事件时每 15s 推一个空记录帧。客户端侧空闲轮询为 5s、
/// 整体超时约 30s，心跳既不会打扰客户端，又能让半开连接在有限时间内写失败。
const WATCH_HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(15);

/// 帧格式：4 字节小端长度 + JSON 负载。长度为 0 或超上限都视为协议错误。
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header).await?;
    let len = u32::from_le_bytes(header) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "非法帧长度"));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    Ok(payload)
}

pub async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "非法帧长度"));
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .await?;
    writer.write_all(payload).await?;
    writer.flush().await
}

/// 客户端首帧：token 鉴权与操作参数一起送达，省一次往返。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub token: String,
    pub op: AgentOp,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    content = "params",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentOp {
    Ping,
    /// 列出单个目录的直接子项。`path` 是相对代理根的 POSIX 路径（`""` 或 `.` 表示根）。
    Scan {
        path: String,
    },
    /// 字面量内容搜索，记录格式与 `rg --json` 的 match 记录一致，
    /// 客户端复用现有解析逻辑。每个文件最多产出 `max_per_file + 1` 条记录，
    /// 多出的 1 条用于向客户端标记单文件截断。
    SearchContent {
        query: String,
        ignore_case: bool,
        /// glob 白名单（如 `*.ts`）与黑名单（`!` 前缀），语义与 `rg -g` 一致。
        include_globs: Vec<String>,
        exclude_globs: Vec<String>,
        /// 对应 `rg --no-ignore`：忽略所有 ignore 文件规则。
        no_ignore: bool,
        max_matches: usize,
        max_per_file: usize,
        max_files: usize,
    },
    /// 递归监视目录，持续推送事件记录直到客户端断开。
    Watch {
        path: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentResponse {
    Ok {
        version: String,
    },
    Records {
        data: Vec<serde_json::Value>,
    },
    Done {
        truncated: bool,
        files_scanned: usize,
    },
    Error {
        message: String,
    },
}

/// 远端状态文件（`<项目根>/.qingcode/agent/agent.json`）。
/// 客户端靠它发现存活代理（端口 / token / 版本），重启应用后免重新部署。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateFile {
    pub version: String,
    pub port: u16,
    pub pid: u32,
    pub token: String,
    pub root: String,
}

/// 把「相对代理根」的路径解析成绝对路径，词法上拒绝 `..` 与空字节。
/// 返回值未经 canonicalize；需要真实路径校验的调用方（scan/watch）自行补一步。
pub fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains('\0') {
        return Err("路径包含无效字符".to_string());
    }
    // 绝对路径一律显式拒绝：静默重解释成 <root>/<绝对路径> 会把 /etc 之类
    // 错误地映射进项目内的 etc/ 目录，报错信息也会误导调用方。
    if relative.starts_with('/') {
        return Err("路径越出了项目根".to_string());
    }
    let rel = relative.trim_matches('/');
    let mut path = root.to_path_buf();
    for segment in rel.split('/') {
        match segment {
            "" | "." => {}
            ".." => return Err("路径不允许越出项目根".to_string()),
            other => path.push(other),
        }
    }
    Ok(path)
}

/// 组件级前缀边界检查：`child` 必须等于 `root` 或位于其下。
/// 基于组件比较，`app` 与 `application` 不会混淆；两端都应先 canonicalize。
pub fn path_is_within(child: &Path, root: &Path) -> bool {
    child.starts_with(root)
}

/// 把字面量文本转义为等价正则（客户端侧的 `rg --fixed-strings` 语义）。
pub fn escape_regex_literal(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() * 2);
    for ch in pattern.chars() {
        if ch.is_ascii_punctuation() {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 生成连接 token：unix 读 `/dev/urandom`，其他平台退化为时间 + pid 混淆
/// （代理只监听 127.0.0.1 且状态文件 0600，兜底熵仅用于开发宿主自测）。
pub fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    #[cfg(unix)]
    {
        if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
            use std::io::Read;
            if file.read_exact(&mut bytes).is_ok() {
                return hex(&bytes);
            }
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let mixed = nanos as u64 ^ u64::from(std::process::id()) << 17;
    bytes[..8].copy_from_slice(&mixed.to_le_bytes());
    let mixed2 = nanos.wrapping_mul(0x9E37_79B9_7F4A_7C15) as u64;
    bytes[8..].copy_from_slice(&mixed2.to_le_bytes());
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 本地 watcher 同款的高变动目录：代理侧先过滤，避免事件流与刷新被构建产物淹没。
/// 这些目录名在**任意层级**都算高变动。
pub const HIGH_CHURN_DIRS: &[&str] = &[
    ".git",
    ".next",
    ".turbo",
    ".cache",
    ".dev",
    ".venv",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
];

/// 只在项目根第一层才算高变动的目录，与主程序 `file_watcher.rs` 的
/// `ROOT_HIGH_CHURN_DIRS` 保持一致：根级 `release/` 是打包产物，
/// 但 `src/release/` 这类同名源码目录仍要正常刷新。
pub const ROOT_HIGH_CHURN_DIRS: &[&str] = &["release"];

/// `path` 相对 `root` 的后代里是否含有高变动目录段。
/// 根级目录只匹配 [`ROOT_HIGH_CHURN_DIRS`] 里的名字，其余按任意层级匹配。
pub fn is_high_churn_path(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let matches_any =
        |name: &str, dirs: &[&str]| dirs.iter().any(|dir| dir.eq_ignore_ascii_case(name));
    if let Some(first) = relative.components().next() {
        if matches_any(&first.as_os_str().to_string_lossy(), ROOT_HIGH_CHURN_DIRS) {
            return true;
        }
    }
    relative
        .components()
        .any(|component| matches_any(&component.as_os_str().to_string_lossy(), HIGH_CHURN_DIRS))
}

/// 服务器上下文与连接处理。
pub struct ServerCtx {
    /// 已 canonicalize 的项目根。
    pub root: PathBuf,
    pub token: String,
}

/// 绑定 `127.0.0.1:port`（0 为临时端口），返回实际端口与后台 accept 任务。
pub async fn bind_server(
    ctx: std::sync::Arc<ServerCtx>,
    port: u16,
) -> io::Result<(u16, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let actual = listener.local_addr()?.port();
    let handle = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let ctx = std::sync::Arc::clone(&ctx);
            tokio::spawn(handle_conn(ctx, stream));
        }
    });
    Ok((actual, handle))
}

/// 单连接处理：首帧鉴权，随后按操作分发。流式操作在客户端断开时尽快收尾。
pub async fn handle_conn(ctx: std::sync::Arc<ServerCtx>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();

    // 首帧必须 10 秒内到达，防止半开连接占用任务。
    let request =
        match tokio::time::timeout(std::time::Duration::from_secs(10), read_frame(&mut reader))
            .await
        {
            Ok(Ok(payload)) => payload,
            _ => return,
        };
    let Ok(request) = serde_json::from_slice::<AgentRequest>(&request) else {
        return;
    };
    if request.token != ctx.token {
        let _ = write_response(
            &mut writer,
            &AgentResponse::Error {
                message: "agent token 校验失败".to_string(),
            },
        )
        .await;
        return;
    }

    match request.op {
        AgentOp::Ping => {
            let _ = write_response(
                &mut writer,
                &AgentResponse::Ok {
                    version: AGENT_VERSION.to_string(),
                },
            )
            .await;
        }
        AgentOp::Scan { path } => {
            handle_scan(&ctx, &mut writer, &path).await;
        }
        AgentOp::SearchContent {
            query,
            ignore_case,
            include_globs,
            exclude_globs,
            no_ignore,
            max_matches,
            max_per_file,
            max_files,
        } => {
            let params = ops::ContentSearchParams {
                query,
                ignore_case,
                include_globs,
                exclude_globs,
                no_ignore,
                max_matches,
                max_per_file,
                max_files,
            };
            handle_search_content(&ctx, &mut writer, params).await;
        }
        AgentOp::Watch { path } => {
            handle_watch(&ctx, &mut reader, &mut writer, &path).await;
        }
    }
}

async fn write_response<W: AsyncWrite + Unpin>(
    writer: &mut W,
    response: &AgentResponse,
) -> io::Result<()> {
    let payload = serde_json::to_vec(response).map_err(io::Error::other)?;
    write_frame(writer, &payload).await
}

async fn handle_scan<W: AsyncWrite + Unpin>(ctx: &ServerCtx, writer: &mut W, relative: &str) {
    match ops::scan_dir(&ctx.root, relative) {
        Ok(entries) => {
            let data = entries
                .iter()
                .map(|entry| serde_json::json!({ "name": entry.name, "isDir": entry.is_dir }))
                .collect();
            let _ = write_response(writer, &AgentResponse::Records { data }).await;
            let _ = write_response(
                writer,
                &AgentResponse::Done {
                    truncated: false,
                    files_scanned: 0,
                },
            )
            .await;
        }
        Err(message) => {
            let _ = write_response(writer, &AgentResponse::Error { message }).await;
        }
    }
}

async fn handle_search_content<W: AsyncWrite + Unpin>(
    ctx: &ServerCtx,
    writer: &mut W,
    params: ops::ContentSearchParams,
) {
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<serde_json::Value>(64);
    let root = ctx.root.clone();
    let cancel_for_task = std::sync::Arc::clone(&cancel);
    let producer = tokio::task::spawn_blocking(move || {
        ops::search_content(&root, &params, &cancel_for_task, &tx)
    });

    // 客户端断开（写失败）时置位取消标记，阻塞中的 walker 会在文件间隙退出。
    let mut write_error = false;
    while let Some(record) = rx.recv().await {
        if write_response(writer, &AgentResponse::Records { data: vec![record] })
            .await
            .is_err()
        {
            write_error = true;
            break;
        }
    }
    if write_error {
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        return;
    }
    match producer.await {
        Ok(Ok(summary)) => {
            let _ = write_response(
                writer,
                &AgentResponse::Done {
                    truncated: summary.truncated,
                    files_scanned: summary.files_scanned,
                },
            )
            .await;
        }
        Ok(Err(message)) => {
            let _ = write_response(writer, &AgentResponse::Error { message }).await;
        }
        Err(_) => {}
    }
}

async fn handle_watch<W: AsyncWrite + Unpin>(
    ctx: &ServerCtx,
    reader: &mut (impl AsyncRead + Unpin + Send),
    writer: &mut W,
    relative: &str,
) {
    let resolved = match resolve_within_root(&ctx.root, relative)
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok())
    {
        Some(resolved) if path_is_within(&resolved, &ctx.root) => resolved,
        _ => {
            let _ = write_response(
                writer,
                &AgentResponse::Error {
                    message: "监视路径越出了项目根".to_string(),
                },
            )
            .await;
            return;
        }
    };
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<serde_json::Value>(64);
    let cancel_for_task = std::sync::Arc::clone(&cancel);
    let watcher = tokio::task::spawn_blocking(move || {
        // 返回值只用于关闭连接时的错误上报；断开是正常收尾。
        let _ = watch::watch_loop(resolved, cancel_for_task, tx);
    });

    // 收尾条件有三条：客户端读端 EOF/错误、写失败、监视器任务结束。
    // 只靠写失败是不够的——安静仓库里没有事件就永远不会写，客户端断开后
    // watcher 任务与 inotify 实例会一直存活（客户端每轮超时重连还会不断累积）。
    // 因此这里始终轮询读端，并用心跳帧让「客户端已死但 TCP 未断」也能暴露。
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + WATCH_HEARTBEAT,
        WATCH_HEARTBEAT,
    );
    // 客户端在首帧之后不再发包，故任意读到字节/EOF/错误都按连接结束处理。
    let mut read_buf = [0u8; 64];
    loop {
        tokio::select! {
            biased;
            _ = reader.read(&mut read_buf) => break,
            event = rx.recv() => {
                let Some(event) = event else {
                    // 监视器已失效（如根目录被删除），没有可推送的事件了。
                    break;
                };
                if write_response(writer, &AgentResponse::Records { data: vec![event] })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            _ = heartbeat.tick() => {
                // 空 data 的心跳帧：客户端遍历 data 时自然忽略，协议无需新增消息类型。
                if write_response(writer, &AgentResponse::Records { data: Vec::new() })
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    // 先丢弃接收端：watcher 若正卡在 blocking_send（客户端不读、通道满），
    // 会立刻收到错误返回，不必等满一个 250ms 轮询周期。
    drop(rx);
    // 等阻塞任务收尾，保证 debouncer 一定被 drop（inotify 实例随之释放）。
    let _ = watcher.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_regex_literal_quotes_metacharacters() {
        assert_eq!(escape_regex_literal("a.b*c"), r"a\.b\*c");
        assert_eq!(escape_regex_literal("中文"), "中文");
        assert_eq!(escape_regex_literal("a b"), "a b");
    }

    #[test]
    fn resolve_within_root_rejects_escape_attempts() {
        let root = Path::new("/srv/project");
        assert_eq!(
            resolve_within_root(root, "src/main.rs").unwrap(),
            PathBuf::from("/srv/project/src/main.rs")
        );
        assert_eq!(resolve_within_root(root, "").unwrap(), root);
        assert_eq!(resolve_within_root(root, ".").unwrap(), root);
        assert!(resolve_within_root(root, "../escape").is_err());
        assert!(resolve_within_root(root, "a/../../escape").is_err());
        assert!(resolve_within_root(root, "a\0b").is_err());
        // 绝对路径必须显式拒绝，而不是被静默重解释成 <root>/etc。
        assert!(resolve_within_root(root, "/etc").is_err());
        assert!(resolve_within_root(root, "/srv/project/src").is_err());
    }

    #[test]
    fn path_within_checks_components_not_strings() {
        let root = Path::new("/srv/project");
        assert!(path_is_within(Path::new("/srv/project/src"), root));
        assert!(path_is_within(root, root));
        assert!(!path_is_within(Path::new("/srv/project-other"), root));
    }

    #[test]
    fn high_churn_filter_matches_below_root_only() {
        let root = Path::new("/srv/project");
        assert!(is_high_churn_path(
            Path::new("/srv/project/target/debug/x"),
            root
        ));
        assert!(is_high_churn_path(
            Path::new("/srv/project/node_modules/y"),
            root
        ));
        assert!(!is_high_churn_path(
            Path::new("/srv/project/src/main.rs"),
            root
        ));
        assert!(!is_high_churn_path(Path::new("/srv/target/x"), root));
    }

    #[test]
    fn high_churn_release_only_at_root_level() {
        let root = Path::new("/srv/project");
        // 根级 release 是打包产物目录，必须过滤。
        assert!(is_high_churn_path(
            Path::new("/srv/project/release/x"),
            root
        ));
        assert!(is_high_churn_path(Path::new("/srv/project/release"), root));
        // 子目录同名 release 是普通源码目录，与主程序一致要正常刷新。
        assert!(!is_high_churn_path(
            Path::new("/srv/project/src/release/x"),
            root
        ));
        assert!(!is_high_churn_path(
            Path::new("/srv/project/a/b/release/x"),
            root
        ));
        // 其余目录名保持任意层级匹配。
        assert!(is_high_churn_path(
            Path::new("/srv/project/src/target/x"),
            root
        ));
        assert!(is_high_churn_path(
            Path::new("/srv/project/a/b/dist/x"),
            root
        ));
    }

    /// 临时目录：进程 id + 纳秒时间戳保证唯一，canonicalize 后返回。
    fn temp_root(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "qingcode-agent-lib-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// 客户端断开读端后，handle_watch 必须自行收尾（而不是永远等事件）。
    #[tokio::test]
    async fn watch_returns_after_client_read_side_closes() {
        let root = temp_root("watch-eof");
        let ctx = std::sync::Arc::new(ServerCtx {
            root: root.clone(),
            token: "test-token".to_string(),
        });
        let (mut server_reader, client_writer) = tokio::io::duplex(64);
        let (mut server_writer, client_reader) = tokio::io::duplex(64);
        let ctx_for_task = std::sync::Arc::clone(&ctx);
        let task = tokio::spawn(async move {
            handle_watch(&ctx_for_task, &mut server_reader, &mut server_writer, "").await;
        });
        // 客户端写端关闭 → 服务端读端 EOF：安静目录里没有任何事件也应立即结束。
        drop(client_writer);
        let joined = tokio::time::timeout(std::time::Duration::from_secs(5), task).await;
        assert!(joined.is_ok(), "handle_watch 未在读端 EOF 后结束");
        drop(client_reader);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn watch_rejects_path_outside_root() {
        let root = temp_root("watch-escape");
        let ctx = ServerCtx {
            root: root.clone(),
            token: "test-token".to_string(),
        };
        let (mut server_reader, _client_writer) = tokio::io::duplex(64);
        let (mut server_writer, mut client_reader) = tokio::io::duplex(1024);
        handle_watch(&ctx, &mut server_reader, &mut server_writer, "../").await;
        let payload = read_frame(&mut client_reader).await.unwrap();
        let response: AgentResponse = serde_json::from_slice(&payload).unwrap();
        assert!(matches!(response, AgentResponse::Error { .. }));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn token_is_hex_and_nonempty() {
        let token = generate_token();
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
