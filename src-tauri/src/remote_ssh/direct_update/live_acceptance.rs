//! Authorized upgrade of the actual paired gateway; creates a disposable project.
use super::*;
use qingcode_server::proto::{self, Frame, HelloRequest, HelloResponse, Kind, Request, Response};
use serde_json::json;

fn serialize_bytes<S: serde::Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_bytes(bytes)
}

fn required(name: &str) -> String {
    std::env::var(name).expect(name)
}

async fn rpc(
    stream: &mut tokio::io::DuplexStream,
    id: u32,
    method: &str,
    params: &impl Serialize,
) -> serde_json::Value {
    let request = Request::with_params(id, method, params).unwrap();
    proto::write_frame(
        stream,
        &Frame::new(Kind::Req, id, proto::encode(&request).unwrap()),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let frame = proto::read_frame(stream).await.unwrap();
            if frame.kind == Kind::Ping {
                proto::write_frame(
                    stream,
                    &Frame::new(Kind::Pong, frame.stream_id, frame.payload),
                )
                .await
                .unwrap();
            } else if frame.kind == Kind::Res && frame.stream_id == id {
                return proto::decode_value::<Response>(&frame.payload)
                    .unwrap()
                    .result;
            } else if frame.kind == Kind::Err && frame.stream_id == id {
                let error: proto::ErrorBody = proto::decode_value(&frame.payload).unwrap();
                panic!("{method}: {}", error.message);
            }
        }
    })
    .await
    .expect("direct RPC timed out")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "updates the authorized QC_UPDATE_HOST paired Windows gateway and ends its terminals"]
async fn live_windows_gateway_version_update() {
    let source = SshManager::new();
    source.set_server_binary_dirs(vec![PathBuf::from(required("QC_UPDATE_SERVER_DIR"))]);
    source.server_auto_download.store(false, Ordering::SeqCst);
    let config = SshConnectionConfig {
        id: "live-direct-update".into(),
        host: required("QC_UPDATE_HOST"),
        port: required("QC_UPDATE_SSH_PORT").parse().unwrap(),
        username: required("QC_UPDATE_USER"),
        auth_kind: "privateKey".into(),
        password: None,
        private_key_path: Some(required("QC_UPDATE_PRIVATE_KEY")),
        passphrase: None,
        host_key_fingerprint: Some(required("QC_UPDATE_FINGERPRINT")),
        mode: Some(RemoteMode::Server),
    };
    let (session, _) = store_authenticated_session(&source, config.clone())
        .await
        .unwrap();
    let sftp = source.open_sftp(&config.id).await.unwrap();
    let path = format!(
        "{}/qingcode-update-{}",
        required("QC_UPDATE_PARENT"),
        uuid::Uuid::new_v4()
    );
    sftp.create_dir(path.clone()).await.unwrap();
    let canonical = sftp.canonicalize(&path).await.unwrap();
    let root = RegisteredRoot {
        uri: format!("ssh://{}{canonical}", config.id),
        canonical_path: canonical.clone(),
        trusted: true,
    };
    source
        .roots
        .write()
        .unwrap()
        .insert(root.uri.clone(), root.clone());
    let old_bin = windows_native_path(&required("QC_UPDATE_EXISTING_BIN")).unwrap();
    let read = execute(
        &source,
        &root,
        &format!("& {} direct-info --include-secret", quote(&old_bin)),
    )
    .await
    .unwrap();
    let before = descriptor(&read).unwrap();
    let direct = DirectConnectionConfig {
        endpoint: format!("https://{}:{}", config.host, before.port),
        certificate_fingerprint: before.certificate_sha256.clone(),
        token: before.token.clone().unwrap(),
        tunnel: None,
    };
    source
        .direct_connections
        .write()
        .unwrap()
        .insert(config.id.clone(), direct.clone());
    source
        .direct_active
        .write()
        .unwrap()
        .insert(config.id.clone());
    let health = direct::test(&direct).await.unwrap();
    if health.server_version != qingcode_server::SERVER_VERSION {
        assert!(
            server::ensure_server_endpoint_with_app(&source, &root, None)
                .await
                .is_err()
        );
        let state = server_status::state_for_root(&source, &root).unwrap();
        let reason = state.reason.unwrap();
        assert!(
            reason.contains(&health.server_version)
                && reason.contains(qingcode_server::SERVER_VERSION)
        );
        println!(
            "LIVE_UPDATE_STAGE mismatch remote={} client={}",
            health.server_version,
            qingcode_server::SERVER_VERSION
        );
    }
    update_over_ssh(
        &source,
        &root,
        config.clone(),
        &direct,
        UpdatePolicy {
            auto_start: false,
            confirmed_upgrade: None,
        },
        None,
        None,
    )
    .await
    .unwrap();
    direct::close_connection(&direct.endpoint, &config.id);
    source.clear_server_endpoint(&server::server_slot_key(&config.id, &canonical));
    server::ensure_server_endpoint_with_app(&source, &root, None)
        .await
        .unwrap();
    let state = server_status::state_for_root(&source, &root).unwrap();
    assert_eq!(state.phase, server_status::ServerPhase::ReadyServer);
    assert_eq!(state.transport, Some(server_status::ServerTransport::Agent));
    let health = direct::test(&direct).await.unwrap();
    direct::require_current_version(&health).unwrap();
    assert_eq!(health.port, before.port);
    assert_eq!(health.certificate_sha256, before.certificate_sha256);
    let fs = SftpSession::direct(direct.clone(), Some(canonical.clone()), true);
    let file = format!("{canonical}/update-verified.txt");
    let mut write = fs
        .open_with_flags(file.clone(), remote_write_flags(true))
        .await
        .unwrap();
    write.write_all(b"direct update acceptance").await.unwrap();
    write.shutdown().await.unwrap();
    drop(write);
    let mut read = fs.open(file.clone()).await.unwrap();
    let mut bytes = Vec::new();
    read.read_to_end(&mut bytes).await.unwrap();
    drop(read);
    assert_eq!(bytes, b"direct update acceptance");
    println!("LIVE_UPDATE_STAGE HTTPS file-write-read OK");
    let mut daemon_pid = None;
    for round in 0..2 {
        let mut stream = direct::open_stream_for(&direct, &config.id).await.unwrap();
        let hello = HelloRequest {
            client_id: config.id.clone(),
            protocol_min: proto::PROTOCOL_VERSION,
            protocol_max: proto::PROTOCOL_VERSION,
            token: direct.token.clone(),
            resume_token: None,
        };
        proto::write_frame(
            &mut stream,
            &Frame::new(Kind::Hello, 0, proto::encode(&hello).unwrap()),
        )
        .await
        .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(15), proto::read_frame(&mut stream))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.kind, Kind::Hello);
        let hello: HelloResponse = proto::decode_value(&frame.payload).unwrap();
        assert_eq!(hello.server_version, qingcode_server::SERVER_VERSION);
        if let Some(pid) = daemon_pid {
            assert_eq!(pid, hello.pid);
        } else {
            daemon_pid = Some(hello.pid);
        }
        let created = rpc(
            &mut stream,
            1,
            "pty.create",
            &json!({"cwd":canonical,"cols":80,"rows":24,"name":"version-update-acceptance"}),
        )
        .await;
        let pty = created["id"].as_str().unwrap();
        #[derive(Serialize)]
        struct Input<'a> {
            id: &'a str,
            #[serde(serialize_with = "serialize_bytes")]
            data: &'a [u8],
        }
        rpc(
            &mut stream,
            2,
            "pty.input",
            &Input {
                id: pty,
                data: b"echo QINGCODE_VERSION_UPDATE_OK\r",
            },
        )
        .await;
        rpc(
            &mut stream,
            3,
            "pty.resize",
            &json!({"id":pty,"cols":100,"rows":30}),
        )
        .await;
        rpc(&mut stream, 4, "pty.kill", &json!({"id":pty})).await;
        println!("LIVE_UPDATE_STAGE WSS round={round} daemon={} version={} ConPTY-create-input-resize-kill OK", hello.pid, hello.server_version);
        drop(stream);
        direct::close_connection(&direct.endpoint, &config.id);
    }
    fs.remove_file(file).await.unwrap();
    sftp.remove_dir(path).await.unwrap();
    let _ = session
        .handle
        .disconnect(Disconnect::ByApplication, "acceptance complete", "en")
        .await;
    println!(
        "LIVE_UPDATE_OK {}:{} {} -> {} identity-preserved",
        config.host, before.port, before.server_version, health.server_version
    );
}

static TRACE_START: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

/// 计时基准开启时打印相对时间戳；其他测试里为空操作。
pub(in crate::remote_ssh) fn trace(event: &str) {
    if let Some(start) = *TRACE_START.lock().unwrap_or_else(|e| e.into_inner()) {
        println!("[{:>7.2}s] {event}", start.elapsed().as_secs_f64());
    }
}

fn trace_reset() {
    *TRACE_START.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
}

/// 真机计时：对已配对、仅监听回环的 Windows 网关跑一次「准备服务包 + 更新」，
/// 打印各阶段与每次远端命令的时间。密码认证，经 SSH 隧道访问网关；会重启网关。
///
/// QC_BENCH_HOST / QC_BENCH_USER / QC_BENCH_PASSWORD 或 QC_BENCH_KEY / QC_BENCH_PARENT（如 /C:/Users/Administrator）
/// QC_BENCH_SERVER_DIR（当前版本服务包目录，含 manifest.json）
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "restarts the paired Windows gateway on QC_BENCH_HOST"]
async fn live_windows_gateway_update_timing() {
    let mut config = SshConnectionConfig {
        id: "bench-direct-update".into(),
        host: required("QC_BENCH_HOST"),
        port: std::env::var("QC_BENCH_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22),
        username: required("QC_BENCH_USER"),
        // 有 QC_BENCH_KEY 用私钥，否则用 QC_BENCH_PASSWORD。
        auth_kind: if std::env::var("QC_BENCH_KEY").is_ok() {
            "privateKey"
        } else {
            "password"
        }
        .into(),
        password: std::env::var("QC_BENCH_PASSWORD").ok(),
        private_key_path: std::env::var("QC_BENCH_KEY").ok(),
        passphrase: None,
        host_key_fingerprint: None,
        mode: Some(RemoteMode::Server),
    };
    config.host_key_fingerprint = Some(ssh_probe_host(config.clone()).await.unwrap().fingerprint);
    let server_dir = PathBuf::from(required("QC_BENCH_SERVER_DIR"));
    let source = SshManager::new();
    source.set_server_binary_dirs(vec![server_dir.clone()]);
    source.server_auto_download.store(false, Ordering::SeqCst);
    let (session, _) = store_authenticated_session(&source, config.clone())
        .await
        .unwrap();
    let sftp = source.open_sftp(&config.id).await.unwrap();
    let path = format!(
        "{}/qingcode-update-bench-{}",
        required("QC_BENCH_PARENT"),
        uuid::Uuid::new_v4().simple()
    );
    sftp.create_dir(path.clone()).await.unwrap();
    let canonical = sftp.canonicalize(&path).await.unwrap();
    let root = RegisteredRoot {
        uri: format!("ssh://{}{canonical}", config.id),
        canonical_path: canonical.clone(),
        trusted: true,
    };
    source
        .roots
        .write()
        .unwrap()
        .insert(root.uri.clone(), root.clone());
    // 当前网关描述：从进程表找到正在运行的直连网关程序并读取描述。
    let found = execute(
        &source,
        &root,
        "$p = Get-CimInstance Win32_Process -Filter \"Name like 'qingcode-server-windows-%'\" | ? { $_.CommandLine -match ' direct( |$)' } | select -First 1; [Console]::WriteLine($p.ExecutablePath)",
    )
    .await
    .unwrap();
    let old_bin = found.stdout.lines().last().unwrap().trim().to_string();
    let read = execute(
        &source,
        &root,
        &format!("& {} direct-info --include-secret", quote(&old_bin)),
    )
    .await
    .unwrap();
    let before = descriptor(&read).unwrap();
    super::super::tunnel::adopt_for_test(&config.id, session.clone()).unwrap();
    let direct = DirectConnectionConfig {
        endpoint: format!("https://127.0.0.1:{}", before.port),
        certificate_fingerprint: before.certificate_sha256.clone(),
        token: before.token.clone().unwrap(),
        tunnel: Some(config.id.clone()),
    };
    let health = direct::test(&direct).await.unwrap();
    println!(
        "BENCH gateway {} v{} -> client v{}",
        old_bin,
        health.server_version,
        qingcode_server::SERVER_VERSION
    );

    trace_reset();
    // 与 direct_agent_prepare_update 相同：独立维护会话里核对本机服务包。
    let maintenance = SshManager::new();
    packages::configure_package_source(&maintenance, &source, &root, Some(server_dir.clone()));
    trace("prepare: ssh auth");
    let (prep_session, _) = store_authenticated_session(&maintenance, config.clone())
        .await
        .unwrap();
    let bound = packages::management_root(&maintenance, &root, &config.id)
        .await
        .unwrap();
    let info = server::recovery::package_info(&maintenance, &bound.uri, server_dir.to_str())
        .await
        .unwrap();
    assert!(info.problem.is_none(), "{:?}", info.problem);
    let _ = prep_session
        .handle
        .disconnect(Disconnect::ByApplication, "bench", "en")
        .await;
    trace("prepare: done; update: start");
    let package = info.directory.unwrap();
    update_over_ssh(
        &source,
        &root,
        config.clone(),
        &direct,
        UpdatePolicy {
            auto_start: false,
            confirmed_upgrade: None,
        },
        Some(&package),
        None,
    )
    .await
    .unwrap();
    trace("update: done");
    *TRACE_START.lock().unwrap() = None;
    let after = direct::test(&direct).await.unwrap();
    direct::require_current_version(&after).unwrap();
    assert_eq!(after.certificate_sha256, before.certificate_sha256);
    sftp.remove_dir(path).await.unwrap();
    let _ = session
        .handle
        .disconnect(Disconnect::ByApplication, "bench", "en")
        .await;
    println!(
        "BENCH_OK v{} -> v{}",
        health.server_version, after.server_version
    );
}

/// A current gateway may forward to an older, still-busy daemon. Exercise its
/// actual HELLO and pty.list without using a saved connection or a user's PTYs.
#[cfg(unix)]
#[tokio::test]
#[ignore = "requires QC_OLD_SERVER_BIN pointing to a compatible older server executable"]
async fn deferred_impact_counts_live_ptys_behind_a_paired_gateway() {
    let (config, gateway, directory) = direct::tests::gateway().await;
    let mut daemon = tokio::process::Command::new(required("QC_OLD_SERVER_BIN"))
        .arg("daemon")
        .arg("--state-dir")
        .arg(&directory)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    for _ in 0..200 {
        if directory.join("token").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let manager = SshManager::new();
    let id = "deferred-loopback";
    manager
        .direct_connections
        .write()
        .unwrap()
        .insert(id.into(), config.clone());
    manager.direct_active.write().unwrap().insert(id.into());
    let canonical = directory.to_str().unwrap();
    let root = RegisteredRoot {
        uri: format!("ssh://{id}{canonical}"),
        canonical_path: canonical.into(),
        trusted: true,
    };
    manager
        .roots
        .write()
        .unwrap()
        .insert(root.uri.clone(), root.clone());

    let mut stream = direct::open_stream_for(&config, id).await.unwrap();
    let hello = HelloRequest {
        client_id: "other-project-client".into(),
        protocol_min: proto::PROTOCOL_VERSION,
        protocol_max: proto::PROTOCOL_VERSION,
        token: config.token.clone(),
        resume_token: None,
    };
    proto::write_frame(
        &mut stream,
        &Frame::new(Kind::Hello, 0, proto::encode(&hello).unwrap()),
    )
    .await
    .unwrap();
    let response = proto::read_frame(&mut stream).await.unwrap();
    assert_eq!(response.kind, Kind::Hello);
    let hello: HelloResponse = proto::decode_value(&response.payload).unwrap();
    let params = json!({"cwd": canonical, "shell": "/bin/sh", "cols": 80, "rows": 24});
    rpc(&mut stream, 1, "pty.create", &params).await;
    server::ensure_server_endpoint_with_app(&manager, &root, None)
        .await
        .unwrap();
    let cached = server_status::state_for_root(&manager, &root)
        .unwrap()
        .deferred_upgrade
        .unwrap();
    assert_eq!(cached.running_version, hello.server_version);
    assert_eq!(cached.live_terminals, 1);
    let second = rpc(&mut stream, 2, "pty.create", &params).await;
    let live = server::deferred_upgrade_impact(&manager, &root)
        .await
        .unwrap();
    assert_eq!(live.live_terminals, 2);
    assert!(cached.verify(&live).is_err());
    rpc(&mut stream, 3, "pty.kill", &json!({"id":second["id"]})).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let live = server::deferred_upgrade_impact(&manager, &root)
                .await
                .unwrap();
            if cached.verify(&live).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    rpc(&mut stream, 4, "server.shutdown", &json!({})).await;
    tokio::time::timeout(Duration::from_secs(10), daemon.wait())
        .await
        .unwrap()
        .unwrap();
    drop(stream);
    gateway.abort();
    let _ = gateway.await;
    std::fs::remove_dir_all(directory).unwrap();
}
