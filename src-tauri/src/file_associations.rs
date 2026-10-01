//! Windows "Open with" / ProgId registration for portable QingCode.exe.
//! Uses HKCU only (no admin). Registers text/code extensions the editor supports.

use serde::Serialize;
use std::path::{Path, PathBuf};

const PROGID: &str = "QingCode.Document";
const APP_KEY: &str = "QingCode.exe";
const FRIENDLY_NAME: &str = "QingCode";
const REGISTRATION_VERSION_NAME: &str = "QingCodeRegistrationVersion";
const REGISTRATION_VERSION: u32 = 2;

/// Text/code extensions QingCode can open (exclude binaries rejected by `read_file`).
const OPEN_WITH_EXTENSIONS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "json",
    "jsonc",
    "json5",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "css",
    "scss",
    "less",
    "html",
    "htm",
    "xml",
    "svg",
    "py",
    "rs",
    "toml",
    "yaml",
    "yml",
    "ini",
    "cfg",
    "conf",
    "env",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "go",
    "java",
    "c",
    "h",
    "cpp",
    "cc",
    "cxx",
    "hpp",
    "cs",
    "kt",
    "kts",
    "swift",
    "rb",
    "php",
    "lua",
    "sql",
    "graphql",
    "gql",
    "vue",
    "svelte",
    "r",
    "dart",
    "scala",
    "groovy",
    "gradle",
    "properties",
    "diff",
    "patch",
    "log",
    "gitignore",
    "gitattributes",
    "editorconfig",
    "dockerfile",
    "makefile",
    "cmake",
    "tex",
    "rst",
    "adoc",
    "csv",
    "tsv",
];

// These can be edited, but must not be offered as document associations: their
// default Open verb executes the script rather than opening a text document.
const EDITOR_ONLY_EXTENSIONS: &[&str] = &["bat", "cmd"];

#[derive(Debug, Serialize, Clone)]
pub struct OpenWithStatus {
    pub registered: bool,
    pub exe_path: String,
    pub extensions: Vec<String>,
    pub file_extensions: Vec<String>,
    pub supported: bool,
}

/// Extensions we register for Open With.
pub fn supported_open_with_extensions() -> Vec<String> {
    OPEN_WITH_EXTENSIONS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

pub fn supported_file_extensions() -> Vec<String> {
    OPEN_WITH_EXTENSIONS
        .iter()
        .chain(EDITOR_ONLY_EXTENSIONS)
        .map(|ext| (*ext).to_string())
        .collect()
}

fn is_empty_legacy_default(owned_open_with: bool, default: Option<&str>) -> bool {
    owned_open_with && default == Some("")
}

/// Collect file paths from process argv (skip exe and flag-like args).
pub fn collect_cli_file_paths(args: impl IntoIterator<Item = String>) -> Vec<String> {
    let cwd = std::env::current_dir().ok();
    collect_cli_file_paths_from(args, cwd.as_deref())
}

/// Collect file paths from another process invocation. Relative paths are
/// resolved against that process' cwd before the primary instance receives them.
pub fn collect_cli_file_paths_from(
    args: impl IntoIterator<Item = String>,
    cwd: Option<&Path>,
) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| {
            let path = PathBuf::from(&arg);
            let resolved = if path.is_absolute() {
                path
            } else if let Some(cwd) = cwd {
                cwd.join(path)
            } else {
                path
            };
            resolved
                .is_file()
                .then(|| resolved.to_string_lossy().into_owned())
        })
        .collect()
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::path::PathBuf;
    use winreg::enums::*;
    use winreg::RegKey;

    fn exe_path() -> Result<PathBuf, String> {
        std::env::current_exe().map_err(|e| format!("无法定位 QingCode.exe: {e}"))
    }

    fn quote_cmd(path: &std::path::Path) -> String {
        format!("\"{}\" \"%1\"", path.display())
    }

    fn icon_value(path: &std::path::Path) -> String {
        format!("{},0", path.display())
    }

    pub fn open_with_status() -> Result<OpenWithStatus, String> {
        let exe = exe_path()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let registered = hkcu
            .open_subkey(format!(r"Software\Classes\Applications\{APP_KEY}"))
            .ok()
            .filter(|key| key.get_raw_value("NoOpenWith").is_err())
            .and_then(|key| key.open_subkey(r"shell\open\command").ok())
            .and_then(|key| key.get_value::<String, _>("").ok())
            .map(|cmd| cmd.eq_ignore_ascii_case(&quote_cmd(&exe)))
            .unwrap_or(false);

        Ok(OpenWithStatus {
            registered,
            exe_path: exe.to_string_lossy().into_owned(),
            extensions: supported_open_with_extensions(),
            file_extensions: supported_file_extensions(),
            supported: true,
        })
    }

    pub fn register_open_with() -> Result<OpenWithStatus, String> {
        let exe = exe_path()?;
        if !exe.is_file() {
            return Err(format!("可执行文件不存在: {}", exe.display()));
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = hkcu
            .create_subkey(r"Software\Classes")
            .map_err(|e| format!("无法写入注册表 Software\\Classes: {e}"))?
            .0;
        let repair_legacy_defaults = needs_legacy_default_repair(&classes);

        let prog = classes
            .create_subkey(PROGID)
            .map_err(|e| format!("无法创建 ProgId: {e}"))?
            .0;
        prog.set_value("", &FRIENDLY_NAME)
            .map_err(|e| format!("写入 ProgId 失败: {e}"))?;
        delete_value_if_present(&prog, "NoOpenWith")?;
        prog.create_subkey("DefaultIcon")
            .map_err(|e| format!("DefaultIcon: {e}"))?
            .0
            .set_value("", &icon_value(&exe))
            .map_err(|e| format!("DefaultIcon 值: {e}"))?;
        prog.create_subkey(r"shell\open\command")
            .map_err(|e| format!("shell\\open\\command: {e}"))?
            .0
            .set_value("", &quote_cmd(&exe))
            .map_err(|e| format!("open command: {e}"))?;

        let app = classes
            .create_subkey(format!(r"Applications\{APP_KEY}"))
            .map_err(|e| format!("Applications key: {e}"))?
            .0;
        app.set_value("FriendlyAppName", &FRIENDLY_NAME)
            .map_err(|e| format!("FriendlyAppName: {e}"))?;
        delete_value_if_present(&app, "NoOpenWith")?;
        app.create_subkey("DefaultIcon")
            .map_err(|e| format!("App DefaultIcon: {e}"))?
            .0
            .set_value("", &icon_value(&exe))
            .map_err(|e| format!("App DefaultIcon 值: {e}"))?;
        app.create_subkey(r"shell\open\command")
            .map_err(|e| format!("App open command: {e}"))?
            .0
            .set_value("", &quote_cmd(&exe))
            .map_err(|e| format!("App open command 值: {e}"))?;

        let supported = app
            .create_subkey("SupportedTypes")
            .map_err(|e| format!("SupportedTypes: {e}"))?
            .0;

        clean_legacy_extensions(&classes, false, repair_legacy_defaults)?;
        for ext in EDITOR_ONLY_EXTENSIONS {
            delete_value_if_present(&supported, &format!(".{ext}"))?;
        }

        for ext in supported_open_with_extensions() {
            let dotted = format!(".{ext}");
            supported
                .set_value(&dotted, &"")
                .map_err(|e| format!("SupportedTypes {dotted}: {e}"))?;

            let ext_key = classes
                .create_subkey(&dotted)
                .map_err(|e| format!("扩展名 {dotted}: {e}"))?
                .0;
            ext_key
                .create_subkey("OpenWithProgids")
                .map_err(|e| format!("OpenWithProgids {dotted}: {e}"))?
                .0
                .set_value(PROGID, &"")
                .map_err(|e| format!("OpenWithProgids 值 {dotted}: {e}"))?;
        }
        app.set_value(REGISTRATION_VERSION_NAME, &REGISTRATION_VERSION)
            .map_err(|e| format!("写入打开方式注册版本: {e}"))?;

        notify_shell_change();
        open_with_status()
    }

    pub fn unregister_open_with() -> Result<OpenWithStatus, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = match hkcu.open_subkey_with_flags(r"Software\Classes", KEY_READ | KEY_WRITE) {
            Ok(k) => k,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return open_with_status(),
            Err(e) => return Err(format!("读取打开方式注册表: {e}")),
        };
        let repair_legacy_defaults = needs_legacy_default_repair(&classes);

        // UserChoice may still point to either identifier. Keep their commands
        // valid, and hide them from Open With instead of orphaning user defaults.
        for path in [PROGID.to_string(), format!(r"Applications\{APP_KEY}")] {
            match classes.open_subkey_with_flags(&path, KEY_READ | KEY_WRITE) {
                Ok(key) => key
                    .set_value("NoOpenWith", &"")
                    .map_err(|e| format!("隐藏打开方式 {path}: {e}"))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("读取打开方式 {path}: {e}")),
            }
        }

        clean_legacy_extensions(&classes, true, repair_legacy_defaults)?;

        notify_shell_change();
        open_with_status()
    }

    fn delete_value_if_present(key: &RegKey, name: &str) -> Result<(), String> {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删除注册表值 {name}: {e}")),
        }
    }

    fn needs_legacy_default_repair(classes: &RegKey) -> bool {
        classes
            .open_subkey(format!(r"Applications\{APP_KEY}"))
            .ok()
            .and_then(|key| key.get_value::<u32, _>(REGISTRATION_VERSION_NAME).ok())
            .unwrap_or(0)
            < REGISTRATION_VERSION
    }

    fn clean_legacy_extensions(
        classes: &RegKey,
        unregister: bool,
        repair_legacy_defaults: bool,
    ) -> Result<(), String> {
        for ext in supported_file_extensions() {
            let dotted = format!(".{ext}");
            let ext_key = match classes.open_subkey_with_flags(&dotted, KEY_READ | KEY_WRITE) {
                Ok(key) => key,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("读取扩展名 {dotted}: {e}")),
            };
            let open_with =
                match ext_key.open_subkey_with_flags("OpenWithProgids", KEY_READ | KEY_WRITE) {
                    Ok(key) => key,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(format!("读取 OpenWithProgids {dotted}: {e}")),
                };
            let owned = open_with.get_raw_value(PROGID).is_ok();
            let default = ext_key.get_value::<String, _>("").ok();
            if repair_legacy_defaults && is_empty_legacy_default(owned, default.as_deref()) {
                // Remove only a blank override with our legacy marker. Windows
                // can then inherit its machine default (e.g. Notepad/batfile).
                delete_value_if_present(&ext_key, "")?;
            }
            if unregister || EDITOR_ONLY_EXTENSIONS.contains(&ext.as_str()) {
                delete_value_if_present(&open_with, PROGID)?;
            }
        }
        Ok(())
    }

    fn notify_shell_change() {
        #[link(name = "shell32")]
        extern "system" {
            fn SHChangeNotify(w_event_id: i32, u_flags: u32, dw_item1: isize, dw_item2: isize);
        }
        unsafe {
            SHChangeNotify(0x0800_0000, 0, 0, 0);
        }
    }
}

#[cfg(windows)]
pub use windows_impl::{open_with_status, register_open_with, unregister_open_with};

#[cfg(not(windows))]
pub fn open_with_status() -> Result<OpenWithStatus, String> {
    Ok(OpenWithStatus {
        registered: false,
        exe_path: String::new(),
        extensions: supported_open_with_extensions(),
        file_extensions: supported_file_extensions(),
        supported: false,
    })
}

#[cfg(not(windows))]
pub fn register_open_with() -> Result<OpenWithStatus, String> {
    Err("仅 Windows 支持注册「打开方式」".into())
}

#[cfg(not(windows))]
pub fn unregister_open_with() -> Result<OpenWithStatus, String> {
    Err("仅 Windows 支持取消注册「打开方式」".into())
}

#[tauri::command]
pub fn get_open_with_status() -> Result<OpenWithStatus, String> {
    open_with_status()
}

#[tauri::command]
pub fn register_file_open_with() -> Result<OpenWithStatus, String> {
    register_open_with()
}

#[tauri::command]
pub fn unregister_file_open_with() -> Result<OpenWithStatus, String> {
    unregister_open_with()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_with_extensions_are_text_and_exclude_office() {
        let exts = supported_open_with_extensions();
        assert!(exts.contains(&"ts".into()));
        assert!(exts.contains(&"md".into()));
        assert!(exts.contains(&"rs".into()));
        assert!(!exts.iter().any(|e| e == "xlsx"));
        assert!(!exts.iter().any(|e| e == "exe"));
        assert!(!exts.iter().any(|e| e == "bat" || e == "cmd"));
        let editable = supported_file_extensions();
        assert!(editable.iter().any(|ext| ext == "bat"));
        assert!(editable.iter().any(|ext| ext == "cmd"));
    }

    #[test]
    fn legacy_cleanup_only_removes_our_blank_default_override() {
        assert!(is_empty_legacy_default(true, Some("")));
        assert!(!is_empty_legacy_default(false, Some("")));
        assert!(!is_empty_legacy_default(true, None));
        assert!(!is_empty_legacy_default(true, Some("txtfilelegacy")));
        assert!(!is_empty_legacy_default(true, Some("batfile")));
        assert!(!is_empty_legacy_default(true, Some(PROGID)));
    }

    #[test]
    fn collect_cli_skips_flags_and_missing_files() {
        let args = vec![
            "QingCode.exe".into(),
            "--flag".into(),
            r"C:\this\path\should\not\exist-qingcode-test.txt".into(),
        ];
        assert!(collect_cli_file_paths(args).is_empty());
    }

    #[test]
    fn collect_cli_resolves_relative_files_against_second_instance_cwd() {
        let dir = std::env::temp_dir().join(format!("qingcode-open-with-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("README.md");
        std::fs::write(&file, "# test\n").unwrap();

        let paths = collect_cli_file_paths_from(
            vec!["QingCode.exe".into(), "README.md".into()],
            Some(&dir),
        );

        assert_eq!(paths, vec![file.to_string_lossy().into_owned()]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
