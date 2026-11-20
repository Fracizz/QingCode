use super::*;

#[test]
fn claude_only_confirms_the_selected_trust_choice_in_the_managed_directory() {
    let prompt = "Accessing workspace:\nD:/Test/codex-prewarm\nQuick safety check: Is this a project you created or one you trust?\n❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel";
    assert_eq!(
        claude_trust_choice(prompt, r"D:\Test\codex-prewarm"),
        Some(false)
    );
    assert_eq!(claude_trust_choice(prompt, r"D:\Other"), None);
    let selected = prompt.replace("❯ No, exit\nYes", "No, exit\n❯ Yes");
    assert_eq!(
        claude_trust_choice(&selected, r"D:\Test\codex-prewarm"),
        Some(true)
    );
    assert_eq!(
        claude_trust_choice(
            &selected.replace("Accessing workspace:", "Open folder:"),
            r"D:\Test\codex-prewarm"
        ),
        None
    );
}

#[test]
fn preset_anchor_is_created_and_refuses_existing_content() {
    let temp = tempfile::tempdir().unwrap();
    let path = checked_anchor(temp.path(), true).unwrap();
    assert_eq!(checked_anchor(temp.path(), false).unwrap(), path);
    std::fs::write(path.join("AGENTS.md"), "fixture").unwrap();
    assert!(checked_anchor(temp.path(), true).is_err());
    assert!(path.join("AGENTS.md").is_file());
}

#[test]
fn only_exact_directory_reports_confirm_a_switch() {
    let path = r"D:\代码\nem panel";
    assert!(reports(
        "• Current working directory: D:/代码/nem panel",
        PWD,
        path
    ));
    assert!(!reports("› /cd D:/代码/nem panel", PWD, path));
    assert!(!reports(
        "• Current working directory: D:/代码/nem panel-old",
        PWD,
        path
    ));
    assert!(!idle("› 1. Trust and continue\n2. Keep current directory"));
}

#[test]
fn claude_accepts_a_result_soft_wrapped_after_the_command_row() {
    let mut parser = vt100::Parser::new(6.try_into().unwrap(), 36.try_into().unwrap(), 0);
    let echo = format!("{:<36}", "❯ /cd D:/code/project");
    parser.process(format!(r"{echo}  ⎿  Already in D:\code\project.").as_bytes());
    let screen = parser.screen();
    assert!(claude_reports(screen, "Already in D:/code/project.", true));
    assert!(!claude_reports(
        screen,
        "Already in D:/code/project2.",
        true
    ));
}

#[test]
fn claude_recognizes_the_composer_after_a_full_width_rule() {
    let mut parser = vt100::Parser::new(6.try_into().unwrap(), 20.try_into().unwrap(), 0);
    parser.process(format!("{}❯ /cd\r\n{}", "─".repeat(20), "─".repeat(20)).as_bytes());
    let rows = claude_rows(parser.screen());
    assert!(claude_composer(&rows, "/cd"));
    assert!(!claude_composer(&rows, ""));
}

#[test]
fn a_loading_composer_and_a_previous_command_do_not_authorize_enter() {
    let mut view = CodexSession {
        screen: vt100::Parser::new_with_callbacks(
            30.try_into().unwrap(),
            120.try_into().unwrap(),
            0,
            CodexStatus::default(),
        ),
        input_seq: AtomicU64::new(0),
        agent: "codex".into(),
        nonce: String::new(),
        handoff: None,
        anchor: String::new(),
    };
    view.screen.process("› Ask Codex to do anything".as_bytes());
    assert!(!view.input_ready());
    view.screen.process(b"\x1b]7501;state=idle:app=codex\x07");
    assert!(view.input_ready());
    view.screen.process("\r\x1b[2K› /pwd".as_bytes());
    assert!(view.composer_shows("› /pwd"));
    view.screen.process(b"\r\n");
    assert!(!view.composer_shows("› /pwd"));
    view.screen
        .process("› /pwd\x1b]7501;state=blocked:app=codex:kind=permission\x07".as_bytes());
    assert!(!view.composer_shows("› /pwd"));
}

/// Set PATH to include a supported Codex executable. This test creates a
/// private CODEX_HOME and two disposable trusted folders. No model turn.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires a local Codex CLI with /cd and /pwd"]
async fn real_codex_switches_project_and_returns_to_powershell() -> Result<(), String> {
    real_cli_switch("codex").await
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the Claude Code executable on PATH"]
async fn real_claude_switches_project_and_returns_to_powershell() -> Result<(), String> {
    real_cli_switch("claude").await
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires OpenCode with serve and attach on PATH"]
async fn real_opencode_switches_project_and_returns_to_powershell() -> Result<(), String> {
    real_cli_switch("opencode").await
}

#[cfg(windows)]
async fn real_cli_switch(agent: &str) -> Result<(), String> {
    use qingcode_server::daemon::{DaemonOptions, RunDir};
    // Claude renders slash-command results as Markdown; a backslash before
    // a leading dot in a Windows component is an escape. Use an ordinary
    // project path so the exact returned directory is observable.
    let temp = tempfile::Builder::new()
        .prefix("qingcode-cli-")
        .tempdir()
        .unwrap();
    let home = temp.path().join("home");
    let anchor = checked_anchor(temp.path(), true)?;
    let anchor = std::path::PathBuf::from(
        crate::terminal::strip_windows_verbatim_prefix(&anchor.to_string_lossy()).into_owned(),
    );
    let project = temp.path().join("项目 A");
    for path in [&home, &project] {
        std::fs::create_dir(path).unwrap();
    }
    let config = format!(
        r#"model = "gpt-6-sol"
model_provider = "fixture"
sandbox_mode = "read-only"
[features]
daemon_auto_start = false
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
[projects.'{}']
trust_level = "trusted"
"#,
        project.display()
    );
    std::fs::write(home.join("config.toml"), config).unwrap();
    let dir = temp.path().join("daemon");
    let run_dir = RunDir::resolve(Some(&dir)).unwrap();
    let daemon = tokio::spawn(qingcode_server::daemon::run_async(DaemonOptions {
        state_dir: Some(dir),
        ..Default::default()
    }));
    let (stream, token) = tokio::time::timeout(READY_TIMEOUT, async {
        loop {
            if let Ok(token) = run_dir.read_token() {
                if let Ok(s) =
                    qingcode_server::connect::connect_async(&IpcEndpoint::new(run_dir.dir())).await
                {
                    return (s, token);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let mut entry = super::super::tests::fake_shell();
    entry.claim_cwd = true;
    entry.session = Some(
        DaemonSession::open_local(stream, "test:codex", token)
            .await
            .unwrap(),
    );
    let (cwd, launch, mut key) =
        local_launch_key(anchor.to_str().unwrap(), Some("powershell")).unwrap();
    key.profile = Some(PrewarmProfile {
        cross_project: false,
        cwd: cwd.clone(),
        profile_id: agent.into(),
        shell: "powershell".into(),
        command: agent.into(),
    });
    let mut target = Target {
        project_path: cwd.clone(),
        cwd,
        launch,
        key,
        count: 1,
        window: "test".into(),
        remote: None,
    };

    target
        .launch
        .env
        .insert("CODEX_HOME".into(), home.display().to_string());
    let env = &mut target.launch.env;
    if agent == "claude" {
        let norm = |p: &Path| p.to_string_lossy().replace('\\', "/");
        let config = serde_json::json!({
            "hasCompletedOnboarding":true, "theme":"dark", "lastOnboardingVersion":"2.1.319",
            "projects":{ (norm(&project)):{"hasTrustDialogAccepted":true},
            (project.to_string_lossy().as_ref()):{"hasTrustDialogAccepted":true} }
        });
        std::fs::write(home.join(".claude.json"), config.to_string()).unwrap();
        env.insert("CLAUDE_CONFIG_DIR".into(), home.display().to_string());
        env.insert("ANTHROPIC_BASE_URL".into(), "http://127.0.0.1:1".into());
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), "fixture".into());
        env.insert(
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        );
    } else if agent == "opencode" {
        for key in [
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
        ] {
            env.insert(key.into(), home.join(key).display().to_string());
        }
        env.insert("OPENCODE_DISABLE_AUTOUPDATE".into(), "true".into());
        env.insert("OPENCODE_DISABLE_MODELS_FETCH".into(), "true".into());
    }
    let started = Instant::now();
    prepare(&mut entry, &target).await?;
    let cold_ms = started.elapsed().as_millis();
    entry.cwd.clone_from(&target.cwd);
    entry.key.clone_from(&target.key);
    let pool = LocalCodexPool::default();
    {
        let mut state = pool.pool.0.lock().unwrap();
        state.target = Some(target.clone());
        state.shells.push(entry);
    }
    let destination = project.to_str().unwrap();
    assert!(pool
        .reserve(destination, Some("powershell"), "unselected", agent)
        .is_none());
    let id = pool
        .reserve(destination, Some("powershell"), agent, agent)
        .expect("cross-project reservation");
    assert!(pool
        .reserve(destination, Some("powershell"), agent, agent)
        .is_none());
    let (canonical, key, _) = pool.key(destination, Some("powershell"), agent).unwrap();
    let mut entry = pool.pool.take_key(&id, &key, &canonical, true).unwrap();
    let codex = entry.codex.as_mut().unwrap();
    let session = entry.session.as_mut().unwrap();
    let cwd = project.to_str().unwrap();
    let claimed = Instant::now();
    let result = tokio::time::timeout(
        codex.switch_timeout(),
        codex.enter(session, &entry.pty_id, cwd, &target.cwd, || Ok(())),
    )
    .await;
    if !matches!(result, Ok(Ok(()))) {
        return Err(format!(
            "switch: {result:?} {}",
            codex.screen.screen().contents()
        ));
    }
    if let Some(file) = &mut codex.handoff {
        file.write_all(cwd.as_bytes()).unwrap();
    }
    session
        .request(
            "pty.claim",
            &serde_json::json!({"id":entry.pty_id,"cwd":cwd}),
        )
        .await
        .unwrap();
    let replay = session.attach(&entry.pty_id, 0, true).await.unwrap();
    assert!(replay.stream_end.ok);
    codex.input_seq.store(
        replay.response["nextInputSeq"].as_u64().unwrap(),
        Ordering::Release,
    );
    println!("{agent} startup through readiness: {cold_ms} ms; directory switch through PTY attach: {} ms", claimed.elapsed().as_millis());
    if let Some(file) = &codex.handoff {
        std::fs::remove_file(file.path()).map_err(|e| e.to_string())?;
    }
    let exited = tokio::time::timeout(READY_TIMEOUT, async {
        if agent == "codex" {
            codex
                .submit(session, &entry.pty_id, "/exit", || Ok(()))
                .await
                .unwrap();
        } else {
            codex
                .wait_for(session, &entry.pty_id, |v| {
                    let screen = v.screen.screen().contents();
                    if agent == "opencode" {
                        screen.contains("Ask anything")
                    } else {
                        claude_composer(&claude_rows(v.screen.screen()), "")
                    }
                })
                .await
                .unwrap();
            send_input_to_session(session, &entry.pty_id, &codex.input_seq, b"/exit".to_vec())
                .await
                .unwrap();
            codex
                .wait_for(session, &entry.pty_id, |v| {
                    v.screen.screen().contents().contains("/exit")
                })
                .await
                .unwrap();
            send_input_to_session(session, &entry.pty_id, &codex.input_seq, vec![b'\r'])
                .await
                .unwrap();
        }
        codex
            .wait_for(session, &entry.pty_id, |s| {
                s.screen.screen().contents().contains(&format!("PS {cwd}>"))
            })
            .await
            .unwrap();
    })
    .await;
    if exited.is_err() {
        return Err(format!(
            "{agent} did not return to the target PowerShell prompt: {}",
            codex.screen.screen().contents()
        ));
    }

    session
        .request("pty.kill", &serde_json::json!({"id":entry.pty_id}))
        .await
        .unwrap();
    daemon.abort();
    assert!(!std::fs::read_to_string(home.join("config.toml"))
        .unwrap()
        .contains("codex-prewarm"));
    Ok(())
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires the named real CLI on PATH (QC_PREWARM_TEST_AGENT)"]
async fn posix_server_switches_real_cli() -> Result<(), String> {
    use super::super::tests::{remote_shell, target_for};
    use qingcode_server::daemon::{DaemonOptions, RunDir};
    let agent = std::env::var("QC_PREWARM_TEST_AGENT").expect("set QC_PREWARM_TEST_AGENT");
    assert!(supported(&agent));
    let temp = tempfile::tempdir().unwrap();
    let anchor = temp.path().join("anchor");
    let project = temp.path().join("项目 B");
    let home = temp.path().join("home");
    let config = home.join(".claude");
    std::fs::create_dir_all(&config).unwrap();
    for p in [&anchor, &project] {
        std::fs::create_dir(p).unwrap()
    }
    let anchor = anchor.to_str().unwrap();
    let project = project.to_str().unwrap();
    std::fs::write(config.join(".claude.json"),serde_json::json!({
        "hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.319","theme":"dark",
        "projects":{anchor:{"hasTrustDialogAccepted":true},project:{"hasTrustDialogAccepted":true}}
    }).to_string()).unwrap();
    std::fs::write(home.join("config.toml"), format!(
        "model='fixture'\nmodel_provider='fixture'\n[features]\ndaemon_auto_start=false\n[model_providers.fixture]\nname='fixture'\nbase_url='http://127.0.0.1:1/v1'\nwire_api='responses'\n[projects.'{anchor}']\ntrust_level='trusted'\n[projects.'{project}']\ntrust_level='trusted'\n"
    )).unwrap();
    let state = temp.path().join("runtime");
    let run = RunDir::resolve(Some(&state)).unwrap();
    let daemon = tokio::spawn(qingcode_server::daemon::run_async(DaemonOptions {
        state_dir: Some(state.clone()),
        ..Default::default()
    }));
    let (stream, token) = tokio::time::timeout(READY_TIMEOUT, async {
        loop {
            if let Ok(token) = run.read_token() {
                if let Ok(stream) =
                    qingcode_server::connect::connect_async(&IpcEndpoint::new(run.dir())).await
                {
                    break (stream, token);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let uri = format!("ssh://test{anchor}");
    let mut entry = remote_shell("fixture", &uri, true);
    let manager = SshManager::new();
    entry.session = Some(
        if let Ok(config_path) = std::env::var("QC_PREWARM_LOOPBACK_SSH") {
            use crate::remote_ssh::{store_authenticated_session, SshConnectionConfig};
            use std::os::unix::fs::PermissionsExt;
            let config: SshConnectionConfig =
                serde_json::from_slice(&std::fs::read(config_path).unwrap()).unwrap();
            assert_eq!(config.host, "127.0.0.1");
            assert!(config.host_key_fingerprint.is_some());
            let connector = temp.path().join("connector");
            let binary = std::env::var("QC_PREWARM_SERVER_BINARY").unwrap();
            let command = format!(
                "#!/bin/sh\nexec {} connect --stdio --state-dir {}\n",
                shell_quote(&binary),
                shell_quote(state.to_str().unwrap())
            );
            std::fs::write(&connector, command).unwrap();
            std::fs::set_permissions(&connector, std::fs::Permissions::from_mode(0o700)).unwrap();
            let id = config.id.clone();
            store_authenticated_session(&manager, config).await?;
            let connection = manager.session(&id)?;
            let access = server::DaemonAccess {
                bin: connector.to_string_lossy().into_owned(),
                token,
            };
            DaemonSession::open_on_transport(&connection, "test:cli", &access).await?
        } else {
            DaemonSession::open_local(stream, "test:cli", token).await?
        },
    );
    entry.key.profile = Some(PrewarmProfile {
        cross_project: true,
        cwd: uri,
        command: agent.clone(),
        shell: "auto".into(),
        profile_id: agent.clone(),
    });
    let mut target = target_for(&entry, 1);
    use std::os::unix::fs::PermissionsExt as _;
    let shell = temp.path().join("fixture-shell");
    let observed = temp.path().join("post-cli-cwd");
    std::fs::write(&shell, "#!/bin/sh\nif [ \"$1\" = -l ]; then pwd -P > \"$QC_FIXTURE_CWD\"; fi\nexec /bin/sh \"$@\"\n").unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
    let home = home.to_str().unwrap();
    for (k, v) in [
        ("HOME", home),
        ("SHELL", shell.to_str().unwrap()),
        ("QC_FIXTURE_CWD", observed.to_str().unwrap()),
        ("XDG_CONFIG_HOME", home),
        ("XDG_STATE_HOME", home),
        ("XDG_DATA_HOME", home),
        ("XDG_CACHE_HOME", home),
        ("CODEX_HOME", home),
        ("CLAUDE_CONFIG_DIR", config.to_str().unwrap()),
        ("ANTHROPIC_BASE_URL", "http://127.0.0.1:1"),
        ("ANTHROPIC_AUTH_TOKEN", "fixture"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ("DISABLE_AUTOUPDATER", "1"),
        ("OPENCODE_DISABLE_AUTOUPDATE", "true"),
        ("OPENCODE_DISABLE_MODELS_FETCH", "true"),
    ] {
        target.launch.env.insert(k.into(), v.into());
    }
    prepare_at(&mut entry, &target, anchor, anchor).await?;
    let session = entry.session.as_mut().unwrap();
    let cli = entry.codex.as_mut().unwrap();
    if !matches!(
        tokio::time::timeout(
            cli.switch_timeout(),
            cli.enter(session, &entry.pty_id, project, anchor, || Ok(()))
        )
        .await,
        Ok(Ok(()))
    ) {
        return Err(format!(
            "switch timed out: {}",
            cli.screen.screen().contents()
        ));
    }
    session
        .request(
            "pty.claim",
            &serde_json::json!({"id":entry.pty_id,"cwd":project}),
        )
        .await?;
    let replay = session.attach(&entry.pty_id, 0, true).await?;
    assert!(replay.stream_end.ok);
    cli.input_seq.store(
        replay.response["nextInputSeq"].as_u64().unwrap(),
        Ordering::Release,
    );
    tokio::time::timeout(READY_TIMEOUT, async {
        if agent == "codex" {
            cli.submit(session, &entry.pty_id, "/exit", || Ok(()))
                .await?;
        } else {
            send_input_to_session(session, &entry.pty_id, &cli.input_seq, b"/exit".to_vec())
                .await
                .map_err(|e| e.0)?;
            cli.wait_for(session, &entry.pty_id, |v| {
                v.screen.screen().contents().contains("/exit")
            })
            .await?;
            send_input_to_session(session, &entry.pty_id, &cli.input_seq, vec![b'\r'])
                .await
                .map_err(|e| e.0)?;
        }
        loop {
            if let Ok(path) = std::fs::read_to_string(&observed) {
                assert_eq!(path.trim_end(), project);
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "exiting the CLI did not return to the claiming project")??;
    session
        .request("pty.kill", &serde_json::json!({"id":entry.pty_id}))
        .await?;
    daemon.abort();
    Ok(())
}
