//! launchd registration. Changing registration leaves the current gateway alone.
use std::path::Path;

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn plist(name: &str, binary: &Path, state: &Path, info: &crate::direct::DirectInfo) -> String {
    let args = [
        binary.to_string_lossy().into_owned(),
        "direct".into(),
        "--hostname".into(),
        info.hostname.clone(),
        "--port".into(),
        info.port.to_string(),
        "--state-dir".into(),
        state.to_string_lossy().into_owned(),
    ];
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array>{}</array><key>RunAtLoad</key><true/></dict></plist>\n", xml(name), args.iter().map(|arg| format!("<string>{}</string>", xml(arg))).collect::<String>())
}

#[cfg(target_os = "macos")]
pub(super) fn register(
    action: &str,
    name: &str,
    binary: &Path,
    state: &Path,
    info: Option<&crate::direct::DirectInfo>,
) -> Result<(), String> {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let uid = unsafe { libc::geteuid() };
    let home = crate::daemon::home_dir().ok_or("home unavailable")?;
    let directory = if uid == 0 {
        "/Library/LaunchDaemons".into()
    } else {
        home.join("Library/LaunchAgents")
    };
    let path = directory.join(format!("{name}.plist"));
    let domain = if uid == 0 {
        "system".into()
    } else {
        format!("gui/{uid}")
    };
    let target = format!("{domain}/{name}");
    let marker = format!(
        "<!-- Managed by QingCode startup: {} -->\n",
        xml(&state.to_string_lossy())
    );
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink())
        || existing
            .as_ref()
            .is_some_and(|text| !text.contains(&marker))
    {
        return Err("refusing to change an unowned launchd plist".into());
    }
    match action {
        "enable" => {
            let info = info.ok_or("missing paired gateway descriptor")?;
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let text =
                plist(name, binary, state, info).replacen("<plist", &format!("{marker}<plist"), 1);
            let temp = path.with_extension(format!("plist.tmp-{}", std::process::id()));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            let result = (|| {
                use std::io::Write;
                file.set_permissions(std::fs::Permissions::from_mode(0o644))
                    .map_err(|e| e.to_string())?;
                file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                crate::direct::replace_private_file(&temp, &path)?;
                // launchd reads the refreshed executable at next boot/login.
                // No bootout: registration must not end current PTYs/gateway.
                super::checked(Command::new("launchctl").args(["enable", &target]))
            })();
            let _ = std::fs::remove_file(temp);
            result?;
        }
        "disable" if existing.is_some() => {
            super::checked(Command::new("launchctl").args(["disable", &target]))?;
        }
        "status" => {
            if existing.is_none() {
                return Err("startup is not registered".into());
            }
            let output = Command::new("launchctl")
                .args(["print-disabled", &domain])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success()
                || String::from_utf8_lossy(&output.stdout).contains(&format!("\"{name}\" => true"))
            {
                return Err("startup is disabled or launchd session is unavailable".into());
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plist_preserves_literal_paths_and_does_not_respawn_during_updates() {
        let info = crate::direct::DirectInfo {
            hostname: "::".into(),
            port: 48763,
            certificate_sha256: "a".repeat(64),
            server_version: "old".into(),
            protocol: 1,
            pid: 123,
            previous_ports: vec![],
            token: None,
        };
        let text = plist(
            "qingcode-direct-test",
            Path::new("/Users/a & b/server"),
            Path::new("/Users/a & b/run"),
            &info,
        );
        assert!(text.contains("<string>/Users/a &amp; b/server</string>"));
        assert!(text.contains("<string>--state-dir</string><string>/Users/a &amp; b/run</string>"));
        assert!(text.contains("<key>RunAtLoad</key><true/>"));
        assert!(!text.contains("KeepAlive"));
    }
}
