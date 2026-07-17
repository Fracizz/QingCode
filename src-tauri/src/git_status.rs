use crate::path_guard::PathAllowlist;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

/// Current Git HEAD for status-bar display.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitHeadInfo {
    /// Branch name, or abbreviated SHA when detached.
    pub name: String,
    pub detached: bool,
}

/// Resolve the Git directory for `start` or any ancestor (supports worktrees).
fn find_git_dir(start: &Path) -> Option<PathBuf> {
    let mut current = if start.is_dir() {
        start.to_path_buf()
    } else {
        start.parent()?.to_path_buf()
    };

    loop {
        let git = current.join(".git");
        if git.is_dir() {
            return Some(git);
        }
        if git.is_file() {
            if let Some(dir) = resolve_gitdir_file(&git, &current) {
                return Some(dir);
            }
        }
        if !current.pop() {
            return None;
        }
    }
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
}
