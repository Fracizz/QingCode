//! End-to-end HTTPS/WSS to a real isolated daemon and PTY. No SSH is involved.
use futures_util::{SinkExt, StreamExt};
use qingcode_server::{
    direct::{self, DirectOptions, Gateway},
    proto::{self, Frame, HelloRequest, Kind},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::net::TcpStream;
use tokio_rustls::{
    rustls::{self, pki_types::ServerName},
    TlsConnector,
};
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, Message},
    WebSocketStream,
};

type Socket = WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>;
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Client {
    socket: Socket,
    pending: Vec<u8>,
    next: u32,
}
impl Client {
    async fn connect(dir: &Path, port: u16, token: &str) -> Self {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(
                std::fs::read(dir.join("direct/certificate.der"))
                    .unwrap()
                    .into(),
            )
            .unwrap();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        let tls = TlsConnector::from(Arc::new(config))
            .connect(
                ServerName::try_from("localhost").unwrap(),
                TcpStream::connect(("127.0.0.1", port)).await.unwrap(),
            )
            .await
            .unwrap();
        let mut request = format!("wss://localhost:{port}/connect")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {token}").parse().unwrap());
        let (socket, _) = tokio_tungstenite::client_async(request, tls).await.unwrap();
        let mut client = Self {
            socket,
            pending: Vec::new(),
            next: 1,
        };
        let hello = HelloRequest {
            client_id: "direct-transport-test".into(),
            protocol_min: 1,
            protocol_max: 1,
            token: token.into(),
            resume_token: None,
        };
        client
            .send(Frame::new(Kind::Hello, 0, proto::encode(&hello).unwrap()))
            .await;
        assert_eq!(client.receive().await.kind, Kind::Hello);
        client
    }

    async fn send(&mut self, frame: Frame) {
        self.socket
            .send(Message::Binary(frame.encode().unwrap().into()))
            .await
            .unwrap();
    }
    async fn receive(&mut self) -> Frame {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Ok((frame, consumed)) = proto::decode(&self.pending) {
                    self.pending.drain(..consumed);
                    if frame.kind == Kind::Ping {
                        self.send(Frame::empty(Kind::Pong, 0)).await;
                        continue;
                    }
                    return frame;
                }
                match self.socket.next().await.unwrap().unwrap() {
                    Message::Binary(bytes) => self.pending.extend_from_slice(&bytes),
                    Message::Ping(bytes) => self.socket.send(Message::Pong(bytes)).await.unwrap(),
                    other => panic!("unexpected websocket message {other:?}"),
                }
            }
        })
        .await
        .expect("direct response timeout")
    }
    async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        let request = proto::Request::with_params(id, method, &params).unwrap();
        self.send(Frame::new(Kind::Req, id, proto::encode(&request).unwrap()))
            .await;
        loop {
            let frame = self.receive().await;
            if frame.stream_id != id {
                continue;
            }
            if frame.kind == Kind::Res {
                let response: proto::Response = proto::decode_value(&frame.payload).unwrap();
                return response.result;
            }
            if frame.kind == Kind::Err {
                panic!("request {method} failed");
            }
        }
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn options(dir: &Path, port: u16) -> DirectOptions {
    DirectOptions {
        hostname: "127.0.0.1".into(),
        port,
        state_dir: Some(dir.into()),
        require_daemon: true,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn websocket_and_gateway_restart_keep_same_remote_terminal_alive() {
    let dir = std::env::temp_dir().join(format!(
        "qingcode-direct-acceptance-{}",
        qingcode_server::generate_token()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let binary = std::env::var_os("QC_TEST_SERVER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_qingcode-server")));
    let child = Command::new(binary)
        .args(["daemon", "--state-dir"])
        .arg(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut daemon = ChildGuard(child);
    for _ in 0..300 {
        if dir.join("token").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(dir.join("token").exists());
    let gateway = Gateway::bind(options(&dir, free_port())).await.unwrap();
    let port = gateway.info.port;
    let token = direct::info(Some(&dir), true).unwrap().token.unwrap();
    let running = tokio::spawn(gateway.run());
    let mut first = Client::connect(&dir, port, &token).await;
    let server = first.request("server.info", json!({})).await;
    #[cfg(unix)]
    let shell = "/bin/sh";
    #[cfg(windows)]
    let shell = "cmd.exe";
    let terminal = first
        .request("pty.create", json!({"cwd":dir,"shell":shell}))
        .await;
    let id = terminal["id"].as_str().unwrap().to_string();
    first.socket.close(None).await.unwrap();
    drop(first);
    tokio::time::sleep(Duration::from_millis(100)).await;
    running.abort();
    let _ = running.await;
    // A separate gateway process may restart while the daemon and PTY remain.
    let gateway = Gateway::bind(options(&dir, 0)).await.unwrap();
    assert_eq!(gateway.info.port, port);
    let running = tokio::spawn(gateway.run());
    let mut second = Client::connect(&dir, port, &token).await;
    let now = second.request("server.info", json!({})).await;
    assert_eq!(server["pid"], now["pid"]);
    let list = second.request("pty.list", json!({})).await;
    let live = list["ptys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap();
    assert!(
        live["exited"].is_null(),
        "gateway restart must not kill terminal: {live}"
    );
    assert_eq!(live["detached"], true);
    second.request("pty.kill", json!({"id":id})).await;
    second.request("server.shutdown", json!({})).await;
    drop(second);
    running.abort();
    let _ = running.await;
    let _ = daemon.0.wait();
    std::fs::remove_dir_all(dir).unwrap();
}
