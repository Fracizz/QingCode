//! Windows 脱离进程创建（CreateProcessW + 精确句柄继承）。
//!
//! 服务对象：`serve --detach`（main.rs）与 `connect --stdio` 拉起 daemon
//! （connect.rs）——都在 lib/bin 两端可用，所以放 lib。
//!
//! 为什么不走 std::process::Command：Windows 上 spawn 以 bInheritHandles=TRUE
//! 复制父进程全部可继承句柄，SSH exec 会话的 stdout 管道正在其中——子进程持有
//! 管道写端，sshd 永远等不到 EOF，客户端的 exec 通道就悬挂到超时（真机
//! 192.168.252.107 实测；无 PTY 会话里管道不是 stdio，GetStdHandle 关不掉）。
//! std 也没有暴露 PROC_THREAD_ATTRIBUTE_HANDLE_LIST 的口子，所以这里直接用
//! Win32 API 把继承严格限定在显式给出的句柄上（对齐 zed remote_server 的
//! spawn_server_normal：原生 API + 脱离标志，不经任何 shell）。

#![cfg(windows)]

use std::ffi::OsStr;
use std::path::Path;

/// 脱离进程的核心参数：真实 argv（不经 shell）、要精确继承的句柄、
/// 可选的 stdio 接管句柄。
pub struct DetachedSpawn {
    /// 完整命令行（含 exe，Windows 惯例：argv[0] 带引号路径）。
    pub command_line: String,
    /// PROC_THREAD_ATTRIBUTE_HANDLE_LIST 里的句柄；为空则完全不继承句柄。
    pub inherit: Vec<*mut core::ffi::c_void>,
    /// Some(handle) 时 stdin/stdout/stderr 全接它（serve 的日志句柄）。
    /// 句柄必须同时出现在 `inherit` 里才会传给子进程。
    pub stdio_handle: Option<*mut core::ffi::c_void>,
}

/// 由 CreateProcessW 拉起的子进程句柄，只保留 hProcess 供 `try_wait` 轮询。
pub struct WindowsChild {
    process: windows_sys::Win32::Foundation::HANDLE,
}

impl WindowsChild {
    /// 非阻塞探测退出状态：已退出返回退出码，未退出返回 None。
    pub fn try_wait(&self) -> std::io::Result<Option<u32>> {
        use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        // SAFETY: process 是 CreateProcessW 返回的合法句柄。
        let waited = unsafe { WaitForSingleObject(self.process, 0) };
        if waited == WAIT_FAILED {
            return Err(std::io::Error::last_os_error());
        }
        if waited != WAIT_OBJECT_0 {
            return Ok(None);
        }
        let mut code = 0u32;
        // SAFETY: 输出写入栈上 u32。
        if unsafe { GetExitCodeProcess(self.process, &mut code) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Some(code))
    }
}

impl Drop for WindowsChild {
    fn drop(&mut self) {
        // SAFETY: process 归本结构所有，drop 时关闭一次。
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.process) };
    }
}

/// 通用脱离 spawn：CREATE_NO_WINDOW + CREATE_BREAKAWAY_FROM_JOB，失败时去掉
/// BREAKAWAY 重试一次（sshd 的 Job 对象可能禁止 breakaway）。
///
/// 标志取舍：不用 DETACHED_PROCESS——serve 依赖 `tokio::signal::ctrl_c()`，
/// 需要宿主控制台存在；BREAKAWAY 让子进程脱离 sshd 的 Job 对象，exec 通道
/// 结束时不会被连坐。
pub fn spawn_detached(spawn: DetachedSpawn) -> Result<WindowsChild, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        UpdateProcThreadAttribute, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW,
        EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    let exe = std::env::current_exe().map_err(|e| format!("定位自身二进制失败: {e}"))?;
    let mut cmdline: Vec<u16> = spawn.command_line.encode_utf16().collect();
    cmdline.push(0);
    let exe_wide: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let dir: Option<Vec<u16>> = exe.parent().map(|dir| {
        dir.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    });

    // 属性列表：把可继承句柄限定为 spawn.inherit。UpdateProcThreadAttribute 只保存
    // 指向句柄数组的指针，数组必须活到 CreateProcessW 之后（放在函数作用域）；
    // 列表本身含内部指针，用 usize 缓冲保证指针对齐。无句柄可继承时跳过属性
    // 列表，并以 bInheritHandles=0 调用 CreateProcessW，从根上杜绝句柄泄漏。
    let mut handles: Vec<*mut core::ffi::c_void> = spawn.inherit;
    let mut attr_buf: Vec<usize>;
    let attr = if handles.is_empty() {
        std::ptr::null_mut()
    } else {
        let mut attr_size = 0usize;
        // SAFETY: 长度探测调用，输出写回 attr_size。
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size) };
        if attr_size == 0 {
            return Err("初始化进程属性列表失败".to_string());
        }
        attr_buf = vec![0usize; attr_size.div_ceil(std::mem::size_of::<usize>())];
        let attr = attr_buf.as_mut_ptr() as *mut core::ffi::c_void;
        // SAFETY: attr 指向对齐缓冲；handles 数组在本函数作用域内存活。
        let init_ok = unsafe { InitializeProcThreadAttributeList(attr, 1, 0, &mut attr_size) };
        let update_ok = unsafe {
            UpdateProcThreadAttribute(
                attr,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_mut_ptr() as *mut core::ffi::c_void,
                std::mem::size_of::<*mut core::ffi::c_void>() * handles.len(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if init_ok == 0 || update_ok == 0 {
            // SAFETY: DeleteProcThreadAttributeList 对未完成初始化的列表是允许的调用。
            unsafe { DeleteProcThreadAttributeList(attr) };
            return Err("配置进程句柄继承列表失败".to_string());
        }
        attr
    };
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    // SAFETY: STARTUPINFOEXW 是全零合法的 POD。
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    if let Some(stdio) = spawn.stdio_handle {
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = stdio;
        si.StartupInfo.hStdOutput = stdio;
        si.StartupInfo.hStdError = stdio;
    }
    if !attr.is_null() {
        si.lpAttributeList = attr;
    }
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let mut flags = if attr.is_null() {
        0
    } else {
        EXTENDED_STARTUPINFO_PRESENT
    } | CREATE_NO_WINDOW
        | CREATE_BREAKAWAY_FROM_JOB;
    let inherit_handles: i32 = i32::from(!handles.is_empty());
    // SAFETY: 参数按 Win32 契约传递；attr/attr_buf/handles 在调用期间保持存活。
    let mut spawned = unsafe {
        CreateProcessW(
            exe_wide.as_ptr(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            inherit_handles,
            flags,
            std::ptr::null(),
            dir.as_ref().map(|d| d.as_ptr()).unwrap_or(std::ptr::null()),
            &si as *const STARTUPINFOEXW as *const _,
            &mut pi,
        )
    } != 0;
    if !spawned {
        // sshd 的 Job 对象可能不允许 breakaway：去掉该标志重试一次。
        flags &= !CREATE_BREAKAWAY_FROM_JOB;
        // SAFETY: 同上。
        spawned = unsafe {
            CreateProcessW(
                exe_wide.as_ptr(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                inherit_handles,
                flags,
                std::ptr::null(),
                dir.as_ref().map(|d| d.as_ptr()).unwrap_or(std::ptr::null()),
                &si as *const STARTUPINFOEXW as *const _,
                &mut pi,
            )
        } != 0;
        if !spawned {
            if !attr.is_null() {
                // SAFETY: attr 已成功初始化。
                unsafe { DeleteProcThreadAttributeList(attr) };
            }
            // SAFETY: GetLastError 只是读取线程局部的最近错误码。
            let last_error = unsafe { GetLastError() };
            return Err(format!(
                "拉起脱离进程失败（两次，含/不含 breakaway），GetLastError={last_error}"
            ));
        }
    }

    if !attr.is_null() {
        // SAFETY: attr 已成功初始化，调用后不再使用。
        unsafe { DeleteProcThreadAttributeList(attr) };
    }
    // SAFETY: 线程句柄即刻关闭；进程句柄的所有权移交 WindowsChild。
    unsafe { windows_sys::Win32::Foundation::CloseHandle(pi.hThread) };
    Ok(WindowsChild {
        process: pi.hProcess,
    })
}

/// 命令行片段按 Windows 规则整体加引号（调用方保证值内不含引号字符）。
pub fn quote_windows_arg(value: &OsStr) -> String {
    format!("\"{}\"", value.to_string_lossy())
}

/// 由 connect 代理拉起 daemon：不继承任何句柄（日志由 daemon 自己写到 run
/// 目录），CREATE_NO_WINDOW + BREAKAWAY 脱离 SSH 会话。
pub fn spawn_detached_daemon(state_dir: Option<&Path>) -> Result<WindowsChild, String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位自身二进制失败: {e}"))?;
    let mut line = format!("{} daemon", quote_windows_arg(exe.as_os_str()));
    if let Some(dir) = state_dir {
        line.push_str(&format!(
            " --state-dir {}",
            quote_windows_arg(OsStr::new(dir))
        ));
    }
    spawn_detached(DetachedSpawn {
        command_line: line,
        inherit: Vec::new(),
        stdio_handle: None,
    })
}
