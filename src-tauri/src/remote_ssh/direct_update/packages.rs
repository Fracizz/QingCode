//! Package preparation uses a temporary SSH session, with no remote installation
//! or settings writes. The actual update only consumes the prepared local directory.
use super::*;
use server::recovery::ServerPackageInfo;
use tauri::ipc::Channel;

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum UpdatePackageSource {
    Automatic {
        #[serde(default = "default_download", rename = "allowDownload")]
        allow_download: bool,
    },
    Offline {
        directory: String,
    },
}

fn default_download() -> bool {
    true
}

pub(super) fn progress(channel: Option<&Channel<String>>, phase: &str) {
    #[cfg(test)]
    super::live_acceptance::trace(&format!("phase {phase}"));
    if let Some(channel) = channel {
        let _ = channel.send(phase.to_owned());
    }
}

pub(super) fn configure_package_source(
    maintenance: &SshManager,
    source: &SshManager,
    root: &RegisteredRoot,
    directory: Option<PathBuf>,
) {
    let offline = directory.is_some();
    maintenance.set_server_binary_dirs(directory.map_or_else(
        || source.server_binary_dirs_for_root(&root.uri),
        |dir| vec![dir],
    ));
    // This is a per-operation policy; never change the user's saved settings.
    maintenance
        .server_auto_download
        .store(!offline, Ordering::SeqCst);
    if let Some(cache) = source.server_cache_dir() {
        maintenance.set_server_cache_dir(cache);
    }
}

pub(super) async fn management_root(
    maintenance: &SshManager,
    root: &RegisteredRoot,
    id: &str,
) -> Result<RegisteredRoot, String> {
    let sftp = maintenance.open_sftp(id).await?;
    let canonical = sftp
        .canonicalize(parse_remote_uri(&root.uri)?.path)
        .await
        .map_err(|e| e.to_string())?;
    let windows = windows_native_path(&root.canonical_path).is_some();
    if !server::remote_roots_equivalent(&canonical, &root.canonical_path, windows) {
        return Err("SSH 项目目录与当前直连项目不一致；更新未执行".into());
    }
    reject_windows_sftp_links(&sftp, &canonical).await?;
    let management_root = RegisteredRoot {
        uri: format!("ssh://{id}{canonical}"),
        canonical_path: canonical,
        trusted: true,
    };
    maintenance
        .roots
        .write()
        .map_err(|_| "SSH 状态不可用")?
        .insert(management_root.uri.clone(), management_root.clone());
    Ok(management_root)
}

pub(super) async fn checked_directory(directory: &str) -> Result<PathBuf, String> {
    // Reject URI/path-domain confusion before any local filesystem access.
    server::recovery::checked_directory(directory)
}

#[tauri::command]
pub async fn direct_agent_prepare_update(
    root_uri: String,
    ssh_connection_id: String,
    config: SshConnectionConfig,
    package_source: UpdatePackageSource,
    on_progress: Channel<String>,
    manager: State<'_, SshManager>,
) -> Result<ServerPackageInfo, String> {
    let root = server_status::require_trusted_root(&manager, &root_uri)?;
    let id = parse_remote_uri(&root.uri)?.connection_id;
    if manager.direct_config(&id).is_none() {
        return Err("此连接不是 Server 端口直连".into());
    }
    let config = direct_firewall::management_config(
        &manager,
        &id,
        Some(&ssh_connection_id),
        Some(config),
        None,
    )?;
    progress(Some(&on_progress), "checkingPackage");
    let (directory, allow_download) = match package_source {
        UpdatePackageSource::Automatic { allow_download } => (None, allow_download),
        UpdatePackageSource::Offline { directory } => {
            (Some(checked_directory(&directory).await?), false)
        }
    };
    let maintenance = SshManager::new();
    configure_package_source(&maintenance, &manager, &root, directory.clone());
    maintenance
        .server_auto_download
        .store(allow_download, Ordering::SeqCst);
    progress(Some(&on_progress), "connecting");
    let ssh_id = config.id.clone();
    let (session, _) = store_authenticated_session(&maintenance, config).await?;
    let result = async {
        let bound = management_root(&maintenance, &root, &ssh_id).await?;
        progress(Some(&on_progress), "checkingPackage");
        let info = server::recovery::package_info(
            &maintenance,
            &bound.uri,
            directory.as_ref().and_then(|dir| dir.to_str()),
        )
        .await?;
        if info.problem.is_none() || !allow_download {
            return Ok(info);
        }
        progress(Some(&on_progress), "downloading");
        let info = server::recovery::download_package(&maintenance, &bound.uri).await?;
        progress(Some(&on_progress), "checkingPackage");
        Ok(info)
    }
    .await;
    let _ = session
        .handle
        .disconnect(Disconnect::ByApplication, "preparation finished", "en")
        .await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_policy_cannot_fall_back_to_global_dirs_or_download() {
        let source = SshManager::new();
        let maintenance = SshManager::new();
        let root = RegisteredRoot {
            uri: "ssh://direct/project".into(),
            canonical_path: "/project".into(),
            trusted: true,
        };
        source.server_auto_download.store(true, Ordering::SeqCst);
        source.set_server_binary_dirs(vec![std::env::temp_dir()]);
        configure_package_source(
            &maintenance,
            &source,
            &root,
            Some(PathBuf::from("/nonexistent-offline-package")),
        );
        assert!(!maintenance.server_auto_download_for_root("ssh://maintenance/project"));
        assert!(maintenance.server_binary_dirs().is_empty());
        assert!(source.server_auto_download());
        assert!(!source.server_binary_dirs().is_empty());
    }

    #[tokio::test]
    async fn rejects_missing_and_remote_offline_paths() {
        assert!(checked_directory("").await.is_err());
        assert!(checked_directory("ssh://host/servers").await.is_err());
        assert!(checked_directory("/nonexistent-offline-package")
            .await
            .is_err());
    }
}
