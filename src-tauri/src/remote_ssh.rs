use crate::file_encoding;
use crate::path_guard::PathAllowlist;
use crate::terminal::{TerminalDataPayload, TerminalExitPayload, TerminalSpawnResult};
use russh::client;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const SSH_URI_PREFIX: &str = "ssh://";
const MAX_EDITOR_FILE_SIZE: u64 = 100 * 1024 * 1024;
const MAX_SLICE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionConfig {
    pub id: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth_kind: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    pub host_key_fingerprint: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostProbe {
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectResult {
    pub fingerprint: String,
    pub canonical_root: String,
}

#[derive(Debug, Serialize)]
pub struct RemoteFileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct RemoteFileStat {
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileSlice {
    pub content: String,
    pub offset: u64,
    pub next_offset: u64,
    pub file_size: u64,
    pub eof: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSymlinkWriteCheck {
    pub needs_confirm: bool,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: u32,
}

#[derive(Debug, Serialize)]
pub struct RemoteSearchHit {
    pub name: String,
    pub path: String,
    pub relative: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct RemoteContentMatch {
    pub line: u32,
    pub text: String,
    pub match_start: u32,
    pub match_end: u32,
}

#[derive(Debug, Serialize)]
pub struct RemoteContentFile {
    pub name: String,
    pub path: String,
    pub relative: String,
    pub matches: Vec<RemoteContentMatch>,
}

#[derive(Debug, Serialize)]
pub struct RemoteContentResponse {
    pub files: Vec<RemoteContentFile>,
    pub match_count: usize,
    pub files_scanned: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitChange {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitStatus {
    pub is_repository: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub behind: u32,
    pub ahead: u32,
    pub last_fetch_at: Option<u64>,
    pub last_pull_at: Option<u64>,
    pub last_push_at: Option<u64>,
    pub changes: Vec<RemoteGitChange>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitPullResult {
    pub summary: String,
    pub has_conflicts: bool,
    pub conflict_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitBranchInfo {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitBranchList {
    pub local: Vec<RemoteGitBranchInfo>,
    pub remote: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitRemote {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_urls: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitCommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub refs: String,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitCommitFileChange {
    pub status: String,
    pub path: String,
    pub previous_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RemoteGitFileContents {
    pub original: String,
    pub modified: String,
}

#[derive(Clone)]
struct SshClient {
    expected_fingerprint: Option<String>,
    observed_fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        if let Ok(mut observed) = self.observed_fingerprint.lock() {
            *observed = Some(fingerprint.clone());
        }
        Ok(self
            .expected_fingerprint
            .as_deref()
            .is_some_and(|expected| expected == fingerprint))
    }
}

struct ConnectedSession {
    handle: client::Handle<SshClient>,
}

#[derive(Clone, Debug)]
struct RegisteredRoot {
    uri: String,
    canonical_path: String,
    trusted: bool,
}

type RemoteTerminalWriter = ChannelWriteHalf<client::Msg>;

pub struct SshManager {
    sessions: RwLock<HashMap<String, Arc<ConnectedSession>>>,
    roots: RwLock<HashMap<String, RegisteredRoot>>,
    terminals: RwLock<HashMap<String, Arc<RemoteTerminalWriter>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            roots: RwLock::new(HashMap::new()),
            terminals: RwLock::new(HashMap::new()),
        }
    }

    fn session(&self, connection_id: &str) -> Result<Arc<ConnectedSession>, String> {
        self.sessions
            .read()
            .map_err(|_| "SSH 连接状态不可用".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| "SSH 连接尚未建立，请重新连接".to_string())
    }

    fn root_for_uri(&self, uri: &str, require_trust: bool) -> Result<RegisteredRoot, String> {
        let roots = self
            .roots
            .read()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?;
        let root = roots
            .values()
            .filter(|root| remote_uri_is_within(uri, &root.uri))
            .max_by_key(|root| root.uri.len())
            .cloned()
            .ok_or_else(|| "远程路径不在已注册项目内".to_string())?;
        if require_trust && !root.trusted {
            return Err("项目未信任（受限模式），无法修改文件或运行命令".to_string());
        }
        Ok(root)
    }

    async fn sftp_for_uri(
        &self,
        uri: &str,
        require_trust: bool,
    ) -> Result<(SftpSession, RemoteUri, RegisteredRoot), String> {
        let parsed = parse_remote_uri(uri)?;
        let root = self.root_for_uri(uri, require_trust)?;
        let session = self.session(&parsed.connection_id)?;
        let channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("打开 SSH SFTP 通道失败：{error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("远端未启用 SFTP：{error}"))?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| format!("初始化 SFTP 失败：{error}"))?;
        sftp.set_timeout(30);
        Ok((sftp, parsed, root))
    }

    async fn exec_uri(
        &self,
        uri: &str,
        command: &str,
        require_trust: bool,
    ) -> Result<RemoteExecResult, String> {
        let parsed = parse_remote_uri(uri)?;
        self.root_for_uri(uri, require_trust)?;
        let session = self.session(&parsed.connection_id)?;
        let mut channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("打开 SSH 命令通道失败：{error}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|error| format!("执行远程命令失败：{error}"))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                _ => {}
            }
        }
        Ok(RemoteExecResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: exit_code.unwrap_or(255),
        })
    }

    async fn exec_uri_with_input(
        &self,
        uri: &str,
        command: &str,
        input: &[u8],
        require_trust: bool,
    ) -> Result<RemoteExecResult, String> {
        let parsed = parse_remote_uri(uri)?;
        self.root_for_uri(uri, require_trust)?;
        let session = self.session(&parsed.connection_id)?;
        let mut channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("打开 SSH 命令通道失败：{error}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|error| format!("执行远程命令失败：{error}"))?;
        channel
            .data(input)
            .await
            .map_err(|error| format!("发送远程命令输入失败：{error}"))?;
        channel
            .eof()
            .await
            .map_err(|error| format!("结束远程命令输入失败：{error}"))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                _ => {}
            }
        }
        Ok(RemoteExecResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: exit_code.unwrap_or(255),
        })
    }
}

#[derive(Debug)]
struct RemoteUri {
    connection_id: String,
    path: String,
}

fn parse_remote_uri(uri: &str) -> Result<RemoteUri, String> {
    let rest = uri
        .strip_prefix(SSH_URI_PREFIX)
        .ok_or_else(|| "不是有效的 SSH 资源地址".to_string())?;
    let (connection_id, path_tail) = rest
        .split_once('/')
        .ok_or_else(|| "SSH 资源地址缺少远程路径".to_string())?;
    if connection_id.is_empty() {
        return Err("SSH 资源地址缺少连接 ID".to_string());
    }
    let path = format!("/{path_tail}");
    validate_remote_path(&path)?;
    Ok(RemoteUri {
        connection_id: connection_id.to_string(),
        path: normalize_remote_path(&path),
    })
}

fn validate_remote_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("远程路径必须是绝对 POSIX 路径".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("远程路径不允许包含 ..".to_string());
    }
    Ok(())
}

fn normalize_remote_path(path: &str) -> String {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

fn normalize_remote_uri(uri: &str) -> String {
    uri.trim_end_matches('/').to_string()
}

fn remote_uri_connection_id(uri: &str) -> Option<&str> {
    uri.strip_prefix(SSH_URI_PREFIX)?
        .split('/')
        .next()
        .filter(|value| !value.is_empty())
}

fn remote_uri_is_within(uri: &str, root: &str) -> bool {
    let uri = normalize_remote_uri(uri);
    let root = normalize_remote_uri(root);
    uri == root || uri.starts_with(&format!("{root}/"))
}

fn join_remote_uri(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}

fn remote_parent_path(path: &str) -> Result<&str, String> {
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .ok_or_else(|| "远程路径缺少父目录".to_string())
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        Err("名称不能为空或包含路径分隔符".to_string())
    } else {
        Ok(())
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn open_transport(
    config: &SshConnectionConfig,
    expected_fingerprint: Option<String>,
) -> Result<(client::Handle<SshClient>, String), String> {
    let observed = Arc::new(Mutex::new(None));
    let handler = SshClient {
        expected_fingerprint,
        observed_fingerprint: Arc::clone(&observed),
    };
    let client_config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    };
    let result = client::connect(
        Arc::new(client_config),
        (config.host.as_str(), config.port),
        handler,
    )
    .await;
    let fingerprint = observed
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .unwrap_or_default();
    let handle = result.map_err(|error| format!("SSH 连接失败：{error}"))?;
    if fingerprint.is_empty() {
        return Err("SSH 服务端未提供主机密钥".to_string());
    }
    Ok((handle, fingerprint))
}

async fn authenticate(
    handle: &mut client::Handle<SshClient>,
    config: &SshConnectionConfig,
) -> Result<(), String> {
    let result = match config.auth_kind.as_str() {
        "password" => {
            let password = config
                .password
                .as_deref()
                .ok_or_else(|| "请输入 SSH 密码".to_string())?;
            handle
                .authenticate_password(&config.username, password)
                .await
                .map_err(|error| format!("SSH 密码认证失败：{error}"))?
        }
        _ => {
            let key_path = config
                .private_key_path
                .as_deref()
                .ok_or_else(|| "请选择 SSH 私钥文件".to_string())?;
            let key = load_secret_key(key_path, config.passphrase.as_deref())
                .map_err(|error| format!("读取 SSH 私钥失败：{error}"))?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("协商 SSH 密钥算法失败：{error}"))?
                .flatten();
            handle
                .authenticate_publickey(
                    &config.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|error| format!("SSH 私钥认证失败：{error}"))?
        }
    };
    if result.success() {
        Ok(())
    } else {
        Err("SSH 认证失败，请检查用户名和凭据".to_string())
    }
}

#[tauri::command]
pub async fn ssh_probe_host(config: SshConnectionConfig) -> Result<SshHostProbe, String> {
    let observed = Arc::new(Mutex::new(None));
    let handler = SshClient {
        expected_fingerprint: None,
        observed_fingerprint: Arc::clone(&observed),
    };
    let result = client::connect(
        Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(15)),
            ..Default::default()
        }),
        (config.host.as_str(), config.port),
        handler,
    )
    .await;
    if let Ok(handle) = result {
        let _ = handle
            .disconnect(Disconnect::ByApplication, "host key probe", "en")
            .await;
    }
    let fingerprint = observed
        .lock()
        .map_err(|_| "SSH 主机密钥状态不可用".to_string())?
        .clone()
        .ok_or_else(|| "无法获取 SSH 主机指纹，请检查地址和端口".to_string())?;
    Ok(SshHostProbe { fingerprint })
}

#[tauri::command]
pub async fn ssh_connect(
    config: SshConnectionConfig,
    root_uri: String,
    trusted: bool,
    manager: State<'_, SshManager>,
) -> Result<SshConnectResult, String> {
    let expected = config
        .host_key_fingerprint
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "连接前必须确认 SSH 主机指纹".to_string())?;
    let parsed_root = parse_remote_uri(&root_uri)?;
    if parsed_root.connection_id != config.id {
        return Err("SSH 项目与连接配置不匹配".to_string());
    }
    let (mut handle, fingerprint) = open_transport(&config, Some(expected)).await?;
    authenticate(&mut handle, &config).await?;
    let connected = Arc::new(ConnectedSession { handle });
    let channel = connected
        .handle
        .channel_open_session()
        .await
        .map_err(|error| format!("打开 SSH SFTP 通道失败：{error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("远端未启用 SFTP：{error}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("初始化 SFTP 失败：{error}"))?;
    let canonical_root = sftp
        .canonicalize(parsed_root.path)
        .await
        .map_err(|error| format!("远程项目目录不可用：{error}"))?;
    let metadata = sftp
        .metadata(canonical_root.clone())
        .await
        .map_err(|error| format!("读取远程项目目录失败：{error}"))?;
    if !metadata.is_dir() {
        return Err("远程项目路径不是目录".to_string());
    }
    manager
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .insert(config.id.clone(), Arc::clone(&connected));
    manager
        .roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .insert(
            root_uri.clone(),
            RegisteredRoot {
                uri: normalize_remote_uri(&root_uri),
                canonical_path: canonical_root.clone(),
                trusted,
            },
        );
    Ok(SshConnectResult {
        fingerprint,
        canonical_root,
    })
}

#[tauri::command]
pub async fn ssh_disconnect(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let session = manager
        .sessions
        .write()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .remove(&connection_id);
    manager
        .roots
        .write()
        .map_err(|_| "SSH 工作区状态不可用".to_string())?
        .retain(|_, root| remote_uri_connection_id(&root.uri) != Some(connection_id.as_str()));
    if let Some(session) = session {
        session
            .handle
            .disconnect(Disconnect::ByApplication, "QingCode disconnect", "en")
            .await
            .map_err(|error| format!("断开 SSH 连接失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_connection_status(
    connection_id: String,
    manager: State<'_, SshManager>,
) -> Result<bool, String> {
    Ok(manager
        .sessions
        .read()
        .map_err(|_| "SSH 连接状态不可用".to_string())?
        .get(&connection_id)
        .is_some_and(|session| !session.handle.is_closed()))
}

#[tauri::command]
pub async fn ssh_validate_directory(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("远程目录不可用：{error}"))?;
    if !metadata.is_dir() {
        return Err(format!("远程路径不是目录：{}", parsed.path));
    }
    let canonical = sftp
        .canonicalize(parsed.path)
        .await
        .map_err(|error| format!("无法解析远程目录：{error}"))?;
    if !remote_path_is_within(&canonical, &root.canonical_path) {
        return Err("远程目录通过符号链接跳出了项目根目录".to_string());
    }
    Ok(())
}

fn remote_path_is_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

async fn ensure_existing_path_within(
    sftp: &SftpSession,
    path: &str,
    root: &RegisteredRoot,
) -> Result<String, String> {
    let canonical = sftp
        .canonicalize(path.to_string())
        .await
        .map_err(|error| format!("无法解析远程路径：{error}"))?;
    if !remote_path_is_within(&canonical, &root.canonical_path) {
        return Err("远程路径通过符号链接跳出了项目根目录".to_string());
    }
    Ok(canonical)
}

async fn ensure_parent_path_within(
    sftp: &SftpSession,
    path: &str,
    root: &RegisteredRoot,
) -> Result<String, String> {
    ensure_existing_path_within(sftp, remote_parent_path(path)?, root).await
}

#[tauri::command]
pub async fn ssh_scan_directory(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteFileNode>, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    let canonical = sftp
        .canonicalize(parsed.path.clone())
        .await
        .map_err(|error| format!("无法解析远程目录：{error}"))?;
    if !remote_path_is_within(&canonical, &root.canonical_path) {
        return Err("远程目录通过符号链接跳出了项目根目录".to_string());
    }
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let entries = sftp
        .read_dir(parsed.path)
        .await
        .map_err(|error| format!("读取远程目录失败：{error}"))?;
    for entry in entries {
        let name = entry.file_name();
        let node = RemoteFileNode {
            path: join_remote_uri(&path, &name),
            name,
            is_dir: entry.metadata().is_dir(),
        };
        if node.is_dir {
            dirs.push(node);
        } else {
            files.push(node);
        }
    }
    dirs.sort_by_key(|node| node.name.to_lowercase());
    files.sort_by_key(|node| node.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub async fn ssh_file_stat(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteFileStat, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    Ok(RemoteFileStat {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
    })
}

#[tauri::command]
pub async fn ssh_file_mtime(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Option<u64>, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件时间失败：{error}"))?;
    Ok(metadata.mtime.map(|seconds| u64::from(seconds) * 1000))
}

#[tauri::command]
pub async fn ssh_read_file(
    path: String,
    encoding: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    if metadata.is_dir() {
        return Err("无法把远程目录作为文件打开".to_string());
    }
    if metadata.len() > MAX_EDITOR_FILE_SIZE {
        return Err("暂不支持编辑超过 100MB 的远程文件".to_string());
    }
    let bytes = sftp
        .read(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    file_encoding::decode(&bytes, file_encoding::parse(encoding.as_deref()))
        .map_err(|error| format!("远程文件解码失败：{error}"))
}

#[tauri::command]
pub async fn ssh_detect_file_encoding(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let bytes = sftp
        .read(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    file_encoding::detect(&bytes[..bytes.len().min(8192)])
        .map(|encoding| encoding.as_str().to_string())
        .map_err(|error| format!("检测远程文件编码失败：{error}"))
}

#[tauri::command]
pub async fn ssh_read_file_slice(
    path: String,
    offset: u64,
    max_bytes: u64,
    manager: State<'_, SshManager>,
) -> Result<RemoteFileSlice, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let mut file = sftp
        .open(parsed.path)
        .await
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    let file_size = metadata.len();
    if offset > file_size {
        return Err("读取偏移超出远程文件范围".to_string());
    }
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| format!("定位远程文件失败：{error}"))?;
    let requested = max_bytes.clamp(1, MAX_SLICE_BYTES).min(file_size - offset) as usize;
    let mut bytes = vec![0; requested];
    let read = file
        .read(&mut bytes)
        .await
        .map_err(|error| format!("读取远程文件片段失败：{error}"))?;
    bytes.truncate(read);
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let next_offset = offset + read as u64;
    Ok(RemoteFileSlice {
        content,
        offset,
        next_offset,
        file_size,
        eof: next_offset >= file_size,
    })
}

#[tauri::command]
pub async fn ssh_write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    let bytes = file_encoding::encode(&content, file_encoding::parse(encoding.as_deref()))
        .map_err(|error| format!("远程文件编码失败：{error}"))?;
    if bytes.len() as u64 > MAX_EDITOR_FILE_SIZE {
        return Err("暂不支持保存超过 100MB 的远程文件".to_string());
    }
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
        let metadata = sftp
            .symlink_metadata(parsed.path.clone())
            .await
            .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
        if metadata.is_dir() {
            return Err("无法把远程目录作为文件保存".to_string());
        }
        // Preserve symlink semantics: an atomic rename would replace the link itself.
        if metadata.is_symlink() {
            return sftp
                .write(parsed.path, &bytes)
                .await
                .map_err(|error| format!("保存远程符号链接目标失败：{error}"));
        }
    }
    let parent = remote_parent_path(&parsed.path)?;
    let name = parsed.path.rsplit('/').next().unwrap_or("file");
    let temp = format!("{parent}/.{name}.qingcode-{}.tmp", uuid::Uuid::new_v4());
    sftp.write(temp.clone(), &bytes)
        .await
        .map_err(|error| format!("上传远程临时文件失败：{error}"))?;
    if let Err(error) = sftp.rename(temp.clone(), parsed.path.clone()).await {
        let _ = sftp.remove_file(temp).await;
        return Err(format!("替换远程文件失败：{error}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_check_symlink_write(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteSymlinkWriteCheck, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    let probe = if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        parsed.path
    } else {
        remote_parent_path(&parsed.path)?.to_string()
    };
    let canonical = sftp
        .canonicalize(probe)
        .await
        .map_err(|error| format!("无法解析远程符号链接目标：{error}"))?;
    if !remote_path_is_within(&canonical, &root.canonical_path) {
        return Err("远程路径通过符号链接跳出了项目根目录，已拒绝写入".to_string());
    }
    Ok(RemoteSymlinkWriteCheck {
        needs_confirm: false,
        resolved_path: Some(canonical),
    })
}

#[tauri::command]
pub async fn ssh_create_file(
    parent: String,
    name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let target_uri = join_remote_uri(&parent, &name);
    let (sftp, parsed, root) = manager.sftp_for_uri(&target_uri, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        return Err("同名文件或文件夹已存在".to_string());
    }
    sftp.write(parsed.path, &[])
        .await
        .map_err(|error| format!("创建远程文件失败：{error}"))?;
    Ok(target_uri)
}

#[tauri::command]
pub async fn ssh_create_directory(
    parent: String,
    name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let target_uri = join_remote_uri(&parent, &name);
    let (sftp, parsed, root) = manager.sftp_for_uri(&target_uri, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    sftp.create_dir(parsed.path)
        .await
        .map_err(|error| format!("创建远程文件夹失败：{error}"))?;
    Ok(target_uri)
}

#[tauri::command]
pub async fn ssh_rename_path(
    path: String,
    new_name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&new_name)?;
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    let uri_parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .ok_or_else(|| "远程路径缺少父目录".to_string())?;
    let new_uri = join_remote_uri(uri_parent, &new_name);
    let new_path = format!(
        "{}/{}",
        remote_parent_path(&parsed.path)?.trim_end_matches('/'),
        new_name
    );
    sftp.rename(parsed.path, new_path)
        .await
        .map_err(|error| format!("重命名远程路径失败：{error}"))?;
    Ok(new_uri)
}

async fn remove_remote_tree(sftp: &SftpSession, path: String) -> Result<(), String> {
    let metadata = sftp
        .symlink_metadata(path.clone())
        .await
        .map_err(|error| format!("读取远程路径失败：{error}"))?;
    if metadata.is_dir() && !metadata.is_symlink() {
        let entries = sftp
            .read_dir(path.clone())
            .await
            .map_err(|error| format!("读取远程目录失败：{error}"))?;
        for entry in entries {
            Box::pin(remove_remote_tree(sftp, entry.path())).await?;
        }
        sftp.remove_dir(path)
            .await
            .map_err(|error| format!("删除远程目录失败：{error}"))
    } else {
        sftp.remove_file(path)
            .await
            .map_err(|error| format!("删除远程文件失败：{error}"))
    }
}

#[tauri::command]
pub async fn ssh_delete_path(path: String, manager: State<'_, SshManager>) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    if normalize_remote_uri(&path) == root.uri {
        return Err("不允许删除远程项目根目录".to_string());
    }
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    remove_remote_tree(&sftp, parsed.path).await
}

async fn upload_local_tree(
    sftp: &SftpSession,
    local_path: PathBuf,
    remote_path: String,
    root: &RegisteredRoot,
) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(&local_path)
        .map_err(|error| format!("读取本地上传路径失败：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("暂不上传本地符号链接：{}", local_path.display()));
    }
    ensure_parent_path_within(sftp, &remote_path, root).await?;
    if sftp.try_exists(remote_path.clone()).await.unwrap_or(false) {
        ensure_existing_path_within(sftp, &remote_path, root).await?;
    }
    if metadata.is_dir() {
        if !sftp.try_exists(remote_path.clone()).await.unwrap_or(false) {
            sftp.create_dir(remote_path.clone())
                .await
                .map_err(|error| format!("创建远程上传目录失败：{error}"))?;
        }
        for entry in std::fs::read_dir(&local_path)
            .map_err(|error| format!("读取本地上传目录失败：{error}"))?
        {
            let entry = entry.map_err(|error| format!("读取本地上传条目失败：{error}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            validate_entry_name(&name)?;
            Box::pin(upload_local_tree(
                sftp,
                entry.path(),
                format!("{}/{name}", remote_path.trim_end_matches('/')),
                root,
            ))
            .await?;
        }
        return Ok(());
    }
    if metadata.len() > MAX_EDITOR_FILE_SIZE {
        return Err(format!(
            "单个上传文件暂不能超过 100MB：{}",
            local_path.display()
        ));
    }
    let bytes =
        std::fs::read(&local_path).map_err(|error| format!("读取本地上传文件失败：{error}"))?;
    sftp.write(remote_path, &bytes)
        .await
        .map_err(|error| format!("上传远程文件失败：{error}"))
}

#[tauri::command]
pub async fn ssh_upload_paths(
    destination: String,
    local_paths: Vec<String>,
    manager: State<'_, SshManager>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    if local_paths.is_empty() {
        return Ok(());
    }
    let (sftp, parsed, root) = manager.sftp_for_uri(&destination, true).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let destination_metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程上传目录失败：{error}"))?;
    if !destination_metadata.is_dir() {
        return Err("请选择远程目录作为上传目标".to_string());
    }
    for local_path in local_paths {
        allowlist.ensure_allowed(&local_path)?;
        let path = PathBuf::from(&local_path);
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "本地上传路径缺少有效名称".to_string())?;
        validate_entry_name(name)?;
        let remote_path = format!("{}/{name}", parsed.path.trim_end_matches('/'));
        upload_local_tree(&sftp, path, remote_path, &root).await?;
    }
    Ok(())
}

async fn download_remote_tree(
    sftp: &SftpSession,
    remote_path: String,
    local_path: PathBuf,
    root: &RegisteredRoot,
    allowlist: &PathAllowlist,
) -> Result<(), String> {
    ensure_existing_path_within(sftp, &remote_path, root).await?;
    allowlist.ensure_writable(&local_path.to_string_lossy())?;
    let metadata = sftp
        .symlink_metadata(remote_path.clone())
        .await
        .map_err(|error| format!("读取远程下载路径失败：{error}"))?;
    if metadata.is_symlink() {
        return Err(format!("暂不下载远程符号链接：{remote_path}"));
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(&local_path)
            .map_err(|error| format!("创建本地下载目录失败：{error}"))?;
        let entries = sftp
            .read_dir(remote_path.clone())
            .await
            .map_err(|error| format!("读取远程下载目录失败：{error}"))?;
        for entry in entries {
            let name = entry.file_name();
            validate_entry_name(&name)?;
            Box::pin(download_remote_tree(
                sftp,
                entry.path(),
                local_path.join(name),
                root,
                allowlist,
            ))
            .await?;
        }
        return Ok(());
    }
    if metadata.len() > MAX_EDITOR_FILE_SIZE {
        return Err(format!("单个下载文件暂不能超过 100MB：{remote_path}"));
    }
    let bytes = sftp
        .read(remote_path)
        .await
        .map_err(|error| format!("读取远程下载文件失败：{error}"))?;
    if let Some(parent) = local_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建本地下载目录失败：{error}"))?;
    }
    std::fs::write(&local_path, bytes).map_err(|error| format!("写入本地下载文件失败：{error}"))
}

#[tauri::command]
pub async fn ssh_download_paths(
    paths: Vec<String>,
    destination: String,
    manager: State<'_, SshManager>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    allowlist.ensure_writable(&destination)?;
    let destination = PathBuf::from(destination);
    for uri in paths {
        let (sftp, parsed, root) = manager.sftp_for_uri(&uri, false).await?;
        let name = Path::new(&parsed.path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "远程下载路径缺少有效名称".to_string())?
            .to_string();
        validate_entry_name(&name)?;
        download_remote_tree(
            &sftp,
            parsed.path,
            destination.join(name),
            &root,
            &allowlist,
        )
        .await?;
    }
    Ok(())
}

fn fuzzy_contains(value: &str, query: &str) -> bool {
    let mut chars = query.chars();
    let mut wanted = chars.next();
    for ch in value.chars() {
        if Some(ch) == wanted {
            wanted = chars.next();
            if wanted.is_none() {
                return true;
            }
        }
    }
    wanted.is_none()
}

fn remote_relative_path(root_path: &str, full_path: &str) -> String {
    full_path
        .strip_prefix(root_path.trim_end_matches('/'))
        .unwrap_or(full_path)
        .trim_start_matches('/')
        .trim_start_matches("./")
        .to_string()
}

fn simple_glob_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.trim_start_matches("./").trim_start_matches('/');
    if pattern.is_empty() {
        return false;
    }
    let anchored = pattern.contains('/');
    let candidate = if anchored {
        value
    } else {
        value.rsplit('/').next().unwrap_or(value)
    };
    let pattern = pattern.replace("**", "*");
    let mut remaining = candidate;
    let mut first = true;
    for part in pattern.split('*') {
        if part.is_empty() {
            continue;
        }
        let Some(index) = remaining.find(part) else {
            return false;
        };
        if first && !pattern.starts_with('*') && index != 0 {
            return false;
        }
        remaining = &remaining[index + part.len()..];
        first = false;
    }
    pattern.ends_with('*') || remaining.is_empty()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_search_files(
    root: String,
    query: String,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
    extension: Option<String>,
    extensions: Option<Vec<String>>,
    limit: Option<usize>,
    exclude_patterns: Option<Vec<String>>,
    use_ignore_files: Option<bool>,
    follow_symlinks: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteSearchHit>, String> {
    // Never follow remote symlinks: command output cannot be canonicalized cheaply,
    // and a symlink may otherwise expose files outside the registered project.
    let _ = (use_ignore_files, follow_symlinks);
    let parsed = parse_remote_uri(&root)?;
    let max = limit.unwrap_or(500).clamp(1, 2_000);
    let marker = "__QINGCODE_REMOTE_FILES__";
    let command = format!(
        "{{ find {} \\( -name .git -o -name node_modules -o -name target \\) -prune -o -type d -print; printf '\\n{}\\n'; find {} \\( -name .git -o -name node_modules -o -name target \\) -prune -o -type f -print; }} | head -n {}",
        shell_quote(&parsed.path),
        marker,
        shell_quote(&parsed.path),
        max.saturating_mul(40).min(50_000)
    );
    let output = manager.exec_uri(&root, &command, false).await?;
    if output.exit_code != 0 {
        return Err(format!("远程文件搜索失败：{}", output.stderr.trim()));
    }
    let extension_list = extensions
        .or_else(|| extension.map(|value| vec![value]))
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim_start_matches('.').to_ascii_lowercase())
        .collect::<Vec<_>>();
    let query = if ignore_case {
        query.to_lowercase()
    } else {
        query
    };
    let exclude_patterns = exclude_patterns.unwrap_or_default();
    let mut hits = Vec::new();
    let mut is_dir = true;
    for raw_line in output.stdout.lines() {
        if raw_line == marker {
            is_dir = false;
            continue;
        }
        let full_path = raw_line;
        let relative = remote_relative_path(&parsed.path, full_path);
        let name = relative.rsplit('/').next().unwrap_or(&relative).to_string();
        if name.is_empty() {
            continue;
        }
        if exclude_patterns
            .iter()
            .any(|pattern| simple_glob_matches(pattern, &relative))
        {
            continue;
        }
        if !extension_list.is_empty() {
            let ext = name
                .rsplit_once('.')
                .map(|(_, ext)| ext.to_ascii_lowercase());
            if !ext.is_some_and(|ext| extension_list.contains(&ext)) {
                continue;
            }
        }
        let candidate = if ignore_case {
            relative.to_lowercase()
        } else {
            relative.clone()
        };
        let matched = if query.is_empty() {
            !extension_list.is_empty()
        } else if match_suffix {
            candidate.ends_with(query.trim_start_matches('.'))
                || candidate.ends_with(&format!(".{}", query.trim_start_matches('.')))
        } else if fuzzy {
            fuzzy_contains(&candidate, &query)
        } else {
            candidate.contains(&query)
        };
        if !matched {
            continue;
        }
        hits.push(RemoteSearchHit {
            name,
            path: join_remote_uri(&root, &relative),
            relative,
            is_dir,
        });
        if hits.len() >= max {
            break;
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn ssh_list_file_extensions(
    roots: Vec<String>,
    max_files: Option<usize>,
    manager: State<'_, SshManager>,
) -> Result<Vec<String>, String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let max = max_files.unwrap_or(8_000).clamp(100, 50_000);
    for root in roots {
        if !root.starts_with(SSH_URI_PREFIX) {
            continue;
        }
        let parsed = parse_remote_uri(&root)?;
        let command = format!(
            "find {} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/target/*' -print | head -n {max}",
            shell_quote(&parsed.path)
        );
        let output = manager.exec_uri(&root, &command, false).await?;
        for path in output.stdout.lines() {
            if let Some((_, extension)) = path.rsplit_once('.') {
                let extension = extension.to_ascii_lowercase();
                if !extension.contains('/') && extension.len() <= 16 {
                    *counts.entry(extension).or_default() += 1;
                }
            }
        }
    }
    let mut extensions = counts.into_iter().collect::<Vec<_>>();
    extensions.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(extensions
        .into_iter()
        .map(|(extension, _)| extension)
        .take(80)
        .collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_search_file_contents(
    root: String,
    query: String,
    ignore_case: bool,
    extension: Option<String>,
    extensions: Option<Vec<String>>,
    max_matches: Option<usize>,
    max_files_scanned: Option<usize>,
    max_matches_per_file: Option<usize>,
    search_id: Option<u64>,
    exclude_patterns: Option<Vec<String>>,
    use_ignore_files: Option<bool>,
    follow_symlinks: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<RemoteContentResponse, String> {
    let _ = (max_files_scanned, search_id);
    let parsed = parse_remote_uri(&root)?;
    let max = max_matches.unwrap_or(500).clamp(1, 2_000);
    let per_file = max_matches_per_file.unwrap_or(20).clamp(1, 200);
    let mut args = vec![
        "rg".to_string(),
        "--json".to_string(),
        "--line-number".to_string(),
        "--column".to_string(),
        "--color=never".to_string(),
        format!("--max-count={per_file}"),
    ];
    if ignore_case {
        args.push("--ignore-case".to_string());
    }
    if use_ignore_files == Some(false) {
        args.push("--no-ignore".to_string());
    }
    // Deliberately ignore this option for SSH roots to preserve the root sandbox.
    let _ = follow_symlinks;
    args.push("--fixed-strings".to_string());
    for extension in extensions
        .or_else(|| extension.map(|value| vec![value]))
        .unwrap_or_default()
    {
        args.push("-g".to_string());
        args.push(format!("*.{}", extension.trim_start_matches('.')));
    }
    for pattern in exclude_patterns.unwrap_or_default() {
        args.push("-g".to_string());
        args.push(format!("!{pattern}"));
    }
    args.push(query);
    args.push(".".to_string());
    let command = format!(
        "cd -- {} && {}",
        shell_quote(&parsed.path),
        args.iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let output = manager.exec_uri(&root, &command, false).await?;
    if !matches!(output.exit_code, 0 | 1) {
        return Err(
            if output.stderr.contains("rg: not found")
                || output.stderr.contains("rg: command not found")
            {
                "远端未安装 ripgrep（rg），无法执行内容搜索".to_string()
            } else {
                format!("远程内容搜索失败：{}", output.stderr.trim())
            },
        );
    }
    let mut files: Vec<RemoteContentFile> = Vec::new();
    let mut match_count = 0usize;
    for line in output.stdout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|kind| kind.as_str()) != Some("match") {
            continue;
        }
        let Some(data) = value.get("data") else {
            continue;
        };
        let Some(relative) = data
            .get("path")
            .and_then(|path| path.get("text"))
            .and_then(|text| text.as_str())
            .map(|path| path.trim_start_matches("./").to_string())
        else {
            continue;
        };
        let text = data
            .get("lines")
            .and_then(|lines| lines.get("text"))
            .and_then(|text| text.as_str())
            .unwrap_or_default()
            .trim_end_matches(['\r', '\n'])
            .to_string();
        let line_number = data
            .get("line_number")
            .and_then(|line| line.as_u64())
            .unwrap_or(1) as u32;
        let submatch = data
            .get("submatches")
            .and_then(|items| items.as_array())
            .and_then(|items| items.first());
        let match_start = submatch
            .and_then(|item| item.get("start"))
            .and_then(|start| start.as_u64())
            .unwrap_or(0) as u32;
        let match_end = submatch
            .and_then(|item| item.get("end"))
            .and_then(|end| end.as_u64())
            .unwrap_or(u64::from(match_start)) as u32;
        let path = join_remote_uri(&root, &relative);
        let name = relative.rsplit('/').next().unwrap_or(&relative).to_string();
        let item = RemoteContentMatch {
            line: line_number,
            text,
            match_start,
            match_end,
        };
        if let Some(file) = files.iter_mut().find(|file| file.relative == relative) {
            file.matches.push(item);
        } else {
            files.push(RemoteContentFile {
                name,
                path,
                relative,
                matches: vec![item],
            });
        }
        match_count += 1;
        if match_count >= max {
            break;
        }
    }
    Ok(RemoteContentResponse {
        files_scanned: files.len(),
        files,
        match_count,
        truncated: match_count >= max,
        cancelled: false,
    })
}

fn parse_git_branch_header(header: &str) -> (Option<String>, Option<String>, u32, u32) {
    let value = header.trim_start_matches("## ");
    if value.starts_with("No commits yet on ") {
        return (
            Some(value.trim_start_matches("No commits yet on ").to_string()),
            None,
            0,
            0,
        );
    }
    if value.starts_with("HEAD (no branch)") {
        return (Some("HEAD".to_string()), None, 0, 0);
    }
    let (head_part, counts) = value.split_once(" [").unwrap_or((value, ""));
    let (branch, upstream) = head_part
        .split_once("...")
        .map_or((head_part, None), |(branch, upstream)| {
            (branch, Some(upstream.to_string()))
        });
    let mut ahead = 0;
    let mut behind = 0;
    for item in counts.trim_end_matches(']').split(',') {
        let item = item.trim();
        if let Some(value) = item.strip_prefix("ahead ") {
            ahead = value.parse().unwrap_or(0);
        }
        if let Some(value) = item.strip_prefix("behind ") {
            behind = value.parse().unwrap_or(0);
        }
    }
    (Some(branch.to_string()), upstream, ahead, behind)
}

#[tauri::command]
pub async fn ssh_git_status(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitStatus, String> {
    let parsed = parse_remote_uri(&path)?;
    let command = format!(
        "git -C {} status --porcelain=v1 --branch -z --untracked-files=all --ignore-submodules=dirty",
        shell_quote(&parsed.path)
    );
    let output = manager.exec_uri(&path, &command, false).await?;
    if output.exit_code != 0 {
        if output
            .stderr
            .to_ascii_lowercase()
            .contains("not a git repository")
        {
            return Ok(RemoteGitStatus {
                is_repository: false,
                branch: None,
                upstream: None,
                behind: 0,
                ahead: 0,
                last_fetch_at: None,
                last_pull_at: None,
                last_push_at: None,
                changes: Vec::new(),
            });
        }
        return Err(format!("读取远程 Git 状态失败：{}", output.stderr.trim()));
    }
    let records = output.stdout.split('\0').collect::<Vec<_>>();
    let mut index = 0usize;
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut changes = Vec::new();
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.starts_with("## ") {
            (branch, upstream, ahead, behind) = parse_git_branch_header(record);
            continue;
        }
        if record.len() < 4 {
            continue;
        }
        let status = record[..2].to_string();
        let relative = record[3..].to_string();
        if status.contains('R') || status.contains('C') {
            index += 1;
        }
        changes.push(RemoteGitChange {
            path: relative,
            status,
        });
    }
    Ok(RemoteGitStatus {
        is_repository: true,
        branch,
        upstream,
        behind,
        ahead,
        last_fetch_at: None,
        last_pull_at: None,
        last_push_at: None,
        changes,
    })
}

fn remote_git_file(root_uri: &str, value: &str) -> Result<String, String> {
    let relative = if value.starts_with(SSH_URI_PREFIX) {
        let root = parse_remote_uri(root_uri)?;
        let file = parse_remote_uri(value)?;
        if root.connection_id != file.connection_id
            || !remote_path_is_within(&file.path, &root.path)
        {
            return Err("仅允许操作当前 SSH 项目内的 Git 文件".to_string());
        }
        remote_relative_path(&root.path, &file.path)
    } else {
        value.replace('\\', "/")
    };
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.split('/').any(|part| part == "..")
    {
        return Err("仅允许操作当前 SSH 项目内的 Git 文件".to_string());
    }
    Ok(relative)
}

async fn remote_git_command(
    manager: &SshManager,
    path: &str,
    args: Vec<String>,
    require_trust: bool,
) -> Result<RemoteExecResult, String> {
    let parsed = parse_remote_uri(path)?;
    let command = format!(
        "git -C {} {}",
        shell_quote(&parsed.path),
        args.iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    manager.exec_uri(path, &command, require_trust).await
}

#[tauri::command]
pub async fn ssh_git_stage(
    path: String,
    files: Vec<String>,
    all: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let mut args = vec!["add".to_string()];
    if all.unwrap_or(false) || files.is_empty() {
        args.push("--all".to_string());
    } else {
        args.push("--".to_string());
        for file in files {
            args.push(remote_git_file(&path, &file)?);
        }
    }
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(output.stderr)
    }
}

#[tauri::command]
pub async fn ssh_git_unstage(
    path: String,
    files: Vec<String>,
    all: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let mut args = vec!["reset".to_string(), "HEAD".to_string()];
    if !all.unwrap_or(false) && !files.is_empty() {
        args.push("--".to_string());
        for file in files {
            args.push(remote_git_file(&path, &file)?);
        }
    }
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(output.stderr)
    }
}

#[tauri::command]
pub async fn ssh_git_commit(
    path: String,
    message: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    let output = remote_git_command(
        &manager,
        &path,
        vec!["commit".to_string(), "-m".to_string(), message],
        true,
    )
    .await?;
    if output.exit_code == 0 {
        Ok(output.stdout.trim().to_string())
    } else {
        Err(output.stderr)
    }
}

async fn remote_git_simple(
    manager: &SshManager,
    path: &str,
    args: Vec<String>,
) -> Result<String, String> {
    let output = remote_git_command(manager, path, args, true).await?;
    if output.exit_code == 0 {
        let summary = if output.stdout.trim().is_empty() {
            output.stderr.trim()
        } else {
            output.stdout.trim()
        };
        Ok(summary.to_string())
    } else {
        Err(output.stderr.trim().to_string())
    }
}

#[tauri::command]
pub async fn ssh_git_push(path: String, manager: State<'_, SshManager>) -> Result<String, String> {
    remote_git_simple(&manager, &path, vec!["push".to_string()]).await
}

#[tauri::command]
pub async fn ssh_git_fetch(path: String, manager: State<'_, SshManager>) -> Result<String, String> {
    remote_git_simple(&manager, &path, vec!["fetch".to_string()]).await
}

#[tauri::command]
pub async fn ssh_git_pull(
    path: String,
    rebase: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitPullResult, String> {
    let mut args = vec!["pull".to_string()];
    if rebase.unwrap_or(false) {
        args.push("--rebase".to_string());
    }
    let summary = remote_git_simple(&manager, &path, args).await?;
    let status = ssh_git_status(path.clone(), manager).await?;
    let conflict_paths = status
        .changes
        .iter()
        .filter(|change| {
            matches!(
                change.status.as_str(),
                "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD"
            )
        })
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    Ok(RemoteGitPullResult {
        summary,
        has_conflicts: !conflict_paths.is_empty(),
        conflict_paths,
    })
}

fn validate_commit_rev(rev: &str) -> Result<&str, String> {
    let rev = rev.trim();
    if rev.is_empty() || rev.len() > 64 || !rev.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("无效的提交哈希".to_string());
    }
    Ok(rev)
}

fn validate_branch_name(branch: &str) -> Result<&str, String> {
    let branch = branch.trim();
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.starts_with("refs/")
        || branch.starts_with("remotes/")
        || branch.contains("..")
        || branch.contains(['\\', '\0', ' '])
    {
        return Err("无效的分支名".to_string());
    }
    Ok(branch)
}

#[tauri::command]
pub async fn ssh_git_log(
    path: String,
    limit: Option<u32>,
    skip: Option<u32>,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitCommitInfo>, String> {
    let limit = limit.unwrap_or(40).clamp(1, 100) as usize;
    let skip = skip.unwrap_or(0).min(100_000) as usize;
    let fetch = limit.saturating_add(skip).min(100_000);
    let output = remote_git_command(
        &manager,
        &path,
        vec![
            "log".to_string(),
            format!("-n{fetch}"),
            "--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%D".to_string(),
        ],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        let error = output.stderr.to_ascii_lowercase();
        if error.contains("does not have any commits")
            || error.contains("bad revision")
            || error.contains("unknown revision")
            || error.contains("尚无任何提交")
        {
            return Ok(Vec::new());
        }
        return Err(format!("读取远程提交记录失败：{}", output.stderr.trim()));
    }
    let commits = output
        .stdout
        .lines()
        .filter_map(|line| {
            let parts = line.split('\0').collect::<Vec<_>>();
            (parts.len() >= 5).then(|| RemoteGitCommitInfo {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                subject: parts[2].to_string(),
                author: parts[3].to_string(),
                date: parts[4].trim().to_string(),
                refs: parts.get(5).map_or("", |value| value.trim()).to_string(),
            })
        })
        .skip(skip)
        .take(limit)
        .collect();
    Ok(commits)
}

#[tauri::command]
pub async fn ssh_git_branch_list(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitBranchList, String> {
    let local_output = remote_git_command(
        &manager,
        &path,
        vec![
            "for-each-ref".to_string(),
            "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)".to_string(),
            "refs/heads".to_string(),
        ],
        false,
    )
    .await?;
    if local_output.exit_code != 0 {
        return Err(format!("读取远程分支失败：{}", local_output.stderr.trim()));
    }
    let local = local_output
        .stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let current = parts.next().unwrap_or_default() == "*";
            let upstream = parts.next().unwrap_or_default().trim();
            Some(RemoteGitBranchInfo {
                name: name.to_string(),
                current,
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            })
        })
        .collect();
    let remote_output = remote_git_command(
        &manager,
        &path,
        vec![
            "for-each-ref".to_string(),
            "--format=%(refname:short)".to_string(),
            "refs/remotes".to_string(),
        ],
        false,
    )
    .await?;
    let remote = remote_output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.ends_with("/HEAD"))
        .map(str::to_string)
        .collect();
    Ok(RemoteGitBranchList { local, remote })
}

#[tauri::command]
pub async fn ssh_git_remotes(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitRemote>, String> {
    let output = remote_git_command(
        &manager,
        &path,
        vec!["remote".to_string(), "-v".to_string()],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(format!("读取远程地址失败：{}", output.stderr.trim()));
    }
    let mut order = Vec::new();
    let mut remotes: HashMap<String, RemoteGitRemote> = HashMap::new();
    for line in output.stdout.lines() {
        let Some((name, rest)) = line.trim().split_once(['\t', ' ']) else {
            continue;
        };
        let rest = rest.trim();
        let (url, kind) = rest.rfind(" (").map_or((rest, ""), |index| {
            (rest[..index].trim(), rest[index..].trim())
        });
        if name.is_empty() || url.is_empty() {
            continue;
        }
        if !remotes.contains_key(name) {
            order.push(name.to_string());
            remotes.insert(
                name.to_string(),
                RemoteGitRemote {
                    name: name.to_string(),
                    fetch_url: None,
                    push_urls: Vec::new(),
                },
            );
        }
        let remote = remotes.get_mut(name).expect("remote inserted");
        if kind.contains("fetch") {
            remote.fetch_url = Some(url.to_string());
        } else if kind.contains("push") && !remote.push_urls.iter().any(|item| item == url) {
            remote.push_urls.push(url.to_string());
        }
    }
    Ok(order
        .into_iter()
        .filter_map(|name| remotes.remove(&name))
        .collect())
}

#[tauri::command]
pub async fn ssh_git_switch(
    path: String,
    branch: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let branch = validate_branch_name(&branch)?.to_string();
    let remote_ref = format!("refs/remotes/{branch}");
    let local_ref = format!("refs/heads/{branch}");
    let remote = remote_git_command(
        &manager,
        &path,
        vec!["rev-parse".to_string(), "--verify".to_string(), remote_ref],
        true,
    )
    .await?;
    let local = remote_git_command(
        &manager,
        &path,
        vec!["rev-parse".to_string(), "--verify".to_string(), local_ref],
        true,
    )
    .await?;
    let args = if remote.exit_code == 0 && local.exit_code != 0 {
        vec!["switch".to_string(), "--track".to_string(), branch]
    } else {
        vec!["switch".to_string(), branch]
    };
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(format!("切换远程 Git 分支失败：{}", output.stderr.trim()))
    }
}

#[tauri::command]
pub async fn ssh_git_commit_files(
    path: String,
    rev: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitCommitFileChange>, String> {
    let rev = validate_commit_rev(&rev)?.to_string();
    let output = remote_git_command(
        &manager,
        &path,
        vec![
            "show".to_string(),
            "--name-status".to_string(),
            "--pretty=format:".to_string(),
            "--no-renames".to_string(),
            rev,
        ],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(format!("读取提交文件失败：{}", output.stderr.trim()));
    }
    Ok(output
        .stdout
        .lines()
        .filter_map(|line| {
            let (status, file) = line.split_once('\t')?;
            let status = status.chars().next()?.to_string();
            (!file.trim().is_empty()).then(|| RemoteGitCommitFileChange {
                status,
                path: file.trim().to_string(),
                previous_path: None,
            })
        })
        .collect())
}

async fn remote_git_show(
    manager: &SshManager,
    path: &str,
    revision: &str,
    file: &str,
) -> Result<String, String> {
    let spec = format!("{revision}:{file}");
    let output = remote_git_command(
        manager,
        path,
        vec!["show".to_string(), "--textconv".to_string(), spec],
        false,
    )
    .await?;
    Ok(if output.exit_code == 0 {
        output.stdout
    } else {
        String::new()
    })
}

#[tauri::command]
pub async fn ssh_git_commit_file_contents(
    path: String,
    rev: String,
    file: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitFileContents, String> {
    let rev = validate_commit_rev(&rev)?.to_string();
    let file = remote_git_file(&path, &file)?;
    Ok(RemoteGitFileContents {
        original: remote_git_show(&manager, &path, &format!("{rev}^"), &file).await?,
        modified: remote_git_show(&manager, &path, &rev, &file).await?,
    })
}

#[tauri::command]
pub async fn ssh_git_file_contents(
    path: String,
    file: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitFileContents, String> {
    let file = remote_git_file(&path, &file)?;
    let file_uri = join_remote_uri(&path, &file);
    let modified = match manager.sftp_for_uri(&file_uri, false).await {
        Ok((sftp, parsed, root)) => {
            ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
            let metadata = sftp.metadata(parsed.path.clone()).await.ok();
            if metadata
                .as_ref()
                .is_some_and(|value| value.len() > MAX_DIFF_BYTES)
            {
                format!("… 文件过大，已跳过内容（最多 {MAX_DIFF_BYTES} bytes）\n")
            } else {
                match sftp.read(parsed.path).await {
                    Ok(bytes) => file_encoding::decode(&bytes, file_encoding::FileEncoding::Auto)
                        .unwrap_or_default(),
                    Err(_) => String::new(),
                }
            }
        }
        Err(_) => String::new(),
    };
    Ok(RemoteGitFileContents {
        original: remote_git_show(&manager, &path, "HEAD", &file).await?,
        modified,
    })
}

#[tauri::command]
pub async fn ssh_git_show_head_file(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Option<String>, String> {
    let root = manager.root_for_uri(&path, false)?;
    let file = remote_git_file(&root.uri, &path)?;
    let content = remote_git_show(&manager, &root.uri, "HEAD", &file).await?;
    Ok((!content.is_empty()).then_some(content))
}

#[tauri::command]
pub async fn ssh_git_discard(
    path: String,
    files: Vec<String>,
    staged: bool,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    for file in files {
        let file = remote_git_file(&path, &file)?;
        let status_output = remote_git_command(
            &manager,
            &path,
            vec![
                "status".to_string(),
                "--porcelain=v1".to_string(),
                "--".to_string(),
                file.clone(),
            ],
            true,
        )
        .await?;
        let status = status_output.stdout.get(..2).unwrap_or_default();
        let args = if status == "??" {
            vec![
                "clean".to_string(),
                "-f".to_string(),
                "--".to_string(),
                file,
            ]
        } else if staged && status.starts_with('A') {
            let unstage = remote_git_command(
                &manager,
                &path,
                vec![
                    "rm".to_string(),
                    "-f".to_string(),
                    "--cached".to_string(),
                    "--".to_string(),
                    file.clone(),
                ],
                true,
            )
            .await?;
            if unstage.exit_code != 0 {
                return Err(format!("丢弃远程 Git 更改失败：{}", unstage.stderr.trim()));
            }
            vec![
                "clean".to_string(),
                "-f".to_string(),
                "--".to_string(),
                file,
            ]
        } else if staged {
            vec![
                "restore".to_string(),
                "--source=HEAD".to_string(),
                "--staged".to_string(),
                "--worktree".to_string(),
                "--".to_string(),
                file,
            ]
        } else {
            vec![
                "restore".to_string(),
                "--worktree".to_string(),
                "--".to_string(),
                file,
            ]
        };
        let output = remote_git_command(&manager, &path, args, true).await?;
        if output.exit_code != 0 {
            return Err(format!("丢弃远程 Git 更改失败：{}", output.stderr.trim()));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_format_document(
    path: String,
    content: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let parsed = parse_remote_uri(&path)?;
    let root = manager.root_for_uri(&path, true)?;
    let extension = parsed
        .path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    let prettier = format!(
        "cd -- {} && if [ -x node_modules/.bin/prettier ]; then exec node_modules/.bin/prettier --stdin-filepath {}; elif command -v prettier >/dev/null 2>&1; then exec prettier --stdin-filepath {}; else echo '未找到 prettier（项目 node_modules 或远端 PATH）' >&2; exit 127; fi",
        shell_quote(&root.canonical_path),
        shell_quote(&parsed.path),
        shell_quote(&parsed.path)
    );
    let command = match extension.as_str() {
        "js" | "jsx" | "ts" | "tsx" | "json" | "json5" | "css" | "scss" | "less"
        | "html" | "vue" | "svelte" | "md" | "yaml" | "yml" => prettier,
        "rs" => "command -v rustfmt >/dev/null 2>&1 && exec rustfmt --emit stdout || { echo '远端未安装 rustfmt' >&2; exit 127; }".to_string(),
        "go" => "command -v gofmt >/dev/null 2>&1 && exec gofmt || { echo '远端未安装 gofmt' >&2; exit 127; }".to_string(),
        "sh" | "bash" | "zsh" => "command -v shfmt >/dev/null 2>&1 && exec shfmt || { echo '远端未安装 shfmt' >&2; exit 127; }".to_string(),
        "py" => format!(
            "if command -v ruff >/dev/null 2>&1; then exec ruff format --stdin-filename {} -; elif command -v black >/dev/null 2>&1; then exec black --quiet -; else echo '远端未安装 ruff 或 black' >&2; exit 127; fi",
            shell_quote(&parsed.path)
        ),
        _ => return Err(format!("暂不支持格式化 .{extension} 远程文件")),
    };
    let output = manager
        .exec_uri_with_input(&path, &command, content.as_bytes(), true)
        .await?;
    if output.exit_code == 0 {
        Ok(output.stdout)
    } else {
        Err(format!("远程格式化失败：{}", output.stderr.trim()))
    }
}

async fn spawn_ssh_terminal(
    id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    app: AppHandle,
    manager: &SshManager,
    command: String,
) -> Result<TerminalSpawnResult, String> {
    let parsed = parse_remote_uri(&cwd)?;
    manager.root_for_uri(&cwd, true)?;
    let session = manager.session(&parsed.connection_id)?;
    let channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|error| format!("打开 SSH 终端通道失败：{error}"))?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            u32::from(cols.unwrap_or(80)),
            u32::from(rows.unwrap_or(24)),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("申请远程 PTY 失败：{error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("启动远程 Shell 失败：{error}"))?;
    let (mut reader, writer) = channel.split();
    manager
        .terminals
        .write()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .insert(id.clone(), Arc::new(writer));

    let app_clone = app.clone();
    let terminal_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut exit_code = 0;
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let _ = app_clone.emit(
                        "terminal-data",
                        TerminalDataPayload {
                            id: terminal_id.clone(),
                            data: data.to_vec(),
                        },
                    );
                }
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status,
                _ => {}
            }
        }
        let _ = app_clone.emit(
            "terminal-exit",
            TerminalExitPayload {
                id: terminal_id,
                exit_code,
            },
        );
    });
    Ok(TerminalSpawnResult::default())
}

#[tauri::command]
pub async fn ssh_create_terminal(
    id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    let parsed = parse_remote_uri(&cwd)?;
    let command = format!(
        "cd -- {} && exec \"${{SHELL:-/bin/sh}}\" -l",
        shell_quote(&parsed.path)
    );
    spawn_ssh_terminal(id, cwd, cols, rows, app, &manager, command).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_spawn_script(
    id: String,
    cwd: String,
    shell_kind: String,
    target: String,
    env: HashMap<String, String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    app: AppHandle,
    manager: State<'_, SshManager>,
) -> Result<TerminalSpawnResult, String> {
    let _ = shell;
    if matches!(shell_kind.as_str(), "ps1" | "bat") {
        return Err("SSH Linux 项目暂不支持 PowerShell 或 BAT 任务".to_string());
    }
    let parsed = parse_remote_uri(&cwd)?;
    let target = if target.starts_with(SSH_URI_PREFIX) {
        parse_remote_uri(&target)?.path
    } else {
        target
    };
    let mut env_prefix = String::new();
    for (key, value) in env {
        if key.is_empty()
            || !key.bytes().enumerate().all(|(index, byte)| {
                byte == b'_'
                    || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
            })
        {
            return Err(format!("无效的远程任务环境变量名：{key}"));
        }
        env_prefix.push_str(&format!("{key}={} ", shell_quote(&value)));
    }
    let invocation = match shell_kind.as_str() {
        "sh" | "script" => format!("exec {env_prefix}/bin/sh {}", shell_quote(&target)),
        "interactive" => format!(
            "{env_prefix}/bin/sh -lc {}; exec \"${{SHELL:-/bin/sh}}\" -l",
            shell_quote(&target)
        ),
        _ => format!("exec {env_prefix}/bin/sh -lc {}", shell_quote(&target)),
    };
    let command = format!("cd -- {} && {invocation}", shell_quote(&parsed.path));
    spawn_ssh_terminal(id, cwd, cols, rows, app, &manager, command).await
}

#[tauri::command]
pub async fn ssh_write_terminal(
    id: String,
    data: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let writer = manager
        .terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "SSH 终端不存在".to_string())?;
    writer
        .data_bytes(data.into_bytes())
        .await
        .map_err(|error| format!("写入 SSH 终端失败：{error}"))
}

#[tauri::command]
pub async fn ssh_resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let writer = manager
        .terminals
        .read()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "SSH 终端不存在".to_string())?;
    writer
        .window_change(u32::from(cols), u32::from(rows), 0, 0)
        .await
        .map_err(|error| format!("调整 SSH 终端尺寸失败：{error}"))
}

#[tauri::command]
pub async fn ssh_kill_terminal(id: String, manager: State<'_, SshManager>) -> Result<(), String> {
    let writer = manager
        .terminals
        .write()
        .map_err(|_| "SSH 终端状态不可用".to_string())?
        .remove(&id);
    if let Some(writer) = writer {
        writer
            .close()
            .await
            .map_err(|error| format!("关闭 SSH 终端失败：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_uri_without_losing_case() {
        let uri = parse_remote_uri("ssh://abc/Home/User/Foo.ts").unwrap();
        assert_eq!(uri.connection_id, "abc");
        assert_eq!(uri.path, "/Home/User/Foo.ts");
    }

    #[test]
    fn rejects_parent_segments() {
        assert!(parse_remote_uri("ssh://abc/home/user/../secret").is_err());
    }

    #[test]
    fn remote_containment_has_path_boundary() {
        assert!(remote_uri_is_within(
            "ssh://abc/home/user/app/src",
            "ssh://abc/home/user/app"
        ));
        assert!(!remote_uri_is_within(
            "ssh://abc/home/user/application",
            "ssh://abc/home/user/app"
        ));
    }

    #[test]
    fn extracts_connection_id_from_root_uri() {
        assert_eq!(remote_uri_connection_id("ssh://abc"), Some("abc"));
        assert_eq!(remote_uri_connection_id("ssh://abc/"), Some("abc"));
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn simple_globs_cover_extensions_and_nested_directories() {
        assert!(simple_glob_matches("*.map", "dist/app.js.map"));
        assert!(simple_glob_matches(
            "**/node_modules/**",
            "packages/app/node_modules/lib/index.js"
        ));
        assert!(!simple_glob_matches("*.map", "src/app.ts"));
    }

    #[test]
    fn git_inputs_reject_command_like_values() {
        assert!(validate_commit_rev("abc123").is_ok());
        assert!(validate_commit_rev("HEAD; rm -rf /").is_err());
        assert!(validate_branch_name("feature/ssh").is_ok());
        assert!(validate_branch_name("--exec=evil").is_err());
        assert!(validate_branch_name("refs/heads/main").is_err());
    }
}
