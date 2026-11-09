//! 本机 PTY 宿主上的持久化终端：与远端 daemon 共用代理循环，只是传输换成命名管道。

use super::*;
use crate::local_pty_host::{self, LOCAL_CONNECTION_ID};

fn local_client_id(manager: &SshManager) -> String {
    manager.daemon_client_id(LOCAL_CONNECTION_ID)
}

/// 确保宿主在运行并完成握手。
pub(in crate::remote_ssh::server) async fn open_local_session(
    manager: &SshManager,
) -> Result<(SessionTransport, DaemonSession), String> {
    let access = tauri::async_runtime::spawn_blocking(local_pty_host::ensure_running)
        .await
        .map_err(|error| format!("启动本地终端宿主失败：{error}"))??;
    let stream = qingcode_server::connect::connect_async(&access.endpoint)
        .await
        .map_err(|error| format!("连接本地终端宿主失败：{error}"))?;
    let session =
        DaemonSession::open_local(stream, &local_client_id(manager), access.token).await?;
    Ok((SessionTransport::Local, session))
}

pub(crate) async fn spawn_local_terminal(
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    launch: PersistentLaunch,
    app: AppHandle,
    manager: &SshManager,
) -> Result<TerminalSpawnResult, String> {
    let (transport, session) = open_local_session(manager).await?;
    spawn_terminal_on_session(
        id,
        TerminalHost::Local,
        LOCAL_CONNECTION_ID.to_string(),
        cwd,
        cols,
        rows,
        launch,
        transport,
        session,
        app,
        manager,
    )
    .await
}

pub(crate) async fn attach_local_terminal(
    id: String,
    pty_id: String,
    size: Option<(u16, u16)>,
    from_seq: Option<u64>,
    app: AppHandle,
    manager: &SshManager,
) -> Result<TerminalSpawnResult, String> {
    if pty_id.trim().is_empty() {
        return Err("ptyId 不能为空".to_string());
    }
    if size.is_some_and(|(cols, rows)| cols == 0 || rows == 0) {
        return Err("终端尺寸必须大于 0".to_string());
    }
    let (transport, session) = open_local_session(manager).await?;
    attach_terminal_on_session(
        id,
        pty_id,
        TerminalHost::Local,
        LOCAL_CONNECTION_ID.to_string(),
        local_client_id(manager),
        size,
        from_seq,
        transport,
        session,
        app,
        manager,
    )
    .await
}

/// 归属校验：宿主里只应有本安装的终端，仍按 owner 精确比对。
fn validate_owned(info: &PtyInfoWire, client_id: &str, detached_only: bool) -> Result<(), String> {
    if info.owner.as_deref() != Some(client_id) {
        return Err("PTY 不属于当前客户端".to_string());
    }
    if detached_only && !info.detached {
        return Err("PTY 已被接回，无法按遗留终端结束".to_string());
    }
    Ok(())
}

/// 结束一个本安装拥有的 PTY；已回收的视为成功。
pub(crate) async fn kill_owned(
    pty_id: &str,
    source: &str,
    detached_only: bool,
    manager: &SshManager,
) -> Result<(), String> {
    let client_id = local_client_id(manager);
    let (transport, session) = open_local_session(manager).await?;
    let _cleanup = ExitSessionCleanup {
        transport: &transport,
        session: &session,
    };
    let response = session.request("pty.list", &serde_json::json!({})).await?;
    let response: PtyListResponse = serde_json::from_value(response)
        .map_err(|error| format!("解析 pty.list 应答失败：{error}"))?;
    let Some(info) = response.ptys.iter().find(|info| info.id == pty_id) else {
        return Ok(());
    };
    validate_owned(info, &client_id, detached_only)?;
    session
        .request(
            "pty.kill",
            &serde_json::json!({
                "id": pty_id, "source": source, "operationId": uuid::Uuid::new_v4().to_string(),
            }),
        )
        .await?;
    Ok(())
}

/// 终端里是否有前台子进程（关闭标签前的确认用）。
pub(crate) async fn has_children(pty_id: &str, manager: &SshManager) -> Result<bool, String> {
    let (transport, session) = open_local_session(manager).await?;
    let _cleanup = ExitSessionCleanup {
        transport: &transport,
        session: &session,
    };
    let response = session
        .request("pty.hasChildren", &serde_json::json!({ "id": pty_id }))
        .await?;
    Ok(response
        .get("hasChildren")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(owner: Option<&str>, detached: bool) -> PtyInfoWire {
        PtyInfoWire {
            id: "pty-1".into(),
            name: None,
            owner: owner.map(str::to_string),
            cwd: None,
            cols: 80,
            rows: 24,
            exited: None,
            detached,
            detached_remaining_ms: None,
        }
    }

    #[test]
    fn owned_validation_rejects_foreign_and_reattached_terminals() {
        assert!(validate_owned(&info(Some("me"), true), "me", true).is_ok());
        assert!(validate_owned(&info(Some("me"), false), "me", false).is_ok());
        assert!(validate_owned(&info(Some("other"), true), "me", true).is_err());
        assert!(validate_owned(&info(None, true), "me", true).is_err());
        assert!(validate_owned(&info(Some("me"), false), "me", true).is_err());
    }

    /// 真实 daemon + 命名管道 + ConPTY：管道断开（等同应用退出）后进程不死，
    /// 新会话能接回、补发断开前的输出并继续输入。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn hosted_terminal_survives_client_disconnect_and_reattaches() {
        use qingcode_server::daemon::{DaemonOptions, RunDir};
        use qingcode_server::ipc::IpcEndpoint;

        const CLIENT: &str = "install:__local__";
        const TIMEOUT: Duration = Duration::from_secs(30);

        async fn open(endpoint: &IpcEndpoint, token: &str) -> DaemonSession {
            let stream = qingcode_server::connect::connect_async(endpoint)
                .await
                .expect("连接宿主");
            DaemonSession::open_local(stream, CLIENT, token.to_string())
                .await
                .expect("宿主握手")
        }

        async fn wait_for_output(events: &mut SessionEventReceiver, marker: &str) {
            let mut seen = Vec::new();
            tokio::time::timeout(TIMEOUT, async {
                loop {
                    if let Some(Event::PtyData { data, .. }) = events.recv().await {
                        seen.extend_from_slice(&data);
                        if String::from_utf8_lossy(&seen).contains(marker) {
                            return;
                        }
                    }
                }
            })
            .await
            .unwrap_or_else(|_| panic!("等待输出 {marker} 超时"));
        }

        let dir = std::env::temp_dir().join(format!("qc-hosted-{}", uuid::Uuid::new_v4()));
        let run_dir = RunDir::resolve(Some(&dir)).unwrap();
        let options = DaemonOptions {
            state_dir: Some(dir.clone()),
            ..Default::default()
        };
        tokio::spawn(async move { qingcode_server::daemon::run_async(options).await });
        let deadline = std::time::Instant::now() + TIMEOUT;
        while !(run_dir.ready_marker().exists() && run_dir.read_token().is_ok()) {
            assert!(std::time::Instant::now() < deadline, "宿主未就绪");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // 监听先于 token 轮换，留一点时间让新 token 落盘。
        tokio::time::sleep(Duration::from_millis(200)).await;
        let token = run_dir.read_token().unwrap();
        let endpoint = IpcEndpoint::new(run_dir.dir());

        let mut first = open(&endpoint, &token).await;
        let mut events = first.take_events().unwrap();
        let created = first
            .request(
                "pty.create",
                &serde_json::json!({
                    "cwd": dir.to_string_lossy(), "shell": "cmd",
                    "args": ["/d", "/k", "echo QC_BEFORE_DROP"], "cols": 100, "rows": 30,
                }),
            )
            .await
            .expect("pty.create");
        let pty_id = created["id"].as_str().unwrap().to_string();
        wait_for_output(&mut events, "QC_BEFORE_DROP").await;
        first.shutdown();
        drop(events);
        drop(first);

        // 宿主感知断开后 PTY 进入 detached，进程仍在运行。
        let mut second = open(&endpoint, &token).await;
        let deadline = std::time::Instant::now() + TIMEOUT;
        loop {
            let listed = second
                .request("pty.list", &serde_json::json!({}))
                .await
                .unwrap();
            let listed: PtyListResponse = serde_json::from_value(listed).unwrap();
            let info = listed.ptys.iter().find(|info| info.id == pty_id).unwrap();
            assert_eq!(info.exited, None, "断开连接不应结束进程");
            if info.detached {
                validate_owned(info, CLIENT, true).unwrap();
                break;
            }
            assert!(std::time::Instant::now() < deadline, "PTY 未进入 detached");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let mut events = second.take_events().unwrap();
        let attach = second.attach(&pty_id, 0, false).await.expect("pty.attach");
        assert!(attach.stream_end.ok);
        let replay: Vec<u8> = attach
            .chunks
            .iter()
            .flat_map(|chunk| chunk.data.iter().copied())
            .collect();
        let screen = attach.response["screen"].as_str().unwrap_or_default();
        assert!(
            String::from_utf8_lossy(&replay).contains("QC_BEFORE_DROP")
                || screen.contains("QC_BEFORE_DROP"),
            "接回后缺少断开前的输出"
        );

        let next_input_seq = attach.response["nextInputSeq"].as_u64().unwrap();
        send_input_to_session(
            &second,
            &pty_id,
            &AtomicU64::new(next_input_seq),
            b"echo QC_AFTER_ATTACH\r".to_vec(),
        )
        .await
        .map_err(|(error, _)| error)
        .expect("pty.input");
        wait_for_output(&mut events, "QC_AFTER_ATTACH").await;

        second
            .request("pty.kill", &serde_json::json!({ "id": pty_id }))
            .await
            .unwrap();
        second.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
