//! 远端 URI / POSIX 路径解析与规范化，以及项目根边界、符号链接逃逸校验。

use super::*;

#[derive(Debug)]
pub(super) struct RemoteUri {
    pub(super) connection_id: String,
    pub(super) path: String,
}

pub(super) fn parse_remote_uri(uri: &str) -> Result<RemoteUri, String> {
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

pub(super) fn validate_remote_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("远程路径必须是绝对 POSIX 路径".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("远程路径不允许包含 ..".to_string());
    }
    Ok(())
}

pub(super) fn normalize_remote_path(path: &str) -> String {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

pub(super) fn normalize_remote_uri(uri: &str) -> String {
    uri.trim_end_matches('/').to_string()
}

pub(super) fn remote_uri_connection_id(uri: &str) -> Option<&str> {
    uri.strip_prefix(SSH_URI_PREFIX)?
        .split('/')
        .next()
        .filter(|value| !value.is_empty())
}

pub(super) fn remote_uri_is_within(uri: &str, root: &str) -> bool {
    let uri = normalize_remote_uri(uri);
    let root = normalize_remote_uri(root);
    uri == root || uri.starts_with(&format!("{root}/"))
}

pub(super) fn join_remote_uri(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}

pub(super) fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

pub(super) fn home_path_candidates(username: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if username == "root" {
        paths.push("/root".to_string());
    } else if !username.is_empty() {
        paths.push(format!("/home/{username}"));
        paths.push(format!("/C:/Users/{username}"));
    }
    paths.push("/root".to_string());
    paths.push("/".to_string());
    paths.dedup();
    paths
}

pub(super) async fn resolve_remote_home(sftp: &SftpSession, username: &str) -> String {
    if let Ok(path) = sftp.canonicalize(".".to_string()).await {
        let normalized = normalize_remote_path(&path);
        if normalized.starts_with('/') {
            return normalized;
        }
    }
    for candidate in home_path_candidates(username) {
        if sftp.try_exists(candidate.clone()).await.unwrap_or(false) {
            if let Ok(canonical) = sftp.canonicalize(candidate).await {
                return normalize_remote_path(&canonical);
            }
        }
    }
    "/".to_string()
}

pub(super) fn remote_parent_path(path: &str) -> Result<&str, String> {
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .ok_or_else(|| "远程路径缺少父目录".to_string())
}

pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn remote_path_is_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

/// Windows OpenSSH 的 REALPATH 只做词法归一，不解析 NTFS reparse point。
/// 必须从盘符根逐组件检查（包含项目根及其祖先），不能只检查最后一个文件。
pub(super) fn windows_sftp_guard_components(path: &str) -> Vec<String> {
    let Some(native) = windows_native_path(path) else {
        return Vec::new();
    };
    let posix = native.replace('\\', "/");
    let mut current = format!("/{}/", &posix[..2]);
    let mut components = vec![current.clone()];
    for component in posix[2..].split('/').filter(|part| !part.is_empty()) {
        if !current.ends_with('/') {
            current.push('/');
        }
        current.push_str(component);
        components.push(current.clone());
    }
    components
}

pub(super) async fn reject_windows_sftp_links(
    sftp: &SftpSession,
    path: &str,
) -> Result<(), String> {
    if sftp.direct.is_some() {
        // The native Agent enforces real-path boundaries before every request.
        return Ok(());
    }
    sftp.windows_guard.check(&sftp.transport, path).await
}

pub(super) async fn ensure_existing_path_within(
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
    reject_windows_sftp_links(sftp, &canonical).await?;
    Ok(canonical)
}

pub(super) async fn ensure_parent_path_within(
    sftp: &SftpSession,
    path: &str,
    root: &RegisteredRoot,
) -> Result<String, String> {
    ensure_existing_path_within(sftp, remote_parent_path(path)?, root).await
}
