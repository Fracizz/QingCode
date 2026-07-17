//! Format the current editor buffer via external tools
//! (Prettier / rustfmt / shfmt / ruff|black / gofmt).
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
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" | "json" | "jsonc"
        | "css" | "scss" | "less" | "html" | "htm" | "md" | "markdown" | "mdx" | "yml"
        | "yaml" | "graphql" | "gql" | "vue" | "astro" => Some(FormatterKind::Prettier),
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
    err.starts_with("无法启动格式化工具")
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

fn run_windows_cmd_bin(bin: &Path, cwd: &Path, args: &[&str], content: &str) -> Result<String, String> {
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
        npx.current_dir(cwd)
            .args(["/C", "npx", "--no-install", "prettier", "--stdin-filepath", path]);
        run_with_stdin(npx, content).map_err(|e| {
            if is_spawn_failure(&e) {
                "未找到 prettier（请安装 Prettier：在项目中执行 npm i -D prettier，或全局安装）"
                    .to_string()
            } else {
                format!("{e}（请安装 Prettier：在项目中执行 npm i -D prettier，或全局安装）")
            }
        })
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("prettier");
        cmd.current_dir(cwd)
            .arg("--stdin-filepath")
            .arg(path);
        match run_with_stdin(cmd, content) {
            Ok(formatted) => return Ok(formatted),
            Err(e) if is_spawn_failure(&e) => {}
            Err(e) => return Err(e),
        }
        let mut npx = Command::new("npx");
        npx.current_dir(cwd)
            .args(["--no-install", "prettier", "--stdin-filepath", path]);
        run_with_stdin(npx, content).map_err(|e| {
            if is_spawn_failure(&e) {
                "未找到 prettier（请安装 Prettier：在项目中执行 npm i -D prettier，或全局安装）"
                    .to_string()
            } else {
                format!("{e}（请安装 Prettier：在项目中执行 npm i -D prettier，或全局安装）")
            }
        })
    }
}

fn format_with_rustfmt(content: &str) -> Result<String, String> {
    let mut cmd = Command::new("rustfmt");
    cmd.arg("--emit").arg("stdout");
    run_with_stdin(cmd, content).map_err(|e| {
        if is_spawn_failure(&e) {
            "未找到 rustfmt（请安装：rustup component add rustfmt）".to_string()
        } else {
            format!("{e}（请安装 rustfmt：rustup component add rustfmt）")
        }
    })
}

fn format_with_shfmt(path: &str, content: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    let cwd = cwd_for_file(path);
    // `-` = stdin; `-filename` helps dialect/config when available.
    let args = ["-filename", path, "-"];

    if let Some(bin) = look_up_node_bin(file_path, "shfmt") {
        #[cfg(windows)]
        {
            return run_windows_cmd_bin(&bin, cwd, &args, content).map_err(|e| {
                if is_spawn_failure(&e) {
                    "未找到 shfmt（请安装 shfmt 并加入 PATH，或在项目中安装）".to_string()
                } else {
                    e
                }
            });
        }
        #[cfg(not(windows))]
        {
            return run_direct_bin(&bin, cwd, &args, content).map_err(|e| {
                if is_spawn_failure(&e) {
                    "未找到 shfmt（请安装 shfmt 并加入 PATH，或在项目中安装）".to_string()
                } else {
                    e
                }
            });
        }
    }

    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.current_dir(cwd)
            .args(["/C", "shfmt", "-filename", path, "-"]);
        run_with_stdin(cmd, content).map_err(|e| {
            if is_spawn_failure(&e) {
                "未找到 shfmt（请安装 shfmt 并加入 PATH）".to_string()
            } else {
                e
            }
        })
    }
    #[cfg(not(windows))]
    {
        run_direct_bin(Path::new("shfmt"), cwd, &args, content).map_err(|e| {
            if is_spawn_failure(&e) {
                "未找到 shfmt（请安装 shfmt 并加入 PATH）".to_string()
            } else {
                e
            }
        })
    }
}

fn run_ruff_format(bin: &Path, cwd: &Path, path: &str, content: &str) -> Result<String, String> {
    let args = ["format", "--stdin-filename", path, "-"];
    #[cfg(windows)]
    {
        // Local venv `.exe` runs directly; PATH name may need cmd for .cmd shims.
        if bin.extension().and_then(|e| e.to_str()) == Some("exe") || bin.is_absolute() {
            run_direct_bin(bin, cwd, &args, content)
        } else {
            let mut cmd = Command::new("cmd");
            cmd.current_dir(cwd)
                .args(["/C", "ruff", "format", "--stdin-filename", path, "-"]);
            run_with_stdin(cmd, content)
        }
    }
    #[cfg(not(windows))]
    {
        run_direct_bin(bin, cwd, &args, content)
    }
}

fn run_black(bin: &Path, cwd: &Path, path: &str, content: &str) -> Result<String, String> {
    let args = ["--stdin-filename", path, "-q", "-"];
    #[cfg(windows)]
    {
        if bin.extension().and_then(|e| e.to_str()) == Some("exe") || bin.is_absolute() {
            run_direct_bin(bin, cwd, &args, content)
        } else {
            let mut cmd = Command::new("cmd");
            cmd.current_dir(cwd)
                .args(["/C", "black", "--stdin-filename", path, "-q", "-"]);
            run_with_stdin(cmd, content)
        }
    }
    #[cfg(not(windows))]
    {
        run_direct_bin(bin, cwd, &args, content)
    }
}

fn format_with_python(path: &str, content: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    let cwd = cwd_for_file(path);

    // Prefer ruff format, then black. Local venv first, then PATH.
    if let Some(bin) = look_up_venv_tool(file_path, "ruff") {
        return run_ruff_format(&bin, cwd, path, content);
    }

    match run_ruff_format(Path::new("ruff"), cwd, path, content) {
        Ok(formatted) => return Ok(formatted),
        Err(e) if is_spawn_failure(&e) => {}
        Err(e) => return Err(e),
    }

    if let Some(bin) = look_up_venv_tool(file_path, "black") {
        return run_black(&bin, cwd, path, content);
    }

    match run_black(Path::new("black"), cwd, path, content) {
        Ok(formatted) => Ok(formatted),
        Err(e) if is_spawn_failure(&e) => Err(
            "未找到 ruff/black（请安装：pip install ruff 或 pip install black，并确保在 PATH 或项目 .venv 中可用）"
                .to_string(),
        ),
        Err(e) => Err(e),
    }
}

fn format_with_gofmt(content: &str) -> Result<String, String> {
    let cmd = Command::new("gofmt");
    run_with_stdin(cmd, content).map_err(|e| {
        if is_spawn_failure(&e) {
            "未找到 gofmt（请安装 Go 工具链并确保 gofmt 在 PATH 中）".to_string()
        } else {
            e
        }
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

    let ext = extension_of(&path).ok_or_else(|| {
        "暂不支持格式化该语言/扩展名（无法识别文件类型）".to_string()
    })?;
    let kind = formatter_for_extension(&ext).ok_or_else(|| {
        format!("暂不支持格式化该语言/扩展名（.{ext}）")
    })?;

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
        assert_eq!(formatter_for_extension("json"), Some(FormatterKind::Prettier));
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
        assert!(!is_spawn_failure("格式化失败: syntax error"));
    }
}
