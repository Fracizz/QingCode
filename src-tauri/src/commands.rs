use crate::content_search::{
    self, ContentSearchOptions, ContentSearchResponse, DEFAULT_MAX_FILES_SCANNED,
    DEFAULT_MAX_MATCHES, DEFAULT_MAX_MATCHES_PER_FILE,
};
use crate::path_guard::PathAllowlist;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Keep full-text editing within the memory budget of a lightweight editor.
/// Larger files need a dedicated streaming viewer rather than CodeMirror state.
const MAX_EDITOR_FILE_SIZE: u64 = 50 * 1024 * 1024;

fn exceeds_editor_file_size_limit(size: u64) -> bool {
    size > MAX_EDITOR_FILE_SIZE
}

#[derive(Debug, Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

fn list_dir_one_level(current: &str) -> Result<Vec<FileNode>, std::io::Error> {
    let dir = Path::new(current);
    if !dir.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Directory is unavailable: {}", current),
        ));
    }

    let mut dirs = vec![];
    let mut files = vec![];

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if is_ignored_entry(&name) {
            continue;
        }

        let full_path = path.to_string_lossy().to_string();
        // Prefer DirEntry::file_type() to avoid an extra metadata round-trip per entry.
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
    allowlist: State<'_, PathAllowlist>,
) -> Result<Vec<FileNode>, String> {
    allowlist.ensure_allowed(&path)?;
    list_dir_one_level(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn validate_directory(path: String) -> Result<(), String> {
    if Path::new(&path).is_dir() {
        Ok(())
    } else {
        Err(format!("Directory is unavailable: {}", path))
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct SearchHit {
    pub name: String,
    pub path: String,
    pub relative: String,
    pub is_dir: bool,
}

fn is_ignored_entry(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | ".git" | ".next"
    )
}

fn is_glob_pattern(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?')
}

fn glob_match(text: &str, pattern: &str) -> bool {
    let text = text.as_bytes();
    let pattern = pattern.as_bytes();
    let mut t = 0usize;
    let mut p = 0usize;
    let mut star_p: Option<usize> = None;
    let mut star_t = 0usize;

    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            t += 1;
            p += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star_p = Some(p);
            star_t = t;
            p += 1;
        } else if let Some(sp) = star_p {
            p = sp + 1;
            star_t += 1;
            t = star_t;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn normalize_extensions(extensions: Option<Vec<String>>) -> Option<Vec<String>> {
    extensions
        .map(|exts| {
            exts.into_iter()
                .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|e| !e.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|exts| !exts.is_empty())
}

fn matches_extensions(name: &str, extensions: Option<&[String]>) -> bool {
    match extensions {
        None | Some([]) => true,
        Some(exts) => Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| exts.iter().any(|want| e.eq_ignore_ascii_case(want))),
    }
}

fn name_matches_query(
    name: &str,
    is_dir: bool,
    query: &str,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
) -> bool {
    if is_dir || query.is_empty() {
        return false;
    }
    let target_name = if ignore_case {
        name.to_lowercase()
    } else {
        name.to_string()
    };
    let q = if ignore_case {
        query.to_lowercase()
    } else {
        query.to_string()
    };

    if is_glob_pattern(&q) {
        return glob_match(&target_name, &q);
    }
    if match_suffix {
        let suffix = if q.starts_with('.') {
            q
        } else {
            format!(".{}", q)
        };
        return target_name.ends_with(&suffix);
    }
    if fuzzy {
        return fuzzy_match(&target_name, &q);
    }
    target_name.contains(&q)
}

#[allow(clippy::too_many_arguments)]
fn walk_matching(
    root: &Path,
    base: &Path,
    out: &mut Vec<SearchHit>,
    limit: usize,
    query: &str,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
    extensions: Option<&[String]>,
) {
    if out.len() >= limit {
        return;
    }
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_entry(&name) {
            continue;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let ext_ok = matches_extensions(&name, extensions);
        let matched = if query.is_empty() {
            !is_dir && extensions.is_some() && ext_ok
        } else if extensions.is_some() && !ext_ok {
            false
        } else {
            name_matches_query(&name, is_dir, query, ignore_case, fuzzy, match_suffix)
        };

        if matched {
            let full = path.to_string_lossy().to_string();
            let relative = path
                .strip_prefix(base)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| full.clone());
            out.push(SearchHit {
                name: name.clone(),
                path: full,
                relative,
                is_dir,
            });
        }
        if is_dir {
            walk_matching(
                &path,
                base,
                out,
                limit,
                query,
                ignore_case,
                fuzzy,
                match_suffix,
                extensions,
            );
        }
    }
}

fn fuzzy_match(haystack: &str, needle: &str) -> bool {
    // Subsequence match: needle chars appear in haystack in order.
    let mut it = haystack.chars();
    for nc in needle.chars() {
        loop {
            match it.next() {
                Some(hc) if hc == nc => break,
                Some(_) => continue,
                None => return false,
            }
        }
    }
    true
}

fn walk_file_extensions(
    root: &Path,
    counts: &mut HashMap<String, usize>,
    scanned: &mut usize,
    max_files: usize,
) {
    if *scanned >= max_files {
        return;
    }
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if *scanned >= max_files {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_entry(&name) {
            continue;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if is_dir {
            walk_file_extensions(&path, counts, scanned, max_files);
            continue;
        }
        *scanned += 1;
        if is_binary_extension(&name) {
            continue;
        }
        let Some(ext) = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
        else {
            continue;
        };
        if ext.is_empty() {
            continue;
        }
        *counts.entry(ext).or_insert(0) += 1;
    }
}

/// Collect unique file extensions under the given project roots (ignores
/// common build/vendor dirs and binary media). Sorted by frequency, then name.
#[tauri::command]
pub fn list_file_extensions(
    roots: Vec<String>,
    max_files: Option<usize>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<Vec<String>, String> {
    for root in &roots {
        allowlist.ensure_allowed(root)?;
    }
    let max = max_files.unwrap_or(8_000).clamp(100, 50_000);
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut scanned = 0usize;
    for root in roots {
        let path = Path::new(&root);
        if !path.is_dir() {
            continue;
        }
        walk_file_extensions(path, &mut counts, &mut scanned, max);
        if scanned >= max {
            break;
        }
    }
    let mut items: Vec<(String, usize)> = counts.into_iter().collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(items.into_iter().map(|(ext, _)| ext).take(80).collect())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn search_files(
    root: String,
    query: String,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
    extension: Option<String>,
    extensions: Option<Vec<String>>,
    limit: Option<usize>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<Vec<SearchHit>, String> {
    allowlist.ensure_allowed(&root)?;
    let base = Path::new(&root);
    if !base.is_dir() {
        return Ok(vec![]);
    }
    let max = limit.unwrap_or(500);
    let q = query.trim();
    if q.is_empty() && extensions.is_none() && extension.is_none() {
        return Ok(vec![]);
    }
    let ext_list = normalize_extensions(extensions.or_else(|| extension.map(|ext| vec![ext])));
    let q = if ignore_case {
        q.to_lowercase()
    } else {
        q.to_string()
    };
    let use_glob = is_glob_pattern(&q);
    let use_suffix = !use_glob && match_suffix && ext_list.is_none();
    let q = if use_suffix && !q.is_empty() && !q.starts_with('.') {
        format!(".{}", q)
    } else {
        q
    };
    let mut hits: Vec<SearchHit> = Vec::new();
    walk_matching(
        base,
        base,
        &mut hits,
        max,
        &q,
        ignore_case,
        fuzzy && !use_glob && !use_suffix,
        use_suffix,
        ext_list.as_deref(),
    );
    Ok(hits)
}

fn file_extension_lower(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_binary_extension(name: &str) -> bool {
    matches!(
        file_extension_lower(name).as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "bmp"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "eot"
            | "pdf"
            | "zip"
            | "gz"
            | "tar"
            | "7z"
            | "rar"
            | "exe"
            | "dll"
            | "so"
            | "dylib"
            | "bin"
            | "mp3"
            | "mp4"
            | "avi"
            | "mov"
            | "mkv"
            | "wasm"
            | "lock"
            | "map"
            | "pyc"
            | "pyo"
            | "pyd"
            | "class"
            | "o"
            | "obj"
            | "typed"
            // Office / document binaries (not plain text)
            | "xlsx"
            | "xlsm"
            | "xls"
            | "docx"
            | "doc"
            | "pptx"
            | "ppt"
            | "odt"
            | "ods"
            | "odp"
            | "numbers"
            | "pages"
            | "key"
            | "sqlite"
            | "db"
            | "7zip"
    )
}

fn display_file_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
}

/// User-facing reason when a path cannot be opened as a text editor buffer.
fn unsupported_text_file_message(path: &str) -> String {
    let name = display_file_name(path);
    let ext = file_extension_lower(name);
    if !ext.is_empty() {
        format!("暂不支持打开 .{ext} 格式（非文本文件），请用对应应用打开：{name}")
    } else {
        format!("暂不支持打开非文本或非 UTF-8 文件：{name}")
    }
}

fn is_utf8_decode_error(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::InvalidData
        || err.to_string().to_ascii_lowercase().contains("utf-8")
}

/// Begin a content-search session. Returns an id shared across multi-root invokes.
#[tauri::command]
pub fn start_content_search() -> u64 {
    content_search::start_content_search()
}

/// Cancel any in-flight content search sessions.
#[tauri::command]
pub fn cancel_content_search() {
    content_search::cancel_content_search()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn search_file_contents(
    root: String,
    query: String,
    ignore_case: bool,
    extension: Option<String>,
    extensions: Option<Vec<String>>,
    max_matches: Option<usize>,
    max_files_scanned: Option<usize>,
    max_matches_per_file: Option<usize>,
    search_id: Option<u64>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<ContentSearchResponse, String> {
    allowlist.ensure_allowed(&root)?;
    let ext = extension
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let ext_list =
        normalize_extensions(extensions.or_else(|| ext.map(|single| vec![single.to_string()])));

    let options = ContentSearchOptions {
        query,
        ignore_case,
        extensions: ext_list,
        max_matches: max_matches.unwrap_or(DEFAULT_MAX_MATCHES),
        max_files_scanned: max_files_scanned.unwrap_or(DEFAULT_MAX_FILES_SCANNED),
        max_matches_per_file: max_matches_per_file.unwrap_or(DEFAULT_MAX_MATCHES_PER_FILE),
    };

    Ok(content_search::search_file_contents(
        Path::new(&root),
        options,
        search_id.unwrap_or(0),
        None,
    ))
}

#[tauri::command]
pub fn read_file(path: String, allowlist: State<'_, PathAllowlist>) -> Result<String, String> {
    allowlist.ensure_allowed(&path)?;
    read_file_inner(path)
}

fn read_file_inner(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    if exceeds_editor_file_size_limit(metadata.len()) {
        return Err(format!(
            "暂不支持打开超过 50MB 的大文件：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    match fs::read_to_string(file_path) {
        Ok(content) => Ok(content),
        Err(e) if is_utf8_decode_error(&e) => Err(unsupported_text_file_message(&path)),
        Err(e) => Err(format!(
            "读取文件失败：{}（{}）",
            display_file_name(&path),
            e
        )),
    }
}

#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    // Mandatory sandbox: canonicalize/symlink-resolve before allowlist check.
    // Symlink escape is rejected unless the resolved target was explicitly authorized
    // (e.g. after the frontend confirm dialog grants the path).
    allowlist.ensure_allowed(&path)?;
    if exceeds_editor_file_size_limit(content.len() as u64) {
        return Err(format!("暂不支持保存超过 50MB 的大文件: {}", path));
    }
    let file_path = Path::new(&path);
    write_file_safely(file_path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

fn write_file_safely(path: &Path, content: &str) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(parent) = parent {
        fs::create_dir_all(parent)?;
    }

    if path.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path is a directory",
        ));
    }

    // Replacing a symlink would turn it into a regular file, so write through it instead.
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)?;
        file.write_all(content.as_bytes())?;
        return file.sync_all();
    }

    let parent = parent.unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("qingcode");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut temp_path = None;

    for attempt in 0..10 {
        let candidate = parent.join(format!(".{file_name}.{nonce}.{attempt}.tmp"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = file
                    .write_all(content.as_bytes())
                    .and_then(|_| file.sync_all())
                {
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                temp_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    let temp_path = temp_path.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "unable to create temporary file",
        )
    })?;

    #[cfg(windows)]
    {
        if path.exists() {
            let backup_path = parent.join(format!(".{file_name}.{nonce}.backup"));
            fs::rename(path, &backup_path)?;
            if let Err(error) = fs::rename(&temp_path, path) {
                let _ = fs::rename(&backup_path, path);
                let _ = fs::remove_file(&temp_path);
                return Err(error);
            }
            let _ = fs::remove_file(backup_path);
            return Ok(());
        }
    }

    fs::rename(temp_path, path)
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        Err("名称不能为空或包含路径分隔符".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn create_file(
    parent: String,
    name: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let parent_path = Path::new(&parent);
    if !parent_path.is_dir() {
        return Err(format!("目录不可用: {}", parent));
    }
    let path = parent_path.join(&name);
    allowlist.ensure_allowed(&path.to_string_lossy())?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("新建文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_directory(
    parent: String,
    name: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let parent_path = Path::new(&parent);
    if !parent_path.is_dir() {
        return Err(format!("目录不可用: {}", parent));
    }
    let path = parent_path.join(&name);
    allowlist.ensure_allowed(&path.to_string_lossy())?;
    fs::create_dir(&path).map_err(|e| format!("新建文件夹失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rename_path(
    path: String,
    new_name: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    validate_entry_name(&new_name)?;
    allowlist.ensure_allowed(&path)?;
    let source = Path::new(&path);
    let parent = source
        .parent()
        .ok_or_else(|| "无法重命名该路径".to_string())?;
    let target = parent.join(&new_name);
    allowlist.ensure_allowed(&target.to_string_lossy())?;
    if target.exists() {
        return Err("目标名称已存在".to_string());
    }
    fs::rename(source, &target).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_path(path: String, allowlist: State<'_, PathAllowlist>) -> Result<(), String> {
    allowlist.ensure_allowed(&path)?;
    let target = Path::new(&path);
    let metadata = fs::symlink_metadata(target).map_err(|e| format!("读取路径失败: {}", e))?;
    if metadata.is_dir() {
        fs::remove_dir_all(target).map_err(|e| format!("删除文件夹失败: {}", e))
    } else {
        fs::remove_file(target).map_err(|e| format!("删除文件失败: {}", e))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryDeleteStats {
    pub path: String,
    pub file_count: u64,
    pub total_size: u64,
}

/// Walk a directory (without following dir symlinks) to gather cheap delete-confirm stats.
#[tauri::command]
pub fn directory_delete_stats(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<DirectoryDeleteStats, String> {
    allowlist.ensure_allowed(&path)?;
    let target = Path::new(&path);
    let metadata = fs::symlink_metadata(target).map_err(|e| format!("读取路径失败: {}", e))?;
    if !metadata.is_dir() {
        return Err("路径不是文件夹".to_string());
    }

    let mut file_count = 0u64;
    let mut total_size = 0u64;
    collect_directory_delete_stats(target, &mut file_count, &mut total_size)?;

    Ok(DirectoryDeleteStats {
        path: display_path(target),
        file_count,
        total_size,
    })
}

fn collect_directory_delete_stats(
    dir: &Path,
    file_count: &mut u64,
    total_size: &mut u64,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {}", e))?;
        if file_type.is_dir() && !file_type.is_symlink() {
            collect_directory_delete_stats(&entry.path(), file_count, total_size)?;
        } else {
            *file_count += 1;
            if let Ok(meta) = entry.metadata() {
                *total_size = total_size.saturating_add(meta.len());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkWriteCheck {
    pub needs_confirm: bool,
    pub resolved_path: Option<String>,
}

/// Detect whether writing `path` would follow a symlink to a target outside registered roots.
/// Uses the native allowlist (not caller-supplied roots). Fail closed on resolve errors.
#[tauri::command]
pub fn check_symlink_write(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<SymlinkWriteCheck, String> {
    check_symlink_write_inner(Path::new(&path), &allowlist)
}

fn check_symlink_write_inner(
    path: &Path,
    allowlist: &PathAllowlist,
) -> Result<SymlinkWriteCheck, String> {
    let outside = allowlist.with_state(|state| {
        crate::path_guard::outside_symlink_write_target(path, state)
    })??;
    match outside {
        None => Ok(SymlinkWriteCheck {
            needs_confirm: false,
            resolved_path: None,
        }),
        Some(resolved) => Ok(SymlinkWriteCheck {
            needs_confirm: true,
            resolved_path: Some(display_path(&resolved)),
        }),
    }
}

fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }
    raw.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_write_replaces_existing_file_with_empty_content() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-write-test-{nonce}"));
        let path = dir.join("sample.txt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, "before").unwrap();

        write_file_safely(&path, "").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_files_larger_than_editor_limit() {
        assert!(!exceeds_editor_file_size_limit(MAX_EDITOR_FILE_SIZE));
        assert!(exceeds_editor_file_size_limit(MAX_EDITOR_FILE_SIZE + 1));
    }

    #[test]
    fn unsupported_message_mentions_office_extension() {
        let msg = unsupported_text_file_message(r"D:\proj\stories_final.xlsx");
        assert!(msg.contains(".xlsx"), "{msg}");
        assert!(msg.contains("stories_final.xlsx"), "{msg}");
        assert!(msg.contains("暂不支持"), "{msg}");
        assert!(!msg.contains("UTF-8"), "{msg}");
    }

    #[test]
    fn read_file_rejects_xlsx_before_decoding() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-xlsx-test-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.xlsx");
        // ZIP/XLSX signature bytes — not valid UTF-8 text.
        fs::write(&path, [0x50u8, 0x4b, 0x03, 0x04, 0xff, 0xfe]).unwrap();

        let err = read_file_inner(path.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains(".xlsx"), "{err}");
        assert!(err.contains("暂不支持"), "{err}");
        assert!(!err.to_ascii_lowercase().contains("utf-8"), "{err}");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn read_file_maps_invalid_utf8_to_friendly_message() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-bin-test-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mystery.dat");
        fs::write(&path, [0x00u8, 0xff, 0xfe, 0x80]).unwrap();

        let err = read_file_inner(path.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("暂不支持"), "{err}");
        assert!(err.contains("mystery.dat"), "{err}");
        assert!(
            !err.to_ascii_lowercase().contains("stream did not contain"),
            "{err}"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_path_like_entry_names() {
        for name in ["", ".", "..", "a/b", "a\\b"] {
            assert!(
                validate_entry_name(name).is_err(),
                "{name:?} should be rejected"
            );
        }
        assert!(validate_entry_name("notes.md").is_ok());
    }

    #[test]
    fn directory_delete_stats_counts_nested_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-dir-stats-{nonce}"));
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("a.txt"), "hello").unwrap();
        fs::write(dir.join("nested/b.txt"), "world!!").unwrap();

        let mut file_count = 0u64;
        let mut total_size = 0u64;
        collect_directory_delete_stats(&dir, &mut file_count, &mut total_size).unwrap();
        assert_eq!(file_count, 2);
        assert_eq!(total_size, 12);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn check_symlink_write_skips_regular_file_inside_project() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-symlink-check-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.txt");
        fs::write(&file, "hi").unwrap();

        let allowlist = PathAllowlist::new();
        allowlist.sync_project_roots(vec![dir.to_string_lossy().to_string()]);
        let check = check_symlink_write_inner(&file, &allowlist).unwrap();
        assert!(!check.needs_confirm);
        assert!(check.resolved_path.is_none());

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn check_symlink_write_flags_symlink_outside_project() {
        use std::os::unix::fs::symlink;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("qingcode-symlink-out-{nonce}"));
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        fs::write(&target, "secret").unwrap();
        let link = project.join("alias.txt");
        symlink(&target, &link).unwrap();

        let allowlist = PathAllowlist::new();
        allowlist.sync_project_roots(vec![project.to_string_lossy().to_string()]);
        let check = check_symlink_write_inner(&link, &allowlist).unwrap();
        assert!(check.needs_confirm);
        assert!(
            check
                .resolved_path
                .as_deref()
                .is_some_and(|p| p.ends_with("secret.txt")),
            "{:?}",
            check.resolved_path
        );

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn list_file_extensions_collects_from_project_and_skips_ignored() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-ext-test-{nonce}"));
        let ignored = dir.join("node_modules");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(&ignored).unwrap();
        fs::write(dir.join("src/main.ts"), "export {}").unwrap();
        fs::write(dir.join("src/app.tsx"), "export {}").unwrap();
        fs::write(dir.join("README.md"), "# hi").unwrap();
        fs::write(dir.join("logo.png"), [0u8; 8]).unwrap();
        fs::write(ignored.join("pkg.js"), "module.exports = {}").unwrap();

        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut scanned = 0usize;
        walk_file_extensions(&dir, &mut counts, &mut scanned, 1000);
        let mut items: Vec<(String, usize)> = counts.into_iter().collect();
        items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let exts: Vec<String> = items.into_iter().map(|(ext, _)| ext).collect();
        assert!(exts.contains(&"ts".to_string()));
        assert!(exts.contains(&"tsx".to_string()));
        assert!(exts.contains(&"md".to_string()));
        assert!(!exts.contains(&"js".to_string()), "ignored node_modules js");
        assert!(!exts.contains(&"png".to_string()), "binary png skipped");

        fs::remove_dir_all(dir).unwrap();
    }
}
