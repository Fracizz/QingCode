//! Paste cleanup uses the existing authenticated session only; it never starts
//! SSH authentication, deployment, or a reconnect in the background.
use super::*;
use crate::terminal_paste_cleanup::{cleanup_cutoff, MAX_CLEANUP_ENTRIES};
use std::time::UNIX_EPOCH;

#[tauri::command]
pub async fn ssh_cleanup_terminal_paste(
    path: String,
    retention_days: u32,
    excluded_paths: Vec<String>,
    manager: State<'_, SshManager>,
) -> Result<usize, String> {
    let cutoff = cleanup_cutoff(retention_days)?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    tokio::time::timeout(
        Duration::from_secs(30),
        cleanup_connected(&manager, &path, cutoff, &excluded_paths),
    )
    .await
    .map_err(|_| "粘贴附件后台清理超时，剩余文件留待下次打开项目时处理".to_string())?
}

async fn safe_path(sftp: &SftpSession, root: &RegisteredRoot, path: &str) -> bool {
    let Some(relative) =
        path.strip_prefix(&format!("{}/", root.canonical_path.trim_end_matches('/')))
    else {
        return false;
    };
    let mut current = root.canonical_path.clone();
    for part in relative.split('/') {
        if validate_entry_name(part).is_err() {
            return false;
        }
        current = join_remote_path(&current, part);
        let Ok(metadata) = sftp.symlink_metadata(current.clone()).await else {
            return false;
        };
        if metadata.is_symlink() {
            return false;
        }
    }
    if reject_windows_sftp_links(sftp, path).await.is_err() {
        return false;
    }
    let Ok(canonical) = ensure_existing_path_within(sftp, path, root).await else {
        return false;
    };
    // Direct Server metadata may report a junction as a directory. Reject any
    // physical-path change, including links that stay inside the project.
    if windows_native_path(path).is_some() {
        canonical.eq_ignore_ascii_case(path)
    } else {
        canonical == path
    }
}

async fn expired_tree(
    sftp: &SftpSession,
    root: &RegisteredRoot,
    batch: &str,
    cutoff: u64,
    remaining: &mut usize,
) -> Option<Vec<(String, bool)>> {
    let mut pending = vec![batch.to_string()];
    let mut entries = Vec::new();
    while let Some(path) = pending.pop() {
        *remaining = remaining.checked_sub(1)?;
        if !safe_path(sftp, root, &path).await {
            return None;
        }
        let metadata = sftp.symlink_metadata(path.clone()).await.ok()?;
        if (!metadata.is_dir() && !metadata.is_regular()) || u64::from(metadata.mtime?) >= cutoff {
            return None;
        }
        if metadata.is_dir() {
            for entry in sftp.read_dir(path.clone()).await.ok()? {
                let name = entry.file_name();
                validate_entry_name(&name).ok()?;
                pending.push(join_remote_path(&path, &name));
                if pending.len() > *remaining {
                    return None;
                }
            }
        }
        entries.push((path, metadata.is_dir()));
    }
    entries.reverse();
    Some(entries)
}

async fn cleanup_connected(
    manager: &SshManager,
    uri: &str,
    cutoff: u64,
    excluded: &[String],
) -> Result<usize, String> {
    let parsed = parse_remote_uri(uri)?;
    let root = manager.root_for_uri(uri, true)?;
    let sftp = if manager.direct_config(&parsed.connection_id).is_some() {
        manager.sftp_for_uri(uri, true).await?.0
    } else {
        let session = manager
            .sessions
            .read()
            .map_err(|_| "SSH 连接状态不可用")?
            .get(&parsed.connection_id)
            .filter(|session| !session.handle.is_closed())
            .cloned();
        let Some(session) = session else { return Ok(0) };
        open_sftp_session(&session)
            .await
            .map_err(|error| error.message)?
    };
    // Work on the canonical registered root, including projects opened via aliases.
    let project = ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let paste = join_remote_path(&project, ".qingcode/terminal-paste");
    if !safe_path(&sftp, &root, &paste).await {
        return Ok(0);
    }
    let mut excluded_canonical = Vec::new();
    for value in excluded {
        if let Ok(excluded) = parse_remote_uri(value) {
            if excluded.connection_id == parsed.connection_id {
                if let Ok(path) = sftp.canonicalize(excluded.path).await {
                    excluded_canonical.push(path);
                }
            }
        }
    }
    let mut remaining = MAX_CLEANUP_ENTRIES;
    let mut removed = 0;
    for entry in sftp
        .read_dir(paste.clone())
        .await
        .map_err(|error| error.to_string())?
    {
        if remaining == 0 {
            break;
        }
        remaining -= 1;
        let name = entry.file_name();
        if validate_entry_name(&name).is_err() {
            continue;
        }
        let batch = join_remote_path(&paste, &name);
        if excluded_canonical
            .iter()
            .any(|path| remote_path_is_within(path, &batch) || remote_path_is_within(&batch, path))
        {
            continue;
        }
        let Some(entries) = expired_tree(&sftp, &root, &batch, cutoff, &mut remaining).await else {
            continue;
        };
        for (target, is_dir) in entries {
            manager.root_for_uri(uri, true)?;
            if !safe_path(&sftp, &root, &target).await {
                break;
            }
            if is_dir {
                // No recursive delete: new/changed files survive concurrent uploads.
                if sftp.remove_dir(target.clone()).await.is_ok() && target == batch {
                    removed += 1;
                }
            } else if sftp
                .symlink_metadata(target.clone())
                .await
                .ok()
                .and_then(|metadata| metadata.mtime)
                .is_some_and(|mtime| u64::from(mtime) < cutoff)
                && sftp.remove_file(target.clone()).await.is_ok()
                && target == batch
            {
                removed += 1;
            }
        }
    }
    Ok(removed)
}
