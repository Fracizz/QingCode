//! mobile_* Tauri 命令：启停、设备与配对、会话列表、桌面镜像与查看窗口。

use super::*;

pub(super) fn status(state: &MobileState) -> Status {
    let port = state
        .running
        .lock()
        .unwrap()
        .as_ref()
        .map(|running| running.port);
    let error = state.last_error.lock().unwrap().clone();
    let now = Instant::now();
    let (saved_port, configured, enabled, fingerprint, desktop_terminals, mut devices) = {
        let inner = state.hub.inner.lock().unwrap();
        let devices: Vec<DeviceStatus> = inner
            .devices
            .iter()
            .map(|entry| DeviceStatus {
                id: entry.saved.id.clone(),
                name: entry.saved.name.clone(),
                paired_at: entry.saved.paired_at,
                online: port.is_some()
                    && entry
                        .last_seen
                        .is_some_and(|seen| now.duration_since(seen) < ONLINE_WINDOW),
            })
            .collect();
        (
            inner.saved_port.unwrap_or(DEFAULT_PORT),
            inner.configured,
            inner.enabled,
            inner.fingerprint.clone(),
            inner.desktop_terminals,
            devices,
        )
    };
    devices.sort_by_key(|device| std::cmp::Reverse(device.paired_at));
    let addresses = if port.is_some() {
        lan_addresses().iter().map(ToString::to_string).collect()
    } else {
        Vec::new()
    };
    Status {
        port,
        saved_port,
        configured,
        enabled,
        fingerprint,
        devices,
        addresses,
        computer: computer_name(),
        error,
        desktop_terminals,
    }
}

/// Loads persisted pairings and restarts the listener if it was enabled.
pub fn initialize(app: &AppHandle) {
    let sweeper = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_SWEEP_INTERVAL).await;
            sweep_idle_terminals(&sweeper).await;
        }
    });
    let presence = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PRESENCE_SWEEP_INTERVAL).await;
            sweep_presence(&presence).await;
        }
    });
    let state = app.state::<MobileState>();
    let saved_names = load_session_names();
    state
        .hub
        .load_session_names(saved_names.clone(), unix_now_ms());
    tauri::async_runtime::spawn(persist_session_names(app.clone(), saved_names));
    let settings = match load_settings() {
        Ok(Some(settings)) => settings,
        Ok(None) => return,
        Err(error) => {
            *state.last_error.lock().unwrap() = Some(error);
            return;
        }
    };
    state.hub.load(&settings);
    if !settings.enabled {
        return;
    }
    let port = settings.endpoint.port();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<MobileState>();
        let _lifecycle = state.lifecycle.lock().await;
        if state.running.lock().unwrap().is_some() {
            return;
        }
        if let Err(error) = start_locked(&app, port, None).await {
            eprintln!("[WARN] mobile connection did not start: {error}");
            *state.last_error.lock().unwrap() = Some(format!("自动启用失败：{error}"));
        }
    });
}

#[derive(Serialize)]
pub struct SettingsSummary {
    pub(super) port: u16,
    pub(super) configured: bool,
    pub(super) password: Option<String>,
}

/// Saved port and remembered password for the settings form; read once when it opens.
#[tauri::command]
pub fn mobile_saved_settings() -> Result<SettingsSummary, String> {
    let saved = load_settings()?;
    Ok(SettingsSummary {
        port: saved
            .as_ref()
            .map_or(DEFAULT_PORT, |settings| settings.endpoint.port()),
        configured: saved.is_some(),
        password: saved.and_then(|settings| settings.password),
    })
}

#[tauri::command]
pub fn mobile_status(state: State<'_, MobileState>) -> Status {
    status(&state)
}

#[tauri::command]
pub async fn mobile_start(
    port: u16,
    code: Option<String>,
    app: AppHandle,
) -> Result<Status, String> {
    let state = app.state::<MobileState>();
    let _lifecycle = state.lifecycle.lock().await;
    start_locked(&app, port, code).await?;
    Ok(status(&state))
}

/// Stops listening and ends phone terminals. `disable` keeps it off on next launch;
/// closing the app passes `false` so the listener returns with the desktop.
#[tauri::command]
pub async fn mobile_stop(disable: Option<bool>, app: AppHandle) -> Result<Status, String> {
    let state = app.state::<MobileState>();
    let _lifecycle = state.lifecycle.lock().await;
    let disable = disable.unwrap_or(true);
    if disable {
        update_settings(|settings| settings.enabled = false)?;
        state.hub.inner.lock().unwrap().enabled = false;
    }
    let running = state.running.lock().unwrap().take();
    state.hub.inner.lock().unwrap().accepting = false;
    if let Some(running) = running {
        running.shutdown().await;
    }
    for (id, kind) in state.hub.take_live_sessions() {
        let _ = end(&app, id.clone(), kind).await;
        emit_view_exit(&app, &id, 0, false);
    }
    // 电脑上开的终端继续运行；设备都已断开，清掉它们的在线记录与独占，电脑恢复可操作。
    for id in state.hub.release_all_devices() {
        emit_control(&app, &id);
    }
    Ok(status(&state))
}

#[tauri::command]
pub async fn mobile_revoke_device(id: String, app: AppHandle) -> Result<Status, String> {
    let state = app.state::<MobileState>();
    let _lifecycle = state.lifecycle.lock().await;
    update_settings(|settings| settings.devices.retain(|device| device.id != id))?;
    for (session, kind) in state.hub.forget_device(&id) {
        let _ = end(&app, session.clone(), kind).await;
        emit_view_exit(&app, &session, 0, false);
    }
    for terminal in state.hub.release_mirrors(Some(&id)) {
        emit_control(&app, &terminal);
    }
    Ok(status(&state))
}

#[tauri::command]
pub fn mobile_pairing_qr(text: String) -> Result<QrMatrix, String> {
    if text.len() > 512 || !text.starts_with("qingcode://pair?") {
        return Err("配对链接无效。".into());
    }
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M)
        .map_err(|error| error.to_string())?;
    let modules = code
        .to_colors()
        .into_iter()
        .map(|color| {
            if color == qrcode::Color::Dark {
                '1'
            } else {
                '0'
            }
        })
        .collect();
    Ok(QrMatrix {
        size: code.width(),
        modules,
    })
}

#[tauri::command]
pub fn mobile_bridge_reply(
    window: WebviewWindow,
    state: State<'_, MobileState>,
    id: Uuid,
    data: Option<Value>,
    error: Option<String>,
) {
    if window.label() == "main" {
        if let Some(sender) = state.pending.lock().unwrap().remove(&id) {
            let _ = sender.send(error.map_or_else(|| Ok(data.unwrap_or(Value::Null)), Err));
        }
    }
}

/// 电脑端的普通终端入口一律拒绝 `mobile-*` id。手机终端要在电脑上看或操作时，
/// 走「终端管理」和带使用权校验的 `mobile_view_*` 命令。
pub(crate) fn reject_desktop_use(id: &str) -> Result<(), String> {
    if is_mobile_terminal(id) {
        Err("手机终端请从「终端管理」打开后接管；普通终端入口不能操作。".into())
    } else {
        Ok(())
    }
}

/// 电脑端「终端管理」列出全部手机会话（跨项目），只含元数据，不含输出。
#[tauri::command]
pub fn mobile_sessions(state: State<'_, MobileState>) -> Vec<Value> {
    state.hub.session_summaries(None)
}

/// 电脑端只读预览：最近历史与当前画面的纯文本，不改尺寸、不输入。
#[tauri::command]
pub fn mobile_session_preview(id: String, state: State<'_, MobileState>) -> Result<Value, String> {
    state.hub.session_preview(&id)
}

/// 按预览返回的游标分页读取更早的普通屏历史，含仍保留输出的已结束会话。
#[tauri::command]
pub fn mobile_session_history(
    id: String,
    before: u64,
    state: State<'_, MobileState>,
) -> Result<Value, String> {
    state.hub.session_history(&id, before)
}

#[tauri::command]
pub fn mobile_rename_session(
    id: String,
    name: String,
    state: State<'_, MobileState>,
) -> Result<Value, String> {
    state.hub.rename_session(&id, &name)
}

#[tauri::command]
pub async fn mobile_end_session(id: String, app: AppHandle) -> Result<(), String> {
    if !is_mobile_terminal(&id) {
        return Err("终端不存在。".into());
    }
    end_session(&app, id).await
}

/// 电脑端写入前的共享检查。返回 `Drop` 表示这是非尺寸方的自动应答，静默丢弃；
/// `Forward { resize }` 带尺寸时，调用方先把终端改成这个尺寸（电脑刚成为尺寸方）再写入。
pub(crate) fn desktop_input(
    app: &AppHandle,
    state: &MobileState,
    id: &str,
    data: &str,
) -> Result<DesktopWrite, String> {
    let decision = state.hub.desktop_input(id, data)?;
    Ok(match decision {
        InputDecision::Drop => DesktopWrite::Drop,
        InputDecision::Forward { resize } => {
            if let Some((cols, rows)) = resize {
                state.hub.with_session(id, |session| {
                    session.screen.resize(cols, rows);
                    session.note_resize();
                });
            }
            emit_control_if_changed(app, id);
            DesktopWrite::Forward { resize }
        }
    })
}

/// 电脑端写入的处理方式，见 [`desktop_input`]。
pub(crate) enum DesktopWrite {
    Forward { resize: Option<(u16, u16)> },
    Drop,
}

/// 电脑窗口请求的尺寸。电脑是尺寸方时返回 true，调用方真正改终端尺寸；
/// 其他设备是尺寸方时只记下电脑的尺寸，电脑下次打字成为尺寸方时再用。
pub(crate) fn desktop_resize(state: &MobileState, id: &str, cols: u16, rows: u16) -> bool {
    state.hub.desktop_resize(id, cols, rows)
}

pub(crate) fn desktop_resized(state: &MobileState, id: &str, cols: u16, rows: u16) {
    state.hub.with_session(id, |session| {
        if session.sharing.size_owner == Controller::Desktop {
            session.screen.resize(cols, rows);
            session.changed.notify_waiters();
        }
    });
}

#[tauri::command]
pub fn mobile_set_desktop_terminals(enabled: bool, app: AppHandle) -> Result<Status, String> {
    update_settings(|settings| settings.desktop_terminals = enabled)?;
    let state = app.state::<MobileState>();
    state.hub.inner.lock().unwrap().desktop_terminals = enabled;
    if !enabled {
        for id in state.hub.release_mirrors(None) {
            emit_control(&app, &id);
        }
    }
    Ok(status(&state))
}

/// 电脑端打开或解除独占。`force` 抢下设备的独占（「接管」）。
#[tauri::command]
pub async fn mobile_terminal_exclusive(
    id: String,
    on: bool,
    force: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    let state = app.state::<MobileState>();
    let _control = state.lock_control(&id).await;
    if let Some((cols, rows)) =
        state
            .hub
            .set_exclusive(&id, Controller::Desktop, on, force.unwrap_or(false))?
    {
        let kind = if is_mobile_terminal(&id) {
            state.hub.desktop_session_kind(&id)?
        } else {
            state.hub.session_kind(&id)?
        };
        apply_resize(&app, kind, &id, cols, rows).await?;
    }
    emit_control(&app, &id);
    Ok(())
}

/// 电脑端锁定或解锁尺寸。
#[tauri::command]
pub fn mobile_terminal_lock_size(id: String, locked: bool, app: AppHandle) -> Result<(), String> {
    app.state::<MobileState>()
        .hub
        .set_size_lock(&id, &Controller::Desktop, locked)?;
    emit_control(&app, &id);
    Ok(())
}

/// 电脑端「按电脑尺寸显示」：电脑直接成为尺寸方。
#[tauri::command]
pub async fn mobile_terminal_take_size(id: String, app: AppHandle) -> Result<(), String> {
    let state = app.state::<MobileState>();
    let _control = state.lock_control(&id).await;
    if let Some((cols, rows)) = state.hub.take_size(&id, Controller::Desktop)? {
        let kind = if is_mobile_terminal(&id) {
            state.hub.desktop_session_kind(&id)?
        } else {
            state.hub.session_kind(&id)?
        };
        apply_resize(&app, kind, &id, cols, rows).await?;
    }
    emit_control(&app, &id);
    Ok(())
}

/// 电脑端「断开其他端」：所有设备退出这个终端（保留配对，可重新打开），
/// 收回设备持有的独占与尺寸。
#[tauri::command]
pub async fn mobile_terminal_kick_devices(id: String, app: AppHandle) -> Result<(), String> {
    let state = app.state::<MobileState>();
    let _control = state.lock_control(&id).await;
    if let Some((cols, rows)) = state.hub.kick_devices(&id)? {
        let kind = if is_mobile_terminal(&id) {
            state.hub.desktop_session_kind(&id)?
        } else {
            state.hub.session_kind(&id)?
        };
        apply_resize(&app, kind, &id, cols, rows).await?;
    }
    emit_control(&app, &id);
    Ok(())
}

/// 最近的输入来源（谁、何时、多少字节），不含内容。
#[tauri::command]
pub fn mobile_terminal_input_log(
    id: String,
    state: State<'_, MobileState>,
) -> Result<Value, String> {
    state.hub.input_log(&id)
}

/// 主窗口重载后恢复各终端的共享提示。镜像在 Rust 侧记录，重载不影响手机。
#[tauri::command]
pub fn mobile_terminal_controls(
    state: State<'_, MobileState>,
    window: WebviewWindow,
) -> Vec<Value> {
    if window.label() != "main" {
        return Vec::new();
    }
    shared_controls(&state.hub.inner.lock().unwrap())
}

/// 电脑端检查通过后登记电脑终端镜像。`data` 是电脑当前画面，只在镜像不完整时提供。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mobile_mirror_seed(
    window: WebviewWindow,
    state: State<'_, MobileState>,
    id: String,
    project: Value,
    name: Option<String>,
    cols: u16,
    rows: u16,
    data: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" || is_mobile_terminal(&id) {
        return Err("终端不存在。".into());
    }
    let project: Project = serde_json::from_value(project).map_err(|error| error.to_string())?;
    state
        .hub
        .approve_mirror(id, project, name, cols, rows, data.as_deref())
}

/// 在电脑标签中打开手机终端：电脑可以直接输入，整屏快照随下一轮输出通知发出。
#[tauri::command]
pub fn mobile_view_open(id: String, app: AppHandle) -> Result<Value, String> {
    if !is_mobile_terminal(&id) {
        return Err("终端不存在。".into());
    }
    let state = app.state::<MobileState>();
    let reply = state.hub.open_view(&id)?;
    if state.hub.update_for_preview(&id, |_| {}) {
        schedule_output_notify(app.clone(), id.clone());
    }
    emit_control(&app, &id);
    Ok(reply)
}

#[tauri::command]
pub fn mobile_view_close(id: String, app: AppHandle) {
    app.state::<MobileState>().hub.close_view(&id);
    emit_control_if_changed(&app, &id);
}

#[tauri::command]
pub async fn mobile_view_input(id: String, data: String, app: AppHandle) -> Result<(), String> {
    let state = app.state::<MobileState>();
    let _control = state.lock_control(&id).await;
    let kind = state.hub.desktop_session_kind(&id)?;
    let DesktopWrite::Forward { resize } = desktop_input(&app, &state, &id, &data)? else {
        return Ok(());
    };
    if let Some((cols, rows)) = resize {
        apply_resize(&app, kind, &id, cols, rows).await?;
    }
    write_input(&app, kind, id, data).await
}

/// 电脑查看标签的实测尺寸：首次适应电脑窗格，之后按尺寸方更新。
#[tauri::command]
pub async fn mobile_view_resize(
    id: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
) -> Result<(), String> {
    let state = app.state::<MobileState>();
    let _control = state.lock_control(&id).await;
    let kind = state.hub.desktop_session_kind(&id)?;
    let (cols, rows) = size(cols, rows);
    let result = if state.hub.desktop_view_resize(&id, cols, rows) {
        apply_resize(&app, kind, &id, cols, rows).await
    } else {
        Ok(())
    };
    emit_control_if_changed(&app, &id);
    result
}
