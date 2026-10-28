//! 真机部署计时基准：对真实远端跑一遍产品的发现 / 部署 / daemon 链路，
//! 并单独测量远端 shell 往返、SFTP 往返、SHA 比对与纯上传吞吐，用来定位
//! 「就绪用时」里各段的真实开销。
//!
//! 只在显式设置环境变量并加 `--ignored` 时运行，凭据只走环境变量：
//!
//! ```text
//! QC_BENCH_HOST / QC_BENCH_USER / QC_BENCH_PASSWORD / QC_BENCH_PORT(默认 22)
//! QC_BENCH_ROOT        远端项目根（Linux 如 /root/qc-bench；Windows 如 /C:/Users/Administrator/qc-bench）
//! QC_BENCH_SERVER_DIR  本地 server 二进制目录（含 qingcode-server-x86_64 / -windows-x86_64.exe）
//! cargo test --lib real_host_bench -- --ignored --nocapture
//! ```

use super::*;
use crate::remote_ssh::{
    ssh_probe_host, store_authenticated_session, RemoteMode, SshConnectionConfig,
};

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn secs(started: Instant) -> String {
    format!("{:.2}s", started.elapsed().as_secs_f64())
}

async fn run_bench() -> Result<(), String> {
    let host = env("QC_BENCH_HOST").ok_or("缺少 QC_BENCH_HOST")?;
    let root_path = env("QC_BENCH_ROOT").ok_or("缺少 QC_BENCH_ROOT")?;
    let server_dir = env("QC_BENCH_SERVER_DIR").ok_or("缺少 QC_BENCH_SERVER_DIR")?;
    let connection_id = "bench".to_string();
    let mut config = SshConnectionConfig {
        id: connection_id.clone(),
        host: host.clone(),
        port: env("QC_BENCH_PORT")
            .and_then(|port| port.parse().ok())
            .unwrap_or(22),
        username: env("QC_BENCH_USER").unwrap_or_else(|| "root".to_string()),
        auth_kind: "password".to_string(),
        password: env("QC_BENCH_PASSWORD"),
        private_key_path: None,
        passphrase: None,
        host_key_fingerprint: None,
        mode: Some(RemoteMode::Server),
    };
    let manager = SshManager::new();
    manager.set_server_binary_dirs(vec![PathBuf::from(&server_dir)]);

    let started = Instant::now();
    config.host_key_fingerprint = Some(ssh_probe_host(config.clone()).await?.fingerprint);
    store_authenticated_session(&manager, config).await?;
    println!("[bench] {host} 指纹探测+认证 {}", secs(started));

    let uri = format!("ssh://{connection_id}{root_path}");
    let started = Instant::now();
    let sftp = manager.open_sftp(&connection_id).await?;
    println!("[bench] 打开 SFTP {}", secs(started));
    let parsed = parse_remote_uri(&uri)?;
    let started = Instant::now();
    let canonical_path = sftp
        .canonicalize(parsed.path)
        .await
        .map_err(|error| format!("项目根不可用：{error}"))?;
    println!("[bench] SFTP canonicalize 往返 {}", secs(started));
    let root = RegisteredRoot {
        uri: normalize_remote_uri(&uri),
        canonical_path: canonical_path.clone(),
        trusted: true,
    };
    manager
        .roots
        .write()
        .map_err(|_| "工作区状态不可用")?
        .insert(uri.clone(), root.clone());

    // 远端 shell 冷启动往返：Linux 是 sh，Windows 是 PowerShell。
    for round in 1..=2 {
        let started = Instant::now();
        exec_on_root(&manager, &root, "true", "$null").await?;
        println!("[bench] 远端 shell 空命令往返#{round} {}", secs(started));
    }

    let ensure_round = |label: &'static str| {
        let manager = &manager;
        let root = &root;
        let connection_id = &connection_id;
        async move {
            let key = server_slot_key(connection_id, &root.canonical_path);
            let started = Instant::now();
            let endpoint = ensure_server_endpoint_with_app(manager, root, None).await?;
            let slot = manager.server_slot(&key).unwrap_or_default();
            println!(
                "[bench] {label}：总 {} 就绪={} daemon={} 分段=[{}] 失败={:?} daemon失败={:?}",
                secs(started),
                endpoint.is_some(),
                slot.endpoint
                    .as_ref()
                    .is_some_and(|endpoint| endpoint.daemon.is_some()),
                slot.last_timings.unwrap_or_default(),
                slot.last_failure,
                slot.daemon_failure,
            );
            Ok::<_, String>(slot.endpoint)
        }
    };

    // 第一轮：按远端现状走（冷部署或发现）。
    let endpoint = ensure_round("第一轮 ensure").await?;

    // 第二轮：清掉内存 slot 与安装目录缓存，模拟重连后的发现路径。
    let key = server_slot_key(&connection_id, &root.canonical_path);
    manager.set_server_slot(&key, ServerSlot::default());
    manager.forget_server_install(&connection_id);
    let endpoint = ensure_round("第二轮 ensure（重新发现）")
        .await?
        .or(endpoint);

    // 拆开测上传各子步骤（写到 /tmp 或 %TEMP% 之外的安装目录旁，不影响正式文件）。
    let windows = windows_native_path(&root.canonical_path).is_some();
    if let Some((home, install_dir)) = manager.cached_server_install(&connection_id) {
        let (arch, local) = locate_local_server_binary_with(&manager, &root, false)
            .await
            .map_err(|error| error.reason)?;
        let size = std::fs::metadata(&local)
            .map(|meta| meta.len())
            .unwrap_or(0);
        let local_sha = sha256_of_file_cached(&local).await?;
        let remote_bin = format!("{install_dir}/{}", server_binary_file_name(windows, &arch));
        let started = Instant::now();
        let matches = remote_binary_sha_matches(&manager, &root, &remote_bin, &local_sha).await?;
        println!("[bench] 远端 SHA 比对 {}（一致={matches}）", secs(started));
        let started = Instant::now();
        let _ = tokio::join!(
            sftp.canonicalize(install_dir.clone()),
            sftp.canonicalize(home.clone())
        );
        println!("[bench] 两次 canonicalize {}", secs(started));
        let bytes = std::fs::read(&local).map_err(|error| error.to_string())?;
        let temp = format!("{install_dir}/bench-upload.tmp");
        let started = Instant::now();
        let mut file = sftp
            .open_with_flags(temp.clone(), remote_write_flags(true))
            .await
            .map_err(|error| error.to_string())?;
        for chunk in bytes.chunks(64 * 1024) {
            file.write_all(chunk)
                .await
                .map_err(|error| error.to_string())?;
        }
        file.shutdown().await.map_err(|error| error.to_string())?;
        let elapsed = started.elapsed().as_secs_f64();
        println!(
            "[bench] 纯 SFTP 上传 {:.1} MiB 用时 {elapsed:.2}s（{:.1} MiB/s）",
            size as f64 / 1048576.0,
            size as f64 / 1048576.0 / elapsed.max(0.001)
        );
        let _ = sftp.remove_file(temp).await;
    }

    if let Some(daemon) = endpoint.and_then(|endpoint| endpoint.daemon) {
        for round in 1..=2 {
            let started = Instant::now();
            let entries =
                daemon_scan_entries(&manager, &connection_id, &daemon, &root.canonical_path, "")
                    .await
                    .map_err(|error| format!("{error:?}"))?;
            println!(
                "[bench] daemon fs.scan#{round} {} 条 {}",
                entries.len(),
                secs(started)
            );
        }
        let started = Instant::now();
        let mut hits = 0usize;
        let outcome = daemon_search_content_call(
            &manager,
            &connection_id,
            &daemon,
            DaemonSearchParams {
                root: root.canonical_path.clone(),
                query: "main".to_string(),
                ignore_case: true,
                include_globs: Vec::new(),
                exclude_globs: Vec::new(),
                no_ignore: false,
                max_matches: 500,
                max_per_file: 20,
                max_files: 200,
            },
            Instant::now() + Duration::from_secs(30),
            || false,
            |_| {
                hits += 1;
                true
            },
        )
        .await
        .map_err(|error| format!("{error:?}"));
        println!(
            "[bench] daemon search.content {} 条记录 {} 结果={}",
            hits,
            secs(started),
            outcome.is_ok()
        );
    } else {
        println!("[bench] daemon 未就绪，跳过 scan/search 计时");
    }
    Ok(())
}

#[test]
#[ignore = "需要真实远端，设置 QC_BENCH_* 环境变量后用 --ignored 运行"]
fn real_host_deploy_bench() {
    if env("QC_BENCH_HOST").is_none() {
        println!("[bench] 未设置 QC_BENCH_HOST，跳过");
        return;
    }
    tauri::async_runtime::block_on(run_bench()).expect("真机基准失败");
}

/// Read-only diagnosis through the application's real russh/SFTP transports.
/// QC_BENCH_HOST/PORT/USER/ROOT, QC_BENCH_KEY, QC_BENCH_BINARY and
/// QC_BENCH_REMOTE_BIN/TOKEN are required. Never deploys or restarts services.
#[tokio::test]
#[ignore = "requires an authorized SSH host and trusted local server binary"]
async fn real_host_read_only_diagnosis() {
    use qingcode_server::proto::{self, Frame, HelloRequest, HelloResponse, Kind};
    use qingcode_server::{read_frame, write_frame, ServerOp, ServerRequest, ServerResponse};

    let required = |name: &str| env(name).unwrap_or_else(|| panic!("missing {name}"));
    let id = "read-only-diagnosis";
    let mut config = SshConnectionConfig {
        id: id.into(),
        host: required("QC_BENCH_HOST"),
        port: required("QC_BENCH_PORT").parse().unwrap(),
        username: required("QC_BENCH_USER"),
        auth_kind: "privateKey".into(),
        password: None,
        private_key_path: Some(required("QC_BENCH_KEY")),
        passphrase: None,
        host_key_fingerprint: None,
        mode: Some(RemoteMode::Server),
    };
    config.host_key_fingerprint = Some(ssh_probe_host(config.clone()).await.unwrap().fingerprint);
    let manager = SshManager::new();
    store_authenticated_session(&manager, config).await.unwrap();
    println!("DIAG SSH authenticated");
    let sftp = manager.open_sftp(id).await.unwrap();
    let path = required("QC_BENCH_ROOT");
    let root = RegisteredRoot {
        uri: format!("ssh://{id}{path}"),
        canonical_path: sftp.canonicalize(&path).await.unwrap(),
        trusted: true,
    };
    manager
        .roots
        .write()
        .unwrap()
        .insert(root.uri.clone(), root.clone());
    let state = parse_server_state(
        &sftp
            .read(server_state_path(&root.canonical_path))
            .await
            .unwrap(),
    )
    .unwrap();
    println!(
        "DIAG SFTP ready; serve version={} port={}",
        state.version, state.port
    );
    let channel = super::super::serve::open_server_channel(&manager, id, state.port)
        .await
        .unwrap();
    let mut stream = channel.into_stream();
    write_frame(
        &mut stream,
        &serde_json::to_vec(&ServerRequest {
            token: state.token,
            op: ServerOp::Ping,
        })
        .unwrap(),
    )
    .await
    .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(10), read_frame(&mut stream))
        .await
        .unwrap()
        .unwrap();
    match serde_json::from_slice::<ServerResponse>(&response).unwrap() {
        ServerResponse::Ok { version } => {
            println!("DIAG SSH direct-tcpip ping ready; version={version}")
        }
        response => panic!("unexpected ping: {response:?}"),
    }
    let remote_bin = required("QC_BENCH_REMOTE_BIN");
    let sha = sha256_of_file_cached(Path::new(&required("QC_BENCH_BINARY")))
        .await
        .unwrap();
    assert!(
        remote_binary_sha_matches(&manager, &root, &remote_bin, &sha)
            .await
            .unwrap()
    );
    let token = String::from_utf8(sftp.read(required("QC_BENCH_TOKEN")).await.unwrap()).unwrap();
    let channel = manager
        .open_session_channel(id, "read-only daemon diagnosis")
        .await
        .unwrap();
    channel
        .exec(
            true,
            super::super::scripts::windows_connect_daemon_command_existing(&remote_bin),
        )
        .await
        .unwrap();
    let mut stream = channel.into_stream();
    proto::write_frame(
        &mut stream,
        &Frame::new(
            Kind::Hello,
            0,
            proto::encode(&HelloRequest {
                client_id: format!("read-only-diag-{}", uuid::Uuid::new_v4()),
                protocol_min: proto::PROTOCOL_VERSION,
                protocol_max: proto::PROTOCOL_VERSION,
                token: token.trim().into(),
                resume_token: None,
            })
            .unwrap(),
        ),
    )
    .await
    .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(20), proto::read_frame(&mut stream))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame.kind, Kind::Hello);
    let hello: HelloResponse = proto::decode_value(&frame.payload).unwrap();
    println!(
        "DIAG daemon HELLO ready; version={} protocol={}",
        hello.server_version, hello.protocol
    );
    let request = proto::Request::with_params(
        1,
        "fs.scan",
        &serde_json::json!({"root": root.canonical_path, "path": "."}),
    )
    .unwrap();
    proto::write_frame(
        &mut stream,
        &Frame::new(Kind::Req, 1, proto::encode(&request).unwrap()),
    )
    .await
    .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(15), proto::read_frame(&mut stream))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame.kind, Kind::Res);
    println!("DIAG daemon fs.scan ready");
    let access = DaemonAccess {
        bin: remote_bin,
        token: token.trim().into(),
    };
    match super::super::daemon::open_daemon_channel(&manager, id, &access).await {
        Ok(mut channel) => {
            channel.shutdown().await;
            assert_eq!(hello.server_version, SERVER_VERSION);
            println!("DIAG application strict HELLO ready");
        }
        Err(reason) => {
            assert_ne!(hello.server_version, SERVER_VERSION);
            assert!(reason.contains("daemon 版本不匹配"), "{reason}");
            println!("DIAG application strict HELLO rejected: {reason}");
        }
    }
}
