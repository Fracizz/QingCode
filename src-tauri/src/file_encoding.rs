//! Text ↔ bytes conversion for `files.encoding`
//! (auto / utf8 / utf8bom / utf16le / utf16be / gbk / gb18030).

use encoding_rs::{Encoding, GB18030, GBK, UTF_16BE, UTF_16LE, UTF_8};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileEncoding {
    Auto,
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Gbk,
    Gb18030,
}

impl FileEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Utf8 => "utf8",
            Self::Utf8Bom => "utf8bom",
            Self::Utf16Le => "utf16le",
            Self::Utf16Be => "utf16be",
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
        "utf16le" | "utf-16le" | "utf-16-le" | "ucs-2le" => FileEncoding::Utf16Le,
        "utf16be" | "utf-16be" | "utf-16-be" | "ucs-2be" => FileEncoding::Utf16Be,
        "gbk" | "gb2312" | "cp936" => FileEncoding::Gbk,
        "gb18030" => FileEncoding::Gb18030,
        "utf8" | "utf-8" | "" => FileEncoding::Utf8,
        _ => FileEncoding::Utf8,
    }
}

fn charset(enc: FileEncoding) -> &'static Encoding {
    match enc {
        FileEncoding::Auto | FileEncoding::Utf8 | FileEncoding::Utf8Bom => UTF_8,
        FileEncoding::Utf16Le => UTF_16LE,
        FileEncoding::Utf16Be => UTF_16BE,
        FileEncoding::Gbk => GBK,
        FileEncoding::Gb18030 => GB18030,
    }
}

/// True when `bytes` is valid UTF-8, or a valid UTF-8 prefix truncated mid-character.
///
/// Detection samples are often capped (e.g. first 8KB). Cutting inside a multi-byte
/// Chinese/emoji sequence must not make a UTF-8 file look non-text.
fn is_utf8_or_truncated_prefix(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        // `error_len() == None` means unexpected end of input (incomplete sequence).
        Err(err) => err.error_len().is_none() && err.valid_up_to() < bytes.len(),
    }
}

/// Heuristic for BOM-less UTF-16.
///
/// ASCII code units in UTF-16 leave a NUL byte on one side (`A` → `41 00` in
/// LE, `00 41` in BE). If NULs strongly concentrate on even or odd byte
/// indices and the sample actually decodes as that UTF-16 variant, treat it
/// as text instead of binary. Real binary files scatter NULs roughly evenly,
/// so a 10:1 imbalance plus a clean decode is a safe signal.
fn detect_utf16_without_bom(bytes: &[u8]) -> Option<FileEncoding> {
    // Need enough signal; tiny buffers can't carry a reliable NUL pattern.
    if bytes.len() < 32 {
        return None;
    }
    let mut even_zeros: u32 = 0;
    let mut odd_zeros: u32 = 0;
    let mut chunks = bytes.chunks_exact(2);
    for pair in chunks.by_ref() {
        if pair[0] == 0 {
            even_zeros += 1;
        }
        if pair[1] == 0 {
            odd_zeros += 1;
        }
    }
    // Account for a trailing odd byte (cannot form a NUL pair on the odd side).
    let _ = chunks.remainder();

    let candidate = if odd_zeros >= 4 && odd_zeros > even_zeros.saturating_mul(10) {
        FileEncoding::Utf16Le
    } else if even_zeros >= 4 && even_zeros > odd_zeros.saturating_mul(10) {
        FileEncoding::Utf16Be
    } else {
        return None;
    };

    // Validate: the sample must decode cleanly as the candidate variant.
    // Random binary bytes with a skewed NUL pattern would fail here (unpaired
    // surrogates / invalid code units).
    let encoding = match candidate {
        FileEncoding::Utf16Le => UTF_16LE,
        FileEncoding::Utf16Be => UTF_16BE,
        _ => return None,
    };
    let (_, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return None;
    }
    Some(candidate)
}

/// Detect a supported text encoding without silently replacing bytes.
///
/// GBK is a subset of GB18030, so non-UTF-8 legacy text is intentionally
/// reported as GB18030: it can decode both safely, while claiming GBK would
/// be incorrect for GB18030-only characters.
///
/// BOM-less UTF-16 is detected by NUL-byte distribution (ASCII code units
/// leave a NUL on one side); pure-Chinese UTF-16 without BOM has no NUL
/// pattern and still needs an explicit encoding to reopen.
pub fn detect(bytes: &[u8]) -> Result<FileEncoding, String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok(FileEncoding::Utf8Bom);
    }
    // Check UTF-16 BOMs before the NUL-byte binary gate (ASCII-in-UTF-16 is full of NULs).
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Ok(FileEncoding::Utf16Le);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Ok(FileEncoding::Utf16Be);
    }
    if bytes.contains(&0) {
        // Could be BOM-less UTF-16 (ASCII code units leave a NUL on one side).
        if let Some(enc) = detect_utf16_without_bom(bytes) {
            return Ok(enc);
        }
        return Err("binary content".to_string());
    }
    if is_utf8_or_truncated_prefix(bytes) {
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
///
/// UTF-16 variants always write a BOM (same as VS Code `utf16le` / `utf16be`).
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
        FileEncoding::Utf16Le => Ok(encode_utf16(text, true)),
        FileEncoding::Utf16Be => Ok(encode_utf16(text, false)),
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

/// encoding_rs can decode UTF-16 but does not encode to it; write BOM + code units ourselves.
fn encode_utf16(text: &str, little_endian: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + text.len() * 2);
    if little_endian {
        out.extend_from_slice(&[0xFF, 0xFE]);
    } else {
        out.extend_from_slice(&[0xFE, 0xFF]);
    }
    for unit in text.encode_utf16() {
        let bytes = if little_endian {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        };
        out.extend_from_slice(&bytes);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_aliases() {
        assert_eq!(parse(Some("auto")), FileEncoding::Auto);
        assert_eq!(parse(Some("utf8")), FileEncoding::Utf8);
        assert_eq!(parse(Some("utf8bom")), FileEncoding::Utf8Bom);
        assert_eq!(parse(Some("utf16le")), FileEncoding::Utf16Le);
        assert_eq!(parse(Some("UTF-16BE")), FileEncoding::Utf16Be);
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
    fn utf16_le_roundtrip_with_bom() {
        let text = "中文hi";
        let bytes = encode(text, FileEncoding::Utf16Le).unwrap();
        assert!(bytes.starts_with(&[0xFF, 0xFE]));
        assert_eq!(detect(&bytes).unwrap(), FileEncoding::Utf16Le);
        assert_eq!(decode(&bytes, FileEncoding::Auto).unwrap(), text);
        assert_eq!(decode(&bytes, FileEncoding::Utf16Le).unwrap(), text);
    }

    #[test]
    fn utf16_be_roundtrip_with_bom() {
        let text = "AB中";
        let bytes = encode(text, FileEncoding::Utf16Be).unwrap();
        assert!(bytes.starts_with(&[0xFE, 0xFF]));
        assert_eq!(detect(&bytes).unwrap(), FileEncoding::Utf16Be);
        assert_eq!(decode(&bytes, FileEncoding::Utf16Be).unwrap(), text);
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

    #[test]
    fn detect_accepts_utf8_truncated_at_sample_boundary() {
        // "中" is E4 B8 AD — drop the last byte as an 8KB-style sample cut would.
        let truncated = &"hello中文".as_bytes()[..7]; // "hello" + E4 B8 (incomplete 中)
        assert!(std::str::from_utf8(truncated).is_err());
        assert_eq!(detect(truncated).unwrap(), FileEncoding::Utf8);

        // Invalid byte in the middle is not a truncated UTF-8 prefix.
        let invalid = [b'a', 0xFF, b'b'];
        assert_ne!(detect(&invalid).ok(), Some(FileEncoding::Utf8));
    }

    #[test]
    fn detect_utf16_le_without_bom_mixed_ascii_chinese() {
        // Mirrors a typical BOM-less UTF-16 LE markdown file: lots of ASCII
        // (markdown syntax) plus some Chinese. Built without a BOM on purpose.
        let text = "# Home 替换 data 挂载方案\n\n这是一份中文文档，含 ASCII 与汉字。\n";
        let mut bytes = Vec::new();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(
            !bytes.starts_with(&[0xFF, 0xFE]),
            "fixture must be BOM-less"
        );
        assert!(bytes.contains(&0), "fixture must contain NULs");
        assert_eq!(detect(&bytes).unwrap(), FileEncoding::Utf16Le);
        assert_eq!(decode(&bytes, FileEncoding::Auto).unwrap(), text);
    }

    #[test]
    fn detect_utf16_be_without_bom_mixed_ascii_chinese() {
        let text = "English mixed with 中文 content.\n";
        let mut bytes = Vec::new();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        assert!(!bytes.starts_with(&[0xFE, 0xFF]));
        assert!(bytes.contains(&0));
        assert_eq!(detect(&bytes).unwrap(), FileEncoding::Utf16Be);
        assert_eq!(decode(&bytes, FileEncoding::Auto).unwrap(), text);
    }

    #[test]
    fn detect_rejects_binary_with_unpaired_surrogate() {
        // NUL pattern screams UTF-16 LE (odd bytes all zero), but one code unit
        // is a lone high surrogate (U+D800 → bytes `00 D8` in LE) → decode fails
        // → must NOT be detected as text. This is the guard against misclassifying
        // binary that happens to have a skewed NUL pattern.
        let mut bad = Vec::new();
        for _ in 0..16 {
            bad.extend_from_slice(&[0x41u8, 0x00]); // 'A' in UTF-16 LE
        }
        bad.extend_from_slice(&[0x00u8, 0xD8]); // lone high surrogate U+D800 (LE)
        for _ in 0..4 {
            bad.extend_from_slice(&[0x42u8, 0x00]); // 'B' in UTF-16 LE
        }
        assert!(bad.contains(&0));
        assert!(
            detect_utf16_without_bom(&bad).is_none(),
            "lone surrogate must fail decode validation"
        );
        assert!(detect(&bad).is_err());
    }

    #[test]
    fn detect_utf16_without_bom_requires_minimum_signal() {
        // Too short / too few NULs → not detected, falls through to binary.
        let short = [0x41u8, 0x00, 0x42, 0x00, 0x43, 0x00];
        assert!(detect_utf16_without_bom(&short).is_none());
    }

    #[test]
    fn detect_help_document_sample_is_utf8() {
        // Reproduce the 帮助文档.md failure: an 8KB-style sample may cut inside a
        // multi-byte UTF-8 character; detection must still prefer UTF-8.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../帮助文档.md");
        let Ok(bytes) = std::fs::read(path) else {
            return; // skip when the doc is absent from the checkout
        };
        assert!(
            bytes.len() > 8192,
            "fixture should exceed the detect sample size"
        );
        assert_eq!(detect(&bytes).unwrap(), FileEncoding::Utf8);

        let mut cut = 8192usize.min(bytes.len());
        while cut > 0 && std::str::from_utf8(&bytes[..cut]).is_ok() {
            cut -= 1;
        }
        if cut == 0 {
            // File happens to align on a character boundary through the sample
            // window — still require the leading sample to detect as UTF-8.
            assert_eq!(detect(&bytes[..8192]).unwrap(), FileEncoding::Utf8);
            return;
        }
        let sample = &bytes[..cut];
        assert!(
            std::str::from_utf8(sample).is_err(),
            "expected a mid-character cut near the sample window"
        );
        assert_eq!(detect(sample).unwrap(), FileEncoding::Utf8);
    }
}
