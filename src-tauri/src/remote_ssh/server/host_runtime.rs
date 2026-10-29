//! One authenticated user daemon per host identity, shared by project roots.
//! Readiness is memory-only: a new SSH incarnation must complete HELLO again.
use super::daemon::probe_shared_daemon;
use super::scripts::sha256_of_file_cached;
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Weak;
use std::time::SystemTime;

#[cfg(test)]
mod live_acceptance;

const HEALTH_TTL: Duration = Duration::from_secs(30);
const FAILURE_RETRY: Duration = Duration::from_secs(5);

#[derive(Clone, PartialEq, Eq)]
struct BinaryStamp {
    size: u64,
    modified: SystemTime,
}

fn binary_stamp(path: &Path) -> Option<BinaryStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    metadata.is_file().then_some(BinaryStamp {
        size: metadata.len(),
        modified: metadata.modified().ok()?,
    })
}

#[derive(Clone)]
pub(super) struct PreparedDaemon {
    pub access: DaemonAccess,
    pub local_binary: PathBuf,
    pub sha256: String,
}

#[derive(Clone)]
struct ReadyDaemon {
    prepared: PreparedDaemon,
    stamp: BinaryStamp,
    verified: Instant,
    sessions: Vec<Weak<()>>,
}

impl ReadyDaemon {
    fn binary_unchanged(&self) -> bool {
        binary_stamp(&self.prepared.local_binary).as_ref() == Some(&self.stamp)
    }

    fn fresh_for(&self, session: &Arc<()>) -> bool {
        self.verified.elapsed() < HEALTH_TTL
            && self.binary_unchanged()
            && self
                .sessions
                .iter()
                .any(|known| known.ptr_eq(&Arc::downgrade(session)))
    }
}

#[derive(Default)]
struct RuntimeEntry {
    gate: tokio::sync::Mutex<()>,
    generation: AtomicU64,
    ready: Mutex<Option<ReadyDaemon>>,
    failure: Mutex<Option<(Instant, String)>>,
    #[cfg(test)]
    initializations: AtomicU64,
}

impl RuntimeEntry {
    fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.failure.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn invalidate_if_current(&self, expected: &DaemonAccess) {
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        if ready
            .as_ref()
            .is_some_and(|ready| &ready.prepared.access == expected)
        {
            self.generation.fetch_add(1, Ordering::SeqCst);
            *ready = None;
            *self.failure.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    async fn acquire<Init, InitFuture, Probe, ProbeFuture>(
        &self,
        session: &Arc<()>,
        initialize: Init,
        probe: Probe,
    ) -> Result<DaemonAccess, String>
    where
        Init: FnOnce() -> InitFuture,
        InitFuture: std::future::Future<Output = Result<PreparedDaemon, String>>,
        Probe: FnOnce(DaemonAccess) -> ProbeFuture,
        ProbeFuture: std::future::Future<Output = Result<(), String>>,
    {
        let _guard = self.gate.lock().await;
        let generation = self.generation.load(Ordering::SeqCst);
        let cached = self.ready.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(mut cached) = cached.filter(ReadyDaemon::binary_unchanged) {
            // Also check the trusted local digest; metadata only accelerates UI hints.
            if sha256_of_file_cached(&cached.prepared.local_binary).await? == cached.prepared.sha256
            {
                if cached.fresh_for(session) {
                    if generation != self.generation.load(Ordering::SeqCst) {
                        return Err("远端服务状态已变化，请重试".into());
                    }
                    return Ok(cached.prepared.access);
                }
                if probe(cached.prepared.access.clone()).await.is_ok() {
                    if generation != self.generation.load(Ordering::SeqCst) {
                        return Err("远端服务状态已变化，请重试".into());
                    }
                    cached.verified = Instant::now();
                    cached.sessions.retain(|known| known.strong_count() > 0);
                    cached.sessions.push(Arc::downgrade(session));
                    let access = cached.prepared.access.clone();
                    let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
                    if generation != self.generation.load(Ordering::SeqCst) {
                        return Err("远端服务状态已变化，请重试".into());
                    }
                    *ready = Some(cached);
                    return Ok(access);
                }
            }
        }
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if let Some((at, reason)) = &*self.failure.lock().unwrap_or_else(|e| e.into_inner()) {
            if at.elapsed() < FAILURE_RETRY {
                return Err(reason.clone());
            }
        }
        #[cfg(test)]
        self.initializations.fetch_add(1, Ordering::SeqCst);
        let prepared = match initialize().await {
            Ok(prepared) => prepared,
            Err(error) => {
                if generation == self.generation.load(Ordering::SeqCst) {
                    *self.failure.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some((Instant::now(), error.clone()));
                }
                return Err(error);
            }
        };
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err("远端服务状态已变化，请重试".into());
        }
        let stamp = binary_stamp(&prepared.local_binary).ok_or("本地 server 二进制已变化")?;
        if sha256_of_file_cached(&prepared.local_binary).await? != prepared.sha256 {
            return Err("本地 server 二进制已变化，请重新准备".into());
        }
        let access = prepared.access.clone();
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        if generation != self.generation.load(Ordering::SeqCst) {
            return Err("远端服务状态已变化，请重试".into());
        }
        *ready = Some(ReadyDaemon {
            prepared,
            stamp,
            verified: Instant::now(),
            sessions: vec![Arc::downgrade(session)],
        });
        *self.failure.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(access)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct BinaryFixture(PathBuf);
    impl BinaryFixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("qc-host-runtime-{}", uuid::Uuid::new_v4()));
            std::fs::write(&path, b"trusted-local-binary").unwrap();
            Self(path)
        }
        async fn prepared(&self, token: &str) -> PreparedDaemon {
            PreparedDaemon {
                access: DaemonAccess {
                    bin: "/home/user/.qingcode/server/v/server".into(),
                    token: token.into(),
                },
                local_binary: self.0.clone(),
                sha256: sha256_of_file_cached(&self.0).await.unwrap(),
            }
        }
    }
    impl Drop for BinaryFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[tokio::test]
    async fn concurrent_roots_prepare_once_and_reconnect_only_probes() {
        let binary = BinaryFixture::new();
        let prepared = binary.prepared("first").await;
        let entry = Arc::new(RuntimeEntry::default());
        let session = Arc::new(());
        let probes = Arc::new(AtomicU64::new(0));
        let mut jobs = tokio::task::JoinSet::new();
        for _ in 0..12 {
            let (entry, session, probes, prepared) = (
                entry.clone(),
                session.clone(),
                probes.clone(),
                prepared.clone(),
            );
            jobs.spawn(async move {
                entry
                    .acquire(
                        &session,
                        || async {
                            tokio::task::yield_now().await;
                            Ok(prepared.clone())
                        },
                        |_| async {
                            probes.fetch_add(1, Ordering::SeqCst);
                            Ok(())
                        },
                    )
                    .await
            });
        }
        while let Some(result) = jobs.join_next().await {
            assert!(result.unwrap().is_ok());
        }
        assert_eq!(entry.initializations.load(Ordering::SeqCst), 1);
        assert_eq!(probes.load(Ordering::SeqCst), 0);
        let reconnect = Arc::new(());
        entry
            .acquire(
                &reconnect,
                || async { panic!("must reuse existing daemon") },
                |_| async {
                    probes.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        assert_eq!(entry.initializations.load(Ordering::SeqCst), 1);
        entry.ready.lock().unwrap().as_mut().unwrap().verified -= HEALTH_TTL;
        entry
            .acquire(
                &reconnect,
                || async { panic!("health checks cannot reinstall") },
                |_| async {
                    probes.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn binary_change_and_failed_probe_reinitialize_but_old_failures_cannot_invalidate_new_token(
    ) {
        let binary = BinaryFixture::new();
        let first = binary.prepared("old").await;
        let entry = RuntimeEntry::default();
        let session = Arc::new(());
        entry
            .acquire(
                &session,
                || async { Ok(first.clone()) },
                |_| async { Ok(()) },
            )
            .await
            .unwrap();
        std::fs::write(&binary.0, b"changed-trusted-local-binary-longer").unwrap();
        let next = binary.prepared("new").await;
        entry
            .acquire(
                &session,
                || async { Ok(next.clone()) },
                |_| async { panic!("changed binary cannot reuse") },
            )
            .await
            .unwrap();
        entry.invalidate_if_current(&first.access);
        assert!(entry
            .ready
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .fresh_for(&session));
        let reconnect = Arc::new(());
        entry
            .acquire(
                &reconnect,
                || async { Ok(next.clone()) },
                |_| async { Err("stale token".into()) },
            )
            .await
            .unwrap();
        assert_eq!(entry.initializations.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn invalidation_during_prepare_does_not_publish_late_readiness() {
        let binary = BinaryFixture::new();
        let prepared = binary.prepared("late").await;
        let entry = Arc::new(RuntimeEntry::default());
        let session = Arc::new(());
        let started = tokio::sync::Notify::new();
        let resume = tokio::sync::Notify::new();
        let opening = entry.acquire(
            &session,
            || async {
                started.notify_one();
                resume.notified().await;
                Ok(prepared)
            },
            |_| async { Ok(()) },
        );
        let invalidation = async {
            started.notified().await;
            entry.invalidate();
            resume.notify_one();
        };
        let (result, _) = tokio::join!(opening, invalidation);
        assert!(result.is_err());
        assert!(entry.ready.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn failing_concurrent_roots_share_backoff_and_restricted_roots_cannot_prepare() {
        let entry = RuntimeEntry::default();
        let session = Arc::new(());
        for _ in 0..8 {
            assert!(entry
                .acquire(
                    &session,
                    || async { Err("offline".into()) },
                    |_| async { Ok(()) }
                )
                .await
                .is_err());
        }
        assert_eq!(entry.initializations.load(Ordering::SeqCst), 1);
        let root = RegisteredRoot {
            uri: "ssh://c/srv/app".into(),
            canonical_path: "/srv/app".into(),
            trusted: false,
        };
        assert!(ensure_shared_daemon(&SshManager::new(), &root, None)
            .await
            .is_err());
    }

    #[test]
    fn identity_shares_aliases_but_separates_user_port_and_fingerprint() {
        let base = SshConnectionConfig {
            id: "one".into(),
            host: "Example.org".into(),
            port: 22,
            username: "user".into(),
            auth_kind: "privateKey".into(),
            private_key_path: None,
            password: None,
            passphrase: None,
            host_key_fingerprint: Some("SHA256:trusted".into()),
            mode: Some(RemoteMode::Server),
        };
        let mut alias = base.clone();
        alias.id = "two".into();
        alias.host = "example.org".into();
        assert_eq!(runtime_identity(&base), runtime_identity(&alias));
        alias.username = "other".into();
        assert_ne!(runtime_identity(&base), runtime_identity(&alias));
        alias = base.clone();
        alias.port = 2222;
        assert_ne!(runtime_identity(&base), runtime_identity(&alias));
        alias = base.clone();
        alias.host_key_fingerprint = Some("SHA256:changed".into());
        assert_ne!(runtime_identity(&base), runtime_identity(&alias));
        alias.host_key_fingerprint = None;
        assert!(runtime_identity(&alias).is_none());
    }
}

#[derive(Default)]
pub(crate) struct HostDaemonCache {
    entries: Mutex<HashMap<String, Arc<RuntimeEntry>>>,
}

impl HostDaemonCache {
    fn entry(&self, key: &str) -> Arc<RuntimeEntry> {
        Arc::clone(
            self.entries
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(key.to_string())
                .or_default(),
        )
    }

    pub(crate) fn invalidate_all(&self) {
        for entry in self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            entry.invalidate();
        }
    }
}

fn runtime_identity(config: &SshConnectionConfig) -> Option<String> {
    let fingerprint = config.host_key_fingerprint.as_deref()?.trim();
    if fingerprint.is_empty() {
        return None;
    }
    serde_json::to_string(&(
        &config.username,
        config.host.to_lowercase(),
        config.port,
        fingerprint,
        qingcode_server::SERVER_VERSION,
    ))
    .ok()
}

fn identity_for_connection(manager: &SshManager, id: &str) -> Option<String> {
    let session = manager.session(id).ok()?;
    let config = session.config.lock().ok()?;
    runtime_identity(&config)
}

/// UI hint only. Every project still registers/canonicalizes its own trusted root.
pub(crate) fn shared_server_ready(manager: &SshManager, connection_id: &str) -> bool {
    shared_server_hint(manager, connection_id, true)
}

/// UI hints may outlive the health TTL. Acquisition still revalidates HELLO.
pub(crate) fn shared_server_known(manager: &SshManager, connection_id: &str) -> bool {
    shared_server_hint(manager, connection_id, false)
}

fn shared_server_hint(manager: &SshManager, connection_id: &str, require_fresh: bool) -> bool {
    if manager.direct_config(connection_id).is_some() {
        return manager.connection_is_open(connection_id);
    }
    let Some(identity) = identity_for_connection(manager, connection_id) else {
        return false;
    };
    let Ok(session) = manager.session(connection_id) else {
        return false;
    };
    if session.handle.is_closed() {
        return false;
    }
    let entry = manager.host_daemons.entry(&identity);
    let ready = entry.ready.lock().unwrap_or_else(|e| e.into_inner());
    ready.as_ref().is_some_and(|ready| {
        if require_fresh {
            ready.fresh_for(&session.server_incarnation)
        } else {
            ready.binary_unchanged()
        }
    })
}

pub(super) async fn ensure_shared_daemon(
    manager: &SshManager,
    root: &RegisteredRoot,
    app: Option<&AppHandle>,
) -> Result<DaemonAccess, String> {
    let parsed = parse_remote_uri(&root.uri)?;
    if !root.trusted || !manager.server_mode(&parsed.connection_id) {
        return Err("仅已信任的 Server 项目可以接入共享服务".into());
    }
    if let Some(config) = manager.direct_config(&parsed.connection_id) {
        return Ok(DaemonAccess {
            bin: "direct".into(),
            token: config.token,
        });
    }
    let session = manager.session(&parsed.connection_id)?;
    let identity =
        identity_for_connection(manager, &parsed.connection_id).ok_or("SSH 主机指纹未确认")?;
    let entry = manager.host_daemons.entry(&identity);
    let probe_connection_id = parsed.connection_id.clone();
    let result =
        entry
            .acquire(
                &session.server_incarnation,
                || super::deploy::prepare_shared_daemon(manager, root, app),
                |access| async move {
                    probe_shared_daemon(manager, &probe_connection_id, &access).await
                },
            )
            .await?;
    let current = manager.session(&parsed.connection_id)?;
    if current.handle.is_closed()
        || !Arc::ptr_eq(&current.server_incarnation, &session.server_incarnation)
    {
        return Err("SSH 连接已变化，请重新接入项目".into());
    }
    Ok(result)
}

/// A dead daemon invalidates every workspace attached to this host identity.
/// Project serve fallbacks remain independent and can keep serving files.
pub(crate) fn invalidate_shared_daemon(manager: &SshManager, connection_id: &str) {
    let Some(identity) = identity_for_connection(manager, connection_id) else {
        return;
    };
    manager.host_daemons.entry(&identity).invalidate();
    discard_bindings(manager, connection_id, None);
}

pub(super) fn discard_shared_bindings(manager: &SshManager, connection_id: &str) {
    discard_bindings(manager, connection_id, None);
}

pub(super) fn invalidate_failed_daemon(
    manager: &SshManager,
    connection_id: &str,
    expected: &DaemonAccess,
) {
    if let Some(identity) = identity_for_connection(manager, connection_id) {
        manager
            .host_daemons
            .entry(&identity)
            .invalidate_if_current(expected);
    }
    discard_bindings(manager, connection_id, Some(expected));
}

fn discard_bindings(manager: &SshManager, connection_id: &str, expected: Option<&DaemonAccess>) {
    let Some(identity) = identity_for_connection(manager, connection_id) else {
        return;
    };
    let ids: Vec<String> = manager
        .sessions
        .read()
        .map(|sessions| sessions.keys().cloned().collect())
        .unwrap_or_default();
    let ids: Vec<String> = ids
        .into_iter()
        .filter(|id| identity_for_connection(manager, id).as_ref() == Some(&identity))
        .collect();
    if let Ok(mut slots) = manager.servers.write() {
        for (key, slot) in slots.iter_mut() {
            if !ids.iter().any(|id| key.starts_with(&format!("{id}|"))) {
                continue;
            }
            if let Some(endpoint) = slot.endpoint.as_mut() {
                if expected.is_some_and(|expected| endpoint.daemon.as_ref() != Some(expected)) {
                    continue;
                }
                endpoint.daemon = None;
                if endpoint.serve.is_none() {
                    slot.endpoint = None;
                }
            }
        }
    }
}
