//! Explicit Linux system-level service installation. The daemon and network
//! gateway have separate cgroups so restarting the gateway preserves PTYs.

use std::process::ExitCode;

const USAGE: &str = "qingcode-server service <install|start|stop|restart|status|uninstall> --name <name>
  install --user <existing-account> [--hostname <IP>] [--port <1-65535>]
          [--state-dir <absolute-directory>] [--detached-ttl-secs <positive-seconds>]
          [--idle-exit-secs <positive-seconds>] [--enable] [--start]
  restart restarts only the gateway and preserves daemon PTYs; --all restarts both and ENDS PTYs.
  stop and uninstall stop both services and END PTYs. uninstall preserves state, credentials and projects.
  install defaults to generating units without enabling or starting them; root and Linux systemd are required.";

/// CLI entry point; service control is deliberately unavailable on other OSes.
pub fn run(args: &[String]) -> ExitCode {
    #[cfg(target_os = "linux")]
    let result = linux::execute(args);
    #[cfg(not(target_os = "linux"))]
    let result: Result<(), String> = {
        let _ = args;
        Err("service management currently supports Linux systemd only".into())
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}\n{USAGE}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(target_os = "linux")]
mod model {
    use serde::{Deserialize, Serialize};
    use std::collections::HashSet;
    use std::path::{Component, Path};

    #[derive(Debug, PartialEq, Eq)]
    pub(super) struct Arguments {
        pub action: String,
        pub name: String,
        pub user: Option<String>,
        pub hostname: String,
        pub port: u16,
        pub state_dir: Option<String>,
        pub detached_ttl_secs: u64,
        pub idle_exit_secs: u64,
        pub enable: bool,
        pub start: bool,
        pub all: bool,
    }

    pub(super) fn safe_name(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 48
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }

    pub(super) fn safe_account(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 64
            && (value.as_bytes()[0].is_ascii_alphabetic() || value.starts_with('_'))
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }

    pub(super) fn valid_path(value: &str) -> Result<(), String> {
        let path = Path::new(value);
        if !path.is_absolute()
            || path == Path::new("/")
            || value.chars().any(char::is_control)
            || value.split('/').any(|part| matches!(part, "." | ".."))
            || path
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err("service paths must be absolute, non-root paths without traversal or control characters".into());
        }
        Ok(())
    }

    pub(super) fn parse(args: &[String]) -> Result<Arguments, String> {
        let action = args.first().ok_or("missing service action")?.clone();
        if !matches!(
            action.as_str(),
            "install" | "start" | "stop" | "restart" | "status" | "uninstall"
        ) {
            return Err("unknown service action".into());
        }
        let mut parsed = Arguments {
            action,
            name: String::new(),
            user: None,
            hostname: "0.0.0.0".into(),
            port: crate::direct::DEFAULT_DIRECT_PORT,
            state_dir: None,
            detached_ttl_secs: 86400,
            idle_exit_secs: 86400,
            enable: false,
            start: false,
            all: false,
        };
        let mut seen = HashSet::new();
        let mut index = 1;
        while index < args.len() {
            let flag = args[index].as_str();
            if !seen.insert(flag) {
                return Err(format!("duplicate option {flag}"));
            }
            if matches!(flag, "--enable" | "--start" | "--all") {
                match flag {
                    "--enable" => parsed.enable = true,
                    "--start" => parsed.start = true,
                    "--all" => parsed.all = true,
                    _ => unreachable!(),
                }
                index += 1;
                continue;
            }
            let value = args
                .get(index + 1)
                .ok_or_else(|| format!("missing value for {flag}"))?;
            match flag {
                "--name" => parsed.name = value.clone(),
                "--user" => parsed.user = Some(value.clone()),
                "--hostname" => parsed.hostname = value.clone(),
                "--port" => parsed.port = value.parse().map_err(|_| "port must be 1-65535")?,
                "--state-dir" => parsed.state_dir = Some(value.clone()),
                "--detached-ttl-secs" => {
                    parsed.detached_ttl_secs = value.parse().map_err(|_| "invalid detached TTL")?
                }
                "--idle-exit-secs" => {
                    parsed.idle_exit_secs = value.parse().map_err(|_| "invalid idle lifetime")?
                }
                _ => return Err(format!("unknown service option {flag}")),
            }
            index += 2;
        }
        if !safe_name(&parsed.name) {
            return Err("--name must be 1-48 ASCII letters/digits, hyphens or underscores, starting with a letter/digit".into());
        }
        if parsed.action == "install" {
            if !parsed.user.as_deref().is_some_and(safe_account) {
                return Err(
                    "install requires explicit --user with an existing system account".into(),
                );
            }
            parsed
                .hostname
                .parse::<std::net::IpAddr>()
                .map_err(|_| "--hostname must be a listen IP address")?;
            if parsed.port == 0 || parsed.detached_ttl_secs == 0 || parsed.idle_exit_secs == 0 {
                return Err("port and lifecycle durations must be positive".into());
            }
            if let Some(path) = &parsed.state_dir {
                valid_path(path)?;
            }
            if parsed.all {
                return Err("--all is only valid for restart".into());
            }
        } else if seen.iter().any(|flag| !matches!(*flag, "--name" | "--all"))
            || (parsed.all && parsed.action != "restart")
        {
            return Err("lifecycle actions accept only --name; restart also accepts --all".into());
        }
        Ok(parsed)
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(super) struct Config {
        pub schema: u32,
        pub name: String,
        pub user: String,
        pub uid: u32,
        pub gid: u32,
        pub home: String,
        pub hostname: String,
        pub port: u16,
        pub state_dir: String,
        pub detached_ttl_secs: u64,
        pub idle_exit_secs: u64,
        pub binary_sha256: String,
    }

    impl Config {
        pub fn validate(&self, expected_name: &str) -> Result<(), String> {
            if self.schema != 1
                || self.name != expected_name
                || !safe_name(&self.name)
                || !safe_account(&self.user)
                || self.port == 0
                || self.detached_ttl_secs == 0
                || self.idle_exit_secs == 0
                || self.hostname.parse::<std::net::IpAddr>().is_err()
                || self.binary_sha256.len() != 64
                || !self.binary_sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("invalid managed service configuration".into());
            }
            valid_path(&self.home)?;
            valid_path(&self.state_dir)
        }

        pub fn binary(&self) -> String {
            format!("/opt/qingcode/{}/qingcode-server", self.name)
        }

        pub fn unit(&self, daemon: bool) -> String {
            format!(
                "qingcode-cloud-{}-{}.service",
                self.name,
                if daemon { "daemon" } else { "gateway" }
            )
        }

        pub fn units(&self) -> [(String, String); 2] {
            let binary = quote(&self.binary(), true);
            let state = quote(&self.state_dir, true);
            let daemon = self.unit(true);
            let gateway = self.unit(false);
            let common = format!(
                "Type=simple\nUser={}\nGroup={}\nEnvironment={}\nWorkingDirectory={}\nUMask=0077\nRestart=always\nRestartSec=3\nKillMode=control-group\nTimeoutStartSec=30\nTimeoutStopSec=15\nStandardOutput=journal\nStandardError=journal\n",
                self.user, self.gid, quote(&format!("HOME={}", self.home), false), quote(&self.home, false),
            );
            let marker = format!(
                "# Managed by qingcode-server service schema 1: {}\n",
                self.name
            );
            let daemon_text = format!(
                "{marker}[Unit]\nDescription=QingCode cloud {} terminal daemon\nWants={gateway}\n\n[Service]\n{common}ExecStart={binary} daemon --state-dir {state} --detached-ttl-secs {} --idle-exit-secs {}\nExecStartPost={binary} service wait-owned-daemon --state-dir {state}\n\n[Install]\nWantedBy=multi-user.target\n",
                self.name, self.detached_ttl_secs, self.idle_exit_secs,
            );
            let gateway_text = format!(
                "{marker}[Unit]\nDescription=QingCode cloud {} HTTPS/WSS gateway\nRequires={daemon}\nAfter={daemon} network.target\nPartOf={daemon}\n\n[Service]\n{common}ExecStartPre={binary} service wait-daemon --state-dir {state}\nExecStart={binary} direct --require-daemon --hostname {} --port {} --state-dir {state}\nExecStartPost={binary} service wait-gateway --state-dir {state}\n\n[Install]\nWantedBy=multi-user.target\n",
                self.name, quote(&self.hostname, true), self.port,
            );
            [(daemon, daemon_text), (gateway, gateway_text)]
        }
    }

    /// systemd unquotes these directives before expanding specifiers. ExecStart
    /// also expands dollar references; doubling each dollar preserves argv.
    pub(super) fn quote(value: &str, command: bool) -> String {
        let mut output = String::from("\"");
        for c in value.chars() {
            match c {
                '\\' => output.push_str("\\\\"),
                '"' => output.push_str("\\\""),
                '%' => output.push_str("%%"),
                '$' if command => output.push_str("$$"),
                c => output.push(c),
            }
        }
        output.push('"');
        output
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::model::*;
    use sha2::{Digest, Sha256};
    use std::ffi::{CStr, CString};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};
    use std::time::{Duration, Instant};

    pub(super) fn execute(args: &[String]) -> Result<(), String> {
        if args.first().is_some_and(|action| {
            matches!(
                action.as_str(),
                "wait-daemon" | "wait-owned-daemon" | "wait-gateway"
            )
        }) {
            return wait_ready(args);
        }
        let args = parse(args)?;
        // SAFETY: geteuid has no pointer arguments or side effects.
        if unsafe { libc::geteuid() } != 0 {
            return Err("system-level service management requires root".into());
        }
        let ctl = systemctl()?;
        if args.action == "install" {
            return install(&ctl, &args);
        }
        let config = load(&args.name)?;
        match args.action.as_str() {
            "start" => {
                control(&ctl, &["start", &config.unit(true), &config.unit(false)])?;
                status(&ctl, &config)
            }
            "restart" => {
                if args.all {
                    eprintln!("Restarting daemon and gateway: all terminal processes for this service will end.");
                    control(&ctl, &["restart", &config.unit(true)])?;
                } else {
                    eprintln!("Restarting gateway only; daemon terminal processes are preserved.");
                    control(&ctl, &["restart", &config.unit(false)])?;
                }
                status(&ctl, &config)
            }
            "stop" => {
                eprintln!("Stopping daemon and gateway: all terminal processes for this service will end.");
                control(&ctl, &["stop", &config.unit(false), &config.unit(true)])?;
                status(&ctl, &config)
            }
            "status" => status(&ctl, &config),
            "uninstall" => uninstall(&ctl, &config),
            _ => unreachable!(),
        }
    }

    fn systemctl() -> Result<PathBuf, String> {
        if !Path::new("/run/systemd/system").is_dir() {
            return Err("the host is not running systemd".into());
        }
        ["/usr/bin/systemctl", "/bin/systemctl"]
            .iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
            .ok_or_else(|| "systemctl is unavailable".into())
    }

    fn output(ctl: &Path, args: &[&str]) -> Result<Output, String> {
        Command::new(ctl)
            .args(args)
            .env("SYSTEMD_PAGER", "")
            .env("SYSTEMD_COLORS", "0")
            .output()
            .map_err(|e| format!("systemctl failed: {e}"))
    }

    fn control(ctl: &Path, args: &[&str]) -> Result<(), String> {
        let output = output(ctl, args)?;
        if !output.status.success() {
            return Err(format!(
                "systemctl {} failed: {}",
                args.first().copied().unwrap_or_default(),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    }

    struct Account {
        uid: u32,
        gid: u32,
        home: String,
    }

    fn account(name: &str) -> Result<Account, String> {
        let name = CString::new(name).map_err(|_| "invalid account name")?;
        let mut buffer = vec![0u8; 16384];
        loop {
            let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
            let mut found = std::ptr::null_mut();
            // SAFETY: record and buffer are writable for their documented
            // sizes, and returned strings are copied before the buffer drops.
            let code = unsafe {
                libc::getpwnam_r(
                    name.as_ptr(),
                    record.as_mut_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut found,
                )
            };
            if code == libc::ERANGE && buffer.len() < 1024 * 1024 {
                buffer.resize(buffer.len() * 2, 0);
                continue;
            }
            if code != 0 || found.is_null() {
                return Err("--user must identify an existing system account".into());
            }
            // SAFETY: successful getpwnam_r initialized record; pw_dir points
            // into the live buffer and is a NUL-terminated account field.
            let record = unsafe { record.assume_init() };
            let home = unsafe { CStr::from_ptr(record.pw_dir) }
                .to_str()
                .map_err(|_| "account home is not UTF-8")?
                .to_string();
            valid_path(&home)?;
            if !Path::new(&home).is_dir() {
                return Err("account home directory does not exist".into());
            }
            return Ok(Account {
                uid: record.pw_uid,
                gid: record.pw_gid,
                home,
            });
        }
    }

    fn metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
        match fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() => Err(format!(
                "refusing symlink in service path: {}",
                path.display()
            )),
            Ok(meta) => Ok(Some(meta)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("cannot inspect {}: {error}", path.display())),
        }
    }

    fn directory(
        path: &Path,
        uid: u32,
        gid: u32,
        private: bool,
        create: bool,
    ) -> Result<(), String> {
        let mut current = PathBuf::from("/");
        for part in path.components().skip(1) {
            current.push(part.as_os_str());
            match metadata(&current)? {
                Some(meta) => {
                    if !meta.is_dir() {
                        return Err(format!("not a service directory: {}", current.display()));
                    }
                    // Root may traverse existing parents, but the service user
                    // must also be able to traverse them. Do not chmod/chown
                    // someone else's home or a pre-existing project directory.
                    let accessible = uid == 0
                        || if meta.uid() == uid {
                            meta.mode() & 0o100 != 0
                        } else if meta.gid() == gid {
                            meta.mode() & 0o010 != 0
                        } else {
                            meta.mode() & 0o001 != 0
                        };
                    if !accessible {
                        return Err(format!(
                            "service account cannot traverse existing directory: {}",
                            current.display()
                        ));
                    }
                }
                None => {
                    if !create {
                        return Err(format!(
                            "service state directory is missing: {}",
                            current.display()
                        ));
                    }
                    fs::create_dir(&current)
                        .map_err(|e| format!("create {} failed: {e}", current.display()))?;
                    let file = OpenOptions::new()
                        .read(true)
                        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
                        .open(&current)
                        .map_err(|e| e.to_string())?;
                    // SAFETY: fchown acts on the opened directory descriptor;
                    // neither a symlink nor a separately swapped path is used.
                    use std::os::fd::AsRawFd;
                    if unsafe { libc::fchown(file.as_raw_fd(), uid, gid) } != 0 {
                        return Err(format!(
                            "directory ownership failed: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                    file.set_permissions(fs::Permissions::from_mode(if private {
                        0o700
                    } else {
                        0o755
                    }))
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if meta.uid() != uid
            || (private && meta.mode() & 0o077 != 0)
            || (!private && meta.mode() & 0o022 != 0)
        {
            return Err(format!(
                "existing service directory has unsafe ownership/permissions: {}",
                path.display()
            ));
        }
        Ok(())
    }

    fn create_file(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|e| format!("create {} failed: {e}", path.display()))?;
        // Set the final mode explicitly: an administrator's restrictive umask
        // must not turn the shared executable into a root-only 0700 file.
        if let Err(error) = file
            .set_permissions(fs::Permissions::from_mode(mode))
            .and_then(|_| file.write_all(bytes))
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(format!("write {} failed: {error}", path.display()));
        }
        Ok(())
    }

    fn install(ctl: &Path, args: &Arguments) -> Result<(), String> {
        let user = args.user.as_deref().ok_or("missing service user")?;
        let account = account(user)?;
        let source = fs::read(std::env::current_exe().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let config = Config {
            schema: 1,
            name: args.name.clone(),
            user: user.into(),
            uid: account.uid,
            gid: account.gid,
            home: account.home.clone(),
            hostname: args.hostname.clone(),
            port: args.port,
            state_dir: args.state_dir.clone().unwrap_or_else(|| {
                format!(
                    "{}/.qingcode/cloud/{}/run",
                    account.home.trim_end_matches('/'),
                    args.name
                )
            }),
            detached_ttl_secs: args.detached_ttl_secs,
            idle_exit_secs: args.idle_exit_secs,
            binary_sha256: format!("{:x}", Sha256::digest(&source)),
        };
        config.validate(&args.name)?;
        let bin_dir = PathBuf::from(format!("/opt/qingcode/{}", args.name));
        let config_path = PathBuf::from(format!("/etc/qingcode/{}.json", args.name));
        let units = config.units();
        for path in [&bin_dir, &config_path] {
            if metadata(path)?.is_some() {
                return Err(format!("refusing existing installation path {}; uninstall explicitly before reinstalling", path.display()));
            }
        }
        for (unit, _) in &units {
            require_unused_unit_paths(
                unit,
                &[
                    Path::new("/etc/systemd/system"),
                    Path::new("/run/systemd/system"),
                    Path::new("/usr/lib/systemd/system"),
                    Path::new("/lib/systemd/system"),
                ],
            )?;
            let loaded = output(ctl, &["show", "--no-pager", "--property=LoadState", unit])?;
            let text = String::from_utf8_lossy(&loaded.stdout);
            let state = text
                .lines()
                .find_map(|line| line.strip_prefix("LoadState="));
            match state {
                Some("not-found") => {}
                Some(state) if loaded.status.success() => {
                    return Err(format!(
                        "refusing pre-existing service unit {unit} (LoadState={state})"
                    ));
                }
                _ => return Err(format!("cannot verify that service unit {unit} is unused")),
            }
        }
        directory(Path::new("/opt/qingcode"), 0, 0, false, true)?;
        directory(Path::new("/etc/qingcode"), 0, 0, false, true)?;
        directory(Path::new("/etc/systemd/system"), 0, 0, false, true)?;
        // All mutation below a developer's writable home occurs after dropping
        // to that developer. A concurrent symlink change cannot redirect a
        // privileged mkdir/chown into another account's filesystem tree.
        use std::os::unix::process::CommandExt;
        let prepared = Command::new("/bin/sh")
            .args([
                "-c",
                "umask 077; exec /bin/mkdir -p -m 700 -- \"$1\"",
                "qingcode-service-state",
            ])
            .arg(Path::new(&config.state_dir).join("direct"))
            .env_clear()
            .env("HOME", &account.home)
            .env("PATH", "/usr/bin:/bin")
            .current_dir(&account.home)
            .gid(account.gid)
            .uid(account.uid)
            .output()
            .map_err(|e| format!("cannot prepare state as service account: {e}"))?;
        if !prepared.status.success() {
            return Err(format!(
                "service account could not create private state: {}",
                String::from_utf8_lossy(&prepared.stderr).trim()
            ));
        }
        directory(
            Path::new(&config.state_dir),
            account.uid,
            account.gid,
            true,
            false,
        )?;
        directory(
            &Path::new(&config.state_dir).join("direct"),
            account.uid,
            account.gid,
            true,
            false,
        )?;
        reject_state_conflict(&config)?;
        fs::create_dir(&bin_dir).map_err(|e| e.to_string())?;
        fs::set_permissions(&bin_dir, fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        let mut created = Vec::new();
        let result: Result<(), String> = (|| {
            let binary = PathBuf::from(config.binary());
            create_file(&binary, &source, 0o755)?;
            created.push(binary);
            create_file(
                &config_path,
                &serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
                0o644,
            )?;
            created.push(config_path.clone());
            for (name, contents) in &units {
                let path = Path::new("/etc/systemd/system").join(name);
                create_file(&path, contents.as_bytes(), 0o644)?;
                created.push(path);
            }
            control(ctl, &["daemon-reload"])?;
            if args.enable {
                control(ctl, &["enable", &config.unit(true), &config.unit(false)])?;
            }
            if args.start {
                control(ctl, &["start", &config.unit(true), &config.unit(false)])?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = control(ctl, &["stop", &config.unit(false), &config.unit(true)]);
            if args.enable {
                let _ = control(ctl, &["disable", &config.unit(false), &config.unit(true)]);
            }
            for path in created.iter().rev() {
                let _ = fs::remove_file(path);
            }
            let _ = fs::remove_dir(&bin_dir);
            let _ = control(ctl, &["daemon-reload"]);
            return Err(format!("service installation failed; new managed files rolled back, state preserved: {error}"));
        }
        println!(
            "{}",
            serde_json::json!({"installed":true,"name":config.name,"enabled":args.enable,"started":args.start,"stateDir":config.state_dir,"binary":config.binary()})
        );
        Ok(())
    }

    fn managed_file(path: &Path) -> Result<Vec<u8>, String> {
        let meta =
            metadata(path)?.ok_or_else(|| format!("managed file missing: {}", path.display()))?;
        if !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err(format!("refusing unsafe managed file: {}", path.display()));
        }
        fs::read(path).map_err(|e| e.to_string())
    }

    fn reject_state_conflict(config: &Config) -> Result<(), String> {
        let state = Path::new(&config.state_dir);
        let canonical = fs::canonicalize(state).map_err(|e| e.to_string())?;
        for entry in fs::read_dir("/etc/qingcode").map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(other) = managed_file(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
                .filter(|other| other.validate(name).is_ok())
            else {
                continue;
            };
            if fs::canonicalize(&other.state_dir).is_ok_and(|path| path == canonical) {
                return Err(format!(
                    "state directory is already assigned to managed service {}",
                    other.name
                ));
            }
        }
        if fs::read(state.join("direct/endpoint.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<crate::direct::DirectInfo>(&bytes).ok())
            .is_some_and(|info| crate::direct::process_alive(info.pid))
        {
            return Err(
                "state directory already has a running direct gateway; refusing to adopt it".into(),
            );
        }
        // Probe only the already-existing socket: no RunDir::resolve, chmod,
        // token reads or root-created lock files in the developer's tree.
        if crate::ipc::IpcEndpoint::new(state)
            .blocking_connect()
            .is_ok()
        {
            return Err(
                "state directory already has a running daemon; refusing to adopt its terminals"
                    .into(),
            );
        }
        Ok(())
    }

    fn load(name: &str) -> Result<Config, String> {
        let config_path = PathBuf::from(format!("/etc/qingcode/{name}.json"));
        let config: Config = serde_json::from_slice(&managed_file(&config_path)?)
            .map_err(|_| "invalid service configuration")?;
        config.validate(name)?;
        let account = account(&config.user)?;
        if account.uid != config.uid || account.gid != config.gid || account.home != config.home {
            return Err(
                "service account identity changed; inspect the installation before managing it"
                    .into(),
            );
        }
        for (name, expected) in config.units() {
            if managed_file(&Path::new("/etc/systemd/system").join(name))? != expected.as_bytes() {
                return Err(
                    "service unit was edited outside this tool; refusing to overwrite or remove it"
                        .into(),
                );
            }
        }
        let actual = format!(
            "{:x}",
            Sha256::digest(managed_file(Path::new(&config.binary()))?)
        );
        if actual != config.binary_sha256 {
            return Err(
                "managed service executable digest changed; refusing lifecycle changes".into(),
            );
        }
        Ok(config)
    }

    fn status(ctl: &Path, config: &Config) -> Result<(), String> {
        let read = |unit: &str| -> Result<serde_json::Value, String> {
            let output = output(
                ctl,
                &[
                    "show",
                    "--no-pager",
                    "--property=ActiveState",
                    "--property=SubState",
                    "--property=MainPID",
                    "--property=UnitFileState",
                    unit,
                ],
            )?;
            if !output.status.success() {
                return Err("cannot inspect managed systemd unit".into());
            }
            let text = String::from_utf8_lossy(&output.stdout);
            let get = |key: &str| {
                text.lines()
                    .find_map(|line| line.strip_prefix(key))
                    .unwrap_or_default()
                    .to_string()
            };
            Ok(
                serde_json::json!({"unit":unit,"activeState":get("ActiveState="),"subState":get("SubState="),"mainPid":get("MainPID=").parse::<u32>().unwrap_or(0),"unitFileState":get("UnitFileState=")}),
            )
        };
        println!(
            "{}",
            serde_json::json!({"name":config.name,"user":config.user,"hostname":config.hostname,"port":config.port,"stateDir":config.state_dir,"daemon":read(&config.unit(true))?,"gateway":read(&config.unit(false))?})
        );
        Ok(())
    }

    fn require_unused_unit_paths(unit: &str, roots: &[&Path]) -> Result<(), String> {
        for root in roots {
            for name in [unit.to_string(), format!("{unit}.d")] {
                let path = root.join(name);
                // symlink_metadata rejects even a dangling alias/drop-in path;
                // unknown inspection errors must not be treated as absence.
                match fs::symlink_metadata(&path) {
                    Ok(_) => {
                        return Err(format!(
                            "refusing pre-existing service unit or overrides: {}",
                            path.display()
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!("cannot inspect {}: {error}", path.display()));
                    }
                }
            }
        }
        Ok(())
    }

    fn require_only_managed_binary(bin_dir: &Path) -> Result<(), String> {
        let directory = metadata(bin_dir)?
            .ok_or_else(|| format!("managed directory missing: {}", bin_dir.display()))?;
        if !directory.is_dir() {
            return Err("managed executable directory is not a directory".into());
        }
        let mut found = false;
        for entry in fs::read_dir(bin_dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_name() != "qingcode-server"
                || !entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_file()
            {
                return Err(format!(
                    "refusing uninstall: unexpected installation entry {}; managed files and service state were not changed",
                    entry.path().display()
                ));
            }
            found = true;
        }
        if !found {
            return Err("managed executable is missing; uninstall was not started".into());
        }
        Ok(())
    }

    fn uninstall(ctl: &Path, config: &Config) -> Result<(), String> {
        require_only_managed_binary(Path::new(&format!("/opt/qingcode/{}", config.name)))?;
        eprintln!("Uninstalling service: all terminal processes for this service will end; state, credentials and projects are preserved.");
        control(ctl, &["stop", &config.unit(false), &config.unit(true)])?;
        control(ctl, &["disable", &config.unit(false), &config.unit(true)])?;
        for (name, _) in config.units() {
            fs::remove_file(Path::new("/etc/systemd/system").join(name))
                .map_err(|e| e.to_string())?;
        }
        fs::remove_file(format!("/etc/qingcode/{}.json", config.name))
            .map_err(|e| e.to_string())?;
        fs::remove_file(config.binary()).map_err(|e| e.to_string())?;
        fs::remove_dir(format!("/opt/qingcode/{}", config.name)).map_err(|e| e.to_string())?;
        control(ctl, &["daemon-reload"])?;
        println!(
            "{}",
            serde_json::json!({"uninstalled":true,"name":config.name,"statePreserved":config.state_dir})
        );
        Ok(())
    }

    fn wait_ready(args: &[String]) -> Result<(), String> {
        if args.len() != 3 || args[1] != "--state-dir" {
            return Err("invalid internal readiness arguments".into());
        }
        valid_path(&args[2])?;
        let state = Path::new(&args[2]);
        let started = Instant::now();
        loop {
            let ready = if args[0] != "wait-gateway" {
                let endpoint_ready =
                    crate::connect::ensure_daemon_token(&crate::connect::ConnectOptions {
                        state_dir: Some(state.into()),
                        ensure_daemon: false,
                        ..Default::default()
                    })
                    .is_ok();
                endpoint_ready
                    && (args[0] != "wait-owned-daemon" || main_process("daemon", state).is_some())
            } else {
                crate::direct::info(Some(state), false)
                    .is_ok_and(|info| main_process("direct", state) == Some(info.pid))
            };
            if ready {
                return Ok(());
            }
            if started.elapsed() >= Duration::from_secs(20) {
                return Err(format!("{} timed out", args[0]));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn main_process(command: &str, state: &Path) -> Option<u32> {
        let pid = std::env::var("MAINPID")
            .ok()?
            .parse::<u32>()
            .ok()
            .filter(|pid| *pid > 0)?;
        let proc = PathBuf::from(format!("/proc/{pid}"));
        let executable = fs::read_link(proc.join("exe")).ok()?;
        if executable != std::env::current_exe().ok()? {
            return None;
        }
        let command_line = fs::read(proc.join("cmdline")).ok()?;
        let args: Vec<_> = command_line.split(|byte| *byte == 0).collect();
        if args.get(1).copied() != Some(command.as_bytes())
            || !args.windows(2).any(|pair| {
                pair[0] == b"--state-dir" && pair[1] == state.as_os_str().as_encoded_bytes()
            })
        {
            return None;
        }
        Some(pid)
    }
    #[cfg(test)]
    mod installation_preflight_tests {
        use super::*;

        struct Temporary(PathBuf);

        impl Temporary {
            fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "qingcode-service-preflight-{}",
                    crate::generate_token()
                ));
                fs::create_dir(&path).unwrap();
                Self(path)
            }
        }

        impl Drop for Temporary {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn unit_preflight_rejects_runtime_units_dropins_and_dangling_aliases() {
            let directory = Temporary::new();
            let root = directory.0.as_path();
            let unit = "qingcode-cloud-test-daemon.service";
            require_unused_unit_paths(unit, &[root]).unwrap();
            let path = root.join(unit);
            fs::write(&path, b"existing runtime unit").unwrap();
            assert!(require_unused_unit_paths(unit, &[root]).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"existing runtime unit");
            fs::remove_file(&path).unwrap();
            let overrides = root.join(format!("{unit}.d"));
            fs::create_dir(&overrides).unwrap();
            let override_file = overrides.join("override.conf");
            fs::write(&override_file, b"existing override").unwrap();
            assert!(require_unused_unit_paths(unit, &[root]).is_err());
            assert_eq!(fs::read(&override_file).unwrap(), b"existing override");
            fs::remove_dir_all(&overrides).unwrap();
            std::os::unix::fs::symlink(root.join("absent"), &path).unwrap();
            assert!(require_unused_unit_paths(unit, &[root]).is_err());
            assert!(fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink());
        }

        #[test]
        fn uninstall_preflight_rejects_extra_entries_without_changing_installation_or_state() {
            let directory = Temporary::new();
            let binary = directory.0.join("qingcode-server");
            fs::write(&binary, b"managed binary").unwrap();
            require_only_managed_binary(&directory.0).unwrap();
            let extra = directory.0.join("operator-notes.txt");
            fs::write(&extra, b"preserve operator data").unwrap();
            assert!(require_only_managed_binary(&directory.0).is_err());
            assert_eq!(fs::read(&binary).unwrap(), b"managed binary");
            assert_eq!(fs::read(&extra).unwrap(), b"preserve operator data");
            fs::remove_file(&extra).unwrap();
            let state = directory.0.join("state");
            fs::create_dir(&state).unwrap();
            fs::write(state.join("token"), b"preserve pairing credential").unwrap();
            assert!(require_only_managed_binary(&directory.0).is_err());
            assert_eq!(fs::read(&binary).unwrap(), b"managed binary");
            assert_eq!(
                fs::read(state.join("token")).unwrap(),
                b"preserve pairing credential"
            );
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::model::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    fn config() -> Config {
        Config {
            schema: 1,
            name: "demo245".into(),
            user: "developer".into(),
            uid: 1000,
            gid: 1000,
            home: "/home/developer".into(),
            hostname: "0.0.0.0".into(),
            port: 48765,
            state_dir: "/home/developer/.qingcode/cloud/demo245/run".into(),
            detached_ttl_secs: 86400,
            idle_exit_secs: 86400,
            binary_sha256: "a".repeat(64),
        }
    }

    #[test]
    fn service_install_requires_explicit_account_and_rejects_ambiguous_options() {
        assert!(parse(&args(&["install", "--name", "demo245"])).is_err());
        let parsed = parse(&args(&[
            "install",
            "--name",
            "demo245",
            "--user",
            "developer",
        ]))
        .unwrap();
        assert!(!parsed.enable && !parsed.start);
        assert_eq!(parsed.detached_ttl_secs, 86400);
        for values in [
            vec!["install", "--name", "../other", "--user", "developer"],
            vec![
                "install",
                "--name",
                "demo",
                "--user",
                "root\nExecStart=evil",
            ],
            vec![
                "install",
                "--name",
                "demo",
                "--user",
                "developer",
                "--port",
                "0",
            ],
            vec![
                "install",
                "--name",
                "demo",
                "--user",
                "developer",
                "--idle-exit-secs",
                "0",
            ],
            vec![
                "install",
                "--name",
                "demo",
                "--user",
                "developer",
                "--name",
                "other",
            ],
            vec!["restart", "--name", "demo", "--user", "developer"],
            vec!["stop", "--name", "demo", "--all"],
        ] {
            assert!(parse(&args(&values)).is_err(), "accepted {values:?}");
        }
        assert!(
            parse(&args(&["restart", "--name", "demo", "--all"]))
                .unwrap()
                .all
        );
    }

    #[test]
    fn service_paths_reject_traversal_and_unit_injection() {
        for path in [
            "/",
            "relative",
            "/tmp/../etc",
            "/tmp/./state",
            "/tmp/state\nUser=root",
            "/tmp/\0state",
        ] {
            assert!(valid_path(path).is_err(), "accepted {path:?}");
        }
        assert!(valid_path("/tmp/cloud dev/$HOME/%n/状态").is_ok());
        assert_eq!(
            quote("/tmp/a b/$HOME/%n/\"x\\", true),
            "\"/tmp/a b/$$HOME/%%n/\\\"x\\\\\""
        );
        assert_eq!(
            quote("HOME=/tmp/$HOME/%n", false),
            "\"HOME=/tmp/$HOME/%%n\""
        );
    }

    #[test]
    fn service_units_keep_daemon_and_gateway_lifetimes_separate() {
        let config = config();
        config.validate("demo245").unwrap();
        let [(daemon, daemon_text), (gateway, gateway_text)] = config.units();
        assert!(daemon_text.contains(&format!("Wants={gateway}")));
        assert!(gateway_text.contains(&format!("Requires={daemon}")));
        assert!(gateway_text.contains(&format!("PartOf={daemon}")));
        assert!(gateway_text.contains("direct --require-daemon"));
        assert!(daemon_text.contains("--detached-ttl-secs 86400 --idle-exit-secs 86400"));
        assert!(daemon_text.contains("service wait-owned-daemon"));
        assert!(gateway_text.contains("service wait-gateway"));
        for unit in [&daemon_text, &gateway_text] {
            assert!(unit.contains("Restart=always\nRestartSec=3"));
            assert!(unit.contains("User=developer\nGroup=1000"));
            assert!(unit.contains("UMask=0077"));
            assert!(!unit
                .split_whitespace()
                .any(|argument| argument == "--detach"));
            assert!(!unit.contains("token"));
        }
    }

    #[test]
    fn service_config_is_bound_to_name_and_contains_no_credentials() {
        let config = config();
        assert!(config.validate("other").is_err());
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("token") && !json.contains("certificate"));
        assert!(serde_json::from_str::<Config>(
            &json.replace("\"schema\":1", "\"schema\":1,\"token\":\"secret\"")
        )
        .is_err());
    }
}
