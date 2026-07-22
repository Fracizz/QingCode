use crate::file_encoding::{self, FileEncoding};
use crate::path_guard::PathAllowlist;
use serde::Serialize;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use tauri::State;

/// Reject paths outside the registered project / authorized sandbox before any Git I/O.
fn ensure_git_root(path: &str, allowlist: &PathAllowlist) -> Result<(), String> {
    allowlist.ensure_allowed(path)?;
    if !Path::new(path).is_dir() {
        return Err("Git 项目目录不可用".to_string());
    }
    Ok(())
}

const MAX_DIFF_BYTES: usize = 1_000_000;

#[derive(Debug, Serialize, Clone)]
pub struct GitChange {
    pub path: String,
    /// Full two-character porcelain XY status (`M `, ` M`, `MM`, `??`, …).
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
    command
        .current_dir(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
        let status = String::from_utf8_lossy(&record[..2]).into_owned();
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if status.trim().is_empty() || path.is_empty() {
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
    if file.trim().is_empty() {
        return Err("Git 文件路径不能为空".to_string());
    }
    let file_path = Path::new(file);
    let relative: PathBuf = if file_path.is_absolute() {
        file_path
            .strip_prefix(root)
            .map_err(|_| "仅允许操作当前项目内的 Git 文件".to_string())?
            .to_path_buf()
    } else {
        file_path.to_path_buf()
    };
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("仅允许操作当前项目内的 Git 文件".to_string());
    }
    // Git accepts forward slashes on Windows and matches porcelain paths.
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn resolve_files(root: &Path, files: Vec<String>) -> Result<Vec<String>, String> {
    if files.is_empty() {
        return Err("至少选择一个 Git 文件".to_string());
    }
    let mut resolved = Vec::with_capacity(files.len());
    for file in files {
        let relative = resolve_relative(root, &file)?;
        if !resolved.contains(&relative) {
            resolved.push(relative);
        }
    }
    Ok(resolved)
}

fn run_git_files(root: &Path, prefix: &[&str], files: &[String]) -> Result<Output, String> {
    let mut args = Vec::with_capacity(prefix.len() + files.len() + 1);
    args.extend_from_slice(prefix);
    args.push("--");
    args.extend(files.iter().map(String::as_str));
    run_git(root, &args)
}

fn git_output_text(output: &Output) -> String {
    let stdout = decode_git_text(&output.stdout).trim().to_string();
    let stderr = decode_git_text(&output.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stderr}\n{stdout}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => format!("Git 退出码 {}", output.status),
    }
}

fn ensure_git_success(action: &str, output: Output) -> Result<Output, String> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(format!("{action}失败：{}", git_output_text(&output)))
    }
}

fn has_head(root: &Path) -> Result<bool, String> {
    let output = run_git(root, &["rev-parse", "--verify", "HEAD"])?;
    Ok(output.status.success())
}

fn stage_all(root: &Path) -> Result<(), String> {
    let output = run_git(root, &["add", "-A"])?;
    ensure_git_success("暂存 Git 文件", output)?;
    Ok(())
}

fn stage_files(root: &Path, files: &[String]) -> Result<(), String> {
    let output = run_git_files(root, &["add"], files)?;
    ensure_git_success("暂存 Git 文件", output)?;
    Ok(())
}

fn unstage_all(root: &Path) -> Result<(), String> {
    if has_head(root)? {
        let restore = run_git(root, &["restore", "--staged", "."])?;
        if restore.status.success() {
            return Ok(());
        }
        let reset = run_git(root, &["reset", "HEAD", "--"])?;
        ensure_git_success("取消暂存 Git 文件", reset)?;
        return Ok(());
    }

    let output = run_git(
        root,
        &["rm", "--cached", "-r", "-f", "--ignore-unmatch", "."],
    )?;
    ensure_git_success("取消暂存 Git 文件", output)?;
    Ok(())
}

fn unstage_files(root: &Path, files: &[String]) -> Result<(), String> {
    if has_head(root)? {
        let restore = run_git_files(root, &["restore", "--staged"], files)?;
        if restore.status.success() {
            return Ok(());
        }
        // Compatibility with older Git versions that predate `git restore`.
        let reset = run_git_files(root, &["reset"], files)?;
        ensure_git_success("取消暂存 Git 文件", reset)?;
        return Ok(());
    }

    // An unborn branch has no HEAD to restore from. Removing entries from the
    // index keeps the worktree untouched and turns them back into untracked files.
    let output = run_git_files(
        root,
        &["rm", "--cached", "-r", "-f", "--ignore-unmatch"],
        files,
    )?;
    ensure_git_success("取消暂存 Git 文件", output)?;
    Ok(())
}

fn commit_staged(root: &Path, message: &str) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".to_string());
    }

    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(["commit", "--file=-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法运行 Git：{error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法向 Git 提交命令写入提交信息".to_string())?;
    stdin
        .write_all(message.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .map_err(|error| format!("写入 Git 提交信息失败：{error}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 Git 提交完成失败：{error}"))?;
    let output = ensure_git_success("Git 提交", output)?;
    let summary = git_output_text(&output);
    Ok(if summary.starts_with("Git 退出码") {
        "提交成功".to_string()
    } else {
        summary
    })
}

fn push_current(root: &Path) -> Result<String, String> {
    let output = run_git(root, &["push"])?;
    let output = ensure_git_success("Git 推送", output)?;
    let summary = git_output_text(&output);
    Ok(if summary.starts_with("Git 退出码") {
        "推送成功".to_string()
    } else {
        summary
    })
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

fn collect_git_status(root: &Path) -> Result<GitStatus, String> {
    let output = run_git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "-z",
            // Match VS Code SCM: expand untracked directories to file paths.
            "--untracked-files=all",
            "--ignore-submodules=dirty",
        ],
    )?;
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
pub async fn git_status(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<GitStatus, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || collect_git_status(&root))
        .await
        .map_err(|error| format!("读取 Git 状态失败：{error}"))?
}

#[tauri::command]
pub async fn git_stage(
    path: String,
    files: Vec<String>,
    all: Option<bool>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    if all.unwrap_or(false) {
        return tauri::async_runtime::spawn_blocking(move || stage_all(&root))
            .await
            .map_err(|error| format!("暂存 Git 文件失败：{error}"))?;
    }
    let files = resolve_files(&root, files)?;
    tauri::async_runtime::spawn_blocking(move || stage_files(&root, &files))
        .await
        .map_err(|error| format!("暂存 Git 文件失败：{error}"))?
}

#[tauri::command]
pub async fn git_unstage(
    path: String,
    files: Vec<String>,
    all: Option<bool>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    if all.unwrap_or(false) {
        return tauri::async_runtime::spawn_blocking(move || unstage_all(&root))
            .await
            .map_err(|error| format!("取消暂存 Git 文件失败：{error}"))?;
    }
    let files = resolve_files(&root, files)?;
    tauri::async_runtime::spawn_blocking(move || unstage_files(&root, &files))
        .await
        .map_err(|error| format!("取消暂存 Git 文件失败：{error}"))?
}

#[tauri::command]
pub async fn git_commit(
    path: String,
    message: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    ensure_git_root(&path, &allowlist)?;
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || commit_staged(&root, &message))
        .await
        .map_err(|error| format!("Git 提交失败：{error}"))?
}

#[tauri::command]
pub async fn git_push(path: String, allowlist: State<'_, PathAllowlist>) -> Result<String, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || push_current(&root))
        .await
        .map_err(|error| format!("Git 推送失败：{error}"))?
}

#[tauri::command]
pub fn git_diff(
    path: String,
    file: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = Path::new(&path);
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
pub fn git_file_contents(
    path: String,
    file: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<GitFileContents, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = Path::new(&path);
    let relative = resolve_relative(root, &file)?;
    Ok(GitFileContents {
        original: git_show_revision(root, "HEAD", &relative),
        modified: read_working_tree_text(root, &relative),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_base(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("qingcode-git-{label}-{nonce}"))
    }

    fn git_success(root: &Path, args: &[&str]) {
        let output = run_git(root, args).expect("run git");
        assert!(output.status.success(), "{}", git_output_text(&output));
    }

    fn init_test_repo(label: &str) -> PathBuf {
        let root = temp_base(label);
        fs::create_dir_all(&root).unwrap();
        git_success(&root, &["init"]);
        git_success(&root, &["config", "user.email", "test@qingcode.local"]);
        git_success(&root, &["config", "user.name", "QingCode Test"]);
        root
    }

    #[test]
    fn ensure_git_root_rejects_path_outside_allowlist() {
        let base = temp_base("outside");
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let allowlist = PathAllowlist::new();
        allowlist.sync_project_roots(vec![project.to_string_lossy().into_owned()]);
        let err = ensure_git_root(&outside.to_string_lossy(), &allowlist).unwrap_err();
        assert!(err.contains("未经授权") || err.contains("不在"), "{err}");

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn ensure_git_root_allows_registered_project() {
        let base = temp_base("under");
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();

        let allowlist = PathAllowlist::new();
        allowlist.sync_project_roots(vec![project.to_string_lossy().into_owned()]);
        assert!(ensure_git_root(&project.to_string_lossy(), &allowlist).is_ok());

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn parses_branch_and_changed_files() {
        let status =
            parse_status(b"## feature/test...origin/feature/test\0 M src/main.ts\0?? notes.txt\0");
        assert_eq!(status.branch.as_deref(), Some("feature/test"));
        assert_eq!(status.changes.len(), 2);
        assert_eq!(status.changes[0].status, " M");
        assert_eq!(status.changes[1].path, "notes.txt");
    }

    #[test]
    fn parses_expanded_untracked_nested_files() {
        // Output shape from `git status -z --untracked-files=all`.
        let status = parse_status(b"## main\0?? .qingcode/run.json\0?? nested/a.txt\0");
        assert_eq!(status.changes.len(), 2);
        assert_eq!(status.changes[0].path, ".qingcode/run.json");
        assert_eq!(status.changes[0].status, "??");
        assert_eq!(status.changes[1].path, "nested/a.txt");
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
        assert_eq!(status.changes[0].status, "R ");
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

    #[test]
    fn stages_and_unstages_tracked_deleted_and_special_paths() {
        let root = init_test_repo("stage-unstage");
        fs::write(root.join("tracked.txt"), "v1\n").unwrap();
        fs::write(root.join("deleted.txt"), "delete me\n").unwrap();
        stage_files(&root, &["tracked.txt".into(), "deleted.txt".into()]).unwrap();
        commit_staged(&root, "initial").unwrap();

        fs::write(root.join("tracked.txt"), "v2\n").unwrap();
        fs::remove_file(root.join("deleted.txt")).unwrap();
        fs::write(root.join("中文 文件.txt"), "hello\n").unwrap();
        fs::write(root.join("-draft.txt"), "draft\n").unwrap();
        let files = vec![
            "tracked.txt".into(),
            "deleted.txt".into(),
            "中文 文件.txt".into(),
            "-draft.txt".into(),
        ];
        stage_files(&root, &files).unwrap();

        let staged = collect_git_status(&root).unwrap();
        assert!(staged.changes.iter().all(|change| {
            change.status == "M " || change.status == "D " || change.status == "A "
        }));

        unstage_files(&root, &files).unwrap();
        let unstaged = collect_git_status(&root).unwrap();
        assert!(unstaged
            .changes
            .iter()
            .any(|change| change.path == "tracked.txt" && change.status == " M"));
        assert!(unstaged
            .changes
            .iter()
            .any(|change| change.path == "deleted.txt" && change.status == " D"));
        assert!(unstaged
            .changes
            .iter()
            .any(|change| change.path == "中文 文件.txt" && change.status == "??"));
        assert!(unstaged
            .changes
            .iter()
            .any(|change| change.path == "-draft.txt" && change.status == "??"));
        assert!(root.join("中文 文件.txt").is_file());
        assert!(root.join("-draft.txt").is_file());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unborn_repo_can_unstage_without_changing_worktree() {
        let root = init_test_repo("unborn-unstage");
        fs::write(root.join("README.md"), "hello\n").unwrap();
        let files = vec!["README.md".into()];
        stage_files(&root, &files).unwrap();
        assert!(collect_git_status(&root)
            .unwrap()
            .changes
            .iter()
            .any(|change| change.status == "A "));

        unstage_files(&root, &files).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "hello\n"
        );
        assert!(collect_git_status(&root)
            .unwrap()
            .changes
            .iter()
            .any(|change| change.status == "??"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stage_all_and_unstage_all_cover_bulk_scm_actions() {
        let root = init_test_repo("bulk-all");
        fs::write(root.join("a.txt"), "a\n").unwrap();
        fs::write(root.join("b.txt"), "b\n").unwrap();
        stage_all(&root).unwrap();
        let staged = collect_git_status(&root).unwrap();
        assert!(staged
            .changes
            .iter()
            .all(|change| change.status.ends_with(' ')));
        unstage_all(&root).unwrap();
        let unstaged = collect_git_status(&root).unwrap();
        assert_eq!(unstaged.changes.len(), 2);
        assert!(unstaged
            .changes
            .iter()
            .all(|change| change.status == "??"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commit_includes_only_staged_version() {
        let root = init_test_repo("commit-staged");
        fs::write(root.join("a.txt"), "a1\n").unwrap();
        fs::write(root.join("b.txt"), "b1\n").unwrap();
        stage_files(&root, &["a.txt".into(), "b.txt".into()]).unwrap();
        commit_staged(&root, "initial").unwrap();

        fs::write(root.join("a.txt"), "a2 staged\n").unwrap();
        fs::write(root.join("b.txt"), "b2 unstaged\n").unwrap();
        stage_files(&root, &["a.txt".into()]).unwrap();
        commit_staged(&root, "only a").unwrap();

        assert_eq!(git_show_revision(&root, "HEAD", "a.txt"), "a2 staged\n");
        assert_eq!(git_show_revision(&root, "HEAD", "b.txt"), "b1\n");
        let status = collect_git_status(&root).unwrap();
        assert!(status
            .changes
            .iter()
            .any(|change| change.path == "b.txt" && change.status == " M"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_empty_commit_message_and_unsafe_file_lists() {
        let root = init_test_repo("reject-input");
        assert_eq!(commit_staged(&root, "   ").unwrap_err(), "提交信息不能为空");
        assert!(resolve_files(&root, vec![]).is_err());
        assert!(resolve_files(&root, vec!["../outside.txt".into()]).is_err());
        assert!(resolve_files(&root, vec!["".into()]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pushes_current_branch_to_configured_upstream() {
        let root = init_test_repo("push-current");
        let remote = temp_base("push-remote");
        fs::create_dir_all(&remote).unwrap();
        git_success(&remote, &["init", "--bare"]);

        fs::write(root.join("README.md"), "v1\n").unwrap();
        stage_files(&root, &["README.md".into()]).unwrap();
        commit_staged(&root, "initial").unwrap();
        let remote_path = remote.to_string_lossy().to_string();
        git_success(&root, &["remote", "add", "origin", &remote_path]);
        let branch_output = run_git(&root, &["branch", "--show-current"]).unwrap();
        let branch = decode_git_text(&branch_output.stdout).trim().to_string();
        assert!(!branch.is_empty());
        git_success(&root, &["push", "--set-upstream", "origin", &branch]);

        fs::write(root.join("README.md"), "v2\n").unwrap();
        stage_files(&root, &["README.md".into()]).unwrap();
        commit_staged(&root, "update").unwrap();
        push_current(&root).unwrap();

        let local_head = run_git(&root, &["rev-parse", "HEAD"]).unwrap();
        let remote_ref = format!("refs/heads/{branch}");
        let remote_head = run_git(&root, &["ls-remote", "origin", &remote_ref]).unwrap();
        let local_sha = decode_git_text(&local_head.stdout).trim().to_string();
        let remote_sha = decode_git_text(&remote_head.stdout)
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        assert_eq!(remote_sha, local_sha);

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(remote).unwrap();
    }

    #[test]
    fn push_without_remote_returns_git_error() {
        let root = init_test_repo("push-no-remote");
        fs::write(root.join("README.md"), "local only\n").unwrap();
        stage_files(&root, &["README.md".into()]).unwrap();
        commit_staged(&root, "initial").unwrap();

        let error = push_current(&root).unwrap_err();
        assert!(error.starts_with("Git 推送失败："), "{error}");

        fs::remove_dir_all(root).unwrap();
    }
}
