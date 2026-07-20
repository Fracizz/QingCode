//! Lightweight app memory sampling for the status bar.
//!
//! Uses a short TTL cache and memory-only process refresh so a 10s UI poll
//! stays cheap. Totals: QingCode main + WebView2 + associated descendants
//! (integrated terminal shells and their children).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const CACHE_TTL: Duration = Duration::from_millis(2_500);

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppMemoryInfo {
    pub total_bytes: u64,
    pub main_bytes: u64,
    pub webview_bytes: u64,
    pub terminal_bytes: u64,
}

struct Cache {
    at: Instant,
    info: AppMemoryInfo,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn is_webview2_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("msedgewebview2") || lower == "webview2"
}

/// Sample memory for this process tree (+ associated WebView2).
/// `extra_roots` are known terminal shell PIDs (still counted if briefly reparented).
/// When `force` is true, bypass the short TTL cache (e.g. status-bar tip open).
pub fn sample_app_memory(extra_roots: &[u32], force: bool) -> AppMemoryInfo {
    if !force {
        if let Ok(guard) = CACHE.lock() {
            if let Some(cache) = guard.as_ref() {
                if cache.at.elapsed() < CACHE_TTL {
                    return cache.info.clone();
                }
            }
        }
    }

    let info = sample_app_memory_uncached(extra_roots);

    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(Cache {
            at: Instant::now(),
            info: info.clone(),
        });
    }
    info
}

fn sample_app_memory_uncached(extra_roots: &[u32]) -> AppMemoryInfo {
    let self_pid = Pid::from_u32(std::process::id());
    let mut system = System::new();
    // Memory-only refresh — avoid CPU/disk/exe metadata cost on every poll.
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let mut children_of: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children_of.entry(parent).or_default().push(*pid);
        }
    }

    let mut tree: HashSet<Pid> = HashSet::new();
    collect_descendants(&children_of, self_pid, &mut tree);
    tree.insert(self_pid);

    for &root in extra_roots {
        let pid = Pid::from_u32(root);
        if system.process(pid).is_some() {
            collect_descendants(&children_of, pid, &mut tree);
            tree.insert(pid);
        }
    }

    // WebView2 may sit outside our parent chain (broker). Include those whose
    // parent is us or already in the tree; if none, keep tree-only webviews.
    let mut webview_extra: HashSet<Pid> = HashSet::new();
    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy();
        if !is_webview2_name(name.as_ref()) || tree.contains(pid) {
            continue;
        }
        if let Some(parent) = process.parent() {
            if parent == self_pid || tree.contains(&parent) {
                webview_extra.insert(*pid);
            }
        }
    }

    let mut counted: HashSet<Pid> = HashSet::new();
    let mut main_bytes = 0_u64;
    let mut webview_bytes = 0_u64;
    let mut terminal_bytes = 0_u64;

    for pid in tree.iter().chain(webview_extra.iter()) {
        if !counted.insert(*pid) {
            continue;
        }
        let Some(process) = system.process(*pid) else {
            continue;
        };
        let bytes = process.memory();
        if *pid == self_pid {
            main_bytes = main_bytes.saturating_add(bytes);
            continue;
        }
        let name = process.name().to_string_lossy();
        if is_webview2_name(name.as_ref()) {
            webview_bytes = webview_bytes.saturating_add(bytes);
        } else {
            terminal_bytes = terminal_bytes.saturating_add(bytes);
        }
    }

    AppMemoryInfo {
        total_bytes: main_bytes
            .saturating_add(webview_bytes)
            .saturating_add(terminal_bytes),
        main_bytes,
        webview_bytes,
        terminal_bytes,
    }
}

fn collect_descendants(children_of: &HashMap<Pid, Vec<Pid>>, root: Pid, out: &mut HashSet<Pid>) {
    let Some(children) = children_of.get(&root) else {
        return;
    };
    for child in children {
        if out.insert(*child) {
            collect_descendants(children_of, *child, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview2_name_detection() {
        assert!(is_webview2_name("msedgewebview2.exe"));
        assert!(is_webview2_name("msedgewebview2"));
        assert!(is_webview2_name("MsEdgeWebView2.exe"));
        assert!(!is_webview2_name("pwsh.exe"));
        assert!(!is_webview2_name("QingCode.exe"));
    }

    #[test]
    fn sample_returns_at_least_main_process() {
        let info = sample_app_memory_uncached(&[]);
        assert!(info.main_bytes > 0, "main should report RSS");
        assert_eq!(
            info.total_bytes,
            info.main_bytes
                .saturating_add(info.webview_bytes)
                .saturating_add(info.terminal_bytes)
        );
    }
}
