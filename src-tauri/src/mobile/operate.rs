//! 手机端操作协议：Operation 定义与分发、输入/尺寸/接入/结束，以及图片上传。

use super::*;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(super) enum Operation {
    Pair {
        secret: String,
        #[serde(default)]
        device: Option<String>,
    },
    Ping,
    Capabilities,
    Projects,
    Sessions {
        /// 不传时返回这台电脑上全部项目的手机会话（附项目与创建设备），供手机纵览。
        #[serde(default)]
        project: Option<String>,
        /// 手机支持使用权时传 true，纵览里并入电脑上开的终端。
        #[serde(default)]
        desktop: bool,
    },
    /// 接入终端并取得使用权。`take` 仅在用户主动点击时为 true；重连和恢复界面传 false，不抢。
    Attach {
        id: String,
        #[serde(default)]
        take: bool,
    },
    /// 手机后台提醒：所有项目会话的忙碌、退出和提醒计数，不含任何终端内容。
    Attention,
    /// 电脑端「终端配置」列表（只含 id / 名称 / 是否已信任，不含命令）。
    TerminalProfiles,
    Create {
        project: String,
        cols: u16,
        rows: u16,
        /// 电脑端终端配置 id；旧版手机不传，按普通终端启动。
        #[serde(default)]
        terminal_profile: Option<String>,
    },
    Poll {
        id: String,
        from: u64,
        #[serde(default)]
        latest: bool,
        #[serde(default)]
        tail: bool,
        #[serde(default)]
        lease: Option<u64>,
    },
    History {
        id: String,
        before: u64,
        /// 新版手机端请求带颜色的历史；旧版不传，仍收到纯文本。
        #[serde(default)]
        formatted: bool,
    },
    Input {
        id: String,
        data: String,
        #[serde(default)]
        lease: Option<u64>,
    },
    Image {
        id: String,
        data: String,
        #[serde(default)]
        lease: Option<u64>,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        lease: Option<u64>,
    },
    End {
        id: String,
    },
    RenameSession {
        id: String,
        name: String,
    },
}

pub(super) async fn operate(
    app: &AppHandle,
    device: &str,
    operation: Operation,
) -> Result<Value, String> {
    let hub = &app.state::<MobileState>().inner().hub;
    match operation {
        Operation::Pair { .. } => unreachable!(),
        // Authentication is checked by request_handler before any operation runs.
        // Never wait for terminal output or the desktop WebView bridge here.
        Operation::Ping => Ok(json!({ "pong": true })),
        Operation::Capabilities => Ok(json!({
            "protocolVersion": 1,
            "features": ["terminal_profiles", "session_names", "images", "latest_screen", "history", "attention", "all_sessions", "handoff"],
            "sessionScope": "shared",
        })),
        Operation::Projects => desktop(app, None).await,
        Operation::Sessions {
            project: None,
            desktop,
        } => {
            schedule_restore_scan(app, device);
            let mut list = hub.session_summaries(Some(device));
            if desktop && hub.desktop_terminals_enabled() {
                // 电脑窗口暂时无响应时只少了电脑终端，手机会话列表照常返回。
                if let Ok(Value::Array(items)) =
                    desktop_query(app, json!({ "desktopTerminals": true })).await
                {
                    list.extend(hub.annotate_desktop_terminals(items, device));
                }
            }
            Ok(json!(list))
        }
        Operation::Attach { id, take } => attach(app, device, id, take).await,
        Operation::Sessions {
            project: Some(project),
            ..
        } => {
            schedule_restore_scan(app, device);
            let inner = hub.inner.lock().unwrap();
            let mut sessions: Vec<_> = inner
                .sessions
                .iter()
                .filter(|(_, session)| session.ready && session.project.id == project)
                .collect();
            sessions.sort_by_key(|(_, session)| session.number);
            Ok(json!(sessions
                .into_iter()
                .map(|(id, session)| session.metadata(id))
                .collect::<Vec<_>>()))
        }
        Operation::Attention => {
            let inner = hub.inner.lock().unwrap();
            let mut sessions: Vec<_> = inner
                .sessions
                .iter()
                .filter(|(_, session)| session.ready)
                .collect();
            sessions.sort_by_key(|(_, session)| session.number);
            Ok(json!(sessions
                .into_iter()
                .map(|(id, session)| session.attention(id))
                .collect::<Vec<_>>()))
        }
        Operation::TerminalProfiles => desktop_query(app, json!({ "profiles": true })).await,
        Operation::Create {
            project,
            cols,
            rows,
            terminal_profile,
        } => {
            create(
                app,
                device,
                &project,
                terminal_profile.as_deref(),
                cols,
                rows,
            )
            .await
        }
        Operation::History {
            id,
            before,
            formatted,
        } => {
            let inner = hub.inner.lock().unwrap();
            let session = inner.live(&id).ok_or("终端不存在。")?;
            Ok(session.screen.history_page(before, formatted))
        }
        Operation::Poll {
            id,
            from,
            latest,
            tail,
            lease,
        } => {
            let wait = {
                let inner = hub.inner.lock().unwrap();
                if let Some(reply) = inner.takeover_reply(&id, lease) {
                    return Ok(reply);
                }
                let session = inner.live(&id).ok_or("终端不存在。")?;
                if latest || (tail && session.should_send_latest(from)) {
                    return Ok(session.latest());
                }
                if from != session.next
                    || session
                        .drain_until
                        .is_some_and(|until| Instant::now() >= until)
                {
                    return Ok(session.read(from));
                }
                session.changed.clone().notified_owned()
            };
            if tokio::time::timeout(Duration::from_millis(900), wait)
                .await
                .is_ok()
            {
                tokio::time::sleep(OUTPUT_COALESCE).await;
            }
            let inner = hub.inner.lock().unwrap();
            if let Some(reply) = inner.takeover_reply(&id, lease) {
                return Ok(reply);
            }
            let session = inner.live(&id).ok_or("终端不存在。")?;
            Ok(if tail && session.should_send_latest(from) {
                session.latest()
            } else {
                session.read(from)
            })
        }
        Operation::Input { id, data, lease } => {
            if data.len() > MAX_INPUT {
                return Err("单次终端输入超过 16 KiB。".into());
            }
            hub.authorize(&id, lease)?;
            hub.with_session(&id, |session| session.note_user_input(&data));
            let kind = hub.session_kind(&id)?;
            write_input(app, kind, id, data).await?;
            Ok(Value::Null)
        }
        Operation::Image { id, data, lease } => {
            hub.authorize(&id, lease)?;
            let project = {
                let inner = hub.inner.lock().unwrap();
                image_project(&inner, &id, device)?
            };
            // Re-read saved trust and connection state before materializing an attachment.
            let current: Project = serde_json::from_value(desktop(app, Some(&project.id)).await?)
                .map_err(|error| error.to_string())?;
            if current.path != project.path || current.kind != project.kind {
                return Err("项目位置已变化，请重新打开终端后发送图片。".into());
            }
            // A desktop prompt may have outlived revocation or session closure.
            {
                let inner = hub.inner.lock().unwrap();
                image_project(&inner, &id, device)?;
            }
            let bytes = decode_image(&data)?;
            let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "png"
            } else {
                "jpg"
            };
            let storage_project = project.clone();
            let storage_app = app.clone();
            let path = tauri::async_runtime::spawn_blocking(move || {
                let name = format!("mobile-image.{extension}");
                if storage_project.kind == ProjectKind::Ssh {
                    // Only the SSH transfer needs a temporary local source.
                    crate::clipboard_files::store_attachment(&name, &bytes)
                } else {
                    crate::clipboard_files::store_project_attachment(
                        &crate::run_environment::to_host_path(&storage_project.path),
                        &name,
                        &bytes,
                        &storage_app.state::<crate::PathAllowlist>(),
                    )
                }
            })
            .await
            .map_err(|error| error.to_string())??;
            let result = if project.kind == ProjectKind::Ssh {
                desktop_request(app, Some(&project.id), Some(&path)).await
            } else {
                local_image_path(&project, &path).map(|path| json!({ "path": path }))
            };
            // SSH has its own uploaded copy. Failed local/WSL preparations do not retain a file.
            if project.kind == ProjectKind::Ssh || result.is_err() {
                let _ = std::fs::remove_file(&path);
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    let _ = std::fs::remove_dir(parent);
                }
            }
            result
        }
        Operation::Resize {
            id,
            cols,
            rows,
            lease,
        } => {
            hub.authorize(&id, lease)?;
            hub.with_session(&id, Session::note_resize);
            let kind = hub.session_kind(&id)?;
            apply_resize(app, kind, &id, cols, rows).await?;
            // 电脑只读画面跟随使用者的行列，内容不错位。
            emit_control(app, &id);
            Ok(Value::Null)
        }
        Operation::RenameSession { id, name } => hub.rename_session(&id, &name),
        Operation::End { id } => {
            if hub.is_phone_session(&id) {
                end_session(app, id).await?;
            } else {
                // 电脑上的终端交给电脑端关闭，标签、提示和记录走桌面原有流程。
                if !hub.desktop_terminals_enabled() {
                    return Err("电脑端未开启手机接入电脑终端。".into());
                }
                desktop_query(app, json!({ "endTerminal": id })).await?;
            }
            Ok(Value::Null)
        }
    }
}

/// 本机宿主托管的电脑终端属于本地项目，但和 SSH 持久终端登记在同一张表。
pub(super) fn routes_through_ssh_table(app: &AppHandle, kind: ProjectKind, id: &str) -> bool {
    kind == ProjectKind::Ssh
        || app
            .state::<crate::remote_ssh::SshManager>()
            .local_hosted_pty_id(id)
            .is_some()
}

pub(super) async fn write_input(
    app: &AppHandle,
    kind: ProjectKind,
    id: String,
    data: String,
) -> Result<(), String> {
    if routes_through_ssh_table(app, kind, &id) {
        crate::remote_ssh::ssh_write_terminal_unchecked(id, data, app.state()).await
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<crate::TerminalManager>().write(&id, &data)
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

pub(super) async fn apply_resize(
    app: &AppHandle,
    kind: ProjectKind,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (cols, rows) = size(cols, rows);
    if routes_through_ssh_table(app, kind, id) {
        crate::remote_ssh::ssh_resize_terminal_unchecked(id.to_owned(), cols, rows, app.state())
            .await?;
    } else {
        app.state::<crate::TerminalManager>()
            .resize(id, cols, rows)?;
    }
    app.state::<MobileState>()
        .hub
        .with_session(id, |session| session.screen.resize(cols, rows));
    Ok(())
}

/// 手机接入终端。电脑终端首次接入时由电脑端抓取当前画面并开始转发。
pub(super) async fn attach(
    app: &AppHandle,
    device: &str,
    id: String,
    take: bool,
) -> Result<Value, String> {
    let hub = &app.state::<MobileState>().inner().hub;
    if !hub.is_phone_session(&id) && !hub.mirror_active(&id) {
        if !hub.desktop_terminals_enabled() {
            return Err("电脑端未开启手机接入电脑终端。".into());
        }
        if !take {
            return Ok(json!({ "takenOver": true, "by": DESKTOP_NAME }));
        }
        desktop_query(app, json!({ "mirrorStart": id, "device": device })).await?;
    }
    let reply = hub.claim(&id, device, take)?;
    emit_control(app, &id);
    Ok(reply)
}

/// 结束手机会话；已退出的会话直接移除。手机端与电脑端「终端管理」共用。
pub(super) async fn end_session(app: &AppHandle, id: String) -> Result<(), String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let kind = {
        let mut inner = hub.inner.lock().unwrap();
        let session = inner.sessions.get_mut(&id).ok_or("终端不存在。")?;
        if !session.ready {
            return Err("终端正在启动或关闭。".into());
        }
        if session.exit.is_some() {
            inner.sessions.remove(&id);
            drop(inner);
            emit_view_exit(app, &id, 0, false);
            return Ok(());
        }
        session.ready = false;
        session.project.kind
    };
    let result = end(app, id.clone(), kind).await;
    {
        let mut inner = hub.inner.lock().unwrap();
        if result.is_ok() {
            inner.sessions.remove(&id);
        } else if let Some(session) = inner.sessions.get_mut(&id) {
            session.ready = true;
        }
    }
    if result.is_ok() {
        emit_view_exit(app, &id, 0, false);
    }
    result
}

pub(super) fn require_device(inner: &HubState, device: &str) -> Result<(), String> {
    if !inner.accepting || !inner.devices.iter().any(|entry| entry.saved.id == device) {
        return Err("移动连接已停止或设备已移除。".into());
    }
    Ok(())
}

pub(super) fn image_project(inner: &HubState, id: &str, device: &str) -> Result<Project, String> {
    require_device(inner, device)?;
    let session = inner.live(id).ok_or("终端不存在。")?;
    // Paired devices share phone sessions. owner only selects lifecycle cleanup.
    if !session.ready || session.exit.is_some() {
        return Err("当前设备没有可用的终端会话。".into());
    }
    Ok(session.project.clone())
}

pub(super) fn decode_image(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if data.len() > MAX_IMAGE.div_ceil(3) * 4 {
        return Err("图片不能超过 8 MB。".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "图片编码无效。")?;
    if bytes.len() > MAX_IMAGE {
        return Err("图片不能超过 8 MB。".into());
    }
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") && !bytes.starts_with(b"\xff\xd8\xff") {
        return Err("仅支持 PNG / JPEG 图片；其他格式请选择压缩后发送。".into());
    }
    Ok(bytes)
}

pub(super) fn local_image_path(project: &Project, path: &str) -> Result<String, String> {
    if project.kind == ProjectKind::Wsl {
        let wsl =
            crate::run_environment::parse_wsl_path(&project.path).ok_or("无法识别 WSL 发行版。")?;
        let root = crate::run_environment::to_host_path(&project.path);
        let relative = std::path::Path::new(path)
            .strip_prefix(&root)
            .map_err(|_| "附件不在当前 WSL 项目内。")?;
        if relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("附件不在当前 WSL 项目内。".into());
        }
        let path = format!(
            "{}/{}",
            wsl.path.trim_end_matches('/'),
            relative.to_string_lossy().replace('\\', "/")
        );
        return Ok(format!("'{}'", path.replace('\'', "'\\''")));
    }
    #[cfg(windows)]
    return Ok(format!("'{}'", path.replace('\'', "''")));
    #[cfg(not(windows))]
    Ok(format!("'{}'", path.replace('\'', "'\\''")))
}

pub(super) fn size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(2, 300), rows.clamp(2, 150))
}
