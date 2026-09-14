use super::*;
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

struct TransferContext<'a> {
    flag: Arc<AtomicBool>,
    app: &'a AppHandle,
    progress: TransferProgress,
    last_emit: Instant,
}

impl TransferContext<'_> {
    fn check(&self) -> Result<(), String> {
        if self.flag.load(Ordering::SeqCst) {
            Err(CANCELLED.to_string())
        } else {
            Ok(())
        }
    }
    fn emit(&mut self, force: bool) {
        if force || self.last_emit.elapsed() >= Duration::from_millis(100) {
            let _ = self.app.emit("ssh-transfer-progress", &self.progress);
            self.last_emit = Instant::now();
        }
    }
    fn begin_file(&mut self, path: String, total: u64) {
        self.progress.current_path = Some(path);
        self.progress.current_bytes = 0;
        self.progress.current_total_bytes = total;
        self.emit(true);
    }
    fn advance(&mut self, bytes: usize) {
        self.progress.current_bytes += bytes as u64;
        self.emit(false);
    }
    fn finish_file(&mut self) {
        self.progress.completed_files += 1;
        self.progress.completed_bytes += self.progress.current_bytes;
        self.emit(true);
    }
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
) -> Result<(), String> {
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
        for path in entries {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "上传文件名不是有效 UTF-8".to_string())?;
            validate_entry_name(name)?;
            let target = format!("{}/{name}", remote.trim_end_matches('/'));
            Box::pin(transfer_upload(
                manager, sftp, path, target, root, allowlist, context,
            ))
            .await?;
        }
        return Ok(());
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
    Ok(())
}

async fn transfer_download(
    sftp: &SftpSession,
    remote: String,
    local: PathBuf,
    root: &RegisteredRoot,
    allowlist: &PathAllowlist,
    context: &mut TransferContext<'_>,
) -> Result<(), String> {
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
        for entry in entries {
            let name = entry.file_name();
            validate_entry_name(&name)?;
            Box::pin(transfer_download(
                sftp,
                entry.path(),
                local.join(name),
                root,
                allowlist,
                context,
            ))
            .await?;
        }
        return Ok(());
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
    Ok(())
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

#[tauri::command]
pub async fn ssh_transfer_paths(
    task_id: String,
    direction: String,
    paths: Vec<String>,
    destination: String,
    manager: State<'_, SshManager>,
    allowlist: State<'_, PathAllowlist>,
    app: AppHandle,
) -> Result<TransferProgress, String> {
    if direction != "upload" && direction != "download" {
        return Err("不支持的传输方向".to_string());
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
    let mut context = TransferContext {
        flag,
        app: &app,
        last_emit: Instant::now(),
        progress: TransferProgress {
            task_id,
            status: "running".to_string(),
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
    };
    context.emit(true);
    for (index, path) in paths.iter().enumerate() {
        let operation = async {
            context.check()?;
            if direction == "upload" {
                let (sftp, parsed, root) =
                    cancellable(&context.flag, manager.sftp_for_uri(&destination, true)).await?;
                cancellable(
                    &context.flag,
                    ensure_existing_path_within(&sftp, &parsed.path, &root),
                )
                .await?;
                if !cancellable(&context.flag, sftp.metadata(parsed.path.clone()))
                    .await?
                    .is_dir()
                {
                    return Err("请选择远程目录作为上传目标".to_string());
                }
                let local = PathBuf::from(path);
                let name = local
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "上传路径缺少有效文件名".to_string())?;
                validate_entry_name(name)?;
                let remote = format!("{}/{name}", parsed.path.trim_end_matches('/'));
                transfer_upload(
                    &manager,
                    &sftp,
                    local,
                    remote,
                    &root,
                    &allowlist,
                    &mut context,
                )
                .await
            } else {
                allowlist.ensure_writable(&destination)?;
                let (sftp, parsed, root) =
                    cancellable(&context.flag, manager.sftp_for_uri(path, false)).await?;
                let name = parsed
                    .path
                    .rsplit('/')
                    .next()
                    .ok_or_else(|| "下载路径缺少有效文件名".to_string())?;
                validate_entry_name(name)?;
                let local = PathBuf::from(&destination).join(name);
                transfer_download(&sftp, parsed.path, local, &root, &allowlist, &mut context).await
            }
        }
        .await;
        if let Err(error) = operation {
            context.progress.status = if context.flag.load(Ordering::SeqCst) {
                "cancelled"
            } else {
                "failed"
            }
            .to_string();
            context.progress.error = Some(error);
            context.progress.failed_path = Some(path.clone());
            context.progress.pending_paths = paths[index..].to_vec();
            context.emit(true);
            return Ok(context.progress);
        }
        context.progress.completed_paths.push(path.clone());
        context.progress.pending_paths = paths[index + 1..].to_vec();
        context.emit(true);
    }
    context.progress.status = "completed".to_string();
    context.progress.current_path = None;
    context.emit(true);
    Ok(context.progress)
}

#[cfg(test)]
mod tests {
    use super::*;
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
