//! Text ↔ bytes conversion for `files.encoding` (auto / utf8 / utf8bom / gbk / gb18030).

use encoding_rs::{Encoding, GB18030, GBK, UTF_8};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileEncoding {
    Auto,
    Utf8,
    Utf8Bom,
    Gbk,
    Gb18030,
}

impl FileEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Utf8 => "utf8",
            Self::Utf8Bom => "utf8bom",
            Self::Gbk => "gbk",
            Self::Gb18030 => "gb18030",
        }
    }
}

/// Parse a settings / command encoding label. Unknown values fall back to UTF-8.
pub fn parse(name: Option<&str>) -> FileEncoding {
    match name
        .map(str::trim)
        .unwrap_or("utf8")
        .to_ascii_lowercase()
        .as_str()
    {
        "auto" => FileEncoding::Auto,
        "utf8bom" | "utf8-bom" | "utf-8-bom" => FileEncoding::Utf8Bom,
        "gbk" | "gb2312" | "cp936" => FileEncoding::Gbk,
        "gb18030" => FileEncoding::Gb18030,
        "utf8" | "utf-8" | "" => FileEncoding::Utf8,
        _ => FileEncoding::Utf8,
    }
}

fn charset(enc: FileEncoding) -> &'static Encoding {
    match enc {
        FileEncoding::Auto | FileEncoding::Utf8 | FileEncoding::Utf8Bom => UTF_8,
        FileEncoding::Gbk => GBK,
        FileEncoding::Gb18030 => GB18030,
    }
}

/// Detect a supported text encoding without silently replacing bytes.
///
/// GBK is a subset of GB18030, so non-UTF-8 legacy text is intentionally
/// reported as GB18030: it can decode both safely, while claiming GBK would
/// be incorrect for GB18030-only characters.
pub fn detect(bytes: &[u8]) -> Result<FileEncoding, String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok(FileEncoding::Utf8Bom);
    }
    if bytes.contains(&0) {
        return Err("binary content".to_string());
    }
    if std::str::from_utf8(bytes).is_ok() {
        return Ok(FileEncoding::Utf8);
    }
    let (_text, _used, had_errors) = GB18030.decode(bytes);
    if had_errors {
        return Err("unsupported text encoding".to_string());
    }
    Ok(FileEncoding::Gb18030)
}

/// Decode file bytes into a Unicode string. Rejects inputs that are not valid for `enc`
/// (no silent replacement), except UTF-8 BOM is stripped when present.
pub fn decode(bytes: &[u8], enc: FileEncoding) -> Result<String, String> {
    let (encoding, payload) = match enc {
        FileEncoding::Auto => return decode(bytes, detect(bytes)?),
        FileEncoding::Utf8 | FileEncoding::Utf8Bom => {
            let payload = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
            (UTF_8, payload)
        }
        other => (charset(other), bytes),
    };

    let (cow, _used, had_errors) = encoding.decode(payload);
    if had_errors {
        return Err(format!("decode failed for {}", enc.as_str()));
    }
    Ok(cow.into_owned())
}

/// Encode a Unicode string to on-disk bytes for `enc`.
pub fn encode(text: &str, enc: FileEncoding) -> Result<Vec<u8>, String> {
    match enc {
        // Auto is only meaningful while reading. New/unspecified content is UTF-8.
        FileEncoding::Auto => Ok(text.as_bytes().to_vec()),
        FileEncoding::Utf8 => Ok(text.as_bytes().to_vec()),
        FileEncoding::Utf8Bom => {
            let mut out = Vec::with_capacity(3 + text.len());
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        FileEncoding::Gbk | FileEncoding::Gb18030 => {
            let encoding = charset(enc);
            let (cow, _used, had_errors) = encoding.encode(text);
            if had_errors {
                return Err(format!("encode failed for {}", enc.as_str()));
            }
            Ok(cow.into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_aliases() {
        assert_eq!(parse(Some("auto")), FileEncoding::Auto);
        assert_eq!(parse(Some("utf8")), FileEncoding::Utf8);
        assert_eq!(parse(Some("utf8bom")), FileEncoding::Utf8Bom);
        assert_eq!(parse(Some("GBK")), FileEncoding::Gbk);
        assert_eq!(parse(Some("gb18030")), FileEncoding::Gb18030);
        assert_eq!(parse(Some("mystery")), FileEncoding::Utf8);
        assert_eq!(parse(None), FileEncoding::Utf8);
    }

    #[test]
    fn utf8_roundtrip_strips_bom_on_read() {
        let with_bom = [0xEFu8, 0xBB, 0xBF, b'h', b'i'];
        assert_eq!(decode(&with_bom, FileEncoding::Utf8).unwrap(), "hi");
        assert_eq!(
            encode("hi", FileEncoding::Utf8Bom).unwrap(),
            vec![0xEF, 0xBB, 0xBF, b'h', b'i']
        );
        assert_eq!(encode("hi", FileEncoding::Utf8).unwrap(), b"hi");
    }

    #[test]
    fn gbk_roundtrip_chinese() {
        // "中文" in GBK
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        let text = decode(&gbk, FileEncoding::Gbk).unwrap();
        assert_eq!(text, "中文");
        assert_eq!(encode(&text, FileEncoding::Gbk).unwrap(), gbk);
        assert!(decode(&gbk, FileEncoding::Utf8).is_err());
    }

    #[test]
    fn gb18030_roundtrip() {
        let text = "中文GB18030";
        let bytes = encode(text, FileEncoding::Gb18030).unwrap();
        assert_eq!(decode(&bytes, FileEncoding::Gb18030).unwrap(), text);
    }

    #[test]
    fn detects_bom_utf8_and_legacy_text() {
        assert_eq!(
            detect(&[0xEF, 0xBB, 0xBF, b'h', b'i']).unwrap(),
            FileEncoding::Utf8Bom
        );
        assert_eq!(detect("中文".as_bytes()).unwrap(), FileEncoding::Utf8);
        // "中文" in GBK; report the compatible GB18030 superset.
        assert_eq!(
            detect(&[0xD6, 0xD0, 0xCE, 0xC4]).unwrap(),
            FileEncoding::Gb18030
        );
        assert!(detect(&[0, 1, 2]).is_err());
    }
}
