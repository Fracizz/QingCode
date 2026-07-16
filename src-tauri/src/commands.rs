use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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

#[tauri::command]
pub fn search_files(
    root: String,
    query: String,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
    extension: Option<String>,
    extensions: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
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
    )
}

fn matches_extension(name: &str, extension: Option<&str>, extensions: Option<&[String]>) -> bool {
    if let Some(exts) = extensions {
        return matches_extensions(name, Some(exts));
    }
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
        haystack
            .find(needle)
            .map(|start| (start, start + needle.len()))
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
    extensions: Option<&[String]>,
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
                extensions,
                state,
                results,
            );
            continue;
        }

        if !matches_extension(&name, extension, extensions) || is_binary_extension(&name) {
            continue;
        }

        state.files_scanned += 1;
        if state.files_scanned > state.max_files_scanned {
            state.truncated = true;
            return;
        }

        let file_matches =
            search_lines_in_file(&path, query, ignore_case, state.max_matches_per_file);
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
    extensions: Option<Vec<String>>,
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
    let ext_list =
        normalize_extensions(extensions.or_else(|| ext.map(|single| vec![single.to_string()])));

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
        None,
        ext_list.as_deref(),
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
}
