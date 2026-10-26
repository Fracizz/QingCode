//! Read-only metadata worker for Windows OpenSSH, whose SFTP REALPATH/LSTAT
//! do not reliably expose NTFS junctions. One lazy SSH channel is shared by
//! the cached SFTP session; it does not modify project files or install services.

use super::*;
use russh::ChannelStream;
use std::sync::Weak;

const GUARD_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_COMPONENTS: usize = 256;

// Windows OpenSSH can wedge a blocking .NET stdin read after the first reply.
// Peek before reading and consume only available bytes; replacing this reader
// with Console/StreamReader.ReadLine regresses repeated requests on real hosts.
const SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public sealed class QcGuardPipeInput {
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool PeekNamedPipe(IntPtr h, IntPtr b, uint n, IntPtr r, out uint a, IntPtr l);
  readonly IntPtr handle = GetStdHandle(-10);
  readonly Stream input = Console.OpenStandardInput();
  readonly byte[] buffer = new byte[4096];
  readonly List<byte> pending = new List<byte>();
  int position, count;
  public string ReadLine() {
    for (;;) {
      while (position < count) {
        byte b = buffer[position++];
        if (b == 10) {
          string line = new UTF8Encoding(false, true).GetString(pending.ToArray());
          pending.Clear();
          return line;
        }
        if (pending.Count >= 65536) throw new InvalidDataException("metadata input exceeds 64KB");
        pending.Add(b);
      }
      uint available;
      if (!PeekNamedPipe(handle, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero)) {
        int error = Marshal.GetLastWin32Error();
        if (error == 109 || error == 232 || error == 233) return null;
        throw new IOException("metadata stdin pipe error: " + error);
      }
      if (available == 0) { Thread.Sleep(10); continue; }
      count = input.Read(buffer, 0, (int)Math.Min(available, (uint)buffer.Length));
      position = 0;
      if (count == 0) return null;
    }
  }
}
'@
$inputReader = New-Object QcGuardPipeInput
[Console]::Out.WriteLine((@{ ready = 1; pid = $PID } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
while ($null -ne ($line = $inputReader.ReadLine())) {
  $answer = @{ id = 0; ok = $false; checked = 0; blocked = $null; error = $null }
  try {
    if ($line.Length -gt 65536) { throw 'metadata request too long' }
    $request = ConvertFrom-Json -InputObject $line
    $answer.id = [UInt64]$request.id
    $paths = @($request.paths)
    if ($answer.id -eq 0 -or $paths.Count -eq 0 -or $paths.Count -gt 256) { throw 'invalid metadata request' }
    foreach ($path in $paths) {
      if ($path -isnot [string] -or $path -notmatch '^[A-Za-z]:[\\/]') { throw 'absolute drive path required' }
      $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
      $answer.checked++
      if (([Int64]$item.Attributes -band [Int64][IO.FileAttributes]::ReparsePoint) -ne 0) {
        $answer.blocked = $path
        break
      }
    }
    $answer.ok = ($null -eq $answer.blocked)
  } catch { $answer.error = $_.Exception.Message }
  [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
"#;

#[derive(Serialize)]
struct Request<'a> {
    id: u64,
    paths: &'a [String],
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    id: u64,
    ok: bool,
    checked: usize,
    blocked: Option<String>,
    error: Option<String>,
}

struct JsonSession<S> {
    io: S,
    buffer: Vec<u8>,
    in_flight: bool,
}

impl<S: AsyncRead + AsyncWrite + Unpin> JsonSession<S> {
    fn new(io: S) -> Self {
        Self {
            io,
            buffer: Vec::new(),
            in_flight: false,
        }
    }

    async fn exchange(&mut self, id: u64, paths: &[String]) -> Result<Response, String> {
        // A cancelled write/read may have left a partial request or an unread
        // response. Never reuse it for another caller, even if its next line is OK.
        if self.in_flight {
            return Err("Windows 路径校验上次请求已取消，需要重建元数据通道".into());
        }
        if paths.is_empty() || paths.len() > MAX_COMPONENTS {
            return Err("Windows 路径组件数量超过校验上限".into());
        }
        let mut bytes = serde_json::to_vec(&Request { id, paths }).map_err(|e| e.to_string())?;
        bytes.extend_from_slice(b"\r\n");
        if bytes.len() > MAX_LINE_BYTES {
            return Err("Windows 路径校验请求超过 64KB".into());
        }
        self.in_flight = true;
        self.io
            .write_all(&bytes)
            .await
            .map_err(|e| format!("发送 Windows 路径校验失败：{e}"))?;
        let line = loop {
            if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                break self.buffer.drain(..=end).collect::<Vec<_>>();
            }
            let remaining = MAX_LINE_BYTES.saturating_sub(self.buffer.len());
            if remaining == 0 {
                return Err("Windows 路径校验应答超过 64KB".into());
            }
            let mut chunk = [0; 4096];
            let capacity = remaining.min(chunk.len());
            let read = self
                .io
                .read(&mut chunk[..capacity])
                .await
                .map_err(|e| format!("读取 Windows 路径校验应答失败：{e}"))?;
            if read == 0 {
                return Err("Windows 路径校验通道已关闭".into());
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        };
        let response: Response =
            serde_json::from_slice(&line).map_err(|e| format!("Windows 路径校验应答无效：{e}"))?;
        if response.id != id {
            return Err("Windows 路径校验应答序号不匹配，已拒绝访问".into());
        }
        let allowed = response.ok
            && response.blocked.is_none()
            && response.error.is_none()
            && response.checked == paths.len();
        let blocked = !response.ok
            && response.error.is_none()
            && response.blocked.as_ref().is_some_and(|p| paths.contains(p))
            && response.checked > 0
            && response.checked <= paths.len();
        let failed = !response.ok
            && response.blocked.is_none()
            && response.error.as_ref().is_some_and(|e| !e.is_empty());
        if !allowed && !blocked && !failed {
            return Err("Windows 路径校验应答不完整，已拒绝访问".into());
        }
        self.in_flight = false;
        Ok(response)
    }
}

type GuardSession = JsonSession<ChannelStream<client::Msg>>;

#[derive(Default)]
struct GuardCache {
    session: Option<GuardSession>,
    opening: Option<tokio::sync::oneshot::Receiver<Result<OpeningChannel, String>>>,
}

fn worker_command() -> Result<String, String> {
    // Indentation is immaterial to this script/C# type; trim it to leave room
    // below cmd.exe's limit without falling back to stdin script execution.
    let script = SCRIPT.lines().map(str::trim).collect::<Vec<_>>().join("\n");
    windows_powershell_inline_command(&script).ok_or_else(|| "Windows 路径校验脚本过长".into())
}

async fn wait_worker_ready(opening: &mut OpeningChannel) -> Result<u32, String> {
    let mut confirmed = false;
    let mut ready = false;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut worker_pid = 0;
    while !confirmed || !ready {
        match opening.0.as_mut().unwrap().wait().await {
            Some(ChannelMsg::Success) => {
                confirmed = true;
                #[cfg(test)]
                eprintln!("Windows metadata guard exec confirmed");
            }
            Some(ChannelMsg::Failure) => return Err("远端拒绝启动 Windows 路径校验通道".into()),
            Some(ChannelMsg::Data { data }) => {
                if stdout.len() + data.len() > MAX_LINE_BYTES {
                    return Err("Windows 路径校验启动应答超过 64KB".into());
                }
                stdout.extend_from_slice(&data);
                if let Some(end) = stdout.iter().position(|b| *b == b'\n') {
                    let value: serde_json::Value = serde_json::from_slice(&stdout[..=end])
                        .map_err(|e| format!("Windows 路径校验启动应答无效：{e}"))?;
                    if value["ready"] != 1
                        || !value["pid"]
                            .as_u64()
                            .is_some_and(|pid| pid > 0 && pid <= u32::MAX as u64)
                        || value.as_object().is_none_or(|object| object.len() != 2)
                        || end + 1 != stdout.len()
                    {
                        return Err("Windows 路径校验启动应答不匹配".into());
                    }
                    ready = true;
                    worker_pid = value["pid"].as_u64().unwrap() as u32;
                    #[cfg(test)]
                    eprintln!("Windows metadata guard READY received");
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                let count = data.len().min(1024usize.saturating_sub(stderr.len()));
                stderr.extend_from_slice(&data[..count]);
            }
            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                return Err(format!(
                    "Windows 路径校验启动通道已关闭：{}",
                    String::from_utf8_lossy(&stderr)
                ))
            }
            _ => {}
        }
    }
    Ok(worker_pid)
}

/// Until exec succeeds, a plain russh Channel does not have ChannelStream's
/// close-on-drop protection. Preserve that cleanup on cancellation as well.
struct OpeningChannel(Option<russh::Channel<client::Msg>>);

impl Drop for OpeningChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(1), channel.eof()).await;
                let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
            });
        }
    }
}

#[derive(Default)]
pub(super) struct WindowsPathGuard {
    cache: tokio::sync::Mutex<GuardCache>,
    next_id: AtomicU64,
    #[cfg(test)]
    starts: AtomicU64,
    #[cfg(test)]
    pid: AtomicU64,
}

impl Drop for WindowsPathGuard {
    fn drop(&mut self) {
        // ChannelStream's own Drop calls tokio::spawn. Application state may be
        // destroyed by Tauri's main thread with no entered Tokio runtime.
        if let Some(mut session) = self.cache.get_mut().session.take() {
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(1), session.io.shutdown()).await;
                drop(session);
            });
        }
    }
}

impl WindowsPathGuard {
    #[cfg(test)]
    pub(super) fn worker_starts(&self) -> u64 {
        self.starts.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(super) fn worker_pid(&self) -> u32 {
        self.pid.load(Ordering::Relaxed) as u32
    }

    pub(super) async fn check(
        &self,
        transport: &Weak<ConnectedSession>,
        path: &str,
    ) -> Result<(), String> {
        if let Some(component) = self.first_reparse_component(transport, path).await? {
            return Err(format!(
                "Windows SSH 项目暂不支持符号链接或 Junction 路径，为防止跳出项目根目录已拒绝访问：{component}"
            ));
        }
        Ok(())
    }

    pub(super) async fn first_reparse_component(
        &self,
        transport: &Weak<ConnectedSession>,
        path: &str,
    ) -> Result<Option<String>, String> {
        let paths: Vec<_> = windows_sftp_guard_components(path)
            .iter()
            .map(|p| windows_native_path(p).ok_or("Windows 路径组件格式无效"))
            .collect::<Result<_, _>>()?;
        if paths.is_empty() {
            return Ok(None);
        }
        let deadline = tokio::time::Instant::now() + GUARD_TIMEOUT;
        let mut cache = tokio::time::timeout_at(deadline, self.cache.lock())
            .await
            .map_err(|_| "等待 Windows 路径校验超时，已拒绝访问".to_string())?;
        if cache.session.as_ref().is_some_and(|s| s.in_flight) {
            // The previous caller was cancelled. Shutdown sends EOF and dropping
            // ChannelStream sends CLOSE before another worker is opened.
            if let Some(mut stale) = cache.session.take() {
                let _ = tokio::time::timeout(Duration::from_secs(1), stale.io.shutdown()).await;
            }
        }
        let result = tokio::time::timeout_at(deadline, async {
            if cache.session.is_none() {
                if cache.opening.is_none() {
                    let transport = transport
                        .upgrade()
                        .ok_or("SSH 连接已关闭，无法校验 Windows 路径")?;
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    cache.opening = Some(rx);
                    // Own the pending open until its confirmation arrives. If a
                    // caller times out, retain this receiver instead of opening
                    // unlimited replacement channels. Dropping the cache makes
                    // a late result close itself through OpeningChannel's Drop.
                    tauri::async_runtime::spawn(async move {
                        let opened = transport
                            .handle
                            .channel_open_session()
                            .await
                            .map(|channel| OpeningChannel(Some(channel)))
                            .map_err(|e| format!("打开 Windows 路径校验通道失败：{e}"));
                        let _ = tx.send(opened);
                    });
                }
                let command = worker_command()?;
                let opened = cache.opening.as_mut().unwrap().await;
                cache.opening = None;
                let mut opening = opened.map_err(|_| "Windows 路径校验通道任务已结束")??;
                opening
                    .0
                    .as_ref()
                    .unwrap()
                    .exec(true, command)
                    .await
                    .map_err(|e| format!("启动 Windows 路径校验失败：{e}"))?;
                // Windows OpenSSH can accept DATA before its process stdin is
                // connected. Wait for both SSH exec confirmation and script READY.
                let _worker_pid = wait_worker_ready(&mut opening).await?;
                cache.session = Some(JsonSession::new(opening.0.take().unwrap().into_stream()));
                #[cfg(test)]
                self.starts.fetch_add(1, Ordering::Relaxed);
                #[cfg(test)]
                self.pid.store(u64::from(_worker_pid), Ordering::Relaxed);
            }
            let id = self
                .next_id
                .fetch_add(1, Ordering::Relaxed)
                .checked_add(1)
                .ok_or("Windows 路径校验请求序号已耗尽")?;
            cache.session.as_mut().unwrap().exchange(id, &paths).await
        })
        .await
        .unwrap_or_else(|_| Err("Windows 路径校验超过 15 秒，已拒绝访问".into()));
        match result {
            Ok(response) if response.ok => Ok(None),
            Ok(response) if response.blocked.is_some() => Ok(response.blocked),
            Ok(response) => Err(format!(
                "无法校验 Windows 远程路径，已拒绝访问：{}",
                response.error.unwrap_or_default()
            )),
            Err(error) => {
                if let Some(mut failed) = cache.session.take() {
                    let _ =
                        tokio::time::timeout(Duration::from_secs(1), failed.io.shutdown()).await;
                }
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    fn paths() -> Vec<String> {
        vec![r"C:\project\file.txt".into()]
    }

    #[test]
    fn guard_script_fits_windows_command_limit_without_stdin_fallback() {
        let command = worker_command().unwrap();
        assert!(command.len() <= WINDOWS_INLINE_COMMAND_LIMIT);
        assert!(command.len() < 7600, "leave space for command-line quoting");
    }

    #[tokio::test]
    async fn guard_reuses_one_stream_with_unique_response_ids() {
        let (client, server) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move {
            let mut server = BufReader::new(server);
            for id in [1, 2] {
                let mut line = String::new();
                server.read_line(&mut line).await.unwrap();
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&line).unwrap()["id"],
                    id
                );
                server.get_mut().write_all(format!("{{\"id\":{id},\"ok\":true,\"checked\":1,\"blocked\":null,\"error\":null}}\n").as_bytes()).await.unwrap();
            }
        });
        let mut session = JsonSession::new(client);
        for id in [1, 2] {
            assert!(session.exchange(id, &paths()).await.unwrap().ok);
        }
        task.await.unwrap();
    }

    #[tokio::test]
    async fn guard_rejects_wrong_id_incomplete_reply_oversize_and_eof() {
        for reply in [
            b"{\"id\":2,\"ok\":true,\"checked\":1}\n".to_vec(),
            b"{\"id\":1,\"ok\":true,\"checked\":0}\n".to_vec(),
            vec![b'x'; MAX_LINE_BYTES + 1],
            Vec::new(),
        ] {
            let (client, server) = tokio::io::duplex(MAX_LINE_BYTES + 1024);
            let task = tokio::spawn(async move {
                let mut server = BufReader::new(server);
                let mut line = String::new();
                server.read_line(&mut line).await.unwrap();
                server.get_mut().write_all(&reply).await.unwrap();
            });
            let mut session = JsonSession::new(client);
            assert!(session.exchange(1, &paths()).await.is_err());
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn guard_cancelled_request_cannot_consume_a_stale_allow_response() {
        let (client, _server) = tokio::io::duplex(4096);
        let mut session = JsonSession::new(client);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), session.exchange(1, &paths()))
                .await
                .is_err()
        );
        assert!(session.in_flight);
        let error = session.exchange(2, &paths()).await.unwrap_err();
        assert!(error.contains("上次请求已取消"));
    }

    #[tokio::test]
    async fn guard_pending_opener_survives_timeout_without_another_open() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut cache = GuardCache {
            opening: Some(rx),
            ..Default::default()
        };
        for _ in 0..2 {
            assert!(tokio::time::timeout(
                Duration::from_millis(10),
                cache.opening.as_mut().unwrap()
            )
            .await
            .is_err());
            assert!(
                !tx.is_closed(),
                "caller timeout must retain the single pending opener"
            );
        }
        assert!(tx.send(Err("delayed open failure".to_string())).is_ok());
        assert!(
            matches!(cache.opening.as_mut().unwrap().await, Ok(Err(error)) if error == "delayed open failure")
        );
    }
}
