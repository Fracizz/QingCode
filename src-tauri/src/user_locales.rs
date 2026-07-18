//! User-installable UI locale packs under the app data `locales/` directory.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const EXAMPLE_LOCALE_JSON: &str = r#"{
  "locale": "example",
  "label": "Example",
  "messages": {
    "设置": "Settings (example)",
    "语言": "Language (example)",
    "显示语言": "Display language (example)",
    "选择界面显示语言。更改后立即生效。": "Choose the UI language. Changes apply immediately."
  }
}
"#;

fn app_data_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let project_root = manifest.parent().expect("CARGO_MANIFEST_DIR has no parent");
        project_root.join(".dev")
    } else {
        dirs::data_dir()
            .expect("no data dir")
            .join("com.qingcode.app")
    }
}

/// Absolute path to the user locales directory (created on demand).
pub fn ensure_user_locales_dir() -> PathBuf {
    let dir = app_data_dir().join("locales");
    let _ = fs::create_dir_all(&dir);
    let example = dir.join("_example.json");
    if !example.exists() {
        let _ = fs::write(&example, EXAMPLE_LOCALE_JSON);
    }
    dir
}

#[derive(Debug, Clone, Serialize)]
pub struct UserLocalePack {
    pub locale: String,
    pub label: String,
    pub messages: HashMap<String, String>,
    pub path: String,
}

fn is_valid_locale_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    let mut parts = code.split('-');
    let Some(primary) = parts.next() else {
        return false;
    };
    if primary.len() < 2 || primary.len() > 8 || !primary.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for part in parts {
        if part.is_empty() || part.len() > 8 || !part.chars().all(|c| c.is_ascii_alphanumeric()) {
            return false;
        }
    }
    true
}

fn parse_locale_file(path: &Path) -> Option<UserLocalePack> {
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let locale = value.get("locale")?.as_str()?.trim().to_string();
    if !is_valid_locale_code(&locale) {
        return None;
    }
    let label = value
        .get("label")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&locale)
        .to_string();
    let messages_val = value.get("messages")?;
    let messages: HashMap<String, String> = serde_json::from_value(messages_val.clone()).ok()?;
    Some(UserLocalePack {
        locale,
        label,
        messages,
        path: path.to_string_lossy().into_owned(),
    })
}

/// List user locale packs (`*.json` under locales/, skipping `_*.json` examples).
#[tauri::command]
pub fn list_user_locales() -> Result<Vec<UserLocalePack>, String> {
    let dir = ensure_user_locales_dir();
    let mut packs = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取语言包目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")) != Some(true)
        {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('_') {
            continue;
        }
        if let Some(pack) = parse_locale_file(&path) {
            packs.push(pack);
        }
    }
    packs.sort_by(|a, b| a.locale.to_ascii_lowercase().cmp(&b.locale.to_ascii_lowercase()));
    Ok(packs)
}

#[tauri::command]
pub fn user_locales_dir() -> String {
    ensure_user_locales_dir()
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_locale_codes() {
        assert!(is_valid_locale_code("en"));
        assert!(is_valid_locale_code("zh-CN"));
        assert!(is_valid_locale_code("pt-BR"));
        assert!(!is_valid_locale_code(""));
        assert!(!is_valid_locale_code("zh_CN"));
        assert!(!is_valid_locale_code("toolongprimary"));
    }

    #[test]
    fn parses_locale_json() {
        let dir = std::env::temp_dir().join(format!(
            "qingcode-locale-parse-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ja.json");
        fs::write(
            &path,
            r#"{"locale":"ja","label":"日本語","messages":{"设置":"設定"}}"#,
        )
        .unwrap();
        let pack = parse_locale_file(&path).expect("parse");
        assert_eq!(pack.locale, "ja");
        assert_eq!(pack.label, "日本語");
        assert_eq!(pack.messages.get("设置").map(String::as_str), Some("設定"));
        let _ = fs::remove_dir_all(&dir);
    }
}
