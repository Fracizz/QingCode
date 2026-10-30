//! 本地 server 二进制的定位与下载：随包目录搜索、离线目录解析、
//! GitHub Release manifest 校验与流式下载落位。

use super::paths::{
    legacy_server_binary_file_name, server_binary_file_name, windows_server_arch_script,
};
use super::*;

/// 下载 manifest 缺 size 字段（旧清单）时的兜底下限：仍要防镜像返回
/// 无限流把磁盘写满，只是放宽到远超真实二进制体积的值。
const SERVER_DOWNLOAD_FALLBACK_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// 探测远端架构并找到本地对应的 server 二进制。
///
/// 失败分类：架构不支持、未开启自动下载且本地缺失是确定性失败（permanent，
/// 缓存成不可用）；自动下载的网络类失败（断网、GitHub 不可达）按瞬时处理——
/// 之前一律 permanent 会让整条连接在网络恢复后也不再尝试，必须重连才解冻。
pub(super) async fn locate_local_server_binary(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<(String, PathBuf), ServerDeployError> {
    locate_local_server_binary_with(manager, root, true).await
}

/// 同 [`locate_local_server_binary`]，但 `allow_download = false` 时只在本地目录
/// 里找。发现已有远端 server 的路径用它做内容强匹配——远端本来就能用时，
/// 不该为了比对再触发一次网络下载。
pub(super) async fn locate_local_server_binary_with(
    manager: &SshManager,
    root: &RegisteredRoot,
    allow_download: bool,
) -> Result<(String, PathBuf), ServerDeployError> {
    let arch = remote_server_arch(manager, root).await?;
    let windows = windows_native_path(&root.canonical_path).is_some();
    let binary_name = server_binary_file_name(windows, &arch);
    let legacy_name = legacy_server_binary_file_name(windows, &arch);
    let local = find_local_server_binary(
        &manager.server_binary_dirs_for_root(&root.uri),
        &[&binary_name, &legacy_name],
    )
    .await;
    if let Ok(Some(candidate)) = &local {
        return Ok((arch, candidate.clone()));
    }
    if allow_download && manager.server_auto_download_for_root(&root.uri) {
        return download_server_binary(manager, &binary_name)
            .await
            .map(|path| (arch, path));
    }
    if let Err(reason) = local {
        return Err(ServerDeployError::permanent(reason));
    }
    Err(ServerDeployError::permanent(format!(
        "本地未找到 QingCode server 二进制（{binary_name}）。在线请打开「缺失时自动下载」；离线可在设置里选择 servers 目录，或把它放到 QingCode.exe 旁边。远端服务尚未就绪，请完成设置后重试"
    )))
}

pub(super) async fn remote_server_arch(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<String, ServerDeployError> {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let arch = if windows {
        manager
            .exec_remote_shell(
                &root.uri,
                "uname -m",
                windows_server_arch_script(),
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await
            .map_err(ServerDeployError::from)?
            .stdout
    } else {
        manager
            .exec_command(&root.uri, "uname -m", None, true, REMOTE_EXEC_TIMEOUT)
            .await
            .map_err(ServerDeployError::from)?
            .stdout
    };
    let arch = arch.trim().to_string();
    if arch != "x86_64" && arch != "aarch64" {
        return Err(ServerDeployError::permanent(format!(
            "远端架构不支持（{arch}）"
        )));
    }
    Ok(arch)
}

async fn find_local_server_binary(
    dirs: &[PathBuf],
    names: &[&str],
) -> Result<Option<PathBuf>, String> {
    let mut rejected = None;
    for dir in dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                if let Err(reason) = validate_local_server_manifest(&candidate).await {
                    rejected.get_or_insert(reason);
                    continue;
                }
                return Ok(Some(candidate));
            }
        }
    }
    rejected.map_or(Ok(None), Err)
}

fn dir_has_server_binary(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // 兼容旧名 qingcode-agent-*；`.download-{pid}` 是中断的下载临时文件，不算。
        entry.path().is_file()
            && (name.starts_with("qingcode-server") || name.starts_with("qingcode-agent"))
            && !name.contains(".download")
            && !name.ends_with(".json")
    })
}

fn plain_local_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    let Some(stripped) = text.strip_prefix(r"\\?\") else {
        return path;
    };
    if let Some(unc) = stripped.strip_prefix(r"UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    PathBuf::from(stripped)
}

/// 接受 servers 目录（或旧版 agents 目录），或包含这些子目录的文件夹。返回实际存放二进制的目录。
pub(crate) fn resolve_offline_server_dir(path: &Path) -> Result<PathBuf, String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|_| "离线目录不存在或无法访问".to_string())?;
    if !canonical.is_dir() {
        return Err("请选择文件夹，而不是文件".to_string());
    }
    let canonical = plain_local_path(canonical);
    if dir_has_server_binary(&canonical) {
        return Ok(canonical);
    }
    for nested in ["servers", "agents"] {
        let nested = canonical.join(nested);
        if nested.is_dir() && dir_has_server_binary(&nested) {
            return Ok(nested);
        }
    }
    Err(
        "这个目录里没有 qingcode-server 二进制。请选择解压后的 servers 目录，或包含 servers 子目录的文件夹。"
            .to_string(),
    )
}

/// server 二进制的 GitHub Release 下载基址（独立发布的 `server-v<版本>` 系列标签）。
/// 可用 `QINGCODE_SERVER_DOWNLOAD_BASE` 覆盖（镜像/内网源；旧名
/// `QINGCODE_AGENT_DOWNLOAD_BASE` 兼容）。
fn server_download_base() -> String {
    let base = std::env::var("QINGCODE_SERVER_DOWNLOAD_BASE")
        .or_else(|_| std::env::var("QINGCODE_AGENT_DOWNLOAD_BASE"))
        .ok()
        .map(|base| base.trim_end_matches('/').to_string());
    if let Some(base) = base {
        if !base.is_empty() {
            return base;
        }
    }
    "https://github.com/Fracizz/QingCode/releases/download".to_string()
}

fn server_release_tag() -> String {
    format!("server-v{}", qingcode_server::SERVER_VERSION)
}

/// GitHub Release 资产 404：标签没发或资产缺失，重试不会变好，按 permanent
/// 缓存原因（部署门闩会把它公开展示）。之前一律按瞬态处理，导致「server-v*
/// 标签未发布」时监督任务反复 404 后静默放弃，芯片永远停在无原因的探测态。
fn release_404_error(asset: &str) -> ServerDeployError {
    ServerDeployError::permanent(format!(
        "GitHub Release {}/{} 不存在（尚未发布该标签或资产），无法自动下载；离线可在设置里选择 servers 目录",
        server_release_tag(),
        asset
    ))
}

/// 下载清单 URL 与二进制 URL（抽成纯函数便于单测）。
fn server_download_urls(base: &str, tag: &str, binary_name: &str) -> (String, String) {
    (
        format!("{base}/{tag}/manifest.json"),
        format!("{base}/{tag}/{binary_name}"),
    )
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ServerManifestArtifact {
    sha256: String,
    /// 下载体积上限：流式下载写入超过该字节数立即失败，防止被劫持的镜像
    /// 返回无限流把磁盘写满。
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ServerManifest {
    #[serde(default)]
    version: String,
    #[serde(default)]
    artifacts: std::collections::HashMap<String, ServerManifestArtifact>,
}

fn parse_server_manifest(bytes: &[u8]) -> Result<ServerManifest, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("解析 server manifest 失败：{e}"))
}

fn validate_server_manifest_version(manifest: &ServerManifest) -> Result<(), String> {
    if manifest.version != qingcode_server::SERVER_VERSION {
        return Err(format!(
            "server 包版本不匹配：文件版本 {}，客户端需要 {}。请更新离线 servers 目录或开启自动下载",
            if manifest.version.is_empty() { "未知" } else { &manifest.version },
            qingcode_server::SERVER_VERSION,
        ));
    }
    Ok(())
}

/// 安装器升级可能保留 exe 旁的旧 servers。先验证清单再参与发现/上传，
/// 不能仅凭文件名把旧包部署进当前版本目录。无清单的手工二进制仍兼容，
/// 其实际版本在远端摘要校验通过后、启动服务之前核对。
pub(super) fn server_manifest_path(binary: &Path) -> PathBuf {
    let receipt = binary.with_file_name(format!(
        "{}.manifest.json",
        binary.file_name().unwrap_or_default().to_string_lossy()
    ));
    if receipt.is_file() {
        receipt
    } else {
        binary.with_file_name("manifest.json")
    }
}

pub(super) async fn validate_local_server_manifest(binary: &Path) -> Result<(), String> {
    let manifest_path = server_manifest_path(binary);
    let metadata = match tokio::fs::metadata(&manifest_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取本地 server 清单失败：{error}")),
    };
    if metadata.len() > 64 * 1024 {
        return Err("本地 server 清单超过 64 KiB，请更新 servers 目录".into());
    }
    let bytes = tokio::fs::read(manifest_path)
        .await
        .map_err(|error| format!("读取本地 server 清单失败：{error}"))?;
    let manifest = parse_server_manifest(&bytes)?;
    validate_server_manifest_version(&manifest)?;
    let name = binary
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("server 文件名无效")?;
    let artifact = manifest
        .artifacts
        .get(name)
        .ok_or_else(|| format!("server 清单缺少 {name}，请更新 servers 目录"))?;
    if artifact.size != 0
        && tokio::fs::metadata(binary)
            .await
            .map_err(|e| e.to_string())?
            .len()
            != artifact.size
    {
        return Err(format!("本地 server 文件大小与清单不匹配：{name}"));
    }
    let actual = super::scripts::sha256_of_file_async(binary).await?;
    if !actual.eq_ignore_ascii_case(artifact.sha256.trim()) {
        return Err(format!("本地 server 文件 SHA-256 与清单不匹配：{name}"));
    }
    Ok(())
}

fn verify_server_sha256(expected: &str, actual: &[u8; 32]) -> Result<(), String> {
    let actual_hex: String = actual.iter().map(|b| format!("{b:02x}")).collect();
    if actual_hex.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(format!(
            "server 二进制 sha256 校验失败：期望 {expected}，实际 {actual_hex}"
        ))
    }
}

/// 下载临时文件名：`.{binary}.download-{pid}-{unique}`。pid 之外再拼一段
/// 唯一后缀，同一进程内并发下载也不会互写同一个临时文件（之前只按 pid
/// 命名，两个并发的部署会互相截断对方的数据）。抽成纯函数便于单测。
fn download_tmp_file_name(binary_name: &str, unique: u128) -> String {
    format!(".{binary_name}.download-{}-{unique}", std::process::id())
}

/// 临时文件名的唯一段：纳秒时钟；时钟不可用时退化为 pid 哈希，仍能区分
/// 同进程内先后两次下载。
fn download_unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_else(|_| u128::from(std::process::id().wrapping_mul(0x9E37_79B9)))
}

/// 从 GitHub Release 下载 server 二进制到缓存目录（`ssh.server.autoDownload`）。
/// 流程：取 manifest.json → 下载二进制（边下边算 sha256，超 manifest 声明的
/// size 立即中止）→ 校验一致 → 原子落位；任何一步失败都清理临时文件。
/// 安全说明：清单与二进制来自同一 GitHub Release（HTTPS），校验保证传输完整性；
/// 不做代码签名，信任源是本仓库的 Release，可用环境变量指向内网镜像。
///
/// 失败分类：网络/本地磁盘问题按瞬时（下次调用重试）；sha256 不一致、体积
/// 超限、manifest 缺条目是镜像内容问题，重试也治不了，按 permanent 缓存。
pub(super) async fn download_server_binary(
    manager: &SshManager,
    binary_name: &str,
) -> Result<PathBuf, ServerDeployError> {
    download_server_binary_from(manager, binary_name, &server_download_base()).await
}

async fn download_server_binary_from(
    manager: &SshManager,
    binary_name: &str,
    base: &str,
) -> Result<PathBuf, ServerDeployError> {
    let cache_dir = manager
        .server_cache_dir()
        .ok_or_else(|| ServerDeployError::permanent("下载缓存目录未配置"))?;
    let binary_name = binary_name.to_string();
    let (manifest_url, binary_url) =
        server_download_urls(base, &server_release_tag(), &binary_name);
    tokio::task::spawn_blocking(move || {
        use sha2::Digest;
        let transient = |reason: String| ServerDeployError::from(reason);
        let server = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(15))
            .timeout_read(std::time::Duration::from_secs(120))
            .build();
        let manifest_bytes = match server.get(&manifest_url).call() {
            Ok(response) => response,
            Err(ureq::Error::Status(404, _)) => return Err(release_404_error("manifest.json")),
            Err(e) => return Err(transient(format!("获取 manifest 失败：{e}"))),
        };
        let manifest_bytes = manifest_bytes
            .into_string()
            .map_err(|e| transient(format!("读取 manifest 失败：{e}")))?;
        let manifest = parse_server_manifest(manifest_bytes.as_bytes()).map_err(transient)?;
        validate_server_manifest_version(&manifest).map_err(ServerDeployError::permanent)?;
        let artifact = manifest.artifacts.get(&binary_name).ok_or_else(|| {
            ServerDeployError::permanent(format!("manifest 缺少 {binary_name} 条目"))
        })?;
        let expected = artifact.sha256.clone();
        let max_bytes = if artifact.size > 0 {
            artifact.size
        } else {
            SERVER_DOWNLOAD_FALLBACK_MAX_BYTES
        };

        let response = match server.get(&binary_url).call() {
            Ok(response) => response,
            Err(ureq::Error::Status(404, _)) => return Err(release_404_error(&binary_name)),
            Err(e) => return Err(transient(format!("下载二进制失败：{e}"))),
        };
        let mut hasher = sha2::Sha256::new();
        let tmp_path = cache_dir.join(download_tmp_file_name(
            &binary_name,
            download_unique_suffix(),
        ));
        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| transient(format!("创建缓存目录失败：{e}")))?;
        let download = (|| -> Result<(), ServerDeployError> {
            let mut file = std::fs::File::create(&tmp_path)
                .map_err(|e| transient(format!("创建临时文件失败：{e}")))?;
            use std::io::Read;
            use std::io::Write as _;
            let mut reader = response.into_reader();
            let mut buf = [0u8; 64 * 1024];
            let mut written = 0u64;
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| transient(format!("下载中断：{e}")))?;
                if n == 0 {
                    break;
                }
                written += n as u64;
                if written > max_bytes {
                    return Err(ServerDeployError::permanent(format!(
                        "下载体积超出 manifest 声明的 {max_bytes} 字节，已中止（下载源可能损坏）"
                    )));
                }
                hasher.update(&buf[..n]);
                file.write_all(&buf[..n])
                    .map_err(|e| transient(format!("写入临时文件失败：{e}")))?;
            }
            let _ = file.sync_all();
            let digest: [u8; 32] = hasher.finalize().into();
            verify_server_sha256(&expected, &digest).map_err(ServerDeployError::permanent)
        })();
        if let Err(error) = download {
            // 提前退出也要清掉半成品，缓存目录才不会堆满 .download 垃圾。
            let _ = std::fs::remove_file(&tmp_path);
            return Err(error);
        }
        let final_path = cache_dir.join(binary_name);
        // Windows 上 rename 不能覆盖已存在文件；先清旧再落位。
        let _ = std::fs::remove_file(&final_path);
        std::fs::rename(&tmp_path, &final_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            transient(format!("落位下载产物失败：{e}"))
        })?;
        // A per-binary receipt avoids concurrent architecture downloads overwriting
        // each other's metadata, and lets recovery preflight verify cached files.
        let receipt = cache_dir.join(format!(
            "{}.manifest.json",
            final_path.file_name().unwrap().to_string_lossy()
        ));
        let receipt_tmp = cache_dir.join(download_tmp_file_name(
            "manifest.json",
            download_unique_suffix(),
        ));
        std::fs::write(&receipt_tmp, &manifest_bytes)
            .map_err(|e| transient(format!("保存 server 清单失败：{e}")))?;
        let _ = std::fs::remove_file(&receipt);
        std::fs::rename(&receipt_tmp, &receipt).map_err(|e| {
            let _ = std::fs::remove_file(&receipt_tmp);
            transient(format!("保存 server 清单失败：{e}"))
        })?;
        Ok(final_path)
    })
    .await
    .map_err(|e| ServerDeployError::from(format!("下载任务失败：{e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PackageFixture(PathBuf);

    impl PackageFixture {
        fn new(version: &str) -> Self {
            use sha2::Digest;
            let dir =
                std::env::temp_dir().join(format!("qc-server-package-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let data = b"server-package-fixture";
            std::fs::write(dir.join("qingcode-server-x86_64"), data).unwrap();
            let manifest = serde_json::json!({
                "version": version,
                "artifacts": {"qingcode-server-x86_64": {
                    "sha256": format!("{:x}", sha2::Sha256::digest(data)), "size": data.len()
                }}
            });
            std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
            Self(dir)
        }
    }

    impl Drop for PackageFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn installed_old_package_does_not_shadow_current_offline_package() {
        let old = PackageFixture::new("0.1.14-beta.1");
        let current = PackageFixture::new(qingcode_server::SERVER_VERSION);
        let names = ["qingcode-server-x86_64"];
        let selected = find_local_server_binary(&[old.0.clone(), current.0.clone()], &names)
            .await
            .unwrap();
        assert_eq!(selected, Some(current.0.join(names[0])));
        let error = find_local_server_binary(std::slice::from_ref(&old.0), &names)
            .await
            .unwrap_err();
        assert!(error.contains("0.1.14-beta.1"));
        assert!(error.contains(qingcode_server::SERVER_VERSION));
    }

    #[tokio::test]
    async fn local_package_rejects_modified_binary_even_with_current_manifest_version() {
        let current = PackageFixture::new(qingcode_server::SERVER_VERSION);
        let binary = current.0.join("qingcode-server-x86_64");
        // Same length: digest verification must catch changes size checks cannot.
        std::fs::write(&binary, b"server-package-CORRUPT").unwrap();
        assert!(validate_local_server_manifest(&binary)
            .await
            .unwrap_err()
            .contains("SHA-256"));
        std::fs::write(&binary, b"truncated").unwrap();
        assert!(validate_local_server_manifest(&binary)
            .await
            .unwrap_err()
            .contains("大小"));
    }

    #[tokio::test]
    async fn client_download_verifies_version_and_persists_a_verifiable_receipt() {
        use std::io::{Read, Write};
        for version in [qingcode_server::SERVER_VERSION, "0.1.14-beta.1"] {
            let fixture = PackageFixture::new(version);
            let manifest = std::fs::read(fixture.0.join("manifest.json")).unwrap();
            let binary = std::fs::read(fixture.0.join("qingcode-server-x86_64")).unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let requests = if version == qingcode_server::SERVER_VERSION {
                2
            } else {
                1
            };
            let server = std::thread::spawn(move || {
                for _ in 0..requests {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut request = Vec::new();
                    loop {
                        let mut byte = [0];
                        stream.read_exact(&mut byte).unwrap();
                        request.push(byte[0]);
                        if request.ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                    let request = String::from_utf8(request).unwrap();
                    let body = if request.lines().next().unwrap().contains("manifest.json") {
                        &manifest
                    } else {
                        &binary
                    };
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                    stream.write_all(body).unwrap();
                }
            });
            let manager = SshManager::new();
            let cache = fixture.0.join("cache");
            manager.set_server_cache_dir(cache.clone());
            let result = download_server_binary_from(
                &manager,
                "qingcode-server-x86_64",
                &format!("http://{address}"),
            )
            .await;
            server.join().unwrap();
            if version == qingcode_server::SERVER_VERSION {
                let path = result.map_err(|e| e.reason).unwrap();
                assert!(server_manifest_path(&path).is_file());
                assert!(validate_local_server_manifest(&path).await.is_ok());
                assert!(
                    super::super::recovery::validate_directory(cache.to_str().unwrap())
                        .await
                        .is_ok()
                );
            } else {
                let error = result.err().unwrap();
                assert!(error.permanent);
                assert!(error.reason.contains("版本不匹配"));
                assert!(!cache.join("qingcode-server-x86_64").exists());
            }
        }
    }

    #[test]
    fn download_manifest_requires_current_version() {
        for version in ["", "0.1.14-beta.1"] {
            let manifest = parse_server_manifest(
                serde_json::json!({"version":version})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
            assert!(validate_server_manifest_version(&manifest).is_err());
        }
        let manifest = parse_server_manifest(
            serde_json::json!({"version":qingcode_server::SERVER_VERSION})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert!(validate_server_manifest_version(&manifest).is_ok());
    }

    #[test]
    fn release_404_is_permanent_and_names_tag_and_asset() {
        let error = release_404_error("manifest.json");
        assert!(error.permanent);
        assert!(!error.after_deploy);
        assert!(
            error.reason.contains(&server_release_tag()),
            "原因应包含标签名：{}",
            error.reason
        );
        assert!(error.reason.contains("manifest.json"));
    }

    #[test]
    fn resolve_offline_server_dir_accepts_agents_folder_or_parent() {
        let root = std::env::temp_dir().join(format!(
            "qingcode-offline-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let servers = root.join("servers");
        std::fs::create_dir_all(&servers).unwrap();
        std::fs::write(servers.join("qingcode-server-x86_64.download"), b"partial").unwrap();
        assert!(resolve_offline_server_dir(&servers).is_err());
        std::fs::write(servers.join("qingcode-server-x86_64"), b"bin").unwrap();
        let from_parent = resolve_offline_server_dir(&root).unwrap();
        let from_agents = resolve_offline_server_dir(&servers).unwrap();
        assert!(from_parent.ends_with("servers"));
        assert_eq!(from_parent, from_agents);
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(resolve_offline_server_dir(&empty).is_err());
        assert!(resolve_offline_server_dir(&servers.join("qingcode-server-x86_64")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn server_download_urls_follow_release_layout() {
        let (manifest, binary) = server_download_urls(
            "https://github.com/Fracizz/QingCode/releases/download",
            "server-v0.1.13-beta.3",
            "qingcode-server-x86_64",
        );
        assert_eq!(
            manifest,
            "https://github.com/Fracizz/QingCode/releases/download/server-v0.1.13-beta.3/manifest.json"
        );
        assert_eq!(
            binary,
            "https://github.com/Fracizz/QingCode/releases/download/server-v0.1.13-beta.3/qingcode-server-x86_64"
        );
    }

    #[test]
    fn server_download_base_follows_env_or_default() {
        // 不改环境变量（并行测试共享进程环境）：无论外部是否设置，
        // 函数返回值都应与「环境变量优先、默认 GitHub」的语义一致。
        let expected = std::env::var("QINGCODE_SERVER_DOWNLOAD_BASE")
            .ok()
            .map(|v| v.trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "https://github.com/Fracizz/QingCode/releases/download".to_string());
        assert_eq!(server_download_base(), expected);
    }

    #[test]
    fn parse_server_manifest_extracts_artifact_sha256() {
        let manifest = parse_server_manifest(
            br#"{"version":"0.1.13-beta.3","artifacts":{"qingcode-server-x86_64":{"sha256":"abc123","size":10}}}"#,
        )
        .unwrap();
        assert_eq!(
            manifest.artifacts["qingcode-server-x86_64"].sha256,
            "abc123"
        );
        assert!(parse_server_manifest(b"not json").is_err());
    }

    #[test]
    fn verify_server_sha256_matches_case_insensitively_and_rejects_wrong() {
        use sha2::Digest;
        let digest: [u8; 32] = sha2::Sha256::digest(b"hello").into();
        let hex: String = digest.iter().map(|b| format!("{b:02X}")).collect();
        assert!(verify_server_sha256(&hex.to_lowercase(), &digest).is_ok());
        assert!(verify_server_sha256(&hex, &digest).is_ok());
        assert!(verify_server_sha256(&"0".repeat(64), &digest).is_err());
    }

    #[test]
    fn download_tmp_names_differ_within_one_process() {
        // 同一进程内并发的两次下载必须落到不同的临时文件，否则互相截断。
        let first = download_tmp_file_name("qingcode-server-x86_64", 1000);
        let second = download_tmp_file_name("qingcode-server-x86_64", 1001);
        assert_ne!(first, second);
        assert!(first.starts_with(".qingcode-server-x86_64.download-"));
        assert!(first.contains(&format!("-{}", std::process::id())));
        // 离线目录判定沿用「.download 前缀不算成品」的规则，临时名不会误命中。
        assert!(first.contains(".download"));
    }
}
