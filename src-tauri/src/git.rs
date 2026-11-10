use crate::file_encoding::{self, FileEncoding};
use crate::git_command;
use crate::path_guard::PathAllowlist;
use serde::Serialize;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use tauri::State;

mod sync_cache;

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
    /// Configured upstream short name (`origin/main`), when tracking is set.
    pub upstream: Option<String>,
    /// Commits on the remote not yet merged locally (`git status --branch`).
    pub behind: u32,
    /// Local commits not yet on the remote.
    pub ahead: u32,
    /// Last `git fetch` time (ms since epoch), from FETCH_HEAD mtime.
    pub last_fetch_at: Option<i64>,
    /// Last pull/merge from remote (ms since epoch), from HEAD reflog.
    pub last_pull_at: Option<i64>,
    /// Last push time (ms since epoch), from the upstream branch reflog when available.
    pub last_push_at: Option<i64>,
    pub changes: Vec<GitChange>,
}

fn run_git(root: &Path, args: &[&str]) -> Result<Output, String> {
    git_command::output(root, args).map_err(|error| format!("无法运行 Git：{error}"))
}

fn is_not_repository_error(output: &Output) -> bool {
    let message = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    message.contains("not a git repository") || message.contains("不是 git 仓库")
}

/// Parse `## branch...upstream [ahead N, behind M]` from porcelain `--branch`.
fn parse_branch_header(header: &str) -> (Option<String>, Option<String>, u32, u32) {
    let body = header
        .trim_start_matches("## ")
        .strip_prefix("No commits yet on ")
        .unwrap_or_else(|| header.trim_start_matches("## "))
        .trim();
    if body.is_empty() || body.starts_with("HEAD (no branch)") {
        return (None, None, 0, 0);
    }

    let tracking_start = body.find(" [").unwrap_or(body.len());
    let branch_part = body[..tracking_start].trim();
    let tracking = if tracking_start < body.len() {
        Some(&body[tracking_start..])
    } else {
        None
    };

    let mut branch_name: Option<String> = None;
    let mut upstream: Option<String> = None;
    if let Some((local, remote)) = branch_part.split_once("...") {
        let local = local.trim();
        let remote = remote.trim();
        if !local.is_empty() {
            branch_name = Some(local.to_string());
        }
        if !remote.is_empty() {
            upstream = Some(remote.to_string());
        }
    } else if !branch_part.is_empty() {
        branch_name = Some(branch_part.to_string());
    }

    let mut ahead = 0u32;
    let mut behind = 0u32;
    if let Some(tr) = tracking {
        let inner = tr
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim();
        for token in inner.split(',') {
            let token = token.trim();
            if let Some(rest) = token.strip_prefix("ahead ") {
                ahead = rest.trim().parse().unwrap_or(0);
            } else if let Some(rest) = token.strip_prefix("behind ") {
                behind = rest.trim().parse().unwrap_or(0);
            }
        }
    }

    (branch_name, upstream, ahead, behind)
}

fn resolve_git_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let output = run_git(root, &["rev-parse", "--git-path", relative]).ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(root.join(path))
    }
}

fn file_mtime_ms(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as i64)
}

fn read_last_fetch_at(root: &Path) -> Option<i64> {
    resolve_git_path(root, "FETCH_HEAD").and_then(|path| file_mtime_ms(&path))
}

/// reflog 里能认出「拉取」的动作 / 说明。
const PULL_REFLOG_NEEDLES: &[&str] = &["pull ", "pull:", "merge branch", "fast-forward"];
/// 远程跟踪分支 reflog 里推送留下的动作。
///
/// `git push` 不写 HEAD 的 reflog，只更新 `refs/remotes/<remote>/<branch>`，
/// 并记一条 `update by push`；所以推送时间要从上游分支的 reflog 里找。
const PUSH_REFLOG_NEEDLES: &[&str] = &["update by push"];

fn read_reflog_text(root: &Path, reference: Option<&str>) -> Option<String> {
    let mut args = vec!["reflog", "show", "--date=unix", "-n", "100"];
    if let Some(reference) = reference {
        args.push(reference);
    }
    let output = run_git(root, &args).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 在一份 reflog 输出里找第一条命中 `needles` 的时间戳（毫秒）。
///
/// 每条 reflog 形如 `<sha> <ref>@{<unix>}: <action>: <message>`，`<message>` 可以缺省
/// （`update by push` 就没有）。因此动作段和说明段都要看。
fn reflog_timestamp(text: &str, needles: &[&str]) -> Option<i64> {
    for line in text.lines() {
        let marker = "@{";
        let Some(marker_at) = line.find(marker) else {
            continue;
        };
        let rest = &line[marker_at + marker.len()..];
        let Some(end) = rest.find('}') else {
            continue;
        };
        let Some(ts_secs) = rest[..end].parse::<i64>().ok() else {
            continue;
        };
        let mut parts = line.splitn(3, ": ");
        parts.next();
        let action = parts.next().unwrap_or("").to_ascii_lowercase();
        let message = parts.next().unwrap_or("").to_ascii_lowercase();
        if needles
            .iter()
            .any(|needle| action.contains(needle) || message.contains(needle))
        {
            return Some(ts_secs.saturating_mul(1000));
        }
    }
    None
}

/// 同步时间：`FETCH_HEAD` 的 mtime + HEAD reflog（拉取）+ 上游分支 reflog（推送）。
fn read_sync_times(root: &Path, upstream: Option<&str>) -> (Option<i64>, Option<i64>, Option<i64>) {
    if let Some(times) = sync_cache::read(root, upstream) {
        return times;
    }
    let last_fetch_at = read_last_fetch_at(root);
    let last_pull_at = read_reflog_text(root, None)
        .as_deref()
        .and_then(|text| reflog_timestamp(text, PULL_REFLOG_NEEDLES));
    let last_push_at = upstream
        .filter(|name| !name.is_empty() && !name.starts_with('-'))
        .and_then(|name| read_reflog_text(root, Some(&format!("refs/remotes/{name}"))))
        .as_deref()
        .and_then(|text| reflog_timestamp(text, PUSH_REFLOG_NEEDLES));
    (last_fetch_at, last_pull_at, last_push_at)
}

/// Parse porcelain v1 `-z` records. NUL framing preserves Chinese, spaces and
/// rename paths exactly instead of relying on Git's display-oriented quoting.
fn parse_status(output: &[u8]) -> GitStatus {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut changes = vec![];
    let mut records = output.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.starts_with(b"## ") {
            let header = String::from_utf8_lossy(record);
            let parsed = parse_branch_header(&header);
            branch = parsed.0;
            upstream = parsed.1;
            ahead = parsed.2;
            behind = parsed.3;
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
        upstream,
        ahead,
        behind,
        last_fetch_at: None,
        last_pull_at: None,
        last_push_at: None,
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

fn is_unmerged_status(status: &str) -> bool {
    let bytes = status.as_bytes();
    if bytes.len() < 2 {
        return false;
    }
    let index = bytes[0];
    let worktree = bytes[1];
    index == b'U'
        || worktree == b'U'
        || (index == b'A' && worktree == b'A')
        || (index == b'D' && worktree == b'D')
}

fn delete_worktree_path(root: &Path, relative: &str) -> Result<(), String> {
    let path = root.join(relative);
    if !path.exists() {
        return Ok(());
    }
    // Belt-and-suspenders: resolved relatives never escape, but refuse if the
    // joined path somehow leaves the project root.
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let path_canon = path.canonicalize().unwrap_or_else(|_| path.clone());
    if !path_canon.starts_with(&root_canon) {
        return Err("仅允许丢弃当前项目内的 Git 文件".to_string());
    }
    if path_canon.is_dir() {
        std::fs::remove_dir_all(&path_canon).map_err(|error| format!("删除未跟踪目录失败：{error}"))
    } else {
        std::fs::remove_file(&path_canon).map_err(|error| format!("删除未跟踪文件失败：{error}"))
    }
}

fn status_map_for_files(
    status: &GitStatus,
    files: &[String],
) -> Result<Vec<(String, String)>, String> {
    let mut matched = Vec::with_capacity(files.len());
    for file in files {
        if let Some(change) = status.changes.iter().find(|change| change.path == *file) {
            if is_unmerged_status(&change.status) {
                return Err(format!("无法丢弃存在合并冲突的文件：{file}"));
            }
            matched.push((change.status.clone(), file.clone()));
        }
    }
    Ok(matched)
}

/// Discard unstaged worktree changes, or delete untracked paths.
fn discard_unstaged_files(root: &Path, files: &[String]) -> Result<(), String> {
    let status = collect_git_status(root)?;
    let matched = status_map_for_files(&status, files)?;
    let mut restore = Vec::new();
    let mut delete = Vec::new();
    for (change_status, file) in matched {
        if change_status == "??" || change_status == "!!" {
            delete.push(file);
            continue;
        }
        let worktree = change_status.as_bytes().get(1).copied().unwrap_or(b' ');
        if worktree != b' ' {
            restore.push(file);
        }
    }
    if !restore.is_empty() {
        let output = run_git_files(root, &["restore"], &restore)?;
        if !output.status.success() {
            // Older Git without `restore`: check out from the index.
            let checkout = run_git_files(root, &["checkout", "--"], &restore)?;
            ensure_git_success("丢弃工作区更改", checkout)?;
        }
    }
    for file in delete {
        delete_worktree_path(root, &file)?;
    }
    Ok(())
}

/// Discard staged changes by restoring index + worktree from HEAD (or deleting
/// on an unborn branch).
fn discard_staged_files(root: &Path, files: &[String]) -> Result<(), String> {
    let status = collect_git_status(root)?;
    let _matched = status_map_for_files(&status, files)?;
    if has_head(root)? {
        let restore = run_git_files(
            root,
            &["restore", "--source=HEAD", "--staged", "--worktree"],
            files,
        )?;
        if restore.status.success() {
            return Ok(());
        }
        let checkout = run_git_files(root, &["checkout", "HEAD", "--"], files)?;
        ensure_git_success("丢弃已暂存更改", checkout)?;
        return Ok(());
    }

    unstage_files(root, files)?;
    for file in files {
        delete_worktree_path(root, file)?;
    }
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

/// Update remote-tracking refs without changing the current branch or worktree.
fn fetch_remote(root: &Path) -> Result<String, String> {
    let output = run_git(root, &["fetch", "--prune"])?;
    let output = ensure_git_success("获取远程更新", output)?;
    let summary = git_output_text(&output);
    Ok(if summary.starts_with("Git 退出码") {
        "已获取远程更新".to_string()
    } else {
        summary
    })
}

fn list_unmerged_paths(root: &Path) -> Result<Vec<String>, String> {
    let output = run_git(root, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
    if !output.status.success() {
        return Ok(vec![]);
    }
    let mut paths = Vec::new();
    for record in output.stdout.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let path = String::from_utf8_lossy(record).into_owned();
        if !path.is_empty() {
            paths.push(path);
        }
    }
    Ok(paths)
}

#[derive(Debug, Serialize, Clone)]
pub struct GitPullResult {
    pub summary: String,
    pub has_conflicts: bool,
    pub conflict_paths: Vec<String>,
}

fn pull_current(root: &Path, rebase: bool) -> Result<GitPullResult, String> {
    let args: Vec<&str> = if rebase {
        vec!["pull", "--rebase"]
    } else {
        vec!["pull"]
    };
    let pull_output = run_git(root, &args)?;
    let conflict_paths = list_unmerged_paths(root)?;
    let has_conflicts = !conflict_paths.is_empty();

    if has_conflicts {
        let summary = if pull_output.status.success() {
            if conflict_paths.len() == 1 {
                format!("拉取完成，但存在未解决的合并冲突：{}", conflict_paths[0])
            } else {
                format!(
                    "拉取完成，但存在 {} 个未解决的合并冲突",
                    conflict_paths.len()
                )
            }
        } else {
            git_output_text(&pull_output)
        };
        return Ok(GitPullResult {
            summary,
            has_conflicts: true,
            conflict_paths,
        });
    }

    let output = ensure_git_success("Git 拉取", pull_output)?;
    let summary = git_output_text(&output);
    Ok(GitPullResult {
        summary: if summary.starts_with("Git 退出码") {
            "拉取成功".to_string()
        } else {
            summary
        },
        has_conflicts: false,
        conflict_paths: vec![],
    })
}

fn decode_git_text(bytes: &[u8]) -> String {
    file_encoding::decode(bytes, FileEncoding::Auto)
        .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned())
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
                upstream: None,
                ahead: 0,
                behind: 0,
                last_fetch_at: None,
                last_pull_at: None,
                last_push_at: None,
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

fn collect_git_status_with_sync(root: &Path) -> Result<GitStatus, String> {
    let mut status = collect_git_status(root)?;
    if status.is_repository {
        let (last_fetch_at, last_pull_at, last_push_at) =
            read_sync_times(root, status.upstream.as_deref());
        status.last_fetch_at = last_fetch_at;
        status.last_pull_at = last_pull_at;
        status.last_push_at = last_push_at;
    }
    Ok(status)
}

#[tauri::command]
pub async fn git_status(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<GitStatus, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || collect_git_status_with_sync(&root))
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

/// Discard selected changes. `staged=true` restores from HEAD (index+worktree);
/// otherwise discards worktree changes / deletes untracked files.
#[tauri::command]
pub async fn git_discard(
    path: String,
    files: Vec<String>,
    staged: bool,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    let files = resolve_files(&root, files)?;
    tauri::async_runtime::spawn_blocking(move || {
        if staged {
            discard_staged_files(&root, &files)
        } else {
            discard_unstaged_files(&root, &files)
        }
    })
    .await
    .map_err(|error| format!("丢弃 Git 更改失败：{error}"))?
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
pub async fn git_fetch(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || fetch_remote(&root))
        .await
        .map_err(|error| format!("获取远程更新失败：{error}"))?
}

#[tauri::command]
pub async fn git_pull(
    path: String,
    rebase: Option<bool>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<GitPullResult, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    let rebase = rebase.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || pull_current(&root, rebase))
        .await
        .map_err(|error| format!("Git 拉取失败：{error}"))?
}

#[derive(Debug, Serialize, Clone)]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitBranchList {
    pub local: Vec<GitBranchInfo>,
    pub remote: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct GitRemote {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_urls: Vec<String>,
}

/// Parse `git remote -v` output into remotes (supports multiple push URLs per name).
fn parse_remote_v(text: &str) -> Vec<GitRemote> {
    let mut order: Vec<String> = Vec::new();
    let mut by_name: std::collections::BTreeMap<String, GitRemote> =
        std::collections::BTreeMap::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((name, rest)) = line.split_once(['\t', ' ']) else {
            continue;
        };
        let name = name.trim();
        let rest = rest.trim();
        if name.is_empty() || rest.is_empty() {
            continue;
        }
        let (url, kind) = if let Some(idx) = rest.rfind(" (") {
            let url = rest[..idx].trim();
            let kind = rest[idx..].trim();
            (url, kind)
        } else {
            (rest, "")
        };
        if url.is_empty() {
            continue;
        }
        if !by_name.contains_key(name) {
            order.push(name.to_string());
            by_name.insert(
                name.to_string(),
                GitRemote {
                    name: name.to_string(),
                    fetch_url: None,
                    push_urls: Vec::new(),
                },
            );
        }
        let remote = by_name.get_mut(name).expect("remote just inserted");
        if kind.contains("fetch") {
            remote.fetch_url = Some(url.to_string());
        } else if kind.contains("push") {
            if !remote.push_urls.iter().any(|existing| existing == url) {
                remote.push_urls.push(url.to_string());
            }
        } else if remote.fetch_url.is_none() {
            remote.fetch_url = Some(url.to_string());
        }
    }

    order
        .into_iter()
        .filter_map(|name| by_name.remove(&name))
        .collect()
}

fn list_remotes(root: &Path) -> Result<Vec<GitRemote>, String> {
    let output = run_git(root, &["remote", "-v"])?;
    if !output.status.success() {
        return Err(format!("读取远程地址失败：{}", git_output_text(&output)));
    }
    Ok(parse_remote_v(&decode_git_text(&output.stdout)))
}

#[derive(Debug, Serialize, Clone)]
pub struct GitCommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    /// Branch / tag decorations from `git log --format=%D` (may be empty).
    pub refs: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct GitCommitFileChange {
    /// Single-letter status: A / M / D / R / C / T …
    pub status: String,
    pub path: String,
    /// Present for renames/copies (destination is `path`).
    pub previous_path: Option<String>,
}

fn validate_local_branch_name(branch: &str) -> Result<&str, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    if branch.starts_with('-')
        || branch.contains("..")
        || branch.contains('\\')
        || branch.contains('\0')
        || branch.contains(' ')
    {
        return Err("无效的分支名".to_string());
    }
    // Reject remote-style refs (origin/main) while still allowing local feature/foo.
    if branch.starts_with("refs/") || branch.starts_with("remotes/") {
        return Err("无效的分支名".to_string());
    }
    Ok(branch)
}

/// Include the full ref for classification; preserve Git's short-name disambiguation.
pub(crate) const BRANCH_LIST_FORMAT: &str =
    "--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)";
pub(crate) const BRANCH_LIST_SORT: &str = "--sort=-committerdate";

pub(crate) fn parse_branch_list(text: &str) -> GitBranchList {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(4, '\t');
        let reference = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").trim();
        let head = parts.next().unwrap_or("");
        let upstream = parts.next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        if reference.starts_with("refs/heads/") {
            local.push(GitBranchInfo {
                name: name.to_string(),
                current: head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            });
        } else if reference.starts_with("refs/remotes/") && !name.ends_with("/HEAD") {
            remote.push(name.to_string());
        }
    }
    GitBranchList { local, remote }
}

fn list_branches(root: &Path) -> Result<GitBranchList, String> {
    let mut output = run_git(
        root,
        &[
            "for-each-ref",
            BRANCH_LIST_FORMAT,
            BRANCH_LIST_SORT,
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    if !output.status.success() {
        // Retain local branches if only remote-ref enumeration is broken.
        output = run_git(
            root,
            &[
                "for-each-ref",
                BRANCH_LIST_FORMAT,
                BRANCH_LIST_SORT,
                "refs/heads",
            ],
        )?;
        if !output.status.success() {
            return Err(format!("读取本地分支失败：{}", git_output_text(&output)));
        }
    }
    Ok(parse_branch_list(&decode_git_text(&output.stdout)))
}

fn switch_branch(root: &Path, branch: &str) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    if branch.starts_with("refs/") || branch.starts_with("remotes/") {
        return Err("无效的分支名".to_string());
    }

    let remote_ref = format!("refs/remotes/{branch}");
    let local_ref = format!("refs/heads/{branch}");
    let has_remote = run_git(root, &["rev-parse", "--verify", &remote_ref])?
        .status
        .success();
    let has_local = run_git(root, &["rev-parse", "--verify", &local_ref])?
        .status
        .success();

    if has_remote && !has_local {
        let output = run_git(root, &["switch", "--track", branch])?;
        ensure_git_success("切换 Git 分支", output)?;
        return Ok(());
    }

    let branch = validate_local_branch_name(branch)?;
    let output = run_git(root, &["switch", branch])?;
    ensure_git_success("切换 Git 分支", output)?;
    Ok(())
}

fn list_commits(root: &Path, limit: usize, skip: usize) -> Result<Vec<GitCommitInfo>, String> {
    let limit = limit.clamp(1, 100);
    let skip = skip.min(100_000);
    let fetch = limit.saturating_add(skip).min(100_000);
    let limit_arg = format!("-n{fetch}");
    let format_arg = "--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%D";
    let output = run_git(root, &["log", &limit_arg, format_arg])?;
    if !output.status.success() {
        let message = git_output_text(&output).to_ascii_lowercase();
        if message.contains("bad revision")
            || message.contains("unknown revision")
            || message.contains("does not have any commits")
            || message.contains("你的当前分支尚无任何提交")
            || message.contains("does not have any commits yet")
        {
            return Ok(vec![]);
        }
        // Unborn / empty repo often fails with "fatal: your current branch ... does not have any commits yet"
        if !has_head(root)? {
            return Ok(vec![]);
        }
        return Err(format!("读取提交记录失败：{}", git_output_text(&output)));
    }

    let mut commits = Vec::new();
    let raw = decode_git_text(&output.stdout);
    // Format: hash\0short\0subject\0author\date\0refs\n
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 5 {
            continue;
        }
        commits.push(GitCommitInfo {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            date: parts[4].trim().to_string(),
            refs: parts
                .get(5)
                .map(|s| s.trim().to_string())
                .unwrap_or_default(),
        });
    }
    if skip >= commits.len() {
        return Ok(vec![]);
    }
    Ok(commits.into_iter().skip(skip).take(limit).collect())
}

#[tauri::command]
pub async fn git_branch_list(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<GitBranchList, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || list_branches(&root))
        .await
        .map_err(|error| format!("读取分支列表失败：{error}"))?
}

#[tauri::command]
pub async fn git_remotes(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<Vec<GitRemote>, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || list_remotes(&root))
        .await
        .map_err(|error| format!("读取远程地址失败：{error}"))?
}

#[tauri::command]
pub async fn git_switch(
    path: String,
    branch: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || switch_branch(&root, &branch))
        .await
        .map_err(|error| format!("切换 Git 分支失败：{error}"))?
}

#[tauri::command]
pub async fn git_log(
    path: String,
    limit: Option<u32>,
    skip: Option<u32>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<Vec<GitCommitInfo>, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    let limit = limit.unwrap_or(40) as usize;
    let skip = skip.unwrap_or(0) as usize;
    tauri::async_runtime::spawn_blocking(move || list_commits(&root, limit, skip))
        .await
        .map_err(|error| format!("读取提交记录失败：{error}"))?
}

pub(crate) fn validate_commit_rev(rev: &str) -> Result<&str, String> {
    let rev = rev.trim();
    if rev.is_empty() || rev.len() > 64 || !rev.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("无效的提交哈希".to_string());
    }
    Ok(rev)
}

fn list_commit_files(root: &Path, rev: &str) -> Result<Vec<GitCommitFileChange>, String> {
    let rev = validate_commit_rev(rev)?;
    let output = run_git(
        root,
        &[
            "show",
            "--name-status",
            "--pretty=format:",
            "--no-renames",
            rev,
        ],
    )?;
    if !output.status.success() {
        return Err(format!("读取提交文件失败：{}", git_output_text(&output)));
    }

    let mut files = Vec::new();
    for line in decode_git_text(&output.stdout).lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, '\t');
        let status_raw = parts.next().unwrap_or("").trim();
        let path = parts.next().unwrap_or("").trim();
        if status_raw.is_empty() || path.is_empty() {
            continue;
        }
        let status = status_raw
            .chars()
            .next()
            .map(|c| c.to_string())
            .unwrap_or_else(|| status_raw.to_string());
        files.push(GitCommitFileChange {
            status,
            path: path.replace('\\', "/"),
            previous_path: None,
        });
    }
    Ok(files)
}

fn commit_file_contents(root: &Path, rev: &str, file: &str) -> Result<GitFileContents, String> {
    let rev = validate_commit_rev(rev)?;
    let relative = resolve_relative(root, file)?;
    let parent = format!("{rev}^");
    let original = git_show_revision(root, &parent, &relative);
    let modified = git_show_revision(root, rev, &relative);
    Ok(GitFileContents { original, modified })
}

#[tauri::command]
pub async fn git_commit_files(
    path: String,
    rev: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<Vec<GitCommitFileChange>, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || list_commit_files(&root, &rev))
        .await
        .map_err(|error| format!("读取提交文件失败：{error}"))?
}

#[tauri::command]
pub async fn git_commit_file_contents(
    path: String,
    rev: String,
    file: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<GitFileContents, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || commit_file_contents(&root, &rev, &file))
        .await
        .map_err(|error| format!("读取提交文件内容失败：{error}"))?
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
pub async fn git_file_contents(
    path: String,
    file: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<GitFileContents, String> {
    ensure_git_root(&path, &allowlist)?;
    let root = PathBuf::from(path);
    let relative = resolve_relative(&root, &file)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(GitFileContents {
            original: git_show_revision(&root, "HEAD", &relative),
            modified: read_working_tree_text(&root, &relative),
        })
    })
    .await
    .map_err(|error| format!("读取 Git 文件内容任务失败：{error}"))?
}

#[cfg(test)]
mod tests;
