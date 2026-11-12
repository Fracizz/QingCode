//! Machine-readable CLI output and Windows console attachment.

use serde::Serialize;
use std::io::{self, Write};

pub const EXIT_OK: i32 = 0;
pub const EXIT_ERROR: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_APP_NOT_RUNNING: i32 = 3;
/// 等待超时，操作可能仍在 GUI 中继续；调用方应先查询状态再决定是否重试。
pub const EXIT_TIMEOUT: i32 = 4;

#[derive(Serialize)]
pub struct CliResponse<T: Serialize> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Attach to the parent console on Windows so `qingcode.exe` (GUI subsystem) can print.
pub fn ensure_stdio() {
    #[cfg(windows)]
    {
        attach_parent_console();
    }
}

#[cfg(windows)]
fn attach_parent_console() {
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
    }
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

fn write_line(stream: &str, line: &str) {
    #[cfg(windows)]
    {
        if write_win_handle(stream, line) {
            return;
        }
        if write_console_device(stream, line) {
            return;
        }
    }
    let _ = match stream {
        "stderr" => {
            let mut err = io::stderr().lock();
            writeln!(err, "{line}")
        }
        _ => {
            let mut out = io::stdout().lock();
            writeln!(out, "{line}")
        }
    };
}

#[cfg(windows)]
fn write_win_handle(stream: &str, line: &str) -> bool {
    // STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12
    const STD_OUTPUT_HANDLE: u32 = 0xFFFFFFF5;
    const STD_ERROR_HANDLE: u32 = 0xFFFFFFF4;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> *mut core::ffi::c_void;
        fn WriteFile(
            handle: *mut core::ffi::c_void,
            buffer: *const u8,
            bytes_to_write: u32,
            bytes_written: *mut u32,
            overlapped: *mut core::ffi::c_void,
        ) -> i32;
    }
    let handle_id = if stream == "stderr" {
        STD_ERROR_HANDLE
    } else {
        STD_OUTPUT_HANDLE
    };
    unsafe {
        let handle = GetStdHandle(handle_id);
        if handle.is_null() || handle == (-1isize as *mut core::ffi::c_void) {
            return false;
        }
        let mut payload = String::with_capacity(line.len() + 2);
        payload.push_str(line);
        payload.push_str("\r\n");
        let mut written = 0u32;
        WriteFile(
            handle,
            payload.as_ptr(),
            payload.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        ) != 0
            && written > 0
    }
}

#[cfg(windows)]
fn write_console_device(stream: &str, line: &str) -> bool {
    use std::fs::OpenOptions;
    use std::io::Write as _;
    let device = if stream == "stderr" {
        "CONERR$"
    } else {
        "CONOUT$"
    };
    let Ok(mut file) = OpenOptions::new().write(true).open(device) else {
        return false;
    };
    writeln!(file, "{line}").is_ok()
}

pub fn print_json<T: Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(s) => write_line("stdout", &s),
        Err(e) => write_line("stderr", &format!("json encode failed: {e}")),
    }
}

pub fn ok<T: Serialize>(data: T) -> i32 {
    print_json(&CliResponse {
        ok: true,
        data: Some(data),
        error: None,
    });
    EXIT_OK
}

pub fn fail(code: i32, error: impl Into<String>) -> i32 {
    print_json(&CliResponse::<serde_json::Value> {
        ok: false,
        data: None,
        error: Some(error.into()),
    });
    code
}

pub fn fail_with_data<T: Serialize>(code: i32, error: impl Into<String>, data: T) -> i32 {
    print_json(&CliResponse {
        ok: false,
        data: Some(data),
        error: Some(error.into()),
    });
    code
}

pub fn usage(msg: impl Into<String>) -> i32 {
    fail(EXIT_USAGE, msg)
}

pub fn help_text() -> &'static str {
    r#"QingCode CLI — AI-friendly project & run-config commands

Usage:
  qingcode.exe version
  qingcode.exe status
  status reports whether the GUI is running, its version, and CLI compatibility.

  qingcode.exe project list
  qingcode.exe project add <dir> [<dir>...]
  qingcode.exe project remove <id|path|name>
  qingcode.exe project switch <id|path|name>

  qingcode.exe run list [--project <id|path|name>]
  qingcode.exe run get <name|id> [--project ...]
  qingcode.exe run upsert --json <file|-> [--project ...]
  qingcode.exe run remove <name|id> [--project ...]
  qingcode.exe run start <name|id> [--project ...] [--task <id|name>] [--wait] [--wait-text <text>] [--timeout <seconds>]
  qingcode.exe run stop <name|id> [--project ...] [--task <id|name>]
  qingcode.exe run restart <name|id> [--project ...] [--task <id|name>]
  qingcode.exe run logs <name|id> [--project ...] [--task <id|name>] [--tail <n>]
  qingcode.exe run status [--project ...]

  Task OS overrides: os.windows / os.linux / os.macos override type, target, cwd, env.
  Common task fields are defaults; env merges by name. WSL uses linux; SSH uses remote OS.
  Existing configs and commands remain supported. start/stop/status require the running app.
  run start submits tasks asynchronously and fails at once for an untrusted project.
  --wait waits until tasks started; --wait-text also waits for that text in task output.

  qingcode.exe terminal profiles
  qingcode.exe terminal list [--project ...]
  qingcode.exe terminal read <id|name> [--project ...] [--scope screen|buffer] [--tail <n>]
  qingcode.exe terminal send <id|name> [--project ...] [--text <text> | --stdin] [--enter]
  qingcode.exe terminal create [--profile <id|name>] [--project ...]
  qingcode.exe terminal restart <id|name> [--project ...]
  qingcode.exe terminal close <id|name> --yes [--project ...]
  Terminal commands require the GUI. read/send/create/restart need a trusted project (local or
  SSH). send writes raw input; --enter appends CR. Success means queued, not executed.

  qingcode.exe settings export [--scope user|workspace] [--project ...] [--output <file>]
  qingcode.exe settings import --json <file|-> [--scope user|workspace] [--project ...]
  qingcode.exe settings reset --yes [--scope user|workspace] [--project ...]
  Settings commands require the GUI. Default scope: user. Export refuses to overwrite files.

  qingcode.exe trust grant <path>
  qingcode.exe trust revoke <path>
  qingcode.exe trust list
  qingcode.exe open <file>[:line[:col]] ...
  Relative paths are resolved against this command's working directory.

Exit codes: 0 ok | 1 error | 2 usage | 3 app not running or still loading | 4 timed out
Output: JSON on stdout
"#
}

pub fn write_line_stdout(line: &str) {
    write_line("stdout", line);
}

pub fn write_help_hint() {
    write_line("stderr", "run: qingcode.exe --help");
}
