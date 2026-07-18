//! Format the current editor buffer via external tools
//! (Prettier / rustfmt / shfmt / ruff|black / gofmt).
//! Content is passed on stdin; the disk file is not overwritten by this command.

use crate::file_encoding::{self, FileEncoding};
use crate::path_guard::PathAllowlist;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::State;

/// Keep formatting responsive; larger buffers should use a dedicated tool outside the editor.
const MAX_FORMAT_BYTES: usize = 5 * 1024 * 1024;
const FORMAT_TIMEOUT: Duration = Duration::from_secs(45);

// Short, actionable hints when the external tool is missing (project or PATH).
const HINT_PRETTIER: &str = "未找到 Prettier。请在项目执行：npm i -D prettier";
const HINT_PYTHON: &str = "暂不支持 Python 格式化";
const HINT_RUSTFMT: &str = "未找到 rustfmt。请执行：rustup component add rustfmt";
const HINT_SHFMT: &str = "未找到 shfmt。请安装 shfmt 并加入 PATH";
const HINT_GOFMT: &str = "未找到 gofmt。请安装 Go 并确保 gofmt 在 PATH 中";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormatterKind {
    Prettier,
    Rustfmt,
    Shfmt,
    Python,
    Gofmt,
}

fn extension_of(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn formatter_for_extension(ext: &str) -> Option<FormatterKind> {
    match ext {
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" | "json" | "jsonc" | "css"
        | "scss" | "less" | "html" | "htm" | "md" | "markdown" | "mdx" | "yml" | "yaml"
        | "graphql" | "gql" | "vue" | "astro" => Some(FormatterKind::Prettier),
        "rs" => Some(FormatterKind::Rustfmt),
        // Matches editor language map (`sh` → shell). bat/ps1 use other formatters; skip.
        "sh" => Some(FormatterKind::Shfmt),
        "py" | "pyi" => Some(FormatterKind::Python),
        "go" => Some(FormatterKind::Gofmt),
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

fn cwd_for_file(path: &str) -> &Path {
    Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn look_up_node_bin(start: &Path, name: &str) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    if dir.is_file() {
        dir.pop();
    }
    loop {
        #[cfg(windows)]
        let candidate = dir
            .join("node_modules")
            .join(".bin")
            .join(format!("{name}.cmd"));
        #[cfg(not(windows))]
        let candidate = dir.join("node_modules").join(".bin").join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn look_up_prettier(start: &Path) -> Option<PathBuf> {
    look_up_node_bin(start, "prettier")
}

/// Walk ancestors for `.venv` / `venv` tool binaries (discovery only; no installs).
#[allow(dead_code)] // Kept for restoring Python formatters (ruff/black).
fn look_up_venv_tool(start: &Path, tool: &str) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    if dir.is_file() {
        dir.pop();
    }
    #[cfg(windows)]
    let rels: [PathBuf; 2] = [
        PathBuf::from(".venv")
            .join("Scripts")
            .join(format!("{tool}.exe")),
        PathBuf::from("venv")
            .join("Scripts")
            .join(format!("{tool}.exe")),
    ];
    #[cfg(not(windows))]
    let rels: [PathBuf; 2] = [
        PathBuf::from(".venv").join("bin").join(tool),
        PathBuf::from("venv").join("bin").join(tool),
    ];
    loop {
        for rel in &rels {
            let candidate = dir.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn is_spawn_failure(err: &str) -> bool {
    err.starts_with("无法启动格式化工具") || err.starts_with("未找到格式化工具")
}

fn or_missing_hint(hint: &'static str, err: String) -> String {
    if is_spawn_failure(&err) {
        hint.to_string()
    } else {
        err
    }
}

/// Windows `cmd` prints “不是内部或外部命令…” in the OEM/ANSI code page (often GBK).
fn decode_process_text(bytes: &[u8]) -> String {
    file_encoding::decode(bytes, FileEncoding::Auto)
        .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned())
        .trim()
        .to_string()
}

fn is_command_not_found(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    detail.contains("不是内部或外部命令")
        || lower.contains("not recognized as an internal or external command")
        || lower.contains("no such file or directory")
        || lower.contains("command not found")
        || (detail.contains("无法将") && detail.contains("项识别为"))
}

fn truncate_error_detail(detail: &str) -> String {
    const MAX: usize = 280;
    let compact = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= MAX {
        return compact;
    }
    let truncated: String = compact.chars().take(MAX).collect();
    format!("{truncated}…")
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
        Err(_) => return Err(format!("格式化超时（{} 秒）", FORMAT_TIMEOUT.as_secs())),
    };

    if !output.status.success() {
        let stderr = decode_process_text(&output.stderr);
        let stdout = decode_process_text(&output.stdout);
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("退出码 {}", output.status.code().unwrap_or(-1))
        };
        if is_command_not_found(&detail) {
            return Err("未找到格式化工具（命令不在 PATH 中）".to_string());
        }
        return Err(format!("格式化失败: {}", truncate_error_detail(&detail)));
    }

    // Formatters emit UTF-8 source; keep strict decode for the buffer we apply.
    String::from_utf8(output.stdout).map_err(|e| format!("格式化输出不是有效 UTF-8: {e}"))
}

fn run_windows_cmd_bin(
    bin: &Path,
    cwd: &Path,
    args: &[&str],
    content: &str,
) -> Result<String, String> {
    let mut cmd = Command::new("cmd");
    cmd.current_dir(cwd).arg("/C").arg(bin);
    for arg in args {
        cmd.arg(arg);
    }
    run_with_stdin(cmd, content)
}

fn run_direct_bin(bin: &Path, cwd: &Path, args: &[&str], content: &str) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.current_dir(cwd);
    for arg in args {
        cmd.arg(arg);
    }
    run_with_stdin(cmd, content)
}

fn format_with_prettier(path: &str, content: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    let cwd = cwd_for_file(path);
    let args = ["--stdin-filepath", path];

    if let Some(bin) = look_up_prettier(file_path) {
        #[cfg(windows)]
        {
            return run_windows_cmd_bin(&bin, cwd, &args, content);
        }
        #[cfg(not(windows))]
        {
            return run_direct_bin(&bin, cwd, &args, content);
        }
    }

    // Fall back to PATH / npx (requires Node.js).
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.current_dir(cwd)
            .args(["/C", "prettier", "--stdin-filepath", path]);
        match run_with_stdin(cmd, content) {
            Ok(formatted) => return Ok(formatted),
            Err(e) if is_spawn_failure(&e) => {}
            Err(e) => return Err(e),
        }
        let mut npx = Command::new("cmd");
        npx.current_dir(cwd).args([
            "/C",
            "npx",
            "--no-install",
            "prettier",
            "--stdin-filepath",
            path,
        ]);
        run_with_stdin(npx, content).map_err(|e| or_missing_hint(HINT_PRETTIER, e))
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("prettier");
        cmd.current_dir(cwd).arg("--stdin-filepath").arg(path);
        match run_with_stdin(cmd, content) {
            Ok(formatted) => return Ok(formatted),
            Err(e) if is_spawn_failure(&e) => {}
            Err(e) => return Err(e),
        }
        let mut npx = Command::new("npx");
        npx.current_dir(cwd)
            .args(["--no-install", "prettier", "--stdin-filepath", path]);
        run_with_stdin(npx, content).map_err(|e| or_missing_hint(HINT_PRETTIER, e))
    }
}

fn format_with_rustfmt(content: &str) -> Result<String, String> {
    let mut cmd = Command::new("rustfmt");
    cmd.arg("--emit").arg("stdout");
    run_with_stdin(cmd, content).map_err(|e| or_missing_hint(HINT_RUSTFMT, e))
}

fn format_with_shfmt(path: &str, content: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    let cwd = cwd_for_file(path);
    // `-` = stdin; `-filename` helps dialect/config when available.
    let args = ["-filename", path, "-"];

    if let Some(bin) = look_up_node_bin(file_path, "shfmt") {
        #[cfg(windows)]
        {
            return run_windows_cmd_bin(&bin, cwd, &args, content)
                .map_err(|e| or_missing_hint(HINT_SHFMT, e));
        }
        #[cfg(not(windows))]
        {
            return run_direct_bin(&bin, cwd, &args, content)
                .map_err(|e| or_missing_hint(HINT_SHFMT, e));
        }
    }

    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.current_dir(cwd)
            .args(["/C", "shfmt", "-filename", path, "-"]);
        run_with_stdin(cmd, content).map_err(|e| or_missing_hint(HINT_SHFMT, e))
    }
    #[cfg(not(windows))]
    {
        run_direct_bin(Path::new("shfmt"), cwd, &args, content)
            .map_err(|e| or_missing_hint(HINT_SHFMT, e))
    }
}

#[allow(dead_code)] // Kept for restoring Python formatters.
fn run_ruff_format(bin: &Path, cwd: &Path, path: &str, content: &str) -> Result<String, String> {
    let args = ["format", "--stdin-filename", path, "-"];
    #[cfg(windows)]
    {
        // Prefer direct spawn (finds `ruff.exe` on PATH). Fall back to cmd for .cmd shims.
        match run_direct_bin(bin, cwd, &args, content) {
            Ok(formatted) => return Ok(formatted),
            Err(e) if is_spawn_failure(&e) || is_command_not_found(&e) => {}
            Err(e) => return Err(e),
        }
        let mut cmd = Command::new("cmd");
        cmd.current_dir(cwd)
            .args(["/C", "ruff", "format", "--stdin-filename", path, "-"]);
        run_with_stdin(cmd, content)
    }
    #[cfg(not(windows))]
    {
        run_direct_bin(bin, cwd, &args, content)
    }
}

#[allow(dead_code)] // Kept for restoring Python formatters.
fn run_black(bin: &Path, cwd: &Path, path: &str, content: &str) -> Result<String, String> {
    let args = ["--stdin-filename", path, "-q", "-"];
    #[cfg(windows)]
    {
        match run_direct_bin(bin, cwd, &args, content) {
            Ok(formatted) => return Ok(formatted),
            Err(e) if is_spawn_failure(&e) || is_command_not_found(&e) => {}
            Err(e) => return Err(e),
        }
        let mut cmd = Command::new("cmd");
        cmd.current_dir(cwd)
            .args(["/C", "black", "--stdin-filename", path, "-q", "-"]);
        run_with_stdin(cmd, content)
    }
    #[cfg(not(windows))]
    {
        run_direct_bin(bin, cwd, &args, content)
    }
}

fn format_with_python(_path: &str, _content: &str) -> Result<String, String> {
    // Temporarily disabled — ruff/black helpers retained above for a later restore.
    Err(HINT_PYTHON.to_string())
}

fn format_with_gofmt(content: &str) -> Result<String, String> {
    let cmd = Command::new("gofmt");
    run_with_stdin(cmd, content).map_err(|e| or_missing_hint(HINT_GOFMT, e))
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

    let ext = extension_of(&path)
        .ok_or_else(|| "暂不支持格式化该语言/扩展名（无法识别文件类型）".to_string())?;
    let kind = formatter_for_extension(&ext)
        .ok_or_else(|| format!("暂不支持格式化该语言/扩展名（.{ext}）"))?;

    match kind {
        FormatterKind::Prettier => format_with_prettier(&path, &content),
        FormatterKind::Rustfmt => format_with_rustfmt(&content),
        FormatterKind::Shfmt => format_with_shfmt(&path, &content),
        FormatterKind::Python => format_with_python(&path, &content),
        FormatterKind::Gofmt => format_with_gofmt(&content),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_prettier_extensions() {
        assert_eq!(formatter_for_extension("ts"), Some(FormatterKind::Prettier));
        assert_eq!(
            formatter_for_extension("json"),
            Some(FormatterKind::Prettier)
        );
        assert_eq!(formatter_for_extension("md"), Some(FormatterKind::Prettier));
    }

    #[test]
    fn maps_rust() {
        assert_eq!(formatter_for_extension("rs"), Some(FormatterKind::Rustfmt));
    }

    #[test]
    fn maps_shell_python_go() {
        assert_eq!(formatter_for_extension("sh"), Some(FormatterKind::Shfmt));
        assert_eq!(formatter_for_extension("py"), Some(FormatterKind::Python));
        assert_eq!(formatter_for_extension("pyi"), Some(FormatterKind::Python));
        assert_eq!(formatter_for_extension("go"), Some(FormatterKind::Gofmt));
    }

    #[test]
    fn rejects_unsupported_extensions() {
        assert_eq!(formatter_for_extension("java"), None);
        assert_eq!(formatter_for_extension("bat"), None);
        assert_eq!(formatter_for_extension("ps1"), None);
        assert_eq!(formatter_for_extension("cpp"), None);
    }

    #[test]
    fn extension_is_lowercase() {
        assert_eq!(extension_of(r"D:\a\B.TS"), Some("ts".into()));
    }

    #[test]
    fn spawn_failure_detection() {
        assert!(is_spawn_failure("无法启动格式化工具: entity not found"));
        assert!(is_spawn_failure("未找到格式化工具（命令不在 PATH 中）"));
        assert!(!is_spawn_failure("格式化失败: syntax error"));
    }

    #[test]
    fn command_not_found_detection() {
        assert!(is_command_not_found(
            "'ruff' 不是内部或外部命令，也不是可运行的程序或批处理文件。"
        ));
        assert!(is_command_not_found(
            "'ruff' is not recognized as an internal or external command"
        ));
        assert!(!is_command_not_found("error: Failed to parse"));
    }

    #[test]
    fn decodes_gbk_cmd_not_found() {
        // "'ruff' 不是内部或外部命令" in GBK (common Windows cmd stderr).
        let gbk = [
            0x27u8, 0x72, 0x75, 0x66, 0x66, 0x27, 0x20, 0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2,
            0xbf, 0xbb, 0xf2, 0xcd, 0xe2, 0xb2, 0xbf, 0xc3, 0xfc, 0xc1, 0xee,
        ];
        let text = decode_process_text(&gbk);
        assert!(text.contains("ruff"), "{text}");
        assert!(text.contains("不是内部或外部命令"), "{text}");
    }
}
