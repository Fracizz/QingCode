//! Execution OS belongs to the workspace, not to the WebView/user agent.
use crate::path_guard::PathAllowlist;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEnvironment {
    pub os: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslPath {
    pub distro: String,
    pub path: String,
}

pub fn parse_wsl_path(value: &str) -> Option<WslPath> {
    let normalized = value.replace('\\', "/");
    let normalized = normalized.strip_prefix("//?/UNC/").unwrap_or(&normalized);
    let lower = normalized.to_ascii_lowercase();
    let rest = if lower.starts_with("wsl://") {
        &normalized[6..]
    } else {
        let unc = normalized.trim_start_matches('/');
        let (host, rest) = unc.split_once('/')?;
        if !host.eq_ignore_ascii_case("wsl$") && !host.eq_ignore_ascii_case("wsl.localhost") {
            return None;
        }
        rest
    };
    let (distro, path) = rest.split_once('/').unwrap_or((rest, ""));
    if distro.is_empty() || distro.starts_with('-') || distro.chars().any(char::is_control) {
        return None;
    }
    Some(WslPath {
        distro: distro.into(),
        path: format!("/{path}"),
    })
}

/// `wsl://` URI 不能直接交给 Windows 文件系统 API；统一转成 `\\wsl.localhost\` UNC。
pub fn to_host_path(value: &str) -> String {
    match parse_wsl_path(value) {
        Some(wsl) => wsl_unc(&wsl.distro, &wsl.path),
        None => value.to_string(),
    }
}

fn wsl_unc(distro: &str, linux_path: &str) -> String {
    format!(r"\\wsl.localhost\{distro}{}", linux_path.replace('/', "\\"))
}

/// 解析任务脚本在宿主上的路径：WSL 工作目录下的绝对/相对 Linux 路径都映射到 UNC。
pub fn resolve_task_target(cwd: &str, target: &str) -> String {
    if let Some(wsl) = parse_wsl_path(cwd) {
        if parse_wsl_path(target).is_some() {
            return to_host_path(target);
        }
        let linux = target.replace('\\', "/");
        let path = if linux.starts_with('/') {
            linux
        } else {
            format!("{}/{linux}", wsl.path.trim_end_matches('/'))
        };
        return wsl_unc(&wsl.distro, &path);
    }
    let path = std::path::Path::new(target);
    if path.is_absolute() {
        target.to_string()
    } else {
        std::path::Path::new(cwd)
            .join(path)
            .to_string_lossy()
            .into_owned()
    }
}

pub fn unix_os(output: &str) -> Result<&'static str, String> {
    match output.trim() {
        "Linux" => Ok("linux"),
        "Darwin" => Ok("macos"),
        "Windows_NT" => Ok("windows"),
        other => Err(format!("无法识别项目执行系统：{other}")),
    }
}

#[tauri::command]
pub fn resolve_run_environment(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<RunEnvironment, String> {
    allowlist.ensure_executable(&path)?;
    if let Some(wsl) = parse_wsl_path(&path) {
        if !cfg!(windows) {
            return Err("WSL 目录仅支持通过 Windows 宿主运行".into());
        }
        return Ok(RunEnvironment {
            os: "linux".into(),
            kind: "wsl".into(),
            distro: Some(wsl.distro),
        });
    }
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "macos",
        other => return Err(format!("不支持的运行系统：{other}")),
    };
    Ok(RunEnvironment {
        os: os.into(),
        kind: "local".into(),
        distro: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wsl_unc_uri_and_canonical_paths() {
        for path in [
            r"\\wsl$\Ubuntu\home\my app",
            r"\\wsl.localhost\Ubuntu\home\my app",
            "wsl://Ubuntu/home/my app",
            r"\\?\UNC\wsl.localhost\Ubuntu\home\my app",
        ] {
            assert_eq!(
                parse_wsl_path(path),
                Some(WslPath {
                    distro: "Ubuntu".into(),
                    path: "/home/my app".into()
                })
            );
        }
        assert!(parse_wsl_path("ssh://wsl/home/app").is_none());
        assert!(parse_wsl_path("D:/app").is_none());
        assert!(parse_wsl_path("wsl://--help/app").is_none());
    }

    #[test]
    fn task_target_maps_wsl_uri_and_relative_paths_to_unc() {
        let unc = r"\\wsl.localhost\Ubuntu\home\app\run.sh";
        assert_eq!(resolve_task_target("wsl://Ubuntu/home/app", "run.sh"), unc);
        assert_eq!(resolve_task_target("wsl://Ubuntu/home/app/", "run.sh"), unc);
        assert_eq!(
            resolve_task_target(r"\\wsl$\Ubuntu\home\app", "/home/app/run.sh"),
            unc
        );
        assert_eq!(
            resolve_task_target("wsl://Ubuntu/home", "wsl://Ubuntu/home/app/run.sh"),
            unc
        );
        assert_eq!(
            to_host_path("wsl://Ubuntu/home/app"),
            r"\\wsl.localhost\Ubuntu\home\app"
        );
        assert_eq!(to_host_path("D:/app"), "D:/app");
    }

    #[test]
    fn remote_os_uses_probe_result() {
        assert_eq!(unix_os("Darwin\n").unwrap(), "macos");
        assert_eq!(unix_os("Linux\n").unwrap(), "linux");
        assert!(unix_os("FreeBSD").is_err());
    }
}
