//! 远端 server 的部署路径、二进制命名与状态文件解析（纯函数）。
//!
//! Windows 远端的「POSIX 风格注册路径 ↔ 原生路径」换算也在这里
//! （[`windows_host_path`]，server_status 的日志脚本同样复用）。

use super::*;
use qingcode_server::ServerStateFile;

pub(crate) fn server_dir_path(canonical_root: &str) -> String {
    let root = canonical_root.trim_end_matches('/');
    format!("{root}/.qingcode/server")
}

pub(crate) fn server_state_path(canonical_root: &str) -> String {
    format!("{}/server.json", server_dir_path(canonical_root))
}

/// 项目 serve 进程的日志文件：serve 不再静默到 /dev/null，启动失败
/// （端口占用、rc=3 退出等）都留痕在这里，`ssh_server_logs` 会拼接展示。
pub(crate) fn server_serve_log_path(canonical_root: &str) -> String {
    format!("{}/serve.log", server_dir_path(canonical_root))
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

pub(crate) fn server_binary_path(canonical_root: &str, arch: &str) -> String {
    format!(
        "{}/{}",
        server_dir_path(canonical_root),
        server_binary_file_name(false, arch)
    )
}

pub(crate) fn server_binary_remote_path(canonical_root: &str, windows: bool, arch: &str) -> String {
    format!(
        "{}/{}",
        server_dir_path(canonical_root),
        server_binary_file_name(windows, arch)
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
            server_dir_path("/srv/project"),
            "/srv/project/.qingcode/server"
        );
        assert_eq!(
            server_dir_path("/srv/project/"),
            "/srv/project/.qingcode/server"
        );
        assert_eq!(
            server_state_path("/srv/project"),
            "/srv/project/.qingcode/server/server.json"
        );
        assert_eq!(
            server_binary_path("/srv/project", "x86_64"),
            "/srv/project/.qingcode/server/qingcode-server-x86_64"
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
}
