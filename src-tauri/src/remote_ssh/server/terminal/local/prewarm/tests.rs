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
    let (args, startup) = remote_ready_args(&launch);
    assert!(!startup);
    assert!(args.last().unwrap().contains("-ready!"));
    assert!(directory_input(r"C:\work\%PATH%", RemoteInput::Cmd, "n").is_none());
}

#[test]
fn remote_startup_line_is_printable_base64_ending_with_enter() {
    use base64::Engine;
    assert_eq!(remote_input_line(""), b"\r".to_vec());

    let line = remote_input_line(" claude --resume; echo 中文 ");
    assert_eq!(line.last(), Some(&b'\r'));
    let body = &line[..line.len() - 1];
    assert!(body.iter().all(|byte| byte.is_ascii_graphic()));
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(body)
        .unwrap();
    assert_eq!(
        String::from_utf8(decoded).unwrap(),
        " claude --resume; echo 中文 "
    );
}

#[test]
fn launch_key_separates_host_shell_arguments_and_environment_but_not_cwd() {
    let launch = PersistentLaunch {
        shell: Some("pwsh.exe".into()),
        args: vec!["-NoLogo".into()],
        env: BTreeMap::from([("PATH".into(), "original".into())]),
        name: None,
        resolved_shell: "pwsh".into(),
        fallback_from: None,
    };
    let key = LaunchKey::from_parts(None, &launch);
    assert!(key != LaunchKey::from_parts(Some("conn-1".into()), &launch));
    let mut changed = launch.clone();
    changed.env.insert("PATH".into(), "updated".into());
    assert!(key != LaunchKey::from_parts(None, &changed));
    changed = launch.clone();
    changed.args.push("-NoProfile".into());
    assert!(key != LaunchKey::from_parts(None, &changed));
    changed = launch;
    changed.shell = Some("cmd.exe".into());
    assert!(key != LaunchKey::from_parts(None, &changed));
    assert!(local_launch_key("this-directory-must-not-exist-qc-prewarm", None).is_err());
}

const CWD: &str = r"C:\work\a";
const OTHER_CWD: &str = r"C:\work\b";

pub(super) fn fake_shell() -> WarmShell {
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
        key: LaunchKey::from_parts(None, &launch),
        cwd: CWD.into(),
        claim_cwd: false,
        launch,
        remote: None,
        codex: None,
        startup_pipe: None,
        startup_input: false,
        marker: String::new(),
        from_seq: 0,
        input_seq: AtomicU64::new(0),
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
            std::thread::spawn(move || pool.reserve_key(&key, CWD, false))
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap().ok())
            .count(),
        1
    );
    assert!(pool.take_key("reserved-id", &key, CWD, true).is_some());
    assert!(pool.take_key("reserved-id", &key, CWD, true).is_none());
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
    assert_eq!(
        pool.reserve_key(&key, CWD, false).as_deref(),
        Ok("reserved-id")
    );
    assert!(pool.rename_reserved("reserved-id", "mobile-abc").is_ok());
    assert!(!pool.has_entry("reserved-id"));
    assert!(pool.take_key("reserved-id", &key, CWD, true).is_none());
    assert!(pool.take_key("mobile-abc", &key, CWD, true).is_some());
    // 预留后池被清空（重配或窗口移交）时按未命中处理。
    assert_eq!(
        pool.rename_reserved("mobile-abc", "mobile-def"),
        Err("empty")
    );
}

#[test]
fn restart_reservations_never_hold_two_shells_under_one_tab_id() {
    let pool = ShellPrewarmPool::default();
    let key = fake_shell().key.clone();
    pool.0
        .lock()
        .unwrap()
        .shells
        .extend([fake_shell(), with_id(fake_shell(), "second")]);
    let first = pool.reserve_key(&key, CWD, false).unwrap();
    assert!(pool.rename_reserved(&first, "tab-1").is_ok());
    // 同一标签再次重启（上次预留未领取）时，第二个空闲项放回池中。
    let second = pool.reserve_key(&key, CWD, false).unwrap();
    assert_eq!(pool.rename_reserved(&second, "tab-1"), Err("id_in_use"));
    assert_eq!(
        pool.reserve_key(&key, CWD, false).as_deref(),
        Ok(second.as_str())
    );
    assert!(pool.take_key("tab-1", &key, CWD, true).is_some());
    assert!(pool.take_key("tab-1", &key, CWD, true).is_none());
}

#[test]
fn stale_reservations_and_mismatched_launches_never_supply_a_shell() {
    let pool = ShellPrewarmPool::default();
    let mut shell = fake_shell();
    let key = shell.key.clone();
    shell.reserved_at = Some(Instant::now() - RESERVATION_TTL);
    pool.0.lock().unwrap().shells.push(shell);
    assert!(pool.take_key("reserved-id", &key, CWD, true).is_none());
    let mut different = key;
    different.args.push("-NoProfile".into());
    assert!(pool.reserve_key(&different, CWD, false).is_err());
}

#[test]
fn reservations_allow_one_extra_refill_and_survive_directory_changes() {
    let mut state = PoolState::default();
    let mut entry = fake_shell();
    let mut target = target_for(&entry, 1);
    target.cwd = OTHER_CWD.into();
    entry.reserved_at = Some(Instant::now());
    state.shells.push(entry);
    assert_eq!(state.refill_slots(1), 1);
    state.shells.push(with_id(fake_shell(), "old-idle"));
    assert_eq!(state.refill_slots(1), 0);
    state.trim_idle(&target);
    assert_eq!(state.shells.len(), 1);
    assert!(state.shells[0].reserved_at.is_some());
    let mut second = with_id(fake_shell(), "second");
    second.reserved_at = Some(Instant::now());
    state.shells.push(second);
    assert_eq!(state.refill_slots(1), 0);
}

#[test]
fn only_the_owning_window_can_invalidate_the_shared_pool() {
    let pool = ShellPrewarmPool::default();
    let shell = fake_shell();
    pool.0.lock().unwrap().target = Some(Target {
        project_path: "project".into(),
        cwd: CWD.into(),
        key: shell.key.clone(),
        launch: shell.launch.clone(),
        count: 1,
        window: "main".into(),
        remote: None,
    });
    pool.0.lock().unwrap().shells.push(shell);
    pool.focus_window("main");
    pool.clear_window("secondary");
    assert_eq!(pool.0.lock().unwrap().shells.len(), 1);
    pool.clear_window("main");
    let state = pool.0.lock().unwrap();
    assert!(state.shells.is_empty());
    assert!(state.target.is_none());
    assert_eq!(state.generation, 1);
}

#[test]
fn focus_ownership_survives_disable_and_rejects_old_windows_after_handoff() {
    let pool = ShellPrewarmPool::default();
    pool.focus_window("main");
    pool.clear_window("main");
    assert!(pool.lock_for_window("main").is_some());
    pool.focus_window("secondary");
    assert!(pool.lock_for_window("main").is_none());
    pool.clear_window("main");
    pool.close_window("main");
    assert!(pool.lock_for_window("secondary").is_some());
    pool.close_window("secondary");
    assert!(pool.lock_for_window("secondary").is_none());
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
            cwd: CWD.into(),
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
    assert_eq!(pool.reserve_key(&other, CWD, false), Err("shell_mismatch"));
    let mut remote = key.clone();
    remote.host = Some("conn-1".into());
    assert_eq!(pool.reserve_key(&remote, CWD, false), Err("host_mismatch"));
    assert_eq!(
        pool.reserve_key(&key, CWD, true),
        Err("startup_unsupported")
    );
    // 没有启动通道（CMD 或旧宿主）就不能切换目录，只能原目录领取。
    assert_eq!(
        pool.reserve_key(&key, OTHER_CWD, false),
        Err("cwd_mismatch")
    );
    // 远端 PowerShell 预热项经 PTY 输入交付命令，也能领取配置终端。
    pool.0.lock().unwrap().shells[0].startup_input = true;
    assert!(pool.reserve_key(&key, CWD, true).is_ok());
    pool.0.lock().unwrap().shells[0].reserved_at = None;
    pool.0.lock().unwrap().shells[0].startup_input = false;
    assert!(pool.reserve_key(&key, CWD, false).is_ok());
    assert_eq!(pool.reserve_key(&key, CWD, false), Err("all_reserved"));
    assert_eq!(pool.status("test")["reserved"], 1);
    assert_eq!(pool.status("test")["ready"], 0);
    pool.focus_window("main");
    pool.clear_window("main");
    assert_eq!(pool.status("test")["reason"], "no_target");
}

#[tokio::test]
async fn claiming_a_shell_wakes_the_refill_loop_immediately() {
    let pool = ShellPrewarmPool::default();
    let shell = fake_shell();
    let key = shell.key.clone();
    pool.0.lock().unwrap().shells.push(shell);
    assert!(pool.reserve_key(&key, CWD, false).is_ok());
    tokio::time::timeout(Duration::from_millis(100), pool.2.notified())
        .await
        .expect("预留后未唤醒补充");
    assert!(pool.take_key("reserved-id", &key, CWD, true).is_some());
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
    assert!(key == LaunchKey::from_parts(Some("conn-1".into()), &expected));
    // 同一连接上的其他项目共用预热项；换连接、换 Shell 或本机都不命中。
    assert!(
        key == remote_launch_key("ssh://conn-1/C:/Users/dev/other", None)
            .unwrap()
            .1
    );
    assert!(
        key != remote_launch_key("ssh://conn-2/C:/Users/dev/app", None)
            .unwrap()
            .1
    );
    assert!(key != remote_launch_key(cwd, Some("cmd")).unwrap().1);
    assert!(key != LaunchKey::from_parts(None, &launch));
}

pub(super) fn remote_shell(id: &str, cwd: &str, claim_cwd: bool) -> WarmShell {
    let (launch, key) = remote_launch_key(cwd, None).unwrap();
    let path = parse_remote_uri(cwd).unwrap().path;
    WarmShell {
        id: id.into(),
        pty_id: format!("pty-{id}"),
        key,
        cwd: cwd.into(),
        claim_cwd,
        launch,
        remote: Some(RemoteTarget {
            root: RegisteredRoot {
                uri: cwd.into(),
                canonical_path: path.clone(),
                trusted: true,
            },
            connection_id: parse_remote_uri(cwd).unwrap().connection_id,
            daemon: server::DaemonAccess {
                bin: String::new(),
                token: String::new(),
            },
            incarnation: None,
            direct_peer: None,
        }),
        codex: None,
        startup_pipe: None,
        startup_input: true,
        marker: String::new(),
        from_seq: 0,
        input_seq: AtomicU64::new(0),
        session: None,
        transport: None,
        reserved_at: None,
    }
}

#[test]
fn same_connection_shells_move_to_other_projects_only_when_the_daemon_can_rebind() {
    let project_a = "ssh://conn-1/C:/work/a";
    let project_b = "ssh://conn-1/C:/work/b";
    let pool = ShellPrewarmPool::default();
    pool.0
        .lock()
        .unwrap()
        .shells
        .push(remote_shell("warm-a", project_a, false));
    let key = remote_launch_key(project_b, None).unwrap().1;
    // 旧 daemon 不能改记 PTY 目录：接回时会被项目根校验拒绝，不能跨项目领取。
    assert_eq!(
        pool.reserve_key(&key, project_b, false),
        Err("cwd_mismatch")
    );
    pool.0.lock().unwrap().shells[0].claim_cwd = true;
    assert_eq!(
        pool.reserve_key(&key, project_b, true).as_deref(),
        Ok("warm-a")
    );
    // 调用方给不出可切换的目录时只认原目录。
    assert!(pool.take_key("warm-a", &key, project_b, false).is_none());
    assert!(pool.take_key("warm-a", &key, project_b, true).is_some());
}

pub(super) fn target_for(shell: &WarmShell, count: usize) -> Target {
    Target {
        project_path: shell.cwd.clone(),
        cwd: shell.cwd.clone(),
        key: shell.key.clone(),
        launch: shell.launch.clone(),
        count,
        window: "main".into(),
        remote: shell.remote.clone(),
    }
}

pub(super) fn with_id(mut shell: WarmShell, id: &str) -> WarmShell {
    shell.id = id.into();
    shell
}

#[test]
fn a_shell_already_in_the_target_directory_is_preferred() {
    let project_a = "ssh://conn-1/C:/work/a";
    let project_b = "ssh://conn-1/C:/work/b";
    let pool = ShellPrewarmPool::default();
    pool.0.lock().unwrap().shells.extend([
        remote_shell("warm-a", project_a, true),
        remote_shell("warm-b", project_b, true),
    ]);
    let key = remote_launch_key(project_b, None).unwrap().1;
    assert_eq!(
        pool.reserve_key(&key, project_b, false).as_deref(),
        Ok("warm-b")
    );
    assert_eq!(
        pool.reserve_key(&key, project_b, false).as_deref(),
        Ok("warm-a")
    );
}

#[test]
fn claim_script_switches_directory_before_the_configured_command() {
    assert_eq!(claim_script(None, None), None);
    assert_eq!(
        claim_script(None, Some("npm run dev")).as_deref(),
        Some("npm run dev")
    );
    assert_eq!(
        claim_script(Some(r"C:\work\it's"), None).as_deref(),
        Some(r"Set-Location -LiteralPath 'C:\work\it''s'")
    );
    // 配置命令单独解析：语法错误也不影响已切换的目录。
    assert_eq!(
        claim_script(Some(r"C:\work"), Some("echo 'hi'")).as_deref(),
        Some(r"Set-Location -LiteralPath 'C:\work'; & ([ScriptBlock]::Create('echo ''hi'''))")
    );
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

/// 真实 PowerShell：预热项领取到其他目录时先切换目录（含单引号的路径），配置命令在新目录
/// 运行，语法错误的配置命令也不影响切换，之后的提示符停留在新目录。
#[cfg(windows)]
#[tokio::test]
async fn powershell_switches_to_the_claiming_project_before_its_command() {
    use std::process::Stdio;

    for startup in [
        Some("[IO.File]::AppendAllText($env:QC_TEST_OUTPUT, (Get-Location).ProviderPath)"),
        Some("if ("),
        None,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("it's project");
        std::fs::create_dir(&project).unwrap();
        let project = crate::terminal::strip_windows_verbatim_prefix(
            &std::fs::canonicalize(&project).unwrap().to_string_lossy(),
        )
        .into_owned();
        let endpoint = IpcEndpoint::new(dir.path());
        let mut listener = endpoint.listen().unwrap().unwrap();
        let address = endpoint.describe();
        let output = dir.path().join("started.txt");
        let mut child = tokio::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "{}; [IO.File]::AppendAllText($env:QC_TEST_OUTPUT, '|' + (Get-Location).ProviderPath)",
                    include_str!("start-profile.ps1")
                ),
            ])
            .current_dir(dir.path())
            .env(
                STARTUP_PIPE_ENV,
                address.strip_prefix(r"\\.\pipe\").unwrap(),
            )
            .env("QC_TEST_OUTPUT", &output)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let script = claim_script(Some(&project), startup).unwrap();
        tokio::time::timeout(READY_TIMEOUT, async {
            let mut pipe = listener.accept().await.unwrap();
            stage_startup(&mut pipe, &script).await.unwrap();
            pipe.write_u8(1).await.unwrap();
            read_startup_ack(&mut pipe).await.unwrap();
            drop(pipe);
            child.wait().await.unwrap();
        })
        .await
        .unwrap();
        let expected = match startup {
            Some(command) if command.starts_with("[IO") => format!("{project}|{project}"),
            _ => format!("|{project}"),
        };
        assert_eq!(std::fs::read_to_string(output).unwrap(), expected);
    }
}

/// Drive the two-stage handoff through an isolated daemon and real Windows ConPTY.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn remote_shells_enter_each_claiming_project_before_running_commands() {
    use qingcode_server::daemon::{DaemonOptions, RunDir};
    let dir = tempfile::tempdir().unwrap();
    let run_dir = RunDir::resolve(Some(dir.path())).unwrap();
    let options = DaemonOptions {
        state_dir: Some(dir.path().into()),
        ..Default::default()
    };
    let daemon = tokio::spawn(qingcode_server::daemon::run_async(options));
    tokio::time::timeout(READY_TIMEOUT, async {
        while !run_dir.ready_marker().exists() || run_dir.read_token().is_err() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut ready = Vec::new();
    for shell in ["powershell", "powershell", "cmd", "powershell"] {
        let entry = remote_shell("test", "ssh://conn-1/D:/anchor", true);
        let mut target = target_for(&entry, 2);
        (target.launch, target.key) = remote_launch_key(&target.project_path, Some(shell)).unwrap();
        target.cwd.clear();
        let stream = qingcode_server::connect::connect_async(&IpcEndpoint::new(run_dir.dir()))
            .await
            .unwrap();
        let session =
            DaemonSession::open_local(stream, "test:windev", run_dir.read_token().unwrap())
                .await
                .unwrap();
        let start = Instant::now();
        let entry = prepare_remote_shell(
            &target,
            target.remote.as_ref().unwrap(),
            SessionTransport::Local,
            session,
            None,
        )
        .await
        .unwrap();
        println!("{shell} create-to-ready {:?}", start.elapsed());
        ready.push(entry);
    }
    for (i, mut entry) in ready.into_iter().enumerate() {
        let path = dir.path().join(format!("项目 [{i}] & test"));
        std::fs::create_dir(&path).unwrap();
        let cwd = path.to_str().unwrap();
        let mode = entry.input_mode().unwrap();
        let session = entry.session.as_mut().unwrap();
        let start = Instant::now();
        if i == 3 {
            let missing = path.join("missing");
            assert!(session
                .enter_prewarm_directory(
                    &entry.pty_id,
                    &entry.input_seq,
                    &entry.marker,
                    remote_input_line(missing.to_str().unwrap())
                )
                .await
                .is_err());
            continue;
        }
        let from_seq = session
            .enter_prewarm_directory(
                &entry.pty_id,
                &entry.input_seq,
                &entry.marker,
                directory_input(cwd, mode, &entry.marker).unwrap(),
            )
            .await
            .unwrap();
        session
            .request(
                "pty.claim",
                &serde_json::json!({"id":entry.pty_id, "cwd":cwd}),
            )
            .await
            .unwrap();
        let attach = session.attach(&entry.pty_id, from_seq, true).await.unwrap();
        let input_seq = AtomicU64::new(attach.response["nextInputSeq"].as_u64().unwrap());
        let write = |line| send_input_to_session(session, &entry.pty_id, &input_seq, line);
        let command = "[IO.File]::AppendAllText((Join-Path $PWD 'once.txt'), 'X')";
        if entry.startup_input {
            write(remote_input_line(if i == 0 { command } else { "" }))
                .await
                .unwrap();
            if i != 0 {
                write(format!("{command}\r").into_bytes()).await.unwrap();
            }
        } else {
            write(b"@echo X>once.txt\r".to_vec()).await.unwrap();
        }
        let file = path.join("once.txt");
        tokio::time::timeout(READY_TIMEOUT, async {
            while !std::fs::read_to_string(&file).is_ok_and(|v| v.trim() == "X") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("command must execute once in the claiming project");
        println!(
            "{} claim-to-output {:?}",
            entry.launch.resolved_shell,
            start.elapsed()
        );
        session
            .request("pty.kill", &serde_json::json!({"id":entry.pty_id}))
            .await
            .unwrap();
    }
    // Compare a plain terminal from pty.create to the same first filesystem effect.
    let (launch, _) = remote_launch_key("ssh://conn-1/D:/anchor", Some("powershell")).unwrap();
    let stream = qingcode_server::connect::connect_async(&IpcEndpoint::new(run_dir.dir()))
        .await
        .unwrap();
    let session = DaemonSession::open_local(stream, "test:windev", run_dir.read_token().unwrap())
        .await
        .unwrap();
    let start = Instant::now();
    let created = session
        .request(
            "pty.create",
            &serde_json::json!({
                "cwd":dir.path(), "shell":launch.shell, "args":launch.args, "cols":120, "rows":30,
            }),
        )
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    send_input_to_session(
        &session,
        id,
        &AtomicU64::new(0),
        b"[IO.File]::AppendAllText((Join-Path $PWD 'cold.txt'), 'X')\r".to_vec(),
    )
    .await
    .unwrap();
    tokio::time::timeout(READY_TIMEOUT, async {
        while !std::fs::read_to_string(dir.path().join("cold.txt")).is_ok_and(|v| v == "X") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    println!("powershell cold-create-to-output {:?}", start.elapsed());
    session
        .request("pty.kill", &serde_json::json!({"id":id}))
        .await
        .unwrap();
    session.shutdown();
    daemon.abort();
}

#[test]
fn posix_remotes_prewarm_bash_zsh_sh_and_the_login_shell() {
    let launch = |shell| {
        crate::remote_ssh::terminal_cmds::persistent_shell_launch("/srv/app", Some(shell)).unwrap()
    };
    let mode = |shell| RemoteInput::for_launch("/srv/app", &launch(shell), false);
    assert_eq!(mode("bash"), Some(RemoteInput::Posix(PosixShell::Builtin)));
    assert_eq!(mode("zsh"), Some(RemoteInput::Posix(PosixShell::Builtin)));
    assert_eq!(mode("sh"), Some(RemoteInput::Posix(PosixShell::Plain)));
    // 「自动」由 daemon 启动登录用户的 $SHELL，只用各家通用的写法。
    assert_eq!(mode("auto"), Some(RemoteInput::Posix(PosixShell::Plain)));
    assert!(launch("auto").shell.is_none());
    // POSIX 不改启动参数，rc 照常加载。
    assert!(launch("bash").args.is_empty());
    let mut unknown = launch("bash");
    unknown.resolved_shell = "nu".into();
    assert_eq!(RemoteInput::for_launch("/srv/app", &unknown, false), None);
    // Windows 远端仍只支持 PowerShell 与 CMD。
    assert_eq!(
        RemoteInput::for_launch("/C:/work", &launch("bash"), false),
        None
    );
}

#[test]
fn posix_directory_and_startup_lines_are_single_quoted_and_skip_history() {
    let mode = RemoteInput::Posix(PosixShell::Builtin);
    let line = directory_input("/srv/it's a [dir] & $HOME", mode, "abc").unwrap();
    assert_eq!(
        String::from_utf8(line).unwrap(),
        concat!(
            " builtin cd '/srv/it'\\''s a [dir] & $HOME'",
            " && builtin printf 'QC-%s-cwd!\\n' 'abc'",
            " || builtin printf 'QC-%s-error!\\n' 'abc'\r"
        )
    );
    let plain = directory_input("/srv/a", RemoteInput::Posix(PosixShell::Plain), "abc").unwrap();
    assert!(String::from_utf8(plain)
        .unwrap()
        .starts_with(" cd '/srv/a' && printf "));
    assert!(directory_input("/srv/a\nrm -rf ~", mode, "abc").is_none());
    assert!(directory_input("relative", mode, "abc").is_none());
    // 格式串与 nonce 分开写：回显的命令行不含完整标记。
    let ready = String::from_utf8(posix_ready_input(PosixShell::Builtin, "abc")).unwrap();
    assert!(ready.starts_with(' ') && ready.ends_with('\r'));
    assert!(!ready.contains("QC-abc-ready!"));

    // 普通终端接回后不输入任何内容；配置命令须为单行。
    assert_eq!(startup_input_line("", mode), Some(Vec::new()));
    assert_eq!(
        startup_input_line("claude --resume", mode),
        Some(b"claude --resume\r".to_vec())
    );
    assert!(startup_input_line("echo a\necho b", mode).is_none());
    // CMD 只接普通终端。
    assert!(startup_input_line("dir", RemoteInput::Cmd).is_none());
    assert!(startup_input_line("", RemoteInput::Cmd).is_some());
}

#[test]
fn posix_remote_shells_can_move_to_another_project_and_take_startup_commands() {
    let project_a = "ssh://linux/srv/a";
    let project_b = "ssh://linux/srv/b";
    let pool = ShellPrewarmPool::default();
    let mut entry = remote_shell("warm", project_a, true);
    entry.startup_input = false;
    (entry.launch, entry.key) = remote_launch_key(project_a, Some("bash")).unwrap();
    assert!(entry.can_rebind());
    assert!(entry.has_startup_channel());
    let key = entry.key.clone();
    pool.0.lock().unwrap().shells.push(entry);
    assert!(pool.reserve_key(&key, project_b, true).is_ok());

    // daemon 不支持改记目录时不能跨项目领取。
    let mut old = remote_shell("old", project_a, false);
    (old.launch, old.key) = remote_launch_key(project_a, Some("bash")).unwrap();
    assert!(!old.can_rebind());
}

/// 真实 daemon + bash：预热、进入领取项目、接回后命令只执行一次。
/// Windows 的 daemon 只托管 PowerShell / CMD，此用例只在 POSIX 主机上运行。
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn posix_remote_shell_enters_the_claiming_project_before_running_the_command() {
    use qingcode_server::daemon::{DaemonOptions, RunDir};
    let dir = tempfile::tempdir().unwrap();
    let run_dir = RunDir::resolve(Some(dir.path())).unwrap();
    let options = DaemonOptions {
        state_dir: Some(dir.path().into()),
        ..Default::default()
    };
    let daemon = tokio::spawn(qingcode_server::daemon::run_async(options));
    tokio::time::timeout(READY_TIMEOUT, async {
        while !run_dir.ready_marker().exists() || run_dir.read_token().is_err() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let anchor = format!("ssh://conn-1{}", dir.path().display());
    let mut ready = Vec::new();
    for shell in ["bash", "sh", "bash"] {
        let mut entry = remote_shell("test", &anchor, true);
        entry.startup_input = false;
        let mut target = target_for(&entry, 2);
        (target.launch, target.key) = remote_launch_key(&anchor, Some(shell)).unwrap();
        target.cwd.clear();
        let stream = qingcode_server::connect::connect_async(&IpcEndpoint::new(run_dir.dir()))
            .await
            .unwrap();
        let session =
            DaemonSession::open_local(stream, "test:posix", run_dir.read_token().unwrap())
                .await
                .unwrap();
        let start = Instant::now();
        let entry = prepare_remote_shell(
            &target,
            target.remote.as_ref().unwrap(),
            SessionTransport::Local,
            session,
            None,
        )
        .await
        .unwrap();
        println!("{shell} create-to-ready {:?}", start.elapsed());
        ready.push(entry);
    }
    for (i, mut entry) in ready.into_iter().enumerate() {
        let path = dir.path().join(format!("项目 [{i}] & it's"));
        std::fs::create_dir(&path).unwrap();
        let cwd = path.to_str().unwrap().to_string();
        let mode = entry.input_mode().unwrap();
        let marker = entry.marker.clone();
        let session = entry.session.as_mut().unwrap();
        if i == 2 {
            let missing = directory_input(&format!("{cwd}/missing"), mode, &marker).unwrap();
            assert!(session
                .enter_prewarm_directory(&entry.pty_id, &entry.input_seq, &marker, missing)
                .await
                .is_err());
            continue;
        }
        let start = Instant::now();
        let line = directory_input(&cwd, mode, &marker).unwrap();
        let from_seq = session
            .enter_prewarm_directory(&entry.pty_id, &entry.input_seq, &marker, line)
            .await
            .unwrap();
        session
            .request(
                "pty.claim",
                &serde_json::json!({"id":entry.pty_id, "cwd":cwd}),
            )
            .await
            .unwrap();
        let attach = session.attach(&entry.pty_id, from_seq, true).await.unwrap();
        let input_seq = AtomicU64::new(attach.response["nextInputSeq"].as_u64().unwrap());
        let line = startup_input_line("printf X >> once.txt", mode).unwrap();
        send_input_to_session(session, &entry.pty_id, &input_seq, line)
            .await
            .unwrap();
        let file = path.join("once.txt");
        tokio::time::timeout(READY_TIMEOUT, async {
            while !std::fs::read_to_string(&file).is_ok_and(|v| v == "X") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("command must execute once in the claiming project");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "X");
        println!(
            "{} claim-to-output {:?}",
            entry.launch.resolved_shell,
            start.elapsed()
        );
        session
            .request("pty.kill", &serde_json::json!({"id":entry.pty_id}))
            .await
            .unwrap();
    }
    daemon.abort();
}

#[test]
fn profile_requires_same_connection_project_profile_shell_and_command() {
    let cwd = "ssh://win/D:/work/a";
    let pool = ShellPrewarmPool::default();
    let mut entry = remote_shell("prepared", cwd, true);
    entry.key.profile = Some(PrewarmProfile {
        cross_project: true,
        cwd: cwd.into(),
        shell: "auto".into(),
        profile_id: "agent".into(),
        command: "claude".into(),
        count: 1,
    });
    assert!(!entry.can_rebind());
    {
        let mut state = pool.0.lock().unwrap();
        state.target = Some(target_for(&entry, 1));
        state.shells.push(entry);
    }
    for (path, shell, id, cmd) in [
        ("ssh://other/D:/work/a", "auto", "agent", "claude"),
        ("ssh://win/D:/work/b", "auto", "agent", "claude"),
        (cwd, "cmd", "agent", "claude"),
        (cwd, "auto", "other", "claude"),
        (cwd, "auto", "agent", "claude --resume"),
    ] {
        assert!(pool.reserve_profile(path, Some(shell), id, cmd).is_none());
    }
    assert!(pool.reserve(cwd, Some("auto"), true).is_err());
    assert_eq!(
        pool.reserve_profile(cwd, Some("auto"), "agent", "claude")
            .as_deref(),
        Some("prepared")
    );
    assert!(pool
        .reserve_profile(cwd, Some("auto"), "agent", "claude")
        .is_none());
}

#[test]
fn phone_claims_prepared_profile_under_its_own_terminal_id() {
    let cwd = "ssh://win/D:/work/a";
    let pool = ShellPrewarmPool::default();
    let mut entry = remote_shell("prepared", cwd, true);
    entry.key.profile = Some(PrewarmProfile {
        cross_project: true,
        cwd: cwd.into(),
        shell: "auto".into(),
        profile_id: "agent".into(),
        command: "claude".into(),
        count: 1,
    });
    {
        let mut state = pool.0.lock().unwrap();
        state.target = Some(target_for(&entry, 1));
        state.shells.push(entry);
    }
    assert!(!pool.reserve_profile_as("mobile-1", cwd, Some("auto"), "other", "claude"));
    assert!(!pool.has_entry("mobile-1"));
    assert!(pool.reserve_profile_as("mobile-1", cwd, Some("auto"), "agent", "claude"));
    assert!(pool.has_entry("mobile-1"));
    assert!(!pool.has_entry("prepared"));
    assert!(!pool.reserve_profile_as("mobile-2", cwd, Some("auto"), "agent", "claude"));
}

#[test]
fn connection_profile_count_sets_cli_slots_and_resizing_keeps_ready_clis() {
    let cwd = "ssh://win/D:/work/a";
    let profile = |count: usize| PrewarmProfile {
        cross_project: true,
        cwd: cwd.into(),
        shell: "auto".into(),
        profile_id: "agent".into(),
        command: "claude".into(),
        count,
    };
    // 数量只决定容量：不同数量的同一配置仍是同一个复用键，越界值收敛到 1..=4。
    assert!(profile(1) == profile(3));
    assert_eq!(profile(0).pool_count(), 1);
    assert_eq!(profile(9).pool_count(), MAX_PROFILE_COUNT);
    let pool = ShellPrewarmPool::default();
    let prepared = |id: &str| {
        let mut entry = remote_shell(id, cwd, true);
        entry.key.profile = Some(profile(2));
        entry
    };
    {
        let mut state = pool.0.lock().unwrap();
        state.target = Some(target_for(&prepared("one"), 2));
        state.shells.push(prepared("one"));
        // 两个名额只就绪一个时还要再补一个。
        assert_eq!(state.refill_slots(2), 1);
        state.shells.push(prepared("two"));
        assert_eq!(state.refill_slots(2), 0);
    }
    // 连续新建两个同配置终端，两次都领到预热的 CLI。
    assert_eq!(
        pool.reserve_profile(cwd, Some("auto"), "agent", "claude")
            .as_deref(),
        Some("one")
    );
    assert_eq!(
        pool.reserve_profile(cwd, Some("auto"), "agent", "claude")
            .as_deref(),
        Some("two")
    );
    pool.0.lock().unwrap().shells.clear();
    {
        let mut state = pool.0.lock().unwrap();
        state
            .shells
            .extend([prepared("a"), prepared("b"), prepared("c")]);
        state.target.as_mut().unwrap().count = 3;
    }
    pool.set_count(3);
    assert_eq!(pool.0.lock().unwrap().shells.len(), 3);
    // 调小时只裁掉多出的空闲 CLI，保留的仍是已就绪的那些。
    pool.set_count(1);
    let state = pool.0.lock().unwrap();
    assert_eq!(state.target.as_ref().unwrap().count, 1);
    assert_eq!(
        state
            .shells
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["a"]
    );
}

/// daemon 连接断开（Server 重启）时 CLI 预热照常补充；只有 CLI 自己退出才暂停。
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn lost_daemon_session_does_not_pause_profile_prewarm_but_cli_exit_does() {
    use qingcode_server::daemon::{DaemonOptions, RunDir};
    let dir = tempfile::tempdir().unwrap();
    let run_dir = RunDir::resolve(Some(dir.path())).unwrap();
    let options = DaemonOptions {
        state_dir: Some(dir.path().into()),
        ..Default::default()
    };
    let daemon = tokio::spawn(qingcode_server::daemon::run_async(options));
    tokio::time::timeout(READY_TIMEOUT, async {
        while !run_dir.ready_marker().exists() || run_dir.read_token().is_err() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let prepared = |_: ()| async {
        let entry = remote_shell("test", "ssh://conn-1/D:/anchor", true);
        let mut target = target_for(&entry, 1);
        (target.launch, target.key) =
            remote_launch_key(&target.project_path, Some("powershell")).unwrap();
        target.cwd.clear();
        let stream = qingcode_server::connect::connect_async(&IpcEndpoint::new(run_dir.dir()))
            .await
            .unwrap();
        let session =
            DaemonSession::open_local(stream, "test:windev", run_dir.read_token().unwrap())
                .await
                .unwrap();
        let mut entry = prepare_remote_shell(
            &target,
            target.remote.as_ref().unwrap(),
            SessionTransport::Local,
            session,
            None,
        )
        .await
        .unwrap();
        entry.key.profile = Some(PrewarmProfile {
            cross_project: true,
            cwd: "ssh://conn-1/D:/anchor".into(),
            shell: "powershell".into(),
            profile_id: "agent".into(),
            command: "claude".into(),
            count: 1,
        });
        entry
    };
    let pool = ShellPrewarmPool::default();
    let lost = prepared(()).await;
    lost.session.as_ref().unwrap().shutdown();
    {
        let mut state = pool.0.lock().unwrap();
        state.shells.push(lost);
        assert_eq!(state.prune_idle(), 1);
        assert_eq!(state.paused_reason, None);
    }
    let exited = prepared(()).await;
    let pty = exited.pty_id.clone();
    let session = exited.session.as_ref().unwrap();
    session
        .request("pty.kill", &serde_json::json!({"id": pty}))
        .await
        .unwrap();
    pool.0.lock().unwrap().shells.push(exited);
    tokio::time::timeout(READY_TIMEOUT, async {
        while pool.0.lock().unwrap().prune_idle() == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("CLI 退出后预热项应被移除");
    assert_eq!(pool.0.lock().unwrap().paused_reason, Some("profile_exited"));
    daemon.abort();
}

#[test]
fn server_restart_clears_update_backoff_and_wakes_the_refill_worker() {
    let cwd = "ssh://conn-1/C:/work/a";
    let shell = remote_shell("warm-a", cwd, true);
    let target = target_for(&shell, 1);
    let pool = ShellPrewarmPool::default();
    {
        let mut state = pool.0.lock().unwrap();
        state.target = Some(target);
        state.shells.push(shell);
        state.generation = 7;
        state.preparing = true;
        state.paused_reason = Some("create_failed_backoff");
        state.ready_timeouts = 2;
    }
    pool.retry_now();
    let state = pool.0.lock().unwrap();
    // 进行中的创建作废，退避与暂停原因清空；仍存活的预热项保留。
    assert_eq!(state.generation, 8);
    assert!(!state.preparing);
    assert_eq!(state.paused_reason, None);
    assert_eq!(state.ready_timeouts, 0);
    assert_eq!(state.shells.len(), 1);
}

#[test]
fn server_restart_ignores_an_unconfigured_pool() {
    let pool = ShellPrewarmPool::default();
    pool.retry_now();
    assert_eq!(pool.0.lock().unwrap().generation, 0);
}
