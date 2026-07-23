use crate::file_encoding;
use crate::path_guard::PathAllowlist;
use serde::Serialize;
use std::fs;
use std::fs::File;
use std::io::{copy, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// Full-buffer `read_file` / `write_file` budget (plain-text CodeMirror up to this size).
const MAX_EDITOR_FILE_SIZE: u64 = 100 * 1024 * 1024;
/// Legacy range-replace hard cap (same as full-buffer budget; UI no longer exposes patch).
const MAX_PATCH_FILE_SIZE: u64 = 100 * 1024 * 1024;
/// Max UTF-8 bytes accepted by `replace_file_range` (fragment edit).
const MAX_REPLACE_TEXT_BYTES: u64 = 1024 * 1024;

fn exceeds_editor_file_size_limit(size: u64) -> bool {
    size > MAX_EDITOR_FILE_SIZE
}

fn exceeds_patch_file_size_limit(size: u64) -> bool {
    size > MAX_PATCH_FILE_SIZE
}

fn display_file_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
}

fn file_extension_lower(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_binary_extension(name: &str) -> bool {
    let ext = file_extension_lower(name);
    matches!(
        ext.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "bmp"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "eot"
            | "pdf"
            | "zip"
            | "gz"
            | "tar"
            | "7z"
            | "rar"
            | "exe"
            | "dll"
            | "so"
            | "dylib"
            | "bin"
            | "mp3"
            | "mp4"
            | "avi"
            | "mov"
            | "mkv"
            | "wasm"
            | "lock"
            | "map"
            | "pyc"
            | "pyo"
            | "pyd"
            | "class"
            | "o"
            | "obj"
            | "typed"
            | "xlsx"
            | "xlsm"
            | "xls"
            | "docx"
            | "doc"
            | "pptx"
            | "ppt"
            | "odt"
            | "ods"
            | "odp"
            | "numbers"
            | "pages"
            | "key"
            | "sqlite"
            | "db"
            | "7zip"
    )
}

/// User-facing reason when a path cannot be opened as a text editor buffer.
fn unsupported_text_file_message(path: &str) -> String {
    let name = display_file_name(path);
    let ext = file_extension_lower(name);
    if !ext.is_empty() {
        format!("暂不支持打开 .{ext} 格式（非文本文件），请用对应应用打开：{name}")
    } else {
        format!("暂不支持打开非文本或非 UTF-8 文件：{name}")
    }
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        Err("名称不能为空或包含路径分隔符".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    // Mandatory sandbox: canonicalize/symlink-resolve before allowlist check.
    // Symlink escape is rejected unless the resolved target was explicitly authorized
    // (e.g. after the frontend confirm dialog grants the path).
    allowlist.ensure_writable(&path)?;
    let enc = file_encoding::parse(encoding.as_deref());
    let bytes = file_encoding::encode(&content, enc).map_err(|e| {
        format!(
            "无法按 {} 编码保存文件：{}（{}）",
            enc.as_str(),
            display_file_name(&path),
            e
        )
    })?;
    if exceeds_editor_file_size_limit(bytes.len() as u64) {
        return Err(format!("暂不支持保存超过 100MB 的大文件: {}", path));
    }
    let file_path = Path::new(&path);
    write_file_safely(file_path, &bytes).map_err(|e| format!("Failed to write {}: {}", path, e))
}

fn write_file_safely(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(parent) = parent {
        fs::create_dir_all(parent)?;
    }

    if path.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path is a directory",
        ));
    }

    // Replacing a symlink would turn it into a regular file, so write through it instead.
    if fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)?;
        file.write_all(bytes)?;
        return file.sync_all();
    }

    let parent = parent.unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("qingcode");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut temp_path = None;

    for attempt in 0..10 {
        let candidate = parent.join(format!(".{file_name}.{nonce}.{attempt}.tmp"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                temp_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    let temp_path = temp_path.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "unable to create temporary file",
        )
    })?;

    #[cfg(windows)]
    {
        if path.exists() {
            let backup_path = parent.join(format!(".{file_name}.{nonce}.backup"));
            fs::rename(path, &backup_path)?;
            if let Err(error) = fs::rename(&temp_path, path) {
                let _ = fs::rename(&backup_path, path);
                let _ = fs::remove_file(&temp_path);
                return Err(error);
            }
            let _ = fs::remove_file(backup_path);
            return Ok(());
        }
    }

    fs::rename(temp_path, path)
}

#[tauri::command]
pub fn replace_file_range(
    path: String,
    start: u64,
    end: u64,
    text: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<super::cmd_stat::FileStat, String> {
    allowlist.ensure_writable(&path)?;
    replace_file_range_inner(path, start, end, text)
}

/// Stream a range replacement into a temp file, then atomically replace.
/// Kept for compatibility; the UI opens ≤100MB files in CodeMirror instead.
fn replace_file_range_inner(
    path: String,
    start: u64,
    end: u64,
    text: String,
) -> Result<super::cmd_stat::FileStat, String> {
    if start > end {
        return Err("替换范围无效：起始位置大于结束位置".into());
    }
    let text_bytes = text.as_bytes();
    if text_bytes.len() as u64 > MAX_REPLACE_TEXT_BYTES {
        return Err(format!(
            "替换内容不能超过 {}MB",
            MAX_REPLACE_TEXT_BYTES / (1024 * 1024)
        ));
    }

    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    let file_size = metadata.len();
    if exceeds_patch_file_size_limit(file_size) {
        return Err(format!(
            "超过 100MB 的文件仅支持只读预览，无法编辑：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    if end > file_size {
        return Err(format!(
            "替换范围超出文件末尾：{}",
            display_file_name(&path)
        ));
    }

    let parent = file_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("qingcode");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let mut temp_path = None;
    for attempt in 0..10 {
        let candidate = parent.join(format!(".{file_name}.{nonce}.{attempt}.patch.tmp"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut out) => {
                let result = (|| -> Result<(), String> {
                    let mut src = File::open(file_path).map_err(|e| {
                        format!("读取文件失败：{}（{}）", display_file_name(&path), e)
                    })?;
                    if start > 0 {
                        copy(&mut Read::by_ref(&mut src).take(start), &mut out)
                            .map_err(|e| format!("写入临时文件失败：{}", e))?;
                    }
                    out.write_all(text_bytes)
                        .map_err(|e| format!("写入替换内容失败：{}", e))?;
                    if end < file_size {
                        src.seek(SeekFrom::Start(end)).map_err(|e| e.to_string())?;
                        copy(&mut src, &mut out).map_err(|e| format!("写入临时文件失败：{}", e))?;
                    }
                    out.sync_all()
                        .map_err(|e| format!("同步临时文件失败：{}", e))?;
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = fs::remove_file(&candidate);
                    return Err(error);
                }
                temp_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("创建临时文件失败：{}", error));
            }
        }
    }

    let temp_path = temp_path.ok_or_else(|| "无法创建临时文件".to_string())?;

    #[cfg(windows)]
    {
        if file_path.exists() {
            let backup_path = parent.join(format!(".{file_name}.{nonce}.patch.backup"));
            if let Err(error) = fs::rename(file_path, &backup_path) {
                let _ = fs::remove_file(&temp_path);
                return Err(format!("替换文件失败：{}", error));
            }
            if let Err(error) = fs::rename(&temp_path, file_path) {
                let _ = fs::rename(&backup_path, file_path);
                let _ = fs::remove_file(&temp_path);
                return Err(format!("替换文件失败：{}", error));
            }
            let _ = fs::remove_file(backup_path);
        } else if let Err(error) = fs::rename(&temp_path, file_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("替换文件失败：{}", error));
        }
    }

    #[cfg(not(windows))]
    {
        if let Err(error) = fs::rename(&temp_path, file_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(format!("替换文件失败：{}", error));
        }
    }

    let new_meta = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    Ok(super::cmd_stat::FileStat {
        size: new_meta.len(),
        is_dir: false,
    })
}

#[tauri::command]
pub fn create_file(
    parent: String,
    name: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let parent_path = Path::new(&parent);
    if !parent_path.is_dir() {
        return Err(format!("目录不可用: {}", parent));
    }
    let path = parent_path.join(&name);
    allowlist.ensure_writable(&path.to_string_lossy())?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("新建文件失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_directory(
    parent: String,
    name: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    validate_entry_name(&name)?;
    let parent_path = Path::new(&parent);
    if !parent_path.is_dir() {
        return Err(format!("目录不可用: {}", parent));
    }
    let path = parent_path.join(&name);
    allowlist.ensure_writable(&path.to_string_lossy())?;
    fs::create_dir(&path).map_err(|e| format!("新建文件夹失败: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rename_path(
    path: String,
    new_name: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    validate_entry_name(&new_name)?;
    allowlist.ensure_writable(&path)?;
    let source = Path::new(&path);
    let parent = source
        .parent()
        .ok_or_else(|| "无法重命名该路径".to_string())?;
    let target = parent.join(&new_name);
    allowlist.ensure_writable(&target.to_string_lossy())?;
    if target.exists() {
        return Err("目标名称已存在".to_string());
    }
    fs::rename(source, &target).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

fn unique_child_path(
    dest_dir: &Path,
    file_name: &std::ffi::OsStr,
) -> Result<std::path::PathBuf, String> {
    let mut candidate = dest_dir.join(file_name);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("item");
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    for i in 1..1000 {
        let name = if i == 1 {
            format!("{} - Copy{}", stem, ext)
        } else {
            format!("{} - Copy ({}){}", stem, i, ext)
        };
        candidate = dest_dir.join(&name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("无法生成可用的目标文件名".to_string())
}

fn copy_entry_recursive(source: &Path, target: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(source).map_err(|e| format!("读取源路径失败: {}", e))?;
    if meta.is_dir() {
        fs::create_dir(target).map_err(|e| format!("创建目标文件夹失败: {}", e))?;
        for entry in fs::read_dir(source).map_err(|e| format!("读取源文件夹失败: {}", e))? {
            let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
            let child_target = target.join(entry.file_name());
            copy_entry_recursive(&entry.path(), &child_target)?;
        }
        Ok(())
    } else {
        fs::copy(source, target).map_err(|e| format!("复制文件失败: {}", e))?;
        Ok(())
    }
}

fn remove_path_entry(target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(target).map_err(|e| format!("读取目标路径失败: {}", e))?;
    if metadata.is_dir() {
        fs::remove_dir_all(target).map_err(|e| format!("删除目标文件夹失败: {}", e))
    } else {
        fs::remove_file(target).map_err(|e| format!("删除目标文件失败: {}", e))
    }
}

/// Resolve destination child path.
/// `conflict_policy`: `overwrite` | `rename` | `fail` (default `fail` when omitted).
fn resolve_dest_child(
    dest: &Path,
    file_name: &std::ffi::OsStr,
    conflict_policy: Option<&str>,
) -> Result<(std::path::PathBuf, bool), String> {
    let preferred = dest.join(file_name);
    if !preferred.exists() {
        return Ok((preferred, false));
    }
    match conflict_policy.unwrap_or("fail") {
        "overwrite" => Ok((preferred, true)),
        "rename" => Ok((unique_child_path(dest, file_name)?, false)),
        "fail" => Err("目标名称已存在".to_string()),
        other => Err(format!("未知的冲突策略: {}", other)),
    }
}

fn resolve_transfer_file_name(
    source: &Path,
    dest_name: Option<&str>,
) -> Result<std::ffi::OsString, String> {
    if let Some(name) = dest_name {
        validate_entry_name(name)?;
        return Ok(std::ffi::OsString::from(name));
    }
    source
        .file_name()
        .map(|n| n.to_os_string())
        .ok_or_else(|| "无法解析源文件名".to_string())
}

/// Move a file or folder into `dest_dir`.
/// `dest_name`: optional new basename (IDEA-style rename-on-conflict).
#[tauri::command]
pub fn move_path(
    path: String,
    dest_dir: String,
    conflict_policy: Option<String>,
    dest_name: Option<String>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    allowlist.ensure_writable(&path)?;
    allowlist.ensure_writable(&dest_dir)?;
    let source = Path::new(&path);
    let dest = Path::new(&dest_dir);
    let dest_meta = fs::symlink_metadata(dest).map_err(|e| format!("读取目标文件夹失败: {}", e))?;
    if !dest_meta.is_dir() {
        return Err("目标不是文件夹".to_string());
    }
    let file_name = resolve_transfer_file_name(source, dest_name.as_deref())?;
    // Refuse moving a folder into itself / a descendant.
    if source.is_dir() {
        let src_norm = source
            .canonicalize()
            .unwrap_or_else(|_| source.to_path_buf());
        let dest_norm = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
        if dest_norm.starts_with(&src_norm) {
            return Err("不能将文件夹移动到其自身或子目录中".to_string());
        }
    }
    let (target, overwrite) = resolve_dest_child(dest, &file_name, conflict_policy.as_deref())?;
    allowlist.ensure_writable(&target.to_string_lossy())?;
    if overwrite {
        remove_path_entry(&target)?;
    }
    fs::rename(source, &target).map_err(|e| format!("移动失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

/// Copy a file or folder into `dest_dir` (recursive for directories).
/// `dest_name`: optional new basename (IDEA-style rename-on-conflict).
#[tauri::command]
pub fn copy_path_into(
    path: String,
    dest_dir: String,
    conflict_policy: Option<String>,
    dest_name: Option<String>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    allowlist.ensure_allowed(&path)?;
    allowlist.ensure_writable(&dest_dir)?;
    let source = Path::new(&path);
    let dest = Path::new(&dest_dir);
    let dest_meta = fs::symlink_metadata(dest).map_err(|e| format!("读取目标文件夹失败: {}", e))?;
    if !dest_meta.is_dir() {
        return Err("目标不是文件夹".to_string());
    }
    let file_name = resolve_transfer_file_name(source, dest_name.as_deref())?;
    if source.is_dir() {
        let src_norm = source
            .canonicalize()
            .unwrap_or_else(|_| source.to_path_buf());
        let dest_norm = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
        if dest_norm.starts_with(&src_norm) {
            return Err("不能将文件夹复制到其自身或子目录中".to_string());
        }
    }
    let (target, overwrite) = resolve_dest_child(dest, &file_name, conflict_policy.as_deref())?;
    allowlist.ensure_writable(&target.to_string_lossy())?;
    if overwrite {
        remove_path_entry(&target)?;
    }
    copy_entry_recursive(source, &target)?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_path(path: String, allowlist: State<'_, PathAllowlist>) -> Result<(), String> {
    allowlist.ensure_writable(&path)?;
    let target = Path::new(&path);
    let metadata = fs::symlink_metadata(target).map_err(|e| format!("读取路径失败: {}", e))?;
    if metadata.is_dir() {
        fs::remove_dir_all(target).map_err(|e| format!("删除文件夹失败: {}", e))
    } else {
        fs::remove_file(target).map_err(|e| format!("删除文件失败: {}", e))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryDeleteStats {
    pub path: String,
    pub file_count: u64,
    pub total_size: u64,
}

/// Walk a directory (without following dir symlinks) to gather cheap delete-confirm stats.
#[tauri::command]
pub fn directory_delete_stats(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<DirectoryDeleteStats, String> {
    allowlist.ensure_writable(&path)?;
    let target = Path::new(&path);
    let metadata = fs::symlink_metadata(target).map_err(|e| format!("读取路径失败: {}", e))?;
    if !metadata.is_dir() {
        return Err("路径不是文件夹".to_string());
    }

    let mut file_count = 0u64;
    let mut total_size = 0u64;
    collect_directory_delete_stats(target, &mut file_count, &mut total_size)?;

    Ok(DirectoryDeleteStats {
        path: display_path(target),
        file_count,
        total_size,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntryCounts {
    pub path: String,
    pub file_count: u64,
    pub folder_count: u64,
    pub total_size: u64,
}

/// Recursively count files/folders and sum file sizes (does not follow dir symlinks).
#[tauri::command]
pub fn directory_entry_counts(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<DirectoryEntryCounts, String> {
    allowlist.ensure_allowed(&path)?;
    let target = Path::new(&path);
    let metadata = fs::symlink_metadata(target).map_err(|e| format!("读取路径失败: {}", e))?;
    if !metadata.is_dir() {
        return Err("路径不是文件夹".to_string());
    }

    let mut file_count = 0u64;
    let mut folder_count = 0u64;
    let mut total_size = 0u64;
    collect_directory_entry_counts(target, &mut file_count, &mut folder_count, &mut total_size)?;

    Ok(DirectoryEntryCounts {
        path: display_path(target),
        file_count,
        folder_count,
        total_size,
    })
}

fn collect_directory_entry_counts(
    dir: &Path,
    file_count: &mut u64,
    folder_count: &mut u64,
    total_size: &mut u64,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {}", e))?;
        if file_type.is_dir() && !file_type.is_symlink() {
            *folder_count += 1;
            collect_directory_entry_counts(&entry.path(), file_count, folder_count, total_size)?;
        } else {
            *file_count += 1;
            if let Ok(meta) = entry.metadata() {
                *total_size = total_size.saturating_add(meta.len());
            }
        }
    }
    Ok(())
}

fn collect_directory_delete_stats(
    dir: &Path,
    file_count: &mut u64,
    total_size: &mut u64,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {}", e))?;
        if file_type.is_dir() && !file_type.is_symlink() {
            collect_directory_delete_stats(&entry.path(), file_count, total_size)?;
        } else {
            *file_count += 1;
            if let Ok(meta) = entry.metadata() {
                *total_size = total_size.saturating_add(meta.len());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkWriteCheck {
    pub needs_confirm: bool,
    pub resolved_path: Option<String>,
}

/// Detect whether writing `path` would follow a symlink to a target outside registered roots.
/// Uses the native allowlist (not caller-supplied roots). Fail closed on resolve errors.
#[tauri::command]
pub fn check_symlink_write(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<SymlinkWriteCheck, String> {
    check_symlink_write_inner(Path::new(&path), &allowlist)
}

fn check_symlink_write_inner(
    path: &Path,
    allowlist: &PathAllowlist,
) -> Result<SymlinkWriteCheck, String> {
    let outside = allowlist
        .with_state(|state| crate::path_guard::outside_symlink_write_target(path, state))??;
    match outside {
        None => Ok(SymlinkWriteCheck {
            needs_confirm: false,
            resolved_path: None,
        }),
        Some(resolved) => Ok(SymlinkWriteCheck {
            needs_confirm: true,
            resolved_path: Some(display_path(&resolved)),
        }),
    }
}

fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }
    raw.to_string()
}

/// Absolute path suitable for OS file-list clipboard (strip Windows `\\?\` prefix).
fn clipboard_file_path(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("路径不存在：{}", path.display()));
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("解析相对路径失败：{error}"))?
            .join(path)
    };
    let canonical = absolute.canonicalize().unwrap_or(absolute);
    Ok(PathBuf::from(display_path(&canonical)))
}

/// Write selected project files/folders onto the **system** clipboard as a file
/// list (`CF_HDROP` on Windows, file URLs on macOS) so Explorer / chat apps can paste.
#[tauri::command]
pub fn clipboard_write_files(
    paths: Vec<String>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("至少选择一个文件".to_string());
    }
    let mut resolved = Vec::with_capacity(paths.len());
    for path in &paths {
        allowlist.ensure_allowed(path)?;
        resolved.push(clipboard_file_path(Path::new(path))?);
    }
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("无法打开系统剪贴板：{error}"))?;
    clipboard
        .set()
        .file_list(&resolved)
        .map_err(|error| format!("写入系统剪贴板失败：{error}"))?;
    Ok(())
}

/// Write plain text to the OS clipboard (paths, references, etc.).
/// Prefer this over `navigator.clipboard` in WebView — keyboard shortcuts often
/// lack a transient user-activation grant and never reach the system clipboard.
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("无法打开系统剪贴板：{error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("写入系统剪贴板失败：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_write_replaces_existing_file_with_empty_content() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-write-test-{nonce}"));
        let path = dir.join("sample.txt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, "before").unwrap();

        write_file_safely(&path, b"").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replace_file_range_rewrites_middle() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-replace-test-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.txt");
        let body = "AAAOLDBBB";
        fs::write(&path, body).unwrap();
        let start = 3u64;
        let end = 6u64;
        let stat =
            replace_file_range_inner(path.to_string_lossy().to_string(), start, end, "NEW".into())
                .unwrap();
        let next = fs::read_to_string(&path).unwrap();
        assert_eq!(next, "AAANEWBBB");
        assert_eq!(stat.size, next.len() as u64);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_path_like_entry_names() {
        for name in ["", ".", "..", "a/b", "a\\b"] {
            assert!(
                validate_entry_name(name).is_err(),
                "{name:?} should be rejected"
            );
        }
        assert!(validate_entry_name("notes.md").is_ok());
    }

    #[test]
    fn directory_delete_stats_counts_nested_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-dir-stats-{nonce}"));
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("a.txt"), "hello").unwrap();
        fs::write(dir.join("nested/b.txt"), "world!!").unwrap();

        let mut file_count = 0u64;
        let mut total_size = 0u64;
        collect_directory_delete_stats(&dir, &mut file_count, &mut total_size).unwrap();
        assert_eq!(file_count, 2);
        assert_eq!(total_size, 12);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn directory_entry_counts_counts_nested_entries() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-dir-counts-{nonce}"));
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("a.txt"), "hello").unwrap();
        fs::write(dir.join("nested/b.txt"), "world!!").unwrap();

        let mut file_count = 0u64;
        let mut folder_count = 0u64;
        let mut total_size = 0u64;
        collect_directory_entry_counts(&dir, &mut file_count, &mut folder_count, &mut total_size)
            .unwrap();
        assert_eq!(file_count, 2);
        assert_eq!(folder_count, 1);
        assert_eq!(total_size, 12); // "hello" + "world!!"

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn check_symlink_write_skips_regular_file_inside_project() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-symlink-check-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.txt");
        fs::write(&file, "hi").unwrap();

        let allowlist = PathAllowlist::new();
        allowlist.sync_project_roots(vec![dir.to_string_lossy().to_string()]);
        let check = check_symlink_write_inner(&file, &allowlist).unwrap();
        assert!(!check.needs_confirm);
        assert!(check.resolved_path.is_none());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clipboard_write_text_roundtrips() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sample = format!("qingcode-clipboard-{nonce}");
        clipboard_write_text(sample.clone()).unwrap();
        let mut clipboard = arboard::Clipboard::new().unwrap();
        let got = clipboard.get_text().unwrap();
        assert_eq!(got, sample);
    }

    #[test]
    fn clipboard_file_path_rejects_missing() {
        let err = clipboard_file_path(Path::new("D:/definitely-missing-qingcode-xyz")).unwrap_err();
        assert!(err.contains("不存在"), "{err}");
    }

    #[test]
    fn clipboard_file_path_returns_existing_absolute() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-clip-path-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, "x").unwrap();

        let resolved = clipboard_file_path(&file).unwrap();
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("a.txt"));
        let text = resolved.to_string_lossy();
        assert!(!text.starts_with(r"\\?\"), "{text}");

        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn check_symlink_write_flags_symlink_outside_project() {
        use std::os::unix::fs::symlink;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("qingcode-symlink-out-{nonce}"));
        let project = base.join("project");
        let outside = base.join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join("secret.txt");
        fs::write(&target, "secret").unwrap();
        let link = project.join("alias.txt");
        symlink(&target, &link).unwrap();

        let allowlist = PathAllowlist::new();
        allowlist.sync_project_roots(vec![project.to_string_lossy().to_string()]);
        let check = check_symlink_write_inner(&link, &allowlist).unwrap();
        assert!(check.needs_confirm);
        assert!(
            check
                .resolved_path
                .as_deref()
                .is_some_and(|p| p.ends_with("secret.txt")),
            "{:?}",
            check.resolved_path
        );

        fs::remove_dir_all(base).unwrap();
    }
}
