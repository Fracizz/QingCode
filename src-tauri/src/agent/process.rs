//! 在项目环境中启动 Agent，逐行收发 JSON。
//!
//! 本机 / WSL 使用子进程的标准输入输出；SSH 远端（直连与 Server 模式）复用远端终端通道，
//! 在 `stty raw -echo` 的 PTY 里运行 Agent，写入经异步通道按序发送。
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::AgentProject;

/// 要在项目环境里执行的 Agent 命令。
#[derive(Clone, Debug, Default)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub enum Process {
    Local {
        child: Child,
        stdin: Option<ChildStdin>,
    },
    Remote(RemoteProcess),
}

/// 发给远端 Agent 终端的命令，由 `mobile.rs` 中的远端启动器按序执行。
#[derive(Debug, PartialEq, Eq)]
pub enum RemoteCommand {
    Write(String),
    Kill,
}

pub struct RemoteProcess {
    sender: tokio::sync::mpsc::UnboundedSender<RemoteCommand>,
}

impl RemoteProcess {
    pub fn new() -> (Self, tokio::sync::mpsc::UnboundedReceiver<RemoteCommand>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (Self { sender }, receiver)
    }
}

pub struct Pipes {
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

impl Process {
    pub fn write_line(&mut self, line: &str) -> Result<(), String> {
        match self {
            Process::Local { stdin, .. } => {
                let stdin = stdin.as_mut().ok_or("Agent 进程已关闭输入。")?;
                stdin
                    .write_all(line.as_bytes())
                    .and_then(|_| stdin.write_all(b"\n"))
                    .and_then(|_| stdin.flush())
                    .map_err(|error| format!("写入 Agent 进程失败：{error}"))
            }
            Process::Remote(remote) => remote
                .sender
                .send(RemoteCommand::Write(format!("{line}\n")))
                .map_err(|_| "远端 Agent 已断开。".to_string()),
        }
    }

    /// 先关闭输入让 Agent 自行退出，超时后结束整个进程树；远端直接结束终端。不阻塞调用方。
    pub fn shutdown(self) {
        match self {
            Process::Local {
                mut child,
                mut stdin,
            } => {
                std::thread::spawn(move || {
                    drop(stdin.take());
                    let deadline = Instant::now() + Duration::from_secs(3);
                    while Instant::now() < deadline {
                        if matches!(child.try_wait(), Ok(Some(_))) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    kill_tree(&mut child);
                });
            }
            Process::Remote(remote) => {
                let _ = remote.sender.send(RemoteCommand::Kill);
            }
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 远端 PTY 关闭回显后输出的就绪标记；此前写入的内容可能被回显，所以写入要等它出现。
pub const READY_MARKER: &str = "QINGCODE_AGENT_READY";

/// 远端 Unix 上的启动脚本：`stty raw -echo` 关闭回显与行规程，使 PTY 字节流就是逐行 JSON；
/// 输出就绪标记后经登录交互 Shell 解析 PATH（nvm、bun 等）再 `exec` Agent，环境变量用 `env` 传入。
pub fn remote_script(launch: &Launch) -> String {
    let mut parts = vec![
        format!("stty raw -echo 2>/dev/null; printf '\\n%s\\n' {READY_MARKER};"),
        "exec".to_string(),
        r#""${SHELL:-/bin/sh}""#.to_string(),
        "-lic".to_string(),
        shell_quote(r#"exec "$0" "$@""#),
    ];
    if !launch.env.is_empty() {
        parts.push("env".into());
        parts.extend(
            launch
                .env
                .iter()
                .map(|(key, value)| shell_quote(&format!("{key}={value}"))),
        );
    }
    parts.push(shell_quote(&launch.program));
    parts.extend(launch.args.iter().map(|arg| shell_quote(arg)));
    parts.join(" ")
}

/// 远端 PTY 字节流 → 完整的行。登录 Shell 可能在第一条 JSON 前输出提示文字，
/// 每行从第一个 `{` 开始解析。
#[derive(Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
    /// 已看到就绪标记；此前的输出（登录提示、可能的回显）全部丢弃。
    ready: bool,
}

/// 单行上限，防止异常输出无限增长。
const MAX_LINE: usize = 32 * 1024 * 1024;

impl LineBuffer {
    /// 返回（本次是否刚就绪, 完整的 JSON 行）。
    pub fn push(&mut self, data: &[u8]) -> (bool, Vec<String>) {
        self.pending.extend_from_slice(data);
        let mut lines = Vec::new();
        let mut became_ready = false;
        while let Some(position) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=position).collect();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{0}');
            if !self.ready {
                if text.ends_with(READY_MARKER) && !text.contains("printf") {
                    self.ready = true;
                    became_ready = true;
                }
                continue;
            }
            if let Some(start) = text.find('{') {
                lines.push(text[start..].to_string());
            }
        }
        if self.pending.len() > MAX_LINE {
            self.pending.clear();
        }
        (became_ready, lines)
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `.cmd` 包装脚本会再启动 node，只结束 cmd.exe 会留下子进程。
        let _ = Command::new("taskkill.exe")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Windows 上 GUI 进程的 PATH 可能缺少用户级安装目录，这里补充常见位置。
#[cfg(windows)]
fn extra_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(home) = dirs::home_dir() {
        directories.push(home.join(".local").join("bin"));
        directories.push(home.join(".opencode").join("bin"));
        directories.push(home.join(".bun").join("bin"));
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(roaming).join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        directories.push(PathBuf::from(&local).join("Programs").join("opencode"));
        directories.push(PathBuf::from(&local).join("pnpm"));
    }
    directories
}

#[cfg(not(windows))]
fn extra_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(home) = dirs::home_dir() {
        directories.push(home.join(".local").join("bin"));
        directories.push(home.join(".opencode").join("bin"));
    }
    directories
}

/// 按 PATH（Windows 还按 PATHEXT）查找本机命令。
pub fn locate(program: &str) -> Option<PathBuf> {
    let direct = Path::new(program);
    if direct.components().count() > 1 {
        return direct.is_file().then(|| direct.to_path_buf());
    }
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(str::to_ascii_lowercase)
            .filter(|extension| matches!(extension.as_str(), ".exe" | ".cmd" | ".bat" | ".com"))
            .collect()
    } else {
        vec![String::new()]
    };
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    directories.extend(extra_directories());
    directories.into_iter().find_map(|directory| {
        extensions.iter().find_map(|extension| {
            let candidate = directory.join(format!("{program}{extension}"));
            candidate.is_file().then_some(candidate)
        })
    })
}

/// WSL 内通过登录交互 Shell 执行，使 nvm / bun 等写在 profile 里的 PATH 生效。
fn wsl_args(distro: &str, cwd: &str, launch: &Launch) -> Vec<String> {
    let mut args: Vec<String> = [
        "--distribution",
        distro,
        "--cd",
        cwd,
        "--exec",
        "/bin/sh",
        "-c",
        r#"exec "${SHELL:-/bin/sh}" -lic 'exec "$0" "$@"' "$@""#,
        "sh",
    ]
    .map(String::from)
    .to_vec();
    if !launch.env.is_empty() {
        args.push("env".into());
        args.extend(
            launch
                .env
                .iter()
                .map(|(key, value)| format!("{key}={value}")),
        );
    }
    args.push(launch.program.clone());
    args.extend(launch.args.iter().cloned());
    args
}

fn command(project: &AgentProject, launch: &Launch) -> Result<Command, String> {
    let mut command = match project.kind.as_str() {
        "local" => {
            let program = locate(&launch.program).ok_or_else(|| {
                format!(
                    "未在电脑上找到 `{}` 命令，请先安装并登录后重试。",
                    launch.program
                )
            })?;
            let mut command = Command::new(program);
            command.args(&launch.args).current_dir(&project.path);
            for (key, value) in &launch.env {
                command.env(key, value);
            }
            command
        }
        "wsl" => {
            let path = crate::run_environment::parse_wsl_path(&project.path)
                .ok_or("无法识别 WSL 项目目录。")?;
            let program = locate("wsl.exe").ok_or("未找到 wsl.exe，请启用 WSL 后重试。")?;
            let mut command = Command::new(program);
            command.args(wsl_args(&path.distro, &path.path, launch));
            command
        }
        _ => return Err("远端项目由远端启动器启动。".into()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(command)
}

pub fn spawn(project: &AgentProject, launch: &Launch) -> Result<(Process, Pipes), String> {
    let mut child = command(project, launch)?
        .spawn()
        .map_err(|error| format!("无法启动 `{}`：{error}", launch.program))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("无法读取 Agent 输出。")?;
    let stderr = child.stderr.take().ok_or("无法读取 Agent 错误输出。")?;
    Ok((Process::Local { child, stdin }, Pipes { stdout, stderr }))
}

/// 逐行读取，非 UTF-8 字节按替换字符处理。
pub fn read_lines(stdout: impl Read, mut each: impl FnMut(&str)) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buffer);
                let line = line.trim();
                if !line.is_empty() {
                    each(line);
                }
            }
        }
    }
}

/// 保留错误输出末尾，进程异常退出时给出原因。
pub fn read_tail(stderr: impl Read, limit: usize) -> String {
    let mut tail = String::new();
    read_lines(stderr, |line| {
        tail.push_str(line);
        tail.push('\n');
        if tail.len() > limit * 2 {
            tail = super::thread::clip_tail(&tail, limit);
        }
    });
    super::thread::clip_tail(tail.trim(), limit)
}

/// 短暂启动一个 Agent 进程收发几条消息（读取额度、账号等），超时后结束。
/// `handle` 收到每行输出，返回要写入的新行；返回 `Err(())` 表示已拿到结果。
pub fn probe(
    project: &AgentProject,
    launch: &Launch,
    initial: Vec<String>,
    timeout: Duration,
    mut handle: impl FnMut(&serde_json::Value) -> Result<Vec<String>, ()>,
) -> Result<(), String> {
    let (mut process, pipes) = spawn(project, launch)?;
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || read_lines(pipes.stdout, |line| drop(sender.send(line.into()))));
    std::thread::spawn(move || drop(read_tail(pipes.stderr, 1024)));
    let result = (|| {
        for line in initial {
            process.write_line(&line)?;
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = receiver
                .recv_timeout(left)
                .map_err(|_| "读取超时。".to_string())?;
            let Ok(value) = serde_json::from_str(&line) else {
                continue;
            };
            match handle(&value) {
                Ok(lines) => {
                    for line in lines {
                        process.write_line(&line)?;
                    }
                }
                Err(()) => return Ok(()),
            }
        }
    })();
    process.shutdown();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_launch_runs_the_agent_through_a_login_shell_with_env_prefix() {
        let launch = Launch {
            program: "opencode".into(),
            args: vec!["acp".into()],
            env: vec![("OPENCODE_CONFIG_CONTENT".into(), "{\"a\":1}".into())],
        };
        let args = wsl_args("Ubuntu", "/home/me/app", &launch);
        assert_eq!(
            &args[..4],
            ["--distribution", "Ubuntu", "--cd", "/home/me/app"]
        );
        assert_eq!(
            &args[8..],
            [
                "sh",
                "env",
                "OPENCODE_CONFIG_CONTENT={\"a\":1}",
                "opencode",
                "acp"
            ]
        );
    }

    #[test]
    fn read_lines_skips_blank_lines_and_tolerates_invalid_utf8() {
        let input: &[u8] = b"{\"a\":1}\n\n\xff\xfe\nlast";
        let mut lines = Vec::new();
        read_lines(input, |line| lines.push(line.to_string()));
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "{\"a\":1}");
        assert_eq!(lines[2], "last");
    }

    #[test]
    fn remote_script_quotes_program_arguments_and_environment() {
        let launch = Launch {
            program: "opencode".into(),
            args: vec!["acp".into(), "it's".into()],
            env: vec![(
                "OPENCODE_CONFIG_CONTENT".into(),
                r#"{"permission":{"*":"ask"}}"#.into(),
            )],
        };
        assert_eq!(
            remote_script(&launch),
            r#"stty raw -echo 2>/dev/null; printf '\n%s\n' QINGCODE_AGENT_READY; exec "${SHELL:-/bin/sh}" -lic 'exec "$0" "$@"' env 'OPENCODE_CONFIG_CONTENT={"permission":{"*":"ask"}}' 'opencode' 'acp' 'it'\''s'"#
        );
    }

    #[test]
    fn line_buffer_joins_chunks_and_skips_shell_noise() {
        let mut buffer = LineBuffer::default();
        // 就绪前的登录提示与可能被回显的写入都丢弃。
        assert_eq!(buffer.push(b"Welcome\r\n{\"echo\":0}\r\n"), (false, vec![]));
        assert_eq!(buffer.push(b"\r\nQINGCODE_AGENT_"), (false, vec![]));
        assert_eq!(buffer.push(b"READY\n{\"id\":"), (true, vec![]));
        assert_eq!(buffer.push(b"1}\n\n{\"a\"").1, ["{\"id\":1}"]);
        assert_eq!(
            buffer.push(b":2}\r\nprompt$ {\"b\":3}\n").1,
            ["{\"a\":2}", "{\"b\":3}"]
        );
        let chinese = "{\"t\":\"你好\"}\n".as_bytes();
        assert!(buffer.push(&chinese[..9]).1.is_empty());
        assert_eq!(
            buffer.push(&chinese[9..]),
            (false, vec!["{\"t\":\"你好\"}".to_string()])
        );
    }

    #[test]
    fn remote_commands_are_queued_in_order() {
        let (remote, mut receiver) = RemoteProcess::new();
        let mut process = Process::Remote(remote);
        process.write_line("{\"a\":1}").unwrap();
        process.write_line("{\"b\":2}").unwrap();
        process.shutdown();
        assert_eq!(
            receiver.try_recv().unwrap(),
            RemoteCommand::Write("{\"a\":1}\n".into())
        );
        assert_eq!(
            receiver.try_recv().unwrap(),
            RemoteCommand::Write("{\"b\":2}\n".into())
        );
        assert_eq!(receiver.try_recv().unwrap(), RemoteCommand::Kill);
    }

    #[test]
    fn ssh_projects_are_not_spawned_locally() {
        let project = AgentProject {
            id: "p".into(),
            name: "p".into(),
            path: "ssh://c/home".into(),
            kind: "ssh".into(),
            host: "h".into(),
        };
        let error = spawn(&project, &Launch::default()).err().unwrap();
        assert!(error.contains("远端"));
    }
}
