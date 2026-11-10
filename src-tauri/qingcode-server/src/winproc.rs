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
    /// 要启动的可执行文件；`None` 时启动当前进程自身。
    pub program: Option<std::path::PathBuf>,
}

/// 由 CreateProcessW 拉起的子进程句柄，只保留 hProcess 供 `try_wait` 轮询。
pub struct WindowsChild {
    process: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
    used_breakaway: bool,
}

impl WindowsChild {
    pub fn id(&self) -> u32 {
        self.pid
    }

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

/// 进程快照里的一项：只保留判定后代关系需要的字段。
struct ProcessEntry {
    pid: u32,
    parent: u32,
    name: String,
}

/// 枚举当前存活的进程；快照失败返回空，调用方按「没有后代」处理。
fn process_snapshot() -> Vec<ProcessEntry> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut entries = Vec::new();
    // SAFETY: 快照句柄只在本函数内使用并关闭；entry 是按 dwSize 初始化的栈上结构。
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return entries;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            entries.push(ProcessEntry {
                pid: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                name: String::from_utf16_lossy(&entry.szExeFile[..len]),
            });
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    entries
}

/// 进程创建时间（FILETIME，100ns）。无法打开进程时返回 `None`。
fn process_creation_time(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let empty = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (empty, empty, empty, empty);
    // SAFETY: 句柄只在本函数内使用并关闭；四个输出参数都是栈上 FILETIME。
    let ok = unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let ok = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
        CloseHandle(process);
        ok
    };
    (ok != 0).then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// 沿父进程关系查找存活的后代。Windows 的父 PID 不随父进程退出而失效，PID 还可能
/// 被复用，所以要求子进程不早于父进程创建。控制台宿主不计数，但继续向下查找。
fn any_live_descendant(
    root: u32,
    root_created: u64,
    entries: &[ProcessEntry],
    created: impl Fn(u32) -> Option<u64>,
) -> bool {
    let mut seen = std::collections::HashSet::from([root]);
    let mut stack = vec![(root, root_created)];
    while let Some((parent, parent_created)) = stack.pop() {
        for entry in entries.iter().filter(|entry| entry.parent == parent) {
            if !seen.insert(entry.pid) {
                continue;
            }
            let Some(entry_created) = created(entry.pid).filter(|time| *time >= parent_created)
            else {
                continue;
            };
            if !crate::pty::is_console_noise_process(&entry.name) {
                return true;
            }
            stack.push((entry.pid, entry_created));
        }
    }
    false
}

/// `root` 是否还有存活的后代进程。`root` 可以已经退出，只要调用方仍持有它的
/// 进程句柄（PID 不会被复用，创建时间也还能读到）。
pub fn has_live_descendants(root: u32) -> bool {
    let Some(root_created) = process_creation_time(root) else {
        return false;
    };
    any_live_descendant(
        root,
        root_created,
        &process_snapshot(),
        process_creation_time,
    )
}

#[cfg(test)]
mod descendant_tests {
    use super::*;

    fn entry(pid: u32, parent: u32, name: &str) -> ProcessEntry {
        ProcessEntry {
            pid,
            parent,
            name: name.to_string(),
        }
    }

    #[test]
    fn descendant_search_finds_program_below_console_host() {
        let entries = [entry(2, 1, "conhost.exe"), entry(3, 2, "claude.exe")];
        assert!(any_live_descendant(1, 10, &entries, |_| Some(20)));
    }

    #[test]
    fn descendant_search_ignores_console_host_only() {
        let entries = [entry(2, 1, "OpenConsole.exe")];
        assert!(!any_live_descendant(1, 10, &entries, |_| Some(20)));
    }

    #[test]
    fn descendant_search_rejects_stale_parent_pid() {
        // 比 root 更早创建：它的父 PID 指向的是被复用前的旧进程。
        let entries = [entry(2, 1, "unrelated.exe")];
        assert!(!any_live_descendant(1, 10, &entries, |_| Some(5)));
    }

    #[test]
    fn descendant_search_survives_parent_pid_cycles() {
        let entries = [entry(2, 3, "conhost.exe"), entry(3, 2, "conhost.exe")];
        assert!(!any_live_descendant(2, 10, &entries, |_| Some(20)));
    }
}

/// 让之后创建的子进程正常响应 Ctrl+C。
///
/// 「忽略 Ctrl+C」是进程属性，会被子进程继承：daemon 经 sshd 的 exec 会话拉起，
/// 这个属性一路继承下来，ConPTY 里的 PowerShell / cmd 就收不到 Ctrl+C，前台命令
/// 和 TUI 都无法中断（真机 252.45 实测）。`SetConsoleCtrlHandler(NULL, FALSE)`
/// 清掉本进程的忽略标记，之后创建的 PTY 子进程随之恢复默认处理；幂等，
/// 不影响已注册的处理函数（如 tokio 的 ctrl_c）。
pub fn restore_ctrl_c_for_children() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    // SAFETY: 处理函数为 NULL 时只修改本进程的 Ctrl+C 忽略标记。
    unsafe { SetConsoleCtrlHandler(None, 0) };
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

    let exe = match spawn.program {
        Some(program) => program,
        None => std::env::current_exe().map_err(|e| format!("定位自身二进制失败: {e}"))?,
    };
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
        let first_error = unsafe { GetLastError() };
        crate::diagnostics::record(
            "process.breakaway_failed",
            serde_json::json!({"osError":first_error}),
            true,
            false,
        );
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
        pid: pi.dwProcessId,
        used_breakaway: flags & CREATE_BREAKAWAY_FROM_JOB != 0,
    })
}

/// 当前进程所在的作业对象是否会在关闭时连带结束子进程，且不允许子进程脱离。
///
/// 典型场景是 `cargo run`（`pnpm tauri:dev`）：cargo 把自己和子进程放进带
/// KILL_ON_JOB_CLOSE 的作业对象，CREATE_BREAKAWAY_FROM_JOB 会以错误 5 失败，
/// 此时直接拉起的子进程会在 cargo 退出时被一起结束。不在作业里返回 false。
pub fn caller_job_kills_children() -> bool {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, QueryInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: 句柄为 NULL 时查询调用进程所属（最内层）的作业；不在作业里时调用失败。
    let ok = unsafe {
        QueryInformationJobObject(
            std::ptr::null_mut(),
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            std::ptr::null_mut(),
        )
    } != 0;
    ok && job_flags_kill_children(info.BasicLimitInformation.LimitFlags)
}

/// 由作业限制标志判断：关闭即结束子进程，且子进程既不能主动也不会自动脱离。
fn job_flags_kill_children(flags: u32) -> bool {
    use windows_sys::Win32::System::JobObjects::{
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0
        && flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) == 0
}

#[cfg(test)]
mod job_tests {
    use super::job_flags_kill_children;
    use windows_sys::Win32::System::JobObjects::{
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };

    #[test]
    fn kill_on_close_job_without_breakaway_kills_children() {
        assert!(job_flags_kill_children(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE));
    }

    #[test]
    fn job_allowing_breakaway_does_not_tie_children() {
        assert!(!job_flags_kill_children(0));
        assert!(!job_flags_kill_children(
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        ));
        assert!(!job_flags_kill_children(
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
        ));
    }
}

/// 以当前桌面的 Shell（explorer）为父进程拉起，让子进程归属 Shell 的作业而不是调用方的。
///
/// PROC_THREAD_ATTRIBUTE_PARENT_PROCESS 指定的父进程决定子进程的作业对象、令牌与
/// 可继承句柄，所以这里不继承任何句柄（调用方的句柄在 Shell 进程里无效）。
/// 没有交互桌面（Session 0、SSH 会话）时 GetShellWindow 为空，直接返回错误。
fn spawn_with_shell_parent(exe: &Path, command_line: &str) -> Result<WindowsChild, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        OpenProcess, UpdateProcThreadAttribute, CREATE_NO_WINDOW, EXTENDED_STARTUPINFO_PRESENT,
        PROCESS_CREATE_PROCESS, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
        STARTUPINFOEXW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId};

    // SAFETY: 两个调用只读取当前桌面的 Shell 窗口及其进程 id。
    let shell = unsafe { GetShellWindow() };
    if shell.is_null() {
        return Err("当前会话没有 Shell 窗口".to_string());
    }
    let mut shell_pid = 0u32;
    unsafe { GetWindowThreadProcessId(shell, &mut shell_pid) };
    if shell_pid == 0 {
        return Err("无法定位 Shell 进程".to_string());
    }
    // SAFETY: 只申请创建子进程所需的权限；句柄在本函数结束前关闭。
    let mut parent: HANDLE = unsafe { OpenProcess(PROCESS_CREATE_PROCESS, 0, shell_pid) };
    if parent.is_null() {
        return Err(format!("打开 Shell 进程失败，GetLastError={}", unsafe {
            GetLastError()
        }));
    }

    let mut attr_size = 0usize;
    // SAFETY: 长度探测调用，输出写回 attr_size。
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size) };
    let mut attr_buf = vec![0usize; attr_size.div_ceil(std::mem::size_of::<usize>()).max(1)];
    let attr = attr_buf.as_mut_ptr() as *mut core::ffi::c_void;
    // SAFETY: attr 指向对齐缓冲；`parent` 在 CreateProcessW 返回前保持存活。
    let ready = unsafe { InitializeProcThreadAttributeList(attr, 1, 0, &mut attr_size) } != 0
        && unsafe {
            UpdateProcThreadAttribute(
                attr,
                0,
                PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                &mut parent as *mut HANDLE as *mut core::ffi::c_void,
                std::mem::size_of::<HANDLE>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } != 0;
    if !ready {
        unsafe {
            DeleteProcThreadAttributeList(attr);
            CloseHandle(parent);
        }
        return Err("配置父进程属性失败".to_string());
    }

    let mut cmdline: Vec<u16> = command_line.encode_utf16().chain(Some(0)).collect();
    let exe_wide: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let dir: Option<Vec<u16>> = exe
        .parent()
        .map(|dir| dir.as_os_str().encode_wide().chain(Some(0)).collect());
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.lpAttributeList = attr;
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: 参数按 Win32 契约传递；不继承句柄，attr/parent 在调用期间存活。
    let spawned = unsafe {
        CreateProcessW(
            exe_wide.as_ptr(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            std::ptr::null(),
            dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            &si as *const STARTUPINFOEXW as *const _,
            &mut pi,
        )
    } != 0;
    let last_error = unsafe { GetLastError() };
    // SAFETY: attr 已初始化；parent 是上面打开的句柄。
    unsafe {
        DeleteProcThreadAttributeList(attr);
        CloseHandle(parent);
    }
    if !spawned {
        return Err(format!("以 Shell 为父进程拉起失败，GetLastError={last_error}"));
    }
    // SAFETY: 线程句柄即刻关闭；进程句柄的所有权移交 WindowsChild。
    unsafe { CloseHandle(pi.hThread) };
    Ok(WindowsChild {
        process: pi.hProcess,
        pid: pi.dwProcessId,
        used_breakaway: false,
    })
}

/// 命令行片段按 Windows 规则整体加引号（调用方保证值内不含引号字符）。
pub fn quote_windows_arg(value: &OsStr) -> String {
    format!("\"{}\"", value.to_string_lossy())
}

/// 由 connect 代理拉起 daemon：不继承任何句柄（日志由 daemon 自己写到 run
/// 目录），CREATE_NO_WINDOW + BREAKAWAY 脱离 SSH 会话。
pub fn spawn_detached_daemon(state_dir: Option<&Path>) -> Result<WindowsChild, String> {
    spawn_detached_daemon_with(None, state_dir, false)
}

/// 本进程最近一次带 `escape_caller_job` 拉起的 daemon 是否仍会随调用方的作业被结束。
static DAEMON_TIED_TO_CALLER_JOB: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 见 [`spawn_detached_daemon_with`] 的 `escape_caller_job`：没拉起过时为 false。
pub fn last_daemon_tied_to_caller_job() -> bool {
    DAEMON_TIED_TO_CALLER_JOB.load(std::sync::atomic::Ordering::SeqCst)
}

/// 同 [`spawn_detached_daemon`]，但可指定 daemon 可执行文件（桌面端本机 PTY 宿主用）。
///
/// `escape_caller_job`：调用方所在的作业对象会连带结束子进程且禁止脱离时（如
/// `cargo run`），改以 Shell 为父进程拉起，让 daemon 活过调用方；做不到时照常拉起，
/// 并通过 [`last_daemon_tied_to_caller_job`] 告知调用方 daemon 会随它结束。
pub fn spawn_detached_daemon_with(
    program: Option<&Path>,
    state_dir: Option<&Path>,
    escape_caller_job: bool,
) -> Result<WindowsChild, String> {
    let exe = match program {
        Some(program) => program.to_path_buf(),
        None => std::env::current_exe().map_err(|e| format!("定位自身二进制失败: {e}"))?,
    };
    let mut line = format!("{} daemon", quote_windows_arg(exe.as_os_str()));
    if let Some(dir) = state_dir {
        line.push_str(&format!(
            " --state-dir {}",
            quote_windows_arg(OsStr::new(dir))
        ));
    }
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    let run = crate::daemon::RunDir::resolve(state_dir)?;
    let log = run.dir().join("daemon.stderr.log");
    if std::fs::metadata(&log).is_ok_and(|meta| meta.len() > 5 * 1024 * 1024) {
        let archive = run.dir().join("daemon.stderr.log.1");
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::rename(&log, archive);
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .share_mode(1 | 2 | 4)
        .open(log)
        .map_err(|error| format!("打开 daemon stderr 日志失败: {error}"))?;
    let handle = file.as_raw_handle();
    // SAFETY: handle belongs to `file` and stays alive through CreateProcessW.
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
        return Err(format!(
            "设置 daemon 日志句柄失败: {}",
            std::io::Error::last_os_error()
        ));
    }
    let job_kills_children = escape_caller_job && caller_job_kills_children();
    let escaped = if job_kills_children {
        spawn_with_shell_parent(&exe, &line)
            .inspect_err(|error| {
                crate::diagnostics::record(
                    "process.job_escape_failed",
                    serde_json::json!({ "error": error }),
                    true,
                    false,
                );
            })
            .ok()
    } else {
        None
    };
    let shell_parent = escaped.is_some();
    let child = match escaped {
        Some(child) => Ok(child),
        None => spawn_inheriting_log(line, handle, exe),
    };
    if escape_caller_job {
        DAEMON_TIED_TO_CALLER_JOB.store(
            job_kills_children && !shell_parent && child.is_ok(),
            std::sync::atomic::Ordering::SeqCst,
        );
    }
    if let Ok(child) = &child {
        use std::io::Write;
        let _ = writeln!(
            file,
            "{}",
            serde_json::json!({"event":"daemon.detached_spawn", "timestampMs":crate::diagnostics::now_ms(),
            "daemonPid":child.pid,"breakawayUsed":child.used_breakaway,"shellParent":shell_parent})
        );
        let _ = file.sync_data();
    }
    drop(file);
    child
}

/// daemon 的常规拉起：stdio 接到 stderr 日志句柄。
fn spawn_inheriting_log(
    line: String,
    handle: *mut core::ffi::c_void,
    exe: std::path::PathBuf,
) -> Result<WindowsChild, String> {
    spawn_detached(DetachedSpawn {
        command_line: line,
        inherit: vec![handle],
        stdio_handle: Some(handle),
        program: Some(exe),
    })
}

/// Start the direct gateway without inheriting SSH stdio or console handles.
pub fn spawn_detached_direct(
    hostname: &str,
    port: u16,
    state_dir: Option<&Path>,
    require_daemon: bool,
) -> Result<WindowsChild, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    if hostname.is_empty()
        || !hostname
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".:-_".contains(&c))
    {
        return Err("直连监听地址无效".into());
    }
    let exe = std::env::current_exe().map_err(|e| format!("定位直连程序失败: {e}"))?;
    let mut command_line = format!(
        "{} direct --hostname {}",
        quote_windows_arg(exe.as_os_str()),
        quote_windows_arg(OsStr::new(hostname))
    );
    if port != 0 {
        command_line.push_str(&format!(" --port {port}"));
    }
    if require_daemon {
        command_line.push_str(" --require-daemon");
    }
    if let Some(dir) = state_dir {
        command_line.push_str(&format!(
            " --state-dir {}",
            quote_windows_arg(dir.as_os_str())
        ));
    }
    let run = crate::daemon::RunDir::resolve(state_dir)?;
    let dir = run.dir().join("direct");
    crate::direct::protect_private_directory(&dir)?;
    let log = dir.join("gateway.log");
    if std::fs::metadata(&log).is_ok_and(|m| m.len() > 5 * 1024 * 1024) {
        let _ = std::fs::remove_file(dir.join("gateway.log.1"));
        let _ = std::fs::rename(&log, dir.join("gateway.log.1"));
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .share_mode(1 | 2 | 4)
        .open(log)
        .map_err(|e| format!("打开直连日志失败: {e}"))?;
    let handle = file.as_raw_handle();
    // SAFETY: file retains this handle through CreateProcessW; only this log is inherited.
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
        return Err(format!(
            "设置直连日志句柄失败: {}",
            std::io::Error::last_os_error()
        ));
    }
    spawn_detached(DetachedSpawn {
        command_line,
        inherit: vec![handle],
        stdio_handle: Some(handle),
        program: None,
    })
}
