use super::*;

const CODE: &str = "a1B@3!";
const PEER: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));

fn settings(devices: Vec<Device>) -> SavedSettings {
    SavedSettings {
        desktop_terminals: false,
        endpoint: SavedEndpoint::Port { port: 49123 },
        certificate: vec![1, 2, 3],
        private_key: vec![],
        code: CodeVerifier::new(CODE).unwrap(),
        password: Some(CODE.into()),
        enabled: true,
        devices,
    }
}

fn accepting_hub(devices: Vec<Device>) -> Hub {
    let hub = Hub::default();
    hub.load(&settings(devices));
    hub.inner.lock().unwrap().accepting = true;
    hub
}

fn project() -> Project {
    Project {
        id: "p".into(),
        name: "p".into(),
        path: "C:\\p".into(),
        kind: ProjectKind::Local,
        host: "Windows".into(),
    }
}

#[cfg(windows)]
#[test]
fn local_image_path_uses_wsl_repository_instead_of_windows_cache() {
    let mut project = project();
    project.kind = ProjectKind::Wsl;
    project.path = "wsl://Ubuntu/home/owner/app's workspace".into();
    let root = crate::run_environment::to_host_path(&project.path);
    let path = std::path::Path::new(&root).join(".qingcode/terminal-paste/batch/mobile-image.jpg");
    assert_eq!(
        local_image_path(&project, &path.to_string_lossy()).unwrap(),
        "'/home/owner/app'\\''s workspace/.qingcode/terminal-paste/batch/mobile-image.jpg'"
    );
    assert!(local_image_path(
        &project,
        r"C:\Users\owner\AppData\Local\Temp\mobile-image.jpg"
    )
    .is_err());
    let escape = std::path::Path::new(&root).join("../outside.jpg");
    assert!(local_image_path(&project, &escape.to_string_lossy()).is_err());
}

#[test]
fn image_upload_shares_live_sessions_between_paired_devices_only() {
    let hub = accepting_hub(Vec::new());
    let phone_token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
    let other_token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
    let phone = hub.authenticate(Some(&phone_token)).unwrap();
    let other = hub.authenticate(Some(&other_token)).unwrap();
    let mut inner = hub.inner.lock().unwrap();
    let mut session = Session::new(project(), phone.clone(), 1);
    session.ready = true;
    inner.sessions.insert("mobile-test".into(), session);
    assert!(image_project(&inner, "mobile-test", &phone).is_ok());
    assert!(image_project(&inner, "mobile-test", &other).is_ok());
    assert!(image_project(&inner, "mobile-test", "unpaired").is_err());
    assert!(image_project(&inner, "missing", &phone).is_err());
    inner.sessions.get_mut("mobile-test").unwrap().ready = false;
    assert!(image_project(&inner, "mobile-test", &phone).is_err());
    inner.sessions.get_mut("mobile-test").unwrap().ready = true;
    inner.accepting = false;
    assert!(image_project(&inner, "mobile-test", &phone).is_err());
}

#[test]
fn revoked_device_cannot_reserve_after_a_desktop_prompt_completes() {
    let hub = accepting_hub(Vec::new());
    let token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
    let device = hub.authenticate(Some(&token)).unwrap();
    hub.forget_device(&device);
    assert!(hub
        .reserve_session("late".into(), project(), &device, None)
        .is_err());
    assert!(!hub.holds("late"));
}

#[tokio::test]
async fn revocation_during_spawn_invalidates_the_reservation_and_rejects_late_completion() {
    let hub = Arc::new(accepting_hub(Vec::new()));
    let token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
    let device = hub.authenticate(Some(&token)).unwrap();
    hub.reserve_session("pending".into(), project(), &device, None)
        .unwrap();
    let (spawned, finish) = oneshot::channel();
    let launching = hub.clone();
    let late_spawn = tokio::spawn(async move {
        finish.await.unwrap();
        // false is the production signal to kill the late PTY.
        launching.finish_create("pending", true)
    });
    assert!(hub.forget_device(&device).is_empty());
    assert!(!hub.holds("pending"));
    spawned.send(()).unwrap();
    assert!(!late_spawn.await.unwrap());
    assert!(!hub.holds("pending"));
}

#[test]
fn stopped_listener_or_failed_spawn_cannot_publish_a_session() {
    let hub = accepting_hub(Vec::new());
    let token = hub.pair(PEER, CODE, None, |_| Ok(())).unwrap();
    let device = hub.authenticate(Some(&token)).unwrap();
    hub.reserve_session("failed".into(), project(), &device, None)
        .unwrap();
    assert!(!hub.finish_create("failed", false));
    hub.reserve_session("stopped".into(), project(), &device, None)
        .unwrap();
    hub.inner.lock().unwrap().accepting = false;
    assert!(!hub.finish_create("stopped", true));
    assert!(!hub.holds("stopped"));
}

#[test]
fn image_upload_rejects_invalid_encoding_formats_and_oversized_payloads() {
    use base64::Engine;
    let encode = |bytes| base64::engine::general_purpose::STANDARD.encode(bytes);
    for bytes in [b"\x89PNG\r\n\x1a\n".as_slice(), b"\xff\xd8\xff"] {
        assert_eq!(decode_image(&encode(bytes)).unwrap(), bytes);
    }
    assert!(decode_image("not base64!").is_err());
    assert!(decode_image(&encode(b"<script>code</script>")).is_err());
    assert!(decode_image(&"A".repeat(MAX_IMAGE.div_ceil(3) * 4 + 1)).is_err());
}

#[tokio::test]
async fn image_request_accepts_eight_mb_after_base64_and_json_framing() {
    let mut image = vec![0; MAX_IMAGE];
    image[..3].copy_from_slice(b"\xff\xd8\xff");
    let data = base64::engine::general_purpose::STANDARD.encode(&image);
    let request = json!({ "op": "image", "id": "mobile-test", "data": data }).to_string();
    assert!(request.len() > 128 * 1024);
    let operation = read_operation(
        Full::new(Bytes::from(request)),
        12 * 1024 * 1024,
        Duration::from_secs(60),
    )
    .await
    .unwrap_or_else(|error| panic!("image request rejected: {error:?}"));
    match operation {
        Operation::Image { id, data, .. } => {
            assert_eq!(id, "mobile-test");
            assert_eq!(decode_image(&data).unwrap(), image);
        }
        _ => panic!("expected image upload"),
    }
}

#[tokio::test]
async fn image_request_distinguishes_size_limit_from_invalid_json() {
    let request = json!({ "op": "image", "id": "mobile-test", "data": "A".repeat(128 * 1024) });
    let result = read_operation(
        Full::new(Bytes::from(request.to_string())),
        128 * 1024,
        Duration::from_secs(15),
    )
    .await;
    assert!(matches!(result, Err((StatusCode::PAYLOAD_TOO_LARGE, _))));
    let result = read_operation(
        Full::new(Bytes::from_static(b"{broken")),
        128 * 1024,
        Duration::from_secs(15),
    )
    .await;
    assert!(matches!(result, Err((StatusCode::BAD_REQUEST, _))));
}

#[tokio::test]
async fn image_request_reports_timeout_and_interrupted_body_separately() {
    let pending =
        futures_util::stream::pending::<Result<hyper::body::Frame<Bytes>, std::io::Error>>();
    let result = read_operation(
        http_body_util::StreamBody::new(pending),
        1024,
        Duration::from_millis(5),
    )
    .await;
    assert!(matches!(result, Err((StatusCode::REQUEST_TIMEOUT, _))));
    let interrupted = futures_util::stream::once(async {
        Err::<hyper::body::Frame<Bytes>, _>(std::io::Error::other("disconnected"))
    });
    let result = read_operation(
        http_body_util::StreamBody::new(interrupted),
        1024,
        Duration::from_secs(1),
    )
    .await;
    assert!(
        matches!(result, Err((StatusCode::BAD_REQUEST, message)) if message.contains("传输中断"))
    );
}

#[test]
fn password_accepts_six_to_twenty_graphic_characters_without_complexity_rules() {
    for invalid in [
        "",
        "12345",
        "123456789012345678901",
        "abc 12",
        "a1中BC",
        "abcdef\n",
    ] {
        assert!(!valid_code(invalid));
    }
    for valid in ["123456", "abcdef", "!!!!!!", CODE, "12345678901234567890"] {
        assert!(valid_code(valid));
    }
}

#[test]
fn legacy_settings_migrate_without_pairings_or_a_remembered_password() {
    let legacy = json!({
        "address": "127.0.0.1:49123",
        "certificate": [],
        "private_key": [],
        "code": CodeVerifier::new(CODE).unwrap(),
    });
    let mut restored: SavedSettings = serde_json::from_value(legacy).unwrap();
    assert_eq!(restored.endpoint.port(), 49123);
    assert!(!restored.enabled);
    assert!(restored.devices.is_empty());
    // Verifier-only files stay valid; the password is remembered once set again.
    assert!(restored.password.is_none());
    assert!(!serde_json::to_string(&restored).unwrap().contains(CODE));
    restored.password = Some(CODE.into());
    let remembered: SavedSettings =
        serde_json::from_str(&serde_json::to_string(&restored).unwrap()).unwrap();
    assert!(remembered
        .code
        .matches(remembered.password.as_deref().unwrap()));
    restored.password = None;
    restored.endpoint = SavedEndpoint::Port { port: 49124 };
    let migrated = serde_json::to_value(&restored).unwrap();
    assert_eq!(migrated["port"], 49124);
    assert!(migrated.get("address").is_none());
    assert!(!migrated.to_string().contains(CODE));
}

#[test]
fn pairings_persist_as_digests_and_survive_reload() {
    let hub = accepting_hub(Vec::new());
    let mut saved = Vec::new();
    let token = hub
        .pair(PEER, CODE, Some(" Pixel\u{7} 8 "), |device| {
            saved.push(device.clone());
            Ok(())
        })
        .unwrap();
    assert_eq!(saved[0].name, "Pixel 8");
    let file = serde_json::to_string(&settings(saved.clone())).unwrap();
    assert!(!file.contains(&token));

    let restarted = Hub::default();
    restarted.load(&serde_json::from_str(&file).unwrap());
    restarted.inner.lock().unwrap().accepting = true;
    assert_eq!(restarted.authenticate(Some(&token)).unwrap(), saved[0].id);
    assert_eq!(
        restarted.authenticate(Some("other")).unwrap_err().0,
        StatusCode::UNAUTHORIZED
    );
    // Stopping the listener must not look like a revoked pairing to the phone.
    restarted.inner.lock().unwrap().accepting = false;
    assert_eq!(
        restarted.authenticate(Some(&token)).unwrap_err().0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[test]
fn several_devices_pair_until_the_limit_and_revocation_ends_their_sessions() {
    let hub = accepting_hub(Vec::new());
    let mut tokens = Vec::new();
    for _ in 0..MAX_DEVICES {
        tokens.push(hub.pair(PEER, CODE, None, |_| Ok(())).unwrap());
    }
    assert!(hub
        .pair(PEER, CODE, None, |_| Ok(()))
        .unwrap_err()
        .contains("上限"));
    let first = hub.authenticate(Some(&tokens[0])).unwrap();
    let second = hub.authenticate(Some(&tokens[1])).unwrap();
    {
        let mut inner = hub.inner.lock().unwrap();
        for (id, owner) in [("mobile-a", &first), ("mobile-b", &second)] {
            let mut session = Session::new(project(), owner.clone(), 1);
            session.ready = true;
            inner.sessions.insert(id.into(), session);
        }
    }
    let ended = hub.forget_device(&first);
    assert_eq!(ended, vec![("mobile-a".to_string(), ProjectKind::Local)]);
    assert!(hub.authenticate(Some(&tokens[0])).is_err());
    assert!(hub.holds("mobile-b"));
}

fn handoff_hub() -> Hub {
    let hub = accepting_hub(vec![device("phone"), device("tablet")]);
    hub.inner.lock().unwrap().desktop_terminals = true;
    hub
}

fn device(id: &str) -> Device {
    Device {
        id: id.into(),
        name: format!("{id}-name"),
        token_digest: token_digest(id),
        paired_at: 0,
    }
}

fn ready_session(hub: &Hub, id: &str, owner: &str) {
    hub.reserve_session(id.into(), project(), owner, None)
        .unwrap();
    assert!(hub.finish_create(id, true));
}

#[test]
fn takeover_requires_an_explicit_take_and_invalidates_the_old_lease() {
    let hub = handoff_hub();
    ready_session(&hub, "mobile-a", "phone");
    assert_eq!(hub.claim("mobile-a", "phone", false).unwrap()["lease"], 1);
    // 重连与恢复界面不抢使用权。
    let passive = hub.claim("mobile-a", "tablet", false).unwrap();
    assert_eq!(passive["takenOver"], true);
    assert_eq!(passive["by"], "phone-name");
    assert_eq!(hub.claim("mobile-a", "tablet", true).unwrap()["lease"], 2);
    assert_eq!(hub.authorize("mobile-a", Some(1)).unwrap_err(), TAKEN_OVER);
    assert!(hub.authorize("mobile-a", Some(2)).is_ok());
    let inner = hub.inner.lock().unwrap();
    assert_eq!(
        inner.takeover_reply("mobile-a", Some(1)).unwrap()["by"],
        "tablet-name"
    );
    assert!(inner.takeover_reply("mobile-a", Some(2)).is_none());
}

#[test]
fn restore_scan_runs_once_at_a_time_and_is_throttled() {
    let hub = handoff_hub();
    let start = Instant::now();
    assert!(hub.begin_restore_scan(start));
    // 上一轮没结束时，到了间隔也不并发。
    assert!(!hub.begin_restore_scan(start + RESTORE_SCAN_INTERVAL));
    hub.finish_restore_scan(true, vec!["conn-a".into()]);
    assert!(!hub.begin_restore_scan(start + Duration::from_secs(1)));
    assert!(hub.begin_restore_scan(start + RESTORE_SCAN_INTERVAL));
    assert!(hub.restore_connect_requested());
    assert!(hub.restore_finished("conn-a"));
    assert!(!hub.restore_finished("conn-b"));
}

#[test]
fn restore_scan_stays_off_while_the_listener_is_stopped() {
    let hub = handoff_hub();
    hub.inner.lock().unwrap().accepting = false;
    assert!(!hub.begin_restore_scan(Instant::now()));
}

#[test]
fn phones_without_a_lease_keep_using_phone_sessions() {
    let hub = handoff_hub();
    ready_session(&hub, "mobile-a", "phone");
    hub.claim("mobile-a", "tablet", true).unwrap();
    assert!(hub.authorize("mobile-a", None).is_ok());
    assert!(hub
        .inner
        .lock()
        .unwrap()
        .takeover_reply("mobile-a", None)
        .is_none());
}

#[test]
fn mirrors_never_reach_paths_that_end_processes() {
    let hub = handoff_hub();
    hub.seed_mirror("term-1".into(), project(), "phone", None, 80, 24, "x")
        .unwrap();
    ready_session(&hub, "mobile-a", "phone");
    assert!(!hub
        .take_idle_sessions(Duration::ZERO)
        .iter()
        .any(|(id, _)| id == "term-1"));
    assert!(!hub
        .forget_device("phone")
        .iter()
        .any(|(id, _)| id == "term-1"));
    assert!(!hub
        .take_live_sessions()
        .iter()
        .any(|(id, _)| id == "term-1"));
    assert_eq!(hub.release_mirrors(None), vec!["term-1".to_string()]);
}

#[test]
fn desktop_takeback_stops_the_mirror_and_tells_the_phone_who_took_it() {
    let hub = handoff_hub();
    hub.seed_mirror("term-1".into(), project(), "phone", None, 80, 24, "x")
        .unwrap();
    let lease = hub.claim("term-1", "phone", true).unwrap()["lease"].as_u64();
    assert!(hub.authorize("term-1", lease).is_ok());
    assert!(hub.authorize("term-1", None).is_err());
    hub.take_for_desktop("term-1").unwrap();
    assert_eq!(hub.authorize("term-1", lease).unwrap_err(), TAKEN_OVER);
    assert!(!hub.mirror_active("term-1"));
    hub.mirror_push("term-1", OutputChunk::Bytes("eA==".into()));
    let inner = hub.inner.lock().unwrap();
    assert_eq!(inner.mirrors["term-1"].next, 0);
    assert_eq!(
        inner.takeover_reply("term-1", lease).unwrap()["by"],
        DESKTOP_NAME
    );
}

#[test]
fn reseeded_mirror_never_reuses_an_old_lease() {
    let hub = handoff_hub();
    hub.seed_mirror("term-1".into(), project(), "phone", None, 80, 24, "x")
        .unwrap();
    let old = hub.claim("term-1", "phone", true).unwrap()["lease"].as_u64();
    hub.take_for_desktop("term-1").unwrap();
    hub.seed_mirror("term-1".into(), project(), "tablet", None, 80, 24, "y")
        .unwrap();
    let new = hub.claim("term-1", "tablet", true).unwrap()["lease"].as_u64();
    assert!(new > old);
    assert!(hub.authorize("term-1", old).is_err());
}

#[test]
fn mirrors_need_the_feature_enabled() {
    let hub = accepting_hub(vec![device("phone")]);
    let error = hub
        .seed_mirror("term-1".into(), project(), "phone", None, 80, 24, "x")
        .unwrap_err();
    assert!(error.contains("未开启"));
}

#[test]
fn desktop_view_starts_with_a_snapshot_then_streams_and_falls_back_when_backlogged() {
    let hub = handoff_hub();
    ready_session(&hub, "mobile-a", "phone");
    hub.open_view("mobile-a").unwrap();
    assert!(matches!(
        hub.take_view_output("mobile-a"),
        Some((ViewOutput::Screen(_), None))
    ));
    hub.with_session("mobile-a", |session| {
        session.push(OutputChunk::Bytes("aGk=".into()));
    });
    match hub.take_view_output("mobile-a") {
        Some((ViewOutput::Bytes(bytes), None)) => assert_eq!(bytes, b"hi"),
        _ => panic!("expected incremental output"),
    }
    let huge = base64::engine::general_purpose::STANDARD.encode(vec![b'x'; MAX_VIEW_BACKLOG + 1]);
    hub.with_session("mobile-a", |session| session.push(OutputChunk::Bytes(huge)));
    assert!(matches!(
        hub.take_view_output("mobile-a"),
        Some((ViewOutput::Screen(_), None))
    ));
}

#[test]
fn only_the_desktop_controller_may_type_into_a_viewed_phone_session() {
    let hub = handoff_hub();
    ready_session(&hub, "mobile-a", "phone");
    assert_eq!(hub.desktop_controls("mobile-a").unwrap_err(), TAKEN_OVER);
    hub.take_for_desktop("mobile-a").unwrap();
    assert!(hub.desktop_controls("mobile-a").is_ok());
    assert_eq!(
        hub.claim("mobile-a", "phone", false).unwrap()["by"],
        DESKTOP_NAME
    );
}

#[test]
fn saved_settings_default_desktop_terminals_off() {
    let mut value = serde_json::to_value(settings(Vec::new())).unwrap();
    value.as_object_mut().unwrap().remove("desktop_terminals");
    let loaded: SavedSettings = serde_json::from_value(value).unwrap();
    assert!(!loaded.desktop_terminals);
}

#[test]
fn desktop_entry_points_reject_mobile_terminals() {
    assert!(reject_desktop_use("mobile-abc").is_err());
    assert!(reject_desktop_use("term-1").is_ok());
}

#[test]
fn desktop_summaries_list_every_project_with_device_and_skip_unready() {
    let hub = accepting_hub(Vec::new());
    let token = hub.pair(PEER, CODE, Some("Pixel"), |_| Ok(())).unwrap();
    let owner = hub.authenticate(Some(&token)).unwrap();
    {
        let mut inner = hub.inner.lock().unwrap();
        let mut other = project();
        other.id = "q".into();
        other.name = "a-first".into();
        for (id, project, ready) in [
            ("mobile-b", project(), true),
            ("mobile-a", other, true),
            ("mobile-starting", project(), false),
        ] {
            let mut session = Session::new(project, owner.clone(), 1);
            session.ready = ready;
            inner.sessions.insert(id.into(), session);
        }
    }
    let list = hub.session_summaries(None);
    let ids: Vec<_> = list
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["mobile-a", "mobile-b"]);
    assert_eq!(list[0]["project"]["id"], "q");
    assert_eq!(list[0]["deviceName"], "Pixel");
    assert!(list[0].get("ownDevice").is_none());
    let phone = hub.session_summaries(Some(&owner));
    assert_eq!(phone.len(), 2);
    assert_eq!(phone[0]["ownDevice"], true);
    assert_eq!(
        hub.session_summaries(Some("other-device"))[0]["ownDevice"],
        false
    );
    assert!(hub.session_preview("mobile-starting").is_err());
}

#[test]
fn desktop_preview_is_plain_text_of_history_and_screen() {
    let hub = accepting_hub(Vec::new());
    {
        let mut inner = hub.inner.lock().unwrap();
        let mut session = Session::new(project(), "owner".into(), 1);
        session.ready = true;
        session.screen.resize(20, 2);
        session
            .screen
            .process(b"\x1b[31mone\x1b[0m\r\ntwo\r\nthree");
        inner.sessions.insert("mobile-a".into(), session);
    }
    let preview = hub.session_preview("mobile-a").unwrap();
    assert_eq!(preview["history"], json!(["one"]));
    assert_eq!(preview["screen"], "two\nthree");
    assert_eq!(preview["alternate"], false);
    assert!(hub.rename_session("mobile-a", "构建").is_ok());
    assert_eq!(hub.session_preview("mobile-a").unwrap()["name"], "构建");
}

#[test]
fn preview_notification_is_scheduled_once_until_sent() {
    let hub = accepting_hub(Vec::new());
    hub.inner.lock().unwrap().sessions.insert(
        "mobile-a".into(),
        Session::new(project(), "owner".into(), 1),
    );
    let write = |session: &mut Session| session.push(OutputChunk::Bytes("aGk=".into()));

    assert!(hub.update_for_preview("mobile-a", write));
    assert!(!hub.update_for_preview("mobile-a", write));
    hub.with_session("mobile-a", |session| {
        session.preview_notify_pending = false;
    });
    assert!(hub.update_for_preview("mobile-a", write));
    assert!(!hub.update_for_preview("mobile-missing", write));
}

#[test]
fn failed_persistence_rolls_back_the_pairing() {
    let hub = accepting_hub(Vec::new());
    let error = hub
        .pair(PEER, CODE, None, |_| Err("disk".into()))
        .unwrap_err();
    assert!(error.contains("disk"));
    assert!(hub.inner.lock().unwrap().devices.is_empty());
}

#[test]
fn pairing_attempts_are_limited_per_source_and_in_total() {
    let hub = accepting_hub(Vec::new());
    for _ in 0..MAX_PEER_ATTEMPTS {
        assert_eq!(
            hub.pair(PEER, "wrong", None, |_| Ok(())).unwrap_err(),
            "密码不正确。"
        );
    }
    assert!(hub
        .pair(PEER, CODE, None, |_| Ok(()))
        .unwrap_err()
        .contains("尝试过多"));
    // Another phone is not locked out by the first source.
    let other = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 21));
    assert!(hub.pair(other, CODE, None, |_| Ok(())).is_ok());

    let aged = Instant::now() - ATTEMPT_WINDOW;
    {
        let mut inner = hub.inner.lock().unwrap();
        inner
            .attempts
            .insert(PEER, VecDeque::from([aged; MAX_PEER_ATTEMPTS]));
        inner.total_attempts = VecDeque::from([Instant::now(); MAX_TOTAL_ATTEMPTS]);
    }
    let third = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 22));
    assert!(hub
        .pair(third, CODE, None, |_| Ok(()))
        .unwrap_err()
        .contains("尝试过多"));
    hub.inner.lock().unwrap().total_attempts.clear();
    assert!(hub.pair(PEER, CODE, None, |_| Ok(())).is_ok());
}

#[test]
fn latest_attach_skips_replay_and_subsequent_poll_only_returns_new_output() {
    let mut session = Session::new(project(), "phone".into(), 1);
    session.screen.resize(40, 4);
    for index in 0..1000 {
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(format!("record {index}\r\n")),
        ));
    }
    let attach = session.latest();
    assert_eq!(attach["chunks"].as_array().unwrap().len(), 1);
    assert_eq!(attach["next"], 1000);
    assert_eq!(attach["more"], false);
    assert_eq!(attach["snapshot"], true);
    assert_eq!(attach["historyAvailable"], true);
    let screen = attach["chunks"][0]["data"].as_str().unwrap();
    assert!(screen.contains("record 999"));
    assert!(!screen.contains("record 0"));
    assert!(screen.len() < 1024);
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode(b"live prompt"),
    ));
    let follow = session.read(1000);
    assert_eq!(follow["chunks"].as_array().unwrap().len(), 1);
    assert_eq!(follow["next"], 1001);
    assert_eq!(follow["reset"], false);
}

#[test]
fn tail_poll_skips_a_redraw_burst_larger_than_one_page() {
    let mut session = Session::new(project(), "phone".into(), 1);
    session.screen.resize(40, 4);
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode(b"prompt"),
    ));
    let caught_up = session.next;
    assert!(!session.should_send_latest(caught_up));
    // 小量新输出照常逐字节回放。
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode(b"small"),
    ));
    assert!(!session.should_send_latest(caught_up));
    // 模拟全屏程序瞬间重绘大量中间帧：积压超过一次轮询上限即改发最新画面。
    let frame = "\x1b[H".to_string() + &"x".repeat(4096);
    for index in 0..64 {
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(format!("{frame}{index}")),
        ));
    }
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode(b"\x1b[2J\x1b[HFINAL FRAME"),
    ));
    assert!(session.should_send_latest(caught_up));
    let latest = session.latest();
    assert_eq!(latest["next"], session.next);
    assert!(latest["chunks"][0]["data"]
        .as_str()
        .unwrap()
        .contains("FINAL FRAME"));
    // 游标越界（已淘汰或来自未来）仍改发最新画面；已追平则不需要。
    assert!(session.should_send_latest(session.next + 1));
    assert!(!session.should_send_latest(session.next));
}

#[test]
fn older_phone_poll_requests_keep_the_replay_contract() {
    let operation: Operation =
        serde_json::from_value(json!({"op":"poll", "id":"mobile-1", "from":0})).unwrap();
    assert!(matches!(
        operation,
        Operation::Poll {
            latest: false,
            tail: false,
            ..
        }
    ));
    let mut session = Session::new(project(), "phone".into(), 1);
    session.push(OutputChunk::Bytes("aGk=".into()));
    assert_eq!(session.read(0)["chunks"], json!(["aGk="]));
}

#[test]
fn session_names_follow_program_titles_and_manual_names_survive_reconnect() {
    let mut session = Session::new(project(), "phone".into(), 7);
    assert_eq!(session.name(), "终端 7");
    let push_title = |session: &mut Session, title: &str| {
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(format!("\x1b]2;{title}\x07")),
        ));
    };
    push_title(&mut session, "OpenCode");
    assert_eq!(session.name(), "OpenCode");
    session.rename("  修复登录  ").unwrap();
    let revision = session.name_revision;
    push_title(&mut session, "Claude");
    assert_eq!(session.name(), "修复登录");
    assert!(session.name_revision > revision);
    assert_eq!(session.latest()["name"], "修复登录");
    assert_eq!(session.read(session.next)["customName"], "修复登录");
    assert_eq!(session.metadata("mobile-7")["name"], "修复登录");
    push_title(&mut session, "⠋ 正在构建");
    for data in [
        session.metadata("mobile-7"),
        session.latest(),
        session.read(session.next),
    ] {
        assert_eq!(data["programTitle"], "⠋ 正在构建");
        assert_eq!(data["name"], "修复登录");
    }
    push_title(&mut session, "Claude");
    session.rename("").unwrap();
    assert_eq!(session.name(), "Claude");
    assert!(session.rename(&"中".repeat(81)).is_err());
    assert!(session.rename("bad\nname").is_err());
    assert_eq!(session.name(), "Claude");
}

fn ssh_session(hub: &Hub, id: &str, number: u64) {
    let mut session = Session::new(
        Project {
            kind: ProjectKind::Ssh,
            ..project()
        },
        "phone".into(),
        number,
    );
    session.ready = true;
    hub.inner
        .lock()
        .unwrap()
        .sessions
        .insert(id.into(), session);
}

fn push_title(hub: &Hub, id: &str, title: &str) {
    hub.with_session(id, |session| {
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(format!("\x1b]2;{title}\x07")),
        ))
    });
}

/// 模拟电脑重启：快照经 JSON 落盘，新进程载入后接回同一个 id。
fn restart_hub(previous: &Hub) -> Hub {
    let file = serde_json::to_vec(&previous.session_names_snapshot()).unwrap();
    let hub = accepting_hub(vec![device("phone")]);
    hub.load_session_names(serde_json::from_slice(&file).unwrap(), unix_now_ms());
    hub
}

fn reserve_restored(hub: &Hub, id: &str) {
    let project = Project {
        kind: ProjectKind::Ssh,
        ..project()
    };
    hub.reserve_session(id.into(), project, "phone", None)
        .unwrap();
    hub.restore_session_name(id);
}

#[test]
fn restored_session_keeps_manual_name_and_identity_after_restart() {
    let before = accepting_hub(vec![device("phone")]);
    ssh_session(&before, "mobile-a", 5);
    before.rename_session("mobile-a", "修复登录").unwrap();
    let created_at = before.inner.lock().unwrap().sessions["mobile-a"].created_at_ms;

    let hub = restart_hub(&before);
    reserve_restored(&hub, "mobile-a");
    let inner = hub.inner.lock().unwrap();
    let session = &inner.sessions["mobile-a"];
    assert_eq!(session.name(), "修复登录");
    assert_eq!(session.custom_name.as_deref(), Some("修复登录"));
    assert_eq!(session.number, 5);
    assert_eq!(session.created_at_ms, created_at);
}

#[test]
fn restored_session_shows_last_program_title_until_a_new_one_arrives() {
    let before = accepting_hub(vec![device("phone")]);
    ssh_session(&before, "mobile-a", 1);
    push_title(&before, "mobile-a", "✳ Claude Code");

    let hub = restart_hub(&before);
    reserve_restored(&hub, "mobile-a");
    hub.with_session("mobile-a", |session| {
        // daemon 的屏幕快照不带标题。
        session.push(OutputChunk::Screen {
            data: "prompt".into(),
            cols: 80,
            rows: 24,
        });
        assert_eq!(session.name(), "Claude Code");
    });
    push_title(&hub, "mobile-a", "OpenCode");
    hub.with_session("mobile-a", |session| assert_eq!(session.name(), "OpenCode"));
}

#[test]
fn restored_label_is_kept_when_the_program_has_no_title() {
    let before = accepting_hub(vec![device("phone")]);
    ssh_session(&before, "mobile-a", 2);
    before
        .inner
        .lock()
        .unwrap()
        .sessions
        .get_mut("mobile-a")
        .unwrap()
        .label = Some("Claude".into());

    let hub = restart_hub(&before);
    reserve_restored(&hub, "mobile-a");
    assert_eq!(
        hub.inner.lock().unwrap().sessions["mobile-a"].name(),
        "Claude"
    );
}

#[test]
fn restored_name_outranks_revisions_the_phone_kept_from_before_restart() {
    let hub = accepting_hub(vec![device("phone")]);
    reserve_restored(&hub, "mobile-a");
    let revision = hub.inner.lock().unwrap().sessions["mobile-a"].name_revision;
    assert!(revision > 1_000_000_000_000);
}

#[test]
fn new_sessions_are_numbered_after_terminals_waiting_for_restore() {
    let before = accepting_hub(vec![device("phone")]);
    ssh_session(&before, "mobile-a", 9);
    let hub = restart_hub(&before);
    ready_session(&hub, "mobile-b", "phone");
    assert_eq!(hub.inner.lock().unwrap().sessions["mobile-b"].number, 10);
}

#[test]
fn spinner_frames_do_not_change_saved_names() {
    let hub = accepting_hub(vec![device("phone")]);
    ssh_session(&hub, "mobile-a", 1);
    push_title(&hub, "mobile-a", "⠋ 正在构建");
    let first = hub.session_names_snapshot();
    push_title(&hub, "mobile-a", "⠙ 正在构建");
    assert_eq!(hub.session_names_snapshot(), first);
    assert_eq!(first["mobile-a"].title.as_deref(), Some("正在构建"));
}

#[test]
fn only_sessions_that_can_be_reattached_are_saved() {
    let hub = accepting_hub(vec![device("phone")]);
    ready_session(&hub, "mobile-local", "phone");
    ssh_session(&hub, "mobile-exited", 1);
    ssh_session(&hub, "mobile-lost", 2);
    for (id, disconnected) in [("mobile-exited", false), ("mobile-lost", true)] {
        hub.with_session(id, |session| {
            session.finish(Exit {
                exit_code: 0,
                disconnected,
            })
        });
    }
    let names = hub.session_names_snapshot();
    assert_eq!(names.keys().collect::<Vec<_>>(), vec!["mobile-lost"]);
}

#[test]
fn saved_name_survives_failed_restore_until_attach_succeeds() {
    let before = accepting_hub(vec![device("phone")]);
    ssh_session(&before, "mobile-a", 3);
    before.rename_session("mobile-a", "构建").unwrap();
    let hub = restart_hub(&before);

    reserve_restored(&hub, "mobile-a");
    assert!(!hub.finish_create("mobile-a", false));
    assert_eq!(
        hub.session_names_snapshot()["mobile-a"]
            .custom_name
            .as_deref(),
        Some("构建")
    );

    reserve_restored(&hub, "mobile-a");
    assert!(hub.finish_create("mobile-a", true));
    assert!(hub.inner.lock().unwrap().pending_names.is_empty());
    assert_eq!(
        hub.inner.lock().unwrap().sessions["mobile-a"].name(),
        "构建"
    );
}

#[test]
fn ended_sessions_drop_their_saved_name() {
    let hub = accepting_hub(vec![device("phone")]);
    ssh_session(&hub, "mobile-a", 1);
    assert!(hub.session_names_snapshot().contains_key("mobile-a"));
    hub.inner.lock().unwrap().sessions.remove("mobile-a");
    assert!(hub.session_names_snapshot().is_empty());
}

#[test]
fn saved_names_expire_and_keep_their_original_wait_start() {
    let now = unix_now_ms();
    let retention = SAVED_NAME_RETENTION.as_millis() as u64;
    let saved = |since: Option<u64>| SavedSessionName {
        detached_since_ms: since,
        ..SavedSessionName::default()
    };
    let hub = accepting_hub(vec![device("phone")]);
    hub.load_session_names(
        HashMap::from([
            ("expired".to_string(), saved(Some(now - retention))),
            ("waiting".to_string(), saved(Some(now - 1000))),
            ("fresh".to_string(), saved(None)),
        ]),
        now,
    );
    let names = hub.session_names_snapshot();
    assert!(!names.contains_key("expired"));
    assert_eq!(names["waiting"].detached_since_ms, Some(now - 1000));
    assert_eq!(names["fresh"].detached_since_ms, Some(now));
}

#[test]
fn stable_title_strips_animation_and_keeps_plain_titles() {
    assert_eq!(stable_title("⠋ 构建").as_deref(), Some("构建"));
    assert_eq!(
        stable_title("✳ Claude Code").as_deref(),
        Some("Claude Code")
    );
    assert_eq!(stable_title("OpenCode").as_deref(), Some("OpenCode"));
    assert_eq!(stable_title("\u{2800}"), None);
}

#[test]
fn spinner_frames_are_known_glyphs_or_leading_symbol_changes() {
    assert!(is_spinner_frame(None, Some("⠋ 构建")));
    assert!(is_spinner_frame(Some("⠋ 构建"), Some("\u{2800} 构建")));
    assert!(is_spinner_frame(
        Some("◐ Claude Code"),
        Some("◓ Claude Code")
    ));
    assert!(is_spinner_frame(Some("| build"), Some("/ build")));
    assert!(!is_spinner_frame(None, Some("Claude Code")));
    assert!(!is_spinner_frame(Some("Claude"), Some("OpenCode")));
    assert!(!is_spinner_frame(Some("✳ Claude Code"), Some("✳ 修复登录")));
    assert!(!is_spinner_frame(Some("[1] build"), Some("[2] build")));
    assert!(!is_spinner_frame(Some("/tmp/build"), Some("\\tmp/build")));
    assert!(!is_spinner_frame(Some("!task"), Some("?task")));
    assert!(!is_spinner_frame(Some("⠋ 构建"), None));
}

#[test]
fn attention_reports_busy_exit_and_bells_without_terminal_content() {
    let mut session = Session::new(project(), "phone".into(), 1);
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode("secret output"),
    ));
    let value = session.attention("mobile-1");
    assert_eq!(value["id"], "mobile-1");
    assert_eq!(value["project"], session.project.id);
    assert_eq!(value["busy"], false);
    assert_eq!(value["exited"], false);
    assert_eq!(value["bells"], 1);
    assert!(!value.to_string().contains("secret output"));
}

#[test]
fn program_busy_holds_across_gaps_between_spinner_frames() {
    let mut session = Session::new(project(), "phone".into(), 1);
    let push_title = |session: &mut Session, title: &str| {
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(format!("\x1b]2;{title}\x07")),
        ));
    };
    push_title(&mut session, "✳ Claude Code");
    assert!(!session.program_busy());
    assert_eq!(session.metadata("mobile-1")["programBusy"], false);
    push_title(&mut session, "⠂ Claude Code");
    push_title(&mut session, "⠐ Claude Code");
    // 转圈中途短暂换回普通标题，状态不翻转；原始标题与名称原样保留。
    push_title(&mut session, "✳ Claude Code");
    assert!(session.program_busy());
    assert_eq!(session.read(session.next)["programBusy"], true);
    assert_eq!(session.latest()["programTitle"], "✳ Claude Code");
    assert_eq!(session.name(), "✳ Claude Code");
    let frame = session.last_spinner_frame.unwrap();
    assert!(session.program_busy_at(frame + SPINNER_HOLD - Duration::from_millis(1)));
    assert!(!session.program_busy_at(frame + SPINNER_HOLD));
    session.finish(Exit {
        exit_code: 0,
        disconnected: false,
    });
    assert!(!session.program_busy());
}

#[test]
fn program_report_overrides_heuristics_until_submit_or_snapshot() {
    let encode =
        |text: &str| OutputChunk::Bytes(base64::engine::general_purpose::STANDARD.encode(text));
    let mut session = Session::new(project(), "phone".into(), 1);
    session.push(encode(
        "\x1b]2;⠼ 构建\x07\x1b]7501;state=done:app=codex\x1b\\",
    ));
    assert!(!session.program_busy());
    assert!(!session.display_busy());

    // 上报空闲时持续输出也不算运行中；回车提交后回到输出判定。
    let start = Instant::now();
    session.note_output_at(start);
    session.note_output_at(start + OUTPUT_STREAK);
    assert!(!session.output_busy_at(start + OUTPUT_STREAK));
    session.note_user_input("x");
    assert!(!session.output_busy_at(start + OUTPUT_STREAK));
    session.note_user_input("build\r");
    assert!(session.output_busy_at(start + OUTPUT_STREAK));

    session.push(encode(
        "\x1b]2;构建\x07\x1b]7501;state=working:app=codex\x1b\\",
    ));
    assert!(session.program_busy_at(Instant::now() + SPINNER_HOLD * 100));
    session.finish(Exit {
        exit_code: 0,
        disconnected: false,
    });
    assert!(!session.program_busy());
}

#[test]
fn screen_snapshot_releases_a_spinner_title_that_will_never_finish() {
    let mut session = Session::new(project(), "phone".into(), 1);
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode("\x1b]2;⠼ 构建\x07"),
    ));
    let frame = session.last_spinner_frame.unwrap();
    assert!(session.program_busy_at(frame + SPINNER_HOLD * 4));
    session.push(OutputChunk::Screen {
        data: "\x1b[Hdone".into(),
        cols: 80,
        rows: 24,
    });
    assert!(!session.program_busy_at(frame + SPINNER_HOLD * 4));
    assert_eq!(session.name(), "构建");
}

#[test]
fn output_busy_ignores_long_redraw_after_idle_resize() {
    let mut session = Session::new(project(), "phone".into(), 1);
    session.note_resize();
    let (start, _) = session.redraw.unwrap();
    let step = Duration::from_millis(200);
    // 重印长对话：持续数秒、块间隔很短，整段都是重绘。
    let mut at = start + step;
    while at <= start + Duration::from_millis(4000) {
        session.note_output_at(at);
        at += step;
    }
    assert!(!session.output_busy_at(at));
    // 重绘段断开后，新的持续输出照常算运行中。
    let later = at + REDRAW_GAP + step;
    session.note_output_at(later);
    session.note_output_at(later + OUTPUT_STREAK);
    assert!(session.output_busy_at(later + OUTPUT_STREAK));
    // 持续输出期间改尺寸不开启重绘段。
    session.note_resize();
    assert!(session.redraw.is_none());
    // 键盘输入结束重绘段。
    let mut typed = Session::new(project(), "phone".into(), 2);
    typed.note_resize();
    typed.note_input();
    assert!(typed.redraw.is_none());
}

#[test]
fn output_busy_needs_a_sustained_streak_and_ignores_echo() {
    let mut session = Session::new(project(), "phone".into(), 1);
    let start = Instant::now();
    let step = Duration::from_millis(200);
    // 短促输出（如提示符重绘）不算运行中。
    session.note_output_at(start);
    session.note_output_at(start + step);
    assert!(!session.output_busy_at(start + step));
    // 持续输出满 OUTPUT_STREAK 才算，并保持 SPINNER_HOLD。
    let last = start + OUTPUT_STREAK;
    session.note_output_at(last);
    assert!(session.output_busy_at(last));
    assert!(session.output_busy_at(last + SPINNER_HOLD - Duration::from_millis(1)));
    assert!(!session.output_busy_at(last + SPINNER_HOLD));
    // 后台提醒用的 program_busy 不受输出影响。
    assert!(!session.program_busy_at(last));

    // 紧跟输入的回显不计。
    let mut echo = Session::new(project(), "phone".into(), 2);
    echo.note_input();
    let typed = echo.last_input.unwrap();
    echo.note_output_at(typed + step);
    assert!(echo.last_output.is_none());
    echo.note_output_at(typed + OUTPUT_QUIET_AFTER_INPUT);
    assert!(echo.last_output.is_some());

    session.finish(Exit {
        exit_code: 0,
        disconnected: false,
    });
    assert!(!session.output_busy_at(last));
}

#[test]
fn program_busy_keeps_current_spinner_but_stops_for_exit() {
    let mut session = Session::new(project(), "phone".into(), 1);
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode("\x1b]2;\u{2800} 构建\x07"),
    ));
    let frame = session.last_spinner_frame.unwrap();
    assert!(session.program_busy_at(frame + SPINNER_HOLD * 4));
    assert_eq!(session.metadata("mobile-1")["name"], "\u{2800} 构建");
    session.finish(Exit {
        exit_code: 0,
        disconnected: false,
    });
    assert!(!session.program_busy_at(frame + SPINNER_HOLD));
}

#[test]
fn program_busy_observes_intermediate_titles_in_one_output_chunk() {
    for terminator in ["\x07", "\x1b\\"] {
        let mut session = Session::new(project(), "phone".into(), 1);
        session.push(OutputChunk::Bytes(
            base64::engine::general_purpose::STANDARD.encode(format!(
                "\x1b]2;⠋ 构建{terminator}\x1b]2;✳ Claude Code{terminator}"
            )),
        ));
        assert!(session.program_busy());
        assert_eq!(session.name(), "✳ Claude Code");
        assert_eq!(session.latest()["programTitle"], "✳ Claude Code");
        assert_eq!(session.name_revision, 2);
        let frame = session.last_spinner_frame.unwrap();
        assert!(!session.program_busy_at(frame + SPINNER_HOLD));
    }
}

#[test]
fn program_busy_handles_osc_and_unicode_split_across_chunks() {
    let output = "\x1b]2;⠋ 构建\x1b\\\x1b]2;✳ Claude Code\x07".as_bytes();
    for split in 1..output.len() {
        let mut session = Session::new(project(), "phone".into(), 1);
        for data in [&output[..split], &output[split..]] {
            session.push(OutputChunk::Bytes(
                base64::engine::general_purpose::STANDARD.encode(data),
            ));
        }
        assert!(session.program_busy());
        assert_eq!(session.name(), "✳ Claude Code");
        assert_eq!(session.name_revision, 2);
    }
}

#[test]
fn activity_revisions_order_responses_without_changing_original_titles() {
    let mut session = Session::new(project(), "phone".into(), 1);
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode("\x1b]2;◐ 原始标题\x07"),
    ));
    session.rename("我的终端").unwrap();
    let responses = [
        session.metadata("mobile-1"),
        session.read(0),
        session.latest(),
    ];
    for (index, response) in responses.iter().enumerate() {
        assert_eq!(response["activityRevision"], index as u64);
        assert_eq!(response["name"], "我的终端");
        assert_eq!(response["programTitle"], "◐ 原始标题");
        assert_eq!(response["programBusy"], true);
    }
}

#[test]
fn create_accepts_an_optional_terminal_profile_id() {
    let legacy: Operation =
        serde_json::from_str(r#"{"op":"create","project":"p","cols":80,"rows":24}"#).unwrap();
    assert!(matches!(
        legacy,
        Operation::Create {
            terminal_profile: None,
            ..
        }
    ));
    let chosen: Operation = serde_json::from_str(
        r#"{"op":"create","project":"p","cols":80,"rows":24,"terminal_profile":"claude"}"#,
    )
    .unwrap();
    assert!(
        matches!(chosen, Operation::Create { terminal_profile: Some(ref id), .. } if id == "claude")
    );
    let list: Operation = serde_json::from_str(r#"{"op":"terminal_profiles"}"#).unwrap();
    assert!(matches!(list, Operation::TerminalProfiles));
    // 手机不能直接提交命令：未知字段被忽略，命令只来自电脑端配置。
    let injected: Operation = serde_json::from_str(
        r#"{"op":"create","project":"p","cols":80,"rows":24,"command":"rm -rf /"}"#,
    )
    .unwrap();
    assert!(matches!(
        injected,
        Operation::Create {
            terminal_profile: None,
            ..
        }
    ));
}

#[test]
fn profile_sessions_fall_back_to_the_profile_name_until_a_title_arrives() {
    let profile = |name: &str, command: &str| LaunchProfile {
        name: name.into(),
        command: command.into(),
        shell: "auto".into(),
    };
    assert_eq!(profile("普通终端", "  ").command(), None);
    assert_eq!(profile("普通终端", "").label(), None);
    assert_eq!(profile(" ", "claude").label(), None);
    assert_eq!(profile(" Claude ", " claude ").command(), Some("claude"));

    let mut session = Session::new(project(), "phone".into(), 3);
    session.label = profile(" Claude\n", "claude").label();
    assert_eq!(session.name(), "Claude");
    session.push(OutputChunk::Bytes(
        base64::engine::general_purpose::STANDARD.encode("\x1b]2;claude · app\x07"),
    ));
    assert_eq!(session.name(), "claude · app");
}

#[test]
fn poll_reads_are_bounded_and_resume_by_sequence() {
    let mut session = Session::new(project(), "d".into(), 1);
    let chunk = "A".repeat(64 * 1024);
    for _ in 0..5 {
        session.push(OutputChunk::Bytes(chunk.clone()));
    }
    let first = session.read(0);
    assert_eq!(first["chunks"].as_array().unwrap().len(), 3);
    assert_eq!(first["next"], 3);
    assert_eq!(first["more"], true);
    let rest = session.read(3);
    assert_eq!(rest["chunks"].as_array().unwrap().len(), 2);
    assert_eq!(rest["more"], false);
    assert_eq!(rest["reset"], false);

    // A single chunk larger than the budget is still delivered.
    session.push(OutputChunk::Bytes("B".repeat(MAX_POLL_BYTES * 2)));
    assert_eq!(session.read(5)["chunks"].as_array().unwrap().len(), 1);
}

#[test]
fn evicted_or_future_sequences_reset_and_screens_replace_history() {
    let mut session = Session::new(project(), "d".into(), 1);
    for _ in 0..20 {
        session.push(OutputChunk::Bytes("x".repeat(64 * 1024)));
    }
    assert!(session.output_size <= MAX_OUTPUT);
    assert_eq!(session.read(0)["reset"], true);
    assert_eq!(session.read(99)["reset"], true);

    session.push(OutputChunk::Screen {
        data: "\u{1b}[2Jprompt$ ".into(),
        cols: 80,
        rows: 24,
    });
    let read = session.read(20);
    let chunks = read["chunks"].as_array().unwrap();
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0]["data"], "\u{1b}[2Jprompt$ ");
    assert_eq!(chunks[0]["cols"], 80);
    assert_eq!(read["reset"], false);
}

#[test]
fn exit_is_reported_after_the_output_drain_window() {
    let mut session = Session::new(project(), "d".into(), 1);
    session.finish(Exit {
        exit_code: 3,
        disconnected: false,
    });
    assert!(session.read(0)["exit"].is_null());
    session.drain_until = Some(Instant::now() - Duration::from_millis(1));
    assert_eq!(session.read(0)["exit"]["exitCode"], 3);
}

#[test]
fn automatic_listener_accepts_lan_sources() {
    for allowed in [
        "127.0.0.1",
        "192.168.1.2",
        "172.18.0.2",
        "10.0.0.2",
        "169.254.2.3",
        "100.64.0.1",
        "100.127.255.254",
        "::ffff:192.168.1.2",
    ] {
        assert!(lan_peer(allowed.parse().unwrap()), "{allowed}");
    }
    for denied in [
        "0.0.0.0",
        "8.8.8.8",
        "172.32.0.2",
        "100.128.0.1",
        "100.63.255.255",
        "2001:db8::1",
    ] {
        assert!(!lan_peer(denied.parse().unwrap()), "{denied}");
    }
}

#[test]
fn pairing_qr_encodes_only_pairing_links() {
    let qr =
        mobile_pairing_qr("qingcode://pair?v=1&host=192.168.1.2&port=48764&fp=00".into()).unwrap();
    assert_eq!(qr.modules.len(), qr.size * qr.size);
    assert!(qr.modules.contains('1'));
    assert!(mobile_pairing_qr("https://example.com".into()).is_err());
}

#[test]
fn idle_sweep_ends_quiet_sessions_and_drops_old_exited_records() {
    let hub = Hub::default();
    {
        let mut inner = hub.inner.lock().unwrap();
        for (id, ready, exited, idle) in [
            ("mobile-quiet", true, false, true),
            ("mobile-busy", true, false, false),
            ("mobile-done", true, true, true),
            ("mobile-starting", false, false, true),
        ] {
            let mut session = Session::new(project(), "phone".into(), 1);
            session.ready = ready;
            if exited {
                session.finish(Exit {
                    exit_code: 0,
                    disconnected: false,
                });
            }
            if idle {
                session.last_active = Instant::now() - Duration::from_secs(10);
            }
            inner.sessions.insert(id.into(), session);
        }
    }
    let idle = hub.take_idle_sessions(Duration::from_secs(5));
    assert_eq!(idle, [("mobile-quiet".to_string(), ProjectKind::Local)]);
    let inner = hub.inner.lock().unwrap();
    assert!(!inner.sessions["mobile-quiet"].ready, "结束期间不可再操作");
    assert!(!inner.sessions.contains_key("mobile-done"));
    assert!(inner.sessions["mobile-busy"].ready);
    assert!(inner.sessions.contains_key("mobile-starting"));
}

#[test]
fn session_metadata_reports_idle_deadline_until_exit() {
    let mut session = Session::new(project(), "phone".into(), 1);
    let meta = session.metadata("mobile-1");
    assert_eq!(
        meta["idleDeadline"].as_u64().unwrap() - meta["lastActiveAt"].as_u64().unwrap(),
        TERMINAL_IDLE.as_millis() as u64
    );
    session.finish(Exit {
        exit_code: 0,
        disconnected: false,
    });
    assert!(session.metadata("mobile-1")["idleDeadline"].is_null());
}

#[test]
fn session_metadata_keeps_created_at_after_activity() {
    let mut session = Session::new(project(), "phone".into(), 1);
    let created = session.metadata("mobile-1")["createdAt"].as_u64().unwrap();
    assert_eq!(created, session.last_active_ms);
    session.last_active_ms += 60_000;
    let meta = session.metadata("mobile-1");
    assert_eq!(meta["createdAt"].as_u64().unwrap(), created);
    assert!(meta["lastActiveAt"].as_u64().unwrap() > created);
}

#[test]
fn device_names_are_trimmed_and_defaulted() {
    assert_eq!(device_name(None), "Android 设备");
    assert_eq!(device_name(Some("  ")), "Android 设备");
    assert_eq!(device_name(Some(&"x".repeat(80))).len(), MAX_DEVICE_NAME);
}
