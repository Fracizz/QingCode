//! Explicit, trusted-workspace-only Windows OpenSSH compatibility repair.
use super::*;

const SCRIPT: &str = include_str!("windows_sshd_repair.ps1");

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsSshRepairPlan {
    pub config_sha256: String,
    pub original_bytes: u64,
    pub compact_bytes: u64,
    pub active_connections: u32,
    pub needs_repair: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsSshRepairResult {
    pub backup_root: String,
    pub config_sha256: String,
    pub restarted: bool,
}

fn repair_root(manager: &SshManager, root_uri: &str) -> Result<RegisteredRoot, String> {
    let root = manager.registered_root(root_uri)?;
    if !root.trusted {
        return Err("修复 SSH 服务前必须信任工作区".into());
    }
    if windows_native_path(&root.canonical_path).is_none() {
        return Err("仅 Windows SSH 项目支持此兼容修复".into());
    }
    Ok(root)
}

fn validate_hash(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("SSH 配置校验值无效，请重新打开修复确认框".into());
    }
    Ok(())
}

async fn execute<T: serde::de::DeserializeOwned>(
    manager: &SshManager,
    root: &RegisteredRoot,
    script: &str,
) -> Result<T, String> {
    let result = manager
        .exec_remote_shell(&root.uri, "exit 1", script, true, Duration::from_secs(30))
        .await?;
    if result.exit_code != 0 {
        return Err(format!(
            "Windows SSH 兼容修复失败：{}",
            result.stderr.trim()
        ));
    }
    serde_json::from_str(result.stdout.trim())
        .map_err(|_| "Windows SSH 修复结果无效，请检查远端 SSH 服务状态".into())
}

#[tauri::command]
pub async fn ssh_windows_repair_plan(
    root_uri: String,
    manager: State<'_, SshManager>,
) -> Result<WindowsSshRepairPlan, String> {
    let root = repair_root(&manager, &root_uri)?;
    execute(
        &manager,
        &root,
        &format!("{SCRIPT}\nGet-QingSshRepairPlan | ConvertTo-Json -Compress"),
    )
    .await
}

#[tauri::command]
pub async fn ssh_windows_repair(
    root_uri: String,
    expected_sha256: String,
    manager: State<'_, SshManager>,
) -> Result<WindowsSshRepairResult, String> {
    validate_hash(&expected_sha256)?;
    let root = repair_root(&manager, &root_uri)?;
    let id = parse_remote_uri(&root.uri)?.connection_id;
    let previous = manager.session(&id)?;
    let backup_name = format!("qingcode-ssh-repair-{}", uuid::Uuid::new_v4().simple());
    let script = format!("{SCRIPT}\nInvoke-QingWindowsSshRepair '{expected_sha256}' '{backup_name}' | ConvertTo-Json -Compress");
    let applied: Result<WindowsSshRepairResult, String> = execute(&manager, &root, &script).await;
    // sshd may close the issuing channel during restart. Re-authentication still
    // uses the confirmed fingerprint, and concurrent reconnects share the gate.
    match applied {
        Ok(result) => {
            manager
                .reconnect_after_channel_failure(&id, &previous)
                .await?;
            Ok(result)
        }
        Err(error) => {
            if previous.handle.is_closed() {
                manager
                    .reconnect_after_channel_failure(&id, &previous)
                    .await?;
            }
            let read_result = format!("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Get-Content -Raw -LiteralPath (Join-Path $env:ProgramData 'ssh/{backup_name}/result.json')");
            execute(&manager, &root, &read_result)
                .await
                .map_err(|_| error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires authorized QC_LIVE_* Windows target; reads configuration only"]
    async fn live_windows_repair_preflight() {
        let required = |name: &str| std::env::var(name).expect(name);
        let id = format!("repair-plan-{}", uuid::Uuid::new_v4());
        let manager = SshManager::new();
        let config = SshConnectionConfig {
            id: id.clone(),
            host: required("QC_LIVE_HOST"),
            port: required("QC_LIVE_PORT").parse().unwrap(),
            username: required("QC_LIVE_USER"),
            auth_kind: "privateKey".into(),
            private_key_path: Some(required("QC_LIVE_PRIVATE_KEY")),
            passphrase: std::env::var("QC_LIVE_PASSPHRASE").ok(),
            password: None,
            host_key_fingerprint: Some(required("QC_LIVE_FINGERPRINT")),
            mode: Some(RemoteMode::Server),
        };
        store_authenticated_session(&manager, config).await.unwrap();
        let sftp = manager.open_sftp(&id).await.unwrap();
        let path = sftp.canonicalize(required("QC_LIVE_PARENT")).await.unwrap();
        let root = RegisteredRoot {
            uri: format!("ssh://{id}{path}"),
            canonical_path: path,
            trusted: true,
        };
        manager
            .roots
            .write()
            .unwrap()
            .insert(root.uri.clone(), root.clone());
        let root = repair_root(&manager, &root.uri).unwrap();
        let plan: WindowsSshRepairPlan = execute(
            &manager,
            &root,
            &format!("{SCRIPT}\nGet-QingSshRepairPlan | ConvertTo-Json -Compress"),
        )
        .await
        .unwrap();
        validate_hash(&plan.config_sha256).unwrap();
        assert!(plan.compact_bytes <= plan.original_bytes);
        println!(
            "WINDOWS_REPAIR_PREFLIGHT {}",
            serde_json::to_string(&plan).unwrap()
        );
    }

    #[test]
    fn repair_requires_trusted_registered_windows_root() {
        let manager = SshManager::new();
        assert!(repair_root(&manager, "ssh://test/C:/app").is_err());
        for (path, trusted) in [("/C:/app", false), ("/home/app", true)] {
            let uri = format!("ssh://test{path}");
            manager.roots.write().unwrap().insert(
                uri.clone(),
                RegisteredRoot {
                    uri: uri.clone(),
                    canonical_path: path.into(),
                    trusted,
                },
            );
            assert!(repair_root(&manager, &uri).is_err());
        }
    }

    #[test]
    fn repair_rejects_script_injection_in_expected_digest() {
        assert!(validate_hash(&"a".repeat(64)).is_ok());
        for hash in ["", "'; Restart-Service sshd; #", &"z".repeat(64)] {
            assert!(validate_hash(hash).is_err());
        }
    }
}
