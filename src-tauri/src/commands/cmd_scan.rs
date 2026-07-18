use crate::exclude;
use crate::path_guard::PathAllowlist;
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

fn should_skip_path(
    workspace_root: &str,
    full_path: &str,
    name: &str,
    exclude_patterns: Option<&[String]>,
) -> bool {
    match exclude_patterns {
        Some(patterns) => {
            if let Some(rel) = exclude::relative_to_root(workspace_root, full_path) {
                if rel.is_empty() {
                    return false;
                }
                return exclude::is_path_excluded(&rel, patterns);
            }
            exclude::is_path_excluded(name, patterns)
        }
        None => exclude::default_hard_ignore_name(name),
    }
}

fn list_dir_one_level(
    current: &str,
    workspace_root: &str,
    exclude_patterns: Option<&[String]>,
    exclude_git_ignore: bool,
) -> Result<Vec<FileNode>, std::io::Error> {
    let dir = Path::new(current);
    if !dir.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("目录不可用: {}", current),
        ));
    }

    let mut dirs = vec![];
    let mut files = vec![];

    let mut builder = WalkBuilder::new(dir);
    builder
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(exclude_git_ignore)
        .git_global(exclude_git_ignore)
        .git_exclude(exclude_git_ignore)
        .ignore(exclude_git_ignore)
        .parents(exclude_git_ignore)
        .follow_links(false);
    if exclude_git_ignore {
        // Honor root `.gitignore` even when the folder is not a git checkout.
        builder.add_custom_ignore_filename(".gitignore");
    }

    for result in builder.build() {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = path.to_string_lossy().to_string();

        if should_skip_path(workspace_root, &full_path, &name, exclude_patterns) {
            continue;
        }

        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);

        let node = FileNode {
            name,
            path: full_path,
            is_dir,
            children: None,
        };

        if is_dir {
            dirs.push(node);
        } else {
            files.push(node);
        }
    }

    dirs.sort_by_key(|a| a.name.to_lowercase());
    files.sort_by_key(|a| a.name.to_lowercase());

    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub fn scan_directory(
    path: String,
    workspace_root: Option<String>,
    exclude_patterns: Option<Vec<String>>,
    exclude_git_ignore: Option<bool>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<Vec<FileNode>, String> {
    allowlist.ensure_allowed(&path)?;
    let root = workspace_root.unwrap_or_else(|| path.clone());
    list_dir_one_level(
        &path,
        &root,
        exclude_patterns.as_deref(),
        exclude_git_ignore.unwrap_or(true),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn validate_directory(path: String) -> Result<(), String> {
    if Path::new(&path).is_dir() {
        Ok(())
    } else {
        Err(format!("目录不可用: {}", path))
    }
}
