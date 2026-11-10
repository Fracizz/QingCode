//! 远端文件命令：stat、读取（文本/图片/分片）、写入、创建、重命名、移动、复制、
//! 删除、扩展名统计与文档格式化。

use super::*;

#[tauri::command]
pub async fn ssh_file_stat(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteFileStat, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    Ok(RemoteFileStat {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
    })
}

#[tauri::command]
pub async fn ssh_file_mtime(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Option<u64>, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件时间失败：{error}"))?;
    Ok(metadata.mtime.map(|seconds| u64::from(seconds) * 1000))
}

#[tauri::command]
pub async fn ssh_read_file(
    path: String,
    encoding: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    // Reject known-binary formats before pulling the whole file across SFTP.
    if crate::binary_ext::is_binary_extension(&parsed.path) {
        return Err(crate::binary_ext::unsupported_remote_binary_message(
            &parsed.path,
        ));
    }
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    if metadata.is_dir() {
        return Err("无法把远程目录作为文件打开".to_string());
    }
    if metadata.len() > MAX_EDITOR_FILE_SIZE {
        return Err("暂不支持编辑超过 100MB 的远程文件".to_string());
    }
    let bytes = sftp
        .read(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    file_encoding::decode(&bytes, file_encoding::parse(encoding.as_deref()))
        .map_err(|error| format!("远程文件解码失败：{error}"))
}

/// 图片查看专用：与 `ssh_read_file` 同一套守卫（sftp 会话 + 根目录边界 + 非目录 +
/// 大小上限），但扩展名检查方向相反——只放行图片白名单（图片是主动允许的二进制）。
/// 内容以原始字节（`tauri::ipc::Response`）直通前端，不做编码转换。
#[tauri::command]
pub async fn ssh_read_image_file(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<tauri::ipc::Response, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    // 与 ssh_read_file 的黑名单方向相反：非图片扩展名直接拒绝，省一次 SFTP 往返。
    if !crate::binary_ext::is_image_extension(&parsed.path) {
        return Err(crate::binary_ext::unsupported_image_format_message(
            &parsed.path,
        ));
    }
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    if metadata.is_dir() {
        return Err("无法把远程目录作为图片打开".to_string());
    }
    if metadata.len() > IMAGE_MAX_BYTES {
        return Err(crate::binary_ext::image_too_large_message(metadata.len()));
    }
    let bytes = sftp
        .read(parsed.path)
        .await
        .map_err(|error| format!("读取远程图片失败：{error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn ssh_detect_file_encoding(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    // `detect` reads the head of the file; skip the round trip for formats that
    // are binary by definition so the UI can name the real reason.
    if crate::binary_ext::is_binary_extension(&parsed.path) {
        return Err(crate::binary_ext::unsupported_remote_binary_message(
            &parsed.path,
        ));
    }
    let bytes = sftp
        .read(parsed.path)
        .await
        .map_err(|error| format!("读取远程文件失败：{error}"))?;
    file_encoding::detect(&bytes[..bytes.len().min(8192)])
        .map(|encoding| encoding.as_str().to_string())
        .map_err(|error| format!("检测远程文件编码失败：{error}"))
}

#[tauri::command]
pub async fn ssh_read_file_slice(
    path: String,
    offset: u64,
    max_bytes: u64,
    manager: State<'_, SshManager>,
) -> Result<RemoteFileSlice, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let mut file = sftp
        .open(parsed.path)
        .await
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    let file_size = metadata.len();
    if offset > file_size {
        return Err("读取偏移超出远程文件范围".to_string());
    }
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| format!("定位远程文件失败：{error}"))?;
    let requested = max_bytes.clamp(1, MAX_SLICE_BYTES).min(file_size - offset) as usize;
    read_remote_file_slice(&mut file, offset, requested, file_size).await
}

/// SFTP reads may stop at the server's packet limit before the requested end.
/// Fill the bounded slice before decoding, then leave a partial UTF-8 tail for
/// the next request, using the same byte-offset rules as the local viewer.
pub(super) async fn read_remote_file_slice<R: AsyncRead + Unpin>(
    file: &mut R,
    offset: u64,
    requested: usize,
    file_size: u64,
) -> Result<RemoteFileSlice, String> {
    let mut bytes = vec![0; requested];
    let mut read_total = 0;
    while read_total < requested {
        let read = file
            .read(&mut bytes[read_total..])
            .await
            .map_err(|error| format!("读取远程文件片段失败：{error}"))?;
        if read == 0 {
            break;
        }
        read_total += read;
    }
    bytes.truncate(read_total);
    bytes.truncate(crate::commands::cmd_stat::trim_utf8_end(&bytes));
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let next_offset = offset + bytes.len() as u64;
    Ok(RemoteFileSlice {
        content,
        offset,
        next_offset,
        file_size,
        eof: next_offset >= file_size,
    })
}

#[tauri::command]
pub async fn ssh_find_line_offset(
    path: String,
    line: u64,
    manager: State<'_, SshManager>,
) -> Result<crate::commands::cmd_stat::LineOffsetResult, String> {
    if line == 0 {
        return Err("行号必须从 1 开始".into());
    }
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let mut file = sftp
        .open(parsed.path)
        .await
        .map_err(|error| format!("打开远程文件失败：{error}"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
    if metadata.is_dir() {
        return Err("无法打开文件夹".into());
    }
    let file_size = metadata.len();
    if file_size == 0 {
        return Ok(crate::commands::cmd_stat::LineOffsetResult {
            line,
            offset: 0,
            found: line == 1,
            total_lines: 0,
            file_size: 0,
        });
    }
    if line == 1 {
        return Ok(crate::commands::cmd_stat::LineOffsetResult {
            line: 1,
            offset: 0,
            found: true,
            total_lines: 1,
            file_size,
        });
    }

    const BUF_SIZE: usize = 64 * 1024;
    let mut buf = [0u8; BUF_SIZE];
    let mut current_line: u64 = 1;
    let mut file_pos: u64 = 0;

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|error| format!("读取远程文件失败：{error}"))?;
        if n == 0 {
            break;
        }
        for (i, &b) in buf[..n].iter().enumerate() {
            if b == b'\n' {
                let next_offset = file_pos + i as u64 + 1;
                current_line += 1;
                if current_line == line {
                    return Ok(crate::commands::cmd_stat::LineOffsetResult {
                        line,
                        offset: next_offset.min(file_size),
                        found: true,
                        total_lines: line,
                        file_size,
                    });
                }
            }
        }
        file_pos += n as u64;
    }

    Ok(crate::commands::cmd_stat::LineOffsetResult {
        line,
        offset: file_size,
        found: false,
        total_lines: current_line,
        file_size,
    })
}

pub(super) fn remote_write_flags(exclusive: bool) -> OpenFlags {
    let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
    if exclusive {
        flags | OpenFlags::EXCLUDE
    } else {
        flags
    }
}

pub(super) async fn write_remote_file_contents(
    sftp: &SftpSession,
    path: String,
    bytes: &[u8],
    exclusive: bool,
) -> Result<(), String> {
    let mut file = sftp
        .open_with_flags(path, remote_write_flags(exclusive))
        .await
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .await
        .map_err(|error| error.to_string())?;
    file.shutdown().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ssh_write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    let bytes = file_encoding::encode(&content, file_encoding::parse(encoding.as_deref()))
        .map_err(|error| format!("远程文件编码失败：{error}"))?;
    if bytes.len() as u64 > MAX_EDITOR_FILE_SIZE {
        return Err("暂不支持保存超过 100MB 的远程文件".to_string());
    }
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
        let metadata = sftp
            .symlink_metadata(parsed.path.clone())
            .await
            .map_err(|error| format!("读取远程文件属性失败：{error}"))?;
        if metadata.is_dir() {
            return Err("无法把远程目录作为文件保存".to_string());
        }
        // Preserve symlink semantics: an atomic rename would replace the link itself.
        if metadata.is_symlink() {
            return write_remote_file_contents(&sftp, parsed.path, &bytes, false)
                .await
                .map_err(|error| format!("保存远程符号链接目标失败：{error}"));
        }
    }
    let parent = remote_parent_path(&parsed.path)?;
    let name = parsed.path.rsplit('/').next().unwrap_or("file");
    let temp = format!("{parent}/.{name}.qingcode-{}.tmp", uuid::Uuid::new_v4());
    write_remote_file_contents(&sftp, temp.clone(), &bytes, true)
        .await
        .map_err(|error| format!("上传远程临时文件失败：{error}"))?;
    if let Err(rename_error) = sftp.rename(temp.clone(), parsed.path.clone()).await {
        // SFTP v3 servers are allowed to reject rename when the destination exists.
        // Keep atomic rename where supported, and safely fall back to truncating the
        // existing regular file without deleting it first.
        if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
            let fallback = write_remote_file_contents(&sftp, parsed.path.clone(), &bytes, false)
                .await
                .map_err(|write_error| {
                    format!("替换远程文件失败：{rename_error}；直接写入也失败：{write_error}")
                });
            let _ = sftp.remove_file(temp).await;
            fallback?;
        } else {
            let _ = sftp.remove_file(temp).await;
            return Err(format!("替换远程文件失败：{rename_error}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_check_symlink_write(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteSymlinkWriteCheck, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    let probe = if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        parsed.path
    } else {
        remote_parent_path(&parsed.path)?.to_string()
    };
    let canonical = ensure_existing_path_within(&sftp, &probe, &root).await?;
    Ok(RemoteSymlinkWriteCheck {
        needs_confirm: false,
        resolved_path: Some(canonical),
    })
}

#[tauri::command]
pub async fn ssh_create_file(
    parent: String,
    name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let target_uri = join_remote_uri(&parent, &name);
    let (sftp, parsed, root) = manager.sftp_for_uri(&target_uri, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    if sftp.try_exists(parsed.path.clone()).await.unwrap_or(false) {
        return Err("同名文件或文件夹已存在".to_string());
    }
    write_remote_file_contents(&sftp, parsed.path, &[], true)
        .await
        .map_err(|error| format!("创建远程文件失败：{error}"))?;
    Ok(target_uri)
}

#[tauri::command]
pub async fn ssh_create_directory(
    parent: String,
    name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let target_uri = join_remote_uri(&parent, &name);
    let (sftp, parsed, root) = manager.sftp_for_uri(&target_uri, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    sftp.create_dir(parsed.path)
        .await
        .map_err(|error| format!("创建远程文件夹失败：{error}"))?;
    Ok(target_uri)
}

#[tauri::command]
pub async fn ssh_rename_path(
    path: String,
    new_name: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    validate_entry_name(&new_name)?;
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    let uri_parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .ok_or_else(|| "远程路径缺少父目录".to_string())?;
    let new_uri = join_remote_uri(uri_parent, &new_name);
    let new_path = format!(
        "{}/{}",
        remote_parent_path(&parsed.path)?.trim_end_matches('/'),
        new_name
    );
    sftp.rename(parsed.path, new_path)
        .await
        .map_err(|error| format!("重命名远程路径失败：{error}"))?;
    Ok(new_uri)
}

pub(super) async fn remove_remote_tree(sftp: &SftpSession, path: String) -> Result<(), String> {
    // HTTPS workspace operations enforce native path/reparse boundaries on the
    // Agent. Its session has no SSH transport for the PowerShell metadata guard.
    if let Some(native) = windows_native_path(&path).filter(|_| sftp.direct.is_none()) {
        if let Some(component) = sftp
            .windows_guard
            .first_reparse_component(&sftp.transport, &path)
            .await?
        {
            if !native
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(component.trim_end_matches('\\'))
            {
                return Err(format!("拒绝通过 Windows 链接删除项目外路径：{component}"));
            }
            // Only this entry is a reparse point: remove the link, not its target.
            if sftp.remove_file(path.clone()).await.is_ok() {
                return Ok(());
            }
            return sftp
                .remove_dir(path)
                .await
                .map_err(|e| format!("删除远程目录链接失败：{e}"));
        }
    }
    let metadata = sftp
        .symlink_metadata(path.clone())
        .await
        .map_err(|error| format!("读取远程路径失败：{error}"))?;
    if metadata.is_dir() && !metadata.is_symlink() {
        let entries = sftp
            .read_dir(path.clone())
            .await
            .map_err(|error| format!("读取远程目录失败：{error}"))?;
        for entry in entries {
            Box::pin(remove_remote_tree(sftp, entry.path())).await?;
        }
        sftp.remove_dir(path)
            .await
            .map_err(|error| format!("删除远程目录失败：{error}"))
    } else {
        match sftp.remove_file(path.clone()).await {
            Ok(()) => Ok(()),
            Err(_) if metadata.is_symlink() && windows_native_path(&path).is_some() => {
                // Windows 目录 symlink/Junction 需要 RMDIR；只移除链接自身，绝不递归目标。
                sftp.remove_dir(path)
                    .await
                    .map_err(|error| format!("删除远程目录链接失败：{error}"))
            }
            Err(error) => Err(format!("删除远程文件失败：{error}")),
        }
    }
}

pub(super) async fn resolve_remote_dest_child(
    sftp: &SftpSession,
    dest_dir: &str,
    file_name: &str,
    conflict_policy: Option<&str>,
) -> Result<(String, String, bool), String> {
    let preferred_path = if dest_dir.ends_with('/') {
        format!("{dest_dir}{file_name}")
    } else {
        format!("{dest_dir}/{file_name}")
    };
    if sftp.metadata(preferred_path.clone()).await.is_err() {
        return Ok((file_name.to_string(), preferred_path, false));
    }
    match conflict_policy.unwrap_or("fail") {
        "overwrite" => Ok((file_name.to_string(), preferred_path, true)),
        "rename" => {
            let (stem, ext) = match file_name.rsplit_once('.') {
                Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
                _ => (file_name, String::new()),
            };
            for i in 1..=1000 {
                let candidate_name = format!("{stem} ({i}){ext}");
                let candidate_path = if dest_dir.ends_with('/') {
                    format!("{dest_dir}{candidate_name}")
                } else {
                    format!("{dest_dir}/{candidate_name}")
                };
                if sftp.metadata(candidate_path.clone()).await.is_err() {
                    return Ok((candidate_name, candidate_path, false));
                }
            }
            Err("无法生成可用的远程目标文件名".to_string())
        }
        "fail" => Err("目标名称已存在".to_string()),
        other => Err(format!("未知的冲突策略：{other}")),
    }
}

pub(super) async fn copy_remote_file(
    sftp: &SftpSession,
    src: String,
    dest: String,
) -> Result<(), String> {
    let mut reader = sftp
        .open(src)
        .await
        .map_err(|e| format!("打开远程源文件失败：{e}"))?;
    let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
    let mut writer = sftp
        .open_with_flags(dest, flags)
        .await
        .map_err(|e| format!("创建远程目标文件失败：{e}"))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取远程文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("写入远程文件失败：{e}"))?;
    }
    Ok(())
}

pub(super) async fn copy_remote_tree(
    sftp: &SftpSession,
    src: String,
    dest: String,
    source_root: &RegisteredRoot,
) -> Result<(), String> {
    // 顶层目录在根内不代表它的子项也安全：逐节点拒绝指向根外的文件链接。
    ensure_existing_path_within(sftp, &src, source_root).await?;
    let metadata = sftp
        .symlink_metadata(src.clone())
        .await
        .map_err(|e| format!("读取远程路径失败：{e}"))?;
    if metadata.is_dir() && !metadata.is_symlink() {
        sftp.create_dir(dest.clone())
            .await
            .map_err(|e| format!("创建远程目录失败：{e}"))?;
        let entries = sftp
            .read_dir(src)
            .await
            .map_err(|e| format!("读取远程目录失败：{e}"))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_dest = format!("{}/{}", dest.trim_end_matches('/'), name);
            Box::pin(copy_remote_tree(
                sftp,
                entry.path().to_string(),
                child_dest,
                source_root,
            ))
            .await?;
        }
        Ok(())
    } else {
        copy_remote_file(sftp, src, dest).await
    }
}

#[tauri::command]
pub async fn ssh_move_path(
    path: String,
    dest_dir: String,
    conflict_policy: Option<String>,
    dest_name: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (source_sftp, source_parsed, source_root) = manager.sftp_for_uri(&path, true).await?;
    let (dest_sftp, dest_parsed, dest_root) = manager.sftp_for_uri(&dest_dir, true).await?;

    if source_parsed.connection_id != dest_parsed.connection_id {
        return Err("不支持跨 SSH 连接移动文件".to_string());
    }
    ensure_existing_path_within(&source_sftp, &source_parsed.path, &source_root).await?;
    ensure_existing_path_within(&dest_sftp, &dest_parsed.path, &dest_root).await?;

    if normalize_remote_uri(&path) == source_root.uri {
        return Err("不允许移动远程项目根目录".to_string());
    }

    let source_meta = source_sftp
        .symlink_metadata(source_parsed.path.clone())
        .await
        .map_err(|e| format!("读取源路径失败：{e}"))?;

    let dest_meta = dest_sftp
        .metadata(dest_parsed.path.clone())
        .await
        .map_err(|e| format!("读取目标文件夹失败：{e}"))?;
    if !dest_meta.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    let initial_name = dest_name.unwrap_or_else(|| {
        source_parsed
            .path
            .rsplit('/')
            .next()
            .unwrap_or(&source_parsed.path)
            .to_string()
    });
    validate_entry_name(&initial_name)?;

    let (final_name, final_dest_path, overwrite) = resolve_remote_dest_child(
        &dest_sftp,
        &dest_parsed.path,
        &initial_name,
        conflict_policy.as_deref(),
    )
    .await?;

    if source_meta.is_dir() {
        let src_prefix = if source_parsed.path.ends_with('/') {
            source_parsed.path.clone()
        } else {
            format!("{}/", source_parsed.path)
        };
        if final_dest_path == source_parsed.path || dest_parsed.path.starts_with(&src_prefix) {
            return Err("不能将文件夹移动到其自身或子目录中".to_string());
        }
    }

    if overwrite {
        remove_remote_tree(&dest_sftp, final_dest_path.clone()).await?;
    }

    dest_sftp
        .rename(source_parsed.path, final_dest_path)
        .await
        .map_err(|e| format!("移动远程路径失败：{e}"))?;

    Ok(join_remote_uri(&dest_dir, &final_name))
}

#[tauri::command]
pub async fn ssh_copy_path_into(
    path: String,
    dest_dir: String,
    conflict_policy: Option<String>,
    dest_name: Option<String>,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let (source_sftp, source_parsed, source_root) = manager.sftp_for_uri(&path, false).await?;
    let (dest_sftp, dest_parsed, dest_root) = manager.sftp_for_uri(&dest_dir, true).await?;

    if source_parsed.connection_id != dest_parsed.connection_id {
        return Err("不支持跨 SSH 连接复制文件".to_string());
    }
    ensure_existing_path_within(&source_sftp, &source_parsed.path, &source_root).await?;
    ensure_existing_path_within(&dest_sftp, &dest_parsed.path, &dest_root).await?;

    let dest_meta = dest_sftp
        .metadata(dest_parsed.path.clone())
        .await
        .map_err(|e| format!("读取目标文件夹失败：{e}"))?;
    if !dest_meta.is_dir() {
        return Err("目标不是文件夹".to_string());
    }

    let initial_name = dest_name.unwrap_or_else(|| {
        source_parsed
            .path
            .rsplit('/')
            .next()
            .unwrap_or(&source_parsed.path)
            .to_string()
    });
    validate_entry_name(&initial_name)?;

    let (final_name, final_dest_path, overwrite) = resolve_remote_dest_child(
        &dest_sftp,
        &dest_parsed.path,
        &initial_name,
        conflict_policy.as_deref(),
    )
    .await?;

    if overwrite {
        remove_remote_tree(&dest_sftp, final_dest_path.clone()).await?;
    }

    copy_remote_tree(
        &dest_sftp,
        source_parsed.path,
        final_dest_path,
        &source_root,
    )
    .await?;

    Ok(join_remote_uri(&dest_dir, &final_name))
}

#[tauri::command]
pub async fn ssh_delete_path(path: String, manager: State<'_, SshManager>) -> Result<(), String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, true).await?;
    if normalize_remote_uri(&path) == root.uri {
        return Err("不允许删除远程项目根目录".to_string());
    }
    ensure_parent_path_within(&sftp, &parsed.path, &root).await?;
    remove_remote_tree(&sftp, parsed.path).await
}

#[tauri::command]
pub async fn ssh_directory_delete_stats(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<crate::commands::cmd_fs::DirectoryDeleteStats, String> {
    let (sftp, parsed, root) = manager.sftp_for_uri(&path, false).await?;
    ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
    let metadata = sftp
        .metadata(parsed.path.clone())
        .await
        .map_err(|error| format!("读取远程路径失败：{error}"))?;
    if !metadata.is_dir() {
        return Err("路径不是文件夹".to_string());
    }

    let mut file_count = 0u64;
    let mut total_size = 0u64;
    let mut queue = vec![parsed.path];

    while let Some(dir) = queue.pop() {
        ensure_existing_path_within(&sftp, &dir, &root).await?;
        let entries = match sftp.read_dir(dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let meta = entry.metadata();
            if meta.is_dir() && !meta.is_symlink() {
                queue.push(entry.path().to_string());
            } else {
                file_count += 1;
                total_size = total_size.saturating_add(meta.len());
            }
        }
    }

    Ok(crate::commands::cmd_fs::DirectoryDeleteStats {
        path,
        file_count,
        total_size,
    })
}

pub(super) fn fuzzy_contains(value: &str, query: &str) -> bool {
    let mut chars = query.chars();
    let mut wanted = chars.next();
    for ch in value.chars() {
        if Some(ch) == wanted {
            wanted = chars.next();
            if wanted.is_none() {
                return true;
            }
        }
    }
    wanted.is_none()
}

pub(super) fn remote_relative_path(root_path: &str, full_path: &str) -> String {
    full_path
        .strip_prefix(root_path.trim_end_matches('/'))
        .unwrap_or(full_path)
        .trim_start_matches('/')
        .trim_start_matches("./")
        .to_string()
}

pub(super) fn simple_glob_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.trim_start_matches("./").trim_start_matches('/');
    if pattern.is_empty() {
        return false;
    }
    let anchored = pattern.contains('/');
    let candidate = if anchored {
        value
    } else {
        value.rsplit('/').next().unwrap_or(value)
    };
    let pattern = pattern.replace("**", "*");
    let mut remaining = candidate;
    let mut first = true;
    for part in pattern.split('*') {
        if part.is_empty() {
            continue;
        }
        let Some(index) = remaining.find(part) else {
            return false;
        };
        if first && !pattern.starts_with('*') && index != 0 {
            return false;
        }
        remaining = &remaining[index + part.len()..];
        first = false;
    }
    pattern.ends_with('*') || remaining.is_empty()
}

#[tauri::command]
pub async fn ssh_list_file_extensions(
    roots: Vec<String>,
    max_files: Option<usize>,
    manager: State<'_, SshManager>,
) -> Result<Vec<String>, String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let max = max_files.unwrap_or(8_000).clamp(100, 50_000);
    for root in roots {
        if !root.starts_with(SSH_URI_PREFIX) {
            continue;
        }
        let parsed = parse_remote_uri(&root)?;
        let command = format!(
            "find {} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/target/*' -print | head -n {max}",
            shell_quote(&parsed.path)
        );
        let output = manager.exec_uri(&root, &command, false).await?;
        for path in output.stdout.lines() {
            if let Some((_, extension)) = path.rsplit_once('.') {
                let extension = extension.to_ascii_lowercase();
                if !extension.contains('/') && extension.len() <= 16 {
                    *counts.entry(extension).or_default() += 1;
                }
            }
        }
    }
    let mut extensions = counts.into_iter().collect::<Vec<_>>();
    extensions.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(extensions
        .into_iter()
        .map(|(extension, _)| extension)
        .take(80)
        .collect())
}

#[tauri::command]
pub async fn ssh_format_document(
    path: String,
    content: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    let parsed = parse_remote_uri(&path)?;
    let root = manager.root_for_uri(&path, true)?;
    let extension = parsed
        .path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    let prettier = format!(
        "cd -- {} && if [ -x node_modules/.bin/prettier ]; then exec node_modules/.bin/prettier --stdin-filepath {}; elif command -v prettier >/dev/null 2>&1; then exec prettier --stdin-filepath {}; else echo '未找到 prettier（项目 node_modules 或远端 PATH）' >&2; exit 127; fi",
        shell_quote(&root.canonical_path),
        shell_quote(&parsed.path),
        shell_quote(&parsed.path)
    );
    let command = match extension.as_str() {
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" | "json" | "jsonc" | "json5"
        | "css" | "scss" | "less" | "html" | "htm" | "vue" | "svelte" | "md" | "markdown"
        | "mdx" | "yaml" | "yml" | "graphql" | "gql" | "astro" => prettier,
        "rs" => "command -v rustfmt >/dev/null 2>&1 && exec rustfmt --emit stdout || { echo '远端未安装 rustfmt' >&2; exit 127; }".to_string(),
        "go" => "command -v gofmt >/dev/null 2>&1 && exec gofmt || { echo '远端未安装 gofmt' >&2; exit 127; }".to_string(),
        "sh" | "bash" | "zsh" => "command -v shfmt >/dev/null 2>&1 && exec shfmt || { echo '远端未安装 shfmt' >&2; exit 127; }".to_string(),
        "py" | "pyi" => format!(
            "if command -v ruff >/dev/null 2>&1; then exec ruff format --stdin-filename {} -; elif command -v black >/dev/null 2>&1; then exec black --quiet -; else echo '远端未安装 ruff 或 black' >&2; exit 127; fi",
            shell_quote(&parsed.path)
        ),
        _ => return Err(format!("暂不支持格式化 .{extension} 远程文件")),
    };
    let output = manager
        .exec_uri_with_input(&path, &command, content.as_bytes(), true)
        .await?;
    if output.exit_code == 0 {
        Ok(output.stdout)
    } else {
        Err(format!("远程格式化失败：{}", output.stderr.trim()))
    }
}
