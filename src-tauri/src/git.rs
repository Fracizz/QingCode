use serde::Serialize;
use std::path::{Component, Path};
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
    Command::new("git")
        .current_dir(root)
        .args(args)
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

fn parse_status(output: &str) -> GitStatus {
    let mut branch = None;
    let mut changes = vec![];
    for line in output.lines() {
        if line.starts_with("## ") {
            branch = parse_branch(line);
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].trim();
        let path = line[3..].trim();
        if status.is_empty() || path.is_empty() {
            continue;
        }
        changes.push(GitChange {
            path: path.to_string(),
            status: status.to_string(),
        });
    }
    GitStatus {
        is_repository: true,
        branch,
        changes,
    }
}

#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatus, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Git 项目目录不可用".to_string());
    }
    let output = run_git(root, &["status", "--porcelain=v1", "--branch"])?;
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
    Ok(parse_status(&String::from_utf8_lossy(&output.stdout)))
}

#[tauri::command]
pub fn git_diff(path: String, file: String) -> Result<String, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Git 项目目录不可用".to_string());
    }
    let file_path = Path::new(&file);
    if !file_path.is_absolute() {
        return Err("仅允许查看项目内的绝对文件路径".to_string());
    }
    let relative = file_path
        .strip_prefix(root)
        .map_err(|_| "仅允许查看当前项目内的文件差异".to_string())?;
    if relative
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err("仅允许查看当前项目内的文件差异".to_string());
    }
    let relative = relative.to_string_lossy();
    let output = run_git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=3",
            "--",
            &relative,
        ],
    )?;
    if !output.status.success() {
        return Err(format!(
            "读取 Git 差异失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let bytes = output.stdout;
    if bytes.len() <= MAX_DIFF_BYTES {
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    Ok(format!(
        "{}\n\n… 差异内容已截断（最多显示 1MB）",
        String::from_utf8_lossy(&bytes[..MAX_DIFF_BYTES])
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_changed_files() {
        let status =
            parse_status("## feature/test...origin/feature/test\n M src/main.ts\n?? notes.txt\n");
        assert_eq!(status.branch.as_deref(), Some("feature/test"));
        assert_eq!(status.changes.len(), 2);
        assert_eq!(status.changes[0].status, "M");
        assert_eq!(status.changes[1].path, "notes.txt");
    }

    #[test]
    fn parses_repository_without_commits() {
        let status = parse_status("## No commits yet on main\n?? README.md\n");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.changes[0].status, "??");
    }
}
