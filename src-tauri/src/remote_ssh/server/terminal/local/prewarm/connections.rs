//! One refill worker per authenticated Server-mode connection (Windows or POSIX). A registered,
//! trusted root permits opening the transport; the idle shell itself starts at home.
use super::*;
use std::collections::BTreeSet;

#[derive(Default)]
struct Connections {
    shell: Option<String>,
    /// 各连接在「远程连接」中设置的普通 Shell 数量；未设置的连接按 [`DEFAULT_CONNECTION_COUNT`]。
    counts: BTreeMap<String, usize>,
    /// 已关闭预热的连接 id。
    disabled: BTreeSet<String>,
    running: bool,
    pools: BTreeMap<String, ShellPrewarmPool>,
    profiles: BTreeMap<String, (String, PrewarmProfile, ShellPrewarmPool)>,
}

/// 连接未单独设置时保留的普通 Shell 数量（自动）：领取后立即补充。
const DEFAULT_CONNECTION_COUNT: usize = 1;

impl Connections {
    fn count_for(&self, id: &str) -> usize {
        self.counts
            .get(id)
            .copied()
            .unwrap_or(DEFAULT_CONNECTION_COUNT)
            .min(8)
    }
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
            for mut p in active.into_iter().chain(anchors) {
                if !codex::supported(&p.command) {
                    continue;
                }
                p.cross_project = true;
                if let Some(id) = remote_uri_connection_id(&p.cwd) {
                    next.insert(id.to_owned(), p);
                }
            }
        }
        state.profiles.retain(|id, (owner, profile, pool)| {
            if let Some(replacement) = next
                .get(id)
                .filter(|next| owner == window && profile.same_cli(next))
            {
                profile.clone_from(replacement);
                true
            } else {
                pool.stop();
                false
            }
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

    /// 远端普通 Shell 只看各连接自己的数量，与本机「Shell 预热数量」无关；
    /// 数量为 0 的连接只停普通 Shell，CLI 预热照常（关闭整条连接用 `disabled`）。
    pub(crate) fn configure(
        &self,
        app: &AppHandle,
        shell: &str,
        counts: BTreeMap<String, usize>,
        disabled: impl IntoIterator<Item = String>,
    ) {
        let disabled: BTreeSet<String> = disabled.into_iter().collect();
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.shell.as_deref() == Some(shell)
            && state.counts == counts
            && state.disabled == disabled
            && state.running
        {
            return;
        }
        state.shell = Some(shell.into());
        state.counts = counts;
        state.disabled = disabled;
        if !state.running {
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
                let manager = app.state::<SshManager>();
                for (id, (window, profile, pool)) in &state.profiles {
                    if state.disabled.contains(id) {
                        pool.stop();
                        continue;
                    }
                    if pool.keeps_trusted_anchor(&manager, profile) {
                        // 同一 CLI 仍可用：只同步该连接设置的数量，已就绪的 CLI 保留。
                        pool.set_count(profile.pool_count());
                        continue;
                    }
                    if let Some(target) = profile.target(&manager, window) {
                        pool.configure_target(&app, target);
                    } else {
                        pool.stop();
                    }
                }
                let mut eligible = connected_targets(&manager);
                eligible.retain(|id, _| !state.disabled.contains(id) && state.count_for(id) > 0);
                state.pools.retain(|id, pool| {
                    if eligible.contains_key(id) {
                        true
                    } else {
                        pool.stop();
                        false
                    }
                });
                let shell = state.shell.clone();
                for (id, remote) in eligible {
                    let count = state.count_for(&id);
                    let Ok((launch, key)) = remote_launch_key(&remote.root.uri, shell.as_deref())
                    else {
                        continue;
                    };
                    // fish 等无法经输入确认目录的 Shell 不预热，避免反复创建失败。
                    let powershell = remote_ready_args(&launch).1;
                    if RemoteInput::for_launch(&remote.root.canonical_path, &launch, powershell)
                        .is_none()
                    {
                        continue;
                    }
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

impl ShellPrewarmPool {
    fn keeps_trusted_anchor(&self, manager: &SshManager, profile: &PrewarmProfile) -> bool {
        let anchor = {
            let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
            state.target.as_ref().and_then(|target| {
                target
                    .key
                    .profile
                    .as_ref()
                    .filter(|old| old.same_cli(profile))?;
                target.remote.clone()
            })
        };
        anchor.is_some_and(|remote| remote_target_valid(manager, &remote))
    }
}

impl PrewarmProfile {
    fn same_cli(&self, other: &Self) -> bool {
        self.profile_id == other.profile_id
            && self.shell == other.shell
            && self.command == other.command
    }

    pub(super) fn target(&self, manager: &SshManager, window: &str) -> Option<Target> {
        let root = manager
            .registered_root(&self.cwd)
            .ok()
            .filter(|r| r.trusted)?;
        let parsed = parse_remote_uri(&self.cwd).ok()?;
        let win = windows_native_path(&parsed.path).is_some();
        let (launch, mut key) = remote_launch_key(&self.cwd, Some(&self.shell)).ok()?;
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
        let connection = remote_server_connection(manager, &self.cwd)?;
        let remote = RemoteTarget::connected(manager, &connection, &root)?;
        key.profile = Some(self.clone());
        Some(Target {
            project_path: self.cwd.clone(),
            cwd: self.cwd.clone(),
            key,
            launch,
            count: self.pool_count(),
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
        let Some(id) = remote_server_connection(manager, &root.uri) else {
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
    fn only_connected_trusted_server_roots_contribute_one_target_per_connection() {
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
        // Linux 远端的 Server 模式连接同样预热。
        assert_eq!(initial.len(), 3);
        assert_eq!(initial["linux"].root.uri, "ssh://linux/home/work");
        assert_eq!(initial["windev"].root.uri, "ssh://windev/D:/a");
        let original = PrewarmProfile {
            cwd: "ssh://windev/D:/a".into(),
            cross_project: true,
            profile_id: "claude".into(),
            shell: "auto".into(),
            command: "claude".into(),
            count: 1,
        };
        let next_project = PrewarmProfile {
            cwd: "ssh://windev/D:/b".into(),
            ..original.clone()
        };
        let pool = ShellPrewarmPool::default();
        pool.0.lock().unwrap().target = original.target(&manager, "main");
        assert!(pool.keeps_trusted_anchor(&manager, &next_project));
        manager
            .roots
            .write()
            .unwrap()
            .get_mut("ssh://windev/D:/a")
            .unwrap()
            .trusted = false;
        manager.direct_active.write().unwrap().remove("other");
        manager.direct_active.write().unwrap().remove("linux");
        let next = connected_targets(&manager);
        assert!(!pool.keeps_trusted_anchor(&manager, &next_project));
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
    fn each_connection_uses_its_own_shell_count() {
        let state = Connections {
            counts: BTreeMap::from([("off".into(), 0), ("many".into(), 3), ("huge".into(), 99)]),
            ..Default::default()
        };
        assert_eq!(state.count_for("unset"), DEFAULT_CONNECTION_COUNT);
        assert_eq!(state.count_for("off"), 0);
        assert_eq!(state.count_for("many"), 3);
        assert_eq!(state.count_for("huge"), 8);
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
            count: 1,
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
        let mut switched = profile("one", "claude");
        switched.cwd = "ssh://one/home/new-project".into();
        registry.set_profiles("main", Some(switched), vec![], true);
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
