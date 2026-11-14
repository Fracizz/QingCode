//! Bounded mobile file reads over the existing SFTP / authenticated Agent adapter.
use super::*;
use crate::mobile::files::{self, Action, Entry, FileAccess, FileRequest};
use serde_json::{json, Value};

fn version(path: &str, meta: &russh_sftp::protocol::FileAttributes) -> String {
    files::stamp(
        path,
        meta.len(),
        &format!("{:?}:{:?}", meta.mtime, meta.permissions),
    )
}

async fn checked(
    sftp: &SftpSession,
    path: &str,
    registered: &RegisteredRoot,
    project_root: &str,
) -> Result<String, String> {
    let canonical = ensure_existing_path_within(sftp, path, registered).await?;
    if !remote_path_is_within(&canonical, project_root) {
        return Err("路径通过符号链接跳出了当前项目。".into());
    }
    Ok(canonical)
}

pub(crate) async fn operate(
    manager: &SshManager,
    mut access: FileAccess,
    request: FileRequest,
) -> Result<Value, String> {
    request.validate()?;
    let (sftp, parsed, registered) = manager.sftp_for_uri(&access.path, true).await?;
    let root = ensure_existing_path_within(&sftp, &parsed.path, &registered).await?;
    files::validate_platform_relative(&request.path, windows_native_path(&root).is_some())?;
    let raw_path = if request.path.is_empty() {
        root.clone()
    } else {
        join_remote_path(&root, &request.path)
    };
    let path = checked(&sftp, &raw_path, &registered, &root).await?;
    if matches!(request.action, Action::List | Action::Search) {
        // Like the desktop remote explorer, only files.exclude applies remotely;
        // .gitignore needs a host-side walker and is not claimed as supported.
        access.exclude_git_ignore = false;
        return tokio::time::timeout(
            Duration::from_secs(20),
            listing(&sftp, &registered, &root, &path, &access, &request),
        )
        .await
        .map_err(|_| "文件查询超时，请缩小目录范围后重试。".to_string())?;
    }
    if !sftp
        .metadata(path.clone())
        .await
        .map_err(|e| e.to_string())?
        .is_regular()
    {
        return Err("仅支持下载普通文件。".into());
    }
    let mut file = sftp
        .open(path.clone())
        .await
        .map_err(|e| format!("无法读取远端文件：{e}"))?;
    let result = async {
        let meta = file.metadata().await.map_err(|e| e.to_string())?;
        if !meta.is_regular() {
            return Err("仅支持下载普通文件。".into());
        }
        let stamp = version(&path, &meta);
        let current = sftp
            .metadata(path.clone())
            .await
            .map_err(|_| files::changed())?;
        if checked(&sftp, &raw_path, &registered, &root).await? != path
            || version(&path, &current) != stamp
        {
            return Err(files::changed());
        }
        if request.action == Action::Stat {
            return Ok(json!({
                "name": files::entry_name(&request.path),
                "path": request.path,
                "size": meta.len(),
                "modifiedAt": meta.mtime.map(|s| u64::from(s) * 1000),
                "version": stamp,
            }));
        }
        if request.version != stamp || request.offset > meta.len() {
            return Err(files::changed());
        }
        let size = (meta.len() - request.offset).min(request.length) as usize;
        let mut bytes = vec![0; size];
        file.seek(std::io::SeekFrom::Start(request.offset))
            .await
            .map_err(|e| e.to_string())?;
        file.read_exact(&mut bytes)
            .await
            .map_err(|_| files::changed())?;
        let after = file.metadata().await.map_err(|e| e.to_string())?;
        if checked(&sftp, &raw_path, &registered, &root).await? != path {
            return Err(files::changed());
        }
        let current = sftp
            .metadata(path.clone())
            .await
            .map_err(|_| files::changed())?;
        if version(&path, &after) != stamp || version(&path, &current) != stamp {
            return Err(files::changed());
        }
        Ok(files::chunk_response(&request, &bytes, meta.len()))
    }
    .await;
    let close = file.close().await;
    match result {
        Ok(value) => {
            close.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

async fn listing(
    sftp: &SftpSession,
    registered: &RegisteredRoot,
    root: &str,
    path: &str,
    access: &FileAccess,
    request: &FileRequest,
) -> Result<Value, String> {
    let search = request.action == Action::Search;
    let limit = if search {
        files::SEARCH_LIMIT
    } else {
        files::LIST_LIMIT
    };
    let query = request.query.trim().to_lowercase();
    let mut pending = vec![(path.to_string(), 0)];
    let mut entries = Vec::new();
    let mut visited = HashSet::new();
    let mut scanned = 0;
    let started = Instant::now();
    let mut truncated = false;
    'walk: while let Some((directory, depth)) = pending.pop() {
        if started.elapsed() >= files::SCAN_TIMEOUT || scanned >= files::SCAN_LIMIT {
            truncated = true;
            break;
        }
        let canonical = checked(sftp, &directory, registered, root).await?;
        if !visited.insert(canonical.clone()) {
            continue;
        }
        let read = sftp
            .read_dir(canonical)
            .await
            .map_err(|e| format!("无法读取远端目录：{e}"))?;
        let mut children = read.collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        let mut dirs = Vec::new();
        for child in children {
            scanned += 1;
            if scanned > files::SCAN_LIMIT || started.elapsed() >= files::SCAN_TIMEOUT {
                truncated = true;
                break 'walk;
            }
            let name = child.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if crate::path_guard::validate_entry_name(&name).is_err() {
                truncated = true;
                continue;
            }
            let full = join_remote_path(&directory, &name);
            let relative = full
                .strip_prefix(root)
                .ok_or("远端路径不在项目内。")?
                .trim_start_matches('/')
                .to_string();
            if files::validate_platform_relative(&relative, windows_native_path(root).is_some())
                .is_err()
            {
                truncated = true;
                continue;
            }
            let meta = child.metadata();
            if !files::visible(&relative, request.hidden, &access.excludes)
                || meta.is_symlink()
                || (!meta.is_dir() && !meta.is_regular())
            {
                continue;
            }
            if search && meta.is_dir() {
                if depth < 64 {
                    dirs.push((full, depth + 1));
                } else {
                    truncated = true;
                }
                continue;
            }
            if search && !relative.to_lowercase().contains(&query) {
                continue;
            }
            if entries.len() == limit {
                truncated = true;
                break 'walk;
            }
            entries.push(Entry {
                name,
                path: relative,
                is_dir: meta.is_dir(),
                size: meta.is_regular().then_some(meta.len()),
                modified_at: meta.mtime.map(|s| u64::from(s) * 1000),
            });
        }
        pending.extend(dirs.into_iter().rev());
    }
    Ok(files::listing(entries, truncated, access))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn agent_files_browse_search_download_and_enforce_selected_project_boundary() {
        use base64::Engine;
        let (config, gateway, directory) = super::super::direct::tests::gateway().await;
        let registered = directory.join("workspace");
        let selected = registered.join("project");
        let sibling = registered.join("sibling");
        std::fs::create_dir_all(selected.join("src")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(selected.join("src/你好.bin"), [0, 255, 128, 1]).unwrap();
        std::fs::write(selected.join(".hidden"), b"hidden").unwrap();
        std::fs::write(sibling.join("secret"), b"outside selected project").unwrap();
        let canonical = std::fs::canonicalize(&registered)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        #[cfg(windows)]
        let canonical = format!("/{}", canonical.trim_start_matches("//?/"));
        let uri = format!("ssh://mobile-files{canonical}");
        let project_uri = format!("{uri}/project");
        let manager = SshManager::new();
        manager
            .direct_connections
            .write()
            .unwrap()
            .insert("mobile-files".into(), config);
        manager
            .direct_active
            .write()
            .unwrap()
            .insert("mobile-files".into());
        manager.roots.write().unwrap().insert(
            uri.clone(),
            RegisteredRoot {
                uri: uri.clone(),
                canonical_path: canonical.clone(),
                trusted: true,
            },
        );
        let access = || FileAccess {
            path: project_uri.clone(),
            excludes: Vec::new(),
            exclude_git_ignore: false,
        };
        let list = operate(&manager, access(), FileRequest::list("".into(), false))
            .await
            .unwrap();
        assert_eq!(list["entries"].as_array().unwrap().len(), 1);
        assert_eq!(list["entries"][0]["name"], "src");
        let search = operate(
            &manager,
            access(),
            FileRequest::search("".into(), "你好".into(), false),
        )
        .await
        .unwrap();
        assert_eq!(search["entries"][0]["path"], "src/你好.bin");
        let stat = operate(&manager, access(), FileRequest::stat("src/你好.bin".into()))
            .await
            .unwrap();
        let chunk = operate(
            &manager,
            access(),
            FileRequest::chunk(
                "src/你好.bin".into(),
                stat["version"].as_str().unwrap().into(),
                0,
                files::CHUNK_LIMIT,
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(chunk["data"].as_str().unwrap())
                .unwrap(),
            [0, 255, 128, 1]
        );
        assert_eq!(chunk["eof"], true);
        #[cfg(unix)]
        {
            std::fs::write(selected.join("src/notes:2026.txt"), b"colon contents").unwrap();
            std::fs::write(selected.join("src/back\\slash"), b"unsupported").unwrap();
            let list = operate(&manager, access(), FileRequest::list("src".into(), false))
                .await
                .unwrap();
            assert!(list["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["name"] == "notes:2026.txt"));
            assert_eq!(list["truncated"], true);
            let search = operate(
                &manager,
                access(),
                FileRequest::search("".into(), "notes:2026".into(), false),
            )
            .await
            .unwrap();
            assert_eq!(search["entries"][0]["path"], "src/notes:2026.txt");
            let stat = operate(
                &manager,
                access(),
                FileRequest::stat("src/notes:2026.txt".into()),
            )
            .await
            .unwrap();
            let chunk = operate(
                &manager,
                access(),
                FileRequest::chunk(
                    "src/notes:2026.txt".into(),
                    stat["version"].as_str().unwrap().into(),
                    0,
                    files::CHUNK_LIMIT,
                ),
            )
            .await
            .unwrap();
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk["data"].as_str().unwrap())
                    .unwrap(),
                b"colon contents"
            );
            std::os::unix::fs::symlink(&sibling, selected.join("escape")).unwrap();
            assert!(operate(
                &manager,
                access(),
                FileRequest::stat("escape/secret".into())
            )
            .await
            .unwrap_err()
            .contains("当前项目"));
        }
        manager
            .roots
            .write()
            .unwrap()
            .get_mut(&uri)
            .unwrap()
            .trusted = false;
        assert!(
            operate(&manager, access(), FileRequest::stat("src/你好.bin".into()))
                .await
                .is_err()
        );
        gateway.abort();
        let _ = gateway.await;
        std::fs::remove_dir_all(directory).unwrap();
    }
}
