//! 真机验收：Server 模式经 SSH 隧道接入直连网关。
//!
//! 走产品的接入入口（`ensure_server_endpoint_with_app`），覆盖首次建立隧道、
//! 文件与命令、daemon 终端、SSH 断线后接回同一终端、第二个客户端复用网关，
//! 以及网关重启后终端仍在。只在显式设置环境变量并加 `--ignored` 时运行：
//!
//! ```text
//! QC_TUNNEL_HOST / QC_TUNNEL_USER / QC_TUNNEL_PORT(默认 22)
//! QC_TUNNEL_KEY         私钥路径（默认 ~/.ssh/id_ed25519）
//! QC_TUNNEL_ROOT        远端项目根（Linux 如 /root/qc-tunnel；Windows 如 /C:/Users/Administrator/qc-tunnel）
//! QC_TUNNEL_SERVER_DIR  本地同版本服务包目录（含 manifest.json）
//! QC_TUNNEL_DOWNLOAD    设为 1 时缺包从 Release 下载到 QC_TUNNEL_CACHE（默认系统临时目录）
//! cargo test --lib live_ssh_tunnel_acceptance -- --ignored --nocapture
//! ```

use super::*;
use qingcode_server::proto::{
    self, Frame, HelloRequest, Kind, Request, Response, StreamChunk, WindowCredit, PROTOCOL_VERSION,
};
use tokio::io::DuplexStream;

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn ms(started: Instant) -> String {
    format!("{:.0}ms", started.elapsed().as_secs_f64() * 1000.0)
}

struct Client {
    manager: SshManager,
    id: String,
    root: RegisteredRoot,
    windows: bool,
}

async fn connect(label: &str) -> Client {
    let id = format!("tunnel-live-{label}-{}", std::process::id());
    let key = env("QC_TUNNEL_KEY").unwrap_or_else(|| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap();
        format!("{home}/.ssh/id_ed25519")
    });
    let mut config = SshConnectionConfig {
        id: id.clone(),
        host: env("QC_TUNNEL_HOST").expect("QC_TUNNEL_HOST"),
        port: env("QC_TUNNEL_PORT")
            .and_then(|port| port.parse().ok())
            .unwrap_or(22),
        username: env("QC_TUNNEL_USER").unwrap_or_else(|| "root".into()),
        auth_kind: "privateKey".into(),
        password: None,
        private_key_path: Some(key),
        passphrase: None,
        host_key_fingerprint: None,
        mode: Some(RemoteMode::Server),
    };
    let manager = SshManager::new();
    manager.set_client_id(format!("qc-tunnel-live-{label}"));
    if let Some(dir) = env("QC_TUNNEL_SERVER_DIR") {
        manager.set_server_binary_dirs(vec![PathBuf::from(dir)]);
    }
    let download = env("QC_TUNNEL_DOWNLOAD").is_some();
    manager
        .server_auto_download
        .store(download, Ordering::SeqCst);
    if download {
        manager.set_server_cache_dir(PathBuf::from(env("QC_TUNNEL_CACHE").unwrap_or_else(|| {
            std::env::temp_dir()
                .join("qc-tunnel-cache")
                .display()
                .to_string()
        })));
    }
    let started = Instant::now();
    let probe = ssh_probe_host(config.clone()).await.expect("探测主机指纹");
    config.host_key_fingerprint = Some(probe.fingerprint);
    store_authenticated_session(&manager, config)
        .await
        .expect("SSH 认证");
    let sftp = manager.open_sftp(&id).await.expect("打开 SFTP");
    let root_path = env("QC_TUNNEL_ROOT").expect("QC_TUNNEL_ROOT");
    let _ = sftp.create_dir(root_path.clone()).await;
    let canonical = sftp.canonicalize(root_path.clone()).await.expect("项目根");
    let root = RegisteredRoot {
        uri: normalize_remote_uri(&format!("ssh://{id}{root_path}")),
        canonical_path: canonical.clone(),
        trusted: true,
    };
    manager
        .roots
        .write()
        .unwrap()
        .insert(root.uri.clone(), root.clone());
    println!("[tunnel][{label}] SSH 认证与项目根 {}", ms(started));
    Client {
        windows: windows_native_path(&canonical).is_some(),
        manager,
        id,
        root,
    }
}

async fn activate(client: &Client, label: &str) -> direct::DirectConnectionConfig {
    if env("QC_TUNNEL_PROFILE").is_some() {
        let started = Instant::now();
        let staged = server::stage_direct_gateway(&client.manager, &client.root)
            .await
            .expect("暂存网关");
        println!("[tunnel][{label}] 暂存网关 {}", ms(started));
        let started = Instant::now();
        let read = read_gateway(&client.manager, &client.root, &staged).await;
        println!(
            "[tunnel][{label}] 读取网关描述 {} ok={}",
            ms(started),
            read.is_ok()
        );
    }
    let started = Instant::now();
    let endpoint =
        server::ensure_server_endpoint_with_app(&client.manager, &client.root, None).await;
    let endpoint = endpoint.unwrap_or_else(|error| panic!("[{label}] 接入失败：{error}"));
    assert!(
        endpoint.is_some_and(|endpoint| endpoint.daemon.is_some()),
        "[{label}] 端点缺少 daemon"
    );
    let config = client
        .manager
        .direct_config(&client.id)
        .expect("连接应已切到隧道直连");
    assert_eq!(config.tunnel.as_deref(), Some(client.id.as_str()));
    let health = direct::test(&config).await.expect("隧道健康检查");
    println!(
        "[tunnel][{label}] 接入 {}：{} 网关 v{} 协议 {}",
        ms(started),
        config.endpoint,
        health.server_version,
        health.protocol
    );
    config
}

async fn gateway_pid(client: &Client) -> u32 {
    let result = client
        .manager
        .exec_remote_shell(
            &client.root.uri,
            "for b in ~/.qingcode/server/*/direct-gateway/*/qingcode-server*; do \"$b\" direct-info && break; done",
            "$b = Get-ChildItem \"$env:USERPROFILE\\.qingcode\\server\\*\\direct-gateway\\*\\qingcode-server*.exe\" | Select-Object -First 1; & $b.FullName direct-info",
            true,
            Duration::from_secs(30),
        )
        .await
        .expect("读取网关描述");
    let info: qingcode_server::direct::DirectInfo = result
        .stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .unwrap_or_else(|| panic!("网关描述无效：{} {}", result.stdout, result.stderr));
    info.pid
}

async fn hello(config: &direct::DirectConnectionConfig, connection_id: &str) -> DuplexStream {
    let mut stream = direct::open_stream_for(config, connection_id)
        .await
        .expect("打开 WSS");
    proto::write_frame(
        &mut stream,
        &Frame::new(
            Kind::Hello,
            0,
            proto::encode(&HelloRequest {
                client_id: "qc-tunnel-live:shared".into(),
                protocol_min: PROTOCOL_VERSION,
                protocol_max: PROTOCOL_VERSION,
                token: config.token.clone(),
                resume_token: None,
            })
            .unwrap(),
        ),
    )
    .await
    .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(15), proto::read_frame(&mut stream))
        .await
        .expect("HELLO 超时")
        .unwrap();
    assert_eq!(frame.kind, Kind::Hello);
    stream
}

/// 发请求并读到响应；期间收到的流数据按流 ID 累积并归还窗口。
async fn request(
    stream: &mut DuplexStream,
    id: u32,
    method: &str,
    params: serde_json::Value,
    output: &mut Vec<u8>,
) -> serde_json::Value {
    let request = Request::with_params(id, method, &params).unwrap();
    proto::write_frame(
        stream,
        &Frame::new(Kind::Req, id, proto::encode(&request).unwrap()),
    )
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), proto::read_frame(stream))
            .await
            .unwrap_or_else(|_| panic!("{method} 超时"))
            .unwrap();
        match frame.kind {
            Kind::Ping => proto::write_frame(stream, &Frame::empty(Kind::Pong, frame.stream_id))
                .await
                .unwrap(),
            Kind::StreamData | Kind::Event => {
                collect(stream, &frame, output).await;
            }
            Kind::Res if frame.stream_id == id => {
                return proto::decode_value::<Response>(&frame.payload)
                    .unwrap()
                    .result;
            }
            Kind::Err if frame.stream_id == id => {
                panic!("{method} 失败：{}", String::from_utf8_lossy(&frame.payload))
            }
            _ => {}
        }
    }
}

async fn collect(stream: &mut DuplexStream, frame: &Frame, output: &mut Vec<u8>) {
    if frame.kind == Kind::Event {
        if let Ok(proto::Event::PtyData { data, .. }) = proto::decode_value(&frame.payload) {
            output.extend_from_slice(&data);
        }
        return;
    }
    if let Ok(chunk) = proto::decode_value::<StreamChunk>(&frame.payload) {
        output.extend_from_slice(&chunk.data);
    }
    let credit = proto::encode(&WindowCredit {
        credit: frame.payload.len() as u32,
    })
    .unwrap();
    let _ = proto::write_frame(stream, &Frame::new(Kind::Window, frame.stream_id, credit)).await;
}

/// 读流数据直到出现 `marker` 之后的新编号，证明终端仍在持续输出。
async fn wait_output(
    stream: &mut DuplexStream,
    output: &mut Vec<u8>,
    marker: &str,
    at_least: usize,
) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while String::from_utf8_lossy(output).matches(marker).count() < at_least {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "终端输出不足：{}",
            String::from_utf8_lossy(output)
        );
        let Ok(frame) = tokio::time::timeout(remaining, proto::read_frame(stream)).await else {
            continue;
        };
        let frame = frame.expect("读取终端输出");
        match frame.kind {
            Kind::Ping => proto::write_frame(stream, &Frame::empty(Kind::Pong, frame.stream_id))
                .await
                .unwrap(),
            Kind::StreamData | Kind::Event => collect(stream, &frame, output).await,
            _ => {}
        }
    }
}

fn marker_command(client: &Client, marker: &str) -> serde_json::Value {
    if client.windows {
        serde_json::json!({
            "cwd": client.root.canonical_path,
            "shell": "powershell.exe",
            "args": ["-NoLogo", "-NoProfile", "-Command",
                format!("$i=0; while ($true) {{ \"{marker}$i\"; $i++; Start-Sleep -Seconds 1 }}")],
            "cols": 120, "rows": 30,
        })
    } else {
        serde_json::json!({
            "cwd": client.root.canonical_path,
            "shell": "/bin/sh",
            "args": ["-c", format!("i=0; while :; do echo {marker}$i; i=$((i+1)); sleep 1; done")],
            "cols": 120, "rows": 30,
        })
    }
}

/// 端口直连换绑：占用端口时回滚、换绑到对外地址、重复执行不重启，结束后恢复原监听。
/// 只验证换绑本身，不改动测试机的开机自启。`--ignored` 运行：
/// `cargo test --lib live_tunnel_gateway_rebinds_for_port_direct -- --ignored --nocapture`
#[tokio::test]
#[ignore = "requires QC_TUNNEL_HOST / QC_TUNNEL_ROOT and an authorized SSH key"]
async fn live_tunnel_gateway_rebinds_for_port_direct() {
    let client = connect("expose").await;
    activate(&client, "expose").await;
    let maintenance = tunnel_maintenance(&client.manager, &client.id, &client.root).unwrap();
    let staged = server::stage_direct_gateway(&maintenance, &client.root)
        .await
        .expect("暂存网关");
    let original = read_gateway(&maintenance, &client.root, &staged)
        .await
        .expect("读取网关")
        .expect("隧道网关应已存在");
    println!(
        "[expose] 原网关 {}:{} pid={}",
        original.hostname, original.port, original.pid
    );
    let healthy = |label: &'static str| {
        let config = client.manager.direct_config(&client.id).expect("隧道登记");
        async move {
            let health = direct::test(&config)
                .await
                .unwrap_or_else(|error| panic!("[{label}] 健康检查失败：{error}"));
            println!("[expose][{label}] 经隧道 {} 正常", config.endpoint);
            health
        }
    };

    // SSH 端口必然被 sshd 占用：换绑失败后原网关必须恢复，隧道继续可用。
    let ssh_port = env("QC_TUNNEL_PORT")
        .and_then(|port| port.parse().ok())
        .unwrap_or(22);
    let error = rebind_gateway(
        &client.manager,
        &maintenance,
        &client.root,
        &staged,
        ssh_port,
    )
    .await
    .expect_err("占用端口应当失败");
    assert!(!error.contains("恢复原网关也失败"), "{error}");
    println!("[expose] 占用端口按预期失败：{error}");
    healthy("rollback").await;

    let port = env("QC_TUNNEL_EXPOSE_PORT")
        .and_then(|port| port.parse().ok())
        .unwrap_or(original.port + 1);
    let exposed = rebind_gateway(&client.manager, &maintenance, &client.root, &staged, port)
        .await
        .expect("换绑到对外地址");
    assert_eq!(exposed.port, port);
    assert_eq!(exposed.hostname, public_listen_host(&original.hostname));
    assert_eq!(exposed.token, original.token, "换绑不得更换配对凭据");
    assert_eq!(exposed.certificate_sha256, original.certificate_sha256);
    let config = client.manager.direct_config(&client.id).expect("隧道登记");
    assert!(config.endpoint.ends_with(&format!(":{port}")));
    assert_eq!(config.tunnel.as_deref(), Some(client.id.as_str()));
    healthy("exposed").await;

    let again = rebind_gateway(&client.manager, &maintenance, &client.root, &staged, port)
        .await
        .expect("重复换绑");
    assert_eq!(again.pid, exposed.pid, "已在目标地址时不得重启网关");

    let restored = move_gateway(&maintenance, &client.root, &staged, &again, &original)
        .await
        .expect("恢复原监听");
    reattach_tunnel(&client.manager, &client.id, &restored)
        .await
        .expect("隧道接回原端口");
    assert_eq!(restored.port, original.port);
    assert_eq!(restored.hostname, original.hostname);
    healthy("restored").await;
    close(&client.id).await;
}

#[tokio::test]
#[ignore = "requires QC_TUNNEL_HOST / QC_TUNNEL_ROOT and an authorized SSH key"]
async fn live_ssh_tunnel_acceptance() {
    let total = Instant::now();
    let a = connect("a").await;

    // 1. 首次接入：建立隧道、准备或复用网关，连接切到隧道直连。
    let config = activate(&a, "a").await;
    let pid_before = gateway_pid(&a).await;

    // 2. 文件与命令经网关。
    let started = Instant::now();
    let (sftp, _, _) = a.manager.sftp_for_uri(&a.root.uri, true).await.unwrap();
    let file = join_remote_path(&a.root.canonical_path, "tunnel-probe.txt");
    {
        let mut handle = sftp
            .open_with_flags(file.clone(), remote_write_flags(true))
            .await
            .expect("写文件");
        handle.write_all(b"tunnel-ok").await.unwrap();
        handle.shutdown().await.unwrap();
    }
    let mut text = String::new();
    sftp.open(file.clone())
        .await
        .expect("读文件")
        .read_to_string(&mut text)
        .await
        .unwrap();
    assert_eq!(text, "tunnel-ok");
    let listed = sftp.read_dir(a.root.canonical_path.clone()).await.unwrap();
    assert!(listed
        .into_iter()
        .any(|entry| entry.file_name() == "tunnel-probe.txt"));
    let echoed = a
        .manager
        .exec_remote_shell(
            &a.root.uri,
            "echo TUNNEL_EXEC",
            "'TUNNEL_EXEC'",
            true,
            Duration::from_secs(30),
        )
        .await
        .expect("远程命令");
    assert!(echoed.stdout.contains("TUNNEL_EXEC"), "{}", echoed.stdout);
    sftp.remove_file(file).await.unwrap();
    println!("[tunnel][a] 文件读写/列目录/远程命令 {}", ms(started));

    // 3. 终端：创建持续输出的 PTY。
    let marker = format!("QC_TUNNEL_{}_", std::process::id());
    let mut stream = hello(&config, &a.id).await;
    let mut output = Vec::new();
    let created = request(
        &mut stream,
        1,
        "pty.create",
        marker_command(&a, &marker),
        &mut output,
    )
    .await;
    let pty = created["id"].as_str().expect("pty id").to_string();
    request(
        &mut stream,
        2,
        "pty.attach",
        serde_json::json!({"id": pty, "fromSeq": 0}),
        &mut output,
    )
    .await;
    wait_output(&mut stream, &mut output, &marker, 2).await;
    println!("[tunnel][a] 终端 {pty} 持续输出");

    // 4. 模拟 SSH 断线：直接断开隧道持有的 SSH 会话，WSS 随之中断。
    let started = Instant::now();
    let session = sessions().session(&a.id).expect("隧道会话");
    session
        .handle
        .disconnect(Disconnect::ByApplication, "simulated drop", "en")
        .await
        .unwrap();
    let mut rest = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut rest)).await;
    drop(stream);
    a.manager
        .ensure_connection_alive(&a.id)
        .await
        .expect("断线后经隧道重连");
    let mut stream = hello(&config, &a.id).await;
    let mut output = Vec::new();
    let listed = request(
        &mut stream,
        3,
        "pty.list",
        serde_json::json!({}),
        &mut output,
    )
    .await;
    let entry = listed["ptys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == pty.as_str())
        .expect("断线后终端仍在");
    assert!(entry["exited"].is_null(), "断线不应结束终端：{entry}");
    request(
        &mut stream,
        4,
        "pty.attach",
        serde_json::json!({"id": pty, "fromSeq": 0}),
        &mut output,
    )
    .await;
    let before = String::from_utf8_lossy(&output).matches(&marker).count();
    wait_output(&mut stream, &mut output, &marker, before + 2).await;
    println!("[tunnel][a] SSH 断线后重连并接回同一终端 {}", ms(started));
    drop(stream);

    // 5. 第二个客户端：复用同一网关进程与 daemon。
    let b = connect("b").await;
    let config_b = activate(&b, "b").await;
    assert_eq!(config_b.endpoint, config.endpoint);
    assert_eq!(gateway_pid(&b).await, pid_before, "第二个客户端应复用网关");
    let mut stream_b = hello(&config_b, &b.id).await;
    let mut output_b = Vec::new();
    let listed = request(
        &mut stream_b,
        1,
        "pty.list",
        serde_json::json!({}),
        &mut output_b,
    )
    .await;
    assert!(
        listed["ptys"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == pty.as_str()),
        "共享 daemon 应能看到 A 的终端"
    );
    drop(stream_b);
    println!("[tunnel][b] 复用网关 pid {pid_before} 与共享 daemon");

    // 6. 网关退出后，新客户端在原地址与端口重启网关；daemon 终端不受影响。
    let started = Instant::now();
    // 命令经网关执行，网关在回应前退出属预期，只看之后能否重启。
    let killed = a
        .manager
        .exec_remote_shell(
            &a.root.uri,
            &format!("kill -9 {pid_before}"),
            &format!("Stop-Process -Id {pid_before} -Force"),
            true,
            Duration::from_secs(30),
        )
        .await;
    println!(
        "[tunnel][a] 结束网关命令：{:?}",
        killed.map(|r| (r.exit_code, r.stdout, r.stderr))
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    let c = connect("c").await;
    let config_c = activate(&c, "c").await;
    assert_eq!(config_c.endpoint, config.endpoint, "应在原地址与端口重启");
    let pid_after = gateway_pid(&c).await;
    assert_ne!(pid_after, pid_before);
    let mut stream_c = hello(&config_c, &c.id).await;
    let mut output_c = Vec::new();
    request(
        &mut stream_c,
        1,
        "pty.attach",
        serde_json::json!({"id": pty, "fromSeq": 0}),
        &mut output_c,
    )
    .await;
    let before = String::from_utf8_lossy(&output_c).matches(&marker).count();
    wait_output(&mut stream_c, &mut output_c, &marker, before + 2).await;
    println!(
        "[tunnel][c] 网关重启（pid {pid_before} → {pid_after}）后终端仍在 {}",
        ms(started)
    );

    // 清理：只结束本测试的终端；网关与 daemon 按产品行为常驻。
    request(
        &mut stream_c,
        2,
        "pty.kill",
        serde_json::json!({"id": pty}),
        &mut output_c,
    )
    .await;
    drop(stream_c);
    for client in [&a, &b, &c] {
        if let Some(config) = client.manager.direct_config(&client.id) {
            direct::close_connection(&config.endpoint, &client.id);
        }
        disconnect(&client.manager, &client.id).await.unwrap();
    }
    println!("LIVE_TUNNEL_OK windows={} 总耗时 {}", a.windows, ms(total));
}
