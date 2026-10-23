//! Shared "this cannot be a text buffer" extension gate.
//!
//! Local `file_stat` / `read_file` and remote SFTP reads must agree on which
//! extensions are binary. When they disagree the same file opens locally but
//! fails over SSH with a decoder-level message — or the reverse.

use std::path::Path;

/// Lowercased extension without the dot; `""` when the name has none.
pub(crate) fn file_extension_lower(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Formats that never decode to a usable text buffer.
///
/// The office formats are ZIP containers, and the rest are compiled or packed
/// artifacts. Text lockfiles (`.lock`) and source maps (`.map`) are deliberately
/// **not** listed: they are UTF-8 text people do open, even though they are
/// generated.
pub(crate) fn is_binary_extension(name: &str) -> bool {
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

pub(crate) fn display_file_name(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
}

/// User-facing reason when a local path cannot be opened as a text buffer.
pub(crate) fn unsupported_text_file_message(path: &str) -> String {
    let name = display_file_name(path);
    let ext = file_extension_lower(name);
    if !ext.is_empty() {
        format!("暂不支持打开 .{ext} 格式（非文本文件），请用对应应用打开：{name}")
    } else {
        format!("暂不支持打开非文本或非 UTF-8 文件：{name}")
    }
}

/// Remote counterpart: the file lives on another host, so offering "打开方式"
/// on this machine is wrong — the editor offers a download instead.
pub(crate) fn unsupported_remote_binary_message(path: &str) -> String {
    let name = display_file_name(path);
    let ext = file_extension_lower(name);
    if !ext.is_empty() {
        format!("暂不支持在文本编辑器中打开 .{ext} 格式（二进制文件）：{name}")
    } else {
        format!("暂不支持在文本编辑器中打开二进制文件：{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_extensions_are_case_insensitive() {
        assert!(is_binary_extension("A.PNG"));
        assert!(is_binary_extension("/tmp/build/app.png"));
        assert!(!is_binary_extension("main.rs"));
        assert!(!is_binary_extension("Makefile"));
    }

    #[test]
    fn text_lockfiles_and_source_maps_stay_openable() {
        // Generated, but UTF-8 text: blocking them used to force a wrong
        // "二进制文件" message on files people legitimately inspect.
        assert!(!is_binary_extension("Cargo.lock"));
        assert!(!is_binary_extension("Gemfile.lock"));
        assert!(!is_binary_extension("bundle.min.js.map"));
    }

    #[test]
    fn local_message_keeps_the_associated_app_hint() {
        let message = unsupported_text_file_message("/tmp/paste.png");
        assert!(message.contains("暂不支持打开 .png 格式"));
        assert!(message.contains("请用对应应用打开"));
    }

    #[test]
    fn remote_message_does_not_point_at_local_apps() {
        let message = unsupported_remote_binary_message("ssh://conn/D:/code/app/shot.png");
        assert!(message.contains(".png 格式（二进制文件）"));
        assert!(message.contains("shot.png"));
        assert!(!message.contains("请用对应应用打开"));
    }
}
