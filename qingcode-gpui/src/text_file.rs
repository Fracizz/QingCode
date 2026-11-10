//! 文本文件读写：大小/二进制/编码检查与换行符往返。
//!
//! 编辑器内部统一使用 `\n`；读取时记录原文件是否为 CRLF，保存时按原样还原，
//! 避免在 Windows 仓库里把整文件换行符改掉。

use std::fs;
use std::io::Write;
use std::path::Path;

/// 编辑器可打开的最大文件体积（与 Web 版大文件阈值同量级）。
pub const MAX_EDITABLE_BYTES: u64 = 5 * 1024 * 1024;

/// 读入编辑器的文本文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextFile {
    /// 已归一化为 `\n` 的内容
    pub text: String,
    /// 原文件是否使用 CRLF
    pub crlf: bool,
}

/// 读取失败原因（面向用户的中文描述）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    TooLarge(u64),
    Binary,
    NotUtf8,
    Io(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::TooLarge(n) => write!(f, "文件过大（{} KB），MVP 暂不支持打开", n / 1024),
            OpenError::Binary => write!(f, "二进制文件，无法以文本打开"),
            OpenError::NotUtf8 => write!(f, "非 UTF-8 编码，MVP 暂不支持"),
            OpenError::Io(e) => write!(f, "读取失败：{e}"),
        }
    }
}

/// 从字节解码为编辑器文本。
pub fn decode(bytes: &[u8]) -> Result<TextFile, OpenError> {
    // 前 8KB 出现 NUL 视为二进制
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return Err(OpenError::Binary);
    }
    // 去掉 UTF-8 BOM
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let raw = std::str::from_utf8(bytes).map_err(|_| OpenError::NotUtf8)?;
    let crlf = raw.contains("\r\n");
    let text = if crlf {
        raw.replace("\r\n", "\n")
    } else {
        raw.to_string()
    };
    Ok(TextFile { text, crlf })
}

/// 读取文件到编辑器。
pub fn read(path: &Path) -> Result<TextFile, OpenError> {
    let meta = fs::metadata(path).map_err(|e| OpenError::Io(e.to_string()))?;
    if meta.len() > MAX_EDITABLE_BYTES {
        return Err(OpenError::TooLarge(meta.len()));
    }
    let bytes = fs::read(path).map_err(|e| OpenError::Io(e.to_string()))?;
    decode(&bytes)
}

/// 把编辑器文本还原为磁盘上的换行风格。
pub fn encode(text: &str, crlf: bool) -> String {
    if crlf {
        // 先归一化，防止已有的 \r\n 被替换成 \r\r\n
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text.to_string()
    }
}

/// 原子保存：先写同目录临时文件再重命名，避免写到一半崩溃损坏原文件。
pub fn write(path: &Path, text: &str, crlf: bool) -> std::io::Result<()> {
    let data = encode(text, crlf);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp = dir.join(format!(".{name}.qingcode-save.tmp"));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_normalizes_crlf_and_remembers_it() {
        let f = decode(b"a\r\nb\r\n").unwrap();
        assert_eq!(f.text, "a\nb\n");
        assert!(f.crlf);
        assert_eq!(encode(&f.text, f.crlf), "a\r\nb\r\n");
    }

    #[test]
    fn decode_keeps_lf_files_untouched() {
        let f = decode("中文\n".as_bytes()).unwrap();
        assert_eq!(f.text, "中文\n");
        assert!(!f.crlf);
        assert_eq!(encode("x\ny", false), "x\ny");
    }

    #[test]
    fn decode_strips_bom_and_rejects_binary_and_invalid_utf8() {
        assert_eq!(decode(b"\xEF\xBB\xBFhi").unwrap().text, "hi");
        assert_eq!(decode(b"ab\0cd"), Err(OpenError::Binary));
        assert_eq!(decode(b"\xFF\xFE\x41"), Err(OpenError::NotUtf8));
    }

    #[test]
    fn encode_crlf_does_not_double_carriage_returns() {
        assert_eq!(encode("a\r\nb\nc", true), "a\r\nb\r\nc");
    }

    #[test]
    fn write_round_trips_through_disk_with_original_line_endings() {
        let dir = std::env::temp_dir().join(format!("qingcode-gpui-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.txt");
        write(&path, "x\ny\n", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"x\r\ny\r\n");
        let back = read(&path).unwrap();
        assert_eq!(
            back,
            TextFile {
                text: "x\ny\n".into(),
                crlf: true
            }
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
