//! Opt-in boot registration for the current user's paired direct gateway.
//! Disabling registration deliberately leaves the running gateway and PTYs alone.
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
use crate::daemon::RunDir;
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
use sha2::{Digest, Sha256};
use std::path::Path;
#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
use std::process::Command;
use std::process::ExitCode;

#[cfg(any(windows, test))]
const WINDOWS_SCRIPT: &str = include_str!("startup_windows.ps1");

#[cfg(any(target_os = "macos", test))]
mod macos;

pub fn run(args: &[String]) -> ExitCode {
    match execute(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[direct:startup] {error}");
            ExitCode::FAILURE
        }
    }
}

fn parse(args: &[String]) -> Result<(&str, Option<&Path>), String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    if !matches!(action, "enable" | "disable" | "status") {
        return Err(
            "usage: qingcode-server startup <enable|disable|status> [--state-dir <directory>]"
                .into(),
        );
    }
    match args.len() {
        1 => Ok((action, None)),
        3 if args[1] == "--state-dir" => {
            let path = Path::new(&args[2]);
            if !path.is_absolute() || args[2].chars().any(char::is_control) {
                return Err(
                    "startup state directory must be absolute without control characters".into(),
                );
            }
            Ok((action, Some(path)))
        }
        _ => Err("startup accepts only --state-dir".into()),
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn checked(command: &mut Command) -> Result<(), String> {
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .trim()
        .to_string())
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn execute(args: &[String]) -> Result<(), String> {
    let (action, state) = parse(args)?;
    let run = RunDir::resolve(state)?;
    let state = std::fs::canonicalize(run.dir()).map_err(|e| e.to_string())?;
    let binary = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = format!(
        "qingcode-direct-{:x}",
        Sha256::digest(state.to_string_lossy().as_bytes())
    );
    let name = &name[..32];
    // Reuse the saved listener configuration, certificate and token. Never pair
    // a new identity or reset the user's port as a side effect of registration.
    let info = if action == "enable" {
        Some(crate::direct::info(Some(&state), false)?)
    } else {
        None
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        fn quote(value: &str) -> String {
            format!("'{}'", value.replace('\'', "''"))
        }
        let script = format!(
            "{WINDOWS_SCRIPT}\nInvoke-QcStartup {} {} {} {} {} {}",
            quote(action),
            quote(name),
            quote(&binary.to_string_lossy()),
            quote(&state.to_string_lossy()),
            quote(
                info.as_ref()
                    .map(|i| i.hostname.as_str())
                    .unwrap_or("0.0.0.0")
            ),
            info.as_ref().map(|i| i.port).unwrap_or(0)
        );
        // UTF-16 encoded input avoids cmd.exe/PowerShell metacharacter expansion.
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let mut command = Command::new("powershell.exe");
        command.creation_flags(0x08000000).args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ]);
        checked(&mut command)?;
    }
    #[cfg(target_os = "linux")]
    linux(action, name, &binary, &state, info.as_ref())?;
    #[cfg(target_os = "macos")]
    macos::register(action, name, &binary, &state, info.as_ref())?;
    println!(
        "{}",
        serde_json::json!({ "autoStart": action != "disable", "name": name })
    );
    Ok(())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn execute(args: &[String]) -> Result<(), String> {
    parse(args)?;
    Err("startup supports Windows, Linux and macOS".into())
}

#[cfg(target_os = "linux")]
fn systemd_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    )
}

#[cfg(target_os = "linux")]
fn linux(
    action: &str,
    name: &str,
    binary: &Path,
    state: &Path,
    info: Option<&crate::direct::DirectInfo>,
) -> Result<(), String> {
    // A root SSH account uses the system manager. Other accounts use their own
    // manager, with lingering so the boot service does not depend on a login.
    let root = unsafe { libc::geteuid() } == 0;
    let home = std::env::var("HOME").map_err(|_| "HOME is unavailable")?;
    let directory = if root {
        "/etc/systemd/system".into()
    } else {
        format!("{home}/.config/systemd/user")
    };
    let unit = format!("{name}.service");
    let path = Path::new(&directory).join(&unit);
    let marker = format!("# Managed by QingCode startup: {}\n", state.display());
    let existing = match std::fs::read_to_string(&path) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink())
        || existing
            .as_ref()
            .is_some_and(|text| !text.starts_with(&marker))
    {
        return Err("refusing to change an unowned startup unit".into());
    }
    let ctl = |args: &[&str]| -> Result<(), String> {
        let mut command = Command::new("systemctl");
        if !root {
            command.arg("--user");
        }
        checked(command.args(args))
    };
    match action {
        "enable" => {
            if !root {
                checked(
                    Command::new("loginctl")
                        .args(["enable-linger", &unsafe { libc::geteuid() }.to_string()]),
                )?;
            }
            let info = info.ok_or("missing paired gateway descriptor")?;
            let text = format!("{marker}[Unit]\nDescription=QingCode direct gateway\nAfter=network.target\n[Service]\nType=simple\nExecStart={} direct --hostname {} --port {} --state-dir {}\nRestart=always\nRestartSec=5\nKillMode=process\nUMask=0077\n[Install]\nWantedBy={}\n", systemd_quote(&binary.to_string_lossy()), systemd_quote(&info.hostname), info.port, systemd_quote(&state.to_string_lossy()), if root { "multi-user.target" } else { "default.target" });
            crate::direct::protect_private_directory(state)?;
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            std::fs::write(&path, text).map_err(|e| e.to_string())?;
            ctl(&["daemon-reload"])?;
            ctl(&["enable", &unit])?;
        }
        "disable" if existing.is_some() => {
            ctl(&["disable", &unit])?;
        }
        "status" => {
            ctl(&["is-enabled", &unit])?;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_actions_relative_paths_and_extra_options() {
        for args in [
            vec![],
            vec!["stop"],
            vec!["enable", "--state-dir", "relative"],
            vec!["enable", "--user", "SYSTEM"],
        ] {
            assert!(parse(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_err());
        }
        assert_eq!(parse(&["disable".into()]).unwrap(), ("disable", None));
    }
    #[test]
    fn windows_boot_task_keeps_current_account_and_never_stops_gateway() {
        assert!(WINDOWS_SCRIPT.contains("-AtStartup"));
        assert!(WINDOWS_SCRIPT.contains("-LogonType S4U -RunLevel Limited"));
        assert!(WINDOWS_SCRIPT.contains("-ExecutionTimeLimit ([TimeSpan]::Zero)"));
        assert!(!WINDOWS_SCRIPT.contains("Stop-Process"));
        assert!(!WINDOWS_SCRIPT.contains("-Password"));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_paths_escape_specifiers_dollars_quotes_and_backslashes() {
        assert_eq!(
            systemd_quote("/home/a%/$x/\"b\\c"),
            "\"/home/a%%/$$x/\\\"b\\\\c\""
        );
    }
}
