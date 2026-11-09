//! 把 CLI 收到的相对路径换算成绝对路径：GUI 的工作目录与调用方无关。

use std::path::{Component, Path, PathBuf};

fn is_ssh_resource(path: &str) -> bool {
    path.starts_with("ssh://")
}

/// 按字面归并 `.` 和 `..`，目标文件可以不存在。
fn absolute_from(path: &Path, cwd: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut result = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// 拆出结尾的 `:line` 或 `:line:col`，其余部分原样作为路径。
fn split_position_suffix(target: &str) -> (&str, &str) {
    let mut end = target.len();
    for _ in 0..2 {
        let Some(colon) = target[..end].rfind(':') else {
            break;
        };
        let digits = &target[colon + 1..end];
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            break;
        }
        end = colon;
    }
    target.split_at(end)
}

pub fn absolutize_open_target(target: &str, cwd: &Path) -> String {
    if is_ssh_resource(target) {
        return target.to_string();
    }
    let (path, position) = split_position_suffix(target);
    if Path::new(path).is_absolute() {
        return target.to_string();
    }
    format!(
        "{}{position}",
        absolute_from(Path::new(path), cwd).to_string_lossy()
    )
}

/// 授予信任的目标必须是真实存在的目录，否则信任记录落在一个永远匹配不上的路径上。
pub fn existing_directory(path: &str, cwd: &Path) -> Result<String, String> {
    let trimmed = path.trim();
    if is_ssh_resource(trimmed) {
        return Ok(trimmed.to_string());
    }
    let absolute = absolute_from(Path::new(trimmed), cwd);
    if !absolute.is_dir() {
        return Err(format!("not a directory: {}", absolute.display()));
    }
    let canonical = std::fs::canonicalize(&absolute).unwrap_or(absolute);
    Ok(crate::terminal::strip_windows_verbatim_prefix(&canonical.to_string_lossy()).into_owned())
}

/// 撤销信任时目录可能已经被删除，只做路径换算。
pub fn absolute_path(path: &str, cwd: &Path) -> String {
    let trimmed = path.trim();
    if is_ssh_resource(trimmed) {
        return trimmed.to_string();
    }
    absolute_from(Path::new(trimmed), cwd)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cwd() -> PathBuf {
        std::env::temp_dir().join("qingcode-cli-cwd")
    }

    fn joined(parts: &[&str]) -> String {
        parts
            .iter()
            .fold(cwd(), |path, part| path.join(part))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn relative_open_target_keeps_line_and_column() {
        assert_eq!(
            absolutize_open_target("src/./a.ts:10:2", &cwd()),
            format!("{}:10:2", joined(&["src", "a.ts"]))
        );
        assert_eq!(
            absolutize_open_target("a.ts:7", &cwd()),
            format!("{}:7", joined(&["a.ts"]))
        );
        assert_eq!(absolutize_open_target("a.ts", &cwd()), joined(&["a.ts"]));
    }

    #[test]
    fn relative_open_target_resolves_parent_segments() {
        assert_eq!(
            absolutize_open_target("x/../a.ts", &cwd()),
            joined(&["a.ts"])
        );
    }

    #[test]
    fn absolute_and_remote_open_targets_are_untouched() {
        let absolute = format!("{}:3", joined(&["a.ts"]));
        assert_eq!(absolutize_open_target(&absolute, &cwd()), absolute);
        let remote = "ssh://conn/srv/App/a.ts:3";
        assert_eq!(absolutize_open_target(remote, &cwd()), remote);
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_path_with_position_is_absolute() {
        let target = r"D:\Work\a.ts:12:3";
        assert_eq!(absolutize_open_target(target, Path::new(r"C:\x")), target);
    }

    #[test]
    fn trust_target_must_be_an_existing_directory() {
        let dir = std::env::temp_dir().join(format!("qingcode-cli-trust-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let resolved = existing_directory(".", &dir).unwrap();
        assert!(Path::new(&resolved).is_absolute());
        assert_ne!(resolved, ".");
        assert!(existing_directory("missing", &dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_trust_targets_are_not_treated_as_local_paths() {
        let remote = "ssh://conn/srv/App";
        assert_eq!(existing_directory(remote, &cwd()).unwrap(), remote);
        assert_eq!(absolute_path(remote, &cwd()), remote);
    }

    #[test]
    fn revoke_path_does_not_need_to_exist() {
        assert_eq!(absolute_path("gone", &cwd()), joined(&["gone"]));
    }
}
