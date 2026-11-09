//! 控制台版 CLI 入口。
//!
//! Windows 发布版 `qingcode.exe` 是 GUI 子系统程序，交互式 cmd/PowerShell 不会等它结束，
//! 也拿不到退出码。这个控制台程序只负责转发参数、等待并原样返回退出码。

use std::path::PathBuf;
use std::process::{Command, ExitCode};

fn sibling_app(exe: PathBuf) -> PathBuf {
    exe.with_file_name(if cfg!(windows) {
        "qingcode.exe"
    } else {
        "qingcode"
    })
}

fn fail(message: String) -> ExitCode {
    // 与主程序的输出约定一致：stdout 上的 JSON，退出码 1。
    let body = serde_json::json!({ "ok": false, "error": message });
    println!("{body}");
    ExitCode::from(1)
}

fn main() -> ExitCode {
    let app = match std::env::current_exe() {
        Ok(exe) => sibling_app(exe),
        Err(error) => return fail(format!("locate exe: {error}")),
    };
    let mut args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.is_empty() {
        // 无参数时主程序会启动 GUI，而这里会一直等它退出。
        args.push("--help".into());
    }
    match Command::new(&app).args(args).status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(error) => fail(format!("run {}: {error}", app.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_is_resolved_next_to_the_shim() {
        let app = sibling_app(PathBuf::from("dir").join("qingcode-cli.exe"));
        assert_eq!(app.parent().unwrap(), std::path::Path::new("dir"));
        assert!(app.file_stem().unwrap().eq_ignore_ascii_case("qingcode"));
    }
}
