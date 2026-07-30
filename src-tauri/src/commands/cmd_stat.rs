use crate::file_encoding;
use crate::path_guard::PathAllowlist;
use serde::Serialize;
use std::fs;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::State;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TextReadMode {
    Auto,
    Compatibility,
    Native,
}

impl TextReadMode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "compatible" => Some(Self::Compatibility),
            "native" => Some(Self::Native),
            _ => None,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Auto => 0,
            Self::Compatibility => 1,
            Self::Native => 2,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            value if value == Self::Compatibility.as_u8() => Self::Compatibility,
            value if value == Self::Native.as_u8() => Self::Native,
            _ => Self::Auto,
        }
    }
}

static TEXT_READ_MODE: AtomicU8 = AtomicU8::new(0);

const AUTO_READ_ATTEMPTS: [TextReadMode; 2] = [TextReadMode::Native, TextReadMode::Compatibility];
const COMPATIBILITY_READ_ATTEMPT: [TextReadMode; 1] = [TextReadMode::Compatibility];
const NATIVE_READ_ATTEMPT: [TextReadMode; 1] = [TextReadMode::Native];

fn text_read_attempts(mode: TextReadMode) -> &'static [TextReadMode] {
    match mode {
        TextReadMode::Auto => &AUTO_READ_ATTEMPTS,
        TextReadMode::Compatibility => &COMPATIBILITY_READ_ATTEMPT,
        TextReadMode::Native => &NATIVE_READ_ATTEMPT,
    }
}

fn streaming_text_read_mode(mode: TextReadMode) -> TextReadMode {
    match mode {
        // A slice after offset 0 cannot be reliably classified as text/ciphertext.
        // Prefer the transparent-encryption-compatible path for streaming views.
        TextReadMode::Auto => TextReadMode::Compatibility,
        explicit => explicit,
    }
}

fn current_text_read_mode() -> TextReadMode {
    TextReadMode::from_u8(TEXT_READ_MODE.load(Ordering::Relaxed))
}

#[tauri::command]
pub fn set_text_read_mode(mode: String) -> Result<(), String> {
    let mode = TextReadMode::parse(&mode)
        .ok_or_else(|| format!("不支持的 Windows 文件读取模式：{mode}"))?;
    TEXT_READ_MODE.store(mode.as_u8(), Ordering::Relaxed);
    Ok(())
}

/**
 * Compatibility mode matches Qt's QFile / Notepad-- Windows share mode.
 *
 * Native mode deliberately retains Rust's original File::open behaviour,
 * including its READ | WRITE | DELETE sharing on Windows.
 */
fn open_text_file_for_read(path: &Path, mode: TextReadMode) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        if mode == TextReadMode::Native {
            return File::open(path);
        }

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
    }

    #[cfg(not(windows))]
    {
        let _ = mode;
        File::open(path)
    }
}

/**
 * Compatibility mode reads through kernel32 `ReadFile`, matching Qt's QFile.
 *
 * Native mode deliberately uses Rust's standard `File::read`; Rust 1.97 calls
 * `NtReadFile` directly on Windows. Keeping both paths allows users to select
 * the one compatible with their filesystem / transparent-encryption software.
 */
fn read_text_file_chunk(
    file: &mut File,
    buf: &mut [u8],
    mode: TextReadMode,
) -> std::io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::ReadFile;

        if mode == TextReadMode::Native {
            return file.read(buf);
        }

        let len = buf.len().min(u32::MAX as usize) as u32;
        let mut read = 0u32;
        let result = unsafe {
            ReadFile(
                file.as_raw_handle(),
                buf.as_mut_ptr().cast(),
                len,
                &mut read,
                std::ptr::null_mut(),
            )
        };
        if result == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(read as usize)
        }
    }

    #[cfg(not(windows))]
    {
        let _ = mode;
        file.read(buf)
    }
}

fn read_text_file_to_end(
    file: &mut File,
    capacity: usize,
    mode: TextReadMode,
) -> std::io::Result<Vec<u8>> {
    const BUFFER_BYTES: usize = 64 * 1024;
    let mut bytes = Vec::with_capacity(capacity);
    let mut buf = [0u8; BUFFER_BYTES];
    loop {
        let read = read_text_file_chunk(file, &mut buf, mode)?;
        if read == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buf[..read]);
    }
}

fn read_text_file_bytes(
    path: &Path,
    capacity: usize,
    mode: TextReadMode,
) -> std::io::Result<Vec<u8>> {
    let mut file = open_text_file_for_read(path, mode)?;
    read_text_file_to_end(&mut file, capacity, mode)
}

fn read_text_file_prefix(
    path: &Path,
    max_bytes: usize,
    mode: TextReadMode,
) -> std::io::Result<Vec<u8>> {
    let mut file = open_text_file_for_read(path, mode)?;
    let mut buf = vec![0u8; max_bytes];
    let read = read_text_file_chunk(&mut file, &mut buf, mode)?;
    buf.truncate(read);
    Ok(buf)
}

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
    let read_mode = current_text_read_mode();
    let mut last_error = None;
    for &attempt in text_read_attempts(read_mode) {
        let buf = match read_text_file_prefix(file_path, DETECT_BYTES, attempt) {
            Ok(buf) => buf,
            Err(error) => {
                last_error = Some(format!(
                    "读取文件失败：{}（{}）",
                    display_file_name(&path),
                    error
                ));
                continue;
            }
        };
        match file_encoding::detect(&buf) {
            Ok(encoding) => return Ok(encoding.as_str().to_string()),
            Err(reason) => {
                last_error = Some(format!(
                    "无法识别文件编码（{}）：{}",
                    reason,
                    display_file_name(&path)
                ));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| format!("无法读取文件：{}", display_file_name(&path))))
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
    let read_mode = current_text_read_mode();
    let mut last_error = None;
    for &attempt in text_read_attempts(read_mode) {
        let bytes = match read_text_file_bytes(file_path, metadata.len() as usize, attempt) {
            Ok(bytes) => bytes,
            Err(error) => {
                last_error = Some(format!(
                    "读取文件失败：{}（{}）",
                    display_file_name(&path),
                    error
                ));
                continue;
            }
        };
        match file_encoding::decode(&bytes, enc) {
            Ok(content) => return Ok(content),
            Err(_) => last_error = Some(decode_error_message(&path, enc)),
        }
    }
    Err(last_error.unwrap_or_else(|| decode_error_message(&path, enc)))
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

    let read_mode = streaming_text_read_mode(current_text_read_mode());
    let mut file = open_text_file_for_read(file_path, read_mode)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;

    let mut buf = vec![0u8; to_read];
    let mut read_total = 0usize;
    while read_total < to_read {
        match read_text_file_chunk(&mut file, &mut buf[read_total..], read_mode) {
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

    let read_mode = streaming_text_read_mode(current_text_read_mode());
    let mut file = open_text_file_for_read(file_path, read_mode)
        .map_err(|e| format!("读取文件失败：{}（{}）", display_file_name(&path), e))?;

    const BUF_SIZE: usize = 64 * 1024;
    let mut buf = [0u8; BUF_SIZE];
    let mut current_line: u64 = 1;
    let mut file_pos: u64 = 0;
    let mut last_line_offset: u64 = 0;

    loop {
        let n = read_text_file_chunk(&mut file, &mut buf, read_mode)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-stat-{label}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(windows)]
    #[test]
    fn text_reader_matches_qt_share_mode_without_delete_sharing() {
        let dir = temp_dir("share-mode");
        let path = dir.join("plain.txt");
        fs::write(&path, b"plain text").unwrap();

        let mode = TextReadMode::Compatibility;
        let mut reader = open_text_file_for_read(&path, mode).unwrap();
        let bytes = read_text_file_to_end(&mut reader, 10, mode).unwrap();
        assert_eq!(bytes, b"plain text");

        // QFile permits concurrent readers/writers but omits FILE_SHARE_DELETE.
        let writer = fs::OpenOptions::new().write(true).open(&path).unwrap();
        drop(writer);
        assert!(
            fs::remove_file(&path).is_err(),
            "an open Qt-compatible reader must not share delete access"
        );

        drop(reader);
        fs::remove_file(path).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn native_text_reader_retains_rust_default_delete_sharing() {
        let dir = temp_dir("native-share-mode");
        let path = dir.join("plain.txt");
        fs::write(&path, b"plain text").unwrap();

        let mode = TextReadMode::Native;
        let mut reader = open_text_file_for_read(&path, mode).unwrap();
        let bytes = read_text_file_to_end(&mut reader, 10, mode).unwrap();
        assert_eq!(bytes, b"plain text");

        fs::remove_file(&path).expect("Rust's native reader shares delete access");
        drop(reader);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parses_supported_text_read_modes() {
        assert_eq!(TextReadMode::parse("auto"), Some(TextReadMode::Auto));
        assert_eq!(
            TextReadMode::parse("compatible"),
            Some(TextReadMode::Compatibility)
        );
        assert_eq!(TextReadMode::parse("native"), Some(TextReadMode::Native));
        assert_eq!(TextReadMode::parse("other"), None);
    }

    #[test]
    fn auto_mode_tries_native_then_compatibility() {
        assert_eq!(
            text_read_attempts(TextReadMode::Auto),
            &[TextReadMode::Native, TextReadMode::Compatibility]
        );
        assert_eq!(
            streaming_text_read_mode(TextReadMode::Auto),
            TextReadMode::Compatibility
        );
    }

    /// Scripts touched by DLP / transparent-encryption agents carry a marker
    /// block; other viewers display them, so the editor open path must too.
    #[test]
    fn read_file_opens_script_with_a_marker_block_past_the_head() {
        let dir = temp_dir("marker");
        let path = dir.join("install.sh");
        let mut bytes = b"#!/bin/bash\nset -euo pipefail\necho install\n".repeat(20);
        bytes.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        bytes.extend_from_slice(b"\n# tail\n");
        fs::write(&path, &bytes).unwrap();

        let text = read_file_inner(path.to_string_lossy().to_string(), Some("auto")).unwrap();
        assert!(text.starts_with("#!/bin/bash"));
        assert!(text.contains('\0'));
        fs::remove_dir_all(dir).unwrap();
    }

    /// Bytes the editor cannot decode are still previewable through the slice
    /// viewer, which backs the error pane's read-only "open anyway" action.
    #[test]
    fn slice_viewer_previews_bytes_the_editor_rejects() {
        let dir = temp_dir("lossy");
        let path = dir.join("tagged.sh");
        let mut bytes = b"#!/bin/sh\necho hello\n".to_vec();
        bytes.extend_from_slice(&[0xFF, 0x00, 0xFE]);
        fs::write(&path, &bytes).unwrap();
        let path = path.to_string_lossy().to_string();

        assert!(read_file_inner(path.clone(), Some("auto")).is_err());

        let slice = read_file_slice_inner(path, 0, 64 * 1024).unwrap();
        assert!(slice.text.starts_with("#!/bin/sh"));
        assert!(
            slice.text.contains('\u{FFFD}'),
            "undecodable bytes become U+FFFD"
        );
        assert!(slice.eof);
        fs::remove_dir_all(dir).unwrap();
    }
}
