//! Explicitly enabled native-client acceptance. Pairing credentials stay in a
//! private configuration file; tests never print them or alter a running daemon.
use super::*;
use crate::remote_ssh::{self, direct::*, server, RegisteredRoot, SshManager};
use qingcode_server::proto::{self, Frame, HelloRequest, HelloResponse, Kind, PROTOCOL_VERSION};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    direct: DirectConnectionConfig,
    root: String,
    ssh: Option<remote_ssh::SshConnectionConfig>,
    daemon_bin: Option<String>,
    daemon_token: Option<String>,
    #[serde(default = "default_git_available")]
    git_available: bool,
}

fn default_git_available() -> bool {
    true
}

fn target() -> Target {
    serde_json::from_slice(
        &std::fs::read(std::env::var("QC_DIRECT_PARITY_CONFIG").unwrap()).unwrap(),
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "requires authorized QC_DIRECT_PARITY_CONFIG with private pairing credentials"]
async fn live_direct_workspace_and_daemon_scan() {
    let target = target();
    let health = test(&target.direct).await.unwrap();
    let mut stream = open_stream_for(&target.direct, "live-parity-probe")
        .await
        .unwrap();
    proto::write_frame(
        &mut stream,
        &Frame::new(
            Kind::Hello,
            0,
            proto::encode(&HelloRequest {
                client_id: "live-parity-probe".into(),
                protocol_min: PROTOCOL_VERSION,
                protocol_max: PROTOCOL_VERSION,
                token: target.direct.token.clone(),
                resume_token: None,
            })
            .unwrap(),
        ),
    )
    .await
    .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(15), proto::read_frame(&mut stream))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame.kind, Kind::Hello);
    let hello: HelloResponse = proto::decode_value(&frame.payload).unwrap();
    println!(
        "LIVE_DIRECT_VERSIONS gateway={} daemon={} client={}",
        health.server_version,
        hello.server_version,
        qingcode_server::SERVER_VERSION
    );
    close_connection(&target.direct.endpoint, "live-parity-probe");
    let canonical = workspace_request(
        &target.direct,
        &serde_json::json!({"op":"canonicalize","path":target.root}),
    )
    .await
    .unwrap()
    .as_str()
    .unwrap()
    .to_string();
    let uri = format!("ssh://live-direct-parity{canonical}");
    let manager = SshManager::new();
    manager
        .direct_connections
        .write()
        .unwrap()
        .insert("live-direct-parity".into(), target.direct.clone());
    manager
        .direct_active
        .write()
        .unwrap()
        .insert("live-direct-parity".into());
    manager.roots.write().unwrap().insert(
        uri.clone(),
        RegisteredRoot {
            uri: uri.clone(),
            canonical_path: canonical.clone(),
            trusted: true,
        },
    );
    let nodes = remote_ssh::direct_scan_directory(&manager, &uri, None, Some(&[]))
        .await
        .unwrap()
        .unwrap();
    println!("LIVE_DIRECT_HTTPS_SCAN_OK entries={}", nodes.len());
    let daemon = server::DaemonAccess {
        bin: "direct".into(),
        token: target.direct.token,
    };
    let mut entries =
        server::daemon_scan_entries(&manager, "live-direct-parity", &daemon, &canonical, "")
            .await
            .unwrap_or_else(|error| panic!("LIVE_DIRECT_DAEMON_SCAN_FAILED {error}"));
    entries.sort();
    let mut expected: Vec<_> = nodes
        .into_iter()
        .map(|node| (node.name, node.is_dir))
        .collect();
    expected.sort();
    assert_eq!(entries, expected);
    println!("LIVE_DIRECT_DAEMON_SCAN_OK entries={}", entries.len());
    close_connection(&target.direct.endpoint, "live-direct-parity");
}

async fn write_file(fs: &remote_ssh::SftpSession, path: &str, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs.create(path).await.map_err(|e| e.to_string())?;
    file.write_all(bytes).await.map_err(|e| e.to_string())?;
    file.close().await.map_err(|e| e.to_string())
}

async fn session(
    manager: &SshManager,
    id: &str,
    daemon: &DaemonAccess,
) -> Result<DaemonSession, String> {
    let client = manager.daemon_client_id(id);
    if let Some(config) = manager.direct_config(id) {
        DaemonSession::open_direct(&config, id, &client, daemon).await
    } else {
        let transport = manager.session(id)?;
        DaemonSession::open_on_transport(&transport, &client, daemon).await
    }
}

async fn verify_services(
    manager: &SshManager,
    root: &RegisteredRoot,
    daemon: &DaemonAccess,
    git_available: bool,
) -> Result<(), String> {
    let id = remote_ssh::parse_remote_uri(&root.uri)?.connection_id;
    let (fs, _, _) = manager.sftp_for_uri(&root.uri, true).await?;
    let nested = ".claude/worktrees/report-allure-status";
    let entries = daemon_scan_entries(manager, &id, daemon, &root.canonical_path, nested)
        .await
        .map_err(|e| e.to_string())?;
    if !entries
        .iter()
        .any(|(name, dir)| name == "readme.txt" && !dir)
    {
        return Err("worktree directory scan lost a file".into());
    }
    let mut records = Vec::new();
    daemon_search_content_call(
        manager,
        &id,
        daemon,
        DaemonSearchParams {
            root: format!("{}/{nested}", root.canonical_path),
            query: "needle-live-parity".into(),
            ignore_case: false,
            include_globs: vec!["*.txt".into()],
            exclude_globs: vec![],
            no_ignore: true,
            max_matches: 10,
            max_per_file: 10,
            max_files: 100,
        },
        Instant::now() + Duration::from_secs(20),
        || false,
        |record| {
            records.push(record.clone());
            true
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    if !records.iter().any(|record| record["type"] == "match") {
        return Err("content search lost the fixture match".into());
    }
    println!("LIVE_PARITY_STAGE {id} nested-scan search-ok");
    if git_available {
        let result = remote_ssh::remote_git_command(
            manager,
            &root.uri,
            vec!["status".into(), "--porcelain".into(), "-uall".into()],
            false,
        )
        .await?;
        if result.exit_code != 0 || !result.stdout.contains("readme.txt") {
            return Err(format!(
                "Git status did not see the fixture: {}",
                result.stderr
            ));
        }
    } else {
        println!("LIVE_PARITY_SKIP {id} Git-not-installed");
    }
    let mut watch = open_daemon_channel(manager, &id, daemon).await?;
    let watch_result: Result<(), String> = async {
        let response = daemon_rpc(
            &mut watch,
            "watch.subscribe",
            &serde_json::json!({"root":root.canonical_path}),
            Instant::now() + Duration::from_secs(15),
        )
        .await
        .map_err(|e| e.to_string())?;
        if response["subscribed"] != true {
            return Err("watch subscription rejected".to_string());
        }
        // The real watcher suppresses its first 500 ms of registration noise.
        tokio::time::sleep(Duration::from_millis(650)).await;
        let marker = format!("event-{id}.txt");
        write_file(&fs, &format!("{}/{marker}", root.canonical_path), b"watch").await?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let frame = watch.next_frame(deadline).await?;
            if frame.kind != Kind::Event {
                continue;
            }
            if let Event::FsChange { path, .. } =
                proto::decode_value::<Event>(&frame.payload).map_err(|e| e.to_string())?
            {
                if path.replace('\\', "/").ends_with(&marker) {
                    if super::super::watch::ssh_uri_for_watch_event(
                        &root.uri,
                        &root.canonical_path,
                        &path,
                    )
                    .is_none()
                    {
                        return Err("watch event could not map to the workspace URI".into());
                    }
                    break;
                }
            }
        }
        Ok(())
    }
    .await;
    watch.shutdown().await;
    watch_result?;
    println!("LIVE_PARITY_STAGE {id} watch-event-ok");

    let first = session(manager, &id, daemon).await?;
    let info = first.request("server.info", &serde_json::json!({})).await?;
    let shell = if remote_ssh::windows_native_path(&root.canonical_path).is_some() {
        "cmd.exe"
    } else {
        "/bin/sh"
    };
    let created = first
        .request(
            "pty.create",
            &serde_json::json!({"cwd":root.canonical_path,"shell":shell,"cols":80,"rows":24}),
        )
        .await?;
    let pty = created["id"].as_str().ok_or("missing PTY id")?.to_string();
    first.shutdown();
    let resumed = session(manager, &id, daemon).await?;
    let result: Result<(), String> = async {
        let current = resumed
            .request("server.info", &serde_json::json!({}))
            .await?;
        if current["pid"] != info["pid"] {
            return Err("daemon was replaced while reconnecting".into());
        }
        let listed = resumed.request("pty.list", &serde_json::json!({})).await?;
        if !listed["ptys"]
            .as_array()
            .ok_or("invalid PTY list")?
            .iter()
            .any(|item| item["id"] == pty)
        {
            return Err("PTY did not survive reconnect".into());
        }
        let attached = resumed.attach(&pty, 0).await?;
        if !attached.stream_end.ok {
            return Err("PTY reattach failed".into());
        }
        Ok(())
    }
    .await;
    let killed = resumed
        .request("pty.kill", &serde_json::json!({"id":pty}))
        .await;
    resumed.shutdown();
    result?;
    killed?;
    println!(
        "LIVE_PARITY_OK {id}: nested-scan content-search Git={} watch-event PTY-reconnect same-daemon",
        if git_available { "passed" } else { "unavailable" }
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires authorized QC_DIRECT_PARITY_CONFIG; creates and removes one UUID project"]
async fn live_ssh_service_and_direct_port_match_on_disposable_project() {
    let target = target();
    let manager = SshManager::new();
    manager
        .direct_connections
        .write()
        .unwrap()
        .insert("live-direct-parity".into(), target.direct.clone());
    manager
        .direct_active
        .write()
        .unwrap()
        .insert("live-direct-parity".into());
    let fs =
        remote_ssh::SftpSession::direct(target.direct.clone(), Some(target.root.clone()), true);
    let path = format!("{}/qingcode-parity-{}", target.root, uuid::Uuid::new_v4());
    fs.create_dir(&path).await.unwrap();
    let canonical = fs.canonicalize(&path).await.unwrap();
    println!("LIVE_PARITY_TEMP {canonical}");
    let root = RegisteredRoot {
        uri: format!("ssh://live-direct-parity{canonical}"),
        canonical_path: canonical.clone(),
        trusted: true,
    };
    manager
        .roots
        .write()
        .unwrap()
        .insert(root.uri.clone(), root.clone());
    let result: Result<(), String> = async {
        for rel in [
            ".claude",
            ".claude/worktrees",
            ".claude/worktrees/report-allure-status",
        ] {
            fs.create_dir(format!("{canonical}/{rel}"))
                .await
                .map_err(|e| e.to_string())?;
        }
        write_file(
            &fs,
            &format!("{canonical}/.claude/worktrees/report-allure-status/readme.txt"),
            b"needle-live-parity\n",
        )
        .await?;
        if target.git_available {
            let init =
                remote_ssh::remote_git_command(&manager, &root.uri, vec!["init".into()], true)
                    .await?;
            if init.exit_code != 0 {
                return Err(format!("fixture Git init failed: {}", init.stderr));
            }
        }
        let nodes = remote_ssh::direct_scan_directory(
            &manager,
            &format!("{}/.claude/worktrees/report-allure-status", root.uri),
            Some(&root.uri),
            Some(&[]),
        )
        .await?
        .ok_or("direct scan was not routed")?;
        if nodes.len() != 1 || nodes[0].name != "readme.txt" {
            return Err("HTTPS nested directory listing did not match fixture".into());
        }
        let daemon = DaemonAccess {
            bin: "direct".into(),
            token: target.direct.token.clone(),
        };
        verify_services(&manager, &root, &daemon, target.git_available).await?;
        if let Some(mut config) = target.ssh {
            config.host_key_fingerprint = Some(
                remote_ssh::ssh_probe_host(config.clone())
                    .await?
                    .fingerprint,
            );
            let id = config.id.clone();
            let (transport, _) = remote_ssh::store_authenticated_session(&manager, config).await?;
            let ssh_root = RegisteredRoot {
                uri: format!("ssh://{id}{canonical}"),
                ..root.clone()
            };
            manager
                .roots
                .write()
                .unwrap()
                .insert(ssh_root.uri.clone(), ssh_root.clone());
            let access = DaemonAccess {
                bin: target.daemon_bin.ok_or("SSH daemon binary missing")?,
                token: target.daemon_token.ok_or("SSH daemon token missing")?,
            };
            let result = verify_services(&manager, &ssh_root, &access, target.git_available).await;
            remote_ssh::close_terminal_transport(&transport).await;
            result?;
        }
        Ok(())
    }
    .await;
    let cleanup = remote_ssh::remove_remote_tree(&fs, canonical).await;
    close_connection(&target.direct.endpoint, "live-direct-parity");
    assert!(
        cleanup.is_ok(),
        "disposable project cleanup failed: {cleanup:?}; services: {result:?}"
    );
    result.expect("live transport parity failed");
    println!("LIVE_PARITY_CLEANUP_OK temporary-project-removed");
}
