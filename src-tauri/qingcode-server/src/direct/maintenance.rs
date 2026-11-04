//! Stop only the current user's paired, default-state, privately installed gateway.
use super::{info, process_alive, DirectInfo};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

fn process_binary(pid: u32) -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let size = unsafe {
            libc::proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32)
        };
        if size <= 0 {
            return Err("cannot inspect gateway executable".into());
        }
        use std::os::unix::ffi::OsStrExt;
        let end = buffer.iter().position(|b| *b == 0).unwrap_or(size as usize);
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end])))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Err("gateway maintenance supports Linux and macOS".into())
    }
}

fn validate_process(binary: &Path, private: &Path, command: &str, uid: &str) -> Result<(), String> {
    let name = binary.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let managed_name = matches!(
        name,
        "qingcode-server-x86_64"
            | "qingcode-server-aarch64"
            | "qingcode-server-macos-x86_64"
            | "qingcode-server-macos-aarch64"
    );
    let executable = binary.to_str().ok_or("invalid executable path")?;
    let args = command
        .trim()
        .strip_prefix(executable)
        .ok_or("gateway executable changed")?;
    let default_state = private.join("run");
    let args = if args.contains("--state-dir") {
        args.strip_suffix(&format!(" --state-dir {}", default_state.display()))
            .filter(|rest| !rest.contains("--state-dir"))
            .ok_or("refusing a custom-state gateway")?
    } else {
        args
    };
    if !binary.starts_with(private)
        || !managed_name
        || !args.starts_with(" direct ") && args != " direct"
        || uid.trim() != unsafe { libc::geteuid() }.to_string()
    {
        return Err("refusing to stop an unrecognized or custom-state gateway".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn stop_startup_unit(pid: u32, state: &Path) -> Result<bool, String> {
    use sha2::{Digest, Sha256};
    let name = format!(
        "qingcode-direct-{:x}",
        Sha256::digest(state.to_string_lossy().as_bytes())
    );
    let name = &name[..32];
    let unit = format!("{name}.service");
    let root = unsafe { libc::geteuid() } == 0;
    let mut command = Command::new("systemctl");
    if !root {
        command.arg("--user");
    }
    let output = match command.args(["show", &unit, "--property=MainPID"]).output() {
        Ok(output) => output,
        Err(_) => return Ok(false),
    };
    if !output.status.success()
        || String::from_utf8_lossy(&output.stdout).trim() != format!("MainPID={pid}")
    {
        return Ok(false);
    }
    let path = if root {
        PathBuf::from("/etc/systemd/system").join(&unit)
    } else {
        crate::daemon::home_dir()
            .ok_or("home unavailable")?
            .join(".config/systemd/user")
            .join(&unit)
    };
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if std::fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
        || !text.starts_with(&format!(
            "# Managed by QingCode startup: {}\n",
            state.display()
        ))
    {
        return Err("refusing to stop an unowned startup unit".into());
    }
    let mut command = Command::new("systemctl");
    if !root {
        command.arg("--user");
    }
    let output = command
        .args(["stop", &unit])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("cannot stop managed startup gateway".into());
    }
    Ok(true)
}

fn same_identity(current: &DirectInfo, expected: &DirectInfo) -> bool {
    current.pid == expected.pid
        && current.port == expected.port
        && current
            .certificate_sha256
            .eq_ignore_ascii_case(&expected.certificate_sha256)
}

pub fn stop(pid: u32, port: u16, certificate: &str) -> Result<PathBuf, String> {
    stop_in_home(
        &crate::daemon::home_dir().ok_or("home unavailable")?,
        pid,
        port,
        certificate,
    )
}

fn stop_in_home(home: &Path, pid: u32, port: u16, certificate: &str) -> Result<PathBuf, String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("invalid gateway PID".into());
    }
    let private =
        std::fs::canonicalize(home.join(".qingcode/server")).map_err(|e| e.to_string())?;
    let state = private.join("run");
    let expected = info(Some(&state), false)?;
    if expected.pid != pid
        || expected.port != port
        || !expected
            .certificate_sha256
            .eq_ignore_ascii_case(certificate)
    {
        return Err("direct identity changed; retry update".into());
    }
    let binary = process_binary(pid)?;
    let query = |field: &str| -> Result<String, String> {
        let output = Command::new("ps")
            .args(["-ww", "-p", &pid.to_string(), "-o", field])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("gateway process unavailable".into());
        }
        String::from_utf8(output.stdout).map_err(|e| e.to_string())
    };
    validate_process(&binary, &private, &query("command=")?, &query("uid=")?)?;
    if !same_identity(&info(Some(&state), false)?, &expected) || process_binary(pid)? != binary {
        return Err("gateway changed before stop".into());
    }
    #[cfg(target_os = "linux")]
    let stopped_by_manager = stop_startup_unit(pid, &private.join("run"))?;
    #[cfg(not(target_os = "linux"))]
    let stopped_by_manager = false;
    if !stopped_by_manager && unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(pid) && process_binary(pid).is_ok() {
        if Instant::now() >= deadline {
            return Err("gateway did not stop in time".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(binary)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_gateway_stop_checks_identity_and_preserves_pairing_for_restart() {
        let Some(source) = std::env::var_os("QC_TEST_SERVER") else {
            return;
        };
        let home = std::env::temp_dir().join(format!(
            "qc-stop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct Fixture {
            home: PathBuf,
            child: Option<std::process::Child>,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Some(child) = &mut self.child {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let _ = std::fs::remove_dir_all(&self.home);
            }
        }
        let mut fixture = Fixture { home, child: None };
        let binary = fixture
            .home
            .join(".qingcode/server/old/qingcode-server-x86_64");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::copy(source, &binary).unwrap();
        let state = fixture.home.join(".qingcode/server/run");
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let spawn = || {
            Command::new(&binary)
                .args([
                    "direct",
                    "--hostname",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                    "--state-dir",
                    state.to_str().unwrap(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        };
        fixture.child = Some(spawn());
        let deadline = Instant::now() + Duration::from_secs(10);
        let before = loop {
            if let Ok(value) = info(Some(&state), true) {
                break value;
            }
            assert!(Instant::now() < deadline, "test gateway startup timed out");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(stop_in_home(&fixture.home, before.pid, port, &"b".repeat(64)).is_err());
        assert!(fixture
            .child
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        assert_eq!(
            stop_in_home(&fixture.home, before.pid, port, &before.certificate_sha256).unwrap(),
            binary
        );
        fixture.child.as_mut().unwrap().wait().unwrap();
        fixture.child = Some(spawn());
        let deadline = Instant::now() + Duration::from_secs(10);
        let after = loop {
            if let Ok(value) = info(Some(&state), true) {
                if value.pid != before.pid {
                    break value;
                }
            }
            assert!(Instant::now() < deadline, "test gateway restart timed out");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(before.port, after.port);
        assert_eq!(before.certificate_sha256, after.certificate_sha256);
        assert_eq!(before.token, after.token);
    }
    #[test]
    fn stop_requires_private_gateway_same_user_and_default_state() {
        let private = Path::new("/Users/a b/.qingcode/server");
        let bin = private.join("old/qingcode-server-macos-aarch64");
        let uid = unsafe { libc::geteuid() }.to_string();
        assert!(validate_process(
            &bin,
            private,
            &format!("{} direct --port 48763", bin.display()),
            &uid
        )
        .is_ok());
        assert!(validate_process(
            &bin,
            private,
            &format!(
                "{} direct --port 48763 --state-dir {}/run",
                bin.display(),
                private.display()
            ),
            &uid
        )
        .is_ok());
        for args in ["daemon", "direct --state-dir /tmp/other", "directly"] {
            assert!(
                validate_process(&bin, private, &format!("{} {args}", bin.display()), &uid)
                    .is_err()
            );
        }
        assert!(validate_process(
            &bin,
            Path::new("/other"),
            &format!("{} direct", bin.display()),
            &uid
        )
        .is_err());
        assert!(
            validate_process(&bin, private, &format!("{} direct", bin.display()), "other").is_err()
        );
    }
}
