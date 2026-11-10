//! 手机端会话的创建、启动配置，以及分离会话的扫描与恢复。

use super::*;

/// 电脑端按 id 解析出的终端配置。命令只来自电脑端保存且已信任的配置，手机只传 id。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LaunchProfile {
    pub(super) name: String,
    /// 多行命令已由电脑端合并为单行；空串表示普通终端。
    pub(super) command: String,
    /// 主机 shell 偏好（auto / powershell / pwsh / cmd / wsl / bash / zsh）。
    pub(super) shell: String,
}

impl LaunchProfile {
    pub(super) fn command(&self) -> Option<&str> {
        Some(self.command.trim()).filter(|command| !command.is_empty())
    }

    pub(super) fn label(&self) -> Option<String> {
        let name = self.name.trim();
        (self.command().is_some() && !name.is_empty())
            .then(|| name.chars().filter(|c| !c.is_control()).take(80).collect())
    }
}

pub(super) async fn launch_profile(app: &AppHandle, id: &str) -> Result<LaunchProfile, String> {
    serde_json::from_value(desktop_query(app, json!({ "profile": id })).await?)
        .map_err(|_| "电脑端返回的终端配置无效，请更新 Windows QingCode 后重试。".into())
}

pub(super) async fn create(
    app: &AppHandle,
    device: &str,
    project_id: &str,
    profile_id: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<Value, String> {
    let hub = &app.state::<MobileState>().inner().hub;
    let project: Project = serde_json::from_value(desktop(app, Some(project_id)).await?)
        .map_err(|error| error.to_string())?;
    let profile = match profile_id {
        Some(id) => Some(launch_profile(app, id).await?),
        None => None,
    };
    let id = format!("{TERMINAL_PREFIX}{}", Uuid::new_v4().simple());
    hub.reserve_session(
        id.clone(),
        project.clone(),
        device,
        profile.as_ref().and_then(LaunchProfile::label),
    )?;
    let (cols, rows) = size(cols, rows);
    hub.with_session(&id, |session| session.screen.resize(cols, rows));
    let command = profile
        .as_ref()
        .and_then(LaunchProfile::command)
        .map(str::to_owned);
    let shell = profile.map(|profile| profile.shell);
    let result = if project.kind == ProjectKind::Ssh {
        if let Some(command) = command {
            // 与电脑端配置终端同一路径：远端 Linux 用登录 shell 执行后保留 shell，
            // 远端 Windows 按配置的 shell 执行；daemon 名称沿用 `mobile-` id。
            crate::remote_ssh::ssh_spawn_script_unchecked(
                id.clone(),
                project.path,
                "interactive".into(),
                command,
                HashMap::new(),
                Some(cols),
                Some(rows),
                shell,
                None,
                None,
                app.clone(),
                app.state(),
            )
            .await
        } else {
            crate::remote_ssh::ssh_create_terminal_unchecked(
                id.clone(),
                project.path,
                Some(cols),
                Some(rows),
                shell,
                app.clone(),
                app.state(),
            )
            .await
        }
    } else {
        let app = app.clone();
        let id = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<crate::PathAllowlist>()
                .ensure_executable(&project.path)?;
            let manager = app.state::<crate::TerminalManager>();
            match (project.kind, command) {
                // WSL 项目在发行版内执行，主机 shell 偏好不适用。
                (ProjectKind::Wsl, command) => manager.spawn_mobile_wsl(
                    id,
                    &project.path,
                    command.as_deref(),
                    cols,
                    rows,
                    app.clone(),
                ),
                (_, Some(command)) => manager.spawn_script(
                    id,
                    &project.path,
                    "interactive",
                    &command,
                    HashMap::new(),
                    shell.as_deref(),
                    None,
                    cols,
                    rows,
                    app.clone(),
                ),
                (_, None) => {
                    manager.spawn(id, &project.path, shell.as_deref(), cols, rows, app.clone())
                }
            }
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result)
    };
    let kept = hub.finish_create(&id, result.is_ok());
    result?;
    if !kept {
        let _ = end(app, id, project.kind).await;
        return Err("移动连接已停止或设备已移除。".into());
    }
    let inner = hub.inner.lock().unwrap();
    let session = inner.sessions.get(&id).ok_or("终端不存在。")?;
    Ok(session.metadata(&id))
}

/// 手机会话记录只在电脑内存里，电脑重启或升级后要从 daemon 找回仍在运行的终端。
/// 在后台进行，不阻塞列表；手机下一次刷新就能看到。
pub(super) fn schedule_restore_scan(app: &AppHandle, device: &str) {
    if !app
        .state::<MobileState>()
        .hub
        .begin_restore_scan(Instant::now())
    {
        return;
    }
    let app = app.clone();
    let device = device.to_owned();
    tauri::async_runtime::spawn(async move {
        let (connect_requested, finished) = scan_detached_sessions(&app, &device).await;
        app.state::<MobileState>()
            .hub
            .finish_restore_scan(connect_requested, finished);
    });
}

pub(super) async fn scan_detached_sessions(app: &AppHandle, device: &str) -> (bool, Vec<String>) {
    let hub = &app.state::<MobileState>().inner().hub;
    let connect_requested = hub.restore_connect_requested()
        || desktop_query(app, json!({ "connectRemoteProjects": true }))
            .await
            .is_ok();
    let mut finished = Vec::new();
    for connection in crate::remote_ssh::mobile_restore::restorable_connections(app) {
        if hub.restore_finished(&connection) {
            continue;
        }
        let listed = crate::remote_ssh::mobile_restore::list_detached(&connection, app).await;
        match listed {
            Ok(terminals) => {
                if restore_detached_sessions(app, device, terminals).await {
                    finished.push(connection);
                }
            }
            // 守护进程还没就绪时下一轮再查。
            Err(error) => eprintln!("[WARN] 查询遗留手机终端失败：{error}"),
        }
    }
    (connect_requested, finished)
}

/// 返回 false 表示有终端这次没接回，下一轮再试。
pub(super) async fn restore_detached_sessions(
    app: &AppHandle,
    device: &str,
    terminals: Vec<crate::remote_ssh::mobile_restore::DetachedMobileTerminal>,
) -> bool {
    let hub = &app.state::<MobileState>().inner().hub;
    let terminals: Vec<_> = terminals
        .into_iter()
        .filter(|terminal| !hub.is_phone_session(&terminal.session_id))
        .collect();
    if terminals.is_empty() {
        return true;
    }
    let Some(projects) = desktop(app, None)
        .await
        .ok()
        .and_then(|value| serde_json::from_value::<Vec<Project>>(value).ok())
    else {
        return false;
    };
    let mut complete = true;
    for terminal in terminals {
        // 项目已移除或不再受信任：不接回，留给 daemon 回收。
        let Some(project) = projects.iter().find(|project| {
            crate::remote_ssh::mobile_restore::is_same_root(&project.path, &terminal.root_uri)
        }) else {
            continue;
        };
        let id = terminal.session_id.clone();
        if let Err(error) = hub.reserve_session(id.clone(), project.clone(), device, None) {
            eprintln!("[WARN] 手机终端未接回：{error}");
            return false;
        }
        hub.restore_session_name(&id);
        hub.with_session(&id, |session| {
            session.screen.resize(terminal.cols, terminal.rows)
        });
        let result = crate::remote_ssh::mobile_restore::attach(&terminal, app).await;
        let attached = result.is_ok();
        if let Err(error) = result {
            eprintln!("[WARN] 手机终端接回失败：{error}");
            complete = false;
        }
        if !hub.finish_create(&id, attached) && attached {
            crate::remote_ssh::mobile_restore::detach(&id, app).await;
        }
    }
    complete
}

pub(super) async fn end(app: &AppHandle, id: String, kind: ProjectKind) -> Result<(), String> {
    if routes_through_ssh_table(app, kind, &id) {
        crate::remote_ssh::ssh_kill_terminal_unchecked(id, None, None, app.state()).await
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<crate::TerminalManager>().kill(&id)
        })
        .await
        .map_err(|error| error.to_string())?
    }
}
