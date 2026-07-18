use crate::file_encoding;
use crate::path_guard::PathAllowlist;
use serde::Serialize;
use std::fs;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::State;

/// Max bytes returned by a single `read_file_slice` call.
const MAX_SLICE_BYTES: u64 = 256 * 1024;
/// Pure read-only slice viewer hard cap.
const MAX_VIEWER_FILE_SIZE: u64 = 500 * 1024 * 1024;
/// Full-buffer `read_file` / `write_file` budget (plain-text CodeMirror up to this size).
const MAX_EDITOR_FILE_SIZE: u64 = 100 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct FileStat {
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub struct FileSlice {
    pub offset: u64,
    pub len: u64,
    pub text: String,
    pub eof: bool,
    pub file_size: u64,
}

/// Result of streaming scan for a 1-based line start offset.
#[derive(Debug, Serialize)]
pub struct LineOffsetResult {
    /// Requested 1-based line number.
    pub line: u64,
    /// Byte offset of the start of that line (or last line when not found).
    pub offset: u64,
    /// True when the requested line exists.
    pub found: bool,
    /// Total lines counted (full file when `!found` or scan completed).
    pub total_lines: u64,
    pub file_size: u64,
}

fn exceeds_editor_file_size_limit(size: u64) -> bool {
    size > MAX_EDITOR_FILE_SIZE
}

fn exceeds_viewer_file_size_limit(size: u64) -> bool {
    size > MAX_VIEWER_FILE_SIZE
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
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "bmp"
        | "woff" | "woff2" | "ttf" | "otf" | "eot" | "pdf"
        | "zip" | "gz" | "tar" | "7z" | "rar" | "exe" | "dll"
        | "so" | "dylib" | "bin" | "mp3" | "mp4" | "avi"
        | "mov" | "mkv" | "wasm" | "lock" | "map" | "pyc"
        | "pyo" | "pyd" | "class" | "o" | "obj" | "typed"
        | "xlsx" | "xlsm" | "xls" | "docx" | "doc"
        | "pptx" | "ppt" | "odt" | "ods" | "odp"
        | "numbers" | "pages" | "key" | "sqlite" | "db" | "7zip"
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

fn decode_error_message(path: &str, encoding: file_encoding::FileEncoding) -> String {
    format!(
        "暂不支持打开非文本或无法按 {} 解码的文件：{}",
        encoding.as_str(),
        display_file_name(path)
    )
}

#[tauri::command]
pub fn file_stat(path: String, allowlist: State<'_, PathAllowlist>) -> Result<FileStat, String> {
    allowlist.ensure_allowed(&path)?;
    file_stat_inner(path)
}

fn file_stat_inner(path: String) -> Result<FileStat, String> {
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    Ok(FileStat {
        size: metadata.len(),
        is_dir: metadata.is_dir(),
    })
}

#[tauri::command]
pub fn read_file(
    path: String,
    encoding: Option<String>,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    allowlist.ensure_allowed(&path)?;
    read_file_inner(path, encoding.as_deref())
}

#[tauri::command]
pub fn detect_file_encoding(
    path: String,
    allowlist: State<'_, PathAllowlist>,
) -> Result<String, String> {
    allowlist.ensure_allowed(&path)?;
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    if exceeds_editor_file_size_limit(metadata.len()) {
        return Err(format!(
            "暂不支持在编辑器中打开超过 100MB 的文件（可用只读预览打开至 500MB）：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    // 只读取前 8KB 进行编码检测，避免大文件全量读取
    const DETECT_BYTES: usize = 8192;
    let mut file = std::fs::File::open(file_path)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
    let mut buf = vec![0u8; DETECT_BYTES];
    let n = std::io::Read::read(&mut file, &mut buf)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
    buf.truncate(n);
    file_encoding::detect(&buf)
        .map(|encoding| encoding.as_str().to_string())
        .map_err(|_| unsupported_text_file_message(&path))
}

fn read_file_inner(path: String, encoding: Option<&str>) -> Result<String, String> {
    let enc = file_encoding::parse(encoding);
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    if exceeds_editor_file_size_limit(metadata.len()) {
        return Err(format!(
            "暂不支持在编辑器中打开超过 100MB 的文件（可用只读预览打开至 500MB）：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    let bytes = fs::read(file_path)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
    file_encoding::decode(&bytes, enc).map_err(|_| decode_error_message(&path, enc))
}

#[tauri::command]
pub fn read_file_slice(
    path: String,
    offset: u64,
    max_bytes: u64,
    allowlist: State<'_, PathAllowlist>,
) -> Result<FileSlice, String> {
    allowlist.ensure_allowed(&path)?;
    read_file_slice_inner(path, offset, max_bytes)
}

fn read_file_slice_inner(path: String, offset: u64, max_bytes: u64) -> Result<FileSlice, String> {
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    let file_size = metadata.len();
    if exceeds_viewer_file_size_limit(file_size) {
        return Err(format!(
            "暂不支持打开超过 500MB 的大文件：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }
    if offset > file_size {
        return Err(format!(
            "读取偏移超出文件范围：{}",
            display_file_name(&path)
        ));
    }

    let want = max_bytes.clamp(1, MAX_SLICE_BYTES);
    let available = file_size - offset;
    let to_read = want.min(available) as usize;

    let mut file = File::open(file_path)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;

    let mut buf = vec![0u8; to_read];
    let mut read_total = 0usize;
    while read_total < to_read {
        match file.read(&mut buf[read_total..]) {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(e) => {
                return Err(format!(
                    "读取文件失败：{}（{}）",
                    display_file_name(&path),
                    e
                ))
            }
        }
    }
    buf.truncate(read_total);

    // Avoid splitting a UTF-8 codepoint at the end of the window.
    let end = trim_utf8_end(&buf);
    buf.truncate(end);

    let text = String::from_utf8_lossy(&buf).into_owned();
    let len = buf.len() as u64;
    let eof = offset + len >= file_size;

    Ok(FileSlice {
        offset,
        len,
        text,
        eof,
        file_size,
    })
}

/// Streaming newline scan: return the byte offset of a 1-based line without loading the file.
#[tauri::command]
pub fn find_line_offset(
    path: String,
    line: u64,
    allowlist: State<'_, PathAllowlist>,
) -> Result<LineOffsetResult, String> {
    allowlist.ensure_allowed(&path)?;
    find_line_offset_inner(path, line)
}

fn find_line_offset_inner(path: String, line: u64) -> Result<LineOffsetResult, String> {
    if line == 0 {
        return Err("行号必须从 1 开始".into());
    }

    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("无法访问文件 {}: {}", display_file_name(&path), e))?;
    if metadata.is_dir() {
        return Err(format!("无法打开文件夹：{}", display_file_name(&path)));
    }
    let file_size = metadata.len();
    if exceeds_viewer_file_size_limit(file_size) {
        return Err(format!(
            "暂不支持打开超过 500MB 的大文件：{}",
            display_file_name(&path)
        ));
    }
    if is_binary_extension(&path) {
        return Err(unsupported_text_file_message(&path));
    }

    if file_size == 0 {
        return Ok(LineOffsetResult {
            line,
            offset: 0,
            found: line == 1,
            total_lines: 0,
            file_size: 0,
        });
    }

    if line == 1 {
        // Still count total lines for UI feedback when useful — cheap enough for jump-to-1.
        // Skip full count for line 1 to keep first jump fast on huge files.
        return Ok(LineOffsetResult {
            line: 1,
            offset: 0,
            found: true,
            total_lines: 1,
            file_size,
        });
    }

    let mut file = File::open(file_path)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;

    const BUF_SIZE: usize = 64 * 1024;
    let mut buf = [0u8; BUF_SIZE];
    let mut current_line: u64 = 1;
    let mut file_pos: u64 = 0;
    let mut last_line_offset: u64 = 0;

    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
        if n == 0 {
            break;
        }
        for (i, &b) in buf[..n].iter().enumerate() {
            if b == b'\n' {
                let next_offset = file_pos + i as u64 + 1;
                current_line += 1;
                last_line_offset = next_offset;
                if current_line == line {
                    return Ok(LineOffsetResult {
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

    // File ended without reaching `line`. If it does not end with `\n`, the last
    // partial line still counts (already in current_line).
    let total_lines = if file_size > 0 { current_line } else { 0 };
    Ok(LineOffsetResult {
        line,
        offset: last_line_offset.min(file_size),
        found: false,
        total_lines,
        file_size,
    })
}

/// Truncate `buf` so it ends on a UTF-8 character boundary (may shorten by ≤3 bytes).
fn trim_utf8_end(buf: &[u8]) -> usize {
    if buf.is_empty() {
        return 0;
    }
    let mut i = buf.len();
    while i > 0 && (buf[i - 1] & 0b1100_0000) == 0b1000_0000 {
        i -= 1;
        if buf.len() - i > 3 {
            return buf.len();
        }
    }
    if i == 0 {
        return 0;
    }
    let lead = buf[i - 1];
    let need = utf8_char_len(lead);
    let have = buf.len() - (i - 1);
    if have < need {
        i - 1
    } else {
        buf.len()
    }
}

fn utf8_char_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead & 0b1110_0000 == 0b1100_0000 {
        2
    } else if lead & 0b1111_0000 == 0b1110_0000 {
        3
    } else if lead & 0b1111_1000 == 0b1111_0000 {
        4
    } else {
        1
    }
}
