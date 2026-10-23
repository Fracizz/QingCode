//! 远端文件变更监视：事件形状与主程序 file_watcher.rs 保持一致，
//! 客户端复用同一条 `fs-change` 事件解析路径。
//!
//! `watch_loop` 是阻塞式的，调用方（lib.rs 的 handle_watch）经
//! `spawn_blocking` 调用；客户端断开、cancel 置位或发送失败即正常收尾。
//! 返回时 debouncer 一定被 drop，inotify 实例随之释放。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, DebouncedEventKind};
use serde_json::json;
use tokio::sync::mpsc::Sender;

use crate::{is_high_churn_path, path_is_within};

/// 目录判定缓存条目上限。事件突发时同一目录会反复出现，缓存避免每次都做
/// 完整 canonicalize；超过上限整体清空，保证长跑进程的缓存有界。
const DIR_CACHE_LIMIT: usize = 4096;

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
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("注册目录监视失败: {e}"))?;

    let mut filter = EmitFilter::new(root);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        match event_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(events)) => {
                for event in events {
                    let path = &event.path;
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
            Ok(Err(_)) => {
                // 监视器瞬时错误（如子目录被短暂移除）：忽略，等待后续事件。
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
            "qingcode-agent-watch-{tag}-{}-{nanos}",
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
