//! Shared "this cannot be a text buffer" extension gate.
//!
//! Local `file_stat` / `read_file` and remote SFTP reads must agree on which
//! extensions are binary. When they disagree the same file opens locally but
//! fails over SSH with a decoder-level message — or the reverse.

use std::path::Path;

/// Lowercased extension without the dot; `""` when the name has none.
pub(crate) fn file_extension_lower(name: &str) -> String {
    Path::new(display_file_name(name))
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

/// 图片查看功能主动放行的二进制格式（allowlist，方向与上面的黑名单相反）。
///
/// 清单必须与前端 `src/lib/imageFiles.ts` 保持一致；本地 `read_image_file` 与
/// 远程 `ssh_read_image_file` 都以这里为唯一判断来源。**不含 tif/tiff**：
/// WebView2 无法渲染 TIFF，放行只会得到一个解码失败的白块。
pub(crate) fn is_image_extension(name: &str) -> bool {
    matches!(
        file_extension_lower(name).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif"
    )
}

/// 图片查看拒绝非图片扩展名时的用户提示。
pub(crate) fn unsupported_image_format_message(path: &str) -> String {
    let name = display_file_name(path);
    let ext = file_extension_lower(name);
    if !ext.is_empty() {
        format!("不是支持的图片格式：{ext}")
    } else {
        format!("不是支持的图片格式：{name}")
    }
}

/// 图片超过解码上限时的用户提示（"大小→消息"的纯函数，本地与远程共用，
/// 便于对 64MB 边界做单元测试；上限值见两侧各自的 `IMAGE_MAX_BYTES`）。
pub(crate) fn image_too_large_message(size: u64) -> String {
    format!("图片过大（{size}），超过 64MB 上限")
}

pub(crate) fn display_file_name(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    if name.is_empty() {
        path
    } else {
        name
    }
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

    #[test]
    fn image_allowlist_hits_web_formats_and_is_case_insensitive() {
        assert!(is_image_extension("/tmp/shot.png"));
        assert!(is_image_extension("D:\\code\\photo.JPG"));
        assert!(is_image_extension("avatar.Jpeg"));
        assert!(is_image_extension("/srv/web/hero.avif"));
        assert!(is_image_extension("anim.gif"));
        assert!(is_image_extension("banner.webp"));
        assert!(is_image_extension("tile.bmp"));
        assert!(is_image_extension("favicon.ico"));
    }

    #[test]
    fn image_allowlist_rejects_tiff_text_executables_and_extensionless() {
        // WebView2 渲染不了 TIFF，tif/tiff 绝不能进白名单。
        assert!(!is_image_extension("scan.tif"));
        assert!(!is_image_extension("scan.tiff"));
        assert!(!is_image_extension("notes.txt"));
        assert!(!is_image_extension("app.exe"));
        assert!(!is_image_extension("Makefile"));
        assert!(!is_image_extension("ssh://conn/tmp/shot"));
    }

    #[test]
    fn unsupported_image_message_names_the_extension_or_file() {
        assert_eq!(
            unsupported_image_format_message("/tmp/notes.txt"),
            "不是支持的图片格式：txt"
        );
        assert_eq!(
            unsupported_image_format_message("D:\\code\\Makefile"),
            "不是支持的图片格式：Makefile"
        );
    }

    #[test]
    fn too_large_message_reports_raw_size_at_the_64mb_boundary() {
        const SIXTY_FOUR_MB: u64 = 64 * 1024 * 1024;
        assert_eq!(
            image_too_large_message(SIXTY_FOUR_MB + 1),
            "图片过大（67108865），超过 64MB 上限"
        );
        assert_eq!(
            image_too_large_message(SIXTY_FOUR_MB * 4),
            "图片过大（268435456），超过 64MB 上限"
        );
    }
}
