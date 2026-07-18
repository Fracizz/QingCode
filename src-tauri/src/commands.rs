use crate::content_search::{
    self, ContentSearchOptions, ContentSearchResponse, DEFAULT_MAX_FILES_SCANNED,
    DEFAULT_MAX_MATCHES, DEFAULT_MAX_MATCHES_PER_FILE,
};
use crate::exclude;
use crate::file_encoding;
use crate::path_guard::PathAllowlist;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::{copy, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Full-buffer `read_file` / `write_file` budget (plain-text CodeMirror up to this size).
/// Frontend further tiers: ≤20MB full/degraded edit, 20–100MB plain edit, >100MB view-only.
const MAX_EDITOR_FILE_SIZE: u64 = 100 * 1024 * 1024;
/// Legacy range-replace hard cap (same as full-buffer budget; UI no longer exposes patch).
const MAX_PATCH_FILE_SIZE: u64 = 100 * 1024 * 1024;
/// Pure read-only slice viewer hard cap.
const MAX_VIEWER_FILE_SIZE: u64 = 500 * 1024 * 1024;
/// Max bytes returned by a single `read_file_slice` call.
const MAX_SLICE_BYTES: u64 = 256 * 1024;
/// Max UTF-8 bytes accepted by `replace_file_range` (fragment edit).
const MAX_REPLACE_TEXT_BYTES: u64 = 1024 * 1024;

fn exceeds_editor_file_size_limit(size: u64) -> bool {
    size > MAX_EDITOR_FILE_SIZE
}

fn exceeds_patch_file_size_limit(size: u64) -> bool {
    size > MAX_PATCH_FILE_SIZE
}

fn exceeds_viewer_file_size_limit(size: u64) -> bool {
    size > MAX_VIEWER_FILE_SIZE
}

#[derive(Debug, Serialize)]
pub struct FileStat {
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct FileSlice {
    pub offset: u64,
    pub len: u64,
    pub text: String,
    pub eof: bool,
    pub file_size: u64,
}

/// Result of streaming scan for a 1-based line start offset.
#[derive(Debug, Serialize)]
pub struct LineOffsetResult {
    /// Requested 1-based line number.
    pub line: u64,
    /// Byte offset of the start of that line (or last line when not found).
    pub offset: u64,
    /// True when the requested line exists.
    pub found: bool,
    /// Total lines counted (full file when `!found` or scan completed).
    pub total_lines: u64,
    pub file_size: u64,
}

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
            format!("Directory is unavailable: {}", current),
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
    exclude::default_hard_ignore_name(name)
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
    exclude_patterns: Option<&[String]>,
    use_ignore_files: bool,
    follow_symlinks: bool,
) {
    let base_str = base.to_string_lossy().to_string();
    let exclude_owned = exclude_patterns.map(|p| p.to_vec());

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(use_ignore_files)
        .git_global(use_ignore_files)
        .git_exclude(use_ignore_files)
        .ignore(use_ignore_files)
        .parents(use_ignore_files)
        .follow_links(follow_symlinks)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            let full = entry.path().to_string_lossy();
            !should_skip_path(&base_str, &full, &name, exclude_owned.as_deref())
        });
    if use_ignore_files {
        builder.add_custom_ignore_filename(".gitignore");
    }

    for result in builder.build() {
        if out.len() >= limit {
            break;
        }
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let full = path.to_string_lossy().to_string();
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
            let relative = path
                .strip_prefix(base)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| full.clone());
            out.push(SearchHit {
                name,
                path: full,
                relative,
                is_dir,
            });
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
    exclude_patterns: Option<Vec<String>>,
    use_ignore_files: Option<bool>,
    follow_symlinks: Option<bool>,
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
        exclude_patterns.as_deref(),
        use_ignore_files.unwrap_or(true),
        follow_symlinks.unwrap_or(false),
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

fn decode_error_message(path: &str, encoding: file_encoding::FileEncoding) -> String {
    format!(
        "暂不支持打开非文本或无法按 {} 解码的文件：{}",
        encoding.as_str(),
        display_file_name(path)
    )
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
    exclude_patterns: Option<Vec<String>>,
    use_ignore_files: Option<bool>,
    follow_symlinks: Option<bool>,
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
        exclude_patterns,
        use_ignore_files: use_ignore_files.unwrap_or(true),
        follow_symlinks: follow_symlinks.unwrap_or(false),
    };

    Ok(content_search::search_file_contents(
        Path::new(&root),
        options,
        search_id.unwrap_or(0),
        None,
    ))
}

#[tauri::command]
pub fn file_stat(path: String, allowlist: State<'_, PathAllowlist>) -> Result<FileStat, String> {
    allowlist.ensure_allowed(&path)?;
    file_stat_inner(path)
}

fn file_stat_inner(path: String) -> Result<FileStat, String> {
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    Ok(FileStat {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
    })
}

#[tauri::command]
pub fn read_file(
    path: String,
    encoding: Option<String>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    allowlist.ensure_allowed(&path)?;
    read_file_inner(path, encoding.as_deref())
}

#[tauri::command]
pub fn detect_file_encoding(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    allowlist.ensure_allowed(&path)?;
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    if exceeds_editor_file_size_limit(metadata.len()) {
        return Err(format!(
            "暂不支持在编辑器中打开超过 100MB 的文件（可用只读预览打开至 500MB）：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    let bytes = fs::read(file_path)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
    file_encoding::detect(&bytes)
        .map(|encoding| encoding.as_str().to_string())
        .map_err(|_| unsupported_text_file_message(&path))
}

fn read_file_inner(path: String, encoding: Option<&str>) -> Result<String, String> {
    let enc = file_encoding::parse(encoding);
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    if exceeds_editor_file_size_limit(metadata.len()) {
        return Err(format!(
            "暂不支持在编辑器中打开超过 100MB 的文件（可用只读预览打开至 500MB）：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    let bytes = fs::read(file_path)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
    file_encoding::decode(&bytes, enc).map_err(|_| decode_error_message(&path, enc))
}

#[tauri::command]
pub fn read_file_slice(
    path: String,
    offset: u64,
    max_bytes: u64,
    allowlist: State<'_, PathAllowlist>,
) -> Result<FileSlice, String> {
    allowlist.ensure_allowed(&path)?;
    read_file_slice_inner(path, offset, max_bytes)
}

fn read_file_slice_inner(path: String, offset: u64, max_bytes: u64) -> Result<FileSlice, String> {
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    let file_size = metadata.len();
    if exceeds_viewer_file_size_limit(file_size) {
        return Err(format!(
            "暂不支持打开超过 500MB 的大文件：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    if offset > file_size {
        return Err(format!(
            "读取偏移超出文件范围：{}",
            display_file_name(&path)
        ));
    }

    let want = max_bytes.clamp(1, MAX_SLICE_BYTES);
    let available = file_size - offset;
    let to_read = want.min(available) as usize;

    let mut file = File::open(file_path)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;

    let mut buf = vec![0u8; to_read];
    let mut read_total = 0usize;
    while read_total < to_read {
        match file.read(&mut buf[read_total..]) {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(e) => {
                return Err(format!(
                    "读取文件失败：{}（{}）",
                    display_file_name(&path),
                    e
                ))
            }
        }
    }
    buf.truncate(read_total);

    // Avoid splitting a UTF-8 codepoint at the end of the window.
    let end = trim_utf8_end(&buf);
    buf.truncate(end);

    let text = String::from_utf8_lossy(&buf).into_owned();
    let len = buf.len() as u64;
    let eof = offset + len >= file_size;

    Ok(FileSlice {
        offset,
        len,
        text,
        eof,
        file_size,
    })
}

/// Streaming newline scan: return the byte offset of a 1-based line without loading the file.
#[tauri::command]
pub fn find_line_offset(
    path: String,
    line: u64,
    allowlist: State<'_, PathAllowlist>,
) -> Result<LineOffsetResult, String> {
    allowlist.ensure_allowed(&path)?;
    find_line_offset_inner(path, line)
}

fn find_line_offset_inner(path: String, line: u64) -> Result<LineOffsetResult, String> {
    if line == 0 {
        return Err("行号必须从 1 开始".into());
    }

    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    let file_size = metadata.len();
    if exceeds_viewer_file_size_limit(file_size) {
        return Err(format!(
            "暂不支持打开超过 500MB 的大文件：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }

    if file_size == 0 {
        return Ok(LineOffsetResult {
            line,
            offset: 0,
            found: line == 1,
            total_lines: 0,
            file_size: 0,
        });
    }

    if line == 1 {
        // Still count total lines for UI feedback when useful — cheap enough for jump-to-1.
        // Skip full count for line 1 to keep first jump fast on huge files.
        return Ok(LineOffsetResult {
            line: 1,
            offset: 0,
            found: true,
            total_lines: 1,
            file_size,
        });
    }

    let mut file = File::open(file_path)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;

    const BUF_SIZE: usize = 64 * 1024;
    let mut buf = [0u8; BUF_SIZE];
    let mut current_line: u64 = 1;
    let mut file_pos: u64 = 0;
    let mut last_line_offset: u64 = 0;

    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
        if n == 0 {
            break;
        }
        for (i, &b) in buf[..n].iter().enumerate() {
            if b == b'\n' {
                let next_offset = file_pos + i as u64 + 1;
                current_line += 1;
                last_line_offset = next_offset;
                if current_line == line {
                    return Ok(LineOffsetResult {
                        line,
                        offset: next_offset.min(file_size),
                        found: true,
                        total_lines: line,
                        file_size,
                    });
                }
            }
        }
        file_pos += n as u64;
    }

    // File ended without reaching `line`. If it does not end with `\n`, the last
    // partial line still counts (already in current_line).
    let total_lines = if file_size > 0 { current_line } else { 0 };
    Ok(LineOffsetResult {
        line,
        offset: last_line_offset.min(file_size),
        found: false,
        total_lines,
        file_size,
    })
}

/// Truncate `buf` so it ends on a UTF-8 character boundary (may shorten by ≤3 bytes).
fn trim_utf8_end(buf: &[u8]) -> usize {
    if buf.is_empty() {
        return 0;
    }
    let mut i = buf.len();
    while i > 0 && (buf[i - 1] & 0b1100_0000) == 0b1000_0000 {
        i -= 1;
        if buf.len() - i > 3 {
            return buf.len();
        }
    }
    if i == 0 {
        return 0;
    }
    let lead = buf[i - 1];
    let need = utf8_char_len(lead);
    let have = buf.len() - (i - 1);
    if have < need {
        i - 1
    } else {
        buf.len()
    }
}

fn utf8_char_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead & 0b1110_0000 == 0b1100_0000 {
        2
    } else if lead & 0b1111_0000 == 0b1110_0000 {
        3
    } else if lead & 0b1111_1000 == 0b1111_0000 {
        4
    } else {
        1
    }
}

#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    // Mandatory sandbox: canonicalize/symlink-resolve before allowlist check.
    // Symlink escape is rejected unless the resolved target was explicitly authorized
    // (e.g. after the frontend confirm dialog grants the path).
    allowlist.ensure_writable(&path)?;
    let enc = file_encoding::parse(encoding.as_deref());
    let bytes = file_encoding::encode(&content, enc).map_err(|e| {
        format!(
            "无法按 {} 编码保存文件：{}（{}）",
            enc.as_str(),
            display_file_name(&path),
            e
        )
    })?;
    if exceeds_editor_file_size_limit(bytes.len() as u64) {
        return Err(format!("暂不支持保存超过 100MB 的大文件: {}", path));
    }
    let file_path = Path::new(&path);
    write_file_safely(file_path, &bytes).map_err(|e| format!("Failed to write {}: {}", path, e))
}

fn write_file_safely(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
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
        file.write_all(bytes)?;
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
                if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
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

#[tauri::command]
pub fn replace_file_range(
    path: String,
    start: u64,
    end: u64,
    text: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<FileStat, String> {
    allowlist.ensure_writable(&path)?;
    replace_file_range_inner(path, start, end, text)
}

/// Stream a range replacement into a temp file, then atomically replace.
/// Kept for compatibility; the UI opens ≤100MB files in CodeMirror instead.
fn replace_file_range_inner(
    path: String,
    start: u64,
    end: u64,
    text: String,
) -> Result<FileStat, String> {
    if start > end {
        return Err("替换范围无效：起始位置大于结束位置".into());
    }
    let text_bytes = text.as_bytes();
    if text_bytes.len() as u64 > MAX_REPLACE_TEXT_BYTES {
        return Err(format!(
            "替换内容不能超过 {}MB",
            MAX_REPLACE_TEXT_BYTES / (1024 * 1024)
        ));
    }

    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    let file_size = metadata.len();
    if exceeds_patch_file_size_limit(file_size) {
        return Err(format!(
            "超过 100MB 的文件仅支持只读预览，无法编辑：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    if end > file_size {
        return Err(format!(
            "替换范围超出文件末尾：{}",
            display_file_name(&path)
        ));
    }

    let parent = file_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("qingcode");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let mut temp_path = None;
    for attempt in 0..10 {
        let candidate = parent.join(format!(".{file_name}.{nonce}.{attempt}.patch.tmp"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut out) => {
                let result = (|| -> Result<(), String> {
                    let mut src = File::open(file_path).map_err(|e| {
                        format!("读取文件失败：{}（{}）", display_file_name(&path), e)
                    })?;
                    if start > 0 {
                        copy(&mut Read::by_ref(&mut src).take(start), &mut out)
                            .map_err(|e| format!("写入临时文件失败：{}", e))?;
                    }
                    out.write_all(text_bytes)
                        .map_err(|e| format!("写入替换内容失败：{}", e))?;
                    if end < file_size {
                        src.seek(SeekFrom::Start(end)).map_err(|e| e.to_string())?;
                        copy(&mut src, &mut out).map_err(|e| format!("写入临时文件失败：{}", e))?;
                    }
                    out.sync_all()
                        .map_err(|e| format!("同步临时文件失败：{}", e))?;
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                temp_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("创建临时文件失败：{}", error));
            }
        }
    }

    let temp_path = temp_path.ok_or_else(|| "无法创建临时文件".to_string())?;

    #[cfg(windows)]
    {
        if file_path.exists() {
            let backup_path = parent.join(format!(".{file_name}.{nonce}.patch.backup"));
            if let Err(error) = fs::rename(file_path, &backup_path) {
                let _ = fs::remove_file(&temp_path);
                return Err(format!("替换文件失败：{}", error));
            }
            if let Err(error) = fs::rename(&temp_path, file_path) {
                let _ = fs::rename(&backup_path, file_path);
                let _ = fs::remove_file(&temp_path);
                return Err(format!("替换文件失败：{}", error));
            }
            let _ = fs::remove_file(backup_path);
        } else if let Err(error) = fs::rename(&temp_path, file_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("替换文件失败：{}", error));
        }
    }

    #[cfg(not(windows))]
    {
        if let Err(error) = fs::rename(&temp_path, file_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("替换文件失败：{}", error));
        }
    }

    let new_meta = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    Ok(FileStat {
        size: new_meta.len(),
        is_dir: false,
    })
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
    allowlist.ensure_writable(&path.to_string_lossy())?;
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
    allowlist.ensure_writable(&path.to_string_lossy())?;
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
    allowlist.ensure_writable(&path)?;
    let source = Path::new(&path);
    let parent = source
        .parent()
        .ok_or_else(|| "无法重命名该路径".to_string())?;
    let target = parent.join(&new_name);
    allowlist.ensure_writable(&target.to_string_lossy())?;
    if target.exists() {
        return Err("目标名称已存在".to_string());
    }
    fs::rename(source, &target).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_path(path: String, allowlist: State<'_, PathAllowlist>) -> Result<(), String> {
    allowlist.ensure_writable(&path)?;
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
    allowlist.ensure_writable(&path)?;
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
    let outside = allowlist
        .with_state(|state| crate::path_guard::outside_symlink_write_target(path, state))??;
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

        write_file_safely(&path, b"").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_files_larger_than_editor_limit() {
        assert!(!exceeds_editor_file_size_limit(MAX_EDITOR_FILE_SIZE));
        assert!(exceeds_editor_file_size_limit(MAX_EDITOR_FILE_SIZE + 1));
        assert_eq!(MAX_EDITOR_FILE_SIZE, 100 * 1024 * 1024);
        assert_eq!(MAX_PATCH_FILE_SIZE, 100 * 1024 * 1024);
        assert_eq!(MAX_VIEWER_FILE_SIZE, 500 * 1024 * 1024);
        assert!(!exceeds_patch_file_size_limit(MAX_PATCH_FILE_SIZE));
        assert!(exceeds_patch_file_size_limit(MAX_PATCH_FILE_SIZE + 1));
        assert!(!exceeds_viewer_file_size_limit(MAX_VIEWER_FILE_SIZE));
        assert!(exceeds_viewer_file_size_limit(MAX_VIEWER_FILE_SIZE + 1));
    }

    #[test]
    fn replace_file_range_rewrites_middle() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-replace-test-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.txt");
        let body = "AAAOLDBBB";
        fs::write(&path, body).unwrap();
        let start = 3u64;
        let end = 6u64;
        let stat =
            replace_file_range_inner(path.to_string_lossy().to_string(), start, end, "NEW".into())
                .unwrap();
        let next = fs::read_to_string(&path).unwrap();
        assert_eq!(next, "AAANEWBBB");
        assert_eq!(stat.size, next.len() as u64);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn trim_utf8_end_keeps_complete_characters() {
        let text = "你好".as_bytes();
        assert_eq!(trim_utf8_end(text), text.len());
        // Drop last continuation byte → trim incomplete char.
        let incomplete = &text[..text.len() - 1];
        assert_eq!(trim_utf8_end(incomplete), 3); // keeps first 你
    }

    #[test]
    fn read_file_slice_reads_window() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-slice-test-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.txt");
        fs::write(&path, "abcdefghijklmnopqrstuvwxyz").unwrap();

        let slice = read_file_slice_inner(path.to_string_lossy().to_string(), 10, 5).unwrap();
        assert_eq!(slice.text, "klmno");
        assert_eq!(slice.offset, 10);
        assert_eq!(slice.len, 5);
        assert!(!slice.eof);
        assert_eq!(slice.file_size, 26);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn find_line_offset_locates_line_starts() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-line-test-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.txt");
        // line1\nline2\nline3
        fs::write(&path, "aa\nbbb\nc").unwrap();
        let p = path.to_string_lossy().to_string();

        let l1 = find_line_offset_inner(p.clone(), 1).unwrap();
        assert!(l1.found);
        assert_eq!(l1.offset, 0);

        let l2 = find_line_offset_inner(p.clone(), 2).unwrap();
        assert!(l2.found);
        assert_eq!(l2.offset, 3); // after "aa\n"

        let l3 = find_line_offset_inner(p.clone(), 3).unwrap();
        assert!(l3.found);
        assert_eq!(l3.offset, 7); // after "aa\nbbb\n"

        let missing = find_line_offset_inner(p, 99).unwrap();
        assert!(!missing.found);
        assert_eq!(missing.total_lines, 3);
        assert_eq!(missing.offset, 7);

        fs::remove_dir_all(dir).unwrap();
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

        let err = read_file_inner(path.to_string_lossy().to_string(), None).unwrap_err();
        assert!(err.contains(".xlsx"), "{err}");
        assert!(err.contains("暂不支持"), "{err}");
        assert!(!err.to_ascii_lowercase().contains("utf-8"), "{err}");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn filename_search_finds_deep_files_and_honors_excludes() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-filename-search-test-{nonce}"));
        fs::create_dir_all(dir.join("src").join("components")).unwrap();
        fs::create_dir_all(dir.join("generated")).unwrap();
        fs::write(
            dir.join("src").join("components").join("Needle.tsx"),
            "export {}",
        )
        .unwrap();
        fs::write(
            dir.join("generated").join("Needle.generated.ts"),
            "export {}",
        )
        .unwrap();

        let excludes = vec!["**/generated".to_string()];
        let mut hits = Vec::new();
        walk_matching(
            &dir,
            &dir,
            &mut hits,
            50,
            "needle",
            true,
            true,
            false,
            None,
            Some(&excludes),
            false,
            false,
        );

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "Needle.tsx");
        assert!(hits[0].relative.contains("src"));
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

        let err = read_file_inner(path.to_string_lossy().to_string(), None).unwrap_err();
        assert!(err.contains("暂不支持"), "{err}");
        assert!(err.contains("mystery.dat"), "{err}");
        assert!(
            !err.to_ascii_lowercase().contains("stream did not contain"),
            "{err}"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn read_write_gbk_roundtrip() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-gbk-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.txt");
        // "中文" in GBK
        fs::write(&path, [0xD6u8, 0xD0, 0xCE, 0xC4]).unwrap();

        assert!(read_file_inner(path.to_string_lossy().to_string(), Some("utf8")).is_err());
        let text = read_file_inner(path.to_string_lossy().to_string(), Some("gbk")).unwrap();
        assert_eq!(text, "中文");

        let bytes = file_encoding::encode("测试", file_encoding::FileEncoding::Gbk).unwrap();
        write_file_safely(&path, &bytes).unwrap();
        let again = read_file_inner(path.to_string_lossy().to_string(), Some("gbk")).unwrap();
        assert_eq!(again, "测试");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_dir_respects_gitignore_when_enabled() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-scan-gi-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".gitignore"), "secret.txt\n").unwrap();
        fs::write(dir.join("keep.txt"), "k").unwrap();
        fs::write(dir.join("secret.txt"), "s").unwrap();
        let root = dir.to_string_lossy().to_string();

        let hidden = list_dir_one_level(&root, &root, None, true).unwrap();
        let names: Vec<_> = hidden.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"keep.txt"), "{names:?}");
        assert!(!names.contains(&"secret.txt"), "{names:?}");

        let shown = list_dir_one_level(&root, &root, None, false).unwrap();
        let names2: Vec<_> = shown.iter().map(|n| n.name.as_str()).collect();
        assert!(names2.contains(&"secret.txt"), "{names2:?}");

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
