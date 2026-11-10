use super::*;
#[cfg(unix)]
use qingcode_server::daemon::{run_async as run_loopback_daemon, DaemonOptions, RunDir};
#[cfg(unix)]
use qingcode_server::ipc::IpcEndpoint;
#[cfg(unix)]
use qingcode_server::proto::{
    self, ErrorBody, Frame, HelloRequest, Kind, Request, Response, StreamEnd, WindowCredit,
    CONTROL_STREAM, PROTOCOL_VERSION, WINDOW_BYTES,
};
#[cfg(unix)]
use tokio::io::{AsyncRead, AsyncWrite};

#[test]
fn reconnect_delay_schedule_matches_watch() {
    let delays = (1..=10)
        .map(|attempt| reconnect_delay_schedule(attempt).as_secs())
        .collect::<Vec<_>>();
    assert_eq!(delays, vec![0, 5, 5, 10, 10, 10, 10, 10, 30, 30]);
}

#[test]
fn attach_falls_back_to_screen_after_repeated_replay_failures() {
    // 首次与第二次仍尝试增量补发，保留滚动历史；之后改要快照，避免无限重连。
    assert!(!attach_should_prefer_screen(0));
    assert!(!attach_should_prefer_screen(1));
    assert!(attach_should_prefer_screen(2));
    assert!(attach_should_prefer_screen(10));
}

#[test]
fn seq_dedup_drops_overlapping_replay() {
    assert!(!seq_is_new(7, 8));
    assert!(seq_is_new(8, 8));
    assert!(seq_is_new(9, 8));
}

#[test]
fn restore_distinguishes_confirmed_absence_from_live_ownership_conflicts() {
    assert!(select_restore_candidate(vec![], "pty", "tab", "owner")
        .unwrap_err()
        .contains("QC_PTY_GONE:"));
    let info = |owner: &str, detached: bool, exited: Option<i32>| {
        serde_json::from_value::<PtyInfoWire>(
            serde_json::json!({"id":"pty","owner":owner,"detached":detached,"exited":exited,
                "cols":80,"rows":24,"nextInputSeq":0,"seq":0}),
        )
        .unwrap()
    };
    assert!(
        select_restore_candidate(vec![info("owner", true, None)], "pty", "tab", "owner").is_ok()
    );
    for candidate in [info("other", true, None), info("owner", false, None)] {
        assert!(
            !select_restore_candidate(vec![candidate], "pty", "tab", "owner")
                .unwrap_err()
                .contains("QC_PTY_GONE:")
        );
    }
    assert!(
        select_restore_candidate(vec![info("owner", true, Some(1))], "pty", "tab", "owner")
            .unwrap_err()
            .contains("QC_PTY_GONE:")
    );
}

fn test_terminal() -> PersistentTerminal {
    let (commands, _rx) = mpsc::channel(1);
    PersistentTerminal {
        id: "t".into(),
        pty_id: "p".into(),
        connection_id: "c".into(),
        root_uri: "ssh://c/root".into(),
        next_seq: AtomicU64::new(0),
        next_input_seq: AtomicU64::new(0),
        size: Mutex::new((80, 24)),
        pending_input: Mutex::new(VecDeque::new()),
        input_ready: Notify::new(),
        closed: AtomicBool::new(false),
        detach_requested: Notify::new(),
        proxy_finished: AtomicBool::new(false),
        proxy_stopped: Notify::new(),
        commands,
        kill_context: Mutex::new(serde_json::Value::Null),
    }
}

#[test]
fn queued_resizes_keep_each_requested_size_and_full_queue_keeps_latest() {
    let (commands, mut rx) = mpsc::channel(2);
    let terminal = PersistentTerminal {
        commands,
        ..test_terminal()
    };
    // 补重绘连发 rows-1 与 rows：排队后两步都要保留，不能都读成最新尺寸。
    terminal.resize(100, 29).unwrap();
    terminal.resize(100, 30).unwrap();
    // 队列满不算失败：最新尺寸已记下，处理排队命令时会补到它。
    terminal.resize(120, 40).unwrap();
    let mut received = Vec::new();
    while let Ok(TerminalCommand::Resize(cols, rows)) = rx.try_recv() {
        received.push((cols, rows));
    }
    assert_eq!(received, vec![(100, 29), (100, 30)]);
    assert_eq!(*terminal.size.lock().unwrap(), (120, 40));
    drop(rx);
    assert!(
        terminal.resize(80, 24).is_err(),
        "会话循环结束后应报告终端已结束"
    );
}

#[tokio::test]
async fn reconnect_to_exited_terminal_preserves_exit_without_sending_pending_input() {
    let terminal = test_terminal();
    let pending = b"echo queued-during-disconnect\n".to_vec();
    terminal.write(pending.clone()).unwrap();

    // 模拟 attach 已报告退出、daemon 随即回收 PTY。旧逻辑会先发 resize/input，
    // 将这里的「不存在」误作传输故障重试，最终误报 daemon 重启并丢失退出码。
    let result = prepare_reconnected_terminal(Some(7), async {
        terminal.pop_pending();
        Err("终端不存在或已回收".to_string())
    })
    .await;
    assert_eq!(result, Ok(Some(7)));
    assert_eq!(terminal.pop_pending(), Some(pending));
}

#[tokio::test]
async fn reconnect_to_live_terminal_prepares_session_and_propagates_failure() {
    let terminal = test_terminal();
    terminal.write(b"echo live\n".to_vec()).unwrap();
    let result = prepare_reconnected_terminal(None, async {
        assert_eq!(terminal.pop_pending(), Some(b"echo live\n".to_vec()));
        Ok(())
    })
    .await;
    assert_eq!(result, Ok(None));

    let result = prepare_reconnected_terminal(None, async {
        Err("daemon pty.resize 请求超时".to_string())
    })
    .await;
    assert_eq!(result, Err("daemon pty.resize 请求超时".to_string()));
}

#[test]
fn pending_input_rejects_overflow_without_dropping_and_keeps_order() {
    let terminal = test_terminal();
    terminal.write(vec![b'a'; 1024 * 1024]).unwrap();
    terminal.write(vec![b'b'; 1024 * 1024]).unwrap();
    // 超过积压上限：整笔拒绝，已排队内容一字节不丢。
    let error = terminal.write(vec![b'c'; 1]).unwrap_err();
    assert!(error.contains("积压"));
    // 发送失败的剩余部分放回队首，仍排在后来的输入之前。
    let first = terminal.pop_pending().unwrap();
    assert_eq!(first[0], b'a');
    terminal.requeue_front(first[512 * 1024..].to_vec());
    let resumed = terminal.pop_pending().unwrap();
    assert_eq!(resumed.len(), 512 * 1024);
    assert_eq!(resumed[0], b'a');
    assert_eq!(terminal.pop_pending().unwrap()[0], b'b');
    assert!(terminal.pop_pending().is_none());
    // 关闭后不再接受输入。
    terminal.mark_closed();
    assert!(terminal.write(vec![b'x']).is_err());
}

#[test]
fn attach_screen_size_prefers_daemon_grid_and_falls_back_to_local_size() {
    let daemon = serde_json::json!({ "cols": 120, "rows": 40 });
    assert_eq!(attach_screen_size(&daemon, (80, 24)), (120, 40));
    let legacy = serde_json::json!({ "cols": 0, "rows": 99999 });
    assert_eq!(attach_screen_size(&legacy, (80, 24)), (80, 24));
    assert_eq!(
        attach_screen_size(&serde_json::json!({}), (80, 24)),
        (80, 24)
    );
}

#[test]
fn cold_attach_requests_a_screen_instead_of_raw_history() {
    // 冷接回的起始序号必须超出任何真实 seq_end，daemon 才会给快照而不是从头重放。
    assert_eq!(COLD_ATTACH_FROM_SEQ, u64::MAX);
}

#[test]
fn attach_restore_kind_is_selected() {
    assert_eq!(
        attach_result_maps_to_restore_kind(true, 0, false),
        RestoreKind::Snapshot
    );
    assert_eq!(
        attach_result_maps_to_restore_kind(false, 2, false),
        RestoreKind::Replay
    );
    assert_eq!(
        attach_result_maps_to_restore_kind(false, 0, false),
        RestoreKind::None
    );
    assert_eq!(
        attach_result_maps_to_restore_kind(false, 0, true),
        RestoreKind::Exit
    );
}

#[test]
fn attach_chunks_are_reassembled_by_seq_and_offset() {
    let chunks = vec![
        StreamChunk {
            seq: Some(1),
            offset: 0,
            data: b"ab".to_vec(),
            last: false,
        },
        StreamChunk {
            seq: Some(1),
            offset: 2,
            data: b"cd".to_vec(),
            last: true,
        },
    ];
    assert_eq!(
        assemble_attach_chunks(&chunks).unwrap(),
        vec![(1, b"abcd".to_vec())]
    );
}

#[test]
fn persistent_event_payloads_match_frontend_contract() {
    let reconnecting = serde_json::to_value(TerminalConnectionPayload {
        id: "t1".into(),
        state: "reconnecting",
        attempt: Some(2),
        reason: Some("network lost".into()),
        restore: None,
    })
    .unwrap();
    assert_eq!(reconnecting["state"], "reconnecting");
    assert_eq!(reconnecting["attempt"], 2);
    assert!(reconnecting.get("restore").is_none());

    let attached = serde_json::to_value(TerminalConnectionPayload {
        id: "t1".into(),
        state: "attached",
        attempt: None,
        reason: None,
        restore: Some("snapshot"),
    })
    .unwrap();
    assert_eq!(attached["restore"], "snapshot");
    assert!(attached.get("attempt").is_none());

    let data = serde_json::to_value(PersistentTerminalDataPayload {
        id: "t1".into(),
        data: "aGk=".into(),
        next_seq: 42,
    })
    .unwrap();
    assert_eq!(data["nextSeq"], 42);
    let screen = serde_json::to_value(TerminalScreenPayload {
        id: "t1".into(),
        data: "S".into(),
        cols: 80,
        rows: 24,
        next_seq: 7,
    })
    .unwrap();
    assert_eq!(
        (screen["cols"].clone(), screen["nextSeq"].clone()),
        (80.into(), 7.into())
    );

    let exit = serde_json::to_value(TerminalExitPayload {
        id: "t1".into(),
        exit_code: 7,
        disconnected: true,
        reason: Some("daemon restarted".into()),
    })
    .unwrap();
    assert_eq!(exit["exitCode"], 7);
    assert_eq!(exit["disconnected"], true);
    assert_eq!(exit["reason"], "daemon restarted");

    let spawn = serde_json::to_value(TerminalSpawnResult {
        resolved_shell: Some("bash".into()),
        fallback_from: None,
        persistent: false,
        pty_id: None,
        connection_id: None,
        persistent_fallback_reason: Some("daemon unavailable".into()),
    })
    .unwrap();
    assert_eq!(spawn["persistent"], false);
    assert_eq!(spawn["persistentFallbackReason"], "daemon unavailable");
    assert!(spawn.get("persistent_fallback_reason").is_none());

    let persistent = serde_json::to_value(TerminalSpawnResult {
        resolved_shell: None,
        fallback_from: None,
        persistent: true,
        pty_id: Some("pty-1".into()),
        connection_id: Some("remote-a".into()),
        persistent_fallback_reason: None,
    })
    .unwrap();
    assert_eq!(persistent["ptyId"], "pty-1");
    assert_eq!(persistent["connectionId"], "remote-a");
    assert!(persistent.get("pty_id").is_none());
}

fn pty_info(id: &str, owner: Option<&str>, cwd: &str) -> PtyInfoWire {
    PtyInfoWire {
        id: id.into(),
        name: Some("opencode".into()),
        owner: owner.map(str::to_string),
        cwd: Some(cwd.into()),
        cols: 120,
        rows: 40,
        exited: None,
        detached: true,
        detached_remaining_ms: Some(60_000),
    }
}

#[test]
fn detached_terminal_kill_requires_owner_detached_state_and_trusted_root() {
    let mut root = RegisteredRoot {
        uri: "ssh://remote-a/home/dev/app".into(),
        canonical_path: "/home/dev/app".into(),
        trusted: true,
    };
    let client_id = "install:remote-a";
    let mut info = pty_info("idle-pty", Some(client_id), "/home/dev/app");
    assert!(validate_detached_terminal_for_kill(&info, client_id, &root).is_ok());
    // 已退出但尚未回收的 PTY 也应能直接清理，无须接回失败后再遗留。
    info.exited = Some(0);
    assert!(validate_detached_terminal_for_kill(&info, client_id, &root).is_ok());
    assert!(validate_detached_terminal_for_kill(&info, "other-install", &root).is_err());
    info.owner = None;
    assert!(validate_detached_terminal_for_kill(&info, client_id, &root).is_err());
    info.owner = Some(client_id.into());
    info.detached = false;
    assert!(validate_detached_terminal_for_kill(&info, client_id, &root).is_err());
    info.detached = true;
    info.cwd = Some("/home/dev/app-sibling".into());
    assert!(validate_detached_terminal_for_kill(&info, client_id, &root).is_err());
    info.cwd = None;
    assert!(validate_detached_terminal_for_kill(&info, client_id, &root).is_err());
    info.cwd = Some("/home/dev/app/subdir".into());
    root.trusted = false;
    assert!(validate_detached_terminal_for_kill(&info, client_id, &root).is_err());
}

#[test]
fn exit_kill_accepts_attached_sessions_but_checks_owner_and_root() {
    let mut root = RegisteredRoot {
        uri: "ssh://c/work".into(),
        canonical_path: "/work".into(),
        trusted: true,
    };
    let mut info = pty_info("pty", Some("install:c"), "/work/project");
    info.detached = false;
    assert!(validate_terminal_for_exit(&info, "install:c", &root).is_ok());
    assert!(validate_detached_terminal_for_kill(&info, "install:c", &root).is_err());
    assert!(validate_terminal_for_exit(&info, "other:c", &root).is_err());
    info.cwd = Some("/work-sibling".into());
    assert!(validate_terminal_for_exit(&info, "install:c", &root).is_err());
    info.cwd = Some("/work".into());
    root.trusted = false;
    assert!(validate_terminal_for_exit(&info, "install:c", &root).is_err());
}

#[tokio::test]
async fn exit_detach_stops_proxy_without_marking_process_closed_or_sending_kill() {
    let terminal = Arc::new(test_terminal());
    let worker = Arc::clone(&terminal);
    let task = tokio::spawn(async move {
        worker.detach_requested.notified().await;
        assert!(!worker.closed.load(Ordering::Acquire));
        worker.proxy_finished.store(true, Ordering::Release);
        worker.proxy_stopped.notify_waiters();
    });
    terminal.detach_for_exit().await.unwrap();
    task.await.unwrap();
    assert!(!terminal.closed.load(Ordering::Acquire));
    // Repeated detach on an already stopped proxy is idempotent.
    terminal.detach_for_exit().await.unwrap();
}

#[test]
fn detached_terminal_maps_owned_pty_cwd_to_ssh_uri() {
    let roots = vec![RegisteredRoot {
        uri: "ssh://remote-a/home/dev/app".into(),
        canonical_path: "/home/dev/app".into(),
        trusted: true,
    }];
    let terminal = detached_terminal_from_info(
        pty_info("pty-1", Some("install:remote-a"), "/home/dev/app"),
        "remote-a",
        &roots,
    )
    .unwrap();
    assert_eq!(terminal.pty_id, "pty-1");
    assert_eq!(terminal.connection_id, "remote-a");
    assert_eq!(terminal.cwd, "ssh://remote-a/home/dev/app");
    assert_eq!((terminal.cols, terminal.rows), (120, 40));
    assert_eq!(terminal.name.as_deref(), Some("opencode"));
    let json = serde_json::to_value(&terminal).unwrap();
    assert_eq!(json["ptyId"], "pty-1");
    assert_eq!(json["connectionId"], "remote-a");
    assert_eq!(json["detachedRemainingMs"], 60_000);
    assert!(json.get("pty_id").is_none());

    let windows_roots = vec![RegisteredRoot {
        uri: "ssh://remote-a/D:/code/app".into(),
        canonical_path: "/D:/code/app".into(),
        trusted: true,
    }];
    let windows = detached_terminal_from_info(
        pty_info("pty-win", Some("install:remote-a"), r"\\?\D:\code\app"),
        "remote-a",
        &windows_roots,
    )
    .unwrap();
    assert_eq!(windows.cwd, "ssh://remote-a/D:/code/app");
}

#[test]
fn detached_terminal_list_requires_exact_owner_and_trusted_root() {
    let client_id = "install:remote-a";
    let owned = owned_detached_ptys(
        vec![
            pty_info("owned", Some(client_id), "/home/dev/app"),
            pty_info("other", Some("install:remote-b"), "/home/dev/app"),
            pty_info("legacy", None, "/home/dev/app"),
        ],
        client_id,
    );
    assert_eq!(owned.len(), 1);
    assert_eq!(owned[0].id, "owned");

    let untrusted = vec![RegisteredRoot {
        uri: "ssh://remote-a/home/dev/app".into(),
        canonical_path: "/home/dev/app".into(),
        trusted: false,
    }];
    assert!(detached_terminal_from_info(
        pty_info("owned", Some(client_id), "/home/dev/app"),
        "remote-a",
        &untrusted,
    )
    .is_none());
}

#[test]
fn mobile_terminal_is_never_offered_as_a_desktop_orphan_after_restart() {
    let root = RegisteredRoot {
        uri: "ssh://remote-a/home/dev/app".into(),
        canonical_path: "/home/dev/app".into(),
        trusted: true,
    };
    let client_id = "install:remote-a";
    let mut mobile = pty_info("phone-pty", Some(client_id), "/home/dev/app");
    mobile.name = Some("mobile-phone-session".into());
    let desktop = pty_info("desktop-pty", Some(client_id), "/home/dev/app");

    // Both share the installation owner. No MobileState/Hub is available
    // after restart, so the persisted daemon name must be sufficient.
    let owned = owned_detached_ptys(vec![mobile, desktop], client_id);
    assert_eq!(owned.len(), 2);
    let orphans: Vec<_> = owned
        .into_iter()
        .filter_map(|info| {
            detached_terminal_from_info(info, "remote-a", std::slice::from_ref(&root))
        })
        .collect();
    assert_eq!(orphans.len(), 1);
    assert_eq!(orphans[0].pty_id, "desktop-pty");
}

#[test]
fn mobile_terminal_cannot_be_restored_from_a_stale_desktop_tab() {
    let client_id = "install:remote-a";
    let mut mobile = pty_info("phone-pty", Some(client_id), "/home/dev/app");
    mobile.name = Some("mobile-phone-session".into());
    let error = select_restore_candidate(vec![mobile], "phone-pty", "tab", client_id).unwrap_err();
    assert!(error.contains("移动端终端不能接回桌面"));
    // It is still alive; never classify rejection as a missing PTY.
    assert!(!error.contains("QC_PTY_GONE:"));
}

#[test]
fn mobile_terminal_is_restored_only_by_its_own_session_id() {
    let client_id = "install:remote-a";
    let mut mobile = pty_info("phone-pty", Some(client_id), "/home/dev/app");
    mobile.name = Some("mobile-phone-session".into());
    assert!(select_restore_candidate(
        vec![mobile.clone()],
        "phone-pty",
        "mobile-phone-session",
        client_id
    )
    .is_ok());
    assert!(
        select_restore_candidate(vec![mobile], "phone-pty", "mobile-other", client_id).is_err()
    );
}

#[test]
fn detached_mobile_list_keeps_only_phone_terminals_in_trusted_roots() {
    let root = RegisteredRoot {
        uri: "ssh://remote-a/home/dev/app".into(),
        canonical_path: "/home/dev/app".into(),
        trusted: true,
    };
    let roots = std::slice::from_ref(&root);
    let client_id = "install:remote-a";
    let mut mobile = pty_info("phone-pty", Some(client_id), "/home/dev/app/src");
    mobile.name = Some("mobile-phone-session".into());
    assert_eq!(
        detached_mobile_terminal_from_info(mobile.clone(), roots),
        Some(DetachedMobileTerminal {
            session_id: "mobile-phone-session".into(),
            pty_id: "phone-pty".into(),
            root_uri: "ssh://remote-a/home/dev/app".into(),
            cols: mobile.cols,
            rows: mobile.rows,
        })
    );

    let desktop = pty_info("desktop-pty", Some(client_id), "/home/dev/app");
    assert_eq!(detached_mobile_terminal_from_info(desktop, roots), None);

    let mut elsewhere = pty_info("phone-pty", Some(client_id), "/srv/other");
    elsewhere.name = Some("mobile-phone-session".into());
    assert_eq!(detached_mobile_terminal_from_info(elsewhere, roots), None);

    let untrusted = RegisteredRoot {
        trusted: false,
        ..root.clone()
    };
    assert_eq!(
        detached_mobile_terminal_from_info(mobile, std::slice::from_ref(&untrusted)),
        None
    );
}

#[test]
fn stale_desktop_orphan_actions_cannot_kill_mobile_terminals() {
    let root = RegisteredRoot {
        uri: "ssh://remote-a/home/dev/app".into(),
        canonical_path: "/home/dev/app".into(),
        trusted: true,
    };
    let client_id = "install:remote-a";
    let mut mobile = pty_info("phone-pty", Some(client_id), "/home/dev/app");
    mobile.name = Some("mobile-phone-session".into());
    assert!(validate_detached_terminal_for_kill(&mobile, client_id, &root).is_err());
    // Explicit connection/project cleanup still owns this terminal.
    assert!(validate_terminal_for_exit(&mobile, client_id, &root).is_ok());
}

#[test]
fn missing_attach_terminal_is_classified_as_daemon_restart() {
    assert!(attach_terminal_is_gone("终端不存在或已回收：abc"));
    assert!(!attach_terminal_is_gone("daemon 响应超时"));
}

#[cfg(unix)]
struct LoopbackClient {
    stream: qingcode_server::ipc::IpcStream,
    next_id: u32,
}

#[cfg(unix)]
impl LoopbackClient {
    async fn connect(run_dir: &RunDir) -> Self {
        let endpoint = IpcEndpoint::new(run_dir.dir());
        let mut stream = endpoint.connect().await.unwrap();
        let hello = HelloRequest {
            client_id: "loopback-client".to_string(),
            protocol_min: PROTOCOL_VERSION,
            protocol_max: PROTOCOL_VERSION,
            token: run_dir.read_token().unwrap(),
            resume_token: None,
        };
        write_loopback_frame(
            &mut stream,
            &Frame::new(Kind::Hello, CONTROL_STREAM, proto::encode(&hello).unwrap()),
        )
        .await;
        let frame = read_loopback_frame(&mut stream).await;
        assert_eq!(frame.kind, Kind::Hello);
        Self { stream, next_id: 1 }
    }

    async fn request<T: Serialize>(&mut self, method: &str, params: &T) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let request = Request::with_params(id, method, params).unwrap();
        write_loopback_frame(
            &mut self.stream,
            &Frame::new(Kind::Req, id, proto::encode(&request).unwrap()),
        )
        .await;
        id
    }

    async fn wait_response(&mut self, id: u32) -> serde_json::Value {
        loop {
            let frame = read_loopback_frame(&mut self.stream).await;
            maybe_ack_loopback_ping(&mut self.stream, &frame).await;
            match frame.kind {
                Kind::Res if frame.stream_id == id => {
                    return proto::decode_value::<Response>(&frame.payload)
                        .unwrap()
                        .result;
                }
                Kind::Err if frame.stream_id == id => {
                    let error = proto::decode_value::<ErrorBody>(&frame.payload).unwrap();
                    panic!("loopback request {id} failed: {error:?}");
                }
                _ => {}
            }
        }
    }

    async fn wait_response_collecting_events(
        &mut self,
        id: u32,
    ) -> (serde_json::Value, Vec<Event>) {
        let mut events = Vec::new();
        loop {
            let frame = read_loopback_frame(&mut self.stream).await;
            maybe_ack_loopback_ping(&mut self.stream, &frame).await;
            match frame.kind {
                Kind::Res if frame.stream_id == id => {
                    let result = proto::decode_value::<Response>(&frame.payload)
                        .unwrap()
                        .result;
                    return (result, events);
                }
                Kind::Err if frame.stream_id == id => {
                    let error = proto::decode_value::<ErrorBody>(&frame.payload).unwrap();
                    panic!("loopback request {id} failed: {error:?}");
                }
                Kind::Event => {
                    if let Ok(event) = proto::decode_value::<Event>(&frame.payload) {
                        events.push(event);
                    }
                }
                _ => {}
            }
        }
    }

    async fn wait_attach(&mut self, id: u32) -> (serde_json::Value, Vec<StreamChunk>) {
        let mut response = None;
        let mut chunks = Vec::new();
        let mut window = qingcode_server::proto::ReceiverWindow::new(WINDOW_BYTES);
        loop {
            let frame = read_loopback_frame(&mut self.stream).await;
            maybe_ack_loopback_ping(&mut self.stream, &frame).await;
            match frame.kind {
                Kind::Res if frame.stream_id == id => {
                    response = Some(
                        proto::decode_value::<Response>(&frame.payload)
                            .unwrap()
                            .result,
                    );
                }
                Kind::StreamData if frame.stream_id == id => {
                    if let Some(credit) = window.consume(frame.payload.len()) {
                        let payload = proto::encode(&WindowCredit { credit }).unwrap();
                        write_loopback_frame(
                            &mut self.stream,
                            &Frame::new(Kind::Window, id, payload),
                        )
                        .await;
                    }
                    chunks.push(proto::decode_value(&frame.payload).unwrap());
                }
                Kind::StreamEnd if frame.stream_id == id => {
                    let end: StreamEnd = proto::decode_value(&frame.payload).unwrap();
                    assert!(end.ok, "attach stream failed: {end:?}");
                    return (response.expect("attach response"), chunks);
                }
                Kind::Err if frame.stream_id == id => {
                    let error = proto::decode_value::<ErrorBody>(&frame.payload).unwrap();
                    panic!("loopback attach failed: {error:?}");
                }
                _ => {}
            }
        }
    }
}

#[cfg(unix)]
async fn write_loopback_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) {
    proto::write_frame(writer, frame).await.unwrap();
}

#[cfg(unix)]
async fn read_loopback_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Frame {
    tokio::time::timeout(Duration::from_secs(10), proto::read_frame(reader))
        .await
        .expect("loopback frame timeout")
        .expect("loopback read failed")
}

#[cfg(unix)]
async fn maybe_ack_loopback_ping<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Frame) {
    if frame.kind == Kind::Ping {
        write_loopback_frame(writer, &Frame::empty(Kind::Pong, CONTROL_STREAM)).await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn loopback_persistent_terminal_survives_channel_drop() {
    let state_dir = std::env::temp_dir().join(format!(
        "qingcode-terminal-loopback-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = state_dir.join("root");
    std::fs::create_dir_all(&root).unwrap();
    let run_dir = RunDir::resolve(Some(&state_dir.join("run"))).unwrap();
    let options = DaemonOptions {
        state_dir: Some(state_dir.join("run")),
        ..Default::default()
    };
    let handle = tokio::spawn(async move { run_loopback_daemon(options).await });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while run_dir.read_token().is_err() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let mut client = LoopbackClient::connect(&run_dir).await;
    let create_id = client
        .request(
            "pty.create",
            &serde_json::json!({
                "cwd": root,
                "shell": "/bin/sh",
                "cols": 80,
                "rows": 24
            }),
        )
        .await;
    let created = client.wait_response(create_id).await;
    let pty_id = created["id"].as_str().unwrap().to_string();

    // 默认 shell 从不发送输入；断开后直接关闭，不依赖 attach/replay。
    let idle_create_id = client
        .request(
            "pty.create",
            &serde_json::json!({ "cwd": root, "cols": 80, "rows": 24 }),
        )
        .await;
    let idle = client.wait_response(idle_create_id).await;
    let idle_pty_id = idle["id"].as_str().unwrap().to_string();

    #[derive(Serialize)]
    struct Input<'a> {
        id: &'a str,
        data: ByteArray<'a>,
    }
    struct ByteArray<'a>(&'a [u8]);
    impl Serialize for ByteArray<'_> {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            serializer.serialize_bytes(self.0)
        }
    }
    let input_id = client
        .request(
            "pty.input",
            &Input {
                id: &pty_id,
                data: ByteArray(b"echo qingcode-loopback\n"),
            },
        )
        .await;
    let (_, early_events) = client.wait_response_collecting_events(input_id).await;

    let mut live = Vec::new();
    for event in early_events {
        if let Event::PtyData { id, data, .. } = event {
            if id == pty_id {
                live.extend_from_slice(&data);
            }
        }
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&live).contains("qingcode-loopback") {
        assert!(tokio::time::Instant::now() < deadline);
        let frame = read_loopback_frame(&mut client.stream).await;
        maybe_ack_loopback_ping(&mut client.stream, &frame).await;
        if frame.kind == Kind::Event {
            if let Ok(Event::PtyData { id, data, .. }) = proto::decode_value(&frame.payload) {
                if id == pty_id {
                    live.extend_from_slice(&data);
                }
            }
        }
    }

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut client = LoopbackClient::connect(&run_dir).await;
    let list_id = client.request("pty.list", &serde_json::json!({})).await;
    let listed = client.wait_response(list_id).await;
    let entry = listed["ptys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == pty_id)
        .cloned()
        .expect("daemon dropped the persistent PTY");
    assert_eq!(entry["detached"], true);

    let idle_entry = listed["ptys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == idle_pty_id)
        .expect("daemon dropped the idle PTY");
    assert_eq!(idle_entry["detached"], true);
    assert_eq!(idle_entry["nextInputSeq"], 0);
    let kill_id = client
        .request("pty.kill", &serde_json::json!({ "id": idle_pty_id }))
        .await;
    client.wait_response(kill_id).await;
    let list_id = client.request("pty.list", &serde_json::json!({})).await;
    let remaining = client.wait_response(list_id).await;
    assert!(remaining["ptys"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["id"] != idle_pty_id));

    let attach_id = client
        .request(
            "pty.attach",
            &serde_json::json!({ "id": pty_id, "fromSeq": 0 }),
        )
        .await;
    let (_, chunks) = client.wait_attach(attach_id).await;
    let replay = assemble_attach_chunks(&chunks).unwrap();
    let replayed = replay
        .into_iter()
        .flat_map(|(_, data)| data)
        .collect::<Vec<_>>();
    assert!(String::from_utf8_lossy(&replayed).contains("qingcode-loopback"));

    drop(client);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut client = LoopbackClient::connect(&run_dir).await;
    let kill_id = client
        .request(
            "pty.kill",
            &serde_json::json!({ "id": pty_id,"source":"detached_cleanup" }),
        )
        .await;
    client.wait_response(kill_id).await;
    let list_id = client.request("pty.list", &serde_json::json!({})).await;
    let listed = client.wait_response(list_id).await;
    assert!(listed["ptys"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["id"] != pty_id));

    let shutdown_id = client
        .request("server.shutdown", &serde_json::json!({}))
        .await;
    client.wait_response(shutdown_id).await;
    let _ = tokio::time::timeout(Duration::from_secs(10), handle).await;
    let _ = std::fs::remove_dir_all(&state_dir);
}
