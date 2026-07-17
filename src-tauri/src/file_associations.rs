//! Windows "Open with" / ProgId registration for portable QingCode.exe.
//! Uses HKCU only (no admin). Registers text/code extensions the editor supports.

use serde::Serialize;
use std::path::Path;

const PROGID: &str = "QingCode.Document";
const APP_KEY: &str = "QingCode.exe";
const FRIENDLY_NAME: &str = "QingCode";

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
    "bat",
    "cmd",
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

#[derive(Debug, Serialize, Clone)]
pub struct OpenWithStatus {
    pub registered: bool,
    pub exe_path: String,
    pub extensions: Vec<String>,
    pub supported: bool,
}

/// Extensions we register for Open With.
pub fn supported_open_with_extensions() -> Vec<String> {
    OPEN_WITH_EXTENSIONS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

/// Collect file paths from process argv (skip exe and flag-like args).
pub fn collect_cli_file_paths(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| Path::new(arg).is_file())
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
            .open_subkey(format!(r"Software\Classes\{PROGID}\shell\open\command"))
            .ok()
            .and_then(|key| key.get_value::<String, _>("").ok())
            .map(|cmd| cmd.to_ascii_lowercase().contains("qingcode"))
            .unwrap_or(false);

        Ok(OpenWithStatus {
            registered,
            exe_path: exe.to_string_lossy().into_owned(),
            extensions: supported_open_with_extensions(),
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

        let prog = classes
            .create_subkey(PROGID)
            .map_err(|e| format!("无法创建 ProgId: {e}"))?
            .0;
        prog.set_value("", &FRIENDLY_NAME)
            .map_err(|e| format!("写入 ProgId 失败: {e}"))?;
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

        notify_shell_change();
        open_with_status()
    }

    pub fn unregister_open_with() -> Result<OpenWithStatus, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let classes = match hkcu.open_subkey_with_flags(r"Software\Classes", KEY_READ | KEY_WRITE) {
            Ok(k) => k,
            Err(_) => return open_with_status(),
        };

        let _ = classes.delete_subkey_all(PROGID);
        let _ = classes.delete_subkey_all(format!(r"Applications\{APP_KEY}"));

        for ext in supported_open_with_extensions() {
            let dotted = format!(".{ext}");
            if let Ok(ext_key) = classes.open_subkey_with_flags(&dotted, KEY_READ | KEY_WRITE) {
                if let Ok(open_with) =
                    ext_key.open_subkey_with_flags("OpenWithProgids", KEY_READ | KEY_WRITE)
                {
                    let _ = open_with.delete_value(PROGID);
                }
            }
        }

        notify_shell_change();
        open_with_status()
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
}
