use crate::content_search;
use crate::content_search::{
    ContentSearchOptions, ContentSearchResponse, DEFAULT_MAX_FILES_SCANNED, DEFAULT_MAX_MATCHES,
    DEFAULT_MAX_MATCHES_PER_FILE,
};
use crate::exclude;
use crate::path_guard::PathAllowlist;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::State;

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
            format!(".{q}")
        };
        return target_name.ends_with(&suffix);
    }
    if fuzzy {
        return fuzzy_match(&target_name, &q);
    }
    target_name.contains(&q)
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
            | "pyc"
            | "pyo"
            | "pyd"
            | "class"
            | "o"
            | "obj"
            | "typed"
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
        format!(".{q}")
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
