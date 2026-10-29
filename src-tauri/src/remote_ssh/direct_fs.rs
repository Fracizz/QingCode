//! SFTP-compatible workspace adapter over the authenticated Agent HTTP API.
//! File handles are issued by the server and retain the opened file identity;
//! chunks are bounded and never reopen an arbitrary client-supplied path.

use super::direct::{DirectConnectionConfig, WorkspaceClient};
use russh_sftp::client::error::Error;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde_json::{json, Value};
use std::future::Future;
use std::io::{self, SeekFrom};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncWrite, AsyncWriteExt, ReadBuf};

type Result<T> = std::result::Result<T, Error>;
type ReadRequest = Pin<Box<dyn Future<Output = io::Result<Vec<u8>>> + Send>>;
type WriteRequest = Pin<Box<dyn Future<Output = io::Result<usize>> + Send>>;
const CHUNK: usize = 128 * 1024;

#[derive(Clone)]
pub(super) struct DirectFs {
    client: Arc<WorkspaceClient>,
    root: Option<String>,
    trusted: bool,
}

impl DirectFs {
    pub(super) fn new(config: DirectConnectionConfig, root: Option<String>, trusted: bool) -> Self {
        Self {
            client: Arc::new(WorkspaceClient::new(config)),
            root,
            trusted,
        }
    }

    async fn request(&self, op: &str, mut params: Value) -> Result<Value> {
        params["op"] = json!(op);
        params["root"] = json!(self.root);
        params["trusted"] = json!(self.trusted);
        self.client.request(&params).await.map_err(Error::IO)
    }

    pub(super) async fn canonicalize(&self, path: String) -> Result<String> {
        let value = self.request("canonicalize", json!({"path":path})).await?;
        value
            .as_str()
            .map(str::to_string)
            .ok_or(Error::UnexpectedPacket)
    }

    pub(super) async fn metadata(&self, path: String, symlink: bool) -> Result<FileAttributes> {
        let value = self
            .request(
                if symlink {
                    "symlink_metadata"
                } else {
                    "metadata"
                },
                json!({"path":path}),
            )
            .await?;
        attributes(value)
    }

    pub(super) async fn exists(&self, path: String) -> Result<bool> {
        self.request("exists", json!({"path":path}))
            .await?
            .as_bool()
            .ok_or(Error::UnexpectedPacket)
    }

    pub(super) async fn simple(&self, op: &str, params: Value) -> Result<()> {
        self.request(op, params).await.map(|_| ())
    }

    #[cfg(test)]
    pub(super) async fn read_link(&self, path: String) -> Result<String> {
        self.request("read_link", json!({"path":path}))
            .await?
            .as_str()
            .map(str::to_string)
            .ok_or(Error::UnexpectedPacket)
    }

    pub(super) async fn read_dir(&self, path: String) -> Result<Vec<RemoteDirEntry>> {
        let value = self.request("read_dir", json!({"path":path})).await?;
        value
            .as_array()
            .ok_or(Error::UnexpectedPacket)?
            .iter()
            .map(|item| {
                Ok(RemoteDirEntry {
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or(Error::UnexpectedPacket)?
                        .into(),
                    path: item
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or(Error::UnexpectedPacket)?
                        .into(),
                    metadata: attributes(
                        item.get("attributes")
                            .cloned()
                            .ok_or(Error::UnexpectedPacket)?,
                    )?,
                })
            })
            .collect()
    }

    pub(super) async fn open(&self, path: String, flags: OpenFlags) -> Result<RemoteFile> {
        let value = self
            .request("open", json!({"path":path,"flags":flags.bits()}))
            .await?;
        let handle = value
            .get("handle")
            .and_then(Value::as_str)
            .ok_or(Error::UnexpectedPacket)?
            .to_string();
        let size = value
            .get("size")
            .and_then(Value::as_u64)
            .ok_or(Error::UnexpectedPacket)?;
        Ok(RemoteFile::Direct(Box::new(DirectFile {
            fs: self.clone(),
            handle: Some(handle),
            position: if flags.contains(OpenFlags::APPEND) {
                size
            } else {
                0
            },
            size,
            read_pending: None,
            write_pending: None,
            read_buffer: Vec::new(),
            buffer_position: 0,
        })))
    }

    pub(super) async fn set_metadata(&self, path: String, attrs: FileAttributes) -> Result<()> {
        self.simple(
            "set_metadata",
            json!({"path":path,"attrs":attributes_json(&attrs)}),
        )
        .await
    }

    pub(super) async fn read(&self, path: String) -> Result<Vec<u8>> {
        let mut file = self.open(path, OpenFlags::READ).await?;
        let mut bytes = Vec::new();
        let result = file.read_to_end(&mut bytes).await;
        let close = file.close().await;
        result.map_err(Error::from)?;
        close.map_err(Error::from)?;
        Ok(bytes)
    }

    #[cfg(test)]
    pub(super) async fn write(&self, path: String, bytes: &[u8]) -> Result<()> {
        let mut file = self
            .open(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            )
            .await?;
        let result = file.write_all(bytes).await;
        let close = file.close().await;
        result.map_err(Error::from)?;
        close.map_err(Error::from)
    }
}

fn attributes(value: Value) -> Result<FileAttributes> {
    let object = value.as_object().ok_or(Error::UnexpectedPacket)?;
    Ok(FileAttributes {
        size: object.get("size").and_then(Value::as_u64),
        permissions: object
            .get("permissions")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok()),
        atime: object
            .get("atime")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok()),
        mtime: object
            .get("mtime")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok()),
        ..FileAttributes::default()
    })
}

fn attributes_json(attrs: &FileAttributes) -> Value {
    json!({"size":attrs.size,"permissions":attrs.permissions,"atime":attrs.atime,"mtime":attrs.mtime})
}

pub(super) struct RemoteDirEntry {
    name: String,
    path: String,
    metadata: FileAttributes,
}

impl RemoteDirEntry {
    pub(super) fn from_sftp(entry: russh_sftp::client::fs::DirEntry) -> Self {
        Self {
            name: entry.file_name(),
            path: entry.path(),
            metadata: entry.metadata(),
        }
    }
    pub(super) fn file_name(&self) -> String {
        self.name.clone()
    }
    pub(super) fn path(&self) -> String {
        self.path.clone()
    }
    pub(super) fn metadata(&self) -> FileAttributes {
        self.metadata.clone()
    }
}

pub(super) enum RemoteFile {
    Ssh(Box<russh_sftp::client::fs::File>),
    Direct(Box<DirectFile>),
}

impl RemoteFile {
    pub(super) async fn metadata(&mut self) -> Result<FileAttributes> {
        match self {
            Self::Ssh(file) => file.metadata().await,
            Self::Direct(file) => attributes(
                file.fs
                    .request("metadata_handle", json!({"handle":file.handle}))
                    .await?,
            ),
        }
    }
    pub(super) async fn close(mut self) -> io::Result<()> {
        match &mut self {
            Self::Ssh(_) => {}
            Self::Direct(file) => {
                file.flush().await?;
                if let Some(handle) = file.handle.take() {
                    file.fs
                        .simple("close", json!({"handle":handle}))
                        .await
                        .map_err(io_error)?;
                }
                return Ok(());
            }
        }
        if let Self::Ssh(file) = self {
            (*file).close().await
        } else {
            unreachable!()
        }
    }
}

pub(super) struct DirectFile {
    fs: DirectFs,
    handle: Option<String>,
    position: u64,
    size: u64,
    read_pending: Option<ReadRequest>,
    write_pending: Option<WriteRequest>,
    read_buffer: Vec<u8>,
    buffer_position: usize,
}

fn io_error(error: Error) -> io::Error {
    io::Error::other(error.to_string())
}

impl Drop for DirectFile {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let fs = self.fs.clone();
            tauri::async_runtime::spawn(async move {
                let _ = fs.simple("close", json!({"handle":handle})).await;
            });
        }
    }
}

impl AsyncRead for DirectFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.buffer_position >= self.read_buffer.len() {
            if self.read_pending.is_none() {
                let fs = self.fs.clone();
                let handle = self.handle.clone();
                let offset = self.position;
                let length = buf.remaining().min(CHUNK);
                self.read_pending = Some(Box::pin(async move {
                    let value = fs
                        .request(
                            "read_at",
                            json!({"handle":handle,"offset":offset,"length":length}),
                        )
                        .await
                        .map_err(io_error)?;
                    let bytes: Vec<u8> = serde_json::from_value(value).map_err(io::Error::other)?;
                    if bytes.len() > length {
                        return Err(io::Error::other("Agent 返回文件片段超出请求大小"));
                    }
                    Ok(bytes)
                }));
            }
            let result = self.read_pending.as_mut().unwrap().as_mut().poll(cx);
            let bytes = match result {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(result) => {
                    self.read_pending = None;
                    match result {
                        Ok(bytes) => bytes,
                        Err(error) => return Poll::Ready(Err(error)),
                    }
                }
            };
            self.read_buffer = bytes;
            self.buffer_position = 0;
        }
        let size = buf
            .remaining()
            .min(self.read_buffer.len() - self.buffer_position);
        buf.put_slice(&self.read_buffer[self.buffer_position..self.buffer_position + size]);
        self.buffer_position += size;
        self.position = self.position.saturating_add(size as u64);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for DirectFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if self.write_pending.is_none() {
            if self.read_pending.is_some() {
                return Poll::Ready(Err(io::Error::other("文件读取尚未完成")));
            }
            self.read_buffer.clear();
            self.buffer_position = 0;
            let fs = self.fs.clone();
            let handle = self.handle.clone();
            let offset = self.position;
            let bytes = bytes[..bytes.len().min(CHUNK)].to_vec();
            self.write_pending = Some(Box::pin(async move {
                let size = bytes.len();
                let value = fs
                    .request(
                        "write_at",
                        json!({"handle":handle,"offset":offset,"data":bytes}),
                    )
                    .await
                    .map_err(io_error)?;
                let written = value
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| io::Error::other("Agent 写入应答无效"))?;
                if written > size {
                    return Err(io::Error::other("Agent 写入长度超出请求大小"));
                }
                Ok(written)
            }));
        }
        let result = self.write_pending.as_mut().unwrap().as_mut().poll(cx);
        match result {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                self.write_pending = None;
                if let Ok(size) = result {
                    self.position = self.position.saturating_add(size as u64);
                    self.size = self.size.max(self.position);
                }
                Poll::Ready(result)
            }
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(pending) = self.write_pending.as_mut() {
            match pending.as_mut().poll(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(result) => {
                    self.write_pending = None;
                    let size = result?;
                    self.position = self.position.saturating_add(size as u64);
                    self.size = self.size.max(self.position);
                }
            }
        }
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(cx)
    }
}

impl AsyncSeek for DirectFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        if self.read_pending.is_some() || self.write_pending.is_some() {
            return Err(io::Error::other("文件操作尚未完成，无法定位"));
        }
        let target = match position {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::End(offset) => self.size.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "文件偏移无效"))?;
        self.position = target;
        self.read_buffer.clear();
        self.buffer_position = 0;
        Ok(())
    }
    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.position))
    }
}

impl AsyncRead for RemoteFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Ssh(file) => Pin::new(file).poll_read(cx, buf),
            Self::Direct(file) => Pin::new(file.as_mut()).poll_read(cx, buf),
        }
    }
}
impl AsyncWrite for RemoteFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut *self {
            Self::Ssh(file) => Pin::new(file).poll_write(cx, buf),
            Self::Direct(file) => Pin::new(file.as_mut()).poll_write(cx, buf),
        }
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Ssh(file) => Pin::new(file).poll_flush(cx),
            Self::Direct(file) => Pin::new(file.as_mut()).poll_flush(cx),
        }
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Ssh(file) => Pin::new(file).poll_shutdown(cx),
            Self::Direct(file) => Pin::new(file.as_mut()).poll_shutdown(cx),
        }
    }
}
impl AsyncSeek for RemoteFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        match &mut *self {
            Self::Ssh(file) => Pin::new(file).start_seek(position),
            Self::Direct(file) => Pin::new(file.as_mut()).start_seek(position),
        }
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        match &mut *self {
            Self::Ssh(file) => Pin::new(file).poll_complete(cx),
            Self::Direct(file) => Pin::new(file.as_mut()).poll_complete(cx),
        }
    }
}
