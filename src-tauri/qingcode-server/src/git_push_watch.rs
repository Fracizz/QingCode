//! 「Git 多端同步」的推送事件源（独立功能，移除清单见 docs/git-push-sync.md）。
//!
//! `git push` 成功后 Git 会向 `logs/refs/remotes/<remote>/<branch>` 追加一行
//! `update by push`，无论推送来自 SCM 面板、终端还是 Agent。这里只监听 reflog
//! 目录：`git fetch` 写入的是 `fetch ...`，不会形成同步回环。
//!
//! 本地项目（桌面进程）与 Server 模式（daemon）共用这份实现。

use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

const PUSH_MESSAGE: &str = "update by push";
const DEBOUNCE: Duration = Duration::from_millis(200);
/// 等待事件的切片：决定取消请求的响应时间，不做文件扫描。
const CANCEL_CHECK: Duration = Duration::from_millis(250);
/// 断线补发只需要最近的记录，避免读取很长的 reflog。
const BACKFILL_TAIL_BYTES: u64 = 64 * 1024;

/// 一次成功的推送。`at` 是写入 reflog 的机器时钟（Unix 秒）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushEvent {
    pub remote: String,
    pub branch: String,
    pub sha: String,
    pub at: i64,
}

/// 解析一行 reflog：`<old> <new> <ident> <ts> <tz>\t<message>`。
/// ident 可能含空格，所以时间戳从行尾取。删除远端分支（新值全 0）不算推送。
fn parse_push_line(line: &str) -> Option<(String, i64)> {
    let (head, message) = line.split_once('\t')?;
    if message.trim_end() != PUSH_MESSAGE {
        return None;
    }
    let fields = head.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 4 {
        return None;
    }
    let sha = fields[1];
    if sha.is_empty() || sha.bytes().all(|byte| byte == b'0') {
        return None;
    }
    let at = fields[fields.len() - 2].parse().ok()?;
    Some((sha.to_string(), at))
}

/// 从 reflog 路径还原 `<remote>/<branch>`；分支名可含 `/`。
fn ref_from_path(remotes_dir: &Path, path: &Path) -> Option<(String, String)> {
    let relative = path.strip_prefix(remotes_dir).ok()?;
    let mut parts = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned());
    let remote = parts.next()?;
    let branch = parts.collect::<Vec<_>>().join("/");
    (!branch.is_empty()).then_some((remote, branch))
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_files(&entry.path(), out);
        } else if kind.is_file() {
            out.push(entry.path());
        }
    }
}

/// 记录每个 reflog 的已读位置，只解析追加的完整行。
struct ReflogTracker {
    remotes_dir: PathBuf,
    offsets: HashMap<PathBuf, u64>,
}

impl ReflogTracker {
    /// 以当前文件末尾为基线；`since` 非空时补发其后发生的推送（每个分支取最新一条）。
    fn new(remotes_dir: PathBuf, since: Option<i64>) -> (Self, Vec<PushEvent>) {
        let mut tracker = Self {
            remotes_dir,
            offsets: HashMap::new(),
        };
        let mut files = Vec::new();
        collect_files(&tracker.remotes_dir, &mut files);
        let mut backfill = Vec::new();
        for path in files {
            let Ok(len) = std::fs::metadata(&path).map(|meta| meta.len()) else {
                continue;
            };
            if let Some(since) = since {
                if let Some(event) = tracker.last_push_since(&path, len, since) {
                    backfill.push(event);
                }
            }
            tracker.offsets.insert(path, len);
        }
        (tracker, backfill)
    }

    fn event_for(&self, path: &Path, sha: String, at: i64) -> Option<PushEvent> {
        let (remote, branch) = ref_from_path(&self.remotes_dir, path)?;
        Some(PushEvent {
            remote,
            branch,
            sha,
            at,
        })
    }

    fn last_push_since(&self, path: &Path, len: u64, since: i64) -> Option<PushEvent> {
        let start = len.saturating_sub(BACKFILL_TAIL_BYTES);
        let text = read_from(path, start)?;
        let text = String::from_utf8_lossy(&text);
        // 从文件中间开始读时第一行可能不完整，解析失败会被自然跳过。
        let (sha, at) = text
            .lines()
            .filter_map(parse_push_line)
            .rfind(|(_, at)| *at > since)?;
        self.event_for(path, sha, at)
    }

    /// 读取一个文件新增的内容，返回其中最后一次推送。
    fn read_appended(&mut self, path: &Path, len: u64) -> Option<PushEvent> {
        let offset = self.offsets.get(path).copied().unwrap_or(0);
        if len == offset {
            return None;
        }
        if len < offset {
            // reflog 被 expire 重写：不是新推送，只重置基线。
            self.offsets.insert(path.to_path_buf(), len);
            return None;
        }
        let bytes = read_from(path, offset)?;
        // Git 可能正在写入：只消费到最后一个换行，半行留给下一次事件。
        let complete = bytes.iter().rposition(|byte| *byte == b'\n')? + 1;
        self.offsets
            .insert(path.to_path_buf(), offset + complete as u64);
        let text = String::from_utf8_lossy(&bytes[..complete]);
        let (sha, at) = text.lines().filter_map(parse_push_line).next_back()?;
        self.event_for(path, sha, at)
    }

    /// 比较全部 reflog 的大小。文件很少；全量比较能覆盖新建目录时漏掉的文件事件。
    fn scan(&mut self) -> Vec<PushEvent> {
        let mut files = Vec::new();
        collect_files(&self.remotes_dir, &mut files);
        files
            .into_iter()
            .filter_map(|path| {
                let len = std::fs::metadata(&path).ok()?.len();
                self.read_appended(&path, len)
            })
            .collect()
    }
}

fn read_from(path: &Path, offset: u64) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// 由 Git 解析公共目录，以支持 worktree 和位于仓库子目录的项目。
fn resolve_logs_dir(root: &Path) -> Result<PathBuf, String> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(["rev-parse", "--git-common-dir"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("无法运行 Git：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let relative = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let common = std::fs::canonicalize(root.join(relative))
        .map_err(|error| format!("无法定位 Git 目录：{error}"))?;
    if common.join("reftable").exists() {
        return Err("reftable 仓库没有可监听的 reflog 文件".to_string());
    }
    let logs = common.join("logs");
    if !logs.is_dir() {
        return Err("仓库未启用 reflog".to_string());
    }
    Ok(logs)
}

/// 阻塞监听，直到 `cancel` 置位或 `emit` 返回 false。
///
/// `since` 用于重连补发：传入上次事件的时间，错过的推送会先补发一次。
/// 监听注册在建立基线之前，两者之间写入的内容会被后续事件读到。
pub fn watch_pushes(
    root: &Path,
    since: Option<i64>,
    cancel: &AtomicBool,
    mut emit: impl FnMut(PushEvent) -> bool,
) -> Result<(), String> {
    let logs = resolve_logs_dir(root)?;
    let (sender, receiver) = mpsc::channel();
    let mut debouncer = new_debouncer(DEBOUNCE, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| format!("创建 reflog 监听失败：{error}"))?;
    // 监听整个 logs：首次推送前 refs/remotes 可能还不存在。
    debouncer
        .watcher()
        .watch(&logs, RecursiveMode::Recursive)
        .map_err(|error| format!("注册 reflog 监听失败：{error}"))?;

    let (mut tracker, backfill) = ReflogTracker::new(logs.join("refs").join("remotes"), since);
    for event in backfill {
        if !emit(event) {
            return Ok(());
        }
    }
    while !cancel.load(Ordering::SeqCst) {
        match receiver.recv_timeout(CANCEL_CHECK) {
            Ok(_) => {
                for event in tracker.scan() {
                    if !emit(event) {
                        return Ok(());
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const OLD: &str = "1111111111111111111111111111111111111111";
    const NEW: &str = "2222222222222222222222222222222222222222";

    fn line(new: &str, at: i64, message: &str) -> String {
        format!("{OLD} {new} Some One <a@b.c> {at} +0800\t{message}\n")
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "qc-push-watch-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn append(path: &Path, text: &str) {
        use std::io::Write;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn parse_push_line_accepts_only_push_records() {
        let parsed = parse_push_line(line(NEW, 1700, PUSH_MESSAGE).trim_end());
        assert_eq!(parsed, Some((NEW.to_string(), 1700)));
        assert_eq!(
            parse_push_line(line(NEW, 1700, "fetch origin: fast-forward").trim_end()),
            None
        );
    }

    #[test]
    fn parse_push_line_ignores_remote_branch_deletion() {
        let zero = "0".repeat(40);
        assert_eq!(
            parse_push_line(line(&zero, 1, PUSH_MESSAGE).trim_end()),
            None
        );
    }

    #[test]
    fn ref_from_path_keeps_slashes_in_branch() {
        let base = Path::new("logs");
        assert_eq!(
            ref_from_path(base, &base.join("origin").join("feat").join("x")),
            Some(("origin".to_string(), "feat/x".to_string()))
        );
        assert_eq!(ref_from_path(base, &base.join("origin")), None);
    }

    #[test]
    fn tracker_reports_only_appended_pushes() {
        let dir = temp_dir("append");
        let log = dir.join("origin").join("main");
        append(&log, &line(OLD, 1, PUSH_MESSAGE));
        let (mut tracker, backfill) = ReflogTracker::new(dir.clone(), None);
        assert!(backfill.is_empty());
        assert!(tracker.scan().is_empty());

        append(&log, &line(NEW, 2, "fetch origin: fast-forward"));
        assert!(tracker.scan().is_empty());

        append(&log, &line(NEW, 3, PUSH_MESSAGE));
        let events = tracker.scan();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].branch, "main");
        assert_eq!(events[0].sha, NEW);
        assert!(tracker.scan().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tracker_leaves_partial_line_for_next_scan() {
        let dir = temp_dir("partial");
        let log = dir.join("origin").join("main");
        append(&log, "");
        let (mut tracker, _) = ReflogTracker::new(dir.clone(), None);
        let full = line(NEW, 5, PUSH_MESSAGE);
        let (head, tail) = full.split_at(30);
        append(&log, head);
        assert!(tracker.scan().is_empty());
        append(&log, tail);
        assert_eq!(tracker.scan().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tracker_backfills_latest_push_after_since() {
        let dir = temp_dir("backfill");
        let log = dir.join("origin").join("main");
        append(&log, &line(OLD, 10, PUSH_MESSAGE));
        append(&log, &line(NEW, 20, PUSH_MESSAGE));
        let (_, events) = ReflogTracker::new(dir.clone(), Some(15));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].sha, NEW);
        let (_, events) = ReflogTracker::new(dir.clone(), Some(20));
        assert!(events.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tracker_resets_baseline_when_reflog_is_rewritten() {
        let dir = temp_dir("rewrite");
        let log = dir.join("origin").join("main");
        append(&log, &line(OLD, 1, PUSH_MESSAGE));
        append(&log, &line(NEW, 2, PUSH_MESSAGE));
        let (mut tracker, _) = ReflogTracker::new(dir.clone(), None);
        std::fs::write(&log, line(NEW, 2, PUSH_MESSAGE)).unwrap();
        assert!(tracker.scan().is_empty());
        append(&log, &line(OLD, 3, PUSH_MESSAGE));
        assert_eq!(tracker.scan().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// 用真实 `git push` 验证事件链路，而不是手写 reflog。
    #[test]
    fn watch_pushes_reports_real_git_push_but_not_fetch() {
        let base = temp_dir("real");
        let remote = base.join("remote.git");
        let work = base.join("work");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]);
        git(&work, &["init", "-b", "main"]);
        git(&work, &["config", "user.email", "t@example.com"]);
        git(&work, &["config", "user.name", "t"]);
        git(
            &work,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        );
        git(&work, &["commit", "--allow-empty", "-m", "one"]);
        git(&work, &["push", "-u", "origin", "main"]);

        let cancel = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let handle = {
            let (work, cancel) = (work.clone(), Arc::clone(&cancel));
            std::thread::spawn(move || {
                watch_pushes(&work, None, &cancel, |event| sender.send(event).is_ok())
            })
        };
        // 等待监听注册完成：注册前写入的内容属于基线。
        std::thread::sleep(Duration::from_millis(600));

        git(&work, &["fetch", "origin"]);
        git(&work, &["commit", "--allow-empty", "-m", "two"]);
        git(&work, &["push"]);
        let event = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("push event");
        assert_eq!(
            (event.remote.as_str(), event.branch.as_str()),
            ("origin", "main")
        );

        cancel.store(true, Ordering::SeqCst);
        handle.join().unwrap().unwrap();
        let _ = std::fs::remove_dir_all(base);
    }
}
