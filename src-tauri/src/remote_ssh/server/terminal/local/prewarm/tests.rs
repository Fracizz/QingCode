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
        key: LaunchKey::from_parts(None, &launch),
        cwd: CWD.into(),
        claim_cwd: false,
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
    assert_eq!(pool.reserve_key(&key, CWD, false), Err("empty"));
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

fn remote_shell(id: &str, cwd: &str, claim_cwd: bool) -> WarmShell {
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
            connection_id: "conn-1".into(),
            working_directory: path,
        }),
        startup_pipe: None,
        startup_input: true,
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

fn target_for(shell: &WarmShell, count: usize) -> Target {
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

fn with_id(mut shell: WarmShell, id: &str) -> WarmShell {
    shell.id = id.into();
    shell
}

#[test]
fn switching_hosts_keeps_one_idle_shell_for_the_previous_host() {
    let local = fake_shell();
    let remote = remote_shell("remote-1", "ssh://conn-1/C:/work/a", true);
    let other_host = remote_launch_key("ssh://conn-2/C:/work/a", None).unwrap().1;
    let (local_key, remote_key) = (local.key.clone(), remote.key.clone());
    let mut state = PoolState {
        target: Some(target_for(&local, 2)),
        ..PoolState::default()
    };
    let mut reserved = with_id(fake_shell(), "local-reserved");
    reserved.reserved_at = Some(Instant::now());
    state.shells.extend([
        with_id(fake_shell(), "local-1"),
        with_id(fake_shell(), "local-2"),
        reserved,
    ]);
    // 本机 → SSH：本机只留 1 个空闲项，正在领取的预留项不受影响。
    assert_eq!(state.retarget(Some((&remote_key, 1))), 1);
    let ids = |state: &PoolState| {
        state
            .shells
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&state), ["local-1", "local-reserved"]);
    state.shells.retain(|shell| shell.reserved_at.is_none());
    state.target = Some(target_for(&remote, 1));
    state.shells.push(remote);
    // SSH → 本机：此前保留的本机项沿用，SSH 也留 1 个。
    assert_eq!(state.retarget(Some((&local_key, 2))), 0);
    assert_eq!(ids(&state), ["local-1", "remote-1"]);
    // 再换到第三个主机：只留上一个主机（本机）的 1 个。
    state.target = Some(target_for(&state.shells[0], 2));
    assert_eq!(state.retarget(Some((&other_host, 1))), 1);
    assert_eq!(ids(&state), ["local-1"]);
    // 切到不预热的项目同样保留上一个主机的 1 个。
    state.target = Some(target_for(&state.shells[0], 1));
    state.shells.push(with_id(fake_shell(), "local-2"));
    assert_eq!(state.retarget(None), 1);
    assert_eq!(ids(&state), ["local-1"]);
}

#[test]
fn shells_kept_for_another_host_do_not_mask_matching_ones() {
    let pool = ShellPrewarmPool::default();
    let local = fake_shell();
    let key = local.key.clone();
    pool.0.lock().unwrap().shells.extend([
        remote_shell("remote-1", "ssh://conn-1/C:/work/a", true),
        local,
    ]);
    // 没有补充目标（切到了不预热的项目）时，保留项仍可领取。
    assert_eq!(
        pool.reserve_key(&key, CWD, false).as_deref(),
        Ok("reserved-id")
    );
    let other = remote_launch_key("ssh://conn-2/C:/work/a", None).unwrap().1;
    assert_eq!(pool.reserve_key(&other, CWD, false), Err("host_mismatch"));
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
