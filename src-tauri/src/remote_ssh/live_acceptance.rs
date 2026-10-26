//! Opt-in acceptance of the actual desktop SSH backend, without a WebView.
//! Run only against an authorized host. Credentials and a verified fingerprint
//! come from QC_LIVE_* environment variables; never from repository fixtures.

use super::*;
use serde_json::json;

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required for live acceptance"))
}

fn config() -> SshConnectionConfig {
    let private_key_path = std::env::var("QC_LIVE_PRIVATE_KEY")
        .ok()
        .filter(|path| !path.trim().is_empty());
    let (auth_kind, password) = if private_key_path.is_some() {
        ("privateKey", None)
    } else {
        ("password", Some(required("QC_LIVE_PASSWORD")))
    };
    SshConnectionConfig {
        id: format!("live-{}", uuid::Uuid::new_v4()),
        host: required("QC_LIVE_HOST"),
        port: std::env::var("QC_LIVE_PORT")
            .unwrap_or_else(|_| "22".into())
            .parse()
            .expect("QC_LIVE_PORT"),
        username: required("QC_LIVE_USER"),
        auth_kind: auth_kind.into(),
        password,
        private_key_path,
        passphrase: std::env::var("QC_LIVE_PASSPHRASE").ok(),
        host_key_fingerprint: Some(required("QC_LIVE_FINGERPRINT")),
        mode: Some(RemoteMode::Server),
    }
}

fn percentiles(mut values: Vec<f64>) -> serde_json::Value {
    values.sort_by(f64::total_cmp);
    let at = |p: f64| values[((values.len() - 1) as f64 * p).ceil() as usize];
    json!({"count": values.len(), "p50_ms": at(0.5), "p95_ms": at(0.95), "max_ms": at(1.0)})
}

fn check(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.to_string())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires explicitly authorized QC_LIVE_* SSH target and verified fingerprint"]
async fn live_backend_sftp_trust_pool_concurrency_and_reconnect() {
    tokio::time::timeout(Duration::from_secs(180), run())
        .await
        .expect("live backend acceptance exceeded 180s")
        .unwrap();
}

async fn run() -> Result<(), String> {
    let config = config();
    let manager = Arc::new(SshManager::new());
    let started = Instant::now();

    let mut wrong_key = config.clone();
    wrong_key.host_key_fingerprint = Some("SHA256:deliberately-wrong-live-test-key".into());
    let rejection = match authenticate_session(wrong_key, ConnectionPurpose::Main).await {
        Err(error) => error,
        Ok(_) => return Err("changed host fingerprint was accepted".into()),
    };
    check(
        rejection.contains("Unknown server key"),
        &format!(
            "changed fingerprint rejection not verified (infrastructure failure): {rejection}"
        ),
    )?;
    let (original, fingerprint) = store_authenticated_session(&manager, config.clone()).await?;
    println!("LIVE_STAGE authenticated");
    assert_eq!(Some(&fingerprint), config.host_key_fingerprint.as_ref());
    let sftp = manager.open_sftp(&config.id).await?;
    let parent = sftp
        .canonicalize(required("QC_LIVE_PARENT"))
        .await
        .map_err(|e| e.to_string())?;
    let directory = join_remote_path(&parent, &format!("qingcode-live-{}", uuid::Uuid::new_v4()));
    sftp.create_dir(directory.clone())
        .await
        .map_err(|e| e.to_string())?;
    let canonical = sftp
        .canonicalize(directory.clone())
        .await
        .map_err(|e| e.to_string())?;
    let root_uri = format!("ssh://{}{canonical}", config.id);
    manager.roots.write().unwrap().insert(
        root_uri.clone(),
        RegisteredRoot {
            uri: root_uri.clone(),
            canonical_path: canonical.clone(),
            trusted: false,
        },
    );

    let result = exercise(&manager, &config.id, &root_uri, &canonical).await;
    // Never delete the parent supplied by the caller. Only this newly-created,
    // canonicalized UUID directory is eligible for cleanup.
    assert!(remote_path_is_within(&canonical, &parent));
    assert!(canonical
        .rsplit('/')
        .next()
        .unwrap()
        .starts_with("qingcode-live-"));
    let cleanup = match manager.open_sftp(&config.id).await {
        Ok(current_sftp) => remove_remote_tree(&current_sftp, canonical.clone()).await,
        Err(error) => Err(error),
    };
    if let Ok(current) = manager.session(&config.id) {
        close_terminal_transport(&current).await;
    }
    close_terminal_transport(&original).await;
    result?;
    cleanup?;
    println!(
        "LIVE_BACKEND {}",
        json!({"ok": true, "host": config.host,
        "elapsed_seconds": started.elapsed().as_secs_f64(), "temporary_root_removed": true})
    );
    Ok(())
}

async fn exercise(
    manager: &Arc<SshManager>,
    id: &str,
    uri: &str,
    root_path: &str,
) -> Result<(), String> {
    check(
        manager.root_for_uri(uri, true).is_err(),
        "untrusted root accepted writes",
    )?;
    manager.set_root_trust(uri, true)?;
    let root = manager.root_for_uri(uri, true)?;
    assert!(manager.server_mode(id));
    let sftp = manager.open_sftp(id).await?;
    println!("LIVE_STAGE trust and canonical path checks");
    check(
        ensure_existing_path_within(&sftp, &format!("{root_path}/.."), &root)
            .await
            .is_err(),
        "canonical parent escape accepted",
    )?;
    assert!(Arc::ptr_eq(&sftp, &manager.open_sftp(id).await?));

    let path = join_remote_path(root_path, "中文-roundtrip.txt");
    ensure_parent_path_within(&sftp, &path, &root).await?;
    let content = "QingCode live acceptance\n中文 UTF-8\n".repeat(100);
    write_remote_file_contents(&sftp, path.clone(), content.as_bytes(), true).await?;
    ensure_existing_path_within(&sftp, &path, &root).await?;
    assert_eq!(
        sftp.read(path.clone()).await.map_err(|e| e.to_string())?,
        content.as_bytes()
    );
    let renamed = join_remote_path(root_path, "renamed.txt");
    sftp.rename(path.clone(), renamed.clone())
        .await
        .map_err(|e| e.to_string())?;
    assert!(!sftp.try_exists(path).await.map_err(|e| e.to_string())?);
    let outside_link = join_remote_path(root_path, "escape");
    sftp.symlink(
        remote_parent_path(root_path)?.to_string(),
        outside_link.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;
    assert!(ensure_existing_path_within(&sftp, &outside_link, &root)
        .await
        .is_err());
    assert!(
        ensure_parent_path_within(&sftp, &format!("{outside_link}/rejected.txt"), &root)
            .await
            .is_err()
    );
    remove_remote_tree(&sftp, outside_link).await?;
    println!("LIVE_STAGE roundtrip, rename and symlink checks passed");

    let mut writes = tokio::task::JoinSet::new();
    for i in 0..16 {
        let shared = Arc::clone(&sftp);
        let root = root.clone();
        let target = join_remote_path(root_path, &format!("concurrent-{i}.txt"));
        writes.spawn(async move {
            let t = Instant::now();
            let bytes = format!("worker-{i}\n").repeat(1000).into_bytes();
            ensure_parent_path_within(&shared, &target, &root).await?;
            write_remote_file_contents(&shared, target.clone(), &bytes, true)
                .await
                .map_err(|e| format!("SFTP worker {i} write: {e}"))?;
            ensure_existing_path_within(&shared, &target, &root).await?;
            let actual = shared
                .read(target)
                .await
                .map_err(|e| format!("SFTP worker {i} read: {e}"))?;
            if actual != bytes {
                return Err("SFTP roundtrip mismatch".to_string());
            }
            Ok::<_, String>(t.elapsed().as_secs_f64() * 1000.0)
        });
    }
    let mut sftp_latencies = Vec::new();
    while let Some(done) = writes.join_next().await {
        sftp_latencies.push(done.map_err(|e| e.to_string())??);
    }
    println!("LIVE_STAGE 16 concurrent SFTP roundtrips passed");

    // A safe top-level source directory can still contain an escaping file
    // link. Use a nested source root and our own sibling marker, never user data.
    let copy_source = join_remote_path(root_path, "copy-source");
    let copy_dest = join_remote_path(root_path, "copy-result");
    let copy_marker = join_remote_path(root_path, "copy-outside-marker.txt");
    sftp.create_dir(copy_source.clone())
        .await
        .map_err(|e| e.to_string())?;
    write_remote_file_contents(&sftp, copy_marker.clone(), b"own outside marker", true).await?;
    sftp.symlink(
        copy_marker,
        join_remote_path(&copy_source, "nested-link.txt"),
    )
    .await
    .map_err(|e| e.to_string())?;
    let source_root = RegisteredRoot {
        uri: format!("{uri}/copy-source"),
        canonical_path: copy_source.clone(),
        trusted: true,
    };
    check(
        copy_remote_tree(&sftp, copy_source, copy_dest.clone(), &source_root)
            .await
            .is_err(),
        "recursive copy followed a file link outside its source project",
    )?;
    check(
        !sftp
            .try_exists(join_remote_path(&copy_dest, "nested-link.txt"))
            .await
            .map_err(|e| e.to_string())?,
        "recursive copy created outside marker content",
    )?;
    println!("LIVE_STAGE recursive copy rejects nested source escape");

    let native_windows = windows_native_path(root_path).is_some();
    let mut commands = tokio::task::JoinSet::new();
    for i in 0..24 {
        let manager = Arc::clone(manager);
        let uri = uri.to_string();
        commands.spawn(async move {
            let t = Instant::now();
            let expected = format!("qc-native-{i}");
            let result = manager
                .exec_remote_shell(
                    &uri,
                    &format!("printf '%s' '{expected}'"),
                    &format!("[Console]::Write('{expected}')"),
                    true,
                    Duration::from_secs(20),
                )
                .await?;
            if result.exit_code != 0 || result.stdout.trim() != expected {
                return Err(format!(
                    "command {i} mismatch: {} {}",
                    result.stdout, result.stderr
                ));
            }
            Ok::<_, String>(t.elapsed().as_secs_f64() * 1000.0)
        });
    }
    let mut exec_latencies = Vec::new();
    while let Some(done) = commands.join_next().await {
        exec_latencies.push(done.map_err(|e| e.to_string())??);
    }
    println!("LIVE_STAGE 24 concurrent commands passed");
    let mut git_available = false;
    if !native_windows {
        git_available = manager
            .exec_uri(uri, "command -v git", false)
            .await?
            .exit_code
            == 0;
    }
    if git_available {
        let git = remote_git_command(manager, uri, vec!["init".into()], true).await?;
        assert_eq!(git.exit_code, 0, "{}", git.stderr);
        let status = remote_git_command(
            manager,
            uri,
            vec!["status".into(), "--porcelain".into()],
            false,
        )
        .await?;
        assert_eq!(status.exit_code, 0, "{}", status.stderr);
        assert!(status.stdout.contains("renamed.txt"));
    }

    let mut leases = Vec::new();
    let mut channels = Vec::new();
    let pool_started = Instant::now();
    for _ in 0..16 {
        let lease = manager.lease_daemon_terminal_transport(id, uri).await?;
        let channel = open_session_channel_once(&lease, "live acceptance pool")
            .await
            .map_err(|e| e.message)?;
        leases.push(lease);
        channels.push(channel);
    }
    println!("LIVE_STAGE 16 pooled channels opened");
    let pool = Arc::clone(
        manager
            .terminal_transport_pools
            .lock()
            .unwrap()
            .get(id)
            .unwrap(),
    );
    let (transport_count, capacity) = {
        let state = pool.lock().await;
        assert_eq!(
            state
                .entries
                .iter()
                .map(|entry| entry.leased)
                .sum::<usize>(),
            16
        );
        assert!(state
            .entries
            .iter()
            .all(|entry| entry.leased <= entry.capacity));
        (
            state.entries.len(),
            state.limit.unwrap().transport_capacity(),
        )
    };
    let main = manager.session(id)?;
    assert!(leases
        .iter()
        .all(|lease| !Arc::ptr_eq(&main, &lease.transport)));
    for channel in channels {
        let _ = channel.close().await;
    }
    drop(leases);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !pool.lock().await.entries.is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        pool.lock().await.entries.is_empty(),
        "terminal pool leaked leases"
    );
    println!("LIVE_STAGE terminal pool released");
    let pool_elapsed_ms = pool_started.elapsed().as_secs_f64() * 1000.0;

    // Force the cooldown branch without provoking an actual failed handshake.
    // Main-connection terminals must leave room for concurrent commands/SFTP.
    pool.lock().await.handshake_failure = Some((Instant::now(), "live budget test".into()));
    let mut fallback_leases = Vec::new();
    let mut fallback_channels = Vec::new();
    for _ in 0..TERMINAL_MAIN_FALLBACK_LIMIT {
        let lease = manager.lease_daemon_terminal_transport(id, uri).await?;
        check(
            lease.main_fallback,
            "forced cooldown did not use main connection",
        )?;
        fallback_channels.push(
            open_session_channel_once(&lease, "live fallback budget")
                .await
                .map_err(|e| e.message)?,
        );
        fallback_leases.push(lease);
    }
    let slots = manager.exec_slots(id)?;
    assert_eq!(
        slots.available_permits(),
        MAX_CONCURRENT_EXEC_CHANNELS - TERMINAL_MAIN_FALLBACK_LIMIT
    );
    let mut fallback_commands = tokio::task::JoinSet::new();
    for _ in 0..MAX_CONCURRENT_EXEC_CHANNELS {
        let manager = Arc::clone(manager);
        let uri = uri.to_string();
        fallback_commands.spawn(async move {
            manager
                .exec_remote_shell(
                    &uri,
                    "sleep 0.05; printf 'budget-ok'",
                    "Start-Sleep -Milliseconds 50; [Console]::Write('budget-ok')",
                    true,
                    Duration::from_secs(20),
                )
                .await
        });
    }
    assert_eq!(
        sftp.read(renamed.clone())
            .await
            .map_err(|e| e.to_string())?,
        content.as_bytes()
    );
    while let Some(result) = fallback_commands.join_next().await {
        let result = result.map_err(|e| e.to_string())??;
        check(
            result.exit_code == 0 && result.stdout == "budget-ok",
            "command failed alongside main terminal fallbacks",
        )?;
    }
    for channel in fallback_channels {
        let _ = channel.close().await;
    }
    for lease in &fallback_leases {
        lease.release();
        lease.release();
    }
    // A released lease may remain alive in a reconnect loop. Return permits
    // immediately and only once, without requiring the lease object to drop.
    assert_eq!(slots.available_permits(), MAX_CONCURRENT_EXEC_CHANNELS);
    drop(fallback_leases);
    pool.lock().await.handshake_failure = None;
    check(
        !main.handle.is_closed(),
        "fallback release disconnected main SSH",
    )?;
    println!("LIVE_STAGE main fallback terminals share command budget and preserve SFTP");

    close_terminal_transport(&main).await;
    // disconnect() queues the SSH message; wait for the transport to actually
    // close before testing recovery from a confirmed loss (rather than racing
    // a still-live connection that is only scheduled to close).
    let disconnect_deadline = Instant::now() + Duration::from_secs(5);
    while !main.handle.is_closed() && Instant::now() < disconnect_deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    check(main.handle.is_closed(), "main transport did not close")?;
    println!("LIVE_STAGE main connection confirmed disconnected");
    let resumed = manager.open_sftp(id).await?;
    assert_eq!(
        resumed
            .read(renamed)
            .await
            .map_err(|e| format!("reconnected SFTP read: {e}"))?,
        content.as_bytes()
    );
    assert!(!Arc::ptr_eq(&main, &manager.session(id)?));
    manager.set_root_trust(uri, false)?;
    assert!(manager.root_for_uri(uri, true).is_err());
    println!(
        "LIVE_BACKEND_METRICS {}",
        json!({
            "sftp": percentiles(sftp_latencies), "exec": percentiles(exec_latencies),
            "pool": {"channels": 16, "ssh_transports": transport_count, "capacity": capacity,
                "elapsed_ms": pool_elapsed_ms, "released": true},
            "trust_denial": true, "changed_fingerprint_rejected": true,
        "symlink_escape_rejected": true, "main_reconnect": true, "git_available": git_available,
        "main_fallback_shared_budget": true
        })
    );
    Ok(())
}
