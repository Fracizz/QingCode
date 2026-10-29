//! Read-only package inspection and explicit client-side download recovery.
//! No remote process is stopped and no settings are changed by preflight.
use super::download::{
    download_server_binary, remote_server_arch, server_manifest_path,
    validate_local_server_manifest,
};
use super::paths::{legacy_server_binary_file_name, server_binary_file_name};
use super::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPackageInfo {
    expected_version: String,
    package_version: Option<String>,
    source_path: Option<String>,
    pub directory: Option<String>,
    pub problem: Option<String>,
}

fn recovery_root(manager: &SshManager, uri: &str) -> Result<RegisteredRoot, String> {
    let root = manager.registered_root(uri)?;
    let id = parse_remote_uri(uri)?.connection_id;
    if !root.trusted {
        return Err("请先信任当前远程项目，再配置远端服务".into());
    }
    if manager.direct_config(&id).is_some() {
        return Err("Server 端口直连不支持通过 SSH 安装服务".into());
    }
    Ok(root)
}

async fn inspect_binary(binary: &Path) -> ServerPackageInfo {
    let manifest_path = server_manifest_path(binary);
    // Bound diagnostic reads independently from the validation path.
    let package_version = match tokio::fs::metadata(&manifest_path).await {
        Ok(meta) if meta.len() <= 64 * 1024 => tokio::fs::read(&manifest_path)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            }),
        _ => None,
    };
    let problem = if !manifest_path.is_file() {
        Some("服务包缺少 manifest.json，无法验证版本，请重新选择完整的 servers 目录".into())
    } else {
        validate_local_server_manifest(binary).await.err()
    };
    ServerPackageInfo {
        expected_version: qingcode_server::SERVER_VERSION.into(),
        package_version,
        source_path: Some(binary.to_string_lossy().into_owned()),
        directory: binary
            .parent()
            .map(|dir| dir.to_string_lossy().into_owned()),
        problem,
    }
}

pub(crate) async fn package_info(
    manager: &SshManager,
    root_uri: &str,
    dir: Option<&str>,
) -> Result<ServerPackageInfo, String> {
    let root = recovery_root(manager, root_uri)?;
    let arch = remote_server_arch(manager, &root)
        .await
        .map_err(|e| e.reason)?;
    let windows = windows_native_path(&root.canonical_path).is_some();
    let names = [
        server_binary_file_name(windows, &arch),
        legacy_server_binary_file_name(windows, &arch),
    ];
    let dirs = match dir {
        Some(dir) => vec![checked_directory(dir)?],
        None => manager.server_binary_dirs_for_root(root_uri),
    };
    let mut first_issue = None;
    for directory in dirs {
        for name in &names {
            let binary = directory.join(name);
            if !binary.is_file() {
                continue;
            }
            let info = inspect_binary(&binary).await;
            if info.problem.is_none() {
                return Ok(info);
            }
            first_issue.get_or_insert(info);
        }
    }
    Ok(first_issue.unwrap_or(ServerPackageInfo {
        expected_version: qingcode_server::SERVER_VERSION.into(),
        package_version: None,
        source_path: None,
        directory: dir.map(str::to_string),
        problem: Some(format!("服务目录缺少当前主机需要的 {}", names[0])),
    }))
}

fn checked_directory(dir: &str) -> Result<PathBuf, String> {
    let dir = dir.trim();
    if dir.is_empty() || dir.len() > 1024 || dir.contains('\0') || dir.contains("://") {
        return Err("离线目录必须是本机文件夹".into());
    }
    download::resolve_offline_server_dir(Path::new(dir))
}

pub(crate) async fn validate_directory(dir: &str) -> Result<String, String> {
    let directory = checked_directory(dir)?;
    let mut found = false;
    for windows in [false, true] {
        for arch in ["x86_64", "aarch64"] {
            for name in [
                server_binary_file_name(windows, arch),
                legacy_server_binary_file_name(windows, arch),
            ] {
                let binary = directory.join(name);
                if !binary.is_file() {
                    continue;
                }
                found = true;
                if let Some(problem) = inspect_binary(&binary).await.problem {
                    return Err(problem);
                }
            }
        }
    }
    if !found {
        return Err("服务目录里没有支持的 server 文件".into());
    }
    Ok(directory.to_string_lossy().into_owned())
}

pub(crate) async fn download_package(
    manager: &SshManager,
    root_uri: &str,
) -> Result<ServerPackageInfo, String> {
    let root = recovery_root(manager, root_uri)?;
    let arch = remote_server_arch(manager, &root)
        .await
        .map_err(|e| e.reason)?;
    let name = server_binary_file_name(windows_native_path(&root.canonical_path).is_some(), &arch);
    // Uses the QingCode client's network/cache, never the target host's network.
    let binary = download_server_binary(manager, &name)
        .await
        .map_err(|e| e.reason)?;
    let info = inspect_binary(&binary).await;
    if let Some(problem) = &info.problem {
        return Err(problem.clone());
    }
    Ok(info)
}

pub(crate) fn reset_failure(manager: &SshManager, root_uri: &str) -> Result<(), String> {
    let root = recovery_root(manager, root_uri)?;
    let id = parse_remote_uri(root_uri)?.connection_id;
    // Drop readiness/failure caches only. Do not stop shared daemons or PTYs.
    host_runtime::invalidate_shared_daemon(manager, &id);
    manager.clear_server_endpoint(&server_slot_key(&id, &root.canonical_path));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Package(PathBuf);
    impl Package {
        fn new(version: &str) -> Self {
            use sha2::Digest;
            let dir = std::env::temp_dir().join(format!("qc-recovery-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let bytes = b"verified-package";
            std::fs::write(dir.join("qingcode-server-x86_64"), bytes).unwrap();
            let manifest = serde_json::json!({"version": version, "artifacts": {"qingcode-server-x86_64": {"sha256":format!("{:x}", sha2::Sha256::digest(bytes)), "size":bytes.len()}}});
            std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
            Self(dir)
        }
    }
    impl Drop for Package {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn wrong_version_reports_both_versions_and_source_without_changing_selection() {
        let package = Package::new("0.1.14-beta.1");
        let binary = package.0.join("qingcode-server-x86_64");
        let info = inspect_binary(&binary).await;
        assert_eq!(info.expected_version, qingcode_server::SERVER_VERSION);
        assert_eq!(info.package_version.as_deref(), Some("0.1.14-beta.1"));
        assert_eq!(
            info.source_path,
            Some(binary.to_string_lossy().into_owned())
        );
        assert!(info.problem.unwrap().contains("版本不匹配"));
        assert!(validate_directory(package.0.to_str().unwrap())
            .await
            .is_err());
        assert!(binary.exists());
    }

    #[tokio::test]
    async fn selecting_directory_requires_complete_manifest_and_matching_digest() {
        let package = Package::new(qingcode_server::SERVER_VERSION);
        assert!(validate_directory(package.0.to_str().unwrap())
            .await
            .is_ok());
        std::fs::write(
            package.0.join("qingcode-server-x86_64"),
            b"modified-package",
        )
        .unwrap();
        assert!(validate_directory(package.0.to_str().unwrap())
            .await
            .unwrap_err()
            .contains("SHA-256"));
        std::fs::remove_file(package.0.join("manifest.json")).unwrap();
        assert!(validate_directory(package.0.to_str().unwrap())
            .await
            .unwrap_err()
            .contains("manifest.json"));
        assert!(validate_directory("ssh://c/home/project").await.is_err());
    }

    #[tokio::test]
    async fn downloaded_binary_receipt_supports_preflight_without_shared_manifest() {
        let package = Package::new(qingcode_server::SERVER_VERSION);
        std::fs::rename(
            package.0.join("manifest.json"),
            package.0.join("qingcode-server-x86_64.manifest.json"),
        )
        .unwrap();
        assert!(validate_directory(package.0.to_str().unwrap())
            .await
            .is_ok());
    }

    #[test]
    fn untrusted_root_cannot_reset_failure_or_install_a_package() {
        let manager = SshManager::new();
        let root = RegisteredRoot {
            uri: "ssh://c/home/project".into(),
            canonical_path: "/home/project".into(),
            trusted: false,
        };
        manager
            .roots
            .write()
            .unwrap()
            .insert(root.uri.clone(), root.clone());
        assert!(reset_failure(&manager, &root.uri)
            .unwrap_err()
            .contains("信任"));
    }

    #[test]
    fn retry_clears_deployment_backoff_and_daemon_failure() {
        let manager = SshManager::new();
        let key = "c|/home/project";
        manager.set_server_slot(
            key,
            ServerSlot {
                deploy_failures: 2,
                unavailable_reason: Some("old".into()),
                daemon_failure: Some("old daemon".into()),
                daemon_downgraded_at: Some(Instant::now()),
                ..Default::default()
            },
        );
        manager.clear_unavailable_servers();
        let slot = manager.server_slot(key).unwrap();
        assert_eq!(slot.deploy_failures, 0);
        assert!(slot.unavailable_reason.is_none());
        assert!(slot.daemon_failure.is_none());
        assert!(slot.daemon_downgraded_at.is_none());
    }

    #[tokio::test]
    #[ignore = "requires authorized QC_LIVE_* SSH host and a matching server package"]
    async fn live_stale_package_reselection_restores_service_on_same_connection() {
        use crate::remote_ssh::{
            ssh_probe_host, store_authenticated_session, RemoteMode, SshConnectionConfig,
            WorkspaceServerSettings,
        };
        let env = |key| std::env::var(key).expect(key);
        let id = format!("package-recovery-{}", uuid::Uuid::new_v4());
        let config = SshConnectionConfig {
            id: id.clone(),
            host: env("QC_LIVE_HOST"),
            port: env("QC_LIVE_PORT").parse().unwrap(),
            username: env("QC_LIVE_USER"),
            auth_kind: "privateKey".into(),
            private_key_path: Some(env("QC_LIVE_PRIVATE_KEY")),
            passphrase: None,
            password: None,
            host_key_fingerprint: Some(env("QC_LIVE_FINGERPRINT")),
            mode: Some(RemoteMode::Server),
        };
        assert_eq!(
            ssh_probe_host(config.clone()).await.unwrap().fingerprint,
            config.host_key_fingerprint.clone().unwrap()
        );
        let manager = SshManager::new();
        store_authenticated_session(&manager, config).await.unwrap();
        let path = format!(
            "{}/qingcode-package-recovery-{}",
            env("QC_LIVE_PARENT"),
            uuid::Uuid::new_v4()
        );
        let uri = format!("ssh://{id}{path}");
        let sftp = manager.open_sftp(&id).await.unwrap();
        sftp.create_dir(&path).await.unwrap();
        let canonical = sftp.canonicalize(&path).await.unwrap();
        let root = RegisteredRoot {
            uri: uri.clone(),
            canonical_path: canonical,
            trusted: true,
        };
        manager
            .roots
            .write()
            .unwrap()
            .insert(uri.clone(), root.clone());
        let old = Package::new("0.1.14-beta.1");
        manager.set_server_binary_dirs(vec![old.0.clone()]);
        let before = package_info(&manager, &uri, None).await.unwrap();
        assert_eq!(before.package_version.as_deref(), Some("0.1.14-beta.1"));
        assert!(before.problem.is_some());
        let selected_dir = env("QC_LIVE_SERVER_DIR");
        let selected = package_info(&manager, &uri, Some(&selected_dir))
            .await
            .unwrap();
        assert!(selected.problem.is_none());
        let key = server_slot_key(&id, &root.canonical_path);
        manager.set_server_slot(
            &key,
            ServerSlot {
                deploy_failures: 2,
                unavailable_reason: Some("stale package".into()),
                ..Default::default()
            },
        );
        reset_failure(&manager, &uri).unwrap();
        manager.workspace_server_settings.write().unwrap().insert(
            uri.clone(),
            WorkspaceServerSettings {
                auto_download: false,
                offline_dir: Some(PathBuf::from(selected.directory.unwrap())),
            },
        );
        let endpoint = deploy::ensure_server_endpoint_with_app(&manager, &root, None)
            .await
            .unwrap()
            .unwrap();
        let daemon = endpoint
            .daemon
            .expect("service recovery must restore terminal daemon");
        let entries = daemon::daemon_scan_entries(&manager, &id, &daemon, &path, ".")
            .await
            .unwrap();
        assert!(entries.is_empty());
        assert_eq!(manager.server_slot(&key).unwrap().deploy_failures, 0);
        sftp.remove_dir(&path).await.unwrap();
        println!("PACKAGE_RECOVERY_ACCEPTANCE old-version-rejected=true same-ssh=true daemon-ready=true scan-ready=true");
    }
}
