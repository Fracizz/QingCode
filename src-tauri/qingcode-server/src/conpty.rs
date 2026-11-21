//! Windows：随程序携带新版 ConPTY（conpty.dll + OpenConsole.exe），不用系统自带的 conhost。
//!
//! 系统自带的 conhost 会吞掉「切换控制台输入模式之前」请求的鼠标上报：pi 全屏模式先进备用屏幕、
//! 后切 raw 模式，xterm 就收不到 `?1000h/?1006h`，滚轮被转成方向键去翻输入历史。
//! Windows Terminal / VS Code 携带的新版 OpenConsole 会把这些请求透传给终端。
//!
//! `portable-pty` 会优先按名加载 `conpty.dll`（找不到才用 kernel32）。这里在首次创建终端前
//! 把嵌入的文件释放到 `%LOCALAPPDATA%\QingCode\conpty\<版本>-<架构>\`（布局与官方 NuGet 包一致：
//! `conpty.dll` 旁的 `<架构>\OpenConsole.exe`），校验 SHA-256 后按完整路径预加载 `conpty.dll`；
//! 已加载同名模块时 `LoadLibrary("conpty.dll")` 直接复用它，不改变进程的 DLL 搜索路径。
//! 任何一步失败都静默退回系统 ConPTY；`QINGCODE_INBOX_CONPTY=1` 可强制退回。
//! 文件来源与摘要见 `vendor/conpty/README.md`。

/// 在创建第一个 ConPTY 之前调用；重复调用无开销，非 Windows 平台为空操作。
pub fn prefer_bundled_conpty() {
    #[cfg(all(windows, any(target_arch = "x86_64", target_arch = "aarch64")))]
    imp::ensure();
}

#[cfg(windows)]
use std::path::Path;

/// 目标文件内容与 `bytes` 不一致（缺失、损坏、旧版本）时原子替换；一致时不写盘。
/// 替换失败（例如文件正被其他进程加载）时，若此时内容已一致也视为成功。
#[cfg(windows)]
fn install(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use sha2::{Digest, Sha256};
    let expected = Sha256::digest(bytes);
    let matches =
        |path: &Path| std::fs::read(path).is_ok_and(|data| Sha256::digest(data) == expected);
    if matches(path) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("ConPTY 释放路径没有上级目录"))?;
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("conpty");
    let temp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temp, bytes)?;
    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            if matches(path) {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(all(windows, any(target_arch = "x86_64", target_arch = "aarch64")))]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::sync::Once;

    use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;

    /// 与 `vendor/conpty/README.md` 记录的 NuGet 包版本一致；升级时一并修改，换用新的释放目录。
    const CONPTY_VERSION: &str = "1.25.261109001";

    #[cfg(target_arch = "x86_64")]
    const ARCH: &str = "x64";
    #[cfg(target_arch = "aarch64")]
    const ARCH: &str = "arm64";

    #[cfg(target_arch = "x86_64")]
    const CONPTY_DLL: &[u8] = include_bytes!("../vendor/conpty/x64/conpty.dll");
    #[cfg(target_arch = "x86_64")]
    const OPEN_CONSOLE: &[u8] = include_bytes!("../vendor/conpty/x64/OpenConsole.exe");
    #[cfg(target_arch = "aarch64")]
    const CONPTY_DLL: &[u8] = include_bytes!("../vendor/conpty/arm64/conpty.dll");
    #[cfg(target_arch = "aarch64")]
    const OPEN_CONSOLE: &[u8] = include_bytes!("../vendor/conpty/arm64/OpenConsole.exe");

    static ONCE: Once = Once::new();

    pub(super) fn ensure() {
        ONCE.call_once(|| {
            if std::env::var_os("QINGCODE_INBOX_CONPTY").is_some_and(|value| value == "1") {
                return;
            }
            if let Err(error) = load() {
                eprintln!("[WARN] 新版 ConPTY 不可用，退回系统 ConPTY：{error}");
            }
        });
    }

    fn load() -> Result<(), String> {
        let base = std::env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or("LOCALAPPDATA 未设置")?;
        let dir = base
            .join("QingCode")
            .join("conpty")
            .join(format!("{CONPTY_VERSION}-{ARCH}"));
        let dll = dir.join("conpty.dll");
        // OpenConsole 先就位：conpty.dll 创建伪控制台时才去找它，找不到会退回 conhost。
        super::install(&dir.join(ARCH).join("OpenConsole.exe"), OPEN_CONSOLE)
            .map_err(|error| format!("释放 OpenConsole.exe 失败：{error}"))?;
        super::install(&dll, CONPTY_DLL)
            .map_err(|error| format!("释放 conpty.dll 失败：{error}"))?;
        let wide: Vec<u16> = dll
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // 模块常驻进程生命周期，不调用 FreeLibrary。
        let module = unsafe { LoadLibraryW(wide.as_ptr()) };
        if module.is_null() {
            return Err(format!(
                "加载 conpty.dll 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::install;

    /// 回归：程序在 cooked 模式下请求鼠标上报（pi 全屏启动时即如此），系统 conhost 会吞掉，
    /// 新版 OpenConsole 必须原样透传给终端。
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    #[test]
    fn bundled_conpty_forwards_mouse_mode_requested_before_raw_input() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;

        super::prefer_bundled_conpty();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/d", "/c", "echo \x1b[?1003h\x1b[?1006hQC-MOUSE-MARK"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 || sender.send(buffer[..count].to_vec()).is_err() {
                    break;
                }
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains("QC-MOUSE-MARK") {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match receiver.recv_timeout(left) {
                Ok(chunk) => output.extend(chunk),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("QC-MOUSE-MARK"), "未读到输出：{text:?}");
        assert!(
            text.contains("\x1b[?1003h") && text.contains("\x1b[?1006h"),
            "鼠标上报被吞：{text:?}"
        );
    }

    #[test]
    fn install_writes_missing_file_and_repairs_mismatched_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arch").join("OpenConsole.exe");
        install(&path, b"new console").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new console");

        std::fs::write(&path, b"tampered").unwrap();
        install(&path, b"new console").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new console");
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["OpenConsole.exe"]);
    }

    #[test]
    fn install_keeps_matching_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conpty.dll");
        std::fs::write(&path, b"same").unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        install(&path, b"same").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            before
        );
    }

    #[test]
    fn install_reports_a_locked_target_with_stale_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conpty.dll");
        std::fs::write(&path, b"old").unwrap();
        // 模拟正被加载：不允许删除/替换时，内容不一致必须报错。
        use std::os::windows::fs::OpenOptionsExt;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1) // FILE_SHARE_READ
            .open(&path)
            .unwrap();
        assert!(install(&path, b"new").is_err());
        drop(lock);
        install(&path, b"new").unwrap();
    }
}
