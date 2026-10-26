//! 跨进程回归：`connect --stdio` 代理与 `daemon` 是两个真实进程时，双向帧流
//! 必须同时可用。
//!
//! 这个组合专门覆盖 Windows 命名管道的一个坑：同步句柄同一时刻只允许一个在途
//! I/O，一边阻塞读时写会立刻失败（ERROR_NO_DATA）。进程内的测试因为读写顺序化
//! 不会暴露它，必须真的把代理拉成独立进程。

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use qingcode_server::daemon::RunDir;
use qingcode_server::proto::{
    self, Frame, HelloRequest, HelloResponse, Kind, CONTROL_STREAM, PROTOCOL_VERSION,
};

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "qingcode-connect-stdio-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn wait_daemon_ready(run_dir: &RunDir, child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if run_dir.ready_marker().exists() && run_dir.read_token().is_ok() {
            return;
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("daemon 提前退出: {status}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("等待 daemon 就绪超时");
}

fn read_frame<R: Read>(reader: &mut R) -> std::io::Result<Frame> {
    let mut head = [0u8; 4];
    reader.read_exact(&mut head)?;
    let body = u32::from_be_bytes(head) as usize;
    let mut rest = vec![0u8; body];
    reader.read_exact(&mut rest)?;
    let mut buffer = Vec::with_capacity(4 + body);
    buffer.extend_from_slice(&head);
    buffer.extend_from_slice(&rest);
    let (frame, _) = proto::decode(&buffer)?;
    Ok(frame)
}

/// 读一帧，超时就 panic（避免 CI 上卡死）。
fn read_frame_with_timeout<R: Read + Send + 'static>(mut reader: R, label: &'static str) -> Frame {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(read_frame(&mut reader));
    });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(result) => result.unwrap_or_else(|e| panic!("{label} 读帧失败: {e}")),
        Err(_) => panic!("{label} 读帧超时（15s）"),
    }
}

#[test]
fn connect_stdio_proxies_frames_across_processes() {
    let dir = temp_dir("roundtrip");
    let run_dir = RunDir::resolve(Some(&dir)).unwrap();

    let mut daemon = Command::new(env!("CARGO_BIN_EXE_qingcode-server"))
        .arg("daemon")
        .arg("--state-dir")
        .arg(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 daemon 失败");
    wait_daemon_ready(&run_dir, &mut daemon);
    let token = run_dir.read_token().unwrap();

    let mut proxy = Command::new(env!("CARGO_BIN_EXE_qingcode-server"))
        .arg("connect")
        .arg("--stdio")
        .arg("--state-dir")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("启动 connect 代理失败");

    let hello = HelloRequest {
        client_id: "stdio-integration".into(),
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        token,
        resume_token: None,
    };
    let frame = Frame::new(
        Kind::Hello,
        CONTROL_STREAM,
        proto::encode(&hello).expect("编码 HELLO 失败"),
    );
    proxy
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&frame.encode().unwrap())
        .expect("写入 HELLO 失败");

    let response = read_frame_with_timeout(proxy.stdout.take().expect("代理缺少 stdout"), "代理");
    let detail = response.kind.as_str();
    assert_eq!(response.kind, Kind::Hello, "代理应答不是 HELLO（{detail}）");
    let hello: HelloResponse = proto::decode_value(&response.payload).expect("解析 HELLO 应答失败");
    assert_eq!(hello.protocol, PROTOCOL_VERSION);
    assert!(!hello.capabilities.is_empty());

    // 收尾：先结束代理，再结束 daemon，最后删目录（Windows 上进程活着会占住文件）。
    let _ = proxy.kill();
    let _ = proxy.wait();
    let _ = daemon.kill();
    let _ = daemon.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

/// Keep subscribed clients open while requesting shutdown. Testing a real child
/// is essential: an in-process run_async result does not prove that Tokio's
/// blocking watcher threads let the process (and its single-instance lock) exit.
#[test]
fn daemon_shutdown_exits_with_multiple_active_watchers() {
    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    struct Proxy {
        child: ChildGuard,
        reader: Option<std::process::ChildStdout>,
    }
    impl Proxy {
        fn send(&mut self, kind: Kind, id: u32, payload: Vec<u8>) {
            self.child
                .0
                .stdin
                .as_mut()
                .unwrap()
                .write_all(&Frame::new(kind, id, payload).encode().unwrap())
                .unwrap();
        }
        fn next(&mut self) -> Frame {
            let mut reader = self.reader.take().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let result = read_frame(&mut reader);
                let _ = tx.send((result, reader));
            });
            let (result, reader) = rx
                .recv_timeout(Duration::from_secs(5))
                .expect("daemon response timed out");
            self.reader = Some(reader);
            result.unwrap()
        }
        fn request(&mut self, id: u32, method: &str, params: serde_json::Value) {
            self.send(
                Kind::Req,
                id,
                proto::encode(&proto::Request {
                    id,
                    method: method.into(),
                    params: proto::encode(&params).unwrap(),
                })
                .unwrap(),
            );
            loop {
                let frame = self.next();
                if frame.kind == Kind::Ping {
                    self.send(Kind::Pong, 0, vec![]);
                }
                if frame.stream_id == id && matches!(frame.kind, Kind::Res | Kind::Err) {
                    assert_eq!(frame.kind, Kind::Res, "request {method} failed");
                    return;
                }
            }
        }
    }
    let dir = temp_dir("shutdown-watchers");
    let run_dir = RunDir::resolve(Some(&dir)).unwrap();
    let root = dir.join("project");
    std::fs::create_dir(&root).unwrap();
    let mut daemon = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_qingcode-server"))
            .args(["daemon", "--state-dir"])
            .arg(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_daemon_ready(&run_dir, &mut daemon.0);
    let token = run_dir.read_token().unwrap();
    let mut proxies = Vec::new();
    for index in 0..3 {
        let mut child = Command::new(env!("CARGO_BIN_EXE_qingcode-server"))
            .args(["connect", "--stdio", "--state-dir"])
            .arg(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let reader = child.stdout.take();
        let mut proxy = Proxy {
            child: ChildGuard(child),
            reader,
        };
        proxy.send(
            Kind::Hello,
            0,
            proto::encode(&HelloRequest {
                client_id: format!("shutdown-watch-{index}"),
                protocol_min: 1,
                protocol_max: 1,
                token: token.clone(),
                resume_token: None,
            })
            .unwrap(),
        );
        assert_eq!(proxy.next().kind, Kind::Hello);
        for id in 1..=4 {
            proxy.request(id, "watch.subscribe", serde_json::json!({"root": root}));
            if id == 1 {
                // Do not wait for END: cancellation and the next subscription
                // intentionally overlap, as during rapid project switching.
                proxy.send(Kind::Cancel, id, vec![]);
            }
        }
        proxies.push(proxy);
    }
    std::thread::sleep(Duration::from_millis(400));
    proxies[0].request(99, "server.shutdown", serde_json::json!({}));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = daemon.0.try_wait().unwrap() {
            assert!(status.success(), "daemon shutdown failed: {status}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "daemon kept running with active watchers after shutdown"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(proxies);
    drop(daemon);
    std::fs::remove_dir_all(&dir).unwrap();
}
