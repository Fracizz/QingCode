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
    Projects {
        /// 新版手机传 true：同时列出未信任项目（带 `trusted: false`），与电脑端项目数一致；
        /// 旧版不传，仍只拿到已信任项目。未信任项目的终端、文件等操作照旧被电脑端拒绝。
        #[serde(default)]
        all: bool,
    },
    FileList {
        project: String,
        #[serde(default)]
        path: String,
        #[serde(default)]
        hidden: bool,
    },
    FileSearch {
        project: String,
        #[serde(default)]
        path: String,
        query: String,
        #[serde(default)]
        hidden: bool,
    },
    FileStat {
        project: String,
        path: String,
    },
    FileChunk {
        project: String,
        path: String,
        version: String,
        offset: u64,
        length: u64,
    },
    Sessions {
        /// 不传时返回这台电脑上全部项目的手机会话（附项目与创建设备），供手机纵览。
        #[serde(default)]
        project: Option<String>,
        /// 手机支持使用权时传 true，纵览里并入电脑上开的终端。
        #[serde(default)]
        desktop: bool,
    },
    /// 接入终端并登记在线。所有设备默认可输入；`take` 仅在用户主动点击「接管」时为 true，
    /// 抢下其他方的独占。`observe` 选择只读旁观（true）或可输入（false），不传沿用之前的选择。
    Attach {
        id: String,
        #[serde(default)]
        take: bool,
        #[serde(default)]
        shared: bool,
        #[serde(default)]
        observe: Option<bool>,
        /// 被「断开其他端」后能否恢复接入：用户主动打开终端时为 true；网络出错后的自动重连
        /// 传 false，得到断开答复而不是悄悄接回。旧版手机不传，沿用接入即恢复。
        #[serde(default)]
        rejoin: Option<bool>,
        /// 本机终端网格（`attach_size`）：随接入一起记下，这台设备是尺寸方时当场改尺寸并等重绘，
        /// 手机不必先取旧尺寸画面再改。旧版手机不传。
        #[serde(default)]
        cols: Option<u16>,
        #[serde(default)]
        rows: Option<u16>,
    },
    /// 打开或解除独占；`force` 抢下其他方的独占。
    Exclusive {
        id: String,
        on: bool,
        #[serde(default)]
        force: bool,
    },
    /// 锁定或解锁尺寸：锁定后打字不再切换尺寸方。
    LockSize {
        id: String,
        locked: bool,
    },
    /// 按这台设备的尺寸显示（直接成为尺寸方）。
    TakeSize {
        id: String,
    },
    /// 手机后台提醒：所有项目会话的忙碌、退出和提醒计数，不含任何终端内容。
    Attention,
    /// 电脑端「终端配置」列表（只含 id / 名称 / 是否已信任，不含命令）。
    TerminalProfiles,
    /// 电脑端终端快捷键栏的自定义键（名称 / 文本 / 是否回车），供手机导入；只读。
    ShortcutKeys,
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
        shared: bool,
        // 旧版手机还会带 `lease`；共享模式下不再用它判断能否输入，未知字段直接忽略。
    },
    /// 输出推送：参数同 `Poll`，响应是一条不断开的 HTTP 流，每行一个 JSON（与 `Poll` 回复相同）。
    /// 手机不必每收到一屏就再发一次请求，画面更新频率不再受网络往返限制。
    PollStream {
        id: String,
        from: u64,
        #[serde(default)]
        latest: bool,
        #[serde(default)]
        tail: bool,
        #[serde(default)]
        shared: bool,
    },
    History {
        id: String,
        before: u64,
        /// 新版手机端请求带颜色的历史；旧版不传，仍收到纯文本。
        #[serde(default)]
        formatted: bool,
    },
    // 旧版手机还会带 `lease`；共享模式下所有设备都能输入，未知字段直接忽略。
    Input {
        id: String,
        data: String,
    },
    Image {
        id: String,
        data: String,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
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
            "features": ["project_files", "terminal_profiles", "shortcut_keys", "session_names", "images", "latest_screen", "history", "attention", "all_sessions", "handoff", "shared_view", "multi_writer", "exclusive", "lock_size", "presence", "output_stream", "attach_size"],
            "sessionScope": "shared",
        })),
        Operation::Projects { all } => {
            desktop_query(app, json!({ "project": null, "allProjects": all })).await
        }
        Operation::FileList {
            project,
            path,
            hidden,
        } => files::operate(app, &project, files::FileRequest::list(path, hidden)).await,
        Operation::FileSearch {
            project,
            path,
            query,
            hidden,
        } => {
            files::operate(
                app,
                &project,
                files::FileRequest::search(path, query, hidden),
            )
            .await
        }
        Operation::FileStat { project, path } => {
            files::operate(app, &project, files::FileRequest::stat(path)).await
        }
        Operation::FileChunk {
            project,
            path,
            version,
            offset,
            length,
        } => {
            files::operate(
                app,
                &project,
                files::FileRequest::chunk(path, version, offset, length),
            )
            .await
        }
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
        Operation::Attach {
            id,
            take,
            shared,
            observe,
            rejoin,
            cols,
            rows,
        } => {
            let claim = AttachClaim {
                take,
                shared,
                observe,
                rejoin,
                size: cols.zip(rows),
            };
            attach(app, device, id, claim).await
        }
        Operation::Exclusive { id, on, force } => {
            let _control = app.state::<MobileState>().lock_control(&id).await;
            let resize = hub.set_exclusive(&id, Controller::Device(device.into()), on, force)?;
            finish_device_claim(app, &id, device, resize).await?;
            Ok(Value::Null)
        }
        Operation::LockSize { id, locked } => {
            hub.set_size_lock(&id, &Controller::Device(device.into()), locked)?;
            emit_control_if_changed(app, &id);
            Ok(Value::Null)
        }
        Operation::TakeSize { id } => {
            let _control = app.state::<MobileState>().lock_control(&id).await;
            if let Some((cols, rows)) = hub.take_size(&id, Controller::Device(device.into()))? {
                let kind = hub.session_kind(&id)?;
                apply_resize(app, kind, &id, cols, rows).await?;
            }
            emit_control(app, &id);
            Ok(Value::Null)
        }
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
        Operation::ShortcutKeys => desktop_query(app, json!({ "shortcutKeys": true })).await,
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
            shared,
        } => poll_reply(app, device, &id, from, latest, tail, shared).await,
        // 推送流由 request_handler 直接接管成流式响应，不会走到这里。
        Operation::PollStream { .. } => Err("输出推送须使用流式请求。".into()),
        Operation::Input { id, data } => {
            if data.len() > MAX_INPUT {
                return Err("单次终端输入超过 16 KiB。".into());
            }
            // 同一终端的输入与改尺寸串行：一条输入整体写完才处理下一条。
            let _control = app.state::<MobileState>().lock_control(&id).await;
            let InputDecision::Forward { resize } = hub.device_input(&id, device, &data)? else {
                return Ok(Value::Null);
            };
            let kind = hub.session_kind(&id)?;
            if let Some((cols, rows)) = resize {
                apply_resize(app, kind, &id, cols, rows).await?;
            }
            write_input(app, kind, id.clone(), data).await?;
            emit_control_if_changed(app, &id);
            Ok(Value::Null)
        }
        Operation::Image { id, data } => {
            hub.authorize_image(&id, device)?;
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
        Operation::Resize { id, cols, rows } => {
            let _control = app.state::<MobileState>().lock_control(&id).await;
            // 只有尺寸方的请求会改终端；其他设备的尺寸先记下，打字成为尺寸方时再用。
            if let Some((cols, rows)) = hub.device_resize(&id, device, cols, rows)? {
                hub.with_session(&id, Session::note_resize);
                let kind = hub.session_kind(&id)?;
                apply_resize(app, kind, &id, cols, rows).await?;
                // 电脑画面跟随尺寸方的行列，内容不错位。
                emit_control(app, &id);
            }
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

/// 手机接入请求的参数，`size` 是手机报上的本机网格。
pub(super) struct AttachClaim {
    pub(super) take: bool,
    pub(super) shared: bool,
    pub(super) observe: Option<bool>,
    pub(super) rejoin: Option<bool>,
    pub(super) size: Option<(u16, u16)>,
}

/// 手机接入终端。电脑终端首次接入时由电脑端检查能否共享；镜像画面不完整时顺带要一份当前画面。
/// 带了本机网格且这台设备是尺寸方时当场改尺寸，并等程序重绘告一段落再答复。
pub(super) async fn attach(
    app: &AppHandle,
    device: &str,
    id: String,
    request: AttachClaim,
) -> Result<Value, String> {
    let AttachClaim {
        take,
        shared,
        observe,
        rejoin,
        size,
    } = request;
    let hub = &app.state::<MobileState>().inner().hub;
    if !hub.is_phone_session(&id) && !hub.mirror_approved(&id) {
        if !hub.desktop_terminals_enabled() {
            return Err("电脑端未开启手机接入电脑终端。".into());
        }
        if !take && !shared {
            return Ok(json!({ "takenOver": true, "by": DESKTOP_NAME }));
        }
        // 串行化：并发接入的手机共用同一次检查和同一份初始画面。
        let state = app.state::<MobileState>();
        let _starting = state.mirror_start.lock().await;
        if !hub.mirror_approved(&id) {
            let seed = !hub.mirror_complete(&id);
            desktop_query(
                app,
                json!({ "mirrorStart": id, "device": device, "seed": seed }),
            )
            .await?;
        }
    }
    let control = app.state::<MobileState>().lock_control(&id).await;
    // 先记下本机网格：已是尺寸方时直接得到要改的尺寸，接管时 `take_exclusive` 也用这份新尺寸。
    let fresh = size.and_then(|(cols, rows)| hub.attach_size(&id, device, cols, rows));
    let claim = hub.claim_rejoin(&id, device, take, observe, rejoin)?;
    let resize = claim.resize.or(fresh);
    let redraw = resize.is_some_and(|grid| hub.screen_size(&id).is_some_and(|now| now != grid));
    if redraw {
        hub.with_session(&id, Session::note_resize);
    }
    finish_device_claim(app, &id, device, resize).await?;
    drop(control);
    if redraw {
        settle_redraw(hub, &id).await;
    }
    Ok(claim.reply)
}

/// 等接入改尺寸引发的重绘告一段落：手机随后取的最新画面已是新尺寸，
/// 省去旧流程「取旧尺寸画面 → 改尺寸 → 轮询到安静」的两次往返和约 900ms 的空等。
async fn settle_redraw(hub: &Hub, id: &str) {
    let started = Instant::now();
    let mut seen = None;
    let mut quiet = ATTACH_REDRAW_FIRST;
    loop {
        // 在锁内取游标并登记等待：之后的输出必定唤醒这次等待，不会漏掉。
        let (next, changed) = {
            let inner = hub.inner.lock().unwrap();
            let Some(session) = inner.live(id).filter(|session| session.exit.is_none()) else {
                return;
            };
            (session.next, session.changed.clone().notified_owned())
        };
        if seen.is_some_and(|seen| seen != next) {
            quiet = ATTACH_REDRAW_GAP;
        }
        seen = Some(next);
        let left = ATTACH_REDRAW_MAX.saturating_sub(started.elapsed());
        if left.is_zero()
            || tokio::time::timeout(quiet.min(left), changed)
                .await
                .is_err()
        {
            return;
        }
    }
}

/// 调用方持有终端控制锁。即使 PTY 改尺寸失败也发布已变更的控制权，
/// 并让手机重报相同行列时可以重试。
async fn finish_device_claim(
    app: &AppHandle,
    id: &str,
    device: &str,
    resize: Option<(u16, u16)>,
) -> Result<(), String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let result = if let Some((cols, rows)) = resize {
        match hub.session_kind(id) {
            Ok(kind) => apply_resize(app, kind, id, cols, rows).await,
            Err(error) => Err(error),
        }
    } else {
        Ok(())
    };
    if result.is_err() {
        hub.with_session(id, |session| {
            session
                .sharing
                .sizes
                .remove(&Controller::Device(device.into()));
        });
    }
    emit_control(app, id);
    result
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

/// 一次输出轮询：有新输出（或需改发最新画面）时立即返回，否则最多等 900ms 后返回空结果。
/// 推送流（`poll_stream`）逐帧复用这里，保证两条路径的回复格式与在线登记一致。
pub(super) async fn poll_reply(
    app: &AppHandle,
    device: &str,
    id: &str,
    from: u64,
    latest: bool,
    tail: bool,
    shared: bool,
) -> Result<Value, String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let read = |inner: &HubState, after_wait: bool| -> Result<Option<Value>, String> {
        require_device(inner, device)?;
        let session = inner.live(id).ok_or("终端不存在。")?;
        if let Some(reply) = inner.kicked_reply(id, device) {
            return Ok(Some(reply));
        }
        if !shared {
            if let Some(reply) = inner.takeover_reply(id, device) {
                return Ok(Some(reply));
            }
        }
        let mut reply = if latest || (tail && session.should_send_latest(from)) {
            session.latest()
        } else if after_wait
            || from != session.next
            || session
                .drain_until
                .is_some_and(|until| Instant::now() >= until)
        {
            session.read(from)
        } else {
            return Ok(None);
        };
        if shared {
            reply["control"] = inner.view_control(session, device);
        }
        Ok(Some(reply))
    };
    // 轮询即在线：登记后若在线名单有变化，通知电脑端。
    {
        let mut inner = hub.inner.lock().unwrap();
        if require_device(&inner, device).is_ok() {
            if let Some(session) = inner
                .live_mut(id)
                .filter(|session| !session.sharing.is_kicked(device))
            {
                session.sharing.see_device(device, None, Instant::now());
            }
        }
    }
    emit_control_if_changed(app, id);
    let wait = {
        let inner = hub.inner.lock().unwrap();
        if let Some(reply) = read(&inner, false)? {
            return Ok(reply);
        }
        inner.live(id).unwrap().changed.clone().notified_owned()
    };
    if tokio::time::timeout(Duration::from_millis(900), wait)
        .await
        .is_ok()
    {
        // 按唤醒时的输入状态选窗口，滚轮常在这次长轮询挂起之后才到。
        let delay = hub
            .inner
            .lock()
            .unwrap()
            .live(id)
            .map_or(OUTPUT_COALESCE, |session| {
                session.output_coalesce_delay(Instant::now())
            });
        tokio::time::sleep(delay).await;
    }
    read(&hub.inner.lock().unwrap(), true)?.ok_or_else(|| "终端不存在。".into())
}
