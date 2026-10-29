//! Bounded metadata flight recorder shared by the desktop client and daemon.
//! Never pass terminal bytes, command lines, tokens, or environment values here.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const KEEP: usize = 3;
const PRE_WINDOW: Duration = Duration::from_secs(120);
const POST_WINDOW: Duration = Duration::from_secs(30);
const MAX_RECENT: usize = 4096;
const MAX_RECENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_INCIDENTS: usize = 20;
pub const EXPORT_BYTES: usize = 512 * 1024;

static RECORDER: OnceLock<Recorder> = OnceLock::new();

struct Recent {
    at: Instant,
    line: String,
}

struct Incident {
    path: PathBuf,
    deadline: Instant,
}

struct State {
    file: File,
    size: u64,
    seq: u64,
    recent: VecDeque<Recent>,
    recent_bytes: usize,
    incidents: Vec<Incident>,
}

pub struct Recorder {
    dir: PathBuf,
    instance: String,
    started: Instant,
    state: Mutex<State>,
}

fn append_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

pub fn stderr_file(path: &Path) -> std::io::Result<File> {
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
        let archive = path.with_extension("log.1");
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::rename(path, archive);
    }
    append_file(path)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn termination_source(source: Option<&str>) -> &str {
    match source {
        Some(
            value @ ("user_close" | "user_restart" | "user_close_others" | "user_close_all"
            | "cancel_reconnect" | "session_replaced" | "spawn_cancelled"
            | "detached_cleanup" | "connection_removed" | "backend_cleanup"),
        ) => value,
        _ => "unknown",
    }
}

pub fn identifier(value: Option<&str>) -> Option<&str> {
    value.filter(|value| {
        !value.is_empty()
            && value.len() <= 160
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_:./".contains(&byte))
    })
}

pub fn error_summary(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if [
        "token",
        "password",
        "secret",
        "authorization",
        "bearer",
        "api_key",
        "cookie",
    ]
    .iter()
    .any(|key| lower.contains(key))
    {
        return "[sensitive error details omitted]".into();
    }
    message
        .chars()
        .filter(|ch| !ch.is_control())
        .take(512)
        .collect()
}

impl Recorder {
    pub fn open(dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir.join("incidents"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&dir, &dir.join("incidents")] {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        let path = dir.join("lifecycle.jsonl");
        let file = append_file(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            dir,
            instance: crate::generate_token(),
            started: Instant::now(),
            state: Mutex::new(State {
                file,
                size,
                seq: 0,
                recent: VecDeque::new(),
                recent_bytes: 0,
                incidents: Vec::new(),
            }),
        })
    }

    /// A critical event is flushed to disk before returning to the caller.
    /// An incident snapshots the preceding two minutes and appends the next 30s.
    pub fn record(
        &self,
        event: &str,
        fields: Value,
        critical: bool,
        incident: bool,
    ) -> std::io::Result<()> {
        let fields = if fields.to_string().len() <= 16 * 1024 {
            fields
        } else {
            json!({"metadataTruncated":true})
        };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.seq += 1;
        let now = Instant::now();
        let timestamp = now_ms();
        let line = format!(
            "{}\n",
            json!({
                "timestampMs": timestamp, "elapsedMs": self.started.elapsed().as_millis(),
                "seq": state.seq, "instanceId": self.instance, "pid": std::process::id(),
                "event": event, "fields": fields,
            })
        );
        if state.size + line.len() as u64 > MAX_BYTES {
            // Close the old handle before renaming (Windows denies rename otherwise).
            let replacement = append_file(&self.dir.join("rotation.tmp"))?;
            drop(std::mem::replace(&mut state.file, replacement));
            for index in (1..=KEEP).rev() {
                let from = if index == 1 {
                    self.dir.join("lifecycle.jsonl")
                } else {
                    self.dir.join(format!("lifecycle.jsonl.{}", index - 1))
                };
                let to = self.dir.join(format!("lifecycle.jsonl.{index}"));
                if from.exists() {
                    if to.exists() {
                        std::fs::remove_file(&to)?;
                    }
                    std::fs::rename(from, to)?;
                }
            }
            state.file = append_file(&self.dir.join("lifecycle.jsonl"))?;
            let _ = std::fs::remove_file(self.dir.join("rotation.tmp"));
            state.size = 0;
        }
        state.file.write_all(line.as_bytes())?;
        state.size += line.len() as u64;
        if critical {
            state.file.sync_data()?;
        }
        state.incidents.retain(|item| now <= item.deadline);
        for item in &state.incidents {
            let mut file = append_file(&item.path)?;
            // Bound every incident even if metadata floods during the post window.
            if file.metadata()?.len() < MAX_BYTES {
                file.write_all(line.as_bytes())?;
                if critical {
                    file.sync_data()?;
                }
            }
        }
        state.recent_bytes += line.len();
        state.recent.push_back(Recent { at: now, line });
        while state.recent.len() > MAX_RECENT
            || state.recent_bytes > MAX_RECENT_BYTES
            || state
                .recent
                .front()
                .is_some_and(|item| now.duration_since(item.at) > PRE_WINDOW)
        {
            if let Some(removed) = state.recent.pop_front() {
                state.recent_bytes -= removed.line.len();
            }
        }
        if incident {
            let path = self.dir.join("incidents").join(format!(
                "{timestamp}-{}-{}.jsonl",
                std::process::id(),
                state.seq
            ));
            let mut file = append_file(&path)?;
            writeln!(
                file,
                "{}",
                json!({"event":"incident.window", "timestampMs": timestamp,
                "postWindowEndsAtMs": timestamp + POST_WINDOW.as_millis() as u64,
                "instanceId": self.instance, "triggerSeq": state.seq})
            )?;
            for item in &state.recent {
                file.write_all(item.line.as_bytes())?;
            }
            file.sync_data()?;
            if state.incidents.len() == 8 {
                state.incidents.remove(0);
            }
            state.incidents.push(Incident {
                path,
                deadline: now + POST_WINDOW,
            });
            prune_incidents(&self.dir.join("incidents"))?;
        }
        Ok(())
    }

    pub fn export(&self) -> std::io::Result<String> {
        let _guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut text = String::new();
        for index in (1..=KEEP).rev() {
            let path = self.dir.join(format!("lifecycle.jsonl.{index}"));
            if path.exists() {
                text.push_str(&read_tail(&path, EXPORT_BYTES / 4)?);
            }
        }
        text.push_str(&read_tail(&self.dir.join("lifecycle.jsonl"), EXPORT_BYTES)?);
        let mut incidents: Vec<_> = std::fs::read_dir(self.dir.join("incidents"))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .collect();
        incidents.sort();
        for path in incidents.iter().rev().take(2) {
            text.push_str(&format!("{}\n", json!({"section":"incident"})));
            text.push_str(&read_tail(path, EXPORT_BYTES)?);
        }
        Ok(text)
    }
}

fn prune_incidents(dir: &Path) -> std::io::Result<()> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect();
    paths.sort();
    for path in paths.iter().take(paths.len().saturating_sub(MAX_INCIDENTS)) {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Read a bounded tail, dropping a partial first line after a seek.
pub fn read_tail(path: &Path, limit: usize) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(limit as u64);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(limit as u64).read_to_end(&mut bytes)?;
    if start > 0 {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        } else {
            bytes.clear();
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn initialize(dir: PathBuf, role: &str) {
    match Recorder::open(dir) {
        Ok(recorder) => {
            if RECORDER.set(recorder).is_ok() {
                record(
                    "process.started",
                    json!({"role":role, "version":crate::SERVER_VERSION,
                    "binarySha256":std::env::current_exe().ok().and_then(|path|std::fs::read(path).ok()).map(|bytes| {
                        use sha2::{Digest, Sha256}; format!("{:x}",Sha256::digest(bytes))
                    })}),
                    true,
                    false,
                );
                std::panic::set_hook(Box::new(|info| {
                    // Payloads can contain user data. Location identifies the failing code.
                    record(
                        "process.panic",
                        json!({"location":info.location().map(|loc|loc.to_string())}),
                        true,
                        true,
                    );
                }));
            }
        }
        Err(error) => eprintln!("diagnostics unavailable: {error}"),
    }
}

pub fn record(event: &str, fields: Value, critical: bool, incident: bool) {
    if let Some(recorder) = RECORDER.get() {
        if let Err(error) = recorder.record(event, fields, critical, incident) {
            eprintln!("diagnostics write failed ({event}): {error}");
        }
    }
}

pub fn export() -> Result<String, String> {
    RECORDER
        .get()
        .ok_or_else(|| "诊断日志尚未初始化".to_string())?
        .export()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incident_keeps_preceding_events_and_critical_kill_before_exit() {
        let dir =
            std::env::temp_dir().join(format!("qingcode-diagnostic-{}", crate::generate_token()));
        let recorder = Recorder::open(dir.clone()).unwrap();
        recorder
            .record("pty.created", json!({"ptyId":"one"}), false, false)
            .unwrap();
        recorder
            .record(
                "pty.kill_requested",
                json!({"ptyId":"one","source":"user_close"}),
                true,
                false,
            )
            .unwrap();
        recorder
            .record(
                "pty.exited",
                json!({"ptyId":"one","exitCode":1}),
                true,
                true,
            )
            .unwrap();
        recorder
            .record("pty.created", json!({"ptyId":"two"}), false, false)
            .unwrap();
        let incident = std::fs::read_dir(dir.join("incidents"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let lines: Vec<Value> = std::fs::read_to_string(incident)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines[1]["event"], "pty.created");
        assert_eq!(lines[2]["event"], "pty.kill_requested");
        assert_eq!(lines[3]["event"], "pty.exited");
        assert_eq!(lines[4]["fields"]["ptyId"], "two");
        assert!(lines[3]["seq"].as_u64().unwrap() > lines[2]["seq"].as_u64().unwrap());
        drop(recorder);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bounded_tail_discards_partial_utf8_lines() {
        let path = std::env::temp_dir().join(format!("qingcode-tail-{}", crate::generate_token()));
        std::fs::write(&path, "长行测试\ncomplete\n").unwrap();
        assert_eq!(read_tail(&path, 12).unwrap(), "complete\n");
        std::fs::remove_file(path).unwrap();
    }
}
