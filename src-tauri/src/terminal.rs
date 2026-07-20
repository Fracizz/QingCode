use portable_pty::{ChildKiller, CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
pub struct TerminalDataPayload {
    pub id: String,
    pub data: Vec<u8>,
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
    shell_pid: Option<u32>,
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

    pub fn spawn(
        &self,
        id: String,
        cwd: &str,
        host_shell: Option<&str>,
        cols: u16,
        rows: u16,
        app: AppHandle,
    ) -> Result<(), String> {
        let cmd = build_host_shell_command(host_shell, cwd)?;
        self.spawn_with(id, cmd, cols, rows, app)
    }

    /// Spawn a pty running a user-configured script/command. `shell_kind` is one
    /// of "ps1" | "bat" | "sh" | "command" | "interactive" | "script".
    /// `interactive` runs the command inside a login shell that stays open after
    /// the command exits (terminal profiles). For "script", the target is a file
    /// path and the kind is inferred from its extension.
    /// `host_shell` selects powershell / pwsh / cmd / wsl / bash / zsh for interactive
    /// profile startups (ignored for one-shot script kinds).
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_script(
        &self,
        id: String,
        cwd: &str,
        shell_kind: &str,
        target: &str,
        env: HashMap<String, String>,
        host_shell: Option<&str>,
        cols: u16,
        rows: u16,
        app: AppHandle,
    ) -> Result<(), String> {
        let cmd = build_script_command(shell_kind, target, cwd, env, host_shell)?;
        self.spawn_with(id, cmd, cols, rows, app)
    }

    fn spawn_with(
        &self,
        id: String,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        app: AppHandle,
    ) -> Result<(), String> {
        let pty_system = NativePtySystem::default();
        let pair: PtyPair = pty_system
            .openpty(clamp_pty_size(cols, rows))
            .map_err(|e| e.to_string())?;

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let shell_pid = child.process_id();
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
            shell_pid,
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
                        let _ = app_clone.emit(
                            "terminal-data",
                            TerminalDataPayload {
                                id: id_clone.clone(),
                                data: buf[..n].to_vec(),
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
            let current_generation = {
                let sessions = sessions.lock().unwrap();
                sessions.get(&id).map(|session| session.generation)
            };
            if should_emit_terminal_exit(current_generation, generation) {
                {
                    let mut sessions = sessions.lock().unwrap();
                    sessions.remove(&id);
                }
                let exit_code = resolve_exit_code(status.map(|status| status.exit_code()).ok());
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
                .resize(clamp_pty_size(cols, rows))
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

    pub fn has_child_processes(&self, id: &str) -> Result<bool, String> {
        let sessions = self.sessions.lock().unwrap();
        let Some(session) = sessions.get(id) else {
            // Session already cleaned up (process exited) → not busy.
            return Ok(false);
        };
        let Some(pid) = session.shell_pid else {
            return Ok(false);
        };
        // Parent process may already be gone; treat as not busy.
        if !process_exists(pid) {
            return Ok(false);
        }
        Ok(count_meaningful_child_processes(pid) > 0)
    }

    /// Shell PIDs for live sessions (used by low-cost app memory sampling).
    pub fn shell_pids(&self) -> Vec<u32> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .values()
            .filter_map(|session| session.shell_pid)
            .collect()
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

/// Keep ConPTY / portable-pty sizes in a sane range (matches frontend clamp).
fn clamp_pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 1000),
        rows: rows.clamp(1, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Pure description of a run-config command (unit-testable without a PTY).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ScriptCommandSpec {
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Vec<(String, String)>,
}

fn default_host_shell() -> &'static str {
    if cfg!(target_os = "windows") {
        "pwsh"
    } else {
        "zsh"
    }
}

fn normalize_host_shell(shell: Option<&str>) -> Result<&'static str, String> {
    let raw = shell
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_host_shell());
    match raw {
        "powershell" => Ok("powershell"),
        "pwsh" => Ok("pwsh"),
        "cmd" => {
            if cfg!(target_os = "windows") {
                Ok("cmd")
            } else {
                Err("命令提示符 (cmd) 仅在 Windows 上可用".to_string())
            }
        }
        "wsl" => {
            if cfg!(target_os = "windows") {
                Ok("wsl")
            } else {
                Err("WSL 仅在 Windows 上可用".to_string())
            }
        }
        "bash" => Ok("bash"),
        "zsh" => Ok("zsh"),
        other => Err(format!("不支持的终端 Shell: {other}")),
    }
}

/// Bare interactive shell (no startup command).
fn pwsh_program() -> String {
    if cfg!(target_os = "windows") {
        "pwsh.exe".to_string()
    } else {
        "pwsh".to_string()
    }
}

fn resolve_host_shell(shell: Option<&str>) -> Result<(String, Vec<String>), String> {
    match normalize_host_shell(shell)? {
        "powershell" => Ok(("powershell.exe".to_string(), vec!["-NoLogo".to_string()])),
        "pwsh" => Ok((pwsh_program(), vec!["-NoLogo".to_string()])),
        "cmd" => Ok(("cmd.exe".to_string(), vec![])),
        "wsl" => Ok(("wsl.exe".to_string(), vec![])),
        "bash" => Ok(("bash".to_string(), vec![])),
        "zsh" => Ok(("zsh".to_string(), vec![])),
        _ => unreachable!(),
    }
}

/// Profile startup: run `target`, then keep a usable prompt in the chosen shell.
fn resolve_interactive_shell(
    shell: Option<&str>,
    target: &str,
) -> Result<(String, Vec<String>), String> {
    let target = target.trim();
    match normalize_host_shell(shell)? {
        "powershell" => Ok((
            "powershell.exe".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!("& {{ {target} }}"),
            ],
        )),
        "pwsh" => Ok((
            pwsh_program(),
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!("& {{ {target} }}"),
            ],
        )),
        "cmd" => Ok((
            "cmd.exe".to_string(),
            vec!["/d".to_string(), "/k".to_string(), target.to_string()],
        )),
        "wsl" => Ok((
            "wsl.exe".to_string(),
            vec![
                "-e".to_string(),
                "bash".to_string(),
                "-lc".to_string(),
                format!("{target}; exec bash"),
            ],
        )),
        "bash" => Ok((
            "bash".to_string(),
            vec!["-lc".to_string(), format!("{target}; exec bash")],
        )),
        "zsh" => Ok((
            "zsh".to_string(),
            vec!["-lc".to_string(), format!("{target}; exec zsh")],
        )),
        _ => unreachable!(),
    }
}

fn build_host_shell_command(shell: Option<&str>, cwd: &str) -> Result<CommandBuilder, String> {
    let (program, args) = resolve_host_shell(shell)?;
    let mut cmd = CommandBuilder::new(&program);
    for arg in &args {
        cmd.arg(arg);
    }
    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }
    Ok(cmd)
}

/// Build a `CommandBuilder` for a run-config task. `cwd` is applied when
/// non-empty; `env` entries are overlaid on top of the inherited environment.
fn build_script_command(
    shell_kind: &str,
    target: &str,
    cwd: &str,
    env: HashMap<String, String>,
    host_shell: Option<&str>,
) -> Result<CommandBuilder, String> {
    let spec = resolve_script_command(shell_kind, target, cwd, env, host_shell)?;
    let mut cmd = CommandBuilder::new(&spec.program);
    for arg in &spec.args {
        cmd.arg(arg);
    }
    if let Some(ref cwd) = spec.cwd {
        cmd.cwd(cwd);
    }
    for (k, v) in spec.env {
        cmd.env(k, v);
    }
    Ok(cmd)
}

fn resolve_script_command(
    shell_kind: &str,
    target: &str,
    cwd: &str,
    env: HashMap<String, String>,
    host_shell: Option<&str>,
) -> Result<ScriptCommandSpec, String> {
    if target.trim().is_empty() {
        return Err("运行任务 target 不能为空".to_string());
    }

    let kind = if shell_kind == "script" {
        infer_script_kind(target)
    } else {
        shell_kind.to_string()
    };

    let (program, args) = match kind.as_str() {
        "ps1" => (
            "powershell.exe".to_string(),
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                target.to_string(),
            ],
        ),
        "bat" => (
            "cmd.exe".to_string(),
            vec!["/c".to_string(), target.to_string()],
        ),
        "sh" => ("bash".to_string(), vec![target.to_string()]),
        "command" => {
            if cfg!(target_os = "windows") {
                (
                    "cmd.exe".to_string(),
                    vec![
                        "/d".to_string(),
                        "/s".to_string(),
                        "/c".to_string(),
                        target.to_string(),
                    ],
                )
            } else {
                (
                    "bash".to_string(),
                    vec!["-c".to_string(), target.to_string()],
                )
            }
        }
        // Terminal profiles: run the startup command, then keep a shell prompt.
        "interactive" => resolve_interactive_shell(host_shell, target)?,
        other => {
            return Err(format!("不支持的运行任务类型: {}", other));
        }
    };

    let mut env_pairs: Vec<(String, String)> = env.into_iter().collect();
    env_pairs.sort_by_key(|(k, _)| k.clone());

    Ok(ScriptCommandSpec {
        program,
        args,
        cwd: if cwd.is_empty() {
            None
        } else {
            Some(cwd.to_string())
        },
        env: env_pairs,
    })
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

/// Whether a wait thread should emit `terminal-exit` for this session id.
/// Stale when the id was reused (generation advanced) or the session was removed.
fn should_emit_terminal_exit(current_generation: Option<u64>, expected: u64) -> bool {
    current_generation == Some(expected)
}

/// Map a waited exit status to the payload code; missing status → 1.
fn resolve_exit_code(status_code: Option<u32>) -> u32 {
    status_code.unwrap_or(1)
}

fn process_exists(pid: u32) -> bool {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    system.process(Pid::from_u32(pid)).is_some()
}

/// Console host helpers that sit under the shell even when the prompt is idle.
fn is_console_noise_process(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "conhost.exe"
            | "conhost"
            | "openconsole.exe"
            | "openconsole"
            | "winpty-agent.exe"
            | "winpty-agent"
            | "wslhost.exe"
            | "wslhost"
    )
}

fn count_meaningful_child_processes(parent_pid: u32) -> usize {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let parent = Pid::from_u32(parent_pid);
    system
        .processes()
        .values()
        .filter(|process| {
            if process.parent() != Some(parent) {
                return false;
            }
            let name = process.name().to_string_lossy();
            !is_console_noise_process(name.as_ref())
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_script_kind_from_extension() {
        assert_eq!(infer_script_kind(r"D:\run\task.ps1"), "ps1");
        assert_eq!(infer_script_kind("scripts/build.bat"), "bat");
        assert_eq!(infer_script_kind("scripts/build.CMD"), "bat");
        assert_eq!(infer_script_kind("scripts/build.sh"), "sh");
    }

    #[test]
    fn resolve_script_command_rejects_empty_target() {
        let err = resolve_script_command("command", "  ", "", HashMap::new(), None).unwrap_err();
        assert!(err.contains("不能为空"), "err={err}");
    }

    #[test]
    fn resolve_script_command_rejects_unknown_kind() {
        let err = resolve_script_command("ruby", "puts 1", "", HashMap::new(), None).unwrap_err();
        assert!(err.contains("不支持"), "err={err}");
    }

    #[test]
    fn resolve_script_command_builds_ps1() {
        let mut env = HashMap::new();
        env.insert("FOO".to_string(), "1".to_string());
        let spec =
            resolve_script_command("ps1", r"D:\run\task.ps1", r"D:\work", env, None).unwrap();
        assert_eq!(spec.program, "powershell.exe");
        assert_eq!(
            spec.args,
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                r"D:\run\task.ps1".to_string(),
            ]
        );
        assert_eq!(spec.cwd.as_deref(), Some(r"D:\work"));
        assert_eq!(spec.env, vec![("FOO".to_string(), "1".to_string())]);
    }

    #[test]
    fn resolve_script_command_infers_kind_for_script() {
        let spec =
            resolve_script_command("script", "tools/setup.sh", "", HashMap::new(), None).unwrap();
        assert_eq!(spec.program, "bash");
        assert_eq!(spec.args, vec!["tools/setup.sh".to_string()]);
    }

    #[test]
    fn resolve_script_command_builds_inline_command() {
        let spec = resolve_script_command("command", "echo hello", "C:\\tmp", HashMap::new(), None)
            .unwrap();
        if cfg!(target_os = "windows") {
            assert_eq!(spec.program, "cmd.exe");
            assert_eq!(
                spec.args,
                vec![
                    "/d".to_string(),
                    "/s".to_string(),
                    "/c".to_string(),
                    "echo hello".to_string(),
                ]
            );
        } else {
            assert_eq!(spec.program, "bash");
            assert_eq!(spec.args, vec!["-c".to_string(), "echo hello".to_string()]);
        }
        assert_eq!(spec.cwd.as_deref(), Some("C:\\tmp"));
    }

    #[test]
    fn resolve_script_command_builds_interactive_shell() {
        let spec =
            resolve_script_command("interactive", "opencode", "C:\\tmp", HashMap::new(), None)
                .unwrap();
        if cfg!(target_os = "windows") {
            assert_eq!(spec.program, pwsh_program());
            assert_eq!(
                spec.args,
                vec![
                    "-NoLogo".to_string(),
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    "& { opencode }".to_string(),
                ]
            );
        } else {
            assert_eq!(spec.program, "zsh");
            assert_eq!(
                spec.args,
                vec!["-lc".to_string(), "opencode; exec zsh".to_string()]
            );
        }
        assert_eq!(spec.cwd.as_deref(), Some("C:\\tmp"));
    }

    #[test]
    fn resolve_interactive_shell_variants() {
        let pwsh = resolve_interactive_shell(Some("pwsh"), "opencode").unwrap();
        assert_eq!(pwsh.0, pwsh_program());
        assert!(pwsh.1.iter().any(|a| a == "-NoExit"));

        if cfg!(target_os = "windows") {
            let cmd = resolve_interactive_shell(Some("cmd"), "opencode").unwrap();
            assert_eq!(cmd.0, "cmd.exe");
            assert_eq!(cmd.1, vec!["/d", "/k", "opencode"]);

            let wsl = resolve_interactive_shell(Some("wsl"), "opencode").unwrap();
            assert_eq!(wsl.0, "wsl.exe");
            assert_eq!(wsl.1, vec!["-e", "bash", "-lc", "opencode; exec bash"]);

            let bare = resolve_host_shell(Some("wsl")).unwrap();
            assert_eq!(bare.0, "wsl.exe");
            assert_eq!(default_host_shell(), "pwsh");
        } else {
            assert!(resolve_interactive_shell(Some("wsl"), "x").is_err());
            assert!(resolve_interactive_shell(Some("cmd"), "x").is_err());
            let zsh = resolve_interactive_shell(Some("zsh"), "opencode").unwrap();
            assert_eq!(zsh.0, "zsh");
            assert_eq!(zsh.1, vec!["-lc", "opencode; exec zsh"]);
            assert_eq!(default_host_shell(), "zsh");
            assert_eq!(resolve_host_shell(None).unwrap().0, "zsh");
        }
    }

    #[test]
    fn should_emit_terminal_exit_only_for_current_generation() {
        assert!(should_emit_terminal_exit(Some(3), 3));
        assert!(!should_emit_terminal_exit(Some(4), 3));
        assert!(!should_emit_terminal_exit(None, 3));
    }

    #[test]
    fn resolve_exit_code_defaults_to_one() {
        assert_eq!(resolve_exit_code(Some(0)), 0);
        assert_eq!(resolve_exit_code(Some(42)), 42);
        assert_eq!(resolve_exit_code(None), 1);
    }

    #[test]
    fn clamp_pty_size_bounds() {
        let size = clamp_pty_size(120, 40);
        assert_eq!(size.cols, 120);
        assert_eq!(size.rows, 40);
        let min = clamp_pty_size(0, 0);
        assert_eq!(min.cols, 2);
        assert_eq!(min.rows, 1);
        let max = clamp_pty_size(u16::MAX, u16::MAX);
        assert_eq!(max.cols, 1000);
        assert_eq!(max.rows, 500);
    }

    #[test]
    fn console_noise_process_names() {
        assert!(is_console_noise_process("conhost.exe"));
        assert!(is_console_noise_process("OpenConsole"));
        assert!(is_console_noise_process("wslhost.exe"));
        assert!(!is_console_noise_process("opencode.exe"));
        assert!(!is_console_noise_process("node"));
    }
}
