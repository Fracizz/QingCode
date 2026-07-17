//! Project content search backed by the ripgrep stack (`ignore` + `grep-searcher`).

use crate::exclude;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_LINE_CHARS: usize = 300;
pub const DEFAULT_MAX_MATCHES: usize = 500;
pub const DEFAULT_MAX_FILES_SCANNED: usize = 8000;
pub const DEFAULT_MAX_MATCHES_PER_FILE: usize = 20;

/// Global search generation for Tauri cancel / multi-root sessions.
static SEARCH_GENERATION: AtomicU64 = AtomicU64::new(0);

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

#[derive(Debug, Serialize, Clone)]
pub struct ContentSearchResponse {
    pub files: Vec<ContentSearchFileResult>,
    pub match_count: usize,
    pub files_scanned: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Clone)]
pub struct ContentSearchOptions {
    pub query: String,
    pub ignore_case: bool,
    pub extensions: Option<Vec<String>>,
    pub max_matches: usize,
    pub max_files_scanned: usize,
    pub max_matches_per_file: usize,
    /// When `Some`, apply VS Code–style exclude globs (relative to search root).
    /// When `None`, fall back to built-in hard-ignored directory names.
    pub exclude_patterns: Option<Vec<String>>,
}

/// Invalidate in-flight searches and return a fresh search id for the next query.
pub fn start_content_search() -> u64 {
    SEARCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Invalidate in-flight searches without starting a new one.
pub fn cancel_content_search() {
    SEARCH_GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn is_search_current(search_id: u64) -> bool {
    SEARCH_GENERATION.load(Ordering::SeqCst) == search_id
}

fn is_hard_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".git"
            | ".next"
            | "coverage"
            | "vendor"
            | ".pnpm"
            | "out"
            | ".turbo"
            | ".cache"
    )
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
    )
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

fn truncate_line(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).chain(['…']).collect()
}

fn escape_literal(query: &str) -> String {
    let mut out = String::with_capacity(query.len() * 2);
    for ch in query.chars() {
        match ch {
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$'
            | '#' | '&' | '~' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn build_matcher(query: &str, ignore_case: bool) -> Result<RegexMatcher, String> {
    let escaped = escape_literal(query);
    RegexMatcherBuilder::new()
        .case_insensitive(ignore_case)
        .build(&escaped)
        .map_err(|e| format!("invalid search pattern: {e}"))
}

struct CollectSink<'a> {
    matcher: &'a RegexMatcher,
    max_per_file: usize,
    matches: &'a mut Vec<ContentSearchMatch>,
    should_quit: &'a AtomicBool,
}

impl Sink for CollectSink<'_> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.should_quit.load(Ordering::Relaxed) {
            return Ok(false);
        }
        if self.matches.len() >= self.max_per_file {
            return Ok(false);
        }

        let line_bytes = mat.bytes();
        let line = String::from_utf8_lossy(line_bytes);
        let line = line.trim_end_matches(['\r', '\n']);
        let Ok(Some(m)) = self.matcher.find(line.as_bytes()) else {
            return Ok(true);
        };
        let start = m.start();
        let end = m.end();
        let text = truncate_line(line, MAX_LINE_CHARS);
        let match_start = start.min(text.len()) as u32;
        let match_end = end.min(text.len()) as u32;
        self.matches.push(ContentSearchMatch {
            line: mat.line_number().unwrap_or(0) as u32,
            text,
            match_start,
            match_end,
        });
        Ok(self.matches.len() < self.max_per_file)
    }
}

struct SharedState {
    search_id: u64,
    /// External cancel token; when true, search stops and reports `cancelled`.
    cancel_flag: Option<Arc<AtomicBool>>,
    should_quit: AtomicBool,
    max_matches: usize,
    max_files_scanned: usize,
    max_matches_per_file: usize,
    match_count: Mutex<usize>,
    files_scanned: Mutex<usize>,
    truncated: AtomicBool,
    results: Mutex<Vec<ContentSearchFileResult>>,
}

impl SharedState {
    fn cancelled_externally(&self) -> bool {
        if let Some(flag) = &self.cancel_flag {
            return flag.load(Ordering::SeqCst);
        }
        // search_id == 0 means "no global session" (unit tests / uncancellable).
        if self.search_id == 0 {
            return false;
        }
        !is_search_current(self.search_id)
    }

    fn check_quit(&self) -> bool {
        if self.should_quit.load(Ordering::Relaxed) {
            return true;
        }
        if self.cancelled_externally() {
            self.should_quit.store(true, Ordering::Relaxed);
            return true;
        }
        false
    }

    fn note_truncated(&self) {
        self.truncated.store(true, Ordering::Relaxed);
        self.should_quit.store(true, Ordering::Relaxed);
    }
}

/// Search file contents under `root`.
///
/// `search_id` should come from [`start_content_search`] for UI-driven searches.
/// Pass `0` to ignore the global generation (optionally pair with `cancel_flag` in tests).
pub fn search_file_contents(
    root: &Path,
    options: ContentSearchOptions,
    search_id: u64,
    cancel_flag: Option<Arc<AtomicBool>>,
) -> ContentSearchResponse {
    let trimmed = options.query.trim();
    if trimmed.is_empty() {
        return ContentSearchResponse {
            files: vec![],
            match_count: 0,
            files_scanned: 0,
            truncated: false,
            cancelled: false,
        };
    }
    if !root.is_dir() {
        return ContentSearchResponse {
            files: vec![],
            match_count: 0,
            files_scanned: 0,
            truncated: false,
            cancelled: false,
        };
    }

    let matcher = match build_matcher(trimmed, options.ignore_case) {
        Ok(m) => m,
        Err(_) => {
            return ContentSearchResponse {
                files: vec![],
                match_count: 0,
                files_scanned: 0,
                truncated: false,
                cancelled: false,
            };
        }
    };

    let state = Arc::new(SharedState {
        search_id,
        cancel_flag,
        should_quit: AtomicBool::new(false),
        max_matches: options.max_matches.max(1),
        max_files_scanned: options.max_files_scanned.max(1),
        max_matches_per_file: options.max_matches_per_file.max(1),
        match_count: Mutex::new(0),
        files_scanned: Mutex::new(0),
        truncated: AtomicBool::new(false),
        results: Mutex::new(Vec::new()),
    });

    let root_buf = root.to_path_buf();
    let extensions = options.extensions.clone();
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8))
        .unwrap_or(4);

    let root_str = root_buf.to_string_lossy().to_string();
    let exclude_patterns = options.exclude_patterns.clone();

    let mut builder = WalkBuilder::new(&root_buf);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        // Apply root `.gitignore` even when the folder is not a git checkout.
        .add_custom_ignore_filename(".gitignore")
        .threads(threads)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            let full = entry.path().to_string_lossy();
            match exclude_patterns.as_deref() {
                Some(patterns) => {
                    if let Some(rel) = exclude::relative_to_root(&root_str, &full) {
                        if !rel.is_empty() && exclude::is_path_excluded(&rel, patterns) {
                            return false;
                        }
                    } else if exclude::is_path_excluded(name.as_ref(), patterns) {
                        return false;
                    }
                    true
                }
                None => !is_hard_ignored_dir(&name),
            }
        });

    let walker = builder.build_parallel();
    walker.run(|| {
        let state = Arc::clone(&state);
        let matcher = matcher.clone();
        let root_buf = root_buf.clone();
        let extensions = extensions.clone();
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(b'\0'))
            .line_number(true)
            .build();

        Box::new(move |result| {
            use ignore::WalkState;

            if state.check_quit() {
                return WalkState::Quit;
            }

            let entry = match result {
                Ok(e) => e,
                Err(_) => return WalkState::Continue,
            };
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if is_binary_extension(&name) || !matches_extensions(&name, extensions.as_deref()) {
                return WalkState::Continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.len() > MAX_FILE_BYTES {
                    return WalkState::Continue;
                }
            }

            {
                let mut scanned = state.files_scanned.lock().unwrap();
                *scanned += 1;
                if *scanned > state.max_files_scanned {
                    state.note_truncated();
                    return WalkState::Quit;
                }
            }

            if state.check_quit() {
                return WalkState::Quit;
            }

            let mut file_matches = Vec::new();
            let sink = CollectSink {
                matcher: &matcher,
                max_per_file: state.max_matches_per_file,
                matches: &mut file_matches,
                should_quit: &state.should_quit,
            };
            let _ = searcher.search_path(&matcher, path, sink);
            if file_matches.is_empty() {
                return if state.check_quit() {
                    WalkState::Quit
                } else {
                    WalkState::Continue
                };
            }

            let full = path.to_string_lossy().to_string();
            let relative = path
                .strip_prefix(&root_buf)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| full.clone());

            {
                let mut match_count = state.match_count.lock().unwrap();
                let remaining = state.max_matches.saturating_sub(*match_count);
                if remaining == 0 {
                    state.note_truncated();
                    return WalkState::Quit;
                }
                let take = file_matches.len().min(remaining);
                let taken: Vec<_> = file_matches.into_iter().take(take).collect();
                *match_count += taken.len();
                state.results.lock().unwrap().push(ContentSearchFileResult {
                    name,
                    path: full,
                    relative,
                    matches: taken,
                });
                if *match_count >= state.max_matches {
                    state.note_truncated();
                    return WalkState::Quit;
                }
            }

            if state.check_quit() {
                WalkState::Quit
            } else {
                WalkState::Continue
            }
        })
    });

    let cancelled = state.cancelled_externally();
    let files = state.results.lock().unwrap().clone();
    let match_count = *state.match_count.lock().unwrap();
    let files_scanned = *state.files_scanned.lock().unwrap();

    ContentSearchResponse {
        files,
        match_count,
        files_scanned,
        truncated: state.truncated.load(Ordering::Relaxed) && !cancelled,
        cancelled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-csearch-{label}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn opts(query: &str) -> ContentSearchOptions {
        ContentSearchOptions {
            query: query.to_string(),
            ignore_case: true,
            extensions: None,
            max_matches: 100,
            max_files_scanned: 1000,
            max_matches_per_file: 20,
            exclude_patterns: None,
        }
    }

    #[test]
    fn respects_exclude_patterns_from_settings() {
        let dir = temp_dir("exclude-patterns");
        fs::create_dir_all(dir.join("keep")).unwrap();
        fs::create_dir_all(dir.join("secret")).unwrap();
        fs::write(dir.join("keep/a.txt"), "findme_keep\n").unwrap();
        fs::write(dir.join("secret/b.txt"), "findme_secret\n").unwrap();

        let mut o = opts("findme");
        o.exclude_patterns = Some(vec!["**/secret".to_string()]);
        let resp = search(&dir, o);
        let texts: Vec<_> = resp
            .files
            .iter()
            .flat_map(|f| f.matches.iter().map(|m| m.text.as_str()))
            .collect();
        assert!(
            texts.iter().any(|t| t.contains("findme_keep")),
            "keep/ should be searchable: {texts:?}"
        );
        assert!(
            !texts.iter().any(|t| t.contains("findme_secret")),
            "secret/ should be excluded: {texts:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn search(root: &Path, options: ContentSearchOptions) -> ContentSearchResponse {
        search_file_contents(root, options, 0, None)
    }

    #[test]
    fn finds_literal_match_in_file() {
        let dir = temp_dir("literal");
        fs::write(dir.join("a.rs"), "fn hello_world() {}\n").unwrap();

        let resp = search(&dir, opts("hello_world"));
        assert_eq!(resp.match_count, 1, "resp={resp:?}");
        assert_eq!(resp.files.len(), 1);
        assert_eq!(resp.files[0].matches[0].line, 1);
        assert!(resp.files[0].matches[0].text.contains("hello_world"));
        assert!(!resp.cancelled);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn respects_gitignore_and_skips_ignored_paths() {
        let dir = temp_dir("gitignore");
        fs::write(dir.join(".gitignore"), "secret/\nignored.txt\n").unwrap();
        fs::create_dir_all(dir.join("secret")).unwrap();
        fs::write(dir.join("secret/hidden.rs"), "findme_secret\n").unwrap();
        fs::write(dir.join("ignored.txt"), "findme_ignored\n").unwrap();
        fs::write(dir.join("keep.rs"), "findme_keep\n").unwrap();

        let resp = search(&dir, opts("findme"));
        let texts: Vec<_> = resp
            .files
            .iter()
            .flat_map(|f| f.matches.iter().map(|m| m.text.clone()))
            .collect();
        assert!(
            texts.iter().any(|t| t.contains("findme_keep")),
            "expected keep.rs hit, got {texts:?}"
        );
        assert!(
            !texts.iter().any(|t| t.contains("findme_secret")),
            "gitignore secret/ should be skipped: {texts:?}"
        );
        assert!(
            !texts.iter().any(|t| t.contains("findme_ignored")),
            "gitignore ignored.txt should be skipped: {texts:?}"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn skips_hardcoded_vendor_dirs_even_without_gitignore() {
        let dir = temp_dir("vendor");
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "findme_nm\n").unwrap();
        fs::write(dir.join("app.js"), "findme_app\n").unwrap();

        let resp = search(&dir, opts("findme"));
        let paths: Vec<_> = resp.files.iter().map(|f| f.relative.clone()).collect();
        assert!(paths.iter().any(|p| p.contains("app.js")), "{paths:?}");
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "{paths:?}"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn case_insensitive_match_works() {
        let dir = temp_dir("case");
        fs::write(dir.join("a.txt"), "HelloWorld\n").unwrap();

        let mut o = opts("helloworld");
        o.ignore_case = true;
        let resp = search(&dir, o);
        assert_eq!(resp.match_count, 1);

        let mut o2 = opts("helloworld");
        o2.ignore_case = false;
        let resp2 = search(&dir, o2);
        assert_eq!(resp2.match_count, 0);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cancel_stops_in_flight_search() {
        let dir = temp_dir("cancel");
        for i in 0..800 {
            fs::write(
                dir.join(format!("f{i}.txt")),
                format!("needle_{i}\n{}", "x".repeat(8000)),
            )
            .unwrap();
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_thread = Arc::clone(&cancel);
        let dir_clone = dir.clone();
        let handle = thread::spawn(move || {
            let mut o = opts("needle");
            o.max_matches = 10_000;
            o.max_files_scanned = 10_000;
            search_file_contents(&dir_clone, o, 0, Some(cancel_thread))
        });

        thread::sleep(Duration::from_millis(20));
        cancel.store(true, Ordering::SeqCst);
        let resp = handle.join().unwrap();
        assert!(
            resp.cancelled,
            "expected cancel flag to stop search, scanned={}",
            resp.files_scanned
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn extension_filter_limits_files() {
        let dir = temp_dir("ext");
        fs::write(dir.join("a.rs"), "needle\n").unwrap();
        fs::write(dir.join("b.ts"), "needle\n").unwrap();

        let mut o = opts("needle");
        o.extensions = Some(vec!["rs".into()]);
        let resp = search(&dir, o);
        assert_eq!(resp.match_count, 1);
        assert!(resp.files[0].name.ends_with(".rs"));

        fs::remove_dir_all(dir).unwrap();
    }
}
