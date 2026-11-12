use super::*;

#[test]
fn automatic_count_uses_physical_memory_with_one_to_eight_bounds() {
    for (gib, expected) in [
        (0, 1),
        (4, 1),
        (8, 1),
        (15, 1),
        (16, 2),
        (24, 3),
        (32, 4),
        (64, 8),
        (128, 8),
    ] {
        assert_eq!(
            resolve_count(&serde_json::json!("auto"), gib * GIB),
            expected
        );
    }
    for count in 0..=8 {
        assert_eq!(resolve_count(&serde_json::json!(count), 64 * GIB), count);
    }
    assert_eq!(resolve_count(&serde_json::json!(100), 8 * GIB), 8);
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
    assert!(powershell[3].contains("$env:QINGCODE_PREWARM_READY_FILE"));
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
        session: None,
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
            std::thread::spawn(move || pool.reserve_key(&key))
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap())
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
    assert!(pool.reserve_key(&different).is_none());
}

#[test]
fn only_the_owning_window_can_invalidate_the_shared_pool() {
    let pool = ShellPrewarmPool::default();
    let shell = fake_shell();
    pool.0.lock().unwrap().target = Some(Target {
        key: shell.key.clone(),
        launch: shell.launch.clone(),
        count: 1,
        window: "main".into(),
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
