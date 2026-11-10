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
    // 只让出使用权：电脑上开的终端继续运行，电脑恢复可操作。
    for id in state.hub.release_mirrors(None) {
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

/// 手机正在使用这个电脑终端时，电脑端输入被拒绝、改尺寸被忽略。
pub(crate) fn desktop_blocked(state: &MobileState, id: &str) -> bool {
    state
        .hub
        .inner
        .lock()
        .unwrap()
        .mirrors
        .get(id)
        .is_some_and(|mirror| {
            !mirror.dormant && mirror.exit.is_none() && mirror.controller != Controller::Desktop
        })
}

pub(crate) fn check_desktop_write(state: &MobileState, id: &str) -> Result<(), String> {
    if desktop_blocked(state, id) {
        Err("终端正在其他设备上使用，请先点「接回」。".into())
    } else {
        Ok(())
    }
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

#[tauri::command]
pub fn mobile_terminal_take(id: String, app: AppHandle) -> Result<(), String> {
    app.state::<MobileState>().hub.take_for_desktop(&id)?;
    emit_control(&app, &id);
    Ok(())
}

/// 主窗口重载后转发已丢失：把镜像全部还给电脑，手机按被接管处理。
#[tauri::command]
pub fn mobile_release_mirrors(app: AppHandle, window: WebviewWindow) {
    if window.label() != "main" {
        return;
    }
    for id in app.state::<MobileState>().hub.release_mirrors(None) {
        emit_control(&app, &id);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mobile_mirror_seed(
    window: WebviewWindow,
    state: State<'_, MobileState>,
    id: String,
    device: String,
    project: Value,
    name: Option<String>,
    cols: u16,
    rows: u16,
    data: String,
) -> Result<(), String> {
    if window.label() != "main" || is_mobile_terminal(&id) {
        return Err("终端不存在。".into());
    }
    let project: Project = serde_json::from_value(project).map_err(|error| error.to_string())?;
    state
        .hub
        .seed_mirror(id, project, &device, name, cols, rows, &data)
}

#[tauri::command]
pub fn mobile_mirror_output(state: State<'_, MobileState>, id: String, data: String) {
    state.hub.mirror_push(&id, OutputChunk::Bytes(data));
}

#[tauri::command]
pub fn mobile_mirror_screen(
    state: State<'_, MobileState>,
    id: String,
    data: String,
    cols: u16,
    rows: u16,
) {
    state
        .hub
        .mirror_push(&id, OutputChunk::Screen { data, cols, rows });
}

#[tauri::command]
pub fn mobile_mirror_finish(
    state: State<'_, MobileState>,
    id: String,
    exit_code: u32,
    disconnected: bool,
) {
    state.hub.mirror_finish(
        &id,
        Exit {
            exit_code,
            disconnected,
        },
    );
}

/// 在电脑标签中打开手机终端：默认只读，整屏快照随下一轮输出通知发出。
#[tauri::command]
pub fn mobile_view_open(id: String, app: AppHandle) -> Result<Value, String> {
    if !is_mobile_terminal(&id) {
        return Err("终端不存在。".into());
    }
    let state = app.state::<MobileState>();
    let reply = state.hub.open_view(&id)?;
    if state.hub.update_for_preview(&id, |_| {}) {
        schedule_output_notify(app.clone(), id);
    }
    Ok(reply)
}

#[tauri::command]
pub fn mobile_view_close(id: String, state: State<'_, MobileState>) {
    state.hub.close_view(&id);
}

#[tauri::command]
pub async fn mobile_view_input(id: String, data: String, app: AppHandle) -> Result<(), String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let kind = hub.desktop_controls(&id)?;
    hub.with_session(&id, |session| session.note_user_input(&data));
    write_input(&app, kind, id, data).await
}

/// 手机仍在使用时电脑的布局变化不影响终端尺寸，这里直接忽略。
#[tauri::command]
pub async fn mobile_view_resize(
    id: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
) -> Result<(), String> {
    let hub = &app.state::<MobileState>().inner().hub;
    match hub.desktop_controls(&id) {
        Ok(kind) => apply_resize(&app, kind, &id, cols, rows).await,
        Err(_) => Ok(()),
    }
}
