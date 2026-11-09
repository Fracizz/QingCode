#[cfg(windows)]
use std::collections::BTreeSet;

/// Installed font family names for the settings font pickers.
#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        Ok(list_windows_font_families())
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[cfg(windows)]
fn list_windows_font_families() -> Vec<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    const KEYS: &[&str] = &[
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Fonts",
    ];

    let mut families = BTreeSet::new();
    for root in [
        RegKey::predef(HKEY_LOCAL_MACHINE),
        RegKey::predef(HKEY_CURRENT_USER),
    ] {
        for path in KEYS {
            let Ok(key) = root.open_subkey(path) else {
                continue;
            };
            for item in key.enum_values().flatten() {
                let (name, _) = item;
                for family in expand_font_family_names(&name) {
                    families.insert(family);
                }
            }
        }
    }
    families.into_iter().collect()
}

/// Windows Fonts registry values often pack several faces from one TTC into a
/// single name joined with ` & `, e.g.
/// `Nirmala UI & Nirmala UI Bold & Nirmala Text (TrueType)`.
#[cfg(windows)]
fn expand_font_family_names(raw: &str) -> Vec<String> {
    let base = raw.split(" (").next().unwrap_or(raw).trim();
    if base.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for part in base.split(" & ") {
        if let Some(family) = normalize_font_family_name(part) {
            if seen.insert(family.clone()) {
                out.push(family);
            }
        }
    }
    out
}

/// Style words some installers register letter-spaced (`B o l d`, `S e m i B o l d`)
/// in the Windows Fonts registry. Longest-first so greedy matching of
/// concatenations (`S e m i B o l d I t a l i c`) works.
#[cfg(windows)]
const SPACED_STYLE_WORDS: &[&str] = &[
    "extralight",
    "semilight",
    "extrabold",
    "condensed",
    "semibold",
    "demibold",
    "regular",
    "oblique",
    "italic",
    "medium",
    "narrow",
    "light",
    "black",
    "heavy",
    "bold",
    "thin",
];

/// True when single-letter tokens spell only style words, e.g. `B o l d I t a l i c`.
#[cfg(windows)]
fn is_spaced_style_run(tokens: &[&str]) -> bool {
    if tokens.len() < 2
        || !tokens
            .iter()
            .all(|token| token.len() == 1 && token.as_bytes()[0].is_ascii_alphabetic())
    {
        return false;
    }
    let mut rest: String = tokens
        .iter()
        .flat_map(|token| token.bytes())
        .map(|b| b.to_ascii_lowercase() as char)
        .collect();
    while !rest.is_empty() {
        let Some(word) = SPACED_STYLE_WORDS
            .iter()
            .find(|word| rest.starts_with(*word))
        else {
            return false;
        };
        rest.drain(..word.len());
    }
    true
}

/// Drop a trailing letter-spaced style word; keep real families ending in one letter.
#[cfg(windows)]
fn strip_spaced_style_suffix(family: &str) -> String {
    let tokens: Vec<&str> = family.split_whitespace().collect();
    let mut end = tokens.len();
    while end > 0
        && tokens[end - 1].len() == 1
        && tokens[end - 1].as_bytes()[0].is_ascii_alphabetic()
    {
        end -= 1;
    }
    if end == tokens.len() || !is_spaced_style_run(&tokens[end..]) {
        return family.to_string();
    }
    tokens[..end].join(" ")
}

#[cfg(windows)]
fn normalize_font_family_name(raw: &str) -> Option<String> {
    let base = raw.split(" (").next().unwrap_or(raw).trim();
    // Reject leftover multi-face blobs instead of exposing them as one option.
    if base.is_empty() || base.contains(" & ") {
        return None;
    }

    let base = strip_spaced_style_suffix(base);
    let base = base.as_str();

    const SUFFIXES: &[&str] = &[
        " Bold Italic",
        " Bold Oblique",
        " SemiBold Italic",
        " Semibold Italic",
        " SemiLight Italic",
        " Semilight Italic",
        " ExtraBold Italic",
        " ExtraLight Italic",
        " Italic",
        " Oblique",
        " Bold",
        " Light",
        " Medium",
        " SemiBold",
        " Semibold",
        " SemiLight",
        " Semilight",
        " Regular",
        " Black",
        " Thin",
        " ExtraBold",
        " ExtraLight",
        " DemiBold",
        " Heavy",
        " Condensed",
        " Narrow",
    ];

    let mut family = base.to_string();
    loop {
        let mut stripped = false;
        for suffix in SUFFIXES {
            if let Some(next) = family.strip_suffix(suffix) {
                let next = next.trim_end();
                if !next.is_empty() {
                    family = next.to_string();
                    stripped = true;
                    break;
                }
            }
        }
        if !stripped {
            break;
        }
    }

    let family = family.trim();
    if family.is_empty() || family.eq_ignore_ascii_case("Unknown") || family.contains('&') {
        None
    } else {
        Some(family.to_string())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{expand_font_family_names, normalize_font_family_name};

    #[test]
    fn strips_truetype_and_style_suffixes() {
        assert_eq!(
            normalize_font_family_name("Arial Bold (TrueType)").as_deref(),
            Some("Arial")
        );
        assert_eq!(
            normalize_font_family_name("Segoe UI (TrueType)").as_deref(),
            Some("Segoe UI")
        );
        assert_eq!(
            normalize_font_family_name("Cascadia Code SemiBold (TrueType)").as_deref(),
            Some("Cascadia Code")
        );
        assert_eq!(
            normalize_font_family_name("Nirmala UI Semilight").as_deref(),
            Some("Nirmala UI")
        );
    }

    #[test]
    fn splits_ttc_multi_family_registry_names() {
        assert_eq!(
            expand_font_family_names(
                "Nirmala UI & Nirmala UI Bold & Nirmala UI Semilight & Nirmala Text & Nirmala Text Bold & Nirmala Text Semilight (TrueType)"
            ),
            vec!["Nirmala UI".to_string(), "Nirmala Text".to_string()]
        );
        assert_eq!(
            expand_font_family_names("Microsoft YaHei & Microsoft YaHei UI (TrueType)"),
            vec![
                "Microsoft YaHei".to_string(),
                "Microsoft YaHei UI".to_string()
            ]
        );
        assert_eq!(
            expand_font_family_names("SimSun & NSimSun (TrueType)"),
            vec!["SimSun".to_string(), "NSimSun".to_string()]
        );
    }

    #[test]
    fn rejects_unsplit_ampersand_blob() {
        assert_eq!(
            normalize_font_family_name("Nirmala UI & Nirmala Text"),
            None
        );
    }

    #[test]
    fn collapses_letter_spaced_style_names() {
        assert_eq!(
            normalize_font_family_name("Maple Mono CN R e g u l a r (TrueType)").as_deref(),
            Some("Maple Mono CN")
        );
        assert_eq!(
            normalize_font_family_name("Maple Mono CN B o l d (TrueType)").as_deref(),
            Some("Maple Mono CN")
        );
        assert_eq!(
            normalize_font_family_name("Maple Mono CN S e m i B o l d I t a l i c").as_deref(),
            Some("Maple Mono CN")
        );
    }

    #[test]
    fn keeps_family_names_ending_in_a_single_letter() {
        assert_eq!(
            normalize_font_family_name("Iosevka A").as_deref(),
            Some("Iosevka A")
        );
        assert_eq!(
            normalize_font_family_name("Maple Mono X y").as_deref(),
            Some("Maple Mono X y")
        );
    }
}
