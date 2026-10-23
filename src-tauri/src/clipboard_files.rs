//! OS clipboard file lists.
//!
//! On Windows, shell and clipboard-manager copies (Explorer, WeType, screenshots)
//! often expose `CF_HDROP` only through `OleGetClipboard`. `GetClipboardData` then
//! reports the format as missing, so a paste looks like an empty clipboard.

use std::path::{Path, PathBuf};

pub fn read_clipboard_paths() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let ole = ole_hdrop_paths();
        if !ole.is_empty() {
            return Ok(normalize_paths(ole));
        }
    }

    let from_board = arboard_paths()?;
    if !from_board.is_empty() {
        return Ok(from_board);
    }

    #[cfg(windows)]
    if let Some(path) = filenamew_path() {
        return Ok(vec![path]);
    }

    Ok(Vec::new())
}

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
fn ole_hdrop_paths() -> Vec<PathBuf> {
    use std::os::windows::ffi::OsStringExt;

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
    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(
            hdrop: *mut core::ffi::c_void,
            index: u32,
            file: *mut u16,
            chars: u32,
        ) -> u32;
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

    unsafe fn hdrop_paths(hdrop: *mut core::ffi::c_void) -> Vec<PathBuf> {
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

/// Single path some clipboard managers place in the registered `FileNameW` format.
#[cfg(windows)]
fn filenamew_path() -> Option<String> {
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(owner: *mut core::ffi::c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> *mut core::ffi::c_void;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalLock(memory: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
        fn GlobalUnlock(memory: *mut core::ffi::c_void) -> i32;
        fn GlobalSize(memory: *mut core::ffi::c_void) -> usize;
    }

    unsafe {
        let mut name: Vec<u16> = "FileNameW".encode_utf16().collect();
        name.push(0);
        let format = RegisterClipboardFormatW(name.as_ptr());
        if format == 0 || OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let data = GetClipboardData(format);
        let path = if data.is_null() {
            None
        } else {
            let locked = GlobalLock(data) as *const u16;
            let text = if locked.is_null() {
                None
            } else {
                let mut len = 0usize;
                let max_chars = GlobalSize(data) / 2;
                while len + 1 < max_chars && *locked.add(len) != 0 {
                    len += 1;
                }
                let raw = String::from_utf16_lossy(std::slice::from_raw_parts(locked, len));
                GlobalUnlock(data);
                let trimmed = raw.trim().trim_start_matches(r"\\?\").trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            };
            text
        };
        CloseClipboard();
        path
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

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
}
