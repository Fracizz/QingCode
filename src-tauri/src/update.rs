//! Check for a newer QingCode release on Gitee (preferred) then GitHub.

use serde::Deserialize;
use serde::Serialize;

const GITEE_LATEST: &str =
    "https://gitee.com/api/v5/repos/FrancizTest_admin/qing-code/releases/latest";
const GITHUB_LATEST: &str = "https://api.github.com/repos/Fracizz/QingCode/releases/latest";
const USER_AGENT: &str = "QingCode-UpdateCheck/1.0";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppUpdateInfo {
    pub update_available: bool,
    pub current: String,
    pub latest: String,
    pub notes: Option<String>,
    pub page_url: String,
    pub download_url: Option<String>,
    /// Which host answered: `gitee` | `github`.
    pub source: String,
}

#[derive(Debug, Deserialize)]
struct ReleaseJson {
    tag_name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    assets: Option<Vec<ReleaseAsset>>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: Option<String>,
    browser_download_url: Option<String>,
}

/// Normalize `v1.2.3` / `1.2.3-beta` → comparable `(major, minor, patch)` when possible.
pub fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let core = trimmed.split(['-', '+']).next().unwrap_or(trimmed);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(l), Some(c)) => l > c,
        _ => {
            let l = latest.trim().trim_start_matches(['v', 'V']);
            let c = current.trim().trim_start_matches(['v', 'V']);
            !l.is_empty() && l != c
        }
    }
}

fn pick_download_url(assets: &[ReleaseAsset]) -> Option<String> {
    let mut fallback: Option<String> = None;
    for asset in assets {
        let name = asset.name.as_deref().unwrap_or("").to_ascii_lowercase();
        let Some(url) = asset.browser_download_url.clone() else {
            continue;
        };
        if name == "qingcode.exe"
            || (name.starts_with("qingcode_") && name.ends_with(".exe"))
        {
            return Some(url);
        }
        if name.ends_with(".exe") && fallback.is_none() {
            fallback = Some(url);
        }
    }
    fallback
}

fn fetch_release(url: &str) -> Result<ReleaseJson, String> {
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("请求失败：{}", e))?;
    if !(200..300).contains(&response.status()) {
        return Err(format!("HTTP {}", response.status()));
    }
    response
        .into_json::<ReleaseJson>()
        .map_err(|e| format!("解析 Release JSON 失败：{}", e))
}

fn release_to_info(release: ReleaseJson, current: &str, source: &str) -> Result<AppUpdateInfo, String> {
    let tag = release
        .tag_name
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Release 缺少 tag_name".to_string())?;
    let latest = tag.trim().trim_start_matches(['v', 'V']).to_string();
    let page_url = release
        .html_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if source == "gitee" {
                "https://gitee.com/FrancizTest_admin/qing-code/releases".to_string()
            } else {
                "https://github.com/Fracizz/QingCode/releases".to_string()
            }
        });
    let download_url = release
        .assets
        .as_deref()
        .and_then(pick_download_url);
    let notes = release
        .body
        .map(|b| {
            let trimmed = b.trim();
            if trimmed.chars().count() > 600 {
                let cut: String = trimmed.chars().take(600).collect();
                format!("{}…", cut)
            } else {
                trimmed.to_string()
            }
        })
        .filter(|s| !s.is_empty());
    Ok(AppUpdateInfo {
        update_available: is_newer(&latest, current),
        current: current.trim().trim_start_matches(['v', 'V']).to_string(),
        latest,
        notes,
        page_url,
        download_url,
        source: source.to_string(),
    })
}

/// Query Gitee first, then GitHub. `current` is the running app version.
pub fn check_latest(current: &str) -> Result<AppUpdateInfo, String> {
    let current = current.trim().trim_start_matches(['v', 'V']);
    if current.is_empty() {
        return Err("当前版本号为空".to_string());
    }

    let mut errors = Vec::new();
    match fetch_release(GITEE_LATEST) {
        Ok(release) => return release_to_info(release, current, "gitee"),
        Err(e) => errors.push(format!("Gitee: {}", e)),
    }
    match fetch_release(GITHUB_LATEST) {
        Ok(release) => return release_to_info(release, current, "github"),
        Err(e) => errors.push(format!("GitHub: {}", e)),
    }
    Err(format!("检查更新失败（{}）", errors.join("；")))
}

#[tauri::command]
pub fn check_app_update(current_version: String) -> Result<AppUpdateInfo, String> {
    check_latest(&current_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_semver_strips_v_prefix() {
        assert_eq!(parse_semver("v0.1.3"), Some((0, 1, 3)));
        assert_eq!(parse_semver("1.2.0"), Some((1, 2, 0)));
        assert_eq!(parse_semver("v2.0.1-beta"), Some((2, 0, 1)));
    }

    #[test]
    fn is_newer_compares_numeric_parts() {
        assert!(is_newer("0.1.4", "0.1.3"));
        assert!(is_newer("v0.2.0", "0.1.9"));
        assert!(!is_newer("0.1.3", "0.1.3"));
        assert!(!is_newer("0.1.2", "0.1.3"));
    }

    #[test]
    fn pick_download_prefers_qingcode_exe() {
        let assets = vec![
            ReleaseAsset {
                name: Some("notes.txt".into()),
                browser_download_url: Some("https://example.com/notes.txt".into()),
            },
            ReleaseAsset {
                name: Some("QingCode_0.1.4.exe".into()),
                browser_download_url: Some("https://example.com/QingCode_0.1.4.exe".into()),
            },
            ReleaseAsset {
                name: Some("other.exe".into()),
                browser_download_url: Some("https://example.com/other.exe".into()),
            },
        ];
        assert_eq!(
            pick_download_url(&assets).as_deref(),
            Some("https://example.com/QingCode_0.1.4.exe")
        );
    }
}
