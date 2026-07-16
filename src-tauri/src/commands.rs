use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

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

        // Skip common heavy/hidden entries to keep the tree snappy.
        if name.starts_with('.')
            || name == "node_modules"
            || name == "target"
            || name == "dist"
            || name == "build"
            || name == ".git"
        {
            continue;
        }

        let full_path = path.to_string_lossy().to_string();
        let is_dir = path.is_dir();

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

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub fn scan_directory(path: String) -> Result<Vec<FileNode>, String> {
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
    name.starts_with('.')
        || name == "node_modules"
        || name == "target"
        || name == "dist"
        || name == "build"
        || name == ".git"
        || name == ".next"
        || name == ".vscode"
        || name == ".idea"
}

fn walk_matching(
    root: &Path,
    base: &Path,
    out: &mut Vec<SearchHit>,
    limit: usize,
    query: &str,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
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
        let target_name = if ignore_case {
            name.to_lowercase()
        } else {
            name.clone()
        };
        let matched = if match_suffix {
            !is_dir && target_name.ends_with(query)
        } else if fuzzy {
            fuzzy_match(&target_name, query)
        } else {
            target_name.contains(query)
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

#[tauri::command]
pub fn search_files(
    root: String,
    query: String,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let base = Path::new(&root);
    if !base.is_dir() {
        return Ok(vec![]);
    }
    let max = limit.unwrap_or(500);
    let q = if ignore_case { query.to_lowercase() } else { query };
    // Suffix/extension match: query like ".ts" or "ts" matches foo.ts.
    let q = if match_suffix && !q.starts_with('.') {
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
        fuzzy,
        match_suffix,
    );
    Ok(hits)
}

const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_LINE_CHARS: usize = 300;
const DEFAULT_MAX_MATCHES: usize = 500;
const DEFAULT_MAX_FILES_SCANNED: usize = 8000;
const DEFAULT_MAX_MATCHES_PER_FILE: usize = 20;

#[derive(Debug, Serialize, Clone)]
pub struct ContentSearchMatch {
    pub line: u32,
    pub text: String,
    pub match_start: u32,
    pub match_end: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContentSearchFileResult {
    pub name: String,
    pub path: String,
    pub relative: String,
    pub matches: Vec<ContentSearchMatch>,
}

#[derive(Debug, Serialize)]
pub struct ContentSearchResponse {
    pub files: Vec<ContentSearchFileResult>,
    pub match_count: usize,
    pub files_scanned: usize,
    pub truncated: bool,
}

fn is_binary_extension(name: &str) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg"
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
    )
}

fn matches_extension(name: &str, extension: Option<&str>) -> bool {
    match extension {
        None => true,
        Some(ext) => {
            let want = ext.trim_start_matches('.');
            Path::new(name)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case(want))
        }
    }
}

fn find_match_range(haystack: &str, needle: &str, ignore_case: bool) -> Option<(usize, usize)> {
    if needle.is_empty() {
        return None;
    }
    if ignore_case {
        let h = haystack.to_lowercase();
        let n = needle.to_lowercase();
        h.find(&n).map(|start| (start, start + n.len()))
    } else {
        haystack.find(needle).map(|start| (start, start + needle.len()))
    }
}

fn truncate_line(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).chain(['…']).collect()
}

fn search_lines_in_file(
    path: &Path,
    query: &str,
    ignore_case: bool,
    max_per_file: usize,
) -> Vec<ContentSearchMatch> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return vec![],
    };
    if meta.len() > MAX_FILE_BYTES {
        return vec![];
    }

    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };

    let reader = BufReader::new(file);
    let mut matches = Vec::new();

    for (idx, line_result) in reader.lines().enumerate() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.contains('\0') {
            break;
        }
        if let Some((start, end)) = find_match_range(&line, query, ignore_case) {
            matches.push(ContentSearchMatch {
                line: (idx + 1) as u32,
                text: truncate_line(&line, MAX_LINE_CHARS),
                match_start: start as u32,
                match_end: end as u32,
            });
            if matches.len() >= max_per_file {
                break;
            }
        }
    }

    matches
}

struct ContentSearchState {
    max_matches: usize,
    max_files_scanned: usize,
    max_matches_per_file: usize,
    match_count: usize,
    files_scanned: usize,
    truncated: bool,
}

fn walk_and_search_content(
    root: &Path,
    base: &Path,
    query: &str,
    ignore_case: bool,
    extension: Option<&str>,
    state: &mut ContentSearchState,
    results: &mut Vec<ContentSearchFileResult>,
) {
    if state.truncated {
        return;
    }

    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if state.truncated {
            return;
        }

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_entry(&name) {
            continue;
        }

        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            walk_and_search_content(
                &path,
                base,
                query,
                ignore_case,
                extension,
                state,
                results,
            );
            continue;
        }

        if !matches_extension(&name, extension) || is_binary_extension(&name) {
            continue;
        }

        state.files_scanned += 1;
        if state.files_scanned > state.max_files_scanned {
            state.truncated = true;
            return;
        }

        let file_matches = search_lines_in_file(
            &path,
            query,
            ignore_case,
            state.max_matches_per_file,
        );
        if file_matches.is_empty() {
            continue;
        }

        let full = path.to_string_lossy().to_string();
        let relative = path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| full.clone());

        let remaining = state.max_matches.saturating_sub(state.match_count);
        let take = file_matches.len().min(remaining);
        let taken = file_matches.into_iter().take(take).collect::<Vec<_>>();
        state.match_count += taken.len();

        results.push(ContentSearchFileResult {
            name: name.clone(),
            path: full.clone(),
            relative,
            matches: taken,
        });

        if state.match_count >= state.max_matches {
            state.truncated = true;
            return;
        }
    }
}

#[tauri::command]
pub fn search_file_contents(
    root: String,
    query: String,
    ignore_case: bool,
    extension: Option<String>,
    max_matches: Option<usize>,
    max_files_scanned: Option<usize>,
    max_matches_per_file: Option<usize>,
) -> Result<ContentSearchResponse, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(ContentSearchResponse {
            files: vec![],
            match_count: 0,
            files_scanned: 0,
            truncated: false,
        });
    }

    let base = Path::new(&root);
    if !base.is_dir() {
        return Ok(ContentSearchResponse {
            files: vec![],
            match_count: 0,
            files_scanned: 0,
            truncated: false,
        });
    }

    let ext = extension
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut state = ContentSearchState {
        max_matches: max_matches.unwrap_or(DEFAULT_MAX_MATCHES),
        max_files_scanned: max_files_scanned.unwrap_or(DEFAULT_MAX_FILES_SCANNED),
        max_matches_per_file: max_matches_per_file.unwrap_or(DEFAULT_MAX_MATCHES_PER_FILE),
        match_count: 0,
        files_scanned: 0,
        truncated: false,
    };

    let mut results: Vec<ContentSearchFileResult> = Vec::new();

    walk_and_search_content(
        base,
        base,
        trimmed,
        ignore_case,
        ext,
        &mut state,
        &mut results,
    );

    Ok(ContentSearchResponse {
        files: results,
        match_count: state.match_count,
        files_scanned: state.files_scanned,
        truncated: state.truncated,
    })
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        Err("名称不能为空或包含路径分隔符".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn create_file(parent: String, name: String) -> Result<String, String> {
    validate_entry_name(&name)?;
    let parent_path = Path::new(&parent);
    if !parent_path.is_dir() {
        return Err(format!("目录不可用: {}", parent));
    }
    let path = parent_path.join(name);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("新建文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_directory(parent: String, name: String) -> Result<String, String> {
    validate_entry_name(&name)?;
    let parent_path = Path::new(&parent);
    if !parent_path.is_dir() {
        return Err(format!("目录不可用: {}", parent));
    }
    let path = parent_path.join(name);
    fs::create_dir(&path).map_err(|e| format!("新建文件夹失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    validate_entry_name(&new_name)?;
    let source = Path::new(&path);
    let parent = source
        .parent()
        .ok_or_else(|| "无法重命名该路径".to_string())?;
    let target = parent.join(new_name);
    if target.exists() {
        return Err("目标名称已存在".to_string());
    }
    fs::rename(source, &target).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    let metadata = fs::symlink_metadata(target).map_err(|e| format!("读取路径失败: {}", e))?;
    if metadata.is_dir() {
        fs::remove_dir_all(target).map_err(|e| format!("删除文件夹失败: {}", e))
    } else {
        fs::remove_file(target).map_err(|e| format!("删除文件失败: {}", e))
    }
}
