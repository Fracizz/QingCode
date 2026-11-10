//! SshManager：终端传输（daemon 租约、主连接回退、sshd 会话上限探测）与持久终端清理。

use super::*;

impl SshManager {
    /// 为终端新建一条独占连接，沿用主连接已确认的配置（含主机指纹）。
    ///
    /// 终端不与 SFTP / 远程命令共用主连接：sshd 每条连接的会话数有上限（MaxSessions，默认 10），
    /// 多个项目的终端挤在一条连接上很快就满；主连接卡死重连时也会把上面的终端一起断开。
    pub(super) async fn open_terminal_transport(
        &self,
        connection_id: &str,
    ) -> Result<Arc<ConnectedSession>, String> {
        self.handshake_terminal_transport(connection_id).await.map_err(|error| {
            format!("{error}（每个终端单独占用一条 SSH 连接，终端很多时可在远端 sshd_config 调大 MaxStartups 后重启 sshd）")
        })
    }

    /// 为 server 模式终端租一个 daemon 通道名额：优先复用已有共享连接，
    /// 都满了（或已失效）才握手新建，避免每个终端都新开 SSH 连接导致握手超时。
    ///
    /// `root_uri` 只用于首次读取远端 sshd 的 MaxSessions。
    pub(super) async fn lease_daemon_terminal_transport(
        &self,
        connection_id: &str,
        root_uri: &str,
    ) -> Result<TerminalTransportLease, String> {
        let pool = {
            let mut pools = self
                .terminal_transport_pools
                .lock()
                .map_err(|_| "SSH 连接状态不可用".to_string())?;
            Arc::clone(pools.entry(connection_id.to_string()).or_default())
        };
        let mut state = pool.lock().await;
        let limit = match state.limit {
            Some(limit) => limit,
            None => {
                let limit = self.probe_sshd_session_limit(root_uri).await;
                state.limit = Some(limit);
                limit
            }
        };
        // 半死的连接上开通道会一直卡到超时；只对将要复用的连接探测一次，失效就换掉。
        // 它上面其它终端的 daemon 会话会各自重连，进程不受影响。
        while let Some(index) = pick_terminal_transport(
            state
                .entries
                .iter()
                .map(|entry| (entry.leased, entry.capacity)),
        ) {
            if !connection_responds(&state.entries[index].transport.handle).await {
                let stale = state.entries.remove(index);
                close_terminal_transport(&stale.transport).await;
                continue;
            }
            let entry = &mut state.entries[index];
            entry.leased += 1;
            return Ok(TerminalTransportLease {
                transport: Arc::clone(&entry.transport),
                released: AtomicBool::new(false),
                pool: Arc::clone(&pool),
                main_fallback: false,
                main_slot: Mutex::new(None),
                notice: None,
            });
        }
        let full = state.entries.len();
        // 刚失败过的握手在冷却期内不再重试：直接回退主连接，避免每个终端都等满
        // 握手超时，也避免失败握手让远端 sshd 继续给本机 IP 追加罚时。
        let cooling = state
            .handshake_failure
            .as_ref()
            .filter(|(at, _)| at.elapsed() < TERMINAL_HANDSHAKE_FAILURE_COOLDOWN)
            .map(|(_, error)| error.clone());
        let fresh_failure = cooling.is_none();
        let handshake = match cooling {
            Some(error) => Err(error),
            None => self.handshake_terminal_transport(connection_id).await,
        };
        let transport = match handshake {
            Ok(transport) => {
                state.handshake_failure = None;
                transport
            }
            Err(error) => {
                if fresh_failure {
                    eprintln!(
                        "[WARN] terminal transport handshake failed for {connection_id}: {error}"
                    );
                    state.handshake_failure = Some((Instant::now(), error.clone()));
                }
                if let Some(lease) = self
                    .lease_main_fallback(connection_id, &pool, &mut state, &error, fresh_failure)
                    .await
                {
                    return Ok(lease);
                }
                return Err(if full == 0 {
                    format!("{error}（终端共享 SSH 连接握手失败，可检查远端 sshd 状态与 MaxStartups；{TERMINAL_HANDSHAKE_PENALTY_HINT}）")
                } else {
                    format!(
                        "{error}（已有 {full} 条终端共享连接均已占满，{}；可在远端 sshd_config 调大 MaxSessions 后重启 sshd）",
                        limit.describe()
                    )
                });
            }
        };
        state.entries.push(PooledTerminalTransport {
            transport: Arc::clone(&transport),
            leased: 1,
            capacity: limit.transport_capacity(),
        });
        Ok(TerminalTransportLease {
            transport,
            released: AtomicBool::new(false),
            pool: Arc::clone(&pool),
            main_fallback: false,
            main_slot: Mutex::new(None),
            notice: (full > 0).then(|| terminal_pool_full_notice(full, limit)),
        })
    }

    /// 专用终端连接握手失败时，向已认证的主连接借一个 daemon 通道。
    ///
    /// 只用现有主连接、不触发重连（重连同样要新握手）；主连接无响应或借用数已达
    /// [`TERMINAL_MAIN_FALLBACK_LIMIT`] 时返回 `None`，由调用方按原错误报错。
    /// `announce` 为真时附带提示（只在刚失败那一次提示，冷却期内静默借用）。
    pub(super) async fn lease_main_fallback(
        &self,
        connection_id: &str,
        pool: &TerminalTransportPool,
        state: &mut TerminalTransportPoolState,
        error: &str,
        announce: bool,
    ) -> Option<TerminalTransportLease> {
        if state.main_fallback >= TERMINAL_MAIN_FALLBACK_LIMIT {
            return None;
        }
        let main = self.session(connection_id).ok()?;
        if !connection_responds(&main.handle).await {
            return None;
        }
        let slot = self.try_main_fallback_slot(connection_id)?;
        state.main_fallback += 1;
        Some(TerminalTransportLease {
            transport: main,
            released: AtomicBool::new(false),
            pool: Arc::clone(pool),
            main_fallback: true,
            main_slot: Mutex::new(Some(slot)),
            notice: announce.then(|| {
                format!(
                    "终端专用 SSH 连接握手失败（{error}），已改用主连接承载终端（最多 {TERMINAL_MAIN_FALLBACK_LIMIT} 个）；{TERMINAL_HANDSHAKE_PENALTY_HINT}"
                )
            }),
        })
    }

    /// 读取远端 sshd 的 MaxSessions；读不到、超时或无法解析时按 OpenSSH 默认值。
    pub(super) async fn probe_sshd_session_limit(&self, root_uri: &str) -> SshdSessionLimit {
        let fallback = SshdSessionLimit {
            max_sessions: sshd_limits::OPENSSH_DEFAULT_MAX_SESSIONS,
            source: SshdSessionLimitSource::Default,
        };
        // 开通道本身在主连接卡顿时也可能等很久，时限要覆盖整个探测。
        let probed = tokio::time::timeout(
            SSHD_LIMITS_PROBE_TIMEOUT,
            self.exec_remote_shell(
                root_uri,
                sshd_limits::SSHD_CONFIG_UNIX_COMMAND,
                sshd_limits::SSHD_CONFIG_WINDOWS_SCRIPT,
                true,
                SSHD_LIMITS_PROBE_TIMEOUT,
            ),
        )
        .await
        .unwrap_or_else(|_| Err("读取 sshd_config 超时".to_string()));
        match probed {
            Ok(result) => sshd_limits::parse_sshd_max_sessions(&result.stdout).map_or(
                fallback,
                |max_sessions| SshdSessionLimit {
                    max_sessions,
                    source: SshdSessionLimitSource::Config,
                },
            ),
            Err(error) => {
                eprintln!("[WARN] reading remote sshd MaxSessions failed: {error}");
                fallback
            }
        }
    }

    pub(super) async fn handshake_terminal_transport(
        &self,
        connection_id: &str,
    ) -> Result<Arc<ConnectedSession>, String> {
        let config = self
            .live_session(connection_id)
            .await?
            .config
            .lock()
            .map_err(|_| "SSH 连接状态不可用".to_string())?
            .clone();
        let _handshake = self
            .terminal_handshakes
            .acquire()
            .await
            .map_err(|_| "SSH 连接状态不可用".to_string())?;
        let (transport, _) = authenticate_session(config, ConnectionPurpose::Terminal).await?;
        Ok(Arc::new(transport))
    }

    pub fn terminal_is_open(&self, id: &str) -> bool {
        let direct = self
            .terminals
            .read()
            .ok()
            .and_then(|terminals| {
                terminals
                    .get(id)
                    .map(|session| session.alive.load(Ordering::Acquire))
            })
            .unwrap_or(false);
        direct
            || self
                .persistent_terminals
                .read()
                .ok()
                .and_then(|terminals| terminals.get(id).map(|terminal| terminal.is_open()))
                .unwrap_or(false)
    }

    /// 该标签由本机 PTY 宿主托管时返回 daemon PTY id。
    pub(crate) fn local_hosted_pty_id(&self, id: &str) -> Option<String> {
        let terminals = self.persistent_terminals.read().ok()?;
        terminals
            .get(id)
            .filter(|terminal| {
                terminal.connection_id() == crate::local_pty_host::LOCAL_CONNECTION_ID
            })
            .map(|terminal| terminal.pty_id().to_string())
    }

    pub(crate) fn set_client_id(&self, client_id: String) {
        if let Ok(mut current) = self.client_id.write() {
            *current = client_id;
        }
    }

    pub(crate) fn daemon_client_id(&self, connection_id: &str) -> String {
        let installation = self
            .client_id
            .read()
            .map(|client_id| client_id.clone())
            .unwrap_or_else(|_| "unknown-install".to_string());
        format!("{installation}:{connection_id}")
    }

    pub(super) async fn kill_persistent_terminals_where(
        &self,
        predicate: impl Fn(&server::PersistentTerminal) -> bool,
    ) {
        let terminals = self
            .persistent_terminals
            .read()
            .map(|terminals| {
                terminals
                    .values()
                    .filter(|terminal| predicate(terminal))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let handles = terminals
            .into_iter()
            .map(|terminal| {
                tauri::async_runtime::spawn(async move {
                    let _ = terminal.kill().await;
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            let _ = handle.await;
        }
    }

    pub(super) async fn kill_persistent_terminals_for_connection(&self, connection_id: &str) {
        self.kill_persistent_terminals_where(|terminal| terminal.connection_id() == connection_id)
            .await;
    }

    pub(super) async fn kill_persistent_terminals_for_root(&self, root_uri: &str) {
        let root_uri = normalize_remote_uri(root_uri);
        self.kill_persistent_terminals_where(|terminal| {
            normalize_remote_uri(terminal.root_uri()) == root_uri
        })
        .await;
    }
}
