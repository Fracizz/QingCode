//! WSL tasks keep Linux process-group ownership; killing wsl.exe alone is insufficient.
use super::*;
use crate::run_environment::{parse_wsl_path, WslPath};

#[derive(Clone)]
pub(super) struct WslTask {
    program: String,
    distro: String,
    state: String,
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn invocation(kind: &str, target: &str) -> Result<String, String> {
    let kind = if kind == "script" {
        let lower = target.to_lowercase();
        if lower.ends_with(".ps1") {
            "ps1"
        } else if lower.ends_with(".bat") || lower.ends_with(".cmd") {
            "bat"
        } else if lower.ends_with(".py") {
            "python"
        } else if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
            "node"
        } else if lower.ends_with(".sh") {
            "sh"
        } else {
            "executable"
        }
    } else {
        kind
    };
    match kind {
        "command" => Ok(format!("exec /bin/sh -c {}", quote(target))),
        "sh" => Ok(format!("exec /bin/sh {}", quote(target))),
        "python" => Ok(format!("exec python3 {}", quote(target))),
        "node" => Ok(format!("exec node {}", quote(target))),
        "executable" => Ok(format!("exec {}", quote(target))),
        "ps1" | "bat" => {
            Err("WSL 使用 Linux 工具链，请为任务配置 os.linux（command/sh/script）".into())
        }
        _ => Err(format!("WSL 不支持的任务类型：{kind}")),
    }
}

fn launch_script(
    cwd: &WslPath,
    root: &WslPath,
    kind: &str,
    target: &str,
    env: HashMap<String, String>,
    state: &str,
) -> Result<String, String> {
    if cwd.distro != root.distro {
        return Err("任务目录必须位于项目所属的 WSL 发行版内".into());
    }
    let mut assignments = Vec::new();
    for (key, value) in env {
        if key.is_empty()
            || !key
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit())
        {
            return Err(format!("无效的 WSL 环境变量名称：{key}"));
        }
        assignments.push(format!("export {key}={};", quote(&value)));
    }
    assignments.sort();
    let script_check = if kind != "command" {
        format!("file=$(readlink -f -- {}) || exit 1; case \"$file\" in \"$root\"/*) ;; *) echo '任务脚本越出项目根目录' >&2; exit 1;; esac; [ -f \"$file\" ] || {{ echo '任务脚本不存在' >&2; exit 1; }};", quote(target))
    } else {
        String::new()
    };
    // Login initialization runs inside Linux. Remove Windows drive PATH entries before tool lookup.
    let command = format!(
        r#"set -f
clean_path=''; old_ifs=$IFS; IFS=:
for entry in $PATH; do case "$entry" in /mnt/[a-zA-Z]/*|'') ;; *) clean_path="${{clean_path:+$clean_path:}}$entry";; esac; done
IFS=$old_ifs; export PATH=$clean_path
root=$(readlink -f -- {root}) || {{ echo 'WSL 项目目录不可用' >&2; exit 1; }}
cd -- {cwd} || {{ echo 'WSL 工作目录不存在' >&2; exit 1; }}
actual=$(pwd -P); case "$actual" in "$root"|"$root"/*) ;; *) echo 'WSL 工作目录越出项目根目录' >&2; exit 1;; esac
{script_check}
{assignments}
{invocation}
"#,
        root = quote(&root.path),
        cwd = quote(&cwd.path),
        assignments = assignments.join("\n"),
        invocation = invocation(kind, target)?
    );
    // A private random directory prevents collisions between tasks, app instances and restarts.
    Ok(format!(r#"command -v setsid >/dev/null 2>&1 || {{ echo 'WSL 缺少 setsid（util-linux），无法管理任务进程' >&2; exit 127; }}
umask 077
if ! mkdir -- {state}; then
  if [ -f {state}/cancel ]; then rm -f -- {state}/cancel; rmdir -- {state} 2>/dev/null || true; exit 143; fi
  exit 1
fi
cleanup() {{
  if [ -f {state}/pid ]; then
    read -r pid < {state}/pid
    case "$pid" in ''|*[!0-9]*) ;; *)
      kill -TERM -"$pid" 2>/dev/null || true
      count=0
      while kill -0 -"$pid" 2>/dev/null && [ "$count" -lt 20 ]; do sleep 0.1; count=$((count+1)); done
      kill -KILL -"$pid" 2>/dev/null || true;; esac
  fi
  rm -f -- {state}/pid {state}/cancel; rmdir -- {state} 2>/dev/null || true
}}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM
setsid /bin/sh -c {inner} &
wait $!
"#, state = quote(state), inner = quote(&format!("echo $$ > {state}/pid || exit 1; [ ! -f {state}/cancel ] || exit 143; exec /bin/sh -lc {command}", state=quote(state), command=quote(&command)))))
}

pub(super) fn build(
    cwd: WslPath,
    root: Option<&str>,
    kind: &str,
    target: &str,
    env: HashMap<String, String>,
) -> Result<(CommandBuilder, WslTask), String> {
    let root = root.and_then(parse_wsl_path).unwrap_or_else(|| cwd.clone());
    let program = locate_program("wsl.exe").ok_or("未找到 wsl.exe，请安装并启用 WSL 后重试")?;
    let task = WslTask {
        program,
        distro: cwd.distro.clone(),
        state: format!("/tmp/qingcode-task-{}", uuid::Uuid::new_v4()),
    };
    let script = launch_script(&cwd, &root, kind, target, env, &task.state)?;
    let mut cmd = CommandBuilder::new(&task.program);
    cmd.args([
        "--distribution",
        &task.distro,
        "--exec",
        "/bin/sh",
        "-c",
        &script,
    ]);
    Ok((cmd, task))
}

impl WslTask {
    pub(super) fn program(&self) -> &str {
        &self.program
    }
    fn stop_script(&self) -> String {
        // The native shell may be killed before WSL has written the pid. Marking cancellation
        // also prevents a delayed wrapper from starting a service after its tab was closed.
        format!(
            r#"
umask 077
mkdir -p -- {state} || exit 1
: > {state}/cancel
if [ -f {state}/pid ]; then
  read -r pid < {state}/pid
  case "$pid" in ''|*[!0-9]*) exit 1;; esac
  kill -TERM -"$pid" 2>/dev/null || true
  count=0
  while kill -0 -"$pid" 2>/dev/null && [ "$count" -lt 20 ]; do sleep 0.1; count=$((count+1)); done
  kill -KILL -"$pid" 2>/dev/null || true
  rm -f -- {state}/pid {state}/cancel; rmdir -- {state} 2>/dev/null || true
fi
"#,
            state = quote(&self.state)
        )
    }

    pub(super) fn stop(&self) -> Result<(), String> {
        let script = self.stop_script();
        let mut command = std::process::Command::new(&self.program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command
            .args([
                "--distribution",
                &self.distro,
                "--exec",
                "/bin/sh",
                "-c",
                &script,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法停止 WSL 任务（{}）：{error}", self.distro))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(status)) => {
                    return Err(format!("停止 WSL 任务失败（{}）：{status}", self.distro))
                }
                Err(error) => return Err(format!("停止 WSL 任务失败：{error}")),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("停止 WSL 任务超时，请检查发行版状态后重试".into());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn wsl_task_quotes_values_and_checks_linux_paths() {
        let path = WslPath {
            distro: "Ubuntu".into(),
            path: "/home/user/my app".into(),
        };
        let script = launch_script(
            &path,
            &path,
            "command",
            "pnpm dev",
            HashMap::from([("VALUE".into(), "a'b;$HOME".into())]),
            "/tmp/task-test",
        )
        .unwrap();
        let syntax = std::process::Command::new("/bin/sh")
            .args(["-n", "-c", &script])
            .status();
        assert!(syntax.unwrap().success());
    }

    #[cfg(unix)]
    #[test]
    fn linux_wrapper_preserves_cwd_env_and_rejects_symlink_escapes() {
        let directory =
            std::env::temp_dir().join(format!("qingcode wsl test {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let cwd = WslPath {
            distro: "Ubuntu".into(),
            path: directory.to_string_lossy().into_owned(),
        };
        let state = directory.join("state").to_string_lossy().into_owned();
        let script = launch_script(
            &cwd,
            &cwd,
            "command",
            "printf '%s\\n' \"$VALUE\"; pwd -P",
            HashMap::from([("VALUE".into(), "a'b;$HOME".into())]),
            &state,
        )
        .unwrap();
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            format!("a'b;$HOME\n{}", directory.display())
        );
        std::os::unix::fs::symlink("/", directory.join("escape")).unwrap();
        let escaped = WslPath {
            path: directory.join("escape").to_string_lossy().into_owned(),
            ..cwd.clone()
        };
        let script = launch_script(
            &escaped,
            &cwd,
            "command",
            "echo SHOULD_NOT_RUN",
            HashMap::new(),
            &state,
        )
        .unwrap();
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("SHOULD_NOT_RUN"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linux_wrapper_stop_terminates_owned_worker_group() {
        let directory =
            std::env::temp_dir().join(format!("qingcode-wsl-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let cwd = WslPath {
            distro: "Ubuntu".into(),
            path: directory.to_string_lossy().into_owned(),
        };
        let state = directory.join("state").to_string_lossy().into_owned();
        let script = launch_script(
            &cwd,
            &cwd,
            "command",
            "sleep 60 & echo $! > worker; wait",
            HashMap::new(),
            &state,
        )
        .unwrap();
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !directory.join("worker").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let task = WslTask {
            program: "unused".into(),
            distro: "Ubuntu".into(),
            state,
        };
        let stopped = std::process::Command::new("/bin/sh")
            .args(["-c", &task.stop_script()])
            .status()
            .unwrap();
        assert!(stopped.success());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while child.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let exited = child.try_wait().unwrap().is_some();
        if !exited {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        assert!(exited, "worker group kept the task alive after stop");
        let pid = std::fs::read_to_string(directory.join("worker")).unwrap();
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{}/stat", pid.trim())) {
            assert!(stat.contains(") Z "), "worker still running: {stat}");
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn wsl_rejects_wrong_distro_windows_scripts_and_invalid_env() {
        let cwd = WslPath {
            distro: "Ubuntu".into(),
            path: "/app".into(),
        };
        let other = WslPath {
            distro: "Debian".into(),
            path: "/app".into(),
        };
        assert!(
            launch_script(&cwd, &other, "command", "echo ok", HashMap::new(), "/tmp/x").is_err()
        );
        assert!(launch_script(&cwd, &cwd, "bat", "run.bat", HashMap::new(), "/tmp/x").is_err());
        assert!(launch_script(
            &cwd,
            &cwd,
            "command",
            "echo ok",
            HashMap::from([("BAD=KEY".into(), "x".into())]),
            "/tmp/x"
        )
        .is_err());
    }
}
