//! Bounded HTTP/1.1 exchanges. A cancelled/failed exchange drops its leased TLS
//! stream; requests are never replayed because writes/opens may have committed.
use super::*;
use std::time::Instant;

const MAX_HEADERS: usize = 16 * 1024;
const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_IDLE: usize = 8;
const IDLE_TTL: Duration = Duration::from_secs(5);

pub(in super::super) struct WorkspaceClient {
    config: DirectConnectionConfig,
    idle: Mutex<Vec<(Instant, TlsStream<TcpStream>)>>,
}

struct Response {
    status: u16,
    body: Vec<u8>,
    reusable: bool,
}

async fn read_response<S: tokio::io::AsyncRead + Unpin>(
    stream: &mut S,
) -> Result<Response, String> {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEADERS {
            return Err("[direct:protocol] 工作区响应头过大".into());
        }
        head.push(
            stream
                .read_u8()
                .await
                .map_err(|_| "[direct:protocol] 工作区响应中断")?,
        );
    }
    let text = std::str::from_utf8(&head).map_err(|_| "[direct:protocol] 工作区响应头无效")?;
    let mut lines = text.split("\r\n");
    let mut status = lines.next().unwrap_or_default().split_whitespace();
    if status.next() != Some("HTTP/1.1") {
        return Err("[direct:protocol] 工作区 HTTP 响应无效".into());
    }
    let status = status
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|s| (100..600).contains(s))
        .ok_or("[direct:protocol] 工作区 HTTP 响应无效")?;
    let mut length = None;
    let mut connection = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or("[direct:protocol] 工作区响应头无效")?;
        match name.to_ascii_lowercase().as_str() {
            "content-length" => {
                let value = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "[direct:protocol] 工作区响应长度无效")?;
                if value > MAX_BODY || length.replace(value).is_some() {
                    return Err("[direct:protocol] 工作区响应长度无效或过大".into());
                }
            }
            "connection" => {
                if connection
                    .replace(value.trim().eq_ignore_ascii_case("keep-alive"))
                    .is_some()
                {
                    return Err("[direct:protocol] 工作区响应头无效".into());
                }
            }
            "transfer-encoding" => return Err("[direct:protocol] 不支持工作区分块响应".into()),
            _ => {}
        }
    }
    let mut body = vec![0; length.ok_or("[direct:protocol] 工作区响应缺少长度")?];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|_| "[direct:protocol] 工作区响应中断")?;
    Ok(Response {
        status,
        body,
        reusable: connection == Some(true),
    })
}

impl WorkspaceClient {
    pub(in super::super) fn new(config: DirectConnectionConfig) -> Self {
        Self {
            config,
            idle: Mutex::new(Vec::new()),
        }
    }

    pub(in super::super) async fn request(
        &self,
        request: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        validate_token(&self.config.token)?;
        let endpoint = endpoint(&self.config.endpoint)?;
        let expected = normalized_fingerprint(&self.config.certificate_fingerprint)?;
        let body =
            serde_json::to_vec(request).map_err(|_| "[direct:protocol] 工作区请求编码失败")?;
        if body.len() > MAX_BODY {
            return Err("[direct:protocol] 工作区请求过大".into());
        }
        let timeout = request
            .get("timeoutSeconds")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(20)
            .clamp(1, 120)
            .saturating_add(10);
        tokio::time::timeout(Duration::from_secs(timeout), async {
            let cached = {
                let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
                idle.retain(|(used, _)| used.elapsed() < IDLE_TTL);
                idle.pop().map(|(_, stream)| stream)
            };
            let mut stream = match cached {
                Some(stream) => stream,
                None => tls(&endpoint, Some(expected)).await?.0,
            };
            let headers = format!(
                "POST /workspace HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
                endpoint.authority, self.config.token, body.len()
            );
            write_http_request(&mut stream, &headers, &body).await
                .map_err(|_| "[direct:unreachable] 工作区请求发送失败")?;
            let response = read_response(&mut stream).await?;
            if matches!(response.status, 401 | 403) {
                return Err("[direct:auth] Agent 连接凭据错误或已失效".into());
            }
            if response.status != 200 { return Err("[direct:protocol] 工作区请求未成功".into()); }
            let value: serde_json::Value = serde_json::from_slice(&response.body)
                .map_err(|_| "[direct:protocol] 工作区 JSON 响应无效")?;
            if response.reusable {
                let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
                if idle.len() < MAX_IDLE { idle.push((Instant::now(), stream)); }
            }
            if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
                return Err(value.get("error").and_then(serde_json::Value::as_str)
                    .unwrap_or("Agent 工作区请求失败").to_string());
            }
            Ok(value.get("value").cloned().unwrap_or(serde_json::Value::Null))
        }).await.map_err(|_| timeout_error())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn workspace_requests_reuse_tls_and_discard_failed_connections_without_replay() {
        let (config, gateway, directory) = super::super::tests::gateway().await;
        let client = WorkspaceClient::new(config);
        let request = serde_json::json!({"op":"info"});
        client.request(&request).await.unwrap();
        let address = client.idle.lock().unwrap()[0]
            .1
            .get_ref()
            .0
            .local_addr()
            .unwrap();
        for _ in 0..20 {
            client.request(&request).await.unwrap();
            let idle = client.idle.lock().unwrap();
            assert_eq!(idle.len(), 1);
            assert_eq!(idle[0].1.get_ref().0.local_addr().unwrap(), address);
        }
        for _ in 21..256 {
            client.request(&request).await.unwrap();
        }
        assert!(
            client.idle.lock().unwrap().is_empty(),
            "server retires a connection after 256 requests"
        );
        client.request(&request).await.unwrap();
        let previous = address;
        let address = client.idle.lock().unwrap()[0]
            .1
            .get_ref()
            .0
            .local_addr()
            .unwrap();
        assert_ne!(address, previous);
        // A failed exchange is discarded instead of silently replaying an
        // operation whose completion could be unknown.
        let (_, mut stream) = client.idle.lock().unwrap().pop().unwrap();
        stream.shutdown().await.unwrap();
        client.idle.lock().unwrap().push((Instant::now(), stream));
        assert!(client.request(&request).await.is_err());
        assert!(client.idle.lock().unwrap().is_empty());
        client.request(&request).await.unwrap();
        assert_ne!(
            client.idle.lock().unwrap()[0]
                .1
                .get_ref()
                .0
                .local_addr()
                .unwrap(),
            address
        );
        drop(client);
        gateway.abort();
        let _ = gateway.await;
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn response_uses_length_without_waiting_for_eof_and_preserves_next_response() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        server.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        let first = tokio::time::timeout(Duration::from_secs(1), read_response(&mut client))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.body, b"{}");
        assert!(first.reusable);
        let second = read_response(&mut client).await.unwrap();
        assert_eq!(second.status, 401);
        assert!(!second.reusable);
    }

    #[tokio::test]
    async fn response_rejects_truncation_ambiguous_framing_and_large_lengths() {
        for bytes in [
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
        ] {
            assert!(read_response(&mut bytes.as_bytes()).await.is_err());
        }
    }
}
