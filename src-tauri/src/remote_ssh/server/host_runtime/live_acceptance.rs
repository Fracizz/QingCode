//! Opt-in real backend acceptance. Uses only UUID-named disposable projects;
//! never shuts down the user's daemon or modifies sshd/authentication settings.
use super::*;
use tokio::io::AsyncWriteExt;

async fn verify_project_services(
    manager: &SshManager,
    id: &str,
    root: &RegisteredRoot,
    daemon: &DaemonAccess,
) -> Result<(), String> {
    use super::super::daemon::{daemon_rpc, open_daemon_channel, DaemonSession};
    let mut channel = open_daemon_channel(manager, id, daemon).await?;
    let subscribed = daemon_rpc(
        &mut channel,
        "watch.subscribe",
        &serde_json::json!({"root": root.canonical_path}),
        Instant::now() + Duration::from_secs(15),
    )
    .await;
    channel.shutdown().await;
    if subscribed
        .map_err(|e| e.to_string())?
        .get("subscribed")
        .and_then(|v| v.as_bool())
        != Some(true)
    {
        return Err("shared daemon watch subscription failed".into());
    }
    let transport = manager.session(id)?;
    let session =
        DaemonSession::open_on_transport(&transport, &manager.daemon_client_id(id), daemon).await?;
    let created = session.request("pty.create", &serde_json::json!({"cwd": root.canonical_path, "cols":80, "rows":24, "name":"shared-runtime-acceptance"})).await;
    let killed = match created {
        Ok(created) => {
            let pty_id = created
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("PTY creation did not return an id")?;
            session
                .request("pty.kill", &serde_json::json!({"id":pty_id}))
                .await
                .map(|_| ())
        }
        Err(error) => Err(error),
    };
    session.shutdown();
    killed?;
    println!("SHARED_DAEMON_STAGE project-watch-and-pty-ready");
    Ok(())
}

async fn register_root(
    manager: &SshManager,
    id: &str,
    path: &str,
) -> Result<RegisteredRoot, String> {
    let sftp = manager.open_sftp(id).await?;
    let canonical = sftp.canonicalize(path).await.map_err(|e| e.to_string())?;
    reject_windows_sftp_links(&sftp, &canonical).await?;
    if !sftp
        .metadata(&canonical)
        .await
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("project root is not a directory".into());
    }
    let root = RegisteredRoot {
        uri: normalize_remote_uri(&format!("ssh://{id}{path}")),
        canonical_path: canonical,
        trusted: true,
    };
    manager
        .roots
        .write()
        .unwrap()
        .insert(root.uri.clone(), root.clone());
    Ok(root)
}

async fn endpoint(manager: &SshManager, root: &RegisteredRoot) -> Result<DaemonAccess, String> {
    let endpoint = super::super::deploy::ensure_server_endpoint_with_app(manager, root, None)
        .await?
        .ok_or("no endpoint")?;
    if endpoint.serve.is_some() {
        return Err("shared path unexpectedly started project serve".into());
    }
    endpoint.daemon.ok_or("shared daemon unavailable".into())
}

async fn acceptance(
    config: SshConnectionConfig,
    parent: &str,
    binary_dir: &str,
    extended: bool,
) -> Result<(), String> {
    let manager = SshManager::new();
    manager.set_server_binary_dirs(vec![PathBuf::from(binary_dir)]);
    let actual = ssh_probe_host(config.clone()).await?.fingerprint;
    if config.host_key_fingerprint.as_deref() != Some(actual.as_str()) {
        return Err("SSH host fingerprint changed; acceptance stopped".into());
    }
    store_authenticated_session(&manager, config.clone())
        .await
        .map_err(|e| format!("primary SSH authentication: {e}"))?;
    let sftp = manager.open_sftp(&config.id).await?;
    let base = format!(
        "{}/qingcode-shared-{}",
        parent.trim_end_matches('/'),
        uuid::Uuid::new_v4()
    );
    let paths = [format!("{base}/a"), format!("{base}/b")];
    sftp.create_dir(&base).await.map_err(|e| e.to_string())?;
    let result: Result<(), String> = tokio::time::timeout(Duration::from_secs(210), async {
        for (index, path) in paths.iter().enumerate() {
            sftp.create_dir(path).await.map_err(|e| e.to_string())?;
            let mut file = sftp.create(format!("{path}/marker-{index}.txt")).await.map_err(|e| e.to_string())?;
            file.write_all(b"shared daemon acceptance").await.map_err(|e| e.to_string())?;
            file.shutdown().await.map_err(|e| e.to_string())?;
        }
        let a = register_root(&manager, &config.id, &paths[0]).await?;
        let identity = identity_for_connection(&manager, &config.id).ok_or("missing identity")?;
        let entry = manager.host_daemons.entry(&identity);
        let started = Instant::now();
        let first = endpoint(&manager, &a).await.map_err(|e| format!("cold shared preparation: {e}"))?;
        let cold_ms = started.elapsed().as_millis();
        println!("SHARED_DAEMON_STAGE cold-ready {cold_ms}ms");
        let started = Instant::now();
        let b = register_root(&manager, &config.id, &paths[1]).await?;
        let second = endpoint(&manager, &b).await.map_err(|e| format!("second project: {e}"))?;
        let second_ms = started.elapsed().as_millis();
        println!("SHARED_DAEMON_STAGE second-project-ready {second_ms}ms");
        if first != second { return Err("projects did not reuse the same daemon".into()); }
        if entry.initializations.load(Ordering::SeqCst) != 1 { return Err("second root repeated preparation".into()); }
        for (index, root) in [&a, &b].iter().enumerate() {
            let entries = super::super::daemon::daemon_scan_entries(&manager, &config.id, &first, &root.canonical_path, ".")
                .await.map_err(|e| e.to_string())?;
            if !entries.iter().any(|(name, _)| name == &format!("marker-{index}.txt")) {
                return Err("project root was not independently attached".into());
            }
            if sftp.metadata(format!("{}/.qingcode/server/server.json", paths[index])).await.is_ok() {
                return Err("shared root unexpectedly has a project serve state file".into());
            }
        }
        verify_project_services(&manager, &config.id, &b, &first).await?;
        // Simulate loss of client readiness, not a crash of a user's daemon.
        invalidate_failed_daemon(&manager, &config.id, &first);
        for root in [&a, &b] {
            if manager.server_slot(&server_slot_key(&config.id, &root.canonical_path)).and_then(|s| s.endpoint).is_some() {
                return Err("daemon failure did not invalidate sibling roots".into());
            }
        }
        let before = entry.initializations.load(Ordering::SeqCst);
        let (left, right) = tokio::join!(endpoint(&manager, &a), endpoint(&manager, &b));
        if left? != right? || entry.initializations.load(Ordering::SeqCst) != before + 1 {
            return Err("concurrent roots did not share a single recovery".into());
        }
        println!("SHARED_DAEMON_STAGE concurrent-recovery-ready");
        if !extended {
            println!("SHARED_DAEMON_ACCEPTANCE {}", serde_json::json!({
                "coldServiceAcquireMs": cold_ms, "secondRootRegisterAndAcquireMs": second_ms,
                "singleRecovery": true, "noProjectServe": true, "sameDaemon": true,
                "projectWatchAndPty": true,
            }));
            return Ok(());
        }
        // Another saved connection to the same authenticated host/user shares
        // the runtime, but validates its own SSH incarnation with HELLO.
        let mut alias_config = config.clone(); alias_config.id = format!("{}-alias", config.id);
        store_authenticated_session(&manager, alias_config.clone()).await.map_err(|e| format!("alias SSH authentication: {e}"))?;
        let alias_root = register_root(&manager, &alias_config.id, &paths[1]).await?;
        let started = Instant::now();
        if endpoint(&manager, &alias_root).await? != first { return Err("alias did not reuse daemon".into()); }
        let alias_ms = started.elapsed().as_millis();
        if entry.initializations.load(Ordering::SeqCst) != before + 1 { return Err("alias reinstalled service".into()); }
        let old = manager.sessions.write().unwrap().remove(&config.id).ok_or("missing SSH session")?;
        old.handle.disconnect(Disconnect::ByApplication, "acceptance reconnect", "en").await.map_err(|e| e.to_string())?;
        drop(old);
        manager.purge_server_state(&config.id);
        store_authenticated_session(&manager, config.clone()).await.map_err(|e| format!("reconnect SSH authentication: {e}"))?;
        let reopened = register_root(&manager, &config.id, &paths[0]).await?;
        let started = Instant::now();
        if endpoint(&manager, &reopened).await? != first { return Err("SSH reconnect restarted daemon".into()); }
        let reconnect_ms = started.elapsed().as_millis();
        if entry.initializations.load(Ordering::SeqCst) != before + 1 { return Err("reconnect repeated deployment".into()); }
        // An empty process cache still discovers the verified user installation
        // and attaches to the already-running daemon without project serve.
        let fresh_manager = SshManager::new();
        fresh_manager.set_server_binary_dirs(vec![PathBuf::from(binary_dir)]);
        store_authenticated_session(&fresh_manager, config.clone()).await.map_err(|e| format!("fresh-client SSH authentication: {e}"))?;
        let fresh_root = register_root(&fresh_manager, &config.id, &paths[0]).await?;
        let started = Instant::now();
        if endpoint(&fresh_manager, &fresh_root).await? != first { return Err("fresh client restarted daemon".into()); }
        println!("SHARED_DAEMON_ACCEPTANCE {}", serde_json::json!({
            "coldMs": cold_ms, "secondRootMs": second_ms, "aliasAttachMs": alias_ms,
            "sshReconnectAttachMs": reconnect_ms, "freshClientAttachMs": started.elapsed().as_millis(),
            "singleRecovery": true, "noProjectServe": true, "sameDaemon": true,
        }));
        Ok(())
    }).await.unwrap_or_else(|_| Err("shared daemon acceptance timed out".into()));
    // Only paths created above are removed; no wildcard/recursive remote deletion.
    let cleanup_sftp = manager.open_sftp(&config.id).await.unwrap_or(sftp);
    let mut cleanup_errors = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let _ = cleanup_sftp
            .remove_file(format!("{path}/marker-{index}.txt"))
            .await;
        if let Err(error) = cleanup_sftp.remove_dir(path).await {
            cleanup_errors.push(error.to_string());
        }
    }
    if let Err(error) = cleanup_sftp.remove_dir(&base).await {
        cleanup_errors.push(error.to_string());
    }
    if !cleanup_errors.is_empty() {
        return Err(format!(
            "{result:?}; disposable project cleanup failed: {cleanup_errors:?}"
        ));
    }
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires authorized QC_LIVE_* SSH target, key, confirmed fingerprint and disposable parent"]
async fn live_shared_daemon_across_roots_and_reconnect() {
    run_from_env(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires authorized QC_LIVE_* SSH target and disposable parent"]
async fn live_shared_daemon_same_connection_roots() {
    run_from_env(false).await;
}

async fn run_from_env(extended: bool) {
    let required = |name: &str| std::env::var(name).expect(name);
    let config = SshConnectionConfig {
        id: format!("shared-live-{}", uuid::Uuid::new_v4()),
        host: required("QC_LIVE_HOST"),
        port: required("QC_LIVE_PORT").parse().unwrap(),
        username: required("QC_LIVE_USER"),
        auth_kind: "privateKey".into(),
        private_key_path: Some(required("QC_LIVE_PRIVATE_KEY")),
        passphrase: std::env::var("QC_LIVE_PASSPHRASE").ok(),
        password: None,
        host_key_fingerprint: Some(required("QC_LIVE_FINGERPRINT")),
        mode: Some(RemoteMode::Server),
    };
    tokio::time::timeout(
        Duration::from_secs(240),
        acceptance(
            config,
            &required("QC_LIVE_PARENT"),
            &required("QC_LIVE_SERVER_DIR"),
            extended,
        ),
    )
    .await
    .expect("shared daemon acceptance timed out")
    .expect("shared daemon acceptance failed");
}
