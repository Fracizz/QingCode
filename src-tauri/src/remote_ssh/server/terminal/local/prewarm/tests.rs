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
