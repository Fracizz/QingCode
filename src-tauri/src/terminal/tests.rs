use super::{hosted_env, hosted_shell_supported};
use std::collections::HashMap;

#[test]
fn hosted_env_drops_values_the_daemon_rejects_and_applies_overlay_last() {
    let base = [
        ("PATH".to_string(), "base".to_string()),
        ("TERM".to_string(), "dumb".to_string()),
        ("colorterm".to_string(), "24bit".to_string()),
        ("=C:".to_string(), "C:\\work".to_string()),
        ("LD_PRELOAD".to_string(), "evil.so".to_string()),
        ("BAD".to_string(), "a\0b".to_string()),
    ];
    let overlay = HashMap::from([("PATH".to_string(), "profile".to_string())]);
    let env = hosted_env(base, overlay);
    assert_eq!(env.len(), 1);
    assert_eq!(env.get("PATH").map(String::as_str), Some("profile"));
}

#[test]
fn only_shells_the_daemon_accepts_are_hosted() {
    for shell in ["powershell", "pwsh", "cmd"] {
        assert!(hosted_shell_supported(shell));
    }
    for shell in ["wsl", "bash", "zsh"] {
        assert!(!hosted_shell_supported(shell));
    }
}

#[test]
fn terminal_identity_overrides_inherited_values() {
    let mut cmd = portable_pty::CommandBuilder::new("cmd.exe");
    cmd.env("TERM_PROGRAM", "vscode");
    super::apply_terminal_identity(&mut cmd, "tab-1", r"C:\Windows\System32\cmd.exe");
    let value = |name: &str| cmd.get_env(name).and_then(|value| value.to_str());
    assert_eq!(value("TERM_PROGRAM"), Some("QingCode"));
    assert_eq!(
        value("TERM_PROGRAM_VERSION"),
        Some(env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(value("QINGCODE_TERMINAL_ID"), Some("tab-1"));
}

#[test]
fn terminal_identity_is_forwarded_into_wsl_and_keeps_existing_wslenv() {
    let mut cmd = portable_pty::CommandBuilder::new("wsl.exe");
    cmd.env("WSLENV", "USERPROFILE/p");
    super::apply_terminal_identity(&mut cmd, "tab-1", r"C:\Windows\System32\WSL.EXE");
    assert_eq!(
        cmd.get_env("WSLENV").and_then(|value| value.to_str()),
        Some("USERPROFILE/p:TERM_PROGRAM:TERM_PROGRAM_VERSION:QINGCODE_TERMINAL_ID")
    );
}

#[test]
fn mobile_wsl_args_pass_profile_command_as_positional_argument() {
    let plain = super::mobile_wsl_args("Ubuntu", "/home/app", None);
    assert_eq!(plain.last().unwrap(), r#"exec "${SHELL:-/bin/sh}" -l"#);
    assert_eq!(
        super::mobile_wsl_args("Ubuntu", "/home/app", Some("  ")),
        plain
    );

    let command = r#"claude --resume "$(cat id)""#;
    let args = super::mobile_wsl_args("Ubuntu", "/home/app", Some(command));
    assert_eq!(&args[..7], &plain[..7]);
    assert_eq!(
        &args[7..],
        [
            r#""${SHELL:-/bin/sh}" -lic "$1"; exec "${SHELL:-/bin/sh}" -l"#,
            "sh",
            command,
        ]
    );
}

#[cfg(windows)]
#[test]
fn windows_pty_killer_reports_success_for_terminated_child() {
    let pair = portable_pty::native_pty_system()
        .openpty(super::clamp_pty_size(80, 24))
        .unwrap();
    let mut child = pair
        .slave
        .spawn_command(portable_pty::CommandBuilder::new("cmd.exe"))
        .unwrap();
    let mut killer = super::WindowsPtyKiller::new(&*child).unwrap();
    portable_pty::ChildKiller::kill(&mut killer).unwrap();
    assert_eq!(child.wait().unwrap().exit_code(), 1);
}

/// 父进程（shell）下挂一个长时间运行的子进程，模拟终端里的前台程序。
fn spawn_shell_with_worker() -> std::process::Child {
    #[cfg(windows)]
    let child = std::process::Command::new("cmd")
        .args(["/c", "ping -n 30 127.0.0.1 >nul"])
        .spawn();
    #[cfg(not(windows))]
    let child = std::process::Command::new("/bin/sh")
        .args(["-c", "sleep 30; :"])
        .spawn();
    child.unwrap()
}

fn wait_for_descendants(root: u32) -> Vec<OwnedProcess> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let owned = snapshot_descendants(root);
        if owned.iter().any(|process| !process.noise) || Instant::now() >= deadline {
            return owned;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn force_stop_kills_snapshot_descendants_after_deadline() {
    let mut shell = spawn_shell_with_worker();
    let owned = wait_for_descendants(shell.id());
    assert!(
        owned.iter().any(|process| !process.noise),
        "worker not found"
    );
    force_stop_after(&owned, Instant::now());
    let system = refresh_owned(&owned);
    assert!(owned
        .iter()
        .all(|process| live_owned(&system, process).is_none()));
    let _ = shell.kill();
    let _ = shell.wait();
}

#[test]
fn second_interrupt_skips_program_that_already_exited() {
    let (writer, receiver) = std::sync::mpsc::sync_channel(1);
    send_second_interrupt(&writer, &[], Instant::now() + Duration::from_secs(5));
    assert!(receiver.try_recv().is_err());
}

#[test]
fn second_interrupt_reaches_program_still_running() {
    let mut shell = spawn_shell_with_worker();
    let owned = wait_for_descendants(shell.id());
    let (writer, receiver) = std::sync::mpsc::sync_channel(1);
    send_second_interrupt(&writer, &owned, Instant::now() + Duration::from_millis(100));
    assert_eq!(receiver.try_recv().unwrap(), b"\x03".to_vec());
    force_stop_after(&owned, Instant::now());
    let _ = shell.kill();
    let _ = shell.wait();
}

#[test]
fn force_stop_skips_reused_pids() {
    let mut worker = spawn_shell_with_worker();
    let pid = Pid::from_u32(worker.id());
    let stale = [OwnedProcess {
        pid,
        start_time: 0,
        noise: false,
    }];
    // 启动时间不匹配 = PID 已被复用，绝不能误杀，也不应等待。
    let started = Instant::now();
    force_stop_after(&stale, Instant::now() + Duration::from_secs(5));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(
        worker.try_wait().unwrap().is_none(),
        "reused pid was killed"
    );
    worker.kill().unwrap();
    worker.wait().unwrap();
}

#[test]
fn encode_terminal_data_uses_standard_base64() {
    assert_eq!(super::encode_terminal_data(b"hello"), "aGVsbG8=");
    assert_eq!(super::encode_terminal_data(&[0, 1, 255]), "AAH/");
    assert_eq!(super::encode_terminal_data(&[]), "");
}

#[test]
fn coalesces_queued_pty_chunks_without_waiting() {
    let mut rest = vec![vec![3_u8, 4], vec![5]];
    let combined = super::take_coalesced_terminal_output(
        vec![1, 2],
        || {
            if rest.is_empty() {
                None
            } else {
                Some(rest.remove(0))
            }
        },
        32,
    );
    assert_eq!(combined, vec![1, 2, 3, 4, 5]);
}

#[test]
fn blocked_writer_has_a_bounded_queue_and_does_not_block_other_writers() {
    struct PausedWriter {
        entered: std::sync::mpsc::Sender<()>,
        resume: std::sync::mpsc::Receiver<()>,
        paused: bool,
    }
    impl std::io::Write for PausedWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if !self.paused {
                self.entered.send(()).unwrap();
                self.resume.recv().unwrap();
                self.paused = true;
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[derive(Debug, Clone)]
    struct TestKiller(std::sync::mpsc::Sender<()>);
    impl ChildKiller for TestKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            self.0.send(()).unwrap();
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }
    let (entered, arrived) = std::sync::mpsc::channel();
    let (resume, paused) = std::sync::mpsc::channel();
    let writer = super::spawn_terminal_writer(
        Box::new(PausedWriter {
            entered,
            resume: paused,
            paused: false,
        }),
        |_| {},
    );
    let manager = TerminalManager::new();
    let pair = NativePtySystem::default()
        .openpty(clamp_pty_size(80, 24))
        .unwrap();
    let (kill, killed) = std::sync::mpsc::channel();
    manager.sessions.lock().unwrap().insert(
        "blocked".to_string(),
        TerminalSession {
            wsl_task: None,
            master: Arc::new(Mutex::new(pair.master)),
            writer,
            killer: Some(Box::new(TestKiller(kill))),
            generation: 1,
            shell_pid: None,
            output_gate: OutputGate::default(),
        },
    );
    manager.write("blocked", "first").unwrap();
    arrived
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    for _ in 0..8 {
        manager.write("blocked", "queued").unwrap();
    }
    assert!(manager
        .write("blocked", "overflow")
        .unwrap_err()
        .contains("缓冲区已满"));
    let other = super::spawn_terminal_writer(Box::new(std::io::sink()), |_| {});
    other.try_send(vec![2]).unwrap();
    manager.kill("blocked").unwrap();
    killed
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert!(manager.sessions.lock().unwrap().is_empty());
    resume.send(()).unwrap();
}
use super::*;

fn all_programs_available(program: &str) -> Option<String> {
    Some(program.to_string())
}

#[test]
fn infer_script_kind_from_extension() {
    assert_eq!(infer_script_kind(r"D:\run\task.ps1"), "ps1");
    assert_eq!(infer_script_kind("scripts/build.bat"), "bat");
    assert_eq!(infer_script_kind("scripts/build.CMD"), "bat");
    assert_eq!(infer_script_kind("scripts/build.sh"), "sh");
}

#[test]
fn strip_windows_verbatim_prefix_restores_drive_paths() {
    assert_eq!(
        strip_windows_verbatim_prefix(r"\\?\D:\code\qingcode"),
        r"D:\code\qingcode"
    );
    assert_eq!(strip_windows_verbatim_prefix(r"\\?\C:\"), r"C:\");
}

#[test]
fn strip_windows_verbatim_prefix_restores_unc_paths() {
    assert_eq!(
        strip_windows_verbatim_prefix(r"\\?\UNC\server\share\project"),
        r"\\server\share\project"
    );
    assert_eq!(
        strip_windows_verbatim_prefix(r"\\?\unc\server\share"),
        r"\\server\share"
    );
}

#[test]
fn strip_windows_verbatim_prefix_leaves_normal_paths_untouched() {
    assert_eq!(strip_windows_verbatim_prefix(r"D:\code"), r"D:\code");
    assert_eq!(
        strip_windows_verbatim_prefix("/home/dev/code"),
        "/home/dev/code"
    );
    assert_eq!(strip_windows_verbatim_prefix(""), "");
}

#[test]
fn resolve_script_command_rejects_empty_target() {
    let err = resolve_script_command("command", "  ", "", HashMap::new(), None).unwrap_err();
    assert!(err.contains("不能为空"), "err={err}");
}

#[test]
fn resolve_script_command_rejects_unknown_kind() {
    let err = resolve_script_command("ruby", "puts 1", "", HashMap::new(), None).unwrap_err();
    assert!(err.contains("不支持"), "err={err}");
}

#[test]
fn resolve_script_command_builds_ps1() {
    let mut env = HashMap::new();
    env.insert("FOO".to_string(), "1".to_string());
    let spec = resolve_script_command_with_locator(
        "ps1",
        r"D:\run\task.ps1",
        r"D:\work",
        env,
        None,
        &all_programs_available,
    )
    .unwrap();
    if cfg!(target_os = "windows") {
        assert_eq!(spec.program, "powershell.exe");
        assert_eq!(
            spec.args,
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                r"D:\run\task.ps1".to_string(),
            ]
        );
    } else {
        assert_eq!(spec.program, "pwsh");
        assert_eq!(
            spec.args,
            vec![
                "-NoProfile".to_string(),
                "-File".to_string(),
                r"D:\run\task.ps1".to_string(),
            ]
        );
    }
    assert_eq!(spec.cwd.as_deref(), Some(r"D:\work"));
    assert_eq!(spec.env, vec![("FOO".to_string(), "1".to_string())]);
}

#[test]
fn resolve_script_command_infers_kind_for_script() {
    let spec =
        resolve_script_command("script", "tools/setup.sh", "", HashMap::new(), None).unwrap();
    assert_eq!(spec.program, "bash");
    assert_eq!(spec.args, vec!["tools/setup.sh".to_string()]);
}

#[test]
fn resolve_script_command_builds_inline_command() {
    let spec =
        resolve_script_command("command", "echo hello", "C:\\tmp", HashMap::new(), None).unwrap();
    if cfg!(target_os = "windows") {
        assert_eq!(spec.program, "cmd.exe");
        assert_eq!(
            spec.args,
            vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "echo hello".to_string(),
            ]
        );
    } else {
        assert_eq!(spec.program, "bash");
        assert_eq!(spec.args, vec!["-c".to_string(), "echo hello".to_string()]);
    }
    assert_eq!(spec.cwd.as_deref(), Some("C:\\tmp"));
}

#[test]
fn resolve_script_command_builds_interactive_shell() {
    let spec = resolve_script_command_with_locator(
        "interactive",
        "opencode",
        "C:\\tmp",
        HashMap::new(),
        None,
        &all_programs_available,
    )
    .unwrap();
    if cfg!(target_os = "windows") {
        assert_eq!(spec.program, "pwsh.exe");
        assert_eq!(
            spec.args,
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                "& { opencode }".to_string(),
            ]
        );
    } else {
        assert_eq!(spec.program, "zsh");
        assert_eq!(
            spec.args,
            vec!["-lc".to_string(), "opencode; exec zsh".to_string()]
        );
    }
    assert_eq!(spec.cwd.as_deref(), Some("C:\\tmp"));
}

#[test]
fn resolve_interactive_shell_variants() {
    let pwsh =
        resolve_host_shell_with_locator(Some("pwsh"), Some("opencode"), &all_programs_available)
            .unwrap();
    assert_eq!(pwsh.program, shell_program_name("pwsh"));
    assert!(pwsh.args.iter().any(|a| a == "-NoExit"));

    if cfg!(target_os = "windows") {
        let cmd =
            resolve_host_shell_with_locator(Some("cmd"), Some("opencode"), &all_programs_available)
                .unwrap();
        assert_eq!(cmd.program, "cmd.exe");
        assert_eq!(cmd.args, vec!["/d", "/k", "opencode"]);

        let wsl =
            resolve_host_shell_with_locator(Some("wsl"), Some("opencode"), &all_programs_available)
                .unwrap();
        assert_eq!(wsl.program, "wsl.exe");
        assert_eq!(wsl.args, vec!["-e", "bash", "-lc", "opencode; exec bash"]);

        let bare =
            resolve_host_shell_with_locator(Some("wsl"), None, &all_programs_available).unwrap();
        assert_eq!(bare.program, "wsl.exe");
        assert_eq!(default_host_shell(), "auto");
    } else {
        assert!(
            resolve_host_shell_with_locator(Some("wsl"), Some("x"), &all_programs_available,)
                .is_err()
        );
        assert!(
            resolve_host_shell_with_locator(Some("cmd"), Some("x"), &all_programs_available,)
                .is_err()
        );
        let zsh =
            resolve_host_shell_with_locator(Some("zsh"), Some("opencode"), &all_programs_available)
                .unwrap();
        assert_eq!(zsh.program, "zsh");
        assert_eq!(zsh.args, vec!["-lc", "opencode; exec zsh"]);
        assert_eq!(default_host_shell(), "zsh");
        assert_eq!(
            resolve_host_shell_with_locator(None, None, &all_programs_available)
                .unwrap()
                .program,
            "zsh"
        );
    }
}

#[test]
fn windows_auto_shell_falls_back_in_order() {
    if !cfg!(target_os = "windows") {
        return;
    }
    let only_windows_powershell = |program: &str| {
        (program == "powershell.exe").then(|| r"C:\Windows\powershell.exe".to_string())
    };
    let resolved =
        resolve_host_shell_with_locator(Some("auto"), None, &only_windows_powershell).unwrap();
    assert_eq!(resolved.id, "powershell");
    assert_eq!(resolved.fallback_from.as_deref(), Some("auto"));

    let only_cmd =
        |program: &str| (program == "cmd.exe").then(|| r"C:\Windows\cmd.exe".to_string());
    let legacy = resolve_host_shell_with_locator(Some("pwsh"), None, &only_cmd).unwrap();
    assert_eq!(legacy.id, "cmd");
    assert_eq!(legacy.fallback_from.as_deref(), Some("pwsh"));
}

#[test]
fn interactive_powershell_profile_does_not_fall_back_to_cmd() {
    if !cfg!(target_os = "windows") {
        return;
    }
    let only_cmd =
        |program: &str| (program == "cmd.exe").then(|| r"C:\Windows\cmd.exe".to_string());
    let err =
        resolve_host_shell_with_locator(Some("pwsh"), Some("opencode"), &only_cmd).unwrap_err();
    assert!(err.contains("未自动改用 CMD"), "err={err}");
}

#[test]
fn explicit_missing_shell_has_actionable_error() {
    let err = resolve_host_shell_with_locator(Some("bash"), None, &|_| None).unwrap_err();
    assert!(err.contains("Bash"), "err={err}");
    assert!(err.contains("设置"), "err={err}");

    let script_err =
        resolve_script_command_with_locator("ps1", "build.ps1", "", HashMap::new(), None, &|_| {
            None
        })
        .unwrap_err();
    assert!(script_err.contains("需要 PowerShell"), "err={script_err}");
}

#[test]
fn output_gate_blocks_reader_until_resumed() {
    let gate = super::OutputGate::default();
    gate.wait_until_resumed();
    gate.set_paused(true);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let reader_gate = gate.clone();
    let handle = std::thread::spawn(move || {
        reader_gate.wait_until_resumed();
        done_tx.send(()).unwrap();
    });
    assert!(done_rx
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());
    gate.set_paused(false);
    done_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    handle.join().unwrap();
}

#[test]
fn should_emit_terminal_exit_only_for_current_generation() {
    assert!(should_emit_terminal_exit(Some(3), 3));
    assert!(!should_emit_terminal_exit(Some(4), 3));
    assert!(!should_emit_terminal_exit(None, 3));
}

#[test]
fn resolve_exit_code_defaults_to_one() {
    assert_eq!(resolve_exit_code(Some(0)), 0);
    assert_eq!(resolve_exit_code(Some(42)), 42);
    assert_eq!(resolve_exit_code(None), 1);
}

#[test]
fn clamp_pty_size_bounds() {
    let size = clamp_pty_size(120, 40);
    assert_eq!(size.cols, 120);
    assert_eq!(size.rows, 40);
    let min = clamp_pty_size(0, 0);
    assert_eq!(min.cols, 2);
    assert_eq!(min.rows, 1);
    let max = clamp_pty_size(u16::MAX, u16::MAX);
    assert_eq!(max.cols, 1000);
    assert_eq!(max.rows, 500);
}

#[test]
fn console_noise_process_names() {
    assert!(is_console_noise_process("conhost.exe"));
    assert!(is_console_noise_process("OpenConsole"));
    assert!(is_console_noise_process("wslhost.exe"));
    assert!(!is_console_noise_process("opencode.exe"));
    assert!(!is_console_noise_process("node"));
}

#[test]
fn meaningful_descendants_ignore_console_host_but_count_its_children() {
    let idle = [(10, None, "powershell.exe"), (11, Some(10), "conhost.exe")];
    assert_eq!(meaningful_descendant_count(&idle, 10), 0);

    let direct = [
        (10, None, "powershell.exe"),
        (11, Some(10), "conhost.exe"),
        (12, Some(10), "claude.exe"),
    ];
    assert_eq!(meaningful_descendant_count(&direct, 10), 1);

    // Some console apps are parented to conhost, not the shell.
    let nested = [
        (10, None, "powershell.exe"),
        (11, Some(10), "conhost.exe"),
        (12, Some(11), "claude.exe"),
    ];
    assert_eq!(meaningful_descendant_count(&nested, 10), 1);
}
