use super::*;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_SEARCH_HITS: usize = 10_000;
const MAX_PATH_LIST_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONTENT_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

struct FileSearchSlot {
    flag: Arc<AtomicBool>,
    active: bool,
    created: Instant,
}

static FILE_SEARCHES: OnceLock<Mutex<HashMap<String, FileSearchSlot>>> = OnceLock::new();

fn file_searches() -> &'static Mutex<HashMap<String, FileSearchSlot>> {
    FILE_SEARCHES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("文件搜索请求 ID 无效".to_string());
    }
    Ok(())
}

struct FileSearchRegistration {
    id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for FileSearchRegistration {
    fn drop(&mut self) {
        if let Ok(mut requests) = file_searches().lock() {
            requests.remove(&self.id);
        }
    }
}

fn register_file_search(id: String) -> Result<FileSearchRegistration, String> {
    validate_request_id(&id)?;
    let mut requests = file_searches()
        .lock()
        .map_err(|_| "文件搜索状态不可用".to_string())?;
    requests.retain(|_, slot| slot.active || slot.created.elapsed() < Duration::from_secs(300));
    if requests.get(&id).is_some_and(|slot| slot.active) {
        return Err("文件搜索请求已在运行".to_string());
    }
    if requests.len() >= 256 && !requests.contains_key(&id) {
        return Err("文件搜索请求过多，请稍后重试".to_string());
    }
    let slot = requests
        .entry(id.clone())
        .or_insert_with(|| FileSearchSlot {
            flag: Arc::new(AtomicBool::new(false)),
            active: false,
            created: Instant::now(),
        });
    slot.active = true;
    Ok(FileSearchRegistration {
        id,
        flag: Arc::clone(&slot.flag),
    })
}

#[tauri::command]
pub fn cancel_ssh_file_search(request_id: String) -> Result<(), String> {
    validate_request_id(&request_id)?;
    let mut requests = file_searches()
        .lock()
        .map_err(|_| "文件搜索状态不可用".to_string())?;
    requests.retain(|_, slot| slot.active || slot.created.elapsed() < Duration::from_secs(300));
    if requests.len() >= 256 && !requests.contains_key(&request_id) {
        return Err("文件搜索请求过多，请稍后重试".to_string());
    }
    requests
        .entry(request_id)
        .or_insert_with(|| FileSearchSlot {
            flag: Arc::new(AtomicBool::new(false)),
            active: false,
            created: Instant::now(),
        })
        .flag
        .store(true, Ordering::SeqCst);
    Ok(())
}

struct SearchControl {
    content_id: Option<u64>,
    filename_flag: Option<Arc<AtomicBool>>,
}

impl SearchControl {
    fn cancelled(&self) -> bool {
        self.filename_flag
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
            || self
                .content_id
                .is_some_and(|id| id != 0 && !crate::content_search::is_search_current(id))
    }
}

/// Poll the same future: individual polls must not restart SFTP/SSH requests.
async fn search_stage<T>(
    control: &SearchControl,
    started: Instant,
    future: impl Future<Output = Result<T, String>>,
) -> Result<Option<T>, String> {
    let stage_started = Instant::now();
    let mut future = std::pin::pin!(future);
    loop {
        if control.cancelled() {
            return Ok(None);
        }
        if started.elapsed() >= SEARCH_TIMEOUT || stage_started.elapsed() >= Duration::from_secs(10)
        {
            return Err("远程搜索超时，已停止当前搜索；请缩小搜索范围".to_string());
        }
        match tokio::time::timeout(Duration::from_millis(100), &mut future).await {
            Ok(result) => return result.map(Some),
            Err(_) => continue,
        }
    }
}

async fn validated_search_root(
    manager: &SshManager,
    root: &str,
    control: &SearchControl,
    started: Instant,
) -> Result<Option<String>, String> {
    search_stage(control, started, async {
        let (sftp, parsed, registered) = manager.sftp_for_uri(root, false).await?;
        // Use the resolved path in the command, not a user-supplied symlink alias.
        ensure_existing_path_within(&sftp, &parsed.path, &registered).await
    })
    .await
}

#[derive(Debug, Default)]
struct StreamResult {
    exit_code: u32,
    stderr: String,
    truncated: bool,
    cancelled: bool,
}

/// Consume bounded records as they arrive. Returning false stops the remote job.
#[allow(clippy::too_many_arguments)]
async fn stream_records(
    manager: &SshManager,
    root: &str,
    command: &str,
    delimiter: u8,
    control: &SearchControl,
    started: Instant,
    mut record: impl FnMut(&[u8]) -> bool,
) -> Result<StreamResult, String> {
    if control.cancelled() {
        return Ok(StreamResult {
            cancelled: true,
            ..Default::default()
        });
    }
    let parsed = parse_remote_uri(root)?;
    manager.root_for_uri(root, false)?;
    let session = manager.session(&parsed.connection_id)?;
    let Some(mut channel) = search_stage(control, started, async {
        session
            .handle
            .channel_open_session()
            .await
            .map_err(|error| error.to_string())
    })
    .await?
    else {
        return Ok(StreamResult {
            cancelled: true,
            ..Default::default()
        });
    };
    let execution = search_stage(control, started, async {
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|error| error.to_string())
    })
    .await;
    if !matches!(&execution, Ok(Some(_))) {
        let _ =
            tokio::time::timeout(Duration::from_secs(1), channel.signal(russh::Sig::TERM)).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        let _ = execution?;
        return Ok(StreamResult {
            cancelled: true,
            ..Default::default()
        });
    }
    let mut pending = Vec::new();
    let mut result = StreamResult {
        exit_code: 255,
        ..Default::default()
    };
    let mut timeout = false;
    'stream: loop {
        if control.cancelled() {
            result.cancelled = true;
            break;
        }
        if started.elapsed() >= SEARCH_TIMEOUT {
            timeout = true;
            break;
        }
        let message = match tokio::time::timeout(Duration::from_millis(100), channel.wait()).await {
            Ok(Some(message)) => message,
            Ok(None) => {
                if !pending.is_empty() && !record(&pending) {
                    result.truncated = true;
                }
                return Ok(result);
            }
            Err(_) => continue,
        };
        match message {
            ChannelMsg::Data { data } => {
                for segment in data.split_inclusive(|byte| *byte == delimiter) {
                    if pending.len() + segment.len() > MAX_RECORD_BYTES {
                        result.truncated = true;
                        break 'stream;
                    }
                    pending.extend_from_slice(segment);
                    if pending.last() == Some(&delimiter) {
                        pending.pop();
                        if !record(&pending) {
                            result.truncated = true;
                            break 'stream;
                        }
                        pending.clear();
                    }
                }
            }
            ChannelMsg::ExtendedData { data, .. } => {
                if result.stderr.len() < 8192 {
                    result.stderr.push_str(&String::from_utf8_lossy(
                        &data[..data.len().min(8192 - result.stderr.len())],
                    ));
                }
            }
            ChannelMsg::ExitStatus { exit_status } => result.exit_code = exit_status,
            _ => {}
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), channel.signal(russh::Sig::TERM)).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
    if timeout {
        return Err("远程搜索超时，已停止当前搜索；请缩小搜索范围".to_string());
    }
    Ok(result)
}

#[derive(Debug, Serialize)]
pub struct RemoteFileSearchResponse {
    pub hits: Vec<RemoteSearchHit>,
    pub truncated: bool,
    pub cancelled: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_search_files(
    root: String,
    query: String,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
    extension: Option<String>,
    extensions: Option<Vec<String>>,
    limit: Option<usize>,
    exclude_patterns: Option<Vec<String>>,
    use_ignore_files: Option<bool>,
    follow_symlinks: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteSearchHit>, String> {
    Ok(ssh_search_files_detailed(
        root,
        query,
        ignore_case,
        fuzzy,
        match_suffix,
        extension,
        extensions,
        limit,
        exclude_patterns,
        use_ignore_files,
        follow_symlinks,
        None,
        None,
        manager,
    )
    .await?
    .hits)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_search_files_detailed(
    root: String,
    query: String,
    ignore_case: bool,
    fuzzy: bool,
    match_suffix: bool,
    extension: Option<String>,
    extensions: Option<Vec<String>>,
    limit: Option<usize>,
    exclude_patterns: Option<Vec<String>>,
    use_ignore_files: Option<bool>,
    follow_symlinks: Option<bool>,
    search_id: Option<u64>,
    request_id: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<RemoteFileSearchResponse, String> {
    let _ = (use_ignore_files, follow_symlinks);
    let registration = request_id.map(register_file_search).transpose()?;
    let control = SearchControl {
        content_id: search_id,
        filename_flag: registration
            .as_ref()
            .map(|request| Arc::clone(&request.flag)),
    };
    let started = Instant::now();
    let Some(canonical_root) = validated_search_root(&manager, &root, &control, started).await?
    else {
        return Ok(RemoteFileSearchResponse {
            hits: Vec::new(),
            truncated: false,
            cancelled: true,
        });
    };
    let max = limit.unwrap_or(500).clamp(1, MAX_SEARCH_HITS);
    let marker = "__QINGCODE_REMOTE_FILES__";
    // NUL records preserve newlines in POSIX names. Limit matches, never the raw
    // directory list; a large first directory must not hide later matches.
    let command = format!(
        "find {path} \\( -name .git -o -name node_modules -o -name target \\) -prune -o -type d -print0; printf '{marker}\\0'; find {path} \\( -name .git -o -name node_modules -o -name target \\) -prune -o -type f -print0",
        path = shell_quote(&canonical_root)
    );
    let extensions = extensions
        .or_else(|| extension.map(|value| vec![value]))
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim_start_matches('.').to_ascii_lowercase())
        .collect::<Vec<_>>();
    let query = if ignore_case {
        query.to_lowercase()
    } else {
        query
    };
    let excludes = exclude_patterns.unwrap_or_default();
    let mut hits = Vec::new();
    let mut is_dir = true;
    let result = stream_records(&manager, &root, &command, 0, &control, started, |raw| {
        let path = String::from_utf8_lossy(raw);
        if path == marker {
            is_dir = false;
            return true;
        }
        let relative = remote_relative_path(&canonical_root, &path);
        let name = relative.rsplit('/').next().unwrap_or(&relative).to_string();
        if name.is_empty()
            || excludes
                .iter()
                .any(|pattern| simple_glob_matches(pattern, &relative))
        {
            return true;
        }
        if !extensions.is_empty()
            && !name
                .rsplit_once('.')
                .is_some_and(|(_, ext)| extensions.contains(&ext.to_ascii_lowercase()))
        {
            return true;
        }
        let candidate = if ignore_case {
            relative.to_lowercase()
        } else {
            relative.clone()
        };
        let matched = if query.is_empty() {
            !extensions.is_empty()
        } else if match_suffix {
            candidate.ends_with(query.trim_start_matches('.'))
        } else if fuzzy {
            fuzzy_contains(&candidate, &query)
        } else {
            candidate.contains(&query)
        };
        if !matched {
            return true;
        }
        if hits.len() == max {
            return false;
        }
        hits.push(RemoteSearchHit {
            name,
            path: join_remote_uri(&root, &relative),
            relative,
            is_dir,
        });
        true
    })
    .await?;
    if !result.cancelled && !result.truncated && result.exit_code != 0 {
        return Err(format!("远程文件搜索失败：{}", result.stderr.trim()));
    }
    Ok(RemoteFileSearchResponse {
        hits,
        truncated: result.truncated,
        cancelled: result.cancelled,
    })
}

fn append_content_record(
    raw: &[u8],
    root: &str,
    files: &mut Vec<RemoteContentFile>,
    count: &mut usize,
    max: usize,
    per_file: usize,
    per_file_truncated: &mut bool,
) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(raw) else {
        return true;
    };
    if value.get("type").and_then(|kind| kind.as_str()) != Some("match") {
        return true;
    }
    let Some(data) = value.get("data") else {
        return true;
    };
    let Some(relative) = data.pointer("/path/text").and_then(|path| path.as_str()) else {
        return true;
    };
    let relative = relative.strip_prefix("./").unwrap_or(relative).to_string();
    // The remote command reads one extra matching line to distinguish a full
    // result from a per-file cap, without withholding other files' matches.
    if files
        .iter()
        .any(|file| file.relative == relative && file.matches.len() >= per_file)
    {
        *per_file_truncated = true;
        return true;
    }
    if *count >= max {
        return false;
    }
    let text = data
        .pointer("/lines/text")
        .and_then(|text| text.as_str())
        .unwrap_or_default()
        .trim_end_matches(['\r', '\n'])
        .to_string();
    let submatch = data.pointer("/submatches/0");
    let match_start = submatch
        .and_then(|item| item.get("start"))
        .and_then(|n| n.as_u64())
        .unwrap_or(0) as u32;
    let item = RemoteContentMatch {
        line: data
            .get("line_number")
            .and_then(|n| n.as_u64())
            .unwrap_or(1) as u32,
        text,
        match_start,
        match_end: submatch
            .and_then(|item| item.get("end"))
            .and_then(|n| n.as_u64())
            .unwrap_or(u64::from(match_start)) as u32,
    };
    if let Some(file) = files.iter_mut().find(|file| file.relative == relative) {
        file.matches.push(item);
    } else {
        files.push(RemoteContentFile {
            name: relative.rsplit('/').next().unwrap_or(&relative).to_string(),
            path: join_remote_uri(root, &relative),
            relative,
            matches: vec![item],
        });
    }
    *count += 1;
    true
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_search_file_contents(
    root: String,
    query: String,
    ignore_case: bool,
    extension: Option<String>,
    extensions: Option<Vec<String>>,
    max_matches: Option<usize>,
    max_files_scanned: Option<usize>,
    max_matches_per_file: Option<usize>,
    search_id: Option<u64>,
    exclude_patterns: Option<Vec<String>>,
    use_ignore_files: Option<bool>,
    follow_symlinks: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<RemoteContentResponse, String> {
    let _ = follow_symlinks;
    let max = max_matches.unwrap_or(500).clamp(1, MAX_SEARCH_HITS);
    let file_limit = max_files_scanned.unwrap_or(8_000).clamp(1, 50_000);
    let started = Instant::now();
    let control = SearchControl {
        content_id: search_id,
        filename_flag: None,
    };
    let Some(canonical_root) = validated_search_root(&manager, &root, &control, started).await?
    else {
        return Ok(RemoteContentResponse {
            files: Vec::new(),
            match_count: 0,
            files_scanned: 0,
            truncated: false,
            cancelled: true,
        });
    };
    let per_file = max_matches_per_file.unwrap_or(20).clamp(1, 200);
    let mut filters = Vec::new();
    if use_ignore_files == Some(false) {
        filters.push("--no-ignore".to_string());
    }
    for ext in extensions
        .or_else(|| extension.map(|value| vec![value]))
        .unwrap_or_default()
    {
        filters.extend([
            "-g".to_string(),
            format!("*.{}", ext.trim_start_matches('.')),
        ]);
    }
    for pattern in exclude_patterns.unwrap_or_default() {
        filters.extend(["-g".to_string(), format!("!{pattern}")]);
    }
    let prefix = format!("cd -- {} && ", shell_quote(&canonical_root));
    let listing = format!(
        "{prefix}rg --files --null {}",
        filters
            .iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let mut paths = Vec::new();
    let mut path_bytes = 0;
    let listed = stream_records(&manager, &root, &listing, 0, &control, started, |raw| {
        if paths.len() >= file_limit || path_bytes + raw.len() > MAX_PATH_LIST_BYTES {
            return false;
        }
        path_bytes += raw.len();
        paths.push(String::from_utf8_lossy(raw).into_owned());
        true
    })
    .await?;
    let mut response = RemoteContentResponse {
        files: Vec::new(),
        match_count: 0,
        files_scanned: 0,
        truncated: listed.truncated,
        cancelled: listed.cancelled,
    };
    if listed.cancelled {
        return Ok(response);
    }
    if !listed.truncated && !matches!(listed.exit_code, 0 | 1) {
        return Err(format!(
            "远程内容搜索失败（请确认远端已安装 rg）：{}",
            listed.stderr.trim()
        ));
    }
    let mut offset = 0;
    let mut per_file_truncated = false;
    let mut output_bytes = 0;
    while offset < paths.len() {
        let mut args = vec![
            "rg".to_string(),
            "--json".to_string(),
            "--line-number".to_string(),
            "--column".to_string(),
            "--color=never".to_string(),
            "--fixed-strings".to_string(),
            format!("--max-count={}", per_file + 1),
        ];
        if ignore_case {
            args.push("--ignore-case".to_string());
        }
        args.extend(["--".to_string(), query.clone()]);
        let start = offset;
        let mut bytes = 0;
        while offset < paths.len() && (offset == start || bytes + paths[offset].len() < 16_000) {
            bytes += paths[offset].len();
            args.push(paths[offset].clone());
            offset += 1;
        }
        let command = format!(
            "{prefix}{}",
            args.iter()
                .map(|arg| shell_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let result = stream_records(&manager, &root, &command, b'\n', &control, started, |raw| {
            if output_bytes + raw.len() > MAX_CONTENT_OUTPUT_BYTES {
                return false;
            }
            output_bytes += raw.len();
            append_content_record(
                raw,
                &root,
                &mut response.files,
                &mut response.match_count,
                max,
                per_file,
                &mut per_file_truncated,
            )
        })
        .await?;
        response.files_scanned += offset - start;
        response.cancelled = result.cancelled;
        response.truncated |= result.truncated || per_file_truncated;
        if result.cancelled || result.truncated {
            break;
        }
        if !matches!(result.exit_code, 0 | 1) {
            return Err(format!("远程内容搜索失败：{}", result.stderr.trim()));
        }
    }
    if response.cancelled {
        response.truncated = false;
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_limit_is_checked_after_matching_and_preserves_hidden_paths() {
        let mut files = Vec::new();
        let mut count = 0;
        let mut truncated = false;
        let record = br#"{"type":"match","data":{"path":{"text":"./.config/a.ts"},"lines":{"text":"hello\n"},"line_number":3,"submatches":[{"start":0,"end":5}]}}"#;
        assert!(append_content_record(
            record,
            "ssh://test/root",
            &mut files,
            &mut count,
            1,
            20,
            &mut truncated
        ));
        assert_eq!(files[0].relative, ".config/a.ts");
        assert!(!append_content_record(
            record,
            "ssh://test/root",
            &mut files,
            &mut count,
            1,
            20,
            &mut truncated
        ));
        assert_eq!(count, 1);
    }

    #[test]
    fn per_file_probe_marks_truncation_without_hiding_other_files() {
        let mut files = Vec::new();
        let mut count = 0;
        let mut truncated = false;
        let first = br#"{"type":"match","data":{"path":{"text":"a.ts"},"lines":{"text":"hello\n"},"line_number":3,"submatches":[{"start":0,"end":5}]}}"#;
        let second = br#"{"type":"match","data":{"path":{"text":"b.ts"},"lines":{"text":"hello\n"},"line_number":3,"submatches":[{"start":0,"end":5}]}}"#;
        for _ in 0..2 {
            assert!(append_content_record(
                first,
                "ssh://test/root",
                &mut files,
                &mut count,
                10,
                2,
                &mut truncated
            ));
        }
        assert!(!truncated);
        assert!(append_content_record(
            first,
            "ssh://test/root",
            &mut files,
            &mut count,
            10,
            2,
            &mut truncated
        ));
        assert!(truncated);
        assert_eq!(count, 2);
        assert!(append_content_record(
            second,
            "ssh://test/root",
            &mut files,
            &mut count,
            10,
            2,
            &mut truncated
        ));
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].matches.len(), 2);
        assert_eq!(count, 3);
    }

    #[test]
    fn filename_pre_cancel_is_preserved_and_does_not_cancel_other_requests() {
        let id = uuid::Uuid::new_v4().to_string();
        let other_id = uuid::Uuid::new_v4().to_string();
        cancel_ssh_file_search(id.clone()).unwrap();
        let request = register_file_search(id.clone()).unwrap();
        let other = register_file_search(other_id.clone()).unwrap();
        let cancelled = SearchControl {
            content_id: None,
            filename_flag: Some(Arc::clone(&request.flag)),
        };
        let running = SearchControl {
            content_id: None,
            filename_flag: Some(Arc::clone(&other.flag)),
        };
        assert!(cancelled.cancelled());
        assert!(!running.cancelled());
        assert!(register_file_search(id.clone()).is_err());
        drop(request);
        drop(other);
        let requests = file_searches().lock().unwrap();
        assert!(!requests.contains_key(&id));
        assert!(!requests.contains_key(&other_id));
    }

    #[test]
    fn filename_request_ids_are_bounded() {
        assert!(validate_request_id("file-search_123").is_ok());
        assert!(validate_request_id("").is_err());
        assert!(validate_request_id("request/path").is_err());
        assert!(validate_request_id(&"a".repeat(129)).is_err());
    }
}
