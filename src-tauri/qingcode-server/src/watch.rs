//! 远端文件变更监视：事件形状与主程序 file_watcher.rs 保持一致，
//! 客户端复用同一条 `fs-change` 事件解析路径。
//!
//! `watch_loop` 是阻塞式的，调用方（lib.rs 的 handle_watch）经
//! `spawn_blocking` 调用；客户端断开、cancel 置位或发送失败即正常收尾。
//! 返回时 debouncer 一定被 drop，inotify 实例随之释放。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use notify::{
    Error as NotifyError, ErrorKind as NotifyErrorKind, RecommendedWatcher, RecursiveMode,
};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, DebouncedEventKind, Debouncer};
use serde_json::json;
use tokio::sync::mpsc::Sender;

use crate::{is_high_churn_path, path_is_within};

/// 目录判定缓存条目上限。事件突发时同一目录会反复出现，缓存避免每次都做
/// 完整 canonicalize；超过上限整体清空，保证长跑进程的缓存有界。
const DIR_CACHE_LIMIT: usize = 4096;

/// inotify 配额耗尽时使用的轮询间隔。轮询只作为 watch 注册失败后的兜底，
/// 不参与正常路径。
const WATCH_POLL_INTERVAL: Duration = Duration::from_secs(1);
const WATCH_POLL_CANCEL_SLICE: Duration = Duration::from_millis(100);

/// 事件过滤器：先做廉价字面过滤（越界 / 高变动目录 / 自写临时文件），
/// 再做真实路径校验。
///
/// 真实路径校验是必需的：inotify 默认跟随符号链接，项目内出现
/// `escape -> /etc` 时事件路径字面上仍在 root 下，实际却指向项目外——
/// 若不校验，会泄露项目外路径名、可能递归 watch 整棵外部目录，
/// 噪音还会冲掉真实事件。
struct EmitFilter {
    root: PathBuf,
    /// 目录 → 该目录的真实路径是否在 root 内。键用事件里的未解析路径，
    /// 值来自 canonicalize，因此同一目录前缀只需解析一次。
    dir_cache: HashMap<PathBuf, bool>,
}

impl EmitFilter {
    fn new(root: PathBuf) -> Self {
        let mut dir_cache = HashMap::new();
        // 根已由调用方 canonicalize，直接命中。
        dir_cache.insert(root.clone(), true);
        Self { root, dir_cache }
    }

    fn should_emit(&mut self, path: &Path) -> bool {
        if !path_is_within(path, &self.root) {
            return false;
        }
        if is_high_churn_path(path, &self.root) {
            return false;
        }
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            // 自写原子写入的 `.tmp`/`.backup` 条目，与主程序一致不上报。
            if name.ends_with(".tmp") || name.ends_with(".backup") {
                return false;
            }
        }
        self.resolves_within_root(path)
    }

    /// 事件路径的真实位置是否仍在项目根内。
    ///
    /// - 路径存在且本身是符号链接：解析完整路径后判定（它可能指向 root 外）；
    ///   同时清空目录缓存，避免之前「该路径是普通目录」的旧结论继续放行
    ///   其子路径。
    /// - 路径存在且不是符号链接：父目录判定即可，中间目录都在父目录里解析过。
    /// - 路径不存在（删除事件）：`canonicalize` 必然失败，退化为父目录判定。
    /// - 父目录也解析失败：无法判定即丢弃，宁可漏报也不上报项目外路径。
    fn resolves_within_root(&mut self, path: &Path) -> bool {
        let Some(parent) = path.parent() else {
            return path == self.root;
        };
        if !self.dir_within_root(parent) {
            return false;
        }
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                self.invalidate_dir_cache();
                std::fs::canonicalize(path)
                    .map(|real| path_is_within(&real, &self.root))
                    .unwrap_or(false)
            }
            _ => true,
        }
    }

    fn dir_within_root(&mut self, dir: &Path) -> bool {
        if let Some(cached) = self.dir_cache.get(dir) {
            return *cached;
        }
        let allowed = std::fs::canonicalize(dir)
            .map(|real| path_is_within(&real, &self.root))
            .unwrap_or(false);
        if self.dir_cache.len() >= DIR_CACHE_LIMIT {
            self.dir_cache.clear();
            self.dir_cache.insert(self.root.clone(), true);
        }
        self.dir_cache.insert(dir.to_path_buf(), allowed);
        allowed
    }

    fn invalidate_dir_cache(&mut self) {
        if self.dir_cache.len() > 1 {
            self.dir_cache.clear();
            self.dir_cache.insert(self.root.clone(), true);
        }
    }
}

fn event_kind(kind: DebouncedEventKind) -> &'static str {
    match kind {
        // AnyContinuous 是去抖期内的连续变化，对齐主程序的 notice 语义。
        DebouncedEventKind::AnyContinuous => "notice",
        // 其余（含 Any 及未来新增变体）一律按整体变更上报。
        _ => "any",
    }
}

fn is_enospc(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ENOSPC)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

/// notify 在 Linux 通常把 inotify ENOSPC 映射成 `MaxFilesWatch`，某些
/// 后端/内核组合会保留为原始 `ENOSPC`，两种都必须进入轮询兜底。
fn should_fallback_to_polling(error: &NotifyError) -> bool {
    match &error.kind {
        NotifyErrorKind::MaxFilesWatch => true,
        NotifyErrorKind::Io(error) => is_enospc(error),
        _ => false,
    }
}

/// 收集 `start` 及其后代中允许监视的目录。高变动目录在枚举阶段就剪枝，
/// 不传给 notify，因此不会占用 inotify watch，也不依赖事后事件过滤。
fn collect_watch_dirs(root: &Path, start: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    let mut pending = vec![start.to_path_buf()];
    while let Some(dir) = pending.pop() {
        if dir != root && is_high_churn_path(&dir, root) {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if dir == root => return Err(error),
            Err(_) => continue,
        };
        dirs.push(dir);
        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() && !is_high_churn_path(&path, root) {
                pending.push(path);
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    Ok(dirs)
}

/// 逐目录注册 `NonRecursive` watch。notify 的 `RecursiveMode::Recursive`
/// 没有排除参数，会在注册阶段直接遍历并 watch 整棵树；这里改为自行枚举，
/// 才能在 node_modules/target 等目录上真正跳过注册。
fn register_watch_tree(
    debouncer: &mut Debouncer<RecommendedWatcher>,
    root: &Path,
    start: &Path,
    watched: &mut HashSet<PathBuf>,
) -> Result<(), NotifyError> {
    for dir in collect_watch_dirs(root, start).map_err(NotifyError::io)? {
        if watched.contains(&dir) {
            continue;
        }
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::NonRecursive)?;
        watched.insert(dir);
    }
    Ok(())
}

fn refresh_watch_tree(
    debouncer: &mut Debouncer<RecommendedWatcher>,
    root: &Path,
    path: &Path,
    watched: &mut HashSet<PathBuf>,
) -> Result<(), NotifyError> {
    let is_real_dir = std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_dir())
        .unwrap_or(false);
    if is_real_dir && !is_high_churn_path(path, root) {
        register_watch_tree(debouncer, root, path, watched)
    } else {
        // 删除/重命名/符号链接目录：释放逻辑记录，后续同名真实目录可重新注册。
        watched.retain(|dir| !dir.starts_with(path));
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PollFingerprint {
    is_dir: bool,
    len: u64,
    modified: Option<SystemTime>,
}

/// 轮询兜底使用的轻量快照。符号链接和高变动目录不进入快照，避免与正常
/// watch 路径产生不同的可见语义。
fn poll_snapshot(root: &Path) -> std::io::Result<HashMap<PathBuf, PollFingerprint>> {
    let mut snapshot = HashMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if dir == root => return Err(error),
            Err(_) => continue,
        };
        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if is_high_churn_path(&path, root) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            snapshot.insert(
                path.clone(),
                PollFingerprint {
                    is_dir: file_type.is_dir(),
                    len: meta.len(),
                    modified: meta.modified().ok(),
                },
            );
            if file_type.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(snapshot)
}

fn poll_changes(
    previous: &HashMap<PathBuf, PollFingerprint>,
    current: &HashMap<PathBuf, PollFingerprint>,
) -> Vec<(PathBuf, bool)> {
    let mut paths = previous
        .keys()
        .chain(current.keys())
        .cloned()
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter_map(|path| {
            let before = previous.get(&path);
            let after = current.get(&path);
            (before != after).then(|| {
                let is_dir = after
                    .or(before)
                    .map(|fingerprint| fingerprint.is_dir)
                    .unwrap_or(false);
                (path, is_dir)
            })
        })
        .collect()
}

fn wait_for_poll(cancel: &AtomicBool) -> bool {
    let deadline = Instant::now() + WATCH_POLL_INTERVAL;
    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(WATCH_POLL_CANCEL_SLICE);
    }
    cancel.load(Ordering::SeqCst)
}

/// inotify 配额不足时仍要提供文件变更通知。轮询比较元数据快照，覆盖新增、
/// 删除和常见修改；目录事件也会上报，让客户端能整目录刷新。
fn poll_loop(
    root: PathBuf,
    cancel: Arc<AtomicBool>,
    send: Sender<serde_json::Value>,
) -> Result<(), String> {
    let mut previous =
        poll_snapshot(&root).map_err(|error| format!("建立文件监视轮询快照失败: {error}"))?;
    let mut filter = EmitFilter::new(root.clone());
    loop {
        if wait_for_poll(&cancel) {
            return Ok(());
        }
        let current = match poll_snapshot(&root) {
            Ok(snapshot) => snapshot,
            Err(_error) if root.exists() => continue,
            Err(error) => return Err(format!("文件监视轮询失败: {error}")),
        };
        for (path, is_dir) in poll_changes(&previous, &current) {
            if !filter.should_emit(&path) {
                continue;
            }
            let record = json!({
                "path": path.to_string_lossy(),
                "kind": "any",
                "isDir": is_dir,
            });
            if send.blocking_send(record).is_err() {
                return Ok(());
            }
        }
        previous = current;
    }
}

/// 递归监视 `root`（已 canonicalize）并逐条推送变更事件，直到客户端断开
/// 或 cancel 置位。监视器彻底失效（如根目录被删除）时返回 Err。
pub fn watch_loop(
    root: PathBuf,
    cancel: Arc<AtomicBool>,
    send: Sender<serde_json::Value>,
) -> Result<(), String> {
    let (event_tx, event_rx) = mpsc::channel::<DebounceEventResult>();
    // 350ms 去抖与主程序 file_watcher.rs 相同，两端刷新节奏一致。
    let mut debouncer = new_debouncer(Duration::from_millis(350), move |result| {
        let _ = event_tx.send(result);
    })
    .map_err(|e| format!("创建文件监视器失败: {e}"))?;
    let mut watched = HashSet::new();
    if let Err(error) = register_watch_tree(&mut debouncer, &root, &root, &mut watched) {
        if should_fallback_to_polling(&error) {
            drop(debouncer);
            return poll_loop(root, cancel, send);
        }
        return Err(format!("注册目录监视失败: {error}"));
    }

    let mut filter = EmitFilter::new(root);
    // 首次枚举/注册期间可能产生系统元数据事件；丢弃注册后 500ms 内的首批
    // 事件，避免客户端每次建立 watch 多一轮无谓刷新。
    // 代价：恰好在建立监视的半秒内发生的真实修改也会被丢弃，属可接受取舍。
    let registered_at = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        match event_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(events)) => {
                for event in events {
                    let path = &event.path;
                    // 新目录必须补注册；预热期只抑制事件发送，不能跳过注册。
                    if let Err(error) =
                        refresh_watch_tree(&mut debouncer, &filter.root, path, &mut watched)
                    {
                        if should_fallback_to_polling(&error) {
                            drop(debouncer);
                            return poll_loop(filter.root.clone(), cancel, send);
                        }
                        return Err(format!("注册新增目录监视失败: {error}"));
                    }
                    if registered_at.elapsed() < Duration::from_millis(500) {
                        continue;
                    }
                    if !filter.should_emit(path) {
                        continue;
                    }
                    // is_dir 在发送时尽力判断：事件到发送之间路径可能已消失。
                    let record = json!({
                        "path": path.to_string_lossy(),
                        "kind": event_kind(event.kind),
                        "isDir": path.is_dir(),
                    });
                    if send.blocking_send(record).is_err() {
                        // 客户端断开，正常收尾（debouncer 随函数返回 drop）。
                        return Ok(());
                    }
                }
            }
            Ok(Err(error)) => {
                if should_fallback_to_polling(&error) {
                    drop(debouncer);
                    return poll_loop(filter.root.clone(), cancel, send);
                }
                // 其他瞬时错误（如子目录被短暂移除）：忽略，等待后续事件。
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // 去抖线程退出且通道关闭：监视器已失效。
                return Err("文件监视器已失效".to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 临时目录：进程 id + 纳秒时间戳保证唯一，canonicalize 后返回。
    fn temp_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "qingcode-server-watch-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn filter_rejects_out_of_root_high_churn_and_temp_files() {
        let root = temp_root("filter");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::create_dir_all(root.join("src/release")).unwrap();
        std::fs::write(root.join("src/main.rs"), "x").unwrap();

        let mut filter = EmitFilter::new(root.clone());
        assert!(filter.should_emit(&root.join("src/main.rs")));
        // 子目录同名 release 与主程序一致：正常上报。
        assert!(filter.should_emit(&root.join("src/release/x.js")));
        // 根级 release 是打包产物目录。
        assert!(!filter.should_emit(&root.join("release/app")));
        assert!(!filter.should_emit(&root.join("node_modules/lib.js")));
        assert!(!filter.should_emit(&root.join("target/debug/app")));
        // 自写原子文件的临时/备份后缀。
        assert!(!filter.should_emit(&root.join("settings.tmp")));
        assert!(!filter.should_emit(&root.join("settings.backup")));
        // 字面上就在 root 外的路径。
        assert!(!filter.should_emit(Path::new("/outside/x.rs")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn filter_accepts_deleted_path_inside_root() {
        let root = temp_root("deleted");
        std::fs::create_dir_all(root.join("src")).unwrap();
        // 文件已不存在（删除事件）：canonicalize 会失败，按父目录判定。
        let mut filter = EmitFilter::new(root.clone());
        assert!(filter.should_emit(&root.join("src/gone.rs")));
        // 父目录也不存在时无法判定，丢弃。
        assert!(!filter.should_emit(&root.join("no-such-dir/gone.rs")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn watch_registration_skips_high_churn_directories() {
        let root = temp_root("watch-excludes");
        for dir in [
            "src",
            "src/release",
            "node_modules/pkg",
            "target/debug",
            "dist/assets",
            ".git/objects",
            "release",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }

        let dirs = collect_watch_dirs(&root, &root).unwrap();
        assert!(dirs.contains(&root));
        assert!(dirs.contains(&root.join("src")));
        // release 只在根级排除，源码树里的同名目录仍要监视。
        assert!(dirs.contains(&root.join("src/release")));
        assert!(!dirs
            .iter()
            .any(|dir| dir.starts_with(root.join("node_modules"))));
        assert!(!dirs.iter().any(|dir| dir.starts_with(root.join("target"))));
        assert!(!dirs.iter().any(|dir| dir.starts_with(root.join("dist"))));
        assert!(!dirs.iter().any(|dir| dir.starts_with(root.join(".git"))));
        assert!(!dirs.iter().any(|dir| dir.starts_with(root.join("release"))));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn watch_limit_errors_use_polling_fallback() {
        let limit = NotifyError::new(NotifyErrorKind::MaxFilesWatch);
        assert!(should_fallback_to_polling(&limit));
        #[cfg(unix)]
        {
            let enospc = NotifyError::new(NotifyErrorKind::Io(std::io::Error::from_raw_os_error(
                libc::ENOSPC,
            )));
            assert!(should_fallback_to_polling(&enospc));
        }
        let transient = NotifyError::new(NotifyErrorKind::PathNotFound);
        assert!(!should_fallback_to_polling(&transient));
    }

    #[test]
    fn polling_diff_reports_created_modified_and_deleted_paths() {
        let created = PathBuf::from("/root/new.rs");
        let modified = PathBuf::from("/root/src/main.rs");
        let deleted = PathBuf::from("/root/old.rs");
        let fingerprint = |len| PollFingerprint {
            is_dir: false,
            len,
            modified: None,
        };
        let previous = HashMap::from([
            (modified.clone(), fingerprint(10)),
            (deleted.clone(), fingerprint(20)),
        ]);
        let current = HashMap::from([
            (created.clone(), fingerprint(5)),
            (modified.clone(), fingerprint(11)),
        ]);

        assert_eq!(
            poll_changes(&previous, &current),
            vec![(created, false), (deleted, false), (modified, false)]
        );
    }

    #[cfg(unix)]
    #[test]
    fn filter_drops_events_through_symlink_escaping_root() {
        let root = temp_root("symlink-root");
        let outside = temp_root("symlink-outside");
        std::fs::create_dir_all(outside.join("network")).unwrap();
        std::fs::write(outside.join("network/interfaces"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        let mut filter = EmitFilter::new(root.clone());
        // 字面在 root 下、实际在 outside：必须丢弃。
        assert!(!filter.should_emit(&root.join("escape/network/interfaces")));
        assert!(!filter.should_emit(&root.join("escape")));
        // 同目录下的正常文件仍要上报。
        std::fs::write(root.join("a.rs"), "x").unwrap();
        assert!(filter.should_emit(&root.join("a.rs")));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
