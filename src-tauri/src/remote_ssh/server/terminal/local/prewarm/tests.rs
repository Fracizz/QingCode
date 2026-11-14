use super::*;

#[test]
fn automatic_count_keeps_one_idle_shell_and_manual_count_is_capped() {
    assert_eq!(resolve_count(&serde_json::json!("auto")), 1);
    assert_eq!(resolve_count(&serde_json::Value::Null), 1);
    for count in 0..=8 {
        assert_eq!(resolve_count(&serde_json::json!(count)), count);
    }
    assert_eq!(resolve_count(&serde_json::json!(100)), 8);
}

#[test]
fn memory_pressure_overrides_even_a_manual_pool_target() {
    assert!(under_pressure(8 * GIB, GIB / 2));
    assert!(under_pressure(64 * GIB, 6 * GIB));
    assert!(!under_pressure(64 * GIB, 8 * GIB));
    assert!(!under_pressure(0, 0));
}

#[test]
fn readiness_runs_after_profiles_without_disabling_them_or_typing_commands() {
    let powershell = ready_args("pwsh", vec!["-NoLogo".into()]);
    assert_eq!(&powershell[..3], &["-NoLogo", "-NoExit", "-Command"]);
    assert!(!powershell.iter().any(|arg| arg == "-NoProfile"));
    assert!(powershell[3].contains("$env:QINGCODE_PREWARM_PIPE"));
    assert!(powershell[3].contains("SetEnvironmentVariable"));
    assert_eq!(
        ready_args("cmd", vec![]),
        vec![
            "/K".to_string(),
            "@type nul > \"%QINGCODE_PREWARM_READY_FILE%\" & set QINGCODE_PREWARM_READY_FILE="
                .to_string()
        ]
    );
}

#[test]
fn remote_powershell_waits_for_a_hidden_startup_line_after_its_setup() {
    let mut launch = crate::remote_ssh::terminal_cmds::persistent_shell_launch(
        "/C:/work/project",
        Some("powershell"),
    )
    .unwrap();
    let (args, startup) = remote_ready_args(&launch);
    assert!(startup);
    assert_eq!(args.len(), launch.args.len());
    assert_eq!(
        &args[..args.len() - 1],
        &launch.args[..launch.args.len() - 1]
    );
    let script = args.last().unwrap();
    assert!(script.starts_with(launch.args.last().unwrap().as_str()));
    assert!(script.contains("[Console]::ReadKey($true)"));
    assert!(script.contains("FromBase64String"));
    assert!(!args.iter().any(|arg| arg == "-NoProfile"));

    launch.resolved_shell = "cmd".into();
    launch.args = vec!["/K".into(), "chcp 65001>nul".into()];
    assert_eq!(remote_ready_args(&launch), (launch.args.clone(), false));
}

#[test]
fn remote_startup_line_is_printable_base64_ending_with_enter() {
    use base64::Engine;
    assert_eq!(remote_startup_line(""), b"\r".to_vec());
    assert_eq!(remote_startup_line("   "), b"\r".to_vec());
    let line = remote_startup_line(" claude --resume; echo 中文 ");
    assert_eq!(line.last(), Some(&b'\r'));
    let body = &line[..line.len() - 1];
    assert!(body.iter().all(|byte| byte.is_ascii_graphic()));
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(body)
        .unwrap();
    assert_eq!(
        String::from_utf8(decoded).unwrap(),
        "claude --resume; echo 中文"
    );
}

#[test]
fn launch_key_separates_shell_arguments_environment_and_cwd() {
    let launch = PersistentLaunch {
        shell: Some("pwsh.exe".into()),
        args: vec!["-NoLogo".into()],
        env: BTreeMap::from([("PATH".into(), "original".into())]),
        name: None,
        resolved_shell: "pwsh".into(),
        fallback_from: None,
    };
    let cwd = std::env::temp_dir();
    let key = LaunchKey::new(&cwd.to_string_lossy(), &launch).unwrap();
    let mut changed = launch.clone();
    changed.env.insert("PATH".into(), "updated".into());
    assert!(key != LaunchKey::new(&cwd.to_string_lossy(), &changed).unwrap());
    changed = launch.clone();
    changed.args.push("-NoProfile".into());
    assert!(key != LaunchKey::new(&cwd.to_string_lossy(), &changed).unwrap());
    changed = launch;
    changed.shell = Some("cmd.exe".into());
    assert!(key != LaunchKey::new(&cwd.to_string_lossy(), &changed).unwrap());
    assert!(LaunchKey::new("this-directory-must-not-exist-qc-prewarm", &changed).is_err());
}

fn fake_shell() -> WarmShell {
    let launch = PersistentLaunch {
        shell: Some("pwsh.exe".into()),
        args: vec![],
        env: BTreeMap::new(),
        name: None,
        resolved_shell: "pwsh".into(),
        fallback_from: None,
    };
    WarmShell {
        id: "reserved-id".into(),
        pty_id: "pty-id".into(),
        key: LaunchKey::new(&std::env::temp_dir().to_string_lossy(), &launch).unwrap(),
        launch,
        remote: None,
        startup_pipe: None,
        startup_input: false,
        session: None,
        transport: None,
        reserved_at: None,
    }
}

#[test]
fn simultaneous_reservations_cannot_claim_the_same_shell_twice() {
    let pool = ShellPrewarmPool::default();
    let shell = fake_shell();
    let key = shell.key.clone();
    pool.0.lock().unwrap().shells.push(shell);
    let workers: Vec<_> = (0..16)
        .map(|_| {
            let pool = pool.clone();
            let key = key.clone();
            std::thread::spawn(move || pool.reserve_key(&key, false))
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap().ok())
            .count(),
        1
    );
    assert!(pool.take_key("reserved-id", &key).is_some());
    assert!(pool.take_key("reserved-id", &key).is_none());
}

#[test]
fn phone_reservations_are_claimed_under_the_phone_terminal_id() {
    let pool = ShellPrewarmPool::default();
    let shell = fake_shell();
    let key = shell.key.clone();
    pool.0.lock().unwrap().shells.push(shell);
    // 未预留的空闲项不能被改名领走。
    assert_eq!(
        pool.rename_reserved("reserved-id", "mobile-abc"),
        Err("empty")
    );
    assert_eq!(pool.reserve_key(&key, false).as_deref(), Ok("reserved-id"));
    assert!(pool.rename_reserved("reserved-id", "mobile-abc").is_ok());
    assert!(!pool.has_entry("reserved-id"));
    assert!(pool.take_key("reserved-id", &key).is_none());
    assert!(pool.take_key("mobile-abc", &key).is_some());
    // 预留后池被清空（重配或窗口移交）时按未命中处理。
    assert_eq!(
        pool.rename_reserved("mobile-abc", "mobile-def"),
        Err("empty")
    );
}

#[test]
fn stale_reservations_and_mismatched_launches_never_supply_a_shell() {
    let pool = ShellPrewarmPool::default();
    let mut shell = fake_shell();
    let key = shell.key.clone();
    shell.reserved_at = Some(Instant::now() - RESERVATION_TTL);
    pool.0.lock().unwrap().shells.push(shell);
    assert!(pool.take_key("reserved-id", &key).is_none());
    let mut different = key;
    different.args.push("-NoProfile".into());
    assert!(pool.reserve_key(&different, false).is_err());
}

#[test]
fn only_the_owning_window_can_invalidate_the_shared_pool() {
    let pool = ShellPrewarmPool::default();
    let shell = fake_shell();
    pool.0.lock().unwrap().target = Some(Target {
        project_path: "project".into(),
        key: shell.key.clone(),
        launch: shell.launch.clone(),
        count: 1,
        window: "main".into(),
        remote: None,
    });
    pool.0.lock().unwrap().shells.push(shell);
    pool.clear_window("secondary");
    assert_eq!(pool.0.lock().unwrap().shells.len(), 1);
    pool.clear_window("main");
    let state = pool.0.lock().unwrap();
    assert!(state.shells.is_empty());
    assert!(state.target.is_none());
    assert_eq!(state.generation, 1);
}

#[test]
fn status_and_reservation_reasons_are_scoped_to_the_target() {
    let pool = ShellPrewarmPool::default();
    let entry = fake_shell();
    let key = entry.key.clone();
    {
        let mut state = pool.0.lock().unwrap();
        state.target = Some(Target {
            project_path: "test".into(),
            key: key.clone(),
            launch: entry.launch.clone(),
            count: 2,
            window: "main".into(),
            remote: None,
        });
        state.shells.push(entry);
        state.preparing = true;
    }
    assert_eq!(pool.status("other")["ready"], 0);
    assert_eq!(pool.status("test")["ready"], 1);
    assert_eq!(pool.status("test")["preparing"], 1);
    let mut other = key.clone();
    other.shell = Some("cmd.exe".into());
    assert_eq!(pool.reserve_key(&other, false), Err("shell_mismatch"));
    assert_eq!(pool.reserve_key(&key, true), Err("startup_unsupported"));
    // 远端 PowerShell 预热项经 PTY 输入交付命令，也能领取配置终端。
    pool.0.lock().unwrap().shells[0].startup_input = true;
    assert!(pool.reserve_key(&key, true).is_ok());
    pool.0.lock().unwrap().shells[0].reserved_at = None;
    pool.0.lock().unwrap().shells[0].startup_input = false;
    assert!(pool.reserve_key(&key, false).is_ok());
    assert_eq!(pool.reserve_key(&key, false), Err("empty"));
    assert_eq!(pool.status("test")["reserved"], 1);
    assert_eq!(pool.status("test")["ready"], 0);
    pool.clear_window("main");
    assert_eq!(pool.status("test")["reason"], "no_target");
}

#[tokio::test]
async fn claiming_a_shell_wakes_the_refill_loop_immediately() {
    let pool = ShellPrewarmPool::default();
    let shell = fake_shell();
    let key = shell.key.clone();
    pool.0.lock().unwrap().shells.push(shell);
    assert!(pool.reserve_key(&key, false).is_ok());
    assert!(pool.take_key("reserved-id", &key).is_some());
    // 许可在领取时即保留，补充循环稍后才开始等待也能立刻醒来。
    tokio::time::timeout(Duration::from_millis(100), pool.2.notified())
        .await
        .expect("领取后未唤醒补充");
}

#[test]
fn remote_keys_follow_the_ssh_terminal_launch_and_never_match_local_paths() {
    let cwd = "ssh://conn-1/C:/Users/dev/app";
    let (launch, key) = remote_launch_key(cwd, None).unwrap();
    // 与 ssh_create_terminal 共用同一份启动参数解析。
    let expected =
        crate::remote_ssh::terminal_cmds::persistent_shell_launch("/C:/Users/dev/app", None)
            .unwrap();
    assert_eq!(launch.args, expected.args);
    assert!(key == LaunchKey::from_parts(cwd.into(), &expected));
    assert!(
        key != remote_launch_key("ssh://conn-2/C:/Users/dev/app", None)
            .unwrap()
            .1
    );
    assert!(key != remote_launch_key(cwd, Some("cmd")).unwrap().1);
    let local = LaunchKey::new(&std::env::temp_dir().to_string_lossy(), &launch).unwrap();
    assert!(key != local);
}

#[cfg(windows)]
#[tokio::test]
async fn powershell_runs_the_staged_profile_only_after_commit() {
    use std::process::Stdio;

    for commit in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let endpoint = IpcEndpoint::new(dir.path());
        let mut listener = endpoint.listen().unwrap().unwrap();
        let address = endpoint.describe();
        let output = dir.path().join("started.txt");
        let mut child = tokio::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                include_str!("start-profile.ps1"),
            ])
            .env(
                STARTUP_PIPE_ENV,
                address.strip_prefix(r"\\.\pipe\").unwrap(),
            )
            .env("QC_TEST_OUTPUT", &output)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        tokio::time::timeout(READY_TIMEOUT, async {
            let mut pipe = listener.accept().await.unwrap();
            stage_startup(
                &mut pipe,
                "[IO.File]::AppendAllText($env:QC_TEST_OUTPUT, '已启动')",
            )
            .await
            .unwrap();
            assert!(!output.exists());
            if commit {
                pipe.write_u8(1).await.unwrap();
                read_startup_ack(&mut pipe).await.unwrap();
            }
            drop(pipe);
            child.wait().await.unwrap();
        })
        .await
        .unwrap();
        if commit {
            assert_eq!(std::fs::read_to_string(output).unwrap(), "已启动");
        } else {
            assert!(!output.exists());
        }
    }
}

/// 真实 ConPTY：远端预热脚本在 profile 后读取一行，执行命令且不回显 base64；空行进入普通 Shell。
#[cfg(windows)]
#[test]
fn remote_powershell_runs_the_delivered_command_without_echoing_it() {
    use std::io::{Read, Write};
    use std::sync::mpsc;

    for command in [
        Some("[IO.File]::AppendAllText($env:QC_TEST_OUTPUT, '已启动')"),
        None,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("started.txt");
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut builder = portable_pty::CommandBuilder::new("powershell.exe");
        builder.args([
            "-NoProfile",
            "-NoLogo",
            "-Command",
            &format!(
                "{}; [IO.File]::AppendAllText($env:QC_TEST_OUTPUT, '|done')",
                include_str!("start-remote-profile.ps1")
            ),
        ]);
        builder.env("QC_TEST_OUTPUT", &output);
        let mut child = pair.slave.spawn_command(builder).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 || tx.send(buffer[..read].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut writer = pair.master.take_writer().unwrap();
        let line = remote_startup_line(command.unwrap_or_default());
        writer.write_all(&line).unwrap();
        writer.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !std::fs::read_to_string(&output).is_ok_and(|text| text.ends_with("|done")) {
            assert!(Instant::now() < deadline, "预热脚本未在时限内结束");
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        drop(writer);
        drop(pair.master);
        let echoed: Vec<u8> = rx.try_iter().flatten().collect();
        let expected = if command.is_some() {
            "已启动|done"
        } else {
            "|done"
        };
        assert_eq!(std::fs::read_to_string(&output).unwrap(), expected);
        let body = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
        if !body.is_empty() {
            assert!(!String::from_utf8_lossy(&echoed).contains(&body));
        }
    }
}
