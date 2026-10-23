//! OS clipboard files and images for SSH paste/upload.
//!
//! Windows screenshots and chat apps usually put a PNG or DIB on the clipboard,
//! not a file list. Shell copies often expose `CF_HDROP` only through
//! `OleGetClipboard`. Both are turned into local paths the uploader can read.

use std::path::{Path, PathBuf};

pub fn read_clipboard_paths() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("qingcode-clipboard".into())
            .spawn(move || {
                let _ = tx.send(read_windows_clipboard());
            })
            .map_err(|error| format!("无法读取剪贴板：{error}"))?;
        rx.recv()
            .map_err(|error| format!("无法读取剪贴板：{error}"))
    }
    #[cfg(not(windows))]
    {
        arboard_paths()
    }
}

#[cfg(not(windows))]
fn arboard_paths() -> Result<Vec<String>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("无法打开系统剪贴板：{error}"))?;
    match clipboard.get().file_list() {
        Ok(paths) => Ok(normalize_paths(paths)),
        Err(arboard::Error::ContentNotAvailable) | Err(arboard::Error::ConversionFailure) => {
            Ok(Vec::new())
        }
        Err(error) => Err(format!("读取剪贴板文件失败：{error}")),
    }
}

fn normalize_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| normalize_path(&path))
        .filter(|path| !path.trim().is_empty())
        .collect()
}

fn normalize_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return stripped.to_string();
    }
    raw.into_owned()
}

#[cfg(windows)]
fn read_windows_clipboard() -> Vec<String> {
    // Ctrl+V can still be holding the clipboard inside the webview. Retry
    // instead of treating a busy clipboard as empty.
    for _ in 0..20 {
        let files = ole_hdrop_paths();
        if !files.is_empty() {
            return normalize_paths(files);
        }
        match read_open_clipboard() {
            None => std::thread::sleep(std::time::Duration::from_millis(25)),
            Some(paths) => return paths,
        }
    }
    Vec::new()
}

#[cfg(windows)]
fn ole_hdrop_paths() -> Vec<PathBuf> {
    const S_OK: i32 = 0;
    const S_FALSE: i32 = 1;
    const CF_HDROP: u16 = 15;
    const DVASPECT_CONTENT: u32 = 1;
    const TYMED_HGLOBAL: u32 = 1;

    #[link(name = "ole32")]
    extern "system" {
        fn OleInitialize(reserved: *mut core::ffi::c_void) -> i32;
        fn OleUninitialize();
        fn OleGetClipboard(data_object: *mut *mut core::ffi::c_void) -> i32;
        fn ReleaseStgMedium(medium: *mut StgMedium);
    }

    #[repr(C)]
    struct FormatEtc {
        cf_format: u16,
        target_device: *mut core::ffi::c_void,
        aspect: u32,
        index: i32,
        tymed: u32,
    }

    #[repr(C)]
    struct StgMedium {
        tymed: u32,
        data: *mut core::ffi::c_void,
        unknown: *mut core::ffi::c_void,
    }

    type GetData =
        unsafe extern "system" fn(*mut core::ffi::c_void, *const FormatEtc, *mut StgMedium) -> i32;
    type Release = unsafe extern "system" fn(*mut core::ffi::c_void) -> u32;

    unsafe fn com_slot<T: Copy>(object: *mut core::ffi::c_void, index: usize) -> T {
        let table = *(object as *const *const T);
        *table.add(index)
    }

    unsafe {
        let init = OleInitialize(std::ptr::null_mut());
        let balanced = init == S_OK || init == S_FALSE;
        let paths = (|| {
            let mut object = std::ptr::null_mut();
            if OleGetClipboard(&mut object) != S_OK || object.is_null() {
                return Vec::new();
            }
            let get_data = com_slot::<GetData>(object, 3);
            let release = com_slot::<Release>(object, 2);
            let format = FormatEtc {
                cf_format: CF_HDROP,
                target_device: std::ptr::null_mut(),
                aspect: DVASPECT_CONTENT,
                index: -1,
                tymed: TYMED_HGLOBAL,
            };
            let mut medium = StgMedium {
                tymed: 0,
                data: std::ptr::null_mut(),
                unknown: std::ptr::null_mut(),
            };
            let hr = get_data(object, &format, &mut medium);
            let paths = if hr == S_OK && !medium.data.is_null() {
                hdrop_paths(medium.data)
            } else {
                Vec::new()
            };
            if hr == S_OK {
                ReleaseStgMedium(&mut medium);
            }
            release(object);
            paths
        })();
        if balanced {
            OleUninitialize();
        }
        paths
    }
}

/// `None` when the clipboard is busy and the caller should retry.
#[cfg(windows)]
fn read_open_clipboard() -> Option<Vec<String>> {
    const CF_HDROP: u32 = 15;
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(owner: *mut core::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> *mut core::ffi::c_void;
    }

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        struct Close;
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe { CloseClipboard() };
            }
        }
        let _close = Close;

        let hdrop = GetClipboardData(CF_HDROP);
        if !hdrop.is_null() {
            let files = normalize_paths(hdrop_paths(hdrop));
            if !files.is_empty() {
                return Some(files);
            }
        }
        if let Some(path) = wide_clipboard_text(register_format("FileNameW")) {
            return Some(vec![path]);
        }
        if let Some(path) = image_clipboard_file(register_format("PNG"), "png", png_payload) {
            return Some(vec![path]);
        }
        for format in [CF_DIBV5, CF_DIB] {
            if let Some(path) = image_clipboard_file(format, "bmp", dib_to_bmp) {
                return Some(vec![path]);
            }
        }
        Some(Vec::new())
    }
}

#[cfg(windows)]
fn register_format(name: &str) -> u32 {
    #[link(name = "user32")]
    extern "system" {
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
    }
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    wide.push(0);
    unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
}

#[cfg(windows)]
fn wide_clipboard_text(format: u32) -> Option<String> {
    if format == 0 {
        return None;
    }
    let bytes = clipboard_bytes(format)?;
    if bytes.len() < 2 {
        return None;
    }
    let mut units = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let unit = u16::from_le_bytes([chunk[0], chunk[1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    let text = String::from_utf16_lossy(&units);
    let trimmed = text.trim().trim_start_matches(r"\\?\").trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(windows)]
fn image_clipboard_file(
    format: u32,
    extension: &str,
    decode: impl FnOnce(&[u8]) -> Option<Vec<u8>>,
) -> Option<String> {
    if format == 0 {
        return None;
    }
    let raw = clipboard_bytes(format)?;
    let encoded = decode(&raw)?;
    write_clipboard_bytes(extension, &encoded).map(|path| normalize_path(&path))
}

#[cfg(windows)]
fn clipboard_bytes(format: u32) -> Option<Vec<u8>> {
    #[link(name = "user32")]
    extern "system" {
        fn GetClipboardData(format: u32) -> *mut core::ffi::c_void;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalLock(memory: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
        fn GlobalUnlock(memory: *mut core::ffi::c_void) -> i32;
        fn GlobalSize(memory: *mut core::ffi::c_void) -> usize;
    }
    unsafe {
        let data = GetClipboardData(format);
        if data.is_null() {
            return None;
        }
        let size = GlobalSize(data);
        if size == 0 {
            return None;
        }
        let locked = GlobalLock(data);
        if locked.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(locked as *const u8, size).to_vec();
        GlobalUnlock(data);
        Some(bytes)
    }
}

#[cfg(windows)]
fn hdrop_paths(hdrop: *mut core::ffi::c_void) -> Vec<PathBuf> {
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(
            hdrop: *mut core::ffi::c_void,
            index: u32,
            file: *mut u16,
            chars: u32,
        ) -> u32;
    }
    unsafe {
        let count = DragQueryFileW(hdrop, u32::MAX, std::ptr::null_mut(), 0);
        let mut paths = Vec::with_capacity(count as usize);
        for index in 0..count {
            let chars = DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0);
            if chars == 0 {
                continue;
            }
            let mut buffer = vec![0u16; chars as usize + 1];
            let written = DragQueryFileW(hdrop, index, buffer.as_mut_ptr(), buffer.len() as u32);
            if written == 0 {
                continue;
            }
            buffer.truncate(written as usize);
            let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer));
            if !path.as_os_str().is_empty() {
                paths.push(path);
            }
        }
        paths
    }
}

/// Same image bytes keep the same temp path, so an in-app copy is not mistaken
/// for a newer system clipboard just because the paste was read twice.
#[cfg(windows)]
fn write_clipboard_bytes(extension: &str, bytes: &[u8]) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("qingcode-clipboard");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("paste-{:016x}.{extension}", fnv64(bytes)));
    if !path.is_file() {
        std::fs::write(&path, bytes).ok()?;
    }
    Some(path)
}

#[cfg(windows)]
fn fnv64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Drop the allocator padding after the IEND chunk so the temp file stays a PNG.
#[cfg(windows)]
fn png_payload(bytes: &[u8]) -> Option<Vec<u8>> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let end = bytes
        .windows(12)
        .position(|window| &window[4..8] == b"IEND")
        .map(|index| index + 12)
        .unwrap_or(bytes.len());
    Some(bytes[..end.min(bytes.len())].to_vec())
}

/// Wrap a clipboard DIB (`CF_DIB` / `CF_DIBV5`) in a `BITMAPFILEHEADER`.
#[cfg(windows)]
fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let header_size = u32::from_le_bytes(dib[0..4].try_into().ok()?) as usize;
    if header_size < 40 || dib.len() < header_size {
        return None;
    }
    let bit_count = u16::from_le_bytes(dib[14..16].try_into().ok()?);
    let compression = u32::from_le_bytes(dib[16..20].try_into().ok()?);
    let colors_used = u32::from_le_bytes(dib[32..36].try_into().ok()?);
    let palette = if header_size > 40 {
        0
    } else if bit_count <= 8 {
        let colors = if colors_used == 0 {
            1usize << bit_count
        } else {
            colors_used as usize
        };
        colors.saturating_mul(4)
    } else if compression == 3 {
        12
    } else {
        0
    };
    let offset = 14usize.saturating_add(header_size).saturating_add(palette);
    let mut bmp = Vec::with_capacity(14 + dib.len());
    bmp.extend_from_slice(&0x4D42u16.to_le_bytes());
    bmp.extend_from_slice(&(14u32.saturating_add(dib.len() as u32)).to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&(offset as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    Some(bmp)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn wraps_24bit_dib_as_bmp() {
        let mut dib = vec![0u8; 44];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&1u32.to_le_bytes());
        dib[8..12].copy_from_slice(&1i32.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        let bmp = dib_to_bmp(&dib).unwrap();
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 14 + 40);
        assert!(bmp.len() > 14);
    }

    #[test]
    fn reads_hdrop_roundtrip_and_restores_previous_files() {
        let previous = read_clipboard_paths().unwrap_or_default();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("qingcode-clip-hdrop-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.txt");
        fs::write(&file, "hi").unwrap();

        let mut clipboard = arboard::Clipboard::new().unwrap();
        clipboard.set().file_list(&[file.as_path()]).unwrap();
        let got = read_clipboard_paths().unwrap();

        if previous.is_empty() {
            let _ = clipboard.clear();
        } else {
            let restore: Vec<&Path> = previous.iter().map(Path::new).collect();
            let _ = clipboard.set().file_list(&restore);
        }
        fs::remove_dir_all(&dir).unwrap();

        assert!(got.iter().any(|path| path.ends_with("note.txt")), "{got:?}");
    }

    #[test]
    fn reads_png_clipboard_as_stable_temp_file() {
        const PNG: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
            0x02, 0xFE, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let previous = read_clipboard_paths().unwrap_or_default();
        set_png_clipboard(PNG);
        let first = read_clipboard_paths().unwrap();
        let second = read_clipboard_paths().unwrap();
        if previous.is_empty() {
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let _ = clipboard.clear();
            }
        } else {
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let restore: Vec<&Path> = previous.iter().map(Path::new).collect();
                let _ = clipboard.set().file_list(&restore);
            }
        }

        assert_eq!(first, second, "{first:?}");
        let path = first.first().expect("png path");
        assert!(path.ends_with(".png"), "{path}");
        assert_eq!(&fs::read(path).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
    }

    fn set_png_clipboard(bytes: &[u8]) {
        #[link(name = "user32")]
        extern "system" {
            fn OpenClipboard(owner: *mut core::ffi::c_void) -> i32;
            fn CloseClipboard() -> i32;
            fn EmptyClipboard() -> i32;
            fn SetClipboardData(
                format: u32,
                memory: *mut core::ffi::c_void,
            ) -> *mut core::ffi::c_void;
            fn RegisterClipboardFormatW(name: *const u16) -> u32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalAlloc(flags: u32, bytes: usize) -> *mut core::ffi::c_void;
            fn GlobalLock(memory: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
            fn GlobalUnlock(memory: *mut core::ffi::c_void) -> i32;
        }
        const GMEM_MOVEABLE: u32 = 0x0002;
        unsafe {
            let mut name: Vec<u16> = "PNG".encode_utf16().collect();
            name.push(0);
            let format = RegisterClipboardFormatW(name.as_ptr());
            assert!(format != 0);
            assert!(OpenClipboard(std::ptr::null_mut()) != 0);
            assert!(EmptyClipboard() != 0);
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            assert!(!memory.is_null());
            let locked = GlobalLock(memory);
            assert!(!locked.is_null());
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), locked as *mut u8, bytes.len());
            GlobalUnlock(memory);
            assert!(!SetClipboardData(format, memory).is_null());
            CloseClipboard();
        }
    }
}
