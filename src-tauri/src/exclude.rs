//! VS Code–style `files.exclude` / `search.exclude` path matching.

/// Normalize to POSIX relative form (no leading/trailing slashes).
pub fn normalize_rel(input: &str) -> String {
    let mut s = input.replace('\\', "/");
    while s.starts_with('/') {
        s.remove(0);
    }
    while s.ends_with('/') && s.len() > 1 {
        s.pop();
    }
    s
}

/// Relative path of `path` under `root`, or `None` if not under root.
pub fn relative_to_root(root: &str, path: &str) -> Option<String> {
    let root_n = normalize_rel(root);
    let path_n = normalize_rel(path);
    let root_cmp = if cfg!(windows) {
        root_n.to_ascii_lowercase()
    } else {
        root_n.clone()
    };
    let path_cmp = if cfg!(windows) {
        path_n.to_ascii_lowercase()
    } else {
        path_n.clone()
    };
    if path_cmp == root_cmp {
        return Some(String::new());
    }
    let prefix = format!("{root_cmp}/");
    if !path_cmp.starts_with(&prefix) {
        return None;
    }
    let skip = root_n.len() + 1;
    if path_n.len() >= skip {
        Some(path_n[skip..].to_string())
    } else {
        None
    }
}

/// True when `relative` (or any of its path prefixes) matches an exclude pattern.
pub fn is_path_excluded(relative: &str, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let path = normalize_rel(relative);
    if path.is_empty() {
        return false;
    }
    for prefix in path_prefixes(&path) {
        for pattern in patterns {
            let pat = normalize_rel(pattern);
            if vscode_glob_match(&prefix, &pat) {
                return true;
            }
        }
    }
    false
}

fn path_prefixes(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut acc = String::new();
    for part in path.split('/').filter(|p| !p.is_empty()) {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(part);
        out.push(acc.clone());
    }
    out
}

/// Segment-aware glob: `**` spans `/`, `*` does not, `?` is one non-slash char.
pub fn vscode_glob_match(text: &str, pattern: &str) -> bool {
    match_from(text.as_bytes(), 0, pattern.as_bytes(), 0)
}

fn match_from(text: &[u8], mut ti: usize, pattern: &[u8], mut pi: usize) -> bool {
    while pi < pattern.len() {
        if pattern[pi] == b'*' && pi + 1 < pattern.len() && pattern[pi + 1] == b'*' {
            let mut next = pi + 2;
            if next < pattern.len() && pattern[next] == b'/' {
                next += 1;
            }
            if next >= pattern.len() {
                return true;
            }
            // Zero or more segments: try every segment boundary (and end).
            let mut i = ti;
            loop {
                if match_from(text, i, pattern, next) {
                    return true;
                }
                if i >= text.len() {
                    break;
                }
                // Advance to next '/' then past it, or finish.
                while i < text.len() && text[i] != b'/' {
                    i += 1;
                }
                if i < text.len() && text[i] == b'/' {
                    i += 1;
                } else {
                    break;
                }
            }
            return false;
        }

        if pattern[pi] == b'*' {
            pi += 1;
            if pi >= pattern.len() {
                return !text[ti..].contains(&b'/');
            }
            let mut i = ti;
            loop {
                if match_from(text, i, pattern, pi) {
                    return true;
                }
                if i >= text.len() || text[i] == b'/' {
                    break;
                }
                i += 1;
            }
            return false;
        }

        if pattern[pi] == b'?' {
            if ti >= text.len() || text[ti] == b'/' {
                return false;
            }
            ti += 1;
            pi += 1;
            continue;
        }

        if ti >= text.len() || text[ti] != pattern[pi] {
            return false;
        }
        ti += 1;
        pi += 1;
    }
    ti == text.len()
}

/// Built-in fallback when the frontend does not pass exclude patterns.
pub fn default_hard_ignore_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | ".git" | ".next"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_node_modules_at_any_depth() {
        assert!(vscode_glob_match("node_modules", "**/node_modules"));
        assert!(vscode_glob_match("pkg/node_modules", "**/node_modules"));
        assert!(!vscode_glob_match("src", "**/node_modules"));
    }

    #[test]
    fn exclude_hides_children_of_matched_folder() {
        let patterns = vec!["**/node_modules".to_string(), "**/dist".to_string()];
        assert!(is_path_excluded("node_modules/lodash/index.js", &patterns));
        assert!(is_path_excluded("dist/app.js", &patterns));
        assert!(!is_path_excluded("src/app.js", &patterns));
    }

    #[test]
    fn extension_glob() {
        assert!(vscode_glob_match("foo.code-search", "**/*.code-search"));
        assert!(vscode_glob_match("a/b/foo.code-search", "**/*.code-search"));
        assert!(!vscode_glob_match("foo.ts", "**/*.code-search"));
    }

    #[test]
    fn relative_to_root_windows_and_posix() {
        let rel = relative_to_root(r"D:\Work\proj", r"D:\Work\proj\src\main.ts").unwrap();
        assert_eq!(rel.replace('\\', "/"), "src/main.ts");
        assert_eq!(
            relative_to_root("/home/u/p", "/home/u/p/a/b").as_deref(),
            Some("a/b")
        );
    }
}
