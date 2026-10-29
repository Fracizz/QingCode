use super::*;
use futures_util::stream::{FuturesUnordered, StreamExt};
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

const CANCELLED: &str = "传输已取消";
const CHUNK_BYTES: usize = 64 * 1024;
struct TransferSlot {
    flag: Arc<AtomicBool>,
    active: bool,
    created: Instant,
}
static TRANSFERS: OnceLock<Mutex<HashMap<String, TransferSlot>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, TransferSlot>> {
    TRANSFERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_task_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("传输任务 ID 无效".to_string());
    }
    Ok(())
}

fn register_task(id: &str) -> Result<Arc<AtomicBool>, String> {
    validate_task_id(id)?;
    let mut tasks = registry()
        .lock()
        .map_err(|_| "传输状态不可用".to_string())?;
    tasks.retain(|_, slot| slot.active || slot.created.elapsed() < Duration::from_secs(300));
    if tasks.get(id).is_some_and(|slot| slot.active) {
        return Err("传输任务已在运行".to_string());
    }
    if tasks.len() >= 256 && !tasks.contains_key(id) {
        return Err("传输任务过多，请稍后重试".to_string());
    }
    let slot = tasks.entry(id.to_string()).or_insert_with(|| TransferSlot {
        flag: Arc::new(AtomicBool::new(false)),
        active: false,
        created: Instant::now(),
    });
    slot.active = true;
    Ok(Arc::clone(&slot.flag))
}

#[tauri::command]
pub fn cancel_ssh_transfer(task_id: String) -> Result<(), String> {
    validate_task_id(&task_id)?;
    let mut tasks = registry()
        .lock()
        .map_err(|_| "传输状态不可用".to_string())?;
    tasks.retain(|_, slot| slot.active || slot.created.elapsed() < Duration::from_secs(300));
    if tasks.len() >= 256 && !tasks.contains_key(&task_id) {
        return Err("传输任务过多，请稍后重试".to_string());
    }
    tasks
        .entry(task_id)
        .or_insert_with(|| TransferSlot {
            flag: Arc::new(AtomicBool::new(false)),
            active: false,
            created: Instant::now(),
        })
        .flag
        .store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub task_id: String,
    pub status: String,
    pub completed_files: usize,
    pub completed_bytes: u64,
    pub completed_paths: Vec<String>,
    pub pending_paths: Vec<String>,
    pub current_path: Option<String>,
    pub current_bytes: u64,
    pub current_total_bytes: u64,
    pub failed_path: Option<String>,
    pub error: Option<String>,
}

const DEFAULT_CONCURRENCY: usize = 4;
const MAX_CONCURRENCY: usize = 8;

struct ActiveFile {
    path: String,
    bytes: u64,
    total: u64,
}

struct TransferState<'a> {
    app: Option<&'a AppHandle>,
    progress: TransferProgress,
    last_emit: Instant,
    active: BTreeMap<usize, ActiveFile>,
}

impl TransferState<'_> {
    fn emit(&mut self, force: bool) {
        self.progress.current_path = self.active.values().next().map(|f| f.path.clone());
        self.progress.current_bytes = self.active.values().map(|f| f.bytes).sum();
        self.progress.current_total_bytes = self.active.values().map(|f| f.total).sum();
        if force || self.last_emit.elapsed() >= Duration::from_millis(100) {
            if let Some(app) = self.app {
                let _ = app.emit("ssh-transfer-progress", &self.progress);
            }
            self.last_emit = Instant::now();
        }
    }
}

struct TransferContext<'a> {
    flag: Arc<AtomicBool>,
    shared: Arc<Mutex<TransferState<'a>>>,
    job: usize,
}

impl TransferContext<'_> {
    fn check(&self) -> Result<(), String> {
        if self.flag.load(Ordering::SeqCst) {
            Err(CANCELLED.to_string())
        } else {
            Ok(())
        }
    }
    fn begin_file(&mut self, path: String, total: u64) {
        let mut state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        state.active.insert(
            self.job,
            ActiveFile {
                path,
                bytes: 0,
                total,
            },
        );
        state.emit(true);
    }
    fn advance(&mut self, bytes: usize) {
        let mut state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(file) = state.active.get_mut(&self.job) {
            file.bytes += bytes as u64;
        }
        state.emit(false);
    }
    fn finish_file(&mut self) {
        let mut state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(file) = state.active.remove(&self.job) {
            state.progress.completed_files += 1;
            state.progress.completed_bytes += file.bytes;
        }
        state.emit(true);
    }
}

struct QueueResult {
    completed: Vec<bool>,
    failure: Option<(usize, String)>,
}

// A directory is a queue item that returns children. Only this loop schedules
// work, so deep directory trees cannot multiply the file concurrency limit.
async fn run_queue<J, F, Fut>(
    jobs: Vec<J>,
    concurrency: usize,
    flag: &AtomicBool,
    mut execute: F,
    mut completed: impl FnMut(&[bool]),
) -> QueueResult
where
    F: FnMut(usize, J) -> Fut,
    Fut: Future<Output = Result<Vec<J>, String>>,
{
    let mut result = QueueResult {
        completed: vec![false; jobs.len()],
        failure: None,
    };
    let mut remaining = vec![1usize; jobs.len()];
    let mut queued: VecDeque<_> = jobs.into_iter().enumerate().collect();
    let mut running = FuturesUnordered::new();
    let mut next_id = 0;
    loop {
        while result.failure.is_none()
            && !flag.load(Ordering::SeqCst)
            && running.len() < concurrency.clamp(1, MAX_CONCURRENCY)
        {
            let Some((source, job)) = queued.pop_front() else {
                break;
            };
            let future = execute(next_id, job);
            next_id += 1;
            running.push(async move { (source, future.await) });
        }
        let Some((source, outcome)) = running.next().await else {
            break;
        };
        match outcome {
            Ok(children) => {
                remaining[source] = remaining[source] - 1 + children.len();
                queued.extend(children.into_iter().map(|job| (source, job)));
                if remaining[source] == 0 {
                    result.completed[source] = true;
                    completed(&result.completed);
                }
            }
            Err(error) => {
                if result.failure.is_none() {
                    result.failure = Some((source, error));
                    // Stop new work; poll all active futures through cleanup
                    // and non-cancellable commits before returning a result.
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
    }
    if result.failure.is_none() && flag.load(Ordering::SeqCst) {
        result.failure = Some((
            result.completed.iter().position(|done| !done).unwrap_or(0),
            CANCELLED.into(),
        ));
    }
    result
}

async fn cancellable<T, E: std::fmt::Display>(
    flag: &AtomicBool,
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, String> {
    let mut future = std::pin::pin!(future);
    let started = Instant::now();
    loop {
        if flag.load(Ordering::SeqCst) {
            return Err(CANCELLED.to_string());
        }
        if started.elapsed() >= Duration::from_secs(30) {
            return Err("传输操作超时，请检查连接后重试".to_string());
        }
        match tokio::time::timeout(Duration::from_millis(100), &mut future).await {
            Ok(result) => return result.map_err(|error| error.to_string()),
            Err(_) => continue,
        }
    }
}

async fn local_io<T: Send + 'static>(
    operation: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
async fn transfer_upload(
    manager: &SshManager,
    sftp: &SftpSession,
    local: PathBuf,
    remote: String,
    root: &RegisteredRoot,
    allowlist: &PathAllowlist,
    context: &mut TransferContext<'_>,
) -> Result<Vec<(PathBuf, String)>, String> {
    context.check()?;
    allowlist.ensure_allowed(&local.to_string_lossy())?;
    let stat_path = local.clone();
    let metadata = local_io(move || std::fs::symlink_metadata(stat_path)).await?;
    if metadata.file_type().is_symlink() {
        return Err(format!("暂不上传本地符号链接：{}", local.display()));
    }
    cancellable(
        &context.flag,
        ensure_parent_path_within(sftp, &remote, root),
    )
    .await?;
    if cancellable(&context.flag, sftp.try_exists(remote.clone())).await? {
        cancellable(
            &context.flag,
            ensure_existing_path_within(sftp, &remote, root),
        )
        .await?;
        let metadata = cancellable(&context.flag, sftp.symlink_metadata(remote.clone())).await?;
        if metadata.is_symlink() {
            return Err(format!("上传目标是符号链接，请选择普通文件路径：{remote}"));
        }
    }
    if metadata.is_dir() {
        if !cancellable(&context.flag, sftp.try_exists(remote.clone())).await? {
            cancellable(&context.flag, sftp.create_dir(remote.clone())).await?;
        }
        let entries = local_io(move || {
            std::fs::read_dir(local)?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<std::io::Result<Vec<_>>>()
        })
        .await?;
        return entries
            .into_iter()
            .map(|path| {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "上传文件名不是有效 UTF-8".to_string())?;
                validate_entry_name(name)?;
                let target = join_remote_path(&remote, name);
                Ok((path, target))
            })
            .collect();
    }

    if !metadata.is_file() {
        return Err(format!("暂不上传特殊文件：{}", local.display()));
    }
    context.begin_file(local.to_string_lossy().into_owned(), metadata.len());
    let mut input = local_io(move || std::fs::File::open(local)).await?;
    let temp = format!(
        "{}/.qingcode-transfer-{}.tmp",
        remote_parent_path(&remote)?,
        uuid::Uuid::new_v4()
    );
    let result: Result<(), String> = async {
        let mut output = cancellable(
            &context.flag,
            sftp.open_with_flags(temp.clone(), remote_write_flags(true)),
        )
        .await?;
        loop {
            context.check()?;
            let (reader, buffer, len) = local_io(move || {
                let mut buffer = vec![0u8; CHUNK_BYTES];
                let len = input.read(&mut buffer)?;
                Ok((input, buffer, len))
            })
            .await?;
            input = reader;
            if len == 0 {
                break;
            }
            cancellable(&context.flag, output.write_all(&buffer[..len])).await?;
            context.advance(len);
        }
        cancellable(&context.flag, output.shutdown()).await?;
        context.check()?;
        // Revalidate immediately before commit. Never truncate an existing file.
        cancellable(
            &context.flag,
            ensure_parent_path_within(sftp, &remote, root),
        )
        .await?;
        if cancellable(&context.flag, sftp.try_exists(remote.clone())).await? {
            cancellable(
                &context.flag,
                ensure_existing_path_within(sftp, &remote, root),
            )
            .await?;
            let metadata =
                cancellable(&context.flag, sftp.symlink_metadata(remote.clone())).await?;
            if metadata.is_symlink() || metadata.is_dir() {
                return Err("上传目标已变为目录或符号链接".to_string());
            }
            // Preserve executable bits and other existing file permissions.
            let attrs = russh_sftp::protocol::FileAttributes {
                permissions: metadata.permissions,
                ..Default::default()
            };
            cancellable(&context.flag, sftp.set_metadata(temp.clone(), attrs)).await?;
        }
        context.check()?;
        // Standard SFTP v3 rename may reject an existing target. POSIX mv on a
        // sibling temporary file gives atomic replacement without truncation.
        // Commit is a short non-cancellable transaction. Cancelling between
        // request and reply must not report a half-written destination.
        let rename = tokio::time::timeout(
            Duration::from_secs(15),
            sftp.rename(temp.clone(), remote.clone()),
        )
        .await
        .map_err(|_| "远程文件提交超时，完成状态不确定，请检查目标后重试".to_string())?;
        if rename.is_err() {
            let command = format!("mv -fT -- {} {}", shell_quote(&temp), shell_quote(&remote));
            let result = tokio::time::timeout(
                Duration::from_secs(15),
                manager.exec_uri(&root.uri, &command, true),
            )
            .await
            .map_err(|_| "远程文件替换超时，完成状态不确定，请检查目标后重试".to_string())??;
            if result.exit_code != 0 {
                return Err(format!("无法安全替换远程文件：{}", result.stderr.trim()));
            }
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::time::timeout(Duration::from_secs(2), sftp.remove_file(temp)).await;
    }
    result?;
    context.finish_file();
    Ok(Vec::new())
}

async fn transfer_download(
    sftp: &SftpSession,
    remote: String,
    local: PathBuf,
    root: &RegisteredRoot,
    allowlist: &PathAllowlist,
    context: &mut TransferContext<'_>,
) -> Result<Vec<(PathBuf, String)>, String> {
    context.check()?;
    cancellable(
        &context.flag,
        ensure_existing_path_within(sftp, &remote, root),
    )
    .await?;
    allowlist.ensure_writable(&local.to_string_lossy())?;
    let metadata = cancellable(&context.flag, sftp.symlink_metadata(remote.clone())).await?;
    if metadata.is_symlink() {
        return Err(format!("暂不下载远程符号链接：{remote}"));
    }
    let check_path = local.clone();
    let existing_permissions = local_io(move || match std::fs::symlink_metadata(check_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(std::io::Error::other("下载目标是符号链接"))
        }
        Ok(metadata) => Ok(Some(metadata.permissions())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    })
    .await?;
    if metadata.is_dir() {
        let directory = local.clone();
        local_io(move || std::fs::create_dir_all(directory)).await?;
        let entries = cancellable(&context.flag, sftp.read_dir(remote)).await?;
        return entries
            .map(|entry| {
                let name = entry.file_name();
                validate_entry_name(&name)?;
                Ok((local.join(name), entry.path()))
            })
            .collect();
    }

    if !metadata.is_regular() {
        return Err(format!("暂不下载远程特殊文件：{remote}"));
    }
    context.begin_file(remote.clone(), metadata.len());
    let parent = local
        .parent()
        .ok_or_else(|| "下载目标缺少父目录".to_string())?
        .to_path_buf();
    let temp = parent.join(format!(".qingcode-transfer-{}.tmp", uuid::Uuid::new_v4()));
    let temp_path = temp.clone();
    let result: Result<(), String> = async {
        let mut output = local_io(move || {
            std::fs::create_dir_all(parent)?;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(temp_path)
        })
        .await?;
        let mut input = cancellable(&context.flag, sftp.open(remote)).await?;
        let mut buffer = vec![0u8; CHUNK_BYTES];
        loop {
            let len = cancellable(&context.flag, input.read(&mut buffer)).await?;
            if len == 0 {
                break;
            }
            let chunk = buffer[..len].to_vec();
            output = local_io(move || {
                output.write_all(&chunk)?;
                Ok(output)
            })
            .await?;
            context.advance(len);
        }
        local_io(move || output.sync_all()).await?;
        context.check()?;
        allowlist.ensure_writable(&local.to_string_lossy())?;
        let source = temp.clone();
        local_io(move || commit_download(&source, &local, existing_permissions)).await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = local_io(move || std::fs::remove_file(temp)).await;
    }
    result?;
    context.finish_file();
    Ok(Vec::new())
}

fn commit_download(
    source: &Path,
    destination: &Path,
    permissions: Option<std::fs::Permissions>,
) -> std::io::Result<()> {
    if std::fs::symlink_metadata(destination)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(std::io::Error::other("下载目标已变为符号链接"));
    }
    if let Some(permissions) = permissions {
        std::fs::set_permissions(source, permissions)?;
    }
    std::fs::rename(source, destination)
}

struct TransferJob {
    local: PathBuf,
    remote: String,
}

async fn execute_job(
    job: TransferJob,
    upload: bool,
    manager: &SshManager,
    allowlist: &PathAllowlist,
    context: &mut TransferContext<'_>,
) -> Result<Vec<TransferJob>, String> {
    context.check()?;
    // Resolve again for each child so trust revocation/root changes take effect.
    let (sftp, parsed, root) =
        cancellable(&context.flag, manager.sftp_for_uri(&job.remote, upload)).await?;
    let children = if upload {
        transfer_upload(
            manager,
            &sftp,
            job.local,
            parsed.path,
            &root,
            allowlist,
            context,
        )
        .await?
    } else {
        transfer_download(&sftp, parsed.path, job.local, &root, allowlist, context).await?
    };
    Ok(children
        .into_iter()
        .map(|(local, remote)| TransferJob {
            local,
            remote: format!("ssh://{}{remote}", parsed.connection_id),
        })
        .collect())
}

fn initial_jobs(
    upload: bool,
    paths: &[String],
    destination: &str,
) -> Result<Vec<TransferJob>, String> {
    let mut targets = std::collections::HashSet::new();
    paths
        .iter()
        .map(|path| {
            let name = if upload {
                Path::new(path).file_name().and_then(|name| name.to_str())
            } else {
                path.rsplit('/').next()
            }
            .ok_or("传输路径缺少有效文件名")?;
            validate_entry_name(name)?;
            let job = if upload {
                TransferJob {
                    local: PathBuf::from(path),
                    remote: join_remote_uri(destination, name),
                }
            } else {
                TransferJob {
                    local: PathBuf::from(destination).join(name),
                    remote: path.clone(),
                }
            };
            let mut target = if upload {
                job.remote.clone()
            } else {
                job.local.to_string_lossy().into_owned()
            };
            let remote_windows =
                upload && parse_remote_uri(&job.remote)?.path.as_bytes().get(2) == Some(&b':');
            if (!upload && cfg!(windows)) || remote_windows {
                target = target.to_lowercase();
            }
            if !targets.insert(target) {
                return Err("多个源路径具有相同的目标文件名，请分开传输".into());
            }
            Ok(job)
        })
        .collect()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_transfer_paths(
    task_id: String,
    direction: String,
    paths: Vec<String>,
    destination: String,
    concurrency: Option<usize>,
    manager: State<'_, SshManager>,
    allowlist: State<'_, PathAllowlist>,
    app: AppHandle,
) -> Result<TransferProgress, String> {
    if direction != "upload" && direction != "download" {
        return Err("不支持的传输方向".into());
    }
    let flag = register_task(&task_id)?;
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(mut tasks) = registry().lock() {
                tasks.remove(&self.0);
            }
        }
    }
    let _cleanup = Cleanup(task_id.clone());
    run_transfer(
        TransferOptions {
            task_id,
            upload: direction == "upload",
            paths,
            destination,
            concurrency: concurrency.unwrap_or(DEFAULT_CONCURRENCY),
        },
        &manager,
        &allowlist,
        Some(&app),
        flag,
    )
    .await
}

struct TransferOptions {
    task_id: String,
    upload: bool,
    paths: Vec<String>,
    destination: String,
    concurrency: usize,
}

async fn run_transfer(
    options: TransferOptions,
    manager: &SshManager,
    allowlist: &PathAllowlist,
    app: Option<&AppHandle>,
    flag: Arc<AtomicBool>,
) -> Result<TransferProgress, String> {
    let TransferOptions {
        task_id,
        upload,
        paths,
        destination,
        concurrency,
    } = options;
    let jobs = initial_jobs(upload, &paths, &destination)?;
    let shared = Arc::new(Mutex::new(TransferState {
        app,
        last_emit: Instant::now(),
        active: BTreeMap::new(),
        progress: TransferProgress {
            task_id,
            status: "running".into(),
            completed_files: 0,
            completed_bytes: 0,
            completed_paths: Vec::new(),
            pending_paths: paths.clone(),
            current_path: None,
            current_bytes: 0,
            current_total_bytes: 0,
            failed_path: None,
            error: None,
        },
    }));
    shared.lock().unwrap().emit(true);
    let result = run_queue(
        jobs,
        concurrency,
        &flag,
        |job_id, job| {
            let mut context = TransferContext {
                flag: flag.clone(),
                shared: shared.clone(),
                job: job_id,
            };
            async move {
                let result = execute_job(job, upload, manager, allowlist, &mut context).await;
                let mut state = context.shared.lock().unwrap_or_else(|e| e.into_inner());
                state.active.remove(&job_id);
                state.emit(true);
                result
            }
        },
        |completed| {
            let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
            state.progress.completed_paths = paths
                .iter()
                .zip(completed)
                .filter(|(_, done)| **done)
                .map(|(path, _)| path.clone())
                .collect();
            state.progress.pending_paths = paths
                .iter()
                .zip(completed)
                .filter(|(_, done)| !**done)
                .map(|(path, _)| path.clone())
                .collect();
            state.emit(true);
        },
    )
    .await;
    let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((source, error)) = result.failure {
        state.progress.status = if error == CANCELLED {
            "cancelled"
        } else {
            "failed"
        }
        .into();
        state.progress.failed_path = paths.get(source).cloned();
        state.progress.error = Some(error);
    } else {
        state.progress.status = "completed".into();
    }
    state.emit(true);
    Ok(state.progress.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrent_directory_roundtrip_preserves_bytes_empty_folders_and_retry_paths() {
        let (config, gateway, directory) = super::super::direct::tests::gateway().await;
        let remote = directory.join("remote");
        let source = directory.join("local/source");
        let downloaded = directory.join("downloaded");
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(source.join("nested/empty")).unwrap();
        std::fs::create_dir_all(&downloaded).unwrap();
        let mut total = 0;
        for index in 0..12 {
            let bytes: Vec<u8> = (0..(128 * 1024 + index)).map(|n| (n % 251) as u8).collect();
            total += bytes.len() as u64;
            std::fs::write(source.join(format!("nested/{index}.bin")), &bytes).unwrap();
        }
        std::fs::write(source.join("zero"), []).unwrap();
        let canonical = std::fs::canonicalize(&remote)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let uri = if canonical.starts_with('/') {
            format!("ssh://transfer-test{canonical}")
        } else {
            format!("ssh://transfer-test/{canonical}")
        };
        let manager = SshManager::new();
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert("transfer-test".into(), config);
        manager
            .direct_active
            .write()
            .unwrap()
            .insert("transfer-test".into());
        manager.roots.write().unwrap().insert(
            uri.clone(),
            RegisteredRoot {
                uri: uri.clone(),
                canonical_path: canonical,
                trusted: true,
            },
        );
        let allowlist = PathAllowlist::new();
        allowlist.authorize_paths(vec![directory.to_string_lossy().into_owned()]);
        let local_path = source.to_string_lossy().into_owned();
        let upload = run_transfer(
            TransferOptions {
                task_id: "upload".into(),
                upload: true,
                paths: vec![local_path.clone()],
                destination: uri.clone(),
                concurrency: 4,
            },
            &manager,
            &allowlist,
            None,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(upload.status, "completed", "{:?}", upload.error);
        assert_eq!(upload.completed_paths, [local_path]);
        assert!(upload.pending_paths.is_empty());
        assert_eq!(upload.completed_files, 13);
        assert_eq!(upload.completed_bytes, total);
        assert_eq!(upload.current_bytes, 0);
        assert!(remote.join("source/nested/empty").is_dir());
        let remote_source = join_remote_uri(&uri, "source");
        let download = run_transfer(
            TransferOptions {
                task_id: "download".into(),
                upload: false,
                paths: vec![remote_source.clone()],
                destination: downloaded.to_string_lossy().into_owned(),
                concurrency: 4,
            },
            &manager,
            &allowlist,
            None,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(download.status, "completed", "{:?}", download.error);
        assert_eq!(
            download.completed_paths.as_slice(),
            std::slice::from_ref(&remote_source)
        );
        assert_eq!(download.completed_files, 13);
        assert_eq!(download.completed_bytes, total);
        assert!(downloaded.join("source/nested/empty").is_dir());
        for index in 0..12 {
            let relative = format!("nested/{index}.bin");
            assert_eq!(
                std::fs::read(source.join(&relative)).unwrap(),
                std::fs::read(downloaded.join("source").join(&relative)).unwrap()
            );
        }
        assert_eq!(std::fs::read(downloaded.join("source/zero")).unwrap(), b"");
        // Retry must include only unfinished top-level paths.
        let missing = join_remote_uri(&uri, "missing");
        let zero = join_remote_uri(&remote_source, "zero");
        let failed = run_transfer(
            TransferOptions {
                task_id: "failed".into(),
                upload: false,
                paths: vec![zero.clone(), missing.clone()],
                destination: downloaded.to_string_lossy().into_owned(),
                concurrency: 1,
            },
            &manager,
            &allowlist,
            None,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.pending_paths, [missing]);
        assert_eq!(failed.completed_paths, [zero]);
        assert_eq!(failed.completed_files, 1);
        drop(manager);
        gateway.abort();
        let _ = gateway.await;
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn directory_children_share_one_bounded_worker_queue() {
        use std::sync::atomic::AtomicUsize;
        for (requested, expected) in [(4, 4), (100, 8)] {
            let active = AtomicUsize::new(0);
            let peak = AtomicUsize::new(0);
            let finished = AtomicUsize::new(0);
            let result = run_queue(
                vec![true],
                requested,
                &AtomicBool::new(false),
                |_, directory| {
                    let (active, peak, finished) = (&active, &peak, &finished);
                    async move {
                        if directory {
                            return Ok(vec![false; 16]);
                        }
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(count, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(5)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        finished.fetch_add(1, Ordering::SeqCst);
                        Ok(Vec::new())
                    }
                },
                |completed| {
                    assert_eq!(completed, [true]);
                    assert_eq!(finished.load(Ordering::SeqCst), 16);
                },
            )
            .await;
            assert!(result.failure.is_none());
            assert_eq!(result.completed, [true]);
            assert_eq!(peak.load(Ordering::SeqCst), expected);
        }
    }

    #[tokio::test]
    async fn failure_stops_new_jobs_but_waits_for_inflight_commits() {
        let flag = AtomicBool::new(false);
        let commit_finished = AtomicBool::new(false);
        let result = run_queue(
            vec![0, 1, 2],
            2,
            &flag,
            |_, job| {
                let commit_finished = &commit_finished;
                async move {
                    match job {
                        0 => {
                            // Simulates a commit that must finish even when its
                            // sibling fails; dropping this future would lose it.
                            tokio::time::sleep(Duration::from_millis(20)).await;
                            commit_finished.store(true, Ordering::SeqCst);
                            Ok(Vec::new())
                        }
                        1 => Err("write failed".into()),
                        _ => panic!("a failed task must not start queued work"),
                    }
                }
            },
            |_| {},
        )
        .await;
        assert!(commit_finished.load(Ordering::SeqCst));
        assert_eq!(result.completed, [true, false, false]);
        assert_eq!(result.failure, Some((1, "write failed".into())));
    }

    #[tokio::test]
    async fn cancelling_active_work_drains_commits_and_does_not_start_queued_files() {
        let flag = AtomicBool::new(false);
        let result = run_queue(
            vec![0, 1, 2],
            2,
            &flag,
            |_, job| {
                let flag = &flag;
                async move {
                    match job {
                        0 => {
                            tokio::task::yield_now().await;
                            flag.store(true, Ordering::SeqCst);
                            Err(CANCELLED.into())
                        }
                        1 => {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                            Ok(Vec::new())
                        }
                        _ => panic!("cancellation must stop queued work"),
                    }
                }
            },
            |_| {},
        )
        .await;
        assert_eq!(result.failure, Some((0, CANCELLED.into())));
        assert_eq!(result.completed, [false, true, false]);
    }

    #[test]
    fn parallel_progress_aggregates_active_bytes_without_counting_completed_bytes_twice() {
        let shared = Arc::new(Mutex::new(TransferState {
            app: None,
            last_emit: Instant::now(),
            active: BTreeMap::new(),
            progress: TransferProgress {
                task_id: "progress".into(),
                status: "running".into(),
                completed_files: 0,
                completed_bytes: 0,
                completed_paths: vec![],
                pending_paths: vec![],
                current_path: None,
                current_bytes: 0,
                current_total_bytes: 0,
                failed_path: None,
                error: None,
            },
        }));
        let mut first = TransferContext {
            flag: Arc::new(AtomicBool::new(false)),
            shared: shared.clone(),
            job: 1,
        };
        let mut second = TransferContext {
            job: 2,
            shared: shared.clone(),
            flag: first.flag.clone(),
        };
        first.begin_file("first".into(), 10);
        second.begin_file("second".into(), 20);
        first.advance(5);
        second.advance(7);
        assert_eq!(shared.lock().unwrap().progress.current_bytes, 12);
        assert_eq!(shared.lock().unwrap().progress.current_total_bytes, 30);
        first.finish_file();
        assert_eq!(shared.lock().unwrap().progress.completed_bytes, 5);
        assert_eq!(shared.lock().unwrap().progress.current_bytes, 7);
        second.finish_file();
        let state = shared.lock().unwrap();
        assert_eq!(state.progress.completed_bytes, 12);
        assert_eq!(state.progress.completed_files, 2);
        assert_eq!(state.progress.current_bytes, 0);
        assert!(state.progress.current_path.is_none());
    }

    #[tokio::test]
    async fn cancellation_before_scheduling_preserves_every_pending_path() {
        let result = run_queue(
            vec![1, 2],
            4,
            &AtomicBool::new(true),
            |_, _| async {
                panic!("cancelled task must not start work");
                #[allow(unreachable_code)]
                Ok(Vec::<usize>::new())
            },
            |_| {},
        )
        .await;
        assert_eq!(result.completed, [false, false]);
        assert_eq!(result.failure, Some((0, CANCELLED.into())));
    }

    #[test]
    fn concurrent_transfers_reject_colliding_top_level_targets() {
        assert!(
            initial_jobs(true, &["/one/a".into(), "/two/a".into()], "ssh://c/project").is_err()
        );
        assert!(initial_jobs(
            false,
            &["ssh://one/project/a".into(), "ssh://two/project/a".into()],
            "/out"
        )
        .is_err());
        assert!(initial_jobs(
            true,
            &["/one/A".into(), "/two/a".into()],
            "ssh://c/D:/project"
        )
        .is_err());
    }

    #[test]
    fn cancel_before_register_is_not_lost() {
        let id = uuid::Uuid::new_v4().to_string();
        cancel_ssh_transfer(id.clone()).unwrap();
        let flag = register_task(&id).unwrap();
        assert!(flag.load(Ordering::SeqCst));
        assert!(register_task(&id).is_err());
        registry().lock().unwrap().remove(&id);
    }
    #[test]
    fn task_ids_are_bounded() {
        assert!(validate_task_id("transfer-123").is_ok());
        assert!(validate_task_id("").is_err());
        assert!(validate_task_id(&"a".repeat(129)).is_err());
    }

    #[test]
    fn download_commit_replaces_a_file_without_deleting_the_original_first() {
        let directory =
            std::env::temp_dir().join(format!("qingcode-transfer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let target = directory.join("target.txt");
        let temp = directory.join("temp.txt");
        std::fs::write(&target, b"before").unwrap();
        std::fs::write(&temp, b"after").unwrap();
        commit_download(&temp, &target, None).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"after");
        assert!(!temp.exists());
        assert!(commit_download(&temp, &target, None).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"after");
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn cancelled_operation_does_not_wait_for_the_remote_response() {
        let flag = AtomicBool::new(true);
        let result = tauri::async_runtime::block_on(cancellable(
            &flag,
            std::future::pending::<Result<(), String>>(),
        ));
        assert_eq!(result.unwrap_err(), CANCELLED);
    }
}
