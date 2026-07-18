use crate::file_encoding::{self, FileEncoding};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

const MAX_DIFF_BYTES: usize = 1_000_000;

#[derive(Debug, Serialize, Clone)]
pub struct GitChange {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitStatus {
    pub is_repository: bool,
    pub branch: Option<String>,
    pub changes: Vec<GitChange>,
}

fn run_git(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.current_dir(root).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .output()
        .map_err(|error| format!("无法运行 Git：{error}"))
}

fn is_not_repository_error(output: &Output) -> bool {
    let message = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    message.contains("not a git repository") || message.contains("不是 git 仓库")
}

fn parse_branch(header: &str) -> Option<String> {
    let branch = header
        .trim_start_matches("## ")
        .strip_prefix("No commits yet on ")
        .unwrap_or_else(|| header.trim_start_matches("## "))
        .split("...")
        .next()
        .unwrap_or_default()
        .trim();
    if branch.is_empty() || branch.starts_with("HEAD (no branch)") {
        None
    } else {
        Some(branch.to_string())
    }
}

/// Parse porcelain v1 `-z` records. NUL framing preserves Chinese, spaces and
/// rename paths exactly instead of relying on Git's display-oriented quoting.
fn parse_status(output: &[u8]) -> GitStatus {
    let mut branch = None;
    let mut changes = vec![];
    let mut records = output.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.starts_with(b"## ") {
            branch = parse_branch(&String::from_utf8_lossy(record));
            continue;
        }
        if record.len() < 4 {
            continue;
        }
        let status = String::from_utf8_lossy(&record[..2]).trim().to_string();
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if status.is_empty() || path.is_empty() {
            continue;
        }
        // In -z mode rename/copy source path is a second record; the first is
        // the destination shown in the panel and used for the diff pathspec.
        if status.contains('R') || status.contains('C') {
            let _source_path = records.next();
        }
        changes.push(GitChange { path, status });
    }
    GitStatus {
        is_repository: true,
        branch,
        changes,
    }
}

fn resolve_relative(root: &Path, file: &str) -> Result<String, String> {
    let file_path = Path::new(file);
    let relative: PathBuf = if file_path.is_absolute() {
        file_path
            .strip_prefix(root)
            .map_err(|_| "仅允许查看当前项目内的文件差异".to_string())?
            .to_path_buf()
    } else {
        file_path.to_path_buf()
    };
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
    {
        return Err("仅允许查看当前项目内的文件差异".to_string());
    }
    // Git accepts forward slashes on Windows and matches porcelain paths.
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn decode_git_text(bytes: &[u8]) -> String {
    file_encoding::decode(bytes, FileEncoding::Auto)
        .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned())
}

fn truncate_diff(bytes: Vec<u8>) -> String {
    if bytes.len() <= MAX_DIFF_BYTES {
        return decode_git_text(&bytes);
    }
    format!(
        "{}\n\n… 差异内容已截断（最多显示 1MB）",
        decode_git_text(&bytes[..MAX_DIFF_BYTES])
    )
}

fn stdout_if_success(output: Output) -> Result<Option<Vec<u8>>, String> {
    if output.status.success() {
        if output.stdout.is_empty() {
            Ok(None)
        } else {
            Ok(Some(output.stdout))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // No commits yet / missing HEAD — caller should fall back.
        if stderr.to_ascii_lowercase().contains("bad revision")
            || stderr.to_ascii_lowercase().contains("unknown revision")
            || stderr.contains("ambiguous argument 'HEAD'")
            || stderr.contains("不存在")
        {
            Ok(None)
        } else {
            Err(format!("读取 Git 差异失败：{stderr}"))
        }
    }
}

fn synthetic_untracked_diff(root: &Path, relative: &str) -> Result<Option<String>, String> {
    let absolute = root.join(relative);
    if !absolute.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&absolute).map_err(|error| format!("读取未跟踪文件失败：{error}"))?;
    if bytes.len() > MAX_DIFF_BYTES {
        return Ok(Some(format!(
            "diff --git a/{relative} b/{relative}\nnew file mode 100644\n--- /dev/null\n+++ b/{relative}\n@@ 文件过大，已跳过内容预览（>{MAX_DIFF_BYTES} bytes）@@\n"
        )));
    }
    let content = decode_git_text(&bytes);
    let mut out = format!(
        "diff --git a/{relative} b/{relative}\nnew file mode 100644\n--- /dev/null\n+++ b/{relative}\n"
    );
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    if lines.is_empty() || (lines.len() == 1 && lines[0].is_empty()) {
        out.push_str("@@ -0,0 +0,0 @@\n");
        return Ok(Some(out));
    }
    let count = lines.len();
    out.push_str(&format!("@@ -0,0 +1,{count} @@\n"));
    for line in lines {
        out.push('+');
        out.push_str(line);
        if !line.ends_with('\n') {
            out.push('\n');
            out.push_str("\\ No newline at end of file\n");
        }
    }
    Ok(Some(out))
}

fn collect_file_diff(root: &Path, relative: &str) -> Result<String, String> {
    // Prefer HEAD so staged + unstaged changes both appear (VS Code-like).
    let head = run_git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=3",
            "HEAD",
            "--",
            relative,
        ],
    )?;
    if let Some(bytes) = stdout_if_success(head)? {
        return Ok(truncate_diff(bytes));
    }

    let cached = run_git(
        root,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            "--unified=3",
            "--",
            relative,
        ],
    )?;
    if let Some(bytes) = stdout_if_success(cached)? {
        return Ok(truncate_diff(bytes));
    }

    let unstaged = run_git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=3",
            "--",
            relative,
        ],
    )?;
    if let Some(bytes) = stdout_if_success(unstaged)? {
        return Ok(truncate_diff(bytes));
    }

    if let Some(synthetic) = synthetic_untracked_diff(root, relative)? {
        return Ok(synthetic);
    }

    Ok(String::new())
}

#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatus, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Git 项目目录不可用".to_string());
    }
    let output = run_git(root, &["status", "--porcelain=v1", "--branch", "-z"])?;
    if !output.status.success() {
        if is_not_repository_error(&output) {
            return Ok(GitStatus {
                is_repository: false,
                branch: None,
                changes: vec![],
            });
        }
        return Err(format!(
            "读取 Git 状态失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(parse_status(&output.stdout))
}

#[tauri::command]
pub fn git_diff(path: String, file: String) -> Result<String, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Git 项目目录不可用".to_string());
    }
    let relative = resolve_relative(root, &file)?;
    collect_file_diff(root, &relative)
}

#[derive(Debug, Serialize, Clone)]
pub struct GitFileContents {
    /// File content at HEAD (empty when untracked / no commits / missing).
    pub original: String,
    /// Working-tree content (empty when deleted or directory-only).
    pub modified: String,
}

fn git_show_revision(root: &Path, revision: &str, relative: &str) -> String {
    let spec = format!("{revision}:{relative}");
    match run_git(root, &["show", "--textconv", &spec]) {
        Ok(output) if output.status.success() => decode_git_text(&output.stdout),
        _ => String::new(),
    }
}

fn read_working_tree_text(root: &Path, relative: &str) -> String {
    let absolute = root.join(relative);
    if !absolute.is_file() {
        return String::new();
    }
    match std::fs::read(&absolute) {
        Ok(bytes) if bytes.len() <= MAX_DIFF_BYTES => decode_git_text(&bytes),
        Ok(_) => format!("… 文件过大，已跳过内容（最多 {MAX_DIFF_BYTES} bytes）\n"),
        Err(_) => String::new(),
    }
}

/// Pair of HEAD vs working-tree contents for the side-by-side editor diff.
#[tauri::command]
pub fn git_file_contents(path: String, file: String) -> Result<GitFileContents, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Git 项目目录不可用".to_string());
    }
    let relative = resolve_relative(root, &file)?;
    Ok(GitFileContents {
        original: git_show_revision(root, "HEAD", &relative),
        modified: read_working_tree_text(root, &relative),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_changed_files() {
        let status =
            parse_status(b"## feature/test...origin/feature/test\0 M src/main.ts\0?? notes.txt\0");
        assert_eq!(status.branch.as_deref(), Some("feature/test"));
        assert_eq!(status.changes.len(), 2);
        assert_eq!(status.changes[0].status, "M");
        assert_eq!(status.changes[1].path, "notes.txt");
    }

    #[test]
    fn parses_repository_without_commits() {
        let status = parse_status(b"## No commits yet on main\0?? README.md\0");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.changes[0].status, "??");
    }

    #[test]
    fn parses_rename_destination_path() {
        let status = parse_status(b"## main\0R  new.ts\0old.ts\0");
        assert_eq!(status.changes[0].path, "new.ts");
        assert_eq!(status.changes[0].status, "R");
    }

    #[test]
    fn keeps_chinese_and_space_paths_unquoted() {
        let status = parse_status("## main\0?? src/中文 文件.ts\0".as_bytes());
        assert_eq!(status.changes[0].path, "src/中文 文件.ts");
    }

    #[test]
    fn decodes_gbk_diff_content() {
        // "中文" in GBK
        assert_eq!(decode_git_text(&[0xD6, 0xD0, 0xCE, 0xC4]), "中文");
    }

    #[test]
    fn resolve_relative_rejects_parent_dir() {
        let root = Path::new(r#"D:\project"#);
        assert!(resolve_relative(root, "../outside.txt").is_err());
    }

    #[test]
    fn resolve_relative_normalizes_separators() {
        let root = Path::new(r#"D:\project"#);
        let relative = resolve_relative(root, r#"D:\project\src\App.tsx"#).unwrap();
        assert_eq!(relative, "src/App.tsx");
    }
}
