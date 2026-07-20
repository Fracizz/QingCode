use crate::path_guard::PathAllowlist;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::State;

/// Current Git HEAD for status-bar display.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitHeadInfo {
    /// Branch name, or abbreviated SHA when detached.
    pub name: String,
    pub detached: bool,
}

/// One changed path from `git status --porcelain`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitStatusEntry {
    /// Absolute path (OS native separators).
    pub path: String,
    /// Short UI code: `M`, `A`, `D`, `??`, `MM`, `R`, …
    pub status: String,
}

/// Worktree dirty snapshot for the explorer / tabs.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitWorkdirStatus {
    pub entries: Vec<GitStatusEntry>,
    pub dirty_count: usize,
}

/// Resolve the Git directory for `start` or any ancestor (supports worktrees).
fn find_git_dir(start: &Path) -> Option<PathBuf> {
    find_git_workdir_and_dir(start).map(|(_, git_dir)| git_dir)
}

/// Resolve the worktree root (directory containing `.git`) and the git dir.
fn find_git_workdir_and_dir(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut current = if start.is_dir() {
        start.to_path_buf()
    } else {
        start.parent()?.to_path_buf()
    };

    loop {
        let git = current.join(".git");
        if git.is_dir() {
            return Some((current, git));
        }
        if git.is_file() {
            if let Some(dir) = resolve_gitdir_file(&git, &current) {
                return Some((current, dir));
            }
        }
        if !current.pop() {
            return None;
        }
    }
}

fn find_git_workdir(start: &Path) -> Option<PathBuf> {
    find_git_workdir_and_dir(start).map(|(workdir, _)| workdir)
}

fn resolve_gitdir_file(git_file: &Path, worktree: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(git_file).ok()?;
    let dir = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:").map(str::trim))?;
    let path = {
        let candidate = Path::new(dir);
        if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            worktree.join(candidate)
        }
    };
    path.is_dir().then_some(path)
}

fn abbreviate_sha(sha: &str) -> String {
    let trimmed = sha.trim();
    if trimmed.len() > 7 {
        trimmed[..7].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Read branch / detached HEAD from `.git/HEAD` under `path` (walks parents).
pub fn read_git_head(path: &Path) -> Option<GitHeadInfo> {
    let git_dir = find_git_dir(path)?;
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if head.is_empty() {
        return None;
    }

    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        let name = reference
            .strip_prefix("refs/heads/")
            .unwrap_or(reference)
            .to_string();
        if name.is_empty() {
            return None;
        }
        return Some(GitHeadInfo {
            name,
            detached: false,
        });
    }

    // Detached HEAD stores a raw object id.
    if head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(GitHeadInfo {
            name: abbreviate_sha(head),
            detached: true,
        });
    }

    None
}

#[tauri::command]
pub fn get_git_head(path: String, allowlist: State<'_, PathAllowlist>) -> Option<GitHeadInfo> {
    if path.trim().is_empty() {
        return None;
    }
    if allowlist.ensure_allowed(&path).is_err() {
        return None;
    }
    read_git_head(Path::new(&path))
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Run `git` in `workdir`. Returns stdout on success; `None` when git is missing / not a repo.
fn run_git(workdir: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.current_dir(workdir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);
    cmd.output().ok()
}

/// Map porcelain `XY` to a short UI status code.
pub fn porcelain_xy_to_status(xy: &str) -> String {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or(' ');
    let y = chars.next().unwrap_or(' ');
    if x == '?' && y == '?' {
        return "??".into();
    }
    if x == '!' && y == '!' {
        return "!!".into();
    }
    if x != ' ' && y != ' ' {
        if x == y {
            return x.to_string();
        }
        return format!("{x}{y}");
    }
    if y != ' ' {
        return y.to_string();
    }
    if x != ' ' {
        return x.to_string();
    }
    xy.trim().to_string()
}

/// Parse one `git status --porcelain` line into (relative path, status).
/// Supports rename/copy lines (`old -> new`).
pub fn parse_porcelain_line(line: &str) -> Option<(String, String)> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.len() < 3 {
        return None;
    }
    let xy = &line[..2];
    let rest = line[2..].trim_start();
    if rest.is_empty() {
        return None;
    }

    let path = if let Some((_old, new_path)) = rest.split_once(" -> ") {
        new_path.trim()
    } else {
        // Quoted paths from git: "path with spaces"
        let trimmed = rest.trim();
        if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
            &trimmed[1..trimmed.len() - 1]
        } else {
            trimmed
        }
    };

    if path.is_empty() {
        return None;
    }

    Some((path.replace('\\', "/"), porcelain_xy_to_status(xy)))
}

fn absolute_from_workdir(workdir: &Path, rel: &str) -> PathBuf {
    let mut abs = workdir.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        abs.push(part);
    }
    abs
}

/// Collect dirty paths via `git status --porcelain` (CLI only; no libgit2).
pub fn read_git_workdir_status(path: &Path) -> Option<GitWorkdirStatus> {
    let workdir = find_git_workdir(path)?;
    let output = run_git(
        &workdir,
        &[
            "status",
            "--porcelain",
            // Match VS Code SCM: list files inside untracked dirs (`-uall`), not just the dir.
            "--untracked-files=all",
            "--ignore-submodules=dirty",
        ],
    )?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((rel, status)) = parse_porcelain_line(line) else {
            continue;
        };
        let abs = absolute_from_workdir(&workdir, &rel);
        entries.push(GitStatusEntry {
            path: abs.to_string_lossy().to_string(),
            status,
        });
    }
    let dirty_count = entries.len();
    Some(GitWorkdirStatus {
        entries,
        dirty_count,
    })
}

#[tauri::command]
pub async fn get_git_workdir_status(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<Option<GitWorkdirStatus>, String> {
    if path.trim().is_empty() {
        return Ok(None);
    }
    if allowlist.ensure_allowed(&path).is_err() {
        return Ok(None);
    }
    let root = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || read_git_workdir_status(&root))
        .await
        .map_err(|error| format!("读取 Git 状态失败：{error}"))
}

/// Read file contents at `HEAD:path` via `git show`. `None` when the path is not in HEAD
/// (e.g. untracked) or git/repo is unavailable.
pub fn read_git_show_head(path: &Path) -> Option<String> {
    let workdir = find_git_workdir(path)?;
    let rel = path.strip_prefix(&workdir).ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if rel_str.is_empty() {
        return None;
    }
    let spec = format!("HEAD:{rel_str}");
    let output = run_git(&workdir, &["show", &spec])?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[tauri::command]
pub fn git_show_head_file(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<Option<String>, String> {
    if path.trim().is_empty() {
        return Ok(None);
    }
    allowlist.ensure_allowed(&path)?;
    Ok(read_git_show_head(Path::new(&path)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-git-{label}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_git_head_returns_branch_name() {
        let root = temp_dir("branch");
        let git = root.join(".git");
        fs::create_dir_all(git.join("refs/heads")).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/feature/foo\n").unwrap();

        let info = read_git_head(&root).expect("branch head");
        assert_eq!(
            info,
            GitHeadInfo {
                name: "feature/foo".into(),
                detached: false,
            }
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_git_head_handles_detached_sha() {
        let root = temp_dir("detached");
        let git = root.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(
            git.join("HEAD"),
            "abcdef1234567890abcdef1234567890abcdef12\n",
        )
        .unwrap();

        let info = read_git_head(&root).expect("detached head");
        assert_eq!(
            info,
            GitHeadInfo {
                name: "abcdef1".into(),
                detached: true,
            }
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_git_head_walks_parents_and_worktree_file() {
        let root = temp_dir("worktree");
        let real_git = root.join("real-git");
        fs::create_dir_all(&real_git).unwrap();
        fs::write(real_git.join("HEAD"), "ref: refs/heads/master\n").unwrap();

        let nested = root.join("src").join("app");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            root.join(".git"),
            format!("gitdir: {}\n", real_git.display()),
        )
        .unwrap();

        let info = read_git_head(&nested).expect("worktree head");
        assert_eq!(info.name, "master");
        assert!(!info.detached);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_git_head_returns_none_outside_repo() {
        let root = temp_dir("norepo");
        assert!(read_git_head(&root).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parse_porcelain_modified_and_untracked() {
        assert_eq!(
            parse_porcelain_line(" M src/main.rs"),
            Some(("src/main.rs".into(), "M".into()))
        );
        assert_eq!(
            parse_porcelain_line("?? new file.txt"),
            Some(("new file.txt".into(), "??".into()))
        );
        assert_eq!(
            parse_porcelain_line("A  staged.ts"),
            Some(("staged.ts".into(), "A".into()))
        );
        assert_eq!(
            parse_porcelain_line("D  gone.rs"),
            Some(("gone.rs".into(), "D".into()))
        );
        assert_eq!(
            parse_porcelain_line("MM both.rs"),
            Some(("both.rs".into(), "M".into()))
        );
        assert_eq!(
            parse_porcelain_line("AM added-then-mod.ts"),
            Some(("added-then-mod.ts".into(), "AM".into()))
        );
    }

    #[test]
    fn parse_porcelain_rename() {
        assert_eq!(
            parse_porcelain_line("R  old.rs -> new.rs"),
            Some(("new.rs".into(), "R".into()))
        );
    }

    #[test]
    fn porcelain_xy_to_status_variants() {
        assert_eq!(porcelain_xy_to_status("??"), "??");
        assert_eq!(porcelain_xy_to_status(" M"), "M");
        assert_eq!(porcelain_xy_to_status("M "), "M");
        assert_eq!(porcelain_xy_to_status("MD"), "MD");
    }

    #[test]
    fn read_git_workdir_status_via_cli_when_git_available() {
        let root = temp_dir("porcelain-cli");
        let init = Command::new("git")
            .current_dir(&root)
            .args(["init"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let Ok(init) = init else {
            fs::remove_dir_all(&root).ok();
            return;
        };
        if !init.status.success() {
            fs::remove_dir_all(&root).ok();
            return;
        }
        let _ = Command::new("git")
            .current_dir(&root)
            .args(["config", "user.email", "test@qingcode.local"])
            .output();
        let _ = Command::new("git")
            .current_dir(&root)
            .args(["config", "user.name", "QingCode Test"])
            .output();

        fs::write(root.join("tracked.txt"), "v1\n").unwrap();
        let add = Command::new("git")
            .current_dir(&root)
            .args(["add", "tracked.txt"])
            .output()
            .unwrap();
        if !add.status.success() {
            fs::remove_dir_all(&root).ok();
            return;
        }
        let commit = Command::new("git")
            .current_dir(&root)
            .args(["commit", "-m", "init"])
            .output()
            .unwrap();
        if !commit.status.success() {
            fs::remove_dir_all(&root).ok();
            return;
        }

        fs::write(root.join("tracked.txt"), "v2\n").unwrap();
        fs::write(root.join("new.txt"), "untracked\n").unwrap();
        fs::create_dir_all(root.join(".qingcode")).unwrap();
        fs::write(root.join(".qingcode").join("run.json"), "{}\n").unwrap();

        let status = read_git_workdir_status(&root).expect("porcelain status");
        assert!(status.dirty_count >= 3);
        let codes: Vec<_> = status.entries.iter().map(|e| e.status.as_str()).collect();
        assert!(codes.iter().any(|c| *c == "M" || c.contains('M')));
        assert!(codes.contains(&"??"));

        // `-uall`: nested untracked files appear; the bare directory does not.
        let paths: Vec<_> = status
            .entries
            .iter()
            .map(|e| e.path.replace('\\', "/"))
            .collect();
        assert!(
            paths
                .iter()
                .any(|p| p.ends_with("/.qingcode/run.json") || p.ends_with(".qingcode/run.json")),
            "expected expanded untracked file, got {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| {
                let trimmed = p.trim_end_matches('/');
                trimmed.ends_with("/.qingcode") || trimmed.ends_with(".qingcode")
            }),
            "untracked directory should not appear as a single entry, got {paths:?}"
        );

        let head = read_git_show_head(&root.join("tracked.txt")).expect("HEAD blob");
        assert_eq!(head, "v1\n");
        assert!(read_git_show_head(&root.join("new.txt")).is_none());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parse_porcelain_untracked_dir_trailing_slash() {
        // Still parse directory-style porcelain lines if Git emits them (rare with -uall).
        assert_eq!(
            parse_porcelain_line("?? .qingcode/"),
            Some((".qingcode/".into(), "??".into()))
        );
    }
}
