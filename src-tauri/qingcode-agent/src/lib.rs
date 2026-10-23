//! QingCode SSH 工作区远端代理：协议定义、路径安全与服务器骨架。
//!
//! 客户端（qingcode 主程序）与本 crate 共用帧编解码和消息类型，避免两端协议漂移。
//! 代理只监听 `127.0.0.1`，由客户端经 SSH `direct-tcpip` 通道接入，不存在公网暴露；
//! 所有操作都限制在启动参数 `--root` 指定的项目根内，越界请求一律拒绝。
//!
//! 连接模型：每条 TCP 连接承载一次操作。首帧是带 token 的请求，随后服务端
//! 按操作回 `records`（流式记录）/ `done`（结束）/ `error`；`watch` 连接会持续
//! 推送事件记录，直到客户端断开。

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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub token: String,
    pub op: AgentOp,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", content = "params", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentOp {
    Ping,
    /// 列出单个目录的直接子项。`path` 是相对代理根的 POSIX 路径（`""` 或 `.` 表示根）。
    Scan { path: String },
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
    Watch { path: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentResponse {
    Ok { version: String },
    Records { data: Vec<serde_json::Value> },
    Done {
        truncated: bool,
        files_scanned: usize,
    },
    Error { message: String },
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
    "release",
];

/// `path` 相对 `root` 的后代里是否含有高变动目录段。
pub fn is_high_churn_path(path: &Path, root: &Path) -> bool {
    let Ok(path) = path.strip_prefix(root) else {
        return false;
    };
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        HIGH_CHURN_DIRS.iter().any(|dir| dir.eq_ignore_ascii_case(&name))
    })
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
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let ctx = std::sync::Arc::clone(&ctx);
                    tokio::spawn(handle_conn(ctx, stream));
                }
                Err(_) => break,
            }
        }
    });
    Ok((actual, handle))
}

/// 单连接处理：首帧鉴权，随后按操作分发。流式操作在客户端断开时尽快收尾。
pub async fn handle_conn(ctx: std::sync::Arc<ServerCtx>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();

    // 首帧必须 10 秒内到达，防止半开连接占用任务。
    let request = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        read_frame(&mut reader),
    )
    .await
    {
        Ok(Ok(payload)) => payload,
        _ => return,
    };
    let Ok(request) = serde_json::from_slice::<AgentRequest>(&request) else {
        return;
    };
    if request.token != ctx.token {
        let _ = write_response(&mut writer, &AgentResponse::Error {
            message: "agent token 校验失败".to_string(),
        })
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

async fn handle_scan<W: AsyncWrite + Unpin>(
    ctx: &ServerCtx,
    writer: &mut W,
    relative: &str,
) {
    match ops::scan_dir(&ctx.root, relative) {
        Ok(entries) => {
            let data = entries
                .iter()
                .map(|entry| {
                    serde_json::json!({ "name": entry.name, "isDir": entry.is_dir })
                })
                .collect();
            let _ = write_response(writer, &AgentResponse::Records { data }).await;
            let _ = write_response(writer, &AgentResponse::Done { truncated: false, files_scanned: 0 }).await;
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
            let _ = write_response(writer, &AgentResponse::Error {
                message: "监视路径越出了项目根".to_string(),
            })
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

    // watch 连接没有 done：客户端断开（读端 EOF）即结束。读端保活由
    // 后台任务负责——客户端不再发送任何帧，这里只需要在写失败时收尾。
    let mut write_error = false;
    while let Some(event) = rx.recv().await {
        if write_response(writer, &AgentResponse::Records { data: vec![event] })
            .await
            .is_err()
        {
            write_error = true;
            break;
        }
    }
    if write_error {
        cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    // 读端等 watcher 任务收尾，保证进程退出前释放 inotify 资源。
    let _ = watcher.await;
    let _ = reader;
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
        assert!(is_high_churn_path(Path::new("/srv/project/target/debug/x"), root));
        assert!(is_high_churn_path(Path::new("/srv/project/node_modules/y"), root));
        assert!(!is_high_churn_path(Path::new("/srv/project/src/main.rs"), root));
        assert!(!is_high_churn_path(Path::new("/srv/target/x"), root));
    }

    #[test]
    fn token_is_hex_and_nonempty() {
        let token = generate_token();
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
