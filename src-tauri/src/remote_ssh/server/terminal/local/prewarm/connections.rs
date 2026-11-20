//! One refill worker per authenticated Windows Server connection. A registered,
//! trusted root permits opening the transport; the idle shell itself starts at home.
use super::*;

#[derive(Default)]
struct Connections {
    shell: Option<String>,
    count: usize,
    running: bool,
    pools: BTreeMap<String, ShellPrewarmPool>,
    profiles: BTreeMap<String, (String, PrewarmProfile, ShellPrewarmPool)>,
}

#[derive(Clone, Default)]
pub(crate) struct ConnectionShellPools(Arc<Mutex<Connections>>, Arc<Notify>);

impl ConnectionShellPools {
    pub(crate) fn changed(&self) {
        self.1.notify_one();
    }

    pub(crate) fn set_profiles(
        &self,
        window: &str,
        active: Option<PrewarmProfile>,
        anchors: Vec<PrewarmProfile>,
        enabled: bool,
    ) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = BTreeMap::new();
        if enabled {
            for p in active.into_iter().chain(
                anchors
                    .into_iter()
                    .filter(|p| codex::supported(&p.command))
                    .map(|mut p| {
                        p.cross_project = true;
                        p
                    }),
            ) {
                if let Some(id) = remote_uri_connection_id(&p.cwd) {
                    next.insert(id.to_owned(), p);
                }
            }
        }
        state.profiles.retain(|id, (owner, profile, pool)| {
            let keep = owner == window && next.get(id) == Some(profile);
            if !keep {
                pool.stop()
            }
            keep
        });
        for (id, profile) in next {
            state
                .profiles
                .entry(id)
                .or_insert_with(|| (window.into(), profile, ShellPrewarmPool::default()));
        }
        self.changed();
    }

    pub(crate) fn close_window(&self, window: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .profiles
            .retain(|_, (owner, _, pool)| {
                if owner == window {
                    pool.stop();
                    false
                } else {
                    true
                }
            });
    }

    pub(crate) fn profile_pool(&self, cwd: &str) -> Option<ShellPrewarmPool> {
        self.0
            .lock()
            .ok()?
            .profiles
            .get(remote_uri_connection_id(cwd)?)
            .map(|(_, _, pool)| pool.clone())
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
                for (window, profile, pool) in state.profiles.values() {
                    if let Some(target) = profile.target(&manager, window) {
                        pool.configure_target(&app, target);
                    } else {
                        pool.stop();
                    }
                }
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

impl PrewarmProfile {
    fn target(&self, manager: &SshManager, window: &str) -> Option<Target> {
        let root = manager
            .registered_root(&self.cwd)
            .ok()
            .filter(|r| r.trusted)?;
        let parsed = parse_remote_uri(&self.cwd).ok()?;
        let win = windows_native_path(&parsed.path).is_some();
        let (launch, mut key) = remote_launch_key(&self.cwd, Some(&self.shell)).ok()?;
        if self.cross_project {
            let supported_shell = if win {
                matches!(launch.resolved_shell.as_str(), "powershell" | "pwsh")
            } else {
                matches!(
                    launch.resolved_shell.as_str(),
                    "auto" | "bash" | "sh" | "zsh"
                )
            };
            if !supported_shell || !codex::supported(&self.command) {
                return None;
            }
        } else if !win {
            return None;
        }
        let connection = parsed.connection_id;
        let remote = RemoteTarget::connected(manager, &connection, &root)?;
        key.profile = Some(self.clone());
        Some(Target {
            project_path: self.cwd.clone(),
            cwd: self.cwd.clone(),
            key,
            launch,
            count: 1,
            window: window.to_owned(),
            remote: Some(remote),
        })
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
    fn anchored_profiles_are_kept_per_connection_and_removed_on_revocation() {
        let registry = ConnectionShellPools::default();
        let profile = |host: &str, command: &str| PrewarmProfile {
            cwd: format!("ssh://{host}/home/project"),
            profile_id: "dev".into(),
            shell: "auto".into(),
            command: command.into(),
            cross_project: false,
        };
        registry.set_profiles(
            "main",
            None,
            vec![
                profile("one", "claude"),
                profile("two", "opencode"),
                profile("other", "codex resume"),
            ],
            true,
        );
        let original = registry.profile_pool("ssh://one/home/other").unwrap();
        assert!(registry.profile_pool("ssh://other/home/other").is_none());
        registry.set_profiles(
            "main",
            Some(profile("one", "claude")),
            vec![profile("one", "claude")],
            true,
        );
        assert!(Arc::ptr_eq(
            &original.0,
            &registry.profile_pool("ssh://one/home/next").unwrap().0
        ));
        assert!(registry.profile_pool("ssh://two/home/other").is_none());
        registry.close_window("main");
        assert!(registry.profile_pool("ssh://one/home/other").is_none());
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
