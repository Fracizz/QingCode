//! 文件系统操作实现：目录扫描与字面量内容搜索。
//!
//! 搜索语义对齐客户端现有的远端 `rg` 行为：`--fixed-strings` 字面量匹配、
//! `rg --json` 同形的 match 记录、glob 过滤与多级上限截断。两个函数都是
//! 阻塞式的，调用方（lib.rs 的 handle_conn）需经 `spawn_blocking` 调用。

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use tokio::sync::mpsc::Sender;

use crate::{escape_regex_literal, path_is_within, resolve_within_root};

/// 单条记录（一行匹配文本）的字节上限，与客户端
/// `src-tauri/src/remote_ssh/search.rs` 的 `MAX_RECORD_BYTES` 对齐。
/// 超限行必须截断：否则整帧会超过 `MAX_FRAME_BYTES`，`write_frame` 报错、
/// 连接直接中断且客户端收不到 done/error 帧。
const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;

/// 把一行原始字节裁到 [`MAX_RECORD_BYTES`] 以内，返回（切片, 是否截断）。
/// 截断点向前退到 UTF-8 字符边界，避免 lossy 转换后留下半个字符。
fn truncate_line_bytes(bytes: &[u8]) -> (&[u8], bool) {
    if bytes.len() <= MAX_RECORD_BYTES {
        return (bytes, false);
    }
    let mut end = MAX_RECORD_BYTES;
    // 0b10xx_xxxx 是 UTF-8 续字节：落在续字节上说明切断了多字节字符，继续前移。
    // 最多退 3 字节即可回到字符起始字节，非法 UTF-8 输入也不会死循环。
    while end > 0 && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    (&bytes[..end], true)
}

/// `scan` 操作的单条目录项。排序由客户端负责，代理只保证完整。
pub struct ScanEntry {
    pub name: String,
    pub is_dir: bool,
}

/// 列出 `root`（已 canonicalize）下 `relative` 目录的直接子项。
pub fn scan_dir(root: &Path, relative: &str) -> Result<Vec<ScanEntry>, String> {
    let path = resolve_within_root(root, relative)?;
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("无法访问目录: {e}"))?;
    if !path_is_within(&canonical, root) {
        // 符号链接等真实路径绕出根的情况，词法检查拦不住，这里兜底。
        return Err("路径越出了项目根".to_string());
    }
    let mut entries = Vec::new();
    let read = std::fs::read_dir(&canonical).map_err(|e| format!("无法读取目录: {e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("无法读取目录项: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
        entries.push(ScanEntry { name, is_dir });
    }
    Ok(entries)
}

/// `searchContent` 请求参数，字段与 `AgentOp::SearchContent` 一一对应。
#[derive(Debug, Clone)]
pub struct ContentSearchParams {
    pub query: String,
    pub ignore_case: bool,
    /// glob 白名单（如 `*.ts`）与黑名单（客户端已保证带 `!` 前缀）。
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    /// 对应 `rg --no-ignore`：忽略所有 ignore 文件规则。
    pub no_ignore: bool,
    pub max_matches: usize,
    pub max_per_file: usize,
    pub max_files: usize,
}

/// 搜索结束时的统计。`truncated` 只在触发上限截断时为真。
#[derive(Debug, Clone, Copy, Default)]
pub struct ContentSearchSummary {
    pub truncated: bool,
    pub files_scanned: usize,
}

/// 单次搜索的共享状态：跨文件累计值与截断/取消标志都挂在这里，
/// `Sink` 实现按文件复用同一份结构，避免在闭包里搬运可变借用。
/// 通用化 matcher 类型：`grep-searcher` 的 Sink 只回调整行文本，
/// 行内 submatch 偏移需借助原 matcher 在行内重新定位。
struct SearchSession<'a, M: Matcher> {
    send: &'a Sender<serde_json::Value>,
    cancel: &'a Arc<AtomicBool>,
    matcher: &'a M,
    /// 单文件允许产出的记录数（max_per_file + 1，多出的 1 条是截断探针）。
    per_file_limit: usize,
    max_matches: usize,
    /// 当前文件的展示路径（`./<相对路径>`），每个文件开始前更新。
    path_text: String,
    per_file_count: usize,
    total_matches: usize,
    /// 触发了全局上限截断。
    truncated: bool,
    /// 客户端断开 / 全局截断 / 取消，需立刻停止整个遍历。
    stop_all: bool,
}

impl<M: Matcher> Sink for SearchSession<'_, M> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.cancel.load(Ordering::SeqCst) {
            self.stop_all = true;
            return Ok(false);
        }
        self.per_file_count += 1;
        self.total_matches += 1;
        // 整行原文（含换行）；非法 UTF-8 按 lossy 处理，与客户端展示一致。
        // 超限行先按字节安全截断，保证后续帧一定不超过 MAX_FRAME_BYTES。
        let (line_bytes, line_truncated) = truncate_line_bytes(mat.bytes());
        let line = String::from_utf8_lossy(line_bytes).into_owned();
        // 与 rg 一致：对整行重新跑一遍 matcher，取全部命中区间作为 submatches。
        // 已被截断裁掉的命中（偏移 >= 截断长度）没有对应文本，直接丢弃。
        let mut submatches = Vec::new();
        let visible = line_bytes.len();
        let _ = self
            .matcher
            .find_iter(mat.bytes(), |m: grep_matcher::Match| {
                if m.start() >= visible {
                    return false;
                }
                submatches.push(serde_json::json!({
                    "start": m.start(),
                    "end": m.end(),
                }));
                true
            });
        let record = serde_json::json!({
            "type": "match",
            "data": {
                "path": { "text": self.path_text.clone() },
                "lines": { "text": line },
                "line_number": mat.line_number().unwrap_or(0),
                "submatches": submatches,
            }
        });
        if self.send.blocking_send(record).is_err() {
            // 客户端断开，等价于取消。
            self.stop_all = true;
            return Ok(false);
        }
        if line_truncated {
            // 超限行与客户端 rg 路径语义一致：截断即停止整次搜索，并标记截断，
            // 让调用方照常发出 done 帧（连接不会断）。
            self.truncated = true;
            self.stop_all = true;
            return Ok(false);
        }
        if self.total_matches >= self.max_matches {
            self.truncated = true;
            self.stop_all = true;
            return Ok(false);
        }
        if self.per_file_count >= self.per_file_limit {
            // 达到单文件上限：停止搜索本文件，但不标记全局截断。
            return Ok(false);
        }
        Ok(true)
    }
}

/// 阻塞式内容搜索：遍历 `root`，按字面量语义产出与 `rg --json` 同形的
/// match 记录。`cancel` 置位或客户端断开都按正常收尾返回当前统计。
pub fn search_content(
    root: &Path,
    params: &ContentSearchParams,
    cancel: &Arc<AtomicBool>,
    send: &Sender<serde_json::Value>,
) -> Result<ContentSearchSummary, String> {
    let mut walker = WalkBuilder::new(root);
    walker.follow_links(false);
    if params.no_ignore {
        // 对齐 rg --no-ignore：所有 ignore 规则（含父目录的）都不生效。
        walker
            .git_ignore(false)
            .git_exclude(false)
            .git_global(false)
            .ignore(false)
            .parents(false);
    }
    let mut overrides = OverrideBuilder::new(root);
    for glob in params
        .include_globs
        .iter()
        .chain(params.exclude_globs.iter())
    {
        overrides
            .add(glob)
            .map_err(|e| format!("非法 glob {glob:?}: {e}"))?;
    }
    let overrides = overrides
        .build()
        .map_err(|e| format!("构建 glob 过滤失败: {e}"))?;
    walker.overrides(overrides);

    // 字面量语义：与 rg --fixed-strings 一致，先把查询转义为等价正则。
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(params.ignore_case)
        .build(&escape_regex_literal(&params.query))
        .map_err(|e| format!("构建搜索匹配器失败: {e}"))?;
    let mut searcher = SearcherBuilder::new().line_number(true).build();

    let mut session = SearchSession {
        send,
        cancel,
        matcher: &matcher,
        per_file_limit: params.max_per_file.saturating_add(1),
        max_matches: params.max_matches,
        path_text: String::new(),
        per_file_count: 0,
        total_matches: 0,
        truncated: false,
        stop_all: false,
    };
    let mut files_scanned = 0usize;

    for result in walker.build() {
        if session.stop_all || cancel.load(Ordering::SeqCst) || send.is_closed() {
            break;
        }
        let entry = match result {
            Ok(entry) => entry,
            // 单个目录遍历失败不中断整体搜索。
            Err(_) => continue,
        };
        // 只搜常规文件：目录与符号链接（follow_links 已关闭）都跳过。
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files_scanned >= params.max_files {
            session.truncated = true;
            break;
        }
        files_scanned += 1;
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        // 统一为 POSIX 风格并带 ./ 前缀，客户端按 strip_prefix("./") 解析。
        session.path_text = format!("./{}", relative.to_string_lossy().replace('\\', "/"));
        session.per_file_count = 0;
        // 文件级 IO/解码错误直接跳过该文件，继续搜索其余文件。
        let _ = searcher.search_path(&matcher, entry.path(), &mut session);
    }

    Ok(ContentSearchSummary {
        truncated: session.truncated,
        files_scanned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 临时目录：进程 id + 纳秒时间戳保证唯一，canonicalize 后返回，
    /// 否则 Windows 的 \\?\ 前缀差异会让 path_is_within 误判越界。
    fn temp_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "qingcode-agent-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn write_file(path: &Path, content: &str) {
        std::fs::write(path, content).unwrap();
    }

    fn base_params(query: &str) -> ContentSearchParams {
        ContentSearchParams {
            query: query.to_string(),
            ignore_case: false,
            include_globs: vec![],
            exclude_globs: vec![],
            no_ignore: false,
            max_matches: 1000,
            max_per_file: 100,
            max_files: 1000,
        }
    }

    /// 收集端：spawn_blocking 包住阻塞搜索，recv 收齐全部记录。
    async fn run_search(
        root: &Path,
        params: &ContentSearchParams,
    ) -> (Vec<serde_json::Value>, ContentSearchSummary) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let cancel = Arc::new(AtomicBool::new(false));
        let root = root.to_path_buf();
        let params = params.clone();
        let producer = tokio::task::spawn_blocking(move || {
            search_content(&root, &params, &cancel, &tx).unwrap()
        });
        let mut records = Vec::new();
        while let Some(record) = rx.recv().await {
            records.push(record);
        }
        let summary = producer.await.unwrap();
        (records, summary)
    }

    #[test]
    fn scan_dir_lists_entries_and_rejects_escape() {
        let root = temp_root("scan");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        write_file(&root.join("a.txt"), "x");
        write_file(&root.join("b.txt"), "y");

        let mut entries = scan_dir(&root, "").unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.txt", "sub"]);
        assert!(entries.iter().find(|e| e.name == "sub").unwrap().is_dir);
        assert!(!entries.iter().find(|e| e.name == "a.txt").unwrap().is_dir);

        assert!(scan_dir(&root, "../escape").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn search_content_emits_rg_json_style_records() {
        let root = temp_root("search-basic");
        write_file(&root.join("a.ts"), "hello world\nsecond hello world line\n");
        write_file(&root.join("b.md"), "nothing here\n");
        write_file(&root.join(".hidden.ts"), "hello world\n");

        let (records, summary) = run_search(&root, &base_params("hello world")).await;
        // 隐藏文件默认跳过（ignore crate 的 hidden 过滤与 no_ignore 无关）。
        assert!(records
            .iter()
            .all(|r| !r["data"]["path"]["text"].to_string().contains("hidden")));
        // a.ts 两处命中，b.md 无命中。
        assert_eq!(records.len(), 2);
        let first = &records[0];
        assert_eq!(first["type"], "match");
        let path_text = first["data"]["path"]["text"].as_str().unwrap();
        assert!(path_text.starts_with("./"));
        assert_eq!(path_text, "./a.ts");
        assert_eq!(first["data"]["lines"]["text"], "hello world\n");
        assert_eq!(first["data"]["line_number"], 1);
        assert_eq!(first["data"]["submatches"][0]["start"], 0);
        assert_eq!(first["data"]["submatches"][0]["end"], 11);
        assert_eq!(records[1]["data"]["line_number"], 2);
        assert_eq!(records[1]["data"]["submatches"][0]["start"], 7);
        assert_eq!(records[1]["data"]["submatches"][0]["end"], 18);
        assert!(!summary.truncated);
        assert_eq!(summary.files_scanned, 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn search_content_include_globs_filter_files() {
        let root = temp_root("search-glob");
        write_file(&root.join("a.ts"), "hello\n");
        write_file(&root.join("b.md"), "hello\n");

        let mut params = base_params("hello");
        params.include_globs = vec!["*.ts".to_string()];
        let (records, summary) = run_search(&root, &params).await;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["data"]["path"]["text"], "./a.ts");
        assert_eq!(summary.files_scanned, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn search_content_per_file_limit_sends_probe_record() {
        let root = temp_root("search-per-file");
        write_file(&root.join("a.ts"), "hello world\nsecond hello world line\n");

        let mut params = base_params("hello world");
        params.max_per_file = 1;
        let (records, summary) = run_search(&root, &params).await;
        // 每文件 max_per_file + 1 条：第 2 条是客户端标记单文件截断的探针。
        assert_eq!(records.len(), 2);
        // 单文件截断不构成全局截断。
        assert!(!summary.truncated);
        assert_eq!(summary.files_scanned, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn search_content_multi_hits_in_one_line_share_record() {
        let root = temp_root("search-multi");
        write_file(&root.join("a.ts"), "go go go\n");
        let (records, _summary) = run_search(&root, &base_params("go")).await;
        // 一行多处命中与 rg 一致：单条 match 记录，submatches 列出全部区间。
        assert_eq!(records.len(), 1);
        let subs = records[0]["data"]["submatches"].as_array().unwrap();
        assert_eq!(subs.len(), 3);
        let starts: Vec<u64> = subs.iter().map(|s| s["start"].as_u64().unwrap()).collect();
        assert_eq!(starts, vec![0, 3, 6]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn search_content_max_matches_marks_truncated() {
        let root = temp_root("search-max-matches");
        write_file(&root.join("a.ts"), "hello world\nsecond hello world line\n");

        let mut params = base_params("hello world");
        params.max_matches = 1;
        let (records, summary) = run_search(&root, &params).await;
        assert_eq!(records.len(), 1);
        assert!(summary.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn search_content_max_files_marks_truncated() {
        let root = temp_root("search-max-files");
        write_file(&root.join("a.ts"), "hello world\n");
        write_file(&root.join("b.md"), "hello world\n");

        let mut params = base_params("hello world");
        params.max_files = 1;
        let (_records, summary) = run_search(&root, &params).await;
        assert_eq!(summary.files_scanned, 1);
        assert!(summary.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn search_content_cancel_stops_before_scanning() {
        let root = temp_root("search-cancel");
        write_file(&root.join("a.ts"), "hello world\n");
        let (tx, _rx) = tokio::sync::mpsc::channel(64);
        let cancel = Arc::new(AtomicBool::new(true));
        let summary = search_content(&root, &base_params("hello world"), &cancel, &tx).unwrap();
        assert_eq!(summary.files_scanned, 0);
        assert!(!summary.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn truncate_line_bytes_cuts_on_char_boundary() {
        // 未超限：原样返回。
        let short = "hello\n".as_bytes();
        assert_eq!(truncate_line_bytes(short), (short, false));
        // 恰好等于上限：不算截断。
        let exact = vec![b'a'; MAX_RECORD_BYTES];
        let (slice, truncated) = truncate_line_bytes(&exact);
        assert_eq!(slice.len(), MAX_RECORD_BYTES);
        assert!(!truncated);
        // 上限正好落在三字节字符中间：退到字符起始字节，不产生半个字符。
        let mut bytes = vec![b'a'; MAX_RECORD_BYTES - 1];
        bytes.extend_from_slice("中".as_bytes());
        assert_eq!(bytes.len(), MAX_RECORD_BYTES + 2);
        let (slice, truncated) = truncate_line_bytes(&bytes);
        assert!(truncated);
        assert_eq!(slice.len(), MAX_RECORD_BYTES - 1);
        assert!(std::str::from_utf8(slice).is_ok());
    }

    #[tokio::test]
    async fn search_content_truncates_oversized_line_and_keeps_done() {
        let root = temp_root("search-oversize");
        // 单行超过 2MB：命中落在截断范围内，仍要产出记录并标记截断。
        let mut line = String::from("hello world ");
        line.push_str(&"x".repeat(3 * 1024 * 1024));
        line.push('\n');
        write_file(&root.join("big.ts"), &line);

        let (records, summary) = run_search(&root, &base_params("hello world")).await;
        assert_eq!(records.len(), 1);
        let text = records[0]["data"]["lines"]["text"].as_str().unwrap();
        assert!(
            text.len() <= MAX_RECORD_BYTES,
            "截断后仍超上限: {}",
            text.len()
        );
        assert!(text.starts_with("hello world "));
        assert_eq!(records[0]["data"]["submatches"][0]["start"], 0);
        // 超限即视为截断收尾，调用方据此仍会发出 done 帧。
        assert!(summary.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn search_content_oversized_line_with_multibyte_text_stays_valid() {
        let root = temp_root("search-oversize-utf8");
        let mut line = String::from("命中 ");
        line.push_str(&"中".repeat(1024 * 1024));
        line.push('\n');
        write_file(&root.join("big.ts"), &line);

        let (records, summary) = run_search(&root, &base_params("命中")).await;
        assert_eq!(records.len(), 1);
        let text = records[0]["data"]["lines"]["text"].as_str().unwrap();
        assert!(text.len() <= MAX_RECORD_BYTES);
        assert!(text.starts_with("命中 "));
        assert!(!text.contains('\u{FFFD}'), "截断产生了非法字符");
        assert!(summary.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }
}
