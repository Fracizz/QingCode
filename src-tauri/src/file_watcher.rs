//! Debounced filesystem watching for open files and project roots.
//! Emits `fs-change` events to the frontend; self-writes can be suppressed briefly.

use crate::path_guard::PathAllowlist;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, DebouncedEventKind, Debouncer};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const DEBOUNCE_MS: u64 = 350;
const SUPPRESS_MS: u64 = 900;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangePayload {
    pub path: String,
    /// `any` | `notice` — mirrors notify-debouncer-mini kinds.
    pub kind: String,
    pub is_dir: bool,
}

struct WatcherInner {
    debouncer: Option<Debouncer<notify::RecommendedWatcher>>,
    roots: HashSet<PathBuf>,
    files: HashSet<PathBuf>,
    /// Paths we just wrote; ignore watcher events until Instant.
    suppress_until: HashMap<PathBuf, Instant>,
}

pub struct FileWatcherManager {
    inner: Mutex<WatcherInner>,
}

impl FileWatcherManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(WatcherInner {
                debouncer: None,
                roots: HashSet::new(),
                files: HashSet::new(),
                suppress_until: HashMap::new(),
            }),
        }
    }

    pub fn note_self_write(&self, path: &str) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        let normalized = normalize_path(Path::new(path));
        guard.suppress_until.insert(
            normalized,
            Instant::now() + Duration::from_millis(SUPPRESS_MS),
        );
        // Drop stale suppress entries opportunistically.
        let now = Instant::now();
        guard.suppress_until.retain(|_, until| *until > now);
    }

    pub fn should_suppress(&self, path: &Path) -> bool {
        let Ok(mut guard) = self.inner.lock() else {
            return false;
        };
        Self::is_suppressed(&mut guard, path)
    }

    fn is_suppressed(guard: &mut WatcherInner, path: &Path) -> bool {
        let now = Instant::now();
        guard.suppress_until.retain(|_, until| *until > now);
        let normalized = normalize_path(path);
        if guard
            .suppress_until
            .get(&normalized)
            .is_some_and(|until| *until > now)
        {
            return true;
        }
        // Also suppress if any ancestor was recently written (atomic rename temp).
        for (key, until) in &guard.suppress_until {
            if *until > now && (normalized.starts_with(key) || key.starts_with(&normalized)) {
                return true;
            }
        }
        false
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    dunce_simplify(path)
}

/// Best-effort path canonicalize without requiring the path to exist.
fn dunce_simplify(path: &Path) -> PathBuf {
    if let Ok(canon) = path.canonicalize() {
        return strip_verbatim_prefix(canon);
    }
    strip_verbatim_prefix(path.to_path_buf())
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn emit_change(app: &AppHandle, path: PathBuf, kind: DebouncedEventKind) {
    let is_dir = path.is_dir();
    let kind_str = match kind {
        DebouncedEventKind::AnyContinuous => "notice",
        DebouncedEventKind::Any => "any",
        _ => "any",
    };
    let payload = FsChangePayload {
        path: path.to_string_lossy().into_owned(),
        kind: kind_str.to_string(),
        is_dir,
    };
    let _ = app.emit("fs-change", payload);
}

fn rebuild_watches(app: AppHandle, guard: &mut WatcherInner) -> Result<(), String> {
    // Drop previous debouncer first so OS watches are released.
    guard.debouncer = None;

    let paths: Vec<(PathBuf, RecursiveMode)> = guard
        .roots
        .iter()
        .cloned()
        .map(|p| (p, RecursiveMode::Recursive))
        .chain(
            guard
                .files
                .iter()
                .cloned()
                .map(|p| (p, RecursiveMode::NonRecursive)),
        )
        .collect();

    if paths.is_empty() {
        return Ok(());
    }

    let app_for_cb = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        move |res: DebounceEventResult| {
            let Ok(events) = res else {
                return;
            };
            for event in events {
                let path = normalize_path(&event.path);
                // Skip noisy temp / backup files from our atomic writer.
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.ends_with(".tmp") || name.ends_with(".backup") {
                        continue;
                    }
                    if name.starts_with('.') && (name.contains(".tmp") || name.contains(".backup"))
                    {
                        continue;
                    }
                }
                if let Some(mgr) = app_for_cb.try_state::<FileWatcherManager>() {
                    if mgr.should_suppress(&path) {
                        continue;
                    }
                }
                emit_change(&app_for_cb, path, event.kind);
            }
        },
    )
    .map_err(|e| format!("创建文件监视器失败: {e}"))?;

    for (path, mode) in &paths {
        if !path.exists() {
            continue;
        }
        if let Err(e) = debouncer.watcher().watch(path, *mode) {
            // Non-fatal: keep watching other paths.
            eprintln!("watch failed for {}: {e}", path.display());
        }
    }

    guard.debouncer = Some(debouncer);
    Ok(())
}

/// Replace watched project roots and open-file paths.
#[tauri::command]
pub fn sync_file_watches(
    roots: Vec<String>,
    files: Vec<String>,
    app: AppHandle,
    state: State<'_, FileWatcherManager>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    for root in &roots {
        if !root.is_empty() {
            allowlist.ensure_allowed(root)?;
        }
    }
    for file in &files {
        if !file.is_empty() {
            allowlist.ensure_allowed(file)?;
        }
    }

    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "文件监视器锁失败".to_string())?;

    guard.roots = roots
        .into_iter()
        .filter(|p| !p.is_empty())
        .map(|p| normalize_path(Path::new(&p)))
        .collect();
    guard.files = files
        .into_iter()
        .filter(|p| !p.is_empty())
        .map(|p| normalize_path(Path::new(&p)))
        .filter(|p| !guard.roots.iter().any(|root| p.starts_with(root)))
        .collect();

    rebuild_watches(app, &mut guard)
}

/// Mark a path as a local save so the next watcher events are ignored.
#[tauri::command]
pub fn suppress_fs_watch(path: String, state: State<'_, FileWatcherManager>) -> Result<(), String> {
    state.note_self_write(&path);
    Ok(())
}

/// Whether `path` is currently in the suppress window (used by frontend filter).
#[tauri::command]
pub fn is_fs_watch_suppressed(
    path: String,
    state: State<'_, FileWatcherManager>,
) -> Result<bool, String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "文件监视器锁失败".to_string())?;
    Ok(FileWatcherManager::is_suppressed(
        &mut guard,
        Path::new(&path),
    ))
}

/// Last modified time in Unix milliseconds, or null if missing.
#[tauri::command]
pub fn file_mtime(path: String, allowlist: State<'_, PathAllowlist>) -> Result<Option<u64>, String> {
    allowlist.ensure_allowed(&path)?;
    file_mtime_inner(path)
}

fn file_mtime_inner(path: String) -> Result<Option<u64>, String> {
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取文件时间失败: {e}")),
    };
    let modified = meta
        .modified()
        .map_err(|e| format!("读取文件时间失败: {e}"))?;
    let millis = modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(millis))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_verbatim_keeps_normal_paths() {
        let p = PathBuf::from(r"D:\Work\file.txt");
        assert_eq!(strip_verbatim_prefix(p.clone()), p);
    }

    #[test]
    fn file_mtime_missing_returns_none() {
        let result = file_mtime_inner(r"D:\definitely\missing\qingcode-test-mtime.txt".into());
        assert_eq!(result.unwrap(), None);
    }

    #[test]
    fn suppress_window_tracks_path() {
        let mgr = FileWatcherManager::new();
        mgr.note_self_write(r"D:\tmp\a.txt");
        let mut guard = mgr.inner.lock().unwrap();
        assert!(FileWatcherManager::is_suppressed(
            &mut guard,
            Path::new(r"D:\tmp\a.txt")
        ));
    }
}
