//! Format the current editor buffer via external tools (Prettier / rustfmt).
//! Content is passed on stdin; the disk file is not overwritten by this command.

use crate::path_guard::PathAllowlist;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::State;

/// Keep formatting responsive; larger buffers should use a dedicated tool outside the editor.
const MAX_FORMAT_BYTES: usize = 5 * 1024 * 1024;
const FORMAT_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormatterKind {
    Prettier,
    Rustfmt,
}

fn extension_of(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn formatter_for_extension(ext: &str) -> Option<FormatterKind> {
    match ext {
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" | "json" | "jsonc"
        | "css" | "scss" | "less" | "html" | "htm" | "md" | "markdown" | "mdx" | "yml"
        | "yaml" | "graphql" | "gql" | "vue" | "astro" => Some(FormatterKind::Prettier),
        "rs" => Some(FormatterKind::Rustfmt),
        _ => None,
    }
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn look_up_prettier(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    if dir.is_file() {
        dir.pop();
    }
    loop {
        #[cfg(windows)]
        let candidate = dir.join("node_modules").join(".bin").join("prettier.cmd");
        #[cfg(not(windows))]
        let candidate = dir.join("node_modules").join(".bin").join("prettier");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn run_with_stdin(mut cmd: Command, input: &str) -> Result<String, String> {
    apply_no_window(&mut cmd);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动格式化工具: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("写入格式化输入失败: {e}"))?;
    }

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    let output = match rx.recv_timeout(FORMAT_TIMEOUT) {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("格式化进程失败: {e}")),
        Err(_) => {
            return Err(format!(
                "格式化超时（{} 秒）",
                FORMAT_TIMEOUT.as_secs()
            ))
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("退出码 {}", output.status.code().unwrap_or(-1))
        };
        return Err(format!("格式化失败: {detail}"));
    }

    String::from_utf8(output.stdout).map_err(|e| format!("格式化输出不是有效 UTF-8: {e}"))
}

fn format_with_prettier(path: &str, content: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    let cwd = file_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    if let Some(bin) = look_up_prettier(file_path) {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("cmd");
            cmd.current_dir(cwd)
                .arg("/C")
                .arg(&bin)
                .arg("--stdin-filepath")
                .arg(path);
            return run_with_stdin(cmd, content);
        }
        #[cfg(not(windows))]
        {
            let mut cmd = Command::new(&bin);
            cmd.current_dir(cwd)
                .arg("--stdin-filepath")
                .arg(path);
            return run_with_stdin(cmd, content);
        }
    }

    // Fall back to PATH / npx (requires Node.js).
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.current_dir(cwd)
            .args(["/C", "prettier", "--stdin-filepath", path]);
        if let Ok(formatted) = run_with_stdin(cmd, content) {
            return Ok(formatted);
        }
        let mut npx = Command::new("cmd");
        npx.current_dir(cwd)
            .args(["/C", "npx", "--no-install", "prettier", "--stdin-filepath", path]);
        run_with_stdin(npx, content).map_err(|e| {
            format!("{e}（请安装 Prettier：在项目中执行 npm i -D prettier，或全局安装）")
        })
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("prettier");
        cmd.current_dir(cwd)
            .arg("--stdin-filepath")
            .arg(path);
        if let Ok(formatted) = run_with_stdin(cmd, content) {
            return Ok(formatted);
        }
        let mut npx = Command::new("npx");
        npx.current_dir(cwd)
            .args(["--no-install", "prettier", "--stdin-filepath", path]);
        run_with_stdin(npx, content).map_err(|e| {
            format!("{e}（请安装 Prettier：在项目中执行 npm i -D prettier，或全局安装）")
        })
    }
}

fn format_with_rustfmt(content: &str) -> Result<String, String> {
    let mut cmd = Command::new("rustfmt");
    cmd.arg("--emit").arg("stdout");
    run_with_stdin(cmd, content).map_err(|e| {
        format!("{e}（请安装 rustfmt：rustup component add rustfmt）")
    })
}

/// Format `content` as if it belonged to `path`. Does not write the file.
#[tauri::command]
pub fn format_document(
    path: String,
    content: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    allowlist.ensure_allowed(&path)?;

    if content.len() > MAX_FORMAT_BYTES {
        return Err(format!(
            "文件过大（>{:.0} MB），无法在编辑器内格式化",
            MAX_FORMAT_BYTES as f64 / (1024.0 * 1024.0)
        ));
    }

    let ext = extension_of(&path).ok_or_else(|| "无法识别文件类型".to_string())?;
    let kind = formatter_for_extension(&ext).ok_or_else(|| {
        format!("暂不支持格式化 .{ext}（当前支持 Prettier 常用类型与 .rs / rustfmt）")
    })?;

    match kind {
        FormatterKind::Prettier => format_with_prettier(&path, &content),
        FormatterKind::Rustfmt => format_with_rustfmt(&content),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_prettier_extensions() {
        assert_eq!(formatter_for_extension("ts"), Some(FormatterKind::Prettier));
        assert_eq!(formatter_for_extension("json"), Some(FormatterKind::Prettier));
        assert_eq!(formatter_for_extension("md"), Some(FormatterKind::Prettier));
    }

    #[test]
    fn maps_rust() {
        assert_eq!(formatter_for_extension("rs"), Some(FormatterKind::Rustfmt));
    }

    #[test]
    fn rejects_unknown() {
        assert_eq!(formatter_for_extension("py"), None);
        assert_eq!(formatter_for_extension("go"), None);
    }

    #[test]
    fn extension_is_lowercase() {
        assert_eq!(extension_of(r"D:\a\B.TS"), Some("ts".into()));
    }
}
