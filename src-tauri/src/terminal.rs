use portable_pty::{ChildKiller, CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
pub struct TerminalDataPayload {
    pub id: String,
    pub data: String,
}

#[derive(serde::Serialize, Clone)]
pub struct TerminalExitPayload {
    pub id: String,
    pub exit_code: u32,
}

struct TerminalSession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    generation: u64,
}

pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    next_generation: AtomicU64,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_generation: AtomicU64::new(1),
        }
    }

    pub fn spawn(&self, id: String, cwd: &str, app: AppHandle) -> Result<(), String> {
        let shell = if cfg!(target_os = "windows") {
            "powershell.exe"
        } else {
            "bash"
        };
        let mut cmd = CommandBuilder::new(shell);
        if !cwd.is_empty() {
            cmd.cwd(cwd);
        }
        self.spawn_with(id, cmd, app)
    }

    /// Spawn a pty running a user-configured script/command. `shell_kind` is one
    /// of "ps1" | "bat" | "sh" | "command" | "script". For "script", the target
    /// is a file path and the kind is inferred from its extension.
    pub fn spawn_script(
        &self,
        id: String,
        cwd: &str,
        shell_kind: &str,
        target: &str,
        env: HashMap<String, String>,
        app: AppHandle,
    ) -> Result<(), String> {
        let cmd = build_script_command(shell_kind, target, cwd, env)?;
        self.spawn_with(id, cmd, app)
    }

    fn spawn_with(&self, id: String, cmd: CommandBuilder, app: AppHandle) -> Result<(), String> {
        let pty_system = NativePtySystem::default();
        let pair: PtyPair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let master = pair.master;
        // Clone the reader before taking the writer (both borrow the master).
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = master
            .take_writer()
            .map_err(|e| format!("failed to take pty writer: {}", e))?;

        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let session = TerminalSession {
            master,
            writer,
            killer: Some(killer),
            generation,
        };

        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(mut old) = sessions.remove(&id) {
                if let Some(mut k) = old.killer.take() {
                    let _ = k.kill();
                }
            }
            sessions.insert(id.clone(), session);
        }

        let app_clone = app.clone();
        let id_clone = id.clone();

        std::thread::spawn(move || {
            use std::io::Read;
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_clone.emit(
                            "terminal-data",
                            TerminalDataPayload {
                                id: id_clone.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        let sessions = Arc::clone(&self.sessions);
        std::thread::spawn(move || {
            let status = child.wait();
            let is_current = {
                let sessions = sessions.lock().unwrap();
                if sessions
                    .get(&id)
                    .is_some_and(|session| session.generation == generation)
                {
                    true
                } else {
                    false
                }
            };
            if is_current {
                let exit_code = status.map(|status| status.exit_code()).unwrap_or(1);
                let _ = app.emit("terminal-exit", TerminalExitPayload { id, exit_code });
            }
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            session.writer.flush().map_err(|e| e.to_string())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())
        } else {
            Ok(())
        }
    }

    pub fn kill(&self, id: &str) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(id) {
            if let Some(mut k) = session.killer.take() {
                let _ = k.kill();
            }
        }
    }

    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            if let Some(mut killer) = session.killer.take() {
                let _ = killer.kill();
            }
        }
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// Build a `CommandBuilder` for a run-config task. `cwd` is applied when
/// non-empty; `env` entries are overlaid on top of the inherited environment.
fn build_script_command(
    shell_kind: &str,
    target: &str,
    cwd: &str,
    env: HashMap<String, String>,
) -> Result<CommandBuilder, String> {
    if target.trim().is_empty() {
        return Err("运行任务 target 不能为空".to_string());
    }

    let kind = if shell_kind == "script" {
        infer_script_kind(target)
    } else {
        shell_kind.to_string()
    };

    let mut cmd = match kind.as_str() {
        "ps1" => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoProfile");
            c.arg("-ExecutionPolicy");
            c.arg("Bypass");
            c.arg("-File");
            c.arg(target);
            c
        }
        "bat" => {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/c");
            c.arg(target);
            c
        }
        "sh" => {
            let mut c = CommandBuilder::new("bash");
            c.arg(target);
            c
        }
        "command" => {
            if cfg!(target_os = "windows") {
                let mut c = CommandBuilder::new("powershell.exe");
                c.arg("-NoProfile");
                c.arg("-Command");
                c.arg(target);
                c
            } else {
                let mut c = CommandBuilder::new("bash");
                c.arg("-c");
                c.arg(target);
                c
            }
        }
        other => {
            return Err(format!("不支持的运行任务类型: {}", other));
        }
    };

    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    Ok(cmd)
}

fn infer_script_kind(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".ps1") {
        "ps1".to_string()
    } else if lower.ends_with(".bat") || lower.ends_with(".cmd") {
        "bat".to_string()
    } else if lower.ends_with(".sh") {
        "sh".to_string()
    } else if cfg!(target_os = "windows") {
        "bat".to_string()
    } else {
        "sh".to_string()
    }
}
