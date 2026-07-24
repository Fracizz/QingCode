//! Lightweight, search-based code navigation powered by Tree-sitter tags.
//!
//! This intentionally extracts syntax-level definitions and call references.
//! Name binding and candidate ranking stay in the frontend so the feature
//! remains useful without a language server or compiler-grade project model.

use crate::path_guard::PathAllowlist;
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;
use tauri::State;
use tree_sitter::Language;
use tree_sitter_tags::{TagsConfiguration, TagsContext};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_FILES: usize = 8000;
const DEFAULT_MAX_RESULTS: usize = 80;
const MAX_CACHE_FILES: usize = 12_000;
const JAVASCRIPT_VARIABLE_TAGS: &str = r#"
(program
  (lexical_declaration
    (variable_declarator name: (identifier) @name) @definition.variable))
(program
  (variable_declaration
    (variable_declarator name: (identifier) @name) @definition.variable))
(export_statement
  (lexical_declaration
    (variable_declarator name: (identifier) @name) @definition.variable))
"#;
const RUST_VALUE_TAGS: &str = r#"
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
"#;

#[derive(Debug, Clone)]
struct CachedTag {
    name: String,
    kind: String,
    is_definition: bool,
    range_start: usize,
    range_end: usize,
    line: u32,
    column: u32,
    text: String,
}

#[derive(Debug, Clone)]
struct CachedFile {
    modified: Option<SystemTime>,
    len: u64,
    tags: Vec<CachedTag>,
}

#[derive(Clone, Default)]
pub struct SymbolSearchState {
    files: Arc<Mutex<HashMap<PathBuf, CachedFile>>>,
    generation: Arc<AtomicUsize>,
}

impl SymbolSearchState {
    pub fn new() -> Self {
        Self::default()
    }

    fn begin_search(&self) -> usize {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, generation: usize) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    fn cached(&self, path: &Path, modified: Option<SystemTime>, len: u64) -> Option<CachedFile> {
        self.files
            .lock()
            .ok()?
            .get(path)
            .filter(|entry| entry.modified == modified && entry.len == len)
            .cloned()
    }

    fn insert(&self, path: PathBuf, entry: CachedFile) {
        let Ok(mut files) = self.files.lock() else {
            return;
        };
        if files.len() >= MAX_CACHE_FILES {
            files.clear();
        }
        files.insert(path, entry);
    }
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolDefinition {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub relative: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearchResponse {
    pub definitions: Vec<SymbolDefinition>,
    pub files_scanned: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolReference {
    pub name: String,
    pub kind: String,
    pub caller_name: Option<String>,
    pub caller_kind: Option<String>,
    pub path: String,
    pub relative: String,
    pub line: u32,
    pub column: u32,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolReferenceResponse {
    pub references: Vec<SymbolReference>,
    pub files_scanned: usize,
    pub truncated: bool,
}

fn configuration(
    language: Language,
    tags_query: &str,
    locals_query: &str,
) -> Result<TagsConfiguration, String> {
    TagsConfiguration::new(language, tags_query, locals_query).map_err(|error| error.to_string())
}

fn javascript_configuration() -> Result<&'static TagsConfiguration, String> {
    static CONFIG: OnceLock<Result<TagsConfiguration, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let tags = format!(
                "{}\n{}",
                tree_sitter_javascript::TAGS_QUERY,
                JAVASCRIPT_VARIABLE_TAGS
            );
            configuration(
                tree_sitter_javascript::LANGUAGE.into(),
                &tags,
                tree_sitter_javascript::LOCALS_QUERY,
            )
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn typescript_configuration(tsx: bool) -> Result<&'static TagsConfiguration, String> {
    static TS_CONFIG: OnceLock<Result<TagsConfiguration, String>> = OnceLock::new();
    static TSX_CONFIG: OnceLock<Result<TagsConfiguration, String>> = OnceLock::new();
    let config = if tsx {
        TSX_CONFIG.get_or_init(|| {
            let tags = format!(
                "{}\n{}\n{}",
                tree_sitter_javascript::TAGS_QUERY,
                tree_sitter_typescript::TAGS_QUERY,
                JAVASCRIPT_VARIABLE_TAGS
            );
            let locals = format!(
                "{}\n{}",
                tree_sitter_javascript::LOCALS_QUERY,
                tree_sitter_typescript::LOCALS_QUERY
            );
            configuration(tree_sitter_typescript::LANGUAGE_TSX.into(), &tags, &locals)
        })
    } else {
        TS_CONFIG.get_or_init(|| {
            let tags = format!(
                "{}\n{}\n{}",
                tree_sitter_javascript::TAGS_QUERY,
                tree_sitter_typescript::TAGS_QUERY,
                JAVASCRIPT_VARIABLE_TAGS
            );
            let locals = format!(
                "{}\n{}",
                tree_sitter_javascript::LOCALS_QUERY,
                tree_sitter_typescript::LOCALS_QUERY
            );
            configuration(
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
                &tags,
                &locals,
            )
        })
    };
    config.as_ref().map_err(Clone::clone)
}

fn rust_configuration() -> Result<&'static TagsConfiguration, String> {
    static CONFIG: OnceLock<Result<TagsConfiguration, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let tags = format!("{}\n{}", tree_sitter_rust::TAGS_QUERY, RUST_VALUE_TAGS);
            configuration(tree_sitter_rust::LANGUAGE.into(), &tags, "")
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn python_configuration() -> Result<&'static TagsConfiguration, String> {
    static CONFIG: OnceLock<Result<TagsConfiguration, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            configuration(
                tree_sitter_python::LANGUAGE.into(),
                tree_sitter_python::TAGS_QUERY,
                "",
            )
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn go_configuration() -> Result<&'static TagsConfiguration, String> {
    static CONFIG: OnceLock<Result<TagsConfiguration, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            configuration(
                tree_sitter_go::LANGUAGE.into(),
                tree_sitter_go::TAGS_QUERY,
                "",
            )
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn java_configuration() -> Result<&'static TagsConfiguration, String> {
    static CONFIG: OnceLock<Result<TagsConfiguration, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            configuration(
                tree_sitter_java::LANGUAGE.into(),
                tree_sitter_java::TAGS_QUERY,
                "",
            )
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn configuration_for_path(path: &Path) -> Result<Option<&'static TagsConfiguration>, String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "js" | "jsx" | "mjs" | "cjs" => javascript_configuration().map(Some),
        "ts" | "mts" | "cts" => typescript_configuration(false).map(Some),
        "tsx" => typescript_configuration(true).map(Some),
        "rs" => rust_configuration().map(Some),
        "py" | "pyw" => python_configuration().map(Some),
        "go" => go_configuration().map(Some),
        "java" => java_configuration().map(Some),
        _ => Ok(None),
    }
}

fn line_text(source: &[u8], range: std::ops::Range<usize>) -> String {
    String::from_utf8_lossy(source.get(range).unwrap_or_default())
        .trim()
        .chars()
        .take(240)
        .collect()
}

fn extract_tags(
    context: &mut TagsContext,
    path: &Path,
    source: &[u8],
) -> Result<Vec<CachedTag>, String> {
    let Some(config) = configuration_for_path(path)? else {
        return Ok(Vec::new());
    };
    let (tags, _) = context
        .generate_tags(config, source, None)
        .map_err(|error| error.to_string())?;
    let mut extracted = Vec::new();
    for tag in tags {
        let tag = tag.map_err(|error| error.to_string())?;
        let Some(name) = source.get(tag.name_range.clone()) else {
            continue;
        };
        let name = String::from_utf8_lossy(name).into_owned();
        if name.is_empty() {
            continue;
        }
        extracted.push(CachedTag {
            name,
            kind: config.syntax_type_name(tag.syntax_type_id).to_string(),
            is_definition: tag.is_definition,
            range_start: tag.range.start,
            range_end: tag.range.end,
            line: tag.span.start.row.saturating_add(1) as u32,
            column: tag.utf16_column_range.start.saturating_add(1) as u32,
            text: line_text(source, tag.line_range),
        });
    }
    let mut seen = std::collections::HashSet::new();
    extracted.retain(|tag| {
        seen.insert((
            tag.name.clone(),
            tag.kind.clone(),
            tag.is_definition,
            tag.line,
            tag.column,
        ))
    });
    Ok(extracted)
}

fn load_tags(
    state: &SymbolSearchState,
    context: &mut TagsContext,
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<Vec<CachedTag>, String> {
    let modified = metadata.modified().ok();
    let len = metadata.len();
    if let Some(entry) = state.cached(path, modified, len) {
        return Ok(entry.tags);
    }

    let source = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let tags = extract_tags(context, path, &source)?;
    state.insert(
        path.to_path_buf(),
        CachedFile {
            modified,
            len,
            tags: tags.clone(),
        },
    );
    Ok(tags)
}

#[cfg(test)]
fn extract_definitions(
    context: &mut TagsContext,
    path: &Path,
    source: &[u8],
) -> Result<Vec<CachedTag>, String> {
    Ok(extract_tags(context, path, source)?
        .into_iter()
        .filter(|tag| tag.is_definition)
        .collect())
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn valid_symbol_name(symbol: &str) -> bool {
    let mut chars = symbol.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    symbol.chars().count() <= 160
        && (first == '_' || first == '$' || first.is_alphabetic())
        && chars.all(|ch| ch == '_' || ch == '$' || ch.is_alphanumeric())
}

struct ScanResult<T> {
    items: Vec<T>,
    files_scanned: usize,
    truncated: bool,
}

fn scan_workspace<T, F>(
    state: &SymbolSearchState,
    root: &Path,
    max_results: usize,
    max_files: usize,
    generation: Option<usize>,
    collect: F,
) -> Result<ScanResult<T>, String>
where
    T: Send,
    F: Fn(&Path, &[CachedTag]) -> Vec<T> + Sync,
{
    if !root.is_dir() {
        return Err(format!("项目目录不存在: {}", root.display()));
    }

    let results = Mutex::new(Vec::new());
    let files_scanned = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let should_quit = AtomicBool::new(false);
    let max_results = max_results.clamp(1, 200);
    let max_files = max_files.clamp(1, 50_000);

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .threads(
            std::thread::available_parallelism()
                .map(|count| count.get().clamp(2, 8))
                .unwrap_or(4),
        )
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".git"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".next"
                    | "coverage"
                    | "vendor"
                    | ".pnpm"
                    | "out"
                    | ".turbo"
                    | ".cache"
            )
        });
    builder.add_custom_ignore_filename(".gitignore");

    builder.build_parallel().run(|| {
        let mut context = TagsContext::new();
        let results = &results;
        let files_scanned = &files_scanned;
        let truncated = &truncated;
        let should_quit = &should_quit;
        let collect = &collect;
        Box::new(move |entry| {
            if should_quit.load(Ordering::Relaxed)
                || generation.is_some_and(|generation| !state.is_current(generation))
            {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let path = entry.path();
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            let Ok(Some(_)) = configuration_for_path(path) else {
                return WalkState::Continue;
            };

            let scanned = files_scanned.fetch_add(1, Ordering::Relaxed) + 1;
            if scanned > max_files {
                truncated.store(true, Ordering::Relaxed);
                should_quit.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let Ok(metadata) = entry.metadata() else {
                return WalkState::Continue;
            };
            if metadata.len() > MAX_FILE_BYTES {
                return WalkState::Continue;
            }
            let Ok(tags) = load_tags(state, &mut context, path, &metadata) else {
                return WalkState::Continue;
            };

            for item in collect(path, &tags) {
                let Ok(mut output) = results.lock() else {
                    return WalkState::Quit;
                };
                if output.len() >= max_results {
                    truncated.store(true, Ordering::Relaxed);
                    should_quit.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
                output.push(item);
            }
            WalkState::Continue
        })
    });

    Ok(ScanResult {
        items: results.into_inner().unwrap_or_default(),
        files_scanned: files_scanned.load(Ordering::Relaxed).min(max_files),
        truncated: truncated.load(Ordering::Relaxed),
    })
}

fn tag_to_definition(root: &Path, path: &Path, tag: &CachedTag) -> SymbolDefinition {
    SymbolDefinition {
        name: tag.name.clone(),
        kind: tag.kind.clone(),
        path: path.to_string_lossy().into_owned(),
        relative: relative_path(root, path),
        line: tag.line,
        column: tag.column,
        text: tag.text.clone(),
    }
}

pub fn search_definitions(
    state: &SymbolSearchState,
    root: &Path,
    symbol: &str,
    max_results: usize,
    max_files: usize,
    generation: Option<usize>,
) -> Result<SymbolSearchResponse, String> {
    if !valid_symbol_name(symbol) {
        return Ok(SymbolSearchResponse {
            definitions: Vec::new(),
            files_scanned: 0,
            truncated: false,
        });
    }
    let scan = scan_workspace(
        state,
        root,
        max_results,
        max_files,
        generation,
        |path, tags| {
            tags.iter()
                .filter(|tag| tag.is_definition && tag.name == symbol)
                .map(|tag| tag_to_definition(root, path, tag))
                .collect()
        },
    )?;
    let mut definitions = scan.items;
    definitions.sort_by(|left, right| {
        left.relative
            .cmp(&right.relative)
            .then(left.line.cmp(&right.line))
    });
    Ok(SymbolSearchResponse {
        definitions,
        files_scanned: scan.files_scanned,
        truncated: scan.truncated,
    })
}

fn enclosing_caller<'a>(tags: &'a [CachedTag], reference: &CachedTag) -> Option<&'a CachedTag> {
    tags.iter()
        .filter(|candidate| {
            candidate.is_definition
                && matches!(
                    candidate.kind.as_str(),
                    "function" | "method" | "constructor" | "macro"
                )
                && candidate.range_start <= reference.range_start
                && candidate.range_end >= reference.range_end
        })
        .min_by_key(|candidate| candidate.range_end.saturating_sub(candidate.range_start))
}

pub fn search_references(
    state: &SymbolSearchState,
    root: &Path,
    symbol: &str,
    max_results: usize,
    max_files: usize,
    generation: Option<usize>,
) -> Result<SymbolReferenceResponse, String> {
    if !valid_symbol_name(symbol) {
        return Ok(SymbolReferenceResponse {
            references: Vec::new(),
            files_scanned: 0,
            truncated: false,
        });
    }
    let scan = scan_workspace(
        state,
        root,
        max_results,
        max_files,
        generation,
        |path, tags| {
            tags.iter()
                .filter(|tag| !tag.is_definition && tag.name == symbol && tag.kind == "call")
                .map(|reference| {
                    let caller = enclosing_caller(tags, reference);
                    SymbolReference {
                        name: reference.name.clone(),
                        kind: reference.kind.clone(),
                        caller_name: caller.map(|tag| tag.name.clone()),
                        caller_kind: caller.map(|tag| tag.kind.clone()),
                        path: path.to_string_lossy().into_owned(),
                        relative: relative_path(root, path),
                        line: reference.line,
                        column: reference.column,
                        text: reference.text.clone(),
                    }
                })
                .collect()
        },
    )?;
    let mut references = scan.items;
    references.sort_by(|left, right| {
        left.relative
            .cmp(&right.relative)
            .then(left.line.cmp(&right.line))
    });
    Ok(SymbolReferenceResponse {
        references,
        files_scanned: scan.files_scanned,
        truncated: scan.truncated,
    })
}

pub fn search_workspace_definitions(
    state: &SymbolSearchState,
    root: &Path,
    query: &str,
    max_results: usize,
    max_files: usize,
    generation: Option<usize>,
) -> Result<SymbolSearchResponse, String> {
    let query = query.trim().to_lowercase();
    if query.chars().count() > 160 {
        return Ok(SymbolSearchResponse {
            definitions: Vec::new(),
            files_scanned: 0,
            truncated: false,
        });
    }
    let scan = scan_workspace(
        state,
        root,
        max_results,
        max_files,
        generation,
        |path, tags| {
            tags.iter()
                .filter(|tag| {
                    tag.is_definition
                        && (query.is_empty() || tag.name.to_lowercase().contains(&query))
                })
                .map(|tag| tag_to_definition(root, path, tag))
                .collect()
        },
    )?;
    let mut definitions = scan.items;
    definitions.sort_by(|left, right| {
        let left_exact = !query.is_empty() && left.name.eq_ignore_ascii_case(&query);
        let right_exact = !query.is_empty() && right.name.eq_ignore_ascii_case(&query);
        right_exact
            .cmp(&left_exact)
            .then(left.name.len().cmp(&right.name.len()))
            .then(left.relative.cmp(&right.relative))
            .then(left.line.cmp(&right.line))
    });
    Ok(SymbolSearchResponse {
        definitions,
        files_scanned: scan.files_scanned,
        truncated: scan.truncated,
    })
}

#[tauri::command]
pub async fn search_symbol_definitions(
    root: String,
    symbol: String,
    max_results: Option<usize>,
    max_files: Option<usize>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SymbolSearchState>,
) -> Result<SymbolSearchResponse, String> {
    allowlist.ensure_allowed(&root)?;
    let state = state.inner().clone();
    let generation = state.begin_search();
    let symbol = symbol.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        search_definitions(
            &state,
            Path::new(&root),
            &symbol,
            max_results.unwrap_or(DEFAULT_MAX_RESULTS),
            max_files.unwrap_or(DEFAULT_MAX_FILES),
            Some(generation),
        )
    })
    .await
    .map_err(|error| format!("符号搜索任务失败: {error}"))?
}

#[tauri::command]
pub async fn search_symbol_references(
    root: String,
    symbol: String,
    max_results: Option<usize>,
    max_files: Option<usize>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SymbolSearchState>,
) -> Result<SymbolReferenceResponse, String> {
    allowlist.ensure_allowed(&root)?;
    let state = state.inner().clone();
    let generation = state.begin_search();
    let symbol = symbol.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        search_references(
            &state,
            Path::new(&root),
            &symbol,
            max_results.unwrap_or(DEFAULT_MAX_RESULTS),
            max_files.unwrap_or(DEFAULT_MAX_FILES),
            Some(generation),
        )
    })
    .await
    .map_err(|error| format!("调用搜索任务失败: {error}"))?
}

#[tauri::command]
pub async fn search_workspace_symbols(
    root: String,
    query: String,
    max_results: Option<usize>,
    max_files: Option<usize>,
    allowlist: State<'_, PathAllowlist>,
    state: State<'_, SymbolSearchState>,
) -> Result<SymbolSearchResponse, String> {
    allowlist.ensure_allowed(&root)?;
    let state = state.inner().clone();
    let generation = state.begin_search();
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_definitions(
            &state,
            Path::new(&root),
            &query,
            max_results.unwrap_or(DEFAULT_MAX_RESULTS),
            max_files.unwrap_or(DEFAULT_MAX_FILES),
            Some(generation),
        )
    })
    .await
    .map_err(|error| format!("工作区符号搜索任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("qingcode-symbol-{name}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn extracts_typescript_definitions_without_comments_or_strings() {
        let path = Path::new("sample.ts");
        let source = br#"
// function ignored() {}
const text = "class AlsoIgnored {}"
export function target() {}
export class Widget {}
export const shared = 1
"#;
        let definitions = extract_definitions(&mut TagsContext::new(), path, source).unwrap();
        assert!(definitions.iter().any(|item| item.name == "target"));
        assert!(definitions.iter().any(|item| item.name == "Widget"));
        assert!(definitions
            .iter()
            .any(|item| item.name == "shared" && item.kind == "variable"));
        assert!(!definitions.iter().any(|item| item.name == "ignored"));
        assert!(!definitions.iter().any(|item| item.name == "AlsoIgnored"));
    }

    #[test]
    fn initializes_every_supported_language_and_extracts_a_definition() {
        let cases: [(&str, &[u8], &str); 7] = [
            ("sample.js", b"function target() {}", "target"),
            (
                "sample.tsx",
                b"export function Target() { return <div /> }",
                "Target",
            ),
            ("sample.rs", b"fn target() {}", "target"),
            ("sample.py", b"def target():\n  pass\n", "target"),
            ("sample.go", b"package demo\nfunc Target() {}\n", "Target"),
            (
                "Sample.java",
                b"class Sample { void target() {} }",
                "target",
            ),
            ("sample.ts", b"interface Target {}", "Target"),
        ];
        let mut context = TagsContext::new();
        for (path, source, expected) in cases {
            let definitions = extract_definitions(&mut context, Path::new(path), source)
                .unwrap_or_else(|error| panic!("{path} configuration failed: {error}"));
            assert!(
                definitions.iter().any(|item| item.name == expected),
                "{path} did not extract {expected}: {definitions:?}"
            );
        }
    }

    #[test]
    fn extracts_call_references_with_the_enclosing_caller() {
        let path = Path::new("sample.ts");
        let source = b"function target() {}\nfunction caller() {\n  target()\n}\n";
        let tags = extract_tags(&mut TagsContext::new(), path, source).unwrap();
        let reference = tags
            .iter()
            .find(|tag| !tag.is_definition && tag.name == "target" && tag.kind == "call")
            .expect("target call should be tagged");
        let caller = enclosing_caller(&tags, reference).expect("call should have a caller");
        assert_eq!(caller.name, "caller");
        assert_eq!(caller.kind, "function");
    }

    #[test]
    fn searches_supported_files_and_ignores_build_directories() {
        let root = temp_dir("workspace");
        fs::write(root.join("main.rs"), "pub fn target() {}\n").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("target").join("generated.rs"), "fn target() {}\n").unwrap();

        let response =
            search_definitions(&SymbolSearchState::new(), &root, "target", 20, 100, None).unwrap();
        assert_eq!(response.definitions.len(), 1);
        assert_eq!(response.definitions[0].relative, "main.rs");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn searches_calls_and_workspace_symbols_from_the_shared_cache() {
        let root = temp_dir("references");
        fs::write(
            root.join("main.ts"),
            "export function target() {}\nexport function caller() { target() }\n",
        )
        .unwrap();
        let state = SymbolSearchState::new();

        let references = search_references(&state, &root, "target", 20, 100, None).unwrap();
        assert_eq!(references.references.len(), 1);
        assert_eq!(
            references.references[0].caller_name.as_deref(),
            Some("caller")
        );

        let symbols = search_workspace_definitions(&state, &root, "call", 20, 100, None).unwrap();
        assert_eq!(symbols.definitions.len(), 1);
        assert_eq!(symbols.definitions[0].name, "caller");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_non_identifier_queries() {
        assert!(!valid_symbol_name(""));
        assert!(!valid_symbol_name("../secret"));
        assert!(valid_symbol_name("_valid42"));
        assert!(valid_symbol_name("中文名称"));
    }
}
