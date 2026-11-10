use super::*;

#[test]
fn watch_heartbeats_extend_idle_deadline_but_not_rpc_deadline() {
    let start = Instant::now();
    let period = Duration::from_secs(45);
    let mut watch = FrameDeadline::idle(start, period);
    let mut rpc = FrameDeadline::fixed(start + period);
    for second in [15, 30, 45, 60, 75] {
        let received = start + Duration::from_secs(second);
        watch.note_frame(received);
        rpc.note_frame(received);
        assert_eq!(watch.deadline, received + period);
        assert_eq!(rpc.deadline, start + period);
    }
    assert_eq!(watch.deadline, start + Duration::from_secs(120));
}

#[test]
fn scan_pages_accumulate_all_entries_and_reject_truncated_or_looping_pages() {
    let mut entries = Vec::new();
    let count = 6000;
    let mut offset = 0;
    while offset < count {
        let end = (offset + 256).min(count);
        let page = serde_json::json!({
            "entries": (offset..end).map(|n| serde_json::json!({
                "name": format!("{n:05}-{}", "long-name".repeat(20)), "isDir": n % 2 == 0,
            })).collect::<Vec<_>>(),
            "nextOffset": (end < count).then_some(end), "truncated": false,
        });
        let next = append_scan_page(&page, offset, &mut entries).unwrap();
        assert_eq!(next, (end < count).then_some(end));
        offset = end;
    }
    assert_eq!(entries.len(), count);
    assert!(entries[5999].0.starts_with("05999-"));
    assert!(!entries[5999].1);
    for invalid in [
        serde_json::json!({"entries": [], "nextOffset": 0}),
        serde_json::json!({"entries": [], "nextOffset": 1}),
        serde_json::json!({"entries": [], "truncated": true}),
    ] {
        assert!(append_scan_page(&invalid, 0, &mut Vec::new()).is_err());
    }
    let legacy = serde_json::json!({"entries": [{"name": "legacy", "isDir": true}]});
    assert!(append_scan_page(&legacy, 0, &mut Vec::new())
        .unwrap()
        .is_none());
}

fn sample_daemon_access() -> DaemonAccess {
    DaemonAccess {
        bin: format!(
            "/home/dev/.qingcode/server/{}/qingcode-server-x86_64",
            SERVER_VERSION
        ),
        token: "token-123".to_string(),
    }
}

fn hello_response(protocol: u32, version: &str, capabilities: &[&str]) -> HelloResponse {
    HelloResponse {
        protocol,
        server_version: version.to_string(),
        pid: 42,
        os: "linux".into(),
        arch: "x86_64".into(),
        home: Some("/home/dev".into()),
        shells: vec!["bash".into()],
        capabilities: capabilities.iter().map(|item| item.to_string()).collect(),
        pty_count: 0,
    }
}

/// 常规通道的严格校验，避免每处测试重复写策略。
fn strict(response: &HelloResponse) -> Result<(), String> {
    validate_daemon_hello_with(response, HelloPolicy::STRICT)
}

#[test]
fn daemon_hello_validation_accepts_compatible_daemon() {
    let response = hello_response(
        PROTOCOL_VERSION,
        SERVER_VERSION,
        &[
            "fs.scan",
            "search.content",
            "watch.subscribe",
            "pty.persist",
        ],
    );
    assert!(strict(&response).is_ok());
}

#[test]
fn daemon_hello_validation_rejects_version_and_capability_gaps() {
    // 协议版本不符：回退 serve。
    assert!(strict(&hello_response(99, SERVER_VERSION, &[])).is_err());
    // daemon 版本过期（旧进程还占着 flock 时可能出现）：回退 serve。
    assert!(strict(&hello_response(
        PROTOCOL_VERSION,
        "0.0.9",
        &["fs.scan", "search.content", "watch.subscribe"]
    ))
    .is_err());
    // 能力缺失：回退 serve。
    assert!(strict(&hello_response(
        PROTOCOL_VERSION,
        SERVER_VERSION,
        &["fs.scan"]
    ))
    .is_err());
}

#[test]
fn daemon_hello_validation_strict_rejects_stale_version_but_lenient_accepts() {
    let stale = hello_response(
        PROTOCOL_VERSION,
        "0.0.9",
        &["fs.scan", "search.content", "watch.subscribe"],
    );
    // 常规通道拒绝版本落后的旧 daemon。
    assert!(strict(&stale).is_err());
    assert!(validate_daemon_hello_with(&stale, HelloPolicy::STRICT).is_err());
    // 淘汰旧 daemon 的宽松策略只看协议与 token，允许连上旧版本实例。
    assert!(validate_daemon_hello_with(&stale, HelloPolicy::LENIENT).is_ok());
}

#[test]
fn daemon_hello_validation_rejects_wrong_protocol_under_both_policies() {
    // 协议不兼容时帧格式可能不同：两种策略都必须拒绝，不能盲发帧。
    let mismatched = hello_response(
        PROTOCOL_VERSION + 1,
        SERVER_VERSION,
        &["fs.scan", "search.content", "watch.subscribe"],
    );
    for policy in [HelloPolicy::STRICT, HelloPolicy::LENIENT] {
        assert!(validate_daemon_hello_with(&mismatched, policy).is_err());
    }
}

#[test]
fn daemon_hello_validation_capability_gap_only_blocks_strict_policy() {
    let missing = hello_response(PROTOCOL_VERSION, SERVER_VERSION, &["fs.scan"]);
    // 能力缺失：常规通道回退 serve。
    assert!(validate_daemon_hello_with(&missing, HelloPolicy::STRICT).is_err());
    // 淘汰路径不依赖能力，只要求能发 shutdown RPC。
    assert!(validate_daemon_hello_with(&missing, HelloPolicy::LENIENT).is_ok());
}

#[test]
fn persistent_terminal_falls_back_when_capability_missing() {
    let read_only = hello_response(
        PROTOCOL_VERSION,
        SERVER_VERSION,
        &["fs.scan", "search.content", "watch.subscribe"],
    );
    assert!(validate_daemon_hello_with(&read_only, HelloPolicy::TERMINAL).is_err());

    let persistent = hello_response(
        PROTOCOL_VERSION,
        SERVER_VERSION,
        &["pty.persist", "pty.attach"],
    );
    assert!(validate_daemon_hello_with(&persistent, HelloPolicy::TERMINAL).is_ok());
}

#[test]
fn terminal_channel_accepts_older_daemon_with_pty_capabilities() {
    // 升级后仍能接回旧版本 daemon 上的终端：只看协议与能力，不看 server 版本。
    let stale = hello_response(PROTOCOL_VERSION, "0.0.9", &["pty.persist", "pty.attach"]);
    assert!(validate_daemon_hello_with(&stale, HelloPolicy::TERMINAL).is_ok());
    assert!(validate_daemon_hello_with(&stale, HelloPolicy::STRICT).is_err());
    // 协议不兼容时帧格式可能不同，终端通道同样拒绝。
    let mismatched = hello_response(
        PROTOCOL_VERSION + 1,
        "0.0.9",
        &["pty.persist", "pty.attach"],
    );
    assert!(validate_daemon_hello_with(&mismatched, HelloPolicy::TERMINAL).is_err());
}

#[test]
fn probe_policy_only_checks_protocol_and_stale_daemons_are_classified() {
    let regular = ["fs.scan", "search.content", "watch.subscribe"];
    let stale = hello_response(PROTOCOL_VERSION, "0.0.9", &regular);
    assert!(validate_daemon_hello_with(&stale, HelloPolicy::PROBE).is_ok());
    let wrong = hello_response(PROTOCOL_VERSION + 1, "0.0.9", &regular);
    assert!(validate_daemon_hello_with(&wrong, HelloPolicy::PROBE).is_err());
    // 推迟升级时常规通道放行版本差异，但能力缺失仍拒绝。
    assert!(validate_daemon_hello_with(&stale, HelloPolicy::STRICT.tolerating_version()).is_ok());
    let missing = hello_response(PROTOCOL_VERSION, "0.0.9", &["fs.scan"]);
    assert!(
        validate_daemon_hello_with(&missing, HelloPolicy::STRICT.tolerating_version()).is_err()
    );
}

const FULL_CAPABILITIES: [&str; 5] = [
    "fs.scan",
    "search.content",
    "watch.subscribe",
    "pty.persist",
    "pty.attach",
];

fn skewed(capabilities: &[&str], live_ptys: usize, newer: bool) -> SkewedDaemon {
    let capabilities: Vec<String> = capabilities.iter().map(|item| item.to_string()).collect();
    SkewedDaemon {
        kept: KeptDaemon {
            running_version: if newer { "99.0.0" } else { "0.0.9" }.into(),
            live_ptys,
            newer,
        },
        compatible: skewed_daemon_compatible(&capabilities),
    }
}

#[test]
fn older_daemon_is_kept_only_when_compatible_and_hosting_live_terminals() {
    // 兼容（含引入级别声明前的旧 daemon）且有运行中的终端：推迟升级、继续接回。
    assert_eq!(
        skewed(&FULL_CAPABILITIES, 2, false).decision(StaleDaemon::DeferWhileBusy),
        SkewDecision::Keep
    );
    // 用户显式更新：即使有终端也替换。
    assert_eq!(
        skewed(&FULL_CAPABILITIES, 2, false).decision(StaleDaemon::Replace),
        SkewDecision::Replace
    );
    // 兼容但空闲：直接升级。
    assert_eq!(
        skewed(&FULL_CAPABILITIES, 0, false).decision(StaleDaemon::DeferWhileBusy),
        SkewDecision::Replace
    );
    // 没有持久终端能力：终端本就接不回，即使在跑也直接淘汰。
    let no_pty = skewed(&["fs.scan", "search.content", "watch.subscribe"], 3, false);
    assert_eq!(
        no_pty.decision(StaleDaemon::DeferWhileBusy),
        SkewDecision::Replace
    );
    assert!(no_pty.reason().contains("daemon 版本不匹配"));
    assert!(no_pty.reason().contains("不兼容"));
    // 常规能力缺失：文件操作无法继续使用它，同样淘汰。
    assert_eq!(
        skewed(&["pty.persist", "pty.attach"], 1, false).decision(StaleDaemon::DeferWhileBusy),
        SkewDecision::Replace
    );
}

#[test]
fn newer_daemon_is_never_downgraded() {
    // 兼容的更新版：沿用，空闲或显式更新都不降级。
    for live in [0, 3] {
        for mode in [StaleDaemon::DeferWhileBusy, StaleDaemon::Replace] {
            assert_eq!(
                skewed(&FULL_CAPABILITIES, live, true).decision(mode),
                SkewDecision::Keep
            );
        }
    }
    // 不兼容的更新版：拒绝而非降级，提示升级客户端。
    let incompatible = skewed(&["fs.scan", "search.content", "watch.subscribe"], 1, true);
    assert_eq!(
        incompatible.decision(StaleDaemon::Replace),
        SkewDecision::RefuseNewer
    );
    let reason = incompatible.reason();
    assert!(reason.contains("请升级 QingCode"), "{reason}");
    // 不得命中前端「版本不匹配」检测，否则会提供把它降级的「更新远端服务」。
    assert!(!reason.contains("版本不匹配"), "{reason}");
}

#[test]
fn server_versions_compare_with_prerelease_precedence() {
    use std::cmp::Ordering::*;
    let cmp = compare_server_versions;
    assert_eq!(cmp("0.1.17-beta.12", "0.1.17-beta.11"), Some(Greater));
    assert_eq!(cmp("0.1.17-beta.2", "0.1.17-beta.11"), Some(Less));
    assert_eq!(cmp("0.1.17", "0.1.17-beta.12"), Some(Greater));
    assert_eq!(cmp("0.1.18-beta.1", "0.1.17"), Some(Greater));
    assert_eq!(cmp("v0.2.0", "0.1.99"), Some(Greater));
    assert_eq!(cmp("0.1.17-beta.11", "0.1.17-beta.11"), Some(Equal));
    assert_eq!(cmp("0.1.17-beta", "0.1.17-beta.1"), Some(Less));
    assert_eq!(cmp("0.1.17-1", "0.1.17-beta"), Some(Less));
    assert_eq!(cmp("garbage", "0.1.17"), None);
    assert_eq!(cmp("0.1", "0.1.17"), None);
}

#[test]
fn terminal_policy_follows_pty_compat_contract() {
    let level = |caps: &[&str]| {
        validate_daemon_hello_with(
            &hello_response(PROTOCOL_VERSION, "0.0.9", caps),
            HelloPolicy::TERMINAL,
        )
    };
    assert!(level(&["pty.persist", "pty.attach"]).is_ok());
    assert!(level(&["pty.persist", "pty.attach", "pty.compat.1"]).is_ok());
    assert!(level(&["pty.persist"]).is_err());
    let beyond = format!("pty.compat.{}", proto::PTY_COMPAT_LEVEL + 1);
    assert!(level(&["pty.persist", "pty.attach", &beyond]).is_err());
}

#[test]
fn live_pty_count_ignores_exited_terminals() {
    let listed = serde_json::json!({
        "ptys": [
            { "id": "a", "exited": null },
            { "id": "b" },
            { "id": "c", "exited": 0 },
        ]
    });
    assert_eq!(count_live_ptys(&listed), Some(2));
    assert_eq!(count_live_ptys(&serde_json::json!({})), None);
}

#[test]
fn kept_daemon_is_keyed_by_access_token() {
    let old = DaemonAccess {
        bin: "/home/dev/.qingcode/server/new/qingcode-server".into(),
        token: format!("kept-{}", uuid::Uuid::new_v4()),
    };
    let info = KeptDaemon {
        running_version: "0.0.9".into(),
        live_ptys: 2,
        newer: false,
    };
    assert!(kept_daemon(&old).is_none());
    keep_daemon(&old, info.clone());
    assert_eq!(kept_daemon(&old), Some(info));
    // 新 daemon 轮换 token 后不会继承旧实例的沿用状态。
    let replaced = DaemonAccess {
        token: format!("fresh-{}", uuid::Uuid::new_v4()),
        ..old.clone()
    };
    assert!(kept_daemon(&replaced).is_none());
    forget_kept_daemon(&old);
    assert!(kept_daemon(&old).is_none());
}

fn test_session_state() -> (SessionState, SessionEventReceiver) {
    let (events_tx, events_rx) = session_event_channel();
    let state = SessionState {
        pending: Mutex::new(HashMap::new()),
        streams: Mutex::new(HashMap::new()),
        events: events_tx,
        next_stream_id: AtomicU32::new(1),
        closed: AtomicBool::new(false),
        closed_reason: Mutex::new(None),
        closed_notify: tokio::sync::Notify::new(),
        last_frame: Mutex::new(Instant::now()),
    };
    (state, events_rx)
}

fn route_test_pty_data(state: &SessionState, seq: u64, bytes: usize) {
    let event = Event::PtyData {
        id: "pty".to_string(),
        seq,
        offset: 0,
        data: vec![b'x'; bytes],
    };
    route_session_frame(
        state,
        Frame::new(Kind::Event, CONTROL_STREAM, proto::encode(&event).unwrap()),
    );
}

#[tokio::test]
async fn session_slow_event_consumer_is_byte_bounded_and_fails_pending_rpc() {
    let (state, mut events) = test_session_state();
    let (reply_tx, reply_rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(1, reply_tx);
    let (stream_tx, mut stream_rx) = mpsc::unbounded_channel();
    state.streams.lock().unwrap().insert(2, stream_tx);

    // 实际编码/路由大帧，模拟 PTY 持续输出但终端消费端正等 input RPC。
    let mut sent = 0;
    while !state.closed.load(Ordering::Acquire) && sent < 100 {
        route_test_pty_data(&state, sent, 64 * 1024);
        sent += 1;
    }
    assert!(state.closed.load(Ordering::Acquire));
    assert!(sent < 100, "慢消费者不能导致无界事件积压");
    assert!(state.events.budget.available_permits() < SESSION_EVENT_QUEUE_BYTES);
    let error = tokio::time::timeout(Duration::from_millis(100), reply_rx)
        .await
        .expect("队列溢出必须立即释放等待 RPC 的消费端")
        .unwrap()
        .unwrap_err();
    assert!(error.contains("输出积压"));
    assert!(matches!(
        stream_rx.recv().await,
        Some(SessionInbound::Error(_))
    ));
    tokio::time::timeout(Duration::from_millis(100), state.wait_closed())
        .await
        .expect("写端应立即收到关闭通知，不依赖发送队列空位");

    // 已接受的输出仍按序保留；丢失的末帧不推进终端 next_seq，重连可从缺口补发。
    for seq in 0..sent - 1 {
        match events.recv().await.unwrap() {
            Event::PtyData { seq: actual, .. } => assert_eq!(actual, seq),
            _ => panic!("unexpected event"),
        }
    }
    assert!(events.receiver.is_empty());
    assert_eq!(
        state.events.budget.available_permits(),
        SESSION_EVENT_QUEUE_BYTES
    );
}

#[tokio::test]
async fn session_tiny_event_flood_is_count_bounded() {
    let (state, _events) = test_session_state();
    for seq in 0..SESSION_EVENT_QUEUE_DEPTH as u64 {
        route_test_pty_data(&state, seq, 1);
    }
    assert!(!state.closed.load(Ordering::Acquire));
    assert!(state.events.budget.available_permits() > SESSION_EVENT_QUEUE_BYTES / 2);
    route_test_pty_data(&state, SESSION_EVENT_QUEUE_DEPTH as u64, 1);
    assert!(state.closed.load(Ordering::Acquire));
}

#[tokio::test]
async fn session_slow_event_consumer_does_not_block_rpc_and_consumption_restores_budget() {
    let (state, mut events) = test_session_state();
    for seq in 0..16 {
        route_test_pty_data(&state, seq, 64 * 1024);
    }
    let budget_before = state.events.budget.available_permits();
    let (reply_tx, reply_rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(99, reply_tx);
    let response = Response {
        id: 99,
        result: serde_json::json!({ "ok": true }),
    };
    route_session_frame(
        &state,
        Frame::new(Kind::Res, 99, proto::encode(&response).unwrap()),
    );
    let result = tokio::time::timeout(Duration::from_millis(100), reply_rx)
        .await
        .expect("事件积压不能阻塞控制请求应答")
        .unwrap()
        .unwrap();
    assert_eq!(result["ok"], true);
    assert!(!state.closed.load(Ordering::Acquire));
    assert!(matches!(
        events.recv().await,
        Some(Event::PtyData { seq: 0, .. })
    ));
    assert!(state.events.budget.available_permits() > budget_before);
    route_test_pty_data(&state, 16, 64 * 1024);
    assert_eq!(state.events.budget.available_permits(), budget_before);
}

/// 隔离 Linux daemon 的 opt-in 真机回归：客户端使用生产 russh/HELLO/session，
/// 不启动或关闭 daemon，只清理本次 UUID client 创建的 PTY。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires authorized QC_LIVE_* Linux SSH target and isolated daemon"]
async fn live_daemon_backpressure_reconnects_and_accepts_input() {
    let required = |name: &str| std::env::var(name).expect(name);
    let config = SshConnectionConfig {
        id: format!("backpressure-{}", uuid::Uuid::new_v4()),
        host: required("QC_LIVE_HOST"),
        port: required("QC_LIVE_PORT").parse().unwrap(),
        username: required("QC_LIVE_USER"),
        auth_kind: "password".into(),
        password: Some(required("QC_LIVE_PASSWORD")),
        private_key_path: None,
        passphrase: None,
        host_key_fingerprint: Some(required("QC_LIVE_FINGERPRINT")),
        mode: Some(RemoteMode::Server),
    };
    let bin = required("QC_LIVE_SERVER_BIN");
    let run_dir = required("QC_LIVE_SERVER_RUN");
    let token = required("QC_LIVE_SERVER_TOKEN");
    let cwd = required("QC_LIVE_ROOT");
    assert!(bin.starts_with('/') && run_dir.starts_with('/') && cwd.starts_with('/'));
    let daemon = DaemonAccess { bin, token };
    let client_id = config.id.clone();
    let (transport, _) = authenticate_session(config, ConnectionPurpose::Terminal)
        .await
        .unwrap();
    let mut session = live_isolated_daemon_session(&transport, &client_id, &daemon, &run_dir)
        .await
        .unwrap();
    let info = session
        .request("server.info", &serde_json::json!({}))
        .await
        .unwrap();
    let created = session
        .request(
            "pty.create",
            &serde_json::json!({
                "cwd": cwd, "shell": "/bin/sh", "cols": 100, "rows": 30,
            }),
        )
        .await
        .unwrap();
    let pty_id = created["id"].as_str().unwrap().to_string();
    let _unconsumed_events = session.take_events().unwrap();
    let started = Instant::now();
    let result = async {
        // stdout 经真实 SSH 通道进入客户端，消费端刻意不读取。
        let command = b"head -c 4194304 /dev/zero | tr '\\000' x; printf '\\nQC_FLOOD_DONE\\n'\n";
        let _ = session
            .request(
                "pty.input",
                &serde_json::json!({
                    "id": pty_id, "seq": 0, "data": command.as_slice(),
                }),
            )
            .await;
        tokio::time::timeout(Duration::from_secs(10), session.wait_closed())
            .await
            .map_err(|_| "real output did not trigger bounded backpressure".to_string())?;
        if !session
            .closed_reason()
            .unwrap_or_default()
            .contains("输出积压")
        {
            return Err(format!(
                "unexpected disconnect: {:?}",
                session.closed_reason()
            ));
        }
        let overflow_ms = started.elapsed().as_secs_f64() * 1000.0;
        tokio::time::sleep(Duration::from_millis(500)).await;

        let mut resumed =
            live_isolated_daemon_session(&transport, &client_id, &daemon, &run_dir).await?;
        let after = resumed
            .request("server.info", &serde_json::json!({}))
            .await?;
        if after["pid"] != info["pid"] {
            return Err("daemon PID changed during backpressure recovery".to_string());
        }
        let attach = resumed.attach(&pty_id, 0, false).await?;
        if attach
            .response
            .get("exited")
            .is_some_and(|value| !value.is_null())
        {
            return Err("PTY exited during backpressure recovery".to_string());
        }
        let restored = attach.response["screen"]
            .as_str()
            .unwrap_or_default()
            .to_string()
            + &attach
                .chunks
                .iter()
                .map(|chunk| String::from_utf8_lossy(&chunk.data))
                .collect::<String>();
        if !restored.contains("QC_FLOOD_DONE") {
            return Err("attach did not restore final flood output".to_string());
        }
        let seq = attach.response["nextInputSeq"]
            .as_u64()
            .ok_or("missing input sequence")?;
        let mut events = resumed.take_events().ok_or("missing resumed events")?;
        resumed
            .request(
                "pty.input",
                &serde_json::json!({
                    "id": pty_id, "seq": seq,
                    "data": b"printf '\\nQC_AFTER_BACKPRESSURE\\n'\n".as_slice(),
                }),
            )
            .await?;
        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = events.recv().await {
                if let Event::PtyData { data, .. } = event {
                    output.extend_from_slice(&data);
                    if String::from_utf8_lossy(&output).contains("\r\nQC_AFTER_BACKPRESSURE\r\n") {
                        return;
                    }
                }
            }
        })
        .await
        .map_err(|_| "input did not work after attach".to_string())?;
        resumed
            .request("pty.kill", &serde_json::json!({"id": pty_id}))
            .await?;
        resumed.shutdown();
        println!(
            "LIVE_BACKPRESSURE_METRICS {}",
            serde_json::json!({
                "overflow_ms": overflow_ms, "encoded_event_budget": SESSION_EVENT_QUEUE_BYTES,
                "same_daemon_pid": true, "restored_output": true, "input_after_attach": true,
            })
        );
        Ok::<_, String>(())
    }
    .await;

    session.shutdown();
    if let Ok(cleanup) =
        live_isolated_daemon_session(&transport, &client_id, &daemon, &run_dir).await
    {
        let _ = cleanup
            .request("pty.kill", &serde_json::json!({"id": pty_id}))
            .await;
        cleanup.shutdown();
    }
    close_terminal_transport(&transport).await;
    result.unwrap();
}

async fn live_isolated_daemon_session(
    transport: &ConnectedSession,
    client_id: &str,
    daemon: &DaemonAccess,
    run_dir: &str,
) -> Result<DaemonSession, String> {
    let channel = open_session_channel_once(transport, "isolated daemon acceptance")
        .await
        .map_err(|error| error.message)?;
    channel
        .exec(
            true,
            format!(
                "{} connect --stdio --state-dir {}",
                shell_quote(&daemon.bin),
                shell_quote(run_dir)
            ),
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut channel = DaemonChannel::new(DaemonTransport::Ssh(channel));
    daemon_hello(
        &mut channel,
        client_id,
        daemon,
        HelloPolicy::TERMINAL,
        Instant::now() + Duration::from_secs(20),
    )
    .await?;
    Ok(DaemonSession::from_channel(channel))
}

#[tokio::test]
async fn direct_session_routes_wire_replies_events_and_shutdown() {
    let (client, mut peer) = tokio::io::duplex(64 * 1024);
    let mut session =
        DaemonSession::from_channel(DaemonChannel::new(DaemonTransport::Direct(client)));
    let mut events = session.take_events().unwrap();
    let wire = tokio::spawn(async move {
        let request = proto::read_frame(&mut peer).await.unwrap();
        let decoded: Request = proto::decode_value(&request.payload).unwrap();
        assert_eq!(decoded.method, "pty.create");
        let response = Response {
            id: request.stream_id,
            result: serde_json::json!({"id":"original-pty"}),
        };
        proto::write_frame(
            &mut peer,
            &Frame::new(
                Kind::Res,
                request.stream_id,
                proto::encode(&response).unwrap(),
            ),
        )
        .await
        .unwrap();
        let event = Event::PtyData {
            id: "original-pty".into(),
            seq: 0,
            offset: 0,
            data: b"output".to_vec(),
        };
        proto::write_frame(
            &mut peer,
            &Frame::new(Kind::Event, CONTROL_STREAM, proto::encode(&event).unwrap()),
        )
        .await
        .unwrap();
        let mut tail = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), peer.read_to_end(&mut tail))
            .await
            .unwrap()
            .unwrap();
    });
    assert_eq!(
        session
            .request("pty.create", &serde_json::json!({}))
            .await
            .unwrap()["id"],
        "original-pty"
    );
    assert!(matches!(events.recv().await,Some(Event::PtyData {data,..}) if data==b"output"));
    session.shutdown();
    wire.await.unwrap();
}

#[tokio::test]
async fn session_routes_concurrent_replies_and_events_by_stream_id() {
    let (state, mut events_rx) = test_session_state();
    let mut replies = Vec::new();
    for stream_id in 1..=10 {
        let (tx, rx) = oneshot::channel();
        state.pending.lock().unwrap().insert(stream_id, tx);
        replies.push((stream_id, rx));
    }
    let (stream_tx, mut stream_rx) = mpsc::unbounded_channel();
    state.streams.lock().unwrap().insert(99, stream_tx);

    for stream_id in (1..=10).rev() {
        let event = Event::PtyData {
            id: "pty".to_string(),
            seq: stream_id as u64,
            offset: 0,
            data: vec![stream_id as u8],
        };
        route_session_frame(
            &state,
            Frame::new(Kind::Event, CONTROL_STREAM, proto::encode(&event).unwrap()),
        );
        let response = Response {
            id: stream_id,
            result: serde_json::json!({ "stream": stream_id }),
        };
        route_session_frame(
            &state,
            Frame::new(Kind::Res, stream_id, proto::encode(&response).unwrap()),
        );
    }
    let chunk = StreamChunk {
        seq: Some(7),
        offset: 0,
        data: b"replay".to_vec(),
        last: true,
    };
    route_session_frame(
        &state,
        Frame::new(Kind::StreamData, 99, proto::encode(&chunk).unwrap()),
    );

    for (stream_id, rx) in replies {
        let result = rx.await.unwrap().unwrap();
        assert_eq!(result["stream"], stream_id);
    }
    for stream_id in (1..=10).rev() {
        match events_rx.recv().await.unwrap() {
            Event::PtyData { seq, data, .. } => {
                assert_eq!(seq, stream_id as u64);
                assert_eq!(data, vec![stream_id as u8]);
            }
            _ => panic!("wrong event routed"),
        }
    }
    match stream_rx.recv().await.unwrap() {
        SessionInbound::StreamData(chunk) => assert_eq!(chunk.data, b"replay"),
        _ => panic!("wrong stream frame routed"),
    }
}

#[test]
fn daemon_step_budget_caps_each_step_by_remaining_deadline() {
    let now = Instant::now();
    let cap = Duration::from_secs(15);
    // 预算充足：用单步上限，而不是 exec 默认的 120s。
    assert_eq!(
        daemon_step_budget(now + Duration::from_secs(30), now, cap),
        Some(cap)
    );
    // 预算不足：截到剩余时长，整轮探测不会越过总截止。
    assert_eq!(
        daemon_step_budget(now + Duration::from_secs(4), now, cap),
        Some(Duration::from_secs(4))
    );
    // 预算耗尽：跳过该步，ensure 直接以无 daemon 收口。
    assert_eq!(daemon_step_budget(now, now, cap), None);
    assert_eq!(
        daemon_step_budget(now, now + Duration::from_secs(1), cap),
        None
    );
}

#[test]
fn record_assembler_reassembles_chunked_records_independently() {
    let mut assembler = RecordAssembler::default();
    // 第一条记录拆两个分片。
    let first = StreamChunk {
        seq: None,
        offset: 0,
        data: b"{\"type\":\"ma".to_vec(),
        last: false,
    };
    let second = StreamChunk {
        seq: None,
        offset: 12,
        data: b"tch\"}".to_vec(),
        last: true,
    };
    assert!(assembler.push(&first).is_none());
    assert_eq!(
        assembler.push(&second).as_deref(),
        Some(&b"{\"type\":\"match\"}"[..])
    );
    // 第二条记录单分片完整，与上一条互不混淆。
    let third = StreamChunk {
        seq: None,
        offset: 0,
        data: b"{}".to_vec(),
        last: true,
    };
    assert_eq!(assembler.push(&third).as_deref(), Some(&b"{}"[..]));
    // 空记录（空数据 + last）也要出结果。
    let empty = StreamChunk {
        seq: None,
        offset: 0,
        data: Vec::new(),
        last: true,
    };
    assert!(assembler
        .push(&empty)
        .is_some_and(|record| record.is_empty()));
}

#[test]
fn daemon_call_error_only_treats_transport_failures_as_downgrade_worthy() {
    // 传输层错误（String 经 `?` 转换）才需要降级 daemon。
    let transport: DaemonCallError = "daemon 响应超时".to_string().into();
    assert!(transport.is_transport());
    // daemon 应答的业务错误（真机：扫描已删除目录返回 code=io）不降级。
    let remote = DaemonCallError::Remote("daemon fs.scan 失败（io）：无法访问目录".to_string());
    assert!(!remote.is_transport());
    assert_eq!(
        String::from(remote),
        "daemon fs.scan 失败（io）：无法访问目录"
    );
}

#[test]
fn direct_daemon_failure_preserves_reason_without_ssh_fallback_or_blocking_https() {
    let manager = SshManager::new();
    manager.direct_connections.write().unwrap().insert(
        "c1".into(),
        super::super::super::direct::DirectConnectionConfig {
            endpoint: "https://127.0.0.1:48763".into(),
            certificate_fingerprint: "0".repeat(64),
            token: "test-token".into(),
            tunnel: None,
        },
    );
    manager.direct_active.write().unwrap().insert("c1".into());
    let key = server_slot_key("c1", "/srv/app");
    let daemon = sample_daemon_access();
    manager.set_server_slot(
        &key,
        ServerSlot {
            endpoint: Some(ServerEndpoint {
                serve: None,
                daemon: Some(daemon.clone()),
            }),
            ..Default::default()
        },
    );
    let reason = handle_daemon_transport_error(
        &manager,
        &key,
        &daemon,
        &DaemonCallError::Transport("daemon 版本不匹配：远端 old，本端 current".into()),
    )
    .unwrap_err();
    assert!(reason.contains("daemon 版本不匹配"));
    assert!(!reason.contains("检查独立端口"));
    let slot = manager.server_slot(&key).unwrap();
    assert!(slot.endpoint.is_none());
    assert_eq!(slot.last_failure.as_deref(), Some(reason.as_str()));
    assert!(slot.daemon_downgraded_at.is_none());
    assert!(
        manager.connection_is_open("c1"),
        "HTTPS must remain available when WSS fails"
    );
    assert!(manager.sessions.read().unwrap().is_empty());
}

#[test]
fn ssh_daemon_failure_still_allows_serve_fallback() {
    let manager = SshManager::new();
    let key = server_slot_key("c1", "/srv/app");
    let daemon = sample_daemon_access();
    manager.set_server_slot(
        &key,
        ServerSlot {
            endpoint: Some(ServerEndpoint {
                serve: Some(ServeEndpoint {
                    port: 4000,
                    token: "t".into(),
                }),
                daemon: Some(daemon.clone()),
            }),
            ..Default::default()
        },
    );
    handle_daemon_transport_error(
        &manager,
        &key,
        &daemon,
        &DaemonCallError::Transport("daemon 响应超时".into()),
    )
    .unwrap();
    let slot = manager.server_slot(&key).unwrap();
    assert_eq!(slot.endpoint.unwrap().serve.unwrap().port, 4000);
    assert!(slot.daemon_downgraded_at.is_some());
}

#[test]
fn daemon_downgrade_keeps_serve_endpoint() {
    let manager = SshManager::new();
    let key = server_slot_key("c1", "/srv/app");
    // 没有端点时降级是空操作，不报错。
    downgrade_server_daemon(&manager, &key, &sample_daemon_access());
    manager.set_server_slot(
        &key,
        ServerSlot {
            endpoint: Some(ServerEndpoint {
                serve: Some(ServeEndpoint {
                    port: 4000,
                    token: "t".to_string(),
                }),
                daemon: Some(sample_daemon_access()),
            }),
            ..Default::default()
        },
    );
    downgrade_server_daemon(&manager, &key, &sample_daemon_access());
    let slot = manager.server_slot(&key).unwrap();
    let endpoint = slot.endpoint.as_ref().unwrap();
    // serve 端点保留，仅 daemon 标记被清掉：后续操作直接走 serve。
    assert_eq!(endpoint.serve.as_ref().unwrap().port, 4000);
    assert!(endpoint.daemon.is_none());
    // 降级时间被记录：冷却 5 分钟后 ensure 快路径才会重新探测 daemon。
    assert!(slot.daemon_downgraded_at.is_some());
    assert!(!daemon_downgrade_retry_ready(
        slot.daemon_downgraded_at,
        Instant::now()
    ));
    assert!(daemon_downgrade_retry_ready(
        slot.daemon_downgraded_at
            .map(|at| at - AGENT_DAEMON_RETRY_AFTER_DOWNGRADE),
        Instant::now()
    ));
    // 从未降级（None）不需要重试。
    assert!(!daemon_downgrade_retry_ready(None, Instant::now()));
}

#[test]
fn daemon_request_params_roundtrip_as_msgpack_map() {
    let request = Request::with_params(
        DAEMON_REQUEST_ID,
        "fs.scan",
        &serde_json::json!({ "root": "/srv/app", "path": "src" }),
    )
    .unwrap();
    let bytes = proto::encode(&request).unwrap();
    let decoded: Request = proto::decode_value(&bytes).unwrap();
    assert_eq!(decoded.method, "fs.scan");
    let params: serde_json::Value = decoded.parse().unwrap();
    assert_eq!(params["root"], "/srv/app");
    assert_eq!(params["path"], "src");
    // HELLO 请求同样走 MessagePack map：字段名按 camelCase 编码。
    let hello = HelloRequest {
        client_id: "c1".into(),
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        token: "t".into(),
        resume_token: None,
    };
    let decoded: HelloRequest = proto::decode_value(&proto::encode(&hello).unwrap()).unwrap();
    assert_eq!(decoded.client_id, "c1");
    assert_eq!(decoded.protocol_min, PROTOCOL_VERSION);
}
