struct PacketReader {
    bytes: Vec<u8>,
    position: usize,
    packet_size: usize,
    fail_at: Option<usize>,
}

impl tokio::io::AsyncRead for PacketReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if self.fail_at.is_some_and(|limit| self.position >= limit) {
            return std::task::Poll::Ready(Err(std::io::Error::other("SFTP disconnected")));
        }
        let count = buf
            .remaining()
            .min(self.packet_size)
            .min(self.bytes.len() - self.position);
        buf.put_slice(&self.bytes[self.position..self.position + count]);
        self.position += count;
        std::task::Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn remote_file_slice_fills_short_sftp_packets_without_exceeding_budget() {
    let bytes = vec![b'a'; 100 * 1024];
    let mut reader = PacketReader {
        bytes: bytes.clone(),
        position: 0,
        packet_size: 32 * 1024,
        fail_at: None,
    };
    let slice = super::read_remote_file_slice(&mut reader, 0, 256 * 1024, bytes.len() as u64)
        .await
        .unwrap();
    assert_eq!(slice.content.as_bytes(), bytes);
    assert!(slice.eof);
    assert_eq!(slice.next_offset, bytes.len() as u64);

    reader.position = 0;
    let slice = super::read_remote_file_slice(&mut reader, 0, 40 * 1024, bytes.len() as u64)
        .await
        .unwrap();
    assert_eq!(reader.position, 40 * 1024);
    assert_eq!(slice.next_offset, 40 * 1024);
    assert!(!slice.eof);
}

#[tokio::test]
async fn remote_file_slice_retains_split_utf8_for_the_next_byte_offset() {
    let bytes = "a你好z".as_bytes().to_vec();
    let mut reader = PacketReader {
        bytes,
        position: 0,
        packet_size: 2,
        fail_at: None,
    };
    let first = super::read_remote_file_slice(&mut reader, 0, 5, 8)
        .await
        .unwrap();
    assert_eq!(first.content, "a你");
    assert_eq!(first.next_offset, 4);
    assert!(!first.eof);
    reader.position = first.next_offset as usize;
    let second = super::read_remote_file_slice(&mut reader, first.next_offset, 4, 8)
        .await
        .unwrap();
    assert_eq!(second.content, "好z");
    assert_eq!(second.next_offset, 8);
    assert!(second.eof);
}

#[tokio::test]
async fn remote_file_slice_propagates_errors_after_partial_reads() {
    let mut reader = PacketReader {
        bytes: vec![b'a'; 20],
        position: 0,
        packet_size: 2,
        fail_at: Some(2),
    };
    let error = super::read_remote_file_slice(&mut reader, 0, 20, 20)
        .await
        .unwrap_err();
    assert!(error.contains("SFTP disconnected"));
}

#[test]
fn windows_sftp_guard_includes_project_ancestors_and_file_components() {
    let components = super::windows_sftp_guard_components("/C:/Users/dev/project/file.txt");
    assert_eq!(
        components,
        vec![
            "/C:/",
            "/C:/Users",
            "/C:/Users/dev",
            "/C:/Users/dev/project",
            "/C:/Users/dev/project/file.txt"
        ]
    );
    assert_eq!(
        components,
        super::windows_sftp_guard_components(r"\\?\C:\Users\dev\project\file.txt")
    );
    assert!(super::windows_sftp_guard_components("/home/dev/project").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires authorized QC_LIVE_* Windows SSH target and verified fingerprint"]
async fn live_windows_sftp_reparse_points_cannot_escape_project() {
    use super::*;

    let required = |name: &str| std::env::var(name).expect(name);
    let config = SshConnectionConfig {
        id: format!("pathguard-{}", uuid::Uuid::new_v4()),
        host: required("QC_LIVE_HOST"),
        port: required("QC_LIVE_PORT").parse().unwrap(),
        username: required("QC_LIVE_USER"),
        auth_kind: "password".into(),
        password: Some(required("QC_LIVE_PASSWORD")),
        private_key_path: None,
        passphrase: None,
        host_key_fingerprint: Some(required("QC_LIVE_FINGERPRINT")),
        mode: Some(RemoteMode::Server),
    };
    let manager = SshManager::new();
    let transport = if let Ok(seconds) = std::env::var("QC_LIVE_DIAGNOSTIC_HANDSHAKE_SECS") {
        let seconds: u64 = seconds.parse().unwrap();
        assert!((20..=90).contains(&seconds));
        // Diagnostic connection acquisition only; production retains its 20s deadline.
        println!("LIVE_WINDOWS_DIAGNOSTIC_HANDSHAKE_SECONDS {seconds}");
        let (handle, disconnect_reason) =
            tokio::time::timeout(Duration::from_secs(seconds), async {
                let (mut handle, _, disconnect_reason) = open_transport(
                    &config,
                    config.host_key_fingerprint.clone(),
                    ConnectionPurpose::Main,
                )
                .await?;
                authenticate(&mut handle, &config).await?;
                Ok::<_, String>((handle, disconnect_reason))
            })
            .await
            .expect("diagnostic SSH handshake exceeded its deadline")
            .unwrap();
        let transport = Arc::new(ConnectedSession {
            server_incarnation: Arc::new(()),
            handle,
            config: Mutex::new(config.clone()),
            sftp: tokio::sync::Mutex::new(None),
            disconnect_reason,
        });
        manager
            .sessions
            .write()
            .unwrap()
            .insert(config.id.clone(), Arc::clone(&transport));
        transport
    } else {
        store_authenticated_session(&manager, config.clone())
            .await
            .unwrap()
            .0
    };
    let sftp = manager.open_sftp(&config.id).await.unwrap();
    let base = join_remote_path(
        &required("QC_LIVE_PARENT"),
        &format!("qingcode-pathguard-{}", uuid::Uuid::new_v4()),
    );
    let project = join_remote_path(&base, "project");
    let outside = join_remote_path(&base, "outside");
    let link = join_remote_path(&project, "escape");
    let junction = join_remote_path(&project, "junction");
    let sentinel = join_remote_path(&outside, "sentinel.txt");
    let owned_marker = b"qingcode-owned-pathguard-sentinel";
    sftp.create_dir(base.clone()).await.unwrap();
    sftp.create_dir(project.clone()).await.unwrap();
    sftp.create_dir(outside.clone()).await.unwrap();
    write_remote_file_contents(&sftp, sentinel.clone(), owned_marker, true)
        .await
        .unwrap();
    let canonical_root = sftp.canonicalize(project.clone()).await.unwrap();
    let uri = format!("ssh://{}{canonical_root}", config.id);
    let root = RegisteredRoot {
        uri: uri.clone(),
        canonical_path: canonical_root,
        trusted: true,
    };
    manager
        .roots
        .write()
        .unwrap()
        .insert(uri.clone(), root.clone());

    let result = async {
            let normal = join_remote_path(&project, "ordinary-中文[1].txt");
            write_remote_file_contents(&sftp, normal.clone(), b"ordinary", true).await?;
            let cold_started = Instant::now();
            ensure_existing_path_within(&sftp, &project, &root).await?;
            let cold_ms = cold_started.elapsed().as_secs_f64() * 1000.0;
            let mut warm_ms = Vec::new();
            for _ in 0..20 {
                let started = Instant::now();
                ensure_existing_path_within(&sftp, &normal, &root).await?;
                if sftp.read(normal.clone()).await.map_err(|e| e.to_string())? != b"ordinary" { return Err("ordinary read failed".into()); }
                ensure_parent_path_within(&sftp, &normal, &root).await?;
                write_remote_file_contents(&sftp, normal.clone(), b"ordinary", false).await?;
                warm_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            warm_ms.sort_by(f64::total_cmp);
            println!("LIVE_WINDOWS_GUARD_PERFORMANCE {}", serde_json::json!({
                "cold_path_check_ms": cold_ms, "warm_guarded_read_write_iterations": warm_ms.len(),
                "warm_guarded_read_write_p50_ms": warm_ms[warm_ms.len()/2],
                "warm_guarded_read_write_p95_ms": warm_ms[(warm_ms.len()*95).div_ceil(100)-1],
                "warm_guarded_read_write_max_ms": warm_ms[warm_ms.len()-1],
                "warm_guarded_read_write_ms": warm_ms,
                "worker_starts": sftp.windows_guard.worker_starts(),
            }));
            sftp.symlink(outside.clone(), link.clone()).await.map_err(|e| e.to_string())?;
            let actual_link = sftp.canonicalize(link.clone()).await.map_err(|e| e.to_string())?;
            let link_metadata = sftp.symlink_metadata(link.clone()).await.map_err(|e| e.to_string())?;
            let link_target = sftp.read_link(link.clone()).await;
            let guard = ensure_existing_path_within(&sftp, &link, &root).await;
            let child_guard = ensure_existing_path_within(&sftp, &join_remote_path(&link, "sentinel.txt"), &root).await;
            let write_guard = ensure_parent_path_within(&sftp, &join_remote_path(&link, "rejected.txt"), &root).await;
            let raw_read = sftp.read(join_remote_path(&link, "sentinel.txt")).await.map_err(|e| e.to_string())?;
            assert_eq!(raw_read, owned_marker);
            println!("LIVE_WINDOWS_SYMLINK {}", serde_json::json!({
                "root": root.canonical_path, "link": link, "realpath": actual_link,
                "lstat_symlink": link_metadata.is_symlink(), "lstat_dir": link_metadata.is_dir(),
                "readlink": format!("{link_target:?}"), "own_outside_sentinel_reachable_via_raw_sftp": true,
                "guard_rejected": guard.is_err(), "child_guard_rejected": child_guard.is_err(),
                "write_guard_rejected": write_guard.is_err(),
            }));
            let native_link = windows_native_path(&link).ok_or("not a Windows fixture")?;
            let attributes = manager.exec_remote_shell(&uri, "false", &format!(
                "Get-Item -LiteralPath '{}' -Force | Select-Object FullName,Attributes,LinkType,Target | ConvertTo-Json -Compress",
                powershell_literal(&native_link)
            ), true, Duration::from_secs(10)).await?;
            println!("LIVE_WINDOWS_NTFS {}", attributes.stdout);
            let native_junction = windows_native_path(&junction).ok_or("invalid junction fixture")?;
            let native_outside = windows_native_path(&outside).ok_or("invalid outside fixture")?;
            let made = manager.exec_remote_shell(&uri, "false", &format!(
                "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",
                powershell_literal(&native_junction), powershell_literal(&native_outside)
            ), true, Duration::from_secs(10)).await?;
            if made.exit_code != 0 { return Err(format!("junction creation failed: {}", made.stderr)); }
            let junction_metadata = sftp.symlink_metadata(junction.clone()).await.map_err(|e| e.to_string())?;
            let junction_target = sftp.read_link(junction.clone()).await;
            let junction_guard = ensure_existing_path_within(&sftp, &junction, &root).await;
            let junction_child_guard = ensure_existing_path_within(&sftp, &join_remote_path(&junction, "sentinel.txt"), &root).await;
            let junction_write_guard = ensure_parent_path_within(&sftp, &join_remote_path(&junction, "rejected.txt"), &root).await;
            let linked_root = RegisteredRoot { uri: uri.clone(), canonical_path: junction.clone(), trusted: true };
            let linked_root_guard = ensure_existing_path_within(&sftp, &join_remote_path(&junction, "sentinel.txt"), &linked_root).await;
            let junction_raw_read = sftp.read(join_remote_path(&junction, "sentinel.txt")).await.map_err(|e| e.to_string())?;
            if junction_raw_read != owned_marker { return Err("junction fixture did not reach owned sentinel".into()); }
            let copied = join_remote_path(&base, "copy");
            let copy_guard = copy_remote_tree(&sftp, project.clone(), copied.clone(), &root).await;
            let copied_outside = sftp.try_exists(join_remote_path(&copied, "escape/sentinel.txt")).await.map_err(|e| e.to_string())?;
            // Ordinary files and directories must keep working through the strengthened guard.
            ensure_existing_path_within(&sftp, &normal, &root).await?;
            ensure_parent_path_within(&sftp, &join_remote_path(&project, "new.txt"), &root).await?;
            let nested_delete = remove_remote_tree(&sftp, join_remote_path(&junction, "sentinel.txt")).await;
            remove_remote_tree(&sftp, link.clone()).await?;
            remove_remote_tree(&sftp, junction.clone()).await?;
            let target_preserved = sftp.read(sentinel.clone()).await.map_err(|e| e.to_string())? == owned_marker;
            let links_removed = !sftp.try_exists(link.clone()).await.map_err(|e| e.to_string())?
                && !sftp.try_exists(junction.clone()).await.map_err(|e| e.to_string())?;
            println!("LIVE_WINDOWS_JUNCTION {}", serde_json::json!({
                "lstat_symlink": junction_metadata.is_symlink(),
                "readlink": format!("{junction_target:?}"),
                "guard_rejected": junction_guard.is_err(), "child_guard_rejected": junction_child_guard.is_err(),
                "write_guard_rejected": junction_write_guard.is_err(), "root_ancestor_link_rejected": linked_root_guard.is_err(),
                "ordinary_file_allowed": true, "recursive_copy_rejected": copy_guard.is_err(),
                "outside_sentinel_not_copied": !copied_outside,
                "one_metadata_worker_reused": sftp.windows_guard.worker_starts() == 1,
                "nested_delete_rejected": nested_delete.is_err(), "link_delete_target_preserved": target_preserved,
                "links_removed_without_recursion": links_removed,
            }));
            Ok::<_, String>(guard.is_err() && child_guard.is_err() && write_guard.is_err()
                && junction_guard.is_err() && junction_child_guard.is_err() && junction_write_guard.is_err()
                && linked_root_guard.is_err() && copy_guard.is_err() && !copied_outside
                && sftp.windows_guard.worker_starts() == 1 && nested_delete.is_err()
                && target_preserved && links_removed)
        }.await;

    if let Err(error) = &result {
        eprintln!("LIVE_WINDOWS_GUARD_FIRST_ERROR {error}");
    }

    // Remove the link itself before the dedicated base; never recurse through it.
    for reparse in [link, junction] {
        if sftp.remove_file(reparse.clone()).await.is_err() {
            let _ = sftp.remove_dir(reparse).await;
        }
    }
    let cleanup = remove_remote_tree(&sftp, base.clone()).await;
    if let Ok(previous) = std::env::var("QC_LIVE_CLEANUP_ROOT") {
        let parent = required("QC_LIVE_PARENT");
        assert_eq!(remote_parent_path(&previous).unwrap(), parent);
        let name = previous.rsplit('/').next().unwrap();
        uuid::Uuid::parse_str(
            name.strip_prefix("qingcode-live-")
                .expect("not a live fixture"),
        )
        .unwrap();
        if sftp.try_exists(previous.clone()).await.unwrap() {
            remove_remote_tree(&sftp, previous).await.unwrap();
        }
        println!("LIVE_WINDOWS_PREVIOUS_FIXTURE_REMOVED true");
    }
    let worker_pid = sftp.windows_guard.worker_pid();
    let cached = transport.sftp.lock().await.take();
    drop(cached);
    let mut owned_sftp = match Arc::try_unwrap(sftp) {
        Ok(owned) => owned,
        Err(_) => panic!("test retained another SFTP wrapper reference"),
    };
    let guard = std::mem::take(&mut owned_sftp.windows_guard);
    std::thread::spawn(move || drop(guard))
        .join()
        .expect("guard Drop panicked without entered runtime");
    drop(owned_sftp);
    let worker_exit = if worker_pid > 0 {
        manager.exec_remote_shell(&uri, "false", &format!(
                "$p = Get-Process -Id {worker_pid} -ErrorAction SilentlyContinue; if ($p -and -not $p.WaitForExit(5000)) {{ [Console]::Write('alive') }} else {{ [Console]::Write('gone') }}"
            ), true, Duration::from_secs(10)).await
                .map(|output| output.exit_code == 0 && output.stdout == "gone")
    } else {
        Ok(false)
    };
    close_terminal_transport(&transport).await;
    println!(
        "LIVE_WINDOWS_GUARD_TEARDOWN {}",
        serde_json::json!({
            "drop_without_runtime_did_not_panic": true, "worker_pid": worker_pid,
            "worker_exited": worker_exit.as_ref().copied().unwrap_or(false),
        })
    );
    if let Err(error) = &cleanup {
        eprintln!("LIVE_WINDOWS_GUARD_CLEANUP_ERROR {error}");
    }
    cleanup.unwrap();
    assert!(
        result.unwrap(),
        "Windows SFTP reparse point escaped registered project root"
    );
    assert!(
        worker_exit.unwrap(),
        "metadata worker remained after guard teardown"
    );
}

#[tokio::test]
async fn host_fingerprint_probe_times_out_on_silent_tcp_server_and_closes_socket() {
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("probe never connected to test server")
            .unwrap();
        // Deliberately withhold the server banner. Cancellation must close
        // the actual accepted socket, rather than leave a detached probe.
        let mut client_banner = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(2),
            stream.read_to_end(&mut client_banner),
        )
        .await
        .expect("probe timeout did not close its TCP socket")
        .unwrap();
        assert!(client_banner.starts_with(b"SSH-2.0-"));
    });
    let mut config = sample_config(None);
    config.host = address.ip().to_string();
    config.port = address.port();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        super::probe_host_with_timeout(&config, Duration::from_millis(50)),
    )
    .await
    .expect("fingerprint probe exceeded its overall deadline");
    let error = result.unwrap_err();
    assert!(error.contains("SSH 主机指纹探测超时"), "{error}");
    assert!(error.contains(&address.to_string()), "{error}");
    server.await.unwrap();
}

#[test]
fn connection_mode_deserializes_lowercase_and_defaults_to_none() {
    let with_mode: super::SshConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "c1", "host": "h", "username": "u", "mode": "ssh"
    }))
    .unwrap();
    assert_eq!(with_mode.mode, Some(super::RemoteMode::Ssh));
    let without: super::SshConnectionConfig =
        serde_json::from_value(serde_json::json!({ "id": "c1", "host": "h", "username": "u" }))
            .unwrap();
    assert_eq!(without.mode, None);
    assert!(
        serde_json::from_value::<super::SshConnectionConfig>(serde_json::json!({
            "id": "c1", "host": "h", "username": "u", "mode": "direct"
        }))
        .is_err()
    );
}

#[test]
fn mode_conflict_only_when_roots_registered_under_other_mode() {
    use super::{mode_conflict, RemoteMode::*};
    assert!(mode_conflict(Some(Server), Ssh, true)
        .unwrap()
        .contains("连接模式已变更"));
    assert!(mode_conflict(Some(Ssh), Server, true).is_some());
    // 只用来浏览目录的会话（还没有根）可以在连接时定下模式。
    assert!(mode_conflict(Some(Server), Ssh, false).is_none());
    assert!(mode_conflict(None, Ssh, true).is_none());
    assert!(mode_conflict(Some(Ssh), Ssh, true).is_none());
}

#[test]
fn remembered_config_keeps_mode_when_incoming_has_none() {
    use super::{merge_remembered_config, RemoteMode};
    let kept = merge_remembered_config(Some(RemoteMode::Server), sample_config(None));
    assert_eq!(kept.mode, Some(RemoteMode::Server));
    let mut incoming = sample_config(None);
    incoming.mode = Some(RemoteMode::Ssh);
    let replaced = merge_remembered_config(Some(RemoteMode::Server), incoming);
    assert_eq!(replaced.mode, Some(RemoteMode::Ssh));
}

#[test]
fn server_mode_is_false_without_session() {
    let manager = super::SshManager::new();
    assert_eq!(manager.connection_mode("missing"), None);
    assert!(!manager.server_mode("missing"));
}

#[test]
fn server_mode_errors_carry_prefix_once() {
    let wrapped = super::into_server_mode_error("远端 daemon 尚未就绪".to_string());
    assert!(wrapped.starts_with(super::server::SERVER_MODE_ERROR_PREFIX));
    // 已带前缀的错误不重复包装。
    assert_eq!(super::into_server_mode_error(wrapped.clone()), wrapped);
}

#[test]
fn server_mode_task_launch_runs_invocation_with_sh() {
    let launch = super::persistent_task_launch("FOO='1' exec /bin/sh 'build.sh'", "构建");
    assert_eq!(launch.shell.as_deref(), Some("/bin/sh"));
    assert_eq!(
        launch.args,
        vec![
            "-c".to_string(),
            "FOO='1' exec /bin/sh 'build.sh'".to_string()
        ]
    );
    assert_eq!(launch.name.as_deref(), Some("构建"));
    assert_eq!(launch.resolved_shell, "sh");
}

#[test]
fn terminal_pool_picks_first_transport_with_room() {
    assert_eq!(super::pick_terminal_transport([(10, 10), (3, 10)]), Some(1));
    assert_eq!(super::pick_terminal_transport([(10, 10), (4, 4)]), None);
    assert_eq!(super::pick_terminal_transport(std::iter::empty()), None);
}

#[test]
fn main_terminal_fallback_and_commands_share_session_budget() {
    let manager = SshManager::new();
    let slots = manager.exec_slots("budget-test").unwrap();
    let mut terminals: Vec<_> = (0..TERMINAL_MAIN_FALLBACK_LIMIT)
        .map(|_| manager.try_main_fallback_slot("budget-test").unwrap())
        .collect();
    let commands: Vec<_> = (TERMINAL_MAIN_FALLBACK_LIMIT..MAX_CONCURRENT_EXEC_CHANNELS)
        .map(|_| Arc::clone(&slots).try_acquire_owned().unwrap())
        .collect();
    assert_eq!(slots.available_permits(), 0);
    assert!(manager.try_main_fallback_slot("budget-test").is_none());
    assert!(Arc::clone(&slots).try_acquire_owned().is_err());

    drop(terminals.pop());
    let replacement = Arc::clone(&slots).try_acquire_owned().unwrap();
    assert!(manager.try_main_fallback_slot("budget-test").is_none());
    drop((terminals, commands, replacement));
    assert_eq!(slots.available_permits(), MAX_CONCURRENT_EXEC_CHANNELS);
}

#[test]
fn terminal_pool_refusal_learns_open_channel_count() {
    // 含本次被拒的租约：已开 3 个通道时 sshd 拒绝，实际上限就是 3。
    assert_eq!(super::observed_capacity_after_refusal(4), Some(3));
    // 一个通道都没开就被拒，不是会话数打满，不修正容量。
    assert_eq!(super::observed_capacity_after_refusal(1), None);
    assert_eq!(super::observed_capacity_after_refusal(0), None);
}

#[test]
fn terminal_pool_capacity_follows_sshd_max_sessions() {
    let limit = |max_sessions, source| super::SshdSessionLimit {
        max_sessions,
        source,
    };
    use super::SshdSessionLimitSource::{Config, Default, Observed};
    assert_eq!(limit(20, Config).transport_capacity(), 20);
    assert_eq!(limit(10, Default).transport_capacity(), 10);
    // MaxSessions 0/1 无法复用连接，退化为每个终端一条连接。
    assert_eq!(limit(0, Config).transport_capacity(), 1);
    assert_eq!(limit(1, Observed).transport_capacity(), 1);
}

#[test]
fn terminal_pool_full_notice_names_count_and_source() {
    let notice = super::terminal_pool_full_notice(
        2,
        super::SshdSessionLimit {
            max_sessions: 10,
            source: super::SshdSessionLimitSource::Config,
        },
    );
    assert!(notice.contains("已有 2 条"));
    assert!(notice.contains("每条连接最多 10 个终端"));
    assert!(notice.contains("MaxSessions"));
    assert!(notice.contains("第 3 条"));
}

use super::*;

#[test]
fn profile_terminal_name_prefers_tab_name_over_terminal_id() {
    assert_eq!(
        profile_terminal_name(Some(" OpenCode "), "uuid-1"),
        "OpenCode"
    );
    assert_eq!(profile_terminal_name(Some("  "), "uuid-1"), "uuid-1");
    assert_eq!(profile_terminal_name(None, "uuid-1"), "uuid-1");
}

#[test]
fn image_read_limit_stays_at_64mb_like_the_local_viewer() {
    // 本地 `cmd_stat::IMAGE_MAX_BYTES` 以同值字面量独立断言；两侧一起防漂移。
    assert_eq!(IMAGE_MAX_BYTES, 64 * 1024 * 1024);
}

#[test]
fn workspace_download_policies_do_not_overwrite_each_other_or_global_defaults() {
    let manager = SshManager::new();
    let automatic = std::env::temp_dir().join(format!("qingcode-policy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&automatic).unwrap();
    manager.set_server_binary_dirs(vec![automatic.clone()]);
    manager.workspace_server_settings.write().unwrap().extend([
        (
            "ssh://c/a".into(),
            WorkspaceServerSettings {
                auto_download: false,
                offline_dir: Some(PathBuf::from("offline-a")),
            },
        ),
        (
            "ssh://c/b".into(),
            WorkspaceServerSettings {
                auto_download: true,
                offline_dir: None,
            },
        ),
    ]);
    assert_eq!(
        manager.server_binary_dirs_for_root("ssh://c/a/"),
        vec![PathBuf::from("offline-a"), automatic.clone()]
    );
    assert_eq!(
        manager.server_binary_dirs_for_root("ssh://c/b"),
        vec![automatic.clone()]
    );
    assert!(!manager.server_auto_download_for_root("ssh://c/a"));
    assert!(manager.server_auto_download_for_root("ssh://c/b"));
    assert!(manager.server_auto_download());
    assert_eq!(manager.server_binary_dirs(), vec![automatic.clone()]);
    std::fs::remove_dir(automatic).unwrap();
}

#[test]
fn workspace_download_policy_rejects_remote_paths_and_accepts_empty_offline_override() {
    for path in [
        "ssh://host/home/server",
        "https://example.test/server",
        "bad\0path",
    ] {
        assert!(WorkspaceServerSettings {
            auto_download: false,
            offline_dir: Some(PathBuf::from(path))
        }
        .validated()
        .is_err());
    }
    let settings: WorkspaceServerSettings =
        serde_json::from_value(serde_json::json!({"autoDownload":false,"offlineDir":""})).unwrap();
    assert_eq!(
        settings.validated().unwrap(),
        WorkspaceServerSettings {
            auto_download: false,
            offline_dir: None
        }
    );
}

#[test]
fn passive_registration_remains_passive_across_trust_changes() {
    let manager = SshManager::new();
    manager
        .passive_roots
        .write()
        .unwrap()
        .insert("ssh://c/a".into());
    manager.roots.write().unwrap().insert(
        "ssh://c/a".into(),
        RegisteredRoot {
            uri: "ssh://c/a".into(),
            canonical_path: "/a".into(),
            trusted: true,
        },
    );
    manager.set_root_trust("ssh://c/a", false).unwrap();
    manager.set_root_trust("ssh://c/a", true).unwrap();
    assert!(manager.root_is_passive("ssh://c/a/"));
    assert!(!manager.root_is_passive("ssh://c/other"));
    assert!(manager.watch_supervisors.lock().unwrap().is_empty());
}

#[test]
fn offline_dir_is_searched_before_other_server_dirs() {
    let manager = SshManager::new();
    let root = std::env::temp_dir().join(format!("qingcode-offline-order-{}", std::process::id()));
    let offline = root.join("picked");
    let other = root.join("bundled");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&offline).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    manager.set_server_binary_dirs(vec![other.clone(), offline.clone()]);
    manager.set_server_offline_dir(Some(offline.clone()));
    let dirs = manager.server_binary_dirs();
    assert_eq!(dirs.first(), Some(&offline));
    assert_eq!(dirs.iter().filter(|dir| *dir == &offline).count(), 1);
    manager.set_server_offline_dir(None);
    assert_eq!(manager.server_binary_dirs().first(), Some(&other));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn closed_flag_stream_marks_eof_but_not_data() {
    let (client, mut server) = tokio::io::duplex(64);
    let health = Arc::new(SftpHealth::new());
    let mut stream = ClosedFlagStream {
        inner: client,
        health: Arc::clone(&health),
    };
    server.write_all(b"ok").await.unwrap();
    let mut buf = [0u8; 8];
    assert_eq!(stream.read(&mut buf).await.unwrap(), 2);
    assert!(!health.is_unusable(Duration::from_secs(3600)));
    drop(server);
    assert_eq!(stream.read(&mut buf).await.unwrap(), 0);
    assert!(health.is_unusable(Duration::from_secs(3600)));
}

#[tokio::test]
async fn sftp_health_flags_requests_left_unanswered() {
    let (client, mut server) = tokio::io::duplex(64);
    let health = Arc::new(SftpHealth::new());
    let mut stream = ClosedFlagStream {
        inner: client,
        health: Arc::clone(&health),
    };
    // 空闲会话不算僵死，无论空闲多久。
    assert!(!health.is_unusable(Duration::ZERO));

    stream.write_all(b"req").await.unwrap();
    assert!(health.is_unusable(Duration::ZERO));
    assert!(!health.is_unusable(Duration::from_secs(3600)));

    // 收到回包后不再有未答请求。
    server.write_all(b"resp").await.unwrap();
    let mut buf = [0u8; 8];
    assert_eq!(stream.read(&mut buf).await.unwrap(), 4);
    assert!(!health.is_unusable(Duration::ZERO));
}

#[test]
fn remote_git_network_commands_get_a_longer_timeout() {
    let args = |name: &str| vec![name.to_string(), "origin".to_string()];
    assert_eq!(
        remote_git_timeout(&args("fetch")),
        REMOTE_NETWORK_EXEC_TIMEOUT
    );
    assert_eq!(
        remote_git_timeout(&args("push")),
        REMOTE_NETWORK_EXEC_TIMEOUT
    );
    assert_eq!(remote_git_timeout(&args("status")), REMOTE_EXEC_TIMEOUT);
    assert_eq!(remote_git_timeout(&[]), REMOTE_EXEC_TIMEOUT);
}

#[test]
fn entries_share_prefix_detects_a_stale_cached_prefix() {
    let entries = vec![("apps/web/a.ts".to_string(), " M".to_string())];
    assert!(entries_share_prefix(&entries, ""));
    assert!(entries_share_prefix(&entries, "apps/web/"));
    assert!(!entries_share_prefix(&entries, "apps/api/"));
    assert!(entries_share_prefix(&[], "apps/api/"));
}

#[test]
fn replaced_ssh_terminal_does_not_emit_exit() {
    let alive = AtomicBool::new(true);
    alive.store(false, Ordering::Release);
    assert!(!claim_terminal_exit(&alive));
}

#[test]
fn current_ssh_terminal_exit_is_reported_once() {
    let alive = AtomicBool::new(true);
    assert!(claim_terminal_exit(&alive));
    assert!(!claim_terminal_exit(&alive));
}

#[test]
fn parses_remote_uri_without_losing_case() {
    let uri = parse_remote_uri("ssh://abc/Home/User/Foo.ts").unwrap();
    assert_eq!(uri.connection_id, "abc");
    assert_eq!(uri.path, "/Home/User/Foo.ts");
}

#[test]
fn rejects_parent_segments() {
    assert!(parse_remote_uri("ssh://abc/home/user/../secret").is_err());
}

#[test]
fn remote_containment_has_path_boundary() {
    assert!(remote_uri_is_within(
        "ssh://abc/home/user/app/src",
        "ssh://abc/home/user/app"
    ));
    assert!(!remote_uri_is_within(
        "ssh://abc/home/user/application",
        "ssh://abc/home/user/app"
    ));
}

#[test]
fn extracts_connection_id_from_root_uri() {
    assert_eq!(remote_uri_connection_id("ssh://abc"), Some("abc"));
    assert_eq!(remote_uri_connection_id("ssh://abc/"), Some("abc"));
}

#[test]
fn shell_quote_escapes_single_quotes() {
    assert_eq!(shell_quote("a'b"), "'a'\\''b'");
}

#[test]
fn remote_writes_create_and_truncate_destination_files() {
    let replace = remote_write_flags(false);
    assert!(replace.contains(OpenFlags::CREATE));
    assert!(replace.contains(OpenFlags::TRUNCATE));
    assert!(replace.contains(OpenFlags::WRITE));
    assert!(!replace.contains(OpenFlags::EXCLUDE));

    let create_new = remote_write_flags(true);
    assert!(create_new.contains(OpenFlags::EXCLUDE));
}

#[test]
fn remote_scripts_use_an_interpreter_matching_the_extension() {
    let python = remote_script_invocation("scripts/dev.py", "PORT='3000' ").unwrap();
    assert!(python.contains("PORT='3000' exec python3 'scripts/dev.py'"));

    let typescript = remote_script_invocation("scripts/dev.ts", "").unwrap();
    assert!(typescript.contains("node_modules/.bin/tsx 'scripts/dev.ts'"));

    assert_eq!(
        remote_script_invocation("scripts/dev.sh", "MODE='test' ").unwrap(),
        "MODE='test' exec /bin/sh 'scripts/dev.sh'"
    );
}

#[test]
fn remote_scripts_reject_windows_script_types() {
    assert!(remote_script_invocation("scripts/dev.ps1", "").is_err());
    assert!(remote_script_invocation("scripts/dev.bat", "").is_err());
}

#[test]
fn simple_globs_cover_extensions_and_nested_directories() {
    assert!(simple_glob_matches("*.map", "dist/app.js.map"));
    assert!(simple_glob_matches(
        "**/node_modules/**",
        "packages/app/node_modules/lib/index.js"
    ));
    assert!(!simple_glob_matches("*.map", "src/app.ts"));
}

#[test]
fn git_inputs_reject_command_like_values() {
    assert!(validate_commit_rev("abc123").is_ok());
    assert!(validate_commit_rev("HEAD; rm -rf /").is_err());
    assert!(validate_branch_name("feature/ssh").is_ok());
    assert!(validate_branch_name("--exec=evil").is_err());
    assert!(validate_branch_name("refs/heads/main").is_err());
}

fn sample_config(private_key_path: Option<&str>) -> SshConnectionConfig {
    SshConnectionConfig {
        id: "test".to_string(),
        host: "127.0.0.1".to_string(),
        port: 22,
        username: "user".to_string(),
        auth_kind: "privateKey".to_string(),
        password: None,
        private_key_path: private_key_path.map(str::to_string),
        passphrase: None,
        host_key_fingerprint: None,
        mode: None,
    }
}

#[test]
fn live_session_config_rejects_identity_and_credential_changes() {
    let original = sample_config(Some("/keys/one"));
    let mut requested = original.clone();
    requested.host = "LOCALHOST".into();
    assert!(require_matching_session_config(&original, &requested).is_err());
    requested = original.clone();
    requested.password = Some("wrong-password".into());
    assert!(require_matching_session_config(&original, &requested).is_err());
    requested = original.clone();
    requested.host_key_fingerprint = Some("SHA256:other-host".into());
    assert!(require_matching_session_config(&original, &requested).is_err());
    requested = original.clone();
    requested.mode = Some(RemoteMode::Server);
    assert!(require_matching_session_config(&original, &requested).is_ok());
    assert_eq!(original.host, "127.0.0.1");
    assert!(original.password.is_none());
}

#[test]
fn pausing_one_project_preserves_other_shared_daemon_bindings() {
    let manager = SshManager::new();
    let daemon = server::DaemonAccess {
        bin: "/home/u/server".into(),
        token: "shared".into(),
    };
    for key in ["one|/srv/a", "two|/srv/b"] {
        manager.set_server_slot(
            key,
            server::ServerSlot {
                endpoint: Some(server::ServerEndpoint {
                    serve: None,
                    daemon: Some(daemon.clone()),
                }),
                ..Default::default()
            },
        );
    }
    manager.pause_project_server("one|/srv/a");
    let stopped = manager.server_slot("one|/srv/a").unwrap();
    assert!(stopped.endpoint.is_none());
    assert!(stopped.unavailable_reason.is_some());
    let other = manager.server_slot("two|/srv/b").unwrap().endpoint.unwrap();
    assert!(other.daemon.as_ref() == Some(&daemon));
    manager.clear_server_endpoint("one|/srv/a");
    assert!(manager
        .server_slot("one|/srv/a")
        .unwrap()
        .unavailable_reason
        .is_none());
}

#[test]
fn cancelling_a_watch_incarnation_cannot_revive_when_its_root_is_retrusted() {
    let manager = SshManager::new();
    let old = manager.begin_watch_supervisor("one|/srv/a");
    manager.stop_watch_supervisor("one|/srv/a");
    assert!(old.load(Ordering::Acquire));
    let replacement = manager.begin_watch_supervisor("one|/srv/a");
    assert!(old.load(Ordering::Acquire));
    assert!(!replacement.load(Ordering::Acquire));
    let third = manager.begin_watch_supervisor("one|/srv/a");
    assert!(replacement.load(Ordering::Acquire));
    assert!(!third.load(Ordering::Acquire));
}

#[test]
fn default_key_candidates_prefer_ed25519() {
    let home = PathBuf::from("home").join("owner");
    let keys = default_private_key_candidates(&home);
    assert_eq!(keys[0], home.join(".ssh").join("id_ed25519"));
    assert!(keys.iter().any(|path| path.ends_with("id_rsa")));
}

#[test]
fn explicit_private_key_wins_over_defaults() {
    let config = sample_config(Some("D:/keys/wsl"));
    assert_eq!(
        resolve_private_key_paths(&config).unwrap(),
        vec![PathBuf::from("D:/keys/wsl")]
    );
}

#[test]
fn blank_private_key_falls_back_to_defaults() {
    let config = sample_config(Some("   "));
    assert!(explicit_private_key_path(&config).is_none());
}

#[test]
fn empty_manager_has_no_existing_session() {
    let manager = SshManager::new();
    assert!(existing_session(&manager, "missing").is_none());
}

#[test]
fn daemon_client_id_combines_install_uuid_and_connection() {
    let manager = SshManager::new();
    manager.set_client_id("8f2af0e7-7a7e-4af0-9f67-2bc588c9146e".to_string());
    assert_eq!(
        manager.daemon_client_id("remote-a"),
        "8f2af0e7-7a7e-4af0-9f67-2bc588c9146e:remote-a"
    );
}

#[test]
fn connected_root_trust_can_be_updated_without_reconnecting() {
    let manager = SshManager::new();
    manager.roots.write().unwrap().insert(
        "test".to_string(),
        RegisteredRoot {
            uri: "ssh://test/home/owner/app".to_string(),
            canonical_path: "/home/owner/app".to_string(),
            trusted: false,
        },
    );

    manager
        .set_root_trust("ssh://test/home/owner/app/", true)
        .unwrap();

    assert!(manager.roots.read().unwrap().get("test").unwrap().trusted);
}

#[test]
fn same_connection_keeps_distinct_same_named_roots_registered() {
    let manager = SshManager::new();
    for (key, uri, canonical_path) in [
        ("team-app", "ssh://wsl/home/team/app", "/home/team/app"),
        ("work-app", "ssh://wsl/work/other/app", "/work/other/app"),
    ] {
        manager.roots.write().unwrap().insert(
            key.to_string(),
            RegisteredRoot {
                uri: uri.to_string(),
                canonical_path: canonical_path.to_string(),
                trusted: true,
            },
        );
    }

    assert!(manager
        .root_is_registered("ssh://wsl/home/team/app/")
        .unwrap());
    assert!(manager
        .root_is_registered("ssh://wsl/work/other/app")
        .unwrap());
    assert!(!manager
        .root_is_registered("ssh://wsl/home/team/other")
        .unwrap());
}

#[test]
fn roots_for_connection_filters_by_connection_id() {
    let manager = SshManager::new();
    for (key, uri) in [
        ("wsl-app", "ssh://wsl/home/app"),
        ("wsl-docs", "ssh://wsl/home/docs"),
        ("win-app", "ssh://w1n/D:/code/app"),
    ] {
        manager.roots.write().unwrap().insert(
            key.to_string(),
            RegisteredRoot {
                uri: uri.to_string(),
                canonical_path: uri
                    .trim_start_matches("ssh://")
                    .split_once('/')
                    .map(|(_, path)| format!("/{path}"))
                    .unwrap_or_else(|| "/".to_string()),
                trusted: key != "wsl-docs",
            },
        );
    }
    let roots = manager.roots_for_connection("wsl");
    assert_eq!(roots.len(), 2);
    assert!(roots.iter().all(|root| root.uri.starts_with("ssh://wsl/")));
    assert!(manager.roots_for_connection("missing").is_empty());
}

#[test]
fn ssh_workspace_root_serializes_camel_case() {
    let root = SshWorkspaceRoot {
        root_uri: "ssh://wsl/home/app".to_string(),
        trusted: true,
    };
    let value = serde_json::to_value(&root).unwrap();
    assert_eq!(value["rootUri"], "ssh://wsl/home/app");
    assert_eq!(value["trusted"], true);
    assert!(value.get("root_uri").is_none());
}

#[test]
fn join_remote_path_from_root_and_child() {
    assert_eq!(join_remote_path("/", "root"), "/root");
    assert_eq!(join_remote_path("/root", "go"), "/root/go");
    assert_eq!(join_remote_path("/root/", ".claude"), "/root/.claude");
}

#[test]
fn home_path_candidates_prefer_user_home() {
    assert_eq!(
        home_path_candidates("owner"),
        vec![
            "/home/owner".to_string(),
            "/C:/Users/owner".to_string(),
            "/root".to_string(),
            "/".to_string()
        ]
    );
    assert_eq!(
        home_path_candidates("root"),
        vec!["/root".to_string(), "/".to_string()]
    );
}

#[test]
fn windows_drive_path_becomes_native_directory() {
    assert_eq!(
        windows_native_path("/D:/code/nem-panel").as_deref(),
        Some(r"D:\code\nem-panel")
    );
    assert_eq!(
        windows_native_path(r"\\?\D:\code\nem-panel").as_deref(),
        Some(r"D:\code\nem-panel")
    );
    assert_eq!(
        windows_native_path("//?/D:/code/nem-panel").as_deref(),
        Some(r"D:\code\nem-panel")
    );
    assert_eq!(windows_native_path("/C:").as_deref(), Some(r"C:\"));
    assert!(windows_native_path("/home/owner/app").is_none());
    assert!(windows_native_path(r"D:code\relative").is_none());
}

const BASE64_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 去掉可选的外层双引号和启动前缀，返回 base64 部分，并确认只含 base64 字符。
fn encoded_part<'a>(command: &'a str, launcher: &str) -> &'a str {
    let inner = command
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(command);
    let encoded = inner
        .strip_prefix(launcher)
        .and_then(|rest| rest.strip_prefix(" -EncodedCommand "))
        .unwrap();
    assert!(encoded
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=')));
    encoded
}

/// 把 base64(UTF-16LE) 还原成脚本文本，便于断言实际执行的内容。
fn decoded_script(command: &str, launcher: &str) -> String {
    let mut bits = 0u32;
    let mut width = 0;
    let mut bytes = Vec::new();
    for ch in encoded_part(command, launcher)
        .bytes()
        .filter(|&ch| ch != b'=')
    {
        let value = BASE64_ALPHABET.iter().position(|&c| c == ch).unwrap() as u32;
        bits = (bits << 6) | value;
        width += 6;
        if width >= 8 {
            width -= 8;
            bytes.push((bits >> width) as u8);
            bits &= (1 << width) - 1;
        }
    }
    let utf16 = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect::<Vec<_>>();
    String::from_utf16(&utf16).unwrap()
}

#[test]
fn windows_terminal_starts_powershell_in_project() {
    let quoted = ssh_interactive_terminal_command("/D:/code/it's", Some("powershell")).unwrap();
    assert_eq!(
        decoded_script(&quoted.command, "powershell.exe -NoLogo -NoExit"),
        format!(
            "{}; Set-Location -LiteralPath 'D:\\code\\it''s'",
            WINDOWS_POWERSHELL_UTF8_SETUP
        )
    );
    assert!(quoted.command.starts_with('"') && quoted.command.ends_with('"'));
    assert!(quoted.enter_directory.is_none());

    let command = ssh_interactive_terminal_command("/D:/code/nem-panel", None).unwrap();
    assert_eq!(
        decoded_script(&command.command, "powershell.exe -NoLogo -NoExit"),
        format!(
            "{}; Set-Location -LiteralPath 'D:\\code\\nem-panel'",
            WINDOWS_POWERSHELL_UTF8_SETUP
        ),
    );
    assert!(command.enter_directory.is_none());
    assert_eq!(command.resolved_shell, "powershell");
    assert_eq!(command.fallback_from, None);

    let cmd_launcher = "powershell.exe -NoLogo -NoProfile -NonInteractive";
    let cmd_target = ssh_interactive_terminal_command("/D:/code/my project", Some("cmd")).unwrap();
    assert_eq!(
        decoded_script(&cmd_target.command, cmd_launcher),
        r"$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath 'D:\code\my project'; & cmd.exe /K 'chcp 65001>nul'; exit $LASTEXITCODE"
    );
    assert!(cmd_target.enter_directory.is_none());
    assert_eq!(cmd_target.resolved_shell, "cmd");
    assert_eq!(cmd_target.fallback_from, None);
    let cmd_percent = ssh_interactive_terminal_command("/D:/100%done", Some("cmd")).unwrap();
    assert!(decoded_script(&cmd_percent.command, cmd_launcher).contains(r"'D:\100%done'"));
    let cmd_root = ssh_interactive_terminal_command("/C:", Some("cmd")).unwrap();
    assert!(decoded_script(&cmd_root.command, cmd_launcher).contains("'C:\\'"));

    let pwsh_target = ssh_interactive_terminal_command("/D:/code/nem-panel", Some("pwsh")).unwrap();
    assert_eq!(
        decoded_script(&pwsh_target.command, "pwsh.exe -NoLogo -NoExit"),
        format!(
            "{}; Set-Location -LiteralPath 'D:\\code\\nem-panel'",
            WINDOWS_POWERSHELL_UTF8_SETUP
        ),
    );
    assert!(pwsh_target.enter_directory.is_none());
    assert_eq!(pwsh_target.resolved_shell, "pwsh");

    let fallback = ssh_interactive_terminal_command("/D:/code/nem-panel", Some("bash")).unwrap();
    assert_eq!(
        decoded_script(&fallback.command, "powershell.exe -NoLogo -NoExit"),
        format!(
            "{}; Set-Location -LiteralPath 'D:\\code\\nem-panel'",
            WINDOWS_POWERSHELL_UTF8_SETUP
        ),
    );
    assert!(fallback.enter_directory.is_none());
    assert_eq!(fallback.resolved_shell, "powershell");
    assert_eq!(fallback.fallback_from, Some("bash".to_string()));

    assert!(ssh_interactive_terminal_command("/D:/code/a\nb", None).is_err());
    assert!(reject_windows_remote_command("/D:/code/nem-panel").is_err());
}

#[test]
fn persistent_windows_shell_forces_utf8_console_and_file_reading() {
    // `cat` 是 Get-Content 的别名；只设置控制台编码不够，必须固定文件读取编码。
    assert!(WINDOWS_POWERSHELL_UTF8_SETUP.contains("Get-Content:Encoding"));
    assert!(WINDOWS_CMD_UTF8_SETUP.contains("65001"));

    let powershell = persistent_shell_launch("/D:/code/app", None).unwrap();
    assert_eq!(powershell.shell.as_deref(), Some("powershell"));
    assert_eq!(
        powershell.args,
        vec![
            "-NoLogo".to_string(),
            "-NoExit".to_string(),
            "-Command".to_string(),
            WINDOWS_POWERSHELL_UTF8_SETUP.to_string(),
        ]
    );

    let cmd = persistent_shell_launch("/D:/code/app", Some("cmd")).unwrap();
    assert_eq!(cmd.shell.as_deref(), Some("cmd"));
    assert_eq!(
        cmd.args,
        vec!["/K".to_string(), WINDOWS_CMD_UTF8_SETUP.to_string()]
    );

    let profile = persistent_profile_launch(
        "/D:/code/app",
        "opencode",
        &HashMap::new(),
        Some("powershell"),
        "OpenCode",
    )
    .unwrap();
    assert_eq!(profile.name.as_deref(), Some("OpenCode"));
    assert!(profile.args[3].starts_with(WINDOWS_POWERSHELL_UTF8_SETUP));
    assert!(profile.args[3].ends_with("; opencode"));

    let unix = persistent_shell_launch("/srv/app", Some("bash")).unwrap();
    assert!(unix.args.is_empty());
}

#[test]
fn windows_profile_direct_fallback_sets_cwd_env_and_command() {
    let env = HashMap::from([("OPENCODE_MODE".to_string(), "dev".to_string())]);
    let powershell = direct_windows_profile_command(
        "/D:/code/my project",
        "opencode --watch",
        &env,
        Some("powershell"),
    )
    .unwrap();
    let script = decoded_script(&powershell, "powershell.exe -NoLogo -NoExit");
    assert!(script.contains(WINDOWS_POWERSHELL_UTF8_SETUP));
    assert!(script.contains(r"$env:OPENCODE_MODE = 'dev'"));
    assert!(script.contains(r"Set-Location -LiteralPath 'D:\code\my project'"));
    assert!(script.ends_with("opencode --watch"));

    let cmd = direct_windows_profile_command(
        "/D:/code/my project",
        "opencode --watch",
        &HashMap::new(),
        Some("cmd"),
    )
    .unwrap();
    let script = decoded_script(&cmd, "powershell.exe -NoLogo -NoProfile -NonInteractive");
    assert!(script.contains(r"& cmd.exe /K 'chcp 65001>nul & opencode --watch'"));
}

#[test]
fn disconnect_reason_explains_keepalive_timeout_and_remote_close() {
    let keepalive = describe_disconnect(
        &client::DisconnectReason::Error(russh::Error::KeepaliveTimeout),
        keepalive_window(ConnectionPurpose::Main),
    );
    assert!(keepalive.starts_with("保活超时"));
    assert!(keepalive.contains("40 秒"));
    let terminal_keepalive = describe_disconnect(
        &client::DisconnectReason::Error(russh::Error::KeepaliveTimeout),
        keepalive_window(ConnectionPurpose::Terminal),
    );
    assert!(terminal_keepalive.starts_with("保活超时"));
    assert!(terminal_keepalive.contains("75 秒"));
    let remote = describe_disconnect(
        &client::DisconnectReason::ReceivedDisconnect(client::RemoteDisconnectInfo {
            reason_code: russh::Disconnect::ByApplication,
            message: " sshd restarting ".to_string(),
            lang_tag: String::new(),
        }),
        keepalive_window(ConnectionPurpose::Main),
    );
    assert!(remote.starts_with("远端主动断开"));
    assert!(remote.ends_with("sshd restarting"));
    let io = describe_disconnect(
        &client::DisconnectReason::Error(russh::Error::HUP),
        keepalive_window(ConnectionPurpose::Main),
    );
    assert!(io.starts_with("连接异常断开"));
}

#[test]
fn ssh_client_waits_through_a_slow_keepalive_reply() {
    let main = ssh_client_config(ConnectionPurpose::Main);
    assert!(main.inactivity_timeout.is_none());
    assert_eq!(main.keepalive_interval, Some(Duration::from_secs(10)));
    assert_eq!(main.keepalive_max, 3);
    assert!(main.nodelay);

    let terminal = ssh_client_config(ConnectionPurpose::Terminal);
    assert!(terminal.inactivity_timeout.is_none());
    assert_eq!(terminal.keepalive_interval, Some(Duration::from_secs(15)));
    assert_eq!(terminal.keepalive_max, 4);
    assert!(terminal.nodelay);
}

#[test]
fn terminal_exit_payload_serializes_reason_only_when_present() {
    let disconnected = serde_json::to_value(TerminalExitPayload {
        id: "terminal-1".to_string(),
        exit_code: 1,
        disconnected: true,
        reason: Some("保活超时：约 75 秒未收到远端任何回包".to_string()),
    })
    .unwrap();
    assert_eq!(
        disconnected.get("reason").and_then(|value| value.as_str()),
        Some("保活超时：约 75 秒未收到远端任何回包")
    );

    let completed = serde_json::to_value(TerminalExitPayload {
        id: "terminal-1".to_string(),
        exit_code: 0,
        disconnected: false,
        reason: None,
    })
    .unwrap();
    assert!(completed.get("reason").is_none());
}

#[test]
fn closed_connection_errors_are_stale() {
    // 在已关闭的连接上开通道实际得到的是这两种错误。
    assert!(is_stale_russh_error(&russh::Error::SendError));
    assert!(is_stale_russh_error(&russh::Error::Disconnect));
    assert!(is_stale_russh_error(&russh::Error::HUP));
    assert!(is_stale_russh_error(&russh::Error::KeepaliveTimeout));
    assert!(is_stale_russh_error(&russh::Error::ChannelOpenFailure(
        russh::ChannelOpenFailure::ConnectFailed
    )));
    assert!(!is_stale_russh_error(&russh::Error::ChannelOpenFailure(
        russh::ChannelOpenFailure::AdministrativelyProhibited
    )));
    assert!(!is_stale_russh_error(&russh::Error::WrongChannel));
}

#[test]
fn linux_session_capacity_refusal_retries_without_treating_transport_as_stale() {
    let capacity =
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited);
    assert!(is_session_channel_refusal(&capacity));
    assert!(!is_stale_russh_error(&capacity));
    assert!(is_session_channel_refusal(
        &russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed,)
    ));
    assert!(!is_session_channel_refusal(
        &russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::UnknownChannelType,)
    ));
}

#[test]
fn terminal_end_messages_distinguish_exit_from_disconnect() {
    assert!(is_terminal_end_message(&ChannelMsg::ExitStatus {
        exit_status: 0
    }));
    assert!(is_terminal_end_message(&ChannelMsg::Close));
    assert!(!is_terminal_end_message(&ChannelMsg::Eof));
}

#[test]
fn windows_quote_arg_follows_msvcrt_rules() {
    assert_eq!(windows_quote_arg("status"), "status");
    assert_eq!(windows_quote_arg(""), "\"\"");
    assert_eq!(windows_quote_arg(r"D:\my code"), "\"D:\\my code\"");
    assert_eq!(windows_quote_arg(r"D:\my code\"), "\"D:\\my code\\\\\"");
    assert_eq!(windows_quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
    assert_eq!(windows_quote_arg(r#"a\"b"#), "\"a\\\\\\\"b\"");
    assert_eq!(windows_quote_arg("--format=%H%x00%s"), "--format=%H%x00%s");
}

#[test]
fn windows_powershell_command_is_shell_neutral() {
    let command = windows_powershell_stdin_command();
    assert!(!command.starts_with('"'));
    encoded_part(&command, WINDOWS_POWERSHELL_EXEC);
}

#[test]
fn windows_git_runs_inline_without_reading_stdin() {
    let script = windows_git_script(r"D:\code\app", &["status".to_string()]).unwrap();
    let command = windows_powershell_inline_command(&script).unwrap();
    assert_eq!(decoded_script(&command, WINDOWS_POWERSHELL_EXEC), script);
    assert!(
        !command.starts_with('"'),
        "exec git must stay an unquoted bash -c script"
    );
    assert!(command.len() <= WINDOWS_INLINE_COMMAND_LIMIT);

    let long_message = "x".repeat(WINDOWS_INLINE_COMMAND_LIMIT);
    let long = windows_git_script(
        r"D:\code\app",
        &["commit".to_string(), "-m".to_string(), long_message],
    )
    .unwrap();
    assert!(windows_powershell_inline_command(&long).is_none());
}

#[test]
fn parse_remote_git_status_keeps_branch_and_skips_rename_source() {
    let stdout = "## test...origin/test [ahead 1]\0 M src/a.ts\0?? new.txt\0R  new.rs\0old.rs\0";
    let parsed = parse_remote_git_status(stdout);
    assert_eq!(parsed.branch.as_deref(), Some("test"));
    assert_eq!(parsed.upstream.as_deref(), Some("origin/test"));
    assert_eq!(parsed.ahead, 1);
    assert_eq!(
        parsed.entries,
        vec![
            ("src/a.ts".to_string(), " M".to_string()),
            ("new.txt".to_string(), "??".to_string()),
            ("new.rs".to_string(), "R ".to_string()),
        ]
    );
}

#[test]
fn parse_remote_git_status_drops_editor_artifacts() {
    let stdout = concat!(
        "## main\0",
        " M src/a.ts\0",
        "?? .qingcode/terminal-paste/stamp/paste-1.png\0",
        "?? .qingcode-transfer-abcd.tmp\0",
        "?? .qingcode/run.json\0",
    );
    let parsed = parse_remote_git_status(stdout);
    assert_eq!(
        parsed.entries,
        vec![
            ("src/a.ts".to_string(), " M".to_string()),
            (".qingcode/run.json".to_string(), "??".to_string()),
        ]
    );
}

#[test]
fn subdirectory_project_paths_are_rebased_onto_the_project_root() {
    // 项目是仓库子目录：porcelain 仍返回仓库根相对，按前缀裁掉后才对得上项目内的文件。
    let stdout = "## main\0 M apps/web/src/a.ts\0?? apps/web/new.txt\0";
    let parsed = parse_remote_git_status(stdout);
    let rebased: Vec<_> = parsed
        .entries
        .iter()
        .filter_map(|(path, _)| crate::git_status::strip_git_prefix(path, "apps/web/"))
        .collect();
    assert_eq!(rebased, vec!["src/a.ts".to_string(), "new.txt".to_string()]);
}

#[test]
fn windows_git_script_quotes_arguments_for_powershell_and_git() {
    let script = windows_git_script(
        r"D:\my code\it's",
        &[
            "commit".to_string(),
            "-m".to_string(),
            "fix: \"a\" b".to_string(),
        ],
    )
    .unwrap();
    assert!(script.contains(r#"$psi.Arguments = '-C "D:\my code\it''s" commit -m "fix: \"a\" b"'"#));
    assert!(script.contains("exit $process.ExitCode"));
    assert!(windows_git_script(r"D:\code", &["a\0b".to_string()]).is_err());
}

#[test]
fn direct_terminal_identity_is_exported_only_on_posix_hosts() {
    let command = with_terminal_identity("exec bash -l".to_string(), "it's", "/srv/app");
    assert_eq!(
            command,
            format!(
                "export TERM_PROGRAM='QingCode' TERM_PROGRAM_VERSION='{}' QINGCODE_TERMINAL_ID={}; exec bash -l",
                env!("CARGO_PKG_VERSION"),
                shell_quote("it's"),
            )
        );
    assert_eq!(
        with_terminal_identity("powershell.exe".to_string(), "id", "/D:/code/app"),
        "powershell.exe"
    );
}

#[test]
fn linux_terminal_still_uses_login_shell() {
    let default_target = ssh_interactive_terminal_command("/home/owner/app", None).unwrap();
    assert_eq!(
        default_target.command,
        "cd -- '/home/owner/app' && exec \"${SHELL:-/bin/sh}\" -l"
    );
    assert_eq!(default_target.resolved_shell, "auto");

    let bash_target = ssh_interactive_terminal_command("/home/owner/app", Some("bash")).unwrap();
    assert_eq!(
        bash_target.command,
        "cd -- '/home/owner/app' && exec bash -l"
    );
    assert_eq!(bash_target.resolved_shell, "bash");

    assert!(reject_windows_remote_command("/home/owner/app").is_ok());
}

#[test]
fn collect_scan_nodes_orders_dirs_first_and_applies_excludes() {
    let entries = vec![
        ("zeta.ts".to_string(), false),
        ("src".to_string(), true),
        ("target".to_string(), true),
        ("alpha.md".to_string(), false),
    ];
    let nodes = collect_scan_nodes("ssh://c1", "/srv/app", "/srv/app", entries, None);
    let names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
    // 目录优先（排序），其次文件（排序）；默认硬忽略目录被剔除。
    assert_eq!(names, vec!["src", "alpha.md", "zeta.ts"]);
    assert!(nodes.iter().all(|node| node.path.starts_with("ssh://c1/")));
}

#[test]
fn collect_scan_nodes_honors_exclude_patterns() {
    let entries = vec![
        ("keep.rs".to_string(), false),
        ("skip.rs".to_string(), false),
        ("sub".to_string(), true),
        ("other".to_string(), true),
    ];
    let patterns = vec!["skip.rs".to_string()];
    let nodes = collect_scan_nodes("ssh://c1", "/srv/app", "/srv/app", entries, Some(&patterns));
    // 目录优先（排序），被排除的 skip.rs 不出现。
    let names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
    assert_eq!(names, vec!["other", "sub", "keep.rs"]);
}

#[test]
fn collect_scan_nodes_matches_excludes_against_path_relative_to_root() {
    let entries = vec![("mod.rs".to_string(), false), ("nested".to_string(), true)];
    // 排除规则按「相对项目根」匹配：扫描子目录时 src/nested 仍能被命中。
    let patterns = vec!["src/nested".to_string()];
    let nodes = collect_scan_nodes(
        "ssh://c1",
        "/srv/app/src",
        "/srv/app",
        entries,
        Some(&patterns),
    );
    let names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
    assert_eq!(names, vec!["mod.rs"]);
    assert_eq!(nodes[0].path, "ssh://c1/mod.rs");
}

#[test]
fn relative_to_root_handles_root_and_children() {
    assert_eq!(remote_relative_to_root("/srv/app", "/srv/app"), "");
    assert_eq!(remote_relative_to_root("/srv/app/src", "/srv/app"), "src");
    assert_eq!(remote_relative_to_root("/srv/app/", "/srv/app/"), "");
}
