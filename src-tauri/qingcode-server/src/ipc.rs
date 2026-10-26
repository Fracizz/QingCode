//! daemon 的跨平台本地 IPC：Unix domain socket ↔ Windows named pipe。
//!
//! Unix：`run/daemon.sock` 上的 Unix socket，`run/daemon.lock` 上的 `flock`
//! 承担单实例锁；接受连接后用 `SO_PEERCRED` 校验对端 uid。
//!
//! Windows：命名管道 `\\.\pipe\qingcode-server-daemon-<hash>`（hash 取运行目录
//! 规范化路径的 SHA-256 前 16 个十六进制字符，同一用户目录唯一、不同用户不冲突；
//! 管道是机器级命名空间，不能像 socket 那样落在用户目录里）。安全与单实例全部
//! 由管道自身的 Win32 语义承担：
//!
//! - **DACL 只放行当前用户**（SDDL `D:P(A;;GA;;;<user-sid>)`），等价于
//!   `0700` 目录 + `SO_PEERCRED` 的组合防线——其他用户在 `CreateFileW` 阶段
//!   就被拒绝，根本到不了 token 校验；
//! - **`FILE_FLAG_FIRST_PIPE_INSTANCE` 天然是单实例锁**：另一个 daemon 进程
//!   持有任何实例时创建失败（`ERROR_ACCESS_DENIED`），语义与 flock 的
//!   `EWOULDBLOCK` 一致；进程退出句柄即释放，无需清理锁文件。
//!
//! 管道名同时写进 `run/pipe`，connect 侧优先读它（消除两侧路径拼写差异导致的
//! 派生不一致）；文件不存在时按同一规则派生（首次 spawn 前的探测）。
//!
//! connect 代理是纯阻塞 std IO 架构（见 `connect.rs` 模块注释），所以这里同时
//! 提供异步（daemon 接受连接、测试客户端）与阻塞（connect 的 `CreateFileW`
//! 同步句柄包成 `std::fs::File`）两套连接入口。

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncRead;

/// 由运行目录派生的 daemon 端点。
#[derive(Debug, Clone)]
pub struct IpcEndpoint {
    run_dir: PathBuf,
}

impl IpcEndpoint {
    pub fn new(run_dir: &Path) -> Self {
        Self {
            run_dir: run_dir.to_path_buf(),
        }
    }

    /// 人可读的端点描述（日志与错误信息用）。
    pub fn describe(&self) -> String {
        #[cfg(unix)]
        {
            self.socket_path().display().to_string()
        }
        #[cfg(windows)]
        {
            self.pipe_name()
        }
    }

    /// daemon 退出时清理落盘痕迹（socket 文件 / 管道名文件）。
    pub fn cleanup(&self) {
        #[cfg(unix)]
        let _ = std::fs::remove_file(self.socket_path());
        #[cfg(windows)]
        let _ = std::fs::remove_file(self.pipe_name_file());
    }

    /// 监听。`Ok(None)` 表示已有实例在运行（单实例锁被占），调用方按
    /// 「无需启动」处理——与 flock 抢不到时 `Ok(None)` 的语义保持一致。
    pub fn listen(&self) -> io::Result<Option<IpcListener>> {
        #[cfg(unix)]
        {
            self.listen_unix()
        }
        #[cfg(windows)]
        {
            self.listen_windows()
        }
    }

    /// 异步客户端连接（测试与 daemon 内部使用）。管道不存在 / 实例全忙时返回
    /// Err，由调用方决定重试。
    pub async fn connect(&self) -> io::Result<IpcStream> {
        #[cfg(unix)]
        {
            Ok(IpcStream::Unix(
                tokio::net::UnixStream::connect(self.socket_path()).await?,
            ))
        }
        #[cfg(windows)]
        {
            let stream =
                tokio::net::windows::named_pipe::ClientOptions::new().open(self.pipe_name())?;
            windows::verify_pipe_server_owner(std::os::windows::io::AsRawHandle::as_raw_handle(
                &stream,
            ) as _)?;
            Ok(IpcStream::PipeClient(stream))
        }
    }

    /// 阻塞客户端连接（Unix 的 `connect --stdio` 用）：返回一对可独立拥有的
    /// std 句柄。
    ///
    /// **Windows 限制**：返回的句柄是同步打开的非 overlapped 句柄，同一时刻只能
    /// 有一个在途 I/O——一边阻塞读时另一边写会得到 `ERROR_NO_DATA(232)`。因此
    /// 只适合「写完再读」的顺序场景（测试）；代理这类全双工用途必须走
    /// [`IpcEndpoint::connect`]（tokio overlapped 客户端）。
    ///
    /// Windows 侧带短重试：daemon 的 acceptor 在「实例已连接、下一个监听实例
    /// 尚未建好」的瞬间没有任何监听实例，此刻 CreateFileW 以
    /// FILE_NOT_FOUND / PIPE_BUSY 失败（真机 252.107 实测为间歇性）。25ms
    /// 间隔重试至多 2 秒，把这个窗口跨过去。
    pub fn blocking_connect(&self) -> io::Result<BlockingIpcPair> {
        self.blocking_connect_within(Duration::from_secs(2))
    }

    /// 同 [`IpcEndpoint::blocking_connect`]，Windows 瞬态重试上限由调用方给定。
    ///
    /// 「daemon 是否存活」的探测用短上限：daemon 被强杀后标记文件还在，管道却
    /// 已不存在，按 2 秒重试会让每次拉起前白等 2 秒（真机 252.45 实测）；跨过
    /// acceptor 补建实例的空窗只需几十毫秒。
    pub fn blocking_connect_within(&self, retry: Duration) -> io::Result<BlockingIpcPair> {
        #[cfg(unix)]
        {
            let _ = retry;
            let stream = std::os::unix::net::UnixStream::connect(self.socket_path())?;
            let read = stream
                .try_clone()
                .map_err(|e| io::Error::new(e.kind(), format!("复制 socket 句柄失败: {e}")))?;
            Ok(BlockingIpcPair {
                read: BlockingIo::Unix(read),
                write: BlockingIo::Unix(stream),
            })
        }
        #[cfg(windows)]
        {
            let deadline = std::time::Instant::now() + retry;
            let file = loop {
                match windows::open_pipe_sync(&self.pipe_name()) {
                    Ok(file) => break file,
                    Err(error) => {
                        let transient = matches!(
                            error.raw_os_error(),
                            Some(2) | Some(231) // ERROR_FILE_NOT_FOUND / ERROR_PIPE_BUSY
                        );
                        if !transient || std::time::Instant::now() >= deadline {
                            return Err(error);
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
            };
            let read = file
                .try_clone()
                .map_err(|e| io::Error::new(e.kind(), format!("复制管道句柄失败: {e}")))?;
            Ok(BlockingIpcPair {
                read: BlockingIo::WinFile(read),
                write: BlockingIo::WinFile(file),
            })
        }
    }

    #[cfg(unix)]
    fn socket_path(&self) -> PathBuf {
        self.run_dir.join("daemon.sock")
    }

    #[cfg(unix)]
    fn lock_path(&self) -> PathBuf {
        self.run_dir.join("daemon.lock")
    }

    #[cfg(unix)]
    fn listen_unix(&self) -> io::Result<Option<IpcListener>> {
        let lock = InstanceLock::acquire(&self.lock_path())?;
        let Some(lock) = lock else {
            return Ok(None);
        };
        // 抢到锁说明目录里的 socket 一定是上次崩溃的残留，删掉再绑。
        let socket = self.socket_path();
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket)?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
        }
        Ok(Some(IpcListener {
            listener,
            _lock: lock,
        }))
    }

    #[cfg(windows)]
    fn pipe_name_file(&self) -> PathBuf {
        self.run_dir.join("pipe")
    }

    /// 管道名：优先读 `run/pipe`（daemon 启动时写入），否则按运行目录派生。
    #[cfg(windows)]
    fn pipe_name(&self) -> String {
        if let Ok(record) = std::fs::read_to_string(self.pipe_name_file()) {
            let name = record.trim();
            if !name.is_empty() {
                return name.to_string();
            }
        }
        derive_pipe_name(&self.run_dir)
    }

    #[cfg(windows)]
    fn listen_windows(&self) -> io::Result<Option<IpcListener>> {
        let name = derive_pipe_name(&self.run_dir);
        // FIRST_PIPE_INSTANCE 创建失败且原因是「已有实例」时按单例锁被占处理。
        let first = match windows::create_pipe_instance(&name, true) {
            Ok(server) => server,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        // 写入管道名供 connect 发现；内容不可信也没关系（连接阶段自然失败）。
        std::fs::write(self.pipe_name_file(), &name)?;
        Ok(Some(IpcListener {
            pipe_name: name,
            pending: Some(first),
        }))
    }
}

/// 规范化运行目录路径（统一分隔符、去尾部分隔符、小写）后取 SHA-256 前 8 字节。
/// Windows 路径大小写不敏感，小写归一保证 `C:\Users\x` 与 `c:\users\X` 同名。
#[cfg(windows)]
pub fn derive_pipe_name(run_dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let normalized = run_dir
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    let hash = Sha256::digest(normalized.as_bytes());
    let prefix = u64::from_be_bytes(hash[..8].try_into().expect("SHA-256 至少 8 字节"));
    format!("\\\\.\\pipe\\qingcode-server-daemon-{prefix:016x}")
}

/// `flock` 单实例锁（Unix）。持有期间其他进程 `acquire` 返回 `None`。
#[cfg(unix)]
pub struct InstanceLock {
    _file: std::fs::File,
}

#[cfg(unix)]
impl InstanceLock {
    /// 非阻塞抢锁。`Ok(None)` 表示已有实例在运行。
    pub fn acquire(path: &Path) -> io::Result<Option<Self>> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)?;
        // SAFETY: flock 只作用于本进程持有的 fd，不涉及内存安全。
        // 并行测试（以及真实的 SIGCHLD）会让 flock 返回 EINTR。这不是抢锁结果，
        // 必须立刻重试；否则调用方会把「被信号打断」当成加锁失败。
        loop {
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result == 0 {
                return Ok(Some(Self { _file: file }));
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
                return Ok(None);
            }
            return Err(error);
        }
    }
}

/// daemon 侧监听器。Unix 上持有 flock（生命周期与监听绑定）；Windows 上
/// `pending` 是预先创建、等待客户端的下一个管道实例——必须在 `connect()`
/// 完成后立刻补建，否则并发连接会得到 `ERROR_PIPE_BUSY`。
pub struct IpcListener {
    #[cfg(unix)]
    listener: tokio::net::UnixListener,
    #[cfg(unix)]
    _lock: InstanceLock,
    #[cfg(windows)]
    pipe_name: String,
    #[cfg(windows)]
    pending: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
}

impl IpcListener {
    pub async fn accept(&mut self) -> io::Result<IpcStream> {
        #[cfg(unix)]
        {
            let (stream, _) = self.listener.accept().await?;
            Ok(IpcStream::Unix(stream))
        }
        #[cfg(windows)]
        {
            let server = match self.pending.take() {
                Some(server) => server,
                // 上一次补建失败后这里重试；仍失败说明管道创建有问题，如实上报。
                None => windows::create_pipe_instance(&self.pipe_name, false)?,
            };
            server.connect().await?;
            // 立刻补建下一个实例，让后续客户端能连上；失败不阻塞当前连接，
            // 下轮 accept 会再试一次。
            self.pending = windows::create_pipe_instance(&self.pipe_name, false).ok();
            Ok(IpcStream::PipeServer(server))
        }
    }
}

impl IpcListener {
    /// acceptor 独立任务 + mpsc 交付。
    ///
    /// 必须这样做而不能在  里直接  的原因：
    /// Windows 命名管道的 accept 在  挂起时持有「等待客户端的
    /// 实例」；select 的其他分支（如 interval 的首个 tick 立即就绪）一旦抢先，
    /// 挂起的 accept future 被整体丢弃，实例随之关闭——已经 CreateFile 成功、
    /// 写完 HELLO 的客户端会立刻读到 EOF。UnixListener::accept 没有这种
    /// 丢弃副作用，但统一走本路径无害且行为一致。mpsc  是取消安全的，
    /// 等待期间什么都不持有。
    pub fn spawn_acceptor(
        self,
        diagnostics: Option<std::sync::Arc<crate::daemon::Log>>,
    ) -> tokio::sync::mpsc::Receiver<IpcStream> {
        let (tx, rx) = tokio::sync::mpsc::channel::<IpcStream>(1);
        tokio::spawn(async move {
            let mut listener = self;
            let note = |message: &str| {
                if let Some(log) = diagnostics.as_ref() {
                    log.info(message);
                }
            };
            loop {
                match listener.accept().await {
                    Ok(stream) => {
                        // 幽灵连接校验：个别 Windows 版本上 ConnectNamedPipe 会
                        // 在没有真实客户端时立即完成。拿不到对端 pid 的实例直接
                        // 丢弃重建，绝不让它占住连接表等 10 秒握手超时。
                        if stream.verify_peer().is_err() {
                            note("acceptor: 丢弃幽灵连接");
                            #[cfg(windows)]
                            {
                                listener.pending = None;
                            }
                            continue;
                        }
                        if tx.send(stream).await.is_err() {
                            // 接收端（serve 循环）已退出，acceptor 一并收摊。
                            break;
                        }
                    }
                    Err(error) => {
                        note(&format!("accept 失败，重建实例: {error}"));
                        // 单次失败不退出：稍等重建实例，避免一个坏连接打死整个 accept 循环。
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        #[cfg(windows)]
                        {
                            listener.pending = None;
                        }
                    }
                }
            }
        });
        rx
    }
}

/// 一条已建立的 IPC 连接（daemon 接到的连接、测试与 connect 的异步客户端）。
pub enum IpcStream {
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
    #[cfg(windows)]
    PipeServer(tokio::net::windows::named_pipe::NamedPipeServer),
    #[cfg(windows)]
    PipeClient(tokio::net::windows::named_pipe::NamedPipeClient),
}

impl IpcStream {
    /// 校验对端身份，返回对端描述（日志用）。
    ///
    /// Unix：`SO_PEERCRED` 比对 uid。Windows：管道 DACL 已在连接阶段限制为
    /// 当前用户，这里只尽力取对端 pid 便于日志排查；测试用的客户端流没有
    /// 对端概念，描述为 in-process。
    pub fn verify_peer(&self) -> io::Result<String> {
        #[cfg(unix)]
        {
            match self {
                IpcStream::Unix(stream) => {
                    let cred = stream.peer_cred()?;
                    // SAFETY: geteuid 无副作用。
                    let self_uid = unsafe { libc::geteuid() };
                    let uid = cred.uid();
                    if uid != self_uid {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            format!("对端 uid {uid} 与本进程 {self_uid} 不符"),
                        ));
                    }
                    Ok(format!("uid={uid}"))
                }
                #[allow(unreachable_patterns)]
                _ => Ok("in-process".to_string()),
            }
        }
        #[cfg(windows)]
        {
            match self {
                IpcStream::PipeServer(server) => match windows::pipe_client_pid(server) {
                    Ok(pid) => Ok(format!("pid={pid}")),
                    Err(error) => Err(io::Error::new(
                        io::ErrorKind::NotConnected,
                        format!("管道无真实对端（幽灵连接）: {error}"),
                    )),
                },
                _ => Ok("in-process".to_string()),
            }
        }
    }
}

impl AsyncRead for IpcStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match &mut *self {
            #[cfg(unix)]
            IpcStream::Unix(stream) => std::pin::Pin::new(stream).poll_read(cx, buf),
            #[cfg(windows)]
            IpcStream::PipeServer(stream) => std::pin::Pin::new(stream).poll_read(cx, buf),
            #[cfg(windows)]
            IpcStream::PipeClient(stream) => std::pin::Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for IpcStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        match &mut *self {
            #[cfg(unix)]
            IpcStream::Unix(stream) => std::pin::Pin::new(stream).poll_write(cx, buf),
            #[cfg(windows)]
            IpcStream::PipeServer(stream) => std::pin::Pin::new(stream).poll_write(cx, buf),
            #[cfg(windows)]
            IpcStream::PipeClient(stream) => std::pin::Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match &mut *self {
            #[cfg(unix)]
            IpcStream::Unix(stream) => std::pin::Pin::new(stream).poll_flush(cx),
            #[cfg(windows)]
            IpcStream::PipeServer(stream) => std::pin::Pin::new(stream).poll_flush(cx),
            #[cfg(windows)]
            IpcStream::PipeClient(stream) => std::pin::Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match &mut *self {
            #[cfg(unix)]
            IpcStream::Unix(stream) => std::pin::Pin::new(stream).poll_shutdown(cx),
            #[cfg(windows)]
            IpcStream::PipeServer(stream) => std::pin::Pin::new(stream).poll_shutdown(cx),
            #[cfg(windows)]
            IpcStream::PipeClient(stream) => std::pin::Pin::new(stream).poll_shutdown(cx),
        }
    }
}

/// 阻塞 IO 半边（`connect --stdio` 用）。
pub enum BlockingIo {
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixStream),
    #[cfg(windows)]
    WinFile(std::fs::File),
}

impl BlockingIo {
    /// 半关闭写端：让 daemon 看到干净的 EOF，而不是等心跳超时。
    /// Windows 命名管道没有半关闭——不关写端，依赖本进程退出关闭句柄；
    /// daemon 侧心跳超时与句柄关闭都会触发相同的 detach 路径。
    pub fn shutdown_write(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            let BlockingIo::Unix(stream) = self;
            stream.shutdown(std::net::Shutdown::Write)?;
        }
        Ok(())
    }
}

impl std::io::Read for BlockingIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            BlockingIo::Unix(stream) => std::io::Read::read(stream, buf),
            #[cfg(windows)]
            BlockingIo::WinFile(file) => std::io::Read::read(file, buf),
        }
    }
}

impl std::io::Write for BlockingIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            BlockingIo::Unix(stream) => std::io::Write::write(stream, buf),
            #[cfg(windows)]
            BlockingIo::WinFile(file) => std::io::Write::write(file, buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            BlockingIo::Unix(stream) => std::io::Write::flush(stream),
            #[cfg(windows)]
            BlockingIo::WinFile(file) => std::io::Write::flush(file),
        }
    }
}

pub struct BlockingIpcPair {
    pub read: BlockingIo,
    pub write: BlockingIo,
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, GENERIC_READ, GENERIC_WRITE, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetLengthSid, GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};
    use windows_sys::Win32::System::Pipes::{
        GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    fn to_wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> io::Error {
        io::Error::last_os_error()
    }

    /// 当前用户 SID 的字符串形式（SDDL 语法用）。返回的缓冲由 LocalFree 释放。
    ///
    /// SAFETY: 只调用 Win32 查询接口；返回指针的所有权交给调用方。
    unsafe fn current_user_sid_string() -> io::Result<*mut u16> {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(last_error());
        }
        let mut length = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut length);
        if length == 0 {
            CloseHandle(token);
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "TokenInformation 长度查询失败",
            ));
        }
        let mut buffer = vec![0u8; length as usize];
        if GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut _,
            length,
            &mut length,
        ) == 0
        {
            let error = last_error();
            CloseHandle(token);
            return Err(error);
        }
        let user = buffer.as_ptr() as *const TOKEN_USER;
        let mut sid_text: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW((*user).User.Sid, &mut sid_text) == 0 {
            let error = last_error();
            CloseHandle(token);
            return Err(error);
        }
        CloseHandle(token);
        Ok(sid_text)
    }

    fn wide_to_string(pointer: *const u16) -> String {
        let mut length = 0usize;
        unsafe {
            while *pointer.add(length) != 0 {
                length += 1;
            }
        }
        let slice = unsafe { std::slice::from_raw_parts(pointer, length) };
        String::from_utf16_lossy(slice)
    }

    fn token_user_sid(token: HANDLE) -> io::Result<Vec<u8>> {
        let mut length = 0u32;
        // 第一次调用只查询所需长度；ERROR_INSUFFICIENT_BUFFER 是预期结果。
        unsafe {
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut length);
        }
        if length == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "TokenInformation 长度查询失败",
            ));
        }
        let mut buffer = vec![0u8; length as usize];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut _,
                length,
                &mut length,
            )
        } == 0
        {
            return Err(last_error());
        }
        let user = buffer.as_ptr() as *const TOKEN_USER;
        let sid = unsafe { (*user).User.Sid };
        let sid_length = unsafe { GetLengthSid(sid) } as usize;
        if sid_length == 0 || sid_length > buffer.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "TokenUser 返回了非法 SID",
            ));
        }
        Ok(unsafe { std::slice::from_raw_parts(sid as *const u8, sid_length) }.to_vec())
    }

    fn process_user_sid(process_id: u32) -> io::Result<Vec<u8>> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            return Err(last_error());
        }
        let mut token: HANDLE = std::ptr::null_mut();
        let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
        let open_error = last_error();
        unsafe {
            CloseHandle(process);
        }
        if opened == 0 {
            return Err(open_error);
        }
        let sid = token_user_sid(token);
        unsafe {
            CloseHandle(token);
        }
        sid
    }

    fn current_user_sid() -> io::Result<Vec<u8>> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(last_error());
        }
        let sid = token_user_sid(token);
        unsafe {
            CloseHandle(token);
        }
        sid
    }

    fn sid_bytes_match(left: &[u8], right: &[u8]) -> bool {
        if left.len() != right.len() {
            return false;
        }
        left.iter()
            .zip(right)
            .fold(0u8, |diff, (left, right)| diff | (left ^ right))
            == 0
    }

    /// 确认已连接命名管道的服务端进程属于当前用户。其他用户即使抢注了同名
    /// 管道并放开 DACL，也无法通过这一步，HELLO/token 不会发给攻击进程。
    pub(super) fn verify_pipe_server_owner(pipe: HANDLE) -> io::Result<u32> {
        let mut server_pid = 0u32;
        if unsafe { GetNamedPipeServerProcessId(pipe, &mut server_pid) } == 0 {
            return Err(last_error());
        }
        let server_sid = process_user_sid(server_pid)?;
        let current_sid = current_user_sid()?;
        if !sid_bytes_match(&server_sid, &current_sid) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("命名管道服务端 pid {server_pid} 不属于当前用户"),
            ));
        }
        Ok(server_pid)
    }

    /// 「仅当前用户完全访问」的安全描述符（D:P 表示无 ACE 匹配即拒绝）。
    fn user_only_sddl() -> io::Result<String> {
        // SAFETY: 指针所有权在本函数内闭环（LocalFree）。
        unsafe {
            let sid_pointer = current_user_sid_string()?;
            let sid = wide_to_string(sid_pointer);
            LocalFree(sid_pointer as _);
            Ok(format!("D:P(A;;GA;;;{sid})"))
        }
    }

    /// 持有 `SECURITY_ATTRIBUTES` 及其安全描述符，drop 时统一 LocalFree。
    struct SecurityAttributes {
        attributes: SECURITY_ATTRIBUTES,
        descriptor: *mut core::ffi::c_void,
        _sddl_wide: Vec<u16>,
    }

    impl SecurityAttributes {
        fn build(sddl: &str) -> io::Result<Self> {
            let wide = to_wide(OsStr::new(sddl));
            let mut descriptor: *mut core::ffi::c_void = std::ptr::null_mut();
            // SAFETY: SDDL 字符串是本函数构造的合法 UTF-16；descriptor 的释放
            // 由 Self::drop 负责。
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(last_error());
            }
            Ok(Self {
                attributes: SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor,
                    bInheritHandle: 0,
                },
                descriptor,
                _sddl_wide: wide,
            })
        }
    }

    impl Drop for SecurityAttributes {
        fn drop(&mut self) {
            // SAFETY: descriptor 由 ConvertStringSecurityDescriptor… 分配，仅此处释放。
            unsafe {
                LocalFree(self.descriptor);
            }
        }
    }

    /// 创建一个服务端管道实例。`first = true` 时带 `FILE_FLAG_FIRST_PIPE_INSTANCE`
    /// （单实例锁语义：其他进程已持有实例则返回 PermissionDenied）。
    /// DACL 只放行当前用户，CreateNamedPipeW 会拷贝描述符，之后的释放不影响管道。
    pub(super) fn create_pipe_instance(
        pipe_name: &str,
        first: bool,
    ) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
        let mut options = tokio::net::windows::named_pipe::ServerOptions::new();
        options.first_pipe_instance(first);
        // 254 是 CreateNamedPipeW 的显式上限（255 保留给 PIPE_UNLIMITED_INSTANCES），
        // 远高于 MAX_CONNS，只防实例配额意外耗尽。
        options.max_instances(254);
        let security = SecurityAttributes::build(&user_only_sddl()?)?;
        // SAFETY: security（及其内部描述符指针）在 create 返回前保持存活；
        // CreateNamedPipeW 会拷贝描述符，之后的 LocalFree 不影响已创建的管道。
        unsafe {
            options.create_with_security_attributes_raw(
                pipe_name,
                &security.attributes as *const SECURITY_ATTRIBUTES as *mut _,
            )
        }
    }

    /// 同步打开管道客户端句柄（阻塞 IO 的 connect 代理用）。
    pub(super) fn open_pipe_sync(pipe_name: &str) -> io::Result<std::fs::File> {
        let wide = to_wide(OsStr::new(pipe_name));
        // SAFETY: 常规 CreateFileW；句柄交给 File 接管生命周期。
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0, // 不带 FILE_FLAG_OVERLAPPED：同步读写
                std::ptr::null_mut(),
            )
        };
        if handle.is_null() || handle as usize == usize::MAX {
            return Err(last_error());
        }
        // SAFETY: handle 来自 CreateFileW 且未在其他地方使用。
        let file: std::fs::File =
            unsafe { std::os::windows::io::FromRawHandle::from_raw_handle(handle) };
        verify_pipe_server_owner(std::os::windows::io::AsRawHandle::as_raw_handle(&file) as _)?;
        Ok(file)
    }

    /// 取命名管道客户端的 pid（日志用；访问控制由 DACL 保证）。
    pub(super) fn pipe_client_pid(
        server: &tokio::net::windows::named_pipe::NamedPipeServer,
    ) -> io::Result<u32> {
        let mut pid = 0u32;
        // SAFETY: AsRawHandle 提供合法管道句柄；输出写入栈上 u32。
        unsafe {
            if GetNamedPipeClientProcessId(
                std::os::windows::io::AsRawHandle::as_raw_handle(server) as _,
                &mut pid,
            ) == 0
            {
                return Err(last_error());
            }
        }
        Ok(pid)
    }

    /// 测试：派生名对同一目录稳定、对不同目录不同。
    #[cfg(test)]
    #[test]
    fn derived_pipe_name_is_stable_and_case_insensitive() {
        use std::path::Path;
        let a = super::derive_pipe_name(Path::new(r"C:\Users\dev\.qingcode\server\run"));
        let b = super::derive_pipe_name(Path::new(r"c:/users/DEV/.qingcode/server/run/"));
        let c = super::derive_pipe_name(Path::new(r"C:\Users\other\.qingcode\server\run"));
        assert_eq!(a, b, "大小写与分隔符归一后应同名");
        assert_ne!(a, c);
        assert!(a.starts_with(r"\\.\pipe\qingcode-server-daemon-"));
    }

    /// 测试：DACL SDDL 能构造出来（含当前用户 SID），说明 token 查询链路可用。
    #[cfg(test)]
    #[test]
    fn user_only_sddl_contains_sid() {
        let sddl = user_only_sddl().unwrap();
        assert!(sddl.starts_with("D:P(A;;GA;;;"), "意外的前缀: {sddl}");
        assert!(sddl.len() > "D:P(A;;GA;;;".len(), "缺少 SID: {sddl}");
    }

    #[test]
    fn current_process_sid_can_be_read_and_matches_itself() {
        let process_sid = process_user_sid(unsafe {
            windows_sys::Win32::System::Threading::GetCurrentProcessId()
        })
        .unwrap();
        let token_sid = current_user_sid().unwrap();
        assert!(sid_bytes_match(&process_sid, &token_sid));
        assert!(!process_sid.is_empty());
    }
}

#[cfg(test)]
mod blocking_tests {
    /// 顺序两次 blocking 连接，第一次直接 drop（模拟代理进程退出）：
    /// 远端真机上第二次连接的写会拿到 ERROR_NO_DATA，先在本机复现。
    #[tokio::test]
    async fn blocking_connect_second_after_first_dropped() {
        let dir = std::env::temp_dir().join(format!(
            "qingcode-ipc-block2-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let run_dir = RunDir::resolve(Some(&dir)).unwrap();
        let options = DaemonOptions {
            state_dir: Some(dir.clone()),
            ..Default::default()
        };
        tokio::spawn(async move { crate::daemon::run_async(options).await });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if run_dir.ready_marker().exists() && run_dir.read_token().is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let token = run_dir.read_token().unwrap();
        let dir2 = dir.clone();
        let token2 = token.clone();
        // 第一次：连接后直接 drop 两半边（脏退，不 shutdown）。
        tokio::task::spawn_blocking(move || {
            let endpoint = IpcEndpoint::new(run_dir.dir());
            let pair = endpoint.blocking_connect().expect("first connect");
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(pair);
        })
        .await
        .unwrap();
        // 等 daemon 侧感知断开（心跳最长 45s？——脏退时读端立即 EOF，teardown 秒级）。
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let token = token2;
        let run_dir2 = RunDir::resolve(Some(&dir2)).unwrap();
        let endpoint = IpcEndpoint::new(run_dir2.dir());
        // 第二次：写 HELLO 应当成功并收到应答。
        let response = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let pair = endpoint.blocking_connect().expect("second connect");
            let hello = crate::proto::Frame::new(
                crate::proto::Kind::Hello,
                crate::proto::CONTROL_STREAM,
                crate::proto::encode(&crate::proto::HelloRequest {
                    client_id: "block2".into(),
                    protocol_min: crate::proto::PROTOCOL_VERSION,
                    protocol_max: crate::proto::PROTOCOL_VERSION,
                    token,
                    resume_token: None,
                })
                .unwrap(),
            )
            .encode()
            .unwrap();
            let mut writer = pair.write;
            std::io::Write::write_all(&mut writer, &hello).expect("second write HELLO");
            let mut reader = pair.read;
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            match reader.read(&mut chunk) {
                Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                other => panic!("second read got {other:?}"),
            }
            buf
        })
        .await
        .unwrap();
        assert_eq!(
            response[4],
            crate::proto::Kind::Hello as u8,
            "第二次连接应答异常"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;
    use crate::daemon::{DaemonOptions, RunDir};

    /// 复刻 connect --stdio 的完整路径：同步句柄连 daemon、写 HELLO、读应答。
    /// 远端真机发现该路径卡死（daemon 等不到 HELLO），先在本机复现。
    #[tokio::test]
    async fn blocking_connect_pipe_roundtrip_with_daemon() {
        let dir = std::env::temp_dir().join(format!(
            "qingcode-ipc-block-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let run_dir = RunDir::resolve(Some(&dir)).unwrap();
        let endpoint = IpcEndpoint::new(run_dir.dir());
        let options = DaemonOptions {
            state_dir: Some(dir.clone()),
            ..Default::default()
        };
        tokio::spawn(async move { crate::daemon::run_async(options).await });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if run_dir.ready_marker().exists() && run_dir.read_token().is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let token = run_dir.read_token().unwrap();
        let pair = tokio::task::spawn_blocking(move || {
            let pair = endpoint.blocking_connect().expect("blocking connect");
            // 上行：HELLO（经阻塞写半边）
            let hello = crate::proto::Frame::new(
                crate::proto::Kind::Hello,
                crate::proto::CONTROL_STREAM,
                crate::proto::encode(&crate::proto::HelloRequest {
                    client_id: "block-test".into(),
                    protocol_min: crate::proto::PROTOCOL_VERSION,
                    protocol_max: crate::proto::PROTOCOL_VERSION,
                    token: token.clone(),
                    resume_token: None,
                })
                .unwrap(),
            )
            .encode()
            .unwrap();
            let mut writer = pair.write;
            std::io::Write::write_all(&mut writer, &hello).expect("write HELLO");
            writer.shutdown_write().ok();
            pair.read
        })
        .await
        .unwrap();
        // 下行：读 HELLO 应答（阻塞读半边）
        let response = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut reader = pair;
            let mut head = [0u8; 4];
            reader.read_exact(&mut head).expect("read header");
            let len = u32::from_be_bytes(head) as usize - 5;
            let mut rest = vec![0u8; 5 + len];
            reader.read_exact(&mut rest).expect("read body");
            rest
        })
        .await
        .unwrap();
        eprintln!("DBG response bytes: {response:02x?}");
        // head 已被单独读掉，response 从帧类型字节开始。
        assert_eq!(
            response[0],
            crate::proto::Kind::Hello as u8,
            "应答不是 HELLO: {response:02x?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
