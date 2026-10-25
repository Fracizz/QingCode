//! 远端 server 的部署路径、二进制命名与状态文件解析（纯函数）。
//!
//! Windows 远端的「POSIX 风格注册路径 ↔ 原生路径」换算也在这里
//! （[`windows_host_path`]，server_status 的日志脚本同样复用）。

use super::*;
use qingcode_server::{ServerStateFile, SERVER_VERSION};

/// 用户私有 server 根目录。Unix 对应 `$HOME/.qingcode/server`，Windows
/// 对应 `%USERPROFILE%\.qingcode\server`（SFTP 形态为 `/C:/Users/...`）。
pub(crate) fn user_server_root(home: &str) -> String {
    format!("{}/.qingcode/server", home.trim_end_matches('/'))
}

/// 当前版本的安装目录：`~/.qingcode/server/<version>`。
pub(crate) fn server_install_dir(home: &str, version: &str) -> String {
    format!("{}/{}", user_server_root(home), version)
}

/// 项目内旧版 serve 状态文件。迁移后它仍用于记录本项目的 serve 端点与
/// 日志，但绝不再指向可执行文件。
pub(crate) fn server_state_path(canonical_root: &str) -> String {
    format!("{}/server.json", project_server_dir_path(canonical_root))
}

/// 项目 serve 进程的日志文件。状态与日志是数据文件；二进制只允许放在
/// [`server_install_dir`]。
pub(crate) fn server_serve_log_path(canonical_root: &str) -> String {
    format!("{}/serve.log", project_server_dir_path(canonical_root))
}

/// 项目内 Server 状态目录。当前只承载 `server.json`、`serve.log` 和忽略规则，
/// 绝不能从这里执行二进制。
pub(crate) fn project_server_dir_path(canonical_root: &str) -> String {
    let root = canonical_root.trim_end_matches('/');
    format!("{root}/.qingcode/server")
}

/// 项目 Server 状态目录的忽略文件，避免 token 状态和日志进入版本库。
pub(crate) fn server_gitignore_path(canonical_root: &str) -> String {
    format!("{}/.gitignore", project_server_dir_path(canonical_root))
}

/// 改名 server 之前的旧版状态文件（`.qingcode/agent/agent.json`）。部署时
/// 发现它就按其中的 pid 尽力清掉旧 serve，避免旧进程永久占端口。
pub(crate) fn legacy_agent_state_path(canonical_root: &str) -> String {
    format!(
        "{}/.qingcode/agent/agent.json",
        canonical_root.trim_end_matches('/')
    )
}

pub(crate) fn server_binary_file_name(windows: bool, arch: &str) -> String {
    if windows {
        format!("qingcode-server-windows-{arch}.exe")
    } else {
        format!("qingcode-server-{arch}")
    }
}

/// 旧版二进制文件名（改名 server 之前发布）：离线目录/缓存里可能还是旧名字，读取兼容。
pub(crate) fn legacy_server_binary_file_name(windows: bool, arch: &str) -> String {
    if windows {
        format!("qingcode-agent-windows-{arch}.exe")
    } else {
        format!("qingcode-agent-{arch}")
    }
}

/// 旧版项目内二进制路径：仅用于删除，调用方不得执行。
pub(crate) fn legacy_project_server_binary_path(
    canonical_root: &str,
    windows: bool,
    arch: &str,
) -> String {
    format!(
        "{}/{}",
        project_server_dir_path(canonical_root),
        server_binary_file_name(windows, arch)
    )
}

/// 改名前的项目内二进制路径：仅用于删除，调用方不得执行。
pub(crate) fn legacy_project_agent_binary_path(
    canonical_root: &str,
    windows: bool,
    arch: &str,
) -> String {
    format!(
        "{}/{}",
        project_server_dir_path(canonical_root),
        legacy_server_binary_file_name(windows, arch)
    )
}

/// Windows 远端打印 `x86_64` 或 `aarch64`。不调用 `uname`，OpenSSH 默认 shell 不一定有它。
pub(crate) fn windows_server_arch_script() -> &'static str {
    r"$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') { 'aarch64' } elseif ($arch -eq 'AMD64') { 'x86_64' } else { $arch }"
}

fn windows_server_path_ok(path: &str) -> bool {
    !path.is_empty() && !path.contains('"') && !path.contains('\n') && !path.contains('\r')
}

/// 远端 POSIX 风格路径转 Windows 原生路径（server_status 的日志脚本也用）。
pub(crate) fn windows_host_path(remote_path: &str) -> Option<String> {
    windows_native_path(remote_path).filter(|path| windows_server_path_ok(path))
}

/// Windows 原生家目录转 SFTP 形态：`C:\Users\dev` → `/C:/Users/dev`。
/// UNC / 非盘符路径返回 `None`，避免把不确定的共享路径当成用户私有目录。
pub(crate) fn windows_remote_path(native_path: &str) -> Option<String> {
    let path = native_path.trim().trim_matches('"');
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let path = path.replace('\\', "/");
    let bytes = path.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'/' {
        return None;
    }
    Some(format!("/{path}"))
}

/// 判断两个远端项目根是否指同一目录。Windows 路径大小写不敏感，POSIX
/// 路径保留大小写。
pub(crate) fn remote_roots_equivalent(left: &str, right: &str, windows: bool) -> bool {
    if windows {
        match (windows_native_path(left), windows_native_path(right)) {
            (Some(left), Some(right)) => left
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(right.trim_end_matches('\\')),
            _ => left
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(right.trim_end_matches('\\')),
        }
    } else {
        left.trim_end_matches('/') == right.trim_end_matches('/')
    }
}

/// 发现决策：只有版本、项目根、本地可信摘要和远端摘要四项同时匹配时才
/// 复用已运行端点。`local_sha256 = None` 必须拒绝，不能仅凭 `server.json`
/// 的版本号执行或连接项目内文件。
pub(crate) fn can_reuse_discovered_server(
    state_version: &str,
    state_root: &str,
    canonical_root: &str,
    windows: bool,
    local_sha256: Option<&str>,
    remote_sha256_matches: bool,
) -> bool {
    state_version == SERVER_VERSION
        && remote_roots_equivalent(state_root, canonical_root, windows)
        && local_sha256.is_some_and(|sha| !sha.trim().is_empty())
        && remote_sha256_matches
}

pub(crate) fn parse_server_state(bytes: &[u8]) -> Result<ServerStateFile, String> {
    let state: ServerStateFile = serde_json::from_slice(bytes)
        .map_err(|error| format!("解析 server 状态文件失败：{error}"))?;
    if state.version.trim().is_empty() {
        return Err("server 状态文件缺少版本号".to_string());
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_paths_handle_trailing_slash_root() {
        assert_eq!(
            project_server_dir_path("/srv/project"),
            "/srv/project/.qingcode/server"
        );
        assert_eq!(
            project_server_dir_path("/srv/project/"),
            "/srv/project/.qingcode/server"
        );
        assert_eq!(
            server_state_path("/srv/project"),
            "/srv/project/.qingcode/server/server.json"
        );
        assert_eq!(
            server_gitignore_path("/srv/project/"),
            "/srv/project/.qingcode/server/.gitignore"
        );
        assert!(remote_path_is_within(
            &project_server_dir_path("/srv/project"),
            "/srv/project"
        ));
        assert!(!remote_path_is_within(
            &project_server_dir_path("/srv/project-evil"),
            "/srv/project"
        ));
        assert_eq!(
            format!(
                "{}/{}",
                server_install_dir("/home/dev", SERVER_VERSION),
                server_binary_file_name(false, "x86_64")
            ),
            format!("/home/dev/.qingcode/server/{SERVER_VERSION}/qingcode-server-x86_64")
        );
        assert_eq!(
            format!(
                "{}/{}",
                server_install_dir("/C:/Users/dev", SERVER_VERSION),
                server_binary_file_name(true, "aarch64")
            ),
            format!(
                "/C:/Users/dev/.qingcode/server/{SERVER_VERSION}/qingcode-server-windows-aarch64.exe"
            )
        );
        assert_eq!(
            legacy_project_server_binary_path("/srv/project", false, "x86_64"),
            "/srv/project/.qingcode/server/qingcode-server-x86_64"
        );
        assert_eq!(
            legacy_project_agent_binary_path("/srv/project", false, "x86_64"),
            "/srv/project/.qingcode/server/qingcode-agent-x86_64"
        );
    }

    #[test]
    fn server_state_parses_camel_case_and_rejects_missing_version() {
        let bytes = br#"{"version":"0.1.13-beta.3","port":45321,"pid":1234,"token":"abcdef","root":"/srv/app"}"#;
        let state = parse_server_state(bytes).unwrap();
        assert_eq!(state.port, 45321);
        assert_eq!(state.pid, 1234);
        assert_eq!(state.token, "abcdef");
        assert!(parse_server_state(br#"{"port":1,"pid":1,"token":"t","root":"/"}"#).is_err());
        assert!(parse_server_state(b"not json").is_err());
    }

    #[test]
    fn serve_log_path_lives_inside_server_dir() {
        assert_eq!(
            server_serve_log_path("/srv/project"),
            "/srv/project/.qingcode/server/serve.log"
        );
        assert_eq!(
            server_serve_log_path("/srv/project/"),
            "/srv/project/.qingcode/server/serve.log"
        );
        assert_eq!(
            legacy_agent_state_path("/srv/project"),
            "/srv/project/.qingcode/agent/agent.json"
        );
    }

    #[test]
    fn user_server_paths_are_versioned_and_outside_project_binary_dir() {
        assert_eq!(user_server_root("/home/dev/"), "/home/dev/.qingcode/server");
        assert_eq!(
            server_install_dir("/home/dev/", "0.1.13-beta.3"),
            "/home/dev/.qingcode/server/0.1.13-beta.3"
        );
        let installed = format!(
            "{}/{}",
            server_install_dir("/home/dev", SERVER_VERSION),
            server_binary_file_name(false, "x86_64")
        );
        assert!(installed.starts_with("/home/dev/.qingcode/server/"));
        assert!(!installed.contains("/.qingcode/server/.qingcode/server/"));
    }

    #[test]
    fn windows_home_paths_convert_to_sftp_shape_and_reject_unc() {
        assert_eq!(
            windows_remote_path(r"C:\Users\dev"),
            Some("/C:/Users/dev".to_string())
        );
        assert_eq!(
            windows_remote_path(r"\\?\D:\Profiles\dev"),
            Some("/D:/Profiles/dev".to_string())
        );
        assert_eq!(windows_remote_path(r"\\server\share\dev"), None);
        assert_eq!(windows_remote_path("relative"), None);
    }

    #[test]
    fn discovery_requires_version_root_and_trusted_checksum() {
        let sha = "a".repeat(64);
        assert!(can_reuse_discovered_server(
            SERVER_VERSION,
            "/srv/project/",
            "/srv/project",
            false,
            Some(&sha),
            true,
        ));
        // 没有本地可信摘要时，即使 server.json 版本一致也必须重新安装。
        assert!(!can_reuse_discovered_server(
            SERVER_VERSION,
            "/srv/project",
            "/srv/project",
            false,
            None,
            true,
        ));
        // 摘要不匹配、版本不匹配、状态文件 root 不属于本项目都拒绝复用。
        assert!(!can_reuse_discovered_server(
            SERVER_VERSION,
            "/srv/project",
            "/srv/project",
            false,
            Some(&sha),
            false,
        ));
        assert!(!can_reuse_discovered_server(
            "0.0.1",
            "/srv/project",
            "/srv/project",
            false,
            Some(&sha),
            true,
        ));
        assert!(!can_reuse_discovered_server(
            SERVER_VERSION,
            "/srv/other",
            "/srv/project",
            false,
            Some(&sha),
            true,
        ));
        assert!(can_reuse_discovered_server(
            SERVER_VERSION,
            "/D:/code/app/",
            "/D:/Code/App",
            true,
            Some(&sha),
            true,
        ));
    }
}
