//! Check for a newer QingCode release on GitHub (preferred) then Gitee.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::Serialize;

const GITEE_LATEST: &str =
    "https://gitee.com/api/v5/repos/FrancizTest_admin/qing-code/releases/latest";
const GITHUB_LATEST: &str = "https://api.github.com/repos/Fracizz/QingCode/releases/latest";
const USER_AGENT: &str = "QingCode-UpdateCheck/1.0";
const RELEASE_SOURCES: &[(&str, &str)] = &[("github", GITHUB_LATEST), ("gitee", GITEE_LATEST)];

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

fn prefer_asset_names() -> &'static [&'static str] {
    #[cfg(all(windows, target_arch = "aarch64"))]
    {
        &[
            "-windows-arm64-setup.exe",
            "-setup.exe",
            "qingcode-setup.exe",
        ]
    }
    #[cfg(all(windows, not(target_arch = "aarch64")))]
    {
        &["-windows-x64-setup.exe", "-setup.exe", "qingcode-setup.exe"]
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        &["-macos-arm64.dmg", "-macos-arm64.zip"]
    }
    #[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
    {
        &["-setup.exe", ".dmg", ".zip"]
    }
}

/// Detect auto-generated source code archives that hosts attach to every
/// release (GitHub: `Source code.zip` / `Source code.tar.gz`; Gitee:
/// `<tag>.zip` / `<tag>.tar.gz`, e.g. `v0.1.8.zip`). These are never valid
/// update payloads and must never be picked as a download URL.
fn is_source_archive(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    // GitHub-style auto-generated source archives.
    if lower == "source code.zip" || lower == "source code.tar.gz" {
        return true;
    }
    // Gitee-style: `<tag>.zip` / `<tag>.tar.gz` where tag is `vX.Y.Z` (+ optional
    // pre-release suffix). Strip the archive suffix and check the tag shape
    // without pulling in a regex dependency.
    let Some(stem) = lower
        .strip_suffix(".tar.gz")
        .or_else(|| lower.strip_suffix(".zip"))
    else {
        return false; // no recognized archive suffix
    };
    is_version_tag(stem)
}

/// Cheap `vX.Y.Z` (optionally `-pre`) tag matcher — no regex dependency.
fn is_version_tag(s: &str) -> bool {
    let s = s.trim();
    let core = s
        .strip_prefix('v')
        .or_else(|| s.strip_prefix('V'))
        .unwrap_or(s);
    if core.is_empty() {
        return false;
    }
    // Drop a pre-release suffix (`-rc.1`, `-beta`, …) before checking the core.
    let core = core.split('-').next().unwrap_or(core);
    let mut parts = core.split('.');
    let major = parts.next().unwrap_or("");
    let minor = parts.next().unwrap_or("");
    let patch = parts.next().unwrap_or("");
    !major.is_empty()
        && !minor.is_empty()
        && !patch.is_empty()
        && major.bytes().all(|b| b.is_ascii_digit())
        && minor.bytes().all(|b| b.is_ascii_digit())
        && patch.bytes().all(|b| b.is_ascii_digit())
        && parts.next().is_none()
}

fn pick_download_url(assets: &[ReleaseAsset]) -> Option<String> {
    let preferred = prefer_asset_names();
    for needle in preferred {
        for asset in assets {
            let name = asset.name.as_deref().unwrap_or("").to_ascii_lowercase();
            if is_source_archive(&name) {
                continue;
            }
            let Some(url) = asset.browser_download_url.clone() else {
                continue;
            };
            if name.contains(needle) || name == *needle {
                return Some(url);
            }
        }
    }

    let mut portable_fallback: Option<String> = None;
    for asset in assets {
        let name = asset.name.as_deref().unwrap_or("").to_ascii_lowercase();
        if is_source_archive(&name) {
            continue;
        }
        let Some(url) = asset.browser_download_url.clone() else {
            continue;
        };
        if name.ends_with("-setup.exe")
            || (name.contains("setup") && name.ends_with(".exe"))
            || name.ends_with(".dmg")
        {
            return Some(url);
        }
        // Portable fallback must be a real platform binary — never a source
        // archive. On Windows only `.exe` is valid; on macOS both `.dmg` and
        // the app-bundle `.zip` are valid; elsewhere accept `.exe`/`.zip`.
        let is_valid_portable = match () {
            #[cfg(windows)]
            () => name.ends_with(".exe"),
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            () => name.ends_with(".dmg") || name.ends_with(".zip"),
            #[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
            () => name.ends_with(".exe") || name.ends_with(".zip"),
        };
        if is_valid_portable && portable_fallback.is_none() {
            portable_fallback = Some(url);
        }
    }
    portable_fallback
}

fn sanitize_filename(name: &str) -> Option<String> {
    let base = Path::new(name.trim()).file_name()?.to_str()?;
    if base.is_empty()
        || base.contains("..")
        || base.contains('/')
        || base.contains('\\')
        || base.contains(':')
    {
        return None;
    }
    Some(base.to_string())
}

fn filename_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let without_query = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    let segment = without_query.rsplit('/').next()?;
    sanitize_filename(segment)
}

fn default_download_filename() -> &'static str {
    #[cfg(all(windows, target_arch = "aarch64"))]
    {
        "QingCode-setup.exe"
    }
    #[cfg(all(windows, not(target_arch = "aarch64")))]
    {
        "QingCode-setup.exe"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "QingCode.dmg"
    }
    #[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
    {
        "QingCode-setup.exe"
    }
}

fn download_dir() -> Result<PathBuf, String> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "无法定位下载目录".to_string())
}

/// Download a release asset into the user's Downloads folder and return the saved path.
pub fn download_release_asset(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("下载地址为空".to_string());
    }
    let filename =
        filename_from_url(trimmed).unwrap_or_else(|| default_download_filename().to_string());
    let dest = download_dir()?.join(&filename);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建下载目录失败：{e}"))?;
    }

    let response = ureq::get(trimmed)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("下载失败：{e}"))?;
    if !(200..300).contains(&response.status()) {
        return Err(format!("HTTP {}", response.status()));
    }

    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(&dest).map_err(|e| format!("创建文件失败：{e}"))?;
    io::copy(&mut reader, &mut file).map_err(|e| format!("写入文件失败：{e}"))?;
    file.flush().map_err(|e| format!("写入文件失败：{e}"))?;

    Ok(dest.to_string_lossy().into_owned())
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

fn release_to_info(
    release: ReleaseJson,
    current: &str,
    source: &str,
) -> Result<AppUpdateInfo, String> {
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
    let download_url = release.assets.as_deref().and_then(pick_download_url);
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

/// Query GitHub first, then Gitee. `current` is the running app version.
pub fn check_latest(current: &str) -> Result<AppUpdateInfo, String> {
    let current = current.trim().trim_start_matches(['v', 'V']);
    if current.is_empty() {
        return Err("当前版本号为空".to_string());
    }

    let mut errors = Vec::new();
    for (source, url) in RELEASE_SOURCES {
        match fetch_release(url) {
            Ok(release) => return release_to_info(release, current, source),
            Err(e) => errors.push(format!("{}: {}", source, e)),
        }
    }
    Err(format!("检查更新失败（{}）", errors.join("；")))
}

#[tauri::command]
pub fn check_app_update(current_version: String) -> Result<AppUpdateInfo, String> {
    check_latest(&current_version)
}

#[tauri::command]
pub fn download_app_update(url: String) -> Result<String, String> {
    download_release_asset(&url)
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
    fn release_sources_prefer_github_and_keep_gitee_fallback() {
        assert_eq!(RELEASE_SOURCES[0], ("github", GITHUB_LATEST));
        assert_eq!(RELEASE_SOURCES[1], ("gitee", GITEE_LATEST));
    }

    #[test]
    fn pick_download_prefers_installer_asset() {
        let assets = vec![
            ReleaseAsset {
                name: Some("notes.txt".into()),
                browser_download_url: Some("https://example.com/notes.txt".into()),
            },
            ReleaseAsset {
                name: Some("QingCode_0.1.4-windows-x64.exe".into()),
                browser_download_url: Some(
                    "https://example.com/QingCode_0.1.4-windows-x64.exe".into(),
                ),
            },
            ReleaseAsset {
                name: Some("QingCode_0.1.4-windows-x64-setup.exe".into()),
                browser_download_url: Some(
                    "https://example.com/QingCode_0.1.4-windows-x64-setup.exe".into(),
                ),
            },
            ReleaseAsset {
                name: Some("QingCode_0.1.4-windows-arm64-setup.exe".into()),
                browser_download_url: Some(
                    "https://example.com/QingCode_0.1.4-windows-arm64-setup.exe".into(),
                ),
            },
        ];
        let picked = pick_download_url(&assets).unwrap();
        #[cfg(all(windows, target_arch = "aarch64"))]
        assert!(picked.contains("windows-arm64-setup"));
        #[cfg(all(windows, not(target_arch = "aarch64")))]
        assert!(picked.contains("windows-x64-setup"));
        #[cfg(not(windows))]
        assert!(!picked.is_empty());
    }

    #[test]
    fn filename_from_url_strips_query() {
        assert_eq!(
            filename_from_url("https://example.com/QingCode_0.1.5-setup.exe?token=abc"),
            Some("QingCode_0.1.5-setup.exe".into())
        );
    }

    #[test]
    fn is_source_archive_detects_host_generated_archives() {
        // Gitee-style: <tag>.zip / <tag>.tar.gz
        assert!(is_source_archive("v0.1.8.zip"));
        assert!(is_source_archive("v0.1.8.tar.gz"));
        assert!(is_source_archive("V1.2.3.zip"));
        assert!(is_source_archive("v10.20.30-rc.1.zip"));
        // GitHub-style auto-generated source archives
        assert!(is_source_archive("Source code.zip"));
        assert!(is_source_archive("Source code.tar.gz"));
        // Real release assets must NOT be flagged
        assert!(!is_source_archive("QingCode_0.1.8-windows-x64-setup.exe"));
        assert!(!is_source_archive("QingCode_0.1.8-macos-arm64.zip"));
        assert!(!is_source_archive("QingCode_0.1.8-windows-x64.exe"));
        assert!(!is_source_archive("QingCode_0.1.8-macos-arm64.dmg"));
    }

    #[test]
    fn pick_download_url_rejects_source_only_release() {
        // Mirrors the actual Gitee v0.1.8 release: only source archives present.
        let assets = vec![
            ReleaseAsset {
                name: Some("v0.1.8.zip".into()),
                browser_download_url: Some(
                    "https://gitee.com/FrancizTest_admin/qing-code/archive/refs/tags/v0.1.8.zip"
                        .into(),
                ),
            },
            ReleaseAsset {
                name: Some("v0.1.8.tar.gz".into()),
                browser_download_url: Some(
                    "https://gitee.com/FrancizTest_admin/qing-code/archive/refs/tags/v0.1.8.tar.gz"
                        .into(),
                ),
            },
        ];
        assert!(pick_download_url(&assets).is_none());
    }

    #[test]
    fn pick_download_url_prefers_installer_over_source_archive() {
        // Source archive listed first must not shadow the real installer.
        let assets = vec![
            ReleaseAsset {
                name: Some("v0.1.8.zip".into()),
                browser_download_url: Some("https://example.com/v0.1.8.zip".into()),
            },
            ReleaseAsset {
                name: Some("QingCode_0.1.8-windows-x64-setup.exe".into()),
                browser_download_url: Some(
                    "https://example.com/QingCode_0.1.8-windows-x64-setup.exe".into(),
                ),
            },
        ];
        let picked = pick_download_url(&assets).unwrap();
        assert!(picked.contains("windows-x64-setup"));
        assert!(!picked.contains("v0.1.8.zip"));
    }
}
