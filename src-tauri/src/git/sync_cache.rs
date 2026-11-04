//! Reuse synchronization metadata while the actual Git files are unchanged.
//! Git still interprets reflogs; this cache only avoids repeated subprocesses.
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use super::{file_mtime_ms, reflog_timestamp, run_git, PULL_REFLOG_NEEDLES, PUSH_REFLOG_NEEDLES};

type Times = (Option<i64>, Option<i64>, Option<i64>);
type Key = (PathBuf, Option<String>);
type Cache = Mutex<HashMap<Key, Entry>>;
type Runner<'a> = dyn Fn(&Path, &[&str]) -> Result<Output, String> + 'a;
const CAPACITY: usize = 128;
// Also re-resolve occasionally for unusual filesystem timestamp behaviour.
const MAX_AGE: Duration = Duration::from_secs(30);
static CACHE: OnceLock<Cache> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
enum Stamp {
    Missing,
    Present {
        modified: Option<SystemTime>,
        created: Option<SystemTime>,
        len: u64,
        identity: (u64, u64, i64, i64),
    },
}

fn stamp(path: &Path) -> Option<Stamp> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Some(Stamp::Missing),
        Err(_) => return None, // A permission/transient error must never become a cache hit.
    };
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        if metadata.is_dir() {
            (metadata.dev(), metadata.ino(), 0, 0)
        } else {
            (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        }
    };
    #[cfg(not(unix))]
    let identity = (0, 0, 0, 0);
    Some(Stamp::Present {
        // Directory entries change whenever Git writes index.lock. Track the
        // directory identity, not its children, whose files are checked below.
        modified: if metadata.is_dir() {
            None
        } else {
            Some(metadata.modified().ok()?)
        },
        created: metadata.created().ok(),
        len: if metadata.is_dir() { 0 } else { metadata.len() },
        identity,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Layout {
    git_dir: PathBuf,
    common_dir: PathBuf,
    stamps: Vec<Stamp>,
}

/// Resolve the native .git marker each time so a new nested repo, changed
/// worktree pointer, or re-created repository cannot reuse a previous entry.
fn layout(root: &Path) -> Option<Layout> {
    let mut current = root.to_path_buf();
    let marker = loop {
        let marker = current.join(".git");
        if marker.exists() {
            break marker;
        }
        if !current.pop() {
            return None;
        }
    };
    let git_dir = if marker.is_dir() {
        fs::canonicalize(&marker).ok()?
    } else {
        let content = fs::read_to_string(&marker).ok()?;
        let pointer = content.trim().strip_prefix("gitdir:")?.trim();
        fs::canonicalize(current.join(pointer)).ok()?
    };
    let common_marker = git_dir.join("commondir");
    let common_dir = if common_marker.exists() {
        fs::canonicalize(git_dir.join(fs::read_to_string(&common_marker).ok()?.trim())).ok()?
    } else {
        git_dir.clone()
    };
    if common_dir.join("reftable").exists() {
        return None; // Its storage files differ from loose refs/logs; use Git directly.
    }
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    if let Some(reference) = head.trim().strip_prefix("ref:") {
        let reference = reference.trim();
        if !reference.starts_with("refs/heads/")
            || Path::new(reference)
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return None;
        }
        if fs::read_to_string(common_dir.join(reference)).is_ok_and(|text| text.starts_with("ref:"))
        {
            return None; // Chained symbolic HEADs can select a different reflog.
        }
    }
    let paths = [
        marker,
        git_dir.clone(),
        common_dir.clone(),
        common_marker,
        git_dir.join("HEAD"),
        common_dir.join("config"),
        git_dir.join("config.worktree"),
        common_dir.join("packed-refs"),
    ];
    let stamps = paths
        .iter()
        .map(|path| stamp(path))
        .collect::<Option<Vec<_>>>()?;
    Some(Layout {
        git_dir,
        common_dir,
        stamps,
    })
}

#[derive(Clone)]
struct Entry {
    layout: Layout,
    paths: Vec<PathBuf>,
    stamps: Vec<Stamp>,
    times: Times,
    loaded: Instant,
}

/// Nonstandard Git process configuration may relocate metadata or alter reflog
/// interpretation. Keep the uncached implementation as the authority there.
fn standard_environment() -> bool {
    std::env::vars_os().all(|(name, _)| {
        let name = name.to_string_lossy().to_ascii_uppercase();
        !name.starts_with("GIT_")
            || matches!(
                name.as_str(),
                // Captured stdout never invokes a pager; it cannot relocate or
                // change metadata. Many terminal environments set GIT_PAGER.
                "GIT_OPTIONAL_LOCKS" | "GIT_TERMINAL_PROMPT" | "GIT_PAGER"
            )
    })
}

pub(super) fn read(root: &Path, upstream: Option<&str>) -> Option<Times> {
    if !standard_environment() {
        return None;
    }
    read_with(
        root,
        upstream,
        CACHE.get_or_init(|| Mutex::new(HashMap::new())),
        &run_git,
    )
}

fn read_with(
    root: &Path,
    upstream: Option<&str>,
    cache: &Cache,
    run: &Runner<'_>,
) -> Option<Times> {
    let root = fs::canonicalize(root).ok()?;
    let upstream = upstream.filter(|name| !name.is_empty() && !name.starts_with('-'));
    let key = (root.clone(), upstream.map(str::to_owned));
    let native = layout(&root)?;
    if let Some(name) = upstream {
        let reference = native.common_dir.join(format!("refs/remotes/{name}"));
        if fs::read_to_string(reference).is_ok_and(|text| text.starts_with("ref:")) {
            return None; // Git follows symbolic upstream refs; do not guess their log target.
        }
    }
    // Do not hold the process-wide lock during disk or subprocess I/O.
    let previous = cache.lock().ok()?.get(&key).cloned();
    if let Some(previous) = previous {
        if previous.loaded.elapsed() < MAX_AGE
            && previous.layout == native
            && previous
                .paths
                .iter()
                .map(|path| stamp(path))
                .collect::<Option<Vec<_>>>()?
                == previous.stamps
        {
            return Some(previous.times);
        }
    }
    let remote_log = upstream.map(|name| format!("logs/refs/remotes/{name}"));
    let mut args = vec![
        "rev-parse",
        "--absolute-git-dir",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-path",
        "FETCH_HEAD",
        "--git-path",
        "logs/HEAD",
    ];
    if let Some(remote_log) = &remote_log {
        args.extend(["--git-path", remote_log]);
    }
    let output = run(&root, &args).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = std::str::from_utf8(&output.stdout).ok()?;
    let paths = text.lines().map(PathBuf::from).collect::<Vec<_>>();
    if paths.len() != if upstream.is_some() { 5 } else { 4 }
        || paths.iter().any(|path| !path.is_absolute())
        || fs::canonicalize(&paths[0]).ok()? != native.git_dir
        || fs::canonicalize(&paths[1]).ok()? != native.common_dir
    {
        return None;
    }
    let paths = paths[2..].to_vec();
    let before = paths
        .iter()
        .map(|path| stamp(path))
        .collect::<Option<Vec<_>>>()?;
    if before[1] == Stamp::Missing {
        // `git reflog show HEAD` can fall back to the current branch's log
        // when logs/HEAD was removed. Keep Git authoritative for that case.
        return None;
    }
    let read_log =
        |index: usize, reference: Option<&str>, needles: &[&str]| -> Option<Option<i64>> {
            if before[index] == Stamp::Missing {
                return Some(None);
            }
            let mut args = vec!["reflog", "show", "--date=unix", "-n", "100"];
            if let Some(reference) = reference {
                args.push(reference);
            }
            let output = run(&root, &args).ok()?;
            if !output.status.success() {
                return None;
            }
            Some(reflog_timestamp(
                &String::from_utf8_lossy(&output.stdout),
                needles,
            ))
        };
    let fetched = file_mtime_ms(&paths[0]);
    let pulled = read_log(1, None, PULL_REFLOG_NEEDLES)?;
    let pushed = match upstream {
        Some(name) => read_log(
            2,
            Some(&format!("refs/remotes/{name}")),
            PUSH_REFLOG_NEEDLES,
        )?,
        None => None,
    };
    let times = (fetched, pulled, pushed);
    let after = paths
        .iter()
        .map(|path| stamp(path))
        .collect::<Option<Vec<_>>>()?;
    // An external fetch/commit racing this read must not cache an old value
    // under the new metadata. The next refresh can obtain a stable snapshot.
    if before == after && layout(&root)? == native {
        let mut entries = cache.lock().ok()?;
        if entries.len() >= CAPACITY && !entries.contains_key(&key) {
            let oldest = entries
                .iter()
                .min_by_key(|(_, entry)| entry.loaded)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            key,
            Entry {
                layout: native,
                paths,
                stamps: after,
                times,
                loaded: Instant::now(),
            },
        );
    }
    Some(times)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn git_success(root: &Path, args: &[&str]) {
        let output = run_git(root, args).unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_test_repo(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("qingcode-{label}-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        git_success(&root, &["init"]);
        git_success(&root, &["config", "user.email", "test@qingcode.local"]);
        git_success(&root, &["config", "user.name", "QingCode Test"]);
        root
    }

    fn empty_cache() -> Cache {
        Mutex::new(HashMap::new())
    }

    #[test]
    fn warm_sync_metadata_uses_no_git_and_external_updates_invalidate() {
        let root = init_test_repo("sync-cache-update");
        git_success(&root, &["commit", "--allow-empty", "-m", "initial"]);
        let cache = empty_cache();
        let calls = Cell::new(0usize);
        let run = |root: &Path, args: &[&str]| {
            calls.set(calls.get() + 1);
            run_git(root, args)
        };
        let initial = read_with(&root, None, &cache, &run).unwrap();
        assert_eq!(calls.get(), 2); // Resolve paths once + interpret HEAD reflog.
        assert_eq!(initial, (None, None, None));
        calls.set(0);
        assert_eq!(read_with(&root, None, &cache, &run), Some(initial));
        assert_eq!(calls.get(), 0);

        let fetch = root.join(".git/FETCH_HEAD");
        fs::write(&fetch, "external fetch\n").unwrap();
        let fetched = read_with(&root, None, &cache, &run).unwrap();
        assert_eq!(fetched.0, file_mtime_ms(&fetch));
        assert!(calls.get() > 0);

        git_success(
            &root,
            &[
                "update-ref",
                "--create-reflog",
                "-m",
                "pull origin main: Fast-forward",
                "HEAD",
                "HEAD",
            ],
        );
        let pulled = read_with(&root, None, &cache, &run).unwrap();
        assert!(pulled.1.is_some());
        fs::remove_file(fetch).unwrap();
        assert_eq!(read_with(&root, None, &cache, &run).unwrap().0, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn upstream_switch_and_external_push_reflog_are_not_stale() {
        let root = init_test_repo("sync-cache-upstream");
        git_success(&root, &["commit", "--allow-empty", "-m", "initial"]);
        let cache = empty_cache();
        assert_eq!(
            read_with(&root, Some("origin/main"), &cache, &run_git)
                .unwrap()
                .2,
            None
        );
        git_success(
            &root,
            &[
                "update-ref",
                "--create-reflog",
                "-m",
                "update by push",
                "refs/remotes/origin/main",
                "HEAD",
            ],
        );
        assert!(read_with(&root, Some("origin/main"), &cache, &run_git)
            .unwrap()
            .2
            .is_some());
        assert_eq!(
            read_with(&root, Some("origin/other"), &cache, &run_git)
                .unwrap()
                .2,
            None
        );
        git_success(
            &root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        assert!(read_with(&root, Some("origin/HEAD"), &cache, &run_git).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worktrees_track_common_fetch_metadata_and_their_own_head_log() {
        let root = init_test_repo("sync-cache-worktree");
        git_success(&root, &["commit", "--allow-empty", "-m", "initial"]);
        let worktree = root.with_extension("linked");
        git_success(
            &root,
            &[
                "worktree",
                "add",
                "-b",
                "linked",
                worktree.to_str().unwrap(),
            ],
        );
        let cache = empty_cache();
        assert_eq!(read_with(&root, None, &cache, &run_git).unwrap().1, None);
        assert_eq!(
            read_with(&worktree, None, &cache, &run_git).unwrap().1,
            None
        );
        git_success(
            &worktree,
            &[
                "update-ref",
                "--create-reflog",
                "-m",
                "pull origin linked: Fast-forward",
                "HEAD",
                "HEAD",
            ],
        );
        assert!(read_with(&worktree, None, &cache, &run_git)
            .unwrap()
            .1
            .is_some());
        assert_eq!(read_with(&root, None, &cache, &run_git).unwrap().1, None);
        // Git's own resolver determines where FETCH_HEAD belongs for worktrees.
        let expected_path = run_git(&worktree, &["rev-parse", "--git-path", "FETCH_HEAD"]).unwrap();
        let path = PathBuf::from(String::from_utf8(expected_path.stdout).unwrap().trim());
        let path = if path.is_absolute() {
            path
        } else {
            worktree.join(path)
        };
        fs::write(&path, "worktree fetch\n").unwrap();
        assert_eq!(
            read_with(&worktree, None, &cache, &run_git).unwrap().0,
            file_mtime_ms(&path)
        );
        git_success(
            &root,
            &["worktree", "remove", "--force", worktree.to_str().unwrap()],
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recreated_repository_and_expired_entries_are_reloaded() {
        let root = init_test_repo("sync-cache-reinit");
        git_success(&root, &["commit", "--allow-empty", "-m", "initial"]);
        let cache = empty_cache();
        let first = read_with(&root, None, &cache, &run_git).unwrap();
        let calls = Cell::new(0usize);
        let run = |root: &Path, args: &[&str]| {
            calls.set(calls.get() + 1);
            run_git(root, args)
        };
        let key = (fs::canonicalize(&root).unwrap(), None);
        cache.lock().unwrap().get_mut(&key).unwrap().loaded = Instant::now() - MAX_AGE;
        assert_eq!(read_with(&root, None, &cache, &run), Some(first));
        assert!(calls.get() > 0);
        git_success(&root, &["switch", "-c", "other"]);
        calls.set(0);
        assert_eq!(read_with(&root, None, &cache, &run), Some(first));
        assert!(calls.get() > 0);
        fs::rename(root.join(".git"), root.join("old-git")).unwrap();
        git_success(&root, &["init"]);
        git_success(&root, &["config", "user.email", "test@qingcode.local"]);
        git_success(&root, &["config", "user.name", "QingCode Test"]);
        git_success(&root, &["commit", "--allow-empty", "-m", "recreated"]);
        calls.set(0);
        assert_eq!(read_with(&root, None, &cache, &run), Some(first));
        assert!(calls.get() > 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_reflog_reads_are_not_cached_and_nonstandard_storage_falls_back() {
        let root = init_test_repo("sync-cache-read-error");
        git_success(&root, &["commit", "--allow-empty", "-m", "initial"]);
        let cache = empty_cache();
        let fail_log = |root: &Path, args: &[&str]| {
            if args[0] == "reflog" {
                return Err("transient read error".to_owned());
            }
            run_git(root, args)
        };
        assert!(read_with(&root, None, &cache, &fail_log).is_none());
        assert!(cache.lock().unwrap().is_empty());
        assert!(read_with(&root, None, &cache, &run_git).is_some());
        fs::create_dir(root.join(".git/reftable")).unwrap();
        assert!(read_with(&root, None, &cache, &run_git).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_head_log_and_chained_symbolic_heads_use_git_fallback() {
        let root = init_test_repo("sync-cache-symbolic-head");
        git_success(&root, &["commit", "--allow-empty", "-m", "initial"]);
        let cache = empty_cache();
        assert!(read_with(&root, None, &cache, &run_git).is_some());
        fs::remove_file(root.join(".git/logs/HEAD")).unwrap();
        assert!(read_with(&root, None, &cache, &run_git).is_none());
        let branch = run_git(&root, &["symbolic-ref", "HEAD"]).unwrap();
        let branch = String::from_utf8(branch.stdout).unwrap();
        git_success(&root, &["symbolic-ref", "refs/heads/alias", branch.trim()]);
        git_success(&root, &["symbolic-ref", "HEAD", "refs/heads/alias"]);
        assert!(read_with(&root, None, &cache, &run_git).is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
