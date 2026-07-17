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
    for root in [RegKey::predef(HKEY_LOCAL_MACHINE), RegKey::predef(HKEY_CURRENT_USER)] {
        for path in KEYS {
            let Ok(key) = root.open_subkey(path) else {
                continue;
            };
            for item in key.enum_values().flatten() {
                let (name, _) = item;
                if let Some(family) = normalize_font_family_name(&name) {
                    families.insert(family);
                }
            }
        }
    }
    families.into_iter().collect()
}

#[cfg(windows)]
fn normalize_font_family_name(raw: &str) -> Option<String> {
    let base = raw.split(" (").next().unwrap_or(raw).trim();
    if base.is_empty() {
        return None;
    }

    const SUFFIXES: &[&str] = &[
        " Bold Italic",
        " Bold Oblique",
        " Italic",
        " Oblique",
        " Bold",
        " Light",
        " Medium",
        " SemiBold",
        " Semibold",
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
    if family.is_empty() || family.eq_ignore_ascii_case("Unknown") {
        None
    } else {
        Some(family.to_string())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::normalize_font_family_name;

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
    }
}
