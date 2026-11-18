//! One refill worker per authenticated Windows Server connection. A registered,
//! trusted root permits opening the transport; the idle shell itself starts at home.
use super::*;

#[derive(Default)]
struct Connections {
    shell: Option<String>,
    count: usize,
    running: bool,
    pools: BTreeMap<String, ShellPrewarmPool>,
}

#[derive(Clone, Default)]
pub(crate) struct ConnectionShellPools(Arc<Mutex<Connections>>, Arc<Notify>);

impl ConnectionShellPools {
    pub(crate) fn changed(&self) {
        self.1.notify_one();
    }

    pub(crate) fn configure(&self, app: &AppHandle, shell: &str, count: usize) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.shell.as_deref() == Some(shell) && state.count == count {
            return;
        }
        state.shell = Some(shell.into());
        state.count = count;
        if count == 0 {
            for (_, pool) in std::mem::take(&mut state.pools) {
                pool.stop();
            }
        } else if !state.running {
            state.running = true;
            let pools = self.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move { pools.monitor(app).await });
        }
        self.changed();
    }

    pub(crate) fn for_cwd(&self, cwd: &str) -> Option<ShellPrewarmPool> {
        let connection = remote_uri_connection_id(cwd)?;
        self.0.lock().ok()?.pools.get(connection).cloned()
    }

    async fn monitor(self, app: AppHandle) {
        loop {
            {
                let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
                if state.count == 0 {
                    state.running = false;
                    return;
                }
                let manager = app.state::<SshManager>();
                let eligible = connected_targets(&manager);
                state.pools.retain(|id, pool| {
                    if eligible.contains_key(id) {
                        true
                    } else {
                        pool.stop();
                        false
                    }
                });
                let count = state.count;
                let shell = state.shell.clone();
                for (id, remote) in eligible {
                    let Ok((launch, key)) = remote_launch_key(&remote.root.uri, shell.as_deref())
                    else {
                        continue;
                    };
                    let pool = state.pools.entry(id.clone()).or_default();
                    pool.configure_target(
                        &app,
                        Target {
                            project_path: remote.root.uri.clone(),
                            cwd: String::new(),
                            key,
                            launch,
                            count,
                            window: id,
                            remote: Some(remote),
                        },
                    );
                }
            }
            tokio::select! {
                _ = self.1.notified() => {},
                _ = tokio::time::sleep(Duration::from_millis(1500)) => {},
            }
        }
    }
}

fn connected_targets(manager: &SshManager) -> BTreeMap<String, RemoteTarget> {
    let roots = manager
        .roots
        .read()
        .map(|roots| roots.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let mut eligible = BTreeMap::new();
    for root in roots.into_iter().filter(|r| r.trusted) {
        let Some(id) = remote_windows_connection(manager, &root.uri) else {
            continue;
        };
        let Some(binding) = RemoteTarget::connected(manager, &id, &root) else {
            continue;
        };
        // Stable anchor when several projects share the same authenticated transport.
        let current = eligible.entry(id).or_insert_with(|| binding.clone());
        if binding.root.uri < current.root.uri {
            *current = binding;
        }
    }
    eligible
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fake_shell, remote_shell, target_for, with_id};
    use super::*;
    #[test]
    fn only_connected_trusted_windows_roots_contribute_one_target_per_connection() {
        use crate::remote_ssh::direct::DirectConnectionConfig;
        let manager = SshManager::new();
        for (id, paths) in [
            ("windev", vec!["D:/a", "D:/b"]),
            ("other", vec!["C:/work"]),
            ("linux", vec!["home/work"]),
        ] {
            manager.direct_connections.write().unwrap().insert(
                id.into(),
                DirectConnectionConfig {
                    endpoint: "test".into(),
                    token: "test".into(),
                    certificate_fingerprint: "test".into(),
                    tunnel: None,
                },
            );
            manager.direct_active.write().unwrap().insert(id.into());
            for path in paths {
                let uri = format!("ssh://{id}/{path}");
                manager.roots.write().unwrap().insert(
                    uri.clone(),
                    RegisteredRoot {
                        uri,
                        canonical_path: format!("/{path}"),
                        trusted: true,
                    },
                );
            }
        }
        let initial = connected_targets(&manager);
        assert_eq!(initial.len(), 2);
        assert_eq!(initial["windev"].root.uri, "ssh://windev/D:/a");
        manager
            .roots
            .write()
            .unwrap()
            .get_mut("ssh://windev/D:/a")
            .unwrap()
            .trusted = false;
        manager.direct_active.write().unwrap().remove("other");
        let next = connected_targets(&manager);
        assert_eq!(next.len(), 1);
        assert_eq!(next["windev"].root.uri, "ssh://windev/D:/b");
        assert!(initial["windev"].same_connection(&next["windev"]));
        manager
            .direct_connections
            .write()
            .unwrap()
            .get_mut("windev")
            .unwrap()
            .certificate_fingerprint = "replacement".into();
        assert!(!next["windev"].same_connection(&connected_targets(&manager)["windev"]));
        manager.direct_active.write().unwrap().remove("windev");
        assert!(connected_targets(&manager).is_empty());
    }

    #[test]
    fn connections_keep_two_shells_each_across_projects_and_local_claims() {
        let registry = ConnectionShellPools::default();
        let local = ShellPrewarmPool::default();
        local
            .0
            .lock()
            .unwrap()
            .shells
            .extend([fake_shell(), with_id(fake_shell(), "local-2")]);
        for id in ["windev", "other"] {
            let cwd = format!("ssh://{id}/D:/work/a");
            let pool = ShellPrewarmPool::default();
            let mut state = pool.0.lock().unwrap();
            let shell = remote_shell("one", &cwd, true);
            state.target = Some(target_for(&shell, 2));
            state
                .shells
                .extend([shell, remote_shell("two", &cwd, true)]);
            drop(state);
            registry.0.lock().unwrap().pools.insert(id.into(), pool);
        }
        for id in ["windev", "other"] {
            let project = format!("ssh://{id}/D:/work/b");
            let pool = registry.for_cwd(&project).unwrap();
            assert_eq!(pool.status(&project)["ready"], 2);
            assert_eq!(pool.reserve(&project, None, true).as_deref(), Ok("one"));
            assert_eq!(pool.reserve(&project, None, false).as_deref(), Ok("two"));
            assert_eq!(pool.reserve(&project, None, false), Err("all_reserved"));
        }
        assert_eq!(local.0.lock().unwrap().shells.len(), 2);
    }
}
