//! Opt-in cloud-host acceptance with encrypted, delayed TCP forwarding.
//! Only this test's sockets, UUID project and PTY are changed; no host network
//! rules, SSH sessions, gateway process or other terminal is modified.

use super::*;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};

const ONE_WAY_DELAY: Duration = Duration::from_millis(50);

struct FaultProxy {
    endpoint: String,
    cut: watch::Sender<u64>,
    task: JoinHandle<()>,
}

impl FaultProxy {
    async fn start(upstream: &str) -> Result<Self, String> {
        let url = url::Url::parse(upstream).map_err(|e| e.to_string())?;
        let host = url
            .host_str()
            .ok_or("cloud endpoint has no host")?
            .trim_matches(['[', ']'])
            .to_string();
        let port = url
            .port_or_known_default()
            .ok_or("cloud endpoint has no port")?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        let (cut, _) = watch::channel(0u64);
        let cuts = cut.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((local, _)) = accepted else { break };
                        let host = host.clone();
                        let mut interrupted = cuts.subscribe();
                        connections.spawn(async move {
                            tokio::select! {
                                _ = interrupted.changed() => {},
                                _ = async {
                                    let remote = TcpStream::connect((host.as_str(), port)).await?;
                                    let _ = local.set_nodelay(true);
                                    let _ = remote.set_nodelay(true);
                                    let (local_read, local_write) = local.into_split();
                                    let (remote_read, remote_write) = remote.into_split();
                                    tokio::try_join!(
                                        delayed_copy(local_read, remote_write),
                                        delayed_copy(remote_read, local_write),
                                    )?;
                                    Ok::<(), std::io::Error>(())
                                } => {},
                            }
                        });
                    },
                    _ = connections.join_next(), if !connections.is_empty() => {},
                }
            }
        });
        Ok(Self {
            endpoint: format!("https://{address}"),
            cut,
            task,
        })
    }

    fn disconnect(&self) {
        self.cut.send_modify(|generation| *generation += 1);
    }
}

impl Drop for FaultProxy {
    fn drop(&mut self) {
        // Dropping the listener task also drops its JoinSet and cancels every
        // bridge, including ones still connecting or sleeping in delayed_copy.
        self.task.abort();
    }
}

async fn delayed_copy<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    mut source: R,
    mut destination: W,
) -> std::io::Result<()> {
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let length = source.read(&mut buffer).await?;
        if length == 0 {
            destination.shutdown().await?;
            return Ok(());
        }
        tokio::time::sleep(ONE_WAY_DELAY).await;
        destination.write_all(&buffer[..length]).await?;
        destination.flush().await?;
    }
}

async fn output_contains(events: &mut SessionEventReceiver, marker: &str) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut output = Vec::new();
        while let Some(event) = events.recv().await {
            if let Event::PtyData { data, .. } = event {
                output.extend_from_slice(&data);
                if String::from_utf8_lossy(&output).contains(marker) {
                    return Ok(());
                }
            }
        }
        Err("PTY event stream ended before command output".to_string())
    })
    .await
    .map_err(|_| "PTY command output timed out".to_string())?
}

async fn wait_for_gateway_restart(
    daemon_pid: &serde_json::Value,
    pty_id: &str,
) -> Result<bool, String> {
    let Some(directory) = std::env::var_os("QC_CLOUD_RESTART_BARRIER_DIR") else {
        return Ok(false);
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let continued = directory.join("continue");
    if continued.exists() {
        return Err(
            "cloud restart barrier already contains continue; use a fresh directory".into(),
        );
    }
    let payload = serde_json::to_vec(&serde_json::json!({
        "daemonPid": daemon_pid, "ptyId": pty_id,
    }))
    .map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut ready = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join("ready.json"))
            .map_err(|e| e.to_string())?;
        ready.write_all(&payload).map_err(|e| e.to_string())?;
    }
    println!("LIVE_CLOUD_RESTART_READY waiting-for-operator-gateway-restart");
    tokio::time::timeout(Duration::from_secs(60), async {
        while !continued.exists() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "operator gateway restart did not complete within 60 seconds".to_string())?;
    Ok(true)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires authorized Linux QC_DIRECT_PARITY_CONFIG; creates and removes a UUID project/PTY"]
async fn live_direct_cloud_latency_disconnect_and_security() {
    let target = target();
    let started = Instant::now();
    let proxy = FaultProxy::start(&target.direct.endpoint).await.unwrap();
    let mut config = target.direct.clone();
    config.endpoint = proxy.endpoint.clone();
    let id = format!("cloud-{}", uuid::Uuid::new_v4());
    let client_id = id.clone();
    let daemon = DaemonAccess {
        bin: "direct".into(),
        token: config.token.clone(),
    };
    let cleanup_fs =
        remote_ssh::SftpSession::direct(target.direct.clone(), Some(target.root.clone()), true);
    let path = format!("{}/qingcode-{id}", target.root.trim_end_matches('/'));
    let mut created_project = false;
    let mut pty_id: Option<String> = None;
    let result: Result<(), String> = async {
        let health = test(&config).await?;
        require_current_version(&health)?;
        let mut wrong_token = config.clone();
        wrong_token.token = format!("invalid-{}", uuid::Uuid::new_v4());
        if !test(&wrong_token)
            .await
            .err()
            .is_some_and(|error| error.contains("[direct:auth]"))
        {
            return Err("wrong pairing token was not rejected as authentication failure".into());
        }
        let mut wrong_identity = config.clone();
        wrong_identity.certificate_fingerprint = if config.certificate_fingerprint == "0".repeat(64) {
            "1".repeat(64)
        } else {
            "0".repeat(64)
        };
        if !test(&wrong_identity)
            .await
            .err()
            .is_some_and(|error| error.contains("[direct:identity]"))
        {
            return Err("wrong pinned certificate was not rejected as identity failure".into());
        }
        println!("LIVE_CLOUD_OK token-and-certificate-rejection");

        let parent_fs = remote_ssh::SftpSession::direct(config.clone(), Some(target.root.clone()), true);
        parent_fs.create_dir(&path).await.map_err(|e| e.to_string())?;
        created_project = true;
        let canonical = parent_fs.canonicalize(&path).await.map_err(|e| e.to_string())?;
        let fs = remote_ssh::SftpSession::direct(config.clone(), Some(canonical.clone()), true);
        let untrusted = remote_ssh::SftpSession::direct(config.clone(), Some(canonical.clone()), false);
        if !untrusted.create(format!("{canonical}/untrusted.txt"))
            .await.err().is_some_and(|error| error.to_string().contains("项目未信任")) {
            return Err("untrusted file creation did not return the trust denial".into());
        }
        if !fs.metadata(target.root.clone()).await.err()
            .is_some_and(|error| error.to_string().contains("越出项目根")) {
            return Err("metadata outside the registered project root did not return the boundary denial".into());
        }
        // The fixture parent can create this link, but the nested project may
        // not follow it back out to the parent workspace.
        let escape = format!("{canonical}/escape");
        parent_fs.symlink(target.root.clone(), escape.clone()).await.map_err(|e| e.to_string())?;
        if !fs.metadata(escape).await.err()
            .is_some_and(|error| error.to_string().contains("越出项目根")) {
            return Err("symlink outside the registered project root did not return the boundary denial".into());
        }
        println!("LIVE_CLOUD_OK untrusted-write-root-escape-and-symlink-rejection");

        let payload: Vec<u8> = (0..1024 * 1024).map(|index| (index % 251) as u8).collect();
        let digest = Sha256::digest(&payload);
        let transfer_started = Instant::now();
        let payload_path = format!("{canonical}/cloud-payload.bin");
        write_file(&fs, &payload_path, &payload).await?;
        let downloaded = fs.read(&payload_path).await.map_err(|e| e.to_string())?;
        if downloaded != payload {
            return Err("1 MiB file round-trip content mismatch".into());
        }
        println!(
            "LIVE_CLOUD_OK file-roundtrip bytes={} sha256={digest:x} elapsed_ms={}",
            payload.len(), transfer_started.elapsed().as_millis(),
        );

        let mut first = DaemonSession::open_direct(&config, &id, &client_id, &daemon).await?;
        let before = first.request("server.info", &serde_json::json!({})).await?;
        let created = first.request("pty.create", &serde_json::json!({
            "cwd":canonical,"shell":"/bin/sh","cols":100,"rows":30,
        })).await?;
        let pty = created["id"].as_str().ok_or("missing PTY id")?.to_string();
        pty_id = Some(pty.clone());
        let mut events = first.take_events().ok_or("missing initial PTY events")?;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let before_marker = format!("QC_CLOUD_BEFORE_{suffix}");
        // The complete output marker never occurs in echoed shell input.
        let command = format!("printf '\\nQC_CLOUD_%s\\n' 'BEFORE_{suffix}'\n");
        first.request("pty.input", &serde_json::json!({
            "id":pty,"seq":0,"data":command.as_bytes(),
        })).await?;
        output_contains(&mut events, &before_marker).await?;

        let offline_marker = format!("QC_CLOUD_OFFLINE_{suffix}");
        let command = format!("sleep 2; printf '\\nQC_CLOUD_%s\\n' 'OFFLINE_{suffix}'\n");
        first.request("pty.input", &serde_json::json!({
            "id":pty,"seq":1,"data":command.as_bytes(),
        })).await?;
        proxy.disconnect();
        tokio::time::timeout(Duration::from_secs(10), first.wait_closed())
            .await.map_err(|_| "fault proxy did not interrupt the live WSS session")?;
        first.shutdown();
        // The queued command finishes while no client owns its network bridge.
        tokio::time::sleep(Duration::from_secs(3)).await;
        let gateway_restarted = wait_for_gateway_restart(&before["pid"], &pty).await?;
        let mut resumed = DaemonSession::open_direct(&config, &id, &client_id, &daemon).await?;
        let after = resumed.request("server.info", &serde_json::json!({})).await?;
        if after["pid"] != before["pid"] {
            return Err("daemon PID changed after simulated network loss".into());
        }
        let attached = resumed.attach(&pty, 0).await?;
        if !attached.stream_end.ok || attached.response.get("exited").is_some_and(|v| !v.is_null()) {
            return Err("original PTY did not survive simulated network loss".into());
        }
        let restored = attached.response["screen"].as_str().unwrap_or_default().to_string()
            + &attached.chunks.iter().map(|chunk| String::from_utf8_lossy(&chunk.data)).collect::<String>();
        if !restored.contains(&offline_marker) {
            return Err("reattach did not replay command output produced while disconnected".into());
        }
        let seq = attached.response["nextInputSeq"].as_u64().ok_or("missing input sequence")?;
        let mut events = resumed.take_events().ok_or("missing resumed PTY events")?;
        let after_marker = format!("QC_CLOUD_AFTER_{suffix}");
        let command = format!("printf '\\nQC_CLOUD_%s\\n' 'AFTER_{suffix}'\n");
        resumed.request("pty.input", &serde_json::json!({
            "id":pty,"seq":seq,"data":command.as_bytes(),
        })).await?;
        output_contains(&mut events, &after_marker).await?;
        resumed.shutdown();
        println!("LIVE_CLOUD_OK same-daemon same-pty offline-output-replay resumed-shell-input injected_rtt_ms=100 gateway_restart={gateway_restarted}");
        Ok(())
    }.await;

    // Cleanup uses the original endpoint so an impaired bridge cannot prevent
    // stopping this test's PTY or removing its disposable project.
    let mut cleanup_errors = Vec::new();
    if let Some(pty) = pty_id {
        let cleanup = async {
            let session =
                DaemonSession::open_direct(&target.direct, &id, &client_id, &daemon).await?;
            let killed = session
                .request("pty.kill", &serde_json::json!({"id":pty}))
                .await;
            session.shutdown();
            killed.map(|_| ())
        };
        match tokio::time::timeout(Duration::from_secs(20), cleanup).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => cleanup_errors.push(error),
            Err(_) => cleanup_errors.push("PTY cleanup timed out".into()),
        }
    }
    if created_project {
        match tokio::time::timeout(
            Duration::from_secs(30),
            remote_ssh::remove_remote_tree(&cleanup_fs, path),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => cleanup_errors.push(error),
            Err(_) => cleanup_errors.push("temporary project cleanup timed out".into()),
        }
    }
    close_connection(&config.endpoint, &id);
    close_connection(&target.direct.endpoint, &id);
    assert!(
        cleanup_errors.is_empty(),
        "cloud cleanup failed: {cleanup_errors:?}; test: {result:?}"
    );
    result.expect("cloud host acceptance failed");
    println!(
        "LIVE_CLOUD_CLEANUP_OK uuid-project-and-pty-removed elapsed_ms={}",
        started.elapsed().as_millis()
    );
}
