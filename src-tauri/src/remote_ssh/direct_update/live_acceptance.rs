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
    update_over_ssh(&source, &root, config.clone(), &direct)
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
