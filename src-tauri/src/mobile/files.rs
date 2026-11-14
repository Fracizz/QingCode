//! Read-only project files for paired phones. All resources are project-relative;
//! each request rechecks the saved project/trust through the desktop bridge.
use super::*;
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub(crate) const CHUNK_LIMIT: u64 = 256 * 1024;
pub(crate) const LIST_LIMIT: usize = 2000;
pub(crate) const SEARCH_LIMIT: usize = 200;
pub(crate) const SCAN_LIMIT: usize = 50_000;
pub(crate) const SCAN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    List,
    Search,
    Stat,
    Chunk,
}

pub(crate) struct FileRequest {
    pub action: Action,
    pub path: String,
    pub hidden: bool,
    pub query: String,
    pub version: String,
    pub offset: u64,
    pub length: u64,
}
impl FileRequest {
    pub fn list(path: String, hidden: bool) -> Self {
        Self {
            action: Action::List,
            path,
            hidden,
            query: String::new(),
            version: String::new(),
            offset: 0,
            length: 0,
        }
    }
    pub fn search(path: String, query: String, hidden: bool) -> Self {
        Self {
            action: Action::Search,
            query,
            ..Self::list(path, hidden)
        }
    }
    pub fn stat(path: String) -> Self {
        Self {
            action: Action::Stat,
            ..Self::list(path, true)
        }
    }
    pub fn chunk(path: String, version: String, offset: u64, length: u64) -> Self {
        Self {
            action: Action::Chunk,
            version,
            offset,
            length,
            ..Self::stat(path)
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        validate_relative(&self.path)?;
        if self.action == Action::Search && (self.query.trim().is_empty() || self.query.len() > 512)
        {
            return Err("请输入 1–512 字节的文件名或路径。".into());
        }
        if self.action == Action::Chunk
            && (self.length == 0 || self.length > CHUNK_LIMIT || self.version.is_empty())
        {
            return Err("下载分块参数无效。".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileAccess {
    pub path: String,
    #[serde(default)]
    pub excludes: Vec<String>,
    #[serde(default)]
    pub exclude_git_ignore: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
}

pub(crate) fn validate_relative(path: &str) -> Result<(), String> {
    if path.len() > 4096
        || path.contains(['\0', '\\'])
        || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic())
        || path.starts_with('/')
        || path
            .split('/')
            .any(|part| part == ".." || part == "." || (part.is_empty() && !path.is_empty()))
    {
        return Err("文件路径必须位于当前项目内。".into());
    }
    Ok(())
}
pub(crate) fn validate_platform_relative(path: &str, windows: bool) -> Result<(), String> {
    validate_relative(path)?;
    if windows && path.contains(':') {
        return Err("不允许访问 Windows 文件流。".into());
    }
    Ok(())
}
pub(crate) fn visible(path: &str, hidden: bool, excludes: &[String]) -> bool {
    (hidden || !path.split('/').any(|part| part.starts_with('.')))
        && !crate::exclude::is_path_excluded(path, excludes)
}
pub(crate) fn entry_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).into()
}
pub(crate) fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
}
pub(crate) fn listing(mut entries: Vec<Entry>, truncated: bool, access: &FileAccess) -> Value {
    sort_entries(&mut entries);
    json!({"entries":entries,"truncated":truncated,"excludedPatterns":access.excludes,"excludeGitIgnore":access.exclude_git_ignore,"skippedLinks":true})
}
pub(crate) fn stamp(path: &str, size: u64, modified: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(path.as_bytes());
    hash.update(size.to_le_bytes());
    hash.update(modified.as_bytes());
    format!("{:x}", hash.finalize())
}
pub(crate) fn changed() -> String {
    "源文件已变化，请重新选择文件后下载。".into()
}
pub(crate) fn chunk_response(request: &FileRequest, bytes: &[u8], size: u64) -> Value {
    let next = request.offset + bytes.len() as u64;
    json!({"data":base64::engine::general_purpose::STANDARD.encode(bytes),"offset":request.offset,"nextOffset":next,"eof":next==size,"version":request.version})
}

pub(super) async fn operate(
    app: &AppHandle,
    project: &str,
    request: FileRequest,
) -> Result<Value, String> {
    request.validate()?;
    let access: FileAccess = serde_json::from_value(desktop_query(app, json!({"project":project,"fileAccess":true,"fileRules":matches!(request.action, Action::List | Action::Search)})).await?).map_err(|_| "项目文件授权无效。".to_string())?;
    if access.path.starts_with("ssh://") {
        return crate::remote_ssh::mobile_files::operate(
            &app.state::<crate::remote_ssh::SshManager>(),
            access,
            request,
        )
        .await;
    }
    app.state::<crate::path_guard::PathAllowlist>()
        .ensure_executable(&access.path)?;
    tauri::async_runtime::spawn_blocking(move || local_operate(&access, &request))
        .await
        .map_err(|_| "文件操作中断。".to_string())?
}
fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_platform_relative(relative, cfg!(windows))?;
    let target = fs::canonicalize(root.join(relative))
        .map_err(|error| format!("文件或目录不可用：{error}"))?;
    if !target.starts_with(root) {
        return Err("路径通过符号链接跳出了当前项目。".into());
    }
    Ok(target)
}
fn modified_ms(meta: &Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}
fn local_stamp(path: &Path, meta: &Metadata) -> String {
    let identity = format!("{:?}:{:?}", meta.modified(), meta.created());
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{identity}:{}:{}", meta.dev(), meta.ino())
    };
    stamp(&path.to_string_lossy(), meta.len(), &identity)
}
fn local_source_unchanged(
    root: &Path,
    relative: &str,
    path: &Path,
    version: &str,
) -> Result<(), String> {
    if checked_path(root, relative).map_err(|_| changed())? != path
        || local_stamp(path, &fs::metadata(path).map_err(|_| changed())?) != version
    {
        return Err(changed());
    }
    Ok(())
}
fn local_operate(access: &FileAccess, request: &FileRequest) -> Result<Value, String> {
    request.validate()?;
    let root = fs::canonicalize(&access.path).map_err(|e| format!("项目目录不可用：{e}"))?;
    let path = checked_path(&root, &request.path)?;
    if matches!(request.action, Action::List | Action::Search) {
        return local_listing(access, request, &root, &path);
    }
    if !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() {
        return Err("仅支持下载普通文件。".into());
    }
    let mut file = File::open(&path).map_err(|e| format!("无法读取文件：{e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("仅支持下载普通文件。".into());
    }
    let version = local_stamp(&path, &meta);
    local_source_unchanged(&root, &request.path, &path, &version)?;
    if request.action == Action::Stat {
        return Ok(
            json!({"name":entry_name(&request.path),"path":request.path,"size":meta.len(),"modifiedAt":modified_ms(&meta),"version":version}),
        );
    }
    if version != request.version || request.offset > meta.len() {
        return Err(changed());
    }
    let size = (meta.len() - request.offset).min(request.length) as usize;
    let mut bytes = vec![0; size];
    file.seek(SeekFrom::Start(request.offset))
        .map_err(|e| e.to_string())?;
    file.read_exact(&mut bytes).map_err(|_| changed())?;
    if local_stamp(&path, &file.metadata().map_err(|e| e.to_string())?) != version {
        return Err(changed());
    }
    local_source_unchanged(&root, &request.path, &path, &version)?;
    Ok(chunk_response(request, &bytes, meta.len()))
}
fn local_listing(
    access: &FileAccess,
    request: &FileRequest,
    root: &Path,
    path: &Path,
) -> Result<Value, String> {
    if !path.is_dir() {
        return Err("当前路径不是目录。".into());
    }
    let search = request.action == Action::Search;
    let limit = if search { SEARCH_LIMIT } else { LIST_LIMIT };
    let mut builder = ignore::WalkBuilder::new(path);
    builder
        .max_depth(if search { Some(64) } else { Some(1) })
        .hidden(!request.hidden)
        .follow_links(false)
        .git_ignore(access.exclude_git_ignore)
        .git_global(access.exclude_git_ignore)
        .git_exclude(access.exclude_git_ignore)
        .ignore(access.exclude_git_ignore)
        .parents(access.exclude_git_ignore);
    if access.exclude_git_ignore {
        builder.add_custom_ignore_filename(".gitignore");
    }
    let exclude_root = root.to_path_buf();
    let excludes = access.excludes.clone();
    builder.filter_entry(move |entry| {
        entry.depth() == 0
            || entry.path().strip_prefix(&exclude_root).is_ok_and(|rel| {
                !crate::exclude::is_path_excluded(
                    &rel.to_string_lossy().replace('\\', "/"),
                    &excludes,
                )
            })
    });
    let query = request.query.trim().to_lowercase();
    let start = Instant::now();
    let mut entries = Vec::new();
    let mut truncated = false;
    for (scanned, result) in builder.build().enumerate() {
        if scanned >= SCAN_LIMIT || start.elapsed() >= SCAN_TIMEOUT {
            truncated = true;
            break;
        }
        let entry = result.map_err(|e| format!("无法读取目录：{e}"))?;
        if entry.depth() == 0 {
            continue;
        }
        let Some(kind) = entry.file_type() else {
            continue;
        };
        if search && entry.depth() == 64 && kind.is_dir() {
            truncated = true;
        }
        if !kind.is_dir() && !kind.is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| "路径不在项目内。")?
            .to_string_lossy()
            .into_owned();
        #[cfg(windows)]
        let relative = relative.replace('\\', "/");
        if validate_platform_relative(&relative, cfg!(windows)).is_err() {
            truncated = true;
            continue;
        }
        if !visible(&relative, request.hidden, &access.excludes)
            || (search && (kind.is_dir() || !relative.to_lowercase().contains(&query)))
        {
            continue;
        }
        if entries.len() == limit {
            truncated = true;
            break;
        }
        let safe_path = checked_path(root, &relative)?;
        let metadata = fs::metadata(&safe_path).map_err(|e| e.to_string())?;
        entries.push(Entry {
            name: entry_name(&relative),
            path: relative,
            is_dir: kind.is_dir(),
            size: kind.is_file().then_some(metadata.len()),
            modified_at: modified_ms(&metadata),
        });
    }
    Ok(listing(entries, truncated, access))
}

#[cfg(test)]
mod tests;
