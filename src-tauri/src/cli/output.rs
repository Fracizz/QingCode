//! Machine-readable CLI output and Windows console attachment.

use serde::Serialize;
use std::io::{self, Write};

pub const EXIT_OK: i32 = 0;
pub const EXIT_ERROR: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_APP_NOT_RUNNING: i32 = 3;

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

pub fn usage(msg: impl Into<String>) -> i32 {
    fail(EXIT_USAGE, msg)
}

pub fn help_text() -> &'static str {
    r#"QingCode CLI — AI-friendly project & run-config commands

Usage:
  qingcode.exe project list
  qingcode.exe project add <dir> [<dir>...]
  qingcode.exe project remove <id|path|name>
  qingcode.exe project switch <id|path|name>

  qingcode.exe run list [--project <id|path|name>]
  qingcode.exe run get <name|id> [--project ...]
  qingcode.exe run upsert --json <file|-> [--project ...]
  qingcode.exe run remove <name|id> [--project ...]
  qingcode.exe run start <name|id> [--project ...]
  qingcode.exe run stop <name|id> [--project ...]
  qingcode.exe run status [--project ...]

  qingcode.exe trust grant <path>
  qingcode.exe open <file>[:line[:col]] ...

Exit codes: 0 ok | 1 error | 2 usage | 3 app not running
Output: JSON on stdout
"#
}

pub fn write_line_stdout(line: &str) {
    write_line("stdout", line);
}

pub fn write_help_hint() {
    write_line("stderr", "run: qingcode.exe --help");
}
