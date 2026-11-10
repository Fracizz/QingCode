//! Git 辅助：定位仓库、读取 HEAD 版本、生成统一 diff 补丁。
//!
//! Diff 基准是 `HEAD` 中的文件内容，对比对象是编辑器当前缓冲区（含未保存修改），
//! 补丁交给 gpui-component 的 `DiffFile::parse` 渲染。

use std::path::{Path, PathBuf};
use std::process::Command;

use similar::TextDiff;

/// 向上查找包含 `.git` 的目录作为仓库根。
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cur = if start.is_file() {
        start.parent()?
    } else {
        start
    };
    loop {
        if cur.join(".git").exists() {
            return Some(cur.to_path_buf());
        }
        cur = cur.parent()?;
    }
}

/// 仓库内相对路径，统一为 `/` 分隔（git 需要）。
pub fn repo_relative(repo: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(repo).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn git_command(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：避免 GUI 进程调用 git 时闪出控制台窗口
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// HEAD 中该文件的内容；未跟踪 / 新文件返回 `Ok(None)`。
pub fn head_content(repo: &Path, rel: &str) -> anyhow::Result<Option<String>> {
    let out = git_command(repo)
        .args(["show", &format!("HEAD:{rel}")])
        .output()?;
    if !out.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout).replace("\r\n", "\n");
    Ok(Some(text))
}

/// 生成 `--- a/<rel>` / `+++ b/<rel>` 形式的统一补丁；无差异时返回 None。
pub fn unified_patch(rel: &str, old: Option<&str>, new: &str) -> Option<String> {
    let old_text = old.unwrap_or("");
    if old.is_some() && old_text == new {
        return None;
    }
    let diff = TextDiff::from_lines(old_text, new);
    let old_header = if old.is_some() {
        format!("a/{rel}")
    } else {
        "/dev/null".to_string()
    };
    let body = diff
        .unified_diff()
        .context_radius(3)
        .header(&old_header, &format!("b/{rel}"))
        .to_string();
    if body.trim().is_empty() {
        None
    } else {
        Some(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_relative_uses_forward_slashes() {
        let repo = PathBuf::from("repo");
        let file = repo.join("src").join("main.rs");
        assert_eq!(repo_relative(&repo, &file).as_deref(), Some("src/main.rs"));
        assert_eq!(repo_relative(&repo, Path::new("other/x")), None);
    }

    #[test]
    fn unified_patch_is_none_when_unchanged() {
        assert_eq!(unified_patch("a.txt", Some("x\n"), "x\n"), None);
    }

    #[test]
    fn unified_patch_marks_changed_lines() {
        let patch = unified_patch("a.txt", Some("one\ntwo\n"), "one\nTWO\n").unwrap();
        assert!(patch.starts_with("--- a/a.txt\n+++ b/a.txt\n"));
        assert!(patch.contains("-two\n"));
        assert!(patch.contains("+TWO\n"));
    }

    #[test]
    fn unified_patch_for_untracked_file_is_all_additions() {
        let patch = unified_patch("new.txt", None, "hello\n").unwrap();
        assert!(patch.starts_with("--- /dev/null\n+++ b/new.txt\n"));
        assert!(patch.contains("+hello\n"));
    }

    #[test]
    fn find_repo_root_walks_up_to_dot_git() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = find_repo_root(here).expect("crate lives inside the QingCode repo");
        assert!(root.join(".git").exists());
        assert!(here.starts_with(&root));
    }
}
