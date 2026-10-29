//! Real processes and real PTYs, including ConPTY when this test runs on Windows.
//! QC_TEST_SERVER overrides the binary path when a cross-built test is copied to a host.
use qingcode_server::proto::{self, Frame, HelloRequest, Kind};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn binary() -> PathBuf {
    std::env::var_os("QC_TEST_SERVER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_qingcode-server")))
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    while Instant::now() < end {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    panic!("lifecycle acceptance timed out");
}

struct Connection {
    proxy: Child,
    frames: mpsc::Receiver<Frame>,
    next: u32,
    daemon_pid: u32,
}

impl Connection {
    fn open(dir: &Path) -> Self {
        let mut proxy = Command::new(binary())
            .args(["connect", "--stdio", "--state-dir"])
            .arg(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut output = proxy.stdout.take().unwrap();
        let (tx, frames) = mpsc::channel();
        std::thread::spawn(move || loop {
            let mut head = [0; 4];
            if output.read_exact(&mut head).is_err() {
                break;
            }
            let size = u32::from_be_bytes(head) as usize;
            if !(5..=4 * 1024 * 1024).contains(&size) {
                break;
            }
            let mut bytes = vec![0; size + 4];
            bytes[..4].copy_from_slice(&head);
            if output.read_exact(&mut bytes[4..]).is_err() {
                break;
            }
            let Ok((frame, _)) = proto::decode(&bytes) else {
                break;
            };
            if tx.send(frame).is_err() {
                break;
            }
        });
        let mut connection = Self {
            proxy,
            frames,
            next: 0,
            daemon_pid: 0,
        };
        let hello = HelloRequest {
            client_id: "isolated-lifecycle-acceptance".into(),
            protocol_min: 1,
            protocol_max: 1,
            token: std::fs::read_to_string(dir.join("token"))
                .unwrap()
                .trim()
                .into(),
            resume_token: None,
        };
        connection.send(Frame::new(Kind::Hello, 0, proto::encode(&hello).unwrap()));
        let frame = connection.receive();
        assert_eq!(frame.kind, Kind::Hello);
        let hello: Value = proto::decode_value(&frame.payload).unwrap();
        connection.daemon_pid = hello["pid"].as_u64().unwrap() as u32;
        connection
    }

    fn send(&mut self, frame: Frame) {
        let input = self.proxy.stdin.as_mut().unwrap();
        input.write_all(&frame.encode().unwrap()).unwrap();
        input.flush().unwrap();
    }

    fn receive(&mut self) -> Frame {
        loop {
            let frame = self
                .frames
                .recv_timeout(Duration::from_secs(15))
                .expect("proxy response timeout");
            if frame.kind == Kind::Ping {
                self.send(Frame::empty(Kind::Pong, 0));
            } else {
                return frame;
            }
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        let request = proto::Request::with_params(id, method, &params).unwrap();
        self.send(Frame::new(Kind::Req, id, proto::encode(&request).unwrap()));
        loop {
            let frame = self.receive();
            if frame.stream_id != id || !matches!(frame.kind, Kind::Res | Kind::Err) {
                continue;
            }
            let body: Value = proto::decode_value(&frame.payload).unwrap();
            assert_ne!(frame.kind, Kind::Err, "request {method} failed: {body}");
            return body["result"].clone();
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.proxy.kill();
        let _ = self.proxy.wait();
    }
}

fn start(dir: &Path, old_token: Option<&str>) -> Child {
    let mut command = Command::new(binary());
    command
        .args(["daemon", "--state-dir"])
        .arg(dir)
        .args(["--idle-exit-secs", "30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.arg("--detach");
    let child = command.spawn().unwrap();
    wait_until(|| {
        std::fs::read_to_string(dir.join("token"))
            .is_ok_and(|token| old_token != Some(token.as_str()))
    });
    child
}

fn journal(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join("lifecycle.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[test]
fn real_pty_disconnect_kill_exit_and_restart_preserve_diagnostic_evidence() {
    let dir = std::env::temp_dir().join(format!(
        "qingcode-lifecycle-{}",
        qingcode_server::generate_token()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let mut launcher = start(&dir, None);
    let mut a = Connection::open(&dir);
    let mut b = Connection::open(&dir);
    let daemon_pid = a.daemon_pid;
    let pty_a = a.request(
        "pty.create",
        json!({"cwd":dir,"env":{"DIAGNOSTIC_PRIVATE":"private-env-sentinel"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let pty_b = b.request("pty.create", json!({"cwd":dir}))["id"]
        .as_str()
        .unwrap()
        .to_string();
    drop(a); // Only the proxy goes away: both shells must survive.
    let list = b.request("pty.list", json!({}));
    for pty in [&pty_a, &pty_b] {
        assert!(list["ptys"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == *pty && item["exited"].is_null()));
    }
    let mut a = Connection::open(&dir);
    assert_eq!(a.daemon_pid, daemon_pid);
    a.request("pty.attach", json!({"id":pty_a,"fromSeq":0}));
    a.request("pty.kill",json!({"id":pty_a,"source":"user_close","operationId":"acceptance-kill-a","terminalId":"tab-a"}));
    let list = b.request("pty.list", json!({}));
    assert!(list["ptys"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == pty_b && item["exited"].is_null()));
    let input = if cfg!(windows) {
        "Write-Output private-input-sentinel; exit 1\r\n"
    } else {
        "printf private-input-sentinel; exit 1\n"
    };
    b.request(
        "pty.input",
        json!({"id":pty_b,"seq":0,"data":input.as_bytes()}),
    );
    wait_until(|| {
        journal(&dir)
            .iter()
            .any(|e| e["event"] == "pty.exited" && e["fields"]["ptyId"] == pty_b)
    });
    let entries = journal(&dir);
    let kill = entries
        .iter()
        .position(|e| e["event"] == "pty.kill_requested" && e["fields"]["ptyId"] == pty_a)
        .unwrap();
    let exit = entries
        .iter()
        .position(|e| e["event"] == "pty.exited" && e["fields"]["ptyId"] == pty_a)
        .unwrap();
    assert!(kill < exit);
    assert_eq!(entries[kill]["fields"]["operationId"], "acceptance-kill-a");
    assert_eq!(entries[exit]["fields"]["terminationRequested"], true);
    let exit_b = entries
        .iter()
        .find(|e| e["event"] == "pty.exited" && e["fields"]["ptyId"] == pty_b)
        .unwrap();
    assert_eq!(exit_b["fields"]["terminationRequested"], false);
    assert_eq!(exit_b["fields"]["cause"], "unknown");
    assert!(!std::fs::read_to_string(dir.join("lifecycle.jsonl"))
        .unwrap()
        .contains("private-env-sentinel"));
    assert!(std::fs::read_dir(dir.join("incidents"))
        .unwrap()
        .next()
        .is_some());
    let old_token = std::fs::read_to_string(dir.join("token")).unwrap();
    b.request("server.shutdown", json!({}));
    drop(a);
    drop(b);
    let _ = launcher.wait();
    // Windows detach launcher exits before the daemon. Wait for its final journal entry.
    wait_until(|| {
        journal(&dir)
            .iter()
            .any(|e| e["event"] == "process.exiting")
    });
    std::thread::sleep(Duration::from_millis(250));
    let mut second_launcher = start(&dir, Some(&old_token));
    let mut c = Connection::open(&dir);
    assert!(c.request("pty.list", json!({}))["ptys"]
        .as_array()
        .unwrap()
        .is_empty());
    c.request("server.shutdown", json!({}));
    drop(c);
    let _ = second_launcher.wait();
    wait_until(|| {
        journal(&dir)
            .iter()
            .filter(|e| e["event"] == "process.exiting")
            .count()
            == 2
    });
    let instances: std::collections::HashSet<_> = journal(&dir)
        .iter()
        .filter(|e| e["event"] == "process.started")
        .map(|e| e["instanceId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(instances.len(), 2);
    // Leave bounded evidence for inspection; the directory is unique and has no production state.
    println!("LIFECYCLE_EVIDENCE={}", dir.display());
}
