//! SshManager：远端 server 槽位、部署闸门、维护任务、watch 监督与工作区信任状态。

use super::*;

impl SshManager {
    pub(super) fn server_gate(&self, key: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
        let mut gates = self
            .server_gates
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        Ok(gates
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone())
    }

    /// 会话在 `ssh_connect` 时固定的模式；会话不存在或尚未经 `ssh_connect` 定下模式时为 `None`。
    pub(crate) fn connection_mode(&self, connection_id: &str) -> Option<RemoteMode> {
        if self.direct_config(connection_id).is_some() {
            return self
                .direct_active
                .read()
                .is_ok_and(|active| active.contains(connection_id))
                .then_some(RemoteMode::Server);
        }
        let session = self.session(connection_id).ok()?;
        let config = session.config.lock().ok()?;
        config.mode
    }

    /// 该连接是否处于 Server 模式。会话不存在时为 false：所有 server 路径据此停下，
    /// SSH 模式的连接从头到尾不会触碰 server 状态。
    pub(crate) fn server_mode(&self, connection_id: &str) -> bool {
        self.connection_mode(connection_id) == Some(RemoteMode::Server)
    }

    /// 项目根所在连接是否处于 Server 模式。
    pub(crate) fn root_server_mode(&self, root: &RegisteredRoot) -> bool {
        remote_uri_connection_id(&root.uri).is_some_and(|id| self.server_mode(id))
    }

    pub(crate) fn set_server_cache_dir(&self, dir: PathBuf) {
        if let Ok(mut slot) = self.server_cache_dir.write() {
            *slot = Some(dir);
        }
    }

    pub(crate) fn server_cache_dir(&self) -> Option<PathBuf> {
        self.server_cache_dir
            .read()
            .ok()
            .and_then(|slot| slot.clone())
    }

    pub(crate) fn server_auto_download(&self) -> bool {
        self.server_auto_download.load(Ordering::SeqCst)
    }

    /// 维护命令用的独立管理器：沿用服务包设置，不带会话、项目根和直连登记。
    pub(super) fn maintenance_manager(&self) -> SshManager {
        let maintenance = SshManager::new();
        maintenance.set_server_binary_dirs(self.server_binary_dirs());
        maintenance
            .server_auto_download
            .store(self.server_auto_download(), Ordering::SeqCst);
        if let Ok(mut cache) = maintenance.server_cache_dir.write() {
            *cache = self.server_cache_dir.read().ok().and_then(|v| v.clone());
        }
        maintenance
    }

    /// 设置本地 server 二进制查找目录：去重且仅保留真实存在的目录。
    pub(crate) fn set_server_binary_dirs(&self, dirs: Vec<PathBuf>) {
        let mut seen = std::collections::HashSet::new();
        let filtered = dirs
            .into_iter()
            .filter(|dir| dir.is_dir() && seen.insert(dir.clone()))
            .collect();
        if let Ok(mut slot) = self.server_binary_dirs.write() {
            if *slot == filtered {
                return;
            }
            *slot = filtered;
        }
        self.reset_shared_services();
    }

    pub(crate) fn set_server_offline_dir(&self, dir: Option<PathBuf>) {
        let dir = dir.filter(|path| path.is_dir());
        if let Ok(mut slot) = self.server_offline_dir.write() {
            if *slot == dir {
                return;
            }
            *slot = dir;
        }
        self.reset_shared_services();
    }

    pub(super) fn reset_shared_services(&self) {
        self.host_daemons.invalidate_all();
        if let Ok(mut slots) = self.servers.write() {
            for slot in slots.values_mut() {
                if let Some(endpoint) = slot.endpoint.as_mut() {
                    endpoint.daemon = None;
                    if endpoint.serve.is_none() {
                        slot.endpoint = None;
                    }
                }
            }
        }
    }

    /// 手动选择的目录排在最前；与自动目录重复时只保留这一次。
    pub(crate) fn server_binary_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = self
            .server_binary_dirs
            .read()
            .map(|dirs| dirs.clone())
            .unwrap_or_default();
        let offline = self
            .server_offline_dir
            .read()
            .ok()
            .and_then(|slot| slot.clone())
            .filter(|dir| dir.is_dir());
        if let Some(offline) = offline {
            dirs.retain(|dir| dir != &offline);
            dirs.insert(0, offline);
        }
        dirs
    }

    pub(super) fn workspace_server_settings(&self, uri: &str) -> Option<WorkspaceServerSettings> {
        self.workspace_server_settings
            .read()
            .ok()?
            .get(&normalize_remote_uri(uri))
            .cloned()
    }

    pub(super) fn server_binary_dirs_for_root(&self, uri: &str) -> Vec<PathBuf> {
        let Some(policy) = self.workspace_server_settings(uri) else {
            return self.server_binary_dirs();
        };
        let mut dirs = self
            .server_binary_dirs
            .read()
            .map(|dirs| dirs.clone())
            .unwrap_or_default();
        if let Some(offline) = policy.offline_dir {
            dirs.retain(|dir| dir != &offline);
            dirs.insert(0, offline);
        }
        dirs
    }

    pub(super) fn server_auto_download_for_root(&self, uri: &str) -> bool {
        self.workspace_server_settings(uri).map_or_else(
            || self.server_auto_download(),
            |policy| policy.auto_download,
        )
    }

    pub(super) fn root_is_passive(&self, uri: &str) -> bool {
        self.passive_roots
            .read()
            .map(|roots| roots.contains(&normalize_remote_uri(uri)))
            .unwrap_or(true)
    }

    pub(super) fn start_workspace_watch(&self, app: AppHandle, root: &RegisteredRoot) {
        let Some(id) = remote_uri_connection_id(&root.uri) else {
            return;
        };
        if !root.trusted || !self.server_mode(id) || self.root_is_passive(&root.uri) {
            return;
        }
        let key = server::server_slot_key(id, &root.canonical_path);
        if self.has_watch_supervisor(&key) {
            return;
        }
        let handle = server::spawn_server_watch_supervisor(
            app,
            id.to_string(),
            normalize_remote_uri(&root.uri),
            root.canonical_path.clone(),
        );
        self.replace_watch_supervisor(&key, handle);
    }

    /// 离线目录变更后，让之前因缺二进制而失败的槽重新尝试部署。
    pub(crate) fn clear_unavailable_servers(&self) {
        if let Ok(mut servers) = self.servers.write() {
            for slot in servers.values_mut() {
                if slot.endpoint.is_none() {
                    slot.unavailable_reason = None;
                    slot.activity = None;
                    slot.last_failure = None;
                    slot.deploy_failures = 0;
                    slot.daemon_failure = None;
                    slot.daemon_downgraded_at = None;
                }
            }
        }
    }

    pub(crate) fn server_slot(&self, key: &str) -> Option<server::ServerSlot> {
        self.servers
            .read()
            .ok()
            .and_then(|servers| servers.get(key).cloned())
    }

    pub(crate) fn set_server_slot(&self, key: &str, slot: server::ServerSlot) {
        if let Ok(mut servers) = self.servers.write() {
            servers.insert(key.to_string(), slot);
        }
    }

    /// server 调用失败后清空端点、不可用原因、部署退避计数与降级时间戳，
    /// 下次再走完整的发现/部署。
    pub(crate) fn clear_server_endpoint(&self, key: &str) {
        if let Ok(mut servers) = self.servers.write() {
            if let Some(slot) = servers.get_mut(key) {
                slot.endpoint = None;
                slot.unavailable_reason = None;
                slot.activity = None;
                slot.last_failure = None;
                slot.daemon_downgraded_at = None;
                slot.daemon_failure = None;
                slot.deploy_failures = 0;
            }
        }
    }

    pub(super) fn pause_project_server(&self, key: &str) {
        self.stop_watch_supervisor(key);
        self.set_server_slot(
            key,
            server::ServerSlot {
                unavailable_reason: Some("项目远端服务已停止，请重启服务或重新连接".into()),
                ..Default::default()
            },
        );
    }

    /// 记录发现/部署中的阶段。`None` 清掉瞬时阶段；没有 slot 时不新建空槽。
    pub(crate) fn set_server_activity(
        &self,
        key: &str,
        activity: Option<server_status::ServerPhase>,
    ) {
        let Ok(mut servers) = self.servers.write() else {
            return;
        };
        if activity.is_none() && !servers.contains_key(key) {
            return;
        }
        let slot = servers.entry(key.to_string()).or_default();
        slot.activity = activity;
    }

    /// 快照变化时返回 true，调用方再 emit。相同载荷不重复发。
    /// 转移表只做诊断，不因为跳步就丢掉这次发布。
    pub(crate) fn record_server_snapshot(&self, state: &server_status::SshServerState) -> bool {
        let Ok(mut snapshots) = self.server_snapshots.lock() else {
            return true;
        };
        let key = normalize_remote_uri(&state.root_uri);
        let previous = snapshots.get(&key).cloned();
        if previous.as_ref() == Some(state) {
            return false;
        }
        let legal = match &previous {
            Some(previous) => {
                server_status::server_phase_transition_allowed(previous.phase, state.phase)
            }
            None => true,
        };
        // 转移表不拦截发布：跳步时仍以当前槽位为准，避免界面停在过期阶段。
        let _: bool = legal;
        snapshots.insert(key, state.clone());
        true
    }

    /// 连接断开时丢弃该连接的全部 server 缓存：端口与 token 随远端进程生命周期变化，
    /// 重连后必须重新发现/部署。前缀匹配 `server_slot_key` 的 `连接id|根` 形式。
    pub(super) fn purge_server_state(&self, connection_id: &str) {
        let prefix = format!("{connection_id}|");
        if let Ok(mut servers) = self.servers.write() {
            servers.retain(|key, _| !key.starts_with(&prefix));
        }
        if let Ok(mut gates) = self.server_gates.lock() {
            gates.retain(|key, _| !key.starts_with(&prefix));
        }
        self.forget_server_install(connection_id);
    }

    /// 该连接已校验过的（家目录, 安装目录）。
    pub(crate) fn cached_server_install(&self, connection_id: &str) -> Option<(String, String)> {
        self.server_installs
            .lock()
            .ok()
            .and_then(|installs| installs.get(connection_id).cloned())
    }

    pub(crate) fn remember_server_install(
        &self,
        connection_id: &str,
        home: &str,
        install_dir: &str,
    ) {
        if let Ok(mut installs) = self.server_installs.lock() {
            installs.insert(
                connection_id.to_string(),
                (home.to_string(), install_dir.to_string()),
            );
        }
    }

    /// 部署失败或断开时丢弃缓存：安装目录可能已被远端删除，下次重新创建并校验。
    pub(crate) fn forget_server_install(&self, connection_id: &str) {
        if let Ok(mut installs) = self.server_installs.lock() {
            installs.remove(connection_id);
        }
    }

    /// 替换某个 (连接, 根) 的 watch 监督任务；重复连接同一根时先终止旧任务。
    pub(super) fn replace_watch_supervisor(
        &self,
        key: &str,
        handle: tauri::async_runtime::JoinHandle<()>,
    ) {
        if let Ok(mut supervisors) = self.watch_supervisors.lock() {
            // Starting a new incarnation already cancelled the previous one.
            // Detach its task so its watch loop can send EOF/CLOSE gracefully.
            supervisors.insert(key.to_string(), handle);
        }
    }

    /// 该 (连接, 根) 是否已有未结束的 watch 监督任务；补信任时据此避免重启
    /// 一条健康的 watch 连接。tauri 的句柄要经 `inner()` 才拿到 tokio 的完成态。
    pub(super) fn has_watch_supervisor(&self, key: &str) -> bool {
        self.watch_supervisors
            .lock()
            .ok()
            .is_some_and(|supervisors| {
                supervisors
                    .get(key)
                    .is_some_and(|handle| !handle.inner().is_finished())
            })
    }

    pub(super) fn stop_watch_supervisor(&self, key: &str) {
        if let Ok(mut cancellations) = self.watch_cancellations.lock() {
            if let Some(cancelled) = cancellations.remove(key) {
                cancelled.store(true, Ordering::Release);
            }
        }
        if let Ok(mut supervisors) = self.watch_supervisors.lock() {
            supervisors.remove(key);
        }
    }

    pub(super) fn begin_watch_supervisor(&self, key: &str) -> Arc<AtomicBool> {
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Ok(mut cancellations) = self.watch_cancellations.lock() {
            if let Some(previous) = cancellations.insert(key.into(), Arc::clone(&cancelled)) {
                previous.store(true, Ordering::Release);
            }
        }
        cancelled
    }

    pub(super) fn set_root_trust(&self, uri: &str, trusted: bool) -> Result<(), String> {
        let normalized = normalize_remote_uri(uri);
        let mut roots = self
            .roots
            .write()
            .map_err(|_| "SSH 工作区状态不可用".to_string())?;
        if let Some(root) = roots
            .values_mut()
            .find(|root| normalize_remote_uri(&root.uri) == normalized)
        {
            root.trusted = trusted;
        }
        Ok(())
    }
}
